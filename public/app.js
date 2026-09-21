"use strict";

const $ = (id) => document.getElementById(id);

const trackEl = $("track");
const artistEl = $("artist");
const albumEl = $("album");
const bar = $("bar");
const art = $("art");
const clockEl = $("clock");
const dateEl = $("date");
const timeDisplay = $("time-display");
const progressTime = $("progress-time");
const fullscreenBtn = $("fullscreen-btn");
const themeToggleBtn = $("theme-toggle-btn");
const prevBtn = $("prev-btn");
const playPauseBtn = $("play-pause-btn");
const nextBtn = $("next-btn");
const repeatBtn = $("repeat-btn");
const shuffleBtn = $("shuffle-btn");
const volumeSlider = $("volume-slider");
const volumeBox = document.querySelector(".volume");
const playIcon = $("play-icon");
const pauseIcon = $("pause-icon");
const lyricsEl = $("lyrics-content");
const adsEl = $("ads-display");
const evaluationEl = $("music-evaluation-content");
const loadingOverlay = $("loading-overlay");
const sourceBadge = $("source-badge");
const connectLink = $("connect-link");


const CONTROL_SYNC_GUARD_MS = 2500;

// 使える機能はサーバーの設定次第（キーはサーバーが持ち、ブラウザには渡さない）
let config = { lastfm: false, gemini: false, genius: false };
const configReady = fetch("/api/config")
  .then((res) => res.json())
  .then((value) => {
    config = value;
    $("recent-tracks").hidden = !config.lastfm;
    $("music-evaluation").hidden = !config.gemini;
  })
  .catch(() => {});

const state = {
  playing: false,
  position: 0,
  duration: 0,
  stamp: 0,
  trackKey: null,
  trackId: null,
  artwork: null,
  source: null,
  repeat: "off",
  lastControl: 0,
  pendingPlay: null,
  server: null,
  serverStamp: 0,
};

const lyricSync = { times: [], nodes: [], active: -1 };

function safeStorage(action, key, value) {
  try {
    return action === "get" ? localStorage.getItem(key) : localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

// ---------- 時計（分が変わる瞬間だけ更新） ----------
function updateClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  dateEl.textContent = now.toLocaleDateString("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  setTimeout(updateClock, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
}
updateClock();

// ---------- ローディング ----------
let loadingHidden = false;
function hideLoading() {
  if (loadingHidden) return;
  loadingHidden = true;
  loadingOverlay.classList.add("loading-overlay-hide");
  setTimeout(() => {
    loadingOverlay.hidden = true;
  }, 500);
}
setTimeout(hideLoading, 2500);

// ---------- テーマ ----------
function applyTheme(theme) {
  document.body.classList.toggle("theme-day", theme === "day");
  document.body.classList.toggle("theme-night", theme !== "day");
  applyAccent();
}
themeToggleBtn.addEventListener("click", () => {
  const next = document.body.classList.contains("theme-day") ? "night" : "day";
  safeStorage("set", "theme", next);
  applyTheme(next);
});

// ---------- アクセントカラー（ジャケット画像から抽出） ----------
const accent = { h: 340, s: 0.8 };

function applyAccent() {
  const night = document.body.classList.contains("theme-night");
  const l = night ? 64 : 50;
  const s = Math.round(accent.s * 100);
  document.body.style.setProperty("--accent", `hsl(${accent.h} ${s}% ${l}%)`);
  document.body.style.setProperty("--accent-2", `hsl(${(accent.h + 38) % 360} ${s}% ${l + 10}%)`);
}

function hashAccent(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  accent.h = Math.abs(hash) % 360;
  accent.s = 0.75;
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function sampleAccent(url, key) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (state.artwork !== url) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 24;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 24, 24);
      const px = ctx.getImageData(0, 0, 24, 24).data;

      let best = null;
      let bestScore = 0;
      for (let i = 0; i < px.length; i += 4) {
        const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
        if (l < 0.12 || l > 0.92) continue;
        const score = s * (1 - Math.abs(l - 0.55));
        if (score > bestScore) {
          bestScore = score;
          best = { h, s };
        }
      }

      if (best && best.s > 0.2) {
        accent.h = Math.round(best.h);
        accent.s = Math.min(0.95, Math.max(0.6, best.s));
      } else {
        hashAccent(key);
      }
    } catch {
      hashAccent(key);
    }
    applyAccent();
  };
  img.onerror = () => {
    if (state.artwork !== url) return;
    hashAccent(key);
    applyAccent();
  };
  img.src = url;
}

// ---------- WebSocket（自動再接続つき） ----------
let ws;
let retry = 0;

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.addEventListener("open", () => {
    retry = 0;
    document.body.classList.add("is-live");
  });
  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "control-result") onControlResult(data);
      else render(data);
    } catch (err) {
      console.error("render error:", err);
    }
  });
  ws.addEventListener("close", () => {
    document.body.classList.remove("is-live");
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
  });
  ws.addEventListener("error", () => ws.close());
}
connect();

const toastEl = $("toast");
let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3500);
}

// 操作に失敗したら、通知して表示をサーバー側の実際の状態に戻す
function onControlResult(result) {
  if (result.ok) return;
  toast(result.message || "操作に失敗しました");

  state.lastControl = 0;
  state.pendingPlay = null;
  const d = state.server;
  if (!d || d.state === "stopped") return;

  state.position = d.position;
  state.duration = d.duration;
  state.stamp = state.serverStamp;
  setPlaying(d.state === "playing");
  if (Number.isFinite(d.volume)) {
    volumeSlider.value = d.volume;
    setVolumeFill();
  }
  if (typeof d.shuffle === "boolean") setShuffleUI(d.shuffle);
  if (d.repeat) setRepeatUI(d.repeat);
  renderProgress();
}

function control(action, value) {
  state.lastControl = Date.now();
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "control", action, value }));
  } else {
    onControlResult({ ok: false, message: "サーバーに接続できていません" });
  }
}

// ---------- 描画 ----------
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function currentPosition() {
  const elapsed = state.playing ? (performance.now() - state.stamp) / 1000 : 0;
  const position = state.position + elapsed;
  return state.duration > 0 ? Math.min(position, state.duration) : position;
}

function renderProgress() {
  if (state.duration <= 0) {
    bar.style.transform = "scaleX(0)";
    return;
  }
  const position = currentPosition();
  bar.style.transform = `scaleX(${position / state.duration})`;
  timeDisplay.textContent = formatTime(position);
  syncLyrics(position);
}

// サーバー更新は 1〜2 秒間隔なので、進捗はクライアント側で補間する
setInterval(() => {
  if (!document.hidden && state.playing) renderProgress();
}, 250);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderProgress();
});

function setPlaying(playing) {
  state.playing = playing;
  document.body.classList.toggle("is-playing", playing);
  // SVG 要素には .hidden プロパティが無いため、属性を直接切り替える
  playIcon.toggleAttribute("hidden", playing);
  pauseIcon.toggleAttribute("hidden", !playing);
}

function setVolumeFill() {
  volumeSlider.style.setProperty("--vol", `${volumeSlider.value}%`);
}

function setShuffleUI(on) {
  shuffleBtn.classList.toggle("is-active", on);
  shuffleBtn.title = on ? "シャッフル: オン" : "シャッフル: オフ";
}

const REPEAT_TITLES = { off: "ループしない", context: "全曲ループ", track: "1曲ループ" };
function setRepeatUI(mode) {
  state.repeat = mode;
  repeatBtn.dataset.mode = mode;
  repeatBtn.classList.toggle("is-active", mode !== "off");
  repeatBtn.title = REPEAT_TITLES[mode] || REPEAT_TITLES.off;
}

function showIdle() {
  state.trackKey = null;
  state.trackId = null;
  state.artwork = null;
  showFeatures(null);
  state.duration = 0;
  setPlaying(false);
  trackEl.textContent = "何も再生していません";
  artistEl.textContent = "Spotify で曲を再生するとここに表示されます";
  albumEl.textContent = "";
  art.hidden = true;
  timeDisplay.textContent = "0:00";
  progressTime.textContent = "0:00";
  renderProgress();
  document.title = "nowplaying";
}

function render(data) {
  if (!loadingHidden) hideLoading();
  state.server = data;
  state.serverStamp = performance.now();

  if (data.state === "stopped") {
    showIdle();
    return;
  }

  const trackKey = `${data.track} ${data.artist}`;
  const trackChanged = trackKey !== state.trackKey;

  if (trackChanged) {
    state.trackKey = trackKey;
    state.trackId = data.id || null;
    showFeatures(null);
    trackEl.textContent = data.track;
    artistEl.textContent = data.artist;
    albumEl.textContent = data.album || "";
    document.title = `nowplaying - ${data.track} / ${data.artist}`;
  }

  if (data.artwork !== state.artwork) {
    state.artwork = data.artwork;
    if (data.artwork) {
      art.src = data.artwork;
      art.alt = data.album || data.track;
      art.hidden = false;
      sampleAccent(data.artwork, trackKey);
    } else {
      art.hidden = true;
      hashAccent(trackKey);
      applyAccent();
    }
  } else if (trackChanged && !data.artwork) {
    hashAccent(trackKey);
    applyAccent();
  }

  state.source = data.source;
  state.position = data.position;
  state.duration = data.duration;
  state.stamp = performance.now();
  progressTime.textContent = formatTime(data.duration);
  // 再生/停止を押した直後は API の反映遅れで古い状態が返るため、少しの間は押した結果を表示し続ける
  const pending = state.pendingPlay;
  if (pending && Date.now() < pending.until) {
    if ((data.state === "playing") === pending.playing) state.pendingPlay = null;
  } else {
    state.pendingPlay = null;
  }
  setPlaying(state.pendingPlay ? state.pendingPlay.playing : data.state === "playing");
  renderProgress();

  const badge =
    data.source === "api" ? "Spotify API" : data.source === "local" ? "Local" : "";
  if (sourceBadge.textContent !== badge) {
    sourceBadge.textContent = badge;
    sourceBadge.hidden = !badge;
  }

  // 操作直後はサーバー側の反映待ちで古い値が返るため、UI への同期を少し止める
  if (Date.now() - state.lastControl > CONTROL_SYNC_GUARD_MS) {
    if (Number.isFinite(data.volume)) {
      volumeSlider.value = data.volume;
      setVolumeFill();
    }
    if (typeof data.shuffle === "boolean") setShuffleUI(data.shuffle);
    if (data.repeat) setRepeatUI(data.repeat);
  }

  // スマホ等は音量の遠隔操作ができないので、スライダーを隠す
  volumeBox.hidden = data.deviceType === "Smartphone";

  adsEl.hidden = !data.isAd;
  lyricsEl.hidden = !!data.isAd;

  if (trackChanged && !data.isAd) loadTrackExtras(data, trackKey);
}

// ---------- 操作 ----------
prevBtn.addEventListener("click", () => control("previous"));
nextBtn.addEventListener("click", () => control("next"));
playPauseBtn.addEventListener("click", () => {
  const now = performance.now();
  if (state.playing) {
    state.position = Math.min(state.position + (now - state.stamp) / 1000, state.duration);
  }
  state.stamp = now;
  const playing = !state.playing;
  state.pendingPlay = { playing, until: Date.now() + 3000 };
  setPlaying(playing);
  renderProgress();
  control("playpause");
});

shuffleBtn.addEventListener("click", () => {
  const on = !shuffleBtn.classList.contains("is-active");
  setShuffleUI(on);
  control("shuffle", on);
});

repeatBtn.addEventListener("click", () => {
  // AppleScript 経由では「1曲ループ」を設定できないため 2 段階で切り替える
  const modes = state.source === "local" ? ["off", "context"] : ["off", "context", "track"];
  const next = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
  setRepeatUI(next);
  control("repeat", next);
});

let volumeTimer = null;
volumeSlider.addEventListener("input", () => {
  state.lastControl = Date.now();
  setVolumeFill();
  if (volumeTimer) return;
  volumeTimer = setTimeout(() => {
    volumeTimer = null;
    control("volume", Number(volumeSlider.value));
  }, 120);
});
setVolumeFill();

const isStandalone =
  matchMedia("(display-mode: fullscreen)").matches ||
  matchMedia("(display-mode: standalone)").matches ||
  navigator.standalone === true;

if (!document.documentElement.requestFullscreen || isStandalone) fullscreenBtn.hidden = true;

// スマホ(タッチ端末)では最初のタップで全画面にする（ブラウザは操作起点でしか許可しない）
if (!isStandalone && document.documentElement.requestFullscreen && matchMedia("(pointer: coarse)").matches) {
  document.addEventListener(
    "pointerup",
    () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
      }
    },
    { once: true }
  );
}
fullscreenBtn.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.error(`Error attempting to enable full-screen mode: ${err.message}`);
    });
  } else {
    document.exitFullscreen();
  }
});
document.addEventListener("fullscreenchange", () => {
  fullscreenBtn.classList.toggle("is-active", !!document.fullscreenElement);
});

// ---------- 歌詞（再生位置に同期）/ BPM・キー / Gemini レビュー ----------
const lyricsCache = new Map();
const reviewCache = new Map();
const featuresCache = new Map();
let extrasTimer = null;
let extrasToken = 0;

const LYRIC_LEAD_SEC = 0.3;
const USER_SCROLL_PAUSE_MS = 4000;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const lyricsScroller = lyricsEl.parentElement;
const lyricsSourceTag = $("lyrics-source");
let userScrollUntil = 0;

// 手動スクロール中は自動追従を止める
["wheel", "touchmove"].forEach((type) =>
  lyricsScroller.addEventListener(
    type,
    () => {
      userScrollUntil = Date.now() + USER_SCROLL_PAUSE_MS;
    },
    { passive: true }
  )
);

function remember(cache, key, value) {
  cache.set(key, value);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function resetLyricSync() {
  lyricSync.times = [];
  lyricSync.nodes = [];
  lyricSync.active = -1;
}

function setLyricsSource(data) {
  if (!data) {
    lyricsSourceTag.hidden = true;
    return;
  }
  lyricsSourceTag.textContent = data.synced
    ? "SYNCED · LRCLIB"
    : data.source === "genius"
      ? "GENIUS"
      : "LRCLIB";
  lyricsSourceTag.hidden = false;
}

function syncLyrics(position, instant = false) {
  const { times, nodes } = lyricSync;
  if (!times.length) return;

  const target = position + LYRIC_LEAD_SEC;
  let lo = 0;
  let hi = times.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx === lyricSync.active) return;

  nodes[lyricSync.active]?.classList.remove("is-active");
  lyricSync.active = idx;
  if (idx < 0) return;

  nodes[idx].classList.add("is-active");
  if (Date.now() < userScrollUntil) return;
  scrollToActiveLyric(instant);
}

function scrollToActiveLyric(instant = false) {
  const node = lyricSync.nodes[lyricSync.active];
  if (!node) return;
  const top = node.offsetTop - lyricsScroller.clientHeight * 0.38 + node.offsetHeight / 2;
  lyricsScroller.scrollTo({
    top: Math.max(0, top),
    behavior: instant || reducedMotion ? "auto" : "smooth",
  });
}

// 画面サイズ変更（回転など）後も現在の行を中央に保つ
window.addEventListener("resize", () => scrollToActiveLyric(true));

function showLyricsNote(message, withHint = false) {
  resetLyricSync();
  setLyricsSource(null);
  const note = el("div", "lyrics-note", message);
  if (withHint) note.append(el("small", "", "LRCLIB / Genius から歌詞を取得しています"));
  lyricsEl.replaceChildren(note);
}

function showLyrics(data) {
  if (data.instrumental) {
    showLyricsNote("インストゥルメンタル曲です");
    return;
  }

  resetLyricSync();
  setLyricsSource(data);
  lyricsScroller.scrollTop = 0;

  if (data.synced?.length) {
    const box = el("div", "lyrics-text synced");
    for (const line of data.synced) {
      const node = el("div", "lyric-line", line.text);
      box.append(node);
      lyricSync.times.push(line.t);
      lyricSync.nodes.push(node);
    }
    lyricsEl.replaceChildren(box);
    syncLyrics(currentPosition(), true);
  } else {
    lyricsEl.replaceChildren(el("div", "lyrics-text", data.lyrics));
  }
}

function showReview(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^[\s*#\-]*(Genre|Mood)[\s*]*[:：][\s*]*(.+?)[\s*]*$/i);
    if (m) rows.push([m[1], m[2]]);
  }

  if (!rows.length) {
    evaluationEl.replaceChildren(el("p", "review-plain", text));
    return;
  }

  evaluationEl.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = el("div", "review-row");
      row.append(
        el("span", "review-label", label),
        el("span", "review-value", value)
      );
      return row;
    })
  );
}

function showFeatures(features) {
  const chips = $("meta-chips");
  const bpm = $("chip-bpm");
  const key = $("chip-key");

  bpm.hidden = !features?.bpm;
  if (features?.bpm) bpm.textContent = `${features.bpm} BPM`;

  key.hidden = !features?.key;
  if (features?.key) {
    $("chip-key-text").textContent = `${features.camelot} · ${features.key}`;
    const wheel = parseInt(features.camelot, 10);
    key.style.setProperty("--wheel", `hsl(${(wheel - 1) * 30} 75% 60%)`);
  }

  chips.hidden = bpm.hidden && key.hidden;
}

async function loadFeatures(id) {
  if (!id) return null;
  if (featuresCache.has(id)) {
    const cached = featuresCache.get(id);
    if (state.trackId === id) showFeatures(cached);
    return cached;
  }
  try {
    const res = await fetch(`/api/features?id=${encodeURIComponent(id)}`);
    const features = res.ok ? await res.json() : null;
    remember(featuresCache, id, features);
    if (state.trackId === id) showFeatures(features);
    return features;
  } catch (err) {
    console.error("features error:", err);
    return null;
  }
}

// Last.fm のユーザー投稿タグ（ジャンルの根拠）。ジャンルと関係ないタグは除く
const tagsCache = new Map();
// ジャンルではないタグ（好み・評価・国籍/言語・年代・気分・性別ボーカルなど）を除外する
const JUNK_TAG = new RegExp(
  [
    "seen live", "favou?rite", "owned", "^my ", "love", "awesome", "beautiful", "spotify",
    "^\\d+s?$", "vocalists?", "^(good|best|great|cool|nice)",
    "^(japan(ese)?|korean?|english|american|british|swedish|german|french|chinese|jp|kr|usa|uk)$",
    "^(chill|happy|sad|energetic|relax(ing)?|mellow|epic|melancholy|summer|night|dance)$",
    "female|male|singer|songwriter|cover|remix|ost|soundtrack|playlist|guilty pleasure",
  ].join("|"),
  "i"
);

function primaryArtist(artist) {
  return artist.split(/\s*(?:,|、|&|×|\bfeat\.?|\bft\.?)\s*/i)[0].trim();
}

async function lastfmCall(method, params) {
  const res = await fetch(`/api/lastfm?${new URLSearchParams({ method, ...params })}`);
  return res.ok ? res.json() : {};
}

const usableTags = (tags) =>
  tags
    .filter((t) => Number(t.count) >= 15 && !JUNK_TAG.test(t.name))
    .slice(0, 5)
    .map((t) => t.name);

const MIN_KNOWN_PLAYCOUNT = 500;

// 同名の別アーティスト（例: Kai=EXO の Kai）のタグが混ざっていないかの簡易チェック。
// 曲が日本語(かな)なのに K-POP 系のタグが付いている、またはその逆なら、混入とみなしてタグを使わない
function looksLikeNameCollision(text, artistTags) {
  const names = artistTags.filter((t) => Number(t.count) >= 15).map((t) => t.name);
  const has = (re) => names.some((n) => re.test(n));
  const kana = /[\u3040-\u30ff]/.test(text);
  const hangul = /[\uac00-\ud7af]/.test(text);
  return (
    (kana && has(/k-?pop|korean|hallyu/i)) ||
    (hangul && has(/j-?pop|j-?rock|japan|anime|vocaloid|visual kei/i))
  );
}

async function fetchTags(track, artist) {
  await configReady;
  if (!config.lastfm) return [];
  const key = `${artist}\u0000${track}`;
  if (tagsCache.has(key)) return tagsCache.get(key);

  const main = primaryArtist(artist);
  let names = [];
  try {
    const trackTags = await lastfmCall("track.getTopTags", { artist: main, track });
    names = usableTags(trackTags?.toptags?.tag || []);

    // 曲単位のタグが無い曲（日本の曲に多い）は、アーティスト単位のタグで補う。
    // ただし同名の別人を拾わないよう、その曲がそのアーティスト名で実際に再生されている場合だけ使う
    if (names.length < 2) {
      const info = await lastfmCall("track.getInfo", { artist: main, track });
      const known = Number(info?.track?.playcount) >= MIN_KNOWN_PLAYCOUNT;
      const canonical = info?.track?.artist?.name;
      if (known && canonical) {
        const artistTags = await lastfmCall("artist.getTopTags", { artist: canonical });
        const all = artistTags?.toptags?.tag || [];
        names = looksLikeNameCollision(track + artist, all) ? [] : usableTags(all);
      }
    }
  } catch (err) {
    console.error("Last.fm tags error:", err);
  }

  remember(tagsCache, key, names);
  return names;
}

async function fetchLyrics(info, key, token) {
  try {
    const params = new URLSearchParams({
      track: info.track,
      artist: info.artist,
      album: info.album || "",
      duration: String(Math.round(info.duration || 0)),
    });
    const res = await fetch(`/api/lyrics?${params}`);
    if (token !== extrasToken) return;

    if (!res.ok) {
      showLyricsNote(
        res.status === 404 ? "歌詞が見つかりませんでした" : `歌詞を取得できませんでした (${res.status})`,
        true
      );
      return;
    }

    const data = await res.json();
    if (token !== extrasToken) return;

    if (data.lyrics || data.instrumental) {
      remember(lyricsCache, key, data);
      showLyrics(data);
    } else {
      showLyricsNote("歌詞が見つかりませんでした", true);
    }
  } catch (err) {
    console.error("歌詞取得エラー:", err);
    if (token === extrasToken) showLyricsNote("歌詞を取得できませんでした", true);
  }
}

async function fetchReview(info, key, token, featuresPromise) {
  await configReady;
  if (!config.gemini) return;
  try {
    const [features, tags] = await Promise.all([featuresPromise, fetchTags(info.track, info.artist)]);
    if (token !== extrasToken) return;

    // 根拠となるデータが無い曲は、想像で書かせず「評価できない」と正直に出す
    if (!features && !tags.length) {
      evaluationEl.replaceChildren(
        el("p", "review-plain", "曲のデータが見つからなかったため、評価は作れませんでした。")
      );
      return;
    }

    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track: info.track, artist: info.artist, facts: { features, tags } }),
    });
    if (!res.ok) throw new Error(`review API error: ${res.status}`);
    const { text } = await res.json();
    if (token !== extrasToken) return;
    remember(reviewCache, key, text);
    showReview(text);
  } catch (err) {
    console.error("Gemini evaluation error:", err);
    if (token === extrasToken) {
      evaluationEl.replaceChildren(el("p", "review-plain", "評価を取得できませんでした。"));
    }
  }
}

// 曲送りの連打で API を叩きすぎないようデバウンス。取得済みの曲はキャッシュを使う
function loadTrackExtras(info, key) {
  const token = ++extrasToken;
  clearTimeout(extrasTimer);

  const cachedLyrics = lyricsCache.get(key);
  const cachedReview = reviewCache.get(key);
  if (cachedLyrics) showLyrics(cachedLyrics);
  else showLyricsNote("歌詞をよみこみ中…");
  if (cachedReview) showReview(cachedReview);
  else evaluationEl.replaceChildren(el("p", "review-plain", "Gemini で曲を評価中…"));

  extrasTimer = setTimeout(() => {
    const featuresPromise = loadFeatures(info.id);
    if (!cachedLyrics) fetchLyrics(info, key, token);
    if (!cachedReview) fetchReview(info, key, token, featuresPromise);
  }, 500);
}

// ---------- Last.fm 最近のトラック ----------
function displayRecentTracks(tracks) {
  const container = $("recent-tracks-list");
  const marquee = el("div", "recent-marquee");
  marquee.append(
    ...tracks.slice(0, 5).map((track) => {
      const card = el("div", "recent-track");
      if (track["@attr"]?.nowplaying === "true") card.classList.add("is-now");

      const artUrl = track.image?.[2]?.["#text"];
      let cover;
      if (artUrl) {
        cover = el("img", "recent-track-art");
        cover.src = artUrl;
        cover.alt = "";
        cover.loading = "lazy";
        cover.decoding = "async";
      } else {
        cover = el("div", "recent-track-art");
      }

      const info = el("div", "recent-track-info");
      info.append(
        el("div", "recent-track-title", track.name),
        el("div", "recent-track-artist", track.artist?.["#text"] || "")
      );
      card.append(cover, info);
      return card;
    })
  );
  container.replaceChildren(marquee);
  layoutMarquee();
}

// 履歴の帯がはみ出すときだけ、複製して右から左へ切れ目なく自動スクロールさせる
function layoutMarquee() {
  const list = $("recent-tracks-list");
  const marquee = list.firstElementChild;
  if (!marquee) return;

  marquee.querySelectorAll("[data-clone]").forEach((node) => node.remove());
  list.classList.remove("is-marquee");
  if (getComputedStyle(marquee).display !== "flex") return;

  const gap = parseFloat(getComputedStyle(marquee).columnGap) || 0;
  const shift = marquee.scrollWidth + gap;
  if (marquee.scrollWidth <= list.clientWidth) return;

  for (const card of [...marquee.children]) {
    const clone = card.cloneNode(true);
    clone.dataset.clone = "1";
    clone.setAttribute("aria-hidden", "true");
    marquee.append(clone);
  }
  list.style.setProperty("--marquee-shift", `${shift}px`);
  list.style.setProperty("--marquee-dur", `${Math.max(14, shift / 28)}s`);
  list.classList.add("is-marquee");
}

let marqueeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(marqueeTimer);
  marqueeTimer = setTimeout(layoutMarquee, 150);
});

let recentFetchedAt = 0;

async function fetchRecentTracks() {
  recentFetchedAt = Date.now();
  if (!config.lastfm) return;
  try {
    const data = await lastfmCall("user.getrecenttracks", { limit: 5 });
    if (data.recenttracks?.track) displayRecentTracks(data.recenttracks.track);
  } catch (error) {
    console.error("Last.fm APIエラー:", error);
  }
}
configReady.then(() => {
  fetchRecentTracks();
  fetchStats();
});
setInterval(() => {
  if (!document.hidden) fetchRecentTracks();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - recentFetchedAt > 60000) fetchRecentTracks();
});

// ---------- Last.fm 再生数（今日 / 直近7日(今日を含む) / 今月） ----------
let statsFetchedAt = 0;

function periodStarts() {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  week.setDate(day.getDate() - 6);
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  return { day, week, month };
}

async function countScrobblesSince(date) {
  const data = await lastfmCall("user.getrecenttracks", {
    limit: 1,
    from: Math.floor(date.getTime() / 1000),
  });
  const total = Number(data.recenttracks?.["@attr"]?.total);
  return Number.isFinite(total) ? total : null;
}

async function fetchStats() {
  if (!config.lastfm) return;
  statsFetchedAt = Date.now();
  const { day, week, month } = periodStarts();
  try {
    const [d, w, m] = await Promise.all([day, week, month].map(countScrobblesSince));
    for (const [id, value] of [["stat-day", d], ["stat-week", w], ["stat-month", m]]) {
      $(id).textContent = value === null ? "–" : value.toLocaleString("ja-JP");
    }
  } catch (error) {
    console.error("Last.fm 集計エラー:", error);
  }
}
setInterval(() => {
  if (!document.hidden) fetchStats();
}, 120000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - statsFetchedAt > 120000) fetchStats();
});

// ---------- 画面を暗くしない / スリープさせない ----------
// Screen Wake Lock API（HTTPS・localhost のみ）を使い、使えない環境（LAN の http など）では
// NoSleep.js が見えない動画を再生する方法に自動で切り替える。動画は最初の操作が無いと再生できない
// ?awake=off を付けると、画面を点けたままにする機能を使わない
const awakeOff = new URLSearchParams(location.search).get("awake") === "off";
const noSleep = !awakeOff && typeof NoSleep === "function" ? new NoSleep() : null;

// NoSleep の動画は既定で音声つきの扱いのため、その端末で音楽を流していると再生が止まってしまう
// （音声フォーカスを奪う）。ミュートにして、音声として扱われないようにする
if (noSleep?.noSleepVideo) {
  const video = noSleep.noSleepVideo;
  video.muted = true;
  video.defaultMuted = true;
  video.volume = 0;
  video.setAttribute("muted", "");
}

function keepAwake() {
  if (!noSleep || noSleep.isEnabled) return;
  Promise.resolve(noSleep.enable()).catch(() => {});
}
keepAwake();
["pointerup", "keydown", "touchend"].forEach((type) =>
  document.addEventListener(type, keepAwake, { passive: true })
);
// 画面ロックやタブ切替で解除されるので、戻ってきたら取り直す
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && noSleep) {
    noSleep.disable();
    keepAwake();
  }
});

// ---------- 初期化 ----------
applyTheme(safeStorage("get", "theme") === "day" ? "day" : "night");
applyAccent();

fetch("/auth/status")
  .then((res) => res.json())
  .then((status) => {
    connectLink.hidden = !(status.configured && !status.authorized);
  })
  .catch(() => {});
