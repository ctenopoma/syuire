/**
 * Application shell: connection, file selection, the operation queue and the
 * save / sync / recovery flows (DESIGN.md 4.1, 4.2, 7.1-7.3, 8, 10).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  applyOperations,
  type Entry,
  type LocalRecoveryInfo,
  type Operation,
  type RepositoryAdapter,
  type Snapshot,
  type SyncStatus,
} from "@syuire/core";

import { GitHubAdapter } from "../adapters/github";
import { LocalAdapterClient } from "../adapters/local";

import { Header } from "./Header";
import { ConnectScreen, valuesFromPrefill, type ConnectValues } from "./ConnectScreen";
import { FileBrowser } from "./FileBrowser";
import { DocumentView } from "./DocumentView";
import { imageMimeType } from "./MarkdownRenderer";
import { SavePanel } from "./SavePanel";
import { RecoveryPanel } from "./RecoveryPanel";
import { StripDialog } from "./StripDialog";

import { parseHash, formatGhSpec, type GitHubPrefill } from "../lib/hash";
import {
  loadPendingBatch,
  loadQueueFrom,
  loadRecoveryMirror,
  makeEnvelope,
  parseQueue,
  removeOperation,
  savePendingBatch,
  saveQueueTo,
  saveRecoveryMirror,
  serializeQueue,
  type PendingBatch,
  type QueueContext,
  type RepoContext,
} from "../lib/queue";
import {
  loadLastConnection,
  localSessionFlag,
  saveLastConnection,
  loadSessionToken,
  saveSessionToken,
  safeLocalStorage,
  safeSessionStorage,
  sessionTokenOptIn,
  setLocalSessionFlag,
} from "../lib/settings";
import { confirmBatch, errorKind, errorMessage, runSave, type BatchAwareAdapter, type ConflictReport } from "../lib/save";
import { adapterErrorMessage } from "../lib/messages";
import { newId } from "../lib/time";

interface Session {
  mode: "github" | "local";
  adapter: BatchAwareAdapter;
  local: LocalAdapterClient | null;
  repoKey: string;
  branch: string;
  label: string;
}

interface OpenFile {
  path: string;
  base: Snapshot;
}

type Navigation =
  | { kind: "dir"; dir: string }
  | { kind: "file"; path: string }
  | { kind: "disconnect" };

function fileText(base: Snapshot, path: string): string {
  const entry = base.files[path];
  return entry ? entry.text : "";
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Resolve a repo-relative image URL against the open file. */
export function resolveRepoPath(basePath: string, url: string): string {
  let clean = url.split("#")[0] ?? "";
  clean = clean.split("?")[0] ?? "";
  try {
    clean = decodeURI(clean);
  } catch {
    // keep the raw value
  }
  const absolute = clean.startsWith("/");
  const segments = absolute ? [] : dirOf(basePath).split("/");
  const out: string[] = [];
  for (const seg of segments.concat(clean.split("/"))) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

export function App(): VNode {
  const localStore = useMemo(() => safeLocalStorage(), []);
  const sessionStore = useMemo(() => safeSessionStorage(), []);

  const [session, setSession] = useState<Session | null>(null);
  const [author, setAuthor] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [prefill, setPrefill] = useState<GitHubPrefill | null>(null);
  const [initialValues, setInitialValues] = useState<ConnectValues | null>(null);

  const [head, setHead] = useState<string>("");
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);

  const [queue, setQueue] = useState<Operation[]>([]);
  const [pending, setPending] = useState<PendingBatch | null>(null);
  const [reuseBatchId, setReuseBatchId] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictReport[] | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [recovery, setRecovery] = useState<LocalRecoveryInfo | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  /** Set when the commit landed but the body on screen could not be re-read. */
  const [staleReason, setStaleReason] = useState<string | null>(null);

  const [queueOpen, setQueueOpen] = useState(false);
  const [stripOpen, setStripOpen] = useState(false);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const [reauth, setReauth] = useState<{ owner: string; repo: string; branch: string } | null>(null);
  const [reauthToken, setReauthToken] = useState("");

  const tokenRef = useRef<string>("");
  const objectUrls = useRef<string[]>([]);

  // -------------------------------------------------------------------
  // Startup: deep link / remembered non-secret settings
  // -------------------------------------------------------------------
  useEffect(() => {
    const link = parseHash(globalThis.location?.hash ?? "");
    const last = loadLastConnection(localStore);
    if (link.kind === "local") {
      // DESIGN.md 8: the session token must not survive in the app URL (history,
      // bookmarks, a shared screenshot). It is read once here, kept in memory by
      // the client, and removed from the address bar immediately.
      setLocalSessionFlag(sessionStore, true);
      const client = new LocalAdapterClient(link.token);
      try {
        const loc = globalThis.location;
        globalThis.history?.replaceState(null, "", `${loc.pathname}${loc.search}`);
      } catch {
        // replaceState can be unavailable (file://); the token stays visible then.
      }
      setConnectBusy(true);
      void (async () => {
        try {
          const repoInfo = await client.info();
          setSession({
            mode: "local",
            adapter: client,
            local: client,
            repoKey: repoInfo.repoRoot,
            branch: repoInfo.branch ?? "",
            label: repoInfo.repoRoot,
          });
          setAuthor(repoInfo.authorName ?? "");
          setConnectBusy(false);
        } catch (err) {
          setConnectBusy(false);
          setConnectError(adapterErrorMessage(errorKind(err), errorMessage(err)));
        }
      })();
      return;
    }
    if (localSessionFlag(sessionStore)) {
      // This tab was opened from `syuire serve`, but the reload lost the
      // fragment that carried the one-shot session token.
      setConnectError(
        "ローカル実行層のセッショントークンは URL から取り除かれています。再読込では接続できません。" +
          "コマンドラインが表示した Open: の URL をもう一度開いてください（未保存の操作はこのタブに残っています）。",
      );
    }
    const fromHash = link.kind === "github" ? link.prefill : null;
    setPrefill(fromHash);
    const remembered = sessionTokenOptIn(sessionStore) ? (loadSessionToken(sessionStore) ?? "") : "";
    tokenRef.current = remembered;
    setInitialValues(valuesFromPrefill(fromHash, last, remembered, remembered.length > 0));
  }, [localStore, sessionStore]);

  useEffect(() => {
    return () => {
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
      objectUrls.current = [];
    };
  }, []);

  // -------------------------------------------------------------------
  // Queue mirroring (sessionStorage) and unload warning
  // -------------------------------------------------------------------
  const context: QueueContext | null = useMemo(() => {
    if (!session || !file) return null;
    return {
      mode: session.mode,
      repoKey: session.repoKey,
      branch: session.branch,
      path: file.path,
    };
  }, [session, file]);

  useEffect(() => {
    if (!context || !file || !sessionStore) return;
    saveQueueTo(sessionStore, context, file.base.revision, queue, new Date().toISOString());
  }, [context, file, queue, sessionStore]);

  useEffect(() => {
    if (!context || !sessionStore) return;
    savePendingBatch(sessionStore, context, pending);
  }, [context, pending, sessionStore]);

  useEffect(() => {
    if (queue.length === 0 && pending === null) return;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", handler);
    return () => globalThis.removeEventListener("beforeunload", handler);
  }, [queue.length, pending]);

  // -------------------------------------------------------------------
  // Derived: virtual source
  // -------------------------------------------------------------------
  const baseText = file ? fileText(file.base, file.path) : "";
  const applied = useMemo(() => applyOperations(baseText, queue), [baseText, queue]);
  const virtualSource = applied.source;
  const applyError = applied.ok
    ? null
    : "未保存の操作の一部が現在の本文に適用できません。保存前に確認してください。";

  // -------------------------------------------------------------------
  // Listing / opening
  // -------------------------------------------------------------------
  const listDir = useCallback(
    async (targetDir: string, revision?: string): Promise<void> => {
      if (!session) return;
      setBusy(true);
      setBrowseError(null);
      try {
        const rev = revision ?? head ?? "";
        const useRev = rev.length > 0 ? rev : await session.adapter.head();
        setHead(useRev);
        const list = await session.adapter.list(targetDir, useRev);
        setEntries(list);
        setDir(targetDir);
      } catch (err) {
        setBrowseError(adapterErrorMessage(errorKind(err), errorMessage(err)));
      } finally {
        setBusy(false);
      }
    },
    [session, head],
  );

  const repoContextOf = (s: Session): RepoContext => ({
    mode: s.mode,
    repoKey: s.repoKey,
    branch: s.branch,
  });

  /**
   * Keep the recovery record in memory and mirrored into sessionStorage
   * (DESIGN.md 8). The host layer owns the authoritative copy; the mirror only
   * lets a reconnect notice that the host lost a batch it had prepared.
   */
  const rememberRecovery = useCallback(
    (s: Session, info: LocalRecoveryInfo | null): void => {
      setRecovery(info);
      if (sessionStore && s.mode === "local") {
        saveRecoveryMirror(sessionStore, repoContextOf(s), info);
      }
    },
    [sessionStore],
  );

  const refreshSync = useCallback(
    async (s: Session): Promise<void> => {
      if (!s.local) return;
      try {
        setSync(await s.local.sync());
      } catch {
        // sync display is best effort
      }
      try {
        rememberRecovery(s, await s.local.recovery());
      } catch {
        // recovery probe is best effort
      }
    },
    [rememberRecovery],
  );

  /**
   * DESIGN.md 7.2 復旧 / 再起動後: when the host layer reports no recovery but
   * this tab still remembers a batch, the prepared state was lost with the host
   * process. Ask the branch history whether the commit exists before offering
   * anything.
   */
  const reconcileLocalRecovery = useCallback(
    async (s: Session): Promise<void> => {
      if (!s.local || !sessionStore) return;
      const ctx = repoContextOf(s);
      const mirror = loadRecoveryMirror(sessionStore, ctx);
      let live: LocalRecoveryInfo | null = null;
      try {
        live = await s.local.recovery();
      } catch {
        return; // best effort; refreshSync will try again
      }
      if (live !== null) {
        rememberRecovery(s, live);
        return;
      }
      if (mirror === null) return;
      try {
        const commitId = await s.local.findBatchCommit(mirror.batchId);
        saveRecoveryMirror(sessionStore, ctx, null);
        if (commitId !== null) {
          setQueue([]);
          setPending(null);
          setNotice(
            `中断していた保存は確定していました（${commitId.slice(0, 7)}）。復旧情報を消去しました。`,
          );
          return;
        }
        setReuseBatchId(mirror.batchId);
        setNotice(
          "ローカル実行層が再起動したため、準備していた状態は失われました。" +
            "コミットは作られていないので、同じ batchId のまま保存し直せます。",
        );
      } catch (err) {
        setSaveMessage(adapterErrorMessage(errorKind(err), errorMessage(err)));
      }
    },
    [sessionStore, rememberRecovery],
  );

  useEffect(() => {
    if (!session) return;
    void (async () => {
      await listDir(prefill?.path && !prefill.path.endsWith(".md") ? prefill.path : "");
      await reconcileLocalRecovery(session);
      await refreshSync(session);
    })();
    // Only when the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      if (!session) return;
      setBusy(true);
      setBrowseError(null);
      setConflicts(null);
      setSaveMessage(null);
      setStaleReason(null);
      try {
        const rev = head.length > 0 ? head : await session.adapter.head();
        const base = await session.adapter.read([path], rev);
        setHead(base.revision);
        setFile({ path, base });
        const ctx: QueueContext = {
          mode: session.mode,
          repoKey: session.repoKey,
          branch: session.branch,
          path,
        };
        const restored = sessionStore ? loadQueueFrom(sessionStore, ctx) : null;
        setQueue(restored ? restored.ops : []);
        if (restored && restored.baseRevision !== base.revision) {
          setNotice("未保存の操作を復元しました（基準版は更新されています）。");
        } else if (restored && restored.ops.length > 0) {
          setNotice(`未保存の操作を ${restored.ops.length} 件復元しました。`);
        }
        setPending(sessionStore ? loadPendingBatch(sessionStore, ctx) : null);
        if (session.mode === "github") {
          const spec = formatGhSpec({
            owner: session.repoKey.split("/")[0] ?? "",
            repo: session.repoKey.split("/")[1] ?? "",
            branch: session.branch,
            path,
          });
          globalThis.location.hash = `gh=${spec}`;
          saveLastConnection(localStore, {
            owner: session.repoKey.split("/")[0] ?? "",
            repo: session.repoKey.split("/")[1] ?? "",
            branch: session.branch,
            path,
            author,
          });
        }
      } catch (err) {
        setBrowseError(adapterErrorMessage(errorKind(err), errorMessage(err)));
      } finally {
        setBusy(false);
      }
    },
    [session, head, sessionStore, localStore, author],
  );

  // Open the deep-linked file once the listing is ready.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !session || file) return;
    const path = prefill?.path;
    if (path && path.endsWith(".md")) {
      autoOpened.current = true;
      void openFile(path);
    }
  }, [session, file, prefill, openFile]);

  // -------------------------------------------------------------------
  // Connect / disconnect
  // -------------------------------------------------------------------
  const connectGitHub = (values: ConnectValues): void => {
    setConnectBusy(true);
    setConnectError(null);
    // Leaving the lost local session behind: stop warning about its token.
    setLocalSessionFlag(sessionStore, false);
    const adapter = new GitHubAdapter({
      owner: values.owner.trim(),
      repo: values.repo.trim(),
      branch: values.branch.trim(),
      token: values.token,
    });
    void (async () => {
      try {
        const revision = await adapter.head();
        tokenRef.current = values.token;
        saveSessionToken(sessionStore, values.rememberToken ? values.token : null);
        saveLastConnection(localStore, {
          owner: values.owner.trim(),
          repo: values.repo.trim(),
          branch: values.branch.trim(),
          path: values.path.trim(),
          author: values.author.trim(),
        });
        setHead(revision);
        setAuthor(values.author.trim());
        setPrefill({
          owner: values.owner.trim(),
          repo: values.repo.trim(),
          branch: values.branch.trim(),
          path: values.path.trim(),
        });
        setSession({
          mode: "github",
          adapter,
          local: null,
          repoKey: `${values.owner.trim()}/${values.repo.trim()}`,
          branch: values.branch.trim(),
          label: `${values.owner.trim()}/${values.repo.trim()}`,
        });
        setConnectBusy(false);
      } catch (err) {
        setConnectBusy(false);
        setConnectError(adapterErrorMessage(errorKind(err), errorMessage(err)));
      }
    })();
  };

  const lookupAuthor = async (values: ConnectValues): Promise<string> => {
    const adapter = new GitHubAdapter({
      owner: values.owner.trim(),
      repo: values.repo.trim(),
      branch: values.branch.trim(),
      token: values.token,
    });
    return adapter.currentUserLogin();
  };

  const disconnect = (): void => {
    if (session && sessionStore && session.mode === "local") {
      saveRecoveryMirror(sessionStore, repoContextOf(session), null);
    }
    setLocalSessionFlag(sessionStore, false);
    setSession(null);
    setFile(null);
    setQueue([]);
    setEntries([]);
    setPending(null);
    setReuseBatchId(null);
    setConflicts(null);
    setSaveMessage(null);
    setStaleReason(null);
    setSync(null);
    setRecovery(null);
    tokenRef.current = "";
    autoOpened.current = false;
    const last = loadLastConnection(localStore);
    setInitialValues(valuesFromPrefill(null, last, "", false));
    saveSessionToken(sessionStore, null);
  };

  // -------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------
  // DESIGN.md 7.2 部分失敗と状態: only 保存結果未確認 and コミット済み・ローカル
  // 反映要復旧 stop 保存 / 最新 / 反映. 準備済み・未コミット is explicitly
  // 「再保存または明示的な取消可」, so it must not block anything.
  const blockedReason =
    recovery !== null && recovery.phase === "result-unknown"
      ? "保存結果未確認です。履歴を照合するまで 保存 / 最新 / GitHub に反映 を停止しています。"
      : recovery !== null && recovery.phase === "committed-needs-recovery"
        ? "コミット済み・ローカル反映要復旧です。復旧するまで 保存 / 最新 / GitHub に反映 を停止しています。"
        : pending
          ? "保存結果未確認です。履歴を「確認」するまで 保存 / 最新 / GitHub に反映 を停止しています。"
          : null;

  /** The adapter demands the same batchId when retrying a prepared batch. */
  const preparedBatchId =
    recovery !== null && recovery.phase === "prepared-uncommitted" ? recovery.batchId : null;

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!session || !file) return false;
    if (blockedReason) {
      setSaveMessage(blockedReason);
      return false;
    }
    setBusy(true);
    setConflicts(null);
    setSaveMessage(null);
    setNotice(null);
    const batchId = reuseBatchId ?? preparedBatchId ?? newId();
    const result = await runSave({
      adapter: session.adapter,
      path: file.path,
      base: file.base,
      ops: queue,
      batchId,
    });
    setBusy(false);

    switch (result.status) {
      case "nothing":
        setNotice(
          preparedBatchId === null
            ? "未保存の操作はありません。"
            : "再試行できる未保存の操作がありません。準備した変更は「準備した変更を取り消す」で戻せます。",
        );
        return false;
      case "committed": {
        setFile({ path: file.path, base: result.base });
        setHead(result.base.revision);
        setQueue([]);
        setPending(null);
        setReuseBatchId(null);
        // DESIGN.md 4.1: the commit is confirmed either way, so the base has
        // already advanced. A failed re-read only means the body on screen is old.
        setStaleReason(
          result.rereadError === undefined
            ? null
            : `保存しましたが、保存後の本文を読み込めませんでした（${result.rereadError}）。表示は古い内容です。再読込してください。`,
        );
        setNotice(`保存しました（${result.commitId.slice(0, 7)}）。`);
        if (session.local) void refreshSync(session);
        return true;
      }
      case "needs-recovery": {
        // DESIGN.md 7.2: ref 更新は成立している。確定した操作は再コミットしない
        // ので、キューと保留バッチを落として復旧情報だけを残す。
        setFile({ path: file.path, base: result.base });
        setHead(result.base.revision);
        setQueue([]);
        setPending(null);
        setReuseBatchId(null);
        setStaleReason(
          result.rereadError === undefined
            ? null
            : `コミット（${result.commitId.slice(0, 7)}）は確定していますが、保存後の本文を読み込めませんでした（${result.rereadError}）。表示は古い内容です。再読込してください。`,
        );
        setSaveMessage(
          `コミット済み（${result.commitId.slice(0, 7)}）・ローカル反映要復旧: ${result.reason}` +
            `（対象: ${result.paths.join(", ")}）。同じ操作は再保存しません。`,
        );
        if (session.local) void refreshSync(session);
        return false;
      }
      case "unknown": {
        const record: PendingBatch =
          result.candidateCommitId === undefined
            ? { batchId: result.batchId, startedAt: new Date().toISOString() }
            : {
                batchId: result.batchId,
                candidateCommitId: result.candidateCommitId,
                startedAt: new Date().toISOString(),
              };
        setPending(record);
        setReuseBatchId(null);
        setSaveMessage("保存結果を確認できませんでした。「確認」を押してください。");
        if (session.local) void refreshSync(session);
        return false;
      }
      case "conflicts":
        setFile({ path: file.path, base: result.base });
        setConflicts(result.conflicts);
        return false;
      case "error": {
        setFile({ path: file.path, base: result.base });
        // A failed local commit leaves a 準備済み・未コミット record behind; pick
        // it up so the recovery panel can offer 再試行 / 取消 (DESIGN.md 7.2).
        if (session.local) void refreshSync(session);
        if (result.kind === "auth" && session.mode === "github") {
          const [owner = "", repo = ""] = session.repoKey.split("/");
          setReauth({ owner, repo, branch: session.branch });
          setSaveMessage("認証が切れました。PAT を入力し直してください。未保存の操作は保持しています。");
        } else {
          setSaveMessage(adapterErrorMessage(result.kind, result.message));
        }
        return false;
      }
      default:
        return false;
    }
  }, [session, file, queue, blockedReason, reuseBatchId, preparedBatchId, refreshSync]);

  const doConfirmBatch = useCallback(async (): Promise<void> => {
    if (!session || !file || !pending) return;
    setBusy(true);
    setSaveMessage(null);
    const result = await confirmBatch(session.adapter, file.path, pending.batchId);
    setBusy(false);
    if (result.status === "found") {
      setFile({ path: file.path, base: result.base });
      setHead(result.base.revision);
      setQueue([]);
      setPending(null);
      setReuseBatchId(null);
      setStaleReason(null);
      setNotice(`保存済みでした（${result.commitId.slice(0, 7)}）。`);
      if (session.local) void refreshSync(session);
      return;
    }
    if (result.status === "not-found") {
      setPending(null);
      setReuseBatchId(pending.batchId);
      setNotice("コミットは作られていませんでした。同じ batchId で保存し直せます。");
      return;
    }
    setSaveMessage(adapterErrorMessage(result.kind, result.message));
  }, [session, file, pending, refreshSync]);

  const doRefresh = useCallback(async (): Promise<void> => {
    if (!session || !file) return;
    if (blockedReason) {
      setSaveMessage(blockedReason);
      return;
    }
    setBusy(true);
    setSaveMessage(null);
    setConflicts(null);
    try {
      if (session.local) {
        setSync(await session.local.pull());
      }
      const revision = await session.adapter.head();
      const base = await session.adapter.read([file.path], revision);
      setFile({ path: file.path, base });
      setHead(revision);
      setStaleReason(null);
      const text = fileText(base, file.path);
      const result = applyOperations(text, queue);
      if (!result.ok) {
        setConflicts(
          result.outcomes
            .filter((o) => o.outcome.status === "conflict")
            .map((o) => ({
              op: o.op,
              reason: o.outcome.status === "conflict" ? o.outcome.reason : "",
            })),
        );
      } else {
        setNotice("最新の本文を読み込みました。");
      }
    } catch (err) {
      setSaveMessage(adapterErrorMessage(errorKind(err), errorMessage(err)));
    } finally {
      setBusy(false);
    }
  }, [session, file, queue, blockedReason]);

  const doPush = useCallback(async (): Promise<boolean> => {
    if (!session?.local) return false;
    if (blockedReason) {
      setSaveMessage(blockedReason);
      return false;
    }
    setBusy(true);
    try {
      setSync(await session.local.push());
      setNotice("GitHub に反映しました。");
      return true;
    } catch (err) {
      setSaveMessage(adapterErrorMessage(errorKind(err), errorMessage(err)));
      return false;
    } finally {
      setBusy(false);
    }
  }, [session, blockedReason]);

  const doSaveAndPush = useCallback(async (): Promise<void> => {
    const saved = await doSave();
    if (!saved) return;
    const pushed = await doPush();
    if (!pushed) {
      setSaveMessage("ローカル保存済み・GitHub 未反映（同じ内容を再コミットしません）。");
    }
  }, [doSave, doPush]);

  // -------------------------------------------------------------------
  // Queue export / import
  // -------------------------------------------------------------------
  const doExport = useCallback((): void => {
    if (!context || !file) return;
    // DESIGN.md 8: 保存結果未確認・反映要復旧の情報は通常の未保存操作として
    // 破棄しない。They travel with the export so the user can still resolve them
    // after the tab (or the host process) is gone.
    const envelope = makeEnvelope(context, file.base.revision, queue, new Date().toISOString(), {
      pending,
      recovery,
    });
    const blob = new Blob([serializeQueue(envelope)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `syuire-queue-${file.path.replace(/[\\/]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, [context, file, queue, pending, recovery]);

  const doImport = useCallback(
    (input: File): void => {
      if (!context || !file) return;
      void input.text().then((text) => {
        const parsed = parseQueue(text);
        if (!parsed.ok) {
          setSaveMessage(`読み込めません: ${parsed.reason}`);
          return;
        }
        const c = parsed.envelope.context;
        if (c.mode !== context.mode || c.repoKey !== context.repoKey || c.branch !== context.branch) {
          setSaveMessage("別の接続先の書き出しです。");
          return;
        }
        if (c.path !== context.path) {
          setSaveMessage(`別のファイルの書き出しです: ${c.path}`);
          return;
        }
        const result = applyOperations(fileText(file.base, file.path), parsed.envelope.ops);
        if (!result.ok) {
          setConflicts(
            result.outcomes
              .filter((o) => o.outcome.status === "conflict")
              .map((o) => ({
                op: o.op,
                reason: o.outcome.status === "conflict" ? o.outcome.reason : "",
              })),
          );
          setSaveMessage("現在の本文に適用できない操作があるため読み込みませんでした。");
          return;
        }
        setQueue(parsed.envelope.ops);
        // Restore the unresolved save state that travelled with the export.
        const notes: string[] = [
          parsed.envelope.baseRevision === file.base.revision
            ? `未保存の操作を ${parsed.envelope.ops.length} 件読み込みました。`
            : `未保存の操作を ${parsed.envelope.ops.length} 件読み込みました（基準版が異なります）。`,
        ];
        const importedPending = parsed.envelope.pending;
        if (importedPending !== undefined) {
          setPending(importedPending);
          notes.push(`保存結果未確認のバッチ（${importedPending.batchId}）を復元しました。「確認」を押してください。`);
        }
        const importedRecovery = parsed.envelope.recovery;
        if (importedRecovery !== undefined) {
          if (session && sessionStore && session.mode === "local" && recovery === null) {
            saveRecoveryMirror(sessionStore, repoContextOf(session), importedRecovery);
          }
          notes.push(
            `復旧情報（${importedRecovery.phase} / batchId ${importedRecovery.batchId}）を復元しました。`,
          );
        }
        setNotice(notes.join(" "));
      });
    },
    [context, file, session, sessionStore, recovery],
  );

  // -------------------------------------------------------------------
  // Images (repo-relative only, at the revision being read)
  // -------------------------------------------------------------------
  const loadImage = useCallback(
    async (url: string): Promise<string> => {
      if (!session || !file) throw new Error("接続していません");
      const path = resolveRepoPath(file.path, url);
      const mime = imageMimeType(path);
      if (mime === null) throw new Error("対応していない画像形式です");
      const adapter = session.adapter;
      const revision = file.base.revision;

      const publish = (parts: BlobPart[]): string => {
        const objectUrl = URL.createObjectURL(new Blob(parts, { type: mime }));
        objectUrls.current.push(objectUrl);
        return objectUrl;
      };

      // Preferred path: raw bytes from the revision being read (DESIGN.md 6).
      if (typeof adapter.readBlob === "function") {
        const blob = await adapter.readBlob(path, revision);
        if (blob === null) throw new Error("画像が見つかりません");
        // Copy into a plain ArrayBuffer so the Blob owns its own bytes.
        const buffer = new ArrayBuffer(blob.bytes.byteLength);
        new Uint8Array(buffer).set(blob.bytes);
        return publish([buffer]);
      }

      // Adapters without readBlob can only serve UTF-8 text, so SVG only.
      if (mime !== "image/svg+xml") {
        throw new Error("この接続ではバイナリ画像を取得できません");
      }
      const snapshot = await adapter.read([path], revision);
      const entry = snapshot.files[path];
      if (!entry) throw new Error("画像が見つかりません");
      if (entry.text.includes("�")) {
        throw new Error("この画像はテキストとして取得できません（バイナリ）");
      }
      return publish([new TextEncoder().encode(entry.text)]);
    },
    [session, file],
  );

  // -------------------------------------------------------------------
  // Navigation guard
  // -------------------------------------------------------------------
  const requestNavigation = (nav: Navigation): void => {
    if (
      queue.length > 0 ||
      pending !== null ||
      (nav.kind === "disconnect" && recovery !== null)
    ) {
      setNavigation(nav);
      return;
    }
    applyNavigation(nav);
  };

  const applyNavigation = (nav: Navigation): void => {
    // DESIGN.md 8: 保存結果未確認・反映要復旧の情報は、通常の未保存操作として
    // 破棄しない。The dialog offers 確認 instead of 破棄 while one exists.
    if (pending !== null) {
      setSaveMessage(
        "保存結果が未確認のまま破棄はできません。「確認」で履歴を照合するか、JSON で書き出してください。",
      );
      return;
    }
    if (nav.kind === "disconnect" && recovery !== null) {
      setSaveMessage(
        "ローカルの復旧情報が残っているため接続を終了できません。復旧を終えるか、JSON で書き出してください。",
      );
      return;
    }
    setNavigation(null);
    setConflicts(null);
    setSaveMessage(null);
    setStaleReason(null);
    if (nav.kind === "disconnect") {
      disconnect();
      return;
    }
    setQueue([]);
    if (sessionStore && context) saveQueueTo(sessionStore, context, "", [], "");
    if (nav.kind === "dir") {
      setFile(null);
      void listDir(nav.dir);
      return;
    }
    setFile(null);
    void openFile(nav.path);
  };

  // -------------------------------------------------------------------
  // Recovery actions (local only)
  // -------------------------------------------------------------------
  const runRecovery = (action: "cancel" | "resolve" | "clear"): void => {
    if (!session?.local) return;
    const client = session.local;
    setBusy(true);
    setRecoveryError(null);
    void (async () => {
      try {
        if (action === "cancel") {
          rememberRecovery(session, await client.cancelPrepared());
          setReuseBatchId(null);
        } else if (action === "clear") {
          rememberRecovery(session, await client.clearRecovery());
        } else {
          const result = await client.resolveUnknown();
          rememberRecovery(session, result.recovery);
          if (result.resolved === "committed-complete" && file && result.commitId) {
            const base = await session.adapter.read([file.path], result.commitId);
            setFile({ path: file.path, base });
            setHead(base.revision);
            setQueue([]);
            setPending(null);
            setStaleReason(null);
            setNotice(`保存済みでした（${result.commitId.slice(0, 7)}）。`);
          } else if (result.resolved === "not-committed") {
            setNotice("コミットは作られていませんでした。同じ batchId で保存し直せます。");
          }
        }
        setSync(await client.sync());
      } catch (err) {
        setRecoveryError(adapterErrorMessage(errorKind(err), errorMessage(err)));
      } finally {
        setBusy(false);
      }
    })();
  };

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  if (!session) {
    return (
      <div class="app">
        {initialValues ? (
          <ConnectScreen
            initial={initialValues}
            busy={connectBusy}
            error={connectError}
            lookupAuthor={lookupAuthor}
            onConnect={connectGitHub}
          />
        ) : (
          <div class="screen">
            <p class="note">{connectError ?? "接続を準備しています..."}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div class="app">
      <Header
        mode={session.mode}
        label={session.label}
        branch={session.branch}
        path={file?.path ?? null}
        revision={file?.base.revision ?? (head.length > 0 ? head : null)}
        unsaved={queue.length}
        sync={sync}
        pendingBatch={pending !== null}
        recovery={recovery !== null}
        onDisconnect={() => requestNavigation({ kind: "disconnect" })}
        onOpenQueue={() => setQueueOpen(true)}
      />

      {notice ? (
        <div class="banner info">
          {notice}
          <button type="button" class="small ghost" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      ) : null}

      {recovery ? (
        <RecoveryPanel
          info={recovery}
          busy={busy}
          error={recoveryError}
          onRetrySave={() => void doSave()}
          onCancelPrepared={() => runRecovery("cancel")}
          onResolveUnknown={() => runRecovery("resolve")}
          onClearRecovery={() => runRecovery("clear")}
        />
      ) : null}

      <SavePanel
        conflicts={conflicts}
        pending={pending}
        message={saveMessage}
        busy={busy}
        onConfirmBatch={() => void doConfirmBatch()}
        onClose={() => {
          setConflicts(null);
          setSaveMessage(null);
        }}
      />

      {reauth ? (
        <aside class="panel reauth" role="dialog" aria-label="PAT の再入力">
          <div class="panel-head">
            <strong>PAT の再入力</strong>
            <button type="button" class="small ghost" onClick={() => setReauth(null)}>
              閉じる
            </button>
          </div>
          <p class="note">未保存の操作はそのまま保持しています。</p>
          <input
            type="password"
            value={reauthToken}
            autocomplete="off"
            onInput={(e) => setReauthToken((e.currentTarget as HTMLInputElement).value)}
          />
          <div class="panel-actions">
            <button
              type="button"
              class="primary"
              disabled={reauthToken.length === 0}
              onClick={() => {
                const adapter = new GitHubAdapter({
                  owner: reauth.owner,
                  repo: reauth.repo,
                  branch: reauth.branch,
                  token: reauthToken,
                });
                tokenRef.current = reauthToken;
                setSession({ ...session, adapter });
                setReauthToken("");
                setReauth(null);
                setSaveMessage(null);
              }}
            >
              再接続
            </button>
          </div>
        </aside>
      ) : null}

      {stripOpen && file ? (
        <StripDialog
          adapter={session.adapter as RepositoryAdapter}
          path={file.path}
          base={file.base}
          virtualSource={virtualSource}
          queueLength={queue.length}
          blockedReason={blockedReason}
          newBatchId={newId}
          onCommitted={(commitId) => {
            setStripOpen(false);
            setNotice(`刷り出しを保存しました（${commitId.slice(0, 7)}）。`);
            void doRefresh();
          }}
          onUnknown={(batchId, candidateCommitId) => {
            // DESIGN.md 7: exactly like an unknown save - record the batch and
            // let the user confirm it against the history before anything else.
            const record: PendingBatch =
              candidateCommitId === undefined
                ? { batchId, startedAt: new Date().toISOString() }
                : { batchId, candidateCommitId, startedAt: new Date().toISOString() };
            setPending(record);
            setStripOpen(false);
            setSaveMessage("刷り出しの保存結果を確認できませんでした。「確認」を押してください。");
            if (session.local) void refreshSync(session);
          }}
          onClose={() => setStripOpen(false)}
        />
      ) : null}

      {navigation ? (
        <aside
          class="panel confirm"
          role="dialog"
          aria-label={pending ? "保存結果未確認" : "未保存の操作"}
        >
          <div class="panel-head">
            <strong>
              {pending
                ? "保存結果が未確認です"
                : recovery
                  ? "復旧情報が残っています"
                  : "未保存の操作があります"}
            </strong>
          </div>
          <p class="note">
            {pending
              ? "コミットが作られたか分からないため、破棄はできません。「確認」で履歴の batchId を照合するか、JSON で書き出してください。"
              : recovery
                ? "ローカル反映の復旧情報は未保存の操作として破棄しません。復旧を終えるか、JSON で書き出してください。"
                : "保存・書き出し・破棄のいずれかを選んでください。"}
          </p>
          <div class="panel-actions">
            {pending ? (
              <button
                type="button"
                class="primary"
                disabled={busy || file === null}
                onClick={() => void doConfirmBatch()}
              >
                確認
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void doSave().then((ok) => {
                    if (ok) applyNavigation(navigation);
                  });
                }}
                disabled={busy || blockedReason !== null}
              >
                保存する
              </button>
            )}
            <button type="button" onClick={doExport}>
              書き出す
            </button>
            {pending === null && !(navigation.kind === "disconnect" && recovery !== null) ? (
              <button type="button" class="danger" onClick={() => applyNavigation(navigation)}>
                破棄して進む
              </button>
            ) : null}
            <button type="button" class="ghost" onClick={() => setNavigation(null)}>
              取消
            </button>
          </div>
        </aside>
      ) : null}

      {file ? (
        <DocumentView
          mode={session.mode}
          path={file.path}
          base={file.base}
          virtualSource={virtualSource}
          applyError={applyError}
          queue={queue}
          author={author}
          busy={busy}
          blockedReason={blockedReason}
          staleReason={staleReason}
          queueOpen={queueOpen}
          onQueueOpenChange={setQueueOpen}
          onAddOp={(op) => setQueue((prev) => [...prev, op])}
          onRemoveOp={(index) => setQueue((prev) => removeOperation(prev, index))}
          onAuthorChange={setAuthor}
          onSave={() => void doSave()}
          onRefresh={() => void doRefresh()}
          onPush={session.local ? () => void doPush() : null}
          onSaveAndPush={session.local ? () => void doSaveAndPush() : null}
          onExport={doExport}
          onImport={doImport}
          onOpenStrip={() => setStripOpen(true)}
          onBack={() => requestNavigation({ kind: "dir", dir: dirOf(file.path) })}
          loadImage={loadImage}
        />
      ) : (
        <FileBrowser
          dir={dir}
          entries={entries}
          busy={busy}
          error={browseError}
          onOpenDir={(next) => void listDir(next)}
          onOpenFile={(path) => requestNavigation({ kind: "file", path })}
          onReload={() => void listDir(dir, "")}
        />
      )}
    </div>
  );
}
