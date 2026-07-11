# Bank Poller MVP

Small local poller for the first milestone:

- keep a persistent browser session alive
- visit the bank portal every few minutes
- scrape the latest movement rows
- dedupe by a stable fingerprint
- post new movements to a Slack incoming webhook

This tool is intentionally separate from Rails. The goal is to prove that polling
works reliably before wiring it into `BalanceTransaction#post!`.

## What it does

1. Opens a persistent Playwright browser profile.
2. Tries to reuse the existing authenticated session.
3. Detects session expiry and attempts login again.
4. Scrapes the latest rows using selectors from `.env`.
5. Saves local seen-state in JSON so the same movement is not announced twice.
6. Posts each new movement to Slack through `SLACK_WEBHOOK_URL`.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill the Slack webhook URL.
3. Fill the bank URLs and selectors.
4. If the bank allows scripted login, fill the username/password selectors too.
5. Install dependencies:

```bash
cd script/bank_poller
npm install
```

## First run

Start with a visible browser:

```bash
cd script/bank_poller
npm run poll:once
```

If the bank requires OTP/captcha/manual confirmation:

- leave `HEADLESS=false`
- let the script open the portal
- complete the login manually in the opened browser window
- run `npm run poll:once` again once the session is valid

The persistent browser profile is stored in `script/bank_poller/data/browser_profile`,
so later runs can usually reuse the same session until the bank expires it.

## Continuous polling

```bash
cd script/bank_poller
npm start
```

Default schedule:

- base interval: `180` seconds
- jitter: `0..90` seconds

So each run sleeps roughly 3 to 4.5 minutes between polls.

## Important env vars

- `BANK_ROWS_SELECTOR`: required. Selector for each movement row.
- `BANK_AMOUNT_SELECTOR`: recommended.
- `BANK_REFERENCE_SELECTOR`: recommended.
- `BANK_DATE_SELECTOR`: recommended.
- `BANK_DESCRIPTION_SELECTOR`: recommended.
- `BANK_LOGGED_IN_SELECTOR`: useful for session detection.
- `BANK_SESSION_EXPIRED_SELECTOR` or `BANK_SESSION_EXPIRED_TEXT`: useful for re-login detection.
- `BANK_REFRESH_SELECTOR`: optional refresh button inside the movement page.

## Local files

The poller writes:

- `data/state.json`: known movement fingerprints and last run metadata
- `data/latest_movements.json`: latest scrape result for inspection
- `data/debug/`: screenshots and HTML snapshots when debugging is enabled

## Notes

- This is the right first MVP if your current goal is only "poll and notify".
- It is not yet connected to Botente billing.
- Once polling is stable, the next step is a matcher that turns a Slack alert into
  an automatic `posted` transition for a matching pending top-up.
