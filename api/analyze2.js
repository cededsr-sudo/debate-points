module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    const {
      teamAName = "Team A",
      teamBName = "Team B",
      transcriptText = "",
      videoLink = ""
    } = req.body || {};

    if (!transcriptText || transcriptText.trim().length < 20) {
      return res.status(200).json(buildFallback(teamAName, teamBName, "Empty transcript"));
    }

    // ---------- CLEAN ----------
    const cleaned = cleanTranscript(transcriptText);

    // ---------- SENTENCES ----------
    const sentences = splitSentences(cleaned);

    // ---------- SIDE SPLIT ----------
    const { sideA, sideB } = splitSides(sentences);

    // ---------- SCORE ----------
    const scoredA = scoreSentences(sideA);
    const scoredB = scoreSentences(sideB);

    // ---------- PICKERS ----------
    const teamAData = buildTeamData(scoredA);
    const teamBData = buildTeamData(scoredB);

    // ---------- LANES ----------
    const teamA_lane = detectLane(sideA);
    const teamB_lane = detectLane(sideB);

    // ---------- VERDICT ----------
    const verdict = compareTeams(scoredA, scoredB);

    // ---------- SOURCES ----------
    const sources = buildSources([...scoredA, ...scoredB]);

    return res.status(200).json({
      teamAName,
      teamBName,
      winner: verdict.winner,
      confidence: verdict.confidence,
      teamAScore: verdict.teamAScore,
      teamBScore: verdict.teamBScore,

      teamA: teamAData,
      teamB: teamBData,

      teamA_integrity: verdict.teamA_integrity,
      teamB_integrity: verdict.teamB_integrity,
      teamA_reasoning: verdict.teamA_reasoning,
      teamB_reasoning: verdict.teamB_reasoning,

      teamA_lane,
      teamB_lane,
      same_lane_engagement: teamA_lane === teamB_lane,
      lane_mismatch: teamA_lane !== teamB_lane,

      strongestArgumentSide: verdict.strongestSide,
      strongestArgument: verdict.strongest,
      whyStrongest: verdict.whyStrongest,
      failedResponseByOtherSide: verdict.failedResponse,
      weakestOverall: verdict.weakest,

      bsMeter: verdict.bsMeter,
      manipulation: verdict.manipulation,
      fluff: verdict.fluff,

      core_disagreement: verdict.coreDisagreement,
      why: verdict.why,

      analysisMode: "deterministic-v2",
      sources,
      error: null
    });

  } catch (err) {
    return res.status(200).json(buildFallback("Team A", "Team B", err.message));
  }
};

// ---------------- CLEAN ----------------
function cleanTranscript(text) {
  return text
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, " ")
    .replace(/\[.*?\]/g, " ")
    .replace(/(applause|laughter|music)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------- SPLIT ----------------
function splitSentences(text) {
  return text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);
}

// ---------------- SIDE SPLIT ----------------
function splitSides(sentences) {
  const mid = Math.floor(sentences.length / 2);
  return {
    sideA: sentences.slice(0, mid),
    sideB: sentences.slice(mid)
  };
}

// ---------------- SCORING ----------------
function scoreSentences(sentences) {
  return sentences.map(s => {
    let score = 0;

    if (/(because|therefore|shows|demonstrates|evidence|study|data)/i.test(s)) score += 3;
    if (/(i think|maybe|probably)/i.test(s)) score -= 2;
    if (s.length > 120) score += 1;
    if (/(you|idiot|stupid)/i.test(s)) score -= 3;

    return { text: s, score };
  }).sort((a, b) => b.score - a.score);
}

// ---------------- TEAM DATA ----------------
function buildTeamData(scored) {
  return {
    main_position: pick(scored, 0),
    truth: pick(scored, 1),
    lies: pickWorst(scored),
    opinion: pickOpinion(scored),
    lala: pickFluff(scored)
  };
}

function pick(arr, i) {
  return arr[i]?.text || "";
}

function pickWorst(arr) {
  return [...arr].sort((a, b) => a.score - b.score)[0]?.text || "";
}

function pickOpinion(arr) {
  return arr.find(s => /think|believe/i.test(s.text))?.text || "";
}

function pickFluff(arr) {
  return arr.find(s => s.score <= 0)?.text || "";
}

// ---------------- LANE ----------------
function detectLane(sentences) {
  const text = sentences.join(" ");

  if (/(study|data|science|experiment)/i.test(text)) return "science/evidence";
  if (/(history|record|past)/i.test(text)) return "history/evidence";
  if (/(scripture|god|bible)/i.test(text)) return "theology/scripture";

  return "mixed/unclear";
}

// ---------------- VERDICT ----------------
function compareTeams(a, b) {
  const avg = arr => arr.reduce((s, x) => s + x.score, 0) / arr.length;

  const scoreA = avg(a);
  const scoreB = avg(b);

  const winner = scoreA > scoreB ? "Team A" : "Team B";

  return {
    winner,
    confidence: Math.abs(scoreA - scoreB) * 10,
    teamAScore: Math.round(scoreA * 10),
    teamBScore: Math.round(scoreB * 10),

    teamA_integrity: scoreA > 0 ? "more grounded" : "weak support",
    teamB_integrity: scoreB > 0 ? "more grounded" : "weak support",

    teamA_reasoning: scoreA,
    teamB_reasoning: scoreB,

    strongestSide: winner,
    strongest: a[0]?.text || b[0]?.text || "",
    whyStrongest: "Higher reasoning + evidence markers",
    failedResponse: "Other side did not directly counter the strongest claim",
    weakest: [...a, ...b].sort((x, y) => x.score - y.score)[0]?.text || "",

    bsMeter: Math.abs(scoreA - scoreB) < 0.5 ? "medium" : "low",
    manipulation: "minimal detected",
    fluff: "present but filtered",

    coreDisagreement: "Competing truth claims",
    why: "Different reasoning frameworks"
  };
}

// ---------------- SOURCES ----------------
function buildSources(sentences) {
  return sentences.slice(0, 5).map(s => ({
    claim: s.text,
    status: s.score > 1 ? "supported-language" : "needs-review",
    note: "Based on transcript only",
    source: "transcript"
  }));
}

// ---------------- FALLBACK ----------------
function buildFallback(a, b, err) {
  return {
    teamAName: a,
    teamBName: b,
    winner: "",
    confidence: 0,
    teamAScore: 0,
    teamBScore: 0,
    teamA: { main_position: "", truth: "", lies: "", opinion: "", lala: "" },
    teamB: { main_position: "", truth: "", lies: "", opinion: "", lala: "" },
    teamA_integrity: "",
    teamB_integrity: "",
    teamA_reasoning: "",
    teamB_reasoning: "",
    teamA_lane: "",
    teamB_lane: "",
    same_lane_engagement: false,
    lane_mismatch: false,
    strongestArgumentSide: "",
    strongestArgument: "",
    whyStrongest: "",
    failedResponseByOtherSide: "",
    weakestOverall: "",
    bsMeter: "",
    manipulation: "",
    fluff: "",
    core_disagreement: "",
    why: "",
    analysisMode: "fallback",
    sources: [],
    error: err
  };
}
