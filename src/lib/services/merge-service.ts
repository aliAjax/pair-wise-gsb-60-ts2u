import { get } from 'svelte/store';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  MergeConflict,
  MergeItem,
  MergeJournal,
  MergePlanResult,
  SignalCase
} from '$lib/models/signal';
import { mergeJournalStore } from '$lib/stores/merge-journal-store';
import { signalStore } from '$lib/stores/signal-store';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSignal(id: string): SignalCase | undefined {
  return get(signalStore).find((signal) => signal.id === id);
}

function revisionOf(id: string): number {
  return findSignal(id)?.revision ?? 0;
}

const riskRank: Record<SignalCase['riskLevel'], number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * 合并预检：
 * - 主/来源必须存在且互不为同一信号
 * - 已合并（只读去向）的信号不能再次参与
 * - baseRevisions 与当前台账不一致时直接报冲突，后到方不能盖掉先到方刚补的证据
 */
export function precheckMerge(input: {
  primaryId: string;
  sourceIds: string[];
  baseRevisions: Record<string, number>;
}): { ok: boolean; conflicts?: MergeConflict[]; message?: string } {
  const { primaryId, sourceIds, baseRevisions } = input;

  if (sourceIds.includes(primaryId)) {
    return { ok: false, message: '主信号不能同时作为来源信号。' };
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    return { ok: false, message: '来源信号存在重复选择。' };
  }

  const ids = [primaryId, ...sourceIds];
  const conflicts: MergeConflict[] = [];

  for (const id of ids) {
    const signal = findSignal(id);
    if (!signal) {
      return { ok: false, message: `信号 ${id} 不在台账中，可能已被其他页签移除。` };
    }
    if (signal.status === 'merged') {
      return {
        ok: false,
        message: `信号 ${id} 已并入 ${signal.mergedInto}，原信号为只读去向，不能再次合并。`
      };
    }
    const actual = signal.revision ?? 0;
    const expected = baseRevisions[id];
    if (expected !== undefined && expected !== actual) {
      conflicts.push({
        signalId: id,
        expected,
        actual,
        reason: '计划合并后该信号被另一个页签更新（例如刚补充证据或结论版本）。'
      });
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      conflicts,
      message: `检测到 ${conflicts.length} 个信号在页签打开后发生过更新，请先复核对方补充的内容再继续。`
    };
  }
  return { ok: true };
}

/**
 * 生成合并写入计划。每个证据/任务/版本/批号/审计都是独立 item，
 * 任何一项写入失败都能从断点恢复，重试按 item id 幂等、不重复接入。
 */
export function planMerge(input: {
  primaryId: string;
  sourceIds: string[];
  actor: string;
  reason: string;
}): MergePlanResult {
  const primary = findSignal(input.primaryId);
  if (!primary) return { ok: false, message: '主信号不存在。' };

  const check = precheckMerge({
    primaryId: input.primaryId,
    sourceIds: input.sourceIds,
    baseRevisions: Object.fromEntries(
      [input.primaryId, ...input.sourceIds].map((id) => [id, revisionOf(id)])
    )
  });
  if (!check.ok) return check;

  const sources = input.sourceIds
    .map((id) => findSignal(id))
    .filter((signal): signal is SignalCase => Boolean(signal));

  const items: MergeItem[] = [];
  const seq = { n: 0 };
  const nextId = (kind: string) => `${input.primaryId}-${kind}-${++seq.n}`;

  for (const source of sources) {
    // 来源审计整体接入主信号（带来源信号号前缀），保证调查轨迹不丢
    for (const entry of source.audit) {
      const audit: AuditEntry = {
        ...entry,
        id: `AUD-MRG-${source.id}-${entry.id}`,
        action: `[来源 ${source.id}] ${entry.action}`,
        detail: entry.detail
      };
      items.push({
        id: nextId('aud'),
        kind: 'primary_audit',
        signalId: input.primaryId,
        payload: audit,
        status: 'pending'
      });
    }

    // 证据矩阵接入：标注来源信号，批号随证据并入覆盖
    const batches = Array.from(new Set([source.batch, ...source.affectedBatches]));
    items.push({
      id: nextId('bat'),
      kind: 'primary_batch',
      signalId: input.primaryId,
      payload: { batches },
      status: 'pending'
    });

    for (const evidence of source.evidence) {
      const tagged: EvidenceItem = {
        ...evidence,
        id: `E-MRG-${source.id}-${evidence.id}`,
        originSignalId: source.id
      };
      items.push({
        id: nextId('ev'),
        kind: 'primary_evidence',
        signalId: input.primaryId,
        payload: tagged,
        status: 'pending'
      });
    }

    // 调查任务接入，保留原负责人并标注来源
    for (const task of source.tasks) {
      const tagged: InvestigationTask = {
        ...task,
        id: `TASK-MRG-${source.id}-${task.id}`,
        originSignalId: source.id
      };
      items.push({
        id: nextId('tsk'),
        kind: 'primary_task',
        signalId: input.primaryId,
        payload: tagged,
        status: 'pending'
      });
    }

    // 来源结论版本并排保留：不替换主信号已有结论，留给复核人比对
    for (const version of source.versions) {
      const tagged: CaseVersion = {
        ...version,
        id: `V-MRG-${source.id}-${version.id}`,
        originSignalId: source.id
      };
      items.push({
        id: nextId('ver'),
        kind: 'primary_version',
        signalId: input.primaryId,
        payload: tagged,
        status: 'pending'
      });
    }

    // 原信号改只读去向，放最后：主信号证据接入成功后才执行
    items.push({
      id: nextId('rdr'),
      kind: 'source_redirect',
      signalId: source.id,
      payload: {
        primaryId: input.primaryId,
        actor: input.actor,
        reason: input.reason,
        at: new Date().toISOString()
      },
      status: 'pending'
    });
  }

  // 汇总报告数/暴露数并重算发生率，作为整个合并的收尾项
  const allForRollup = [primary, ...sources];
  const reportCount = allForRollup.reduce((sum, signal) => sum + signal.reportCount, 0);
  const exposedUnits = allForRollup.reduce((sum, signal) => sum + signal.exposedUnits, 0);
  items.push({
    id: `${input.primaryId}-finalize`,
    kind: 'primary_finalize',
    signalId: input.primaryId,
    payload: {
      actor: input.actor,
      reason: input.reason,
      sourceIds: input.sourceIds,
      reportCount,
      exposedUnits
    },
    status: 'pending'
  });

  const baseRevisions = Object.fromEntries(
    [input.primaryId, ...input.sourceIds].map((id) => [id, revisionOf(id)])
  );

  const journal = mergeJournalStore.create({
    primaryId: input.primaryId,
    sourceIds: input.sourceIds,
    actor: input.actor,
    reason: input.reason,
    items,
    baseRevisions
  });

  return { ok: true, journal };
}

export interface MergeRunOptions {
  /** QA/演示用：在第 N 个条目（从 1 起）模拟一次写入失败，恢复后续做 */
  failAtItem?: number;
}

export interface MergeRunResult {
  status: MergeJournal['status'];
  conflictAt?: string;
  message?: string;
}

/**
 * 执行（或断点续跑）一份合并 journal。
 * 对每个信号只在本次合并的“首次写入”前核对计划基线：
 * 其他页签在合并开始前刚补过证据会被拦下；同一 journal 的后续写入不再比对，
 * 避免把本次合并自身造成的 revision 增长误判为冲突。
 */
export async function runMerge(journalId: string, options: MergeRunOptions = {}): Promise<MergeRunResult> {
  const journal = get(mergeJournalStore).find((item) => item.id === journalId);
  if (!journal) return { status: 'failed', message: '合并记录不存在。' };

  mergeJournalStore.markRunning(journalId);
  let attempt = 0;
  // 本次运行中已开始接入的信号：后续条目属于同一批写入，不再做外部并发校验
  const guardedSignals = new Set<string>();

  for (const item of journal.items) {
    if (item.status === 'done') {
      guardedSignals.add(item.signalId);
      continue;
    }
    attempt += 1;
    await wait(40);

    // 模拟写入失败：journal 已落盘，刷新后可从该条目继续
    if (options.failAtItem === attempt) {
      mergeJournalStore.markItem(journalId, item.id, {
        status: 'pending',
        error: '模拟写入失败（网络/存储不可用），条目保留待恢复。'
      });
      mergeJournalStore.markFailed(
        journalId,
        `第 ${attempt} 项（${item.kind}）写入失败，已保留断点；点击“恢复未完成项”可继续，已接入内容不会重复。`
      );
      return {
        status: 'failed',
        message: `第 ${attempt} 项写入失败，可恢复续做。`
      };
    }

    const needsGuard = !guardedSignals.has(item.signalId);
    const expectedRevision = needsGuard ? journal.baseRevisions[item.signalId] : undefined;
    const applied = signalStore.applyMergeItem(item, expectedRevision);
    guardedSignals.add(item.signalId);

    if (applied.conflict) {
      mergeJournalStore.markItem(journalId, item.id, {
        status: 'conflict',
        error: applied.error
      });
      mergeJournalStore.markConflict(
        journalId,
        applied.error ?? '检测到并发更新，已阻止本次写入。'
      );
      return { status: 'conflict', conflictAt: item.id, message: applied.error };
    }

    if (applied.error) {
      // 目标缺失等非冲突错误：保留 pending，等待恢复
      mergeJournalStore.markItem(journalId, item.id, { status: 'pending', error: applied.error });
      mergeJournalStore.markFailed(journalId, applied.error);
      return { status: 'failed', message: applied.error };
    }

    mergeJournalStore.markItem(journalId, item.id, { status: 'done', error: undefined });
  }

  mergeJournalStore.markCompleted(journalId);
  return { status: 'completed' };
}

/**
 * 失败恢复：以当前台账最新 revision 重置基线后续跑。
 * 若来源信号已被其他页签并入别处，停止恢复并提示。
 */
export async function recoverMerge(
  journalId: string,
  options: MergeRunOptions = {}
): Promise<MergeRunResult> {
  const journal = get(mergeJournalStore).find((item) => item.id === journalId);
  if (!journal) return { status: 'failed', message: '合并记录不存在。' };

  const pendingSignals = Array.from(
    new Set(journal.items.filter((item) => item.status !== 'done').map((item) => item.signalId))
  );

  for (const id of pendingSignals) {
    const signal = findSignal(id);
    if (!signal) return { status: 'failed', message: `信号 ${id} 已不在台账中，无法自动恢复。` };
    if (
      signal.status === 'merged' &&
      signal.mergedInto !== journal.primaryId &&
      journal.items.some((item) => item.kind === 'source_redirect' && item.signalId === id && item.status !== 'done')
    ) {
      return {
        status: 'conflict',
        message: `来源信号 ${id} 已被另一个页签并入 ${signal.mergedInto}，请人工复核后放弃或重建本次合并。`
      };
    }
  }

  const latestRevisions = Object.fromEntries(pendingSignals.map((id) => [id, revisionOf(id)]));
  mergeJournalStore.rebase(journalId, { ...journal.baseRevisions, ...latestRevisions });
  return runMerge(journalId, options);
}

export function listMergeJournals(): MergeJournal[] {
  return get(mergeJournalStore);
}

export function isReadOnly(signal: SignalCase): boolean {
  return signal.status === 'merged' || Boolean(signal.mergedInto);
}
