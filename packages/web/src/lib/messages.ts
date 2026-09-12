/**
 * Japanese wording for adapter error kinds, selection failures and conflict
 * reasons. Kept in one place so no raw reason string reaches the UI.
 */
import type { AdapterErrorKind, SyncState } from "@syuire/core";
import type { SelectionFailure } from "@syuire/core";

export function selectionFailureMessage(reason: SelectionFailure): string {
  switch (reason) {
    case "multi-block":
      return "複数ブロックにまたがっています。範囲を選び直してください。";
    case "empty-selection":
      return "選択が空です。文字を選んでください。";
    case "front-matter":
      return "フロントマターは朱入れの対象外です。";
    case "no-block":
      return "本文の中を選んでください。";
    default:
      return "この範囲には朱を付けられません。";
  }
}

export function conflictReasonMessage(reason: string): string {
  switch (reason) {
    case "anchor-not-found":
      return "引用した箇所が見つかりません（本文が変更されました）";
    case "ambiguous-anchor":
      return "引用した箇所を一つに絞れません。対象を再指定してください";
    case "comment-missing":
      return "対象のコメントが本文にありません";
    case "id-conflict":
      return "同じ ID の別のコメントがあります";
    case "reply-id-conflict":
      return "同じ ID の別の返信があります";
    case "already-in-target-state":
      return "すでにその状態です";
    case "state-changed":
      return "外部から状態が変更されました";
    case "thread-changed":
      return "確認後にスレッドが変更されました";
    case "body-changed":
      return "確認後に対象の本文が変更されました";
    case "block-missing":
      return "対象のブロックが見つかりません";
    case "anchor-changed":
      return "対象の引用が変更されています";
    case "document-readonly":
      return "形式エラーがあるため読取専用です";
    default:
      return reason;
  }
}

export function adapterErrorMessage(kind: AdapterErrorKind, message: string): string {
  switch (kind) {
    case "auth":
      return `認証エラー: ${message}`;
    case "permission":
      return `権限がありません: ${message}`;
    case "conflict":
      return `競合: ${message}`;
    case "rate-limit":
      return `レート制限: ${message}`;
    case "too-large":
      return `サイズ上限を超えています: ${message}`;
    case "not-found":
      return `見つかりません: ${message}`;
    case "worktree-dirty":
      return `作業ツリーに未コミットの変更があります: ${message}`;
    case "worktree-recovery":
      return `作業ツリーの復旧が必要です: ${message}`;
    case "commit-failed":
      return `コミットできませんでした: ${message}`;
    case "repo-state":
      return `リポジトリの状態を確認してください: ${message}`;
    case "network":
      return `通信エラー: ${message}`;
    case "validation":
      return `入力が不正です: ${message}`;
    case "internal":
      return `内部エラー: ${message}`;
    default:
      return message;
  }
}

export function syncStateLabel(state: SyncState): string {
  switch (state) {
    case "in-sync":
      return "同期済み";
    case "remote-ahead":
      return "リモートが先行";
    case "local-ahead":
      return "ローカルが先行";
    case "diverged":
      return "分岐";
    case "no-upstream":
      return "upstream 未設定";
    case "repo-busy":
      return "リポジトリ操作中";
    case "unknown":
      return "不明";
    default:
      return state;
  }
}

export function recoveryPhaseLabel(
  phase: "prepared-uncommitted" | "result-unknown" | "committed-needs-recovery",
): string {
  switch (phase) {
    case "prepared-uncommitted":
      return "準備済み・未コミット";
    case "result-unknown":
      return "保存結果未確認";
    case "committed-needs-recovery":
      return "コミット済み・ローカル反映要復旧";
    default:
      return phase;
  }
}

export function markerStatusLabel(status: "ok" | "moved" | "changed"): string | null {
  return status === "ok" ? null : "対象変更あり";
}
