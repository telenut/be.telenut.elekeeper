const Homey = require('homey');

class ElekeeperApp extends Homey.App {
  async onInit() {
    this.log('Elekeeper App is initializing...');
  }

  // Functie om de trigger voor vermogen af te vuren
  async triggerPowerChanged(device, tokens) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard('power_changed');
      if (trigger) {
        await trigger.trigger(device, tokens);
      }
    } catch (err) {
      this.error('Fout bij het afvuren van de power_changed flow:', err.message);
    }
  }

  // Functie om de trigger voor dagopbrengst af te vuren
  async triggerTodayYieldChanged(device, tokens) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard('today_yield_changed');
      if (trigger) {
        await trigger.trigger(device, tokens);
      }
    } catch (err) {
      this.error('Fout bij het afvuren van de today_yield_changed flow:', err.message);
    }
  }
}

module.exports = ElekeeperApp;