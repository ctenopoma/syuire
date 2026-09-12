import { formatCommitMessage } from "@syuire/core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalGitAdapter } from "../src/local-git-adapter.js";
import { git, makeFixture, uuid } from "./helpers.js";

const BODY = "docs/a.md";

async function localCommit(repo: string, file: string, text: string, subject: string): Promise<void> {
  const abs = path.join(repo, file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text);
  await git(repo, ["add", "--", file]);
  await git(repo, ["commit", "-m", subject]);
}

describe("LocalGitAdapter sync", () => {
  it("reports in-sync right after cloning", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const status = await adapter.sync();
    expect(status.branch).toBe("main");
    expect(status.upstream).toBe("origin/main");
    expect(status.state).toBe("in-sync");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.lastFetchedAt).toBeNull();
  });

  it("reports no-upstream when the branch has none", async () => {
    const fx = await makeFixture();
    await git(fx.clone, ["checkout", "-b", "side"]);
    const adapter = await LocalGitAdapter.open(fx.clone);
    const status = await adapter.sync();
    expect(status.branch).toBe("side");
    expect(status.upstream).toBeNull();
    expect(status.state).toBe("no-upstream");
  });

  it("reports local-ahead, then in-sync after push", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    await localCommit(fx.clone, "docs/c.md", "# C\n", "local work");
    expect((await adapter.sync()).state).toBe("local-ahead");

    const after = await adapter.push();
    expect(after.state).toBe("in-sync");
    expect(after.ahead).toBe(0);
  });

  it("reports remote-ahead after fetch and fast-forwards on pull", async () => {
    const fx = await makeFixture();
    const other = await fx.clone2();
    await localCommit(other, "docs/d.md", "# D\n", "remote work");
    await git(other, ["push"]);

    const adapter = await LocalGitAdapter.open(fx.clone);
    const fetched = await adapter.fetch();
    expect(fetched.state).toBe("remote-ahead");
    expect(fetched.behind).toBe(1);
    expect(typeof fetched.lastFetchedAt).toBe("string");

    const pulled = await adapter.pull();
    expect(pulled.state).toBe("in-sync");
    expect(await fx.exists(fx.clone, "docs/d.md")).toBe(true);
  });

  it("refuses to pull when the branch has diverged", async () => {
    const fx = await makeFixture();
    const other = await fx.clone2();
    await localCommit(other, "docs/d.md", "# D\n", "remote work");
    await git(other, ["push"]);
    await localCommit(fx.clone, "docs/e.md", "# E\n", "local work");

    const adapter = await LocalGitAdapter.open(fx.clone);
    await adapter.fetch();
    expect((await adapter.sync()).state).toBe("diverged");
    await expect(adapter.pull()).rejects.toMatchObject({ kind: "conflict" });
    // No merge was made.
    expect((await git(fx.clone, ["rev-list", "--count", "HEAD"])).trim()).toBe("2");
  });

  it("rejects a non-fast-forward push as a conflict", async () => {
    const fx = await makeFixture();
    const other = await fx.clone2();
    await localCommit(other, "docs/d.md", "# D\n", "remote work");
    await git(other, ["push"]);
    await localCommit(fx.clone, "docs/e.md", "# E\n", "local work");

    const adapter = await LocalGitAdapter.open(fx.clone);
    await expect(adapter.push()).rejects.toMatchObject({ kind: "conflict" });
  });

  it("commits, then pushes the commit to the remote", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    const result = await adapter.commit({
      base,
      changes: [{ path: BODY, text: "# A\n\nsaved locally.\n" }],
      batchId,
      message: formatCommitMessage("syuire: save", batchId),
    });
    if (result.status !== "committed") throw new Error("unreachable");

    const status = await adapter.push();
    expect(status.state).toBe("in-sync");
    const remoteHead = (await git(fx.remote, ["rev-parse", "refs/heads/main"])).trim();
    expect(remoteHead).toBe(result.commitId);
  });

  it("reports repo-busy while a merge is in progress", async () => {
    const fx = await makeFixture();
    const other = await fx.clone2();
    await localCommit(other, BODY, "# A\n\nremote edit.\n", "remote edit");
    await git(other, ["push"]);
    await localCommit(fx.clone, BODY, "# A\n\nlocal edit.\n", "local edit");

    const adapter = await LocalGitAdapter.open(fx.clone);
    await adapter.fetch();
    // Deliberately create a conflicted merge with plain Git.
    const merge = await git(fx.clone, ["merge", "origin/main"]).catch(() => "conflict");
    expect(merge).toBeDefined();

    const status = await adapter.sync();
    expect(status.state).toBe("repo-busy");
    const base = await adapter.read([BODY]);
    const batchId = uuid();
    await expect(
      adapter.commit({
        base,
        changes: [{ path: BODY, text: "x\n" }],
        batchId,
        message: formatCommitMessage("syuire: save", batchId),
      }),
    ).rejects.toMatchObject({ kind: "repo-state" });
  });

  it("reports the repository info", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    const info = await adapter.info();
    expect(await fs.realpath(info.repoRoot)).toBe(await fs.realpath(fx.clone));
    expect(info.branch).toBe("main");
    expect(info.upstream).toBe("origin/main");
    expect(info.authorName).toBe("syuire Test");
    expect(info.authorEmail).toBe("test@example.invalid");
    expect(info.head).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("rejects opening a directory that is not a work tree", async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "syuire-nonrepo-"));
    try {
      await expect(LocalGitAdapter.open(dir)).rejects.toMatchObject({ kind: "repo-state" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
