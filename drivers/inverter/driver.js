'use strict';

const { Driver } = require('homey');

class InverterDriver extends Driver {
  async onInit() {
    this.log('Elekeeper Inverter Driver has been initialized');

    // Condition cards are registered once here (not per device)
    this.homey.flow.getConditionCard('power_greater_than')
      .registerRunListener(async (args) => (args.device.getCapabilityValue('measure_power') || 0) > args.power);

    this.homey.flow.getConditionCard('power_less_than')
      .registerRunListener(async (args) => (args.device.getCapabilityValue('measure_power') || 0) < args.power);

    this.homey.flow.getConditionCard('battery_greater_than')
      .registerRunListener(async (args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc > args.percentage;
      });

    this.homey.flow.getConditionCard('battery_less_than')
      .registerRunListener(async (args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc < args.percentage;
      });
  }

  async onPair(session) {
    session.setHandler('login', async (data) => {
      this.log('Login attempt for:', data.username);

      // Validate the credentials before creating the device, and remember the plant
      const poller = this.homey.app.getPoller(data.username, data.password, 'eu');
      let plants;
      try {
        plants = await poller.discover();
      } catch (err) {
        this.error('Login failed:', err.message);
        throw new Error(this.homey.__('pair.login_failed', { message: err.message }));
      }
      if (!plants.length) throw new Error(this.homey.__('pair.no_plants'));

      const { plant, inverters } = plants[0];
      const model = inverters[0] && inverters[0].deviceModel;
      return {
        name: model ? `Elekeeper ${model}` : 'Elekeeper Inverter',
        data: {
          id: `elekeeper_${data.username}_${Date.now()}`,
        },
        store: {
          username: data.username,
          password: data.password,
          region: 'eu',
          plantUid: plant.plantUid,
        },
      };
    });
  }
}

module.exports = InverterDriver;
