/**
 * GitHubAdapter: RepositoryAdapter implementation backed by the GitHub REST
 * (Contents) and Git Data APIs. See DESIGN.md sections 7, 7.1, 7.3, 8.
 *
 * - Reads resolve a branch tip commit and read a fixed revision (Contents API).
 * - Writes go exclusively through the Git Data API: blobs -> tree -> commit ->
 *   non-force ref update, preserving unrelated tree entries and file modes.
 * - Never retries internally. Auth, permission, rate-limit and validation
 *   failures are surfaced as errors, never treated as retryable conflicts.
 * - The token is sent only as an Authorization header; it must never appear
 *   in a request URL or in a thrown error message.
 */
import type {
  Change,
  CommitInput,
  CommitResult,
  Entry,
  RepositoryAdapter,
  Snapshot,
} from "@syuire/core";
import { AdapterError, extractBatchId } from "@syuire/core";

const DEFAULT_API_BASE = "https://api.github.com";
/** DESIGN.md 7.1: v1 edit target is capped at 1 MiB per file. */
const MAX_FILE_SIZE = 1024 * 1024;
/**
 * Upper bound for a binary blob read (images). The Contents API inlines base64
 * up to 1 MiB; beyond that the blobs endpoint serves base64 up to 100 MiB. We
 * refuse anything larger than this so a stray large asset cannot be pulled into
 * the browser.
 */
const MAX_BLOB_SIZE = 20 * 1024 * 1024;

export interface GitHubAdapterOptions {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

interface GitHubContentItem {
  path: string;
  sha: string;
  size?: number;
  type: "file" | "dir" | "symlink" | "submodule";
  encoding?: string;
  content?: string;
}

interface GitHubRefResponse {
  object: { sha: string; type: string };
}

interface GitHubCommitGetResponse {
  sha: string;
  tree: { sha: string };
}

interface GitHubBlobCreateResponse {
  sha: string;
}

interface GitHubBlobGetResponse {
  sha: string;
  size?: number;
  encoding?: string;
  content?: string;
}

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface GitHubTreeGetResponse {
  sha: string;
  tree: GitHubTreeEntry[];
}

interface GitHubTreeCreateResponse {
  sha: string;
}

interface GitHubCommitCreateResponse {
  sha: string;
}

interface GitHubCommitListItem {
  sha: string;
  commit: { message: string };
}

interface GitHubUserResponse {
  login: string;
}

/** Encode a "/"-separated path (branch name or repo path) segment by segment. */
function encodeSegments(pathLike: string): string {
  return pathLike
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class GitHubAdapter implements RepositoryAdapter {
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(options: GitHubAdapterOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
  }

  // -------------------------------------------------------------------
  // RepositoryAdapter
  // -------------------------------------------------------------------

  async head(): Promise<string> {
    return this.getRefSha();
  }

  async list(dir: string, revision: string): Promise<Entry[]> {
    const normalized = normalizePath(dir);
    const path = normalized
      ? `/repos/${this.repoSegment()}/contents/${encodeSegments(normalized)}`
      : `/repos/${this.repoSegment()}/contents`;
    const { data } = await this.fetchJson<GitHubContentItem[] | GitHubContentItem>("GET", path, {
      searchParams: { ref: revision },
    });
    const items = Array.isArray(data) ? data : [data];
    const entries: Entry[] = [];
    for (const item of items) {
      if (item.type === "file") {
        const entry: Entry = { path: item.path, kind: "file", blobId: item.sha };
        if (typeof item.size === "number") entry.size = item.size;
        entries.push(entry);
      } else if (item.type === "dir") {
        entries.push({ path: item.path, kind: "dir", blobId: item.sha });
      }
      // symlink / submodule entries are intentionally skipped.
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return entries;
  }

  async read(paths: string[], revision?: string): Promise<Snapshot> {
    const rev = revision ?? (await this.head());
    const files: Snapshot["files"] = {};
    for (const rawPath of paths) {
      const normalized = normalizePath(rawPath);
      const contentPath = `/repos/${this.repoSegment()}/contents/${encodeSegments(normalized)}`;
      let response: Response;
      try {
        response = await this.rawFetch("GET", contentPath, { searchParams: { ref: rev } });
      } catch {
        throw this.networkError();
      }
      if (response.status === 404) {
        files[rawPath] = null;
        continue;
      }
      if (!response.ok) {
        throw await this.errorFromResponse(response);
      }
      const data = (await response.json()) as GitHubContentItem | GitHubContentItem[];
      if (Array.isArray(data)) {
        throw new AdapterError("validation", `GitHub path is a directory, not a file: ${rawPath}`);
      }
      const tooLarge =
        (typeof data.size === "number" && data.size > MAX_FILE_SIZE) || data.encoding !== "base64";
      if (tooLarge || typeof data.content !== "string") {
        throw new AdapterError(
          "too-large",
          `GitHub file exceeds the 1 MiB edit limit or is unavailable as base64: ${rawPath}`,
        );
      }
      const bytes = base64ToBytes(data.content.replace(/\n/g, ""));
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      files[rawPath] = { text, blobId: data.sha };
    }
    return { revision: rev, files };
  }

  /**
   * Read one path at `revision` as raw bytes (DESIGN.md 6). Files up to 1 MiB
   * carry inline base64 on the Contents API; larger ones report
   * `encoding: "none"` and are fetched from the blobs endpoint, which serves
   * base64 up to 100 MiB. Returns null when the path is absent at that revision.
   */
  async readBlob(
    path: string,
    revision: string,
  ): Promise<{ bytes: Uint8Array; blobId: string } | null> {
    const normalized = normalizePath(path);
    const contentPath = `/repos/${this.repoSegment()}/contents/${encodeSegments(normalized)}`;
    let response: Response;
    try {
      response = await this.rawFetch("GET", contentPath, { searchParams: { ref: revision } });
    } catch {
      throw this.networkError();
    }
    if (response.status === 404) return null;
    if (!response.ok) throw await this.errorFromResponse(response);

    const data = (await response.json()) as GitHubContentItem | GitHubContentItem[];
    if (Array.isArray(data)) {
      throw new AdapterError("validation", `GitHub path is a directory, not a file: ${path}`);
    }
    if (data.type !== "file") {
      throw new AdapterError("validation", `GitHub path is not a regular file: ${path}`);
    }
    if (typeof data.size === "number" && data.size > MAX_BLOB_SIZE) {
      throw new AdapterError("too-large", `GitHub file exceeds the 20 MiB blob limit: ${path}`);
    }

    if (data.encoding === "base64" && typeof data.content === "string") {
      const bytes = base64ToBytes(data.content.replace(/\s+/g, ""));
      if (bytes.length > MAX_BLOB_SIZE) {
        throw new AdapterError("too-large", `GitHub file exceeds the 20 MiB blob limit: ${path}`);
      }
      return { bytes, blobId: data.sha };
    }

    // encoding "none" (over 1 MiB) or a missing body: go through the blobs API.
    const { data: blob } = await this.fetchJson<GitHubBlobGetResponse>(
      "GET",
      `/repos/${this.repoSegment()}/git/blobs/${encodeURIComponent(data.sha)}`,
    );
    if (typeof blob.size === "number" && blob.size > MAX_BLOB_SIZE) {
      throw new AdapterError("too-large", `GitHub file exceeds the 20 MiB blob limit: ${path}`);
    }
    if (blob.encoding !== "base64" || typeof blob.content !== "string") {
      throw new AdapterError(
        "too-large",
        `GitHub blob is not available as base64 (over 100 MiB?): ${path}`,
      );
    }
    const bytes = base64ToBytes(blob.content.replace(/\s+/g, ""));
    if (bytes.length > MAX_BLOB_SIZE) {
      throw new AdapterError("too-large", `GitHub file exceeds the 20 MiB blob limit: ${path}`);
    }
    return { bytes, blobId: blob.sha };
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    const { base, changes, batchId, message } = input;

    // 1. The base revision must still be the branch tip.
    const currentSha = await this.getRefSha();
    if (currentSha !== base.revision) {
      throw new AdapterError("conflict", "GitHub branch has moved since the base revision was read");
    }

    // 1b. DESIGN.md 7.1: v1 edits at most 1 MiB per file. Check every change
    // before anything is created server-side, so an oversized body never
    // becomes a blob.
    for (const change of changes) {
      const bytes = new TextEncoder().encode(change.text).byteLength;
      if (bytes > MAX_FILE_SIZE) {
        throw new AdapterError(
          "too-large",
          `${change.path} is ${bytes} bytes, over the 1 MiB edit limit`,
        );
      }
    }

    // 2. Base tree, read from the base commit.
    const { data: baseCommit } = await this.fetchJson<GitHubCommitGetResponse>(
      "GET",
      `/repos/${this.repoSegment()}/git/commits/${encodeURIComponent(base.revision)}`,
    );
    const baseTreeSha = baseCommit.tree.sha;

    // 3 & 4. Create a blob per change, and resolve the mode of each path by
    // walking the base tree (cached for the duration of this commit() call).
    const treeCache = new Map<string, GitHubTreeGetResponse>();
    const treeEntries: Array<{ path: string; mode: string; type: "blob"; sha: string }> = [];
    for (const change of changes) {
      const resolved = await this.resolveInBaseTree(baseTreeSha, change, treeCache);
      // DESIGN.md 5.4「既存パスには上書きしない」: a path the caller never read
      // is a new-file intent (a review log). If the base tree already has it,
      // committing would silently overwrite somebody else's file.
      if (resolved.exists) {
        const baseEntry = base.files[change.path];
        if (baseEntry === undefined) {
          throw new AdapterError(
            "validation",
            `${change.path} already exists at ${base.revision} but was not read into base.files; refusing to overwrite it`,
          );
        }
        if (baseEntry === null) {
          throw new AdapterError(
            "validation",
            `base says ${change.path} does not exist at ${base.revision}, but it does; refusing to overwrite it`,
          );
        }
      }
      const mode = resolved.mode;
      const { data: blob } = await this.fetchJson<GitHubBlobCreateResponse>(
        "POST",
        `/repos/${this.repoSegment()}/git/blobs`,
        { body: { content: change.text, encoding: "utf-8" } },
      );
      treeEntries.push({ path: change.path, mode, type: "blob", sha: blob.sha });
    }

    // 5. Tree, built from the base tree plus the changed blobs. Unrelated
    // entries are preserved by GitHub via base_tree.
    const { data: newTree } = await this.fetchJson<GitHubTreeCreateResponse>(
      "POST",
      `/repos/${this.repoSegment()}/git/trees`,
      { body: { base_tree: baseTreeSha, tree: treeEntries } },
    );

    // 6. Commit, with the base revision as its sole parent.
    const { data: newCommit } = await this.fetchJson<GitHubCommitCreateResponse>(
      "POST",
      `/repos/${this.repoSegment()}/git/commits`,
      { body: { message, tree: newTree.sha, parents: [base.revision] } },
    );

    // 7. Re-check the ref immediately before publishing it.
    const refBeforeUpdate = await this.getRefSha();
    if (refBeforeUpdate !== base.revision) {
      throw new AdapterError("conflict", "GitHub branch moved before the commit could be published");
    }

    // 8. Non-force ref update. A thrown fetch (network failure / abort)
    // leaves the outcome unknown: we cannot tell whether it landed.
    let updateResponse: Response;
    try {
      updateResponse = await this.rawFetch("PATCH", this.refPath("update"), {
        body: { sha: newCommit.sha, force: false },
      });
    } catch {
      return { status: "unknown", batchId, candidateCommitId: newCommit.sha };
    }
    if (!updateResponse.ok) {
      const status = updateResponse.status;
      // 409 / 422 are GitHub's definite "the ref was not updated" answers, and
      // 401 / 403 mean the request was rejected before it could touch the ref.
      if (status === 409 || status === 422) {
        throw new AdapterError(
          "conflict",
          "GitHub rejected the branch update because it is no longer a fast-forward",
        );
      }
      if (status === 401 || status === 403) {
        throw await this.errorFromResponse(updateResponse);
      }
      // Anything else (5xx, 429, 408, a proxy's own error page...) tells us
      // nothing about whether the ref moved. DESIGN.md 7: ref 更新結果が不明なら
      // unknown. The caller confirms via the batch trailer before re-saving.
      return { status: "unknown", batchId, candidateCommitId: newCommit.sha };
    }

    // 9. Done.
    return { status: "committed", commitId: newCommit.sha, localReflection: "not-applicable" };
  }

  // -------------------------------------------------------------------
  // Extra capabilities used for recovery and authorship (DESIGN.md 5.1, 7.3)
  // -------------------------------------------------------------------

  /** Find a commit on the session branch carrying the syuire-Batch trailer. */
  async findBatchCommit(batchId: string): Promise<string | null> {
    const { data } = await this.fetchJson<GitHubCommitListItem[]>(
      "GET",
      `/repos/${this.repoSegment()}/commits`,
      { searchParams: { sha: this.branch, per_page: "50" } },
    );
    for (const item of data) {
      if (extractBatchId(item.commit.message) === batchId) {
        return item.sha;
      }
    }
    return null;
  }

  async currentUserLogin(): Promise<string> {
    const { data } = await this.fetchJson<GitHubUserResponse>("GET", "/user");
    return data.login;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private repoSegment(): string {
    return `${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  private refPath(kind: "get" | "update"): string {
    const branchSegment = encodeSegments(this.branch);
    return kind === "get"
      ? `/repos/${this.repoSegment()}/git/ref/heads/${branchSegment}`
      : `/repos/${this.repoSegment()}/git/refs/heads/${branchSegment}`;
  }

  private async getRefSha(): Promise<string> {
    const { data } = await this.fetchJson<GitHubRefResponse>("GET", this.refPath("get"));
    return data.object.sha;
  }

  private async getTree(sha: string, cache: Map<string, GitHubTreeGetResponse>): Promise<GitHubTreeGetResponse> {
    const cached = cache.get(sha);
    if (cached) return cached;
    const { data } = await this.fetchJson<GitHubTreeGetResponse>(
      "GET",
      `/repos/${this.repoSegment()}/git/trees/${encodeURIComponent(sha)}`,
    );
    cache.set(sha, data);
    return data;
  }

  /**
   * Walk the base tree segment by segment. Returns the mode the new tree entry
   * must carry and whether the path already exists at the base revision.
   */
  private async resolveInBaseTree(
    baseTreeSha: string,
    change: Change,
    cache: Map<string, GitHubTreeGetResponse>,
  ): Promise<{ mode: string; exists: boolean }> {
    const segments = normalizePath(change.path)
      .split("/")
      .filter((segment) => segment.length > 0);
    let treeSha = baseTreeSha;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      const tree = await this.getTree(treeSha, cache);
      const found = tree.tree.find((entry) => entry.path === segment);
      const isLast = i === segments.length - 1;
      if (!found) {
        // New path (or a new path underneath an existing directory): default mode.
        return { mode: "100644", exists: false };
      }
      if (isLast) {
        if (found.type !== "blob") {
          throw new AdapterError("validation", `GitHub path is not a file: ${change.path}`);
        }
        return { mode: found.mode, exists: true };
      }
      if (found.type !== "tree") {
        throw new AdapterError(
          "validation",
          `GitHub path conflicts with an existing file: ${change.path}`,
        );
      }
      treeSha = found.sha;
    }
    return { mode: "100644", exists: false };
  }

  private buildUrl(path: string, searchParams?: Record<string, string | undefined>): string {
    let url = `${this.apiBase}${path}`;
    if (searchParams) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        if (value !== undefined) qs.set(key, value);
      }
      const serialized = qs.toString();
      if (serialized) url += `?${serialized}`;
    }
    return url;
  }

  private async rawFetch(
    method: string,
    path: string,
    opts: { searchParams?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<Response> {
    const url = this.buildUrl(path, opts.searchParams);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const init: RequestInit = { method, headers, cache: "no-store" };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return this.fetchImpl(url, init);
  }

  private networkError(): AdapterError {
    return new AdapterError("network", "GitHub request failed due to a network error");
  }

  private async fetchJson<T>(
    method: string,
    path: string,
    opts: { searchParams?: Record<string, string | undefined>; body?: unknown; refUpdate?: boolean } = {},
  ): Promise<{ data: T; response: Response }> {
    let response: Response;
    try {
      response = await this.rawFetch(method, path, opts);
    } catch {
      throw this.networkError();
    }
    if (!response.ok) {
      throw await this.errorFromResponse(response, opts.refUpdate ?? false);
    }
    if (response.status === 204) {
      return { data: undefined as T, response };
    }
    const data = (await response.json()) as T;
    return { data, response };
  }

  private async errorFromResponse(response: Response, refUpdate = false): Promise<AdapterError> {
    let message = "";
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "message" in body) {
        const raw = (body as { message?: unknown }).message;
        if (typeof raw === "string") message = raw;
      }
    } catch {
      // Body wasn't JSON (or already consumed) - proceed without a message.
    }
    const suffix = message ? `: ${message}` : "";
    const status = response.status;

    if (status === 401) {
      return new AdapterError("auth", `GitHub authentication failed${suffix}`);
    }
    if (status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0" || /rate limit/i.test(message)) {
        return new AdapterError("rate-limit", `GitHub rate limit exceeded${suffix}`);
      }
      return new AdapterError("permission", `GitHub permission denied${suffix}`);
    }
    if (status === 404) {
      return new AdapterError("not-found", `GitHub resource not found${suffix}`);
    }
    if (status === 409) {
      return new AdapterError("conflict", `GitHub conflict${suffix}`);
    }
    if (status === 422) {
      if (refUpdate) {
        return new AdapterError("conflict", `GitHub ref update rejected${suffix}`);
      }
      return new AdapterError("validation", `GitHub validation failed${suffix}`);
    }
    if (status >= 500) {
      return new AdapterError("network", `GitHub server error${suffix}`);
    }
    return new AdapterError("network", `GitHub request failed with status ${status}${suffix}`);
  }
}
