module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    const body = req.body || {};
    const teamAName = str(body.teamAName || "Team A");
    const teamBName = str(body.teamBName || "Team B");
    const transcriptText = getTranscript(body);
    const videoLink = str(body.videoLink || "");

    if (!transcriptText || transcriptText.trim().length < 50) {
      return res.status(200).json(fallback(teamAName, teamBName, "Transcript too short or missing"));
    }

    const cleaned = cleanTranscript(transcriptText);
    const sections = segmentTranscript(cleaned);

    const teamASentences = dedupeSentences([
      ...splitIntoSentences(sections.aOpening),
      ...splitIntoSentences(sections.crossA)
    ]).filter(isUsefulSentence);

    const teamBSentences = dedupeSentences([
      ...splitIntoSentences(sections.bOpening),
      ...splitIntoSentences(sections.crossB)
    ]).filter(isUsefulSentence);

    if (!teamASentences.length || !teamBSentences.length) {
      return res.status(200).json(fallback(teamAName, teamBName, "Could not isolate usable arguments for both sides"));
    }

    const scoredA = scorePool(teamASentences, "A");
    const scoredB = scorePool(teamBSentences, "B");

    const teamA = buildSideBlock(scoredA);
    const teamB = buildSideBlock(scoredB);

    const teamA_lane = detectLane(scoredA);
    const teamB_lane = detectLane(scoredB);

    const verdict = buildVerdict(scoredA, scoredB, teamAName, teamBName, teamA, teamB, teamA_lane, teamB_lane);
    const sources = buildSources(scoredA, scoredB, videoLink);

    return res.status(200).json({
      teamAName,
      teamBName,
      winner: verdict.winner,
      confidence: verdict.confidence,
      teamAScore: verdict.teamAScore,
      teamBScore: verdict.teamBScore,

      teamA,
      teamB,

      teamA_integrity: verdict.teamA_integrity,
      teamB_integrity: verdict.teamB_integrity,
      teamA_reasoning: verdict.teamA_reasoning,
      teamB_reasoning: verdict.teamB_reasoning,

      teamA_lane,
      teamB_lane,
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

      analysisMode: "deterministic-v3",
      sources,
      error: null
    });
  } catch (err) {
    return res.status(200).json(fallback("Team A", "Team B", err && err.message ? err.message : "Unknown error"));
  }
};

function getTranscript(body) {
  const keys = ["transcriptText", "transcript", "rawTranscript", "text"];
  for (const key of keys) {
    if (typeof body[key] === "string" && body[key].trim()) return body[key];
  }
  return "";
}

function str(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function cleanTranscript(text) {
  let t = String(text || "");

  t = t.replace(/\r/g, "\n");
  t = t.replace(/\b\d{1,2}:\d{2,3}(?:\s*(?:second|seconds))?\b/gi, " ");
  t = t.replace(/\b\d+\s*minute[s]?\s*,?\s*\d+\s*second[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*minute[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*second[s]?\b/gi, " ");
  t = t.replace(/\[(applause|laughter|music|audience|cheering)\]/gi, " ");
  t = t.replace(/\[(.*?)\]/g, " ");
  t = t.replace(/(\d)([A-Za-z])/g, "$1 $2");
  t = t.replace(/([A-Za-z])(\d)/g, "$1 $2");
  t = t.replace(/\b(uh|um|er|ah)\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

function segmentTranscript(text) {
  const lower = text.toLowerCase();

  const aStart = findFirst(lower, [
    "so i have i have 10 minutes for an opening statement",
    "i have 10 minutes for an opening statement",
    "a major hurdle for the origin of life research",
    "mr farina as my guest welcome"
  ]);

  const bStart = findFirst(lower, [
    "mr farino your opening statement please",
    "mr farina your opening statement please",
    "hey everyone thanks to rice university for having us here tonight"
  ]);

  const crossStart = findFirst(lower, [
    "we now turn to dr tour who will ask a question",
    "one of the things that we have to make in order to have life are polypeptides"
  ]);

  const safeAStart = aStart === -1 ? 0 : aStart;
  const safeBStart = bStart === -1 ? Math.floor(text.length * 0.45) : bStart;
  const safeCrossStart = crossStart === -1 ? text.length : crossStart;

  const aOpening = text.slice(safeAStart, safeBStart > safeAStart ? safeBStart : safeCrossStart);
  const bOpening = text.slice(safeBStart, safeCrossStart > safeBStart ? safeCrossStart : text.length);
  const cross = text.slice(safeCrossStart);

  const crossSentences = splitIntoSentences(cross);

  const crossA = [];
  const crossB = [];

  let current = "A";
  for (const s of crossSentences) {
    const x = s.toLowerCase();

    if (
      /mr farina|farina|dave|here's one|we've got|i brought actual papers|you keep going|you're missing a mountain of research/.test(x) &&
      !/dr tour|james/.test(x)
    ) current = "B";

    if (
      /dr tour|james|show me the prebiotic chemistry|i studied every one of your papers|it's not there|these are the ones you've got to do/.test(x) &&
      !/mr farina|dave/.test(x)
    ) current = "A";

    if (current === "A") crossA.push(s);
    else crossB.push(s);
  }

  return { aOpening, bOpening, crossA: crossA.join(". "), crossB: crossB.join(". ") };
}

function findFirst(text, markers) {
  let best = -1;
  for (const m of markers) {
    const idx = text.indexOf(m);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function splitIntoSentences(text) {
  return String(text || "")
    .replace(/([.?!])\s+/g, "$1|||")
    .split("|||")
    .map(str)
    .filter(Boolean);
}

function dedupeSentences(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function isUsefulSentence(s) {
  const x = s.toLowerCase();
  if (s.length < 35) return false;
  if (s.split(/\s+/).length < 7) return false;

  const junk = [
    "good evening everyone",
    "some quick logistics",
    "in case of emergency",
    "please silence your cell phones",
    "thank you very much",
    "please join me in welcoming",
    "let's welcome the two debaters",
    "describe the ground rules",
    "question and answer session",
    "thanks to rice university for having us here tonight"
  ];

  for (const j of junk) {
    if (x.includes(j)) return false;
  }

  return true;
}

function scorePool(sentences, side) {
  return sentences
    .map(text => {
      const f = features(text);
      return { side, text, features: f, score: computeScore(f) };
    })
    .sort((a, b) => b.score - a.score);
}

function features(text) {
  const x = text.toLowerCase();

  const evidence = count(x, [
    "data", "study", "paper", "journal", "experiment", "evidence", "demonstrates",
    "shows", "nmr", "spectrum", "chemistry", "prebiotic", "rna", "peptide",
    "nucleotide", "yield", "basaltic", "coupling", "polypeptide"
  ]);

  const reasoning = count(x, [
    "because", "therefore", "hence", "since", "if", "then", "which means",
    "as a result", "in order to"
  ]);

  const attack = count(x, [
    "liar", "lies", "fraud", "fraudulence", "charlatan", "delusional",
    "idiotic", "toxic", "clueless", "embarrassing"
  ]);

  const fluff = count(x, [
    "thank you", "glad to be here", "pleasure to be here", "enjoy it", "audience"
  ]);

  const opinion = count(x, [
    "i think", "i believe", "i maintain", "i presume", "i hope"
  ]);

  const claim =
    /(is|are|means|shows|demonstrates|requires|fails|cannot|can not|won't|does not|did not|we have|there is|there are)/i.test(text);

  const question =
    /\?$/.test(text) || /^(show me|are you|do you|what is|where is|how)/i.test(x);

  return { evidence, reasoning, attack, fluff, opinion, claim, question, words: text.split(/\s+/).length };
}

function computeScore(f) {
  let score = 0;

  if (f.claim) score += 4;
  score += Math.min(6, f.evidence);
  score += Math.min(4, f.reasoning * 1.5);

  if (f.words >= 12) score += 2;
  if (f.words >= 18 && f.words <= 40) score += 2;

  score -= Math.min(3, f.opinion);
  score -= Math.min(4, f.fluff * 2);

  const attackOnly = f.attack > 0 && f.evidence === 0 && f.reasoning === 0;
  if (attackOnly) score -= 8;
  else score -= Math.min(3, f.attack);

  if (f.question && f.evidence === 0 && f.reasoning === 0) score -= 3;
  if (f.words < 8) score -= 4;

  return Math.round(score * 10) / 10;
}

function count(text, phrases) {
  let n = 0;
  for (const p of phrases) {
    const m = text.match(new RegExp("\\b" + esc(p) + "\\b", "gi"));
    if (m) n += m.length;
  }
  return n;
}

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSideBlock(scored) {
  return {
    main_position: pick(scored, row =>
      row.features.claim &&
      (row.features.evidence > 0 || row.features.reasoning > 0) &&
      row.features.attack === 0
    ),
    truth: pick(scored, row =>
      row.features.evidence > 0 &&
      row.features.claim &&
      row.features.attack === 0
    ),
    lies: pickLow(scored, row =>
      row.features.attack > 0 ||
      (row.features.claim && row.features.evidence === 0 && row.features.reasoning === 0)
    ),
    opinion: pick(scored, row =>
      row.features.opinion > 0 ||
      (row.features.claim && row.features.evidence === 0 && row.features.reasoning === 0)
    ),
    lala: pickLow(scored, row =>
      row.features.fluff > 0 ||
      (row.features.attack > 0 && row.features.evidence === 0 && row.features.reasoning === 0)
    )
  };
}

function pick(scored, test) {
  const found = scored.find(test);
  return found ? found.text : (scored[0] ? scored[0].text : "");
}

function pickLow(scored, test) {
  const found = [...scored].filter(test).sort((a, b) => a.score - b.score)[0];
  return found ? found.text : ([...scored].sort((a, b) => a.score - b.score)[0]?.text || "");
}

function detectLane(scored) {
  const text = scored.map(x => x.text.toLowerCase()).join(" ");

  const science = count(text, [
    "data", "study", "paper", "experiment", "chemistry", "prebiotic", "rna",
    "nmr", "spectrum", "yield", "peptide", "nucleotide", "cell"
  ]);

  const history = count(text, [
    "historical", "history", "record", "community", "trend"
  ]);

  const theology = count(text, [
    "god", "bible", "jesus", "faith", "religious", "creationist", "scripture"
  ]);

  const top = Math.max(science, history, theology);
  if (top === 0) return "mixed / unclear lane";

  const arr = [
    { name: "science / evidence lane", score: science },
    { name: "history / evidence lane", score: history },
    { name: "theology / scripture lane", score: theology }
  ].sort((a, b) => b.score - a.score);

  if (arr[1].score > 0 && arr[1].score / arr[0].score > 0.55) {
    return "mixed lane with overlapping frameworks";
  }

  return arr[0].name;
}

function buildVerdict(scoredA, scoredB, teamAName, teamBName, teamA, teamB, laneA, laneB) {
  const a = summarize(scoredA);
  const b = summarize(scoredB);

  const teamAScore = clamp(Math.round(
    50 +
    (a.topAvg - b.topAvg) * 2.4 +
    (a.evidence - b.evidence) * 2.0 +
    (a.reasoning - b.reasoning) * 1.8 -
    (a.attack - b.attack) * 1.8 -
    (a.fluff - b.fluff) * 1.2
  ), 1, 99);

  const teamBScore = clamp(100 - teamAScore, 1, 99);
  const diff = Math.abs(teamAScore - teamBScore);

  const winner = diff === 0 ? "Tie" : (teamAScore > teamBScore ? teamAName : teamBName);
  const confidence = diff >= 25 ? "high" : diff >= 12 ? "medium" : "low";

  const strongestA = strongest(scoredA);
  const strongestB = strongest(scoredB);
  const strongestPick = !strongestB || (strongestA && strongestA.score >= strongestB.score)
    ? { side: teamAName, row: strongestA }
    : { side: teamBName, row: strongestB };

  const weakest = [...scoredA, ...scoredB].sort((x, y) => x.score - y.score)[0];

  return {
    winner,
    confidence,
    teamAScore,
    teamBScore,

    teamA_integrity: integrityText(a),
    teamB_integrity: integrityText(b),
    teamA_reasoning: reasoningText(a),
    teamB_reasoning: reasoningText(b),

    same_lane_engagement: sameLane(laneA, laneB),
    lane_mismatch: !sameLane(laneA, laneB),

    strongestArgumentSide: strongestPick.side,
    strongestArgument: strongestPick.row ? strongestPick.row.text : "",
    whyStrongest: strongestPick.row
      ? "It contains an actual claim with supporting scientific language instead of mostly posture or insult."
      : "",
    failedResponseByOtherSide: strongestPick.side === teamAName
      ? `${teamBName} never matched that point with equally specific support.`
      : `${teamAName} never matched that point with equally specific support.`,
    weakestOverall: weakest ? weakest.text : "",

    bsMeter: bsMeter(a, b),
    manipulation: manipulationText(a, b),
    fluff: fluffText(a, b),

    core_disagreement: `One side says current origin-of-life work still does not provide an experimentally valid path to life; the other says there are already multiple viable prebiotic pathways and that the criticism is distorted.`,
    why: overallWhy(winner, diff, a, b, laneA, laneB, teamAName, teamBName)
  };
}

function summarize(scored) {
  const top = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.15)));
  const avg = arr => arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0;

  return {
    topAvg: round(avg(top.map(x => x.score))),
    evidence: round(avg(top.map(x => x.features.evidence))),
    reasoning: round(avg(top.map(x => x.features.reasoning))),
    attack: round(avg(scored.map(x => x.features.attack))),
    fluff: round(avg(scored.map(x => x.features.fluff)))
  };
}

function strongest(scored) {
  const top = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.1)));
  return top.find(x =>
    x.features.claim &&
    (x.features.evidence > 0 || x.features.reasoning > 0) &&
    !(x.features.attack > 0 && x.features.evidence === 0 && x.features.reasoning === 0)
  ) || top[0] || null;
}

function integrityText(s) {
  if (s.attack > 0.9 && s.evidence < 0.8) return "Too attack-heavy. The case leans more on accusation than support.";
  if (s.topAvg >= 7 && s.evidence >= 1.2) return "Mostly grounded. The side puts forward support-bearing claims.";
  if (s.reasoning >= 0.8) return "Moderately grounded, but uneven.";
  return "Mixed integrity. There are claims here, but support is thin or inconsistent.";
}

function reasoningText(s) {
  if (s.reasoning >= 1.5 && s.evidence >= 1.2) return "Reasoning is strong and tied to scientific support.";
  if (s.reasoning >= 0.8) return "Reasoning is present but uneven.";
  return "Reasoning is thin. Conclusions are stated more than built.";
}

function bsMeter(a, b) {
  const attack = a.attack + b.attack;
  const fluff = a.fluff + b.fluff;
  if (attack > 2.2 || fluff > 1.4) return "high";
  if (attack > 1.1 || fluff > 0.7) return "medium";
  return "low";
}

function manipulationText(a, b) {
  if (a.attack < 0.4 && b.attack < 0.4) return "Low manipulation pressure. Most of the exchange stays on claims.";
  if (Math.abs(a.attack - b.attack) < 0.35) return "Both sides use rhetorical pressure, but neither dominates only through it.";
  return a.attack > b.attack
    ? "Team A leans harder on rhetorical pressure and personal framing."
    : "Team B leans harder on rhetorical pressure and personal framing.";
}

function fluffText(a, b) {
  const total = a.fluff + b.fluff;
  if (total < 0.5) return "Low fluff.";
  if (total < 1.4) return "Moderate fluff.";
  return "High fluff.";
}

function overallWhy(winner, diff, a, b, laneA, laneB, teamAName, teamBName) {
  if (winner === "Tie") {
    return "Neither side separated clearly enough on evidence-weighted structure.";
  }

  const same = sameLane(laneA, laneB)
    ? "Both sides are at least mostly arguing in the same lane."
    : "The sides drift between different frameworks, which hurts direct engagement.";

  if (winner === teamAName) {
    return `${teamAName} wins by cleaner claim structure, less rhetorical drag, and better support-weighted sentences. ${same} Margin: ${diff}.`;
  }

  return `${teamBName} wins by cleaner claim structure, less rhetorical drag, and better support-weighted sentences. ${same} Margin: ${diff}.`;
}

function sameLane(a, b) {
  if (a === b) return true;
  if (a.includes("mixed") && b.includes("science")) return true;
  if (b.includes("mixed") && a.includes("science")) return true;
  return false;
}

function buildSources(scoredA, scoredB, videoLink) {
  return [...scoredA, ...scoredB]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(row => {
      let status = "needs-review";
      let note = "Transcript-only claim worth later verification.";

      if (row.features.evidence > 0 && row.features.reasoning > 0) {
        status = "supported-language";
        note = "Contains both claim and support language.";
      } else if (row.features.attack > 0 && row.features.evidence === 0) {
        status = "flagged-overreach";
        note = "Leans on accusation more than support.";
      }

      return {
        claim: row.text,
        status,
        note,
        source: videoLink ? "transcript / debate video reference" : "transcript"
      };
    });
}

function fallback(teamAName, teamBName, error) {
  return {
    teamAName,
    teamBName,
    winner: "",
    confidence: "low",
    teamAScore: 50,
    teamBScore: 50,

    teamA: { main_position: "", truth: "", lies: "", opinion: "", lala: "" },
    teamB: { main_position: "", truth: "", lies: "", opinion: "", lala: "" },

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
    error: str(error || "Unknown error")
  };
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
