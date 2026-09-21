const TIMEOUT_MS = 20000;
const cache = new Map();

const apiKey = () => process.env.GEMINI_API_KEY || process.env.GEMINI_ACCESS_TOKEN || "";
const model = () => process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const isConfigured = () => !!apiKey();

const text = (value, max) => String(value ?? "").slice(0, max);
const ratio = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function sanitizeFacts(facts) {
  const f = facts?.features;
  const features = f
    ? {
        bpm: Number.isFinite(f.bpm) ? f.bpm : null,
        key: f.key ? text(f.key, 8) : null,
        mode: f.mode === "major" ? "major" : "minor",
        energy: ratio(f.energy),
        valence: ratio(f.valence),
        danceability: ratio(f.danceability),
        acousticness: ratio(f.acousticness),
      }
    : null;
  const tags = Array.isArray(facts?.tags)
    ? facts.tags.slice(0, 5).map((t) => text(t, 40))
    : [];
  return { features, tags };
}

function describeFeatures(f) {
  if (!f) return "情報なし";
  const parts = [];
  if (f.bpm) parts.push(`BPM ${f.bpm}`);
  if (f.key) parts.push(`キー ${f.key}（${f.mode === "major" ? "長調" : "短調"}）`);
  const levels = [
    ["エネルギー", f.energy],
    ["明るさ(valence)", f.valence],
    ["踊りやすさ", f.danceability],
    ["アコースティック度", f.acousticness],
  ];
  for (const [label, value] of levels) {
    if (typeof value === "number") parts.push(`${label} ${value}（0〜1）`);
  }
  return parts.join(" / ") || "情報なし";
}

function buildPrompt(track, artist, { features, tags }) {
  const tagText = tags.length ? tags.join(", ") : "情報なし";
  return `あなたは親しみやすい音楽評論家です。次の曲を、かわいくて優しい口調で評価してください。

曲名: ${track}
アーティスト: ${artist}

確かな情報（これだけを根拠にする）:
- ユーザー投稿タグ(Last.fm): ${tagText}
- 音の特徴: ${describeFeatures(features)}

ルール:
- 必ず日本語で答える。絵文字は使わない
- 上の情報だけを根拠にする。曲名やアーティスト名から中身を想像して作らない
- Genre はタグのうち「音楽のジャンル」だけを使う。国籍・言語（japanese など）、年代、気分、アーティスト名は入れない。日本語に整え、最大3つを「 / 」で区切る（例: J-Pop / ロック）。vocaloid は「ボカロ」としてジャンルに含めてよい
- ジャンルを表すタグが1つも無ければ、Genre は「不明」と書く
- Mood は音の特徴（エネルギー・明るさ・BPM など）から、短い言葉を2〜3個「・」で区切って書く。文にしない。各6文字以内（例: 疾走感・切ない）
- 出力は下の2行だけ。前置き・説明・見出しは書かない

出力形式:
Genre: （ジャンル）
Mood: （短い言葉を「・」区切りで）`;
}

async function review(body) {
  if (!isConfigured()) throw new Error("GEMINI_API_KEY が未設定です");

  const track = text(body?.track, 200);
  const artist = text(body?.artist, 200);
  if (!track || !artist) throw new Error("track と artist は必須です");

  const facts = sanitizeFacts(body?.facts);
  const key = JSON.stringify([track, artist, facts]);
  if (cache.has(key)) return cache.get(key);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model()}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
      body: JSON.stringify({
        generationConfig: { temperature: 0.4 },
        contents: [{ parts: [{ text: buildPrompt(track, artist, facts) }] }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);

  const json = await res.json();
  const output = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!output) throw new Error("Gemini から評価を取得できませんでした");

  cache.set(key, output);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return output;
}

module.exports = { review, isConfigured };
