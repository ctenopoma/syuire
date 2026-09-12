/**
 * Structured Git runner.
 *
 * DESIGN.md 7.2 / 11.1: the local host layer must never expose a generic shell.
 * Git is always started with a structured argument vector via `execFile`, never
 * through a shell and never by concatenating a command string.
 */

import { AdapterError } from "@syuire/core";
import { execFile } from "node:child_process";
import { redactText } from "./redact.js";

export interface RunGitOptions {
  /** Bytes (or UTF-8 text) written to the child's stdin. */
  stdin?: string | Uint8Array;
  /** Maximum bytes captured from stdout/stderr. Default 64 MiB. */
  maxBuffer?: number;
  /** Extra environment entries layered on top of the computed base environment. */
  env?: Record<string, string>;
  /** Internal: skip the `core.sshCommand` probe (used by the probe itself). */
  skipSshProbe?: boolean;
  /** Milliseconds before the child is killed. Defaults to the per-command limit. */
  timeout?: number;
}

export interface GitResult {
  /** stdout decoded as UTF-8 (BOM preserved). */
  stdout: string;
  stderr: string;
  /** Process exit code, or -1 when the process produced no observable exit code. */
  code: number;
  /** Raw stdout bytes. */
  stdoutRaw: Buffer;
  /** Signal that terminated the child, if any. */
  signal: NodeJS.Signals | null;
  /** True when the child could not be spawned at all (e.g. git not installed). */
  failedToSpawn: boolean;
  /** True when the exit status could not be observed (spawn failure or signal). */
  unobservable: boolean;
  /** True when the child was killed because it exceeded its time limit. */
  timedOut: boolean;
  /** Underlying spawn/exec error, when there was one. */
  error?: Error;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const BATCH_SSH_COMMAND = "ssh -o BatchMode=yes";

/**
 * DESIGN.md 7.2: git must never sit waiting on an interactive prompt. Terminal
 * prompts and SSH BatchMode cover the common cases, but a credential helper
 * with its own GUI, a wedged network connection or a stuck lock can still hang
 * forever, so every invocation gets a hard time limit and the child is killed.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Commands that legitimately talk to a remote get a longer limit. */
const REMOTE_TIMEOUT_MS = 300_000;
const REMOTE_COMMANDS = new Set(["fetch", "pull", "push", "clone", "ls-remote", "remote", "submodule"]);

function timeoutFor(args: string[], opts: RunGitOptions): number {
  if (typeof opts.timeout === "number" && opts.timeout > 0) return opts.timeout;
  const first = args.find((a) => !a.startsWith("-"));
  return first !== undefined && REMOTE_COMMANDS.has(first) ? REMOTE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * The error to raise for a git invocation that had to be killed. Credential
 * prompts are the usual cause, so the message says so; the kind is "auth" when
 * the output already mentions credentials and "network" otherwise.
 */
export function timeoutError(args: string[], result: GitResult): AdapterError {
  const text = `${result.stderr}\n${result.stdout}`;
  const credentialish =
    /Username|Password|passphrase|credential|Authentication|Enter PIN|Host key/i.test(text);
  const command = `git ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")}`.trim();
  return new AdapterError(
    credentialish ? "auth" : "network",
    `${command} did not finish in time and was stopped; it may be waiting for credentials (認証情報の入力待ちの可能性があります)`,
    {
      timedOut: true,
      stderr: redactText(result.stderr.trim()),
      stdout: redactText(result.stdout.trim()),
    },
  );
}

/** Decoder that keeps a leading BOM as U+FEFF instead of stripping it. */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** Cache of the `core.sshCommand` probe, keyed by repository working directory. */
const sshProbeCache = new Map<string, boolean>();

/** Test seam: forget cached `core.sshCommand` probes. */
export function resetGitEnvCache(): void {
  sshProbeCache.clear();
}

function ambientSshCommand(): string | null {
  const value = process.env["GIT_SSH_COMMAND"];
  return value !== undefined && value.trim().length > 0 ? value : null;
}

function hasAmbientSsh(): boolean {
  // GIT_SSH names a program, not a command line, so no option can be appended
  // to it; GIT_SSH_COMMAND is handled in buildEnv instead.
  return Boolean(ambientSshCommand() || process.env["GIT_SSH"]);
}

async function shouldSetBatchSsh(cwd: string): Promise<boolean> {
  if (hasAmbientSsh()) return false;
  const cached = sshProbeCache.get(cwd);
  if (cached !== undefined) return cached;
  const probe = await exec(cwd, ["config", "--get", "core.sshCommand"], {
    skipSshProbe: true,
  });
  const configured = probe.code === 0 && probe.stdout.trim().length > 0;
  const result = !configured;
  sshProbeCache.set(cwd, result);
  return result;
}

function buildEnv(batchSsh: boolean, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // DESIGN.md 7.2: never wait on an interactive prompt; fail as an auth error.
  env["GIT_TERMINAL_PROMPT"] = "0";
  // Stable, parseable porcelain-adjacent output.
  env["LC_ALL"] = "C";
  // DESIGN.md 7.2: SSH must run in BatchMode. An ambient GIT_SSH_COMMAND is
  // respected but still gets BatchMode appended, so an inherited command line
  // cannot re-enable an interactive passphrase prompt.
  const ambient = ambientSshCommand();
  if (ambient !== null) {
    if (!/BatchMode/i.test(ambient)) env["GIT_SSH_COMMAND"] = `${ambient} -o BatchMode=yes`;
  } else if (batchSsh) {
    env["GIT_SSH_COMMAND"] = BATCH_SSH_COMMAND;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function exec(cwd: string, args: string[], opts: RunGitOptions): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const env = buildEnv(false, opts.env);
    finishExec(cwd, args, opts, env, resolve);
  });
}

function finishExec(
  cwd: string,
  args: string[],
  opts: RunGitOptions,
  env: NodeJS.ProcessEnv,
  resolve: (r: GitResult) => void,
): void {
  const child = execFile(
    "git",
    args,
    {
      cwd,
      env,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      encoding: "buffer",
      windowsHide: true,
      timeout: timeoutFor(args, opts),
      killSignal: "SIGTERM",
    },
    (err, stdoutBuf, stderrBuf) => {
      const stdoutRaw = Buffer.isBuffer(stdoutBuf) ? stdoutBuf : Buffer.from(String(stdoutBuf));
      const stderrRaw = Buffer.isBuffer(stderrBuf) ? stderrBuf : Buffer.from(String(stderrBuf));
      let code = 0;
      let signal: NodeJS.Signals | null = null;
      let failedToSpawn = false;
      let timedOut = false;
      let error: Error | undefined;
      if (err) {
        error = err;
        const e = err as Error & {
          code?: number | string;
          signal?: NodeJS.Signals | null;
          killed?: boolean;
        };
        signal = e.signal ?? null;
        // execFile reports a timeout kill as `killed` with the kill signal set.
        // It kills the child for an exceeded maxBuffer the same way, so that
        // case is excluded explicitly.
        timedOut = e.killed === true && signal !== null && !/maxBuffer/i.test(e.message);
        if (typeof e.code === "number") {
          code = e.code;
        } else if (typeof e.code === "string") {
          // ENOENT / EACCES etc: the process never ran.
          failedToSpawn = true;
          code = -1;
        } else {
          code = -1;
        }
      }
      const unobservable = failedToSpawn || (signal !== null && code === -1) || code === -1;
      const result: GitResult = {
        stdout: decodeUtf8(stdoutRaw),
        stderr: decodeUtf8(stderrRaw),
        code,
        stdoutRaw,
        signal,
        failedToSpawn,
        unobservable,
        timedOut,
      };
      if (error) resolve({ ...result, error });
      else resolve(result);
    },
  );
  // Always close stdin so a command that unexpectedly reads it cannot hang.
  const input = opts.stdin;
  if (child.stdin) {
    if (input === undefined) child.stdin.end();
    else child.stdin.end(Buffer.from(typeof input === "string" ? Buffer.from(input, "utf8") : input));
  }
}

/**
 * Run `git <args>` inside `cwd`. Never throws for a non-zero exit code; inspect
 * `code` / `unobservable` instead.
 */
export async function runGit(
  cwd: string,
  args: string[],
  opts: RunGitOptions = {},
): Promise<GitResult> {
  if (opts.skipSshProbe) return exec(cwd, args, opts);
  const batchSsh = await shouldSetBatchSsh(cwd);
  return new Promise<GitResult>((resolve) => {
    const env = buildEnv(batchSsh, opts.env);
    finishExec(cwd, args, opts, env, resolve);
  });
}

export class GitCommandError extends Error {
  readonly result: GitResult;
  readonly args: string[];
  constructor(args: string[], result: GitResult) {
    super(
      redactText(
        `git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      ),
    );
    this.name = "GitCommandError";
    this.args = args;
    this.result = result;
  }
}

/** Run git and throw when the command did not exit successfully. */
export async function runGitOrThrow(
  cwd: string,
  args: string[],
  opts: RunGitOptions = {},
): Promise<GitResult> {
  const result = await runGit(cwd, args, opts);
  if (result.timedOut) throw timeoutError(args, result);
  if (result.code !== 0) throw new GitCommandError(args, result);
  return result;
}

/** Convenience: trimmed stdout of a successful command. */
export async function gitText(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<string> {
  const r = await runGitOrThrow(cwd, args, opts);
  return r.stdout.trim();
}
