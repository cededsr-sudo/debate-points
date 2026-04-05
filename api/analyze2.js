module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let safeTeamAName = "Team A";
  let safeTeamBName = "Team B";

  try {
    const body = req.body || {};

    safeTeamAName = cleanSimpleName(body.teamAName) || "Team A";
    safeTeamBName = cleanSimpleName(body.teamBName) || "Team B";

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
      teamAName: safeTeamAName,
      teamBName: safeTeamBName,
      transcript: cleanedTranscript,
      videoLink
    });

    if (!process.env.GROQ_API_KEY) {
      return res.status(200).json(withMode(localResult, "Local"));
    }

    try {
      const chunks = chunkTranscript(cleanedTranscript, 1800);
      const chunkResults = [];

      for (let i = 0; i < chunks.length; i += 1) {
        const chunkPrompt = buildChunkPrompt({
          teamAName: safeTeamAName,
          teamBName: safeTeamBName,
          chunkText: chunks[i],
          chunkNumber: i + 1,
          totalChunks: chunks.length
        });

        const chunkResponse = await callGroq(chunkPrompt, {
          temperature: 0.15,
          max_completion_tokens: 950
        });

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

      const judgePrompt = buildJudgePrompt({
        teamAName: safeTeamAName,
        teamBName: safeTeamBName,
        videoLink,
        chunkResults,
        transcript: cleanedTranscript
      });

      const judgeResponse = await callGroq(judgePrompt, {
        temperature: 0.1,
        max_completion_tokens: 1450
      });

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
        teamAName: safeTeamAName,
        teamBName: safeTeamBName
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
        teamAName: safeTeamAName,
        teamBName: safeTeamBName,
        reason: "Unexpected backend failure."
      })
    );
  }
};

async function callGroq(prompt, options = {}) {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature:
          typeof options.temperature === "number" ? options.temperature : 0.1,
        max_completion_tokens:
          typeof options.max_completion_tokens === "number"
            ? options.max_completion_tokens
            : 900,
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
    "You are analyzing one chunk of a debate transcript.",
    "",
    "Rules:",
    "- Do not quote transcript text directly.",
    "- Do not include timestamps.",
    "- Do not include speaker tags.",
    "- Do not invent facts not grounded in the chunk.",
    "- If a point is unsupported, call it unsupported or overstated, not automatically false.",
    "- Separate grounded points from detached leaps.",
    "- Use short, clean analyst language.",
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
    "- main_points: core claim or push",
    "- truth_points: grounded point with some support",
    "- lie_points: unsupported or overstated point",
    "- opinion_points: subjective framing",
    "- lala_points: detached leap, misinformation, or irrelevant stretch treated like proof",
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
    "You are the final judge of a debate analysis.",
    "",
    "Core integrity lanes:",
    "- Transcript lane: stay grounded in what appears in the transcript and chunk summaries.",
    "- Reasoning lane: reward arguments that explain why, not just assert.",
    "- Worldview lane: recognize whether a point is empirical, rhetorical, emotional, interpretive, or value-based.",
    "- Fairness lane: do not punish either side just for tone, religion, skepticism, or style.",
    "- Restraint lane: do not invent facts, motives, or certainty.",
    "",
    "Rules:",
    "- Do not quote transcript text directly.",
    "- Do not include timestamps.",
    "- Do not include speaker tags.",
    "- Rewrite every field in clean analyst language.",
    "- If one side is clearly stronger, do not hide behind Mixed.",
    "- Winner must match score advantage.",
    "- Unsupported is not automatically disproven.",
    "- Do not reward aggression by itself.",
    "- Use Lala Land for detached leaps, misinformation, or irrelevant stretches being treated like proof.",
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
    "Scoring guidance:",
    "- 1 to 10 scale.",
    "- 9-10 = rare excellent debate showing.",
    "- 7-8 = strong.",
    "- 5-6 = mixed or average.",
    "- 3-4 = weak.",
    "- 1-2 = very bad.",
    "- If winner is not Mixed, scores must not be tied.",
    "- Avoid inflated scoring.",
    "",
    "Field meaning:",
    "- main position: one clear short claim",
    "- truth: strongest grounded point",
    "- lies: clearest unsupported or overstated point",
    "- opinion: clearest subjective frame",
    "- lala: biggest detached leap, misinformation, or irrelevant stretch",
    "- strongestArgument: single best argument in the debate",
    "- whyStrongest: explain exactly why it wins",
    "- failedResponseByOtherSide: what went unanswered",
    "- weakestOverall: single worst claim in the debate",
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
    "Full cleaned transcript:",
    args.transcript,
    "",
    "Chunk analyses:",
    JSON.stringify(args.chunkResults, null, 2)
  ].join("\n");
}

function buildDeterministicResult(args) {
  const lines = splitDialogueLines(args.transcript);
  const guessed = splitLinesIntoSidesSmart(lines, args.teamAName, args.teamBName);

  const teamAText = guessed.teamA.join(" ");
  const teamBText = guessed.teamB.join(" ");

  const usedA = createUsedTracker();
  const usedB = createUsedTracker();

  const teamAData = {
    main_position: summarizeMainPosition(teamAText, usedA),
    truth: detectReasonableClaims(teamAText, usedA),
    lies: detectWeakClaims(teamAText, usedA),
    opinion: detectOpinion(teamAText, usedA),
    lala: detectBiggestMisinformation(teamAText, usedA)
  };

  const teamBData = {
    main_position: summarizeMainPosition(teamBText, usedB),
    truth: detectReasonableClaims(teamBText, usedB),
    lies: detectWeakClaims(teamBText, usedB),
    opinion: detectOpinion(teamBText, usedB),
    lala: detectBiggestMisinformation(teamBText, usedB)
  };

  let teamAScore = estimateDebateScore(teamAText, teamAData);
  let teamBScore = estimateDebateScore(teamBText, teamBData);

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

  const normalizedPair = normalizeScorePair(teamAScore, teamBScore, winner);
  teamAScore = normalizedPair.teamAScore;
  teamBScore = normalizedPair.teamBScore;

  const result = {
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    analysisMode: "Local",
    teamA: teamAData,
    teamB: teamBData,
    teamAScore,
    teamBScore,
    winner,
    strongestArgumentSide: strongest.side,
    strongestArgument: strongest.text,
    whyStrongest: buildWhyStrongest(strongest.side, args.teamAName, args.teamBName),
    failedResponseByOtherSide: buildFailedResponse(
      strongest.side,
      args.teamAName,
      args.teamBName
    ),
    bsMeter,
    strongestOverall:
      strongest.side === "Team A"
        ? args.teamAName + ": " + strongest.text
        : args.teamBName + ": " + strongest.text,
    weakestOverall: buildWeakestOverall(
      teamAData,
      teamBData,
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
  out.failedResponseByOtherSide = cleanAnalystField(out.failedResponseByOtherSide);
  out.whyStrongest = cleanAnalystField(out.whyStrongest);
  out.why = cleanAnalystField(out.why);
  out.manipulation = cleanAnalystField(out.manipulation);
  out.fluff = cleanAnalystField(out.fluff);
  out.weakestOverall = cleanAnalystField(out.weakestOverall);
  out.bsMeter = normalizeBsMeter(out.bsMeter);
  out.winner = normalizeWinner(out.winner);
  out.strongestArgumentSide = normalizeStrongestSide(out.strongestArgumentSide);

  if (!out.strongestArgumentSide) {
    out.strongestArgumentSide =
      out.teamAScore >= out.teamBScore ? "Team A" : "Team B";
  }

  if (
    out.strongestArgument &&
    out.strongestArgument !== "-" &&
    out.strongestArgumentSide === "Team A"
  ) {
    out.strongestOverall = out.teamAName + ": " + out.strongestArgument;
  } else if (
    out.strongestArgument &&
    out.strongestArgument !== "-" &&
    out.strongestArgumentSide === "Team B"
  ) {
    out.strongestOverall = out.teamBName + ": " + out.strongestArgument;
  } else {
    out.strongestOverall = cleanAnalystField(
      String(out.strongestOverall || "")
        .replace(/^Team A:\s*/i, out.teamAName + ": ")
        .replace(/^Team B:\s*/i, out.teamBName + ": ")
    );
  }

  if (
    out.winner === "Mixed" &&
    out.strongestArgumentSide &&
    out.bsMeter !== "Neither side is reaching significantly"
  ) {
    const steadierSide =
      out.bsMeter === "Team A is reaching more"
        ? "Team B"
        : out.bsMeter === "Team B is reaching more"
        ? "Team A"
        : "";

    if (steadierSide && steadierSide !== out.strongestArgumentSide) {
      out.winner = steadierSide;
    }
  }

  const normalizedPair = normalizeScorePair(
    out.teamAScore,
    out.teamBScore,
    out.winner
  );
  out.teamAScore = normalizedPair.teamAScore;
  out.teamBScore = normalizedPair.teamBScore;

  if (!out.weakestOverall || out.weakestOverall === "-") {
    out.weakestOverall = buildWeakestOverall(
      out.teamA,
      out.teamB,
      out.teamAName,
      out.teamBName
    );
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

function chunkTranscript(text, maxChars) {
  const cleaned = String(text).trim();
  if (!cleaned) return [];

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((part) => part.trim())
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

  if (!chunks.length) {
    return [cleaned.slice(0, maxChars)];
  }

  return chunks;
}

function cleanTranscript(text) {
  return normalizeWhitespace(removeTranscriptNoise(String(text).replace(/\r/g, "\n"))).trim();
}

function removeTranscriptNoise(text) {
  return String(text)
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
    .replace(/^\s*politics news\s*$/gim, " ")
    .replace(/^\s*\[music\]\s*$/gim, " ")
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\d*\s*(seconds?|minutes?)\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(seconds?|minutes?)\b/gi, " ")
    .replace(/\b(?:applause|laughter|music)\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}(?=[A-Z])/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?=[A-Za-z])/g, " ")
    .replace(/\b\d{1,2}:\d{2}\d+(?=[A-Za-z])/g, " ");
}

function normalizeWhitespace(text) {
  return String(text)
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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

function withMode(result, mode) {
  return {
    ...result,
    analysisMode: mode
  };
}

function buildFallbackResponse(args) {
  return withMode(
    {
      teamAName: args.teamAName || "Team A",
      teamBName: args.teamBName || "Team B",
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
      teamAScore: 5,
      teamBScore: 5,
      winner: "Mixed",
      strongestArgumentSide: "Team A",
      strongestArgument: "-",
      whyStrongest: safeString(args.reason, "Analysis failed."),
      failedResponseByOtherSide: "-",
      bsMeter: "Neither side is reaching significantly",
      strongestOverall: "-",
      weakestOverall: "-",
      why: safeString(args.reason, "Analysis failed."),
      manipulation: "-",
      fluff: "-",
      sources: []
    },
    "Fallback"
  );
}

function splitDialogueLines(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitLinesIntoSidesSmart(lines, teamAName, teamBName) {
  const teamA = [];
  const teamB = [];
  let current = "A";

  const normalizedA = normalizeSpeakerName(teamAName);
  const normalizedB = normalizeSpeakerName(teamBName);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const speaker = detectSpeaker(line, normalizedA, normalizedB);

    if (speaker === "A") {
      current = "A";
      teamA.push(stripSpeakerPrefix(line));
      continue;
    }

    if (speaker === "B") {
      current = "B";
      teamB.push(stripSpeakerPrefix(line));
      continue;
    }

    if (current === "A") teamA.push(stripSpeakerPrefix(line));
    else teamB.push(stripSpeakerPrefix(line));
  }

  if (!teamA.length && !teamB.length) {
    return splitLinesIntoSidesFallback(lines);
  }

  if (!teamA.length || !teamB.length) {
    return splitLinesIntoSidesFallback(lines);
  }

  return { teamA, teamB };
}

function splitLinesIntoSidesFallback(lines) {
  const teamA = [];
  const teamB = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (i % 2 === 0) teamA.push(stripSpeakerPrefix(lines[i]));
    else teamB.push(stripSpeakerPrefix(lines[i]));
  }

  return { teamA, teamB };
}

function normalizeSpeakerName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectSpeaker(line, normalizedA, normalizedB) {
  const raw = String(line).trim();
  const lower = raw.toLowerCase();

  const prefixMatch = raw.match(/^\s*(?:>>\s*)?([^:\-\]]{1,40})\s*[:\-]\s+/);
  if (!prefixMatch) return "";

  const candidate = normalizeSpeakerName(prefixMatch[1]);

  if (!candidate) return "";
  if (normalizedA && (candidate === normalizedA || candidate.includes(normalizedA))) {
    return "A";
  }
  if (normalizedB && (candidate === normalizedB || candidate.includes(normalizedB))) {
    return "B";
  }

  if (/\b(team a|speaker 1)\b/.test(lower)) return "A";
  if (/\b(team b|speaker 2)\b/.test(lower)) return "B";

  return "";
}

function stripSpeakerPrefix(line) {
  return String(line)
    .replace(/^\s*(?:>>\s*)?([^:\-\]]{1,40})\s*[:\-]\s+/, "")
    .replace(/^\s*(TRUMP|RUBIO|MODERATOR|HOST|QUESTION|AUDIENCE)\s*:\s*/i, "")
    .trim();
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
    return (hasOverclaimLanguage(s) || hasExtremeLanguage(s)) && !hasSupportLanguage(s);
  });
  if (!sentence) return "-";

  return "Overstates: " + makeClaim(sentence);
}

function detectOpinion(text, used) {
  const sentence = pickUnused(splitSentences(text), used, (s) => hasOpinionLanguage(s));
  if (!sentence) return "-";
  return "Subjective framing: " + makeClaim(sentence);
}

function detectBiggestMisinformation(text, used) {
  const sentence = pickUnused(splitSentences(text), used, (s) => {
    return hasLalaLanguage(s) || (hasOverclaimLanguage(s) && !hasSupportLanguage(s));
  });

  if (!sentence) return "-";
  return "Detached claim: " + makeClaim(sentence);
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
  if (s.length > 40) score += 1;
  return score;
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => cleanSentence(s))
    .filter((s) => s.length > 10);
}

function cleanSentence(s) {
  return normalizeWhitespace(removeTranscriptNoise(stripSpeakerPrefix(String(s)))).trim();
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
  const t = String(s).toLowerCase();
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
    t.includes("test") ||
    t.includes("if") ||
    t.includes("then")
  );
}

function hasExtremeLanguage(s) {
  const t = String(s).toLowerCase();
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
  const t = String(s).toLowerCase();
  return (
    t.includes("obviously") ||
    t.includes("clearly") ||
    t.includes("undeniable") ||
    t.includes("proves") ||
    t.includes("no doubt")
  );
}

function hasOpinionLanguage(s) {
  const t = String(s).toLowerCase();
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
  const t = String(s).toLowerCase();
  return (
    t.includes("everybody knows") ||
    t.includes("literally everyone") ||
    t.includes("nothing matters") ||
    t.includes("everything is fake") ||
    t.includes("the whole world") ||
    t.includes("you haven't hired anybody") ||
    t.includes("everyone's dumb") ||
    t.includes("he says five things every night") ||
    t.includes("if he hadn't inherited") ||
    t.includes("that's why you're here") ||
    t.includes("you know where he would be") ||
    t.includes("nobody in your life") ||
    t.includes("all you do is") ||
    t.includes("that's the only reason")
  );
}

function supportScore(text) {
  return splitSentences(text).reduce((score, s) => {
    let add = 0;
    if (hasSupportLanguage(s)) add += 2;
    if (!hasExtremeLanguage(s)) add += 1;
    if (!hasLalaLanguage(s)) add += 1;
    if (s.length > 40) add += 1;
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

function estimateDebateScore(text, fields) {
  let score = 5;

  score += Math.min(2, Math.floor(supportScore(text) / 6));
  score -= Math.min(2, Math.floor(weaknessScore(text) / 4));

  if (fields.truth && fields.truth !== "-") score += 1;
  if (fields.lies && fields.lies !== "-") score -= 1;
  if (fields.lala && fields.lala !== "-") score -= 1;

  return clampScore(score);
}

function normalizeScorePair(teamAScore, teamBScore, winner) {
  let a = clampScore(teamAScore);
  let b = clampScore(teamBScore);

  if (winner === "Team A") {
    if (a <= b) a = Math.min(10, b + 1);
    if (a === 10 && b === 10) b = 8;
  }

  if (winner === "Team B") {
    if (b <= a) b = Math.min(10, a + 1);
    if (a === 10 && b === 10) a = 8;
  }

  if (winner === "Mixed") {
    const even = Math.max(Math.min(a, b), 6);
    a = even;
    b = even;
    if (a === 10 && b === 10) {
      a = 7;
      b = 7;
    }
  }

  return { teamAScore: a, teamBScore: b };
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

function occurrences(text, token) {
  if (!token) return 0;
  const matches = String(text).match(new RegExp(escapeRegExp(token), "g"));
  return matches ? matches.length : 0;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function buildWeakestOverall(teamAData, teamBData, teamAName, teamBName) {
  if (teamAData.lala && teamAData.lala !== "-") {
    return teamAName + ": " + teamAData.lala;
  }
  if (teamBData.lala && teamBData.lala !== "-") {
    return teamBName + ": " + teamBData.lala;
  }
  if (teamAData.lies && teamAData.lies !== "-") {
    return teamAName + ": " + teamAData.lies;
  }
  if (teamBData.lies && teamBData.lies !== "-") {
    return teamBName + ": " + teamBData.lies;
  }
  return "No clearly terrible argument.";
}

function buildWhy(winner, teamAName, teamBName) {
  if (winner === "Team A") {
    return teamAName + " had the more grounded case overall.";
  }
  if (winner === "Team B") {
    return teamBName + " had the more grounded case overall.";
  }
  return "Neither side separated enough to claim a clear edge.";
}

function buildManipulation(teamAText, teamBText) {
  const a = manipulationCount(teamAText);
  const b = manipulationCount(teamBText);

  if (a === 0 && b === 0) return "No major manipulation pattern detected.";
  if (Math.abs(a - b) <= 1) return "Both sides lean on framing moves at times.";
  return a > b
    ? "Team A leans more on manipulation or loaded framing."
    : "Team B leans more on manipulation or loaded framing.";
}

function manipulationCount(text) {
  const t = String(text).toLowerCase();
  const flags = [
    "you just",
    "you people",
    "be honest",
    "everyone knows",
    "admit it",
    "obviously",
    "clearly"
  ];
  return flags.reduce((sum, flag) => sum + occurrences(t, flag), 0);
}

function buildFluff(countA, countB) {
  if (countA === 0 && countB === 0) return "Low fluff overall.";
  if (Math.abs(countA - countB) <= 1) return "Both sides use some filler.";
  return countA > countB
    ? "Team A uses more filler and verbal padding."
    : "Team B uses more filler and verbal padding.";
}

function cleanAnalystField(value) {
  let text = safeString(value, "-");
  if (text === "-") return text;

  text = String(text)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\d*\s*(seconds?|minutes?)\b/gi, " ")
    .replace(/\b(TRUMP|RUBIO|MODERATOR|HOST|QUESTION|AUDIENCE)\s*:\s*/gi, "")
    .replace(/>>\s*[^:]+:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  text = normalizeWhitespace(removeTranscriptNoise(text))
    .replace(/^Team A:\s*/i, "")
    .replace(/^Team B:\s*/i, "")
    .trim();

  if (!text) return "-";
  return text;
}

function makeClaim(sentence) {
  const cleaned = cleanAnalystField(sentence);
  if (cleaned === "-") return "-";

  let text = cleaned
    .replace(/^grounded point:\s*/i, "")
    .replace(/^overstates:\s*/i, "")
    .replace(/^subjective framing:\s*/i, "")
    .replace(/^detached claim:\s*/i, "")
    .replace(/^unsupported leap:\s*/i, "")
    .replace(/^argues that\s*/i, "")
    .trim();

  text = capitalize(text);
  if (!/[.!?]$/.test(text)) text += ".";
  return text;
}

function capitalize(text) {
  const s = safeString(text, "");
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
