export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    const { text = "", link = "" } = req.body || {};

    const input = (text || link || "").trim();

    if (!input) {
      return res.status(400).json({
        structure: "error",
        topics: ["empty"],
        worldview: ["none"],
        scores: {
          clarity: 0,
          integrity: 0,
          honesty: 0,
          manipulation: 0,
          bsn: 0
        }
      });
    }

    const lower = input.toLowerCase();

    const structure =
      input.includes("?") ? "debate" : "commentary";

    const topics = [];
    if (lower.includes("trump") || lower.includes("president")) topics.push("political");
    if (lower.includes("god") || lower.includes("bible")) topics.push("theological");
    if (lower.includes("data") || lower.includes("evidence")) topics.push("empirical");

    const worldview = [];
    if (lower.includes("data") || lower.includes("evidence")) worldview.push("empirical");
    if (lower.includes("right") || lower.includes("wrong")) worldview.push("moral");
    if (lower.includes("god") || lower.includes("bible")) worldview.push("theological");

    const scores = {
      clarity: 60,
      integrity: 60,
      honesty: 60,
      manipulation: 20,
      bsn: 30
    };

    return res.status(200).json({
      structure,
      topics: topics.length ? topics : ["general"],
      worldview: worldview.length ? worldview : ["general"],
      scores
    });

  } catch (e) {
    return res.status(500).json({
      structure: "error",
      topics: ["fail"],
      worldview: ["fail"],
      scores: {
        clarity: 0,
        integrity: 0,
        honesty: 0,
        manipulation: 0,
        bsn: 0
      }
    });
  }
}
