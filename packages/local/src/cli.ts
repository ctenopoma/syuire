#!/usr/bin/env node
/**
 * `syuire serve <clonePath> [--port N] [--no-open]`
 *
 * DESIGN.md 3: this is only a way to start the UI, not a general-purpose CLI
 * for comment operations.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

interface ParsedArgs {
  command: string | null;
  clonePath: string | null;
  port: number | undefined;
  open: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    clonePath: null,
    port: undefined,
    open: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--no-open") {
      parsed.open = false;
    } else if (arg === "--port" || arg === "-p") {
      const next = argv[i + 1];
      i += 1;
      const n = Number(next);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`--port needs a port number, got ${String(next)}`);
      }
      parsed.port = n;
    } else if (arg.startsWith("--port=")) {
      const n = Number(arg.slice("--port=".length));
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`--port needs a port number, got ${arg}`);
      }
      parsed.port = n;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (parsed.command === null) {
      parsed.command = arg;
    } else if (parsed.clonePath === null) {
      parsed.clonePath = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return parsed;
}

const USAGE = `syuire serve <clonePath> [--port N] [--no-open]

Serves the syuire UI from localhost and operates the given existing clone.
`;

/** Open a URL with the platform opener. The URL is always a separate argv item. */
export function openInBrowser(url: string): void {
  const platform = process.platform;
  const done = (err: Error | null): void => {
    if (err) process.stderr.write(`could not open a browser automatically: ${err.message}\n`);
  };
  if (platform === "win32") {
    // Never route the URL through `cmd /c start`: cmd re-parses its argument
    // line, so `&`, `^`, `%VAR%` and friends inside the URL would be
    // interpreted by the shell. rundll32's FileProtocolHandler takes the URL
    // as one opaque argument and hands it to the default browser.
    execFile("rundll32", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, done);
    return;
  }
  if (platform === "darwin") {
    execFile("open", [url], done);
    return;
  }
  execFile("xdg-open", [url], done);
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help || args.command === null) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }
  if (args.command !== "serve") {
    process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
    return 2;
  }
  if (args.clonePath === null) {
    process.stderr.write(`serve needs the path of an existing clone\n\n${USAGE}`);
    return 2;
  }

  let server;
  try {
    server =
      args.port === undefined
        ? await startServer({ repoPath: args.clonePath })
        : await startServer({ repoPath: args.clonePath, port: args.port });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const info = await server.adapter.info();
  const openUrl = `${server.url}/#token=${server.token}`;
  process.stdout.write(`syuire local host layer\n`);
  process.stdout.write(`  repository: ${info.repoRoot}\n`);
  process.stdout.write(`  branch:     ${info.branch ?? "(detached HEAD, read only)"}\n`);
  process.stdout.write(`Open: ${openUrl}\n`);
  process.stdout.write(`Press Ctrl+C to stop.\n`);

  if (args.open) openInBrowser(openUrl);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(`\nstopping\n`);
      void server.close().then(resolve, resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
