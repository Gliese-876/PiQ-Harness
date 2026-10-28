import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionError,
} from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep } from '@earendil-works/pi-ai';
import { initializeGroup } from '../src/config.ts';
import { conversationDirectory, conversationKey, type Conversation } from '../src/conversations.ts';
import piq, { type PiQOptions } from '../src/extension.ts';
import { readRuntimeStatus, RunController } from '../src/run-control.ts';
import type { IncomingRecord, StoredMessage } from '../src/store.ts';

type ChannelSettings = Parameters<NonNullable<PiQOptions['createTransport']>>[0];
type Channel = ReturnType<NonNullable<PiQOptions['createTransport']>>;

/** The real Pi runtime and extension run against this explicitly injected channel boundary. */
class FakeChannel implements Channel {
  isConnected = false;
  closed = false;
  readonly sent: Array<{ conversation: Conversation; input: Parameters<Channel['send']>[1] }> = [];
  readonly media: Array<{ conversation: Conversation; input: Parameters<Channel['sendMedia']>[1] }> = [];
  readonly options: ChannelSettings;
  readonly connectImmediately: boolean;
  constructor(options: ChannelSettings, connectImmediately = true) { this.options = options; this.connectImmediately = connectImmediately; }
  async connect() { if (this.connectImmediately) this.status('connected'); }
  close() { this.closed = true; this.isConnected = false; this.options.onStatus?.('disconnected'); }
  status(value: 'connected' | 'disconnected' | 'error') {
    this.isConnected = value === 'connected'; this.options.onStatus?.(value);
  }
  receive(record: IncomingRecord) { this.options.onMessage?.({ ...record, attachments: record.attachments ?? [], raw: record.raw ?? {} }); }
  async send(conversation: Conversation, input: Parameters<Channel['send']>[1], signal?: AbortSignal) {
    signal?.throwIfAborted();
    assert.ok(this.isConnected, 'tests may only dispatch through their connected fake channel');
    this.sent.push({ conversation, input }); return { messageId: `sent-text-${this.sent.length}`, raw: {} };
  }
  async sendMedia(conversation: Conversation, input: Parameters<Channel['sendMedia']>[1], signal?: AbortSignal) {
    signal?.throwIfAborted();
    assert.ok(this.isConnected, 'tests may only dispatch through their connected fake channel');
    this.media.push({ conversation, input }); return { messageId: `sent-file-${this.media.length}`, raw: {} };
  }
  async request(): Promise<never> { assert.fail('This integration suite does not dispatch raw QQ API requests'); }
  async sendRich(): Promise<never> { assert.fail('This integration suite does not dispatch rich QQ messages'); }
}

function message(conversation: Conversation, id: string, text: string, extra: Partial<IncomingRecord> = {}): IncomingRecord {
  return { conversation, messageId: id, selfId: 'synthetic-application', userId: 'opaque-member', sender: 'Test member',
    time: Math.floor(Date.now() / 1000), rawText: text, outgoing: false,
    raw: { id, content: text, author: { id: 'opaque-member' } }, ...extra };
}

async function records(cwd: string, conversation: Conversation): Promise<StoredMessage[]> {
  const directory = join(cwd, conversationDirectory(conversation));
  const names = await readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const contents = await Promise.all(names.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(directory, name), 'utf8')));
  return contents.flatMap(text => text.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line) as StoredMessage));
}

async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 8_000;
  while (!await check()) { if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${label}`); await delay(10); }
}

async function fixture(t: TestContext) {
  const variables = ['PIQ_TERMINAL_RETURN_TOKEN', 'PIQ_TERMINAL_WRAPPER_PID', 'PIQ_RUN_MODE', 'PIQ_START_RUNNING'];
  const saved = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External network is disabled in Pi integration tests'); });
  const parent = join(process.cwd(), '.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'official-pi-host-'));
  const sessions: AgentSession[] = [];
  t.after(async () => {
    try {
      for (const session of sessions.reverse()) {
        await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
      }
    } finally {
      for (const name of variables) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
      await rm(root, { recursive: true, force: true });
    }
  });
  async function host(id: string, responses: FauxResponseStep[], options: {
    conversations?: Conversation[]; prepare?: (cwd: string) => Promise<void>; credentials?: boolean; offline?: boolean; accountConflict?: boolean;
    claimAccount?: PiQOptions['claimAccount']; captureSession?: (session: AgentSession) => void; skipReadyCheck?: boolean;
  } = {}) {
    const conversations = options.conversations ?? [{ type: 'group' as const, id: `opaque-${id}` }];
    const cwd = await initializeGroup(root, id, { name: id, conversations });
    await writeFile(join(cwd, 'PIQ.md'), '# Test group\n```json\n' + JSON.stringify({ id, name: id, conversations,
      quietMs: 80, maxWaitMs: 500, minIntervalMs: 0 }) + '\n```\n');
    await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ packages: [] }));
    await writeFile(join(cwd, 'AGENTS.md'), `# Group instructions\n\nRULES_ONLY_FOR_${id}\n`);
    await options.prepare?.(cwd);
    const agentDir = join(root, `agent-${id}`); await mkdir(agentDir);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } }));
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const channels: FakeChannel[] = [];
    let settledTurns = 0;
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [api => {
      piq(api, {
        readManagedCredentials: async directory => {
          assert.equal(directory, cwd);
          return options.credentials === false ? { appId: '', hasSecret: false, available: false }
            : { appId: 'synthetic-application', appSecret: 'synthetic-secret-never-sent', hasSecret: true, available: true };
        },
        claimAccount: options.claimAccount ?? (async () => { if (options.accountConflict) throw new Error('同一 AppID 已有 PiQ 对话组运行，请先结束该组后再启动。'); return async () => {}; }),
        createTransport: settings => { const channel = new FakeChannel(settings, !options.offline); channels.push(channel); return channel; },
      });
      api.on('agent_settled', () => { settledTurns++; });
    }] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const faux = fauxProvider({ provider: `piq-local-${id}`, tokensPerSecond: 1_000_000 }); faux.setResponses(responses);
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, '.pi', 'sessions')) });
    sessions.push(session);
    const errors: ExtensionError[] = [], notices: string[] = [];
    t.mock.method(session.extensionRunner.createContext().ui, 'notify', (text: string) => { notices.push(text); });
    options.captureSession?.(session);
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    if (!options.skipReadyCheck) await eventually(async () => {
      const state = await readRuntimeStatus(cwd);
      return options.credentials === false || options.accountConflict ? state?.connection === 'error'
        : options.offline ? channels.length === 1 : state?.connection === 'connected';
    }, 'the isolated extension to initialize');
    return { id, cwd, conversations, session, faux, channels, errors, notices, get settledTurns() { return settledTurns; } };
  }
  return { root, host };
}

const signals = (session: AgentSession) => session.messages.filter(item => item.role === 'custom' && item.customType === 'piq:messages');

test('real Pi receives a compact signal, reads original JSONL, and sends only an explicit reply', async t => {
  const f = await fixture(t), firstConversation: Conversation = { type: 'group', id: 'opaque-first' };
  const requests: string[] = [];
  const first = await f.host('first', [
    async context => {
      requests.push(JSON.stringify(context));
      const directory = conversationDirectory(firstConversation);
      const files = await readdir(join(f.root, 'first', directory));
      return fauxAssistantMessage(fauxToolCall('read', { path: join(directory, files[0]!) }), { stopReason: 'toolUse' });
    },
    context => { requests.push(JSON.stringify(context)); return fauxAssistantMessage(fauxToolCall('qq_send', {
      conversation: conversationKey(firstConversation), text: 'Explicit reply', replyTo: 'incoming-1',
    }), { stopReason: 'toolUse' }); },
    fauxAssistantMessage('Ordinary assistant output remains in Pi.'),
  ]);
  const second = await f.host('second', [fauxAssistantMessage('No external reply needed.')]);
  assert.match(first.session.systemPrompt, /RULES_ONLY_FOR_first/);
  assert.doesNotMatch(first.session.systemPrompt, /RULES_ONLY_FOR_second/);
  for (const tool of ['qq_send', 'qq_send_file']) assert.ok(first.session.getActiveToolNames().includes(tool));
  for (let i = 1; i <= 3; i++) first.channels[0]!.receive(message(firstConversation, `incoming-${i}`, `FIRST_GROUP_BODY_${i}`,
    i === 3 ? { attachments: [{ content_type: 'image/png', url: 'https://example.invalid/picture.png' }] } : {}));
  first.channels[0]!.receive(message(second.conversations[0]!, 'foreign-1', 'FOREIGN_GROUP_BODY'));
  second.channels[0]!.receive(message(firstConversation, 'foreign-2', 'FIRST_GROUP_BODY'));
  second.channels[0]!.receive(message(second.conversations[0]!, 'second-1', 'SECOND_GROUP_BODY'));
  await eventually(() => first.faux.state.callCount === 3 && second.faux.state.callCount === 1
    && first.session.isIdle && second.session.isIdle, 'both real Pi runs to settle');
  assert.equal(signals(first.session).length, 1);
  assert.doesNotMatch(JSON.stringify(signals(first.session)), /FIRST_GROUP_BODY/);
  assert.doesNotMatch(requests[0]!, /FIRST_GROUP_BODY/);
  assert.match(requests[1]!, /FIRST_GROUP_BODY_3/);
  assert.match(requests[1]!, /image\/png/);
  assert.doesNotMatch(JSON.stringify(first.session.messages), /FOREIGN_GROUP_BODY|SECOND_GROUP_BODY|synthetic-secret-never-sent/);
  assert.equal(first.channels[0]!.sent.length, 1); assert.equal(second.channels[0]!.sent.length, 0);
  assert.equal(first.channels[0]!.sent[0]!.input.replyTo, 'incoming-1');
  const written = await records(first.cwd, firstConversation);
  assert.equal(written.length, 4); assert.equal(written.filter(record => record.outgoing).length, 1);
  assert.deepEqual(written[2]!.attachments, [{ content_type: 'image/png', url: 'https://example.invalid/picture.png' }]);
  assert.equal(written[0]!.raw!.content, 'FIRST_GROUP_BODY_1');
  assert.deepEqual(await records(first.cwd, second.conversations[0]!), []);
  assert.deepEqual(first.errors, []); assert.deepEqual(first.notices, []); assert.deepEqual(second.errors, []);
});

test('inbound delivery waits for persistence and exposes failure without blocking later events', async t => {
  const f = await fixture(t);
  const host = await f.host('delivery', []);
  const channel = host.channels[0]!;
  const conversation = host.conversations[0]!;
  const deliver = (record: IncomingRecord) => Promise.resolve(channel.options.onMessage({ ...record, attachments: [], raw: record.raw ?? {} }));
  await assert.rejects(deliver(message(conversation, 'wrong-account', 'Must fail', { selfId: 'another-application', botAuthored: true })));
  await deliver(message(conversation, 'persisted-next', 'Durably received', { botAuthored: true }));
  const saved = await records(host.cwd, conversation);
  assert.deepEqual(saved.map(record => record.messageId), ['persisted-next']);
  assert.ok(host.notices.some(text => text.includes('接收消息')));
  assert.equal(signals(host.session).length, 0);
});

test('one session aggregates group and private records while preserving their distinct identities', async t => {
  const f = await fixture(t);
  const conversations: Conversation[] = [{ type: 'group', id: 'same-opaque-id' }, { type: 'private', id: 'same-opaque-id' }];
  const host = await f.host('shared', [
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: conversationKey(conversations[1]!), text: 'Reply to private only' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: 'group:outside-group', text: 'Must be blocked' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Finished.'),
  ], { conversations });
  for (const conversation of conversations) {
    const event = message(conversation, 'same-message-id', 'Shared source text');
    host.channels[0]!.receive(event); host.channels[0]!.receive(event);
  }
  await eventually(() => host.faux.state.callCount === 3 && host.session.isIdle, 'shared conversation processing');
  assert.equal(signals(host.session).length, 1); assert.match(JSON.stringify(signals(host.session)), /2 条新消息/);
  assert.equal((await records(host.cwd, conversations[0]!)).length, 1);
  assert.equal((await records(host.cwd, conversations[1]!)).length, 2);
  assert.equal(host.channels[0]!.sent.length, 1);
  assert.equal(host.channels[0]!.sent[0]!.conversation.type, 'private');
  assert.match(JSON.stringify(host.session.messages), /不属于当前对话组/);
  assert.deepEqual(host.errors, []);
});

test('reload closes the former receiver and preserves the acknowledged message watermark', async t => {
  const f = await fixture(t);
  const host = await f.host('reload', [fauxAssistantMessage('First message acknowledged.'), fauxAssistantMessage('Second message acknowledged.')]);
  const previous = host.channels[0]!;
  previous.receive(message(host.conversations[0]!, 'before-reload', 'BEFORE_RELOAD'));
  await eventually(() => host.faux.state.callCount === 1 && host.session.isIdle && host.settledTurns === 1, 'first settled turn');
  const stateBefore = JSON.parse(await readFile(join(host.cwd, '.piq', 'state-v3.json'), 'utf8'));
  assert.equal(stateBefore.notifiedThrough, 1);
  await host.session.reload();
  await eventually(() => host.channels.length === 2 && host.channels[1]!.isConnected, 'replacement receiver');
  assert.equal(previous.closed, true);
  await delay(150); assert.equal(host.faux.state.callCount, 1, 'an acknowledged message must not wake the reloaded session again');
  previous.receive(message(host.conversations[0]!, 'stale-receiver', 'STALE_RECEIVER_TEXT'));
  host.channels[1]!.receive(message(host.conversations[0]!, 'after-reload', 'AFTER_RELOAD'));
  await eventually(() => host.faux.state.callCount === 2 && host.session.isIdle && host.settledTurns === 2, 'replacement receiver turn');
  const journal = await records(host.cwd, host.conversations[0]!);
  assert.equal(journal.length, 2); assert.ok(!journal.some(record => record.rawText === 'STALE_RECEIVER_TEXT'));
  assert.equal(JSON.parse(await readFile(join(host.cwd, '.piq', 'state-v3.json'), 'utf8')).notifiedThrough, 2);
  assert.deepEqual(host.errors, []);
});

test('messages keep accumulating during a model turn and produce one follow-up signal', async t => {
  const f = await fixture(t);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const host = await f.host('busy', [async () => { await gate; return fauxAssistantMessage('First run completed.'); }, fauxAssistantMessage('Batch considered.')]);
  try {
    host.channels[0]!.receive(message(host.conversations[0]!, 'first', 'START_BUSY'));
    await eventually(() => host.faux.state.callCount === 1 && !host.session.isIdle, 'busy model');
    for (let i = 0; i < 8; i++) host.channels[0]!.receive(message(host.conversations[0]!, `busy-${i}`, `WHILE_BUSY_${i}`));
    await eventually(async () => (await records(host.cwd, host.conversations[0]!)).length === 9, 'records saved during the turn');
    await delay(150); assert.equal(host.faux.state.callCount, 1);
    release();
    await eventually(() => host.faux.state.callCount === 2 && host.session.isIdle, 'one aggregated follow-up');
    assert.equal(signals(host.session).length, 2);
    assert.match(JSON.stringify(signals(host.session)[1]), /8 条新消息/);
    assert.doesNotMatch(JSON.stringify(signals(host.session)), /WHILE_BUSY_/);
    assert.equal(host.channels[0]!.sent.length, 0);
    assert.deepEqual(host.errors, []);
  } finally { release(); }
});

test('file sending accepts four media kinds inside the group and rejects foreign destinations or paths', async t => {
  const f = await fixture(t), kinds = ['image', 'voice', 'video', 'file'] as const;
  const conversation: Conversation = { type: 'group', id: 'opaque-media' };
  const responses: FauxResponseStep[] = kinds.map(kind => fauxAssistantMessage(fauxToolCall('qq_send_file', {
    conversation: conversationKey(conversation), kind, path: `assets/${kind}.bin`, replyTo: 'media-trigger', fileName: `${kind}.bin`,
  }), { stopReason: 'toolUse' }));
  responses.push(
    fauxAssistantMessage(fauxToolCall('qq_send_file', { conversation: conversationKey(conversation), kind: 'file', path: '../outside.bin' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_send_file', { conversation: 'private:outside', kind: 'file', path: 'assets/file.bin' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Only explicit local files were dispatched.'),
  );
  const host = await f.host('media', responses, { prepare: async cwd => {
    for (const kind of kinds) await writeFile(join(cwd, 'assets', `${kind}.bin`), `test ${kind}`);
    await writeFile(join(f.root, 'outside.bin'), 'outside this group');
  } });
  host.channels[0]!.receive(message(conversation, 'media-trigger', 'SELECT_MEDIA'));
  await eventually(() => host.faux.state.callCount === 7 && host.session.isIdle, 'all media tools');
  assert.deepEqual(host.channels[0]!.media.map(item => item.input.kind), kinds);
  for (const item of host.channels[0]!.media) {
    assert.ok(item.input.path.startsWith(join(host.cwd, 'assets')));
    assert.equal(item.input.replyTo, 'media-trigger');
  }
  const toolResults = host.session.messages.filter(item => item.role === 'toolResult');
  assert.equal(toolResults.filter(item => item.isError).length, 2);
  assert.equal((await records(host.cwd, conversation)).filter(item => item.outgoing).length, 4);
  assert.deepEqual(host.errors, []);
});

test('missing application credentials stay visible in runtime status and never create a transport', async t => {
  const f = await fixture(t);
  const host = await f.host('missing-credentials', [fauxAssistantMessage('Local Pi remains available.')], { credentials: false });
  assert.equal(host.channels.length, 0);
  const status = await readRuntimeStatus(host.cwd);
  assert.equal(status?.connection, 'error');
  assert.match(status?.lastError ?? '', /AppID|AppSecret|凭据|连接设置/);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-secret-never-sent/);
  await host.session.prompt('Work locally without QQ credentials.');
  assert.equal(host.faux.state.callCount, 1); assert.equal(host.channels.length, 0);
  assert.deepEqual(host.errors, []);
});

test('an account ownership conflict is visible before a second official gateway can be created', async t => {
  const f = await fixture(t);
  const host = await f.host('account-conflict', [], { accountConflict: true });
  assert.equal(host.channels.length, 0);
  const status = await readRuntimeStatus(host.cwd);
  assert.equal(status?.connection, 'error');
  assert.match(status?.lastError ?? '', /同一 AppID/);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-secret-never-sent/);
  assert.equal(host.faux.state.callCount, 0);
  assert.deepEqual(host.errors, []);
});

test('an explicit send before the first incoming event records the configured bot identity', async t => {
  const f = await fixture(t);
  const host = await f.host('first-send', [
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: 'group:opaque-first-send', text: 'A deliberate first send' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Completed.'),
  ]);
  await host.session.prompt('Send the explicitly requested greeting.');
  await eventually(() => host.settledTurns === 1, 'the explicit send turn');
  assert.equal(host.channels[0]!.sent.length, 1);
  const written = await records(host.cwd, host.conversations[0]!);
  assert.equal(written.length, 1);
  assert.equal(written[0]!.outgoing, true);
  assert.equal(written[0]!.selfId, 'synthetic-application');
  assert.doesNotMatch(JSON.stringify(host.session.messages), /本地日志写入失败/);
  assert.equal(signals(host.session).length, 0);
});

test('shutdown during the asynchronous settled hook does not reuse its retired binding', async t => {
  const f = await fixture(t);
  let reached = false, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = RunController.prototype.markBusy;
  t.mock.method(RunController.prototype, 'markBusy', async function (this: RunController, busy: boolean) {
    await original.call(this, busy);
    if (!busy && !reached) { reached = true; await gate; }
  });
  const host = await f.host('settled-close', [fauxAssistantMessage('The response is complete.')]);
  try {
    host.channels[0]!.receive(message(host.conversations[0]!, 'before-shutdown', 'Finish before closing'));
    await eventually(() => reached, 'the paused settled hook');
    await host.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    release();
    await eventually(() => host.settledTurns === 1, 'the retired hook to return');
    assert.equal(host.channels[0]!.closed, true);
    assert.deepEqual(host.errors, []);
    await assert.rejects(readFile(join(host.cwd, '.piq', 'owner.lock')), { code: 'ENOENT' });
  } finally { release(); }
});

for (const rejectClaim of [false, true]) {
  test(`shutdown while account ownership is pending ${rejectClaim ? 'ignores a late rejection' : 'releases a late claim without starting a gateway'}`, async t => {
    const f = await fixture(t);
    let session: AgentSession | undefined, claimStarted = false, releases = 0;
    let settle = () => {};
    const claim = new Promise<() => Promise<void>>((resolveClaim, reject) => {
      settle = () => rejectClaim ? reject(new Error('late simulated account failure'))
        : resolveClaim(async () => { releases++; });
    });
    const opening = f.host(rejectClaim ? 'claim-rejected' : 'claim-acquired', [], {
      claimAccount: async () => { claimStarted = true; return claim; },
      captureSession: value => { session = value; }, skipReadyCheck: true,
    });
    try {
      await eventually(() => claimStarted && !!session, 'the pending account claim');
      await session!.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      settle();
      const host = await opening;
      assert.equal(releases, rejectClaim ? 0 : 1);
      assert.equal(host.channels.length, 0);
      assert.equal(host.faux.state.callCount, 0);
      assert.deepEqual(host.errors, []); assert.deepEqual(host.notices, []);
      await assert.rejects(readFile(join(host.cwd, '.piq', 'owner.lock')), { code: 'ENOENT' });
    } finally { settle(); await opening; }
  });
}
