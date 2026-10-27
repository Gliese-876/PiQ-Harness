import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const script = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const source = script.slice(0, script.indexOf("$('rename-group').addEventListener"));

class Element {
  tagName: string;
  children: Element[] = [];
  value = ''; hidden = false; disabled = false; open = false; className = ''; title = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (...args: unknown[]) => unknown>();
  private ownText = '';
  classList = { toggle() {}, remove() {}, add() {} };
  constructor(tag = 'div') { this.tagName = tag; }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('HTML injection is not allowed'); }
  get options() { return this.children; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; this.ownText = ''; }
  querySelectorAll() { return []; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, handler: (...args: unknown[]) => unknown) { this.listeners.set(name, handler); }
  contains() { return false; }
  reportValidity() { return true; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function page() {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const requests: Array<{ path: string; options: RequestInit }> = [];
  const prompts: Array<string | null> = [];
  const confirmations: string[] = [];
  let confirmed = true;
  let responder = async (_path: string, _options: RequestInit): Promise<unknown> => ({});
  const context = createContext({
    URL, console,
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), querySelectorAll: () => [] },
    window: {
      prompt: () => prompts.shift() ?? null,
      confirm: (message: string) => { confirmations.push(message); return confirmed; },
    },
    localStorage: { setItem() {}, removeItem() {} },
    fetch: async (path: string, options: RequestInit) => {
      requests.push({ path, options });
      const result = await responder(path, options);
      return { ok: true, json: async () => result };
    },
  });
  const run = (code: string) => runInContext(code, context);
  run(source);
  run(`state.selected='one'; state.detail={config:{id:'one',name:'原组',conversations:[{type:'group',id:'123456'}]},configRevision:'revision-1'};
    state.configRevision='revision-1'; state.groups=[{id:'one',name:'原组',running:false,conversations:[{type:'group',id:'123456'}]}];
    state.configText=JSON.stringify(connectionFields()); state.csrfToken='test-token';`);
  return {
    get, run, requests, prompts, confirmations,
    confirm(value: boolean) { confirmed = value; },
    respond(callback: typeof responder) { responder = callback; },
  };
}

test('the primary start action opens a terminal and live sessions retain pause and stop controls', async () => {
  const ui = page();
  ui.run('renderRunStatus(); refreshState=async()=>{};');
  assert.equal(ui.get('run-action').textContent, '打开 Pi 终端');
  assert.equal(ui.get('open-terminal').hidden, true);
  assert.equal(ui.get('run-action').disabled, false);
  await ui.run("controlRun('start')");
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0]!.path, '/api/groups/one/open');
  assert.match(ui.get('notice').textContent, /关闭终端即停止/);
  ui.run("state.groups[0].running=true; state.groups[0].runtime={mode:'terminal',paused:false}; renderRunStatus();");
  assert.equal(ui.get('run-action').textContent, '暂停');
  assert.equal(ui.get('stop-run').hidden, false);
  assert.equal(ui.get('open-terminal').hidden, false);
  assert.match(ui.get('terminal-note').textContent, /关闭终端即停止/);
  ui.run('state.groups[0].runtime.paused=true; renderRunStatus();');
  assert.equal(ui.get('run-action').textContent, '恢复运行');
});

test('a running group can be renamed with its revision but cannot be deleted', async () => {
  const ui = page();
  ui.run('state.groups[0].running=true; renderRunStatus();');
  assert.equal(ui.get('rename-group').disabled, false);
  assert.equal(ui.get('delete-group').disabled, true);
  await ui.run("manageGroup('delete')");
  assert.equal(ui.requests.length, 0);
  ui.prompts.push('新名称');
  ui.respond(async () => ({ config: { id: 'one', name: '新名称', conversations: [{ type: 'group', id: '123456' }] }, revision: 'revision-2' }));
  await ui.run("manageGroup('rename')");
  assert.equal(ui.requests[0]!.path, '/api/groups/one/config');
  assert.deepEqual(JSON.parse(String(ui.requests[0]!.options.body)), {
    config: { id: 'one', name: '新名称', conversations: [{ type: 'group', id: '123456' }] }, revision: 'revision-1',
  });
  assert.equal(ui.run('state.configRevision'), 'revision-2');
  assert.equal(ui.get('group-title').textContent, '新名称');
});

test('group mutations respect unsaved settings and deletion cancellation', async () => {
  const ui = page();
  ui.run("$('ws-url').value='ws://changed.example';");
  ui.prompts.push('未保存时不能改名');
  await ui.run("manageGroup('rename')");
  assert.equal(ui.requests.length, 0);
  assert.match(ui.get('notice').textContent, /先保存/);
  ui.run('state.configText=JSON.stringify(connectionFields());');
  ui.confirm(false);
  await ui.run("manageGroup('delete')");
  assert.equal(ui.requests.length, 0);
  assert.match(ui.confirmations.at(-1)!, /文档、聊天记录、资料和 Pi 会话历史都会保留/);
  assert.equal(ui.run('state.selected'), 'one');
});

test('deleting the final group returns to welcome and failed deletion preserves it', async () => {
  const ui = page();
  ui.run('refreshState=async()=>{};');
  ui.respond(async () => { throw new Error('对话组刚开始运行'); });
  await ui.run("manageGroup('delete')");
  assert.equal(ui.run('state.groups.length'), 1);
  assert.equal(ui.run('state.selected'), 'one');
  assert.match(ui.get('notice').textContent, /刚开始运行/);
  ui.respond(async () => ({ deleted: true, id: 'one', recoveryPath: '/test/.trash/one' }));
  await ui.run("manageGroup('delete')");
  assert.equal(ui.requests.at(-1)!.options.method, 'DELETE');
  assert.equal(ui.run('state.groups.length'), 0);
  assert.equal(ui.run('state.selected'), null);
  assert.equal(ui.get('welcome').hidden, false);
  assert.equal(ui.get('group-workspace').hidden, true);
});

test('starting a fresh session requires confirmation and keeps document contents', async () => {
  const ui = page();
  ui.run("state.groups[0].running=true; state.documentLoaded=true; state.documentText='saved memory'; $('document-content').value='saved memory'; renderRunStatus(); refreshState=async()=>{};");
  ui.confirm(false);
  await ui.run('newSession()');
  assert.equal(ui.requests.length, 0);
  ui.confirm(true);
  await ui.run('newSession()');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0]!.path, '/api/groups/one/new-session');
  assert.equal(ui.requests[0]!.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(ui.requests[0]!.options.body)), {});
  assert.match(ui.confirmations.at(-1)!, /新会话不会加载旧会话上下文/);
  assert.match(ui.confirmations.at(-1)!, /旧会话文件会保留/);
  assert.equal(ui.get('document-content').value, 'saved memory');
  assert.equal(ui.run('state.detail.config.conversations.length'), 1);
});

test('fresh-session completion cannot replace the newly selected group state', async () => {
  const ui = page();
  ui.run('renderRunStatus(); refreshState=async()=>{};');
  let finish!: (value: unknown) => void;
  ui.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = ui.run('newSession()');
  ui.run("state.selected='two'; state.detailSequence++; state.detail={config:{id:'two',name:'第二组',conversations:[{type:'group',id:'223456'}]}}; state.groups.push({id:'two',running:false}); state.modelLoaded=true; notice('第二组');");
  finish({ message: '旧组已打开' });
  await pending;
  assert.equal(ui.run('state.selected'), 'two');
  assert.equal(ui.run('state.modelLoaded'), true);
  assert.equal(ui.get('notice').textContent, '第二组');
});

test('trash renders names as text and restores a token through the dedicated endpoint', async () => {
  const ui = page();
  ui.run("state.trashEntries=[{token:'one-123-test',id:'one',name:'<img src=x onerror=bad>',deletedAt:1793000000000}]; renderTrash(); refreshState=async()=>{};");
  assert.match(ui.get('trash-list').textContent, /<img src=x onerror=bad>/);
  const row = ui.get('trash-list').children[0]!;
  assert.equal(row.children[0]!.children[0]!.tagName, 'h3');
  ui.respond(async () => ({ id: 'restored', name: '恢复的组' }));
  await ui.run('restoreGroup(state.trashEntries[0])');
  assert.equal(ui.requests[0]!.path, '/api/trash/one-123-test/restore');
  assert.equal(ui.requests[0]!.options.method, 'POST');
  assert.equal(ui.run('state.trashEntries.length'), 0);
  assert.equal(ui.run('state.selected'), 'one', 'restoring must preserve the current editor selection');
  assert.match(ui.get('notice').textContent, /恢复的组/);
});

test('restoration conflicts remain visible and a pending restore cannot be submitted twice', async () => {
  const ui = page();
  ui.run("state.trashEntries=[{token:'one-123-test',id:'one',name:'原组',deletedAt:0}];");
  let fail!: (error: Error) => void;
  ui.respond(() => new Promise((_resolve, reject) => { fail = reject; }));
  const first = ui.run('restoreGroup(state.trashEntries[0])');
  await ui.run('restoreGroup(state.trashEntries[0])');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.get('trash-list').children[0]!.children[1]!.disabled, true);
  fail(new Error('对话归属已被其他组占用'));
  await first;
  assert.equal(ui.run('state.trashEntries.length'), 1);
  assert.match(ui.get('trash-error').textContent, /已被其他组占用/);
  assert.equal(ui.get('trash-error').hidden, false);
});

test('late trash responses do not overwrite a reopened dialog', async () => {
  const ui = page();
  const finish: Array<(value: unknown) => void> = [];
  ui.respond(() => new Promise(resolve => finish.push(resolve)));
  const first = ui.run('loadTrash()');
  ui.run('closeTrash();');
  const second = ui.run('loadTrash()');
  finish[1]!({ entries: [{ token: 'new-1', id: 'new', name: '新列表', deletedAt: 1 }] });
  await second;
  finish[0]!({ entries: [{ token: 'old-1', id: 'old', name: '旧列表', deletedAt: 1 }] });
  await first;
  assert.equal(ui.run('state.trashEntries[0].id'), 'new');
  assert.equal(ui.get('refresh-trash').disabled, false);
});

test('a state response from before deletion cannot resurrect the removed group', async () => {
  const ui = page();
  const snapshot = { csrfToken: 'test-token', root: '/root', groups: [{ id: 'one', name: '原组', running: false, conversations: [] }] };
  let oldResponse!: (value: unknown) => void;
  let reads = 0;
  ui.respond(async path => {
    if (path !== '/api/state') return { deleted: true, id: 'one' };
    reads++;
    if (reads === 1) return new Promise(resolve => { oldResponse = resolve; });
    return { ...snapshot, groups: [] };
  });
  const poll = ui.run('refreshState()');
  await ui.run("manageGroup('delete')");
  oldResponse(snapshot);
  await poll;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.run('state.groups.length'), 0);
  assert.equal(ui.run('state.selected'), null);
  assert.equal(reads, 2);
});
