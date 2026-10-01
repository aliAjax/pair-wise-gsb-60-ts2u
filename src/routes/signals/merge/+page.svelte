<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { page } from '$app/stores';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type { MergeJournal, SignalCase } from '$lib/models/signal';
  import { listSignals } from '$lib/services/signal-service';
  import {
    isReadOnly,
    planMerge,
    precheckMerge,
    recoverMerge,
    runMerge
  } from '$lib/services/merge-service';
  import { mergeJournalStore } from '$lib/stores/merge-journal-store';
  import type { ActionData } from './$types';

  export let form: ActionData;

  const queryClient = useQueryClient();

  const query = createQuery({ queryKey: ['signals', 'merge'], queryFn: () => listSignals({}) });
  function querySignals(): SignalCase[] {
    return ($query.data ?? []) as SignalCase[];
  }
  $: signals = querySignals();

  const paramPrimary = $page.url.searchParams.get('primary') ?? '';
  const paramSources = $page.url.searchParams.getAll('source');

  let primaryId = paramPrimary;
  let sourceIds: string[] = paramSources;
  let actor = '周宁';
  let reason = '';
  let failAtItem = 0;
  // SSR 首次渲染时 query 数据未就绪；数据到达后如未选择或所选已只读，则补一次默认值
  let initialized = false;
  $: if (!initialized && signals.length > 0) {
    initialized = true;
    const selectable = signals.filter((signal) => !isReadOnly(signal));
    if (!selectable.some((signal) => signal.id === primaryId)) {
      primaryId = selectable[0]?.id ?? '';
    }
    sourceIds = sourceIds.filter((id) => id !== primaryId && selectable.some((signal) => signal.id === id));
  }

  // 最近一次执行的 journal 及其结果提示
  let activeJournalId: string | null = null;
  function findActiveJournal(): MergeJournal | null {
    return $mergeJournalStore.find((journal) => journal.id === activeJournalId) ?? null;
  }
  $: activeJournal = findActiveJournal();
  $: pendingJournals = $mergeJournalStore.filter((journal) => journal.status !== 'completed');
  $: recentJournals = $mergeJournalStore.slice(0, 5);

  $: selectedPrimary = signals.find((signal) => signal.id === primaryId) ?? null;
  $: selectedSources = sourceIds
    .map((id) => signals.find((signal) => signal.id === id))
    .filter((signal): signal is SignalCase => Boolean(signal));

  // 保存基线：表单提交时携带的 revision 快照，服务端校验后由浏览器逐项写入
  $: baseRevisions = Object.fromEntries(
    [primaryId, ...sourceIds].filter(Boolean).map((id) => [id, signals.find((s) => s.id === id)?.revision ?? 0])
  );

  $: precheck =
    primaryId && sourceIds.length > 0
      ? precheckMerge({ primaryId, sourceIds, baseRevisions })
      : { ok: false as const, message: '请选择一个主信号和至少一个来源信号。' };

  const sourceLabels: Record<SignalCase['sourceType'], string> = {
    complaint: '投诉',
    repair: '维修',
    adverse_event: '不良事件',
    field_report: '现场报告'
  };

  function toggleSource(id: string) {
    if (id === primaryId) return;
    sourceIds = sourceIds.includes(id) ? sourceIds.filter((item) => item !== id) : [...sourceIds, id];
  }

  function choosePrimary(id: string) {
    primaryId = id;
    sourceIds = sourceIds.filter((item) => item !== id);
  }

  async function refreshSignals() {
    await queryClient.invalidateQueries({ queryKey: ['signals'] });
  }

  function selectJournal(id: string) {
    activeJournalId = id;
  }

  async function execute(journalId: string, resume = false) {
    activeJournalId = journalId;
    const options = !resume && failAtItem > 0 ? { failAtItem } : {};
    const result = resume
      ? await recoverMerge(journalId, options)
      : await runMerge(journalId, options);
    await refreshSignals();
    if (result.status === 'completed') {
      failAtItem = 0;
    }
  }

  const handleMerge: SubmitFunction = () =>
    async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === 'success') {
        const data = result.data as {
          merge?: { primaryId: string; sourceIds: string[]; actor: string; reason: string };
        };
        if (!data.merge) return;
        const plan = planMerge(data.merge);
        if (!plan.ok || !plan.journal) {
          return;
        }
        reason = '';
        await execute(plan.journal.id);
      }
    };

  const journalStatusLabel: Record<MergeJournal['status'], string> = {
    prepared: '待执行',
    running: '写入中',
    completed: '已完成',
    failed: '部分失败可恢复',
    conflict: '存在冲突'
  };

  const itemKindLabel: Record<MergeJournal['items'][number]['kind'], string> = {
    primary_evidence: '接入证据',
    primary_task: '接入任务',
    primary_version: '并排保留结论',
    primary_batch: '并入批号覆盖',
    primary_audit: '接入审计',
    source_redirect: '原信号转只读去向',
    primary_finalize: '汇总报告数与发生率'
  };
</script>

<svelte:head><title>信号合并 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-5 flex flex-wrap items-end justify-between gap-3">
  <div>
    <div class="flex flex-wrap items-center gap-3">
      <a class="text-sm text-primary-700-300 hover:underline" href="/signals">返回信号台账</a>
      <span class="text-surface-400">/</span>
      <span class="text-sm text-surface-500-400">信号合并工作台</span>
    </div>
    <h1 class="mt-2 text-2xl font-semibold">合并同一故障的重复安全信号</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      负责人指定主信号与来源信号；证据矩阵、调查任务、结论版本、审计记录并入主信号，批号并入覆盖，原信号保留只读去向。
    </p>
  </div>
</div>

{#if form?.message}
  <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{form.message}</div>
{/if}

{#if pendingJournals.length > 0 && !activeJournal}
  <section class="mb-6 rounded border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
    <h2 class="font-semibold text-amber-900 dark:text-amber-200">存在未完成的合并写入</h2>
    <p class="mt-1 text-sm text-amber-800 dark:text-amber-300">
      有合并在写入中断或遇到冲突，已接入的内容不会重复；可从断点恢复续做。
    </p>
    <div class="mt-3 space-y-2">
      {#each pendingJournals as journal}
        <div class="flex flex-wrap items-center justify-between gap-3 rounded border border-amber-300 bg-surface-50-950 p-3">
          <div class="text-sm">
            <p class="font-medium">
              {journal.primaryId} ← {journal.sourceIds.join('、')}
            </p>
            <p class="mt-1 text-xs text-surface-500-400">
              {journalStatusLabel[journal.status]} · 负责人 {journal.actor} · {journal.createdAt.slice(0, 16).replace('T', ' ')}
              {#if journal.conflictDetail}· {journal.conflictDetail}{/if}
            </p>
          </div>
          <button class="btn variant-filled-primary btn-sm" type="button" on:click={() => execute(journal.id, true)}>
            {journal.status === 'conflict' ? '按最新数据复核并继续' : '恢复未完成项'}
          </button>
        </div>
      {/each}
    </div>
  </section>
{/if}

{#if activeJournal}
  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="font-semibold">
          合并进度：{activeJournal.primaryId} ← {activeJournal.sourceIds.join('、')}
        </h2>
        <p class="mt-1 text-xs text-surface-500-400">
          状态：{journalStatusLabel[activeJournal.status]}
          · 已完成 {activeJournal.items.filter((item) => item.status === 'done').length}/{activeJournal.items.length} 项
        </p>
      </div>
      <div class="flex gap-2">
        {#if activeJournal.status === 'failed'}
          <button class="btn variant-filled-primary btn-sm" type="button" on:click={() => execute(activeJournal.id, true)}>
            恢复未完成项（重试不重复接入）
          </button>
        {:else if activeJournal.status === 'conflict'}
          <button class="btn variant-filled-primary btn-sm" type="button" on:click={() => execute(activeJournal.id, true)}>
            我已复核对方补充，按最新版本继续
          </button>
        {:else if activeJournal.status === 'completed'}
          <a class="btn variant-soft-primary btn-sm" href={`/signals/${activeJournal.primaryId}`}>查看主信号</a>
        {/if}
        <button class="btn variant-ghost-surface btn-sm" type="button" on:click={() => (activeJournalId = null)}>收起</button>
      </div>
    </div>

    {#if activeJournal.conflictDetail}
      <div class="mt-3 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">
        <p class="font-medium">并发冲突已阻止覆盖</p>
        <p class="mt-1">{activeJournal.conflictDetail}</p>
        <p class="mt-2 text-xs">请先打开该信号核对另一个页签刚补的证据或结论，确认后再按最新版本继续；未接入的条目会保留，已接入的不重复。</p>
      </div>
    {/if}

    <ol class="mt-4 space-y-2">
      {#each activeJournal.items as item}
        <li class="flex flex-wrap items-center justify-between gap-2 rounded border border-surface-300-700 px-3 py-2 text-sm">
          <span>
            <span class="font-medium">{itemKindLabel[item.kind]}</span>
            <span class="ml-2 text-xs text-surface-500-400">{item.signalId}</span>
          </span>
          {#if item.status === 'done'}
            <span class="badge variant-soft-success">已接入</span>
          {:else if item.status === 'conflict'}
            <span class="badge variant-soft-error" title={item.error}>冲突待复核</span>
          {:else}
            <span class="badge" title={item.error}>待写入{item.error ? ` · ${item.error}` : ''}</span>
          {/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}

<form method="POST" action="?/merge" use:enhance={handleMerge}>
  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900">
    <div class="border-b border-surface-300-700 px-4 py-3">
      <h2 class="font-semibold">第一步：选择主信号与来源信号</h2>
      <p class="mt-1 text-xs text-surface-500-400">
        单选主信号（核查主线与结论保留在它身上），勾选一个或多个来源信号；已合并的只读信号不在候选内。
      </p>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[900px]">
        <thead>
          <tr>
            <th class="w-20">主信号</th>
            <th class="w-20">来源</th>
            <th>信号</th>
            <th>产品 / 批号覆盖</th>
            <th>证据 / 任务 / 结论</th>
            <th>版本</th>
            <th>风险状态</th>
          </tr>
        </thead>
        <tbody>
          {#each signals as signal (signal.id)}
            <tr class:opacity-50={isReadOnly(signal)}>
              <td>
                <label class="sr-only" for={`primary-${signal.id}`}>主信号</label>
                <input
                  id={`primary-${signal.id}`}
                  type="radio"
                  name="primaryRadio"
                  disabled={isReadOnly(signal)}
                  checked={primaryId === signal.id}
                  on:change={() => choosePrimary(signal.id)}
                />
              </td>
              <td>
                <label class="sr-only" for={`source-${signal.id}`}>来源</label>
                <input
                  id={`source-${signal.id}`}
                  type="checkbox"
                  disabled={isReadOnly(signal) || primaryId === signal.id}
                  checked={sourceIds.includes(signal.id)}
                  on:change={() => toggleSource(signal.id)}
                />
              </td>
              <td>
                <a class="font-semibold text-primary-700-300 hover:underline" href={`/signals/${signal.id}`}>
                  {signal.id}
                </a>
                <p class="mt-1 max-w-[320px] text-sm text-surface-600-300">{signal.title}</p>
                <p class="mt-1 text-xs text-surface-500-400">{sourceLabels[signal.sourceType]}来源</p>
                {#if isReadOnly(signal)}
                  <p class="mt-1 text-xs font-medium text-teal-700">已并入 {signal.mergedInto}（只读）</p>
                {/if}
              </td>
              <td>
                <p class="font-medium">{signal.product}</p>
                <p class="text-sm text-surface-500-400">{signal.affectedBatches.join('、')}</p>
              </td>
              <td class="text-sm">
                {signal.evidence.length} 项证据 · {signal.tasks.length} 个任务 · {signal.versions.length} 版结论
              </td>
              <td class="metric-value text-sm">V{signal.revision ?? 0}</td>
              <td><RiskBadge risk={signal.riskLevel} status={signal.status} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
    <div class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">第二步：填写合并依据</h2>
      <div class="mt-4 grid gap-4 md:grid-cols-2">
        <label class="block">
          <span class="mb-1 block text-sm font-medium">负责人</span>
          <input class="input" name="actor" bind:value={actor} required minlength="2" />
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">故障演练：在第几项模拟写入失败（0=关闭）</span>
          <input class="input" type="number" min="0" bind:value={failAtItem} />
        </label>
        <label class="block md:col-span-2">
          <span class="mb-1 block text-sm font-medium">合并依据（同一故障的判定理由）</span>
          <textarea
            class="textarea"
            name="reason"
            rows="3"
            bind:value={reason}
            required
            minlength="6"
            placeholder="例如：故障模式、涉及部件与批号窗口一致，投诉/维修/现场记录互为印证"
          ></textarea>
        </label>
      </div>

      <!-- 实际提交字段 -->
      <input type="hidden" name="primaryId" value={primaryId} />
      {#each sourceIds as sourceId}
        <input type="hidden" name="sourceIds" value={sourceId} />
      {/each}
      <input type="hidden" name="baseRevisions" value={JSON.stringify(baseRevisions)} />

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button class="btn variant-filled-primary" type="submit" disabled={!precheck.ok}>
          预检并执行合并
        </button>
        {#if !precheck.ok}
          <span class="text-xs text-surface-500-400">{precheck.message}</span>
        {:else}
          <span class="text-xs text-teal-700">预检通过：所选信号自打开页签以来未被其他页签更新。</span>
        {/if}
      </div>
    </div>

    <aside class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">合并后将发生什么</h2>
      {#if selectedPrimary}
        <div class="mt-3 space-y-3 text-sm">
          <p>
            主信号 <span class="font-medium">{selectedPrimary.id}</span>（{sourceLabels[selectedPrimary.sourceType]}）
            将接收来源信号的全部证据、未结任务、审计记录。
          </p>
          <ul class="list-disc space-y-1 pl-5 text-surface-600-300">
            <li>批号覆盖并入：{Array.from(new Set([...selectedPrimary.affectedBatches, ...selectedSources.flatMap((s) => s.affectedBatches)])).join('、')}</li>
            <li>来源结论版本并排保留并标注来源，不替换主信号现有 V{selectedPrimary.versions.length} 结论，留复核人比对</li>
            <li>报告数汇总为 {selectedPrimary.reportCount + selectedSources.reduce((n, s) => n + s.reportCount, 0)} 条，并重算核查发生率</li>
            <li>来源信号转为「已并入主信号」只读去向，证据不可再改</li>
          </ul>
        </div>
      {:else}
        <p class="mt-3 text-sm text-surface-500-400">请选择主信号。</p>
      {/if}
    </aside>
  </section>
</form>

{#if recentJournals.length > 0}
  <section class="rounded border border-surface-300-700 bg-surface-100-900">
    <div class="border-b border-surface-300-700 px-4 py-3">
      <h2 class="font-semibold">合并写入记录</h2>
      <p class="mt-1 text-xs text-surface-500-400">每份合并按条目持久化，可审计、可恢复、重试幂等。</p>
    </div>
    <div class="divide-y divide-surface-300-700">
      {#each recentJournals as journal}
        <button
          type="button"
          class="block w-full px-4 py-3 text-left hover:bg-surface-200-800"
          on:click={() => selectJournal(journal.id)}
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium">
              {`${journal.primaryId} ← ${journal.sourceIds.join('、')}`}
            </p>
            <span class="badge">{journalStatusLabel[journal.status]}</span>
          </div>
          <p class="mt-1 text-xs text-surface-500-400">
            {journal.actor} · {journal.createdAt.slice(0, 16).replace('T', ' ')}
            · {journal.items.filter((item) => item.status === 'done').length}/{journal.items.length} 项完成
          </p>
        </button>
      {/each}
    </div>
  </section>
{/if}
