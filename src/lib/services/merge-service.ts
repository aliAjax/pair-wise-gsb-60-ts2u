import type {
  IncomingVersion,
  MergeContentType,
  MergeJob,
  MergeSourceProgress,
  SignalCase
} from '$lib/models/signal';
import { RevisionConflictError, signalStore } from '$lib/stores/signal-store';

const JOB_STORAGE_KEY = 'medical-safety-merge-jobs-v1';

/** 模拟写入失败的注入点，仅用于演示恢复流程 */
export interface MergeRunOptions {
  /** 在指定来源执行到指定阶段时注入一次写入失败（恢复后续跑不再失败） */
  failOnce?: { sourceId: string; phase: MergeContentType };
}

export class MergeWriteError extends Error {
  constructor(
    public sourceId: string,
    public phase: MergeContentType,
    causeMessage: string
  ) {
    super(`来源 ${sourceId} 的「${phaseLabel(phase)}」写入失败：${causeMessage}`);
    this.name = 'MergeWriteError';
  }
}

export function phaseLabel(phase: MergeContentType) {
  const labels: Record<MergeContentType, string> = {
    evidence: '证据矩阵',
    tasks: '调查任务',
    versions: '结论版本',
    audit: '审计记录'
  };
  return labels[phase];
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function readJobs(): MergeJob[] {
  try {
    const raw = localStorage.getItem(JOB_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MergeJob[]) : [];
  } catch {
    return [];
  }
}

function writeJobs(jobs: MergeJob[]) {
  localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(jobs));
}

function saveJob(job: MergeJob) {
  job.updatedAt = new Date().toISOString();
  const jobs = readJobs().filter((item) => item.id !== job.id);
  jobs.push(job);
  writeJobs(jobs);
  globalThis.dispatchEvent?.(new CustomEvent('merge-jobs-changed'));
}

export function listMergeJobs(): MergeJob[] {
  return readJobs().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function activeMergeJobs(): MergeJob[] {
  return listMergeJobs().filter((job) => job.status === 'running' || job.status === 'conflict' || job.status === 'failed');
}

export function getMergeJob(id: string): MergeJob | undefined {
  return readJobs().find((job) => job.id === id);
}

export function dismissMergeJob(id: string) {
  writeJobs(readJobs().filter((job) => job.id !== id));
  globalThis.dispatchEvent?.(new CustomEvent('merge-jobs-changed'));
}

/** 校验选择结果并建立合并作业（此时不写入任何信号） */
export function createMergeJob(input: {
  masterId: string;
  sourceIds: string[];
  actor: string;
  reason: string;
}): MergeJob {
  signalStore.refresh();
  const snapshot = signalStore.getSnapshot();
  const master = snapshot.find((signal) => signal.id === input.masterId);
  if (!master) throw new Error('主信号不存在或已被重置。');
  if (master.mergedInto) throw new Error(`主信号 ${master.id} 已作为来源并入 ${master.mergedInto.masterSignalId}，只读不可再合并。`);
  if (input.sourceIds.includes(input.masterId)) throw new Error('主信号不能同时作为来源信号。');

  const sourceSignals: SignalCase[] = [];
  for (const sourceId of input.sourceIds) {
    const source = snapshot.find((signal) => signal.id === sourceId);
    if (!source) throw new Error(`来源信号 ${sourceId} 不存在。`);
    if (source.mergedInto) {
      throw new Error(`来源信号 ${sourceId} 已并入 ${source.mergedInto.masterSignalId}，不能重复并入。`);
    }
    if (source.mergedSources.length > 0) {
      throw new Error(
        `来源信号 ${sourceId} 已作为主信号并入 ${source.mergedSources.length} 个信号，反向并入会造成去向链，请直接合并其当前内容。`
      );
    }
    sourceSignals.push(source);
  }

  const expectedSourceRevisions: Record<string, number> = {};
  for (const source of sourceSignals) expectedSourceRevisions[source.id] = source.revision;

  const job: MergeJob = {
    id: makeId('MRG'),
    masterId: master.id,
    masterTitle: master.title,
    sourceIds: sourceSignals.map((source) => source.id),
    actor: input.actor,
    reason: input.reason,
    status: 'running',
    expectedMasterRevision: master.revision,
    expectedSourceRevisions,
    progress: sourceSignals.map<MergeSourceProgress>((source) => ({
      signalId: source.id,
      title: source.title,
      attached: [],
      status: 'pending'
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveJob(job);
  return job;
}

/** 风险等级取较高者 */
function maxRisk(a: SignalCase['riskLevel'], b: SignalCase['riskLevel']): SignalCase['riskLevel'] {
  const order = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  return order[a] >= order[b] ? a : b;
}

/**
 * 阶段一：证据矩阵并入 + 批号覆盖并集 + 报告/暴露/发生率聚合。
 * 幂等：originId 已存在的证据不会重复接入。
 */
function attachEvidence(master: SignalCase, source: SignalCase) {
  let added = 0;
  for (const evidence of source.evidence) {
    const exists = master.evidence.some(
      (item) => item.originId === evidence.id || item.id === evidence.id
    );
    if (exists) continue;
    master.evidence.unshift({ ...structuredClone(evidence), originId: evidence.id, originSignalId: source.id });
    added += 1;
  }
  for (const batch of source.affectedBatches) {
    if (!master.affectedBatches.includes(batch)) master.affectedBatches.push(batch);
  }
  if (!master.affectedBatches.includes(source.batch)) {
    master.affectedBatches.push(source.batch);
  }
  master.reportCount += source.reportCount;
  master.exposedUnits += source.exposedUnits;
  master.occurrenceRate = master.exposedUnits > 0
    ? (master.reportCount / master.exposedUnits) * 100
    : master.occurrenceRate;
  return added;
}

/** 阶段二：调查任务并入（保留完成态），originId 去重 */
function attachTasks(master: SignalCase, source: SignalCase) {
  let added = 0;
  for (const task of source.tasks) {
    const exists = master.tasks.some((item) => item.originId === task.id || item.id === task.id);
    if (exists) continue;
    master.tasks.push({ ...structuredClone(task), originId: task.id, originSignalId: source.id });
    added += 1;
  }
  return added;
}

/**
 * 阶段三：来源结论进入并排待复核区。
 * 无论主信号是否已有结论版本，都不直接替换或改写主结论。
 */
function attachVersions(master: SignalCase, source: SignalCase, mergedAt: string): number {
  let added = 0;
  for (const version of source.versions) {
    const exists = master.incomingVersions.some(
      (item) => item.originVersionId === version.id
    );
    if (exists) continue;
    const incoming: IncomingVersion = {
      id: makeId('INC'),
      sourceSignalId: source.id,
      originVersionId: version.id,
      version: version.version,
      author: version.author,
      summary: version.summary,
      disposition: version.disposition,
      rationale: version.rationale,
      createdAt: version.createdAt,
      mergedAt,
      reviewStatus: 'pending'
    };
    master.incomingVersions.unshift(incoming);
    added += 1;
  }
  return added;
}

/** 阶段四：来源审计记录接入主信号（带原始来源标记） */
function attachAudit(master: SignalCase, source: SignalCase, actor: string, reason: string) {
  for (const entry of source.audit) {
    const exists = master.audit.some((item) => item.originId === entry.id);
    if (exists) continue;
    master.audit.unshift({
      ...structuredClone(entry),
      originId: entry.id,
      originSignalId: source.id
    });
  }
  master.audit.unshift({
    id: makeId('AUD'),
    actor,
    action: '并入来源信号',
    detail: `${source.id}（${source.title}）已并入：证据 ${source.evidence.length} 项、任务 ${source.tasks.length} 项、结论 ${source.versions.length} 版；依据：${reason}`,
    createdAt: new Date().toISOString()
  });
}

/** 来源信号封口：写入只读去向；主信号登记来源清单 */
function finalizeSource(source: SignalCase, master: SignalCase, actor: string) {
  const mergedAt = new Date().toISOString();
  source.mergedInto = {
    masterSignalId: master.id,
    masterTitle: master.title,
    mergedAt,
    mergedBy: actor
  };
  source.audit.unshift({
    id: makeId('AUD'),
    actor,
    action: '信号已并入',
    detail: `本信号作为来源并入主信号 ${master.id}，此后只读留痕。`,
    createdAt: mergedAt
  });

  if (!master.mergedSources.some((item) => item.signalId === source.id)) {
    master.mergedSources.push({
      signalId: source.id,
      title: source.title,
      sourceType: source.sourceType,
      owner: source.owner,
      mergedAt,
      mergedBy: actor,
      evidenceCount: source.evidence.length,
      taskCount: source.tasks.length,
      versionCount: source.versions.length
    });
  }
}

const PHASE_ORDER: MergeContentType[] = ['evidence', 'tasks', 'versions', 'audit'];

/**
 * 执行/恢复合并作业。
 * - 每个来源先做冲突预检（主信号或来源被其他页签改过即整体停止，后来方先看到冲突）
 * - 四个阶段按序幂等接入；已完成阶段与 originId 去重保证重试不重复接入
 * - 单阶段写入失败：作业持久化进度，刷新或重试时从未完成阶段续跑
 */
export function runMergeJob(jobId: string, options: MergeRunOptions = {}): MergeJob {
  const job = getMergeJob(jobId);
  if (!job) throw new Error('合并作业不存在。');

  signalStore.refresh();
  let snapshot = signalStore.getSnapshot();
  let master = snapshot.find((signal) => signal.id === job.masterId);
  if (!master || master.mergedInto) {
    job.status = 'conflict';
    job.conflict = {
      masterChanged: true,
      changedSourceIds: [],
      detail: master?.mergedInto
        ? `主信号已并入 ${master.mergedInto.masterSignalId}，合并无法继续。`
        : '主信号已不存在。'
    };
    saveJob(job);
    return job;
  }

  for (const progress of job.progress) {
    if (progress.status === 'done') continue;

    const source = snapshot.find((signal) => signal.id === progress.signalId);
    const currentMaster = snapshot.find((signal) => signal.id === job.masterId);
    if (!currentMaster) {
      job.status = 'conflict';
      job.conflict = {
        masterChanged: true,
        changedSourceIds: [],
        detail: '主信号在执行过程中消失。'
      };
      saveJob(job);
      return job;
    }

    // —— 冲突预检：后来方先看到冲突，且不写入任何内容 ——
    const changedSourceIds: string[] = [];
    if (source && source.revision !== job.expectedSourceRevisions[source.id]) {
      changedSourceIds.push(source.id);
    }
    if (source?.mergedInto) changedSourceIds.push(source.id);
    const masterChanged = currentMaster.revision !== job.expectedMasterRevision;

    if (masterChanged || changedSourceIds.length > 0) {
      progress.status = 'conflict';
      progress.error = source?.mergedInto
        ? `来源 ${source.id} 已被并入 ${source.mergedInto.masterSignalId}。`
        : '修订号已变化，可能有页签刚补充了证据。';
      job.status = 'conflict';
      job.conflict = {
        masterChanged,
        changedSourceIds: Array.from(new Set(changedSourceIds)),
        detail: masterChanged
          ? `主信号修订号 ${job.expectedMasterRevision} -> ${currentMaster.revision}；${changedSourceIds.length ? `来源 ${changedSourceIds.join('、')} 也已更新。` : '另一页签刚写入过主信号。'}`
          : `来源 ${changedSourceIds.join('、')} 在合并开始后被更新，继续接入可能盖掉对方刚补的证据。`
      };
      saveJob(job);
      return job;
    }
    if (!source) {
      progress.status = 'failed';
      progress.error = '来源信号不存在。';
      job.status = 'failed';
      saveJob(job);
      return job;
    }

    progress.status = 'attaching';
    saveJob(job);

    try {
      for (const phase of PHASE_ORDER) {
        if (progress.attached.includes(phase)) continue; // 恢复：跳过已完成阶段

        if (
          options.failOnce &&
          options.failOnce.sourceId === source.id &&
          options.failOnce.phase === phase
        ) {
          // 只注入一次：恢复续跑时清除该注入点
          options.failOnce = undefined;
          throw new MergeWriteError(source.id, phase, '模拟的持久化写入失败（可恢复）');
        }

        const expectedMaster = signalStore
          .getSnapshot()
          .find((signal) => signal.id === job.masterId)!.revision;

        signalStore.commitMergeBatch(job.masterId, source.id, {
          master: expectedMaster,
          source: job.expectedSourceRevisions[source.id]
        }, (masterCopy, sourceCopy) => {
          // 封口放最后一步；前四个阶段只写主信号，最终阶段连同来源一起提交
          if (phase === 'evidence') attachEvidence(masterCopy, sourceCopy);
          if (phase === 'tasks') attachTasks(masterCopy, sourceCopy);
          if (phase === 'versions') attachVersions(masterCopy, sourceCopy, new Date().toISOString());
          if (phase === 'audit') {
            attachAudit(masterCopy, sourceCopy, job.actor, job.reason);
            masterCopy.riskLevel = maxRisk(masterCopy.riskLevel, sourceCopy.riskLevel);
            masterCopy.severity = Math.max(masterCopy.severity, sourceCopy.severity);
            if (masterCopy.status === 'new') masterCopy.status = 'investigating';
            finalizeSource(sourceCopy, masterCopy, job.actor);
          }
        }, phase === 'audit');

        progress.attached.push(phase);
        // 逐阶段推进基线：恢复续跑时不会把自己此前已提交的阶段误判为并发修改
        const masterAfterPhase = signalStore
          .getSnapshot()
          .find((signal) => signal.id === job.masterId);
        if (masterAfterPhase) job.expectedMasterRevision = masterAfterPhase.revision;
        if (phase === 'audit') {
          const sourceAfterPhase = signalStore
            .getSnapshot()
            .find((signal) => signal.id === source.id);
          if (sourceAfterPhase) job.expectedSourceRevisions[source.id] = sourceAfterPhase.revision;
        }
        saveJob(job);

        snapshot = signalStore.getSnapshot();
        master = snapshot.find((signal) => signal.id === job.masterId)!;
      }
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        progress.status = 'conflict';
        progress.error = error.message;
        job.status = 'conflict';
        job.conflict = {
          masterChanged: true,
          changedSourceIds: [source.id],
          detail: `提交时检出并发修改：${error.message}`
        };
        saveJob(job);
        return job;
      }
      progress.status = 'failed';
      progress.error = error instanceof Error ? error.message : String(error);
      job.status = 'failed';
      saveJob(job);
      return job;
    }

    // 该来源全部阶段成功：更新基线（自己的提交产生的修订号变化）
    const latest = signalStore.getSnapshot();
    const latestMaster = latest.find((signal) => signal.id === job.masterId);
    if (latestMaster) job.expectedMasterRevision = latestMaster.revision;
    progress.status = 'done';
    progress.error = undefined;
    saveJob(job);
    snapshot = latest;
    master = latestMaster;
  }

  job.status = 'completed';
  job.conflict = undefined;
  saveJob(job);
  return job;
}

/**
 * 冲突后刷新基线：接受当前快照中的修订号，未完成的来源回到 pending，
 * 已接入阶段保留（originId 去重），随后可续跑。
 */
export function rebaseMergeJob(jobId: string, reviewer: string): MergeJob {
  const job = getMergeJob(jobId);
  if (!job) throw new Error('合并作业不存在。');
  signalStore.refresh();
  let snapshot = signalStore.getSnapshot();
  let master = snapshot.find((signal) => signal.id === job.masterId);
  if (!master) throw new Error('主信号已不存在，无法刷新基线。');
  if (master.mergedInto) throw new Error('主信号已被并入其他信号，该作业只能放弃。');

  for (const progress of job.progress) {
    const source = snapshot.find((signal) => signal.id === progress.signalId);
    if (!source || source.mergedInto) {
      // 来源已被其他页签并入别处：无法再接入，但已完成的接入保持有效
      progress.status = 'done';
      progress.error = source?.mergedInto
        ? `已由其他操作并入 ${source.mergedInto.masterSignalId}（跳过）`
        : '来源已不存在（跳过）';
      continue;
    }
    job.expectedSourceRevisions[source.id] = source.revision;
    if (progress.status === 'conflict' || progress.status === 'failed') {
      progress.status = 'pending';
      progress.error = undefined;
    }
  }

  // 审计写入本身也推进主信号修订号，因此基线在写入之后再读取
  signalStore.addAudit(master.id, {
    id: makeId('AUD'),
    actor: reviewer,
    action: '合并冲突刷新基线',
    detail: `合并作业 ${jobId} 检出并发修改后，负责人 ${reviewer} 确认当前快照并续跑，已接入内容保持不重复。`,
    createdAt: new Date().toISOString()
  });

  snapshot = signalStore.getSnapshot();
  master = snapshot.find((signal) => signal.id === job.masterId);
  if (master) job.expectedMasterRevision = master.revision;
  job.status = 'running';
  job.conflict = undefined;
  saveJob(job);
  return job;
}
