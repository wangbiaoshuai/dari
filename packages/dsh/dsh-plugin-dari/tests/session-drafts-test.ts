// 会话草稿隔离：目录按会话稳定派生、装配时注入、且目录被创建。
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installSessionDrafts, sessionDraftDir} from '../src/session-drafts.ts';

const root = mkdtempSync(join(tmpdir(), 'dari-session-drafts-'));
const knowledge = {ensureWorkspace: () => ({root, modelHash: 'h', settings: {workspaceRoot: root}})} as any;
const hooks: Array<(...args: any[]) => any> = [];
const ctx = {on: (_name: string, fn: any) => { hooks.push(fn); return () => {}; }, effect: () => {}} as any;

try {
  installSessionDrafts({ctx, knowledge, log() {}});
  assert.equal(hooks.length, 1, 'must register one assemble hook');

  const sessionId = 'session-0123456789abcdef';
  const dir = sessionDraftDir(sessionId);
  assert.match(dir, /^drafts\/[0-9a-f]{8}$/, 'directory must be drafts/<8 hex>');
  assert.equal(dir, sessionDraftDir(sessionId), 'derivation must be stable');
  assert.notEqual(dir, sessionDraftDir('session-other'), 'different sessions must differ');

  const assembled = await hooks[0]({}, {agent: {session: {id: sessionId}}}, async () => ({sections: [{name: 'harness:base', text: 'base'}]}));
  const section = assembled.sections.find((s: any) => s.name === 'deployment:draft-directory');
  assert(section, 'must append the draft directory section');
  assert(section.text.includes(dir), 'section must name the session directory');
  assert(section.text.includes('read'), 'section must state the read-before-modify rule');
  assert.equal(assembled.sections[0].name, 'harness:base', 'existing sections must be preserved');
  assert(existsSync(join(root, dir)), 'session directory must be created');

  console.log('session drafts: stable directory, section injected, directory created');
} finally {
  rmSync(root, {recursive: true, force: true});
}
