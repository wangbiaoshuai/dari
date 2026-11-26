// 探测（probe）：执行只读取数，最多 3 张表、每表字段不限，不生成答案与交付。
// 约束由编译器选项与这里的校验共同保证。
import type {Program} from './compiler.ts';

/** 探测最多返回的行数；探测只用于确认取值，不做分析。 */
export const PROBE_MAX_ROWS = 20;
/** 一次探测最多读取的表（数据集）数量。 */
export const PROBE_MAX_TABLES = 3;
const forbidden = ['connect', 'join', 'union', 'group_by', 'group_by_identity', 'distinct', 'lookup'];

export interface ProbeTarget { bindings: string[] }

/** 校验探测稿：1..3 个远程绑定，每个绑定必须带 filter、不跨表、字段数不限、take ≤ 20。
 *  answer 与 context! 等本地绑定不参与执行，不计入表数量。 */
export function probeTarget(program: Program): ProbeTarget {
  const data = [...program.bindings].filter(([name, binding]) => !binding.internal && name !== program.answer);
  const remote = data.filter(([, binding]) => (binding as any).modelPlan !== undefined);
  if (remote.length < 1 || remote.length > PROBE_MAX_TABLES) throw Error('Probe reads 1..' + PROBE_MAX_TABLES + ' datasets; found ' + remote.length);
  for (const [name, binding] of remote) {
    const ast: any = (binding as any).ast;
    const steps: any[] = Array.isArray(ast?.steps) ? ast.steps : [];
    const names = steps.map(step => step?.name);
    for (const step of forbidden) if (names.includes(step)) throw Error('Probe reads one dataset per binding; ' + step + ' is not allowed on ' + name + '; split additional datasets into separate bindings');
    const project = steps.find(step => step?.name === 'project');
    const fields = project?.args?.[0]?.fields;
    if (!Array.isArray(fields) || fields.length < 1) throw Error('Probe projects at least one field on ' + name);
    if (names.at(-2) !== 'order_by' || names.at(-1) !== 'take') throw Error('Probe binding must end with order_by(...) |> take(n) on ' + name);
    const take = steps.at(-1);
    const bound = take?.args?.[0]?.value;
    if (typeof bound !== 'number' || bound < 1 || bound > PROBE_MAX_ROWS) throw Error('Probe requires take(n) with 1 <= n <= ' + PROBE_MAX_ROWS + ' on ' + name);
    // 单行探测（take(1)）用于最新时间、计数等没有自然过滤条件的检查，可以省略 filter。
    if (!names.includes('filter') && bound !== 1) throw Error('Probe requires a filter on ' + name + ' unless it returns a single row (take(1))');
  }
  return {bindings: remote.map(([name]) => name)};
}
