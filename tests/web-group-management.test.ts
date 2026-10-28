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
    URL, console, TextEncoder, TextDecoder,
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
  run(`state.selected='one'; state.detail={config:{id:'one',name:'原组',conversations:[{type:'group',id:'GROUP_OpenID-1'}]},configRevision:'revision-1'};
    state.configRevision='revision-1'; state.groups=[{id:'one',name:'原组',running:false,conversations:[{type:'group',id:'GROUP_OpenID-1'}]}];
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
  ui.respond(async () => ({ config: { id: 'one', name: '新名称', conversations: [{ type: 'group', id: 'GROUP_OpenID-1' }] }, revision: 'revision-2' }));
  await ui.run("manageGroup('rename')");
  assert.equal(ui.requests[0]!.path, '/api/groups/one/config');
  assert.deepEqual(JSON.parse(String(ui.requests[0]!.options.body)), {
    config: { id: 'one', name: '新名称', conversations: [{ type: 'group', id: 'GROUP_OpenID-1' }] }, revision: 'revision-1',
  });
  assert.equal(ui.run('state.configRevision'), 'revision-2');
  assert.equal(ui.get('group-title').textContent, '新名称');
});

test('group mutations respect unsaved settings and deletion cancellation', async () => {
  const ui = page();
  ui.run("$('app-id-env').value='CHANGED_APP_ID';");
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

test('conversation forms preserve opaque OpenIDs and reject unsupported kinds or path-shaped identifiers', () => {
  const ui = page();
  const input = [{ type: 'group', id: 'Group_OpenID-X' }, { type: 'private', id: 'User_OpenID-y' }];
  assert.deepEqual(JSON.parse(ui.run(`JSON.stringify(validateConversations(${JSON.stringify(input)}))`)), input);
  assert.equal(ui.run("conversationKey({type:'group',id:'Aa_Bb-1'})"), 'group:Aa_Bb-1');
  assert.equal(ui.run("conversationFromKey('private:User_OpenID-y').id"), 'User_OpenID-y');
  for (const value of [{ type: 'temporary', id: 'Old' }, { type: 'group', id: '../escape' }, { type: 'private', id: 'id with spaces' }]) {
    assert.throws(() => ui.run(`validateConversations([${JSON.stringify(value)}])`));
  }
  assert.throws(() => ui.run("validateConversations([{type:'group',id:'Aa'},{type:'group',id:'Aa'}])"), /重复/);
  assert.equal(ui.run("validateConversations([{type:'group',id:'Aa'},{type:'group',id:'aa'}]).length"), 2);
});

test('connection settings submit credential variable names and display configuration separately from connection', async () => {
  const ui = page();
  ui.run("state.detail.config={...state.detail.config,appIdEnv:'QQBOT_APP_ID',appSecretEnv:'QQBOT_APP_SECRET',groupMemberEvents:false,quietMs:1500,maxWaitMs:10000,minIntervalMs:15000}; state.detail.config.conversations=[]; setConfig(state.detail); $('app-secret-env').value='OTHER_APP_SECRET'; $('group-member-events').value='true';");
  ui.respond(async (_path, options) => ({ config: JSON.parse(String(options.body)).config, revision: 'official-revision', credential: { available: true, source: '环境变量 QQBOT_APP_ID、OTHER_APP_SECRET' } }));
  await ui.run('saveConfig({preventDefault(){}})');
  const payload = JSON.parse(String(ui.requests[0]!.options.body));
  assert.equal(payload.config.appIdEnv, 'QQBOT_APP_ID');
  assert.equal(payload.config.groupMemberEvents, true);
  assert.equal(ui.run('configDirty()'), false, 'saving the event subscription must clear the dirty state');
  assert.equal(payload.config.appSecretEnv, 'OTHER_APP_SECRET');
  assert.equal('wsUrl' in payload.config, false);
  assert.equal('accessTokenEnv' in payload.config, false);
  assert.equal(ui.get('credential-status').textContent, '凭据已配置');
  ui.run('renderRunStatus()');
  assert.equal(ui.get('connection-status').textContent, 'QQBot 未连接');
});

test('the log view accepts official opaque message IDs and attachments without a OneBot envelope', () => {
  const ui = page();
  const record = { v: 3, seq: 1, receivedAt: 1793000000000, conversation: { type: 'group', id: 'Group_OpenID-X' },
    messageId: 'official_message_ABC-1', time: 1793000000, sender: 'Member', userId: 'User_OpenID', selfId: 'APP_ID',
    rawText: '官方消息', attachments: [{ filename: '<img onerror=bad>.png', content_type: 'image/png' }], outgoing: false };
  ui.run(`state.logConversation='group:Group_OpenID-X'; renderMessages(${JSON.stringify(JSON.stringify(record) + '\n')},false);`);
  assert.match(ui.get('message-list').textContent, /官方消息/);
  assert.match(ui.get('message-list').textContent, /official_message_ABC-1/);
  assert.match(ui.get('message-list').textContent, /<img onerror=bad>\.png/);
  assert.throws(() => ui.run(`parseMessages(${JSON.stringify(JSON.stringify({ ...record, v: 2 }) + '\n')},'group:Group_OpenID-X')`));
  assert.throws(() => ui.run(`parseMessages(${JSON.stringify(JSON.stringify(record) + '\n')},'private:Group_OpenID-X')`));
});

test('the log view labels platform message variants and exposes nested conversation records as inert text', () => {
  const ui = page();
  const base = { v: 3, seq: 1, receivedAt: 1793000000000, conversation: { type: 'group', id: 'Group_OpenID-X' },
    messageId: 'official_message_1', time: 1793000000, sender: 'Forwarder', userId: 'User_OpenID', selfId: 'APP_ID', rawText: ' ', outgoing: false };
  const raw = { message_type: 102, msg_elements: [{ author: { username: '原作者 <img src=x onerror=bad>' }, message_type: 103,
    content: '引用内容', msg_elements: [{ author: { username: '嵌套作者' }, message_type: 0, content: '<script>alert(1)</script>最内层原文' }] }] };
  const original = JSON.stringify({ ...base, raw }) + '\n';
  ui.run(`state.logConversation='group:Group_OpenID-X'; renderMessages(${JSON.stringify(original)},false);`);
  assert.match(ui.get('message-list').textContent, /聊天记录/);
  const flatten = (node: Element): Element[] => [node, ...node.children.flatMap(flatten)];
  const nodes = flatten(ui.get('message-list'));
  const details = nodes.find(node => node.tagName === 'details')!;
  assert.equal(details.open, false);
  const pre = nodes.find(node => node.tagName === 'pre')!;
  assert.deepEqual(JSON.parse(pre.textContent), raw);
  assert.match(pre.textContent, /原作者|嵌套作者|最内层原文/);
  assert.match(pre.textContent, /<script>alert\(1\)<\/script>/);
  assert.ok(!nodes.some(node => ['img', 'script', 'iframe'].includes(node.tagName)));
  assert.equal(ui.get('log-content').textContent, original, 'the original JSONL view must remain byte-for-byte unchanged');
  assert.equal(ui.requests.length, 0, 'rendering raw platform events never downloads attachments or fetches nested content');
  for (const [type, label] of [[0, '文本消息'], [3, 'ARK 卡片'], [101, '并行消息'], [102, '聊天记录'], [103, '引用消息']] as const) {
    assert.equal(ui.run(`platformMessageLabel({raw:{message_type:${type}}})`), label);
  }
  assert.equal(ui.run("platformMessageLabel({raw:{eventType:'GROUP_MEMBER_ADD'}})"), '平台事件 · GROUP_MEMBER_ADD');
  assert.equal(ui.run("platformMessageLabel({eventType:'FRIEND_ADD',raw:{}})"), '平台事件 · FRIEND_ADD');
  assert.equal(ui.run('platformMessageLabel({raw:{message_type:999}})'), '消息类型 999');
});

test('large platform previews are bounded and marked without truncating the underlying JSONL', () => {
  const ui = page();
  const raw = { message_type: 103, msg_elements: [{ author: { username: '原作者' }, content: '中文原文'.repeat(30_000) }] };
  const record = { v: 3, seq: 1, receivedAt: 1793000000000, conversation: { type: 'group', id: 'Group_OpenID-X' },
    messageId: 'official-long', time: 1793000000, rawText: '', outgoing: false, raw };
  const original = JSON.stringify(record) + '\n';
  ui.run(`state.logConversation='group:Group_OpenID-X'; renderMessages(${JSON.stringify(original)},false);`);
  const article = ui.get('message-list').children[0]!;
  const details = article.children.find(node => node.tagName === 'details')!;
  assert.match(details.children[0]!.textContent, /64 KiB/);
  assert.match(details.children[1]!.textContent, /预览已截断/);
  assert.doesNotMatch(details.children[1]!.textContent, /\ufffd/);
  assert.ok(Buffer.byteLength(details.children[1]!.textContent) < 64 * 1024 + 256);
  assert.equal(ui.get('log-content').textContent, original);
  assert.equal(ui.requests.length, 0);
});
