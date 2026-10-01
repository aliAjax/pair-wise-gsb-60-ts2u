import { z } from 'zod';

export const signalStatuses = [
  'new',
  'investigating',
  'observed',
  'action_required',
  'review',
  'closed',
  'merged'
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
  actor: z.string().trim().min(2, '请填写操作人')
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明')
});

export const versionSchema = z.object({
  id: z.string().min(1),
  author: z.string().trim().min(2, '请填写版本作者'),
  summary: z.string().trim().min(8, '结论摘要至少 8 个字符'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  rationale: z.string().trim().min(6, '请填写判断依据')
});

export const mergeSchema = z.object({
  primaryId: z.string().min(1, '请选择主信号'),
  sourceIds: z
    .array(z.string().min(1))
    .min(1, '至少选择一个来源信号')
    .refine((ids) => new Set(ids).size === ids.length, '来源信号重复'),
  actor: z.string().trim().min(2, '请填写负责人'),
  reason: z.string().trim().min(6, '合并依据至少 6 个字符'),
  baseRevisions: z.record(z.string(), z.number().int().nonnegative())
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
  /** 接入自主信号之外的来源信号时，记录来源信号号，用于证据矩阵追溯 */
  originSignalId?: string;
}

export interface InvestigationTask {
  id: string;
  title: string;
  owner: string;
  dueAt: string;
  status: 'open' | 'in_progress' | 'done';
  /** 合并接入的调查任务保留来源信号号 */
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
  /** 来源信号的结论版本并排保留，不替换主信号既有结论；复核人据此比对 */
  originSignalId?: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

/** 合并写入的最小单元。逐项落盘保证失败后可从断点续做，重试不重复接入。 */
export interface MergeItem {
  id: string;
  kind:
    | 'primary_evidence'
    | 'primary_task'
    | 'primary_version'
    | 'primary_batch'
    | 'primary_audit'
    | 'source_redirect'
    | 'primary_finalize';
  signalId: string;
  payload: unknown;
  status: 'pending' | 'done' | 'conflict';
  error?: string;
}

export interface MergeJournal {
  id: string;
  primaryId: string;
  sourceIds: string[];
  actor: string;
  reason: string;
  createdAt: string;
  finishedAt?: string;
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'conflict';
  items: MergeItem[];
  /** 计划合并时各信号的版本号，用于乐观并发校验 */
  baseRevisions: Record<string, number>;
  /** 失败/冲突时展示给后到方的冲突明细 */
  conflictDetail?: string;
}

export interface MergeConflict {
  signalId: string;
  expected: number;
  actual: number;
  reason: string;
}

export interface MergePlanResult {
  ok: boolean;
  journal?: MergeJournal;
  conflicts?: MergeConflict[];
  message?: string;
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
  audit: AuditEntry[];
  reopenedCount: number;
  /** 乐观并发版本号：任何写入（含另一个页签）都会 +1，保存时核对 */
  revision?: number;
  /** 被合并后指向主信号；原信号保留为只读去向 */
  mergedInto?: string;
  /** 主信号记录并入的来源信号号 */
  mergedFrom?: string[];
  mergedAt?: string;
  mergedBy?: string;
}

export interface SignalFilters {
  query?: string;
  status?: SignalStatus | 'all';
  riskLevel?: RiskLevel | 'all';
  sourceType?: SignalSourceType | 'all';
}
