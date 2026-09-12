/**
 * Save state machine (DESIGN.md 4.1, 7.1, 7.3).
 *
 * A save is: re-read when the base moved -> re-apply the whole queue ->
 * one commit carrying the batch id. Conflicts hold the entire batch; an unknown
 * result must be confirmed against the branch history before anything is
 * re-committed, and the batch id is reused so comment ids never change.
 */
import { AdapterError, applyOperations, formatCommitMessage } from "@akaire/core";
import type {
  AdapterErrorKind,
  Operation,
  RepositoryAdapter,
  Snapshot,
} from "@akaire/core";

export interface BatchAwareAdapter extends RepositoryAdapter {
  findBatchCommit(batchId: string): Promise<string | null>;
}

export interface ConflictReport {
  op: Operation;
  reason: string;
}

export interface SaveRequest {
  adapter: RepositoryAdapter;
  path: string;
  base: Snapshot;
  ops: Operation[];
  batchId: string;
  /** DESIGN.md 7.3: automatic retries are capped at 2. */
  maxConflictRetries?: number;
  /** Commit summary line; the batch trailer is appended by core. */
  summary?: (opCount: number) => string;
}

export type SaveResult =
  | { status: "nothing"; base: Snapshot }
  | { status: "committed"; base: Snapshot; commitId: string; batchId: string; rereadError?: string }
  | {
      status: "needs-recovery";
      base: Snapshot;
      commitId: string;
      batchId: string;
      paths: string[];
      reason: string;
      /** Set when the post-commit re-read failed; `base` then only carries the new revision. */
      rereadError?: string;
    }
  | { status: "unknown"; base: Snapshot; batchId: string; candidateCommitId?: string }
  | { status: "conflicts"; base: Snapshot; conflicts: ConflictReport[] }
  | { status: "error"; base: Snapshot; kind: AdapterErrorKind; message: string };

export function defaultSummary(opCount: number): string {
  return `akaire: 朱 ${opCount} 件`;
}

function fileText(base: Snapshot, path: string): string | null {
  const entry = base.files[path];
  return entry ? entry.text : null;
}

/** Re-read the file at `revision` when the branch tip moved. */
async function refreshBase(
  adapter: RepositoryAdapter,
  path: string,
  base: Snapshot,
): Promise<Snapshot> {
  const head = await adapter.head();
  if (head === base.revision) return base;
  return adapter.read([path], head);
}

/**
 * Re-read `path` at a commit that is already confirmed. On failure the old
 * snapshot is kept for its text, but the revision advances to `commitId`: the
 * commit exists, so continuing to call the old revision "current" would let the
 * next save be built on a base that is no longer the branch tip.
 */
async function readAt(
  adapter: RepositoryAdapter,
  path: string,
  commitId: string,
  fallback: Snapshot,
): Promise<{ base: Snapshot; error?: string }> {
  try {
    return { base: await adapter.read([path], commitId) };
  } catch (err) {
    return { base: { revision: commitId, files: fallback.files }, error: errorMessage(err) };
  }
}

export async function runSave(request: SaveRequest): Promise<SaveResult> {
  const { adapter, path, ops, batchId } = request;
  const maxRetries = request.maxConflictRetries ?? 2;
  const summary = request.summary ?? defaultSummary;
  let base = request.base;

  if (ops.length === 0) return { status: "nothing", base };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // (a) base revision check / re-read
    try {
      base = await refreshBase(adapter, path, base);
    } catch (err) {
      return toErrorResult(base, err);
    }

    const text = fileText(base, path);
    if (text === null) {
      return {
        status: "error",
        base,
        kind: "not-found",
        message: `対象のファイルが見つかりません: ${path}`,
      };
    }

    // (b) re-apply the whole queue on the (possibly new) base
    const applied = applyOperations(text, ops);
    if (!applied.ok) {
      const conflicts: ConflictReport[] = [];
      for (const entry of applied.outcomes) {
        if (entry.outcome.status === "conflict") {
          conflicts.push({ op: entry.op, reason: entry.outcome.reason });
        }
      }
      return { status: "conflicts", base, conflicts };
    }

    // (c) one commit for the whole batch
    const message = formatCommitMessage(summary(ops.length), batchId);
    let result;
    try {
      result = await adapter.commit({
        base,
        changes: [{ path, text: applied.source }],
        batchId,
        message,
      });
    } catch (err) {
      if (err instanceof AdapterError && err.kind === "conflict" && attempt < maxRetries) {
        continue;
      }
      if (err instanceof AdapterError && err.kind === "conflict") {
        return {
          status: "error",
          base,
          kind: "conflict",
          message: "更新が続いています。時間をおいて保存し直してください。",
        };
      }
      return toErrorResult(base, err);
    }

    // (d) outcome
    if (result.status === "unknown") {
      return result.candidateCommitId === undefined
        ? { status: "unknown", base, batchId }
        : { status: "unknown", base, batchId, candidateCommitId: result.candidateCommitId };
    }
    // The commit is confirmed in both remaining cases, so the base always
    // advances to the new commit. When the re-read fails we still adopt the new
    // revision (DESIGN.md 4.1: 確定の根拠は対象 ref への反映とコミット ID) and
    // report `rereadError` so the caller can show the body as stale instead of
    // pretending the old revision is current.
    const reread = await readAt(adapter, path, result.commitId, base);

    if (result.localReflection === "needs-recovery") {
      const info = {
        status: "needs-recovery" as const,
        base: reread.base,
        commitId: result.commitId,
        batchId,
        paths: result.paths,
        reason: result.reason,
      };
      return reread.error === undefined ? info : { ...info, rereadError: reread.error };
    }
    return reread.error === undefined
      ? { status: "committed", base: reread.base, commitId: result.commitId, batchId }
      : {
          status: "committed",
          base: reread.base,
          commitId: result.commitId,
          batchId,
          rereadError: reread.error,
        };
  }

  return {
    status: "error",
    base,
    kind: "conflict",
    message: "更新が続いています。時間をおいて保存し直してください。",
  };
}

export type ConfirmResult =
  | { status: "found"; commitId: string; base: Snapshot }
  | { status: "not-found" }
  | { status: "error"; kind: AdapterErrorKind; message: string };

/**
 * Resolve a "保存結果未確認" batch by looking for the batch trailer in the
 * branch history (DESIGN.md 7.3). Never commits.
 */
export async function confirmBatch(
  adapter: BatchAwareAdapter,
  path: string,
  batchId: string,
): Promise<ConfirmResult> {
  let commitId: string | null;
  try {
    commitId = await adapter.findBatchCommit(batchId);
  } catch (err) {
    return { status: "error", kind: errorKind(err), message: errorMessage(err) };
  }
  if (commitId === null) return { status: "not-found" };
  try {
    const base = await adapter.read([path], commitId);
    return { status: "found", commitId, base };
  } catch (err) {
    return { status: "error", kind: errorKind(err), message: errorMessage(err) };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof AdapterError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorKind(err: unknown): AdapterErrorKind {
  return err instanceof AdapterError ? err.kind : "internal";
}

function toErrorResult(
  base: Snapshot,
  err: unknown,
): { status: "error"; base: Snapshot; kind: AdapterErrorKind; message: string } {
  return { status: "error", base, kind: errorKind(err), message: errorMessage(err) };
}
