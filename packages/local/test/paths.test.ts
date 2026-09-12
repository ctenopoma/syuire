import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRepoPath, validateRepoPathSyntax, validateRevision } from "../src/paths.js";
import { LocalGitAdapter } from "../src/local-git-adapter.js";
import { makeFixture } from "./helpers.js";

describe("repo path safety", () => {
  const cases: Array<[string, string]> = [
    ["parent traversal", "../x"],
    ["nested traversal", "docs/../../x"],
    ["dot segment", "./x"],
    ["git directory", ".git/config"],
    ["git directory nested", "docs/.git/config"],
    ["posix absolute", "/etc/passwd"],
    ["windows absolute", "C:/Windows/System32/config"],
    ["backslash separator", "docs\\a.md"],
    ["empty", ""],
    ["empty segment", "docs//a.md"],
  ];

  for (const entry of cases) {
    const label = entry[0];
    const value = entry[1];
    it(`rejects ${label}: ${JSON.stringify(value)}`, async () => {
      expect(() => validateRepoPathSyntax(value)).toThrowError();
      const root = await fs.realpath(os.tmpdir());
      await expect(resolveRepoPath(root, value)).rejects.toMatchObject({ kind: "validation" });
    });
  }

  it("accepts ordinary repo-relative paths", async () => {
    const fx = await makeFixture();
    const resolved = await resolveRepoPath(fx.clone, "docs/a.md");
    expect(resolved).toBe(path.join(fx.clone, "docs", "a.md"));
  });

  it("rejects a path that leaves the repository through a symlink", async () => {
    const fx = await makeFixture();
    const outside = path.join(fx.root, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.md"), "secret\n");
    try {
      await fs.symlink(outside, path.join(fx.clone, "link"), "junction");
    } catch {
      return; // creating links may be disallowed; the syntax cases still cover the API
    }
    await expect(resolveRepoPath(fx.clone, "link/secret.md")).rejects.toMatchObject({
      kind: "validation",
    });
  });

  it("rejects unsafe paths through the adapter API", async () => {
    const fx = await makeFixture();
    const adapter = await LocalGitAdapter.open(fx.clone);
    await expect(adapter.read(["../x"])).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.read([".git/config"])).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.read(["/etc/passwd"])).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.list("../x", "HEAD")).rejects.toMatchObject({ kind: "validation" });
  });

  it("rejects revisions that could be read as options", () => {
    expect(() => validateRevision("--upload-pack=evil")).toThrowError();
    expect(() => validateRevision("")).toThrowError();
    expect(validateRevision("HEAD")).toBe("HEAD");
    expect(validateRevision("0123456789abcdef0123456789abcdef01234567")).toBeTruthy();
  });
});
