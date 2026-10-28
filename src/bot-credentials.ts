import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateOpenId } from './conversations.ts';

export interface ManagedCredentialNames { appIdEnv: string; appSecretEnv: string }
export interface ManagedCredentialMetadata { appId: string; hasSecret: boolean; available: boolean }
/** Internal credential resolution only. HTTP responses must select the metadata fields explicitly. */
export interface ManagedCredentials extends ManagedCredentialMetadata { appSecret?: string }
export interface ManagedCredentialStorage {
  read(names: readonly string[]): Promise<NodeJS.ProcessEnv>;
  /** An undefined value removes that exact variable. */
  write(values: Readonly<Record<string, string | undefined>>): Promise<void>;
}
export interface ManagedCredentialOptions {
  storage?: ManagedCredentialStorage;
  /** Platform override for simulated storage tests. */
  platform?: NodeJS.Platform;
}
export class ManagedCredentialError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'ManagedCredentialError'; this.status = status; }
}

const MAX_SECRET_LENGTH = 4_096;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyMetadata = (): ManagedCredentials => ({ appId: '', hasSecret: false, available: false });
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// Pending operations only: entries are removed on completion and never cache credential values.
const operations = new Map<string, Promise<void>>();

async function withCredentialOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const finished = result.then(() => {}, () => {});
  operations.set(key, finished);
  try { return await result; }
  finally { if (operations.get(key) === finished) operations.delete(key); }
}

async function directory(cwd: string): Promise<string> {
  try {
    const path = await realpath(resolve(cwd));
    if (!(await lstat(path)).isDirectory()) throw new Error();
    return path;
  } catch { throw new ManagedCredentialError('对话组目录不可用。'); }
}

export async function managedCredentialNames(cwd: string): Promise<ManagedCredentialNames> {
  const path = await directory(cwd);
  const canonical = process.platform === 'win32' ? path.toLowerCase() : path;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return { appIdEnv: `PIQ_BOT_${hash}_APP_ID`, appSecretEnv: `PIQ_BOT_${hash}_APP_SECRET` };
}

// Values travel exclusively through stdin. The helper never prints values on errors.
const USER_ENVIRONMENT_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'read') { $names = @($request.names) }
  elseif ($request.action -eq 'write') { $names = @($request.values | ForEach-Object { $_.name }) }
  else { throw 'Invalid action.' }
  if ($names.Count -ne 2 -or $names[0] -eq $names[1]) { throw 'Invalid variable set.' }
  foreach ($name in $names) {
    if ($name -notmatch '^PIQ_BOT_[a-f0-9]{16}_APP_(ID|SECRET)$') { throw 'Invalid variable name.' }
  }
  if (($names[0] -replace '_APP_(ID|SECRET)$','') -ne ($names[1] -replace '_APP_(ID|SECRET)$','')) { throw 'Mismatched variables.' }
  if ($request.action -eq 'read') {
    $values = @{}
    foreach ($name in $names) { $values[$name] = [Environment]::GetEnvironmentVariable([string]$name, 'User') }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $values -Compress))
  } else {
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable([string]$name, 'User') }
    try {
      foreach ($entry in $request.values) {
        $value = $null
        if ($null -ne $entry.value) { $value = [string]$entry.value }
        [Environment]::SetEnvironmentVariable([string]$entry.name, $value, 'User')
      }
    } catch {
      foreach ($name in $names) {
        try { [Environment]::SetEnvironmentVariable([string]$name, $previous[$name], 'User') } catch { }
      }
      throw 'Write failed.'
    }
    [Console]::Out.WriteLine('{"ok":true}')
  }
  exit 0
} catch {
  [Console]::Error.WriteLine('PiQ managed credential operation failed.')
  exit 1
}
`;

async function userEnvironmentOperation(payload: unknown): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', USER_ENVIRONMENT_SCRIPT], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', settled = false;
    const finish = (success: boolean, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (success) resolveResult(value);
      else reject(new ManagedCredentialError('无法读写 QQ 机器人用户环境变量，请重试。', 500));
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length + String(chunk).length > 32_768) { child.kill(); finish(false); return; }
      output += String(chunk);
    });
    child.stdin.on('error', () => finish(false));
    child.stderr.on('data', () => {});
    child.once('error', () => finish(false));
    child.once('close', code => {
      if (code !== 0) { finish(false); return; }
      try { finish(true, JSON.parse(output.trim())); } catch { finish(false); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const userStorage: ManagedCredentialStorage = {
  async read(names) {
    const result = await userEnvironmentOperation({ action: 'read', names });
    if (!object(result)) throw new ManagedCredentialError('读取已保存的 QQ 机器人凭据失败。', 500);
    return Object.fromEntries(names.map(name => {
      const value = Object.hasOwn(result, name) ? result[name] : undefined;
      if (value !== null && value !== undefined && typeof value !== 'string') throw new ManagedCredentialError('读取已保存的 QQ 机器人凭据失败。', 500);
      return [name, value ?? undefined];
    }));
  },
  async write(values) {
    const result = await userEnvironmentOperation({ action: 'write', values: Object.entries(values).map(([name, value]) => ({ name, value: value ?? null })) });
    if (!object(result) || result.ok !== true) throw new ManagedCredentialError('保存 QQ 机器人凭据失败。', 500);
  },
};

function appId(value: unknown): string {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw new ManagedCredentialError('AppID 格式无效。');
  try { return validateOpenId(value.trim()); }
  catch { throw new ManagedCredentialError('AppID 须为 1 到 128 位字母、数字、下划线或连字符。'); }
}

function secret(value: unknown, allowBlank: boolean): string | undefined {
  if (value === undefined && allowBlank) return;
  if (typeof value !== 'string' || value.length > MAX_SECRET_LENGTH || /[\p{Cc}\u2028\u2029]/u.test(value)) {
    throw new ManagedCredentialError('AppSecret 须为不含控制字符且不超过 4096 个字符的文本。');
  }
  const result = value.trim();
  if (!result) {
    if (allowBlank) return;
    throw new ManagedCredentialError('请填写 AppSecret。');
  }
  return result;
}

async function readValues(storage: ManagedCredentialStorage, names: ManagedCredentialNames): Promise<NodeJS.ProcessEnv> {
  try {
    const values = await storage.read([names.appIdEnv, names.appSecretEnv]);
    if (!object(values)) throw new Error();
    return Object.fromEntries([names.appIdEnv, names.appSecretEnv].map(name => {
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (value !== undefined && typeof value !== 'string') throw new Error();
      return [name, value];
    }));
  } catch { throw new ManagedCredentialError('读取已保存的 QQ 机器人凭据失败，请重试。', 500); }
}

export async function readManagedCredentials(cwd: string, options: ManagedCredentialOptions = {}): Promise<ManagedCredentials> {
  if ((options.platform ?? process.platform) !== 'win32') return emptyMetadata();
  const names = await managedCredentialNames(cwd);
  return withCredentialOperation(names.appIdEnv, async () => {
    const values = await readValues(options.storage ?? userStorage, names);
    try {
      const id = values[names.appIdEnv]?.trim() ? appId(values[names.appIdEnv]) : '';
      const savedSecret = secret(values[names.appSecretEnv], true);
      return { appId: id, hasSecret: savedSecret !== undefined, available: Boolean(id && savedSecret),
        ...(savedSecret === undefined ? {} : { appSecret: savedSecret }) };
    } catch { throw new ManagedCredentialError('已保存的 QQ 机器人凭据格式无效，请重新保存。', 500); }
  });
}

export async function readBoundBotAccount(cwd: string): Promise<string | undefined> {
  try {
    const folder = join(cwd, '.piq');
    const folderInfo = await lstat(folder);
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink() || !samePath(folder, await realpath(folder))) throw new Error();
    const file = join(folder, 'bot-account.json');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 4_096 || !samePath(file, await realpath(file))) throw new Error();
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!object(value) || value.version !== 1 || Object.keys(value).some(key => key !== 'version' && key !== 'accountId')) throw new Error();
    return validateOpenId(value.accountId);
  } catch (error) {
    if (missing(error)) return undefined;
    throw new ManagedCredentialError('本组机器人绑定记录无效，请先检查后再保存凭据。', 409);
  }
}

async function checkAccountBinding(cwd: string, requestedAppId: string): Promise<void> {
  const boundAppId = await readBoundBotAccount(cwd);
  if (boundAppId !== undefined && boundAppId !== requestedAppId) throw new ManagedCredentialError('更换机器人需要归档旧账号记录，请在工作台确认更换。', 409);
}

export function validateManagedCredentialInput(input: { appId: string; appSecret?: string }): { appId: string; appSecret?: string } {
  if (!object(input)) throw new ManagedCredentialError('机器人凭据格式无效。');
  return { appId: appId(input.appId), appSecret: secret(input.appSecret, true) };
}

export async function saveManagedCredentials(cwd: string, input: { appId: string; appSecret?: string },
  options: ManagedCredentialOptions = {}): Promise<ManagedCredentialMetadata> {
  if ((options.platform ?? process.platform) !== 'win32') throw new ManagedCredentialError('当前平台暂不支持保存，请在 Windows 工作台中配置机器人。', 501);
  const validated = validateManagedCredentialInput(input);
  const id = validated.appId, suppliedSecret = validated.appSecret;
  const cwdPath = await directory(cwd), names = await managedCredentialNames(cwdPath), storage = options.storage ?? userStorage;
  return withCredentialOperation(names.appIdEnv, async () => {
    await checkAccountBinding(cwdPath, id);
    const original = await readValues(storage, names);
    const previousId = original[names.appIdEnv]?.trim();
    if (!suppliedSecret && previousId !== id) throw new ManagedCredentialError('首次保存或更换 AppID 时，请同时填写 AppSecret。');
    const savedSecret = suppliedSecret ?? secret(original[names.appSecretEnv], true);
    if (!savedSecret) throw new ManagedCredentialError('首次保存时请同时填写 AppID 和 AppSecret。');
    await checkAccountBinding(cwdPath, id);
    try {
      await storage.write({ [names.appIdEnv]: id, [names.appSecretEnv]: savedSecret });
      const persisted = await readValues(storage, names);
      if (persisted[names.appIdEnv] !== id || persisted[names.appSecretEnv] !== savedSecret) throw new Error('Credential persistence verification failed.');
    }
    catch {
      try { await storage.write(original); }
      catch { throw new ManagedCredentialError('凭据保存失败，原值恢复也未完成；请重新保存 AppID 和 AppSecret。', 500); }
      throw new ManagedCredentialError('凭据保存失败，已尝试恢复原值；请重试。', 500);
    }
    return { appId: id, hasSecret: true, available: true };
  });
}
