/**
 * NCI Student Assistant - AI proxy, logging and feedback
 * ---------------------------------------------------
 * Add this file to the SAME Apps Script project as Code.gs.
 * Deploy once: it serves all three jobs.
 *
 *   1. Answers questions with an AI model, grounded in knowledge.json entries
 *   2. Logs each question anonymously
 *   3. Accepts "that helped / this didn't help" feedback
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

var MODEL = 'gpt-4o-mini';
var MAX_ENTRIES = 3;
var ENTRY_CHARS = 500;
var QUESTION_CHARS = 300;
var MAX_TOKENS = 500;
var OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Digest tab for "what should we write next".
var DIGEST_SHEET = 'Needs content';

var OPENAI_KEY_PROPERTY = 'OPENAI_API_KEY';

var SYSTEM_PROMPT = [
  'You are the student information assistant for National College of Ireland,',
  'an institution in Dublin, Ireland. You answer MSc student questions.',
  '',
  'ABSOLUTE RULES',
  '1. Use ONLY the numbered OFFICIAL ENTRIES supplied in the user message.',
  '   Nothing else is permitted. Do not use your own knowledge.',
  '2. If the entries do not contain the answer, reply with exactly:',
  '   "I do not have that in my NCI notes yet." then one sentence on who to',
  '   contact, and stop. Do not guess, estimate or extrapolate.',
  '3. Never state a date, fee, deadline, policy or contact detail that is not',
  '   written in the entries. If the entries disagree, say they differ.',
  '4. Never invent a URL. Only use the source URLs given in the entries.',
  '5. Never ask for, and never repeat, personal details such as a name,',
  '   student number or email address.',
  '6. Be concise and practical. Use short paragraphs or bullets. No preamble,',
  '   no restating the question, no sign-off.',
  '7. If the entries suggest the student may be distressed or in difficulty,',
  '   add one brief line pointing to the Student Counselling and Wellness',
  '   Service, without dramatising it.'
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
  Logger.log('Ready. Set the API key with setApiKey("<your-key>").');
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
      model: MODEL,
      searches: rows('Searches'),
      digest: rows(DIGEST_SHEET)
    });
    if (mode === 'digest') return json({ ok: true, items: digest() });
    return answer(p);
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ----------------------------------------------------------------- doPost */

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    var data = JSON.parse(raw || '{}');
    if (data.mode === 'feedback') return json({ ok: true, feedback: feedback(data) });
    if (data.mode === 'log') return json({ ok: true, logged: logQuestion(data) });
    return json({ ok: false, error: 'unknown mode' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* --------------------------------------------------------------- answering */

function answer(p) {
  var question = scrub(String(p.q || '')).slice(0, QUESTION_CHARS);
  if (!question) return json({ ok: false, error: 'empty question' });

  var entries = parseEntries(p.entries).slice(0, MAX_ENTRIES);
  if (!entries.length) {
    return json({ ok: true, answered: false, answer: '', reason: 'no entries' });
  }
  if (!hasApiKey()) {
    return json({ ok: false, error: 'no api key', fallback: true });
  }

  var numbered = entries.map(function (en, i) {
    return [
      'ENTRY ' + (i + 1),
      'Question this answers: ' + en.q,
      'Official answer: ' + en.a,
      'Official source: ' + en.title + ' - ' + en.url
    ].join('\n');
  }).join('\n\n');

  var userMessage = [
    'OFFICIAL ENTRIES (the only permitted source):',
    '',
    numbered,
    '',
    'STUDENT QUESTION:',
    question,
    '',
    'Answer using only the entries above. If they do not cover it, say you do ' +
    'not know and point to the NCI Support Hub.'
  ].join('\n');

  var res = callOpenAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ]);

  if (!res.ok) return json({ ok: false, error: res.error, fallback: true });

  var text = String(res.text || '').trim();
  if (!text) return json({ ok: false, error: 'empty completion', fallback: true });

  // Only surface sources the model was actually given.
  var sources = entries.map(function (en) {
    return { title: en.title, url: en.url };
  });

  return json({
    ok: true,
    answered: true,
    answer: text.slice(0, 2500),
    sources: sources,
    model: MODEL
  });
}

function callOpenAI(messages) {
  var key = PropertiesService.getScriptProperties().getProperty(OPENAI_KEY_PROPERTY);
  var payload = {
    model: MODEL,
    messages: messages,
    temperature: 0,          // deterministic: fewer creative excursions
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

function parseEntries(raw) {
  try {
    var list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(function (e) {
      return e && e.q && e.a && String(e.url || '').indexOf('https://') === 0;
    }).map(function (e) {
      return {
        q: scrub(String(e.q)).slice(0, 160),
        a: scrub(String(e.a)).slice(0, ENTRY_CHARS),
        url: String(e.url),
        title: scrub(String(e.title || 'Official NCI page')).slice(0, 80)
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

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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
    .replace(/\b(?:x|ca)?\d{5,}\b/g, ' [id] ')
    .replace(/\b\d{4,}\b/g, ' [number] ')
    .replace(/\s+/g, ' ')
    .trim();
}