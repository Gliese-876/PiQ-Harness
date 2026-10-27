#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGroup } from './cli.ts';
import { cancelTerminalReturn, finishTerminal, registerTerminal } from './terminal-monitor.ts';

interface TerminalEntryOptions {
  env?: NodeJS.ProcessEnv;
  register?: typeof registerTerminal;
  cancel?: typeof cancelTerminalReturn;
  open?: typeof openGroup;
}

export async function terminalMain(args = process.argv.slice(2), options: TerminalEntryOptions = {}): Promise<number> {
  if (args.length !== 1) throw new Error('请指定一个群工作目录。');
  const cwd = resolve(args[0]!);
  const inherited = options.env ?? process.env;
  const token = inherited.PIQ_TERMINAL_RETURN_TOKEN;
  const sessionFile = inherited.PIQ_SESSION_FILE;
  const env: NodeJS.ProcessEnv = { ...inherited, PIQ_RUN_MODE: 'terminal' };
  delete env.PIQ_SESSION_FILE;
  delete env.PIQ_LAUNCH_ID;
  if (!token) return await (options.open ?? openGroup)(cwd, [], { env, sessionFile });
  const register = options.register ?? registerTerminal;
  await register(cwd, token, process.pid);
  try { return await (options.open ?? openGroup)(cwd, [], {
    // A managed Pi command may itself launch the real Pi process. Its extension
    // registers the actual owner; every launcher inherits only the wrapper identity.
    env: { ...env, PIQ_TERMINAL_RETURN_TOKEN: token, PIQ_TERMINAL_WRAPPER_PID: String(process.pid) }, sessionFile,
  }); } finally { await (options.cancel ?? finishTerminal)(cwd, token); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  terminalMain().then(code => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`PiQ: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
