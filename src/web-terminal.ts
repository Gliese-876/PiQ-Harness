import { spawn } from 'node:child_process';
import { access, readFile, readdir, unlink } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshSession, defaultMessagesRoot, groupTemporaryEnvironment, resolvePiCommand } from './cli.ts';
import { loadConfig, type GroupConfig } from './config.ts';
import { cancelTerminalReturn, prepareTerminalReturn, withTerminalStartupLock } from './terminal-monitor.ts';

export interface CredentialStatus {
  available: boolean;
  source: string;
}

export interface CredentialOptions {
  env?: NodeJS.ProcessEnv;
  configDirectory?: string;
}

interface ResolvedCredential {
  status: CredentialStatus;
  token?: string;
}

let defaultConfigDirectory: string | undefined;

function localConfigDirectory(): string {
  return defaultConfigDirectory ??= join(dirname(defaultMessagesRoot()), 'SnowLuma', 'config');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());
}

function endpointMatches(endpoint: Record<string, unknown>, url: URL): boolean {
  const host = typeof endpoint.host === 'string' ? endpoint.host : '';
  // Local configuration credentials only apply to a local endpoint, including
  // servers bound to all interfaces. Never infer credentials for a remote URL.
  if (!loopback(url.hostname) || (!loopback(host) && host !== '0.0.0.0' && host !== '::')) return false;
  const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
  if (Number(endpoint.port) !== port) return false;
  const path = typeof endpoint.path === 'string' && endpoint.path ? endpoint.path : '/';
  return url.pathname.replace(/\/$/, '') === path.replace(/\/$/, '');
}

async function resolveCredential(config: GroupConfig, options: CredentialOptions): Promise<ResolvedCredential> {
  const env = options.env ?? process.env;
  if (env[config.accessTokenEnv]) {
    return { status: { available: true, source: `环境变量 ${config.accessTokenEnv}` }, token: env[config.accessTokenEnv] };
  }
  const url = new URL(config.wsUrl);
  if (!loopback(url.hostname)) return { status: { available: false, source: `请设置环境变量 ${config.accessTokenEnv}` } };
  const directory = options.configDirectory ?? localConfigDirectory();
  let names: string[];
  try { names = (await readdir(directory)).filter(name => /^onebot(?:_\d+)?\.json$/.test(name)).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: { available: false, source: `请设置环境变量 ${config.accessTokenEnv}` } };
    throw new Error('无法读取本机 SnowLuma 配置目录。');
  }
  const tokens = new Set<string>();
  for (const name of names) {
    let data: unknown;
    try { data = JSON.parse(await readFile(join(directory, name), 'utf8')); }
    catch { continue; }
    if (!object(data) || !object(data.networks)) continue;
    for (const kind of ['httpServers', 'wsServers'] as const) {
      const endpoints = data.networks[kind];
      if (!Array.isArray(endpoints)) continue;
      for (const endpoint of endpoints) {
        if (!object(endpoint) || (kind === 'httpServers' && endpoint.enableWebSocket !== true)
          || endpoint.enable === false || endpoint.enabled === false || !endpointMatches(endpoint, url)) continue;
        if (endpoint.accessToken === undefined || endpoint.accessToken === null || typeof endpoint.accessToken === 'string') {
          tokens.add(typeof endpoint.accessToken === 'string' ? endpoint.accessToken : '');
        }
      }
    }
  }
  if (tokens.size > 1) return { status: { available: false, source: `本机有多个匹配配置，请设置 ${config.accessTokenEnv}` } };
  const token = tokens.values().next().value;
  if (token !== undefined) return { status: { available: true, source: token ? 'SnowLuma 本地配置' : 'SnowLuma 本地配置（无需令牌）' }, token };
  return { status: { available: false, source: `请设置环境变量 ${config.accessTokenEnv}` } };
}

/** Safe metadata for the WebUI. Token values are deliberately not part of this result. */
export async function credentialStatus(config: GroupConfig, options: CredentialOptions = {}): Promise<CredentialStatus> {
  return (await resolveCredential(config, options)).status;
}

/** The returned environment is for a local child process, never for an HTTP response. */
export async function resolveGroupEnvironment(
  _cwd: string,
  config: GroupConfig,
  options: CredentialOptions = {},
): Promise<{ env: NodeJS.ProcessEnv; credential: CredentialStatus }> {
  const result = await resolveCredential(config, options);
  const env = { ...(options.env ?? process.env) };
  if (result.token !== undefined) env[config.accessTokenEnv] = result.token;
  return { env, credential: result.status };
}

export async function getRunningOwner(cwd: string): Promise<{ running: boolean; pid: number | null }> {
  let owner: unknown;
  try { owner = JSON.parse(await readFile(join(cwd, '.piq', 'owner.lock'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { running: false, pid: null };
    throw new Error('本群运行锁无法读取，请检查 .piq/owner.lock。');
  }
  if (!object(owner) || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) {
    throw new Error('本群运行锁无效，请检查 .piq/owner.lock。');
  }
  const pid = Number(owner.pid);
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { running: false, pid: null };
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  return { running: true, pid };
}

export interface TerminalLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface TerminalOptions extends CredentialOptions {
  freshSession?: boolean;
  launch?: (specification: TerminalLaunch) => Promise<void>;
  prepareReturn?: typeof prepareTerminalReturn;
  cancelReturn?: typeof cancelTerminalReturn;
}

const openingTerminals = new Map<string, Promise<{ message: string; alreadyRunning?: boolean }>>();

async function launchTerminal(specification: TerminalLaunch): Promise<void> {
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(specification.command, specification.args, {
      cwd: specification.cwd, env: specification.env, shell: false,
      detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.once('error', () => reject(new Error('打开终端失败，请检查 Windows Terminal（wt.exe）是否已安装。')));
    child.once('spawn', () => { child.unref(); resolveLaunch(); });
  });
}

async function powerShell(env: NodeJS.ProcessEnv): Promise<string> {
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'pwsh.exe');
    try { await access(candidate); return candidate; } catch { /* Try the next directory. */ }
  }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export async function openGroupTerminal(cwd: string, options: TerminalOptions = {}): Promise<{ message: string; alreadyRunning?: boolean }> {
  const directory = resolve(cwd);
  const existing = openingTerminals.get(directory);
  if (existing) {
    await existing;
    return { message: '终端正在打开，请稍候。', alreadyRunning: true };
  }
  const operation = withTerminalStartupLock(directory, async () => {
    const config = await loadConfig(directory);
    if (!config) throw new Error('请先初始化本群目录。');
    if (!config.conversations.length) throw new Error('请先给对话组添加至少一个对话。');
    const owner = await getRunningOwner(directory);
    if (owner.running) return { message: `本群 Pi 已在终端运行（PID ${owner.pid}），请切换到已有终端。`, alreadyRunning: true };
    if (process.platform !== 'win32' && !options.launch) throw new Error('终端入口目前支持 Windows；请在本群目录中手动运行 Pi。');
    const { env } = await resolveGroupEnvironment(directory, config, options);
    // Validate installation before creating a launch lease or opening a window.
    await resolvePiCommand(env);
    const shell = await powerShell(env);
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const cancel = options.cancelReturn ?? cancelTerminalReturn;
    const lease = await (options.prepareReturn ?? prepareTerminalReturn)(directory, { env });
    if (lease.alreadyRunning) return { message: '终端正在打开或已由本群接管，请切换到已有终端。', alreadyRunning: true };
    let sessionFile: string | undefined;
    try {
      if ((await getRunningOwner(directory)).running) {
        await cancel(directory, lease.token);
        return { message: '本群会话已由其他实例接管，请刷新状态。', alreadyRunning: true };
      }
      if (options.freshSession) sessionFile = await createFreshSession(directory);
      const terminalEnv: NodeJS.ProcessEnv = { ...await groupTemporaryEnvironment(directory, env), PIQ_GROUP_DIRECTORY: directory, PIQ_NODE_EXECUTABLE: process.execPath,
        PIQ_TERMINAL_ENTRY: join(sourceRoot, 'src', 'terminal-entry.ts'), PIQ_TERMINAL_RETURN_TOKEN: lease.token,
        PIQ_RUN_MODE: 'terminal', PIQ_START_RUNNING: '1', PIQ_SESSION_FILE: sessionFile };
      delete terminalEnv.PIQ_TERMINAL_WRAPPER_PID;
      delete terminalEnv.PIQ_LAUNCH_ID;
      await (options.launch ?? launchTerminal)({
        command: 'wt.exe',
        args: ['-w', 'new', 'new-tab', '--inheritEnvironment', '--title', `PiQ ${config.name}`,
          shell, '-NoLogo', '-NoProfile', '-File', join(sourceRoot, 'scripts', 'open-pi.ps1')],
        cwd: directory,
        // Group paths and tokens go through the child environment, not WT command syntax.
        env: terminalEnv,
      });
      return { message: options.freshSession ? '已请求打开终端并新建空上下文，原有会话与资料保留。关闭终端即停止。'
        : '已请求打开终端，并继续本群最近的 Pi 会话。关闭终端即停止。' };
    } catch (error) {
      await cancel(directory, lease.token);
      if (sessionFile) await unlink(sessionFile).catch(() => {});
      throw error;
    }
  });
  openingTerminals.set(directory, operation);
  try { return await operation; }
  finally { if (openingTerminals.get(directory) === operation) openingTerminals.delete(directory); }
}
