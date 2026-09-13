/**
 * Markdown -> Preact VNodes (DESIGN.md 6).
 *
 * Rules that matter here:
 * - Text is never taken from an mdast node value. Every text-bearing leaf is
 *   rendered as `<span data-s data-e [data-atomic]>` pieces cut from the
 *   `TextRun`s of the text map, so the DOM selection maps back to source
 *   offsets exactly. Decorations (syntax colours, highlighted comment anchors)
 *   only ever split a non-atomic run; they never move a boundary.
 * - Raw HTML in the manuscript is displayed as literal text, never injected.
 * - Links only get an `href` for http/https/mailto and relative URLs. Links to
 *   headings scroll inside the document, links to other files are handed to
 *   the app, so the app's own `#gh=` fragment is never clobbered.
 * - External images are never fetched. A repository image is fetched from the
 *   revision being read, automatically when the reader allows it, otherwise
 *   on 「読み込む」. The object URL is revoked when the image goes away.
 * - syuire markers render as a numbered badge; blocks carrying markers get a
 *   left gutter with a vertical rule and the numbers. The anchored text of a
 *   comment is highlighted so the reader can see what the note is about.
 */
import { useEffect, useState } from "preact/hooks";
import type { JSX, VNode } from "preact";
import type { Code, Definition, FootnoteDefinition, Heading, Nodes, Parent, Root } from "mdast";
import { MARKER_PREFIX, mdastDisplayText, runsInRange, type LeafBlock, type TextMap } from "@syuire/core";
import { splitRun, type Decoration } from "../lib/decorate";
import { highlightRanges, resolveLanguage } from "../lib/highlight";

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
  /** leaf block start offset -> highlighted anchor ranges (display coordinates) */
  annotations: Map<number, Decoration[]>;
  /** comment whose thread is open; its badge and anchor are emphasised */
  activeCommentId: string | null;
  /** Colour fenced code by its info string. */
  highlightCode: boolean;
  /** Fetch repository images without asking. */
  autoImages: boolean;
  onMarkerClick: (commentId: string) => void;
  /** A relative link (another file in the repository) was activated. */
  onOpenLink: (href: string) => void;
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

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

const codeDecorations = new WeakMap<LeafBlock, Decoration[]>();

function decorationsFor(ctx: RendererContext, block: LeafBlock): Decoration[] {
  const annotations = ctx.annotations.get(block.range.start) ?? [];
  if (!ctx.highlightCode || block.type !== "code") return annotations;
  let tokens = codeDecorations.get(block);
  if (tokens === undefined) {
    const lang = block.node.type === "code" ? (block.node as Code).lang : null;
    tokens = highlightRanges(block.displayText, lang).map((r) => ({
      start: r.start,
      end: r.end,
      className: `tok tok-${r.type}`,
    }));
    codeDecorations.set(block, tokens);
  }
  return tokens.length === 0 ? annotations : tokens.concat(annotations);
}

/** Spans for the display text of a source range, cut at decoration boundaries. */
function renderRuns(ctx: RendererContext, range: Range, keyBase: string): VNode[] {
  const out: VNode[] = [];
  const runs = runsInRange(ctx.tm, range.start, range.end);
  for (let i = 0; i < runs.length; i++) {
    const entry = runs[i];
    if (!entry) continue;
    const { block, run } = entry;
    const pieces = splitRun(run, decorationsFor(ctx, block));
    for (let j = 0; j < pieces.length; j++) {
      const piece = pieces[j];
      if (!piece) continue;
      const text = block.displayText.slice(piece.displayStart, piece.displayEnd);
      if (text.length === 0) continue;
      const classes = [...piece.classes];
      const commentId = piece.attrs["data-comment"];
      if (commentId !== undefined && commentId === ctx.activeCommentId) classes.push("anno-active");
      out.push(
        <span
          key={`${keyBase}:${i}:${j}`}
          class={classes.length > 0 ? classes.join(" ") : undefined}
          data-s={String(piece.sourceStart)}
          data-e={String(piece.sourceEnd)}
          data-atomic={piece.atomic ? "1" : undefined}
          {...piece.attrs}
        >
          {text}
        </span>,
      );
    }
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

/**
 * GitHub-style heading slug: lower-case, punctuation removed, spaces to `-`.
 * Used for `#section` links inside the manuscript and for the outline.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export interface OutlineEntry {
  depth: number;
  text: string;
  id: string;
  /** Absolute source offset of the heading (for ordering with markers). */
  start: number;
}

/** Headings of the document with the ids the renderer assigns them. */
export function outlineOf(tm: TextMap): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const seen = new Map<string, number>();
  for (const child of tm.root.children) {
    if (child.type !== "heading") continue;
    const h = child as Heading;
    const raw = mdastDisplayText(h);
    const text = raw.replace(/\s+/g, " ").trim();
    const base = headingSlug(raw) || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    const start = h.position?.start.offset === undefined ? 0 : h.position.start.offset + tm.bodyStart;
    out.push({ depth: h.depth, text, id, start });
  }
  return out;
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
  auto: boolean;
  load: (url: string) => Promise<string>;
}): VNode {
  const [state, setState] = useState<ImageState>({ kind: "idle" });
  const repoImage = isRepositoryImage(props.url);
  const label = props.alt.length > 0 ? props.alt : props.url;
  const src = state.kind === "loaded" ? state.src : null;

  const start = (): void => {
    setState({ kind: "loading" });
    props.load(props.url).then(
      (loaded) => setState({ kind: "loaded", src: loaded }),
      (err: unknown) => setState({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    );
  };

  // Auto-load once per URL when the reader allows it.
  useEffect(() => {
    if (props.auto && repoImage && state.kind === "idle") start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.auto, props.url]);

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
        <img src={src} alt={props.alt} title={props.title ?? undefined} loading="lazy" />
        {props.title ? <span class="img-caption">{props.title}</span> : null}
      </span>
    );
  }

  return (
    <span class={`img-placeholder${state.kind === "loading" ? " loading" : ""}`}>
      <span class="img-alt">画像: {label}</span>
      {repoImage ? (
        <button type="button" class="small" disabled={state.kind === "loading"} onClick={start}>
          {state.kind === "loading" ? "読み込み中" : state.kind === "error" ? "再試行" : "読み込む"}
        </button>
      ) : (
        <span class="img-note">外部画像は取得しません</span>
      )}
      {state.kind === "error" ? <span class="img-error">{state.message}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Document-level lookups (definitions, footnotes)
// ---------------------------------------------------------------------------

interface DocumentIndex {
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
  /** footnote identifier -> displayed number, in order of first reference */
  footnoteNumbers: Map<string, number>;
  headingIds: Map<number, string>;
}

function collectFootnoteRefs(node: Nodes, order: string[]): void {
  if (node.type === "footnoteReference") {
    if (!order.includes(node.identifier)) order.push(node.identifier);
    return;
  }
  if ("children" in node) {
    for (const child of (node as Parent).children as Nodes[]) collectFootnoteRefs(child, order);
  }
}

function indexDocument(ctx: RendererContext): DocumentIndex {
  const root = ctx.tm.root;
  const definitions = new Map<string, Definition>();
  const footnotes = new Map<string, FootnoteDefinition>();
  const walk = (node: Nodes): void => {
    if (node.type === "definition") {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
      return;
    }
    if (node.type === "footnoteDefinition") {
      if (!footnotes.has(node.identifier)) footnotes.set(node.identifier, node);
      return;
    }
    if ("children" in node) for (const child of (node as Parent).children as Nodes[]) walk(child);
  };
  walk(root as unknown as Nodes);
  const order: string[] = [];
  collectFootnoteRefs(root as unknown as Nodes, order);
  const footnoteNumbers = new Map<string, number>();
  let n = 1;
  for (const id of order) if (footnotes.has(id)) footnoteNumbers.set(id, n++);
  for (const id of footnotes.keys()) if (!footnoteNumbers.has(id)) footnoteNumbers.set(id, n++);
  const headingIds = new Map<number, string>();
  for (const entry of outlineOf(ctx.tm)) headingIds.set(entry.start, entry.id);
  return { definitions, footnotes, footnoteNumbers, headingIds };
}

function scrollToId(id: string): boolean {
  if (typeof document === "undefined") return false;
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

interface RenderState {
  ctx: RendererContext;
  index: DocumentIndex;
}

function renderMarker(node: Nodes, st: RenderState, block: boolean, key: string): VNode | null {
  const ctx = st.ctx;
  const range = absRange(node, ctx);
  if (!range) return null;
  const number = ctx.markerNumbers.get(range.start);
  const id = ctx.markerIds.get(range.start);
  if (number === undefined || id === undefined) return null;
  const changed = ctx.changed.has(id);
  const active = ctx.activeCommentId === id;
  return (
    <button
      key={key}
      type="button"
      id={`marker-${id}`}
      data-marker-id={id}
      class={`marker-badge${block ? " marker-badge-block" : ""}${changed ? " marker-changed" : ""}${active ? " marker-active" : ""}`}
      title={changed ? `コメント ${number}（対象変更あり）` : `コメント ${number}`}
      aria-label={`コメント ${number} を開く`}
      onClick={() => ctx.onMarkerClick(id)}
    >
      {number}
      {changed ? <span class="marker-flag">!</span> : null}
    </button>
  );
}

function renderChildren(node: Parent, st: RenderState, phrasing: boolean): VNode[] {
  const out: VNode[] = [];
  const children = node.children as Nodes[];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    const rendered = renderNode(child, st, phrasing, `${i}`);
    if (rendered !== null) out.push(rendered);
  }
  return out;
}

/** Wrap a flow block so markers attached to it get a gutter rule and numbers. */
function withGutter(node: Nodes, st: RenderState, key: string, body: VNode): VNode {
  const range = absRange(node, st.ctx);
  const numbers = range ? st.ctx.gutter.get(range.start) : undefined;
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

function renderLink(
  st: RenderState,
  key: string,
  url: string,
  title: string | null | undefined,
  children: VNode[],
): VNode {
  const target = safeHref(url);
  if (!target) {
    return (
      <span key={key} class="link-blocked" title={`許可されていないリンク: ${url}`}>
        {children}
      </span>
    );
  }
  if (target.external) {
    return (
      <a key={key} href={target.href} title={title ?? undefined} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    );
  }
  const internal = target.href.startsWith("#");
  return (
    <a
      key={key}
      href={target.href}
      title={title ?? undefined}
      class={internal ? "link-heading" : "link-file"}
      onClick={(e) => {
        e.preventDefault();
        if (internal) {
          let id = target.href.slice(1);
          try {
            id = decodeURIComponent(id);
          } catch {
            // keep raw
          }
          scrollToId(id);
          return;
        }
        st.ctx.onOpenLink(target.href);
      }}
    >
      {children}
    </a>
  );
}

function renderNode(node: Nodes, st: RenderState, phrasing: boolean, key: string): VNode | null {
  const ctx = st.ctx;
  switch (node.type) {
    // ---- text-bearing leaves -------------------------------------------
    case "text":
    case "inlineCode":
    case "code":
    case "html": {
      const range = absRange(node, ctx);
      if (!range) return null;
      if (isMarkerNode(node)) return renderMarker(node, st, !phrasing, key);
      const spans = renderRuns(ctx, range, key);
      if (node.type === "inlineCode") {
        return (
          <code class="inline-code" key={key}>
            {spans}
          </code>
        );
      }
      if (node.type === "code") {
        const lang = node.lang ?? null;
        const known = resolveLanguage(lang);
        const block = (
          <div class="code-wrap" key={key}>
            {lang ? (
              <div class="code-head" aria-hidden="true">
                <span class="code-lang">{lang}</span>
              </div>
            ) : null}
            <pre class={`code-block${known ? ` lang-${known}` : ""}`}>
              <code>{spans}</code>
            </pre>
          </div>
        );
        return withGutter(node, st, key, block);
      }
      if (node.type === "html") {
        const el = (
          <span class="raw-html" key={key} title="原稿の HTML は文字として表示します">
            {spans}
          </span>
        );
        return phrasing ? el : withGutter(node, st, key, <div class="raw-html-block">{el}</div>);
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
      return withGutter(node, st, key, <p key={key}>{renderChildren(node, st, true)}</p>);
    case "heading": {
      const depth = Math.min(6, Math.max(1, node.depth));
      const Tag = `h${depth}` as keyof JSX.IntrinsicElements;
      const range = absRange(node, ctx);
      const id = range ? st.index.headingIds.get(range.start) : undefined;
      return withGutter(
        node,
        st,
        key,
        <Tag key={key} id={id} class="md-heading">
          {renderChildren(node, st, true)}
        </Tag>,
      );
    }
    case "blockquote":
      return withGutter(node, st, key, <blockquote key={key}>{renderChildren(node, st, false)}</blockquote>);
    case "list": {
      const items = renderChildren(node, st, false);
      const hasTasks = node.children.some((c) => c.checked !== null && c.checked !== undefined);
      const body = node.ordered ? (
        <ol key={key} start={node.start ?? 1} class={hasTasks ? "task-list" : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key} class={hasTasks ? "task-list" : undefined}>
          {items}
        </ul>
      );
      return withGutter(node, st, key, body);
    }
    case "listItem": {
      const task = node.checked !== null && node.checked !== undefined;
      return (
        <li key={key} class={task ? `task${node.checked ? " done" : ""}` : undefined}>
          {task ? <input type="checkbox" checked={node.checked ?? false} disabled aria-label="タスク" /> : null}
          {renderChildren(node, st, false)}
        </li>
      );
    }
    case "thematicBreak":
      return <hr key={key} />;
    case "table": {
      const align = node.align ?? [];
      const rows = node.children;
      const head = rows[0];
      const body = rows.slice(1);
      const cell = (row: Nodes, header: boolean, rowKey: string): VNode => (
        <tr key={rowKey}>
          {((row as Parent).children as Nodes[]).map((c, ci) => {
            const style = align[ci] ? { textAlign: align[ci] as "left" | "right" | "center" } : undefined;
            return header ? (
              <th key={`${rowKey}:${ci}`} style={style}>
                {renderChildren(c as Parent, st, true)}
              </th>
            ) : (
              <td key={`${rowKey}:${ci}`} style={style}>
                {renderChildren(c as Parent, st, true)}
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
      return withGutter(node, st, key, table);
    }
    case "footnoteDefinition":
      // Rendered together at the end of the document.
      return null;
    case "definition":
      return null;

    // ---- phrasing -------------------------------------------------------
    case "emphasis":
      return <em key={key}>{renderChildren(node, st, true)}</em>;
    case "strong":
      return <strong key={key}>{renderChildren(node, st, true)}</strong>;
    case "delete":
      return <del key={key}>{renderChildren(node, st, true)}</del>;
    case "link":
      return renderLink(st, key, node.url, node.title, renderChildren(node, st, true));
    case "linkReference": {
      const def = st.index.definitions.get(node.identifier);
      const children = renderChildren(node, st, true);
      if (!def) return <span key={key}>{children}</span>;
      return renderLink(st, key, def.url, def.title, children);
    }
    case "image":
      return (
        <ImageBlock
          key={key}
          url={node.url}
          alt={node.alt ?? ""}
          title={node.title ?? null}
          auto={ctx.autoImages}
          load={ctx.loadImage}
        />
      );
    case "imageReference": {
      const def = st.index.definitions.get(node.identifier);
      if (!def) {
        return (
          <span key={key} class="img-placeholder">
            <span class="img-alt">画像: {node.alt ?? node.identifier}</span>
          </span>
        );
      }
      return (
        <ImageBlock
          key={key}
          url={def.url}
          alt={node.alt ?? ""}
          title={def.title ?? null}
          auto={ctx.autoImages}
          load={ctx.loadImage}
        />
      );
    }
    case "footnoteReference": {
      const n = st.index.footnoteNumbers.get(node.identifier);
      if (n === undefined) return <span key={key}>[^{node.identifier}]</span>;
      const id = `fn-${node.identifier}`;
      return (
        <sup key={key} class="fn-ref">
          <a
            href={`#${id}`}
            title={`脚注 ${n}`}
            onClick={(e) => {
              e.preventDefault();
              scrollToId(id);
            }}
          >
            [{n}]
          </a>
        </sup>
      );
    }
    default: {
      if ("children" in node) {
        return <span key={key}>{renderChildren(node as Parent, st, phrasing)}</span>;
      }
      return null;
    }
  }
}

function renderFootnotes(st: RenderState): VNode | null {
  const { footnotes, footnoteNumbers } = st.index;
  if (footnotes.size === 0) return null;
  const ordered = [...footnotes.values()].sort(
    (a, b) => (footnoteNumbers.get(a.identifier) ?? 0) - (footnoteNumbers.get(b.identifier) ?? 0),
  );
  return (
    <section class="footnotes" aria-label="脚注">
      <ol>
        {ordered.map((def) => {
          const n = footnoteNumbers.get(def.identifier) ?? 0;
          const body = withGutter(
            def as unknown as Nodes,
            st,
            `fn:${def.identifier}`,
            <div class="fn-body">{renderChildren(def, st, false)}</div>,
          );
          return (
            <li key={def.identifier} id={`fn-${def.identifier}`} value={n}>
              {body}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function FrontMatter(props: { tm: TextMap }): VNode | null {
  const fm = props.tm.frontMatter;
  if (!fm) return null;
  const text = props.tm.source.slice(fm.start, fm.end).replace(/\r\n/g, "\n").trim();
  return (
    <details class="front-matter">
      <summary>フロントマター（朱入れの対象外）</summary>
      <pre>{text}</pre>
    </details>
  );
}

export function MarkdownRenderer(props: { ctx: RendererContext }): VNode {
  const st: RenderState = { ctx: props.ctx, index: indexDocument(props.ctx) };
  const root: Root = props.ctx.tm.root;
  return (
    <div class="markdown">
      <FrontMatter tm={props.ctx.tm} />
      {renderChildren(root as unknown as Parent, st, false)}
      {renderFootnotes(st)}
    </div>
  );
}
