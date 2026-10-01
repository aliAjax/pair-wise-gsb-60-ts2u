// 合并语义的无头验证：幂等恢复、并发冲突、结论并排、批号覆盖
// 运行：node scripts/run-merge-test.mjs（先 esbuild 打包）
const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: () => null,
  length: 0
};
(globalThis as Record<string, unknown>).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined
};

const { createMergeJob, dismissMergeJob, rebaseMergeJob, runMergeJob } = await import(
  '../src/lib/services/merge-service'
);
const { signalStore } = await import('../src/lib/stores/signal-store');

function resetState() {
  storage.clear(); // 同时清掉合并作业存储
  signalStore.reset();
}

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// ---- 场景 1：正常合并 ----
console.log('场景 1：正常合并（证据/任务/结论/审计接入 + 批号覆盖）');
{
  resetState();
  const snap = signalStore.getSnapshot();
  const master018 = snap.find((s) => s.id === 'SIG-2026-018')!;
  const source015 = snap.find((s) => s.id === 'SIG-2026-015')!;

  const job = createMergeJob({
    masterId: 'SIG-2026-018',
    sourceIds: ['SIG-2026-015'],
    actor: '周宁',
    reason: '同一区域维修与投诉报告反映同批次管路相关故障模式，证据链重合。'
  });
  const result = runMergeJob(job.id);
  check('作业完成', result.status === 'completed', result.status);
  dismissMergeJob(job.id);

  const after = signalStore.getSnapshot();
  const master = after.find((s) => s.id === 'SIG-2026-018')!;
  const source = after.find((s) => s.id === 'SIG-2026-015')!;

  check('证据接入（3+2=5）', master.evidence.length === 5, `实际 ${master.evidence.length}`);
  check('任务接入（2+1=3）', master.tasks.length === 3, `实际 ${master.tasks.length}`);
  check('来源审计接入主信号', master.audit.some((a) => a.originSignalId === 'SIG-2026-015'));
  check('批号并集覆盖', master.affectedBatches.includes('M12-251118'));
  check('报告数聚合', master.reportCount === 17 + 9, `实际 ${master.reportCount}`);
  check('来源写入只读去向', source.mergedInto?.masterSignalId === 'SIG-2026-018');
  check('主信号登记来源清单', master.mergedSources.some((m) => m.signalId === 'SIG-2026-015'));
  check('接入证据带 originId', master.evidence.some((e) => e.originId === 'E-015-01'));

  // 结论并排：主信号有 V1，来源结论必须进待复核区而不是替换
  check('主结论未被替换（仍只有 1 版）', master.versions.length === 1, `实际 ${master.versions.length}`);
  check('来源结论进入并排待复核区', master.incomingVersions.length === 1);
  check('待复核结论为 pending', master.incomingVersions[0].reviewStatus === 'pending');

  // 采纳来源结论 → 生成主信号新版本
  signalStore.reviewIncomingVersion(
    'SIG-2026-018',
    master.incomingVersions[0].id,
    'adopt',
    '复核员甲',
    '分层分析结论与现场数据一致，可以采纳。'
  );
  const reviewed = signalStore.getSnapshot().find((s) => s.id === 'SIG-2026-018')!;
  check('采纳后生成 V2', reviewed.versions.length === 2 && reviewed.versions[0].version === 2);
  check('V2 记录采纳来源', reviewed.versions[0].originSignalId === 'SIG-2026-015');
  check('待复核项标记 adopted', reviewed.incomingVersions[0].reviewStatus === 'adopted');

  void master018;
  void source015;
}

// ---- 场景 2：写入失败后续跑，重试不重复接入 ----
console.log('场景 2：任务阶段注入失败 → 续跑后不重复接入');
{
  resetState();
  const job = createMergeJob({
    masterId: 'SIG-2026-019',
    sourceIds: ['SIG-2026-011'],
    actor: '顾岚',
    reason: '软件缺陷工单与现场报告归并到同一处置信号。'
  });
  const failed = runMergeJob(job.id, { failOnce: { sourceId: 'SIG-2026-011', phase: 'tasks' } });
  check('作业状态 failed', failed.status === 'failed', failed.status);
  const failedProgress = failed.progress[0];
  check('已完成 evidence 阶段', failedProgress.attached.includes('evidence'));
  check('未到 versions 阶段', !failedProgress.attached.includes('versions'));

  const mid = signalStore.getSnapshot().find((s) => s.id === 'SIG-2026-019')!;
  const evidenceAfterEvidence = mid.evidence.length;
  check('证据已即时可见', evidenceAfterEvidence === 2 + 1, `实际 ${evidenceAfterEvidence}`);
  check('来源尚未封口', !mid.mergedSources.some((m) => m.signalId === 'SIG-2026-011'));

  // 续跑
  const resumed = runMergeJob(job.id);
  check('续跑后完成', resumed.status === 'completed', resumed.status);
  const final = signalStore.getSnapshot().find((s) => s.id === 'SIG-2026-019')!;
  check('证据未重复接入（仍为 3）', final.evidence.length === 3, `实际 ${final.evidence.length}`);
  check('任务接入（2+1=3）', final.tasks.length === 3, `实际 ${final.tasks.length}`);
  check('来源结论待复核', final.incomingVersions.length === 1);
  check('来源已封口', final.mergedSources.some((m) => m.signalId === 'SIG-2026-011'));
  dismissMergeJob(job.id);
}

// ---- 场景 3：并发冲突（主信号被他页先写） ----
console.log('场景 3：另一页签先给主信号补证据，后来方先看到冲突且不覆盖');
{
  resetState();
  const job = createMergeJob({
    masterId: 'SIG-2026-019',
    sourceIds: ['SIG-2026-018'],
    actor: '顾岚',
    reason: '冲突场景验证。'
  }).id;
  // 在作业建立后、执行前，另一页签给主信号补证据
  signalStore.addEvidence(
    'SIG-2026-019',
    {
      id: 'E-CONCURRENT',
      type: 'test',
      title: '另一页签刚补的热成像复测',
      source: '加急实验室',
      strength: 'strong',
      batch: 'D9-260722',
      note: '在合并作业挂起期间录入。',
      createdAt: new Date().toISOString()
    },
    '沈瑜'
  );
  const conflicted = runMergeJob(job);
  check('检出冲突 status=conflict', conflicted.status === 'conflict', conflicted.status);
  check('冲突原因包含主信号修订变化', conflicted.conflict?.masterChanged === true);

  const master = signalStore.getSnapshot().find((s) => s.id === 'SIG-2026-019')!;
  check('对方刚补的证据保留', master.evidence.some((e) => e.id === 'E-CONCURRENT'));
  check('冲突时未接入任何来源内容', !master.mergedSources.some((m) => m.signalId === 'SIG-2026-018'));

  // 刷新基线后续跑：接受他页写入，合并正常完成
  const rebased = rebaseMergeJob(job, '顾岚');
  check('刷新基线后回到 running', rebased.status === 'running');
  const rerun = runMergeJob(job);
  check('续跑完成', rerun.status === 'completed', rerun.status);
  const completed = signalStore.getSnapshot().find((s) => s.id === 'SIG-2026-019')!;
  check('他页证据与来源证据并存', completed.evidence.some((e) => e.id === 'E-CONCURRENT'));
  dismissMergeJob(job);
}

// ---- 场景 4：来源被他页补证据导致冲突，且刷新基线续跑可完成 ----
console.log('场景 4：来源信号在合并挂起期间被他页补证据 → 冲突 → 刷新基线续跑');
{
  resetState();
  // 用 019 作来源、018 作主信号：先确认 019 未封口
  const fresh = signalStore.getSnapshot();
  const s019 = fresh.find((s) => s.id === 'SIG-2026-019')!;
  check('前置：019 尚未封口', !s019.mergedInto, s019.mergedInto?.masterSignalId ?? '');

  const jobId = createMergeJob({
    masterId: 'SIG-2026-018',
    sourceIds: ['SIG-2026-019'],
    actor: '周宁',
    reason: '除颤器温升与管路报警判定为同源现场异常，归并复核。'
  }).id;

  // 另一页签给来源 019 补了一条证据
  signalStore.addEvidence(
    'SIG-2026-019',
    {
      id: 'E-SOURCE-LATE',
      type: 'field_report',
      title: '挂起期间现场补发的第二台拆机记录',
      source: '现场服务 F-802',
      strength: 'strong',
      batch: 'D9-260722',
      note: '合并作业建立后录入。',
      createdAt: new Date().toISOString()
    },
    '顾岚'
  );

  const conflicted = runMergeJob(jobId);
  check('检出冲突', conflicted.status === 'conflict', conflicted.status);
  check('冲突定位到来源', (conflicted.conflict?.changedSourceIds ?? []).includes('SIG-2026-019'));
  check('主信号未被写入', conflicted.progress[0].attached.length === 0);
  check('来源未封口（对方证据仍在原信号）',
    signalStore.getSnapshot().find((s) => s.id === 'SIG-2026-019')!.evidence.some((e) => e.id === 'E-SOURCE-LATE'));

  rebaseMergeJob(jobId, '周宁');
  const rerun = runMergeJob(jobId);
  check('刷新基线续跑完成', rerun.status === 'completed', rerun.status);
  const master = signalStore.getSnapshot().find((s) => s.id === 'SIG-2026-018')!;
  check('对方后补证据最终也接入主信号', master.evidence.some((e) => e.originId === 'E-SOURCE-LATE'));
  dismissMergeJob(jobId);
}

// ---- 场景 5：已并入的只读信号不能重复并入 ----
console.log('场景 5：已并入的只读信号不能重复并入');
{
  resetState();
  // 先完成一次 018 <- 015 的合并
  const first = createMergeJob({
    masterId: 'SIG-2026-018',
    sourceIds: ['SIG-2026-015'],
    actor: '周宁',
    reason: '初始合并，用于验证封口信号不能再次并入。'
  });
  runMergeJob(first.id);

  let rejected = false;
  try {
    createMergeJob({
      masterId: 'SIG-2026-019',
      sourceIds: ['SIG-2026-015'],
      actor: '顾岚',
      reason: '尝试重复并入已封口信号。'
    });
  } catch {
    rejected = true;
  }
  check('拒绝重复并入', rejected);
  dismissMergeJob(first.id);
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
