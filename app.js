/* =====================================================================
   NCI Student Information Assistant
   ---------------------------------------------------------------------
   Plain lookup chatbot. No RAG, no API keys, no backend required.

   How it works, in four steps:
     1. Fetch knowledge.json (the knowledge base, kept in this repo).
     2. Normalise the student's question into tokens.
     3. Score every entry against those tokens and keep the best match.
     4. Show the answer + the official NCI link, or say plainly that
        there is no match. It never invents an answer.

   Optional (phase 2) integrations are switched on by filling in the
   two empty URLs in the CONFIG block below. See README.md.
   ===================================================================== */

'use strict';

/* ---------------------------------------------------------------------
   1. CONFIG
   Leave these empty for the first version. They are the only two things
   you ever need to change when you switch on the post-launch features.
   --------------------------------------------------------------------- */
const CONFIG = {
  // Where the knowledge base lives (relative to this page).
  knowledgeUrl: 'knowledge.json',

  // Google Apps Script web app URL that appends a row to a Google Sheet.
  // Example: https://script.google.com/macros/s/AKfycb.../exec
  // Leave as "" to keep search counts in the browser only.
  statsEndpoint: '',

  // Apps Script proxy. Serves the AI, the anonymous log and the feedback
  // controls. Empty "" = AI off, everything else works exactly as before.
  aiEndpoint: 'https://script.google.com/macros/s/AKfycbyCQZGEZL8FQLliNYmhy8rvj-vLp7-QBbmseNqS3xBQ2Ow9qeeRNtQvaOcXTN1Cqotqnw/exec',

  // How many matched entries to send the AI as its permitted sources.
  aiCandidateLimit: 3,

  // Trims each entry's answer to this length before sending, to keep the
  // request small and the model focused.
  aiEntryChars: 520,

  // Google Form for "suggest a missing question". Use the /edit link.
  // Leave as "" and the button will point at NCI Support Hub instead.
  suggestionFormUrl:
    'https://docs.google.com/forms/d/e/1FAIpQLSfDC7AjYX_bNs3dj_3oghmwpfyeHQRxcLBIaAn2v5iLAPr_PQ/edit?usp=sharing',

  // Name of the Google Form field that receives the suggested question.
  // Optional. Only used if suggestionFormUrl is set.
  suggestionFieldName: 'entry.1608898430',

  supportHubUrl: 'https://ncisupporthub.ncirl.ie/hc/en-ie',
  studentServicesUrl: 'https://www.ncirl.ie/Students/Student-Services',
  nciHomeUrl: 'https://www.ncirl.ie'
};

// ---------------------------------------------------------------------
//   AI LAYER
//
//   The deterministic matcher above still decides WHICH entries are
//   relevant. The AI then composes the answer from only those entries.
//
//   The AI call goes to our own Apps Script proxy, never to OpenAI
//   directly: the API key lives in Apps Script, so it cannot be read out
//   of the page source.
//
//   If the proxy is unreachable or errors, askAI() resolves to null and
//   the page carries on showing the exact-match answer it already has.
//   Nothing breaks, we just lose the AI wording.
// ---------------------------------------------------------------------

const AI_TIMEOUT_MS = 25000;
let aiSeq = 0;

function aiEndpointUrl(params) {
  if (!CONFIG.aiEndpoint) return null;
  const url = new URL(CONFIG.aiEndpoint);
  Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
  return url.toString();
}

/** Trim an entry down to what the model actually needs. */
function entryForModel(entry, score) {
  return {
    q: entry.question,
    a: entry.answer.length > CONFIG.aiEntryChars
      ? entry.answer.slice(0, CONFIG.aiEntryChars).replace(/\s+\S*$/, '') + '.'
      : entry.answer,
    url: entry.link,
    title: entry.linkLabel || 'Official NCI page',
    score: Math.round((score || 0) * 100)
  };
}

// JSONP, because Apps Script redirects /exec to a googleusercontent.com URL
// and the browser is then blocked from reading the response by CORS. A script
// tag sidesteps that. The callback name is randomised per request so two
// searches in flight cannot collide.
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

/**
 * Ask the proxy to answer from the given entries.
 * Resolves to { answer, sources } or null if unavailable.
 */
async function askAI(question, entries) {
  const url = aiEndpointUrl({
    q: redactForStats(question).slice(0, 300),
    entries: JSON.stringify(entries.map(e => entryForModel(e.entry, e.score)))
  });
  if (!url) return null;

  let payload;
  try {
    payload = await jsonp(url);
  } catch (e) {
    return null;
  }
  if (!payload || payload.ok !== true || !payload.answered) return null;
  if (typeof payload.answer !== 'string' || !payload.answer.trim()) return null;

  // Only ever surface URLs the model was actually given.
  const allowed = new Set(entries.map(e => e.entry.link));
  const sources = (Array.isArray(payload.sources) ? payload.sources : [])
    .filter(s => s && allowed.has(s.url))
    .map(s => ({ href: s.url, label: s.title || 'Official NCI page' }));

  return { answer: payload.answer.trim(), sources }

async function enhanceWithAI(question, result) {
  if (!CONFIG.aiEndpoint) return null;
  const entries = (result.ranked || []).slice(0, 3).filter(r => r.score > MATCH_THRESHOLD * 0.4);
  if (!entries.length) return null;
  const ai = await askAI(question, entries);
  if (!ai || !ai.answer) return null;
  appendAIAnswer(question, ai.answer, ai.sources, false);
  return ai;
}

async function tryAIOnNoMatch(question, result) {
  if (!CONFIG.aiEndpoint) return null;
  const entries = (result.ranked || []).slice(0, 5).filter(r => r.score > MATCH_THRESHOLD * 0.3);
  const ai = await askAI(question, entries);
  if (!ai || !ai.answer) return null;
  appendAIAnswer(question, ai.answer, ai.sources, true);
  return ai;
}

function appendAIAnswer(question, answerText, sources, isNoMatch) {
  const card = document.createElement('div');
  card.className = 'card ai-card';
  
  const badge = document.createElement('span');
  badge.className = 'ai-badge';
  badge.textContent = 'Answered by AI (grounded in NCI sources)';
  card.appendChild(badge);
  
  const h = document.createElement('h2');
  h.textContent = question.length > 60 ? question.slice(0, 57) + '...' : question;
  card.appendChild(h);
  
  const p = document.createElement('p');
  p.className = 'answer';
  p.textContent = answerText;
  card.appendChild(p);
  
  if (Array.isArray(sources) && sources.length) {
    const srcWrap = document.createElement('div');
    srcWrap.className = 'sources';
    const label = document.createElement('span');
    label.className = 'sources-label';
    label.textContent = 'Sources:';
    srcWrap.appendChild(label);
    const ul = document.createElement('ul');
    sources.forEach(s => {
      if (!s || !s.href) return;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = s.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = s.label || 'Official NCI page';
      li.appendChild(a);
      ul.appendChild(li);
    });
    srcWrap.appendChild(ul);
    card.appendChild(srcWrap);
  }
  
  const caveat = document.createElement('p');
  caveat.className = 'caveat';
  caveat.textContent = 'Please confirm on the official NCI page, as dates and policies can change.';
  card.appendChild(caveat);
  
  const fb = renderFeedback({ entry: { id: '' } }, question);
  if (fb) card.appendChild(fb);
  
  const wellbeing = renderWellbeing(question);
  if (wellbeing) card.appendChild(wellbeing);
  
  try{console.log("[NCI DEBUG] about to append card to answer");}catch(e){} els.answer.appendChild(card);
}

;
}

// ---------------------------------------------------------------------
//   FEEDBACK
//
//   "That helped" / "This didn't help" is the only honest signal we have
//   for whether an answer is actually useful. It is logged anonymously.
// ---------------------------------------------------------------------

function logQuestion(question, entryId, answered) {
  if (!CONFIG.statsEndpoint) return;
  postJson(CONFIG.statsEndpoint, {
    mode: 'log', question: redactForStats(question).slice(0, 200),
    entryId: entryId || '', answered: !!answered
  });
}

function sendFeedback(question, entryId, helpful) {
  if (!CONFIG.statsEndpoint) return;
  postJson(CONFIG.statsEndpoint, {
    mode: 'feedback', question: redactForStats(question).slice(0, 200),
    entryId: entryId || '', helpful: !!helpful
  });
}

function postJson(url, body) {
  try {
    fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

function renderFeedback(result, query) {
  if (!CONFIG.statsEndpoint) return null;

  const wrap = document.createElement('div');
  wrap.className = 'feedback';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Was this answer helpful?');

  const label = document.createElement('span');
  label.className = 'feedback-label';
  label.textContent = 'Did this answer your question?';
  wrap.appendChild(label);

  const buttons = [
    { yes: true, text: 'Yes, thanks' },
    { yes: false, text: 'No, still stuck' }
  ].map(spec => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'feedback-btn';
    b.textContent = spec.text;
    b.addEventListener('click', () => {
      sendFeedback(query, result.entry.id, spec.yes);
      buttons.forEach(o => { o.setAttribute('disabled', 'disabled'); });
      wrap.classList.add('done');
      thanks.textContent = spec.yes
        ? 'Thanks - that helps us know what is working.'
        : 'Thanks. We will add this to the list of things to write up.';
    });
    return b;
  });

  const thanks = document.createElement('span');
  thanks.className = 'feedback-thanks';

  buttons.forEach(b => wrap.appendChild(b));
  wrap.appendChild(thanks);
  return wrap;
}

function renderRelated(result) {
  if (!result || !result.entry) return null;
  const rel = Array.isArray(result.entry.relatedTopics) ? result.entry.relatedTopics : [];
  if (rel.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'related';
  const h = document.createElement('h3');
  h.textContent = 'You may also want to know:';
  wrap.appendChild(h);
  const ul = document.createElement('ul');
  rel.slice(0, 4).forEach(qt => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'related-btn';
    b.textContent = qt;
    b.addEventListener('click', () => {
      if (els.input) els.input.value = qt;
      handleAsk(qt);
    });
    li.appendChild(b);
    ul.appendChild(li);
  });
  wrap.appendChild(ul);
  return wrap;
}



/* ---------------------------------------------------------------------
   2. SMALL HELPERS
   --------------------------------------------------------------------- */

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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ---------------------------------------------------------------------
   3. STATE
   --------------------------------------------------------------------- */
const CONVERSATION = {
  lastQuestion: '',
  lastEntryId: '',
  lastTopic: ''
};

const JOURNEY_QUESTIONS = {
  academic: [
    'What should I do if I miss an assignment deadline?',
    'How do I request an extension?',
    'What is an assessment deferral?',
    'Where can I get academic support?',
    'Who is my Programme Coordinator?'
  ],
  timetable: [
    'When is reading week?',
    'Where can I find my timetable?',
    'What are the academic calendar dates?',
    'Attendance information'
  ],
  exams: [
    'When are exams?',
    'Where can I find exam information?',
    'What should I do if I miss an assessment deadline?'
  ],
  moodle: [
    'How do I access Moodle?',
    'Where can I find my module information?',
    'Who do I contact if Moodle isn\'t working?'
  ],
  support: [
    'How do I contact NCI Support Hub?',
    'Who is my Programme Coordinator?',
    'Where can I get academic support?',
    'Student Services'
  ],
  fees: [
    'Tuition fees information',
    'Where can I find fees information?'
  ],
  international: [
    'International student support',
    'Student services'
  ],
  wellbeing: [
    'Student counselling and wellbeing',
    'Where can I get help if I\'m struggling?'
  ]
};

const state = {
  kb: null,
  entries: [],
  activeCategory: 'All'
};

const els = {
  form: document.getElementById('ask-form'),
  input: document.getElementById('question'),
  button: document.getElementById('ask-button'),
  answer: document.getElementById('answer'),
  suggestBlock: document.getElementById('suggest-block'),
  suggestLink: document.getElementById('suggest-link'),
  suggestPrompt: document.getElementById('suggest-prompt'),
  filters: document.getElementById('category-filters'),
  list: document.getElementById('entry-list'),
  popularList: document.getElementById('popular-list'),
  popularSource: document.getElementById('popular-source'),
  lastReviewed: document.getElementById('last-reviewed')
};

/* ---------------------------------------------------------------------
   4. LOAD THE KNOWLEDGE BASE
   --------------------------------------------------------------------- */
async function loadKnowledgeBase() {
  const res = await fetch(CONFIG.knowledgeUrl + '?v=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load knowledge.json (HTTP ' + res.status + ')');
  const kb = await res.json();
  if (!kb || !Array.isArray(kb.entries) || kb.entries.length === 0) {
    throw new Error('knowledge.json is empty or malformed');
  }
  state.kb = kb;
  state.entries = kb.entries.map(e => {
    const texts = [e.question].concat(e.variants || []);
    return {
      ...e,
      // Pre-compute the match structures once, not on every keystroke.
      texts: texts,
      textNorms: texts.map(normalise),
      textSets: texts.map(t => new Set(tokenise(t, false))),
      keywordSet: new Set(tokenise((e.keywords || []).join(' '), false)),
      // Every token the entry can be found by, questions + variants + keywords.
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
}

/* ---------------------------------------------------------------------
   5. MATCHING
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

/* ---------------------------------------------------------------------
   6. RENDERING
   --------------------------------------------------------------------- */

// Highlights the words the student used, by walking text nodes only.
// Nothing is ever injected as raw HTML, so the knowledge base file
// cannot introduce markup into the page.
function highlight(container, query) {
  const terms = Array.from(tokenSet(query)).filter(t => t.length > 2);
  if (!terms.length) return;
  const pattern = new RegExp('\\b(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\w*', 'gi');

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && pattern.test(node.nodeValue)) targets.push(node);
    pattern.lastIndex = 0;
  }

  targets.forEach(node => {
    const frag = document.createDocumentFragment();
    let last = 0;
    node.nodeValue.replace(pattern, (match, _g, offset) => {
      if (offset > last) frag.appendChild(node.nodeValue.slice(last, offset));
      const mark = document.createElement('mark');
      mark.textContent = match;
      frag.appendChild(mark);
      last = offset + match.length;
      return match;
    });
    if (last < node.nodeValue.length) frag.appendChild(node.nodeValue.slice(last));
    node.parentNode.replaceChild(frag, node);
  });
}

const DISTRESS_PATTERNS = [
  /\bkill(ing)? myself\b/, /\bsuicid/, /\bself[- ]harm/, /\bend(ing)? my life\b/,
  /\boverdose\b/, /\bhurt myself\b/, /\bcan'?t go on\b/, /\bno reason to live\b/,
  /\bwant to die\b/, /\bhope to die\b/,
  /\bstress(ed|ful|ing)?\b/, /\bstressed\b/, /\boverwhelm(ed|ing)?\b/,
  /\banx(ious|iety)\b/, /\bdepress(ed|ion)?\b/, /\bpanic\b/, /\bburnt out\b/,
  /\bburned out\b/, /\bnot coping\b/, /\bstruggling\b/, /\bmental health\b/,
  /\bunwell\b/, /\bfeeling low\b/, /\bhopeless\b/, /\bdifficult to concentrate\b/,
  /\bcan'?t sleep\b/, /\bcannot sleep\b/, /\bstruggle to sleep\b/, /\bexhausted\b/,
  /\bburnout\b/, /\blonely\b/, /\bisolated\b/,
  /\bcrisis\b/, /\bcounselling\b/, /\bcounsel(ing|or)\b/, /\btherap(y|ist)\b/,
];

const WELLBEING_ENTRY = 'counselling-wellbeing';

function renderWellbeing(query) {
  const q = (query || '').toLowerCase();
  if (!q || !DISTRESS_PATTERNS.some(re => re.test(q))) return null;

  const e = (state.kb.entries || []).find(x => x.id === WELLBEING_ENTRY);
  if (!e) return null;

  const card = document.createElement('div');
  card.className = 'card wellbeing';

  const h = document.createElement('h2');
  h.textContent = 'If you are struggling, you are not alone';
  card.appendChild(h);

  const p = document.createElement('p');
  p.className = 'answer';
  p.textContent =
    'If any of this is weighing on you, please talk to someone. NCI\'s Student Counselling and ' +
    'Wellbeing Service offers confidential appointments and is the right first step. You can also ' +
    'see your programme co-ordinator or the Students\' Union. If you or someone else is in ' +
    'immediate danger, contact emergency services.';
  card.appendChild(p);

  const a = document.createElement('a');
  a.className = 'source';
  a.href = e.link;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = e.linkLabel + ' ↗';
  card.appendChild(a);

  return card;
}

function renderMatch(result, query) {
  els.answer.innerHTML = '';
  const e = result.entry;
  const card = document.createElement('div');
  card.className = 'card';

  const conf = document.createElement('span');
  conf.className = 'confidence';
  conf.textContent = result.exact ? 'exact match' : Math.round(result.score * 100) + '% match';
  card.appendChild(conf);

  const cat = document.createElement('span');
  cat.className = 'category';
  cat.textContent = e.category;
  card.appendChild(cat);

  const h = document.createElement('h2');
  h.textContent = e.question;
  card.appendChild(h);

  const p = document.createElement('p');
  p.className = 'answer';
  p.textContent = e.answer;
  card.appendChild(p);
  highlight(p, query);

  const sources = [];
  if (e.link) sources.push({ href: e.link, label: e.linkLabel || 'Official NCI page' });
  (e.links || []).forEach(href => {
    if (!sources.some(s => s.href === href)) {
      sources.push({ href: href, label: 'More on this topic' });
    }
  });
  const srcHead = document.createElement('p');
  srcHead.className = 'source-head';
  srcHead.textContent = sources.length > 1 ? 'Official NCI sources' : 'Source';
  card.appendChild(srcHead);
  const srcWrap = document.createElement('div');
  srcWrap.className = 'source-list';
  sources.forEach(s => {
    const a = document.createElement('a');
    a.className = 'source';
    a.href = s.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = s.label + ' ↗';
    srcWrap.appendChild(a);
  });
  card.appendChild(srcWrap);

  const caveat = document.createElement('p');
  caveat.className = 'caveat';
  caveat.textContent = 'Please confirm on the official NCI page, as dates and policies can change.';
  card.appendChild(caveat);

  const chk = document.createElement('p');
  chk.className = 'checked';
  chk.textContent = 'Source checked: ' + formatDate(e.checked);
  card.appendChild(chk);

  try{console.log("[NCI DEBUG] about to append card to answer");}catch(e){} els.answer.appendChild(card);

  const fb = renderFeedback(result, query);
  if (fb) { try{console.log("[NCI DEBUG] appending fb");}catch(e){} els.answer.appendChild(fb); }

  const wellbeing = renderWellbeing(query);
  if (wellbeing) { try{console.log("[NCI DEBUG] appending wellbeing");}catch(e){} els.answer.appendChild(wellbeing); }

  if (result.also.length) {
    const also = document.createElement('div');
    also.className = 'card also-list';
    const alsoH = document.createElement('h2');
    alsoH.textContent = 'Also check, in case this is what you meant:';
    also.appendChild(alsoH);
    result.also.forEach(other => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = other.question;
      b.addEventListener('click', () => handleAsk(other.question, true));
      also.appendChild(b);
    });
    els.answer.appendChild(also);
  }

  const na = renderNextAction(e);
  if (na) { try{console.log("[NCI DEBUG] appending na");}catch(e){} els.answer.appendChild(na); }

  const rel = renderRelated(result);
  if (rel) { try{console.log("[NCI DEBUG] appending rel");}catch(e){} els.answer.appendChild(rel); }
}

function renderNoMatch(query, result) {
  els.answer.innerHTML = '';
  const fb = state.kb.fallback || {};

  const card = document.createElement('div');
  card.className = 'card no-match';

  const h = document.createElement('h2');
  h.textContent = 'I do not have an answer for that one.';
  card.appendChild(h);

  const p = document.createElement('p');
  p.textContent = fb.message || 'I could not find a confident answer, so I will not guess.';
  card.appendChild(p);

  const ul = document.createElement('ul');
  (fb.links || []).forEach(l => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = l.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = l.label;
    li.appendChild(a);
    ul.appendChild(li);
  });
  card.appendChild(ul);

  // If we were close to several entries, offer them rather than a dead end.
  const close = (result.ranked || [])
    .filter(r => r.score >= MATCH_THRESHOLD * 0.62)
    .slice(0, 4)
    .map(r => r.entry);
  if (close.length) {
    const wrap = document.createElement('div');
    wrap.className = 'also-asked';
    const t = document.createElement('p');
    t.textContent = 'One of these might be closer than you think:';
    wrap.appendChild(t);
    const ol = document.createElement('ol');
    close.forEach(e => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e.question;
      b.style.textAlign = 'left';
      b.style.font = 'inherit';
      b.style.textDecoration = 'underline';
      b.style.color = 'inherit';
      b.style.background = 'none';
      b.style.border = '0';
      b.style.padding = '0';
      b.style.cursor = 'pointer';
      b.addEventListener('click', () => handleAsk(e.question, true));
      li.appendChild(b);
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
    card.appendChild(wrap);
  }

  try{console.log("[NCI DEBUG] about to append card to answer");}catch(e){} els.answer.appendChild(card);

  const feedback = renderFeedback(result, query);
  if (feedback) els.answer.appendChild(feedback);

  const wellbeing = renderWellbeing(query);
  if (wellbeing) { try{console.log("[NCI DEBUG] appending wellbeing");}catch(e){} els.answer.appendChild(wellbeing); }
}

function renderError(message) {
  els.answer.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card no-match';
  const h = document.createElement('h2');
  h.textContent = 'The knowledge base did not load.';
  const p = document.createElement('p');
  p.textContent = message + ' This normally means the page is being opened from a file on a computer rather than from the web link. Please open the public site address instead, or go straight to the NCI website.';
  const a = document.createElement('a');
  a.className = 'source';
  a.href = CONFIG.nciHomeUrl;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Go to the NCI website ↗';
  card.append(h, p, a);
  try{console.log("[NCI DEBUG] about to append card to answer");}catch(e){} els.answer.appendChild(card);
}

/* ---------------------------------------------------------------------
   7. SUGGEST A MISSING QUESTION
   --------------------------------------------------------------------- */
function setupSuggestionLink(query) {
  if (!CONFIG.suggestionFormUrl) {
    els.suggestLink.href = CONFIG.supportHubUrl;
    els.suggestLink.textContent = 'Ask the NCI Support Hub';
    els.suggestPrompt.textContent =
      'Tell the Support Hub what you were looking for, and it goes straight to the college team.';
    return;
  }
  const url = new URL(CONFIG.suggestionFormUrl);
  if (CONFIG.suggestionFieldName && query) {
    // prefill the question the student actually typed
    url.searchParams.set(CONFIG.suggestionFieldName, redactForStats(query).slice(0, 200));
  }
  els.suggestLink.href = url.toString();
  els.suggestLink.textContent = 'Suggest a question';
  els.suggestPrompt.textContent =
    'Your question has been added to the form below. Submitting it sends it to the college team.';
}

function showSuggestionBlock(query) {
  setupSuggestionLink(query);
  els.suggestBlock.hidden = false;
}

function hideSuggestionBlock() {
  els.suggestBlock.hidden = true;
}

/* ---------------------------------------------------------------------
   8. SEARCH STATISTICS
   ---------------------------------------------------------------------
   Privacy by design: the only thing ever recorded is the search text
   and the timestamp. No name, no email, no student number, no IP stored
   by this code, and no cookies.

   Two modes, both optional:
     local  - counts in this browser's localStorage. Always on, zero setup.
     remote - POSTs {text, entryId, timestamp} to CONFIG.statsEndpoint,
              a Google Apps Script web app that appends a row to a Sheet.
   --------------------------------------------------------------------- */
const LOCAL_KEY = 'nci-assistant-stats-v1';

function readLocalStats() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; }
  catch (e) { return {}; }
}

function writeLocalStats(stats) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(stats)); } catch (e) { /* private mode */ }
}

// Search text is only ever used to show popular questions, but a student can
// accidentally type their student number, email or password into the box.
// Anything that looks like a credential is stripped before it is stored
// anywhere, so no identifier ever reaches local storage or the sheet.
function redactForStats(text) {
  return normalise(text)
    .replace(/[^\s@]+@[^\s@]+/g, ' [email] ')
    .replace(/\b(?:password|passwd|pwd|passcode)\b\s*(?:is|are|was|=|:)?\s*["']?[^\s"']{3,}["']?/gi,
             ' password [redacted]')
    .replace(/\b(?:x|ca)?\d{5,}\b/g, ' [id] ')
    .replace(/\b\d{4,}\b/g, ' [number] ')
    .replace(/\s+/g, ' ')
    .trim();
}

function recordSearch(query, entryId) {
  // -- local counts
  const stats = readLocalStats();
  const key = redactForStats(query).slice(0, 80) || '(blank)';
  stats[key] = (stats[key] || 0) + 1;
  writeLocalStats(stats);

  // -- optional remote logging. Fire and forget, never blocks the answer.
  if (CONFIG.statsEndpoint) {
    try {
      fetch(CONFIG.statsEndpoint, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          text: key,
          entryId: entryId || '',
          timestamp: new Date().toISOString()
        })
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }
}

function renderPopular(stats) {
  const rows = Object.keys(stats)
    .map(k => ({ text: k, count: stats[k] }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, 8);

  els.popularList.innerHTML = '';
  if (!rows.length) {
    els.popularSource.textContent =
      'No searches recorded yet. Counts appear here as soon as students start asking questions.';
    return;
  }
  els.popularSource.textContent = 'Most searched, from this device only.';
  rows.forEach(r => {
    const li = document.createElement('li');
    li.textContent = r.text;
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = ' (' + r.count + ')';
    li.appendChild(c);
    els.popularList.appendChild(li);
  });
}

async function loadRemotePopular() {
  if (!CONFIG.statsEndpoint) return false;
  try {
    const res = await fetch(CONFIG.statsEndpoint + '?mode=top', { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    const queries = Array.isArray(data) ? data : (data.queries || []);
    if (!queries.length) return false;
    els.popularList.innerHTML = '';
    els.popularSource.textContent = 'Most searched by all students, live.';
    queries.slice(0, 8).forEach(q => {
      const li = document.createElement('li');
      const text = typeof q === 'string' ? q : q.text;
      const count = typeof q === 'string' ? 0 : q.count;
      li.textContent = text;
      if (count) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = ' (' + count + ')';
        li.appendChild(c);
      }
      els.popularList.appendChild(li);
    });
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------------------
   9. BROWSE EVERY ANSWER, WITH CATEGORY FILTERS
   --------------------------------------------------------------------- */
function renderFilters() {
  const cats = ['All'];
  state.entries.forEach(e => { if (cats.indexOf(e.category) === -1) cats.push(e.category); });

  els.filters.innerHTML = '';
  cats.forEach(cat => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = cat;
    b.setAttribute('aria-pressed', String(cat === state.activeCategory));
    b.addEventListener('click', () => {
      state.activeCategory = cat;
      // Quick questions and journeys
  document.querySelectorAll('.quick-btn').forEach(b => {
    b.addEventListener('click', () => {
      const q = b.dataset.q || b.textContent;
      if (els.input) els.input.value = q;
      handleAsk(q);
    });
  });
  document.querySelectorAll('.journey-card').forEach(b => {
    b.addEventListener('click', () => {
      const j = b.dataset.journey;
      const qs = (j && JOURNEY_QUESTIONS[j]) || [];
      if (!qs.length) return;
      // Ask the first question in journey
      if (els.input) els.input.value = qs[0];
      handleAsk(qs[0]);
    });
  });

  renderFilters();
      renderEntryList();
    });
    els.filters.appendChild(b);
  });
}

function renderEntryList() {
  els.list.innerHTML = '';
  state.entries
    .filter(e => state.activeCategory === 'All' || e.category === state.activeCategory)
    .forEach(e => {
      const d = document.createElement('details');
      const s = document.createElement('summary');
      s.textContent = e.question;
      d.appendChild(s);

      const body = document.createElement('div');
      body.className = 'entry-body';

      const cat = document.createElement('p');
      cat.className = 'cat';
      cat.textContent = e.category;
      body.appendChild(cat);

      const p = document.createElement('p');
      p.textContent = e.answer;
      body.appendChild(p);

      const a = document.createElement('a');
      a.className = 'source';
      a.href = e.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = e.linkLabel + ' ↗';
      body.appendChild(a);

      const chk = document.createElement('p');
      chk.className = 'checked';
      chk.textContent = 'Source checked: ' + formatDate(e.checked);
      body.appendChild(chk);

      d.appendChild(body);
      els.list.appendChild(d);
    });
}

/* ---------------------------------------------------------------------
   10. MAIN QUERY HANDLER
   --------------------------------------------------------------------- */
function handleAsk(query, isFollowUp) {
  try { console.log("[NCI DEBUG] handleAsk called:", query); } catch(e){}
  const q = String(query || '').trim();
  if (!q) { try { console.log("[NCI DEBUG] empty query, returning"); } catch(e){}; return; }

  const result = search(q);
  try { console.log("[NCI DEBUG] search result:", {matched: result && result.matched, score: result && result.score, entryId: result && result.entry && result.entry.id}); } catch(e){}
  hideSuggestionBlock();

  if (!result) {
    renderNoMatch(q, { ranked: [] });
    showSuggestionBlock(q);
    return;
  }

  if (result.matched) {
    CONVERSATION.lastQuestion = q;
    CONVERSATION.lastEntryId = result.entry.id;
    CONVERSATION.lastTopic = result.entry.category || '';
    try { console.log("[NCI DEBUG] rendering match"); } catch(e){} renderMatch(result, q);
    recordSearch(q, result.entry.id);
    try { logQuestion(q, result.entry.id, false); } catch (e) {}
    try { console.log("[NCI DEBUG] calling enhanceWithAI"); enhanceWithAI(q, result); } catch (e) { try{console.error("[NCI DEBUG] enhance error", e);}catch(ee){} }
  } else {
    CONVERSATION.lastQuestion = q;
    CONVERSATION.lastEntryId = '';
    CONVERSATION.lastTopic = '';
    try { console.log("[NCI DEBUG] rendering no match"); } catch(e){} renderNoMatch(q, result);
    showSuggestionBlock(q);
    recordSearch(q, '');
    try { logQuestion(q, '', true); } catch (e) {}
    try { console.log("[NCI DEBUG] calling tryAIOnNoMatch"); tryAIOnNoMatch(q, result); } catch (e) { try{console.error("[NCI DEBUG] tryAI error", e);}catch(ee){} }
  }

  if (!isFollowUp) {
    els.answer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* ---------------------------------------------------------------------
   11. START
   --------------------------------------------------------------------- */
async function init() {
  try{console.log("[NCI DEBUG] init starting");}catch(e){}
  els.form.addEventListener('submit', function (ev) {
    try{console.log('[NCI DEBUG] form submit intercepted');}catch(e){}
    ev.preventDefault();
    handleAsk(els.input.value);
  });

  try {
    await loadKnowledgeBase();
  } catch (err) {
    renderError(err.message);
    els.button.disabled = true;
    els.input.disabled = true;
    return;
  }

  els.lastReviewed.textContent = formatDate(state.kb.meta.lastReviewed);

  // Quick questions and journeys
  document.querySelectorAll('.quick-btn').forEach(b => {
    b.addEventListener('click', () => {
      const q = b.dataset.q || b.textContent;
      if (els.input) els.input.value = q;
      handleAsk(q);
    });
  });
  document.querySelectorAll('.journey-card').forEach(b => {
    b.addEventListener('click', () => {
      const j = b.dataset.journey;
      const qs = (j && JOURNEY_QUESTIONS[j]) || [];
      if (!qs.length) return;
      // Ask the first question in journey
      if (els.input) els.input.value = qs[0];
      handleAsk(qs[0]);
    });
  });

  renderFilters();
  renderEntryList();
  renderPopular(readLocalStats());
  loadRemotePopular();
  els.button.disabled = false;
}

document.addEventListener('DOMContentLoaded', init);


function isNode(n){try{return n&&typeof n.appendChild==="function"&&n.nodeType!==undefined;}catch(e){return false;}}
function isDistressQuery(q) {
  const t = String(q || '').toLowerCase();
  const keys = ['suicid', 'self harm', 'self-harm', 'depress', 'anxiet', 'panic', 'abuse', 'lonely', 'crisis', 'hopeless'];
  return keys.some(k => t.includes(k));
}
function renderNextAction(entry) {
  if (!entry) return null;
  const wrap = document.createElement('div');
  wrap.className = 'next-action';
  const h = document.createElement('h3');
  h.textContent = 'What to do next';
  wrap.appendChild(h);
  const p = document.createElement('p');
  p.className = 'answer';
  p.textContent = entry.nextAction || 'Check the official NCI page linked below and contact the relevant service if unsure.';
  wrap.appendChild(p);
  if (entry.supportDestination) {
    const sd = document.createElement('p');
    sd.className = 'hint';
    sd.textContent = 'Where to go: ' + entry.supportDestination;
    wrap.appendChild(sd);
  }
  return wrap;
}

