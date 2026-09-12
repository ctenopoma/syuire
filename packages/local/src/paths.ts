/**
 * Repo-relative path safety.
 *
 * DESIGN.md 7: "書込対象は選択リポジトリ内の Markdown と退避ログに限定する。
 * `.git`、シンボリックリンクによる範囲外アクセスを拒否する。"
 *
 * The adapter API speaks `/`-separated, repository-relative paths. Everything
 * that reaches the filesystem goes through {@link resolveRepoPath}.
 */

import { AdapterError } from "@syuire/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Cheap, synchronous syntax checks. Throws AdapterError("validation"). */
export function validateRepoPathSyntax(p: string, what = "path"): string[] {
  if (typeof p !== "string" || p.length === 0) {
    throw new AdapterError("validation", `${what} must be a non-empty string`);
  }
  if (p.includes("\0")) {
    throw new AdapterError("validation", `${what} must not contain NUL: ${JSON.stringify(p)}`);
  }
  if (p.includes("\\")) {
    throw new AdapterError(
      "validation",
      `${what} must use "/" separators, got ${JSON.stringify(p)}`,
    );
  }
  if (p.startsWith("/") || WINDOWS_DRIVE.test(p) || path.isAbsolute(p)) {
    throw new AdapterError("validation", `${what} must be repository-relative: ${p}`);
  }
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "") {
      throw new AdapterError("validation", `${what} must not contain empty segments: ${p}`);
    }
    if (seg === "." || seg === "..") {
      throw new AdapterError("validation", `${what} must not contain "." or ".." segments: ${p}`);
    }
    if (seg.toLowerCase() === ".git") {
      throw new AdapterError("validation", `${what} must not touch the .git directory: ${p}`);
    }
    if (seg.endsWith(" ") || seg.endsWith(".")) {
      // Windows silently trims these, which would break the identity of the path.
      throw new AdapterError(
        "validation",
        `${what} segment must not end with a space or dot: ${p}`,
      );
    }
  }
  return segments;
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  return !path.isAbsolute(rel);
}

/**
 * Validate `p` and return its absolute filesystem path inside `repoRoot`.
 *
 * Rejects absolute paths, `..` segments, `.git`, any existing path component
 * that is a symlink, and anything whose nearest existing ancestor resolves
 * outside `repoRoot`.
 */
export async function resolveRepoPath(repoRoot: string, p: string, what = "path"): Promise<string> {
  const segments = validateRepoPathSyntax(p, what);
  const rootReal = (await realpathOrNull(repoRoot)) ?? path.resolve(repoRoot);

  let current = path.resolve(repoRoot);
  let deepestExisting = rootReal;
  for (const seg of segments) {
    current = path.join(current, seg);
    let st;
    try {
      st = await fs.lstat(current);
    } catch {
      // Does not exist (yet). Remaining components cannot be symlinks.
      break;
    }
    if (st.isSymbolicLink()) {
      throw new AdapterError(
        "validation",
        `${what} passes through a symbolic link, which is not allowed: ${p}`,
      );
    }
    const real = await realpathOrNull(current);
    if (real === null) break;
    deepestExisting = real;
  }

  if (!isInside(rootReal, deepestExisting)) {
    throw new AdapterError("validation", `${what} resolves outside the repository: ${p}`);
  }
  return path.join(path.resolve(repoRoot), ...segments);
}

/** Same as {@link resolveRepoPath} but also accepts "" for the repository root. */
export async function resolveRepoDir(repoRoot: string, dir: string): Promise<string> {
  if (dir === "" || dir === ".") return path.resolve(repoRoot);
  return resolveRepoPath(repoRoot, dir.replace(/\/+$/, ""), "dir");
}

const REVISION_RE = /^[0-9A-Za-z._/^~@{}+-]+$/;

/** Reject revision strings that could be read as an option or a path escape. */
export function validateRevision(revision: string): string {
  if (typeof revision !== "string" || revision.length === 0) {
    throw new AdapterError("validation", "revision must be a non-empty string");
  }
  if (revision.startsWith("-")) {
    throw new AdapterError("validation", `revision must not start with "-": ${revision}`);
  }
  if (revision.includes("..") || !REVISION_RE.test(revision)) {
    throw new AdapterError("validation", `invalid revision: ${revision}`);
  }
  return revision;
}
