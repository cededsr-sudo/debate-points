export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { teamAName, teamBName, teamAText, teamBText, videoLink } = req.body;

    if (!teamAText || !teamBText) {
      return res.status(400).json({ error: "Both teams are required" });
    }

    const prompt = `
You are a direct, sharp debate judge.

Compare these two sides directly.

Team A Name: ${teamAName || "Team A"}
Team A Text:
${teamAText}

Team B Name: ${teamBName || "Team B"}
Team B Text:
${teamBText}

Optional Link:
${videoLink || "No link provided"}

Return ONLY valid JSON in this exact format:

{
  "teamAName": "",
  "teamBName": "",
  "teamA": {
    "position": "",
    "truth": "",
    "lies": "",
    "opinion": "",
    "lalaLand": ""
  },
  "teamB": {
    "position": "",
    "truth": "",
    "lies": "",
    "opinion": "",
    "lalaLand": ""
  },
  "winner": "",
  "bsMeter": "",
  "strongestOverall": "",
  "weakestOverall": "",
  "why": "",
  "manipulation": "",
  "fluff": "",
  "sources": []
}

Rules:
- Be decisive.
- Team names should be preserved.
- "Truth" = grounded, reasonable, or supported points.
- "Lies" = false, exaggerated, unsupported, or overconfident points.
- "Opinion" = subjective framing or personal perspective.
- "Lala Land" = fantasy leaps, reality disconnect, wild overreach, or nonsense.
- "bsMeter" must plainly say who is bluffing more, exaggerating more, or reaching more.
- "winner" must be Team A, Team B, or Mixed.
- Do not use weak filler like "not clearly developed."
- Be concrete and readable.
- If no explicit sources are mentioned, return ["No explicit sources mentioned"].
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${process.env.OPENAI_API_KEY}\`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are a no-nonsense debate breakdown tool."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = {
        teamAName: teamAName || "Team A",
        teamBName: teamBName || "Team B",
        teamA: {
          position: "Team A presents a position.",
          truth: "Some grounded content may be present.",
          lies: "Some unsupported content may be present.",
          opinion: "Some subjective framing may be present.",
          lalaLand: "Some overreach or fantasy leap may be present."
        },
        teamB: {
          position: "Team B presents a position.",
          truth: "Some grounded content may be present.",
          lies: "Some unsupported content may be present.",
          opinion: "Some subjective framing may be present.",
          lalaLand: "Some overreach or fantasy leap may be present."
        },
        winner: "Mixed",
        bsMeter: "Both sides may be reaching in different ways.",
        strongestOverall: "Could not isolate strongest overall point cleanly.",
        weakestOverall: "Could not isolate weakest overall point cleanly.",
        why: raw || "The response could not be parsed cleanly.",
        manipulation: "Some emotional framing may be present.",
        fluff: "Some filler or repetition may be present.",
        sources: ["No explicit sources mentioned"]
      };
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
