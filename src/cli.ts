#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { access, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertAssignments, initializeGroup, loadConfig, validateGroupId } from "./config.ts";
import { parseConversationKey, type Conversation } from './conversations.ts';
import { modelArguments } from './web-models.ts';

export function defaultMessagesRoot(): string {
  let documents = join(homedir(), "Documents");
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('MyDocuments')"], {
      encoding: "utf8", windowsHide: true, timeout: 5_000,
    });
    const knownFolder = result.stdout?.trim();
    if (result.status === 0 && knownFolder && isAbsolute(knownFolder)) documents = knownFolder;
  }
  return join(documents, "PiQ-Messages");
}

export interface CliOptions {
  action: "init" | "open" | "discover" | "path" | "help";
  id?: string;
  name?: string;
  conversations?: Conversation[];
  root?: string;
  appIdEnv?: string;
  appSecretEnv?: string;
  freshSession?: boolean;
  piArgs: string[];
}

export function parseArgs(args: string[]): CliOptions {
  if (!args.length || ["--help", "-h", "help"].includes(args[0]!)) return { action: "help", piArgs: [] };
  const action = args[0];
  if (action !== "init" && action !== "open" && action !== "discover" && action !== "path") throw new Error("命令应为 init、open、discover 或 path。");
  const result: CliOptions = { action, id: validateGroupId(args[1]), piArgs: [], ...(action === 'init' ? { conversations: [] } : {}) };
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--new-session') {
      if (action !== 'open') throw new Error('--new-session 仅用于 open。');
      result.freshSession = true;
      continue;
    }
    if (arg === "--") {
      if (action !== "open") throw new Error("只有 open 命令支持 -- 后的 Pi 参数。");
      result.piArgs = args.slice(i + 1);
      break;
    }
    if (arg === '--conversation') {
      if (action !== 'init') throw new Error('--conversation 仅用于 init。');
      result.conversations!.push(parseConversationKey(args[++i]));
      continue;
    }
    const key = arg === "--root" ? "root" : arg === "--app-id-env" ? "appIdEnv" : arg === "--app-secret-env" ? "appSecretEnv" : arg === '--name' ? 'name' : null;
    if (!key) throw new Error(`未知参数：${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值。`);
    if (action !== "init" && key !== "root") throw new Error(`${arg} 仅用于 init。`);
    result[key] = value;
  }
  if (action === 'init' && !result.name?.trim()) throw new Error('创建对话组需要 --name <名称>。');
  return result;
}

async function isFile(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Resolve Node entrypoints rather than invoking .cmd through a shell on Windows. */
export async function resolvePiCommand(env: NodeJS.ProcessEnv = process.env): Promise<{ command: string; args: string[] }> {
  if (env.PIQ_PI_ENTRY) {
    const entry = resolve(env.PIQ_PI_ENTRY);
    if (!await isFile(entry)) throw new Error("PIQ_PI_ENTRY 指向的 Pi Node 入口不存在。");
    return { command: process.execPath, args: [entry] };
  }
  if (process.platform !== "win32") return { command: "pi", args: [] };
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const launcher = join(directory, "pi-launcher.js");
    if (await isFile(launcher)) return { command: process.execPath, args: [launcher] };
    const packageDirectory = join(directory, "node_modules", "@earendil-works", "pi-coding-agent");
    try {
      const pkg = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (typeof bin === "string") {
        const entry = resolve(packageDirectory, bin);
        if (await isFile(entry)) return { command: process.execPath, args: [entry] };
      }
    } catch { /* Try the next PATH directory. */ }
  }
  throw new Error("未找到 Pi 的 Node 入口。请安装 Pi，或用 PIQ_PI_ENTRY 指定其 JavaScript 入口文件。");
}

export interface OpenGroupOptions {
  /** The spawned command can be a launcher; this PID is not necessarily the Pi owner. */
  onSpawn?: (pid: number) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  freshSession?: boolean;
  sessionFile?: string;
}

/** Keep child-process scratch files in this group without changing the caller's environment. */
export async function groupTemporaryEnvironment(cwd: string, inherited: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const root = await realpath(resolve(cwd));
  const directory = join(root, '.tmp');
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  const actual = await realpath(directory);
  const part = relative(root, actual);
  const same = process.platform === 'win32' ? actual.toLowerCase() === directory.toLowerCase() : actual === directory;
  if (!info.isDirectory() || info.isSymbolicLink() || !same || part === '..' || part.startsWith('../')
    || part.startsWith('..\\') || isAbsolute(part)) throw new Error('临时目录 .tmp 须为本组内的普通目录，不能使用符号链接或目录联接。');
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (['TEMP', 'TMP', 'TMPDIR'].includes(key.toUpperCase())) delete env[key];
  }
  return { ...env, TEMP: directory, TMP: directory, TMPDIR: directory };
}

/** Persist the empty Pi header immediately, so closing before a first turn still resets context. */
export async function createFreshSession(cwd: string): Promise<string> {
  const root = await realpath(cwd);
  let directory = root;
  for (const part of ['.pi', 'sessions']) {
    directory = join(directory, part);
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    const actual = await realpath(directory);
    const same = process.platform === 'win32' ? actual.toLowerCase() === directory.toLowerCase() : actual === directory;
    if (!info.isDirectory() || info.isSymbolicLink() || !same) throw new Error('会话目录须为本组内的普通目录。');
  }
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const session = SessionManager.create(root, directory);
  const path = session.getSessionFile()!;
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(session.getHeader()) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  return path;
}

export async function openGroup(cwd: string, extraArgs: string[] = [], options: OpenGroupOptions = {}): Promise<number> {
  const config = await loadConfig(cwd);
  if (!config) throw new Error("该对话组尚未初始化。请先运行 init <对话组标识> --name <名称>。");
  if (!config.conversations.length) throw new Error('请先向对话组添加至少一个对话。');
  await assertAssignments(cwd, config);
  const { resolveGroupEnvironment } = await import('./web-terminal.ts');
  const inherited = options.env === undefined ? undefined : { ...process.env, ...options.env };
  const credentials = await resolveGroupEnvironment(cwd, config, { env: inherited });
  if (!credentials.credential.available) console.error(`PiQ: QQ 机器人连接未启用：${credentials.credential.source}。`);
  const env = await groupTemporaryEnvironment(cwd, credentials.env);
  const launcher = await resolvePiCommand(env);
  const selectedModel = await modelArguments(cwd);
  const sessionFile = options.sessionFile ?? (options.freshSession ? await createFreshSession(cwd) : undefined);
  if (sessionFile) {
    const directory = await realpath(join(cwd, '.pi', 'sessions'));
    const path = await realpath(sessionFile);
    const part = relative(directory, path);
    const info = await lstat(sessionFile);
    if (!part || part.startsWith('..') || isAbsolute(part) || info.isSymbolicLink() || !info.isFile() || info.nlink > 1) {
      throw new Error('指定会话须为本组 .pi/sessions 内的普通文件。');
    }
  }
  const sessionArgs = sessionFile ? ['--session', sessionFile] : ['--continue'];
  return await new Promise<number>((resolveCode, reject) => {
    const child = spawn(launcher.command, [...launcher.args, ...sessionArgs, "--session-dir", join(cwd, ".pi", "sessions"), ...selectedModel, ...extraArgs], {
      cwd, stdio: "inherit", env, shell: false, windowsHide: true,
    });
    let registration: Promise<void> = Promise.resolve();
    child.once('spawn', () => {
      registration = Promise.resolve().then(async () => {
        if (!child.pid) throw new Error('Pi 没有返回进程标识。');
        await options.onSpawn?.(child.pid);
      });
      void registration.catch(error => { child.kill('SIGKILL'); reject(error); });
    });
    child.once("error", reject);
    child.once("exit", (code) => { void registration.then(() => resolveCode(code ?? 1), reject); });
  });
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  if (options.action === "help") {
    console.log([
      "PiQ — 让多个对话共用一个独立的 Pi 工作目录", "",
      "node src/cli.ts init <对话组标识> --name <名称> [--conversation group:group_openid] [--conversation private:user_openid]",
      "  [--root <目录>] [--app-id-env <变量名>] [--app-secret-env <变量名>]",
      "node src/cli.ts open <对话组标识> [--root <目录>] [--new-session] [-- <Pi参数...>]",
      "node src/cli.ts discover <对话组标识> [--root <目录>]",
      "node src/cli.ts path <对话组标识> [--root <目录>]", "",
      "默认目录：文档/PiQ-Messages/<对话组标识>。每个对话只能属于一个对话组。",
      "--conversation 可以重复使用；未添加对话的空组可先编辑配置。",
      "discover 仅监听 QQ 机器人事件并显示对话标识，不发送消息、不输出正文；Ctrl+C 退出。",
      "open 继承当前终端、模型配置和环境变量，并继续本组 .pi/sessions 中的最近会话。",
      "--new-session 新建空上下文，保留已有会话、聊天日志、记忆与资料；关闭终端即停止运行。",
      "首次启动请在 Pi 中信任本组目录，以加载 .pi/settings.json 声明的扩展。",
    ].join("\n"));
    return 0;
  }
  const root = resolve(options.root ?? defaultMessagesRoot());
  const cwd = resolve(root, options.id!);
  if (options.action === "init") {
    console.log(await initializeGroup(root, options.id!, {
      name: options.name!,
      conversations: options.conversations!,
      appIdEnv: options.appIdEnv,
      appSecretEnv: options.appSecretEnv,
    }));
    return 0;
  }
  if (options.action === "path") { console.log(cwd); return 0; }
  const config = await loadConfig(cwd);
  if (config && config.id !== options.id) throw new Error("目录中 PIQ.md 的对话组标识与请求不一致。");
  if (options.action === 'discover') {
    const { discoverGroup } = await import('./discover.ts');
    return await discoverGroup(cwd);
  }
  return await openGroup(cwd, options.piArgs, { freshSession: options.freshSession });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`PiQ: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
