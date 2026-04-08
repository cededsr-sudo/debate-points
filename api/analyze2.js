module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    const body = req.body || {};
    const teamAName = clean(body.teamAName || "Team A");
    const teamBName = clean(body.teamBName || "Team B");
    const transcript = clean(body.transcriptText || "");
    const videoLink = clean(body.videoLink || "");

    if (!transcript) {
      return res.status(200).json(fallback(teamAName, teamBName, "Transcript missing"));
    }

    const cut = trimFrontMatter(transcript);
    const parts = splitSections(cut);

    const aPool = scoreLines(toLines(parts.a));
    const bPool = scoreLines(toLines(parts.b));

    if (!aPool.length || !bPool.length) {
      return res.status(200).json(fallback(teamAName, teamBName, "Could not split debate"));
    }

    const teamA = buildSide(aPool);
    const teamB = buildSide(bPool);

    const aLane = lane(aPool);
    const bLane = lane(bPool);

    const aTop = avgTop(aPool);
    const bTop = avgTop(bPool);
    const aBad = avgBad(aPool);
    const bBad = avgBad(bPool);

    let teamAScore = Math.round(50 + (aTop - bTop) * 2 - (aBad - bBad) * 2);
    teamAScore = Math.max(1, Math.min(99, teamAScore));
    const teamBScore = 100 - teamAScore;

    const winner = teamAScore === teamBScore ? "Tie" : (teamAScore > teamBScore ? teamAName : teamBName);
    const diff = Math.abs(teamAScore - teamBScore);
    const confidence = diff >= 20 ? "high" : diff >= 10 ? "medium" : "low";

    const strongestA = strongest(aPool);
    const strongestB = strongest(bPool);
    const strongestPick = (!strongestB || (strongestA && strongestA.score >= strongestB.score))
      ? { side: teamAName, row: strongestA, other: teamBName }
      : { side: teamBName, row: strongestB, other: teamAName };

    const weakestOverall = [...aPool, ...bPool].sort((x, y) => x.score - y.score)[0]?.text || "";

    return res.status(200).json({
      teamAName,
      teamBName,
      winner,
      confidence,
      teamAScore,
      teamBScore,

      teamA,
      teamB,

      teamA_integrity: integrity(aPool),
      teamB_integrity: integrity(bPool),
      teamA_reasoning: reasoning(aPool),
      teamB_reasoning: reasoning(bPool),

      teamA_lane: aLane,
      teamB_lane: bLane,
      same_lane_engagement: sameLane(aLane, bLane),
      lane_mismatch: !sameLane(aLane, bLane),

      strongestArgumentSide: strongestPick.side,
      strongestArgument: strongestPick.row?.text || "",
      whyStrongest: strongestPick.row ? "Best mix of claim + support, less fluff." : "",
      failedResponseByOtherSide: strongestPick.row ? `${strongestPick.other} did not answer with equally specific support.` : "",
      weakestOverall,

      bsMeter: bsMeter(aPool, bPool),
      manipulation: manipulation(aPool, bPool),
      fluff: fluff(aPool, bPool),

      core_disagreement:
        "One side says origin-of-life research still lacks an experimentally valid path to life; the other says there are already viable prebiotic pathways and the criticism is distorted.",
      why:
        winner === "Tie"
          ? "Neither side separated clearly enough on support-weighted lines."
          : `${winner} had stronger support-bearing lines and/or less rhetorical drag.`,

      analysisMode: "deterministic-lite",
      sources: buildSources(aPool, bPool, videoLink),
      error: null
    });
  } catch (e) {
    return res.status(200).json(fallback("Team A", "Team B", e.message || "Unknown error"));
  }
};

function clean(s) {
  return String(s || "")
    .replace(/\r/g, "\n")
    .replace(/\b\d{1,2}:\d{2,3}(?:\s*(?:second|seconds))?\b/gi, " ")
    .replace(/\b\d+\s*minute[s]?\s*,?\s*\d+\s*second[s]?\b/gi, " ")
    .replace(/\b\d+\s*minute[s]?\b/gi, " ")
    .replace(/\b\d+\s*second[s]?\b/gi, " ")
    .replace(/\[(.*?)\]/g, " ")
    .replace(/\b(uh|um|er|ah)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    return { a: text.slice(0, mid), b: text.slice(mid) };
  }

  const aOpen = text.slice(0, bStart);
  const bOpen = crossStart !== -1 ? text.slice(bStart, crossStart) : text.slice(bStart);
  const cross = crossStart !== -1 ? text.slice(crossStart) : "";

  const crossLines = toLines(cross);
  const aCross = [];
  const bCross = [];
  let who = "A";

  for (const line of crossLines) {
    const x = line.toLowerCase();

    if (/show me the prebiotic chemistry|it's not there|i studied every one of your papers|these are the ones you've got to do/.test(x)) who = "A";
    if (/you're missing a mountain of research|here's one|i brought actual papers|we've got research for that/.test(x)) who = "B";

    if (who === "A") aCross.push(line);
    else bCross.push(line);
  }

  return {
    a: aOpen + ". " + aCross.join(". "),
    b: bOpen + ". " + bCross.join(". ")
  };
}

function toLines(text) {
  return String(text || "")
    .replace(/([.?!])\s+/g, "$1|||")
    .split("|||")
    .map(s => s.trim())
    .filter(s => s.length >= 35 && s.split(/\s+/).length >= 7)
    .filter(s => {
      const x = s.toLowerCase();
      return ![
        "good evening everyone",
        "some quick logistics",
        "in case of emergency",
        "please silence your cell phones",
        "thank you very much",
        "please join me in welcoming",
        "describe the ground rules"
      ].some(j => x.includes(j));
    });
}

function scoreLines(lines) {
  const seen = new Set();
  return lines
    .filter(line => {
      const k = line.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(text => {
      const x = text.toLowerCase();
      const evidence = hits(x, ["data","study","paper","journal","experiment","evidence","prebiotic","chemistry","rna","nmr","spectrum","peptide","nucleotide","yield","coupling"]);
      const reason = hits(x, ["because","therefore","hence","since","if","then","which means"]);
      const attack = hits(x, ["liar","lies","fraud","charlatan","delusional","idiotic","toxic","clueless"]);
      const fluff = hits(x, ["thank you","glad to be here","pleasure to be here","enjoy it"]);
      const claim = /(is|are|means|shows|demonstrates|requires|fails|cannot|does not|did not|there is|there are|we have)/i.test(text);

      let score = 0;
      if (claim) score += 4;
      score += Math.min(6, evidence);
      score += Math.min(4, reason * 1.5);
      if (text.split(/\s+/).length >= 12) score += 2;
      if (attack > 0 && evidence === 0 && reason === 0) score -= 8;
      else score -= Math.min(3, attack);
      score -= Math.min(4, fluff * 2);

      return { text, score, evidence, reason, attack, fluff, claim };
    })
    .sort((a, b) => b.score - a.score);
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

function buildSide(pool) {
  return {
    main_position: pick(pool, x => x.claim && (x.evidence > 0 || x.reason > 0) && x.attack === 0),
    truth: pick(pool, x => x.evidence > 0 && x.claim && x.attack === 0),
    lies: pickLow(pool, x => x.attack > 0 || (x.claim && x.evidence === 0 && x.reason === 0)),
    opinion: pick(pool, x => x.claim && x.evidence === 0 && x.reason === 0),
    lala: pickLow(pool, x => x.fluff > 0 || (x.attack > 0 && x.evidence === 0))
  };
}

function pick(pool, test) {
  return pool.find(test)?.text || pool[0]?.text || "";
}

function pickLow(pool, test) {
  return [...pool].filter(test).sort((a, b) => a.score - b.score)[0]?.text || [...pool].sort((a, b) => a.score - b.score)[0]?.text || "";
}

function strongest(pool) {
  return pool.find(x => x.claim && (x.evidence > 0 || x.reason > 0) && !(x.attack > 0 && x.evidence === 0)) || pool[0] || null;
}

function avgTop(pool) {
  const top = pool.slice(0, Math.max(3, Math.ceil(pool.length * 0.15)));
  return top.length ? top.reduce((s, x) => s + x.score, 0) / top.length : 0;
}

function avgBad(pool) {
  return pool.length ? pool.reduce((s, x) => s + x.attack + x.fluff, 0) / pool.length : 0;
}

function integrity(pool) {
  const bad = avgBad(pool);
  const top = avgTop(pool);
  if (bad > 1.2 && top < 6) return "Too attack-heavy.";
  if (top >= 7) return "Mostly grounded.";
  return "Mixed integrity.";
}

function reasoning(pool) {
  const top = pool.slice(0, Math.max(3, Math.ceil(pool.length * 0.15)));
  const r = top.length ? top.reduce((s, x) => s + x.reason, 0) / top.length : 0;
  if (r >= 1.5) return "Reasoning is strong.";
  if (r >= 0.8) return "Reasoning is present but uneven.";
  return "Reasoning is thin.";
}

function lane(pool) {
  const text = pool.map(x => x.text.toLowerCase()).join(" ");
  const science = hits(text, ["data","study","paper","experiment","chemistry","prebiotic","rna","nmr","peptide","nucleotide","cell"]);
  const theology = hits(text, ["god","bible","jesus","faith","religious","creationist"]);
  if (science >= theology && science > 0) return "science / evidence lane";
  if (theology > science) return "theology / scripture lane";
  return "mixed / unclear lane";
}

function sameLane(a, b) {
  if (a === b) return true;
  if (a.includes("mixed") && b.includes("science")) return true;
  if (b.includes("mixed") && a.includes("science")) return true;
  return false;
}

function bsMeter(aPool, bPool) {
  const bad = avgBad(aPool) + avgBad(bPool);
  if (bad > 2.2) return "high";
  if (bad > 1.1) return "medium";
  return "low";
}

function manipulation(aPool, bPool) {
  const a = aPool.reduce((s, x) => s + x.attack, 0) / Math.max(1, aPool.length);
  const b = bPool.reduce((s, x) => s + x.attack, 0) / Math.max(1, bPool.length);
  if (a < 0.4 && b < 0.4) return "Low manipulation pressure.";
  return a > b ? "Team A leans harder on personal framing." : "Team B leans harder on personal framing.";
}

function fluff(aPool, bPool) {
  const f = aPool.reduce((s, x) => s + x.fluff, 0) / Math.max(1, aPool.length) +
            bPool.reduce((s, x) => s + x.fluff, 0) / Math.max(1, bPool.length);
  if (f < 0.5) return "Low fluff.";
  if (f < 1.2) return "Moderate fluff.";
  return "High fluff.";
}

function buildSources(aPool, bPool, videoLink) {
  return [...aPool, ...bPool].slice(0, 8).map(x => ({
    claim: x.text,
    status: x.evidence > 0 && x.reason > 0 ? "supported-language" : (x.attack > 0 && x.evidence === 0 ? "flagged-overreach" : "needs-review"),
    note: x.evidence > 0 && x.reason > 0 ? "Claim includes support language." : (x.attack > 0 && x.evidence === 0 ? "More accusation than support." : "Transcript-only claim."),
    source: videoLink ? "transcript / debate video reference" : "transcript"
  }));
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
    error: clean(error || "Unknown error")
  };
}
