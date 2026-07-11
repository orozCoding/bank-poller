import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "..");

function readString(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function readBoolean(name, fallback = false) {
  const raw = readString(name, fallback ? "true" : "false").toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function readInteger(name, fallback) {
  const raw = readString(name, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT_DIR, value);
}

function requireString(name) {
  const value = readString(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig() {
  const dataDir = resolvePath(readString("BANK_POLLER_DATA_DIR", "data"));

  const config = {
    rootDir: ROOT_DIR,
    dataDir,
    stateFile: resolvePath(readString("BANK_POLLER_STATE_FILE", path.join("data", "state.json"))),
    latestMovementsFile: resolvePath(readString("BANK_POLLER_LATEST_FILE", path.join("data", "latest_movements.json"))),
    debugDir: resolvePath(readString("BANK_POLLER_DEBUG_DIR", path.join("data", "debug"))),
    slack: {
      webhookUrl: requireString("SLACK_WEBHOOK_URL")
    },
    browser: {
      headless: readBoolean("HEADLESS", false),
      channel: readString("BROWSER_CHANNEL", "chrome"),
      userDataDir: resolvePath(readString("BANK_POLLER_BROWSER_DIR", path.join("data", "browser_profile")))
    },
    poller: {
      once: readBoolean("POLL_ONCE", false),
      intervalSeconds: readInteger("POLL_INTERVAL_SECONDS", 180),
      jitterSeconds: readInteger("POLL_JITTER_SECONDS", 90),
      timeoutMs: readInteger("POLL_TIMEOUT_MS", 30_000),
      postLoginWaitMs: readInteger("POST_LOGIN_WAIT_MS", 5_000),
      rowsLimit: readInteger("BANK_ROWS_LIMIT", 20),
      maxSeenMovements: readInteger("MAX_SEEN_MOVEMENTS", 5_000),
      saveDebugArtifacts: readBoolean("SAVE_DEBUG_ARTIFACTS", true)
    },
    bank: {
      name: readString("BANK_NAME", "Banco"),
      loginUrl: readString("BANK_LOGIN_URL"),
      movementsUrl: requireString("BANK_MOVEMENTS_URL"),
      username: readString("BANK_USERNAME"),
      password: readString("BANK_PASSWORD"),
      selectors: {
        rows: requireString("BANK_ROWS_SELECTOR"),
        date: readString("BANK_DATE_SELECTOR"),
        reference: readString("BANK_REFERENCE_SELECTOR"),
        amount: readString("BANK_AMOUNT_SELECTOR"),
        description: readString("BANK_DESCRIPTION_SELECTOR"),
        username: readString("BANK_USERNAME_SELECTOR"),
        password: readString("BANK_PASSWORD_SELECTOR"),
        submit: readString("BANK_SUBMIT_SELECTOR"),
        loggedIn: readString("BANK_LOGGED_IN_SELECTOR"),
        sessionExpired: readString("BANK_SESSION_EXPIRED_SELECTOR"),
        refresh: readString("BANK_REFRESH_SELECTOR")
      },
      sessionExpiredText: readString("BANK_SESSION_EXPIRED_TEXT")
    }
  };

  if ((config.bank.username || config.bank.password) &&
      (!config.bank.selectors.username || !config.bank.selectors.password || !config.bank.selectors.submit)) {
    throw new Error(
      "BANK_USERNAME/BANK_PASSWORD were provided, but one or more login selectors are missing."
    );
  }

  return config;
}
