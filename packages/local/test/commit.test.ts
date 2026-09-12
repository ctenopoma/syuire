import { AdapterError, extractBatchId, formatCommitMessage } from "@akaire/core";
import { describe, expect, it } from "vitest";
import { LocalGitAdapter } from "../src/local-git-adapter.js";
import { git, gitRaw, makeFixture, uuid } from "./helpers.js";

const BODY = "docs/a.md";

async function commitFilesOf(repo: string, rev = "HEAD"): Promise<string[]> {
  const out = await git(repo, ["show", "--name-only", "--format=", rev]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort();
}

describe("LocalGitAdapter.commit", () => {
  it("commits a tracked file and reports complete local reflection", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const before = base.files[BODY];
    expect(before).not.toBeNull();

    const batchId = uuid();
    const result = await adapter.commit({
      base,
      changes: [{ path: BODY, text: `${before!.text}\nadded by akaire.\n` }],
      batchId,
      message: formatCommitMessage("akaire: add a comment", batchId),
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.localReflection).toBe("complete");

    // Parent is the base revision.
    expect((await git(fx.clone, ["rev-parse", "HEAD^"])).trim()).toBe(base.revision);
    // The batch trailer is present.
    const message = await git(fx.clone, ["log", "-1", "--format=%B"]);
    expect(extractBatchId(message)).toBe(batchId);
    // Three-way match: HEAD, index and work tree agree for the target.
    expect((await gitRaw(fx.clone, ["diff", "--quiet", "HEAD", "--", BODY])).code).toBe(0);
    expect((await gitRaw(fx.clone, ["diff", "--cached", "--quiet", "HEAD", "--", BODY])).code).toBe(0);
    expect(await fx.read(fx.clone, BODY)).toContain("added by akaire.");
    expect(await adapter.recovery()).toBeNull();
    expect(await commitFilesOf(fx.clone)).toEqual([BODY]);
  });

  it("preserves unrelated staged and unstaged changes and keeps them out of the commit", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);

    await fx.write(fx.clone, "other.md", "other staged\n");
    await git(fx.clone, ["add", "other.md"]);
    await fx.write(fx.clone, "third.md", "third unstaged\n");
    await fx.write(fx.clone, "untracked.txt", "untracked\n");

    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const result = await adapter.commit({
      base,
      changes: [{ path: BODY, text: "# A\n\nrewritten.\n" }],
      batchId,
      message: formatCommitMessage("akaire: save", batchId),
    });
    expect(result.status).toBe("committed");

    expect(await commitFilesOf(fx.clone)).toEqual([BODY]);
    const staged = await git(fx.clone, ["diff", "--cached", "--name-only"]);
    expect(staged.trim()).toBe("other.md");
    const unstaged = await git(fx.clone, ["diff", "--name-only"]);
    expect(unstaged.trim()).toBe("third.md");
    expect(await fx.exists(fx.clone, "untracked.txt")).toBe(true);
    expect(await fx.read(fx.clone, "other.md")).toBe("other staged\n");
    expect(await fx.read(fx.clone, "third.md")).toBe("third unstaged\n");
  });

  it("adds a new review log with add -N in the same commit as the body", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const logPath = `reviews/docs/a/20260907T001200Z-${batchId}.md`;

    const result = await adapter.commit({
      base,
      changes: [
        { path: BODY, text: "# A\n\nstripped.\n" },
        { path: logPath, text: `# review log\n\nbase: ${base.revision}\n` },
      ],
      batchId,
      message: formatCommitMessage("akaire: strip", batchId),
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.localReflection).toBe("complete");
    expect(await commitFilesOf(fx.clone)).toEqual([BODY, logPath].sort());
    expect((await git(fx.clone, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("refuses to overwrite a tracked path that the caller never read", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    // A first strip writes a review log; a second one must not silently
    // overwrite it (DESIGN.md 5.4 「既存パスには上書きしない」).
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const logPath = `reviews/docs/a/20260907T001200Z-${batchId}.md`;
    const first = await adapter.commit({
      base,
      changes: [
        { path: BODY, text: "# A\n\nstripped.\n" },
        { path: logPath, text: "first log\n" },
      ],
      batchId,
      message: formatCommitMessage("akaire: strip", batchId),
    });
    expect(first.status).toBe("committed");

    const base2 = await adapter.read([BODY]);
    const batch2 = uuid();
    const err = await adapter
      .commit({
        base: base2, // logPath was never read, so this is a new-file intent
        changes: [{ path: logPath, text: "second log\n" }],
        batchId: batch2,
        message: formatCommitMessage("akaire: strip", batch2),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe("validation");
    expect(await fx.read(fx.clone, logPath)).toBe("first log\n");
    expect(await adapter.recovery()).toBeNull();

    // A base that claims the path does not exist is refused for the same reason.
    const batch3 = uuid();
    await expect(
      adapter.commit({
        base: { revision: base2.revision, files: { ...base2.files, [logPath]: null } },
        changes: [{ path: logPath, text: "third log\n" }],
        batchId: batch3,
        message: formatCommitMessage("akaire: strip", batch3),
      }),
    ).rejects.toMatchObject({ kind: "validation" });

    // Reading it first turns the same call into an ordinary update.
    const base3 = await adapter.read([BODY, logPath]);
    const batch4 = uuid();
    const ok = await adapter.commit({
      base: base3,
      changes: [{ path: logPath, text: "edited log\n" }],
      batchId: batch4,
      message: formatCommitMessage("akaire: edit the log", batch4),
    });
    expect(ok.status).toBe("committed");
    expect(await fx.read(fx.clone, logPath)).toBe("edited log\n");
  });

  it("rejects a dirty target path", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    await fx.write(fx.clone, BODY, "# A\n\nedited outside.\n");

    const batchId = uuid();
    await expect(
      adapter.commit({
        base,
        changes: [{ path: BODY, text: "# A\n\nfrom akaire.\n" }],
        batchId,
        message: formatCommitMessage("akaire: save", batchId),
      }),
    ).rejects.toMatchObject({ kind: "worktree-dirty" });
    // The work tree was not touched.
    expect(await fx.read(fx.clone, BODY)).toBe("# A\n\nedited outside.\n");
  });

  it("rejects a target path with a staged change even when the work tree matches HEAD", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const original = base.files[BODY]!.text;

    await fx.write(fx.clone, BODY, "# A\n\nstaged only.\n");
    await git(fx.clone, ["add", BODY]);
    await fx.write(fx.clone, BODY, original); // work tree back to HEAD, index still differs

    const batchId = uuid();
    await expect(
      adapter.commit({
        base,
        changes: [{ path: BODY, text: `${original}extra\n` }],
        batchId,
        message: formatCommitMessage("akaire: save", batchId),
      }),
    ).rejects.toMatchObject({ kind: "worktree-dirty" });
  });

  it("reports a conflict when HEAD moved away from the base revision", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);

    await fx.write(fx.clone, "docs/b.md", "# B changed\n");
    await git(fx.clone, ["commit", "-am", "external commit"]);

    const batchId = uuid();
    await expect(
      adapter.commit({
        base,
        changes: [{ path: BODY, text: "# A\n\nfrom akaire.\n" }],
        batchId,
        message: formatCommitMessage("akaire: save", batchId),
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("stops with a validation error when the log path is ignored", async () => {
    const fx = await makeFixture();
    await fx.write(fx.clone, ".gitignore", "reviews/\n");
    await git(fx.clone, ["add", ".gitignore"]);
    await git(fx.clone, ["commit", "-m", "ignore reviews"]);

    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const logPath = `reviews/docs/a/log-${batchId}.md`;

    const err = await adapter
      .commit({
        base,
        changes: [
          { path: BODY, text: "# A\n\nstripped.\n" },
          { path: logPath, text: "log\n" },
        ],
        batchId,
        message: formatCommitMessage("akaire: strip", batchId),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe("validation");
    expect((err as AdapterError).message).toContain(".gitignore");
    // Nothing was written.
    expect(await fx.exists(fx.clone, logPath)).toBe(false);
    expect(await fx.read(fx.clone, BODY)).toBe("# A\n\nfirst paragraph.\n");
  });

  it("verifies correctly in a core.autocrlf=true repository with a CRLF work tree", async () => {
    const fx = await makeFixture({
      repoConfig: [["core.autocrlf", "true"]],
      initialFiles: { "docs/a.md": "# A\r\n\r\nfirst paragraph.\r\n" },
    });
    // The blob is normalised to LF while the work tree keeps CRLF.
    const raw = await fx.read(fx.clone, BODY);
    expect(raw).toContain("\r\n");
    const blobText = await git(fx.clone, ["show", `HEAD:${BODY}`]);
    expect(blobText).not.toContain("\r\n");

    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    expect(base.files[BODY]!.text).not.toContain("\r\n");

    const batchId = uuid();
    const result = await adapter.commit({
      base,
      changes: [{ path: BODY, text: `${base.files[BODY]!.text}akaire.\n` }],
      batchId,
      message: formatCommitMessage("akaire: save", batchId),
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.localReflection).toBe("complete");
    expect((await gitRaw(fx.clone, ["diff", "--quiet", "HEAD", "--", BODY])).code).toBe(0);

    // DESIGN.md 5.2: the work tree keeps CRLF (an editor watching the file
    // sees no line-ending churn), the committed blob is LF-only, and the
    // three-way match (work tree / index / HEAD) holds byte for byte.
    const afterRaw = await fx.read(fx.clone, BODY);
    expect(afterRaw).toBe("# A\r\n\r\nfirst paragraph.\r\nakaire.\r\n");
    const committedBlob = await git(fx.clone, ["show", `HEAD:${BODY}`]);
    expect(committedBlob).not.toContain("\r\n");
    expect(committedBlob).toBe("# A\n\nfirst paragraph.\nakaire.\n");
    expect((await git(fx.clone, ["status", "--porcelain", "--", BODY])).trim()).toBe("");
    expect((await gitRaw(fx.clone, ["diff", "--cached", "--quiet", "HEAD", "--", BODY])).code).toBe(0);
  });

  it("writes a new review log with CRLF in a core.autocrlf=true repository, committing it as LF", async () => {
    const fx = await makeFixture({
      repoConfig: [["core.autocrlf", "true"]],
      initialFiles: { "docs/a.md": "# A\r\n\r\nfirst paragraph.\r\n" },
    });
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    expect(base.files[BODY]!.text).not.toContain("\r\n");

    const batchId = uuid();
    const logPath = `reviews/docs/a/20260907T001200Z-${batchId}.md`;
    const logText = `# review log\n\nbase: ${base.revision}\n`;

    const result = await adapter.commit({
      base,
      changes: [
        { path: BODY, text: `${base.files[BODY]!.text}akaire.\n` },
        { path: logPath, text: logText },
      ],
      batchId,
      message: formatCommitMessage("akaire: save", batchId),
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.localReflection).toBe("complete");

    // The new file lands on disk with CRLF, matching the rest of this
    // CRLF work tree, but is committed with LF only.
    const rawLog = await fx.read(fx.clone, logPath);
    expect(rawLog).toBe(logText.replace(/\n/g, "\r\n"));
    const committedLog = await git(fx.clone, ["show", `HEAD:${logPath}`]);
    expect(committedLog).not.toContain("\r\n");
    expect(committedLog).toBe(logText);
    expect((await git(fx.clone, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("leaves an LF file byte-for-byte unchanged in a repository without autocrlf", async () => {
    const fx = await makeFixture(); // default fixture: core.autocrlf=false, LF content
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const before = base.files[BODY]!.text;
    expect(before).not.toContain("\r");

    const batchId = uuid();
    const newText = `${before}akaire.\n`;
    const result = await adapter.commit({
      base,
      changes: [{ path: BODY, text: newText }],
      batchId,
      message: formatCommitMessage("akaire: save", batchId),
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.localReflection).toBe("complete");

    const raw = await fx.read(fx.clone, BODY);
    expect(raw).toBe(newText);
    expect(raw).not.toContain("\r");
  });

  it("refuses to commit on a detached HEAD but still reads", async () => {
    const fx = await makeFixture();
    await git(fx.clone, ["checkout", "--detach", "HEAD"]);
    const adapter = await LocalGitAdapter.open(fx.clone);
    expect(adapter.branch).toBeNull();

    const base = await adapter.read([BODY]);
    expect(base.files[BODY]).not.toBeNull();
    const entries = await adapter.list("docs", base.revision);
    expect(entries.map((e) => e.path)).toEqual(["docs/a.md", "docs/b.md"]);

    const batchId = uuid();
    await expect(
      adapter.commit({
        base,
        changes: [{ path: BODY, text: "x\n" }],
        batchId,
        message: formatCommitMessage("akaire: save", batchId),
      }),
    ).rejects.toMatchObject({ kind: "repo-state" });
  });

  it("lists and reads at a revision", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const head = await adapter.head();
    const root = await adapter.list("", head);
    expect(root.find((e) => e.path === "docs")).toMatchObject({ kind: "dir" });
    const file = root.find((e) => e.path === "other.md");
    expect(file?.kind).toBe("file");
    expect(typeof file?.blobId).toBe("string");
    expect(file?.size).toBe("other\n".length);

    const snapshot = await adapter.read([BODY, "docs/missing.md"]);
    expect(snapshot.revision).toBe(head);
    expect(snapshot.files["docs/missing.md"]).toBeNull();
    expect(snapshot.files[BODY]?.text).toBe("# A\n\nfirst paragraph.\n");
  });

  it("readBlob returns raw bytes for a committed binary file", async () => {
    const fx = await makeFixture();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0xff, 0x00, 0xfe, 0x7f, 0x80, 0x0a, 0x0d, 0x1a, 0xff,
    ]);
    await fx.writeBytes(fx.clone, "docs/img/a.png", png);
    await git(fx.clone, ["add", "--", "docs/img/a.png"]);
    await git(fx.clone, ["commit", "-m", "add image"]);

    const adapter = await LocalGitAdapter.open(fx.clone);
    const head = await adapter.head();
    const blob = await adapter.readBlob("docs/img/a.png", head);
    expect(blob).not.toBeNull();
    expect(Array.from(blob!.bytes)).toEqual(Array.from(png));
    expect(blob!.blobId).toMatch(/^[0-9a-f]{40}$/);

    // Missing paths and paths that are directories are null, not an error.
    expect(await adapter.readBlob("docs/img/missing.png", head)).toBeNull();
    expect(await adapter.readBlob("docs/img", head)).toBeNull();
    await expect(adapter.readBlob("../outside.png", head)).rejects.toBeInstanceOf(AdapterError);
  });

  it("finds a commit by its batch trailer", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const result = await adapter.commit({
      base,
      changes: [{ path: BODY, text: "# A\n\nsaved.\n" }],
      batchId,
      message: formatCommitMessage("akaire: save", batchId),
    });
    if (result.status !== "committed") throw new Error("unreachable");
    expect(await adapter.findBatchCommit(batchId)).toBe(result.commitId);
    expect(await adapter.findBatchCommit(uuid())).toBeNull();
  });
});
