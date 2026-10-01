import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  IncomingVersion,
  InvestigationTask,
  SignalCase,
  SignalStatus,
  RiskLevel
} from '$lib/models/signal';
import { seedSignals } from '$lib/services/seed';
import { get, writable } from 'svelte/store';

const STORAGE_KEY = 'medical-safety-signals-v1';

/** 乐观并发：写入时持有的修订号已过期（另一个页签/操作先写入） */
export class RevisionConflictError extends Error {
  constructor(
    public signalId: string,
    public expected: number,
    public actual: number
  ) {
    super(`信号 ${signalId} 已被其他操作更新（修订号 ${expected} -> ${actual}），请刷新后重试。`);
    this.name = 'RevisionConflictError';
  }
}

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

/** 为旧版本 localStorage 数据补齐合并功能所需字段 */
function migrate(signals: SignalCase[]): SignalCase[] {
  return signals.map((signal) => ({
    ...signal,
    incomingVersions: signal.incomingVersions ?? [],
    mergedSources: signal.mergedSources ?? [],
    revision: typeof signal.revision === 'number' ? signal.revision : 1
  }));
}

function readPersisted(): SignalCase[] {
  if (!browser) return cloneSeed();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? migrate(JSON.parse(raw) as SignalCase[]) : cloneSeed();
  } catch {
    return cloneSeed();
  }
}

const internal = writable<SignalCase[]>(readPersisted());

if (browser) {
  internal.subscribe((value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  });

  // 另一个页签完成写入后，本页签同步到最新快照，后续合并提交即可检出冲突
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      internal.set(migrate(JSON.parse(event.newValue) as SignalCase[]));
    } catch {
      // 解析失败时保留当前内存状态
    }
  });
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
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
    closed: '已关闭'
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

/** 从 localStorage 强制刷新（storage 事件只在跨页签时触发，本页签提交前也主动读一次） */
function refreshFromStorage(): SignalCase[] {
  if (!browser) return get(internal);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) internal.set(migrate(JSON.parse(raw) as SignalCase[]));
  } catch {
    // 保留当前内存状态
  }
  return get(internal);
}

/**
 * 带显式受影响集合的原子提交。变更函数接收深拷贝与 markTouched。
 * expectedRevisions 中任一信号修订号不符即整体放弃，抛 RevisionConflictError：
 * 后来方不能盖掉先写入方刚补的证据。
 */
function commitTracked(
  mutate: (items: SignalCase[], markTouched: (id: string) => void) => void,
  expectedRevisions: Record<string, number> = {}
): SignalCase[] {
  const current = refreshFromStorage();

  for (const [id, expected] of Object.entries(expectedRevisions)) {
    const target = current.find((signal) => signal.id === id);
    if (target && target.revision !== expected) {
      throw new RevisionConflictError(id, expected, target.revision);
    }
  }

  const next = structuredClone(current);
  const touched = new Set<string>();
  mutate(next, (id) => touched.add(id));

  const at = now();
  for (const signal of next) {
    if (touched.has(signal.id)) {
      signal.revision += 1;
      signal.updatedAt = at;
    }
  }

  internal.set(next);
  return next;
}

export const signalStore = {
  subscribe: internal.subscribe,

  /** 主动与持久层同步（开始合并前调用） */
  refresh() {
    return refreshFromStorage();
  },

  add(signal: SignalCase) {
    internal.update((items) => [signal, ...items]);
  },

  create(input: Omit<SignalCase, 'id' | 'openedAt' | 'updatedAt' | 'audit' | 'reopenedCount'>) {
    const createdAt = now();
    const signal: SignalCase = {
      ...input,
      id: `SIG-${new Date().getFullYear()}-${String(get(internal).length + 20).padStart(3, '0')}`,
      openedAt: createdAt,
      updatedAt: createdAt,
      reopenedCount: 0,
      incomingVersions: [],
      mergedSources: [],
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

  transition(
    id: string,
    nextStatus: SignalStatus,
    reason: string,
    actor: string,
    expectedRevision?: number
  ) {
    commitTracked(
      (items, mark) => {
        const updated = items.find((signal) => signal.id === id);
        if (!updated) return;
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
        mark(id);
      },
      typeof expectedRevision === 'number' ? { [id]: expectedRevision } : {}
    );
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string, expectedRevision?: number) {
    commitTracked(
      (items, mark) => {
        const updated = items.find((signal) => signal.id === id);
        if (!updated) return;
        updated.evidence.unshift(evidence);
        appendAudit(
          updated,
          actor,
          '新增证据',
          `${evidence.title}，证据强度：${evidence.strength}`
        );
        mark(id);
      },
      typeof expectedRevision === 'number' ? { [id]: expectedRevision } : {}
    );
  },

  addVersion(id: string, version: CaseVersion, actor: string, expectedRevision?: number) {
    commitTracked(
      (items, mark) => {
        const updated = items.find((signal) => signal.id === id);
        if (!updated) return;
        updated.versions.unshift(version);
        appendAudit(updated, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
        mark(id);
      },
      typeof expectedRevision === 'number' ? { [id]: expectedRevision } : {}
    );
  },

  addIncomingVersion(
    id: string,
    incoming: IncomingVersion,
    actor: string,
    detail: string,
    expectedRevision?: number
  ) {
    commitTracked(
      (items, mark) => {
        const updated = items.find((signal) => signal.id === id);
        if (!updated) return;
        updated.incomingVersions.unshift(incoming);
        appendAudit(updated, actor, '待复核结论', detail);
        mark(id);
      },
      typeof expectedRevision === 'number' ? { [id]: expectedRevision } : {}
    );
  },

  reviewIncomingVersion(
    id: string,
    incomingId: string,
    decision: 'adopt' | 'dismiss',
    reviewer: string,
    note: string,
    expectedRevision?: number
  ) {
    commitTracked(
      (items, mark) => {
        const updated = items.find((signal) => signal.id === id);
        if (!updated) return;
        const incoming = updated.incomingVersions.find((item) => item.id === incomingId);
        if (!incoming || incoming.reviewStatus !== 'pending') return;

        incoming.reviewStatus = decision === 'adopt' ? 'adopted' : 'dismissed';
        incoming.reviewedBy = reviewer;
        incoming.reviewedAt = now();
        incoming.reviewNote = note;

        if (decision === 'adopt') {
          const nextVersionNumber = (updated.versions[0]?.version ?? 0) + 1;
          updated.versions.unshift({
            id: makeId('V'),
            version: nextVersionNumber,
            author: reviewer,
            summary: incoming.summary,
            disposition: incoming.disposition,
            rationale: `采纳来源信号 ${incoming.sourceSignalId} V${incoming.version} 的结论：${incoming.rationale}；复核意见：${note}`,
            createdAt: now(),
            originId: incoming.originVersionId,
            originSignalId: incoming.sourceSignalId
          });
          appendAudit(
            updated,
            reviewer,
            '采纳并入结论',
            `采纳来源 ${incoming.sourceSignalId} V${incoming.version}，形成 V${nextVersionNumber}。`
          );
        } else {
          appendAudit(
            updated,
            reviewer,
            '驳回并入结论',
            `驳回来源 ${incoming.sourceSignalId} V${incoming.version}：${note}`
          );
        }
        mark(id);
      },
      typeof expectedRevision === 'number' ? { [id]: expectedRevision } : {}
    );
  },

  reopen(id: string, actor: string, reason: string, expectedRevision?: number) {
    commitTracked(
      (items, mark) => {
        const updated = items.find((signal) => signal.id === id);
        if (!updated) return;
        updated.status = 'investigating';
        updated.reopenedCount += 1;
        appendAudit(updated, actor, '重新打开', reason);
        mark(id);
      },
      typeof expectedRevision === 'number' ? { [id]: expectedRevision } : {}
    );
  },

  replaceTask(id: string, task: InvestigationTask) {
    commitTracked((items, mark) => {
      const updated = items.find((signal) => signal.id === id);
      if (!updated) return;
      updated.tasks = updated.tasks.map((item) => (item.id === task.id ? task : item));
      appendAudit(updated, task.owner, '更新任务', `${task.title}：${task.status}`);
      mark(id);
    });
  },

  addAudit(id: string, entry: AuditEntry) {
    commitTracked((items, mark) => {
      const updated = items.find((signal) => signal.id === id);
      if (!updated) return;
      updated.audit.unshift(entry);
      mark(id);
    });
  },

  /**
   * 合并专用批次：一次提交原子修改主信号（和来源信号）。
   * touchSource 为 false 时只改主信号（证据/任务/结论阶段，不推进来源修订号）；
   * 最终阶段封口来源时传 true。冲突检测始终覆盖主信号与来源。
   */
  commitMergeBatch(
    masterId: string,
    sourceId: string,
    expected: { master: number; source: number },
    apply: (master: SignalCase, source: SignalCase) => void,
    touchSource = false
  ) {
    commitTracked(
      (items, mark) => {
        const master = items.find((signal) => signal.id === masterId);
        const source = items.find((signal) => signal.id === sourceId);
        if (!master || !source) return;
        apply(master, source);
        mark(masterId);
        if (touchSource) mark(sourceId);
      },
      { [masterId]: expected.master, [sourceId]: expected.source }
    );
  },

  /** 合并冲突后，用当前修订号重置期望基线（保留已完成进度，准备续跑） */
  currentRevisions(ids: string[]): Record<string, number> {
    const snapshot = refreshFromStorage();
    const result: Record<string, number> = {};
    for (const id of ids) {
      const signal = snapshot.find((item) => item.id === id);
      if (signal) result[id] = signal.revision;
    }
    return result;
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
    incomingVersions: [],
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
    revision: 1,
    mergedSources: []
  };
}
