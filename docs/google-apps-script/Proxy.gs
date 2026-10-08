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
  var sh = ss.getSheetByName('Searches');
  if (!sh) {
    sh = ss.insertSheet('Searches');
    sh.getRange(1, 1, 1, 4).setValues([['timestamp', 'query', 'entry_id', 'outcome']]);
    sh.setFrozenRows(1);
  }
  var dg = ss.getSheetByName(DIGEST_SHEET);
  if (!dg) {
    dg = ss.insertSheet(DIGEST_SHEET);
    dg.getRange(1, 1, 1, 3).setValues([['question', 'why', 'last_seen']]);
    dg.setFrozenRows(1);
  }
  Logger.log('Ready. Set the API key with setApiKey().');
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
    if (data.mode === 'feedback') return json({ ok: true, feedback: feedback(data) }, (e.parameter && e.parameter.callback) || "");
    if (data.mode === 'log') return json({ ok: true, logged: logQuestion(data) }, (e.parameter && e.parameter.callback) || "");
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
    contentBlock ? 'EXTRACTED PAGE CONTENT (copy facts from this):\n\n' + contentBlock + '\n\n' : '',
    (histLines ? 'CONVERSATION SO FAR:\n' + histLines + '\n' : ''),
    'STUDENT QUESTION:',
    question,
    '',
    'Answer the student. If it is about NCI or student life, help them and cite the most relevant official source(s) from the list above.',
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

function logQuestion(data) {
  var q = scrub(String(data.question || '')).slice(0, 200);
  if (!q) return false;
  appendRow('Searches', [new Date().toISOString(), q,
                        String(data.entryId || '').slice(0, 80),
                        data.answered ? 'ai' : 'no-answer']);
  return true;
}

function feedback(data) {
  var q = scrub(String(data.question || '')).slice(0, 200);
  var good = data.helpful === true || data.helpful === 'true';
  appendRow('Searches', [new Date().toISOString(), q,
                        String(data.entryId || '').slice(0, 80),
                        good ? 'helped' : 'not-helpful']);
  return true;
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
    var outcome = String(r[3] || '').trim();
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
  var dg = ss().getSheetByName(DIGEST_SHEET);
  if (!dg) return;
  if (dg.getLastRow() > 0) {
    dg.getRange(1, 1, dg.getLastRow(), dg.getLastColumns()).clearContent();
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

/* ---------------------------------------------------------------- helpers */

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

function appendRow(name, values) {
  try {
    ss().getSheetByName(name).appendRow(values);
    return true;
  } catch (err) {
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