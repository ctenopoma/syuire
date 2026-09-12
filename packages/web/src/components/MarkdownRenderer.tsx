/**
 * Markdown -> Preact VNodes (DESIGN.md 6).
 *
 * Rules that matter here:
 * - Text is never taken from an mdast node value. Every text-bearing leaf is
 *   rendered as one `<span data-s data-e [data-atomic]>` per `TextRun`, so the
 *   DOM selection can be mapped back to source offsets exactly.
 * - Raw HTML in the manuscript is displayed as literal text, never injected.
 * - Links only get an `href` for http/https/mailto and relative URLs.
 * - Images are never auto-loaded. External images are never fetched at all;
 *   a repository image is fetched only when the reader presses 「読み込む」, and
 *   then only from the revision that is being read. The object URL it produces
 *   is revoked when the image is replaced or unmounted.
 * - akaire markers render as a numbered badge; blocks carrying markers get a
 *   left gutter with a vertical rule and the numbers.
 */
import { useEffect, useState } from "preact/hooks";
import type { JSX, VNode } from "preact";
import type { Nodes, Parent, Root } from "mdast";
import { MARKER_PREFIX, runsInRange, type TextMap } from "@akaire/core";

export interface RendererContext {
  tm: TextMap;
  /** marker start offset -> displayed number */
  markerNumbers: Map<number, number>;
  /** marker start offset -> comment id */
  markerIds: Map<number, string>;
  /** flow block start offset -> marker numbers shown in the gutter */
  gutter: Map<number, number[]>;
  /** comment ids whose anchor no longer matches */
  changed: Set<string>;
  onMarkerClick: (commentId: string) => void;
  loadImage: (url: string) => Promise<string>;
}

interface Range {
  start: number;
  end: number;
}

function absRange(node: Nodes, ctx: RendererContext): Range | null {
  const p = node.position;
  if (!p || p.start.offset === undefined || p.end.offset === undefined) return null;
  return { start: p.start.offset + ctx.tm.bodyStart, end: p.end.offset + ctx.tm.bodyStart };
}

function isMarkerNode(node: Nodes): boolean {
  return node.type === "html" && node.value.startsWith(MARKER_PREFIX);
}

/** One span per run of the display text. */
function renderRuns(ctx: RendererContext, range: Range, keyBase: string): VNode[] {
  const out: VNode[] = [];
  const runs = runsInRange(ctx.tm, range.start, range.end);
  for (let i = 0; i < runs.length; i++) {
    const entry = runs[i];
    if (!entry) continue;
    const { block, run } = entry;
    const text = block.displayText.slice(run.displayStart, run.displayEnd);
    if (text.length === 0) continue;
    out.push(
      <span
        key={`${keyBase}:${i}`}
        data-s={String(run.sourceStart)}
        data-e={String(run.sourceEnd)}
        data-atomic={run.atomic ? "1" : undefined}
      >
        {text}
      </span>,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links and images
// ---------------------------------------------------------------------------

export interface SafeHref {
  href: string;
  external: boolean;
}

/** http/https/mailto and relative URLs only; anything else renders as plain text. */
export function safeHref(url: string): SafeHref | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("//")) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(trimmed);
  if (!scheme) return { href: trimmed, external: false };
  const name = (scheme[1] ?? "").toLowerCase();
  if (name === "http" || name === "https") return { href: trimmed, external: true };
  if (name === "mailto") return { href: trimmed, external: true };
  return null;
}

export function isRepositoryImage(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("//") || trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("data:")) return false;
  return !/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(trimmed);
}

/** Image MIME type from the file extension, or null for anything we do not render. */
export function imageMimeType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    default:
      return null;
  }
}

type ImageState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; src: string }
  | { kind: "error"; message: string };

function ImageBlock(props: {
  url: string;
  alt: string;
  title: string | null;
  load: (url: string) => Promise<string>;
}): VNode {
  const [state, setState] = useState<ImageState>({ kind: "idle" });
  const repoImage = isRepositoryImage(props.url);
  const label = props.alt.length > 0 ? props.alt : props.url;
  const src = state.kind === "loaded" ? state.src : null;

  // Release the object URL when this image is replaced or unmounted.
  useEffect(() => {
    if (src === null) return undefined;
    return () => {
      if (src.startsWith("blob:")) URL.revokeObjectURL(src);
    };
  }, [src]);

  if (src !== null) {
    return (
      <span class="img-loaded">
        <img src={src} alt={props.alt} title={props.title ?? undefined} />
      </span>
    );
  }

  return (
    <span class="img-placeholder">
      <span class="img-alt">画像: {label}</span>
      {repoImage ? (
        <button
          type="button"
          class="small"
          disabled={state.kind === "loading"}
          onClick={() => {
            setState({ kind: "loading" });
            props.load(props.url).then(
              (src) => setState({ kind: "loaded", src }),
              (err: unknown) =>
                setState({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
            );
          }}
        >
          {state.kind === "loading" ? "読み込み中" : "読み込む"}
        </button>
      ) : (
        <span class="img-note">外部画像は自動取得しません</span>
      )}
      {state.kind === "error" ? <span class="img-error">{state.message}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function renderMarker(node: Nodes, ctx: RendererContext, block: boolean, key: string): VNode | null {
  const range = absRange(node, ctx);
  if (!range) return null;
  const number = ctx.markerNumbers.get(range.start);
  const id = ctx.markerIds.get(range.start);
  if (number === undefined || id === undefined) return null;
  const changed = ctx.changed.has(id);
  return (
    <button
      key={key}
      type="button"
      class={`marker-badge${block ? " marker-badge-block" : ""}${changed ? " marker-changed" : ""}`}
      title={changed ? "対象変更あり" : `コメント ${number}`}
      onClick={() => ctx.onMarkerClick(id)}
    >
      {number}
      {changed ? <span class="marker-flag">!</span> : null}
    </button>
  );
}

function renderChildren(node: Parent, ctx: RendererContext, phrasing: boolean): VNode[] {
  const out: VNode[] = [];
  const children = node.children as Nodes[];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    const rendered = renderNode(child, ctx, phrasing, `${i}`);
    if (rendered !== null) out.push(rendered);
  }
  return out;
}

/** Wrap a flow block so markers attached to it get a gutter rule and numbers. */
function withGutter(node: Nodes, ctx: RendererContext, key: string, body: VNode): VNode {
  const range = absRange(node, ctx);
  const numbers = range ? ctx.gutter.get(range.start) : undefined;
  if (!numbers || numbers.length === 0) return body;
  return (
    <div class="blk marked" key={key}>
      <div class="blk-gutter" aria-hidden="false">
        {numbers.map((n) => (
          <span class="gutter-num" key={String(n)}>
            {n}
          </span>
        ))}
      </div>
      <div class="blk-body">{body}</div>
    </div>
  );
}

function renderNode(
  node: Nodes,
  ctx: RendererContext,
  phrasing: boolean,
  key: string,
): VNode | null {
  switch (node.type) {
    // ---- text-bearing leaves -------------------------------------------
    case "text":
    case "inlineCode":
    case "code":
    case "html": {
      const range = absRange(node, ctx);
      if (!range) return null;
      if (isMarkerNode(node)) return renderMarker(node, ctx, !phrasing, key);
      const spans = renderRuns(ctx, range, key);
      if (node.type === "inlineCode") {
        return (
          <code class="inline-code" key={key}>
            {spans}
          </code>
        );
      }
      if (node.type === "code") {
        const block = (
          <pre class="code-block" key={key}>
            <code>{spans}</code>
          </pre>
        );
        return withGutter(node, ctx, key, block);
      }
      if (node.type === "html") {
        const el = (
          <span class="raw-html" key={key} title="原稿の HTML は文字として表示します">
            {spans}
          </span>
        );
        return phrasing ? el : withGutter(node, ctx, key, <div class="raw-html-block">{el}</div>);
      }
      return <span key={key}>{spans}</span>;
    }
    case "break": {
      const range = absRange(node, ctx);
      const runs = range ? runsInRange(ctx.tm, range.start, range.end) : [];
      const first = runs[0];
      if (!first) return <br key={key} />;
      return (
        <span
          key={key}
          data-s={String(first.run.sourceStart)}
          data-e={String(first.run.sourceEnd)}
          data-atomic="1"
        >
          <br />
        </span>
      );
    }

    // ---- flow -----------------------------------------------------------
    case "paragraph":
      return withGutter(node, ctx, key, <p key={key}>{renderChildren(node, ctx, true)}</p>);
    case "heading": {
      const depth = Math.min(6, Math.max(1, node.depth));
      const Tag = `h${depth}` as keyof JSX.IntrinsicElements;
      return withGutter(node, ctx, key, <Tag key={key}>{renderChildren(node, ctx, true)}</Tag>);
    }
    case "blockquote":
      return withGutter(
        node,
        ctx,
        key,
        <blockquote key={key}>{renderChildren(node, ctx, false)}</blockquote>,
      );
    case "list": {
      const items = renderChildren(node, ctx, false);
      const body = node.ordered ? (
        <ol key={key} start={node.start ?? 1}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
      return withGutter(node, ctx, key, body);
    }
    case "listItem":
      return (
        <li key={key} class={node.checked === null || node.checked === undefined ? undefined : "task"}>
          {node.checked === null || node.checked === undefined ? null : (
            <input type="checkbox" checked={node.checked} disabled />
          )}
          {renderChildren(node, ctx, false)}
        </li>
      );
    case "thematicBreak":
      return <hr key={key} />;
    case "table": {
      const align = node.align ?? [];
      const rows = node.children;
      const head = rows[0];
      const body = rows.slice(1);
      const cell = (
        row: Nodes,
        header: boolean,
        rowKey: string,
      ): VNode => (
        <tr key={rowKey}>
          {((row as Parent).children as Nodes[]).map((c, ci) => {
            const style = align[ci] ? { textAlign: align[ci] as "left" | "right" | "center" } : undefined;
            return header ? (
              <th key={`${rowKey}:${ci}`} style={style}>
                {renderChildren(c as Parent, ctx, true)}
              </th>
            ) : (
              <td key={`${rowKey}:${ci}`} style={style}>
                {renderChildren(c as Parent, ctx, true)}
              </td>
            );
          })}
        </tr>
      );
      const table = (
        <div class="table-wrap" key={key}>
          <table>
            {head ? <thead>{cell(head, true, `${key}:h`)}</thead> : null}
            <tbody>{body.map((r, i) => cell(r, false, `${key}:b${i}`))}</tbody>
          </table>
        </div>
      );
      return withGutter(node, ctx, key, table);
    }

    // ---- phrasing -------------------------------------------------------
    case "emphasis":
      return <em key={key}>{renderChildren(node, ctx, true)}</em>;
    case "strong":
      return <strong key={key}>{renderChildren(node, ctx, true)}</strong>;
    case "delete":
      return <del key={key}>{renderChildren(node, ctx, true)}</del>;
    case "link": {
      const target = safeHref(node.url);
      const children = renderChildren(node, ctx, true);
      if (!target) {
        return (
          <span key={key} class="link-blocked" title={`許可されていないリンク: ${node.url}`}>
            {children}
          </span>
        );
      }
      return (
        <a
          key={key}
          href={target.href}
          title={node.title ?? undefined}
          rel="noopener noreferrer"
          target={target.external ? "_blank" : undefined}
        >
          {children}
        </a>
      );
    }
    case "linkReference":
    case "footnoteReference":
    case "footnoteDefinition":
      return <span key={key}>{renderChildren(node as Parent, ctx, phrasing)}</span>;
    case "image":
      return (
        <ImageBlock
          key={key}
          url={node.url}
          alt={node.alt ?? ""}
          title={node.title ?? null}
          load={ctx.loadImage}
        />
      );
    case "imageReference":
      return (
        <span key={key} class="img-placeholder">
          <span class="img-alt">画像: {node.alt ?? node.identifier}</span>
        </span>
      );
    case "definition":
      return null;
    default: {
      if ("children" in node) {
        return <span key={key}>{renderChildren(node as Parent, ctx, phrasing)}</span>;
      }
      return null;
    }
  }
}

export function MarkdownRenderer(props: { ctx: RendererContext }): VNode {
  const root: Root = props.ctx.tm.root;
  return (
    <div class="markdown">
      {props.ctx.tm.frontMatter ? (
        <div class="front-matter">フロントマター（朱入れの対象外）</div>
      ) : null}
      {renderChildren(root as unknown as Parent, props.ctx, false)}
    </div>
  );
}
