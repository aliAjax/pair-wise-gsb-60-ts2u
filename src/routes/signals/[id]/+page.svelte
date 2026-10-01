<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type { AuditEntry, CaseVersion, EvidenceItem, SignalStatus } from '$lib/models/signal';
  import { exportSignalReport } from '$lib/services/signal-service';
  import { isReadOnly } from '$lib/services/merge-service';
  import { signalStore } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: nextVersion = (signal?.versions[0]?.version ?? 0) + 1;
  $: readOnly = signal ? isReadOnly(signal) : false;
  $: primaryHasVersion = (signal?.versions.filter((version) => !version.originSignalId).length ?? 0) > 0;

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
          transition?: { id: string; nextStatus: SignalStatus; reason: string; actor: string };
        };
        if (payload.transition) {
          signalStore.transition(
            payload.transition.id,
            payload.transition.nextStatus,
            payload.transition.reason,
            payload.transition.actor
          );
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

  {#if readOnly}
    <section class="mb-6 rounded border border-teal-300 bg-teal-50 p-4 dark:border-teal-700 dark:bg-teal-950">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="font-semibold text-teal-900 dark:text-teal-200">该信号已并入主信号（只读去向）</h2>
          <p class="mt-1 text-sm text-teal-800 dark:text-teal-300">
            证据矩阵、调查任务、结论版本与审计记录已于 {signal.mergedAt?.slice(0, 16).replace('T', ' ')}
            由 {signal.mergedBy} 并入 <span class="font-medium">{signal.mergedInto}</span>；原信号保留备查，不再接受写入。
          </p>
        </div>
        <a class="btn variant-filled-primary btn-sm" href={`/signals/${signal.mergedInto}`}>前往主信号 {signal.mergedInto}</a>
      </div>
    </section>
  {/if}

  {#if signal.mergedFrom?.length}
    <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="font-semibold">合并来源</h2>
          <p class="mt-1 text-xs text-surface-500-400">
            以下来源信号的证据、任务、结论与审计已接入本主信号，原信号保留为只读去向。
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          {#each signal.mergedFrom as sourceId}
            <a class="btn btn-sm variant-ghost-surface" href={`/signals/${sourceId}`}>{sourceId}</a>
          {/each}
        </div>
      </div>
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
      {#if readOnly}
        <p class="mt-4 rounded bg-surface-200-800 p-3 text-sm text-surface-600-300">
          信号已并入主信号，状态流转已锁定。如需继续调查，请在主信号 {signal.mergedInto} 上操作。
        </p>
      {:else}
        <form
          class="mt-4 space-y-3"
          method="POST"
          action="?/transition"
          use:enhance={transitionHandler}
        >
        <input type="hidden" name="id" value={signal.id} />
        <label class="block">
          <span class="mb-1 block text-sm font-medium">目标状态</span>
          <select class="select" name="nextStatus">
            {#each statusOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">操作人</span>
          <input class="input" name="actor" value={signal.owner} />
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">流转依据</span>
          <textarea class="textarea" name="reason" rows="3" placeholder="说明新增证据、风险判断或复核结论"></textarea>
        </label>
        <button class="btn w-full variant-filled-primary" type="submit">提交状态流转</button>
      </form>

        {#if signal.status === 'closed'}
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

  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900">
    <div class="flex items-center justify-between border-b border-surface-300-700 px-4 py-3">
      <div>
        <h2 class="text-lg font-semibold">调查任务</h2>
        <p class="mt-1 text-sm text-surface-500-400">来源信号并入的任务保留原负责人，并标注来源信号号。</p>
      </div>
      <span class="badge">{signal.tasks.length} 个任务</span>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[720px]">
        <thead>
          <tr>
            <th>任务</th>
            <th>负责人</th>
            <th>截止日</th>
            <th>状态</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          {#each signal.tasks as task}
            <tr>
              <td class="font-medium">{task.title}</td>
              <td>{task.owner}</td>
              <td class="metric-value">{task.dueAt}</td>
              <td>
                {task.status === 'done'
                  ? '已完成'
                  : task.status === 'in_progress'
                    ? '进行中'
                    : '待开始'}
              </td>
              <td>
                {#if task.originSignalId}
                  <a class="text-xs font-medium text-amber-700 hover:underline" href={`/signals/${task.originSignalId}`}>
                    合并自 {task.originSignalId}
                  </a>
                {:else}
                  <span class="text-xs text-surface-500-400">主信号</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <div class="grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">补充核查证据</h2>
      {#if readOnly}
        <p class="mt-3 rounded bg-surface-200-800 p-3 text-sm text-surface-600-300">
          原信号只读，证据补充请在主信号 {signal.mergedInto} 上进行。
        </p>
      {:else}
        <form
          class="mt-4 grid gap-4 md:grid-cols-2"
          method="POST"
          action="?/evidence"
          use:enhance={() =>
            async ({ result, update }) => {
              if (result.type === 'success') {
                const payload = result.data as { evidence?: EvidenceItem; actor?: string };
                if (payload.evidence) signalStore.addEvidence(signal.id, payload.evidence, payload.actor ?? signal.owner);
              }
              await update({ reset: true });
            }}
        >
        <input type="hidden" name="id" value={signal.id} />
        <label>
          <span class="mb-1 block text-sm font-medium">证据类型</span>
          <select class="select" name="evidenceType">
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
          <select class="select" name="strength">
            <option value="strong">强支持</option>
            <option value="moderate">中等支持</option>
            <option value="weak">弱支持</option>
            <option value="contrary">相反证据</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据名称</span>
          <input class="input" name="title" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">来源</span>
          <input class="input" name="source" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">关联批号</span>
          <input class="input" name="batch" value={signal.batch} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">录入人</span>
          <input class="input" name="actor" value={signal.owner} />
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">核查说明</span>
          <textarea class="textarea" name="note" rows="3"></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-primary" type="submit">加入证据矩阵</button>
        </div>
        </form>
      {/if}
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">形成结论版本</h2>
      {#if readOnly}
        <p class="mt-3 rounded bg-surface-200-800 p-3 text-sm text-surface-600-300">
          原信号只读，结论版本仅作为来源记录保留并已并排接入主信号 {signal.mergedInto}。
        </p>
      {:else}
        <form
          class="mt-4 grid gap-4 md:grid-cols-2"
          method="POST"
          action="?/version"
          use:enhance={() =>
            async ({ result, update }) => {
              if (result.type === 'success') {
                const payload = result.data as { version?: CaseVersion; actor?: string };
                if (payload.version) signalStore.addVersion(signal.id, payload.version, payload.actor ?? signal.owner);
              }
              await update({ reset: true });
            }}
        >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="versionNumber" value={nextVersion} />
        <label>
          <span class="mb-1 block text-sm font-medium">版本作者</span>
          <input class="input" name="author" value={signal.owner} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">建议处置</span>
          <select class="select" name="disposition">
            <option value="continue_observation">继续观察</option>
            <option value="risk_communication">风险沟通</option>
            <option value="corrective_action">纠正措施</option>
          </select>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">结论摘要</span>
          <textarea class="textarea" name="summary" rows="2"></textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">判断依据与替代解释</span>
          <textarea class="textarea" name="rationale" rows="3"></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-secondary" type="submit">保存为 V{nextVersion}</button>
        </div>
        </form>
      {/if}
    </section>
  </div>

  <div class="mt-6 grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">结论版本</h2>
      {#if primaryHasVersion}
        <p class="mt-1 text-xs text-surface-500-400">
          主信号结论与来源信号结论并排保留：来源结论供复核人比对，不替换主信号结论。
        </p>
      {/if}
      <div class="mt-4 space-y-4">
        {#each signal.versions as version}
          <article
            class="border-l-2 pl-4 {version.originSignalId ? 'border-amber-500' : 'border-teal-600'}"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">
                V{version.version} · {version.author}
                {#if version.originSignalId}
                  <span class="badge variant-soft-warning ml-2">来源结论 · {version.originSignalId}</span>
                {:else}
                  <span class="badge variant-soft-success ml-2">主信号结论</span>
                {/if}
              </p>
              <span class="text-xs text-surface-500-400">{version.createdAt.slice(0, 10)}</span>
            </div>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-2 text-xs text-surface-500-400">{version.rationale}</p>
          </article>
        {:else}
          <p class="text-sm text-surface-500-400">尚未形成正式结论版本。</p>
        {/each}
      </div>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">审计记录</h2>
      <div class="mt-4 space-y-5">
        {#each signal.audit as entry}
          <div class="timeline-item">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium">{entry.action} · {entry.actor}</p>
              <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <p class="mt-1 text-xs text-surface-500-400">{entry.detail}</p>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}
