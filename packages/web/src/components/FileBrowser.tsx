/**
 * Directory / Markdown file browser over `adapter.list(dir, head)`.
 */
import type { VNode } from "preact";
import type { Entry } from "@akaire/core";

export interface FileBrowserProps {
  dir: string;
  entries: Entry[];
  busy: boolean;
  error: string | null;
  onOpenDir: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onReload: () => void;
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function parentDir(dir: string): string {
  const i = dir.lastIndexOf("/");
  return i < 0 ? "" : dir.slice(0, i);
}

function formatSize(size: number | undefined): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function FileBrowser(props: FileBrowserProps): VNode {
  const markdown = props.entries.filter((e) => e.kind === "file" && /\.md$/i.test(e.path));
  const dirs = props.entries.filter((e) => e.kind === "dir");

  return (
    <div class="screen browser">
      <div class="browser-bar">
        <span class="crumb">/{props.dir}</span>
        <button type="button" class="small ghost" onClick={props.onReload} disabled={props.busy}>
          再読込
        </button>
      </div>
      {props.error ? <p class="error">{props.error}</p> : null}
      <ul class="entries">
        {props.dir.length > 0 ? (
          <li>
            <button type="button" class="entry" onClick={() => props.onOpenDir(parentDir(props.dir))}>
              <span class="entry-icon">↰</span>
              <span class="entry-name">..</span>
            </button>
          </li>
        ) : null}
        {dirs.map((entry) => (
          <li key={entry.path}>
            <button type="button" class="entry" onClick={() => props.onOpenDir(entry.path)}>
              <span class="entry-icon">▤</span>
              <span class="entry-name">{baseName(entry.path)}</span>
            </button>
          </li>
        ))}
        {markdown.map((entry) => (
          <li key={entry.path}>
            <button type="button" class="entry" onClick={() => props.onOpenFile(entry.path)}>
              <span class="entry-icon">▪</span>
              <span class="entry-name">{baseName(entry.path)}</span>
              <span class="entry-size">{formatSize(entry.size)}</span>
            </button>
          </li>
        ))}
        {!props.busy && dirs.length === 0 && markdown.length === 0 ? (
          <li class="empty">Markdown ファイルがありません</li>
        ) : null}
      </ul>
      {props.busy ? <p class="note">読み込み中...</p> : null}
    </div>
  );
}
