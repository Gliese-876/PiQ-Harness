import { spawn } from 'node:child_process';
import { access, readFile, unlink } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshSession, groupTemporaryEnvironment, resolvePiCommand } from './cli.ts';
import { loadConfig, type GroupConfig } from './config.ts';
import { clearTerminalLaunch, prepareTerminalLaunch, withTerminalStartupLock } from './terminal-monitor.ts';
import { readManagedCredentials, type ManagedCredentials } from './bot-credentials.ts';

export interface CredentialStatus {
  available: boolean;
  source: string;
  appId?: string;
  hasSecret?: boolean;
  managed?: boolean;
}

export interface CredentialOptions {
  /** Environment inherited by the local child process; never a QQ credential source. */
  env?: NodeJS.ProcessEnv;
  readManagedCredentials?: (cwd: string) => Promise<ManagedCredentials>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Credentials come only from this group's saved local settings. */
export async function resolveGroupEnvironment(
  cwd: string,
  _config: GroupConfig,
  options: CredentialOptions = {},
): Promise<{ env: NodeJS.ProcessEnv; credential: CredentialStatus; credentials?: { appId: string; appSecret: string } }> {
  const env = { ...(options.env ?? process.env) };
  try {
    const saved = await (options.readManagedCredentials ?? readManagedCredentials)(cwd);
    if (!saved.available || !saved.appId || !saved.appSecret) return { env, credential: {
      available: false, appId: saved.appId, hasSecret: saved.hasSecret, managed: true,
      source: '请在连接设置填写并保存机器人 AppID 和 AppSecret。',
    } };
    return { env, credentials: { appId: saved.appId, appSecret: saved.appSecret },
      credential: { available: true, appId: saved.appId, hasSecret: true, managed: true, source: '机器人凭据已保存在本机。' } };
  } catch {
    return { env, credential: { available: false, appId: '', hasSecret: false, managed: true,
      source: '无法读取本机机器人凭据，请在连接设置重试保存。' } };
  }
}

/** Browser metadata contains only the application id and whether a secret exists. */
export async function credentialStatus(config: GroupConfig, options: CredentialOptions = {}, cwd = ''): Promise<CredentialStatus> {
  return (await resolveGroupEnvironment(cwd, config, options)).credential;
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
  prepareLaunch?: typeof prepareTerminalLaunch;
  clearLaunch?: typeof clearTerminalLaunch;
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
    const { env, credential } = await resolveGroupEnvironment(directory, config, options);
    // Validate installation before creating a launch lease or opening a window.
    await resolvePiCommand(env);
    const shell = await powerShell(env);
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const cancel = options.clearLaunch ?? clearTerminalLaunch;
    const lease = await (options.prepareLaunch ?? prepareTerminalLaunch)(directory);
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
      const message = options.freshSession ? '已请求打开终端并新建空上下文，原有会话与资料保留。关闭终端即停止。'
        : '已请求打开终端，并继续本群最近的 Pi 会话。关闭终端即停止。';
      return { message: message + (credential.available ? '' : ` QQ 机器人连接未启用：${credential.source}。`) };
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
