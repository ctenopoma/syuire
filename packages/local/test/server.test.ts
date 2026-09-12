import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";
import { git, makeFixture } from "./helpers.js";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  raw: Buffer;
}

function request(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw.toString("utf8"),
            raw,
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

let running: RunningServer | null = null;

afterEach(async () => {
  if (running !== null) {
    await running.close();
    running = null;
  }
});

describe("local host layer HTTP server", () => {
  it("rejects /api requests without the session token", async () => {
    const fx = await makeFixture();
    running = await startServer({ repoPath: fx.clone, webDist: path.join(fx.root, "no-dist") });
    const reply = await request(running.port, {
      path: "/api/info",
      headers: { host: `127.0.0.1:${running.port}` },
    });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body).error.kind).toBe("permission");
  });

  it("rejects /api requests with a wrong Host header", async () => {
    const fx = await makeFixture();
    running = await startServer({ repoPath: fx.clone, webDist: path.join(fx.root, "no-dist") });
    const reply = await request(running.port, {
      path: "/api/info",
      headers: {
        host: "attacker.example",
        authorization: `Bearer ${running.token}`,
      },
    });
    expect(reply.status).toBe(403);
    expect(reply.body).toContain("Host");
  });

  it("rejects a cross-site request even with the token", async () => {
    const fx = await makeFixture();
    running = await startServer({ repoPath: fx.clone, webDist: path.join(fx.root, "no-dist") });
    const reply = await request(running.port, {
      path: "/api/info",
      headers: {
        host: `127.0.0.1:${running.port}`,
        authorization: `Bearer ${running.token}`,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
    });
    expect(reply.status).toBe(403);
  });

  it("answers /api/info with the token", async () => {
    const fx = await makeFixture();
    running = await startServer({ repoPath: fx.clone, webDist: path.join(fx.root, "no-dist") });
    const reply = await request(running.port, {
      path: "/api/info",
      headers: {
        host: `localhost:${running.port}`,
        origin: `http://localhost:${running.port}`,
        "sec-fetch-site": "same-origin",
        authorization: `Bearer ${running.token}`,
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    const info = JSON.parse(reply.body);
    expect(info.branch).toBe("main");
    expect(info.authorName).toBe("syuire Test");
  });

  it("serves sync, list, read and rejects unsafe paths", async () => {
    const fx = await makeFixture();
    running = await startServer({ repoPath: fx.clone, webDist: path.join(fx.root, "no-dist") });
    const headers = {
      host: `127.0.0.1:${running.port}`,
      authorization: `Bearer ${running.token}`,
      "content-type": "application/json",
    };

    const sync = await request(running.port, { path: "/api/sync", headers });
    expect(sync.status).toBe(200);
    expect(JSON.parse(sync.body).state).toBe("in-sync");

    const list = await request(running.port, { path: "/api/list?dir=docs", headers });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).entries.map((e: { path: string }) => e.path)).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);

    const read = await request(running.port, {
      method: "POST",
      path: "/api/read",
      headers,
      body: JSON.stringify({ paths: ["docs/a.md"] }),
    });
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body).files["docs/a.md"].text).toContain("first paragraph");

    const unsafe = await request(running.port, {
      method: "POST",
      path: "/api/read",
      headers,
      body: JSON.stringify({ paths: ["../outside.md"] }),
    });
    expect(unsafe.status).toBe(400);
    expect(JSON.parse(unsafe.body).error.kind).toBe("validation");

    const dotGit = await request(running.port, {
      method: "POST",
      path: "/api/read",
      headers,
      body: JSON.stringify({ paths: [".git/config"] }),
    });
    expect(dotGit.status).toBe(400);
  });

  it("serves raw bytes from /api/blob and 404s for a missing path", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x0d, 0x0a, 0x7f, 0x80, 0x01,
      0x00, 0xfe, 0xff,
    ]);
    const fx = await makeFixture();
    await fx.writeBytes(fx.clone, "docs/img/a.png", png);
    await git(fx.clone, ["add", "--", "docs/img/a.png"]);
    await git(fx.clone, ["commit", "-m", "add image"]);

    running = await startServer({ repoPath: fx.clone, webDist: path.join(fx.root, "no-dist") });
    const headers = {
      host: `127.0.0.1:${running.port}`,
      authorization: `Bearer ${running.token}`,
    };
    const head = await running.adapter.head();

    const reply = await request(running.port, {
      path: `/api/blob?path=docs/img/a.png&revision=${head}`,
      headers,
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/octet-stream");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(Array.from(reply.raw)).toEqual(Array.from(png));

    const missing = await request(running.port, {
      path: `/api/blob?path=docs/img/missing.png&revision=${head}`,
      headers,
    });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error.kind).toBe("not-found");

    const unsafe = await request(running.port, {
      path: `/api/blob?path=../outside.png&revision=${head}`,
      headers,
    });
    expect(unsafe.status).toBe(400);

    const noToken = await request(running.port, {
      path: `/api/blob?path=docs/img/a.png&revision=${head}`,
      headers: { host: `127.0.0.1:${running.port}` },
    });
    expect(noToken.status).toBe(403);
  });

  it("serves a placeholder page when the web bundle is not built", async () => {
    const fx = await makeFixture();
    running = await startServer({ repoPath: fx.clone, webDist: path.join(fx.root, "no-dist") });
    const reply = await request(running.port, { path: "/", headers: {} });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("web bundle is not built");
  });

  it("serves static files and falls back to index.html without directory traversal", async () => {
    const fx = await makeFixture();
    const dist = path.join(fx.root, "dist");
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>syuire</title>app");
    await fs.writeFile(path.join(dist, "app.js"), "console.log(1)\n");
    await fs.writeFile(path.join(fx.root, "secret.txt"), "top secret\n");

    running = await startServer({ repoPath: fx.clone, webDist: dist });
    const index = await request(running.port, { path: "/" });
    expect(index.body).toContain("app");
    const js = await request(running.port, { path: "/app.js" });
    expect(js.headers["content-type"]).toContain("text/javascript");
    const spa = await request(running.port, { path: "/docs/a" });
    expect(spa.status).toBe(200);
    expect(spa.body).toContain("app");
    const traversal = await request(running.port, { path: "/../secret.txt" });
    expect(traversal.body).not.toContain("top secret");
    const encoded = await request(running.port, { path: "/%2e%2e/secret.txt" });
    expect(encoded.body).not.toContain("top secret");
  });
});
