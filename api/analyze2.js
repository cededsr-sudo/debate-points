"use strict";

/**
 * /api/analyze2.js
 *
 * Full backend for the supplied frontend.
 * Self-contained. No external packages.
 * Always returns JSON.
 *
 * Contract expected by frontend:
 * POST /api/analyze2
 * body: {
 *   teamAName: string,
 *   teamBName: string,
 *   transcriptText: string,
 *   videoLink?: string
 * }
 */

const DEFAULT_TEAM_A = "Team A";
const DEFAULT_TEAM_B = "Team B";
const ANALYSIS_MODE =
  "deterministic+claim-first+speaker-segmentation+factcheck-stub+frontend-match";

module.exports = async function analyze2Handler(req, res) {
  try {
    const body = req && req.body && typeof req.body === "object" ? req.body : {};

    const requestedTeamA = cleanText(
      body.teamAName || body.teamA || body.speakerA || body.nameA || ""
    );
    const requestedTeamB = cleanText(
      body.teamBName || body.teamB || body.speakerB || body.nameB || ""
    );
    const videoLink = cleanText(body.videoLink || "");
    const transcriptRaw = getTranscriptFromBody(body);

    if (!transcriptRaw.trim()) {
      return res.json(buildErrorResponse("Paste a transcript first.", {
        teamAName: requestedTeamA || DEFAULT_TEAM_A,
        teamBName: requestedTeamB || DEFAULT_TEAM_B
      }));
    }

    const cleanedTranscript = normalizeTranscript(transcriptRaw);
    const parsed = parseTranscript(cleanedTranscript);

    const inferred = inferDebateRoles(parsed, requestedTeamA, requestedTeamB);
    const teamAName = inferred.teamAName || requestedTeamA || DEFAULT_TEAM_A;
    const teamBName = inferred.teamBName || requestedTeamB || DEFAULT_TEAM_B;

    const segmented = segmentBySide(parsed, inferred, teamAName, teamBName);

    const teamAClaims = buildClaimMap(segmented.teamA, teamAName);
    const teamBClaims = buildClaimMap(segmented.teamB, teamBName);

    const teamAAnalysis = analyzeSide(teamAClaims, teamAName, teamBName);
    const teamBAnalysis = analyzeSide(teamBClaims, teamBName, teamAName);

    const factLayer = buildFactCheckLayer(teamAAnalysis, teamBAnalysis, videoLink);
    const result = buildFrontendResult(
      teamAAnalysis,
      teamBAnalysis,
      factLayer,
      teamAName,
      teamBName
    );

    return res.json(enforceFrontendContract(result));
  } catch (err) {
    return res.json(buildErrorResponse(
      err && err.message ? err.message : "Unknown backend error",
      {}
    ));
  }
};

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
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

function cleanText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeTranscript(text) {
  let out = String(text || "");

  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Put likely timestamps on their own lines.
  out = out.replace(
    /(\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}:\d{2}:\d{2})\s*(hour|hours|minute|minutes|second|seconds)?/gi,
    "\n$&"
  );

  // Put obvious speaker labels onto fresh lines.
  out = out.replace(/\b([A-Z][a-z]+)\s*:/g, "\n$1: ");

  // Split mashed words after time labels.
  out = out
    .replace(/\bseconds([A-Z])/g, " seconds $1")
    .replace(/\bminutes([A-Z])/g, " minutes $1")
    .replace(/\bhour([A-Z])/g, " hour $1")
    .replace(/\bhours([A-Z])/g, " hours $1");

  // Reduce visual trash
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return out;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

function parseTranscript(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const chunks = [];
  let current = { timestamp: "", text: "" };

  for (const line of lines) {
    if (looksLikeTimestampLine(line)) {
      if (current.text.trim()) {
        chunks.push(finalizeChunk(current));
      }
      current = { timestamp: extractTimestamp(line), text: stripTimestamp(line) };
      continue;
    }

    if (!current.text) {
      current.text = line;
    } else {
      current.text += " " + line;
    }
  }

  if (current.text.trim()) {
    chunks.push(finalizeChunk(current));
  }

  if (!chunks.length) {
    return [{ timestamp: "", text: cleanText(text), raw: cleanText(text) }];
  }

  return chunks;
}

function looksLikeTimestampLine(line) {
  return /^(\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}:\d{2}:\d{2})\b/.test(line);
}

function extractTimestamp(line) {
  const m = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}:\d{2}:\d{2})\b/);
  return m ? m[1] : "";
}

function stripTimestamp(line) {
  return cleanText(
    String(line || "")
      .replace(/^(\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}:\d{2}:\d{2})\b/, "")
      .replace(/^\s*(hour|hours|minute|minutes|second|seconds)[^a-zA-Z]*/i, "")
  );
}

function finalizeChunk(chunk) {
  const text = cleanText(chunk.text || "");
  return {
    timestamp: chunk.timestamp || "",
    text,
    raw: text
  };
}

/* -------------------------------------------------------------------------- */
/* Role inference                                                             */
/* -------------------------------------------------------------------------- */

function inferDebateRoles(chunks, requestedA, requestedB) {
  const whole = chunks.map((c) => c.text).join(" ");

  let moderator = "";
  let teamA = requestedA || "";
  let teamB = requestedB || "";

  const modMatch = whole.match(/my name is ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (modMatch) moderator = cleanPersonName(modMatch[1]);

  const negMatch = whole.match(/speaking for the negative[, ]+we have ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const affMatch = whole.match(/speaking for the affirmative(?: today)?[, ]+is ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);

  if (!teamA && negMatch) teamA = cleanPersonName(negMatch[1]);
  if (!teamB && affMatch) teamB = cleanPersonName(affMatch[1]);

  if (!teamA || !teamB) {
    const discovered = inferByOpeningTransitions(chunks);
    if (!teamA && discovered.teamA) teamA = discovered.teamA;
    if (!teamB && discovered.teamB) teamB = discovered.teamB;
  }

  return {
    moderator: moderator || "Moderator",
    teamAName: teamA || DEFAULT_TEAM_A,
    teamBName: teamB || DEFAULT_TEAM_B
  };
}

function cleanPersonName(name) {
  return cleanText(String(name || "").replace(/[^A-Za-z\s'-]/g, ""));
}

function inferByOpeningTransitions(chunks) {
  const joined = chunks.map((c) => c.text).join(" ");

  let teamA = "";
  let teamB = "";

  const passMatch = joined.match(/pass over to ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (passMatch) teamA = cleanPersonName(passMatch[1]);

  const daveOpen = joined.match(/we now have 20 minutes for ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (daveOpen) teamB = cleanPersonName(daveOpen[1]);

  return { teamA, teamB };
}

/* -------------------------------------------------------------------------- */
/* Segmentation                                                               */
/* -------------------------------------------------------------------------- */

function segmentBySide(chunks, inferred, teamAName, teamBName) {
  const teamA = [];
  const teamB = [];
  const moderator = [];
  const unknown = [];

  let phase = "intro";
  let activeSpeaker = "moderator";

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i].text;
    const low = text.toLowerCase();

    if (isModeratorFormatChunk(low)) {
      moderator.push(chunks[i]);
      if (/pass over to|opening remarks|give .* opening remarks/.test(low)) {
        phase = "teamA_opening";
        activeSpeaker = "teamA";
      }
      if (/we now have 20 minutes for|dave to present his opening remarks|reset the timer/.test(low)) {
        phase = "teamB_opening";
        activeSpeaker = "teamB";
      }
      if (/30 minutes of open discussion|moderated discussion|quick response from/.test(low)) {
        phase = "discussion";
        activeSpeaker = "unknown";
      }
      if (/closing remarks|concluding summary/.test(low)) {
        phase = "closing";
        activeSpeaker = "unknown";
      }
      continue;
    }

    if (looksLikeIntroBio(low)) {
      moderator.push(chunks[i]);
      continue;
    }

    if (phase === "teamA_opening") {
      if (/all right\. so, this is supposed to be a debate|this is supposed to be a debate about evolution|first, let'?s talk/i.test(text)) {
        phase = "teamB_opening";
        activeSpeaker = "teamB";
      }
    }

    if (phase === "discussion" || phase === "closing" || phase === "unknown") {
      const who = inferSpeakerFromChunk(text, teamAName, teamBName);
      if (who === "teamA") {
        teamA.push(chunks[i]);
      } else if (who === "teamB") {
        teamB.push(chunks[i]);
      } else {
        unknown.push(chunks[i]);
      }
      continue;
    }

    if (activeSpeaker === "teamA") {
      teamA.push(chunks[i]);
      continue;
    }

    if (activeSpeaker === "teamB") {
      teamB.push(chunks[i]);
      continue;
    }

    unknown.push(chunks[i]);
  }

  // If one side is too small, use fallback split from discussion/unknown.
  if (teamA.length < 3 || teamB.length < 3) {
    const fallback = fallbackSpeakerDistribution(chunks, teamAName, teamBName);
    if (teamA.length < 3) teamA.push(...fallback.teamA);
    if (teamB.length < 3) teamB.push(...fallback.teamB);
  }

  return {
    teamA: dedupeChunks(teamA),
    teamB: dedupeChunks(teamB),
    moderator: dedupeChunks(moderator),
    unknown: dedupeChunks(unknown)
  };
}

function isModeratorFormatChunk(low) {
  return (
    /welcome everyone|today we are here for the debate|let me just introduce|before we jump into the debate|format of the debate|i'll pass over to|that concludes|we now have \d+ minutes|quick response|all right, gentlemen|sorry gentlemen|remain respectful|time limits/.test(low)
  );
}

function looksLikeIntroBio(low) {
  return (
    /phd student|master'?s degree|science communicator|youtube channel|podcast|speaking for the negative|speaking for the affirmative|co-author|forthcoming book|channel is primarily|hopes to serve as a beacon/.test(low)
  );
}

function inferSpeakerFromChunk(text, teamAName, teamBName) {
  const low = text.toLowerCase();

  if (new RegExp("\\b" + escapeRegExp(teamAName.toLowerCase()) + "\\b").test(low)) {
    if (/i defined|i am defining|according to dennis noble|noble|neodarwinism|modern synthesis|wiseman barrier|genome reorganization/.test(low)) {
      return "teamA";
    }
  }

  if (new RegExp("\\b" + escapeRegExp(teamBName.toLowerCase()) + "\\b").test(low)) {
    if (/darwinian evolution|factually occurs|natural selection|scientific facts|theories can yield facts|descent with modification/.test(low)) {
      return "teamB";
    }
  }

  if (/according to dennis noble|the four pillars|wiseman barrier|central dogma|genome reorganization|dance to the tune of life|oneeyed watchmaker|neodarwinism/.test(low)) {
    return "teamA";
  }

  if (/darwinian evolution refers to|descent with modification|natural selection|scientific facts are|theories can yield facts|evolution by darwinian mechanisms|mutations in bacteria producing antibiotic resistance/.test(low)) {
    return "teamB";
  }

  if (/you titled the debate|everyone is laughing at you|shut your mouth|you got mad at me/.test(low)) {
    return "teamB";
  }

  if (/i invited him to have a separate debate|gish gallop|i'm going to test him on this|fina has a dilemma/.test(low)) {
    return "teamA";
  }

  return "unknown";
}

function fallbackSpeakerDistribution(chunks, teamAName, teamBName) {
  const teamA = [];
  const teamB = [];

  for (const chunk of chunks) {
    const low = chunk.text.toLowerCase();

    if (looksLikeIntroBio(low) || isModeratorFormatChunk(low)) continue;

    const who = inferSpeakerFromChunk(chunk.text, teamAName, teamBName);
    if (who === "teamA") teamA.push(chunk);
    if (who === "teamB") teamB.push(chunk);
  }

  return { teamA: dedupeChunks(teamA), teamB: dedupeChunks(teamB) };
}

function dedupeChunks(chunks) {
  const seen = new Set();
  const out = [];

  for (const chunk of chunks) {
    const key = cleanText(chunk.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(chunk);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Claim map                                                                  */
/* -------------------------------------------------------------------------- */

function buildClaimMap(chunks, sideName) {
  const joined = chunks.map((c) => c.text).join(" ");
  const sentences = splitIntoSentences(joined)
    .map(cleanSentence)
    .filter(Boolean)
    .filter((s) => !isGarbageSentence(s));

  const enriched = sentences.map((s) => enrichSentence(s, sideName));

  const mainClaims = enriched
    .filter((x) => x.kind === "main" || x.kind === "definition")
    .sort((a, b) => b.score - a.score);

  const supportClaims = enriched
    .filter((x) => x.kind === "support")
    .sort((a, b) => b.score - a.score);

  const overreachClaims = enriched
    .filter((x) => x.kind === "overreach")
    .sort((a, b) => b.score - a.score);

  const opinionClaims = enriched
    .filter((x) => x.kind === "opinion")
    .sort((a, b) => b.score - a.score);

  const fillerClaims = enriched
    .filter((x) => x.kind === "filler")
    .sort((a, b) => b.score - a.score);

  const bestMain = mainClaims[0] || supportClaims[0] || opinionClaims[0] || fillerClaims[0] || null;
  const bestSupport = supportClaims[0] || mainClaims[0] || null;
  const worstOverreach = overreachClaims[0] || null;

  return {
    sideName,
    sentences: enriched,
    bestMain,
    bestSupport,
    worstOverreach,
    mainClaims,
    supportClaims,
    overreachClaims,
    opinionClaims,
    fillerClaims,
    lane: classifyLane(enriched),
    topicVector: buildTopicVector(enriched)
  };
}

function splitIntoSentences(text) {
  let t = String(text || "");

  t = t
    .replace(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g, ". ")
    .replace(/\?+/g, "? ")
    .replace(/!+/g, "! ")
    .replace(/\.\s+/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const rough = t
    .split(/(?<=[\.\?\!])\s+|;\s+|\s+-\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (rough.length > 1) return rough;

  return t.split(/,\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
}

function cleanSentence(s) {
  return cleanText(
    String(s || "")
      .replace(/^\W+/, "")
      .replace(/\W+$/, "")
      .replace(/\s+,/g, ",")
      .replace(/\s+\./g, ".")
  );
}

function isGarbageSentence(s) {
  const low = s.toLowerCase();

  if (!s || s.length < 25) return true;
  if (s.length > 350) return true;

  if (
    /welcome everyone|today we are here|my name is|let me just introduce|before we jump into|format of the debate|remain respectful|can you hear me|no worries|let me reset the timer|thanks everyone for coming/.test(low)
  ) {
    return true;
  }

  if (
    /youtube channel|science podcast|phd student|master'?s degree|co-author|forthcoming book|science of everything|beacon towards/.test(low)
  ) {
    return true;
  }

  if (/sorry gentlemen|all right gentlemen|closing remarks|concluding summary/.test(low)) {
    return true;
  }

  return false;
}

function enrichSentence(sentence, sideName) {
  const low = sentence.toLowerCase();
  let score = 0;
  let kind = "support";

  // Positive scoring
  if (/i define|i am defining|refers to|means|the point is|the question before us|the dilemma is|the simple point|the nature of their debate|i'm talking about/.test(low)) score += 10;
  if (/because|therefore|thus|so that|which means|the reason is|hence|according to/.test(low)) score += 8;
  if (/paper|book|nature|cambridge|oxford|royal society|nobel prize|published|debate|evidence|fossil record|antibiotic resistance|observ(e|ed)|example|study/.test(low)) score += 8;
  if (/central dogma|wiseman barrier|randomness|passive vehicle|genome reorganization|natural selection|descent with modification|scientific facts|theories can yield facts|common ancestry/.test(low)) score += 8;
  if (/\b(first|second|third|fourth)\b/.test(low)) score += 3;

  // Negative scoring
  if (/shut your mouth|everyone is laughing at you|coward|clown|aggressive|domesticated|neutered/.test(low)) score -= 12;
  if (/what are you talking about|how insane is that|that's ridiculous/.test(low)) score -= 6;
  if (/i hope|i'm looking forward|thank you|no worries/.test(low)) score -= 6;

  if (/i define|i am defining|refers to|means|the question before us|darwinian evolution refers to/.test(low)) {
    kind = "definition";
    score += 6;
  }

  if (/because|therefore|the reason|which means|evidence|paper|published|study|observed|fossil record|antibiotic resistance|nobel prize/.test(low)) {
    kind = "support";
  }

  if (/the point is|the simple point|the dilemma is|the nature of their debate|what can you do with all of this/.test(low)) {
    kind = "main";
    score += 7;
  }

  if (/clown|coward|laughing at you|absurd|primitive understanding|incompetent|misrepresents|lying|misleading people/.test(low)) {
    kind = "overreach";
    score += 5;
  }

  if (/i think|i believe|i doubt|likely|probably|it seems|appears/.test(low)) {
    kind = "opinion";
  }

  if (/thank you|can you hear me|one minute reminder|no worries|thanks everyone|closing remarks|open discussion/.test(low)) {
    kind = "filler";
    score -= 10;
  }

  if (score < 1) score = 1;

  return {
    text: sentence,
    low,
    score,
    kind
  };
}

/* -------------------------------------------------------------------------- */
/* Side analysis                                                              */
/* -------------------------------------------------------------------------- */

function analyzeSide(claimMap, sideName, otherSideName) {
  const main = claimMap.bestMain ? claimMap.bestMain.text : "";
  const support = claimMap.bestSupport ? claimMap.bestSupport.text : "";
  const overreach = claimMap.worstOverreach ? claimMap.worstOverreach.text : "";
  const opinion = pickOpinionSentence(claimMap);
  const filler = pickFillerSentence(claimMap);

  const integrity = buildIntegrity(claimMap);
  const reasoning = buildReasoning(claimMap);

  const strengthScore = scoreStrength(claimMap);
  const overreachScore = scoreOverreach(claimMap);
  const fluffScore = scoreFluff(claimMap);

  return {
    sideName,
    team: {
      main_position: sanitizeForOutput(
        summarizeMainPosition(main, support, sideName)
      ),
      truth: sanitizeForOutput(
        summarizeTruth(support, main, sideName)
      ),
      lies: sanitizeForOutput(
        summarizeOverreach(overreach, sideName)
      ),
      opinion: sanitizeForOutput(
        opinion || `${sideName} includes interpretive or judgment language mixed into the case.`
      ),
      lala: sanitizeForOutput(
        filler || "Some filler remains after cleanup."
      )
    },
    integrity,
    reasoning,
    lane: claimMap.lane,
    strengthScore,
    overreachScore,
    fluffScore,
    bestSentence: main || support || "",
    bestSupport: support || main || "",
    weakestSentence: overreach || opinion || filler || "",
    topicVector: claimMap.topicVector,
    claimMap
  };
}

function summarizeMainPosition(main, support, sideName) {
  const source = main || support;
  if (!source) {
    return `${sideName} does not preserve a stable main position clearly enough in the submitted transcript.`;
  }

  const short = clipSentence(source, 190);
  if (/^team /i.test(short)) return short;
  return `${sideName} mainly argues that ${lowerFirst(short)}.`;
}

function summarizeTruth(support, main, sideName) {
  const source = support || main;
  if (!source) {
    return `${sideName} does not preserve a clean evidence sentence strongly enough to quote as grounded support.`;
  }
  return clipSentence(source, 220);
}

function summarizeOverreach(overreach, sideName) {
  if (!overreach) {
    return `${sideName} does not show one dominant overreach sentence, but some interpretive stretch may still remain.`;
  }
  return clipSentence(overreach, 220);
}

function pickOpinionSentence(claimMap) {
  const item = claimMap.opinionClaims[0];
  if (!item) return "";
  return clipSentence(item.text, 180);
}

function pickFillerSentence(claimMap) {
  const item = claimMap.fillerClaims[0];
  if (!item) return "Some filler remains after cleanup.";
  return clipSentence(item.text, 160);
}

function buildIntegrity(claimMap) {
  const over = scoreOverreach(claimMap);
  const support = claimMap.supportClaims.length;

  if (support >= 3 && over <= 4) {
    return "Leans more grounded than inflated, though not every claim is equally supported.";
  }

  if (over >= 8) {
    return "Shows noticeable overreach or unsupported certainty relative to the evidence preserved.";
  }

  return "Mixed integrity profile: some grounded points, some interpretive stretch, some unresolved support gaps.";
}

function buildReasoning(claimMap) {
  const defs = claimMap.mainClaims.filter((c) => c.kind === "definition").length;
  const supports = claimMap.supportClaims.length;

  if (defs >= 1 && supports >= 3) {
    return "Strongest on explicit reasoning structure and at least some evidentiary support.";
  }

  if (supports >= 1) {
    return "Uses support language and topic engagement, though the chain from premise to conclusion is less consistent.";
  }

  return "Reasoning exists, but much of it is asserted more than fully demonstrated.";
}

function scoreStrength(claimMap) {
  const main = claimMap.bestMain ? claimMap.bestMain.score : 0;
  const support = claimMap.bestSupport ? claimMap.bestSupport.score : 0;
  return main + support + claimMap.supportClaims.length * 2;
}

function scoreOverreach(claimMap) {
  return claimMap.overreachClaims.reduce((sum, x) => sum + Math.min(5, x.score), 0);
}

function scoreFluff(claimMap) {
  return claimMap.fillerClaims.length + Math.max(0, claimMap.sentences.length < 4 ? 2 : 0);
}

/* -------------------------------------------------------------------------- */
/* Verdict                                                                    */
/* -------------------------------------------------------------------------- */

function buildFrontendResult(teamA, teamB, factLayer, teamAName, teamBName) {
  const winner = decideWinner(teamA, teamB);
  const confidence = decideConfidence(teamA, teamB, winner);
  const strongest = chooseStrongest(teamA, teamB);
  const weakest = chooseWeakest(teamA, teamB);

  const sameLane = buildSameLaneEngagement(teamA.lane, teamB.lane);
  const laneMismatch = buildLaneMismatch(teamA.lane, teamB.lane);

  return {
    teamAName,
    teamBName,
    winner,
    confidence,
    teamAScore: String(normalizeDisplayScore(teamA.strengthScore)),
    teamBScore: String(normalizeDisplayScore(teamB.strengthScore)),

    teamA: teamA.team,
    teamB: teamB.team,

    teamA_integrity: teamA.integrity,
    teamB_integrity: teamB.integrity,
    teamA_reasoning: teamA.reasoning,
    teamB_reasoning: teamB.reasoning,

    teamA_lane: teamA.lane,
    teamB_lane: teamB.lane,
    same_lane_engagement: sameLane,
    lane_mismatch: laneMismatch,

    strongestArgumentSide: strongest.side,
    strongestArgument: strongest.text,
    whyStrongest: strongest.why,
    failedResponseByOtherSide: strongest.failedResponse,

    weakestOverall: weakest.text,

    bsMeter: buildBSMeter(teamA, teamB),
    manipulation: buildManipulation(teamA, teamB),
    fluff: buildFluff(teamA, teamB),

    core_disagreement: buildCoreDisagreement(teamA, teamB),
    why: buildOverallWhy(winner, teamA, teamB),

    analysisMode: ANALYSIS_MODE,
    sources: factLayer.sources
  };
}

function decideWinner(teamA, teamB) {
  const a = teamA.strengthScore - teamA.overreachScore - teamA.fluffScore;
  const b = teamB.strengthScore - teamB.overreachScore - teamB.fluffScore;
  const diff = a - b;

  if (Math.abs(diff) <= 3) return "Mixed";
  return diff > 0 ? teamA.sideName : teamB.sideName;
}

function decideConfidence(teamA, teamB, winner) {
  if (winner === "Mixed") return "51%";
  const a = teamA.strengthScore - teamA.overreachScore - teamA.fluffScore;
  const b = teamB.strengthScore - teamB.overreachScore - teamB.fluffScore;
  const diff = Math.abs(a - b);
  const base = Math.min(82, 56 + diff * 2);
  return String(base) + "%";
}

function chooseStrongest(teamA, teamB) {
  const aText = teamA.bestSupport || teamA.bestSentence;
  const bText = teamB.bestSupport || teamB.bestSentence;

  const aScore = (teamA.claimMap.bestSupport ? teamA.claimMap.bestSupport.score : 0) + teamA.strengthScore;
  const bScore = (teamB.claimMap.bestSupport ? teamB.claimMap.bestSupport.score : 0) + teamB.strengthScore;

  if (!aText && !bText) {
    return {
      side: "Mixed",
      text: "No stable strongest argument could be finalized from the preserved transcript.",
      why: "The preserved material does not isolate a clear claim-and-support chain strongly enough.",
      failedResponse: "No clean strongest-point rebuttal comparison could be finalized."
    };
  }

  if (aScore >= bScore) {
    return {
      side: teamA.sideName,
      text: clipSentence(aText, 240),
      why: "It stands out because it brings more actual support and it stays closer to the real dispute.",
      failedResponse: buildFailedResponse(teamA, teamB)
    };
  }

  return {
    side: teamB.sideName,
    text: clipSentence(bText, 240),
    why: "It stands out because it explains its logic more clearly and preserves more visible support.",
    failedResponse: buildFailedResponse(teamB, teamA)
  };
}

function chooseWeakest(teamA, teamB) {
  const aWeak = weaknessValue(teamA);
  const bWeak = weaknessValue(teamB);

  if (aWeak >= bWeak) {
    return `${teamA.sideName} is weakest on ${lowerFirst(clipSentence(teamA.weakestSentence || teamA.team.lies, 210))} because it reaches past the support actually shown and it leans on interpretation.`;
  }

  return `${teamB.sideName} is weakest on ${lowerFirst(clipSentence(teamB.weakestSentence || teamB.team.lies, 210))} because it reaches past the support actually shown and it leans on interpretation.`;
}

function weaknessValue(team) {
  return team.overreachScore * 2 + team.fluffScore + Math.max(0, 12 - team.strengthScore);
}

function buildFailedResponse(winnerSide, loserSide) {
  const winnerMain = stripPrefix(winnerSide.bestSentence);
  const loserMain = stripPrefix(loserSide.bestSentence);

  if (!winnerMain) {
    return `${loserSide.sideName} does not clearly beat the strongest preserved point.`;
  }

  if (!loserMain) {
    return `${loserSide.sideName} does not preserve a cleaner rival claim against that point.`;
  }

  return `${loserSide.sideName} does not beat that point with a cleaner rival claim. Its nearest competing claim is: ${clipSentence(loserMain, 180)}.`;
}

function buildCoreDisagreement(teamA, teamB) {
  const a = stripPrefix(teamA.bestSentence);
  const b = stripPrefix(teamB.bestSentence);

  if (!a && !b) {
    return "Main dispute: the transcript cleanup did not preserve a stable core claim for either side clearly enough to summarize.";
  }

  if (a && b && normalizeLoose(a) !== normalizeLoose(b)) {
    return `Main dispute: ${teamA.sideName} says ${lowerFirst(clipSentence(a, 180))}, while ${teamB.sideName} says ${lowerFirst(clipSentence(b, 180))}.`;
  }

  return "Main dispute: both sides circle the same topic, but they frame or support it differently in the preserved transcript.";
}

function buildOverallWhy(winner, teamA, teamB) {
  if (winner === "Mixed") {
    return `Close call. ${teamA.sideName}'s clearest usable point is ${lowerFirst(clipSentence(stripPrefix(teamA.bestSentence), 160))}, but it is weakened because it overstates the case and it leans on interpretation. ${teamB.sideName}'s clearest usable point is ${lowerFirst(clipSentence(stripPrefix(teamB.bestSentence), 160))}, but it is weakened because it overstates the case and it leans on interpretation.`;
  }

  const win = winner === teamA.sideName ? teamA : teamB;
  const lose = winner === teamA.sideName ? teamB : teamA;

  return `${winner} wins because its clearer usable point stays closer to the preserved dispute and carries more visible support, while ${lose.sideName} leaves more support gaps, interpretive stretch, or unresolved rebuttal weakness.`;
}

function buildBSMeter(teamA, teamB) {
  if (teamA.overreachScore === teamB.overreachScore) {
    return "Both sides show comparable overreach.";
  }
  return teamA.overreachScore > teamB.overreachScore
    ? `${teamA.sideName} is reaching more`
    : `${teamB.sideName} is reaching more`;
}

function buildManipulation(teamA, teamB) {
  const a = countManipulation(teamA.claimMap.sentences);
  const b = countManipulation(teamB.claimMap.sentences);

  if (a === 0 && b === 0) {
    return "Low obvious manipulation in the preserved text for both sides.";
  }

  return `${teamA.sideName}: ${describeManipulationCount(a)} ${teamB.sideName}: ${describeManipulationCount(b)}`;
}

function buildFluff(teamA, teamB) {
  return `${teamA.sideName}: ${describeFluff(teamA.fluffScore)} ${teamB.sideName}: ${describeFluff(teamB.fluffScore)}`;
}

function describeManipulationCount(n) {
  if (n <= 1) return "Low obvious manipulation in the preserved text.";
  if (n <= 3) return "Some rhetorical pressure appears, but it does not fully dominate the case.";
  return "Noticeable pressure language and framing tactics show up alongside the argument.";
}

function describeFluff(n) {
  if (n <= 1) return "Low fluff after cleanup.";
  if (n <= 3) return "Some fluff remains, but the main claims are still identifiable.";
  return "Heavy noise remains and it obscures parts of the argument.";
}

/* -------------------------------------------------------------------------- */
/* Lane + topics                                                              */
/* -------------------------------------------------------------------------- */

function classifyLane(enriched) {
  const text = enriched.map((x) => x.low).join(" ");

  const scores = {
    "science / evidence lane": countMatches(text, [
      "evolution", "natural selection", "dna", "genome", "cell", "mutation",
      "antibiotic", "fossil", "biology", "scientific", "paper", "nature"
    ]),
    "history / evidence lane": countMatches(text, [
      "history", "historical", "timeline", "century", "published", "book",
      "royal society", "1942", "1962", "oxford", "cambridge"
    ]),
    "theology / scripture lane": countMatches(text, [
      "genesis", "scripture", "theological", "gospels", "bible", "apostles",
      "messianic", "ancient near eastern"
    ]),
    "philosophy / logic lane": countMatches(text, [
      "causality", "theory", "fact", "logic", "aristotle", "dilemma",
      "epistemology", "define"
    ])
  };

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  const second = entries[1];

  if (!top || top[1] <= 1) return "mixed / unclear lane";
  if (second && second[1] >= top[1] * 0.7) return "mixed lane with overlapping frameworks";
  return top[0];
}

function buildTopicVector(enriched) {
  const text = enriched.map((x) => x.low).join(" ");
  const topics = [];

  maybePushTopic(text, topics, "evolution");
  maybePushTopic(text, topics, "natural selection");
  maybePushTopic(text, topics, "genome reorganization");
  maybePushTopic(text, topics, "dennis noble");
  maybePushTopic(text, topics, "darwinian evolution");
  maybePushTopic(text, topics, "common ancestry");
  maybePushTopic(text, topics, "genesis");
  maybePushTopic(text, topics, "historical evidence");
  maybePushTopic(text, topics, "scientific fact");
  maybePushTopic(text, topics, "causality");

  return topics;
}

function maybePushTopic(text, topics, topic) {
  if (text.includes(topic)) topics.push(topic);
}

function buildSameLaneEngagement(aLane, bLane) {
  if (aLane === bLane) {
    return `Both sides largely argue in the same lane: ${aLane}.`;
  }

  if (String(aLane).includes("mixed") || String(bLane).includes("mixed")) {
    return "At least one side blends lanes, so engagement is only partial rather than cleanly matched.";
  }

  return "The sides partly engage each other, but they often argue from different frameworks.";
}

function buildLaneMismatch(aLane, bLane) {
  if (aLane === bLane) {
    return "Low lane mismatch. They are mostly fighting on shared ground.";
  }
  return `Lane mismatch exists: Team A is mainly in ${aLane}, while Team B is mainly in ${bLane}.`;
}

/* -------------------------------------------------------------------------- */
/* Fact-check stub                                                            */
/* -------------------------------------------------------------------------- */

function buildFactCheckLayer(teamA, teamB, videoLink) {
  const claims = [];

  addSourceClaims(claims, teamA.sideName, teamA.claimMap.supportClaims.slice(0, 3), videoLink);
  addSourceClaims(claims, teamB.sideName, teamB.claimMap.supportClaims.slice(0, 3), videoLink);
  addSourceClaims(claims, teamA.sideName, teamA.claimMap.overreachClaims.slice(0, 2), videoLink, true);
  addSourceClaims(claims, teamB.sideName, teamB.claimMap.overreachClaims.slice(0, 2), videoLink, true);

  return { sources: claims.slice(0, 8) };
}

function addSourceClaims(out, sideName, items, videoLink, flagged) {
  for (const item of items || []) {
    out.push({
      claim: `${sideName}: ${clipSentence(item.text, 220)}`,
      type: flagged ? "flagged-overreach" : "supported-language",
      confidence: "unknown",
      likely_source: videoLink || "Transcript-only analysis",
      note: flagged
        ? "Contains strong certainty or sweep language that would need outside verification."
        : "Uses evidence-oriented language, but outside verification is still required."
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Output sanitation                                                          */
/* -------------------------------------------------------------------------- */

function enforceFrontendContract(result) {
  const safe = JSON.parse(JSON.stringify(result || {}));

  safe.teamAName = meaningful(safe.teamAName, DEFAULT_TEAM_A);
  safe.teamBName = meaningful(safe.teamBName, DEFAULT_TEAM_B);
  safe.winner = meaningful(safe.winner, "Mixed");
  safe.confidence = normalizeConfidence(safe.confidence);
  safe.teamAScore = meaningful(String(safe.teamAScore || ""), "50");
  safe.teamBScore = meaningful(String(safe.teamBScore || ""), "50");

  safe.teamA = safe.teamA || {};
  safe.teamB = safe.teamB || {};

  safe.teamA.main_position = meaningful(sanitizeForOutput(safe.teamA.main_position), `${safe.teamAName} main position could not be preserved clearly.`);
  safe.teamA.truth = meaningful(sanitizeForOutput(safe.teamA.truth), `${safe.teamAName} truth lane was not isolated cleanly.`);
  safe.teamA.lies = meaningful(sanitizeForOutput(safe.teamA.lies), `${safe.teamAName} overreach lane was not isolated cleanly.`);
  safe.teamA.opinion = meaningful(sanitizeForOutput(safe.teamA.opinion), `${safe.teamAName} opinion lane was not isolated cleanly.`);
  safe.teamA.lala = meaningful(sanitizeForOutput(safe.teamA.lala), "Some filler remains after cleanup.");

  safe.teamB.main_position = meaningful(sanitizeForOutput(safe.teamB.main_position), `${safe.teamBName} main position could not be preserved clearly.`);
  safe.teamB.truth = meaningful(sanitizeForOutput(safe.teamB.truth), `${safe.teamBName} truth lane was not isolated cleanly.`);
  safe.teamB.lies = meaningful(sanitizeForOutput(safe.teamB.lies), `${safe.teamBName} overreach lane was not isolated cleanly.`);
  safe.teamB.opinion = meaningful(sanitizeForOutput(safe.teamB.opinion), `${safe.teamBName} opinion lane was not isolated cleanly.`);
  safe.teamB.lala = meaningful(sanitizeForOutput(safe.teamB.lala), "Some filler remains after cleanup.");

  safe.teamA_integrity = meaningful(sanitizeForOutput(safe.teamA_integrity), "Mixed integrity profile.");
  safe.teamB_integrity = meaningful(sanitizeForOutput(safe.teamB_integrity), "Mixed integrity profile.");
  safe.teamA_reasoning = meaningful(sanitizeForOutput(safe.teamA_reasoning), "Reasoning exists, but not all of it is fully demonstrated.");
  safe.teamB_reasoning = meaningful(sanitizeForOutput(safe.teamB_reasoning), "Reasoning exists, but not all of it is fully demonstrated.");

  safe.teamA_lane = meaningful(sanitizeForOutput(safe.teamA_lane), "mixed / unclear lane");
  safe.teamB_lane = meaningful(sanitizeForOutput(safe.teamB_lane), "mixed / unclear lane");
  safe.same_lane_engagement = meaningful(sanitizeForOutput(safe.same_lane_engagement), "Same-lane engagement could not be finalized.");
  safe.lane_mismatch = meaningful(sanitizeForOutput(safe.lane_mismatch), "Lane mismatch could not be finalized.");

  safe.strongestArgumentSide = meaningful(sanitizeForOutput(safe.strongestArgumentSide), "Mixed");
  safe.strongestArgument = meaningful(sanitizeForOutput(safe.strongestArgument), "No stable strongest argument could be finalized.");
  safe.whyStrongest = meaningful(sanitizeForOutput(safe.whyStrongest), "The strongest argument is the one with the clearest logic and strongest visible support.");
  safe.failedResponseByOtherSide = meaningful(sanitizeForOutput(safe.failedResponseByOtherSide), "The opposing side does not beat that point with a cleaner rival claim.");
  safe.weakestOverall = meaningful(sanitizeForOutput(safe.weakestOverall), "The weakest overall point is the one with the least support and clearest interpretive stretch.");

  safe.bsMeter = meaningful(sanitizeForOutput(safe.bsMeter), "Both sides show some degree of overreach.");
  safe.manipulation = meaningful(sanitizeForOutput(safe.manipulation), "Manipulation is limited or not clearly dominant in the preserved transcript.");
  safe.fluff = meaningful(sanitizeForOutput(safe.fluff), "Some fluff remains, but core claims are still visible.");

  safe.core_disagreement = meaningful(sanitizeForOutput(safe.core_disagreement), "The sides disagree over which core claim is better supported.");
  safe.why = meaningful(sanitizeForOutput(safe.why), "The result comes from comparing claim clarity, support, overreach, and rebuttal strength.");

  safe.analysisMode = meaningful(safe.analysisMode, ANALYSIS_MODE);
  safe.sources = Array.isArray(safe.sources) ? safe.sources : [];

  return {
    teamAName: safe.teamAName,
    teamBName: safe.teamBName,
    winner: safe.winner,
    confidence: safe.confidence,
    teamAScore: safe.teamAScore,
    teamBScore: safe.teamBScore,

    teamA: {
      main_position: safe.teamA.main_position,
      truth: safe.teamA.truth,
      lies: safe.teamA.lies,
      opinion: safe.teamA.opinion,
      lala: safe.teamA.lala
    },
    teamB: {
      main_position: safe.teamB.main_position,
      truth: safe.teamB.truth,
      lies: safe.teamB.lies,
      opinion: safe.teamB.opinion,
      lala: safe.teamB.lala
    },

    teamA_integrity: safe.teamA_integrity,
    teamB_integrity: safe.teamB_integrity,
    teamA_reasoning: safe.teamA_reasoning,
    teamB_reasoning: safe.teamB_reasoning,

    teamA_lane: safe.teamA_lane,
    teamB_lane: safe.teamB_lane,
    same_lane_engagement: safe.same_lane_engagement,
    lane_mismatch: safe.lane_mismatch,

    strongestArgumentSide: safe.strongestArgumentSide,
    strongestArgument: safe.strongestArgument,
    whyStrongest: safe.whyStrongest,
    failedResponseByOtherSide: safe.failedResponseByOtherSide,
    weakestOverall: safe.weakestOverall,

    bsMeter: safe.bsMeter,
    manipulation: safe.manipulation,
    fluff: safe.fluff,

    core_disagreement: safe.core_disagreement,
    why: safe.why,

    analysisMode: safe.analysisMode,
    sources: safe.sources
  };
}

function sanitizeForOutput(value) {
  let text = cleanText(value);

  if (!text) return "";

  text = text
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\s*hours?,?\s*\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?,?\s*\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?\b/gi, " ")
    .replace(/[|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text;
}

function meaningful(value, fallback) {
  const v = cleanText(value);
  if (!v || v === "-" || /^none$/i.test(v)) return fallback;
  return v;
}

function normalizeConfidence(value) {
  const v = cleanText(value);
  if (!v) return "50%";
  if (/%$/.test(v)) return v;
  if (/^\d+$/.test(v)) return v + "%";
  return "50%";
}

function normalizeDisplayScore(raw) {
  const n = Number(raw || 0);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(99, Math.round(n)));
}

function buildErrorResponse(message, partial) {
  return enforceFrontendContract({
    teamAName: partial.teamAName || DEFAULT_TEAM_A,
    teamBName: partial.teamBName || DEFAULT_TEAM_B,
    winner: "Mixed",
    confidence: "50%",
    teamAScore: "50",
    teamBScore: "50",
    teamA: {
      main_position: "Backend could not complete the analysis.",
      truth: "No usable result returned.",
      lies: "No usable result returned.",
      opinion: "No usable result returned.",
      lala: "No usable result returned."
    },
    teamB: {
      main_position: "Backend could not complete the analysis.",
      truth: "No usable result returned.",
      lies: "No usable result returned.",
      opinion: "No usable result returned.",
      lala: "No usable result returned."
    },
    teamA_integrity: "Analysis failed before integrity scoring completed.",
    teamB_integrity: "Analysis failed before integrity scoring completed.",
    teamA_reasoning: "Analysis failed before reasoning scoring completed.",
    teamB_reasoning: "Analysis failed before reasoning scoring completed.",
    teamA_lane: "mixed / unclear lane",
    teamB_lane: "mixed / unclear lane",
    same_lane_engagement: "Could not finalize same-lane engagement.",
    lane_mismatch: "Could not finalize lane mismatch.",
    strongestArgumentSide: "Mixed",
    strongestArgument: "No strongest argument could be finalized.",
    whyStrongest: "Backend failed before strongest-argument selection.",
    failedResponseByOtherSide: "Backend failed before rebuttal comparison.",
    weakestOverall: "Backend failed before weakest-point selection.",
    bsMeter: "Backend failed before BS comparison.",
    manipulation: "Backend failed before manipulation analysis.",
    fluff: "Backend failed before fluff analysis.",
    core_disagreement: "The backend failed before a stable core disagreement was built.",
    why: cleanText(message || "Unknown backend error"),
    analysisMode: ANALYSIS_MODE + "+error",
    sources: []
  });
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function countMatches(text, words) {
  let total = 0;
  for (const word of words) {
    const re = new RegExp("\\b" + escapeRegExp(word) + "\\b", "gi");
    const matches = String(text || "").match(re);
    total += matches ? matches.length : 0;
  }
  return total;
}

function countManipulation(sentences) {
  const text = (sentences || []).map((s) => s.low).join(" ");
  return countMatches(text, [
    "clown", "coward", "laughing at you", "shut your mouth", "ridiculous",
    "absurd", "incompetent", "lying", "misleading"
  ]);
}

function clipSentence(text, maxLen) {
  const t = cleanText(text);
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1).trim() + "…";
}

function clip(text, maxLen) {
  return clipSentence(text, maxLen);
}

function lowerFirst(text) {
  const t = cleanText(text);
  if (!t) return "";
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function stripPrefix(text) {
  return cleanText(String(text || "").replace(/^(team a|team b|wes|myth|sabor|dave)\s*[:\-]\s*/i, ""));
}

function normalizeLoose(text) {
  return cleanText(text).toLowerCase().replace(/[^a-z0-9 ]/g, "");
}

function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
