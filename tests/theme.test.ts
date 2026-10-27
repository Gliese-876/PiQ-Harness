import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../web/theme.js', import.meta.url), 'utf8');
function browser(saved: string | null = null, dark = true, unavailableStorage = false, legacyMedia = false) {
  const storage = new Map<string, string>();
  if (saved !== null) storage.set('piq:theme', saved);
  const documentListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, (event: { key: string | null; newValue: string | null }) => void>();
  const selectListeners = new Map<string, () => void>();
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  let loaded = false;
  let systemChanged = () => {};
  const select = { value: '', addEventListener(name: string, callback: () => void) { selectListeners.set(name, callback); } };
  const query = { matches: dark, ...(legacyMedia ? { addListener(callback: () => void) { systemChanged = callback; } }
    : { addEventListener(_name: string, callback: () => void) { systemChanged = callback; } }) };
  runInNewContext(source, {
    document: { documentElement: root, getElementById() { return loaded ? select : null; }, addEventListener(name: string, callback: () => void) { documentListeners.set(name, callback); } },
    window: { matchMedia: () => query, addEventListener(name: string, callback: (event: { key: string | null; newValue: string | null }) => void) { windowListeners.set(name, callback); } },
    localStorage: { getItem(key: string) { if (unavailableStorage) throw new Error('Storage disabled'); return storage.get(key) ?? null; }, setItem(key: string, value: string) { if (unavailableStorage) throw new Error('Storage disabled'); storage.set(key, value); } },
  });
  return {
    root, storage, select,
    load() { loaded = true; documentListeners.get('DOMContentLoaded')!(); },
    choose(value: string) { select.value = value; selectListeners.get('change')!(); },
    system(value: boolean) { query.matches = value; systemChanged(); },
    external(value: string | null, key: string | null = 'piq:theme') { windowListeners.get('storage')!({ key, newValue: value }); },
  };
}

test('first visits follow the system before DOM readiness and preserve saved choices', () => {
  for (const dark of [false, true]) {
    const fresh = browser(null, dark);
    assert.equal(fresh.root.dataset.themeMode, 'system');
    assert.equal(fresh.root.dataset.theme, dark ? 'dark' : 'light');
    assert.equal(fresh.root.style.colorScheme, dark ? 'dark' : 'light');
    fresh.load();
    assert.equal(fresh.select.value, 'system');
    const invalid = browser('removed-theme', dark);
    assert.equal(invalid.root.dataset.themeMode, 'system');
    assert.equal(invalid.root.dataset.theme, dark ? 'dark' : 'light');
  }
  for (const saved of ['light', 'dark', 'system']) {
    const page = browser(saved, true);
    assert.equal(page.root.dataset.theme, saved === 'system' ? 'dark' : saved);
    page.load();
    assert.equal(page.select.value, saved);
  }
});

test('every selectable palette persists, survives reload and sets native form color scheme', () => {
  const page = browser(); page.load();
  for (const palette of ['midnight', 'rose', 'paper', 'light', 'dark']) {
    page.choose(palette);
    assert.equal(page.storage.get('piq:theme'), palette);
    assert.equal(page.root.dataset.theme, palette);
    assert.equal(page.root.style.colorScheme, ['light', 'paper'].includes(palette) ? 'light' : 'dark');
    assert.equal(browser(page.storage.get('piq:theme')!).root.dataset.theme, palette);
  }
});

test('system changes affect only system mode, including legacy matchMedia listeners', () => {
  for (const legacy of [false, true]) {
    const page = browser('system', false, false, legacy); page.load();
    assert.equal(page.root.dataset.theme, 'light');
    page.system(true); assert.equal(page.root.dataset.theme, 'dark');
    page.choose('rose'); page.system(false); assert.equal(page.root.dataset.theme, 'rose');
    page.choose('system'); assert.equal(page.root.dataset.theme, 'light');
  }
});

test('cross-tab changes, cleared storage and unavailable storage remain usable', () => {
  const page = browser(null, false); page.load();
  page.external('paper'); assert.equal(page.root.dataset.theme, 'paper'); assert.equal(page.select.value, 'paper');
  page.external('invalid'); assert.equal(page.root.dataset.theme, 'light'); assert.equal(page.select.value, 'system');
  page.system(true); assert.equal(page.root.dataset.theme, 'dark');
  page.external('rose'); page.external(null, null); assert.equal(page.root.dataset.theme, 'dark'); assert.equal(page.select.value, 'system');
  page.system(false); assert.equal(page.root.dataset.theme, 'light');
  page.external('rose', 'unrelated'); assert.equal(page.root.dataset.theme, 'light');
  page.external('rose'); page.external(null); assert.equal(page.select.value, 'system'); assert.equal(page.root.dataset.theme, 'light');
  const blocked = browser('dark', false, true); blocked.load();
  assert.equal(blocked.root.dataset.theme, 'light'); assert.equal(blocked.select.value, 'system');
  blocked.choose('midnight');
  assert.equal(blocked.root.dataset.theme, 'midnight');
  blocked.choose('invalid'); assert.equal(blocked.select.value, 'system'); assert.equal(blocked.root.dataset.theme, 'light');
});

test('the selector exposes every palette and initializes before the stylesheet', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const palette of ['system', 'light', 'dark', 'midnight', 'rose', 'paper']) assert.ok(html.includes('value="' + palette + '"'));
  assert.ok(html.indexOf('/theme.js') < html.indexOf('/style.css'), 'palette selection precedes first styled paint');
});
