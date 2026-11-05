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

http://localhost:8080 を開き、開発用ログインで
`sensei@example.ac.jp`(先生)と `1234567@example.ac.jp`(学生)を別ブラウザ/シークレットウィンドウで試せます。

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

Web Push とカメラ(QR 読み取り)は HTTPS が必須です。

```bash
docker compose --profile tunnel up -d
docker compose logs tunnel | grep trycloudflare
```

表示された `https://xxxx.trycloudflare.com` をスマホで開きます。開発構成のままでも使えます(HMR もトンネル越しに動きます)。
Microsoft ログインを使う場合は、その URL を `.env` の `BASE_URL` と Entra ID のリダイレクト URI に設定してください。
Quick Tunnel の URL は起動のたびに変わります。

iPhone の注意点:
- 通知が届くのは **ホーム画面に追加したアプリ**として開いたときだけ(iOS 16.4 以降)
- ホーム画面のアプリと Safari はログイン状態が別。QR は標準カメラではなく **アプリ内の「QRコードを読み取る」** で読む

## 環境変数(.env)

| 変数 | 既定値 | 説明 |
|---|---|---|
| `BASE_URL` | `http://localhost:8080` | 公開 URL。Microsoft ログインのリダイレクト先、Cookie の Secure 判定に使う |
| `SESSION_SECRET` | 開発用の固定値 | セッション Cookie の署名鍵。**本番では必ず変更** |
| `AUTH_MODE` | `dev` | `dev`(開発用ログイン)または `microsoft` |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | - | `AUTH_MODE=microsoft` のとき必須 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | - | 未設定なら通知は送らずログに出すだけ |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | 連絡先(学校のアドレスに変更) |
| `FORCE_OPEN` | `false` | `true` なら時間割を無視して全ルームを授業中扱い(開発用) |
| `RENOTIFY_SECONDS` | `180` | 先生への再通知間隔 |
| `PERIODS` | `1=09:10-10:40,…,5=16:30-18:00` | 時限の時間割(JST)。compose の server.environment に追加して使う |
| `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` | `root` / `callsys` | DB のパスワード |

## Microsoft ログインの設定(AUTH_MODE=microsoft)

1. Entra ID(Azure ポータル)の「アプリの登録」で新規登録
   - サポートされるアカウント: この組織ディレクトリのみ
   - リダイレクト URI(Web): `{BASE_URL}/auth/callback`
2. 「証明書とシークレット」でクライアントシークレットを作成
3. テナント ID・クライアント ID・シークレットを `.env` に設定

学校のテナントでアプリ登録やユーザーの同意が制限されている場合は、情報システム担当に依頼が必要です。

## 仕様メモ(実装済みの挙動)

- ロール: メールのローカル部が7桁の数字なら学生、それ以外は先生
- キュー: 質問・課題チェックを1本の列で、呼んだ順(`calls.id` 昇順)
- 学生: 同じボタンをもう一度押すと取り消し。待機中はもう一方のボタンは押せない
- 学生への通知: 先生が先頭の人を「対応済」にしたら、新しく先頭になった人に「次があなたの番です」
- 先生への通知: 待機人数 0→1 で通知し、アプリを開く(画面が前面に来る)まで 3 分ごとに再通知。待機人数が 0 になったらリセット
- アプリを前面で開いているときは OS の通知を出さず、画面内で音とバイブ
- 先生画面は先頭2人まで表示。待機人数と内訳は常に表示
- 授業時間が終わると、残っている呼び出しは1分以内に自動で取り消し
- ルーム削除で受講登録・呼び出し・メモもすべて削除(DB の ON DELETE CASCADE。削除前にメモ一覧から CSV 保存可)

## まだ入っていないもの

- チューター招待(同等権限の譲渡)
- 祝日・補講などの例外、手動での開始・終了
- サーバー再起動をまたいだ再通知(再起動時は確認済み扱いで復元)
- 本番向けのマイグレーション管理(今は AutoMigrate。列の削除や型変更は自動では行われない)
