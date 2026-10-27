import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeGroup } from '../src/config.ts';
import { getProcessStatus, handoffToTerminal, startGroup } from '../src/process-manager.ts';
import { registerTerminal } from '../src/terminal-monitor.ts';
import type { TerminalLaunch } from '../src/web-terminal.ts';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'process-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await initializeGroup(root, '10001', { name: 'Test group', conversations: [{ type: 'group', id: '10001' }] });
  await mkdir(join(cwd, '.piq'), { recursive: true });
  const fakeEntry = join(root, 'fake-pi.cjs'); await writeFile(fakeEntry, '');
  const env = { PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'private-test-token' };
  const ownerFile = join(cwd, '.piq', 'owner.lock');
  const workerFile = join(cwd, '.piq', 'worker.json');
  const token = 'owned-worker-token';
  const owner = () => writeFile(ownerFile, JSON.stringify({ version: 1, pid: process.pid, token }));
  const record = (launchId = 'fixture', state = 'running', ownerToken = token, extra: Record<string, unknown> = {}) => writeFile(workerFile, JSON.stringify({
    version: 1, mode: 'background', pid: process.pid, launchId, startedAt: Date.now(), state, ownerToken, ...extra,
  }));
  return { root, cwd, env, ownerFile, workerFile, token, owner, record };
}

test('starting a group opens a terminal and creates no worker or recovery process', async t => {
  const f = await fixture(t);
  const launches: TerminalLaunch[] = [];
  await startGroup(f.cwd, { env: f.env, launch: async specification => { launches.push(specification); } });
  assert.equal(launches.length, 1);
  const launched = launches[0]!;
  assert.equal(launched.command, 'wt.exe');
  assert.equal(launched.cwd, f.cwd);
  assert.equal(launched.env.SNOWLUMA_ACCESS_TOKEN, 'private-test-token');
  assert.equal(launched.env.PIQ_RUN_MODE, 'terminal');
  assert.ok(launched.env.PIQ_TERMINAL_ENTRY?.endsWith('terminal-entry.ts'));
  assert.doesNotMatch(JSON.stringify(launched.args), /private-test-token|background\.ts|terminal-monitor\.ts/);
  const marker = JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8'));
  assert.equal(marker.kind, 'terminal-only');
  assert.equal(marker.monitorPid, undefined);
  assert.equal(marker.token, launched.env.PIQ_TERMINAL_RETURN_TOKEN);
  assert.equal((await getProcessStatus(f.cwd)).mode, 'terminal');
  assert.equal((await getProcessStatus(f.cwd)).starting, true);
  for (const filename of ['worker.json', 'worker-launch.json', 'start.lock']) {
    await assert.rejects(readFile(join(f.cwd, '.piq', filename)), { code: 'ENOENT' });
  }
});

test('concurrent and repeated terminal starts do not launch a second Pi session', async t => {
  const f = await fixture(t);
  let launches = 0;
  const options = { env: f.env, launch: async () => { launches++; } };
  const results = await Promise.all([startGroup(f.cwd, options), startGroup(f.cwd, options)]);
  assert.equal(launches, 1);
  assert.equal(results.filter(result => result.alreadyRunning).length, 1);
  const lease = JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8'));
  await registerTerminal(f.cwd, lease.token, process.pid, process.pid);
  const running = await getProcessStatus(f.cwd);
  assert.equal(running.mode, 'terminal'); assert.equal(running.running, true);
  assert.equal((await startGroup(f.cwd, options)).alreadyRunning, true);
  assert.equal(launches, 1);
});

test('a failed terminal launch releases its leases and can be retried', async t => {
  const f = await fixture(t);
  await assert.rejects(startGroup(f.cwd, { env: f.env, launch: async () => { throw new Error('Test terminal unavailable'); } }), /terminal unavailable/);
  assert.deepEqual(await getProcessStatus(f.cwd), { running: false, pid: null, mode: null, starting: false });
  for (const filename of ['start.lock', 'terminal-return.lock', 'terminal-return.json']) {
    await assert.rejects(readFile(join(f.cwd, '.piq', filename)), { code: 'ENOENT' });
  }
  let retried = false;
  await startGroup(f.cwd, { env: f.env, launch: async () => { retried = true; } });
  assert.equal(retried, true);
});

test('legacy background records remain readable and require a matching live owner token', async t => {
  const f = await fixture(t);
  await f.owner(); await f.record();
  assert.deepEqual(await getProcessStatus(f.cwd), { running: true, pid: process.pid, mode: 'background', starting: false });
  await f.record('fixture', 'running', 'stale-token');
  assert.deepEqual(await getProcessStatus(f.cwd), { running: true, pid: process.pid, mode: 'terminal', starting: false });
  await f.record('fixture', 'running', f.token, { lastError: 'legacy secret must not be returned' });
  const warned = await getProcessStatus(f.cwd);
  assert.equal(warned.running, true); assert.match(warned.error!, /扩展运行出现错误/);
  assert.doesNotMatch(warned.error!, /secret/);
});

test('legacy startup markers stay visible until completed and dead PIDs are ignored', async t => {
  const f = await fixture(t);
  const launchPath = join(f.cwd, '.piq', 'worker-launch.json');
  const pending = { version: 1, pid: process.pid, launchId: 'legacy-launch', startedAt: Date.now() };
  await writeFile(launchPath, JSON.stringify(pending));
  assert.deepEqual(await getProcessStatus(f.cwd), { running: false, pid: process.pid, mode: 'background', starting: true });
  await f.record(pending.launchId, 'stopped');
  assert.deepEqual(await getProcessStatus(f.cwd), { running: false, pid: null, mode: null, starting: false });
  await unlink(f.workerFile);
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'console.log(process.pid)'], { windowsHide: true });
  await writeFile(launchPath, JSON.stringify({ ...pending, pid: Number(stdout.trim()) }));
  assert.deepEqual(await getProcessStatus(f.cwd), { running: false, pid: null, mode: null, starting: false });
});

test('handoff stops a legacy background owner before opening the terminal', async t => {
  const f = await fixture(t);
  await f.owner(); await f.record();
  const calls: string[] = [];
  const result = await handoffToTerminal(f.cwd, {
    shutdown: async cwd => { assert.equal(cwd, f.cwd); calls.push('shutdown'); await unlink(f.ownerFile); },
    openTerminal: async cwd => {
      assert.equal(cwd, f.cwd);
      await assert.rejects(readFile(f.ownerFile), { code: 'ENOENT' });
      calls.push('terminal'); return { message: 'opened' };
    },
  });
  assert.equal(result.message, 'opened');
  assert.deepEqual(calls, ['shutdown', 'terminal']);
});

test('handoff leaves terminal owners untouched even if an unrelated worker record remains', async t => {
  const f = await fixture(t);
  await f.owner(); await f.record('fixture', 'running', 'old-owner');
  let shutdowns = 0;
  const result = await handoffToTerminal(f.cwd, {
    shutdown: async () => { shutdowns++; },
    openTerminal: async () => ({ message: 'already open', alreadyRunning: true }),
  });
  assert.equal(result.alreadyRunning, true);
  assert.equal(shutdowns, 0);
});

test('handoff timeout preserves the owner and does not launch a competing terminal', async t => {
  const f = await fixture(t);
  await f.owner(); await f.record();
  let opens = 0;
  await assert.rejects(handoffToTerminal(f.cwd, {
    timeoutMs: 1, shutdown: async () => {},
    openTerminal: async () => { opens++; return { message: 'unexpected' }; },
  }), /尚未退出/);
  assert.equal(opens, 0);
  assert.equal((await getProcessStatus(f.cwd)).running, true);
});

test('handoff detects a replacement owner instead of opening beside it', async t => {
  const f = await fixture(t);
  await f.owner(); await f.record();
  let opens = 0;
  await assert.rejects(handoffToTerminal(f.cwd, {
    shutdown: async () => { await writeFile(f.ownerFile, JSON.stringify({ version: 1, pid: process.pid, token: 'replacement' })); },
    openTerminal: async () => { opens++; return { message: 'unexpected' }; },
  }), /其他实例接管/);
  assert.equal(opens, 0);
});
