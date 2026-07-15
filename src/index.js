import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { chromium } from "playwright";

import { BankPortalScraper } from "./bank_portal_scraper.js";
import { assertPollingConfig, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { SlackClient } from "./slack_webhook.js";
import { StateStore } from "./state_store.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "..");

dotenv.config({ path: path.join(ROOT_DIR, ".env") });

const logger = createLogger("bank_poller");

// Exposed so the fatal-error handler can release the bank session too: the
// portal allows one session per client, so dying without logging out strands a
// session that rejects the next run's login until it expires on its own.
let releaseSession = null;

async function main() {
  const config = loadConfig();
  assertPollingConfig(config);
  await fs.mkdir(config.dataDir, { recursive: true });

  const stateStore = new StateStore({
    stateFile: config.stateFile,
    latestMovementsFile: config.latestMovementsFile,
    maxSeenMovements: config.poller.maxSeenMovements
  });
  await stateStore.load();

  const browserOptions = {
    headless: config.browser.headless,
    viewport: { width: 1440, height: 960 },
    // Let our shutdown handler log out before the browser closes; otherwise
    // Playwright tears Chrome down on the signal and logout races a dead page.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
  };

  if (config.browser.channel) {
    browserOptions.channel = config.browser.channel;
  }

  const context = await chromium.launchPersistentContext(config.browser.userDataDir, browserOptions);
  const page = context.pages()[0] || await context.newPage();

  const scraper = new BankPortalScraper({ page, config, logger });
  const slackClient = new SlackClient({
    botToken: config.slack.botToken,
    channel: config.slack.channel,
    bankName: config.bank.name,
    timezone: config.timezone
  });

  let closing = false;
  const closeSession = async () => {
    if (closing) return;
    closing = true;
    // Log out so we don't leave an active session behind — the bank allows only
    // one per client, and an orphaned session blocks the next run's login.
    await scraper.logout().catch(() => {});
    await context.close().catch(() => {});
  };
  releaseSession = closeSession;

  const shutdown = async () => {
    logger.info("Shutting down");
    await closeSession();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // SIGHUP too (e.g. the terminal closing): Playwright's handleSIGHUP is off so
  // Chrome survives the signal, which only helps if we log out before exiting.
  process.on("SIGHUP", shutdown);

  let consecutiveFailures = 0;

  do {
    try {
      const movements = await pollWithRetry(scraper, logger);
      await stateStore.recordLatestMovements(movements);

      const unseenMovements = movements.filter((movement) => !stateStore.hasFingerprint(movement.fingerprint));
      const notifyMovements = config.poller.onlyIncoming
        ? unseenMovements.filter((movement) => movement.isIncoming)
        : unseenMovements;

      logger.info(`Poll complete. Found ${movements.length} rows, ${unseenMovements.length} new, ${notifyMovements.length} notifiable.`);

      // The portal lists newest first. Post oldest -> newest so the channel reads
      // chronologically and the most recent payment is the last message.
      const movementsToPost = [...unseenMovements].reverse();

      let postedCount = 0;
      for (const movement of movementsToPost) {
        if (config.poller.onlyIncoming && !movement.isIncoming) {
          await stateStore.rememberMovement(movement);
          continue;
        }

        await slackClient.postMovement(movement);
        postedCount += 1;
        await stateStore.rememberMovement(movement);
      }

      await sendHeartbeat({ config, slackClient, stateStore, logger, postedCount });
      await stateStore.markRunSuccess();
      consecutiveFailures = 0;
    } catch (error) {
      logger.error(error.message);
      await stateStore.markRunFailure(error);
      consecutiveFailures += 1;
    }

    if (config.poller.once) break;
    await sleep(nextDelayMs(config.poller, consecutiveFailures));
  } while (true);

  await closeSession();
}

// The portal fails transiently in two observed ways: the page loads blank
// (Angular never boots, so it never recovers no matter how long we wait), and
// the movements dialog ignores the first click. Both clear on a fresh attempt,
// so retry within the cycle — otherwise one blip costs a whole backoff window,
// which at a 15-20 min poll interval means a ~30 min blackout.
const POLL_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 5_000;

async function pollWithRetry(scraper, logger) {
  let lastError;

  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    try {
      return await scraper.pollMovements();
    } catch (error) {
      lastError = error;

      // A session held elsewhere can't be retried away — it has to expire. Fail
      // fast and let the loop's backoff wait it out instead of burning attempts.
      if (/already active/i.test(error.message)) throw error;

      if (attempt < POLL_ATTEMPTS) {
        const reason = String(error.message).split("\n")[0];
        logger.warn(`Poll attempt ${attempt}/${POLL_ATTEMPTS} failed (${reason}); retrying`);
        await sleep(RETRY_PAUSE_MS);
      }
    }
  }

  throw lastError;
}

async function sendHeartbeat({ config, slackClient, stateStore, logger, postedCount }) {
  if (!config.slack.heartbeat) return;

  // Bold the timestamp: this message is edited in place, so the check time is
  // the one thing that changes and the only thing worth scanning for.
  const stamp = `*${formatLocalTime(new Date(), config.timezone)}*`;
  const text = postedCount > 0
    ? `🟢 ${config.bank.name}: ${postedCount} nuevo(s) pago(s) notificado(s). Última verificación: ${stamp}`
    : `🟢 ${config.bank.name}: sin nuevos pagos. Última verificación: ${stamp}`;

  // When we just posted real payment messages, start a fresh heartbeat below
  // them; otherwise edit the existing heartbeat in place to avoid channel noise.
  const previous = postedCount > 0 ? null : stateStore.getHeartbeat();

  try {
    const reference = await slackClient.postOrUpdateHeartbeat(text, previous);
    await stateStore.setHeartbeat(reference);
  } catch (error) {
    logger.warn(`Could not send heartbeat: ${error.message}`);
  }
}

function formatLocalTime(date, timezone) {
  try {
    return new Intl.DateTimeFormat("es-VE", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

// Randomized delay so the cadence isn't robotic. On success: interval ± jitter.
// On repeated failure: exponential backoff (interval doubles per failure) capped
// at maxBackoffSeconds, so we never hammer the bank when something is wrong.
function nextDelayMs(poller, consecutiveFailures) {
  const base = consecutiveFailures > 0
    ? Math.min(poller.maxBackoffSeconds, poller.intervalSeconds * 2 ** consecutiveFailures)
    : poller.intervalSeconds;
  const jitterRange = Math.min(poller.jitterSeconds, base / 2);
  const jitter = (Math.random() * 2 - 1) * Math.max(jitterRange, 0);
  const seconds = Math.max(30, base + jitter);
  return Math.round(seconds * 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  logger.error(error.stack || error.message);
  if (releaseSession) await releaseSession().catch(() => {});
  process.exit(1);
});
