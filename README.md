# akaire(朱入れ)

GitHub を共有の正本とする Markdown 朱入れクライアント。PC と iPad から本文にコメント・返信を付け、Git コミットとして保存する。
Web は静的 SPA から GitHub に直接アクセスし、Windows は同じ UI とローカル実行層で既存 clone の commit・pull・push を扱う。
業務データは Git リポジトリに置き、サービス側に DB や利用者のリポジトリ情報を持たない。AI による修正・自動実行は外部システムで行う。

設計案は [DESIGN.md](./DESIGN.md)。

## 状態

- 2026-09-07: 設計案 v0.5。実装開始(M0 core 完了、M1 Web / M2 ローカル実装中)
- 2026-09-08: M0〜M3 の初期実装が揃い、ローカル実行層で朱入れ→保存→刷り出しを通しで確認。GitHub 実リポジトリと実機 iPad は未検証

## 構成

```text
packages/
├─ core/    # 形式、parse/serialize、表示文字列↔ソース対応、配置、操作再適用、刷り出し
├─ web/     # Preact UI、GitHubAdapter、LocalAdapterClient
└─ local/   # localhost 実行層(UI 配信、既存 clone の Git 操作)、`akaire serve`
```

## 開発

```bash
npm install
npm test
npm run build
```

Web UI の開発サーバー:

```bash
npm run dev -w @akaire/web
```

ローカル実行層(既存 clone を指定して起動し、表示された URL をブラウザで開く):

```bash
npm run serve -- <cloneのパス>
```

`--port N` で待受ポートを固定、`--no-open` でブラウザを自動で開かない。
