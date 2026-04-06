"use strict";

/**
 * /api/analyze2.js
 *
 * Debate Judgment Engine backend
 * - Keeps frontend contract unchanged
 * - Always returns valid JSON with res.json(...)
 * - Cleans transcript junk
 * - Separates thesis / support / attack / example / filler
 * - Avoids using attacks or rhetorical intros as main positions
 */

const DEFAULT_TEAM_A = "Team A";
const DEFAULT_TEAM_B = "Team B";
const ANALYSIS_MODE = "deterministic+factcheck+ai-refinement+merge+claim-mapping";

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

module.exports = async function analyze2Handler(req, res) {
  try {
    const body = req && req.body && typeof req.body === "object" ? req.body : {};

    const teamAName =
      normalizeText(body.teamAName || body.teamA || body.speakerA || body.nameA) ||
      DEFAULT_TEAM_A;

    const teamBName =
      normalizeText(body.teamBName || body.teamB || body.speakerB || body.nameB) ||
      DEFAULT_TEAM_B;

    const transcriptRaw = getTranscriptFromBody(body);
    const videoLink = normalizeText(body.videoLink || "");

    const cleanedTranscript = cleanTranscript(transcriptRaw);

    const extracted = extractSides({
      transcriptRaw,
      cleanedTranscript,
      teamAName,
      teamBName
    });

    const teamAClaims = buildClaimMap(extracted.teamAText, teamAName);
    const teamBClaims = buildClaimMap(extracted.teamBText, teamBName);

    const teamAAnalysis = deterministicAnalysis(teamAClaims, teamAName);
    const teamBAnalysis = deterministicAnalysis(teamBClaims, teamBName);

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

    return res.json(
      enforceConsistency({
        ...merged,
        teamAName,
        teamBName,
        analysisMode: ANALYSIS_MODE,
        sources: Array.isArray(factLayer.checkedClaims) ? factLayer.checkedClaims : []
      })
    );
  } catch (error) {
    return res.json(buildFailureResponse(req, error));
  }
};

/* -------------------------------------------------------------------------- */
/* Input helpers                                                              */
/* -------------------------------------------------------------------------- */

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

function clip(text, max = 220) {
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countHits(text, patterns) {
  const lower = cleanWhitespace(text).toLowerCase();
  let hits = 0;

  for (const item of patterns || []) {
    if (lower.includes(item)) hits += 1;
  }

  return hits;
}

/* -------------------------------------------------------------------------- */
/* Dictionaries                                                               */
/* -------------------------------------------------------------------------- */

const REASONING_WORDS = [
  "because",
  "therefore",
  "thus",
  "hence",
  "since",
  "if",
  "then",
  "it follows",
  "which means",
  "that means",
  "as a result",
  "consequently",
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
  "record",
  "records",
  "historically",
  "observation",
  "observations",
  "experiment",
  "experiments",
  "measured",
  "observed",
  "scholar",
  "scholars",
  "journal",
  "published"
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
  "obviously",
  "clearly",
  "completely",
  "100%",
  "without question",
  "proves everything",
  "there is no doubt",
  "all of them"
];

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
  "literally"
];

const ATTACK_HINTS = [
  "oversimplification",
  "unsupported",
  "overreach",
  "wrong because",
  "fails to",
  "does not answer",
  "misrepresents",
  "misrepresenting",
  "downplaying",
  "harsh theological interpretation",
  "thought terminating",
  "cliche",
  "this point leans on",
  "that argument leans on",
  "that claim leans on",
  "is either unaware",
  "deliberately"
];

const EXAMPLE_HINTS = [
  "for example",
  "for instance",
  "imagine",
  "case study",
  "heaven's gate",
  "heavens gate",
  "joseph smith",
  "angel moroni",
  "spaceship",
  "numerius",
  "casius",
  "molech",
  "enoch",
  "ezra"
];

const TOPIC_WORDS = [
  "genesis",
  "jesus",
  "gospel",
  "gospels",
  "eyewitness",
  "historical proof",
  "historical evidence",
  "babylonian",
  "mesopotamian",
  "ancient near eastern",
  "moral law",
  "moral lawgiver",
  "god",
  "scripture",
  "theology",
  "theological",
  "resurrection",
  "primeval history",
  "papias",
  "johannine",
  "beloved disciple",
  "disciples",
  "martyrdom"
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
  /\bhit the notification bell\b/i,
  /\bshare this video\b/i,
  /\bfollow me on\b/i,
  /\bcheck out my\b/i,
  /\bmy channel\b/i,
  /\bour channel\b/i,
  /\bsponsored by\b/i,
  /\bpodcast\b/i,
  /\bpatreon\b/i,
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

const NON_ARGUMENT_CONTEXT_PATTERNS = [
  /\bthis channel is\b/i,
  /\bchannel is primarily\b/i,
  /\bchannel is about\b/i,
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
  /\bthis debate format\b/i,
  /\bchapter\s+\d+\b/i,
  /\btable of contents\b/i
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
  /(^|\s):\d{1,4}\b/g
];

/* -------------------------------------------------------------------------- */
/* Cleaning                                                                   */
/* -------------------------------------------------------------------------- */

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

  const cleaned = [];

  for (const line of lines) {
    const stripped = cleanWhitespace(stripSpeakerPrefix(line));
    if (!stripped) continue;
    if (isLikelySetupLine(stripped)) continue;
    if (isLikelyModeratorLine(stripped) && wordCount(stripped) < 18) continue;
    if (looksMostlyCorrupt(stripped)) continue;
    cleaned.push(stripped);
  }

  return uniquePreserveOrder(cleaned).join("\n");
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

/* -------------------------------------------------------------------------- */
/* Setup / moderator / context                                                */
/* -------------------------------------------------------------------------- */

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

function isGenericFallbackText(text) {
  const t = cleanWhitespace(text || "").toLowerCase();
  return (
    !t ||
    t === "-" ||
    /shows some overreach/.test(t) ||
    /unsupported phrasing/.test(t) ||
    /no single sentence is clean enough/.test(t) ||
    /includes interpretive or judgment language/.test(t) ||
    /limited obvious filler/.test(t) ||
    /does not fully answer/.test(t) ||
    /clearest reasoning chain/.test(t) ||
    /does not have enough preserved argument text/.test(t) ||
    /mixed integrity profile/.test(t) ||
    /strongest on explicit reasoning structure/.test(t) ||
    /some filler remains after cleanup/.test(t)
  );
}

function isAttackSentence(text) {
  const t = cleanWhitespace(text || "").toLowerCase();
  return ATTACK_HINTS.some((hint) => t.includes(hint));
}

function isExampleHeavySentence(text) {
  const t = cleanClaimForDisplay(text).toLowerCase();
  return EXAMPLE_HINTS.some((hint) => t.includes(hint));
}

function isRhetoricalIntro(text) {
  const t = cleanWhitespace(text || "").toLowerCase();

  return (
    /people are going to say/.test(t) ||
    /some people are going to say/.test(t) ||
    /why are you being so aggressive/.test(t) ||
    /let me tell you why/.test(t) ||
    /now i know/.test(t) ||
    /i know some people/.test(t) ||
    /you may be wondering/.test(t) ||
    /somebody might say/.test(t) ||
    /someone might say/.test(t) ||
    /before i get into that/.test(t) ||
    /let me explain something/.test(t) ||
    /here's what i mean/.test(t) ||
    /let's be honest/.test(t) ||
    /now listen/.test(t)
  );
}

function isNonArgumentContextLine(line) {
  const t = cleanClaimForDisplay(line);
  if (!t) return true;

  if (
    /\bsubscribe\b/i.test(t) ||
    /\bnotification bell\b/i.test(t) ||
    /\bshare this video\b/i.test(t) ||
    /\bmy channel\b/i.test(t) ||
    /\bour channel\b/i.test(t) ||
    /\bthanks for watching\b/i.test(t) ||
    /\bthanks for joining\b/i.test(t)
  ) {
    return true;
  }

  if (NON_ARGUMENT_CONTEXT_PATTERNS.some((re) => re.test(t))) return true;
  if (isRhetoricalIntro(t)) return true;
  return false;
}

function isBadClaimCandidate(text) {
  const t = cleanClaimForDisplay(text || "");
  if (!t) return true;

  return (
    isRhetoricalIntro(t) ||
    isNonArgumentContextLine(t) ||
    isGenericFallbackText(t) ||
    wordCount(t) < 7 ||
    /^[,"'`;:\-]/.test(t) ||
    /\.\.\.$/.test(t) ||
    /(^|[\s,;:])\d+\s*[;:,]/.test(t)
  );
}

function cleanClaimForDisplay(text) {
  let t = cleanWhitespace(stripTranscriptCorruption(text || ""));

  t = t
    .replace(/^\d+\s*[;:,.-]\s*/g, "")
    .replace(/^team\s*[ab]\s*(says|argues)\s*/i, "")
    .replace(/^says\s*/i, "")
    .replace(/^argues\s*/i, "")
    .replace(/^that\s+/i, "")
    .replace(/^quote[:,]?\s*/i, "")
    .replace(/^first[:,]?\s*/i, "")
    .replace(/^second[:,]?\s*/i, "")
    .replace(/^third[:,]?\s*/i, "")
    .replace(/^fourth[:,]?\s*/i, "")
    .replace(/^and\s+/i, "")
    .replace(/^but\s+/i, "")
    .replace(/^so\s+/i, "")
    .replace(/^now\s+/i, "")
    .replace(/^well\s+/i, "")
    .replace(/^look[:,]?\s*/i, "")
    .replace(/^listen[:,]?\s*/i, "")
    .replace(/^let'?s (look at|talk about)\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return t;
}

function isThesisLike(text) {
  const t = cleanWhitespace(text || "").toLowerCase();
  if (!t) return false;
  if (isBadClaimCandidate(t)) return false;
  if (isAttackSentence(t)) return false;
  if (isExampleHeavySentence(t)) return false;

  return (
    /\bshould\b/.test(t) ||
    /\bshould not\b/.test(t) ||
    /\bcannot\b/.test(t) ||
    /\bdoes not\b/.test(t) ||
    /\bis\b/.test(t) ||
    /\bare\b/.test(t) ||
    /\bcounts as\b/.test(t) ||
    /\bhistorical proof\b/.test(t) ||
    /\bhistorical evidence\b/.test(t) ||
    /\bgenesis\b/.test(t) ||
    /\bjesus\b/.test(t) ||
    /\bgospels?\b/.test(t) ||
    /\beyewitness/.test(t) ||
    /\bmoral law/.test(t) ||
    /\bgod\b/.test(t)
  );
}

function humanizeClaim(text) {
  const raw = cleanClaimForDisplay(text);
  const t = raw.toLowerCase();

  if (!raw) return "the main claim is not preserved clearly";
  if (isRhetoricalIntro(raw)) return "rhetorical setup language, not a usable argument claim";

  if (/eyewitness/.test(t) && /jesus/.test(t) && /historical (proof|evidence)/.test(t)) {
    return "eyewitness-style testimony should not automatically count as strong historical proof for Jesus";
  }

  if (/babylonian background of genesis|mesopotamian literature|primeval history of genesis/i.test(raw)) {
    return "Genesis should be read against Ancient Near Eastern background material rather than as an isolated modern account";
  }

  if (/moral law/i.test(raw) && /moral lawgiver/i.test(raw)) {
    return "objective moral law points to a moral lawgiver";
  }

  if (/disciple whom jesus loved|johannine/i.test(raw)) {
    return "the beloved disciple may be a literary figure rather than a secure eyewitness";
  }

  if (/heaven'?s gate|joseph smith|angel moroni|spaceship/i.test(raw)) {
    return "sincere belief by itself does not prove that the belief is historically true";
  }

  if (/papias/i.test(raw) && /judas/i.test(raw)) {
    return "Papias includes legendary material, which weakens it as clean historical support";
  }

  if (/everyone else.*go to hell|simply chose not to save/i.test(raw)) {
    return "this point depends on a harsh theological interpretation that still needs stronger support";
  }

  return clip(raw.charAt(0).toLowerCase() + raw.slice(1), 170);
}

/* -------------------------------------------------------------------------- */
/* Side extraction                                                            */
/* -------------------------------------------------------------------------- */

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
  if (explicit.teamA.length >= 2 && explicit.teamB.length >= 2) {
    return {
      teamAText: explicit.teamA.join(" "),
      teamBText: explicit.teamB.join(" ")
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
      if (wordCount(cleaned) >= 5) teamA.push(cleaned);
      continue;
    }

    if (bPatterns.some((re) => re.test(line))) {
      const cleaned = cleanWhitespace(
        stripTranscriptCorruption(line.replace(/^[^:\-]+[:\-]\s*/, ""))
      );
      if (wordCount(cleaned) >= 5) teamB.push(cleaned);
    }
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
    .filter((line) => !isLikelyModeratorLine(line))
    .filter((line) => !isLikelySetupLine(line))
    .filter((line) => wordCount(line) >= 6);

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

/* -------------------------------------------------------------------------- */
/* Claim extraction                                                           */
/* -------------------------------------------------------------------------- */

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

function scoreSentence(sentence) {
  const text = cleanClaimForDisplay(sentence);
  if (isBadClaimCandidate(text)) return -999;

  let score = 0;
  const wc = wordCount(text);

  score += Math.min(wc, 24);
  score += countHits(text, REASONING_WORDS) * 7;
  score += countHits(text, EVIDENCE_WORDS) * 6;
  score += countHits(text, TOPIC_WORDS) * 5;
  score -= countHits(text, FILLER_WORDS) * 3;

  if (isAttackSentence(text)) score -= 6;
  if (isExampleHeavySentence(text)) score -= 8;
  if (wc > 50) score -= 6;
  if (/\?/.test(text)) score -= 4;

  return score;
}

function classifySentence(sentence) {
  const cleaned = cleanClaimForDisplay(sentence);
  const lower = cleaned.toLowerCase();

  if (
    !cleaned ||
    isRhetoricalIntro(cleaned) ||
    isNonArgumentContextLine(cleaned) ||
    countHits(cleaned, FILLER_WORDS) >= 2
  ) {
    return "filler";
  }

  if (isAttackSentence(cleaned)) return "attack";
  if (isExampleHeavySentence(cleaned)) return "example";

  const reasoningHits = countHits(lower, REASONING_WORDS);
  const evidenceHits = countHits(lower, EVIDENCE_WORDS);
  const topicHits = countHits(lower, TOPIC_WORDS);

  if (isThesisLike(cleaned)) return "thesis";
  if (evidenceHits >= 1 || reasoningHits >= 1 || topicHits >= 1) return "support";

  return "filler";
}

function uniqueRecordHuman(records) {
  const seen = new Set();
  const output = [];

  for (const item of records || []) {
    const key = cleanWhitespace(item.human || item.text).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }

  return output;
}

function buildClaimMap(text, sideName) {
  const sentences = toSentences(text)
    .map(cleanClaimForDisplay)
    .filter(Boolean)
    .filter((s) => wordCount(s) >= 5)
    .filter((s) => !isRhetoricalIntro(s));

  const theses = [];
  const supports = [];
  const attacks = [];
  const examples = [];
  const fillers = [];

  for (const sentence of sentences) {
    const kind = classifySentence(sentence);
    const record = {
      text: sentence,
      human: humanizeClaim(sentence),
      score: scoreSentence(sentence)
    };

    if (kind === "thesis") theses.push(record);
    else if (kind === "support") supports.push(record);
    else if (kind === "attack") attacks.push(record);
    else if (kind === "example") examples.push(record);
    else fillers.push(record);
  }

  const sortDesc = (a, b) => b.score - a.score;

  theses.sort(sortDesc);
  supports.sort(sortDesc);
  attacks.sort(sortDesc);
  examples.sort(sortDesc);
  fillers.sort(sortDesc);

  return {
    sideName,
    sentences,
    thesis: uniqueRecordHuman(theses).filter((r) => !isBadClaimCandidate(r.text)).slice(0, 5),
    support: uniqueRecordHuman(supports).filter((r) => !isBadClaimCandidate(r.text)).slice(0, 7),
    attack: uniqueRecordHuman(attacks).filter((r) => !isBadClaimCandidate(r.text)).slice(0, 5),
    example: uniqueRecordHuman(examples).filter((r) => !isBadClaimCandidate(r.text)).slice(0, 4),
    filler: uniqueRecordHuman(fillers).slice(0, 4)
  };
}

function bestUsableClaimFromAnalysis(analysis) {
  const thesis = analysis && analysis.thesis && analysis.thesis.length ? analysis.thesis[0].human : "";
  if (thesis && !isBadClaimCandidate(thesis) && !isAttackSentence(thesis)) return thesis;

  const support = analysis && analysis.support && analysis.support.length ? analysis.support[0].human : "";
  if (support && !isBadClaimCandidate(support) && !isAttackSentence(support)) return support;

  const example = analysis && analysis.example && analysis.example.length ? analysis.example[0].human : "";
  if (example && !isBadClaimCandidate(example)) return example;

  return "the main claim is not preserved clearly";
}

/* -------------------------------------------------------------------------- */
/* Deterministic analysis                                                     */
/* -------------------------------------------------------------------------- */

function deterministicAnalysis(claimMap, sideName) {
  const mainClaim = bestUsableClaimFromAnalysis(claimMap);

  const truth =
    claimMap.support.length
      ? claimMap.support[0].human
      : claimMap.thesis.length
      ? claimMap.thesis[0].human
      : mainClaim;

  const lies =
    claimMap.attack.length
      ? claimMap.attack[0].human
      : "the case includes at least one claim that outruns its displayed support";

  const opinionCandidate = claimMap.sentences.find(
    (s) =>
      !isBadClaimCandidate(s) &&
      /\bi think\b|\bi believe\b|\bin my view\b|\bit seems\b|\bshould\b/i.test(s)
  );

  const opinion = opinionCandidate
    ? humanizeClaim(opinionCandidate)
    : "interpretive language is mixed into the case";

  const lala =
    claimMap.filler.length
      ? claimMap.filler[0].human
      : "some filler remains after cleanup";

  const joined = (claimMap.sentences || []).join(" ").toLowerCase();

  const evidenceHits = countHits(joined, EVIDENCE_WORDS);
  const reasoningHits = countHits(joined, REASONING_WORDS);
  const topicHits = countHits(joined, TOPIC_WORDS);
  const overreachHits = countHits(joined, OVERREACH_WORDS);
  const fillerHits = countHits(joined, FILLER_WORDS);

  const lane = inferLane(joined);
  const integrityText = buildIntegrityText(evidenceHits, reasoningHits, overreachHits);
  const reasoningText = buildReasoningText(evidenceHits, reasoningHits, topicHits);
  const manipulationText = buildManipulationText(joined);
  const fluffText =
    fillerHits >= 3
      ? "Some fluff remains, but the main claims are still identifiable."
      : "Low fluff after cleanup.";

  const scoreRaw = scoreSide({
    evidenceHits,
    reasoningHits,
    topicHits,
    overreachHits,
    fillerHits,
    thesisCount: claimMap.thesis.length,
    supportCount: claimMap.support.length
  });

  return {
    sideName,
    sentences: claimMap.sentences,
    thesis: claimMap.thesis,
    support: claimMap.support,
    attack: claimMap.attack,
    example: claimMap.example,
    filler: claimMap.filler,
    main_position: sideName + " mainly argues that " + mainClaim + ".",
    truth,
    lies,
    opinion,
    lala,
    bestSentence: mainClaim,
    lane,
    integrityText,
    reasoningText,
    manipulationText,
    fluffText,
    scoreRaw
  };
}

function inferLane(text) {
  const t = cleanWhitespace(text).toLowerCase();

  const theologyScore = countHits(t, [
    "god",
    "scripture",
    "jesus",
    "gospel",
    "gospels",
    "genesis",
    "theology",
    "theological",
    "moral law",
    "moral lawgiver"
  ]);

  const historyScore = countHits(t, [
    "historical",
    "historically",
    "evidence",
    "eyewitness",
    "records",
    "scholar",
    "scholars",
    "journal",
    "published",
    "babylonian",
    "mesopotamian"
  ]);

  if (theologyScore && historyScore) return "mixed lane with overlapping frameworks";
  if (theologyScore > historyScore) return "theology / scripture lane";
  if (historyScore > theologyScore) return "history / evidence lane";
  return "mixed / unclear lane";
}

function buildIntegrityText(evidenceHits, reasoningHits, overreachHits) {
  if (evidenceHits + reasoningHits > overreachHits + 2) {
    return "Leans more grounded than inflated, though not every claim is equally supported.";
  }
  if (overreachHits > evidenceHits + reasoningHits) {
    return "Shows noticeable overreach or unsupported certainty relative to the evidence preserved.";
  }
  return "Mixed integrity profile: some grounded points, some interpretive stretch, some unresolved support gaps.";
}

function buildReasoningText(evidenceHits, reasoningHits, topicHits) {
  if (reasoningHits >= 3 && evidenceHits >= 2) {
    return "Strongest on explicit reasoning structure and at least some evidentiary support.";
  }
  if (reasoningHits >= 3) {
    return "Reasoning is present and mostly traceable, though support is not always equally strong.";
  }
  if (evidenceHits >= 2 || topicHits >= 3) {
    return "Uses support language and topic engagement, though the chain from premise to conclusion is less consistent.";
  }
  return "Reasoning exists, but much of it is asserted more than fully demonstrated.";
}

function buildManipulationText(joined) {
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

  if (hits >= 3) return "Noticeable pressure language and framing tactics show up alongside the argument.";
  if (hits >= 1) return "Some rhetorical pressure appears, but it does not fully dominate the case.";
  return "Low obvious manipulation in the preserved text.";
}

function scoreSide(parts) {
  const {
    evidenceHits,
    reasoningHits,
    topicHits,
    overreachHits,
    fillerHits,
    thesisCount,
    supportCount
  } = parts;

  const raw =
    48 +
    evidenceHits * 4 +
    reasoningHits * 4 +
    topicHits * 2 +
    thesisCount * 5 +
    supportCount * 2 -
    overreachHits * 4 -
    fillerHits * 2;

  return Math.max(10, Math.min(95, Math.round(raw)));
}

/* -------------------------------------------------------------------------- */
/* Fact check layer                                                           */
/* -------------------------------------------------------------------------- */

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

function factCheckLayer(teamAAnalysis, teamBAnalysis, meta) {
  const checkedClaims = [];

  const inspect = (analysis, sideName) => {
    const claims = []
      .concat(analysis.thesis || [])
      .concat(analysis.support || [])
      .filter((item) => item && item.text && !isBadClaimCandidate(item.text))
      .slice(0, 3);

    for (const claim of claims) {
      checkedClaims.push({
        claim: clip(sideName + ": " + claim.human, 220),
        status: inferFactCheckStatus(claim.text),
        note: buildFactCheckNote(claim.text),
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

/* -------------------------------------------------------------------------- */
/* AI refinement stub                                                         */
/* -------------------------------------------------------------------------- */

async function aiRefinementLayer(teamAAnalysis, teamBAnalysis, meta) {
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const weak = strongerWeakPoint(teamAAnalysis, teamBAnalysis);

  const winnerClaim = bestUsableClaimFromAnalysis(strongest.winner);
  const loserClaim = bestUsableClaimFromAnalysis(strongest.loser);

  return {
    usedAI: false,
    promptPreview: clip(meta.promptOverride || "No custom refinement prompt provided.", 220),
    override: {
      strongestArgumentSide: strongest.winner.sideName,
      strongestArgument: "Core point: " + winnerClaim,
      whyStrongest: "It stands out because " + strongest.text + ".",
      failedResponseByOtherSide:
        strongest.loser.sideName +
        " does not beat that point with a cleaner rival claim. Its nearest competing claim is: " +
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
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Comparison / verdict                                                       */
/* -------------------------------------------------------------------------- */

function strongestReasonWhy(a, b) {
  const aj = ((a && a.sentences) || []).join(" ").toLowerCase();
  const bj = ((b && b.sentences) || []).join(" ").toLowerCase();

  const aScore =
    countHits(aj, EVIDENCE_WORDS) * 3 +
    countHits(aj, REASONING_WORDS) * 3 +
    countHits(aj, TOPIC_WORDS) * 2 -
    countHits(aj, OVERREACH_WORDS) * 2;

  const bScore =
    countHits(bj, EVIDENCE_WORDS) * 3 +
    countHits(bj, REASONING_WORDS) * 3 +
    countHits(bj, TOPIC_WORDS) * 2 -
    countHits(bj, OVERREACH_WORDS) * 2;

  const winner = aScore >= bScore ? a : b;
  const loser = winner === a ? b : a;

  const reasons = [];
  const wj = winner === a ? aj : bj;
  const lj = winner === a ? bj : aj;

  if (countHits(wj, EVIDENCE_WORDS) > countHits(lj, EVIDENCE_WORDS)) reasons.push("it brings more actual support");
  if (countHits(wj, REASONING_WORDS) > countHits(lj, REASONING_WORDS)) reasons.push("it explains its logic more clearly");
  if (countHits(wj, TOPIC_WORDS) > countHits(lj, TOPIC_WORDS)) reasons.push("it stays closer to the real dispute");
  if (countHits(lj, OVERREACH_WORDS) > countHits(wj, OVERREACH_WORDS)) reasons.push("the other side overreaches more");

  if (!reasons.length) reasons.push("it is still the cleaner argument in the preserved text");

  return {
    winner,
    loser,
    text: reasons.slice(0, 2).join(" and ")
  };
}

function weakPointReason(analysis) {
  const joined = ((analysis && analysis.sentences) || []).join(" ").toLowerCase();

  let weakClaim = humanizeClaim((analysis && analysis.lies) || "");
  if (isGenericFallbackText(weakClaim)) {
    weakClaim = humanizeClaim((analysis && analysis.opinion) || "");
  }
  if (isGenericFallbackText(weakClaim)) {
    weakClaim = bestUsableClaimFromAnalysis(analysis);
  }

  const reasons = [];
  if (/\balways\b|\bnever\b|\beveryone\b|\bnobody\b|\bobviously\b/.test(joined)) reasons.push("it overstates the case");
  if (countHits(joined, EVIDENCE_WORDS) === 0) reasons.push("it lacks concrete support");
  if (countHits(joined, REASONING_WORDS) === 0) reasons.push("it asserts more than it explains");
  if (countHits(joined, OPINION_WORDS) >= 1) reasons.push("it leans on interpretation");

  if (!reasons.length) reasons.push("it does not create enough pressure on the opposing case");

  return {
    claim: weakClaim,
    reason: reasons.slice(0, 2).join(" and ")
  };
}

function strongerWeakPoint(teamAAnalysis, teamBAnalysis) {
  const aWeak = weakPointReason(teamAAnalysis);
  const bWeak = weakPointReason(teamBAnalysis);

  const aPenalty =
    (aWeak.reason.match(/and/g) || []).length +
    (aWeak.reason.includes("lacks concrete support") ? 2 : 0) +
    (aWeak.reason.includes("asserts more than it explains") ? 2 : 0);

  const bPenalty =
    (bWeak.reason.match(/and/g) || []).length +
    (bWeak.reason.includes("lacks concrete support") ? 2 : 0) +
    (bWeak.reason.includes("asserts more than it explains") ? 2 : 0);

  const weaker = aPenalty >= bPenalty ? teamAAnalysis : teamBAnalysis;
  const detail = weaker === teamAAnalysis ? aWeak : bWeak;

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

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aClaim = bestUsableClaimFromAnalysis(teamAAnalysis);
  const bClaim = bestUsableClaimFromAnalysis(teamBAnalysis);

  return "Main dispute: Team A says " + aClaim + ", but Team B says " + bClaim + ".";
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

function buildBSMeter(teamAAnalysis, teamBAnalysis) {
  const aOver = countHits((teamAAnalysis.sentences || []).join(" "), OVERREACH_WORDS);
  const bOver = countHits((teamBAnalysis.sentences || []).join(" "), OVERREACH_WORDS);

  if (aOver === bOver) return "Both sides show comparable overreach.";
  return aOver > bOver
    ? teamAAnalysis.sideName + " is reaching more"
    : teamBAnalysis.sideName + " is reaching more";
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer) {
  const aStrong = bestUsableClaimFromAnalysis(teamAAnalysis);
  const bStrong = bestUsableClaimFromAnalysis(teamBAnalysis);
  const aWeak = weakPointReason(teamAAnalysis);
  const bWeak = weakPointReason(teamBAnalysis);

  if (winner === "Mixed") {
    return (
      "Close call. Team A's usable core claim is " +
      aStrong +
      ", but it is weakened because " +
      aWeak.reason +
      ". Team B's usable core claim is " +
      bStrong +
      ", but it is weakened because " +
      bWeak.reason +
      "."
    );
  }

  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const winClaim = bestUsableClaimFromAnalysis(strongest.winner);
  const loseWeak = weakPointReason(strongest.loser);

  return (
    winner +
    " wins because its clearest usable claim is " +
    winClaim +
    ", and " +
    strongest.text +
    ". The other side falls behind because " +
    loseWeak.reason +
    "."
  );
}

/* -------------------------------------------------------------------------- */
/* Base result / merge                                                        */
/* -------------------------------------------------------------------------- */

function buildBaseResult(teamAName, teamBName, teamAAnalysis, teamBAnalysis, factLayer) {
  const winner = decideWinner(teamAAnalysis, teamBAnalysis);
  const confidence = buildConfidence(teamAAnalysis.scoreRaw, teamBAnalysis.scoreRaw);
  const sameLane = buildSameLaneEngagement(teamAAnalysis.lane, teamBAnalysis.lane);
  const laneMismatch = buildLaneMismatch(teamAAnalysis.lane, teamBAnalysis.lane);
  const coreDisagreement = buildCoreDisagreement(teamAAnalysis, teamBAnalysis);
  const why = buildOverallWhy(winner, teamAAnalysis, teamBAnalysis, factLayer);
  const bsMeter = buildBSMeter(teamAAnalysis, teamBAnalysis);
  const weakest = strongerWeakPoint(teamAAnalysis, teamBAnalysis);
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);

  return {
    teamAName,
    teamBName,
    winner,
    confidence,
    teamAScore: normalizeDisplayScore(teamAAnalysis.scoreRaw),
    teamBScore: normalizeDisplayScore(teamBAnalysis.scoreRaw),

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

    strongestArgumentSide: strongest.winner.sideName,
    strongestArgument: "Core point: " + bestUsableClaimFromAnalysis(strongest.winner),
    whyStrongest: "It stands out because " + strongest.text + ".",
    failedResponseByOtherSide:
      strongest.loser.sideName +
      " does not beat that point with a cleaner rival claim. Its nearest competing claim is: " +
      bestUsableClaimFromAnalysis(strongest.loser) +
      ".",
    weakestOverall: weakest.text,

    bsMeter,
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
      teamBAnalysis.fluffText,

    core_disagreement: coreDisagreement,
    why,

    analysisMode: ANALYSIS_MODE,
    sources: Array.isArray(factLayer.checkedClaims) ? factLayer.checkedClaims : []
  };
}

function sanitizeForDisplay(value) {
  let text = cleanClaimForDisplay(value || "");
  if (!text) return "";
  return text.replace(/\s{2,}/g, " ").trim();
}

function mergeLayer(base, aiLayer) {
  const merged = { ...base };
  const override = aiLayer && aiLayer.override ? aiLayer.override : {};

  function prefer(next, current) {
    const n = cleanWhitespace(next || "");
    if (!n) return current;
    return sanitizeForDisplay(n);
  }

  merged.strongestArgumentSide = prefer(override.strongestArgumentSide, merged.strongestArgumentSide);
  merged.strongestArgument = prefer(override.strongestArgument, merged.strongestArgument);
  merged.whyStrongest = prefer(override.whyStrongest, merged.whyStrongest);
  merged.failedResponseByOtherSide = prefer(override.failedResponseByOtherSide, merged.failedResponseByOtherSide);
  merged.weakestOverall = prefer(override.weakestOverall, merged.weakestOverall);
  merged.manipulation = prefer(override.manipulation, merged.manipulation);
  merged.fluff = prefer(override.fluff, merged.fluff);

  return merged;
}

/* -------------------------------------------------------------------------- */
/* Consistency                                                                */
/* -------------------------------------------------------------------------- */

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

function enforceConsistency(result) {
  const safe = JSON.parse(JSON.stringify(result || {}));

  safe.teamAName = meaningful(safe.teamAName, DEFAULT_TEAM_A);
  safe.teamBName = meaningful(safe.teamBName, DEFAULT_TEAM_B);
  safe.winner = meaningful(safe.winner, "Mixed");
  safe.confidence = normalizeConfidence(safe.confidence);
  safe.teamAScore = meaningful(String(safe.teamAScore || ""), "50");
  safe.teamBScore = meaningful(String(safe.teamBScore || ""), "50");

  safe.teamA = safe.teamA || {};
  safe.teamB = safe.teamB || {};

  safe.teamA.main_position = meaningful(
    sanitizeForDisplay(safe.teamA.main_position),
    safe.teamAName + " presents a position, but the transcript remains partially noisy."
  );
  safe.teamA.truth = meaningful(
    sanitizeForDisplay(safe.teamA.truth),
    safe.teamAName + " makes at least one concrete claim, though the cleanest support sentence is limited."
  );
  safe.teamA.lies = meaningful(
    sanitizeForDisplay(safe.teamA.lies),
    safe.teamAName + " includes at least one claim that outruns its displayed support."
  );
  safe.teamA.opinion = meaningful(
    sanitizeForDisplay(safe.teamA.opinion),
    safe.teamAName + " includes interpretive language mixed into the case."
  );
  safe.teamA.lala = meaningful(
    sanitizeForDisplay(safe.teamA.lala),
    "some filler remains after cleanup"
  );

  safe.teamB.main_position = meaningful(
    sanitizeForDisplay(safe.teamB.main_position),
    safe.teamBName + " presents a position, but the transcript remains partially noisy."
  );
  safe.teamB.truth = meaningful(
    sanitizeForDisplay(safe.teamB.truth),
    safe.teamBName + " makes at least one concrete claim, though the cleanest support sentence is limited."
  );
  safe.teamB.lies = meaningful(
    sanitizeForDisplay(safe.teamB.lies),
    safe.teamBName + " includes at least one claim that outruns its displayed support."
  );
  safe.teamB.opinion = meaningful(
    sanitizeForDisplay(safe.teamB.opinion),
    safe.teamBName + " includes interpretive language mixed into the case."
  );
  safe.teamB.lala = meaningful(
    sanitizeForDisplay(safe.teamB.lala),
    "some filler remains after cleanup"
  );

  safe.teamA_integrity = meaningful(
    sanitizeForDisplay(safe.teamA_integrity),
    safe.teamAName + " has a mixed integrity profile."
  );
  safe.teamB_integrity = meaningful(
    sanitizeForDisplay(safe.teamB_integrity),
    safe.teamBName + " has a mixed integrity profile."
  );
  safe.teamA_reasoning = meaningful(
    sanitizeForDisplay(safe.teamA_reasoning),
    safe.teamAName + " shows some reasoning but not every step is fully developed."
  );
  safe.teamB_reasoning = meaningful(
    sanitizeForDisplay(safe.teamB_reasoning),
    safe.teamBName + " shows some reasoning but not every step is fully developed."
  );

  safe.teamA_lane = meaningful(safe.teamA_lane, "mixed / unclear lane");
  safe.teamB_lane = meaningful(safe.teamB_lane, "mixed / unclear lane");
  safe.same_lane_engagement = meaningful(
    sanitizeForDisplay(safe.same_lane_engagement),
    "Both sides engage only partially in the same lane."
  );
  safe.lane_mismatch = meaningful(
    sanitizeForDisplay(safe.lane_mismatch),
    "Some lane mismatch remains in how the sides frame the issue."
  );

  safe.strongestArgumentSide = meaningful(
    sanitizeForDisplay(safe.strongestArgumentSide),
    safe.winner === "Mixed" ? safe.teamAName : safe.winner
  );
  safe.strongestArgument = meaningful(
    sanitizeForDisplay(safe.strongestArgument),
    "Core point: the strongest usable claim is not preserved clearly."
  );
  safe.whyStrongest = meaningful(
    sanitizeForDisplay(safe.whyStrongest),
    "It stands out because it is the cleaner argument in the preserved text."
  );
  safe.failedResponseByOtherSide = meaningful(
    sanitizeForDisplay(safe.failedResponseByOtherSide),
    "The opposing side does not beat that point with a cleaner rival claim."
  );
  safe.weakestOverall = meaningful(
    sanitizeForDisplay(safe.weakestOverall),
    "The weakest overall point is the one with the least support and clearest interpretive stretch."
  );

  safe.bsMeter = meaningful(
    sanitizeForDisplay(safe.bsMeter),
    "Both sides show some degree of overreach."
  );
  safe.manipulation = meaningful(
    sanitizeForDisplay(safe.manipulation),
    "Manipulation is limited or not clearly dominant in the preserved transcript."
  );
  safe.fluff = meaningful(
    sanitizeForDisplay(safe.fluff),
    "Some fluff remains, but core claims are still visible."
  );

  safe.core_disagreement = meaningful(
    sanitizeForDisplay(safe.core_disagreement),
    "The sides disagree over which core claim is better supported."
  );
  safe.why = meaningful(
    sanitizeForDisplay(safe.why),
    "The result comes from comparing claim clarity, support, overreach, and rebuttal strength."
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

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

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
    teamAScore: "50",
    teamBScore: "50",

    teamA: {
      main_position: teamAName + " could not be fully analyzed because the backend hit an error path.",
      truth: teamAName + " still appears to contain at least one argument claim in the submitted transcript.",
      lies: teamAName + " could not be fully stress-tested because processing failed before completion.",
      opinion: teamAName + " likely includes interpretation alongside argument.",
      lala: "some filler remains after cleanup"
    },

    teamB: {
      main_position: teamBName + " could not be fully analyzed because the backend hit an error path.",
      truth: teamBName + " still appears to contain at least one argument claim in the submitted transcript.",
      lies: teamBName + " could not be fully stress-tested because processing failed before completion.",
      opinion: teamBName + " likely includes interpretation alongside argument.",
      lala: "some filler remains after cleanup"
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
    strongestArgument: "Core point: no strongest argument could be finalized because processing failed before stable selection.",
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
