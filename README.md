# Bank Poller MVP

Small local poller for the first milestone:

- keep a persistent browser session alive
- visit the bank portal every few minutes
- scrape the latest movement rows
- dedupe by a stable fingerprint
- post new movements to Slack

This repo is now BDV-first. It defaults to Banco de Venezuela personas:

- login URL: `https://bdvenlinea.banvenez.com/`
- consolidated page: `https://bdvenlinea.banvenez.com/main/posicionconsolidada`
- incoming notifications only by default
- reference suffix extraction (`last 6`) built in

## What it does

1. Opens a persistent Playwright browser profile.
2. Tries to reuse the existing authenticated session.
3. Detects session expiry and attempts login again.
4. Opens the first `Movimientos` action from Posición Consolidada when needed.
5. Scrapes the latest BDV movement rows.
6. Keeps only incoming credits by default.
7. Posts the amount, full reference, and last 6 digits to Slack.
8. Saves local seen-state in JSON so the same movement is not announced twice.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`.
3. Fill `BANK_USERNAME` and `BANK_PASSWORD`.
4. Install dependencies:

```bash
cd ~/bank-poller
npm install
```

## First run

Start with a visible browser:

```bash
cd ~/bank-poller
npm run poll:once
```

If BDV requires any manual confirmation:

- leave `HEADLESS=false`
- let the script open the portal
- complete the login manually in the opened browser window
- run `npm run poll:once` again once the session is valid

The persistent browser profile lives under `data/browser_profile`, so later
runs can usually reuse the same session until the bank expires it.

## Continuous polling

```bash
cd ~/bank-poller
npm start
```

## Inspecting an unknown bank page

When I do not know the bank UI yet, the fastest path is to let the tool capture
artifacts from a real session.

1. Put the page you care about in `BANK_INSPECT_URL`, or reuse `BANK_MOVEMENTS_URL`
   if you already know it.
2. Run:

```bash
cd ~/bank-poller
npm run inspect
```

3. If the portal needs manual login or OTP, complete that in the opened browser.
4. After the wait window, inspect mode saves:

- screenshot
- full HTML
- page text
- metadata JSON
- row previews when `BANK_ROWS_SELECTOR` is configured

Artifacts land in `data/debug/`. That is enough for me to identify selectors and
session-expiry signals without guessing the UI.

Default schedule:

- base interval: `180` seconds
- jitter: `±90` seconds (symmetric, so the cadence isn't robotic)
- on failure: exponential backoff (interval doubles per consecutive failure) up
  to `POLL_MAX_BACKOFF_SECONDS` (default `1800`), so a broken run never hammers
  the bank.

So a healthy run sleeps roughly 1.5 to 4.5 minutes between polls. The browser
session is kept alive for the life of the process and reused across polls — it
only logs in again when the bank actually expires the session, which minimizes
bot-like login activity.

## Heartbeat ("still alive") message

When `SLACK_HEARTBEAT=true` (default), every successful check posts a heartbeat
to Slack even when there are no new payments, so you can see the poller is live.
It edits a single message in place (via `chat.update`) to show the last check
time — e.g. `🟢 Banco de Venezuela: sin nuevos pagos. Última verificación: …` —
instead of flooding the channel. When a real payment is posted, the heartbeat
starts a fresh message below it. Set `SLACK_HEARTBEAT=false` to only notify on
payments. `TIMEZONE` (default `America/Caracas`) controls the timestamp.

## Important env vars

- `SLACK_BOT_TOKEN`: required for polling mode.
- `SLACK_CHANNEL`: required for polling mode. Default example: `#pagos-clientes`.
- `BANK_USERNAME` / `BANK_PASSWORD`: recommended so the poller can recover after session expiry.
- `NOTIFY_ONLY_INCOMING=true`: default. Only credits are sent to Slack.
- `REFERENCE_SUFFIX_LENGTH=6`: default. Used for the "last 6 digits" field.
- `BANK_*_SELECTOR`: optional advanced overrides only if BDV changes its UI.

## Local files

The poller writes:

- `data/state.json`: known movement fingerprints and last run metadata
- `data/latest_movements.json`: latest scrape result for inspection
- `data/debug/`: screenshots and HTML snapshots when debugging is enabled

## Notes

- This repo is intentionally separate from Botente.
- The current target is "poll and notify", not payment validation yet.
- The next step after stable polling is matching incoming credits against customer-submitted references.
