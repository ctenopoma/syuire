import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  RECENT_CONNECTIONS_MAX,
  RECENT_PATHS_MAX,
  forgetConnection,
  loadPrefs,
  loadRecentConnections,
  recentPathsFor,
  rememberConnection,
  savePrefs,
} from "./settings";
import type { StorageLike } from "./queue";

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const gh = { mode: "github" as const, repoKey: "acme/docs", branch: "review", author: "naoki" };

describe("recent connections", () => {
  it("keeps the most recent connection first and de-duplicates", () => {
    const s = memoryStorage();
    rememberConnection(s, gh, "2026-09-01T00:00:00Z");
    rememberConnection(s, { ...gh, branch: "main" }, "2026-09-02T00:00:00Z");
    rememberConnection(s, gh, "2026-09-03T00:00:00Z");
    const list = loadRecentConnections(s);
    expect(list.map((c) => c.branch)).toEqual(["review", "main"]);
    expect(list[0]?.usedAt).toBe("2026-09-03T00:00:00Z");
  });

  it("tracks the files opened per connection, most recent first", () => {
    const s = memoryStorage();
    rememberConnection(s, { ...gh, path: "a.md" });
    rememberConnection(s, { ...gh, path: "b.md" });
    rememberConnection(s, { ...gh, path: "a.md" });
    expect(recentPathsFor(s, gh)).toEqual(["a.md", "b.md"]);
    for (let i = 0; i < RECENT_PATHS_MAX + 3; i++) rememberConnection(s, { ...gh, path: `f${i}.md` });
    expect(recentPathsFor(s, gh)).toHaveLength(RECENT_PATHS_MAX);
  });

  it("caps the list and can forget one entry", () => {
    const s = memoryStorage();
    for (let i = 0; i < RECENT_CONNECTIONS_MAX + 2; i++) {
      rememberConnection(s, { ...gh, repoKey: `acme/r${i}` });
    }
    expect(loadRecentConnections(s)).toHaveLength(RECENT_CONNECTIONS_MAX);
    const last = loadRecentConnections(s)[0];
    if (!last) throw new Error("expected an entry");
    forgetConnection(s, last);
    expect(loadRecentConnections(s).some((c) => c.repoKey === last.repoKey)).toBe(false);
  });

  it("keeps the author when a later remember has none", () => {
    const s = memoryStorage();
    rememberConnection(s, gh);
    rememberConnection(s, { ...gh, author: "" });
    expect(loadRecentConnections(s)[0]?.author).toBe("naoki");
  });

  it("ignores corrupt storage", () => {
    const s = memoryStorage();
    s.setItem("syuire.recentConnections", "{not json");
    expect(loadRecentConnections(s)).toEqual([]);
    s.setItem("syuire.recentConnections", JSON.stringify([{ mode: "ftp", repoKey: "x" }, 3]));
    expect(loadRecentConnections(s)).toEqual([]);
  });

  it("stores only connection fields", () => {
    const s = memoryStorage();
    rememberConnection(s, { ...gh, path: "a.md" });
    const raw = JSON.parse(s.getItem("syuire.recentConnections") ?? "[]") as Array<Record<string, unknown>>;
    expect(Object.keys(raw[0] ?? {}).sort()).toEqual(
      ["author", "branch", "mode", "recentPaths", "repoKey", "usedAt"].sort(),
    );
  });
});

describe("prefs", () => {
  it("round-trips and clamps", () => {
    const s = memoryStorage();
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
    savePrefs(s, { theme: "dark", fontSize: 99, autoImages: false, highlightCode: false });
    expect(loadPrefs(s)).toEqual({ theme: "dark", fontSize: 26, autoImages: false, highlightCode: false });
    s.setItem("syuire.prefs", "nope");
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
  });
});
