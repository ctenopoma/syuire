/**
 * URL fragment handling (DESIGN.md 8).
 *
 * Only the fragment may carry repository / branch / path, never a query string
 * and never a PAT. The local host layer launches the UI with `#token=<session>`.
 */

export interface GitHubPrefill {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export type DeepLink =
  | { kind: "local"; token: string }
  | { kind: "github"; prefill: GitHubPrefill }
  | { kind: "none" };

/** Parse `owner/repo`, `owner/repo@branch` or `owner/repo@branch:path`. */
export function parseGhSpec(spec: string): GitHubPrefill | null {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return null;

  let rest = trimmed;
  let path = "";
  let branch = "";

  const at = rest.indexOf("@");
  if (at >= 0) {
    const tail = rest.slice(at + 1);
    rest = rest.slice(0, at);
    const colon = tail.indexOf(":");
    if (colon >= 0) {
      branch = tail.slice(0, colon);
      path = tail.slice(colon + 1);
    } else {
      branch = tail;
    }
  }

  const parts = rest.split("/");
  if (parts.length !== 2) return null;
  const owner = (parts[0] ?? "").trim();
  const repo = (parts[1] ?? "").trim();
  if (owner.length === 0 || repo.length === 0) return null;

  return {
    owner,
    repo,
    branch: branch.trim(),
    path: path.trim().replace(/^\/+/, ""),
  };
}

/** Build the fragment value for a connection. Never called with a token. */
export function formatGhSpec(prefill: GitHubPrefill): string {
  const base = `${prefill.owner}/${prefill.repo}`;
  if (prefill.branch.length === 0) return base;
  const withBranch = `${base}@${prefill.branch}`;
  return prefill.path.length > 0 ? `${withBranch}:${prefill.path}` : withBranch;
}

/**
 * Read a deep link out of `location.hash`.
 * `#token=...` wins over `#gh=...` so a local launch is never mistaken for a
 * GitHub prefill.
 */
export function parseHash(hash: string): DeepLink {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return { kind: "none" };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { kind: "none" };
  }

  const token = params.get("token");
  if (token !== null && token.length > 0) {
    return { kind: "local", token };
  }

  const gh = params.get("gh");
  if (gh !== null) {
    const prefill = parseGhSpec(gh);
    if (prefill) return { kind: "github", prefill };
  }

  return { kind: "none" };
}
