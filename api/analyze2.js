module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    const body = req.body || {};
    const teamAName = cleanText(body.teamAName || "Team A");
    const teamBName = cleanText(body.teamBName || "Team B");
    const transcriptText = getTranscript(body);
    const videoLink = cleanText(body.videoLink || "");

    if (!transcriptText || transcriptText.trim().length < 40) {
      return res.status(200).json(buildFallback(teamAName, teamBName, "Transcript too short or missing"));
    }

    const cleaned = cleanTranscript(transcriptText);
    const segmented = segmentDebate(cleaned);

    const teamALines = collectSideLines(segmented.teamAOpening, segmented.crossfireA);
    const teamBLines = collectSideLines(segmented.teamBOpening, segmented.crossfireB);

    if (!teamALines.length || !teamBLines.length) {
      return res.status(200).json(buildFallback(teamAName, teamBName, "Could not isolate both sides"));
    }

    const scoredA = scorePool(teamALines, "A");
    const scoredB = scorePool(teamBLines, "B");

    const teamA = buildTeamBlock(scoredA);
    const teamB = buildTeamBlock(scoredB);

    const teamA_lane = detectLane(scoredA);
    const teamB_lane = detectLane(scoredB);

    const verdict = buildVerdict({
      teamAName,
      teamBName,
      scoredA,
      scoredB,
      teamA,
      teamB,
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

      teamA: {
        main_position: teamA.main_position,
        truth: teamA.truth,
        lies: teamA.lies,
        opinion: teamA.opinion,
        lala: teamA.lala
      },

      teamB: {
        main_position: teamB.main_position,
        truth: teamB.truth,
        lies: teamB.lies,
        opinion: teamB.opinion,
        lala: teamB.lala
      },

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

      analysisMode: "deterministic-bullets-v1",
      sources,
      error: null
    });
  } catch (err) {
    return res.status(200).json(buildFallback("Team A", "Team B", err && err.message ? err.message : "Unknown backend error"));
  }
};

/* ----------------------------- INPUT ----------------------------- */

function getTranscript(body) {
  const keys = ["transcriptText", "transcript", "rawTranscript", "text"];
  for (const key of keys) {
    if (typeof body[key] === "string" && body[key].trim()) {
      return body[key];
    }
  }
  return "";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/* --------------------------- CLEANING --------------------------- */

function cleanTranscript(text) {
  let t = String(text || "");

  t = t.replace(/\r/g, "\n");

  // kill timestamps
  t = t.replace(/\b\d{1,3}:\d{2,3}(?::\d{2})?\b/g, " ");
  t = t.replace(/\b\d+\s*minute[s]?\s*,?\s*\d+\s*second[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*minute[s]?\b/gi, " ");
  t = t.replace(/\b\d+\s*second[s]?\b/gi, " ");

  // remove bracket tags
  t = t.replace(/\[(applause|laughter|music|audience|cheering)\]/gi, " ");
  t = t.replace(/\[(.*?)\]/g, " ");

  // separate smashed digits/letters
  t = t.replace(/(\d)([A-Za-z])/g, "$1 $2");
  t = t.replace(/([A-Za-z])(\d)/g, "$1 $2");

  // filler cleanup
  t = t.replace(/\b(uh|um|er|ah)\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

function splitSentences(text) {
  return String(text || "")
    .replace(/([.?!])\s+/g, "$1|||")
    .replace(/;/g, ".|||")
    .split("|||")
    .map(cleanText)
    .filter(Boolean);
}

function isUsableSentence(s) {
  if (!s) return false;
  if (s.length < 40) return false;
  if (wordCount(s) < 8) return false;

  const x = s.toLowerCase();

  const hardReject = [
    "good evening everyone",
    "some quick logistics",
    "in case of emergency",
    "please silence your cell phones",
    "the moderator for tonight",
    "describe the ground rules",
    "question and answer session",
    "please join me in welcoming",
    "let's welcome the two debaters",
    "it's a real pleasure to be here",
    "thanks to rice university for having us here tonight",
    "thank you very much",
    "we now turn to",
    "live stream",
    "restroom",
    "photography",
    "videography",
    "neutral corners",
    "weighing in"
  ];

  for (const bad of hardReject) {
    if (x.includes(bad)) return false;
  }

  return /[a-z]/i.test(s);
}

function wordCount(s) {
  return cleanText(s).split(/\s+/).filter(Boolean).length;
}

/* ------------------------- SEGMENTATION ------------------------- */

function segmentDebate(text) {
  const lower = text.toLowerCase();

  const aStart = findFirst(lower, [
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

  const teamAOpening = text.slice(safeAStart, safeBStart > safeAStart ? safeBStart : safeCrossStart);
  const teamBOpening = text.slice(safeBStart, safeCrossStart > safeBStart ? safeCrossStart : text.length);
  const crossfire = text.slice(safeCrossStart);

  const crossLines = splitSentences(crossfire);
  const crossfireA = [];
  const crossfireB = [];

  let current = "A";

  for (const line of crossLines) {
    const x = line.toLowerCase();

    if (
      /show me the prebiotic chemistry|it's not there|i studied every one of your papers|these are the ones you've got to do|i'm asking you to come up and show me the chemistry|you can't make rna|show us the data/.test(x)
    ) {
      current = "A";
    }

    if (
      /you're missing a mountain of research|here's one|i brought actual papers|we've got research for that|nucleotide polymerization has been demonstrated|plenty of studies show|there are countless studies/.test(x)
    ) {
      current = "B";
    }

    if (current === "A") crossfireA.push(line);
    else crossfireB.push(line);
  }

  return {
    teamAOpening,
    teamBOpening,
    crossfireA,
    crossfireB
  };
}

function findFirst(text, markers) {
  let best = -1;
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function collectSideLines(openingText, crossfireLines) {
  const openingLines = splitSentences(openingText).filter(isUsableSentence);
  const crossLines = (crossfireLines || []).filter(isUsableSentence);
  return dedupeLines([...openingLines, ...crossLines]);
}

function dedupeLines(lines) {
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

/* ---------------------------- SCORING ---------------------------- */

function scorePool(lines, side) {
  return lines
    .map(text => {
      const features = getFeatures(text);
      return {
        side,
        text,
        features,
        score: computeScore(features)
      };
    })
    .sort((a, b) => b.score - a.score);
}

function getFeatures(text) {
  const x = text.toLowerCase();

  const evidence = countHits(x, [
    "data", "study", "paper", "journal", "experiment", "evidence", "demonstrates", "shows", "show",
    "prebiotic", "chemistry", "molecular", "rna", "nmr", "spectrum", "nucleotide", "peptide",
    "polypeptide", "polymerization", "yield", "basaltic", "coupling", "reaction", "research"
  ]);

  const reasoning = countHits(x, [
    "because", "therefore", "hence", "since", "if", "then", "which means", "as a result",
    "in order to", "that means"
  ]);

  const attack = countHits(x, [
    "liar", "lies", "fraud", "fraudulence", "charlatan", "delusional", "idiotic",
    "toxic", "clueless", "embarrassing", "unhinged", "ignorance"
  ]);

  const fluff = countHits(x, [
    "thank you", "glad to be here", "pleasure to be here", "enjoy it", "audience", "welcome"
  ]);

  const opinion = countHits(x, [
    "i think", "i believe", "i maintain", "i presume", "i hope"
  ]);

  const theology = countHits(x, [
    "god", "bible", "jesus", "faith", "religious", "creationist", "scripture", "miracles"
  ]);

  const history = countHits(x, [
    "history", "historical", "record", "records", "community", "trend"
  ]);

  const claim = /(is|are|means|shows|demonstrates|requires|fails|cannot|does not|did not|there is|there are|we have|we do not|we don't)/i.test(text);
  const question = /\?$/.test(text) || /^(show me|are you|do you|what is|how|where)/i.test(x);

  return {
    evidence,
    reasoning,
    attack,
    fluff,
    opinion,
    theology,
    history,
    claim,
    question,
    words: wordCount(text)
  };
}

function computeScore(f) {
  let score = 0;

  if (f.claim) score += 4;
  score += Math.min(6, f.evidence);
  score += Math.min(4, f.reasoning * 1.5);

  if (f.words >= 12) score += 2;
  if (f.words >= 18 && f.words <= 44) score += 2;

  score -= Math.min(3, f.opinion);
  score -= Math.min(4, f.fluff * 2);

  const attackOnly = f.attack > 0 && f.evidence === 0 && f.reasoning === 0;
  if (attackOnly) score -= 8;
  else score -= Math.min(3, f.attack);

  if (f.question && f.evidence === 0 && f.reasoning === 0) score -= 3;
  if (f.words < 8) score -= 4;

  return round1(score);
}

function countHits(text, phrases) {
  let count = 0;
  for (const phrase of phrases) {
    const regex = new RegExp("\\b" + escapeRegExp(phrase) + "\\b", "gi");
    const matches = text.match(regex);
    if (matches) count += matches.length;
  }
  return count;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------------- TEAM BLOCKS -------------------------- */

function buildTeamBlock(pool) {
  const main = topMatches(pool, row =>
    row.features.claim &&
    (row.features.evidence > 0 || row.features.reasoning > 0) &&
    row.features.attack === 0
  );

  const truth = topMatches(pool, row =>
    row.features.evidence > 0 &&
    row.features.claim &&
    row.features.attack === 0
  );

  const lies = lowMatches(pool, row =>
    row.features.attack > 0 ||
    (row.features.claim && row.features.evidence === 0 && row.features.reasoning === 0)
  );

  const opinion = topMatches(pool, row =>
    row.features.opinion > 0 ||
    (row.features.claim && row.features.evidence === 0 && row.features.reasoning === 0)
  );

  const lala = lowMatches(pool, row =>
    row.features.fluff > 0 ||
    (row.features.attack > 0 && row.features.evidence === 0)
  );

  return {
    main_position: bulletString(main.length ? main : pool.slice(0, 3)),
    truth: bulletString(truth.length ? truth : pool.slice(0, 3)),
    lies: bulletString(lies.length ? lies : pool.slice(-3).reverse()),
    opinion: bulletString(opinion.length ? opinion : pool.slice(0, 2)),
    lala: bulletString(lala.length ? lala : pool.slice(-2).reverse())
  };
}

function topMatches(pool, predicate) {
  return pool.filter(predicate).slice(0, 3);
}

function lowMatches(pool, predicate) {
  return pool.filter(predicate).sort((a, b) => a.score - b.score).slice(0, 3);
}

function bulletString(rows) {
  if (!rows || !rows.length) return "-";
  const cleaned = rows
    .map(r => cleanBullet(r.text))
    .filter(Boolean)
    .slice(0, 3);

  return cleaned.length ? cleaned.map(line => "• " + line).join("\n") : "-";
}

function cleanBullet(text) {
  let s = cleanText(text);
  s = s.replace(/^[-•\s]+/, "");
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------------------------- LANES ---------------------------- */

function detectLane(pool) {
  const joined = pool.map(r => r.text.toLowerCase()).join(" ");

  const science = countHits(joined, [
    "data", "study", "paper", "experiment", "chemistry", "prebiotic", "rna",
    "nmr", "spectrum", "nucleotide", "peptide", "cell", "polymerization", "yield"
  ]);

  const history = countHits(joined, [
    "history", "historical", "record", "records", "community", "trend"
  ]);

  const theology = countHits(joined, [
    "god", "bible", "jesus", "faith", "religious", "creationist", "scripture"
  ]);

  const buckets = [
    { name: "science / evidence lane", score: science },
    { name: "history / evidence lane", score: history },
    { name: "theology / scripture lane", score: theology }
  ].sort((a, b) => b.score - a.score);

  if (buckets[0].score === 0) return "mixed / unclear lane";
  if (buckets[1].score > 0 && buckets[1].score / buckets[0].score > 0.55) {
    return "mixed lane with overlapping frameworks";
  }
  return buckets[0].name;
}

function sameLane(a, b) {
  if (a === b) return true;
  if (a.includes("mixed") && b.includes("science")) return true;
  if (b.includes("mixed") && a.includes("science")) return true;
  return false;
}

/* ---------------------------- VERDICT ---------------------------- */

function buildVerdict(ctx) {
  const statsA = summarizePool(ctx.scoredA);
  const statsB = summarizePool(ctx.scoredB);

  let teamAScore = Math.round(
    50 +
    (statsA.topAvg - statsB.topAvg) * 2.4 +
    (statsA.evidence - statsB.evidence) * 2.0 +
    (statsA.reasoning - statsB.reasoning) * 1.8 -
    (statsA.attack - statsB.attack) * 1.8 -
    (statsA.fluff - statsB.fluff) * 1.2
  );

  teamAScore = clamp(teamAScore, 1, 99);
  const teamBScore = clamp(100 - teamAScore, 1, 99);

  const diff = Math.abs(teamAScore - teamBScore);
  const winner = diff === 0 ? "Tie" : (teamAScore > teamBScore ? ctx.teamAName : ctx.teamBName);
  const confidence = diff >= 24 ? "high" : diff >= 12 ? "medium" : "low";

  const strongestA = strongestArgument(ctx.scoredA);
  const strongestB = strongestArgument(ctx.scoredB);

  let strongestArgumentSide = ctx.teamAName;
  let strongestArgument = strongestA ? strongestA.text : "";
  let strongestScore = strongestA ? strongestA.score : -999;

  if (strongestB && strongestB.score > strongestScore) {
    strongestArgumentSide = ctx.teamBName;
    strongestArgument = strongestB.text;
    strongestScore = strongestB.score;
  }

  const otherSideName = strongestArgumentSide === ctx.teamAName ? ctx.teamBName : ctx.teamAName;
  const weakestOverall = weakestLine(ctx.scoredA, ctx.scoredB);

  return {
    winner,
    confidence,
    teamAScore,
    teamBScore,

    teamA_integrity: integrityText(statsA),
    teamB_integrity: integrityText(statsB),
    teamA_reasoning: reasoningText(statsA),
    teamB_reasoning: reasoningText(statsB),

    same_lane_engagement: sameLane(ctx.teamA_lane, ctx.teamB_lane),
    lane_mismatch: !sameLane(ctx.teamA_lane, ctx.teamB_lane),

    strongestArgumentSide,
    strongestArgument: strongestArgument || "-",
    whyStrongest: strongestArgument
      ? "• Clear claim\n• Concrete support language\n• Less rhetorical drag than competing lines"
      : "-",
    failedResponseByOtherSide: strongestArgument
      ? `• ${otherSideName} did not answer it with equally specific support\n• Response pressure was higher than direct rebuttal`
      : "-",
    weakestOverall,

    bsMeter: bsMeter(statsA, statsB),
    manipulation: manipulationText(statsA, statsB),
    fluff: fluffText(statsA, statsB),

    core_disagreement:
      "• Team A says origin-of-life work still lacks an experimentally valid path to life\n• Team B says viable prebiotic pathways already exist and Team A distorts the field",

    why:
      winner === "Tie"
        ? "• Neither side separated clearly enough on support-weighted lines"
        : `• ${winner} had stronger support-bearing lines\n• ${winner} carried less rhetorical drag overall`
  };
}

function summarizePool(pool) {
  const top = pool.slice(0, Math.max(3, Math.ceil(pool.length * 0.15)));
  return {
    topAvg: round1(avg(top.map(x => x.score))),
    evidence: round1(avg(top.map(x => x.features.evidence))),
    reasoning: round1(avg(top.map(x => x.features.reasoning))),
    attack: round1(avg(pool.map(x => x.features.attack))),
    fluff: round1(avg(pool.map(x => x.features.fluff)))
  };
}

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function strongestArgument(pool) {
  return pool.find(row =>
    row.features.claim &&
    (row.features.evidence > 0 || row.features.reasoning > 0) &&
    !(row.features.attack > 0 && row.features.evidence === 0 && row.features.reasoning === 0)
  ) || pool[0] || null;
}

function weakestLine(a, b) {
  const row = [...a, ...b].sort((x, y) => x.score - y.score)[0];
  return row ? "• " + cleanBullet(row.text) : "-";
}

function integrityText(stats) {
  if (stats.attack > 0.9 && stats.evidence < 0.8) {
    return "• Too attack-heavy\n• Support load is too thin";
  }
  if (stats.topAvg >= 7 && stats.evidence >= 1.2) {
    return "• Mostly grounded\n• Support-bearing claims are present";
  }
  return "• Mixed integrity\n• Some usable claims, but uneven support";
}

function reasoningText(stats) {
  if (stats.reasoning >= 1.5 && stats.evidence >= 1.2) {
    return "• Strong reasoning chain\n• Claims are tied to support";
  }
  if (stats.reasoning >= 0.8) {
    return "• Reasoning is present\n• Still uneven in places";
  }
  return "• Reasoning is thin\n• Conclusions outrun support";
}

function bsMeter(a, b) {
  const total = a.attack + b.attack + a.fluff + b.fluff;
  if (total > 3) return "high";
  if (total > 1.5) return "medium";
  return "low";
}

function manipulationText(a, b) {
  if (a.attack < 0.4 && b.attack < 0.4) {
    return "• Low manipulation pressure\n• Most selected lines stay on claims";
  }
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

/* ---------------------------- SOURCES ---------------------------- */

function buildSources(aPool, bPool, videoLink) {
  return [...aPool, ...bPool]
    .filter(row => row.text && row.text.length >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(row => {
      let status = "needs-review";
      let note = "Transcript-only claim. Check cited papers or the full video.";
      if (row.features.evidence > 0 && row.features.reasoning > 0) {
        status = "supported-language";
        note = "Contains claim-plus-support language.";
      } else if (row.features.attack > 0 && row.features.evidence === 0) {
        status = "flagged-overreach";
        note = "Leans more on accusation than support.";
      }

      return {
        claim: cleanBullet(row.text),
        status,
        note,
        source: videoLink ? "transcript / debate video reference" : "transcript"
      };
    });
}

/* --------------------------- FALLBACK --------------------------- */

function buildFallback(teamAName, teamBName, errorMessage) {
  return {
    teamAName,
    teamBName,
    winner: "",
    confidence: "low",
    teamAScore: 50,
    teamBScore: 50,

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
    error: cleanText(errorMessage || "Unknown error")
  };
}

/* --------------------------- UTILITIES --------------------------- */

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
