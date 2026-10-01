import { fail } from '@sveltejs/kit';
import { mergeSchema } from '$lib/models/signal';

// 合并表单的服务端校验入口。逐项写入在浏览器端由 merge-service 执行，
// 这样写入失败时才能依据 localStorage 中的 journal 断点恢复。
export const actions = {
  merge: async ({ request }) => {
    const formData = await request.formData();
    const primaryId = String(formData.get('primaryId') ?? '');
    const sourceIds = formData.getAll('sourceIds').map(String);
    const actor = String(formData.get('actor') ?? '');
    const reason = String(formData.get('reason') ?? '');

    let baseRevisions: Record<string, number> = {};
    try {
      baseRevisions = JSON.parse(String(formData.get('baseRevisions') ?? '{}')) as Record<string, number>;
    } catch {
      return fail(400, { message: '合并基线版本数据损坏，请刷新页面后重试。' });
    }

    const parsed = mergeSchema.safeParse({ primaryId, sourceIds, actor, reason, baseRevisions });
    if (!parsed.success) {
      return fail(400, { message: parsed.error.issues[0]?.message ?? '合并表单校验失败' });
    }

    return { success: true, merge: parsed.data };
  }
};
