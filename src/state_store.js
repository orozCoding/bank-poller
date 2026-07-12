import fs from "node:fs/promises";
import path from "node:path";

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export class StateStore {
  constructor({ stateFile, latestMovementsFile, maxSeenMovements }) {
    this.stateFile = stateFile;
    this.latestMovementsFile = latestMovementsFile;
    this.maxSeenMovements = maxSeenMovements;
    this.state = {
      version: 1,
      seen: {},
      lastRunAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      heartbeat: null
    };
  }

  getHeartbeat() {
    return this.state.heartbeat;
  }

  async setHeartbeat(reference) {
    this.state.heartbeat = reference;
    await this.save();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      this.state = { ...this.state, ...JSON.parse(raw) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  hasFingerprint(fingerprint) {
    return Boolean(this.state.seen[fingerprint]);
  }

  async rememberMovement(movement) {
    this.state.seen[movement.fingerprint] = {
      firstSeenAt: new Date().toISOString(),
      movement
    };
    this.prune();
    await this.save();
  }

  async recordLatestMovements(movements) {
    await ensureParentDir(this.latestMovementsFile);
    await fs.writeFile(
      this.latestMovementsFile,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          count: movements.length,
          movements
        },
        null,
        2
      )
    );
  }

  async markRunSuccess() {
    this.state.lastRunAt = new Date().toISOString();
    this.state.lastSuccessAt = this.state.lastRunAt;
    this.state.lastErrorAt = null;
    this.state.lastErrorMessage = null;
    await this.save();
  }

  async markRunFailure(error) {
    this.state.lastRunAt = new Date().toISOString();
    this.state.lastErrorAt = this.state.lastRunAt;
    this.state.lastErrorMessage = error.message;
    await this.save();
  }

  async save() {
    await ensureParentDir(this.stateFile);
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  prune() {
    const entries = Object.entries(this.state.seen);
    if (entries.length <= this.maxSeenMovements) return;

    entries
      .sort((a, b) => {
        const left = a[1]?.firstSeenAt || "";
        const right = b[1]?.firstSeenAt || "";
        return left.localeCompare(right);
      })
      .slice(0, entries.length - this.maxSeenMovements)
      .forEach(([fingerprint]) => {
        delete this.state.seen[fingerprint];
      });
  }
}
