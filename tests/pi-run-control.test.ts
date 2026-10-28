import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionError } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep } from '@earendil-works/pi-ai';
import { initializeGroup } from '../src/config.ts';
import { conversationDirectory, type Conversation } from '../src/conversations.ts';
import piq, { type PiQOptions } from '../src/extension.ts';
import { GroupStore, type IncomingRecord } from '../src/store.ts';
import { readRuntimeStatus, requestRunAction } from '../src/run-control.ts';
import { clearTerminalLaunch, prepareTerminalLaunch } from '../src/terminal-monitor.ts';

type ChannelSettings = Parameters<NonNullable<PiQOptions['createTransport']>>[0];
type Channel = ReturnType<NonNullable<PiQOptions['createTransport']>>;
const conversation: Conversation = { type: 'group', id: 'opaque-control-group' };
const target = 'group:opaque-control-group';
function message(id: string, text = 'Independent incoming text'): IncomingRecord {
  return { conversation, messageId: id, selfId: 'synthetic-application', userId: 'opaque-member', sender: 'Member',
    time: Math.floor(Date.now() / 1000), rawText: text, outgoing: false, raw: { id, content: text } };
}

class FakeChannel implements Channel {
  isConnected = false; closed = false;
  sent = 0; mediaSent = 0; mediaStarted = 0; mediaSignal?: AbortSignal;
  readonly options: ChannelSettings;
  readonly offline: boolean;
  readonly holdMedia: boolean;
  constructor(options: ChannelSettings, offline: boolean, holdMedia: boolean) {
    this.options = options; this.offline = offline; this.holdMedia = holdMedia;
  }
  async connect() { if (!this.offline) this.status('connected'); }
  close() { this.closed = true; this.isConnected = false; this.options.onStatus?.('disconnected'); }
  status(value: 'connected' | 'disconnected' | 'error') { this.isConnected = value === 'connected'; this.options.onStatus?.(value); }
  receive(event: IncomingRecord) { this.options.onMessage?.({ ...event, attachments: event.attachments ?? [], raw: event.raw ?? {} }); }
  async send(_conversation: Conversation, _input: Parameters<Channel['send']>[1], signal?: AbortSignal) {
    signal?.throwIfAborted(); assert.ok(this.isConnected); this.sent++; return { messageId: `text-${this.sent}`, raw: {} };
  }
  async sendMedia(_conversation: Conversation, _input: Parameters<Channel['sendMedia']>[1], signal?: AbortSignal) {
    signal?.throwIfAborted(); this.mediaStarted++; this.mediaSignal = signal;
    if (this.holdMedia) {
      assert.ok(signal, 'PiQ must pass its cancellation signal into the channel');
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    signal?.throwIfAborted(); assert.ok(this.isConnected); this.mediaSent++; return { messageId: `file-${this.mediaSent}`, raw: {} };
  }
  async request(): Promise<never> { assert.fail('This control suite does not dispatch raw QQ API requests'); }
  async sendRich(): Promise<never> { assert.fail('This control suite does not dispatch rich QQ messages'); }
}

async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 8_000;
  while (!await check()) { if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${label}`); await delay(10); }
}

async function fixture(t: TestContext, responses: FauxResponseStep[], options: {
  offline?: boolean; pending?: boolean; holdMedia?: boolean; managedTerminal?: boolean;
} = {}) {
  const keys = ['PIQ_TERMINAL_RETURN_TOKEN', 'PIQ_TERMINAL_WRAPPER_PID', 'PIQ_RUN_MODE', 'PIQ_START_RUNNING'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External network is disabled in Pi control tests'); });
  const parent = join(process.cwd(), '.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'official-pi-control-'));
  const config = { id: 'control', name: 'Control', conversations: [conversation],
    quietMs: 50, maxWaitMs: 250, minIntervalMs: 0 };
  const cwd = await initializeGroup(root, config.id, { name: config.name, conversations: config.conversations });
  await writeFile(join(cwd, 'PIQ.md'), '# Test\n```json\n' + JSON.stringify(config) + '\n```\n');
  await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ packages: [] }));
  await writeFile(join(cwd, 'assets', 'voice.wav'), 'synthetic local media');
  if (options.managedTerminal) {
    const lease = await prepareTerminalLaunch(cwd);
    process.env.PIQ_TERMINAL_RETURN_TOKEN = lease.token;
    process.env.PIQ_TERMINAL_WRAPPER_PID = String(process.pid);
    process.env.PIQ_RUN_MODE = 'terminal';
  }
  if (options.pending) {
    const store = await GroupStore.open(cwd, config, 'synthetic-application');
    try { await store.append(message('already-persisted', 'Previously received message')); } finally { await store.close(); }
  }
  const agentDir = join(root, 'agent'); await mkdir(agentDir);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } }));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const channels: FakeChannel[] = [];
  let settledTurns = 0;
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [api => {
    piq(api, { claimAccount: async () => async () => {},
      readManagedCredentials: async directory => {
        assert.equal(directory, cwd);
        return { appId: 'synthetic-application', appSecret: 'synthetic-secret', hasSecret: true, available: true };
      },
      createTransport: settings => { const channel = new FakeChannel(settings, options.offline === true, options.holdMedia === true); channels.push(channel); return channel; } });
    api.on('agent_settled', () => { settledTurns++; });
  }] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const faux = fauxProvider({ provider: 'piq-local-control', tokensPerSecond: 1_000_000 }); faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  let session: AgentSession;
  const errors: ExtensionError[] = [], notices: string[] = [];
  const start = async (resume: boolean) => {
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader,
      sessionManager: resume ? SessionManager.continueRecent(cwd, join(cwd, '.pi', 'sessions')) : SessionManager.create(cwd, join(cwd, '.pi', 'sessions')) }));
    t.mock.method(session.extensionRunner.createContext().ui, 'notify', (text: string) => { notices.push(text); });
    await session.bindExtensions({ mode: 'print', shutdownHandler: () => {}, onError: error => errors.push(error) });
    await eventually(() => channels.length > 0, 'the fake official channel');
    if (!options.offline) await eventually(async () => (await readRuntimeStatus(cwd))?.connection === 'connected', 'connected state');
  };
  const stop = async () => {
    if (!session) return;
    await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
  };
  t.after(async () => {
    try { await stop(); if (options.managedTerminal) await clearTerminalLaunch(cwd); }
    finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await rm(root, { recursive: true, force: true });
    }
  });
  await start(false);
  return { cwd, faux, channels, errors, notices, get session() { return session; }, get settledTurns() { return settledTurns; },
    restart: async () => { await stop(); await loader.reload(); await start(true); }, stop };
}

async function action(cwd: string, kind: 'pause' | 'resume') {
  const request = await requestRunAction(cwd, kind);
  await eventually(async () => (await readRuntimeStatus(cwd))?.requestId === request.requestId, `${kind} acknowledgement`);
}

async function journal(cwd: string) {
  const directory = join(cwd, conversationDirectory(conversation));
  const names = await readdir(directory);
  return (await Promise.all(names.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(directory, name), 'utf8'))))
    .flatMap(text => text.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

test('pause keeps collecting, refuses text and file sends, and resume delivers one aggregate', async t => {
  const f = await fixture(t, [
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: target, text: 'blocked while paused' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('qq_send_file', { conversation: target, kind: 'voice', path: 'assets/voice.wav' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Both sends were blocked.'), fauxAssistantMessage('The accumulated messages are now available.'),
  ]);
  await action(f.cwd, 'pause'); assert.equal((await readRuntimeStatus(f.cwd))?.paused, true);
  for (let i = 0; i < 4; i++) f.channels[0]!.receive(message(`paused-${i}`));
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.pendingCount === 4, 'paused records');
  await delay(150); assert.equal(f.faux.state.callCount, 0);
  await f.session.prompt('Attempt both explicitly requested QQ sends.');
  assert.equal(f.channels[0]!.sent, 0); assert.equal(f.channels[0]!.mediaStarted, 0);
  assert.equal(f.session.messages.filter(item => item.role === 'toolResult' && item.isError).length, 2);
  await action(f.cwd, 'resume');
  await eventually(() => f.faux.state.callCount === 4 && f.session.isIdle, 'one resumed model turn');
  const signals = f.session.messages.filter(item => item.role === 'custom' && item.customType === 'piq:messages');
  assert.equal(signals.length, 1); assert.match(JSON.stringify(signals), /4 条新消息/);
  assert.equal((await journal(f.cwd)).length, 4);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.notices, []);
});

test('persisted messages wait for an official channel connection before waking Pi', async t => {
  const f = await fixture(t, [fauxAssistantMessage('The channel is connected now.')], { offline: true, pending: true });
  await delay(150); assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.session.messages.filter(item => item.role === 'custom').length, 0);
  f.channels[0]!.status('connected');
  await eventually(() => f.faux.state.callCount === 1 && f.session.isIdle, 'pending notification after reconnect');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.pendingCount === 0, 'persisted acknowledgement');
  assert.deepEqual(f.errors, []); assert.deepEqual(f.notices, []);
});

test('pausing an active model turn aborts it and resume continues without a new incoming message', async t => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, [async () => { await gate; return fauxAssistantMessage('Interrupted response.'); }, fauxAssistantMessage('Resumed work.')]);
  try {
    f.channels[0]!.receive(message('start-active'));
    await eventually(() => f.faux.state.callCount === 1 && !f.session.isIdle, 'active model turn');
    await action(f.cwd, 'pause'); release();
    await eventually(() => f.session.isIdle, 'aborted turn');
    assert.ok(f.session.messages.some(item => item.role === 'assistant' && item.stopReason === 'aborted'));
    await action(f.cwd, 'resume');
    await eventually(() => f.faux.state.callCount === 2 && f.session.isIdle, 'resume without another event');
    assert.equal(f.session.messages.filter(item => item.role === 'custom' && item.customType === 'piq:resume').length, 1);
    assert.equal(f.channels[0]!.sent, 0); assert.deepEqual(f.errors, []);
  } finally { release(); }
});

test('pausing while a file send waits aborts the exact channel signal before dispatch', async t => {
  const f = await fixture(t, [
    fauxAssistantMessage(fauxToolCall('qq_send_file', { conversation: target, kind: 'voice', path: 'assets/voice.wav', replyTo: 'send-trigger' }), { stopReason: 'toolUse' }),
  ], { holdMedia: true });
  f.channels[0]!.receive(message('send-trigger'));
  await eventually(() => f.channels[0]!.mediaStarted === 1, 'a pending media send');
  await action(f.cwd, 'pause');
  await eventually(() => f.session.isIdle, 'cancelled send to settle');
  assert.equal(f.channels[0]!.mediaSignal?.aborted, true);
  assert.equal(f.channels[0]!.mediaSent, 0);
  assert.equal((await journal(f.cwd)).filter(item => item.outgoing).length, 0);
  assert.deepEqual(f.errors, []);
});

test('manual reopen preserves the Pi conversation and receives only through the replacement channel', async t => {
  const f = await fixture(t, [fauxAssistantMessage('PERSISTED_ASSISTANT_CONTEXT'), context => {
    assert.match(JSON.stringify(context), /PERSISTED_ASSISTANT_CONTEXT/);
    return fauxAssistantMessage('New event after reopening.');
  }]);
  f.channels[0]!.receive(message('before-close'));
  await eventually(() => f.faux.state.callCount === 1 && f.session.isIdle && f.settledTurns === 1, 'first settled session turn');
  const sessionFile = f.session.sessionFile;
  const old = f.channels[0]!;
  await f.restart();
  assert.equal(old.closed, true); assert.equal(f.session.sessionFile, sessionFile);
  old.receive(message('stale-after-close'));
  f.channels[1]!.receive(message('after-reopen'));
  await eventually(() => f.faux.state.callCount === 2 && f.session.isIdle && f.settledTurns === 2, 'reopened session turn');
  assert.deepEqual((await journal(f.cwd)).map(item => item.messageId), ['before-close', 'after-reopen']);
  await f.stop();
  await assert.rejects(readFile(join(f.cwd, '.piq', 'owner.lock')), { code: 'ENOENT' });
  assert.deepEqual(f.errors, []);
});

test('a managed terminal records the real Pi owner and preserves terminal runtime mode', async t => {
  const f = await fixture(t, [fauxAssistantMessage('No model call needed.')], { managedTerminal: true });
  const lease = JSON.parse(await readFile(join(f.cwd, '.piq', 'terminal-return.json'), 'utf8'));
  assert.equal(lease.wrapperPid, process.pid); assert.equal(lease.piPid, process.pid);
  assert.equal((await readRuntimeStatus(f.cwd))?.mode, 'terminal');
  assert.equal(f.faux.state.callCount, 0);
});
