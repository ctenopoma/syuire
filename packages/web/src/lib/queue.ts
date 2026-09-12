/**
 * Unsaved operation queue: storage key, sessionStorage mirroring, export /
 * import format and dependent-operation removal (DESIGN.md 7.3, 8).
 *
 * Only operations, the connection descriptor and the base revision are stored -
 * never the manuscript, never a token.
 */
import type { LocalRecoveryInfo, Operation } from "@akaire/core";

export type ConnectionMode = "github" | "local";

export interface QueueContext {
  mode: ConnectionMode;
  /** `owner/repo` for GitHub, the clone root for local. */
  repoKey: string;
  branch: string;
  path: string;
}

/** Connection identity without a file: recovery info belongs to the clone, not to one file. */
export interface RepoContext {
  mode: ConnectionMode;
  repoKey: string;
  branch: string;
}

export const QUEUE_FORMAT = "akaire.queue";
export const QUEUE_VERSION = 1;

export interface QueueEnvelope {
  format: typeof QUEUE_FORMAT;
  version: number;
  context: QueueContext;
  baseRevision: string;
  savedAt: string;
  ops: Operation[];
  /**
   * DESIGN.md 8: 保存結果未確認・反映要復旧の情報は通常の未保存操作として破棄しない。
   * Both travel with the export so a device failure cannot strand them.
   */
  pending?: PendingBatch;
  recovery?: LocalRecoveryInfo;
}

export interface PendingBatch {
  batchId: string;
  candidateCommitId?: string;
  startedAt: string;
}

/** Storage subset used here, so tests can pass a plain map. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

export function queueStorageKey(context: QueueContext): string {
  return [
    "akaire.queue",
    context.mode,
    encodePart(context.repoKey),
    encodePart(context.branch),
    encodePart(context.path),
  ].join(":");
}

export function pendingBatchStorageKey(context: QueueContext): string {
  return [
    "akaire.batch",
    context.mode,
    encodePart(context.repoKey),
    encodePart(context.branch),
    encodePart(context.path),
  ].join(":");
}

export function recoveryStorageKey(context: RepoContext): string {
  return [
    "akaire.recovery",
    context.mode,
    encodePart(context.repoKey),
    encodePart(context.branch),
  ].join(":");
}

export function sameContext(a: QueueContext, b: QueueContext): boolean {
  return a.mode === b.mode && a.repoKey === b.repoKey && a.branch === b.branch && a.path === b.path;
}

export function makeEnvelope(
  context: QueueContext,
  baseRevision: string,
  ops: Operation[],
  savedAt: string,
  extra: { pending?: PendingBatch | null; recovery?: LocalRecoveryInfo | null } = {},
): QueueEnvelope {
  const envelope: QueueEnvelope = {
    format: QUEUE_FORMAT,
    version: QUEUE_VERSION,
    context,
    baseRevision,
    savedAt,
    ops,
  };
  if (extra.pending != null) envelope.pending = extra.pending;
  if (extra.recovery != null) envelope.recovery = extra.recovery;
  return envelope;
}

export function serializeQueue(envelope: QueueEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export type ParsedQueue = { ok: true; envelope: QueueEnvelope } | { ok: false; reason: string };

function isOperation(value: unknown): value is Operation {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "addComment" || kind === "addReply" || kind === "setState" || kind === "reanchor"
  );
}

export function parseQueue(text: string): ParsedQueue {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "JSON として読み取れません" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "JSON の内容が想定と異なります" };
  }
  const obj = raw as Partial<QueueEnvelope>;
  if (obj.format !== QUEUE_FORMAT) {
    return { ok: false, reason: "akaire のキュー書き出しではありません" };
  }
  if (obj.version !== QUEUE_VERSION) {
    return { ok: false, reason: `未対応のバージョンです: ${String(obj.version)}` };
  }
  const context = obj.context;
  if (
    typeof context !== "object" ||
    context === null ||
    typeof context.repoKey !== "string" ||
    typeof context.branch !== "string" ||
    typeof context.path !== "string" ||
    (context.mode !== "github" && context.mode !== "local")
  ) {
    return { ok: false, reason: "接続先の情報が壊れています" };
  }
  if (typeof obj.baseRevision !== "string" || obj.baseRevision.length === 0) {
    return { ok: false, reason: "基準リビジョンがありません" };
  }
  if (!Array.isArray(obj.ops) || !obj.ops.every(isOperation)) {
    return { ok: false, reason: "操作の配列が壊れています" };
  }
  const envelope: QueueEnvelope = {
    format: QUEUE_FORMAT,
    version: QUEUE_VERSION,
    context: {
      mode: context.mode,
      repoKey: context.repoKey,
      branch: context.branch,
      path: context.path,
    },
    baseRevision: obj.baseRevision,
    savedAt: typeof obj.savedAt === "string" ? obj.savedAt : "",
    ops: obj.ops,
  };
  const pending = toPendingBatch(obj.pending);
  if (pending !== null) envelope.pending = pending;
  const recovery = toRecoveryInfo(obj.recovery);
  if (recovery !== null) envelope.recovery = recovery;
  return { ok: true, envelope };
}

/** Validate a pending batch record coming from storage or an imported file. */
export function toPendingBatch(value: unknown): PendingBatch | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<PendingBatch>;
  if (typeof raw.batchId !== "string" || raw.batchId.length === 0) return null;
  const pending: PendingBatch = {
    batchId: raw.batchId,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
  };
  if (typeof raw.candidateCommitId === "string") pending.candidateCommitId = raw.candidateCommitId;
  return pending;
}

const RECOVERY_PHASES = ["prepared-uncommitted", "result-unknown", "committed-needs-recovery"];

/** Validate a LocalRecoveryInfo coming from storage or an imported file. */
export function toRecoveryInfo(value: unknown): LocalRecoveryInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<LocalRecoveryInfo>;
  if (typeof raw.batchId !== "string" || raw.batchId.length === 0) return null;
  if (typeof raw.phase !== "string" || !RECOVERY_PHASES.includes(raw.phase)) return null;
  if (typeof raw.baseCommitId !== "string") return null;
  if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== "string")) return null;
  const info: LocalRecoveryInfo = {
    batchId: raw.batchId,
    phase: raw.phase,
    baseCommitId: raw.baseCommitId,
    paths: raw.paths,
    blobs:
      typeof raw.blobs === "object" && raw.blobs !== null
        ? (raw.blobs as LocalRecoveryInfo["blobs"])
        : {},
  };
  if (typeof raw.newCommitId === "string") info.newCommitId = raw.newCommitId;
  if (typeof raw.reason === "string") info.reason = raw.reason;
  return info;
}

export function saveQueueTo(
  storage: StorageLike,
  context: QueueContext,
  baseRevision: string,
  ops: Operation[],
  savedAt: string,
): void {
  const key = queueStorageKey(context);
  if (ops.length === 0) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, serializeQueue(makeEnvelope(context, baseRevision, ops, savedAt)));
}

export function loadQueueFrom(storage: StorageLike, context: QueueContext): QueueEnvelope | null {
  const text = storage.getItem(queueStorageKey(context));
  if (text === null) return null;
  const parsed = parseQueue(text);
  if (!parsed.ok) return null;
  return sameContext(parsed.envelope.context, context) ? parsed.envelope : null;
}

export function savePendingBatch(
  storage: StorageLike,
  context: QueueContext,
  pending: PendingBatch | null,
): void {
  const key = pendingBatchStorageKey(context);
  if (pending === null) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(pending));
}

export function loadPendingBatch(
  storage: StorageLike,
  context: QueueContext,
): PendingBatch | null {
  const text = storage.getItem(pendingBatchStorageKey(context));
  if (text === null) return null;
  try {
    return toPendingBatch(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * DESIGN.md 8: the local recovery record lives in memory and `sessionStorage`
 * until the local reflection completes. The authoritative copy is the host
 * layer's; this mirror only exists so a reconnect can notice that the host lost
 * a batch it had already prepared.
 */
export function saveRecoveryMirror(
  storage: StorageLike,
  context: RepoContext,
  info: LocalRecoveryInfo | null,
): void {
  const key = recoveryStorageKey(context);
  if (info === null) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(info));
}

export function loadRecoveryMirror(
  storage: StorageLike,
  context: RepoContext,
): LocalRecoveryInfo | null {
  const text = storage.getItem(recoveryStorageKey(context));
  if (text === null) return null;
  try {
    return toRecoveryInfo(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Comment id an operation belongs to. */
export function operationCommentId(op: Operation): string {
  return op.kind === "addComment" ? op.comment.id : op.commentId;
}

/**
 * Remove one operation. Removing an `addComment` also removes every queued
 * reply / state change / re-anchor that depends on it, because those would
 * conflict with "comment-missing" on save.
 */
export function removeOperation(ops: Operation[], index: number): Operation[] {
  const target = ops[index];
  if (!target) return ops;
  if (target.kind !== "addComment") return ops.filter((_, i) => i !== index);
  const id = target.comment.id;
  return ops.filter((op, i) => i !== index && operationCommentId(op) !== id);
}

/** Short human-readable description used in the unsaved list and conflict report. */
export function describeOperation(op: Operation): string {
  switch (op.kind) {
    case "addComment":
      return `朱を追加: 「${op.comment.anchor}」`;
    case "addReply":
      return `返信: ${op.reply.text}`;
    case "setState":
      return op.to === "resolved" ? "解決にする" : "再オープンする";
    case "reanchor":
      return `対象を再指定: 「${op.next.anchor}」`;
  }
}
