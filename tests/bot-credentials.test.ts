import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  ManagedCredentialError, managedCredentialNames, readManagedCredentials, saveManagedCredentials,
  type ManagedCredentialOptions,
} from '../src/bot-credentials.ts';
import { GroupStore } from '../src/store.ts';

type Storage = NonNullable<ManagedCredentialOptions['storage']>;
const secret = 'synthetic-app-secret-do-not-disclose';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function flushFileOperations(cwd: string) {
  // Allow earlier path lookups to finish while the simulated storage gate stays closed.
  for (let turn = 0; turn < 3; turn++) {
    await realpath(cwd);
    await new Promise<void>(done => setImmediate(done));
  }
}

const rejected = (status: number, privateValue?: string) => (error: unknown) => {
  assert.ok(error instanceof ManagedCredentialError);
  assert.equal(error.status, status);
  if (privateValue) {
    assert.ok(!error.message.includes(privateValue));
    assert.ok(!JSON.stringify(error).includes(privateValue));
  }
  return true;
};

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'bot-credentials-'));
  const cwd = join(root, 'group'); await mkdir(cwd);
  await writeFile(join(cwd, 'PIQ.md'), '# Existing configuration\n');
  await writeFile(join(cwd, 'PERSONA.md'), '# Existing persona\n');
  const links: string[] = [];
  t.after(async () => {
    for (const path of links) {
      try { if (process.platform === 'win32') await rmdir(path); else await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const canonical = await realpath(root), part = relative(await realpath(parent), canonical);
    assert.ok(part && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part));
    await rm(canonical, { recursive: true, force: true });
  });
  const names = await managedCredentialNames(cwd);
  const keys = [names.appIdEnv, names.appSecretEnv];
  const values = new Map<string, string>();
  const reads: string[][] = [], writes: Array<Record<string, string | undefined>> = [];
  const apply = (update: Readonly<Record<string, string | undefined>>) => {
    for (const [name, value] of Object.entries(update)) {
      if (value === undefined) values.delete(name); else values.set(name, value);
    }
  };
  const storage: Storage = {
    read: async requested => {
      reads.push([...requested]);
      return Object.fromEntries(requested.map(name => [name, values.get(name)]));
    },
    write: async update => { writes.push({ ...update }); apply(update); },
  };
  const options: ManagedCredentialOptions = { platform: 'win32', storage };
  async function bind(appId: string) {
    await mkdir(join(cwd, '.piq'), { recursive: true });
    await writeFile(join(cwd, '.piq', 'bot-account.json'), JSON.stringify({ version: 1, accountId: appId }));
  }
  return { root, cwd, names, keys, values, reads, writes, storage, options, apply, bind, links };
}

test('credential variable names are stable per real directory and distinct across groups', async t => {
  const f = await fixture(t);
  assert.match(f.names.appIdEnv, /^PIQ_BOT_[a-f0-9]{16}_APP_ID$/i);
  assert.equal(f.names.appSecretEnv, f.names.appIdEnv.replace(/_APP_ID$/, '_APP_SECRET'));
  assert.deepEqual(await managedCredentialNames(join(f.cwd, '.')), f.names);
  const sibling = join(f.root, 'other-group'); await mkdir(sibling);
  assert.notDeepEqual(await managedCredentialNames(sibling), f.names);
  if (process.platform === 'win32') assert.deepEqual(await managedCredentialNames(f.cwd.toUpperCase()), f.names);
});

test('directory aliases resolve to the same credential names', async t => {
  const f = await fixture(t), alias = join(f.root, 'alias');
  try { await symlink(f.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    t.skip('The operating system sandbox does not permit directory aliases.'); return;
  }
  f.links.push(alias);
  assert.deepEqual(await managedCredentialNames(alias), f.names);
});

test('first save persists only the selected keys and exposes safe metadata without changing project files or process environment', async t => {
  const f = await fixture(t);
  const beforeEnvironment = f.keys.map(key => process.env[key]);
  const beforeFiles = await readdir(f.cwd);
  const input = Object.freeze({ appId: ' APP_ID_123 ', appSecret: ` ${secret} ` });
  const result = await saveManagedCredentials(f.cwd, input, f.options);
  assert.deepEqual(result, { appId: 'APP_ID_123', hasSecret: true, available: true });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(f.values.get(f.names.appIdEnv), 'APP_ID_123');
  assert.equal(f.values.get(f.names.appSecretEnv), secret);
  assert.deepEqual([...f.values.keys()].sort(), [...f.keys].sort());
  assert.ok(f.reads.every(names => names.length === 2 && names.every(name => f.keys.includes(name))));
  assert.ok(f.writes.every(update => Object.keys(update).length === 2 && Object.keys(update).every(name => f.keys.includes(name))));
  assert.deepEqual(f.keys.map(key => process.env[key]), beforeEnvironment);
  assert.deepEqual(await readdir(f.cwd), beforeFiles);
  assert.equal(await readFile(join(f.cwd, 'PIQ.md'), 'utf8'), '# Existing configuration\n');
  assert.equal(await readFile(join(f.cwd, 'PERSONA.md'), 'utf8'), '# Existing persona\n');
  assert.deepEqual(input, { appId: ' APP_ID_123 ', appSecret: ` ${secret} ` });
});

test('internal reads return the saved secret while missing values produce an unavailable state', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readManagedCredentials(f.cwd, f.options), { appId: '', hasSecret: false, available: false });
  f.values.set(f.names.appIdEnv, 'APP_ID_A');
  assert.deepEqual(await readManagedCredentials(f.cwd, f.options), { appId: 'APP_ID_A', hasSecret: false, available: false });
  f.values.set(f.names.appSecretEnv, secret);
  const result = await readManagedCredentials(f.cwd, f.options);
  assert.equal(result.appId, 'APP_ID_A'); assert.equal(result.appSecret, secret);
  assert.equal(result.hasSecret, true); assert.equal(result.available, true);
  assert.equal(f.writes.length, 0);
});

test('blank secret preserves an existing secret only for the same application', async t => {
  const f = await fixture(t);
  await saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, f.options);
  for (const appSecret of [undefined, '', '   ']) {
    assert.deepEqual(await saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret }, f.options),
      { appId: 'APP_ID_A', hasSecret: true, available: true });
    assert.equal(f.values.get(f.names.appSecretEnv), secret);
  }
  const calls = f.writes.length;
  for (const appSecret of [undefined, '', '   ']) {
    await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_B', appSecret }, f.options), error => {
      assert.ok(error instanceof ManagedCredentialError); assert.ok([400, 409].includes(error.status)); return true;
    });
  }
  assert.equal(f.writes.length, calls);
  assert.equal(f.values.get(f.names.appIdEnv), 'APP_ID_A');
  await saveManagedCredentials(f.cwd, { appId: 'APP_ID_B', appSecret: 'new-synthetic-secret' }, f.options);
  assert.equal(f.values.get(f.names.appIdEnv), 'APP_ID_B');
  assert.equal(f.values.get(f.names.appSecretEnv), 'new-synthetic-secret');
});

test('the first save requires both fields and validates their bounded contents before writing', async t => {
  const f = await fixture(t);
  for (const appSecret of [undefined, '', '   ']) {
    await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret }, f.options), rejected(400));
  }
  for (const appId of ['', 'bad/id', 'bad:id', 'app\nid', 'a'.repeat(129)]) {
    await assert.rejects(saveManagedCredentials(f.cwd, { appId, appSecret: secret }, f.options), rejected(400, secret));
  }
  for (const appSecret of [secret + '\n', secret + '\0', secret + '\t', secret + '\x7f', 's'.repeat(4097)]) {
    await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret }, f.options), rejected(400, secret));
  }
  assert.equal(f.writes.length, 0); assert.equal(f.values.size, 0);
});

test('a stored account binding prevents changing applications while allowing secret rotation', async t => {
  const f = await fixture(t);
  await f.bind('APP_ID_A');
  await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_B', appSecret: secret }, f.options), rejected(409, secret));
  assert.equal(f.writes.length, 0);
  assert.deepEqual(await saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, f.options),
    { appId: 'APP_ID_A', hasSecret: true, available: true });
});

test('a binding created by the real group store permits secret rotation for its own application only', async t => {
  const f = await fixture(t);
  const store = await GroupStore.open(f.cwd, {
    id: 'credential-binding', conversations: [{ type: 'group', id: 'GROUP_OpenID_123' }],
  }, 'APP_ID_A');
  await store.close();
  const filename = join(f.cwd, '.piq', 'bot-account.json'), binding = await readFile(filename);
  await saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, f.options);
  const rotated = 'rotated-synthetic-secret';
  assert.deepEqual(await saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: rotated }, f.options),
    { appId: 'APP_ID_A', hasSecret: true, available: true });
  const writes = f.writes.length;
  await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_B', appSecret: 'other-synthetic-secret' }, f.options),
    rejected(409));
  assert.equal(f.writes.length, writes);
  assert.equal(f.values.get(f.names.appIdEnv), 'APP_ID_A');
  assert.equal(f.values.get(f.names.appSecretEnv), rotated);
  assert.deepEqual(await readFile(filename), binding);
});

test('a binding created during credential lookup is rechecked before saving', async t => {
  const f = await fixture(t), read = f.storage.read;
  f.storage.read = async names => { await f.bind('DIFFERENT_APP_ID'); return read(names); };
  await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, f.options), rejected(409, secret));
  assert.equal(f.writes.length, 0);
});

test('a malformed account binding fails safely and leaves all credential values untouched', async t => {
  const f = await fixture(t), privateValue = 'PRIVATE_BROKEN_BINDING_CONTENT';
  await mkdir(join(f.cwd, '.piq'));
  await writeFile(join(f.cwd, '.piq', 'bot-account.json'), '{' + privateValue);
  await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, f.options), rejected(409, privateValue));
  assert.equal(f.writes.length, 0);
  assert.equal(await readFile(join(f.cwd, '.piq', 'bot-account.json'), 'utf8'), '{' + privateValue);
});

test('account bindings reject unknown fields without accepting or changing saved credentials', async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, '.piq'));
  const filename = join(f.cwd, '.piq', 'bot-account.json');
  const binding = JSON.stringify({ version: 1, accountId: 'APP_ID_A', unexpected: 'synthetic-extra-field' });
  await writeFile(filename, binding);
  await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, f.options), rejected(409, secret));
  assert.equal(f.writes.length, 0);
  assert.equal(await readFile(filename, 'utf8'), binding);
});

for (const existing of [false, true]) {
  test(`a partial write failure restores ${existing ? 'both previous values' : 'the originally absent keys'}`, async t => {
    const f = await fixture(t);
    if (existing) {
      f.values.set(f.names.appIdEnv, 'OLD_APP_ID'); f.values.set(f.names.appSecretEnv, 'old-synthetic-secret');
    }
    const before = new Map(f.values), privateValue = 'SYNTHETIC_WRITER_FAILURE_SECRET';
    f.storage.write = async update => {
      f.writes.push({ ...update });
      if (f.writes.length === 1) {
        const value = update[f.names.appIdEnv];
        if (value === undefined) f.values.delete(f.names.appIdEnv); else f.values.set(f.names.appIdEnv, value);
        throw new Error(privateValue);
      }
      f.apply(update);
    };
    await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'NEW_APP_ID', appSecret: secret }, f.options), rejected(500, privateValue));
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.values, before);
    assert.deepEqual(Object.keys(f.writes[1]!).sort(), [...f.keys].sort());
  });
}

test('rollback failure is reported safely instead of claiming a successful save', async t => {
  const f = await fixture(t), privateValue = 'SYNTHETIC_ROLLBACK_FAILURE_SECRET';
  f.storage.write = async update => { f.writes.push({ ...update }); throw new Error(privateValue); };
  await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, f.options), rejected(500, privateValue));
  assert.equal(f.writes.length, 2);
});

test('storage read failures are safe for both metadata lookup and saving', async t => {
  const f = await fixture(t), privateValue = 'SYNTHETIC_READER_FAILURE_SECRET';
  f.storage.read = async () => { throw new Error(privateValue); };
  await assert.rejects(readManagedCredentials(f.cwd, f.options), rejected(500, privateValue));
  await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, f.options), rejected(500, privateValue));
  assert.equal(f.writes.length, 0);
});

test('non-Windows metadata stays empty and saving explicitly declines without touching storage', async t => {
  const f = await fixture(t);
  const options: ManagedCredentialOptions = { ...f.options, platform: 'linux' };
  assert.deepEqual(await readManagedCredentials(f.cwd, options), { appId: '', hasSecret: false, available: false });
  await assert.rejects(saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: secret }, options), error => {
    rejected(501, secret)(error);
    assert.match((error as ManagedCredentialError).message, /Windows\s*工作台/);
    assert.doesNotMatch((error as ManagedCredentialError).message, /手动|环境变量/);
    return true;
  });
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});

test('saving waits for an in-progress read to return the complete previous credential pair', async t => {
  const f = await fixture(t), readId = deferred(), releaseRead = deferred(), saveReady = deferred();
  f.values.set(f.names.appIdEnv, 'OLD_APP_ID');
  f.values.set(f.names.appSecretEnv, 'old-synthetic-secret');
  const readStorage = f.storage.read, writeStorage = f.storage.write;
  const events: string[] = [];
  let readingFirst = true;
  f.storage.read = async names => {
    if (!readingFirst) { events.push('save:read'); return readStorage(names); }
    readingFirst = false;
    f.reads.push([...names]);
    const id = f.values.get(f.names.appIdEnv);
    events.push('read:id'); readId.resolve();
    await releaseRead.promise;
    events.push('read:secret');
    return { [f.names.appIdEnv]: id, [f.names.appSecretEnv]: f.values.get(f.names.appSecretEnv) };
  };
  f.storage.write = async values => { events.push('save:write'); await writeStorage(values); };
  const reading = readManagedCredentials(f.cwd, f.options);
  await readId.promise;
  const saveOptions: ManagedCredentialOptions = {
    platform: 'win32', get storage() { saveReady.resolve(); return f.storage; },
  };
  const saving = saveManagedCredentials(f.cwd, { appId: 'NEW_APP_ID', appSecret: 'new-synthetic-secret' }, saveOptions);
  try {
    await saveReady.promise;
    await flushFileOperations(f.cwd);
    assert.deepEqual(events, ['read:id']);
    assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 0);
  } finally {
    releaseRead.resolve();
    await Promise.allSettled([reading, saving]);
  }
  assert.deepEqual(await reading, { appId: 'OLD_APP_ID', appSecret: 'old-synthetic-secret', hasSecret: true, available: true });
  assert.deepEqual(await saving, { appId: 'NEW_APP_ID', hasSecret: true, available: true });
  assert.deepEqual(events, ['read:id', 'read:secret', 'save:read', 'save:write']);
  assert.equal(f.values.get(f.names.appIdEnv), 'NEW_APP_ID');
  assert.equal(f.values.get(f.names.appSecretEnv), 'new-synthetic-secret');
});

test('reading waits until a partially written credential pair has fully committed', async t => {
  const f = await fixture(t), wroteId = deferred(), releaseWrite = deferred();
  f.values.set(f.names.appIdEnv, 'OLD_APP_ID');
  f.values.set(f.names.appSecretEnv, 'old-synthetic-secret');
  f.storage.write = async values => {
    f.writes.push({ ...values });
    f.values.set(f.names.appIdEnv, values[f.names.appIdEnv]!);
    wroteId.resolve();
    await releaseWrite.promise;
    f.values.set(f.names.appSecretEnv, values[f.names.appSecretEnv]!);
  };
  const saving = saveManagedCredentials(f.cwd, { appId: 'NEW_APP_ID', appSecret: 'new-synthetic-secret' }, f.options);
  await wroteId.promise;
  let readSettled = false;
  const reading = readManagedCredentials(f.cwd, f.options).then(value => { readSettled = true; return value; });
  try {
    await flushFileOperations(f.cwd);
    assert.equal(readSettled, false);
    assert.equal(f.reads.length, 1);
    assert.equal(f.values.get(f.names.appIdEnv), 'NEW_APP_ID');
    assert.equal(f.values.get(f.names.appSecretEnv), 'old-synthetic-secret');
  } finally {
    releaseWrite.resolve();
    await Promise.allSettled([reading, saving]);
  }
  await saving;
  assert.deepEqual(await reading, { appId: 'NEW_APP_ID', appSecret: 'new-synthetic-secret', hasSecret: true, available: true });
  assert.equal(f.reads.length, 2); assert.equal(f.writes.length, 1);
});

test('concurrent saves for one directory preserve the selected application and secret as a pair', async t => {
  const f = await fixture(t), originalWrite = f.storage.write;
  let active = 0, peak = 0;
  f.storage.write = async update => {
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
      await originalWrite(update);
    } finally { active--; }
  };
  await Promise.all([
    saveManagedCredentials(f.cwd, { appId: 'APP_ID_A', appSecret: 'secret-a' }, f.options),
    saveManagedCredentials(f.cwd, { appId: 'APP_ID_B', appSecret: 'secret-b' }, f.options),
  ]);
  assert.equal(peak, 1);
  assert.equal(f.writes.length, 2);
  const finalAppId = f.values.get(f.names.appIdEnv);
  assert.ok(finalAppId === 'APP_ID_A' || finalAppId === 'APP_ID_B');
  assert.equal(f.values.get(f.names.appSecretEnv), finalAppId === 'APP_ID_A' ? 'secret-a' : 'secret-b');
  assert.equal(finalAppId, f.writes.at(-1)![f.names.appIdEnv]);
});
