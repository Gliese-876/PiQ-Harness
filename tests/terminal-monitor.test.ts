import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { initializeGroup } from '../src/config.ts';
import { clearTerminalLaunch, stopTerminalRegistration, getTerminalLaunchStatus, getTerminalLaunchError, prepareTerminalLaunch,
  registerTerminal, TERMINAL_START_TIMEOUT_MS } from '../src/terminal-monitor.ts';

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveStop => { child.once('exit', () => resolveStop()); child.kill(); });
}

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'terminal-lease-'));
  const cwd = await initializeGroup(root, 'friends', { name: 'Friends', conversations: [{ type: 'group', id: '123456' }] });
  await mkdir(join(cwd, '.piq'), { recursive: true });
  const stateFile = join(cwd, '.piq', 'terminal-return.json');
  const children: ChildProcess[] = [];
  const child = async () => {
    const processChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    children.push(processChild);
    await new Promise<void>((resolveChild, reject) => { processChild.once('spawn', resolveChild); processChild.once('error', reject); });
    return processChild;
  };
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  t.after(async () => {
    await Promise.all(children.map(stopChild));
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, stateFile, state, child };
}

test('concurrent terminal requests publish one current launch lease', async t => {
  const f = await fixture(t);
  const prepared = await Promise.all([prepareTerminalLaunch(f.cwd), prepareTerminalLaunch(f.cwd)]);
  assert.equal(prepared[0].token, prepared[1].token);
  assert.equal(prepared.filter(item => item.alreadyRunning).length, 1);
  const stored = await f.state();
  assert.equal(stored.kind, 'terminal-only'); assert.equal(stored.state, 'starting');
  assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'kind', 'launcherPid', 'state', 'token', 'version']);
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: false, starting: true, pid: process.pid });
});

test('closing a terminal before Pi registers permits another terminal launch', async t => {
  const f = await fixture(t);
  const prepared = await prepareTerminalLaunch(f.cwd);
  const wrapper = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid);
  const active = await getTerminalLaunchStatus(f.cwd);
  assert.equal(active.running || active.starting, true);
  assert.equal(active.pid, wrapper.pid);
  await stopChild(wrapper);
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: false, starting: false, pid: null });
  assert.equal((await f.state()).launcherPid, process.pid, 'a still-open WebUI must not keep the closed terminal running');
  const next = await prepareTerminalLaunch(f.cwd);
  assert.notEqual(next.token, prepared.token);
  assert.notEqual(next.alreadyRunning, true);
});

test('terminal status tracks both wrapper and real Pi without any automatic restart', async t => {
  const f = await fixture(t);
  const prepared = await prepareTerminalLaunch(f.cwd);
  const wrapper = await f.child(); const pi = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, pi.pid);
  await stopChild(wrapper);
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: true, starting: false, pid: pi.pid });
  await stopChild(pi);
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: false, starting: false, pid: null });
});

test('an unopened terminal lease expires and cannot register after its deadline', async t => {
  const f = await fixture(t);
  const prepared = await prepareTerminalLaunch(f.cwd);
  await writeFile(f.stateFile, JSON.stringify({ ...await f.state(), createdAt: Date.now() - TERMINAL_START_TIMEOUT_MS - 1 }));
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: false, starting: false, pid: null });
  await assert.rejects(registerTerminal(f.cwd, prepared.token), /失效/);
  const retry = await prepareTerminalLaunch(f.cwd);
  assert.notEqual(retry.token, prepared.token);
});

test('registration preserves process identity across reload and rejects another owner', async t => {
  const f = await fixture(t);
  const prepared = await prepareTerminalLaunch(f.cwd);
  const wrapper = await f.child(); const pi = await f.child(); const other = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, pi.pid);
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, pi.pid);
  assert.equal((await f.state()).piPid, pi.pid);
  await assert.rejects(registerTerminal(f.cwd, prepared.token, other.pid), /另一进程/);
  await assert.rejects(registerTerminal(f.cwd, prepared.token, wrapper.pid, other.pid), /已登记/);
  await assert.rejects(registerTerminal(f.cwd, 'stale-token', wrapper.pid), /失效/);
  await assert.rejects(registerTerminal(f.cwd, prepared.token, 0), /无效/);
});

test('cancellation is idempotent and stale tokens cannot remove a newer lease', async t => {
  const f = await fixture(t);
  const first = await prepareTerminalLaunch(f.cwd);
  await clearTerminalLaunch(f.cwd, first.token);
  const second = await prepareTerminalLaunch(f.cwd);
  await clearTerminalLaunch(f.cwd, first.token);
  assert.equal((await f.state()).token, second.token);
  await Promise.all([clearTerminalLaunch(f.cwd, second.token), clearTerminalLaunch(f.cwd, second.token)]);
  await assert.rejects(readFile(f.stateFile), { code: 'ENOENT' });
});

test('stopping registration keeps live Pi and wrapper tracking until both have exited', async t => {
  const f = await fixture(t);
  const prepared = await prepareTerminalLaunch(f.cwd);
  const wrapper = await f.child(); const pi = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, pi.pid);
  await assert.rejects(readFile(join(f.cwd, '.piq', 'owner.lock')), { code: 'ENOENT' });
  const token = await stopTerminalRegistration(f.cwd);
  assert.equal(token, prepared.token);
  const retained = await f.state();
  assert.equal(retained.state, 'disabled');
  assert.equal(retained.wrapperPid, wrapper.pid); assert.equal(retained.piPid, pi.pid);
  assert.equal(await getTerminalLaunchError(f.cwd), undefined, 'a deliberate stop is not a startup error');
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: true, starting: false, pid: pi.pid });
  assert.deepEqual(await prepareTerminalLaunch(f.cwd), { token, alreadyRunning: true });
  await assert.rejects(registerTerminal(f.cwd, prepared.token, wrapper.pid, pi.pid), /失效/);

  await stopChild(pi);
  const wrapperOnly = await getTerminalLaunchStatus(f.cwd);
  assert.equal(wrapperOnly.running || wrapperOnly.starting, true);
  assert.equal(wrapperOnly.pid, wrapper.pid);
  assert.deepEqual(await prepareTerminalLaunch(f.cwd), { token, alreadyRunning: true });
  await stopChild(wrapper);
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: false, starting: false, pid: null });
  await clearTerminalLaunch(f.cwd, token);
  await assert.rejects(readFile(f.stateFile), { code: 'ENOENT' });
});

test('disabling a wrapper before Pi registration blocks its late registration and duplicate launch', async t => {
  const f = await fixture(t);
  const prepared = await prepareTerminalLaunch(f.cwd);
  const wrapper = await f.child(); const latePi = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid);
  const token = await stopTerminalRegistration(f.cwd);
  assert.equal(await stopTerminalRegistration(f.cwd), token, 'repeated stop requests keep the same launch identity');
  const active = await getTerminalLaunchStatus(f.cwd);
  assert.equal(active.running || active.starting, true); assert.equal(active.pid, wrapper.pid);
  assert.equal((await f.state()).piPid, undefined);
  assert.deepEqual(await prepareTerminalLaunch(f.cwd), { token, alreadyRunning: true });
  await assert.rejects(registerTerminal(f.cwd, prepared.token, wrapper.pid, latePi.pid), /失效/);
  assert.equal((await f.state()).piPid, undefined);
  await stopChild(wrapper); await stopChild(latePi);
  await clearTerminalLaunch(f.cwd, token);
});

test('a stop token cannot remove a new launch created after the old launch ends', async t => {
  const f = await fixture(t);
  const first = await prepareTerminalLaunch(f.cwd);
  const token = await stopTerminalRegistration(f.cwd);
  assert.equal(token, first.token);
  const second = await prepareTerminalLaunch(f.cwd);
  assert.notEqual(second.token, token);
  await clearTerminalLaunch(f.cwd, token);
  assert.equal((await f.state()).token, second.token);
  assert.equal((await f.state()).state, 'starting');
});

test('stopping registration without a marker is a no-op', async t => {
  const f = await fixture(t);
  assert.equal(await stopTerminalRegistration(f.cwd), undefined);
  assert.equal(await getTerminalLaunchError(f.cwd), undefined);
  await assert.rejects(readFile(f.stateFile), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.cwd, '.piq', 'terminal-return.lock')), { code: 'ENOENT' });
});

test('abandoned lease locks are recovered without starting any process', async t => {
  const f = await fixture(t);
  const dead = await f.child(); await stopChild(dead);
  await writeFile(join(f.cwd, '.piq', 'terminal-return.lock'), JSON.stringify({ pid: dead.pid, token: 'abandoned-lock' }));
  const prepared = await prepareTerminalLaunch(f.cwd);
  assert.equal((await f.state()).token, prepared.token);
  await assert.rejects(readFile(join(f.cwd, '.piq', 'terminal-return.lock')), { code: 'ENOENT' });
  assert.equal(await getTerminalLaunchError(f.cwd), undefined);
});

test('damaged metadata is preserved and reported without exposing arbitrary details', async t => {
  const f = await fixture(t);
  await writeFile(f.stateFile, '{bad secret-test-data');
  await assert.rejects(prepareTerminalLaunch(f.cwd));
  assert.equal(await readFile(f.stateFile, 'utf8'), '{bad secret-test-data');
  const error = await getTerminalLaunchError(f.cwd);
  assert.match(error!, /终端/); assert.doesNotMatch(error!, /secret-test-data/);
});

test('terminal metadata refuses directory links outside its group', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await rename(join(f.cwd, '.piq'), join(f.cwd, '.piq-original'));
  try { await symlink(outside, join(f.cwd, '.piq'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await rename(join(f.cwd, '.piq-original'), join(f.cwd, '.piq'));
    t.skip('The OS sandbox does not permit directory links.'); return;
  }
  await assert.rejects(prepareTerminalLaunch(f.cwd), /普通/);
  assert.equal(await getTerminalLaunchError(f.cwd) !== undefined, true);
});
