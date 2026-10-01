<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type { AuditEntry, CaseVersion, Disposition, EvidenceItem, SignalStatus } from '$lib/models/signal';
  import { exportSignalReport } from '$lib/services/signal-service';
  import { RevisionConflictError, signalStore } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: nextVersion = (signal?.versions[0]?.version ?? 0) + 1;
  $: readOnly = !!signal?.mergedInto;
  $: mergedInto = signal?.mergedInto;

  const dispositionLabels: Record<Disposition, string> = {
    continue_observation: '继续观察',
    risk_communication: '风险沟通',
    corrective_action: '纠正措施'
  };

  let actionError = '';

  function guardRevision(error: unknown) {
    if (error instanceof RevisionConflictError) {
      actionError = error.message;
    } else if (error instanceof Error) {
      actionError = error.message;
    }
  }

  const statusOptions: Array<{ value: SignalStatus; label: string }> = [
    { value: 'investigating', label: '转入调查' },
    { value: 'observed', label: '持续观察' },
    { value: 'action_required', label: '进入风险处置' },
    { value: 'review', label: '提交复核' },
    { value: 'closed', label: '关闭信号' }
  ];

  const transitionHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          transition?: { id: string; nextStatus: SignalStatus; reason: string; actor: string; revision?: string };
        };
        if (payload.transition) {
          try {
            signalStore.transition(
              payload.transition.id,
              payload.transition.nextStatus,
              payload.transition.reason,
              payload.transition.actor,
              payload.transition.revision ? Number(payload.transition.revision) : undefined
            );
            actionError = '';
          } catch (error) {
            guardRevision(error);
          }
        }
      }
      await update({ reset: true });
    };
  };
</script>

<svelte:head><title>{signal?.id ?? data.id} | 信号核查详情</title></svelte:head>

{#if !signal}
  <section class="rounded border border-error-300 bg-error-50 p-6 text-error-900">
    未找到信号 {data.id}。它可能已被本地数据重置。
  </section>
{:else}
  <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex flex-wrap items-center gap-3">
        <a class="text-sm text-primary-700-300 hover:underline" href="/signals">返回信号台账</a>
        <span class="text-surface-400">/</span>
        <span class="text-sm text-surface-500-400">{signal.id}</span>
      </div>
      <h1 class="mt-3 max-w-4xl text-2xl font-semibold">{signal.title}</h1>
      <div class="mt-3"><RiskBadge risk={signal.riskLevel} status={signal.status} /></div>
    </div>
    <button class="btn variant-soft-primary" type="button" on:click={() => exportSignalReport(signal.id)}>
      导出可追溯报告
    </button>
  </div>

  {#if form?.message}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{form.message}</div>
  {/if}
  {#if actionError}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">
      <p class="font-medium">写入被拒绝（乐观并发保护）</p>
      <p class="mt-1">{actionError}</p>
      <p class="mt-1">页面展示的是较早快照，请刷新页面核对他人刚补充的证据后再提交。</p>
    </div>
  {/if}

  {#if mergedInto}
    <section class="mb-5 rounded border border-warning-300 bg-warning-50 p-4 text-sm text-warning-900">
      <p class="font-medium">本信号已作为来源信号并入，此后只读留痕。</p>
      <p class="mt-1">
        去向：
        <a class="font-medium underline" href={`/signals/${mergedInto.masterSignalId}`}>
          {mergedInto.masterSignalId} · {mergedInto.masterTitle}
        </a>
        ；合并人 {mergedInto.mergedBy}，时间 {mergedInto.mergedAt.slice(0, 16).replace('T', ' ')}。
      </p>
    </section>
  {/if}

  {#if signal.mergedSources.length > 0}
    <section class="mb-5 rounded border border-success-300 bg-success-50 p-4 text-sm text-success-900">
      <p class="font-medium">本主信号已并入 {signal.mergedSources.length} 个来源信号：</p>
      <ul class="mt-2 space-y-1">
        {#each signal.mergedSources as source}
          <li>
            <a class="underline" href={`/signals/${source.signalId}`}>{source.signalId}</a>
            · {source.title} · 证据 {source.evidenceCount} / 任务 {source.taskCount} / 结论 {source.versionCount}
            · {source.mergedBy} · {source.mergedAt.slice(0, 10)}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="workspace-grid mb-6">
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-8">
      <div class="grid gap-5 md:grid-cols-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">产品与批号</p>
          <p class="mt-1 font-medium">{signal.product}</p>
          <p class="mt-1 text-sm text-surface-600-300">{signal.affectedBatches.join(' / ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">调查负责人</p>
          <p class="mt-1 font-medium">{signal.owner}</p>
          <p class="mt-1 text-sm text-surface-600-300">最后更新 {signal.updatedAt.slice(0, 16).replace('T', ' ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">报告与暴露</p>
          <p class="metric-value mt-1 font-medium">{signal.reportCount} 条 / {signal.exposedUnits} 台</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">核查发生率</p>
          <p class="metric-value mt-1 font-medium">{signal.occurrenceRate.toFixed(2)}%</p>
        </div>
      </div>
      <div class="section-rule mt-5 pt-5">
        <p class="text-sm leading-6 text-surface-700-300">{signal.description}</p>
      </div>
    </article>

    <aside class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-4">
      <h2 class="font-semibold">状态流转</h2>
      <p class="mt-1 text-xs text-surface-500-400">每次流转都记录依据、操作人和时间。</p>
      <form
        class="mt-4 space-y-3"
        method="POST"
        action="?/transition"
        use:enhance={transitionHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="revision" value={signal.revision} />
        <label class="block">
          <span class="mb-1 block text-sm font-medium">目标状态</span>
          <select class="select" name="nextStatus" disabled={readOnly}>
            {#each statusOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">操作人</span>
          <input class="input" name="actor" value={signal.owner} disabled={readOnly} />
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">流转依据</span>
          <textarea class="textarea" name="reason" rows="3" placeholder="说明新增证据、风险判断或复核结论" disabled={readOnly}></textarea>
        </label>
        <button class="btn w-full variant-filled-primary" type="submit" disabled={readOnly}>
          {readOnly ? '来源信号只读' : '提交状态流转'}
        </button>
        <p class="text-xs text-surface-500-400">当前修订号 r{signal.revision}；若他页先写入，本次提交将被拒绝而非覆盖。</p>
      </form>

      {#if signal.status === 'closed' && !readOnly}
        <div class="section-rule mt-5 pt-5">
          <h3 class="font-medium">新事件重新打开</h3>
          <p class="mt-1 text-xs text-surface-500-400">关闭信号收到新报告时，不允许静默修改结论。</p>
          <form
            class="mt-3 space-y-3"
            method="POST"
            action="?/reopen"
            use:enhance={() =>
              async ({ result, update }) => {
                if (result.type === 'success') {
                  const payload = result.data as { reopen?: { id: string; actor: string; reason: string } };
                  if (payload.reopen) {
                    signalStore.reopen(payload.reopen.id, payload.reopen.actor, payload.reopen.reason);
                  }
                }
                await update({ reset: true });
              }}
          >
            <input type="hidden" name="id" value={signal.id} />
            <input class="input" name="actor" value={signal.owner} aria-label="操作人" />
            <textarea class="textarea" name="reason" rows="2" placeholder="描述新报告及其影响"></textarea>
            <button class="btn w-full variant-soft-error" type="submit">重新打开信号</button>
          </form>
        </div>
      {/if}
    </aside>
  </section>

  <section class="mb-6">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">证据矩阵</h2>
        <p class="mt-1 text-sm text-surface-500-400">强支持、弱支持和相反证据并列保存，不覆盖替代解释。</p>
      </div>
      <span class="badge">{signal.evidence.length} 项证据</span>
    </div>
    <EvidenceMatrix evidence={signal.evidence} />
  </section>

  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">调查任务</h2>
        <p class="mt-1 text-sm text-surface-500-400">来源信号的未完成任务一并接入，保留完成态与原负责人。</p>
      </div>
      <span class="badge">{signal.tasks.length} 项任务</span>
    </div>
    <ul class="grid gap-2 md:grid-cols-2">
      {#each signal.tasks as task}
        <li class="flex flex-wrap items-center gap-2 rounded border border-surface-300-700 p-3 text-sm">
          <span
            class="badge {task.status === 'done'
              ? 'variant-soft-success'
              : task.status === 'in_progress'
                ? 'variant-soft-primary'
                : 'variant-ghost-surface'}"
          >
            {task.status === 'done' ? '已完成' : task.status === 'in_progress' ? '进行中' : '待开始'}
          </span>
          <span class="font-medium">{task.title}</span>
          <span class="text-xs text-surface-500-400">{task.owner} · 截止 {task.dueAt}</span>
          {#if task.originSignalId}
            <span class="badge variant-soft-primary">来自 {task.originSignalId}</span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <div class="grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">补充核查证据</h2>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/evidence"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') {
              const payload = result.data as { evidence?: EvidenceItem; actor?: string; revision?: number };
              if (payload.evidence) {
                try {
                  signalStore.addEvidence(signal.id, payload.evidence, payload.actor ?? signal.owner, payload.revision);
                  actionError = '';
                } catch (error) {
                  guardRevision(error);
                }
              }
            }
            await update({ reset: true });
          }}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="revision" value={signal.revision} />
        <label>
          <span class="mb-1 block text-sm font-medium">证据类型</span>
          <select class="select" name="evidenceType" disabled={readOnly}>
            <option value="complaint">投诉</option>
            <option value="repair">维修</option>
            <option value="adverse_event">不良事件</option>
            <option value="field_report">现场报告</option>
            <option value="test">测试</option>
            <option value="literature">文献</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据强度</span>
          <select class="select" name="strength" disabled={readOnly}>
            <option value="strong">强支持</option>
            <option value="moderate">中等支持</option>
            <option value="weak">弱支持</option>
            <option value="contrary">相反证据</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据名称</span>
          <input class="input" name="title" disabled={readOnly} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">来源</span>
          <input class="input" name="source" disabled={readOnly} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">关联批号</span>
          <input class="input" name="batch" value={signal.batch} disabled={readOnly} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">录入人</span>
          <input class="input" name="actor" value={signal.owner} disabled={readOnly} />
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">核查说明</span>
          <textarea class="textarea" name="note" rows="3" disabled={readOnly}></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-primary" type="submit" disabled={readOnly}>
            {readOnly ? '来源信号只读' : '加入证据矩阵'}
          </button>
        </div>
      </form>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">形成结论版本</h2>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/version"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') {
              const payload = result.data as { version?: CaseVersion; actor?: string; revision?: number };
              if (payload.version) {
                try {
                  signalStore.addVersion(signal.id, payload.version, payload.actor ?? signal.owner, payload.revision);
                  actionError = '';
                } catch (error) {
                  guardRevision(error);
                }
              }
            }
            await update({ reset: true });
          }}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="versionNumber" value={nextVersion} />
        <input type="hidden" name="revision" value={signal.revision} />
        <label>
          <span class="mb-1 block text-sm font-medium">版本作者</span>
          <input class="input" name="author" value={signal.owner} disabled={readOnly} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">建议处置</span>
          <select class="select" name="disposition" disabled={readOnly}>
            <option value="continue_observation">继续观察</option>
            <option value="risk_communication">风险沟通</option>
            <option value="corrective_action">纠正措施</option>
          </select>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">结论摘要</span>
          <textarea class="textarea" name="summary" rows="2" disabled={readOnly}></textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">判断依据与替代解释</span>
          <textarea class="textarea" name="rationale" rows="3" disabled={readOnly}></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-secondary" type="submit" disabled={readOnly}>
            {readOnly ? '来源信号只读' : `保存为 V${nextVersion}`}
          </button>
        </div>
      </form>
    </section>
  </div>

  <div class="mt-6 grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">结论版本（主信号）</h2>
      <p class="mt-1 text-xs text-surface-500-400">来源信号的结论不会替换这里，只在右侧并排留给复核人。</p>
      <div class="mt-4 space-y-4">
        {#each signal.versions as version}
          <article class="border-l-2 border-teal-600 pl-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{version.version} · {version.author}</p>
              <span class="text-xs text-surface-500-400">{version.createdAt.slice(0, 10)}</span>
            </div>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-2 text-xs text-surface-500-400">{version.rationale}</p>
            {#if version.originSignalId}
              <p class="mt-2 text-xs font-medium text-success-700">
                采纳自来源 <a class="underline" href={`/signals/${version.originSignalId}`}>{version.originSignalId}</a> 的结论
              </p>
            {/if}
          </article>
        {:else}
          <p class="text-sm text-surface-500-400">尚未形成正式结论版本。</p>
        {/each}
      </div>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">待复核的来源结论（并排）</h2>
      <p class="mt-1 text-xs text-surface-500-400">
        合并接入的来源结论保留原始判断，不自动覆盖主结论；复核人可逐条采纳（生成新版本）或驳回。
      </p>
      <div class="mt-4 space-y-4">
        {#each signal.incomingVersions as incoming}
          <article
            class="rounded border p-3 {incoming.reviewStatus === 'pending'
              ? 'border-warning-300 bg-warning-50'
              : incoming.reviewStatus === 'adopted'
                ? 'border-success-300 bg-success-50'
                : 'border-surface-300-700 opacity-70'}"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium">
                来源
                <a class="underline" href={`/signals/${incoming.sourceSignalId}`}>{incoming.sourceSignalId}</a>
                · V{incoming.version} · {incoming.author}
              </p>
              <span class="text-xs text-surface-500-400">{incoming.createdAt.slice(0, 10)}</span>
            </div>
            <p class="mt-2 text-sm">{incoming.summary}</p>
            <p class="mt-1 text-xs text-surface-500-400">
              建议处置：{dispositionLabels[incoming.disposition]}；{incoming.rationale}
            </p>

            {#if incoming.reviewStatus === 'pending'}
              <form
                method="POST"
                action="?/reviewIncoming"
                class="mt-3 grid gap-2"
                use:enhance={() =>
                  async ({ result, update }) => {
                    if (result.type === 'success') {
                      const payload = result.data as {
                        reviewIncoming?: {
                          signalId: string;
                          incomingId: string;
                          decision: 'adopt' | 'dismiss';
                          reviewer: string;
                          note: string;
                        };
                      };
                      if (payload.reviewIncoming) {
                        try {
                          signalStore.reviewIncomingVersion(
                            payload.reviewIncoming.signalId,
                            payload.reviewIncoming.incomingId,
                            payload.reviewIncoming.decision,
                            payload.reviewIncoming.reviewer,
                            payload.reviewIncoming.note
                          );
                          actionError = '';
                        } catch (error) {
                          guardRevision(error);
                        }
                      }
                    }
                    await update({ reset: true });
                  }}
              >
                <input type="hidden" name="signalId" value={signal.id} />
                <input type="hidden" name="incomingId" value={incoming.id} />
                <div class="flex gap-2">
                  <input class="input flex-1" name="reviewer" placeholder="复核人" value={signal.owner} disabled={readOnly} />
                  <button class="btn btn-sm variant-filled-primary" name="decision" value="adopt" type="submit" disabled={readOnly}>
                    采纳为新版本
                  </button>
                  <button class="btn btn-sm variant-soft-error" name="decision" value="dismiss" type="submit" disabled={readOnly}>
                    驳回
                  </button>
                </div>
                <input class="input" name="note" placeholder="复核意见（至少 4 个字符）" disabled={readOnly} />
              </form>
            {:else}
              <p class="mt-2 text-xs font-medium">
                {incoming.reviewStatus === 'adopted' ? '已采纳并生成主信号新版本' : '已驳回'}
                · {incoming.reviewedBy} · {incoming.reviewedAt?.slice(0, 10)}
              </p>
              {#if incoming.reviewNote}
                <p class="mt-1 text-xs text-surface-500-400">复核意见：{incoming.reviewNote}</p>
              {/if}
            {/if}
          </article>
        {:else}
          <p class="text-sm text-surface-500-400">没有待复核的来源结论。</p>
        {/each}
      </div>
    </section>
  </div>

  <div class="mt-6">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">审计记录</h2>
      <div class="mt-4 grid gap-5 lg:grid-cols-2">
        {#each signal.audit as entry}
          <div class="timeline-item">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium">
                {entry.action} · {entry.actor}
                {#if entry.originSignalId}
                  <span class="badge variant-soft-primary ml-1">来自 {entry.originSignalId}</span>
                {/if}
              </p>
              <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <p class="mt-1 text-xs text-surface-500-400">{entry.detail}</p>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}
