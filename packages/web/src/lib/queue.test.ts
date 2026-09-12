import { describe, expect, it } from "vitest";
import type { AddCommentOp, Comment, LocalRecoveryInfo, Operation } from "@syuire/core";
import {
  loadPendingBatch,
  loadQueueFrom,
  loadRecoveryMirror,
  makeEnvelope,
  parseQueue,
  pendingBatchStorageKey,
  queueStorageKey,
  recoveryStorageKey,
  removeOperation,
  savePendingBatch,
  saveQueueTo,
  saveRecoveryMirror,
  serializeQueue,
  type PendingBatch,
  type QueueContext,
  type RepoContext,
  type StorageLike,
} from "./queue";

const context: QueueContext = {
  mode: "github",
  repoKey: "acme/docs",
  branch: "feature/x",
  path: "docs/foo.md",
};

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function comment(id: string): Comment {
  return {
    schemaVersion: 1,
    id,
    anchor: "アンカー",
    prefix: "",
    suffix: "",
    text: "コメント",
    author: "naoki",
    timestamp: "2026-09-07T09:12:00+09:00",
    state: "open",
    replies: [],
  };
}

function addComment(id: string): AddCommentOp {
  return {
    kind: "addComment",
    comment: comment(id),
    sourceOffset: 0,
    block: { type: "paragraph", range: { start: 0, end: 10 }, fingerprint: "fp" },
    blockOnly: false,
  };
}

const repoContext: RepoContext = {
  mode: "local",
  repoKey: "C:/work/clone",
  branch: "feature/x",
};

const pendingBatch: PendingBatch = {
  batchId: "b8f4b1f8-1111-4222-8333-444444444444",
  candidateCommitId: "c0ffee1",
  startedAt: "2026-09-07T00:00:00Z",
};

const recoveryInfo: LocalRecoveryInfo = {
  batchId: "b8f4b1f8-1111-4222-8333-444444444444",
  phase: "committed-needs-recovery",
  baseCommitId: "base1234",
  newCommitId: "new5678",
  paths: ["docs/foo.md"],
  blobs: { "docs/foo.md": { before: "blob-before", after: "blob-after" } },
  reason: "the work tree does not match the new commit",
};

describe("storage keys", () => {
  it("is derived from mode, repo, branch and path", () => {
    expect(queueStorageKey(context)).toBe(
      "syuire.queue:github:acme%2Fdocs:feature%2Fx:docs%2Ffoo.md",
    );
    expect(pendingBatchStorageKey(context)).toBe(
      "syuire.batch:github:acme%2Fdocs:feature%2Fx:docs%2Ffoo.md",
    );
  });

  it("separates local and github and different files", () => {
    expect(queueStorageKey({ ...context, mode: "local" })).not.toBe(queueStorageKey(context));
    expect(queueStorageKey({ ...context, path: "docs/bar.md" })).not.toBe(queueStorageKey(context));
    expect(queueStorageKey({ ...context, branch: "main" })).not.toBe(queueStorageKey(context));
  });

  it("keys the recovery mirror by repository and branch, not by file", () => {
    expect(recoveryStorageKey(repoContext)).toBe(
      "syuire.recovery:local:C%3A%2Fwork%2Fclone:feature%2Fx",
    );
    expect(recoveryStorageKey({ ...repoContext, branch: "main" })).not.toBe(
      recoveryStorageKey(repoContext),
    );
  });
});

describe("serialisation", () => {
  it("round-trips an envelope", () => {
    const envelope = makeEnvelope(context, "abc123", [addComment("id-1")], "2026-09-07T00:00:00Z");
    const parsed = parseQueue(serializeQueue(envelope));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope.context).toEqual(context);
      expect(parsed.envelope.baseRevision).toBe("abc123");
      expect(parsed.envelope.ops).toHaveLength(1);
    }
  });

  it("carries the pending batch and the recovery info through export / import", () => {
    const envelope = makeEnvelope(context, "abc123", [addComment("id-1")], "2026-09-07T00:00:00Z", {
      pending: pendingBatch,
      recovery: recoveryInfo,
    });
    expect(envelope.pending).toEqual(pendingBatch);
    expect(envelope.recovery).toEqual(recoveryInfo);

    const parsed = parseQueue(serializeQueue(envelope));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.pending).toEqual(pendingBatch);
    expect(parsed.envelope.recovery).toEqual(recoveryInfo);
  });

  it("omits both when there is nothing unresolved, and drops broken ones on import", () => {
    const envelope = makeEnvelope(context, "abc123", [addComment("id-1")], "t", {
      pending: null,
      recovery: null,
    });
    expect("pending" in envelope).toBe(false);
    expect("recovery" in envelope).toBe(false);

    const broken = parseQueue(
      JSON.stringify({
        format: "syuire.queue",
        version: 1,
        context,
        baseRevision: "abc123",
        ops: [],
        pending: { candidateCommitId: "c1" }, // no batchId
        recovery: { batchId: "b1", phase: "nonsense", baseCommitId: "x", paths: [] },
      }),
    );
    expect(broken.ok).toBe(true);
    if (!broken.ok) return;
    expect(broken.envelope.pending).toBeUndefined();
    expect(broken.envelope.recovery).toBeUndefined();
  });

  it("rejects other JSON, other versions and broken ops", () => {
    expect(parseQueue("not json").ok).toBe(false);
    expect(parseQueue(JSON.stringify({ format: "other" })).ok).toBe(false);
    expect(
      parseQueue(JSON.stringify({ format: "syuire.queue", version: 99, context, baseRevision: "a", ops: [] })).ok,
    ).toBe(false);
    expect(
      parseQueue(
        JSON.stringify({
          format: "syuire.queue",
          version: 1,
          context,
          baseRevision: "a",
          ops: [{ kind: "nope" }],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseQueue(
        JSON.stringify({ format: "syuire.queue", version: 1, context, ops: [] }),
      ).ok,
    ).toBe(false);
  });
});

describe("sessionStorage mirroring", () => {
  it("writes under the context key and reads back", () => {
    const storage = memoryStorage();
    saveQueueTo(storage, context, "rev1", [addComment("id-1")], "2026-09-07T00:00:00Z");
    expect(storage.map.has(queueStorageKey(context))).toBe(true);
    const loaded = loadQueueFrom(storage, context);
    expect(loaded?.baseRevision).toBe("rev1");
    expect(loaded?.ops).toHaveLength(1);
  });

  it("removes the entry when the queue empties", () => {
    const storage = memoryStorage();
    saveQueueTo(storage, context, "rev1", [addComment("id-1")], "t");
    saveQueueTo(storage, context, "rev1", [], "t");
    expect(storage.map.has(queueStorageKey(context))).toBe(false);
    expect(loadQueueFrom(storage, context)).toBeNull();
  });

  it("does not return another file's queue", () => {
    const storage = memoryStorage();
    saveQueueTo(storage, context, "rev1", [addComment("id-1")], "t");
    expect(loadQueueFrom(storage, { ...context, path: "docs/bar.md" })).toBeNull();
  });

  it("keeps the pending batch id", () => {
    const storage = memoryStorage();
    savePendingBatch(storage, context, {
      batchId: "b-1",
      candidateCommitId: "c-1",
      startedAt: "t",
    });
    expect(loadPendingBatch(storage, context)).toEqual({
      batchId: "b-1",
      candidateCommitId: "c-1",
      startedAt: "t",
    });
    savePendingBatch(storage, context, null);
    expect(loadPendingBatch(storage, context)).toBeNull();
  });

  it("mirrors the local recovery info next to the pending batch", () => {
    const storage = memoryStorage();
    saveRecoveryMirror(storage, repoContext, recoveryInfo);
    expect(storage.map.has(recoveryStorageKey(repoContext))).toBe(true);
    expect(loadRecoveryMirror(storage, repoContext)).toEqual(recoveryInfo);

    // Another clone / branch never sees it.
    expect(loadRecoveryMirror(storage, { ...repoContext, branch: "main" })).toBeNull();

    saveRecoveryMirror(storage, repoContext, null);
    expect(storage.map.has(recoveryStorageKey(repoContext))).toBe(false);
    expect(loadRecoveryMirror(storage, repoContext)).toBeNull();
  });

  it("ignores a corrupted recovery mirror", () => {
    const storage = memoryStorage();
    storage.setItem(recoveryStorageKey(repoContext), "{ not json");
    expect(loadRecoveryMirror(storage, repoContext)).toBeNull();
    storage.setItem(recoveryStorageKey(repoContext), JSON.stringify({ batchId: "b" }));
    expect(loadRecoveryMirror(storage, repoContext)).toBeNull();
  });
});

describe("removeOperation", () => {
  it("removes replies, state changes and re-anchors of a removed comment", () => {
    const ops: Operation[] = [
      addComment("a"),
      addComment("b"),
      {
        kind: "addReply",
        commentId: "a",
        reply: { id: "r1", author: "u", timestamp: "t", text: "x" },
      },
      {
        kind: "setState",
        commentId: "a",
        from: "open",
        to: "resolved",
        threadFingerprint: "tf",
        blockFingerprint: "bf",
      },
      {
        kind: "reanchor",
        commentId: "b",
        previous: { anchor: "a", prefix: "", suffix: "" },
        next: { anchor: "b", prefix: "", suffix: "" },
        sourceOffset: 0,
        block: { type: "paragraph", range: { start: 0, end: 1 }, fingerprint: "fp" },
      },
    ];

    const afterA = removeOperation(ops, 0);
    expect(afterA.map((op) => op.kind)).toEqual(["addComment", "reanchor"]);

    const afterReply = removeOperation(ops, 2);
    expect(afterReply).toHaveLength(4);
    expect(afterReply.some((op) => op.kind === "addReply")).toBe(false);
  });

  it("ignores an out-of-range index", () => {
    const ops: Operation[] = [addComment("a")];
    expect(removeOperation(ops, 5)).toBe(ops);
  });
});
