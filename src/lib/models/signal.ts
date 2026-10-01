import { z } from 'zod';

export const signalStatuses = [
  'new',
  'investigating',
  'observed',
  'action_required',
  'review',
  'closed'
] as const;

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const evidenceStrengths = ['strong', 'moderate', 'weak', 'contrary'] as const;

export const createSignalSchema = z.object({
  title: z.string().trim().min(6, '信号标题至少 6 个字符'),
  product: z.string().trim().min(2, '请输入产品名称'),
  batch: z.string().trim().min(2, '请输入批号'),
  sourceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report']),
  severity: z.coerce.number().int().min(1).max(5),
  occurredAt: z.string().min(1, '请选择发生日期'),
  description: z.string().trim().min(10, '经过说明至少 10 个字符')
});

export const transitionSchema = z.object({
  id: z.string().min(1),
  nextStatus: z.enum(signalStatuses),
  reason: z.string().trim().min(4, '请填写流转依据'),
  actor: z.string().trim().min(2, '请填写操作人'),
  revision: z.coerce.number().int().positive().optional()
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明'),
  revision: z.coerce.number().int().positive().optional()
});

export const versionSchema = z.object({
  id: z.string().min(1),
  author: z.string().trim().min(2, '请填写版本作者'),
  summary: z.string().trim().min(8, '结论摘要至少 8 个字符'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  rationale: z.string().trim().min(6, '请填写判断依据'),
  revision: z.coerce.number().int().positive().optional()
});

export type SignalStatus = (typeof signalStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type EvidenceStrength = (typeof evidenceStrengths)[number];
export type SignalSourceType = z.infer<typeof createSignalSchema>['sourceType'];
export type Disposition = z.infer<typeof versionSchema>['disposition'];

export interface EvidenceItem {
  id: string;
  type: SignalSourceType | 'test' | 'literature';
  title: string;
  source: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  createdAt: string;
  /** 合并接入时保留的原始证据 ID，用于重试去重 */
  originId?: string;
  /** 接入来源信号 */
  originSignalId?: string;
}

export interface InvestigationTask {
  id: string;
  title: string;
  owner: string;
  dueAt: string;
  status: 'open' | 'in_progress' | 'done';
  originId?: string;
  originSignalId?: string;
}

export interface CaseVersion {
  id: string;
  version: number;
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
  createdAt: string;
  originId?: string;
  originSignalId?: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
  originId?: string;
  originSignalId?: string;
}

/**
 * 来源信号并入主信号后，以并排方式保留给复核人的结论版本。
 * 不直接进入主信号 versions，也不覆盖当前结论。
 */
export interface IncomingVersion {
  id: string;
  /** 来源信号 ID */
  sourceSignalId: string;
  /** 来源结论原始版本 ID */
  originVersionId: string;
  version: number;
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
  createdAt: string;
  mergedAt: string;
  reviewStatus: 'pending' | 'adopted' | 'dismissed';
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

/** 来源信号被合并后保留的只读去向记录 */
export interface MergedSourceRef {
  /** 来源信号 ID */
  signalId: string;
  title: string;
  sourceType: SignalSourceType;
  owner: string;
  mergedAt: string;
  mergedBy: string;
  evidenceCount: number;
  taskCount: number;
  versionCount: number;
}

export interface MergeTargetRef {
  masterSignalId: string;
  masterTitle: string;
  mergedAt: string;
  mergedBy: string;
}

export interface SignalCase {
  id: string;
  title: string;
  product: string;
  batch: string;
  sourceType: SignalSourceType;
  status: SignalStatus;
  riskLevel: RiskLevel;
  severity: number;
  reportCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  occurredAt: string;
  openedAt: string;
  updatedAt: string;
  owner: string;
  description: string;
  affectedBatches: string[];
  evidence: EvidenceItem[];
  tasks: InvestigationTask[];
  versions: CaseVersion[];
  /** 来源信号结论并排待复核区，不替代 versions */
  incomingVersions: IncomingVersion[];
  audit: AuditEntry[];
  reopenedCount: number;
  /** 每次任何写入递增，用于合并时的乐观并发校验 */
  revision: number;
  /** 作为来源信号被合并后的只读去向 */
  mergedInto?: MergeTargetRef;
  /** 已并入本主信号的来源信号清单 */
  mergedSources: MergedSourceRef[];
}

export type MergeContentType = 'evidence' | 'tasks' | 'versions' | 'audit';

export interface MergeSourceProgress {
  signalId: string;
  title: string;
  /** 已完成接入的内容类别；恢复时据此跳过，保证重试不重复接入 */
  attached: MergeContentType[];
  status: 'pending' | 'attaching' | 'done' | 'conflict' | 'failed';
  error?: string;
}

export interface MergeJob {
  id: string;
  masterId: string;
  masterTitle: string;
  sourceIds: string[];
  actor: string;
  reason: string;
  status: 'running' | 'conflict' | 'failed' | 'completed';
  /** 建立合并时主信号的修订号；提交时若已变化则判定并发冲突 */
  expectedMasterRevision: number;
  /** 各来源信号建立时的修订号，用于检测对方是否刚补过证据 */
  expectedSourceRevisions: Record<string, number>;
  progress: MergeSourceProgress[];
  createdAt: string;
  updatedAt: string;
  conflict?: {
    masterChanged: boolean;
    changedSourceIds: string[];
    detail: string;
  };
}

export interface SignalFilters {
  query?: string;
  status?: SignalStatus | 'all';
  riskLevel?: RiskLevel | 'all';
  sourceType?: SignalSourceType | 'all';
}

export const mergeSignalsSchema = z
  .object({
    masterId: z.string().min(1, '请选择主信号'),
    sourceIds: z.array(z.string().min(1)).min(1, '请至少选择一个来源信号'),
    actor: z.string().trim().min(2, '请填写合并负责人'),
    reason: z.string().trim().min(8, '合并依据至少 8 个字符')
  })
  .refine((data) => !data.sourceIds.includes(data.masterId), {
    message: '主信号不能同时作为来源信号',
    path: ['sourceIds']
  });

export const reviewIncomingVersionSchema = z.object({
  signalId: z.string().min(1),
  incomingId: z.string().min(1),
  decision: z.enum(['adopt', 'dismiss']),
  reviewer: z.string().trim().min(2, '请填写复核人'),
  note: z.string().trim().min(4, '请填写复核意见')
});
