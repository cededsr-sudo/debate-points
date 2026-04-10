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

    if (!rawText || rawText.trim().length < 25) {
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

    const split = splitSpeakers(cleaned, structure);

    const sideASentences = splitSentences(split.A);
    const sideBSentences = splitSentences(split.B);

    const featuresA = scoreFeatures(split.A, sideASentences);
    const featuresB = scoreFeatures(split.B, sideBSentences);

    const scoresA = computeScores(featuresA);
    const scoresB = computeScores(featuresB);

    const ignoranceA = deriveIgnorance(featuresA, scoresA);
    const ignoranceB = deriveIgnorance(featuresB, scoresB);

    const deceptionA = deriveDeception(featuresA, scoresA);
    const deceptionB = deriveDeception(featuresB, scoresB);

    const verdict = compareSides(scoresA, scoresB, featuresA, featuresB);

    return res.status(200).json({
      structure,
      topics,
      worldview,

      sideA: {
        label: "A",
        textSample: summarizeSide(split.A),
        scores: scoresA,
        labels: {
          honesty: honestyLabel(scoresA.honesty),
          ignorance: ignoranceLabel(ignoranceA),
          manipulation: manipulationLabel(scoresA.manipulation),
          deception: deceptionLabel(deceptionA),
          bsn: bsnLabel(scoresA.bsn)
        },
        debug: {
          features: featuresA,
          sentenceCount: sideASentences.length
        }
      },

      sideB: {
        label: "B",
        textSample: summarizeSide(split.B),
        scores: scoresB,
        labels: {
          honesty: honestyLabel(scoresB.honesty),
          ignorance: ignoranceLabel(ignoranceB),
          manipulation: manipulationLabel(scoresB.manipulation),
          deception: deceptionLabel(deceptionB),
          bsn: bsnLabel(scoresB.bsn)
        },
        debug: {
          features: featuresB,
          sentenceCount: sideBSentences.length
        }
      },

      verdict,

      scores: {
        clarity: round((scoresA.clarity + scoresB.clarity) / 2),
        integrity: round((scoresA.integrity + scoresB.integrity) / 2),
        honesty: round((scoresA.honesty + scoresB.honesty) / 2),
        manipulation: round((scoresA.manipulation + scoresB.manipulation) / 2),
        bsn: round((scoresA.bsn + scoresB.bsn) / 2)
      },

      labels: {
        honesty: honestyLabel(round((scoresA.honesty + scoresB.honesty) / 2)),
        ignorance: ignoranceLabel(round((ignoranceA + ignoranceB) / 2)),
        manipulation: manipulationLabel(round((scoresA.manipulation + scoresB.manipulation) / 2)),
        deception: deceptionLabel(round((deceptionA + deceptionB) / 2)),
        bsn: bsnLabel(round((scoresA.bsn + scoresB.bsn) / 2))
      },

      winner: null,

      debug: {
        splitMode: split.mode,
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
  text = text.replace(/\n{2,}/g, "\n");
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

    return html
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
  } finally {
    clearTimeout(timeout);
  }
}

function detectStructure(text, sentences) {
  const lower = text.toLowerCase();

  const debateSignals =
    countMatches(lower, /\b(team a|team b|moderator|rebuttal|cross examination|opening statement|closing statement|debate)\b/g);

  const interviewSignals =
    countMatches(lower, /\b(i'm|welcome|my question is|i'm wondering|do you think|what i'd like|why not just oppose|i guess)\b/g);

  const quoteSignals =
    countMatches(lower, /\b(let me read|have a watch|have a listen|he said|she said|they said|quote|quoted|clip)\b/g);

  if (debateSignals >= 2) return "debate";
  if (interviewSignals >= 6) return "debate";
  if (quoteSignals >= 1 || sentences.length > 5) return "commentary";
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

  topicScores.political += countMatches(lower, /\b(trump|president|maga|election|policy|america|conservative|left|right|government|iran|israel|midterms|congress|democrat|republican|war)\b/g);
  topicScores.moral += countMatches(lower, /\b(right|wrong|moral|immoral|virtue|evil|goodness|clarity|justice|hate|integrity)\b/g);
  topicScores.theological += countMatches(lower, /\b(god|torah|bible|judaism|jews|chosen|messianic|rabbi|esau|jacob|cain|abel|christianity|christian|scripture)\b/g);
  topicScores.media += countMatches(lower, /\b(podcast|podcasters|cnn|fox|new york times|tweet|truth|show|television|tv|journalist|clip|documentary|interview|reporting)\b/g);
  topicScores.empirical += countMatches(lower, /\b(evidence|proof|fact|reported|video|claim|support|data|source|experiment|briefed|classified)\b/g);
  topicScores.tribal += countMatches(lower, /\b(real maga|not maga|our side|their side|coalition|betrayal|turn on|dark side|base)\b/g);

  const sorted = Object.entries(topicScores)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .map(([topic]) => topic);

  if (sorted.length) return sorted.slice(0, 4);
  return ["political", "media"];
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

  lanes.political += countMatches(lower, /\b(trump|president|policy|election|government|america|maga|conservative|left|right|coalition|war|iran|israel)\b/g);
  lanes.tribal += countMatches(lower, /\b(real maga|not maga|our side|their side|betrayal|base|coalition|turn on)\b/g);
  lanes.theological += countMatches(lower, /\b(god|torah|bible|messianic|rabbi|esau|jacob|chosen|judaism|christianity|christian)\b/g);
  lanes.moral += countMatches(lower, /\b(right|wrong|moral|immoral|virtue|evil|goodness|clarity|justice)\b/g);
  lanes.empirical += countMatches(lower, /\b(evidence|proof|fact|source|reported|video|support|data|briefed|classified)\b/g);

  const sorted = Object.entries(lanes)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .slice(0, 2)
    .map(([lane]) => lane);

  if (sorted.length) return sorted;
  return ["political"];
}

function splitSpeakers(text, structure) {
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);

  if (structure !== "debate") {
    const midpoint = Math.max(1, Math.floor(lines.length / 2));
    return {
      mode: "half_split",
      A: lines.slice(0, midpoint).join(" "),
      B: lines.slice(midpoint).join(" ")
    };
  }

  const questionLike = [];
  const answerLike = [];

  for (const line of lines) {
    const lower = line.toLowerCase();

    const looksQuestion =
      line.includes("?") ||
      /\b(i'm wondering|do you think|why|what|how|would you|are you|so you|my question|i guess then my question)\b/.test(lower);

    const looksAnswer =
      /\b(well|so|i think|i believe|what i'd like|my view|i don't think|i do think|i know|i mean|the answer|i support|i oppose)\b/.test(lower);

    if (looksQuestion && !looksAnswer) {
      questionLike.push(line);
    } else if (looksAnswer) {
      answerLike.push(line);
    } else {
      if (questionLike.length <= answerLike.length) {
        questionLike.push(line);
      } else {
        answerLike.push(line);
      }
    }
  }

  if (!questionLike.length || !answerLike.length) {
    const midpoint = Math.max(1, Math.floor(lines.length / 2));
    return {
      mode: "fallback_half_split",
      A: lines.slice(0, midpoint).join(" "),
      B: lines.slice(midpoint).join(" ")
    };
  }

  return {
    mode: "question_answer_split",
    A: questionLike.join(" "),
    B: answerLike.join(" ")
  };
}

function summarizeSide(text) {
  const sentences = splitSentences(text);
  return sentences.slice(0, 2).join(" ").slice(0, 280) || "-";
}

function scoreFeatures(text, sentences) {
  const lower = text.toLowerCase();
  const textLength = text.length;
  const sentenceCount = Math.max(sentences.length, 1);

  const logicalConnectors = countMatches(lower, /\b(because|therefore|so|thus|hence|which means|that means|for example|for instance|in other words)\b/g);
  const hedges = countMatches(lower, /\b(maybe|perhaps|i think|i believe|it seems|likely|possibly|might|i guess)\b/g);
  const directAssertions = countMatches(lower, /\b(is|are|was|were|does|did|will|won't|can't|cannot)\b/g);
  const insults = countMatches(lower, /\b(stupid|loser|losers|low iq|crazy|nut jobs|clowns|idiot|dumb|moral rot|lunacy|deranged|liars|unhinged)\b/g);
  const tribalTerms = countMatches(lower, /\b(maga|real maga|not maga|our side|their side|base|coalition|dark side|traitor)\b/g);
  const evidenceTerms = countMatches(lower, /\b(evidence|proof|reported|source|video|clip|lawsuit|record|fact|support|briefed|classified|committee|release)\b/g);
  const quoteTerms = countMatches(lower, /\b(he said|she said|they said|let me read|quote|quoted|have a watch|have a listen)\b/g);
  const overclaimTerms = countMatches(lower, /\b(obviously|clearly|beyond doubt|everyone knows|always|never|completely|totally|absolutely|once and for all)\b/g);
  const contradictionMarkers = countMatches(lower, /\b(but|however|although|on the other hand|yet|still)\b/g);
  const questionCount = countMatches(text, /\?/g);
  const dodgeTerms = countMatches(lower, /\b(i don't know|hard to say|we don't know|i can't say|i wasn't there|we'll find out|some of this i can't talk about)\b/g);

  const avgSentenceLength = textLength / sentenceCount;

  const thesisClarity = clamp(
    35 +
      logicalConnectors * 4 +
      Math.min(sentenceCount, 20) * 0.7 -
      Math.max(avgSentenceLength - 180, 0) * 0.15
  );

  const specificity = clamp(
    25 +
      evidenceTerms * 5 +
      countMatches(lower, /\b(trump|iran|israel|congress|committee|cia|classified|missile|nuclear|war)\b/g) * 2 -
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
      questionCount * 4 +
      countMatches(lower, /\b(answer|respond|response|oppose|support|why|because|what i'd like|the answer)\b/g) * 2 -
      dodgeTerms * 3
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
      countMatches(lower, /\b(i think|i believe|to me|it seems|i would say|in my view|in my opinion)\b/g) * 3 -
      overclaimTerms * 3 -
      countMatches(lower, /\b(proves|proof that|beyond any reasonable doubt)\b/g) * 4
  );

  const burdenDiscipline = clamp(
    40 +
      evidenceTerms * 4 -
      overclaimTerms * 3 -
      insults * 2 -
      countMatches(lower, /\b(liar|hoax|fake|anti-semitic|supremacist|hostage|genocide)\b/g) * 2
  );

  const emotionalPressure = clamp(
    20 +
      insults * 8 +
      tribalTerms * 5 +
      countMatches(lower, /\b(hate|evil|dark side|traitor|lunacy|dangerous|heinous|obscene|massive threat|disaster)\b/g) * 5
  );

  const overreachSeverity = clamp(
    20 +
      overclaimTerms * 7 +
      countMatches(lower, /\b(everyone knows|always|never|all of them|no one|once and for all|massive threat|completely failed)\b/g) * 6
  );

  const unsupportedClaimRate = clamp(
    30 +
      Math.max(directAssertions - evidenceTerms - hedges, 0) * 2 +
      overclaimTerms * 3 +
      dodgeTerms * 1
  );

  const tribalFraming = clamp(
    15 +
      tribalTerms * 9 +
      countMatches(lower, /\b(real conservative|real maga|our side|their side|coalition|base)\b/g) * 5
  );

  const contradictionSeverity = clamp(
    15 +
      Math.max(countMatches(lower, /\b(i support|i oppose|i don't support|i do support)\b/g) - 1, 0) * 8 +
      Math.max(countMatches(lower, /\b(always|never)\b/g) - 1, 0) * 4 +
      Math.max(contradictionMarkers - logicalConnectors, 0) * 1.5 +
      dodgeTerms * 2
  );

  return {
    thesisClarity: round(thesisClarity || 25),
    specificity: round(specificity || 25),
    structureCoherence: round(structureCoherence || 25),
    responsiveness: round(responsiveness || 25),
    quoteFairness: round(quoteFairness || 25),
    distinctionHonesty: round(distinctionHonesty || 25),
    burdenDiscipline: round(burdenDiscipline || 25),
    emotionalPressure: round(emotionalPressure || 25),
    overreachSeverity: round(overreachSeverity || 25),
    unsupportedClaimRate: round(unsupportedClaimRate || 25),
    tribalFraming: round(tribalFraming || 25),
    contradictionSeverity: round(contradictionSeverity || 25)
  };
}

function computeScores(features) {
  let clarity = clamp(
    0.30 * features.thesisClarity +
      0.25 * features.specificity +
      0.25 * features.structureCoherence +
      0.20 * features.responsiveness
  );

  let integrity = clamp(
    0.30 * features.quoteFairness +
      0.25 * features.distinctionHonesty +
      0.25 * features.burdenDiscipline +
      0.20 * (100 - features.emotionalPressure)
  );

  let honesty = clamp(
    0.35 * features.distinctionHonesty +
      0.25 * features.quoteFairness +
      0.20 * (100 - features.contradictionSeverity) +
      0.20 * (100 - features.overreachSeverity)
  );

  let manipulation = clamp(
    0.40 * features.tribalFraming +
      0.35 * features.emotionalPressure +
      0.25 * features.unsupportedClaimRate
  );

  let bsn = clamp(
    0.30 * features.unsupportedClaimRate +
      0.25 * features.overreachSeverity +
      0.20 * features.emotionalPressure +
      0.15 * features.tribalFraming +
      0.10 * features.contradictionSeverity
  );

  if (clarity === 0 && integrity === 0 && honesty === 0 && manipulation === 0 && bsn === 0) {
    clarity = 55;
    integrity = 45;
    honesty = 40;
    manipulation = 60;
    bsn = 65;
  }

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

function compareSides(scoresA, scoresB, featuresA, featuresB) {
  const burdenA = scoresA.bsn + scoresA.manipulation + featuresA.contradictionSeverity;
  const burdenB = scoresB.bsn + scoresB.manipulation + featuresB.contradictionSeverity;

  let moreBSN = "tie";
  if (burdenA > burdenB + 5) moreBSN = "A_more_bsn";
  if (burdenB > burdenA + 5) moreBSN = "B_more_bsn";

  let moreHonest = "tie";
  if (scoresA.honesty > scoresB.honesty + 5) moreHonest = "A_more_honest";
  if (scoresB.honesty > scoresA.honesty + 5) moreHonest = "B_more_honest";

  let clearer = "tie";
  if (scoresA.clarity > scoresB.clarity + 5) clearer = "A_clearer";
  if (scoresB.clarity > scoresA.clarity + 5) clearer = "B_clearer";

  return {
    moreBSN,
    moreHonest,
    clearer,
    summary:
      moreBSN === "A_more_bsn"
        ? "Side A carries more BSN overall."
        : moreBSN === "B_more_bsn"
        ? "Side B carries more BSN overall."
        : "Both sides are fairly close on BSN."
  };
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
