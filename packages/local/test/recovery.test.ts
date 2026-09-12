import { formatCommitMessage } from "@akaire/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalGitAdapter } from "../src/local-git-adapter.js";
import { git, makeFixture, uuid, type Fixture } from "./helpers.js";

const BODY = "docs/a.md";
const ORIGINAL = "# A\n\nfirst paragraph.\n";

const FAILING_HOOK = `#!/bin/sh
if [ -f "$(git rev-parse --git-dir)/akaire-fail" ]; then
  echo "pre-commit refused" >&2
  exit 1
fi
exit 0
`;

const MUTATING_HOOK = `#!/bin/sh
printf 'appended by a hook\\n' >> docs/a.md
exit 0
`;

async function marker(fx: Fixture, on: boolean): Promise<void> {
  const file = path.join(fx.clone, ".git", "akaire-fail");
  if (on) await fs.writeFile(file, "");
  else await fs.rm(file, { force: true });
}

async function commitCount(repo: string): Promise<number> {
  return Number((await git(repo, ["rev-list", "--count", "HEAD"])).trim());
}

describe("LocalGitAdapter recovery", () => {
  it("keeps a prepared batch when the commit fails and retries it without writing twice", async () => {
    const fx = await makeFixture();
    await fx.installHook(fx.clone, "pre-commit", FAILING_HOOK);
    await marker(fx, true);

    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const logPath = `reviews/docs/a/log-${batchId}.md`;
    const input = {
      base,
      changes: [
        { path: BODY, text: `${ORIGINAL}akaire line.\n` },
        { path: logPath, text: "log body\n" },
      ],
      batchId,
      message: formatCommitMessage("akaire: save", batchId),
    };
    const commitsBefore = await commitCount(fx.clone);

    await expect(adapter.commit(input)).rejects.toMatchObject({ kind: "commit-failed" });

    const rec = await adapter.recovery();
    expect(rec?.phase).toBe("prepared-uncommitted");
    expect(rec?.batchId).toBe(batchId);
    expect(rec?.paths.sort()).toEqual([BODY, logPath].sort());
    // The prepared content is in the work tree and the log has an intent-to-add entry.
    expect(await fx.read(fx.clone, BODY)).toBe(`${ORIGINAL}akaire line.\n`);
    expect((await git(fx.clone, ["ls-files", "--", logPath])).trim()).toBe(logPath);
    expect(commitsBefore).toBe(await commitCount(fx.clone));

    // Retry after fixing the hook: no double write, exactly one new commit.
    await marker(fx, false);
    const result = await adapter.commit(input);
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.localReflection).toBe("complete");
    expect(await commitCount(fx.clone)).toBe(commitsBefore + 1);
    expect(await fx.read(fx.clone, BODY)).toBe(`${ORIGINAL}akaire line.\n`);
    expect(await adapter.recovery()).toBeNull();
    expect((await git(fx.clone, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("stops with worktree-recovery when a prepared file was edited externally", async () => {
    const fx = await makeFixture();
    await fx.installHook(fx.clone, "pre-commit", FAILING_HOOK);
    await marker(fx, true);

    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const input = {
      base,
      changes: [{ path: BODY, text: `${ORIGINAL}akaire line.\n` }],
      batchId,
      message: formatCommitMessage("akaire: save", batchId),
    };
    await expect(adapter.commit(input)).rejects.toMatchObject({ kind: "commit-failed" });

    await fx.write(fx.clone, BODY, "something an editor wrote\n");
    await marker(fx, false);

    await expect(adapter.commit(input)).rejects.toMatchObject({ kind: "worktree-recovery" });
    expect((await adapter.recovery())?.phase).toBe("prepared-uncommitted");
    // Nothing was overwritten.
    expect(await fx.read(fx.clone, BODY)).toBe("something an editor wrote\n");
  });

  it("cancels a prepared batch, restoring content and dropping the intent-to-add entry", async () => {
    const fx = await makeFixture();
    await fx.installHook(fx.clone, "pre-commit", FAILING_HOOK);
    await marker(fx, true);

    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const logPath = `reviews/docs/a/log-${batchId}.md`;
    await expect(
      adapter.commit({
        base,
        changes: [
          { path: BODY, text: `${ORIGINAL}akaire line.\n` },
          { path: logPath, text: "log body\n" },
        ],
        batchId,
        message: formatCommitMessage("akaire: save", batchId),
      }),
    ).rejects.toMatchObject({ kind: "commit-failed" });

    expect((await git(fx.clone, ["ls-files", "--", logPath])).trim()).toBe(logPath);

    expect(await adapter.cancelPrepared()).toBeNull();
    expect(await adapter.recovery()).toBeNull();
    expect(await fx.read(fx.clone, BODY)).toBe(ORIGINAL);
    expect(await fx.exists(fx.clone, logPath)).toBe(false);
    expect((await git(fx.clone, ["ls-files", "--", logPath])).trim()).toBe("");
    expect((await git(fx.clone, ["status", "--porcelain"])).trim()).toBe("");

    // A fresh save works afterwards.
    await marker(fx, false);
    const batch2 = uuid();
    const base2 = await adapter.read([BODY]);
    const result = await adapter.commit({
      base: base2,
      changes: [{ path: BODY, text: `${ORIGINAL}second try.\n` }],
      batchId: batch2,
      message: formatCommitMessage("akaire: save", batch2),
    });
    expect(result.status).toBe("committed");
  });

  it("reports needs-recovery when a hook changes the work tree during the commit", async () => {
    const fx = await makeFixture();
    await fx.installHook(fx.clone, "pre-commit", MUTATING_HOOK);

    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const result = await adapter.commit({
      base,
      changes: [{ path: BODY, text: `${ORIGINAL}akaire line.\n` }],
      batchId,
      message: formatCommitMessage("akaire: save", batchId),
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.localReflection).toBe("needs-recovery");
    if (result.localReflection !== "needs-recovery") throw new Error("unreachable");
    expect(result.paths).toEqual([BODY]);
    expect(result.reason).toMatch(/work tree/);

    const rec = await adapter.recovery();
    expect(rec?.phase).toBe("committed-needs-recovery");
    expect(rec?.newCommitId).toBe(result.commitId);

    // 新規保存・pull・push 禁止.
    await expect(
      adapter.commit({
        base: await adapter.read([BODY]),
        changes: [{ path: BODY, text: "anything\n" }],
        batchId: uuid(),
        message: formatCommitMessage("akaire: save", uuid()),
      }),
    ).rejects.toMatchObject({ kind: "worktree-recovery" });
    await expect(adapter.push()).rejects.toMatchObject({ kind: "worktree-recovery" });
    await expect(adapter.pull()).rejects.toMatchObject({ kind: "worktree-recovery" });

    // clearRecovery refuses while the three-way match is still broken.
    await expect(adapter.clearRecovery()).rejects.toMatchObject({ kind: "worktree-recovery" });

    // The user repairs the work tree with an external tool, then acknowledges.
    await git(fx.clone, ["checkout", "--", BODY]);
    expect(await adapter.clearRecovery()).toBeNull();
    expect(await adapter.recovery()).toBeNull();
  });

  it("treats a failed work-tree write as prepared-uncommitted and can cancel it", async () => {
    const fx = await makeFixture();
    // "reviews/docs" exists as a file, so creating reviews/docs/a/ must fail.
    await fx.write(fx.clone, "reviews/docs", "not a directory\n");
    await git(fx.clone, ["add", "reviews/docs"]);
    await git(fx.clone, ["commit", "-m", "add a blocking file"]);

    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const logPath = `reviews/docs/a/log-${batchId}.md`;

    await expect(
      adapter.commit({
        base,
        changes: [
          { path: BODY, text: `${ORIGINAL}akaire line.\n` },
          { path: logPath, text: "log body\n" },
        ],
        batchId,
        message: formatCommitMessage("akaire: strip", batchId),
      }),
    ).rejects.toMatchObject({ kind: "worktree-recovery" });

    const rec = await adapter.recovery();
    expect(rec?.phase).toBe("prepared-uncommitted");
    // The first file was written, the second was not, and no commit was made.
    expect(await fx.read(fx.clone, BODY)).toBe(`${ORIGINAL}akaire line.\n`);
    expect((await git(fx.clone, ["log", "-1", "--format=%s"])).trim()).toBe("add a blocking file");

    expect(await adapter.cancelPrepared()).toBeNull();
    expect(await fx.read(fx.clone, BODY)).toBe(ORIGINAL);
    expect((await git(fx.clone, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("refuses resolveUnknown when there is nothing unconfirmed", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    await expect(adapter.resolveUnknown()).rejects.toMatchObject({ kind: "validation" });
  });
});
