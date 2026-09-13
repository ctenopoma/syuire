/**
 * PAT field (DESIGN.md 8).
 *
 * Typing a fine-grained token on a tablet is error-prone, so the field offers
 * a paste button (clipboard read needs a user gesture and may be refused),
 * a show / hide toggle for checking the last characters, and strips every
 * whitespace character a copy from a mail or a note may carry. The value is
 * never echoed anywhere else.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";

export interface TokenInputProps {
  value: string;
  onInput: (token: string) => void;
  /** Called after a paste or when the field loses focus with a value. */
  onCommit?: (token: string) => void;
  autofocus?: boolean;
  disabled?: boolean;
  id?: string;
}

export function cleanToken(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export function TokenInput(props: TokenInputProps): VNode {
  const [visible, setVisible] = useState(false);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (props.autofocus) input.current?.focus();
  }, [props.autofocus]);

  const canPaste =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard !== "undefined" &&
    typeof navigator.clipboard.readText === "function";

  const paste = async (): Promise<void> => {
    setPasteNote(null);
    try {
      const text = cleanToken(await navigator.clipboard.readText());
      if (text.length === 0) {
        setPasteNote("クリップボードが空です。");
        return;
      }
      props.onInput(text);
      props.onCommit?.(text);
    } catch {
      setPasteNote("クリップボードを読めませんでした。入力欄に長押しで貼り付けてください。");
      input.current?.focus();
    }
  };

  return (
    <div class="token-field">
      <div class="token-row">
        <input
          ref={input}
          id={props.id}
          type={visible ? "text" : "password"}
          value={props.value}
          disabled={props.disabled}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          inputMode="text"
          placeholder="github_pat_…"
          aria-label="fine-grained PAT"
          onInput={(e) => props.onInput(cleanToken((e.currentTarget as HTMLInputElement).value))}
          onPaste={(e) => {
            const text = e.clipboardData?.getData("text");
            if (text === undefined) return;
            e.preventDefault();
            const cleaned = cleanToken(text);
            props.onInput(cleaned);
            props.onCommit?.(cleaned);
          }}
          onBlur={() => {
            if (props.value.length > 0) props.onCommit?.(props.value);
          }}
        />
        <button
          type="button"
          class="small ghost"
          aria-pressed={visible}
          title={visible ? "隠す" : "表示する"}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? "隠す" : "表示"}
        </button>
        {canPaste ? (
          <button type="button" class="small" onClick={() => void paste()} disabled={props.disabled}>
            貼り付け
          </button>
        ) : null}
      </div>
      {pasteNote ? <p class="note">{pasteNote}</p> : null}
    </div>
  );
}
