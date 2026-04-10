export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { text = "", link = "" } = req.body || {};

    if (!text && !link) {
      return res.status(400).json({ error: "Provide text or link." });
    }

    let input = text;

    if (!input && link) {
      const r = await fetch(link);
      const html = await r.text();
      input = html.replace(/<[^>]+>/g, " ");
    }

    if (!input || input.length < 20) {
      return res.status(400).json({ error: "Not enough content." });
    }

    const clean = input.toLowerCase();

    // ---- FORCE OUTPUT (NO FAIL STATES) ----

    const structure = clean.includes("?") ? "debate" : "commentary";

    const topics = [];
    if (clean.includes("trump") || clean.includes("iran") || clean.includes("election")) {
      topics.push("political");
    }
    if (clean.includes("podcast") || clean.includes("media") || clean.includes("cnn")) {
      topics.push("media");
    }
    if (clean.includes("god") || clean.includes("torah") || clean.includes("bible")) {
      topics.push("theological");
    }

    if (!topics.length) topics.push("political");

    const worldview = ["political"];

    // ---- BEHAVIOR DETECTION ----

    const contradictions = (clean.match(/\bbut\b|\bhowever\b/g) || []).length;
    const hedging = (clean.match(/\bi think\b|\bi don't know\b|\bmaybe\b|\bperhaps\b/g) || []).length;
    const attacks = (clean.match(/\bstupid\b|\bloser\b|\bdumb\b|\bliar\b|\bclown\b/g) || []).length;
    const strongClaims = (clean.match(/\bobviously\b|\bclearly\b|\bdefinitely\b|\bbeyond doubt\b/g) || []).length;

    const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));

    const clarity = clamp(70 - contradictions + strongClaims * 2);
    const integrity = clamp(65 - attacks * 5 - contradictions);
    const honesty = clamp(65 - hedging * 4 - contradictions);
    const manipulation = clamp(20 + attacks * 6 + strongClaims * 2);
    const bsn = clamp(30 + contradictions * 5 + hedging * 4);

    return res.status(200).json({
      structure,
      topics,
      worldview,
      scores: {
        clarity,
        integrity,
        honesty,
        manipulation,
        bsn
      }
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}
