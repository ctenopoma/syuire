import { AdapterError } from "@syuire/core";
import { describe, expect, it, vi } from "vitest";
import { LocalAdapterClient } from "./local.js";

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responses: Array<{ status?: number; body: unknown }>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const status = next?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(next?.body ?? null),
    } as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("LocalAdapterClient", () => {
  it("sends the bearer token and no-store on every request", async () => {
    const { fetchImpl, calls } = mockFetch([
      { body: { repoRoot: "C:/repo", branch: "main", head: "abc", upstream: "origin/main", authorName: "n", authorEmail: "e" } },
    ]);
    const client = new LocalAdapterClient("tok3n", { fetchImpl });
    const info = await client.info();

    expect(info.branch).toBe("main");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/info");
    expect(calls[0]!.init.cache).toBe("no-store");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok3n");
  });

  it("posts commits and returns the CommitResult", async () => {
    const { fetchImpl, calls } = mockFetch([
      { body: { status: "committed", commitId: "cafe", localReflection: "complete" } },
    ]);
    const client = new LocalAdapterClient("t", { fetchImpl, baseUrl: "http://127.0.0.1:4711" });
    const result = await client.commit({
      base: { revision: "base1", files: {} },
      changes: [{ path: "docs/a.md", text: "x" }],
      batchId: "11111111-2222-3333-4444-555555555555",
      message: "syuire: save\n\nsyuire-Batch: 11111111-2222-3333-4444-555555555555\n",
    });

    expect(result).toEqual({ status: "committed", commitId: "cafe", localReflection: "complete" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:4711/api/commit");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body)).batchId).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("turns an error body back into an AdapterError", async () => {
    const { fetchImpl } = mockFetch([
      {
        status: 409,
        body: {
          error: {
            kind: "worktree-dirty",
            message: "the work tree has uncommitted changes for: docs/a.md",
            details: { paths: ["docs/a.md"] },
          },
        },
      },
    ]);
    const client = new LocalAdapterClient("t", { fetchImpl });
    const err = await client
      .commit({
        base: { revision: "b", files: {} },
        changes: [{ path: "docs/a.md", text: "x" }],
        batchId: "11111111-2222-3333-4444-555555555555",
        message: "m",
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe("worktree-dirty");
    expect((err as AdapterError).details).toEqual({ paths: ["docs/a.md"] });
  });

  it("falls back to an internal AdapterError for an unknown error kind", async () => {
    const { fetchImpl } = mockFetch([{ status: 500, body: { error: { message: "boom" } } }]);
    const client = new LocalAdapterClient("t", { fetchImpl });
    const err = await client.sync().catch((e: unknown) => e);
    expect((err as AdapterError).kind).toBe("internal");
    expect((err as AdapterError).message).toBe("boom");
  });

  it("reports an unreachable host layer as a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const client = new LocalAdapterClient("t", { fetchImpl });
    const err = await client.head().catch((e: unknown) => e);
    expect((err as AdapterError).kind).toBe("network");
  });

  it("reads a blob as raw bytes and maps 404 to null", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x7f, 0x80]);
    const calls: Call[] = [];
    let first = true;
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (first) {
        first = false;
        return {
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === "etag" ? '"deadbeef"' : null) },
          arrayBuffer: async () => png.buffer.slice(0),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { kind: "not-found", message: "gone" } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new LocalAdapterClient("tok", { fetchImpl });
    const blob = await client.readBlob("docs/img/a.png", "rev1");
    expect(blob).not.toBeNull();
    expect(Array.from(blob!.bytes)).toEqual(Array.from(png));
    expect(blob!.blobId).toBe("deadbeef");
    expect(calls[0]!.url).toBe("/api/blob?path=docs%2Fimg%2Fa.png&revision=rev1");
    expect(calls[0]!.init.cache).toBe("no-store");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");

    expect(await client.readBlob("docs/img/missing.png", "rev1")).toBeNull();
  });

  it("unwraps the recovery and batch envelopes", async () => {
    const recovery = {
      batchId: "11111111-2222-3333-4444-555555555555",
      phase: "prepared-uncommitted",
      baseCommitId: "base",
      paths: ["docs/a.md"],
      blobs: { "docs/a.md": { before: "b1", after: "b2" } },
    };
    const { fetchImpl, calls } = mockFetch([
      { body: { recovery } },
      { body: { commitId: "abc123" } },
      { body: { recovery: null } },
    ]);
    const client = new LocalAdapterClient("t", { fetchImpl });
    expect(await client.recovery()).toEqual(recovery);
    expect(await client.findBatchCommit("11111111-2222-3333-4444-555555555555")).toBe("abc123");
    expect(await client.cancelPrepared()).toBeNull();
    expect(calls[1]!.url).toContain("/api/batch?batchId=");
    expect(calls[2]!.url).toBe("/api/recovery/cancel");
  });
});
