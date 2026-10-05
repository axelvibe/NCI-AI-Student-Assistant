# Connecting the AI (OpenAI)

This adds a grounded AI answer while keeping the API key off the public page.

## 1) Create a fresh Apps Script project (do not reuse the old one)
1. Go to https://script.google.com -> New project
2. Create a fresh Google Sheet: https://sheets.new (name e.g. "NCI assistant AI")
3. In the Apps Script editor, delete `Code.gs` contents
4. Copy the entire contents of `docs/google-apps-script/Proxy.gs` into Code.gs
5. Save

## 2) Put your OpenAI key in Script Properties (safest)
1. In Apps Script: Run -> `setApiKey`
2. A popup appears. Paste your OpenAI key (sk-...) and accept
3. You can delete the `setApiKey` function after saving if you want, but not necessary

## 3) Create the sheets (setup)
1. With the new sheet open, go to Extensions -> NCI assistant AI (or just re-run from Apps Script)
2. Run `setup()` from the editor dropdown once. It creates `Searches` and `Needs content` tabs.

## 4) Deploy as a Web App
1. Deploy -> New deployment
2. Type: Web app
3. Description: NCI assistant proxy
4. Execute as: Me
5. Who has access: Anyone
6. Deploy -> Copy the Web App URL (ends with /exec)

## 5) Send the URL to me
Send that `/exec` URL to me. I will set `aiEndpoint` to it in app.js, commit and redeploy.
Once live, AI answers appear only when the matcher finds relevant entries and the AI sticks to them.

## Tip: if the "Run -> setApiKey" option doesn't appear
In Apps Script, make sure you're looking at the `Proxy.gs` file (or that you've saved it). The function runs once from the editor's Run dropdown. If Apps Script asks for authorisation, click "Review permissions" -> choose your account -> "Advanced" -> "Go to (unsafe)" if needed, then allow.
