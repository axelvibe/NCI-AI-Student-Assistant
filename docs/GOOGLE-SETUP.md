# Turning on search stats and "suggest a question"

Both features are already built and wired into the page. They are switched off
only because two URLs live in your Google account, not in this repository. Once
you paste those two URLs into `app.js`, the site is live.

Total time: about 10 minutes. Nothing here needs a server or a paid plan.

---

## Part 1 - Search stats (needs a Google Sheet + Apps Script)

### 1. Make the sheet
1. Go to <https://sheets.new> and name it something like `NCI assistant searches`.
2. Leave it empty. The script creates the tab and the header row.

### 2. Add the script
1. Go to <https://script.google.com> and click **New project**.
2. Click the code editor's `Code.gs` file, select all, delete it.
3. Open `docs/google-apps-script/Code.gs` in this repo, copy the whole file, paste it in.
4. Save (Ctrl/Cmd + S).

### 3. Connect it to the sheet
1. In the Apps Script toolbar, choose the project name dropdown -> **Add-ons** -> **Sheets**.
   (If you do not see it: **Project Settings** -> tick *Show "googleusercontent.com" and
   "script.google.com" manifest files*, save, reload.)
2. Reload the sheet tab. A new menu **Extensions** should appear. If not, close and
   reopen the sheet.
3. From **Extensions -> NCI assistant searches -> setup** to create the log tab.

### 4. Deploy it
1. In Apps Script, click **Deploy** -> **New deployment**.
2. **+** -> type **Web app**.
3. Set:
   - **Description**: `NCI assistant stats`
   - **Execute as**: **Me**
   - **Who has access**: **Anyone**
4. **Deploy** and approve the warning.

### 5. Test before wiring it up
Open this in a browser, replacing the URL with yours:

    https://script.google.com/macros/s/DEPLOYMENT_ID/exec?mode=health

You should see `{"ok":true,"rows":1}`. If you see an error, the usual cause is
*Who has access* being set to "Only myself".

### 6. Paste the URL
Copy the `/exec` URL (it ends in `/exec`) and send it to me, or paste it into
`app.js`:

```js
statsEndpoint: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec',
```

---

## Part 2 - "Suggest a question" (needs a Google Form)

### 1. Create the form
1. Go to <https://forms.google.com> -> **Blank form**.
2. Title it `Suggest a question for the NCI assistant`.
3. Add **one** question, type **Short answer**, label:
   `What should the assistant be able to answer?`
4. Add a second **Paragraph** question:
   `Anything else we should know? (optional)`
5. **Do not** tick "Collect email addresses" - the assistant's privacy promise
   depends on nobody's address being stored.

### 2. Get the field ID
1. In the form editor, click the three-dot menu on the **first** question ->
   **Show question id** (or "Copy question ID").
2. It looks like `entry.123456789`. That number is what you need.

### 3. Get the form URL
1. Click the **Send** icon -> **Link** -> **Copy link**.
2. It looks like
   `https://docs.google.com/forms/d/e/1FAIpQLSc.../viewform`.
3. Replace `/viewform` with `/edit?usp=sharing`.

### 4. Paste both values
```js
suggestionFormUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSc.../edit?usp=sharing',
suggestionFieldName: 'entry.123456789',
```

The site pre-fills the question the student actually typed, so they do not have
to retype it.

---

## Part 3 - Scheduled link checks (no input needed from you)

`.github/workflows/link-check.yml` already runs `check_links.py` on a schedule
and on every change to `knowledge.json`. If a source page dies it opens an issue
on the repository. You can change the frequency in the `schedule:` block.

**Note:** `ncisupporthub.ncirl.ie` returns HTTP 403 to automated requests, so its
articles always report as `BLOCKED`. The workflow treats `BLOCKED` as a warning,
not a failure, so it will not spam you. Real 404s and dead hosts do fail the run.

---

## Privacy

- Search text is scrubbed in the browser *and* again on the server before it is
  stored. Student numbers, email addresses and passwords are replaced with
  `[id]`, `[email]` and `password [redacted]`.
- No cookies, no fingerprinting, no cross-site tracking.
- Popular questions are aggregate counts only.

## Checking it worked

After you have pasted the URLs and the site has redeployed, ask something in the
live assistant, then check your sheet within a minute. One row should appear.

If it does not, the most likely cause is the deployment access setting in step
4 of Part 1.
