'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const {
  ElekeeperApi,
  SESSION_ERROR_CODES,
  num,
  stat,
  gridPowerHomey,
  batteryPowerHomey,
  _internal,
} = require('../lib/ElekeeperApi');
const PlantPoller = require('../lib/PlantPoller');
const { getApiRegion } = require('../lib/regions');

function loadWithMockHomey(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    require: (name) => (name === 'homey' ? { Driver: class {}, Device: class {} } : realRequire(name)),
  }, { filename });
  return module.exports;
}

const InverterDevice = loadWithMockHomey('drivers/inverter/device.js');

test('maps the selectable Elekeeper nodes to API v2 regions', () => {
  assert.equal(getApiRegion('europe'), 'eu');
  assert.equal(getApiRegion('international'), 'in');
  assert.throws(() => getApiRegion('invalid'), /Invalid network node/);
});

test('uses Homey import/export power conventions for grid power', () => {
  assert.equal(gridPowerHomey({ sysGridPowerwatt: 500, gridDirection: -1 }), 500);
  assert.equal(gridPowerHomey({ sysGridPowerwatt: 500, gridDirection: 1 }), -500);
  assert.equal(gridPowerHomey({}), null);
  assert.equal(num('95%'), 95);
  assert.equal(stat({ energyDataList: [{ dataType: 'PV_ENERGY', energyTotal: '123.4' }] }, 'PV_ENERGY', 'energyTotal'), 123.4);
});

test('signs v2 requests without exposing the plaintext password', () => {
  const encrypted = _internal.encryptPassword('secret');
  assert.notEqual(encrypted, 'secret');
  const signed = _internal.signV2({ username: 'test', password: encrypted });
  assert.ok(signed.headers['X-Sign']);
  assert.match(signed.raw, /"username":"test"/);
  assert.doesNotMatch(signed.raw, /"password":"secret"/);
});

test('includes errCode 10002 ("Please login first") in SESSION_ERROR_CODES and recovers automatically', async () => {
  assert.ok(SESSION_ERROR_CODES.includes(10002));

  let loginCalls = 0;
  let plantCalls = 0;

  const api = new ElekeeperApi({
    username: 'user@example.com',
    password: 'secret',
    fetchImpl: async (url) => {
      if (url.endsWith('/api/v2/sys/user/login')) {
        loginCalls++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            errCode: 0,
            data: { tokenHead: 'Bearer ', token: `token_${loginCalls}` },
          }),
        };
      }
      if (url.endsWith('/api/v2/monitor/plant/getEndUserPlantList')) {
        plantCalls++;
        if (plantCalls === 1) {
          // Simulate expired token on SAJ backend returning HTTP 200 + errCode 10002
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              connOk: true,
              errCode: 10002,
              errMsg: 'Please login first',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            errCode: 0,
            data: { list: [{ plantUid: 'p1' }] },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  // Prime with an existing (soon-to-expire) token
  api.token = 'Bearer stale_token';
  api.tokenAt = Date.now();

  const plants = await api.getPlants();
  assert.equal(plants.length, 1);
  assert.equal(plants[0].plantUid, 'p1');
  assert.equal(plantCalls, 2);
  assert.equal(loginCalls, 1);
  assert.equal(api.token, 'Bearer token_1');
});

test('proactively refreshes token when tokenMaxAgeMs has elapsed', async () => {
  let loginCalls = 0;
  const api = new ElekeeperApi({
    username: 'user@example.com',
    password: 'secret',
    tokenMaxAgeMs: 1000,
    fetchImpl: async (url) => {
      if (url.endsWith('/api/v2/sys/user/login')) {
        loginCalls++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            errCode: 0,
            data: { tokenHead: 'Bearer ', token: `fresh_${loginCalls}` },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ errCode: 0, data: { list: [] } }),
      };
    },
  });

  api.token = 'Bearer old_token';
  api.tokenAt = Date.now() - 5000; // older than tokenMaxAgeMs (1000ms)

  await api.getPlants();
  assert.equal(loginCalls, 1);
  assert.equal(api.token, 'Bearer fresh_1');
});

test('aborts hung HTTP requests and destroys stalled response bodies on timeout', async () => {
  let bodyDestroyed = false;
  const api = new ElekeeperApi({
    username: 'user@example.com',
    password: 'secret',
    timeoutMs: 30,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: {
        destroy() {
          bodyDestroyed = true;
        },
      },
      text: () => new Promise(() => {}), // hangs forever reading body
    }),
  });

  await assert.rejects(() => api.login(), /request timed out after 30ms/);
  assert.equal(bodyDestroyed, true);
  assert.equal(api.token, null);
});

test('PlantPoller enforces poll-level timeout, clears inflight, and invalidates token on failure', async () => {
  const poller = new PlantPoller({
    username: 'user@example.com',
    password: 'secret',
    pollTimeoutMs: 40,
  });
  poller.api.token = 'Bearer active';
  poller.api.tokenAt = Date.now();
  poller._fetch = () => new Promise(() => {}); // simulate hung poll

  await assert.rejects(() => poller.snapshot('plant1', 0), /Poll snapshot timed out after 40ms/);
  assert.equal(poller.inflight.size, 0);
  assert.equal(poller.api.token, null);
});

test('InverterDevice removes battery capabilities on init when battery reading is off and does not overwrite meters with null', async () => {
  const device = new InverterDevice();
  const caps = new Set(['measure_power', 'meter_power', 'measure_battery', 'measure_power.battery']);
  const written = [];

  device.log = () => {};
  device.error = () => {};
  device.hasCapability = (c) => caps.has(c);
  device.removeCapability = async (c) => { caps.delete(c); };
  device.addCapability = async (c) => { caps.add(c); };
  device.getSetting = () => false;
  device.setCapabilityValue = async (c, v) => { written.push([c, v]); };
  device.updatePvStrings = async () => {};
  device.updateData = async () => {};
  device.homey = {
    setInterval: () => 1,
    app: {
      triggerPowerChanged: async () => {},
      triggerTodayYieldChanged: async () => {},
    },
  };

  await device.onInit();
  assert.equal(caps.has('measure_battery'), false);
  assert.equal(caps.has('measure_power.battery'), false);
  assert.equal(caps.has('meter_power.today'), true);

  // When optional endpoints fail (inverterEnergy = {}, stats = {}), meter_power* must not be overwritten with null
  await device.applySnapshot({
    inverter: { deviceSn: 'SN1' },
    inverterEnergy: {},
    flow: { pvPower: 0, sysGridPowerwatt: 120, gridDirection: -1, totalLoadPowerwatt: 120 },
    stats: {},
    pvStrings: null,
  }, 0);

  const writtenMap = Object.fromEntries(written);
  assert.equal(writtenMap.measure_power, 0);
  assert.equal(writtenMap['measure_power.grid'], 120);
  assert.equal(writtenMap['measure_power.load'], 120);
  assert.equal('meter_power' in writtenMap, false);
  assert.equal('meter_power.today' in writtenMap, false);
  assert.equal('meter_power.imported_today' in writtenMap, false);
  assert.equal('meter_power.exported_today' in writtenMap, false);
});

test('InverterDevice reports battery level and power when battery reading is on', async () => {
  const device = new InverterDevice();
  const caps = new Set(['measure_power', 'meter_power']);
  const written = [];

  device.log = () => {};
  device.error = () => {};
  device.hasCapability = (c) => caps.has(c);
  device.removeCapability = async (c) => { caps.delete(c); };
  device.addCapability = async (c) => { caps.add(c); };
  device.setCapabilityOptions = async () => {};
  device.getSetting = (key) => key === 'read_battery';
  device.setCapabilityValue = async (c, v) => { written.push([c, v]); };
  device.updatePvStrings = async () => {};
  device.updateData = async () => {};
  device.homey = {
    __: (key) => key,
    setInterval: () => 1,
    app: {
      triggerPowerChanged: async () => {},
      triggerTodayYieldChanged: async () => {},
    },
  };

  await device.onInit();
  assert.equal(caps.has('measure_battery'), true);
  assert.equal(caps.has('measure_power.battery'), true);

  await device.applySnapshot({
    inverter: { deviceSn: 'SN1' },
    inverterEnergy: {},
    flow: { pvPower: 0, batEnergyPercent: '81%', batPower: 2201, batteryDirection: 1 },
    stats: {},
    pvStrings: null,
  }, 0);

  const writtenMap = Object.fromEntries(written);
  assert.equal(writtenMap.measure_battery, 81);
  assert.equal(writtenMap['measure_power.battery'], -2201); // discharging is negative

  // Turning the setting off removes the capabilities again
  await device.syncBatteryCapabilities(false);
  assert.equal(caps.has('measure_battery'), false);
  assert.equal(caps.has('measure_power.battery'), false);
});

test('batteryPowerHomey: charging positive, discharging negative', () => {
  assert.equal(batteryPowerHomey({ batPower: '1500', batteryDirection: -1 }), 1500);
  assert.equal(batteryPowerHomey({ batPower: '1500', batteryDirection: 1 }), -1500);
  assert.equal(batteryPowerHomey({}), null);
});

test('PlantPoller only calls the battery endpoints when battery is on and the energy flow has no SoC', async () => {
  const calls = [];
  const poller = new PlantPoller({ username: 'u', password: 'p' });
  poller.api = {
    invalidate() {},
    getPlants: async () => [{ plantUid: 'plant1' }],
    getQueryDevice: async () => ({}),
    getEnergyFlow: async () => ({ pvPower: 100 }),
    getPlantStatistics: async () => ({}),
    getInverters: async () => [{ deviceSn: 'SN1' }],
    getInverterEnergy: async () => ({}),
    getPvStrings: async () => [],
    getBatteryInfo: async () => { calls.push('info'); return {}; },
    getBatteryList: async () => { calls.push('list'); return [{ batSoc: '64' }]; },
  };

  const off = await poller.snapshot('plant1', 0);
  assert.deepEqual(calls, []);
  assert.equal(PlantPoller.batterySoc(off), null);

  const on = await poller.snapshot('plant1', 0, { battery: true });
  assert.deepEqual(calls, ['info', 'list']);
  assert.equal(PlantPoller.batterySoc(on), 64);

  // SoC already in the energy flow: no extra requests
  calls.length = 0;
  poller.clearCache();
  poller.api.getEnergyFlow = async () => ({ batEnergyPercent: '90' });
  const flowSoc = await poller.snapshot('plant1', 0, { battery: true });
  assert.deepEqual(calls, []);
  assert.equal(PlantPoller.batterySoc(flowSoc), 90);
});

test('manifest, compose, and locales are consistent, with battery support opt-in and all pairing translations', () => {
  const manifest = require('../app.json');
  const compose = require('../drivers/inverter/driver.compose.json');

  assert.equal(manifest.drivers.length, 1);
  assert.equal(manifest.drivers[0].id, 'inverter');
  assert.equal(manifest.capabilities, undefined);
  assert.equal(manifest.drivers[0].energy, undefined);
  assert.equal(compose.energy, undefined);
  // Battery capabilities are added per device only when "Read battery data" is on
  assert.ok(!manifest.drivers[0].capabilities.includes('measure_battery'));
  assert.ok(!manifest.drivers[0].capabilities.includes('measure_power.battery'));
  const readBattery = manifest.drivers[0].settings.find((x) => x.id === 'read_battery');
  assert.equal(readBattery && readBattery.value, false);
  for (const id of ['battery_greater_than', 'battery_less_than']) {
    assert.ok(manifest.flow.conditions.some((c) => c.id === id), `Missing condition ${id}`);
  }
  assert.deepEqual(compose.settings, manifest.drivers[0].settings);

  for (const lang of ['en', 'nl', 'es']) {
    const locale = require(`../locales/${lang}.json`);
    assert.equal(locale.pair.add_battery, undefined);
    assert.equal(locale.pair.no_battery, undefined);
    assert.ok(locale.battery_level_title, `Missing battery_level_title in locales/${lang}.json`);
    assert.ok(locale.battery_power_title, `Missing battery_power_title in locales/${lang}.json`);
    for (const key of [
      'title', 'subtitle', 'username', 'username_placeholder',
      'password', 'password_placeholder', 'network_node', 'europe',
      'international', 'node_hint', 'add_device', 'missing_credentials',
      'login_failed', 'no_plants', 'connection_failed',
    ]) {
      assert.ok(locale.pair[key], `Missing pair.${key} in locales/${lang}.json`);
    }
  }
});
