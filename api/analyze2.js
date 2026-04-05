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
      const chunks = chunkTranscript(cleanedTranscript, 850);
      const chunkResults = [];

      for (let i = 0; i < chunks.length; i += 1) {
        await sleep(1600);

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

      await sleep(2000);

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

      return res
        .status(200)
        .json(withMode(enforceConsistency(mergeLocalAndAi(localResult, aiResult)), "Hybrid"));
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
        max_completion_tokens: 420,
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
    "STRICT MODE:",
    "Return ONLY valid JSON.",
    "No markdown.",
    "No code fences.",
    "No text before JSON.",
    "No text after JSON.",
    "",
    "Analyze one debate chunk.",
    "",
    "DO NOT quote transcript wording.",
    "DO NOT copy speaker names.",
    "DO NOT include timestamps.",
    "DO NOT include filler language.",
    "Rewrite every output as a short analytical statement.",
    "Each item must be under 10 words.",
    "",
    "Team A label: " + args.teamAName,
    "Team B label: " + args.teamBName,
    "Chunk: " + args.chunkNumber + " of " + args.totalChunks,
    "",
    "Return exactly:",
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
    "Category rules:",
    "- main_points = core claim only.",
    "- truth_points = grounded point only.",
    "- lie_points = unsupported claim only.",
    "- opinion_points = subjective framing only.",
    "- lala_points = unsupported leap only.",
    "",
    "Return ONLY JSON.",
    "",
    "Chunk text:",
    args.chunkText
  ].join("\n");
}

function buildJudgePrompt(args) {
  return [
    "STRICT MODE:",
    "Return ONLY valid JSON.",
    "No markdown.",
    "No code fences.",
    "No text before JSON.",
    "No text after JSON.",
    "",
    "You are the final judge for a debate.",
    "",
    "DO NOT quote transcript wording.",
    "DO NOT copy speaker names.",
    "DO NOT include timestamps.",
    "Rewrite all outputs as clean debate analysis.",
    "",
    "You MUST make a decision.",
    'Use "Mixed" ONLY if the sides are truly close.',
    "Winner must have the higher score.",
    "Equal scores only if winner is Mixed.",
    "",
    "Team A label: " + args.teamAName,
    "Team B label: " + args.teamBName,
    "",
    "Return exactly:",
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
    "Field rules:",
    "- main position: one short core claim.",
    "- truth: one grounded point.",
    "- lies: one unsupported claim.",
    "- opinion: one subjective frame.",
    "- lala: one unsupported leap.",
    "- strongestArgument: max 10 words.",
    "- whyStrongest: max 12 words.",
    "- failedResponseByOtherSide: max 12 words.",
    "- weakestOverall: max 8 words.",
    '- strongestArgumentSide must be exactly "Team A" or "Team B".',
    '- bsMeter must be exactly one of:',
    '  "Team A is reaching more"',
    '  "Team B is reaching more"',
    '  "Neither side is reaching significantly"',
    "",
    "Return ONLY JSON.",
    "",
    "Chunk analyses:",
    JSON.stringify(args.chunkResults, null, 2)
  ].join("\n");
}

function buildDeterministicResult(args) {
  const transcript = args.transcript;
  const lines = splitDialogueLines(transcript);
  const split = splitLinesIntoSides(lines);

  const teamAJoined = split.teamA.join(" ");
  const teamBJoined = split.teamB.join(" ");

  const usedA = createUsedTracker();
  const usedB = createUsedTracker();

  const teamAMain = summarizeMainPosition(teamAJoined, usedA);
  const teamBMain = summarizeMainPosition(teamBJoined, usedB);

  const teamATruth = detectReasonableClaims(teamAJoined, usedA);
  const teamBTruth = detectReasonableClaims(teamBJoined, usedB);

  const teamALies = detectWeakClaims(teamAJoined, usedA);
  const teamBLies = detectWeakClaims(teamBJoined, usedB);

  const teamAOpinion = detectOpinion(teamAJoined, usedA);
  const teamBOpinion = detectOpinion(teamBJoined, usedB);

  const teamALala = detectLala(teamAJoined, usedA);
  const teamBLala = detectLala(teamBJoined, usedB);

  const fluffA = countFluff(teamAJoined);
  const fluffB = countFluff(teamBJoined);
  const weakA = weaknessScore(teamAJoined);
  const weakB = weaknessScore(teamBJoined);
  const supportA = supportScore(teamAJoined);
  const supportB = supportScore(teamBJoined);

  let teamAScore = clampScore(5 + supportA - weakA);
  let teamBScore = clampScore(5 + supportB - weakB);

  let winner = "Mixed";
  if (teamAScore >= teamBScore + 2) winner = "Team A";
  if (teamBScore >= teamAScore + 2) winner = "Team B";

  const strongest = pickStrongestArgument(teamAJoined, teamBJoined);

  if (winner === "Mixed") {
    if (strongest.side === "Team A" && teamAScore >= teamBScore + 1) winner = "Team A";
    if (strongest.side === "Team B" && teamBScore >= teamAScore + 1) winner = "Team B";
  }

  if (winner === "Team A" && teamAScore <= teamBScore) {
    teamAScore = Math.min(10, teamBScore + 1);
  }
  if (winner === "Team B" && teamBScore <= teamAScore) {
    teamBScore = Math.min(10, teamAScore + 1);
  }
  if (winner === "Mixed") {
    const even = Math.max(Math.min(teamAScore, teamBScore), 6);
    teamAScore = even;
    teamBScore = even;
  }

  const strongestArgumentSide = strongest.side;
  const strongestArgument = strongest.text;
  const whyStrongest = buildWhyStrongest(strongest.side, args.teamAName, args.teamBName);
  const failedResponseByOtherSide = buildFailedResponse(strongest.side, args.teamAName, args.teamBName);
  const bsMeter = buildBsMeter(weakA, weakB);

  const strongestOverall =
    strongest.side === "Team A"
      ? args.teamAName + ": " + strongest.text
      : args.teamBName + ": " + strongest.text;

  const weakestOverall = buildWeakestOverall(weakA, weakB, args.teamAName, args.teamBName);
  const why = buildWhy(winner, args.teamAName, args.teamBName);
  const manipulation = buildManipulation(teamAJoined, teamBJoined);
  const fluff = buildFluff(fluffA, fluffB);

  return {
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    analysisMode: "Local",
    teamA: {
      main_position: cleanAnalystField(teamAMain),
      truth: cleanAnalystField(teamATruth),
      lies: cleanAnalystField(teamALies),
      opinion: cleanAnalystField(teamAOpinion),
      lala: cleanAnalystField(teamALala)
    },
    teamB: {
      main_position: cleanAnalystField(teamBMain),
      truth: cleanAnalystField(teamBTruth),
      lies: cleanAnalystField(teamBLies),
      opinion: cleanAnalystField(teamBOpinion),
      lala: cleanAnalystField(teamBLala)
    },
    teamAScore,
    teamBScore,
    winner,
    strongestArgumentSide,
    strongestArgument: cleanAnalystField(strongestArgument),
    whyStrongest: cleanAnalystField(whyStrongest),
    failedResponseByOtherSide: cleanAnalystField(failedResponseByOtherSide),
    bsMeter,
    strongestOverall: cleanAnalystField(strongestOverall),
    weakestOverall: cleanAnalystField(weakestOverall),
    why: cleanAnalystField(why),
    manipulation: cleanAnalystField(manipulation),
    fluff: cleanAnalystField(fluff),
    sources: [
      {
        claim: "Deterministic analysis uses transcript patterns, not outside fact-checking",
        type: "general",
        likely_source: "Manual review needed",
        confidence: "medium"
      }
    ]
  };
}

function mergeLocalAndAi(localResult, aiResult) {
  return {
    teamAName: aiResult.teamAName || localResult.teamAName,
    teamBName: aiResult.teamBName || localResult.teamBName,
    analysisMode: "Hybrid",
    teamA: {
      main_position: cleanAnalystField(pickBetter(aiResult.teamA.main_position, localResult.teamA.main_position)),
      truth: cleanAnalystField(pickBetter(aiResult.teamA.truth, localResult.teamA.truth)),
      lies: cleanAnalystField(pickBetter(aiResult.teamA.lies, localResult.teamA.lies)),
      opinion: cleanAnalystField(pickBetter(aiResult.teamA.opinion, localResult.teamA.opinion)),
      lala: cleanAnalystField(pickBetter(aiResult.teamA.lala, localResult.teamA.lala))
    },
    teamB: {
      main_position: cleanAnalystField(pickBetter(aiResult.teamB.main_position, localResult.teamB.main_position)),
      truth: cleanAnalystField(pickBetter(aiResult.teamB.truth, localResult.teamB.truth)),
      lies: cleanAnalystField(pickBetter(aiResult.teamB.lies, localResult.teamB.lies)),
      opinion: cleanAnalystField(pickBetter(aiResult.teamB.opinion, localResult.teamB.opinion)),
      lala: cleanAnalystField(pickBetter(aiResult.teamB.lala, localResult.teamB.lala))
    },
    teamAScore: isValidNumber(aiResult.teamAScore) ? aiResult.teamAScore : localResult.teamAScore,
    teamBScore: isValidNumber(aiResult.teamBScore) ? aiResult.teamBScore : localResult.teamBScore,
    winner: pickWinner(aiResult.winner, localResult.winner),
    strongestArgumentSide: pickStrongestSide(aiResult.strongestArgumentSide, localResult.strongestArgumentSide),
    strongestArgument: cleanAnalystField(pickBetter(aiResult.strongestArgument, localResult.strongestArgument)),
    whyStrongest: cleanAnalystField(pickBetter(aiResult.whyStrongest, localResult.whyStrongest)),
    failedResponseByOtherSide: cleanAnalystField(
      pickBetter(aiResult.failedResponseByOtherSide, localResult.failedResponseByOtherSide)
    ),
    bsMeter: normalizeBsMeter(pickBetter(aiResult.bsMeter, localResult.bsMeter)),
    strongestOverall: cleanAnalystField(pickBetter(aiResult.strongestOverall, localResult.strongestOverall)),
    weakestOverall: cleanAnalystField(pickBetter(aiResult.weakestOverall, localResult.weakestOverall)),
    why: cleanAnalystField(pickBetter(aiResult.why, localResult.why)),
    manipulation: cleanAnalystField(pickBetter(aiResult.manipulation, localResult.manipulation)),
    fluff: cleanAnalystField(pickBetter(aiResult.fluff, localResult.fluff)),
    sources: localResult.sources
  };
}

function enforceConsistency(result) {
  const out = JSON.parse(JSON.stringify(result));

  out.teamAScore = clampScore(Number(out.teamAScore || 5));
  out.teamBScore = clampScore(Number(out.teamBScore || 5));

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

  out.strongestArgument = cleanAnalystField(out.strongestArgument);
  out.strongestOverall = cleanAnalystField(out.strongestOverall);
  out.weakestOverall = cleanAnalystField(out.weakestOverall);
  out.failedResponseByOtherSide = cleanAnalystField(out.failedResponseByOtherSide);
  out.whyStrongest = cleanAnalystField(out.whyStrongest);
  out.why = cleanAnalystField(out.why);
  out.bsMeter = normalizeBsMeter(out.bsMeter);

  return out;
}

function withMode(result, mode) {
  const clone = JSON.parse(JSON.stringify(result));
  clone.analysisMode = mode;
  return clone;
}

function normalizeAiJudgeResult(parsed, defaults) {
  return {
    teamAName: safeString(parsed && parsed.teamAName, defaults.teamAName),
    teamBName: safeString(parsed && parsed.teamBName, defaults.teamBName),
    teamA: {
      main_position: cleanAnalystField(parsed && parsed.teamA_main_position),
      truth: cleanAnalystField(parsed && parsed.teamA_truth),
      lies: cleanAnalystField(parsed && parsed.teamA_lies),
      opinion: cleanAnalystField(parsed && parsed.teamA_opinion),
      lala: cleanAnalystField(parsed && parsed.teamA_lala)
    },
    teamB: {
      main_position: cleanAnalystField(parsed && parsed.teamB_main_position),
      truth: cleanAnalystField(parsed && parsed.teamB_truth),
      lies: cleanAnalystField(parsed && parsed.teamB_lies),
      opinion: cleanAnalystField(parsed && parsed.teamB_opinion),
      lala: cleanAnalystField(parsed && parsed.teamB_lala)
    },
    teamAScore: toIntSafe(parsed && parsed.teamAScore),
    teamBScore: toIntSafe(parsed && parsed.teamBScore),
    winner: normalizeWinner(parsed && parsed.winner),
    strongestArgumentSide: normalizeStrongestSide(parsed && parsed.strongestArgumentSide),
    strongestArgument: cleanAnalystField(parsed && parsed.strongestArgument),
    whyStrongest: cleanAnalystField(parsed && parsed.whyStrongest),
    failedResponseByOtherSide: cleanAnalystField(parsed && parsed.failedResponseByOtherSide),
    bsMeter: normalizeBsMeter(parsed && parsed.bsMeter),
    strongestOverall: cleanAnalystField(parsed && parsed.strongestOverall),
    weakestOverall: cleanAnalystField(parsed && parsed.weakestOverall),
    why: cleanAnalystField(parsed && parsed.why),
    manipulation: cleanAnalystField(parsed && parsed.manipulation),
    fluff: cleanAnalystField(parsed && parsed.fluff)
  };
}

function normalizeChunkResult(parsed) {
  return {
    teamA: {
      main_points: safeArray(parsed && parsed.teamA && parsed.teamA.main_points).map(cleanAnalystField),
      truth_points: safeArray(parsed && parsed.teamA && parsed.teamA.truth_points).map(cleanAnalystField),
      lie_points: safeArray(parsed && parsed.teamA && parsed.teamA.lie_points).map(cleanAnalystField),
      opinion_points: safeArray(parsed && parsed.teamA && parsed.teamA.opinion_points).map(cleanAnalystField),
      lala_points: safeArray(parsed && parsed.teamA && parsed.teamA.lala_points).map(cleanAnalystField)
    },
    teamB: {
      main_points: safeArray(parsed && parsed.teamB && parsed.teamB.main_points).map(cleanAnalystField),
      truth_points: safeArray(parsed && parsed.teamB && parsed.teamB.truth_points).map(cleanAnalystField),
      lie_points: safeArray(parsed && parsed.teamB && parsed.teamB.lie_points).map(cleanAnalystField),
      opinion_points: safeArray(parsed && parsed.teamB && parsed.teamB.opinion_points).map(cleanAnalystField),
      lala_points: safeArray(parsed && parsed.teamB && parsed.teamB.lala_points).map(cleanAnalystField)
    },
    winnerLean: normalizeWinner(parsed && parsed.winnerLean),
    bestPoint: cleanAnalystField(parsed && parsed.bestPoint),
    worstPoint: cleanAnalystField(parsed && parsed.worstPoint),
    manipulation: cleanAnalystField(parsed && parsed.manipulation),
    fluff: cleanAnalystField(parsed && parsed.fluff)
  };
}

function splitDialogueLines(text) {
  return text
    .split("\n")
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);
}

function splitLinesIntoSides(lines) {
  const teamA = [];
  const teamB = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (i % 2 === 0) {
      teamA.push(lines[i]);
    } else {
      teamB.push(lines[i]);
    }
  }

  return { teamA, teamB };
}

function createUsedTracker() {
  return {};
}

function summarizeMainPosition(text, used) {
  const sentences = splitSentences(text);
  const picked = pickUnused(sentences, used, function (s) {
    return s.length > 18;
  });
  return rewriteAsClaim(picked || "-");
}

function detectReasonableClaims(text, used) {
  const sentences = splitSentences(text);
  const picked = collectUnused(
    sentences,
    used,
    function (s) {
      return hasSupportLanguage(s) && !hasExtremeLanguage(s) && !hasOpinionLanguage(s);
    },
    1
  );
  if (!picked.length) return "-";
  return rewriteGrounded(picked[0]);
}

function detectWeakClaims(text, used) {
  const sentences = splitSentences(text);
  const picked = collectUnused(
    sentences,
    used,
    function (s) {
      return hasExtremeLanguage(s) || hasOverclaimLanguage(s);
    },
    1
  );
  if (!picked.length) return "-";
  return rewriteWeak(picked[0]);
}

function detectOpinion(text, used) {
  const sentences = splitSentences(text);
  const picked = collectUnused(
    sentences,
    used,
    function (s) {
      return hasOpinionLanguage(s);
    },
    1
  );
  if (!picked.length) return "-";
  return rewriteOpinion(picked[0]);
}

function detectLala(text, used) {
  const sentences = splitSentences(text);
  const picked = collectUnused(
    sentences,
    used,
    function (s) {
      return hasLalaLanguage(s);
    },
    1
  );
  if (!picked.length) return "-";
  return rewriteLala(picked[0]);
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(function (s) {
      return hardScrubText(s.trim());
    })
    .filter(function (s) {
      return s.length > 12;
    });
}

function pickUnused(sentences, used, predicate) {
  for (let i = 0; i < sentences.length; i += 1) {
    const s = sentences[i];
    if (!used[s] && predicate(s)) {
      used[s] = true;
      return shorten(s, 120);
    }
  }
  return "";
}

function collectUnused(sentences, used, predicate, maxItems) {
  const out = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const s = sentences[i];
    if (!used[s] && predicate(s)) {
      used[s] = true;
      out.push(s);
      if (out.length >= maxItems) break;
    }
  }
  return out;
}

function hasSupportLanguage(s) {
  const t = s.toLowerCase();
  return (
    t.includes("because") ||
    t.includes("for example") ||
    t.includes("for instance") ||
    t.includes("evidence") ||
    t.includes("data") ||
    t.includes("according") ||
    t.includes("study") ||
    t.includes("shows") ||
    t.includes("means") ||
    t.includes("therefore")
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
    t.includes("completely") ||
    t.includes("proves everything")
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
    t.includes("should") ||
    t.includes("would like") ||
    t.includes("my take")
  );
}

function hasLalaLanguage(s) {
  const t = s.toLowerCase();
  return (
    t.includes("everybody knows") ||
    t.includes("literally everyone") ||
    t.includes("nothing matters") ||
    t.includes("everything is fake") ||
    t.includes("all behavior is") ||
    t.includes("the whole world")
  );
}

function countFluff(text) {
  const t = String(text).toLowerCase();
  let count = 0;
  const tokens = ["um", "uh", "like", "you know", "i mean", "basically", "sort of"];
  for (let i = 0; i < tokens.length; i += 1) {
    count += occurrences(t, tokens[i]);
  }
  return count;
}

function supportScore(text) {
  const s = splitSentences(text);
  let score = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (hasSupportLanguage(s[i])) score += 2;
    if (!hasExtremeLanguage(s[i])) score += 1;
  }
  return score;
}

function weaknessScore(text) {
  const s = splitSentences(text);
  let score = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (hasExtremeLanguage(s[i])) score += 2;
    if (hasOverclaimLanguage(s[i])) score += 1;
    if (hasLalaLanguage(s[i])) score += 2;
  }
  return score;
}

function clampScore(raw) {
  if (raw < 1) return 1;
  if (raw > 10) return 10;
  return raw;
}

function pickStrongestArgument(teamA, teamB) {
  const a = detectBestSupportedSentence(teamA);
  const b = detectBestSupportedSentence(teamB);

  if (!a && !b) {
    return {
      side: "Team A",
      text: "Makes the clearer case."
    };
  }

  if (a && !b) return { side: "Team A", text: rewriteAsClaim(a) };
  if (b && !a) return { side: "Team B", text: rewriteAsClaim(b) };

  return a.length >= b.length
    ? { side: "Team A", text: rewriteAsClaim(a) }
    : { side: "Team B", text: rewriteAsClaim(b) };
}

function detectBestSupportedSentence(text) {
  const sentences = splitSentences(text);
  let best = "";
  let bestScore = -1;

  for (let i = 0; i < sentences.length; i += 1) {
    const s = sentences[i];
    let score = 0;
    if (hasSupportLanguage(s)) score += 3;
    if (!hasExtremeLanguage(s)) score += 1;
    if (!hasOpinionLanguage(s)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  return best ? shorten(best, 70) : "";
}

function buildWhyStrongest(side, teamAName, teamBName) {
  if (side === "Team A") {
    return "Better supported than " + teamBName + ".";
  }
  return "Better supported than " + teamAName + ".";
}

function buildFailedResponse(side, teamAName, teamBName) {
  if (side === "Team A") {
    return teamBName + " failed to answer the stronger point.";
  }
  return teamAName + " failed to answer the stronger point.";
}

function buildBsMeter(weakA, weakB) {
  if (Math.abs(weakA - weakB) <= 1) return "Neither side is reaching significantly";
  if (weakA > weakB) return "Team A is reaching more";
  return "Team B is reaching more";
}

function buildWeakestOverall(weakA, weakB, teamAName, teamBName) {
  if (Math.abs(weakA - weakB) <= 1) return "No clearly terrible argument.";
  if (weakA > weakB) return teamAName + ": overstates claims.";
  return teamBName + ": overstates claims.";
}

function buildWhy(winner, teamAName, teamBName) {
  if (winner === "Team A") {
    return teamAName + " created the stronger overall case.";
  }
  if (winner === "Team B") {
    return teamBName + " created the stronger overall case.";
  }
  return "Both sides showed strengths, but neither gained a decisive edge.";
}

function buildManipulation(teamA, teamB) {
  const text = (teamA + " " + teamB).toLowerCase();
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

function pickBetter(primary, fallback) {
  if (primary && primary !== "-" && primary !== "Mixed") return primary;
  return fallback;
}

function pickWinner(primary, fallback) {
  if (primary === "Team A" || primary === "Team B" || primary === "Mixed") {
    return primary;
  }
  return fallback;
}

function pickStrongestSide(primary, fallback) {
  if (primary === "Team A" || primary === "Team B") {
    return primary;
  }
  return fallback;
}

function normalizeWinner(value) {
  const text = safeString(value, "Mixed");
  return text === "Team A" || text === "Team B" || text === "Mixed"
    ? text
    : "Mixed";
}

function normalizeStrongestSide(value) {
  const text = safeString(value, "");
  return text === "Team A" || text === "Team B" ? text : "";
}

function normalizeBsMeter(value) {
  const text = safeString(value, "Neither side is reaching significantly");
  if (
    text === "Team A is reaching more" ||
    text === "Team B is reaching more" ||
    text === "Neither side is reaching significantly"
  ) {
    return text;
  }
  return "Neither side is reaching significantly";
}

function safeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(function (item) {
      return safeString(item, "");
    })
    .filter(function (item) {
      return item && item !== "-";
    })
    .slice(0, 6);
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
    .replace(/\b\d+\s*[:,;.-]\s*\d+\s*secondsthe\b/gi, " the ")
    .replace(/\b\d+\s*[:,;.-]\s*\d+\s*minutes?the\b/gi, " the ")
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
    .replace(
      /^\s*\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\s*$/gim,
      " "
    )
    .replace(/[A-Za-z0-9_-]{25,}/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+,/g, ",")
    .replace(/\s+;/g, ";")
    .replace(/\s+:/g, ":")
    .replace(/\s+\./g, ".")
    .replace(/,+/g, ",")
    .replace(/;+/g, ";")
    .trim();
}

function cleanSimpleName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function cleanTranscript(text) {
  return hardScrubText(String(text).replace(/\r/g, "\n")).trim();
}

function getTranscriptStats(text) {
  const lines = text
    .split("\n")
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);

  const words = text.split(/\s+/).filter(Boolean);

  return {
    lineCount: lines.length,
    wordCount: words.length
  };
}

function occurrences(text, fragment) {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text.match(new RegExp(escaped, "g"));
  return matches ? matches.length : 0;
}

function shorten(text, maxLen) {
  const t = safeString(text, "-");
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 3).trim() + "...";
}

function safeJson(response) {
  return response.json().catch(function () {
    return null;
  });
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
    throw new Error("Invalid JSON from model");
  }
}

function safeString(value, fallback) {
  if (value === null || value === undefined) return fallback || "-";
  const text = String(value).trim();
  return text ? text : fallback || "-";
}

function toIntSafe(value) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return null;
  return clampScore(n);
}

function isValidNumber(value) {
  return typeof value === "number" && !isNaN(value);
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function cleanAnalystField(value) {
  let text = safeString(value, "-");
  if (text === "-") return text;

  text = hardScrubText(text)
    .replace(/^grounded point:\s*/i, "Grounded point: ")
    .replace(/^overstates:\s*/i, "Overstates: ")
    .replace(/^subjective framing:\s*/i, "Subjective framing: ")
    .replace(/^unsupported leap:\s*/i, "Unsupported leap: ")
    .replace(/^argues that\s*/i, "")
    .replace(/^and that'?s why\s*/i, "")
    .replace(/^so\s+/i, "")
    .replace(/^well\s+/i, "")
    .replace(/^okay\s+/i, "")
    .replace(/^look\s+/i, "")
    .replace(/^here'?s my take\s*/i, "")
    .replace(/^claim:\s*/i, "")
    .replace(/^reason:\s*/i, "")
    .trim();

  if (!text) return "-";
  return shorten(text, 110);
}

function rewriteAsClaim(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten(stripTerminalPunctuation(s) + ".", 55);
}

function rewriteGrounded(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten("Grounded point: " + stripTerminalPunctuation(s) + ".", 70);
}

function rewriteWeak(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten("Overstates: " + stripTerminalPunctuation(s) + ".", 65);
}

function rewriteOpinion(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten("Subjective framing: " + stripTerminalPunctuation(s) + ".", 75);
}

function rewriteLala(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten("Unsupported leap: " + stripTerminalPunctuation(s) + ".", 65);
}

function stripTerminalPunctuation(text) {
  return String(text).replace(/[.!,;:]+$/g, "").trim();
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
