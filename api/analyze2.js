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

    if (stats.wordCount < 80 || stats.lineCount < 4) {
      return res.status(400).json({
        error:
          "This does not look like a usable debate transcript yet. Paste the actual spoken exchange, not metadata, timestamps, titles, or outro junk."
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(200).json(
        buildFallbackResponse({
          teamAName: teamAName,
          teamBName: teamBName,
          reason: "Missing GROQ_API_KEY in Vercel environment variables."
        })
      );
    }

    const chunks = chunkTranscript(cleanedTranscript, 1200);
    const chunkResults = [];

    for (let i = 0; i < chunks.length; i += 1) {
      await sleep(2000);

      const chunkPrompt = buildChunkPrompt({
        teamAName: teamAName,
        teamBName: teamBName,
        videoLink: videoLink,
        chunkText: chunks[i],
        chunkNumber: i + 1,
        totalChunks: chunks.length
      });

      const chunkResponse = await callGroqJson(chunkPrompt);

      if (!chunkResponse.ok) {
        return res.status(200).json(
          buildFallbackResponse({
            teamAName: teamAName,
            teamBName: teamBName,
            reason: "Chunk analysis failed: " + chunkResponse.error
          })
        );
      }

      let parsedChunk;
      try {
        parsedChunk = safeParseJson(chunkResponse.content);
      } catch (err) {
        return res.status(200).json(
          buildFallbackResponse({
            teamAName: teamAName,
            teamBName: teamBName,
            reason: "A chunk returned invalid JSON."
          })
        );
      }

      chunkResults.push(normalizeChunkResult(parsedChunk));
    }

    await sleep(2500);

    const synthesisPrompt = buildSynthesisPrompt({
      teamAName: teamAName,
      teamBName: teamBName,
      videoLink: videoLink,
      chunkResults: chunkResults
    });

    const synthesisResponse = await callGroqJson(synthesisPrompt);

    if (!synthesisResponse.ok) {
      return res.status(200).json(
        buildFallbackResponse({
          teamAName: teamAName,
          teamBName: teamBName,
          reason: "Final synthesis failed: " + synthesisResponse.error
        })
      );
    }

    let parsedFinal;
    try {
      parsedFinal = safeParseJson(synthesisResponse.content);
    } catch (err) {
      return res.status(200).json(
        buildFallbackResponse({
          teamAName: teamAName,
          teamBName: teamBName,
          reason: "Final synthesis returned invalid JSON."
        })
      );
    }

    return res.status(200).json(
      normalizeFinalResult(parsedFinal, {
        teamAName: teamAName,
        teamBName: teamBName
      })
    );
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

async function callGroqJson(prompt) {
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
        response_format: { type: "json_object" },
        max_completion_tokens: 600,
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
    "You MUST return ONLY valid JSON.",
    "NO text before JSON.",
    "NO text after JSON.",
    "NO markdown.",
    "NO explanations.",
    "NO comments.",
    "If you break this, the system fails.",
    "",
    "You are analyzing one chunk of a larger debate transcript.",
    "",
    "Ignore:",
    "- timestamps",
    "- metadata",
    "- uploader junk",
    "- category labels",
    "- title text",
    "- page filler",
    "- platform junk",
    "",
    "Analyze ONLY the spoken exchange in this chunk.",
    "",
    "Team A label: " + args.teamAName,
    "Team B label: " + args.teamBName,
    "Optional link: " + (args.videoLink || "No link provided"),
    "Chunk: " + args.chunkNumber + " of " + args.totalChunks,
    "",
    "Return this exact JSON shape:",
    "",
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
    "- Arrays should contain short concrete points from THIS chunk only.",
    '- winnerLean must be exactly "Team A", "Team B", or "Mixed".',
    "- bestPoint must be one specific strong point from this chunk.",
    "- worstPoint must be one specific weak point from this chunk.",
    "- Keep each point short and direct.",
    "- No extra keys.",
    "",
    "Transcript chunk:",
    args.chunkText
  ].join("\n");
}

function buildSynthesisPrompt(args) {
  return [
    "STRICT MODE:",
    "You MUST return ONLY valid JSON.",
    "NO text before JSON.",
    "NO text after JSON.",
    "NO markdown.",
    "NO explanations.",
    "NO comments.",
    "If you break this, the system fails.",
    "",
    "You are synthesizing chunk-level debate analyses into one final result.",
    "",
    "Team A label: " + args.teamAName,
    "Team B label: " + args.teamBName,
    "Optional link: " + (args.videoLink || "No link provided"),
    "",
    "Return this exact JSON shape only:",
    "",
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
    "- Keep each field short and direct.",
    "- Do not include arrays.",
    "- Do not include nested objects.",
    "- Do not include extra keys.",
    "",
    "Chunk analyses:",
    JSON.stringify(args.chunkResults, null, 2)
  ].join("\n");
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

function normalizeFinalResult(parsed, defaults) {
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
    sources: [
      {
        claim: "Final synthesis did not include source extraction",
        type: "general",
        likely_source: "Manual verification needed",
        confidence: "low"
      }
    ]
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

async function safeJson(response) {
  try {
    return await response.json();
  } catch (err) {
    return null;
  }
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
