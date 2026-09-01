# Desktop Companion AI

macOS 上で動作する、デスクトップ常駐型のコンパニオン AI です。  
Tauri + React 製で、Codex CLI をバックエンドとして使います。

現在は通常のチャット機能に加えて、Google Calendar からユーザーが登録した `【ラベル】` で始まる予定を取得して一覧表示し、開始前にローカル通知する予定アシスト機能を持っています。

## 現在の機能

- 画面上に常駐するキャラクター表示
- キャラクターのクリックでチャット表示 / 非表示
- キャラクターのドラッグ移動と位置保存
- キャラクター画像の差し替え
- キャラクターサイズの調整
- チャットウィンドウの幅 / 高さ調整
- 作業ディレクトリの選択
- Codex モデル切り替え
- システムプロンプトの編集
- 会話履歴の一時保存・最大30件の検索・お気に入り
- Codex の応答表示
- 実行中の応答停止
- `タスクメモ` と `Google Calendar` の専用パネル表示
- 日付ごとに保存される今日のタスクメモ（優先度・個別通知・翌日引き継ぎ）
- 8:00〜21:00の30分刻みで選べる定時タスクリマインド
- 朝・昼・夕方のデイリーサポート通知
- `/task`、`/remind`、`/history` などのスラッシュコマンド
- 回答のお気に入り保存と依頼テンプレート
- 画像・PDF・文書などのファイルドロップ添付
- Codex、通知、ショートカット、GitHub接続先の診断画面
- Google Calendar連携設定の表示・非表示
- Google Calendar から当日予定を手動取得
- 通知対象ラベルの追加・削除と、予定タイトルの先頭一致抽出
- 5分前の会話風ローカル通知
- 毎日指定時刻の自動更新オン / オフ
- 透過ウィンドウ + クリック透過による常駐表示

## ディレクトリ構成

```text
desktop-companionAI/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── public/
│   ├── character.png
│   └── character.svg
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── Character.tsx
│   │   └── ChatWindow.tsx
│   ├── styles/
│   │   └── index.css
│   └── utils/
│       └── storage.ts
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── icons/
    └── src/
        ├── main.rs
        ├── lib.rs
        └── codex.rs
```

## 技術スタック

- Frontend: React 18 + Vite + TypeScript
- Desktop shell: Tauri v1
- Backend: Rust
- AI 実行: Codex CLI
- Calendar 連携: Google OAuth 2.0 for Desktop Apps + Google Calendar REST API
- 通知: Tauri notification API

## セットアップ

### 前提条件

- Node.js 18 以上
- Rust / Cargo
- Codex CLI
- macOS
- Google Cloud Console で作成した OAuth Client ID
- GitHub アカウント（別PCと同期する場合）

### 例

```bash
node --version
cargo --version
```

Codex CLI をインストールし、事前に利用可能な状態にしてください。

```bash
npm install -g @openai/codex
codex login
```

### 依存インストール

```bash
pnpm install
```

## GitHub 連携と別PCでの利用

このプロジェクトは GitHub リポジトリで管理しているため、別の Mac でも同じコードを取得して使えます。

リポジトリ:

```text
https://github.com/takzp0717/desktop-companionAI
```

### 新しいPCで使い始める手順

1. GitHub からリポジトリを clone
2. Node.js / Rust / Codex CLI をインストール
3. Codex にログイン
4. `pnpm install`
5. `pnpm run tauri dev` で起動確認
6. 必要に応じて `.app` をビルド

```bash
git clone https://github.com/takzp0717/desktop-companionAI.git
cd desktop-companionAI
pnpm install
codex login
pnpm run tauri dev
```

### 日常的な同期フロー

別PCでも変更を取り込みたい場合は、作業前に pull、変更後に commit / push します。

```bash
git pull
git add .
git commit -m "Update desktop companion"
git push
```

その後、別のPCで再度以下を実行します。

```bash
git pull
```

### GitHub では同期されないもの

以下は GitHub では共有されず、PCごとに再設定が必要です。

- Codex のログイン状態
- アプリ内の `localStorage` 設定
- キャラクター位置
- 会話履歴
- キャラクター画像の差し替え結果
- Google Client ID / Calendar ID の入力内容
- 通知許可や macOS のセキュリティ許可

つまり、コードとアセットは GitHub で同期できますが、アプリの個人設定までは自動同期されません。

### 開発起動

```bash
pnpm run tauri dev
```

### ビルド

フロントのみ:

```bash
pnpm run build
```

`.app` を作る:

```bash
pnpm run tauri build -- --bundles app
```

フルビルド:

```bash
pnpm run tauri build
```

ビルド成果物は通常 `src-tauri/target/release/bundle/macos/` 以下に生成されます。  
この環境では `.dmg` 生成が Tauri の自動スクリプトで失敗することがあったため、必要なら `hdiutil create` で手動生成します。

### `.app` と `.dmg` の作り方

配布用にまず `.app` を作り、必要ならその `.app` から `.dmg` を作ります。

`.app` を作る:

```bash
pnpm run tauri build -- --bundles app
```

生成先:

```text
src-tauri/target/release/bundle/macos/Shaolon AI.app
```

`.dmg` も Tauri に任せて試す場合:

```bash
pnpm run tauri build
```

もし `.dmg` 生成で失敗した場合は、`.app` を作ったあとに手動で `.dmg` を作成します。

```bash
hdiutil create -volname "Shaolon AI" \
  -srcfolder "src-tauri/target/release/bundle/macos/Shaolon AI.app" \
  -ov -format UDZO \
  "Shaolon AI.dmg"
```

手動生成した `.dmg` は通常、プロジェクト直下に作られます。

別の Mac に持っていく最短手順:

1. GitHub から clone
2. `pnpm install`
3. `codex login`
4. `pnpm run tauri build -- --bundles app`
5. 必要なら上の `hdiutil` で `.dmg` を作成

## Google Calendar 設定

`今日の予定` パネル側で以下を設定します。

- `Google Client ID`
- `Google Client Secret`
- `Google Calendar ID`
- `通知対象ラベル`
- `毎日決まった時間に予定を更新`

通常は `Google Calendar ID` は `primary` のままで構いません。

`更新` 後にメインカレンダーが見つからない場合は、認証情報を破棄して次回の更新時にGoogleアカウントの選択画面を開きます。予定を確認したいGoogleアカウントを選び直してください。取得に失敗した場合でも自動で連続再試行はせず、画面にエラーを表示して手動更新を待ちます。

### Google Cloud Console 側の準備

1. プロジェクトを作成
2. `Google Calendar API` を有効化
3. `OAuth consent screen` を設定
4. `OAuth client ID` を作成
5. 種類は `Desktop app` を選ぶ
6. 発行された Client ID と Client Secret をアプリへ貼る

### 注意

現在の実装は Google のデスクトップアプリ向け OAuth 2.0 + PKCE を使います。認証画面はシステムブラウザで開き、結果はMac内の一時的なローカル接続でアプリへ戻します。Client ID と Client Secret はShaolon AIのローカル設定に保存され、Google OAuthのトークン交換にのみ利用します。

## 使い方

### 基本操作

| 操作 | 動作 |
|------|------|
| キャラクターをクリック | チャットを開閉 |
| キャラクターをドラッグ | 位置を変更して保存 |
| `Esc` | チャットを閉じる |
| `Tab` | キャラクター全体を表示 / 非表示 |
| `Enter` | 改行 |
| `Shift + Enter` | メッセージ送信 |
| 送信ボタン | メッセージ送信 |
| 停止ボタン | 実行中の Codex 応答を中断 |
| `📝` | タスクメモパネルを開閉 |
| `🗓︎` | Google Calendarパネルを開閉 |
| `⚙` | 設定画面を開閉 |
| `↩` | 設定・タスク・カレンダーからチャット画面に戻る |
| 終了ボタン | アプリ終了 |

### 設定からできること

- キャラクターサイズの変更
- チャット幅 / 高さの変更
- キャラクター画像の変更
- AI モデルの選択
- 作業ディレクトリの変更
- Auto 実行の ON / OFF
- 起動時リセットの ON / OFF
- システムプロンプトの編集
- 過去セッションの復元

### タスクメモパネルでできること

- 今日のタスクメモの追加・完了・削除
- 最優先タスクを3件まで固定
- タスクごとの通知時刻と10分後の再通知
- 未完了タスクの翌日への自動引き継ぎ
- 通知後、アプリ内の「完了」「10分後」から処理

### Google Calendarパネルでできること

- 朝・昼・夕方のデイリーサポートを個別にオン・オフ
- 8:00〜21:00の30分刻みから定時リマインドの通知時刻を選んで追加
- 設定中の通知時刻だけを一覧表示し、不要な時刻を解除
- Google Calendar連携設定を折りたたんで非表示
- 登録した `【ラベル】` で始まる当日予定の確認
- 通知対象ラベルの追加・削除
- 手動更新
- Google Client ID / Client Secret / Calendar ID の入力
- 毎日指定時刻の自動更新設定

## 動作概要

### Codex チャット

1. フロントエンドから Tauri の `send_to_codex` を呼び出します。
2. Rust 側で `codex exec` を起動します。
3. Auto 実行が ON のときは `--approve-for-me`、OFF のときは `--sandbox read-only` を付けて実行します。
   - `--approve-for-me` は許可審査先をユーザーではなくCodexの自動審査へ切り替え、`workspace-write` サンドボックス内の通常作業を都度確認なしで進めます。
   - macOSの権限ダイアログ、認証情報の入力、危険性の高い操作などはAuto実行とは別扱いで、引き続きユーザー確認が必要です。
4. 作業ディレクトリに非 ASCII 文字が含まれる場合は、一時ディレクトリにシンボリックリンクを作って Codex に渡します。
5. JSON イベントを読み取り、最終応答を `codex-output` として返します。
6. 正常終了時は `codex-done`、異常時は `codex-error` を返します。
7. 停止時は `stop_codex` で実行中プロセスを終了します。

### カレンダー予定

1. システムブラウザでGoogleのデスクトップOAuth認証を行い、PKCEでアクセストークンを取得します。
2. Google Calendar API から当日予定を取得します。
3. タイトルが登録済みの `【ラベル】` で始まるイベントだけ抽出します。
4. `今日の予定` パネルに `開始時刻 + タイトル` を一覧表示します。
5. 終日予定以外は、開始5分前に Tauri のローカル通知を送ります。
6. 通知文は LLM 生成ではなくテンプレートからランダム選択します。

会話コンテキスト、設定、履歴、当日予定キャッシュは `localStorage` に保存します。

## 実装メモ

- [src/App.tsx](./src/App.tsx)
  画面上のキャラクター表示、位置管理、可視状態、クリック透過制御
- [src/components/Character.tsx](./src/components/Character.tsx)
  キャラクター描画とドラッグ操作
- [src/components/ChatWindow.tsx](./src/components/ChatWindow.tsx)
  チャット UI、設定 UI、今日の予定 UI、Google Calendar 取得、通知予約
- [src/utils/storage.ts](./src/utils/storage.ts)
  設定値、サイズ、画像、会話セッション、当日予定キャッシュの保存と復元
- [src-tauri/src/main.rs](./src-tauri/src/main.rs)
  Tauri アプリ起動、透過ウィンドウ、カーソル透過制御
- [src-tauri/src/codex.rs](./src-tauri/src/codex.rs)
  Codex CLI の起動、イベント処理、停止処理

## カスタマイズ

### デフォルト画像の変更

`public/character.png` を差し替えると、初期キャラクター画像を変更できます。

### Codex 実行オプションの変更

`src-tauri/src/codex.rs` で、以下の CLI オプション制御を変更できます。

- `--model`
- `--sandbox read-only`
- `--approve-for-me`
- `--ephemeral`
- `--skip-git-repo-check`
- 実行ディレクトリ (`--cd`)

### 予定の抽出ルール変更

`今日の予定` パネルの `通知対象ラベル` から、抽出対象を自由に追加・削除できます。

## 注意点

- 現状は macOS 前提です。
- Codex CLI が利用できないと応答できません。
- Auto 実行モードでは通常作業の許可要求をCodexの自動審査へ送り、`workspace-write` の範囲でコマンド実行やファイル変更を進めます。macOS側の権限確認や危険性の高い操作は引き続き確認が必要です。
- カレンダー連携には Google Client ID と Client Secret の設定が必要です。
- カレンダー通知はアプリ起動中のみ動作します。
- 自動更新はアプリ起動中にのみスケジュールされます。
- タスクメモの定時通知もアプリ起動中のみ動作します。
- タスク通知の操作ボタンは、通知後にShaolon AIを開いた画面内に表示されます。
- `.dmg` は環境によって Tauri の標準ビルドで失敗する場合があります。
- macOS の別PCでは初回起動時に Gatekeeper の許可が必要になる場合があります。

## Shaolon AI 0.2 の追加機能

- 全画面アプリと別Spaceでも同じキャラクターを表示
- キャラクターのドラッグ中にチャットもリアルタイム追従
- `Option + Space` でチャットを呼び出すグローバルショートカット
- `Command + Shift + Space` を予備ショートカットとして利用可能
- 現在の画面を明示的に添付して質問する機能
- クリップボード連携（v0.3では直前のAI回答をコピー）
- 相談・開発・文章・調査・秘書の作業モード
- ユーザーが確認・編集・削除できる明示的な記憶
- Auto実行時は送信前確認なしでCodexへ依頼
- カレンダー通知の頻度（静か・標準・積極的）

画面キャプチャはユーザーが「画面」ボタンを押したときだけ実行します。初回利用時は、macOSの「プライバシーとセキュリティ > 画面収録」でShaolon AIの許可が必要です。

## Shaolon AI 0.3 の追加機能

- タスクごとの通知、最優先3件、10分スヌーズ、翌日引き継ぎ
- 朝・昼・夕方のデイリーサポート
- `/` 入力によるローカルコマンド候補
- 「コピー」ボタンで直前のAI回答をそのままコピー
- 「コマンド」ボタンから利用可能なコマンド一覧を表示・選択
- 最大30件の会話履歴検索とお気に入り
- 回答の保存と依頼テンプレート
- Finderからのファイルドロップ添付（最大5件）
- Codex CLI、作業フォルダ、通知、ショートカット、Gitリモートの診断

### 主なスラッシュコマンド

| コマンド | 動作 |
|---|---|
| `/task 内容` | 今日のタスクを追加 |
| `/remind 15:30 内容` | 通知時刻つきタスクを追加 |
| `/today` | タスクメモを開く |
| `/history 検索語` | 会話履歴を検索 |
| `/template 名前 \| 依頼文` | 依頼テンプレートを保存 |
| `/diagnostics` | 診断画面を開く |
| `/clear` | 現在の会話を保存して整理 |
