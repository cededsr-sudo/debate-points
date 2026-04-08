module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    const body = req.body || {};
    const teamAName = clean(body.teamAName || "Team A");
    const teamBName = clean(body.teamBName || "Team B");
    const transcriptText = getTranscript(body);
    const videoLink = clean(body.videoLink || "");

    if (!transcriptText || transcriptText.trim().length < 40) {
      return res.status(200).json(fallback(teamAName, teamBName, "Transcript too short or missing"));
    }

    const cleaned = cleanTranscript(transcriptText);
    const debateText = trimFrontMatter(cleaned);
    const sections = splitSections(debateText);

    const aLines = collectLines(sections.aOpening, sections.crossA);
    const bLines = collectLines(sections.bOpening, sections.crossB);

    if (!aLines.length || !bLines.length) {
      return res.status(200).json(fallback(teamAName, teamBName, "Could not isolate both sides"));
    }

    const scoredA = scorePool(aLines, "A");
    const scoredB = scorePool(bLines, "B");

    const teamA = buildSide(scoredA);
    const teamB = buildSide(scoredB);

    const teamA_lane = detectLane(scoredA);
    const teamB_lane = detectLane(scoredB);

    const verdict = buildVerdict({
      teamAName,
      teamBName,
      scoredA,
      scoredB,
      teamA_lane,
      teamB_lane
    });

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

      analysisMode: "deterministic-bullets-v2",
      sources,
      error: null
    });
  } catch (err) {
    return res.status(200).json(fallback("Team A", "Team B", err && err.message ? err.message : "Unknown backend error"));
  }
};

/* -------------------- INPUT -------------------- */

function getTranscript(body) {
  const keys = ["transcriptText", "transcript", "rawTranscript", "text"];
  for (const key of keys) {
    if (typeof body[key] === "string" && body[key].trim()) return body[key];
  }
  return "";
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/* -------------------- CLEAN -------------------- */

function cleanTranscript(text) {
  let t = String(text || "");

  t = t.replace(/\r/g, "\n");
  t = t.replace(/\b\d{1,3}:\d{2,3}(?::\d{2})?\b/g, " ");
  t = t.replace(/\b\d+\s*hour[s]?\s*,?\s*\d+\s*minute[s]?\s*,?\s*\d+\s*second[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*minute[s]?\s*,?\s*\d+\s*second[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*minute[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*second[s]?\b/gi, " ");
  t = t.replace(/\[(.*?)\]/g, " ");
  t = t.replace(/(\d)([A-Za-z])/g, "$1 $2");
  t = t.replace(/([A-Za-z])(\d)/g, "$1 $2");
  t = t.replace(/\b(uh|um|er|ah)\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

function trimFrontMatter(text) {
  const lower = text.toLowerCase();
  const markers = [
    "i have 10 minutes for an opening statement",
    "a major hurdle for the origin of life research",
    "mr farina as my guest welcome"
  ];

  for (const m of markers) {
    const i = lower.indexOf(m);
    if (i !== -1) return text.slice(i);
  }
  return text;
}

function splitSentences(text) {
  return String(text || "")
    .replace(/([.?!])\s+/g, "$1|||")
    .replace(/;/g, ".|||")
    .split("|||")
    .map(clean)
    .filter(Boolean);
}

function usableSentence(s) {
  if (!s || s.length < 40) return false;
  if (s.split(/\s+/).length < 8) return false;

  const x = s.toLowerCase();
  const banned = [
    "good evening everyone",
    "some quick logistics",
    "in case of emergency",
    "please silence your cell phones",
    "describe the ground rules",
    "please join me in welcoming",
    "let's welcome the two debaters",
    "thank you very much",
    "live stream",
    "restroom",
    "photography",
    "videography",
    "neutral corners",
    "weighing in"
  ];

  return !banned.some(b => x.includes(b));
}

/* -------------------- SPLIT -------------------- */

function splitSections(text) {
  const lower = text.toLowerCase();

  const bStart =
    lower.indexOf("mr farino your opening statement please") !== -1
      ? lower.indexOf("mr farino your opening statement please")
      : lower.indexOf("mr farina your opening statement please");

  const crossStart =
    lower.indexOf("we now turn to dr tour who will ask a question") !== -1
      ? lower.indexOf("we now turn to dr tour who will ask a question")
      : lower.indexOf("one of the things that we have to make in order to have life are polypeptides");

  if (bStart === -1) {
    const mid = Math.floor(text.length / 2);
    return {
      aOpening: text.slice(0, mid),
      bOpening: text.slice(mid),
      crossA: [],
      crossB: []
    };
  }

  const aOpening = text.slice(0, bStart);
  const bOpening = crossStart !== -1 ? text.slice(bStart, crossStart) : text.slice(bStart);
  const cross = crossStart !== -1 ? text.slice(crossStart) : "";

  const crossLines = splitSentences(cross);
  const crossA = [];
  const crossB = [];
  let who = "A";

  for (const line of crossLines) {
    const x = line.toLowerCase();

    if (/show me the prebiotic chemistry|it's not there|i studied every one of your papers|these are the ones you've got to do|i'm asking you to come up and show me the chemistry/.test(x)) {
      who = "A";
    }

    if (/you're missing a mountain of research|here's one|i brought actual papers|we've got research for that|nucleotide polymerization has been demonstrated|there are no papers that show/i.test(x)) {
      who = "B";
    }

    if (who === "A") crossA.push(line);
    else crossB.push(line);
  }

  return { aOpening, bOpening, crossA, crossB };
}

function collectLines(openingText, crossLines) {
  const lines = [
    ...splitSentences(openingText),
    ...(crossLines || [])
  ].filter(usableSentence);

  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/* -------------------- SCORE -------------------- */

function scorePool(lines, side) {
  return lines.map(text => {
    const f = features(text);
    return { side, text, features: f, score: score(f) };
  }).sort((a, b) => b.score - a.score);
}

function features(text) {
  const x = text.toLowerCase();

  return {
    evidence: hits(x, ["data","study","paper","journal","experiment","evidence","shows","demonstrates","prebiotic","chemistry","rna","nmr","spectrum","peptide","polypeptide","nucleotide","yield","coupling","polymerization","research"]),
    reasoning: hits(x, ["because","therefore","hence","since","if","then","which means","as a result","in order to"]),
    attack: hits(x, ["liar","lies","fraud","charlatan","delusional","idiotic","toxic","clueless","embarrassing","ignorance"]),
    fluff: hits(x, ["thank you","glad to be here","pleasure to be here","enjoy it","welcome"]),
    opinion: hits(x, ["i think","i believe","i maintain","i presume","i hope"]),
    science: hits(x, ["data","study","paper","experiment","chemistry","prebiotic","rna","nmr","peptide","nucleotide","cell"]),
    theology: hits(x, ["god","bible","jesus","faith","religious","creationist","scripture"]),
    history: hits(x, ["history","historical","record","records","community","trend"]),
    claim: /(is|are|means|shows|demonstrates|requires|fails|cannot|does not|did not|there is|there are|we have|we do not)/i.test(text),
    words: text.split(/\s+/).length
  };
}

function score(f) {
  let s = 0;
  if (f.claim) s += 4;
  s += Math.min(6, f.evidence);
  s += Math.min(4, f.reasoning * 1.5);
  if (f.words >= 12) s += 2;
  if (f.words >= 18 && f.words <= 44) s += 2;
  s -= Math.min(3, f.opinion);
  s -= Math.min(4, f.fluff * 2);

  const attackOnly = f.attack > 0 && f.evidence === 0 && f.reasoning === 0;
  if (attackOnly) s -= 8;
  else s -= Math.min(3, f.attack);

  return Math.round(s * 10) / 10;
}

function hits(text, words) {
  let n = 0;
  for (const w of words) {
    const m = text.match(new RegExp("\\b" + esc(w) + "\\b", "gi"));
    if (m) n += m.length;
  }
  return n;
}

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------- TEAM BLOCKS -------------------- */

function buildSide(pool) {
  return {
    main_position: bullets(best(pool, x => x.features.claim && (x.features.evidence > 0 || x.features.reasoning > 0) && x.features.attack === 0)),
    truth: bullets(best(pool, x => x.features.evidence > 0 && x.features.claim && x.features.attack === 0)),
    lies: bullets(worst(pool, x => x.features.attack > 0 || (x.features.claim && x.features.evidence === 0 && x.features.reasoning === 0))),
    opinion: bullets(best(pool, x => x.features.opinion > 0 || (x.features.claim && x.features.evidence === 0 && x.features.reasoning === 0))),
    lala: bullets(worst(pool, x => x.features.fluff > 0 || (x.features.attack > 0 && x.features.evidence === 0)))
  };
}

function best(pool, test) {
  const rows = pool.filter(test).slice(0, 3);
  return rows.length ? rows : pool.slice(0, 3);
}

function worst(pool, test) {
  const rows = pool.filter(test).sort((a, b) => a.score - b.score).slice(0, 3);
  return rows.length ? rows : [...pool].sort((a, b) => a.score - b.score).slice(0, 3);
}

function bullets(rows) {
  if (!rows || !rows.length) return "-";
  return rows.slice(0, 3).map(r => "• " + cleanBullet(r.text)).join("\n");
}

function cleanBullet(text) {
  const s = clean(text).replace(/^[-•\s]+/, "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/* -------------------- LANE -------------------- */

function detectLane(pool) {
  const text = pool.map(x => x.text.toLowerCase()).join(" ");
  const science = hits(text, ["data","study","paper","experiment","chemistry","prebiotic","rna","nmr","peptide","nucleotide","cell"]);
  const theology = hits(text, ["god","bible","jesus","faith","religious","creationist","scripture"]);
  const history = hits(text, ["history","historical","record","records","community","trend"]);

  const ranked = [
    { name: "science / evidence lane", score: science },
    { name: "history / evidence lane", score: history },
    { name: "theology / scripture lane", score: theology }
  ].sort((a, b) => b.score - a.score);

  if (ranked[0].score === 0) return "mixed / unclear lane";
  if (ranked[1].score > 0 && ranked[1].score / ranked[0].score > 0.55) return "mixed lane with overlapping frameworks";
  return ranked[0].name;
}

function sameLane(a, b) {
  if (a === b) return true;
  if (a.includes("mixed") && b.includes("science")) return true;
  if (b.includes("mixed") && a.includes("science")) return true;
  return false;
}

/* -------------------- VERDICT -------------------- */

function buildVerdict(ctx) {
  const a = summarize(ctx.scoredA);
  const b = summarize(ctx.scoredB);

  let teamAScore = Math.round(
    50 +
    (a.topAvg - b.topAvg) * 2.4 +
    (a.evidence - b.evidence) * 2.0 +
    (a.reasoning - b.reasoning) * 1.8 -
    (a.attack - b.attack) * 1.8 -
    (a.fluff - b.fluff) * 1.2
  );

  teamAScore = clamp(teamAScore, 1, 99);
  const teamBScore = clamp(100 - teamAScore, 1, 99);

  const diff = Math.abs(teamAScore - teamBScore);
  const winner = diff === 0 ? "Tie" : (teamAScore > teamBScore ? ctx.teamAName : ctx.teamBName);
  const confidence = diff >= 24 ? "high" : diff >= 12 ? "medium" : "low";

  const strongestA = pickStrongestArgument(ctx.scoredA);
  const strongestB = pickStrongestArgument(ctx.scoredB);

  let strongestArgumentSide = ctx.teamAName;
  let strongestArgumentText = strongestA ? strongestA.text : "";
  let strongestScore = strongestA ? strongestA.score : -999;

  if (strongestB && strongestB.score > strongestScore) {
    strongestArgumentSide = ctx.teamBName;
    strongestArgumentText = strongestB.text;
  }

  const otherSide = strongestArgumentSide === ctx.teamAName ? ctx.teamBName : ctx.teamAName;
  const weakest = [...ctx.scoredA, ...ctx.scoredB].sort((x, y) => x.score - y.score)[0];

  return {
    winner,
    confidence,
    teamAScore,
    teamBScore,

    teamA_integrity: integrityText(a),
    teamB_integrity: integrityText(b),
    teamA_reasoning: reasoningText(a),
    teamB_reasoning: reasoningText(b),

    same_lane_engagement: sameLane(ctx.teamA_lane, ctx.teamB_lane),
    lane_mismatch: !sameLane(ctx.teamA_lane, ctx.teamB_lane),

    strongestArgumentSide,
    strongestArgument: strongestArgumentText ? "• " + cleanBullet(strongestArgumentText) : "-",
    whyStrongest: strongestArgumentText ? "• Clear claim\n• Concrete support language\n• Less rhetorical drag" : "-",
    failedResponseByOtherSide: strongestArgumentText ? `• ${otherSide} did not answer with equally specific support` : "-",
    weakestOverall: weakest ? "• " + cleanBullet(weakest.text) : "-",

    bsMeter: bsMeter(a, b),
    manipulation: manipulationText(a, b),
    fluff: fluffText(a, b),

    core_disagreement: "• Team A says origin-of-life research still lacks an experimentally valid path to life\n• Team B says viable prebiotic pathways already exist and the criticism is distorted",
    why: winner === "Tie"
      ? "• Neither side separated clearly enough on support-weighted lines"
      : `• ${winner} had stronger support-bearing lines\n• ${winner} carried less rhetorical drag overall`
  };
}

function summarize(pool) {
  const top = pool.slice(0, Math.max(3, Math.ceil(pool.length * 0.15)));
  return {
    topAvg: avg(top.map(x => x.score)),
    evidence: avg(top.map(x => x.features.evidence)),
    reasoning: avg(top.map(x => x.features.reasoning)),
    attack: avg(pool.map(x => x.features.attack)),
    fluff: avg(pool.map(x => x.features.fluff))
  };
}

function avg(arr) {
  return arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0;
}

function pickStrongestArgument(pool) {
  return pool.find(x =>
    x.features.claim &&
    (x.features.evidence > 0 || x.features.reasoning > 0) &&
    !(x.features.attack > 0 && x.features.evidence === 0 && x.features.reasoning === 0)
  ) || pool[0] || null;
}

function integrityText(s) {
  if (s.attack > 0.9 && s.evidence < 0.8) return "• Too attack-heavy\n• Support load is thin";
  if (s.topAvg >= 7 && s.evidence >= 1.2) return "• Mostly grounded\n• Support-bearing claims are present";
  return "• Mixed integrity\n• Some usable claims, but uneven support";
}

function reasoningText(s) {
  if (s.reasoning >= 1.5 && s.evidence >= 1.2) return "• Strong reasoning chain\n• Claims tie to support";
  if (s.reasoning >= 0.8) return "• Reasoning is present\n• Still uneven in places";
  return "• Reasoning is thin\n• Conclusions outrun support";
}

function bsMeter(a, b) {
  const total = a.attack + b.attack + a.fluff + b.fluff;
  if (total > 3) return "high";
  if (total > 1.5) return "medium";
  return "low";
}

function manipulationText(a, b) {
  if (a.attack < 0.4 && b.attack < 0.4) return "• Low manipulation pressure\n• Most selected lines stay on claims";
  return a.attack > b.attack
    ? "• Team A leans harder on personal framing\n• Rhetorical pressure is elevated"
    : "• Team B leans harder on personal framing\n• Rhetorical pressure is elevated";
}

function fluffText(a, b) {
  const total = a.fluff + b.fluff;
  if (total < 0.5) return "• Low fluff\n• Most selected lines carry argument weight";
  if (total < 1.3) return "• Moderate fluff\n• Some airtime is wasted on posture";
  return "• High fluff\n• Too much filler or non-core motion";
}

/* -------------------- SOURCES -------------------- */

function buildSources(aPool, bPool, videoLink) {
  return [...aPool, ...bPool]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(x => ({
      claim: cleanBullet(x.text),
      status: x.features.evidence > 0 && x.features.reasoning > 0
        ? "supported-language"
        : (x.features.attack > 0 && x.features.evidence === 0 ? "flagged-overreach" : "needs-review"),
      note: x.features.evidence > 0 && x.features.reasoning > 0
        ? "Contains claim-plus-support language."
        : (x.features.attack > 0 && x.features.evidence === 0 ? "Leans more on accusation than support." : "Transcript-only claim."),
      source: videoLink ? "transcript / debate video reference" : "transcript"
    }));
}

/* -------------------- FALLBACK -------------------- */

function fallback(teamAName, teamBName, error) {
  return {
    teamAName,
    teamBName,
    winner: "",
    confidence: "low",
    teamAScore: 50,
    teamBScore: 50,

    teamA: { main_position: "-", truth: "-", lies: "-", opinion: "-", lala: "-" },
    teamB: { main_position: "-", truth: "-", lies: "-", opinion: "-", lala: "-" },

    teamA_integrity: "-",
    teamB_integrity: "-",
    teamA_reasoning: "-",
    teamB_reasoning: "-",

    teamA_lane: "mixed / unclear lane",
    teamB_lane: "mixed / unclear lane",
    same_lane_engagement: false,
    lane_mismatch: true,

    strongestArgumentSide: "-",
    strongestArgument: "-",
    whyStrongest: "-",
    failedResponseByOtherSide: "-",
    weakestOverall: "-",

    bsMeter: "medium",
    manipulation: "-",
    fluff: "-",

    core_disagreement: "-",
    why: "-",

    analysisMode: "fallback",
    sources: [],
    error: clean(error || "Unknown error")
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
