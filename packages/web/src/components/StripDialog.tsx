/**
 * 刷り出し (strip) dialog (DESIGN.md 5.4, 7.3).
 *
 * Blockers first, then a preview of the stripped body, the review log and its
 * path, then one commit carrying both changes and the batch trailer. If the
 * base revision moved, the preview is rebuilt instead of committing.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  formatCommitMessage,
  parseDocument,
  renderReviewLog,
  reviewLogPath,
  stripBlockersForSource,
  stripMarkers,
  type RepositoryAdapter,
  type Snapshot,
} from "@syuire/core";
import { errorKind, errorMessage } from "../lib/save";
import { adapterErrorMessage } from "../lib/messages";

export interface StripDialogProps {
  adapter: RepositoryAdapter;
  path: string;
  base: Snapshot;
  virtualSource: string;
  queueLength: number;
  /** Non-null when 保存 / 最新 / 反映 are blocked; strip is blocked with them. */
  blockedReason: string | null;
  newBatchId: () => string;
  onCommitted: (commitId: string) => void;
  /** DESIGN.md 7: an unknown ref-update result becomes a pending batch, like any save. */
  onUnknown: (batchId: string, candidateCommitId: string | undefined) => void;
  onClose: () => void;
}

interface Preview {
  batchId: string;
  strippedAt: Date;
  body: string;
  log: string;
  logPath: string;
  markerCount: number;
  blockMarkers: number;
  inlineMarkers: number;
  removedLines: number;
}

/** Result of the "the log path must not exist yet" probe (DESIGN.md 5.4). */
type LogPathCheck =
  | { status: "checking" }
  | { status: "free" }
  | { status: "taken" }
  | { status: "error"; message: string };

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\n/).length;
}

export function StripDialog(props: StripDialogProps): VNode {
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleBase, setStaleBase] = useState(false);
  const [logCheck, setLogCheck] = useState<LogPathCheck>({ status: "checking" });

  const doc = useMemo(() => parseDocument(props.virtualSource), [props.virtualSource]);

  const blockers = useMemo(() => {
    // stripBlockersForSource adds 対象未確認 markers to the format / unresolved
    // checks, so a comment whose target moved also stops the strip.
    const list = stripBlockersForSource(props.virtualSource);
    const extra: string[] = [];
    if (props.queueLength > 0) {
      extra.push(`未保存の操作が ${props.queueLength} 件あります`);
    }
    if (props.blockedReason !== null) extra.push(props.blockedReason);
    return [...extra, ...list];
  }, [props.virtualSource, props.queueLength, props.blockedReason]);

  const preview = useMemo<Preview | null>(() => {
    if (blockers.length > 0) return null;
    const batchId = props.newBatchId();
    const strippedAt = new Date();
    const body = stripMarkers(doc);
    const logPath = reviewLogPath(props.path, strippedAt, batchId);
    const log = renderReviewLog({
      originalPath: props.path,
      baseCommitId: props.base.revision,
      batchId,
      strippedAt,
      markers: doc.markers,
    });
    const blockMarkers = doc.markers.filter((m) => m.blockLevel).length;
    return {
      batchId,
      strippedAt,
      body,
      log,
      logPath,
      markerCount: doc.markers.length,
      blockMarkers,
      inlineMarkers: doc.markers.length - blockMarkers,
      removedLines: countLines(props.virtualSource) - countLines(body),
    };
    // `generation` deliberately re-creates the preview after a stale base.
  }, [doc, blockers, props.path, props.base.revision, generation]);

  // DESIGN.md 5.4「既存パスには上書きしない」: check before showing the preview,
  // not only at commit time, so the user is never offered a strip that would
  // overwrite an existing review log.
  const logPath = preview?.logPath ?? null;
  const revision = props.base.revision;
  const adapter = props.adapter;
  useEffect(() => {
    if (logPath === null) {
      setLogCheck({ status: "checking" });
      return;
    }
    let cancelled = false;
    setLogCheck({ status: "checking" });
    void (async () => {
      try {
        const snapshot = await adapter.read([logPath], revision);
        if (cancelled) return;
        setLogCheck(snapshot.files[logPath] ? { status: "taken" } : { status: "free" });
      } catch (err) {
        if (cancelled) return;
        setLogCheck({
          status: "error",
          message: adapterErrorMessage(errorKind(err), errorMessage(err)),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, logPath, revision]);

  const pathBlockers: string[] = [];
  if (preview !== null) {
    if (logCheck.status === "taken") {
      pathBlockers.push(`退避ログのパスがすでに存在します: ${preview.logPath}`);
    } else if (logCheck.status === "error") {
      pathBlockers.push(`退避ログのパスを確認できませんでした: ${logCheck.message}`);
    }
  }
  const allBlockers = [...blockers, ...pathBlockers];
  const canCommit = preview !== null && pathBlockers.length === 0 && logCheck.status === "free";

  const commit = (): void => {
    if (!preview || !canCommit) return;
    setBusy(true);
    setError(null);
    setStaleBase(false);
    void (async () => {
      try {
        const head = await props.adapter.head();
        if (head !== props.base.revision) {
          setStaleBase(true);
          setBusy(false);
          return;
        }
        // Re-check the log path against the tip we are about to build on.
        const existing = await props.adapter.read([preview.logPath], props.base.revision);
        if (existing.files[preview.logPath]) {
          setLogCheck({ status: "taken" });
          setBusy(false);
          return;
        }
        const result = await props.adapter.commit({
          base: props.base,
          changes: [
            { path: props.path, text: preview.body },
            { path: preview.logPath, text: preview.log },
          ],
          batchId: preview.batchId,
          message: formatCommitMessage(
            `syuire: 刷り出し ${preview.markerCount} 件`,
            preview.batchId,
          ),
        });
        setBusy(false);
        if (result.status === "unknown") {
          props.onUnknown(result.batchId, result.candidateCommitId);
          setError(
            "保存結果を確認できませんでした。「確認」で履歴の batchId を照合してください。",
          );
          return;
        }
        if (result.localReflection === "needs-recovery") {
          setError(`コミット済み・ローカル反映要復旧: ${result.reason}`);
          return;
        }
        props.onCommitted(result.commitId);
      } catch (err) {
        setBusy(false);
        setError(adapterErrorMessage(errorKind(err), errorMessage(err)));
      }
    })();
  };

  return (
    <aside class="panel strip" role="dialog" aria-label="刷り出し">
      <div class="panel-head">
        <strong>刷り出し</strong>
        <button type="button" class="small ghost" onClick={props.onClose}>
          閉じる
        </button>
      </div>

      {allBlockers.length > 0 ? (
        <div class="block danger">
          <p>
            <strong>刷り出しできません</strong>
          </p>
          <ul class="blockers">
            {allBlockers.map((b, i) => (
              <li key={String(i)}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview ? (
        <div class="block">
          <p class="meta">出力先: {props.path}</p>
          <p class="meta">退避ログ: {preview.logPath}</p>
          <p class="meta">batchId: {preview.batchId}</p>
          <p class="note">
            マーカー {preview.markerCount} 件を削除（マーカー行 {preview.blockMarkers} 行 / 行内{" "}
            {preview.inlineMarkers} 個）、行数 {preview.removedLines} 行減少
          </p>
          <details open>
            <summary>除去後の本文</summary>
            <pre class="preview">{preview.body}</pre>
          </details>
          <details>
            <summary>退避ログ</summary>
            <pre class="preview">{preview.log}</pre>
          </details>
          {staleBase ? (
            <p class="error">
              基準版が変わりました。プレビューを作り直してから保存してください。
            </p>
          ) : null}
          {error ? <p class="error">{error}</p> : null}
          <div class="panel-actions">
            {staleBase ? (
              <button
                type="button"
                onClick={() => {
                  setStaleBase(false);
                  setGeneration((g) => g + 1);
                }}
              >
                プレビューを作り直す
              </button>
            ) : (
              <button
                type="button"
                class="primary"
                onClick={commit}
                disabled={busy || !canCommit}
              >
                {busy ? "保存中..." : logCheck.status === "checking" ? "確認中..." : "1 コミットで保存"}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
