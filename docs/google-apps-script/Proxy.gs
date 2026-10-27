/**
 * NCI Student Assistant - AI proxy
 * ---------------------------------------------------
 * Add this file to the SAME Apps Script project as Code.gs.
 * Deploy once: it serves all three jobs.
 *
 *   1. Answers student questions with the OpenAI model, grounded on a list
 *      of OFFICIAL NCI source pages supplied by the browser (sources.json).
 *   2. Logs each question anonymously.
 *   3. Accepts "that helped / this didn't help" feedback.
 *
 * WHY A PROXY EXISTS
 * The OpenAI key lives here, in Apps Script, and never in app.js. Anything in
 * browser code is readable by anyone who views the page source, so a key placed
 * in the chatbot would be stolen and drained within minutes. The browser calls
 * this script; this script calls OpenAI.
 *
 * WHY JSONP (doGet + callback=) INSTEAD OF POST + fetch
 * Apps Script redirects /exec to a googleusercontent.com URL, which breaks CORS,
 * so the browser cannot read the response. A <script> tag with a JSONP callback
 * sidesteps CORS entirely. Requests are scrubbed and truncated before they
 * leave the browser, so nothing identifying is ever in the URL.
 *
 * SETUP
 *   1. Project Settings -> Show manifest files -> save.
 *   2. Run setup(), then deploy as a Web app: Execute as "Me",
 *      Who has access "Anyone".
 *   3. Put the OpenAI key in Script Properties (see below), NOT in this file.
 */

var MODEL = 'gpt-4o';
var MAX_SOURCES = 10;       // official source pages accepted per request
var HISTORY_TURNS = 8;      // previous messages used for conversational context
var QUESTION_CHARS = 500;
var MAX_TOKENS = 700;
var OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ON-DEMAND RAG: how many of the selected pages are fetched for real content.
var CONTEXT_SOURCES = 6;      // pages fetched per question (the best-ranked ones)
var CONTEXT_CHARS = 4500;     // characters of extracted text kept per page
var CONTEXT_TOTAL = 14000;    // characters of page content sent to the model
var CONTEXT_TTL = 10800;      // seconds to cache a fetched page (3 hours)

// Only these host suffixes may ever be fetched server-side (SSRF guard) or
// linked from an answer. Everything else in sources.json is display-only.
var FETCH_SUFFIXES = ['.ncirl.ie', '.ncisu.ie'];
var LINK_SUFFIXES = ['.ncirl.ie', '.ncisu.ie', 'myapps.microsoft.com'];

// Several NCI sites (WordPress front door, Zendesk) block requests that do not
// look like a normal browser, so page fetches send a browser-like User-Agent.
var BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';


// Digest tab for "what should we write next".
var DIGEST_SHEET = 'Needs content';

// Reporting tabs (kept separate so each one stays easy to read and pivot).
var SURVEY_SHEET = 'Survey responses';
var SURVEY_SUMMARY_SHEET = 'Survey summary';
var TOP_SHEET = 'Top questions';
var DASHBOARD_SHEET = 'Dashboard';
var REPORT_SHEET = 'Daily report';

// One survey question per row in "Survey summary". The ids must match app.js.
var SURVEY_QUESTIONS = [
  { id: 'resolved',  label: 'Was your problem resolved?' },
  { id: 'helpful',   label: 'Did you find it helpful?' },
  { id: 'recommend', label: 'Would you recommend it?' },
  { id: 'easy',      label: 'Was it easy to use?' }
];

var REPORT_HEADERS = ['date', 'visits', 'unique_sessions', 'questions', 'answered',
  'answered_%', 'helped', 'helped_%', 'not_helped', 'no_feedback', 'no_answer', 'surveys'];

var OPENAI_KEY_PROPERTY = 'OPENAI_API_KEY';

var SUPPORT_HUB = 'https://ncisupporthub.ncirl.ie/hc/en-ie';

var SYSTEM_PROMPT = [
  'You are the NCI Student Assistant for National College of Ireland (NCI), Dublin, Ireland.',
  'You help students and prospective students with anything about NCI and student life. Be warm, clear, concise and practical.',
  '',
  'SCOPE',
  '- Answer questions about NCI and student life: admissions and courses, registration and enrolment, fees and funding, Moodle and IT, assignments and assessment, exams and results, the library, referencing, careers and work placement, clubs and societies, support and wellbeing, campus services.',
  '- If a question is clearly unrelated to NCI or student life (for example general trivia, coding help, medical or legal advice, or another university), politely decline in one sentence and say you can only help with NCI and student questions. Do not answer off-topic questions.',
  '',
  'TRUTHFULNESS AND SOURCES',
  '- You may be given a CURATED KNOWLEDGE BASE of pre-written, verified NCI answers. If an entry matches the question, prefer it as the baseline truth and keep its facts exactly.',
  '- You are given a list of OFFICIAL NCI SOURCES (title + URL) and, for some of them, the EXTRACTED CONTENT of that page. Treat the extracted content as ground truth.',
  '- Answer from the extracted content whenever it covers the question: quote real dates, fees, times, entry requirements and steps that appear there.',
  '- Never invent dates, fees, deadlines, policies, room numbers, staff names, phone numbers or email addresses. If a specific detail is not in the extracted content and you are not confident it is correct, say you do not have that detail and point to the most relevant official source.',
  '- Only link to URLs that appear in the provided official source list. Never invent or guess a URL.',
  '- If the extracted content is empty or missing for a source, you only have its title, so do not guess what is on it - point the student there instead.',
  '- If you do not have enough information to answer, say so clearly and direct the student to the NCI Support Hub (' + SUPPORT_HUB + ').',
  '- For time-sensitive information (dates, fees, deadlines), add a brief reminder to confirm it on the official NCI page.',
  '',
  'STYLE',
  '- Keep answers short. Use a couple of short paragraphs or a few bullet points. No preamble, no restating the question, no sign-off.',
  '- Never ask for or repeat personal details (name, student number, email, password). Keep everything anonymous.',
  '- If the student seems distressed or in difficulty, gently and briefly point them to NCI\'s Student Counselling and Wellness Service.'
].join('\n');


/* ------------------------------------------------------------------ setup */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // If the Daily report still has its old, narrower header, clear its data rows
  // so the re-organised layout starts clean. (It is rebuilt from the raw logs.)
  var rep = ss.getSheetByName(REPORT_SHEET);
  if (rep) {
    var head = rep.getRange(1, 1, 1, Math.max(rep.getLastColumn(), 1)).getValues()[0].join('|');
    if (head !== REPORT_HEADERS.join('|')) {
      if (rep.getLastRow() >= 2) {
        rep.getRange(2, 1, rep.getLastRow() - 1, Math.max(rep.getLastColumn(), 1)).clearContent();
      }
    }
  }

  Object.keys(LOG_SHEETS).forEach(function (name) {
    ensureSheet(ss, name, LOG_SHEETS[name]);
  });

  Logger.log('Sheets ready: ' + Object.keys(LOG_SHEETS).join(', ') + '. ' +
             'Set the API key with setApiKey(), then run setupReporting() once ' +
             'to turn on the daily report email.');
}

/** Create a sheet with the given header row, or fix its header if it is missing
 *  or out of date. Data rows are never touched. */
function ensureSheet(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var current = sh.getRange(1, 1, 1, header.length).getValues()[0].join('\u0000');
  if (current !== header.join('\u0000')) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  }
  sh.setFrozenRows(1);
  return sh;
}

/** Run this ONCE from the editor. The key is stored in Script Properties,
 *  which are not part of the source file and not visible to anyone reading it. */
function setApiKey() {
  var key = Browser.inputBox(
    'Paste your OpenAI API key.\n\nIt is saved in Script Properties, not in code, ' +
    'and is not visible to anyone reading this project.');
  key = String(key || '').trim();
  if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
    throw new Error('That does not look like an OpenAI key. Nothing was saved.');
  }
  PropertiesService.getScriptProperties().setProperty(OPENAI_KEY_PROPERTY, key);
  Logger.log('Key saved. Delete this function from the project if you like.');
}

function hasApiKey() {
  return !!PropertiesService.getScriptProperties().getProperty(OPENAI_KEY_PROPERTY);
}

/* ------------------------------------------------------------------ doGet */

/** ?mode=health - check the deployment and the key without spending anything. */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var mode = p.mode || 'answer';
  try {
    if (mode === 'health') return json({
      ok: true,
      keyPresent: hasApiKey(),
      model: MODEL
    }, p.callback);
    if (mode === 'digest') return json({ ok: true, items: digest() }, p.callback);
    if (mode === 'visit') return json({ ok: true, recorded: recordVisit(p) }, p.callback);
    if (mode === 'log') return json({ ok: true, logged: logQuestion(p) }, p.callback);
    if (mode === 'feedback') return json({ ok: true, feedback: recordFeedback(p) }, p.callback);
    if (mode === 'survey') return json({ ok: true, survey: recordSurvey(p) }, p.callback);
    if (mode === 'report') return json({ ok: true, report: dailyReportText(p.date || yesterday()) }, p.callback);
    return answer(p, p.callback);
  } catch (err) {
    return json({ ok: false, error: String(err) }, (e.parameter && e.parameter.callback) || "");
  }
}

/* ----------------------------------------------------------------- doPost */

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    var data = JSON.parse(raw || '{}');
    if (data.mode === 'feedback') return json({ ok: true, feedback: recordFeedback(data) }, (e.parameter && e.parameter.callback) || "");
    if (data.mode === 'survey') return json({ ok: true, survey: recordSurvey(data) }, (e.parameter && e.parameter.callback) || "");
    if (data.mode === 'log') return json({ ok: true, logged: logQuestion(data) }, (e.parameter && e.parameter.callback) || "");
    if (data.mode === 'visit') return json({ ok: true, recorded: recordVisit(data) }, (e.parameter && e.parameter.callback) || "");
    return json({ ok: false, error: 'unknown mode' }, (e.parameter && e.parameter.callback) || "");
  } catch (err) {
    return json({ ok: false, error: String(err) }, (e.parameter && e.parameter.callback) || "");
  }
}

/* --------------------------------------------------------------- answering */

function answer(p, cb) {
  var question = scrub(String(p.q || '')).slice(0, QUESTION_CHARS);
  if (!question) return json({ ok: false, error: 'empty question' }, cb);

  var sources = parseSources(p.sources).slice(0, MAX_SOURCES);
  if (!sources.length) {
    // Nothing to ground on: answer honestly that we cannot verify right now.
    return json({ ok: true, answered: false, answer: '', reason: 'no sources' }, cb);
  }
  if (!hasApiKey()) {
    return json({ ok: false, error: 'no api key', fallback: true }, cb);
  }

  var history = parseHistory(p.history);
  var histLines = history.slice(-HISTORY_TURNS).map(function (x) {
    return (x.role || '') + ': ' + String(x.content || '').slice(0, 200);
  }).join('\n');

  var sourceList = sources.map(function (s, i) {
    return (i + 1) + '. ' + s.title + ' - ' + s.url;
  }).join('\n');

  // Curated, pre-verified answers from knowledge.json - the primary grounding.
  var kb = parseKb(p.kb);
  var kbBlock = kb.map(function (e) {
    return 'Q: ' + e.question + '\nA: ' + e.answer;
  }).join('\n\n');

  // Pull the actual text of the best-ranked pages so the answer can quote real
  // details (dates, fees, steps) instead of only linking to the page.
  var context = fetchContext(sources);
  var contentBlock = '';
  if (context.length) {
    var used = 0;
    var blocks = [];
    for (var i = 0; i < context.length && used < CONTEXT_TOTAL; i++) {
      var body = context[i].text.slice(0, CONTEXT_CHARS);
      if (!body) continue;
      used += body.length;
      var n = sourceNumber(sources, context[i].src.url);
      blocks.push((n ? 'SOURCE ' + n + ': ' : 'SOURCE: ') + context[i].src.title +
                  '\nURL: ' + context[i].src.url + '\nCONTENT:\n' + body);
    }
    if (blocks.length) contentBlock = blocks.join('\n\n');
  }

  var userMessage = [
    'OFFICIAL NCI SOURCES (the only URLs you may link to):',
    '',
    sourceList || '(none)',
    '',
    kbBlock ? 'CURATED KNOWLEDGE BASE (verified NCI answers - prefer these, they are the baseline truth):\n\n' + kbBlock + '\n\n' : '',
    contentBlock ? 'EXTRACTED PAGE CONTENT (copy facts from this):\n\n' + contentBlock + '\n\n' : '',
    (histLines ? 'CONVERSATION SO FAR:\n' + histLines + '\n' : ''),
    'STUDENT QUESTION:',
    question,
    '',
    'Answer the student. If a Curated Knowledge Base answer above fits the question, base your reply on it (reworded naturally for the chat) and cite its official source.',
    'If it is unrelated to NCI or student life, politely decline. If you do not have enough information, say so and point to the NCI Support Hub.'
  ].join('\n');

  var res = callOpenAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ]);

  if (!res.ok) return json({ ok: false, error: res.error, fallback: true }, cb);

  var text = String(res.text || '').trim();
  if (!text) return json({ ok: false, error: 'empty completion', fallback: true }, cb);

  return json({
    ok: true,
    answered: true,
    answer: text.slice(0, 3000),
    sources: citedSources(text, sources),
    model: MODEL
  }, cb);
}

// Position of a source in the numbered list shown to the model, so page content
// and the source list always use the same number.
function sourceNumber(sources, url) {
  for (var i = 0; i < sources.length; i++) {
    if (sources[i].url === url) return i + 1;
  }
  return '';
}

// Return only the provided sources the model actually referenced in its answer.
// If it cited none by URL, fall back to the first couple so the student still
// has an official link to check.
function citedSources(text, sources) {
  var lower = String(text || '');
  var used = sources.filter(function (s) {
    return lower.indexOf(s.url) !== -1;
  });
  if (!used.length) used = sources.slice(0, 2);
  return used.map(function (s) { return { title: s.title, url: s.url }; });
}

/* ------------------------------------------------------------- page context */

/**
 * Fetch the text of the best-ranked official pages so the model can answer with
 * real content (dates, fees, rules) instead of only a link.
 *
 * - Only hosts in FETCH_SUFFIXES are ever requested (no SSRF).
 * - Results are cached for CONTEXT_TTL seconds so repeated questions are fast.
 * - Failures are ignored: a page that will not load simply produces no context.
 */
function fetchContext(sources) {
  var want = sources.filter(function (s) { return canFetch(s.url); }).slice(0, CONTEXT_SOURCES);
  if (!want.length) return [];

  var cache = ctxCache();
  var ready = [];
  var missing = [];

  want.forEach(function (s) {
    var hit = '';
    if (cache) {
      try { hit = cache.get('page:' + s.url) || ''; } catch (e) { hit = ''; }
    }
    if (hit) ready.push({ src: s, text: hit });
    else missing.push({ src: s, text: '' });
  });

  if (missing.length) {
    var reqs = missing.map(function (m) { return contentRequest(m.src.url); });
    var fetched = [];
    try {
      fetched = UrlFetchApp.fetchAll(reqs.map(function (r) {
        return {
          url: r.url,
          method: 'get',
          followRedirects: true,
          muteHttpExceptions: true,
          validateHttpsCertificates: true,
          headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' }
        };
      }));
    } catch (e) {
      fetched = [];
    }
    missing.forEach(function (m, i) {
      var res = fetched[i];
      var text = '';
      if (res) {
        try {
          var code = res.getResponseCode();
          if (code >= 200 && code < 400) text = pageText(res.getContentText(), reqs[i].json).slice(0, CONTEXT_CHARS);
        } catch (e2) { text = ''; }
      }
      m.text = text;
      if (text && cache) {
        try { cache.put('page:' + m.src.url, text, CONTEXT_TTL); } catch (e3) {}
      }
    });
  }

  // Keep the original ranking order.
  var byUrl = {};
  ready.concat(missing).forEach(function (r) { byUrl[r.src.url] = r; });
  return want.map(function (s) { return byUrl[s.url]; }).filter(Boolean);
}

// Zendesk help centres block normal page loads (403) but publish the same
// content through their public JSON API, so support-hub articles are read that
// way instead. Returns the URL to actually fetch plus how to read the response.
function contentRequest(url) {
  var m = /^https:\/\/ncisupporthub\.ncirl\.ie\/hc\/en-ie\/articles\/(\d+)/i.exec(String(url || ''));
  if (m) {
    return {
      url: 'https://ncisupporthub.ncirl.ie/api/v2/help_center/en-ie/articles/' + m[1] + '.json',
      json: true
    };
  }
  return { url: String(url || ''), json: false };
}

// Turn a fetched payload (HTML page or Zendesk JSON) into plain readable text.
function pageText(body, isJson) {
  if (isJson) {
    try {
      var data = JSON.parse(body);
      var art = data && data.article;
      if (!art) return '';
      return extractText([art.title || '', art.body || ''].join('\n'));
    } catch (e) {
      return '';
    }
  }
  return extractText(body);
}

function ctxCache() {
  try { return CacheService.getScriptCache(); } catch (e) { return null; }
}

function hostOf(url) {
  var m = /^https:\/\/([^\/?#]+)/i.exec(String(url || ''));
  if (!m) return '';
  return m[1].split('@').pop().split(':')[0].toLowerCase().replace(/^www\./, '');
}

function endsWithSuffix(host, suffix) {
  return host === suffix.replace(/^\./, '') || host.length > suffix.length && host.slice(-suffix.length) === suffix;
}

function canFetch(url) {
  var host = hostOf(url);
  if (!host) return false;
  return FETCH_SUFFIXES.some(function (s) { return endsWithSuffix(host, s); });
}

function canLink(url) {
  var host = hostOf(url);
  if (!host) return false;
  return LINK_SUFFIXES.some(function (s) { return endsWithSuffix(host, s); });
}

// Very small HTML -> readable text converter. Good enough for the static
// ncirl.ie pages; JS-only portals (moodle, MyApps) will yield little or nothing,
// which is safe - the model just falls back to linking the source.
function extractText(html) {
  var s = String(html || '');
  // Prefer the page's <main> region: it drops the shared navigation, menus and
  // footer boilerplate that otherwise eats most of the character budget.
  var main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(s);
  if (main && main[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length > 300) {
    s = main[1];
  }
  s = s
    .replace(/<!DOCTYPE[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<(br|hr)[^>]*>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|tr|div|section|article|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return tidyText(s);
}

function decodeEntities(s) {
  var named = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    '&#39;': "'", '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '-', '&middot;': '-',
    '&lsquo;': "'", '&rsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
    '&hellip;': '...', '&bull;': '-'
  };
  return String(s).replace(/&[a-zA-Z]+;|&#x?[0-9a-fA-F]+;/g, function (m) {
    if (named[m]) return named[m];
    var hex = /^&#x([0-9a-fA-F]+);$/.exec(m);
    if (hex) return safeFromCode(parseInt(hex[1], 16));
    var dec = /^&#(\d+);$/.exec(m);
    if (dec) return safeFromCode(parseInt(dec[1], 10));
    return ' ';
  });
}

function safeFromCode(n) {
  if (!isFinite(n) || n < 32 || n > 65535) return ' ';
  return String.fromCharCode(n);
}

function tidyText(s) {
  return String(s)
    .replace(/\r/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length > 1; })
    .join('\n')
    .trim();
}

function callOpenAI(messages) {
  var key = PropertiesService.getScriptProperties().getProperty(OPENAI_KEY_PROPERTY);
  var payload = {
    model: MODEL,
    messages: messages,
    temperature: 0.2,
    max_tokens: MAX_TOKENS
  };
  try {
    var res = UrlFetchApp.fetch(OPENAI_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var body = res.getContentText();
    if (code !== 200) {
      return { ok: false, error: 'openai ' + code + ': ' + body.slice(0, 200) };
    }
    var parsed = JSON.parse(body);
    var text = parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content : '';
    return { ok: true, text: text };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Conversation so far, supplied by the browser: [{ role, content }].
function parseHistory(raw) {
  try {
    var list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(function (x) {
      return x && (x.role === 'user' || x.role === 'assistant') && x.content;
    }).map(function (x) {
      return { role: x.role, content: scrub(String(x.content)).slice(0, 300) };
    });
  } catch (err) {
    return [];
  }
}

// Curated knowledge-base entries from knowledge.json, supplied by the browser:
// [{ question, answer }]. These are already written and verified, so they are
// NOT passed through scrub (which would corrupt real dates and emails).
function parseKb(raw) {
  try {
    var list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list.slice(0, 4).filter(function (e) {
      return e && e.answer;
    }).map(function (e) {
      return {
        question: cleanLabel(String(e.question || '')).slice(0, 160),
        answer: String(e.answer || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900)
      };
    });
  } catch (err) {
    return [];
  }
}

// Lighter clean for trusted labels (source titles): strip control chars and
// emails, trim length. Does NOT apply the password/ID heuristics, which would
// wrongly rewrite a title such as "NCI Password Management".
function cleanLabel(text) {
  return String(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\s@]+@[^\s@]+/g, ' [email] ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Official source pages supplied by the browser: [{ title, url }].
// Anything that is not on a known official host is dropped outright, so the
// model can never be handed - or fetch - an arbitrary URL.
function parseSources(raw) {
  try {
    var list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(function (s) {
      return s && String(s.url || '').indexOf('https://') === 0 && canLink(s.url);
    }).map(function (s) {
      return {
        title: cleanLabel(String(s.title || 'Official NCI page')).slice(0, 90),
        url: String(s.url).slice(0, 300)
      };
    });
  } catch (err) {
    return [];
  }
}

/* ---------------------------------------------------------------- logging */

var VISIT_SHEET = 'Visits';

// One row per page load. Anonymous by design: a random session id, a coarse
// device type and the timestamp. No IP address, name or email is ever stored.
function recordVisit(data) {
  var now = new Date();
  return appendRow(VISIT_SHEET, [now.toISOString(), isoDate(now), cleanId(data.sid), deviceType(data.device)]);
}

// One row per question - what was asked, whether the assistant answered it, and
// a question id + session id used to attach "did this help" feedback later.
function logQuestion(data) {
  var q = scrub(String(data.question || data.q || '')).slice(0, 200);
  if (!q) return false;
  var answered = data.answered === true || data.answered === 'true';
  return appendRow('Searches', [
    new Date().toISOString(), q, cleanId(data.qid),
    answered ? 'ai' : 'no-answer', cleanId(data.sid), answered ? 'yes' : 'no'
  ]);
}

// "That helped / that didn't help". Updates the matching question row in place
// when the id is found, otherwise records a standalone feedback row.
function recordFeedback(data) {
  var qid = cleanId(data.qid);
  var good = data.helpful === true || data.helpful === 'true';
  var outcome = good ? 'helped' : 'not-helpful';
  if (qid) {
    var sh = ss().getSheetByName('Searches');
    if (sh && sh.getLastRow() >= 2) {
      var ids = sh.getRange(2, 3, sh.getLastRow() - 1, 1).getValues();
      for (var i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i][0]) === qid) {
          sh.getRange(i + 2, 4).setValue(outcome);
          return true;
        }
      }
    }
  }
  appendRow('Searches', [
    new Date().toISOString(), scrub(String(data.question || data.q || '')).slice(0, 200),
    qid, outcome, cleanId(data.sid), ''
  ]);
  return true;
}

// One row per completed survey. Values arrive as 'yes'/'no' (or '' if skipped).
function recordSurvey(data) {
  var now = new Date();
  var norm = function (v) {
    var s = String(v == null ? '' : v).toLowerCase();
    return (s === 'yes' || s === 'no') ? s : '';
  };
  var answers = {};
  var answered = 0;
  var yesCount = 0;
  SURVEY_QUESTIONS.forEach(function (q) {
    var a = norm(data[q.id]);
    answers[q.id] = a;
    if (a) {
      answered++;
      if (a === 'yes') yesCount++;
    }
  });
  var overall = answered ? Math.round((yesCount / answered) * 100) / 100 : '';
  return appendRow(SURVEY_SHEET, [
    now.toISOString(), isoDate(now), cleanId(data.sid), deviceType(data.device),
    cleanId(data.qid), scrub(String(data.q || data.question || '')).slice(0, 200),
    answers.resolved, answers.helpful, answers.recommend, answers.easy, overall
  ]);
}

function cleanId(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

function deviceType(v) {
  var d = String(v || '').toLowerCase();
  return (d === 'mobile' || d === 'tablet' || d === 'desktop') ? d : 'unknown';
}

function isoDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function yesterday() {
  var d = new Date();
  d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* ----------------------------------------------------------------- digest */

/**
 * Questions that either had no answer or were rated unhelpful. This is the
 * "what should we write next" list, so nobody needs access to this project.
 */
function digest() {
  var sh = ss().getSheetByName('Searches');
  if (!sh || sh.getLastRow() < 2) return [];
  var rows_ = sh.getRange(2, 2, sh.getLastRow() - 1, 4).getValues();

  var agg = {};
  rows_.forEach(function (r) {
    var q = String(r[0] || '').trim();
    var outcome = String(r[2] || '').trim();
    if (!q || q === '(blank)') return;
    if (!agg[q]) agg[q] = { question: q, asked: 0, refused: 0, unhappy: 0, last: '' };
    agg[q].asked++;
    if (outcome === 'no-answer') agg[q].refused++;
    if (outcome === 'not-helpful') agg[q].unhappy++;
  });

  return Object.keys(agg)
    .map(function (k) { return agg[k]; })
    .filter(function (r) { return r.refused > 0 || r.unhappy > 0; })
    .sort(function (a, b) {
      return (b.refused * 3 + b.unhappy) - (a.refused * 3 + a.unhappy);
    })
    .slice(0, 40)
    .map(function (r) {
      r.last = r.last || '';
      return r;
    });
}

/** Writes the digest into its own tab. Run on a trigger, or manually. */
function refreshDigestTab() {
  var dg = ensureSheet(ss(), DIGEST_SHEET, LOG_SHEETS[DIGEST_SHEET]);
  if (dg.getLastRow() >= 2) {
    dg.getRange(2, 1, dg.getLastRow() - 1, Math.max(dg.getLastColumn(), 1)).clearContent();
  }
  var items = digest();
  if (!items.length) {
    dg.getRange(2, 1, 1, 3)
      .setValues([['(nothing outstanding)', 'every question so far is answered', '']]);
    return;
  }
  dg.getRange(2, 1, items.length, 3).setValues(items.map(function (r) {
    var why = [];
    if (r.refused) why.push(r.refused + 'x no answer given');
    if (r.unhappy) why.push(r.unhappy + 'x marked unhelpful');
    return [r.question, why.join(', '), new Date().toISOString().slice(0, 10)];
  }));
}

/* ----------------------------------------------------------- daily report */

var REPORT_EMAIL_PROPERTY = 'REPORT_EMAIL';

/** Run ONCE from the editor to switch on the daily report email.
 *  setupReporting()            -> email the deploying account, 08:00 daily
 *  setupReporting('x@y.com')   -> email someone else instead           */
function setupReporting(email) {
  setupMorningReport(email);
}

/** Easiest way to switch on the daily report: run this from the editor, type the
 *  email in the box (or leave it blank to use your own account) and click OK. */
function configureReporting() {
  var current = PropertiesService.getScriptProperties().getProperty(REPORT_EMAIL_PROPERTY) || '';
  var prompt = 'Daily report recipient email.\n\n' +
    'Leave blank to send the report to your own Google account:\n' + Session.getEffectiveUser().getEmail() +
    '\n\nCurrent setting: ' + (current || '(your account)');
  var answer = Browser.inputBox('NCI Student Assistant', prompt, Browser.Buttons.OK_CANCEL);
  if (String(answer).toLowerCase() === 'cancel') return;
  setupMorningReport(String(answer || '').trim() || null);
  Logger.log('Done. The report will be emailed to: ' + reportRecipient());
}

function setReportEmail(email) {
  PropertiesService.getScriptProperties().setProperty(REPORT_EMAIL_PROPERTY, String(email || '').trim());
  Logger.log('Report recipient set to: ' + reportRecipient());
}

function reportRecipient() {
  return PropertiesService.getScriptProperties().getProperty(REPORT_EMAIL_PROPERTY)
      || Session.getEffectiveUser().getEmail();
}

/** Trigger entry point (also runnable by hand). Emails + stores yesterday's report. */
function sendDailyReport() {
  var day = yesterday();
  var text = dailyReportText(day);
  writeDailyReportRow(day);
  writeSurveySummaryRows(day);
  writeTopQuestionsRows(day);
  writeDashboard();
  var to = reportRecipient();
  if (to) {
    MailApp.sendEmail({
      to: to,
      subject: 'NCI Student Assistant - daily report ' + day,
      body: text
    });
  }
  return text;
}

/** Emails today's full report (Dashboard-style summary) at ~08:00. */
function sendMorningReport() {
  var day = isoDate(new Date());
  var text = dailyReportText(day);
  writeDailyReportRow(day);
  writeSurveySummaryRows(day);
  writeTopQuestionsRows(day);
  writeDashboard();
  var to = reportRecipient();
  if (to) {
    MailApp.sendEmail({
      to: to,
      subject: 'NCI Student Assistant - morning report ' + day,
      body: text
    });
  }
  return text;
}

/** Run ONCE from the editor to email today's report at ~08:00 every day. */
function setupMorningReport(email) {
  if (email) PropertiesService.getScriptProperties().setProperty(REPORT_EMAIL_PROPERTY, String(email).trim());
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMorningReport' || t.getHandlerFunction() === 'sendDailyReport') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('sendMorningReport').timeBased().everyDays(1).atHour(8).create();
  Logger.log('Morning report (today) scheduled for ~08:00 each day. Recipient: ' + reportRecipient());
}

/** Rebuild every reporting tab for TODAY. Handy while testing. */
function refreshReports() {
  var day = isoDate(new Date());
  writeDailyReportRow(day);
  writeSurveySummaryRows(day);
  writeTopQuestionsRows(day);
  writeDashboard();
  Logger.log('Reporting tabs refreshed for ' + day + '.');
  return day;
}

/** Rebuild every derived tab for every date that appears in the raw logs.
 *  Run once after enabling reporting, or after backfilling data, so the
 *  Dashboard and per-day tabs always reflect the raw records. */
function rebuildAllReports() {
  var days = {};
  var add = function (sh, col) {
    if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var d = rowDay(r[0]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) days[d] = true;
    });
  };
  add(ss().getSheetByName(VISIT_SHEET), 2);
  add(ss().getSheetByName('Searches'), 1);
  add(ss().getSheetByName(SURVEY_SHEET), 2);

  var list = Object.keys(days).sort();
  list.forEach(function (day) {
    writeDailyReportRow(day);
    writeSurveySummaryRows(day);
    writeTopQuestionsRows(day);
  });
  writeDashboard();
  Logger.log('Rebuilt reports for ' + list.length + ' day(s): ' + (list.join(', ') || '(none)'));
  return list;
}

/** Diagnostic: confirms every reporting tab exists with the expected header
 *  and logs its row count. Run from the editor and read the Execution log. */
function checkWiring() {
  var book = ss();
  var problems = [];

  Object.keys(LOG_SHEETS).forEach(function (name) {
    var sh = book.getSheetByName(name);
    if (!sh) { problems.push(name + ': sheet missing'); return; }
    var want = LOG_SHEETS[name];
    var got = sh.getRange(1, 1, 1, want.length).getValues()[0];
    for (var i = 0; i < want.length; i++) {
      if (String(got[i]) !== want[i]) {
        problems.push(name + ': column ' + (i + 1) + " is '" + got[i] + "', expected '" + want[i] + "'");
      }
    }
    Logger.log(name + ': ' + Math.max(sh.getLastRow() - 1, 0) + ' data row(s)');
  });

  var sv = book.getSheetByName(SURVEY_SHEET);
  if (sv && sv.getLastRow() >= 2) {
    Logger.log('latest survey: ' + JSON.stringify(sv.getRange(sv.getLastRow(), 1, 1, 11).getValues()[0]));
  } else {
    Logger.log('latest survey: none yet');
  }

  if (problems.length) {
    Logger.log('WIRING PROBLEMS:\n- ' + problems.join('\n- '));
  } else {
    Logger.log('WIRING OK: every tab and header matches the reporting code.');
  }
  return problems;
}

/** Manual test: builds today's report and returns it (no email). */
function previewDailyReport() {
  return dailyReportText(isoDate(new Date()));
}

function dailyStats(day) {
  var zero = function (o) { return Object.keys(o).length; };
  var stats = {
    date: day,
    visits: 0, sessions: {}, questions: 0, answered: 0,
    helped: 0, notHelped: 0, noFeedback: 0, refused: 0, surveys: 0,
    top: {}, unanswered: {}
  };

  var vs = ss().getSheetByName(VISIT_SHEET);
  if (vs && vs.getLastRow() >= 2) {
    vs.getRange(2, 1, vs.getLastRow() - 1, 4).getValues().forEach(function (r) {
      // The date cell is often read back as a Date object, so normalise it.
      if (rowDay(r[1]) !== day) return;
      stats.visits++;
      var sid = String(r[2] || '');
      if (sid) stats.sessions[sid] = true;
    });
  }

  var sh = ss().getSheetByName('Searches');
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function (r) {
      if (rowDay(r[0]) !== day) return;
      var q = String(r[1] || '').trim();
      var outcome = String(r[3] || '').trim();
      var answeredFlag = String(r[5] || '').trim();
      if (!q) return;
      stats.questions++;
      stats.top[q] = (stats.top[q] || 0) + 1;
      if (answeredFlag === 'yes') stats.answered++;
      else stats.refused++;
      if (outcome === 'helped') stats.helped++;
      else if (outcome === 'not-helpful') stats.notHelped++;
      else if (answeredFlag === 'yes') stats.noFeedback++;
      if (answeredFlag !== 'yes') stats.unanswered[q] = (stats.unanswered[q] || 0) + 1;
    });
  }

  stats.uniqueSessions = zero(stats.sessions);

  var sv = ss().getSheetByName(SURVEY_SHEET);
  if (sv && sv.getLastRow() >= 2) {
    sv.getRange(2, 1, sv.getLastRow() - 1, 11).getValues().forEach(function (r) {
      if (rowDay(r[1]) === day) stats.surveys++;
    });
  }

  return stats;
}

function rowDay(ts) {
  var tz = Session.getScriptTimeZone();
  if (ts instanceof Date) return Utilities.formatDate(ts, tz, 'yyyy-MM-dd');
  var s = String(ts || '');
  // Full ISO timestamps are stored in UTC; attribute them to the local day so
  // questions asked after midnight Irish time are not counted on the day before.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  }
  return s.slice(0, 10);
}

function topQuestions(top, limit) {
  return Object.keys(top).sort(function (a, b) { return top[b] - top[a]; }).slice(0, limit || 5);
}

function dailyReportText(day) {
  var s = dailyStats(day);
  var rate = s.questions ? Math.round((s.answered / s.questions) * 100) : 0;
  var lines = [
    'NCI Student Assistant - daily report',
    'Date: ' + s.date,
    '',
    'Visits:            ' + s.visits,
    'Unique sessions:   ' + s.uniqueSessions,
    '',
    'Questions asked:   ' + s.questions,
    'Answered:          ' + s.answered + (s.questions ? ' (' + rate + '%)' : ''),
    '  helped:          ' + s.helped,
    '  not helpful:     ' + s.notHelped,
    '  no feedback yet: ' + s.noFeedback,
    'No answer given:   ' + s.refused
  ];

  var top = topQuestions(s.top, 5);
  if (top.length) {
    lines.push('', 'Top questions:');
    top.forEach(function (q) { lines.push('  ' + s.top[q] + 'x  ' + q); });
  }

  var gaps = topQuestions(s.unanswered, 10);
  if (gaps.length) {
    lines.push('', 'Questions the assistant could NOT answer (write content for these):');
    gaps.forEach(function (q) { lines.push('  - ' + q + ' (' + s.unanswered[q] + 'x)'); });
  } else {
    lines.push('', 'Every question in this period was answered.');
  }

  var sv = surveyStats(day);
  lines.push('', 'Survey responses:  ' + sv.n);
  if (sv.n) {
    SURVEY_QUESTIONS.forEach(function (q) {
      var c = sv.q[q.id];
      var total = c.yes + c.no;
      var pct = total ? Math.round((c.yes / total) * 100) : 0;
      lines.push('  ' + padRight(q.label, 30) + c.yes + ' yes / ' + c.no + ' no  (' + pct + '%)');
    });
  }
  return lines.join('\n');
}

function padRight(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function writeDailyReportRow(day) {
  var s = dailyStats(day);
  var rate = s.questions ? Math.round((s.answered / s.questions) * 100) : 0;
  var helpedPct = s.questions ? Math.round((s.helped / s.questions) * 100) : 0;
  var sh = ensureSheet(ss(), REPORT_SHEET, REPORT_HEADERS);
  var rowIndex = -1;
  var last = sh.getLastRow();
  if (last >= 2) {
    var existing = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < existing.length; i++) {
      if (rowDay(existing[i][0]) === day) rowIndex = i + 2;
    }
  }
  if (rowIndex === -1) rowIndex = last + 1;
  sh.getRange(rowIndex, 1, 1, REPORT_HEADERS.length).setValues([[
    day, s.visits, s.uniqueSessions, s.questions, s.answered, rate,
    s.helped, helpedPct, s.notHelped, s.noFeedback, s.refused, s.surveys
  ]]);
}

/** Per-question yes/no/skip counts for one day. */
function surveyStats(day) {
  var out = { n: 0, q: {} };
  SURVEY_QUESTIONS.forEach(function (q) { out.q[q.id] = { yes: 0, no: 0, skipped: 0 }; });
  var sh = ss().getSheetByName(SURVEY_SHEET);
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues().forEach(function (r) {
    if (rowDay(r[1]) !== day) return;
    out.n++;
    SURVEY_QUESTIONS.forEach(function (q, i) {
      var v = String(r[6 + i] || '').toLowerCase();
      if (v === 'yes') out.q[q.id].yes++;
      else if (v === 'no') out.q[q.id].no++;
      else out.q[q.id].skipped++;
    });
  });
  return out;
}

/** Delete existing rows for a date in a one-row-per-day reporting tab. */
function clearDayRows(sh, day) {
  var last = sh.getLastRow();
  if (last < 2) return;
  var dates = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = dates.length - 1; i >= 0; i--) {
    if (rowDay(dates[i][0]) === day) sh.deleteRow(i + 2);
  }
}

/** Rebuild "Survey summary" for one day: one row per survey question. */
function writeSurveySummaryRows(day) {
  var s = surveyStats(day);
  var sh = ensureSheet(ss(), SURVEY_SUMMARY_SHEET, LOG_SHEETS[SURVEY_SUMMARY_SHEET]);
  clearDayRows(sh, day);
  var rows = SURVEY_QUESTIONS.map(function (q) {
    var c = s.q[q.id];
    var total = c.yes + c.no;
    var pct = total ? Math.round((c.yes / total) * 100) : '';
    return [day, q.label, c.yes, c.no, c.skipped, pct];
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

/** Rebuild "Top questions" for one day (the 10 most asked). */
function writeTopQuestionsRows(day) {
  var s = dailyStats(day);
  var sh = ensureSheet(ss(), TOP_SHEET, LOG_SHEETS[TOP_SHEET]);
  clearDayRows(sh, day);
  var rows = topQuestions(s.top, 10).map(function (q) {
    var unanswered = s.unanswered[q] || 0;
    return [day, q, s.top[q], s.top[q] - unanswered, unanswered];
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  }
}

/** Rebuild the all-time Dashboard tab. */
function writeDashboard() {
  var sh = ensureSheet(ss(), DASHBOARD_SHEET, LOG_SHEETS[DASHBOARD_SHEET]);
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 1)).clearContent();
  }
  var q = allSearchTotals();
  var sv = allSurveyTotals();
  var rate = q.questions ? Math.round((q.answered / q.questions) * 100) : 0;
  var rows = [
    ['total_visits', countRows(VISIT_SHEET)],
    ['total_questions', q.questions],
    ['answer_rate_%', rate],
    ['helped', q.helped],
    ['not_helped', q.notHelped],
    ['no_answer', q.noAnswer],
    ['survey_responses', sv.n]
  ];
  SURVEY_QUESTIONS.forEach(function (question) {
    var c = sv.q[question.id];
    var total = c.yes + c.no;
    rows.push(['survey_' + question.id + '_yes_%', total ? Math.round((c.yes / total) * 100) : 0]);
  });
  var now = isoDate(new Date());
  rows.forEach(function (r) { r.push(now); });
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
}

function countRows(name) {
  var sh = ss().getSheetByName(name);
  return sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
}

function allSearchTotals() {
  var out = { questions: 0, answered: 0, helped: 0, notHelped: 0, noAnswer: 0 };
  var sh = ss().getSheetByName('Searches');
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function (r) {
    if (!String(r[1] || '').trim()) return;
    out.questions++;
    if (String(r[5] || '').trim() === 'yes') out.answered++;
    else out.noAnswer++;
    var o = String(r[3] || '').trim();
    if (o === 'helped') out.helped++;
    else if (o === 'not-helpful') out.notHelped++;
  });
  return out;
}

function allSurveyTotals() {
  var out = { n: 0, q: {} };
  SURVEY_QUESTIONS.forEach(function (q) { out.q[q.id] = { yes: 0, no: 0, skipped: 0 }; });
  var sh = ss().getSheetByName(SURVEY_SHEET);
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues().forEach(function (r) {
    out.n++;
    SURVEY_QUESTIONS.forEach(function (q, i) {
      var v = String(r[6 + i] || '').toLowerCase();
      if (v === 'yes') out.q[q.id].yes++;
      else if (v === 'no') out.q[q.id].no++;
      else out.q[q.id].skipped++;
    });
  });
  return out;
}

/* ---------------------------------------------------------------- helpers */

/** Maintenance: erase all recorded visits, questions, surveys and report rows
 *  while keeping the header rows. Handy to clear test data before going live. */
function resetLogs() {
  [VISIT_SHEET, 'Searches', REPORT_SHEET, SURVEY_SHEET, SURVEY_SUMMARY_SHEET, TOP_SHEET, DASHBOARD_SHEET]
    .forEach(function (name) {
      var sh = ss().getSheetByName(name);
      if (sh && sh.getLastRow() >= 2) {
        sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 1)).clearContent();
      }
    });
  Logger.log('Cleared Visits, Searches, Survey, Survey summary, Top questions, Dashboard and Daily report data rows.');
}

function json(obj, callback) {
  var cb = callback || "";
  var data = JSON.stringify(obj);
  if (cb) {
    data = cb + "(" + data + ");";
    return ContentService.createTextOutput(data).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(data).setMimeType(ContentService.MimeType.JSON);
}

function ss() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function rows(name) {
  var sh = ss().getSheetByName(name);
  return sh ? sh.getLastRow() : 0;
}

var LOG_SHEETS = {
  'Searches': ['timestamp', 'query', 'entry_id', 'outcome', 'session', 'answered'],
  'Visits': ['timestamp', 'date', 'session', 'device'],
  'Survey responses': ['timestamp', 'date', 'session', 'device', 'entry_id', 'question_asked',
                       'resolved', 'helpful', 'recommend', 'easy', 'overall'],
  'Survey summary': ['date', 'survey_question', 'yes', 'no', 'skipped', 'yes_%'],
  'Top questions': ['date', 'question', 'times_asked', 'answered', 'unanswered'],
  'Dashboard': ['metric', 'value', 'last_updated'],
  'Daily report': REPORT_HEADERS,
  'Needs content': ['question', 'why', 'last_seen']
};

function appendRow(name, values) {
  try {
    var sheet = ss().getSheetByName(name);
    if (!sheet) {
      var header = LOG_SHEETS[name];
      sheet = header ? ensureSheet(ss(), name, header) : ss().insertSheet(name);
    }
    sheet.appendRow(values);
    return true;
  } catch (err) {
    Logger.log('appendRow(' + name + ') failed: ' + err);
    return false;
  }
}

// Runs before anything is sent to OpenAI or written to the sheet. The browser
// does the same thing, so this is the second of two passes.
function scrub(text) {
  return String(text)
    .replace(/[^\s@]+@[^\s@]+/g, ' [email] ')
    .replace(/\b(?:password|passwd|pwd|passcode)\b\s*(?:is|are|was|=|:)?\s*["']?[^\s"']{3,}["']?/gi,
             ' password [redacted]')
    .replace(/\b(?:x|ca)?\d{5,}\b/gi, ' [id] ')
    .replace(/\b\d{4,}\b/g, ' [number] ')
    .replace(/\s+/g, ' ')
    .trim();
}