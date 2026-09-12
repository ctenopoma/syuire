/**
 * Client for the local host layer (DESIGN.md 3, 7.2).
 *
 * The browser UI talks to the same-origin `/api/*` routes served by
 * `@syuire/local`. Every request carries the per-launch session token and is
 * made with `cache: "no-store"` (DESIGN.md 8).
 */

import {
  AdapterError,
  type AdapterErrorKind,
  type CommitInput,
  type CommitResult,
  type Entry,
  type LocalRecoveryInfo,
  type LocalRepositoryAdapter,
  type Snapshot,
  type SyncStatus,
} from "@syuire/core";

export interface LocalRepoInfo {
  repoRoot: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  authorName: string | null;
  authorEmail: string | null;
}

export interface LocalResolveUnknownResult {
  resolved: "committed-complete" | "committed-needs-recovery" | "not-committed";
  commitId?: string;
  recovery: LocalRecoveryInfo | null;
}

interface ErrorBody {
  error?: { kind?: unknown; message?: unknown; details?: unknown };
}

const KINDS: readonly AdapterErrorKind[] = [
  "conflict",
  "auth",
  "permission",
  "not-found",
  "too-large",
  "rate-limit",
  "validation",
  "worktree-dirty",
  "worktree-recovery",
  "commit-failed",
  "repo-state",
  "network",
  "internal",
];

function toKind(value: unknown): AdapterErrorKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value)
    ? (value as AdapterErrorKind)
    : "internal";
}

export interface LocalAdapterClientOptions {
  /** Base URL of the local host layer. Defaults to the current origin. */
  baseUrl?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export class LocalAdapterClient implements LocalRepositoryAdapter {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, options: LocalAdapterClientOptions = {}) {
    this.#token = token;
    this.#baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async #request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers, cache: "no-store", credentials: "omit" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${route}`, init);
    } catch (err) {
      throw new AdapterError("network", `the local host layer is unreachable: ${String(err)}`);
    }

    let payload: unknown = null;
    const text = await response.text().catch(() => "");
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const err = (payload as ErrorBody | null)?.error;
      const message =
        typeof err?.message === "string" ? err.message : `request failed with ${response.status}`;
      throw new AdapterError(toKind(err?.kind), message, err?.details ?? null);
    }
    return payload as T;
  }

  // -- RepositoryAdapter ---------------------------------------------------

  async head(): Promise<string> {
    const r = await this.#request<{ head: string }>("GET", "/api/head");
    return r.head;
  }

  async list(dir: string, revision: string): Promise<Entry[]> {
    const query = new URLSearchParams({ dir, revision });
    const r = await this.#request<{ entries: Entry[] }>("GET", `/api/list?${query.toString()}`);
    return r.entries;
  }

  read(paths: string[], revision?: string): Promise<Snapshot> {
    const body = revision === undefined ? { paths } : { paths, revision };
    return this.#request<Snapshot>("POST", "/api/read", body);
  }

  commit(input: CommitInput): Promise<CommitResult> {
    return this.#request<CommitResult>("POST", "/api/commit", input);
  }

  /**
   * Raw bytes of one repository file at one revision (DESIGN.md 6). The host
   * layer streams `application/octet-stream`; nothing is text-decoded here.
   * A missing path at that revision is null, not an error.
   */
  async readBlob(
    path: string,
    revision: string,
  ): Promise<{ bytes: Uint8Array; blobId: string } | null> {
    const query = new URLSearchParams({ path, revision });
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: "application/octet-stream",
    };
    const init: RequestInit = { method: "GET", headers, cache: "no-store", credentials: "omit" };

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/blob?${query.toString()}`, init);
    } catch (err) {
      throw new AdapterError("network", `the local host layer is unreachable: ${String(err)}`);
    }

    if (response.status === 404) return null;
    if (!response.ok) {
      let payload: unknown = null;
      const text = await response.text().catch(() => "");
      if (text.length > 0) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          payload = null;
        }
      }
      const err = (payload as ErrorBody | null)?.error;
      const message =
        typeof err?.message === "string" ? err.message : `request failed with ${response.status}`;
      throw new AdapterError(toKind(err?.kind), message, err?.details ?? null);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const etag = response.headers?.get?.("etag") ?? null;
    const blobId = etag === null ? "" : etag.replace(/^W\//, "").replace(/^"|"$/g, "");
    return { bytes, blobId };
  }

  // -- LocalRepositoryAdapter ---------------------------------------------

  fetch(): Promise<SyncStatus> {
    return this.#request<SyncStatus>("POST", "/api/fetch");
  }

  pull(): Promise<SyncStatus> {
    return this.#request<SyncStatus>("POST", "/api/pull");
  }

  push(): Promise<SyncStatus> {
    return this.#request<SyncStatus>("POST", "/api/push");
  }

  sync(): Promise<SyncStatus> {
    return this.#request<SyncStatus>("GET", "/api/sync");
  }

  async findBatchCommit(batchId: string): Promise<string | null> {
    const query = new URLSearchParams({ batchId });
    const r = await this.#request<{ commitId: string | null }>(
      "GET",
      `/api/batch?${query.toString()}`,
    );
    return r.commitId;
  }

  async recovery(): Promise<LocalRecoveryInfo | null> {
    const r = await this.#request<{ recovery: LocalRecoveryInfo | null }>("GET", "/api/recovery");
    return r.recovery;
  }

  // -- local-only extras ---------------------------------------------------

  info(): Promise<LocalRepoInfo> {
    return this.#request<LocalRepoInfo>("GET", "/api/info");
  }

  async cancelPrepared(): Promise<LocalRecoveryInfo | null> {
    const r = await this.#request<{ recovery: LocalRecoveryInfo | null }>(
      "POST",
      "/api/recovery/cancel",
    );
    return r.recovery;
  }

  resolveUnknown(): Promise<LocalResolveUnknownResult> {
    return this.#request<LocalResolveUnknownResult>("POST", "/api/recovery/resolve-unknown");
  }

  async clearRecovery(): Promise<LocalRecoveryInfo | null> {
    const r = await this.#request<{ recovery: LocalRecoveryInfo | null }>(
      "POST",
      "/api/recovery/clear",
    );
    return r.recovery;
  }
}
