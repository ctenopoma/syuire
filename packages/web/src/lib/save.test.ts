import { describe, expect, it } from "vitest";
import {
  AdapterError,
  createAddCommentOp,
  extractBatchId,
  type CommitInput,
  type CommitResult,
  type Entry,
  type Operation,
  type Snapshot,
} from "@akaire/core";
import { confirmBatch, runSave, type BatchAwareAdapter } from "./save";

const PATH = "docs/foo.md";
const SOURCE = "abc def\n";

function makeOp(): Operation {
  const result = createAddCommentOp(
    SOURCE,
    { start: 4, end: 7 },
    {
      id: "11111111-2222-3333-4444-555555555555",
      text: "ここを直す",
      author: "naoki",
      timestamp: "2026-09-07T09:12:00+09:00",
    },
  );
  if (!result.ok) throw new Error(`fixture failed: ${result.reason}`);
  return result.op;
}

type Programmed = CommitResult | Error;

class FakeAdapter implements BatchAwareAdapter {
  headRevision: string;
  readonly texts = new Map<string, string>();
  readonly commitCalls: CommitInput[] = [];
  readonly programmed: Programmed[] = [];
  readonly batchCommits = new Map<string, string>();
  headCalls = 0;
  readCalls: Array<{ paths: string[]; revision: string | undefined }> = [];

  constructor(headRevision: string, text: string) {
    this.headRevision = headRevision;
    this.texts.set(headRevision, text);
  }

  async head(): Promise<string> {
    this.headCalls++;
    return this.headRevision;
  }

  async list(): Promise<Entry[]> {
    return [];
  }

  async read(paths: string[], revision?: string): Promise<Snapshot> {
    this.readCalls.push({ paths, revision });
    const rev = revision ?? this.headRevision;
    const text = this.texts.get(rev);
    if (text === undefined) throw new AdapterError("not-found", `no such revision ${rev}`);
    const files: Snapshot["files"] = {};
    for (const p of paths) files[p] = { text, blobId: `blob-${rev}` };
    return { revision: rev, files };
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    this.commitCalls.push(input);
    const next = this.programmed.shift();
    if (next === undefined) throw new Error("no programmed commit result");
    if (next instanceof Error) throw next;
    return next;
  }

  async findBatchCommit(batchId: string): Promise<string | null> {
    return this.batchCommits.get(batchId) ?? null;
  }
}

async function baseAt(adapter: FakeAdapter, revision: string): Promise<Snapshot> {
  return adapter.read([PATH], revision);
}

describe("runSave", () => {
  it("does nothing with an empty queue", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const result = await runSave({
      adapter,
      path: PATH,
      base: await baseAt(adapter, "r1"),
      ops: [],
      batchId: "b1",
    });
    expect(result.status).toBe("nothing");
    expect(adapter.commitCalls).toHaveLength(0);
  });

  it("commits the batch and adopts the new revision", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const base = await baseAt(adapter, "r1");
    adapter.texts.set("r2", SOURCE);
    adapter.programmed.push({
      status: "committed",
      commitId: "r2",
      localReflection: "not-applicable",
    });

    const op = makeOp();
    const batchId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const result = await runSave({ adapter, path: PATH, base, ops: [op], batchId });

    expect(adapter.commitCalls).toHaveLength(1);
    const call = adapter.commitCalls[0];
    expect(call?.changes[0]?.path).toBe(PATH);
    expect(call?.changes[0]?.text).toContain("@comment");
    expect(call?.message).toContain("akaire: 朱 1 件");
    expect(extractBatchId(call?.message ?? "")).toBe(batchId);

    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.commitId).toBe("r2");
      // The new base was re-read at the commit that was just created.
      expect(result.base.revision).toBe("r2");
    }
  });

  it("re-reads when the branch tip moved before committing", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const base = await baseAt(adapter, "r1");
    adapter.headRevision = "r5";
    adapter.texts.set("r5", `${SOURCE}追記\n`);
    adapter.texts.set("r6", SOURCE);
    adapter.programmed.push({
      status: "committed",
      commitId: "r6",
      localReflection: "not-applicable",
    });

    const result = await runSave({ adapter, path: PATH, base, ops: [makeOp()], batchId: "b1" });

    expect(adapter.commitCalls[0]?.base.revision).toBe("r5");
    expect(result.status).toBe("committed");
  });

  it("holds the whole batch when an operation conflicts", async () => {
    const adapter = new FakeAdapter("r1", "まったく別の本文\n");
    const base = await baseAt(adapter, "r1");
    const result = await runSave({ adapter, path: PATH, base, ops: [makeOp()], batchId: "b1" });

    expect(adapter.commitCalls).toHaveLength(0);
    expect(result.status).toBe("conflicts");
    if (result.status === "conflicts") {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.reason).toBe("anchor-not-found");
    }
  });

  it("reports an unknown result and keeps the batch id", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const base = await baseAt(adapter, "r1");
    adapter.programmed.push({ status: "unknown", batchId: "b1", candidateCommitId: "c9" });

    const result = await runSave({ adapter, path: PATH, base, ops: [makeOp()], batchId: "b1" });
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.batchId).toBe("b1");
      expect(result.candidateCommitId).toBe("c9");
    }
  });

  it("surfaces needs-recovery and advances the base to the confirmed commit", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const base = await baseAt(adapter, "r1");
    adapter.texts.set("r2", `${SOURCE}committed\n`);
    adapter.programmed.push({
      status: "committed",
      commitId: "r2",
      localReflection: "needs-recovery",
      paths: [PATH],
      reason: "作業ツリーが一致しません",
    });

    const result = await runSave({ adapter, path: PATH, base, ops: [makeOp()], batchId: "b1" });
    expect(result.status).toBe("needs-recovery");
    if (result.status !== "needs-recovery") return;
    expect(result.paths).toEqual([PATH]);
    // The commit IS confirmed, so the base moves to it and the body is re-read.
    expect(result.commitId).toBe("r2");
    expect(result.base.revision).toBe("r2");
    expect(result.base.files[PATH]?.text).toContain("committed");
    expect(result.rereadError).toBeUndefined();
    expect(adapter.readCalls.at(-1)).toEqual({ paths: [PATH], revision: "r2" });
  });

  it("adopts the new revision even when the post-commit re-read fails", async () => {
    for (const localReflection of ["not-applicable", "needs-recovery"] as const) {
      const adapter = new FakeAdapter("r1", SOURCE);
      const base = await baseAt(adapter, "r1");
      // "r2" is never registered, so read() at r2 throws.
      adapter.programmed.push(
        localReflection === "not-applicable"
          ? { status: "committed", commitId: "r2", localReflection }
          : {
              status: "committed",
              commitId: "r2",
              localReflection,
              paths: [PATH],
              reason: "作業ツリーが一致しません",
            },
      );

      const result = await runSave({ adapter, path: PATH, base, ops: [makeOp()], batchId: "b1" });
      if (result.status !== "committed" && result.status !== "needs-recovery") {
        throw new Error(`unexpected status ${result.status}`);
      }
      // DESIGN.md 4.1: the commit id is the proof, so the base must not stay on
      // the old revision under a "saved" message - it advances and the body is
      // flagged stale instead.
      expect(result.base.revision).toBe("r2");
      expect(result.rereadError).toBeTruthy();
      expect(result.base.files[PATH]?.text).toBe(SOURCE);
    }
  });

  it("retries a conflict at most twice and then stops", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const base = await baseAt(adapter, "r1");
    for (let i = 0; i < 5; i++) {
      adapter.programmed.push(new AdapterError("conflict", "branch moved"));
    }

    const result = await runSave({ adapter, path: PATH, base, ops: [makeOp()], batchId: "b1" });

    expect(adapter.commitCalls).toHaveLength(3);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.kind).toBe("conflict");
      expect(result.message).toContain("更新が続いています");
    }
  });

  it("succeeds when a retried conflict clears", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const base = await baseAt(adapter, "r1");
    adapter.programmed.push(new AdapterError("conflict", "branch moved"));
    adapter.texts.set("r2", SOURCE);
    adapter.programmed.push({
      status: "committed",
      commitId: "r2",
      localReflection: "not-applicable",
    });

    const result = await runSave({ adapter, path: PATH, base, ops: [makeOp()], batchId: "b1" });
    expect(adapter.commitCalls).toHaveLength(2);
    expect(result.status).toBe("committed");
  });

  it("keeps the queue on an auth error", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const base = await baseAt(adapter, "r1");
    adapter.programmed.push(new AdapterError("auth", "token expired"));
    const ops = [makeOp()];

    const result = await runSave({ adapter, path: PATH, base, ops, batchId: "b1" });

    expect(adapter.commitCalls).toHaveLength(1);
    expect(ops).toHaveLength(1);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.kind).toBe("auth");
    }
  });

  it("reports a missing file", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const base: Snapshot = { revision: "r1", files: {} };
    const result = await runSave({ adapter, path: PATH, base, ops: [makeOp()], batchId: "b1" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.kind).toBe("not-found");
  });
});

describe("confirmBatch", () => {
  it("adopts the commit when the batch trailer is found", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    adapter.texts.set("r2", SOURCE);
    adapter.batchCommits.set("b1", "r2");

    const result = await confirmBatch(adapter, PATH, "b1");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.commitId).toBe("r2");
      expect(result.base.revision).toBe("r2");
    }
  });

  it("reports not-found so the same batch id can be retried", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    const result = await confirmBatch(adapter, PATH, "b1");
    expect(result.status).toBe("not-found");
  });

  it("reports adapter errors", async () => {
    const adapter = new FakeAdapter("r1", SOURCE);
    adapter.findBatchCommit = async (): Promise<string | null> => {
      throw new AdapterError("network", "offline");
    };
    const result = await confirmBatch(adapter, PATH, "b1");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.kind).toBe("network");
  });
});
