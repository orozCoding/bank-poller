import fs from "node:fs/promises";
import path from "node:path";

import { normalizeMovement } from "./normalizers.js";

export class BankPortalScraper {
  constructor({ page, config, logger }) {
    this.page = page;
    this.config = config;
    this.logger = logger;
  }

  async pollMovements() {
    await this.ensureAuthenticated();
    await this.gotoMovementsPage();
    await this.refreshIfNeeded();
    await this.waitForRows();

    const rawMovements = await this.extractRows();
    const movements = rawMovements.map((movement) =>
      normalizeMovement(movement, this.config.bank.name)
    );

    await this.captureArtifacts("latest");
    return movements;
  }

  async ensureAuthenticated() {
    await this.page.goto(this.config.bank.movementsUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.poller.timeoutMs
    });
    await this.page.waitForTimeout(1_000);

    if (await this.isAuthenticated()) return;

    this.logger.warn("Session looks expired, trying login");
    await this.login();

    await this.page.goto(this.config.bank.movementsUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.poller.timeoutMs
    });
    await this.page.waitForTimeout(1_000);

    if (!(await this.isAuthenticated())) {
      await this.captureArtifacts("auth-failed");
      throw new Error("Could not confirm an authenticated bank session after login.");
    }
  }

  async gotoMovementsPage() {
    const currentUrl = this.page.url();
    if (currentUrl !== this.config.bank.movementsUrl) {
      await this.page.goto(this.config.bank.movementsUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.poller.timeoutMs
      });
    } else {
      await this.page.reload({
        waitUntil: "domcontentloaded",
        timeout: this.config.poller.timeoutMs
      });
    }
  }

  async refreshIfNeeded() {
    const selector = this.config.bank.selectors.refresh;
    if (!selector) return;

    const button = this.page.locator(selector);
    if ((await button.count()) !== 1) return;

    await button.click();
    await this.page.waitForTimeout(1_000);
  }

  async waitForRows() {
    await this.page.waitForSelector(this.config.bank.selectors.rows, {
      timeout: this.config.poller.timeoutMs
    });
  }

  async extractRows() {
    const selectors = this.config.bank.selectors;
    const limit = this.config.poller.rowsLimit;

    return this.page.locator(selectors.rows).evaluateAll((rows, config) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const pick = (row, selector) => {
        if (!selector) return "";
        const node = row.querySelector(selector);
        return clean(node ? node.textContent : "");
      };

      return rows.slice(0, config.limit).map((row) => ({
        date: pick(row, config.date),
        reference: pick(row, config.reference),
        amountText: pick(row, config.amount),
        description: pick(row, config.description),
        rawText: clean(row.textContent)
      }));
    }, {
      limit,
      date: selectors.date,
      reference: selectors.reference,
      amount: selectors.amount,
      description: selectors.description
    });
  }

  async isAuthenticated() {
    const selectors = this.config.bank.selectors;

    if (selectors.sessionExpired && (await this.page.locator(selectors.sessionExpired).count()) > 0) {
      return false;
    }

    if (this.config.bank.sessionExpiredText) {
      const bodyText = await this.page.locator("body").innerText().catch(() => "");
      if (bodyText.toLowerCase().includes(this.config.bank.sessionExpiredText.toLowerCase())) {
        return false;
      }
    }

    if (selectors.username && (await this.page.locator(selectors.username).count()) > 0) {
      return false;
    }

    if (selectors.loggedIn && (await this.page.locator(selectors.loggedIn).count()) > 0) {
      return true;
    }

    if ((await this.page.locator(selectors.rows).count()) > 0) {
      return true;
    }

    return this.page.url().startsWith(this.config.bank.movementsUrl);
  }

  async login() {
    if (!this.config.bank.loginUrl) {
      throw new Error("BANK_LOGIN_URL is required for automatic re-login.");
    }

    if (!this.config.bank.username || !this.config.bank.password) {
      throw new Error("Session expired and no BANK_USERNAME/BANK_PASSWORD were configured.");
    }

    const selectors = this.config.bank.selectors;
    await this.page.goto(this.config.bank.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.poller.timeoutMs
    });

    await this.page.locator(selectors.username).fill(this.config.bank.username);
    await this.page.locator(selectors.password).fill(this.config.bank.password);
    await this.page.locator(selectors.submit).click();
    await this.page.waitForTimeout(this.config.poller.postLoginWaitMs);
  }

  async captureArtifacts(label) {
    if (!this.config.poller.saveDebugArtifacts) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = `${timestamp}-${label}`;
    const screenshotPath = path.join(this.config.debugDir, `${baseName}.png`);
    const htmlPath = path.join(this.config.debugDir, `${baseName}.html`);

    await fs.mkdir(this.config.debugDir, { recursive: true });
    await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await this.page.content().catch(() => "");
    await fs.writeFile(htmlPath, html);
  }
}
