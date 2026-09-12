/**
 * Local host layer — DESIGN.md 7.2 の末尾:
 * "ローカル実行層は loopback のみに bind し、同一 origin と起動ごとのセッション
 *  トークンを検証する。汎用シェル実行 API を公開せず、引数を構造化して Git を
 *  起動する。外部サイトからローカルファイルや Git を操作できない境界を持たせる。"
 *
 * Only `node:http`; no framework, no CORS headers, no shell.
 */

import { AdapterError, type AdapterErrorKind } from "@syuire/core";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalGitAdapter } from "./local-git-adapter.js";
import { redactDetails, redactText } from "./redact.js";

export interface StartServerOptions {
  repoPath: string;
  port?: number;
  webDist?: string;
}

export interface RunningServer {
  url: string;
  token: string;
  port: number;
  adapter: LocalGitAdapter;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024; // 8 MiB

const STATUS_BY_KIND: Record<AdapterErrorKind, number> = {
  conflict: 409,
  auth: 401,
  permission: 403,
  "not-found": 404,
  "too-large": 413,
  "rate-limit": 429,
  validation: 400,
  "worktree-dirty": 409,
  "worktree-recovery": 409,
  "commit-failed": 409,
  "repo-state": 409,
  network: 502,
  internal: 500,
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>syuire</title>
<style>body{font:14px system-ui,sans-serif;margin:3rem auto;max-width:40rem;line-height:1.6}</style>
</head><body>
<h1>syuire</h1>
<p>The web bundle is not built. Run <code>npm run build -w @syuire/web</code> and reload.</p>
<p>The local API is running; keep the token from the launcher output.</p>
</body></html>
`;

function defaultWebDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../web/dist");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0] ?? null;
  return null;
}

interface Guard {
  ok: boolean;
  status: number;
  message: string;
}

function checkApiRequest(req: http.IncomingMessage, port: number, token: string): Guard {
  const host = headerValue(req, "host");
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (host === null || !allowedHosts.includes(host)) {
    return { ok: false, status: 403, message: "unexpected Host header" };
  }
  const origin = headerValue(req, "origin");
  if (origin !== null && origin !== "null") {
    const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    if (!allowedOrigins.includes(origin)) {
      return { ok: false, status: 403, message: "unexpected Origin header" };
    }
  }
  const site = headerValue(req, "sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return { ok: false, status: 403, message: "cross-site request" };
  }
  const auth = headerValue(req, "authorization");
  if (auth === null || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7).trim(), token)) {
    return { ok: false, status: 403, message: "missing or invalid session token" };
  }
  return { ok: true, status: 200, message: "" };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body ?? null), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}

/**
 * Error responses are the one place where raw Git output leaves the host
 * layer, so every string on the way out is redacted and length-capped
 * (DESIGN.md 8: credentials are never copied by the app).
 */
function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof AdapterError) {
    const status = STATUS_BY_KIND[err.kind] ?? 500;
    sendJson(res, status, {
      error: {
        kind: err.kind,
        message: redactText(err.message),
        details: err.details === undefined ? null : redactDetails(err.details),
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { kind: "internal", message: redactText(message) } });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_BODY) {
      throw new AdapterError("too-large", "request body exceeds 8 MiB");
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AdapterError("validation", "request body is not valid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterError("validation", "expected a JSON object body");
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new AdapterError("validation", `${what} must be an array of strings`);
  }
  return value as string[];
}

async function handleApi(
  adapter: LocalGitAdapter,
  method: string,
  pathname: string,
  url: URL,
  req: http.IncomingMessage,
): Promise<unknown> {
  const route = `${method} ${pathname}`;
  switch (route) {
    case "GET /api/info":
      return adapter.info();
    case "GET /api/sync":
      return adapter.sync();
    case "POST /api/fetch":
      return adapter.fetch();
    case "POST /api/pull":
      return adapter.pull();
    case "POST /api/push":
      return adapter.push();
    case "GET /api/list": {
      const dir = url.searchParams.get("dir") ?? "";
      const revision = url.searchParams.get("revision");
      const rev = revision ?? (await adapter.head());
      return { revision: rev, entries: await adapter.list(dir, rev) };
    }
    case "GET /api/head":
      return { head: await adapter.head() };
    case "POST /api/read": {
      const body = asRecord(await readJsonBody(req));
      const paths = asStringArray(body["paths"], "paths");
      const revision = body["revision"];
      if (revision === undefined || revision === null) return adapter.read(paths);
      if (typeof revision !== "string") {
        throw new AdapterError("validation", "revision must be a string");
      }
      return adapter.read(paths, revision);
    }
    case "POST /api/commit": {
      const body = asRecord(await readJsonBody(req));
      const base = body["base"];
      const changes = body["changes"];
      const batchId = body["batchId"];
      const message = body["message"];
      if (base === null || typeof base !== "object") {
        throw new AdapterError("validation", "base must be a Snapshot");
      }
      if (!Array.isArray(changes)) {
        throw new AdapterError("validation", "changes must be an array");
      }
      if (typeof batchId !== "string" || typeof message !== "string") {
        throw new AdapterError("validation", "batchId and message must be strings");
      }
      const snapshot = base as { revision: unknown; files: unknown };
      if (typeof snapshot.revision !== "string" || snapshot.files === null || typeof snapshot.files !== "object") {
        throw new AdapterError("validation", "base must have a revision and files");
      }
      for (const change of changes) {
        if (
          change === null ||
          typeof change !== "object" ||
          typeof (change as { path?: unknown }).path !== "string" ||
          typeof (change as { text?: unknown }).text !== "string"
        ) {
          throw new AdapterError("validation", "each change needs a string path and text");
        }
      }
      return adapter.commit({
        base: base as { revision: string; files: Record<string, { text: string; blobId: string } | null> },
        changes: changes as Array<{ path: string; text: string }>,
        batchId,
        message,
      });
    }
    case "GET /api/recovery":
      return { recovery: await adapter.recovery() };
    case "POST /api/recovery/cancel":
      return { recovery: await adapter.cancelPrepared() };
    case "POST /api/recovery/resolve-unknown":
      return adapter.resolveUnknown();
    case "POST /api/recovery/clear":
      return { recovery: await adapter.clearRecovery() };
    case "GET /api/batch": {
      const batchId = url.searchParams.get("batchId");
      if (batchId === null) throw new AdapterError("validation", "batchId is required");
      return { commitId: await adapter.findBatchCommit(batchId) };
    }
    default:
      throw new AdapterError("not-found", `no such route: ${route}`);
  }
}

/**
 * GET /api/blob?path=&revision= — raw bytes of one repository file at one
 * revision (DESIGN.md 6). Never text-decoded, never cached, always served as
 * an opaque octet stream so the browser cannot be talked into sniffing it into
 * an active type.
 */
async function handleBlob(
  adapter: LocalGitAdapter,
  url: URL,
  res: http.ServerResponse,
  method: string,
): Promise<void> {
  const repoPath = url.searchParams.get("path");
  if (repoPath === null || repoPath === "") {
    throw new AdapterError("validation", "path is required");
  }
  const revision = url.searchParams.get("revision");
  const rev = revision !== null && revision !== "" ? revision : await adapter.head();
  const blob = await adapter.readBlob(repoPath, rev);
  if (blob === null) {
    throw new AdapterError("not-found", `no such file at ${rev}: ${repoPath}`);
  }
  const payload = Buffer.from(blob.bytes.buffer, blob.bytes.byteOffset, blob.bytes.byteLength);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-disposition": "attachment",
    etag: `"${blob.blobId}"`,
  });
  if (method === "HEAD") res.end();
  else res.end(payload);
}

async function statFile(p: string): Promise<{ size: number } | null> {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? { size: st.size } : null;
  } catch {
    return null;
  }
}

async function serveStatic(
  res: http.ServerResponse,
  webDist: string,
  pathname: string,
  method: string,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    res.end("method not allowed");
    return;
  }
  const root = path.resolve(webDist);
  const distExists = await fs
    .stat(root)
    .then((s) => s.isDirectory())
    .catch(() => false);

  const sendHtml = (status: number, html: string): void => {
    const payload = Buffer.from(html, "utf8");
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(payload.length),
      "x-content-type-options": "nosniff",
    });
    if (method === "HEAD") res.end();
    else res.end(payload);
  };

  if (!distExists) {
    sendHtml(200, PLACEHOLDER_HTML);
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }
  if (decoded.includes("\0")) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }

  const relative = decoded.replace(/^\/+/, "");
  const candidate = relative === "" ? path.join(root, "index.html") : path.resolve(root, relative);
  const inside = candidate === root || candidate.startsWith(root + path.sep);
  const indexPath = path.join(root, "index.html");

  const serveFile = async (file: string): Promise<boolean> => {
    const st = await statFile(file);
    if (st === null) return false;
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": String(st.size),
      "x-content-type-options": "nosniff",
    });
    if (method === "HEAD") {
      res.end();
      return true;
    }
    res.end(await fs.readFile(file));
    return true;
  };

  if (inside && (await serveFile(candidate))) return;
  // SPA fallback for extension-less routes only.
  if (inside && path.extname(candidate) === "" && (await serveFile(indexPath))) return;
  if (relative === "" && (await serveFile(indexPath))) return;
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const adapter = await LocalGitAdapter.open(options.repoPath);
  const token = randomBytes(32).toString("base64url");
  const webDist = options.webDist ?? defaultWebDist();

  let boundPort = options.port ?? 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? "/";
        const url = new URL(rawUrl, `http://127.0.0.1:${boundPort}`);
        const pathname = url.pathname;
        const method = (req.method ?? "GET").toUpperCase();

        if (pathname === "/api" || pathname.startsWith("/api/")) {
          const guard = checkApiRequest(req, boundPort, token);
          if (!guard.ok) {
            sendJson(res, guard.status, {
              error: { kind: "permission", message: guard.message, details: null },
            });
            return;
          }
          if (pathname === "/api/blob" && (method === "GET" || method === "HEAD")) {
            await handleBlob(adapter, url, res, method);
            return;
          }
          const body = await handleApi(adapter, method, pathname, url, req);
          sendJson(res, 200, body);
          return;
        }
        await serveStatic(res, webDist, pathname, method);
      } catch (err) {
        if (!res.headersSent) sendError(res, err);
        else res.end();
      }
    })();
  });

  server.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new AdapterError("internal", "the local server did not bind to a TCP port");
  }
  boundPort = address.port;

  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    url: `http://127.0.0.1:${boundPort}`,
    token,
    port: boundPort,
    adapter,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
