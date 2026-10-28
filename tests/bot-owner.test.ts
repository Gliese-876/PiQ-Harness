import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { claimBotAccount } from '../src/bot-owner.ts';

const syntheticApp = 'synthetic-bot-account';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'bot-owner-'));
  t.after(async () => {
    const part = relative(parent, cwd);
    assert.ok(part && !part.startsWith('..'));
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, options: { namespace: `test-${randomUUID()}` } };
}

async function script(cwd: string, source: string): Promise<string> {
  const path = join(cwd, `child-${randomUUID()}.mjs`);
  const moduleUrl = pathToFileURL(resolve('src/bot-owner.ts')).href;
  await writeFile(path, `import { claimBotAccount } from ${JSON.stringify(moduleUrl)};\n${source}\n`);
  return path;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

async function waitForReady(child: ChildProcess): Promise<void> {
  await Promise.race([
    once(child.stdout!, 'data').then(([data]) => { assert.match(String(data), /ready/); }),
    once(child, 'exit').then(() => { throw new Error('The simulated socket owner exited before claiming its account.'); }),
  ]);
}

test('one synthetic account can be claimed once and reclaimed after idempotent release', async t => {
  const f = await fixture(t);
  const release = await claimBotAccount(syntheticApp, f.options);
  t.after(release);
  await assert.rejects(claimBotAccount(syntheticApp, f.options), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /同一 AppID.*运行/);
    assert.doesNotMatch(error.message, /synthetic-bot-account|piq-qqbot-|pipe|test-/);
    return true;
  });
  await Promise.all([release(), release()]);
  await release();
  const secondRelease = await claimBotAccount(syntheticApp, f.options);
  await secondRelease();
});

test('different application IDs and isolated namespaces can coexist', async t => {
  const f = await fixture(t);
  const releases: Array<() => Promise<void>> = [];
  t.after(async () => { await Promise.all(releases.map(release => release())); });
  releases.push(await claimBotAccount(syntheticApp, f.options));
  releases.push(await claimBotAccount('another-synthetic-account', f.options));
  releases.push(await claimBotAccount(syntheticApp, { namespace: `other-test-${randomUUID()}` }));
});

test('an owner in another process prevents a second claim until it releases', async t => {
  const f = await fixture(t);
  const entry = await script(f.cwd, [
    `const release = await claimBotAccount(${JSON.stringify(syntheticApp)}, ${JSON.stringify(f.options)});`,
    'process.stdout.write("ready\\n");',
    'process.stdin.once("data", async () => { await release(); process.stdin.pause(); });',
  ].join('\n'));
  const child = spawn(process.execPath, [entry], { cwd: f.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => stopChild(child));
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
  t.after(() => clearTimeout(timeout));
  let stderr = '';
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr += chunk; });
  await waitForReady(child);
  await assert.rejects(claimBotAccount(syntheticApp, f.options), /同一 AppID/);
  const exited = once(child, 'exit');
  child.stdin!.end('release\n');
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  const release = await claimBotAccount(syntheticApp, f.options);
  await release();
});

test('the ownership marker does not keep its process alive and is released at exit', {
  skip: process.platform !== 'win32' && process.platform !== 'linux' ? 'Filesystem sockets require an explicit release.' : false,
}, async t => {
  const f = await fixture(t);
  const entry = await script(f.cwd, [
    `await claimBotAccount(${JSON.stringify(syntheticApp)}, ${JSON.stringify(f.options)});`,
    'process.stdout.write("claimed\\n");',
  ].join('\n'));
  const child = spawnSync(process.execPath, [entry], { cwd: f.cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /claimed/);
  const release = await claimBotAccount(syntheticApp, f.options);
  await release();
});

test('Windows and Linux release ownership when a process is killed', {
  skip: process.platform !== 'win32' && process.platform !== 'linux' ? 'Filesystem sockets retain a marker after an abrupt exit.' : false,
}, async t => {
  const f = await fixture(t);
  const entry = await script(f.cwd, [
    `await claimBotAccount(${JSON.stringify(syntheticApp)}, ${JSON.stringify(f.options)});`,
    'setInterval(() => {}, 1_000);',
    'process.stdout.write("ready\\n");',
  ].join('\n'));
  const child = spawn(process.execPath, [entry], { cwd: f.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => stopChild(child));
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
  t.after(() => clearTimeout(timeout));
  await waitForReady(child);
  await assert.rejects(claimBotAccount(syntheticApp, f.options), /同一 AppID/);
  await stopChild(child);
  const release = await claimBotAccount(syntheticApp, f.options);
  await release();
});

test('invalid identifiers fail without exposing supplied text', async t => {
  const f = await fixture(t);
  for (const input of ['', 'private-app-id\n', 'private app id', 'x'.repeat(513)]) {
    await assert.rejects(claimBotAccount(input, f.options), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /有效.*AppID/);
      assert.doesNotMatch(error.message, /private-app/);
      return true;
    });
  }
});
