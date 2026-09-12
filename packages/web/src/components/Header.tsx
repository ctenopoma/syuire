/**
 * Header: repository, branch, file, unsaved count, save target and sync state
 * (DESIGN.md 6, 4.2).
 */
import type { VNode } from "preact";
import type { SyncStatus } from "@akaire/core";
import { syncStateLabel } from "../lib/messages";

export interface HeaderProps {
  mode: "github" | "local";
  label: string;
  branch: string;
  path: string | null;
  revision: string | null;
  unsaved: number;
  sync: SyncStatus | null;
  pendingBatch: boolean;
  recovery: boolean;
  onDisconnect: () => void;
  onOpenQueue: () => void;
}

function shortRev(revision: string | null): string {
  return revision ? revision.slice(0, 7) : "-";
}

export function Header(props: HeaderProps): VNode {
  const sync = props.sync;
  return (
    <header class="app-header">
      <div class="hdr-line hdr-main">
        <span class={`badge mode-${props.mode}`}>{props.mode === "local" ? "ローカル" : "GitHub"}</span>
        <span class="hdr-repo" title={props.label}>
          {props.label}
        </span>
        <span class="hdr-branch">@{props.branch || "-"}</span>
        <button type="button" class="small ghost" onClick={props.onDisconnect}>
          接続解除
        </button>
      </div>
      <div class="hdr-line hdr-sub">
        <span class="hdr-path" title={props.path ?? ""}>
          {props.path ?? "（ファイル未選択）"}
        </span>
        <span class="hdr-rev">版 {shortRev(props.revision)}</span>
        <button
          type="button"
          class={props.unsaved > 0 ? "small warn" : "small ghost"}
          onClick={props.onOpenQueue}
        >
          未保存 {props.unsaved} 件
        </button>
        {props.pendingBatch ? <span class="chip danger">保存結果未確認</span> : null}
        {props.recovery ? <span class="chip danger">要復旧</span> : null}
      </div>
      {sync ? (
        <div class="hdr-line hdr-sync">
          <span class="chip">{syncStateLabel(sync.state)}</span>
          <span>
            ahead {sync.ahead} / behind {sync.behind}
          </span>
          <span>upstream: {sync.upstream ?? "なし"}</span>
          <span>最終確認: {sync.lastFetchedAt ?? "なし"}</span>
          {sync.detail ? <span class="hdr-detail">{sync.detail}</span> : null}
        </div>
      ) : null}
    </header>
  );
}
