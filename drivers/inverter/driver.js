"use strict";

const { Driver } = require('homey');
const fetch = require('node-fetch');
const { getBaseUrl } = require('../../lib/regions');
const { SajAuthenticationError, login } = require('../../lib/saj-auth');

class InverterDriver extends Driver {
  async onInit() {
    this.log('Elekeeper Inverter Driver has been initialized');
  }

  async onPair(session) {
    session.setHandler('login', async (data) => {
      const region = data.region === undefined ? 'europe' : data.region;
      const baseUrl = getBaseUrl(region);
      const username = typeof data.username === 'string' ? data.username.trim() : '';
      const password = typeof data.password === 'string' ? data.password : '';
      if (!username || !password) throw new Error(this.homey.__('pair.missing_credentials'));

      try {
        await this.validateCredentials({ baseUrl, username, password });
      } catch (error) {
        if (error instanceof SajAuthenticationError && error.reason === 'connection_failed') {
          throw new Error(this.homey.__('pair.connection_failed'));
        }
        throw new Error(this.homey.__('pair.login_failed'));
      }

      const device = {
        name: 'Elekeeper Inverter',
        data: {
          id: `elekeeper_${username}_${Date.now()}`,
        },
        settings: { region },
        store: {
          username,
          password,
        },
      };
      return device;
    });
  }

  async validateCredentials({ baseUrl, username, password }) {
    await login({
      baseUrl,
      username,
      password,
      fetchRequest: (url, options) => fetch(url, { ...options, timeout: 30000 }),
    });
  }
}

module.exports = InverterDriver;
