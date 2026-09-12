/**
 * Operation queue application (DESIGN.md section 7.3).
 *
 * Operations are applied one by one to an evolving source. A batch with any
 * conflicting operation is reported as not ok; the caller must not commit it.
 */
import { markersById, parseDocument, removeMarkerRange } from "./document.js";
import { blockFingerprint, threadFingerprint } from "./fingerprint.js";
import { serializeComment } from "./marker.js";
import { stripBlockers } from "./strip.js";
import { computePlacement, findAnchor, insertMarker, prepareSelection, type AnchorMatch } from "./placement.js";
import { blockAt, buildTextMap, type LeafBlock, type TextMap } from "./textmap.js";
import {
  SCHEMA_VERSION,
  type AddCommentOp,
  type AddReplyOp,
  type ApplyOutcome,
  type ApplyResult,
  type BlockRef,
  type Comment,
  type CommentState,
  type MarkerOccurrence,
  type Operation,
  type ParsedDocument,
  type Reply,
  type ReanchorOp,
  type SetStateOp,
  type SourceRange,
} from "./types.js";

function sameComment(a: Comment, b: Comment): boolean {
  return serializeComment(a) === serializeComment(b);
}

function sameReply(a: Reply, b: Reply): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Leaf block a marker belongs to: the containing block for inline markers, the next block for block-level ones. */
export function markerBlock(tm: TextMap, occ: MarkerOccurrence): LeafBlock | undefined {
  if (!occ.blockLevel) {
    return blockAt(tm, occ.start) ?? blockAt(tm, occ.end, true);
  }
  for (const b of tm.blocks) {
    if (b.range.start >= occ.end) return b;
  }
  return undefined;
}

function flowFingerprint(source: string, doc: ParsedDocument, range: SourceRange): string {
  return blockFingerprint(source, range, doc.markers);
}

function replaceRange(source: string, range: SourceRange, text: string): string {
  return source.slice(0, range.start) + text + source.slice(range.end);
}

interface Step {
  source: string;
  outcome: ApplyOutcome;
}

function conflict(source: string, reason: string): Step {
  return { source, outcome: { status: "conflict", reason } };
}

function locateAnchor(tm: TextMap, prefix: string, anchor: string, suffix: string, blockFp: string | undefined, source: string, doc: ParsedDocument): AnchorMatch | string {
  const matches = findAnchor(tm, prefix, anchor, suffix);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return "anchor-not-found";
  if (blockFp) {
    const inBlock = matches.filter((m) => flowFingerprint(source, doc, m.block.flowRange) === blockFp);
    if (inBlock.length === 1) return inBlock[0]!;
  }
  return "ambiguous-anchor";
}

function applyAddComment(source: string, doc: ParsedDocument, op: AddCommentOp): Step {
  const existing = markersById(doc).get(op.comment.id);
  if (existing) {
    return sameComment(existing.comment, op.comment)
      ? { source, outcome: { status: "already-applied" } }
      : conflict(source, "id-conflict");
  }
  const tm = buildTextMap(source);
  const c = op.comment;
  const located = locateAnchor(tm, c.prefix, c.anchor, c.suffix, op.block.fingerprint, source, doc);
  if (typeof located === "string") return conflict(source, located);
  const placement = computePlacement(tm, located.block, located.sourceOffset);
  return { source: insertMarker(source, placement, serializeComment(c)), outcome: { status: "applied" } };
}

function applyAddReply(source: string, doc: ParsedDocument, op: AddReplyOp): Step {
  const occ = markersById(doc).get(op.commentId);
  if (!occ) return conflict(source, "comment-missing");
  const existing = occ.comment.replies.find((r) => r.id === op.reply.id);
  if (existing) {
    return sameReply(existing, op.reply)
      ? { source, outcome: { status: "already-applied" } }
      : conflict(source, "reply-id-conflict");
  }
  const updated: Comment = { ...occ.comment, replies: [...occ.comment.replies, op.reply] };
  return {
    source: replaceRange(source, { start: occ.start, end: occ.end }, serializeComment(updated)),
    outcome: { status: "applied" },
  };
}

function applySetState(source: string, doc: ParsedDocument, op: SetStateOp): Step {
  const occ = markersById(doc).get(op.commentId);
  if (!occ) return conflict(source, "comment-missing");
  if (occ.comment.state === op.to) return conflict(source, "already-in-target-state");
  if (occ.comment.state !== op.from) return conflict(source, "state-changed");
  if (threadFingerprint(occ.comment) !== op.threadFingerprint) return conflict(source, "thread-changed");
  const tm = buildTextMap(source);
  const block = markerBlock(tm, occ);
  if (!block) return conflict(source, "block-missing");
  if (flowFingerprint(source, doc, block.flowRange) !== op.blockFingerprint) return conflict(source, "body-changed");
  const updated: Comment = { ...occ.comment, state: op.to };
  return {
    source: replaceRange(source, { start: occ.start, end: occ.end }, serializeComment(updated)),
    outcome: { status: "applied" },
  };
}

function applyReanchor(source: string, doc: ParsedDocument, op: ReanchorOp): Step {
  const occ = markersById(doc).get(op.commentId);
  if (!occ) return conflict(source, "comment-missing");
  const c = occ.comment;
  if (c.anchor === op.next.anchor && c.prefix === op.next.prefix && c.suffix === op.next.suffix) {
    return { source, outcome: { status: "already-applied" } };
  }
  if (c.anchor !== op.previous.anchor || c.prefix !== op.previous.prefix || c.suffix !== op.previous.suffix) {
    return conflict(source, "anchor-changed");
  }
  const removed = replaceRange(source, removeMarkerRange(source, occ), "");
  const doc2 = parseDocument(removed);
  const tm = buildTextMap(removed);
  const located = locateAnchor(tm, op.next.prefix, op.next.anchor, op.next.suffix, op.block.fingerprint, removed, doc2);
  if (typeof located === "string") return conflict(source, located);
  const placement = computePlacement(tm, located.block, located.sourceOffset);
  const updated: Comment = { ...c, anchor: op.next.anchor, prefix: op.next.prefix, suffix: op.next.suffix };
  return { source: insertMarker(removed, placement, serializeComment(updated)), outcome: { status: "applied" } };
}

/** Apply operations in order. `ok` is false when any operation conflicts; the returned source is then only a preview. */
export function applyOperations(baseSource: string, ops: Operation[]): ApplyResult {
  let source = baseSource;
  const outcomes: ApplyResult["outcomes"] = [];
  let ok = true;
  for (const op of ops) {
    const doc = parseDocument(source);
    let step: Step;
    if (doc.errors.length > 0) {
      step = conflict(source, "document-readonly");
    } else {
      switch (op.kind) {
        case "addComment":
          step = applyAddComment(source, doc, op);
          break;
        case "addReply":
          step = applyAddReply(source, doc, op);
          break;
        case "setState":
          step = applySetState(source, doc, op);
          break;
        case "reanchor":
          step = applyReanchor(source, doc, op);
          break;
      }
    }
    source = step.source;
    outcomes.push({ op, outcome: step.outcome });
    if (step.outcome.status === "conflict") ok = false;
  }
  return { source, outcomes, ok };
}

// ---------------------------------------------------------------------------
// Operation constructors (used by the UI on the virtual state)
// ---------------------------------------------------------------------------

export interface NewCommentFields {
  id: string;
  text: string;
  author: string;
  timestamp: string;
}

export type CreateAddCommentResult =
  | { ok: true; op: AddCommentOp; placement: "inline" | "block"; flowType: string }
  | { ok: false; reason: string };

/** Build an addComment operation from a selection on `source` (the current virtual state). */
export function createAddCommentOp(source: string, sel: SourceRange, fields: NewCommentFields): CreateAddCommentResult {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return { ok: false, reason: "document-readonly" };
  const tm = buildTextMap(source);
  const prep = prepareSelection(tm, sel);
  if (!prep.ok) return { ok: false, reason: prep.reason };
  const flowRange = prep.placement.flowRange;
  const block: BlockRef = {
    type: prep.placement.flowType,
    range: flowRange,
    fingerprint: flowFingerprint(source, doc, flowRange),
  };
  const comment: Comment = {
    schemaVersion: SCHEMA_VERSION,
    id: fields.id,
    anchor: prep.anchor,
    prefix: prep.prefix,
    suffix: prep.suffix,
    text: fields.text,
    author: fields.author,
    timestamp: fields.timestamp,
    state: "open",
    replies: [],
  };
  return {
    ok: true,
    op: { kind: "addComment", comment, sourceOffset: prep.sourceOffset, block, blockOnly: prep.blockOnly },
    placement: prep.placement.placement,
    flowType: prep.placement.flowType,
  };
}

export function createAddReplyOp(commentId: string, reply: Reply): AddReplyOp {
  return { kind: "addReply", commentId, reply };
}

/** Build a setState operation, recording the fingerprints the user saw on `source`. */
export function createSetStateOp(source: string, commentId: string, to: CommentState): SetStateOp | { ok: false; reason: string } {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return { ok: false, reason: "document-readonly" };
  const occ = markersById(doc).get(commentId);
  if (!occ) return { ok: false, reason: "comment-missing" };
  if (occ.comment.state === to) return { ok: false, reason: "already-in-target-state" };
  const tm = buildTextMap(source);
  const block = markerBlock(tm, occ);
  if (!block) return { ok: false, reason: "block-missing" };
  return {
    kind: "setState",
    commentId,
    from: occ.comment.state,
    to,
    threadFingerprint: threadFingerprint(occ.comment),
    blockFingerprint: flowFingerprint(source, doc, block.flowRange),
  };
}

/** Build a reanchor operation from a new selection on `source`. */
export function createReanchorOp(source: string, commentId: string, sel: SourceRange): ReanchorOp | { ok: false; reason: string } {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return { ok: false, reason: "document-readonly" };
  const occ = markersById(doc).get(commentId);
  if (!occ) return { ok: false, reason: "comment-missing" };
  const tm = buildTextMap(source);
  const prep = prepareSelection(tm, sel);
  if (!prep.ok) return { ok: false, reason: prep.reason };
  const c = occ.comment;
  return {
    kind: "reanchor",
    commentId,
    previous: { anchor: c.anchor, prefix: c.prefix, suffix: c.suffix },
    next: { anchor: prep.anchor, prefix: prep.prefix, suffix: prep.suffix },
    sourceOffset: prep.sourceOffset,
    block: {
      type: prep.placement.flowType,
      range: prep.placement.flowRange,
      fingerprint: flowFingerprint(source, doc, prep.placement.flowRange),
    },
  };
}

/**
 * Strip preconditions on a source (DESIGN 5.4 step 1): format errors, unresolved
 * comments, and markers whose target could not be confirmed (対象未確認).
 */
export function stripBlockersForSource(source: string): string[] {
  const doc = parseDocument(source);
  const blockers = stripBlockers(doc);
  for (const s of markerStatuses(source)) {
    if (s.status !== "ok") {
      blockers.push(`対象未確認: コメント ${s.occurrence.comment.id} (${s.status === "moved" ? "位置が移動" : "対象変更あり"})`);
    }
  }
  return blockers;
}

/** Status of each marker relative to the current body: whether its anchor is still found where it sits. */
export interface MarkerStatus {
  occurrence: MarkerOccurrence;
  /** "ok": anchor+context found right at the marker; "moved": found elsewhere (unique); "changed": not found or ambiguous. */
  status: "ok" | "moved" | "changed";
  block: LeafBlock | undefined;
}

export function markerStatuses(source: string): MarkerStatus[] {
  const doc = parseDocument(source);
  const tm = buildTextMap(source);
  return doc.markers.map((occ) => {
    const block = markerBlock(tm, occ);
    const c = occ.comment;
    const matches = findAnchor(tm, c.prefix, c.anchor, c.suffix);
    let status: MarkerStatus["status"] = "changed";
    if (matches.length === 1) {
      const m = matches[0]!;
      status = block && m.block === block ? "ok" : "moved";
    } else if (matches.length > 1 && block) {
      status = matches.some((m) => m.block === block) ? "ok" : "changed";
    }
    return { occurrence: occ, status, block };
  });
}
