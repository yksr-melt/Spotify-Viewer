# nowplaying

歌詞・BPM/キー・再生数を 1 画面にまとめた、Spotify の「いま再生中」ディスプレイです。部屋のサブディスプレイやスマホ立てに置いて眺める用途に合わせて作りました。
*A now-playing display for Spotify: synced lyrics, BPM / key (Camelot), Last.fm stats, and a phone-friendly layout that never scrolls.*

## 機能

- **再生中の表示**: ジャケット・曲名・アーティスト・進捗。ジャケットの色が画面全体のアクセントカラーになります
- **同期歌詞**: 再生位置に合わせて現在の行がハイライトされ、自動でスクロールします（[LRCLIB](https://lrclib.net) → 無ければ Genius）
- **BPM・キー・Camelot**: 曲名の下に `148 BPM` / `3B · D♭` のように表示します（[ReccoBeats](https://reccobeats.com)）
- **Last.fm 連携**（任意）: 最近聴いた曲、今日 / 直近7日 / 今月の再生数
- **Gemini のレビュー**（任意）: Last.fm のタグと音の特徴を根拠にした Genre / Mood
- **再生コントロール**: 再生 / 停止・曲送り・音量・シャッフル・リピート
- **スマホ縦・横 / タブレット対応**: スクロールせず 1 画面に収まります。画面を点けたままにする機能つき
- **夜 / 昼テーマ**、全画面表示

## 動作要件

- Node.js 20 以上
- Spotify アカウント
  - **Web API 経由（推奨）**: どの OS でも動作します
  - **ローカル経由（フォールバック）**: macOS の Spotify デスクトップアプリ + AppleScript
- 再生コントロールの Web API は **Spotify Premium** が必要です（Free では、Mac の Spotify アプリで再生している場合のみ操作できます）

## セットアップ

```bash
git clone https://github.com/yksr-melt/Spotify-Viewer.git
cd Spotify-Viewer
npm install
cp .env.example .env
```

### 1. Spotify Web API（推奨）

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) でアプリを作成します
2. **Redirect URI** に `http://127.0.0.1:8080/callback` を登録します（`localhost` ではなく `127.0.0.1`）
3. `.env` の `SPOTIFY_CLIENT_ID` に Client ID を入れます（Client Secret は不要です）
4. サーバーを起動し、**そのマシンで** `http://127.0.0.1:3000` を開いて、画面上部の「Spotify API に接続」から一度だけ許可します

認証用のポート（8080）は、未認証の間だけ `127.0.0.1` で開き、ログインが終わると閉じます。トークンは `.spotify-token.json` に保存されます（git には含まれません）。

Web API が使えない場合や失敗した場合は、自動で AppleScript（macOS の Spotify アプリ）に切り替わります。

### 2. 任意のキー

`.env` に入れたものだけ機能が有効になります。無い機能は画面から自動的に隠れます。

| 機能 | `.env` | 取得先 |
|---|---|---|
| 最近聴いた曲・再生数・ジャンルの根拠 | `LASTFM_API_KEY`, `LASTFM_USER` | [Last.fm API](https://www.last.fm/api/account/create) |
| Genre / Mood のレビュー | `GEMINI_API_KEY`（`GEMINI_MODEL` で変更可） | [Google AI Studio](https://aistudio.google.com/apikey) |
| 歌詞のフォールバック | `GENIUS_ACCESS_TOKEN` | [Genius API](https://genius.com/api-clients) |

キーはすべてサーバー側で使われ、ブラウザには渡りません。

### 3. 起動

```bash
npm start
```

`http://localhost:3000` を開きます。

## スマホで見る

同じ Wi-Fi のスマホで `http://<PCのローカルIP>:3000` を開きます。

- **全画面**: Android などは最初のタップで全画面になります。iPhone の Safari はウェブページの全画面に対応していないため、共有ボタンから「ホーム画面に追加」して起動してください
- **画面を暗くしない**: ページを開いている間は画面が消えないようにします（HTTP 接続では最初のタップが必要です）。サーバー側も、誰かが開いている間は Mac のスリープを防ぎます
  - 見えない動画（ミュート）を流し続ける方法で実現します（HTTPS・localhost では Screen Wake Lock API も併用します）。音楽を再生している端末で開いたときに再生が止まる場合は、URL の末尾に `?awake=off` を付けると、この機能を使わなくなります
- スマホで再生している曲の場合、音量の遠隔操作はできないため、音量スライダーは非表示になります

## セキュリティ上の注意

このサーバーには認証がありません。**同じネットワークの誰でも**、再生コントロールを操作できます。

- 家庭内の Wi-Fi など、信頼できるネットワークでのみ使ってください
- ルーターのポート開放などで **インターネットに公開しないでください**
- このマシンからだけ使う場合は、`.env` に `HOST=127.0.0.1` を設定してください

## 仕組みとデータ元

| データ | 取得元 |
|---|---|
| 再生状態・操作 | Spotify Web API（フォールバック: AppleScript） |
| 同期歌詞 | [LRCLIB](https://lrclib.net) → [Genius](https://genius.com) |
| BPM・キー・音の特徴 | [ReccoBeats](https://reccobeats.com) |
| タグ・再生数 | [Last.fm](https://www.last.fm) |
| レビュー | [Gemini API](https://ai.google.dev) |

- Spotify の audio-features API は新規アプリでは使えなくなったため、BPM・キーは ReccoBeats から取得しています。**収録の無い曲では表示されません**
- ジャンルは Last.fm のユーザー投稿タグが根拠です。曲単位のタグが無い場合は、その曲がそのアーティスト名で再生されている場合に限って、アーティスト単位のタグで補います。同名の別アーティストのタグが混ざる場合があります
- 根拠になるデータが無い曲は、想像で書かず「評価できません」と表示します
- 歌詞の著作権は各権利者に帰属します。歌詞は表示のために取得するだけで、このリポジトリには保存しません

## 設定（環境変数）

`.env.example` を参照してください。`PORT`（既定 3000）、`AUTH_PORT`（既定 8080）、`HOST` も変更できます。

## 似たプロジェクト

同じ分野には、それぞれ優れたツールがあります。

- [11ason/Spotify-Now-Playing](https://github.com/11ason/Spotify-Now-Playing): 自前サーバーで動く、再生中表示のスクリーンセーバー
- [peterdconradie/Now-Playing-Dashboard-for-Spotify](https://github.com/peterdconradie/Now-Playing-Dashboard-for-Spotify): 歌詞・Wikipedia・MusicBrainz を並べるダッシュボード
- [je09/spotDJ](https://github.com/je09/spotDJ): BPM とキー（Camelot 表記も）を Spotify 上に表示する拡張
- [mantou132/Spotify-Lyrics](https://github.com/mantou132/Spotify-Lyrics): Web プレーヤー用の同期歌詞の拡張

このリポジトリは、それらの機能（再生中表示・同期歌詞・BPM/キー・Last.fm の再生数）を **1 画面にまとめ、スマホの縦・横どちらでもスクロールせずに見られるよう調整した**ものです。

## 使用ライブラリ・素材

- [Express](https://expressjs.com) / [ws](https://github.com/websockets/ws) / [dotenv](https://github.com/motdotla/dotenv)
- [NoSleep.js](https://github.com/richtr/NoSleep.js)（MIT、画面を点けたままにするための動画 `public/vendor/nosleep.*` を同梱）
- フォント: Google Fonts の Mochiy Pop One / Zen Kaku Gothic New / Syne / DM Mono（CDN から読み込み）

## ライセンス

[MIT](LICENSE)
