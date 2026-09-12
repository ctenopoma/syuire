/** Test fixtures: real Git repositories in temporary directories. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";
import { runGit } from "../src/git.js";

const created: string[] = [];

export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (${r.code}):\n${r.stderr}${r.stdout}`);
  }
  return r.stdout;
}

export async function gitRaw(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await runGit(cwd, args);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

export interface Fixture {
  root: string;
  /** Bare repository standing in for GitHub. */
  remote: string;
  /** The user's clone that the adapter operates. */
  clone: string;
  /** Empty directory used as core.hooksPath so ambient hooks cannot interfere. */
  hooksDir: string;
  write(repo: string, relPath: string, content: string): Promise<void>;
  /** Write raw bytes (binary fixtures such as images). */
  writeBytes(repo: string, relPath: string, bytes: Uint8Array): Promise<void>;
  read(repo: string, relPath: string): Promise<string>;
  exists(repo: string, relPath: string): Promise<boolean>;
  clone2(): Promise<string>;
  installHook(repo: string, name: string, body: string): Promise<void>;
}

async function configureRepo(repo: string, hooksDir: string, extra: Array<[string, string]> = []): Promise<void> {
  const pairs: Array<[string, string]> = [
    ["user.name", "syuire Test"],
    ["user.email", "test@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", hooksDir.replace(/\\/g, "/")],
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
    ["gc.auto", "0"],
    ["advice.detachedHead", "false"],
    ...extra,
  ];
  for (const [key, value] of pairs) {
    await git(repo, ["config", key, value]);
  }
}

export async function makeFixture(
  options: { repoConfig?: Array<[string, string]>; initialFiles?: Record<string, string> } = {},
): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "syuire-"));
  created.push(root);
  const hooksDir = path.join(root, "hooks");
  await fs.mkdir(hooksDir, { recursive: true });

  const remote = path.join(root, "remote.git");
  await fs.mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare", "--initial-branch=main", "."]);

  const clone = path.join(root, "clone");
  await fs.mkdir(clone, { recursive: true });
  await git(clone, ["init", "--initial-branch=main", "."]);
  await configureRepo(clone, hooksDir, options.repoConfig ?? []);

  const files = options.initialFiles ?? {
    "docs/a.md": "# A\n\nfirst paragraph.\n",
    "docs/b.md": "# B\n",
    "other.md": "other\n",
    "third.md": "third\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(clone, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  await git(clone, ["add", "-A"]);
  await git(clone, ["commit", "-m", "initial"]);
  await git(clone, ["remote", "add", "origin", remote.replace(/\\/g, "/")]);
  await git(clone, ["push", "-u", "origin", "main"]);

  let cloneCounter = 0;
  const fixture: Fixture = {
    root,
    remote,
    clone,
    hooksDir,
    async write(repo, relPath, content) {
      const abs = path.join(repo, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
    async writeBytes(repo, relPath, bytes) {
      const abs = path.join(repo, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
    },
    async read(repo, relPath) {
      return fs.readFile(path.join(repo, relPath), "utf8");
    },
    async exists(repo, relPath) {
      try {
        await fs.stat(path.join(repo, relPath));
        return true;
      } catch {
        return false;
      }
    },
    async clone2() {
      cloneCounter += 1;
      const dir = path.join(root, `clone${cloneCounter + 1}`);
      await git(root, ["clone", remote.replace(/\\/g, "/"), dir.replace(/\\/g, "/")]);
      await configureRepo(dir, hooksDir, options.repoConfig ?? []);
      return dir;
    },
    async installHook(repo, name, body) {
      const dir = path.join(repo, ".git", "syuire-hooks");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      await fs.writeFile(file, body, { mode: 0o755 });
      await fs.chmod(file, 0o755).catch(() => undefined);
      await git(repo, ["config", "core.hooksPath", dir.replace(/\\/g, "/")]);
    },
  };
  return fixture;
}

async function removeTree(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows keeps pack files read-only; a leftover temp directory is harmless.
  }
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await removeTree(dir);
  }
});

export function uuid(): string {
  return crypto.randomUUID();
}
