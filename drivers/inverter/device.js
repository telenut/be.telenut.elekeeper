'use strict';

const { Device } = require('homey');
const { num, stat, batteryPowerHomey, gridPowerHomey } = require('../../lib/ElekeeperApi');
const PlantPoller = require('../../lib/PlantPoller');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // Elekeeper refreshes its data about every 5 minutes
const FAILURES_BEFORE_UNAVAILABLE = 3;

// Capabilities added after the first release; added on init so existing users keep their device
const ADDED_CAPABILITIES = [
  'meter_power.today',
  'measure_battery',
  'measure_power.battery',
  'measure_power.grid',
  'measure_power.load',
  'meter_power.imported_today',
  'meter_power.exported_today',
];

class InverterDevice extends Device {
  async onInit() {
    this.log('Elekeeper SAJ Inverter started');

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

  get poller() {
    return this.homey.app.getPoller(
      this.getStoreValue('username'),
      this.getStoreValue('password'),
      this.getStoreValue('region') || 'eu',
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
      // Devices paired before 1.4 have no plant stored: remember the plant they resolved to
      if (!this.getStoreValue('plantUid') && s.plant && s.plant.plantUid) {
        await this.setStoreValue('plantUid', s.plant.plantUid).catch(this.error);
        await this.setStoreValue('region', this.getStoreValue('region') || 'eu').catch(this.error);
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

    const set = (cap, value) => this.setCapabilityValue(cap, value === undefined ? null : value).catch(this.error);

    await set('measure_power', pvPower);
    await set('meter_power', totalYield);
    await set('meter_power.today', todayYield);

    await set('measure_power.grid', gridPowerHomey(flow));
    await set('measure_power.load', num(flow.totalLoadPowerwatt));
    await set('meter_power.imported_today', stat(s.stats, 'BUY_AND_SELL', 'energy1Today'));
    await set('meter_power.exported_today', stat(s.stats, 'BUY_AND_SELL', 'energy2Today'));

    await this.updatePvStrings(s.pvStrings);

    const hasBattery = PlantPoller.hasBattery(s);
    await set('measure_battery', hasBattery ? PlantPoller.batterySoc(s) : null);
    await set('measure_power.battery', hasBattery ? batteryPowerHomey(flow) : null);

    if (pvPower !== null && pvPower !== this.lastPower) {
      this.homey.app.triggerPowerChanged(this, { power: pvPower }).catch(this.error);
      this.lastPower = pvPower;
    }
    if (todayYield !== null && todayYield !== this.lastYield) {
      this.homey.app.triggerTodayYieldChanged(this, { yield: todayYield }).catch(this.error);
      this.lastYield = todayYield;
    }

    this.log(`✅ Update [index ${index}]: PV=${pvPower}W | today=${todayYield}kWh | grid=${gridPowerHomey(flow)}W`
      + ` | load=${num(flow.totalLoadPowerwatt)}W | battery=${hasBattery ? `${PlantPoller.batterySoc(s)}% (${batteryPowerHomey(flow)}W)` : 'none'}`);
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
      await this.setCapabilityValue(powerCap, num(pv.pvpower)).catch(this.error);
      await this.setCapabilityValue(voltCap, num(pv.pvvolt)).catch(this.error);
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('region')) {
      const baseUrl = getBaseUrl(newSettings.region);
      // Finish in-flight requests before switching so an old-node login cannot
      // overwrite the new session or send its token to the other node.
      await this.updatePromise;
      this.baseUrl = baseUrl;
      this.invalidateToken();
      this.log(`Network node changed to ${newSettings.region}. Signing in again...`);
    }
    if (changedKeys.includes('inverter_index')) {
      this.log(`Index changed from ${oldSettings.inverter_index} to ${newSettings.inverter_index}. Refreshing...`);
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
