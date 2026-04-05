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

    const schema = buildSchema();

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0.1,
        response_format: {
          type: "json_schema",
          json_schema: schema
        },
        messages: [
          {
            role: "system",
            content:
              "Return only schema-valid JSON. Ignore transcript metadata, timestamps, labels, title text, category text, and platform filler."
          },
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
              "Groq rate-limit issue. The app is wired correctly, but the provider is refusing requests right now."
          })
        );
      }

      if (lowered.includes("api key") || lowered.includes("authentication") || lowered.includes("unauthorized")) {
        return res.status(200).json(
          buildFallbackResponse({
            teamAName,
            teamBName,
            reason:
              "Groq API key issue. Check the key stored in Vercel."
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
          reason: "Structured output parsing failed."
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

    // chapter labels / youtube wrapper junk
    .replace(/^\s*chapter\s+\d+.*$/gim, " ")
    .replace(/^\s*\d+\s+views?\s*$/gim, " ")
    .replace(
      /^\s*\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\s*$/gim,
      " "
    )

    // inline timestamp junk
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")

    // lines that begin with timestamp sludge
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

    // giant encoded junk blobs
    .replace(/[A-Za-z0-9_-]{25,}/g, " ")

    // normalize whitespace
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
You are a ruthless debate analyst.

IMPORTANT:
The transcript may contain metadata such as:
- video title
- channel name
- views
- months ago / years ago
- chapter labels
- timestamps
- sync to video time
- subscribe prompts
- outro junk
- uploader notes
- category labels

You must IGNORE all metadata, timestamps, labels, title text, page filler, and platform junk.
Analyze ONLY the actual spoken exchange and argumentative content.

Optional Team A Name: ${teamAName}
Optional Team B Name: ${teamBName}
Optional Link: ${videoLink || "No link provided"}

Transcript:
${cleanedTranscript}

Return ONLY valid JSON in this exact shape:

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
- Ignore metadata and non-debate filler completely.
- Be decisive.
- Do NOT use filler like "could not be isolated cleanly" unless the content is genuinely too weak.
- "winner" must be exactly "Team A", "Team B", or "Mixed".
- "truth" = grounded, supported, reasonable claims by that side.
- "lies" = false, exaggerated, unsupported, or overconfident claims by that side.
- "opinion" = subjective framing by that side.
- "lala" = fantasy leaps, absurd overreach, reality disconnect, nonsense by that side.
- "bsMeter" must plainly say who is bluffing or reaching more and why.
- "strongestOverall" must identify one specific strong point from the exchange.
- "weakestOverall" must identify one specific weak point from the exchange.
- "why" must explain the edge plainly.
- "manipulation" should describe rhetorical pressure or emotional steering if present.
- "fluff" should describe actual spoken filler or repetition, not metadata.
- "sources" should list 2 to 4 claims that would need outside verification where possible.
`.trim();
}

function buildSchema() {
  return {
    name: "debate_analysis",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        teamAName: { type: "string" },
        teamBName: { type: "string" },
        teamA: {
          type: "object",
          additionalProperties: false,
          properties: {
            main_position: { type: "string" },
            truth: { type: "string" },
            lies: { type: "string" },
            opinion: { type: "string" },
            lala: { type: "string" }
          },
          required: ["main_position", "truth", "lies", "opinion", "lala"]
        },
        teamB: {
          type: "object",
          additionalProperties: false,
          properties: {
            main_position: { type: "string" },
            truth: { type: "string" },
            lies: { type: "string" },
            opinion: { type: "string" },
            lala: { type: "string" }
          },
          required: ["main_position", "truth", "lies", "opinion", "lala"]
        },
        winner: { type: "string" },
        bsMeter: { type: "string" },
        strongestOverall: { type: "string" },
        weakestOverall: { type: "string" },
        why: { type: "string" },
        manipulation: { type: "string" },
        fluff: { type: "string" },
        sources: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              claim: { type: "string" },
              type: { type: "string" },
              likely_source: { type: "string" },
              confidence: { type: "string" }
            },
            required: ["claim", "type", "likely_source", "confidence"]
          }
        }
      },
      required: [
        "teamAName",
        "teamBName",
        "teamA",
        "teamB",
        "winner",
        "bsMeter",
        "strongestOverall",
        "weakestOverall",
        "why",
        "manipulation",
        "fluff",
        "sources"
      ]
    }
  };
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
