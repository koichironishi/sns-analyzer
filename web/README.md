# SNS分析 Web版（Next.js＋Supabase）

Python 版（`../snsanalyzer`）の全機能を、MEO コンソールと同じ **Supabase** を使う別アプリとして作り直したものです（ログインは MEO と共通、クライアントは SNS分析 専用）。Vercel で動かします。

- ログイン：スタッフは MEO と同じアカウント（全クライアントを運用）
- クライアント：SNS分析 専用（MEO のクライアントとは別）。追加・編集は SNS分析 の画面で行い、削除は管理者のみ
- 閲覧ユーザー：クライアントごとに SNS分析 の画面で発行（初期パスワードを表示し、初回ログイン時に変更を求める）。自社のレポートのみ閲覧
- SNS 連携：Facebook ログイン（Facebook ページ＋紐づく Instagram）、Threads ログイン、X（Bearer Token）
- レポート：概要／AI分析／SNS比較／競合比較／投稿時間／形式・タグ／投稿ランキング／ダウンロード（CSV・Markdown・ZIP）、PDF 保存（印刷）
- 設定：競合の登録、AI分析の同意、事業内容、CSV 取り込み、フォロワー数の手動記録、データ削除
- 管理者：全体設定（保存期間・収集件数・AI モデル・ポリシーの事業者情報）、操作ログ
- 公開ページ：プライバシーポリシー、利用規約、データ削除のご案内・状況確認、Meta / Threads のデータ削除コールバック

## 1. Supabase にテーブルを追加する

Supabase の SQL Editor で **`../supabase/sns.sql` だけ** を実行します。

- 追加するのは `sns_` で始まる表だけで、MEO の表は変更しません。何度実行しても安全です
- **MEO の `schema.sql` は実行しないでください**（MEO の表を作り直してしまいます）
- アクセストークンを持つ `sns_connections` は、画面のセッションからは読めません（サーバーの service_role だけが読み書き）

## 2. 環境変数

`.env.example` を参考に、Vercel の Environment Variables に設定します。

| 変数 | 内容 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | MEO と同じ Supabase プロジェクトの値 |
| `SUPABASE_SERVICE_ROLE_KEY` | 同じプロジェクトの service_role キー（サーバーでのみ使用） |
| `NEXT_PUBLIC_SITE_URL` | このアプリの公開 URL（例：`https://sns.example.jp`）。OAuth のリダイレクト先に使う |
| `META_APP_ID` / `META_APP_SECRET` | Facebook・Instagram 用の Meta アプリ |
| `THREADS_APP_ID` / `THREADS_APP_SECRET` | Threads 用のアプリ（Meta アプリの Threads のユースケース） |
| `ANTHROPIC_API_KEY` | AI分析を使う場合 |
| `CRON_SECRET` | 自動収集の認証（長いランダム文字列。例：`openssl rand -hex 32`） |

## 3. Meta アプリ（Facebook ページ＋Instagram）

MEO のアプリとは別に作ることをおすすめします（必要な権限が違うため）。

1. [Meta for Developers](https://developers.facebook.com/apps/) でアプリを作成し、「Facebook ログイン for Business」を追加
2. 有効な OAuth リダイレクト URI：`{NEXT_PUBLIC_SITE_URL}/api/connect/meta/callback`
3. 権限：`pages_show_list` `pages_read_engagement` `read_insights` `instagram_basic` `instagram_manage_insights` `business_management`
4. 設定 → ベーシック
   - プライバシーポリシーの URL：`{NEXT_PUBLIC_SITE_URL}/privacy`
   - 利用規約の URL：`{NEXT_PUBLIC_SITE_URL}/terms`
   - データ削除：「データ削除コールバック URL」に `{NEXT_PUBLIC_SITE_URL}/api/data-deletion/meta`
5. 本番公開の前にアプリレビューで上記の権限を申請します（開発モードではアプリの役割を持つ人だけが連携できます）
6. 競合の Facebook ページを取得するには「Page Public Content Access」の審査が別途必要です（なくても Instagram の競合は Business Discovery で取得できます）

## 4. Threads アプリ

1. Meta アプリに「Threads API にアクセス」のユースケースを追加
2. リダイレクトコールバック URL：`{NEXT_PUBLIC_SITE_URL}/api/connect/threads/callback`
3. アンインストールコールバック URL・削除コールバック URL：どちらも `{NEXT_PUBLIC_SITE_URL}/api/data-deletion/threads`
4. 権限：`threads_basic` `threads_manage_insights`。競合のフォロワー数も取る場合は `threads_profile_discovery` の承認を得てから、環境変数 `THREADS_PROFILE_DISCOVERY=1` を設定して連携し直す
5. Threads のアプリ ID・シークレットを `THREADS_APP_ID` / `THREADS_APP_SECRET` に設定

## 5. X

X Developer Portal でアプリを作り、Bearer Token を発行します。クライアントの「設定・連携」→ X の「Bearer Token で連携する」に、ユーザー名と一緒に入力します。X API は従量課金のため、全体設定の「1回あたりの取得件数の上限」で使用量を抑えてください。

## 6. Vercel にデプロイ

1. このリポジトリを Vercel にインポートし、**Root Directory を `web`** にする
2. 環境変数を設定してデプロイ
3. 独自ドメインを使う場合は、ドメインを追加してから `NEXT_PUBLIC_SITE_URL` と各アプリのリダイレクト URI をそのドメインに合わせる

`vercel.json` で東京リージョン（`hnd1`）と、1日1回の自動収集（日本時間 4:00）を設定しています。MEO の Supabase が別のリージョンにある場合は、`regions` をそれに近い場所に変えてください。

### 自動収集について

- 1回の実行は最大5分です。締め切りまでに処理できた「クライアント×SNS」だけを進め、残りは次回に回します（同じ日に2回以上は取り直しません）
- Vercel の Hobby プランは cron が1日1回のため、クライアントや連携が多い場合は、`../supabase/sns-cron.sql` で Supabase（pg_cron＋pg_net）から1日に数回呼び出してください
- 手動で実行するときは、クライアントの「設定・連携」→「今すぐ収集」
- 保存期間（全体設定。既定400日）を過ぎたデータは、自動収集のたびに削除します

## 7. 公開前のチェック

- 全体設定で、プライバシーポリシー・利用規約の事業者情報（【要記入】の項目）をすべて入力し、専門家の確認を受ける
- AI分析を使うクライアントは、「設定・連携」→「AI分析の同意」で同意を記録する（記録がないと実行できません）

## 開発

```bash
npm install
npm run dev
```

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

`npm test` の内容：

- `tests/sql.test.ts`：`sns.sql` を PGlite（WASM の PostgreSQL）に流し、RLS（スタッフ／閲覧ユーザー／無関係なユーザー）とトークンの非公開を確認
- `tests/parity.test.ts`：分析・競合比較の結果が Python 版と一致することを確認
- `tests/collectors.test.ts`：各 SNS の API 応答から正しく取り込めるか（偽の fetch で確認）
- `tests/lib.test.ts`：OAuth のトークン交換、署名の検証、CSV・ZIP の書き出し、CSV の取り込み

### 画面の動作確認（本物の Supabase なし）

`tests/e2e/fake-supabase.ts` は、PGlite 上に MEO のスタブと `sns.sql` を流し、デモデータを入れた「テスト用の偽 Supabase」です（本番では使いません）。

```bash
npm run e2e:supabase
```

別のターミナルで、偽 Supabase を向けて起動します（ログイン用のテストアカウントは `tests/e2e/fake-supabase.ts` の `USERS` を参照）。

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=fake-anon-key SUPABASE_SERVICE_ROLE_KEY=fake-service-role-key npm run dev
```
