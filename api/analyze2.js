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
    type: cleanText(arg && arg.type) || "argument",
    text: cleanText(arg && arg.text) || "General argument detected but not cleanly parsed.",
    strength: clamp(Number(arg && arg.strength)),
    issues: normalizeArray(arg && arg.issues, 5)
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
      notable_problems: normalizeArray(summary.notable_problems, 6)
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

function splitWords(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter(Boolean);
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

function removeNoise(text) {
  return cleanText(text)
    .replace(/^\s*intro\s*:?/gim, "")
    .replace(/^\s*chapter\s+\d+\s*:\s*/gim, "")
    .replace(/^\s*\d+:\d+\s*/gm, "")
    .replace(/^\s*\d+\s*seconds?\s*/gim, "")
    .replace(/^\s*\d+\s*minutes?,?\s*\d*\s*seconds?\s*/gim, "")
    .replace(/\[\s*applause\s*\]|\[\s*laughter\s*\]|\[\s*clears throat\s*\]/gi, " ")
    .replace(/[^\x00-\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectStructure(text) {
  if (!text) return "mixed";

  const argumentHits = countMatches(text, [
    "because", "therefore", "however", "evidence", "proof", "claim", "point", "reason", "why", "statistics"
  ]);
  const conflictHits = countMatches(text, [
    "liar", "lying", "wrong", "stupid", "idiot", "bullshit", "dishonest", "stop", "let me", "not true"
  ]);
  const narrativeHits = countMatches(text, [
    "then", "after", "before", "later", "when", "happened", "story"
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

  for (const [label, tokens] of rules) {
    if (tokens.some((token) => lower.includes(token))) {
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
    ["skeptical framing", ["evidence", "proof", "source", "statistics", "fact check", "research"]],
    ["adversarial framing", ["wrong", "liar", "lying", "bullshit", "dishonest", "stop"]],
    ["certainty-first", ["obviously", "clearly", "absolutely", "everyone knows"]],
    ["defensive posture", ["that's not what i said", "stop", "misrepresent", "twisting"]],
    ["moral absolutism", ["always", "never", "good", "evil", "truth"]],
    ["political framing", ["conservative", "liberal", "fascist", "left", "right"]]
  ];

  for (const [label, tokens] of rules) {
    if (tokens.some((token) => lower.includes(token))) worldview.push(label);
  }

  return unique(worldview, 8);
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
  const insultCount = countMatches(text, [
    "idiot", "stupid", "moron", "bitch", "bullshit", "trash", "worthless", "liar"
  ]);
  const exaggerationCount = countMatches(text, [
    "always", "never", "everyone", "nobody", "obviously", "clearly", "totally", "completely"
  ]);
  const evasionCount = countMatches(text, [
    "whatever", "never mind", "that's not the point", "anyway", "stop twisting", "totally different statistics"
  ]);

  const contradictionPenalty =
    (text.toLowerCase().includes("always") && text.toLowerCase().includes("never") ? 18 : 0) +
    (text.toLowerCase().includes("everyone") && text.toLowerCase().includes("nobody") ? 18 : 0);

  let clarity = 35 + Math.min(connectors * 6, 24);
  if (avgSentenceLength >= 7 && avgSentenceLength <= 24) clarity += 18;
  if (avgSentenceLength > 35) clarity -= 15;
  if (wordCount < 8) clarity -= 20;
  clarity -= Math.min(insultCount * 3, 15);

  let integrity = 45 + Math.min(evidenceCount * 8, 32);
  integrity -= Math.min(insultCount * 6, 30);
  integrity -= Math.min(exaggerationCount * 4, 20);

  let honesty = 50;
  honesty += Math.min(countMatches(text, ["i think", "i believe", "my point", "i am saying"]) * 5, 20);
  honesty -= Math.min(hedgeCount * 5, 25);
  honesty -= Math.min(evasionCount * 8, 24);

  let manipulation = 10 + Math.min(insultCount * 10, 45);
  manipulation += Math.min(exaggerationCount * 6, 24);
  manipulation += Math.min(countMatches(text, ["you need to", "you have to", "obviously", "clearly", "stop", "attitude"]) * 8, 24);

  let bsn = 15 + contradictionPenalty + Math.min(evasionCount * 10, 30) + Math.min(exaggerationCount * 5, 20);
  if (evidenceCount === 0 && connectors === 0 && wordCount > 20) bsn += 15;

  return {
    clarity: clamp(clarity),
    integrity: clamp(integrity),
    honesty: clamp(honesty),
    manipulation: clamp(manipulation),
    bsn: clamp(bsn)
  };
}

function splitIntoSegments(rawText) {
  const text = cleanText(rawText);
  if (!text) return [];

  const chapterRegex = /chapter\s+\d+\s*:\s*([^\n]+)/gi;
  const matches = [...text.matchAll(chapterRegex)];

  if (!matches.length) return [text];

  const segments = [];

  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index || 0;
    const end = i + 1 < matches.length ? matches[i + 1].index || text.length : text.length;
    const chunk = text.slice(start, end).trim();
    if (chunk) segments.push(chunk);
  }

  return segments;
}

function chooseBestSegment(text) {
  const segments = splitIntoSegments(text);
  if (!segments.length) return text;

  const scored = segments.map((segment) => {
    const cleaned = removeNoise(segment);
    const words = splitWords(cleaned).length;

    const interruptionHits = countMatches(cleaned, [
      "stop", "let me", "you're not", "you keep", "you're saying", "you said", "let me finish", "not letting me"
    ]);

    const accusationHits = countMatches(cleaned, [
      "that's a lie", "that is a lie", "that's not true", "that is not true", "wrong", "you are lying", "liar"
    ]);

    const overlapHits = countMatches(cleaned, [
      "talking over", "interrupt", "you have not let", "not allowing me", "respond"
    ]);

    const evidenceHits = countMatches(cleaned, [
      "because", "evidence", "data", "study", "statistics", "proof", "research", "poll"
    ]);

    let score = 0;
    score += Math.min(words, 1200) / 25;
    score += interruptionHits * 15;
    score += accusationHits * 18;
    score += overlapHits * 20;
    score += evidenceHits * 3;

    if (interruptionHits === 0 && accusationHits === 0) {
      score -= 25;
    }

    return { segment, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].segment;
}

function splitSentences(text) {
  return removeNoise(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => cleanText(s))
    .filter(Boolean);
}

function classifyArgument(sentence) {
  const lower = sentence.toLowerCase();
  const issues = [];
  let type = "claim";
  let strength = 45;

  if (
    lower.includes("study") ||
    lower.includes("statistics") ||
    lower.includes("data") ||
    lower.includes("research") ||
    lower.includes("according to") ||
    lower.includes("poll")
  ) {
    type = "evidence";
    strength += 25;
  }

  if (
    lower.includes("how can") ||
    lower.includes("what do you mean") ||
    lower.includes("how is that") ||
    lower.includes("why are you")
  ) {
    type = "challenge";
    strength += 8;
  }

  if (
    lower.includes("that's not true") ||
    lower.includes("that is not true") ||
    lower.includes("wrong") ||
    lower.includes("that's a lie") ||
    lower.includes("that is a lie")
  ) {
    type = "counterpoint";
    strength += 10;
    issues.push("accusation");
  }

  if (
    lower.includes("totally different statistics") ||
    lower.includes("i've read the opposite") ||
    lower.includes("that's not the point") ||
    lower.includes("anyway")
  ) {
    type = "dodge";
    strength -= 15;
    issues.push("non-answer");
  }

  if (
    lower.includes("obviously") ||
    lower.includes("clearly") ||
    lower.includes("everyone knows")
  ) {
    issues.push("unsupported certainty");
    strength -= 8;
  }

  if (
    lower.includes("you have an attitude") ||
    lower.includes("performative") ||
    lower.includes("you just") ||
    lower.includes("stop")
  ) {
    type = "manipulation";
    issues.push("pressure tactic");
    strength -= 10;
  }

  if (
    lower.includes("i do not believe") ||
    lower.includes("i've read the exact opposite") ||
    lower.includes("i'm saying")
  ) {
    issues.push("unsupported assertion");
    strength -= 6;
  }

  if (
    lower.includes("because") ||
    lower.includes("therefore") ||
    lower.includes("which means") ||
    lower.includes("so how can")
  ) {
    strength += 8;
  }

  if (sentence.length > 180) strength -= 4;
  if (sentence.length < 24) strength -= 10;

  return {
    type,
    text: sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence,
    strength: clamp(strength),
    issues: unique(issues, 5)
  };
}

function extractArguments(text) {
  const sentences = splitSentences(text);

  const candidates = sentences
    .filter((sentence) => sentence.length >= 20)
    .map(classifyArgument)
    .sort((a, b) => b.strength - a.strength);

  if (!candidates.length) {
    return [{
      type: "argument",
      text: "General argument detected but not cleanly parsed.",
      strength: 25,
      issues: ["low parse confidence"]
    }];
  }

  return candidates.slice(0, 10);
}

function buildSummary(argumentsList) {
  const strongest = argumentsList
    .filter((item) => item.strength >= 65)
    .slice(0, 3)
    .map((item) => item.text);

  const weakest = argumentsList
    .filter((item) => item.issues.length > 0 || item.strength <= 40)
    .slice(0, 3)
    .map((item) => item.text);

  const problems = unique(
    argumentsList.flatMap((item) => item.issues || []),
    6
  );

  return {
    text: strongest.length
      ? "Argument extraction completed. Stronger points and weaker moves were separated."
      : "Argument extraction completed with limited confidence.",
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

  const focusedSegment = chooseBestSegment(combined) || combined;
  const cleaned = removeNoise(focusedSegment);
  const argumentsList = extractArguments(cleaned);

  return normalizeOutput({
    structure: detectStructure(cleaned),
    topics: extractTopics(cleaned),
    worldview: extractWorldview(cleaned),
    scores: analyzeScores(cleaned),
    arguments: argumentsList,
    summary: buildSummary(argumentsList)
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
