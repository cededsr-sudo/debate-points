const MAX_TEXT_LENGTH = 250000;

function makeBaseResponse() {
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
    },
    arguments: [],
    summary: {
      text: "No analysis available.",
      strongest_points: [],
      weakest_points: [],
      notable_problems: []
    }
  };
}

function clamp(value, min = 0, max = 100) {
  const num = Number.isFinite(value) ? value : 0;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function safeString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function cleanText(value) {
  return safeString(value)
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .trim();
}

function unique(items, limit = 8) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const value = cleanText(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }

  return out;
}

function normalizeArray(value, limit = 8) {
  if (!Array.isArray(value)) return [];
  return unique(value, limit);
}

function normalizeArgument(arg) {
  return {
    type: cleanText(arg && arg.type) || "claim",
    text: cleanText(arg && arg.text) || "General argument detected but not cleanly parsed.",
    strength: clamp(Number(arg && arg.strength)),
    issues: normalizeArray(arg && arg.issues, 6)
  };
}

function normalizeOutput(value) {
  const base = makeBaseResponse();
  const scores = value && value.scores && typeof value.scores === "object" ? value.scores : {};
  const summary = value && value.summary && typeof value.summary === "object" ? value.summary : {};

  return {
    structure: cleanText(value && value.structure) || base.structure,
    topics: normalizeArray(value && value.topics, 8),
    worldview: normalizeArray(value && value.worldview, 8),
    scores: {
      clarity: clamp(Number(scores.clarity)),
      integrity: clamp(Number(scores.integrity)),
      honesty: clamp(Number(scores.honesty)),
      manipulation: clamp(Number(scores.manipulation)),
      bsn: clamp(Number(scores.bsn))
    },
    arguments: Array.isArray(value && value.arguments)
      ? value.arguments.map(normalizeArgument).slice(0, 12)
      : [],
    summary: {
      text: cleanText(summary.text) || base.summary.text,
      strongest_points: normalizeArray(summary.strongest_points, 5),
      weakest_points: normalizeArray(summary.weakest_points, 5),
      notable_problems: normalizeArray(summary.notable_problems, 8)
    }
  };
}

function sendJson(res, statusCode, payload) {
  const safe = normalizeOutput(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(safe));
}

async function readBody(req) {
  if (req && req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (req && typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return new Promise((resolve) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_TEXT_LENGTH * 2) {
        raw = raw.slice(0, MAX_TEXT_LENGTH * 2);
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });

    req.on("error", () => resolve({}));
  });
}

function countMatches(text, patterns) {
  const lower = text.toLowerCase();
  let total = 0;

  for (const pattern of patterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = lower.match(new RegExp(escaped, "g"));
    total += matches ? matches.length : 0;
  }

  return total;
}

function splitWords(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter(Boolean);
}

function stripTimestampsKeepLines(text) {
  return cleanText(text)
    .replace(/^\s*\d+:\d+\s*/gm, "")
    .replace(/^\s*\d+\s*seconds?\s*$/gim, "")
    .replace(/^\s*\d+\s*minutes?,?\s*\d*\s*seconds?\s*$/gim, "")
    .replace(/\[\s*applause\s*\]|\[\s*laughter\s*\]|\[\s*clears throat\s*\]/gi, "");
}

function removeNoise(text) {
  return stripTimestampsKeepLines(text)
    .replace(/[^\x00-\x7F]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function splitIntoSegments(rawText) {
  const text = removeNoise(rawText);
  if (!text) return [];

  const matches = [...text.matchAll(/(^|\n)(chapter\s+\d+\s*:\s*[^\n]+)/gi)];
  if (!matches.length) {
    return [{ title: "Full Text", body: text }];
  }

  const segments = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index || 0;
    const end = i + 1 < matches.length ? matches[i + 1].index || text.length : text.length;
    const chunk = text.slice(start, end).trim();
    const firstLine = chunk.split("\n")[0] || `Chapter ${i + 1}`;
    segments.push({
      title: cleanText(firstLine),
      body: chunk
    });
  }

  return segments;
}

function detectStructure(text) {
  if (!text) return "mixed";

  const argumentHits = countMatches(text, [
    "because", "therefore", "however", "evidence", "proof", "claim",
    "point", "reason", "why", "statistics", "research", "poll"
  ]);
  const conflictHits = countMatches(text, [
    "wrong", "liar", "lying", "stop", "let me", "not true",
    "that's a lie", "you keep", "talking over", "attitude", "respond"
  ]);
  const narrativeHits = countMatches(text, [
    "then", "after", "before", "later", "when", "story", "happened"
  ]);

  if (conflictHits >= 4) return "conflict";
  if (argumentHits >= 4) return "argument";
  if (narrativeHits >= 4) return "narrative";
  return "mixed";
}

function extractTopics(text) {
  const lower = text.toLowerCase();
  const topics = [];

  const rules = [
    ["religion", ["god", "jesus", "bible", "church", "atheist", "christian", "faith"]],
    ["politics", ["government", "president", "conservative", "liberal", "policy", "election"]],
    ["health", ["vaccine", "doctor", "medical", "health", "covid", "disease", "medicine", "rfk"]],
    ["morality", ["moral", "morality", "good", "evil", "purpose", "sin"]],
    ["gender", ["women", "woman", "men", "man", "mother", "feminism", "marriage"]],
    ["race", ["black", "policing", "poverty", "community", "racism", "crime"]],
    ["sports", ["nba", "lakers", "kobe", "magic", "lebron", "finals"]],
    ["truth", ["truth", "lie", "lying", "honest", "dishonest", "facts", "evidence"]],
    ["education", ["school", "college", "student", "teacher", "educated"]]
  ];

  for (const [label, words] of rules) {
    if (words.some((word) => lower.includes(word))) {
      topics.push(label);
    }
  }

  return unique(topics, 8);
}

function extractWorldview(text) {
  const lower = text.toLowerCase();
  const worldview = [];

  const rules = [
    ["religious framing", ["god", "jesus", "bible", "faith", "sin", "christian"]],
    ["skeptical framing", ["evidence", "proof", "source", "statistics", "research", "poll"]],
    ["adversarial framing", ["wrong", "liar", "lying", "stop", "attitude", "talking over"]],
    ["certainty-first", ["obviously", "clearly", "absolutely", "everyone knows"]],
    ["defensive posture", ["that's not what i said", "misrepresent", "twisting", "not the point"]],
    ["moral absolutism", ["always", "never", "good", "evil", "truth"]],
    ["political framing", ["conservative", "liberal", "left", "right", "fascist"]]
  ];

  for (const [label, words] of rules) {
    if (words.some((word) => lower.includes(word))) {
      worldview.push(label);
    }
  }

  return unique(worldview, 8);
}

function splitSentences(text) {
  const compact = removeNoise(text).replace(/\n+/g, " ");
  return compact
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => cleanText(s))
    .filter(Boolean);
}

function analyzeScores(text) {
  const words = splitWords(text);
  const wordCount = words.length;
  const sentences = splitSentences(text);
  const sentenceCount = Math.max(sentences.length, 1);
  const avgSentenceLength = wordCount / sentenceCount;

  const connectors = countMatches(text, [
    "because", "therefore", "however", "for example", "if", "then", "but", "so", "since"
  ]);
  const evidenceCount = countMatches(text, [
    "evidence", "proof", "source", "study", "data", "statistics", "according to", "poll", "research"
  ]);
  const hedgeCount = countMatches(text, [
    "maybe", "perhaps", "probably", "possibly", "kind of", "sort of", "seems"
  ]);
  const pressureCount = countMatches(text, [
    "stop", "let me", "you keep", "talking over", "attitude", "obviously", "clearly"
  ]);
  const exaggerationCount = countMatches(text, [
    "always", "never", "everyone", "nobody", "totally", "completely"
  ]);
  const evasionCount = countMatches(text, [
    "that's not the point", "totally different statistics", "i've read the opposite",
    "anyway", "whatever", "i do not believe they are"
  ]);

  let clarity = 35 + Math.min(connectors * 6, 24);
  if (avgSentenceLength >= 7 && avgSentenceLength <= 24) clarity += 18;
  if (avgSentenceLength > 35) clarity -= 15;
  if (wordCount < 8) clarity -= 20;

  let integrity = 45 + Math.min(evidenceCount * 8, 32);
  integrity -= Math.min(exaggerationCount * 4, 20);
  integrity -= Math.min(evasionCount * 8, 24);

  let honesty = 50 + Math.min(evidenceCount * 4, 20);
  honesty -= Math.min(hedgeCount * 5, 25);
  honesty -= Math.min(evasionCount * 8, 24);

  let manipulation = 10 + Math.min(pressureCount * 8, 40);
  manipulation += Math.min(exaggerationCount * 5, 20);

  let bsn = 15 + Math.min(evasionCount * 10, 30) + Math.min(exaggerationCount * 5, 20);
  if (evidenceCount === 0 && connectors === 0 && wordCount > 20) bsn += 15;

  return {
    clarity: clamp(clarity),
    integrity: clamp(integrity),
    honesty: clamp(honesty),
    manipulation: clamp(manipulation),
    bsn: clamp(bsn)
  };
}

function scoreSegment(segment) {
  const cleaned = removeNoise(segment.body);
  const words = splitWords(cleaned).length;

  const interruptionHits = countMatches(cleaned, [
    "stop", "let me", "you keep", "talking over", "not allowing me",
    "let somebody get in", "you have not let", "respond"
  ]);

  const accusationHits = countMatches(cleaned, [
    "that's a lie", "that is a lie", "that's not true", "that is not true",
    "wrong", "liar", "lying"
  ]);

  const evidenceHits = countMatches(cleaned, [
    "statistics", "study", "data", "research", "poll", "evidence", "proof",
    "according to", "predictor", "outcomes"
  ]);

  const challengeHits = countMatches(cleaned, [
    "how can", "how is that", "what do you mean", "why are you", "how are you measuring"
  ]);

  let score = 0;
  score += Math.min(words, 1500) / 30;
  score += interruptionHits * 18;
  score += accusationHits * 18;
  score += evidenceHits * 8;
  score += challengeHits * 7;

  if (/candace owens vs feminists/i.test(segment.title)) {
    score += 50;
  }

  return score;
}

function chooseBestSegment(text) {
  const segments = splitIntoSegments(text);
  if (!segments.length) return { title: "Full Text", body: removeNoise(text) };

  const scored = segments
    .map((segment) => ({ ...segment, score: scoreSegment(segment) }))
    .sort((a, b) => b.score - a.score);

  return scored[0];
}

function classifyArgument(sentence) {
  const lower = sentence.toLowerCase();
  const issues = [];
  let type = "claim";
  let strength = 45;

  const hasEvidence = [
    "study", "statistics", "data", "research", "according to", "poll",
    "predictor", "outcomes", "rates", "poverty", "mental health",
    "higher incomes", "behavioral problems", "divorced"
  ].some((term) => lower.includes(term));

  const isChallenge = [
    "how can", "how is that", "what do you mean", "how are you measuring", "why are you"
  ].some((term) => lower.includes(term));

  const isDodge = [
    "totally different statistics",
    "i've actually read the exact opposite",
    "that's not what i'm talking about",
    "i do not believe they are",
    "i'm saying that",
    "because everything that you said i've actually read the exact opposite"
  ].some((term) => lower.includes(term));

  const isManipulation = [
    "you have an attitude",
    "performative",
    "stop",
    "let somebody get in",
    "you don't want to",
    "you keep",
    "not allowing me to respond",
    "not productive"
  ].some((term) => lower.includes(term));

  const isCounter = [
    "that's not true", "that is not true", "wrong", "that's a lie", "that is a lie"
  ].some((term) => lower.includes(term));

  if (hasEvidence) {
    type = "evidence";
    strength += 25;
  }

  if (isChallenge) {
    type = "challenge";
    strength += 12;
  }

  if (isCounter) {
    type = "counterpoint";
    strength += 8;
    issues.push("accusation");
  }

  if (isDodge) {
    type = "dodge";
    strength -= 15;
    issues.push("non-answer");
    issues.push("unsupported assertion");
  }

  if (isManipulation) {
    type = "manipulation";
    strength -= 12;
    issues.push("pressure tactic");
  }

  if (lower.includes("obviously") || lower.includes("clearly") || lower.includes("absolutely")) {
    issues.push("unsupported certainty");
    strength -= 8;
  }

  if (lower.includes("everyone") || lower.includes("never") || lower.includes("always")) {
    issues.push("overgeneralization");
    strength -= 6;
  }

  if (lower.includes("because") || lower.includes("so how can") || lower.includes("which means")) {
    strength += 8;
  }

  if (sentence.length > 200) strength -= 4;
  if (sentence.length < 24) strength -= 8;

  return {
    type,
    text: sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence,
    strength: clamp(strength),
    issues: unique(issues, 6)
  };
}

function extractArguments(text) {
  const sentences = splitSentences(text);

  const picked = sentences
    .filter((sentence) => sentence.length >= 24)
    .filter((sentence) => {
      const lower = sentence.toLowerCase();
      return (
        lower.includes("statistics") ||
        lower.includes("study") ||
        lower.includes("data") ||
        lower.includes("research") ||
        lower.includes("poll") ||
        lower.includes("poverty") ||
        lower.includes("predictor") ||
        lower.includes("mental health") ||
        lower.includes("behavioral problems") ||
        lower.includes("higher incomes") ||
        lower.includes("that's not true") ||
        lower.includes("wrong") ||
        lower.includes("how can") ||
        lower.includes("how are you measuring") ||
        lower.includes("totally different statistics") ||
        lower.includes("attitude") ||
        lower.includes("let me finish") ||
        lower.includes("performative") ||
        lower.includes("obviously") ||
        lower.includes("because")
      );
    })
    .map(classifyArgument)
    .sort((a, b) => b.strength - a.strength);

  if (!picked.length) {
    const fallback = sentences.slice(0, 6).map(classifyArgument);
    return fallback.length
      ? fallback
      : [{
          type: "claim",
          text: "General argument detected but not cleanly parsed.",
          strength: 25,
          issues: ["low parse confidence"]
        }];
  }

  return picked.slice(0, 10);
}

function buildSummary(argumentsList, segmentTitle) {
  const strongest = argumentsList
    .filter((item) => item.type === "evidence" || item.type === "challenge")
    .slice(0, 3)
    .map((item) => item.text);

  const weakest = argumentsList
    .filter((item) =>
      item.type === "dodge" ||
      item.type === "manipulation" ||
      item.issues.includes("unsupported assertion") ||
      item.issues.includes("unsupported certainty")
    )
    .slice(0, 3)
    .map((item) => item.text);

  const problems = unique(argumentsList.flatMap((item) => item.issues || []), 8);
  const title = cleanText(segmentTitle) || "Selected segment";

  return {
    text: `${title} was selected as the strongest debate segment and reduced into argument moves.`,
    strongest_points: strongest.length ? strongest : ["No especially strong argument units detected."],
    weakest_points: weakest.length ? weakest : ["No especially weak argument units detected."],
    notable_problems: problems.length ? problems : ["none flagged"]
  };
}

function buildAnalysis(text, link) {
  const combined = cleanText(`${safeString(text)} ${safeString(link)}`);
  const base = makeBaseResponse();

  if (!combined) {
    return normalizeOutput(base);
  }

  const segment = chooseBestSegment(combined);
  const cleaned = removeNoise(segment.body);
  const argumentsList = extractArguments(cleaned);

  return normalizeOutput({
    structure: detectStructure(cleaned),
    topics: extractTopics(cleaned),
    worldview: extractWorldview(cleaned),
    scores: analyzeScores(cleaned),
    arguments: argumentsList,
    summary: buildSummary(argumentsList, segment.title)
  });
}

module.exports = async function handler(req, res) {
  try {
    if (!req || req.method !== "POST") {
      return sendJson(res, 200, makeBaseResponse());
    }

    const body = await readBody(req);
    const text = cleanText(body && body.text).slice(0, MAX_TEXT_LENGTH);
    const link = cleanText(body && body.link).slice(0, 5000);

    return sendJson(res, 200, buildAnalysis(text, link));
  } catch {
    return sendJson(res, 200, makeBaseResponse());
  }
};
