/**
 * "未保存" panel: the operation queue with per-item removal, plus JSON export
 * and import (DESIGN.md 7.3, 8).
 */
import { useRef } from "preact/hooks";
import type { VNode } from "preact";
import type { Operation } from "@syuire/core";
import { describeOperation } from "../lib/queue";

export interface QueuePanelProps {
  ops: Operation[];
  baseRevision: string;
  applyError: string | null;
  onRemove: (index: number) => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onClose: () => void;
}

export function QueuePanel(props: QueuePanelProps): VNode {
  const input = useRef<HTMLInputElement | null>(null);

  return (
    <aside class="panel queue" role="dialog" aria-label="未保存の操作">
      <div class="panel-head">
        <strong>未保存 {props.ops.length} 件</strong>
        <button type="button" class="small ghost" onClick={props.onClose}>
          閉じる
        </button>
      </div>
      <p class="meta">基準版 {props.baseRevision.slice(0, 7)}</p>
      {props.applyError ? <p class="error">{props.applyError}</p> : null}
      {props.ops.length === 0 ? (
        <p class="note">未保存の操作はありません。</p>
      ) : (
        <ol class="ops">
          {props.ops.map((op, i) => (
            <li key={`${op.kind}:${i}`}>
              <span class="op-kind">{op.kind}</span>
              <span class="op-text">{describeOperation(op)}</span>
              <button type="button" class="small ghost" onClick={() => props.onRemove(i)}>
                取り除く
              </button>
            </li>
          ))}
        </ol>
      )}
      <div class="panel-actions">
        <button type="button" onClick={props.onExport} disabled={props.ops.length === 0}>
          JSON で書き出し
        </button>
        <button type="button" onClick={() => input.current?.click()}>
          JSON を読み込み
        </button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const target = e.currentTarget as HTMLInputElement;
            const file = target.files?.[0];
            if (file) props.onImport(file);
            target.value = "";
          }}
        />
      </div>
    </aside>
  );
}
