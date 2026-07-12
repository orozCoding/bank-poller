import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { chromium } from "playwright";

import { BankPortalScraper } from "./bank_portal_scraper.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "..");

dotenv.config({ path: path.join(ROOT_DIR, ".env") });

const logger = createLogger("inspect");

async function main() {
  const config = loadConfig();
  await fs.mkdir(config.dataDir, { recursive: true });

  const inspectUrl = config.inspect.url || config.bank.movementsUrl || config.bank.loginUrl;
  if (!inspectUrl) {
    throw new Error("BANK_INSPECT_URL, BANK_MOVEMENTS_URL, or BANK_LOGIN_URL is required for inspect mode.");
  }

  const context = await chromium.launchPersistentContext(config.browser.userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 960 },
    ...(config.browser.channel ? { channel: config.browser.channel } : {})
  });

  const page = context.pages()[0] || await context.newPage();
  const scraper = new BankPortalScraper({ page, config, logger });

  logger.info(`Opening ${inspectUrl}`);
  await page.goto(inspectUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.poller.timeoutMs
  });

  logger.info(`Waiting ${config.inspect.waitMs}ms so you can log in or navigate`);
  await page.waitForTimeout(config.inspect.waitMs);

  const metadata = await scraper.inspectCurrentPage({ label: "inspect" });
  logger.info("Inspect artifacts captured", {
    url: metadata.url,
    title: metadata.title,
    tables: metadata.tables.length,
    rowPreviewCount: metadata.rowPreview.length
  });

  await context.close();
}

main().catch((error) => {
  logger.error(error.stack || error.message);
  process.exit(1);
});
