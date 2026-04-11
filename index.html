export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = normalizeBody(req.body);
    const textInput = typeof body.text === "string" ? body.text.trim() : "";
    const linkInput = typeof body.link === "string" ? body.link.trim() : "";

    if (!textInput && !linkInput) {
      return res.status(400).json({ error: "Provide text or link." });
    }

    let rawText = textInput;

    if (!rawText && linkInput) {
      rawText = await extractTextFromLink(linkInput);
    }

    if (!rawText || rawText.trim().length < 20) {
      return res.status(400).json({ error: "Not enough content to analyze." });
    }

    const cleaned = cleanText(rawText);
    const normalized = removeAdReads(cleaned);

    if (!normalized || normalized.length < 20) {
      return res.status(400).json({ error: "Content became empty after cleanup." });
    }

    const sentences = splitSentences(normalized);
    const structure = detectStructure(normalized, sentences);
    const topics = detectTopics(normalized);
    const worldview = detectWorldview(normalized);

    const features = analyzeFeatures(normalized, sentences);
    const scores = computeScores(features);

    return res.status(200).json({
      structure,
      topics,
      worldview,
      scores
    });
  } catch (error) {
    console.error("analyze error:", error);
    return res.status(500).json({
      error: error?.message || "Failed to analyze input."
    });
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

async function extractTextFromLink(link) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(link, {
      method: "GET",
      headers: {
        "User-Agent": "ReasoningAudit/1.0",
        "Accept": "text/html,application/xhtml+xml,text/plain"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch link: ${response.status}`);
    }

    const html = await response.text();

    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|br|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    clearTimeout(timeout);
  }
}

function cleanText(raw) {
  let text = String(raw || "");

  text = text.replace(/\r/g, "\n");

  // remove timecodes like 0:00, 12:34, 1:02:03
  text = text.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");

  // remove transcript timing words
  text = text.replace(/\b\d+\s*(second|seconds|minute|minutes|hour|hours)\b/gi, " ");

  // remove UI junk that keeps appearing in pasted transcripts
  text = text.replace(/\bSync to video time\b/gi, " ");
  text = text.replace(/\bRecently uploaded\b/gi, " ");
  text = text.replace(/\bPolitics News\b/gi, " ");
  text = text.replace(/\bFor you\b/gi, " ");
  text = text.replace(/\bAnalyze\b/gi, " ");
  text = text.replace(/\bClear\b/gi, " ");
  text = text.replace(/\bMode:\s*Reasoning Audit\b/gi, " ");
  text = text.replace(/\bAPI:\s*\/api\/analyze\b/gi, " ");

  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{2,}/g, "\n");
  text = text.replace(/\s+([,.!?;:])/g, "$1");

  return text.trim();
}

function removeAdReads(text) {
  const lower = text.toLowerCase();

  const adMarkers = [
    "for a limited time",
    "tempo meals",
    "templemeals.com",
    "tempomeals.com",
    "rules and restrictions may apply"
  ];

  let working = text;

  for (const marker of adMarkers) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) {
      // cut out a chunk around the ad marker
      const start = Math.max(0, idx - 500);
      const end = Math.min(text.length, idx + 1200);
      working = working.slice(0, start) + " " + working.slice(end);
      break;
    }
  }

  return working.replace(/\s+/g, " ").trim();
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function detectStructure(text, sentences) {
  const lower = text.toLowerCase();

  const questionCount = countMatches(text, /\?/g);
  const answerSignals = countMatches(
    lower,
    /\b(well|so|i think|i believe|i don't know|i support|i oppose|what i'd like|the answer)\b/g
  );
  const quoteSignals = countMatches(
    lower,
    /\b(let me read|he said|she said|they said|have a listen|have a watch|quote|quoted)\b/g
  );

  if ((questionCount >= 4 && answerSignals >= 4) || questionCount >= 8) {
    return "debate";
  }

  if (quoteSignals >= 1 || sentences.length > 5) {
    return "commentary";
  }

  return "commentary";
}

function detectTopics(text) {
  const lower = text.toLowerCase();

  const buckets = {
    political: countMatches(lower, /\b(trump|president|war|iran|israel|congress|democrat|republican|government|policy|allies|committee)\b/g),
    media: countMatches(lower, /\b(podcast|interview|show|press|media|new york times|clip|reporting)\b/g),
    theological: countMatches(lower, /\b(god|bible|torah|atheist|christian|judaism|morality|purpose)\b/g),
    social: countMatches(lower, /\b(feminism|women|marriage|children|career|family)\b/g),
    sports: countMatches(lower, /\b(kobe|magic johnson|laker|nba|championship|all-star)\b/g),
    empirical: countMatches(lower, /\b(data|statistics|reported|fact|evidence|source|study|poll|classified|briefed)\b/g)
  };

  const topics = Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .slice(0, 4)
    .map(([name]) => name);

  return topics.length ? topics : ["general"];
}

function detectWorldview(text) {
  const lower = text.toLowerCase();

  const lanes = {
    political: countMatches(lower, /\b(trump|president|iran|israel|war|government|congress|policy)\b/g),
    empirical: countMatches(lower, /\b(data|statistics|reported|fact|evidence|source|study|poll|classified|briefed)\b/g),
    moral: countMatches(lower, /\b(right|wrong|good|evil|honest|dishonest|truth|lie|liar|integrity|genocide)\b/g),
    theological: countMatches(lower, /\b(god|bible|torah|atheist|christian|judaism|morality|purpose)\b/g),
    cultural: countMatches(lower, /\b(feminism|women|marriage|children|career|family)\b/g)
  };

  const worldview = Object.entries(lanes)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .slice(0, 2)
    .map(([name]) => name);

  return worldview.length ? worldview : ["general"];
}

function analyzeFeatures(text, sentences) {
  const lower = text.toLowerCase();
  const sentenceCount = Math.max(sentences.length, 1);
  const avgSentenceLength = text.length / sentenceCount;

  const connectors = countMatches(lower, /\b(because|therefore|so|thus|which means|for example|for instance|in other words)\b/g);
  const evidence = countMatches(lower, /\b(data|statistics|reported|source|evidence|facts|study|poll|classified|briefed|committee)\b/g);
  const hedges = countMatches(lower, /\b(i think|i believe|i guess|maybe|perhaps|it seems|i don't know|we don't know|we'll find out)\b/g);
  const attacks = countMatches(lower, /\b(liar|liars|stupid|dumb|loser|losers|fake news|unhinged|dishonest)\b/g);
  const overclaims = countMatches(lower, /\b(obviously|clearly|absolutely|completely|always|never|that's just true|massive threat|huge win)\b/g);
  const contradictionMarkers = countMatches(lower, /\b(but|however|yet|still|although)\b/g);
  const questions = countMatches(text, /\?/g);
  const directClaims = countMatches(lower, /\b(i support|i oppose|yes|no|my answer is|that's what i think)\b/g);
  const evasion = countMatches(lower, /\b(i don't know|we don't know|we'll find out|i wasn't there|i can't talk about|i'm not invited)\b/g);

  return {
    connectors,
    evidence,
    hedges,
    attacks,
    overclaims,
    contradictionMarkers,
    questions,
    directClaims,
    evasion,
    avgSentenceLength
  };
}

function computeScores(features) {
  let clarity =
    58 +
    features.connectors * 4 +
    features.evidence * 2 +
    features.directClaims * 2 -
    features.evasion * 4 -
    Math.max(features.avgSentenceLength - 180, 0) * 0.12;

  let integrity =
    60 +
    features.evidence * 3 -
    features.attacks * 6 -
    features.overclaims * 3 -
    features.evasion * 2;

  let honesty =
    60 +
    features.directClaims * 3 +
    features.evidence * 2 -
    features.evasion * 5 -
    features.overclaims * 3;

  let manipulation =
    15 +
    features.attacks * 8 +
    features.overclaims * 5 +
    features.evasion * 4;

  let bsn =
    20 +
    features.evasion * 7 +
    features.contradictionMarkers * 3 +
    features.overclaims * 4 +
    Math.max(features.directClaims - features.evidence, 0) * 2;

  return {
    clarity: clampRound(clarity),
    integrity: clampRound(integrity),
    honesty: clampRound(honesty),
    manipulation: clampRound(manipulation),
    bsn: clampRound(bsn)
  };
}

function clampRound(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}
