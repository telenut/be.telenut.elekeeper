'use strict';

const { Driver } = require('homey');
const PlantPoller = require('../../lib/PlantPoller');

class BatteryDriver extends Driver {
  async onInit() {
    this.log('Elekeeper Battery Driver has been initialized');
  }

  async onPair(session) {
    session.setHandler('login', async (data) => {
      this.log('Battery login attempt for:', data.username);

      const poller = this.homey.app.getPoller(data.username, data.password, 'eu');
      let plants;
      try {
        plants = await poller.discover();
      } catch (err) {
        this.error('Login failed:', err.message);
        throw new Error(this.homey.__('pair.login_failed', { message: err.message }));
      }
      if (!plants.length) throw new Error(this.homey.__('pair.no_plants'));

      // Only offer the device when the plant actually reports a battery
      const { plant } = plants[0];
      const snapshot = await poller.snapshot(plant.plantUid, 0);
      if (!PlantPoller.hasBattery(snapshot)) {
        throw new Error(this.homey.__('pair.no_battery'));
      }

      const model = snapshot.inverter && snapshot.inverter.deviceModel;
      return {
        name: model ? `${model} Battery` : 'Elekeeper Battery',
        data: {
          id: `elekeeper_battery_${plant.plantUid}`,
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

module.exports = BatteryDriver;
