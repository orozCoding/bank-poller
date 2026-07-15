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
    await this.openMovements();
    await this.refreshIfNeeded();
    await this.waitForRows();

    const rawMovements = await this.extractRows();
    const movements = rawMovements.map((movement) =>
      normalizeMovement(movement, this.config.bank.name, {
        referenceSuffixLength: this.config.poller.referenceSuffixLength
      })
    );

    await this.captureArtifacts("latest");
    return movements;
  }

  async inspectCurrentPage({ label = "inspect" } = {}) {
    const metadata = await this.page.evaluate((selectors) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const bodyText = clean(document.body ? document.body.innerText : "");
      const rows = selectors.rows
        ? Array.from(document.querySelectorAll(selectors.rows)).slice(0, 10).map((row, index) => ({
            index,
            text: clean(row.textContent)
          }))
        : [];

      const tables = Array.from(document.querySelectorAll("table")).slice(0, 10).map((table, index) => ({
        index,
        id: table.id || "",
        className: clean(table.className || ""),
        rowCount: table.querySelectorAll("tr").length
      }));

      return {
        url: window.location.href,
        title: document.title,
        bodyText,
        rowPreview: rows,
        tables
      };
    }, {
      rows: this.config.bank.selectors.rows
    });

    await this.captureArtifacts(label, metadata);
    return metadata;
  }

  async openMovements() {
    // Load the consolidated page fresh every poll so we re-fetch movements — an
    // already-open dialog from a previous poll would yield stale rows. This
    // navigation keeps the in-memory session when it's still valid (no re-login);
    // only if the loaded page shows the login form do we authenticate.
    await this.navigateToMovements();

    if (!(await this.isAuthenticated())) {
      this.logger.warn("Session looks expired, trying login");
      await this.login();
      await this.navigateToMovements();
      if (!(await this.isAuthenticated())) {
        await this.captureArtifacts("auth-failed");
        throw new Error("Could not confirm an authenticated bank session after login.");
      }
    }

    await this.ensureMovementsView();
  }

  async gotoAppHome() {
    // Enter the SPA at its root. The consolidated view lives at a *client-side*
    // route (/main/posicionconsolidada) that the server does not serve directly
    // — requesting it cold returns a 404 and hangs navigation. Loading the root
    // boots the Angular app and warms its service worker, which is what makes
    // that deep route resolvable afterwards.
    // "commit" (not "domcontentloaded"): behind this site's service worker the
    // DOMContentLoaded event does not fire reliably, so waiting on it hangs the
    // whole timeout even though the app renders fine. waitForAppReady() polls
    // the DOM and is what actually confirms the page is usable.
    const homeUrl = this.config.bank.homeUrl || this.config.bank.loginUrl;
    await this.page.goto(homeUrl, {
      waitUntil: "commit",
      timeout: this.config.poller.timeoutMs
    });
    await this.waitForAppReady();
  }

  async navigateToMovements() {
    const url = this.config.bank.movementsUrl;
    if (!url) return;
    const timeout = this.config.poller.timeoutMs;

    // "commit" (not "domcontentloaded"): behind the service worker DCL doesn't
    // fire reliably and would hang the timeout. The consolidated view is a
    // client-side route the server 404s until the service worker is warmed, so
    // if the response is dead, boot the app at the root first and retry.
    const response = await this.page
      .goto(url, { waitUntil: "commit", timeout })
      .catch(() => null);

    if (!response || response.status() >= 400) {
      await this.gotoAppHome();
      await this.page.goto(url, { waitUntil: "commit", timeout });
    }

    await this.waitForAppReady();
  }

  async ensureMovementsView() {
    if (await this.hasMovementsView()) return;

    this.logger.info("Movements table not visible yet, opening it from Posición Consolidada");

    // The consolidated accounts table loads from a separate API call after the
    // logged-in shell is ready, so give it a chance to render before we try to
    // click its Movimientos icon (otherwise the trigger lookup races the DOM).
    await this.waitForConsolidatedTable();

    const clicked = await this.openMovementsFromConsolidated();
    if (!clicked) {
      await this.captureArtifacts("movements-trigger-not-found");
      throw new Error("Could not find the Movimientos trigger on Posición Consolidada.");
    }

    await this.waitForAppReady();
  }

  async waitForConsolidatedTable() {
    const selector = this.config.bank.selectors.movementsTrigger;
    if (!selector) return;

    await this.page
      .waitForSelector(selector, { state: "visible", timeout: this.config.poller.timeoutMs })
      .catch(() => {
        // Fall through: openMovementsFromConsolidated() still has a text-based
        // fallback that scans for the "subject" icon by hand.
      });
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
    if (!this.config.bank.selectors.rows) {
      throw new Error("BANK_ROWS_SELECTOR is required to wait for movement rows.");
    }

    if (await this.hasMovementsView()) return;

    try {
      await this.page.waitForSelector(this.config.bank.selectors.rows, {
        timeout: this.config.poller.timeoutMs
      });
    } catch (error) {
      // The Movimientos click can land without the dialog ever opening, which
      // strands us here for the full timeout. Capture the page so the next
      // investigation starts with evidence instead of a bare timeout.
      await this.captureArtifacts("rows-not-found").catch(() => {});
      throw error;
    }
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
        description: pick(row, config.description),
        debitCredit: pick(row, config.direction),
        amountText: pick(row, config.amount),
        balanceText: pick(row, config.balance),
        rawText: clean(row.textContent)
      }));
    }, {
      limit,
      date: selectors.date,
      reference: selectors.reference,
      description: selectors.description,
      direction: selectors.direction,
      amount: selectors.amount,
      balance: selectors.balance
    });
  }

  async isAuthenticated() {
    const selectors = this.config.bank.selectors;
    const bodyText = await this.page.locator("body").innerText().catch(() => "");

    if (selectors.sessionExpired && (await this.page.locator(selectors.sessionExpired).count()) > 0) {
      return false;
    }

    if (this.config.bank.sessionExpiredText) {
      if (bodyText.toLowerCase().includes(this.config.bank.sessionExpiredText.toLowerCase())) {
        return false;
      }
    }

    const loginMarker = selectors.loginMarker || selectors.username;
    if (loginMarker && (await this.page.locator(loginMarker).count()) > 0) {
      return false;
    }

    if (selectors.loggedIn && (await this.page.locator(selectors.loggedIn).count()) > 0) {
      return true;
    }

    if (selectors.rows && (await this.page.locator(selectors.rows).count()) > 0) {
      return true;
    }

    return bodyText.includes(this.config.bank.texts.consolidated) || bodyText.includes(this.config.bank.texts.movementDialog);
  }

  async login() {
    if (!this.config.bank.loginUrl) {
      throw new Error("BANK_LOGIN_URL is required for automatic re-login.");
    }

    if (!this.config.bank.username || !this.config.bank.password) {
      throw new Error("Session expired and no BANK_USERNAME/BANK_PASSWORD were configured.");
    }

    const selectors = this.config.bank.selectors;
    // openMovements() just navigated, so the login form is usually already on
    // screen. Only navigate if the username field isn't present, to avoid a
    // redundant reload that can race the service worker / anti-bot layer.
    if ((await this.page.locator(selectors.username).count()) === 0) {
      await this.page.goto(this.config.bank.loginUrl, {
        waitUntil: "commit",
        timeout: this.config.poller.timeoutMs
      });
    }

    await this.page.waitForSelector(selectors.username, {
      state: "visible",
      timeout: this.config.poller.timeoutMs
    });
    await this.fillFirstVisible(selectors.username, this.config.bank.username);

    await this.submitPassword();
    await this.waitForAppReady();
    await this.page.waitForTimeout(this.config.poller.postLoginWaitMs);

    // The portal allows only one live session per client. If a previous session
    // is still active it rejects this login with a dismiss-only "Cliente tiene
    // una sesion activa" toast — it cannot be overridden. Dismiss it and fail so
    // the poll loop backs off and retries once the old session expires. Graceful
    // logout on shutdown (see logout()) keeps our own runs from causing this.
    if (await this.hasActiveSessionNotice()) {
      await this.dismissActiveSessionNotice();
      throw new Error(
        "Another BDV session is already active; will retry after backoff once it expires."
      );
    }
  }

  async submitPassword() {
    const selectors = this.config.bank.selectors;

    // Click "Entrar" on the username step to open the password dialog.
    await this.clickVisibleButton(selectors.pageSubmit || selectors.submit);
    await this.waitForAppReady();

    await this.page.waitForSelector(selectors.dialogContainer, {
      state: "visible",
      timeout: this.config.poller.timeoutMs
    });
    await this.page.waitForSelector(selectors.password, {
      state: "visible",
      timeout: this.config.poller.timeoutMs
    });
    await this.fillFirstVisible(selectors.password, this.config.bank.password);
    await this.clickVisibleButton(selectors.dialogSubmit || selectors.submit);
    await this.waitForAppReady();
  }

  async hasActiveSessionNotice() {
    const notice = this.config.bank.texts.activeSession;
    if (!notice) return false;
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    return bodyText.toLowerCase().includes(notice.toLowerCase());
  }

  async dismissActiveSessionNotice() {
    this.logger.warn("Portal reports another active session; dismissing the notice");
    const accept = this.config.bank.selectors.activeSessionAccept;
    const button = this.page.locator(accept);
    const count = await button.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = button.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ force: true }).catch(() => {});
        await this.page.waitForTimeout(1_000);
        return;
      }
    }
  }

  async logout() {
    const selector = this.config.bank.selectors.logout;
    if (!selector) return;

    try {
      // Do NOT reload/navigate: this SPA drops the client session on a fresh page
      // load (that's why every start says "session expired"), which would hide
      // the nav and log us out client-side while leaving the server session live.
      // Instead, close any open dialog so the nav shell is interactable, then
      // click "Salir" on the current authenticated page.
      await this.page.keyboard.press("Escape").catch(() => {});
      await this.page.waitForTimeout(500);
      await this.waitForSpinnerIdle();

      const links = this.page.locator(selector);
      const count = await links.count();
      if (count === 0) {
        this.logger.warn("Logout control not found; leaving the session to expire on its own");
        return;
      }

      let target = null;
      for (let index = 0; index < count; index += 1) {
        const candidate = links.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          target = candidate;
          break;
        }
      }
      await (target || links.first()).click({ force: true });

      // Wait for the login form to reappear (real confirmation that logout landed)
      // and to let the request reach the server before the browser is torn down.
      await this.page
        .waitForSelector(this.config.bank.selectors.loginMarker, { state: "visible", timeout: 15_000 })
        .catch(() => {});
      await this.page.waitForTimeout(1_000);
      this.logger.info("Logged out of the bank session");
    } catch (error) {
      this.logger.warn(`Logout attempt failed: ${error.message}`);
    }
  }

  async clickVisibleButton(selector) {
    const buttons = this.page.locator(selector);
    const count = await buttons.count();
    if (count < 1) {
      throw new Error(`Could not find a button for selector: ${selector}`);
    }

    // The app's full-page #spinner overlay intercepts pointer events during the
    // (tarpitted) load, so wait for it to clear before clicking.
    await this.waitForSpinnerIdle();

    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if (await button.isVisible()) {
        // force: if the spinner briefly re-appears mid-action it must not block
        // a click on an already-visible, enabled button.
        await button.click({ force: true });
        return;
      }
    }

    throw new Error(`Could not find a visible button for selector: ${selector}`);
  }

  async waitForSpinnerIdle(timeout = 15_000) {
    // Prefer to let the overlay clear on its own (means Angular finished its
    // current work), but cap the wait short: callers force-click, so a spinner
    // that lingers must not wedge the flow for the full navigation timeout.
    await this.page
      .waitForSelector("#spinner", { state: "hidden", timeout })
      .catch(() => {});
  }

  async fillFirstVisible(selector, value) {
    const locator = this.page.locator(selector);
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible()) {
        await candidate.fill(value);
        return;
      }
    }

    throw new Error(`Could not find a visible field for selector: ${selector}`);
  }

  async waitForAppReady() {
    try {
      await this.waitForAppReadyOnce();
    } catch (error) {
      // This is the timeout the poller dies on most often (the portal throttles
      // automated browsers, so renders can outrun the timeout). Capture what was
      // on screen before rethrowing — otherwise the failure is undiagnosable.
      // Never let the capture itself mask the timeout: the page may already be
      // gone, which is exactly when the original error matters most.
      await this.captureArtifacts("app-not-ready").catch(() => {});
      throw error;
    }
  }

  async waitForAppReadyOnce() {
    await this.page.waitForFunction((config) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const bodyText = clean(document.body ? document.body.innerText : "");

      const spinner = document.querySelector("#spinner");
      const spinnerVisible = (() => {
        if (!spinner) return false;
        const style = window.getComputedStyle(spinner);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = spinner.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })();

      const hasUsername = config.username ? document.querySelector(config.username) : false;
      const hasLoggedIn = config.loggedIn ? document.querySelector(config.loggedIn) : false;
      const hasRows = config.rows ? document.querySelector(config.rows) : false;
      const hasKnownText = [config.loginPrompt, config.consolidated, config.movementDialog]
        .filter(Boolean)
        .some((text) => bodyText.includes(text));

      // The login form and account views frequently render while the app's
      // global #spinner is still visible, so a concrete element being present
      // means the page is usable regardless of the spinner. Only fall back to
      // generic text signals once the spinner has actually cleared.
      const hasTarget = Boolean(hasUsername) || Boolean(hasLoggedIn) || Boolean(hasRows);
      return hasTarget || (!spinnerVisible && hasKnownText);
    }, {
      username: this.config.bank.selectors.username,
      loggedIn: this.config.bank.selectors.loggedIn,
      rows: this.config.bank.selectors.rows,
      loginPrompt: this.config.bank.texts.loginPrompt,
      consolidated: this.config.bank.texts.consolidated,
      movementDialog: this.config.bank.texts.movementDialog
    }, {
      timeout: this.config.poller.timeoutMs
    });
  }

  async hasMovementsView() {
    return this.page.evaluate((config) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const bodyText = clean(document.body ? document.body.innerText : "");
      const hasTitle = bodyText.includes(config.movementDialog);
      const rows = config.rows ? document.querySelectorAll(config.rows).length : 0;
      return hasTitle && rows > 0;
    }, {
      movementDialog: this.config.bank.texts.movementDialog,
      rows: this.config.bank.selectors.rows
    });
  }

  async openMovementsFromConsolidated() {
    const selector = this.config.bank.selectors.movementsTrigger;
    if (selector) {
      const trigger = this.page.locator(selector).first();
      if ((await trigger.count()) > 0) {
        await this.waitForSpinnerIdle();
        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await trigger.click({ force: true });
        return true;
      }
    }

    return this.page.evaluate((texts) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const clickElement = (element) => {
        if (!element) return false;
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      };

      const summaryTables = Array.from(document.querySelectorAll("table"));
      const summaryTable = summaryTables.find((table) => {
        const headers = Array.from(table.querySelectorAll("th")).map((th) => clean(th.textContent).toUpperCase());
        return headers.includes("MOVIMIENTOS") && headers.includes("SALDO");
      });

      if (!summaryTable) return false;

      const rows = Array.from(summaryTable.querySelectorAll("tr")).filter((row) =>
        row.querySelectorAll("td").length >= 4
      );
      const firstRow = rows[0];
      if (!firstRow) return false;

      const cells = Array.from(firstRow.querySelectorAll("td"));
      const movementCell = cells[2];
      if (!movementCell) return false;

      const explicit = movementCell.querySelector("button, a, [role='button']");
      if (clickElement(explicit)) return true;

      const iconCandidate = Array.from(movementCell.querySelectorAll("mat-icon, i, span, div")).find((node) =>
        clean(node.textContent).toLowerCase() === "subject"
      );
      if (iconCandidate && clickElement(iconCandidate.closest("button, a, [role='button']") || iconCandidate)) {
        return true;
      }

      return clickElement(movementCell);
    }, {
      movementsHeader: this.config.bank.texts.movementsHeader
    });
  }

  async captureArtifacts(label, metadata = null) {
    if (!this.config.poller.saveDebugArtifacts) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = `${timestamp}-${label}`;
    const screenshotPath = path.join(this.config.debugDir, `${baseName}.png`);
    const htmlPath = path.join(this.config.debugDir, `${baseName}.html`);
    const textPath = path.join(this.config.debugDir, `${baseName}.txt`);
    const metadataPath = path.join(this.config.debugDir, `${baseName}.json`);

    await fs.mkdir(this.config.debugDir, { recursive: true });
    await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await this.page.content().catch(() => "");
    const text = await this.page.locator("body").innerText().catch(() => "");

    await fs.writeFile(htmlPath, html);
    await fs.writeFile(textPath, text);
    await fs.writeFile(metadataPath, JSON.stringify({
      capturedAt: new Date().toISOString(),
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      metadata
    }, null, 2));
  }
}
