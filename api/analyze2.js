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

    if (extracted.teamA.wordCount < 50 || extracted.teamB.wordCount < 50) {
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
      return res.status(200).json(withMode(enforceConsistency(factAdjustedLocal), factCheck.mode));
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
      return res.status(200).json(
        withMode(enforceConsistency(factAdjustedLocal), factCheck.mode)
      );
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
        max_completion_tokens: 1800,
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
    "You are the debate judgment engine for Debate Points.",
    "You are NOT a summarizer.",
    "You are NOT a neutral moderator.",
    "You are delivering a verdict.",
    "",
    "You are judging a debate using:",
    "- cleaned side extractions",
    "- fact-check report",
    "- local baseline analysis",
    "",
    "Your writing must sound decisive, critical, specific, and grounded in what was actually argued.",
    "Do not reward credentials, confidence, aggression, eloquence, popularity, or length by themselves.",
    "Do not invent evidence not present in the extraction, fact-check report, or baseline analysis.",
    "Treat fact-checking as one input, not the whole decision.",
    "",
    "WRITE LIKE THIS:",
    "- blunt",
    "- plain",
    "- sharp",
    "- verdict-driven",
    "- willing to call out failure",
    "",
    "DO NOT WRITE LIKE THIS:",
    "- balanced for no reason",
    "- polite and padded",
    "- vague",
    "- academic",
    "- generic AI summary language",
    "",
    "BANNED LANGUAGE:",
    '- \"contains substantial argument structure\"',
    '- \"moderate lane mismatch\"',
    '- \"both sides had strengths and weaknesses\"',
    '- \"appears to\"',
    '- \"somewhat\"',
    '- \"leans\"',
    '- \"to an extent\"',
    '- \"partially successful\"',
    '- \"no major failed response extracted\"',
    '- \"more context is needed\"',
    '- \"the debate is nuanced\"',
    "",
    "If the output sounds safe, balanced, polite, padded, or academic, it is wrong.",
    "If it sounds like judgment, critique, and decision, it is correct.",
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
    "FIELD RULES:",
    "",
    "winner:",
    "- Pick the side that actually won the exchange.",
    "- Do not force balance.",
    "- If both are weak, still name who did less damage to their own case.",
    "",
    "confidence:",
    "- Use a number from 0 to 100.",
    "",
    "teamAScore / teamBScore:",
    "- Use numbers from 0 to 100.",
    "- Reflect debate performance, not likability.",
    "",
    "teamA_lane / teamB_lane:",
    "- State the actual lane each side is arguing in.",
    "- Be specific.",
    "",
    "core_disagreement:",
    "- State the real issue dividing them.",
    "- Strip away side noise.",
    "",
    "teamA_main_position / teamB_main_position:",
    "- State each side's central claim in plain language.",
    "",
    "teamA_truth / teamB_truth:",
    "- Name what each side got right.",
    "- Be concrete.",
    "",
    "teamA_lies / teamB_lies:",
    "- Name false claims, distortions, dishonest framing, or exaggerations treated like fact.",
    "- If it is exaggeration rather than literal falsehood, say that directly.",
    "",
    "teamA_opinion / teamB_opinion:",
    "- Name what is interpretation, assumption, or viewpoint rather than proof.",
    "",
    "teamA_lala / teamB_lala:",
    "- Call out rhetorical padding, repetition, empty swagger, slogan fog, or fake argument.",
    "",
    "teamA_integrity / teamB_integrity:",
    "- Judge honesty, dodging, manipulation, pressure tactics, and dismissiveness used to avoid answering.",
    "",
    "teamA_reasoning / teamB_reasoning:",
    "- Judge whether the logic actually supports the claim.",
    "- Ask whether the side builds a case or just asserts one.",
    "",
    "same_lane_engagement:",
    "- State clearly whether they are actually arguing the same thing.",
    "",
    "lane_mismatch:",
    "- Explain exactly how the lanes differ.",
    "- Never use vague phrases like moderate lane mismatch.",
    "",
    "strongestArgumentSide:",
    "- Pick which side made the strongest single argument.",
    "",
    "strongestArgument:",
    "- State that argument clearly and specifically.",
    "",
    "whyStrongest:",
    "- Explain why it worked.",
    "",
    "failedResponseByOtherSide:",
    "- This field is mandatory.",
    "- Identify a missed answer, dodge, ignored question, or strong point left standing.",
    "- Never return none or no major failed response.",
    "",
    "weakestOverall:",
    "- This field is mandatory.",
    "- Name the weakest stretch in the whole exchange.",
    "",
    "manipulation:",
    "- Identify pressure tactics, emotional leverage, framing tricks, false binaries, or selective distortions.",
    "",
    "fluff:",
    "- Judge how much of the exchange is padding instead of argument.",
    "",
    "why:",
    "- This is the final verdict.",
    "- It must sound like a judge explaining the decision.",
    "- It must not sound like a summary.",
    "",
    "QUALITY CHECK BEFORE OUTPUT:",
    "- Rewrite any field that sounds generic, padded, neutral, or soft.",
    "- Rewrite any field that hides failure.",
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
        whyStrongest: args.localResult.whyStrongest,
        failedResponseByOtherSide: args.localResult.failedResponseByOtherSide,
        weakestOverall: args.localResult.weakestOverall,
        bsMeter: args.localResult.bsMeter,
        why: args.localResult.why
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
    8
  );

  if (!claims.length) {
    return {
      mode: "Local",
      available: false,
      summary: "No clearly checkable claims were extracted.",
      claims: [],
      teamA: makeFactTally(),
      teamB: makeFactTally()
    };
  }

  if (!process.env.TAVILY_API_KEY) {
    return summarizeFactChecks(
      claims.map((claim) => ({
        ...claim,
        status: "unverified",
        reason: "No fact-check provider configured.",
        evidence: []
      })),
      "Local"
    );
  }

  const checked = [];

  for (const claim of claims) {
    try {
      const result = await verifyClaimWithTavily(claim);
      checked.push(result);
      await sleep(250);
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

function makeFactTally() {
  return {
    supported: 0,
    contradicted: 0,
    unclear: 0,
    tooBroad: 0,
    unverified: 0
  };
}

function summarizeFactChecks(checkedClaims, mode) {
  const summary = {
    mode,
    available: checkedClaims.some((c) => c.status !== "unverified"),
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

function factTallyText(tally) {
  return [
    tally.supported + " supported",
    tally.contradicted + " contradicted",
    tally.unclear + " unclear",
    tally.tooBroad + " too broad",
    tally.unverified + " unverified"
  ].join(", ");
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
  const s = String(sentence || "").toLowerCase();

  if (countWords(s) < 7) return "";
  if (hasAttackLanguage(s)) return "";
  if (hasOpinionLanguage(s)) return "";
  if (hasLalaLanguage(s)) return "";

  if (
    /\b(19|20)\d{2}\b/.test(s) ||
    /\bpublished\b/.test(s) ||
    /\bpeer-reviewed\b/.test(s) ||
    /\bnobel\b/.test(s) ||
    /\bjournal\b/.test(s) ||
    /\bbook\b/.test(s) ||
    /\bphd\b/.test(s)
  ) {
    return "historical / bibliographic";
  }

  if (
    /\bmutation\b/.test(s) ||
    /\bnatural selection\b/.test(s) ||
    /\bgenome\b/.test(s) ||
    /\bcommon ancestry\b/.test(s) ||
    /\bspeciation\b/.test(s) ||
    /\bobserved\b/.test(s) ||
    /\bthere are\b/.test(s)
  ) {
    return "empirical / scientific";
  }

  if (
    /\ball\b/.test(s) ||
    /\bnone\b/.test(s) ||
    /\bzero\b/.test(s) ||
    /\beveryone\b/.test(s) ||
    /\bnobody\b/.test(s)
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
    return cleaned + " source date publication";
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
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function verifyClaimWithTavily(claim) {
  const results = await tavilySearch(claim.query, 4);

  if (!results.length) {
    return {
      ...claim,
      status: "unverified",
      reason: "Search returned no usable evidence.",
      evidence: []
    };
  }

  return scoreEvidenceAgainstClaim(claim, results);
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
  const evidence = results.slice(0, 3).map((r) => ({
    title: r.title,
    url: r.url,
    domain: r.domain,
    snippet: truncate(cleanAnalystField(r.content), 220)
  }));

  if (claim.type === "broad quantitative") {
    return {
      ...claim,
      status: "too_broad",
      reason: "This claim is too broad for high-confidence automatic verification.",
      evidence
    };
  }

  const claimText = String(claim.claim || "").toLowerCase();
  let supportHits = 0;
  let contradictionHits = 0;

  for (const r of results) {
    const text = (r.title + " " + r.content).toLowerCase();
    const important = extractImportantTokens(claimText);
    const tokenHits = important.filter((t) => text.includes(t)).length;

    if (tokenHits >= Math.min(3, important.length || 3)) {
      supportHits += 1;
    }

    if (
      /\bfalse\b|\bincorrect\b|\bnot true\b|\bdebunked\b|\bno evidence\b|\bdisputed\b/.test(text) &&
      tokenHits >= Math.min(2, important.length || 2)
    ) {
      contradictionHits += 1;
    }
  }

  if (supportHits >= 2 && contradictionHits === 0) {
    return {
      ...claim,
      status: "supported",
      reason: "Multiple search results align with the claim.",
      evidence
    };
  }

  if (contradictionHits >= 2 && supportHits === 0) {
    return {
      ...claim,
      status: "contradicted",
      reason: "Multiple search results conflict with the claim.",
      evidence
    };
  }

  if (supportHits >= 1 && contradictionHits >= 1) {
    return {
      ...claim,
      status: "unclear",
      reason: "Search evidence is mixed or ambiguous.",
      evidence
    };
  }

  return {
    ...claim,
    status: "unverified",
    reason: "Automatic verification did not find enough reliable matching evidence.",
    evidence
  };
}

function extractImportantTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 4)
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, 8);
}

function applyFactCheckToResult(result, factCheck, context) {
  const out = clone(result);

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

  if (Math.abs(out.teamAScore - out.teamBScore) >= 3) {
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

  if (!contradicted.length) return existing;

  const best = contradicted[0];
  return cleanAnalystField(
    "Fact-check problem: " + best.claim + " Contradicted. " + best.reason
  );
}

function appendFactSummary(existing, tally, teamName) {
  const additions = [];

  if (tally.supported > 0) additions.push(tally.supported + " supported claim(s)");
  if (tally.contradicted > 0) additions.push(tally.contradicted + " contradicted claim(s)");
  if (tally.tooBroad > 0) additions.push(tally.tooBroad + " claim(s) too broad to verify");

  if (!additions.length) return existing;

  return cleanAnalystField(
    existing + " Fact-check note for " + teamName + ": " + additions.join(", ") + "."
  );
}

function appendOverallFactWhy(existing, factCheck, context) {
  const a = factCheck.teamA;
  const b = factCheck.teamB;

  let addition = "";

  if (a.contradicted > b.contradicted) {
    addition =
      " " +
      context.teamAName +
      " takes more fact-check damage, which weakens its case.";
  } else if (b.contradicted > a.contradicted) {
    addition =
      " " +
      context.teamBName +
      " takes more fact-check damage, which weakens its case.";
  } else if (a.supported > b.supported) {
    addition =
      " " +
      context.teamAName +
      " gets more fact-check support on concrete claims.";
  } else if (b.supported > a.supported) {
    addition =
      " " +
      context.teamBName +
      " gets more fact-check support on concrete claims.";
  }

  return cleanAnalystField((existing || "") + addition);
}

function buildFactSources(factCheck) {
  const out = [];

  for (const claim of factCheck.claims || []) {
    for (const ev of claim.evidence || []) {
      out.push({
        claim: claim.claim,
        type: claim.status,
        likely_source: ev.domain || ev.url || "unknown",
        confidence:
          claim.status === "supported" || claim.status === "contradicted"
            ? "medium"
            : "low",
        title: ev.title || "",
        url: ev.url || ""
      });
    }
  }

  return out.slice(0, 8);
}

/* =========================
   LOCAL ANALYSIS
========================= */

function buildDeterministicResult(args) {
  const teamAText = args.extracted.teamA.text || "";
  const teamBText = args.extracted.teamB.text || "";

  const teamAProfile = buildSideProfile(teamAText, "Team A");
  const teamBProfile = buildSideProfile(teamBText, "Team B");

  const teamAScore = clampScore(
    50 +
      teamAProfile.supportScore +
      teamAProfile.directnessScore -
      teamAProfile.overreachScore -
      Math.round(teamAProfile.fluffScore / 2)
  );

  const teamBScore = clampScore(
    50 +
      teamBProfile.supportScore +
      teamBProfile.directnessScore -
      teamBProfile.overreachScore -
      Math.round(teamBProfile.fluffScore / 2)
  );

  const winner =
    Math.abs(teamAScore - teamBScore) < 3
      ? "Mixed"
      : teamAScore > teamBScore
      ? "Team A"
      : "Team B";

  const strongestSide =
    teamAProfile.bestArgumentScore >= teamBProfile.bestArgumentScore
      ? "Team A"
      : "Team B";

  const strongestProfile =
    strongestSide === "Team A" ? teamAProfile : teamBProfile;

  return enforceConsistency({
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    winner,
    confidence: buildConfidence(teamAScore, teamBScore, teamAProfile, teamBProfile),
    teamAScore,
    teamBScore,

    teamA: {
      main_position: buildMainPosition(teamAText),
      truth: buildTruth(teamAText),
      lies: buildOverreach(teamAText),
      opinion: buildOpinion(teamAText),
      lala: buildLala(teamAText)
    },

    teamB: {
      main_position: buildMainPosition(teamBText),
      truth: buildTruth(teamBText),
      lies: buildOverreach(teamBText),
      opinion: buildOpinion(teamBText),
      lala: buildLala(teamBText)
    },

    teamA_integrity: buildIntegrity(teamAText),
    teamB_integrity: buildIntegrity(teamBText),
    teamA_reasoning: buildReasoning(teamAText),
    teamB_reasoning: buildReasoning(teamBText),

    teamA_lane: detectLane(teamAText),
    teamB_lane: detectLane(teamBText),
    same_lane_engagement: buildSameLaneEngagement(teamAText, teamBText),
    lane_mismatch: buildLaneMismatch(teamAText, teamBText),

    strongestArgumentSide: strongestSide,
    strongestArgument: strongestProfile.bestArgument || "No single strong argument extracted cleanly.",
    whyStrongest: buildWhyStrongest(strongestProfile),
    failedResponseByOtherSide: buildFailedResponse(teamAText, teamBText, strongestSide),
    weakestOverall: buildWeakestOverall(teamAProfile, teamBProfile),

    bsMeter: buildBsMeter(teamAProfile.overreachScore, teamBProfile.overreachScore),
    manipulation: buildManipulation(teamAProfile.pressureScore, teamBProfile.pressureScore),
    fluff: buildFluff(teamAProfile.fluffScore, teamBProfile.fluffScore),

    core_disagreement: buildCoreDisagreement(teamAText, teamBText),
    why: buildWhyWinner(
      winner,
      teamAProfile,
      teamBProfile,
      args.teamAName,
      args.teamBName
    ),

    analysisMode: "Local",
    sources: []
  });
}

function buildSideProfile(text, side) {
  const sentences = splitSentences(text);
  const normalized = normalizeBlockText(text);

  const supportScore =
    Math.min(14, countEvidenceSignals(normalized) + countReasoningSignals(normalized));

  const directnessScore =
    Math.min(8, countDirectAnswerSignals(normalized) + countCounterSignals(normalized));

  const overreachScore =
    Math.min(10, countOverreachSignals(normalized));

  const fluffScore =
    Math.min(10, countFluffSignals(normalized));

  const pressureScore =
    Math.min(10, countPressureSignals(normalized));

  const bestArgument = pickBestArgument(sentences);
  const bestArgumentScore =
    Math.min(
      20,
      scoreSentenceStrength(bestArgument) +
        (bestArgument ? 2 : 0)
    );

  return {
    side,
    supportScore,
    directnessScore,
    overreachScore,
    fluffScore,
    pressureScore,
    bestArgument,
    bestArgumentScore
  };
}

function buildConfidence(teamAScore, teamBScore, a, b) {
  const margin = Math.abs(teamAScore - teamBScore);
  let confidence = 45 + margin * 5;

  if (a.supportScore + b.supportScore >= 18) confidence += 8;
  if (a.overreachScore + b.overreachScore >= 12) confidence -= 5;

  return clampConfidence(confidence);
}

function buildMainPosition(text) {
  const sentence = pickBestArgument(splitSentences(text));
  if (sentence) return cleanAnalystField(sentence);
  return "Main position was not extracted cleanly.";
}

function buildTruth(text) {
  const sentences = splitSentences(text).filter((s) => {
    const t = s.toLowerCase();
    return (
      /\bbecause\b|\btherefore\b|\bfor example\b|\bevidence\b|\bstudy\b|\bdata\b/.test(t) &&
      !hasAttackLanguage(t)
    );
  });

  if (!sentences.length) {
    return "Very little is clearly established with real support.";
  }

  return cleanAnalystField(sentences[0]);
}

function buildOverreach(text) {
  const sentences = splitSentences(text).filter((s) =>
    countOverreachSignals(s.toLowerCase()) > 0
  );

  if (!sentences.length) {
    return "No major overreach stands out from the extracted material.";
  }

  return cleanAnalystField(
    "Overreach problem: " + sentences[0]
  );
}

function buildOpinion(text) {
  const sentences = splitSentences(text).filter((s) =>
    hasOpinionLanguage(s.toLowerCase())
  );

  if (!sentences.length) {
    return "Opinion is present, but not as the main driver.";
  }

  return cleanAnalystField(sentences[0]);
}

function buildLala(text) {
  const sentences = splitSentences(text).filter((s) =>
    hasLalaLanguage(s.toLowerCase()) || countFluffSignals(s.toLowerCase()) >= 2
  );

  if (!sentences.length) {
    return "Low fluff. Most of the material at least tries to argue.";
  }

  return cleanAnalystField(
    "Padding or verbal fog: " + sentences[0]
  );
}

function buildIntegrity(text) {
  const t = normalizeBlockText(text);
  const pressure = countPressureSignals(t);
  const direct = countDirectAnswerSignals(t);
  const attacks = countAttackSignals(t);

  if (pressure >= 4 && direct <= 1) {
    return "Pushes pressure and attitude harder than honest engagement.";
  }

  if (attacks >= 4 && direct <= 1) {
    return "Leans on dismissiveness instead of answering cleanly.";
  }

  if (direct >= 3 && attacks <= 1) {
    return "Answers more directly and stays closer to fair engagement.";
  }

  return "Mixed integrity. There is argument here, but also dodging or framing drift.";
}

function buildReasoning(text) {
  const evidence = countEvidenceSignals(text.toLowerCase());
  const reasoning = countReasoningSignals(text.toLowerCase());
  const overreach = countOverreachSignals(text.toLowerCase());

  if (evidence + reasoning >= 6 && overreach <= 2) {
    return "Builds a real case and stays reasonably tied to its own support.";
  }

  if (evidence + reasoning >= 4 && overreach >= 4) {
    return "Builds part of a case, then stretches beyond what the support can carry.";
  }

  if (evidence + reasoning <= 2) {
    return "Asserts more than it proves. The reasoning stays thin.";
  }

  return "Some reasoning is present, but the structure is uneven and not fully convincing.";
}

function detectLane(text) {
  const t = String(text || "").toLowerCase();

  const empirical =
    countMatches(t, /\bdata\b|\bstudy\b|\bevidence\b|\bscience\b|\bobserved\b|\bexperiment\b/g);
  const philosophical =
    countMatches(t, /\blogic\b|\bcontradiction\b|\bcoherent\b|\bimplies\b|\btherefore\b/g);
  const theological =
    countMatches(t, /\bscripture\b|\bbible\b|\bgod\b|\bjesus\b|\bprophet\b|\btheological\b/g);
  const rhetorical =
    countMatches(t, /\byou just\b|\byou keep\b|\bframing\b|\bspin\b|\brhetoric\b/g);

  const entries = [
    ["empirical / scientific", empirical],
    ["philosophical / logical", philosophical],
    ["theological / scriptural", theological],
    ["rhetorical / persuasive", rhetorical]
  ].sort((a, b) => b[1] - a[1]);

  return entries[0][1] > 0 ? entries[0][0] : "lane not clearly extracted";
}

function buildSameLaneEngagement(teamAText, teamBText) {
  const laneA = detectLane(teamAText);
  const laneB = detectLane(teamBText);

  if (laneA === laneB && laneA !== "lane not clearly extracted") {
    return "Yes. Both sides are fighting over the same claim lane.";
  }

  if (laneA !== laneB) {
    return "No. They are arguing past each other.";
  }

  return "Only partly. The lanes are muddy and the engagement is uneven.";
}

function buildLaneMismatch(teamAText, teamBText) {
  const laneA = detectLane(teamAText);
  const laneB = detectLane(teamBText);

  if (laneA === laneB) {
    return "The main lane is shared. The clash is more about which side supports its claim better.";
  }

  return "They are not arguing the same thing. One side works in " + laneA + " while the other shifts into " + laneB + ".";
}

function buildWhyStrongest(profile) {
  if (!profile.bestArgument) {
    return "No single argument stood out cleanly.";
  }

  if (profile.bestArgumentScore >= 12) {
    return "It lands because it is clear, relevant, and more structured than the rest of the exchange.";
  }

  return "It stands out mostly because the rest of the exchange is weaker or less focused.";
}

function buildFailedResponse(teamAText, teamBText, strongestSide) {
  const otherText = strongestSide === "Team A" ? teamBText : teamAText;
  const normalized = normalizeBlockText(otherText);

  if (countDirectAnswerSignals(normalized) <= 1) {
    return "The strongest challenge is never answered directly. The pressure point is left standing.";
  }

  if (countAttackSignals(normalized) >= 3 && countReasoningSignals(normalized) <= 1) {
    return "The reply shifts into rhetoric and attitude instead of answering the actual challenge.";
  }

  return "The answer is partial at best. The core pressure is softened, not resolved.";
}

function buildWeakestOverall(teamAProfile, teamBProfile) {
  if (teamAProfile.overreachScore >= teamBProfile.overreachScore + 2) {
    return "The weakest stretch is Team A pushing past what its support actually proves.";
  }

  if (teamBProfile.overreachScore >= teamAProfile.overreachScore + 2) {
    return "The weakest stretch is Team B pushing past what its support actually proves.";
  }

  if (teamAProfile.fluffScore + teamBProfile.fluffScore >= 8) {
    return "The weakest stretch is rhetorical padding replacing clean argument.";
  }

  return "The weakest stretch is the jump from assertion to certainty without enough support.";
}

function buildManipulation(teamAPressure, teamBPressure) {
  if (teamAPressure >= 3 && teamBPressure >= 3) {
    return "Dismissive or pressuring rhetoric appears on both sides.";
  }

  if (teamAPressure >= 3) {
    return "Team A uses more pressure, framing, or dismissive rhetoric.";
  }

  if (teamBPressure >= 3) {
    return "Team B uses more pressure, framing, or dismissive rhetoric.";
  }

  return "Manipulation is not central to this exchange.";
}

function buildFluff(teamAFluff, teamBFluff) {
  const total = teamAFluff + teamBFluff;

  if (total >= 12) {
    return "High. Too much filler, repetition, and verbal fog.";
  }

  if (total >= 6) {
    return "Moderate. There is real argument here, but too much padding rides along with it.";
  }

  return "Low. Most of the exchange at least tries to make a case.";
}

function buildBsMeter(teamAOverreach, teamBOverreach) {
  if (teamAOverreach >= teamBOverreach + 2) return "Team A is reaching more";
  if (teamBOverreach >= teamAOverreach + 2) return "Team B is reaching more";
  return "Neither side is reaching significantly";
}

function buildCoreDisagreement(teamAText, teamBText) {
  const a = buildMainPosition(teamAText);
  const b = buildMainPosition(teamBText);

  if (!a || !b) {
    return "Core disagreement was not extracted cleanly.";
  }

  return cleanAnalystField(
    "The dispute is whether " + a + " versus " + b
  );
}

function buildWhyWinner(winner, teamAProfile, teamBProfile, teamAName, teamBName) {
  if (winner === "Team A") {
    return (
      teamAName +
      " wins because it builds the stronger case, stays closer to the actual point, and leaves less unsupported overreach hanging in the air."
    );
  }

  if (winner === "Team B") {
    return (
      teamBName +
      " wins because it builds the stronger case, stays closer to the actual point, and leaves less unsupported overreach hanging in the air."
    );
  }

  return "Neither side cleanly separates. Both land something, but neither takes firm control of the exchange.";
}

/* =========================
   MERGE / NORMALIZE
========================= */

function mergeLocalAndAi(localResult, aiResult) {
  return {
    teamAName: localResult.teamAName,
    teamBName: localResult.teamBName,
    analysisMode: "Hybrid",

    confidence: toIntSafeConfidence(aiResult.confidence) ?? localResult.confidence,
    teamAScore: toIntSafe(aiResult.teamAScore) ?? localResult.teamAScore,
    teamBScore: toIntSafe(aiResult.teamBScore) ?? localResult.teamBScore,
    winner: pickWinner(aiResult.winner, localResult.winner),

    teamA_lane: preferAiText(aiResult.teamA_lane, localResult.teamA_lane),
    teamB_lane: preferAiText(aiResult.teamB_lane, localResult.teamB_lane),
    core_disagreement: preferAiText(aiResult.core_disagreement, localResult.core_disagreement),

    teamA: {
      main_position: preferAiText(aiResult.teamA.main_position, localResult.teamA.main_position),
      truth: preferAiText(aiResult.teamA.truth, localResult.teamA.truth),
      lies: preferAiText(aiResult.teamA.lies, localResult.teamA.lies),
      opinion: preferAiText(aiResult.teamA.opinion, localResult.teamA.opinion),
      lala: preferAiText(aiResult.teamA.lala, localResult.teamA.lala)
    },

    teamB: {
      main_position: preferAiText(aiResult.teamB.main_position, localResult.teamB.main_position),
      truth: preferAiText(aiResult.teamB.truth, localResult.teamB.truth),
      lies: preferAiText(aiResult.teamB.lies, localResult.teamB.lies),
      opinion: preferAiText(aiResult.teamB.opinion, localResult.teamB.opinion),
      lala: preferAiText(aiResult.teamB.lala, localResult.teamB.lala)
    },

    teamA_integrity: preferAiText(aiResult.teamA_integrity, localResult.teamA_integrity),
    teamB_integrity: preferAiText(aiResult.teamB_integrity, localResult.teamB_integrity),
    teamA_reasoning: preferAiText(aiResult.teamA_reasoning, localResult.teamA_reasoning),
    teamB_reasoning: preferAiText(aiResult.teamB_reasoning, localResult.teamB_reasoning),

    same_lane_engagement: preferAiText(aiResult.same_lane_engagement, localResult.same_lane_engagement),
    lane_mismatch: preferAiText(aiResult.lane_mismatch, localResult.lane_mismatch),

    strongestArgumentSide: normalizeStrongestSide(
      aiResult.strongestArgumentSide || localResult.strongestArgumentSide
    ),
    strongestArgument: preferAiText(aiResult.strongestArgument, localResult.strongestArgument),
    whyStrongest: preferAiText(aiResult.whyStrongest, localResult.whyStrongest),
    failedResponseByOtherSide: preferAiText(
      forceFailedResponse(aiResult.failedResponseByOtherSide, localResult),
      localResult.failedResponseByOtherSide
    ),
    weakestOverall: preferAiText(
      forceWeakestOverall(aiResult.weakestOverall, localResult),
      localResult.weakestOverall
    ),

    bsMeter: normalizeBsMeter(aiResult.bsMeter || localResult.bsMeter),
    manipulation: preferAiText(aiResult.manipulation, localResult.manipulation),
    fluff: preferAiText(aiResult.fluff, localResult.fluff),

    why: preferAiText(aiResult.why, localResult.why),

    sources:
      Array.isArray(localResult.sources) && localResult.sources.length
        ? localResult.sources
        : Array.isArray(aiResult.sources)
        ? aiResult.sources
        : []
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

    teamA_lane: safeString(parsed && parsed.teamA_lane, ""),
    teamB_lane: safeString(parsed && parsed.teamB_lane, ""),
    core_disagreement: safeString(parsed && parsed.core_disagreement, ""),

    teamA: {
      main_position: safeString(parsed && parsed.teamA_main_position, ""),
      truth: safeString(parsed && parsed.teamA_truth, ""),
      lies: safeString(parsed && parsed.teamA_lies, ""),
      opinion: safeString(parsed && parsed.teamA_opinion, ""),
      lala: safeString(parsed && parsed.teamA_lala, "")
    },

    teamB: {
      main_position: safeString(parsed && parsed.teamB_main_position, ""),
      truth: safeString(parsed && parsed.teamB_truth, ""),
      lies: safeString(parsed && parsed.teamB_lies, ""),
      opinion: safeString(parsed && parsed.teamB_opinion, ""),
      lala: safeString(parsed && parsed.teamB_lala, "")
    },

    teamA_integrity: safeString(parsed && parsed.teamA_integrity, ""),
    teamB_integrity: safeString(parsed && parsed.teamB_integrity, ""),
    teamA_reasoning: safeString(parsed && parsed.teamA_reasoning, ""),
    teamB_reasoning: safeString(parsed && parsed.teamB_reasoning, ""),

    same_lane_engagement: safeString(parsed && parsed.same_lane_engagement, ""),
    lane_mismatch: safeString(parsed && parsed.lane_mismatch, ""),

    strongestArgumentSide: normalizeStrongestSide(parsed && parsed.strongestArgumentSide),
    strongestArgument: safeString(parsed && parsed.strongestArgument, ""),
    whyStrongest: safeString(parsed && parsed.whyStrongest, ""),
    failedResponseByOtherSide: safeString(parsed && parsed.failedResponseByOtherSide, ""),
    weakestOverall: safeString(parsed && parsed.weakestOverall, ""),

    manipulation: safeString(parsed && parsed.manipulation, ""),
    fluff: safeString(parsed && parsed.fluff, ""),
    bsMeter: normalizeBsMeter(parsed && parsed.bsMeter),
    why: safeString(parsed && parsed.why, ""),
    sources: []
  };
}

function enforceConsistency(result) {
  const out = clone(result || {});

  out.teamAName = safeString(out.teamAName, "Team A");
  out.teamBName = safeString(out.teamBName, "Team B");
  out.analysisMode = safeString(out.analysisMode, "Local");
  out.confidence = clampConfidence(Number(out.confidence || 50));
  out.teamAScore = clampScore(Number(out.teamAScore || 50));
  out.teamBScore = clampScore(Number(out.teamBScore || 50));
  out.winner = normalizeWinner(out.winner);

  out.teamA_lane = cleanVerdictField(out.teamA_lane, "Lane not clearly extracted.");
  out.teamB_lane = cleanVerdictField(out.teamB_lane, "Lane not clearly extracted.");
  out.core_disagreement = cleanVerdictField(
    out.core_disagreement,
    "Core disagreement was not extracted cleanly."
  );

  out.teamA = ensureTeamSection(out.teamA);
  out.teamB = ensureTeamSection(out.teamB);

  out.teamA_integrity = cleanVerdictField(
    out.teamA_integrity,
    "Integrity was not clearly extracted for Team A."
  );
  out.teamB_integrity = cleanVerdictField(
    out.teamB_integrity,
    "Integrity was not clearly extracted for Team B."
  );
  out.teamA_reasoning = cleanVerdictField(
    out.teamA_reasoning,
    "Reasoning was not clearly extracted for Team A."
  );
  out.teamB_reasoning = cleanVerdictField(
    out.teamB_reasoning,
    "Reasoning was not clearly extracted for Team B."
  );

  out.same_lane_engagement = cleanVerdictField(
    out.same_lane_engagement,
    "Lane engagement was not clearly extracted."
  );
  out.lane_mismatch = cleanVerdictField(
    out.lane_mismatch,
    "Lane mismatch was not clearly extracted."
  );

  out.strongestArgumentSide = normalizeStrongestSide(out.strongestArgumentSide);
  out.strongestArgument = cleanVerdictField(
    out.strongestArgument,
    "No single strong argument was extracted cleanly."
  );
  out.whyStrongest = cleanVerdictField(
    out.whyStrongest,
    "Why the strongest argument worked was not extracted cleanly."
  );

  out.failedResponseByOtherSide = cleanVerdictField(
    forceFailedResponse(out.failedResponseByOtherSide, out),
    "A direct answer was missed, but the exact failure was not extracted cleanly."
  );

  out.weakestOverall = cleanVerdictField(
    forceWeakestOverall(out.weakestOverall, out),
    "The weakest stretch was poor support or rhetorical padding."
  );

  out.manipulation = cleanVerdictField(
    out.manipulation,
    "Manipulation was not central."
  );

  out.fluff = cleanVerdictField(
    out.fluff,
    "Fluff level was not clearly extracted."
  );

  out.bsMeter = normalizeBsMeter(out.bsMeter);
  out.why = cleanVerdictField(
    out.why,
    buildFallbackWhy(out)
  );

  if (!Array.isArray(out.sources)) {
    out.sources = [];
  }

  if (out.winner === "Mixed") {
    if (out.teamAScore >= out.teamBScore + 3) out.winner = "Team A";
    if (out.teamBScore >= out.teamAScore + 3) out.winner = "Team B";
  }

  if (out.strongestArgumentSide !== "Team A" && out.strongestArgumentSide !== "Team B") {
    out.strongestArgumentSide =
      out.teamAScore >= out.teamBScore ? "Team A" : "Team B";
  }

  return out;
}

function ensureTeamSection(team) {
  const t = team || {};
  return {
    main_position: cleanVerdictField(
      t.main_position,
      "Main position was not extracted cleanly."
    ),
    truth: cleanVerdictField(
      t.truth,
      "Very little was clearly established as true."
    ),
    lies: cleanVerdictField(
      t.lies,
      "No clear falsehood or overreach was isolated."
    ),
    opinion: cleanVerdictField(
      t.opinion,
      "Opinion was not isolated cleanly."
    ),
    lala: cleanVerdictField(
      t.lala,
      "No major rhetorical padding was isolated."
    )
  };
}

function preferAiText(aiValue, localValue) {
  const ai = cleanVerdictCandidate(aiValue);
  const local = cleanVerdictCandidate(localValue);

  if (!ai) return local || "-";
  if (!local) return ai;

  if (isWeakGeneric(ai) && !isWeakGeneric(local)) return local;
  if (!isWeakGeneric(ai) && isWeakGeneric(local)) return ai;
  if (ai.length >= local.length * 0.7) return ai;
  return local;
}

function cleanVerdictCandidate(value) {
  if (value == null) return "";
  let text = String(value).trim();
  if (!text || text === "-" || /^n\/a$/i.test(text)) return "";
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function cleanVerdictField(value, fallback) {
  const text = cleanVerdictCandidate(value);
  if (!text) return fallback;
  if (/^no major failed response/i.test(text)) return fallback;
  if (/^none$/i.test(text)) return fallback;
  if (/^unknown$/i.test(text)) return fallback;
  return text;
}

function forceFailedResponse(value, result) {
  const current = cleanVerdictCandidate(value);
  if (
    current &&
    !/^none$/i.test(current) &&
    !/no major failed response/i.test(current)
  ) {
    return current;
  }

  if (result && result.strongestArgument) {
    return "The strongest challenge is not answered directly. The pressure point is left standing instead of resolved.";
  }

  return "A direct challenge goes unanswered, and the exchange moves on without a clean reply.";
}

function forceWeakestOverall(value, result) {
  const current = cleanVerdictCandidate(value);
  if (current && !/^none$/i.test(current)) return current;

  if (result && result.bsMeter === "Team A is reaching more") {
    return "The weakest stretch is Team A pushing past what the support actually proves.";
  }

  if (result && result.bsMeter === "Team B is reaching more") {
    return "The weakest stretch is Team B pushing past what the support actually proves.";
  }

  return "The weakest stretch is rhetorical padding replacing a clean argument.";
}

function buildFallbackWhy(result) {
  const a = Number(result.teamAScore || 0);
  const b = Number(result.teamBScore || 0);

  if (a >= b + 3) {
    return (
      result.teamAName +
      " wins because it makes the stronger case, stays closer to the real point, and leaves less unsupported overreach hanging in the air."
    );
  }

  if (b >= a + 3) {
    return (
      result.teamBName +
      " wins because it makes the stronger case, stays closer to the real point, and leaves less unsupported overreach hanging in the air."
    );
  }

  return "The exchange is close, but neither side cleanly dominates every category.";
}

function normalizeWinner(value) {
  const v = String(value || "").trim();
  if (v === "Team A" || v === "Team B" || v === "Mixed") return v;
  return "Mixed";
}

function pickWinner(aiWinner, localWinner) {
  const normalizedAi = normalizeWinner(aiWinner);
  if (normalizedAi !== "Mixed") return normalizedAi;
  return normalizeWinner(localWinner);
}

function normalizeStrongestSide(value) {
  const v = String(value || "").trim();
  if (v === "Team A" || v === "Team B") return v;
  return "";
}

function normalizeBsMeter(value) {
  const v = String(value || "").trim();
  if (v === "Team A is reaching more") return v;
  if (v === "Team B is reaching more") return v;
  return "Neither side is reaching significantly";
}

function isWeakGeneric(text) {
  const t = String(text || "").toLowerCase();

  return [
    "contains substantial argument structure",
    "moderate lane mismatch",
    "both sides had strengths and weaknesses",
    "appears to",
    "somewhat",
    "leans",
    "to an extent",
    "partially successful",
    "no major failed response extracted",
    "more context is needed",
    "the debate is nuanced",
    "important points on both sides",
    "not enough information"
  ].some((bad) => t.includes(bad));
}

function withMode(result, mode) {
  return {
    ...result,
    analysisMode: safeString(mode, "Local")
  };
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
    sources: []
  });
}

/* =========================
   TRANSCRIPT CLEANING / EXTRACTION
========================= */

function cleanTranscript(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\s*minute[s]?\b/gi, " ")
    .replace(/\b\d+\s*second[s]?\b/gi, " ")
    .replace(/\[music\]|\[applause\]|\[laughter\]/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getTranscriptStats(text) {
  const lines = String(text || "")
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    lineCount: lines.length,
    wordCount: countWords(text)
  };
}

function extractDebateSides(args) {
  const transcript = String(args.transcript || "");
  const lines = transcript
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const bucketA = [];
  const bucketB = [];
  let fallbackToggle = 0;

  for (const line of lines) {
    const lower = line.toLowerCase();

    const aPatterns = [
      args.teamAName.toLowerCase() + ":",
      "team a:",
      "speaker a:",
      "a:",
      "pro:",
      "affirmative:"
    ];

    const bPatterns = [
      args.teamBName.toLowerCase() + ":",
      "team b:",
      "speaker b:",
      "b:",
      "con:",
      "negative:"
    ];

    const matchedA = aPatterns.some((p) => lower.startsWith(p));
    const matchedB = bPatterns.some((p) => lower.startsWith(p));

    if (matchedA) {
      bucketA.push(stripSpeakerPrefix(line));
      continue;
    }

    if (matchedB) {
      bucketB.push(stripSpeakerPrefix(line));
      continue;
    }

    if (/^moderator:|^host:|^interviewer:|^audience:/i.test(lower)) {
      continue;
    }

    if (countWords(line) < 4) continue;

    if (fallbackToggle % 2 === 0) bucketA.push(line);
    else bucketB.push(line);

    fallbackToggle += 1;
  }

  const textA = normalizeBlockText(bucketA.join(" "));
  const textB = normalizeBlockText(bucketB.join(" "));

  return {
    teamA: {
      text: textA,
      wordCount: countWords(textA)
    },
    teamB: {
      text: textB,
      wordCount: countWords(textB)
    }
  };
}

function stripSpeakerPrefix(line) {
  return String(line || "").replace(/^[^:]{1,60}:\s*/, "").trim();
}

function normalizeBlockText(text) {
  return hardScrubText(String(text || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function hardScrubText(text) {
  return String(text || "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   SIGNAL SCORING
========================= */

function countEvidenceSignals(text) {
  return Math.min(
    8,
    countMatches(text, /\bevidence\b/g) +
      countMatches(text, /\bdata\b/g) +
      countMatches(text, /\bstudy\b/g) +
      countMatches(text, /\bfor example\b/g) +
      countMatches(text, /\bobserved\b/g) +
      countMatches(text, /\bfact\b/g)
  );
}

function countReasoningSignals(text) {
  return Math.min(
    8,
    countMatches(text, /\bbecause\b/g) +
      countMatches(text, /\btherefore\b/g) +
      countMatches(text, /\bwhich means\b/g) +
      countMatches(text, /\bif\b/g) +
      countMatches(text, /\bthen\b/g)
  );
}

function countDirectAnswerSignals(text) {
  return Math.min(
    6,
    countMatches(text, /\byes\b/g) +
      countMatches(text, /\bno\b/g) +
      countMatches(text, /\bdirectly\b/g) +
      countMatches(text, /\bthe answer\b/g) +
      countMatches(text, /\bi answered\b/g)
  );
}

function countCounterSignals(text) {
  return Math.min(
    6,
    countMatches(text, /\byou said\b/g) +
      countMatches(text, /\byour claim\b/g) +
      countMatches(text, /\bthat does not follow\b/g) +
      countMatches(text, /\bthat is false\b/g)
  );
}

function countOverreachSignals(text) {
  return Math.min(
    10,
    countMatches(text, /\ball\b/g) +
      countMatches(text, /\bnone\b/g) +
      countMatches(text, /\beveryone\b/g) +
      countMatches(text, /\bnobody\b/g) +
      countMatches(text, /\bproves\b/g) +
      countMatches(text, /\bobviously\b/g) +
      countMatches(text, /\bclearly\b/g) +
      countMatches(text, /\balways\b/g) +
      countMatches(text, /\bnever\b/g)
  );
}

function countFluffSignals(text) {
  return Math.min(
    10,
    countMatches(text, /\bbasically\b/g) +
      countMatches(text, /\bliterally\b/g) +
      countMatches(text, /\byou know\b/g) +
      countMatches(text, /\bi mean\b/g) +
      countMatches(text, /\bat the end of the day\b/g) +
      countMatches(text, /\bthe fact of the matter\b/g)
  );
}

function countPressureSignals(text) {
  return Math.min(
    10,
    countMatches(text, /\bcoward\b/g) +
      countMatches(text, /\bclown\b/g) +
      countMatches(text, /\bstupid\b/g) +
      countMatches(text, /\bidiot\b/g) +
      countMatches(text, /\bdumb\b/g) +
      countMatches(text, /\byou just\b/g) +
      countMatches(text, /\byou keep\b/g)
  );
}

function countAttackSignals(text) {
  return Math.min(
    10,
    countMatches(text, /\bidiot\b/g) +
      countMatches(text, /\bstupid\b/g) +
      countMatches(text, /\bdumb\b/g) +
      countMatches(text, /\bclown\b/g) +
      countMatches(text, /\bcoward\b/g)
  );
}

function hasAttackLanguage(text) {
  return countAttackSignals(text) > 0;
}

function hasOpinionLanguage(text) {
  return /\bi think\b|\bi believe\b|\bin my view\b|\bprobably\b|\bmaybe\b|\bseems\b/.test(text);
}

function hasLalaLanguage(text) {
  return /\byou know\b|\bi mean\b|\bat the end of the day\b|\bbasically\b/.test(text);
}

/* =========================
   SENTENCE HELPERS
========================= */

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => countWords(s) >= 4)
    .slice(0, 60);
}

function pickBestArgument(sentences) {
  const scored = sentences
    .map((s) => ({ s, score: scoreSentenceStrength(s) }))
    .sort((a, b) => b.score - a.score);

  return scored.length ? scored[0].s : "";
}

function scoreSentenceStrength(sentence) {
  const s = String(sentence || "").toLowerCase();
  return (
    countEvidenceSignals(s) * 2 +
    countReasoningSignals(s) * 2 +
    countCounterSignals(s) -
    countFluffSignals(s) -
    countAttackSignals(s)
  );
}

/* =========================
   LOW LEVEL HELPERS
========================= */

function safeParseJson(text) {
  try {
    return JSON.parse(extractJsonObject(text));
  } catch (err) {
    return {};
  }
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return "{}";
  return raw.slice(first, last + 1);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (err) {
    return null;
  }
}

function cleanSimpleName(value) {
  return String(value || "")
    .replace(/[^\w\s\-'.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function cleanAnalystField(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function safeString(value, fallback) {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s ? s : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function countMatches(text, regex) {
  const m = String(text || "").match(regex);
  return m ? m.length : 0;
}

function truncate(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
}

function toIntSafe(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function toIntSafeConfidence(value) {
  const n = toIntSafe(value);
  if (n == null) return null;
  return clampConfidence(n);
}

function clampScore(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function clampConfidence(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (err) {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STOPWORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "they",
  "them",
  "then",
  "than",
  "there",
  "their",
  "would",
  "could",
  "should",
  "about",
  "because",
  "which",
  "where",
  "when",
  "what",
  "into",
  "your",
  "just",
  "more",
  "most",
  "very",
  "only",
  "does",
  "did",
  "been",
  "being",
  "also",
  "such",
  "much"
]);
