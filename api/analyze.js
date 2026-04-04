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
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `Return ONLY valid JSON. No extra text.

{
  "truth": "",
  "lies": "",
  "opinion": "",
  "foolery": "",
  "manipulation": "",
  "fluff": "",
  "sources": []
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
        sources: []
      };
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
