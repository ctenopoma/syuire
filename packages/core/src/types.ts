/**
 * Shared types for syuire core. See DESIGN.md sections 5, 7.
 * These are the contract between core, web, and local packages.
 */

// ---------------------------------------------------------------------------
// 5.1 Comment format
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1 as const;
export const MARKER_PREFIX = "<!-- @comment";
export const MARKER_SUFFIX = " -->";

export type CommentState = "open" | "resolved";

export interface Reply {
  id: string;
  author: string;
  timestamp: string;
  text: string;
  /** Unknown fields are preserved verbatim. */
  [extra: string]: unknown;
}

export interface Comment {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  /** Selected display text at creation time. */
  anchor: string;
  /** Up to 32 code points of display text before the anchor. */
  prefix: string;
  /** Up to 32 code points of display text after the anchor. */
  suffix: string;
  text: string;
  author: string;
  /** ISO 8601 with offset. */
  timestamp: string;
  state: CommentState;
  replies: Reply[];
  /** Unknown fields are preserved verbatim. */
  [extra: string]: unknown;
}

export const CONTEXT_MAX_CODE_POINTS = 32;

/** A marker found in a Markdown source. Offsets are UTF-16 code unit offsets into the source. */
export interface MarkerOccurrence {
  comment: Comment;
  /** Offset of `<!--`. */
  start: number;
  /** Offset just after `-->`. */
  end: number;
  /** Raw marker text `source.slice(start, end)`. */
  raw: string;
  /** True when the marker sits alone on its own line (block-level placement). */
  blockLevel: boolean;
}

export type MarkerErrorKind =
  | "broken-marker"
  | "invalid-json"
  | "missing-field"
  | "unknown-schema-version"
  | "duplicate-id";

export interface MarkerError {
  kind: MarkerErrorKind;
  message: string;
  start: number;
  end: number;
  id?: string;
}

export interface ParsedDocument {
  source: string;
  markers: MarkerOccurrence[];
  errors: MarkerError[];
  /** Line ending style detected in the source. Mixed sources report the first one seen. */
  lineEnding: "\n" | "\r\n";
  hasBom: boolean;
}

// ---------------------------------------------------------------------------
// 7.3 Operation queue
// ---------------------------------------------------------------------------

export interface SourceRange {
  start: number;
  end: number;
}

/** Identifies the block a comment belongs to, for re-anchoring and fingerprinting. */
export interface BlockRef {
  /** mdast node type, e.g. "paragraph", "heading", "table", "code". */
  type: string;
  /** Source range of the whole block (container prefixes excluded on the first line). */
  range: SourceRange;
  /** Fingerprint per DESIGN.md 7.3 (marker-stripped, LF-normalised source of the block). */
  fingerprint: string;
}

export interface AddCommentOp {
  kind: "addComment";
  comment: Comment;
  /** Source offset where the marker should be inserted (before placement adjustment). */
  sourceOffset: number;
  /** Block the selection belonged to when the op was created. */
  block: BlockRef;
  /** Whether the selection could only be attached to a whole block. */
  blockOnly: boolean;
}

export interface AddReplyOp {
  kind: "addReply";
  commentId: string;
  reply: Reply;
}

export interface SetStateOp {
  kind: "setState";
  commentId: string;
  from: CommentState;
  to: CommentState;
  /** Fingerprint of the thread (comment text, state, replies) when the user decided. */
  threadFingerprint: string;
  /** Fingerprint of the block containing the marker when the user decided. */
  blockFingerprint: string;
}

export interface ReanchorOp {
  kind: "reanchor";
  commentId: string;
  previous: { anchor: string; prefix: string; suffix: string };
  next: { anchor: string; prefix: string; suffix: string };
  sourceOffset: number;
  block: BlockRef;
}

export type Operation = AddCommentOp | AddReplyOp | SetStateOp | ReanchorOp;

export type OperationId = string;

export function operationId(op: Operation): OperationId {
  switch (op.kind) {
    case "addComment":
      return `addComment:${op.comment.id}`;
    case "addReply":
      return `addReply:${op.reply.id}`;
    case "setState":
      return `setState:${op.commentId}:${op.to}:${op.threadFingerprint}`;
    case "reanchor":
      return `reanchor:${op.commentId}:${op.next.anchor}`;
  }
}

export type ApplyOutcome =
  | { status: "applied" }
  | { status: "already-applied" }
  | { status: "conflict"; reason: string };

export interface ApplyResult {
  source: string;
  outcomes: Array<{ op: Operation; outcome: ApplyOutcome }>;
  /** True when every op was applied or already applied. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// 7 RepositoryAdapter
// ---------------------------------------------------------------------------

export interface Entry {
  path: string;
  kind: "file" | "dir";
  blobId?: string;
  size?: number;
}

export interface Snapshot {
  /** Commit id that was read. */
  revision: string;
  files: Record<string, { text: string; blobId: string } | null>;
}

export interface Change {
  path: string;
  text: string;
}

export type CommitResult =
  | { status: "committed"; commitId: string; localReflection: "complete" | "not-applicable" }
  | {
      status: "committed";
      commitId: string;
      localReflection: "needs-recovery";
      paths: string[];
      reason: string;
    }
  | { status: "unknown"; batchId: string; candidateCommitId?: string };

export interface CommitInput {
  base: Snapshot;
  changes: Change[];
  batchId: string;
  message: string;
}

export type AdapterErrorKind =
  | "conflict"
  | "auth"
  | "permission"
  | "not-found"
  | "too-large"
  | "rate-limit"
  | "validation"
  | "worktree-dirty"
  | "worktree-recovery"
  | "commit-failed"
  | "repo-state"
  | "network"
  | "internal";

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly details: unknown;
  constructor(kind: AdapterErrorKind, message: string, details?: unknown) {
    super(message);
    this.name = "AdapterError";
    this.kind = kind;
    this.details = details;
  }
}

export interface RepositoryAdapter {
  list(dir: string, revision: string): Promise<Entry[]>;
  read(paths: string[], revision?: string): Promise<Snapshot>;
  commit(input: CommitInput): Promise<CommitResult>;
  /** Resolve the current tip of the session branch. */
  head(): Promise<string>;
  /**
   * Read one path at `revision` as raw bytes (DESIGN.md 6: repository images
   * are fetched from the revision being read). Returns null when the path does
   * not exist at that revision. Optional: adapters that cannot serve bytes
   * simply omit it.
   */
  readBlob?(path: string, revision: string): Promise<{ bytes: Uint8Array; blobId: string } | null>;
}

// ---------------------------------------------------------------------------
// 4.2 / 7.2 Local-only capabilities
// ---------------------------------------------------------------------------

export type SyncState =
  | "in-sync"
  | "remote-ahead"
  | "local-ahead"
  | "diverged"
  | "no-upstream"
  | "repo-busy"
  | "unknown";

export interface SyncStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  state: SyncState;
  /** ISO timestamp of the last successful fetch in this session, or null. */
  lastFetchedAt: string | null;
  /** Human-readable reason when state is repo-busy or unknown. */
  detail?: string;
}

/** Recovery record kept while a local save is between "prepared" and "reflected". See DESIGN.md 7.2. */
export interface LocalRecoveryInfo {
  batchId: string;
  phase: "prepared-uncommitted" | "result-unknown" | "committed-needs-recovery";
  baseCommitId: string;
  newCommitId?: string;
  paths: string[];
  /** Per path: blob ids before and after preparation. */
  blobs: Record<string, { before: string | null; after: string }>;
  reason?: string;
}

export interface LocalRepositoryAdapter extends RepositoryAdapter {
  fetch(): Promise<SyncStatus>;
  /** fast-forward only */
  pull(): Promise<SyncStatus>;
  push(): Promise<SyncStatus>;
  sync(): Promise<SyncStatus>;
  /** Find a commit on the session branch carrying the batch trailer. */
  findBatchCommit(batchId: string): Promise<string | null>;
  recovery(): Promise<LocalRecoveryInfo | null>;
}

/** Trailer key recorded in commit messages. */
export const BATCH_TRAILER = "syuire-Batch";

export function formatCommitMessage(summary: string, batchId: string): string {
  return `${summary}\n\n${BATCH_TRAILER}: ${batchId}\n`;
}

export function extractBatchId(message: string): string | undefined {
  const m = /^syuire-Batch:\s*([0-9a-fA-F-]{36})\s*$/m.exec(message);
  return m?.[1];
}
