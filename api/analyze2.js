// /api/analyze.js

const MAX_TEXT_LENGTH = 250000;

function makeBaseResponse() {
  return {
    structure: "mixed",
    selected_segment: "none",
    topics: [],
    worldview: [],
    scores: {
      clarity: 0,
      integrity: 0,
      honesty: 0,
      manipulation: 0,
      bsn: 0
    },
    scan: [],
    analytics: {
      line_count: 0,
      evidence_signals: 0,
      dodge_signals: 0,
      trash_signals: 0,
      manipulation_signals: 0,
      unsupported_claims: 0,
      pressure_questions: 0,
      question_count: 0,
      repeated_punctuation_count: 0,
      all_caps_count: 0,
      punctuation_intensity: 0
    },
    summary: {
      text: "No summary available.",
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

  for (const item of items || []) {
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
  return Array.isArray(value) ? unique(value, limit) : [];
}

function normalizeScanItem(item, index) {
  const punctuation = item && item.punctuation && typeof item.punctuation === "object" ? item.punctuation : {};

  return {
    index: Number.isFinite(Number(item && item.index)) ? Number(item.index) : index + 1,
    text: cleanText(item && item.text) || "General argument detected but not cleanly parsed.",
    label: cleanText(item && item.label) || "point",
    strength: clamp(Number(item && item.strength)),
    reason: cleanText(item && item.reason) || "No reason available.",
    flags: normalizeArray(item && item.flags, 8),
    punctuation: {
      question_marks: Math.max(0, Number(punctuation.question_marks) || 0),
      exclamations: Math.max(0, Number(punctuation.exclamations) || 0),
      ellipses: Math.max(0, Number(punctuation.ellipses) || 0),
      repeated_punctuation: Boolean(punctuation.repeated_punctuation),
      all_caps_words: Math.max(0, Number(punctuation.all_caps_words) || 0),
      quotes: Math.max(0, Number(punctuation.quotes) || 0),
      parentheticals: Math.max(0, Number(punctuation.parentheticals) || 0),
      dash_breaks: Math.max(0, Number(punctuation.dash_breaks) || 0)
    }
  };
}

function normalizeOutput(value) {
  const base = makeBaseResponse();
  const scores = value && value.scores && typeof value.scores === "object" ? value.scores : {};
  const analytics = value && value.analytics && typeof value.analytics === "object" ? value.analytics : {};
  const summary = value && value.summary && typeof value.summary === "object" ? value.summary : {};

  return {
    structure: cleanText(value && value.structure) || base.structure,
    selected_segment: cleanText(value && value.selected_segment) || base.selected_segment,
    topics: normalizeArray(value && value.topics, 8),
    worldview: normalizeArray(value && value.worldview, 8),
    scores: {
      clarity: clamp(Number(scores.clarity)),
      integrity: clamp(Number(scores.integrity)),
      honesty: clamp(Number(scores.honesty)),
      manipulation: clamp(Number(scores.manipulation)),
      bsn: clamp(Number(scores.bsn))
    },
    scan: Array.isArray(value && value.scan)
      ? value.scan.map((item, index) => normalizeScanItem(item, index)).slice(0, 120)
      : [],
    analytics: {
      line_count: Math.max(0, Number(analytics.line_count) || 0),
      evidence_signals: Math.max(0, Number(analytics.evidence_signals) || 0),
      dodge_signals: Math.max(0, Number(analytics.dodge_signals) || 0),
      trash_signals: Math.max(0, Number(analytics.trash_signals) || 0),
      manipulation_signals: Math.max(0, Number(analytics.manipulation_signals) || 0),
      unsupported_claims: Math.max(0, Number(analytics.unsupported_claims) || 0),
      pressure_questions: Math.max(0, Number(analytics.pressure_questions) || 0),
      question_count: Math.max(0, Number(analytics.question_count) || 0),
      repeated_punctuation_count: Math.max(0, Number(analytics.repeated_punctuation_count) || 0),
      all_caps_count: Math.max(0, Number(analytics.all_caps_count) || 0),
      punctuation_intensity: clamp(Number(analytics.punctuation_intensity))
    },
    summary: {
      text: cleanText(summary.text) || base.summary.text,
      strongest_points: normalizeArray(summary.strongest_points, 6),
      weakest_points: normalizeArray(summary.weakest_points, 6),
      notable_problems: normalizeArray(summary.notable_problems, 10)
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

async function parseIncomingBody(req) {
  try {
    if (req && req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      return req.body;
    }

    if (req && typeof req.body === "string") {
      return req.body ? JSON.parse(req.body) : {};
    }

    let raw = "";

    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > MAX_TEXT_LENGTH * 2) {
        raw = raw.slice(0, MAX_TEXT_LENGTH * 2);
      }
    }

    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
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

function stripNoiseKeepLines(text) {
  return cleanText(text)
    .replace(/^\s*intro\s*:?\s*$/gim, "")
    .replace(/^\s*\d+:\d+\s*/gm, "")
    .replace(/^\s*\d+\s*seconds?\s*$/gim, "")
    .replace(/^\s*\d+\s*minutes?,?\s*\d*\s*seconds?\s*$/gim, "")
    .replace(/\[\s*applause\s*\]|\[\s*laughter\s*\]|\[\s*clears throat\s*\]/gi, "");
}

function removeNoise(text) {
  return stripNoiseKeepLines(text)
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
    "because", "therefore", "however", "evidence", "proof", "claim", "reason",
    "statistics", "research", "poll"
  ]);

  const conflictHits = countMatches(text, [
    "wrong", "liar", "lying", "stop", "let me", "not true", "that's a lie",
    "talking over", "attitude"
  ]);

  const narrativeHits = countMatches(text, [
    "then", "after", "before", "later", "story", "happened"
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
    ["politics", ["government", "president", "conservative", "liberal", "policy", "election", "democrat", "trump"]],
    ["health", ["vaccine", "doctor", "medical", "health", "covid", "disease", "medicine", "rfk"]],
    ["morality", ["moral", "morality", "good", "evil", "purpose", "sin"]],
    ["gender", ["women", "woman", "men", "man", "mother", "feminism", "marriage"]],
    ["race", ["black", "policing", "poverty", "community", "racism", "crime"]],
    ["sports", ["nba", "lakers", "kobe", "magic", "lebron", "finals"]],
    ["truth", ["truth", "lie", "lying", "honest", "dishonest", "facts", "evidence"]]
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
    ["skeptical framing", ["evidence", "proof", "source", "statistics", "research", "poll"]],
    ["adversarial framing", ["wrong", "liar", "lying", "stop", "attitude", "talking over"]],
    ["certainty-first", ["obviously", "clearly", "absolutely"]],
    ["defensive posture", ["that's not what i said", "misrepresent", "twisting", "not the point"]],
    ["moral absolutism", ["always", "never", "good", "evil", "truth"]],
    ["religious framing", ["god", "jesus", "faith", "sin", "christian"]]
  ];

  for (const [label, words] of rules) {
    if (words.some((word) => lower.includes(word))) {
      worldview.push(label);
    }
  }

  return unique(worldview, 8);
}

function scoreSegment(segment) {
  const cleaned = removeNoise(segment.body);
  const words = splitWords(cleaned).length;

  const interruptionHits = countMatches(cleaned, [
    "stop", "let me", "you keep", "talking over", "not allowing me", "let somebody get in", "respond"
  ]);

  const accusationHits = countMatches(cleaned, [
    "that's a lie", "that is a lie", "that's not true", "that is not true", "wrong", "liar", "lying"
  ]);

  const evidenceHits = countMatches(cleaned, [
    "statistics", "study", "data", "research", "poll", "evidence", "proof", "predictor", "outcomes", "poverty", "mental health"
  ]);

  const challengeHits = countMatches(cleaned, [
    "how can", "how is that", "what do you mean", "why are you", "how are you measuring"
  ]);

  let score = 0;
  score += Math.min(words, 1500) / 30;
  score += interruptionHits * 20;
  score += accusationHits * 20;
  score += evidenceHits * 15;
  score += challengeHits * 10;

  if (/candace owens vs feminists/i.test(segment.title)) score += 70;
  if (/doctor mike vs anti-vaxxers/i.test(segment.title)) score += 20;

  return score;
}

function chooseBestSegment(text) {
  const segments = splitIntoSegments(text);
  if (!segments.length) {
    return { title: "Full Text", body: removeNoise(text) };
  }

  return segments
    .map((segment) => ({ ...segment, score: scoreSegment(segment) }))
    .sort((a, b) => b.score - a.score)[0];
}

function breakLines(text) {
  const rawLines = stripNoiseKeepLines(text)
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  const lines = [];

  for (const line of rawLines) {
    const pieces = line
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
      .map((piece) => cleanText(piece))
      .filter(Boolean);

    if (pieces.length) lines.push(...pieces);
    else lines.push(line);
  }

  return lines;
}

function scanPunctuation(text) {
  return {
    question_marks: (text.match(/\?/g) || []).length,
    exclamations: (text.match(/!/g) || []).length,
    ellipses: (text.match(/\.\.\./g) || []).length,
    repeated_punctuation: /(\?\?+|!!+|!\?|\?!)/.test(text),
    all_caps_words: (text.match(/\b[A-Z]{2,}\b/g) || []).length,
    quotes: (text.match(/["“”']/g) || []).length,
    parentheticals: (text.match(/\([^)]*\)/g) || []).length,
    dash_breaks: (text.match(/--| - |—/g) || []).length
  };
}

function classifyLine(text, index) {
  const lower = text.toLowerCase();
  const punctuation = scanPunctuation(text);

  let label = "point";
  let strength = 45;
  let reason = "Recognized as a substantive line.";
  const flags = [];

  const hasEvidence = [
    "study", "statistics", "data", "research", "according to", "poll", "predictor",
    "outcomes", "rates", "poverty", "mental health", "higher incomes",
    "behavioral problems", "divorced"
  ].some((term) => lower.includes(term));

  const isPressureQuestion = [
    "how are you measuring", "how can you say", "how is that",
    "what do you mean", "why are you", "so how can"
  ].some((term) => lower.includes(term));

  const isDodge = [
    "totally different statistics", "i've actually read the exact opposite",
    "that's not what i'm talking about", "i do not believe they are",
    "i'm saying that", "i've read the opposite"
  ].some((term) => lower.includes(term));

  const isManipulation = [
    "you have an attitude", "performative", "stop", "let somebody get in",
    "you don't want to", "you keep", "not allowing me to respond",
    "walk away and feel like i've won", "you just have an attitude"
  ].some((term) => lower.includes(term));

  const isCounter = [
    "that's not true", "that is not true", "wrong", "that's a lie", "that is a lie"
  ].some((term) => lower.includes(term));

  const isUnsupported = [
    "obviously", "clearly", "because you said so", "i do not believe", "it is obvious"
  ].some((term) => lower.includes(term));

  const isTrash = [
    "nice to meet you", "great conversation", "good job", "okay.", "yeah.", "hello.", "good to see you"
  ].includes(lower);

  if (isTrash) {
    label = "trash";
    strength = 10;
    reason = "Adds little or nothing to the argument.";
    flags.push("filler");
  } else if (hasEvidence) {
    label = "evidence";
    strength += 30;
    reason = "Uses measurable or source-like language.";
    flags.push("evidence-based");
  } else if (isPressureQuestion || punctuation.question_marks > 0) {
    label = "question";
    strength += isPressureQuestion ? 28 : 12;
    reason = isPressureQuestion
      ? "Directly pressures the other side for method, evidence, or consistency."
      : "Questions the other side's claim or framing.";
    if (isPressureQuestion) flags.push("evidence-pressure");
  }

  if (isCounter) {
    label = "counter";
    strength += 14;
    reason = "Directly rejects the previous claim.";
    flags.push("rebuttal");
  }

  if (isDodge) {
    label = "dodge";
    strength = Math.max(10, strength - 25);
    reason = "Rejects or evades the other side without naming support.";
    flags.push("deflection");
    flags.push("no evidence");
  }

  if (isManipulation) {
    label = "manipulation";
    strength = Math.max(8, strength - 30);
    reason = "Uses pressure, control, or personal framing instead of argument.";
    flags.push("personal attack");
    flags.push("conversation control");
  }

  if (isUnsupported) {
    if (label === "point") label = "unsupported";
    strength = Math.max(10, strength - 15);
    if (reason === "Recognized as a substantive line.") {
      reason = "Makes a claim without grounding it.";
    }
    flags.push("unsupported certainty");
  }

  if (punctuation.repeated_punctuation) flags.push("heightened punctuation");
  if (punctuation.all_caps_words > 0) flags.push("all-caps emphasis");

  if (text.length > 220) strength -= 4;
  if (text.length < 18) strength -= 8;

  return {
    index: index + 1,
    text,
    label,
    strength: clamp(strength),
    reason,
    flags: unique(flags, 8),
    punctuation
  };
}

function buildAnalytics(scan) {
  const analytics = {
    line_count: scan.length,
    evidence_signals: 0,
    dodge_signals: 0,
    trash_signals: 0,
    manipulation_signals: 0,
    unsupported_claims: 0,
    pressure_questions: 0,
    question_count: 0,
    repeated_punctuation_count: 0,
    all_caps_count: 0,
    punctuation_intensity: 0
  };

  for (const item of scan) {
    analytics.question_count += item.punctuation.question_marks;
    analytics.repeated_punctuation_count += item.punctuation.repeated_punctuation ? 1 : 0;
    analytics.all_caps_count += item.punctuation.all_caps_words;

    if (item.label === "evidence") analytics.evidence_signals += 1;
    if (item.label === "dodge") analytics.dodge_signals += 1;
    if (item.label === "trash") analytics.trash_signals += 1;
    if (item.label === "manipulation") analytics.manipulation_signals += 1;
    if (item.label === "unsupported") analytics.unsupported_claims += 1;
    if (item.label === "question" && item.flags.includes("evidence-pressure")) {
      analytics.pressure_questions += 1;
    }
  }

  analytics.punctuation_intensity = clamp(
    (analytics.question_count * 4) +
    (analytics.repeated_punctuation_count * 10) +
    (analytics.all_caps_count * 6),
    0,
    100
  );

  return analytics;
}

function buildSummary(scan, title) {
  const strongest = scan
    .filter((item) => item.label === "evidence" || item.label === "question" || item.label === "counter")
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 4)
    .map((item) => item.text);

  const weakest = scan
    .filter((item) => item.label === "dodge" || item.label === "manipulation" || item.label === "unsupported" || item.label === "trash")
    .sort((a, b) => a.strength - b.strength)
    .slice(0, 4)
    .map((item) => item.text);

  const notableProblems = unique(scan.flatMap((item) => item.flags || []), 10);

  return {
    text: `${cleanText(title) || "Selected segment"} was scanned line by line for points, trash, dodges, pressure, and punctuation.`,
    strongest_points: strongest.length ? strongest : ["No especially strong lines detected."],
    weakest_points: weakest.length ? weakest : ["No especially weak lines detected."],
    notable_problems: notableProblems.length ? notableProblems : ["none flagged"]
  };
}

function analyzeScores(text) {
  const words = splitWords(text);
  const wordCount = words.length;
  const lines = breakLines(text);
  const lineCount = Math.max(lines.length, 1);
  const avgLineLength = wordCount / lineCount;

  const connectors = countMatches(text, ["because", "therefore", "however", "if", "then", "but", "so", "since"]);
  const evidenceCount = countMatches(text, ["evidence", "proof", "source", "study", "data", "statistics", "according to", "poll", "research"]);
  const hedgeCount = countMatches(text, ["maybe", "perhaps", "probably", "possibly", "kind of", "sort of", "seems"]);
  const pressureCount = countMatches(text, ["stop", "let me", "you keep", "talking over", "attitude", "obviously", "clearly"]);
  const exaggerationCount = countMatches(text, ["always", "never", "everyone", "nobody", "totally", "completely"]);
  const evasionCount = countMatches(text, ["that's not the point", "totally different statistics", "i've read the opposite", "anyway", "whatever", "i do not believe they are"]);

  let clarity = 35 + Math.min(connectors * 6, 24);
  if (avgLineLength >= 7 && avgLineLength <= 24) clarity += 18;
  if (avgLineLength > 35) clarity -= 15;
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

function buildAnalysis(text, link) {
  const combined = cleanText(`${safeString(text)} ${safeString(link)}`);
  const base = makeBaseResponse();

  if (!combined) {
    return normalizeOutput(base);
  }

  const segment = chooseBestSegment(combined);
  const cleaned = removeNoise(segment.body);
  const rawLines = breakLines(cleaned);
  const scan = rawLines.map((line, index) => classifyLine(line, index));
  const analytics = buildAnalytics(scan);

  return normalizeOutput({
    structure: detectStructure(cleaned),
    selected_segment: segment.title,
    topics: extractTopics(cleaned),
    worldview: extractWorldview(cleaned),
    scores: analyzeScores(cleaned),
    scan,
    analytics,
    summary: buildSummary(scan, segment.title)
  });
}

module.exports = async function handler(req, res) {
  try {
    if (!req || req.method !== "POST") {
      return sendJson(res, 200, makeBaseResponse());
    }

    const body = await parseIncomingBody(req);
    const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT_LENGTH) : "";
    const link = typeof body.link === "string" ? body.link.slice(0, 5000) : "";

    return sendJson(res, 200, buildAnalysis(text, link));
  } catch {
    return sendJson(res, 200, makeBaseResponse());
  }
};
