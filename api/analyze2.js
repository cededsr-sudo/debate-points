"use strict";

/**
 * /api/analyze2.js
 *
 * Complete self-contained backend endpoint for Debate Judgment Engine.
 * Keeps the existing frontend contract.
 * Always returns valid JSON via res.json(...)
 */

const DEFAULT_TEAM_A = "Team A";
const DEFAULT_TEAM_B = "Team B";
const ANALYSIS_MODE = "deterministic+factcheck+ai-refinement+merge";

module.exports = async function analyze2Handler(req, res) {
  try {
    const body = req && req.body && typeof req.body === "object" ? req.body : {};

    const teamAName =
      safeText(body.teamAName || body.teamA || body.speakerA || body.nameA) ||
      DEFAULT_TEAM_A;

    const teamBName =
      safeText(body.teamBName || body.teamB || body.speakerB || body.nameB) ||
      DEFAULT_TEAM_B;

    const videoLink = safeText(body.videoLink || "");
    const transcriptRaw = getTranscriptFromBody(body);

    const cleanedTranscript = cleanTranscript(transcriptRaw);

    const extracted = extractSides({
      transcriptRaw,
      cleanedTranscript,
      teamAName,
      teamBName
    });

    const teamASelected = selectArgumentSentences(extracted.teamAText);
    const teamBSelected = selectArgumentSentences(extracted.teamBText);

    const teamAAnalysis = deterministicAnalysis(teamASelected, teamAName);
    const teamBAnalysis = deterministicAnalysis(teamBSelected, teamBName);

    const factLayer = factCheckLayer(teamAAnalysis, teamBAnalysis, {
      teamAName,
      teamBName,
      videoLink
    });

    const aiLayer = await aiRefinementLayer(teamAAnalysis, teamBAnalysis, {
      teamAName,
      teamBName,
      videoLink,
      promptOverride: safeText(
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
  } catch (err) {
    return res.json(buildFailureResponse(req, err));
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

function safeText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function cleanWhitespace(value) {
  return safeText(value);
}

function clip(text, max) {
  const limit = typeof max === "number" ? max : 320;
  const t = cleanWhitespace(text);
  if (!t) return "";
  if (t.length <= limit) return t;
  return t.slice(0, limit - 3).trim() + "...";
}

function wordCount(text) {
  const t = cleanWhitespace(text);
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function uniquePreserveOrder(items) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const cleaned = cleanWhitespace(item);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }

  return out;
}

function countHits(text, words) {
  const lower = cleanWhitespace(text).toLowerCase();
  let count = 0;
  for (const word of words) {
    if (lower.includes(word)) count += 1;
  }
  return count;
}

function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* Dictionaries                                                       */
/* ------------------------------------------------------------------ */

const FILLER_WORDS = [
  "um",
  "uh",
  "er",
  "ah",
  "basically",
  "literally",
  "kind of",
  "sort of",
  "you know",
  "i mean",
  "like"
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
  "consequently",
  "follows",
  "implies",
  "proves",
  "shows",
  "demonstrates",
  "as a result",
  "so that"
];

const EVIDENCE_WORDS = [
  "data",
  "study",
  "studies",
  "evidence",
  "example",
  "examples",
  "for example",
  "for instance",
  "according to",
  "report",
  "reports",
  "document",
  "documents",
  "history",
  "source",
  "sources",
  "research",
  "facts",
  "record",
  "records",
  "statistic",
  "statistics",
  "observation",
  "observations",
  "experiment",
  "experiments"
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
  "should",
  "appears"
];

const OVERREACH_WORDS = [
  "always",
  "never",
  "everyone",
  "nobody",
  "all of them",
  "completely",
  "obviously",
  "100%",
  "proved everything",
  "absolutely all",
  "cannot possibly",
  "every single"
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
  /\bpodcast\b/i,
  /\bpatreon\b/i,
  /\bsponsored by\b/i,
  /\bfollow me on\b/i,
  /\bcheck out my\b/i,
  /\bmy channel\b/i,
  /\bour channel\b/i,
  /\bwe have a great show\b/i,
  /\blet's get started\b/i,
  /\bwithout further ado\b/i,
  /\btonight's debate\b/i,
  /\btoday's debate\b/i,
  /\bjoin us\b/i,
  /\bintroducing\b/i,
  /\bround of applause\b/i,
  /\bthat concludes our debate\b/i,
  /\bthat concludes the proceedings\b/i,
  /\btake care everyone\b/i,
  /\bhope you found this interesting\b/i
];

const MODERATOR_HINTS = [
  "moderator",
  "host",
  "interviewer",
  "panelist",
  "panel",
  "facilitator",
  "question:"
];

const STAGE_DIRECTION_PATTERNS = [
  /\[[^\]]{0,100}\]/g,
  /\((?:music|applause|laughter|laughing|cheering|intro|outro|crosstalk|silence|background noise)[^)]*\)/gi
];

const CLEAN_TIMESTAMP_PATTERNS = [
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /\b\d+\s*hours?,?\s*\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi,
  /\b\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi,
  /\b\d+\s*hours?\b/gi,
  /\b\d+\s*minutes?\b/gi,
  /\b\d+\s*seconds?\b/gi
];

/* ------------------------------------------------------------------ */
/* Corruption cleanup                                                 */
/* ------------------------------------------------------------------ */

function cleanTranscript(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return "";

  let normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  normalized = normalized
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  const rawLines = normalized
    .split("\n")
    .flatMap((line) => splitLineIntoSegments(line))
    .map((line) => cleanWhitespace(line))
    .filter(Boolean);

  const cleanedLines = [];

  for (let line of rawLines) {
    line = stripTranscriptCorruption(line);
    line = stripSpeakerPrefix(line);
    line = cleanWhitespace(line);

    if (!line) continue;
    if (isLikelySetupLine(line)) continue;
    if (isLikelyModeratorLine(line) && wordCount(line) < 18) continue;
    if (looksMostlyCorrupt(line)) continue;

    cleanedLines.push(line);
  }

  return uniquePreserveOrder(cleanedLines).join("\n");
}

function splitLineIntoSegments(line) {
  const value = typeof line === "string" ? line : "";
  if (!value.trim()) return [];

  let working = value;

  working = working
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

  for (const re of CLEAN_TIMESTAMP_PATTERNS) {
    line = line.replace(re, " ");
  }

  line = line
    .replace(/\b\d{1,4}\s*hour,,?\b/gi, " ")
    .replace(/\b\d{1,4}\s*hours?,,?\b/gi, " ")
    .replace(/\b\d{1,4}\s*minutes?,,?\b/gi, " ")
    .replace(/\b\d{1,4}\s*seconds?,,?\b/gi, " ")
    .replace(/(^|\s):\d{1,4}\b/g, " ")
    .replace(/\b\d{1,3}[;:,]\s*\d{1,3}\s*seconds?\b/gi, " ")
    .replace(/\b\d{1,3}[;:,]\s*\d{1,3}\s*minutes?\b/gi, " ")
    .replace(/\b\d{1,3}[;:,]\s*\d{1,3}\s*hours?\b/gi, " ")
    .replace(/\b\d+\s*seconds(?=[a-z])/gi, " ")
    .replace(/\b\d+\s*minutes(?=[a-z])/gi, " ")
    .replace(/\b\d+\s*hours(?=[a-z])/gi, " ")
    .replace(/\bseconds(?=[A-Z])/g, " ")
    .replace(/\bminutes(?=[A-Z])/g, " ")
    .replace(/\bhours(?=[A-Z])/g, " ")
    .replace(/\b\d{1,3}[;:,]\b/g, " ")
    .replace(/\b\d+\s*\/\s*\d+\b/g, " ")
    .replace(/\^\s*of\s*\d+/gi, " ")
    .replace(/\b1\s*\/\s*10\b/gi, " ")
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
  const t = cleanWhitespace(line);
  if (!t) return true;

  const wc = wordCount(t);
  if (wc < 4) return true;

  const digitClusters = (t.match(/\d+/g) || []).length;
  const weirdPunct = (t.match(/[;:]/g) || []).length;
  const brokenTimeGlue =
    /\b\d+\s*seconds\s+[a-z]/i.test(t) ||
    /\b\d+\s*minutes\s+[a-z]/i.test(t) ||
    /(^|\s):\d{1,4}\b/.test(t) ||
    /\bhour,,/i.test(t);

  if (brokenTimeGlue) return true;
  if (digitClusters >= 4 && wc <= 18) return true;
  if (weirdPunct >= 3 && wc <= 20) return true;

  return false;
}

function containsCorruption(sentence) {
  const s = cleanWhitespace(sentence);
  if (!s) return true;

  return (
    looksMostlyCorrupt(s) ||
    /\b\d+\s*seconds\s+[a-z]/i.test(s) ||
    /\b\d+\s*minutes\s+[a-z]/i.test(s) ||
    /\b\d+\s*hours\s+[a-z]/i.test(s) ||
    /(^|\s):\d{1,4}\b/.test(s) ||
    /\bhour,,/i.test(s) ||
    /\b\d{1,3}[;:,]\s*\d{1,3}\b/.test(s)
  );
}

/* ------------------------------------------------------------------ */
/* Setup / moderator detection                                        */
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
  if (/^(next question|time starts now|your time starts now)\b/i.test(t)) return true;

  return MODERATOR_HINTS.some((hint) => t.includes(hint));
}

/* ------------------------------------------------------------------ */
/* Side extraction                                                    */
/* ------------------------------------------------------------------ */

function extractSides(args) {
  const text = args.cleanedTranscript || args.transcriptRaw || "";
  const lines = String(text)
    .split("\n")
    .map((line) => cleanWhitespace(line))
    .filter(Boolean);

  if (!lines.length) {
    return { teamAText: "", teamBText: "" };
  }

  const explicit = extractByExplicitSpeakerLabels(
    lines,
    args.teamAName,
    args.teamBName
  );

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

  const alternating = fallbackSplitSides(lines);
  return {
    teamAText: alternating.teamA.join(" "),
    teamBText: alternating.teamB.join(" ")
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

  for (const line of lines) {
    if (isLikelyModeratorLine(line)) continue;

    if (aPatterns.some((re) => re.test(line))) {
      const cleaned = cleanWhitespace(line.replace(/^[^:\-]+[:\-]\s*/, ""));
      if (isRealArgumentSentence(cleaned)) teamA.push(cleaned);
      continue;
    }

    if (bPatterns.some((re) => re.test(line))) {
      const cleaned = cleanWhitespace(line.replace(/^[^:\-]+[:\-]\s*/, ""));
      if (isRealArgumentSentence(cleaned)) teamB.push(cleaned);
    }
  }

  return {
    teamA: uniquePreserveOrder(teamA),
    teamB: uniquePreserveOrder(teamB)
  };
}

function splitByBlocks(lines) {
  const eligible = lines.filter(
    (line) =>
      !isLikelyModeratorLine(line) &&
      !isLikelySetupLine(line) &&
      isRealArgumentSentence(line)
  );

  if (!eligible.length) return { teamA: [], teamB: [] };

  const midpoint = Math.ceil(eligible.length / 2);

  const firstHalf = eligible.slice(0, midpoint);
  const secondHalf = eligible.slice(midpoint);

  const teamA = [];
  const teamB = [];

  for (const line of firstHalf) {
    if (isRealArgumentSentence(line)) teamA.push(line);
  }

  for (const line of secondHalf) {
    if (isRealArgumentSentence(line)) teamB.push(line);
  }

  if (!hasRealSideContent(teamA) || !hasRealSideContent(teamB)) {
    return { teamA: [], teamB: [] };
  }

  return {
    teamA: uniquePreserveOrder(teamA),
    teamB: uniquePreserveOrder(teamB)
  };
}

function fallbackSplitSides(lines) {
  const eligible = lines.filter(
    (line) =>
      !isLikelyModeratorLine(line) &&
      !isLikelySetupLine(line) &&
      isRealArgumentSentence(line)
  );

  const teamA = [];
  const teamB = [];

  for (let i = 0; i < eligible.length; i += 1) {
    if (i % 2 === 0) teamA.push(eligible[i]);
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
  const t = cleanWhitespace(line);
  if (!t) return false;
  if (wordCount(t) < 8) return false;
  if (isLikelySetupLine(t)) return false;
  if (isLikelyModeratorLine(t) && wordCount(t) < 20) return false;
  if (/^(thanks|thank you|okay|alright|right|sure)\b/i.test(t)) return false;
  if (containsCorruption(t)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Sentence selection                                                 */
/* ------------------------------------------------------------------ */

function toSentences(text) {
  const value = cleanWhitespace(text);
  if (!value) return [];

  let working = value
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ");

  const raw = working
    .split(/(?<=[.!?])\s+/)
    .map((s) => cleanWhitespace(s))
    .filter(Boolean);

  return uniquePreserveOrder(raw);
}

function selectArgumentSentences(text) {
  const sentences = toSentences(text);

  const candidates = sentences
    .map((sentence) => stripTranscriptCorruption(sentence))
    .map((sentence) => cleanWhitespace(sentence))
    .filter(Boolean)
    .filter(isRealArgumentSentence);

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
  let score = 0;
  const wc = wordCount(sentence);

  score += Math.min(wc, 28);
  score += countHits(sentence, REASONING_WORDS) * 8;
  score += countHits(sentence, EVIDENCE_WORDS) * 7;
  score += countHits(sentence, OPINION_WORDS) * 2;
  score -= countHits(sentence, FILLER_WORDS) * 3;

  if (/\d/.test(sentence)) score += 1;
  if (/for example|for instance|according to/i.test(sentence)) score += 6;
  if (/because/i.test(sentence)) score += 6;
  if (wc > 10 && wc < 45) score += 5;
  if (wc < 8) score -= 20;
  if (wc > 60) score -= 8;
  if (containsCorruption(sentence)) score -= 50;

  return score;
}

/* ------------------------------------------------------------------ */
/* Deterministic analysis                                             */
/* ------------------------------------------------------------------ */

function deterministicAnalysis(sentences, sideName) {
  const safeSentences = Array.isArray(sentences)
    ? sentences.map((s) => cleanWhitespace(stripTranscriptCorruption(s))).filter(isRealArgumentSentence)
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
  const integrityText = buildIntegrityText(safeSentences, truth, lies, opinion);
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

  return sideName + " mainly argues: " + clip(best, 260);
}

function extractTruth(sentences) {
  const candidate =
    sentences.find((s) => countHits(s, EVIDENCE_WORDS) >= 1 && !containsCorruption(s)) ||
    sentences.find((s) => countHits(s, REASONING_WORDS) >= 1 && !containsCorruption(s)) ||
    sentences.find((s) => !containsCorruption(s)) ||
    "";

  return candidate ? clip(candidate, 300) : "";
}

function extractLies(sentences) {
  const candidate =
    sentences.find((s) => countHits(s, OVERREACH_WORDS) >= 1 && !containsCorruption(s)) ||
    sentences.find(
      (s) =>
        !containsCorruption(s) &&
        countHits(s, EVIDENCE_WORDS) === 0 &&
        countHits(s, OPINION_WORDS) === 0 &&
        wordCount(s) > 10
    ) ||
    "";

  return candidate ? clip(candidate, 300) : "";
}

function extractOpinion(sentences) {
  const candidate =
    sentences.find((s) => countHits(s, OPINION_WORDS) >= 1 && !containsCorruption(s)) ||
    sentences.find((s) => /\bshould\b|\bseems\b|\bappears\b/i.test(s) && !containsCorruption(s)) ||
    "";

  return candidate ? clip(candidate, 300) : "";
}

function extractLala(sentences) {
  const candidate =
    sentences.find((s) => countHits(s, FILLER_WORDS) >= 2 && !containsCorruption(s)) ||
    sentences.find((s) => /\bwhatever\b|\byou know\b|\bi mean\b/i.test(s) && !containsCorruption(s)) ||
    "";

  return candidate ? clip(candidate, 300) : "";
}

function chooseBestSentence(sentences) {
  if (!Array.isArray(sentences) || !sentences.length) return "";
  const ranked = sentences
    .filter((s) => !containsCorruption(s))
    .map((s) => ({ sentence: s, score: scoreSentence(s) }))
    .sort((a, b) => b.score - a.score);

  return ranked.length ? ranked[0].sentence : "";
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
    "statistics"
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

function buildIntegrityText(sentences, truth, lies, opinion) {
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
  const overreach = sentences.reduce((n, s) => n + countHits(s, OVERREACH_WORDS), 0);
  const filler = sentences.reduce((n, s) => n + countHits(s, FILLER_WORDS), 0);

  let score =
    50 +
    reasoning * 4 +
    evidence * 4 +
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

  const inspect = (analysis) => {
    const claims = analysis.sentences
      .filter((claim) => !containsCorruption(claim))
      .slice(0, 3);

    for (const claim of claims) {
      checkedClaims.push({
        claim: clip(claim, 220),
        status: inferFactCheckStatus(claim),
        note: buildFactCheckNote(claim),
        source: meta.videoLink ? clip(meta.videoLink, 180) : "Transcript-only analysis"
      });
    }
  };

  inspect(teamAAnalysis);
  inspect(teamBAnalysis);

  return {
    checkedClaims,
    summary:
      "Fact-check layer executed in transcript mode. Claims were flagged structurally, not externally verified."
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
    "- Prefer better wording over emptiness.\n" +
    "- Replace weak deterministic text with stronger concise analysis.\n" +
    "- Do not remove structure.\n\n" +
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

  const weakerAnalysis =
    strongerIsA(teamAAnalysis, teamBAnalysis) ? teamBAnalysis : teamAAnalysis;

  return {
    strongestArgumentSide: strongestSide,
    strongestArgument: strongestArgument,
    whyStrongest:
      "It is more grounded and supported than the strongest competing point on the other side.",
    failedResponseByOtherSide:
      weakerSide + " does not clearly neutralize the opposing best point in the preserved transcript.",
    weakestOverall:
      weakerAnalysis.bestSentence && !containsCorruption(weakerAnalysis.bestSentence)
        ? weakerAnalysis.sideName + ": " + weakerAnalysis.bestSentence
        : weakerAnalysis.sideName + ": " + weakerAnalysis.lies,
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
      teamAAnalysis.fluffText === "Low fluff after cleanup." &&
      teamBAnalysis.fluffText === "Low fluff after cleanup."
        ? "Low overall fluff after cleanup."
        : teamAAnalysis.sideName +
          ": " +
          teamAAnalysis.fluffText +
          " " +
          teamBAnalysis.sideName +
          ": " +
          teamBAnalysis.fluffText
  };
}

function strongerIsA(teamAAnalysis, teamBAnalysis) {
  return teamAAnalysis.scoreRaw >= teamBAnalysis.scoreRaw;
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

  const strongestIsA = teamAAnalysis.scoreRaw >= teamBAnalysis.scoreRaw;
  const weakerAnalysis = strongestIsA ? teamBAnalysis : teamAAnalysis;
  const weakerName = strongestIsA ? teamBName : teamAName;

  const weakestRealSentence =
    weakerAnalysis.sentences.find((s) => countHits(s, OVERREACH_WORDS) >= 1 && !containsCorruption(s)) ||
    weakerAnalysis.sentences.find((s) => !containsCorruption(s)) ||
    "";

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

    strongestArgumentSide: strongestIsA ? teamAName : teamBName,
    strongestArgument: strongestIsA
      ? teamAAnalysis.bestSentence
      : teamBAnalysis.bestSentence,
    whyStrongest:
      "The strongest argument has the clearest reasoning chain and the least unsupported inflation.",
    failedResponseByOtherSide: strongestIsA
      ? teamBName + " does not fully answer " + teamAName + "'s strongest point in the preserved transcript."
      : teamAName + " does not fully answer " + teamBName + "'s strongest point in the preserved transcript.",
    weakestOverall: weakestRealSentence
      ? weakerName + ": " + weakestRealSentence
      : weakerName + ": " + weakerAnalysis.lies,

    bsMeter,
    manipulation: "Manipulation assessment completed from transcript framing only.",
    fluff:
      teamAName +
      ": " +
      teamAAnalysis.fluffText +
      " " +
      teamBName +
      ": " +
      teamBAnalysis.fluffText,

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
  const confidence = Math.min(95, 50 + diff * 4);
  return String(confidence) + "%";
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

  return (
    "Lane mismatch exists: Team A is mainly in " +
    aLane +
    ", while Team B is mainly in " +
    bLane +
    "."
  );
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const a = clip(stripLabelPrefix(teamAAnalysis.bestSentence), 120);
  const b = clip(stripLabelPrefix(teamBAnalysis.bestSentence), 120);

  if (a && b) {
    return "The core disagreement is between Team A's claim that " + a + " and Team B's claim that " + b + ".";
  }

  return "The core disagreement is which side offers the better-grounded central claim in the preserved debate text.";
}

function stripLabelPrefix(text) {
  return cleanWhitespace(String(text || "").replace(/^(team a|team b)\s*[:\-]\s*/i, ""));
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  if (winner === "Mixed") {
    return "Both sides show some usable reasoning but also leave support gaps, overreach, or unresolved rebuttal issues.";
  }

  const winnerAnalysis =
    winner === teamAAnalysis.sideName ? teamAAnalysis : teamBAnalysis;

  return (
    winner +
    " wins because its better points are more structured and less inflated, while the other side leaves more unresolved weakness. " +
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

/* ------------------------------------------------------------------ */
/* Consistency                                                        */
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
    .replace(/\s{2,}/g, " ")
    .trim();

  return text || "";
}

/* ------------------------------------------------------------------ */
/* Failure response                                                   */
/* ------------------------------------------------------------------ */

function buildFailureResponse(req, err) {
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
function buildConfidence(a, b) {
  const diff = Math.abs(a - b);
  const confidence = Math.min(95, 50 + diff * 4);
  return `${confidence}%`;
}

function normalizeDisplayScore(raw) {
  return Math.max(1, Math.min(10, Math.round(raw / 10)));
}

function buildSameLaneEngagement(aLane, bLane) {
  if (aLane === bLane) {
    return `Both sides largely argue in the same lane: ${aLane}.`;
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
  return `Lane mismatch exists: Team A is mainly in ${aLane}, while Team B is mainly in ${bLane}.`;
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  return `The core disagreement is whether ${teamAAnalysis.sideName}'s central claim or ${teamBAnalysis.sideName}'s central claim is better grounded by reasoning and support in the preserved transcript.`;
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  if (winner === "Mixed") {
    return "Both sides show some usable reasoning but also leave support gaps, overreach, or unresolved rebuttal issues.";
  }

  const winnerAnalysis =
    winner === teamAAnalysis.sideName ? teamAAnalysis : teamBAnalysis;
  const loserAnalysis =
    winner === teamAAnalysis.sideName ? teamBAnalysis : teamAAnalysis;

  return `${winner} wins because its better points are more structured and less inflated, while the other side leaves more unresolved weakness. ${factLayer.summary}`;
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
    ? `${teamAAnalysis.sideName} is reaching more`
    : `${teamBAnalysis.sideName} is reaching more`;
}
 /* ------------------------------------------------------------------ */
/* Consistency Enforcement                                            */
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
      `${safe.teamAName} presents a position, but the transcript remains partially noisy.`
    )
  );
  safe.teamA.truth = sanitizeForDisplay(
    meaningful(
      safe.teamA.truth,
      `${safe.teamAName} makes at least one concrete claim, though the cleanest evidence sentence is limited.`
    )
  );
  safe.teamA.lies = sanitizeForDisplay(
    meaningful(
      safe.teamA.lies,
      `${safe.teamAName} contains some unsupported reach or unresolved assertion.`
    )
  );
  safe.teamA.opinion = sanitizeForDisplay(
    meaningful(
      safe.teamA.opinion,
      `${safe.teamAName} includes judgment or interpretation in the argument.`
    )
  );
  safe.teamA.lala = sanitizeForDisplay(
    meaningful(
      safe.teamA.lala,
      `${safe.teamAName} has some leftover loose wording or filler.`
    )
  );

  safe.teamB.main_position = sanitizeForDisplay(
    meaningful(
      safe.teamB.main_position,
      `${safe.teamBName} presents a position, but the transcript remains partially noisy.`
    )
  );
  safe.teamB.truth = sanitizeForDisplay(
    meaningful(
      safe.teamB.truth,
      `${safe.teamBName} makes at least one concrete claim, though the cleanest evidence sentence is limited.`
    )
  );
  safe.teamB.lies = sanitizeForDisplay(
    meaningful(
      safe.teamB.lies,
      `${safe.teamBName} contains some unsupported reach or unresolved assertion.`
    )
  );
  safe.teamB.opinion = sanitizeForDisplay(
    meaningful(
      safe.teamB.opinion,
      `${safe.teamBName} includes judgment or interpretation in the argument.`
    )
  );
  safe.teamB.lala = sanitizeForDisplay(
    meaningful(
      safe.teamB.lala,
      `${safe.teamBName} has some leftover loose wording or filler.`
    )
  );

  safe.teamA_integrity = sanitizeForDisplay(
    meaningful(safe.teamA_integrity, `${safe.teamAName} has a mixed integrity profile.`)
  );
  safe.teamB_integrity = sanitizeForDisplay(
    meaningful(safe.teamB_integrity, `${safe.teamBName} has a mixed integrity profile.`)
  );
  safe.teamA_reasoning = sanitizeForDisplay(
    meaningful(
      safe.teamA_reasoning,
      `${safe.teamAName} shows some reasoning but not every step is fully developed.`
    )
  );
  safe.teamB_reasoning = sanitizeForDisplay(
    meaningful(
      safe.teamB_reasoning,
      `${safe.teamBName} shows some reasoning but not every step is fully developed.`
    )
  );

  safe.teamA_lane = sanitizeForDisplay(meaningful(safe.teamA_lane, "mixed / unclear lane"));
  safe.teamB_lane = sanitizeForDisplay(meaningful(safe.teamB_lane, "mixed / unclear lane"));
  safe.same_lane_engagement = sanitizeForDisplay(
    meaningful(
      safe.same_lane_engagement,
      "Both sides engage only partially in the same lane."
    )
  );
  safe.lane_mismatch = sanitizeForDisplay(
    meaningful(
      safe.lane_mismatch,
      "Some lane mismatch remains in how the sides frame the issue."
    )
  );

  safe.strongestArgumentSide = sanitizeForDisplay(
    meaningful(
      safe.strongestArgumentSide,
      safe.winner === "Mixed" ? safe.teamAName : safe.winner
    )
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
  if (/^\d+$/.test(v)) return `${v}%`;
  return "50%";
}

function sanitizeForDisplay(value) {
  let text = cleanWhitespace(value);

  if (!text) return "";

  text = text
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\s*hours?,?\s*\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?\b/gi, " ")
    .replace(/[|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text || "";
}  /* ------------------------------------------------------------------ */
/* Failure Response                                                   */
/* ------------------------------------------------------------------ */

function buildFailureResponse(req, err) {
  const body = req && req.body && typeof req.body === "object" ? req.body : {};

  const teamAName = safeText(body.teamAName || DEFAULT_TEAM_A) || DEFAULT_TEAM_A;
  const teamBName = safeText(body.teamBName || DEFAULT_TEAM_B) || DEFAULT_TEAM_B;

  const message = err && err.message ? cleanWhitespace(err.message) : "Unknown backend error";

  return enforceConsistency({
    teamAName,
    teamBName,
    winner: "Mixed",
    confidence: "50%",
    teamAScore: "5",
    teamBScore: "5",

    teamA: {
      main_position: `${teamAName} could not be fully analyzed because the backend hit an error path.`,
      truth: `${teamAName} still appears to contain at least one argument claim in the submitted transcript.`,
      lies: `${teamAName} could not be fully stress-tested because processing failed before completion.`,
      opinion: `${teamAName} likely includes interpretation alongside argument.`,
      lala: `${teamAName} transcript may still contain some loose or noisy language.`
    },

    teamB: {
      main_position: `${teamBName} could not be fully analyzed because the backend hit an error path.`,
      truth: `${teamBName} still appears to contain at least one argument claim in the submitted transcript.`,
      lies: `${teamBName} could not be fully stress-tested because processing failed before completion.`,
      opinion: `${teamBName} likely includes interpretation alongside argument.`,
      lala: `${teamBName} transcript may still contain some loose or noisy language.`
    },

    teamA_integrity: `${teamAName} integrity assessment is incomplete because the handler failed.`,
    teamB_integrity: `${teamBName} integrity assessment is incomplete because the handler failed.`,
    teamA_reasoning: `${teamAName} reasoning assessment is incomplete because the handler failed.`,
    teamB_reasoning: `${teamBName} reasoning assessment is incomplete because the handler failed.`,

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
    why: `Returned safe fallback JSON after backend failure: ${clip(message, 180)}`,

    analysisMode: `${ANALYSIS_MODE}+failure-fallback`,
    sources: []
  });
}

/* ------------------------------------------------------------------ */
/* Misc                                                               */
/* ------------------------------------------------------------------ */

function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
} /* =========================
   END PATCH OVERRIDES
   ========================= */

const PATCH_EXTRA_CORRUPTION_PATTERNS = [
  /\b\d{1,4}\s*hour,,?\b/gi,
  /\b\d{1,4}\s*hours?,,?\b/gi,
  /\b\d{1,4}\s*minutes?,,?\b/gi,
  /\b\d{1,4}\s*seconds?,,?\b/gi,
  /(^|\s):\d{1,4}\b/g,
  /\b\d{1,3}[;:,]\s*\d{1,3}\s*seconds?\b/gi,
  /\b\d{1,3}[;:,]\s*\d{1,3}\s*minutes?\b/gi,
  /\b\d{1,3}[;:,]\s*\d{1,3}\s*hours?\b/gi,
  /\b\d+\s*seconds(?=[a-z])/gi,
  /\b\d+\s*minutes(?=[a-z])/gi,
  /\b\d+\s*hours(?=[a-z])/gi,
  /\bseconds(?=[A-Z])/g,
  /\bminutes(?=[A-Z])/g,
  /\bhours(?=[A-Z])/g,
  /\b\d{1,3}[;:,]\b/g,
  /\b\d+\s*\/\s*\d+\b/g,
  /\^\s*of\s*\d+/gi,
  /\b1\s*\/\s*10\b/gi
];

function stripTranscriptCorruption(text) {
  let line = String(text || "");

  for (const re of STAGE_DIRECTION_PATTERNS) {
    line = line.replace(re, " ");
  }

  for (const re of CLEAN_TIMESTAMP_PATTERNS) {
    line = line.replace(re, " ");
  }

  for (const re of PATCH_EXTRA_CORRUPTION_PATTERNS) {
    line = line.replace(re, " ");
  }

  line = line
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
  const t = cleanWhitespace(stripTranscriptCorruption(line));
  if (!t) return true;

  const wc = wordCount(t);
  if (wc < 4) return true;

  const digitClusters = (t.match(/\d+/g) || []).length;
  const weirdPunct = (t.match(/[;:]/g) || []).length;

  return (
    /\b\d+\s*seconds\s+[a-z]/i.test(t) ||
    /\b\d+\s*minutes\s+[a-z]/i.test(t) ||
    /\b\d+\s*hours\s+[a-z]/i.test(t) ||
    /(^|\s):\d{1,4}\b/.test(t) ||
    /\bhour,,/i.test(t) ||
    /\b\d{1,3}[;:,]\s*\d{1,3}\b/.test(t) ||
    (digitClusters >= 4 && wc <= 18) ||
    (weirdPunct >= 3 && wc <= 20)
  );
}

function containsCorruption(sentence) {
  const s = cleanWhitespace(stripTranscriptCorruption(sentence));
  if (!s) return true;

  return (
    looksMostlyCorrupt(s) ||
    /\b\d+\s*seconds\s+[a-z]/i.test(s) ||
    /\b\d+\s*minutes\s+[a-z]/i.test(s) ||
    /\b\d+\s*hours\s+[a-z]/i.test(s) ||
    /(^|\s):\d{1,4}\b/.test(s) ||
    /\bhour,,/i.test(s) ||
    /\b\d{1,3}[;:,]\s*\d{1,3}\b/.test(s)
  );
}

function isRealArgumentSentence(line) {
  const t = cleanWhitespace(stripTranscriptCorruption(line));
  if (!t) return false;
  if (wordCount(t) < 8) return false;
  if (isLikelySetupLine(t)) return false;
  if (isLikelyModeratorLine(t) && wordCount(t) < 20) return false;
  if (/^(thanks|thank you|okay|alright|right|sure)\b/i.test(t)) return false;
  if (containsCorruption(t)) return false;
  return true;
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
      const cleaned = cleanWhitespace(stripTranscriptCorruption(line.replace(/^[^:\-]+[:\-]\s*/, "")));
      if (isRealArgumentSentence(cleaned)) teamA.push(cleaned);
      continue;
    }

    if (bPatterns.some((re) => re.test(line))) {
      const cleaned = cleanWhitespace(stripTranscriptCorruption(line.replace(/^[^:\-]+[:\-]\s*/, "")));
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

function extractSides(args) {
  const text = args.cleanedTranscript || args.transcriptRaw || "";
  const lines = String(text)
    .split("\n")
    .map((line) => cleanWhitespace(stripTranscriptCorruption(line)))
    .filter(Boolean);

  if (!lines.length) {
    return { teamAText: "", teamBText: "" };
  }

  const explicit = extractByExplicitSpeakerLabels(lines, args.teamAName, args.teamBName);
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

  const alternating = fallbackSplitSides(lines);
  return {
    teamAText: alternating.teamA.join(" "),
    teamBText: alternating.teamB.join(" ")
  };
}

function selectArgumentSentences(text) {
  const sentences = toSentences(text);

  const candidates = sentences
    .map((sentence) => cleanWhitespace(stripTranscriptCorruption(sentence)))
    .filter(Boolean)
    .filter(isRealArgumentSentence)
    .filter((sentence) => !containsCorruption(sentence));

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
  let score = 0;
  const wc = wordCount(cleaned);

  score += Math.min(wc, 26);
  score += countHits(cleaned, REASONING_WORDS) * 8;
  score += countHits(cleaned, EVIDENCE_WORDS) * 7;
  score += countHits(cleaned, OPINION_WORDS) * 1;
  score -= countHits(cleaned, FILLER_WORDS) * 3;

  if (/for example|for instance|according to/i.test(cleaned)) score += 6;
  if (/because/i.test(cleaned)) score += 6;
  if (wc > 10 && wc < 45) score += 6;
  if (wc < 8) score -= 20;
  if (wc > 60) score -= 10;
  if (containsCorruption(cleaned)) score -= 100;

  return score;
}

function chooseBestSentence(sentences) {
  if (!Array.isArray(sentences) || !sentences.length) return "";

  const ranked = sentences
    .map((s) => cleanWhitespace(stripTranscriptCorruption(s)))
    .filter(Boolean)
    .filter(isRealArgumentSentence)
    .filter((s) => !containsCorruption(s))
    .map((sentence) => ({ sentence, score: scoreSentence(sentence) }))
    .sort((a, b) => b.score - a.score);

  return ranked.length ? ranked[0].sentence : "";
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aClaim = clip(teamAAnalysis.truth || teamAAnalysis.bestSentence || teamAAnalysis.main_position || "", 140);
  const bClaim = clip(teamBAnalysis.truth || teamBAnalysis.bestSentence || teamBAnalysis.main_position || "", 140);

  if (aClaim && bClaim) {
    return `Team A presses this claim: ${aClaim} Team B presses this competing claim: ${bClaim}`;
  }

  return "The sides disagree over which central claim is better supported by reasoning and evidence in the preserved transcript.";
}

function factCheckLayer(teamAAnalysis, teamBAnalysis, meta) {
  const checkedClaims = [];

  const inspect = (analysis, sideName) => {
    const claims = analysis.sentences
      .map((claim) => cleanWhitespace(stripTranscriptCorruption(claim)))
      .filter(Boolean)
      .filter((claim) => !containsCorruption(claim))
      .slice(0, 3);

    for (const claim of claims) {
      checkedClaims.push({
        claim: clip(`${sideName}: ${claim}`, 220),
        status: inferFactCheckStatus(claim),
        note: buildFactCheckNote(claim),
        source: meta.videoLink ? clip(meta.videoLink, 180) : "Transcript-only analysis"
      });
    }
  };

  inspect(teamAAnalysis, teamAAnalysis.sideName || "Team A");
  inspect(teamBAnalysis, teamBAnalysis.sideName || "Team B");

  return {
    checkedClaims,
    summary: "Fact-check layer executed in transcript mode. Claims were filtered for transcript corruption but not externally verified."
  };
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
