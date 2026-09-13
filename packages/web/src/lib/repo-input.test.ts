import { describe, expect, it } from "vitest";
import { parseRepoInput, repoLabel } from "./repo-input";

describe("parseRepoInput", () => {
  it("accepts owner/repo specs", () => {
    expect(parseRepoInput("acme/docs")).toEqual({ owner: "acme", repo: "docs", branch: "", path: "" });
    expect(parseRepoInput(" acme/docs.git ")).toEqual({ owner: "acme", repo: "docs", branch: "", path: "" });
    expect(parseRepoInput("acme/docs@review:docs/a.md")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "review",
      path: "docs/a.md",
    });
  });

  it("accepts repository URLs", () => {
    expect(parseRepoInput("https://github.com/acme/docs")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "",
      path: "",
    });
    expect(parseRepoInput("https://github.com/acme/docs.git/")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "",
      path: "",
    });
    expect(parseRepoInput("github.com/acme/docs")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "",
      path: "",
    });
  });

  it("takes branch and path from tree / blob URLs", () => {
    expect(parseRepoInput("https://github.com/acme/docs/tree/review")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "review",
      path: "",
    });
    expect(parseRepoInput("https://github.com/acme/docs/tree/review/docs/guide")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "review",
      path: "docs/guide",
    });
    expect(parseRepoInput("https://github.com/acme/docs/blob/review/docs/%E6%A6%82%E8%A6%81.md?plain=1#L3")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "review",
      path: "docs/概要.md",
    });
  });

  it("accepts ssh remotes", () => {
    expect(parseRepoInput("git@github.com:acme/docs.git")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "",
      path: "",
    });
  });

  it("rejects other hosts and malformed input", () => {
    expect(parseRepoInput("")).toBeNull();
    expect(parseRepoInput("https://gitlab.com/acme/docs")).toBeNull();
    expect(parseRepoInput("acme")).toBeNull();
    expect(parseRepoInput("https://github.com/acme")).toBeNull();
    expect(parseRepoInput("a b/c")).toBeNull();
  });

  it("labels a repository with its branch", () => {
    expect(repoLabel({ owner: "acme", repo: "docs" })).toBe("acme/docs");
    expect(repoLabel({ owner: "acme", repo: "docs", branch: "review" })).toBe("acme/docs @review");
  });
});
