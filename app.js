const Homey = require('homey');

class ElekeeperApp extends Homey.App {
  async onInit() {
    this.log('Elekeeper App is initializing...');
  }

  // Functie om de trigger voor vermogen op te halen en af te vuren
  async triggerPowerChanged(device, tokens) {
    const trigger = this.homey.flow.getDeviceTriggerCard('power_changed');
    if (trigger) {
      return trigger.trigger(device, tokens);
    }
  }

  // Functie om de trigger voor dagopbrengst op te halen en af te vuren
  async triggerTodayYieldChanged(device, tokens) {
    const trigger = this.homey.flow.getDeviceTriggerCard('today_yield_changed');
    if (trigger) {
      return trigger.trigger(device, tokens);
    }
  }
}

module.exports = ElekeeperApp;