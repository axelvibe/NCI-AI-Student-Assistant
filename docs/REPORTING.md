# Recorded data, reports and analysis guide

This documents everything the NCI Student Assistant records, which sheet/tab each
piece lives in, what every column means, and how to use the data to improve the bot.

The website sends small, anonymous "beacons" to the Apps Script proxy. The proxy
writes them into the Google Sheet and builds the report tabs from the raw records.
Nothing identifies a student: there are no names, emails or student numbers, and the
text is scrubbed (`[email]`, `[id]`, `[number]`, `password [redacted]`) before it is
stored.

## Tabs at a glance

| Tab | Kind | Grain | Purpose |
| --- | --- | --- | --- |
| `Searches` | raw | one row per question | what was asked, and how it went |
| `Visits` | raw | one row per page load | traffic volume and device mix |
| `Survey responses` | raw | one row per completed survey | the 4-question satisfaction survey |
| `Needs content` | derived | one row per problem question | "what should we write next" list |
| `Daily report` | derived | one row per day | the daily KPI summary (also emailed) |
| `Survey summary` | derived | one row per day **per question** | survey results ready to chart |
| `Top questions` | derived | one row per day per question | the most-asked questions |
| `Dashboard` | derived | one row per metric | all-time headline numbers |

Raw tabs are append-only (one write per event). Derived tabs are **rebuilt** from the
raw tabs, so they can always be regenerated — never type into them by hand.

## Raw data dictionaries

### `Searches`
| Column | Meaning |
| --- | --- |
| `timestamp` | UTC ISO time the question was asked |
| `query` | the scrubbed question text (max 200 chars) |
| `entry_id` | question id, used to attach the "did this help?" feedback |
| `outcome` | `ai` (answered), `no-answer` (refused), `helped`, `not-helpful` |
| `session` | anonymous per-tab session id |
| `answered` | `yes` if the assistant produced a grounded answer, else `no` |

Note: one question produces one row. The later "did this help?" click updates the
`outcome` of that row in place; a standalone feedback row is only added if the
question id cannot be found.

### `Visits`
| Column | Meaning |
| --- | --- |
| `timestamp` | UTC ISO time of the page load |
| `date` | local (Europe/Dublin) date, used for day grouping |
| `session` | anonymous session id |
| `device` | `desktop`, `mobile`, `tablet` or `unknown` |

### `Survey responses`
| Column | Meaning |
| --- | --- |
| `timestamp` | UTC ISO time the survey was finished |
| `date` | local date |
| `session` | anonymous session id |
| `device` | device type |
| `entry_id` | question id the survey was attached to |
| `question_asked` | the scrubbed question that triggered the survey |
| `resolved` | `yes` / `no` / blank — "Was your problem resolved?" |
| `helpful` | `yes` / `no` / blank — "Did you find it helpful?" |
| `recommend` | `yes` / `no` / blank — "Would you recommend it?" |
| `easy` | `yes` / `no` / blank — "Was it easy to use?" |
| `overall` | share of answered questions that were `yes` (0–1) |

Blank means the student skipped that question. All four answers are sent in a single
request when the survey finishes.

## Derived report dictionaries

### `Daily report` (one row per day, upserted by date)
`date`, `visits`, `unique_sessions`, `questions`, `answered`, `answered_%`, `helped`,
`helped_%`, `not_helped`, `no_feedback`, `no_answer`, `surveys`.

### `Survey summary` (one row per day per question)
`date`, `survey_question`, `yes`, `no`, `skipped`, `yes_%`.

### `Top questions` (one row per day per question)
`date`, `question`, `times_asked`, `answered`, `unanswered`.

### `Dashboard` (all-time, rebuilt)
`metric`, `value`, `last_updated`. Metrics: `total_visits`, `total_questions`,
`answer_rate_%`, `helped`, `not_helped`, `no_answer`, `survey_responses`, and
`survey_<id>_yes_%` for each of the four survey questions.

## How to run the reports

Run these from the Apps Script editor (function dropdown → Run):

| Function | What it does |
| --- | --- |
| `checkWiring()` | Validates every tab exists with the expected header; logs row counts. Run this first if anything looks wrong. |
| `refreshReports()` | Rebuilds today's `Daily report` / `Survey summary` / `Top questions` / `Dashboard`. |
| `rebuildAllReports()` | Rebuilds those tabs for **every** date found in the raw logs (use after enabling reporting or backfilling). |
| `refreshDigestTab()` | Rebuilds `Needs content`. |
| `previewDailyReport()` | Returns today's report text (no email). |
| `sendDailyReport()` | Emails + stores **yesterday's** report (the daily trigger calls this at ~08:00). |
| `configureReporting()` | Sets the recipient and installs the daily 08:00 email trigger. |
| `resetLogs()` | Erases all raw + derived data rows (keeps headers). Use only to clear test data. |

**Important:** the email/report for a given run covers **yesterday**. To see today,
use `previewDailyReport()` or `refreshReports()`.

## Analysis guide — what to look at

| Question to answer | Where to look | Then do |
| --- | --- | --- |
| How many students use it? | `Dashboard.total_visits`, `Daily report.visits` | Track week-on-week growth. |
| How often does it actually answer? | `answered_%` | If low, add/repair sources and knowledge entries. |
| Are students satisfied? | `Survey summary` (`yes_%` per question) | Low `resolved` → answers miss the real need; low `easy` → UI/UX work. |
| Which answers are weak? | `helped` vs `not_helped`, `Needs content` | Rewrite or add content for the flagged questions. |
| What do students want that we lack? | `Needs content`, `Top questions.unanswered` | Highest-value gap list for new knowledge entries. |
| What is most asked? | `Top questions` | Prioritise quality on the top 10 questions. |
| Which pages should we refresh? | `sources.json` + `check_links.py` | Re-verify dates/fees on the cited pages. |

### Suggested quality loop
1. Weekly: run `rebuildAllReports()`, read `Needs content` and `Top questions`.
2. Add or fix a `knowledge.json` entry for each flagged question.
3. Re-run `check_links.py` before committing knowledge changes.
4. Watch `answered_%` and `Survey summary` move over the following weeks.

## Backend roles (for maintainers)

- `docs/google-apps-script/Proxy.gs` — the **only** deployed script. Handles AI
  answers, all logging, the survey, and reporting.
- `docs/google-apps-script/Code.gs` — **legacy**, search-only. Do not deploy it; if it
  is still present in the Apps Script project, delete it so its `doGet`/`doPost` do
  not shadow `Proxy.gs`.
- `docs/GOOGLE-SETUP.md` — describes the old Code.gs flow; superseded by
  `docs/SETUP_AI.md` for the current proxy.

## Troubleshooting: HTTP 400 responses

Apps Script can answer with an HTML `400` (an "unusual traffic" page) when several
requests arrive at once. It is a burst throttle, not a bug in the sheet code. The
site retries failed beacons twice, with a pause and a fresh URL, so occasional 400s
recover by themselves — in DevTools you will see a second identical `mode=...`
request a couple of seconds later.

If every request returns 400 for several minutes, stop testing for 10–15 minutes and
try again. Normal student use (one visit, a few questions, one survey) stays well
below the burst threshold.
