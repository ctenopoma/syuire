/**
 * Syntax highlighting as display-text ranges (DESIGN.md 6).
 *
 * The renderer must keep one `<span data-s data-e>` per text run so that the
 * DOM selection maps back to source offsets. A highlighter that returns HTML
 * cannot be used for that; Prism's tokenizer can, because it yields a token
 * stream whose lengths add up to the input. The stream is flattened here into
 * `[start, end, className]` ranges over the code text, and the renderer splits
 * its runs at those boundaries (see `decorate.ts`).
 *
 * Prism is loaded in manual mode: it must never touch the DOM by itself.
 */
import Prism from "prismjs";

// Bundled with the core: markup, css, clike, javascript.
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-python";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-r";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-makefile";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-latex";

Prism.manual = true;

export interface TokenRange {
  start: number;
  end: number;
  /** Prism token type, e.g. "keyword", "string", "comment". */
  type: string;
}

const ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellsession: "bash",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  yml: "yaml",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  md: "markdown",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  cs: "csharp",
  "c#": "csharp",
  rs: "rust",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  dockerfile: "docker",
  make: "makefile",
  tex: "latex",
  patch: "diff",
  jsonc: "json",
  json5: "json",
  golang: "go",
  text: "",
  txt: "",
  plain: "",
  plaintext: "",
  mermaid: "",
};

/** Normalise a fence info string (`js {1,3}`, `TypeScript`) to a Prism language id, or null. */
export function resolveLanguage(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/[\s{,]/)[0] ?? "";
  const key = first.toLowerCase();
  if (key.length === 0) return null;
  const name = key in ALIASES ? (ALIASES[key] ?? "") : key;
  if (name.length === 0) return null;
  return Prism.languages[name] ? name : null;
}

type Stream = Array<string | Prism.Token>;

function flatten(stream: Stream, parentType: string | null, offset: number, out: TokenRange[]): number {
  let pos = offset;
  for (const item of stream) {
    if (typeof item === "string") {
      if (parentType !== null && item.length > 0) {
        out.push({ start: pos, end: pos + item.length, type: parentType });
      }
      pos += item.length;
      continue;
    }
    const content = item.content as string | Stream;
    if (typeof content === "string") {
      if (content.length > 0) out.push({ start: pos, end: pos + content.length, type: item.type });
      pos += content.length;
    } else {
      pos = flatten(content, item.type, pos, out);
    }
  }
  return pos;
}

/** Token ranges over `code`, in order, non-overlapping. Empty for unknown languages. */
export function highlightRanges(code: string, info: string | null | undefined): TokenRange[] {
  const lang = resolveLanguage(info);
  if (lang === null || code.length === 0) return [];
  const grammar = Prism.languages[lang];
  if (!grammar) return [];
  let stream: Stream;
  try {
    stream = Prism.tokenize(code, grammar);
  } catch {
    return [];
  }
  const out: TokenRange[] = [];
  const total = flatten(stream, null, 0, out);
  // A grammar that drops or duplicates characters would corrupt the mapping;
  // refuse its output rather than shift the highlighting.
  if (total !== code.length) return [];
  return out;
}
