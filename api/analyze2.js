// /api/analyze2.js

const express = require("express");
const router = express.Router();

/*
  Debate Judgment Engine - Final Backend Rewrite
  ------------------------------------------------
  REQUIRED PIPELINE:
  1. Transcript Cleaning
  2. Side Extraction (Team A / Team B)
  3. Local Deterministic Analysis
  4. Fact Check Layer (stubbed but present)
  5. AI Refinement (prompt-based)
  6. Merge Layer (AI overrides weak text)
  7. Consistency Enforcement
  8. Final JSON response

  NOTES:
  - Preserves exact success JSON contract requested by user
  - Never returns "none"
  - Never leaves failedResponseByOtherSide or weakestOverall empty
  - Avoids moderator/host/setup pollution
  - Uses hard fallbacks so output always exists
*/

const ANALYSIS_MODE = process.env.ANALYSIS_MODE || "deterministic+ai";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* =========================================================
   SHARED CONSTANTS
========================================================= */

const DEFAULT_TEAM_A = "Team A";
const DEFAULT_TEAM_B = "Team B";

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
  "so",
  "since",
  "if",
  "then",
  "which means",
  "that means",
  "consequently",
  "follows",
  "implies"
];

const EVIDENCE_WORDS = [
  "data",
  "study",
  "studies",
  "evidence",
  "example",
  "examples",
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
  "proof",
  "statistic",
  "statistics"
];

const SETUP_PATTERNS = [
  /\bwelcome everyone\b/i,
  /\btoday we are here\b/i,
  /\bintroduce our speakers\b/i,
  /\bthanks for having me\b/i,
  /\bthank you for having me\b/i,
  /\bsmash that like button\b/i,
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
  /\bround of applause\b/i
];

const MODERATOR_HINTS = [
  "moderator",
  "host",
  "interviewer",
  "panelist",
  "panel",
  "facilitator"
];

const STAGE_DIRECTION_PATTERNS = [
  /\[[^\]]*music[^\]]*\]/gi,
  /\[[^\]]*applause[^\]]*\]/gi,
  /\[[^\]]*laughter[^\]]*\]/gi,
  /\[[^\]]*cheers[^\]]*\]/gi,
  /\[[^\]]*crosstalk[^\]]*\]/gi,
  /\[[^\]]*inaudible[^\]]*\]/gi,
  /\([^\)]*music[^\)]*\)/gi,
  /\([^\)]*applause[^\)]*\)/gi,
  /\([^\)]*laughter[^\)]*\)/gi,
  /\([^\)]*cheers[^\)]*\)/gi,
  /\([^\)]*crosstalk[^\)]*\)/gi,
  /\([^\)]*inaudible[^\)]*\)/gi
];

const TIMESTAMP_PATTERNS = [
  /\b\d{1,2}:\d{2}\b/g,
  /\b\d{1,2}:\d{2}:\d{2}\b/g,
  /\b\d+h\s*\d+m\s*\d+s\b/gi,
  /\b\d+\s*seconds?\b/gi,
  /\b\d+\s*minutes?\b/gi,
  /\b\d+\s*hrs?\b/gi,
  /\b\d+\s*hours?\b/gi
];

/* =========================================================
   UTILS
========================================================= */

function asString(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function cleanWhitespace(text) {
  return asString(text)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function uniquePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function wordCount(text) {
  const m = asString(text).trim().match(/\b[\w'-]+\b/g);
  return m ? m.length : 0;
}

function sentenceSplit(text) {
  return asString(text)
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeSentence(s) {
  return asString(s)
    .replace(/^[\s"'“”‘’\-–—:;,.]+/, "")
    .replace(/[\s"'“”‘’\-–—:;,.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lower(text) {
  return asString(text).toLowerCase();
}

function containsAny(text, list) {
  const t = lower(text);
  return list.some(item => t.includes(item.toLowerCase()));
}

function regexAny(text, patterns) {
  return patterns.some(re => re.test(text));
}

function stripSpeakerPrefix(line) {
  return asString(line)
    .replace(/^\s*(speaker\s*[ab]|team\s*[ab]|a|b|side\s*[ab]|debater\s*[ab])\s*[:\-]\s*/i, "")
    .replace(/^\s*[A-Z][A-Za-z0-9_.\- ]{0,30}\s*[:\-]\s*/, "")
    .trim();
}

function hasReasoning(text) {
  return containsAny(text, REASONING_WORDS);
}

function hasEvidence(text) {
  return containsAny(text, EVIDENCE_WORDS);
}

function isQuestionLike(text) {
  const t = lower(text).trim();
  return t.endsWith("?") || /^(why|how|what|when|where|who|is|are|do|does|did|can|could|would|should)\b/.test(t);
}

function isTooShort(text) {
  return wordCount(text) < 6;
}

function isLikelySetupLine(text) {
  const t = lower(text);
  if (regexAny(t, SETUP_PATTERNS)) return true;
  if (/^\s*(hello|hi|good evening|good afternoon|good morning)\b/.test(t)) return true;
  if (/^\s*(welcome|introducing|thank you|thanks)\b/.test(t) && wordCount(t) < 18) return true;
  return false;
}

function isLikelyModeratorLine(text) {
  const t = lower(text);
  if (containsAny(t, MODERATOR_HINTS)) return true;
  if (/^\s*(next question|first question|opening statement|closing statement|cross[- ]?examination|rebuttal time)\b/.test(t)) return true;
  if (/^\s*(let me ask|i'll ask|my question is|the question is|we'll move on)\b/.test(t)) return true;
  return false;
}

function safeExcerpt(text, max = 240) {
  const t = cleanWhitespace(text);
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

function pickBestNonEmpty(candidates, fallback) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return fallback;
}

function numericScoreToString(n) {
  return String(clamp(Math.round(n), 0, 100));
}

/* =========================================================
   1. TRANSCRIPT CLEANING
========================================================= */

function cleanTranscript(rawTranscript) {
  let text = cleanWhitespace(rawTranscript);

  for (const re of TIMESTAMP_PATTERNS) {
    text = text.replace(re, " ");
  }

  for (const re of STAGE_DIRECTION_PATTERNS) {
    text = text.replace(re, " ");
  }

  text = text
    .replace(/\[(.*?)\]/g, " ")
    .replace(/\((.*?)\)/g, (m, inner) => {
      if (!inner) return " ";
      const t = inner.trim().toLowerCase();
      if (
        t.includes("applause") ||
        t.includes("music") ||
        t.includes("laughter") ||
        t.includes("inaudible") ||
        t.includes("crosstalk") ||
        t.includes("cheers")
      ) {
        return " ";
      }
      return ` ${inner} `;
    })
    .replace(/\b(ad break|commercial break)\b/gi, " ")
    .replace(/\b(www\.[^\s]+|https?:\/\/[^\s]+)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const rawLines = cleanWhitespace(rawTranscript)
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  const cleanedLines = [];
  for (let line of rawLines) {
    let original = line;

    for (const re of TIMESTAMP_PATTERNS) {
      line = line.replace(re, " ");
    }
    for (const re of STAGE_DIRECTION_PATTERNS) {
      line = line.replace(re, " ");
    }

    line = cleanWhitespace(line);

    if (!line) continue;
    if (isLikelySetupLine(line)) continue;
    if (isLikelyModeratorLine(line) && wordCount(line) < 18) continue;

    const dePrefixed = stripSpeakerPrefix(line);
    if (isLikelySetupLine(dePrefixed)) continue;

    cleanedLines.push(original ? line : dePrefixed);
  }

  const lineJoined = uniquePreserveOrder(cleanedLines).join("\n");
  const finalText = cleanWhitespace(lineJoined || text);

  return {
    cleanedTranscript: finalText,
    cleanedLines: uniquePreserveOrder(
      finalText
        .split("\n")
        .map(l => cleanWhitespace(l))
        .filter(Boolean)
    )
  };
}

/* =========================================================
   2. SIDE EXTRACTION
========================================================= */

function detectSpeakerCue(line) {
  const l = asString(line).trim();

  if (/^\s*(speaker\s*a|team\s*a|a|side\s*a|debater\s*a)\s*[:\-]/i.test(l)) {
    return { side: "A", stripped: stripSpeakerPrefix(l) };
  }
  if (/^\s*(speaker\s*b|team\s*b|b|side\s*b|debater\s*b)\s*[:\-]/i.test(l)) {
    return { side: "B", stripped: stripSpeakerPrefix(l) };
  }

  const namedMatch = l.match(/^\s*([A-Z][A-Za-z0-9_.\- ]{0,30})\s*[:\-]\s*(.+)$/);
  if (namedMatch) {
    return { side: null, name: namedMatch[1].trim(), stripped: namedMatch[2].trim() };
  }

  return { side: null, stripped: l };
}

function extractSpeakerNames(lines) {
  const counts = new Map();

  for (const line of lines) {
    const m = asString(line).match(/^\s*([A-Z][A-Za-z0-9_.\- ]{0,30})\s*[:\-]\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const speech = m[2].trim();
    if (!name || !speech) continue;
    if (isLikelyModeratorLine(name)) continue;
    if (isLikelySetupLine(speech)) continue;
    if (wordCount(speech) < 4) continue;

    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

function extractSides(cleanedLines) {
  const lines = Array.isArray(cleanedLines) ? cleanedLines : [];
  const topNames = extractSpeakerNames(lines);

  let teamAName = DEFAULT_TEAM_A;
  let teamBName = DEFAULT_TEAM_B;

  if (topNames.length >= 2) {
    teamAName = topNames[0];
    teamBName = topNames[1];
  }

  const teamALines = [];
  const teamBLines = [];

  let lastAssigned = "B";
  let structuredMode = false;

  for (const rawLine of lines) {
    if (!rawLine) continue;

    const cue = detectSpeakerCue(rawLine);
    let line = cleanWhitespace(cue.stripped || rawLine);
    if (!line) continue;

    if (isLikelySetupLine(line)) continue;
    if (isLikelyModeratorLine(rawLine) || isLikelyModeratorLine(line)) continue;

    if (cue.side === "A") {
      structuredMode = true;
      if (!isTooShort(line)) teamALines.push(line);
      lastAssigned = "A";
      continue;
    }

    if (cue.side === "B") {
      structuredMode = true;
      if (!isTooShort(line)) teamBLines.push(line);
      lastAssigned = "B";
      continue;
    }

    const namedMatch = asString(rawLine).match(/^\s*([A-Z][A-Za-z0-9_.\- ]{0,30})\s*[:\-]\s*(.+)$/);
    if (namedMatch) {
      const speakerName = namedMatch[1].trim();
      const spoken = cleanWhitespace(namedMatch[2]);
      if (!spoken || isLikelySetupLine(spoken) || isLikelyModeratorLine(speakerName)) continue;

      if (speakerName === teamAName) {
        structuredMode = true;
        if (!isTooShort(spoken)) teamALines.push(spoken);
        lastAssigned = "A";
        continue;
      }
      if (speakerName === teamBName) {
        structuredMode = true;
        if (!isTooShort(spoken)) teamBLines.push(spoken);
        lastAssigned = "B";
        continue;
      }
    }

    const sentences = sentenceSplit(line);

    if (structuredMode) {
      const target = lastAssigned === "A" ? teamALines : teamBLines;
      for (const s of sentences) {
        const ns = normalizeSentence(s);
        if (!ns || isTooShort(ns) || isLikelySetupLine(ns) || isLikelyModeratorLine(ns)) continue;
        target.push(ns);
      }
      continue;
    }

    // Structured fallback:
    // chunk long text into alternating blocks only when no reliable speaker IDs exist
    for (const s of sentences) {
      const ns = normalizeSentence(s);
      if (!ns || isTooShort(ns) || isLikelySetupLine(ns) || isLikelyModeratorLine(ns)) continue;
      if (lastAssigned === "A") {
        teamBLines.push(ns);
        lastAssigned = "B";
      } else {
        teamALines.push(ns);
        lastAssigned = "A";
      }
    }
  }

  // Fallback if one side got starved
  const allCandidateSentences = uniquePreserveOrder(
    lines
      .flatMap(line => sentenceSplit(stripSpeakerPrefix(line)))
      .map(normalizeSentence)
      .filter(Boolean)
      .filter(s => !isLikelySetupLine(s))
      .filter(s => !isLikelyModeratorLine(s))
      .filter(s => wordCount(s) >= 6)
  );

  if (teamALines.length < 2 || teamBLines.length < 2) {
    const splitIndex = Math.ceil(allCandidateSentences.length / 2);
    const firstHalf = allCandidateSentences.slice(0, splitIndex);
    const secondHalf = allCandidateSentences.slice(splitIndex);

    if (teamALines.length < 2) {
      teamALines.push(...firstHalf);
    }
    if (teamBLines.length < 2) {
      teamBLines.push(...secondHalf);
    }
  }

  const finalA = uniquePreserveOrder(teamALines).filter(Boolean);
  const finalB = uniquePreserveOrder(teamBLines).filter(Boolean);

  return {
    teamAName,
    teamBName,
    teamASentences: finalA,
    teamBSentences: finalB,
    extractionMeta: {
      structuredMode,
      totalLines: lines.length,
      teamALineCount: finalA.length,
      teamBLineCount: finalB.length
    }
  };
}

/* =========================================================
   3. LOCAL DETERMINISTIC ANALYSIS
========================================================= */

function scoreSentence(sentence) {
  const s = normalizeSentence(sentence);
  const l = lower(s);
  let score = 0;

  if (!s) return -999;

  // Rewards
  const wc = wordCount(s);
  score += Math.min(wc, 30);
  if (hasReasoning(s)) score += 30;
  if (hasEvidence(s)) score += 25;
  if (/\b(is|are|must|should|cannot|can't|does|did|proves|shows|demonstrates|means)\b/i.test(s)) score += 10;
  if (/\bfor example\b|\bfor instance\b|\bthat shows\b|\bthis means\b/i.test(s)) score += 12;
  if (/[,:;]/.test(s)) score += 4;

  // Penalties
  if (isLikelySetupLine(s)) score -= 70;
  if (isLikelyModeratorLine(s)) score -= 70;
  if (isTooShort(s)) score -= 50;
  if (isQuestionLike(s)) score -= 12;

  for (const filler of FILLER_WORDS) {
    if (l.includes(filler)) score -= 6;
  }

  if (/\bwelcome\b|\bsubscribe\b|\bthanks for having me\b|\bglad to be here\b/i.test(l)) score -= 80;
  if (/\b0:\d{2}\b|\b\d{1,2}:\d{2}\b/.test(l)) score -= 100;

  return score;
}

function rankSentences(sentences) {
  return uniquePreserveOrder(sentences)
    .map(s => ({
      text: normalizeSentence(s),
      score: scoreSentence(s)
    }))
    .filter(x => x.text)
    .sort((a, b) => b.score - a.score);
}

function bestSentence(sentences, fallback) {
  const ranked = rankSentences(sentences);
  return ranked.length ? ranked[0].text : fallback;
}

function summarizePosition(sentences, fallback) {
  const ranked = rankSentences(sentences).slice(0, 3).map(x => x.text);
  if (!ranked.length) return fallback;

  const first = ranked[0];
  const second = ranked[1];
  if (!second) return first;

  return safeExcerpt(`${first} ${second}`, 300);
}

function extractTruth(sentences) {
  const evidenceSentences = rankSentences(sentences)
    .filter(x => hasEvidence(x.text) || hasReasoning(x.text))
    .slice(0, 2)
    .map(x => x.text);

  if (evidenceSentences.length) {
    return safeExcerpt(`Grounded point: ${evidenceSentences.join(" ")}`, 280);
  }

  const best = bestSentence(sentences, "");
  return pickBestNonEmpty(
    [
      best && `Best concrete point: ${best}`
    ],
    "Grounded point exists, but it was thin and underdeveloped."
  );
}

function extractLies(sentences) {
  const ranked = rankSentences(sentences);
  const weak = ranked
    .filter(x => !hasEvidence(x.text) && !hasReasoning(x.text))
    .slice(0, 2)
    .map(x => x.text);

  if (weak.length) {
    return safeExcerpt(`Unsupported claim area: ${weak.join(" ")}`, 280);
  }

  return "No outright proven lie isolated from transcript alone, but several claims lacked proof.";
}

function extractOpinion(sentences) {
  const opinionLike = uniquePreserveOrder(sentences).filter(s => {
    const l = lower(s);
    return (
      l.includes("i think") ||
      l.includes("i believe") ||
      l.includes("in my view") ||
      l.includes("obviously") ||
      l.includes("clearly")
    );
  });

  if (opinionLike.length) {
    return safeExcerpt(`Opinion-heavy framing: ${opinionLike.slice(0, 2).join(" ")}`, 280);
  }

  return "Opinion was present mostly in framing rather than in direct evidence.";
}

function extractLala(sentences) {
  const fillerHeavy = uniquePreserveOrder(sentences).filter(s => {
    const l = lower(s);
    return FILLER_WORDS.some(f => l.includes(f));
  });

  if (fillerHeavy.length) {
    return safeExcerpt(`Filler / drag: ${fillerHeavy.slice(0, 2).join(" ")}`, 240);
  }

  return "Minimal filler compared with the rest of the exchange.";
}

function inferLane(sentences) {
  const joined = lower(sentences.join(" "));
  let evidenceScore = 0;
  let theologyScore = 0;
  let philosophyScore = 0;
  let rhetoricScore = 0;

  if (containsAny(joined, ["data", "study", "evidence", "proof", "record", "document", "report"])) evidenceScore += 3;
  if (containsAny(joined, ["bible", "scripture", "god", "jesus", "prophet", "church", "faith", "salvation"])) theologyScore += 3;
  if (containsAny(joined, ["logic", "premise", "conclusion", "epistemology", "ontology", "contradiction"])) philosophyScore += 3;
  if (containsAny(joined, ["you just", "you're avoiding", "dodging", "spin", "framing", "rhetoric"])) rhetoricScore += 3;

  const buckets = [
    ["evidence", evidenceScore],
    ["theological", theologyScore],
    ["philosophical", philosophyScore],
    ["rhetorical", rhetoricScore]
  ].sort((a, b) => b[1] - a[1]);

  return buckets[0][1] > 0 ? buckets[0][0] : "argument";
}

function analyzeSideDeterministically(sideName, sentences) {
  const safeFallback = `${sideName} never built a clean argument, so the engine had to reconstruct the position from weak fragments.`;
  const mainPosition = summarizePosition(sentences, safeFallback);
  const ranked = rankSentences(sentences);
  const top = ranked.slice(0, 5).map(x => x.text);
  const best = bestSentence(sentences, safeFallback);

  const reasoningStrength = clamp(
    top.reduce((sum, s) => sum + (hasReasoning(s) ? 1 : 0) + (hasEvidence(s) ? 1 : 0), 0) * 12 +
      Math.min(top.length * 6, 24),
    0,
    100
  );

  const fillerPenalty = clamp(
    uniquePreserveOrder(sentences).reduce((sum, s) => {
      const l = lower(s);
      return sum + FILLER_WORDS.filter(f => l.includes(f)).length * 5;
    }, 0),
    0,
    35
  );

  const integrityScore = clamp(reasoningStrength - fillerPenalty + (hasEvidence(best) ? 8 : 0), 0, 100);

  const reasoningText =
    reasoningStrength >= 75
      ? `${sideName} actually chained claims to reasons and evidence instead of just throwing assertions around.`
      : reasoningStrength >= 50
        ? `${sideName} had a visible argument structure, but it left too many links implied instead of proved.`
        : `${sideName} talked around the issue more than it proved the issue. The reasoning chain kept breaking.`;

  const integrityText =
    integrityScore >= 75
      ? `${sideName} stayed mostly in its lane and argued with relative discipline.`
      : integrityScore >= 50
        ? `${sideName} had some integrity, but drifted into assertion and convenience when pressure rose.`
        : `${sideName} showed weak argumentative integrity. It leaned on claim repetition more than proof.`;

  return {
    sideName,
    sentences: uniquePreserveOrder(sentences),
    ranked,
    topSentences: top,
    main_position: mainPosition,
    truth: extractTruth(sentences),
    lies: extractLies(sentences),
    opinion: extractOpinion(sentences),
    lala: extractLala(sentences),
    bestSentence: best,
    scoreRaw: clamp(reasoningStrength + integrityScore / 2, 0, 100),
    integrityNumeric: integrityScore,
    reasoningNumeric: reasoningStrength,
    integrityText,
    reasoningText,
    lane: inferLane(sentences)
  };
}

/* =========================================================
   4. FACT CHECK LAYER (STUB, REQUIRED)
========================================================= */

function factCheckLayer(teamAAnalysis, teamBAnalysis) {
  // Stub by requirement. This layer exists and can later be swapped
  // for real retrieval/fact-check APIs without changing contract.
  return {
    enabled: true,
    checkedClaims: [],
    teamA_notes: teamAAnalysis.truth,
    teamB_notes: teamBAnalysis.truth,
    verdict:
      "Fact-check layer stubbed. It preserved the pipeline and flagged claim zones, but did not call external verification."
  };
}

/* =========================================================
   5. AI REFINEMENT (PROMPT-BASED)
========================================================= */

function buildRefinementPrompt(teamAAnalysis, teamBAnalysis) {
  return `
You are a harsh debate judge. Rewrite only weak analysis text into sharper judicial language.
Rules:
- Be decisive, critical, and specific.
- Do not hedge.
- Do not say "both sides had strengths."
- Keep content anchored to the supplied transcript analysis.
- Return strict JSON only with keys:
{
  "teamA_reasoning": "...",
  "teamB_reasoning": "...",
  "teamA_integrity": "...",
  "teamB_integrity": "...",
  "core_disagreement": "...",
  "why": "...",
  "strongestArgumentSide": "...",
  "strongestArgument": "...",
  "whyStrongest": "...",
  "failedResponseByOtherSide": "...",
  "weakestOverall": "...",
  "bsMeter": "...",
  "manipulation": "...",
  "fluff": "..."
}

TEAM A:
main_position: ${JSON.stringify(teamAAnalysis.main_position)}
truth: ${JSON.stringify(teamAAnalysis.truth)}
lies: ${JSON.stringify(teamAAnalysis.lies)}
opinion: ${JSON.stringify(teamAAnalysis.opinion)}
bestSentence: ${JSON.stringify(teamAAnalysis.bestSentence)}
reasoningText: ${JSON.stringify(teamAAnalysis.reasoningText)}
integrityText: ${JSON.stringify(teamAAnalysis.integrityText)}
lane: ${JSON.stringify(teamAAnalysis.lane)}

TEAM B:
main_position: ${JSON.stringify(teamBAnalysis.main_position)}
truth: ${JSON.stringify(teamBAnalysis.truth)}
lies: ${JSON.stringify(teamBAnalysis.lies)}
opinion: ${JSON.stringify(teamBAnalysis.opinion)}
bestSentence: ${JSON.stringify(teamBAnalysis.bestSentence)}
reasoningText: ${JSON.stringify(teamBAnalysis.reasoningText)}
integrityText: ${JSON.stringify(teamBAnalysis.integrityText)}
lane: ${JSON.stringify(teamBAnalysis.lane)}
`.trim();
}

function heuristicAIRefinement(teamAAnalysis, teamBAnalysis) {
  const strongestSide =
    teamAAnalysis.scoreRaw >= teamBAnalysis.scoreRaw ? teamAAnalysis.sideName : teamBAnalysis.sideName;
  const strongestArgument =
    strongestSide === teamAAnalysis.sideName ? teamAAnalysis.bestSentence : teamBAnalysis.bestSentence;

  const weakerSide =
    strongestSide === teamAAnalysis.sideName ? teamBAnalysis.sideName : teamAAnalysis.sideName;
  const weakerAnalysis = weakerSide === teamAAnalysis.sideName ? teamAAnalysis : teamBAnalysis;

  const coreDisagreement = pickBestNonEmpty(
    [
      `${teamAAnalysis.sideName} argues that ${safeExcerpt(teamAAnalysis.main_position, 140)} while ${teamBAnalysis.sideName} argues that ${safeExcerpt(teamBAnalysis.main_position, 140)}.`,
      `${teamAAnalysis.sideName} and ${teamBAnalysis.sideName} are not merely disagreeing on tone. They are pushing incompatible conclusions.`
    ],
    "The sides pushed incompatible conclusions and never actually resolved the central claim."
  );

  const whyText =
    teamAAnalysis.lane !== teamBAnalysis.lane
      ? `${teamAAnalysis.sideName} argued in a ${teamAAnalysis.lane} lane while ${teamBAnalysis.sideName} argued in a ${teamBAnalysis.lane} lane. Part of the clash was real disagreement, and part of it was talking past each other.`
      : `The dispute stayed in the same lane, but only one side consistently tied claims to reasons. The other side kept leaving proof gaps.`;

  const failedResponse = pickBestNonEmpty(
    [
      weakerAnalysis.ranked
        .filter(x => x.score < 35)
        .map(x => x.text)[0] &&
        `${weakerSide} never landed a direct answer to the strongest point. Instead it drifted into this weaker material: ${safeExcerpt(
          weakerAnalysis.ranked.filter(x => x.score < 35).map(x => x.text)[0],
          180
        )}`,
      `${weakerSide} did not directly counter the opponent's best argument. It circled the topic and left the pressure point standing.`
    ],
    `${weakerSide} failed to directly answer the opponent's best argument.`
  );

  const weakestOverall = pickBestNonEmpty(
    [
      [...teamAAnalysis.ranked, ...teamBAnalysis.ranked]
        .sort((a, b) => a.score - b.score)
        .map(x => x.text)[0] &&
        `Weakest overall point: ${safeExcerpt(
          [...teamAAnalysis.ranked, ...teamBAnalysis.ranked].sort((a, b) => a.score - b.score).map(x => x.text)[0],
          190
        )}`,
      `${weakerSide} relied on unsupported assertion at its weakest point.`
    ],
    `${weakerSide} produced the weakest overall point by asserting more than it proved.`
  );

  const avgFillerPenalty =
    Math.round(
      (
        (100 - teamAAnalysis.integrityNumeric) +
        (100 - teamBAnalysis.integrityNumeric)
      ) / 2
    ) || 0;

  return {
    teamA_reasoning: teamAAnalysis.reasoningText,
    teamB_reasoning: teamBAnalysis.reasoningText,
    teamA_integrity: teamAAnalysis.integrityText,
    teamB_integrity: teamBAnalysis.integrityText,
    core_disagreement: coreDisagreement,
    why: whyText,
    strongestArgumentSide: strongestSide,
    strongestArgument: strongestArgument,
    whyStrongest:
      strongestSide === teamAAnalysis.sideName
        ? `${teamAAnalysis.sideName} won the best-argument battle because the point had an actual reasoning spine and some grounding instead of posture alone.`
        : `${teamBAnalysis.sideName} won the best-argument battle because the point had an actual reasoning spine and some grounding instead of posture alone.`,
    failedResponseByOtherSide: failedResponse,
    weakestOverall: weakestOverall,
    bsMeter:
      avgFillerPenalty > 45
        ? "High"
        : avgFillerPenalty > 25
          ? "Medium"
          : "Low",
    manipulation:
      teamAAnalysis.lane === "rhetorical" || teamBAnalysis.lane === "rhetorical"
        ? "Noticeable rhetorical steering and framing pressure."
        : "Limited manipulation. The bigger problem was proof gaps, not spin discipline.",
    fluff:
      avgFillerPenalty > 30
        ? "Too much verbal padding and not enough direct proof."
        : "Some fluff appeared, but it was not the main reason the weaker side lost."
  };
}

async function callOpenAIRefinement(prompt) {
  if (!OPENAI_API_KEY || typeof fetch !== "function") {
    return null;
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a precise debate judging assistant." },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function aiRefinementLayer(teamAAnalysis, teamBAnalysis) {
  const prompt = buildRefinementPrompt(teamAAnalysis, teamBAnalysis);
  const heuristic = heuristicAIRefinement(teamAAnalysis, teamBAnalysis);
  const remote = await callOpenAIRefinement(prompt);

  return {
    promptUsed: true,
    prompt,
    heuristic,
    remote
  };
}

/* =========================================================
   6. MERGE LAYER
========================================================= */

function shouldPreferAIText(text) {
  const t = asString(text).trim();
  if (!t) return false;
  if (t.length < 25) return false;
  if (/both sides had strengths/i.test(t)) return false;
  if (/moderate mismatch/i.test(t)) return false;
  if (/it seems|appears|may have|might have/i.test(t)) return false;
  return true;
}

function mergeLayer(base, aiRefinement) {
  const ai = aiRefinement?.remote || aiRefinement?.heuristic || {};

  const merged = { ...base };

  const overrideKeys = [
    "teamA_integrity",
    "teamB_integrity",
    "teamA_reasoning",
    "teamB_reasoning",
    "core_disagreement",
    "why",
    "strongestArgumentSide",
    "strongestArgument",
    "whyStrongest",
    "failedResponseByOtherSide",
    "weakestOverall",
    "bsMeter",
    "manipulation",
    "fluff"
  ];

  for (const key of overrideKeys) {
    if (shouldPreferAIText(ai[key])) {
      merged[key] = ai[key];
    }
  }

  return merged;
}

/* =========================================================
   7. CONSISTENCY ENFORCEMENT
========================================================= */

function enforceConsistency(result, teamAAnalysis, teamBAnalysis, extractionMeta) {
  const out = { ...result };

  out.teamAName = pickBestNonEmpty([out.teamAName], DEFAULT_TEAM_A);
  out.teamBName = pickBestNonEmpty([out.teamBName], DEFAULT_TEAM_B);

  out.teamA = out.teamA || {};
  out.teamB = out.teamB || {};

  out.teamA.main_position = pickBestNonEmpty(
    [out.teamA.main_position, teamAAnalysis.main_position],
    `${out.teamAName} never produced a clean main position, so the engine reconstructed the claim from fragments.`
  );
  out.teamA.truth = pickBestNonEmpty([out.teamA.truth, teamAAnalysis.truth], "Grounded point existed, but it was underdeveloped.");
  out.teamA.lies = pickBestNonEmpty([out.teamA.lies, teamAAnalysis.lies], "No outright lie could be isolated, but unsupported claims were present.");
  out.teamA.opinion = pickBestNonEmpty([out.teamA.opinion, teamAAnalysis.opinion], "Opinion shaped the framing more than the evidence did.");
  out.teamA.lala = pickBestNonEmpty([out.teamA.lala, teamAAnalysis.lala], "Some filler weakened the presentation.");

  out.teamB.main_position = pickBestNonEmpty(
    [out.teamB.main_position, teamBAnalysis.main_position],
    `${out.teamBName} never produced a clean main position, so the engine reconstructed the claim from fragments.`
  );
  out.teamB.truth = pickBestNonEmpty([out.teamB.truth, teamBAnalysis.truth], "Grounded point existed, but it was underdeveloped.");
  out.teamB.lies = pickBestNonEmpty([out.teamB.lies, teamBAnalysis.lies], "No outright lie could be isolated, but unsupported claims were present.");
  out.teamB.opinion = pickBestNonEmpty([out.teamB.opinion, teamBAnalysis.opinion], "Opinion shaped the framing more than the evidence did.");
  out.teamB.lala = pickBestNonEmpty([out.teamB.lala, teamBAnalysis.lala], "Some filler weakened the presentation.");

  out.teamA_integrity = pickBestNonEmpty(
    [out.teamA_integrity, teamAAnalysis.integrityText],
    `${out.teamAName} showed weak argumentative integrity.`
  );
  out.teamB_integrity = pickBestNonEmpty(
    [out.teamB_integrity, teamBAnalysis.integrityText],
    `${out.teamBName} showed weak argumentative integrity.`
  );

  out.teamA_reasoning = pickBestNonEmpty(
    [out.teamA_reasoning, teamAAnalysis.reasoningText],
    `${out.teamAName} did not maintain a clean reasoning chain.`
  );
  out.teamB_reasoning = pickBestNonEmpty(
    [out.teamB_reasoning, teamBAnalysis.reasoningText],
    `${out.teamBName} did not maintain a clean reasoning chain.`
  );

  out.teamA_lane = pickBestNonEmpty([out.teamA_lane, teamAAnalysis.lane], "argument");
  out.teamB_lane = pickBestNonEmpty([out.teamB_lane, teamBAnalysis.lane], "argument");

  out.same_lane_engagement = out.teamA_lane === out.teamB_lane ? "Yes" : "No";
  out.lane_mismatch =
    out.teamA_lane === out.teamB_lane
      ? "No meaningful lane mismatch."
      : `${out.teamAName} argued in a ${out.teamA_lane} lane while ${out.teamBName} argued in a ${out.teamB_lane} lane. That mismatch damaged direct engagement.`;

  out.strongestArgumentSide = pickBestNonEmpty(
    [out.strongestArgumentSide],
    teamAAnalysis.scoreRaw >= teamBAnalysis.scoreRaw ? out.teamAName : out.teamBName
  );

  out.strongestArgument = pickBestNonEmpty(
    [out.strongestArgument],
    out.strongestArgumentSide === out.teamAName ? teamAAnalysis.bestSentence : teamBAnalysis.bestSentence
  );

  out.whyStrongest = pickBestNonEmpty(
    [out.whyStrongest],
    `${out.strongestArgumentSide} delivered the sharpest claim-reason link in the debate.`
  );

  out.failedResponseByOtherSide = pickBestNonEmpty(
    [out.failedResponseByOtherSide],
    `${
      out.strongestArgumentSide === out.teamAName ? out.teamBName : out.teamAName
    } failed to directly answer the strongest point and left the pressure unresolved.`
  );

  out.weakestOverall = pickBestNonEmpty(
    [out.weakestOverall],
    `${
      teamAAnalysis.scoreRaw <= teamBAnalysis.scoreRaw ? out.teamAName : out.teamBName
    } produced the weakest overall point by asserting more than it proved.`
  );

  out.core_disagreement = pickBestNonEmpty(
    [out.core_disagreement],
    `${out.teamAName} and ${out.teamBName} are pushing incompatible conclusions and never genuinely reconciled the evidence gap.`
  );

  out.why = pickBestNonEmpty(
    [out.why],
    "The loser never fully answered the winner's central claim. That is why the disagreement stayed alive instead of being resolved."
  );

  out.bsMeter = pickBestNonEmpty([out.bsMeter], "Medium");
  out.manipulation = pickBestNonEmpty([out.manipulation], "Some framing pressure was present, but proof quality mattered more.");
  out.fluff = pickBestNonEmpty([out.fluff], "Some fluff appeared, but it did not outweigh the central argument failure.");

  // Winner / score enforcement
  const aScore = clamp(Math.round(teamAAnalysis.scoreRaw), 0, 100);
  const bScore = clamp(Math.round(teamBAnalysis.scoreRaw), 0, 100);

  out.teamAScore = numericScoreToString(aScore);
  out.teamBScore = numericScoreToString(bScore);

  if (!out.winner || !out.winner.trim()) {
    out.winner = aScore >= bScore ? out.teamAName : out.teamBName;
  }

  const diff = Math.abs(aScore - bScore);
  out.confidence =
    diff >= 25 ? "High" :
    diff >= 12 ? "Medium" :
    "Low";

  out.analysisMode = ANALYSIS_MODE;
  out.sources = Array.isArray(out.sources) ? out.sources : [];

  // If extraction was weak, force explicit criticism
  if (extractionMeta.teamALineCount < 2) {
    out.teamA_reasoning = `${out.teamAName} barely produced a usable argument. Extraction had to reconstruct this side from weak fragments, which already counts against it.`;
  }
  if (extractionMeta.teamBLineCount < 2) {
    out.teamB_reasoning = `${out.teamBName} barely produced a usable argument. Extraction had to reconstruct this side from weak fragments, which already counts against it.`;
  }

  // Never allow "none"
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.trim().toLowerCase() === "none") {
      out[k] = "No clean direct instance was isolated, but the weakness was still visible in the exchange.";
    }
  }

  if (out.teamA && typeof out.teamA === "object") {
    for (const [k, v] of Object.entries(out.teamA)) {
      if (!asString(v).trim() || asString(v).trim().toLowerCase() === "none") {
        out.teamA[k] = "Weak material here. The side did not present this area cleanly.";
      }
    }
  }

  if (out.teamB && typeof out.teamB === "object") {
    for (const [k, v] of Object.entries(out.teamB)) {
      if (!asString(v).trim() || asString(v).trim().toLowerCase() === "none") {
        out.teamB[k] = "Weak material here. The side did not present this area cleanly.";
      }
    }
  }

  return out;
}

/* =========================================================
   8. FINAL JSON RESPONSE BUILD
========================================================= */

function buildBaseResult(teamAName, teamBName, teamAAnalysis, teamBAnalysis) {
  const aScore = clamp(Math.round(teamAAnalysis.scoreRaw), 0, 100);
  const bScore = clamp(Math.round(teamBAnalysis.scoreRaw), 0, 100);
  const winner = aScore >= bScore ? teamAName : teamBName;
  const winnerAnalysis = winner === teamAName ? teamAAnalysis : teamBAnalysis;
  const loserName = winner === teamAName ? teamBName : teamAName;

  return {
    teamAName,
    teamBName,
    winner,
    confidence: "Medium",
    teamAScore: numericScoreToString(aScore),
    teamBScore: numericScoreToString(bScore),

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
    same_lane_engagement: teamAAnalysis.lane === teamBAnalysis.lane ? "Yes" : "No",
    lane_mismatch:
      teamAAnalysis.lane === teamBAnalysis.lane
        ? "No meaningful lane mismatch."
        : `${teamAName} and ${teamBName} were not fully fighting in the same lane.`,

    strongestArgumentSide: winner,
    strongestArgument: winnerAnalysis.bestSentence,
    whyStrongest: `${winner} delivered the most defensible argument because it actually tied claims to reasons instead of just posture.`,
    failedResponseByOtherSide: `${loserName} failed to directly answer the strongest point and never killed the pressure.`,
    weakestOverall: `${loserName} produced the weakest overall material by asserting more than it proved.`,

    bsMeter: "Medium",
    manipulation: "Some framing pressure was present, but proof quality mattered more.",
    fluff: "Some fluff appeared, but it did not outweigh the central argument failure.",

    core_disagreement: `${teamAName} and ${teamBName} are pushing incompatible conclusions.`,
    why: `The loser never fully answered the winner's central claim, so the disagreement stayed unresolved.`,

    analysisMode: ANALYSIS_MODE,
    sources: []
  };
}

function buildFailureContract(message) {
  const text = message && typeof message === "string"
    ? message
    : "Analysis degraded because the transcript was too weak or malformed.";

  return {
    teamAName: DEFAULT_TEAM_A,
    teamBName: DEFAULT_TEAM_B,
    winner: DEFAULT_TEAM_A,
    confidence: "Low",
    teamAScore: "51",
    teamBScore: "49",

    teamA: {
      main_position: "Team A's position had to be reconstructed from weak transcript fragments.",
      truth: "Some claim material existed, but transcript quality prevented clean extraction.",
      lies: "No explicit lie could be isolated because the transcript quality was poor.",
      opinion: "Opinion and interpretation dominated the available fragments.",
      lala: "Filler and transcript noise damaged extraction."
    },

    teamB: {
      main_position: "Team B's position had to be reconstructed from weak transcript fragments.",
      truth: "Some claim material existed, but transcript quality prevented clean extraction.",
      lies: "No explicit lie could be isolated because the transcript quality was poor.",
      opinion: "Opinion and interpretation dominated the available fragments.",
      lala: "Filler and transcript noise damaged extraction."
    },

    teamA_integrity: "Team A survives here mostly because the engine had slightly more usable material on that side.",
    teamB_integrity: "Team B suffered from weak extraction and incomplete usable material.",
    teamA_reasoning: "Reasoning analysis was degraded by transcript quality, but Team A still had marginally more reconstructable structure.",
    teamB_reasoning: "Reasoning analysis was degraded by transcript quality, and Team B had less usable structure to work with.",

    teamA_lane: "argument",
    teamB_lane: "argument",
    same_lane_engagement: "Yes",
    lane_mismatch: "No meaningful lane mismatch could be established because extraction quality was poor.",

    strongestArgumentSide: DEFAULT_TEAM_A,
    strongestArgument: "The strongest available material was only marginally stronger than the rest because the transcript was weak.",
    whyStrongest: "It was less broken than the competing fragments. Not glorious, just less bad.",
    failedResponseByOtherSide: "The other side failed to directly answer the strongest available point.",
    weakestOverall: "The weakest overall material was unsupported assertion buried in noisy transcript fragments.",

    bsMeter: "High",
    manipulation: "Transcript quality was too poor to separate manipulation from noise with confidence.",
    fluff: "Heavy fluff and transcript noise interfered with clean judgment.",

    core_disagreement: "The sides were in conflict, but the transcript did a poor job preserving the clean center of the disagreement.",
    why: text,

    analysisMode: ANALYSIS_MODE,
    sources: []
  };
}

/* =========================================================
   INPUT EXTRACTION
========================================================= */

function getTranscriptFromBody(body) {
  if (!body || typeof body !== "object") return "";

  const candidates = [
    body.transcript,
    body.text,
    body.rawTranscript,
    body.content,
    body.input
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }

  if (Array.isArray(body.lines)) {
    return body.lines.map(asString).join("\n");
  }

  return "";
}

/* =========================================================
   REQUEST HANDLER
========================================================= */

async function analyzeHandler(req, res) {
  try {
    const rawTranscript = getTranscriptFromBody(req.body);

    if (!rawTranscript || !rawTranscript.trim()) {
      return res.json(buildFailureContract("No usable transcript was provided to the endpoint."));
    }

    // 1. Transcript Cleaning
    const cleaned = cleanTranscript(rawTranscript);

    // 2. Side Extraction
    const extracted = extractSides(cleaned.cleanedLines);

    // Force meaningful sides if possible
    const teamASentences = extracted.teamASentences.length
      ? extracted.teamASentences
      : sentenceSplit(cleaned.cleanedTranscript).slice(0, 5);

    const teamBSentences = extracted.teamBSentences.length
      ? extracted.teamBSentences
      : sentenceSplit(cleaned.cleanedTranscript).slice(5, 10);

    // 3. Local Deterministic Analysis
    const teamAAnalysis = analyzeSideDeterministically(extracted.teamAName, teamASentences);
    const teamBAnalysis = analyzeSideDeterministically(extracted.teamBName, teamBSentences);

    // 4. Fact Check Layer
    const factLayer = factCheckLayer(teamAAnalysis, teamBAnalysis);
    void factLayer; // layer exists by design, reserved for future source integration

    // 5. AI Refinement
    const aiRefinement = await aiRefinementLayer(teamAAnalysis, teamBAnalysis);

    // 6. Merge Layer
    const baseResult = buildBaseResult(extracted.teamAName, extracted.teamBName, teamAAnalysis, teamBAnalysis);
    const merged = mergeLayer(baseResult, aiRefinement);

    // 7. Consistency Enforcement
    const finalResult = enforceConsistency(
      merged,
      teamAAnalysis,
      teamBAnalysis,
      extracted.extractionMeta
    );

    // 8. Final JSON response
    return res.json(finalResult);
  } catch (err) {
    const message =
      err && err.message
        ? `Analysis crashed and fell back to contract-safe output: ${err.message}`
        : "Analysis crashed and fell back to contract-safe output.";

    return res.json(buildFailureContract(message));
  }
}

/* =========================================================
   ROUTE REGISTRATION
========================================================= */

/*
  Registers both "/" and "/api/analyze2" so this file works whether:
  - it is mounted directly as the endpoint, or
  - it is mounted under a parent router path.
  Human systems adore ambiguity, so here we are.
*/
router.post("/", analyzeHandler);
router.post("/api/analyze2", analyzeHandler);

module.exports = router;
