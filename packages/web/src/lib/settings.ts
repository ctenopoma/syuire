/**
 * Device-local, non-secret settings (DESIGN.md 8).
 *
 * `localStorage` holds only owner / repo / branch / path (the last connection,
 * a short list of recent ones with the files opened there) and display
 * preferences. The PAT lives in memory by default and, only when the user opts
 * in, in `sessionStorage`. It is never written to `localStorage`, a URL, or a
 * log line.
 */
import type { StorageLike } from "./queue";

export const LAST_CONNECTION_KEY = "syuire.lastConnection";
export const RECENT_CONNECTIONS_KEY = "syuire.recentConnections";
export const PREFS_KEY = "syuire.prefs";
export const RECENT_CONNECTIONS_MAX = 8;
export const RECENT_PATHS_MAX = 10;
export const PAT_KEY = "syuire.pat";
export const PAT_OPT_IN_KEY = "syuire.patOptIn";
/**
 * Marks that this tab was opened from the local launcher. The session token is
 * stripped out of the URL as soon as it has been read (DESIGN.md 8: tokens
 * never stay in the app URL), so after a reload there is nothing to reconnect
 * with; the flag is what lets the UI say so instead of showing the GitHub form.
 */
export const LOCAL_SESSION_KEY = "syuire.localSession";

export interface LastConnection {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  author: string;
}

export function loadLastConnection(storage: StorageLike | null): LastConnection | null {
  if (!storage) return null;
  const text = storage.getItem(LAST_CONNECTION_KEY);
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Partial<LastConnection>;
    return {
      owner: typeof raw.owner === "string" ? raw.owner : "",
      repo: typeof raw.repo === "string" ? raw.repo : "",
      branch: typeof raw.branch === "string" ? raw.branch : "",
      path: typeof raw.path === "string" ? raw.path : "",
      author: typeof raw.author === "string" ? raw.author : "",
    };
  } catch {
    return null;
  }
}

export function saveLastConnection(storage: StorageLike | null, value: LastConnection): void {
  if (!storage) return;
  try {
    storage.setItem(LAST_CONNECTION_KEY, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private mode); the app still works.
  }
}

/** Read a PAT the user previously chose to keep for this tab session. */
export function loadSessionToken(storage: StorageLike | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(PAT_KEY);
  } catch {
    return null;
  }
}

export function saveSessionToken(storage: StorageLike | null, token: string | null): void {
  if (!storage) return;
  try {
    if (token === null || token.length === 0) {
      storage.removeItem(PAT_KEY);
      storage.removeItem(PAT_OPT_IN_KEY);
    } else {
      storage.setItem(PAT_KEY, token);
      storage.setItem(PAT_OPT_IN_KEY, "1");
    }
  } catch {
    // ignored: opting in is best effort
  }
}

export function setLocalSessionFlag(storage: StorageLike | null, on: boolean): void {
  if (!storage) return;
  try {
    if (on) storage.setItem(LOCAL_SESSION_KEY, "1");
    else storage.removeItem(LOCAL_SESSION_KEY);
  } catch {
    // ignored: the flag is only a nicer error message
  }
}

export function localSessionFlag(storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(LOCAL_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function sessionTokenOptIn(storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(PAT_OPT_IN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Safe accessors: Storage access throws in some privacy modes. */
export function safeLocalStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function safeSessionStorage(): StorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recent connections and the files opened in each (non-secret)
// ---------------------------------------------------------------------------

export interface RecentConnection {
  mode: "github" | "local";
  /** `owner/repo` for GitHub, the clone root for local. */
  repoKey: string;
  branch: string;
  author: string;
  /** Most recent first. */
  recentPaths: string[];
  /** ISO timestamp of the last connect or open. */
  usedAt: string;
}

export interface ConnectionKey {
  mode: "github" | "local";
  repoKey: string;
  branch: string;
}

function sameConnection(a: ConnectionKey, b: ConnectionKey): boolean {
  return a.mode === b.mode && a.repoKey === b.repoKey && a.branch === b.branch;
}

export function loadRecentConnections(storage: StorageLike | null): RecentConnection[] {
  if (!storage) return [];
  let text: string | null;
  try {
    text = storage.getItem(RECENT_CONNECTIONS_KEY);
  } catch {
    return [];
  }
  if (text === null) return [];
  try {
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: RecentConnection[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Partial<RecentConnection>;
      if (r.mode !== "github" && r.mode !== "local") continue;
      if (typeof r.repoKey !== "string" || r.repoKey.length === 0) continue;
      out.push({
        mode: r.mode,
        repoKey: r.repoKey,
        branch: typeof r.branch === "string" ? r.branch : "",
        author: typeof r.author === "string" ? r.author : "",
        recentPaths: Array.isArray(r.recentPaths)
          ? r.recentPaths.filter((p): p is string => typeof p === "string").slice(0, RECENT_PATHS_MAX)
          : [],
        usedAt: typeof r.usedAt === "string" ? r.usedAt : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

function saveRecentConnections(storage: StorageLike | null, list: RecentConnection[]): void {
  if (!storage) return;
  try {
    storage.setItem(RECENT_CONNECTIONS_KEY, JSON.stringify(list.slice(0, RECENT_CONNECTIONS_MAX)));
  } catch {
    // Storage may be unavailable (private mode); the app still works.
  }
}

/**
 * Move (or insert) a connection to the front of the recent list. `path`, when
 * given, becomes the most recent file of that connection.
 */
export function rememberConnection(
  storage: StorageLike | null,
  conn: ConnectionKey & { author: string; path?: string },
  now: string = new Date().toISOString(),
): RecentConnection[] {
  const list = loadRecentConnections(storage);
  const existing = list.find((c) => sameConnection(c, conn));
  const paths = existing ? [...existing.recentPaths] : [];
  if (conn.path !== undefined && conn.path.length > 0) {
    const i = paths.indexOf(conn.path);
    if (i >= 0) paths.splice(i, 1);
    paths.unshift(conn.path);
  }
  const entry: RecentConnection = {
    mode: conn.mode,
    repoKey: conn.repoKey,
    branch: conn.branch,
    author: conn.author.length > 0 ? conn.author : (existing?.author ?? ""),
    recentPaths: paths.slice(0, RECENT_PATHS_MAX),
    usedAt: now,
  };
  const next = [entry, ...list.filter((c) => !sameConnection(c, conn))].slice(0, RECENT_CONNECTIONS_MAX);
  saveRecentConnections(storage, next);
  return next;
}

export function forgetConnection(storage: StorageLike | null, conn: ConnectionKey): RecentConnection[] {
  const next = loadRecentConnections(storage).filter((c) => !sameConnection(c, conn));
  saveRecentConnections(storage, next);
  return next;
}

export function recentPathsFor(storage: StorageLike | null, conn: ConnectionKey): string[] {
  const found = loadRecentConnections(storage).find((c) => sameConnection(c, conn));
  return found ? found.recentPaths : [];
}

// ---------------------------------------------------------------------------
// Display preferences (non-secret)
// ---------------------------------------------------------------------------

export type ThemePref = "auto" | "light" | "dark";

export interface Prefs {
  theme: ThemePref;
  /** Body font size in px for the manuscript. */
  fontSize: number;
  /** Fetch repository images without asking. */
  autoImages: boolean;
  /** Colour fenced code blocks. */
  highlightCode: boolean;
}

export const DEFAULT_PREFS: Prefs = { theme: "auto", fontSize: 17, autoImages: true, highlightCode: true };
export const FONT_SIZE_MIN = 13;
export const FONT_SIZE_MAX = 26;

export function loadPrefs(storage: StorageLike | null): Prefs {
  if (!storage) return DEFAULT_PREFS;
  let text: string | null;
  try {
    text = storage.getItem(PREFS_KEY);
  } catch {
    return DEFAULT_PREFS;
  }
  if (text === null) return DEFAULT_PREFS;
  try {
    const raw = JSON.parse(text) as Partial<Prefs>;
    const theme: ThemePref = raw.theme === "light" || raw.theme === "dark" ? raw.theme : "auto";
    const size =
      typeof raw.fontSize === "number" && Number.isFinite(raw.fontSize)
        ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(raw.fontSize)))
        : DEFAULT_PREFS.fontSize;
    return {
      theme,
      fontSize: size,
      autoImages: typeof raw.autoImages === "boolean" ? raw.autoImages : DEFAULT_PREFS.autoImages,
      highlightCode: typeof raw.highlightCode === "boolean" ? raw.highlightCode : DEFAULT_PREFS.highlightCode,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(storage: StorageLike | null, prefs: Prefs): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // best effort
  }
}
