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

    // Always build a deterministic local result first
    const localResult = buildDeterministicResult({
      teamAName: teamAName,
      teamBName: teamBName,
      transcript: cleanedTranscript,
      videoLink: videoLink
    });

    // If no Groq key, return local result immediately
    if (!process.env.GROQ_API_KEY) {
      return res.status(200).json(localResult);
    }

    // Try AI enhancement, but NEVER let it kill the whole app
    try {
      const chunks = chunkTranscript(cleanedTranscript, 900);
      const chunkResults = [];

      for (let i = 0; i < chunks.length; i += 1) {
        await sleep(1800);

        const chunkPrompt = buildChunkPrompt({
          teamAName: teamAName,
          teamBName: teamBName,
          videoLink: videoLink,
          chunkText: chunks[i],
          chunkNumber: i + 1,
          totalChunks: chunks.length
        });

        const chunkResponse = await callGroq(chunkPrompt);

        if (!chunkResponse.ok) {
          return res.status(200).json(withAiNote(localResult, "AI chunk step failed. Showing local analysis."));
        }

        let parsedChunk;
        try {
          parsedChunk = safeParseJson(chunkResponse.content);
        } catch (err) {
          return res.status(200).json(withAiNote(localResult, "AI chunk JSON failed. Showing local analysis."));
        }

        chunkResults.push(normalizeChunkResult(parsedChunk));
      }

      await sleep(2200);

      const synthesisPrompt = buildSynthesisPrompt({
        teamAName: teamAName,
        teamBName: teamBName,
        videoLink: videoLink,
        chunkResults: chunkResults
      });

      const synthesisResponse = await callGroq(synthesisPrompt);

      if (!synthesisResponse.ok) {
        return res.status(200).json(withAiNote(localResult, "AI synthesis failed. Showing local analysis."));
      }

      let parsedFinal;
      try {
        parsedFinal = safeParseJson(synthesisResponse.content);
      } catch (err) {
        return res.status(200).json(withAiNote(localResult, "AI synthesis JSON failed. Showing local analysis."));
      }

      const aiResult = normalizeAiFinalResult(parsedFinal, {
        teamAName: teamAName,
        teamBName: teamBName
      });

      return res.status(200).json(mergeLocalAndAi(localResult, aiResult));
    } catch (err) {
      return res.status(200).json(withAiNote(localResult, "AI enhancement failed. Showing local analysis."));
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
    "Return ONLY valid JSON.",
    "No markdown.",
    "No code fences.",
    "No explanation outside JSON.",
    "",
    "Analyze this debate chunk.",
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
    "Rules:",
    '- winnerLean must be exactly "Team A", "Team B", or "Mixed".',
    "- Keep points short.",
    "- No extra keys.",
    "",
    "Chunk text:",
    args.chunkText
  ].join("\n");
}

function buildSynthesisPrompt(args) {
  return [
    "Return ONLY valid JSON.",
    "No markdown.",
    "No code fences.",
    "No explanation outside JSON.",
    "",
    "Synthesize these chunk analyses into one final result.",
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
    '  "winner": "",',
    '  "bsMeter": "",',
    '  "strongestOverall": "",',
    '  "weakestOverall": "",',
    '  "why": "",',
    '  "manipulation": "",',
    '  "fluff": ""',
    "}",
    "",
    "Rules:",
    '- winner must be exactly "Team A", "Team B", or "Mixed".',
    "- No nested objects.",
    "- No arrays.",
    "- No extra keys.",
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

  const teamAMain = summarizeMainPosition(teamAJoined);
  const teamBMain = summarizeMainPosition(teamBJoined);

  const teamATruth = detectReasonableClaims(teamAJoined);
  const teamBTruth = detectReasonableClaims(teamBJoined);

  const teamALies = detectWeakClaims(teamAJoined);
  const teamBLies = detectWeakClaims(teamBJoined);

  const teamAOpinion = detectOpinion(teamAJoined);
  const teamBOpinion = detectOpinion(teamBJoined);

  const teamALala = detectLala(teamAJoined);
  const teamBLala = detectLala(teamBJoined);

  const fluffA = countFluff(teamAJoined);
  const fluffB = countFluff(teamBJoined);
  const weakA = weaknessScore(teamAJoined);
  const weakB = weaknessScore(teamBJoined);
  const supportA = supportScore(teamAJoined);
  const supportB = supportScore(teamBJoined);

  let winner = "Mixed";
  if (supportA - weakA > supportB - weakB + 1) winner = "Team A";
  if (supportB - weakB > supportA - weakA + 1) winner = "Team B";

  const bsMeter = buildBsMeter(weakA, weakB);
  const strongestOverall = buildStrongestOverall(teamAJoined, teamBJoined, args.teamAName, args.teamBName);
  const weakestOverall = buildWeakestOverall(teamAJoined, teamBJoined, args.teamAName, args.teamBName);
  const why = buildWhy(winner, supportA, weakA, supportB, weakB, args.teamAName, args.teamBName);
  const manipulation = buildManipulation(teamAJoined, teamBJoined);
  const fluff = buildFluff(fluffA, fluffB);

  return {
    teamAName: args.teamAName,
    teamBName: args.teamBName,
    teamA: {
      main_position: teamAMain,
      truth: teamATruth,
      lies: teamALies,
      opinion: teamAOpinion,
      lala: teamALala
    },
    teamB: {
      main_position: teamBMain,
      truth: teamBTruth,
      lies: teamBLies,
      opinion: teamBOpinion,
      lala: teamBLala
    },
    winner: winner,
    bsMeter: bsMeter,
    strongestOverall: strongestOverall,
    weakestOverall: weakestOverall,
    why: why,
    manipulation: manipulation,
    fluff: fluff,
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

function summarizeMainPosition(text) {
  const sentences = splitSentences(text);
  if (!sentences.length) return "-";
  return shorten(sentences[0], 140);
}

function detectReasonableClaims(text) {
  const sentences = splitSentences(text);
  const picked = sentences.filter(function (s) {
    return hasSupportLanguage(s) && !hasExtremeLanguage(s);
  });
  if (!picked.length) return "-";
  return shorten(picked.slice(0, 2).join(" | "), 220);
}

function detectWeakClaims(text) {
  const sentences = splitSentences(text);
  const picked = sentences.filter(function (s) {
    return hasExtremeLanguage(s) || hasOverclaimLanguage(s);
  });
  if (!picked.length) return "-";
  return shorten(picked.slice(0, 2).join(" | "), 220);
}

function detectOpinion(text) {
  const sentences = splitSentences(text);
  const picked = sentences.filter(function (s) {
    return hasOpinionLanguage(s);
  });
  if (!picked.length) return "-";
  return shorten(picked.slice(0, 2).join(" | "), 220);
}

function detectLala(text) {
  const sentences = splitSentences(text);
  const picked = sentences.filter(function (s) {
    return hasLalaLanguage(s);
  });
  if (!picked.length) return "-";
  return shorten(picked.slice(0, 2).join(" | "), 220);
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
    t.includes("means")
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
    t.includes("would like")
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

function buildBsMeter(weakA, weakB) {
  if (Math.abs(weakA - weakB) <= 1) return "50/50";
  if (weakA > weakB) return "Team A is reaching more";
  return "Team B is reaching more";
}

function buildStrongestOverall(teamA, teamB, teamAName, teamBName) {
  const a = detectReasonableClaims(teamA);
  const b = detectReasonableClaims(teamB);
  if (a === "-" && b === "-") return "-";
  if (a !== "-" && b === "-") return teamAName + ": " + a;
  if (b !== "-" && a === "-") return teamBName + ": " + b;
  return a.length >= b.length ? teamAName + ": " + a : teamBName + ": " + b;
}

function buildWeakestOverall(teamA, teamB, teamAName, teamBName) {
  const a = detectWeakClaims(teamA);
  const b = detectWeakClaims(teamB);
  if (a === "-" && b === "-") return "-";
  if (a !== "-" && b === "-") return teamAName + ": " + a;
  if (b !== "-" && a === "-") return teamBName + ": " + b;
  return a.length >= b.length ? teamAName + ": " + a : teamBName + ": " + b;
}

function buildWhy(winner, supportA, weakA, supportB, weakB, teamAName, teamBName) {
  if (winner === "Team A") {
    return teamAName + " had slightly more support and less weak overreach overall.";
  }
  if (winner === "Team B") {
    return teamBName + " had slightly more support and less weak overreach overall.";
  }
  return "Both sides had mixed strengths and weak spots, so neither side created a clear edge.";
}

function buildManipulation(teamA, teamB) {
  const text = (teamA + " " + teamB).toLowerCase();
  if (
    text.includes("you people") ||
    text.includes("you just") ||
    text.includes("that’s ridiculous") ||
    text.includes("be honest")
  ) {
    return "Some rhetorical pressure or dismissive framing appears in the exchange.";
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

function mergeLocalAndAi(localResult, aiResult) {
  return {
    teamAName: aiResult.teamAName || localResult.teamAName,
    teamBName: aiResult.teamBName || localResult.teamBName,
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
    winner: pickBetter(aiResult.winner, localResult.winner),
    bsMeter: pickBetter(aiResult.bsMeter, localResult.bsMeter),
    strongestOverall: pickBetter(aiResult.strongestOverall, localResult.strongestOverall),
    weakestOverall: pickBetter(aiResult.weakestOverall, localResult.weakestOverall),
    why: pickBetter(aiResult.why, localResult.why),
    manipulation: pickBetter(aiResult.manipulation, localResult.manipulation),
    fluff: pickBetter(aiResult.fluff, localResult.fluff),
    sources: localResult.sources
  };
}

function withAiNote(result, note) {
  return {
    teamAName: result.teamAName,
    teamBName: result.teamBName,
    teamA: result.teamA,
    teamB: result.teamB,
    winner: result.winner,
    bsMeter: result.bsMeter,
    strongestOverall: result.strongestOverall,
    weakestOverall: result.weakestOverall,
    why: result.why + " " + note,
    manipulation: result.manipulation,
    fluff: result.fluff,
    sources: result.sources
  };
}

function pickBetter(primary, fallback) {
  if (primary && primary !== "-" && primary !== "Mixed") return primary;
  return fallback;
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

function normalizeAiFinalResult(parsed, defaults) {
  return {
    teamAName: safeString(parsed && parsed.teamAName, defaults.teamAName),
    teamBName: safeString(parsed && parsed.teamBName, defaults.teamBName),
    teamA: {
      main_position: safeString(parsed && parsed.teamA_main_position),
      truth: safeString(parsed && parsed.teamA_truth),
      lies: safeString(parsed && parsed.teamA_lies),
      opinion: safeString(parsed && parsed.teamA_opinion),
      lala: safeString(parsed && parsed.teamA_lala)
    },
    teamB: {
      main_position: safeString(parsed && parsed.teamB_main_position),
      truth: safeString(parsed && parsed.teamB_truth),
      lies: safeString(parsed && parsed.teamB_lies),
      opinion: safeString(parsed && parsed.teamB_opinion),
      lala: safeString(parsed && parsed.teamB_lala)
    },
    winner: normalizeWinner(parsed && parsed.winner),
    bsMeter: safeString(parsed && parsed.bsMeter),
    strongestOverall: safeString(parsed && parsed.strongestOverall),
    weakestOverall: safeString(parsed && parsed.weakestOverall),
    why: safeString(parsed && parsed.why),
    manipulation: safeString(parsed && parsed.manipulation),
    fluff: safeString(parsed && parsed.fluff),
    sources: []
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
    bestPoint: safeString(parsed && parsed.bestPoint),
    worstPoint: safeString(parsed && parsed.worstPoint),
    manipulation: safeString(parsed && parsed.manipulation),
    fluff: safeString(parsed && parsed.fluff)
  };
}

function normalizeWinner(value) {
  const text = safeString(value, "Mixed");
  return text === "Team A" || text === "Team B" || text === "Mixed"
    ? text
    : "Mixed";
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

function safeString(value, fallback) {
  if (value === null || value === undefined) return fallback || "-";
  const text = String(value).trim();
  return text ? text : fallback || "-";
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function buildFallbackResponse(args) {
  return {
    teamAName: args.teamAName,
    teamBName: args.teamBName,
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
    winner: "Mixed",
    bsMeter: "No live AI judgment available",
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
