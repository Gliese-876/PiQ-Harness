import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { initializeGroup, validateConfig } from '../src/config.ts';
import { credentialStatus, getRunningOwner, openGroupTerminal, resolveGroupEnvironment, type TerminalLaunch } from '../src/web-terminal.ts';
import { terminalMain } from '../src/terminal-entry.ts';
import { createFreshSession, openGroup } from '../src/cli.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { finishTerminal, getTerminalLaunchStatus, prepareTerminalReturn, registerTerminal } from '../src/terminal-monitor.ts';

async function fixture() {
  const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'terminal-'));
  const configDirectory = join(root, 'snow-config');
  await mkdir(configDirectory);
  const config = validateConfig({ id: '223344', name: 'Test group', conversations: [{ type: 'group', id: '223344' }], wsUrl: 'ws://127.0.0.1:3000/' });
  const cwd = await initializeGroup(root, config.id, { name: config.name, conversations: config.conversations, wsUrl: config.wsUrl });
  await writeFile(join(configDirectory, 'onebot_10001.json'), JSON.stringify({ networks: { httpServers: [{
    host: '127.0.0.1', port: 3000, path: '/', enableWebSocket: true, accessToken: 'private-test-token',
  }] } }));
  return { root, cwd, configDirectory, config };
}

test('credential metadata contains no secret and environment variables take priority', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const options = { configDirectory: f.configDirectory, env: {} };
  assert.deepEqual(await credentialStatus(f.config, options), { available: true, source: 'SnowLuma 本地配置' });
  const resolved = await resolveGroupEnvironment(f.cwd, f.config, options);
  assert.equal(resolved.env.SNOWLUMA_ACCESS_TOKEN, 'private-test-token');
  assert.doesNotMatch(JSON.stringify(resolved.credential), /private-test-token/);
  assert.equal(await resolveGroupEnvironment(f.cwd, f.config, {
    ...options, env: { SNOWLUMA_ACCESS_TOKEN: 'from-environment' },
  }).then(result => result.env.SNOWLUMA_ACCESS_TOKEN), 'from-environment');
});

test('local credentials require a matching enabled endpoint and are not inferred for remote hosts', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const options = { configDirectory: f.configDirectory, env: {} };
  for (const wsUrl of ['ws://127.0.0.1:3001/', 'ws://127.0.0.1:3000/other', 'ws://example.com:3000/']) {
    const config = { ...f.config, wsUrl };
    assert.equal((await credentialStatus(config, options)).available, false);
    assert.equal((await resolveGroupEnvironment(f.cwd, config, options)).env.SNOWLUMA_ACCESS_TOKEN, undefined);
  }
  await writeFile(join(f.configDirectory, 'onebot_10001.json'), JSON.stringify({ networks: { httpServers: [{
    host: '127.0.0.1', port: 3000, path: '/', enableWebSocket: false, accessToken: 'private-test-token',
  }] } }));
  assert.equal((await credentialStatus(f.config, options)).available, false);
  await writeFile(join(f.configDirectory, 'onebot_10002.json'), JSON.stringify({ networks: { wsServers: [{
    host: '0.0.0.0', port: 3000, path: '/', accessToken: 'ws-token',
  }] } }));
  assert.equal((await resolveGroupEnvironment(f.cwd, f.config, options)).env.SNOWLUMA_ACCESS_TOKEN, 'ws-token');
});

test('ambiguous matching account credentials require an explicit environment variable', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.configDirectory, 'onebot_20001.json'), JSON.stringify({ networks: { wsServers: [{
    host: '127.0.0.1', port: 3000, path: '/', accessToken: 'another-private-token',
  }] } }));
  const status = await credentialStatus(f.config, { configDirectory: f.configDirectory, env: {} });
  assert.equal(status.available, false);
  assert.doesNotMatch(JSON.stringify(status), /another-private-token|private-test-token/);
});

test('terminal request uses trusted scripts and separate arguments with a scoped credential environment', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const fakeEntry = join(f.root, 'pi with spaces.cjs');
  await writeFile(fakeEntry, '');
  let request: TerminalLaunch | undefined;
  const result = await openGroupTerminal(f.cwd, {
    configDirectory: f.configDirectory,
    env: { SystemRoot: 'C:\\Windows', PIQ_PI_ENTRY: fakeEntry },
    prepareReturn: async () => ({ token: 'terminal-return-test-token' }),
    cancelReturn: async () => {},
    launch: async specification => { request = specification; },
  });
  assert.match(result.message, /继续本群最近/);
  assert.equal(request!.cwd, f.cwd);
  assert.equal(request!.command, 'wt.exe');
  assert.equal(request!.env.SNOWLUMA_ACCESS_TOKEN, 'private-test-token');
  assert.equal(request!.env.PIQ_GROUP_DIRECTORY, f.cwd);
  assert.equal(request!.env.PIQ_NODE_EXECUTABLE, process.execPath);
  assert.equal(request!.env.PIQ_TERMINAL_RETURN_TOKEN, 'terminal-return-test-token');
  assert.ok(!request!.args.includes('-NoExit'));
  assert.equal(request!.env.PIQ_RUN_MODE, 'terminal');
  assert.equal(request!.env.PIQ_START_RUNNING, '1');
  assert.ok(request!.args.includes('--inheritEnvironment'));
  assert.ok(!request!.args.includes(f.cwd));
  assert.ok(request!.args.some(arg => arg.endsWith(join('scripts', 'open-pi.ps1'))));
  assert.equal(request!.args.some(arg => arg.includes('Start-Pi.ps1') || arg.includes('private-test-token')), false);
  assert.equal(request!.args.some(arg => arg.includes('terminal-return-test-token')), false);
});

test('an existing live group owner prevents a duplicate terminal', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(join(f.cwd, '.piq'));
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'test-owner' }));
  assert.deepEqual(await getRunningOwner(f.cwd), { running: true, pid: process.pid });
  const result = await openGroupTerminal(f.cwd, { launch: async () => assert.fail('Duplicate launch') });
  assert.equal(result.alreadyRunning, true);
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), 'invalid');
  await assert.rejects(getRunningOwner(f.cwd), /运行锁/);
});

test('the trusted terminal entry continues the correct group session without a model or QQ call', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, '.pi', 'settings.json'), JSON.stringify({
    defaultProvider: 'test-provider', defaultModel: 'test-model', defaultThinkingLevel: 'high',
  }));
  const fakeEntry = join(f.root, 'fake-pi.cjs');
  await writeFile(fakeEntry, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), credential: !!process.env.SNOWLUMA_ACCESS_TOKEN }));');
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/terminal-entry.ts', import.meta.url)), f.cwd], {
      cwd: f.root, env: { ...process.env, PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'test-only', PIQ_TERMINAL_RETURN_TOKEN: undefined }, shell: false, windowsHide: true,
    });
    let text = ''; let errors = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveOutput(text) : reject(new Error(errors)));
  });
  assert.deepEqual(JSON.parse(output), {
    cwd: f.cwd, args: ['--continue', '--session-dir', join(f.cwd, '.pi', 'sessions'),
      '--provider', 'test-provider', '--model', 'test-model', '--thinking', 'high'], credential: true,
  });
});

test('the PowerShell helper treats special characters in group paths as literal data', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const cwd = await initializeGroup(join(f.root, 'space; $value & [literal]'), '223355', { name: 'Special path group', conversations: [{ type: 'group', id: '223355' }], wsUrl: f.config.wsUrl });
  const fakeEntry = join(f.root, 'fake-pi-helper.cjs');
  await writeFile(fakeEntry, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), credential: !!process.env.SNOWLUMA_ACCESS_TOKEN }));');
  let output = '';
  await openGroupTerminal(cwd, {
    configDirectory: f.configDirectory, env: { ...process.env, PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'test-helper' },
    prepareReturn: async () => ({ token: 'helper-return-token' }),
    cancelReturn: async () => {},
    launch: specification => new Promise<void>((resolveLaunch, reject) => {
      const helper = specification.args[specification.args.indexOf('-File') + 1]!;
      const shell = specification.args[specification.args.indexOf('-NoLogo') - 1]!;
      const child = spawn(shell, ['-NoLogo', '-NoProfile', '-File', helper], {
        cwd: f.root, env: { ...specification.env, PIQ_TERMINAL_RETURN_TOKEN: undefined }, shell: false, windowsHide: true,
      });
      let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolveLaunch() : reject(new Error(errors)));
    }),
  });
  assert.deepEqual(JSON.parse(output), {
    cwd, args: ['--continue', '--session-dir', join(cwd, '.pi', 'sessions')], credential: true,
  });
});

test('concurrent and still-opening terminal requests launch one window', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const fakeEntry = join(f.root, 'fake-pi.cjs'); await writeFile(fakeEntry, '');
  let preparations = 0; let launches = 0;
  const options = {
    env: { PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'test-only' },
    prepareReturn: async () => ({ token: 'opening-return-token', alreadyRunning: preparations++ > 0 }),
    cancelReturn: async () => assert.fail('Successful opening must retain its return lease'),
    launch: async () => { launches++; await delay(20); },
  };
  const results = await Promise.all([openGroupTerminal(f.cwd, options), openGroupTerminal(f.cwd, options)]);
  assert.equal(launches, 1);
  assert.equal(preparations, 1);
  assert.equal(results.filter(result => result.alreadyRunning).length, 1);
  assert.equal((await openGroupTerminal(f.cwd, options)).alreadyRunning, true);
  assert.equal(launches, 1);
});

test('a failed window launch cancels only the prepared terminal lease', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const fakeEntry = join(f.root, 'fake-pi.cjs'); await writeFile(fakeEntry, '');
  const cancelled: unknown[] = [];
  await assert.rejects(openGroupTerminal(f.cwd, {
    env: { PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'test-only' },
    prepareReturn: async () => ({ token: 'failed-window-token' }),
    cancelReturn: async (...args: [string, string?]) => { cancelled.push(args); },
    launch: async () => { throw new Error('fixture window failure'); },
  }), /fixture window failure/);
  assert.deepEqual(cancelled, [[f.cwd, 'failed-window-token']]);
});

test('an owner appearing after lease preparation prevents the terminal window', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const fakeEntry = join(f.root, 'fake-pi.cjs'); await writeFile(fakeEntry, '');
  const cancelled: unknown[] = [];
  const result = await openGroupTerminal(f.cwd, {
    env: { PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'test-only' },
    prepareReturn: async () => {
      await mkdir(join(f.cwd, '.piq'), { recursive: true });
      await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'new-owner' }));
      return { token: 'superseded-return-token' };
    },
    cancelReturn: async (...args: [string, string?]) => { cancelled.push(args); },
    launch: async () => assert.fail('A new live owner must prevent the terminal launch'),
  });
  assert.equal(result.alreadyRunning, true);
  assert.deepEqual(cancelled, [[f.cwd, 'superseded-return-token']]);
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'owner.lock'), 'utf8')).token, 'new-owner');
});

test('managed terminal entries register only the wrapper and pass its identity through the environment', async () => {
  const cwd = join(process.cwd(), '.test-tmp', 'entry-fixture');
  const calls: unknown[] = [];
  const result = await terminalMain([cwd], {
    env: { PIQ_TERMINAL_RETURN_TOKEN: 'managed-entry-token' },
    register: async (...args: [string, string, number?, number?]) => { calls.push(args); },
    open: async (path, args, options) => {
      assert.equal(path, cwd); assert.deepEqual(args, []);
      assert.equal(options!.onSpawn, undefined);
      assert.equal(options!.env!.PIQ_TERMINAL_WRAPPER_PID, String(process.pid));
      assert.equal(options!.env!.PIQ_TERMINAL_RETURN_TOKEN, 'managed-entry-token');
      return 0;
    },
  });
  assert.equal(result, 0);
  assert.deepEqual(calls, [[cwd, 'managed-entry-token', process.pid]]);
  assert.equal(await terminalMain([cwd], { env: {}, register: async () => assert.fail('Plain CLI must not register a monitor'), open: async (_cwd, _args, options) => {
    assert.equal(options!.env!.PIQ_RUN_MODE, 'terminal'); return 0;
  } }), 0);
  await assert.rejects(terminalMain([cwd], {
    env: { PIQ_TERMINAL_RETURN_TOKEN: 'cancelled-entry-token' },
    register: async () => { throw new Error('fixture stale terminal token'); },
    open: async () => assert.fail('An invalid wrapper registration must not launch Pi'),
  }), /fixture stale terminal token/);
});

test('nested launchers inherit the terminal wrapper identity without being registered as Pi owners', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const launcher = join(f.root, 'nested-launcher.cjs');
  const actualPi = join(f.root, 'actual-pi.cjs');
  const report = join(f.root, 'actual-pi.json');
  await writeFile(launcher, `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[process.env.FIXTURE_REAL_PI_ENTRY],{stdio:'inherit',env:process.env,shell:false}); child.once('exit',code=>{process.exitCode=code??1});`);
  await writeFile(actualPi, `require('node:fs').writeFileSync(process.env.FIXTURE_REAL_PI_REPORT,JSON.stringify({pid:process.pid,parentPid:process.ppid,wrapper:process.env.PIQ_TERMINAL_WRAPPER_PID,token:process.env.PIQ_TERMINAL_RETURN_TOKEN,args:process.argv.slice(2)}));`);
  const calls: unknown[] = [];
  const originalWrapper = process.env.PIQ_TERMINAL_WRAPPER_PID;
  assert.equal(await terminalMain([f.cwd], {
    env: { PIQ_PI_ENTRY: launcher, PIQ_TERMINAL_RETURN_TOKEN: 'nested-return-token', FIXTURE_REAL_PI_ENTRY: actualPi, FIXTURE_REAL_PI_REPORT: report },
    register: async (...args: [string, string, number?, number?]) => { calls.push(args); },
  }), 0);
  const actual = JSON.parse(await readFile(report, 'utf8'));
  assert.deepEqual(calls, [[f.cwd, 'nested-return-token', process.pid]]);
  assert.notEqual(actual.pid, process.pid);
  assert.notEqual(actual.parentPid, process.pid);
  assert.equal(actual.wrapper, String(process.pid));
  assert.equal(actual.token, 'nested-return-token');
  assert.deepEqual(actual.args, []);
  assert.equal(process.env.PIQ_TERMINAL_WRAPPER_PID, originalWrapper, 'Child configuration must not modify the caller environment.');
});

test('Pi spawn registration finishes before an exiting child resolves and failures terminate the child', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const previousEntry = process.env.PIQ_PI_ENTRY;
  t.after(() => { if (previousEntry === undefined) delete process.env.PIQ_PI_ENTRY; else process.env.PIQ_PI_ENTRY = previousEntry; });
  const fakeEntry = join(f.root, 'fast-pi.cjs'); await writeFile(fakeEntry, '');
  process.env.PIQ_PI_ENTRY = fakeEntry;
  let registered = false;
  assert.equal(await openGroup(f.cwd, [], { onSpawn: async () => { await delay(40); registered = true; } }), 0);
  assert.equal(registered, true);
  await writeFile(fakeEntry, 'setInterval(() => {}, 1000)');
  let childPid = 0;
  await assert.rejects(openGroup(f.cwd, [], { onSpawn: async pid => { childPid = pid; throw new Error('fixture registration failed'); } }), /fixture registration failed/);
  const deadline = Date.now() + 3_000;
  while (true) {
    try { process.kill(childPid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); break; }
    if (Date.now() > deadline) assert.fail('The unregistered Pi child is still running');
    await delay(10);
  }
});


test('fresh terminal sessions are persisted before a turn and preserve previous history', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const old = await createFreshSession(f.cwd);
  const oldContents = await readFile(old, 'utf8');
  await writeFile(join(f.cwd, 'MEMORY.md'), 'Remember this');
  await delay(20);
  const fakeEntry = join(f.root, 'fake-pi.cjs'); await writeFile(fakeEntry, '');
  let sessionFile = '';
  await openGroupTerminal(f.cwd, { freshSession: true, configDirectory: f.configDirectory,
    env: { PIQ_PI_ENTRY: fakeEntry }, launch: async specification => {
      sessionFile = specification.env.PIQ_SESSION_FILE!;
      assert.ok(sessionFile.endsWith('.jsonl'));
      const rows = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, 'session');
      assert.equal(rows[0].cwd, f.cwd);
      assert.equal(specification.env.PIQ_RUN_MODE, 'terminal');
    } });
  assert.notEqual(sessionFile, old);
  assert.equal(SessionManager.continueRecent(f.cwd, join(f.cwd, '.pi', 'sessions')).getSessionFile(), sessionFile);
  assert.equal(SessionManager.open(sessionFile).getEntries().length, 0);
  assert.equal(await readFile(old, 'utf8'), oldContents);
  assert.equal(await readFile(join(f.cwd, 'MEMORY.md'), 'utf8'), 'Remember this');
});

test('a failed fresh terminal launch preserves the previous session selection', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const old = await createFreshSession(f.cwd);
  const fakeEntry = join(f.root, 'fake-pi.cjs'); await writeFile(fakeEntry, '');
  await assert.rejects(openGroupTerminal(f.cwd, { freshSession: true, configDirectory: f.configDirectory,
    env: { PIQ_PI_ENTRY: fakeEntry }, launch: async () => { throw new Error('window unavailable'); } }), /window unavailable/);
  assert.deepEqual(await readdir(join(f.cwd, '.pi', 'sessions')), [old.split(/[\\/]/).pop()]);
  assert.equal(SessionManager.continueRecent(f.cwd, join(f.cwd, '.pi', 'sessions')).getSessionFile(), old);
});

test('the terminal entry passes the selected session once and releases its marker on exit', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const lease = await prepareTerminalReturn(f.cwd);
  const sessionFile = await createFreshSession(f.cwd);
  await terminalMain([f.cwd], { env: { PIQ_TERMINAL_RETURN_TOKEN: lease.token, PIQ_SESSION_FILE: sessionFile },
    open: async (_path, _args, options) => {
      assert.equal(options!.sessionFile, sessionFile);
      assert.equal(options!.env!.PIQ_SESSION_FILE, undefined);
      assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8')).wrapperPid, process.pid);
      return 0;
    } });
  await assert.rejects(stat(join(f.cwd, '.piq', 'terminal-return.json')), { code: 'ENOENT' });
});

test('a terminal wrapper cannot discard a real Pi process that outlives its launcher', async t => {
  const f = await fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolveChild, reject) => { child.once('spawn', resolveChild); child.once('error', reject); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolveExit => { child.once('exit', () => resolveExit()); child.kill(); });
  };
  t.after(async () => { await stop(); await rm(f.root, { recursive: true, force: true }); });
  const lease = await prepareTerminalReturn(f.cwd);
  await terminalMain([f.cwd], { env: { PIQ_TERMINAL_RETURN_TOKEN: lease.token },
    open: async () => { await registerTerminal(f.cwd, lease.token, process.pid, child.pid); return 0; } });
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: true, starting: false, pid: child.pid });
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8')).recoveryDisabled, true);
  assert.equal((await prepareTerminalReturn(f.cwd)).alreadyRunning, true);
  await finishTerminal(f.cwd, 'stale-token');
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8')).token, lease.token);
  await stop();
  await finishTerminal(f.cwd, lease.token);
  await assert.rejects(stat(join(f.cwd, '.piq', 'terminal-return.json')), { code: 'ENOENT' });
});
