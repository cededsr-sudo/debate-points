// /api/analyze.js

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    if (req.method !== "POST") {
      return res.end(JSON.stringify(base()));
    }

    let body = "";

    for await (const chunk of req) {
      body += chunk;
    }

    let data = {};
    try {
      data = JSON.parse(body || "{}");
    } catch {
      data = { text: body };
    }

    const text = (data.text || "").toString();

    // FORCE SIMPLE LINE SPLIT
    const lines = text
      .replace(/\d{1,2}:\d{2}/g, "\n")     // remove timestamps
      .replace(/[.!?]/g, "\n")             // force breaks
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 5);

    const scan = lines.map((line, i) => ({
      index: i + 1,
      text: line,
      label: detect(line),
      strength: 50,
      reason: "basic scan",
      flags: [],
      punctuation: {
        question_marks: (line.match(/\?/g) || []).length,
        exclamations: (line.match(/!/g) || []).length,
        ellipses: 0,
        repeated_punctuation: false,
        all_caps_words: (line.match(/\b[A-Z]{2,}\b/g) || []).length,
        quotes: 0,
        parentheticals: 0,
        dash_breaks: 0
      }
    }));

    const result = {
      structure: "basic",
      selected_segment: "full text",
      topics: [],
      worldview: [],
      scores: {
        clarity: 50,
        integrity: 50,
        honesty: 50,
        manipulation: 50,
        bsn: 50
      },
      scan,
      analytics: {
        line_count: scan.length,
        evidence_signals: 0,
        dodge_signals: 0,
        trash_signals: 0,
        manipulation_signals: 0,
        unsupported_claims: 0,
        pressure_questions: 0,
        question_count: scan.reduce((a, s) => a + s.punctuation.question_marks, 0),
        repeated_punctuation_count: 0,
        all_caps_count: scan.reduce((a, s) => a + s.punctuation.all_caps_words, 0),
        punctuation_intensity: 0
      },
      summary: {
        text: "Basic scan running.",
        strongest_points: [],
        weakest_points: [],
        notable_problems: []
      }
    };

    return res.end(JSON.stringify(result));

  } catch {
    return res.end(JSON.stringify(base()));
  }
};

function base() {
  return {
    structure: "none",
    selected_segment: "none",
    topics: [],
    worldview: [],
    scores: {
      clarity: 0,
      integrity: 0,
      honesty: 0,
      manipulation: 0,
      bsn: 0
    },
    scan: [],
    analytics: {
      line_count: 0,
      evidence_signals: 0,
      dodge_signals: 0,
      trash_signals: 0,
      manipulation_signals: 0,
      unsupported_claims: 0,
      pressure_questions: 0,
      question_count: 0,
      repeated_punctuation_count: 0,
      all_caps_count: 0,
      punctuation_intensity: 0
    },
    summary: {
      text: "fallback",
      strongest_points: [],
      weakest_points: [],
      notable_problems: []
    }
  };
}

function detect(line) {
  const l = line.toLowerCase();

  if (l.includes("why") || l.includes("?")) return "question";
  if (l.includes("because") || l.includes("data") || l.includes("study")) return "evidence";
  if (l.includes("you") && l.includes("wrong")) return "manipulation";

  return "point";
}
