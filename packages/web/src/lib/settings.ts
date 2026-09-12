/**
 * Device-local, non-secret settings (DESIGN.md 8).
 *
 * `localStorage` holds only owner / repo / branch / path. The PAT lives in
 * memory by default and, only when the user opts in, in `sessionStorage`.
 * It is never written to `localStorage`, a URL, or a log line.
 */
import type { StorageLike } from "./queue";

export const LAST_CONNECTION_KEY = "akaire.lastConnection";
export const PAT_KEY = "akaire.pat";
export const PAT_OPT_IN_KEY = "akaire.patOptIn";
/**
 * Marks that this tab was opened from the local launcher. The session token is
 * stripped out of the URL as soon as it has been read (DESIGN.md 8: tokens
 * never stay in the app URL), so after a reload there is nothing to reconnect
 * with; the flag is what lets the UI say so instead of showing the GitHub form.
 */
export const LOCAL_SESSION_KEY = "akaire.localSession";

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
