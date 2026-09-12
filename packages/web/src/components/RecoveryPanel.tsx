/**
 * Local recovery panel (DESIGN.md 7.2 部分失敗と状態).
 *
 * Each phase maps to the actions the table allows:
 * - 準備済み・未コミット: 再保存または明示的な取消可 (保存 stays enabled).
 * - 保存結果未確認: 履歴照合まで新規保存・pull・push 禁止.
 * - コミット済み・ローカル反映要復旧: 再コミットしない。新規保存・pull・push 禁止.
 */
import type { VNode } from "preact";
import type { LocalRecoveryInfo } from "@syuire/core";
import { recoveryPhaseLabel } from "../lib/messages";

export interface RecoveryPanelProps {
  info: LocalRecoveryInfo;
  busy: boolean;
  error: string | null;
  /** Re-run the save with the same batchId (prepared-uncommitted only). */
  onRetrySave: () => void;
  onCancelPrepared: () => void;
  onResolveUnknown: () => void;
  onClearRecovery: () => void;
}

function phaseNote(phase: LocalRecoveryInfo["phase"]): string {
  switch (phase) {
    case "prepared-uncommitted":
      return "コミットは成立していません。同じ batchId で再試行するか、準備した変更を取り消せます。";
    case "result-unknown":
      return "コミットの成否が不明です。履歴を照合するまで 保存 / 最新 / GitHub に反映 は行いません。";
    case "committed-needs-recovery":
      return "コミットは確定しています。再コミットはせず、復旧が終わるまで 保存 / 最新 / GitHub に反映 は行いません。";
    default:
      return "";
  }
}

export function RecoveryPanel(props: RecoveryPanelProps): VNode {
  const info = props.info;
  return (
    <section class="panel recovery" aria-label="復旧">
      <div class="panel-head">
        <strong class="danger">{recoveryPhaseLabel(info.phase)}</strong>
      </div>
      <p class="meta">batchId: {info.batchId}</p>
      <p class="meta">基準コミット: {info.baseCommitId.slice(0, 7)}</p>
      {info.newCommitId ? <p class="meta">作成コミット: {info.newCommitId.slice(0, 7)}</p> : null}
      <p class="meta">対象: {info.paths.join(", ")}</p>
      {info.reason ? <p class="note">{info.reason}</p> : null}
      <p class="note">{phaseNote(info.phase)}</p>
      {props.error ? <p class="error">{props.error}</p> : null}
      <div class="panel-actions">
        {info.phase === "prepared-uncommitted" ? (
          <>
            <button
              type="button"
              class="primary"
              onClick={props.onRetrySave}
              disabled={props.busy}
            >
              再試行
            </button>
            <button type="button" onClick={props.onCancelPrepared} disabled={props.busy}>
              準備した変更を取り消す
            </button>
          </>
        ) : null}
        {info.phase === "result-unknown" ? (
          <button type="button" onClick={props.onResolveUnknown} disabled={props.busy}>
            履歴を照合する
          </button>
        ) : null}
        {info.phase === "committed-needs-recovery" ? (
          <button type="button" onClick={props.onClearRecovery} disabled={props.busy}>
            復旧済みにする
          </button>
        ) : null}
      </div>
    </section>
  );
}
