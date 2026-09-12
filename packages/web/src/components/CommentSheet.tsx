/**
 * Bottom sheet for writing a comment or a reply (DESIGN.md 6).
 *
 * Fixed to the bottom above the toolbar so the iPad selection menu is not in
 * the way. The selection captured before the sheet opened stays in App state,
 * because focusing the textarea collapses the DOM selection.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";

export interface CommentSheetProps {
  title: string;
  /** Quoted display text (anchor) shown above the textarea. */
  quote: string | null;
  prefix?: string;
  suffix?: string;
  note: string | null;
  author: string;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (text: string, author: string) => void;
  onCancel: () => void;
}

export function CommentSheet(props: CommentSheetProps): VNode {
  const [text, setText] = useState("");
  const [author, setAuthor] = useState(props.author);
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    area.current?.focus();
  }, []);

  return (
    <div class="sheet" role="dialog" aria-label={props.title}>
      <div class="sheet-head">
        <strong>{props.title}</strong>
        <button type="button" class="small ghost" onClick={props.onCancel}>
          閉じる
        </button>
      </div>
      {props.quote !== null ? (
        <p class="quote">
          {props.prefix ? <span class="ctx">{props.prefix}</span> : null}
          <mark>{props.quote}</mark>
          {props.suffix ? <span class="ctx">{props.suffix}</span> : null}
        </p>
      ) : null}
      {props.note ? <p class="note">{props.note}</p> : null}
      <textarea
        ref={area}
        rows={4}
        value={text}
        placeholder="コメントを書く"
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
      />
      <label class="inline">
        <span>author</span>
        <input
          value={author}
          autocomplete="off"
          onInput={(e) => setAuthor((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      {props.error ? <p class="error">{props.error}</p> : null}
      <div class="sheet-actions">
        <button type="button" class="ghost" onClick={props.onCancel}>
          取消
        </button>
        <button
          type="button"
          class="primary"
          disabled={props.busy || text.trim().length === 0 || author.trim().length === 0}
          onClick={() => props.onSubmit(text, author.trim())}
        >
          {props.submitLabel}
        </button>
      </div>
    </div>
  );
}
