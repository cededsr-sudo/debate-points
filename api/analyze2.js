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
      teamAName: teamAName,
      teamBName: teamBName,
      transcript: cleanedTranscript,
      videoLink: videoLink
    });

    if (!process.env.GROQ_API_KEY) {
      return res.status(200).json(localResult);
    }

    try {
      const chunks = chunkTranscript(cleanedTranscript, 900);
      const chunkResults = [];

      for (let i = 0; i < chunks.length; i += 1) {
        await sleep(1800);

        const chunkPrompt = buildChunkPrompt({
          teamAName: teamAName,
          teamBName: teamBName,
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

      await sleep(2200);

      const judgePrompt = buildJudgePrompt({
        teamAName: teamAName,
        teamBName: teamBName,
        videoLink: videoLink,
        chunkResults: chunkResults
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
        teamAName: teamAName,
        teamBName: teamBName
      });

      return res.status(200).json(withMode(mergeLocalAndAi(localResult, aiResult), "Hybrid"));
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
        max_completion_tokens: 500,
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
      content: content
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
    "You are analyzing one chunk of a debate transcript.",
    "",
    "DO NOT copy transcript text.",
    "DO NOT quote transcript wording.",
    "DO NOT include timestamps.",
    "DO NOT include filler phrases.",
    "DO NOT include partial sentences.",
    "",
    "Rewrite all outputs into clean analytical statements.",
    "Each item must be short, clear, and claim-style.",
    "Each item should be under 16 words.",
    "",
    "Team A label: " + args.teamAName,
    "Team B label: " + args.teamBName,
    "Chunk: " + args.chunkNumber + " of " + args.totalChunks,
    "",
    "Return exactly this JSON shape:",
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
    "- main_points = side's core claims in this chunk.",
    "- truth_points = grounded or supported claims.",
    "- lie_points = unsupported, exaggerated, or misleading claims.",
    "- opinion_points = subjective framing or preference.",
    "- lala_points = speculative leap or absurd overreach.",
    "",
    "Return ONLY JSON. No explanations.",
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
    "DO NOT copy transcript text.",
    "DO NOT quote transcript wording.",
    "DO NOT include timestamps.",
    "DO NOT include filler phrases.",
    "Rewrite all outputs into clean analytical statements.",
    "",
    "You MUST make a decision.",
    'Use "Mixed" ONLY if both sides are truly close and equally weak.',
    "Scores MUST reflect the winner.",
    "If there is a winner, that side must have the higher score.",
    "",
    "Team A label: " + args.teamAName,
    "Team B label: " + args.teamBName,
    "Optional link: " + (args.videoLink || "No link provided"),
    "",
    "Return exactly this JSON shape:",
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
    "Formatting rules:",
    '- winner must be exactly "Team A", "Team B", or "Mixed".',
    '- strongestArgumentSide must be exactly "Team A" or "Team B".',
    "- teamAScore and teamBScore must be integers from 1 to 10.",
    "- Every field must be short and direct.",
    "- No arrays.",
    "- No nested objects.",
    "- No extra keys.",
    "",
    "Specific field rules:",
    "- strongestArgument = one specific argument rewritten cleanly, not transcript wording.",
    "- whyStrongest = directly contrast why it beats the other side's best point.",
    "- failedResponseByOtherSide = what the weaker side failed to answer or support.",
    "- weakestOverall = the weakest argument made, even if it was addressed.",
    '- bsMeter must be exactly one of: "Team A is reaching more", "Team B is reaching more", or "Neither side is reaching significantly".',
    "",
    "Return ONLY JSON. No explanations.",
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

  const teamAScore = clampScore(5 + supportA - weakA);
  const teamBScore = clampScore(5 + supportB - weakB);

  let winner = "Mixed";
  if (teamAScore >= teamBScore + 2) winner = "Team A";
  if (teamBScore >= teamAScore + 2) winner = "Team B";

  const strongest = pickStrongestArgument(
    teamAJoined,
    teamBJoined,
    args.teamAName,
    args.teamBName
  );

  if (winner === "Mixed") {
    if (strongest.side === "Team A" && teamAScore >= teamBScore + 1) winner = "Team A";
    if (strongest.side === "Team B" && teamBScore >= teamAScore + 1) winner = "Team B";
  }

  const strongestArgumentSide = strongest.side;
  const strongestArgument = strongest.text;
  const whyStrongest = buildWhyStrongest(
    strongest.side,
    args.teamAName,
    args.teamBName
  );

  const failedResponseByOtherSide = buildFailedResponse(
    strongest.side,
    teamAJoined,
    teamBJoined,
    args.teamAName,
    args.teamBName
  );

  const bsMeter = buildBsMeter(weakA, weakB);
  const strongestOverall =
    strongest.side === "Team A"
      ? args.teamAName + ": " + strongest.text
      : args.teamBName + ": " + strongest.text;

  const weakestOverall = buildWeakestOverall(
    teamAJoined,
    teamBJoined,
    args.teamAName,
    args.teamBName
  );

  const why = buildWhy(
    winner,
    teamAScore,
    teamBScore,
    args.teamAName,
    args.teamBName
  );

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
    teamAScore: teamAScore,
    teamBScore: teamBScore,
    winner: winner,
    strongestArgumentSide: strongestArgumentSide,
    strongestArgument: cleanAnalystField(strongestArgument),
    whyStrongest: cleanAnalystField(whyStrongest),
    failedResponseByOtherSide: cleanAnalystField(failedResponseByOtherSide),
    bsMeter: bsMeter,
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
    failedResponseByOtherSide: cleanAnalystField(pickBetter(aiResult.failedResponseByOtherSide, localResult.failedResponseByOtherSide)),
    bsMeter: normalizeBsMeter(pickBetter(aiResult.bsMeter, localResult.bsMeter)),
    strongestOverall: cleanAnalystField(pickBetter(aiResult.strongestOverall, localResult.strongestOverall)),
    weakestOverall: cleanAnalystField(pickBetter(aiResult.weakestOverall, localResult.weakestOverall)),
    why: cleanAnalystField(pickBetter(aiResult.why, localResult.why)),
    manipulation: cleanAnalystField(pickBetter(aiResult.manipulation, localResult.manipulation)),
    fluff: cleanAnalystField(pickBetter(aiResult.fluff, localResult.fluff)),
    sources: localResult.sources
  };
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

  return { teamA: teamA, teamB: teamB };
}

function createUsedTracker() {
  return {};
}

function summarizeMainPosition(text, used) {
  const sentences = splitSentences(text);
  const picked = pickUnused(sentences, used, function (s) {
    return s.length > 20;
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
    2
  );
  if (!picked.length) return "-";
  return picked.map(rewriteGrounded).join(" | ");
}

function detectWeakClaims(text, used) {
  const sentences = splitSentences(text);
  const picked = collectUnused(
    sentences,
    used,
    function (s) {
      return hasExtremeLanguage(s) || hasOverclaimLanguage(s);
    },
    2
  );
  if (!picked.length) return "-";
  return picked.map(rewriteWeak).join(" | ");
}

function detectOpinion(text, used) {
  const sentences = splitSentences(text);
  const picked = collectUnused(
    sentences,
    used,
    function (s) {
      return hasOpinionLanguage(s);
    },
    2
  );
  if (!picked.length) return "-";
  return picked.map(rewriteOpinion).join(" | ");
}

function detectLala(text, used) {
  const sentences = splitSentences(text);
  const picked = collectUnused(
    sentences,
    used,
    function (s) {
      return hasLalaLanguage(s);
    },
    2
  );
  if (!picked.length) return "-";
  return picked.map(rewriteLala).join(" | ");
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(function (s) {
      return s.trim();
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
      return shorten(s, 180);
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

function pickStrongestArgument(teamA, teamB, teamAName, teamBName) {
  const a = detectBestSupportedSentence(teamA);
  const b = detectBestSupportedSentence(teamB);

  if (!a && !b) {
    return {
      side: "Team A",
      text: "Makes the slightly clearer core claim."
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

  return best ? shorten(best, 220) : "";
}

function buildWhyStrongest(side, teamAName, teamBName) {
  if (side === "Team A") {
    return "It is clearer, more grounded, and better supported than " + teamBName + "'s best point.";
  }
  return "It is clearer, more grounded, and better supported than " + teamAName + "'s best point.";
}

function buildFailedResponse(side, teamA, teamB, teamAName, teamBName) {
  if (side === "Team A") {
    const weak = detectWeakClaims(teamB, createUsedTracker());
    return weak !== "-"
      ? teamBName + " failed to fully answer or support its weaker claim."
      : teamBName + " did not clearly answer the stronger support-based point.";
  }

  const weak = detectWeakClaims(teamA, createUsedTracker());
  return weak !== "-"
    ? teamAName + " failed to fully answer or support its weaker claim."
    : teamAName + " did not clearly answer the stronger support-based point.";
}

function buildBsMeter(weakA, weakB) {
  if (Math.abs(weakA - weakB) <= 1) return "Neither side is reaching significantly";
  if (weakA > weakB) return "Team A is reaching more";
  return "Team B is reaching more";
}

function buildWeakestOverall(teamA, teamB, teamAName, teamBName) {
  const a = detectWeakClaims(teamA, createUsedTracker());
  const b = detectWeakClaims(teamB, createUsedTracker());

  if (a === "-" && b === "-") return "-";
  if (a !== "-" && b === "-") return teamAName + ": weakest claim relied on overreach.";
  if (b !== "-" && a === "-") return teamBName + ": weakest claim relied on overreach.";
  return a.length >= b.length
    ? teamAName + ": weakest claim relied on overreach."
    : teamBName + ": weakest claim relied on overreach.";
}

function buildWhy(winner, teamAScore, teamBScore, teamAName, teamBName) {
  if (winner === "Team A") {
    return teamAName + " built the stronger case and avoided as much weak overreach.";
  }
  if (winner === "Team B") {
    return teamBName + " built the stronger case and avoided as much weak overreach.";
  }
  return "Both sides had real strengths, but neither side created a decisive edge.";
}

function buildManipulation(teamA, teamB) {
  const text = (teamA + " " + teamB).toLowerCase();
  if (
    text.includes("you people") ||
    text.includes("you just") ||
    text.includes("that’s ridiculous") ||
    text.includes("be honest")
  ) {
    return "Dismissive or pressuring rhetoric appears in the exchange.";
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

function chunkTranscript(text, maxChars) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(function (p) {
      return p.trim();
    })
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (let i = 0; i < paragraphs.length; i += 1) {
    const para = paragraphs[i];

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

  if (current) {
    chunks.push(current);
  }

  if (!chunks.length) {
    return [text.slice(0, maxChars)];
  }

  return chunks;
}

function cleanSimpleName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function cleanTranscript(text) {
  return String(text)
    .replace(/\r/g, "\n")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
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
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+:\d+(?:\d+)?\s*(?:minutes?|minute|seconds?|second)\b/gi, " ")
    .replace(/^\s*\[[^\]]*\]\s*$/gm, " ")
    .replace(/^\s*\([^)]*\)\s*$/gm, " ")
    .replace(/[A-Za-z0-9_-]{25,}/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

  text = String(text)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+:\d+(?:\d+)?\s*(?:minutes?|minute|seconds?|second)\b/gi, " ")
    .replace(/\b(?:um|uh|you know|i mean|basically|sort of)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(/^and that'?s why\s*/i, "")
    .replace(/^so\s+/i, "")
    .replace(/^well\s+/i, "")
    .replace(/^okay\s+/i, "")
    .replace(/^look\s+/i, "")
    .replace(/^here'?s my take\s*/i, "");

  text = shorten(text, 180);

  if (!text) return "-";
  return text;
}

function rewriteAsClaim(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten(s.replace(/\.$/, ""), 160);
}

function rewriteGrounded(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten("Grounded claim: " + s.replace(/\.$/, ""), 180);
}

function rewriteWeak(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten("Unsupported or overstated claim: " + s.replace(/\.$/, ""), 180);
}

function rewriteOpinion(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten("Subjective framing: " + s.replace(/\.$/, ""), 180);
}

function rewriteLala(sentence) {
  const s = cleanAnalystField(sentence);
  if (s === "-") return s;
  return shorten("Speculative leap: " + s.replace(/\.$/, ""), 180);
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
    teamAScore: 5,
    teamBScore: 5,
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
