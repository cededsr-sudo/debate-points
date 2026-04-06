"use strict";

/**
 * /api/analyze2.js
 *
 * Fresh backend rebuild for Debate Judgment Engine.
 * - No external dependencies
 * - Always returns JSON via res.json(...)
 * - Keeps frontend contract
 * - Cleans transcript aggressively
 * - Extracts real claim candidates before verdict
 * - Refuses to let fallback text become the strongest argument
 */

const ANALYSIS_MODE = "deterministic+claim-first+factcheck-stub+merge";
const DEFAULT_TEAM_A = "Team A";
const DEFAULT_TEAM_B = "Team B";

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

module.exports = async function analyze2Handler(req, res) {
  try {
    const body = req && typeof req.body === "object" && req.body ? req.body : {};

    const teamAName = normalizeName(
      body.teamAName || body.teamA || body.speakerA || body.nameA || DEFAULT_TEAM_A
    );
    const teamBName = normalizeName(
      body.teamBName || body.teamB || body.speakerB || body.nameB || DEFAULT_TEAM_B
    );

    const transcriptRaw = getTranscriptFromBody(body);
    const videoLink = cleanText(body.videoLink || "");
    const cleanedTranscript = cleanTranscript(transcriptRaw);

    const sideData = extractSides({
      rawTranscript: transcriptRaw,
      cleanedTranscript,
      teamAName,
      teamBName
    });

    const teamAClaims = extractClaimsForSide(sideData.teamALines, teamAName);
    const teamBClaims = extractClaimsForSide(sideData.teamBLines, teamBName);

    const teamAAnalysis = analyzeSide(teamAClaims, teamAName);
    const teamBAnalysis = analyzeSide(teamBClaims, teamBName);

    const factLayer = buildFactCheckLayer(teamAAnalysis, teamBAnalysis, videoLink);
    const result = buildResult(teamAName, teamBName, teamAAnalysis, teamBAnalysis, factLayer);

    return res.json(enforceConsistency(result));
  } catch (err) {
    return res.json(buildFailureResponse(req, err));
  }
};

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const TIMESTAMP_PATTERNS = [
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /\b\d+\s*hour[s]?,?\s*\d+\s*minute[s]?,?\s*\d+\s*second[s]?\b/gi,
  /\b\d+\s*minute[s]?,?\s*\d+\s*second[s]?\b/gi,
  /\b\d+\s*hour[s]?\b/gi,
  /\b\d+\s*minute[s]?\b/gi,
  /\b\d+\s*second[s]?\b/gi
];

const STAGE_PATTERNS = [
  /\[[^\]]{0,120}\]/g,
  /\((?:music|applause|laughter|laughing|cheering|crosstalk|silence|background noise|intro|outro)[^)]*\)/gi
];

const INTRO_PATTERNS = [
  /\bwelcome everyone\b/i,
  /\bwelcome back\b/i,
  /\bthank[s]? for having me\b/i,
  /\bthanks for watching\b/i,
  /\bthanks for joining\b/i,
  /\bdon't forget to subscribe\b/i,
  /\bmake sure to subscribe\b/i,
  /\bhit the notification bell\b/i,
  /\bshare this video\b/i,
  /\bfollow me on\b/i,
  /\bcheck out my\b/i,
  /\bmy channel\b/i,
  /\bour channel\b/i,
  /\bpatreon\b/i,
  /\bpodcast\b/i,
  /\bsponsored by\b/i,
  /\blet'?s get started\b/i,
  /\bwithout further ado\b/i,
  /\btoday'?s debate\b/i,
  /\btonight'?s debate\b/i,
  /\bthis concludes\b/i,
  /\bthat concludes\b/i,
  /\btake care everyone\b/i,
  /\bhope you found this interesting\b/i
];

const CONTEXT_PATTERNS = [
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
  /\bwe'?re here today\b/i,
  /\bjoin me in welcoming\b/i,
  /\bthis event\b/i,
  /\bthis discussion\b/i,
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
  "implies"
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
  "published",
  "for example",
  "for instance",
  "according to"
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
  "without question",
  "there is no doubt",
  "proves everything",
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

const ATTACK_WORDS = [
  "oversimplification",
  "unsupported",
  "overreach",
  "fails to",
  "does not answer",
  "misrepresents",
  "misrepresenting",
  "downplaying",
  "harsh interpretation",
  "thought terminating",
  "cliche",
  "wrong because"
];

const TOPIC_WORDS = [
  "god",
  "jesus",
  "genesis",
  "gospel",
  "gospels",
  "scripture",
  "theology",
  "theological",
  "historical evidence",
  "historical proof",
  "eyewitness",
  "babylonian",
  "mesopotamian",
  "primeval history",
  "moral law",
  "moral lawgiver",
  "papias",
  "johannine",
  "beloved disciple",
  "disciples",
  "martyrdom",
  "resurrection"
];

const BAD_FALLBACK_TEXT = [
  "the main claim is not preserved clearly",
  "no clear usable claim survived transcript cleanup",
  "interpretive language is mixed into the case",
  "the case includes at least one claim that outruns its displayed support"
];

/* -------------------------------------------------------------------------- */
/* Basic helpers                                                              */
/* -------------------------------------------------------------------------- */

function cleanText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeName(value) {
  const v = cleanText(value);
  return v || DEFAULT_TEAM_A;
}

function wordCount(text) {
  const t = cleanText(text);
  return t ? t.split(/\s+/).length : 0;
}

function uniquePreserveOrder(items) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const v = cleanText(item);
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }

  return out;
}

function clip(text, max) {
  const v = cleanText(text);
  if (!v) return "";
  if (v.length <= max) return v;
  return v.slice(0, Math.max(0, max - 3)).trim() + "...";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countHits(text, patterns) {
  const lower = cleanText(text).toLowerCase();
  let count = 0;

  for (const item of patterns || []) {
    if (lower.includes(item)) count += 1;
  }

  return count;
}

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

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
  }

  if (Array.isArray(body.transcriptLines)) return body.transcriptLines.filter(Boolean).join("\n");
  if (Array.isArray(body.lines)) return body.lines.filter(Boolean).join("\n");

  return "";
}

/* -------------------------------------------------------------------------- */
/* Transcript cleaning                                                        */
/* -------------------------------------------------------------------------- */

function removeTimestampsAndStageDirections(text) {
  let out = String(text || "");

  for (const re of STAGE_PATTERNS) out = out.replace(re, " ");
  for (const re of TIMESTAMP_PATTERNS) out = out.replace(re, " ");

  out = out
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/[|]+/g, " ")
    .replace(/[;:,]{2,}/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s{2,}/g, " ");

  return out;
}

function splitTranscriptIntoLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .flatMap((line) =>
      String(line || "")
        .split(/(?<=[.!?])\s+|(?<=;)\s+|(?<=:)\s+(?=[A-Z])/)
        .map((part) => cleanText(part))
        .filter(Boolean)
    );
}

function stripSpeakerPrefix(line) {
  return cleanText(
    String(line || "").replace(
      /^(speaker\s*[ab12]|team\s*[ab12]|side\s*[ab12]|host|moderator|interviewer|facilitator|a|b|1|2)\s*[:\-]\s*/i,
      ""
    )
  );
}

function isLikelySetupLine(line) {
  const t = cleanText(line);
  return INTRO_PATTERNS.some((re) => re.test(t));
}

function isLikelyModeratorLine(line) {
  const t = cleanText(line).toLowerCase();
  if (!t) return false;
  if (/^(moderator|host|interviewer|facilitator)\s*[:\-]/i.test(line)) return true;
  return MODERATOR_HINTS.some((hint) => t.includes(hint));
}

function isRhetoricalIntro(line) {
  const t = cleanText(line).toLowerCase();
  return (
    /people are going to say/.test(t) ||
    /some people are going to say/.test(t) ||
    /why are you being so aggressive/.test(t) ||
    /let me tell you why/.test(t) ||
    /now i know/.test(t) ||
    /you may be wondering/.test(t) ||
    /somebody might say/.test(t) ||
    /someone might say/.test(t)
  );
}

function isNonArgumentContextLine(line) {
  const t = cleanText(line);
  if (!t) return true;
  if (CONTEXT_PATTERNS.some((re) => re.test(t))) return true;
  if (isRhetoricalIntro(t)) return true;
  return false;
}

function cleanTranscript(text) {
  const stripped = removeTimestampsAndStageDirections(text);
  const lines = splitTranscriptIntoLines(stripped);
  const cleaned = [];

  for (const rawLine of lines) {
    const line = stripSpeakerPrefix(rawLine);
    if (!line) continue;
    if (isLikelySetupLine(line)) continue;
    if (isLikelyModeratorLine(line) && wordCount(line) < 18) continue;
    cleaned.push(line);
  }

  return uniquePreserveOrder(cleaned).join("\n");
}

/* -------------------------------------------------------------------------- */
/* Side extraction                                                            */
/* -------------------------------------------------------------------------- */

function extractSides({ rawTranscript, cleanedTranscript, teamAName, teamBName }) {
  const source = cleanText(cleanedTranscript) ? cleanedTranscript : rawTranscript || "";
  const rawLines = splitTranscriptIntoLines(removeTimestampsAndStageDirections(source));

  const explicit = extractSidesByLabels(rawLines, teamAName, teamBName);
  if (explicit.teamALines.length >= 3 && explicit.teamBLines.length >= 3) {
    return explicit;
  }

  return extractSidesByAlternation(rawLines);
}

function extractSidesByLabels(lines, teamAName, teamBName) {
  const teamALines = [];
  const teamBLines = [];

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

  for (const raw of lines) {
    const line = cleanText(raw);
    if (!line) continue;
    if (isLikelySetupLine(line)) continue;
    if (isLikelyModeratorLine(line)) continue;

    if (aPatterns.some((re) => re.test(line))) {
      const cleaned = cleanText(line.replace(/^[^:\-]+[:\-]\s*/, ""));
      if (cleaned) teamALines.push(cleaned);
      continue;
    }

    if (bPatterns.some((re) => re.test(line))) {
      const cleaned = cleanText(line.replace(/^[^:\-]+[:\-]\s*/, ""));
      if (cleaned) teamBLines.push(cleaned);
    }
  }

  return {
    teamALines: uniquePreserveOrder(teamALines),
    teamBLines: uniquePreserveOrder(teamBLines)
  };
}

function extractSidesByAlternation(lines) {
  const eligible = lines
    .map((line) => cleanText(stripSpeakerPrefix(line)))
    .filter(Boolean)
    .filter((line) => !isLikelySetupLine(line))
    .filter((line) => !isLikelyModeratorLine(line))
    .filter((line) => wordCount(line) >= 6);

  const teamALines = [];
  const teamBLines = [];

  for (let i = 0; i < eligible.length; i += 1) {
    if (i % 2 === 0) teamALines.push(eligible[i]);
    else teamBLines.push(eligible[i]);
  }

  return {
    teamALines: uniquePreserveOrder(teamALines),
    teamBLines: uniquePreserveOrder(teamBLines)
  };
}

/* -------------------------------------------------------------------------- */
/* Claim extraction                                                           */
/* -------------------------------------------------------------------------- */

function toCandidateSentences(lines) {
  const source = Array.isArray(lines) ? lines : [];
  const out = [];

  for (const line of source) {
    const parts = String(line || "")
      .split(/(?<=[.!?])\s+|(?<=;)\s+|,\s+(?=(?:because|but|however|therefore|so|if|when|since)\b)/i)
      .map((x) => cleanText(x))
      .filter(Boolean);

    out.push(...parts);
  }

  return uniquePreserveOrder(out);
}

function verdictClean(text) {
  return cleanText(
    String(text || "")
      .replace(/^core point:\s*/i, "")
      .replace(/^main dispute:\s*/i, "")
      .replace(/^team\s*[ab]\s+says\s+/i, "")
      .replace(/^team\s*[ab]\s+mainly argues that\s+/i, "")
      .replace(/^team\s*[ab]\s+argues that\s+/i, "")
      .replace(/^quote[:,]?\s*/i, "")
      .replace(/^first[:,]?\s*/i, "")
      .replace(/^second[:,]?\s*/i, "")
      .replace(/^third[:,]?\s*/i, "")
      .replace(/^fourth[:,]?\s*/i, "")
      .replace(/^now[:,]?\s*/i, "")
      .replace(/^well[:,]?\s*/i, "")
      .replace(/^look[:,]?\s*/i, "")
      .replace(/^listen[:,]?\s*/i, "")
      .replace(/^and\s+/i, "")
      .replace(/^but\s+/i, "")
      .replace(/^so\s+/i, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

function isBadClaimCandidate(text) {
  const t = verdictClean(text);
  const l = t.toLowerCase();

  if (!t) return true;
  if (wordCount(t) < 7) return true;
  if (BAD_FALLBACK_TEXT.includes(l)) return true;
  if (/^[,"'`;:\-]/.test(t)) return true;
  if (/\.\.\.$/.test(t)) return true;
  if (isLikelySetupLine(t)) return true;
  if (isLikelyModeratorLine(t)) return true;
  if (isRhetoricalIntro(t)) return true;
  if (isNonArgumentContextLine(t)) return true;

  return false;
}

function scoreClaim(text) {
  const t = verdictClean(text);
  if (isBadClaimCandidate(t)) return -999;

  let score = 0;
  const lower = t.toLowerCase();

  score += Math.min(wordCount(t), 28);
  score += countHits(lower, REASONING_WORDS) * 8;
  score += countHits(lower, EVIDENCE_WORDS) * 7;
  score += countHits(lower, TOPIC_WORDS) * 5;
  score -= countHits(lower, FILLER_WORDS) * 3;
  score -= countHits(lower, OVERREACH_WORDS) * 2;

  if (/\b(because|therefore|since|if|then|shows|demonstrates|means|proves)\b/.test(lower)) score += 10;
  if (/\b(eyewitness|historical evidence|historical proof|genesis|jesus|gospel|babylonian|mesopotamian|moral law)\b/.test(lower)) score += 8;
  if (/\?/.test(t)) score -= 2;
  if (isAttackSentence(t)) score -= 4;
  if (isExampleHeavySentence(t)) score -= 3;

  return score;
}

function isAttackSentence(text) {
  const lower = cleanText(text).toLowerCase();
  return ATTACK_WORDS.some((w) => lower.includes(w));
}

function isExampleHeavySentence(text) {
  const lower = cleanText(text).toLowerCase();
  return (
    lower.includes("for example") ||
    lower.includes("for instance") ||
    lower.includes("imagine") ||
    lower.includes("heaven's gate") ||
    lower.includes("heavens gate") ||
    lower.includes("joseph smith") ||
    lower.includes("angel moroni")
  );
}

function humanizeClaim(text) {
  const raw = verdictClean(text);
  const lower = raw.toLowerCase();

  if (!raw) return "no clear usable claim survived transcript cleanup";

  if (/eyewitness/.test(lower) && /jesus/.test(lower) && /historical (proof|evidence)/.test(lower)) {
    return "eyewitness-style testimony should not automatically count as strong historical proof for Jesus";
  }

  if (/babylonian background of genesis|mesopotamian literature|primeval history of genesis/.test(lower)) {
    return "Genesis should be read against Ancient Near Eastern background material rather than as an isolated modern account";
  }

  if (/moral law/.test(lower) && /moral lawgiver/.test(lower)) {
    return "objective moral law points to a moral lawgiver";
  }

  if (/disciple whom jesus loved|johannine|beloved disciple/.test(lower)) {
    return "the beloved disciple may be a literary figure rather than a secure eyewitness";
  }

  if (/heaven'?s gate|joseph smith|angel moroni|spaceship/.test(lower)) {
    return "sincere belief by itself does not prove that the belief is historically true";
  }

  if (/papias/.test(lower) && /judas/.test(lower)) {
    return "Papias includes legendary material, which weakens it as clean historical support";
  }

  if (/everyone else.*go to hell|simply chose not to save/.test(lower)) {
    return "this point depends on a harsh theological interpretation that still needs stronger support";
  }

  return clip(raw.charAt(0).toLowerCase() + raw.slice(1), 180);
}

function classifyClaim(text) {
  const t = verdictClean(text);
  const lower = t.toLowerCase();

  if (!t) return "filler";
  if (isRhetoricalIntro(t)) return "filler";
  if (isLikelySetupLine(t)) return "filler";
  if (countHits(lower, FILLER_WORDS) >= 2) return "filler";
  if (isAttackSentence(t)) return "attack";
  if (isExampleHeavySentence(t)) return "example";

  const reasoningHits = countHits(lower, REASONING_WORDS);
  const evidenceHits = countHits(lower, EVIDENCE_WORDS);
  const topicHits = countHits(lower, TOPIC_WORDS);

  const thesisLike =
    /\b(should|should not|cannot|does not|is|are|counts as|historical proof|historical evidence)\b/.test(lower) ||
    topicHits >= 1;

  if (thesisLike && reasoningHits + evidenceHits + topicHits >= 1) return "thesis";
  if (reasoningHits >= 1 || evidenceHits >= 1 || topicHits >= 1) return "support";

  return "filler";
}

function extractClaimsForSide(lines, sideName) {
  const sentences = toCandidateSentences(lines)
    .map(verdictClean)
    .filter(Boolean)
    .filter((s) => wordCount(s) >= 5);

  const thesis = [];
  const support = [];
  const attack = [];
  const example = [];
  const filler = [];

  for (const sentence of sentences) {
    const kind = classifyClaim(sentence);
    const record = {
      text: sentence,
      human: humanizeClaim(sentence),
      score: scoreClaim(sentence)
    };

    if (kind === "thesis") thesis.push(record);
    else if (kind === "support") support.push(record);
    else if (kind === "attack") attack.push(record);
    else if (kind === "example") example.push(record);
    else filler.push(record);
  }

  const sortDesc = (a, b) => b.score - a.score;

  thesis.sort(sortDesc);
  support.sort(sortDesc);
  attack.sort(sortDesc);
  example.sort(sortDesc);
  filler.sort(sortDesc);

  return {
    sideName,
    sentences: uniquePreserveOrder(sentences),
    thesis: uniqueRecords(thesis).filter((x) => !isBadClaimCandidate(x.text)).slice(0, 5),
    support: uniqueRecords(support).filter((x) => !isBadClaimCandidate(x.text)).slice(0, 7),
    attack: uniqueRecords(attack).filter((x) => !isBadClaimCandidate(x.text)).slice(0, 5),
    example: uniqueRecords(example).filter((x) => !isBadClaimCandidate(x.text)).slice(0, 4),
    filler: uniqueRecords(filler).slice(0, 4)
  };
}

function uniqueRecords(records) {
  const out = [];
  const seen = new Set();

  for (const record of records || []) {
    const key = cleanText((record && (record.text || record.human)) || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }

  return out;
}

function bestRealClaim(sideClaims) {
  const pools = []
    .concat((sideClaims.thesis || []).map((x) => x.text))
    .concat((sideClaims.support || []).map((x) => x.text))
    .concat((sideClaims.example || []).map((x) => x.text))
    .concat(sideClaims.sentences || []);

  const ranked = uniquePreserveOrder(pools)
    .map((text) => ({ text, score: scoreClaim(text) }))
    .filter((x) => x.score > -999)
    .sort((a, b) => b.score - a.score);

  return ranked.length ? ranked[0].text : "";
}

/* -------------------------------------------------------------------------- */
/* Side analysis                                                              */
/* -------------------------------------------------------------------------- */

function inferLane(text) {
  const lower = cleanText(text).toLowerCase();

  const theologyScore = countHits(lower, [
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

  const historyScore = countHits(lower, [
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

function scoreSide(summary) {
  const raw =
    48 +
    summary.evidenceHits * 4 +
    summary.reasoningHits * 4 +
    summary.topicHits * 2 +
    summary.thesisCount * 5 +
    summary.supportCount * 2 -
    summary.overreachHits * 4 -
    summary.fillerHits * 2;

  return Math.max(10, Math.min(95, Math.round(raw)));
}

function analyzeSide(sideClaims, sideName) {
  const mainClaimText = bestRealClaim(sideClaims);
  const mainClaim = mainClaimText
    ? humanizeClaim(mainClaimText)
    : "no clear usable claim survived transcript cleanup";

  const truthClaimText =
    ((sideClaims.support || [])[0] && sideClaims.support[0].text) ||
    ((sideClaims.thesis || [])[0] && sideClaims.thesis[0].text) ||
    mainClaimText;

  const attackClaimText =
    ((sideClaims.attack || [])[0] && sideClaims.attack[0].text) || "";

  const opinionClaimText = (sideClaims.sentences || []).find(
    (s) => !isBadClaimCandidate(s) && /\b(i think|i believe|in my opinion|in my view|it seems|should|ought)\b/i.test(s)
  );

  const fillerClaimText =
    ((sideClaims.filler || [])[0] && sideClaims.filler[0].text) || "";

  const joined = cleanText((sideClaims.sentences || []).join(" ")).toLowerCase();

  const summary = {
    evidenceHits: countHits(joined, EVIDENCE_WORDS),
    reasoningHits: countHits(joined, REASONING_WORDS),
    topicHits: countHits(joined, TOPIC_WORDS),
    overreachHits: countHits(joined, OVERREACH_WORDS),
    fillerHits: countHits(joined, FILLER_WORDS),
    thesisCount: (sideClaims.thesis || []).length,
    supportCount: (sideClaims.support || []).length
  };

  return {
    sideName,
    sentences: sideClaims.sentences,
    thesis: sideClaims.thesis,
    support: sideClaims.support,
    attack: sideClaims.attack,
    example: sideClaims.example,
    filler: sideClaims.filler,
    main_position:
      mainClaimText
        ? sideName + " mainly argues that " + mainClaim + "."
        : sideName + " does not have a stable claim extracted cleanly enough for confident summarizing.",
    truth:
      truthClaimText
        ? humanizeClaim(truthClaimText)
        : sideName + " makes at least one concrete claim, though the cleanest support sentence is limited.",
    lies:
      attackClaimText
        ? humanizeClaim(attackClaimText)
        : sideName + " includes at least one claim that outruns its displayed support.",
    opinion:
      opinionClaimText
        ? humanizeClaim(opinionClaimText)
        : sideName + " includes interpretive language mixed into the case.",
    lala:
      fillerClaimText
        ? verdictClean(fillerClaimText)
        : "some filler remains after cleanup",
    bestSentence: mainClaimText,
    lane: inferLane(joined),
    integrityText: buildIntegrityText(summary.evidenceHits, summary.reasoningHits, summary.overreachHits),
    reasoningText: buildReasoningText(summary.evidenceHits, summary.reasoningHits, summary.topicHits),
    manipulationText: buildManipulationText(joined),
    fluffText:
      summary.fillerHits >= 3
        ? "Some fluff remains, but the main claims are still identifiable."
        : "Low fluff after cleanup.",
    scoreRaw: scoreSide(summary)
  };
}

/* -------------------------------------------------------------------------- */
/* Fact check stub                                                            */
/* -------------------------------------------------------------------------- */

function inferFactCheckStatus(claim) {
  const lower = cleanText(claim).toLowerCase();
  if (!lower) return "needs-review";
  if (countHits(lower, OVERREACH_WORDS) >= 1) return "flagged-overreach";
  if (countHits(lower, EVIDENCE_WORDS) >= 1) return "supported-language";
  return "needs-review";
}

function buildFactCheckNote(claim) {
  const lower = cleanText(claim).toLowerCase();
  if (!lower) return "No claim text preserved.";
  if (countHits(lower, OVERREACH_WORDS) >= 1) {
    return "Contains strong certainty or sweep language that would need outside verification.";
  }
  if (countHits(lower, EVIDENCE_WORDS) >= 1) {
    return "Uses evidence-oriented language, but outside verification is still required.";
  }
  return "This claim is analyzable, but not independently verified in this backend-only version.";
}

function buildFactCheckLayer(teamAAnalysis, teamBAnalysis, videoLink) {
  const checkedClaims = [];

  function inspect(sideAnalysis, sideName) {
    const candidates = []
      .concat((sideAnalysis.thesis || []).map((x) => x.text))
      .concat((sideAnalysis.support || []).map((x) => x.text))
      .concat((sideAnalysis.example || []).map((x) => x.text));

    const unique = uniquePreserveOrder(candidates)
      .filter((c) => !isBadClaimCandidate(c))
      .slice(0, 3);

    for (const claim of unique) {
      checkedClaims.push({
        claim: clip(sideName + ": " + humanizeClaim(claim), 220),
        status: inferFactCheckStatus(claim),
        note: buildFactCheckNote(claim),
        source: videoLink ? clip(videoLink, 180) : "Transcript-only analysis"
      });
    }
  }

  inspect(teamAAnalysis, teamAAnalysis.sideName || DEFAULT_TEAM_A);
  inspect(teamBAnalysis, teamBAnalysis.sideName || DEFAULT_TEAM_B);

  return {
    checkedClaims,
    summary:
      "Fact-check layer executed in transcript mode. Claims were filtered structurally, not externally verified."
  };
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

function strongestReasonWhy(a, b) {
  const aj = cleanText((a.sentences || []).join(" ")).toLowerCase();
  const bj = cleanText((b.sentences || []).join(" ")).toLowerCase();

  const aScore =
    countHits(aj, EVIDENCE_WORDS) * 4 +
    countHits(aj, REASONING_WORDS) * 4 +
    countHits(aj, TOPIC_WORDS) * 2 -
    countHits(aj, OVERREACH_WORDS) * 2;

  const bScore =
    countHits(bj, EVIDENCE_WORDS) * 4 +
    countHits(bj, REASONING_WORDS) * 4 +
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
  if (!reasons.length) reasons.push("it remains the cleaner usable claim in the preserved text");

  return {
    winner,
    loser,
    winnerClaim: winner.bestSentence ? humanizeClaim(winner.bestSentence) : "no clear usable claim survived transcript cleanup",
    loserClaim: loser.bestSentence ? humanizeClaim(loser.bestSentence) : "no clear usable claim survived transcript cleanup",
    text: reasons.slice(0, 2).join(" and ")
  };
}

function weakPointReason(analysis) {
  const joined = cleanText((analysis.sentences || []).join(" ")).toLowerCase();

  let weakClaim =
    (analysis.attack && analysis.attack[0] && analysis.attack[0].text)
      ? humanizeClaim(analysis.attack[0].text)
      : analysis.opinion || analysis.lies || humanizeClaim(analysis.bestSentence || "");

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
    (aWeak.reason.includes("lacks concrete support") ? 2 : 0) +
    (aWeak.reason.includes("asserts more than it explains") ? 2 : 0) +
    (aWeak.reason.includes("it overstates the case") ? 1 : 0);

  const bPenalty =
    (bWeak.reason.includes("lacks concrete support") ? 2 : 0) +
    (bWeak.reason.includes("asserts more than it explains") ? 2 : 0) +
    (bWeak.reason.includes("it overstates the case") ? 1 : 0);

  const weaker = aPenalty >= bPenalty ? teamAAnalysis : teamBAnalysis;
  const detail = weaker === teamAAnalysis ? aWeak : bWeak;

  return {
    side: weaker.sideName,
    text: weaker.sideName + " is weakest on " + detail.claim + " because " + detail.reason + "."
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
  const aClaim = teamAAnalysis.bestSentence ? humanizeClaim(teamAAnalysis.bestSentence) : "";
  const bClaim = teamBAnalysis.bestSentence ? humanizeClaim(teamBAnalysis.bestSentence) : "";

  if (!aClaim && !bClaim) {
    return "The transcript cleanup did not preserve a stable core claim for either side clearly enough to summarize.";
  }

  if (!aClaim || !bClaim) {
    return "One side preserves a clearer core claim than the other after transcript cleanup.";
  }

  if (aClaim === bClaim) {
    return "Both sides circle the same topic, but they frame or support it differently in the preserved transcript.";
  }

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
  const aOver = countHits(cleanText((teamAAnalysis.sentences || []).join(" ")), OVERREACH_WORDS);
  const bOver = countHits(cleanText((teamBAnalysis.sentences || []).join(" ")), OVERREACH_WORDS);

  if (aOver === bOver) return "Both sides show comparable overreach.";
  return aOver > bOver
    ? teamAAnalysis.sideName + " is reaching more"
    : teamBAnalysis.sideName + " is reaching more";
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis) {
  const aStrong = teamAAnalysis.bestSentence ? humanizeClaim(teamAAnalysis.bestSentence) : "no stable claim";
  const bStrong = teamBAnalysis.bestSentence ? humanizeClaim(teamBAnalysis.bestSentence) : "no stable claim";
  const aWeak = weakPointReason(teamAAnalysis);
  const bWeak = weakPointReason(teamBAnalysis);

  if (winner === "Mixed") {
    return (
      "Close call. Team A's clearest usable point is " +
      aStrong +
      ", but it is weakened because " +
      aWeak.reason +
      ". Team B's clearest usable point is " +
      bStrong +
      ", but it is weakened because " +
      bWeak.reason +
      "."
    );
  }

  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const loseWeak = weakPointReason(strongest.loser);

  return (
    winner +
    " wins because its clearest usable point is " +
    strongest.winnerClaim +
    ", and " +
    strongest.text +
    ". The other side falls behind because " +
    loseWeak.reason +
    "."
  );
}

/* -------------------------------------------------------------------------- */
/* Result builder                                                             */
/* -------------------------------------------------------------------------- */

function buildResult(teamAName, teamBName, teamAAnalysis, teamBAnalysis, factLayer) {
  const winner = decideWinner(teamAAnalysis, teamBAnalysis);
  const confidence = buildConfidence(teamAAnalysis.scoreRaw, teamBAnalysis.scoreRaw);
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const weakest = strongerWeakPoint(teamAAnalysis, teamBAnalysis);

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
    same_lane_engagement: buildSameLaneEngagement(teamAAnalysis.lane, teamBAnalysis.lane),
    lane_mismatch: buildLaneMismatch(teamAAnalysis.lane, teamBAnalysis.lane),

    strongestArgumentSide: strongest.winner.sideName,
    strongestArgument:
      strongest.winner.bestSentence
        ? "Core point: " + strongest.winnerClaim
        : "No strongest argument could be isolated cleanly from the preserved transcript.",
    whyStrongest: "It stands out because " + strongest.text + ".",
    failedResponseByOtherSide:
      strongest.loser.bestSentence
        ? strongest.loser.sideName +
          " does not beat that point with a cleaner rival claim. Its nearest competing claim is: " +
          strongest.loserClaim +
          "."
        : strongest.loser.sideName + " does not preserve a cleaner competing claim in the transcript.",
    weakestOverall: weakest.text,

    bsMeter: buildBSMeter(teamAAnalysis, teamBAnalysis),
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

    core_disagreement: buildCoreDisagreement(teamAAnalysis, teamBAnalysis),
    why: buildOverallWhy(winner, teamAAnalysis, teamBAnalysis),

    analysisMode: ANALYSIS_MODE,
    sources: Array.isArray(factLayer.checkedClaims) ? factLayer.checkedClaims : []
  };
}

/* -------------------------------------------------------------------------- */
/* Consistency                                                                */
/* -------------------------------------------------------------------------- */

function meaningful(value, fallback) {
  const v = cleanText(value);
  if (!v) return fallback;
  if (v === "-" || /^none$/i.test(v)) return fallback;
  return v;
}

function normalizeConfidence(value) {
  const v = cleanText(value);
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
    safe.teamA.main_position,
    safe.teamAName + " does not have a stable claim extracted cleanly enough for confident summarizing."
  );
  safe.teamA.truth = meaningful(
    safe.teamA.truth,
    safe.teamAName + " makes at least one concrete claim, though the cleanest support sentence is limited."
  );
  safe.teamA.lies = meaningful(
    safe.teamA.lies,
    safe.teamAName + " includes at least one claim that outruns its displayed support."
  );
  safe.teamA.opinion = meaningful(
    safe.teamA.opinion,
    safe.teamAName + " includes interpretive language mixed into the case."
  );
  safe.teamA.lala = meaningful(safe.teamA.lala, "some filler remains after cleanup");

  safe.teamB.main_position = meaningful(
    safe.teamB.main_position,
    safe.teamBName + " does not have a stable claim extracted cleanly enough for confident summarizing."
  );
  safe.teamB.truth = meaningful(
    safe.teamB.truth,
    safe.teamBName + " makes at least one concrete claim, though the cleanest support sentence is limited."
  );
  safe.teamB.lies = meaningful(
    safe.teamB.lies,
    safe.teamBName + " includes at least one claim that outruns its displayed support."
  );
  safe.teamB.opinion = meaningful(
    safe.teamB.opinion,
    safe.teamBName + " includes interpretive language mixed into the case."
  );
  safe.teamB.lala = meaningful(safe.teamB.lala, "some filler remains after cleanup");

  safe.teamA_integrity = meaningful(safe.teamA_integrity, safe.teamAName + " has a mixed integrity profile.");
  safe.teamB_integrity = meaningful(safe.teamB_integrity, safe.teamBName + " has a mixed integrity profile.");
  safe.teamA_reasoning = meaningful(safe.teamA_reasoning, safe.teamAName + " shows some reasoning but not every step is fully developed.");
  safe.teamB_reasoning = meaningful(safe.teamB_reasoning, safe.teamBName + " shows some reasoning but not every step is fully developed.");

  safe.teamA_lane = meaningful(safe.teamA_lane, "mixed / unclear lane");
  safe.teamB_lane = meaningful(safe.teamB_lane, "mixed / unclear lane");
  safe.same_lane_engagement = meaningful(safe.same_lane_engagement, "Both sides engage only partially in the same lane.");
  safe.lane_mismatch = meaningful(safe.lane_mismatch, "Some lane mismatch remains in how the sides frame the issue.");

  safe.strongestArgumentSide = meaningful(
    safe.strongestArgumentSide,
    safe.winner === "Mixed" ? safe.teamAName : safe.winner
  );
  safe.strongestArgument = meaningful(
    safe.strongestArgument,
    "No strongest argument could be isolated cleanly from the preserved transcript."
  );
  safe.whyStrongest = meaningful(
    safe.whyStrongest,
    "The strongest surviving point was the cleaner argument in the preserved text."
  );
  safe.failedResponseByOtherSide = meaningful(
    safe.failedResponseByOtherSide,
    "The opposing side does not preserve a cleaner competing claim in the transcript."
  );
  safe.weakestOverall = meaningful(
    safe.weakestOverall,
    "The weakest overall point is the one with the least support and clearest interpretive stretch."
  );

  safe.bsMeter = meaningful(safe.bsMeter, "Both sides show some degree of overreach.");
  safe.manipulation = meaningful(safe.manipulation, "Manipulation is limited or not clearly dominant in the preserved transcript.");
  safe.fluff = meaningful(safe.fluff, "Some fluff remains, but core claims are still visible.");

  safe.core_disagreement = meaningful(
    safe.core_disagreement,
    "The sides disagree over which core claim is better supported."
  );
  safe.why = meaningful(
    safe.why,
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

function buildFailureResponse(req, err) {
  const body = req && typeof req.body === "object" && req.body ? req.body : {};
  const teamAName = normalizeName(body.teamAName || DEFAULT_TEAM_A);
  const teamBName = normalizeName(body.teamBName || DEFAULT_TEAM_B);
  const message = cleanText(err && err.message ? err.message : "Unknown backend error");

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
/* ===================== APPEND: STOP CLAIM COLLAPSE PATCH ===================== */

function rawClaimForCompare(text) {
  return cleanText(
    String(text || "")
      .replace(/\b\d+\s*seconds?\b/gi, " ")
      .replace(/\b\d+\s*minutes?\b/gi, " ")
      .replace(/\b\d+\s*hours?\b/gi, " ")
      .replace(/\b\d+:\d+(?::\d+)?\b/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

function looksTooGenericClaim(text) {
  const t = cleanText(text).toLowerCase();
  return (
    !t ||
    t === "genesis should be read against ancient near eastern background material rather than as an isolated modern account" ||
    t === "sincere belief by itself does not prove that the belief is historically true" ||
    t === "the beloved disciple may be a literary figure rather than a secure eyewitness" ||
    t === "papias includes legendary material, which weakens it as clean historical support" ||
    t === "this point depends on a harsh theological interpretation that still needs stronger support"
  );
}

function humanizeClaim(text) {
  const raw = rawClaimForCompare(verdictClean(text));
  const lower = raw.toLowerCase();

  if (!raw) return "no clear usable claim survived transcript cleanup";

  if (/eyewitness/.test(lower) && /jesus/.test(lower) && /historical (proof|evidence)/.test(lower)) {
    return "eyewitness testimony alone should not automatically settle the historical case for Jesus";
  }

  if (/babylonian background of genesis|mesopotamian literature|ancient near eastern background/.test(lower)) {
    if (/directly dependent|dependent on/.test(lower)) {
      return "Genesis is being argued to depend directly on Ancient Near Eastern source material";
    }
    if (/read against|background material|context/.test(lower)) {
      return "Genesis is being argued to require Ancient Near Eastern background context for proper reading";
    }
    return clip(raw, 180);
  }

  if (/literary typology|historical reportage|gospel narratives are shaped/.test(lower)) {
    return "the Gospels are being argued to be shaped by literary typology rather than straightforward historical reportage";
  }

  if (/martyrdom of the early disciples|wes himself admits|disciples are largely historically questionable/.test(lower)) {
    return "the historical case for disciple martyrdom is being argued to be weaker than apologists claim";
  }

  if (/simon bar.?g(i|o)ra|movement died with him|messianic figure/.test(lower)) {
    return "failed messianic movements are being used as a historical comparison against Christian claims";
  }

  if (/academic press|eyewitness testimony behind the gospels|undermines the apologetic claim/.test(lower)) {
    return "academic scholarship is being used to argue against eyewitness testimony behind the Gospels";
  }

  if (/moral law/.test(lower) && /moral lawgiver/.test(lower)) {
    return "objective moral law is being used to argue for a moral lawgiver";
  }

  if (/disciple whom jesus loved|johannine|beloved disciple/.test(lower)) {
    return "the beloved disciple is being challenged as secure eyewitness evidence";
  }

  if (/heaven'?s gate|joseph smith|angel moroni|spaceship/.test(lower)) {
    return "sincere belief is being used as an example that belief alone does not prove truth";
  }

  if (/papias/.test(lower) && /judas/.test(lower)) {
    return "Papias is being used in a way that may overstate the strength of legendary material as history";
  }

  if (/everyone else.*go to hell|simply chose not to save/.test(lower)) {
    return "this point leans on a harsh theological interpretation that still needs stronger support";
  }

  return clip(raw, 180);
}

function strongestReasonWhy(a, b) {
  const aRaw = rawClaimForCompare(a.bestSentence || "");
  const bRaw = rawClaimForCompare(b.bestSentence || "");
  const aHuman = aRaw ? humanizeClaim(aRaw) : "no clear usable claim survived transcript cleanup";
  const bHuman = bRaw ? humanizeClaim(bRaw) : "no clear usable claim survived transcript cleanup";

  const aj = cleanText((a.sentences || []).join(" ")).toLowerCase();
  const bj = cleanText((b.sentences || []).join(" ")).toLowerCase();

  const aScore =
    countHits(aj, EVIDENCE_WORDS) * 4 +
    countHits(aj, REASONING_WORDS) * 4 +
    countHits(aj, TOPIC_WORDS) * 2 -
    countHits(aj, OVERREACH_WORDS) * 2;

  const bScore =
    countHits(bj, EVIDENCE_WORDS) * 4 +
    countHits(bj, REASONING_WORDS) * 4 +
    countHits(bj, TOPIC_WORDS) * 2 -
    countHits(bj, OVERREACH_WORDS) * 2;

  const claimsAreTooSimilar =
    aHuman === bHuman ||
    (looksTooGenericClaim(aHuman) && looksTooGenericClaim(bHuman)) ||
    (aRaw && bRaw && (
      aRaw.toLowerCase().includes(bRaw.toLowerCase()) ||
      bRaw.toLowerCase().includes(aRaw.toLowerCase())
    ));

  const winner = aScore >= bScore ? a : b;
  const loser = winner === a ? b : a;

  const reasons = [];
  const wj = winner === a ? aj : bj;
  const lj = winner === a ? bj : aj;

  if (countHits(wj, EVIDENCE_WORDS) > countHits(lj, EVIDENCE_WORDS)) reasons.push("it brings more actual support");
  if (countHits(wj, REASONING_WORDS) > countHits(lj, REASONING_WORDS)) reasons.push("it explains its logic more clearly");
  if (countHits(wj, TOPIC_WORDS) > countHits(lj, TOPIC_WORDS)) reasons.push("it stays closer to the real dispute");
  if (countHits(lj, OVERREACH_WORDS) > countHits(wj, OVERREACH_WORDS)) reasons.push("the other side overreaches more");

  if (claimsAreTooSimilar) {
    reasons.push("the raw claim wording on both sides overlaps too much after cleanup, so only support and pressure differences remain");
  }

  if (!reasons.length) reasons.push("it remains the cleaner usable claim in the preserved text");

  return {
    winner,
    loser,
    winnerClaim: winner === a ? aHuman : bHuman,
    loserClaim: winner === a ? bHuman : aHuman,
    winnerRaw: winner === a ? aRaw : bRaw,
    loserRaw: winner === a ? bRaw : aRaw,
    claimsAreTooSimilar,
    text: reasons.slice(0, 2).join(" and ")
  };
}

function buildCoreDisagreement(teamAAnalysis, teamBAnalysis) {
  const aRaw = rawClaimForCompare(teamAAnalysis.bestSentence || "");
  const bRaw = rawClaimForCompare(teamBAnalysis.bestSentence || "");
  const aClaim = aRaw ? humanizeClaim(aRaw) : "";
  const bClaim = bRaw ? humanizeClaim(bRaw) : "";

  if (!aRaw && !bRaw) {
    return "The transcript cleanup did not preserve a stable core claim for either side clearly enough to summarize.";
  }

  if (!aRaw || !bRaw) {
    return "One side preserves a clearer core claim than the other after transcript cleanup.";
  }

  if (aClaim === bClaim || (looksTooGenericClaim(aClaim) && looksTooGenericClaim(bClaim))) {
    return "Both sides stay on the same topic, but the preserved transcript does not separate their best cleaned claims sharply enough. The real difference appears more in support, examples, and pressure than in thesis wording.";
  }

  return "Main dispute: Team A says " + aClaim + ", but Team B says " + bClaim + ".";
}

function buildOverallWhy(winner, teamAAnalysis, teamBAnalysis) {
  const strongest = strongestReasonWhy(teamAAnalysis, teamBAnalysis);
  const aStrong = strongest.winner === teamAAnalysis ? strongest.winnerClaim : strongest.loserClaim;
  const bStrong = strongest.winner === teamAAnalysis ? strongest.loserClaim : strongest.winnerClaim;
  const aWeak = weakPointReason(teamAAnalysis);
  const bWeak = weakPointReason(teamBAnalysis);

  if (winner === "Mixed") {
    if (strongest.claimsAreTooSimilar) {
      return (
        "Close call. The cleaned thesis wording on both sides collapses toward the same topic, so the result turns on support quality rather than a sharply distinct thesis. Team A is weakened because " +
        aWeak.reason +
        ". Team B is weakened because " +
        bWeak.reason +
        "."
      );
    }

    return (
      "Close call. Team A's clearest usable point is " +
      aStrong +
      ", but it is weakened because " +
      aWeak.reason +
      ". Team B's clearest usable point is " +
      bStrong +
      ", but it is weakened because " +
      bWeak.reason +
      "."
    );
  }

  const loseWeak = weakPointReason(strongest.loser);

  if (strongest.claimsAreTooSimilar) {
    return (
      winner +
      " wins on support quality more than thesis uniqueness. The cleaned claims overlap too much, but " +
      strongest.text +
      ". The other side falls behind because " +
      loseWeak.reason +
      "."
    );
  }

  return (
    winner +
    " wins because its clearest usable point is " +
    strongest.winnerClaim +
    ", and " +
    strongest.text +
    ". The other side falls behind because " +
    loseWeak.reason +
    "."
  );
}

function strongerWeakPoint(teamAAnalysis, teamBAnalysis) {
  const aWeak = weakPointReason(teamAAnalysis);
  const bWeak = weakPointReason(teamBAnalysis);

  const aPenalty =
    (aWeak.reason.includes("lacks concrete support") ? 2 : 0) +
    (aWeak.reason.includes("asserts more than it explains") ? 2 : 0) +
    (aWeak.reason.includes("overstates the case") ? 1 : 0) +
    (aWeak.reason.includes("leans on interpretation") ? 1 : 0);

  const bPenalty =
    (bWeak.reason.includes("lacks concrete support") ? 2 : 0) +
    (bWeak.reason.includes("asserts more than it explains") ? 2 : 0) +
    (bWeak.reason.includes("overstates the case") ? 1 : 0) +
    (bWeak.reason.includes("leans on interpretation") ? 1 : 0);

  if (aPenalty === bPenalty) {
    return {
      side: "Mixed",
      text: "Neither side creates a clean edge on weakness. Both preserve claims with support gaps, interpretive stretch, or overreach."
    };
  }

  const weaker = aPenalty > bPenalty ? teamAAnalysis : teamBAnalysis;
  const detail = weaker === teamAAnalysis ? aWeak : bWeak;

  return {
    side: weaker.sideName,
    text: weaker.sideName + " is weakest on " + detail.claim + " because " + detail.reason + "."
  };
}

function decideWinner(teamAAnalysis, teamBAnalysis) {
  const diff = Math.abs(teamAAnalysis.scoreRaw - teamBAnalysis.scoreRaw);
  if (diff <= 2) return "Mixed";
  return teamAAnalysis.scoreRaw > teamBAnalysis.scoreRaw
    ? teamAAnalysis.sideName
    : teamBAnalysis.sideName;
}

/* =================== END APPEND: STOP CLAIM COLLAPSE PATCH =================== */
