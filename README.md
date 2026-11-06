# 先生呼び出しアプリ(プロトタイプ)

授業中に学生が先生を呼び出し、呼んだ順に対応してもらうための PWA。

```
ブラウザ ─▶ nginx(入口 :8080)─┬─ /api, /auth ─▶ server(Go / Echo + GORM)─▶ mysql
                                └─ それ以外    ─▶ web(React)
```

すべて Docker で動きます。手元に Go や Node を入れる必要はありません。

| コンテナ | 開発構成(`docker compose up`) | 本番構成(`-f docker-compose.yml`) |
|---|---|---|
| nginx | 入口。振り分け・SSE・WebSocket | 同じ |
| web | Vite 開発サーバー(保存すると即反映) | ビルド済みファイルを nginx で配信 |
| server | air(.go を保存すると再ビルド・再起動) | ビルド済みバイナリ |
| mysql | MySQL 8.4 | 同じ |

```
callsys/
├── docker-compose.yml           本番構成(基本)
├── docker-compose.override.yml  開発構成の差分(docker compose up で自動的に重ねられる)
├── .env.example
├── nginx/templates/             入口 nginx の設定(起動時に環境変数で振り分け先が決まる)
├── server/                      Go(Dockerfile は dev / prod の2段構成、.air.toml)
└── web/                         React(Dockerfile は dev / prod の2段構成、本番配信用 nginx.conf)
```

## 開発

```bash
cp .env.example .env
docker compose up -d --build
```

http://localhost:8080 を開き、学校の Microsoft アカウントでログインします(先に下の「Microsoft ログインの設定」が必要)。
Azure の設定なしで試すときは `.env` を `AUTH_MODE=dev` にすると、`sensei@example.ac.jp`(先生)や `1234567@example.ac.jp`(学生)の開発用ログインが使えます。

- `web/src` を保存 → ブラウザに即反映(ページの再読み込みなし)
- `server/*.go` を保存 → air が再ビルドして再起動(数秒)
- 初回起動時に `server/go.sum` が作られるので、git に入れておいてください
- `npm install` は web コンテナの起動時に自動で実行されます。パッケージを追加するときは
  `docker compose exec web npm install <パッケージ名>`

ログ: `docker compose logs -f server web`

### Web Push の鍵(初回のみ)

```bash
docker compose run --rm --no-deps server sh -c "go mod tidy && go run . -genvapid"
```

出力された2行を `.env` に貼り、`docker compose up -d` で反映します。

## 本番構成

```bash
docker compose -f docker-compose.yml up -d --build
```

override を読み込まないので、Go はバイナリ、React はビルド済みファイルで動きます(ソースのマウントもなし)。

## スマホで試す(HTTPS)

Web Push・カメラ(QR 読み取り)・Microsoft ログインには HTTPS が必要です。Cloudflare のトンネルで HTTPS の URL を用意します。

### 名前付きトンネル(URL が固定・おすすめ)

URL が変わらないので、Azure のリダイレクト URI や `.env` を一度設定すれば済みます。Cloudflare のアカウントと、Cloudflare で管理しているドメインが必要です。

1. Cloudflare のダッシュボード →「Zero Trust」→「ネットワーク」→「Tunnels」でトンネルを作成し、コネクタは「Docker」を選ぶ
2. 表示されたコマンドの `--token` の後ろ(`eyJ...`)を `.env` の `CLOUDFLARE_TUNNEL_TOKEN` に入れる
   (Windows 用の `cloudflared.exe service install eyJ...` が表示された場合も、`eyJ...` の部分が同じトークン)
3. トンネルの「公開ホスト名」を追加する
   - サブドメイン・ドメイン: 例 `call.example.com`
   - サービス: タイプ `HTTP`、URL `nginx:80`
4. `.env` の `BASE_URL` を `https://call.example.com` にし、Azure のリダイレクト URI に `https://call.example.com/auth/callback` を追加
5. 起動

```bash
docker compose --profile tunnel up -d
docker compose logs tunnel   # "Registered tunnel connection" が出れば接続済み
```

トークンはパスワードと同じです。Git やチャットに貼らないでください。漏れたときはダッシュボードでトンネルを作り直します。

### Quick Tunnel(アカウント不要・URL は毎回変わる)

```bash
docker compose --profile quicktunnel up -d
docker compose logs quicktunnel | grep trycloudflare      # PowerShell: | Select-String trycloudflare
```

表示された `https://xxxx.trycloudflare.com` をスマホで開きます。コンテナを作り直すたびに URL が変わるので、そのたびに `BASE_URL` と Azure のリダイレクト URI の変更が必要です。

iPhone の注意点:
- 通知が届くのは **ホーム画面に追加したアプリ**として開いたときだけ(iOS 16.4 以降)
- ホーム画面のアプリと Safari はログイン状態が別。QR は標準カメラではなく **アプリ内の「QRコードを読み取る」** で読む

## 環境変数(.env)

| 変数 | 既定値 | 説明 |
|---|---|---|
| `BASE_URL` | `http://localhost:8080` | 公開 URL。Microsoft ログインのリダイレクト先、Cookie の Secure 判定に使う |
| `SESSION_SECRET` | 開発用の固定値 | セッション Cookie の署名鍵。**本番では必ず変更** |
| `AUTH_MODE` | `microsoft` | `microsoft`(学校の Microsoft アカウントのみ)。Azure なしで試すときだけ `dev` |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | - | Microsoft ログインに必須(下の「Microsoft ログインの設定」) |
| `ALLOWED_EMAIL_DOMAINS` | - | ログインを許可するメールのドメイン(カンマ区切り)。空なら制限しない |
| `DEV_LOGIN_PASSWORD` | - | 設定すると Microsoft ログインと併用で開発用ログインが使える(要パスワード・テスト用) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | - | 未設定なら通知は送らずログに出すだけ |
| `VAPID_SUBJECT` | `admin@example.com` | 通知サービスに伝える連絡先。自分か学校のメールアドレスに変更(`mailto:` は付けても付けなくてもよい) |
| `FORCE_OPEN` | `false` | `true` なら時間割を無視して全ルームを授業中扱い(開発用) |
| `RENOTIFY_SECONDS` | `180` | 先生への再通知間隔 |
| `PERIODS` | `1=09:15-10:45,…,6=18:45-20:15` | 時限の時間割(JST)。形式は `時限=開始-終了` をカンマ区切り |
| `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` | `root` / `callsys` | DB のパスワード |

## Microsoft ログインの設定

ログインは学校の Microsoft アカウントのみです(`AUTH_MODE=microsoft`、既定)。
名前は Microsoft アカウントの表示名を使い、ログインのたびに最新の表示名で更新します。

### 1. Entra ID にアプリを登録する

Azure ポータル(https://portal.azure.com)→「Microsoft Entra ID」→「アプリの登録」→「新規登録」

| 項目 | 設定 |
|---|---|
| 名前 | 先生呼び出し(任意) |
| サポートされているアカウントの種類 | **この組織ディレクトリのみ**(シングルテナント) |
| リダイレクト URI | プラットフォーム「Web」、`{BASE_URL}/auth/callback` |

リダイレクト URI は使う URL ごとに追加します(「認証」画面から複数登録できます)。

- 手元の PC: `http://localhost:8080/auth/callback`
- トンネル: `https://xxxx.trycloudflare.com/auth/callback`(Quick Tunnel は起動のたびに URL が変わるので、そのたびに追加が必要)
- 本番: `https://(学校のサーバー)/auth/callback`

### 2. シークレットを作る

「証明書とシークレット」→「新しいクライアント シークレット」。表示された「値」をすぐに控えます(あとから見られません)。

### 3. `.env` に設定する

| 変数 | どこにあるか |
|---|---|
| `AZURE_TENANT_ID` | アプリの「概要」→ ディレクトリ (テナント) ID |
| `AZURE_CLIENT_ID` | アプリの「概要」→ アプリケーション (クライアント) ID |
| `AZURE_CLIENT_SECRET` | 手順 2 で控えた値 |
| `BASE_URL` | ブラウザで開く URL(リダイレクト URI と同じもの) |
| `ALLOWED_EMAIL_DOMAINS` | 学校のメールのドメイン(例: `school.ac.jp`)。空なら制限しない |

API のアクセス許可は既定の「Microsoft Graph / User.Read」のままで大丈夫です(使うのは `openid` `profile` `email` だけ)。
学校のテナントで「ユーザーによるアプリへの同意」が制限されている場合は、ログイン時に「管理者の承認が必要」と表示されます。
その場合は情報システム担当に、アプリの「API のアクセス許可」で「管理者の同意を与えます」を押してもらってください。

### ログインできるアカウント

- 学校のテナントのアカウントだけ(テナント専用の発行元で ID トークンを検証し、`tid` も確認)
- ゲストアカウント(外部から招待されたアカウント)は不可
- `ALLOWED_EMAIL_DOMAINS` を設定した場合は、そのドメインのアカウントだけ
- 学生か先生かは、サインイン名(例: `1234567@school.ac.jp`)の `@` の前が7桁の数字かどうかで判定

### 先生のアカウントがないときに試す(開発用ログインの併用)

`.env` に `DEV_LOGIN_PASSWORD` を設定すると、Microsoft ログインはそのままで、ログイン画面に「開発用ログイン(テスト用)」が出ます。
メールアドレス・表示名・このパスワードを入れるとログインできます(`@` の前が7桁の数字なら学生、それ以外は先生)。

- 例:PC は開発用ログインで `sensei@example.ac.jp`(先生)、スマホは自分の Microsoft アカウント(学生)
- 公開している URL でも使えるよう、パスワードが必要です。12文字以上にしてください
- Microsoft で使われているメールアドレスは、開発用ログインでは使えません(本物のアカウントになりすませないように)
- 本番では `DEV_LOGIN_PASSWORD` を空にしてください

### Azure なしで試す(開発用)

`AUTH_MODE=dev` にすると、Microsoft ログインを使わず、開発用ログインだけになります(`DEV_LOGIN_PASSWORD` が空ならパスワードも不要)。本番では使わないでください。

## 仕様メモ(実装済みの挙動)

- ログイン: 学校の Microsoft アカウントのみ。名前は Microsoft の表示名(ログインのたびに更新)
- ロール: サインイン名の `@` の前が7桁の数字なら学生、それ以外は先生
- キュー: 質問・課題チェックを1本の列で、呼んだ順(`calls.id` 昇順)
- 学生: 同じボタンをもう一度押すと取り消し。待機中はもう一方のボタンは押せない
- 学生への通知: 先生が先頭の人を「対応済」にしたら、新しく先頭になった人に「次があなたの番です」
- 先生への通知: 待機人数 0→1 で通知し、アプリを開く(画面が前面に来る)まで 3 分ごとに再通知。待機人数が 0 になったらリセット
- 通知は常に OS の通知として表示し、アプリを開いていれば画面内でも音とバイブ(iOS は通知を出さないプッシュが続くと登録を取り消すため)
- 先生・学生のホームに「テスト通知を送る」ボタン。送信結果(届いたか、失敗の理由)をその場で表示
- 通知の送信結果はすべてサーバーのログに出る(`docker compose logs server | Select-String push:`)
- 先生画面は先頭2人まで表示。待機人数と内訳は常に表示
- 授業時間が終わると、残っている呼び出しは1分以内に自動で取り消し
- 先生はルーム画面の「授業を開始 / 授業を終了」で手動で切り替えられる(時間割より優先)
  - 開始: 今から100分間開く(時間割外のデバッグや補講・延長に使う)
  - 終了: すぐに閉じて待機中の呼び出しを取り消す。時間割上の授業中なら、その時限が終わるまで閉じたまま
- ルーム削除で受講登録・呼び出し・メモもすべて削除(DB の ON DELETE CASCADE。削除前にメモ一覧から CSV 保存可)

## まだ入っていないもの

- チューター招待(同等権限の譲渡)
- 祝日などの自動での例外処理(今は先生が手動で開始・終了する)
- サーバー再起動をまたいだ再通知(再起動時は確認済み扱いで復元)
- 本番向けのマイグレーション管理(今は AutoMigrate。列の削除や型変更は自動では行われない)
