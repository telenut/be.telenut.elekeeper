'use strict';

const { ElekeeperApi, num } = require('./ElekeeperApi');

/**
 * Fetches one consistent snapshot of a plant (inverter, energy flow, statistics, battery)
 * and caches it briefly, so several Homey devices on the same account (inverter + battery)
 * share one login and one round of requests per poll.
 */
class PlantPoller {
  constructor({ username, password, region = 'eu', log = () => {}, error = () => {} }) {
    this.api = new ElekeeperApi({ username, password, region, log });
    this.log = log;
    this.error = error;
    this.cacheMs = 60 * 1000;
    this.cache = new Map(); // key -> { at, data }
    this.inflight = new Map(); // key -> Promise
    this.warned = new Set(); // optional endpoints that are currently failing (logged once)
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

    const promise = this._fetch(plantUid, inverterIndex)
      .then((data) => {
        this.cache.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async _fetch(plantUid, inverterIndex) {
    const plants = await this.api.getPlants();
    if (!plants.length) throw new Error('No plants found on this Elekeeper account');
    const plant = plantUid ? plants.find((p) => p.plantUid === plantUid) : plants[0];
    if (!plant) throw new Error(`Plant ${plantUid} not found on this account`);
    const uid = plant.plantUid;

    // Core data: failures here fail the snapshot so devices don't show stale zeros
    const queryDevice = await this.api.getQueryDevice(uid);
    const flow = await this.api.getEnergyFlow(uid, queryDevice);

    // Everything below is optional: a failure only leaves those values empty
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

    const stats = await optional('Plant statistics', () => this.api.getPlantStatistics(uid, queryDevice), {});
    const inverters = await optional('Inverter list', () => this.api.getInverters(uid), []);

    let inverter = null;
    let inverterEnergy = {};
    let batteryInfo = {};
    let pvStrings = null;
    if (inverters.length) {
      if (inverterIndex >= inverters.length) {
        this.log(`⚠️ Inverter index ${inverterIndex} does not exist, there are ${inverters.length} inverter(s)`);
      } else {
        inverter = inverters[inverterIndex];
        inverterEnergy = await optional('Inverter energy', () => this.api.getInverterEnergy(inverter.deviceSn), {});
        batteryInfo = await optional('Battery info', () => this.api.getBatteryInfo(inverter.deviceSn), {});
        pvStrings = await optional('PV strings', () => this.api.getPvStrings(inverter.deviceSn), null);
      }
    }
    const batteryList = await optional('Battery list', () => this.api.getBatteryList(uid), []);

    return {
      fetchedAt: Date.now(),
      plant,
      queryDevice,
      inverters,
      inverter,
      inverterEnergy,
      flow,
      stats,
      batteryInfo,
      batteryList,
      pvStrings,
    };
  }

  /** Battery state of charge from whichever endpoint reports it. */
  static batterySoc(s) {
    const candidates = [
      s.inverterEnergy && s.inverterEnergy.batterySoc,
      s.flow && s.flow.batEnergyPercent,
      s.batteryInfo && s.batteryInfo.batEnergyPercent,
      s.batteryList && s.batteryList[0] && s.batteryList[0].batSoc,
    ];
    for (const c of candidates) {
      const n = num(c);
      if (n !== null) return n;
    }
    return null;
  }

  static hasBattery(s) {
    return PlantPoller.batterySoc(s) !== null
      || num(s.flow && s.flow.batPower) !== null && parseInt(s.flow.hasBattery || 0, 10) === 1;
  }
}

module.exports = PlantPoller;
