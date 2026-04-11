// /api/analyze.js

function createFallbackResponse() {
  return {
    structure: "mixed",
    topics: [],
    worldview: [],
    scores: {
      clarity: 0,
      integrity: 0,
      honesty: 0,
      manipulation: 0,
      bsn: 0
    }
  };
}

function clamp(value, min = 0, max = 100) {
  const num = Number.isFinite(value) ? value : 0;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function toSafeString(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function splitWords(text) {
  return text.toLowerCase().match(/[a-z0-9']+/g) || [];
}

function uniqueStrings(items, limit) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const value = toSafeString(item).trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }

  return out;
}

function normalizeResponseShape(result) {
  const fallback = createFallbackResponse();
  const safe = result && typeof result === "object" ? result : fallback;
  const safeScores = safe.scores && typeof safe.scores === "object" ? safe.scores : fallback.scores;

  return {
    structure: toSafeString(safe.structure).trim() || fallback.structure,
    topics: Array.isArray(safe.topics) ? safe.topics.map(toSafeString).filter(Boolean) : fallback.topics,
    worldview: Array.isArray(safe.worldview) ? safe.worldview.map(toSafeString).filter(Boolean) : fallback.worldview,
    scores: {
      clarity: clamp(Number(safeScores.clarity)),
      integrity: clamp(Number(safeScores.integrity)),
      honesty: clamp(Number(safeScores.honesty)),
      manipulation: clamp(Number(safeScores.manipulation)),
      bsn: clamp(Number(safeScores.bsn))
    }
  };
}

async function readRawBody(req) {
  if (!req || typeof req !== "object") return "";

  if (typeof req.body === "string") {
    return req.body;
  }

  if (req.body && typeof req.body === "object") {
    try {
      return JSON.stringify(req.body);
    } catch {
      return "";
    }
  }

  return await new Promise((resolve) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        data = data.slice(0, 2_000_000);
      }
    });

    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

async function parseIncomingBody(req) {
  try {
    if (req && req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      return req.body;
    }

    const raw = await readRawBody(req);
    if (!raw) return {};

    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

function detectStructure(text) {
  const lower = text.toLowerCase();

  const argumentativeHits = [
    "because", "therefore", "thus", "hence", "so ", "if ", "then ",
    "evidence", "proof", "reason", "argument", "claim", "premise", "conclusion"
  ].reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);

  const narrativeHits = [
    "then", "after", "before", "when", "suddenly", "later", "story", "happened"
  ].reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);

  const confrontationalHits = [
    "you", "they", "lied", "stupid", "idiot", "fake", "nonsense", "bullshit", "moron"
  ].reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);

  if (!text.trim()) return "empty";
  if (argumentativeHits >= narrativeHits && argumentativeHits >= 2) return "argument";
  if (narrativeHits >= argumentativeHits && narrativeHits >= 2) return "narrative";
  if (confrontationalHits >= 3) return "conflict";
  return "mixed";
}

function extractTopics(text) {
  const lower = text.toLowerCase();
  const topicMap = [
    { label: "politics", patterns: ["president", "congress", "senate", "election", "policy", "government", "trump", "biden"] },
    { label: "religion", patterns: ["god", "jesus", "bible", "church", "faith", "prophet", "salvation"] },
    { label: "ethics", patterns: ["moral", "morality", "right", "wrong", "good", "evil"] },
    { label: "truth claims", patterns: ["truth", "false", "lie", "real", "reality", "facts"] },
    { label: "evidence", patterns: ["evidence", "proof", "source", "data", "study", "citation"] },
    { label: "relationships", patterns: ["family", "wife", "husband", "friend", "lover", "relationship"] },
    { label: "media", patterns: ["video", "podcast", "article", "youtube", "tiktok", "post"] },
    { label: "education", patterns: ["school", "class", "teacher", "student", "assignment"] },
    { label: "law", patterns: ["legal", "court", "judge", "law", "crime", "felony"] },
    { label: "technology", patterns: ["app", "api", "frontend", "backend", "code", "server"] }
  ];

  const found = [];

  for (const topic of topicMap) {
    if (topic.patterns.some((p) => lower.includes(p))) {
      found.push(topic.label);
    }
  }

  if (found.length === 0) {
    const words = splitWords(text)
      .filter((w) => w.length >= 5)
      .filter((w) => !COMMON_WORDS.has(w));

    return uniqueStrings(words.slice(0, 6), 6);
  }

  return uniqueStrings(found, 6);
}

function extractWorldview(text) {
  const lower = text.toLowerCase();
  const tags = [];

  const worldviewRules = [
    { label: "religious framing", patterns: ["god", "jesus", "bible", "faith", "sin", "salvation"] },
    { label: "skeptical framing", patterns: ["prove", "evidence", "source", "data", "show me"] },
    { label: "moral absolutism", patterns: ["always", "never", "evil", "truth is truth", "right and wrong"] },
    { label: "adversarial framing", patterns: ["you people", "they always", "liar", "idiot", "stupid", "bullshit"] },
    { label: "political framing", patterns: ["left", "right", "democrat", "republican", "trump", "biden"] },
    { label: "personal grievance", patterns: ["you did this", "wasting my time", "you ruined", "you messed up"] },
    { label: "certainty-first", patterns: ["obviously", "clearly", "everyone knows", "no question"] },
    { label: "defensive posture", patterns: ["i'm not saying", "that is not what i said", "stop twisting", "misrepresenting"] }
  ];

  for (const rule of worldviewRules) {
    if (rule.patterns.some((p) => lower.includes(p))) {
      tags.push(rule.label);
    }
  }

  if (tags.length === 0) {
    if (!text.trim()) return [];
    return ["undetermined"];
  }

  return uniqueStrings(tags, 6);
}

const COMMON_WORDS = new Set([
  "about", "after", "again", "against", "almost", "also", "always", "another", "because",
  "before", "being", "between", "could", "every", "first", "going", "great", "group",
  "might", "never", "other", "people", "really", "should", "still", "their", "there",
  "these", "thing", "think", "those", "through", "under", "using", "where", "which",
  "would", "input", "transcript", "argument", "paste", "optional", "provide", "request"
]);

function countMatches(text, patterns) {
  const lower = text.toLowerCase();
  let count = 0;

  for (const pattern of patterns) {
    if (pattern instanceof RegExp) {
      const matches = lower.match(pattern);
      count += matches ? matches.length : 0;
    } else if (typeof pattern === "string" && pattern) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = lower.match(new RegExp(escaped, "g"));
      count += matches ? matches.length : 0;
    }
  }

  return count;
}

function analyzeScores(text) {
  const words = splitWords(text);
  const wordCount = words.length;
  const sentenceMatches = text.match(/[^.!?\n]+[.!?]?/g) || [];
  const sentences = sentenceMatches.map((s) => s.trim()).filter(Boolean);
  const sentenceCount = Math.max(sentences.length, 1);

  const connectors = countMatches(text, [
    "because", "therefore", "however", "although", "if", "then", "so", "but", "since", "thus", "for example"
  ]);

  const evidenceCount = countMatches(text, [
    "evidence", "proof", "source", "according to", "data", "study", "quote", "facts", "documented"
  ]);

  const hedgeCount = countMatches(text, [
    "maybe", "perhaps", "probably", "possibly", "i think", "i guess", "sort of", "kind of", "seems like"
  ]);

  const directnessCount = countMatches(text, [
    "i know", "i believe", "my point", "the point is", "this means", "i am saying"
  ]);

  const insultCount = countMatches(text, [
    "idiot", "stupid", "moron", "dumb", "bitch", "bullshit", "trash", "worthless", "loser", "evil"
  ]);

  const exaggerationCount = countMatches(text, [
    "always", "never", "everyone", "nobody", "literally", "obviously", "100%", "completely", "totally"
  ]);

  const evasionCount = countMatches(text, [
    "whatever", "anyway", "but that's not the point", "you know what i mean", "never mind", "doesn't matter"
  ]);

  const contradictionPairs = [
    ["always", "never"],
    ["everyone", "nobody"],
    ["nothing", "everything"]
  ];

  let contradictionCount = 0;
  const lower = text.toLowerCase();
  for (const [a, b] of contradictionPairs) {
    if (lower.includes(a) && lower.includes(b)) contradictionCount += 1;
  }

  const avgSentenceLength = wordCount / sentenceCount;
  const shortSentenceBonus = avgSentenceLength >= 7 && avgSentenceLength <= 24 ? 12 : 0;
  const connectorBonus = Math.min(connectors * 6, 24);
  const evidenceBonus = Math.min(evidenceCount * 8, 24);
  const insultPenalty = Math.min(insultCount * 8, 40);
  const hedgePenalty = Math.min(hedgeCount * 5, 25);
  const exaggerationPenalty = Math.min(exaggerationCount * 4, 24);
  const evasionPenalty = Math.min(evasionCount * 8, 30);
  const contradictionPenalty = Math.min(contradictionCount * 18, 36);

  let clarity = 35 + shortSentenceBonus + connectorBonus - Math.max(0, avgSentenceLength > 35 ? 15 : 0) - Math.min(insultCount * 3, 15);
  if (wordCount < 8) clarity -= 20;

  let integrity = 45 + evidenceBonus - insultPenalty - Math.min(exaggerationCount * 3, 15);
  if (evidenceCount === 0 && wordCount > 30) integrity -= 10;

  let honesty = 50 + Math.min(directnessCount * 6, 18) - hedgePenalty - Math.min(evasionCount * 6, 24);

  let manipulation = 10 + insultCount * 10 + exaggerationCount * 6 + evasionCount * 8;
  if (countMatches(text, ["you people", "they always", "clearly", "obviously"]) > 0) manipulation += 10;

  let bsn = 15 + contradictionPenalty + evasionPenalty + Math.min(exaggerationCount * 5, 20);
  if (evidenceCount === 0 && connectors === 0 && wordCount > 20) bsn += 15;

  return {
    clarity: clamp(clarity),
    integrity: clamp(integrity),
    honesty: clamp(honesty),
    manipulation: clamp(manipulation),
    bsn: clamp(bsn)
  };
}

function buildAnalysis(text, link) {
  const combined = `${toSafeString(text)} ${toSafeString(link)}`.trim();
  const fallback = createFallbackResponse();

  if (!combined) {
    return {
      structure: "empty",
      topics: [],
      worldview: [],
      scores: fallback.scores
    };
  }

  return normalizeResponseShape({
    structure: detectStructure(combined),
    topics: extractTopics(combined),
    worldview: extractWorldview(combined),
    scores: analyzeScores(combined)
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const sendSafe = (payload, statusCode = 200) => {
    const safePayload = normalizeResponseShape(payload);
    res.status(statusCode).send(JSON.stringify(safePayload));
  };

  try {
    if (!req || req.method !== "POST") {
      return sendSafe(createFallbackResponse(), 200);
    }

    const body = await parseIncomingBody(req);
    const text = toSafeString(body && body.text);
    const link = toSafeString(body && body.link);

    const result = buildAnalysis(text, link);
    return sendSafe(result, 200);
  } catch {
    return sendSafe(createFallbackResponse(), 200);
  }
};
