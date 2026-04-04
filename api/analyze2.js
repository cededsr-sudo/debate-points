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
            content: `Analyze the text and respond in EXACTLY this format:

TRUTH: short useful judgment
LIES: short useful judgment
OPINION: short useful judgment
FOOLERY: short useful judgment
MANIPULATION: short useful judgment
FLUFF: short useful judgment
SOURCES: comma-separated list of explicit sources mentioned, or "No explicit sources mentioned"

Never say "None clearly present".
Never leave any category blank.
If weak, still make your best judgment.`
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

    function pick(label, nextLabels) {
      const pattern = new RegExp(
        `${label}:\\s*([\\s\\S]*?)(?=\\n(?:${nextLabels.join("|")}):|$)`,
        "i"
      );
      const match = raw.match(pattern);
      return match ? match[1].trim() : "";
    }

    const truth = pick("TRUTH", ["LIES", "OPINION", "FOOLERY", "MANIPULATION", "FLUFF", "SOURCES"]) || "Some grounded or reasonable content is present, but limited.";
    const lies = pick("LIES", ["OPINION", "FOOLERY", "MANIPULATION", "FLUFF", "SOURCES"]) || "Some unsupported, exaggerated, or unproven content appears present.";
    const opinion = pick("OPINION", ["FOOLERY", "MANIPULATION", "FLUFF", "SOURCES"]) || "The text contains subjective framing or personal perspective.";
    const foolery = pick("FOOLERY", ["MANIPULATION", "FLUFF", "SOURCES"]) || "The reasoning contains weak, sloppy, or unserious elements.";
    const manipulation = pick("MANIPULATION", ["FLUFF", "SOURCES"]) || "The text uses some emotional steering, loaded framing, or pressure.";
    const fluff = pick("FLUFF", ["SOURCES"]) || "The text contains filler, repetition, or low-substance wording.";

    const sourcesText = pick("SOURCES", []);
    const sources =
      !sourcesText || /no explicit sources mentioned/i.test(sourcesText)
        ? ["No explicit sources mentioned"]
        : sourcesText.split(",").map(s => s.trim()).filter(Boolean);

    return res.status(200).json({
      truth,
      lies,
      opinion,
      foolery,
      manipulation,
      fluff,
      sources
    });

  } catch (err) {
    return res.status(500).json({ error: "Analysis failed" });
  }
}
