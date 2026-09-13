/**
 * Free-form repository input (DESIGN.md 8, 10).
 *
 * The connect form takes one field that accepts whatever the user has at hand:
 *
 * - `owner/repo`, `owner/repo@branch`, `owner/repo@branch:path`
 * - `https://github.com/owner/repo` (with or without `.git`, trailing `/`)
 * - `https://github.com/owner/repo/tree/branch[/dir]`
 * - `https://github.com/owner/repo/blob/branch/path.md`
 * - `git@github.com:owner/repo.git`
 *
 * A branch name containing `/` cannot be told apart from the path in a
 * `tree` / `blob` URL; the first segment is taken as the branch and the user
 * can correct it in the branch field.
 */
import type { GitHubPrefill } from "./hash";
import { parseGhSpec } from "./hash";

const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

function validNames(owner: string, repo: string): boolean {
  return OWNER_REPO.test(owner) && REPO_NAME.test(repo) && repo !== "." && repo !== "..";
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function fromUrl(url: URL): GitHubPrefill | null {
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const segments = url.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map(safeDecode);
  const owner = segments[0] ?? "";
  const repo = stripGitSuffix(segments[1] ?? "");
  if (!validNames(owner, repo)) return null;
  const kind = segments[2];
  let branch = "";
  let path = "";
  if ((kind === "tree" || kind === "blob") && segments.length >= 4) {
    branch = segments[3] ?? "";
    path = segments.slice(4).join("/");
    // A directory link is only useful as a starting folder; keep it as the
    // path so the browser opens there, a file link opens the file itself.
  }
  return { owner, repo, branch, path };
}

/** Parse the repository field. Returns null when nothing usable was typed. */
export function parseRepoInput(text: string): GitHubPrefill | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // git@github.com:owner/repo.git
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (ssh) {
    const owner = ssh[1] ?? "";
    const repo = ssh[2] ?? "";
    return validNames(owner, repo) ? { owner, repo, branch: "", path: "" } : null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return fromUrl(new URL(trimmed));
    } catch {
      return null;
    }
  }
  // github.com/owner/repo without a scheme
  if (/^(?:www\.)?github\.com\//i.test(trimmed)) {
    try {
      return fromUrl(new URL(`https://${trimmed}`));
    } catch {
      return null;
    }
  }

  const spec = parseGhSpec(trimmed);
  if (!spec) return null;
  const repo = stripGitSuffix(spec.repo);
  if (!validNames(spec.owner, repo)) return null;
  return { ...spec, repo };
}

/** Short label for a parsed repository, used in lists and chips. */
export function repoLabel(p: { owner: string; repo: string; branch?: string }): string {
  const base = `${p.owner}/${p.repo}`;
  return p.branch && p.branch.length > 0 ? `${base} @${p.branch}` : base;
}
