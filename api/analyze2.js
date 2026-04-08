module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    const body = req.body || {};
    const teamAName = cleanWhitespace(body.teamAName || "Team A");
    const teamBName = cleanWhitespace(body.teamBName || "Team B");
    const transcriptText = getTranscriptFromBody(body);
    const videoLink = cleanWhitespace(body.videoLink || "");

    if (!transcriptText || transcriptText.trim().length < 40) {
      return res.status(200).json(buildFallback(teamAName, teamBName, "Transcript too short or missing"));
    }

    const cleanedTranscript = cleanTranscript(transcriptText);
    const debateOnlyTranscript = trimToDebateCore(cleanedTranscript);
    const rawSentences = splitSentences(debateOnlyTranscript);
    const filteredSentences = rawSentences.filter(isUsableSentence);

    if (!filteredSentences.length) {
      return res.status(200).json(buildFallback(teamAName, teamBName, "No usable debate sentences found"));
    }

    const sideSplit = splitDebateSides(filteredSentences, teamAName, teamBName);
    const teamAScored = scoreSentencePool(sideSplit.teamA, "A");
    const teamBScored = scoreSentencePool(sideSplit.teamB, "B");

    const teamAData = buildTeamBlock(teamAScored);
    const teamBData = buildTeamBlock(teamBScored);

    const laneA = detectLane(teamAScored);
    const laneB = detectLane(teamBScored);

    const verdict = buildVerdict({
      teamAName,
      teamBName,
      teamAScored,
      teamBScored,
      teamAData,
      teamBData,
      laneA,
      laneB
    });

    const sources = buildSources(teamAScored, teamBScored, videoLink);

    return res.status(200).json({
      teamAName,
      teamBName,
      winner: verdict.winner,
      confidence: verdict.confidence,
      teamAScore: verdict.teamAScore,
      teamBScore: verdict.teamBScore,

      teamA: {
        main_position: teamAData.main_position,
        truth: teamAData.truth,
        lies: teamAData.lies,
        opinion: teamAData.opinion,
        lala: teamAData.lala
      },

      teamB: {
        main_position: teamBData.main_position,
        truth: teamBData.truth,
        lies: teamBData.lies,
        opinion: teamBData.opinion,
        lala: teamBData.lala
      },

      teamA_integrity: verdict.teamA_integrity,
      teamB_integrity: verdict.teamB_integrity,
      teamA_reasoning: verdict.teamA_reasoning,
      teamB_reasoning: verdict.teamB_reasoning,

      teamA_lane: laneA,
      teamB_lane: laneB,
      same_lane_engagement: verdict.same_lane_engagement,
      lane_mismatch: verdict.lane_mismatch,

      strongestArgumentSide: verdict.strongestArgumentSide,
      strongestArgument: verdict.strongestArgument,
      whyStrongest: verdict.whyStrongest,
      failedResponseByOtherSide: verdict.failedResponseByOtherSide,
      weakestOverall: verdict.weakestOverall,

      bsMeter: verdict.bsMeter,
      manipulation: verdict.manipulation,
      fluff: verdict.fluff,

      core_disagreement: verdict.core_disagreement,
      why: verdict.why,

      analysisMode: "deterministic-v2.5",
      sources,
      error: null
    });
  } catch (err) {
    return res.status(200).json(buildFallback("Team A", "Team B", err && err.message ? err.message : "Unknown backend error"));
  }
};

/* ----------------------------- INPUT HELPERS ----------------------------- */

function getTranscriptFromBody(body) {
  const candidates = [
    body.transcriptText,
    body.transcript,
    body.rawTranscript,
    body.text
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function cleanWhitespace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

/* ---------------------------- TRANSCRIPT CLEAN --------------------------- */

function cleanTranscript(text) {
  let t = String(text || "");

  // Normalize line breaks
  t = t.replace(/\r/g, "\n");

  // Remove timestamp patterns like:
  // 0:011 second, 1:05, 1 minute 5 seconds, 10:04 etc.
  t = t.replace(/\b\d{1,2}:\d{2,3}(?:\s*(?:second|seconds))?\b/gi, " ");
  t = t.replace(/\b\d+\s*minute[s]?\s*,?\s*\d+\s*second[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*minute[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*second[s]?\b/gi, " ");

  // Remove bracketed tags
  t = t.replace(/\[(applause|laughter|music|cheering|audience)\]/gi, " ");
  t = t.replace(/\[(.*?)\]/g, " ");

  // Un-glue smashed timestamp remnants from text
  t = t.replace(/(\d)([A-Za-z])/g, "$1 $2");
  t = t.replace(/([A-Za-z])(\d)/g, "$1 $2");

  // Remove repetitive transcript noise
  t = t.replace(/\buh\b/gi, " ");
  t = t.replace(/\bum\b/gi, " ");
  t = t.replace(/\ber\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

function trimToDebateCore(text) {
  const lower = text.toLowerCase();

  // Try to jump to the actual opening statement area.
  const startMarkers = [
    "opening statement",
    "i have 10 minutes for an opening statement",
    "a major hurdle for the origin of life research",
    "thank you before we get started",
    "mr farina your opening statement please",
    "straightener hey everyone thanks"
  ];

  let bestStart = -1;
  for (const marker of startMarkers) {
    const idx = lower.indexOf(marker);
    if (idx !== -1 && (bestStart === -1 || idx < bestStart)) {
      bestStart = idx;
    }
  }

  if (bestStart !== -1) {
    return text.slice(bestStart).trim();
  }

  // Fallback: strip hard logistics phrases if no better start exists
  const hardIntroMarkers = [
    "good evening everyone and welcome",
    "some quick logistics before we get started",
    "in case of emergency",
    "please silence your cell phones",
    "the moderator for tonight's debate",
    "describe the ground rules"
  ];

  let trimmed = text;
  for (const marker of hardIntroMarkers) {
    const idx = trimmed.toLowerCase().indexOf(marker);
    if (idx !== -1 && idx < 1200) {
      trimmed = trimmed.slice(idx + marker.length);
    }
  }

  return trimmed.trim();
}

/* --------------------------- SENTENCE HANDLING --------------------------- */

function splitSentences(text) {
  if (!text) return [];

  const rough = text
    .replace(/([.?!])\s+/g, "$1|||")
    .replace(/\b(Mr|Dr|Prof|Professor)\.\s+/g, "$1 ")
    .split("|||")
    .map(s => cleanWhitespace(s));

  return rough.filter(Boolean);
}

function isUsableSentence(s) {
  if (!s) return false;

  const text = cleanWhitespace(s);
  if (text.length < 28) return false;
  if (wordCount(text) < 6) return false;

  const lower = text.toLowerCase();

  const hardRejectPatterns = [
    /please join me in welcoming/,
    /thank you very much/,
    /thanks to rice university/,
    /there are three exits/,
    /silence your cell phones/,
    /restroom/,
    /live stream/,
    /photography/,
    /videography/,
    /ground rules/,
    /question and answer session/,
    /let's welcome the two debaters/,
    /give me a moment/,
    /neutral corners/,
    /weighing in/,
    /it'?s a real pleasure to be here/
  ];

  for (const pat of hardRejectPatterns) {
    if (pat.test(lower)) return false;
  }

  // Reject mostly broken fragments
  if (!/[a-z]/i.test(text)) return false;
  if (/[,:;]$/.test(text)) return false;

  return true;
}

function wordCount(s) {
  return cleanWhitespace(s).split(/\s+/).filter(Boolean).length;
}

/* ----------------------------- SIDE SEGMENTING ---------------------------- */

function splitDebateSides(sentences, teamAName, teamBName) {
  // Strategy:
  // 1. Detect opening marker for B if possible
  // 2. Detect speaker labels / phrase markers
  // 3. Fallback to weighted half split

  const joined = sentences.join(" ||| ");
  const lowerJoined = joined.toLowerCase();

  const bStartMarkers = [
    "mr farina your opening statement please",
    "your opening statement please straightener",
    "your opening statement please",
    "hey everyone thanks to rice university for having us here tonight"
  ];

  let bMarkerIndexInJoined = -1;
  for (const marker of bStartMarkers) {
    const idx = lowerJoined.indexOf(marker);
    if (idx !== -1) {
      bMarkerIndexInJoined = idx;
      break;
    }
  }

  if (bMarkerIndexInJoined !== -1) {
    const rebuilt = [];
    let rolling = 0;
    for (let i = 0; i < sentences.length; i++) {
      const piece = sentences[i] + " ||| ";
      rebuilt.push({ index: i, start: rolling, text: sentences[i] });
      rolling += piece.length;
    }

    let cutIndex = Math.floor(sentences.length / 2);
    for (const row of rebuilt) {
      if (row.start >= bMarkerIndexInJoined) {
        cutIndex = row.index;
        break;
      }
    }

    const teamA = sentences.slice(0, Math.max(1, cutIndex));
    const teamB = sentences.slice(Math.max(1, cutIndex));

    return rebalanceSides(teamA, teamB, sentences);
  }

  // Speaker cue based segmentation
  let currentSide = "A";
  const teamA = [];
  const teamB = [];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    if (
      /mr farina|dave farina|professor dave|farina says|farina opening statement/.test(lower) &&
      !/dr tour|james tour/.test(lower)
    ) {
      currentSide = "B";
    } else if (
      /dr tour|james tour|doctor tour|tour says/.test(lower) &&
      !/mr farina|dave farina/.test(lower)
    ) {
      currentSide = "A";
    }

    if (currentSide === "A") teamA.push(sentence);
    else teamB.push(sentence);
  }

  if (teamA.length > 8 && teamB.length > 8) {
    return rebalanceSides(teamA, teamB, sentences);
  }

  // Fallback weighted split
  const cut = Math.floor(sentences.length * 0.42);
  return rebalanceSides(sentences.slice(0, cut), sentences.slice(cut), sentences);
}

function rebalanceSides(teamA, teamB, allSentences) {
  if (!teamA.length || !teamB.length) {
    const mid = Math.floor(allSentences.length / 2);
    return {
      teamA: allSentences.slice(0, mid),
      teamB: allSentences.slice(mid)
    };
  }

  // Avoid ridiculous imbalance from marker weirdness
  const total = allSentences.length;
  const minReasonable = Math.max(8, Math.floor(total * 0.2));

  if (teamA.length < minReasonable || teamB.length < minReasonable) {
    const mid = Math.floor(total / 2);
    return {
      teamA: allSentences.slice(0, mid),
      teamB: allSentences.slice(mid)
    };
  }

  return { teamA, teamB };
}

/* ------------------------------ SCORING CORE ----------------------------- */

function scoreSentencePool(sentences, sideLabel) {
  const seen = new Set();
  const scored = [];

  for (const raw of sentences) {
    const text = cleanWhitespace(raw);
    const dedupeKey = text.toLowerCase();

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const features = analyzeSentenceFeatures(text);
    const score = computeSentenceScore(features);

    scored.push({
      side: sideLabel,
      text,
      score,
      features
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function analyzeSentenceFeatures(text) {
  const lower = text.toLowerCase();

  const evidenceWords = countMatches(lower, [
    "data", "evidence", "study", "paper", "journal", "experiment", "experimental",
    "demonstrate", "demonstrates", "shows", "show", "record", "records",
    "historical", "chemistry", "molecular", "nmr", "rna", "peptide", "cell",
    "nucleotide", "prebiotic", "spectrum", "catalysis", "yield"
  ]);

  const reasoningWords = countMatches(lower, [
    "because", "therefore", "thus", "hence", "since", "which means",
    "that means", "in order to", "if", "then", "so that", "as a result"
  ]);

  const opinionWords = countMatches(lower, [
    "i think", "i believe", "i presume", "i maintain", "in my opinion", "i hope"
  ]);

  const attackWords = countMatches(lower, [
    "liar", "lies", "fraud", "fraudulence", "charlatan", "delusional",
    "clueless", "idiotic", "embarrassing", "toxic", "pathological"
  ]);

  const fluffWords = countMatches(lower, [
    "thank you", "welcome", "glad to be here", "pleasure to be here",
    "enjoy it", "audience", "tonight we are here", "thanks very much"
  ]);

  const hasQuestion = /\?$/.test(text) || /^(show me|are you|do you|can you|what is|where is|how about)/i.test(text);
  const hasClaimVerb = /(is|are|means|shows|demonstrates|proves|indicates|suggests|requires|fails|works|does not|cannot|can’t|won’t|never)/i.test(text);
  const hasContrast = /\bbut\b|\bhowever\b|\balthough\b|\byet\b/i.test(text);
  const lengthWords = wordCount(text);

  const moderatorish = /opening statement please|we now turn to|ask a question|thank you very much|please join me|welcome to/i.test(lower);

  const technicalDensity = countMatches(lower, [
    "abiogenesis", "origin of life", "prebiotic", "polypeptide", "polynucleotide",
    "polysaccharide", "autocatalytic", "chirality", "nucleotides", "ribose",
    "basaltic", "hydrogen peroxide", "ultra pure water", "commercial aircraft"
  ]);

  return {
    evidenceWords,
    reasoningWords,
    opinionWords,
    attackWords,
    fluffWords,
    hasQuestion,
    hasClaimVerb,
    hasContrast,
    lengthWords,
    moderatorish,
    technicalDensity
  };
}

function computeSentenceScore(f) {
  let score = 0;

  if (f.hasClaimVerb) score += 4;
  if (f.evidenceWords > 0) score += Math.min(5, f.evidenceWords);
  if (f.reasoningWords > 0) score += Math.min(4, f.reasoningWords * 1.5);
  if (f.technicalDensity > 0) score += Math.min(4, f.technicalDensity);

  if (f.lengthWords >= 12) score += 2;
  if (f.lengthWords >= 20 && f.lengthWords <= 45) score += 2;
  if (f.hasContrast) score += 1;

  if (f.opinionWords > 0) score -= Math.min(2, f.opinionWords);
  if (f.fluffWords > 0) score -= Math.min(4, f.fluffWords * 2);
  if (f.moderatorish) score -= 8;

  const attackOnly = f.attackWords > 0 && f.evidenceWords === 0 && f.reasoningWords === 0 && f.technicalDensity === 0;
  if (attackOnly) score -= 7;
  else if (f.attackWords > 0) score -= Math.min(3, f.attackWords);

  if (f.hasQuestion && !f.hasClaimVerb && f.evidenceWords === 0) score -= 3;
  if (f.lengthWords < 8) score -= 4;
  if (f.lengthWords > 60) score -= 1;

  return Math.round(score * 10) / 10;
}

function countMatches(text, phrases) {
  let count = 0;
  for (const phrase of phrases) {
    const escaped = escapeRegExp(phrase);
    const matches = text.match(new RegExp(`\\b${escaped}\\b`, "gi"));
    if (matches) count += matches.length;
  }
  return count;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------------------------- TEAM BLOCK BUILD --------------------------- */

function buildTeamBlock(scored) {
  const main_position = selectBest(scored, row =>
    row.features.hasClaimVerb &&
    (row.features.reasoningWords > 0 || row.features.evidenceWords > 0) &&
    row.features.attackWords < 2
  );

  const truth = selectBest(scored, row =>
    row.features.evidenceWords > 0 &&
    row.features.hasClaimVerb &&
    row.features.attackWords === 0
  );

  const lies = selectBest(scored, row =>
    row.features.attackWords > 0 ||
    (row.features.hasClaimVerb && row.features.evidenceWords === 0 && row.features.reasoningWords === 0 && row.score < 2)
  , true);

  const opinion = selectBest(scored, row =>
    row.features.opinionWords > 0 ||
    (row.features.hasClaimVerb && row.features.evidenceWords === 0 && row.features.reasoningWords === 0)
  );

  const lala = selectBest(scored, row =>
    row.features.fluffWords > 0 ||
    (row.features.attackWords > 0 && row.features.evidenceWords === 0 && row.features.reasoningWords === 0)
  , true);

  return {
    main_position: main_position || fallbackText(scored, 0),
    truth: truth || fallbackText(scored, 1),
    lies: lies || fallbackWeak(scored),
    opinion: opinion || fallbackOpinion(scored),
    lala: lala || fallbackFluff(scored)
  };
}

function selectBest(scored, predicate, preferLower = false) {
  const filtered = scored.filter(predicate);
  if (!filtered.length) return "";

  const ordered = preferLower
    ? [...filtered].sort((a, b) => a.score - b.score)
    : [...filtered].sort((a, b) => b.score - a.score);

  return ordered[0] ? ordered[0].text : "";
}

function fallbackText(scored, index) {
  return scored[index] ? scored[index].text : "";
}

function fallbackWeak(scored) {
  const ordered = [...scored].sort((a, b) => a.score - b.score);
  return ordered[0] ? ordered[0].text : "";
}

function fallbackOpinion(scored) {
  const found = scored.find(row => row.features.opinionWords > 0 || row.features.attackWords > 0);
  return found ? found.text : (scored[2] ? scored[2].text : "");
}

function fallbackFluff(scored) {
  const found = [...scored].sort((a, b) => a.score - b.score).find(row =>
    row.features.fluffWords > 0 || row.features.attackWords > 0 || row.score <= 0
  );
  return found ? found.text : (scored[scored.length - 1] ? scored[scored.length - 1].text : "");
}

/* ------------------------------- LANE LOGIC ------------------------------ */

function detectLane(scored) {
  const text = scored.map(x => x.text.toLowerCase()).join(" ");

  const scienceScore = countMatches(text, [
    "data", "evidence", "study", "journal", "experiment", "chemistry", "molecular",
    "rna", "nmr", "spectrum", "yield", "prebiotic", "polypeptide", "nucleotide", "cell"
  ]);

  const historyScore = countMatches(text, [
    "history", "historical", "record", "records", "past", "community", "trend"
  ]);

  const theologyScore = countMatches(text, [
    "god", "bible", "jesus", "religious", "scripture", "creationist", "faith", "miracles"
  ]);

  const top = Math.max(scienceScore, historyScore, theologyScore);

  if (top === 0) return "mixed/unclear";

  const buckets = [
    { lane: "science / evidence lane", score: scienceScore },
    { lane: "history / evidence lane", score: historyScore },
    { lane: "theology / scripture lane", score: theologyScore }
  ].sort((a, b) => b.score - a.score);

  if (buckets[0].score > 0 && buckets[1].score > 0 && buckets[1].score / buckets[0].score > 0.55) {
    return "mixed lane with overlapping frameworks";
  }

  return buckets[0].lane;
}

/* ------------------------------ VERDICT LOGIC ---------------------------- */

function buildVerdict(ctx) {
  const aStats = summarizeSide(ctx.teamAScored);
  const bStats = summarizeSide(ctx.teamBScored);

  const teamAScore = clamp(Math.round(
    50 +
    (aStats.truthStrength - bStats.truthStrength) * 2.4 +
    (aStats.reasoningStrength - bStats.reasoningStrength) * 1.8 +
    (aStats.evidenceStrength - bStats.evidenceStrength) * 1.8 -
    (aStats.attackBurden - bStats.attackBurden) * 1.6 -
    (aStats.fluffBurden - bStats.fluffBurden) * 1.2
  ), 1, 99);

  const teamBScore = clamp(100 - teamAScore, 1, 99);

  const winner = teamAScore === teamBScore
    ? "Tie"
    : (teamAScore > teamBScore ? ctx.teamAName : ctx.teamBName);

  const diff = Math.abs(teamAScore - teamBScore);
  const confidence = diff >= 28 ? "high" : diff >= 14 ? "medium" : "low";

  const strongestA = getStrongestArgument(ctx.teamAScored);
  const strongestB = getStrongestArgument(ctx.teamBScored);

  let strongestArgumentSide = ctx.teamAName;
  let strongestArgument = strongestA ? strongestA.text : "";
  let strongestWeight = strongestA ? strongestA.score : -999;

  if (strongestB && strongestB.score > strongestWeight) {
    strongestArgumentSide = ctx.teamBName;
    strongestArgument = strongestB.text;
    strongestWeight = strongestB.score;
  }

  const weakerSideName = strongestArgumentSide === ctx.teamAName ? ctx.teamBName : ctx.teamAName;
  const weakerSideScored = strongestArgumentSide === ctx.teamAName ? ctx.teamBScored : ctx.teamAScored;

  const failedResponseByOtherSide = buildFailedResponse(strongestArgument, weakerSideScored, weakerSideName);
  const weakestOverall = getWeakestOverall(ctx.teamAScored, ctx.teamBScored);

  const teamA_integrity = describeIntegrity(aStats, ctx.teamAData);
  const teamB_integrity = describeIntegrity(bStats, ctx.teamBData);

  const teamA_reasoning = describeReasoning(aStats, ctx.teamAData.main_position);
  const teamB_reasoning = describeReasoning(bStats, ctx.teamBData.main_position);

  const same_lane_engagement = sameLane(ctx.laneA, ctx.laneB);
  const lane_mismatch = !same_lane_engagement;

  const bsMeter = computeBSMeter(aStats, bStats);
  const manipulation = describeManipulation(aStats, bStats);
  const fluff = describeFluff(aStats, bStats);

  const core_disagreement = buildCoreDisagreement(ctx.teamAData.main_position, ctx.teamBData.main_position);
  const why = buildOverallWhy({
    winner,
    teamAName: ctx.teamAName,
    teamBName: ctx.teamBName,
    aStats,
    bStats,
    laneA: ctx.laneA,
    laneB: ctx.laneB,
    diff
  });

  return {
    winner,
    confidence,
    teamAScore,
    teamBScore,
    teamA_integrity,
    teamB_integrity,
    teamA_reasoning,
    teamB_reasoning,
    same_lane_engagement,
    lane_mismatch,
    strongestArgumentSide,
    strongestArgument,
    whyStrongest: strongestArgument
      ? buildWhyStrongest(strongestArgumentSide, strongestArgument)
      : "",
    failedResponseByOtherSide,
    weakestOverall,
    bsMeter,
    manipulation,
    fluff,
    core_disagreement,
    why
  };
}

function summarizeSide(scored) {
  const top = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.2)));
  const avg = arr => arr.length ? arr.reduce((sum, x) => sum + x, 0) / arr.length : 0;

  const truthStrength = avg(top.map(x => x.score));
  const evidenceStrength = avg(top.map(x => x.features.evidenceWords));
  const reasoningStrength = avg(top.map(x => x.features.reasoningWords));
  const attackBurden = avg(scored.map(x => x.features.attackWords));
  const fluffBurden = avg(scored.map(x => x.features.fluffWords));
  const opinionBurden = avg(scored.map(x => x.features.opinionWords));

  return {
    truthStrength: round1(truthStrength),
    evidenceStrength: round1(evidenceStrength),
    reasoningStrength: round1(reasoningStrength),
    attackBurden: round1(attackBurden),
    fluffBurden: round1(fluffBurden),
    opinionBurden: round1(opinionBurden)
  };
}

function getStrongestArgument(scored) {
  const topWindow = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.1)));
  const filtered = topWindow.filter(row =>
    row.features.hasClaimVerb &&
    (row.features.evidenceWords > 0 || row.features.reasoningWords > 0 || row.features.technicalDensity > 0) &&
    !(row.features.attackWords > 0 && row.features.evidenceWords === 0 && row.features.reasoningWords === 0)
  );

  return (filtered[0] || topWindow[0] || null);
}

function getWeakestOverall(a, b) {
  const all = [...a, ...b].sort((x, y) => x.score - y.score);
  return all[0] ? all[0].text : "";
}

function buildFailedResponse(strongestArgument, otherSideScored, otherSideName) {
  if (!strongestArgument) return "";

  const strongTokens = extractKeyTerms(strongestArgument);
  const relevantCounter = otherSideScored.find(row => {
    const rowLower = row.text.toLowerCase();
    let hits = 0;
    for (const token of strongTokens) {
      if (rowLower.includes(token)) hits++;
    }
    return hits >= 2 && row.score > 3;
  });

  if (relevantCounter) {
    return `${otherSideName} addressed part of the claim, but did not neutralize its core force.`;
  }

  return `${otherSideName} never gave a direct, comparably specific answer to that point.`;
}

function extractKeyTerms(text) {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => w.length >= 5)
    .filter(w => !["therefore", "because", "should", "their", "would", "could", "which", "about", "these"].includes(w));

  return [...new Set(tokens)].slice(0, 8);
}

function describeIntegrity(stats, teamData) {
  if (stats.attackBurden > 0.9 && stats.evidenceStrength < 0.8) {
    return "Leans too hard on attack language relative to evidence. The case feels more accusatory than anchored.";
  }
  if (stats.truthStrength >= 7 && stats.evidenceStrength >= 1.2) {
    return "Mostly grounded. The side put forward identifiable claims with enough support language to feel structurally serious.";
  }
  if (stats.reasoningStrength >= 1 && stats.attackBurden < 0.6) {
    return "Moderately grounded. The side makes a recognizable case, though some claims still lean on assertion more than demonstration.";
  }
  return "Mixed integrity. There are usable claims here, but the structure is weakened by overreach, thin support, or wasted motion.";
}

function describeReasoning(stats, mainPosition) {
  if (!mainPosition) return "No stable reasoning chain could be isolated.";
  if (stats.reasoningStrength >= 1.5 && stats.evidenceStrength >= 1.2) {
    return "Reasoning is comparatively strong. This side regularly links claims to data, mechanism, or explicit conditions.";
  }
  if (stats.reasoningStrength >= 0.8) {
    return "Reasoning is present but uneven. There is an argument structure, though not every major claim is adequately supported.";
  }
  return "Reasoning is thin. The side states conclusions more often than it builds them.";
}

function computeBSMeter(aStats, bStats) {
  const combinedAttack = aStats.attackBurden + bStats.attackBurden;
  const combinedFluff = aStats.fluffBurden + bStats.fluffBurden;
  const combinedEvidence = aStats.evidenceStrength + bStats.evidenceStrength;

  if (combinedAttack > 2.2 || (combinedFluff > 1.5 && combinedEvidence < 1.5)) return "high";
  if (combinedAttack > 1.1 || combinedFluff > 0.8) return "medium";
  return "low";
}

function describeManipulation(aStats, bStats) {
  const worse = aStats.attackBurden > bStats.attackBurden ? "Team A" : "Team B";
  const gap = Math.abs(aStats.attackBurden - bStats.attackBurden);

  if (aStats.attackBurden < 0.4 && bStats.attackBurden < 0.4) {
    return "Manipulation pressure is relatively low. Most of the fight is on claims rather than theatrics.";
  }
  if (gap < 0.35) {
    return "Both sides use rhetorical pressure, but neither dominates the debate through manipulation alone.";
  }
  return `${worse} leans more heavily on rhetorical pressure, personal framing, or adversarial packaging instead of staying purely on the evidence.`;
}

function describeFluff(aStats, bStats) {
  const total = aStats.fluffBurden + bStats.fluffBurden;

  if (total < 0.5) return "Low fluff. Most selected material is argument-bearing.";
  if (total < 1.4) return "Moderate fluff. Some motion is wasted on framing and side noise.";
  return "High fluff. Too much airtime is burned on posture, filler, or non-core material.";
}

function buildCoreDisagreement(aMain, bMain) {
  if (!aMain && !bMain) return "The transcript does not preserve a stable core disagreement clearly enough.";

  const a = aMain || "One side argues current origin-of-life research does not yet experimentally establish a valid pathway to life.";
  const b = bMain || "The other side argues origin-of-life research has made real progress and that the criticism is distorted.";

  return `One side argues: ${a} The other side argues: ${b}`;
}

function buildWhyStrongest(sideName, argument) {
  const lower = argument.toLowerCase();
  const hasEvidence = /(data|study|paper|journal|experiment|shows|demonstrates|prebiotic|chemistry|rna|nmr|spectrum)/i.test(lower);
  const hasReasoning = /(because|therefore|hence|since|if|then|which means)/i.test(lower);

  if (hasEvidence && hasReasoning) {
    return `${sideName} lands the strongest point because it combines a claim, a reason, and concrete scientific framing instead of just posture.`;
  }
  if (hasEvidence) {
    return `${sideName} lands the strongest point because it is more anchored in specific evidence language than the surrounding material.`;
  }
  return `${sideName} lands the strongest point because it is clearer and more structurally defensible than the competing claims.`;
}

function buildOverallWhy(ctx) {
  if (ctx.winner === "Tie") {
    return "Neither side separated enough on evidence-weighted structure. The exchange produced usable claims, but no decisive superiority in this transcript slice.";
  }

  const winnerStats = ctx.winner === ctx.teamAName ? ctx.aStats : ctx.bStats;
  const loserStats = ctx.winner === ctx.teamAName ? ctx.bStats : ctx.aStats;

  const reasons = [];

  if (winnerStats.truthStrength > loserStats.truthStrength) {
    reasons.push("stronger claim quality");
  }
  if (winnerStats.evidenceStrength > loserStats.evidenceStrength) {
    reasons.push("better evidence language");
  }
  if (winnerStats.reasoningStrength > loserStats.reasoningStrength) {
    reasons.push("clearer reasoning links");
  }
  if (winnerStats.attackBurden < loserStats.attackBurden) {
    reasons.push("less dependence on attack rhetoric");
  }
  if (winnerStats.fluffBurden < loserStats.fluffBurden) {
    reasons.push("less wasted motion");
  }

  const laneComment = sameLane(ctx.laneA, ctx.laneB)
    ? "Both sides are at least mostly in the same argumentative lane."
    : "The sides also drift between different frameworks, which weakens direct engagement.";

  const reasonText = reasons.length ? reasons.join(", ") : "a narrower but still meaningful structural edge";

  return `${ctx.winner} wins by ${reasonText}. ${laneComment} Margin: ${ctx.diff} points.`;
}

function sameLane(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes("mixed") && b.includes("science")) return true;
  if (b.includes("mixed") && a.includes("science")) return true;
  if (a.includes("mixed lane with overlapping frameworks") && b.includes("mixed lane with overlapping frameworks")) return true;
  return false;
}

/* ------------------------------- SOURCES -------------------------------- */

function buildSources(teamAScored, teamBScored, videoLink) {
  const combined = [...teamAScored, ...teamBScored]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return combined.map(row => {
    let status = "needs-review";
    let note = "Transcript-only claim. Worth checking against cited papers or the video context.";

    if (row.features.evidenceWords > 0 && row.features.reasoningWords > 0) {
      status = "supported-language";
      note = "This line contains claim-plus-support language and is stronger than a bare assertion.";
    } else if (row.features.attackWords > 0 && row.features.evidenceWords === 0) {
      status = "flagged-overreach";
      note = "This line leans on accusation or rhetorical force more than verifiable support.";
    }

    return {
      claim: row.text,
      status,
      note,
      source: videoLink ? "transcript / debate video reference" : "transcript"
    };
  });
}

/* ------------------------------- FALLBACK ------------------------------- */

function buildFallback(teamAName, teamBName, errorMessage) {
  return {
    teamAName,
    teamBName,
    winner: "",
    confidence: "low",
    teamAScore: 50,
    teamBScore: 50,

    teamA: {
      main_position: "",
      truth: "",
      lies: "",
      opinion: "",
      lala: ""
    },

    teamB: {
      main_position: "",
      truth: "",
      lies: "",
      opinion: "",
      lala: ""
    },

    teamA_integrity: "",
    teamB_integrity: "",
    teamA_reasoning: "",
    teamB_reasoning: "",

    teamA_lane: "mixed / unclear lane",
    teamB_lane: "mixed / unclear lane",
    same_lane_engagement: false,
    lane_mismatch: true,

    strongestArgumentSide: "",
    strongestArgument: "",
    whyStrongest: "",
    failedResponseByOtherSide: "",
    weakestOverall: "",

    bsMeter: "medium",
    manipulation: "",
    fluff: "",

    core_disagreement: "",
    why: "",

    analysisMode: "fallback",
    sources: [],
    error: cleanWhitespace(errorMessage || "Unknown error")
  };
}

/* ------------------------------- UTILITIES ------------------------------ */

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
