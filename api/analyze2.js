export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = normalizeBody(req.body);
    const textInput = typeof body.text === "string" ? body.text.trim() : "";
    const linkInput = typeof body.link === "string" ? body.link.trim() : "";

    if (!textInput && !linkInput) {
      return res.status(400).json({ error: "Provide text or link." });
    }

    let rawText = textInput;

    if (!rawText && linkInput) {
      rawText = await extractTextFromLink(linkInput);
    }

    if (!rawText || rawText.length < 40) {
      return res.status(400).json({ error: "Not enough content to analyze." });
    }

    const cleaned = cleanText(rawText);
    const sentences = splitSentences(cleaned);

    if (!sentences.length) {
      return res.status(400).json({ error: "Could not parse usable text." });
    }

    const structure = detectStructure(cleaned, sentences);
    const topics = detectTopics(cleaned);
    const worldview = detectWorldview(cleaned);
    const features = scoreFeatures(cleaned, sentences);
    const scores = computeScores(features);
    const ignorance = deriveIgnorance(features, scores);
    const deception = deriveDeception(features, scores);

    return res.status(200).json({
      structure,
      topics,
      worldview,
      scores,
      labels: {
        honesty: honestyLabel(scores.honesty),
        ignorance: ignoranceLabel(ignorance),
        manipulation: manipulationLabel(scores.manipulation),
        deception: deceptionLabel(deception),
        bsn: bsnLabel(scores.bsn)
      },
      winner: null,
      debug: {
        features,
        textLength: rawText.length,
        cleanedLength: cleaned.length,
        sentenceCount: sentences.length
      }
    });
  } catch (error) {
    console.error("analyze error:", error);
    return res.status(500).json({
      error: error?.message || "Failed to analyze input."
    });
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value);
}

function safeDivide(a, b) {
  return b === 0 ? 0 : a / b;
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function cleanText(raw) {
  let text = raw || "";

  text = text.replace(/\b\d{1,2}:\d{1,2}(?:\d{1,2})?\s*(?:seconds?|minutes?(?:,\s*\d+\s*seconds?)?)?/gi, " ");
  text = text.replace(/\b\d{1,2}:\s*,\s*\d+\s*seconds?\b/gi, " ");
  text = text.replace(/\b\d+\s*minutes?,?\s*\d*\s*seconds?\b/gi, " ");
  text = text.replace(/\bSync to video time\b/gi, " ");
  text = text.replace(/\bAll\s+Politics\s+News\s+For you\s+Recently uploaded\b/gi, " ");
  text = text.replace(/\r/g, "\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/\s+([,.!?;:])/g, "$1");
  text = text.trim();

  return text;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function extractTextFromLink(link) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(link, {
      method: "GET",
      headers: {
        "User-Agent": "ReasoningAudit/1.0",
        "Accept": "text/html,application/xhtml+xml,text/plain"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch link: ${response.status}`);
    }

    const html = await response.text();

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|br|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function detectStructure(text, sentences) {
  const lower = text.toLowerCase();

  const speakerCues =
    countMatches(lower, /\b(team a|team b|speaker 1|speaker 2|moderator|host|guest|debate|cross examination|rebuttal)\b/g) +
    countMatches(lower, /\b(he said|she said|they said|let me read|have a watch|have a listen|clip|quoted|quote)\b/g);

  const quoteCount =
    countMatches(text, /["“”]/g) +
    countMatches(lower, /\b(quote|quoted|let me read|he said|she said|they said)\b/g);

  const shortSentenceCount = sentences.filter((s) => s.length < 140).length;
  const quoteDensity = safeDivide(quoteCount, Math.max(text.length / 200, 1));
  const cueDensity = safeDivide(speakerCues + shortSentenceCount * 0.05, Math.max(sentences.length, 1));

  if (
    lower.includes("let me read") ||
    lower.includes("have a watch") ||
    lower.includes("have a listen") ||
    lower.includes("i want to show you") ||
    quoteDensity > 2.0 ||
    cueDensity < 0.7
  ) {
    return "commentary";
  }

  if (speakerCues >= 4 && sentences.length > 8) {
    return "debate";
  }

  return "commentary";
}

function detectTopics(text) {
  const lower = text.toLowerCase();
  const topicScores = {
    political: 0,
    moral: 0,
    theological: 0,
    media: 0,
    empirical: 0,
    tribal: 0
  };

  topicScores.political += countMatches(lower, /\b(trump|president|maga|election|policy|america|conservative|left|right|government|iran|israel|midterms)\b/g);
  topicScores.moral += countMatches(lower, /\b(right|wrong|moral|immoral|virtue|evil|goodness|clarity|justice|hate|integrity)\b/g);
  topicScores.theological += countMatches(lower, /\b(god|torah|bible|judaism|jews|chosen|messianic|rabbi|esau|jacob|cain|abel|christianity|christian|scripture)\b/g);
  topicScores.media += countMatches(lower, /\b(podcast|podcasters|cnn|fox|new york times|tweet|truth|show|television|tv|journalist|clip|documentary)\b/g);
  topicScores.empirical += countMatches(lower, /\b(evidence|proof|fact|reported|video|claim|support|data|source|experiment)\b/g);
  topicScores.tribal += countMatches(lower, /\b(real maga|not maga|our side|their side|coalition|betrayal|turn on|dark side|base)\b/g);

  const sorted = Object.entries(topicScores)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .map(([topic]) => topic);

  return sorted.length ? sorted.slice(0, 4) : ["mixed"];
}

function detectWorldview(text) {
  const lower = text.toLowerCase();

  const lanes = {
    political: 0,
    tribal: 0,
    theological: 0,
    moral: 0,
    empirical: 0
  };

  lanes.political += countMatches(lower, /\b(trump|president|policy|election|government|america|maga|conservative|left|right|coalition)\b/g);
  lanes.tribal += countMatches(lower, /\b(real maga|not maga|our side|their side|betrayal|base|coalition|turn on)\b/g);
  lanes.theological += countMatches(lower, /\b(god|torah|bible|messianic|rabbi|esau|jacob|chosen|judaism|christianity|christian)\b/g);
  lanes.moral += countMatches(lower, /\b(right|wrong|moral|immoral|virtue|evil|goodness|clarity|justice)\b/g);
  lanes.empirical += countMatches(lower, /\b(evidence|proof|fact|source|reported|video|support|data)\b/g);

  const sorted = Object.entries(lanes)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .slice(0, 2)
    .map(([lane]) => lane);

  return sorted.length ? sorted : ["mixed"];
}

function scoreFeatures(text, sentences) {
  const lower = text.toLowerCase();
  const textLength = text.length;
  const sentenceCount = sentences.length;

  const logicalConnectors = countMatches(lower, /\b(because|therefore|so|thus|hence|which means|that means|for example|for instance|in other words)\b/g);
  const hedges = countMatches(lower, /\b(maybe|perhaps|i think|i believe|it seems|likely|possibly|might)\b/g);
  const directAssertions = countMatches(lower, /\b(is|are|was|were|does|did|will|won't|can't|cannot)\b/g);
  const insults = countMatches(lower, /\b(stupid|loser|losers|low iq|crazy|nut jobs|clowns|idiot|dumb|moral rot|lunacy|deranged)\b/g);
  const tribalTerms = countMatches(lower, /\b(maga|real maga|not maga|our side|their side|base|coalition|dark side|traitor)\b/g);
  const evidenceTerms = countMatches(lower, /\b(evidence|proof|reported|source|video|clip|lawsuit|record|fact|support)\b/g);
  const quoteTerms = countMatches(lower, /\b(he said|she said|they said|let me read|quote|quoted|have a watch|have a listen)\b/g);
  const overclaimTerms = countMatches(lower, /\b(obviously|clearly|beyond doubt|everyone knows|always|never|completely|totally|absolutely|once and for all)\b/g);
  const contradictionMarkers = countMatches(lower, /\b(but|however|although|on the other hand|yet|still)\b/g);
  const questionCount = countMatches(text, /\?/g);

  const avgSentenceLength = sentenceCount ? textLength / sentenceCount : textLength;

  const thesisClarity = clamp(
    35 +
      logicalConnectors * 4 +
      Math.min(sentenceCount, 20) * 0.7 -
      Math.max(avgSentenceLength - 180, 0) * 0.15
  );

  const specificity = clamp(
    25 +
      evidenceTerms * 5 +
      countMatches(lower, /\b(trump|tucker|candace|alex jones|megyn|israel|iran|cnn|fox)\b/g) * 2 -
      hedges * 2
  );

  const structureCoherence = clamp(
    40 +
      logicalConnectors * 4 +
      contradictionMarkers * 1.5 -
      insults * 3 -
      Math.max(sentenceCount - 120, 0) * 0.3
  );

  const responsiveness = clamp(
    30 +
      countMatches(lower, /\b(response|respond|rebuttal|answer|criticize|against|reaction|doubling down)\b/g) * 6 +
      questionCount * 2 -
      countMatches(lower, /\b(anyway|moving on|before we get to that|by the way)\b/g) * 4
  );

  const quoteFairness = clamp(
    55 +
      hedges * 2 -
      insults * 4 -
      overclaimTerms * 2 -
      Math.max(quoteTerms - evidenceTerms, 0) * 2
  );

  const distinctionHonesty = clamp(
    45 +
      hedges * 3 +
      countMatches(lower, /\b(i think|i believe|to me|it seems|i would say|in my view)\b/g) * 3 -
      overclaimTerms * 3 -
      countMatches(lower, /\b(proves|proof that|beyond any reasonable doubt)\b/g) * 4
  );

  const burdenDiscipline = clamp(
    40 +
      evidenceTerms * 4 -
      overclaimTerms * 3 -
      insults * 2 -
      countMatches(lower, /\b(liar|hoax|fake|anti-semitic|supremacist|hostage)\b/g) * 2
  );

  const emotionalPressure = clamp(
    20 +
      insults * 8 +
      tribalTerms * 5 +
      countMatches(lower, /\b(hate|evil|dark side|traitor|lunacy|dangerous|heinous|obscene)\b/g) * 5
  );

  const overreachSeverity = clamp(
    20 +
      overclaimTerms * 7 +
      countMatches(lower, /\b(everyone knows|always|never|all of them|no one|once and for all|opposite of maga)\b/g) * 6
  );

  const unsupportedClaimRate = clamp(
    30 +
      Math.max(directAssertions - evidenceTerms - hedges, 0) * 2 +
      overclaimTerms * 3
  );

  const tribalFraming = clamp(
    15 +
      tribalTerms * 9 +
      countMatches(lower, /\b(real conservative|real maga|our side|their side|coalition|base)\b/g) * 5
  );

  const contradictionSeverity = clamp(
    15 +
      Math.max(countMatches(lower, /\b(he doesn't care|he does care|i don't care|i care)\b/g) - 1, 0) * 8 +
      Math.max(countMatches(lower, /\b(always|never)\b/g) - 1, 0) * 4 +
      Math.max(contradictionMarkers - logicalConnectors, 0) * 1.5
  );

  return {
    thesisClarity: round(thesisClarity),
    specificity: round(specificity),
    structureCoherence: round(structureCoherence),
    responsiveness: round(responsiveness),
    quoteFairness: round(quoteFairness),
    distinctionHonesty: round(distinctionHonesty),
    burdenDiscipline: round(burdenDiscipline),
    emotionalPressure: round(emotionalPressure),
    overreachSeverity: round(overreachSeverity),
    unsupportedClaimRate: round(unsupportedClaimRate),
    tribalFraming: round(tribalFraming),
    contradictionSeverity: round(contradictionSeverity)
  };
}

function computeScores(features) {
  const clarity = clamp(
    0.30 * features.thesisClarity +
      0.25 * features.specificity +
      0.25 * features.structureCoherence +
      0.20 * features.responsiveness
  );

  const integrity = clamp(
    0.30 * features.quoteFairness +
      0.25 * features.distinctionHonesty +
      0.25 * features.burdenDiscipline +
      0.20 * (100 - features.emotionalPressure)
  );

  const honesty = clamp(
    0.35 * features.distinctionHonesty +
      0.25 * features.quoteFairness +
      0.20 * (100 - features.contradictionSeverity) +
      0.20 * (100 - features.overreachSeverity)
  );

  const manipulation = clamp(
    0.40 * features.tribalFraming +
      0.35 * features.emotionalPressure +
      0.25 * features.unsupportedClaimRate
  );

  const bsn = clamp(
    0.30 * features.unsupportedClaimRate +
      0.25 * features.overreachSeverity +
      0.20 * features.emotionalPressure +
      0.15 * features.tribalFraming +
      0.10 * features.contradictionSeverity
  );

  return {
    clarity: round(clarity),
    integrity: round(integrity),
    honesty: round(honesty),
    manipulation: round(manipulation),
    bsn: round(bsn)
  };
}

function deriveIgnorance(features, scores) {
  return round(
    clamp(
      20 +
        0.30 * features.unsupportedClaimRate +
        0.25 * features.overreachSeverity +
        0.15 * (100 - features.distinctionHonesty) +
        0.15 * (100 - features.burdenDiscipline) +
        0.15 * (100 - scores.clarity)
    )
  );
}

function deriveDeception(features, scores) {
  return round(
    clamp(
      10 +
        0.35 * features.contradictionSeverity +
        0.25 * features.overreachSeverity +
        0.20 * (100 - features.quoteFairness) +
        0.20 * (100 - scores.integrity)
    )
  );
}

function honestyLabel(score) {
  if (score >= 75) return "high";
  if (score >= 45) return "mixed";
  return "low";
}

function ignoranceLabel(score) {
  if (score < 30) return "low";
  if (score < 60) return "moderate";
  return "high";
}

function manipulationLabel(score) {
  if (score < 30) return "low";
  if (score < 60) return "moderate";
  return "high";
}

function deceptionLabel(score) {
  if (score < 25) return "none";
  if (score < 50) return "possible";
  return "likely";
}

function bsnLabel(score) {
  if (score < 25) return "low";
  if (score < 50) return "moderate";
  if (score < 75) return "high";
  return "severe";
}
