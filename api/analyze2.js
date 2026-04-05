export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { teamAName, teamBName, transcriptText, videoLink } = req.body || {};

    if (!transcriptText || !transcriptText.trim()) {
      return res.status(400).json({ error: "Transcript is required" });
    }

    const prompt = `
You are a sharp, decisive debate judge.

You are given:
- one full debate transcript blob
- optional Team A and Team B names
- optional video link

Your job:
1. Infer the two main sides from the transcript.
2. Label them using the provided team names when helpful.
3. Judge each side in these categories:
   - truth
   - lies
   - opinion
   - lalaLand
4. Decide who has the current edge.
5. Explain who is BS-ing more.
6. Extract strongest and weakest overall points.
7. Describe manipulation and fluff.
8. Build a smart source section.

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
  "sources": [
    {
      "claim": "",
      "type": "",
      "source": "",
      "confidence": ""
    }
  ]
}

Rules:
- Be concrete and readable.
- Do NOT use vague filler like "not clearly developed."
- Do NOT say "None clearly present."
- "truth" = grounded, reasonable, supported points.
- "lies" = false, exaggerated, unsupported, or overconfident claims.
- "opinion" = subjective framing or personal perspective.
- "lalaLand" = fantasy leaps, wild overreach, reality disconnect, nonsense.
- "winner" must be exactly one of: "Team A", "Team B", "Mixed".
- "bsMeter" must plainly say who is bluffing, exaggerating, or reaching more.
- "strongestOverall" and "weakestOverall" must be specific.
- "why" must explain the edge in plain language.
- "manipulation" should describe emotional steering, loaded framing, or rhetorical pressure.
- "fluff" should describe filler, repetition, or low-substance wording.
- For "sources":
  - use explicit sources mentioned in the transcript when available
  - if a claim implies a likely source, name the likely source and mark lower confidence
  - if no direct source is available, say "No direct source — requires verification"
  - confidence must be "high", "medium", or "low"
  - give at least 2 source items when possible

Optional Team A Name: ${teamAName || "Team A"}
Optional Team B Name: ${teamBName || "Team B"}
Optional Link: ${videoLink || "No link provided"}

Transcript:
${transcriptText}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "developer",
            content: "Return only valid JSON. No markdown. No explanation outside the JSON."
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
          position: "Team A presents one side of the debate.",
          truth: "Some grounded content appears on Team A's side.",
          lies: "Some unsupported or exaggerated claims may appear on Team A's side.",
          opinion: "Some subjective framing appears on Team A's side.",
          lalaLand: "Some overreach or fantasy leap may appear on Team A's side."
        },
        teamB: {
          position: "Team B presents the opposing side of the debate.",
          truth: "Some grounded content appears on Team B's side.",
          lies: "Some unsupported or exaggerated claims may appear on Team B's side.",
          opinion: "Some subjective framing appears on Team B's side.",
          lalaLand: "Some overreach or fantasy leap may appear on Team B's side."
        },
        winner: "Mixed",
        bsMeter: "Both sides may be stretching in different ways.",
        strongestOverall: "Could not isolate strongest overall point cleanly.",
        weakestOverall: "Could not isolate weakest overall point cleanly.",
        why: raw || "The model response could not be parsed cleanly.",
        manipulation: "Some emotional framing may be present.",
        fluff: "Some filler or repetition may be present.",
        sources: [
          {
            claim: "Could not reliably parse source claims from response",
            type: "general",
            source: "No direct source — requires verification",
            confidence: "low"
          }
        ]
      };
    }

    if (!parsed.teamAName) parsed.teamAName = teamAName || "Team A";
    if (!parsed.teamBName) parsed.teamBName = teamBName || "Team B";

    if (!parsed.teamA) parsed.teamA = {};
    if (!parsed.teamB) parsed.teamB = {};

    parsed.teamA.position = parsed.teamA.position || "Team A presents one side of the debate.";
    parsed.teamA.truth = parsed.teamA.truth || "Some grounded content appears on Team A's side.";
    parsed.teamA.lies = parsed.teamA.lies || "Some unsupported or exaggerated claims may appear on Team A's side.";
    parsed.teamA.opinion = parsed.teamA.opinion || "Some subjective framing appears on Team A's side.";
    parsed.teamA.lalaLand = parsed.teamA.lalaLand || "Some overreach or fantasy leap may appear on Team A's side.";

    parsed.teamB.position = parsed.teamB.position || "Team B presents the opposing side of the debate.";
    parsed.teamB.truth = parsed.teamB.truth || "Some grounded content appears on Team B's side.";
    parsed.teamB.lies = parsed.teamB.lies || "Some unsupported or exaggerated claims may appear on Team B's side.";
    parsed.teamB.opinion = parsed.teamB.opinion || "Some subjective framing appears on Team B's side.";
    parsed.teamB.lalaLand = parsed.teamB.lalaLand || "Some overreach or fantasy leap may appear on Team B's side.";

    parsed.winner = parsed.winner || "Mixed";
    parsed.bsMeter = parsed.bsMeter || "Both sides may be stretching in different ways.";
    parsed.strongestOverall = parsed.strongestOverall || "Could not isolate strongest overall point.";
    parsed.weakestOverall = parsed.weakestOverall || "Could not isolate weakest overall point.";
    parsed.why = parsed.why || "Neither side clearly dominates from the available transcript.";
    parsed.manipulation = parsed.manipulation || "Some emotional framing or loaded wording may be present.";
    parsed.fluff = parsed.fluff || "Some filler, repetition, or low-substance wording may be present.";

    if (!Array.isArray(parsed.sources) || !parsed.sources.length) {
      parsed.sources = [
        {
          claim: "No explicit source claims extracted",
          type: "general",
          source: "No direct source — requires verification",
          confidence: "low"
        }
      ];
    }

    parsed.sources = parsed.sources.map((item) => ({
      claim: item?.claim || "Unspecified claim",
      type: item?.type || "general",
      source: item?.source || "No direct source — requires verification",
      confidence: item?.confidence || "low"
    }));

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
