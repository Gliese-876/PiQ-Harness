import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { groupTemporaryEnvironment, openGroup } from '../src/cli.ts';
import { initializeGroup } from '../src/config.ts';
import { openGroupTerminal, type TerminalLaunch } from '../src/web-terminal.ts';

const temporaryKeys = (env: NodeJS.ProcessEnv) => Object.keys(env).filter(key => /^(?:temp|tmp|tmpdir)$/i.test(key)).sort();
const parentTemporaryValues = () => Object.fromEntries(temporaryKeys(process.env).map(key => [key, process.env[key]]));

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'temporary-environment-'));
  const cwd = await initializeGroup(root, 'friends', { name: 'Friends', conversations: [{ type: 'group', id: '123456' }] });
  const fakeEntry = join(root, 'fake-pi.mjs');
  await writeFile(fakeEntry, [
    "import { writeFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "import { tmpdir } from 'node:os';",
    "const values = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:temp|tmp|tmpdir)$/i.test(key)));",
    "await writeFile(join(tmpdir(), 'created-by-fake-pi.txt'), 'temporary output');",
    "await writeFile(process.argv.at(-1), JSON.stringify({ values, cwd: process.cwd(), temporaryDirectory: tmpdir() }));",
  ].join('\n'));
  const links: string[] = [];
  t.after(async () => {
    for (const path of links) {
      try { if (process.platform === 'win32') await rmdir(path); else await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!resolve(root).startsWith(parent + sep)) throw new Error('Temporary cleanup must stay in the test directory.');
    await rm(root, { recursive: true, force: true });
  });
  const env = { PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'synthetic-test-token', Temp: 'old-temp', tMp: 'old-tmp', tmpDIR: 'old-tmpdir' };
  return { root, cwd, fakeEntry, env, links, temporary: join(cwd, '.tmp') };
}

test('temporary environment normalizes mixed-case variables without mutating either parent', async t => {
  const f = await fixture(t);
  const input = Object.freeze({ Temp: 'host-temp', tMp: 'host-tmp', tmpDIR: 'host-tmpdir', PIQ_TEST_UNRELATED: 'keep-me' });
  const before = { ...input };
  const parentBefore = parentTemporaryValues();
  const result = await groupTemporaryEnvironment(f.cwd, input);
  assert.notEqual(result, input);
  assert.deepEqual(input, before);
  assert.deepEqual(parentTemporaryValues(), parentBefore);
  assert.deepEqual(temporaryKeys(result), ['TEMP', 'TMP', 'TMPDIR']);
  assert.equal(result.TEMP, f.temporary); assert.equal(result.TMP, f.temporary); assert.equal(result.TMPDIR, f.temporary);
  assert.equal(result.PIQ_TEST_UNRELATED, 'keep-me');
  assert.equal((await stat(f.temporary)).isDirectory(), true);
  assert.equal((await groupTemporaryEnvironment(f.cwd, input)).TMP, f.temporary, 'an existing ordinary directory is reusable');
});

test('default temporary environment copies process settings without changing the current process', async t => {
  const f = await fixture(t);
  const parentBefore = parentTemporaryValues();
  const result = await groupTemporaryEnvironment(f.cwd);
  assert.notEqual(result, process.env);
  assert.deepEqual(parentTemporaryValues(), parentBefore);
  assert.deepEqual(temporaryKeys(result), ['TEMP', 'TMP', 'TMPDIR']);
  assert.equal(result.TEMP, f.temporary); assert.equal(result.TMP, f.temporary); assert.equal(result.TMPDIR, f.temporary);
});

test('the CLI child receives only its group temporary directory and creates temporary output there', async t => {
  const f = await fixture(t);
  const inputBefore = { ...f.env };
  const parentBefore = parentTemporaryValues();
  const output = join(f.cwd, 'fake-pi-environment.json');
  assert.equal(await openGroup(f.cwd, ['--test-output', output], { env: f.env }), 0);
  const child = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(child.cwd, f.cwd);
  assert.deepEqual(child.values, { TEMP: f.temporary, TMP: f.temporary, TMPDIR: f.temporary });
  assert.equal(child.temporaryDirectory, f.temporary);
  assert.equal(await readFile(join(f.temporary, 'created-by-fake-pi.txt'), 'utf8'), 'temporary output');
  assert.deepEqual(f.env, inputBefore);
  assert.deepEqual(parentTemporaryValues(), parentBefore);
});

test('the WebUI terminal launch receives its group temporary directory without changing the caller', async t => {
  const f = await fixture(t);
  const inputBefore = { ...f.env };
  const parentBefore = parentTemporaryValues();
  const launches: TerminalLaunch[] = [];
  await openGroupTerminal(f.cwd, { env: f.env, launch: async specification => { launches.push(specification); } });
  assert.equal(launches.length, 1);
  const env = launches[0]!.env;
  assert.deepEqual(temporaryKeys(env), ['TEMP', 'TMP', 'TMPDIR']);
  assert.equal(env.TEMP, f.temporary); assert.equal(env.TMP, f.temporary); assert.equal(env.TMPDIR, f.temporary);
  assert.equal((await stat(f.temporary)).isDirectory(), true);
  assert.deepEqual(f.env, inputBefore);
  assert.deepEqual(parentTemporaryValues(), parentBefore);
});

async function refusesBeforeLaunch(cwd: string, env: NodeJS.ProcessEnv) {
  let children = 0;
  await assert.rejects(groupTemporaryEnvironment(cwd, env));
  await assert.rejects(openGroup(cwd, [], { env, onSpawn: () => { children++; } }));
  await assert.rejects(openGroupTerminal(cwd, { env, launch: async () => { children++; } }));
  assert.equal(children, 0, 'invalid temporary storage must fail before starting any process');
}

test('a regular file at .tmp is preserved and prevents both launch paths', async t => {
  const f = await fixture(t);
  await writeFile(f.temporary, 'keep-existing-file');
  await refusesBeforeLaunch(f.cwd, f.env);
  assert.equal(await readFile(f.temporary, 'utf8'), 'keep-existing-file');
});

for (const external of [true, false]) {
  test((external ? 'outside' : 'inside') + '-group directory links cannot replace the temporary directory', async t => {
    const f = await fixture(t);
    const target = join(external ? f.root : f.cwd, 'linked-temporary-target');
    await mkdir(target);
    await writeFile(join(target, 'sentinel.txt'), 'keep-linked-target');
    try { await symlink(target, f.temporary, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      t.skip('The operating system does not permit directory links.'); return;
    }
    f.links.push(f.temporary);
    await refusesBeforeLaunch(f.cwd, f.env);
    assert.equal(await readFile(join(target, 'sentinel.txt'), 'utf8'), 'keep-linked-target');
  });
}
