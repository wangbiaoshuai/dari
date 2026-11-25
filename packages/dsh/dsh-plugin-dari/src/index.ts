// Workspace-scoped ontology: domain summary, fixed knowledge cards and DARI analysis.
// Vocabulary assistance and standalone help manuals complement model facts.

export { createProjector } from '@local/dari-model';
export type { JsonValue, ProjectRule, Projector } from '@local/dari-model';
export { buildOption, CHART_WIDTH, plotHeight } from '@local/dari-model';
export { renderEchartsSvg } from '@local/dari-model';
export { renderMarkdown } from '@local/dari-model';

import { runService } from '@local/dari/service';
import { createIntegration } from '@local/dari-model';
import { createKnowledge } from '@local/dari-model';
import { installWorkMethods } from './work-methods.ts';
import { installSessionDrafts } from './session-drafts.ts';
import { installDataWindow } from './data-window.ts';
import { createTimeContext } from '@local/dari-model';
import { guidedTools } from './guided-tools.ts';
import { createTools } from './tools.ts';
import { createVaRuntime } from './va.ts';
import { installVocabularyHelper } from './va-helper.ts';
import type { LogFn, PluginContext } from '@local/dari-model';
import type { PluginConfig } from '@local/dari-model';

export const inject = ['tools', 'systemPrompt'];

export function apply(ctx: PluginContext, config: PluginConfig = {}): void {
  const log: LogFn = (message) => {
    try {
      const logger = ctx.logger;
      if (logger?.info) logger.info(message);
      else console.error(message);
    } catch {
      console.error(message);
    }
  };

  const knowledge = createKnowledge({ ctx, log, config });
  ctx.effect(() => knowledge.dispose);
  if (config.vocabularyHelper === true) {
    installVocabularyHelper({ ctx, knowledge, log, config });
    return;
  }

  installWorkMethods(ctx);
  installSessionDrafts({ ctx, knowledge, log });
  installDataWindow({ ctx, knowledge, log });

  const timeContext = createTimeContext({ ctx, log });
  timeContext.install();

  const va = createVaRuntime({ ctx, log, config });

  const definitions = createTools({ knowledge, va, timeContext, log, config, attachments:()=>ctx.get('attachments'), approval:()=>ctx.get('approval'), filePolicy:()=>ctx.get('sandboxPolicy') });
  ctx.effect(() => definitions.dispose);
  for (const definition of guidedTools(definitions, knowledge, definitions.infoContracts)) {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') ctx.effect(() => dispose);
  }

}

// Finite host capabilities consumed by the isolated DARI service.
export {dariHost} from '@local/dari-model';

export {createIntegration} from '@local/dari-model';

// 同一个 bundle 既是 DSH 插件，也是它拉起的 DARI service；由环境变量区分角色。
if (process.env.DARI_SERVICE === '1') {
  // 先清掉标记：--integration 若指向本文件，导入时不能再次进入 service 模式。
  delete process.env.DARI_SERVICE;
  const argv = process.argv.slice(2);
  const custom = argv.includes('--integration');
  await runService(argv, custom ? undefined : async (flags) => {
    const options = JSON.parse(flags.options ?? '{}') as { model?: string };
    return createIntegration({ model: options.model, database: flags.database });
  });
}
