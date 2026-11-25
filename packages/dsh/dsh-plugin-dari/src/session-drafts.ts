// 会话级草稿隔离：把每个会话的 .dari 分析稿限制在自己的目录下，避免同名文件跨题复用。
//
// 目录形式：<工作区>/drafts/<会话摘要前 8 位>/。装配系统提示时注入一次，
// 模型据此在会话内建稿；目录按需创建，失败只记录不影响本轮。
import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {Knowledge, LogFn, PluginContext} from '@local/dari-model';

/** 会话 → 相对工作区的草稿目录（稳定、不可读回原始会话 id）。 */
export function sessionDraftDir(sessionId: string): string {
  return 'drafts/' + createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

export function installSessionDrafts({ctx, knowledge, log}: {
  ctx: PluginContext;
  knowledge: Knowledge;
  log: LogFn;
}): void {
  const prepared = new WeakSet<object>();
  const dispose = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent;
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return next();
    let dir: string | undefined;
    try {
      const entry = knowledge.ensureWorkspace({agent});
      dir = sessionDraftDir(sessionId);
      if (!prepared.has(agent!.session)) {
        mkdirSync(join(entry.root, dir), {recursive: true});
        prepared.add(agent!.session);
        log(`[dari] session drafts ${entry.root}/${dir}`);
      }
    } catch (error) {
      log('[dari] session drafts unavailable: ' + String((error as Error)?.message ?? error));
    }
    const assembled = await next();
    if (dir === undefined) return assembled;
    return {
      ...assembled,
      sections: [...assembled.sections, {
        name: 'deployment:draft-directory',
        interpolate: false,
        text: '# 会话草稿目录\n\n'
          + `本次会话的 .dari 分析稿写在 \`${dir}/\` 下（例如 \`${dir}/<slug>.dari\`）。\n`
          + '- 新建稿件用该目录；不要读写其他目录或其他会话遗留的稿件。\n'
          + '- 修改已存在的稿件前先 read；与本问题无关的稿件用 write 整体替换。\n'
          + '- dari_check / dari_submit 的 src 使用同一路径写法。',
      }],
    };
  });
  ctx.effect(() => dispose);
}
