export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { text } = req.body;

    if (!text) {
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
            content: `You are analyzing an argument or transcript.

Fill every field with a short useful summary based on the input.
Do NOT leave fields blank unless absolutely nothing relevant exists.
If something is unclear, still give your best concise judgment.

Return ONLY valid JSON in this exact format:

{
  "truth": "short summary of truthful or grounded parts",
  "lies": "short summary of false, exaggerated, or unsupported parts",
  "opinion": "short summary of subjective or personal-view parts",
  "foolery": "short summary of unserious, sloppy, clownish, or weak reasoning",
  "manipulation": "short summary of emotional steering, loaded framing, or selective pressure",
  "fluff": "short summary of padding, repetition, or low-substance filler",
  "sources": ["list any explicit sources mentioned in the input, or write 'No explicit sources mentioned'"]
}`
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
        truth: "",
        lies: "",
        opinion: "",
        foolery: "",
        manipulation: "",
        fluff: raw,
        sources: ["No explicit sources mentioned"]
      };
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
