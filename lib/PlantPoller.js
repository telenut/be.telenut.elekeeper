'use strict';

const { ElekeeperApi } = require('./ElekeeperApi');

const DEFAULT_POLL_TIMEOUT_MS = 60 * 1000;

/**
 * Fetches one consistent snapshot of a plant (inverter, energy flow, statistics)
 * and caches it briefly, so multiple inverter devices on the same account
 * share one login and one round of requests per poll.
 */
class PlantPoller {
  constructor({
    username,
    password,
    region = 'eu',
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    apiOptions = {},
    log = () => {},
    error = () => {},
  }) {
    this.api = new ElekeeperApi({ username, password, region, log, ...apiOptions });
    this.log = log;
    this.error = error;
    this.cacheMs = 60 * 1000;
    this.pollTimeoutMs = pollTimeoutMs;
    this.cache = new Map(); // key -> { at, data }
    this.inflight = new Map(); // key -> Promise
    this.warned = new Set(); // optional endpoints that are currently failing (logged once)
  }

  clearCache() {
    this.cache.clear();
  }

  invalidate() {
    this.cache.clear();
    this.api.invalidate();
  }

  /** Validate credentials and return the plants with their inverters (used when pairing). */
  async discover() {
    await this.api.login();
    const plants = await this.api.getPlants();
    const result = [];
    for (const plant of plants) {
      let inverters = [];
      try {
        inverters = await this.api.getInverters(plant.plantUid);
      } catch (err) {
        this.log(`Could not list inverters for plant ${plant.plantUid}: ${err.message}`);
      }
      result.push({ plant, inverters });
    }
    return result;
  }

  /**
   * @param {string|null} plantUid  null = first plant of the account (legacy devices)
   * @param {number} inverterIndex  index in the plant's inverter list
   */
  async snapshot(plantUid, inverterIndex = 0) {
    const key = `${plantUid || '*'}|${inverterIndex}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.data;
    if (this.inflight.has(key)) return this.inflight.get(key);

    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.api.invalidate();
        reject(new Error(`Poll snapshot timed out after ${this.pollTimeoutMs}ms`));
      }, this.pollTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });

    const promise = Promise.race([this._fetch(plantUid, inverterIndex), timeoutPromise])
      .then((data) => {
        this.cache.set(key, { at: Date.now(), data });
        return data;
      })
      .catch((err) => {
        // Invalidate the token on any unhandled snapshot failure so the next poll
        // starts with a clean login instead of getting stuck with a stale session.
        this.api.invalidate();
        throw err;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  async _fetch(plantUid, inverterIndex) {
    const plants = await this.api.getPlants();
    if (!plants.length) throw new Error('No plants found on this Elekeeper account');
    const plant = plantUid ? plants.find((p) => p.plantUid === plantUid) : plants[0];
    if (!plant) throw new Error(`Plant ${plantUid} not found on this account`);
    const uid = plant.plantUid;

    const optional = async (what, fn, fallback) => {
      try {
        const result = await fn();
        if (this.warned.delete(what)) this.log(`${what} available again`);
        return result;
      } catch (err) {
        if (!this.warned.has(what)) this.log(`⚠️ ${what} not available: ${err.message}`);
        this.warned.add(what);
        return fallback;
      }
    };

    const queryDevice = await optional('Plant capability', () => this.api.getQueryDevice(uid), {});
    const flow = await this.api.getEnergyFlow(uid, queryDevice);
    const stats = await optional('Plant statistics', () => this.api.getPlantStatistics(uid, queryDevice), {});
    const inverters = await optional('Inverter list', () => this.api.getInverters(uid), []);

    let inverter = null;
    let inverterEnergy = {};
    let pvStrings = null;
    if (inverters.length) {
      if (inverterIndex >= inverters.length) {
        this.log(`⚠️ Inverter index ${inverterIndex} does not exist, there are ${inverters.length} inverter(s)`);
      } else {
        inverter = inverters[inverterIndex];
        inverterEnergy = await optional('Inverter energy', () => this.api.getInverterEnergy(inverter.deviceSn), {});
        pvStrings = await optional('PV strings', () => this.api.getPvStrings(inverter.deviceSn), null);
      }
    }

    return {
      fetchedAt: Date.now(),
      plant,
      queryDevice,
      inverters,
      inverter,
      inverterEnergy,
      flow,
      stats,
      pvStrings,
    };
  }
}

module.exports = PlantPoller;
