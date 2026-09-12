/**
 * LocalGitAdapter — DESIGN.md 7.2.
 *
 * Bound to one existing clone and to the branch that was checked out when the
 * adapter was opened. Saving is ordinary Git porcelain: the target files are
 * reflected into the work tree and committed with `git commit --only -- <paths>`
 * so that unrelated staged and unstaged changes survive and stay out of the
 * commit.
 *
 * Every public operation on one adapter runs through an internal promise queue,
 * because the design requires operations to be serialised per repository.
 */

import {
  AdapterError,
  extractBatchId,
  type CommitInput,
  type CommitResult,
  type Entry,
  type LocalRecoveryInfo,
  type LocalRepositoryAdapter,
  type Snapshot,
  type SyncState,
  type SyncStatus,
} from "@syuire/core";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { decodeUtf8, runGit, timeoutError, type GitResult } from "./git.js";
import { redactText } from "./redact.js";
import {
  convertLfToCrlf,
  fileFingerprint,
  fingerprint,
  readFileBytes,
  removeFile,
  writeFileAtomic,
} from "./fsutil.js";
import { resolveRepoDir, resolveRepoPath, validateRevision } from "./paths.js";
import {
  aheadBehind,
  classifyRemoteFailure,
  configValue,
  currentBranch,
  hasUnmergedEntry,
  hashObjectBytes,
  hashObjectFile,
  indexMatchesHead,
  inProgressOperation,
  isIgnored,
  isTrackedInIndex,
  lsTree,
  lsTreeDir,
  newPathWantsCrlf,
  revParse,
  upstreamRef,
  worktreeMatchesHead,
  worktreeWantsCrlf,
  type TreeEntry,
} from "./repo-queries.js";

export interface RepoInfo {
  repoRoot: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  authorName: string | null;
  authorEmail: string | null;
}

export interface ResolveUnknownResult {
  resolved: "committed-complete" | "committed-needs-recovery" | "not-committed";
  commitId?: string;
  recovery: LocalRecoveryInfo | null;
}

/** In-memory detail behind a LocalRecoveryInfo. Never persisted. */
interface PreparedPath {
  repoPath: string;
  absPath: string;
  /** Blob id of the work-tree content before preparation, null for a new file. */
  beforeBlob: string | null;
  /** Raw bytes before preparation, null for a new file. */
  beforeBytes: Buffer | null;
  /** Raw fingerprint before preparation, null for a new file. */
  beforeFingerprint: string | null;
  /** Blob id the prepared content hashes to, through .gitattributes filters. */
  afterBlob: string;
  afterBytes: Buffer;
  /** Mode the entry must have in the new tree. */
  mode: string;
  /** True when the path is not present in HEAD (a new review log). */
  isNew: boolean;
}

interface PreparedBatch {
  batchId: string;
  baseCommitId: string;
  message: string;
  paths: PreparedPath[];
}

const NEW_FILE_MODE = "100644";

function toRecoveryInfo(
  batch: PreparedBatch,
  phase: LocalRecoveryInfo["phase"],
  extra: { newCommitId?: string; reason?: string } = {},
): LocalRecoveryInfo {
  const blobs: Record<string, { before: string | null; after: string }> = {};
  for (const p of batch.paths) blobs[p.repoPath] = { before: p.beforeBlob, after: p.afterBlob };
  const info: LocalRecoveryInfo = {
    batchId: batch.batchId,
    phase,
    baseCommitId: batch.baseCommitId,
    paths: batch.paths.map((p) => p.repoPath),
    blobs,
  };
  if (extra.newCommitId !== undefined) info.newCommitId = extra.newCommitId;
  if (extra.reason !== undefined) info.reason = extra.reason;
  return info;
}

export class LocalGitAdapter implements LocalRepositoryAdapter {
  readonly repoRoot: string;
  /** Branch checked out when the adapter was opened, or null for detached HEAD. */
  readonly branch: string | null;

  #queue: Promise<unknown> = Promise.resolve();
  #lastFetchedAt: string | null = null;
  #prepared: PreparedBatch | null = null;
  #recovery: LocalRecoveryInfo | null = null;

  private constructor(repoRoot: string, branch: string | null) {
    this.repoRoot = repoRoot;
    this.branch = branch;
  }

  /**
   * Open an existing clone. The branch checked out right now becomes the
   * session branch. A detached HEAD (or an in-progress merge/rebase) keeps the
   * adapter usable for reading; `commit` then fails with "repo-state".
   */
  static async open(repoPath: string): Promise<LocalGitAdapter> {
    const start = path.resolve(repoPath);
    const inside = await runGit(start, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      throw new AdapterError("repo-state", `not a Git work tree: ${start}`, {
        stderr: redactText(inside.stderr.trim()),
      });
    }
    const top = await runGit(start, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      throw new AdapterError("repo-state", `cannot resolve the repository root of ${start}`, {
        stderr: redactText(top.stderr.trim()),
      });
    }
    const repoRoot = path.resolve(top.stdout.trim());
    const branch = await currentBranch(repoRoot);
    return new LocalGitAdapter(repoRoot, branch);
  }

  // -- serialisation -------------------------------------------------------

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #git(args: string[], stdin?: Uint8Array): Promise<GitResult> {
    return stdin === undefined
      ? runGit(this.repoRoot, args)
      : runGit(this.repoRoot, args, { stdin });
  }

  // -- reading -------------------------------------------------------------

  head(): Promise<string> {
    return this.#enqueue(() => this.#head());
  }

  async #head(): Promise<string> {
    const id = await revParse(this.repoRoot, "HEAD");
    if (id === null) {
      throw new AdapterError("repo-state", "HEAD does not resolve to a commit (empty repository?)");
    }
    return id;
  }

  list(dir: string, revision: string): Promise<Entry[]> {
    return this.#enqueue(async () => {
      const rev = validateRevision(revision);
      const cleanDir = dir.replace(/^\/+|\/+$/g, "");
      if (cleanDir !== "") await resolveRepoDir(this.repoRoot, cleanDir);
      const entries = await lsTreeDir(this.repoRoot, rev, cleanDir);
      const out: Entry[] = [];
      for (const e of entries) {
        if (e.type === "blob") {
          out.push({ path: e.path, kind: "file", blobId: e.object, size: e.size ?? 0 });
        } else {
          out.push({ path: e.path, kind: "dir" });
        }
      }
      out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return out;
    });
  }

  read(paths: string[], revision?: string): Promise<Snapshot> {
    return this.#enqueue(async () => {
      const rev = revision === undefined ? await this.#head() : validateRevision(revision);
      const resolved = revision === undefined ? rev : ((await revParse(this.repoRoot, rev)) ?? rev);
      const files: Snapshot["files"] = {};
      for (const p of paths) {
        await resolveRepoPath(this.repoRoot, p);
        const spec = `${resolved}:${p}`;
        const exists = await this.#git(["cat-file", "-e", spec]);
        if (exists.code !== 0) {
          files[p] = null;
          continue;
        }
        const show = await this.#git(["show", spec]);
        if (show.code !== 0) {
          files[p] = null;
          continue;
        }
        const blob = await revParse(this.repoRoot, spec);
        if (blob === null) {
          files[p] = null;
          continue;
        }
        files[p] = { text: decodeUtf8(show.stdoutRaw), blobId: blob };
      }
      return { revision: resolved, files };
    });
  }

  /**
   * Raw bytes of one path at `revision` (DESIGN.md 6: repository images come
   * from the revision being read). No text decoding happens anywhere on this
   * path. Returns null when the path does not exist at that revision.
   */
  readBlob(
    repoPath: string,
    revision: string,
  ): Promise<{ bytes: Uint8Array; blobId: string } | null> {
    return this.#enqueue(async () => {
      const rev = validateRevision(revision);
      await resolveRepoPath(this.repoRoot, repoPath);
      const resolved = (await revParse(this.repoRoot, rev)) ?? rev;
      const spec = `${resolved}:${repoPath}`;
      const blobId = await revParse(this.repoRoot, spec);
      if (blobId === null) return null;
      const type = await this.#git(["cat-file", "-t", spec]);
      if (type.code !== 0 || type.stdout.trim() !== "blob") return null;
      const show = await this.#git(["cat-file", "blob", spec]);
      if (show.code !== 0) return null;
      return { bytes: new Uint8Array(show.stdoutRaw), blobId };
    });
  }

  // -- committing ----------------------------------------------------------

  commit(input: CommitInput): Promise<CommitResult> {
    return this.#enqueue(() => this.#commit(input));
  }

  async #commit(input: CommitInput): Promise<CommitResult> {
    this.#assertBatchId(input.batchId);
    const rec = this.#recovery;
    if (rec !== null && rec.phase !== "prepared-uncommitted") {
      // DESIGN.md 7.2 table: 保存結果未確認 / コミット済み・ローカル反映要復旧 → 新規保存禁止.
      throw new AdapterError(
        "worktree-recovery",
        rec.phase === "result-unknown"
          ? "the result of a previous save is unconfirmed; resolve it before saving again"
          : "a previous commit needs local recovery; resolve it before saving again",
        { phase: rec.phase, batchId: rec.batchId, paths: rec.paths },
      );
    }
    if (rec !== null && rec.batchId !== input.batchId) {
      throw new AdapterError(
        "worktree-recovery",
        "another batch is prepared but not committed; retry or cancel it first",
        { phase: rec.phase, batchId: rec.batchId, paths: rec.paths },
      );
    }

    await this.#assertCommittable(input.base.revision);

    if (rec !== null && this.#prepared !== null && rec.batchId === input.batchId) {
      return this.#commitRetry(input, this.#prepared);
    }

    const batch = await this.#prepare(input);
    this.#prepared = batch;
    this.#recovery = toRecoveryInfo(batch, "prepared-uncommitted");

    // Step 4: reflect into the work tree.
    for (const p of batch.paths) {
      await this.#writePrepared(p);
    }

    return this.#addVerifyAndCommit(batch);
  }

  /** DESIGN.md 7.2 step 1: preconditions that make committing legal at all. */
  async #assertCommittable(baseRevision: string): Promise<void> {
    if (this.branch === null) {
      throw new AdapterError(
        "repo-state",
        "HEAD is detached; use an external Git tool to check out a branch",
      );
    }
    const branchNow = await currentBranch(this.repoRoot);
    if (branchNow === null) {
      throw new AdapterError("repo-state", "HEAD is detached; the session branch is gone");
    }
    if (branchNow !== this.branch) {
      throw new AdapterError(
        "repo-state",
        `the checked-out branch changed from ${this.branch} to ${branchNow}`,
      );
    }
    const busy = await inProgressOperation(this.repoRoot);
    if (busy !== null) {
      throw new AdapterError("repo-state", `a ${busy} is in progress; finish it with a Git tool`);
    }
    const head = await this.#head();
    if (head !== baseRevision) {
      throw new AdapterError(
        "conflict",
        `HEAD moved: expected ${baseRevision}, found ${head}`,
        { expected: baseRevision, actual: head },
      );
    }
  }

  #assertBatchId(batchId: string): void {
    if (typeof batchId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(batchId)) {
      throw new AdapterError("validation", "batchId must be a UUID");
    }
  }

  /** DESIGN.md 7.2 steps 2 and 3: per-path clean check, then prepare in memory. */
  async #prepare(input: CommitInput): Promise<PreparedBatch> {
    if (!Array.isArray(input.changes) || input.changes.length === 0) {
      throw new AdapterError("validation", "commit requires at least one change");
    }
    if (typeof input.message !== "string" || input.message.trim().length === 0) {
      throw new AdapterError("validation", "commit requires a message");
    }
    const trailerBatch = extractBatchId(input.message);
    if (trailerBatch !== input.batchId) {
      throw new AdapterError(
        "validation",
        "the commit message must carry an Syuire-Batch trailer matching batchId",
      );
    }
    const seen = new Set<string>();
    const dirty: string[] = [];
    const prepared: PreparedPath[] = [];

    for (const change of input.changes) {
      const repoPath = change.path;
      if (seen.has(repoPath)) {
        throw new AdapterError("validation", `duplicate path in changes: ${repoPath}`);
      }
      seen.add(repoPath);
      const absPath = await resolveRepoPath(this.repoRoot, repoPath);
      if (typeof change.text !== "string") {
        throw new AdapterError("validation", `change.text must be a string for ${repoPath}`);
      }
      const headEntry: TreeEntry | null = await lsTree(this.repoRoot, "HEAD", repoPath);
      const baseEntry = Object.prototype.hasOwnProperty.call(input.base.files, repoPath)
        ? input.base.files[repoPath]
        : undefined;

      if (headEntry !== null && headEntry.type === "blob") {
        // DESIGN.md 5.4「既存パスには上書きしない」: a caller that did not read
        // the path cannot be updating it — it believes the path is free (a new
        // review log). Refuse rather than silently overwriting a tracked file.
        if (baseEntry === undefined) {
          throw new AdapterError(
            "validation",
            `${repoPath} already exists in HEAD but was not read into base.files; refusing to overwrite it`,
            { path: repoPath },
          );
        }
        if (baseEntry === null) {
          throw new AdapterError(
            "validation",
            `base says ${repoPath} does not exist at ${input.base.revision}, but it is present in HEAD; refusing to overwrite it`,
            { path: repoPath },
          );
        }
        const bytes = await readFileBytes(absPath);
        if (bytes === null) {
          dirty.push(repoPath);
          continue;
        }
        const wtBlob = await hashObjectFile(this.repoRoot, repoPath);
        if (wtBlob === null || wtBlob !== headEntry.object) {
          dirty.push(repoPath);
          continue;
        }
        if (!(await worktreeMatchesHead(this.repoRoot, repoPath))) {
          // Catches a mode change that the blob comparison cannot see.
          dirty.push(repoPath);
          continue;
        }
        if (!(await indexMatchesHead(this.repoRoot, repoPath))) {
          dirty.push(repoPath);
          continue;
        }
        if (await hasUnmergedEntry(this.repoRoot, repoPath)) {
          dirty.push(repoPath);
          continue;
        }
        if (baseEntry != null && baseEntry.blobId !== wtBlob) {
          dirty.push(repoPath);
          continue;
        }
        // DESIGN.md 5.2: the committed blob always comes from the original
        // (LF) text, but the bytes written into the work tree must preserve
        // whatever line ending the work tree already used for this path.
        const afterBlob = await hashObjectBytes(
          this.repoRoot,
          repoPath,
          Buffer.from(change.text, "utf8"),
        );
        const worktreeText = (await worktreeWantsCrlf(this.repoRoot, repoPath))
          ? convertLfToCrlf(change.text)
          : change.text;
        const afterBytes = Buffer.from(worktreeText, "utf8");
        prepared.push({
          repoPath,
          absPath,
          beforeBlob: wtBlob,
          beforeBytes: bytes,
          beforeFingerprint: fingerprint(bytes),
          afterBlob,
          afterBytes,
          mode: headEntry.mode,
          isNew: false,
        });
        continue;
      }

      // Not in HEAD: a new review log. DESIGN.md 5.4 / 7.2.
      if (baseEntry != null) {
        throw new AdapterError(
          "validation",
          `base claims ${repoPath} exists, but it is not present in ${input.base.revision}`,
        );
      }
      const existing = await readFileBytes(absPath);
      if (existing !== null) {
        dirty.push(repoPath);
        continue;
      }
      if (await isTrackedInIndex(this.repoRoot, repoPath)) {
        dirty.push(repoPath);
        continue;
      }
      if (await isIgnored(this.repoRoot, repoPath)) {
        throw new AdapterError(
          "validation",
          `${repoPath} is excluded by .gitignore, so it cannot be added to the commit`,
          { path: repoPath },
        );
      }
      // DESIGN.md 5.2: same split as above — the blob is hashed from the
      // original text, the work-tree bytes follow the path's own attributes.
      const afterBlob = await hashObjectBytes(
        this.repoRoot,
        repoPath,
        Buffer.from(change.text, "utf8"),
      );
      const worktreeText = (await newPathWantsCrlf(this.repoRoot, repoPath))
        ? convertLfToCrlf(change.text)
        : change.text;
      const afterBytes = Buffer.from(worktreeText, "utf8");
      prepared.push({
        repoPath,
        absPath,
        beforeBlob: null,
        beforeBytes: null,
        beforeFingerprint: null,
        afterBlob,
        afterBytes,
        mode: NEW_FILE_MODE,
        isNew: true,
      });
    }

    if (dirty.length > 0) {
      throw new AdapterError(
        "worktree-dirty",
        `the work tree or index has uncommitted changes for: ${dirty.join(", ")}`,
        { paths: dirty },
      );
    }

    return {
      batchId: input.batchId,
      baseCommitId: input.base.revision,
      message: input.message,
      paths: prepared,
    };
  }

  /** Step 4 for one path, with the raw-byte re-check immediately before writing. */
  async #writePrepared(p: PreparedPath): Promise<void> {
    if (!p.isNew) {
      const now = await fileFingerprint(p.absPath);
      if (now !== p.beforeFingerprint) {
        throw new AdapterError(
          "worktree-recovery",
          `${p.repoPath} was modified outside syuire while the save was being prepared`,
          { path: p.repoPath, phase: "prepared-uncommitted" },
        );
      }
    }
    try {
      await writeFileAtomic(p.absPath, p.afterBytes);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      throw new AdapterError(
        "worktree-recovery",
        `could not write ${p.repoPath} (${code || String(err)}); the file may be locked by another program`,
        { path: p.repoPath, code, phase: "prepared-uncommitted" },
      );
    }
  }

  /** DESIGN.md 7.2 復旧: retry with the same batchId. */
  async #commitRetry(input: CommitInput, batch: PreparedBatch): Promise<CommitResult> {
    if (input.base.revision !== batch.baseCommitId) {
      throw new AdapterError(
        "conflict",
        `the prepared batch is based on ${batch.baseCommitId}, not ${input.base.revision}`,
      );
    }
    const byPath = new Map(batch.paths.map((p) => [p.repoPath, p]));
    for (const change of input.changes) {
      const p = byPath.get(change.path);
      if (p === undefined) {
        throw new AdapterError(
          "validation",
          `retry of batch ${batch.batchId} adds an unprepared path: ${change.path}`,
        );
      }
      const blob = await hashObjectBytes(
        this.repoRoot,
        change.path,
        Buffer.from(change.text, "utf8"),
      );
      if (blob !== p.afterBlob) {
        throw new AdapterError(
          "validation",
          `retry of batch ${batch.batchId} changes the content of ${change.path}`,
        );
      }
    }

    for (const p of batch.paths) {
      const current = await this.#currentBlob(p);
      if (current === p.afterBlob) continue; // already reflected, do not write twice
      if (current === p.beforeBlob) {
        await this.#writePrepared(p);
        continue;
      }
      throw new AdapterError(
        "worktree-recovery",
        `${p.repoPath} is neither the value before nor after preparation; check it with a Git tool`,
        { path: p.repoPath, phase: "prepared-uncommitted" },
      );
    }
    return this.#addVerifyAndCommit(batch);
  }

  async #currentBlob(p: PreparedPath): Promise<string | null> {
    const bytes = await readFileBytes(p.absPath);
    if (bytes === null) return null;
    return hashObjectFile(this.repoRoot, p.repoPath);
  }

  /** Steps 5 to 8. */
  async #addVerifyAndCommit(batch: PreparedBatch): Promise<CommitResult> {
    // Step 5: make untracked logs visible to `commit --only`.
    for (const p of batch.paths) {
      if (!p.isNew) continue;
      const add = await this.#git(["add", "-N", "--", p.repoPath]);
      if (add.code !== 0) {
        if (/ignored by one of your .gitignore files|is in \.gitignore/i.test(add.stderr)) {
          throw new AdapterError(
            "validation",
            `${p.repoPath} is excluded by .gitignore, so it cannot be added to the commit`,
            { path: p.repoPath, stderr: redactText(add.stderr.trim()) },
          );
        }
        throw new AdapterError("commit-failed", `git add -N failed for ${p.repoPath}`, {
          stderr: redactText(add.stderr.trim()),
        });
      }
    }

    // Step 6: re-verify branch, HEAD and every prepared blob.
    const branchNow = await currentBranch(this.repoRoot);
    if (branchNow !== this.branch) {
      throw new AdapterError(
        "worktree-recovery",
        `the checked-out branch changed to ${branchNow ?? "a detached HEAD"} before committing`,
        { phase: "prepared-uncommitted" },
      );
    }
    const headNow = await revParse(this.repoRoot, "HEAD");
    if (headNow !== batch.baseCommitId) {
      throw new AdapterError(
        "worktree-recovery",
        `HEAD moved to ${headNow ?? "nothing"} before committing`,
        { phase: "prepared-uncommitted" },
      );
    }
    for (const p of batch.paths) {
      const blob = await this.#currentBlob(p);
      if (blob !== p.afterBlob) {
        throw new AdapterError(
          "worktree-recovery",
          `${p.repoPath} no longer matches the prepared content`,
          { path: p.repoPath, phase: "prepared-uncommitted" },
        );
      }
    }

    // Step 7: commit. Hooks and signing apply as usual.
    const msgFile = path.join(
      await fsp.mkdtemp(path.join(os.tmpdir(), "syuire-msg-")),
      "COMMIT_MSG",
    );
    let result: GitResult;
    try {
      await fsp.writeFile(msgFile, Buffer.from(batch.message, "utf8"));
      result = await this.#git([
        "commit",
        "--only",
        "-F",
        msgFile,
        "--",
        ...batch.paths.map((p) => p.repoPath),
      ]);
    } finally {
      await fsp.rm(path.dirname(msgFile), { recursive: true, force: true }).catch(() => undefined);
    }

    if (result.unobservable) {
      // DESIGN.md 7.2: commit の終了結果を受け取れない場合は保存結果未確認.
      this.#recovery = toRecoveryInfo(batch, "result-unknown", {
        reason: result.failedToSpawn
          ? "git could not be started"
          : result.timedOut
            ? "git commit did not finish in time and was stopped; it may have been waiting for credentials or a hook"
            : `git commit produced no exit status${result.signal ? ` (signal ${result.signal})` : ""}`,
      });
      return { status: "unknown", batchId: batch.batchId };
    }
    if (result.code !== 0) {
      this.#recovery = toRecoveryInfo(batch, "prepared-uncommitted");
      throw new AdapterError("commit-failed", "git commit failed; the changes stay in the work tree", {
        stderr: redactText(result.stderr.trim()),
        stdout: redactText(result.stdout.trim()),
        code: result.code,
        paths: batch.paths.map((p) => p.repoPath),
      });
    }

    return this.#verifyAfterCommit(batch);
  }

  /** Step 8: the three-way check that turns a commit into "ローカル保存済み". */
  async #verifyAfterCommit(batch: PreparedBatch): Promise<CommitResult> {
    const commitId = await revParse(this.repoRoot, "HEAD");
    if (commitId === null) {
      this.#recovery = toRecoveryInfo(batch, "committed-needs-recovery", {
        reason: "HEAD does not resolve after the commit",
      });
      return {
        status: "committed",
        commitId: "",
        localReflection: "needs-recovery",
        paths: batch.paths.map((p) => p.repoPath),
        reason: "HEAD does not resolve after the commit",
      };
    }
    const reason = await this.#verificationFailure(batch, commitId);
    if (reason === null) {
      this.#recovery = null;
      this.#prepared = null;
      return { status: "committed", commitId, localReflection: "complete" };
    }
    this.#recovery = toRecoveryInfo(batch, "committed-needs-recovery", {
      newCommitId: commitId,
      reason,
    });
    return {
      status: "committed",
      commitId,
      localReflection: "needs-recovery",
      paths: batch.paths.map((p) => p.repoPath),
      reason,
    };
  }

  /** Returns null when the commit reflects the prepared state exactly. */
  async #verificationFailure(batch: PreparedBatch, commitId: string): Promise<string | null> {
    const parent = await revParse(this.repoRoot, `${commitId}^`);
    if (parent !== batch.baseCommitId) {
      return `the new commit's parent is ${parent ?? "missing"}, expected ${batch.baseCommitId}`;
    }
    const body = await this.#git(["cat-file", "-p", commitId]);
    if (body.code !== 0 || extractBatchId(body.stdout) !== batch.batchId) {
      return `the commit message does not carry Syuire-Batch: ${batch.batchId}`;
    }
    for (const p of batch.paths) {
      const entry = await lsTree(this.repoRoot, commitId, p.repoPath);
      if (entry === null) return `${p.repoPath} is missing from the new commit`;
      if (entry.object !== p.afterBlob) {
        return `${p.repoPath} was committed as ${entry.object}, expected ${p.afterBlob}`;
      }
      if (entry.mode !== p.mode) {
        return `${p.repoPath} was committed with mode ${entry.mode}, expected ${p.mode}`;
      }
    }
    const paths = batch.paths.map((p) => p.repoPath);
    const wt = await this.#git(["diff", "--quiet", "HEAD", "--", ...paths]);
    if (wt.code !== 0) return `the work tree does not match the new commit for ${paths.join(", ")}`;
    const idx = await this.#git(["diff", "--cached", "--quiet", "HEAD", "--", ...paths]);
    if (idx.code !== 0) return `the index does not match the new commit for ${paths.join(", ")}`;
    return null;
  }

  // -- recovery ------------------------------------------------------------

  recovery(): Promise<LocalRecoveryInfo | null> {
    return this.#enqueue(async () => (this.#recovery === null ? null : { ...this.#recovery }));
  }

  /** Undo a prepared-but-uncommitted batch after the user asked for it. */
  cancelPrepared(): Promise<LocalRecoveryInfo | null> {
    return this.#enqueue(async () => {
      const rec = this.#recovery;
      const batch = this.#prepared;
      if (rec === null || batch === null) return null;
      if (rec.phase !== "prepared-uncommitted") {
        throw new AdapterError(
          "worktree-recovery",
          `cannot cancel while the batch is in phase ${rec.phase}`,
          { phase: rec.phase },
        );
      }
      const states: Array<{ p: PreparedPath; current: string | null }> = [];
      for (const p of batch.paths) {
        const current = await this.#currentBlob(p);
        if (current !== p.afterBlob && current !== p.beforeBlob) {
          throw new AdapterError(
            "worktree-recovery",
            `${p.repoPath} changed outside syuire; cancel would discard that change`,
            { path: p.repoPath },
          );
        }
        states.push({ p, current });
      }
      for (const s of states) {
        const p = s.p;
        if (p.isNew) {
          if (s.current !== null) await removeFile(p.absPath);
          // DESIGN.md 7.2 復旧: drop the intent-to-add entry from the normal index.
          if (await isTrackedInIndex(this.repoRoot, p.repoPath)) {
            const reset = await this.#git(["reset", "--quiet", "--", p.repoPath]);
            if (reset.code !== 0) {
              throw new AdapterError("worktree-recovery", `git reset failed for ${p.repoPath}`, {
                stderr: redactText(reset.stderr.trim()),
              });
            }
          }
          continue;
        }
        if (s.current === p.afterBlob && p.beforeBytes !== null) {
          await writeFileAtomic(p.absPath, p.beforeBytes);
        }
      }
      this.#recovery = null;
      this.#prepared = null;
      return null;
    });
  }

  /** DESIGN.md 7.3: confirm a "保存結果未確認" batch against the branch history. */
  resolveUnknown(): Promise<ResolveUnknownResult> {
    return this.#enqueue(async () => {
      const rec = this.#recovery;
      const batch = this.#prepared;
      if (rec === null || batch === null || rec.phase !== "result-unknown") {
        throw new AdapterError(
          "validation",
          "there is no save with an unconfirmed result to resolve",
          { phase: rec?.phase ?? null },
        );
      }
      const commitId = await this.#findBatchCommit(rec.batchId);
      if (commitId === null) {
        this.#recovery = toRecoveryInfo(batch, "prepared-uncommitted");
        return { resolved: "not-committed", recovery: { ...this.#recovery } };
      }
      const reason = await this.#verificationFailure(batch, commitId);
      if (reason === null) {
        this.#recovery = null;
        this.#prepared = null;
        return { resolved: "committed-complete", commitId, recovery: null };
      }
      this.#recovery = toRecoveryInfo(batch, "committed-needs-recovery", {
        newCommitId: commitId,
        reason,
      });
      return {
        resolved: "committed-needs-recovery",
        commitId,
        recovery: { ...this.#recovery },
      };
    });
  }

  /**
   * Explicit acknowledgement that the user repaired the work tree themselves.
   * Re-checks the three-way match before dropping the recovery record.
   */
  clearRecovery(): Promise<LocalRecoveryInfo | null> {
    return this.#enqueue(async () => {
      const rec = this.#recovery;
      if (rec === null) return null;
      const paths = rec.paths;
      if (paths.length > 0) {
        const wt = await this.#git(["diff", "--quiet", "HEAD", "--", ...paths]);
        const idx = await this.#git(["diff", "--cached", "--quiet", "HEAD", "--", ...paths]);
        if (wt.code !== 0 || idx.code !== 0) {
          throw new AdapterError(
            "worktree-recovery",
            `HEAD, index and work tree still disagree for ${paths.join(", ")}`,
            { paths },
          );
        }
      }
      this.#recovery = null;
      this.#prepared = null;
      return null;
    });
  }

  findBatchCommit(batchId: string): Promise<string | null> {
    return this.#enqueue(() => this.#findBatchCommit(batchId));
  }

  async #findBatchCommit(batchId: string): Promise<string | null> {
    this.#assertBatchId(batchId);
    const ref = this.branch ?? "HEAD";
    const r = await this.#git(["log", "--format=%H%x00%B%x00", "-n", "200", ref]);
    if (r.code !== 0) return null;
    const parts = r.stdout.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const hash = (parts[i] ?? "").trim();
      const body = parts[i + 1] ?? "";
      if (!/^[0-9a-f]{40,64}$/.test(hash)) continue;
      if (extractBatchId(body) === batchId) return hash;
    }
    return null;
  }

  // -- synchronisation -----------------------------------------------------

  fetch(): Promise<SyncStatus> {
    return this.#enqueue(async () => {
      await this.#fetch();
      return this.#sync();
    });
  }

  async #fetch(): Promise<void> {
    const args = ["fetch", "--prune"];
    const r = await this.#git(args);
    if (r.code !== 0) throw classifyRemoteFailure(r, args);
    this.#lastFetchedAt = new Date().toISOString();
  }

  pull(): Promise<SyncStatus> {
    return this.#enqueue(async () => {
      this.#assertSyncAllowed();
      await this.#fetch();
      const status = await this.#sync();
      if (status.state === "no-upstream" || status.state === "repo-busy") return status;
      if (status.behind === 0) return status;
      if (status.ahead > 0) {
        throw new AdapterError(
          "conflict",
          `the branch has diverged (${status.ahead} ahead, ${status.behind} behind); merge it with a Git tool`,
          { ahead: status.ahead, behind: status.behind },
        );
      }
      const merge = await this.#git(["merge", "--ff-only", "@{u}"]);
      if (merge.code !== 0) {
        if (merge.timedOut) throw timeoutError(["merge"], merge);
        const text = `${merge.stderr}\n${merge.stdout}`;
        if (/local changes|would be overwritten|Please commit your changes|cannot pull with rebase/i.test(text)) {
          throw new AdapterError(
            "worktree-dirty",
            "the fast-forward would overwrite local changes; commit or stash them with a Git tool",
            { stderr: redactText(merge.stderr.trim()) },
          );
        }
        throw new AdapterError("conflict", "fast-forward pull was refused", {
          stderr: redactText(merge.stderr.trim() || merge.stdout.trim()),
        });
      }
      return this.#sync();
    });
  }

  push(): Promise<SyncStatus> {
    return this.#enqueue(async () => {
      this.#assertSyncAllowed();
      const r = await this.#git(["push"]);
      if (r.code !== 0) {
        if (r.timedOut) throw classifyRemoteFailure(r, ["push"]);
        const text = `${r.stderr}\n${r.stdout}`;
        if (/non-fast-forward|fetch first|Updates were rejected|rejected\]/i.test(text)) {
          throw new AdapterError(
            "conflict",
            "the push was rejected because the remote has commits you do not have",
            { stderr: redactText(r.stderr.trim()) },
          );
        }
        throw classifyRemoteFailure(r, ["push"]);
      }
      return this.#sync();
    });
  }

  #assertSyncAllowed(): void {
    const rec = this.#recovery;
    if (rec !== null && (rec.phase === "result-unknown" || rec.phase === "committed-needs-recovery")) {
      throw new AdapterError(
        "worktree-recovery",
        rec.phase === "result-unknown"
          ? "the result of a previous save is unconfirmed; pull and push are disabled"
          : "a previous commit needs local recovery; pull and push are disabled",
        { phase: rec.phase, batchId: rec.batchId, paths: rec.paths },
      );
    }
  }

  sync(): Promise<SyncStatus> {
    return this.#enqueue(() => this.#sync());
  }

  async #sync(): Promise<SyncStatus> {
    const branch = await currentBranch(this.repoRoot);
    const head = await revParse(this.repoRoot, "HEAD");
    const busy = await inProgressOperation(this.repoRoot);
    const upstream = await upstreamRef(this.repoRoot);

    const base = {
      branch,
      head,
      upstream,
      ahead: 0,
      behind: 0,
      lastFetchedAt: this.#lastFetchedAt,
    };

    if (busy !== null) {
      return { ...base, state: "repo-busy" as SyncState, detail: `a ${busy} is in progress` };
    }
    if (branch === null) {
      return { ...base, state: "repo-busy" as SyncState, detail: "HEAD is detached" };
    }
    if (upstream === null) {
      return {
        ...base,
        state: "no-upstream" as SyncState,
        detail: "no upstream branch is configured",
      };
    }
    const counts = await aheadBehind(this.repoRoot);
    if (counts === null) {
      return {
        ...base,
        state: "unknown" as SyncState,
        detail: "the upstream ref could not be compared",
      };
    }
    let state: SyncState;
    if (counts.ahead === 0 && counts.behind === 0) state = "in-sync";
    else if (counts.ahead > 0 && counts.behind === 0) state = "local-ahead";
    else if (counts.ahead === 0 && counts.behind > 0) state = "remote-ahead";
    else state = "diverged";
    return { ...base, ahead: counts.ahead, behind: counts.behind, state };
  }

  info(): Promise<RepoInfo> {
    return this.#enqueue(async () => ({
      repoRoot: this.repoRoot,
      branch: await currentBranch(this.repoRoot),
      head: await revParse(this.repoRoot, "HEAD"),
      upstream: await upstreamRef(this.repoRoot),
      authorName: await configValue(this.repoRoot, "user.name"),
      authorEmail: await configValue(this.repoRoot, "user.email"),
    }));
  }
}
