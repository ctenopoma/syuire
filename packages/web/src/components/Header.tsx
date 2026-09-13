/**
 * Header: repository, branch, file, unsaved count, save target and sync state
 * (DESIGN.md 6, 4.2). Two compact lines; the sync details fold away.
 */
import { useState } from "preact/hooks";
import type { VNode } from "preact";
import type { SyncStatus } from "@syuire/core";
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

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function syncChipClass(state: SyncStatus["state"]): string {
  switch (state) {
    case "in-sync":
      return "chip ok";
    case "diverged":
    case "repo-busy":
      return "chip danger";
    default:
      return "chip";
  }
}

export function Header(props: HeaderProps): VNode {
  const sync = props.sync;
  const [syncOpen, setSyncOpen] = useState(false);
  return (
    <header class="app-header">
      <div class="hdr-line hdr-main">
        <span class={`badge mode-${props.mode}`}>{props.mode === "local" ? "ローカル" : "GitHub"}</span>
        <span class="hdr-repo" title={props.label}>
          {props.label}
        </span>
        <span class="hdr-branch" title={`ブランチ ${props.branch || "-"}`}>
          @{props.branch || "-"}
        </span>
        <span class="hdr-spacer" />
        {sync ? (
          <button
            type="button"
            class={`${syncChipClass(sync.state)} as-button`}
            aria-expanded={syncOpen}
            title="同期の詳細"
            onClick={() => setSyncOpen((v) => !v)}
          >
            {syncStateLabel(sync.state)}
            {sync.ahead > 0 ? ` ↑${sync.ahead}` : ""}
            {sync.behind > 0 ? ` ↓${sync.behind}` : ""}
          </button>
        ) : null}
        <button type="button" class="small ghost" onClick={props.onDisconnect}>
          接続解除
        </button>
      </div>
      <div class="hdr-line hdr-sub">
        <span class="hdr-path" title={props.path ?? ""}>
          {props.path ? baseName(props.path) : "ファイルを選んでください"}
        </span>
        <span class="hdr-rev" title={props.revision ?? ""}>
          版 {shortRev(props.revision)}
        </span>
        <span class="hdr-spacer" />
        {props.pendingBatch ? <span class="chip danger">保存結果未確認</span> : null}
        {props.recovery ? <span class="chip danger">要復旧</span> : null}
        <button
          type="button"
          class={props.unsaved > 0 ? "small warn" : "small ghost"}
          onClick={props.onOpenQueue}
          aria-label={`未保存 ${props.unsaved} 件`}
        >
          未保存 {props.unsaved}
        </button>
      </div>
      {sync && syncOpen ? (
        <div class="hdr-line hdr-sync">
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
