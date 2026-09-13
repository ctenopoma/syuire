/**
 * Side panel with three tabs: the heading outline, the list of comments,
 * and the display preferences (DESIGN.md 6).
 */
import { useState } from "preact/hooks";
import type { VNode } from "preact";
import type { Comment } from "@syuire/core";
import type { OutlineEntry } from "./MarkdownRenderer";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, type Prefs } from "../lib/settings";

export interface CommentRow {
  number: number;
  comment: Comment;
  changed: boolean;
}

export type OutlineTab = "outline" | "comments" | "display";

export interface OutlinePanelProps {
  tab: OutlineTab;
  onTabChange: (tab: OutlineTab) => void;
  outline: OutlineEntry[];
  comments: CommentRow[];
  activeCommentId: string | null;
  prefs: Prefs;
  onPrefsChange: (prefs: Prefs) => void;
  onJumpHeading: (id: string) => void;
  onJumpComment: (id: string) => void;
  onClose: () => void;
}

function shorten(text: string, max: number): string {
  const cps = Array.from(text.replace(/\s+/g, " ").trim());
  return cps.length <= max ? cps.join("") : `${cps.slice(0, max).join("")}…`;
}

export function OutlinePanel(props: OutlinePanelProps): VNode {
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const openCount = props.comments.filter((c) => c.comment.state !== "resolved").length;
  const rows = props.comments.filter((c) =>
    filter === "all" ? true : filter === "open" ? c.comment.state !== "resolved" : c.comment.state === "resolved",
  );
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]): void =>
    props.onPrefsChange({ ...props.prefs, [key]: value });

  return (
    <aside class="panel outline" role="dialog" aria-label="目次と朱の一覧">
      <div class="panel-head">
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={props.tab === "outline"}
            class={props.tab === "outline" ? "tab active" : "tab"}
            onClick={() => props.onTabChange("outline")}
          >
            目次
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.tab === "comments"}
            class={props.tab === "comments" ? "tab active" : "tab"}
            onClick={() => props.onTabChange("comments")}
          >
            朱 {openCount}/{props.comments.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.tab === "display"}
            class={props.tab === "display" ? "tab active" : "tab"}
            onClick={() => props.onTabChange("display")}
          >
            表示
          </button>
        </div>
        <button type="button" class="small ghost" onClick={props.onClose}>
          閉じる
        </button>
      </div>

      {props.tab === "outline" ? (
        props.outline.length === 0 ? (
          <p class="note">見出しがありません。</p>
        ) : (
          <ul class="toc">
            {props.outline.map((h) => (
              <li key={h.id} class={`toc-h${Math.min(6, h.depth)}`}>
                <button type="button" class="toc-item" onClick={() => props.onJumpHeading(h.id)}>
                  {h.text.length > 0 ? h.text : "（無題）"}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {props.tab === "comments" ? (
        <>
          <div class="seg" role="group" aria-label="絞り込み">
            {(["all", "open", "resolved"] as const).map((f) => (
              <button
                key={f}
                type="button"
                class={filter === f ? "seg-item active" : "seg-item"}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "すべて" : f === "open" ? "未解決" : "解決済み"}
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <p class="note">該当する朱がありません。</p>
          ) : (
            <ul class="comment-list">
              {rows.map((row) => {
                const c = row.comment;
                const resolved = c.state === "resolved";
                return (
                  <li key={c.id} class={props.activeCommentId === c.id ? "active" : undefined}>
                    <button type="button" class="comment-item" onClick={() => props.onJumpComment(c.id)}>
                      <span class={`marker-badge static${row.changed ? " marker-changed" : ""}`}>{row.number}</span>
                      <span class="comment-body">
                        <span class="comment-anchor">
                          {c.anchor.length > 0 ? shorten(c.anchor, 28) : "（ブロックへの朱）"}
                        </span>
                        <span class="comment-text">{shorten(c.text, 60)}</span>
                        <span class="meta">
                          {c.author}
                          {c.replies.length > 0 ? ` ・ 返信 ${c.replies.length}` : ""}
                          {resolved ? " ・ 解決済み" : ""}
                          {row.changed ? " ・ 対象変更あり" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}

      {props.tab === "display" ? (
        <div class="display-prefs">
          <div class="pref-row">
            <span>文字の大きさ</span>
            <span class="stepper">
              <button
                type="button"
                class="small"
                aria-label="小さく"
                disabled={props.prefs.fontSize <= FONT_SIZE_MIN}
                onClick={() => set("fontSize", Math.max(FONT_SIZE_MIN, props.prefs.fontSize - 1))}
              >
                A−
              </button>
              <span class="stepper-value">{props.prefs.fontSize}px</span>
              <button
                type="button"
                class="small"
                aria-label="大きく"
                disabled={props.prefs.fontSize >= FONT_SIZE_MAX}
                onClick={() => set("fontSize", Math.min(FONT_SIZE_MAX, props.prefs.fontSize + 1))}
              >
                A+
              </button>
            </span>
          </div>
          <div class="pref-row">
            <span>配色</span>
            <span class="seg" role="group" aria-label="配色">
              {(["auto", "light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  class={props.prefs.theme === t ? "seg-item active" : "seg-item"}
                  aria-pressed={props.prefs.theme === t}
                  onClick={() => set("theme", t)}
                >
                  {t === "auto" ? "端末に合わせる" : t === "light" ? "明るい" : "暗い"}
                </button>
              ))}
            </span>
          </div>
          <label class="check">
            <input
              type="checkbox"
              checked={props.prefs.highlightCode}
              onChange={(e) => set("highlightCode", (e.currentTarget as HTMLInputElement).checked)}
            />
            <span>コードに色を付ける</span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={props.prefs.autoImages}
              onChange={(e) => set("autoImages", (e.currentTarget as HTMLInputElement).checked)}
            />
            <span>
              リポジトリ内の画像を自動で読み込む
              <span class="hint block">開いている版から取得します。外部の画像は取得しません。</span>
            </span>
          </label>
        </div>
      ) : null}
    </aside>
  );
}
