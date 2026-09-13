/**
 * GitHub connection screen (DESIGN.md 8, 10).
 *
 * Two things are needed to start: which repository and a PAT. Everything
 * else is derived: the branch defaults to the repository's default branch,
 * the author to the token's login, and the file is picked afterwards in the
 * browser. Recent connections are one tap away.
 *
 * The PAT is kept in memory unless the user opts in to sessionStorage. It is
 * never written to localStorage, to the URL, or to any message shown here.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import type { GitHubPrefill } from "../lib/hash";
import { parseRepoInput, repoLabel } from "../lib/repo-input";
import type { RecentConnection } from "../lib/settings";
import { TokenInput } from "./TokenInput";

export interface ConnectValues {
  owner: string;
  repo: string;
  /** Empty means "the repository's default branch". */
  branch: string;
  /** Optional file or directory to open after connecting. */
  path: string;
  token: string;
  author: string;
  rememberToken: boolean;
}

export interface RepoLookup {
  defaultBranch: string;
  branches: string[];
  canPush: boolean | null;
}

export interface ConnectScreenProps {
  initial: ConnectValues;
  recent: RecentConnection[];
  busy: boolean;
  error: string | null;
  /** Resolve the token's login (GitHub `/user`). Rejects on a bad token. */
  verifyToken: (token: string) => Promise<string>;
  /** Default branch and branch names of a repository, as seen with the token. */
  lookupRepo: (owner: string, repo: string, token: string) => Promise<RepoLookup>;
  onConnect: (values: ConnectValues) => void;
  onForgetRecent: (conn: RecentConnection) => void;
}

type TokenStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; login: string }
  | { kind: "error"; message: string };

type RepoStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; info: RepoLookup }
  | { kind: "error"; message: string };

const PAT_HELP_URL = "https://github.com/settings/personal-access-tokens/new";

function initialRepoText(v: ConnectValues): string {
  if (v.owner.length === 0 || v.repo.length === 0) return "";
  return `${v.owner}/${v.repo}`;
}

export function ConnectScreen(props: ConnectScreenProps): VNode {
  const [repoText, setRepoText] = useState(initialRepoText(props.initial));
  const [branch, setBranch] = useState(props.initial.branch);
  const [branchTouched, setBranchTouched] = useState(props.initial.branch.length > 0);
  const [path, setPath] = useState(props.initial.path);
  const [token, setToken] = useState(props.initial.token);
  const [author, setAuthor] = useState(props.initial.author);
  const [authorTouched, setAuthorTouched] = useState(props.initial.author.length > 0);
  const [remember, setRemember] = useState(props.initial.rememberToken);
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>({ kind: "idle" });
  const [repoStatus, setRepoStatus] = useState<RepoStatus>({ kind: "idle" });
  const [advancedOpen, setAdvancedOpen] = useState(props.initial.path.length > 0);

  const parsed: GitHubPrefill | null = parseRepoInput(repoText);
  const repoKey = parsed ? `${parsed.owner}/${parsed.repo}` : "";

  // A pasted URL can carry a branch and a path; take them unless the user
  // already typed their own.
  useEffect(() => {
    if (!parsed) return;
    if (parsed.branch.length > 0 && !branchTouched) setBranch(parsed.branch);
    if (parsed.path.length > 0) {
      setPath(parsed.path);
      setAdvancedOpen(true);
    }
    // Only when the parsed repository text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoText]);

  useEffect(() => {
    setRepoText(initialRepoText(props.initial));
    setBranch(props.initial.branch);
    setBranchTouched(props.initial.branch.length > 0);
    setPath(props.initial.path);
    setToken(props.initial.token);
    setAuthor(props.initial.author);
    setAuthorTouched(props.initial.author.length > 0);
    setRemember(props.initial.rememberToken);
  }, [props.initial]);

  // ---- token verification ------------------------------------------------
  const verifySeq = useRef(0);
  const verifiedToken = useRef<string>("");

  const verify = (value: string): void => {
    if (value.length === 0) {
      setTokenStatus({ kind: "idle" });
      return;
    }
    if (value === verifiedToken.current && tokenStatus.kind === "ok") return;
    const seq = ++verifySeq.current;
    setTokenStatus({ kind: "checking" });
    props.verifyToken(value).then(
      (login) => {
        if (seq !== verifySeq.current) return;
        verifiedToken.current = value;
        setTokenStatus({ kind: "ok", login });
        if (!authorTouched) setAuthor(login);
      },
      (err: unknown) => {
        if (seq !== verifySeq.current) return;
        setTokenStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
  };

  // A remembered token is verified once on mount so the login shows up.
  useEffect(() => {
    if (props.initial.token.length > 0) verify(props.initial.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- repository lookup (needs a verified token) -------------------------
  const lookupSeq = useRef(0);
  useEffect(() => {
    if (tokenStatus.kind !== "ok" || !parsed) {
      setRepoStatus({ kind: "idle" });
      return;
    }
    const seq = ++lookupSeq.current;
    setRepoStatus({ kind: "checking" });
    props.lookupRepo(parsed.owner, parsed.repo, token).then(
      (info) => {
        if (seq !== lookupSeq.current) return;
        setRepoStatus({ kind: "ok", info });
        if (!branchTouched && branch.length === 0) setBranch(info.defaultBranch);
      },
      (err: unknown) => {
        if (seq !== lookupSeq.current) return;
        setRepoStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    // Re-run when the repository or the verified token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey, tokenStatus.kind === "ok" ? token : ""]);

  const values = (): ConnectValues => ({
    owner: parsed?.owner ?? "",
    repo: parsed?.repo ?? "",
    branch: branch.trim(),
    path: path.trim(),
    token,
    author: author.trim(),
    rememberToken: remember,
  });

  const canConnect = parsed !== null && token.length > 0 && !props.busy;

  const useRecent = (conn: RecentConnection): void => {
    setRepoText(conn.repoKey);
    setBranch(conn.branch);
    setBranchTouched(true);
    setPath("");
    if (conn.author.length > 0 && !authorTouched) setAuthor(conn.author);
    if (token.length > 0 && !props.busy) {
      const [owner = "", repo = ""] = conn.repoKey.split("/");
      props.onConnect({
        owner,
        repo,
        branch: conn.branch,
        path: "",
        token,
        author: author.trim().length > 0 ? author.trim() : conn.author,
        rememberToken: remember,
      });
    }
  };

  const branches = repoStatus.kind === "ok" ? repoStatus.info.branches : [];

  return (
    <div class="screen connect">
      <div class="connect-card">
        <h1 class="brand">
          syuire<span class="brand-kana">シュイレ</span>
        </h1>
        <p class="lede">GitHub の作業ブランチに直接つないで、Markdown に朱を入れます。</p>

        {props.recent.length > 0 ? (
          <section class="recent" aria-label="最近の接続先">
            <h2 class="section-title">最近の接続先</h2>
            <ul class="recent-list">
              {props.recent.map((conn) => (
                <li key={`${conn.repoKey}@${conn.branch}`}>
                  <button
                    type="button"
                    class="recent-item"
                    disabled={props.busy}
                    onClick={() => useRecent(conn)}
                    title={token.length > 0 ? "この PAT で接続" : "フォームに入力"}
                  >
                    <span class="recent-repo">{conn.repoKey}</span>
                    <span class="recent-branch">@{conn.branch || "既定"}</span>
                    {conn.recentPaths[0] ? <span class="recent-path">{conn.recentPaths[0]}</span> : null}
                  </button>
                  <button
                    type="button"
                    class="small ghost"
                    aria-label={`${conn.repoKey} を一覧から消す`}
                    onClick={() => props.onForgetRecent(conn)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {token.length === 0 ? <p class="hint">PAT を入れてから選ぶと、そのまま接続します。</p> : null}
          </section>
        ) : null}

        <form
          class="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canConnect) props.onConnect(values());
          }}
        >
          <label>
            <span>リポジトリ</span>
            <input
              value={repoText}
              placeholder="https://github.com/owner/repo または owner/repo"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              inputMode="url"
              onInput={(e) => setRepoText((e.currentTarget as HTMLInputElement).value)}
            />
            <span class="field-status">
              {repoText.trim().length === 0 ? (
                <span class="hint">GitHub のページ URL を貼り付けても構いません。</span>
              ) : !parsed ? (
                <span class="error">owner/repo の形で読み取れません。</span>
              ) : repoStatus.kind === "checking" ? (
                <span class="hint">{repoKey} を確認中...</span>
              ) : repoStatus.kind === "error" ? (
                <span class="error">
                  {repoKey}: {repoStatus.message}
                </span>
              ) : repoStatus.kind === "ok" ? (
                <span class="ok">
                  ✓ {repoKey}
                  {repoStatus.info.canPush === false ? "（書き込み権限なし）" : ""}
                </span>
              ) : (
                <span class="hint">{repoLabel(parsed)}</span>
              )}
            </span>
          </label>

          <label>
            <span>
              fine-grained PAT{" "}
              <a href={PAT_HELP_URL} target="_blank" rel="noopener noreferrer" class="help-link">
                作成する ↗
              </a>
            </span>
            <TokenInput value={token} onInput={setToken} onCommit={verify} disabled={props.busy} />
            <span class="field-status">
              {tokenStatus.kind === "checking" ? (
                <span class="hint">確認中...</span>
              ) : tokenStatus.kind === "ok" ? (
                <span class="ok">✓ {tokenStatus.login} として認証</span>
              ) : tokenStatus.kind === "error" ? (
                <span class="error">{tokenStatus.message}</span>
              ) : (
                <span class="hint">対象リポジトリの Contents: Read and write を許可したトークン。</span>
              )}
            </span>
          </label>

          <label>
            <span>ブランチ</span>
            <input
              value={branch}
              list="syuire-branches"
              placeholder={
                repoStatus.kind === "ok" ? `既定: ${repoStatus.info.defaultBranch}` : "空なら既定ブランチ"
              }
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              onInput={(e) => {
                setBranchTouched(true);
                setBranch((e.currentTarget as HTMLInputElement).value);
              }}
            />
            {branches.length > 0 ? (
              <datalist id="syuire-branches">
                {branches.map((b) => (
                  <option value={b} key={b} />
                ))}
              </datalist>
            ) : null}
          </label>

          <label class="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>
              このタブを閉じるまで PAT を覚えておく
              <span class="hint block">
                再読込しても再入力せずに済みます。sessionStorage だけに置き、URL や localStorage には保存しません。
              </span>
            </span>
          </label>

          <details
            class="advanced"
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>詳細設定</summary>
            <label>
              <span>接続後に開くファイル（任意）</span>
              <input
                value={path}
                placeholder="docs/foo.md"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                onInput={(e) => setPath((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label>
              <span>author（コメントの署名）</span>
              <input
                value={author}
                placeholder={tokenStatus.kind === "ok" ? tokenStatus.login : "GitHub のログイン名"}
                autocomplete="off"
                onInput={(e) => {
                  setAuthorTouched(true);
                  setAuthor((e.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>
          </details>

          {props.error ? (
            <p class="error" role="alert">
              {props.error}
            </p>
          ) : null}
          <button type="submit" class="primary big" disabled={!canConnect}>
            {props.busy ? "接続中..." : "接続"}
          </button>
        </form>
      </div>
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
    branch: (prefill?.branch ?? "") || last?.branch || "",
    path: prefill?.path ?? "",
    author: last?.author ?? "",
    token,
    rememberToken,
  };
}
