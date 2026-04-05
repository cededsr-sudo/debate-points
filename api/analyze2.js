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
      return text
        // remove urls
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/www\.\S+/gi, " ")

        // remove common youtube metadata / junk lines
        .replace(/^\s*\d+\s+views\s*$/gim, " ")
        .replace(/^\s*\d+\s+(day|days|week|weeks|month|months|year|years)\s+ago\s*$/gim, " ")
        .replace(/^\s*sync to video time\s*$/gim, " ")
        .replace(/^\s*show transcript\s*$/gim, " ")
        .replace(/^\s*transcript\s*$/gim, " ")
        .replace(/^\s*up next\s*$/gim, " ")
        .replace(/^\s*autoplay\s*$/gim, " ")
        .replace(/^\s*subscribe\s*$/gim, " ")
        .replace(/^\s*closing remarks.*$/gim, " ")
        .replace(/^\s*invitation.*$/gim, " ")
        .replace(/^\s*chapter\s+\d+.*$/gim, " ")

        // remove timestamps like 1:28:02 or 28:02
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")

        // remove "hour, minute, second" junk
        .replace(/\b\d+\s*hour,\s*\d+\s*minutes?,\s*\d+\s*seconds?\b/gi, " ")
        .replace(/\b\d+\s*minutes?,\s*\d+\s*seconds?\b/gi, " ")

        // remove repeated broken encoded blobs / long garbage tokens
        .replace(/\b[A-Za-z0-9_\-%]{25,}\b/g, " ")

        // remove isolated metadata bullets
        .replace(/^\s*•\s*$/gim, " ")

        // normalize whitespace
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const cleanedTranscript = cleanTranscript(transcriptText);

    // crude quality check
    const lineCount = cleanedTranscript.split("\n").filter(Boolean).length;
    const wordCount = cleanedTranscript.split(/\s+/).filter(Boolean).length;

    if (wordCount < 80 || lineCount < 4) {
      return res.status(400).json({
        error: "This still does not look like a usable debate transcript. Paste the actual spoken exchange, not title/views/timestamps/outro junk."
      });
    }

    const prompt = `
You are a ruthless debate analyst.

You are given one cleaned debate transcript blob.
Your job is to infer the two sides and make hard calls.

Use optional names when helpful:
- Team A Name: ${teamAName || "Team A"}
- Team B Name: ${teamBName || "Team B"}
- Optional Link: ${videoLink || "No link provided"}

Transcript:
${cleanedTranscript}

Return ONLY valid JSON in this exact format:

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
- Be decisive.
- Do NOT use filler like "some may be present" unless evidence is truly thin.
- Do NOT say "not clearly developed."
- "winner" must be exactly "Team A", "Team B", or "Mixed".
- "truth" = grounded, supported, reasonable claims made by that side.
- "lies" = false, exaggerated, unsupported, or overconfident claims made by that side.
- "opinion" = subjective framing by that side.
- "lala" = fantasy leaps, absurd overreach, reality disconnect, nonsense by that side.
- "bsMeter" must plainly say who is bluffing/reaching more and why.
- "strongestOverall" must identify one specific point from the exchange.
- "weakestOverall" must identify one specific bad point from the exchange.
- "why" must explain the edge plainly.
- "manipulation" should describe rhetorical pressure / emotional steering if present.
- "fluff" should describe filler / repetition if present.
- "sources" should list 2-4 claims that require support.
- For each source:
  - "claim" = the actual claim needing support
  - "type" = biblical, historical, scientific, philosophical, general, etc.
  - "likely_source" = likely source if known, otherwise "No direct source — requires verification"
  - "confidence" = high, medium, or low
- If the transcript is mostly one-sided and not a true exchange, say that plainly in "why" and set winner based on available content.
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.15,
        messages: [
          {
            role: "developer",
            content: "Return only valid JSON. No markdown. No explanation outside JSON."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const rawResponse = await response.json();
    const rawContent = rawResponse?.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      parsed = {
        teamAName: teamAName || "Team A",
        teamBName: teamBName || "Team B",
        teamA: {
          main_position: "Could not cleanly isolate Team A's full position.",
          truth: "Grounded content could not be isolated cleanly.",
          lies: "Unsupported claims could not be isolated cleanly.",
          opinion: "Subjective framing could not be isolated cleanly.",
          lala: "Overreach could not be isolated cleanly."
        },
        teamB: {
          main_position: "Could not cleanly isolate Team B's full position.",
          truth: "Grounded content could not be isolated cleanly.",
          lies: "Unsupported claims could not be isolated cleanly.",
          opinion: "Subjective framing could not be isolated cleanly.",
          lala: "Overreach could not be isolated cleanly."
        },
        winner: "Mixed",
        bsMeter: "Could not judge BS level cleanly from the current input.",
        strongestOverall: "Could not isolate strongest overall point cleanly.",
        weakestOverall: "Could not isolate weakest overall point cleanly.",
        why: rawContent || "The AI response could not be parsed cleanly.",
        manipulation: "Could not judge manipulation cleanly.",
        fluff: "Could not judge fluff cleanly.",
        sources: [
          {
            claim: "Could not reliably parse source claims from response",
            type: "general",
            likely_source: "No direct source — requires verification",
            confidence: "low"
          }
        ]
      };
    }

    // normalize missing fields
    if (!parsed.teamAName) parsed.teamAName = teamAName || "Team A";
    if (!parsed.teamBName) parsed.teamBName = teamBName || "Team B";

    if (!parsed.teamA) parsed.teamA = {};
    if (!parsed.teamB) parsed.teamB = {};

    parsed.teamA.main_position = parsed.teamA.main_position || "-";
    parsed.teamA.truth = parsed.teamA.truth || "-";
    parsed.teamA.lies = parsed.teamA.lies || "-";
    parsed.teamA.opinion = parsed.teamA.opinion || "-";
    parsed.teamA.lala = parsed.teamA.lala || "-";

    parsed.teamB.main_position = parsed.teamB.main_position || "-";
    parsed.teamB.truth = parsed.teamB.truth || "-";
    parsed.teamB.lies = parsed.teamB.lies || "-";
    parsed.teamB.opinion = parsed.teamB.opinion || "-";
    parsed.teamB.lala = parsed.teamB.lala || "-";

    parsed.winner = parsed.winner || "Mixed";
    parsed.bsMeter = parsed.bsMeter || "-";
    parsed.strongestOverall = parsed.strongestOverall || "-";
    parsed.weakestOverall = parsed.weakestOverall || "-";
    parsed.why = parsed.why || "-";
    parsed.manipulation = parsed.manipulation || "-";
    parsed.fluff = parsed.fluff || "-";

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

    parsed.sources = parsed.sources.map((item) => ({
      claim: item?.claim || "Unspecified claim",
      type: item?.type || "general",
      likely_source: item?.likely_source || "No direct source — requires verification",
      confidence: item?.confidence || "low"
    }));

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
