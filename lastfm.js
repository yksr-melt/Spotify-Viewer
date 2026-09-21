const ENDPOINT = "https://ws.audioscrobbler.com/2.0/";
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 60 * 1000;

const apiKey = () => process.env.LASTFM_API_KEY || "";
const user = () => process.env.LASTFM_USER || "";

const isConfigured = () => !!(apiKey() && user());

// ブラウザから呼べる Last.fm メソッドと、受け付けるパラメータ（api_key / user はサーバーが付ける）
const METHODS = {
  "user.getrecenttracks": ["limit", "from", "page"],
  "track.getTopTags": ["artist", "track"],
  "track.getInfo": ["artist", "track"],
  "artist.getTopTags": ["artist"],
};

const cache = new Map();

async function call(query) {
  if (!isConfigured()) {
    const err = new Error("LASTFM_API_KEY / LASTFM_USER が未設定です");
    err.status = 503;
    throw err;
  }

  const method = String(query.method || "");
  const allowed = METHODS[method];
  if (!allowed) {
    const err = new Error("許可されていない method です");
    err.status = 400;
    throw err;
  }

  const params = new URLSearchParams({
    method,
    api_key: apiKey(),
    format: "json",
    autocorrect: "1",
  });
  for (const name of allowed) {
    if (query[name] !== undefined) params.set(name, String(query[name]).slice(0, 200));
  }
  if (method === "user.getrecenttracks") params.set("user", user());

  // タグ・曲情報は変わりにくいのでキャッシュする（履歴は毎回取り直す）
  const cacheable = method !== "user.getrecenttracks";
  const cacheKey = params.toString();
  if (cacheable) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  }

  const res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = await res.json().catch(() => ({}));

  if (cacheable && res.ok) {
    cache.set(cacheKey, { data, at: Date.now() });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return data;
}

module.exports = { call, isConfigured };
