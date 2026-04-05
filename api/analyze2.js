export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { teamAName, teamBName, transcriptText, videoLink } = req.body || {};

    if (!transcriptText || !transcriptText.trim()) {
      return res.status(400).json({ error: "Transcript is required" });
    }

    const cleanedTranscript = transcriptText
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/www\.\S+/gi, " ")
      .replace(/[A-Za-z0-9_\-]+%[A-Za-z0-9%\-_]*/g, " ")
      .replace(/\b[a-zA-Z0-9]{25,}\b/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (cleanedTranscript.length < 80) {
      return res.status(400).json({
        error: "Input is not a usable debate transcript yet. Paste readable dialogue, not tracking links or broken text."
      });
    }

    const prompt = `
You are a ruthless debate analyst.

Your job is to judge the debate sharply, not politely.

You are given:
- one full debate transcript blob
- optional Team A and Team B names
- optional video link

Your tasks:
1. Infer the two main sides from the transcript.
2. Use the optional team names when helpful.
3. For each side, identify:
   - main_position
   - truth
   - lies
   - opinion
   - lala
4. Decide who has the edge.
5. Explain who is BS-ing more.
6. Extract the strongest overall point.
7. Extract the weakest overall point.
8. Describe manipulation and fluff.
9. Build a useful source section.

Important rules:
- If the input is mostly broken links, encoded junk, tracking garbage, or unreadable fragments, say that directly.
- Do NOT fake a serious analysis from garbage.
- Be decisive.
- Do NOT use vague filler like "not clearly developed."
- Do NOT say "some may appear" unless absolutely necessary.
- Winner must be exactly: "Team A", "Team B", or "Mixed".
- "truth" = grounded, reasonable, supported points.
- "lies" = false, exaggerated, unsupported, or overconfident claims.
- "opinion" = subjective framing or personal perspective.
- "lala" = fantasy leaps, wild overreach, reality disconnect, nonsense.
- "bsMeter" must plainly say who is bluffing, stretching, or BS-ing more.
- "strongestOverall" and "weakestOverall" must be specific and useful.
- "why" must explain the edge in plain language.
- "manipulation" should describe emotional steering, loaded framing, or rhetorical pressure.
- "fluff" should describe filler, repetition, or low-substance wording.
- "sources" should contain claims that need support.
- For each source item:
  - "claim" = the claim being checked
  - "type" = biblical, historical, scientific, general, political, etc.
  - "likely_source" = the likely source if known, otherwise "No direct source — requires verification"
  - "confidence" = high, medium, or low
- Give at least 2 source items when possible.

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

Optional Team A Name: ${teamAName || "Team A"}
Optional Team B Name: ${teamBName || "Team B"}
Optional Link: ${videoLink || "No link provided"}

Transcript:
${cleanedTranscript}
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
          main_position: "Could not cleanly isolate Team A's full position from the transcript.",
          truth: "Some grounded content may be present on Team A's side.",
          lies: "Some unsupported or exaggerated claims may be present on Team A's side.",
          opinion: "Some subjective framing may be present on Team A's side.",
          lala: "Some overreach or reality-disconnect may be present on Team A's side."
        },
        teamB: {
          main_position: "Could not cleanly isolate Team B's full position from the transcript.",
          truth: "Some grounded content may be present on Team B's side.",
          lies: "Some unsupported or exaggerated claims may be present on Team B's side.",
          opinion: "Some subjective framing may be present on Team B's side.",
          lala: "Some overreach or reality-disconnect may be present on Team B's side."
        },
        winner: "Mixed",
        bsMeter: "Both sides may be stretching in different ways.",
        strongestOverall: "Could not isolate the strongest overall point cleanly.",
        weakestOverall: "Could not isolate the weakest overall point cleanly.",
        why: rawContent || "The AI response could not be parsed cleanly.",
        manipulation: "Some emotional framing or loaded wording may be present.",
        fluff: "Some filler, repetition, or low-substance wording may be present.",
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

    if (!parsed.teamAName) parsed.teamAName = teamAName || "Team A";
    if (!parsed.teamBName) parsed.teamBName = teamBName || "Team B";

    if (!parsed.teamA) parsed.teamA = {};
    if (!parsed.teamB) parsed.teamB = {};

    parsed.teamA.main_position =
      parsed.teamA.main_position || "Team A presents one side of the debate.";
    parsed.teamA.truth =
      parsed.teamA.truth || "Some grounded content appears on Team A's side.";
    parsed.teamA.lies =
      parsed.teamA.lies || "Some unsupported or exaggerated claims appear on Team A's side.";
    parsed.teamA.opinion =
      parsed.teamA.opinion || "Some subjective framing appears on Team A's side.";
    parsed.teamA.lala =
      parsed.teamA.lala || "Some fantasy leap or bad overreach appears on Team A's side.";

    parsed.teamB.main_position =
      parsed.teamB.main_position || "Team B presents the opposing side of the debate.";
    parsed.teamB.truth =
      parsed.teamB.truth || "Some grounded content appears on Team B's side.";
    parsed.teamB.lies =
      parsed.teamB.lies || "Some unsupported or exaggerated claims appear on Team B's side.";
    parsed.teamB.opinion =
      parsed.teamB.opinion || "Some subjective framing appears on Team B's side.";
    parsed.teamB.lala =
      parsed.teamB.lala || "Some fantasy leap or bad overreach appears on Team B's side.";

    parsed.winner = parsed.winner || "Mixed";
    parsed.bsMeter = parsed.bsMeter || "Both sides may be stretching in different ways.";
    parsed.strongestOverall =
      parsed.strongestOverall || "Could not isolate strongest overall point.";
    parsed.weakestOverall =
      parsed.weakestOverall || "Could not isolate weakest overall point.";
    parsed.why =
      parsed.why || "Neither side clearly dominates from the available transcript.";
    parsed.manipulation =
      parsed.manipulation || "Some emotional framing or loaded wording may be present.";
    parsed.fluff =
      parsed.fluff || "Some filler, repetition, or low-substance wording may be present.";

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
      likely_source:
        item?.likely_source || item?.source || "No direct source — requires verification",
      confidence: item?.confidence || "low"
    }));

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
