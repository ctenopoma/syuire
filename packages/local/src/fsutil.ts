/** Raw-byte fingerprints and atomic work-tree writes. DESIGN.md 7.2. */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export function fingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readFileBytes(absPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

export async function fileFingerprint(absPath: string): Promise<string | null> {
  const bytes = await readFileBytes(absPath);
  return bytes === null ? null : fingerprint(bytes);
}

/**
 * Write `bytes` to `absPath` by writing a sibling temp file and renaming it.
 * Parent directories are created when missing.
 */
export async function writeFileAtomic(absPath: string, bytes: Uint8Array): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.syuire-${randomBytes(6).toString("hex")}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "wx");
    await handle.writeFile(bytes);
    await handle.sync().catch(() => undefined);
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, absPath);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function removeFile(absPath: string): Promise<void> {
  await fs.rm(absPath, { force: true });
}

/**
 * Convert every bare LF in `text` to CRLF, for writing DESIGN.md-5.2 content
 * into a work tree that keeps CRLF line endings. `text` is not expected to
 * contain CR (it comes from a blob, which Git stores with LF only), but an
 * existing CRLF is left untouched rather than doubled, and a lone CR is left
 * untouched rather than treated as part of an end-of-line sequence.
 */
export function convertLfToCrlf(text: string): string {
  return text.replace(/\r\n|\n/g, (m) => (m === "\n" ? "\r\n" : m));
}
