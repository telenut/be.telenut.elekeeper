'use strict';

const { Driver } = require('homey');
const { getApiRegion } = require('../../lib/regions');

class InverterDriver extends Driver {
  async onInit() {
    this.log('Elekeeper Inverter Driver has been initialized');

    // Condition cards are registered once here (not per device)
    this.homey.flow.getConditionCard('power_greater_than')
      .registerRunListener(async (args) => (args.device.getCapabilityValue('measure_power') || 0) > args.power);

    this.homey.flow.getConditionCard('power_less_than')
      .registerRunListener(async (args) => (args.device.getCapabilityValue('measure_power') || 0) < args.power);
  }

  async onPair(session) {
    session.setHandler('login', async (data) => {
      const username = typeof data.username === 'string' ? data.username.trim() : '';
      const password = typeof data.password === 'string' ? data.password : '';
      if (!username || !password) {
        throw new Error(this.homey.__('pair.missing_credentials'));
      }

      this.log('Login attempt for:', username);

      // Validate the credentials before creating the device, and remember the plant
      const selectedNode = data.region || 'europe';
      const region = getApiRegion(selectedNode);
      const poller = this.homey.app.getPoller(username, password, region);
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
          id: `elekeeper_${username}_${Date.now()}`,
        },
        settings: {
          region: selectedNode,
        },
        store: {
          username,
          password,
          region,
          plantUid: plant.plantUid,
        },
      };
    });
  }
}

module.exports = InverterDriver;
