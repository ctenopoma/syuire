import { describe, expect, it } from "vitest";
import {
  nearestRunSpan,
  offsetWithinSpan,
  pointToSourceOffsets,
  selectionToSourceRange,
  type DomNodeLike,
} from "./selection";

// --- minimal DOM stand-in ---------------------------------------------------

function txt(value: string): DomNodeLike {
  return { nodeType: 3, parentNode: null, childNodes: [], nodeValue: value };
}

function elem(attrs: Record<string, string>, children: DomNodeLike[]): DomNodeLike {
  const node: DomNodeLike = {
    nodeType: 1,
    parentNode: null,
    childNodes: children,
    nodeValue: null,
    getAttribute: (name: string) => attrs[name] ?? null,
  };
  for (const child of children) {
    (child as { parentNode: DomNodeLike | null }).parentNode = node;
  }
  return node;
}

/**
 * Source: `abc&amp;def` where
 *   [0,3)  -> "abc"      (linear)
 *   [3,8)  -> "&"        (atomic entity)
 *   [8,11) -> "def"      (linear)
 */
function fixture(): {
  container: DomNodeLike;
  abc: DomNodeLike;
  amp: DomNodeLike;
  def: DomNodeLike;
} {
  const abc = txt("abc");
  const amp = txt("&");
  const def = txt("def");
  const container = elem({}, [
    elem({ "data-s": "0", "data-e": "3" }, [abc]),
    elem({ "data-s": "3", "data-e": "8", "data-atomic": "1" }, [amp]),
    elem({ "data-s": "8", "data-e": "11" }, [def]),
  ]);
  return { container, abc, amp, def };
}

describe("nearestRunSpan", () => {
  it("finds the closest ancestor carrying data-s", () => {
    const { abc, container } = fixture();
    expect(nearestRunSpan(abc)).toBe(container.childNodes[0]);
  });

  it("returns null outside the rendered runs", () => {
    const stray = txt("x");
    expect(nearestRunSpan(stray)).toBeNull();
  });
});

describe("offsetWithinSpan", () => {
  it("accumulates text across nested elements", () => {
    const inner = txt("ab");
    const tail = txt("cd");
    const span = elem({ "data-s": "100", "data-e": "104" }, [elem({}, [inner]), tail]);
    expect(offsetWithinSpan(span, inner, 1)).toBe(1);
    expect(offsetWithinSpan(span, tail, 1)).toBe(3);
  });

  it("handles an element point given as a child index", () => {
    const inner = txt("ab");
    const tail = txt("cd");
    const span = elem({ "data-s": "100", "data-e": "104" }, [elem({}, [inner]), tail]);
    expect(offsetWithinSpan(span, span, 1)).toBe(2);
  });

  it("returns null when the node is not inside the span", () => {
    const span = elem({ "data-s": "0", "data-e": "1" }, [txt("a")]);
    expect(offsetWithinSpan(span, txt("z"), 0)).toBeNull();
  });
});

describe("pointToSourceOffsets", () => {
  it("adds the offset inside a linear run", () => {
    const { abc } = fixture();
    expect(pointToSourceOffsets(abc, 1)).toEqual({ start: 1, end: 1 });
  });

  it("maps an atomic run to data-s / data-e", () => {
    const { amp } = fixture();
    expect(pointToSourceOffsets(amp, 1)).toEqual({ start: 3, end: 8 });
  });

  it("never runs past data-e", () => {
    const { abc } = fixture();
    expect(pointToSourceOffsets(abc, 99)).toEqual({ start: 3, end: 3 });
  });

  it("returns null outside the document", () => {
    expect(pointToSourceOffsets(txt("x"), 0)).toBeNull();
  });
});

describe("selectionToSourceRange", () => {
  it("maps a forward selection", () => {
    const { abc, def } = fixture();
    expect(selectionToSourceRange(abc, 1, def, 2)).toEqual({ start: 1, end: 10 });
  });

  it("maps a backward selection the same way", () => {
    const { abc, def } = fixture();
    expect(selectionToSourceRange(def, 2, abc, 1)).toEqual({ start: 1, end: 10 });
  });

  it("uses data-e when the end side is atomic", () => {
    const { abc, amp } = fixture();
    expect(selectionToSourceRange(abc, 0, amp, 1)).toEqual({ start: 0, end: 8 });
  });

  it("uses data-s when an atomic run is the start side", () => {
    const { amp, def } = fixture();
    expect(selectionToSourceRange(amp, 0, def, 3)).toEqual({ start: 3, end: 11 });
  });

  it("returns null for a collapsed selection", () => {
    const { abc } = fixture();
    expect(selectionToSourceRange(abc, 2, abc, 2)).toBeNull();
  });

  it("returns null when a side is outside the rendered runs", () => {
    const { abc } = fixture();
    expect(selectionToSourceRange(abc, 0, txt("z"), 1)).toBeNull();
    expect(selectionToSourceRange(null, 0, abc, 1)).toBeNull();
  });
});
