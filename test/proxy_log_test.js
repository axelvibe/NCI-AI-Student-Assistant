// Tests the Proxy.gs logging contract without Google Apps Script:
//   * logQuestion writes all 15 Searches columns
//   * recordFeedback updates the original row and never overwrites outcome
//   * ensureSearchesSheet migrates old sheets without losing rows
// Uses in-memory sheet mocks. Run via `python3 test/run_tests.py`.
(function () {
  var APP_DIR = APP_DIR_PLACEHOLDER;
  var src = readFile(APP_DIR + 'docs/google-apps-script/Proxy.gs');

  globalThis.Utilities = {
    formatDate: function (d) { return d.toISOString().slice(0, 10); }
  };

  var wrapper = new Function('Logger', src + '\n' +
    'return { logQuestion: logQuestion, recordFeedback: recordFeedback, ' +
    'formatSources: formatSources, ensureSearchesSheet: ensureSearchesSheet, ' +
    'isTestSession: isTestSession, isTestQuestionText: isTestQuestionText, ' +
    'searchDedupeKey: searchDedupeKey, surveyDedupeKey: surveyDedupeKey, ' +
    'dailyStats: dailyStats, csvCell: csvCell, ' +
    'SEARCH_HEADERS: SEARCH_HEADERS, ' +
    'setAppend: function (fn) { appendRow = fn; }, ' +
    'setSS: function (fn) { ss = fn; } };');
  var api = wrapper({ log: function () {} });

  var failures = 0;
  function check(cond, msg) {
    if (!cond) { failures++; print('    FAIL: ' + msg); }
  }

  // ---- appendRow capture ----
  var captured = [];
  api.setAppend(function (name, values) {
    captured.push({ name: name, values: values });
    return true;
  });

  // 1. successful answer row
  var ok = api.logQuestion({
    question: 'What are the exam dates?',
    answered: true,
    answer: 'Exams run from 5 May. Email me at a@b.com or password hunter2.',
    sources: [{ title: 'NCI Exams', url: 'https://www.ncirl.ie/exams' }],
    model: 'gpt-4o', qid: 'q-123', session: 's-456', response_ms: 321, outcome: 'answered'
  });
  check(ok === true, 'logQuestion returned true');
  check(captured.length === 1 && captured[0].name === 'Searches', 'one Searches row');
  var row = captured[0].values;
  check(row.length === 15, '15 columns, got ' + row.length);
  check(row[1] === 'What are the exam dates?', 'question column');
  check(row[2] === 'q-123', 'question_id column');
  check(row[3] === 'answered', 'outcome column');
  check(row[4] === 's-456', 'session_id column');
  check(row[5] === 'yes', 'answered column');
  check(row[7].indexOf('a@b.com') === -1 && row[7].indexOf('hunter2') === -1, 'answer scrubbed');
  check(row[7].indexOf('5 May') !== -1, 'answer date preserved');
  check(row[8].indexOf('https://www.ncirl.ie/exams') !== -1, 'sources column');
  check(row[9] === 'gpt-4o', 'model column');
  check(row[10] === 321, 'response_ms column');
  check(row[11] === '' && row[12] === '' && row[13] === '', 'no feedback yet');

  // 2. error row
  captured = [];
  api.logQuestion({ question: 'bad question', answered: false, error: 'no api key', qid: 'q-err', session: 's' });
  row = captured[0].values;
  check(row[3] === 'error', 'outcome error');
  check(row[5] === 'no', 'answered no');
  check(row[14] === 'no api key', 'error column');

  // ---- in-memory sheet mock ----
  function makeSheet(rows, maxRows, maxCols) {
    var data = rows.map(function (r) {
      var copy = r.slice();
      while (copy.length < maxCols) copy.push('');
      return copy;
    });
    while (data.length < maxRows) {
      var blank = [];
      while (blank.length < maxCols) blank.push('');
      data.push(blank);
    }
    return {
      getLastRow: function () {
        for (var i = data.length - 1; i >= 0; i--) {
          for (var j = 0; j < data[i].length; j++) if (data[i][j] !== '') return i + 1;
        }
        return 0;
      },
      getLastColumn: function () {
        var max = 0;
        data.forEach(function (r) {
          for (var j = r.length - 1; j >= 0; j--) {
            if (r[j] !== '') { max = Math.max(max, j + 1); break; }
          }
        });
        return max;
      },
      getMaxRows: function () { return data.length; },
      getMaxColumns: function () { return maxCols; },
      getRange: function (r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        return {
          getValues: function () {
            var out = [];
            for (var i = 0; i < nr; i++) {
              var line = [];
              for (var j = 0; j < nc; j++) line.push(data[r - 1 + i][c - 1 + j]);
              out.push(line);
            }
            return out;
          },
          setValues: function (vals) {
            for (var i = 0; i < vals.length; i++) {
              for (var j = 0; j < vals[i].length; j++) data[r - 1 + i][c - 1 + j] = vals[i][j];
            }
          },
          setValue: function (v) { data[r - 1][c - 1] = v; }
        };
      },
      clearContents: function () {
        data.forEach(function (r) { for (var j = 0; j < r.length; j++) r[j] = ''; });
      },
      setFrozenRows: function () {},
      insertRowsAfter: function (after, n) { for (var i = 0; i < n; i++) { var b = []; while (b.length < maxCols) b.push(''); data.push(b); } },
      insertColumnsAfter: function (after, n) { maxCols += n; data.forEach(function (r) { for (var i = 0; i < n; i++) r.push(''); }); },
      _data: data
    };
  }

  // 3. feedback updates the existing row and keeps outcome
  var data = [
    api.SEARCH_HEADERS.slice(),
    ['2026-01-01T10:00:00Z', 'q text', 'q-123', 'answered', 's-456', 'yes',
     '2026-01-01', 'answer', 'sources', 'gpt-4o', 100, '', '', '', '']
  ];
  var sheet = makeSheet(data, data.length, 15);
  api.setSS(function () {
    return { getSheetByName: function (n) { return n === 'Searches' ? sheet : null; } };
  });
  var fb = api.recordFeedback({ qid: 'q-123', helpful: 'true' });
  check(fb === true, 'feedback found row');
  var updated = sheet._data[1];
  check(updated[3] === 'answered', 'outcome not overwritten');
  check(updated[11] === 'yes' && updated[12] === 'helped' && updated[13], 'feedback columns written');

  // 4. standalone feedback falls back to a feedback-only row
  captured = [];
  api.recordFeedback({ qid: 'missing', helpful: 'false', question: 'lost question', session: 's' });
  row = captured[0].values;
  check(row[3] === 'feedback-only', 'feedback-only outcome');
  check(row[11] === 'no' && row[12] === 'not-helpful', 'standalone feedback columns');

  // 5. sources string parsing
  check(api.formatSources('[{"title":"T","url":"https://www.ncirl.ie"}]')
    .indexOf('T - https://www.ncirl.ie') === 0, 'sources JSON string');

  // 6. migration from the legacy query/entry_id/session schema
  var legacy = [
    ['timestamp', 'query', 'entry_id', 'outcome', 'session', 'answered'],
    ['2026-01-01T10:00:00Z', 'What are the fees?', 'e1', 'ai', 's1', 'yes'],
    ['2026-01-02T11:30:00Z', 'When are exams?', 'e2', 'no-answer', 's2', 'no']
  ];
  var oldSheet = makeSheet(legacy, 10, 6);
  var book = {
    getSheetByName: function (n) { return n === 'Searches' ? oldSheet : null; },
    insertSheet: function () { return oldSheet; }
  };
  api.ensureSearchesSheet(book);
  var migrated = oldSheet._data;
  check(migrated[0].slice(0, 15).join('|') === api.SEARCH_HEADERS.join('|'), 'migrated header');
  check(migrated[1][1] === 'What are the fees?' && migrated[1][2] === 'e1', 'legacy question/id preserved');
  check(migrated[1][4] === 's1', 'legacy session mapped');
  check(migrated[1][6] === '2026-01-01', 'date derived from timestamp');
  check(migrated[1][5] === 'yes' && migrated[2][5] === 'no', 'answered derived from outcome');

  // 7. migration from the oldest is_refusal schema
  var oldest = [
    ['timestamp', 'query', 'entry_id', 'is_refusal'],
    ['2026-01-03T09:00:00Z', 'Hello?', 'e3', 'no'],
    ['2026-01-03T09:01:00Z', 'Off topic?', 'e4', 'yes']
  ];
  var oldestSheet = makeSheet(oldest, 10, 4);
  var book2 = {
    getSheetByName: function (n) { return n === 'Searches' ? oldestSheet : null; },
    insertSheet: function () { return oldestSheet; }
  };
  api.ensureSearchesSheet(book2);
  var migrated2 = oldestSheet._data;
  check(migrated2[1][3] === 'answered' && migrated2[1][5] === 'yes', 'is_refusal=no becomes answered');
  check(migrated2[2][3] === 'refused' && migrated2[2][5] === 'no', 'is_refusal=yes becomes refused');

  // 8. report filtering and deduplication
  check(api.isTestSession('abc') && api.isTestSession('ABC'), 'abc is a test session');
  check(!api.isTestSession('s-456'), 'real session is not test');
  check(api.isTestQuestionText('test') && api.isTestQuestionText('[test] dates'), 'test text detected');
  check(!api.isTestQuestionText('latest news'), 'normal text is not test');

  var d1 = ['2026-01-01T09:00:00Z', 'What are the fees?', 'q1', 'answered', 's1', 'yes', '2026-01-01', 'a', 's', 'gpt-4o', 1, '', '', '', ''];
  var d2 = ['2026-01-01T09:01:00Z', 'What are the fees?', 'q1', 'answered', 's1', 'yes', '2026-01-01', 'a', 's', 'gpt-4o', 1, '', '', '', ''];
  var d3 = ['2026-01-01T09:02:00Z', 'What are the fees?', 'q2', 'answered', 's2', 'yes', '2026-01-01', 'a', 's', 'gpt-4o', 1, '', '', '', ''];
  var d4 = ['2026-01-01T09:05:00Z', 'When are exams?', '', 'answered', 's2', 'yes', '2026-01-01', 'a', 's', 'gpt-4o', 1, '', '', '', ''];
  var d5 = ['2026-01-01T09:05:30Z', 'When are exams?', '', 'answered', 's2', 'yes', '2026-01-01', 'a', 's', 'gpt-4o', 1, '', '', '', ''];
  var d6 = ['2026-01-01T09:06:00Z', 'test', 'q3', 'answered', 'abc', 'yes', '2026-01-01', 'a', 's', 'gpt-4o', 1, '', '', '', ''];
  var d7 = ['2026-01-01T09:07:00Z', 'fees', 'q4', 'feedback-only', 's1', 'no', '2026-01-01', '', '', '', '', '', 'helped', '2026-01-01T09:07:00Z', ''];
  check(api.searchDedupeKey(d1) === api.searchDedupeKey(d2), 'same qid dedupes');
  check(api.searchDedupeKey(d1) !== api.searchDedupeKey(d3), 'different qid survives');
  check(api.searchDedupeKey(d4) === api.searchDedupeKey(d5), 'blank qid same minute dedupes');

  var visits = [
    ['timestamp', 'date', 'session', 'device'],
    ['2026-01-01T09:00:00Z', '2026-01-01', 's1', 'desktop'],
    ['2026-01-01T09:01:00Z', '2026-01-01', 's1', 'desktop'],
    ['2026-01-01T09:02:00Z', '2026-01-01', 'abc', 'desktop'],
    ['2026-01-01T09:03:00Z', '2026-01-01', 's2', 'mobile']
  ];
  var surveys = [
    ['timestamp', 'date', 'session', 'device', 'entry_id', 'question_asked', 'resolved', 'helpful', 'recommend', 'easy', 'overall'],
    ['2026-01-01T09:10:00Z', '2026-01-01', 's1', 'desktop', 'q1', 'What are the fees?', 'yes', 'yes', 'yes', 'yes', 1],
    ['2026-01-01T09:10:05Z', '2026-01-01', 's1', 'desktop', 'q1', 'What are the fees?', 'yes', 'yes', 'yes', 'yes', 1],
    ['2026-01-01T09:11:00Z', '2026-01-01', 'abc', 'desktop', 'q2', 'test', 'yes', 'no', 'yes', 'no', 0.5],
    ['2026-01-01T09:12:00Z', '2026-01-01', 's2', 'mobile', 'q3', 'When are exams?', 'yes', 'no', 'yes', 'yes', 0.75]
  ];
  var searchSheet = makeSheet([api.SEARCH_HEADERS.slice()].concat([d1, d2, d3, d4, d5, d6, d7]), 20, 15);
  var visitSheet = makeSheet(visits, 10, 4);
  var surveySheet = makeSheet(surveys, 10, 11);
  api.setSS(function () {
    return { getSheetByName: function (n) {
      if (n === 'Searches') return searchSheet;
      if (n === 'Visits') return visitSheet;
      if (n === 'Survey responses') return surveySheet;
      return null;
    } };
  });
  var stats = api.dailyStats('2026-01-01');
  check(stats.visits === 3, 'visits exclude abc, got ' + stats.visits);
  check(stats.uniqueSessions === 2, 'distinct users, got ' + stats.uniqueSessions);
  check(stats.questions === 3, 'questions deduped/excluded, got ' + stats.questions);
  check(stats.surveys === 2, 'surveys deduped/excluded, got ' + stats.surveys);
  check(api.csvCell('a,b') === '"a,b"', 'csv comma quoted');
  check(api.csvCell('a"b') === '"a""b"', 'csv quote escaped');

  print('');
  print('LOGGING TESTS: ' + (failures ? failures + ' failure(s)' : 'all passed'));
  if (failures) throw new Error(failures + ' logging test failure(s)');
})();
