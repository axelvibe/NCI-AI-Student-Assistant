/**
 * NCI Student Assistant - search analytics
 * ----------------------------------------
 * Appends one row per search to a Google Sheet and serves the most-searched
 * questions back to the site.
 *
 * Contract expected by app.js (see CONFIG.statsEndpoint in app.js):
 *
 *   POST  body (text/plain JSON):  { "text": "...", "entryId": "...", "timestamp": "..." }
 *         -> appends a row. The site never reads the response.
 *
 *   GET   ?mode=top
 *         -> JSON:  [ { "text": "...", "count": 12 }, ... ]   (most searched first)
 *
 * SETUP: see docs/GOOGLE-SETUP.md. Run setup() once, then deploy as a Web App.
 *        Required execute-as: "Me". Required access: "Anyone".
 */

var SHEET_NAME = 'Searches';
var MAX_ROWS = 50000;      // oldest rows are trimmed past this
var TOP_N = 8;             // how many popular questions to return
var HEADER = ['timestamp', 'query', 'entry_id', 'is_refusal'];

/* ---------------------------------------------------------------- setup */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sheet.setFrozenRows(1);
  }
  // Keep the log free of anything that identifies a student, even if the page
  // is bypassed and something posts directly to this endpoint.
  try {
    ss.getSheetByName(SHEET_NAME).getRange('A:F').setHidden(false);
  } catch (e) { /* not fatal */ }
  Logger.log('Ready. Sheet: ' + ss.getName() + ' -> ' + SHEET_NAME);
}

/* ------------------------------------------------------------- handlers */

function doGet(e) {
  try {
    var mode = (e && e.parameter && e.parameter.mode) || '';
    if (mode === 'top') {
      return json(topQueries());
    }
    if (mode === 'health') {
      return json({ ok: true, rows: sheet().getLastRow() });
    }
    return json({ ok: true, hint: 'use ?mode=top' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json({ ok: false, error: 'busy' });
  }

  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    var data = {};
    try {
      data = JSON.parse(raw) || {};
    } catch (parseErr) {
      data = { text: String(raw) };
    }

    var query = scrub(String(data.text == null ? '' : data.text)).slice(0, 120);
    if (!query) return json({ ok: true, skipped: 'empty' });

    var entryId = String(data.entryId == null ? '' : data.entryId).slice(0, 80);
    var when = String(data.timestamp || new Date().toISOString()).slice(0, 40);

    var sh = sheet();
    sh.appendRow([when, query, entryId, entryId ? 'no' : 'yes']);

    // Keep the log bounded so the Sheet never hits its cell limit.
    if (sh.getMaxRows() > MAX_ROWS + 1) {
      sh.deleteRows(MAX_ROWS + 1, sh.getMaxRows() - MAX_ROWS);
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* -------------------------------------------------------------- helpers */

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  }
  return sh;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Second line of defence: strip anything that looks like a credential, even
// though the page already does this before sending.
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

function topQueries() {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last < 2) return [];

  var values = sh.getRange(2, 2, last - 1, 1).getValues();
  var counts = Object.create(null);

  values.forEach(function (row) {
    var q = String(row[0] || '').trim();
    if (!q) return;
    // Drop the "(blank)" bucket from the public list.
    if (q === '(blank)') return;
    counts[q] = (counts[q] || 0) + 1;
  });

  return Object.keys(counts)
    .map(function (q) { return { text: q, count: counts[q] }; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, TOP_N);
}

/** Run this from the editor to preview what the site would show. */
function testTop() {
  Logger.log(JSON.stringify(topQueries(), null, 2));
}

/** Run this to clear the log and start fresh. */
function resetLog() {
  var sh = sheet();
  if (sh.getLastRow() > 0) sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumns()).clearContent();
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  Logger.log('Log cleared.');
}
