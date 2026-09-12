/**
 * Thread panel for one marker: quote with context, body, replies, state and the
 * 返信 / 解決 / 再オープン / 対象を再指定 actions (DESIGN.md 5.3, 7.3).
 */
import type { VNode } from "preact";
import type { Comment } from "@akaire/core";

export interface ThreadPanelProps {
  number: number;
  comment: Comment;
  /** "changed" / "moved" markers show 「対象変更あり」. */
  changed: boolean;
  /** A selection is available for 対象を再指定. */
  canReanchor: boolean;
  busy: boolean;
  error: string | null;
  onReply: () => void;
  onSetState: (to: "open" | "resolved") => void;
  onReanchor: () => void;
  onClose: () => void;
}

export function ThreadPanel(props: ThreadPanelProps): VNode {
  const c = props.comment;
  const resolved = c.state === "resolved";
  return (
    <aside class="panel thread" role="dialog" aria-label={`コメント ${props.number}`}>
      <div class="panel-head">
        <strong>
          <span class="marker-badge static">{props.number}</span> コメント
        </strong>
        <button type="button" class="small ghost" onClick={props.onClose}>
          閉じる
        </button>
      </div>

      <p class="quote">
        <span class="ctx">{c.prefix}</span>
        <mark>{c.anchor}</mark>
        <span class="ctx">{c.suffix}</span>
      </p>
      {props.changed ? <p class="chip danger">対象変更あり</p> : null}

      <p class="thread-text">{c.text}</p>
      <p class="meta">
        {c.author} ・ {c.timestamp} ・{" "}
        <span class={resolved ? "chip ok" : "chip"}>{resolved ? "resolved" : "open"}</span>
      </p>

      {c.replies.length > 0 ? (
        <ul class="replies">
          {c.replies.map((r) => (
            <li key={r.id}>
              <p class="thread-text">{r.text}</p>
              <p class="meta">
                {r.author} ・ {r.timestamp}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {props.error ? <p class="error">{props.error}</p> : null}

      <div class="panel-actions">
        <button type="button" onClick={props.onReply} disabled={props.busy}>
          返信
        </button>
        <button
          type="button"
          onClick={() => props.onSetState(resolved ? "open" : "resolved")}
          disabled={props.busy}
        >
          {resolved ? "再オープン" : "解決"}
        </button>
        <button
          type="button"
          onClick={props.onReanchor}
          disabled={props.busy || !props.canReanchor}
          title={props.canReanchor ? "" : "本文で新しい範囲を選んでください"}
        >
          対象を再指定
        </button>
      </div>
    </aside>
  );
}
