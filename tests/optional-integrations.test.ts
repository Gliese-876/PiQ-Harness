import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import noEscalation from '../examples/integrations/no-escalation.ts';

type Hook = (event: { toolName: string; input: unknown }) => { block: boolean; reason: string } | undefined;
function hooks(): Map<string, unknown> {
  const handlers = new Map<string, unknown>();
  noEscalation({ on(name: string, callback: unknown) {
    handlers.set(name, callback);
  } } as unknown as ExtensionAPI);
  return handlers;
}
function policy(): Hook {
  const hook = hooks().get('tool_call') as Hook | undefined;
  assert.ok(hook);
  return hook;
}

test('optional local policy blocks directory grants and unrestricted retries for every tool', () => {
  const check = policy();
  assert.equal(check({ toolName: 'sandbox_grant_write', input: { path: 'C:/outside' } })?.block, true);
  for (const toolName of ['powershell', 'write', 'edit', 'another_extension']) {
    for (const sandbox_permissions of ['danger-full-access', ' danger-full-access ']) {
      const result = check({ toolName, input: { sandbox_permissions, justification: 'a retry' } });
      assert.equal(result?.block, true, toolName);
    }
  }
});

test('optional local policy leaves ordinary calls and confined retries to the external engines', () => {
  const check = policy();
  for (const input of [undefined, null, {}, { path: 'assets/file.txt' },
    { sandbox_permissions: null }, { sandbox_permissions: 'workspace-write' }]) {
    assert.equal(check({ toolName: 'write', input }), undefined);
  }
});

test('Windows optional policy uses the group root for temporary files and restores its process environment', { skip: process.platform !== 'win32' }, async () => {
  const variables = ['TEMP', 'TMP', 'TMPDIR'] as const;
  const original = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'optional-temp-'));
  const handlers = hooks();
  const start = handlers.get('session_start') as (event: unknown, ctx: { cwd: string }) => Promise<void>;
  const stop = handlers.get('session_shutdown') as () => void;
  try {
    const prior = join(cwd, '.tmp');
    process.env.TEMP = prior;
    process.env.TMP = prior;
    delete process.env.TMPDIR;
    const snapshot = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    await start({}, { cwd: join(cwd, '.') });
    for (const name of variables) assert.equal(process.env[name], await realpath(cwd));
    await start({}, { cwd });
    // A later component's choice must not be replaced on shutdown.
    process.env.TMP = join(cwd, 'later-choice');
    stop();
    assert.equal(process.env.TEMP, snapshot.TEMP);
    assert.equal(process.env.TMP, join(cwd, 'later-choice'));
    assert.equal(process.env.TMPDIR, snapshot.TMPDIR);
    stop();
    assert.equal(process.env.TMP, join(cwd, 'later-choice'));
  } finally {
    for (const name of variables) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    if (!resolve(cwd).startsWith(parent + sep)) throw new Error('Invalid test cleanup path');
    await rm(cwd, { recursive: true, force: true });
  }
});
