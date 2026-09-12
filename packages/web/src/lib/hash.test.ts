import { describe, expect, it } from "vitest";
import { formatGhSpec, parseGhSpec, parseHash } from "./hash";

describe("parseGhSpec", () => {
  it("parses owner/repo", () => {
    expect(parseGhSpec("acme/docs")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "",
      path: "",
    });
  });

  it("parses owner/repo@branch", () => {
    expect(parseGhSpec("acme/docs@review")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "review",
      path: "",
    });
  });

  it("parses owner/repo@branch:path with a slashed branch and path", () => {
    expect(parseGhSpec("acme/docs@feature/x:docs/foo.md")).toEqual({
      owner: "acme",
      repo: "docs",
      branch: "feature/x",
      path: "docs/foo.md",
    });
  });

  it("rejects malformed specs", () => {
    expect(parseGhSpec("")).toBeNull();
    expect(parseGhSpec("acme")).toBeNull();
    expect(parseGhSpec("a/b/c")).toBeNull();
    expect(parseGhSpec("/docs")).toBeNull();
  });
});

describe("parseHash", () => {
  it("returns none for an empty fragment", () => {
    expect(parseHash("")).toEqual({ kind: "none" });
    expect(parseHash("#")).toEqual({ kind: "none" });
  });

  it("detects the local session token", () => {
    expect(parseHash("#token=abc123")).toEqual({ kind: "local", token: "abc123" });
  });

  it("prefers the token over a gh spec", () => {
    expect(parseHash("#gh=a/b&token=t")).toEqual({ kind: "local", token: "t" });
  });

  it("prefills a GitHub connection", () => {
    expect(parseHash("#gh=acme/docs@review:docs/foo.md")).toEqual({
      kind: "github",
      prefill: { owner: "acme", repo: "docs", branch: "review", path: "docs/foo.md" },
    });
  });

  it("ignores an unusable gh spec", () => {
    expect(parseHash("#gh=nope")).toEqual({ kind: "none" });
    expect(parseHash("#other=1")).toEqual({ kind: "none" });
  });

  it("round-trips through formatGhSpec", () => {
    const prefill = { owner: "acme", repo: "docs", branch: "review", path: "docs/foo.md" };
    expect(parseHash(`#gh=${formatGhSpec(prefill)}`)).toEqual({ kind: "github", prefill });
  });

  it("formats without optional parts", () => {
    expect(formatGhSpec({ owner: "a", repo: "b", branch: "", path: "" })).toBe("a/b");
    expect(formatGhSpec({ owner: "a", repo: "b", branch: "m", path: "" })).toBe("a/b@m");
  });
});
