import { describe, expect, it } from "vitest";
import { AdapterError, formatCommitMessage } from "@syuire/core";
import { GitHubAdapter } from "./github.js";

// ---------------------------------------------------------------------------
// A small in-memory fake of the GitHub REST + Git Data API, exposed as a
// `fetch` implementation. Only the endpoints GitHubAdapter calls are
// implemented; everything else 404s.
// ---------------------------------------------------------------------------

const OWNER = "acme";
const REPO = "manuscripts";
const BRANCH = "main";
const TOKEN = "ghp_super-secret-token-value-123456";

type FakeTreeEntry = { path: string; mode: string; type: "blob" | "tree"; sha: string };
type FakeTree = { sha: string; tree: FakeTreeEntry[] };
type FakeCommit = { sha: string; tree: string; parents: string[]; message: string };
/** Blob content. Text blobs keep their text; binary blobs keep raw bytes. */
type FakeBlob = { sha: string; text: string; bytes?: Uint8Array };
/** Optional per-blob override for the Contents API response (for too-large / bad-encoding tests). */
type FakeContentsOverride = { size: number; encoding: string; content: string; sha?: string };

type Node = { type: "blob"; mode: string; sha: string } | { type: "tree"; children: Map<string, Node> };

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

class FakeGitHub {
  refs = new Map<string, string>(); // "heads/<branch>" -> commit sha
  commits = new Map<string, FakeCommit>();
  trees = new Map<string, FakeTree>();
  blobs = new Map<string, FakeBlob>();
  contentsOverrides = new Map<string, FakeContentsOverride>();
  userLogin = "octocat";
  private counter = 0;

  nextSha(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter.toString(16).padStart(8, "0")}`;
  }

  /** Seed a root commit for `branch` from a flat path -> text (or bytes) map. */
  seedRepo(files: Record<string, string | Uint8Array>, branch = BRANCH): string {
    const root = new Map<string, Node>();
    for (const [path, value] of Object.entries(files)) {
      const sha = this.nextSha("blob");
      if (typeof value === "string") this.blobs.set(sha, { sha, text: value });
      else this.blobs.set(sha, { sha, text: "", bytes: value });
      this.setPath(root, path.split("/"), "100644", sha);
    }
    const treeSha = this.persistNode(root);
    const commitSha = this.nextSha("commit");
    this.commits.set(commitSha, { sha: commitSha, tree: treeSha, parents: [], message: "initial" });
    this.refs.set(`heads/${branch}`, commitSha);
    return commitSha;
  }

  /** Directly register a too-large / non-base64 contents response for a path. */
  overridePath(path: string, override: FakeContentsOverride): void {
    this.contentsOverrides.set(path, override);
  }

  /** Raw bytes of a blob: the stored bytes for binary blobs, UTF-8 otherwise. */
  blobBytes(sha: string): Uint8Array | null {
    const blob = this.blobs.get(sha);
    if (!blob) return null;
    return blob.bytes ?? utf8Bytes(blob.text);
  }

  private loadNode(treeSha: string): Map<string, Node> {
    const children = new Map<string, Node>();
    const t = this.trees.get(treeSha);
    if (!t) return children;
    for (const e of t.tree) {
      if (e.type === "tree") {
        children.set(e.path, { type: "tree", children: this.loadNode(e.sha) });
      } else {
        children.set(e.path, { type: "blob", mode: e.mode, sha: e.sha });
      }
    }
    return children;
  }

  private setPath(root: Map<string, Node>, segments: string[], mode: string, sha: string): void {
    const [head, ...rest] = segments as [string, ...string[]];
    if (rest.length === 0) {
      root.set(head, { type: "blob", mode, sha });
      return;
    }
    let node = root.get(head);
    if (!node || node.type !== "tree") {
      node = { type: "tree", children: new Map() };
      root.set(head, node);
    }
    this.setPath(node.children, rest, mode, sha);
  }

  private persistNode(children: Map<string, Node>): string {
    const entries: FakeTreeEntry[] = [];
    for (const [name, node] of children) {
      if (node.type === "blob") {
        entries.push({ path: name, mode: node.mode, type: "blob", sha: node.sha });
      } else {
        entries.push({ path: name, mode: "040000", type: "tree", sha: this.persistNode(node.children) });
      }
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    const sha = this.nextSha("tree");
    this.trees.set(sha, { sha, tree: entries });
    return sha;
  }

  createTreeWithChanges(baseTreeSha: string, changes: FakeTreeEntry[]): string {
    const root = this.loadNode(baseTreeSha);
    for (const c of changes) {
      this.setPath(root, c.path.split("/"), c.mode, c.sha);
    }
    return this.persistNode(root);
  }

  resolveContents(
    commitSha: string,
    path: string,
  ): { kind: "not-found" } | { kind: "dir"; entries: Array<{ path: string; sha: string; type: "file" | "dir"; size?: number }> } | { kind: "file"; sha: string; text: string; bytes: Uint8Array; path: string } {
    const commit = this.commits.get(commitSha);
    if (!commit) return { kind: "not-found" };
    const segments = path.split("/").filter((s) => s.length > 0);
    let treeSha = commit.tree;
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      const tree = this.trees.get(treeSha);
      if (!tree) return { kind: "not-found" };
      const found = tree.tree.find((e) => e.path === seg);
      if (!found) return { kind: "not-found" };
      const isLast = i === segments.length - 1;
      if (isLast) {
        if (found.type === "tree") {
          const subtree = this.trees.get(found.sha);
          const entries = (subtree?.tree ?? []).map((e) => {
            const entryPath = `${currentPath}/${e.path}`;
            if (e.type === "blob") {
              const bytes = this.blobBytes(e.sha);
              return { path: entryPath, sha: e.sha, type: "file" as const, size: bytes ? bytes.length : 0 };
            }
            return { path: entryPath, sha: e.sha, type: "dir" as const };
          });
          return { kind: "dir", entries };
        }
        const blob = this.blobs.get(found.sha);
        if (!blob) return { kind: "not-found" };
        return {
          kind: "file",
          sha: found.sha,
          text: blob.text,
          bytes: blob.bytes ?? utf8Bytes(blob.text),
          path: currentPath,
        };
      }
      if (found.type !== "tree") return { kind: "not-found" };
      treeSha = found.sha;
    }
    // Root directory listing.
    const tree = this.trees.get(treeSha);
    const entries = (tree?.tree ?? []).map((e) => {
      if (e.type === "blob") {
        const bytes = this.blobBytes(e.sha);
        return { path: e.path, sha: e.sha, type: "file" as const, size: bytes ? bytes.length : 0 };
      }
      return { path: e.path, sha: e.sha, type: "dir" as const };
    });
    return { kind: "dir", entries };
  }
}

interface FetchRecorder {
  urls: string[];
}

function createFakeFetch(gh: FakeGitHub, recorder: FetchRecorder): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    recorder.urls.push(url.toString());
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const json = (status: number, body: unknown, headers?: Record<string, string>) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;

    // GET /repos/{owner}/{repo}/git/ref/heads/{branch...}
    let m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/);
    if (m && method === "GET") {
      const branch = decodeURIComponent(m[3] as string);
      const sha = gh.refs.get(`heads/${branch}`);
      if (!sha) return json(404, { message: "Not Found" });
      return json(200, { object: { sha, type: "commit" } });
    }

    // PATCH /repos/{owner}/{repo}/git/refs/heads/{branch...}
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/);
    if (m && method === "PATCH") {
      const branch = decodeURIComponent(m[3] as string);
      const key = `heads/${branch}`;
      const current = gh.refs.get(key);
      const newSha = body?.sha as string;
      const commit = gh.commits.get(newSha);
      if (!commit) return json(422, { message: "Object does not exist" });
      if (!current || commit.parents[0] !== current) {
        return json(422, { message: "Update is not a fast forward" });
      }
      gh.refs.set(key, newSha);
      return json(200, { object: { sha: newSha, type: "commit" } });
    }

    // GET /repos/{owner}/{repo}/git/commits/{sha}
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([^/]+)$/);
    if (m && method === "GET") {
      const commit = gh.commits.get(m[3] as string);
      if (!commit) return json(404, { message: "Not Found" });
      return json(200, { sha: commit.sha, tree: { sha: commit.tree }, parents: commit.parents, message: commit.message });
    }

    // POST /repos/{owner}/{repo}/git/commits
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/);
    if (m && method === "POST") {
      const sha = gh.nextSha("commit");
      const parents = (body?.parents as string[] | undefined) ?? [];
      const tree = body?.tree as string;
      const message = body?.message as string;
      gh.commits.set(sha, { sha, tree, parents, message });
      return json(201, { sha });
    }

    // GET /repos/{owner}/{repo}/git/trees/{sha}
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/);
    if (m && method === "GET") {
      const tree = gh.trees.get(m[3] as string);
      if (!tree) return json(404, { message: "Not Found" });
      return json(200, { sha: tree.sha, tree: tree.tree });
    }

    // POST /repos/{owner}/{repo}/git/trees
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/);
    if (m && method === "POST") {
      const baseTree = body?.base_tree as string;
      const changes = (body?.tree as FakeTreeEntry[]) ?? [];
      const sha = gh.createTreeWithChanges(baseTree, changes);
      return json(201, { sha });
    }

    // GET /repos/{owner}/{repo}/git/blobs/{sha}
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/);
    if (m && method === "GET") {
      const sha = decodeURIComponent(m[3] as string);
      const bytes = gh.blobBytes(sha);
      if (bytes === null) return json(404, { message: "Not Found" });
      return json(200, {
        sha,
        size: bytes.length,
        encoding: "base64",
        content: bytesToBase64(bytes),
      });
    }

    // POST /repos/{owner}/{repo}/git/blobs
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/);
    if (m && method === "POST") {
      const content = body?.content as string;
      const sha = gh.nextSha("blob");
      gh.blobs.set(sha, { sha, text: content });
      return json(201, { sha });
    }

    // GET /repos/{owner}/{repo}/commits (list, walking parents)
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/commits$/);
    if (m && method === "GET") {
      const branch = url.searchParams.get("sha") ?? BRANCH;
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const items: GitHubCommitListItemLike[] = [];
      let cursor = gh.refs.get(`heads/${branch}`);
      while (cursor && items.length < perPage) {
        const commit = gh.commits.get(cursor);
        if (!commit) break;
        items.push({ sha: commit.sha, commit: { message: commit.message } });
        cursor = commit.parents[0];
      }
      return json(200, items);
    }

    // GET /user
    if (path === "/user" && method === "GET") {
      return json(200, { login: gh.userLogin });
    }

    // GET /repos/{owner}/{repo}/contents or /contents/{path...}
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/contents(\/(.*))?$/);
    if (m && method === "GET") {
      const subPath = m[4] ? decodeURIComponent(m[4]) : "";
      const ref = url.searchParams.get("ref");
      if (!ref) return json(422, { message: "ref is required" });
      const override = gh.contentsOverrides.get(subPath);
      if (override) {
        return json(200, {
          path: subPath,
          sha: override.sha ?? gh.nextSha("blob"),
          size: override.size,
          type: "file",
          encoding: override.encoding,
          content: override.content,
        });
      }
      const resolved = gh.resolveContents(ref, subPath);
      if (resolved.kind === "not-found") return json(404, { message: "Not Found" });
      if (resolved.kind === "dir") {
        return json(
          200,
          resolved.entries.map((e) => ({
            path: e.path,
            sha: e.sha,
            type: e.type,
            size: e.type === "file" ? e.size : 0,
          })),
        );
      }
      const bytes = resolved.bytes;
      return json(200, {
        path: resolved.path,
        sha: resolved.sha,
        size: bytes.length,
        type: "file",
        encoding: "base64",
        content: bytesToBase64(bytes),
      });
    }

    return json(404, { message: `no fake route for ${method} ${path}` });
  }) as typeof fetch;
}

interface GitHubCommitListItemLike {
  sha: string;
  commit: { message: string };
}

function makeAdapter(gh: FakeGitHub, recorder: FetchRecorder, overrides: Partial<{ token: string }> = {}) {
  return new GitHubAdapter({
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    token: overrides.token ?? TOKEN,
    fetch: createFakeFetch(gh, recorder),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubAdapter", () => {
  it("trims a pasted token and rejects one with inner whitespace before sending anything", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({ "docs/a.md": "# A\n" });
    const recorder: FetchRecorder = { urls: [] };
    const seenAuth: string[] = [];
    const inner = createFakeFetch(gh, recorder);
    const spying: typeof fetch = (input, init) => {
      seenAuth.push(String((init?.headers as Record<string, string>)["Authorization"]));
      return inner(input, init);
    };
    const trimmed = new GitHubAdapter({ owner: OWNER, repo: REPO, branch: BRANCH, token: `  ${TOKEN}\n`, fetch: spying });
    await expect(trimmed.head()).resolves.toBe(sha);
    expect(seenAuth).toEqual([`Bearer ${TOKEN}`]);

    const broken = makeAdapter(gh, recorder, { token: "ghp_abc def" });
    const before = recorder.urls.length;
    await expect(broken.head()).rejects.toMatchObject({ kind: "auth" });
    expect(recorder.urls.length).toBe(before);
  });

  it("calls the global fetch without an instance receiver (browsers throw Illegal invocation otherwise)", async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    // Emulate window.fetch: reject any call whose receiver is not the global object.
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis && this !== undefined) throw new TypeError("Illegal invocation");
      calls.push(input);
      return Promise.resolve(new Response(JSON.stringify({ object: { sha: "a".repeat(40), type: "commit" } }), { status: 200 }));
    } as typeof fetch;
    try {
      const adapter = new GitHubAdapter({ owner: OWNER, repo: REPO, branch: BRANCH, token: TOKEN });
      await expect(adapter.head()).resolves.toBe("a".repeat(40));
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("head() resolves the branch tip sha", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({ "README.md": "hello" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    await expect(adapter.head()).resolves.toBe(sha);
  });

  it("list() maps entries, sorted dirs first then files by path", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({
      "b.md": "b",
      "a.md": "a",
      "docs/z.md": "z",
      "docs/a.md": "a",
    });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    const entries = await adapter.list("", sha);
    expect(entries.map((e) => [e.kind, e.path])).toEqual([
      ["dir", "docs"],
      ["file", "a.md"],
      ["file", "b.md"],
    ]);
    const file = entries.find((e) => e.path === "a.md");
    expect(file?.blobId).toBeTruthy();
    expect(file?.size).toBe(1);

    const nested = await adapter.list("docs", sha);
    expect(nested.map((e) => e.path)).toEqual(["docs/a.md", "docs/z.md"]);
  });

  it("read() preserves a BOM as U+FEFF and returns null for missing files", async () => {
    const gh = new FakeGitHub();
    const withBom = "\uFEFFhello";
    const sha = gh.seedRepo({ "with-bom.md": withBom, "plain.md": "world" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    const snapshot = await adapter.read(["with-bom.md", "plain.md", "missing.md"], sha);
    expect(snapshot.revision).toBe(sha);
    expect(snapshot.files["with-bom.md"]?.text).toBe(withBom);
    expect(snapshot.files["with-bom.md"]?.text.codePointAt(0)).toBe(0xfeff);
    expect(snapshot.files["plain.md"]?.text).toBe("world");
    expect(snapshot.files["missing.md"]).toBeNull();
  });

  it("read() defaults to the branch head when no revision is given", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({ "a.md": "content" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    const snapshot = await adapter.read(["a.md"]);
    expect(snapshot.revision).toBe(sha);
  });

  it("read() throws too-large for files over the 1 MiB limit", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({ "small.md": "x" });
    gh.overridePath("big.md", { size: 2 * 1024 * 1024, encoding: "base64", content: "" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    await expect(adapter.read(["big.md"], sha)).rejects.toMatchObject({ kind: "too-large" });
  });

  it("read() throws too-large when encoding is not base64", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({ "small.md": "x" });
    gh.overridePath("huge.md", { size: 500, encoding: "none", content: "" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    await expect(adapter.read(["huge.md"], sha)).rejects.toMatchObject({ kind: "too-large" });
  });

  it("read() throws validation when the path is a directory", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({ "docs/a.md": "a" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    await expect(adapter.read(["docs"], sha)).rejects.toMatchObject({ kind: "validation" });
  });

  it("readBlob() round-trips binary bytes, including 0x00 and 0xFF", async () => {
    const gh = new FakeGitHub();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe, 0xfd,
      0x00, 0xff, 0x7f, 0x80, 0x01,
    ]);
    const sha = gh.seedRepo({ "img/a.png": png, "a.md": "a" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    const blob = await adapter.readBlob("img/a.png", sha);
    expect(blob).not.toBeNull();
    expect(Array.from(blob!.bytes)).toEqual(Array.from(png));
    expect(blob!.blobId).toBeTruthy();
    // Small files are served inline by the Contents API; no blobs request needed.
    expect(recorder.urls.some((u) => u.includes("/git/blobs/"))).toBe(false);
  });

  it("readBlob() falls back to the blobs endpoint when the Contents API reports encoding none", async () => {
    const gh = new FakeGitHub();
    const big = new Uint8Array(300);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    const sha = gh.seedRepo({ "img/big.png": big });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    // Find the blob sha the seeded tree used, then make Contents report it as
    // too big to inline, exactly as GitHub does above 1 MiB.
    const listed = await adapter.list("img", sha);
    const blobId = listed[0]?.blobId as string;
    gh.overridePath("img/big.png", {
      size: 2 * 1024 * 1024,
      encoding: "none",
      content: "",
      sha: blobId,
    });

    const blob = await adapter.readBlob("img/big.png", sha);
    expect(blob).not.toBeNull();
    expect(Array.from(blob!.bytes)).toEqual(Array.from(big));
    expect(blob!.blobId).toBe(blobId);
    expect(recorder.urls.some((u) => u.includes(`/git/blobs/${blobId}`))).toBe(true);
  });

  it("readBlob() returns null for a path that does not exist at the revision", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({ "a.md": "a" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    expect(await adapter.readBlob("img/missing.png", sha)).toBeNull();
  });

  it("readBlob() throws too-large past the 20 MiB cap", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedRepo({ "a.md": "a" });
    gh.overridePath("img/huge.png", {
      size: 21 * 1024 * 1024,
      encoding: "none",
      content: "",
    });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    await expect(adapter.readBlob("img/huge.png", sha)).rejects.toMatchObject({
      kind: "too-large",
    });
    // The oversized blob is never downloaded.
    expect(recorder.urls.some((u) => u.includes("/git/blobs/"))).toBe(false);
  });

  it("commit() happy path: parent is base, ref moves, unrelated files preserved", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "a.md": "a-content", "b.md": "b-content" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    const snapshot = await adapter.read(["a.md"], base);
    const batchId = "11111111-1111-1111-1111-111111111111";
    const result = await adapter.commit({
      base: { revision: base, files: snapshot.files },
      changes: [{ path: "a.md", text: "a-updated" }],
      batchId,
      message: formatCommitMessage("Add a comment", batchId),
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.localReflection).toBe("not-applicable");

    const newSha = result.commitId;
    const newCommit = gh.commits.get(newSha);
    expect(newCommit?.parents).toEqual([base]);
    expect(gh.refs.get(`heads/${BRANCH}`)).toBe(newSha);

    // Unrelated file b.md must still be present and unchanged; a.md updated.
    const after = await adapter.read(["a.md", "b.md"], newSha);
    expect(after.files["a.md"]?.text).toBe("a-updated");
    expect(after.files["b.md"]?.text).toBe("b-content");
  });

  it("commit() throws conflict when the ref already moved before the call", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "a.md": "a-content" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);
    // Someone else commits after we "read" base, moving the branch tip.
    gh.seedRepo({ "a.md": "someone-else-edited" });

    const batchId = "22222222-2222-2222-2222-222222222222";
    await expect(
      adapter.commit({
        base: { revision: base, files: { "a.md": { text: "a-content", blobId: "x" } } },
        changes: [{ path: "a.md", text: "my-edit" }],
        batchId,
        message: formatCommitMessage("Edit", batchId),
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("commit() throws conflict when the ref update PATCH is rejected (422)", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "a.md": "a-content" });
    const recorder: FetchRecorder = { urls: [] };

    // Both of the adapter's own client-side ref checks (step 1 and step 7)
    // see the unmoved base revision; only the actual PATCH call itself is
    // rejected by GitHub with 422 (e.g. a protected-branch rule or a race
    // the two client-side checks didn't happen to catch).
    const inner = createFakeFetch(gh, recorder);
    const patchRejected: typeof fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (init?.method === "PATCH" && /\/git\/refs\/heads\//.test(url.pathname)) {
        return new Response(JSON.stringify({ message: "Update is not a fast forward" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
      return inner(input, init);
    }) as typeof fetch;

    const adapter = new GitHubAdapter({ owner: OWNER, repo: REPO, branch: BRANCH, token: TOKEN, fetch: patchRejected });

    const batchId = "33333333-3333-3333-3333-333333333333";
    await expect(
      adapter.commit({
        base: { revision: base, files: { "a.md": { text: "a-content", blobId: "x" } } },
        changes: [{ path: "a.md", text: "my-edit" }],
        batchId,
        message: formatCommitMessage("Edit", batchId),
      }),
    ).rejects.toMatchObject({ kind: "conflict" });

    // The branch ref must not have moved.
    expect(gh.refs.get(`heads/${BRANCH}`)).toBe(base);
  });

  it.each([
    [502, "Bad gateway"],
    [429, "Too many requests"],
    [408, "Request timeout"],
  ])(
    "commit() returns unknown when the ref PATCH answers %i (no definite conflict)",
    async (status, message) => {
      const gh = new FakeGitHub();
      const base = gh.seedRepo({ "a.md": "a-content" });
      const recorder: FetchRecorder = { urls: [] };
      const inner = createFakeFetch(gh, recorder);
      const failing: typeof fetch = (async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        if (init?.method === "PATCH" && /\/git\/refs\/heads\//.test(url.pathname)) {
          return new Response(JSON.stringify({ message }), {
            status,
            headers: { "content-type": "application/json" },
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      const adapter = new GitHubAdapter({
        owner: OWNER,
        repo: REPO,
        branch: BRANCH,
        token: TOKEN,
        fetch: failing,
      });

      const batchId = "4a4a4a4a-4b4b-4c4c-4d4d-4e4e4e4e4e4e";
      const result = await adapter.commit({
        base: { revision: base, files: { "a.md": { text: "a-content", blobId: "x" } } },
        changes: [{ path: "a.md", text: "my-edit" }],
        batchId,
        message: formatCommitMessage("Edit", batchId),
      });

      // DESIGN.md 7: ref 更新結果が不明なら unknown - never an error, so the
      // caller confirms the batch trailer instead of committing again.
      expect(result).toMatchObject({ status: "unknown", batchId });
      if (result.status !== "unknown") throw new Error("unreachable");
      expect(gh.commits.get(result.candidateCommitId as string)).toBeTruthy();
    },
  );

  it("commit() still throws for a definite 401 / 403 on the ref PATCH", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [403, "permission"],
    ] as const) {
      const gh = new FakeGitHub();
      const base = gh.seedRepo({ "a.md": "a-content" });
      const recorder: FetchRecorder = { urls: [] };
      const inner = createFakeFetch(gh, recorder);
      const failing: typeof fetch = (async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        if (init?.method === "PATCH" && /\/git\/refs\/heads\//.test(url.pathname)) {
          return new Response(JSON.stringify({ message: "nope" }), {
            status,
            headers: { "content-type": "application/json", "x-ratelimit-remaining": "42" },
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      const adapter = new GitHubAdapter({
        owner: OWNER,
        repo: REPO,
        branch: BRANCH,
        token: TOKEN,
        fetch: failing,
      });
      const batchId = "4f4f4f4f-4f4f-4f4f-4f4f-4f4f4f4f4f4f";
      await expect(
        adapter.commit({
          base: { revision: base, files: { "a.md": { text: "a-content", blobId: "x" } } },
          changes: [{ path: "a.md", text: "my-edit" }],
          batchId,
          message: formatCommitMessage("Edit", batchId),
        }),
      ).rejects.toMatchObject({ kind });
      expect(gh.refs.get(`heads/${BRANCH}`)).toBe(base);
    }
  });

  it("commit() returns an unknown result when the ref-update fetch throws", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "a.md": "a-content" });
    const recorder: FetchRecorder = { urls: [] };
    const inner = createFakeFetch(gh, recorder);
    const flaky: typeof fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (init?.method === "PATCH" && /\/git\/refs\/heads\//.test(url.pathname)) {
        throw new TypeError("network down");
      }
      return inner(input, init);
    }) as typeof fetch;

    const adapter = new GitHubAdapter({ owner: OWNER, repo: REPO, branch: BRANCH, token: TOKEN, fetch: flaky });

    const batchId = "44444444-4444-4444-4444-444444444444";
    const result = await adapter.commit({
      base: { revision: base, files: { "a.md": { text: "a-content", blobId: "x" } } },
      changes: [{ path: "a.md", text: "my-edit" }],
      batchId,
      message: formatCommitMessage("Edit", batchId),
    });

    expect(result).toMatchObject({ status: "unknown", batchId });
    if (result.status !== "unknown") throw new Error("unreachable");
    expect(result.candidateCommitId).toBeTruthy();
    // The commit really was created server-side, just not published to the ref.
    expect(gh.commits.get(result.candidateCommitId as string)).toBeTruthy();
    expect(gh.refs.get(`heads/${BRANCH}`)).toBe(base);
  });

  it("commit() refuses to overwrite a path that exists in the base tree but was not read", async () => {
    const gh = new FakeGitHub();
    const logPath = "reviews/docs/a/20260907T001200Z-old.md";
    const base = gh.seedRepo({ "docs/a.md": "a-content", [logPath]: "an earlier review log" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    const batchId = "88888888-8888-8888-8888-888888888888";
    // A strip that reuses an existing log path: base.files never mentions it,
    // so the adapter must treat it as a new-file intent and refuse.
    await expect(
      adapter.commit({
        base: { revision: base, files: { "docs/a.md": { text: "a-content", blobId: "x" } } },
        changes: [
          { path: "docs/a.md", text: "stripped" },
          { path: logPath, text: "a new review log" },
        ],
        batchId,
        message: formatCommitMessage("Strip", batchId),
      }),
    ).rejects.toMatchObject({ kind: "validation" });

    // Nothing was published and the existing log is untouched.
    expect(gh.refs.get(`heads/${BRANCH}`)).toBe(base);
    const after = await adapter.read([logPath], base);
    expect(after.files[logPath]?.text).toBe("an earlier review log");

    // A base that claims the path is absent is refused for the same reason.
    await expect(
      adapter.commit({
        base: { revision: base, files: { [logPath]: null } },
        changes: [{ path: logPath, text: "a new review log" }],
        batchId,
        message: formatCommitMessage("Strip", batchId),
      }),
    ).rejects.toMatchObject({ kind: "validation" });

    // Reading it first (an ordinary update) is still allowed.
    const read = await adapter.read(["docs/a.md", logPath], base);
    const ok = await adapter.commit({
      base: read,
      changes: [{ path: logPath, text: "an edited review log" }],
      batchId,
      message: formatCommitMessage("Edit the log", batchId),
    });
    expect(ok.status).toBe("committed");
  });

  it("commit() creates a brand-new log path that is absent from the base tree", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "docs/a.md": "a-content" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);
    const batchId = "89898989-8989-8989-8989-898989898989";
    const logPath = "reviews/docs/a/20260907T001200Z-new.md";

    const result = await adapter.commit({
      base: { revision: base, files: { "docs/a.md": { text: "a-content", blobId: "x" } } },
      changes: [
        { path: "docs/a.md", text: "stripped" },
        { path: logPath, text: "log" },
      ],
      batchId,
      message: formatCommitMessage("Strip", batchId),
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    const after = await adapter.read([logPath], result.commitId);
    expect(after.files[logPath]?.text).toBe("log");
  });

  it("commit() rejects a change over the 1 MiB limit before creating any blob", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "a.md": "a-content" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);
    const batchId = "99999999-9999-9999-9999-999999999999";

    // Just over 1 MiB once encoded as UTF-8 (3 bytes per character here).
    const tooBig = "あ".repeat(350_000);
    expect(new TextEncoder().encode(tooBig).byteLength).toBeGreaterThan(1024 * 1024);

    await expect(
      adapter.commit({
        base: { revision: base, files: { "a.md": { text: "a-content", blobId: "x" } } },
        changes: [{ path: "a.md", text: tooBig }],
        batchId,
        message: formatCommitMessage("Edit", batchId),
      }),
    ).rejects.toMatchObject({ kind: "too-large" });

    // No blob, tree or commit was created, and the ref did not move.
    expect(recorder.urls.some((u) => /\/git\/(blobs|trees|commits)$/.test(new URL(u).pathname))).toBe(
      false,
    );
    expect(gh.refs.get(`heads/${BRANCH}`)).toBe(base);

    // A body just under the limit still commits.
    const justUnder = "a".repeat(1024 * 1024);
    const ok = await adapter.commit({
      base: { revision: base, files: { "a.md": { text: "a-content", blobId: "x" } } },
      changes: [{ path: "a.md", text: justUnder }],
      batchId,
      message: formatCommitMessage("Edit", batchId),
    });
    expect(ok.status).toBe("committed");
  });

  it("commit() preserves the file mode of an existing path", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "script.sh": "#!/bin/sh\necho hi" });
    // Force an executable mode on the seeded blob.
    const rootTree = gh.trees.get(gh.commits.get(base)!.tree)!;
    const entry = rootTree.tree.find((e) => e.path === "script.sh")!;
    entry.mode = "100755";

    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);
    const batchId = "55555555-5555-5555-5555-555555555555";
    const result = await adapter.commit({
      base: { revision: base, files: { "script.sh": { text: "old", blobId: "x" } } },
      changes: [{ path: "script.sh", text: "#!/bin/sh\necho updated" }],
      batchId,
      message: formatCommitMessage("Edit", batchId),
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    const newCommit = gh.commits.get(result.commitId)!;
    const newTree = gh.trees.get(newCommit.tree)!;
    const newEntry = newTree.tree.find((e) => e.path === "script.sh")!;
    expect(newEntry.mode).toBe("100755");
  });

  it("findBatchCommit() locates the commit carrying the trailer", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "a.md": "a" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    const batchId = "66666666-6666-6666-6666-666666666666";
    const result = await adapter.commit({
      base: { revision: base, files: { "a.md": { text: "a", blobId: "x" } } },
      changes: [{ path: "a.md", text: "a-2" }],
      batchId,
      message: formatCommitMessage("Edit", batchId),
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");

    await expect(adapter.findBatchCommit(batchId)).resolves.toBe(result.commitId);
    await expect(adapter.findBatchCommit("00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
  });

  it("currentUserLogin() returns the authenticated user's login", async () => {
    const gh = new FakeGitHub();
    gh.userLogin = "havealinch";
    gh.seedRepo({ "a.md": "a" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    await expect(adapter.currentUserLogin()).resolves.toBe("havealinch");
  });

  it("maps 401 to an auth AdapterError", async () => {
    const recorder: FetchRecorder = { urls: [] };
    const unauthorized: typeof fetch = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const adapter = new GitHubAdapter({ owner: OWNER, repo: REPO, branch: BRANCH, token: TOKEN, fetch: unauthorized });

    await expect(adapter.head()).rejects.toMatchObject({ kind: "auth" });
  });

  it("maps 403 with rate-limit headers to a rate-limit AdapterError, and other 403s to permission", async () => {
    const rateLimited: typeof fetch = (async () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
      })) as typeof fetch;
    const adapterRateLimited = new GitHubAdapter({ owner: OWNER, repo: REPO, branch: BRANCH, token: TOKEN, fetch: rateLimited });
    await expect(adapterRateLimited.head()).rejects.toMatchObject({ kind: "rate-limit" });

    const forbidden: typeof fetch = (async () =>
      new Response(JSON.stringify({ message: "Resource protected" }), {
        status: 403,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "42" },
      })) as typeof fetch;
    const adapterForbidden = new GitHubAdapter({ owner: OWNER, repo: REPO, branch: BRANCH, token: TOKEN, fetch: forbidden });
    await expect(adapterForbidden.head()).rejects.toMatchObject({ kind: "permission" });
  });

  it("never puts the token in a request URL or in a thrown error message", async () => {
    const gh = new FakeGitHub();
    const base = gh.seedRepo({ "a.md": "a-content", "docs/b.md": "b" });
    const recorder: FetchRecorder = { urls: [] };
    const adapter = makeAdapter(gh, recorder);

    await adapter.head();
    await adapter.list("", base);
    await adapter.read(["a.md", "missing.md"], base);
    await adapter.currentUserLogin();
    const batchId = "77777777-7777-7777-7777-777777777777";
    await adapter.commit({
      base: { revision: base, files: { "a.md": { text: "a-content", blobId: "x" } } },
      changes: [{ path: "a.md", text: "a-content-2" }],
      batchId,
      message: formatCommitMessage("Edit", batchId),
    });
    await adapter.findBatchCommit(batchId);

    expect(recorder.urls.length).toBeGreaterThan(0);
    for (const url of recorder.urls) {
      expect(url).not.toContain(TOKEN);
    }

    // And error paths: the adapter's own error messages never embed the
    // token - they only ever include GitHub's `message` field verbatim.
    let caught: unknown;
    try {
      const unauthorized: typeof fetch = (async () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const badAdapter = new GitHubAdapter({ owner: OWNER, repo: REPO, branch: BRANCH, token: TOKEN, fetch: unauthorized });
      await badAdapter.head();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).message).not.toContain(TOKEN);
  });
});
