# Connecting the AI, recording and reports

This sets up the Apps Script backend that provides grounded AI answers, records
anonymous usage and builds the report tabs. The OpenAI key stays in Apps Script and
never touches the repository.

The **only** script to deploy is `docs/google-apps-script/Proxy.gs`.

## 1) Create the Apps Script project
1. Create a fresh Google Sheet: <https://sheets.new> (name e.g. "NCI assistant AI").
2. In that sheet: **Extensions → Apps Script** (this binds the script to the sheet).
3. In the editor, delete the contents of the default `Code.gs`.
4. Paste the entire contents of `docs/google-apps-script/Proxy.gs`.
5. Save (Cmd/Ctrl + S).
6. If an old search-only `Code.gs` (from `docs/GOOGLE-SETUP.md`) is also present,
   delete that file so its `doGet`/`doPost` cannot shadow the proxy.

## 2) Put the OpenAI key in Script Properties
1. Run → `setApiKey`. A popup appears; paste the key (`sk-...`) and accept.
2. The key is stored in Script Properties, not in the code.

## 3) Create the sheets
1. Run → `setup` once.
2. It creates every tab and, if the `Daily report` header is the old layout, clears
   its data rows so the new 12-column layout starts clean.
3. Expected log: `Sheets ready: Searches, Visits, Survey responses, Survey summary, Top questions, Dashboard, Daily report, Needs content.`

## 4) Deploy as a Web App
1. Deploy → New deployment → type **Web app**.
2. **Execute as:** Me. **Who has access:** Anyone.
3. Deploy, approve the warning, and copy the `/exec` URL.
4. Paste it into `app.js` as `CONFIG.aiEndpoint`, commit and redeploy the site.

> After **any** code change, use **Deploy → Manage deployments → Edit → Version: New
> version → Deploy**. Saving the file alone does not update the live URL.

## 5) Verify
1. Open `<the /exec URL>?mode=health` in a browser.
   Expect `{"ok":true,"keyPresent":true,"model":"gpt-4o"}`.
2. Run → `checkWiring` and read the log — it confirms every tab and header.
3. Ask a question on the live site, answer the 4-thumb survey, then run
   `refreshReports()` and check the tabs.

## 6) Turn on the daily email
1. Run → `configureReporting()` and type the recipient (blank = your own account).
2. It schedules `sendDailyReport` for ~08:00 daily. The email covers **yesterday**.
3. Test now with `previewDailyReport()` (today, no email) or `sendDailyReport()`
   (emails yesterday).

## 7) Set the time zone
In the Sheet: **File → Settings → Time zone → Europe/Dublin**. Day grouping and the
report dates depend on it.

See [`REPORTING.md`](REPORTING.md) for every tab, column and the analysis guide.

## Tip: if "Run → setApiKey" does not appear
Make sure you are looking at the saved `Proxy.gs` file. If Apps Script asks for
authorisation, click **Review permissions → your account → Advanced → Go to … (unsafe)
→ Allow**.
