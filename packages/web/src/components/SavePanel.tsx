/**
 * Save outcome panel: held batches with their conflicts, and the
 * 「保存結果未確認」 confirmation step (DESIGN.md 7.1, 7.3).
 */
import type { VNode } from "preact";
import type { ConflictReport } from "../lib/save";
import type { PendingBatch } from "../lib/queue";
import { conflictReasonMessage } from "../lib/messages";
import { describeOperation } from "../lib/queue";

export interface SavePanelProps {
  conflicts: ConflictReport[] | null;
  pending: PendingBatch | null;
  message: string | null;
  busy: boolean;
  onConfirmBatch: () => void;
  onClose: () => void;
}

export function SavePanel(props: SavePanelProps): VNode | null {
  if (!props.conflicts && !props.pending && !props.message) return null;
  return (
    <aside class="panel save" role="dialog" aria-label="保存の状況">
      <div class="panel-head">
        <strong>保存の状況</strong>
        <button type="button" class="small ghost" onClick={props.onClose}>
          閉じる
        </button>
      </div>

      {props.pending ? (
        <div class="block danger">
          <p>
            <strong>保存結果未確認</strong>
          </p>
          <p class="meta">batchId: {props.pending.batchId}</p>
          {props.pending.candidateCommitId ? (
            <p class="meta">候補コミット: {props.pending.candidateCommitId.slice(0, 7)}</p>
          ) : null}
          <p class="note">
            コミットが成立したか分かりません。履歴を照合するまで、新しい保存は行いません。
          </p>
          <button type="button" class="primary" onClick={props.onConfirmBatch} disabled={props.busy}>
            確認
          </button>
        </div>
      ) : null}

      {props.message ? <p class="error">{props.message}</p> : null}

      {props.conflicts && props.conflicts.length > 0 ? (
        <div class="block">
          <p>
            <strong>競合のため保留しました（何もコミットしていません）</strong>
          </p>
          <ul class="conflicts">
            {props.conflicts.map((c, i) => (
              <li key={String(i)}>
                <span class="op-text">{describeOperation(c.op)}</span>
                <span class="reason">{conflictReasonMessage(c.reason)}</span>
              </li>
            ))}
          </ul>
          <p class="note">
            「最新」で本文を取り直し、対象を再指定してから保存し直してください。
          </p>
        </div>
      ) : null}
    </aside>
  );
}
