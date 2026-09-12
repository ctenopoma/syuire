import { AdapterError } from "@syuire/core";
import { describe, expect, it } from "vitest";
import { MAX_DETAIL_CHARS, redactDetails, redactText } from "../src/redact.js";
import { classifyRemoteFailure } from "../src/repo-queries.js";
import type { GitResult } from "../src/git.js";

function gitResult(stderr: string, stdout = ""): GitResult {
  return {
    stdout,
    stderr,
    code: 128,
    stdoutRaw: Buffer.from(stdout, "utf8"),
    signal: null,
    failedToSpawn: false,
    unobservable: false,
    timedOut: false,
  };
}

describe("redactText", () => {
  it("removes credentials embedded in a remote URL", () => {
    const line =
      "fatal: unable to access 'https://naoki:ghp_secret_token_value@github.com/acme/docs.git/': 403";
    const redacted = redactText(line);
    expect(redacted).not.toContain("ghp_secret_token_value");
    expect(redacted).not.toContain("naoki:");
    expect(redacted).toContain("https://***@github.com/acme/docs.git/");
  });

  it("redacts every occurrence and every scheme", () => {
    const text = [
      "remote: https://user:pw@example.invalid/a.git",
      "remote: http://token@example.invalid/b.git",
      "remote: ssh://git:key@example.invalid/c.git",
    ].join("\n");
    const redacted = redactText(text);
    expect(redacted).not.toMatch(/pw@|token@|key@/);
    expect(redacted.match(/:\/\/\*\*\*@/g)).toHaveLength(3);
  });

  it("leaves an ordinary URL and ordinary text alone", () => {
    expect(redactText("https://github.com/acme/docs.git")).toBe(
      "https://github.com/acme/docs.git",
    );
    expect(redactText("error: pathspec 'a@b' did not match")).toBe(
      "error: pathspec 'a@b' did not match",
    );
  });

  it("caps a long string at 2000 characters", () => {
    const long = `x`.repeat(50_000);
    const redacted = redactText(long);
    expect(redacted.length).toBe(MAX_DETAIL_CHARS);
    expect(redacted.endsWith("…")).toBe(true);
    expect(redactText("short").length).toBe(5);
  });
});

describe("redactDetails", () => {
  it("walks nested objects and arrays", () => {
    const details = redactDetails({
      stderr: "https://u:secret@host/x.git failed",
      paths: ["docs/a.md", "https://u:secret2@host/y.git"],
      nested: { stdout: "https://u:secret3@host/z.git", code: 128, flag: true, nil: null },
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(details);
    expect(serialized).not.toMatch(/secret/);
    expect(serialized.match(/\*\*\*@/g)).toHaveLength(3);
    expect((details["nested"] as Record<string, unknown>)["code"]).toBe(128);
    expect((details["nested"] as Record<string, unknown>)["nil"]).toBeNull();
  });

  it("caps long strings inside details too", () => {
    const details = redactDetails({ stderr: "y".repeat(10_000) }) as { stderr: string };
    expect(details.stderr.length).toBe(MAX_DETAIL_CHARS);
  });
});

describe("classifyRemoteFailure", () => {
  it("never attaches an un-redacted remote URL to the error details", () => {
    const err = classifyRemoteFailure(
      gitResult(
        "remote: Invalid username or password\n" +
          "fatal: Authentication failed for 'https://naoki:ghp_hunter2@github.com/acme/docs.git/'\n",
      ),
      ["push"],
    );
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.kind).toBe("auth");
    expect(JSON.stringify(err.details)).not.toContain("ghp_hunter2");
    expect(JSON.stringify(err.details)).toContain("***@github.com");
  });

  it("reports a killed command as a timeout that may be waiting for credentials", () => {
    const timed: GitResult = { ...gitResult(""), code: -1, signal: "SIGTERM", timedOut: true, unobservable: true };
    const err = classifyRemoteFailure(timed, ["fetch", "--prune"]);
    expect(err.kind).toBe("network");
    expect(err.message).toContain("認証情報");
    expect((err.details as { timedOut?: boolean }).timedOut).toBe(true);
  });
});
