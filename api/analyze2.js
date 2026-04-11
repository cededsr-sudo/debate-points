export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json(buildErrorPayload("Method not allowed"));
  }

  try {
    const body = parseBody(req.body);
    const textInput = typeof body.text === "string" ? body.text.trim() : "";
    const linkInput = typeof body.link === "string" ? body.link.trim() : "";

    if (!textInput && !linkInput) {
      return res.status(400).json(buildErrorPayload("Provide text or link."));
    }

    let rawText = textInput;

    if (!rawText && linkInput) {
      rawText = await fetchTextFromLink(linkInput);
    }

    if (!rawText || rawText.trim().length < 20) {
      return res.status(400).json(buildErrorPayload("Not enough content to analyze."));
    }

    const cleaned = normalizeTranscript(rawText);

    if (!cleaned || cleaned.length < 20) {
      return res.status(400).json(buildErrorPayload("Content became empty after cleanup."));
    }

    const sentences = splitSentences(cleaned);
    const structure = detectStructure(cleaned, sentences);
    const topics = detectTopics(cleaned);
    const worldview = detectWorldview(cleaned);
    const scores = computeScores(cleaned, sentences);

    return res.status(200).json({
      structure,
      topics,
      worldview,
      scores,
      debug: {
        routeHit: true,
        sentenceCount: sentences.length,
        inputLength: cleaned.length
      }
    });
  } catch (error) {
    console.error("analyze error:", error);
    return res.status(500).json(buildErrorPayload(error?.message || "Server error"));
  }
}

function buildErrorPayload(message) {
  return {
    structure: "error",
    topics: ["system"],
    worldview: ["system"],
    scores: {
      clarity: 0,
      integrity: 0,
      honesty: 0,
      manipulation: 0,
      bsn: 0
    },
    error: message,
    debug: {
      routeHit: true
    }
  };
}

function parseBody(body) {
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

async function fetchTextFromLink(link) {
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

function normalizeTranscript(raw) {
  let text = String(raw || "");

  text = text.replace(/\r/g, "\n");

  text = text.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  text = text.replace(/\b\d+\s*(second|seconds|minute|minutes|hour|hours)\b/gi, " ");

  text = text.replace(/\bSync to video time\b/gi, " ");
  text = text.replace(/\bRecently uploaded\b/gi, " ");
  text = text.replace(/\bPolitics News\b/gi, " ");
  text = text.replace(/\bFor you\b/gi, " ");
  text = text.replace(/\bAnalyze\b/gi, " ");
  text = text.replace(/\bClear\b/gi, " ");
  text = text.replace(/\bMode:\s*Reasoning Audit\b/gi, " ");
  text = text.replace(/\bMode:\s*-\b/gi, " ");
  text = text.replace(/\bHTTP:\s*\d+\b/gi, " ");
  text = text.replace(/\bAPI:\s*\/api\/analyze\b/gi, " ");

  text = removeAdReads(text);

  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{2,}/g, "\n");
  text = text.replace(/\s+([,.!?;:])/g, "$1");

  return text.trim();
}

function removeAdReads(text) {
  const lower = text.toLowerCase();
  const markers = [
    "for a limited time",
    "tempo meals",
    "templemeals.com",
    "tempomeals.com",
    "rules and restrictions may apply"
  ];

  let working = text;

  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) {
      const start = Math.max(0, idx - 500);
      const end = Math.min(text.length, idx + 1400);
      working = working.slice(0, start) + " " + working.slice(end);
      break;
    }
  }

  return working;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function count(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function detectStructure(text, sentences) {
  const lower = text.toLowerCase();

  const questions = count(text, /\?/g);
  const answerSignals = count(
    lower,
    /\b(well|so|i think|i believe|i don't know|i support|i oppose|what i'd like|the answer)\b/g
  );
  const quoteSignals = count(
    lower,
    /\b(let me read|he said|she said|they said|have a listen|have a watch|quote|quoted)\b/g
  );

  if ((questions >= 4 && answerSignals >= 3) || questions >= 8) {
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
    political: count(lower, /\b(trump|president|war|iran|israel|congress|democrat|republican|government|policy|allies|committee)\b/g),
    media: count(lower, /\b(podcast|interview|show|press|media|clip|reporting|journalist)\b/g),
    theological: count(lower, /\b(god|bible|torah|atheist|christian|judaism|morality|purpose)\b/g),
    social: count(lower, /\b(feminism|women|marriage|children|career|family)\b/g),
    sports: count(lower, /\b(kobe|magic johnson|laker|nba|championship|all-star)\b/g),
    empirical: count(lower, /\b(data|statistics|reported|fact|evidence|source|study|poll|classified|briefed)\b/g),
    health: count(lower, /\b(rfk|vaccine|doctor|health|covid|seat belt|medicine|medical)\b/g)
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
    political: count(lower, /\b(trump|president|iran|israel|war|government|congress|policy)\b/g),
    empirical: count(lower, /\b(data|statistics|reported|fact|evidence|source|study|poll|classified|briefed)\b/g),
    moral: count(lower, /\b(right|wrong|good|evil|honest|dishonest|truth|lie|liar|integrity)\b/g),
    theological: count(lower, /\b(god|bible|torah|atheist|christian|judaism|morality|purpose)\b/g),
    cultural: count(lower, /\b(feminism|women|marriage|children|career|family)\b/g)
  };

  const worldview = Object.entries(lanes)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .slice(0, 2)
    .map(([name]) => name);

  return worldview.length ? worldview : ["general"];
}

function computeScores(text, sentences) {
  const lower = text.toLowerCase();
  const sentenceCount = Math.max(sentences.length, 1);
  const avgSentenceLength = text.length / sentenceCount;

  const connectors = count(lower, /\b(because|therefore|so|thus|which means|for example|for instance|in other words)\b/g);
  const evidence = count(lower, /\b(data|statistics|reported|source|evidence|facts|study|poll|classified|briefed|committee)\b/g);
  const hedges = count(lower, /\b(i think|i believe|i guess|maybe|perhaps|it seems|i don't know|we don't know|we'll find out)\b/g);
  const attacks = count(lower, /\b(liar|liars|stupid|dumb|loser|losers|fake news|unhinged|dishonest)\b/g);
  const overclaims = count(lower, /\b(obviously|clearly|absolutely|completely|always|never|that's just true|massive threat|huge win)\b/g);
  const contradictions = count(lower, /\b(but|however|yet|still|although)\b/g);
  const directClaims = count(lower, /\b(i support|i oppose|yes|no|my answer is|that's what i think)\b/g);
  const evasion = count(lower, /\b(i don't know|we don't know|we'll find out|i wasn't there|i can't talk about|i'm not invited)\b/g);

  const clarity =
    58 +
    connectors * 4 +
    evidence * 2 +
    directClaims * 2 -
    evasion * 4 -
    Math.max(avgSentenceLength - 180, 0) * 0.12;

  const integrity =
    60 +
    evidence * 3 -
    attacks * 6 -
    overclaims * 3 -
    evasion * 2;

  const honesty =
    60 +
    directClaims * 3 +
    evidence * 2 -
    evasion * 5 -
    overclaims * 3 -
    hedges;

  const manipulation =
    15 +
    attacks * 8 +
    overclaims * 5 +
    evasion * 4;

  const bsn =
    20 +
    evasion * 7 +
    contradictions * 3 +
    overclaims * 4 +
    Math.max(directClaims - evidence, 0) * 2;

  return {
    clarity: clamp(clarity),
    integrity: clamp(integrity),
    honesty: clamp(honesty),
    manipulation: clamp(manipulation),
    bsn: clamp(bsn)
  };
}
