# NCI Student Information Assistant

A small, dependency-free chatbot that answers common **MSc student** questions at
National College of Ireland using a hand-written knowledge base of official public
NCI information.

It is a plain static site: `index.html`, `style.css`, `app.js` and `knowledge.json`.
No build step, no framework, no server, no API keys, no RAG or vector database.

## The one rule

**It only answers what is written in `knowledge.json`, and every answer links to the
official NCI page it came from.** If it cannot find a confident match it says so
plainly and points the student to NCI. It never guesses, and it never invents a
date, fee or deadline.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure and the chat UI |
| `style.css` | Styling, responsive down to phone widths |
| `app.js` | Search, ranking, rendering, browse view, local stats |
| `knowledge.json` | The 40 answers, with variants, keywords and official source links |

## How matching works

`app.js` scores every entry out of 1 from five signals, then applies a second,
independent gate. There is no server and no model.

| Signal | Weight | What it measures |
| --- | --- | --- |
| `exact` | 0.30 | The whole question matches a question or variant wording |
| `phrase` | 0.30 | How much of the question appears in one single wording |
| `keys` | 0.20 | Which of the entry's own keywords the student used |
| `cov` | 0.20 | IDF-weighted share of the question the entry accounts for |
| `fuzzy` | 0.05 | Character bigram overlap, for typos in longer words |

- **IDF weighting** means a rare word like `eduroam` counts for far more than a
  common one like `assignment`, instead of every word counting the same.
- **An explained-token gate** (`EXPLAIN_GATE = 0.60`) requires the winning entry to
  account for at least 60% of the words the student used. A high score alone is not
  enough. Without this, one topical keyword was enough to confidently answer a
  longer unrelated question — "how do I pay my rent" scored well on the fees entry
  purely on the word "pay".
- **Short words use edit distance, not bigrams.** Bigrams under-rate short typos:
  `weak` vs `week` shares only one bigram (0.25) although it is a single keystroke
  (0.75). Tokens of 5 characters or fewer are compared with normalised Levenshtein
  distance, longer ones with bigrams.
- `wi fi` is folded to `wifi` during normalisation.

An answer is only shown when the score is at least `MATCH_THRESHOLD` (0.26) **and**
the gate is satisfied. Runner-ups within `ALSO_CHECK_BAND` are offered as
"also check", which is how genuinely ambiguous questions such as *Exam Result* are
handled — two real answers rather than one arbitrary one.

## Test results

The shipped `app.js` was run under JavaScriptCore against a labelled set of
**73 in-scope questions and 21 out-of-scope questions**:

| Set | Result |
| --- | --- |
| The 32 questions exactly as briefed | 32/32 |
| Natural rewordings a student would type | 32/32 |
| Typos and very short input | 9/9 |
| Out of scope, must refuse to answer | 21/21 |
| **Total** | **94/94 (100%)** |
| The 8 entries added in the September 2026 update | 24/24 |
| New entries not hijacking existing ones | 8/8 |
| Distress-support nudge fires when it should | 7/7 |
| Distress-support nudge stays quiet when it should | 4/4 |
| **Total after update** | **137/137 (100%)** |

The out-of-scope set is the important one. It includes weather, sport, jokes,
canteen and parking questions, and questions about student numbers or landlords.
All 21 are correctly refused rather than answered with the nearest unrelated entry.

## Accuracy and sourcing

Every answer was checked against the live NCI page it cites. Where a page did not
support a specific claim, the claim was removed rather than kept:

- Fee figures are **not** stated. NCI does not publish a single fee table on its
  Postgraduate Fees page, so the assistant points to the individual course page
  instead of quoting an unverified number.
- Results are described as published on MyDetails, not emailed.
- The exams page refers to the **Mayor Square campus**, not "Spencer Dock".
- The study-room booking link in the previous draft was wrong and was replaced with
  the correct per-room booking route.
- Resit dates are attributed to the Academic Calendar, and the three kinds of
  deferral are distinguished.
- "Spencer Dock" is used only where the source page uses it, for the study rooms.

One honest limitation: this assistant is only as current as its knowledge base. The
`lastReviewed` date is shown in the footer so it is obvious when information was
last confirmed. Semester dates, exam blocks, fees and scholarships all change, so
students should still open the linked official page before making plans.

## Privacy

No personal data is collected, stored or displayed. There are no staff names and no
student information in the knowledge base. Search counts are kept in the browser
only, and only the search text and a timestamp, never who searched.

## Optional: search stats and suggestions

Off by default, so the site works with no configuration. To enable either one, edit
the `CONFIG` object at the top of `app.js`:

- `statsEndpoint` — a Google Apps Script web app URL that appends a row to a Google
  Sheet. Request body is plain text, so no CORS preflight is involved.
- `suggestionFormUrl` — a Google Form `/edit` link for "suggest a missing question",
  so a student can report a gap. Leave empty and the button points at the NCI
  Support Hub instead.

Neither is required, and neither is set up in this repository.

## Running locally

Because `app.js` fetches `knowledge.json`, open it over HTTP rather than by
double-clicking the file:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploying

Any static host works. For GitHub Pages: push to `main`, then in the repository
settings set Pages to deploy from the `main` branch.

## Not included

No build tooling, no tests wired into CI, and no automated re-verification of the
NCI source pages. Re-checking the knowledge base against the live site is a manual
step, and it is the step that matters most for this project.

## Checking the source links

`check_links.py` hits every URL referenced by the knowledge base — the primary
`link`, any additional `links`, and any bare URL that appears inside an answer.
Run it before committing any change to `knowledge.json`:

    python3 check_links.py knowledge.json --timeout 30

It reports four outcomes that matter:

| Result | Meaning |
| --- | --- |
| `OK` | Page loaded. |
| `BROKEN` | HTTP 404 or 410, or the host does not resolve. Needs a new source. |
| `UNREACHABLE` / `TIMEOUT` | Connection refused, DNS or timeout. Retried once before being reported. |
| `BLOCKED` | HTTP 401/403/429. Usually a bot filter, **not** evidence the page was removed. |

`ncisupporthub.ncirl.ie` returns 403 to automated requests, so its articles
always show as `BLOCKED`. Those pages are real; confirm changes to them by hand.

