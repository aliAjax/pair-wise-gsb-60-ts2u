<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionResult } from '@sveltejs/kit';
  import { onDestroy, onMount } from 'svelte';
  import type { MergeContentType, MergeJob, SignalCase } from '$lib/models/signal';
  import {
    activeMergeJobs,
    createMergeJob,
    dismissMergeJob,
    phaseLabel,
    rebaseMergeJob,
    runMergeJob
  } from '$lib/services/merge-service';
  import { signalStore } from '$lib/stores/signal-store';

  export let signals: SignalCase[];
  export let selectedIds: string[] = [];
  export let onClose: () => void;
  export let onChanged: () => void;

  let masterId = '';
  let actor = '安全评审专员';
  let reason = '';
  let formError = '';
  let running = false;
  let failDemo = false;
  let failPhase: MergeContentType = 'tasks';
  let jobsTick = 0;

  const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const phaseAll: MergeContentType[] = ['evidence', 'tasks', 'versions', 'audit'];
  const statusText: Record<string, string> = {
    pending: '待接入',
    attaching: '接入中',
    done: '已完成',
    conflict: '冲突',
    failed: '失败'
  };

  $: mergeable = signals.filter((signal) => !signal.mergedInto);
  $: selected = mergeable.filter((signal) => selectedIds.includes(signal.id));
  $: master = mergeable.find((signal) => signal.id === masterId);
  $: sourceCandidates = selected.filter((signal) => signal.id !== masterId);
  $: jobs = computeJobs(jobsTick);

  function computeJobs(_tick: number) {
    return activeMergeJobs();
  }

  $: if (!masterId && selected.length > 0) {
    masterId = [...selected].sort(
      (a, b) => riskOrder[b.riskLevel] - riskOrder[a.riskLevel] || b.reportCount - a.reportCount
    )[0].id;
  }
  $: if (masterId && !selectedIds.includes(masterId)) masterId = '';

  onMount(() => globalThis.addEventListener('merge-jobs-changed', refreshJobs));
  onDestroy(() => globalThis.removeEventListener('merge-jobs-changed', refreshJobs));

  function refreshJobs() {
    jobsTick += 1;
  }

  function enhanceForm() {
    return async ({ result }: { result: ActionResult }) => {
      if (result.type === 'success') {
        const data = result.data as {
          merge?: { masterId: string; sourceIds: string[]; actor: string; reason: string };
        };
        if (data.merge) {
          reason = '';
          startJob(data.merge);
        }
      } else if (result.type === 'failure') {
        formError = (result.data as { message?: string })?.message ?? '合并校验失败';
      }
    };
  }

  function startJob(input: { masterId: string; sourceIds: string[]; actor: string; reason: string }) {
    running = true;
    formError = '';
    let jobId = '';
    try {
      signalStore.refresh();
      const job = createMergeJob(input);
      jobId = job.id;
    } catch (error) {
      formError = error instanceof Error ? error.message : String(error);
      running = false;
      return;
    }
    execute(jobId, false);
  }

  function execute(jobId: string, resume: boolean) {
    // 放到宏任务里，让作业状态先渲染为「进行中」
    setTimeout(() => {
      try {
        const injectSource =
          !resume && failDemo
            ? activeMergeJobs()
                .find((job) => job.id === jobId)
                ?.progress.find((p) => p.status !== 'done')?.signalId ?? ''
            : '';
        const job = runMergeJob(
          jobId,
          !resume && failDemo && injectSource
            ? { failOnce: { sourceId: injectSource, phase: failPhase } }
            : {}
        );
        if (job.status === 'completed') onChanged();
      } catch (error) {
        formError = error instanceof Error ? error.message : String(error);
      } finally {
        running = false;
        failDemo = false;
        refreshJobs();
      }
    }, 250);
  }

  function resume(job: MergeJob) {
    formError = '';
    running = true;
    execute(job.id, true);
  }

  function rebase(job: MergeJob) {
    try {
      const refreshed = rebaseMergeJob(job.id, actor || '安全评审专员');
      onChanged();
      resume(refreshed);
    } catch (error) {
      formError = error instanceof Error ? error.message : String(error);
    }
  }

  function close(job: MergeJob) {
    dismissMergeJob(job.id);
    refreshJobs();
    if (job.status === 'completed') onChanged();
  }
</script>

<div class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true">
  <div class="my-8 w-full max-w-3xl rounded-lg border border-surface-300-700 bg-surface-50-950 p-6 shadow-xl">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-xl font-semibold">合并同源安全信号</h2>
        <p class="mt-1 text-sm text-surface-600-300">
          指定主信号与来源信号。证据矩阵、调查任务、结论版本、审计记录接入主信号，批号并入覆盖；来源信号保留只读去向。
        </p>
      </div>
      <button class="btn btn-sm variant-ghost-surface" type="button" on:click={onClose}>关闭</button>
    </div>

    {#if selected.length < 2}
      <div class="mt-5 rounded border border-warning-300 bg-warning-50 p-4 text-sm text-warning-900">
        请先在台账勾选至少两个信号（其中一个作为主信号，其余作为来源）。
      </div>
    {:else}
      <form method="POST" action="?/merge" class="mt-5 space-y-4" use:enhance={enhanceForm}>
        <div>
          <span class="mb-1 block text-sm font-medium">主信号（合并后保留并承接全部内容）</span>
          <div class="grid gap-2 md:grid-cols-2">
            {#each selected as signal}
              <label
                class="flex cursor-pointer items-start gap-3 rounded border p-3 text-sm {masterId === signal.id
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-surface-300-700'}"
              >
                <input type="radio" name="masterId" value={signal.id} bind:group={masterId} class="mt-1" />
                <span>
                  <span class="font-medium">{signal.id} · {signal.title}</span>
                  <span class="mt-1 block text-xs text-surface-500-400">
                    {signal.product} / {signal.affectedBatches.join('、')} / 修订 r{signal.revision}
                  </span>
                </span>
              </label>
            {/each}
          </div>
        </div>

        <div>
          <span class="mb-1 block text-sm font-medium">来源信号（接入后只读留痕）</span>
          <ul class="space-y-1 text-sm">
            {#each sourceCandidates as source}
              <li class="flex items-center gap-2 rounded border border-surface-300-700 p-2">
                <input type="checkbox" name="sourceIds" value={source.id} checked readonly />
                <span class="font-medium">{source.id}</span>
                <span class="text-surface-600-300">{source.title}</span>
                <span class="ml-auto text-xs text-surface-500-400">
                  证据 {source.evidence.length} · 任务 {source.tasks.length} · 结论 {source.versions.length} · r{source.revision}
                </span>
              </li>
            {:else}
              <li class="text-surface-500-400">请选择一个与默认项不同的主信号。</li>
            {/each}
          </ul>
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <label>
            <span class="mb-1 block text-sm font-medium">合并负责人</span>
            <input class="input" name="actor" bind:value={actor} required minlength="2" />
          </label>
          <label class="flex items-end gap-2 text-sm">
            <input type="checkbox" bind:checked={failDemo} />
            <span>
              演示：在来源信号的
              <select class="select ml-1 inline-block w-auto py-1" bind:value={failPhase} disabled={!failDemo}>
                <option value="evidence">{phaseLabel('evidence')}</option>
                <option value="tasks">{phaseLabel('tasks')}</option>
                <option value="versions">{phaseLabel('versions')}</option>
                <option value="audit">{phaseLabel('audit')}</option>
              </select>
              阶段注入一次写入失败
            </span>
          </label>
        </div>
        <label>
          <span class="mb-1 block text-sm font-medium">合并依据</span>
          <textarea
            class="textarea"
            name="reason"
            rows="2"
            bind:value={reason}
            required
            minlength="8"
            placeholder="说明同一故障模式、批号关联或证据链重合的判断依据"
          ></textarea>
        </label>

        {#if formError}
          <p class="rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{formError}</p>
        {/if}

        <div class="flex justify-end gap-3">
          <button class="btn variant-ghost-surface" type="button" on:click={onClose}>取消</button>
          <button
            class="btn variant-filled-primary"
            type="submit"
            disabled={sourceCandidates.length === 0 || running}
          >
            {running ? '合并执行中…' : `开始合并（${sourceCandidates.length} 个来源）`}
          </button>
        </div>
      </form>
    {/if}

    {#if jobs.length > 0}
      <div class="section-rule mt-6 pt-5">
        <h3 class="font-semibold">合并作业与恢复</h3>
        <p class="mt-1 text-xs text-surface-500-400">
          作业进度持久化在本地：写入失败可续跑，重试按原始 ID 去重，不会重复接入；冲突需先刷新基线。
        </p>
        <div class="mt-3 space-y-4">
          {#each jobs as job (job.id)}
            <article class="rounded border border-surface-300-700 p-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="text-sm font-medium">{job.id} → 主信号 {job.masterId}</p>
                <span
                  class="badge {job.status === 'completed'
                    ? 'variant-soft-success'
                    : job.status === 'conflict'
                      ? 'variant-soft-error'
                      : job.status === 'failed'
                        ? 'variant-soft-error'
                        : 'variant-soft-primary'}"
                >
                  {job.status === 'running'
                    ? '进行中'
                    : job.status === 'conflict'
                      ? '并发冲突'
                      : job.status === 'failed'
                        ? '部分失败'
                        : '已完成'}
                </span>
              </div>

              {#if job.conflict}
                <div class="mt-3 rounded border border-error-300 bg-error-50 p-3 text-xs text-error-900">
                  <p class="font-medium">检出并发修改，已停止写入以防盖掉对方证据：</p>
                  <p class="mt-1">{job.conflict.detail}</p>
                  <p class="mt-2">请核对最新证据后「刷新基线并续跑」；已接入的阶段会跳过，不重复接入。</p>
                </div>
              {/if}

              <ul class="mt-3 space-y-2">
                {#each job.progress as progress}
                  <li class="text-sm">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-medium">{progress.signalId}</span>
                      <span class="text-xs text-surface-500-400">{progress.title}</span>
                      <span
                        class="badge {progress.status === 'done'
                          ? 'variant-soft-success'
                          : progress.status === 'conflict' || progress.status === 'failed'
                            ? 'variant-soft-error'
                            : 'variant-soft-primary'}"
                      >
                        {statusText[progress.status]}
                      </span>
                    </div>
                    <div class="mt-1 flex flex-wrap gap-1">
                      {#each phaseAll as phase}
                        <span
                          class="rounded px-2 py-0.5 text-xs {progress.attached.includes(phase)
                            ? 'bg-success-100 text-success-900'
                            : progress.status === 'failed'
                              ? 'bg-error-100 text-error-900'
                              : 'bg-surface-200 text-surface-700'}"
                        >
                          {phaseLabel(phase)}
                        </span>
                      {/each}
                    </div>
                    {#if progress.error}
                      <p class="mt-1 text-xs text-error-700">{progress.error}</p>
                    {/if}
                  </li>
                {/each}
              </ul>

              <div class="mt-3 flex flex-wrap justify-end gap-2">
                {#if job.status === 'failed'}
                  <button class="btn btn-sm variant-filled-primary" type="button" disabled={running} on:click={() => resume(job)}>
                    从失败阶段续跑
                  </button>
                {/if}
                {#if job.status === 'conflict'}
                  <button class="btn btn-sm variant-filled-secondary" type="button" disabled={running} on:click={() => rebase(job)}>
                    刷新基线并续跑
                  </button>
                {/if}
                <button class="btn btn-sm variant-ghost-surface" type="button" on:click={() => close(job)}>
                  {job.status === 'completed' ? '关闭并刷新台账' : '放弃该作业'}
                </button>
              </div>
            </article>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
