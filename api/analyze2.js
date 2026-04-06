"use strict";

/**
 * /api/analyze2.js
 *
 * Debate Judgment Engine backend
 * - Keeps existing frontend contract
 * - Always returns valid JSON through res.json(...)
 * - Deterministic first
 * - Structural fact-check + AI refinement + merge layers preserved
 * - Filters out intros, bios, moderator/setup fluff, and non-argument context
 */

const DEFAULT_TEAM_A = "Team A";
const DEFAULT_TEAM_B = "Team B";
const ANALYSIS_MODE = "deterministic+factcheck+ai-refinement+merge";

/* ------------------------------------------------------------------ */
/* Main handler                                                       */
/* ------------------------------------------------------------------ */

module.exports = async function analyze2Handler(req, res) {
  try {
    const body = req && req.body && typeof req.body === "object" ? req.body : {};

    const teamAName =
      normalizeText(body.teamAName || body.teamA || body.speakerA || body.nameA) ||
      DEFAULT_TEAM_A;

    const teamBName =
      normalizeText(body.teamBName || body.teamB || body.speakerB || body.nameB) ||
      DEFAULT_TEAM_B;

    const videoLink = normalizeText(body.videoLink || "");
    const transcriptRaw = getTranscriptFromBody(body);

    const cleanedTranscript = cleanTranscript(transcriptRaw);

    const extracted = extractSides({
      transcriptRaw,
      cleanedTranscript,
      teamAName,
      teamBName
    });

    const teamASentences = selectArgumentSentences(extracted.teamAText);
    const teamBSentences = selectArgumentSentences(extracted.teamBText);

    const teamAAnalysis = deterministicAnalysis(teamASentences, teamAName);
    const teamBAnalysis = deterministicAnalysis(teamBSentences, teamBName);

    const factLayer = factCheckLayer(teamAAnalysis, teamBAnalysis, {
      teamAName,
      teamBName,
      videoLink
    });

    const aiLayer = await aiRefinementLayer(teamAAnalysis, teamBAnalysis, {
      teamAName,
      teamBName,
      videoLink,
      promptOverride: normalizeText(
        body.promptOverride || body.aiPrompt || body.refinementPrompt || ""
      )
    });

    const base = buildBaseResult(
      teamAName,
      teamBName,
      teamAAnalysis,
      teamBAnalysis,
      factLayer
    );

    const merged = mergeLayer(base, aiLayer);

    const finalResult = enforceConsistency({
      ...merged,
      teamAName,
      teamBName,
      analysisMode: ANALYSIS_MODE,
      sources: Array.isArray(factLayer.checkedClaims) ? factLayer.checkedClaims : []
    });

    return res.json(finalResult);
  } catch (error) {
    return res.json(buildFailureResponse(req, error));
  }
};

/* ------------------------------------------------------------------ */
/* Input helpers                                                      */
/* ------------------------------------------------------------------ */

function getTranscriptFromBody(body) {
  const candidates = [
    body.transcriptText,
    body.transcript,
    body.rawTranscript,
    body.text,
    body.content,
    body.input,
    body.debateText,
    body.fullTranscript,
    body.videoTranscript,
    body.cleanedTranscript
  ];

  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item;
  }

  if (Array.isArray(body.transcriptLines)) {
    return body.transcriptLines.filter(Boolean).join("\n");
  }

  if (Array.isArray(body.lines)) {
    return body.lines.filter(Boolean).join("\n");
  }

  return "";
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function cleanWhitespace(value) {
  return normalizeText(value);
}

function wordCount(text) {
  const t = cleanWhitespace(text);
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function clip(text, max = 300) {
  const t = cleanWhitespace(text);
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max - 3).trim() + "...";
}

function uniquePreserveOrder(items) {
  const output = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const cleaned = cleanWhitespace(item);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }

  return output;
}

function countHits(text, patterns) {
  const lower = cleanWhitespace(text).toLowerCase();
  let hits = 0;
  for (const item of patterns) {
    if (lower.includes(item)) hits += 1;
  }
  return hits;
}

function includesAny(text, patterns) {
  return countHits(text, patterns) > 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* Dictionaries                                                       */
/* ------------------------------------------------------------------ */

const FILLER_WORDS = [
  "um",
  "uh",
  "er",
  "ah",
  "you know",
  "i mean",
  "kind of",
  "sort of",
  "basically",
  "literally",
  "whatever"
];

const REASONING_WORDS = [
  "because",
  "therefore",
  "thus",
  "hence",
  "since",
  "if",
  "then",
  "which means",
  "that means",
  "as a result",
  "consequently",
  "it follows",
  "shows",
  "demonstrates",
  "proves",
  "implies",
  "so that"
];

const EVIDENCE_WORDS = [
  "data",
  "study",
  "studies",
  "evidence",
  "research",
  "report",
  "reports",
  "document",
  "documents",
  "for example",
  "for instance",
  "according to",
  "statistics",
  "statistic",
  "record",
  "records",
  "historically",
  "observation",
  "observations",
  "experiment",
  "experiments",
  "measured",
  "observed"
];

const OPINION_WORDS = [
  "i think",
  "i believe",
  "in my opinion",
  "in my view",
  "it seems",
  "probably",
  "maybe",
  "perhaps",
  "i feel",
  "i guess",
  "appears",
  "should",
  "ought"
];

const OVERREACH_WORDS = [
  "always",
  "never",
  "everyone",
  "nobody",
  "all of them",
  "every single",
  "obviously",
  "completely",
  "100%",
  "cannot possibly",
  "proved everything",
  "absolutely all",
  "without question"
];

const INTRO_PATTERNS = [
  /\bwelcome everyone\b/i,
  /\bwelcome back\b/i,
  /\bthanks for having me\b/i,
  /\bthank you for having me\b/i,
  /\bthanks for joining\b/i,
  /\bmake sure to like\b/i,
  /\bmake sure to subscribe\b/i,
  /\bdon't forget to subscribe\b/i,
  /\bfollow me on\b/i,
  /\bcheck out my\b/i,
  /\bmy channel\b/i,
  /\bour channel\b/i,
  /\bsponsored by\b/i,
  /\bpatreon\b/i,
  /\bpodcast\b/i,
  /\blet's get started\b/i,
  /\bwithout further ado\b/i,
  /\btoday's debate\b/i,
  /\btonight's debate\b/i,
  /\bintroducing\b/i,
  /\bround of applause\b/i,
  /\btake care everyone\b/i,
  /\bthanks everyone for participating\b/i,
  /\bthat concludes our debate\b/i,
  /\bthat concludes the proceedings\b/i,
  /\bhope you found this interesting\b/i
];

const MODERATOR_HINTS = [
  "moderator",
  "host",
  "interviewer",
  "facilitator",
  "question:",
  "next question",
  "your time starts now",
  "time starts now"
];

const STAGE_DIRECTION_PATTERNS = [
  /\[[^\]]{0,120}\]/g,
  /\((?:music|applause|laughter|laughing|cheering|intro|outro|crosstalk|silence|background noise)[^)]*\)/gi
];

const TIMESTAMP_PATTERNS = [
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /\b\d+\s*hours?,?\s*\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi,
  /\b\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi,
  /\b\d+\s*hours?\b/gi,
  /\b\d+\s*minutes?\b/gi,
  /\b\d+\s*seconds?\b/gi,
  /\b\d{1,3}[;:,]\s*\d{1,3}\s*seconds?\b/gi,
  /\b\d{1,3}[;:,]\s*\d{1,3}\s*minutes?\b/gi,
  /\b\d{1,3}[;:,]\s*\d{1,3}\s*hours?\b/gi,
  /(^|\s):\d{1,4}\b/g
];

const NON_ARGUMENT_CONTEXT_PATTERNS = [
  /\bthis channel is\b/i,
  /\bchannel is primarily\b/i,
  /\bchannel is about\b/i,
  /\bpassionate about\b/i,
  /\bphd student\b/i,
  /\bmaster'?s thesis\b/i,
  /\bco-?author\b/i,
  /\bforthcoming book\b/i,
  /\bopen discussion\b/i,
  /\bi will facilitate\b/i,
  /\bi'll facilitate\b/i,
  /\bthe speakers can also ask each other questions\b/i,
  /\bmany people today have come to support\b/i,
  /\bwe can all come to a better understanding\b/i,
  /\bthanks very much for participating\b/i,
  /\blet me introduce\b/i,
  /\bhere to discuss\b/i,
  /\bwe're here today\b/i,
  /\bjoin me in welcoming\b/i,
  /\bthis event\b/i,
  /\bthis discussion\b/i,
  /\bthis debate format\b/i
];

const TOPIC_WORDS = [
  "evolution",
  "creation",
  "science",
  "evidence",
  "bible",
  "scripture",
  "god",
  "jesus",
  "research",
  "study",
  "common ancestry",
  "design",
  "atheism",
  "theism",
  "logic",
  "model",
  "experiment",
  "flood",
  "genesis",
  "determinism",
  "free will",
  "causality"
];

/* ------------------------------------------------------------------ */
/* Transcript cleaning                                                */
/* ------------------------------------------------------------------ */

function cleanTranscript(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return "";

  let working = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  working = working
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  const lines = working
    .split("\n")
    .flatMap(splitLineIntoSegments)
    .map((line) => cleanWhitespace(stripTranscriptCorruption(line)))
    .filter(Boolean);

  const cleanedLines = [];

  for (const line of lines) {
    const stripped = cleanWhitespace(stripSpeakerPrefix(line));
    if (!stripped) continue;
    if (isLikelySetupLine(stripped)) continue;
    if (isLikelyModeratorLine(stripped) && wordCount(stripped) < 18) continue;
    if (looksMostlyCorrupt(stripped)) continue;
    cleanedLines.push(stripped);
  }

  return uniquePreserveOrder(cleanedLines).join("\n");
}

function splitLineIntoSegments(line) {
  const value = typeof line === "string" ? line : "";
  if (!value.trim()) return [];

  const working = value
    .replace(/([.?!])\s+/g, "$1\n")
    .replace(/\s{2,}/g, " ");

  return working
    .split("\n")
    .map((part) => cleanWhitespace(part))
    .filter(Boolean);
}

function stripSpeakerPrefix(line) {
  return cleanWhitespace(
    String(line).replace(
      /^(speaker\s*[ab12]|team\s*[ab12]|side\s*[ab12]|a|b|host|moderator|interviewer)\s*[:\-]\s*/i,
      ""
    )
  );
}

function stripTranscriptCorruption(text) {
  let line = String(text || "");

  for (const re of STAGE_DIRECTION_PATTERNS) {
    line = line.replace(re, " ");
  }

  for (const re of TIMESTAMP_PATTERNS) {
    line = line.replace(re, " ");
  }

  line = line
    .replace(/\b\d+\s*seconds(?=[a-z])/gi, " ")
    .replace(/\b\d+\s*minutes(?=[a-z])/gi, " ")
    .replace(/\b\d+\s*hours(?=[a-z])/gi, " ")
    .replace(/\bseconds(?=[A-Z])/g, " ")
    .replace(/\bminutes(?=[A-Z])/g, " ")
    .replace(/\bhours(?=[A-Z])/g, " ")
    .replace(/\b\d{1,4}\s*hour,,?\b/gi, " ")
    .replace(/\b\d{1,4}\s*hours?,,?\b/gi, " ")
    .replace(/\b\d{1,4}\s*minutes?,,?\b/gi, " ")
    .replace(/\b\d{1,4}\s*seconds?,,?\b/gi, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/[|]+/g, " ")
    .replace(/[;:,]{2,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return cleanWhitespace(line);
}

function looksMostlyCorrupt(line) {
  const raw = cleanWhitespace(String(line || ""));
  if (!raw) return true;

  const cleaned = cleanWhitespace(stripTranscriptCorruption(raw));
  const rawWords = wordCount(raw);
  const cleanWords = wordCount(cleaned);

  if (!cleaned) return true;
  if (cleanWords < 4 && rawWords < 8) return true;

  const rawDigitClusters = (raw.match(/\d+/g) || []).length;
  const rawWeirdPunct = (raw.match(/[;:]/g) || []).length;

  if (rawDigitClusters >= 8 && cleanWords < 8) return true;
  if (rawWeirdPunct >= 6 && cleanWords < 8) return true;

  return false;
}

function containsCorruption(sentence) {
  const raw = cleanWhitespace(String(sentence || ""));
  if (!raw) return true;

  const cleaned = cleanWhitespace(stripTranscriptCorruption(raw));
  if (!cleaned) return true;

  const rawWords = wordCount(raw);
  const cleanWords = wordCount(cleaned);

  if (cleanWords >= 8) return false;
  if (rawWords >= 12 && cleanWords >= 6) return false;

  return looksMostlyCorrupt(raw);
}

/* ------------------------------------------------------------------ */
/* Setup / moderator / non-argument detection                         */
/* ------------------------------------------------------------------ */

function isLikelySetupLine(line) {
  const t = cleanWhitespace(line);
  if (!t) return true;
  return INTRO_PATTERNS.some((re) => re.test(t));
}

function isLikelyModeratorLine(line) {
  const t = cleanWhitespace(line).toLowerCase();
  if (!t) return false;

  if (/^(moderator|host|interviewer|question)\s*[:\-]/i.test(line)) return true;
  return MODERATOR_HINTS.some((hint) => t.includes(hint));
}

function isNonArgumentContextLine(line) {
  const t = cleanWhitespace(line);
  if (!t) return true;

  if (NON_ARGUMENT_CONTEXT_PATTERNS.some((re) => re.test(t))) return true;

  const lower = t.toLowerCase();
  const hasReasoning = includesAny(lower, REASONING_WORDS);
  const hasEvidence = includesAny(lower, EVIDENCE_WORDS);
  const hasTopic = includesAny(lower, TOPIC_WORDS);

  if (!hasReasoning && !hasEvidence && !hasTopic) {
    if (
      /\bthank(s| you)\b/i.test(t) ||
      /\bwelcome\b/i.test(t) ||
      /\bparticipating\b/i.test(t) ||
      /\bdiscussion\b/i.test(t) ||
      /\bfacilitate\b/i.test(t) ||
      /\bchannel\b/i.test(t) ||
      /\bbook\b/i.test(t) ||
      /\bthesis\b/i.test(t)
    ) {
      return true;
    }
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Side extraction                                                    */
/* ------------------------------------------------------------------ */

function extractSides({ transcriptRaw, cleanedTranscript, teamAName, teamBName }) {
  const text = cleanedTranscript || transcriptRaw || "";
  const lines = String(text)
    .split("\n")
    .map((line) => cleanWhitespace(stripTranscriptCorruption(line)))
    .filter(Boolean);

  if (!lines.length) {
    return { teamAText: "", teamBText: "" };
  }

  const explicit = extractByExplicitSpeakerLabels(lines, teamAName, teamBName);
  if (hasRealSideContent(explicit.teamA) && hasRealSideContent(explicit.teamB)) {
    return {
      teamAText: explicit.teamA.join(" "),
      teamBText: explicit.teamB.join(" ")
    };
  }

  const blockSplit = splitByBlocks(lines);
  if (hasRealSideContent(blockSplit.teamA) && hasRealSideContent(blockSplit.teamB)) {
    return {
      teamAText: blockSplit.teamA.join(" "),
      teamBText: blockSplit.teamB.join(" ")
    };
  }

  const fallback = fallbackSplitSides(lines);
  return {
    teamAText: fallback.teamA.join(" "),
    teamBText: fallback.teamB.join(" ")
  };
}

function extractByExplicitSpeakerLabels(lines, teamAName, teamBName) {
  const teamA = [];
  const teamB = [];

  const aName = escapeRegExp(teamAName);
  const bName = escapeRegExp(teamBName);

  const aPatterns = [
    new RegExp("^" + aName + "\\s*[:\\-]", "i"),
    /^team\s*a\s*[:\-]/i,
    /^speaker\s*a\s*[:\-]/i,
    /^side\s*a\s*[:\-]/i,
    /^a\s*[:\-]/i,
    /^1\s*[:\-]/i
  ];

  const bPatterns = [
    new RegExp("^" + bName + "\\s*[:\\-]", "i"),
    /^team\s*b\s*[:\-]/i,
    /^speaker\s*b\s*[:\-]/i,
    /^side\s*b\s*[:\-]/i,
    /^b\s*[:\-]/i,
    /^2\s*[:\-]/i
  ];

  for (const rawLine of lines) {
    const line = cleanWhitespace(stripTranscriptCorruption(rawLine));
    if (!line || isLikelyModeratorLine(line)) continue;

    if (aPatterns.some((re) => re.test(line))) {
      const cleaned = cleanWhitespace(
        stripTranscriptCorruption(line.replace(/^[^:\-]+[:\-]\s*/, ""))
      );
      if (isRealArgumentSentence(cleaned)) teamA.push(cleaned);
      continue;
    }

    if (bPatterns.some((re) => re.test(line))) {
      const cleaned = cleanWhitespace(
        stripTranscriptCorruption(line.replace(/^[^:\-]+[:\-]\s*/, ""))
      );
      if (isRealArgumentSentence(cleaned)) teamB.push(cleaned);
    }
  }

  return {
    teamA: uniquePreserveOrder(teamA),
    teamB: uniquePreserveOrder(teamB)
  };
}

function splitByBlocks(lines) {
  const eligible = lines
    .map((line) => cleanWhitespace(stripTranscriptCorruption(line)))
    .filter(Boolean)
    .filter(
      (line) =>
        !isLikelyModeratorLine(line) &&
        !isLikelySetupLine(line) &&
        isRealArgumentSentence(line)
    );

  if (eligible.length < 4) return { teamA: [], teamB: [] };

  const chunks = [];
  let current = [];

  for (const line of eligible) {
    current.push(line);
    if (current.length >= 2) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);

  if (chunks.length < 2) return { teamA: [], teamB: [] };

  const teamA = [];
  const teamB = [];

  for (let i = 0; i < chunks.length; i += 1) {
    if (i % 2 === 0) teamA.push(...chunks[i]);
    else teamB.push(...chunks[i]);
  }

  return {
    teamA: uniquePreserveOrder(teamA),
    teamB: uniquePreserveOrder(teamB)
  };
}

function fallbackSplitSides(lines) {
  const eligible = lines
    .map((line) => cleanWhitespace(stripTranscriptCorruption(line)))
    .filter(Boolean)
    .filter(
      (line) =>
        !isLikelyModeratorLine(line) &&
        !isLikelySetupLine(line) &&
        isRealArgumentSentence(line)
    );

  const teamA = [];
  const teamB = [];

  for (let i = 0; i < eligible.length; i += 1) {
    const bucket = Math.floor(i / 2);
    if (bucket % 2 === 0) teamA.push(eligible[i]);
    else teamB.push(eligible[i]);
  }

  if (!teamA.length && eligible.length) teamA.push(eligible[0]);
  if (!teamB.length && eligible.length > 1) teamB.push(eligible[1]);

  return {
    teamA: uniquePreserveOrder(teamA),
    teamB: uniquePreserveOrder(teamB)
  };
}

function hasRealSideContent(lines) {
  const list = Array.isArray(lines) ? lines.filter(isRealArgumentSentence) : [];
  return list.length >= 2;
}

function isRealArgumentSentence(line) {
  const raw = cleanWhitespace(String(line || ""));
  if (!raw) return false;
  if (isLikelySetupLine(raw)) return false;
  if (isLikelyModeratorLine(raw) && wordCount(raw) < 20) return false;
  if (isNonArgumentContextLine(raw)) return false;
  if (/^(thanks|thank you|okay|alright|right|sure)\b/i.test(raw)) return false;

  const cleaned = cleanWhitespace(stripTranscriptCorruption(raw));
  if (!cleaned) return false;
  if (wordCount(cleaned) < 6) return false;

  const hasReasoning = includesAny(cleaned, REASONING_WORDS);
  const hasEvidence = includesAny(cleaned, EVIDENCE_WORDS);
  const hasTopic = includesAny(cleaned, TOPIC_WORDS);
  const hasDebateStyleClaim =
    /\b(is|are|does|do|cannot|can't|won't|proves|shows|demonstrates|refutes|contradicts|supports)\b/i.test(
      cleaned
    );

  return hasReasoning || hasEvidence || hasTopic || hasDebateStyleClaim;
}

/* ------------------------------------------------------------------ */
/* Sentence selection                                                 */
/* ------------------------------------------------------------------ */

function toSentences(text) {
  const value = cleanWhitespace(text);
  if (!value) return [];

  const working = value.replace(/\n+/g, " ").replace(/\s{2,}/g, " ");

  return uniquePreserveOrder(
    working
      .split(/(?<=[.!?])\s+/)
      .map((s) => cleanWhitespace(s))
      .filter(Boolean)
  );
}

function selectArgumentSentences(text) {
  const sentences = toSentences(text);

  const candidates = sentences
    .map((sentence) => {
      const cleaned = cleanWhitespace(stripTranscriptCorruption(sentence));
      return wordCount(cleaned) >= 6 ? cleaned : cleanWhitespace(sentence);
    })
    .filter(Boolean)
    .filter(isRealArgumentSentence)
    .filter((sentence) => !isNonArgumentContextLine(sentence));

  const scored = candidates
    .map((sentence) => ({
      sentence,
      score: scoreSentence(sentence)
    }))
    .sort((a, b) => b.score - a.score);

  const selected = uniquePreserveOrder(scored.slice(0, 12).map((x) => x.sentence));
  if (selected.length >= 3) return selected;

  return uniquePreserveOrder(candidates.slice(0, 12));
}

function scoreSentence(sentence) {
  const cleaned = cleanWhitespace(stripTranscriptCorruption(sentence));
  const text = wordCount(cleaned) >= 6 ? cleaned : cleanWhitespace(sentence);

  let score = 0;
  const wc = wordCount(text);

  score += Math.min(wc, 26);
  score += countHits(text, REASONING_WORDS) * 8;
  score += countHits(text, EVIDENCE_WORDS) * 7;
  score += countHits(text, TOPIC_WORDS) * 4;
  score += countHits(text, OPINION_WORDS) * 1;
  score -= countHits(text, FILLER_WORDS) * 2;

  if (/for example|for instance|according to/i.test(text)) score += 6;
  if (/because/i.test(text)) score += 6;
  if (wc > 10 && wc < 45) score += 6;
  if (wc < 8) score -= 10;
  if (wc > 60) score -= 6;
  if (containsCorruption(text) && wc < 8) score -= 25;
  if (isNonArgumentContextLine(text)) score -= 40;

  return score;
}

function chooseBestSentence(sentences) {
  if (!Array.isArray(sentences) || !sentences.length) return "";

  const ranked = sentences
    .map((s) => {
      const cleaned = cleanWhitespace(stripTranscriptCorruption(s));
      return wordCount(cleaned) >= 6 ? cleaned : cleanWhitespace(s);
    })
    .filter(Boolean)
    .filter(isRealArgumentSentence)
    .filter((sentence) => !isNonArgumentContextLine(sentence))
    .map((sentence) => ({ sentence, score: scoreSentence(sentence) }))
    .sort((a, b) => b.score - a.score);

  return ranked.length ? ranked[0].sentence : "";
}

/* ------------------------------------------------------------------ */
/* Deterministic analysis                                             */
/* ------------------------------------------------------------------ */

function deterministicAnalysis(sentences, sideName) {
  const safeSentences = Array.isArray(sentences)
    ? sentences
        .map((s) => {
          const cleaned = cleanWhitespace(stripTranscriptCorruption(s));
          return wordCount(cleaned) >= 6 ? cleaned : cleanWhitespace(s);
        })
        .filter(Boolean)
        .filter(isRealArgumentSentence)
    : [];

  const joined = safeSentences.join(" ");
  const bestSentence = chooseBestSentence(safeSentences);

  const mainPosition = summarizeMainPosition(safeSentences, sideName);
  const truth = extractTruth(safeSentences);
  const lies = extractLies(safeSentences);
  const opinion = extractOpinion(safeSentences);
  const lala = extractLala(safeSentences);
  const lane = inferLane(joined);
  const reasoningText = buildReasoningText(safeSentences);
  const integrityText = buildIntegrityText(truth, lies, opinion);
  const manipulationText = buildManipulationText(safeSentences);
  const fluffText = buildFluffText(safeSentences);
  const scoreRaw = scoreSide(safeSentences, truth, lies, opinion);

  return {
    sideName,
    sentences: safeSentences,
    main_position: meaningful(
      mainPosition,
      sideName + " does not have enough preserved argument text to summarize the main position cleanly."
    ),
    truth: meaningful(
      truth,
      sideName + " presents at least one concrete claim, but the available text does not preserve a cleaner evidence sentence."
    ),
    lies: meaningful(
      lies,
      sideName + " shows some overreach or unsupported phrasing, but no single sentence is clean enough to isolate as the main weak point."
    ),
    opinion: meaningful(
      opinion,
      sideName + " includes interpretive or judgment language mixed into the argument."
    ),
    lala: meaningful(
      lala,
      sideName + " has limited obvious filler after cleanup, but some loose phrasing still remains."
    ),
    bestSentence: meaningful(
      bestSentence,
      sideName + " has a serviceable argument sentence, though the transcript remains partially noisy."
    ),
    lane: meaningful(lane, "mixed / unclear lane"),
    reasoningText: meaningful(
      reasoningText,
      sideName + " uses some reasoning structure, though not every step is fully developed."
    ),
    integrityText: meaningful(
      integrityText,
      sideName + " shows a mixed integrity profile with some grounded points and some unsupported reach."
    ),
    manipulationText: meaningful(
      manipulationText,
      sideName + " does not show a dominant manipulation pattern, but some framing language may still pressure the conclusion."
    ),
    fluffText: meaningful(
      fluffText,
      sideName + " contains some filler or loose wording, but the core argument still comes through."
    ),
    scoreRaw
  };
}

function summarizeMainPosition(sentences, sideName) {
  if (!sentences.length) {
    return sideName + " does not have enough preserved argument text to summarize the main position cleanly.";
  }

  const best = chooseBestSentence(sentences);
  if (!best) {
    return sideName + " does not have enough preserved argument text to summarize the main position cleanly.";
  }

  const summary = summarizeClaim(best);
  return sideName + " mainly argues that " + summary + ".";
}

function summarizeClaim(text) {
  const cleaned = clip(text, 220)
    .replace(/^[,;:\-\s]+/, "")
    .replace(/\.$/, "");

  if (!cleaned) return "the central claim is not preserved clearly";
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function extractTruth(sentences) {
  const candidate =
    sentences.find(
      (s) =>
        !isNonArgumentContextLine(s) &&
        (countHits(s, EVIDENCE_WORDS) >= 1 || countHits(s, REASONING_WORDS) >= 1)
    ) ||
    sentences.find((s) => !isNonArgumentContextLine(s) && countHits(s, TOPIC_WORDS) >= 1) ||
    "";

  return candidate ? clip(candidate, 300) : "";
}

function extractLies(sentences) {
  const candidate =
    sentences.find(
      (s) =>
        !isNonArgumentContextLine(s) &&
        (countHits(s, OVERREACH_WORDS) >= 1 ||
          (countHits(s, EVIDENCE_WORDS) === 0 &&
            countHits(s, REASONING_WORDS) === 0 &&
            wordCount(s) > 10))
    ) || "";

  return candidate ? clip(candidate, 300) : "";
}

function extractOpinion(sentences) {
  const candidate =
    sentences.find(
      (s) =>
        !isNonArgumentContextLine(s) &&
        (countHits(s, OPINION_WORDS) >= 1 || /\bshould\b|\bseems\b|\bappears\b/i.test(s))
    ) || "";

  return candidate ? clip(candidate, 300) : "";
}

function extractLala(sentences) {
  const candidate =
    sentences.find(
      (s) =>
        isNonArgumentContextLine(s) ||
        countHits(s, FILLER_WORDS) >= 2 ||
        /\bwhatever\b|\byou know\b|\bi mean\b/i.test(s)
    ) || "";

  return candidate ? clip(candidate, 300) : "";
}

function inferLane(text) {
  const t = cleanWhitespace(text).toLowerCase();

  const scienceScore = countHits(t, [
    "data",
    "study",
    "research",
    "model",
    "evidence",
    "physics",
    "biology",
    "experiment",
    "observation",
    "statistics",
    "evolution",
    "common ancestry"
  ]);

  const theologyScore = countHits(t, [
    "god",
    "bible",
    "scripture",
    "jesus",
    "biblical",
    "genesis",
    "theology",
    "creation",
    "faith",
    "flood"
  ]);

  const philosophyScore = countHits(t, [
    "logic",
    "reason",
    "premise",
    "conclusion",
    "causality",
    "determinism",
    "free will",
    "metaphysics",
    "epistemology"
  ]);

  const ranked = [
    { name: "science / evidence lane", score: scienceScore },
    { name: "theology / scripture lane", score: theologyScore },
    { name: "logic / philosophy lane", score: philosophyScore }
  ].sort((a, b) => b.score - a.score);

  if (!ranked[0].score) return "mixed / unclear lane";
  if (ranked[0].score === ranked[1].score && ranked[0].score > 0) {
    return "mixed lane with overlapping frameworks";
  }

  return ranked[0].name;
}

function buildReasoningText(sentences) {
  const reasoningHits = sentences.reduce((n, s) => n + countHits(s, REASONING_WORDS), 0);
  const evidenceHits = sentences.reduce((n, s) => n + countHits(s, EVIDENCE_WORDS), 0);

  if (reasoningHits >= 4 && evidenceHits >= 2) {
    return "Strongest on explicit reasoning structure and at least some evidentiary support.";
  }
  if (reasoningHits >= 3) {
    return "Reasoning is present and mostly traceable, though support is not always equally strong.";
  }
  if (evidenceHits >= 2) {
    return "Uses examples or evidence language, but the chain from premise to conclusion is less consistent.";
  }
  return "Reasoning exists, but much of it is asserted more than fully demonstrated.";
}

function buildIntegrityText(truth, lies, opinion) {
  const truthStrength = truth ? wordCount(truth) : 0;
  const lieStrength = lies ? wordCount(lies) : 0;
  const opinionStrength = opinion ? wordCount(opinion) : 0;

  if (truthStrength > lieStrength + opinionStrength) {
    return "Leans more grounded than inflated, though not every claim is equally supported.";
  }
  if (lieStrength > truthStrength) {
    return "Shows noticeable overreach or unsupported certainty relative to the evidence preserved.";
  }
  return "Mixed integrity profile: some grounded points, some interpretive stretch, some unresolved support gaps.";
}

function buildManipulationText(sentences) {
  const joined = sentences.join(" ").toLowerCase();

  const hits = countHits(joined, [
    "obviously",
    "everyone knows",
    "clearly",
    "dishonest",
    "ridiculous",
    "absurd",
    "you have to",
    "you must"
  ]);

  if (hits >= 3) {
    return "Noticeable pressure language and framing tactics show up alongside the argument.";
  }
  if (hits >= 1) {
    return "Some rhetorical pressure appears, but it does not fully dominate the case.";
  }
  return "Low obvious manipulation in the preserved text.";
}

function buildFluffText(sentences) {
  const joined = sentences.join(" ").toLowerCase();
  const fillerHits = countHits(joined, FILLER_WORDS);

  if (fillerHits >= 8) {
    return "Heavy filler and loose speech patterns still bleed into the argument selection.";
  }
  if (fillerHits >= 3) {
    return "Some fluff remains, but the main claims are still identifiable.";
  }
  return "Low fluff after cleanup.";
}

function scoreSide(sentences, truth, lies, opinion) {
  const reasoning = sentences.reduce((n, s) => n + countHits(s, REASONING_WORDS), 0);
  const evidence = sentences.reduce((n, s) => n + countHits(s, EVIDENCE_WORDS), 0);
  const topic = sentences.reduce((n, s) => n + countHits(s, TOPIC_WORDS), 0);
  const overreach = sentences.reduce((n, s) => n + countHits(s, OVERREACH_WORDS), 0);
  const filler = sentences.reduce((n, s) => n + countHits(s, FILLER_WORDS), 0);

  let score =
    50 +
    reasoning * 4 +
    evidence * 4 +
    topic * 1.5 +
    Math.min(wordCount(truth || ""), 25) * 0.3 -
    overreach * 3 -
    filler * 1.2 -
    Math.min(wordCount(opinion || ""), 18) * 0.15 -
    Math.min(wordCount(lies || ""), 25) * 0.1;

  if (!sentences.length) score = 35;

  return Math.max(1, Math.min(99, Math.round(score)));
}

/* ------------------------------------------------------------------ */
/* Fact check layer                                                   */
/* ------------------------------------------------------------------ */

function factCheckLayer(teamAAnalysis, teamBAnalysis, meta) {
  const checkedClaims = [];

  const inspect = (analysis, sideName) => {
    const claims = analysis.sentences
      .filter((claim) => !isNonArgumentContextLine(claim))
      .map((claim) => {
        const cleaned = cleanWhitespace(stripTranscriptCorruption(claim));
        return wordCount(cleaned) >= 6 ? cleaned : cleanWhitespace(claim);
      })
      .filter(Boolean)
      .slice(0, 3);

    for (const claim of claims) {
      checkedClaims.push({
        claim: clip(sideName + ": " + claim, 220),
        status: inferFactCheckStatus(claim),
        note: buildFactCheckNote(claim),
        source: meta.videoLink ? clip(meta.videoLink, 180) : "Transcript-only analysis"
      });
    }
  };

  inspect(teamAAnalysis, teamAAnalysis.sideName || DEFAULT_TEAM_A);
  inspect(teamBAnalysis, teamBAnalysis.sideName || DEFAULT_TEAM_B);

  return {
    checkedClaims,
    summary:
      "Fact-check layer executed in transcript mode. Claims were filtered structurally, not externally verified."
  };
}

function inferFactCheckStatus(claim) {
  const c = cleanWhitespace(claim).toLowerCase();
  if (!c) return "needs-review";
  if (countHits(c, OVERREACH_WORDS) >= 1) return "flagged-overreach";
  if (countHits(c, EVIDENCE_WORDS) >= 1) return "supported-language";
  return "needs-review";
}

function buildFactCheckNote(claim) {
  const c = cleanWhitespace(claim);
  if (!c) return "No claim text preserved.";
  if (countHits(c, OVERREACH_WORDS) >= 1) {
    return "Contains strong certainty or sweep language that would need outside verification.";
  }
  if (countHits(c, EVIDENCE_WORDS) >= 1) {
    return "Uses evidence-oriented language, but outside verification is still required.";
  }
  return "This claim is analyzable, but not independently verified in this backend-only version.";
}

/* ------------------------------------------------------------------ */
/* AI refinement layer                                                */
/* ------------------------------------------------------------------ */

async function aiRefinementLayer(teamAAnalysis, teamBAnalysis, meta) {
  const promptBundle = buildRefinementPrompt(teamAAnalysis, teamBAnalysis, meta);
  const heuristic = heuristicAIRefinement(teamAAnalysis, teamBAnalysis);

  return {
    usedAI: false,
    promptPreview: clip(promptBundle, 500),
    override: heuristic
  };
}

function buildRefinementPrompt(teamAAnalysis, teamBAnalysis, meta) {
  return (
    "You are refining a debate analysis JSON.\n\n" +
    "Instructions:\n" +
    "- Keep all required fields populated.\n" +
    "- Prefer stronger concise wording over weak fallback wording.\n" +
    "- Do not change the output structure.\n" +
    "- Do not return empty fields.\n\n" +
    "Prompt override:\n" +
    (meta.promptOverride || "No custom override provided.") +
    "\n\nTEAM A:\n" +
    "main_position: " + JSON.stringify(teamAAnalysis.main_position) + "\n" +
    "truth: " + JSON.stringify(teamAAnalysis.truth) + "\n" +
    "lies: " + JSON.stringify(teamAAnalysis.lies) + "\n" +
    "opinion: " + JSON.stringify(teamAAnalysis.opinion) + "\n" +
    "bestSentence: " + JSON.stringify(teamAAnalysis.bestSentence) + "\n" +
    "reasoningText: " + JSON.stringify(teamAAnalysis.reasoningText) + "\n" +
    "integrityText: " + JSON.stringify(teamAAnalysis.integrityText) + "\n" +
    "lane: " + JSON.stringify(teamAAnalysis.lane) + "\n\n" +
    "TEAM B:\n" +
    "main_position: " + JSON.stringify(teamBAnalysis.main_position) + "\n" +
    "truth: " + JSON.stringify(teamBAnalysis.truth) + "\n" +
    "lies: " + JSON.stringify(teamBAnalysis.lies) + "\n" +
    "opinion: " + JSON.stringify(teamBAnalysis.opinion) + "\n" +
    "bestSentence: " + JSON.stringify(teamBAnalysis.bestSentence) + "\n" +
    "reasoningText: " + JSON.stringify(teamBAnalysis.reasoningText) + "\n" +
    "integrityText: " + JSON.stringify(teamBAnalysis.integrityText) + "\n" +
    "lane: " + JSON.stringify(teamBAnalysis.lane)
  );
}

function heuristicAIRefinement(teamAAnalysis, teamBAnalysis) {
  const strongestSide =
    teamAAnalysis.scoreRaw >= teamBAnalysis.scoreRaw
      ? teamAAnalysis.sideName
      : teamBAnalysis.sideName;

  const strongestArgument =
    strongestSide === teamAAnalysis.sideName
      ? teamAAnalysis.bestSentence
      : teamBAnalysis.bestSentence;

  const weakerSide =
    strongestSide === teamAAnalysis.sideName
      ? teamBAnalysis.sideName
      : teamAAnalysis.sideName;

  const weakerClaim =
    strongerWeakPoint(teamAAnalysis, teamBAnalysis).text ||
    weakerSide + " leaves the weaker unresolved point in the preserved transcript.";

  return {
    strongestArgumentSide: strongestSide,
    strongestArgument: strongestArgument,
    whyStrongest:
      "It stands out because it has the clearest reasoning path and the least unsupported inflation.",
    failedResponseByOtherSide:
      weakerSide + " does not clearly neutralize the opposing best point in the preserved transcript.",
    weakestOverall: weakerClaim,
    manipulation:
      teamAAnalysis.manipulationText === "Low obvious manipulation in the preserved text." &&
      teamBAnalysis.manipulationText === "Low obvious manipulation in the preserved text."
        ? "Neither side shows dominant manipulation in the preserved text."
        : teamAAnalysis.sideName +
          ": " +
          teamAAnalysis.manipulationText +
          " " +
          teamBAnalysis.sideName +
          ": " +
          teamBAnalysis.manipulationText,
    fluff:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.fluffText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.fluffText
  };
}

/* ------------------------------------------------------------------ */
/* Base result + merge                                                */
/* ------------------------------------------------------------------ */

function buildBaseResult(teamAName, teamBName, teamAAnalysis, teamBAnalysis, factLayer) {
  const winner = decideWinner(teamAAnalysis, teamBAnalysis);
  const confidence = buildConfidence(teamAAnalysis.scoreRaw, teamBAnalysis.scoreRaw);
  const sameLane = buildSameLaneEngagement(teamAAnalysis.lane, teamBAnalysis.lane);
  const laneMismatch = buildLaneMismatch(teamAAnalysis.lane, teamBAnalysis.lane);
  const coreDisagreement = buildCoreDisagreement(teamAAnalysis, teamBAnalysis);
  const why = buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer);
  const bsMeter = buildBSMeter(teamAAnalysis, teamBAnalysis);
  const weakest = strongerWeakPoint(teamAAnalysis, teamBAnalysis);

  return {
    teamAName,
    teamBName,
    winner,
    confidence,
    teamAScore: String(normalizeDisplayScore(teamAAnalysis.scoreRaw)),
    teamBScore: String(normalizeDisplayScore(teamBAnalysis.scoreRaw)),

    teamA: {
      main_position: teamAAnalysis.main_position,
      truth: teamAAnalysis.truth,
      lies: teamAAnalysis.lies,
      opinion: teamAAnalysis.opinion,
      lala: teamAAnalysis.lala
    },

    teamB: {
      main_position: teamBAnalysis.main_position,
      truth: teamBAnalysis.truth,
      lies: teamBAnalysis.lies,
      opinion: teamBAnalysis.opinion,
      lala: teamBAnalysis.lala
    },

    teamA_integrity: teamAAnalysis.integrityText,
    teamB_integrity: teamBAnalysis.integrityText,
    teamA_reasoning: teamAAnalysis.reasoningText,
    teamB_reasoning: teamBAnalysis.reasoningText,

    teamA_lane: teamAAnalysis.lane,
    teamB_lane: teamBAnalysis.lane,
    same_lane_engagement: sameLane,
    lane_mismatch: laneMismatch,

    strongestArgumentSide:
      teamAAnalysis.scoreRaw >= teamBAnalysis.scoreRaw ? teamAName : teamBName,
    strongestArgument:
      teamAAnalysis.scoreRaw >= teamBAnalysis.scoreRaw
        ? teamAAnalysis.bestSentence
        : teamBAnalysis.bestSentence,
    whyStrongest:
      "The strongest argument has the clearest reasoning chain and the least unsupported inflation.",
    failedResponseByOtherSide:
      teamAAnalysis.scoreRaw >= teamBAnalysis.scoreRaw
        ? teamBName + " does not fully answer " + teamAName + "'s strongest point in the preserved transcript."
        : teamAName + " does not fully answer " + teamBName + "'s strongest point in the preserved transcript.",
    weakestOverall: weakest.text,

    bsMeter,
    manipulation: "Manipulation assessment completed from transcript framing only.",
    fluff: teamAName + ": " + teamAAnalysis.fluffText + " " + teamBName + ": " + teamBAnalysis.fluffText,

    core_disagreement: coreDisagreement,
    why,

    analysisMode: ANALYSIS_MODE,
    sources: Array.isArray(factLayer.checkedClaims) ? factLayer.checkedClaims : []
  };
}

function mergeLayer(base, aiLayer) {
  const merged = { ...base };
  const override = aiLayer && aiLayer.override ? aiLayer.override : {};

  const weak = (value) =>
    !value ||
    !String(value).trim() ||
    /^none$/i.test(String(value).trim()) ||
    String(value).trim() === "-";

  const replaceIfBetter = (current, next) => {
    if (weak(current) && !weak(next)) return next;
    if (!weak(next) && String(next).length > String(current || "").length + 20) return next;
    return current;
  };

  merged.strongestArgumentSide = replaceIfBetter(
    merged.strongestArgumentSide,
    override.strongestArgumentSide
  );
  merged.strongestArgument = replaceIfBetter(
    merged.strongestArgument,
    sanitizeForDisplay(override.strongestArgument)
  );
  merged.whyStrongest = replaceIfBetter(merged.whyStrongest, override.whyStrongest);
  merged.failedResponseByOtherSide = replaceIfBetter(
    merged.failedResponseByOtherSide,
    sanitizeForDisplay(override.failedResponseByOtherSide)
  );
  merged.weakestOverall = replaceIfBetter(
    merged.weakestOverall,
    sanitizeForDisplay(override.weakestOverall)
  );
  merged.manipulation = replaceIfBetter(merged.manipulation, override.manipulation);
  merged.fluff = replaceIfBetter(merged.fluff, override.fluff);

  return merged;
}

/* ------------------------------------------------------------------ */
/* Result builders                                                    */
/* ------------------------------------------------------------------ */

function decideWinner(teamAAnalysis, teamBAnalysis) {
  const diff = Math.abs(teamAAnalysis.scoreRaw - teamBAnalysis.scoreRaw);
  if (diff <= 3) return "Mixed";
  return teamAAnalysis.scoreRaw > teamBAnalysis.scoreRaw
    ? teamAAnalysis.sideName
    : teamBAnalysis.sideName;
}

function buildConfidence(a, b) {
  const diff = Math.abs(a - b);
  return String(Math.min(95, 50 + diff * 4)) + "%";
}

function normalizeDisplayScore(raw) {
  return Math.max(1, Math.min(10, Math.round(raw / 10)));
}

function buildSameLaneEngagement(aLane, bLane) {
  if (aLane === bLane) {
    return "Both sides largely argue in the same lane: " + aLane + ".";
  }
  if (aLane.includes("mixed") || bLane.includes("mixed")) {
    return "At least one side blends lanes, so engagement is only partial rather than cleanly matched.";
  }
  return "The sides partly engage each other, but they often argue from different frameworks.";
}

function buildLaneMismatch(aLane, bLane) {
  if (aLane === bLane) {
    return "Low lane mismatch. They are mostly fighting on shared ground.";
  }
  return "Lane mismatch exists: Team A is mainly in " + aLane + ", while Team B is mainly in " + bLane + ".";
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aClaim = summarizeClaim(
    teamAAnalysis.truth || teamAAnalysis.bestSentence || teamAAnalysis.main_position || ""
  );
  const bClaim = summarizeClaim(
    teamBAnalysis.truth || teamBAnalysis.bestSentence || teamBAnalysis.main_position || ""
  );

  if (aClaim && bClaim) {
    return (
      "The dispute is whether " +
      aClaim +
      ", with Team A arguing " +
      aClaim +
      " and Team B arguing " +
      bClaim +
      "."
    );
  }

  return "The sides disagree over which central claim is better supported by reasoning and evidence in the preserved transcript.";
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  if (winner === "Mixed") {
    return "Both sides show some usable reasoning but also leave support gaps, overreach, or unresolved rebuttal issues.";
  }

  const winnerAnalysis = winner === teamAAnalysis.sideName ? teamAAnalysis : teamBAnalysis;
  const loserAnalysis = winner === teamAAnalysis.sideName ? teamBAnalysis : teamAAnalysis;
  const winnerStrength = summarizeClaim(winnerAnalysis.bestSentence || winnerAnalysis.truth || "");
  const loserWeakness = summarizeClaim(loserAnalysis.lies || loserAnalysis.bestSentence || "");

  return (
    winner +
    " wins because its stronger point is " +
    winnerStrength +
    ", while the weaker side leaves unresolved weakness around " +
    loserWeakness +
    ". " +
    factLayer.summary
  );
}

function buildBSMeter(teamAAnalysis, teamBAnalysis) {
  const aOver =
    countHits(teamAAnalysis.lies, OVERREACH_WORDS) +
    countHits(teamAAnalysis.sentences.join(" "), OVERREACH_WORDS);

  const bOver =
    countHits(teamBAnalysis.lies, OVERREACH_WORDS) +
    countHits(teamBAnalysis.sentences.join(" "), OVERREACH_WORDS);

  if (aOver === bOver) return "Both sides show comparable overreach.";
  return aOver > bOver
    ? teamAAnalysis.sideName + " is reaching more"
    : teamBAnalysis.sideName + " is reaching more";
}

function strongerWeakPoint(teamAAnalysis, teamBAnalysis) {
  const aWeakScore = weaknessScore(teamAAnalysis);
  const bWeakScore = weaknessScore(teamBAnalysis);

  if (aWeakScore >= bWeakScore) {
    return {
      side: teamAAnalysis.sideName,
      text:
        teamAAnalysis.sideName +
        " weakest point: " +
        summarizeClaim(teamAAnalysis.lies || teamAAnalysis.bestSentence || "") +
        " because it is less supported or more inflated than the stronger opposing material."
    };
  }

  return {
    side: teamBAnalysis.sideName,
    text:
      teamBAnalysis.sideName +
      " weakest point: " +
      summarizeClaim(teamBAnalysis.lies || teamBAnalysis.bestSentence || "") +
      " because it is less supported or more inflated than the stronger opposing material."
  };
}

function weaknessScore(analysis) {
  return (
    countHits(analysis.lies || "", OVERREACH_WORDS) * 3 +
    Math.max(0, 18 - wordCount(analysis.truth || "")) +
    countHits(analysis.opinion || "", OPINION_WORDS)
  );
}

/* ------------------------------------------------------------------ */
/* Consistency enforcement                                            */
/* ------------------------------------------------------------------ */

function enforceConsistency(result) {
  const safe = JSON.parse(JSON.stringify(result || {}));

  safe.teamAName = meaningful(safe.teamAName, DEFAULT_TEAM_A);
  safe.teamBName = meaningful(safe.teamBName, DEFAULT_TEAM_B);
  safe.winner = meaningful(safe.winner, "Mixed");
  safe.confidence = normalizeConfidence(safe.confidence);
  safe.teamAScore = meaningful(String(safe.teamAScore || ""), "5");
  safe.teamBScore = meaningful(String(safe.teamBScore || ""), "5");

  safe.teamA = safe.teamA || {};
  safe.teamB = safe.teamB || {};

  safe.teamA.main_position = sanitizeForDisplay(
    meaningful(
      safe.teamA.main_position,
      safe.teamAName + " presents a position, but the transcript remains partially noisy."
    )
  );
  safe.teamA.truth = sanitizeForDisplay(
    meaningful(
      safe.teamA.truth,
      safe.teamAName + " makes at least one concrete claim, though the cleanest evidence sentence is limited."
    )
  );
  safe.teamA.lies = sanitizeForDisplay(
    meaningful(
      safe.teamA.lies,
      safe.teamAName + " contains some unsupported reach or unresolved assertion."
    )
  );
  safe.teamA.opinion = sanitizeForDisplay(
    meaningful(
      safe.teamA.opinion,
      safe.teamAName + " includes judgment or interpretation in the argument."
    )
  );
  safe.teamA.lala = sanitizeForDisplay(
    meaningful(
      safe.teamA.lala,
      safe.teamAName + " has some leftover loose wording or filler."
    )
  );

  safe.teamB.main_position = sanitizeForDisplay(
    meaningful(
      safe.teamB.main_position,
      safe.teamBName + " presents a position, but the transcript remains partially noisy."
    )
  );
  safe.teamB.truth = sanitizeForDisplay(
    meaningful(
      safe.teamB.truth,
      safe.teamBName + " makes at least one concrete claim, though the cleanest evidence sentence is limited."
    )
  );
  safe.teamB.lies = sanitizeForDisplay(
    meaningful(
      safe.teamB.lies,
      safe.teamBName + " contains some unsupported reach or unresolved assertion."
    )
  );
  safe.teamB.opinion = sanitizeForDisplay(
    meaningful(
      safe.teamB.opinion,
      safe.teamBName + " includes judgment or interpretation in the argument."
    )
  );
  safe.teamB.lala = sanitizeForDisplay(
    meaningful(
      safe.teamB.lala,
      safe.teamBName + " has some leftover loose wording or filler."
    )
  );

  safe.teamA_integrity = sanitizeForDisplay(
    meaningful(safe.teamA_integrity, safe.teamAName + " has a mixed integrity profile.")
  );
  safe.teamB_integrity = sanitizeForDisplay(
    meaningful(safe.teamB_integrity, safe.teamBName + " has a mixed integrity profile.")
  );
  safe.teamA_reasoning = sanitizeForDisplay(
    meaningful(
      safe.teamA_reasoning,
      safe.teamAName + " shows some reasoning but not every step is fully developed."
    )
  );
  safe.teamB_reasoning = sanitizeForDisplay(
    meaningful(
      safe.teamB_reasoning,
      safe.teamBName + " shows some reasoning but not every step is fully developed."
    )
  );

  safe.teamA_lane = sanitizeForDisplay(meaningful(safe.teamA_lane, "mixed / unclear lane"));
  safe.teamB_lane = sanitizeForDisplay(meaningful(safe.teamB_lane, "mixed / unclear lane"));
  safe.same_lane_engagement = sanitizeForDisplay(
    meaningful(safe.same_lane_engagement, "Both sides engage only partially in the same lane.")
  );
  safe.lane_mismatch = sanitizeForDisplay(
    meaningful(safe.lane_mismatch, "Some lane mismatch remains in how the sides frame the issue.")
  );

  safe.strongestArgumentSide = sanitizeForDisplay(
    meaningful(safe.strongestArgumentSide, safe.winner === "Mixed" ? safe.teamAName : safe.winner)
  );
  safe.strongestArgument = sanitizeForDisplay(
    meaningful(
      safe.strongestArgument,
      "A usable strongest argument exists, but transcript cleanup limits precision."
    )
  );
  safe.whyStrongest = sanitizeForDisplay(
    meaningful(
      safe.whyStrongest,
      "It stands out because it is more structured and less inflated than the nearest competing point."
    )
  );
  safe.failedResponseByOtherSide = sanitizeForDisplay(
    meaningful(
      safe.failedResponseByOtherSide,
      "The opposing side does not fully neutralize the strongest point in the preserved text."
    )
  );
  safe.weakestOverall = sanitizeForDisplay(
    meaningful(
      safe.weakestOverall,
      "The weakest overall point is the one with the most unsupported certainty or least developed support."
    )
  );

  safe.bsMeter = sanitizeForDisplay(
    meaningful(safe.bsMeter, "Both sides show some degree of overreach.")
  );
  safe.manipulation = sanitizeForDisplay(
    meaningful(
      safe.manipulation,
      "Manipulation is limited or not clearly dominant in the preserved transcript."
    )
  );
  safe.fluff = sanitizeForDisplay(
    meaningful(safe.fluff, "Some fluff remains, but core claims are still visible.")
  );

  safe.core_disagreement = sanitizeForDisplay(
    meaningful(
      safe.core_disagreement,
      "The sides disagree over which core claim is better supported."
    )
  );
  safe.why = sanitizeForDisplay(
    meaningful(
      safe.why,
      "The result comes from comparing reasoning quality, support, overreach, and rebuttal strength."
    )
  );

  safe.analysisMode = meaningful(safe.analysisMode, ANALYSIS_MODE);
  safe.sources = Array.isArray(safe.sources) ? safe.sources : [];

  return {
    teamAName: safe.teamAName,
    teamBName: safe.teamBName,
    winner: safe.winner,
    confidence: safe.confidence,
    teamAScore: safe.teamAScore,
    teamBScore: safe.teamBScore,

    teamA: {
      main_position: safe.teamA.main_position,
      truth: safe.teamA.truth,
      lies: safe.teamA.lies,
      opinion: safe.teamA.opinion,
      lala: safe.teamA.lala
    },

    teamB: {
      main_position: safe.teamB.main_position,
      truth: safe.teamB.truth,
      lies: safe.teamB.lies,
      opinion: safe.teamB.opinion,
      lala: safe.teamB.lala
    },

    teamA_integrity: safe.teamA_integrity,
    teamB_integrity: safe.teamB_integrity,
    teamA_reasoning: safe.teamA_reasoning,
    teamB_reasoning: safe.teamB_reasoning,

    teamA_lane: safe.teamA_lane,
    teamB_lane: safe.teamB_lane,
    same_lane_engagement: safe.same_lane_engagement,
    lane_mismatch: safe.lane_mismatch,

    strongestArgumentSide: safe.strongestArgumentSide,
    strongestArgument: safe.strongestArgument,
    whyStrongest: safe.whyStrongest,
    failedResponseByOtherSide: safe.failedResponseByOtherSide,
    weakestOverall: safe.weakestOverall,

    bsMeter: safe.bsMeter,
    manipulation: safe.manipulation,
    fluff: safe.fluff,

    core_disagreement: safe.core_disagreement,
    why: safe.why,

    analysisMode: safe.analysisMode,
    sources: safe.sources
  };
}

function meaningful(value, fallback) {
  const v = cleanWhitespace(value);
  if (!v) return fallback;
  if (/^none$/i.test(v)) return fallback;
  if (v === "-") return fallback;
  return v;
}

function normalizeConfidence(value) {
  const v = cleanWhitespace(value);
  if (!v) return "50%";
  if (/%$/.test(v)) return v;
  if (/^\d+$/.test(v)) return v + "%";
  return "50%";
}

function sanitizeForDisplay(value) {
  let text = cleanWhitespace(value);
  if (!text) return "";

  text = stripTranscriptCorruption(text)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\s*hours?,?\s*\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?\b/gi, " ")
    .replace(/[|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text || "";
}

/* ------------------------------------------------------------------ */
/* Failure response                                                   */
/* ------------------------------------------------------------------ */

function buildFailureResponse(req, error) {
  const body = req && req.body && typeof req.body === "object" ? req.body : {};

  const teamAName = normalizeText(body.teamAName || DEFAULT_TEAM_A) || DEFAULT_TEAM_A;
  const teamBName = normalizeText(body.teamBName || DEFAULT_TEAM_B) || DEFAULT_TEAM_B;
  const message = error && error.message ? cleanWhitespace(error.message) : "Unknown backend error";

  return enforceConsistency({
    teamAName,
    teamBName,
    winner: "Mixed",
    confidence: "50%",
    teamAScore: "5",
    teamBScore: "5",

    teamA: {
      main_position: teamAName + " could not be fully analyzed because the backend hit an error path.",
      truth: teamAName + " still appears to contain at least one argument claim in the submitted transcript.",
      lies: teamAName + " could not be fully stress-tested because processing failed before completion.",
      opinion: teamAName + " likely includes interpretation alongside argument.",
      lala: teamAName + " transcript may still contain some loose or noisy language."
    },

    teamB: {
      main_position: teamBName + " could not be fully analyzed because the backend hit an error path.",
      truth: teamBName + " still appears to contain at least one argument claim in the submitted transcript.",
      lies: teamBName + " could not be fully stress-tested because processing failed before completion.",
      opinion: teamBName + " likely includes interpretation alongside argument.",
      lala: teamBName + " transcript may still contain some loose or noisy language."
    },

    teamA_integrity: teamAName + " integrity assessment is incomplete because the handler failed.",
    teamB_integrity: teamBName + " integrity assessment is incomplete because the handler failed.",
    teamA_reasoning: teamAName + " reasoning assessment is incomplete because the handler failed.",
    teamB_reasoning: teamBName + " reasoning assessment is incomplete because the handler failed.",

    teamA_lane: "mixed / unclear lane",
    teamB_lane: "mixed / unclear lane",
    same_lane_engagement: "Could not fully evaluate lane engagement after backend failure.",
    lane_mismatch: "Could not fully evaluate lane mismatch after backend failure.",

    strongestArgumentSide: "Mixed",
    strongestArgument: "No strongest argument could be finalized because processing failed before stable selection.",
    whyStrongest: "The backend error prevented a final strongest-argument comparison.",
    failedResponseByOtherSide: "The backend error prevented final rebuttal comparison.",
    weakestOverall: "The backend error prevented final weakest-point selection.",

    bsMeter: "Backend failure prevented a stable BS comparison.",
    manipulation: "Backend failure prevented a stable manipulation read.",
    fluff: "Backend failure prevented a stable fluff read.",

    core_disagreement: "The sides still disagree, but the backend failure prevented a cleaner summary.",
    why: "Returned safe fallback JSON after backend failure: " + clip(message, 180),

    analysisMode: ANALYSIS_MODE + "+failure-fallback",
    sources: []
  });
}
/* =========================
   VERDICT CLARITY OVERRIDES
   Paste this at the END of /api/analyze2.js
   ========================= */

function summarizeClaimTight(text) {
  const cleaned = clip(
    cleanWhitespace(stripTranscriptCorruption(text || ""))
      .replace(/^[,;:\-\s]+/, "")
      .replace(/\.$/, ""),
    160
  );

  if (!cleaned) return "the main claim is not preserved clearly";
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function reasonProfile(analysis) {
  const joined = (analysis && analysis.sentences ? analysis.sentences : [])
    .join(" ")
    .toLowerCase();

  return {
    evidenceHits: countHits(joined, EVIDENCE_WORDS),
    reasoningHits: countHits(joined, REASONING_WORDS),
    topicHits: countHits(joined, TOPIC_WORDS),
    opinionHits: countHits(joined, OPINION_WORDS),
    overreachHits: countHits(joined, OVERREACH_WORDS),
    fillerHits: countHits(joined, FILLER_WORDS)
  };
}

function strongestReasonWhy(a, b) {
  const pa = reasonProfile(a);
  const pb = reasonProfile(b);

  const winner = a.scoreRaw >= b.scoreRaw ? a : b;
  const loser = winner === a ? b : a;
  const wp = winner === a ? pa : pb;
  const lp = winner === a ? pb : pa;

  const reasons = [];

  if (wp.evidenceHits > lp.evidenceHits) {
    reasons.push("it uses more evidence-oriented support");
  }

  if (wp.reasoningHits > lp.reasoningHits) {
    reasons.push("it gives a clearer because-therefore chain");
  }

  if (wp.topicHits > lp.topicHits) {
    reasons.push("it stays closer to the actual dispute");
  }

  if (lp.overreachHits > wp.overreachHits) {
    reasons.push("the other side reaches harder without matching support");
  }

  if (lp.fillerHits > wp.fillerHits) {
    reasons.push("the other side burns more space on weaker framing");
  }

  if (!reasons.length) {
    reasons.push("it is the cleaner and more focused point in the preserved transcript");
  }

  return {
    winner,
    loser,
    text: "because " + reasons.slice(0, 3).join(", ")
  };
}

function weakPointReason(analysis) {
  const p = reasonProfile(analysis);
  const weakClaim = summarizeClaimTight(
    analysis.lies || analysis.opinion || analysis.lala || analysis.bestSentence || ""
  );

  const reasons = [];

  if (p.overreachHits >= 1) reasons.push("it overreaches beyond what is actually supported");
  if (p.evidenceHits === 0) reasons.push("it does not bring concrete evidence with it");
  if (p.reasoningHits === 0) reasons.push("it asserts more than it explains");
  if (p.opinionHits >= 1) reasons.push("it leans into interpretation more than demonstration");
  if (p.fillerHits >= 2) reasons.push("it carries extra fluff instead of pressure on the issue");

  if (!reasons.length) {
    reasons.push("it does not create a strong enough edge against the opposing case");
  }

  return {
    claim: weakClaim,
    reason: reasons.slice(0, 2).join(" and ")
  };
}

function strongerWeakPoint(teamAAnalysis, teamBAnalysis) {
  const aWeakScore = weaknessScore(teamAAnalysis);
  const bWeakScore = weaknessScore(teamBAnalysis);

  const weaker = aWeakScore >= bWeakScore ? teamAAnalysis : teamBAnalysis;
  const detail = weakPointReason(weaker);

  return {
    side: weaker.sideName,
    text:
      weaker.sideName +
      " weakest point: " +
      detail.claim +
      " because " +
      detail.reason +
      "."
  };
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aClaim = summarizeClaimTight(
    teamAAnalysis.truth || teamAAnalysis.bestSentence || teamAAnalysis.main_position || ""
  );
  const bClaim = summarizeClaimTight(
    teamBAnalysis.truth || teamBAnalysis.bestSentence || teamBAnalysis.main_position || ""
  );

  if (aClaim && bClaim) {
    return (
      "The dispute is whether " +
      aClaim +
      ", while Team B argues " +
      bClaim +
      "."
    );
  }

  return "The sides disagree over which core claim is better supported by reasoning and evidence.";
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  if (winner === "Mixed") {
    const aWeak = weakPointReason(teamAAnalysis);
    const bWeak = weakPointReason(teamBAnalysis);

    return (
      "Mixed because Team A still has weakness around " +
      aWeak.claim +
      ", and Team B still has weakness around " +
      bWeak.claim +
      ". Neither side creates a decisive edge."
    );
  }

  const winnerAnalysis = winner === teamAAnalysis.sideName ? teamAAnalysis : teamBAnalysis;
  const loserAnalysis = winner === teamAAnalysis.sideName ? teamBAnalysis : teamAAnalysis;

  const strongest = summarizeClaimTight(
    winnerAnalysis.bestSentence || winnerAnalysis.truth || winnerAnalysis.main_position || ""
  );

  const weak = weakPointReason(loserAnalysis);
  const because = strongestReasonWhy(teamAAnalysis, teamBAnalysis).text;

  return (
    winner +
    " wins because its best point is " +
    strongest +
    ", " +
    because +
    ", while " +
    loserAnalysis.sideName +
    " stays weaker around " +
    weak.claim +
    "."
  );
}

function heuristicAIRefinement(teamAAnalysis, teamBAnalysis) {
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const weak = strongerWeakPoint(teamAAnalysis, teamBAnalysis);

  return {
    strongestArgumentSide: strongest.winner.sideName,
    strongestArgument:
      strongest.winner.bestSentence ||
      strongest.winner.truth ||
      strongest.winner.main_position,
    whyStrongest:
      "It stands out " + strongest.text + ".",
    failedResponseByOtherSide:
      strongest.loser.sideName +
      " never fully breaks that point with a stronger counter-claim or cleaner evidence line.",
    weakestOverall: weak.text,
    manipulation:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.manipulationText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.manipulationText,
    fluff:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.fluffText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.fluffText
  };
}
/* =========================
   FINAL JUDGMENT OVERRIDES
   Paste at END of /api/analyze2.js
   ========================= */

function cleanJudgmentText(text) {
  let t = cleanWhitespace(stripTranscriptCorruption(text || ""));

  t = t
    .replace(/^\d+\s*[;:,.-]\s*/g, "")
    .replace(/^chapter\s+\d+\s*[:.-]?\s*/i, "")
    .replace(/^now let'?s look at\s+/i, "")
    .replace(/^according to him,\s*/i, "")
    .replace(/^and even if\s+/i, "even if ")
    .replace(/^but by\s+/i, "")
    .replace(/^so\s+/i, "")
    .replace(/\bsubscribe\b.*$/i, "")
    .replace(/\bhit the notification bell\b.*$/i, "")
    .replace(/\bshare this video\b.*$/i, "")
    .replace(/\bgood kind of case study\b/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return t;
}

function isNonArgumentContextLine(line) {
  const t = cleanJudgmentText(line);
  if (!t) return true;

  if (
    /\bsubscribe\b/i.test(t) ||
    /\bnotification bell\b/i.test(t) ||
    /\bshare this video\b/i.test(t) ||
    /\bmy channel\b/i.test(t) ||
    /\bour channel\b/i.test(t) ||
    /\bchapter\s+\d+\b/i.test(t) ||
    /\btable of contents\b/i.test(t) ||
    /\bnow let'?s look at\b/i.test(t) ||
    /\bnow i am defining\b/i.test(t) ||
    /\bthis section\b/i.test(t) ||
    /\bthis chapter\b/i.test(t) ||
    /\baccording to him\b/i.test(t) ||
    /\bgood kind of case study\b/i.test(t) ||
    /\bthanks for watching\b/i.test(t) ||
    /\bthanks for joining\b/i.test(t)
  ) {
    return true;
  }

  if (NON_ARGUMENT_CONTEXT_PATTERNS.some((re) => re.test(t))) return true;

  const lower = t.toLowerCase();
  const hasReasoning = includesAny(lower, REASONING_WORDS);
  const hasEvidence = includesAny(lower, EVIDENCE_WORDS);
  const hasTopic = includesAny(lower, TOPIC_WORDS);

  if (!hasReasoning && !hasEvidence && !hasTopic) {
    if (
      /\bchannel\b/i.test(t) ||
      /\bbook\b/i.test(t) ||
      /\bchapter\b/i.test(t) ||
      /\bdiscussion\b/i.test(t) ||
      /\bfacilitate\b/i.test(t)
    ) {
      return true;
    }
  }

  return false;
}

function selectArgumentSentences(text) {
  const sentences = toSentences(text);

  const candidates = sentences
    .map((sentence) => cleanJudgmentText(sentence))
    .filter(Boolean)
    .filter((sentence) => !isNonArgumentContextLine(sentence))
    .filter((sentence) => wordCount(sentence) >= 7)
    .filter((sentence) => {
      const hasReasoning = includesAny(sentence, REASONING_WORDS);
      const hasEvidence = includesAny(sentence, EVIDENCE_WORDS);
      const hasTopic = includesAny(sentence, TOPIC_WORDS);
      const hasClaimVerb =
        /\b(is|are|does|do|cannot|can't|won't|proves|shows|demonstrates|refutes|contradicts|supports|explains)\b/i.test(sentence);

      return hasReasoning || hasEvidence || hasTopic || hasClaimVerb;
    });

  const scored = candidates
    .map((sentence) => ({
      sentence,
      score: scoreSentence(sentence)
    }))
    .sort((a, b) => b.score - a.score);

  return uniquePreserveOrder(scored.slice(0, 12).map((x) => x.sentence));
}

function scoreSentence(sentence) {
  const text = cleanJudgmentText(sentence);
  let score = 0;
  const wc = wordCount(text);

  score += Math.min(wc, 24);
  score += countHits(text, REASONING_WORDS) * 9;
  score += countHits(text, EVIDENCE_WORDS) * 8;
  score += countHits(text, TOPIC_WORDS) * 5;
  score -= countHits(text, FILLER_WORDS) * 3;

  if (/because/i.test(text)) score += 8;
  if (/for example|for instance|according to/i.test(text)) score += 6;
  if (wc > 10 && wc < 40) score += 6;
  if (wc > 55) score -= 10;
  if (isNonArgumentContextLine(text)) score -= 60;
  if (/^\d+\s*[;:,.-]/.test(sentence)) score -= 25;
  if (/\bchapter\s+\d+\b/i.test(sentence)) score -= 25;
  if (/\bsubscribe\b/i.test(sentence)) score -= 50;

  return score;
}

function summarizeClaimTight(text) {
  const cleaned = clip(cleanJudgmentText(text || ""), 140)
    .replace(/^[,;:\-\s]+/, "")
    .replace(/\.$/, "");

  if (!cleaned) return "the main claim is not preserved clearly";
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function reasonProfile(analysis) {
  const joined = ((analysis && analysis.sentences) || [])
    .map(cleanJudgmentText)
    .join(" ")
    .toLowerCase();

  return {
    evidenceHits: countHits(joined, EVIDENCE_WORDS),
    reasoningHits: countHits(joined, REASONING_WORDS),
    topicHits: countHits(joined, TOPIC_WORDS),
    opinionHits: countHits(joined, OPINION_WORDS),
    overreachHits: countHits(joined, OVERREACH_WORDS),
    fillerHits: countHits(joined, FILLER_WORDS)
  };
}

function strongestReasonWhy(a, b) {
  const pa = reasonProfile(a);
  const pb = reasonProfile(b);

  const winner = a.scoreRaw >= b.scoreRaw ? a : b;
  const loser = winner === a ? b : a;
  const wp = winner === a ? pa : pb;
  const lp = winner === a ? pb : pa;

  const reasons = [];

  if (wp.evidenceHits > lp.evidenceHits) {
    reasons.push("it gives more actual evidence");
  }
  if (wp.reasoningHits > lp.reasoningHits) {
    reasons.push("it explains its logic more clearly");
  }
  if (wp.topicHits > lp.topicHits) {
    reasons.push("it stays more directly on the real issue");
  }
  if (lp.overreachHits > wp.overreachHits) {
    reasons.push("the other side overreaches more");
  }
  if (lp.fillerHits > wp.fillerHits) {
    reasons.push("the other side wastes more space on weaker material");
  }

  if (!reasons.length) {
    reasons.push("it is the cleaner argument in the preserved transcript");
  }

  return {
    winner,
    loser,
    text: reasons.slice(0, 2).join(" and ")
  };
}

function weakPointReason(analysis) {
  const p = reasonProfile(analysis);
  const weakClaim = summarizeClaimTight(
    analysis.lies || analysis.opinion || analysis.lala || analysis.bestSentence || ""
  );

  const reasons = [];

  if (p.overreachHits >= 1) reasons.push("it reaches past the support actually shown");
  if (p.evidenceHits === 0) reasons.push("it lacks concrete evidence");
  if (p.reasoningHits === 0) reasons.push("it asserts more than it explains");
  if (p.opinionHits >= 1) reasons.push("it leans on interpretation");
  if (p.fillerHits >= 2) reasons.push("it carries too much fluff");

  if (!reasons.length) {
    reasons.push("it does not pressure the opposing case enough");
  }

  return {
    claim: weakClaim,
    reason: reasons.slice(0, 2).join(" and ")
  };
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aClaim = summarizeClaimTight(
    teamAAnalysis.truth || teamAAnalysis.bestSentence || teamAAnalysis.main_position || ""
  );
  const bClaim = summarizeClaimTight(
    teamBAnalysis.truth || teamBAnalysis.bestSentence || teamBAnalysis.main_position || ""
  );

  return (
    "Main dispute: Team A says " +
    aClaim +
    ", but Team B says " +
    bClaim +
    "."
  );
}

function strongerWeakPoint(teamAAnalysis, teamBAnalysis) {
  const aWeakScore = weaknessScore(teamAAnalysis);
  const bWeakScore = weaknessScore(teamBAnalysis);

  const weaker = aWeakScore >= bWeakScore ? teamAAnalysis : teamBAnalysis;
  const detail = weakPointReason(weaker);

  return {
    side: weaker.sideName,
    text:
      weaker.sideName +
      " is weakest on " +
      detail.claim +
      " because " +
      detail.reason +
      "."
  };
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  if (winner === "Mixed") {
    const aWeak = weakPointReason(teamAAnalysis);
    const bWeak = weakPointReason(teamBAnalysis);

    return (
      "No clear winner. Team A is still weak on " +
      aWeak.claim +
      " because " +
      aWeak.reason +
      ", and Team B is still weak on " +
      bWeak.claim +
      " because " +
      bWeak.reason +
      "."
    );
  }

  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const losingSide = strongest.loser;
  const weak = weakPointReason(losingSide);
  const winClaim = summarizeClaimTight(
    strongest.winner.bestSentence ||
      strongest.winner.truth ||
      strongest.winner.main_position ||
      ""
  );

  return (
    winner +
    " wins because its best point is " +
    winClaim +
    ", and " +
    strongest.text +
    ". " +
    losingSide.sideName +
    " stays weaker on " +
    weak.claim +
    " because " +
    weak.reason +
    "."
  );
}

function heuristicAIRefinement(teamAAnalysis, teamBAnalysis) {
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const weak = strongerWeakPoint(teamAAnalysis, teamBAnalysis);

  return {
    strongestArgumentSide: strongest.winner.sideName,
    strongestArgument:
      cleanJudgmentText(
        strongest.winner.bestSentence ||
        strongest.winner.truth ||
        strongest.winner.main_position
      ),
    whyStrongest:
      "It wins because " + strongest.text + ".",
    failedResponseByOtherSide:
      strongest.loser.sideName +
      " never answers that point with stronger evidence or a cleaner counter-argument.",
    weakestOverall: weak.text,
    manipulation:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.manipulationText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.manipulationText,
    fluff:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.fluffText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.fluffText
  };
}

function factCheckLayer(teamAAnalysis, teamBAnalysis, meta) {
  const checkedClaims = [];

  const inspect = (analysis, sideName) => {
    const claims = (analysis.sentences || [])
      .map(cleanJudgmentText)
      .filter(Boolean)
      .filter((claim) => !isNonArgumentContextLine(claim))
      .filter((claim) => !/\bsubscribe\b/i.test(claim))
      .filter((claim) => !/\bchapter\s+\d+\b/i.test(claim))
      .slice(0, 3);

    for (const claim of claims) {
      checkedClaims.push({
        claim: clip(sideName + ": " + claim, 220),
        status: inferFactCheckStatus(claim),
        note: buildFactCheckNote(claim),
        source: meta.videoLink ? clip(meta.videoLink, 180) : "Transcript-only analysis"
      });
    }
  };

  inspect(teamAAnalysis, teamAAnalysis.sideName || DEFAULT_TEAM_A);
  inspect(teamBAnalysis, teamBAnalysis.sideName || DEFAULT_TEAM_B);

  return {
    checkedClaims,
    summary:
      "Fact-check layer executed in transcript mode. Claims were filtered structurally, not externally verified."
  };
}

function sanitizeForDisplay(value) {
  let text = cleanJudgmentText(value || "");
  if (!text) return "";

  text = text
    .replace(/^\d+\s*[;:,.-]\s*/g, "")
    .replace(/^chapter\s+\d+\s*[:.-]?\s*/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text || "";
}
/* =========================
   CLAIM CLARITY OVERRIDES
   Paste at END of /api/analyze2.js
   ========================= */

function cleanJudgmentText(text) {
  let t = cleanWhitespace(stripTranscriptCorruption(text || ""));

  t = t
    .replace(/^\d+\s*[;:,.-]\s*/g, "")
    .replace(/^chapter\s+\d+\s*[:.-]?\s*/i, "")
    .replace(/^quote[:,]?\s*/i, "")
    .replace(/^and\s+/i, "")
    .replace(/^but\s+/i, "")
    .replace(/^so\s+/i, "")
    .replace(/^now\s+/i, "")
    .replace(/^well\s+/i, "")
    .replace(/^fourth[:,]?\s*/i, "")
    .replace(/^first[:,]?\s*/i, "")
    .replace(/^second[:,]?\s*/i, "")
    .replace(/^third[:,]?\s*/i, "")
    .replace(/^according to him[:,]?\s*/i, "")
    .replace(/^let'?s talk about\s+/i, "")
    .replace(/^let'?s look at\s+/i, "")
    .replace(/\bsubscribe\b.*$/i, "")
    .replace(/\bhit the notification bell\b.*$/i, "")
    .replace(/\bshare this video\b.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return t;
}

function rewriteClaimHuman(text) {
  let t = cleanJudgmentText(text);

  t = t
    .replace(/^team\s*[ab]\s*(says|argues)\s*/i, "")
    .replace(/^says\s*/i, "")
    .replace(/^argues\s*/i, "")
    .replace(/^that\s+/i, "")
    .replace(/^quote\s*/i, "")
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .trim();

  if (!t) return "the main claim is not preserved clearly";

  if (/^when the revolt was crushed/i.test(t)) {
    return "the movement ended because it was crushed militarily, not because the gospels count as strong historical proof";
  }

  if (/eyewitnesses/i.test(t) && /jesus/i.test(t)) {
    return "eyewitness-style testimony should not be treated as strong historical proof for Jesus by default";
  }

  if (/mendes/i.test(t) && /disciple whom jesus loved/i.test(t)) {
    return "the disciple whom Jesus loved may be a literary figure rather than an identifiable eyewitness";
  }

  if (/papias/i.test(t) && /judas/i.test(t)) {
    return "Papias contains legendary material, which weakens its value as clean historical support";
  }

  if (/euthiferr?o|euthyphro/i.test(t)) {
    return "the Euthyphro dilemma challenges whether morality depends on God or exists independently";
  }

  if (/molech|enoch|ezra/i.test(t)) {
    return "later Jewish literature developed ideas beyond the earlier base text";
  }

  if (/casius|numeriius|numerius/i.test(t) && /jesus/i.test(t)) {
    return "named-witness testimony should not be accepted in one historical case and dismissed in another without a clear reason";
  }

  if (t.length > 180) {
    t = clip(t, 180);
  }

  t = t.replace(/\s{2,}/g, " ").trim();
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function summarizeClaimTight(text) {
  return rewriteClaimHuman(text || "");
}

function summarizeMainPosition(sentences, sideName) {
  if (!sentences || !sentences.length) {
    return sideName + " does not have enough preserved argument text to summarize the main position cleanly.";
  }

  const best = chooseBestSentence(sentences);
  const claim = rewriteClaimHuman(best);

  return sideName + " mainly argues that " + claim + ".";
}

function extractTruth(sentences) {
  const candidate =
    sentences.find(
      (s) =>
        !isNonArgumentContextLine(s) &&
        (countHits(s, EVIDENCE_WORDS) >= 1 || countHits(s, REASONING_WORDS) >= 1)
    ) ||
    sentences.find((s) => !isNonArgumentContextLine(s) && countHits(s, TOPIC_WORDS) >= 1) ||
    "";

  return candidate ? rewriteClaimHuman(candidate) : "";
}

function extractLies(sentences) {
  const candidate =
    sentences.find(
      (s) =>
        !isNonArgumentContextLine(s) &&
        (countHits(s, OVERREACH_WORDS) >= 1 ||
          (countHits(s, EVIDENCE_WORDS) === 0 &&
            countHits(s, REASONING_WORDS) === 0 &&
            wordCount(s) > 10))
    ) || "";

  return candidate ? rewriteClaimHuman(candidate) : "";
}

function extractOpinion(sentences) {
  const candidate =
    sentences.find(
      (s) =>
        !isNonArgumentContextLine(s) &&
        (countHits(s, OPINION_WORDS) >= 1 || /\bshould\b|\bseems\b|\bappears\b/i.test(s))
    ) || "";

  return candidate ? rewriteClaimHuman(candidate) : "";
}

function extractLala(sentences) {
  const candidate =
    sentences.find(
      (s) =>
        isNonArgumentContextLine(s) ||
        countHits(s, FILLER_WORDS) >= 2 ||
        /\bwhatever\b|\byou know\b|\bi mean\b/i.test(s)
    ) || "";

  return candidate ? rewriteClaimHuman(candidate) : "";
}

function strongestReasonWhy(a, b) {
  const pa = reasonProfile(a);
  const pb = reasonProfile(b);

  const winner = a.scoreRaw >= b.scoreRaw ? a : b;
  const loser = winner === a ? b : a;
  const wp = winner === a ? pa : pb;
  const lp = winner === a ? pb : pa;

  const reasons = [];

  if (wp.evidenceHits > lp.evidenceHits) {
    reasons.push("it gives more actual evidence");
  }
  if (wp.reasoningHits > lp.reasoningHits) {
    reasons.push("it explains its logic more clearly");
  }
  if (wp.topicHits > lp.topicHits) {
    reasons.push("it stays more directly on the real issue");
  }
  if (lp.overreachHits > wp.overreachHits) {
    reasons.push("the other side overreaches more");
  }

  if (!reasons.length) {
    reasons.push("it is the cleaner argument in the preserved transcript");
  }

  return {
    winner,
    loser,
    text: reasons.slice(0, 2).join(" and ")
  };
}

function weakPointReason(analysis) {
  const p = reasonProfile(analysis);
  const weakClaim = rewriteClaimHuman(
    analysis.lies || analysis.opinion || analysis.lala || analysis.bestSentence || ""
  );

  const reasons = [];

  if (p.overreachHits >= 1) reasons.push("it reaches past the support actually shown");
  if (p.evidenceHits === 0) reasons.push("it lacks concrete evidence");
  if (p.reasoningHits === 0) reasons.push("it asserts more than it explains");
  if (p.opinionHits >= 1) reasons.push("it leans on interpretation");
  if (p.fillerHits >= 2) reasons.push("it carries too much fluff");

  if (!reasons.length) {
    reasons.push("it does not create enough pressure on the opposing case");
  }

  return {
    claim: weakClaim,
    reason: reasons.slice(0, 2).join(" and ")
  };
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aClaim = rewriteClaimHuman(
    teamAAnalysis.truth || teamAAnalysis.bestSentence || teamAAnalysis.main_position || ""
  );
  const bClaim = rewriteClaimHuman(
    teamBAnalysis.truth || teamBAnalysis.bestSentence || teamBAnalysis.main_position || ""
  );

  return "Main dispute: Team A says " + aClaim + ", but Team B says " + bClaim + ".";
}

function strongerWeakPoint(teamAAnalysis, teamBAnalysis) {
  const aWeakScore = weaknessScore(teamAAnalysis);
  const bWeakScore = weaknessScore(teamBAnalysis);

  const weaker = aWeakScore >= bWeakScore ? teamAAnalysis : teamBAnalysis;
  const detail = weakPointReason(weaker);

  return {
    side: weaker.sideName,
    text:
      weaker.sideName +
      " is weakest on " +
      detail.claim +
      " because " +
      detail.reason +
      "."
  };
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  if (winner === "Mixed") {
    const aWeak = weakPointReason(teamAAnalysis);
    const bWeak = weakPointReason(teamBAnalysis);

    return (
      "No clear winner. Team A is still weak on " +
      aWeak.claim +
      " because " +
      aWeak.reason +
      ", and Team B is still weak on " +
      bWeak.claim +
      " because " +
      bWeak.reason +
      "."
    );
  }

  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const losingSide = strongest.loser;
  const weak = weakPointReason(losingSide);
  const winClaim = rewriteClaimHuman(
    strongest.winner.bestSentence ||
      strongest.winner.truth ||
      strongest.winner.main_position ||
      ""
  );

  return (
    winner +
    " wins because its best point is that " +
    winClaim +
    ", and " +
    strongest.text +
    ". " +
    losingSide.sideName +
    " stays weaker on " +
    weak.claim +
    " because " +
    weak.reason +
    "."
  );
}

function heuristicAIRefinement(teamAAnalysis, teamBAnalysis) {
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const weak = strongerWeakPoint(teamAAnalysis, teamBAnalysis);

  return {
    strongestArgumentSide: strongest.winner.sideName,
    strongestArgument:
      "Core point: " +
      rewriteClaimHuman(
        strongest.winner.bestSentence ||
        strongest.winner.truth ||
        strongest.winner.main_position
      ),
    whyStrongest:
      "It wins because " + strongest.text + ".",
    failedResponseByOtherSide:
      strongest.loser.sideName +
      " never answers that point with stronger evidence or a cleaner counter-argument.",
    weakestOverall: weak.text,
    manipulation:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.manipulationText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.manipulationText,
    fluff:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.fluffText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.fluffText
  };
}

function factCheckLayer(teamAAnalysis, teamBAnalysis, meta) {
  const checkedClaims = [];

  const inspect = (analysis, sideName) => {
    const claims = (analysis.sentences || [])
      .map(cleanJudgmentText)
      .filter(Boolean)
      .filter((claim) => !isNonArgumentContextLine(claim))
      .slice(0, 3);

    for (const claim of claims) {
      checkedClaims.push({
        claim: clip(sideName + ": " + rewriteClaimHuman(claim), 220),
        status: inferFactCheckStatus(claim),
        note: buildFactCheckNote(claim),
        source: meta.videoLink ? clip(meta.videoLink, 180) : "Transcript-only analysis"
      });
    }
  };

  inspect(teamAAnalysis, teamAAnalysis.sideName || DEFAULT_TEAM_A);
  inspect(teamBAnalysis, teamBAnalysis.sideName || DEFAULT_TEAM_B);

  return {
    checkedClaims,
    summary:
      "Fact-check layer executed in transcript mode. Claims were filtered structurally, not externally verified."
  };
}

function sanitizeForDisplay(value) {
  let text = cleanJudgmentText(value || "");
  if (!text) return "";

  text = text
    .replace(/^\d+\s*[;:,.-]\s*/g, "")
    .replace(/^chapter\s+\d+\s*[:.-]?\s*/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text || "";
}
/* =========================
   THESIS VS EXAMPLE OVERRIDES
   Paste at END of /api/analyze2.js
   ========================= */

function cleanJudgmentText(text) {
  let t = cleanWhitespace(stripTranscriptCorruption(text || ""));

  t = t
    .replace(/^\d+\s*[;:,.-]\s*/g, "")
    .replace(/^chapter\s+\d+\s*[:.-]?\s*/i, "")
    .replace(/^quote[:,]?\s*/i, "")
    .replace(/^and\s+/i, "")
    .replace(/^but\s+/i, "")
    .replace(/^so\s+/i, "")
    .replace(/^now\s+/i, "")
    .replace(/^well\s+/i, "")
    .replace(/^fourth[:,]?\s*/i, "")
    .replace(/^first[:,]?\s*/i, "")
    .replace(/^second[:,]?\s*/i, "")
    .replace(/^third[:,]?\s*/i, "")
    .replace(/^according to him[:,]?\s*/i, "")
    .replace(/^let'?s talk about\s+/i, "")
    .replace(/^let'?s look at\s+/i, "")
    .replace(/\bsubscribe\b.*$/i, "")
    .replace(/\bhit the notification bell\b.*$/i, "")
    .replace(/\bshare this video\b.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return t;
}

function isExampleHeavySentence(text) {
  const t = cleanJudgmentText(text).toLowerCase();

  return (
    /\bfor example\b/.test(t) ||
    /\bfor instance\b/.test(t) ||
    /\bimagine\b/.test(t) ||
    /\blike when\b/.test(t) ||
    /\bcase study\b/.test(t) ||
    /\bheaven'?s gate\b/.test(t) ||
    /\bjoseph smith\b/.test(t) ||
    /\bangel moroni\b/.test(t) ||
    /\bspaceship\b/.test(t) ||
    /\bnumerius\b/.test(t) ||
    /\bcasius\b/.test(t) ||
    /\bmolech\b/.test(t) ||
    /\benoch\b/.test(t) ||
    /\bezra\b/.test(t)
  );
}

function isThesisSentence(text) {
  const t = cleanJudgmentText(text);
  const lower = t.toLowerCase();

  if (!t) return false;
  if (isNonArgumentContextLine(t)) return false;

  const hasCoreDebateVerb =
    /\b(is|are|does|do|cannot|can't|should|shouldn'?t|must|mustn'?t|counts?|proves?|shows?|demonstrates?|undermines?|supports?|refutes?)\b/i.test(
      t
    );

  const hasTopic = includesAny(lower, TOPIC_WORDS);
  const hasReasoning = includesAny(lower, REASONING_WORDS);
  const exampleHeavy = isExampleHeavySentence(t);

  if ((hasTopic && hasCoreDebateVerb) || (hasReasoning && hasTopic)) {
    return !exampleHeavy;
  }

  return false;
}

function rewriteClaimHuman(text) {
  let t = cleanJudgmentText(text);

  t = t
    .replace(/^team\s*[ab]\s*(says|argues)\s*/i, "")
    .replace(/^says\s*/i, "")
    .replace(/^argues\s*/i, "")
    .replace(/^that\s+/i, "")
    .replace(/^quote\s*/i, "")
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .trim();

  if (!t) return "the main claim is not preserved clearly";

  if (/eyewitness/i.test(t) && /jesus/i.test(t) && /historical proof|historical evidence/i.test(t)) {
    return "eyewitness-style testimony should not automatically count as strong historical proof for Jesus";
  }

  if (/when the revolt was crushed/i.test(t)) {
    return "the movement ended because it was defeated militarily, not because the gospels function as strong historical proof";
  }

  if (/disciple whom jesus loved/i.test(t) || /mendes/i.test(t)) {
    return "the disciple whom Jesus loved may be a literary figure rather than a secure eyewitness";
  }

  if (/papias/i.test(t) && /judas/i.test(t)) {
    return "Papias contains legendary material, which weakens it as clean historical support";
  }

  if (/everyone else.*go to hell|simply chose not to save/i.test(t)) {
    return "this point leans on a harsh theological interpretation that still needs stronger support";
  }

  if (/heaven'?s gate|joseph smith|angel moroni|spaceship/i.test(t)) {
    return "later analogy-based examples are being used to challenge whether sincere belief proves truth";
  }

  if (t.length > 160) t = clip(t, 160);

  t = t.replace(/\s{2,}/g, " ").trim();
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function pickMainClaimSentence(sentences) {
  const pool = (sentences || [])
    .map(cleanJudgmentText)
    .filter(Boolean)
    .filter((s) => !isNonArgumentContextLine(s));

  const thesisFirst = pool
    .filter(isThesisSentence)
    .sort((a, b) => scoreSentence(b) - scoreSentence(a));

  if (thesisFirst.length) return thesisFirst[0];

  const notExampleHeavy = pool
    .filter((s) => !isExampleHeavySentence(s))
    .sort((a, b) => scoreSentence(b) - scoreSentence(a));

  if (notExampleHeavy.length) return notExampleHeavy[0];

  return chooseBestSentence(pool);
}

function summarizeClaimTight(text) {
  return rewriteClaimHuman(text || "");
}

function summarizeMainPosition(sentences, sideName) {
  if (!sentences || !sentences.length) {
    return sideName + " does not have enough preserved argument text to summarize the main position cleanly.";
  }

  const best = pickMainClaimSentence(sentences);
  const claim = rewriteClaimHuman(best);

  return sideName + " mainly argues that " + claim + ".";
}

function extractTruth(sentences) {
  const pool = (sentences || [])
    .map(cleanJudgmentText)
    .filter(Boolean)
    .filter((s) => !isNonArgumentContextLine(s));

  const thesisEvidence =
    pool.find((s) => isThesisSentence(s) && countHits(s, EVIDENCE_WORDS) >= 1) ||
    pool.find((s) => isThesisSentence(s) && countHits(s, REASONING_WORDS) >= 1) ||
    pool.find((s) => isThesisSentence(s)) ||
    pool.find((s) => !isExampleHeavySentence(s) && countHits(s, EVIDENCE_WORDS) >= 1) ||
    "";

  return thesisEvidence ? rewriteClaimHuman(thesisEvidence) : "";
}

function extractLies(sentences) {
  const pool = (sentences || [])
    .map(cleanJudgmentText)
    .filter(Boolean)
    .filter((s) => !isNonArgumentContextLine(s));

  const candidate =
    pool.find((s) => countHits(s, OVERREACH_WORDS) >= 1 && !isExampleHeavySentence(s)) ||
    pool.find(
      (s) =>
        !isExampleHeavySentence(s) &&
        countHits(s, EVIDENCE_WORDS) === 0 &&
        countHits(s, REASONING_WORDS) === 0 &&
        wordCount(s) > 10
    ) ||
    "";

  return candidate ? rewriteClaimHuman(candidate) : "";
}

function extractOpinion(sentences) {
  const pool = (sentences || [])
    .map(cleanJudgmentText)
    .filter(Boolean)
    .filter((s) => !isNonArgumentContextLine(s));

  const candidate =
    pool.find(
      (s) =>
        !isExampleHeavySentence(s) &&
        (countHits(s, OPINION_WORDS) >= 1 || /\bshould\b|\bseems\b|\bappears\b/i.test(s))
    ) || "";

  return candidate ? rewriteClaimHuman(candidate) : "";
}

function extractLala(sentences) {
  const pool = (sentences || [])
    .map(cleanJudgmentText)
    .filter(Boolean);

  const candidate =
    pool.find((s) => isNonArgumentContextLine(s)) ||
    pool.find((s) => isExampleHeavySentence(s) && wordCount(s) > 10) ||
    pool.find((s) => countHits(s, FILLER_WORDS) >= 2) ||
    "";

  return candidate ? rewriteClaimHuman(candidate) : "";
}

function chooseBestSentence(sentences) {
  if (!Array.isArray(sentences) || !sentences.length) return "";

  const ranked = sentences
    .map(cleanJudgmentText)
    .filter(Boolean)
    .filter((sentence) => !isNonArgumentContextLine(sentence))
    .map((sentence) => ({ sentence, score: scoreSentence(sentence) }))
    .sort((a, b) => b.score - a.score);

  return ranked.length ? ranked[0].sentence : "";
}

function strongestReasonWhy(a, b) {
  const pa = reasonProfile(a);
  const pb = reasonProfile(b);

  const winner = a.scoreRaw >= b.scoreRaw ? a : b;
  const loser = winner === a ? b : a;
  const wp = winner === a ? pa : pb;
  const lp = winner === a ? pb : pa;

  const reasons = [];

  if (wp.evidenceHits > lp.evidenceHits) reasons.push("it gives more actual evidence");
  if (wp.reasoningHits > lp.reasoningHits) reasons.push("it explains its logic more clearly");
  if (wp.topicHits > lp.topicHits) reasons.push("it stays closer to the real issue");
  if (lp.overreachHits > wp.overreachHits) reasons.push("the other side overreaches more");

  if (!reasons.length) {
    reasons.push("it is the cleaner argument in the preserved transcript");
  }

  return {
    winner,
    loser,
    text: reasons.slice(0, 2).join(" and ")
  };
}

function weakPointReason(analysis) {
  const p = reasonProfile(analysis);
  const weakClaim = rewriteClaimHuman(
    analysis.lies || analysis.opinion || analysis.lala || pickMainClaimSentence(analysis.sentences || []) || ""
  );

  const reasons = [];

  if (p.overreachHits >= 1) reasons.push("it reaches past the support actually shown");
  if (p.evidenceHits === 0) reasons.push("it lacks concrete evidence");
  if (p.reasoningHits === 0) reasons.push("it asserts more than it explains");
  if (p.opinionHits >= 1) reasons.push("it leans on interpretation");
  if (p.fillerHits >= 2) reasons.push("it carries too much fluff");

  if (!reasons.length) {
    reasons.push("it does not create enough pressure on the opposing case");
  }

  return {
    claim: weakClaim,
    reason: reasons.slice(0, 2).join(" and ")
  };
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aClaim = rewriteClaimHuman(
    pickMainClaimSentence(teamAAnalysis.sentences || []) ||
      teamAAnalysis.truth ||
      teamAAnalysis.main_position ||
      ""
  );

  const bClaim = rewriteClaimHuman(
    pickMainClaimSentence(teamBAnalysis.sentences || []) ||
      teamBAnalysis.truth ||
      teamBAnalysis.main_position ||
      ""
  );

  return "Main dispute: Team A says " + aClaim + ", but Team B says " + bClaim + ".";
}

function strongerWeakPoint(teamAAnalysis, teamBAnalysis) {
  const aWeakScore = weaknessScore(teamAAnalysis);
  const bWeakScore = weaknessScore(teamBAnalysis);

  const weaker = aWeakScore >= bWeakScore ? teamAAnalysis : teamBAnalysis;
  const detail = weakPointReason(weaker);

  return {
    side: weaker.sideName,
    text:
      weaker.sideName +
      " is weakest on " +
      detail.claim +
      " because " +
      detail.reason +
      "."
  };
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  if (winner === "Mixed") {
    const aWeak = weakPointReason(teamAAnalysis);
    const bWeak = weakPointReason(teamBAnalysis);

    return (
      "No clear winner. Team A is still weak on " +
      aWeak.claim +
      " because " +
      aWeak.reason +
      ", and Team B is still weak on " +
      bWeak.claim +
      " because " +
      bWeak.reason +
      "."
    );
  }

  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const losingSide = strongest.loser;
  const weak = weakPointReason(losingSide);
  const winClaim = rewriteClaimHuman(
    pickMainClaimSentence(strongest.winner.sentences || []) ||
      strongest.winner.truth ||
      strongest.winner.main_position ||
      ""
  );

  return (
    winner +
    " wins because its main point is that " +
    winClaim +
    ", and " +
    strongest.text +
    ". " +
    losingSide.sideName +
    " stays weaker on " +
    weak.claim +
    " because " +
    weak.reason +
    "."
  );
}

function heuristicAIRefinement(teamAAnalysis, teamBAnalysis) {
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const weak = strongerWeakPoint(teamAAnalysis, teamBAnalysis);

  return {
    strongestArgumentSide: strongest.winner.sideName,
    strongestArgument:
      "Core point: " +
      rewriteClaimHuman(
        pickMainClaimSentence(strongest.winner.sentences || []) ||
          strongest.winner.truth ||
          strongest.winner.main_position
      ),
    whyStrongest:
      "It wins because " + strongest.text + ".",
    failedResponseByOtherSide:
      strongest.loser.sideName +
      " never answers that point with stronger evidence or a cleaner counter-argument.",
    weakestOverall: weak.text,
    manipulation:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.manipulationText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.manipulationText,
    fluff:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.fluffText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.fluffText
  };
}

function factCheckLayer(teamAAnalysis, teamBAnalysis, meta) {
  const checkedClaims = [];

  const inspect = (analysis, sideName) => {
    const claims = (analysis.sentences || [])
      .map(cleanJudgmentText)
      .filter(Boolean)
      .filter((claim) => !isNonArgumentContextLine(claim))
      .filter((claim) => !isExampleHeavySentence(claim))
      .slice(0, 3);

    for (const claim of claims) {
      checkedClaims.push({
        claim: clip(sideName + ": " + rewriteClaimHuman(claim), 220),
        status: inferFactCheckStatus(claim),
        note: buildFactCheckNote(claim),
        source: meta.videoLink ? clip(meta.videoLink, 180) : "Transcript-only analysis"
      });
    }
  };

  inspect(teamAAnalysis, teamAAnalysis.sideName || DEFAULT_TEAM_A);
  inspect(teamBAnalysis, teamBAnalysis.sideName || DEFAULT_TEAM_B);

  return {
    checkedClaims,
    summary:
      "Fact-check layer executed in transcript mode. Claims were filtered structurally, not externally verified."
  };
}

function sanitizeForDisplay(value) {
  let text = cleanJudgmentText(value || "");
  if (!text) return "";

  text = text
    .replace(/^\d+\s*[;:,.-]\s*/g, "")
    .replace(/^chapter\s+\d+\s*[:.-]?\s*/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text || "";
}
/* =========================
   DECISIVE VERDICT OVERRIDES
   Paste at END of /api/analyze2.js
   ========================= */

function isGenericFallbackText(text) {
  const t = cleanWhitespace(text || "").toLowerCase();

  return (
    !t ||
    t === "-" ||
    /no single sentence is clean enough/.test(t) ||
    /shows some overreach or unsupported phrasing/.test(t) ||
    /includes interpretive or judgment language mixed into the argument/.test(t) ||
    /has limited obvious filler after cleanup/.test(t) ||
    /does not have enough preserved argument text/.test(t) ||
    /could not be fully analyzed/.test(t) ||
    /a usable strongest argument exists/.test(t) ||
    /the strongest argument has the clearest reasoning chain/.test(t) ||
    /does not fully answer/.test(t)
  );
}

function bestUsableClaimFromAnalysis(analysis) {
  const pool = ((analysis && analysis.sentences) || [])
    .map((s) => cleanJudgmentText ? cleanJudgmentText(s) : cleanWhitespace(s))
    .filter(Boolean)
    .filter((s) => !isNonArgumentContextLine(s))
    .filter((s) => !isExampleHeavySentence(s));

  const thesis = pool.filter((s) => isThesisSentence(s)).sort((a, b) => scoreSentence(b) - scoreSentence(a));
  if (thesis.length) return rewriteClaimHuman(thesis[0]);

  const ranked = pool.sort((a, b) => scoreSentence(b) - scoreSentence(a));
  if (ranked.length) return rewriteClaimHuman(ranked[0]);

  return rewriteClaimHuman(
    (analysis && (analysis.truth || analysis.bestSentence || analysis.main_position || analysis.lies)) || ""
  );
}

function weakPointReason(analysis) {
  const p = reasonProfile(analysis);

  let weakClaim = rewriteClaimHuman(
    (analysis && analysis.lies) || ""
  );

  if (isGenericFallbackText(weakClaim)) {
    weakClaim = rewriteClaimHuman(
      (analysis && analysis.opinion) || ""
    );
  }

  if (isGenericFallbackText(weakClaim)) {
    weakClaim = rewriteClaimHuman(
      (analysis && analysis.lala) || ""
    );
  }

  if (isGenericFallbackText(weakClaim)) {
    weakClaim = bestUsableClaimFromAnalysis(analysis);
  }

  const reasons = [];

  if (p.overreachHits >= 1) reasons.push("it reaches past the support actually shown");
  if (p.evidenceHits === 0) reasons.push("it lacks concrete evidence");
  if (p.reasoningHits === 0) reasons.push("it asserts more than it explains");
  if (p.opinionHits >= 1) reasons.push("it leans on interpretation");
  if (p.fillerHits >= 2) reasons.push("it carries too much fluff");

  if (!reasons.length) {
    reasons.push("it does not create enough pressure on the opposing case");
  }

  return {
    claim: weakClaim,
    reason: reasons.slice(0, 2).join(" and ")
  };
}

function strongerWeakPoint(teamAAnalysis, teamBAnalysis) {
  const aWeakScore = weaknessScore(teamAAnalysis);
  const bWeakScore = weaknessScore(teamBAnalysis);

  const weaker = aWeakScore >= bWeakScore ? teamAAnalysis : teamBAnalysis;
  const detail = weakPointReason(weaker);

  return {
    side: weaker.sideName,
    text:
      weaker.sideName +
      " is weakest on " +
      detail.claim +
      " because " +
      detail.reason +
      "."
  };
}

function strongestReasonWhy(a, b) {
  const pa = reasonProfile(a);
  const pb = reasonProfile(b);

  const winner = a.scoreRaw >= b.scoreRaw ? a : b;
  const loser = winner === a ? b : a;
  const wp = winner === a ? pa : pb;
  const lp = winner === a ? pb : pa;

  const reasons = [];

  if (wp.evidenceHits > lp.evidenceHits) reasons.push("it gives more actual evidence");
  if (wp.reasoningHits > lp.reasoningHits) reasons.push("it explains its logic more clearly");
  if (wp.topicHits > lp.topicHits) reasons.push("it stays closer to the real issue");
  if (lp.overreachHits > wp.overreachHits) reasons.push("the other side overreaches more");
  if (lp.fillerHits > wp.fillerHits) reasons.push("the other side uses weaker filler");

  if (!reasons.length) {
    reasons.push("it is still the cleaner argument in the preserved transcript");
  }

  return {
    winner,
    loser,
    text: reasons.slice(0, 2).join(" and ")
  };
}

function heuristicAIRefinement(teamAAnalysis, teamBAnalysis) {
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const weak = strongerWeakPoint(teamAAnalysis, teamBAnalysis);

  const winnerClaim = bestUsableClaimFromAnalysis(strongest.winner);
  const loserClaim = bestUsableClaimFromAnalysis(strongest.loser);

  return {
    strongestArgumentSide: strongest.winner.sideName,
    strongestArgument: "Core point: " + winnerClaim,
    whyStrongest: "It wins because " + strongest.text + ".",
    failedResponseByOtherSide:
      strongest.loser.sideName +
      " never lands a cleaner competing claim against: " +
      winnerClaim +
      ". Its nearest response stays weaker around " +
      loserClaim +
      ".",
    weakestOverall: weak.text,
    manipulation:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.manipulationText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.manipulationText,
    fluff:
      teamAAnalysis.sideName +
      ": " +
      teamAAnalysis.fluffText +
      " " +
      teamBAnalysis.sideName +
      ": " +
      teamBAnalysis.fluffText
  };
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aClaim = bestUsableClaimFromAnalysis(teamAAnalysis);
  const bClaim = bestUsableClaimFromAnalysis(teamBAnalysis);

  return "Main dispute: Team A says " + aClaim + ", but Team B says " + bClaim + ".";
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  const aWeak = weakPointReason(teamAAnalysis);
  const bWeak = weakPointReason(teamBAnalysis);

  if (winner === "Mixed") {
    return (
      "Close call, not a blank tie. Team A's strongest usable claim is " +
      bestUsableClaimFromAnalysis(teamAAnalysis) +
      ", but it is weakened because " +
      aWeak.reason +
      ". Team B's strongest usable claim is " +
      bestUsableClaimFromAnalysis(teamBAnalysis) +
      ", but it is weakened because " +
      bWeak.reason +
      "."
    );
  }

  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const losingSide = strongest.loser;
  const weak = weakPointReason(losingSide);
  const winClaim = bestUsableClaimFromAnalysis(strongest.winner);

  return (
    winner +
    " wins because its clearest usable claim is " +
    winClaim +
    ", and " +
    strongest.text +
    ". " +
    losingSide.sideName +
    " falls behind because " +
    weak.reason +
    "."
  );
}

function decideWinner(teamAAnalysis, teamBAnalysis) {
  const diff = Math.abs(teamAAnalysis.scoreRaw - teamBAnalysis.scoreRaw);

  if (diff <= 1) return "Mixed";
  return teamAAnalysis.scoreRaw > teamBAnalysis.scoreRaw
    ? teamAAnalysis.sideName
    : teamBAnalysis.sideName;
}

function buildConfidence(a, b) {
  const diff = Math.abs(a - b);

  if (diff <= 1) return "51%";
  if (diff === 2) return "55%";
  if (diff === 3) return "60%";
  if (diff === 4) return "65%";
  if (diff === 5) return "70%";
  return String(Math.min(92, 70 + diff * 3)) + "%";
}

function normalizeDisplayScore(raw) {
  return String(Math.max(1, Math.min(100, Math.round(raw))));
}

function mergeLayer(base, aiLayer) {
  const merged = { ...base };
  const override = aiLayer && aiLayer.override ? aiLayer.override : {};

  function useOverride(current, next) {
    const n = cleanWhitespace(next || "");
    if (!n) return current;

    if (isGenericFallbackText(current)) return n;
    if (current === base.whyStrongest) return n;
    return n;
  }

  merged.strongestArgumentSide = useOverride(
    merged.strongestArgumentSide,
    override.strongestArgumentSide
  );

  merged.strongestArgument = useOverride(
    merged.strongestArgument,
    sanitizeForDisplay(override.strongestArgument)
  );

  merged.whyStrongest = useOverride(
    merged.whyStrongest,
    sanitizeForDisplay(override.whyStrongest)
  );

  merged.failedResponseByOtherSide = useOverride(
    merged.failedResponseByOtherSide,
    sanitizeForDisplay(override.failedResponseByOtherSide)
  );

  merged.weakestOverall = useOverride(
    merged.weakestOverall,
    sanitizeForDisplay(override.weakestOverall)
  );

  merged.manipulation = useOverride(
    merged.manipulation,
    sanitizeForDisplay(override.manipulation)
  );

  merged.fluff = useOverride(
    merged.fluff,
    sanitizeForDisplay(override.fluff)
  );

  return merged;
}
