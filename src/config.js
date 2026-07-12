import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "..");

function readString(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function readFirstString(names, fallback = "") {
  for (const name of names) {
    const value = readString(name);
    if (value) return value;
  }
  return fallback;
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
    timezone: readString("TIMEZONE", "America/Caracas"),
    slack: {
      botToken: readFirstString(["SLACK_BOT_TOKEN", "BDV_SLACK_BOT_TOKEN"]),
      channel: readFirstString(["SLACK_CHANNEL", "BDV_SLACK_CHANNEL"], "#pagos-clientes"),
      // Post a "still alive" heartbeat after every successful check even when
      // there are no new payments, so we can see the poller is live.
      heartbeat: readBoolean("SLACK_HEARTBEAT", true)
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
      // After a failure, back off (interval doubles per consecutive failure)
      // up to this cap, so we never hammer the bank when something is wrong.
      maxBackoffSeconds: readInteger("POLL_MAX_BACKOFF_SECONDS", 1_800),
      timeoutMs: readInteger("POLL_TIMEOUT_MS", 30_000),
      postLoginWaitMs: readInteger("POST_LOGIN_WAIT_MS", 5_000),
      rowsLimit: readInteger("BANK_ROWS_LIMIT", 20),
      maxSeenMovements: readInteger("MAX_SEEN_MOVEMENTS", 5_000),
      saveDebugArtifacts: readBoolean("SAVE_DEBUG_ARTIFACTS", true),
      onlyIncoming: readBoolean("NOTIFY_ONLY_INCOMING", true),
      referenceSuffixLength: readInteger("REFERENCE_SUFFIX_LENGTH", 6)
    },
    inspect: {
      url: readString("BANK_INSPECT_URL"),
      waitMs: readInteger("INSPECT_WAIT_MS", 15_000)
    },
    bank: {
      name: readString("BANK_NAME", "Banco de Venezuela"),
      loginUrl: readString("BANK_LOGIN_URL", "https://bdvenlinea.banvenez.com/"),
      movementsUrl: readString("BANK_MOVEMENTS_URL", "https://bdvenlinea.banvenez.com/main/posicionconsolidada"),
      username: readFirstString(["BANK_USERNAME", "BDV_USERNAME"]),
      password: readFirstString(["BANK_PASSWORD", "BDV_PASSWORD"]),
      selectors: {
        rows: readString("BANK_ROWS_SELECTOR", "mat-table.mat-table mat-row, .mat-table .mat-row"),
        date: readString("BANK_DATE_SELECTOR", "mat-cell:nth-child(1), td:nth-child(1)"),
        reference: readString("BANK_REFERENCE_SELECTOR", "mat-cell:nth-child(2), td:nth-child(2)"),
        description: readString("BANK_DESCRIPTION_SELECTOR", "mat-cell:nth-child(3), td:nth-child(3)"),
        direction: readString("BANK_DIRECTION_SELECTOR", "mat-cell:nth-child(4), td:nth-child(4)"),
        amount: readString("BANK_AMOUNT_SELECTOR", "mat-cell:nth-child(5), td:nth-child(5)"),
        balance: readString("BANK_BALANCE_SELECTOR", "mat-cell:nth-child(6), td:nth-child(6)"),
        username: readString("BANK_USERNAME_SELECTOR", 'input[aria-label="usuario"], input[id^="mat-input-"]'),
        password: readString("BANK_PASSWORD_SELECTOR", 'input[type="password"], input[aria-label*="clave" i], input[aria-label*="contraseña" i], input[aria-label*="password" i]'),
        submit: readString("BANK_SUBMIT_SELECTOR", "button.mat-raised-button.mat-accent"),
        pageSubmit: readString("BANK_PAGE_SUBMIT_SELECTOR", "button.mat-raised-button.mat-accent"),
        dialogContainer: readString("BANK_DIALOG_CONTAINER_SELECTOR", ".cdk-overlay-container mat-dialog-container, .cdk-overlay-container .mat-dialog-container, mat-dialog-container, .mat-dialog-container, [role='dialog']"),
        dialogSubmit: readString("BANK_DIALOG_SUBMIT_SELECTOR", ".cdk-overlay-container mat-dialog-container button.mat-raised-button.mat-accent, .cdk-overlay-container .mat-dialog-container button.mat-raised-button.mat-accent, mat-dialog-container button.mat-raised-button.mat-accent, .mat-dialog-container button.mat-raised-button.mat-accent, [role='dialog'] button.mat-raised-button.mat-accent"),
        loggedIn: readString("BANK_LOGGED_IN_SELECTOR", "h3.card-container-title"),
        sessionExpired: readString("BANK_SESSION_EXPIRED_SELECTOR"),
        refresh: readString("BANK_REFRESH_SELECTOR"),
        movementsTrigger: readString("BANK_MOVEMENTS_TRIGGER_SELECTOR", "table.table-saldo-cuenta tbody tr td:nth-child(3) mat-icon"),
        activeSessionAccept: readString(
          "BANK_ACTIVE_SESSION_ACCEPT_SELECTOR",
          ".mat-snack-bar-container button, simple-snack-bar button, .snackBar button, [class*='snack'] button"
        ),
        logout: readString("BANK_LOGOUT_SELECTOR", '[aria-label="Salir"]'),
        // Login-page marker used for auth detection. Must be specific to the
        // login form — the broad username selector also matches mat-inputs on
        // the movements dialog, which would false-negative the session check.
        loginMarker: readString("BANK_LOGIN_MARKER_SELECTOR", 'input[aria-label="usuario"]')
      },
      sessionExpiredText: readString("BANK_SESSION_EXPIRED_TEXT"),
      texts: {
        loginPrompt: readString("BANK_LOGIN_PROMPT_TEXT", "Usuario"),
        consolidated: readString("BANK_CONSOLIDATED_TEXT", "Posición Consolidada"),
        movementDialog: readString("BANK_MOVEMENT_DIALOG_TEXT", "Consulta de movimientos"),
        movementsHeader: readString("BANK_MOVEMENTS_HEADER_TEXT", "Movimientos"),
        activeSession: readString("BANK_ACTIVE_SESSION_TEXT", "sesion activa")
      }
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

export function assertPollingConfig(config) {
  if (!config.slack.botToken) {
    throw new Error("SLACK_BOT_TOKEN is required for polling mode.");
  }

  if (!config.slack.channel) {
    throw new Error("SLACK_CHANNEL is required for polling mode.");
  }
}
