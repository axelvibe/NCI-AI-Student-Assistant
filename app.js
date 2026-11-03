/* =====================================================================
   NCI Student Assistant — conversational engine
   ---------------------------------------------------------------------
   A chat assistant for National College of Ireland students.

   How it works:
     1. Load sources.json — a curated registry of official NCI pages.
     2. Every question is sent to our Apps Script proxy (the only place
        the OpenAI key lives). The proxy answers with the model, grounded
        on the official NCI sources, and cites them.
     3. Answers are rendered as chat bubbles with links to the official
        NCI page(s), or an honest "I don't have enough information" reply.

   Guardrails:
     - Only answers questions about NCI and student life.
     - Never invents NCI dates, fees, policies or contact details.
     - Never asks for or stores personal data (name, email, student no.).
     - The API key never touches this file (it is kept in Apps Script).

   Optional: a wellbeing check points students in distress to NCI's
   Student Counselling and Wellness Service.
   ===================================================================== */

'use strict';

/* ---------------------------------------------------------------------
   1. CONFIG
   --------------------------------------------------------------------- */
const CONFIG = {
  // Curated registry of official NCI source pages.
  sourcesUrl: 'sources.json',

  // Curated, pre-verified answers used as the primary grounding layer.
  knowledgeUrl: 'knowledge.json',

  // Apps Script proxy (holds the OpenAI key). Empty "" = AI off.
  aiEndpoint: 'https://script.google.com/macros/s/AKfycbxS_LS_U-BrKKEHt5HKC_9y3bQGgqtY3MWcmJGhDccxEUwOdmycP2HKuWGaJLJHUx6Fsg/exec',

  // How many registry sources to send the model for each question.
  maxSources: 8,

  // How many knowledge-base entries to send as grounding.
  maxKb: 4,

  // How many previous turns to send for context.
  historyTurns: 8,

  supportHubUrl: 'https://ncisupporthub.ncirl.ie/hc/en-ie',
  wellbeingUrl: 'https://www.ncirl.ie/Students/Student-Services/Support-Services/Student-Counselling-Wellness-Service',

  // Post-answer satisfaction survey. Asked one question at a time and shown
  // once per browser session so nobody is nagged after every answer.
  surveyEnabled: true,
  surveyMode: 'once-per-session',
  surveyQuestions: [
    { id: 'resolved',  label: 'Was your problem resolved?' },
    { id: 'helpful',   label: 'Did you find it helpful?' },
    { id: 'recommend', label: 'Would you recommend it?' },
    { id: 'easy',      label: 'Was it easy to use?' }
  ]
};

const AI_TIMEOUT_MS = 30000;
let aiSeq = 0;

/* ---------------------------------------------------------------------
   2. STATE
   --------------------------------------------------------------------- */
const state = {
  sources: [],       // registry
  knowledge: [],     // curated knowledge base (knowledge.json)
  entries: [],       // knowledge entries with pre-computed matching data
  entryCount: 0,     // IDF denominator
  allowedHosts: new Set(), // hosts we are allowed to link to
  ready: false
};

// Anonymous session id, kept for the browser tab only. Used to group a visit's
// events; never linked to any personal detail.
const SESSION_ID = (() => {
  try {
    const key = 'nciAssistantSession';
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(key, id);
    }
    return id.slice(0, 40);
  } catch (e) {
    return 's' + Date.now().toString(36);
  }
})();

// Sequential survey state. Lives for the whole page session; `done` stops the
// survey appearing again after it has been shown once (survives reloads in the
// same tab via sessionStorage, but resets for a new browser session).
const SURVEY = {
  done: (() => {
    try { return sessionStorage.getItem('nciAssistantSurveyDone') === '1'; }
    catch (e) { return false; }
  })(),
  qid: '',
  question: '',
  answers: {},
  index: 0
};

function deviceType() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/ipad|tablet|kindle|playbook|silk/.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod|phone/.test(ua)) return 'mobile';
  return 'desktop';
}

function newId(prefix) {
  return (prefix || 'q') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isOfficialUrl(url) {
  try {
    return state.allowedHosts.has(new URL(url).hostname.toLowerCase());
  } catch (e) {
    return false;
  }
}

const CONVERSATION = {
  history: []        // [{ role: 'user'|'assistant', content }]
};

const els = {
  chat: document.getElementById('chat'),
  form: document.getElementById('chat-form'),
  input: document.getElementById('chat-input'),
  send: document.getElementById('send-btn'),
  statusChip: document.getElementById('status-chip'),
  statusText: document.getElementById('status-text')
};

/* ---------------------------------------------------------------------
   3. TEXT HELPERS (privacy + matching)
   --------------------------------------------------------------------- */

// Strip anything that looks like a credential before it is ever sent,
// logged or displayed as a record. Second pass happens in the proxy too.
function scrub(text) {
  return String(text || '')
    .replace(/[^\s@]+@[^\s@]+/g, ' [email] ')
    .replace(/\b(?:password|passwd|pwd|passcode)\b\s*(?:is|are|was|=|:)?\s*["']?[^\s"']{3,}["']?/gi,
             ' password [redacted]')
    .replace(/\b(?:x|ca)?\d{5,}\b/gi, ' [id] ')
    .replace(/\b\d{4,}\b/g, ' [number] ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lighter scrub for model output: keep dates, fees and phone numbers, but
// still remove anything that looks like an email or a password.
function scrubAnswer(text) {
  return String(text || '')
    .replace(/[^\s@]+@[^\s@]+/g, ' [email] ')
    .replace(/\b(?:password|passwd|pwd|passcode)\b\s*(?:is|are|was|=|:)?\s*["']?[^\s"']{3,}["']?/gi,
             ' password [redacted]');
}

function normalise(text) {
  let t = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // "wi fi" and "wifi" are the same thing to a student.
  t = t.replace(/\bwi[- ]?fi\b/g, 'wifi');
  return t;
}

// Words that carry no topical signal. Question words ("where", "when", "how")
// and generic verbs are deliberately included: as keywords they match almost
// any entry and produce confident answers to unrelated questions.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its',
  'this', 'that', 'these', 'those', 'there', 'here',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as', 'of', 'to', 'in',
  'on', 'at', 'by', 'for', 'with', 'about', 'into', 'from', 'up', 'down',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'please', 'want', 'wanna', 'need', 'like', 'know', 'tell', 'get',
  'nci', 'college', 'school', 'university', 'ncir', 'help',
  'where', 'when', 'what', 'how', 'who', 'why', 'which', 'many', 'much',
  'out', 'come', 'go', 'going', 'gets', 'got', 'say', 'said', 'give', 'take',
  'make', 'put', 'real', 'really', 'thing', 'things'
]);

// Very light stemmer. Only strips the common English plural endings so that
// "books"/"book" and "results"/"result" are treated as the same token.
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 3 && word.endsWith('ss')) return word;
  if (word.length > 3 && word.endsWith('us')) return word;
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function tokenise(text, keepStopwords) {
  const out = [];
  for (const raw of normalise(text).split(' ')) {
    if (!raw) continue;
    if (!keepStopwords && STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw) && raw.length < 4) continue; // drop bare numbers
    out.push(stem(raw));
  }
  return out;
}

function tokenSet(text) {
  return new Set(tokenise(text, false));
}

// Dice over character bigrams: "referncing" still overlaps "referencing".
// Used for whole strings, where a missed letter shifts every bigram.
function bigramDice(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

// Normalised Levenshtein similarity, 0..1.
// Bigram scoring under-rates short words: "weak" vs "week" shares only one
// bigram (0.25) even though they differ by a single keystroke (0.75). Typos in
// short words are common, so short tokens are compared with edit distance.
const SHORT_TOKEN_MAX = 5;
const SHORT_TOKEN_SIM = 0.75;

function editSimilarity(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, sub);
    }
    prev = cur;
  }
  return 1 - prev[lb] / Math.max(la, lb);
}

// Character bigrams, so "modle" still has something in common with "moodle".
function bigrams(text) {
  const s = ' ' + normalise(text).replace(/\s+/g, ' ') + ' ';
  const grams = new Set();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

/* ---------------------------------------------------------------------
   4. SOURCE REGISTRY
   --------------------------------------------------------------------- */
async function loadSources() {
  const res = await fetch(CONFIG.sourcesUrl + '?v=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load sources.json (HTTP ' + res.status + ')');
  const data = await res.json();
  if (!data || !Array.isArray(data.sources) || !data.sources.length) {
    throw new Error('sources.json is empty or malformed');
  }
  state.sources = data.sources
    .filter(s => s && s.url && /^https:\/\//.test(s.url))
    .map(s => {
      const kw = new Set();
      (s.keywords || []).forEach(k => tokenise(k).forEach(t => kw.add(t)));
      try { state.allowedHosts.add(new URL(s.url).hostname.toLowerCase()); } catch (e) {}
      return {
        id: s.id,
        title: s.title || 'Official NCI page',
        url: s.url,
        keywords: s.keywords || [],
        kw: kw
      };
    });
}

// Choose the official pages most relevant to the question, so the model
// is grounded on the right sources. Always include the Support Hub.
function selectSources(question) {
  const qNorm = normalise(question);
  const qTokens = tokenise(question);
  const qSet = new Set(qTokens);

  const scored = state.sources.map(s => {
    let score = 0;
    for (const t of qSet) if (s.kw.has(t)) score += 2;
    for (const k of s.keywords) {
      const kn = normalise(k);
      if (kn.indexOf(' ') !== -1 && kn && qNorm.indexOf(kn) !== -1) score += 3;
    }
    return { src: s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  let picked = scored.filter(s => s.score > 0).slice(0, CONFIG.maxSources).map(s => s.src);

  // Always offer the Support Hub and Student Services as fallbacks.
  const fallbackIds = ['support-hub', 'student-services', 'current-students-hub'];
  for (const id of fallbackIds) {
    if (picked.length >= CONFIG.maxSources) break;
    const f = state.sources.find(s => s.id === id);
    if (f && picked.indexOf(f) === -1) picked.push(f);
  }
  return picked;
}

// Load the curated knowledge base (knowledge.json): pre-written, verified
// answers. This is the baseline grounding layer for the assistant.
async function loadKnowledge() {
  const res = await fetch(CONFIG.knowledgeUrl + '?v=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load knowledge.json (HTTP ' + res.status + ')');
  const data = await res.json();
  const entries = (data && Array.isArray(data.entries)) ? data.entries : [];

  state.entries = entries
    .filter(e => e && e.answer)
    .map(e => {
      const texts = [e.question].concat(e.variants || []);
      if (e.link) { try { state.allowedHosts.add(new URL(e.link).hostname.toLowerCase()); } catch (err) {} }
      return {
        ...e,
        id: e.id || '',
        question: e.question || '',
        answer: e.answer,
        link: e.link || '',
        linkLabel: e.linkLabel || e.title || '',
        title: e.title || e.linkLabel || '',
        texts: texts,
        textNorms: texts.map(normalise),
        textSets: texts.map(t => new Set(tokenise(t, false))),
        keywordSet: new Set(tokenise((e.keywords || []).join(' '), false)),
        allSet: new Set(tokenise(texts.join(' ') + ' ' + (e.keywords || []).join(' '), false)),
        allBigrams: bigrams(texts.join(' '))
      };
    });

  // Document frequency over the whole knowledge base, used for IDF weighting.
  const df = new Map();
  for (const e of state.entries) {
    for (const t of e.allSet) df.set(t, (df.get(t) || 0) + 1);
  }
  state.entries.forEach(e => { e.idf = df; });
  state.entryCount = state.entries.length;
  state.knowledge = state.entries;
}

/* ---------------------------------------------------------------------
   4b. MATCHING
   ---------------------------------------------------------------------
   Each entry scores out of 1 from five signals:

     exact   the whole question matches a question/variant wording
     phrase  most of the student's words appear in ONE question/variant
     keys    how many of the entry's keywords the student actually used
     cov     IDF-weighted share of the question the entry accounts for
     fuzzy   character bigram overlap, catches typos in longer words

   Two design points matter for accuracy:

   * IDF weighting. A rare word like "eduroam" is far stronger evidence
     than a common one like "assignment", so coverage is weighted by how
     few entries contain each word rather than counting words equally.

   * An explained-token GATE. A high score alone is not enough to answer.
     The winning entry must also account for at least GATE of the words
     the student used. Without this, one topical keyword is enough to
     confidently answer a longer unrelated question - e.g. "how do I pay
     my rent" scores well on the fees entry purely on the word "pay".

   Weights, threshold and gate were chosen by grid search against a
   labelled set of 73 in-scope questions and 21 out-of-scope questions.
   --------------------------------------------------------------------- */
const WEIGHTS = { exact: 0.30, phrase: 0.30, keys: 0.20, cov: 0.20, fuzzy: 0.05 };
const WEIGHT_TOTAL = WEIGHTS.exact + WEIGHTS.phrase + WEIGHTS.keys +
                     WEIGHTS.cov + WEIGHTS.fuzzy;

// Below this score we say we do not know, rather than guessing.
const MATCH_THRESHOLD = 0.26;
// The winner must also explain at least this share of the student's words.
const EXPLAIN_GATE = 0.60;
// Two keyword hits are treated as a full keyword match: a student needs a
// couple of the right words, not every keyword on the entry.
const KEYWORD_CAP = 4;
// Similarity needed between two words to count as the same, for long words.
const FUZZY_TOKEN_SIM = 0.68;
// Runner-ups this close to the winner get offered as "also check".
const ALSO_CHECK_BAND = 0.10;

function idf(entry, token) {
  const df = entry.idf.get(token) || 0;
  return Math.log(1 + entry.entryCountN / (1 + df));
}

// Is a word the student typed close enough to a word in the entry to count?
function fuzzyHas(queryToken, entryTokens) {
  if (entryTokens.has(queryToken)) return true;
  const short = queryToken.length <= SHORT_TOKEN_MAX;
  const qGrams = bigrams(queryToken);
  for (const et of entryTokens) {
    if (short && Math.abs(et.length - queryToken.length) <= 1 &&
        editSimilarity(queryToken, et) >= SHORT_TOKEN_SIM) {
      return true;
    }
    if (qGrams.size && bigramDice(qGrams, bigrams(et)) >= FUZZY_TOKEN_SIM) {
      return true;
    }
  }
  return false;
}

function scoreEntry(entry, queryNorm, queryList, querySet, queryGrams) {
  // 1. exact whole-string match
  let exact = 0;
  for (const tn of entry.textNorms) {
    if (tn && queryNorm === tn) { exact = 1; break; }
    if (tn.length > 8 && queryNorm.includes(tn)) exact = Math.max(exact, 0.95);
    if (queryNorm.length > 8 && tn.includes(queryNorm)) exact = Math.max(exact, 0.90);
  }

  // 2. phrase: best single wording that covers the question
  let phrase = 0;
  for (const ts of entry.textSets) {
    if (!querySet.size) break;
    let hit = 0;
    for (const t of querySet) if (fuzzyHas(t, ts)) hit++;
    phrase = Math.max(phrase, hit / querySet.size);
  }

  // 3. keys: which of the entry's own keywords the student used
  let keyHits = 0;
  for (const k of entry.keywordSet) if (fuzzyHas(k, querySet)) keyHits++;
  const keys = Math.min(1, keyHits / (Math.min(KEYWORD_CAP, entry.keywordSet.size) || 1));

  // 4. cov: IDF-weighted share of the question this entry accounts for
  let num = 0, den = 0;
  for (const t of queryList) {
    const w = idf(entry, t);
    den += w;
    if (fuzzyHas(t, entry.allSet)) num += w;
  }
  const cov = den ? num / den : 0;

  // 5. fuzzy: character overlap for typos in longer words
  const fuzzy = bigramDice(queryGrams, entry.allBigrams);

  const raw = WEIGHTS.exact * exact + WEIGHTS.phrase * phrase +
              WEIGHTS.keys * keys + WEIGHTS.cov * cov + WEIGHTS.fuzzy * fuzzy;

  // how much of the question is left unexplained, used for the gate
  let explained = 0;
  for (const t of querySet) if (fuzzyHas(t, entry.allSet)) explained++;
  const coverage = querySet.size ? explained / querySet.size : 0;

  return { raw, score: raw / WEIGHT_TOTAL, exact: exact > 0, coverage };
}

function stopwordOnlySearch(queryNorm) {
  // Only reached when the query contains no indexable content words, so the
  // comparison is done on raw normalised text.
  let best = null;
  for (const e of state.entries) {
    const qText = normalise(e.question);
    const variants = (e.variants || []).map(normalise);
    let score = 0, exact = false;
    if (queryNorm === qText || variants.indexOf(queryNorm) !== -1) {
      score = 1; exact = true;
    } else if (queryNorm.indexOf(qText) !== -1) {
      score = 0.8;
    } else {
      for (const v of variants) {
        if (v && queryNorm.indexOf(v) !== -1) { score = 0.7; break; }
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { entry: e, score: score, exact: exact, coverage: 1, also: [] };
    }
  }
  if (!best) return { matched: false, ranked: [], topScore: 0 };
  return {
    matched: true,
    entry: best.entry,
    score: best.score,
    exact: best.exact,
    also: []
  };
}

function search(query) {
  const queryNorm = normalise(query);
  if (!queryNorm) return null;

  // A query made entirely of stopwords ("where do I go if I need help") has no
  // content tokens left to score against, but it is still a real question. Fall
  // back to a plain text test against each entry's question and its rewordings.
  // This can only fire when the query has no indexable terms at all, so it
  // cannot loosen matching for any ordinary question.
  const queryList = tokenise(query, false);
  const querySet = new Set(queryList);
  if (querySet.size === 0) return stopwordOnlySearch(queryNorm);
  const queryGrams = bigrams(query);

  // IDF needs the total entry count on each entry.
  for (const e of state.entries) e.entryCountN = state.entryCount;

  const ranked = state.entries
    .map(e => ({ entry: e, ...scoreEntry(e, queryNorm, queryList, querySet, queryGrams) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return { matched: false, ranked, topScore: 0 };

  const top = ranked[0];
  // Both conditions must hold: strong enough score, and enough of the
  // question actually explained. Otherwise we admit we do not know.
  if (top.score < MATCH_THRESHOLD || top.coverage < EXPLAIN_GATE) {
    return { matched: false, ranked, topScore: top.score, topCoverage: top.coverage };
  }

  return {
    matched: true,
    entry: top.entry,
    score: top.score,
    exact: top.exact,
    also: ranked.slice(1)
      .filter(r => top.score - r.score <= ALSO_CHECK_BAND)
      .map(r => r.entry)
  };
}

// Choose the curated entries that best match the question.
function selectKb(question) {
  const result = search(question);
  if (!result || !result.matched) return [];
  return [result.entry].concat(result.also || []).slice(0, CONFIG.maxKb);
}

/* ---------------------------------------------------------------------
   5. PROXY CALL
   --------------------------------------------------------------------- */
function aiEndpointUrl(params) {
  if (!CONFIG.aiEndpoint) return null;
  const url = new URL(CONFIG.aiEndpoint);
  Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
  return url.toString();
}

// JSONP: Apps Script redirects break CORS, so a <script> tag is used.
function jsonp(url, timeoutMs) {
  return new Promise(resolve => {
    const name = '__nciAi' + Date.now() + '_' + (aiSeq++);
    const script = document.createElement('script');
    let done = false;

    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { delete window[name]; } catch (e) { window[name] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs || AI_TIMEOUT_MS);
    window[name] = data => finish(data);
    script.onerror = () => finish(null);
    script.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + name;
    document.head.appendChild(script);
  });
}

async function askAI(question, sources, kb, qid) {
  const history = Array.isArray(CONVERSATION.history) ? CONVERSATION.history.slice(-CONFIG.historyTurns) : [];
  const url = aiEndpointUrl({
    q: scrub(question).slice(0, 500),
    sources: JSON.stringify(sources.map(s => ({ title: s.title, url: s.url }))),
    kb: JSON.stringify((kb || []).map(e => ({ question: e.question, answer: e.answer }))),
    history: JSON.stringify(history),
    qid: qid || '',
    sid: SESSION_ID,
    device: deviceType()
  });
  if (!url) return null;

  let payload = null;
  try { payload = await jsonp(url); } catch (e) { payload = null; }
  if (!payload) {
    // A transient 400 from Google is worth one retry with a fresh URL.
    await new Promise(resolve => setTimeout(resolve, 1200));
    try { payload = await jsonp(bustUrl(url)); } catch (e) { payload = null; }
  }
  if (!payload) return null;
  if (payload.ok !== true) {
    return {
      answer: '',
      sources: [],
      error: payload.error || 'proxy error',
      logged: payload.logged === true
    };
  }
  if (payload.answered !== true) {
    return { answer: '', sources: [], refused: true, logged: payload.logged === true };
  }
  if (typeof payload.answer !== 'string' || !payload.answer.trim()) return null;

  const allowed = new Set(sources.map(s => s.url));
  const used = (Array.isArray(payload.sources) ? payload.sources : [])
    .filter(s => s && allowed.has(s.url))
    .map(s => ({ title: s.title || 'Official NCI page', url: s.url }));

  return {
    answer: payload.answer.trim(),
    sources: used,
    model: payload.model,
    logged: payload.logged === true
  };
}

/* ---------------------------------------------------------------------
   5b. ANONYMOUS RECORDING
   --------------------------------------------------------------------- */
// Fire-and-forget beacons to the proxy. They never block the chat and never
// carry personal data - just an anonymous session id and a device type.
// A unique _t parameter is appended so Google never serves a cached response
// for a repeated URL (which would skip re-running the logger).
function bustUrl(url) {
  return url + (url.indexOf('?') === -1 ? '?' : '&') + '_t=' +
    Date.now() + Math.random().toString(36).slice(2, 8);
}

function beacon(params, attempt) {
  const url = aiEndpointUrl(params);
  if (!url) return;
  const tries = attempt || 0;
  // JSONP <script> is the transport Google accepts from the site. Google can
  // briefly return a 400 when several requests arrive at once, so retry a
  // couple of times after a pause, with a fresh URL.
  jsonp(bustUrl(url), 8000).then(res => {
    if (!res && tries < 2) {
      setTimeout(() => beacon(params, tries + 1), 1500 * (tries + 1));
    }
  }).catch(() => {});
}

function recordVisit() {
  beacon({ mode: 'visit', sid: SESSION_ID, device: deviceType() });
}

function logQuestion(question, answered, qid, answer, sources, model, error) {
  beacon({
    mode: 'log',
    q: scrub(question).slice(0, 200),
    answered: answered ? 'true' : 'false',
    qid: qid,
    sid: SESSION_ID,
    answer: scrubAnswer(answer).slice(0, 1000),
    sources: JSON.stringify((sources || []).map(s => ({ title: s.title, url: s.url }))),
    model: String(model || ''),
    error: String(error || '')
  });
}

function sendFeedback(qid, question, helpful) {
  beacon({ mode: 'feedback', qid: qid, helpful: helpful ? 'true' : 'false', q: scrub(question).slice(0, 200), sid: SESSION_ID });
}

// Send the whole survey in ONE beacon. Four rapid requests would risk Google's
// abuse throttle, so we batch the answers into a single call.
function sendSurvey() {
  const payload = {
    mode: 'survey',
    qid: SURVEY.qid,
    q: scrub(SURVEY.question).slice(0, 200),
    sid: SESSION_ID,
    device: deviceType()
  };
  CONFIG.surveyQuestions.forEach(q => { payload[q.id] = SURVEY.answers[q.id] || ''; });
  beacon(payload);
}

// Sequential satisfaction survey: asks one question at a time, advances after
// each answer, then sends all answers together. Shown once per browser session.
function appendSurvey(bubble, qid, question) {
  if (!CONFIG.surveyEnabled || SURVEY.done) return;
  SURVEY.done = true;
  try { sessionStorage.setItem('nciAssistantSurveyDone', '1'); } catch (e) {}
  SURVEY.qid = qid;
  SURVEY.question = question;
  SURVEY.answers = {};
  SURVEY.index = 0;

  const card = document.createElement('div');
  card.className = 'survey-card';
  const title = document.createElement('div');
  title.className = 'survey-title';
  title.textContent = 'Quick check';
  const progress = document.createElement('div');
  progress.className = 'survey-progress';
  const body = document.createElement('div');
  body.className = 'survey-body';
  card.appendChild(title);
  card.appendChild(progress);
  card.appendChild(body);
  bubble.appendChild(card);

  function step(i) {
    SURVEY.index = i;
    progress.textContent = (i + 1) + ' of ' + CONFIG.surveyQuestions.length;
    body.textContent = '';

    const q = CONFIG.surveyQuestions[i];
    const wrap = document.createElement('div');
    wrap.className = 'survey-q';
    const label = document.createElement('div');
    label.className = 'survey-q-label';
    label.textContent = q.label;
    const opts = document.createElement('div');
    opts.className = 'survey-opts';

    let answered = false;
    const make = (symbol, text, yes) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fb-btn ' + (yes ? 'fb-up' : 'fb-down');
      btn.setAttribute('aria-label', text);
      btn.title = text;
      btn.textContent = symbol;
      btn.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        SURVEY.answers[q.id] = yes ? 'yes' : 'no';
        opts.querySelectorAll('.fb-btn').forEach(b => { b.disabled = true; });
        btn.classList.add('is-chosen');
        setTimeout(() => {
          if (i + 1 < CONFIG.surveyQuestions.length) step(i + 1);
          else finish();
        }, 400);
      });
      return btn;
    };
    opts.appendChild(make('\u{1F44D}', 'Yes', true));
    opts.appendChild(make('\u{1F44E}', 'No', false));
    wrap.appendChild(label);
    wrap.appendChild(opts);
    body.appendChild(wrap);
  }

  function finish() {
    card.classList.add('is-done');
    progress.textContent = '';
    body.textContent = '';
    const thanks = document.createElement('div');
    thanks.className = 'survey-thanks';
    thanks.textContent = 'Thanks \u2014 that helps NCI improve.';
    body.appendChild(thanks);
    sendSurvey();
  }

  step(0);
}

/* ---------------------------------------------------------------------
   6. DISTRESS / WELLBEING
   --------------------------------------------------------------------- */
const DISTRESS_PATTERNS = [
  /\bkill(ing)? myself\b/, /\bsuicid/, /\bself[- ]harm/, /\bend(ing)? my life\b/,
  /\boverdose\b/, /\bhurt myself\b/, /\bcan'?t go on\b/, /\bno reason to live\b/,
  /\bwant to die\b/, /\bhope to die\b/,
  /\bstress(ed|ful|ing)?\b/, /\boverwhelm(ed|ing)?\b/, /\banx(ious|iety)\b/,
  /\bdepress(ed|ion)?\b/, /\bpanic\b/, /\bburn(ed|t)? out\b/, /\bnot coping\b/,
  /\bstruggling\b/, /\bmental health\b/, /\bhopeless\b/, /\blonely\b/, /\bisolated\b/,
  /\bcan'?t sleep\b/, /\bcannot sleep\b/, /\bexhausted\b/
];

function isDistressed(text) {
  const q = String(text || '').toLowerCase();
  return DISTRESS_PATTERNS.some(re => re.test(q));
}

/* ---------------------------------------------------------------------
   7. RENDERING
   --------------------------------------------------------------------- */

// Inline markdown to safe DOM nodes (bold, code, links). Never innerHTML.
function renderInline(parent, text) {
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] && m[2]) {
      if (isOfficialUrl(m[2])) {
        const a = document.createElement('a');
        a.href = m[2]; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = m[1];
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(m[1]));
      }
    } else if (m[3]) {
      if (isOfficialUrl(m[3])) {
        const a = document.createElement('a');
        a.href = m[3]; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = m[3];
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(m[3]));
      }
    } else if (m[4]) {
      const b = document.createElement('strong'); b.textContent = m[4]; parent.appendChild(b);
    } else if (m[5]) {
      const c = document.createElement('code'); c.textContent = m[5]; parent.appendChild(c);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// Block markdown: headings, bullet/numbered lists, paragraphs.
function renderRichText(container, text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let i = 0;
  const isBullet = l => /^\s*[-*\u2022]\s+/.test(l);
  const isNumber = l => /^\s*\d+[.)]\s+/.test(l);
  const isHead = l => /^\s*#{1,6}\s+/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (isBullet(line)) {
      const ul = document.createElement('ul');
      while (i < lines.length && isBullet(lines[i])) {
        const li = document.createElement('li');
        renderInline(li, lines[i].replace(/^\s*[-*\u2022]\s+/, ''));
        ul.appendChild(li); i++;
      }
      container.appendChild(ul); continue;
    }

    if (isNumber(line)) {
      const ol = document.createElement('ol');
      while (i < lines.length && isNumber(lines[i])) {
        const li = document.createElement('li');
        renderInline(li, lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        ol.appendChild(li); i++;
      }
      container.appendChild(ol); continue;
    }

    if (isHead(line)) {
      const h = document.createElement('h3');
      renderInline(h, line.replace(/^\s*#{1,6}\s+/, ''));
      container.appendChild(h); i++; continue;
    }

    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() && !isBullet(lines[i]) && !isNumber(lines[i]) && !isHead(lines[i])) {
      para.push(lines[i]); i++;
    }
    const p = document.createElement('p');
    renderInline(p, para.join(' '));
    container.appendChild(p);
  }
}

function appendUserMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'msg msg-user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const p = document.createElement('p');
  p.textContent = text;
  bubble.appendChild(p);
  msg.appendChild(bubble);
  els.chat.appendChild(msg);
  scrollToBottom();
}

function appendAssistantBubble() {
  const msg = document.createElement('div');
  msg.className = 'msg msg-assistant';
  const avatar = document.createElement('div');
  avatar.className = 'avatar'; avatar.textContent = 'NCI';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  msg.appendChild(avatar); msg.appendChild(bubble);
  els.chat.appendChild(msg);
  return bubble;
}

function appendAssistantText(text, sources) {
  const bubble = appendAssistantBubble();
  renderRichText(bubble, text);
  appendSources(bubble, sources);
  scrollToBottom();
}

function appendSources(bubble, sources) {
  if (!Array.isArray(sources) || !sources.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'answer-sources';
  const label = document.createElement('span');
  label.className = 'answer-sources-label';
  label.textContent = sources.length > 1 ? 'Official NCI sources' : 'Official NCI source';
  wrap.appendChild(label);
  sources.forEach(s => {
    const a = document.createElement('a');
    a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = s.title;
    wrap.appendChild(a);
  });
  bubble.appendChild(wrap);
}

function appendSupportCard(bubble) {
  const card = document.createElement('div');
  card.className = 'support-card';
  const t = document.createElement('strong');
  t.textContent = 'If you are struggling, you are not alone.';
  const p = document.createElement('p');
  p.textContent = 'NCI\'s Student Counselling and Wellness Service offers free, confidential support. ';
  const a = document.createElement('a');
  a.href = CONFIG.wellbeingUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = 'Get in touch with the service \u2197';
  p.appendChild(a);
  card.appendChild(t); card.appendChild(p);
  bubble.appendChild(card);
}

// "Was this helpful?" thumbs under an answer. Records the rating anonymously
// against the question id so the daily report can show whether answers helped.
function appendFeedback(bubble, qid, question) {
  const wrap = document.createElement('div');
  wrap.className = 'answer-feedback';
  const label = document.createElement('span');
  label.className = 'answer-feedback-label';
  label.textContent = 'Did this help?';
  wrap.appendChild(label);

  let done = false;
  const make = (cls, symbol, text, helpful) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fb-btn ' + cls;
    btn.setAttribute('aria-label', text);
    btn.title = text;
    btn.textContent = symbol;
    btn.addEventListener('click', () => {
      if (done) return;
      done = true;
      sendFeedback(qid, question, helpful);
      wrap.querySelectorAll('.fb-btn').forEach(b => { b.disabled = true; });
      btn.classList.add('is-chosen');
      label.textContent = 'Thanks for the feedback';
    });
    return btn;
  };
  wrap.appendChild(make('fb-up', '\u{1F44D}', 'This helped', true));
  wrap.appendChild(make('fb-down', '\u{1F44E}', 'This was not helpful', false));
  bubble.appendChild(wrap);
}

function showTyping() {
  const msg = document.createElement('div');
  msg.className = 'msg msg-assistant typing';
  const avatar = document.createElement('div');
  avatar.className = 'avatar'; avatar.textContent = 'NCI';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('span');
    d.className = 'dot';
    bubble.appendChild(d);
  }
  msg.appendChild(avatar); msg.appendChild(bubble);
  els.chat.appendChild(msg);
  scrollToBottom();
  return msg;
}

function scrollToBottom() {
  try { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, document.body.scrollHeight); }
}

function setStatus(online) {
  if (!els.statusChip) return;
  els.statusChip.classList.toggle('is-offline', !online);
  els.statusText.textContent = online ? 'Online' : 'Offline';
}

/* ---------------------------------------------------------------------
   8. CONVERSATION FLOW
   --------------------------------------------------------------------- */
let busy = false;

async function sendMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || busy) return;
  busy = true;
  els.send.disabled = true;

  appendUserMessage(text);
  if (els.input) { els.input.value = ''; autoGrowInput(); }

  const qid = newId('q');
  const typing = showTyping();
  const sources = selectSources(text);
  const kb = selectKb(text);
  const ai = await askAI(text, sources, kb, qid);
  if (typing && typing.parentNode) typing.parentNode.removeChild(typing);

  const offlineMessage = 'Sorry, I could not reach the NCI assistant just now. ' +
    'Please check your connection and try again, or contact the NCI Support Hub: ' + CONFIG.supportHubUrl;
  const refusalMessage = 'I don\'t have enough verified information to answer that one confidently, so I won\'t guess.\n\n' +
    'You can find the answer on the NCI Support Hub, or ask Student Services directly.';

  if (ai === null) {
    const bubble = appendAssistantBubble();
    renderRichText(bubble, offlineMessage);
    appendSurvey(bubble, qid, text);
    logQuestion(text, false, qid, offlineMessage, [], '', 'network error');
  } else if (ai.error) {
    const bubble = appendAssistantBubble();
    renderRichText(bubble, offlineMessage);
    appendSurvey(bubble, qid, text);
    if (!ai.logged) logQuestion(text, false, qid, offlineMessage, [], '', ai.error);
  } else if (ai.refused) {
    const bubble = appendAssistantBubble();
    renderRichText(bubble, refusalMessage);
    appendSources(bubble, state.sources.filter(s => s.id === 'support-hub' || s.id === 'student-services'));
    appendSurvey(bubble, qid, text);
    if (!ai.logged) logQuestion(text, false, qid, refusalMessage, [], '', 'refused');
  } else {
    const bubble = appendAssistantBubble();
    renderRichText(bubble, ai.answer);
    appendSources(bubble, ai.sources);
    if (isDistressed(text)) appendSupportCard(bubble);
    appendFeedback(bubble, qid, text);
    appendSurvey(bubble, qid, text);
    scrollToBottom();
    if (!ai.logged) logQuestion(text, true, qid, ai.answer, ai.sources, ai.model, '');

    // Record the turn for conversational context (scrubbed, trimmed).
    CONVERSATION.history.push({ role: 'user', content: scrub(text).slice(0, 300) });
    CONVERSATION.history.push({ role: 'assistant', content: ai.answer.slice(0, 500) });
    if (CONVERSATION.history.length > CONFIG.historyTurns * 2) {
      CONVERSATION.history = CONVERSATION.history.slice(-CONFIG.historyTurns);
    }
  }

  busy = false;
  els.send.disabled = false;
  if (els.input) els.input.focus();
}

/* ---------------------------------------------------------------------
   9. INPUT BEHAVIOUR
   --------------------------------------------------------------------- */
function autoGrowInput() {
  const t = els.input;
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 150) + 'px';
}

/* ---------------------------------------------------------------------
   10. INIT
   --------------------------------------------------------------------- */
// The assistant is online as long as the proxy is configured. We deliberately
// do not probe the health endpoint on every load (it can be slow to respond and
// would flash a misleading "Offline" state). Delivery is confirmed per message
// instead: if a message fails to send, the student sees an inline retry message.
function healthCheck() {
  setStatus(!!CONFIG.aiEndpoint);
}

async function init() {
  if (els.form) {
    els.form.addEventListener('submit', e => {
      e.preventDefault();
      sendMessage(els.input ? els.input.value : '');
    });
  }

  if (els.input) {
    els.input.addEventListener('input', autoGrowInput);
    els.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(els.input.value);
      }
    });
  }

  try {
    await loadSources();
    // The knowledge base is the primary grounding; if it fails to load we still
    // answer from the live official sources, so this is not fatal.
    try { await loadKnowledge(); } catch (e) { /* continue with sources only */ }
    state.ready = true;
  } catch (e) {
    appendAssistantText(
      'I could not load my list of official NCI sources, so I cannot answer right now. Please refresh the page, or go directly to the NCI website: https://www.ncirl.ie',
      []
    );
    if (els.send) els.send.disabled = true;
    setStatus(false);
    return;
  }

  healthCheck();

  // Record this visit anonymously (one row per page load).
  recordVisit();
}

document.addEventListener('DOMContentLoaded', init);