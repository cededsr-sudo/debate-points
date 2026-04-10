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
    const cleanedNoAds = removeAdReads(cleaned);
    const sentences = splitSentences(cleanedNoAds);

    if (!sentences.length) {
      return res.status(400).json({ error: "Could not parse usable text." });
    }

    const structure = detectStructure(cleanedNoAds, sentences);
    const topics = detectTopics(cleanedNoAds);
    const worldview = detectWorldview(cleanedNoAds);

    const split = splitSpeakers(cleanedNoAds, structure);
    const sideAText = split.A || "";
    const sideBText = split.B || "";

    const sideASentences = splitSentences(sideAText);
    const sideBSentences = splitSentences(sideBText);

    const featuresA = scoreFeatures(sideAText, sideASentences);
    const featuresB = scoreFeatures(sideBText, sideBSentences);

    const scoresA = computeScores(featuresA);
    const scoresB = computeScores(featuresB);

    const behaviorA = detectBehavior(sideAText);
    const behaviorB = detectBehavior(sideBText);

    const ignoranceA = deriveIgnorance(featuresA, scoresA, behaviorA);
    const ignoranceB = deriveIgnorance(featuresB, scoresB, behaviorB);

    const deceptionA = deriveDeception(featuresA, scoresA, behaviorA);
    const deceptionB = deriveDeception(featuresB, scoresB, behaviorB);

    const judgmentA = judgeSide(scoresA, behaviorA);
    const judgmentB = judgeSide(scoresB, behaviorB);

    const verdict = compareSides(scoresA, scoresB, behaviorA, behaviorB);

    const aggregateScores = {
      clarity: round((scoresA.clarity + scoresB.clarity) / 2),
      integrity: round((scoresA.integrity + scoresB.integrity) / 2),
      honesty: round((scoresA.honesty + scoresB.honesty) / 2),
      manipulation: round((scoresA.manipulation + scoresB.manipulation) / 2),
      bsn: round((scoresA.bsn + scoresB.bsn) / 2)
    };

    return res.status(200).json({
      structure,
      topics,
      worldview,
      scores: aggregateScores,
      labels: {
        honesty: honestyLabel(aggregateScores.honesty),
        ignorance: ignoranceLabel(round((ignoranceA + ignoranceB) / 2)),
        manipulation: manipulationLabel(aggregateScores.manipulation),
        deception: deceptionLabel(round((deceptionA + deceptionB) / 2)),
        bsn: bsnLabel(aggregateScores.bsn)
      },
      verdict,
      sideA: {
        label: "A",
        summary: summarizeSide(sideAText),
        scores: scoresA,
        judgment: judgmentA,
        labels: {
          honesty: honestyLabel(scoresA.honesty),
          ignorance: ignoranceLabel(ignoranceA),
          manipulation: manipulationLabel(scoresA.manipulation),
          deception: deceptionLabel(deceptionA),
          bsn: bsnLabel(scoresA.bsn)
        },
        behavior: behaviorA,
        debug: {
          features: featuresA,
          sentenceCount: sideASentences.length
        }
      },
      sideB: {
        label: "B",
        summary: summarizeSide(sideBText),
        scores: scoresB,
        judgment: judgmentB,
        labels: {
          honesty: honestyLabel(scoresB.honesty),
          ignorance: ignoranceLabel(ignoranceB),
          manipulation: manipulationLabel(scoresB.manipulation),
          deception: deceptionLabel(deceptionB),
          bsn: bsnLabel(scoresB.bsn)
        },
        behavior: behaviorB,
        debug: {
          features: featuresB,
          sentenceCount: sideBSentences.length
        }
      },
      perimeters: {
        blankOutputPrevention: true,
        adReadRemoval: true,
        timestampCleanup: true,
        sameOriginCompatible: true,
        sideSplitEnabled: true,
        behaviorJudgmentEnabled: true,
        fallbackTopics: true,
        fallbackWorldview: true
      },
      winner: null,
      debug: {
        splitMode: split.mode,
        rawLength: rawText.length,
        cleanedLength: cleanedNoAds.length,
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

  text = text.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  text = text.replace(/\b\d+\s*(seconds?|minutes?|hours?)\b/gi, " ");
  text = text.replace(/\bSync to video time\b/gi, " ");
  text = text.replace(/\bAll\s+Politics\s+News\s+For you\s+Recently uploaded\b/gi, " ");
  text = text.replace(/\r/g, "\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{2,}/g, "\n");
  text = text.replace(/\s+([,.!?;:])/g, "$1");
  text = text.trim();

  return text;
}

function removeAdReads(text) {
  const lower = text.toLowerCase();
  const adStarts = [
    "hey, so this time of year",
    "tempo meals",
    "for a limited time",
    "go to templemeals.com",
    "go to tempomeals.com"
  ];

  let cutStart = -1;
  for (const marker of adStarts) {
    const idx = lower.indexOf(marker);
    if (idx !== -1 && (cutStart === -1 || idx < cutStart)) {
      cutStart = idx;
    }
  }

  if (cutStart === -1) return text;

  const tailMarkers = [
    "so i guess i'm just confused",
    "so do you want him to keep",
    "what i'd like is",
    "my question is"
  ];

  let cutEnd = -1;
  const lowerText = text.toLowerCase();
  for (const marker of tailMarkers) {
    const idx = lowerText.indexOf(marker, cutStart);
    if (idx !== -1) {
      cutEnd = idx;
      break;
    }
  }

  if (cutEnd === -1) {
    return text.slice(0, cutStart).trim();
  }

  return (text.slice(0, cutStart) + " " + text.slice(cutEnd)).replace(/\s+/g, " ").trim();
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

  const questionMarks = countMatches(text, /\?/g);
  const interviewSignals = countMatches(
    lower,
    /\b(i'm wondering|my question|do you think|why not|what do you want|would you|are you|so do you|why would you)\b/g
  );
  const answerSignals = countMatches(
    lower,
    /\b(i think|i believe|i support|i oppose|what i'd like|the answer|well|so|i mean)\b/g
  );
  const quoteSignals = countMatches(
    lower,
    /\b(let me read|have a watch|have a listen|he said|she said|they said|quote|quoted)\b/g
  );

  if ((questionMarks >= 8 && answerSignals >= 8) || interviewSignals >= 6) {
    return "debate";
  }

  if (quoteSignals >= 1 || sentences.length > 5) {
    return "commentary";
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

  topicScores.political += countMatches(lower, /\b(trump|president|war|iran|israel|congress|committee|democrat|republican|policy|government|america|allies|commander-in-chief)\b/g);
  topicScores.moral += countMatches(lower, /\b(right|wrong|moral|immoral|good|evil|justice|honest|integrity|liar|genocide)\b/g);
  topicScores.theological += countMatches(lower, /\b(god|bible|torah|jews|anti-semitism|christian|judaism)\b/g);
  topicScores.media += countMatches(lower, /\b(podcast|show|interview|reporting|new york times|media|clip|press)\b/g);
  topicScores.empirical += countMatches(lower, /\b(evidence|facts|source|reported|classified|briefed|committee|intelligence|program|missile|drone|nuclear)\b/g);
  topicScores.tribal += countMatches(lower, /\b(our side|their side|coalition|base|party)\b/g);

  const sorted = Object.entries(topicScores)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .map(([topic]) => topic);

  return sorted.length ? sorted.slice(0, 4) : ["political", "media"];
}

function detectWorldview(text) {
  const lower = text.toLowerCase();

  const lanes = {
    political: 0,
    empirical: 0,
    moral: 0,
    tribal: 0,
    theological: 0
  };

  lanes.political += countMatches(lower, /\b(trump|president|iran|israel|war|government|america|congress|committee)\b/g);
  lanes.empirical += countMatches(lower, /\b(facts|evidence|reported|classified|briefed|source|intelligence|program|nuclear|missile|drone)\b/g);
  lanes.moral += countMatches(lower, /\b(right|wrong|good|evil|honest|liars|genocide|threat)\b/g);
  lanes.tribal += countMatches(lower, /\b(party|democratic|republican|our side|their side)\b/g);
  lanes.theological += countMatches(lower, /\b(god|jews|anti-semitism|bible|torah)\b/g);

  const sorted = Object.entries(lanes)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0)
    .slice(0, 2)
    .map(([lane]) => lane);

  return sorted.length ? sorted : ["political"];
}

function splitSpeakers(text, structure) {
  const sentences = splitSentences(text);

  if (structure !== "debate" || sentences.length < 6) {
    const midpoint = Math.max(1, Math.floor(sentences.length / 2));
    return {
      mode: "half_split",
      A: sentences.slice(0, midpoint).join(" "),
      B: sentences.slice(midpoint).join(" ")
    };
  }

  const A = [];
  const B = [];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    const isQuestionish =
      sentence.includes("?") ||
      /\b(i'm wondering|why not|do you think|what do you want|would you|are you|so do you|how can you|why would you|my question)\b/.test(lower);

    const isAnswerish =
      /\b(well|so|i think|i believe|i support|i oppose|i don't support|what i'd like|i mean|the answer|i know|i don't know|i have a huge problem)\b/.test(lower);

    if (isQuestionish && !isAnswerish) {
      A.push(sentence);
      continue;
    }

    if (isAnswerish) {
      B.push(sentence);
      continue;
    }

    if (A.length <= B.length) {
      A.push(sentence);
    } else {
      B.push(sentence);
    }
  }

  if (!A.length || !B.length) {
    const midpoint = Math.max(1, Math.floor(sentences.length / 2));
    return {
      mode: "fallback_half_split",
      A: sentences.slice(0, midpoint).join(" "),
      B: sentences.slice(midpoint).join(" ")
    };
  }

  return {
    mode: "question_answer_split",
    A: A.join(" "),
    B: B.join(" ")
  };
}

function summarizeSide(text) {
  return splitSentences(text).slice(0, 2).join(" ").slice(0, 260) || "-";
}

function scoreFeatures(text, sentences) {
  const lower = text.toLowerCase();
  const sentenceCount = Math.max(sentences.length, 1);
  const textLength = text.length;
  const avgSentenceLength = safeDivide(textLength, sentenceCount);

  const logicalConnectors = countMatches(lower, /\b(because|therefore|so|thus|which means|for example|in other words)\b/g);
  const evidenceTerms = countMatches(lower, /\b(fact|facts|evidence|reported|source|classified|briefed|committee|release|speech|program)\b/g);
  const hedges = countMatches(lower, /\b(i think|i believe|i guess|maybe|perhaps|i don't know|we don't know|we'll find out|it depends)\b/g);
  const attacks = countMatches(lower, /\b(liar|liars|stupid|dumb|loser|losers|unhinged|fake news)\b/g);
  const contradictionMarkers = countMatches(lower, /\b(but|however|yet|still|although)\b/g);
  const overclaims = countMatches(lower, /\b(obviously|clearly|absolutely|completely|massive threat|huge win|always|never)\b/g);
  const commitment = countMatches(lower, /\b(i support|i oppose|yes|no|totally|that's what i think|my answer is yes)\b/g);
  const questionMarks = countMatches(text, /\?/g);
  const evasion = countMatches(lower, /\b(i don't know|we don't know|we'll find out|i wasn't there|i can't talk about|i'm not invited)\b/g);

  const thesisClarity = clamp(
    40 +
      logicalConnectors * 4 +
      evidenceTerms * 2 -
      Math.max(avgSentenceLength - 180, 0) * 0.15
  );

  const specificity = clamp(
    30 +
      evidenceTerms * 5 +
      countMatches(lower, /\b(iran|trump|israel|nuclear|missile|drone|committee|intelligence|war powers)\b/g) * 2 -
      hedges * 1.5
  );

  const structureCoherence = clamp(
    42 +
      logicalConnectors * 3 +
      Math.min(sentenceCount, 20) * 0.6 -
      attacks * 2 -
      evasion * 1.5
  );

  const responsiveness = clamp(
    35 +
      questionMarks * 2 +
      commitment * 2 -
      evasion * 4
  );

  const quoteFairness = clamp(
    55 +
      evidenceTerms * 1.5 -
      attacks * 4 -
      overclaims * 2
  );

  const distinctionHonesty = clamp(
    48 +
      hedges * 2 -
      overclaims * 3 -
      evasion * 2
  );

  const burdenDiscipline = clamp(
    40 +
      evidenceTerms * 3 -
      attacks * 2 -
      overclaims * 2
  );

  const emotionalPressure = clamp(
    15 +
      attacks * 10 +
      overclaims * 4
  );

  const overreachSeverity = clamp(
    18 +
      overclaims * 7 +
      countMatches(lower, /\b(massive threat|huge win|everyone|never|always|that's just true)\b/g) * 5
  );

  const unsupportedClaimRate = clamp(
    25 +
      Math.max(commitment + overclaims - evidenceTerms, 0) * 3 +
      evasion * 2
  );

  const tribalFraming = clamp(
    10 +
      countMatches(lower, /\b(party|our side|their side|democratic|republican)\b/g) * 6
  );

  const contradictionSeverity = clamp(
    15 +
      contradictionMarkers * 3 +
      evasion * 3 +
      countMatches(lower, /\b(i support|i oppose|i don't support|my answer is yes|no)\b/g) * 1
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
  return {
    clarity: round(clamp(
      0.30 * features.thesisClarity +
      0.25 * features.specificity +
      0.25 * features.structureCoherence +
      0.20 * features.responsiveness
    )),
    integrity: round(clamp(
      0.30 * features.quoteFairness +
      0.25 * features.distinctionHonesty +
      0.25 * features.burdenDiscipline +
      0.20 * (100 - features.emotionalPressure)
    )),
    honesty: round(clamp(
      0.35 * features.distinctionHonesty +
      0.25 * features.quoteFairness +
      0.20 * (100 - features.contradictionSeverity) +
      0.20 * (100 - features.overreachSeverity)
    )),
    manipulation: round(clamp(
      0.40 * features.tribalFraming +
      0.35 * features.emotionalPressure +
      0.25 * features.unsupportedClaimRate
    )),
    bsn: round(clamp(
      0.30 * features.unsupportedClaimRate +
      0.25 * features.overreachSeverity +
      0.20 * features.emotionalPressure +
      0.15 * features.tribalFraming +
      0.10 * features.contradictionSeverity
    ))
  };
}

function detectBehavior(text) {
  const lower = text.toLowerCase();

  const evasion = countMatches(lower, /\b(i don't know|we don't know|we'll find out|i wasn't there|i'm not invited|i can't talk about)\b/g);
  const commitment = countMatches(lower, /\b(i support|i oppose|yes|no|totally|my answer is yes|that's what i think)\b/g);
  const contradictions = countMatches(lower, /\b(but|however|yet|still|although)\b/g);
  const attacks = countMatches(lower, /\b(liar|liars|stupid|dumb|loser|unhinged|fake news)\b/g);
  const assertionOnly = countMatches(lower, /\b(that's just true|massive threat|huge win|obviously|clearly)\b/g);

  return {
    evasion,
    commitment,
    contradictions,
    attacks,
    assertionOnly
  };
}

function deriveIgnorance(features, scores, behavior) {
  return round(clamp(
    18 +
    0.25 * features.unsupportedClaimRate +
    0.20 * features.overreachSeverity +
    0.15 * (100 - features.distinctionHonesty) +
    0.15 * (100 - scores.clarity) +
    0.25 * behavior.evasion
  ));
}

function deriveDeception(features, scores, behavior) {
  return round(clamp(
    10 +
    0.30 * features.contradictionSeverity +
    0.25 * features.overreachSeverity +
    0.15 * (100 - features.quoteFairness) +
    0.15 * (100 - scores.integrity) +
    0.15 * behavior.assertionOnly
  ));
}

function judgeSide(scores, behavior) {
  if (behavior.evasion > behavior.commitment && behavior.contradictions >= 4) {
    return "BSN";
  }
  if (scores.honesty >= 65 && behavior.commitment >= behavior.evasion) {
    return "HONEST";
  }
  if (behavior.evasion >= 3 && behavior.commitment <= 1) {
    return "MANIPULATED";
  }
  return "MIXED";
}

function compareSides(scoresA, scoresB, behaviorA, behaviorB) {
  const bsnLoadA = scoresA.bsn + scoresA.manipulation + behaviorA.evasion * 4 + behaviorA.contradictions * 2;
  const bsnLoadB = scoresB.bsn + scoresB.manipulation + behaviorB.evasion * 4 + behaviorB.contradictions * 2;

  const honestyLoadA = scoresA.honesty + behaviorA.commitment * 3 - behaviorA.evasion * 2;
  const honestyLoadB = scoresB.honesty + behaviorB.commitment * 3 - behaviorB.evasion * 2;

  const clarityLoadA = scoresA.clarity + behaviorA.commitment * 2;
  const clarityLoadB = scoresB.clarity + behaviorB.commitment * 2;

  const moreBSN =
    bsnLoadA > bsnLoadB + 5 ? "A_more_bsn" :
    bsnLoadB > bsnLoadA + 5 ? "B_more_bsn" :
    "tie";

  const moreHonest =
    honestyLoadA > honestyLoadB + 5 ? "A_more_honest" :
    honestyLoadB > honestyLoadA + 5 ? "B_more_honest" :
    "tie";

  const clearer =
    clarityLoadA > clarityLoadB + 5 ? "A_clearer" :
    clarityLoadB > clarityLoadA + 5 ? "B_clearer" :
    "tie";

  return {
    moreBSN,
    moreHonest,
    clearer,
    summary:
      moreBSN === "A_more_bsn"
        ? "Side A carries more BSN overall."
        : moreBSN === "B_more_bsn"
        ? "Side B carries more BSN overall."
        : "Both sides are close on BSN."
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
