/**
 * Reading view: rendered manuscript, selection capture, bottom toolbar and the
 * sheets/panels that hang off it (DESIGN.md 6, 7.3).
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  buildTextMap,
  createAddCommentOp,
  createAddReplyOp,
  createReanchorOp,
  createSetStateOp,
  markerStatuses,
  parseDocument,
  prepareSelection,
  type Comment,
  type Operation,
  type Snapshot,
  type SourceRange,
} from "@syuire/core";
import { MarkdownRenderer, type RendererContext } from "./MarkdownRenderer";
import { CommentSheet } from "./CommentSheet";
import { ThreadPanel } from "./ThreadPanel";
import { QueuePanel } from "./QueuePanel";
import { asDomNode, selectionToSourceRange } from "../lib/selection";
import { conflictReasonMessage, selectionFailureMessage } from "../lib/messages";
import { localIsoTimestamp, newId } from "../lib/time";

export interface DocumentViewProps {
  mode: "github" | "local";
  path: string;
  base: Snapshot;
  virtualSource: string;
  applyError: string | null;
  queue: Operation[];
  author: string;
  busy: boolean;
  /** Non-null when 保存 / 最新 / push must stay disabled (recovery, unknown batch). */
  blockedReason: string | null;
  /** Non-null when the displayed body is known to be out of date (DESIGN.md 4.1). */
  staleReason: string | null;
  queueOpen: boolean;
  onQueueOpenChange: (open: boolean) => void;
  onAddOp: (op: Operation) => void;
  onRemoveOp: (index: number) => void;
  onAuthorChange: (author: string) => void;
  onSave: () => void;
  onRefresh: () => void;
  onPush: (() => void) | null;
  onSaveAndPush: (() => void) | null;
  onExport: () => void;
  onImport: (file: File) => void;
  onOpenStrip: () => void;
  onBack: () => void;
  loadImage: (url: string) => Promise<string>;
}

const FLOW_LABELS: Record<string, string> = {
  paragraph: "段落",
  heading: "見出し",
  table: "表",
  code: "コードブロック",
  blockquote: "引用",
  list: "リスト",
  html: "HTML ブロック",
  listItem: "リスト項目",
};

function flowLabel(flowType: string): string {
  return FLOW_LABELS[flowType] ?? flowType;
}

type SheetState =
  | { kind: "none" }
  | { kind: "comment" }
  | { kind: "reply"; commentId: string };

export function DocumentView(props: DocumentViewProps): VNode {
  const container = useRef<HTMLDivElement | null>(null);
  const [lastSelection, setLastSelection] = useState<SourceRange | null>(null);
  const [sheet, setSheet] = useState<SheetState>({ kind: "none" });
  const [threadId, setThreadId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const tm = useMemo(() => buildTextMap(props.virtualSource), [props.virtualSource]);
  const doc = useMemo(() => parseDocument(props.virtualSource), [props.virtualSource]);

  const info = useMemo(() => {
    const numbers = new Map<number, number>();
    const ids = new Map<number, string>();
    const gutter = new Map<number, number[]>();
    const changed = new Set<string>();
    const byId = new Map<string, { number: number; comment: Comment }>();
    const statuses = markerStatuses(props.virtualSource);
    statuses.forEach((status, index) => {
      const n = index + 1;
      const occ = status.occurrence;
      numbers.set(occ.start, n);
      ids.set(occ.start, occ.comment.id);
      byId.set(occ.comment.id, { number: n, comment: occ.comment });
      if (status.status !== "ok") changed.add(occ.comment.id);
      if (status.block) {
        const key = status.block.flowRange.start;
        const list = gutter.get(key);
        if (list) list.push(n);
        else gutter.set(key, [n]);
      }
    });
    return { numbers, ids, gutter, changed, byId };
  }, [props.virtualSource]);

  // The rendered offsets change with the source, so a stale selection must go.
  useEffect(() => {
    setLastSelection(null);
  }, [props.virtualSource]);

  useEffect(() => {
    const onSelectionChange = (): void => {
      const root = container.current;
      if (!root) return;
      const selection = document.getSelection();
      if (!selection) return;
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;
      if (!anchor || !focus) return;
      if (!root.contains(anchor) || !root.contains(focus)) return;
      const range = selectionToSourceRange(
        asDomNode(anchor),
        selection.anchorOffset,
        asDomNode(focus),
        selection.focusOffset,
      );
      // Keep the previous range when the selection collapses: focusing the
      // sheet clears the DOM selection on iPad (DESIGN.md 6).
      if (range) setLastSelection(range);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const prepared = useMemo(() => {
    if (!lastSelection) return null;
    return prepareSelection(tm, lastSelection);
  }, [tm, lastSelection]);

  const selectionNote = (() => {
    if (!prepared) return "本文を選択してください";
    if (!prepared.ok) return selectionFailureMessage(prepared.reason);
    return prepared.blockOnly
      ? `${flowLabel(prepared.placement.flowType)}への朱`
      : `「${prepared.anchor}」への朱`;
  })();

  const canComment = prepared !== null && prepared.ok;

  const rendererContext: RendererContext = {
    tm,
    markerNumbers: info.numbers,
    markerIds: info.ids,
    gutter: info.gutter,
    changed: info.changed,
    onMarkerClick: (id) => {
      setThreadId(id);
      setSheet({ kind: "none" });
    },
    loadImage: props.loadImage,
  };

  const submitComment = (text: string, author: string): void => {
    if (!lastSelection) return;
    setActionError(null);
    const result = createAddCommentOp(props.virtualSource, lastSelection, {
      id: newId(),
      text,
      author,
      timestamp: localIsoTimestamp(),
    });
    if (!result.ok) {
      setActionError(conflictReasonMessage(result.reason));
      return;
    }
    props.onAuthorChange(author);
    props.onAddOp(result.op);
    setSheet({ kind: "none" });
  };

  const submitReply = (commentId: string, text: string, author: string): void => {
    setActionError(null);
    props.onAuthorChange(author);
    props.onAddOp(
      createAddReplyOp(commentId, {
        id: newId(),
        author,
        timestamp: localIsoTimestamp(),
        text,
      }),
    );
    setSheet({ kind: "none" });
  };

  const changeState = (commentId: string, to: "open" | "resolved"): void => {
    setActionError(null);
    const result = createSetStateOp(props.virtualSource, commentId, to);
    if (!("kind" in result)) {
      setActionError(conflictReasonMessage(result.reason));
      return;
    }
    props.onAddOp(result);
  };

  const reanchor = (commentId: string): void => {
    setActionError(null);
    if (!lastSelection) {
      setActionError("本文で新しい範囲を選んでください。");
      return;
    }
    const result = createReanchorOp(props.virtualSource, commentId, lastSelection);
    if (!("kind" in result)) {
      setActionError(conflictReasonMessage(result.reason));
      return;
    }
    props.onAddOp(result);
    setThreadId(null);
  };

  const thread = threadId === null ? null : info.byId.get(threadId);

  return (
    <div class="screen document">
      {doc.errors.length > 0 ? (
        <div class="banner danger">
          形式エラーが {doc.errors.length} 件あります。読取専用として表示しています。
        </div>
      ) : null}
      {props.applyError ? <div class="banner danger">{props.applyError}</div> : null}
      {props.blockedReason ? <div class="banner danger">{props.blockedReason}</div> : null}
      {props.staleReason ? <div class="banner danger">{props.staleReason}</div> : null}

      <div class="doc-scroll" ref={container}>
        <MarkdownRenderer ctx={rendererContext} />
      </div>

      {sheet.kind === "comment" ? (
        <CommentSheet
          title="朱を追加"
          quote={prepared && prepared.ok ? prepared.anchor : null}
          prefix={prepared && prepared.ok ? prepared.prefix : ""}
          suffix={prepared && prepared.ok ? prepared.suffix : ""}
          note={selectionNote}
          author={props.author}
          busy={props.busy}
          error={actionError}
          submitLabel="追加"
          onSubmit={submitComment}
          onCancel={() => setSheet({ kind: "none" })}
        />
      ) : null}

      {sheet.kind === "reply" ? (
        <CommentSheet
          title="返信"
          quote={info.byId.get(sheet.commentId)?.comment.anchor ?? null}
          note={null}
          author={props.author}
          busy={props.busy}
          error={actionError}
          submitLabel="返信を追加"
          onSubmit={(text, author) => submitReply(sheet.commentId, text, author)}
          onCancel={() => setSheet({ kind: "none" })}
        />
      ) : null}

      {thread ? (
        <ThreadPanel
          number={thread.number}
          comment={thread.comment}
          changed={info.changed.has(thread.comment.id)}
          canReanchor={lastSelection !== null}
          busy={props.busy}
          error={actionError}
          onReply={() => setSheet({ kind: "reply", commentId: thread.comment.id })}
          onSetState={(to) => changeState(thread.comment.id, to)}
          onReanchor={() => reanchor(thread.comment.id)}
          onClose={() => setThreadId(null)}
        />
      ) : null}

      {props.queueOpen ? (
        <QueuePanel
          ops={props.queue}
          baseRevision={props.base.revision}
          applyError={props.applyError}
          onRemove={props.onRemoveOp}
          onExport={props.onExport}
          onImport={props.onImport}
          onClose={() => props.onQueueOpenChange(false)}
        />
      ) : null}

      <div class="toolbar">
        <button type="button" class="ghost" onClick={props.onBack}>
          ファイル
        </button>
        <button
          type="button"
          class="primary grow"
          disabled={!canComment || props.busy}
          title={selectionNote}
          onClick={() => {
            setActionError(null);
            setSheet({ kind: "comment" });
            setThreadId(null);
          }}
        >
          朱を追加
        </button>
        <button
          type="button"
          disabled={props.busy || props.blockedReason !== null || props.queue.length === 0}
          onClick={props.onSave}
        >
          保存
        </button>
        <button
          type="button"
          disabled={props.busy || props.blockedReason !== null}
          onClick={props.onRefresh}
        >
          最新
        </button>
        <button type="button" class="ghost" onClick={() => setMenuOpen((v) => !v)}>
          ⋯
        </button>
      </div>
      <p class="selection-note">{selectionNote}</p>

      {menuOpen ? (
        <div class="menu">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              props.onQueueOpenChange(true);
            }}
          >
            未保存 {props.queue.length} 件
          </button>
          <button
            type="button"
            disabled={props.blockedReason !== null}
            onClick={() => {
              setMenuOpen(false);
              props.onOpenStrip();
            }}
          >
            刷り出し
          </button>
          {props.onPush ? (
            <button
              type="button"
              disabled={props.blockedReason !== null}
              onClick={() => {
                setMenuOpen(false);
                props.onPush?.();
              }}
            >
              GitHub に反映
            </button>
          ) : null}
          {props.onSaveAndPush ? (
            <button
              type="button"
              disabled={props.blockedReason !== null}
              onClick={() => {
                setMenuOpen(false);
                props.onSaveAndPush?.();
              }}
            >
              保存して GitHub に反映
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              props.onExport();
            }}
          >
            JSON で書き出し
          </button>
        </div>
      ) : null}
    </div>
  );
}
