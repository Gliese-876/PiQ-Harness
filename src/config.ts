import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { conversationKey, parseConversationKey, validateConversation, type Conversation } from './conversations.ts';

export interface GroupConfig {
  id: string;
  name: string;
  conversations: Conversation[];
  appIdEnv: string;
  appSecretEnv: string;
  groupMemberEvents: boolean;
  quietMs: number;
  maxWaitMs: number;
  minIntervalMs: number;
}

export const DEFAULTS: Omit<GroupConfig, 'id' | 'name' | 'conversations'> = {
  appIdEnv: 'QQBOT_APP_ID', appSecretEnv: 'QQBOT_APP_SECRET',
  groupMemberEvents: false,
  quietMs: 1_500, maxWaitMs: 10_000, minIntervalMs: 15_000,
};
export class ConfigError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const codeIs = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const revision = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateGroupId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) {
    throw new Error('对话组标识须为 1 到 64 位小写字母、数字、下划线或连字符，不能使用系统保留名称。');
  }
  return value;
}

export function validateConfig(value: unknown): GroupConfig {
  if (!object(value)) throw new Error('PIQ.md 的 JSON 必须是配置对象。');
  const allowed = new Set(['id', 'name', 'conversations', ...Object.keys(DEFAULTS)]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('PIQ.md 含未知配置项；请使用对话组配置格式。');
  const id = validateGroupId(value.id);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80
    || /[\x00-\x1f\x7f]/.test(value.name)) throw new Error('对话组名称须为 1 到 80 个字符。');
  if (!Array.isArray(value.conversations)) throw new Error('conversations 必须是对话数组。');
  const conversations = value.conversations.map(validateConversation);
  if (new Set(conversations.map(conversationKey)).size !== conversations.length) throw new Error('同一对话在对话组中只能出现一次。');
  const merged = { ...DEFAULTS, ...value };
  for (const field of ['appIdEnv', 'appSecretEnv'] as const) {
    if (typeof merged[field] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(merged[field])) {
      throw new Error(`${field} 必须是有效的环境变量名；实际凭据不能写入 PIQ.md。`);
    }
  }
  if (typeof merged.groupMemberEvents !== 'boolean') throw new Error('groupMemberEvents 必须是布尔值。');
  for (const key of ['quietMs', 'maxWaitMs', 'minIntervalMs'] as const) {
    if (typeof merged[key] !== 'number' || !Number.isInteger(merged[key]) || merged[key] < 0 || merged[key] > 3_600_000) throw new Error(`${key} 必须是 0 到 3600000 的整数毫秒。`);
  }
  if (merged.maxWaitMs === 0 || merged.quietMs > merged.maxWaitMs) throw new Error('maxWaitMs 必须大于 0，且不小于 quietMs。');
  return { id, name: value.name.trim(), conversations, appIdEnv: merged.appIdEnv, appSecretEnv: merged.appSecretEnv,
    groupMemberEvents: merged.groupMemberEvents,
    quietMs: merged.quietMs, maxWaitMs: merged.maxWaitMs, minIntervalMs: merged.minIntervalMs };
}

function parseMarkdown(markdown: string): GroupConfig {
  const blocks = [...markdown.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1) throw new Error('PIQ.md 必须包含且只包含一个 json 代码块。');
  let value: unknown;
  try { value = JSON.parse(blocks[0]![1]!); } catch { throw new Error('PIQ.md 的 json 代码块格式无效。'); }
  return validateConfig(value);
}

export async function loadConfig(cwd: string): Promise<GroupConfig | null> {
  try { return parseMarkdown(await readFile(join(cwd, 'PIQ.md'), 'utf8')); }
  catch (error) { if (missing(error)) return null; throw error; }
}

function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function localFile(cwd: string, relativeFile: string): Promise<string> {
  const path = join(cwd, relativeFile);
  const parent = dirname(path);
  try { if (!contained(cwd, await realpath(parent))) throw new ConfigError(400, '配置文件须位于当前对话组目录。'); }
  catch (error) { if (!missing(error)) throw error; }
  try { if ((await lstat(path)).isSymbolicLink() || !contained(cwd, await realpath(path))) throw new ConfigError(400, '配置文件须为当前目录中的普通文件。'); }
  catch (error) { if (!missing(error)) throw error; }
  return path;
}

async function groupDirectory(cwd: string): Promise<{ root: string; path: string; id: string }> {
  const requested = resolve(cwd);
  const id = validateGroupId(basename(requested));
  const root = await realpath(dirname(requested));
  const path = await realpath(requested);
  if ((await lstat(requested)).isSymbolicLink() || !contained(root, path) || relative(root, path) !== id) throw new ConfigError(400, '对话组目录必须直接位于根目录中。');
  await localFile(path, 'PIQ.md');
  return { root, path, id };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (codeIs(error, 'ESRCH')) return false; if (codeIs(error, 'EPERM')) return true; throw error; }
}
interface Owner { pid: number; token: string }

async function owner(cwd: string): Promise<Owner | null> {
  try {
    const path = await localFile(cwd, '.piq/owner.lock');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== 'string' || !value.token) throw new Error('对话组运行锁无效。');
    return { pid: Number(value.pid), token: value.token };
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function exclusiveFile(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

async function atomicFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await exclusiveFile(temporary, text);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(15 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

/** One root lease covers config edits and runtime conversation claims. */
export async function withRootLock<T>(rootInput: string, operation: (root: string) => Promise<T>): Promise<T> {
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput);
  const path = await localFile(root, '.piq-config.lock');
  const token = randomUUID();
  const text = JSON.stringify({ pid: process.pid, token });
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await exclusiveFile(path, text); break; }
    catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
    let current: unknown;
    try { current = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (missing(error)) continue; if (!(error instanceof SyntaxError)) throw error; }
    if (object(current) && Number.isSafeInteger(current.pid) && Number(current.pid) > 0 && typeof current.token === 'string' && !alive(Number(current.pid))) {
      const recovery = `${path}.recover`;
      let handle;
      try { handle = await open(recovery, 'wx', 0o600); }
      catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
      if (handle) {
        try {
          try {
            const latest = JSON.parse(await readFile(path, 'utf8'));
            if (latest.pid === current.pid && latest.token === current.token && !alive(latest.pid)) await unlink(path);
          } catch (error) { if (!missing(error)) throw error; }
        } finally { await handle.close(); await unlink(recovery); }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new ConfigError(409, '对话组配置正在被其他操作使用，请稍后重试。');
    await delay(25);
  }
  try { return await operation(root); }
  finally {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.token === token) await unlink(path);
  }
}

export interface GroupListing { id: string; path: string; config: GroupConfig }

async function scanGroups(root: string): Promise<GroupListing[]> {
  const groups: GroupListing[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const path = join(root, entry.name);
    try { await lstat(join(path, 'PIQ.md')); }
    catch (error) {
      if (!missing(error)) throw error;
      // A running process retains its loaded members even if its document was
      // removed. Resolve that owner before another group can claim its chats.
      if (!entry.isSymbolicLink()) {
        const running = await owner(path);
        if (running && alive(running.pid)) throw new ConfigError(409, `运行中的对话组 ${entry.name} 缺少 PIQ.md，请恢复配置或先停止该会话。`);
      }
      continue;
    }
    const checked = await groupDirectory(path);
    const config = await loadConfig(checked.path);
    if (!config || config.id !== checked.id) throw new ConfigError(400, `目录 ${entry.name} 与 PIQ.md 的对话组标识不一致。`);
    groups.push({ id: config.id, path: checked.path, config });
  }
  return groups;
}

async function activeClaims(cwd: string): Promise<string[]> {
  const lock = await owner(cwd);
  if (!lock || !alive(lock.pid)) return [];
  let value: unknown;
  try { value = JSON.parse(await readFile(await localFile(cwd, '.piq/conversations.json'), 'utf8')); }
  catch (error) { if (missing(error)) return []; throw error; }
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || typeof value.ownerToken !== 'string' || !Array.isArray(value.keys)) throw new ConfigError(409, '活动对话归属记录无效，请先停止对应 Pi 会话。');
  if (value.pid !== lock.pid || value.ownerToken !== lock.token) return [];
  return value.keys.map(key => conversationKey(parseConversationKey(key)));
}

/** Call while holding withRootLock when validating a registry mutation. */
export async function checkAssignments(root: string, candidate?: GroupConfig): Promise<GroupListing[]> {
  const groups = await scanGroups(root);
  const owners = new Map<string, string>();
  const claim = (key: string, id: string) => {
    const previous = owners.get(key);
    if (previous && previous !== id) throw new ConfigError(409, `对话 ${key} 同时分配给 ${previous} 和 ${id}；每个对话只能属于一个对话组。`);
    owners.set(key, id);
  };
  for (const group of groups) {
    const config = group.id === candidate?.id ? candidate : group.config;
    for (const item of config.conversations) claim(conversationKey(item), group.id);
    for (const key of await activeClaims(group.path)) claim(key, group.id);
  }
  if (candidate && !groups.some(group => group.id === candidate.id)) {
    for (const item of candidate.conversations) claim(conversationKey(item), candidate.id);
  }
  return groups;
}

export async function listGroupConfigs(root: string): Promise<GroupListing[]> {
  return withRootLock(root, async resolved => checkAssignments(resolved));
}

export async function assertAssignments(cwd: string, config: GroupConfig): Promise<void> {
  const checked = await groupDirectory(cwd);
  const candidate = validateConfig(config);
  if (checked.id !== candidate.id) throw new ConfigError(400, '目录与对话组标识不一致。');
  await withRootLock(checked.root, async root => { await checkAssignments(root, candidate); });
}

export interface InitializeOptions {
  name: string;
  conversations: Conversation[];
  appIdEnv?: string;
  appSecretEnv?: string;
  extensionPath?: string;
}

async function createIfMissing(path: string, content: string): Promise<void> {
  try { await exclusiveFile(path, content); }
  catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
}

export async function initializeGroup(rootInput: string, idInput: string, options: InitializeOptions): Promise<string> {
  const id = validateGroupId(idInput);
  const requested = validateConfig({ id, name: options?.name, conversations: options?.conversations, ...DEFAULTS,
    ...(options?.appIdEnv === undefined ? {} : { appIdEnv: options.appIdEnv }),
    ...(options?.appSecretEnv === undefined ? {} : { appSecretEnv: options.appSecretEnv }),
  });
  return withRootLock(resolve(rootInput), async root => {
    const cwd = join(root, id);
    try { if ((await lstat(cwd)).isSymbolicLink()) throw new ConfigError(400, '对话组目录不能是符号链接。'); }
    catch (error) { if (!missing(error)) throw error; }
    const existing = await loadConfig(cwd);
    if (existing && existing.id !== id) throw new ConfigError(400, '目录与 PIQ.md 的对话组标识不一致。');
    await checkAssignments(root, existing ?? requested);
    const settingsPath = await localFile(cwd, '.pi/settings.json');
    let original: string | undefined; let settings: Record<string, unknown> = {};
    try {
      original = await readFile(settingsPath, 'utf8');
      const parsed: unknown = JSON.parse(original);
      if (!object(parsed)) throw new Error();
      settings = parsed;
    } catch (error) { if (!missing(error)) throw new Error('现有 .pi/settings.json 无效，请先修复该文件。'); }
    if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error('现有 .pi/settings.json 的 packages 必须是数组。');
    const packagePath = resolve(options.extensionPath ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
    const packages = (settings.packages ?? []) as unknown[];
    const configured = packages.some(entry => entry === packagePath || (object(entry) && entry.source === packagePath));
    await mkdir(join(cwd, '.pi', 'sessions'), { recursive: true });
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await mkdir(join(cwd, 'messages'), { recursive: true });
    await createIfMissing(join(root, 'AGENTS.md'), await readFile(new URL('../templates/AGENTS.md', import.meta.url), 'utf8'));
    await createIfMissing(join(cwd, 'PIQ.md'), [
      `# 对话组 ${requested.name}`, '', '本目录中的对话共用一个 Pi 会话和一套配置。修改对话归属前先停止本组。', '',
      '```json', JSON.stringify(requested, null, 2), '```', '',
      'quietMs：静默聚合等待；maxWaitMs：连续发言的最长聚合等待；minIntervalMs：两次通知的最小间隔。', '',
    ].join('\n'));
    await createIfMissing(join(cwd, 'AGENTS.md'), [
      `# 对话组 ${requested.name}`, '',
      '本目录内的对话共用会话、人设、记忆和资料，成员对话见 PIQ.md。',
      'PERSONA.md 可记录人设；需要时自行读取、维护 MEMORY.md 或其他 Markdown。',
      '官方机器人群聊和私聊使用 OpenID 标识，日志保存在 messages/v3/group/<OpenID哈希>/ 与 messages/v3/private/<OpenID哈希>/，各自按日期使用 JSONL。',
      '消息保留官方事件原文，发送必须明确指定 PIQ.md 中配置的本组对话；实际 AppID 与 AppSecret 只从指定环境变量读取。',
      'PiQ 通知只表示有新消息。自行阅读记录，判断是否回应，也可以保持沉默。',
      '发消息时调用 qq_send，并明确指定本组中的目标对话。普通 Pi 回答只显示在当前会话。',
      '回复以目标对话的上下文为准；其他对话尤其私聊的内容，不因属于同组而自动转述。',
      '可在本组目录内整理记忆、保存表情包和其他资料，assets/ 可存放媒体。', '',
    ].join('\n'));
    await createIfMissing(join(cwd, 'PERSONA.md'), '# 人设\n\n在这里填写本对话组的人设、语气和偏好。\n');
    if (!configured) {
      const updated = JSON.stringify({ ...settings, packages: [...packages, packagePath] }, null, 2) + '\n';
      if (original !== undefined) {
        if (await readFile(settingsPath, 'utf8') !== original) throw new ConfigError(409, '.pi/settings.json 在初始化期间被修改，请重试。');
        await createIfMissing(`${settingsPath}.before-piq`, original);
        await atomicFile(settingsPath, updated);
      } else await exclusiveFile(settingsPath, updated);
    }
    return cwd;
  });
}

export async function saveGroupConfig(cwd: string, input: GroupConfig, expectedRevision: string): Promise<{ config: GroupConfig; revision: string }> {
  const checked = await groupDirectory(cwd);
  const candidate = validateConfig(input);
  if (candidate.id !== checked.id) throw new ConfigError(400, '此处不能更改对话组标识。');
  return withRootLock(checked.root, async root => {
    const path = await localFile(checked.path, 'PIQ.md');
    const original = await readFile(path, 'utf8');
    if (typeof expectedRevision !== 'string' || revision(original) !== expectedRevision) throw new ConfigError(409, '配置已在其他位置修改，请重新加载后再保存。');
    const before = parseMarkdown(original);
    const keys = (config: GroupConfig) => config.conversations.map(conversationKey).sort().join('\n');
    if (keys(before) !== keys(candidate)) {
      const running = await owner(checked.path);
      if (running && alive(running.pid)) throw new ConfigError(409, '修改对话归属前，请先停止此对话组的 Pi 会话。');
    }
    await checkAssignments(root, candidate);
    const updated = original.replace(/^```json[ \t]*\r?\n[\s\S]*?^```[ \t]*\r?$/m, '```json\n' + JSON.stringify(candidate, null, 2) + '\n```');
    if (await readFile(path, 'utf8') !== original) throw new ConfigError(409, '配置在保存期间被修改，请重试。');
    await atomicFile(path, updated);
    return { config: candidate, revision: revision(updated) };
  });
}

/** Runtime claims retain membership even if someone edits an active PIQ.md by hand. */
export async function claimConversations(cwd: string, input: GroupConfig): Promise<() => Promise<void>> {
  const checked = await groupDirectory(cwd);
  const config = validateConfig(input);
  if (config.id !== checked.id) throw new ConfigError(400, '目录与对话组标识不一致。');
  const claimed = await withRootLock(checked.root, async root => {
    const disk = await loadConfig(checked.path);
    if (JSON.stringify(disk) !== JSON.stringify(config)) throw new ConfigError(409, '对话组配置已变更，请重新加载。');
    const lock = await owner(checked.path);
    if (!lock || lock.pid !== process.pid) throw new ConfigError(409, '当前进程尚未取得此对话组运行锁。');
    await checkAssignments(root, config);
    const path = await localFile(checked.path, '.piq/conversations.json');
    await atomicFile(path, JSON.stringify({ version: 1, id: config.id, pid: lock.pid, ownerToken: lock.token, keys: config.conversations.map(conversationKey) }, null, 2) + '\n');
    return { path, token: lock.token };
  });
  let released = false;
  return async () => {
    if (released) return;
    await withRootLock(checked.root, async () => {
      try {
        await localFile(checked.path, '.piq/conversations.json');
        const value = JSON.parse(await readFile(claimed.path, 'utf8'));
        if (value.ownerToken === claimed.token) await unlink(claimed.path);
      } catch (error) { if (!missing(error)) throw error; }
    });
    released = true;
  };
}
