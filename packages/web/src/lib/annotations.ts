/**
 * Highlighted comment anchors (DESIGN.md 6 「既存の朱は縦線と番号で表示」).
 *
 * A marker only says where the comment sits; the text it is about is found
 * the same way the core re-anchors it: prefix + anchor + suffix in the display
 * text of a leaf block. The match in the marker's own block wins; a unique
 * match elsewhere (the comment "moved") is still shown; anything ambiguous
 * or missing gets no highlight, only the badge with its 「!」.
 */
import { findAnchor, type MarkerStatus, type TextMap } from "@syuire/core";
import type { Decoration } from "./decorate";

/** leaf block start offset -> decorations in that block's display coordinates */
export function buildAnnotations(tm: TextMap, statuses: MarkerStatus[]): Map<number, Decoration[]> {
  const out = new Map<number, Decoration[]>();
  for (const status of statuses) {
    const c = status.occurrence.comment;
    if (c.anchor.length === 0) continue;
    const matches = findAnchor(tm, c.prefix, c.anchor, c.suffix);
    let match = status.block ? matches.find((m) => m.block === status.block) : undefined;
    if (!match && matches.length === 1) match = matches[0];
    if (!match) continue;
    const state = c.state === "resolved" ? "resolved" : "open";
    const decoration: Decoration = {
      start: match.displayIndex,
      end: match.displayIndex + c.anchor.length,
      className: `anno anno-${state}${status.status === "ok" ? "" : " anno-moved"}`,
      attrs: { "data-comment": c.id },
    };
    const key = match.block.range.start;
    const list = out.get(key);
    if (list) list.push(decoration);
    else out.set(key, [decoration]);
  }
  return out;
}
