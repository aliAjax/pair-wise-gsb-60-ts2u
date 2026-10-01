import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  MergeItem,
  SignalCase,
  SignalStatus,
  RiskLevel
} from '$lib/models/signal';
import { seedSignals } from '$lib/services/seed';
import { get, writable } from 'svelte/store';

export const SIGNALS_STORAGE_KEY = 'medical-safety-signals-v1';

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

/** 补齐历史数据：老版本台账没有 revision 与合并字段 */
function normalize(items: SignalCase[]): SignalCase[] {
  return items.map((signal) => ({
    ...signal,
    revision: signal.revision ?? 0,
    affectedBatches: signal.affectedBatches ?? [signal.batch],
    evidence: signal.evidence ?? [],
    tasks: signal.tasks ?? [],
    versions: signal.versions ?? [],
    audit: signal.audit ?? []
  }));
}

function readPersisted(): SignalCase[] {
  if (!browser) return cloneSeed();

  try {
    const raw = localStorage.getItem(SIGNALS_STORAGE_KEY);
    return normalize(raw ? (JSON.parse(raw) as SignalCase[]) : cloneSeed());
  } catch {
    return cloneSeed();
  }
}

const internal = writable<SignalCase[]>(readPersisted());

if (browser) {
  internal.subscribe((value) => {
    localStorage.setItem(SIGNALS_STORAGE_KEY, JSON.stringify(value));
  });

  // 两个页签同时处理同一批来源信号：后写入的页签把数据同步过来，
  // 保存时再凭 revision 发现冲突，而不是静默盖掉对方刚补的证据。
  window.addEventListener('storage', (event) => {
    if (event.key === SIGNALS_STORAGE_KEY && event.newValue) {
      try {
        internal.set(normalize(JSON.parse(event.newValue) as SignalCase[]));
      } catch {
        // 其他页签写入进行中产生的半截 JSON，忽略本次同步
      }
    }
  });
}

function now() {
  return new Date().toISOString();
}

export function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

function statusLabel(status: SignalStatus) {
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭',
    merged: '已合并'
  };
  return labels[status];
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string) {
  signal.audit.unshift({
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: now()
  });
  signal.updatedAt = now();
}

const riskRank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank[a] >= riskRank[b] ? a : b;
}

/** 对单个信号施加一次合并写入项。幂等：已存在的证据/任务/版本/批号不重复接入。 */
function applyMergeItemToSignal(signal: SignalCase, item: MergeItem): SignalCase {
  const updated = structuredClone(signal);

  switch (item.kind) {
    case 'primary_evidence': {
      const evidence = item.payload as EvidenceItem;
      if (updated.evidence.some((entry) => entry.id === evidence.id)) return signal;
      updated.evidence.unshift(evidence);
      break;
    }
    case 'primary_task': {
      const task = item.payload as InvestigationTask;
      if (updated.tasks.some((entry) => entry.id === task.id)) return signal;
      updated.tasks.push(task);
      break;
    }
    case 'primary_version': {
      const version = item.payload as CaseVersion;
      if (updated.versions.some((entry) => entry.id === version.id)) return signal;
      // 来源结论并排保留，标记 originSignalId，不替换主信号既有结论
      updated.versions.unshift(version);
      break;
    }
    case 'primary_batch': {
      const { batches } = item.payload as { batches: string[] };
      let changed = false;
      for (const batch of batches) {
        if (!updated.affectedBatches.includes(batch)) {
          updated.affectedBatches.push(batch);
          changed = true;
        }
      }
      if (!changed) return signal;
      break;
    }
    case 'primary_audit': {
      const entry = item.payload as AuditEntry;
      if (updated.audit.some((audit) => audit.id === entry.id)) return signal;
      updated.audit.unshift(entry);
      break;
    }
    case 'primary_finalize': {
      const payload = item.payload as {
        actor: string;
        reason: string;
        sourceIds: string[];
        reportCount: number;
        exposedUnits: number;
      };
      updated.mergedFrom = Array.from(new Set([...(updated.mergedFrom ?? []), ...payload.sourceIds]));
      updated.reportCount = payload.reportCount;
      updated.exposedUnits = payload.exposedUnits;
      updated.occurrenceRate =
        payload.exposedUnits > 0
          ? Number(((payload.reportCount / payload.exposedUnits) * 100).toFixed(2))
          : updated.occurrenceRate;
      if (updated.status === 'closed' || updated.status === 'merged') {
        updated.status = 'review';
      }
      const sources = payload.sourceIds.join('、');
      appendAudit(updated, payload.actor, '完成信号合并', `并入来源信号 ${sources}；依据：${payload.reason}`);
      break;
    }
    case 'source_redirect': {
      const payload = item.payload as { primaryId: string; actor: string; reason: string; at: string };
      if (updated.mergedInto === payload.primaryId) return signal;
      updated.mergedInto = payload.primaryId;
      updated.mergedAt = payload.at;
      updated.mergedBy = payload.actor;
      updated.status = 'merged';
      appendAudit(updated, payload.actor, '并入主信号', `证据矩阵、调查任务与结论版本已并入 ${payload.primaryId}；依据：${payload.reason}`);
      break;
    }
  }

  updated.revision = (updated.revision ?? 0) + 1;
  return updated;
}

export const signalStore = {
  subscribe: internal.subscribe,

  add(signal: SignalCase) {
    internal.update((items) => [{ ...signal, revision: signal.revision ?? 0 }, ...items]);
  },

  create(input: Omit<SignalCase, 'id' | 'openedAt' | 'updatedAt' | 'audit' | 'reopenedCount'>) {
    const createdAt = now();
    const signal: SignalCase = {
      ...input,
      id: `SIG-${new Date().getFullYear()}-${String(get(internal).length + 20).padStart(3, '0')}`,
      openedAt: createdAt,
      updatedAt: createdAt,
      reopenedCount: 0,
      revision: 1,
      audit: [
        {
          id: makeId('AUD'),
          actor: input.owner,
          action: '建立信号',
          detail: `按${input.sourceType}来源建立核查任务。`,
          createdAt
        }
      ]
    };
    internal.update((items) => [signal, ...items]);
    return signal;
  },

  transition(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        const previous = updated.status;
        updated.status = nextStatus;
        if (nextStatus === 'action_required' && updated.riskLevel === 'low') {
          updated.riskLevel = 'medium';
        }
        appendAudit(
          updated,
          actor,
          '状态流转',
          `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：${reason}`
        );
        updated.revision = (updated.revision ?? 0) + 1;
        return updated;
      })
    );
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        if (signal.status === 'merged') return signal; // 已合并信号只读
        const updated = structuredClone(signal);
        updated.evidence.unshift(evidence);
        appendAudit(
          updated,
          actor,
          '新增证据',
          `${evidence.title}，证据强度：${evidence.strength}`
        );
        updated.revision = (updated.revision ?? 0) + 1;
        return updated;
      })
    );
  },

  addVersion(id: string, version: CaseVersion, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        if (signal.status === 'merged') return signal;
        const updated = structuredClone(signal);
        updated.versions.unshift(version);
        appendAudit(updated, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
        updated.revision = (updated.revision ?? 0) + 1;
        return updated;
      })
    );
  },

  reopen(id: string, actor: string, reason: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.status = 'investigating';
        updated.reopenedCount += 1;
        appendAudit(updated, actor, '重新打开', reason);
        updated.revision = (updated.revision ?? 0) + 1;
        return updated;
      })
    );
  },

  replaceTask(id: string, task: InvestigationTask) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        if (signal.status === 'merged') return signal;
        const updated = structuredClone(signal);
        updated.tasks = updated.tasks.map((item) => (item.id === task.id ? task : item));
        appendAudit(updated, task.owner, '更新任务', `${task.title}：${task.status}`);
        updated.revision = (updated.revision ?? 0) + 1;
        return updated;
      })
    );
  },

  addAudit(id: string, entry: AuditEntry) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.audit.unshift(entry);
        updated.updatedAt = entry.createdAt;
        updated.revision = (updated.revision ?? 0) + 1;
        return updated;
      })
    );
  },

  /**
   * 幂等施加一个合并写入项。
   * - 找不到目标信号：报错，journal 条目留在 pending，稍后可恢复重试
   * - expectedRevision 与当前 revision 不一致：抛 RevisionMismatch，
   *   表示另一个页签/用户刚补过证据，不能盖掉
   */
  applyMergeItem(item: MergeItem, expectedRevision?: number): { conflict: boolean; error?: string } {
    let result: { conflict: boolean; error?: string } = { conflict: false };
    internal.update((items) => {
      const index = items.findIndex((signal) => signal.id === item.signalId);
      if (index < 0) {
        result = { conflict: false, error: `信号 ${item.signalId} 不在台账中` };
        return items;
      }
      const current = items[index];
      if (expectedRevision !== undefined && (current.revision ?? 0) !== expectedRevision) {
        result = {
          conflict: true,
          error: `信号 ${item.signalId} 版本已变化（保存时基于 V${expectedRevision}，当前 V${current.revision ?? 0}），对方可能刚补充了证据`
        };
        return items;
      }
      if (current.status === 'merged' && item.kind !== 'source_redirect') {
        result = { conflict: false, error: `信号 ${current.id} 已并入 ${current.mergedInto}，为只读去向` };
        return items;
      }
      const next = applyMergeItemToSignal(current, item);
      if (next === current) {
        // 幂等命中：条目此前已接入，直接视为成功且不增加 revision
        return items;
      }
      const copy = items.slice();
      copy[index] = next;
      return copy;
    });
    return result;
  },

  /** 仅供 merge runner 在一次恢复周期内读取最新 revision */
  getRevision(id: string): number | undefined {
    return get(internal).find((signal) => signal.id === id)?.revision ?? 0;
  },

  reset() {
    internal.set(cloneSeed());
  },

  getSnapshot() {
    return get(internal);
  }
};

export function createSignalFromForm(input: {
  title: string;
  product: string;
  batch: string;
  sourceType: SignalCase['sourceType'];
  severity: number;
  occurredAt: string;
  description: string;
}): SignalCase {
  const nowIso = now();
  return {
    id: `SIG-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`,
    title: input.title,
    product: input.product,
    batch: input.batch,
    sourceType: input.sourceType,
    status: 'new',
    riskLevel: riskFromSeverity(input.severity),
    severity: input.severity,
    reportCount: 1,
    exposedUnits: 0,
    occurrenceRate: 0,
    occurredAt: input.occurredAt,
    openedAt: nowIso,
    updatedAt: nowIso,
    owner: '待分派',
    description: input.description,
    affectedBatches: [input.batch],
    evidence: [],
    tasks: [
      {
        id: makeId('TASK'),
        title: '核对来源记录与产品批号',
        owner: '待分派',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        status: 'open'
      }
    ],
    versions: [],
    audit: [
      {
        id: makeId('AUD'),
        actor: '安全台账',
        action: '建立信号',
        detail: '由人工登记表单创建初始信号。',
        createdAt: nowIso
      }
    ],
    reopenedCount: 0,
    revision: 1
  };
}
