export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { teamAName, teamBName, transcriptText, videoLink } = req.body || {};

    if (!transcriptText || !transcriptText.trim()) {
      return res.status(400).json({ error: "Transcript is required" });
    }

    function cleanTranscript(text) {
      return String(text)
        // urls
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/www\.\S+/gi, " ")

        // common platform junk
        .replace(/\b\d+\s+views?\b/gi, " ")
        .replace(/\b\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/gi, " ")
        .replace(/\bsync to video time\s*/gi, " ")
        .replace(/\bshow transcript\s*/gi, " ")
        .replace(/\btranscript\s*/gi, " ")
        .replace(/\bautoplay\s*/gi, " ")
        .replace(/\bsubscribe\s*/gi, " ")
        .replace(/\bclosing remarks\s*/gi, " ")
        .replace(/\binvitation\s*/gi, " ")
        .replace(/\bepic exchange\s*/gi, " ")

        // chapter labels / timestamps
        .replace(/\bchapter\s+\d+\b.*$/gim, " ")
        .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/gm, " ")
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")

        // uploader junk / bracket junk
        .replace(/^\s*\[.*?\]\s*$/gm, " ")
        .replace(/^\s*\(.*?\)\s*$/gm, " ")

        // encoded blobs / obvious nonsense chunks
        .replace(/[A-Za-z0-9\-_]{25,}/g, " ")

        // normalize whitespace
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const cleanedTranscript = cleanTranscript(transcriptText);
    const wordCount = cleanedTranscript.split(/\s+/).filter(Boolean).length;
    const lineCount = cleanedTranscript.split("\n").filter(line => line.trim()).length;

    if (wordCount < 80 || lineCount < 4) {
      return res.status(400).json({
        error: "This does not look like a usable debate transcript yet. Paste the actual spoken exchange, not metadata, timestamps, titles, or outro junk."
      });
    }

    const prompt = `
You are a ruthless debate analyst.

IMPORTANT:
The transcript may contain metadata such as:
- video title
- channel name
- views
- months ago / years ago
- chapter labels
- sync to video time
- timestamps
- closing remarks
- invitations
- subscribe prompts
- uploader notes

You must IGNORE all metadata, timestamps, labels, title text, and outro junk.
Analyze ONLY the actual spoken exchange and argumentative content.

Optional Team A Name: ${teamAName || "Team A"}
Optional Team B Name: ${teamBName || "Team B"}
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
- Do NOT use filler like "could not be isolated cleanly" unless the debate content is genuinely too weak.
- "winner" must be exactly "Team A", "Team B", or "Mixed".
- "truth" = grounded, supported, reasonable claims by that side.
- "lies" = false, exaggerated, unsupported, or overconfident claims by that side.
- "opinion" = subjective framing by that side.
- "lala" = fantasy leaps, absurd overreach, reality disconnect, nonsense by that side.
- "bsMeter" must plainly say who is bluffing or reaching more and why.
- "strongestOverall" must identify one specific point from the exchange.
- "weakestOverall" must identify one specific bad point from the exchange.
- "why" must explain the edge plainly.
- "manipulation" should describe rhetorical pressure or emotional steering if present.
- "fluff" should describe actual spoken filler or repetition, not page metadata.
- "sources" should list 2 to 4 claims that require support.
`;

    const schema = {
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

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        response_format: {
          type: "json_schema",
          json_schema: schema
        },
        messages: [
          {
            role: "developer",
            content: "Return only schema-valid JSON."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const rawResponse = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: rawResponse?.error?.message || "OpenAI request failed"
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawResponse.choices[0].message.content);
    } catch (err) {
      return res.status(500).json({
        error: "Structured output parsing failed"
      });
    }

    parsed.teamAName = parsed.teamAName || teamAName || "Team A";
    parsed.teamBName = parsed.teamBName || teamBName || "Team B";

    if (!Array.isArray(parsed.sources) || !parsed.sources.length) {
      parsed.sources = [
        {
          claim: "No explicit source claims extracted",
          type: "general",
          likely_source: "No direct source — requires verification",
          confidence: "low"
        }
      ];
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
