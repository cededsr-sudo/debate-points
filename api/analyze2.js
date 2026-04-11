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
    debate: {
      summary: "No analysis available.",
      honestSide: "unclear",
      dishonestSide: "unclear",
      participants: [
        {
          name: "Speaker A",
          honesty: 0,
          lying: 0,
          points: [],
          weaknesses: []
        },
        {
          name: "Speaker B",
          honesty: 0,
          lying: 0,
          points: [],
          weaknesses: []
        }
      ]
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
  return safeString(value).replace(/\u0000/g, "").trim();
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
  return unique(Array.isArray(value) ? value : [], limit);
}

function normalizeParticipant(value, fallbackName) {
  const points = normalizeArray(value && value.points, 5);
  const weaknesses = normalizeArray(value && value.weaknesses, 5);

  return {
    name: cleanText(value && value.name) || fallbackName,
    honesty: clamp(Number(value && value.honesty)),
    lying: clamp(Number(value && value.lying)),
    points,
    weaknesses
  };
}

function normalizeOutput(value) {
  const base = makeBaseResponse();
  const scores = value && value.scores && typeof value.scores === "object" ? value.scores : {};
  const debate = value && value.debate && typeof value.debate === "object" ? value.debate : {};

  const rawParticipants = Array.isArray(debate.participants) ? debate.participants : base.debate.participants;

  const participants = [
    normalizeParticipant(rawParticipants[0], "Speaker A"),
    normalizeParticipant(rawParticipants[1], "Speaker B")
  ];

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
    debate: {
      summary: cleanText(debate.summary) || base.debate.summary,
      honestSide: cleanText(debate.honestSide) || "unclear",
      dishonestSide: cleanText(debate.dishonestSide) || "unclear",
      participants
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

function detectStructure(text) {
  if (!text) return "mixed";

  const argumentHits = countMatches(text, [
    "because", "therefore", "however", "evidence", "proof", "claim", "point", "reason", "why"
  ]);
  const conflictHits = countMatches(text, [
    "liar", "lying", "wrong", "stupid", "idiot", "bullshit", "dishonest"
  ]);
  const narrativeHits = countMatches(text, [
    "then", "after", "before", "later", "when", "happened", "story"
  ]);

  if (argumentHits >= 4) return "argument";
  if (conflictHits >= 3) return "conflict";
  if (narrativeHits >= 4) return "narrative";
  return "mixed";
}

function extractTopics(text) {
  const lower = text.toLowerCase();
  const topics = [];

  const rules = [
    ["religion", ["god", "jesus", "bible", "church", "atheist", "christian", "faith"]],
    ["politics", ["government", "president", "conservative", "liberal", "policy", "election"]],
    ["health", ["vaccine", "doctor", "medical", "health", "covid", "disease", "medicine"]],
    ["morality", ["moral", "morality", "good", "evil", "purpose", "sin"]],
    ["gender", ["women", "woman", "men", "man", "mother", "feminism", "marriage"]],
    ["race", ["black", "policing", "poverty", "community", "racism"]],
    ["sports", ["nba", "lakers", "kobe", "magic", "lebron", "finals"]],
    ["truth", ["truth", "lie", "lying", "honest", "dishonest", "facts", "evidence"]],
    ["technology", ["api", "backend", "frontend", "server", "code", "app"]],
    ["education", ["school", "college", "student", "teacher", "educated"]]
  ];

  for (const [label, tokens] of rules) {
    if (tokens.some((token) => lower.includes(token))) {
      topics.push(label);
    }
  }

  if (topics.length) return unique(topics, 8);

  const common = new Set([
    "about", "after", "again", "because", "before", "being", "could", "every",
    "other", "people", "really", "should", "their", "there", "these", "thing",
    "think", "those", "where", "which", "would"
  ]);

  return unique(
    splitWords(text).filter((word) => word.length >= 5 && !common.has(word)).slice(0, 8),
    8
  );
}

function extractWorldview(text) {
  const lower = text.toLowerCase();
  const worldview = [];

  const rules = [
    ["religious framing", ["god", "jesus", "bible", "faith", "sin", "christian"]],
    ["skeptical framing", ["evidence", "proof", "source", "statistics", "fact check"]],
    ["adversarial framing", ["wrong", "liar", "lying", "bullshit", "dishonest"]],
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

function analyzeOverallScores(text) {
  const words = splitWords(text);
  const wordCount = words.length;
  const sentences = (text.match(/[^.!?\n]+[.!?]?/g) || []).map((s) => s.trim()).filter(Boolean);
  const sentenceCount = Math.max(sentences.length, 1);
  const avgSentenceLength = wordCount / sentenceCount;

  const connectors = countMatches(text, [
    "because", "therefore", "however", "for example", "if", "then", "but", "so", "since"
  ]);
  const evidenceCount = countMatches(text, [
    "evidence", "proof", "source", "study", "data", "statistics", "according to", "poll"
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
    "whatever", "never mind", "that's not the point", "anyway", "stop twisting"
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
  manipulation += Math.min(countMatches(text, ["you need to", "you have to", "obviously", "clearly"]) * 8, 24);

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

function parseTranscript(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+[:.]\d+/.test(line))
    .filter((line) => !/^chapter\s+\d+/i.test(line));

  const turns = [];
  const speakerRegex = /^([A-Za-z][A-Za-z0-9 '&._-]{0,40}):\s*(.+)$/;

  for (const line of lines) {
    const match = line.match(speakerRegex);

    if (match) {
      turns.push({
        speaker: cleanText(match[1]),
        text: cleanText(match[2])
      });
      continue;
    }

    if (turns.length === 0) {
      turns.push({ speaker: "Speaker A", text: line });
      continue;
    }

    const last = turns[turns.length - 1];
    if (last.text.length < 600) {
      last.text += ` ${line}`;
    } else {
      turns.push({
        speaker: turns.length % 2 === 0 ? "Speaker A" : "Speaker B",
        text: line
      });
    }
  }

  if (turns.length === 1) {
    const chunks = text
      .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (chunks.length >= 2) {
      return chunks.slice(0, 12).map((chunk, index) => ({
        speaker: index % 2 === 0 ? "Speaker A" : "Speaker B",
        text: chunk
      }));
    }
  }

  return turns.slice(0, 40);
}

function buildPoints(segmentText) {
  const sentences = (segmentText.match(/[^.!?\n]+[.!?]?/g) || [])
    .map((s) => s.trim())
    .filter(Boolean);

  const candidates = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    return (
      lower.includes("because") ||
      lower.includes("evidence") ||
      lower.includes("data") ||
      lower.includes("statistics") ||
      lower.includes("my point") ||
      lower.includes("i think") ||
      lower.includes("the point") ||
      lower.includes("means") ||
      lower.includes("shows")
    );
  });

  const picked = candidates.length ? candidates : sentences;
  return unique(
    picked
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter((sentence) => sentence.length >= 20)
      .map((sentence) => sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence),
    4
  );
}

function buildWeaknesses(segmentText) {
  const weaknesses = [];
  const lower = segmentText.toLowerCase();

  if (countMatches(segmentText, ["idiot", "stupid", "bullshit", "liar", "moron", "bitch"]) > 0) {
    weaknesses.push("Uses insults instead of clean reasoning.");
  }

  if (countMatches(segmentText, ["always", "never", "everyone", "nobody", "obviously", "clearly"]) > 1) {
    weaknesses.push("Leans on exaggeration or certainty language.");
  }

  if (countMatches(segmentText, ["maybe", "perhaps", "probably", "kind of", "sort of"]) > 1) {
    weaknesses.push("Sounds hedged or unsure.");
  }

  if (countMatches(segmentText, ["evidence", "data", "study", "statistics", "source", "proof"]) === 0) {
    weaknesses.push("Makes claims without grounding them in evidence.");
  }

  if (countMatches(segmentText, ["whatever", "never mind", "that's not the point", "anyway"]) > 0) {
    weaknesses.push("Shows signs of evasion.");
  }

  if (lower.includes("always") && lower.includes("never")) {
    weaknesses.push("Contains contradiction signals.");
  }

  if (weaknesses.length === 0) {
    weaknesses.push("Could be more specific and better supported.");
  }

  return unique(weaknesses, 4);
}

function analyzeSpeaker(name, text) {
  const overall = analyzeOverallScores(text);

  const honesty = clamp((overall.honesty + overall.integrity + overall.clarity) / 3);
  const lying = clamp((overall.manipulation + overall.bsn + (100 - overall.integrity)) / 3);

  return {
    name,
    honesty,
    lying,
    points: buildPoints(text),
    weaknesses: buildWeaknesses(text)
  };
}

function analyzeDebate(text) {
  const turns = parseTranscript(text);

  if (!turns.length) {
    return makeBaseResponse().debate;
  }

  const speakerMap = new Map();

  for (const turn of turns) {
    const speaker = cleanText(turn.speaker) || `Speaker ${speakerMap.size + 1}`;
    const existing = speakerMap.get(speaker) || [];
    existing.push(cleanText(turn.text));
    speakerMap.set(speaker, existing);
  }

  let participants = Array.from(speakerMap.entries()).map(([name, parts]) => {
    return analyzeSpeaker(name, parts.join(" "));
  });

  if (participants.length === 1) {
    participants.push(
      normalizeParticipant(
        {
          name: "Speaker B",
          honesty: 0,
          lying: 0,
          points: [],
          weaknesses: ["No second speaker was clearly detected."]
        },
        "Speaker B"
      )
    );
  }

  if (participants.length > 2) {
    participants = participants
      .sort((a, b) => (b.points.length + b.honesty) - (a.points.length + a.honesty))
      .slice(0, 2);
  }

  const a = participants[0];
  const b = participants[1];

  let honestSide = "unclear";
  let dishonestSide = "unclear";

  if (a.honesty > b.honesty + 8) {
    honestSide = a.name;
    dishonestSide = b.name;
  } else if (b.honesty > a.honesty + 8) {
    honestSide = b.name;
    dishonestSide = a.name;
  }

  const summary =
    honestSide === "unclear"
      ? "Both sides show mixed honesty. One or both make weak or unsupported moves."
      : `${honestSide} comes across as more honest and grounded. ${dishonestSide} shows more manipulation, exaggeration, or weak support.`;

  return {
    summary,
    honestSide,
    dishonestSide,
    participants: [a, b]
  };
}

function buildAnalysis(text, link) {
  const combined = `${cleanText(text)} ${cleanText(link)}`.trim();
  const base = makeBaseResponse();

  if (!combined) {
    return normalizeOutput(base);
  }

  return normalizeOutput({
    structure: detectStructure(combined),
    topics: extractTopics(combined),
    worldview: extractWorldview(combined),
    scores: analyzeOverallScores(combined),
    debate: analyzeDebate(combined)
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
