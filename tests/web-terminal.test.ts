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
import { finishTerminal, getTerminalLaunchStatus, prepareTerminalLaunch, registerTerminal } from '../src/terminal-monitor.ts';

async function fixture() {
  const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'terminal-'));
  const config = validateConfig({ id: '223344', name: 'Test group', conversations: [{ type: 'group', id: 'opaque-group_223344' }] });
  const cwd = await initializeGroup(root, config.id, { name: config.name, conversations: config.conversations });
  return { root, cwd, config };
}

test('credential metadata exposes availability without secrets and process settings take priority', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const input = Object.freeze({ QQBOT_APP_ID: 'synthetic-process-id', QQBOT_APP_SECRET: 'synthetic-process-secret', PIQ_TEST_MARKER: 'preserved' });
  const processBefore = [process.env.QQBOT_APP_ID, process.env.QQBOT_APP_SECRET];
  const options = { env: input, readUserEnvironment: async () => { assert.fail('Present process credentials must not read user settings'); return {}; } };
  const status = await credentialStatus(f.config, options);
  assert.equal(status.available, true);
  assert.deepEqual(Object.keys(status).sort(), ['available', 'source']);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-process-id|synthetic-process-secret/);
  const resolved = await resolveGroupEnvironment(f.cwd, f.config, options);
  assert.notEqual(resolved.env, input);
  assert.deepEqual(resolved.env, input);
  assert.equal(resolved.credential.available, true);
  assert.equal(input.QQBOT_APP_SECRET, 'synthetic-process-secret');
  assert.ok(process.env.QQBOT_APP_ID === processBefore[0] && process.env.QQBOT_APP_SECRET === processBefore[1], 'Parent credentials must not change');
});

test('user fallback requests only missing configured names and imports only those values', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const config = validateConfig({ ...f.config, appIdEnv: 'PIQ_SELECTED_APP_ID', appSecretEnv: 'PIQ_SELECTED_APP_SECRET' });
  const input = Object.freeze({ PIQ_SELECTED_APP_ID: 'synthetic-process-id', PIQ_TEST_MARKER: 'keep' });
  const requests: string[][] = [];
  const result = await resolveGroupEnvironment(f.cwd, config, { env: input, readUserEnvironment: async names => {
    requests.push([...names]);
    return { PIQ_SELECTED_APP_ID: 'must-not-replace-process-id', PIQ_SELECTED_APP_SECRET: 'synthetic-user-secret',
      QQBOT_APP_ID: 'unselected-default-id', QQBOT_APP_SECRET: 'unselected-default-secret', UNRELATED_VALUE: 'never-import' };
  } });
  assert.deepEqual(requests, [['PIQ_SELECTED_APP_SECRET']]);
  assert.equal(result.env.PIQ_SELECTED_APP_ID, 'synthetic-process-id');
  assert.equal(result.env.PIQ_SELECTED_APP_SECRET, 'synthetic-user-secret');
  assert.equal(result.env.PIQ_TEST_MARKER, 'keep');
  assert.equal(result.env.QQBOT_APP_ID, undefined); assert.equal(result.env.QQBOT_APP_SECRET, undefined);
  assert.equal(result.env.UNRELATED_VALUE, undefined);
  assert.deepEqual(input, { PIQ_SELECTED_APP_ID: 'synthetic-process-id', PIQ_TEST_MARKER: 'keep' });
  assert.equal(result.credential.available, true);
  assert.doesNotMatch(JSON.stringify(result.credential), /synthetic-process-id|synthetic-user-secret/);
});

test('fallback requires both selected credentials and does not substitute default variable names', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const config = validateConfig({ ...f.config, appIdEnv: 'PIQ_SELECTED_APP_ID', appSecretEnv: 'PIQ_SELECTED_APP_SECRET' });
  const requested: string[][] = [];
  const result = await resolveGroupEnvironment(f.cwd, config, { env: {}, readUserEnvironment: async names => {
    requested.push([...names]);
    return { QQBOT_APP_ID: 'wrong-app-id', QQBOT_APP_SECRET: 'wrong-app-secret', PIQ_SELECTED_APP_SECRET: 'synthetic-user-secret' };
  } });
  assert.deepEqual(requested, [['PIQ_SELECTED_APP_ID', 'PIQ_SELECTED_APP_SECRET']]);
  assert.equal(result.credential.available, false);
  assert.match(result.credential.source, /PIQ_SELECTED_APP_ID/);
  assert.equal(result.env.PIQ_SELECTED_APP_ID, undefined);
  assert.equal(result.env.PIQ_SELECTED_APP_SECRET, 'synthetic-user-secret');
  assert.equal(result.env.QQBOT_APP_ID, undefined); assert.equal(result.env.QQBOT_APP_SECRET, undefined);
  assert.doesNotMatch(JSON.stringify(result.credential), /wrong-app|synthetic-user-secret/);
});

test('an explicitly supplied environment stays isolated when no user reader is provided', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const env of [{}, { QQBOT_APP_ID: 'synthetic-only-id' }, { QQBOT_APP_SECRET: 'synthetic-only-secret' }]) {
    const result = await resolveGroupEnvironment(f.cwd, f.config, { env });
    assert.equal(result.credential.available, false);
    assert.deepEqual(result.env, env);
    assert.doesNotMatch(JSON.stringify(result.credential), /synthetic-only-id|synthetic-only-secret/);
  }
  const result = await resolveGroupEnvironment(f.cwd, f.config, { env: { QQBOT_APP_ID: '', QQBOT_APP_SECRET: '' } });
  assert.equal(result.credential.available, false);
});

test('Windows credential names are normalized for exact-key consumers without replacing process values', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const input = Object.freeze({ qqbot_app_id: 'synthetic-parent-id', QqBot_App_Secret: '', UNRELATED_VALUE: 'keep' });
  const result = await resolveGroupEnvironment(f.cwd, f.config, { env: input, readUserEnvironment: async names => {
    assert.deepEqual(names, ['QQBOT_APP_SECRET']);
    return { qqbot_app_id: 'must-not-replace-id', qqbot_app_secret: 'synthetic-user-secret' };
  } });
  assert.equal(result.env[f.config.appIdEnv], 'synthetic-parent-id');
  assert.equal(result.env[f.config.appSecretEnv], 'synthetic-user-secret');
  assert.equal(result.env.qqbot_app_id, undefined); assert.equal(result.env.QqBot_App_Secret, undefined);
  assert.equal(result.env.qqbot_app_secret, undefined);
  assert.equal(result.env.UNRELATED_VALUE, 'keep');
  assert.equal(result.credential.available, true);
  assert.deepEqual(input, { qqbot_app_id: 'synthetic-parent-id', QqBot_App_Secret: '', UNRELATED_VALUE: 'keep' });
});

test('user environment read failures return safe metadata and preserve process values', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await resolveGroupEnvironment(f.cwd, f.config, {
    env: { QQBOT_APP_ID: 'synthetic-process-id' },
    readUserEnvironment: async names => {
      assert.deepEqual(names, ['QQBOT_APP_SECRET']);
      throw new Error('private-reader-secret https://private.invalid/?secret=hidden');
    },
  });
  assert.equal(result.credential.available, false);
  assert.match(result.credential.source, /QQBOT_APP_SECRET/);
  assert.equal(result.env.QQBOT_APP_ID, 'synthetic-process-id');
  assert.equal(result.env.QQBOT_APP_SECRET, undefined);
  assert.doesNotMatch(JSON.stringify(result.credential), /private-reader-secret|private.invalid|hidden|synthetic-process-id/);
});

test('missing QQBot credentials still open the terminal with a configuration reminder', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const fakeEntry = join(f.root, 'fake-pi.cjs'); await writeFile(fakeEntry, '');
  const requests: TerminalLaunch[] = [];
  const result = await openGroupTerminal(f.cwd, {
    env: { PIQ_PI_ENTRY: fakeEntry },
    launch: async specification => { requests.push(specification); },
  });
  assert.equal(requests.length, 1);
  assert.match(result.message, /QQBOT_APP_ID/); assert.match(result.message, /QQBOT_APP_SECRET/);
  assert.equal(requests[0]!.env.QQBOT_APP_ID, undefined);
  assert.equal(requests[0]!.env.QQBOT_APP_SECRET, undefined);
});

test('terminal request uses trusted scripts and separate arguments with a scoped credential environment', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const fakeEntry = join(f.root, 'pi with spaces.cjs');
  await writeFile(fakeEntry, '');
  let request: TerminalLaunch | undefined;
  const result = await openGroupTerminal(f.cwd, {
    env: { SystemRoot: 'C:\\Windows', PIQ_PI_ENTRY: fakeEntry, QQBOT_APP_ID: 'synthetic-app-id' },
    readUserEnvironment: async names => { assert.deepEqual(names, ['QQBOT_APP_SECRET']); return { QQBOT_APP_SECRET: 'private-test-token', IGNORED_FROM_USER: 'do-not-import' }; },
    prepareLaunch: async () => ({ token: 'terminal-return-test-token' }),
    clearLaunch: async () => {},
    launch: async specification => { request = specification; },
  });
  assert.match(result.message, /继续本群最近/);
  assert.equal(request!.cwd, f.cwd);
  assert.equal(request!.command, 'wt.exe');
  assert.equal(request!.env.QQBOT_APP_ID, 'synthetic-app-id');
  assert.equal(request!.env.QQBOT_APP_SECRET, 'private-test-token');
  assert.equal(request!.env.IGNORED_FROM_USER, undefined);
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
  await writeFile(fakeEntry, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), credential: !!process.env.QQBOT_APP_ID && !!process.env.QQBOT_APP_SECRET }));');
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/terminal-entry.ts', import.meta.url)), f.cwd], {
      cwd: f.root, env: { ...process.env, PIQ_PI_ENTRY: fakeEntry, QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'test-only', PIQ_TERMINAL_RETURN_TOKEN: undefined }, shell: false, windowsHide: true,
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
  const cwd = await initializeGroup(join(f.root, 'space; $value & [literal]'), '223355', { name: 'Special path group', conversations: [{ type: 'group', id: '223355' }] });
  const fakeEntry = join(f.root, 'fake-pi-helper.cjs');
  await writeFile(fakeEntry, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), credential: !!process.env.QQBOT_APP_ID && !!process.env.QQBOT_APP_SECRET }));');
  let output = '';
  await openGroupTerminal(cwd, {
    env: { ...process.env, PIQ_PI_ENTRY: fakeEntry, QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'test-helper' },
    prepareLaunch: async () => ({ token: 'helper-return-token' }),
    clearLaunch: async () => {},
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
    env: { PIQ_PI_ENTRY: fakeEntry, QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'test-only' },
    prepareLaunch: async () => ({ token: 'opening-return-token', alreadyRunning: preparations++ > 0 }),
    clearLaunch: async () => assert.fail('Successful opening must retain its return lease'),
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
    env: { PIQ_PI_ENTRY: fakeEntry, QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'test-only' },
    prepareLaunch: async () => ({ token: 'failed-window-token' }),
    clearLaunch: async (...args: [string, string?]) => { cancelled.push(args); },
    launch: async () => { throw new Error('fixture window failure'); },
  }), /fixture window failure/);
  assert.deepEqual(cancelled, [[f.cwd, 'failed-window-token']]);
});

test('an owner appearing after lease preparation prevents the terminal window', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const fakeEntry = join(f.root, 'fake-pi.cjs'); await writeFile(fakeEntry, '');
  const cancelled: unknown[] = [];
  const result = await openGroupTerminal(f.cwd, {
    env: { PIQ_PI_ENTRY: fakeEntry, QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'test-only' },
    prepareLaunch: async () => {
      await mkdir(join(f.cwd, '.piq'), { recursive: true });
      await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'new-owner' }));
      return { token: 'superseded-return-token' };
    },
    clearLaunch: async (...args: [string, string?]) => { cancelled.push(args); },
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
    env: { PIQ_PI_ENTRY: launcher, PIQ_TERMINAL_RETURN_TOKEN: 'nested-return-token', FIXTURE_REAL_PI_ENTRY: actualPi, FIXTURE_REAL_PI_REPORT: report,
      QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'synthetic-test-secret' },
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
  const fakeEntry = join(f.root, 'fast-pi.cjs'); await writeFile(fakeEntry, '');
  const env = { PIQ_PI_ENTRY: fakeEntry, QQBOT_APP_ID: 'synthetic-app-id', QQBOT_APP_SECRET: 'synthetic-test-secret' };
  let registered = false;
  assert.equal(await openGroup(f.cwd, [], { env, onSpawn: async () => { await delay(40); registered = true; } }), 0);
  assert.equal(registered, true);
  await writeFile(fakeEntry, 'setInterval(() => {}, 1000)');
  let childPid = 0;
  await assert.rejects(openGroup(f.cwd, [], { env, onSpawn: async pid => { childPid = pid; throw new Error('fixture registration failed'); } }), /fixture registration failed/);
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
  await openGroupTerminal(f.cwd, { freshSession: true,
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
  await assert.rejects(openGroupTerminal(f.cwd, { freshSession: true,
    env: { PIQ_PI_ENTRY: fakeEntry }, launch: async () => { throw new Error('window unavailable'); } }), /window unavailable/);
  assert.deepEqual(await readdir(join(f.cwd, '.pi', 'sessions')), [old.split(/[\\/]/).pop()]);
  assert.equal(SessionManager.continueRecent(f.cwd, join(f.cwd, '.pi', 'sessions')).getSessionFile(), old);
});

test('the terminal entry passes the selected session once and releases its marker on exit', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const lease = await prepareTerminalLaunch(f.cwd);
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
  const lease = await prepareTerminalLaunch(f.cwd);
  await terminalMain([f.cwd], { env: { PIQ_TERMINAL_RETURN_TOKEN: lease.token },
    open: async () => { await registerTerminal(f.cwd, lease.token, process.pid, child.pid); return 0; } });
  assert.deepEqual(await getTerminalLaunchStatus(f.cwd), { running: true, starting: false, pid: child.pid });
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8')).state, 'disabled');
  assert.equal((await prepareTerminalLaunch(f.cwd)).alreadyRunning, true);
  await finishTerminal(f.cwd, 'stale-token');
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8')).token, lease.token);
  await stop();
  await finishTerminal(f.cwd, lease.token);
  await assert.rejects(stat(join(f.cwd, '.piq', 'terminal-return.json')), { code: 'ENOENT' });
});
