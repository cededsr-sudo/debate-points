export default async function handler(req, res) {
  try {
    const { text } = req.body;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Analyze the text and return JSON with: truth, lies, opinion, foolery, manipulation, reality_scale, sources."
          },
          {
            role: "user",
            content: text
          }
        ]
      })
    });

    const data = await response.json();

    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({ error: "Something broke." });
  }
}
