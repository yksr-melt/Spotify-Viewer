const ENDPOINT = "https://api.reccobeats.com/v1/audio-features";
const TIMEOUT_MS = 6000;

const MAJOR_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const MINOR_NAMES = ["Cm", "C♯m", "Dm", "E♭m", "Em", "Fm", "F♯m", "Gm", "G♯m", "Am", "B♭m", "Bm"];
const MAJOR_CAMELOT = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const MINOR_CAMELOT = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

const cache = new Map();
const NEGATIVE_TTL_MS = 30 * 60 * 1000;

function remember(id, value) {
  cache.set(id, { value, at: Date.now() });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
}

function ratio(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function convert(raw) {
  const tempo = Number(raw.tempo);
  const key = Number.isInteger(raw.key) && raw.key >= 0 && raw.key < 12 ? raw.key : null;
  const major = raw.mode === 1;

  return {
    bpm: tempo > 0 ? Math.round(tempo) : null,
    key: key === null ? null : major ? MAJOR_NAMES[key] : MINOR_NAMES[key],
    camelot: key === null ? null : major ? MAJOR_CAMELOT[key] : MINOR_CAMELOT[key],
    mode: major ? "major" : "minor",
    energy: ratio(raw.energy),
    valence: ratio(raw.valence),
    danceability: ratio(raw.danceability),
    acousticness: ratio(raw.acousticness),
    instrumentalness: ratio(raw.instrumentalness),
  };
}

async function getFeatures(spotifyId) {
  if (!/^[0-9A-Za-z]{22}$/.test(spotifyId)) return null;

  const hit = cache.get(spotifyId);
  if (hit && (hit.value || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.value;

  const res = await fetch(`${ENDPOINT}?ids=${spotifyId}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ReccoBeats HTTP ${res.status}`);

  const json = await res.json();
  const raw = json?.content?.[0];
  const value = raw ? convert(raw) : null;
  if (value && value.bpm === null && value.key === null) {
    remember(spotifyId, null);
    return null;
  }
  remember(spotifyId, value);
  return value;
}

module.exports = { getFeatures };
