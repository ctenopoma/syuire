/**
 * GitHub connection form (DESIGN.md 8, 10).
 *
 * The PAT is kept in memory unless the user opts in to sessionStorage. It is
 * never written to localStorage, to the URL, or to any message shown here.
 */
import { useEffect, useState } from "preact/hooks";
import type { VNode } from "preact";
import type { GitHubPrefill } from "../lib/hash";

export interface ConnectValues {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
  author: string;
  rememberToken: boolean;
}

export interface ConnectScreenProps {
  initial: ConnectValues;
  busy: boolean;
  error: string | null;
  /** Resolve the default author from the PAT (GitHub `/user` login). */
  lookupAuthor: (values: ConnectValues) => Promise<string>;
  onConnect: (values: ConnectValues) => void;
}

export function ConnectScreen(props: ConnectScreenProps): VNode {
  const [values, setValues] = useState<ConnectValues>(props.initial);
  const [authorTouched, setAuthorTouched] = useState(props.initial.author.length > 0);
  const [authorBusy, setAuthorBusy] = useState(false);
  const [authorNote, setAuthorNote] = useState<string | null>(null);

  useEffect(() => {
    setValues(props.initial);
  }, [props.initial]);

  const set = <K extends keyof ConnectValues>(key: K, value: ConnectValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  /** Trim every field; a pasted PAT often carries a trailing space or line break on iPad. */
  const normalized = (): ConnectValues => ({
    ...values,
    owner: values.owner.trim(),
    repo: values.repo.trim(),
    branch: values.branch.trim(),
    path: values.path.trim(),
    author: values.author.trim(),
    token: values.token.replace(/\s+/g, ""),
  });

  const canConnect =
    values.owner.trim().length > 0 &&
    values.repo.trim().length > 0 &&
    values.branch.trim().length > 0 &&
    values.token.trim().length > 0 &&
    !props.busy;

  const resolveAuthor = (): void => {
    if (authorTouched || values.token.length === 0) return;
    if (values.owner.trim().length === 0 || values.repo.trim().length === 0) return;
    setAuthorBusy(true);
    setAuthorNote(null);
    props.lookupAuthor(normalized()).then(
      (login) => {
        setAuthorBusy(false);
        if (login.length > 0) setValues((prev) => (prev.author.length > 0 ? prev : { ...prev, author: login }));
      },
      () => {
        setAuthorBusy(false);
        setAuthorNote("GitHub のログイン名を取得できませんでした。手入力してください。");
      },
    );
  };

  return (
    <div class="screen connect">
      <h1>syuire</h1>
      <p class="lede">GitHub の作業ブランチに直接つないで、Markdown に朱を入れます。</p>

      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canConnect) props.onConnect(normalized());
        }}
      >
        <label>
          <span>オーナー</span>
          <input
            value={values.owner}
            autocomplete="off"
            onInput={(e) => set("owner", (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          <span>リポジトリ</span>
          <input
            value={values.repo}
            autocomplete="off"
            onInput={(e) => set("repo", (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          <span>ブランチ</span>
          <input
            value={values.branch}
            autocomplete="off"
            onInput={(e) => set("branch", (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          <span>パス（任意）</span>
          <input
            value={values.path}
            placeholder="docs/foo.md"
            autocomplete="off"
            onInput={(e) => set("path", (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          <span>fine-grained PAT</span>
          <input
            type="password"
            value={values.token}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => set("token", (e.currentTarget as HTMLInputElement).value.replace(/\s+/g, ""))}
            onBlur={resolveAuthor}
          />
        </label>
        <label>
          <span>author{authorBusy ? "（取得中）" : ""}</span>
          <input
            value={values.author}
            autocomplete="off"
            onInput={(e) => {
              setAuthorTouched(true);
              set("author", (e.currentTarget as HTMLInputElement).value);
            }}
          />
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={values.rememberToken}
            onChange={(e) => set("rememberToken", (e.currentTarget as HTMLInputElement).checked)}
          />
          <span>この端末のセッションに PAT を記憶</span>
        </label>
        <p class="hint">
          既定では PAT はメモリだけに置き、再読込のたびに再入力します。記憶した場合も
          <code>sessionStorage</code> だけで、URL・localStorage には保存しません。
        </p>
        {authorNote ? <p class="note">{authorNote}</p> : null}
        {props.error ? <p class="error">{props.error}</p> : null}
        <button type="submit" class="primary" disabled={!canConnect}>
          {props.busy ? "接続中..." : "接続"}
        </button>
      </form>
    </div>
  );
}

export function valuesFromPrefill(
  prefill: GitHubPrefill | null,
  last: { owner: string; repo: string; branch: string; path: string; author: string } | null,
  token: string,
  rememberToken: boolean,
): ConnectValues {
  return {
    owner: prefill?.owner ?? last?.owner ?? "",
    repo: prefill?.repo ?? last?.repo ?? "",
    branch: (prefill?.branch ?? "") || last?.branch || "main",
    path: prefill?.path ?? last?.path ?? "",
    author: last?.author ?? "",
    token,
    rememberToken,
  };
}
