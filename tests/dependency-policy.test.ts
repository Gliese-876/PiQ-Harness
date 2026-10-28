import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('QQ access pins the official SDK and retains its MIT notice without legacy or QR connectors', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const sdk = '@tencent-connect/qqbot-nodejs';
  assert.equal(manifest.dependencies?.[sdk], '1.0.5');
  assert.equal(lock.packages?.['']?.dependencies?.[sdk], '1.0.5');
  assert.equal(lock.packages?.[`node_modules/${sdk}`]?.version, '1.0.5');
  assert.equal(lock.packages?.[`node_modules/${sdk}`]?.license, 'MIT');
  const forbidden = (name: string) => name === '@tencent-connect/qqbot-connector'
    || name === '@tencent-connect/openclaw-qqbot' || name.startsWith('@snowluma/')
    || name.startsWith('@dsh/') || /(?:^|\/)(?:snowluma|onebot|dsh)(?:$|[-/])/i.test(name);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      assert.equal(forbidden(name), false, `${name} must not provide QQ protocol access`);
      if (typeof value === 'string' && value.startsWith('npm:')) {
        const alias = value.slice(4).replace(/@[^@/]*$/, '');
        assert.equal(forbidden(alias), false, `${name} must not alias a legacy or QR connector`);
      }
    }
  }
  for (const [location, entry] of Object.entries(lock.packages ?? {}) as Array<[string, { name?: string }]>) {
    const name = location.split('node_modules/').at(-1) ?? '';
    assert.equal(forbidden(name), false, location);
    if (entry.name) assert.equal(forbidden(entry.name), false, entry.name);
  }
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.ok(notices.includes(sdk));
  assert.ok(notices.includes('Copyright (c) 2026 Tencent'));
  assert.ok(notices.includes('The above copyright notice and this permission notice shall be included'));
});

test('recommended extensions remain external and are not loaded with the PiQ package', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const optionalPackages = ['@gotgenes/pi-permission-system', '@yuru7/pi-sandbox', 'pi-web-access', '@buyong/pi-codex-image-gen'];
  for (const name of optionalPackages) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      assert.equal(manifest[field]?.[name], undefined, `${name} must be installed independently`);
    }
    for (const [location, entry] of Object.entries(lock.packages ?? {}) as Array<[string, { name?: string }]>) {
      assert.ok(!location.endsWith(`node_modules/${name}`));
      assert.notEqual(entry.name, name);
    }
  }
  assert.ok(manifest.pi.extensions.every((path: string) => !path.includes('examples/integrations')),
    'the optional local policy is not a default PiQ extension');
});
