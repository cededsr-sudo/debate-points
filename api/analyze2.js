export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const teamAName = cleanText(body.teamAName || "Team A");
    const teamBName = cleanText(body.teamBName || "Team B");
    const videoLink = cleanText(body.videoLink || "");
    const rawTranscript = body.transcriptText || body.text || "";

    if (!cleanText(rawTranscript)) {
      return res.status(400).json({
        error: "Paste a transcript first."
      });
    }

    const transcript = normalizeTranscript(rawTranscript);
    const paragraphs = splitIntoParagraphs(transcript);
    const candidateClaims = extractCandidateClaims(paragraphs);

    const sideBuckets = splitClaimsIntoSides(candidateClaims);
    const teamAClaims = scoreClaims(sideBuckets.teamA);
    const teamBClaims = scoreClaims(sideBuckets.teamB);

    const teamA = buildSideSummary(teamAName, teamAClaims);
    const teamB = buildSideSummary(teamBName, teamBClaims);

    const coreDisagreement = buildCoreDisagreement(teamA, teamB);
    const strongest = chooseStrongest(teamA, teamB);
    const weakest = chooseWeakest(teamA, teamB);
    const winner = chooseWinner(teamA, teamB);
    const scores = buildScores(teamA, teamB, winner);
    const lanes = buildLaneSection(teamA, teamB);
    const pressureNoise = buildPressureNoise(teamA, teamB);
    const sources = buildSources(teamAName, teamBName, teamA, teamB, videoLink);

    const result = {
      teamAName,
      teamBName,

      winner,
      confidence: scores.confidence,
      teamAScore: String(scores.teamA),
      teamBScore: String(scores.teamB),

      teamA_lane: teamA.lane,
      teamB_lane: teamB.lane,
      core_disagreement: coreDisagreement,
      bsMeter: buildBsMeter(teamA, teamB),
      strongestArgumentSide: strongest.side,
      strongestArgument: strongest.text,
      whyStrongest: strongest.why,
      failedResponseByOtherSide: strongest.failedResponse,
      weakestOverall: weakest.text,
      why: buildOverallWhy(winner, teamA, teamB, strongest, weakest),

      teamA: {
        main_position: teamA.mainPosition,
        truth: teamA.truth,
        lies: teamA.overreach,
        opinion: teamA.opinion,
        lala: teamA.lala
      },
      teamB: {
        main_position: teamB.mainPosition,
        truth: teamB.truth,
        lies: teamB.overreach,
        opinion: teamB.opinion,
        lala: teamB.lala
      },

      teamA_integrity: teamA.integrity,
      teamB_integrity: teamB.integrity,
      teamA_reasoning: teamA.reasoning,
      teamB_reasoning: teamB.reasoning,

      same_lane_engagement: lanes.sameLaneEngagement,
      lane_mismatch: lanes.laneMismatch,

      manipulation: pressureNoise.manipulation,
      fluff: pressureNoise.fluff,

      analysisMode: "DETERMINISTIC+CLAIM-FIRST+HEURISTIC-SCORING+MERGE",
      sources
    };

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      error: "Analysis failed",
      detail: cleanText(err && err.message ? err.message : "Unknown error")
    });
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text, max = 240) {
  const t = cleanText(text);
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max - 3).trim() + "...";
}

function normalizeTranscript(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\s*hour[s]?,?\s*\d+\s*minute[s]?,?\s*\d+\s*second[s]?\b/gi, " ")
    .replace(/\b\d+\s*minute[s]?,?\s*\d+\s*second[s]?\b/gi, " ")
    .replace(/\b\d+\s*second[s]?\b/gi, " ")
    .replace(/\b\d+\s*minute[s]?\b/gi, " ")
    .replace(/\b\d+\s*hour[s]?\b/gi, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function splitIntoParagraphs(text) {
  return String(text || "")
    .split(/\n+/)
    .map((p) => cleanText(p))
    .filter(Boolean)
    .filter((p) => p.length >= 20);
}

function extractCandidateClaims(paragraphs) {
  const sentences = [];

  for (const para of paragraphs) {
    const split = para
      .split(/(?<=[.!?])\s+|(?<=;)\s+|(?<=:)\s+(?=[A-Z])/)
      .map((s) => cleanText(s))
      .filter(Boolean);

    for (const s of split) {
      if (isUsableSentence(s)) {
        sentences.push(s);
      }
    }
  }

  return dedupe(sentences);
}

function isUsableSentence(sentence) {
  const s = cleanText(sentence);
  const lower = s.toLowerCase();

  if (!s || s.length < 35) return false;

  const blocked = [
    "subscribe",
    "notification bell",
    "share this video",
    "thanks for watching",
    "thank you all",
    "welcome back",
    "let's get started",
    "this concludes",
    "open discussion",
    "i invited him",
    "separate debate",
    "thanks for participating",
    "we can go from there",
    "can you clarify",
    "what do you mean by",
    "i'll facilitate",
    "our speakers"
  ];

  if (blocked.some((x) => lower.includes(x))) return false;

  if (
    !containsAny(lower, [
      "because",
      "therefore",
      "so",
      "if",
      "then",
      "shows",
      "means",
      "evidence",
      "study",
      "research",
      "history",
      "historical",
      "source",
      "record",
      "fossil",
      "genesis",
      "gospel",
      "jesus",
      "evolution",
      "common ancestry",
      "eyewitness",
      "martyrdom",
      "moral law",
      "mechanism",
      "selection"
    ])
  ) {
    return false;
  }

  return true;
}

function splitClaimsIntoSides(claims) {
  const teamA = [];
  const teamB = [];

  for (let i = 0; i < claims.length; i += 1) {
    if (i % 2 === 0) teamA.push(claims[i]);
    else teamB.push(claims[i]);
  }

  return { teamA, teamB };
}

function scoreClaims(claims) {
  return claims
    .map((text) => {
      const lower = text.toLowerCase();

      let score = 0;

      score += containsAny(lower, ["because", "therefore", "if", "then", "means", "shows"]) ? 25 : 0;
      score += containsAny(lower, ["study", "studies", "research", "evidence", "historical", "record", "source", "fossil", "eyewitness"]) ? 25 : 0;
      score += containsAny(lower, ["genesis", "gospel", "jesus", "evolution", "common ancestry", "martyrdom", "papias", "johannine", "mechanism"]) ? 20 : 0;
      score += containsAny(lower, ["wrong", "false", "misleading", "undermines", "fails", "does not answer", "doesn't answer"]) ? 10 : 0;
      score -= containsAny(lower, ["obviously", "clearly", "devastating", "completely destroys", "everyone knows"]) ? 8 : 0;
      score -= containsAny(lower, ["um", "uh", "i mean", "you know", "like"]) ? 5 : 0;

      if (text.length > 260) score -= 6;
      if (text.length < 45) score -= 8;

      return {
        text,
        score,
        lower,
        type: classifySentence(lower)
      };
    })
    .sort((a, b) => b.score - a.score);
}

function classifySentence(lower) {
  if (containsAny(lower, ["because", "therefore", "if", "then", "means", "shows"])) return "reasoning";
  if (containsAny(lower, ["study", "research", "evidence", "historical", "record", "source", "fossil", "eyewitness"])) return "support";
  if (containsAny(lower, ["wrong", "false", "misleading", "undermines", "fails"])) return "attack";
  return "general";
}

function buildSideSummary(sideName, claims) {
  const best = claims[0]?.text || "";
  const support = claims.find((x) => x.type === "support")?.text || best;
  const reasoning = claims.find((x) => x.type === "reasoning")?.text || best;
  const attack = claims.find((x) => x.type === "attack")?.text || "";
  const lowerAll = claims.map((x) => x.lower).join(" ");

  const lane = inferLane(lowerAll);

  return {
    sideName,
    rawClaims: claims,
    best,
    lane,

    mainPosition: best
      ? `${sideName} mainly argues that ${humanize(best)}.`
      : `${sideName} does not preserve a stable single claim clearly enough to summarize.`,

    truth: support
      ? humanize(support)
      : `${sideName} presents at least one usable point, but the cleanest support sentence is not preserved well.`,

    overreach: attack
      ? humanize(attack)
      : containsAny(lowerAll, ["obviously", "clearly", "devastating", "completely destroys", "everyone knows"])
        ? `${sideName} shows some overreach or unsupported certainty in the preserved text.`
        : `${sideName} preserves some claims that still need tighter support.`,

    opinion: containsAny(lowerAll, ["i think", "i believe", "it seems", "probably", "maybe"])
      ? `${sideName} includes interpretive or judgment language mixed into the case.`
      : `${sideName} uses some interpretation alongside direct argument.`,

    lala: containsAny(lowerAll, ["um", "uh", "i mean", "you know", "like"])
      ? `Some filler remains after cleanup.`
      : `Low fluff after cleanup.`,

    integrity: containsAny(lowerAll, ["obviously", "clearly", "devastating", "everyone knows"])
      ? `Shows noticeable overreach or unsupported certainty relative to the preserved support.`
      : `Leans more grounded than inflated, though not every claim is equally supported.`,

    reasoning: containsAny(lowerAll, ["because", "therefore", "if", "then", "means", "shows"])
      ? `Strongest on explicit reasoning structure and at least some evidentiary support.`
      : `Uses support language and topic engagement, though the chain from premise to conclusion is less consistent.`,

    supportCount: claims.filter((x) => x.type === "support" || x.type === "reasoning").length,
    attackCount: claims.filter((x) => x.type === "attack").length,
    fluffCount: countAny(lowerAll, ["um", "uh", "i mean", "you know", "like"]),
    overreachCount: countAny(lowerAll, ["obviously", "clearly", "devastating", "completely destroys", "everyone knows"]),
    totalScore: claims.reduce((sum, x) => sum + Math.max(0, x.score), 0)
  };
}

function humanize(text) {
  let t = cleanText(text);

  t = t
    .replace(/^[,;:\- ]+/, "")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\s+\?/g, "?")
    .replace(/\s+\!/g, "!");

  return clip(t, 260);
}

function inferLane(lower) {
  const history = countAny(lower, ["history", "historical", "source", "sources", "record", "records", "eyewitness", "martyrdom", "papias", "johannine"]);
  const theology = countAny(lower, ["genesis", "god", "jesus", "gospel", "gospels", "scripture", "theology", "moral law", "moral lawgiver"]);
  const science = countAny(lower, ["evolution", "common ancestry", "fossil", "selection", "mechanism", "mechanisms", "adaptation", "study", "studies", "research"]);

  if (science >= history && science >= theology && science > 0) return "science / evidence lane";
  if (history >= science && history >= theology && history > 0) return "history / evidence lane";
  if (theology >= science && theology >= history && theology > 0) return "theology / scripture lane";
  return "mixed / unclear lane";
}

function buildCoreDisagreement(teamA, teamB) {
  const a = bareClaim(teamA.best);
  const b = bareClaim(teamB.best);

  if (!a && !b) {
    return "The transcript cleanup did not preserve a stable core claim for either side clearly enough to summarize.";
  }

  if (a && b && a.toLowerCase() === b.toLowerCase()) {
    return "Both sides circle the same topic, but they frame or support it differently in the preserved transcript.";
  }

  return `Main dispute: ${teamA.sideName} says ${a || "its case is not preserved clearly"}, but ${teamB.sideName} says ${b || "its case is not preserved clearly"}.`;
}

function bareClaim(text) {
  const t = humanize(text);
  if (!t) return "";
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function chooseStrongest(teamA, teamB) {
  const stronger = teamA.totalScore >= teamB.totalScore ? teamA : teamB;
  const weaker = stronger === teamA ? teamB : teamA;

  return {
    side: stronger.sideName,
    text: `Core point: ${humanize(stronger.best) || "No stable strongest claim survived cleanup."}`,
    why:
      stronger.best
        ? `It stands out because it brings more actual support and stays closer to the real dispute.`
        : `No stable strongest claim survived cleanup.`,
    failedResponse:
      stronger.best
        ? `${weaker.sideName} does not beat that point with a cleaner rival claim. Its nearest competing claim is: ${humanize(weaker.best) || "none preserved clearly"}.`
        : `No stable strongest-argument comparison could be finalized.`
  };
}

function chooseWeakest(teamA, teamB) {
  const aWeak = teamA.overreachCount + Math.max(0, teamA.fluffCount - 1);
  const bWeak = teamB.overreachCount + Math.max(0, teamB.fluffCount - 1);

  if (aWeak === bWeak) {
    return {
      text: "Neither side creates a clean edge on weakness. Both preserve claims with support gaps, interpretive stretch, or overreach."
    };
  }

  const weaker = aWeak > bWeak ? teamA : teamB;
  return {
    text: `${weaker.sideName} is weakest on ${humanize(weaker.rawClaims[0]?.text || weaker.best)} because it asserts more than it cleanly demonstrates.`
  };
}

function chooseWinner(teamA, teamB) {
  const diff = Math.abs(teamA.totalScore - teamB.totalScore);
  if (diff <= 12) return "Mixed";
  return teamA.totalScore > teamB.totalScore ? teamA.sideName : teamB.sideName;
}

function buildScores(teamA, teamB, winner) {
  let teamAScore = Math.max(50, Math.min(95, Math.round(teamA.totalScore / Math.max(1, teamA.rawClaims.length || 1))));
  let teamBScore = Math.max(50, Math.min(95, Math.round(teamB.totalScore / Math.max(1, teamB.rawClaims.length || 1))));

  if (winner === "Mixed") {
    const avg = Math.round((teamAScore + teamBScore) / 2);
    teamAScore = avg;
    teamBScore = avg;
  }

  const diff = Math.abs(teamAScore - teamBScore);
  const confidence = `${Math.max(51, Math.min(88, 51 + diff))}%`;

  return {
    teamA: teamAScore,
    teamB: teamBScore,
    confidence
  };
}

function buildLaneSection(teamA, teamB) {
  if (teamA.lane === teamB.lane) {
    return {
      sameLaneEngagement: `Both sides largely argue in the same lane: ${teamA.lane}.`,
      laneMismatch: `Low lane mismatch. They are mostly fighting on shared ground.`
    };
  }

  return {
    sameLaneEngagement: `At least one side blends lanes, so engagement is only partial rather than cleanly matched.`,
    laneMismatch: `Lane mismatch exists: ${teamA.sideName} is mainly in ${teamA.lane}, while ${teamB.sideName} is mainly in ${teamB.lane}.`
  };
}

function buildPressureNoise(teamA, teamB) {
  const aPressure = containsAny(teamA.rawClaims.map((x) => x.lower).join(" "), ["clown", "gish gallop", "misleading", "what are you talking about", "why are you being so aggressive"]);
  const bPressure = containsAny(teamB.rawClaims.map((x) => x.lower).join(" "), ["clown", "gish gallop", "misleading", "what are you talking about", "why are you being so aggressive"]);

  return {
    manipulation: `${teamA.sideName}: ${aPressure ? "Noticeable pressure language and framing tactics show up alongside the argument." : "Low obvious manipulation in the preserved text."} ${teamB.sideName}: ${bPressure ? "Noticeable pressure language and framing tactics show up alongside the argument." : "Low obvious manipulation in the preserved text."}`,
    fluff: `${teamA.sideName}: ${teamA.fluffCount > 1 ? "Some fluff remains, but the main claims are still identifiable." : "Low fluff after cleanup."} ${teamB.sideName}: ${teamB.fluffCount > 1 ? "Some fluff remains, but the main claims are still identifiable." : "Low fluff after cleanup."}`
  };
}

function buildBsMeter(teamA, teamB) {
  if (teamA.overreachCount > teamB.overreachCount) return `${teamA.sideName} is reaching more`;
  if (teamB.overreachCount > teamA.overreachCount) return `${teamB.sideName} is reaching more`;
  return "Both sides show comparable overreach.";
}

function buildOverallWhy(winner, teamA, teamB, strongest, weakest) {
  if (winner === "Mixed") {
    return `Close call. ${teamA.sideName}'s clearest usable point is ${bareClaim(teamA.best) || "not preserved clearly"}, while ${teamB.sideName}'s clearest usable point is ${bareClaim(teamB.best) || "not preserved clearly"}. ${weakest.text}`;
  }

  const losingSide = winner === teamA.sideName ? teamB : teamA;
  return `${winner} wins because its better point is more structured, more supported, and closer to the actual dispute. ${losingSide.sideName} falls behind because its preserved claims lean more on assertion than clean demonstration.`;
}

function buildSources(teamAName, teamBName, teamA, teamB, videoLink) {
  const items = [];
  const picked = [
    { side: teamAName, claim: teamA.best },
    { side: teamAName, claim: teamA.rawClaims[1]?.text || "" },
    { side: teamBName, claim: teamB.best },
    { side: teamBName, claim: teamB.rawClaims[1]?.text || "" }
  ];

  for (const item of picked) {
    if (!cleanText(item.claim)) continue;

    items.push({
      claim: `${item.side}: ${humanize(item.claim)}`,
      type: inferSourceType(item.claim),
      confidence: "unknown",
      source: videoLink || "Transcript-only analysis",
      note: buildSourceNote(item.claim)
    });
  }

  return items.slice(0, 6);
}

function inferSourceType(claim) {
  const lower = cleanText(claim).toLowerCase();
  if (containsAny(lower, ["study", "research", "historical", "record", "source", "fossil", "eyewitness", "journal", "published"])) {
    return "supported-language";
  }
  if (containsAny(lower, ["obviously", "clearly", "devastating", "completely destroys"])) {
    return "flagged-overreach";
  }
  return "needs-review";
}

function buildSourceNote(claim) {
  const lower = cleanText(claim).toLowerCase();
  if (containsAny(lower, ["study", "research", "historical", "record", "source", "fossil", "eyewitness", "journal", "published"])) {
    return "Uses evidence-oriented language, but outside verification is still required.";
  }
  if (containsAny(lower, ["obviously", "clearly", "devastating", "completely destroys"])) {
    return "Contains strong certainty or sweep language that would need outside verification.";
  }
  return "This claim is analyzable, but not independently verified in this backend-only version.";
}

function containsAny(text, words) {
  return words.some((word) => String(text).includes(word));
}

function countAny(text, words) {
  return words.reduce((sum, word) => sum + (String(text).includes(word) ? 1 : 0), 0);
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    const key = cleanText(item).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cleanText(item));
  }

  return out;
}
