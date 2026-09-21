const express = require("express");
const { execFile } = require("child_process");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const spotifyApi = require("./spotify");
const lyricsLrclib = require("./lyrics");
const { getFeatures } = require("./features");
const lastfm = require("./lastfm");
const geminiReview = require("./review");

dotenv.config();
loadLocalEnv();

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.static("public"));

const host = process.env.HOST || undefined;

const server = app.listen(port, host, () => {
  console.log(`http://localhost:${port}`);
});

const wss = new WebSocket.Server({ server, maxPayload: 1024 });


server.on("upgrade", (request, socket, head) => {
  console.log("Upgrade request received");
});

app.use((req, res, next) => {
  res.removeHeader("X-Frame-Options");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'self' https://discord.com https://*.discord.com"
  );
  next();
});


// ---- Spotify データ取得（Web API 優先 → AppleScript フォールバック） ----

const API_INTERVAL_MS = 2000;
const LOCAL_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 2000;

let lastLog = "";
function logOnce(message) {
  if (message === lastLog) return;
  lastLog = message;
  console.error(message);
}

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 4000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

const LOCAL_SCRIPT = `
if application "Spotify" is not running then return "not_running"
tell application "Spotify"
  if player state is stopped then return "stopped"
  set t to current track
  set art to ""
  try
    set art to artwork url of t
  end try
  return (name of t) & "||" & (artist of t) & "||" & (album of t) & "||" & (player position as text) & "||" & ((duration of t) as text) & "||" & (player state as text) & "||" & art & "||" & (sound volume as text) & "||" & (shuffling as text) & "||" & (repeating as text) & "||" & (spotify url of t)
end tell`;

async function getLocalData() {
  try {
    const out = await runOsascript(LOCAL_SCRIPT);
    if (!out || out === "not_running" || out === "stopped") return null;

    const d = out.split("||");
    const volume = parseInt(d[7], 10);
    return {
      track: d[0],
      artist: d[1],
      album: d[2],
      position: parseFloat((d[3] || "").replace(",", ".")) || 0,
      duration: (parseInt(d[4], 10) || 0) / 1000,
      state: d[5],
      artwork: d[6] || null,
      volume: Number.isFinite(volume) ? volume : null,
      shuffle: d[8] === "true",
      repeat: d[9] === "true" ? "context" : "off",
      id: (d[10] || "").match(/^spotify:track:([0-9A-Za-z]{22})$/)?.[1] || null,
      isAd: (d[10] || "").startsWith("spotify:ad"),
      source: "local",
    };
  } catch (err) {
    logOnce(`Spotify AppleScript error: ${err.message}`);
    return null;
  }
}

async function getPlayback() {
  if (spotifyApi.isAuthorized()) {
    try {
      const data = await spotifyApi.getPlayback();
      if (data) {
        lastLog = "";
        return data;
      }
    } catch (err) {
      logOnce(`Spotify API: ${err.message}（AppleScript にフォールバックします）`);
    }
  }
  return (await getLocalData()) || { state: "stopped", source: "none" };
}

let lastData = null;
let lastPayload = null;

function broadcast(data) {
  lastData = data;
  const payload = JSON.stringify(data);
  if (payload === lastPayload) return;
  lastPayload = payload;

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

let pollTimer = null;

async function poll() {
  pollTimer = null;
  let delay = IDLE_INTERVAL_MS;

  // 閲覧者がいなければ Spotify への問い合わせ自体をスキップして負荷を抑える
  if (wss.clients.size > 0) {
    try {
      const data = await getPlayback();
      delay =
        data.source === "api"
          ? API_INTERVAL_MS
          : data.source === "local"
            ? LOCAL_INTERVAL_MS
            : IDLE_INTERVAL_MS;
      broadcast(data);
    } catch (error) {
      console.error("Error in data update loop:", error);
    }
  }

  startAuthServer();
  pollTimer = setTimeout(poll, delay);
}

function pollSoon() {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, 0);
}

// ---- Mac をスリープさせない（表示中のクライアントが居る間だけ） ----
// スリープするとサーバーが止まってスマホ側の表示も更新されなくなるため、-i でアイドルスリープだけ防ぐ
const { spawn } = require("child_process");
let caffeinate = null;

function updateCaffeinate() {
  const needed = wss.clients.size > 0;
  if (needed && !caffeinate) {
    caffeinate = spawn("caffeinate", ["-i"], { stdio: "ignore" });
    caffeinate.on("error", () => {
      caffeinate = null;
    });
    caffeinate.on("exit", () => {
      caffeinate = null;
    });
  } else if (!needed && caffeinate) {
    caffeinate.kill();
    caffeinate = null;
  }
}

process.on("exit", () => caffeinate?.kill());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0));
}

// ---- 認証（Spotify Web API / PKCE） ----

app.get("/auth/status", (req, res) => {
  res.json({
    configured: spotifyApi.isConfigured(),
    authorized: spotifyApi.isAuthorized(),
  });
});

// 認証専用リスナー（Redirect URI: http://127.0.0.1:${authPort}/callback）。
// ループバックのみで待ち受け、未認証の間だけ開き、ログイン完了で閉じる。
const authPort = Number(process.env.AUTH_PORT) || 8080;
let authServer = null;

function startAuthServer() {
  if (authServer || !spotifyApi.isConfigured() || spotifyApi.isAuthorized()) return;

  const authApp = express();

  authApp.get("/auth/login", (req, res) => {
    res.redirect(spotifyApi.startLogin());
  });

  authApp.get("/callback", async (req, res) => {
    try {
      await spotifyApi.handleCallback(req.query);
      pollSoon();
      res.redirect(`http://127.0.0.1:${port}/`);
      stopAuthServer();
    } catch (err) {
      console.error("Spotify auth error:", err);
      res.status(400).send(`Spotify 認証に失敗しました: ${err.message}`);
    }
  });

  authServer = authApp.listen(authPort, "127.0.0.1", () => {
    console.log(`auth: http://127.0.0.1:${authPort}/auth/login（認証が完了すると閉じます）`);
  });
  authServer.on("error", (err) => {
    console.error(`認証用ポート ${authPort} を開けませんでした: ${err.message}`);
    authServer = null;
  });
}

function stopAuthServer() {
  if (!authServer) return;
  const closing = authServer;
  authServer = null;
  closing.close(() => console.log("auth: 認証用ポートを閉じました"));
  closing.closeAllConnections?.();
}

startAuthServer();
poll();

// ---- 再生コントロール ----

// Spotify が起動していない時に AppleScript で勝手に起動してしまわないよう、稼働中のときだけ実行する
const guarded = (command) =>
  `if application "Spotify" is running then
  tell application "Spotify" to ${command}
  return "ok"
end if
return "not_running"`;

const LOCAL_CONTROLS = {
  playpause: () => guarded("playpause"),
  next: () => guarded("next track"),
  previous: () => guarded("previous track"),
  volume: (v) => guarded(`set sound volume to ${v}`),
  shuffle: (v) => guarded(`set shuffling to ${v}`),
  repeat: (v) => guarded(`set repeating to ${v !== "off"}`),
};

function sanitizeControl(action, value) {
  switch (action) {
    case "playpause":
    case "next":
    case "previous":
      return { action, value: null };
    case "volume": {
      const n = Math.round(Number(value));
      return Number.isFinite(n)
        ? { action, value: Math.min(100, Math.max(0, n)) }
        : null;
    }
    case "shuffle":
      return typeof value === "boolean" ? { action, value } : null;
    case "repeat":
      return ["off", "context", "track"].includes(value) ? { action, value } : null;
    default:
      return null;
  }
}

function describeControlError(err) {
  switch (err?.reason) {
    case "PREMIUM_REQUIRED":
      return "再生操作には Spotify Premium が必要です";
    case "VOLUME_CONTROL_DISALLOW":
      return "この端末は音量の遠隔操作に対応していません";
    case "NO_ACTIVE_DEVICE":
      return "再生中の端末がありません";
    default:
      return err?.status ? `操作に失敗しました (${err.status})` : "操作に失敗しました";
  }
}

// 戻り値: { ok: true } または { ok: false, message }
async function handleControl(message) {
  const cmd = sanitizeControl(message?.action, message?.value);
  if (!cmd) return { ok: false, message: "不正な操作です" };

  let apiError = null;
  if (spotifyApi.isAuthorized() && lastData?.source !== "local") {
    try {
      const apiAction =
        cmd.action === "playpause"
          ? lastData?.state === "playing"
            ? "pause"
            : "play"
          : cmd.action;
      await spotifyApi.control(apiAction, cmd.value);
      return { ok: true };
    } catch (err) {
      apiError = err;
      logOnce(`Spotify API control (${cmd.action}): ${err.status || ""} ${err.reason || err.message}`);
    }
  }

  // Spotify 側が明示的に拒否した場合（Premium 未加入・端末非対応など）は、
  // 再生中の端末が Mac 自身のときだけ AppleScript に切り替える。別端末で再生中なら成功扱いにしない
  const rejectedByApi = !!apiError?.status;
  const playingOnThisMac = lastData?.source === "local" || lastData?.deviceType === "Computer";
  if (!rejectedByApi || playingOnThisMac) {
    try {
      const result = await runOsascript(LOCAL_CONTROLS[cmd.action](cmd.value));
      if (result === "ok") return { ok: true };
    } catch (err) {
      console.error(`Spotify control error (${cmd.action}):`, err.message);
    }
  }

  return {
    ok: false,
    message: apiError ? describeControlError(apiError) : "Spotify が起動していません",
  };
}

// ---- 歌詞（メイン: LRCLIB の同期歌詞 / サブ: Genius） ----

const lyricsCache = new Map();
const LYRICS_NEGATIVE_TTL_MS = 5 * 60 * 1000;

function cacheLyrics(key, value) {
  lyricsCache.set(key, { value, at: Date.now() });
  if (lyricsCache.size > 100) lyricsCache.delete(lyricsCache.keys().next().value);
}

app.get("/api/lyrics", async (req, res) => {
  const track = String(req.query.track || "");
  const artist = String(req.query.artist || "");
  const album = String(req.query.album || "");
  const duration = Number(req.query.duration) || 0;

  if (!track || !artist) {
    return res.status(400).json({ error: "track と artist は必須です" });
  }

  const key = `${artist} ${track} ${Math.round(duration)}`;
  const cached = lyricsCache.get(key);
  if (cached && (cached.value || Date.now() - cached.at < LYRICS_NEGATIVE_TTL_MS)) {
    return cached.value
      ? res.json(cached.value)
      : res.status(404).json({ error: "歌詞が見つかりませんでした" });
  }

  let result = null;
  try {
    result = await lyricsLrclib.findLrclib({ track, artist, album, duration });
  } catch (error) {
    console.error("LRCLIB error:", error.message);
  }

  if (!result && process.env.GENIUS_ACCESS_TOKEN) {
    try {
      const genius = await fetchLyricsFromGenius(track, artist);
      result = { ...genius, synced: null, source: "genius" };
    } catch (error) {
      console.error("Genius lyrics error:", error.message);
    }
  }

  cacheLyrics(key, result);
  if (!result) return res.status(404).json({ error: "歌詞が見つかりませんでした" });
  res.json(result);
});

// クライアントが「どの機能が使えるか」を知るための設定（キー自体は返さない）
app.get("/api/config", (req, res) => {
  res.json({
    lastfm: lastfm.isConfigured(),
    gemini: geminiReview.isConfigured(),
    genius: !!process.env.GENIUS_ACCESS_TOKEN,
  });
});

// Last.fm への中継（API キーとユーザー名はサーバーが付ける）
app.get("/api/lastfm", async (req, res) => {
  try {
    res.json(await lastfm.call(req.query));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.post("/api/review", express.json({ limit: "10kb" }), async (req, res) => {
  try {
    res.json({ text: await geminiReview.review(req.body) });
  } catch (error) {
    console.error("Review error:", error.message);
    res.status(error.message.includes("未設定") ? 503 : 502).json({ error: error.message });
  }
});

app.get("/api/features", async (req, res) => {
  try {
    const features = await getFeatures(String(req.query.id || ""));
    if (!features) return res.status(404).json({ error: "not found" });
    res.json(features);
  } catch (error) {
    console.error("Features error:", error.message);
    res.status(502).json({ error: "audio features の取得に失敗しました" });
  }
});


wss.on("connection", (ws) => {
  console.log("WebSocket connection established");
  updateCaffeinate();

  // 新規接続には必ず最新状態を送る（重複排除キャッシュをリセットして即時ポーリング）
  lastPayload = null;
  pollSoon();

  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message?.type !== "control") return;

    const result = await handleControl(message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "control-result", action: message.action, ...result }));
    }
    // API の再生状態は反映まで少し遅れるため、少し待ってから取り直す
    setTimeout(pollSoon, 600);
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed");
    setTimeout(updateCaffeinate, 0);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

function normalizeName(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function pickGeniusHit(hits, track, artist) {
  const wantArtist = normalizeName(lyricsLrclib.firstArtist(artist));
  const wantTrack = normalizeName(lyricsLrclib.cleanTitle(track));
  if (!wantArtist) return null;

  const sameArtist = hits.filter((hit) => {
    const name = normalizeName(hit.result?.primary_artist?.name || hit.result?.artist_names);
    return name && (name.includes(wantArtist) || wantArtist.includes(name));
  });

  return (
    sameArtist.find((hit) => {
      const title = normalizeName(hit.result?.title);
      return title && (title.includes(wantTrack) || wantTrack.includes(title));
    }) ||
    sameArtist[0] ||
    null
  );
}

async function fetchLyricsFromGenius(track, artist) {
  const headers = { Authorization: `Bearer ${process.env.GENIUS_ACCESS_TOKEN}` };
  const query = encodeURIComponent(`${lyricsLrclib.cleanTitle(track) || track} ${lyricsLrclib.firstArtist(artist)}`);

  const searchResponse = await fetch(`https://api.genius.com/search?q=${query}`, { headers });
  if (!searchResponse.ok) {
    throw new Error(`Genius検索に失敗しました (HTTP ${searchResponse.status})`);
  }

  const hits = (await searchResponse.json())?.response?.hits || [];
  const hit = pickGeniusHit(hits, track, artist);
  const songId = hit?.result?.id;
  if (!songId) throw new Error("Geniusで該当する曲が見つかりませんでした");

  const sourceUrl = `https://genius.com/songs/${songId}`;

  const songResponse = await fetch(`https://api.genius.com/songs/${songId}?text_format=plain`, { headers });
  if (songResponse.ok) {
    const plain = (await songResponse.json())?.response?.song?.lyrics?.lyrics?.body?.plain;
    if (plain) return { lyrics: plain, sourceUrl };
  }

  const pageResponse = await fetch(sourceUrl);
  if (!pageResponse.ok) {
    throw new Error(`Genius歌詞ページ取得に失敗しました (HTTP ${pageResponse.status})`);
  }
  const scraped = extractLyricsFromHtml(await pageResponse.text());
  if (!scraped) throw new Error("歌詞の取得に失敗しました");

  return { lyrics: scraped, sourceUrl };
}


function extractLyricsFromHtml(html) {
  if (!html) return "";

  // 新しいGeniusの歌詞コンテナを検出
  const containerRegex = /<div[^>]+data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi;
  const matches = [...html.matchAll(containerRegex)];

  let combined = matches.map(match => match[1]).join("\n");

  // 古い形式の歌詞コンテナも検出
  if (!combined) {
    const legacyMatch = html.match(/<div class="lyrics">([\s\S]*?)<\/div>/i);
    if (legacyMatch) {
      combined = legacyMatch[1];
    }
  }

  // JavaScript埋め込みの歌詞データを抽出
  if (!combined) {
    const jsLyricsMatch = html.match(/"lyrics_state":"synced","lyrics":\s*"([^"]+)"/);
    if (jsLyricsMatch) {
      combined = jsLyricsMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  }

  if (!combined) return "";

  let text = decodeHtmlEntities(
    combined
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/?p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );

  // メタ情報（[Chorus] などのセクション名や不要なフッター）を除去
  const lines = text.split("\n");
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // 空行は一旦残す

    // [Intro], [Chorus], [Verse 1] のような行を除去
    if (/^\[[^\]]+\]$/.test(trimmed)) return false;

    // Genius 固有のメタ情報行を除去
    if (/Contributors/i.test(trimmed)) return false;
    if (/Translations?/i.test(trimmed)) return false;
    if (/Romanization/i.test(trimmed)) return false;
    if (/You might also like/i.test(trimmed)) return false;
    if (/Embed$/i.test(trimmed)) return false;
    // タイトル行っぽい「◯◯ Lyrics」を除去
    if (/Lyrics$/i.test(trimmed)) return false;

    return true;
  });

  text = cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

function decodeHtmlEntities(text) {
  if (!text) return "";
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCharCode(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCharCode(parseInt(entity.slice(1), 10));
    }

    const entities = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'"
    };

    return entities[entity] || match;
  });
}

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const [rawKey, ...rawValueParts] = trimmed.split("=");
    const key = rawKey.trim();
    const value = rawValueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}
