# Desktop Companion AI

Mac上で動作するデスクトップ常駐型AIアシスタント。
Tauri + React製。Claude Code CLIをバックエンドとして使用。

## ディレクトリ構成

```
desktop-companionAI/
├── index.html                  # エントリーHTML
├── package.json
├── tsconfig.json
├── vite.config.ts
├── public/
│   └── character.png           # キャラクター画像（差し替え可）
├── src/
│   ├── main.tsx                # Reactエントリー
│   ├── App.tsx                 # ルートコンポーネント（位置・表示制御）
│   ├── components/
│   │   ├── Character.tsx       # キャラクター表示・ドラッグ
│   │   └── ChatWindow.tsx      # チャットUI・Claude連携
│   ├── utils/
│   │   └── storage.ts          # localStorageユーティリティ
│   └── styles/
│       └── index.css           # スタイル（透過・ダークテーマ）
└── src-tauri/
    ├── build.rs
    ├── Cargo.toml
    ├── tauri.conf.json         # Tauriウィンドウ設定（透過・最前面）
    ├── icons/                  # アプリアイコン
    └── src/
        ├── main.rs             # Tauriエントリー
        └── claude.rs           # Claude Code CLI実行・ストリーミング
```

## セットアップ

### 前提条件

```bash
# Node.js 18+
node --version

# Rust + Cargo
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Tauri CLI
cargo install tauri-cli

# Claude Code CLI (必須)
npm install -g @anthropic-ai/claude-code

# Claude Codeのセットアップ（APIキー設定）
claude
```

### 開発実行

```bash
# 依存パッケージインストール
npm install

# 開発モードで起動
npm run tauri dev
```

### ビルド（配布用）

```bash
npm run tauri build
# → src-tauri/target/release/bundle/macos/ にアプリが生成される
```

## 使い方

| 操作 | 動作 |
|------|------|
| キャラクタークリック | チャット開く/閉じる |
| `Tab` | キャラクター完全非表示/表示 |
| `ESC` | チャットを閉じる |
| 外側クリック | チャットを閉じる |
| `Enter` | メッセージ送信 |
| キャラクタードラッグ | 位置変更（保存される） |

## カスタマイズ

### キャラクター画像の変更

`public/character.png` を任意の画像に差し替える（推奨: 80×80px 以上、PNG透過）

### Claude Code オプションの変更

`src-tauri/src/claude.rs` の `run_claude()` 内 `cmd.arg("--print")` 部分を編集。

## アーキテクチャ

```
[React UI]
  Character.tsx  ──クリック/ドラッグ──→  App.tsx
  ChatWindow.tsx ──invoke("send_to_claude")──→  [Tauri Backend]
                                                   claude.rs
                                                   └─ spawn("claude --print <msg>")
                                                       ├─ stdout → emit("claude-output")
                                                       ├─ done   → emit("claude-done")
                                                       └─ error  → emit("claude-error")
  ChatWindow.tsx ──listen("claude-output")──→ リアルタイム表示
```
