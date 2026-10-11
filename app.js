'use strict';

const Homey = require('homey');
const PlantPoller = require('./lib/PlantPoller');

class ElekeeperApp extends Homey.App {
  async onInit() {
    this.log('Elekeeper App is initializing...');
    // One poller per Elekeeper account, shared by all devices (inverter + battery)
    this.pollers = new Map();
  }

  /** Shared poller for an account. A changed password replaces the old poller. */
  getPoller(username, password, region = 'eu') {
    const key = `${region}|${username}`;
    const existing = this.pollers.get(key);
    if (existing && existing.api.password === password) return existing;
    const poller = new PlantPoller({
      username,
      password,
      region,
      log: (...args) => this.log(`[${username}]`, ...args),
      error: (...args) => this.error(`[${username}]`, ...args),
    });
    this.pollers.set(key, poller);
    return poller;
  }

  // Fires the power_changed flow trigger
  async triggerPowerChanged(device, tokens) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard('power_changed');
      if (trigger) {
        await trigger.trigger(device, tokens);
      }
    } catch (err) {
      this.error('Failed to fire the power_changed flow:', err.message);
    }
  }

  // Fires the today_yield_changed flow trigger
  async triggerTodayYieldChanged(device, tokens) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard('today_yield_changed');
      if (trigger) {
        await trigger.trigger(device, tokens);
      }
    } catch (err) {
      this.error('Failed to fire the today_yield_changed flow:', err.message);
    }
  }
}

module.exports = ElekeeperApp;
