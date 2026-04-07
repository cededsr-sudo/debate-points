"use strict";

/**
 * /api/analyze2.js
 *
 * Rewritten to match the CURRENT frontend contract exactly.
 *
 * Frontend sends:
 * {
 *   teamAName: string,
 *   teamBName: string,
 *   transcriptText: string,
 *   videoLink?: string
 * }
 *
 * Frontend expects response fields:
 * - winner
 * - confidence
 * - teamAScore
 * - teamBScore
 * - teamA_lane
 * - teamB_lane
 * - core_disagreement
 * - bsMeter
 * - strongestArgumentSide
 * - strongestArgument
 * - whyStrongest
 * - failedResponseByOtherSide
 * - weakestOverall
 * - why
 * - teamA.{main_position,truth,lies,opinion,lala}
 * - teamB.{main_position,truth,lies,opinion,lala}
 * - teamA_integrity
 * - teamB_integrity
 * - teamA_reasoning
 * - teamB_reasoning
 * - same_lane_engagement
 * - lane_mismatch
 * - manipulation
 * - fluff
 * - analysisMode
 * - sources
 */

const DEFAULT_TEAM_A = "Team A";
const DEFAULT_TEAM_B = "Team B";
const ANALYSIS_MODE = "deterministic+claim-first+sentence-filter+speaker-split+factcheck-stub";

const EVIDENCE_WORDS = [
  "evidence", "data", "study", "paper", "research", "journal", "published", "experiment",
  "observed", "results", "fossil", "molecular", "embryology", "rna", "protein", "cell",
  "chemistry", "record", "historical", "source", "sources", "quoted", "quote", "according to"
];

const REASONING_WORDS = [
  "because", "therefore", "thus", "hence", "since", "which means", "that means",
  "this shows", "this proves", "as a result", "for that reason", "if", "then"
];

const OVERREACH_WORDS = [
  "liar", "fraud", "charlatan", "delusional", "idiotic", "ridiculous", "pathetic", "clown",
  "dishonest", "embarrassing", "propagandist", "scam", "science illiterate", "gish gallop"
];

const OPINION_WORDS = [
  "i think", "i believe", "in my opinion", "clearly", "obviously", "i doubt", "i presume"
];

const FILLER_WORDS = [
  "um", "uh", "you know", "i mean", "kind of", "sort of", "well", "look", "listen"
];

const MODERATOR_WORDS = [
  "welcome to", "graduate student", "time keeper", "quick logistics", "in case of emergency",
  "please silence", "cell phones", "restroom", "live streamed", "moderator", "ground rules",
  "opening statement", "question and answer session", "thank you very much", "good night",
  "travel safely", "come up", "applause", "audience"
];

module.exports = async function analyze2Handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json(buildErrorResponse("Method not allowed. Use POST."));
  }

  try {
    const body = req && req.body && typeof req.body === "object" ? req.body : {};

    const teamAName = normalizeText(body.teamAName || DEFAULT_TEAM_A) || DEFAULT_TEAM_A;
    const teamBName = normalizeText(body.teamBName || DEFAULT_TEAM_B) || DEFAULT_TEAM_B;
    const videoLink = normalizeText(body.videoLink || "");
    const transcriptRaw = getTranscriptFromBody(body);

    if (!transcriptRaw) {
      return res.status(400).json(buildErrorResponse("Transcript is required.", teamAName, teamBName));
    }

    const cleanedTranscript = cleanTranscript(transcriptRaw);
    const allSentences = splitIntoSentences(cleanedTranscript);
    const usableSentences = allSentences.filter(isUsableSentence);

    const split = splitSides(usableSentences, teamAName, teamBName);
    const teamAAnalysis = analyzeSide(split.teamA, teamAName);
    const teamBAnalysis = analyzeSide(split.teamB, teamBName);

    const result = buildResult({
      teamAName,
      teamBName,
      videoLink,
      cleanedTranscript,
      teamAAnalysis,
      teamBAnalysis
    });

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json(buildErrorResponse(
      err && err.message ? err.message : "Server failed to analyze transcript."
    ));
  }
};

function getTranscriptFromBody(body) {
  const candidates = [
    body.transcriptText,
    body.transcript,
    body.rawTranscript,
    body.text,
    body.content,
    body.debateText,
    body.fullTranscript,
    body.videoTranscript,
    body.cleanedTranscript
  ];

  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item;
  }

  if (Array.isArray(body.transcriptLines)) return body.transcriptLines.filter(Boolean).join("\n");
  if (Array.isArray(body.lines)) return body.lines.filter(Boolean).join("\n");

  return "";
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function clip(text, max = 220) {
  const t = normalizeText(text);
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trim() + "…";
}

function cleanTranscript(text) {
  let out = String(text || "");

  out = out
    .replace(/\r/g, "\n")
    .replace(/\[Applause\]/gi, " ")
    .replace(/\[Music\]/gi, " ")
    .replace(/\[Laughter\]/gi, " ")
    .replace(/\bSync to video time\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, " ")
    .replace(/\b\d+:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\s*hours?,?\s*\d*\s*minutes?,?\s*\d*\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?,?\s*\d*\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?\b/gi, " ")
    .replace(/([a-z])([A-Z])/g, "$1. $2")
    .replace(/\n+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/[ ]{2,}/g, " ")
    .trim();

  return out;
}

function splitIntoSentences(text) {
  const prepared = String(text || "")
    .replace(/([.!?])\s+(?=[A-Z])/g, "$1\n")
    .replace(/;\s+(?=[A-Z])/g, ";\n")
    .replace(/:\s+(?=[A-Z])/g, ":\n");

  return prepared
    .split(/\n+/)
    .map(normalizeText)
    .filter(Boolean);
}

function wordCount(text) {
  const t = normalizeText(text);
  return t ? t.split(/\s+/).length : 0;
}

function containsAny(text, list) {
  const lower = normalizeText(text).toLowerCase();
  return list.some((item) => lower.includes(item));
}

function countAny(text, list) {
  const lower = normalizeText(text).toLowerCase();
  let count = 0;
  for (const item of list) if (lower.includes(item)) count += 1;
  return count;
}

function fillerRatio(text) {
  const lower = normalizeText(text).toLowerCase();
  const parts = lower.split(/\s+/).filter(Boolean);
  if (!parts.length) return 1;
  let filler = 0;
  for (const f of FILLER_WORDS) {
    if (lower.includes(f)) filler += 1;
  }
  return filler / parts.length;
}

function isModeratorSentence(text) {
  return containsAny(text, MODERATOR_WORDS);
}

function isBrokenFragment(text) {
  const t = normalizeText(text);
  if (!t) return true;
  if (wordCount(t) < 8) return true;
  if (/^[,;:.]/.test(t)) return true;
  if (/^(and|but|so|or|because|then|well)\b/i.test(t) && wordCount(t) < 14) return true;
  if (/\b(thank you|good night|travel safely)\b/i.test(t)) return true;
  return false;
}

function isUsableSentence(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (isModeratorSentence(t)) return false;
  if (isBrokenFragment(t)) return false;
  if (fillerRatio(t) > 0.12) return false;
  return true;
}

function scoreSentence(text) {
  const t = normalizeText(text);
  if (!t) return -999;

  let score = 0;
  const wc = wordCount(t);

  if (wc >= 10) score += 6;
  if (wc >= 16) score += 8;
  if (wc > 45) score -= 4;

  score += countAny(t, EVIDENCE_WORDS) * 6;
  score += countAny(t, REASONING_WORDS) * 5;
  score -= countAny(t, OVERREACH_WORDS) * 4;
  score -= countAny(t, OPINION_WORDS) * 2;

  if (/\b(show|shows|demonstrate|demonstrates|prove|proves|support|supports|undermine|undermines|refute|refutes|compare|compares)\b/i.test(t)) score += 5;
  if (/\b(cannot|can not|does not|do not|fails|failed|lack|lacks|insufficient)\b/i.test(t)) score += 4;
  if (/\b(if .* then|because .*|the reason .* is)\b/i.test(t.toLowerCase())) score += 4;
  if (/\?$/.test(t)) score -= 2;

  return score;
}

function splitSides(sentences, teamAName, teamBName) {
  const mid = Math.floor(sentences.length / 2);
  let teamA = sentences.slice(0, mid);
  let teamB = sentences.slice(mid);

  const aNamed = [];
  const bNamed = [];
  const aName = teamAName.toLowerCase();
  const bName = teamBName.toLowerCase();

  for (const s of sentences) {
    const lower = s.toLowerCase();
    if (aName && lower.includes(aName)) aNamed.push(s);
    else if (bName && lower.includes(bName)) bNamed.push(s);
  }

  if (aNamed.length >= 3) teamA = uniqueKeepOrder([...teamA, ...aNamed]);
  if (bNamed.length >= 3) teamB = uniqueKeepOrder([...teamB, ...bNamed]);

  return { teamA: uniqueKeepOrder(teamA), teamB: uniqueKeepOrder(teamB) };
}

function uniqueKeepOrder(arr) {
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const key = normalizeText(item).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeText(item));
  }
  return out;
}

function pickBestSentence(sentences, predicate) {
  const ranked = sentences
    .filter((s) => (predicate ? predicate(s) : true))
    .map((s) => ({ sentence: s, score: scoreSentence(s) }))
    .sort((a, b) => b.score - a.score);

  return ranked.length ? ranked[0].sentence : "";
}

function classifyLane(sentences) {
  const text = sentences.join(" ").toLowerCase();

  const science = (text.match(/\b(data|experiment|chemistry|rna|protein|molecule|fossil|molecular|embryology|cell|lab|study|paper|journal|evidence)\b/g) || []).length;
  const theology = (text.match(/\b(god|bible|jesus|faith|scripture|miracle|creationist|apologist|theology)\b/g) || []).length;
  const history = (text.match(/\b(history|historical|records|sources|eyewitness|literary|ancient|roman|gospel|martyrdom)\b/g) || []).length;

  const max = Math.max(science, theology, history);
  if (max < 3) return "mixed / unclear lane";
  if (science >= theology && science >= history) return "science / evidence lane";
  if (history >= science && history >= theology) return "history / evidence lane";
  if (theology >= science && theology >= history) return "theology / scripture lane";
  return "mixed lane with overlapping frameworks";
}

function analyzeSide(sentences, sideName) {
  const cleaned = uniqueKeepOrder(sentences).filter(isUsableSentence);

  const bestSentence = pickBestSentence(cleaned);
  const truth = pickBestSentence(cleaned, (s) => containsAny(s, EVIDENCE_WORDS) || containsAny(s, REASONING_WORDS));
  const lies = pickBestSentence(cleaned, (s) => containsAny(s, OVERREACH_WORDS));
  const opinion = pickBestSentence(cleaned, (s) => containsAny(s, OPINION_WORDS));
  const lala = pickBestSentence(cleaned, (s) => fillerRatio(s) > 0.04);

  const supportHits = cleaned.reduce((n, s) => n + countAny(s, EVIDENCE_WORDS), 0);
  const reasonHits = cleaned.reduce((n, s) => n + countAny(s, REASONING_WORDS), 0);
  const overreachHits = cleaned.reduce((n, s) => n + countAny(s, OVERREACH_WORDS), 0);
  const opinionHits = cleaned.reduce((n, s) => n + countAny(s, OPINION_WORDS), 0);

  const scoreRaw = Math.max(0, Math.min(100, 45 + supportHits * 4 + reasonHits * 3 - overreachHits * 4 - opinionHits * 2));

  return {
    sideName,
    sentences: cleaned,
    bestSentence: bestSentence || `${sideName} does not preserve a stable main claim clearly enough in the transcript.`,
    main_position: bestSentence || `${sideName} does not preserve a stable main claim clearly enough in the transcript.`,
    truth: truth || `${sideName} preserves topic material, but no cleaner evidence sentence outranks the surviving fragments.`,
    lies: lies || `${sideName} shows some overreach or unsupported phrasing, but no single sentence is clean enough to isolate as the main weak point.`,
    opinion: opinion || `${sideName} includes interpretive language mixed into the case.`,
    lala: lala || `some filler remains after cleanup`,
    lane: classifyLane(cleaned),
    scoreRaw,
    integrityText: supportHits >= overreachHits
      ? `Leans more grounded than inflated, though not every claim is equally supported.`
      : `Mixed integrity profile: some grounded points, some interpretive stretch, some unresolved support gaps.`,
    reasoningText: reasonHits >= 2
      ? `Uses support language and topic engagement, though the chain from premise to conclusion is less consistent.`
      : `Reasoning exists, but much of it is asserted more than fully demonstrated.`,
    manipulationText: overreachHits >= 2
      ? `Noticeable pressure language and framing tactics show up alongside the argument.`
      : `Low obvious manipulation in the preserved text.`,
    fluffText: fillerRatio(cleaned.join(" ")) > 0.05
      ? `Some fluff remains, but the main claims are still identifiable.`
      : `Low fluff after cleanup.`
  };
}

function normalizeDisplayScore(raw) {
  return String(Math.max(1, Math.min(10, Math.round(raw / 10))));
}

function buildConfidence(a, b) {
  const diff = Math.abs(a - b);
  return `${Math.max(51, Math.min(95, 50 + diff * 2))}%`;
}

function stableClaim(text) {
  const t = normalizeText(text)
    .replace(/^core point:\s*/i, "")
    .replace(/^that\s+/i, "")
    .replace(/^,\s*/i, "")
    .trim();

  if (!t || isBrokenFragment(t)) return "";
  return clip(t, 170);
}

function decideWinner(teamA, teamB) {
  const diff = teamA.scoreRaw - teamB.scoreRaw;
  if (diff >= 8) return teamA.sideName;
  if (diff <= -8) return teamB.sideName;
  return "Mixed";
}

function buildResult({ teamAName, teamBName, videoLink, cleanedTranscript, teamAAnalysis, teamBAnalysis }) {
  const winner = decideWinner(teamAAnalysis, teamBAnalysis);
  const strongestIsA = scoreSentence(teamAAnalysis.bestSentence) >= scoreSentence(teamBAnalysis.bestSentence);
  const strongest = strongestIsA ? teamAAnalysis : teamBAnalysis;
  const weaker = strongestIsA ? teamBAnalysis : teamAAnalysis;

  const coreA = stableClaim(teamAAnalysis.truth || teamAAnalysis.bestSentence);
  const coreB = stableClaim(teamBAnalysis.truth || teamBAnalysis.bestSentence);

  let coreDisagreement = "The sides disagree over which core claim is better supported.";
  if (coreA && coreB && coreA.toLowerCase() !== coreB.toLowerCase()) {
    coreDisagreement = `Main dispute: ${teamAName} says ${coreA}, while ${teamBName} says ${coreB}.`;
  } else if (coreA || coreB) {
    coreDisagreement = `Both sides circle the same topic, but they frame or support it differently in the preserved transcript.`;
  }

  let sameLane = `Both sides largely argue in the same lane: ${teamAAnalysis.lane}.`;
  let laneMismatch = `Low lane mismatch. They are mostly fighting on shared ground.`;
  if (teamAAnalysis.lane !== teamBAnalysis.lane) {
    sameLane = `At least one side blends lanes, so engagement is only partial rather than cleanly matched.`;
    laneMismatch = `Lane mismatch exists: ${teamAName} is mainly in ${teamAAnalysis.lane}, while ${teamBName} is mainly in ${teamBAnalysis.lane}.`;
  }

  const bsMeter = teamAAnalysis.scoreRaw === teamBAnalysis.scoreRaw
    ? "Both sides show comparable overreach."
    : teamAAnalysis.scoreRaw < teamBAnalysis.scoreRaw
      ? `${teamAName} is reaching more`
      : `${teamBName} is reaching more`;

  const strongestArgument = stableClaim(strongest.bestSentence) || "No stable strongest argument could be finalized from the preserved transcript.";
  const whyStrongest = strongestArgument.startsWith("No stable")
    ? "No strongest argument was selected because the extracted transcript material stayed too unstable."
    : "It stands out because it brings more actual support and it stays closer to the real dispute.";

  const failedResponseByOtherSide = stableClaim(weaker.bestSentence)
    ? `${weaker.sideName} does not beat that point with a cleaner rival claim. Its nearest competing claim is: ${stableClaim(weaker.bestSentence)}`
    : `${weaker.sideName} does not preserve a cleaner rival claim strongly enough to displace the other side's best point.`;

  const weakestOverall = weaker.lies && !/shows some overreach/i.test(weaker.lies)
    ? `${weaker.sideName} is weakest on ${stableClaim(weaker.lies)} because it overstates the case and leans on interpretation more than demonstration.`
    : `Neither side creates a clean edge on weakness. Both preserve claims with support gaps, interpretive stretch, or overreach.`;

  const why = winner === "Mixed"
    ? `Close call. ${teamAName}'s clearest usable point is ${stableClaim(teamAAnalysis.bestSentence) || "not stable enough to quote cleanly"}, while ${teamBName}'s clearest usable point is ${stableClaim(teamBAnalysis.bestSentence) || "not stable enough to quote cleanly"}. The result comes from comparing claim clarity, support, overreach, and rebuttal strength.`
    : `${winner} wins because its best point stays closer to a usable claim-plus-support structure, while the other side leaves more unresolved weakness, overreach, or rebuttal failure in the preserved transcript.`;

  return {
    teamAName,
    teamBName,
    winner,
    confidence: buildConfidence(teamAAnalysis.scoreRaw, teamBAnalysis.scoreRaw),
    teamAScore: normalizeDisplayScore(teamAAnalysis.scoreRaw),
    teamBScore: normalizeDisplayScore(teamBAnalysis.scoreRaw),

    teamA: {
      main_position: clip(teamAAnalysis.main_position),
      truth: clip(teamAAnalysis.truth),
      lies: clip(teamAAnalysis.lies),
      opinion: clip(teamAAnalysis.opinion),
      lala: clip(teamAAnalysis.lala)
    },

    teamB: {
      main_position: clip(teamBAnalysis.main_position),
      truth: clip(teamBAnalysis.truth),
      lies: clip(teamBAnalysis.lies),
      opinion: clip(teamBAnalysis.opinion),
      lala: clip(teamBAnalysis.lala)
    },

    teamA_integrity: teamAAnalysis.integrityText,
    teamB_integrity: teamBAnalysis.integrityText,
    teamA_reasoning: teamAAnalysis.reasoningText,
    teamB_reasoning: teamBAnalysis.reasoningText,

    teamA_lane: teamAAnalysis.lane,
    teamB_lane: teamBAnalysis.lane,
    same_lane_engagement: sameLane,
    lane_mismatch: laneMismatch,

    strongestArgumentSide: strongest.sideName,
    strongestArgument,
    whyStrongest,
    failedResponseByOtherSide,
    weakestOverall,

    bsMeter,
    manipulation: `${teamAName}: ${teamAAnalysis.manipulationText} ${teamBName}: ${teamBAnalysis.manipulationText}`,
    fluff: `${teamAName}: ${teamAAnalysis.fluffText} ${teamBName}: ${teamBAnalysis.fluffText}`,

    core_disagreement: coreDisagreement,
    why,

    analysisMode: ANALYSIS_MODE,
    sources: buildSources(teamAAnalysis, teamBAnalysis, videoLink)
  };
}

function buildSources(teamAAnalysis, teamBAnalysis, videoLink) {
  const items = [];

  const pushSide = (side) => {
    for (const sentence of side.sentences.slice(0, 4)) {
      items.push({
        claim: `${side.sideName}: ${clip(sentence, 180)}`,
        status: containsAny(sentence, OVERREACH_WORDS)
          ? "flagged-overreach"
          : containsAny(sentence, EVIDENCE_WORDS)
            ? "supported-language"
            : "needs-review",
        note: containsAny(sentence, EVIDENCE_WORDS)
          ? "Uses evidence-oriented language, but outside verification is still required."
          : "This claim is analyzable, but not independently verified in this backend-only version.",
        source: videoLink || "Transcript-only analysis"
      });
    }
  };

  pushSide(teamAAnalysis);
  pushSide(teamBAnalysis);

  return items.slice(0, 8);
}

function buildErrorResponse(message, teamAName = DEFAULT_TEAM_A, teamBName = DEFAULT_TEAM_B) {
  return {
    teamAName,
    teamBName,
    winner: "-",
    confidence: "-%",
    teamAScore: "-",
    teamBScore: "-",

    teamA: {
      main_position: "-",
      truth: "-",
      lies: "-",
      opinion: "-",
      lala: "-"
    },

    teamB: {
      main_position: "-",
      truth: "-",
      lies: "-",
      opinion: "-",
      lala: "-"
    },

    teamA_integrity: "-",
    teamB_integrity: "-",
    teamA_reasoning: "-",
    teamB_reasoning: "-",
    teamA_lane: "-",
    teamB_lane: "-",
    same_lane_engagement: "-",
    lane_mismatch: "-",
    strongestArgumentSide: "-",
    strongestArgument: "-",
    whyStrongest: "-",
    failedResponseByOtherSide: "-",
    weakestOverall: "-",
    bsMeter: "-",
    manipulation: "-",
    fluff: "-",
    core_disagreement: "-",
    why: "-",
    analysisMode: "-",
    sources: [],
    error: normalizeText(message) || "Unknown backend error"
  };
}
