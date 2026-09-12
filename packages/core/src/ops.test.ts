import { describe, expect, it } from "vitest";
import { parseDocument } from "./document.js";
import { stripMarkers } from "./strip.js";
import {
  applyOperations,
  createAddCommentOp,
  createAddReplyOp,
  createReanchorOp,
  createSetStateOp,
  markerStatuses,
  stripBlockersForSource,
} from "./ops.js";
import type { AddCommentOp, Operation, SetStateOp } from "./types.js";

const BASE = "# 見出し\n\n本文の この表現を見直す。\n\n- 項目一\n- 項目二の文\n";
const F = { author: "naoki", timestamp: "2026-09-07T09:12:00+09:00" };

function add(source: string, needle: string, id: string, text = "コメント"): AddCommentOp {
  const s = source.indexOf(needle);
  const r = createAddCommentOp(source, { start: s, end: s + needle.length }, { id, text, ...F });
  if (!r.ok) throw new Error(r.reason);
  return r.op;
}

describe("applyOperations", () => {
  it("adds a comment inline and is idempotent", () => {
    const op = add(BASE, "この表現", "c1");
    const r1 = applyOperations(BASE, [op]);
    expect(r1.ok).toBe(true);
    expect(r1.outcomes[0]!.outcome).toEqual({ status: "applied" });
    expect(r1.source).toContain('本文の <!-- @comment{"schemaVersion":1,"id":"c1","anchor":"この表現"');
    expect(stripMarkers(parseDocument(r1.source))).toBe(BASE);
    const r2 = applyOperations(r1.source, [op]);
    expect(r2.ok).toBe(true);
    expect(r2.outcomes[0]!.outcome).toEqual({ status: "already-applied" });
    expect(r2.source).toBe(r1.source);
  });

  it("conflicts when the same id exists with different content", () => {
    const op = add(BASE, "この表現", "c1");
    const applied = applyOperations(BASE, [op]).source;
    const other = { ...op, comment: { ...op.comment, text: "別の本文" } };
    const r = applyOperations(applied, [other]);
    expect(r.ok).toBe(false);
    expect(r.outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "id-conflict" });
  });

  it("re-applies onto a changed base when the anchor is unique", () => {
    const op = add(BASE, "この表現", "c1");
    const newBase = "前書きが増えた。\n\n" + BASE;
    const r = applyOperations(newBase, [op]);
    expect(r.ok).toBe(true);
    expect(r.source).toContain("本文の <!-- @comment");
  });

  it("stops when the anchor is gone or ambiguous", () => {
    const op = add(BASE, "この表現", "c1");
    const gone = applyOperations(BASE.replace("この表現", "その表現"), [op]);
    expect(gone.outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "anchor-not-found" });
    const dup = applyOperations(BASE + "\n本文の この表現を見直す。\n", [op]);
    expect(dup.outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "ambiguous-anchor" });
    expect(dup.ok).toBe(false);
  });

  it("uses the block fingerprint to disambiguate identical text in different blocks", () => {
    const src = "共通 文言 です。\n\n共通 文言 です。追加。";
    const s = src.lastIndexOf("文言");
    const r = createAddCommentOp(src, { start: s, end: s + 2 }, { id: "c1", text: "t", ...F });
    if (!r.ok) throw new Error(r.reason);
    const out = applyOperations(src, [r.op]);
    expect(out.ok).toBe(true);
    expect(out.source).toBe(`共通 文言 です。\n\n共通 <!-- @comment{"schemaVersion":1,"id":"c1","anchor":"文言","prefix":"共通 ","suffix":" です。追加。","text":"t","author":"naoki","timestamp":"2026-09-07T09:12:00+09:00","state":"open","replies":[]} -->文言 です。追加。`);
  });

  it("adds replies by id and detects reply conflicts", () => {
    const withComment = applyOperations(BASE, [add(BASE, "この表現", "c1")]).source;
    const reply = createAddReplyOp("c1", { id: "r1", author: "ai", timestamp: "2026-09-07T10:00:00+09:00", text: "対応しました" });
    const r = applyOperations(withComment, [reply]);
    expect(r.ok).toBe(true);
    expect(parseDocument(r.source).markers[0]!.comment.replies).toHaveLength(1);
    expect(applyOperations(r.source, [reply]).outcomes[0]!.outcome).toEqual({ status: "already-applied" });
    const changed = createAddReplyOp("c1", { ...reply.reply, text: "違う" });
    expect(applyOperations(r.source, [changed]).outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "reply-id-conflict" });
    expect(applyOperations(BASE, [reply]).outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "comment-missing" });
  });

  it("changes state only when thread and body are unchanged", () => {
    const withComment = applyOperations(BASE, [add(BASE, "この表現", "c1")]).source;
    const op = createSetStateOp(withComment, "c1", "resolved") as SetStateOp;
    expect(op.kind).toBe("setState");
    const ok = applyOperations(withComment, [op]);
    expect(ok.ok).toBe(true);
    expect(parseDocument(ok.source).markers[0]!.comment.state).toBe("resolved");
    // body changed after the decision (DESIGN 7.3: 納期 example)
    const bodyChanged = withComment.replace("表現を見直す。", "表現を見直す。期限は30日。");
    expect(applyOperations(bodyChanged, [op]).outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "body-changed" });
    // a reply arrived after the decision
    const reply = createAddReplyOp("c1", { id: "r1", author: "ai", timestamp: "t", text: "x" });
    const replied = applyOperations(withComment, [reply]).source;
    expect(applyOperations(replied, [op]).outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "thread-changed" });
    // external system already resolved it
    expect(applyOperations(ok.source, [op]).outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "already-in-target-state" });
    // unrelated block edited: still fine
    const otherBlock = withComment.replace("項目一", "項目壱");
    expect(applyOperations(otherBlock, [op]).ok).toBe(true);
  });

  it("evaluates a batch on the virtual state so own replies do not self-conflict", () => {
    const withComment = applyOperations(BASE, [add(BASE, "この表現", "c1")]).source;
    const reply = createAddReplyOp("c1", { id: "r1", author: "naoki", timestamp: "t", text: "済み" });
    const virtual = applyOperations(withComment, [reply]).source;
    const setState = createSetStateOp(virtual, "c1", "resolved") as SetStateOp;
    const batch: Operation[] = [reply, setState];
    const r = applyOperations(withComment, batch);
    expect(r.ok).toBe(true);
    expect(r.outcomes.map((o) => o.outcome.status)).toEqual(["applied", "applied"]);
  });

  it("holds the whole batch when one op conflicts", () => {
    const op1 = add(BASE, "見出し", "c1");
    const op3 = add(BASE, "項目一", "c3");
    const bad = { ...op1, comment: { ...op1.comment, id: "c2", anchor: "存在しない" } };
    const r = applyOperations(BASE, [op1, bad, op3]);
    expect(r.ok).toBe(false);
    expect(r.outcomes.map((o) => o.outcome.status)).toEqual(["applied", "conflict", "applied"]);
  });

  it("refuses to touch a document with marker errors", () => {
    const broken = BASE + '\n<!-- @comment{"schemaVersion":9,"id":"z"} -->\n';
    const r = applyOperations(broken, [add(BASE, "この表現", "c1")]);
    expect(r.outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "document-readonly" });
  });

  it("re-anchors a comment to a new selection, removing the old marker", () => {
    const withComment = applyOperations(BASE, [add(BASE, "この表現", "c1")]).source;
    const s = withComment.indexOf("項目二の文");
    const op = createReanchorOp(withComment, "c1", { start: s, end: s + 3 });
    if (!("kind" in op)) throw new Error(op.reason);
    const r = applyOperations(withComment, [op]);
    expect(r.ok).toBe(true);
    const doc = parseDocument(r.source);
    expect(doc.markers).toHaveLength(1);
    expect(doc.markers[0]!.comment.anchor).toBe("項目二");
    expect(doc.markers[0]!.blockLevel).toBe(true);
    expect(stripMarkers(doc)).toBe(BASE);
    expect(applyOperations(r.source, [op]).outcomes[0]!.outcome).toEqual({ status: "already-applied" });
  });

  it("block-level markers keep list structure and strip back to the original", () => {
    const op = add(BASE, "項目二", "c1");
    const r = applyOperations(BASE, [op]);
    expect(r.source).toContain("- <!-- @comment");
    expect(r.source).toContain("-->\n  項目二の文");
    expect(stripMarkers(parseDocument(r.source))).toBe(BASE);
  });
});

describe("stripBlockersForSource", () => {
  it("blocks on open comments and on unconfirmed targets", () => {
    const src = applyOperations(BASE, [add(BASE, "この表現", "c1")]).source;
    expect(stripBlockersForSource(src).some((b) => /resolved|open/.test(b))).toBe(true);
    const resolved = applyOperations(src, [createSetStateOp(src, "c1", "resolved") as SetStateOp]).source;
    expect(stripBlockersForSource(resolved)).toEqual([]);
    const changed = resolved.replace("この表現を", "あの表現を");
    expect(stripBlockersForSource(changed)).toEqual([expect.stringContaining("対象未確認")]);
  });
});

describe("markerStatuses", () => {
  it("reports ok, moved and changed", () => {
    const src = applyOperations(BASE, [add(BASE, "この表現", "c1")]).source;
    expect(markerStatuses(src)[0]!.status).toBe("ok");
    const changed = src.replace("この表現を", "あの表現を");
    expect(markerStatuses(changed)[0]!.status).toBe("changed");
    const moved = src.replace("本文の <!-- @comment", "本文の <!-- @comment").replace("\n\n本文の ", "\n\n段落追加。\n\n本文の ");
    expect(markerStatuses(moved)[0]!.status).toBe("ok");
    // marker line left behind while the paragraph text moved elsewhere
    const marker = /<!-- @comment[^>]*-->/.exec(src)![0];
    const stranded = src.replace(marker, "") .replace("- 項目一", `${marker}\n- 項目一`);
    expect(markerStatuses(stranded)[0]!.status).toBe("moved");
  });
});
