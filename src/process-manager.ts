import { getRunningOwner, openGroupTerminal, type TerminalOptions } from './web-terminal.ts';
import { getTerminalLaunchStatus, getTerminalLaunchError } from './terminal-monitor.ts';

export interface ProcessStatus {
  running: boolean;
  pid: number | null;
  mode: 'terminal' | null;
  starting: boolean;
  error?: string;
}
export async function getProcessStatus(cwd: string): Promise<ProcessStatus> {
  const owner = await getRunningOwner(cwd);
  if (owner.running) return { ...owner, mode: 'terminal', starting: false };
  const terminal = await getTerminalLaunchStatus(cwd);
  if (terminal.running || terminal.starting) return { ...terminal, mode: 'terminal' };
  const error = await getTerminalLaunchError(cwd);
  return { running: false, pid: null, mode: null, starting: false, ...(error ? { error } : {}) };
}
export interface ProcessResult { message: string; alreadyRunning?: boolean; starting?: boolean; pid?: number }
export async function startGroup(cwd: string, options: TerminalOptions = {}): Promise<ProcessResult> {
  const status = await getProcessStatus(cwd);
  if (status.running || status.starting) return { message: status.starting ? '本组 Pi 正在启动。' : '本组 Pi 已运行。',
    alreadyRunning: true, starting: status.starting, pid: status.pid ?? undefined };
  return openGroupTerminal(cwd, options);
}
