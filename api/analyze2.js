export default async function handler(req, res) {
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
      return res.status(400).json({
        error: "Transcript is required"
      });
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
          teamAName,
          teamBName,
          reason: "Missing GROQ_API_KEY in Vercel environment variables."
        })
      );
    }

    const chunks = chunkTranscript(cleanedTranscript, 4500);
    const chunkResults = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];

      const chunkPrompt = buildChunkPrompt({
        teamAName,
        teamBName,
        videoLink,
        chunkText: chunk,
        chunkNumber: i + 1,
        totalChunks: chunks.length
      });

      const chunkResponse = await callGroqJson(chunkPrompt);

      if (!chunkResponse.ok) {
        return res.status(200).json(
          buildFallbackResponse({
            teamAName,
            teamBName,
            reason: `Chunk analysis failed: ${chunkResponse.error}`
          })
        );
      }

      let parsedChunk;
      try {
        parsedChunk = JSON.parse(chunkResponse.content);
      } catch (err) {
        return res.status(200).json(
          buildFallbackResponse({
            teamAName,
            teamBName,
            reason: "A chunk returned invalid JSON."
          })
        );
      }

      chunkResults.push(normalizeChunkResult(parsedChunk));
    }

    const synthesisPrompt = buildSynthesisPrompt({
      teamAName,
      teamBName,
      videoLink,
      chunkResults
    });

    const synthesisResponse = await callGroqJson(synthesisPrompt);

    if (!synthesisResponse.ok) {
      return res.status(200).json(
        buildFallbackResponse({
          teamAName,
          teamBName,
          reason: `Final synthesis failed: ${synthesisResponse.error}`
        })
      );
    }

    let parsedFinal;
    try {
      parsedFinal = JSON.parse(synthesisResponse.content);
    } catch (err) {
      return res.status(200).json(
        buildFallbackResponse({
          teamAName,
          teamBName,
          reason: "Final synthesis returned invalid JSON."
        })
      );
    }

    const safeResult = normalizeFinalResult(parsedFinal, {
      teamAName,
      teamBName
    });

    return res.status(200).json(safeResult);
  } catch (err) {
    return res.status(200).json(
      buildFallbackResponse({
        teamAName: "Team A",
        teamBName: "Team B",
        reason: "Unexpected backend failure."
      })
    );
  }
}

async function callGroqJson(prompt) {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-70b-8192",
        temperature: 0.1,
        response_format: { type: "json_object" },
        max_tokens: 1800,
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
        raw?.error?.message || raw?.message || "Groq request failed";
      return {
        ok: false,
        error: message
      };
    }

    const content = raw?.choices?.[0]?.message?.content;

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

function buildChunkPrompt({
  teamAName,
  teamBName,
  videoLink,
  chunkText,
  chunkNumber,
  totalChunks
}) {
  return `
Return ONLY valid JSON.
No markdown.
No code fences.
No commentary before or after the JSON.

You are analyzing one chunk of a larger debate transcript.

Ignore:
- timestamps
- metadata
- uploader junk
- category labels
- title text
- page filler
- platform junk

Analyze ONLY the spoken exchange in this chunk.

Team A label: ${teamAName}
Team B label: ${teamBName}
Optional link: ${videoLink || "No link provided"}
Chunk: ${chunkNumber} of ${totalChunks}

Return this exact JSON shape:

{
  "teamA": {
    "main_points": [],
    "truth_points": [],
    "lie_points": [],
    "opinion_points": [],
    "lala_points": []
  },
  "teamB": {
    "main_points": [],
    "truth_points": [],
    "lie_points": [],
    "opinion_points": [],
    "lala_points": []
  },
  "winnerLean": "",
  "bestPoint": "",
  "worstPoint": "",
  "manipulation": "",
  "fluff": "",
  "sourceClaims": [
    {
      "claim": "",
      "type": "",
      "likely_source": "",
      "confidence": ""
    }
  ]
}

Rules:
- Arrays should contain short concrete points from THIS chunk only.
- winnerLean must be exactly "Team A", "Team B", or "Mixed".
- bestPoint must be one specific strong point from this chunk.
- worstPoint must be one specific weak point from this chunk.
- sourceClaims should include up to 3 claims needing outside verification.

Transcript chunk:
${chunkText}
`.trim();
}

function buildSynthesisPrompt({
  teamAName,
  teamBName,
  videoLink,
  chunkResults
}) {
  return `
Return ONLY valid JSON.
No markdown.
No code fences.
No commentary before or after the JSON.

You are synthesizing chunk-level debate analyses into one final result.

Team A label: ${teamAName}
Team B label: ${teamBName}
Optional link: ${videoLink || "No link provided"}

Use this exact JSON shape:

{
  "teamAName": "",
  "teamBName": "",
  "teamA": {
    "main_position": "",
    "truth": "",
    "lies": "",
    "opinion": "",
    "lala": ""
  },
  "teamB": {
    "main_position": "",
    "truth": "",
    "lies": "",
    "opinion": "",
    "lala": ""
  },
  "winner": "",
  "bsMeter": "",
  "strongestOverall": "",
  "weakestOverall": "",
  "why": "",
  "manipulation": "",
  "fluff": "",
  "sources": [
    {
      "claim": "",
      "type": "",
      "likely_source": "",
      "confidence": ""
    }
  ]
}

Rules:
- winner must be exactly "Team A", "Team B", or "Mixed".
- truth = grounded, supported, reasonable claims overall.
- lies = false, exaggerated, unsupported, or overconfident claims overall.
- opinion = subjective framing overall.
- lala = fantasy leaps, absurd overreach, or nonsense overall.
- strongestOverall must identify one specific strong point.
- weakestOverall must identify one specific weak point.
- bsMeter must clearly say who is bluffing/reaching more, or say 50/50 if truly even.
- why must explain the edge plainly.
- sources should include 2 to 4 claims needing outside verification.

Chunk analyses:
${JSON.stringify(chunkResults, null, 2)}
`.trim();
}

function chunkTranscript(text, maxChars = 4500) {
  const paragraphs = text
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
      main_points: safeArray(parsed?.teamA?.main_points),
      truth_points: safeArray(parsed?.teamA?.truth_points),
      lie_points: safeArray(parsed?.teamA?.lie_points),
      opinion_points: safeArray(parsed?.teamA?.opinion_points),
      lala_points: safeArray(parsed?.teamA?.lala_points)
    },
    teamB: {
      main_points: safeArray(parsed?.teamB?.main_points),
      truth_points: safeArray(parsed?.teamB?.truth_points),
      lie_points: safeArray(parsed?.teamB?.lie_points),
      opinion_points: safeArray(parsed?.teamB?.opinion_points),
      lala_points: safeArray(parsed?.teamB?.lala_points)
    },
    winnerLean: normalizeWinner(parsed?.winnerLean),
    bestPoint: safeString(parsed?.bestPoint),
    worstPoint: safeString(parsed?.worstPoint),
    manipulation: safeString(parsed?.manipulation),
    fluff: safeString(parsed?.fluff),
    sourceClaims: normalizeSources(parsed?.sourceClaims).slice(0, 3)
  };
}

function normalizeFinalResult(parsed, defaults) {
  return {
    teamAName: safeString(parsed?.teamAName, defaults.teamAName),
    teamBName: safeString(parsed?.teamBName, defaults.teamBName),
    teamA: {
      main_position: safeString(parsed?.teamA?.main_position),
      truth: safeString(parsed?.teamA?.truth),
      lies: safeString(parsed?.teamA?.lies),
      opinion: safeString(parsed?.teamA?.opinion),
      lala: safeString(parsed?.teamA?.lala)
    },
    teamB: {
      main_position: safeString(parsed?.teamB?.main_position),
      truth: safeString(parsed?.teamB?.truth),
      lies: safeString(parsed?.teamB?.lies),
      opinion: safeString(parsed?.teamB?.opinion),
      lala: safeString(parsed?.teamB?.lala)
    },
    winner: normalizeWinner(parsed?.winner),
    bsMeter: safeString(parsed?.bsMeter),
    strongestOverall: safeString(parsed?.strongestOverall),
    weakestOverall: safeString(parsed?.weakestOverall),
    why: safeString(parsed?.why),
    manipulation: safeString(parsed?.manipulation),
    fluff: safeString(parsed?.fluff),
    sources: normalizeSources(parsed?.sources).slice(0, 4)
  };
}

function normalizeSources(input) {
  const arr = Array.isArray(input) ? input : [];

  if (!arr.length) {
    return [
      {
        claim: "No explicit source claims extracted",
        type: "general",
        likely_source: "No direct source — requires verification",
        confidence: "low"
      }
    ];
  }

  return arr.map((item) => ({
    claim: safeString(item?.claim, "No explicit source claim extracted"),
    type: safeString(item?.type, "general"),
    likely_source: safeString(
      item?.likely_source,
      "No direct source — requires verification"
    ),
    confidence: safeString(item?.confidence, "low")
  }));
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
    .map((item) => safeString(item, ""))
    .filter((item) => item && item !== "-")
    .slice(0, 6);
}

function cleanSimpleName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function cleanTranscript(text) {
  return String(text)
    .replace(/\r/g, "\n")

    // urls
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")

    // page junk
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

    // wrapper junk
    .replace(/^\s*chapter\s+\d+.*$/gim, " ")
    .replace(/^\s*\d+\s+views?\s*$/gim, " ")
    .replace(
      /^\s*\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\s*$/gim,
      " "
    )

    // timestamps
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")

    // bare bracket metadata
    .replace(/^\s*\[[^\]]*\]\s*$/gm, " ")
    .replace(/^\s*\([^)]*\)\s*$/gm, " ")

    // giant junk blobs
    .replace(/[A-Za-z0-9_-]{25,}/g, " ")

    // normalize
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getTranscriptStats(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
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

function safeString(value, fallback = "-") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function buildFallbackResponse({ teamAName, teamBName, reason }) {
  return {
    teamAName,
    teamBName,
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
    why: safeString(reason, "AI unavailable."),
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
