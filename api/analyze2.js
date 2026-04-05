module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};

    const teamAName = cleanSimpleName(body.teamAName) || "Team A";
    const teamBName = cleanSimpleName(body.teamBName) || "Team B";
    const transcriptText =
      typeof body.transcriptText === "string" ? body.transcriptText : "";
    const videoLink =
      typeof body.videoLink === "string" ? body.videoLink.trim() : "";

    if (!transcriptText.trim()) {
      return res.status(400).json({ error: "Transcript is required" });
    }

    const cleanedTranscript = cleanTranscript(transcriptText);
    const stats = getTranscriptStats(cleanedTranscript);

    if (stats.wordCount < 80 || stats.lineCount < 3) {
      return res.status(400).json({
        error:
          "This does not look like a usable debate transcript yet. Paste actual spoken exchange, not metadata or junk."
      });
    }

    const extracted = extractDebateSides({
      transcript: cleanedTranscript,
      teamAName,
      teamBName
    });

    if (extracted.teamA.wordCount < 60 || extracted.teamB.wordCount < 60) {
      return res.status(200).json(
        withMode(
          buildFallbackResponse({
            teamAName,
            teamBName,
            reason:
              "Not enough clean side-specific debate substance was extracted. The transcript may still be mostly moderator text, metadata, or badly formatted turns."
          }),
          "Local"
        )
      );
    }

    const localResult = buildDeterministicResult({
      teamAName,
      teamBName,
      videoLink,
      transcript: cleanedTranscript,
      extracted
    });

    const factCheck = await runFactCheckLayer({
      teamAName,
      teamBName,
      extracted,
      localResult
    });

    const factAdjustedLocal = applyFactCheckToResult(localResult, factCheck, {
      teamAName,
      teamBName
    });

    if (!process.env.GROQ_API_KEY) {
      return res.status(200).json(withMode(factAdjustedLocal, factCheck.mode));
    }

    try {
      const aiResult = await runAiRefinement({
        teamAName,
        teamBName,
        videoLink,
        extracted,
        localResult: factAdjustedLocal,
        factCheck
      });

      const merged = mergeLocalAndAi(factAdjustedLocal, aiResult);
      const consistent = enforceConsistency(merged);

      return res.status(200).json(
        withMode(
          consistent,
          factCheck.mode === "Fact-Checked Local"
            ? "Fact-Checked Hybrid"
            : "Hybrid"
        )
      );
    } catch (err) {
      return res.status(200).json(withMode(factAdjustedLocal, factCheck.mode));
    }
  } catch (err) {
    return res.status(200).json(
      withMode(
        buildFallbackResponse({
          teamAName: "Team A",
          teamBName: "Team B",
          reason: "Unexpected backend failure."
        }),
        "Local"
      )
    );
  }
};

/* =========================
   AI REFINEMENT
========================= */

async function runAiRefinement(args) {
  const prompt = buildJudgePrompt(args);
  const response = await callGroq(prompt);

  if (!response.ok) {
    throw new Error(response.error || "AI provider failed");
  }

  const parsed = safeParseJson(response.content);
  return normalizeAiJudgeResult(parsed, {
    teamAName: args.teamAName,
    teamBName: args.teamBName
  });
}

async function callGroq(prompt) {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0.1,
        max_completion_tokens: 1400,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const raw = await safeJson(response);

    if (!response.ok) {
      return {
        ok: false,
        error:
          (raw && raw.error && raw.error.message) ||
          (raw && raw.message) ||
          "Provider request failed"
      };
    }

    const content =
      raw &&
      raw.choices &&
      raw.choices[0] &&
      raw.choices[0].message &&
      raw.choices[0].message.content;

    if (!content) {
      return { ok: false, error: "Provider returned no content." };
    }

    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: "Network/provider request failed." };
  }
}

function buildJudgePrompt(args) {
  return [
    "Return ONLY valid JSON.",
    "No markdown.",
    "No code fences.",
    "No text before JSON.",
    "No text after JSON.",
    "",
    "You are judging a debate using cleaned side extractions plus fact-check results.",
    "Do not reward credentials, confidence, eloquence, aggression, or popularity by themselves.",
    "Do not invent evidence not present in the text or fact-check report.",
    "Treat fact-checking as one input, not the entire winner logic.",
    "",
    "WORLDVIEW LANES:",
    "- empirical / scientific",
    "- philosophical / logical",
    "- theological / scriptural",
    "- rhetorical / persuasive",
    "",
    "Return exactly this JSON shape:",
    "{",
    '  "winner": "Team A | Team B | Mixed",',
    '  "confidence": 0,',
    '  "teamAScore": 0,',
    '  "teamBScore": 0,',
    '  "teamA_lane": "",',
    '  "teamB_lane": "",',
    '  "core_disagreement": "",',
    '  "teamA_main_position": "",',
    '  "teamA_truth": "",',
    '  "teamA_lies": "",',
    '  "teamA_opinion": "",',
    '  "teamA_lala": "",',
    '  "teamB_main_position": "",',
    '  "teamB_truth": "",',
    '  "teamB_lies": "",',
    '  "teamB_opinion": "",',
    '  "teamB_lala": "",',
    '  "teamA_integrity": "",',
    '  "teamB_integrity": "",',
    '  "teamA_reasoning": "",',
    '  "teamB_reasoning": "",',
    '  "same_lane_engagement": "",',
    '  "lane_mismatch": "",',
    '  "strongestArgumentSide": "",',
    '  "strongestArgument": "",',
    '  "whyStrongest": "",',
    '  "failedResponseByOtherSide": "",',
    '  "weakestOverall": "",',
    '  "manipulation": "",',
    '  "fluff": "",',
    '  "bsMeter": "",',
    '  "why": ""',
    "}",
    "",
    'winner must be exactly "Team A", "Team B", or "Mixed".',
    'strongestArgumentSide must be exactly "Team A" or "Team B".',
    'bsMeter must be exactly one of:',
    '"Team A is reaching more"',
    '"Team B is reaching more"',
    '"Neither side is reaching significantly"',
    "",
    "Team A Name: " + args.teamAName,
    "Team B Name: " + args.teamBName,
    "Video Link: " + (args.videoLink || "none"),
    "",
    "CLEAN SIDE EXTRACTION:",
    JSON.stringify(args.extracted, null, 2),
    "",
    "FACT CHECK REPORT:",
    JSON.stringify(args.factCheck, null, 2),
    "",
    "LOCAL BASELINE ANALYSIS:",
    JSON.stringify(
      {
        winner: args.localResult.winner,
        confidence: args.localResult.confidence,
        teamAScore: args.localResult.teamAScore,
        teamBScore: args.localResult.teamBScore,
        teamA_lane: args.localResult.teamA_lane,
        teamB_lane: args.localResult.teamB_lane,
        core_disagreement: args.localResult.core_disagreement,
        teamA: args.localResult.teamA,
        teamB: args.localResult.teamB,
        strongestArgumentSide: args.localResult.strongestArgumentSide,
        strongestArgument: args.localResult.strongestArgument,
        bsMeter: args.localResult.bsMeter
      },
      null,
      2
    )
  ].join("\n");
}

/* =========================
   FACT CHECK LAYER
========================= */

async function runFactCheckLayer(args) {
  const claims = dedupeClaims(
    [
      ...extractCheckableClaims(args.extracted.teamA.text, "Team A"),
      ...extractCheckableClaims(args.extracted.teamB.text, "Team B")
    ],
    12
  );

  if (!claims.length) {
    return {
      mode: "Local",
      available: false,
      summary: "No clearly checkable claims were extracted.",
      claims: [],
      teamA: {
        supported: 0,
        contradicted: 0,
        unclear: 0,
        tooBroad: 0,
        unverified: 0
      },
      teamB: {
        supported: 0,
        contradicted: 0,
        unclear: 0,
        tooBroad: 0,
        unverified: 0
      }
    };
  }

  if (!process.env.TAVILY_API_KEY) {
    const unverified = claims.map((claim) => ({
      ...claim,
      status: "unverified",
      reason: "No fact-check search provider configured.",
      evidence: []
    }));

    return summarizeFactChecks(unverified, "Local");
  }

  const checked = [];
  for (const claim of claims) {
    try {
      const result = await verifyClaimWithTavily(claim);
      checked.push(result);
      await sleep(300);
    } catch (err) {
      checked.push({
        ...claim,
        status: "unverified",
        reason: "Fact-check request failed.",
        evidence: []
      });
    }
  }

  return summarizeFactChecks(checked, "Fact-Checked Local");
}

function extractCheckableClaims(text, side) {
  const sentences = splitSentences(text);
  const claims = [];

  for (const sentence of sentences) {
    const type = classifyClaimType(sentence);
    if (!type) continue;

    claims.push({
      side,
      claim: cleanAnalystField(sentence),
      type,
      query: buildFactQuery(sentence, type)
    });
  }

  return claims;
}

function classifyClaimType(sentence) {
  const s = sentence.toLowerCase();

  if (countWords(s) < 7) return "";
  if (hasAttackLanguage(s)) return "";
  if (hasOpinionLanguage(s)) return "";
  if (hasLalaLanguage(s)) return "";

  if (
    /\b(19|20)\d{2}\b/.test(s) ||
    /\bpublished\b/.test(s) ||
    /\bwon the nobel prize\b/.test(s) ||
    /\bfellow of the royal society\b/.test(s) ||
    /\bphd\b/.test(s) ||
    /\bpeer-reviewed\b/.test(s) ||
    /\bpapers\b/.test(s) ||
    /\bbook\b/.test(s) ||
    /\bdebate\b/.test(s)
  ) {
    return "historical / bibliographic";
  }

  if (
    /\bthere are\b/.test(s) ||
    /\bwe observe\b/.test(s) ||
    /\bobserved\b/.test(s) ||
    /\bexample of\b/.test(s) ||
    /\bspeciation\b/.test(s) ||
    /\bmutation\b/.test(s) ||
    /\bnatural selection\b/.test(s) ||
    /\bcommon ancestry\b/.test(s) ||
    /\bgenome\b/.test(s)
  ) {
    return "empirical / scientific";
  }

  if (
    /\bnobody in the field\b/.test(s) ||
    /\bzero\b/.test(s) ||
    /\ball biologists\b/.test(s) ||
    /\beveryone\b/.test(s) ||
    /\bprecisely zero\b/.test(s)
  ) {
    return "broad quantitative";
  }

  return "";
}

function buildFactQuery(sentence, type) {
  const cleaned = cleanAnalystField(sentence)
    .replace(/[.?!]+$/, "")
    .slice(0, 220);

  if (type === "historical / bibliographic") {
    return cleaned + " publication date biography source";
  }

  if (type === "empirical / scientific") {
    return cleaned + " scientific evidence source";
  }

  if (type === "broad quantitative") {
    return cleaned + " evidence source";
  }

  return cleaned;
}

function dedupeClaims(claims, maxClaims) {
  const seen = new Set();
  const out = [];

  for (const claim of claims) {
    const key = normalizeDedupKey(claim.claim);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
    if (out.length >= maxClaims) break;
  }

  return out;
}

function normalizeDedupKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function verifyClaimWithTavily(claim) {
  const results = await tavilySearch(claim.query, 5);

  if (!results.length) {
    return {
      ...claim,
      status: "unverified",
      reason: "Search returned no usable evidence.",
      evidence: []
    };
  }

  const scored = scoreEvidenceAgainstClaim(claim, results);
  return {
    ...claim,
    status: scored.status,
    reason: scored.reason,
    evidence: scored.evidence
  };
}

async function tavilySearch(query, maxResults) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.TAVILY_API_KEY
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      include_answer: false,
      include_raw_content: false,
      max_results: maxResults,
      topic: "general"
    })
  });

  const raw = await safeJson(response);
  if (!response.ok) {
    throw new Error(
      (raw && raw.error) || (raw && raw.message) || "Tavily request failed"
    );
  }

  const results = (raw && raw.results) || [];
  return results.map((r) => ({
    title: safeString(r.title, ""),
    url: safeString(r.url, ""),
    content: safeString(r.content, ""),
    domain: extractDomain(safeString(r.url, ""))
  }));
}

function scoreEvidenceAgainstClaim(claim, results) {
  const claimText = claim.claim.toLowerCase();

  const evidence = results.slice(0, 3).map((r) => ({
    title: r.title,
    url: r.url,
    domain: r.domain,
    snippet: truncate(cleanAnalystField(r.content), 220)
  }));

  if (claim.type === "broad quantitative") {
    return {
      status: "too_broad",
      reason: "This claim is framed too broadly for high-confidence automatic verification.",
      evidence
    };
  }

  let supportHits = 0;
  let contradictionHits = 0;

  for (const r of results) {
    const text = (r.title + " " + r.content).toLowerCase();

    if (claim.type === "historical / bibliographic") {
      if (historicalSupportMatch(claimText, text)) supportHits += 1;
      if (historicalContradictionMatch(claimText, text)) contradictionHits += 1;
    }

    if (claim.type === "empirical / scientific") {
      if (scienceSupportMatch(claimText, text)) supportHits += 1;
      if (scienceContradictionMatch(claimText, text)) contradictionHits += 1;
    }
  }

  if (supportHits >= 2 && contradictionHits === 0) {
    return {
      status: "supported",
      reason: "Multiple search results align with the claim.",
      evidence
    };
  }

  if (contradictionHits >= 2 && supportHits === 0) {
    return {
      status: "contradicted",
      reason: "Multiple search results conflict with the claim.",
      evidence
    };
  }

  if (supportHits >= 1 && contradictionHits >= 1) {
    return {
      status: "unclear",
      reason: "Search evidence is mixed or ambiguous.",
      evidence
    };
  }

  if (supportHits === 1 && contradictionHits === 0) {
    return {
      status: "unclear",
      reason: "There is partial support, but not enough for high-confidence verification.",
      evidence
    };
  }

  return {
    status: "unverified",
    reason: "Automatic verification did not find enough reliable matching evidence.",
    evidence
  };
}

function historicalSupportMatch(claim, text) {
  const yearMatch = claim.match(/\b(19|20)\d{2}\b/);
  const hasYear = yearMatch ? text.includes(yearMatch[0]) : true;

  const nameTokens = extractImportantTokens(claim);
  const tokenHits = nameTokens.filter((t) => text.includes(t)).length;

  return hasYear && tokenHits >= Math.min(3, nameTokens.length);
}

function historicalContradictionMatch(claim, text) {
  const yearMatch = claim.match(/\b(19|20)\d{2}\b/);
  if (!yearMatch) return false;

  const claimYear = yearMatch[0];
  const textYears = text.match(/\b(18|19|20)\d{2}\b/g) || [];
  if (!textYears.length) return false;

  const importantTokens = extractImportantTokens(claim);
  const tokenHits = importantTokens.filter((t) => text.includes(t)).length;
  if (tokenHits < Math.min(2, importantTokens.length)) return false;

  return !text.includes(claimYear) && textYears.length > 0;
}

function scienceSupportMatch(claim, text) {
  const tokens = extractImportantTokens(claim);
  const tokenHits = tokens.filter((t) => text.includes(t)).length;
  return tokenHits >= Math.min(3, tokens.length);
}

function scienceContradictionMatch(claim, text) {
  if (!/\b(no evidence|not observed|disputed|incorrect|false)\b/.test(text)) {
    return false;
  }

  const tokens = extractImportantTokens(claim);
  const tokenHits = tokens.filter((t) => text.includes(t)).length;
  return tokenHits >= Math.min(2, tokens.length);
}

function extractImportantTokens(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 4)
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, 8);
}

function summarizeFactChecks(checkedClaims, mode) {
  const summary = {
    mode,
    available: mode !== "Local" || checkedClaims.some((c) => c.status !== "unverified"),
    summary: "",
    claims: checkedClaims,
    teamA: makeFactTally(),
    teamB: makeFactTally()
  };

  for (const claim of checkedClaims) {
    const bucket = claim.side === "Team A" ? summary.teamA : summary.teamB;
    if (claim.status === "supported") bucket.supported += 1;
    else if (claim.status === "contradicted") bucket.contradicted += 1;
    else if (claim.status === "unclear") bucket.unclear += 1;
    else if (claim.status === "too_broad") bucket.tooBroad += 1;
    else bucket.unverified += 1;
  }

  summary.summary =
    "Fact check summary - Team A: " +
    factTallyText(summary.teamA) +
    " | Team B: " +
    factTallyText(summary.teamB);

  return summary;
}

function makeFactTally() {
  return {
    supported: 0,
    contradicted: 0,
    unclear: 0,
    tooBroad: 0,
    unverified: 0
  };
}

function factTallyText(tally) {
  return [
    tally.supported + " supported",
    tally.contradicted + " contradicted",
    tally.unclear + " unclear",
    tally.tooBroad + " too broad",
    tally.unverified + " unverified"
  ].join(", ");
}

function applyFactCheckToResult(result, factCheck, context) {
  const out = JSON.parse(JSON.stringify(result));

  const aDelta =
    factCheck.teamA.supported -
    factCheck.teamA.contradicted -
    Math.round(factCheck.teamA.tooBroad * 0.5);

  const bDelta =
    factCheck.teamB.supported -
    factCheck.teamB.contradicted -
    Math.round(factCheck.teamB.tooBroad * 0.5);

  out.teamAScore = clampScore(out.teamAScore + clampDelta(aDelta));
  out.teamBScore = clampScore(out.teamBScore + clampDelta(bDelta));

  const totalSupported =
    factCheck.teamA.supported + factCheck.teamB.supported;
  const totalContradicted =
    factCheck.teamA.contradicted + factCheck.teamB.contradicted;

  if (totalSupported > 0) {
    out.confidence = clampConfidence(out.confidence + Math.min(12, totalSupported * 3));
  }

  if (totalContradicted > 0) {
    out.confidence = clampConfidence(out.confidence - Math.min(10, totalContradicted * 2));
  }

  out.teamA.truth = buildTruthField(out.teamA.truth, factCheck.claims, "Team A");
  out.teamB.truth = buildTruthField(out.teamB.truth, factCheck.claims, "Team B");
  out.teamA.lies = buildLiesField(out.teamA.lies, factCheck.claims, "Team A");
  out.teamB.lies = buildLiesField(out.teamB.lies, factCheck.claims, "Team B");

  out.teamA_reasoning = appendFactSummary(
    out.teamA_reasoning,
    factCheck.teamA,
    context.teamAName
  );
  out.teamB_reasoning = appendFactSummary(
    out.teamB_reasoning,
    factCheck.teamB,
    context.teamBName
  );

  out.why = appendOverallFactWhy(out.why, factCheck, context);

  out.sources = buildFactSources(factCheck);

  if (Math.abs(out.teamAScore - out.teamBScore) >= 2) {
    out.winner = out.teamAScore > out.teamBScore ? "Team A" : "Team B";
  }

  return enforceConsistency(out);
}

function clampDelta(n) {
  if (n > 2) return 2;
  if (n < -2) return -2;
  return n;
}

function buildTruthField(existing, claims, side) {
  const supported = claims.filter(
    (c) => c.side === side && c.status === "supported"
  );

  if (!supported.length) return existing;

  const best = supported[0];
  return cleanAnalystField(
    "Fact-checked support: " + best.claim + " Supported. " + best.reason
  );
}

function buildLiesField(existing, claims, side) {
  const contradicted = claims.filter(
    (c) => c.side === side && c.status === "contradicted"
  );
  const tooBroad = claims.filter(
    (c) => c.side === side && c.status === "too_broad"
  );

  if (contradicted.length) {
    return cleanAnalystField(
      "Fact-check issue: " +
        contradicted[0].claim +
        " Contradicted. " +
        contradicted[0].reason
    );
  }

  if (tooBroad.length) {
    return cleanAnalystField(
      "Overreach / too broad to verify automatically: " +
        tooBroad[0].claim
    );
  }

  return existing;
}

function appendFactSummary(existing, tally, name) {
  if (
    tally.supported === 0 &&
    tally.contradicted === 0 &&
    tally.tooBroad === 0
  ) {
    return existing;
  }

  return cleanAnalystField(
    existing +
      " Fact-check impact for " +
      name +
      ": " +
      factTallyText(tally) +
      "."
  );
}

function appendOverallFactWhy(existing, factCheck, context) {
  const aNet = factCheck.teamA.supported - factCheck.teamA.contradicted;
  const bNet = factCheck.teamB.supported - factCheck.teamB.contradicted;

  if (aNet === 0 && bNet === 0) return existing;

  if (aNet > bNet) {
    return cleanAnalystField(
      existing +
        " Fact-checking slightly favors " +
        context.teamAName +
        " on checkable claims."
    );
  }

  if (bNet > aNet) {
    return cleanAnalystField(
      existing +
        " Fact-checking slightly favors " +
        context.teamBName +
        " on checkable claims."
    );
  }

  return cleanAnalystField(existing + " Fact-checking is roughly even.");
}

function buildFactSources(factCheck) {
  const sources = [];
  for (const claim of factCheck.claims || []) {
    for (const ev of claim.evidence || []) {
      sources.push({
        claim: claim.claim,
        type: claim.type,
        likely_source: ev.url || ev.domain || ev.title || "Unknown source",
        confidence: claim.status
      });
    }
  }

  if (!sources.length) {
    return [
      {
        claim: "No fact-check sources were available",
        type: "general",
        likely_source: "Requires manual review",
        confidence: "low"
      }
    ];
  }

  return sources.slice(0, 10);
}

/* =========================
   EXTRACTION
========================= */

function extractDebateSides(args) {
  const lines = splitDialogueLines(args.transcript);
  const filtered = removeObviousMetadata(lines);

  const blocks = buildSpeechBlocks(filtered);
  const debateBlocks = dropIntroAndModeratorBlocks(blocks, args);

  const assigned = assignBlocksToSides(debateBlocks, args);

  const teamALines = assigned.teamA;
  const teamBLines = assigned.teamB;

  return {
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    notes: assigned.notes,
    teamA: {
      text: teamALines.join(" ").trim(),
      lines: teamALines,
      wordCount: countWords(teamALines.join(" "))
    },
    teamB: {
      text: teamBLines.join(" ").trim(),
      lines: teamBLines,
      wordCount: countWords(teamBLines.join(" "))
    }
  };
}

function splitDialogueLines(text) {
  return String(text)
    .split("\n")
    .map((line) => hardScrubText(line))
    .map((line) => line.trim())
    .filter(Boolean);
}

function removeObviousMetadata(lines) {
  return lines.filter((line) => {
    const t = line.toLowerCase();

    if (!t) return false;
    if (/^page \d+$/i.test(t)) return false;
    if (/^slide \d+$/i.test(t)) return false;
    if (/^(transcript|captions|subtitle)$/i.test(t)) return false;
    if (/^[\[\](){}\-–—•*]+$/.test(t)) return false;
    if (t.length < 2) return false;

    return true;
  });
}

function buildSpeechBlocks(lines) {
  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (isHardTurnBoundary(line)) {
      if (current.length) {
        blocks.push(current.join(" ").trim());
        current = [];
      }
      blocks.push(line.trim());
      continue;
    }

    if (current.length === 0) {
      current.push(line);
      continue;
    }

    const prev = current[current.length - 1];
    const shouldSplit = shouldStartNewBlock(prev, line);

    if (shouldSplit) {
      blocks.push(current.join(" ").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length) {
    blocks.push(current.join(" ").trim());
  }

  return blocks
    .map((b) => normalizeBlockText(b))
    .filter((b) => countWords(b) >= 4);
}

function isHardTurnBoundary(line) {
  const t = line.toLowerCase();
  return (
    /\b(all right|alright),?\s/.test(t) ||
    /\bthanks[, ]/.test(t) ||
    /\bthank you[, ]/.test(t) ||
    /\bwith that being said\b/.test(t) ||
    /\bthat concludes\b/.test(t) ||
    /\blet me reset the timer\b/.test(t) ||
    /\bwe now have\b/.test(t) ||
    /\bopening remarks\b/.test(t) ||
    /\brebuttal\b/.test(t) ||
    /\bclosing remarks\b/.test(t)
  );
}

function shouldStartNewBlock(prev, next) {
  const nextLower = next.toLowerCase();
  const prevWords = countWords(prev);
  const nextWords = countWords(next);

  if (nextWords >= 30 && prevWords >= 30) return true;
  if (/\b(all right|alright|thanks|thank you)\b/.test(nextLower)) return true;
  if (/\bso the question before us\b/.test(nextLower)) return true;
  if (/\bthis is supposed to be a debate\b/.test(nextLower)) return true;
  if (/\bfirstly\b/.test(nextLower) && prevWords > 40) return true;
  if (/\bthe first challenge\b/.test(nextLower) && prevWords > 40) return true;

  return false;
}

function dropIntroAndModeratorBlocks(blocks, args) {
  const out = [];
  let seenSubstantiveStart = false;

  for (const block of blocks) {
    const moderatorLike = isModeratorBlock(block, args);
    const speakerBioLike = isSpeakerBioBlock(block, args);

    if (!seenSubstantiveStart) {
      if (moderatorLike || speakerBioLike) continue;

      if (looksLikeOpeningArgument(block)) {
        seenSubstantiveStart = true;
        out.push(block);
      }

      continue;
    }

    if (moderatorLike) {
      out.push("__TURN_BREAK__");
      continue;
    }

    if (!speakerBioLike) out.push(block);
  }

  return collapseTurnBreaks(out);
}

function collapseTurnBreaks(items) {
  const out = [];
  for (const item of items) {
    if (item === "__TURN_BREAK__" && out[out.length - 1] === "__TURN_BREAK__") {
      continue;
    }
    out.push(item);
  }
  while (out[0] === "__TURN_BREAK__") out.shift();
  while (out[out.length - 1] === "__TURN_BREAK__") out.pop();
  return out;
}

function isModeratorBlock(block, args) {
  const t = block.toLowerCase();

  if (
    /\bwelcome everyone\b/.test(t) ||
    /\btoday we are here\b/.test(t) ||
    /\blet me just introduce\b/.test(t) ||
    /\bi'll just briefly introduce myself\b/.test(t) ||
    /\bmy name is\b/.test(t) ||
    /\bfirst speaking for\b/.test(t) ||
    /\bour second speaker\b/.test(t) ||
    /\bthose are our speakers\b/.test(t) ||
    /\bformat of the debate\b/.test(t) ||
    /\bremain respectful\b/.test(t) ||
    /\bon topic\b/.test(t) ||
    /\btime limits\b/.test(t) ||
    /\bpass over to\b/.test(t) ||
    /\bthat concludes\b/.test(t) ||
    /\blet me reset the timer\b/.test(t) ||
    /\bwe now have\b/.test(t) ||
    /\bminutes of rebuttal\b/.test(t) ||
    /\bclosing remarks\b/.test(t) ||
    /\bmoderator discussion\b/.test(t)
  ) {
    return true;
  }

  if (mentionsNameOnlyAsTransition(block, args.teamAName, args.teamBName)) {
    return true;
  }

  return false;
}

function isSpeakerBioBlock(block, args) {
  const t = block.toLowerCase();

  if (
    /\bmaster'?s degree\b/.test(t) ||
    /\bphd student\b/.test(t) ||
    /\byoutube channel\b/.test(t) ||
    /\bscience communicator\b/.test(t) ||
    /\bbest known for\b/.test(t) ||
    /\bcurrently a\b/.test(t)
  ) {
    return true;
  }

  if (
    containsNameToken(t, args.teamAName) &&
    containsNameToken(t, args.teamBName) &&
    /\bspeaking for\b/.test(t)
  ) {
    return true;
  }

  return false;
}

function mentionsNameOnlyAsTransition(block, teamAName, teamBName) {
  const t = block.toLowerCase();
  const a = containsNameToken(t, teamAName);
  const b = containsNameToken(t, teamBName);

  if (!(a || b)) return false;

  return (
    /\bthanks[, ]/.test(t) ||
    /\bwith that being said\b/.test(t) ||
    /\bwill now have\b/.test(t) ||
    /\bopening remarks\b/.test(t) ||
    /\brebuttal\b/.test(t) ||
    /\bclosing remarks\b/.test(t) ||
    /\bminutes for\b/.test(t)
  );
}

function looksLikeOpeningArgument(block) {
  const t = block.toLowerCase();

  return (
    /\bthe question before us\b/.test(t) ||
    /\bi am defining\b/.test(t) ||
    /\bthis is supposed to be a debate\b/.test(t) ||
    /\bfirst, let'?s talk about\b/.test(t) ||
    /\bthe claim\b/.test(t) ||
    /\bthe problem\b/.test(t) ||
    /\bthe issue\b/.test(t) ||
    /\bi argue\b/.test(t) ||
    /\bi contend\b/.test(t)
  );
}

function assignBlocksToSides(blocks, args) {
  const teamA = [];
  const teamB = [];
  const notes = [];

  let currentSide = "A";
  let switchedOnce = false;

  for (const block of blocks) {
    if (block === "__TURN_BREAK__") {
      currentSide = currentSide === "A" ? "B" : "A";
      switchedOnce = true;
      continue;
    }

    const target = chooseSideForBlock(block, currentSide, args);

    if (target === "A") teamA.push(block);
    else teamB.push(block);

    currentSide = target;
  }

  if (!switchedOnce) {
    const reparsed = fallbackSplitByLargeWindows(blocks);
    teamA.length = 0;
    teamB.length = 0;
    teamA.push(...reparsed.teamA);
    teamB.push(...reparsed.teamB);
    notes.push("Fallback split used because turn boundaries were weak.");
  }

  return { teamA, teamB, notes };
}

function chooseSideForBlock(block, defaultSide, args) {
  const t = block.toLowerCase();

  const aNameSeen = containsNameToken(t, args.teamAName);
  const bNameSeen = containsNameToken(t, args.teamBName);

  if (aNameSeen && !bNameSeen && /\bi\b/.test(t) && !/\bhe\b|\bshe\b|\bthey\b/.test(t)) {
    return "A";
  }
  if (bNameSeen && !aNameSeen && /\bi\b/.test(t) && !/\bhe\b|\bshe\b|\bthey\b/.test(t)) {
    return "B";
  }

  if (/\bmy opponent\b/.test(t) || /\bhe claims\b/.test(t) || /\bshe claims\b/.test(t)) {
    return defaultSide;
  }

  return defaultSide;
}

function fallbackSplitByLargeWindows(blocks) {
  const cleanBlocks = blocks.filter((b) => b !== "__TURN_BREAK__");
  const mid = Math.max(1, Math.floor(cleanBlocks.length / 2));
  return {
    teamA: cleanBlocks.slice(0, mid),
    teamB: cleanBlocks.slice(mid)
  };
}

/* =========================
   LOCAL ANALYSIS
========================= */

function buildDeterministicResult(args) {
  const teamAText = args.extracted.teamA.text;
  const teamBText = args.extracted.teamB.text;

  const teamAWindows = buildClaimWindows(splitSentences(teamAText), 3);
  const teamBWindows = buildClaimWindows(splitSentences(teamBText), 3);

  const teamAProfile = analyzeSide(teamAText, teamAWindows);
  const teamBProfile = analyzeSide(teamBText, teamBWindows);

  let teamAScore = clampScore(teamAProfile.score);
  let teamBScore = clampScore(teamBProfile.score);

  let winner = "Mixed";
  const diff = Math.abs(teamAScore - teamBScore);

  if (diff >= 2) {
    winner = teamAScore > teamBScore ? "Team A" : "Team B";
  }

  const strongest =
    teamAProfile.strongest.score >= teamBProfile.strongest.score
      ? { side: "Team A", text: teamAProfile.strongest.text, score: teamAProfile.strongest.score }
      : { side: "Team B", text: teamBProfile.strongest.text, score: teamBProfile.strongest.score };

  if (winner === "Mixed" && strongest.score >= 8) {
    if (strongest.side === "Team A" && teamAProfile.overreach <= teamBProfile.overreach) {
      winner = "Team A";
    } else if (strongest.side === "Team B" && teamBProfile.overreach <= teamAProfile.overreach) {
      winner = "Team B";
    }
  }

  const confidence = clampConfidence(
    35 +
      Math.abs(teamAScore - teamBScore) * 10 +
      (strongest.score >= 8 ? 10 : 0) -
      (winner === "Mixed" ? 12 : 0)
  );

  return enforceConsistency({
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    analysisMode: "Local",
    confidence,
    teamAScore,
    teamBScore,
    winner,
    teamA_lane: detectLane(teamAText),
    teamB_lane: detectLane(teamBText),
    core_disagreement: detectCoreDisagreement(teamAText, teamBText),
    teamA: {
      main_position: teamAProfile.mainPosition,
      truth: teamAProfile.groundedPoint,
      lies: teamAProfile.overreachPoint,
      opinion: teamAProfile.opinionPoint,
      lala: teamAProfile.speculativePoint
    },
    teamB: {
      main_position: teamBProfile.mainPosition,
      truth: teamBProfile.groundedPoint,
      lies: teamBProfile.overreachPoint,
      opinion: teamBProfile.opinionPoint,
      lala: teamBProfile.speculativePoint
    },
    teamA_integrity: summarizeIntegrity(teamAText, teamAProfile),
    teamB_integrity: summarizeIntegrity(teamBText, teamBProfile),
    teamA_reasoning: summarizeReasoning(teamAText, teamAProfile),
    teamB_reasoning: summarizeReasoning(teamBText, teamBProfile),
    same_lane_engagement: detectSameLaneEngagement(teamAText, teamBText),
    lane_mismatch: detectLaneMismatch(teamAText, teamBText),
    strongestArgumentSide: strongest.side,
    strongestArgument: strongest.text || "-",
    whyStrongest: buildWhyStrongest(strongest, args.teamAName, args.teamBName),
    failedResponseByOtherSide: buildFailedResponse(
      strongest,
      teamAProfile,
      teamBProfile,
      args.teamAName,
      args.teamBName
    ),
    weakestOverall: buildWeakestOverall(
      teamAProfile,
      teamBProfile,
      args.teamAName,
      args.teamBName
    ),
    manipulation: buildManipulation(teamAText, teamBText),
    fluff: buildFluff(countFluff(teamAText), countFluff(teamBText)),
    bsMeter: buildBsMeter(teamAProfile.overreach, teamBProfile.overreach),
    why: buildWhyWinner(
      winner,
      teamAProfile,
      teamBProfile,
      args.teamAName,
      args.teamBName
    ),
    sources: [
      {
        claim: "Local analysis is based on cleaned transcript structure and argument heuristics.",
        type: "general",
        likely_source: "Debate transcript",
        confidence: "medium"
      }
    ]
  });
}

function analyzeSide(text, windows) {
  const sentences = splitSentences(text);

  const mainWindow = pickBestWindow(windows, scoreMainPositionWindow);
  const strongestWindow = pickBestWindow(windows, scoreStrongestWindow);
  const groundedSentence = pickBestSentence(sentences, scoreGroundedSentence);
  const overreachSentence = pickBestSentence(sentences, scoreOverreachSentence);
  const opinionSentence = pickBestSentence(sentences, scoreOpinionSentence);
  const speculativeSentence = pickBestSentence(sentences, scoreSpeculativeSentence);

  const support = scoreSupport(text);
  const overreach = scoreOverreach(text);
  const dodging = scoreDodging(text);
  const pressure = scorePressure(text);
  const fluff = countFluff(text);

  const score = Math.round(
    5 +
      Math.min(3, support) -
      Math.min(2, overreach * 0.6) -
      Math.min(1, dodging * 0.4) -
      Math.min(1, fluff * 0.15)
  );

  return {
    score,
    support,
    overreach,
    dodging,
    pressure,
    fluff,
    strongest: {
      text: strongestWindow ? cleanAnalystField(strongestWindow) : "-",
      score: strongestWindow ? scoreStrongestWindow(strongestWindow) : 0
    },
    mainPosition: mainWindow
      ? cleanAnalystField(makeClaim(mainWindow))
      : "No clear main position extracted.",
    groundedPoint: groundedSentence
      ? "Grounded point: " + cleanAnalystField(makeClaim(groundedSentence))
      : "No clearly grounded point extracted.",
    overreachPoint: overreachSentence
      ? "Overreach: " + cleanAnalystField(makeClaim(overreachSentence))
      : "No major overreach extracted.",
    opinionPoint: opinionSentence
      ? "Subjective framing: " + cleanAnalystField(makeClaim(opinionSentence))
      : "No strong subjective framing extracted.",
    speculativePoint: speculativeSentence
      ? "Speculative leap: " + cleanAnalystField(makeClaim(speculativeSentence))
      : "No strong speculative leap extracted."
  };
}

function buildClaimWindows(sentences, size) {
  const out = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const part = sentences.slice(i, i + size).join(" ").trim();
    if (countWords(part) >= 14) out.push(part);
  }
  return out;
}

function pickBestWindow(windows, scorer) {
  let best = "";
  let bestScore = -Infinity;

  for (const w of windows) {
    const score = scorer(w);
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
  }

  return best;
}

function pickBestSentence(sentences, scorer) {
  let best = "";
  let bestScore = -Infinity;

  for (const s of sentences) {
    const score = scorer(s);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  return bestScore > 0 ? best : "";
}

function scoreMainPositionWindow(text) {
  const t = text.toLowerCase();
  let score = 0;

  if (hasClaimLanguage(t)) score += 4;
  if (hasCausalLanguage(t)) score += 2;
  if (hasSupportLanguage(t)) score += 2;
  if (isIntroNoise(t)) score -= 8;
  if (hasModeratorLanguage(t)) score -= 8;
  if (countWords(t) < 12) score -= 3;

  return score;
}

function scoreStrongestWindow(text) {
  const t = text.toLowerCase();
  let score = 0;

  if (hasSupportLanguage(t)) score += 4;
  if (hasCausalLanguage(t)) score += 2;
  if (hasContrastLanguage(t)) score += 2;
  if (hasEvidenceLanguage(t)) score += 2;
  if (hasExtremeLanguage(t)) score -= 2;
  if (isIntroNoise(t)) score -= 10;
  if (hasModeratorLanguage(t)) score -= 10;

  return score;
}

function scoreGroundedSentence(s) {
  const t = s.toLowerCase();
  let score = 0;
  if (isIntroNoise(t) || hasModeratorLanguage(t)) return -100;
  if (hasSupportLanguage(t)) score += 4;
  if (hasEvidenceLanguage(t)) score += 3;
  if (hasExtremeLanguage(t)) score -= 2;
  if (hasOpinionLanguage(t)) score -= 1;
  return score;
}

function scoreOverreachSentence(s) {
  const t = s.toLowerCase();
  let score = 0;
  if (isIntroNoise(t) || hasModeratorLanguage(t)) return -100;
  if (hasExtremeLanguage(t)) score += 3;
  if (hasAttackLanguage(t)) score += 2;
  if (hasOverclaimLanguage(t)) score += 2;
  return score;
}

function scoreOpinionSentence(s) {
  const t = s.toLowerCase();
  let score = 0;
  if (isIntroNoise(t) || hasModeratorLanguage(t)) return -100;
  if (hasOpinionLanguage(t)) score += 4;
  if (hasAttackLanguage(t)) score += 2;
  return score;
}

function scoreSpeculativeSentence(s) {
  const t = s.toLowerCase();
  let score = 0;
  if (isIntroNoise(t) || hasModeratorLanguage(t)) return -100;
  if (hasLalaLanguage(t)) score += 4;
  if (hasOverclaimLanguage(t)) score += 2;
  return score;
}

/* =========================
   SCORING / TEXT SIGNALS
========================= */

function scoreSupport(text) {
  const t = text.toLowerCase();
  let score = 0;

  score += countMatches(t, /\bbecause\b/g) * 1.2;
  score += countMatches(t, /\bfor example\b/g) * 1.2;
  score += countMatches(t, /\bfor instance\b/g) * 1.2;
  score += countMatches(t, /\bthe reason\b/g) * 1.2;
  score += countMatches(t, /\bshows\b/g) * 1.0;
  score += countMatches(t, /\bevidence\b/g) * 1.2;
  score += countMatches(t, /\bdata\b/g) * 0.8;
  score += countMatches(t, /\btherefore\b/g) * 1.0;
  score += countMatches(t, /\bmeans\b/g) * 0.8;
  score += countMatches(t, /\bso\b/g) * 0.15;

  return Math.min(10, score);
}

function scoreOverreach(text) {
  const t = text.toLowerCase();
  let score = 0;

  score += countMatches(t, /\balways\b/g) * 1.0;
  score += countMatches(t, /\bnever\b/g) * 1.0;
  score += countMatches(t, /\beveryone\b/g) * 0.8;
  score += countMatches(t, /\bnobody\b/g) * 0.8;
  score += countMatches(t, /\bcompletely\b/g) * 0.8;
  score += countMatches(t, /\bproves\b/g) * 1.0;
  score += countMatches(t, /\bobviously\b/g) * 0.8;
  score += countMatches(t, /\bclearly\b/g) * 0.6;
  score += countMatches(t, /\babsurd\b/g) * 0.8;
  score += countMatches(t, /\bclown\b/g) * 1.2;
  score += countMatches(t, /\bcoward\b/g) * 1.2;
  score += countMatches(t, /\bincompetent\b/g) * 0.8;
  score += countMatches(t, /\bprecisely zero\b/g) * 1.0;

  return Math.min(10, score);
}

function scoreDodging(text) {
  const t = text.toLowerCase();
  let score = 0;

  score += countMatches(t, /\bdoesn'?t answer\b/g) * 1.2;
  score += countMatches(t, /\bavoids\b/g) * 1.0;
  score += countMatches(t, /\bdidn'?t address\b/g) * 1.2;
  score += countMatches(t, /\bdidn'?t actually\b/g) * 0.8;
  score += countMatches(t, /\bmisrepresent\b/g) * 0.6;

  return Math.min(10, score);
}

function countFluff(text) {
  const t = text.toLowerCase();
  let score = 0;

  score += countMatches(t, /\bum\b/g);
  score += countMatches(t, /\buh\b/g);
  score += countMatches(t, /\byou know\b/g);
  score += countMatches(t, /\blike\b/g) * 0.2;
  score += countMatches(t, /\bjust\b/g) * 0.2;
  score += countMatches(t, /\ball right\b/g) * 0.4;

  return Math.round(score);
}

function hasClaimLanguage(text) {
  return (
    /\bthe point\b/.test(text) ||
    /\bthe issue\b/.test(text) ||
    /\bthe problem\b/.test(text) ||
    /\bthe question\b/.test(text) ||
    /\bi argue\b/.test(text) ||
    /\bi contend\b/.test(text) ||
    /\bi am defining\b/.test(text) ||
    /\baccording to\b/.test(text)
  );
}

function hasCausalLanguage(text) {
  return (
    /\bbecause\b/.test(text) ||
    /\btherefore\b/.test(text) ||
    /\bmeans\b/.test(text) ||
    /\bcausality\b/.test(text) ||
    /\bmechanism\b/.test(text) ||
    /\bgenerate\b/.test(text) ||
    /\bexplains\b/.test(text)
  );
}

function hasSupportLanguage(text) {
  return (
    /\bbecause\b/.test(text) ||
    /\bfor example\b/.test(text) ||
    /\bfor instance\b/.test(text) ||
    /\bevidence\b/.test(text) ||
    /\bdata\b/.test(text) ||
    /\bshows\b/.test(text) ||
    /\btherefore\b/.test(text) ||
    /\bmeans\b/.test(text) ||
    /\bpredict\b/.test(text) ||
    /\btest\b/.test(text) ||
    /\bobserve\b/.test(text)
  );
}

function hasEvidenceLanguage(text) {
  return (
    /\bevidence\b/.test(text) ||
    /\bdata\b/.test(text) ||
    /\bpaper\b/.test(text) ||
    /\bstudy\b/.test(text) ||
    /\barticle\b/.test(text) ||
    /\bobserve\b/.test(text) ||
    /\bobserved\b/.test(text) ||
    /\bexample\b/.test(text)
  );
}

function hasContrastLanguage(text) {
  return (
    /\bbut\b/.test(text) ||
    /\bhowever\b/.test(text) ||
    /\bin contrast\b/.test(text) ||
    /\bon the other hand\b/.test(text) ||
    /\binstead\b/.test(text)
  );
}

function hasExtremeLanguage(text) {
  return (
    /\balways\b/.test(text) ||
    /\bnever\b/.test(text) ||
    /\beveryone\b/.test(text) ||
    /\bnobody\b/.test(text) ||
    /\ball of them\b/.test(text) ||
    /\bcompletely\b/.test(text) ||
    /\bprecisely zero\b/.test(text)
  );
}

function hasOverclaimLanguage(text) {
  return (
    /\bproves\b/.test(text) ||
    /\bsettles\b/.test(text) ||
    /\bdestroys\b/.test(text) ||
    /\bobliterates\b/.test(text) ||
    /\bcrushes\b/.test(text) ||
    /\bcan only mean\b/.test(text)
  );
}

function hasOpinionLanguage(text) {
  return (
    /\bi think\b/.test(text) ||
    /\bi doubt\b/.test(text) ||
    /\bi want you to consider\b/.test(text) ||
    /\bisn'?t that rich\b/.test(text) ||
    /\binteresting\b/.test(text) ||
    /\bprimitive understanding\b/.test(text) ||
    /\bridiculous\b/.test(text) ||
    /\bidiotic\b/.test(text)
  );
}

function hasLalaLanguage(text) {
  return (
    /\beveryone is laughing\b/.test(text) ||
    /\bhe will run away\b/.test(text) ||
    /\bwill look incompetent\b/.test(text) ||
    /\bhe has to\b/.test(text) ||
    /\bthe only option\b/.test(text)
  );
}

function hasAttackLanguage(text) {
  return (
    /\bclown\b/.test(text) ||
    /\bcoward\b/.test(text) ||
    /\bincompetent\b/.test(text) ||
    /\bidiotic\b/.test(text) ||
    /\binsane\b/.test(text) ||
    /\bprimitive\b/.test(text)
  );
}

function hasModeratorLanguage(text) {
  return (
    /\bwelcome everyone\b/.test(text) ||
    /\bformat of the debate\b/.test(text) ||
    /\bremain respectful\b/.test(text) ||
    /\btime limits\b/.test(text) ||
    /\bopening remarks\b/.test(text) ||
    /\bclosing remarks\b/.test(text)
  );
}

function isIntroNoise(text) {
  return (
    /\bthanks everyone for coming\b/.test(text) ||
    /\bmy name is\b/.test(text) ||
    /\bi'?ll just briefly introduce\b/.test(text) ||
    /\blet me introduce\b/.test(text) ||
    /\bchannel is primarily\b/.test(text) ||
    /\bfirst speaking for\b/.test(text)
  );
}

/* =========================
   SUMMARIES
========================= */

function detectLane(text) {
  const t = text.toLowerCase();

  const empirical =
    countMatches(t, /\bevidence\b/g) * 2 +
    countMatches(t, /\bdata\b/g) * 2 +
    countMatches(t, /\bobserve\b/g) * 2 +
    countMatches(t, /\bmutation\b/g) * 2 +
    countMatches(t, /\bnatural selection\b/g) * 2 +
    countMatches(t, /\bgenome\b/g) * 2 +
    countMatches(t, /\bbiology\b/g) * 2 +
    countMatches(t, /\bscience\b/g) * 1;

  const philosophical =
    countMatches(t, /\bdefinition\b/g) * 2 +
    countMatches(t, /\bcausality\b/g) * 3 +
    countMatches(t, /\bfact\b/g) * 2 +
    countMatches(t, /\btheory\b/g) * 2 +
    countMatches(t, /\bepistemology\b/g) * 3 +
    countMatches(t, /\blogic\b/g) * 2 +
    countMatches(t, /\bequivocation\b/g) * 2 +
    countMatches(t, /\bmeaning\b/g) * 1;

  const theological =
    countMatches(t, /\bscripture\b/g) * 3 +
    countMatches(t, /\bgod\b/g) * 2 +
    countMatches(t, /\bfaith\b/g) * 2 +
    countMatches(t, /\btheological\b/g) * 3;

  const rhetorical =
    countMatches(t, /\bclown\b/g) * 2 +
    countMatches(t, /\bcoward\b/g) * 2 +
    countMatches(t, /\bincompetent\b/g) * 2 +
    countMatches(t, /\bprimitive understanding\b/g) * 2 +
    countMatches(t, /\blaughing at you\b/g) * 2;

  const scores = [
    ["empirical / scientific", empirical],
    ["philosophical / logical", philosophical],
    ["theological / scriptural", theological],
    ["rhetorical / persuasive", rhetorical]
  ].sort((a, b) => b[1] - a[1]);

  if (
    scores[0][1] > 0 &&
    scores[1][1] > 0 &&
    Math.abs(scores[0][1] - scores[1][1]) <= 2 &&
    (scores[0][0] === "philosophical / logical" || scores[1][0] === "philosophical / logical")
  ) {
    return "philosophical / logical";
  }

  return scores[0][1] > 0 ? scores[0][0] : "rhetorical / persuasive";
}

function detectCoreDisagreement(teamAText, teamBText) {
  const a = teamAText.toLowerCase();
  const b = teamBText.toLowerCase();

  if (
    (/\bmodern synthesis\b/.test(a) || /\bneodarwin/i.test(a)) &&
    (/\bdarwinian evolution\b/.test(b) || /\bfact\b/.test(b))
  ) {
    return cleanAnalystField(
      "Whether Team A has exposed a real failure in neo-Darwinian or gene-centric explanation, or whether Team B is right that Team A is equivocating on what Darwinian evolution and scientific fact mean."
    );
  }

  return cleanAnalystField(
    "The sides disagree over what the central claim actually is, what counts as support for it, and whether the opponent has answered the strongest version of the case."
  );
}

function summarizeIntegrity(text, profile) {
  const t = text.toLowerCase();

  const attackHeavy = profile.pressure >= 4 || profile.overreach >= 5;
  const supportHeavy = profile.support >= 5;
  const dodgeHeavy = profile.dodging >= 3;

  if (supportHeavy && attackHeavy && dodgeHeavy) {
    return "Makes substantive points, but mixes them with rhetorical pressure, overstatement, and selective engagement.";
  }

  if (supportHeavy && attackHeavy) {
    return "Combines real argument with noticeable dismissive or pressuring rhetoric.";
  }

  if (supportHeavy && !attackHeavy) {
    return "Shows a meaningful effort to support claims and stays comparatively more disciplined.";
  }

  if (attackHeavy && !supportHeavy) {
    return "Relies too much on rhetorical pressure or attack language relative to direct support.";
  }

  if (/\bmy opponent\b/.test(t) || /\bhe claims\b/.test(t) || /\bshe claims\b/.test(t)) {
    return "Engages the opponent directly, though not always with strong support.";
  }

  return "Limited but recognizable effort to engage the dispute.";
}

function summarizeReasoning(text, profile) {
  const t = text.toLowerCase();

  if (profile.support >= 6 && profile.overreach <= 2) {
    return "Reasoning chain is relatively clear, with claims tied to examples, distinctions, or stated support.";
  }

  if (profile.support >= 5 && profile.overreach >= 4) {
    return "Contains substantial argument structure, but the reasoning is weakened by overreach and rhetorical padding.";
  }

  if (profile.support >= 4 && /\bdefinition\b|\bcausality\b|\bfact\b|\btheory\b/.test(t)) {
    return "Reasoning leans heavily on conceptual framing and category distinctions rather than direct evidence alone.";
  }

  if (profile.support <= 2 && profile.overreach >= 4) {
    return "Reasoning is comparatively thin and leans too much on assertion or attack.";
  }

  if (profile.support <= 2) {
    return "Reasoning is present, but it stays under-supported in the extracted material.";
  }

  return "Reasoning is visible, but uneven in support and follow-through.";
}

function detectSameLaneEngagement(teamAText, teamBText) {
  const a = detectLane(teamAText);
  const b = detectLane(teamBText);

  if (a === b) {
    return "The sides largely argue within the same lane.";
  }

  const pair = [a, b].join(" | ");

  if (
    pair.includes("empirical / scientific") &&
    pair.includes("philosophical / logical")
  ) {
    return "There is partial overlap, but one side leans more scientific while the other leans more conceptual or definitional.";
  }

  return "The sides are only partly engaging in the same lane.";
}

function detectLaneMismatch(teamAText, teamBText) {
  const a = detectLane(teamAText);
  const b = detectLane(teamBText);

  if (a === b) return "No major lane mismatch.";

  if (
    [a, b].includes("empirical / scientific") &&
    [a, b].includes("philosophical / logical")
  ) {
    return "Moderate lane mismatch: one side argues more from science content while the other leans more on framing, category, or conceptual distinctions.";
  }

  return "Noticeable lane mismatch.";
}

function buildWhyStrongest(strongest, teamAName, teamBName) {
  if (!strongest.text || strongest.text === "-") {
    return "No clearly strong multi-sentence argument window was extracted.";
  }

  return strongest.side === "Team A"
    ? teamAName + " presents the clearer supported argument window in the extracted material."
    : teamBName + " presents the clearer supported argument window in the extracted material.";
}

function buildFailedResponse(strongest, teamAProfile, teamBProfile, teamAName, teamBName) {
  if (!strongest || !strongest.text || strongest.text === "-") {
    return "No clear failed response extracted.";
  }

  if (strongest.side === "Team A") {
    if (teamBProfile.support + teamBProfile.dodging < teamAProfile.support) {
      return teamBName + " does not seem to answer " + teamAName + "'s strongest extracted point with equal clarity or support.";
    }
    if (teamBProfile.overreach > teamAProfile.overreach + 1) {
      return teamBName + " appears to answer pressure with more pressure rather than a comparably strong direct rebuttal.";
    }
    return "No major failed response extracted.";
  }

  if (teamAProfile.support + teamAProfile.dodging < teamBProfile.support) {
    return teamAName + " does not seem to answer " + teamBName + "'s strongest extracted point with equal clarity or support.";
  }
  if (teamAProfile.overreach > teamBProfile.overreach + 1) {
    return teamAName + " appears to answer pressure with more pressure rather than a comparably strong direct rebuttal.";
  }

  return "No major failed response extracted.";
}

function buildWeakestOverall(teamAProfile, teamBProfile, teamAName, teamBName) {
  const aWeak = teamAProfile.overreach + teamAProfile.fluff - teamAProfile.support;
  const bWeak = teamBProfile.overreach + teamBProfile.fluff - teamBProfile.support;

  if (aWeak >= bWeak + 2) {
    return teamAName + " shows the weaker stretch because overreach and rhetorical excess outpace support more noticeably.";
  }

  if (bWeak >= aWeak + 2) {
    return teamBName + " shows the weaker stretch because overreach and rhetorical excess outpace support more noticeably.";
  }

  if (teamAProfile.overreach >= 5 && teamBProfile.overreach >= 5) {
    return "Both sides have weak stretches where rhetorical pressure starts crowding out cleaner argument.";
  }

  return "Neither side has a uniquely weak stretch by a large margin, but both have some uneven moments.";
}

function buildManipulation(teamAText, teamBText) {
  const a = scorePressure(teamAText);
  const b = scorePressure(teamBText);

  if (a >= 3 && b >= 3) {
    return "Dismissive or pressuring rhetoric appears on both sides.";
  }
  if (a >= 3) {
    return "Team A uses more dismissive or pressuring rhetoric.";
  }
  if (b >= 3) {
    return "Team B uses more dismissive or pressuring rhetoric.";
  }
  return "No major manipulation pattern extracted.";
}

function buildFluff(teamAFluff, teamBFluff) {
  if (teamAFluff + teamBFluff >= 16) {
    return "Heavy filler and repetition are present.";
  }
  if (teamAFluff + teamBFluff >= 8) {
    return "Some filler and repetition are present.";
  }
  return "No major fluff problem extracted.";
}

function buildBsMeter(teamAOverreach, teamBOverreach) {
  if (teamAOverreach >= teamBOverreach + 2) return "Team A is reaching more";
  if (teamBOverreach >= teamAOverreach + 2) return "Team B is reaching more";
  return "Neither side is reaching significantly";
}

function buildWhyWinner(winner, teamAProfile, teamBProfile, teamAName, teamBName) {
  if (winner === "Team A") {
    return (
      teamAName +
      " edges the result by combining stronger support with less damaging overreach in the extracted material."
    );
  }
  if (winner === "Team B") {
    return (
      teamBName +
      " edges the result by combining stronger support with less damaging overreach in the extracted material."
    );
  }
  return "The extracted material is close enough that neither side cleanly separates from the other.";
}

function scorePressure(text) {
  const t = text.toLowerCase();
  let score = 0;
  score += countMatches(t, /\bcoward\b/g) * 1.5;
  score += countMatches(t, /\bclown\b/g) * 1.5;
  score += countMatches(t, /\bincompetent\b/g) * 1.0;
  score += countMatches(t, /\bidiotic\b/g) * 1.5;
  score += countMatches(t, /\blaughing at you\b/g) * 2.0;
  score += countMatches(t, /\bprimitive understanding\b/g) * 1.5;
  return Math.min(10, score);
}

/* =========================
   MERGE / NORMALIZE
========================= */

function mergeLocalAndAi(localResult, aiResult) {
  return {
    teamAName: aiResult.teamAName || localResult.teamAName,
    teamBName: aiResult.teamBName || localResult.teamBName,
    analysisMode: "Hybrid",
    confidence: toIntSafeConfidence(aiResult.confidence) ?? localResult.confidence,
    teamAScore: toIntSafe(aiResult.teamAScore) ?? localResult.teamAScore,
    teamBScore: toIntSafe(aiResult.teamBScore) ?? localResult.teamBScore,
    winner: pickWinner(aiResult.winner, localResult.winner),
    teamA_lane: pickBetter(aiResult.teamA_lane, localResult.teamA_lane),
    teamB_lane: pickBetter(aiResult.teamB_lane, localResult.teamB_lane),
    core_disagreement: pickBetter(aiResult.core_disagreement, localResult.core_disagreement),
    teamA: {
      main_position: pickBetter(aiResult.teamA.main_position, localResult.teamA.main_position),
      truth: pickBetter(aiResult.teamA.truth, localResult.teamA.truth),
      lies: pickBetter(aiResult.teamA.lies, localResult.teamA.lies),
      opinion: pickBetter(aiResult.teamA.opinion, localResult.teamA.opinion),
      lala: pickBetter(aiResult.teamA.lala, localResult.teamA.lala)
    },
    teamB: {
      main_position: pickBetter(aiResult.teamB.main_position, localResult.teamB.main_position),
      truth: pickBetter(aiResult.teamB.truth, localResult.teamB.truth),
      lies: pickBetter(aiResult.teamB.lies, localResult.teamB.lies),
      opinion: pickBetter(aiResult.teamB.opinion, localResult.teamB.opinion),
      lala: pickBetter(aiResult.teamB.lala, localResult.teamB.lala)
    },
    teamA_integrity: pickBetter(aiResult.teamA_integrity, localResult.teamA_integrity),
    teamB_integrity: pickBetter(aiResult.teamB_integrity, localResult.teamB_integrity),
    teamA_reasoning: pickBetter(aiResult.teamA_reasoning, localResult.teamA_reasoning),
    teamB_reasoning: pickBetter(aiResult.teamB_reasoning, localResult.teamB_reasoning),
    same_lane_engagement: pickBetter(aiResult.same_lane_engagement, localResult.same_lane_engagement),
    lane_mismatch: pickBetter(aiResult.lane_mismatch, localResult.lane_mismatch),
    strongestArgumentSide: pickStrongestSide(
      aiResult.strongestArgumentSide,
      localResult.strongestArgumentSide
    ),
    strongestArgument: pickBetter(aiResult.strongestArgument, localResult.strongestArgument),
    whyStrongest: pickBetter(aiResult.whyStrongest, localResult.whyStrongest),
    failedResponseByOtherSide: pickBetter(
      aiResult.failedResponseByOtherSide,
      localResult.failedResponseByOtherSide
    ),
    weakestOverall: pickBetter(aiResult.weakestOverall, localResult.weakestOverall),
    manipulation: pickBetter(aiResult.manipulation, localResult.manipulation),
    fluff: pickBetter(aiResult.fluff, localResult.fluff),
    bsMeter: normalizeBsMeter(pickBetter(aiResult.bsMeter, localResult.bsMeter)),
    why: pickBetter(aiResult.why, localResult.why),
    sources: Array.isArray(aiResult.sources) && aiResult.sources.length ? aiResult.sources : localResult.sources
  };
}

function normalizeAiJudgeResult(parsed, context) {
  return {
    teamAName: context.teamAName,
    teamBName: context.teamBName,
    confidence: toIntSafeConfidence(parsed && parsed.confidence),
    teamAScore: toIntSafe(parsed && parsed.teamAScore),
    teamBScore: toIntSafe(parsed && parsed.teamBScore),
    winner: normalizeWinner(parsed && parsed.winner),
    teamA_lane: safeString(parsed && parsed.teamA_lane, "-"),
    teamB_lane: safeString(parsed && parsed.teamB_lane, "-"),
    core_disagreement: safeString(parsed && parsed.core_disagreement, "-"),
    teamA: {
      main_position: safeString(parsed && parsed.teamA_main_position, "-"),
      truth: safeString(parsed && parsed.teamA_truth, "-"),
      lies: safeString(parsed && parsed.teamA_lies, "-"),
      opinion: safeString(parsed && parsed.teamA_opinion, "-"),
      lala: safeString(parsed && parsed.teamA_lala, "-")
    },
    teamB: {
      main_position: safeString(parsed && parsed.teamB_main_position, "-"),
      truth: safeString(parsed && parsed.teamB_truth, "-"),
      lies: safeString(parsed && parsed.teamB_lies, "-"),
      opinion: safeString(parsed && parsed.teamB_opinion, "-"),
      lala: safeString(parsed && parsed.teamB_lala, "-")
    },
    teamA_integrity: safeString(parsed && parsed.teamA_integrity, "-"),
    teamB_integrity: safeString(parsed && parsed.teamB_integrity, "-"),
    teamA_reasoning: safeString(parsed && parsed.teamA_reasoning, "-"),
    teamB_reasoning: safeString(parsed && parsed.teamB_reasoning, "-"),
    same_lane_engagement: safeString(parsed && parsed.same_lane_engagement, "-"),
    lane_mismatch: safeString(parsed && parsed.lane_mismatch, "-"),
    strongestArgumentSide: normalizeStrongestSide(parsed && parsed.strongestArgumentSide),
    strongestArgument: safeString(parsed && parsed.strongestArgument, "-"),
    whyStrongest: safeString(parsed && parsed.whyStrongest, "-"),
    failedResponseByOtherSide: safeString(parsed && parsed.failedResponseByOtherSide, "-"),
    weakestOverall: safeString(parsed && parsed.weakestOverall, "-"),
    manipulation: safeString(parsed && parsed.manipulation, "-"),
    fluff: safeString(parsed && parsed.fluff, "-"),
    bsMeter: normalizeBsMeter(parsed && parsed.bsMeter),
    why: safeString(parsed && parsed.why, "-"),
    sources: []
  };
}

function enforceConsistency(result) {
  const out = JSON.parse(JSON.stringify(result));

  out.teamAScore = clampScore(Number(out.teamAScore || 5));
  out.teamBScore = clampScore(Number(out.teamBScore || 5));
  out.confidence = clampConfidence(Number(out.confidence || 50));
  out.winner = normalizeWinner(out.winner);

  out.teamA = out.teamA || {};
  out.teamB = out.teamB || {};

  out.teamA.main_position = cleanAnalystField(out.teamA.main_position);
  out.teamA.truth = cleanAnalystField(out.teamA.truth);
  out.teamA.lies = cleanAnalystField(out.teamA.lies);
  out.teamA.opinion = cleanAnalystField(out.teamA.opinion);
  out.teamA.lala = cleanAnalystField(out.teamA.lala);

  out.teamB.main_position = cleanAnalystField(out.teamB.main_position);
  out.teamB.truth = cleanAnalystField(out.teamB.truth);
  out.teamB.lies = cleanAnalystField(out.teamB.lies);
  out.teamB.opinion = cleanAnalystField(out.teamB.opinion);
  out.teamB.lala = cleanAnalystField(out.teamB.lala);

  out.teamA_lane = cleanAnalystField(out.teamA_lane);
  out.teamB_lane = cleanAnalystField(out.teamB_lane);
  out.core_disagreement = cleanAnalystField(out.core_disagreement);
  out.teamA_integrity = cleanAnalystField(out.teamA_integrity);
  out.teamB_integrity = cleanAnalystField(out.teamB_integrity);
  out.teamA_reasoning = cleanAnalystField(out.teamA_reasoning);
  out.teamB_reasoning = cleanAnalystField(out.teamB_reasoning);
  out.same_lane_engagement = cleanAnalystField(out.same_lane_engagement);
  out.lane_mismatch = cleanAnalystField(out.lane_mismatch);
  out.strongestArgument = cleanAnalystField(out.strongestArgument);
  out.whyStrongest = cleanAnalystField(out.whyStrongest);
  out.failedResponseByOtherSide = cleanAnalystField(out.failedResponseByOtherSide);
  out.weakestOverall = cleanAnalystField(out.weakestOverall);
  out.manipulation = cleanAnalystField(out.manipulation);
  out.fluff = cleanAnalystField(out.fluff);
  out.bsMeter = normalizeBsMeter(out.bsMeter);
  out.why = cleanAnalystField(out.why);
  out.strongestArgumentSide = normalizeStrongestSide(out.strongestArgumentSide) || "Team A";

  if (out.winner === "Team A" && out.teamAScore <= out.teamBScore) {
    out.teamAScore = clampScore(out.teamBScore + 1);
  }
  if (out.winner === "Team B" && out.teamBScore <= out.teamAScore) {
    out.teamBScore = clampScore(out.teamAScore + 1);
  }

  if (out.winner === "Mixed" && Math.abs(out.teamAScore - out.teamBScore) >= 2) {
    out.winner = out.teamAScore > out.teamBScore ? "Team A" : "Team B";
  }

  return out;
}

function withMode(result, mode) {
  return { ...result, analysisMode: mode };
}

/* =========================
   FALLBACK
========================= */

function buildFallbackResponse(args) {
  return enforceConsistency({
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    analysisMode: "Local",
    confidence: 18,
    teamAScore: 5,
    teamBScore: 5,
    winner: "Mixed",
    teamA_lane: "-",
    teamB_lane: "-",
    core_disagreement: args.reason || "Not enough reliable debate substance was extracted.",
    teamA: {
      main_position: "Not enough clean Team A material extracted.",
      truth: "-",
      lies: "-",
      opinion: "-",
      lala: "-"
    },
    teamB: {
      main_position: "Not enough clean Team B material extracted.",
      truth: "-",
      lies: "-",
      opinion: "-",
      lala: "-"
    },
    teamA_integrity: "-",
    teamB_integrity: "-",
    teamA_reasoning: "-",
    teamB_reasoning: "-",
    same_lane_engagement: "-",
    lane_mismatch: "-",
    strongestArgumentSide: "Team A",
    strongestArgument: "-",
    whyStrongest: "-",
    failedResponseByOtherSide: "-",
    weakestOverall: "-",
    manipulation: "-",
    fluff: "-",
    bsMeter: "Neither side is reaching significantly",
    why: args.reason || "Not enough clean argument content.",
    sources: [
      {
        claim: "No fact-check sources were available",
        type: "general",
        likely_source: "Requires manual review",
        confidence: "low"
      }
    ]
  });
}

/* =========================
   CLEANING / PARSING
========================= */

function cleanTranscript(text) {
  return String(text)
    .replace(/\r/g, "\n")

    .replace(/\b\d{1,2}:\d{2}\d+\s*minute[s]?,\s*\d+\s*second[s]?\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\d+\s*minutes?\b/gi, " ")

    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\s*hour[s]?,\s*\d+\s*minute[s]?,\s*\d+\s*second[s]?\b/gi, " ")
    .replace(/\b\d+\s*minute[s]?,\s*\d+\s*second[s]?\b/gi, " ")
    .replace(/\b\d+\s*minute[s]?\b/gi, " ")
    .replace(/\b\d+\s*second[s]?\b/gi, " ")

    .replace(/\bseconds([A-Za-z])/g, " $1")
    .replace(/\bminutes([A-Za-z])/g, " $1")
    .replace(/\bsecond([A-Za-z])/g, " $1")
    .replace(/\bminute([A-Za-z])/g, " $1")

    .replace(/\b\d{1,2}:\s*,/g, " ")
    .replace(/\b\d{1,2}:\b/g, " ")

    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeBlockText(text) {
  return hardScrubText(String(text))
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => cleanSentence(s))
    .filter((s) => countWords(s) >= 5);
}

function cleanSentence(s) {
  return hardScrubText(String(s))
    .replace(/\s+/g, " ")
    .trim();
}

function hardScrubText(text) {
  return String(text)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐-‒–—]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\b\d+\s*minutes?\b/gi, " ")
    .replace(/\b\d+\s*seconds?\b/gi, " ")
    .replace(/\bseconds([A-Za-z])/g, " $1")
    .replace(/\bminutes([A-Za-z])/g, " $1")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\s+:/g, ":")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function getTranscriptStats(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const words = String(text).split(/\s+/).filter(Boolean);

  return {
    lineCount: lines.length,
    wordCount: words.length
  };
}

function cleanSimpleName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function makeClaim(text) {
  return cleanAnalystField(text)
    .replace(/\bso\b\s*/i, "")
    .replace(/\bwell\b\s*/i, "")
    .replace(/^[,.;:\-\s]+/, "")
    .trim();
}

function cleanAnalystField(value) {
  const text = safeString(value, "-");
  return text
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\b\d+\s*minutes?\b/gi, " ")
    .replace(/\b\d+\s*seconds?\b/gi, " ")
    .replace(/\bseconds([A-Za-z])/g, " $1")
    .replace(/\bminutes([A-Za-z])/g, " $1")
    .replace(/\buh\b/gi, "")
    .replace(/\bum\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .trim() || "-";
}

function containsNameToken(text, name) {
  if (!name) return false;
  const parts = String(name)
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3);

  return parts.some((p) => text.includes(p));
}

function countWords(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function truncate(text, maxLen) {
  const s = safeString(text, "");
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trim() + "…";
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

/* =========================
   SAFE HELPERS
========================= */

function safeJson(response) {
  return response.json().catch(() => null);
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = String(text).indexOf("{");
    const end = String(text).lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(String(text).slice(start, end + 1));
    }
    throw new Error("Invalid JSON");
  }
}

function safeString(value, fallback = "-") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeWinner(value) {
  const v = safeString(value, "Mixed");
  return v === "Team A" || v === "Team B" || v === "Mixed" ? v : "Mixed";
}

function normalizeStrongestSide(value) {
  const v = safeString(value, "");
  return v === "Team A" || v === "Team B" ? v : "";
}

function normalizeBsMeter(value) {
  const v = safeString(value, "Neither side is reaching significantly");
  if (
    v === "Team A is reaching more" ||
    v === "Team B is reaching more" ||
    v === "Neither side is reaching significantly"
  ) {
    return v;
  }
  return "Neither side is reaching significantly";
}

function pickBetter(primary, fallback) {
  return safeString(primary, "-") !== "-" ? primary : fallback;
}

function pickWinner(primary, fallback) {
  return normalizeWinner(primary || fallback);
}

function pickStrongestSide(primary, fallback) {
  return normalizeStrongestSide(primary || fallback);
}

function toIntSafe(value) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return null;
  return clampScore(n);
}

function toIntSafeConfidence(value) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return null;
  return clampConfidence(n);
}

function clampScore(n) {
  if (n < 1) return 1;
  if (n > 10) return 10;
  return Math.round(n);
}

function clampConfidence(n) {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================
   STOPWORDS
========================= */

const STOPWORDS = new Set([
  "that",
  "this",
  "with",
  "have",
  "from",
  "they",
  "them",
  "their",
  "there",
  "would",
  "could",
  "should",
  "about",
  "because",
  "which",
  "while",
  "where",
  "when",
  "what",
  "your",
  "into",
  "these",
  "those",
  "being",
  "through",
  "after",
  "before",
  "against",
  "according",
  "under",
  "over",
  "between",
  "today",
  "says",
  "said",
  "just",
  "really",
  "very",
  "more",
  "most",
  "also",
  "than",
  "such",
  "then"
]);
