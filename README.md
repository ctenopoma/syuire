# syuire(シュイレ・朱入れ)

[WEB Pages](https://ctenopoma.github.io/syuire/)

GitHub を共有の正本とする Markdown 朱入れクライアント。PC と iPad から本文にコメント・返信を付け、Git コミットとして保存する。
Web は静的 SPA から GitHub に直接アクセスし、Windows は同じ UI とローカル実行層で既存 clone の commit・pull・push を扱う。
業務データは Git リポジトリに置き、サービス側に DB や利用者のリポジトリ情報を持たない。AI による修正・自動実行は外部システムで行う。

設計案は [DESIGN.md](./DESIGN.md)。

## 状態

- 2026-09-07: 設計案 v0.5。実装開始(M0 core 完了、M1 Web / M2 ローカル実装中)
- 2026-09-08: M0〜M3 の初期実装が揃い、ローカル実行層で朱入れ→保存→刷り出しを通しで確認。GitHub 実リポジトリと実機 iPad は未検証
- 2026-09-13: UI を見直し。接続はリポジトリ(URL 可)と PAT だけで開始し、ブランチ・署名は自動、ファイルは接続後に選ぶ。最近の接続先・ファイル、リポジトリ全体からの検索、目次・朱一覧パネル、朱の対象の強調表示、コードの着色、脚注・参照リンク、配色と文字サイズの設定を追加

## 構成

```text
packages/
├─ core/    # 形式、parse/serialize、表示文字列↔ソース対応、配置、操作再適用、刷り出し
├─ web/     # Preact UI、GitHubAdapter、LocalAdapterClient
└─ local/   # localhost 実行層(UI 配信、既存 clone の Git 操作)、`syuire serve`
```

## 開発

```bash
npm install
npm test
npm run build
```

## 使い方(Web)

1. 接続画面で「リポジトリ」に GitHub のページ URL(`https://github.com/owner/repo/blob/branch/docs/a.md` など)か `owner/repo` を貼る。
2. fine-grained PAT(対象リポジトリの Contents: Read and write)を貼り付ける。ログイン名が確認され、既定ブランチが入る。
3. 「接続」でファイル一覧へ。最近開いたファイル、フォルダ内の絞り込み、「全体から探す」でリポジトリ全体の Markdown から選べる。
4. 本文を選択して「朱を追加」。「目次」から見出し・朱の一覧・表示設定(文字サイズ、配色、コードの着色、画像の自動読み込み)を開ける。

Web UI の開発サーバー:

```bash
npm run dev -w @syuire/web
```

ローカル実行層(既存 clone を指定して起動し、表示された URL をブラウザで開く):

```bash
npm run serve -- <cloneのパス>
```

`--port N` で待受ポートを固定、`--no-open` でブラウザを自動で開かない。
