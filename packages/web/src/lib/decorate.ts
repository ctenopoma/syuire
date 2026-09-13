/**
 * Split text runs at decoration boundaries without losing the display to
 * source mapping (DESIGN.md 6).
 *
 * A `TextRun` maps display code units `[displayStart, displayEnd)` to source
 * `[sourceStart, sourceEnd)`. Non-atomic runs map one to one, so any display
 * position inside them has an exact source offset and the run can be cut
 * there. Atomic runs (`&amp;`, escapes, line endings) map as a whole and are
 * never cut: they take the classes that cover their first unit.
 */
import type { TextRun } from "@syuire/core";

export interface Decoration {
  /** Display range within the block. */
  start: number;
  end: number;
  className: string;
  /** Optional attributes copied onto the piece (e.g. data-comment). */
  attrs?: Record<string, string>;
}

export interface Piece {
  displayStart: number;
  displayEnd: number;
  sourceStart: number;
  sourceEnd: number;
  atomic: boolean;
  classes: string[];
  attrs: Record<string, string>;
}

function coverAt(decorations: Decoration[], position: number): { classes: string[]; attrs: Record<string, string> } {
  const classes: string[] = [];
  const attrs: Record<string, string> = {};
  for (const d of decorations) {
    if (d.start <= position && position < d.end) {
      if (!classes.includes(d.className)) classes.push(d.className);
      if (d.attrs) Object.assign(attrs, d.attrs);
    }
  }
  return { classes, attrs };
}

/** Pieces of one run, in display order. With no overlapping decoration the run comes back whole. */
export function splitRun(run: TextRun, decorations: Decoration[]): Piece[] {
  const relevant = decorations.filter((d) => d.start < run.displayEnd && d.end > run.displayStart);
  if (relevant.length === 0) {
    return [
      {
        displayStart: run.displayStart,
        displayEnd: run.displayEnd,
        sourceStart: run.sourceStart,
        sourceEnd: run.sourceEnd,
        atomic: run.atomic,
        classes: [],
        attrs: {},
      },
    ];
  }
  if (run.atomic) {
    const cover = coverAt(relevant, run.displayStart);
    return [
      {
        displayStart: run.displayStart,
        displayEnd: run.displayEnd,
        sourceStart: run.sourceStart,
        sourceEnd: run.sourceEnd,
        atomic: true,
        classes: cover.classes,
        attrs: cover.attrs,
      },
    ];
  }
  const cuts = new Set<number>([run.displayStart, run.displayEnd]);
  for (const d of relevant) {
    if (d.start > run.displayStart && d.start < run.displayEnd) cuts.add(d.start);
    if (d.end > run.displayStart && d.end < run.displayEnd) cuts.add(d.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i] ?? run.displayStart;
    const to = points[i + 1] ?? run.displayEnd;
    if (to <= from) continue;
    const cover = coverAt(relevant, from);
    const delta = from - run.displayStart;
    out.push({
      displayStart: from,
      displayEnd: to,
      sourceStart: run.sourceStart + delta,
      sourceEnd: run.sourceStart + delta + (to - from),
      atomic: false,
      classes: cover.classes,
      attrs: cover.attrs,
    });
  }
  return out;
}
