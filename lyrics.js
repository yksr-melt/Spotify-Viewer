const LRCLIB = "https://lrclib.net/api";
const USER_AGENT = "spotify-site (personal now-playing display)";
const TIMEOUT_MS = 6000;
const MAX_DURATION_DIFF = 6;

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

function firstArtist(artist) {
  return artist.split(/\s*(?:,|、|&|\bfeat\.?\b|\bft\.?\b|×)\s*/i)[0].trim();
}

function cleanTitle(title) {
  return title
    .replace(/\s*[(\[（][^)\]）]*[)\]）]\s*/g, " ")
    .replace(/\s+-\s+.*$/, "")
    .trim();
}

async function lrclibRequest(endpoint, params) {
  const url = new URL(`${LRCLIB}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
  return res.json();
}

function toResult(hit) {
  if (!hit) return null;
  if (hit.instrumental) return { instrumental: true, source: "lrclib" };

  const synced = hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : [];
  const plain = hit.plainLyrics || synced.map((l) => l.text).join("\n");
  if (!synced.length && !plain) return null;

  return {
    lyrics: plain,
    synced: synced.length ? synced : null,
    source: "lrclib",
    sourceUrl: hit.id ? `https://lrclib.net/api/get/${hit.id}` : undefined,
  };
}

function pickBest(hits, duration) {
  const usable = hits.filter((h) => h.syncedLyrics || h.plainLyrics || h.instrumental);
  if (!usable.length) return null;
  if (!duration) return usable[0];

  const scored = usable
    .map((h) => ({ h, diff: Math.abs((h.duration || 0) - duration) }))
    .filter((x) => x.diff <= MAX_DURATION_DIFF)
    .sort((a, b) => Number(!!b.h.syncedLyrics) - Number(!!a.h.syncedLyrics) || a.diff - b.diff);
  return scored[0]?.h || null;
}

async function findLrclib({ track, artist, album, duration }) {
  const seconds = duration ? Math.round(duration) : undefined;

  const exact = await lrclibRequest("/get", {
    track_name: track,
    artist_name: artist,
    album_name: album,
    duration: seconds,
  });
  if (exact) return toResult(exact);

  const hits = await lrclibRequest("/search", {
    track_name: cleanTitle(track) || track,
    artist_name: firstArtist(artist),
  });
  return toResult(pickBest(Array.isArray(hits) ? hits : [], seconds));
}

module.exports = { findLrclib, firstArtist, cleanTitle };
