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

    if (stats.wordCount < 40 || stats.lineCount < 2) {
      return res.status(400).json({
        error:
          "This does not look like a usable debate transcript yet. Paste actual spoken exchange, not metadata or junk."
      });
    }

    const localResult = buildDeterministicResult({
      teamAName,
      teamBName,
      transcript: cleanedTranscript,
      videoLink
    });

    if (!process.env.GROQ_API_KEY) {
      return res.status(200).json(localResult);
    }

    try {
      const chunks = chunkTranscript(cleanedTranscript, 900);
      const chunkResults = [];

      for (let i = 0; i < chunks.length; i += 1) {
        await sleep(1400);

        const chunkPrompt = buildChunkPrompt({
          teamAName,
          teamBName,
          chunkText: chunks[i],
          chunkNumber: i + 1,
          totalChunks: chunks.length
        });

        const chunkResponse = await callGroq(chunkPrompt);

        if (!chunkResponse.ok) {
          return res.status(200).json(withMode(localResult, "Local"));
        }

        let parsedChunk;
        try {
          parsedChunk = safeParseJson(chunkResponse.content);
        } catch (err) {
          return res.status(200).json(withMode(localResult, "Local"));
        }

        chunkResults.push(normalizeChunkResult(parsedChunk));
      }

      await sleep(1800);

      const judgePrompt = buildJudgePrompt({
        teamAName,
        teamBName,
        videoLink,
        chunkResults
      });

      const judgeResponse = await callGroq(judgePrompt);

      if (!judgeResponse.ok) {
        return res.status(200).json(withMode(localResult, "Local"));
      }

      let parsedJudge;
      try {
        parsedJudge = safeParseJson(judgeResponse.content);
      } catch (err) {
        return res.status(200).json(withMode(localResult, "Local"));
      }

      const aiResult = normalizeAiJudgeResult(parsedJudge, {
        teamAName,
        teamBName
      });

      const merged = mergeLocalAndAi(localResult, aiResult);
      const consistent = enforceConsistency(merged);

      return res.status(200).json(withMode(consistent, "Hybrid"));
    } catch (err) {
      return res.status(200).json(withMode(localResult, "Local"));
    }
  } catch (err) {
    return res.status(200).json(
      buildFallbackResponse({
        teamAName: "Team A",
        teamBName: "Team B",
        reason: "Unexpected backend failure."
      })
    );
  }
};

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
        max_completion_tokens: 650,
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
      const message =
        (raw && raw.error && raw.error.message) ||
        (raw && raw.message) ||
        "Groq request failed";

      return {
        ok: false,
        error: message
      };
    }

    const content =
      raw &&
      raw.choices &&
      raw.choices[0] &&
      raw.choices[0].message &&
      raw.choices[0].message.content;

    if (!content) {
      return {
        ok: false,
        error: "Groq returned no message content."
      };
    }

    return {
      ok: true,
      content
    };
  } catch (err) {
    return {
      ok: false,
      error: "Network/provider request failed."
    };
  }
}

function buildChunkPrompt(args) {
  return [
    "Return ONLY valid JSON.",
    "No markdown.",
    "No code fences.",
    "No text before JSON.",
    "No text after JSON.",
    "",
    "Analyze one chunk of a debate.",
    "",
    "Rules:",
    "- Do not quote transcript text directly.",
    "- Do not include timestamps.",
    "- Do not include speaker tags.",
    "- Rewrite into clean short analyst language.",
    "- Be clear and decisive.",
    "",
    "Return exactly this shape:",
    "{",
    '  "teamA": {',
    '    "main_points": [],',
    '    "truth_points": [],',
    '    "lie_points": [],',
    '    "opinion_points": [],',
    '    "lala_points": []',
    "  },",
    '  "teamB": {',
    '    "main_points": [],',
    '    "truth_points": [],',
    '    "lie_points": [],',
    '    "opinion_points": [],',
    '    "lala_points": []',
    "  },",
    '  "winnerLean": "",',
    '  "bestPoint": "",',
    '  "worstPoint": "",',
    '  "manipulation": "",',
    '  "fluff": ""',
    "}",
    "",
    "Meaning:",
    "- main_points: core claim",
    "- truth_points: grounded point",
    "- lie_points: unsupported or overstated point",
    "- opinion_points: personal framing",
    "- lala_points: absurd leap",
    "",
    'winnerLean must be exactly "Team A", "Team B", or "Mixed".',
    "",
    "Team A: " + args.teamAName,
    "Team B: " + args.teamBName,
    "Chunk " + args.chunkNumber + " of " + args.totalChunks,
    "",
    "Chunk text:",
    args.chunkText
  ].join("\n");
}

function buildJudgePrompt(args) {
  return [
    "Return ONLY valid JSON.",
    "No markdown.",
    "No code fences.",
    "No text before JSON.",
    "No text after JSON.",
    "",
    "You are the final judge of a debate.",
    "",
    "Rules:",
    "- Do not quote transcript text directly.",
    "- Do not include timestamps.",
    "- Do not include speaker tags.",
    "- Rewrite every field in clean analyst language.",
    "- Make a decision.",
    '- Use "Mixed" only if neither side truly has the edge.',
    "- If one side has the stronger argument and the other side reaches more, do not hide behind Mixed.",
    "- Winner must match score advantage.",
    "- Do not be vague.",
    "",
    "Return exactly this shape:",
    "{",
    '  "teamAName": "",',
    '  "teamBName": "",',
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
    '  "teamAScore": 0,',
    '  "teamBScore": 0,',
    '  "winner": "",',
    '  "strongestArgumentSide": "",',
    '  "strongestArgument": "",',
    '  "whyStrongest": "",',
    '  "failedResponseByOtherSide": "",',
    '  "bsMeter": "",',
    '  "strongestOverall": "",',
    '  "weakestOverall": "",',
    '  "why": "",',
    '  "manipulation": "",',
    '  "fluff": ""',
    "}",
    "",
    "Field meaning:",
    "- main position: one clear short claim",
    "- truth: one grounded point",
    "- lies: one unsupported or overstated point",
    "- opinion: one subjective frame",
    "- lala: one unsupported leap",
    "- strongestArgument: clean statement of best argument",
    "- whyStrongest: say exactly why it beats the other side",
    "- failedResponseByOtherSide: what the weaker side failed to answer",
    "- weakestOverall: weakest bad argument in the debate",
    "",
    '- strongestArgumentSide must be exactly "Team A" or "Team B".',
    '- winner must be exactly "Team A", "Team B", or "Mixed".',
    '- bsMeter must be exactly one of:',
    '  "Team A is reaching more"',
    '  "Team B is reaching more"',
    '  "Neither side is reaching significantly"',
    "",
    "Team A: " + args.teamAName,
    "Team B: " + args.teamBName,
    "Optional link: " + (args.videoLink || "none"),
    "",
    "Chunk analyses:",
    JSON.stringify(args.chunkResults, null, 2)
  ].join("\n");
}

function buildDeterministicResult(args) {
  const lines = splitDialogueLines(args.transcript);
  const split = splitLinesIntoSides(lines);

  const teamAText = split.teamA.join(" ");
  const teamBText = split.teamB.join(" ");

  const usedA = createUsedTracker();
  const usedB = createUsedTracker();

  let teamAScore = clampScore(5 + supportScore(teamAText) - weaknessScore(teamAText));
  let teamBScore = clampScore(5 + supportScore(teamBText) - weaknessScore(teamBText));

  const strongest = pickStrongestArgument(teamAText, teamBText);
  const bsMeter = buildBsMeter(weaknessScore(teamAText), weaknessScore(teamBText));

  let winner = "Mixed";
  if (teamAScore >= teamBScore + 2) winner = "Team A";
  if (teamBScore >= teamAScore + 2) winner = "Team B";

  if (winner === "Mixed") {
    if (strongest.side === "Team A" && bsMeter === "Team B is reaching more") {
      winner = "Team A";
    } else if (strongest.side === "Team B" && bsMeter === "Team A is reaching more") {
      winner = "Team B";
    }
  }

  if (winner === "Team A" && teamAScore <= teamBScore) teamAScore = Math.min(10, teamBScore + 1);
  if (winner === "Team B" && teamBScore <= teamAScore) teamBScore = Math.min(10, teamAScore + 1);
  if (winner === "Mixed") {
    const even = Math.max(Math.min(teamAScore, teamBScore), 6);
    teamAScore = even;
    teamBScore = even;
  }

  const result = {
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    analysisMode: "Local",
    teamA: {
      main_position: summarizeMainPosition(teamAText, usedA),
      truth: detectReasonableClaims(teamAText, usedA),
      lies: detectWeakClaims(teamAText, usedA),
      opinion: detectOpinion(teamAText, usedA),
      lala: detectLala(teamAText, usedA)
    },
    teamB: {
      main_position: summarizeMainPosition(teamBText, usedB),
      truth: detectReasonableClaims(teamBText, usedB),
      lies: detectWeakClaims(teamBText, usedB),
      opinion: detectOpinion(teamBText, usedB),
      lala: detectLala(teamBText, usedB)
    },
    teamAScore,
    teamBScore,
    winner,
    strongestArgumentSide: strongest.side,
    strongestArgument: strongest.text,
    whyStrongest: buildWhyStrongest(strongest.side, args.teamAName, args.teamBName),
    failedResponseByOtherSide: buildFailedResponse(strongest.side, args.teamAName, args.teamBName),
    bsMeter,
    strongestOverall:
      strongest.side === "Team A"
        ? args.teamAName + ": " + strongest.text
        : args.teamBName + ": " + strongest.text,
    weakestOverall: buildWeakestOverall(
      weaknessScore(teamAText),
      weaknessScore(teamBText),
      args.teamAName,
      args.teamBName
    ),
    why: buildWhy(winner, args.teamAName, args.teamBName),
    manipulation: buildManipulation(teamAText, teamBText),
    fluff: buildFluff(countFluff(teamAText), countFluff(teamBText)),
    sources: [
      {
        claim: "Deterministic analysis uses transcript patterns, not outside fact-checking",
        type: "general",
        likely_source: "Manual review needed",
        confidence: "medium"
      }
    ]
  };

  return enforceConsistency(result);
}

function mergeLocalAndAi(localResult, aiResult) {
  return {
    teamAName: aiResult.teamAName || localResult.teamAName,
    teamBName: aiResult.teamBName || localResult.teamBName,
    analysisMode: "Hybrid",
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
    teamAScore: isValidNumber(aiResult.teamAScore) ? aiResult.teamAScore : localResult.teamAScore,
    teamBScore: isValidNumber(aiResult.teamBScore) ? aiResult.teamBScore : localResult.teamBScore,
    winner: pickWinner(aiResult.winner, localResult.winner),
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
    bsMeter: normalizeBsMeter(pickBetter(aiResult.bsMeter, localResult.bsMeter)),
    strongestOverall: pickBetter(aiResult.strongestOverall, localResult.strongestOverall),
    weakestOverall: pickBetter(aiResult.weakestOverall, localResult.weakestOverall),
    why: pickBetter(aiResult.why, localResult.why),
    manipulation: pickBetter(aiResult.manipulation, localResult.manipulation),
    fluff: pickBetter(aiResult.fluff, localResult.fluff),
    sources: localResult.sources
  };
}

function enforceConsistency(result) {
  const out = JSON.parse(JSON.stringify(result));

  out.teamAScore = clampScore(Number(out.teamAScore || 5));
  out.teamBScore = clampScore(Number(out.teamBScore || 5));

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

  out.strongestArgument = cleanAnalystField(out.strongestArgument);
  out.strongestOverall = cleanAnalystField(out.strongestOverall);
  out.weakestOverall = cleanAnalystField(out.weakestOverall);
  out.failedResponseByOtherSide = cleanAnalystField(out.failedResponseByOtherSide);
  out.whyStrongest = cleanAnalystField(out.whyStrongest);
  out.why = cleanAnalystField(out.why);
  out.manipulation = cleanAnalystField(out.manipulation);
  out.fluff = cleanAnalystField(out.fluff);
  out.bsMeter = normalizeBsMeter(out.bsMeter);

  if (out.winner === "Team A" && out.teamAScore <= out.teamBScore) {
    out.teamAScore = Math.min(10, out.teamBScore + 1);
  }

  if (out.winner === "Team B" && out.teamBScore <= out.teamAScore) {
    out.teamBScore = Math.min(10, out.teamAScore + 1);
  }

  if (
    out.winner === "Mixed" &&
    out.strongestArgumentSide === "Team A" &&
    out.bsMeter === "Team B is reaching more"
  ) {
    out.winner = "Team A";
    if (out.teamAScore <= out.teamBScore) {
      out.teamAScore = Math.min(10, out.teamBScore + 1);
    }
  }

  if (
    out.winner === "Mixed" &&
    out.strongestArgumentSide === "Team B" &&
    out.bsMeter === "Team A is reaching more"
  ) {
    out.winner = "Team B";
    if (out.teamBScore <= out.teamAScore) {
      out.teamBScore = Math.min(10, out.teamAScore + 1);
    }
  }

  if (out.winner === "Mixed") {
    const even = Math.max(Math.min(out.teamAScore, out.teamBScore), 6);
    out.teamAScore = even;
    out.teamBScore = even;
  }

  return out;
}

function normalizeAiJudgeResult(parsed, defaults) {
  return {
    teamAName: safeString(parsed && parsed.teamAName, defaults.teamAName),
    teamBName: safeString(parsed && parsed.teamBName, defaults.teamBName),
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
    teamAScore: toIntSafe(parsed && parsed.teamAScore),
    teamBScore: toIntSafe(parsed && parsed.teamBScore),
    winner: normalizeWinner(parsed && parsed.winner),
    strongestArgumentSide: normalizeStrongestSide(parsed && parsed.strongestArgumentSide),
    strongestArgument: safeString(parsed && parsed.strongestArgument, "-"),
    whyStrongest: safeString(parsed && parsed.whyStrongest, "-"),
    failedResponseByOtherSide: safeString(parsed && parsed.failedResponseByOtherSide, "-"),
    bsMeter: normalizeBsMeter(parsed && parsed.bsMeter),
    strongestOverall: safeString(parsed && parsed.strongestOverall, "-"),
    weakestOverall: safeString(parsed && parsed.weakestOverall, "-"),
    why: safeString(parsed && parsed.why, "-"),
    manipulation: safeString(parsed && parsed.manipulation, "-"),
    fluff: safeString(parsed && parsed.fluff, "-")
  };
}

function normalizeChunkResult(parsed) {
  return {
    teamA: {
      main_points: safeArray(parsed && parsed.teamA && parsed.teamA.main_points),
      truth_points: safeArray(parsed && parsed.teamA && parsed.teamA.truth_points),
      lie_points: safeArray(parsed && parsed.teamA && parsed.teamA.lie_points),
      opinion_points: safeArray(parsed && parsed.teamA && parsed.teamA.opinion_points),
      lala_points: safeArray(parsed && parsed.teamA && parsed.teamA.lala_points)
    },
    teamB: {
      main_points: safeArray(parsed && parsed.teamB && parsed.teamB.main_points),
      truth_points: safeArray(parsed && parsed.teamB && parsed.teamB.truth_points),
      lie_points: safeArray(parsed && parsed.teamB && parsed.teamB.lie_points),
      opinion_points: safeArray(parsed && parsed.teamB && parsed.teamB.opinion_points),
      lala_points: safeArray(parsed && parsed.teamB && parsed.teamB.lala_points)
    },
    winnerLean: normalizeWinner(parsed && parsed.winnerLean),
    bestPoint: safeString(parsed && parsed.bestPoint, "-"),
    worstPoint: safeString(parsed && parsed.worstPoint, "-"),
    manipulation: safeString(parsed && parsed.manipulation, "-"),
    fluff: safeString(parsed && parsed.fluff, "-")
  };
}

function splitDialogueLines(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitLinesIntoSides(lines) {
  const teamA = [];
  const teamB = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (i % 2 === 0) teamA.push(lines[i]);
    else teamB.push(lines[i]);
  }

  return { teamA, teamB };
}

function summarizeMainPosition(text, used) {
  const sentence = pickUnused(splitSentences(text), used, (s) => s.length > 18);
  if (!sentence) return "-";
  return makeClaim(sentence);
}

function detectReasonableClaims(text, used) {
  const sentence = pickUnused(splitSentences(text), used, (s) => {
    return hasSupportLanguage(s) && !hasExtremeLanguage(s) && !hasOpinionLanguage(s);
  });
  if (!sentence) return "-";
  return "Grounded point: " + makeClaim(sentence);
}

function detectWeakClaims(text, used) {
  const sentence = pickUnused(splitSentences(text), used, (s) => {
    return hasExtremeLanguage(s) || hasOverclaimLanguage(s);
  });
  if (!sentence) return "-";
  return "Overstates: " + makeClaim(sentence);
}

function detectOpinion(text, used) {
  const sentence = pickUnused(splitSentences(text), used, (s) => hasOpinionLanguage(s));
  if (!sentence) return "-";
  return "Subjective framing: " + makeClaim(sentence);
}

function detectLala(text, used) {
  const sentence = pickUnused(splitSentences(text), used, (s) => hasLalaLanguage(s));
  if (!sentence) return "-";
  return "Unsupported leap: " + makeClaim(sentence);
}

function pickStrongestArgument(teamAText, teamBText) {
  const a = detectBestSupportedSentence(teamAText);
  const b = detectBestSupportedSentence(teamBText);

  if (!a && !b) {
    return { side: "Team A", text: "Makes the clearer case." };
  }
  if (a && !b) return { side: "Team A", text: makeClaim(a) };
  if (b && !a) return { side: "Team B", text: makeClaim(b) };

  const aScore = estimateSentenceStrength(a);
  const bScore = estimateSentenceStrength(b);

  if (aScore >= bScore) return { side: "Team A", text: makeClaim(a) };
  return { side: "Team B", text: makeClaim(b) };
}

function detectBestSupportedSentence(text) {
  const sentences = splitSentences(text);
  let best = "";
  let bestScore = -1;

  for (const s of sentences) {
    const score = estimateSentenceStrength(s);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  return best;
}

function estimateSentenceStrength(s) {
  let score = 0;
  if (hasSupportLanguage(s)) score += 3;
  if (!hasExtremeLanguage(s)) score += 1;
  if (!hasOpinionLanguage(s)) score += 1;
  if (!hasLalaLanguage(s)) score += 1;
  return score;
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => cleanSentence(s))
    .filter((s) => s.length > 10);
}

function cleanSentence(s) {
  return hardScrubText(String(s))
    .replace(/\bseconds([A-Z])/g, " $1")
    .replace(/\bminutes([A-Z])/g, " $1")
    .replace(/\bhours([A-Z])/g, " $1")
    .replace(/\s+/g, " ")
    .trim();
}

function createUsedTracker() {
  return new Set();
}

function pickUnused(sentences, used, predicate) {
  for (const s of sentences) {
    if (!used.has(s) && predicate(s)) {
      used.add(s);
      return s;
    }
  }
  return "";
}

function hasSupportLanguage(s) {
  const t = s.toLowerCase();
  return (
    t.includes("because") ||
    t.includes("for example") ||
    t.includes("for instance") ||
    t.includes("evidence") ||
    t.includes("data") ||
    t.includes("shows") ||
    t.includes("therefore") ||
    t.includes("means") ||
    t.includes("predict") ||
    t.includes("test")
  );
}

function hasExtremeLanguage(s) {
  const t = s.toLowerCase();
  return (
    t.includes("always") ||
    t.includes("never") ||
    t.includes("everyone") ||
    t.includes("nobody") ||
    t.includes("all of them") ||
    t.includes("completely")
  );
}

function hasOverclaimLanguage(s) {
  const t = s.toLowerCase();
  return (
    t.includes("obviously") ||
    t.includes("clearly") ||
    t.includes("undeniable") ||
    t.includes("proves") ||
    t.includes("no doubt")
  );
}

function hasOpinionLanguage(s) {
  const t = s.toLowerCase();
  return (
    t.includes("i think") ||
    t.includes("i feel") ||
    t.includes("i believe") ||
    t.includes("in my view") ||
    t.includes("my take") ||
    t.includes("should") ||
    t.includes("would")
  );
}

function hasLalaLanguage(s) {
  const t = s.toLowerCase();
  return (
    t.includes("everybody knows") ||
    t.includes("literally everyone") ||
    t.includes("nothing matters") ||
    t.includes("everything is fake") ||
    t.includes("the whole world")
  );
}

function supportScore(text) {
  return splitSentences(text).reduce((score, s) => {
    let add = 0;
    if (hasSupportLanguage(s)) add += 2;
    if (!hasExtremeLanguage(s)) add += 1;
    if (!hasLalaLanguage(s)) add += 1;
    return score + add;
  }, 0);
}

function weaknessScore(text) {
  return splitSentences(text).reduce((score, s) => {
    let add = 0;
    if (hasExtremeLanguage(s)) add += 2;
    if (hasOverclaimLanguage(s)) add += 1;
    if (hasLalaLanguage(s)) add += 2;
    return score + add;
  }, 0);
}

function countFluff(text) {
  const t = String(text).toLowerCase();
  const words = ["um", "uh", "like", "you know", "i mean", "basically", "sort of"];
  let count = 0;
  for (const word of words) {
    count += occurrences(t, word);
  }
  return count;
}

function buildBsMeter(weakA, weakB) {
  if (Math.abs(weakA - weakB) <= 1) return "Neither side is reaching significantly";
  return weakA > weakB ? "Team A is reaching more" : "Team B is reaching more";
}

function buildWhyStrongest(side, teamAName, teamBName) {
  return side === "Team A"
    ? "Better supported than " + teamBName + "."
    : "Better supported than " + teamAName + ".";
}

function buildFailedResponse(side, teamAName, teamBName) {
  return side === "Team A"
    ? teamBName + " failed to answer the stronger point."
    : teamAName + " failed to answer the stronger point.";
}

function buildWeakestOverall(weakA, weakB, teamAName, teamBName) {
  if (Math.abs(weakA - weakB) <= 1) return "No clearly terrible argument.";
  return weakA > weakB
    ? teamAName + " overstates claims."
    : teamBName + " overstates claims.";
}

function buildWhy(winner, teamAName, teamBName) {
  if (winner === "Team A") return teamAName + " created the stronger overall case.";
  if (winner === "Team B") return teamBName + " created the stronger overall case.";
  return "Both sides showed strengths, but neither gained a decisive edge.";
}

function buildManipulation(teamAText, teamBText) {
  const text = (teamAText + " " + teamBText).toLowerCase();
  if (
    text.includes("you people") ||
    text.includes("you just") ||
    text.includes("that’s ridiculous") ||
    text.includes("be honest")
  ) {
    return "Dismissive or pressuring rhetoric appears.";
  }
  return "-";
}

function buildFluff(fluffA, fluffB) {
  const total = fluffA + fluffB;
  if (total === 0) return "-";
  if (total < 4) return "Light filler present.";
  if (total < 10) return "Noticeable filler and repetition present.";
  return "Heavy filler and repetition present.";
}

function makeClaim(sentence) {
  const cleaned = cleanAnalystField(sentence);
  if (cleaned === "-") return "-";

  let text = cleaned
    .replace(/^grounded point:\s*/i, "")
    .replace(/^overstates:\s*/i, "")
    .replace(/^subjective framing:\s*/i, "")
    .replace(/^unsupported leap:\s*/i, "")
    .replace(/^argues that\s*/i, "")
    .trim();

  text = capitalize(text);
  if (!/[.!?]$/.test(text)) text += ".";
  return text;
}

function cleanAnalystField(value) {
  let text = safeString(value, "-");
  if (text === "-") return text;

  text = hardScrubText(text)
    .replace(/>>\s*[^:]+:\s*/g, "")
    .replace(/\b0:\d+\b/g, " ")
    .replace(/\b\d+\s*seconds([A-Z])/g, " $1")
    .replace(/\b\d+\s*minutes([A-Z])/g, " $1")
    .replace(/\b\d+\s*hours([A-Z])/g, " $1")
    .replace(/\bseconds([A-Z])/g, " $1")
    .replace(/\bminutes([A-Z])/g, " $1")
    .replace(/\bhours([A-Z])/g, " $1")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "-";
  return text;
}

function hardScrubText(text) {
  return String(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/>>\s*[^:\n]{1,40}:\s*/g, " ")
    .replace(/^\s*[^:\n]{1,30}:\s+/gm, " ")
    .replace(/\b\d+\s*[:,;.-]\s*\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*[:,;.-]\s*\d+\s*minutes?\b/gi, " ")
    .replace(/\b\d+\s*[:,;.-]\s*\d+\s*hours?\b/gi, " ")
    .replace(/\b\d+\s*[:,;.-]\s*\d+\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\s*seconds?\b/gi, " ")
    .replace(/\b\d+\s*minutes?\b/gi, " ")
    .replace(/\b\d+\s*hours?\b/gi, " ")
    .replace(/^\s*sync to video time\s*$/gim, " ")
    .replace(/^\s*show transcript\s*$/gim, " ")
    .replace(/^\s*transcript\s*$/gim, " ")
    .replace(/^\s*autoplay\s*$/gim, " ")
    .replace(/^\s*subscribe\s*$/gim, " ")
    .replace(/^\s*closing remarks\s*$/gim, " ")
    .replace(/^\s*invitation\s*$/gim, " ")
    .replace(/^\s*epic exchange\s*$/gim, " ")
    .replace(/^\s*all\s*$/gim, " ")
    .replace(/^\s*politics news\s*$/gim, " ")
    .replace(/^\s*\[music\]\s*$/gim, " ")
    .replace(/^\s*chapter\s+\d+.*$/gim, " ")
    .replace(/^\s*\d+\s+views?\s*$/gim, " ")
    .replace(/[A-Za-z0-9_-]{25,}/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+,/g, ",")
    .replace(/\s+;/g, ";")
    .replace(/\s+:/g, ":")
    .replace(/\s+\./g, ".")
    .trim();
}

function chunkTranscript(text, maxChars) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (!current) {
      current = para;
      continue;
    }

    if ((current + "\n\n" + para).length <= maxChars) {
      current += "\n\n" + para;
    } else {
      chunks.push(current);
      current = para;
    }
  }

  if (current) chunks.push(current);
  if (!chunks.length) return [text.slice(0, maxChars)];
  return chunks;
}

function cleanTranscript(text) {
  return hardScrubText(String(text).replace(/\r/g, "\n")).trim();
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

function safeJson(response) {
  return response.json().catch(() => null);
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Invalid JSON");
  }
}

function safeString(value, fallback = "-") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeString(item, ""))
    .filter(Boolean);
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

function isValidNumber(value) {
  return typeof value === "number" && !isNaN(value);
}

function clampScore(n) {
  if (n < 1) return 1;
  if (n > 10) return 10;
  return n;
}

function occurrences(text, fragment) {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text.match(new RegExp(escaped, "g"));
  return matches ? matches.length : 0;
}

function capitalize(text) {
  const s = safeString(text, "");
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withMode(result, mode) {
  const out = JSON.parse(JSON.stringify(result));
  out.analysisMode = mode;
  return out;
}

function buildFallbackResponse(args) {
  return {
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    analysisMode: "Local",
    teamA: {
      main_position: "Fallback mode: AI unavailable",
      truth: "-",
      lies: "-",
      opinion: "-",
      lala: "-"
    },
    teamB: {
      main_position: "Fallback mode: AI unavailable",
      truth: "-",
      lies: "-",
      opinion: "-",
      lala: "-"
    },
    teamAScore: 6,
    teamBScore: 6,
    winner: "Mixed",
    strongestArgumentSide: "Team A",
    strongestArgument: "-",
    whyStrongest: "-",
    failedResponseByOtherSide: "-",
    bsMeter: "Neither side is reaching significantly",
    strongestOverall: "-",
    weakestOverall: "-",
    why: safeString(args.reason, "AI unavailable."),
    manipulation: "-",
    fluff: "-",
    sources: [
      {
        claim: "No AI source extraction available",
        type: "general",
        likely_source: "Requires manual review",
        confidence: "low"
      }
    ]
  };
}
