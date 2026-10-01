import { spawn, type ChildProcess } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs a command and collects its output. Rejects only if the command cannot be started at all. */
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

const children = new Set<ChildProcess>();

export const runProcess: Runner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      // Keep only the tail of very chatty stderr (progress bars).
      if (stderr.length > 2000) stderr.splice(0, 1000);
    });

    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;

    child.on("error", (err) => {
      clearTimeout(timer);
      children.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      const err = Buffer.concat(stderr).toString("utf8");
      resolve({
        code: timedOut ? null : code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: timedOut ? `${err}\nTimed out after ${options.timeoutMs} ms` : err,
      });
    });
  });

/** Kills every child process still running (yt-dlp downloads, Whisper) — used on shutdown. */
export function killAllProcesses(): void {
  for (const child of children) child.kill("SIGTERM");
}
