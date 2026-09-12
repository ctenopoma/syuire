/**
 * Integration scenario over the real core + LocalGitAdapter (DESIGN.md section 10 / 11):
 * add a comment → external system replies and edits the body → stale save conflicts →
 * pull → resolve with re-checked fingerprints → strip body + log in one commit.
 */
import { describe, expect, it } from "vitest";
import {
  AdapterError,
  applyOperations,
  createAddCommentOp,
  createAddReplyOp,
  createReanchorOp,
  createSetStateOp,
  formatCommitMessage,
  parseDocument,
  renderReviewLog,
  reviewLogPath,
  stripBlockersForSource,
  stripMarkers,
  type SetStateOp,
} from "@syuire/core";
import { LocalGitAdapter } from "../src/local-git-adapter.js";
import { git, makeFixture, uuid } from "./helpers.js";

const PATH = "docs/foo.md";
const BODY = "# 提案書\n\n本文の この表現を見直す。納期は10日です。\n\n- 項目一\n- 項目二\n";

describe("scenario: review round trip through git", () => {
  it("walks the operating flow with an external editor in between", async () => {
    const fx = await makeFixture({ initialFiles: { [PATH]: BODY } });
    const adapter = await LocalGitAdapter.open(fx.clone);

    // 1. Reviewer adds a comment and saves (one commit).
    let base = await adapter.read([PATH]);
    const text0 = base.files[PATH]!.text;
    const s = text0.indexOf("この表現");
    const add = createAddCommentOp(text0, { start: s, end: s + 4 }, {
      id: uuid(),
      text: "具体例を加えてほしい",
      author: "naoki",
      timestamp: "2026-09-07T09:12:00+09:00",
    });
    if (!add.ok) throw new Error(add.reason);
    const applied = applyOperations(text0, [add.op]);
    expect(applied.ok).toBe(true);
    const batch1 = uuid();
    const r1 = await adapter.commit({
      base,
      changes: [{ path: PATH, text: applied.source }],
      batchId: batch1,
      message: formatCommitMessage("syuire: 朱 1 件", batch1),
    });
    expect(r1.status).toBe("committed");
    await adapter.push();
    const commentId = add.op.comment.id;

    // 2. External system (separate clone) replies and edits the body, then pushes.
    const other = await fx.clone2();
    const theirs = await fx.read(other, PATH);
    const replied = applyOperations(theirs, [
      createAddReplyOp(commentId, { id: uuid(), author: "ai", timestamp: "2026-09-07T10:00:00+09:00", text: "例を追加しました" }),
    ]);
    expect(replied.ok).toBe(true);
    // Edit the body only (the marker JSON also contains the phrase inside its suffix).
    await fx.write(other, PATH, replied.source.replace(/納期は10日です。(\r?\n)/, "納期は30日です。$1"));
    await git(other, ["commit", "-am", "external edit"]);
    await git(other, ["push"]);

    // 3. Reviewer decides "resolved" on the stale view and tries to save: HEAD is stale vs remote,
    //    but the local HEAD is unchanged, so the commit would succeed locally. The design requires
    //    「最新」 first; simulate the user pressing 最新 (fetch + ff pull) before saving.
    const staleSource = applied.source;
    const staleOp = createSetStateOp(staleSource, commentId, "resolved") as SetStateOp;
    expect(staleOp.kind).toBe("setState");
    const sync = await adapter.pull();
    expect(sync.state).toBe("in-sync");
    const head2 = await adapter.head();
    expect(head2).not.toBe(base.revision);

    // 4. Re-apply the queued op on the new base: the thread changed (reply) and the body changed → held.
    base = await adapter.read([PATH]);
    const held = applyOperations(base.files[PATH]!.text, [staleOp]);
    expect(held.ok).toBe(false);
    expect(held.outcomes[0]!.outcome).toEqual({ status: "conflict", reason: "thread-changed" });

    // 5. A commit with the old base revision is refused as a conflict.
    const staleBase = { revision: r1.status === "committed" ? r1.commitId : "", files: { [PATH]: { text: staleSource, blobId: "x" } } };
    const staleBatch = uuid();
    await expect(
      adapter.commit({ base: staleBase, changes: [{ path: PATH, text: staleSource }], batchId: staleBatch, message: formatCommitMessage("x", staleBatch) }),
    ).rejects.toMatchObject({ kind: "conflict" });

    // 6. The external body edit changed the comment's context (suffix), so the marker reports
    //    「対象変更あり」 and strip would be blocked. The reviewer re-specifies the target on the
    //    current body, then resolves; both go into one batch evaluated on the virtual state.
    const fresh = base.files[PATH]!.text;
    expect(fresh).toContain("納期は30日");
    expect(stripBlockersForSource(fresh)).toContainEqual(expect.stringContaining("対象未確認"));
    const s2 = fresh.lastIndexOf("この表現"); // the first occurrence is inside the marker JSON
    const reanchor = createReanchorOp(fresh, commentId, { start: s2, end: s2 + 4 });
    if (!("kind" in reanchor)) throw new Error(reanchor.reason);
    const virtual = applyOperations(fresh, [reanchor]).source;
    const op2 = createSetStateOp(virtual, commentId, "resolved") as SetStateOp;
    const applied2 = applyOperations(fresh, [reanchor, op2]);
    expect(applied2.ok).toBe(true);
    expect(parseDocument(applied2.source).markers[0]!.comment.suffix).toContain("納期は30日");
    const batch2 = uuid();
    const r2 = await adapter.commit({
      base,
      changes: [{ path: PATH, text: applied2.source }],
      batchId: batch2,
      message: formatCommitMessage("syuire: 解決 1 件", batch2),
    });
    expect(r2).toMatchObject({ status: "committed", localReflection: "complete" });
    expect(await adapter.findBatchCommit(batch2)).toBe(r2.status === "committed" ? r2.commitId : null);

    // 7. Strip: no blockers, body + log in one commit, log path never pre-existing.
    base = await adapter.read([PATH]);
    const source = base.files[PATH]!.text;
    expect(stripBlockersForSource(source)).toEqual([]);
    const doc = parseDocument(source);
    const batch3 = uuid();
    const logPath = reviewLogPath(PATH, new Date("2026-09-08T00:00:00Z"), batch3);
    expect(logPath).toMatch(/^reviews\/docs\/foo\/20260908T000000Z-/);
    const r3 = await adapter.commit({
      base,
      changes: [
        { path: PATH, text: stripMarkers(doc) },
        { path: logPath, text: renderReviewLog({ originalPath: PATH, baseCommitId: base.revision, batchId: batch3, strippedAt: new Date(), markers: doc.markers }) },
      ],
      batchId: batch3,
      message: formatCommitMessage("syuire: 刷り出し", batch3),
    });
    expect(r3).toMatchObject({ status: "committed", localReflection: "complete" });
    const stripped = (await adapter.read([PATH])).files[PATH]!.text;
    // The external clone committed CRLF; syuire preserves whatever line endings the file has.
    expect(stripped.replace(/\r\n/g, "\n")).toBe(BODY.replace("納期は10日", "納期は30日"));
    expect(stripped.includes("\r\n")).toBe(source.includes("\r\n"));
    const log = (await adapter.read([logPath])).files[logPath]!.text;
    expect(log).toContain(commentId);
    expect(log).toContain("例を追加しました");
    const files = (await git(fx.clone, ["show", "--name-only", "--format=", "HEAD"])).trim().split(/\r?\n/).sort();
    expect(files).toEqual([PATH, logPath].sort());
    expect((await git(fx.clone, ["status", "--porcelain"])).trim()).toBe("");

    // 8. Repeating the strip against the same log path is refused (既存パスには上書きしない).
    base = await adapter.read([PATH]);
    const dupBatch = uuid();
    await expect(
      adapter.commit({ base, changes: [{ path: logPath, text: "dup" }], batchId: dupBatch, message: formatCommitMessage("x", dupBatch) }),
    ).rejects.toMatchObject({ kind: "validation" });
  }, 60_000);
});
