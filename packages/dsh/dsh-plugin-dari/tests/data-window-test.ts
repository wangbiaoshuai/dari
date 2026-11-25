// 数据时间范围：manifest 优先、数据库列回退、装配时注入提示段。
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {installDataWindow, readCoverage} from '../src/data-window.ts';

const root = mkdtempSync(join(tmpdir(), 'dari-data-window-'));
const dataFile = join(root, 'ops.sqlite');

try {
  // 1) manifest 优先
  writeFileSync(dataFile, '');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    time: {kpi_window: {start_utc: '2026-10-22T03:50:00Z', end_exclusive_utc: '2026-11-23T03:50:00Z'}},
  }));
  const fromManifest = readCoverage(dataFile);
  assert.equal(fromManifest?.source, 'manifest');
  assert.equal(fromManifest?.start, '2026-10-22T03:50:00Z');
  assert.equal(fromManifest?.end, '2026-11-23T03:50:00Z');

  // 2) 无 manifest 时按时钟列探测
  rmSync(join(root, 'manifest.json'));
  const db = new DatabaseSync(dataFile);
  db.exec('create table t (ts text)');
  db.exec("insert into t values ('2026-01-01T00:00:00Z'), ('2026-01-03T00:00:00Z')");
  db.close();
  const fromDatabase = readCoverage(dataFile);
  assert.equal(fromDatabase?.source, 'database');
  assert.equal(fromDatabase?.start, '2026-01-01T00:00:00Z');
  assert.equal(fromDatabase?.end, '2026-01-03T00:00:00Z');

  // 3) 装配时注入
  const knowledge = {ensureWorkspace: () => ({root, modelHash: 'h', settings: {workspaceRoot: root, dataFile}})} as any;
  const hooks: Array<(...args: any[]) => any> = [];
  const ctx = {on: (_name: string, fn: any) => { hooks.push(fn); return () => {}; }, effect: () => {}} as any;
  installDataWindow({ctx, knowledge, log() {}});
  assert.equal(hooks.length, 1);
  const assembled = await hooks[0]({}, {agent: {session: {id: 'session-x'}}}, async () => ({sections: [{name: 'base', text: 'b'}]}));
  const section = assembled.sections.find((s: any) => s.name === 'deployment:data-window');
  assert(section, 'must append data window section');
  assert(section.text.includes('2026-01-01T00:00:00Z'), 'section must carry coverage');
  assert(section.text.includes('数据时间范围'), 'section must be titled');

  console.log('data window: manifest, database fallback and prompt injection passed');
} finally {
  rmSync(root, {recursive: true, force: true});
}
