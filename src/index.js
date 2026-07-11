import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { chromium } from "playwright";

import { BankPortalScraper } from "./bank_portal_scraper.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { SlackWebhookClient } from "./slack_webhook.js";
import { StateStore } from "./state_store.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "..");

dotenv.config({ path: path.join(ROOT_DIR, ".env") });

const logger = createLogger("bank_poller");

async function main() {
  const config = loadConfig();
  await fs.mkdir(config.dataDir, { recursive: true });

  const stateStore = new StateStore({
    stateFile: config.stateFile,
    latestMovementsFile: config.latestMovementsFile,
    maxSeenMovements: config.poller.maxSeenMovements
  });
  await stateStore.load();

  const browserOptions = {
    headless: config.browser.headless,
    viewport: { width: 1440, height: 960 }
  };

  if (config.browser.channel) {
    browserOptions.channel = config.browser.channel;
  }

  const context = await chromium.launchPersistentContext(config.browser.userDataDir, browserOptions);
  const page = context.pages()[0] || await context.newPage();

  const scraper = new BankPortalScraper({ page, config, logger });
  const slackClient = new SlackWebhookClient({
    webhookUrl: config.slack.webhookUrl,
    bankName: config.bank.name
  });

  const shutdown = async () => {
    logger.info("Shutting down");
    await context.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  do {
    try {
      const movements = await scraper.pollMovements();
      await stateStore.recordLatestMovements(movements);

      const newMovements = movements.filter((movement) => !stateStore.hasFingerprint(movement.fingerprint));
      logger.info(`Poll complete. Found ${movements.length} rows, ${newMovements.length} new.`);

      for (const movement of newMovements) {
        await slackClient.postMovement(movement);
        await stateStore.rememberMovement(movement);
      }

      await stateStore.markRunSuccess();
    } catch (error) {
      logger.error(error.message);
      await stateStore.markRunFailure(error);
    }

    if (config.poller.once) break;
    await sleep(nextDelayMs(config.poller.intervalSeconds, config.poller.jitterSeconds));
  } while (true);

  await context.close();
}

function nextDelayMs(intervalSeconds, jitterSeconds) {
  const jitter = Math.floor(Math.random() * Math.max(jitterSeconds, 0));
  return (intervalSeconds + jitter) * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  logger.error(error.stack || error.message);
  process.exit(1);
});
