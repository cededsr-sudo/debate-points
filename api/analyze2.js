const ANALYSIS_MODE = 'deterministic+claim-first+factcheck-stub+merge';

const DEFAULT_TEAM_A = 'Team A';
const DEFAULT_TEAM_B = 'Team B';

const TIMESTAMP_PATTERNS = [
  /\b\d{1,2}:\d{2}:\d{2}\b/g,
  /\b\d{1,2}:\d{2}\b/g,
  /\b\d+\s*hour[s]?\b/gi,
  /\b\d+\s*minute[s]?\b/gi,
  /\b\d+\s*second[s]?\b/gi,
  /\b\d+\s*hours?,\s*\d+\s*minutes?,\s*\d+\s*seconds?\b/gi,
  /\b\d+\s*minutes?,\s*\d+\s*seconds?\b/gi,
  /\b\d+\s*seconds\b/gi,
  /^\s*\d+\s*$/gm
];

const STAGE_PATTERNS = [
  /\[applause\]/gi,
  /\[music\]/gi,
  /\[laughter\]/gi,
  /\[inaudible\]/gi,
  /foreign/gi
];

const MODERATOR_HINTS = [
  'moderator', 'welcome', 'tonight as', 'time keeper', 'logistics', 'restroom', 'cell phones',
  'live stream', 'please join me in welcoming', 'ground rules', 'question and answer session',
  'opening statement please', 'thank you very much', 'we now turn to', 'ask a question',
  'the audience can ask', 'let us welcome', 'neutral corners', 'to my left', 'to my right'
];

const OUTRO_HINTS = [
  'that concludes', 'take care everyone', 'hope you found this interesting', 'thanks everyone for',
  'thanks very much for participating', 'conclude the proceedings', 'good evening everyone'
];

const FILLER_WORDS = new Set([
  'um', 'uh', 'er', 'ah', 'like', 'you know', 'i mean', 'sort of', 'kind of', 'basically', 'literally'
]);

const REASON_WORDS = [
  'because', 'therefore', 'thus', 'hence', 'so', 'since', 'which means', 'that means',
  'as a result', 'for that reason', 'this shows', 'this proves', 'which is why'
];

const SUPPORT_WORDS = [
  'study', 'paper', 'data', 'evidence', 'experiment', 'observed', 'result', 'results', 'shows',
  'demonstrates', 'record', 'fossil', 'molecular', 'embryology', 'rna', 'peptide', 'chemistry',
  'nmr', 'published', 'journal', 'research', 'citation', 'references'
];

const PRESSURE_WORDS = [
  'liar', 'fraud', 'clueless', 'scam', 'charlatan', 'delusional', 'ridiculous', 'idiotic',
  'embarrassing', 'pathetic', 'gish gallop', 'straw man', 'propagandist', 'science denial'
];

const OPINION_WORDS = [
  'i think', 'i believe', 'in my opinion', 'clearly', 'obviously', 'absurd', 'ridiculous', 'idiotic',
  'pathetic', 'embarrassing', 'dishonest', 'fraudulent', 'delusional'
];

function cleanWhitespace(value = '') {
  return String(value)
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleSafe(value, fallback) {
  const text = cleanWhitespace(value || '');
  return text || fallback;
}

function stripTimestamps(text = '') {
  let out = text;
  for (const re of TIMESTAMP_PATTERNS) out = out.replace(re, ' ');
  for (const re of STAGE_PATTERNS) out = out.replace(re, ' ');
  return cleanWhitespace(out);
}

function normalizeTranscript(raw = '') {
  let text = cleanWhitespace(raw);
  text = stripTimestamps(text);
  text = text
    .replace(/\bSync to video time\b/gi, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([a-z])([A-Z])/g, '$1. $2')
    .replace(/([a-z])(?=(Mr |Mrs |Dr |Professor |Team ))/g, '$1 ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n/g, ' ');
  return cleanWhitespace(text);
}

function splitSentences(text = '') {
  const prepared = text
    .replace(/([.!?])\s+(?=[A-Z])/g, '$1\n')
    .replace(/;\s+(?=[A-Z])/g, ';\n')
    .replace(/:\s+(?=[A-Z])/g, ':\n');

  return prepared
    .split(/\n+/)
    .map(s => cleanWhitespace(s))
    .filter(Boolean);
}

function words(text = '') {
  return cleanWhitespace(text).toLowerCase().split(/\s+/).filter(Boolean);
}

function wordCount(text = '') {
  return words(text).length;
}

function includesAny(text = '', list = []) {
  const lower = text.toLowerCase();
  return list.some(item => lower.includes(item));
}

function isModeratorLike(sentence = '') {
  if (!sentence) return true;
  const lower = sentence.toLowerCase();
  if (includesAny(lower, MODERATOR_HINTS)) return true;
  if (includesAny(lower, OUTRO_HINTS)) return true;
  if (/^thank you/.test(lower) && wordCount(lower) < 14) return true;
  if (/^welcome/.test(lower)) return true;
  if (/^good evening/.test(lower)) return true;
  if (/^please /.test(lower) && wordCount(lower) < 18) return true;
  return false;
}

function isFragment(sentence = '') {
  const s = cleanWhitespace(sentence);
  if (!s) return true;
  if (wordCount(s) < 8) return true;
  if (/^[,;:.]/.test(s)) return true;
  if (/^(and|but|so|or|because|then|well)\b/i.test(s) && wordCount(s) < 14) return true;
  if (/^(this|that|it|he|she|they)\s+(happens|is|was)\b/i.test(s) && wordCount(s) < 10) return true;
  if (/(tell him|read the paper|what are you talking about)\?*$/i.test(s) && wordCount(s) < 18) return true;
  return false;
}

function fillerRatio(sentence = '') {
  const ws = words(sentence);
  if (!ws.length) return 1;
  const filler = ws.filter(w => FILLER_WORDS.has(w)).length;
  return filler / ws.length;
}

function isUsableSentence(sentence = '') {
  if (!sentence) return false;
  if (isModeratorLike(sentence)) return false;
  if (isFragment(sentence)) return false;
  if (fillerRatio(sentence) > 0.16) return false;
  if (/\b(restroom|audience|applause|cell phones|live stream|exit)\b/i.test(sentence)) return false;
  return true;
}

function scoreSentence(sentence = '') {
  const lower = sentence.toLowerCase();
  let score = 0;
  const wc = wordCount(sentence);

  if (wc >= 12) score += 4;
  if (wc >= 18) score += 4;
  if (wc <= 45) score += 3;
  if (includesAny(lower, REASON_WORDS)) score += 8;
  if (includesAny(lower, SUPPORT_WORDS)) score += 8;
  if (/\b(show|demonstrate|prove|support|indicate|suggest|undermine|explain|refute|compare)\b/i.test(sentence)) score += 6;
  if (/\b(cannot|can not|does not|do not|fails|fail|lack|lacks|undercut|undermine|insufficient|not enough)\b/i.test(sentence)) score += 4;
  if (/\b(if .* then|because .* therefore|the reason .* is)\b/i.test(lower)) score += 6;
  if (/\bpaper|study|data|experiment|journal|fossil|rna|peptide|molecule|genesis|gospels|history|evidence\b/i.test(sentence)) score += 5;
  if (/\?/.test(sentence)) score -= 3;
  if (includesAny(lower, PRESSURE_WORDS)) score -= 4;
  if (includesAny(lower, OPINION_WORDS)) score -= 2;
  if (fillerRatio(sentence) > 0.08) score -= 5;
  return score;
}

function findTurnAnchors(sentences, teamAName, teamBName) {
  const anchors = [];
  const nameA = teamAName.toLowerCase();
  const nameB = teamBName.toLowerCase();

  sentences.forEach((s, i) => {
    const lower = s.toLowerCase();
    if (lower.includes(nameA) && /opening statement|question|reply|answer|respond/i.test(lower)) anchors.push({ index: i, side: 'A' });
    if (lower.includes(nameB) && /opening statement|question|reply|answer|respond/i.test(lower)) anchors.push({ index: i, side: 'B' });
  });

  return anchors.sort((a, b) => a.index - b.index);
}

function segmentDebate(sentences, teamAName, teamBName) {
  const usable = sentences.filter(isUsableSentence);
  if (!usable.length) return { A: [], B: [] };

  const anchors = findTurnAnchors(sentences, teamAName, teamBName);
  if (anchors.length >= 2) {
    const ranges = [];
    for (let i = 0; i < anchors.length; i++) {
      const start = anchors[i].index + 1;
      const end = i + 1 < anchors.length ? anchors[i + 1].index : sentences.length;
      ranges.push({ side: anchors[i].side, start, end });
    }

    const A = [];
    const B = [];
    for (const r of ranges) {
      const slice = sentences.slice(r.start, r.end).filter(isUsableSentence);
      if (r.side === 'A') A.push(...slice);
      else B.push(...slice);
    }
    if (A.length || B.length) return { A, B };
  }

  const half = Math.floor(usable.length / 2);
  return {
    A: usable.slice(0, half),
    B: usable.slice(half)
  };
}

function classifyLane(sentences) {
  const text = sentences.join(' ').toLowerCase();
  const science = (text.match(/\b(data|experiment|molecule|chemistry|rna|peptide|fossil|embryology|molecular|record|study|paper|journal|evidence)\b/g) || []).length;
  const theology = (text.match(/\b(god|bible|jesus|scripture|gospel|genesis|faith|theology|miracle|martyrdom|disciple)\b/g) || []).length;
  const history = (text.match(/\b(history|historical|rome|roman|ancient|eyewitness|records|sources|biographies|literary)\b/g) || []).length;

  const max = Math.max(science, theology, history);
  if (max === 0) return 'mixed / unclear lane';
  if (science >= theology && science >= history && science >= 3) return 'science / evidence lane';
  if (history >= theology && history >= science && history >= 3) return 'history / evidence lane';
  if (theology >= science && theology >= history && theology >= 3) return 'theology / scripture lane';
  return 'mixed lane with overlapping frameworks';
}

function pickBest(sentences, predicate = () => true) {
  const candidates = sentences
    .filter(predicate)
    .map(s => ({ text: s, score: scoreSentence(s) }))
    .sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function dedupeNearby(sentences) {
  const out = [];
  const seen = new Set();
  for (const s of sentences) {
    const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).slice(0, 12).join(' ');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function trimSentence(text = '', max = 180) {
  const s = cleanWhitespace(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trim()}…`;
}

function stableClaimPhrase(text = '', sideName = '') {
  const s = cleanWhitespace(text);
  if (!s || s.length < 20) return '';
  let out = s
    .replace(new RegExp(`^${sideName}\\s+(mainly argues|argues|says)\\s+that\\s+`, 'i'), '')
    .replace(/^core point:\s*/i, '')
    .replace(/^that\s+/i, '')
    .replace(/^,\s*/i, '')
    .trim();

  if (wordCount(out) < 6) return '';
  if (isFragment(out)) return '';
  return trimSentence(out, 160);
}

function buildSideProfile(sideName, sentences) {
  const cleaned = dedupeNearby(sentences).filter(isUsableSentence);

  const main = pickBest(cleaned, s => scoreSentence(s) >= 10);
  const truth = pickBest(cleaned, s => includesAny(s.toLowerCase(), SUPPORT_WORDS) || includesAny(s.toLowerCase(), REASON_WORDS));
  const overreach = pickBest(cleaned, s => includesAny(s.toLowerCase(), PRESSURE_WORDS) || includesAny(s.toLowerCase(), OPINION_WORDS));
  const opinion = pickBest(cleaned, s => includesAny(s.toLowerCase(), OPINION_WORDS));
  const fluff = pickBest(cleaned, s => fillerRatio(s) > 0.05 || /\b(look|listen|come on|you know|i mean)\b/i.test(s));

  const supportCount = cleaned.filter(s => includesAny(s.toLowerCase(), SUPPORT_WORDS)).length;
  const reasonCount = cleaned.filter(s => includesAny(s.toLowerCase(), REASON_WORDS)).length;
  const pressureCount = cleaned.filter(s => includesAny(s.toLowerCase(), PRESSURE_WORDS)).length;
  const opinionCount = cleaned.filter(s => includesAny(s.toLowerCase(), OPINION_WORDS)).length;

  const score = Math.max(0, Math.min(100, 40 + (supportCount * 5) + (reasonCount * 4) - (pressureCount * 4) - (opinionCount * 2)));

  return {
    sideName,
    sentences: cleaned,
    lane: classifyLane(cleaned),
    mainPosition: main?.text || `${sideName} does not preserve a stable main claim clearly enough in the transcript.`,
    truth: truth?.text || `${sideName} preserves some topic material, but no single sentence cleanly carries the main evidentiary point.`,
    overreach: overreach?.text || `${sideName} shows no single dominant overreach sentence, but some rhetoric exceeds the displayed support.`,
    opinion: opinion?.text || `${sideName} includes interpretive or judgment language mixed into the case.`,
    lalaLand: fluff?.text || 'Some filler remains after cleanup.',
    integrity: supportCount >= pressureCount + 1
      ? 'Leans more grounded than inflated, though not every claim is equally supported.'
      : 'Mixed integrity profile: some grounded points, some interpretive stretch, some unresolved support gaps.',
    reasoning: reasonCount >= 2
      ? 'Uses support language and topic engagement, though the chain from premise to conclusion is less consistent.'
      : 'Reasoning exists, but much of it is asserted more than fully demonstrated.',
    rawScore: score,
    supportCount,
    reasonCount,
    pressureCount,
    opinionCount,
    bestClaim: main?.text || truth?.text || ''
  };
}

function buildCoreDisagreement(a, b) {
  const claimA = stableClaimPhrase(a.bestClaim, a.sideName);
  const claimB = stableClaimPhrase(b.bestClaim, b.sideName);

  if (!claimA && !claimB) {
    return 'Main dispute: the transcript cleanup did not preserve a stable core claim for either side clearly enough to summarize.';
  }
  if (claimA && claimB && claimA.toLowerCase() !== claimB.toLowerCase()) {
    return `Main dispute: ${a.sideName} says ${claimA}, while ${b.sideName} says ${claimB}.`;
  }
  if (claimA && !claimB) {
    return `Main dispute: ${a.sideName} presses ${claimA}, while ${b.sideName} does not preserve a comparably clear rival claim in the transcript.`;
  }
  if (!claimA && claimB) {
    return `Main dispute: ${b.sideName} presses ${claimB}, while ${a.sideName} does not preserve a comparably clear rival claim in the transcript.`;
  }
  return 'Main dispute: both sides circle the same topic, but they frame or support it differently in the preserved transcript.';
}

function buildWeakestOverall(a, b) {
  const penaltyA = a.pressureCount + a.opinionCount - a.supportCount;
  const penaltyB = b.pressureCount + b.opinionCount - b.supportCount;

  if (Math.abs(penaltyA - penaltyB) <= 1) {
    return 'Neither side creates a clean edge on weakness. Both preserve claims with support gaps, interpretive stretch, or overreach.';
  }

  const weak = penaltyA > penaltyB ? a : b;
  const weakText = stableClaimPhrase(weak.overreach || weak.opinion, weak.sideName);

  if (!weakText) {
    return `${weak.sideName} is weakest where at least one claim outruns its displayed support because it asserts more than it explains.`;
  }

  return `${weak.sideName} is weakest on ${weakText} because it overstates the case and leans on interpretation more than demonstration.`;
}

function buildOverallWhy(a, b, winner) {
  if (winner === 'Mixed') {
    return `Close call. ${a.sideName}'s clearest usable point is ${stableClaimPhrase(a.bestClaim, a.sideName) || 'not stable enough to quote cleanly'}, but it is weakened because it ${a.supportCount > a.pressureCount ? 'still leaves unresolved support gaps.' : 'overstates the case and leans on interpretation.'} ${b.sideName}'s clearest usable point is ${stableClaimPhrase(b.bestClaim, b.sideName) || 'not stable enough to quote cleanly'}, but it is weakened because it ${b.supportCount > b.pressureCount ? 'still leaves unresolved support gaps.' : 'overstates the case and leans on interpretation.'}`;
  }

  const win = winner === a.sideName ? a : b;
  const lose = win.sideName === a.sideName ? b : a;
  return `${win.sideName} wins because its best point stays closer to a usable claim-plus-support structure, while ${lose.sideName} leaves more unresolved weakness, overreach, or rebuttal failure in the preserved transcript.`;
}

function buildFactCheckSources(a, b) {
  const pool = [
    ...a.sentences.map(s => ({ side: a.sideName, text: s })),
    ...b.sentences.map(s => ({ side: b.sideName, text: s }))
  ];

  return pool
    .filter(item => scoreSentence(item.text) >= 9)
    .sort((x, y) => scoreSentence(y.text) - scoreSentence(x.text))
    .slice(0, 8)
    .map(item => ({
      title: `${item.side}: ${trimSentence(item.text, 140)}`,
      type: includesAny(item.text.toLowerCase(), PRESSURE_WORDS)
        ? 'flagged-overreach'
        : includesAny(item.text.toLowerCase(), SUPPORT_WORDS)
          ? 'supported-language'
          : 'needs-review',
      confidence: 'unknown',
      source: 'Transcript-only analysis',
      note: includesAny(item.text.toLowerCase(), SUPPORT_WORDS)
        ? 'Uses evidence-oriented language, but outside verification is still required.'
        : 'This claim is analyzable, but not independently verified in this backend-only version.'
    }));
}

function compareSides(a, b) {
  const diff = a.rawScore - b.rawScore;
  let winner = 'Mixed';
  if (diff >= 7) winner = a.sideName;
  if (diff <= -7) winner = b.sideName;

  const strongest = (scoreSentence(a.bestClaim) >= scoreSentence(b.bestClaim)) ? a : b;
  const weaker = strongest.sideName === a.sideName ? b : a;

  let bsMeter = 'Both sides show comparable overreach.';
  if (a.pressureCount > b.pressureCount + 1) bsMeter = `${a.sideName} is reaching more`;
  if (b.pressureCount > a.pressureCount + 1) bsMeter = `${b.sideName} is reaching more`;

  return {
    winner,
    confidence: `${Math.max(51, Math.min(92, 50 + Math.abs(diff)))}%`,
    teamAScore: a.rawScore,
    teamBScore: b.rawScore,
    teamALane: a.lane,
    teamBLane: b.lane,
    coreDisagreement: buildCoreDisagreement(a, b),
    bsMeter,
    strongestArgumentSide: winner === 'Mixed' ? strongest.sideName : winner,
    strongestArgument: strongest.bestClaim || 'No stable strongest argument could be finalized from the preserved transcript.',
    whyItStandsOut: strongest.bestClaim
      ? 'It stands out because it brings more actual support and it stays closer to the real dispute.'
      : 'No strongest argument was selected because the extracted transcript material stayed too unstable.',
    failedResponseByOtherSide: weaker.bestClaim
      ? `${weaker.sideName} does not beat that point with a cleaner rival claim. Its nearest competing claim is: ${trimSentence(weaker.bestClaim)}`
      : `${weaker.sideName} does not preserve a cleaner rival claim strongly enough to displace the other side's best point.`,
    weakestOverall: buildWeakestOverall(a, b),
    overallWhy: buildOverallWhy(a, b, winner),
    sameLaneEngagement: a.lane === b.lane
      ? `Both sides largely argue in the same lane: ${a.lane}.`
      : 'At least one side blends lanes, so engagement is only partial rather than cleanly matched.',
    laneMismatch: a.lane === b.lane
      ? 'Low lane mismatch. They are mostly fighting on shared ground.'
      : `Lane mismatch exists: ${a.sideName} is mainly in ${a.lane}, while ${b.sideName} is mainly in ${b.lane}.`,
    manipulation: `${a.sideName}: ${a.pressureCount ? 'Some rhetorical pressure appears, but it does not fully dominate the case.' : 'Low obvious manipulation in the preserved text.'} ${b.sideName}: ${b.pressureCount ? 'Noticeable pressure language and framing tactics show up alongside the argument.' : 'Low obvious manipulation in the preserved text.'}`,
    fluff: `${a.sideName}: ${fillerRatio(a.sentences.join(' ')) > 0.05 ? 'Some fluff remains, but the main claims are still identifiable.' : 'Low fluff after cleanup.'} ${b.sideName}: ${fillerRatio(b.sentences.join(' ')) > 0.05 ? 'Some fluff remains, but the main claims are still identifiable.' : 'Low fluff after cleanup.'}`
  };
}

function buildResponse(body) {
  const teamAName = titleSafe(body.teamAName, DEFAULT_TEAM_A);
  const teamBName = titleSafe(body.teamBName, DEFAULT_TEAM_B);
  const transcript = cleanWhitespace(body.transcript || body.rawTranscript || '');

  if (!transcript) {
    return {
      ok: false,
      error: 'Transcript is required.',
      analysisMode: ANALYSIS_MODE
    };
  }

  const normalized = normalizeTranscript(transcript);
  const sentences = splitSentences(normalized);
  const segmented = segmentDebate(sentences, teamAName, teamBName);

  const a = buildSideProfile(teamAName, segmented.A);
  const b = buildSideProfile(teamBName, segmented.B);
  const compared = compareSides(a, b);

  return {
    ok: true,
    analysisMode: ANALYSIS_MODE,
    cleanedTranscript: normalized,
    winner: compared.winner,
    confidence: compared.confidence,
    teamAScore: compared.teamAScore,
    teamBScore: compared.teamBScore,
    teamALane: compared.teamALane,
    teamBLane: compared.teamBLane,
    coreDisagreement: compared.coreDisagreement,
    bsMeter: compared.bsMeter,
    strongestArgumentSide: compared.strongestArgumentSide,
    strongestArgument: compared.strongestArgument,
    whyItStandsOut: compared.whyItStandsOut,
    failedResponseByOtherSide: compared.failedResponseByOtherSide,
    weakestOverall: compared.weakestOverall,
    overallWhy: compared.overallWhy,
    teamAnalysis: {
      teamA: {
        name: a.sideName,
        mainPosition: a.mainPosition,
        truth: a.truth,
        overreach: a.overreach,
        opinion: a.opinion,
        lalaLand: a.lalaLand
      },
      teamB: {
        name: b.sideName,
        mainPosition: b.mainPosition,
        truth: b.truth,
        overreach: b.overreach,
        opinion: b.opinion,
        lalaLand: b.lalaLand
      }
    },
    integrityAndReasoning: {
      teamAIntegrity: a.integrity,
      teamAReasoning: a.reasoning,
      teamBIntegrity: b.integrity,
      teamBReasoning: b.reasoning
    },
    worldviewLaneCheck: {
      sameLaneEngagement: compared.sameLaneEngagement,
      laneMismatch: compared.laneMismatch
    },
    pressureAndNoise: {
      manipulation: compared.manipulation,
      fluff: compared.fluff
    },
    factCheckSources: buildFactCheckSources(a, b)
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed. Use POST.',
      analysisMode: ANALYSIS_MODE
    });
  }

  try {
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const result = buildResponse(body);
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Server failed to analyze transcript.',
      detail: err && err.message ? err.message : 'unknown error',
      analysisMode: ANALYSIS_MODE
    });
  }
};
