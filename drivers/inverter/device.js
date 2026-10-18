'use strict';

const { Device } = require('homey');
const { num, stat, gridPowerHomey } = require('../../lib/ElekeeperApi');
const { getApiRegion } = require('../../lib/regions');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // Elekeeper refreshes its data about every 5 minutes
const FAILURES_BEFORE_UNAVAILABLE = 3;

// Capabilities added after the first release; added on init so existing users keep their device
const ADDED_CAPABILITIES = [
  'meter_power.today',
  'measure_power.grid',
  'measure_power.load',
  'meter_power.imported_today',
  'meter_power.exported_today',
];

// Battery capabilities removed when focusing Elekeeper strictly on solar inverters
const REMOVED_CAPABILITIES = [
  'measure_battery',
  'measure_power.battery',
];

class InverterDevice extends Device {
  async onInit() {
    this.log('Elekeeper SAJ Inverter started');

    for (const cap of REMOVED_CAPABILITIES) {
      if (this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }
    for (const cap of ADDED_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    this.lastPower = null;
    this.lastYield = null;
    this.failures = 0;
    this.isUpdating = false;

    this.pollInterval = this.homey.setInterval(() => this.updateData(), POLL_INTERVAL_MS);
    await this.updateData();
  }

  _resolveApiRegion() {
    const stored = this.getStoreValue('region');
    if (stored === 'eu' || stored === 'in' || stored === 'cn') return stored;
    try {
      return getApiRegion(this.getSetting('region') || 'europe');
    } catch (_) {
      return 'eu';
    }
  }

  get poller() {
    return this.homey.app.getPoller(
      this.getStoreValue('username'),
      this.getStoreValue('password'),
      this._resolveApiRegion(),
    );
  }

  async updateData() {
    if (this.isUpdating) {
      this.log('Previous update still running; skipping this poll.');
      return;
    }
    this.isUpdating = true;
    this.updatePromise = this.runDataUpdate();
    return this.updatePromise;
  }

  async runDataUpdate() {
    try {
      const index = this.getSetting('inverter_index') || 0;
      const s = await this.poller.snapshot(this.getStoreValue('plantUid') || null, index);
      await this.applySnapshot(s, index);
      // Devices paired before 1.3.7 have no plant stored: remember the plant they resolved to
      if (!this.getStoreValue('plantUid') && s.plant && s.plant.plantUid) {
        await this.setStoreValue('plantUid', s.plant.plantUid).catch(this.error);
        await this.setStoreValue('region', this._resolveApiRegion()).catch(this.error);
      }
      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable().catch(this.error);
    } catch (err) {
      this.failures++;
      this.error(`Update failed (${this.failures}x):`, err.message);
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE) {
        await this.setUnavailable(err.message).catch(this.error);
      }
    } finally {
      this.isUpdating = false;
    }
  }

  async applySnapshot(s, index) {
    if (this.getSetting('debug_logging')) {
      this.log(`Snapshot [index ${index}]:`, JSON.stringify({
        inverter: s.inverter, inverterEnergy: s.inverterEnergy, flow: s.flow, stats: s.stats,
      }));
    }

    const e = s.inverterEnergy || {};
    const flow = s.flow || {};

    // PV production: inverter energy detail first (same as the HA integration), energy flow as fallback
    const pvPower = num(e.powerNow) ?? num(flow.pvPower) ?? num(flow.totalPvPower);
    const totalYield = num(e.totalEnergy) ?? stat(s.stats, 'PV_ENERGY', 'energyTotal');
    const todayYield = num(e.todayEnergy) ?? stat(s.stats, 'PV_ENERGY', 'energy1Today');
    const gridPower = gridPowerHomey(flow);
    const loadPower = num(flow.totalLoadPowerwatt);
    const importedToday = stat(s.stats, 'BUY_AND_SELL', 'energy1Today');
    const exportedToday = stat(s.stats, 'BUY_AND_SELL', 'energy2Today');

    // Only update a capability when a valid numeric value is present so a transient failure
    // on an optional endpoint never overwrites cumulative/daily meters with null.
    const setIfPresent = async (cap, value) => {
      if (value !== null && value !== undefined) {
        await this.setCapabilityValue(cap, value).catch(this.error);
      }
    };

    await setIfPresent('measure_power', pvPower);
    await setIfPresent('meter_power', totalYield);
    await setIfPresent('meter_power.today', todayYield);

    await setIfPresent('measure_power.grid', gridPower);
    await setIfPresent('measure_power.load', loadPower);
    await setIfPresent('meter_power.imported_today', importedToday);
    await setIfPresent('meter_power.exported_today', exportedToday);

    await this.updatePvStrings(s.pvStrings);

    if (pvPower !== null && pvPower !== this.lastPower) {
      this.homey.app.triggerPowerChanged(this, { power: pvPower }).catch(this.error);
      this.lastPower = pvPower;
    }
    if (todayYield !== null && todayYield !== this.lastYield) {
      this.homey.app.triggerTodayYieldChanged(this, { yield: todayYield }).catch(this.error);
      this.lastYield = todayYield;
    }

    this.log(`✅ Update [index ${index}]: PV=${pvPower}W | today=${todayYield}kWh | total=${totalYield}kWh`
      + ` | grid=${gridPower}W | load=${loadPower}W`);
  }

  // Adds measure_power.pvN / measure_voltage.pvN per reported string, so an inverter with
  // 2 strings doesn't get 6 empty tiles. On null (endpoint failed) the old values stay.
  async updatePvStrings(pvList) {
    if (!pvList) return;
    for (let i = 0; i < pvList.length; i++) {
      const pv = pvList[i] || {};
      const n = parseInt(pv.pvNo, 10) || (i + 1);
      const powerCap = `measure_power.pv${n}`;
      const voltCap = `measure_voltage.pv${n}`;
      if (!this.hasCapability(powerCap)) {
        await this.addCapability(powerCap).catch(this.error);
        await this.setCapabilityOptions(powerCap, { title: this.homey.__('pv_power_title', { n }) }).catch(this.error);
      }
      if (!this.hasCapability(voltCap)) {
        await this.addCapability(voltCap).catch(this.error);
        await this.setCapabilityOptions(voltCap, { title: this.homey.__('pv_voltage_title', { n }) }).catch(this.error);
      }
      const pVal = num(pv.pvpower);
      const vVal = num(pv.pvvolt);
      if (pVal !== null) await this.setCapabilityValue(powerCap, pVal).catch(this.error);
      if (vVal !== null) await this.setCapabilityValue(voltCap, vVal).catch(this.error);
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('region')) {
      const apiRegion = getApiRegion(newSettings.region);
      if (this.updatePromise) {
        await this.updatePromise.catch(() => {});
      }
      if (this.poller && typeof this.poller.invalidate === 'function') {
        this.poller.invalidate();
      }
      await this.setStoreValue('region', apiRegion);
      this.log(`Network node changed to ${newSettings.region}. Signing in again...`);
    }
    if (changedKeys.includes('inverter_index')) {
      if (this.poller && typeof this.poller.clearCache === 'function') {
        this.poller.clearCache();
      }
      this.log(`Index changed from ${oldSettings.inverter_index} to ${newSettings.inverter_index}. Refreshing...`);
    }
    if (changedKeys.includes('region') || changedKeys.includes('inverter_index')) {
      this.homey.setTimeout(() => this.updateData(), 1000);
    }
  }

  onDeleted() {
    if (this.pollInterval) this.homey.clearInterval(this.pollInterval);
  }

  onUninit() {
    if (this.pollInterval) this.homey.clearInterval(this.pollInterval);
  }
}

module.exports = InverterDevice;
