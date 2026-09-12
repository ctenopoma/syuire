/**
 * "刷り出し" (strip / print): removing markers for a public copy while
 * preserving history in a review log. See DESIGN.md 5.4.
 */
import type { Comment, MarkerOccurrence, ParsedDocument } from "./types.js";
import { removeMarkerRange } from "./document.js";

/** Returns the list of reasons stripping is currently blocked, empty when OK. */
export function stripBlockers(doc: ParsedDocument): string[] {
  const reasons: string[] = [];

  if (doc.errors.length > 0) {
    reasons.push(`document has ${doc.errors.length} marker error(s)`);
  }

  for (const occ of doc.markers) {
    if (occ.comment.state !== "resolved") {
      reasons.push(`comment ${occ.comment.id} is not resolved (state: ${occ.comment.state})`);
    }
  }

  return reasons;
}

/**
 * Removes every marker from the document source. Nothing else is
 * reformatted: line endings, BOM, and surrounding whitespace are preserved.
 */
export function stripMarkers(doc: ParsedDocument): string {
  const entries = doc.markers.map((occ) => ({ occ, range: removeMarkerRange(doc.source, occ) }));
  entries.sort((a, b) => b.range.start - a.range.start);

  let result = doc.source;
  for (const { range } of entries) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatUtcTimestamp(at: Date): string {
  const y = at.getUTCFullYear();
  const mo = pad2(at.getUTCMonth() + 1);
  const d = pad2(at.getUTCDate());
  const h = pad2(at.getUTCHours());
  const mi = pad2(at.getUTCMinutes());
  const s = pad2(at.getUTCSeconds());
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

/**
 * Computes the review log path for a stripped document. See DESIGN.md 5.4:
 * `reviews/<originalPath without trailing .md>/<UTC yyyyMMddTHHmmssZ>-<batchId>.md`.
 */
export function reviewLogPath(originalPath: string, at: Date, batchId: string): string {
  let p = originalPath.replace(/\\/g, "/");
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  const withoutExt = p.endsWith(".md") ? p.slice(0, -3) : p;
  const ts = formatUtcTimestamp(at);
  return `reviews/${withoutExt}/${ts}-${batchId}.md`;
}

export interface RenderReviewLogInput {
  originalPath: string;
  baseCommitId: string;
  batchId: string;
  strippedAt: Date;
  markers: MarkerOccurrence[];
}

function renderReplyLine(reply: Comment["replies"][number]): string {
  return `     - ${reply.author} (${reply.timestamp}): ${reply.text}`;
}

function renderCommentEntry(occ: MarkerOccurrence, index: number): string[] {
  const c = occ.comment;
  const lines: string[] = [];
  lines.push(`${index + 1}. \`${c.anchor}\``);
  lines.push(`   - text: ${c.text}`);
  lines.push(`   - author: ${c.author}`);
  lines.push(`   - timestamp: ${c.timestamp}`);
  lines.push(`   - state: ${c.state}`);
  if (c.replies.length > 0) {
    lines.push(`   - replies:`);
    for (const reply of c.replies) {
      lines.push(renderReplyLine(reply));
    }
  }
  return lines;
}

/** Renders the Markdown review log for a batch of stripped markers. */
export function renderReviewLog(input: RenderReviewLogInput): string {
  const lines: string[] = [];

  lines.push(`# 刷り出しログ: ${input.originalPath}`);
  lines.push("");
  lines.push(`- 元パス: ${input.originalPath}`);
  lines.push(`- 変更前コミット: ${input.baseCommitId}`);
  lines.push(`- batchId: ${input.batchId}`);
  lines.push(`- 刷り出し日時: ${input.strippedAt.toISOString()}`);
  lines.push("");

  lines.push("## コメント一覧");
  lines.push("");
  input.markers.forEach((occ, index) => {
    lines.push(...renderCommentEntry(occ, index));
  });
  lines.push("");

  lines.push("## マーカー JSON");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(input.markers.map((m) => m.comment), null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}
