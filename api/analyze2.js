"use strict";

/**
 * /api/analyze2.js
 *
 * Backend for the uploaded Debate Judgment frontend.
 * No external packages.
 * Always returns valid JSON.
 *
 * Goal:
 * - strip timestamp garbage
 * - strip moderator / intro / outro junk
 * - split transcript into usable claim sentences
 * - infer each side's argument pool
 * - select real thesis/support/overreach/opinion/filler
 * - return EXACT frontend contract
 */

const DEFAULT_TEAM_A = "Team A";
const DEFAULT_TEAM_B = "Team B";
const ANALYSIS_MODE =
  "deterministic+claim-first+speaker-segmentation+factcheck-stub+frontend-match";

module.exports = async function analyze2Handler(req, res) {
  try {
    const body = req && req.body && typeof req.body === "object" ? req.body : {};

    const teamAName =
      normalizeText(body.teamAName || body.teamA || body.speakerA || body.nameA) ||
      DEFAULT_TEAM_A;

    const teamBName =
      normalizeText(body.teamBName || body.teamB || body.speakerB || body.nameB) ||
      DEFAULT_TEAM_B;

    const videoLink = normalizeText(body.videoLink || "");
    const transcriptRaw = getTranscriptFromBody(body);

    if (!transcriptRaw) {
      return res.json(buildFailureResponse({
        teamAName,
        teamBName,
        message: "Paste a transcript first."
      }));
    }

    const cleanedTranscript = cleanTranscript(transcriptRaw);
    const sentencePool = splitTranscriptIntoSentences(cleanedTranscript);

    const sideBuckets = inferSideBuckets(sentencePool, teamAName, teamBName);
    const teamAClaims = analyzeSide(sideBuckets.teamA, teamAName, teamBName);
    const teamBClaims = analyzeSide(sideBuckets.teamB, teamBName, teamAName);

    const result = buildResult({
      teamAName,
      teamBName,
      teamAClaims,
      teamBClaims,
      videoLink
    });

    return res.json(result);
  } catch (error) {
    return res.json(
      buildFailureResponse({
        teamAName:
          normalizeText(req?.body?.teamAName || req?.body?.teamA) || DEFAULT_TEAM_A,
        teamBName:
          normalizeText(req?.body?.teamBName || req?.body?.teamB) || DEFAULT_TEAM_B,
        message: error && error.message ? error.message : "Unknown backend error"
      })
    );
  }
};

/* -------------------------------------------------------------------------- */
/* input                                                                      */
/* -------------------------------------------------------------------------- */

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

  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item;
  }

  if (Array.isArray(body.transcriptLines)) {
    return body.transcriptLines.filter(Boolean).join("\n");
  }

  if (Array.isArray(body.lines)) {
    return body.lines.filter(Boolean).join("\n");
  }

  return "";
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function clip(text, max = 240) {
  const t = normalizeText(text);
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trim() + "…";
}

/* -------------------------------------------------------------------------- */
/* transcript cleaning                                                        */
/* -------------------------------------------------------------------------- */

function cleanTranscript(raw) {
  let text = String(raw || "");

  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // explode mashed timestamps onto boundaries
  text = text
    .replace(/(\d{1,2}:\d{2}(?::\d{2})?)/g, "\n$1 ")
    .replace(/\b(\d+)\s*hours?,?\s*(\d+)\s*minutes?,?\s*(\d+)\s*seconds?/gi, "\n")
    .replace(/\b(\d+)\s*minutes?,?\s*(\d+)\s*seconds?/gi, "\n")
    .replace(/\b(\d+)\s*seconds?/gi, " ")
    .replace(/\b(\d+)\s*minutes?/gi, " ")
    .replace(/\b(\d+)\s*hours?/gi, " ");

  // remove stage junk
  text = text
    .replace(/\[[^\]]{0,100}\]/g, " ")
    .replace(/\((?:applause|laughter|music|intro|outro|crosstalk|cheering|noise)[^)]*\)/gi, " ");

  // split obvious speaker labels
  text = text.replace(/\b([A-Z][a-z]{2,20})\s*:/g, "\n$1: ");

  // unstick camel fragments caused by transcript damage
  text = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\bseconds([A-Z])/g, " $1")
    .replace(/\bminutes([A-Z])/g, " $1")
    .replace(/\bhour([A-Z])/g, " $1")
    .replace(/\bhours([A-Z])/g, " $1");

  // clean symbols
  text = text
    .replace(/[|]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return text;
}

function splitTranscriptIntoSentences(text) {
  const lines = String(text || "")
    .split("\n")
    .map((x) => normalizeText(x))
    .filter(Boolean);

  const rawSentences = [];

  for (const line of lines) {
    if (isModeratorLine(line)) continue;
    if (isPureMetadata(line)) continue;

    const parts = line
      .split(/(?<=[.!?])\s+|;\s+|\s+-\s+/)
      .map((s) => normalizeText(s))
      .filter(Boolean);

    for (const part of parts) {
      const cleaned = cleanupSentence(part);
      if (cleaned) rawSentences.push(cleaned);
    }
  }

  return dedupe(rawSentences).filter((s) => !isBadSentence(s));
}

function cleanupSentence(sentence) {
  let s = normalizeText(sentence);

  s = s
    .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "")
    .replace(/^[,:;.\-]+/, "")
    .replace(/[,:;.\-]+$/, "")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .trim();

  return s;
}

function isPureMetadata(line) {
  const low = line.toLowerCase();
  return (
    /^analysis mode\b/.test(low) ||
    /^sync to video time\b/.test(low) ||
    /^video link\b/.test(low) ||
    /^team [ab] name\b/.test(low)
  );
}

function isModeratorLine(line) {
  const low = line.toLowerCase();

  return (
    /welcome everyone|today we are here|thanks everyone for coming|that concludes our debate|that concludes the proceedings|take care everyone|hope you found this interesting/.test(low) ||
    /let me introduce|before we jump into|format of the debate|opening remarks|closing remarks|moderated discussion|quick response/.test(low) ||
    /round of applause|remain respectful|reset the timer|my name is/.test(low)
  );
}

function isBadSentence(sentence) {
  const low = sentence.toLowerCase();

  if (!sentence || sentence.length < 30) return true;
  if (sentence.length > 320) return true;

  if (
    /subscribe|notification bell|share this video|my channel|our channel|patreon|podcast|sponsored/.test(low)
  ) {
    return true;
  }

  if (
    /science communicator|phd student|master'?s degree|co-author|forthcoming book|beacon towards understanding/.test(low)
  ) {
    return true;
  }

  if (
    /can you hear me|thank you so much|good to be here|thanks for having me/.test(low)
  ) {
    return true;
  }

  // reject clearly busted timestamp leftovers
  if (
    /\b\d{2,}\b/.test(low) &&
    /seconds|minutes|hour/.test(low)
  ) {
    return true;
  }

  return false;
}

function dedupe(arr) {
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

/* -------------------------------------------------------------------------- */
/* side inference                                                             */
/* -------------------------------------------------------------------------- */

function inferSideBuckets(sentences, teamAName, teamBName) {
  const teamA = [];
  const teamB = [];
  const unknown = [];

  for (const sentence of sentences) {
    const side = inferSentenceSide(sentence, teamAName, teamBName);
    if (side === "A") teamA.push(sentence);
    else if (side === "B") teamB.push(sentence);
    else unknown.push(sentence);
  }

  // if one side is starving, distribute unknown by topical balance
  if (teamA.length < 4 || teamB.length < 4) {
    const split = splitUnknownByTopic(unknown);
    if (teamA.length < 4) teamA.push(...split.a);
    if (teamB.length < 4) teamB.push(...split.b);
  }

  return {
    teamA: dedupe(teamA),
    teamB: dedupe(teamB)
  };
}

function inferSentenceSide(sentence, teamAName, teamBName) {
  const low = sentence.toLowerCase();

  if (teamAName && low.includes(teamAName.toLowerCase())) return "A";
  if (teamBName && low.includes(teamBName.toLowerCase())) return "B";

  // origin-of-life / Noble / anti-neodarwinism cluster
  if (
    /dennis noble|james shapiro|central dogma|wiseman barrier|genome reorganization|neodarwinism|modern synthesis|passive vehicle|self-replicating molecules|rna|polypeptide|mineral surfaces/.test(low)
  ) {
    return "A";
  }

  // mainstream evo / observed mechanisms cluster
  if (
    /natural selection|speciation|descent with modification|fossil record|common ancestry|antibiotic resistance|bacterial colonies|homology|transitional species|scientific facts|theories can yield facts/.test(low)
  ) {
    return "B";
  }

  // debate-control / accusing other guy of dodge or gish
  if (
    /gish gallop|i invited him to have a separate debate|i'?m going to test him on this|four pillars/.test(low)
  ) {
    return "A";
  }

  if (
    /concede the debate|never do a debate with this dumb title|factually occurs|you don't actually understand|scientific communicator worth their salt/.test(low)
  ) {
    return "B";
  }

  return "?";
}

function splitUnknownByTopic(unknown) {
  const a = [];
  const b = [];

  for (const sentence of unknown) {
    const low = sentence.toLowerCase();

    const aScore = countHits(low, [
      "noble", "shapiro", "modern synthesis", "neodarwinism", "central dogma",
      "self-replicating", "rna", "polypeptide", "mineral", "origins"
    ]);

    const bScore = countHits(low, [
      "natural selection", "common ancestry", "speciation", "fossil",
      "homology", "antibiotic", "bacterial", "transitional", "observed"
    ]);

    if (aScore > bScore) a.push(sentence);
    else if (bScore > aScore) b.push(sentence);
  }

  return { a, b };
}

/* -------------------------------------------------------------------------- */
/* analysis                                                                   */
/* -------------------------------------------------------------------------- */

function analyzeSide(sentences, sideName, otherSideName) {
  const scored = sentences.map((s) => scoreSentence(s));

  const mainCandidates = scored
    .filter((x) => x.role === "claim" || x.role === "definition")
    .sort(sortByQuality);

  const truthCandidates = scored
    .filter((x) => x.role === "support")
    .sort(sortByQuality);

  const overreachCandidates = scored
    .filter((x) => x.role === "overreach")
    .sort(sortByQuality);

  const opinionCandidates = scored
    .filter((x) => x.role === "opinion")
    .sort(sortByQuality);

  const fillerCandidates = scored
    .filter((x) => x.role === "filler")
    .sort(sortByQuality);

  const bestMain = mainCandidates[0] || truthCandidates[0] || scored[0] || null;
  const bestTruth = truthCandidates[0] || mainCandidates[0] || null;
  const bestOverreach = overreachCandidates[0] || null;
  const bestOpinion = opinionCandidates[0] || null;
  const bestFiller = fillerCandidates[0] || null;

  const lane = classifyLane(sentences);
  const integrity = classifyIntegrity(scored);
  const reasoning = classifyReasoning(scored);

  const strength =
    (bestMain ? bestMain.score : 0) +
    (bestTruth ? bestTruth.score : 0) +
    truthCandidates.length * 2;

  const overreach =
    overreachCandidates.reduce((sum, x) => sum + Math.min(5, x.score), 0);

  const fluff = fillerCandidates.length;

  return {
    sideName,
    sentences,
    bestMain,
    bestTruth,
    bestOverreach,
    bestOpinion,
    bestFiller,
    lane,
    integrity,
    reasoning,
    strength,
    overreach,
    fluff
  };
}

function scoreSentence(sentence) {
  const low = sentence.toLowerCase();

  let score = 1;
  let role = "support";

  const definitionHits = countHits(low, [
    "i define", "i am defining", "refers to", "means", "the question is",
    "the debate is", "the point is", "what i am saying is"
  ]);

  const supportHits = countHits(low, [
    "because", "therefore", "so", "since", "which means", "the reason is",
    "for example", "for instance", "according to", "study", "evidence",
    "data", "fossil", "observed", "paper", "research"
  ]);

  const overreachHits = countHits(low, [
    "always", "never", "everyone", "nobody", "obviously", "completely",
    "absolutely", "zero ability", "no ability", "all of science"
  ]);

  const opinionHits = countHits(low, [
    "i think", "i believe", "it seems", "probably", "maybe", "perhaps"
  ]);

  const fillerHits = countHits(low, [
    "thank you", "good to be here", "can you hear me", "no worries",
    "let me tell you why", "the internet has lost its mind"
  ]);

  score += definitionHits * 6;
  score += supportHits * 4;
  score += sentence.length > 70 ? 2 : 0;
  score += sentence.length > 110 ? 1 : 0;
  score -= fillerHits * 5;

  if (definitionHits > 0) role = "definition";
  if (supportHits > 1) role = "support";
  if (definitionHits > 0 && supportHits > 0) role = "claim";
  if (opinionHits > 0 && supportHits === 0) role = "opinion";
  if (overreachHits > 0) role = "overreach";
  if (fillerHits > 0) role = "filler";

  if (
    /the point is|the question is|what i am saying is|the debate is|we can observe today and then extrapolate that into the past|genesis should be read against ancient near eastern background material/.test(low)
  ) {
    role = "claim";
    score += 8;
  }

  if (
    /according to dennis noble|natural selection|speciation is evolution|we observe this repeatedly|thousands of specimens|fossil record|published in/.test(low)
  ) {
    role = "support";
    score += 7;
  }

  return {
    text: sentence,
    score,
    role
  };
}

function sortByQuality(a, b) {
  return b.score - a.score || b.text.length - a.text.length;
}

/* -------------------------------------------------------------------------- */
/* classifications                                                            */
/* -------------------------------------------------------------------------- */

function classifyLane(sentences) {
  const text = sentences.join(" ").toLowerCase();

  const scores = {
    "science / evidence lane": countHits(text, [
      "natural selection", "speciation", "fossil", "genome", "dna",
      "cell", "observed", "bacterial", "homology", "common ancestry"
    ]),
    "history / evidence lane": countHits(text, [
      "historical", "records", "document", "published", "century",
      "sources", "manuscript", "history"
    ]),
    "theology / scripture lane": countHits(text, [
      "genesis", "gospel", "scripture", "bible", "messianic", "apostles"
    ]),
    "mixed lane with overlapping frameworks": countHits(text, [
      "define", "theory", "evidence", "history", "science", "scripture"
    ])
  };

  const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ordered[0] || ordered[0][1] === 0) return "mixed / unclear lane";

  const top = ordered[0];
  const second = ordered[1];

  if (second && second[1] >= top[1] * 0.8) {
    return "mixed lane with overlapping frameworks";
  }

  return top[0];
}

function classifyIntegrity(scored) {
  const supports = scored.filter((x) => x.role === "support").length;
  const over = scored.filter((x) => x.role === "overreach").length;

  if (supports >= 3 && over <= 1) {
    return "Leans more grounded than inflated, though not every claim is equally supported.";
  }

  if (over >= 2) {
    return "Shows noticeable overreach or unsupported certainty relative to the evidence preserved.";
  }

  return "Mixed integrity profile: some grounded points, some interpretive stretch, some unresolved support gaps.";
}

function classifyReasoning(scored) {
  const claims = scored.filter((x) => x.role === "claim" || x.role === "definition").length;
  const supports = scored.filter((x) => x.role === "support").length;

  if (claims >= 1 && supports >= 2) {
    return "Strongest on explicit reasoning structure and at least some evidentiary support.";
  }

  if (supports >= 1) {
    return "Uses support language and topic engagement, though the chain from premise to conclusion is less consistent.";
  }

  return "Reasoning exists, but much of it is asserted more than fully demonstrated.";
}

/* -------------------------------------------------------------------------- */
/* verdict                                                                    */
/* -------------------------------------------------------------------------- */

function buildResult({ teamAName, teamBName, teamAClaims, teamBClaims, videoLink }) {
  const winner = decideWinner(teamAClaims, teamBClaims);
  const confidence = decideConfidence(teamAClaims, teamBClaims, winner);

  const strongest = chooseStrongest(teamAClaims, teamBClaims);
  const weakest = chooseWeakest(teamAClaims, teamBClaims);

  return enforceShape({
    teamAName,
    teamBName,
    winner,
    confidence,
    teamAScore: String(clampScore(teamAClaims.strength - teamAClaims.overreach - teamAClaims.fluff)),
    teamBScore: String(clampScore(teamBClaims.strength - teamBClaims.overreach - teamBClaims.fluff)),

    teamA: {
      main_position: buildMainPosition(teamAClaims),
      truth: buildTruth(teamAClaims),
      lies: buildLies(teamAClaims),
      opinion: buildOpinion(teamAClaims),
      lala: buildLala(teamAClaims)
    },

    teamB: {
      main_position: buildMainPosition(teamBClaims),
      truth: buildTruth(teamBClaims),
      lies: buildLies(teamBClaims),
      opinion: buildOpinion(teamBClaims),
      lala: buildLala(teamBClaims)
    },

    teamA_integrity: teamAClaims.integrity,
    teamB_integrity: teamBClaims.integrity,
    teamA_reasoning: teamAClaims.reasoning,
    teamB_reasoning: teamBClaims.reasoning,

    teamA_lane: teamAClaims.lane,
    teamB_lane: teamBClaims.lane,
    same_lane_engagement: buildSameLane(teamAClaims, teamBClaims),
    lane_mismatch: buildLaneMismatch(teamAClaims, teamBClaims),

    core_disagreement: buildCoreDisagreement(teamAClaims, teamBClaims),
    bsMeter: buildBS(teamAClaims, teamBClaims),

    strongestArgumentSide: strongest.side,
    strongestArgument: strongest.text,
    whyStrongest: strongest.why,
    failedResponseByOtherSide: strongest.failedResponse,

    weakestOverall: weakest,

    why: buildOverallWhy(winner, teamAClaims, teamBClaims),

    manipulation: buildManipulation(teamAClaims, teamBClaims),
    fluff: buildFluff(teamAClaims, teamBClaims),

    analysisMode: ANALYSIS_MODE,
    sources: buildSources(teamAClaims, teamBClaims, videoLink)
  });
}

function decideWinner(a, b) {
  const aNet = a.strength - a.overreach - a.fluff;
  const bNet = b.strength - b.overreach - b.fluff;

  if (Math.abs(aNet - bNet) <= 3) return "Mixed";
  return aNet > bNet ? a.sideName : b.sideName;
}

function decideConfidence(a, b, winner) {
  if (winner === "Mixed") return "51%";
  const diff = Math.abs((a.strength - a.overreach) - (b.strength - b.overreach));
  return String(Math.max(56, Math.min(84, 56 + diff * 2))) + "%";
}

function chooseStrongest(a, b) {
  const aBest = a.bestTruth || a.bestMain;
  const bBest = b.bestTruth || b.bestMain;

  const aScore = (aBest ? aBest.score : 0) + a.strength;
  const bScore = (bBest ? bBest.score : 0) + b.strength;

  if (!aBest && !bBest) {
    return {
      side: "Mixed",
      text: "No strongest argument could be finalized from the preserved transcript.",
      why: "The preserved material did not isolate a stable claim-and-support chain strongly enough.",
      failedResponse: "No rebuttal comparison could be finalized cleanly."
    };
  }

  if (aScore >= bScore) {
    return {
      side: a.sideName,
      text: clip(aBest.text, 240),
      why: "It stands out because it brings more actual support and it stays closer to the real dispute.",
      failedResponse: b.bestMain
        ? `${b.sideName} does not beat that point with a cleaner rival claim. Its nearest competing claim is: ${clip(b.bestMain.text, 180)}.`
        : `${b.sideName} does not preserve a cleaner competing claim against that point.`
    };
  }

  return {
    side: b.sideName,
    text: clip(bBest.text, 240),
    why: "It stands out because it explains its logic more clearly and keeps more visible support attached to the claim.",
    failedResponse: a.bestMain
      ? `${a.sideName} does not beat that point with a cleaner rival claim. Its nearest competing claim is: ${clip(a.bestMain.text, 180)}.`
      : `${a.sideName} does not preserve a cleaner competing claim against that point.`
  };
}

function chooseWeakest(a, b) {
  const aWeak = weaknessValue(a);
  const bWeak = weaknessValue(b);

  if (aWeak >= bWeak) {
    return `${a.sideName} is weakest on ${lowerFirst(clip((a.bestOverreach && a.bestOverreach.text) || buildLies(a), 180))} because it reaches past the support actually shown and leans on interpretation.`;
  }

  return `${b.sideName} is weakest on ${lowerFirst(clip((b.bestOverreach && b.bestOverreach.text) || buildLies(b), 180))} because it reaches past the support actually shown and leans on interpretation.`;
}

function weaknessValue(side) {
  return side.overreach * 2 + side.fluff + Math.max(0, 10 - side.strength);
}

function buildMainPosition(side) {
  if (side.bestMain) {
    return `${side.sideName} mainly argues that ${lowerFirst(clip(side.bestMain.text, 190))}.`;
  }
  return `${side.sideName} does not preserve a stable main position clearly enough in the submitted transcript.`;
}

function buildTruth(side) {
  if (side.bestTruth) return clip(side.bestTruth.text, 220);
  if (side.bestMain) return clip(side.bestMain.text, 220);
  return `${side.sideName} does not preserve a clean evidence sentence strongly enough to quote as grounded support.`;
}

function buildLies(side) {
  if (side.bestOverreach) return clip(side.bestOverreach.text, 220);
  return `${side.sideName} does not show one dominant overreach sentence, but some interpretive stretch may still remain.`;
}

function buildOpinion(side) {
  if (side.bestOpinion) return clip(side.bestOpinion.text, 180);
  return `${side.sideName} includes interpretive or judgment language mixed into the case.`;
}

function buildLala(side) {
  if (side.bestFiller) return clip(side.bestFiller.text, 150);
  return "Some filler remains after cleanup.";
}

function buildCoreDisagreement(a, b) {
  const aMain = a.bestMain ? a.bestMain.text : "";
  const bMain = b.bestMain ? b.bestMain.text : "";

  if (aMain && bMain && normalizeLoose(aMain) !== normalizeLoose(bMain)) {
    return `Main dispute: ${a.sideName} says ${lowerFirst(clip(aMain, 170))}, while ${b.sideName} says ${lowerFirst(clip(bMain, 170))}.`;
  }

  if (aMain || bMain) {
    return "Both sides circle the same topic, but they frame or support it differently in the preserved transcript.";
  }

  return "The transcript cleanup did not preserve a stable core claim for either side clearly enough to summarize.";
}

function buildBS(a, b) {
  if (a.overreach === b.overreach) return "Both sides show comparable overreach.";
  return a.overreach > b.overreach
    ? `${a.sideName} is reaching more`
    : `${b.sideName} is reaching more`;
}

function buildSameLane(a, b) {
  if (a.lane === b.lane) return `Both sides largely argue in the same lane: ${a.lane}.`;
  if (a.lane.includes("mixed") || b.lane.includes("mixed")) {
    return "At least one side blends lanes, so engagement is only partial rather than cleanly matched.";
  }
  return "The sides partly engage each other, but they often argue from different frameworks.";
}

function buildLaneMismatch(a, b) {
  if (a.lane === b.lane) return "Low lane mismatch. They are mostly fighting on shared ground.";
  return `Lane mismatch exists: Team A is mainly in ${a.lane}, while Team B is mainly in ${b.lane}.`;
}

function buildManipulation(a, b) {
  const aText = a.sentences.join(" ").toLowerCase();
  const bText = b.sentences.join(" ").toLowerCase();

  const aHits = countHits(aText, ["clown", "coward", "laughing at you", "shut your mouth", "dumb title"]);
  const bHits = countHits(bText, ["clown", "coward", "laughing at you", "shut your mouth", "dumb title"]);

  return `${a.sideName}: ${manipulationDesc(aHits)} ${b.sideName}: ${manipulationDesc(bHits)}`;
}

function manipulationDesc(n) {
  if (n <= 1) return "Low obvious manipulation in the preserved text.";
  if (n <= 3) return "Some rhetorical pressure appears, but it does not fully dominate the case.";
  return "Noticeable pressure language and framing tactics show up alongside the argument.";
}

function buildFluff(a, b) {
  return `${a.sideName}: ${fluffDesc(a.fluff)} ${b.sideName}: ${fluffDesc(b.fluff)}`;
}

function fluffDesc(n) {
  if (n <= 1) return "Low fluff after cleanup.";
  if (n <= 3) return "Some fluff remains, but the main claims are still identifiable.";
  return "Heavy noise remains and it obscures parts of the argument.";
}

function buildOverallWhy(winner, a, b) {
  if (winner === "Mixed") {
    return `Close call. ${a.sideName}'s clearest usable point is ${lowerFirst(clip((a.bestTruth && a.bestTruth.text) || (a.bestMain && a.bestMain.text) || "its main claim", 150))}, but it is weakened by overreach or support gaps. ${b.sideName}'s clearest usable point is ${lowerFirst(clip((b.bestTruth && b.bestTruth.text) || (b.bestMain && b.bestMain.text) || "its main claim", 150))}, but it is also weakened by overreach or support gaps.`;
  }

  const win = winner === a.sideName ? a : b;
  const lose = winner === a.sideName ? b : a;

  return `${winner} wins because its clearer usable point stays closer to the preserved dispute and carries more visible support, while ${lose.sideName} leaves more support gaps, interpretive stretch, or unresolved rebuttal weakness.`;
}

function buildSources(a, b, videoLink) {
  const out = [];

  for (const item of [a.bestTruth, a.bestMain, b.bestTruth, b.bestMain, a.bestOverreach, b.bestOverreach]) {
    if (!item) continue;

    out.push({
      claim: clip(item.text, 220),
      type:
        item.role === "overreach"
          ? "flagged-overreach"
          : item.role === "support"
          ? "supported-language"
          : "needs-review",
      confidence: "unknown",
      likely_source: videoLink || "Transcript-only analysis",
      note:
        item.role === "overreach"
          ? "Contains strong certainty or sweep language that would need outside verification."
          : "Transcript-preserved claim. Outside verification may still be required."
    });
  }

  return dedupeObjects(out).slice(0, 8);
}

function dedupeObjects(arr) {
  const out = [];
  const seen = new Set();

  for (const item of arr) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* shaping                                                                    */
/* -------------------------------------------------------------------------- */

function enforceShape(data) {
  return {
    teamAName: fallback(data.teamAName, DEFAULT_TEAM_A),
    teamBName: fallback(data.teamBName, DEFAULT_TEAM_B),
    winner: fallback(data.winner, "Mixed"),
    confidence: normalizeConfidence(data.confidence),
    teamAScore: fallback(String(data.teamAScore || ""), "50"),
    teamBScore: fallback(String(data.teamBScore || ""), "50"),

    teamA: {
      main_position: fallback(data.teamA?.main_position, `${data.teamAName || DEFAULT_TEAM_A} main position could not be preserved clearly.`),
      truth: fallback(data.teamA?.truth, "No clean truth sentence isolated."),
      lies: fallback(data.teamA?.lies, "No dominant overreach sentence isolated."),
      opinion: fallback(data.teamA?.opinion, "Interpretive language remains."),
      lala: fallback(data.teamA?.lala, "Some filler remains after cleanup.")
    },

    teamB: {
      main_position: fallback(data.teamB?.main_position, `${data.teamBName || DEFAULT_TEAM_B} main position could not be preserved clearly.`),
      truth: fallback(data.teamB?.truth, "No clean truth sentence isolated."),
      lies: fallback(data.teamB?.lies, "No dominant overreach sentence isolated."),
      opinion: fallback(data.teamB?.opinion, "Interpretive language remains."),
      lala: fallback(data.teamB?.lala, "Some filler remains after cleanup.")
    },

    teamA_integrity: fallback(data.teamA_integrity, "Mixed integrity profile."),
    teamB_integrity: fallback(data.teamB_integrity, "Mixed integrity profile."),
    teamA_reasoning: fallback(data.teamA_reasoning, "Reasoning exists, but not all of it is fully demonstrated."),
    teamB_reasoning: fallback(data.teamB_reasoning, "Reasoning exists, but not all of it is fully demonstrated."),

    teamA_lane: fallback(data.teamA_lane, "mixed / unclear lane"),
    teamB_lane: fallback(data.teamB_lane, "mixed / unclear lane"),
    same_lane_engagement: fallback(data.same_lane_engagement, "Same-lane engagement could not be finalized."),
    lane_mismatch: fallback(data.lane_mismatch, "Lane mismatch could not be finalized."),

    core_disagreement: fallback(data.core_disagreement, "The sides disagree over which core claim is better supported."),
    bsMeter: fallback(data.bsMeter, "Both sides show some degree of overreach."),
    strongestArgumentSide: fallback(data.strongestArgumentSide, "Mixed"),
    strongestArgument: fallback(data.strongestArgument, "No strongest argument could be finalized."),
    whyStrongest: fallback(data.whyStrongest, "The strongest argument is the one with the clearest logic and strongest visible support."),
    failedResponseByOtherSide: fallback(data.failedResponseByOtherSide, "The opposing side does not beat that point with a cleaner rival claim."),
    weakestOverall: fallback(data.weakestOverall, "The weakest overall point is the one with the least support and clearest interpretive stretch."),
    why: fallback(data.why, "The result comes from comparing claim clarity, support, overreach, and rebuttal strength."),

    manipulation: fallback(data.manipulation, "Manipulation is limited or not clearly dominant in the preserved transcript."),
    fluff: fallback(data.fluff, "Some fluff remains, but core claims are still visible."),

    analysisMode: fallback(data.analysisMode, ANALYSIS_MODE),
    sources: Array.isArray(data.sources) ? data.sources : []
  };
}

function buildFailureResponse({ teamAName, teamBName, message }) {
  return enforceShape({
    teamAName,
    teamBName,
    winner: "Mixed",
    confidence: "50%",
    teamAScore: "50",
    teamBScore: "50",
    teamA_lane: "mixed / unclear lane",
    teamB_lane: "mixed / unclear lane",
    core_disagreement: "The backend failed before a stable disagreement summary was built.",
    bsMeter: "Backend failure prevented a stable BS comparison.",
    strongestArgumentSide: "Mixed",
    strongestArgument: "No strongest argument could be finalized because processing failed.",
    whyStrongest: "The backend error prevented a strongest-argument comparison.",
    failedResponseByOtherSide: "The backend error prevented rebuttal comparison.",
    weakestOverall: "The backend error prevented weakest-point selection.",
    why: normalizeText(message || "Unknown backend error"),
    manipulation: "Backend failure prevented a stable manipulation read.",
    fluff: "Backend failure prevented a stable fluff read.",
    sources: []
  });
}

/* -------------------------------------------------------------------------- */
/* misc                                                                       */
/* -------------------------------------------------------------------------- */

function countHits(text, phrases) {
  let count = 0;
  for (const phrase of phrases) {
    if (String(text || "").includes(phrase)) count += 1;
  }
  return count;
}

function fallback(value, defaultValue) {
  const v = normalizeText(value);
  return v || defaultValue;
}

function lowerFirst(text) {
  const t = normalizeText(text);
  if (!t) return "";
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function clampScore(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(1, Math.min(99, Math.round(num)));
}

function normalizeConfidence(value) {
  const v = normalizeText(value);
  if (!v) return "50%";
  return v.includes("%") ? v : v + "%";
}

function normalizeLoose(text) {
  return normalizeText(text).toLowerCase().replace(/[^a-z0-9 ]/g, "");
}
