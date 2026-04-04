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
            content: `Analyze the user's text and respond in EXACTLY this format:

TRUTH: one short useful summary
LIES: one short useful summary
OPINION: one short useful summary
FOOLERY: one short useful summary
MANIPULATION: one short useful summary
FLUFF: one short useful summary
SOURCES: comma-separated list of explicit sources mentioned, or "No explicit sources mentioned"

Do not leave categories blank.
If a category is weak or absent, write "None clearly present" for that category.`
          },
          {
            role: "user",
            content: text
          }
        ]
      })
    });

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "";

    function pull(label, nextLabels) {
      const pattern = new RegExp(
        `${label}:\\s*([\\s\\S]*?)(?=\\n(?:${nextLabels.join("|")}):|$)`,
        "i"
      );
      const match = raw.match(pattern);
      return match ? match[1].trim() : "None clearly present";
    }

    const result = {
      truth: pull("TRUTH", ["LIES", "OPINION", "FOOLERY", "MANIPULATION", "FLUFF", "SOURCES"]),
      lies: pull("LIES", ["OPINION", "FOOLERY", "MANIPULATION", "FLUFF", "SOURCES"]),
      opinion: pull("OPINION", ["FOOLERY", "MANIPULATION", "FLUFF", "SOURCES"]),
      foolery: pull("FOOLERY", ["MANIPULATION", "FLUFF", "SOURCES"]),
      manipulation: pull("MANIPULATION", ["FLUFF", "SOURCES"]),
      fluff: pull("FLUFF", ["SOURCES"]),
      sources: []
    };

    const sourcesText = pull("SOURCES", []);
    result.sources =
      sourcesText.toLowerCase() === "no explicit sources mentioned"
        ? ["No explicit sources mentioned"]
        : sourcesText.split(",").map(s => s.trim()).filter(Boolean);

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
