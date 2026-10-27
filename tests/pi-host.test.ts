import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionError,
} from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { initializeGroup, loadConfig } from '../src/config.ts';
import { GroupStore } from '../src/store.ts';
import { normalizeMessageEvent } from '../src/transport.ts';
import { conversationKey, type Conversation } from '../src/conversations.ts';
import { readRuntimeStatus, requestRunAction } from '../src/run-control.ts';

/** Fake only the network boundary: Pi and PiQ's independent transport run their real implementations. */
class LocalSocket extends EventTarget {
  static instances: LocalSocket[] = [];
  static autoOpen = true;
  static history = new Map<string, Array<Record<string, unknown>>>();
  static messages = new Map<number, Record<string, unknown>>();
  static forwards = new Map<string, Array<Record<string, unknown>>>();
  static transcripts = new Map<number, string>();
  static stickers = [{ emoji_id: 'sticker-001', md5: 'fake-sticker-md5', desc: 'Local test sticker' }];
  static voices = [{ type: 'default', characters: [{ character_id: 'voice-001', character_name: 'Local test voice' }] }];
  static nextMessageId = -900;
  readyState = 0;
  readonly url: string;
  sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];

  constructor(url: string) {
    super();
    this.url = url;
    LocalSocket.instances.push(this);
    if (LocalSocket.autoOpen) queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string): void {
    const packet = JSON.parse(data);
    this.sent.push(packet);
    const key = packet.action === 'get_friend_msg_history' ? `private:${packet.params.user_id}` : `group:${packet.params.group_id}`;
    const records = LocalSocket.history.get(key) ?? [];
    const anchor = records.findIndex(record => record.message_id === packet.params.message_id);
    const messages = packet.params.message_id
      ? anchor < 0 ? [] : records.slice(anchor, anchor + packet.params.count)
      : records.slice(-packet.params.count);
    let result: unknown;
    if (packet.action === 'get_login_info') result = { user_id: 99999, nickname: 'Test bot' };
    else if (['get_group_msg_history', 'get_friend_msg_history'].includes(packet.action)) result = { messages };
    else if (packet.action === 'get_msg') result = LocalSocket.messages.get(packet.params.message_id) ?? null;
    else if (packet.action === 'get_forward_msg') result = { messages: LocalSocket.forwards.get(packet.params.id) ?? [] };
    else if (['send_group_forward_msg', 'send_private_forward_msg'].includes(packet.action)) {
      const messageId = LocalSocket.nextMessageId--;
      const forwardId = `sent-forward-${Math.abs(messageId)}`;
      const nodes = (packet.params.messages as Array<{ type: string; data: { id: string } }>).map(node => {
        assert.equal(node.type, 'node');
        const message = LocalSocket.messages.get(Number(node.data.id));
        assert.ok(message, 'simulated backend only resolves known original message ids');
        return message;
      });
      LocalSocket.forwards.set(forwardId, nodes);
      result = { message_id: messageId, res_id: forwardId, forward_id: forwardId };
    }
    else if (packet.action === 'fetch_custom_face_detail') result = LocalSocket.stickers;
    else if (packet.action === 'get_ai_characters') result = LocalSocket.voices;
    else if (packet.action === 'fetch_ptt_text') result = { text: LocalSocket.transcripts.get(packet.params.message_id) ?? '' };
    else if (packet.action === 'get_group_root_files') result = { files: [
      { file_id: 'file-001', file_name: 'Local group file.txt', group_id: packet.params.group_id },
    ], folders: [] };
    else if (packet.action === 'create_group_file_folder') result = { ok: true };
    else if (packet.action === 'get_qun_album_list') result = {
      album_list: [{ album_id: 'album-001', name: 'Local group album', upload_number: 1 }], attach_info: '', has_more: false,
    };
    else if (packet.action === 'download_file') result = { file: '/backend/temporary-sticker.png' };
    else if (packet.action === 'add_custom_face') result = { emoji_id: 'added-sticker-001' };
    else if (['modify_custom_face', 'delete_custom_face', 'move_custom_face_to_front'].includes(packet.action)) result = null;
    else if (['group_poke', 'friend_poke', 'set_msg_emoji_like', 'delete_msg'].includes(packet.action)) result = null;
    else result = { message_id: LocalSocket.nextMessageId-- };
    queueMicrotask(() => this.receive({
      status: 'ok', retcode: 0, data: result, echo: packet.echo,
    }));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function groupMessage(groupId: string, messageId: number, text: string) {
  return {
    post_type: 'message', message_type: 'group', self_id: 99999,
    group_id: Number(groupId), user_id: 88888, message_id: messageId,
    message_seq: messageId, time: 1_700_000_000,
    sender: { nickname: 'Test member' },
    message: [{ type: 'text', data: { text } }], raw_message: text,
  };
}

function privateMessage(userId: string, messageId: number, text: string) {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 99999,
    user_id: Number(userId), message_id: messageId, message_seq: messageId, time: 1_700_000_000,
    sender: { nickname: 'Private member' }, message: [{ type: 'text', data: { text } }], raw_message: text };
}

function temporaryMessage(groupId: string, userId: string, messageId: number, text: string) {
  return { ...privateMessage(userId, messageId, text), sub_type: 'group',
    sender: { nickname: 'Temporary member', group_id: Number(groupId) } };
}

function poke(overrides: Record<string, unknown> = {}) {
  return { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 99999,
    time: 1_700_000_100, user_id: 88888, target_id: 99999, ...overrides };
}

async function conversationRecords(cwd: string, conversation: Conversation): Promise<Array<Record<string, any>>> {
  const directory = messagesDirectory(cwd, conversation);
  const files = (await readdir(directory)).filter(file => file.endsWith('.jsonl'));
  return (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8'))))
    .flatMap(contents => contents.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

const messagesDirectory = (cwd: string, conversation: Conversation) => conversation.type === 'temporary'
  ? join(cwd, 'messages', conversation.type, conversation.sourceGroupId!, conversation.id)
  : join(cwd, 'messages', conversation.type, conversation.id);

async function eventually(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

async function fixture(t: TestContext) {
  const oldAutostart = process.env.PIQ_SNOWLUMA_AUTOSTART;
  process.env.PIQ_SNOWLUMA_AUTOSTART = '0';
  t.after(() => { if (oldAutostart === undefined) delete process.env.PIQ_SNOWLUMA_AUTOSTART; else process.env.PIQ_SNOWLUMA_AUTOSTART = oldAutostart; });
  LocalSocket.history.clear();
  LocalSocket.autoOpen = true;
  LocalSocket.messages.clear(); LocalSocket.forwards.clear(); LocalSocket.transcripts.clear(); LocalSocket.nextMessageId = -900;
  // Windows Codex's virtualized OS temp denies rename; the channel uses atomic rename for receipts.
  const tempRoot = join(process.cwd(), '.test-tmp');
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, 'pi-host-'));
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { value: LocalSocket, configurable: true, writable: true });
  // Any accidental model/catalog HTTP call fails locally instead of using credentials or the network.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network access is disabled in Pi integration tests'); });
  const sessions: AgentSession[] = [];
  t.after(async () => {
    try {
      for (const session of sessions.reverse()) {
        await session.abort();
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket);
      else Reflect.deleteProperty(globalThis, 'WebSocket');
      await rm(root, { recursive: true, force: true });
    }
  });

  async function host(groupId: string, marker: string, responses: FauxResponseStep[], prepare?: (cwd: string) => Promise<void>, conversations: Conversation[] = [{ type: 'group', id: groupId }], quietMs = 60) {
    const cfg = { id: groupId, name: groupId, conversations };
    const cwd = await initializeGroup(root, groupId, cfg);
    await prepare?.(cwd);
    await writeFile(join(cwd, 'AGENTS.md'), `# This group's instructions\n\n${marker}\n`);
    await writeFile(join(cwd, 'PIQ.md'), '# Connection\n\n```json\n' + JSON.stringify({
      ...cfg, wsUrl: 'ws://127.0.0.1:9/', accessTokenEnv: 'PIQ_TEST_UNUSED_TOKEN',
      quietMs, maxWaitMs: Math.max(200, quietMs * 2), minIntervalMs: 0,
    }) + '\n```\n');
    const agentDir = join(root, `agent-${groupId}`);
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false },
    }));
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    // Load the actual package configured by initializeGroup, including its extension manifest.
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const faux = fauxProvider({ provider: `piq-test-${groupId}`, tokensPerSecond: 1_000_000 });
    faux.setResponses(responses);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({
      cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, '.pi', 'sessions')),
    });
    sessions.push(session);
    const errors: ExtensionError[] = [];
    const notifications: string[] = [];
    const ui = session.extensionRunner.createContext().ui;
    t.mock.method(ui, 'notify', (message: string) => { notifications.push(message); });
    const socketsBefore = LocalSocket.instances.length;
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    await eventually(() => LocalSocket.instances.length > socketsBefore, 'the group WebSocket');
    const socket = LocalSocket.instances.at(-1)!;
    await eventually(() => socket.readyState === 1, 'the local socket to open');
    return { cwd, session, faux, socket, errors, notifications };
  }

  return { root, host };
}

test('real Pi loads per-group Markdown, receives a signal, reads records and sends only explicit replies', async t => {
  const f = await fixture(t);
  const firstGroup = '123401';
  const secondGroup = '123402';
  const firstMarker = 'PERSONA_ONLY_FOR_FIRST_GROUP';
  const secondMarker = 'PERSONA_ONLY_FOR_SECOND_GROUP';
  const firstBody = 'FIRST_GROUP_MESSAGE_BODY';
  const secondBody = 'SECOND_GROUP_MESSAGE_BODY';
  const requests: string[] = [];
  const first = await f.host(firstGroup, firstMarker, [
    async context => {
      requests.push(JSON.stringify(context));
      const files = await readdir(messagesDirectory(join(f.root, firstGroup), { type: 'group', id: firstGroup }));
      assert.equal(files.filter(file => file.endsWith('.jsonl')).length, 1);
      return fauxAssistantMessage(fauxToolCall('read', { path: join('messages', 'group', firstGroup, files[0]!) }), { stopReason: 'toolUse' });
    },
    context => {
      requests.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxToolCall('qq_send', { conversation: `group:${firstGroup}`, text: 'An explicitly chosen reply' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('This ordinary assistant response belongs only in Pi.'),
  ]);
  const second = await f.host(secondGroup, secondMarker, [fauxAssistantMessage('No reply needed.')]);
  assert.match(first.session.systemPrompt, new RegExp(firstMarker));
  assert.doesNotMatch(first.session.systemPrompt, new RegExp(secondMarker));
  assert.match(second.session.systemPrompt, new RegExp(secondMarker));
  assert.doesNotMatch(second.session.systemPrompt, new RegExp(firstMarker));
  assert.ok(first.session.getActiveToolNames().includes('qq_send'));

  for (let index = 1; index <= 3; index++) {
    first.socket.receive(groupMessage(firstGroup, index, `${firstBody} ${index}`));
  }
  first.socket.receive(groupMessage(secondGroup, 20, secondBody));
  second.socket.receive(groupMessage(firstGroup, 30, firstBody));
  second.socket.receive(groupMessage(secondGroup, 40, secondBody));
  await eventually(() => first.faux.state.callCount === 3 && second.faux.state.callCount === 1
    && first.session.isIdle && second.session.isIdle, 'both local model runs to settle');

  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(first.notifications, []);
  assert.deepEqual(second.notifications, []);
  const signals = first.session.messages.filter(message => message.role === 'custom');
  assert.equal(signals.length, 1, 'the burst should produce one context signal');
  assert.doesNotMatch(JSON.stringify(signals), new RegExp(firstBody));
  assert.doesNotMatch(requests[0]!, new RegExp(firstBody));
  assert.match(requests[1]!, new RegExp(firstBody), 'the model obtains message content via the built-in read tool');
  assert.doesNotMatch(JSON.stringify(first.session.messages), new RegExp(secondBody));
  assert.doesNotMatch(JSON.stringify(second.session.messages), new RegExp(firstBody));
  const replies = first.socket.sent.filter(packet => packet.action === 'send_group_msg');
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0]!.params, {
    group_id: Number(firstGroup), message: [{ type: 'text', data: { text: 'An explicitly chosen reply' } }],
  });
  assert.equal(second.socket.sent.filter(packet => packet.action === 'send_group_msg').length, 0);
  assert.match(JSON.stringify(first.session.messages), /-900/, 'the send receipt returns to Pi');
  assert.notEqual(first.session.sessionFile, second.session.sessionFile);
  assert.ok(first.session.sessionFile!.startsWith(join(first.cwd, '.pi', 'sessions')));
  assert.ok(second.session.sessionFile!.startsWith(join(second.cwd, '.pi', 'sessions')));
  const firstDirectory = messagesDirectory(first.cwd, { type: 'group', id: firstGroup });
  const firstFiles = await readdir(firstDirectory);
  const firstLog = await readFile(join(firstDirectory, firstFiles[0]!), 'utf8');
  assert.match(firstLog, new RegExp(firstBody));
  assert.doesNotMatch(firstLog, new RegExp(secondBody));
});

test('real Pi reload closes the old connection and keeps one receiver for the current group', async t => {
  const f = await fixture(t);
  const host = await f.host('123403', 'RELOAD_GROUP_PERSONA', [fauxAssistantMessage('Seen after reload.')]);
  const previousSocket = host.socket;
  const socketsBefore = LocalSocket.instances.length;
  await host.session.reload();
  assert.equal(previousSocket.readyState, 3);
  assert.equal(LocalSocket.instances.length, socketsBefore + 1);
  const currentSocket = LocalSocket.instances.at(-1)!;
  await eventually(() => currentSocket.readyState === 1, 'replacement socket');
  previousSocket.receive(groupMessage('123403', 51, 'STALE_SOCKET_CONTENT'));
  currentSocket.receive(groupMessage('123403', 52, 'CURRENT_SOCKET_CONTENT'));
  await eventually(() => host.faux.state.callCount === 1 && host.session.isIdle, 'the replacement receiver to notify Pi');
  assert.deepEqual(host.errors, []);
  assert.deepEqual(host.notifications, []);
  const directory = messagesDirectory(host.cwd, { type: 'group', id: '123403' });
  const files = await readdir(directory);
  const log = await readFile(join(directory, files[0]!), 'utf8');
  assert.match(log, /CURRENT_SOCKET_CONTENT/);
  assert.doesNotMatch(log, /STALE_SOCKET_CONTENT/);
  assert.equal(host.session.messages.filter(message => message.role === 'custom').length, 1);
});

test('real Pi keeps collecting while busy and wakes once with the accumulated messages after settling', async t => {
  const f = await fixture(t);
  let release = () => {};
  const busy = new Promise<void>(resolve => { release = resolve; });
  const host = await f.host('123404', 'BUSY_GROUP_PERSONA', [
    async () => { await busy; return fauxAssistantMessage('The first response is finished.'); },
    fauxAssistantMessage('The accumulated messages can now be considered.'),
  ]);
  const independent = await f.host('123405', 'INDEPENDENT_GROUP_PERSONA', [fauxAssistantMessage('Another group remains responsive.')]);
  try {
    host.socket.receive(groupMessage('123404', 60, 'START_ONE_RUN'));
    await eventually(() => host.faux.state.callCount === 1, 'the first model response to start');
    assert.equal(host.session.isIdle, false);
    for (let index = 1; index <= 10; index++) {
      host.socket.receive(groupMessage('123404', 60 + index, `WHILE_BUSY_${index}`));
    }
    independent.socket.receive(groupMessage('123405', 80, 'INDEPENDENT_GROUP_MESSAGE'));
    await eventually(() => independent.faux.state.callCount === 1 && independent.session.isIdle,
      'the other group to respond independently while the first group is busy');
    assert.equal(host.session.isIdle, false);
    assert.deepEqual(independent.errors, []);
    await eventually(async () => {
      const directory = messagesDirectory(host.cwd, { type: 'group', id: '123404' });
      const files = await readdir(directory);
      return files.length > 0 && (await readFile(join(directory, files[0]!), 'utf8')).includes('WHILE_BUSY_10');
    }, 'all incoming messages to reach the journal while Pi is busy');
    await delay(250);
    assert.equal(host.faux.state.callCount, 1);
    assert.equal(host.session.messages.filter(message => message.role === 'custom').length, 1);
    release();
    await eventually(() => host.faux.state.callCount === 2 && host.session.isIdle, 'one follow-up notification after settling');
    assert.deepEqual(host.errors, []);
    assert.deepEqual(host.notifications, []);
    assert.deepEqual(independent.notifications, []);
    const signals = host.session.messages.filter(message => message.role === 'custom');
    assert.equal(signals.length, 2);
    assert.match(JSON.stringify(signals[1]), /10 条新消息/);
    assert.doesNotMatch(JSON.stringify(signals), /WHILE_BUSY_/);
    assert.doesNotMatch(JSON.stringify(host.session.messages), /INDEPENDENT_GROUP_MESSAGE/);
    assert.equal(host.socket.sent.filter(packet => packet.action === 'send_group_msg').length, 0);
  } finally {
    release();
  }
});

test('real Pi recovers offline history on startup and reconnects without injecting or duplicating message text', async t => {
  const f = await fixture(t);
  const groupId = '123406';
  const records = Array.from({ length: 9 }, (_, index) => groupMessage(groupId, index + 1, 'IDENTICAL_OFFLINE_BODY'));
  LocalSocket.history.set(`group:${groupId}`, records.slice(0, 6));
  const host = await f.host(groupId, 'HISTORY_GROUP', [
    fauxAssistantMessage('The initial offline batch is available.'),
    fauxAssistantMessage('The next offline batch is available.'),
  ], async cwd => {
    const store = await GroupStore.open(cwd, { id: groupId, conversations: [{ type: 'group', id: groupId }] });
    try { await store.append(normalizeMessageEvent(records[0]!)!); await store.acknowledge(1); }
    finally { await store.close(); }
  });
  await eventually(() => host.faux.state.callCount === 1 && host.session.isIdle, 'the startup history notification');
  const firstSignals = host.session.messages.filter(message => message.role === 'custom');
  assert.equal(firstSignals.length, 1);
  assert.match(JSON.stringify(firstSignals), /5 条新消息/);
  assert.doesNotMatch(JSON.stringify(host.session.messages), /IDENTICAL_OFFLINE_BODY/);
  LocalSocket.history.set(`group:${groupId}`, records);
  host.socket.close();
  await eventually(() => host.faux.state.callCount === 2 && host.session.isIdle, 'the reconnect history notification');
  const signals = host.session.messages.filter(message => message.role === 'custom');
  assert.equal(signals.length, 2);
  assert.match(JSON.stringify(signals[1]), /3 条新消息/);
  const directory = messagesDirectory(host.cwd, { type: 'group', id: groupId });
  const files = await readdir(directory);
  const log = await readFile(join(directory, files[0]!), 'utf8');
  assert.equal(log.trimEnd().split('\n').map(line => JSON.parse(line)).length, 9);
  assert.deepEqual(host.errors, []);
  assert.deepEqual(host.notifications, []);
});

test('one Pi conversation group shares context across group and private dialogs while replies stay explicitly scoped', async t => {
  const f = await fixture(t);
  const sharedId = 'shared';
  const peerId = '123407';
  const conversations: Conversation[] = [{ type: 'group', id: peerId }, { type: 'private', id: peerId }];
  const requests: string[] = [];
  const readConversation = async (type: Conversation['type']) => {
    const directory = join(f.root, sharedId, 'messages', type, peerId);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    return fauxAssistantMessage(fauxToolCall('read', { path: join('messages', type, peerId, files[0]!) }), { stopReason: 'toolUse' });
  };
  const shared = await f.host(sharedId, 'SHARED_GROUP_RULES', [
    async context => { requests.push(JSON.stringify(context)); return readConversation('group'); },
    async context => { requests.push(JSON.stringify(context)); return readConversation('private'); },
    context => {
      requests.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxToolCall('qq_send', { conversation: `private:${peerId}`, text: 'A reply to the private dialog only.' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: 'group:999888', text: 'This outside-group destination must be blocked.' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Conversation group processing is complete.'),
  ], undefined, conversations);
  const other = await f.host('isolated', 'OTHER_GROUP_RULES', [fauxAssistantMessage('Only the other group sees its own message.')], undefined, [{ type: 'group', id: '999888' }]);
  const groupRecord = groupMessage(peerId, 1, 'SAME_SHARED_BODY');
  const privateRecord = privateMessage(peerId, 1, 'SAME_SHARED_BODY');
  shared.socket.receive(groupRecord);
  shared.socket.receive(privateRecord);
  shared.socket.receive(groupRecord);
  shared.socket.receive(privateRecord);
  shared.socket.receive(groupMessage('999888', 2, 'OTHER_GROUP_BODY'));
  other.socket.receive(groupRecord);
  other.socket.receive(privateRecord);
  other.socket.receive(groupMessage('999888', 2, 'OTHER_GROUP_BODY'));
  await eventually(() => shared.faux.state.callCount === 5 && shared.session.isIdle
    && other.faux.state.callCount === 1 && other.session.isIdle, 'the shared and isolated groups to finish');

  assert.deepEqual(shared.errors, []);
  assert.deepEqual(shared.notifications, []);
  assert.deepEqual(other.errors, []);
  const signals = shared.session.messages.filter(message => message.role === 'custom' && message.customType === 'piq:messages');
  assert.equal(signals.length, 1, 'both dialogs aggregate into one Pi turn');
  assert.match(JSON.stringify(signals), /2 条新消息/);
  assert.match(JSON.stringify(signals), /messages\/group\/123407\//);
  assert.match(JSON.stringify(signals), /messages\/private\/123407\//);
  const firstSignal = signals[0]!;
  assert.ok(firstSignal.role === 'custom');
  const details = firstSignal.details as { conversations: Array<{ conversation: Conversation; count: number }> };
  assert.deepEqual(details.conversations.map(item => [conversationKey(item.conversation), item.count]).sort(),
    [[`group:${peerId}`, 1], [`private:${peerId}`, 1]].sort());
  assert.doesNotMatch(JSON.stringify(signals), /SAME_SHARED_BODY/);
  assert.doesNotMatch(requests[0]!, /SAME_SHARED_BODY/);
  assert.match(requests[2]!, /SAME_SHARED_BODY/);
  assert.doesNotMatch(JSON.stringify(shared.session.messages), /OTHER_GROUP_BODY|OTHER_GROUP_RULES/);
  assert.doesNotMatch(JSON.stringify(other.session.messages), /SAME_SHARED_BODY|SHARED_GROUP_RULES/);
  const sends = shared.socket.sent.filter(packet => ['send_private_msg', 'send_group_msg'].includes(packet.action));
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.action, 'send_private_msg');
  assert.equal(sends[0]!.params.user_id, Number(peerId));
  assert.equal(sends[0]!.params.group_id, undefined);
  assert.ok(shared.session.messages.some(message => message.role === 'toolResult' && message.toolName === 'qq_send' && message.isError));
  assert.notEqual(shared.session.sessionFile, other.session.sessionFile);
  for (const conversation of conversations) {
    const directory = messagesDirectory(shared.cwd, conversation);
    const files = await readdir(directory);
    const records = (await readFile(join(directory, files[0]!), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const incoming = records.filter(record => !record.outgoing);
    assert.equal(incoming.length, 1, 'duplicate delivery deduplicates within each dialog, not between dialogs');
    assert.deepEqual(incoming[0].conversation, conversation);
    assert.equal(incoming[0].v, 2);
    assert.ok(records.every(record => record.conversation.type === conversation.type && record.conversation.id === peerId));
  }
});

test('temporary messages join their source group, stay in a separate log, and respect explicit assignments', async t => {
  const f = await fixture(t);
  const sourceId = '123408';
  const peerId = '876501';
  const source = await f.host('source', 'SOURCE_GROUP_RULES', [
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: `temporary:${sourceId}:${peerId}`, text: 'A temporary-session reply.' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The three dialog types were considered together.'),
  ], undefined, [{ type: 'group', id: sourceId }, { type: 'private', id: peerId }], 250);
  const otherPeer = '876502';
  const other = await f.host('assigned', 'EXPLICIT_TEMP_GROUP', [fauxAssistantMessage('This temporary dialog was explicitly assigned here.')], undefined,
    [{ type: 'temporary', sourceGroupId: sourceId, id: otherPeer }], 250);

  source.socket.receive(groupMessage(sourceId, 1, 'SAME_BURST_CONTENT'));
  source.socket.receive(privateMessage(peerId, 1, 'SAME_BURST_CONTENT'));
  source.socket.receive(temporaryMessage(sourceId, peerId, 1, 'SAME_BURST_CONTENT'));
  await eventually(() => source.faux.state.callCount === 2 && source.session.isIdle, 'classified group/private/temporary notification');
  assert.deepEqual(source.errors, []);
  assert.deepEqual(source.notifications, []);
  const signals = source.session.messages.filter(message => message.role === 'custom' && message.customType === 'piq:messages');
  assert.equal(signals.length, 1);
  const firstSignal = signals[0]!;
  assert.ok(firstSignal.role === 'custom');
  const details = firstSignal.details as { conversations: Array<{ conversation: Conversation; count: number }> };
  assert.deepEqual(details.conversations.map(item => [conversationKey(item.conversation), item.count]).sort(),
    [[`group:${sourceId}`, 1], [`private:${peerId}`, 1], [`temporary:${sourceId}:${peerId}`, 1]].sort());
  assert.doesNotMatch(JSON.stringify(signals), /SAME_BURST_CONTENT/);
  assert.ok((await loadConfig(source.cwd))!.conversations.some(conversation => conversationKey(conversation) === `temporary:${sourceId}:${peerId}`));
  const temporaryDirectory = join(source.cwd, 'messages', 'temporary', sourceId, peerId);
  const files = await readdir(temporaryDirectory);
  const temporaryRecords = (await readFile(join(temporaryDirectory, files[0]!), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(temporaryRecords.filter(record => !record.outgoing).length, 1);
  assert.ok(temporaryRecords.every(record => conversationKey(record.conversation) === `temporary:${sourceId}:${peerId}`));
  const sends = source.socket.sent.filter(packet => packet.action === 'send_private_msg');
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.params.user_id, Number(peerId));
  assert.equal(sends[0]!.params.group_id, Number(sourceId));

  const elsewhere = temporaryMessage(sourceId, otherPeer, 2, 'EXPLICIT_ASSIGNMENT_BODY');
  source.socket.receive(elsewhere);
  other.socket.receive(elsewhere);
  await eventually(() => other.faux.state.callCount === 1 && other.session.isIdle, 'the explicit temporary owner to receive its message');
  await delay(300);
  assert.equal(source.faux.state.callCount, 2, 'automatic source routing must respect the configured owner');
  assert.equal((await loadConfig(source.cwd))!.conversations.some(conversation => conversationKey(conversation) === `temporary:${sourceId}:${otherPeer}`), false);
  assert.deepEqual(source.errors, []); assert.deepEqual(source.notifications, []);
  assert.deepEqual(other.errors, []); assert.deepEqual(other.notifications, []);
});

test('real Pi explicitly pokes a group member or private peer and rejects unscoped destinations', async t => {
  const f = await fixture(t);
  const groupId = '444001';
  const peerId = '444002';
  const temporaryId = '444003';
  const conversations: Conversation[] = [
    { type: 'group', id: groupId }, { type: 'private', id: peerId },
    { type: 'temporary', id: temporaryId, sourceGroupId: groupId },
  ];
  const tool = (parameters: Record<string, string>) => fauxAssistantMessage(fauxToolCall('qq_poke', parameters), { stopReason: 'toolUse' });
  const host = await f.host('poke-actions', 'EXPLICIT_POKE_ACTIONS', [
    tool({ conversation: `group:${groupId}`, userId: '88888' }),
    tool({ conversation: `private:${peerId}` }),
    tool({ conversation: 'group:555111', userId: '88888' }),
    tool({ conversation: `group:${groupId}` }),
    tool({ conversation: `temporary:${groupId}:${temporaryId}` }),
    tool({ conversation: `private:${peerId}`, userId: '77777' }),
    fauxAssistantMessage('The explicit pokes and rejected targets have been considered.'),
  ], undefined, conversations);
  assert.ok(host.session.getActiveToolNames().includes('qq_poke'));
  await host.session.prompt('Exercise the explicit poke tool and its conversation boundaries.');

  const actions = host.socket.sent.filter(packet => ['group_poke', 'friend_poke'].includes(packet.action));
  assert.deepEqual(actions.map(packet => [packet.action, packet.params]), [
    ['group_poke', { group_id: Number(groupId), user_id: 88888 }],
    ['friend_poke', { user_id: Number(peerId) }],
  ]);
  const results = host.session.messages.filter(message => message.role === 'toolResult' && message.toolName === 'qq_poke');
  assert.equal(results.length, 6);
  assert.equal(results.filter(result => result.role === 'toolResult' && result.isError).length, 4);
  assert.equal(host.socket.sent.filter(packet => ['send_group_msg', 'send_private_msg'].includes(packet.action)).length, 0);
  for (const conversation of conversations.slice(0, 2)) {
    const records = await conversationRecords(host.cwd, conversation);
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.kind, 'poke');
    assert.equal(record.source, 'action');
    assert.equal(record.outgoing, true);
    assert.equal(record.userId, '99999');
    assert.equal(record.targetId, conversation.type === 'group' ? '88888' : peerId);
    assert.equal('messageId' in record, false);
    assert.equal('messageSeq' in record, false);
    assert.equal(typeof record.eventId, 'string');
  }
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('poke notices share classified notifications and separate journals without moving message history', async t => {
  const f = await fixture(t);
  const groupId = '444004';
  const peerId = '444005';
  const temporaryId = '444006';
  const conversations: Conversation[] = [
    { type: 'group', id: groupId }, { type: 'private', id: peerId },
    { type: 'temporary', id: temporaryId, sourceGroupId: groupId },
  ];
  const requests: string[] = [];
  const host = await f.host('poke-notices', 'POKE_NOTICE_RULES', [context => {
    requests.push(JSON.stringify(context));
    return fauxAssistantMessage('The conversations are available to read if needed.');
  }], undefined, conversations, 250);
  const repeatedPoke = poke({ group_id: Number(groupId) });
  host.socket.receive(repeatedPoke);
  host.socket.receive(repeatedPoke);
  host.socket.receive(privateMessage(peerId, 1, 'PRIVATE_BODY_READ_ONLY_ON_DEMAND'));
  host.socket.receive(poke({ user_id: Number(peerId), sender_id: Number(peerId) }));
  host.socket.receive(poke({ group_id: Number(groupId), user_id: 99999, target_id: 88888 }));
  host.socket.receive(poke({ user_id: Number(peerId), sender_id: 99999, target_id: Number(peerId) }));
  host.socket.receive(poke({ group_id: 555111 }));
  // Without a group source, a private notice must not be assigned to a temporary conversation.
  host.socket.receive(poke({ user_id: Number(temporaryId), sender_id: Number(temporaryId) }));
  await eventually(() => host.faux.state.callCount === 1 && host.session.isIdle, 'one combined notice and message turn');

  const signals = host.session.messages.filter(message => message.role === 'custom' && message.customType === 'piq:messages');
  assert.equal(signals.length, 1);
  const signal = signals[0]!;
  assert.ok(signal.role === 'custom');
  const details = signal.details as { conversations: Array<{ conversation: Conversation; count: number }> };
  assert.deepEqual(details.conversations.map(item => [conversationKey(item.conversation), item.count]).sort(),
    [[`group:${groupId}`, 2], [`private:${peerId}`, 2]].sort());
  assert.doesNotMatch(JSON.stringify(signals), /PRIVATE_BODY_READ_ONLY_ON_DEMAND|戳了/);
  assert.doesNotMatch(requests[0]!, /PRIVATE_BODY_READ_ONLY_ON_DEMAND|戳了/);
  const groupRecords = await conversationRecords(host.cwd, conversations[0]!);
  const privateRecords = await conversationRecords(host.cwd, conversations[1]!);
  assert.equal(groupRecords.length, 3);
  assert.equal(privateRecords.length, 3);
  const incomingPokes = groupRecords.filter(record => record.kind === 'poke' && !record.outgoing);
  assert.equal(incomingPokes.length, 2, 'two identical same-second reports remain separate events');
  assert.notEqual(incomingPokes[0]!.eventId, incomingPokes[1]!.eventId);
  for (const record of [...groupRecords, ...privateRecords].filter(record => record.kind === 'poke')) {
    assert.equal(record.source, 'notice');
    assert.equal('messageId' in record, false);
    assert.equal('messageSeq' in record, false);
    assert.equal(record.outgoing, record.userId === record.selfId);
  }
  assert.equal(privateRecords.find(record => record.kind === 'poke' && record.outgoing)!.userId, '99999',
    'private notice sender_id identifies our own poke even when user_id is the peer');
  const history = JSON.parse(await readFile(join(host.cwd, '.piq', 'history.json'), 'utf8'));
  assert.equal(history.cursors[`group:${groupId}`], null);
  assert.equal(history.cursors[`private:${peerId}`].messageId, '1');
  assert.deepEqual((await loadConfig(host.cwd))!.conversations, conversations);

  host.socket.receive(poke({ group_id: Number(groupId), user_id: 99999, target_id: 88888, time: 1_700_000_200 }));
  await eventually(async () => (await conversationRecords(host.cwd, conversations[0]!)).length === 4, 'the own notice to be recorded');
  await delay(350);
  assert.equal(host.faux.state.callCount, 1, 'our own poke does not wake the agent again');
  assert.equal(host.socket.sent.filter(packet => ['group_poke', 'friend_poke'].includes(packet.action)).length, 0,
    'receiving a poke must not automatically poke back');
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('paused Pi records poke notices and refuses explicit poke actions until resumed', async t => {
  const f = await fixture(t);
  const groupId = '444007';
  const host = await f.host('poke-paused', 'PAUSED_POKE_RULES', [
    fauxAssistantMessage(fauxToolCall('qq_poke', { conversation: `group:${groupId}`, userId: '88888' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The paused action was refused.'),
    fauxAssistantMessage('The stored notice is now available.'),
  ], undefined, [{ type: 'group', id: groupId }]);
  const pause = await requestRunAction(host.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(host.cwd))?.requestId === pause.requestId, 'poke pause receipt');
  host.socket.receive(poke({ group_id: Number(groupId) }));
  await eventually(async () => (await readRuntimeStatus(host.cwd))?.pendingCount === 1, 'a poke recorded while paused');
  await delay(150);
  assert.equal(host.faux.state.callCount, 0);
  await host.session.prompt('Check the paused qq_poke guard.');
  assert.equal(host.socket.sent.filter(packet => ['group_poke', 'friend_poke'].includes(packet.action)).length, 0);
  assert.match(JSON.stringify(host.session.messages), /PiQ 已暂停/);
  const resume = await requestRunAction(host.cwd, 'resume');
  await eventually(async () => (await readRuntimeStatus(host.cwd))?.requestId === resume.requestId, 'poke resume receipt');
  await eventually(() => host.faux.state.callCount === 3 && host.session.isIdle, 'one resumed poke notice turn');
  assert.equal(host.session.messages.filter(message => message.role === 'custom' && message.customType === 'piq:messages').length, 1);
  const records = await conversationRecords(host.cwd, { type: 'group', id: groupId });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'poke');
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('real Pi explicitly reacts, recalls, sends a saved sticker and uses QQ voice without forwarding ordinary output', async t => {
  const f = await fixture(t);
  const groupId = '444008';
  const conversation = `group:${groupId}`;
  LocalSocket.messages.set(-201, groupMessage(groupId, -201, 'A message to react to'));
  LocalSocket.messages.set(-202, { ...groupMessage(groupId, -202, 'Our own earlier message'), user_id: 99999 });
  LocalSocket.messages.set(-203, { ...groupMessage(groupId, -203, ''), message: [{ type: 'record', data: { file: 'fake-voice.silk' } }] });
  LocalSocket.transcripts.set(-203, 'LOCAL_EXPLICIT_VOICE_TRANSCRIPT');
  const host = await f.host('explicit-interactions', 'EXPLICIT_INTERACTION_RULES', [
    fauxAssistantMessage(fauxToolCall('qq_react', { conversation, messageId: -201, emojiId: '66' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_react', { conversation, messageId: -201, emojiId: '66', set: false }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_recall', { conversation, messageId: -202 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'list', count: 4 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'send', conversation, emojiId: 'sticker-001', replyTo: -201 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'list', conversation }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send', conversation, text: 'A deliberate voice reply.', characterId: 'voice-001' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'transcribe', conversation, messageId: -203 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation, text: 'A deliberate quoted reply.', replyTo: -201 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('This ordinary assistant response must stay inside Pi.'),
  ], undefined, [{ type: 'group', id: groupId }]);
  await host.session.prompt('Use only explicit QQ tools for the selected interactions.');

  const packets = host.socket.sent;
  assert.deepEqual(packets.filter(packet => packet.action === 'set_msg_emoji_like').map(packet => packet.params), [
    { message_id: -201, emoji_id: '66', set: true }, { message_id: -201, emoji_id: '66', set: false },
  ]);
  assert.deepEqual(packets.filter(packet => packet.action === 'delete_msg').map(packet => packet.params), [{ message_id: -202 }]);
  assert.deepEqual(packets.filter(packet => packet.action === 'fetch_custom_face_detail').map(packet => packet.params), [{ count: 4 }]);
  assert.deepEqual(packets.filter(packet => packet.action === 'send_custom_face').map(packet => packet.params), [
    { emoji_id: 'sticker-001', group_id: Number(groupId), reply_to: -201 },
  ]);
  assert.deepEqual(packets.filter(packet => packet.action === 'get_ai_characters').map(packet => packet.params), [{ group_id: Number(groupId) }]);
  assert.deepEqual(packets.filter(packet => packet.action === 'send_group_ai_record').map(packet => packet.params), [
    { group_id: Number(groupId), character: 'voice-001', text: 'A deliberate voice reply.' },
  ]);
  assert.deepEqual(packets.filter(packet => packet.action === 'fetch_ptt_text').map(packet => packet.params), [{ message_id: -203 }]);
  const recognition = packets.findIndex(packet => packet.action === 'fetch_ptt_text');
  assert.equal(packets[recognition - 1]?.action, 'get_msg', 'recognition follows a scoped record-message lookup');
  assert.equal(packets[recognition - 1]?.params.message_id, -203);
  assert.deepEqual(packets.filter(packet => packet.action === 'get_msg').map(packet => packet.params.message_id), [-201, -201, -202, -203]);
  const replies = packets.filter(packet => ['send_group_msg', 'send_private_msg'].includes(packet.action));
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0]!.params, { group_id: Number(groupId), message: [
    { type: 'reply', data: { id: '-201' } }, { type: 'text', data: { text: 'A deliberate quoted reply.' } },
  ] });
  const results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.filter(result => result.role === 'toolResult' && result.isError).length, 0);
  assert.match(JSON.stringify(results), /LOCAL_EXPLICIT_VOICE_TRANSCRIPT/);
  assert.match(JSON.stringify(results), /Local test sticker/);
  assert.match(JSON.stringify(results), /Local test voice/);
  const records = await conversationRecords(host.cwd, { type: 'group', id: groupId });
  assert.equal(records.length, 3, 'only successful sticker, voice and quoted sends become outgoing message records');
  assert.ok(records.every(record => record.outgoing));
  assert.equal(new Set(records.map(record => record.messageId)).size, 3);
  assert.ok(records.some(record => record.segments.some((segment: { type: string }) => segment.type === 'custom_face')));
  assert.ok(records.some(record => record.segments.some((segment: { type: string }) => segment.type === 'record')));
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('QQ interaction tools verify message ownership and reject unsupported private or temporary operations', async t => {
  const f = await fixture(t);
  const groupId = '444009';
  const peerId = '444010';
  const privateChat = `private:${peerId}`;
  const conversation = `group:${groupId}`;
  const temporary = `temporary:${groupId}:444011`;
  LocalSocket.messages.set(-211, groupMessage(groupId, -211, 'Another member wrote this'));
  LocalSocket.messages.set(-212, { ...groupMessage('555111', -212, 'A foreign conversation'), user_id: 99999 });
  LocalSocket.messages.set(-213, { ...groupMessage('555111', -213, ''), message: [{ type: 'record', data: { file: 'foreign.silk' } }] });
  const host = await f.host('interaction-boundaries', 'INTERACTION_BOUNDARIES', [
    fauxAssistantMessage(fauxToolCall('qq_react', { conversation: privateChat, messageId: -211, emojiId: '66' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_react', { conversation, messageId: -212, emojiId: '66' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_recall', { conversation, messageId: -211 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_recall', { conversation, messageId: -212 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send', conversation: privateChat, text: 'Unsupported private AI voice.', characterId: 'voice-001' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'list', conversation: privateChat }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'transcribe', conversation, messageId: -211 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'transcribe', conversation, messageId: -213 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'send', conversation: temporary, emojiId: 'sticker-001' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_react', { conversation: 'group:555111', messageId: -212, emojiId: '66' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('All unsupported or incorrectly scoped operations were refused.'),
  ], undefined, [{ type: 'group', id: groupId }, { type: 'private', id: peerId },
    { type: 'temporary', sourceGroupId: groupId, id: '444011' }]);
  await host.session.prompt('Check the interaction tool conversation and sender boundaries.');
  const results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 10);
  assert.ok(results.every(result => result.role === 'toolResult' && result.isError));
  const forbidden = ['set_msg_emoji_like', 'delete_msg', 'send_custom_face', 'get_ai_characters', 'send_group_ai_record', 'fetch_ptt_text'];
  assert.equal(host.socket.sent.filter(packet => forbidden.includes(packet.action)).length, 0);
  assert.deepEqual(host.socket.sent.filter(packet => packet.action === 'get_msg').map(packet => packet.params.message_id),
    [-212, -211, -212, -211, -213], 'unsupported contexts reject before read; scoped operations fetch their own supplied message');
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('paused Pi refuses all interaction, sticker and voice tool requests before dispatch', async t => {
  const f = await fixture(t);
  const groupId = '444012';
  const conversation = `group:${groupId}`;
  const host = await f.host('paused-interactions', 'PAUSED_INTERACTIONS', [
    fauxAssistantMessage(fauxToolCall('qq_react', { conversation, messageId: -221, emojiId: '66' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_recall', { conversation, messageId: -221 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'list' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'send', conversation, emojiId: 'sticker-001' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'list', conversation }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send', conversation, text: 'Paused voice.', characterId: 'voice-001' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'transcribe', conversation, messageId: -221 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The paused channel refused all tool actions.'),
  ], undefined, [{ type: 'group', id: groupId }]);
  const pause = await requestRunAction(host.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(host.cwd))?.requestId === pause.requestId, 'interaction pause receipt');
  await host.session.prompt('Try each interaction tool while paused.');
  const operations = ['get_msg', 'set_msg_emoji_like', 'delete_msg', 'fetch_custom_face_detail', 'send_custom_face',
    'get_ai_characters', 'send_group_ai_record', 'fetch_ptt_text'];
  assert.equal(host.socket.sent.filter(packet => operations.includes(packet.action)).length, 0);
  const results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 7);
  assert.ok(results.every(result => result.role === 'toolResult' && result.isError));
  assert.match(JSON.stringify(results), /PiQ 已暂停/);
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('an incoming voice stays in its journal without automatic recognition or transcript injection', async t => {
  const f = await fixture(t);
  const groupId = '444013';
  const host = await f.host('voice-on-demand', 'VOICE_ON_DEMAND_RULES', [
    fauxAssistantMessage('The voice can be read or transcribed when needed.'),
  ], undefined, [{ type: 'group', id: groupId }]);
  host.socket.receive({ ...groupMessage(groupId, -231, '[语音]'),
    message: [{ type: 'record', data: { file: 'LOCAL_ON_DEMAND_VOICE.silk' } }] });
  await eventually(() => host.faux.state.callCount === 1 && host.session.isIdle, 'the incoming voice signal');
  assert.equal(host.socket.sent.filter(packet => ['get_msg', 'fetch_ptt_text', 'send_group_ai_record'].includes(packet.action)).length, 0);
  const signals = host.session.messages.filter(message => message.role === 'custom' && message.customType === 'piq:messages');
  assert.equal(signals.length, 1);
  assert.doesNotMatch(JSON.stringify(signals), /LOCAL_ON_DEMAND_VOICE|\[语音\]/);
  const records = await conversationRecords(host.cwd, { type: 'group', id: groupId });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.segments[0].type, 'record');
  assert.equal(records[0]!.segments[0].data.file, 'LOCAL_ON_DEMAND_VOICE.silk');
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('real Pi registers group resources and stages only its workspace sticker for explicit account management', async t => {
  const f = await fixture(t);
  const groupId = '444014';
  const conversation = `group:${groupId}`;
  const localSticker = 'LOCAL_WORKSPACE_STICKER_BYTES';
  const host = await f.host('explicit-resources', 'EXPLICIT_RESOURCE_RULES', [
    fauxAssistantMessage(fauxToolCall('qq_group_files', { action: 'list', conversation }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_group_files', { action: 'mkdir', conversation, name: 'Pi resources' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_album', { action: 'list', conversation }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'rename', emojiId: 'sticker-001', name: 'Renamed local sticker' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'add', conversation, path: 'assets/local-sticker.png' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The explicit resource operations are complete.'),
  ], async cwd => { await writeFile(join(cwd, 'assets', 'local-sticker.png'), localSticker); }, [{ type: 'group', id: groupId }]);
  for (const tool of ['qq_group_files', 'qq_album', 'qq_sticker']) assert.ok(host.session.getActiveToolNames().includes(tool));
  await host.session.prompt('List this group file and album, create a folder, and manage the chosen local sticker.');
  const resourceActions = ['get_group_root_files', 'create_group_file_folder', 'get_qun_album_list', 'modify_custom_face', 'download_file', 'add_custom_face'];
  const packets = host.socket.sent.filter(packet => resourceActions.includes(packet.action));
  assert.deepEqual(packets.map(packet => packet.action), resourceActions);
  assert.deepEqual(packets[0]!.params, { group_id: Number(groupId) });
  assert.deepEqual(packets[1]!.params, { group_id: Number(groupId), name: 'Pi resources', parent_id: '/' });
  assert.deepEqual(packets[2]!.params, { group_id: Number(groupId), attach_info: '' });
  assert.deepEqual(packets[3]!.params, { emoji_id: 'sticker-001', desc: 'Renamed local sticker' });
  assert.equal(packets[4]!.params.base64, Buffer.from(localSticker).toString('base64'));
  assert.match(String(packets[4]!.params.name), /^piq-[0-9a-f-]+\.png$/);
  assert.equal('url' in packets[4]!.params, false);
  assert.deepEqual(packets[5]!.params, { file: '/backend/temporary-sticker.png' });
  assert.ok(packets.every(packet => packet.params.group_id === undefined || packet.params.group_id === Number(groupId)));
  const results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 5);
  assert.ok(results.every(result => result.role === 'toolResult' && !result.isError));
  for (const marker of ['Local group file.txt', 'Local group album', 'added-sticker-001']) assert.match(JSON.stringify(results), new RegExp(marker.replaceAll('.', '\\.')));
  assert.equal(host.socket.sent.filter(packet => ['send_group_msg', 'send_private_msg'].includes(packet.action)).length, 0);
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('group resource tools refuse foreign scope and sibling assets, and all resource tools honor pause', async t => {
  const f = await fixture(t);
  const groupId = '444015';
  const conversation = `group:${groupId}`;
  const privateChat = 'private:444016';
  const outside = await initializeGroup(f.root, 'other-resources', { name: 'Other resource group', conversations: [] });
  await writeFile(join(outside, 'assets', 'private-sticker.png'), 'OTHER_GROUP_PRIVATE_ASSET_BYTES');
  const host = await f.host('resource-boundaries', 'RESOURCE_BOUNDARY_RULES', [
    fauxAssistantMessage(fauxToolCall('qq_group_files', { action: 'list', conversation: 'group:555111' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_group_files', { action: 'list', conversation: privateChat }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_album', { action: 'list', conversation: privateChat }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'add', path: '../other-resources/assets/private-sticker.png' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Invalid resource scopes were refused.'),
    fauxAssistantMessage(fauxToolCall('qq_group_files', { action: 'mkdir', conversation, name: 'Paused folder' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_album', { action: 'list', conversation }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'rename', emojiId: 'sticker-001', name: 'Paused rename' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_sticker', { action: 'add', path: 'assets/local-sticker.png' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Paused resource operations were refused.'),
  ], async cwd => { await writeFile(join(cwd, 'assets', 'local-sticker.png'), 'LOCAL_PAUSED_RESOURCE_BYTES'); },
  [{ type: 'group', id: groupId }, { type: 'private', id: '444016' }]);
  await host.session.prompt('Check group resource scope and local asset boundaries.');
  let results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 4);
  assert.ok(results.every(result => result.role === 'toolResult' && result.isError));
  const pause = await requestRunAction(host.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(host.cwd))?.requestId === pause.requestId, 'resource pause receipt');
  await host.session.prompt('Try all resource tools while the channel is paused.');
  results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 8);
  assert.ok(results.every(result => result.role === 'toolResult' && result.isError));
  assert.match(JSON.stringify(results.slice(4)), /PiQ 已暂停/);
  const resourceActions = ['get_group_root_files', 'create_group_file_folder', 'get_qun_album_list', 'modify_custom_face', 'download_file', 'add_custom_face'];
  assert.equal(host.socket.sent.filter(packet => resourceActions.includes(packet.action)).length, 0);
  assert.doesNotMatch(JSON.stringify(host.socket.sent), /OTHER_GROUP_PRIVATE_ASSET_BYTES|LOCAL_PAUSED_RESOURCE_BYTES/);
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('real Pi explicitly sends a local voice file to group, friend and temporary conversations with separate journals', async t => {
  const f = await fixture(t);
  const groupId = '444017';
  const peerId = '444018';
  const temporaryId = '444019';
  const conversations: Conversation[] = [
    { type: 'group', id: groupId }, { type: 'private', id: peerId },
    { type: 'temporary', sourceGroupId: groupId, id: temporaryId },
  ];
  const audio = Buffer.from('LOCAL_AUDIO_FILE_BYTES');
  const host = await f.host('local-voice-actions', 'LOCAL_VOICE_ACTIONS', [
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send_file', conversation: `group:${groupId}`, path: 'assets/reply.wav' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send_file', conversation: `private:${peerId}`, path: 'assets/reply.wav' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send_file', conversation: `temporary:${groupId}:${temporaryId}`, path: 'assets/reply.wav' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('This ordinary answer stays in Pi after the three explicit audio sends.'),
  ], async cwd => { await writeFile(join(cwd, 'assets', 'reply.wav'), audio); }, conversations);
  await host.session.prompt('Send the saved voice file explicitly to the three selected conversations.');
  const sends = host.socket.sent.filter(packet => ['send_group_msg', 'send_private_msg'].includes(packet.action));
  const message = [{ type: 'record', data: { file: `base64://${audio.toString('base64')}` } }];
  assert.deepEqual(sends.map(packet => [packet.action, packet.params]), [
    ['send_group_msg', { group_id: Number(groupId), message }],
    ['send_private_msg', { user_id: Number(peerId), message }],
    ['send_private_msg', { user_id: Number(temporaryId), group_id: Number(groupId), message }],
  ]);
  assert.equal(host.socket.sent.filter(packet => ['send_group_ai_record', 'download_file'].includes(packet.action)).length, 0);
  const results = host.session.messages.filter(record => record.role === 'toolResult' && record.toolName === 'qq_voice');
  assert.equal(results.length, 3);
  assert.ok(results.every(result => result.role === 'toolResult' && !result.isError));
  const ids = new Set<string>();
  for (const conversation of conversations) {
    const records = await conversationRecords(host.cwd, conversation);
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.deepEqual(record.conversation, conversation);
    assert.equal(record.outgoing, true);
    assert.equal(record.rawText, '[语音]');
    assert.equal(record.segments.length, 1);
    assert.equal(record.segments[0].type, 'record');
    assert.equal(record.segments[0].data.file, join(host.cwd, 'assets', 'reply.wav'));
    assert.match(record.messageId, /^-\d+$/);
    ids.add(record.messageId);
  }
  assert.equal(ids.size, 3, 'each send retains its distinct backend receipt');
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('local voice sending rejects outside files and cannot dispatch while paused or cancelled during reconnect', async t => {
  const f = await fixture(t);
  const groupId = '444020';
  const conversation = `group:${groupId}`;
  const sibling = await initializeGroup(f.root, 'other-audio', { name: 'Other audio group', conversations: [] });
  const outsideAudio = join(sibling, 'assets', 'private.wav');
  await writeFile(outsideAudio, 'OTHER_GROUP_AUDIO_BYTES');
  const host = await f.host('local-voice-boundaries', 'LOCAL_VOICE_BOUNDARIES', [
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send_file', conversation, path: '../other-audio/assets/private.wav' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send_file', conversation, path: outsideAudio }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send_file', conversation, path: 'https://invalid.test/voice.wav' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Outside files were refused.'),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send_file', conversation, path: 'assets/reply.wav' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The paused audio send was refused.'),
    fauxAssistantMessage(fauxToolCall('qq_voice', { action: 'send_file', conversation, path: 'assets/reply.wav' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('This response should be interrupted by cancellation.'),
  ], async cwd => { await writeFile(join(cwd, 'assets', 'reply.wav'), 'LOCAL_CANCELLABLE_AUDIO'); }, [{ type: 'group', id: groupId }]);
  await host.session.prompt('Check audio file scope before any external send.');
  let results = host.session.messages.filter(record => record.role === 'toolResult' && record.toolName === 'qq_voice');
  assert.equal(results.length, 3);
  assert.ok(results.every(result => result.role === 'toolResult' && result.isError));
  const pause = await requestRunAction(host.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(host.cwd))?.requestId === pause.requestId, 'local audio pause receipt');
  await host.session.prompt('Try to send the local voice file while paused.');
  results = host.session.messages.filter(record => record.role === 'toolResult' && record.toolName === 'qq_voice');
  assert.equal(results.length, 4);
  assert.ok(results.every(result => result.role === 'toolResult' && result.isError));
  assert.match(JSON.stringify(results[3]), /PiQ 已暂停/);
  const resume = await requestRunAction(host.cwd, 'resume');
  await eventually(async () => (await readRuntimeStatus(host.cwd))?.requestId === resume.requestId, 'local audio resume receipt');
  const socketsBefore = LocalSocket.instances.length;
  LocalSocket.autoOpen = false;
  host.socket.close();
  const sending = host.session.prompt('Send the local audio after reconnecting.');
  await eventually(() => LocalSocket.instances.length > socketsBefore, 'the audio action to wait on a fresh connection');
  assert.equal(host.faux.state.callCount, 7, 'the cancellable tool call has started, without a final assistant response');
  assert.equal(host.session.isIdle, false);
  await host.session.abort();
  await Promise.allSettled([sending]);
  assert.equal(host.session.isIdle, true);
  const sockets = [host.socket, ...LocalSocket.instances.slice(socketsBefore)];
  assert.equal(sockets.flatMap(socket => socket.sent).filter(packet => ['send_group_msg', 'send_private_msg'].includes(packet.action)).length, 0);
  assert.doesNotMatch(JSON.stringify(sockets.flatMap(socket => socket.sent)), /OTHER_GROUP_AUDIO_BYTES|LOCAL_CANCELLABLE_AUDIO/);
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('real Pi reads history and received forwards, explicitly forwards selected records, then reads its saved send', async t => {
  const f = await fixture(t);
  const groupId = '444021', peerId = '444022';
  const source = `group:${groupId}`, target = `private:${peerId}`;
  const ordinary = groupMessage(groupId, -301, 'HISTORY_SOURCE_BODY');
  const received = { ...groupMessage(groupId, -302, '[合并转发]'),
    message: [{ type: 'forward', data: { id: 'received-forward' } }] };
  LocalSocket.messages.set(-301, ordinary);
  LocalSocket.messages.set(-302, received);
  LocalSocket.forwards.set('received-forward', [{
    sender: { user_id: 77777, nickname: 'Original member' }, time: 1_700_000_000,
    message: [{ type: 'text', data: { text: 'INNER_FORWARDED_TEXT' } },
      { type: 'image', data: { url: 'https://qpic.cn/image?signature=PRIVATE_FORWARD_SIGNATURE' } }],
  }]);
  let host: Awaited<ReturnType<typeof f.host>>;
  host = await f.host('history-forward-flow', 'HISTORY_FORWARD_RULES', [
    fauxAssistantMessage(fauxToolCall('qq_read_history', { conversation: source, limit: 10 }), { stopReason: 'toolUse' }),
    () => {
      assert.equal(host.socket.sent.filter(packet => packet.action.startsWith('send_')).length, 0);
      return fauxAssistantMessage(fauxToolCall('qq_read_forward', { conversation: source, messageId: -302 }), { stopReason: 'toolUse' });
    },
    () => {
      assert.equal(host.socket.sent.filter(packet => packet.action.startsWith('send_')).length, 0);
      return fauxAssistantMessage(fauxToolCall('qq_forward', {
        sourceConversation: source, messageIds: [-301, -302], targetConversation: target,
      }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage(fauxToolCall('qq_read_history', { conversation: target, messageId: -900 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_read_forward', { conversation: target, messageId: -900 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('This ordinary response remains only in the Pi session.'),
  ], undefined, [{ type: 'group', id: groupId }, { type: 'private', id: peerId }]);
  for (const tool of ['qq_read_history', 'qq_read_forward', 'qq_forward']) assert.ok(host.session.getActiveToolNames().includes(tool));
  host.socket.receive(ordinary); host.socket.receive(received);
  await eventually(() => host.faux.state.callCount === 6 && host.session.isIdle, 'the history and explicit forward workflow to settle');
  const results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 5);
  assert.ok(results.every(result => result.role === 'toolResult' && !result.isError), JSON.stringify(results));
  const parsed = (index: number) => {
    const block = results[index]!.content.find(item => item.type === 'text');
    assert.ok(block && block.type === 'text');
    return JSON.parse(block.text) as { records: Array<Record<string, any>> };
  };
  assert.deepEqual(parsed(0).records.map(record => record.messageId), [-301, -302]);
  assert.equal(parsed(1).records[0]!.text, 'INNER_FORWARDED_TEXT');
  assert.ok(parsed(1).records[0]!.segments.some((segment: { hasImage?: boolean }) => segment.hasImage));
  assert.equal(parsed(3).records.length, 1);
  assert.equal(parsed(3).records[0]!.messageId, -900);
  assert.equal(parsed(3).records[0]!.outgoing, true);
  assert.equal(parsed(4).records[0]!.text, 'HISTORY_SOURCE_BODY');
  assert.equal(parsed(4).records.length, 2);
  assert.doesNotMatch(JSON.stringify(results), /PRIVATE_FORWARD_SIGNATURE/);
  assert.deepEqual(host.socket.sent.filter(packet => packet.action === 'get_forward_msg').map(packet => packet.params), [
    { id: 'received-forward' }, { id: 'sent-forward-900' },
  ]);
  const sends = host.socket.sent.filter(packet => packet.action.startsWith('send_'));
  assert.equal(sends.length, 1, 'only the explicit forward tool sends anything');
  assert.equal(sends[0]!.action, 'send_private_forward_msg');
  assert.deepEqual(sends[0]!.params, { user_id: Number(peerId), messages: [
    { type: 'node', data: { id: '-301' } }, { type: 'node', data: { id: '-302' } },
  ] });
  const sentRecords = await conversationRecords(host.cwd, { type: 'private', id: peerId });
  assert.equal(sentRecords.length, 1);
  assert.equal(sentRecords[0]!.messageId, '-900');
  assert.equal(sentRecords[0]!.outgoing, true);
  assert.deepEqual(sentRecords[0]!.segments, [{ type: 'forward', data: { id: 'sent-forward-900' } }]);
  assert.equal((await conversationRecords(host.cwd, { type: 'group', id: groupId })).length, 2);
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});

test('real Pi refuses foreign history and forward targets, and all three tools honor pause', async t => {
  const f = await fixture(t);
  const groupId = '444023', peerId = '444024';
  const source = `group:${groupId}`, target = `private:${peerId}`, foreign = 'group:555999';
  const host = await f.host('history-forward-boundaries', 'HISTORY_FORWARD_BOUNDARIES', [
    fauxAssistantMessage(fauxToolCall('qq_read_history', { conversation: foreign }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_read_forward', { conversation: foreign, messageId: -310 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_forward', { sourceConversation: foreign, messageIds: [-310], targetConversation: target }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_forward', { sourceConversation: source, messageIds: [-310], targetConversation: foreign }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Foreign conversations were refused.'),
    fauxAssistantMessage(fauxToolCall('qq_read_history', { conversation: source }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_read_forward', { conversation: source, messageId: -310 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_forward', { sourceConversation: source, messageIds: [-310], targetConversation: target }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Paused tools were refused.'),
  ], undefined, [{ type: 'group', id: groupId }, { type: 'private', id: peerId }]);
  await host.session.prompt('Check the history source and forwarding target boundaries.');
  let results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 4);
  assert.ok(results.every(result => result.role === 'toolResult' && result.isError));
  assert.match(JSON.stringify(results), /不属于当前对话组/);
  const pause = await requestRunAction(host.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(host.cwd))?.requestId === pause.requestId, 'history and forward pause receipt');
  await host.session.prompt('Try history reading, forward reading, and forwarding while paused.');
  results = host.session.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 7);
  assert.ok(results.every(result => result.role === 'toolResult' && result.isError));
  assert.match(JSON.stringify(results.slice(4)), /PiQ 已暂停/);
  assert.equal(host.socket.sent.filter(packet => packet.action === 'get_forward_msg' || packet.action.startsWith('send_')).length, 0);
  assert.deepEqual(host.errors, []); assert.deepEqual(host.notifications, []);
});
