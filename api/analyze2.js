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
          reason:
            "Missing GROQ_API_KEY. The app is wired, but no Groq server key is available."
        })
      );
    }

    const prompt = buildPrompt({
      teamAName,
      teamBName,
      videoLink,
      cleanedTranscript
    });

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0.1,
        response_format: { type: "json_object" },
        reasoning_format: "hidden",
        max_completion_tokens: 2200,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const rawResponse = await safeJson(response);

    if (!response.ok) {
      const providerMessage =
        rawResponse?.error?.message ||
        rawResponse?.message ||
        "Groq request failed";

      const lowered = String(providerMessage).toLowerCase();

      if (lowered.includes("rate")) {
        return res.status(200).json(
          buildFallbackResponse({
            teamAName,
            teamBName,
            reason:
              "Groq rate-limit issue. The provider refused the request right now."
          })
        );
      }

      if (
        lowered.includes("api key") ||
        lowered.includes("authentication") ||
        lowered.includes("unauthorized")
      ) {
        return res.status(200).json(
          buildFallbackResponse({
            teamAName,
            teamBName,
            reason: "Groq API key issue. Check the key stored in Vercel."
          })
        );
      }

      if (
        lowered.includes("failed to validate json") ||
        lowered.includes("failed_generation")
      ) {
        return res.status(200).json(
          buildFallbackResponse({
            teamAName,
            teamBName,
            reason:
              "Groq JSON validation failed. The provider did not return valid JSON for this request."
          })
        );
      }

      return res.status(200).json(
        buildFallbackResponse({
          teamAName,
          teamBName,
          reason: `Provider error: ${providerMessage}`
        })
      );
    }

    const content = rawResponse?.choices?.[0]?.message?.content;

    if (!content) {
      return res.status(200).json(
        buildFallbackResponse({
          teamAName,
          teamBName,
          reason: "Groq returned no message content."
        })
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return res.status(200).json(
        buildFallbackResponse({
          teamAName,
          teamBName,
          reason: "Returned content was not valid JSON."
        })
      );
    }

    const safeResult = normalizeResult(parsed, { teamAName, teamBName });
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

    // common page junk
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

    // chapter labels / wrapper junk
    .replace(/^\s*chapter\s+\d+.*$/gim, " ")
    .replace(/^\s*\d+\s+views?\s*$/gim, " ")
    .replace(
      /^\s*\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\s*$/gim,
      " "
    )

    // inline timestamps
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")

    // timestamp-heavy lines
    .replace(
      /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*(minutes?,?\s*\d+\s*seconds?)?.*$/gim,
      function (line) {
        const stripped = line.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "").trim();
        if (!stripped) return " ";
        return stripped;
      }
    )

    // bare bracket metadata
    .replace(/^\s*\[[^\]]*\]\s*$/gm, " ")
    .replace(/^\s*\([^)]*\)\s*$/gm, " ")

    // giant junk blobs
    .replace(/[A-Za-z0-9_-]{25,}/g, " ")

    // whitespace normalize
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

function buildPrompt({ teamAName, teamBName, videoLink, cleanedTranscript }) {
  return `
Return ONLY valid JSON.
Do not include markdown.
Do not include commentary before or after the JSON.
Do not include code fences.

Ignore all metadata, timestamps, labels, title text, page filler, category text, and platform junk.
Analyze ONLY the actual spoken exchange and argumentative content.

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
- winner must be exactly "Team A", "Team B", or "Mixed"
- truth = grounded, supported, reasonable claims
- lies = false, exaggerated, unsupported, or overconfident claims
- opinion = subjective framing
- lala = fantasy leaps, absurd overreach, reality disconnect, or nonsense
- strongestOverall = one specific strong point
- weakestOverall = one specific weak point
- sources = 2 to 4 claims needing outside verification when possible

Transcript:
${cleanedTranscript}
`.trim();
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (err) {
    return null;
  }
}

function normalizeResult(parsed, defaults) {
  const safeTeamA = normalizeTeam(parsed?.teamA);
  const safeTeamB = normalizeTeam(parsed?.teamB);

  const winnerRaw = safeString(parsed?.winner);
  const winner =
    winnerRaw === "Team A" || winnerRaw === "Team B" || winnerRaw === "Mixed"
      ? winnerRaw
      : "Mixed";

  let sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
  sources = sources
    .map((item) => ({
      claim: safeString(item?.claim, "No explicit source claim extracted"),
      type: safeString(item?.type, "general"),
      likely_source: safeString(
        item?.likely_source,
        "No direct source — requires verification"
      ),
      confidence: safeString(item?.confidence, "low")
    }))
    .slice(0, 4);

  if (!sources.length) {
    sources = [
      {
        claim: "No explicit source claims extracted",
        type: "general",
        likely_source: "No direct source — requires verification",
        confidence: "low"
      }
    ];
  }

  return {
    teamAName: safeString(parsed?.teamAName, defaults.teamAName),
    teamBName: safeString(parsed?.teamBName, defaults.teamBName),
    teamA: safeTeamA,
    teamB: safeTeamB,
    winner,
    bsMeter: safeString(parsed?.bsMeter),
    strongestOverall: safeString(parsed?.strongestOverall),
    weakestOverall: safeString(parsed?.weakestOverall),
    why: safeString(parsed?.why),
    manipulation: safeString(parsed?.manipulation),
    fluff: safeString(parsed?.fluff),
    sources
  };
}

function normalizeTeam(team) {
  return {
    main_position: safeString(team?.main_position),
    truth: safeString(team?.truth),
    lies: safeString(team?.lies),
    opinion: safeString(team?.opinion),
    lala: safeString(team?.lala)
  };
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
