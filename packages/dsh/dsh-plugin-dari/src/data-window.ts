// 数据时间范围：把数据文件实际覆盖的时间窗注入系统提示，
// 避免模型推荐或选择落在数据之外的相对时间窗（例如数据只到两天前时的“最近 24 小时”）。
import {existsSync, readFileSync, statSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {Knowledge, LogFn, PluginContext} from '@local/dari-model';

export interface Coverage { start: string; end: string; source: string; windows: Array<{name: string; start: string; end: string}> }

/** 与数据文件同目录的 manifest.json 里声明的窗口最权威。 */
function fromManifest(dataFile: string): Coverage | undefined {
  const file = join(dirname(dataFile), 'manifest.json');
  if (!existsSync(file)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const windows: Array<{name: string; start: string; end: string}> = [];
    for (const [name, value] of Object.entries(manifest?.time ?? {})) {
      const start = (value as any)?.start_utc;
      const end = (value as any)?.end_exclusive_utc ?? (value as any)?.end_utc;
      if (typeof start === 'string' && typeof end === 'string') windows.push({name, start, end});
    }
    if (windows.length === 0) return undefined;
    const starts = windows.map(window => window.start).sort();
    const ends = windows.map(window => window.end).sort();
    return {start: starts[0], end: ends[ends.length - 1], source: 'manifest', windows};
  } catch {
    return undefined;
  }
}

/** 没有 manifest 时，按常见的时钟列名在库里探测一次覆盖范围。 */
function fromDatabase(dataFile: string): Coverage | undefined {
  if (!existsSync(dataFile)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dataFile, {readOnly: true});
    const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as Array<{name: string}>;
    let start: string | undefined, end: string | undefined;
    for (const {name} of tables.slice(0, 200)) {
      let columns: Array<{name: string}>;
      try { columns = db.prepare(`pragma table_info("${name.replaceAll('"', '""')}")`).all() as Array<{name: string}>; } catch { continue; }
      const clock = columns.find(column => /^(ts|time|created?_?time|occur.*|.*_ts)$/i.test(column.name));
      if (clock === undefined) continue;
      try {
        const row = db.prepare(`select min("${clock.name}") as lo, max("${clock.name}") as hi from "${name.replaceAll('"', '""')}"`).get() as {lo?: string; hi?: string};
        if (typeof row?.lo === 'string' && (start === undefined || row.lo < start)) start = row.lo;
        if (typeof row?.hi === 'string' && (end === undefined || row.hi > end)) end = row.hi;
      } catch { /* 该表的时钟列不是可比较的文本，跳过 */ }
    }
    return start !== undefined && end !== undefined ? {start, end, source: 'database', windows: [{name: 'database', start, end}]} : undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* 忽略关闭失败 */ }
  }
}

const cache = new Map<string, {stamp: number; coverage: Coverage | undefined}>();
/** 读取一个数据文件的覆盖范围；manifest 优先，其次探测数据库列。 */
export function readCoverage(dataFile: string): Coverage | undefined {
  const stamp = (() => { try { return statSync(dataFile).mtimeMs; } catch { return 0; } })();
  const hit = cache.get(dataFile);
  if (hit !== undefined && hit.stamp === stamp) return hit.coverage;
  const coverage = fromManifest(dataFile) ?? fromDatabase(dataFile);
  cache.set(dataFile, {stamp, coverage});
  return coverage;
}

export function installDataWindow({ctx, knowledge, log}: {
  ctx: PluginContext;
  knowledge: Knowledge;
  log: LogFn;
}): void {
  const dispose = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent;
    let coverage: Coverage | undefined;
    let fileName = 'data';
    try {
      const entry = knowledge.ensureWorkspace({agent});
      const dataFile = entry.settings.dataFile;
      if (typeof dataFile === 'string' && dataFile.length > 0) {
        coverage = readCoverage(dataFile);
        fileName = basename(dataFile);
      }
    } catch (error) {
      log('[dari] data window unavailable: ' + String((error as Error)?.message ?? error));
    }
    const assembled = await next();
    if (coverage === undefined) return assembled;
    return {
      ...assembled,
      sections: [...assembled.sections, {
        name: 'deployment:data-window',
        interpolate: false,
        text: '# 数据时间范围\n\n'
          + `数据文件 \`${fileName}\` 的时间覆盖（UTC，上界不含）：\n`
          + coverage.windows.map(window => `- ${window.name}：${window.start} 至 ${window.end}`).join('\n') + '\n'
          + '- 选择“最近 N 小时/天”等相对时间窗之前，先确认它与对应数据的覆盖范围有交集；\n'
          + '- 查询结果为空时，先说明数据覆盖范围与所用时间窗，再决定是否调整口径，不要把空结果当成查询写法错误反复改稿。',
      }],
    };
  });
  ctx.effect(() => dispose);
}
