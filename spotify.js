const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TOKEN_FILE = path.join(__dirname, ".spotify-token.json");
const SCOPES = "user-read-playback-state user-modify-playback-state";
const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
const REQUEST_TIMEOUT_MS = 5000;

const clientId = () => process.env.SPOTIFY_CLIENT_ID || "";
const redirectUri = () =>
  process.env.SPOTIFY_REDIRECT_URI ||
  `http://127.0.0.1:${process.env.AUTH_PORT || 8080}/callback`;

let tokens = readTokens();
let refreshing = null;
let cooldownUntil = 0;
const pendingLogins = new Map();

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveTokens(next) {
  tokens = next;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(next), { mode: 0o600 });
}

function clearTokens() {
  tokens = null;
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

const isConfigured = () => !!clientId();
const isAuthorized = () => isConfigured() && !!tokens?.refresh_token;

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), ...params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `HTTP ${res.status}`);
    err.code = json.error;
    throw err;
  }
  return json;
}

async function getAccessToken() {
  if (!isAuthorized()) return null;
  if (tokens.access_token && Date.now() < tokens.expires_at - 30_000) {
    return tokens.access_token;
  }

  if (!refreshing) {
    refreshing = tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    })
      .then((json) => {
        saveTokens({
          access_token: json.access_token,
          refresh_token: json.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + json.expires_in * 1000,
        });
      })
      .catch((err) => {
        if (err.code === "invalid_grant") clearTokens();
        throw err;
      })
      .finally(() => {
        refreshing = null;
      });
  }

  await refreshing;
  return tokens?.access_token || null;
}

async function request(method, endpoint, query) {
  if (Date.now() < cooldownUntil) throw new Error("rate limited");

  const token = await getAccessToken();
  if (!token) throw new Error("not authorized");

  const url = new URL(API + endpoint);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 429) {
    cooldownUntil = Date.now() + (Number(res.headers.get("retry-after")) || 5) * 1000;
    throw new Error("rate limited");
  }
  if (res.status === 401) {
    tokens.expires_at = 0;
    throw new Error("unauthorized");
  }
  return res;
}

function mapPlayback(p) {
  const item = p.item;
  const isAd = p.currently_playing_type === "ad";
  if (!item && !isAd) return null;

  const images = item?.album?.images || item?.images || [];
  return {
    track: item?.name || "Advertisement",
    artist:
      item?.artists?.map((a) => a.name).join(", ") || item?.show?.publisher || "",
    album: item?.album?.name || item?.show?.name || "",
    position: (p.progress_ms || 0) / 1000,
    duration: (item?.duration_ms || 0) / 1000,
    state: p.is_playing ? "playing" : "paused",
    artwork: (images[1] || images[0])?.url || null,
    volume: p.device?.volume_percent ?? null,
    deviceType: p.device?.type || null,
    deviceName: p.device?.name || null,
    shuffle: !!p.shuffle_state,
    repeat: p.repeat_state || "off",
    id: item?.type === "track" && !item.is_local ? item.id : null,
    isAd,
    source: "api",
  };
}

// 再生中なら楽曲情報、何も再生されていなければ null。API が使えない場合は throw。
async function getPlayback() {
  const res = await request("GET", "/me/player", { additional_types: "episode" });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return mapPlayback(await res.json());
}

async function control(action, value) {
  let res;
  switch (action) {
    case "play":
      res = await request("PUT", "/me/player/play");
      break;
    case "pause":
      res = await request("PUT", "/me/player/pause");
      break;
    case "next":
      res = await request("POST", "/me/player/next");
      break;
    case "previous":
      res = await request("POST", "/me/player/previous");
      break;
    case "volume":
      res = await request("PUT", "/me/player/volume", { volume_percent: value });
      break;
    case "shuffle":
      res = await request("PUT", "/me/player/shuffle", { state: value });
      break;
    case "repeat":
      res = await request("PUT", "/me/player/repeat", { state: value });
      break;
    default:
      throw new Error(`unknown action: ${action}`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.reason = body?.error?.reason || "";
    throw err;
  }
}

function startLogin() {
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");

  const now = Date.now();
  for (const [key, entry] of pendingLogins) {
    if (now - entry.at > 10 * 60 * 1000) pendingLogins.delete(key);
  }
  pendingLogins.set(state, { verifier, at: now });

  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

async function handleCallback({ code, state, error }) {
  if (error) throw new Error(String(error));
  const pending = pendingLogins.get(state);
  if (!code || !pending) throw new Error("state が不正、または期限切れです");
  pendingLogins.delete(state);

  const json = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  saveTokens({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  });
}

module.exports = {
  isConfigured,
  isAuthorized,
  getPlayback,
  control,
  startLogin,
  handleCallback,
};
