import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { initializeGroup } from '../src/config.ts';
import { getProcessStatus, startGroup } from '../src/process-manager.ts';
import { registerTerminal } from '../src/terminal-monitor.ts';
import type { TerminalLaunch } from '../src/web-terminal.ts';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'process-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await initializeGroup(root, 'one', { name: 'Test group', conversations: [{ type: 'group', id: 'GroupOpenID' }] });
  const entry = join(root, 'fake-pi.cjs'); await writeFile(entry, '');
  return { root, cwd, env: { PIQ_PI_ENTRY: entry, QQBOT_APP_ID: '123', QQBOT_APP_SECRET: 'test-secret' } };
}
test('starting a group opens one terminal with credentials confined to the environment', async t => {
  const f = await fixture(t); const launches: TerminalLaunch[] = [];
  await startGroup(f.cwd, { env: f.env, launch: async spec => { launches.push(spec); } });
  assert.equal(launches.length, 1);
  const request = launches[0]!;
  assert.equal(request.command, 'wt.exe'); assert.equal(request.cwd, f.cwd);
  assert.equal(request.env.QQBOT_APP_SECRET, 'test-secret'); assert.equal(request.env.PIQ_RUN_MODE, 'terminal');
  assert.doesNotMatch(JSON.stringify(request.args), /test-secret/);
  const lease = JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8'));
  assert.equal(lease.kind, 'terminal-only'); assert.equal(lease.state, 'starting');
  assert.equal((await getProcessStatus(f.cwd)).starting, true);
});
test('concurrent and repeated terminal starts cannot create another group session', async t => {
  const f = await fixture(t); let launches = 0;
  const options = { env: f.env, launch: async () => { launches++; } };
  const results = await Promise.all([startGroup(f.cwd, options), startGroup(f.cwd, options)]);
  assert.equal(launches, 1); assert.equal(results.filter(r => r.alreadyRunning).length, 1);
  const lease = JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8'));
  await registerTerminal(f.cwd, lease.token, process.pid, process.pid);
  const state = await getProcessStatus(f.cwd);
  assert.equal(state.mode, 'terminal'); assert.equal(state.running, true);
  assert.equal((await startGroup(f.cwd, options)).alreadyRunning, true);
});
test('failed launches release the startup lease and may be retried', async t => {
  const f = await fixture(t);
  await assert.rejects(startGroup(f.cwd, { env: f.env, launch: async () => { throw new Error('test unavailable'); } }), /unavailable/);
  assert.deepEqual(await getProcessStatus(f.cwd), { running: false, pid: null, mode: null, starting: false });
  for (const file of ['start.lock', 'terminal-return.lock', 'terminal-return.json']) {
    await assert.rejects(readFile(join(f.cwd, '.piq', file)), { code: 'ENOENT' });
  }
  let launched = false;
  await startGroup(f.cwd, { env: f.env, launch: async () => { launched = true; } });
  assert.equal(launched, true);
});
