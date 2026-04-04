export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "No text provided" });
    }

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
            role: "system",
            content: `You are a debate breakdown tool.

Analyze the text as a debate, argument, or exchange between sides.
If there are no clearly named speakers, infer two sides from the competing claims.

Return ONLY valid JSON in this exact format:

{
  "speakerA": "Main claims, strengths, and weaknesses of side A",
  "speakerB": "Main claims, strengths, and weaknesses of side B",
  "strongestPoint": "The strongest point made in the exchange",
  "weakestPoint": "The weakest point made in the exchange",
  "edge": "Speaker A / Speaker B / Mixed",
  "why": "Short explanation for who currently has the stronger case",
  "manipulation": "Main emotional framing, loaded language, or rhetorical pressure used",
  "fluff": "Main filler, repetition, or low-substance wording",
  "sources": ["explicit sources mentioned in the text, or 'No explicit sources mentioned'"]
}

Rules:
- Never leave fields blank.
- Be concrete.
- Do not say 'None clearly present'.
- If weak, still make your best judgment.
- Keep each field concise but useful.`
          },
          {
            role: "user",
            content: text
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
        speakerA: "Unable to cleanly parse Speaker A, but one side appears to argue from the stronger grounded position.",
        speakerB: "Unable to cleanly parse Speaker B, but the opposing side appears to rely more on weaker or less supported claims.",
        strongestPoint: "A stronger point appears to exist, but the response was not cleanly parsed.",
        weakestPoint: "A weaker point appears to exist, but the response was not cleanly parsed.",
        edge: "Mixed",
        why: raw || "The response was unclear, so the edge could not be judged cleanly.",
        manipulation: "Some rhetorical steering or framing may be present.",
        fluff: "Some filler or repetition may be present.",
        sources: ["No explicit sources mentioned"]
      };
    }

    parsed.speakerA = parsed.speakerA || "Speaker A presents a position, but the case is not clearly developed.";
    parsed.speakerB = parsed.speakerB || "Speaker B presents a position, but the case is not clearly developed.";
    parsed.strongestPoint = parsed.strongestPoint || "A strongest point exists, but it was not clearly isolated.";
    parsed.weakestPoint = parsed.weakestPoint || "A weakest point exists, but it was not clearly isolated.";
    parsed.edge = parsed.edge || "Mixed";
    parsed.why = parsed.why || "Neither side clearly dominates based on the available text.";
    parsed.manipulation = parsed.manipulation || "Some emotional framing or loaded wording may be present.";
    parsed.fluff = parsed.fluff || "Some filler, repetition, or low-substance wording is present.";
    parsed.sources = Array.isArray(parsed.sources) && parsed.sources.length
      ? parsed.sources
      : ["No explicit sources mentioned"];

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
