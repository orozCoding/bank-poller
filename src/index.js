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
    bankName: config.bank.name
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

  const shutdown = async () => {
    logger.info("Shutting down");
    await closeSession();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let consecutiveFailures = 0;

  do {
    try {
      const movements = await scraper.pollMovements();
      await stateStore.recordLatestMovements(movements);

      const unseenMovements = movements.filter((movement) => !stateStore.hasFingerprint(movement.fingerprint));
      const notifyMovements = config.poller.onlyIncoming
        ? unseenMovements.filter((movement) => movement.isIncoming)
        : unseenMovements;

      logger.info(`Poll complete. Found ${movements.length} rows, ${unseenMovements.length} new, ${notifyMovements.length} notifiable.`);

      let postedCount = 0;
      for (const movement of unseenMovements) {
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

async function sendHeartbeat({ config, slackClient, stateStore, logger, postedCount }) {
  if (!config.slack.heartbeat) return;

  const stamp = formatLocalTime(new Date(), config.timezone);
  const text = postedCount > 0
    ? `🟢 ${config.bank.name}: ${postedCount} nuevo(s) pago(s) notificado(s). Última verificación: ${stamp}.`
    : `🟢 ${config.bank.name}: sin nuevos pagos. Última verificación: ${stamp}.`;

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

main().catch((error) => {
  logger.error(error.stack || error.message);
  process.exit(1);
});
