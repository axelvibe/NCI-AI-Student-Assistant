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

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those',
  'there', 'here', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as', 'of',
  'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'into', 'from', 'up',
  'down', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
  'must', 'please', 'want', 'need', 'like', 'know', 'tell', 'get',
  'nci', 'college', 'school', 'university', 'help',
  'where', 'when', 'what', 'how', 'who', 'why', 'which'
]);

function tokenise(text) {
  const out = [];
  for (const raw of normalise(text).split(' ')) {
    if (!raw || STOPWORDS.has(raw)) continue;
    out.push(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return out;
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
  state.knowledge = entries
    .filter(e => e && e.answer)
    .map(e => {
      const kw = new Set();
      (e.keywords || []).forEach(k => tokenise(k).forEach(t => kw.add(t)));
      (e.variants || []).forEach(v => tokenise(v).forEach(t => kw.add(t)));
      tokenise(e.question || '').forEach(t => kw.add(t));
      if (e.link) { try { state.allowedHosts.add(new URL(e.link).hostname.toLowerCase()); } catch (err) {} }
      return {
        id: e.id || '',
        question: e.question || '',
        answer: e.answer,
        link: e.link || '',
        linkLabel: e.linkLabel || e.title || '',
        title: e.title || e.linkLabel || '',
        kw: kw
      };
    });
}

// Choose the curated entries that best match the question.
function selectKb(question) {
  const qNorm = normalise(question);
  const qSet = new Set(tokenise(question));
  const scored = state.knowledge.map(e => {
    let score = 0;
    for (const t of qSet) if (e.kw.has(t)) score += 2;
    const qn = normalise(e.question);
    if (qn && qNorm.indexOf(qn) !== -1) score += 4;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(x => x.score >= 3).slice(0, CONFIG.maxKb).map(x => x.e);
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

async function askAI(question, sources, kb) {
  const history = Array.isArray(CONVERSATION.history) ? CONVERSATION.history.slice(-CONFIG.historyTurns) : [];
  const url = aiEndpointUrl({
    q: scrub(question).slice(0, 400),
    sources: JSON.stringify(sources.map(s => ({ title: s.title, url: s.url }))),
    kb: JSON.stringify((kb || []).map(e => ({ question: e.question, answer: e.answer }))),
    history: JSON.stringify(history)
  });
  if (!url) return null;

  let payload;
  try { payload = await jsonp(url); } catch (e) { return null; }
  if (!payload || payload.ok !== true) return null;
  if (payload.answered !== true) {
    return { answer: '', sources: [], refused: true };
  }
  if (typeof payload.answer !== 'string' || !payload.answer.trim()) return null;

  const allowed = new Set(sources.map(s => s.url));
  const used = (Array.isArray(payload.sources) ? payload.sources : [])
    .filter(s => s && allowed.has(s.url))
    .map(s => ({ title: s.title || 'Official NCI page', url: s.url }));

  return { answer: payload.answer.trim(), sources: used, model: payload.model };
}

/* ---------------------------------------------------------------------
   5b. ANONYMOUS RECORDING
   --------------------------------------------------------------------- */
// Fire-and-forget beacons to the proxy. They never block the chat and never
// carry personal data - just an anonymous session id and a device type.
// A unique _t parameter is appended so Google never serves a cached response
// for a repeated URL (which would skip re-running the logger).
function beacon(params) {
  const url = aiEndpointUrl(params);
  if (!url) return;
  const bust = url + (url.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now() + Math.random().toString(36).slice(2, 7);
  // Use the same JSONP transport as the AI call. Cross-origin no-cors fetch is
  // rejected by Google with a 400 for Apps Script web apps, while a <script>
  // request works. The response is ignored; this is fire-and-forget.
  jsonp(bust, 8000).catch(() => {});
}

function recordVisit() {
  beacon({ mode: 'visit', sid: SESSION_ID, device: deviceType() });
}

function logQuestion(question, answered, qid) {
  beacon({ mode: 'log', q: scrub(question).slice(0, 200), answered: answered ? 'true' : 'false', qid: qid, sid: SESSION_ID });
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

  const typing = showTyping();
  const sources = selectSources(text);
  const kb = selectKb(text);
  const ai = await askAI(text, sources, kb);
  if (typing && typing.parentNode) typing.parentNode.removeChild(typing);

  const qid = newId('q');

  if (ai === null) {
    const bubble = appendAssistantBubble();
    renderRichText(bubble,
      'Sorry, I could not reach the NCI assistant just now. Please check your connection and try again, or contact the NCI Support Hub: ' + CONFIG.supportHubUrl);
    appendSurvey(bubble, qid, text);
    logQuestion(text, false, qid);
  } else if (ai.refused) {
    const bubble = appendAssistantBubble();
    renderRichText(bubble,
      'I don\'t have enough verified information to answer that one confidently, so I won\'t guess.\n\n' +
      'You can find the answer on the NCI Support Hub, or ask Student Services directly.');
    appendSources(bubble, state.sources.filter(s => s.id === 'support-hub' || s.id === 'student-services'));
    appendSurvey(bubble, qid, text);
    logQuestion(text, false, qid);
  } else {
    const bubble = appendAssistantBubble();
    renderRichText(bubble, ai.answer);
    appendSources(bubble, ai.sources);
    if (isDistressed(text)) appendSupportCard(bubble);
    appendFeedback(bubble, qid, text);
    appendSurvey(bubble, qid, text);
    scrollToBottom();
    logQuestion(text, true, qid);

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