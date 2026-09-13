/**
 * Markdown file picker over `adapter.list(dir, head)`.
 *
 * Breadcrumbs, the files opened before in this connection, a filter box for
 * the current folder, and on request one listing of every Markdown file in
 * the repository so a document can be found without walking directories.
 */
import { useState } from "preact/hooks";
import type { VNode } from "preact";
import type { Entry } from "@syuire/core";

export interface TreeListing {
  entries: Entry[];
  /** The host cut the listing short (very large repository). */
  truncated: boolean;
}

export interface FileBrowserProps {
  dir: string;
  entries: Entry[];
  busy: boolean;
  error: string | null;
  /** Files opened before in this connection, most recent first. */
  recentPaths: string[];
  tree: TreeListing | null;
  treeBusy: boolean;
  treeError: string | null;
  onLoadTree: () => void;
  onOpenDir: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onReload: () => void;
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function formatSize(size: number | undefined): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(path);
}

/** Case-insensitive match of every whitespace-separated term against the path. */
export function matchesFilter(path: string, filter: string): boolean {
  const terms = filter.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const hay = path.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

const MAX_RESULTS = 200;

export function FileBrowser(props: FileBrowserProps): VNode {
  const [filter, setFilter] = useState("");
  const searching = filter.trim().length > 0;

  const markdown = props.entries.filter((e) => e.kind === "file" && isMarkdownPath(e.path));
  const dirs = props.entries.filter((e) => e.kind === "dir");
  const crumbs = props.dir.length > 0 ? props.dir.split("/") : [];

  const treeFiles = props.tree ? props.tree.entries.filter((e) => e.kind === "file" && isMarkdownPath(e.path)) : null;
  const searchPool = treeFiles ?? markdown;
  const results = searching ? searchPool.filter((e) => matchesFilter(e.path, filter)) : [];

  const fileRow = (entry: Entry, showDir: boolean): VNode => (
    <li key={entry.path}>
      <button type="button" class="entry" onClick={() => props.onOpenFile(entry.path)}>
        <span class="entry-icon file" aria-hidden="true">
          ▪
        </span>
        <span class="entry-name">
          {baseName(entry.path)}
          {showDir && dirName(entry.path).length > 0 ? <span class="entry-dir">{dirName(entry.path)}/</span> : null}
        </span>
        <span class="entry-size">{formatSize(entry.size)}</span>
      </button>
    </li>
  );

  return (
    <div class="screen browser">
      <div class="browser-bar">
        <nav class="crumbs" aria-label="フォルダ">
          <button type="button" class="crumb" onClick={() => props.onOpenDir("")} disabled={props.dir.length === 0}>
            ルート
          </button>
          {crumbs.map((name, i) => {
            const target = crumbs.slice(0, i + 1).join("/");
            const last = i === crumbs.length - 1;
            return (
              <span class="crumb-seg" key={target}>
                <span class="crumb-sep" aria-hidden="true">
                  /
                </span>
                <button type="button" class="crumb" disabled={last} onClick={() => props.onOpenDir(target)}>
                  {name}
                </button>
              </span>
            );
          })}
        </nav>
        <button type="button" class="small ghost" onClick={props.onReload} disabled={props.busy}>
          再読込
        </button>
      </div>

      <div class="search-row">
        <input
          type="search"
          value={filter}
          placeholder={treeFiles ? "リポジトリ内の Markdown を探す" : "このフォルダのファイルを探す"}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          aria-label="ファイル名で探す"
          onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
        />
        {treeFiles === null ? (
          <button type="button" class="small" onClick={props.onLoadTree} disabled={props.treeBusy}>
            {props.treeBusy ? "読み込み中..." : "全体から探す"}
          </button>
        ) : (
          <span class="hint">{treeFiles.length} 件{props.tree?.truncated ? "（一部）" : ""}</span>
        )}
      </div>
      {props.treeError ? <p class="error">{props.treeError}</p> : null}
      {props.error ? <p class="error">{props.error}</p> : null}

      {searching ? (
        <ul class="entries" aria-label="検索結果">
          {results.slice(0, MAX_RESULTS).map((e) => fileRow(e, true))}
          {results.length === 0 && !props.treeBusy ? (
            <li class="empty">
              一致する Markdown がありません
              {treeFiles === null ? "。「全体から探す」でリポジトリ全体を対象にできます。" : "。"}
            </li>
          ) : null}
          {results.length > MAX_RESULTS ? <li class="empty">他 {results.length - MAX_RESULTS} 件。語を足して絞ってください。</li> : null}
        </ul>
      ) : (
        <>
          {props.recentPaths.length > 0 ? (
            <section class="recent-files" aria-label="最近開いたファイル">
              <h2 class="section-title">最近開いたファイル</h2>
              <ul class="entries">
                {props.recentPaths.map((p) => fileRow({ path: p, kind: "file", blobId: "" }, true))}
              </ul>
            </section>
          ) : null}
          <h2 class="section-title">{props.dir.length > 0 ? props.dir : "ルート"}</h2>
          <ul class="entries">
            {props.dir.length > 0 ? (
              <li>
                <button type="button" class="entry" onClick={() => props.onOpenDir(dirName(props.dir))}>
                  <span class="entry-icon" aria-hidden="true">
                    ↰
                  </span>
                  <span class="entry-name">上のフォルダへ</span>
                </button>
              </li>
            ) : null}
            {dirs.map((entry) => (
              <li key={entry.path}>
                <button type="button" class="entry" onClick={() => props.onOpenDir(entry.path)}>
                  <span class="entry-icon dir" aria-hidden="true">
                    ▤
                  </span>
                  <span class="entry-name">{baseName(entry.path)}</span>
                </button>
              </li>
            ))}
            {markdown.map((entry) => fileRow(entry, false))}
            {!props.busy && dirs.length === 0 && markdown.length === 0 ? (
              <li class="empty">Markdown ファイルがありません</li>
            ) : null}
          </ul>
        </>
      )}
      {props.busy ? <p class="note">読み込み中...</p> : null}
    </div>
  );
}
