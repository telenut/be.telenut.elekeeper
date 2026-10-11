'use strict';

const { Device } = require('homey');
const { num, stat, batteryPowerHomey } = require('../../lib/ElekeeperApi');
const PlantPoller = require('../../lib/PlantPoller');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const FAILURES_BEFORE_UNAVAILABLE = 3;

/**
 * Home battery (Homey Energy). measure_power follows the Homey convention for home
 * batteries: positive while charging, negative while discharging.
 */
class BatteryDevice extends Device {
  async onInit() {
    this.log('Elekeeper Battery started');
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
    if (this.isUpdating) return;
    this.isUpdating = true;
    try {
      const index = this.getSetting('inverter_index') || 0;
      const s = await this.poller.snapshot(this.getStoreValue('plantUid'), index);
      await this.applySnapshot(s);
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

  async applySnapshot(s) {
    const flow = s.flow || {};
    const info = s.batteryInfo || {};
    const first = (s.batteryList && s.batteryList[0]) || {};

    if (this.getSetting('debug_logging')) {
      this.log('Battery snapshot:', JSON.stringify({ flow, batteryInfo: info, batteryList: s.batteryList, stats: s.stats }));
    }

    const set = (cap, value) => this.setCapabilityValue(cap, value === undefined ? null : value).catch(this.error);

    const soc = PlantPoller.batterySoc(s);
    const power = batteryPowerHomey(flow);

    await set('measure_battery', soc);
    await set('measure_power', power);

    // Lifetime counters (system totals). Only set when reported, so Homey Energy never sees a drop to 0.
    const totalCharged = num(info.totalBatChgEnergy);
    const totalDischarged = num(info.totalBatDisEnergy);
    if (totalCharged !== null) await set('meter_power.charged', totalCharged);
    if (totalDischarged !== null) await set('meter_power.discharged', totalDischarged);

    await set('meter_power.charged_today',
      num(info.todayBatChgEnergy) ?? stat(s.stats, 'CHARGE_AND_DISCHARGE', 'energy1Today'));
    await set('meter_power.discharged_today',
      num(info.todayBatDisEnergy) ?? stat(s.stats, 'CHARGE_AND_DISCHARGE', 'energy2Today'));

    await set('saj_operating_mode', info.userModeName || flow.userModeName || null);

    // Temperature from the battery list, added only when the plant reports it
    const temp = num(first.batTemperature);
    if (temp !== null) {
      if (!this.hasCapability('measure_temperature')) await this.addCapability('measure_temperature').catch(this.error);
      await set('measure_temperature', temp);
    }

    this.log(`✅ Battery: ${soc}% | ${power}W | mode=${info.userModeName || flow.userModeName || '?'}`
      + ` | charged=${totalCharged}kWh discharged=${totalDischarged}kWh`);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('inverter_index')) {
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

module.exports = BatteryDevice;
