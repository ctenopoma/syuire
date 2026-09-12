/**
 * Small typed queries over one clone. Every helper takes the repository root as
 * `cwd` and structured arguments; none of them build a command string.
 */

import { AdapterError } from "@syuire/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, runGitOrThrow, timeoutError, type GitResult } from "./git.js";
import { redactText } from "./redact.js";

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  object: string;
  size: number | null;
  path: string;
}

/** Parse `git ls-tree -l -z` output. */
export function parseLsTreeZ(stdout: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab);
    const p = record.slice(tab + 1);
    const parts = meta.split(/\s+/).filter((s) => s.length > 0);
    const mode = parts[0];
    const type = parts[1];
    const object = parts[2];
    const sizeText = parts[3];
    if (mode === undefined || type === undefined || object === undefined) continue;
    if (type !== "blob" && type !== "tree" && type !== "commit") continue;
    const size = sizeText !== undefined && /^\d+$/.test(sizeText) ? Number(sizeText) : null;
    out.push({ mode, type, object, size, path: p });
  }
  return out;
}

export async function lsTree(cwd: string, revision: string, repoPath: string): Promise<TreeEntry | null> {
  const r = await runGit(cwd, ["ls-tree", "-l", "-z", revision, "--", repoPath]);
  if (r.code !== 0) return null;
  const entries = parseLsTreeZ(r.stdout);
  return entries.find((e) => e.path === repoPath) ?? null;
}

export async function lsTreeDir(cwd: string, revision: string, dir: string): Promise<TreeEntry[]> {
  const args = dir === "" ? ["ls-tree", "-l", "-z", revision] : ["ls-tree", "-l", "-z", revision, "--", `${dir}/`];
  const r = await runGit(cwd, args);
  if (r.code !== 0) {
    if (r.timedOut) throw timeoutError(args, r);
    if (/not a tree object|unknown revision|Not a valid object name/i.test(r.stderr)) {
      throw new AdapterError("not-found", `revision or directory not found: ${revision}:${dir}`, {
        stderr: redactText(r.stderr.trim()),
      });
    }
    throw new AdapterError("internal", `git ls-tree failed: ${redactText(r.stderr.trim())}`);
  }
  return parseLsTreeZ(r.stdout);
}

/** Hash a work-tree file through .gitattributes / core.autocrlf filters. */
export async function hashObjectFile(cwd: string, repoPath: string): Promise<string | null> {
  const r = await runGit(cwd, ["hash-object", `--path=${repoPath}`, "--", repoPath]);
  if (r.code !== 0) return null;
  const id = r.stdout.trim();
  return /^[0-9a-f]{40,64}$/.test(id) ? id : null;
}

/** Hash in-memory bytes as if they were written to `repoPath`. */
export async function hashObjectBytes(
  cwd: string,
  repoPath: string,
  bytes: Uint8Array,
): Promise<string> {
  const r = await runGitOrThrow(cwd, ["hash-object", `--path=${repoPath}`, "--stdin"], {
    stdin: bytes,
  });
  return r.stdout.trim();
}

export async function revParse(cwd: string, rev: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--verify", "--quiet", rev]);
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
}

export async function gitPath(cwd: string, name: string): Promise<string> {
  const r = await runGitOrThrow(cwd, ["rev-parse", "--git-path", name]);
  const p = r.stdout.trim();
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** DESIGN.md 4.2: merge / rebase / cherry-pick / bisect in progress → read only. */
export async function inProgressOperation(cwd: string): Promise<string | null> {
  const checks: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["BISECT_LOG", "bisect"],
  ];
  for (const entry of checks) {
    const name = entry[0];
    const label = entry[1];
    const p = await gitPath(cwd, name);
    if (await pathExists(p)) return label;
  }
  return null;
}

/** True when the index has no staged difference from HEAD for `repoPath`. */
export async function indexMatchesHead(cwd: string, repoPath: string): Promise<boolean> {
  const r = await runGit(cwd, ["diff", "--cached", "--quiet", "HEAD", "--", repoPath]);
  return r.code === 0;
}

/** True when the work tree matches HEAD for `repoPath` (content and mode). */
export async function worktreeMatchesHead(cwd: string, repoPath: string): Promise<boolean> {
  const r = await runGit(cwd, ["diff", "--quiet", "HEAD", "--", repoPath]);
  return r.code === 0;
}

export async function hasUnmergedEntry(cwd: string, repoPath: string): Promise<boolean> {
  const r = await runGit(cwd, ["ls-files", "-u", "-z", "--", repoPath]);
  if (r.code !== 0) return false;
  return r.stdout.replace(/\0/g, "").trim().length > 0;
}

export async function isTrackedInIndex(cwd: string, repoPath: string): Promise<boolean> {
  const r = await runGit(cwd, ["ls-files", "-z", "--", repoPath]);
  if (r.code !== 0) return false;
  return r.stdout.replace(/\0/g, "").trim().length > 0;
}

export async function isIgnored(cwd: string, repoPath: string): Promise<boolean> {
  const r = await runGit(cwd, ["check-ignore", "-q", "--", repoPath]);
  return r.code === 0;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export async function upstreamRef(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v.length > 0 && v !== "@{u}" ? v : null;
}

export async function aheadBehind(cwd: string): Promise<AheadBehind | null> {
  const r = await runGit(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  if (r.code !== 0) return null;
  const parts = r.stdout.trim().split(/\s+/);
  const ahead = Number(parts[0]);
  const behind = Number(parts[1]);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

export async function configValue(cwd: string, key: string): Promise<string | null> {
  const r = await runGit(cwd, ["config", "--get", key]);
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
}

// -- line-ending detection. DESIGN.md 5.2 -----------------------------------

export interface WorktreeEol {
  /** Effective eol Git reports for the blob it would stage (`i/...`). */
  index: string;
  /** Effective eol Git reports for the file currently on disk (`w/...`). */
  worktree: string;
}

/** Parse one `git ls-files --eol -z` record's `i/<eol> w/<eol> attr/<attrs>` metadata. */
export function parseLsFilesEolRecord(record: string): WorktreeEol | null {
  const tab = record.indexOf("\t");
  const meta = tab >= 0 ? record.slice(0, tab) : record;
  const index = /(?:^|\s)i\/([\w-]+)/.exec(meta)?.[1];
  const worktree = /(?:^|\s)w\/([\w-]+)/.exec(meta)?.[1];
  if (index === undefined || worktree === undefined) return null;
  return { index, worktree };
}

/** The eol style Git currently sees for a path already in the index. */
export async function worktreeEolStyle(cwd: string, repoPath: string): Promise<WorktreeEol | null> {
  const r = await runGit(cwd, ["ls-files", "--eol", "-z", "--", repoPath]);
  if (r.code !== 0) return null;
  const record = r.stdout.split("\0").find((s) => s.length > 0);
  return record === undefined ? null : parseLsFilesEolRecord(record);
}

/**
 * True when a tracked path's work-tree copy currently holds CRLF for content
 * Git normalises to LF in the index — i.e. the case DESIGN.md 5.2 requires us
 * to preserve by writing CRLF back into the work tree.
 */
export async function worktreeWantsCrlf(cwd: string, repoPath: string): Promise<boolean> {
  const eol = await worktreeEolStyle(cwd, repoPath);
  return eol !== null && eol.index === "lf" && eol.worktree === "crlf";
}

export interface AttrTextEol {
  /** `git check-attr` value for `text`: "set" | "unset" | "auto" | "unspecified" | ... */
  text: string;
  /** `git check-attr` value for `eol`: "crlf" | "lf" | "unspecified". */
  eol: string;
}

/** `git check-attr -z text eol -- <path>`, for a path that is not yet tracked. */
export async function checkAttrTextEol(cwd: string, repoPath: string): Promise<AttrTextEol> {
  const r = await runGit(cwd, ["check-attr", "-z", "text", "eol", "--", repoPath]);
  let text = "unspecified";
  let eol = "unspecified";
  if (r.code === 0) {
    // -z record: (<path> NUL <attr> NUL <value> NUL) repeated, one triple per attribute.
    const parts = r.stdout.split("\0");
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const attr = parts[i + 1];
      const value = parts[i + 2];
      if (attr === "text" && value !== undefined) text = value;
      else if (attr === "eol" && value !== undefined) eol = value;
    }
  }
  return { text, eol };
}

/**
 * DESIGN.md 5.2: decide whether a brand-new path (not yet in the index — a
 * review log) should be written to the work tree with CRLF line endings.
 *
 * This mirrors what a real `git checkout` of that path would produce, which
 * is more subtle than "core.autocrlf true means CRLF": an explicit `eol=`
 * attribute always wins; an explicit `-text` is left alone (binary-like, no
 * conversion). Beyond that, normalisation only happens when something
 * actually engages it. With an explicit `text` (or `text=auto`) attribute,
 * `core.autocrlf=true` forces CRLF, `core.autocrlf=input` forces LF (it only
 * normalises on the way in), and a plain `core.autocrlf=false` falls back to
 * `core.eol`. With *no* attribute rule at all, only `core.autocrlf=true`
 * engages normalisation — `core.eol` has no effect on such a path, and
 * `core.autocrlf=false`/`input` never touch it, regardless of `core.eol`.
 * (Verified directly against `git hash-object`/`git checkout` output; the
 * asymmetry is real, not a simplification.)
 */
export async function newPathWantsCrlf(cwd: string, repoPath: string): Promise<boolean> {
  const attrs = await checkAttrTextEol(cwd, repoPath);
  if (attrs.eol === "crlf") return true;
  if (attrs.eol === "lf") return false;
  if (attrs.text === "unset") return false;

  const autocrlf = (await configValue(cwd, "core.autocrlf"))?.trim().toLowerCase() ?? "false";
  if (attrs.text === "set" || attrs.text === "auto") {
    if (autocrlf === "true") return true;
    if (autocrlf === "input") return false;
    const eolCfg = (await configValue(cwd, "core.eol"))?.trim().toLowerCase() ?? "native";
    if (eolCfg === "crlf") return true;
    if (eolCfg === "native") return process.platform === "win32";
    return false;
  }
  // No attribute rule matched at all ("unspecified"): only autocrlf=true converts.
  return autocrlf === "true";
}

/** Classify a failing remote operation as auth / network. DESIGN.md 7.2. */
export function classifyRemoteFailure(result: GitResult, args: string[] = []): AdapterError {
  if (result.timedOut) return timeoutError(args, result);
  const text = `${result.stderr}\n${result.stdout}`;
  if (
    /could not read (Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|Host key verification failed|access denied|remote: Invalid username|403 Forbidden|401 Unauthorized|fatal: could not read Username/i.test(
      text,
    )
  ) {
    return new AdapterError("auth", "Git authentication failed", {
      stderr: redactText(result.stderr.trim()),
    });
  }
  if (/has no upstream branch|does not appear to be a git repository|No configured push destination/i.test(text)) {
    return new AdapterError("validation", "no upstream configured for this branch", {
      stderr: redactText(result.stderr.trim()),
    });
  }
  return new AdapterError("network", "Git could not reach the remote", {
    stderr: redactText(result.stderr.trim() || result.stdout.trim()),
  });
}
