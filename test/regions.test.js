'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { getBaseUrl } = require('../lib/regions');
const { SajAuthenticationError, login } = require('../lib/saj-auth');

function load(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, URLSearchParams,
    require: name => name === 'homey' ? { Driver: class {}, Device: class {} } : realRequire(name),
  }, { filename });
  return module.exports;
}

const Driver = load('drivers/inverter/driver.js');
const Device = load('drivers/inverter/device.js');

test('existing installations default to Europe and unknown nodes are rejected', () => {
  assert.equal(getBaseUrl(), 'https://eop.saj-electric.com/dev-api/api/v1');
  assert.equal(getBaseUrl('international'), 'https://iop.saj-electric.com/dev-api/api/v1');
  assert.throws(() => getBaseUrl('https://other.example'), /Invalid network node/);
});

test('pairing persists the selected node and accepts old pairing payloads', async () => {
  let handler;
  const validatedNodes = [];
  const driver = new Driver();
  driver.homey = { __: key => key };
  driver.validateCredentials = async ({ baseUrl }) => { validatedNodes.push(baseUrl); };
  await driver.onPair({ setHandler: (event, fn) => { handler = fn; } });
  for (const region of [undefined, 'europe', 'international']) {
    const result = await handler({ username: 'test', password: 'test', region });
    assert.equal(result.settings.region, region ?? 'europe');
  }
  assert.deepEqual(validatedNodes, [getBaseUrl('europe'), getBaseUrl('europe'), getBaseUrl('international')]);
  await assert.rejects(handler({ username: '', password: '' }), /pair.missing_credentials/);
  await assert.rejects(handler({ region: 'invalid' }), /Invalid network node/);
});

test('pairing reports rejected credentials and does not create a device definition', async () => {
  let handler;
  const driver = new Driver();
  driver.homey = { __: key => key };
  driver.validateCredentials = async () => { throw new SajAuthenticationError('invalid_credentials'); };
  await driver.onPair({ setHandler: (event, fn) => { handler = fn; } });
  await assert.rejects(
    handler({ username: 'wrong@example.com', password: 'wrong', region: 'international' }),
    /pair.login_failed/,
  );
});

test('credential validation sends the login request only to the selected node', async () => {
  for (const region of ['europe', 'international']) {
    let requestedUrl;
    const token = await login({
      baseUrl: getBaseUrl(region),
      username: 'test@example.com',
      password: 'secret',
      fetchRequest: async (url, options) => {
        requestedUrl = url;
        assert.equal(options.method, 'POST');
        assert.match(options.body, /username=test%40example.com/);
        assert.doesNotMatch(options.body, /password=secret(?:&|$)/);
        return { ok: true, status: 200, json: async () => ({
          errCode: 0, data: { tokenHead: 'Bearer ', token: region },
        }) };
      },
    });
    assert.equal(requestedUrl, `${getBaseUrl(region)}/sys/login`);
    assert.equal(token, `Bearer ${region}`);
  }
});

test('both nodes route login, discovery, energy flow and PV details together', async () => {
  for (const region of ['europe', 'international']) {
    const device = new Device();
    Object.assign(device, {
      baseUrl: getBaseUrl(region), username: 'test', password: 'test', token: null,
      log() {}, error() {}, getSetting() { return 0; },
      async setCapabilityValue() {}, async updatePvStrings() {},
      homey: { app: {
        async triggerPowerChanged() {}, async triggerTodayYieldChanged() {},
      } },
    });
    const paths = [];
    device.fetchWithTimeout = async (url, options) => {
      assert.ok(url.startsWith(getBaseUrl(region) + '/'));
      const pathname = new URL(url).pathname.replace('/dev-api/api/v1', '');
      paths.push(pathname);
      if (pathname === '/sys/login') {
        assert.equal(options.headers.Authorization, undefined);
        return { ok: true, status: 200, json: async () => ({ errCode: 0, data: { token: region } }) };
      }
      assert.equal(options.headers.Authorization, region);
      const data = {
        '/monitor/plant/getEndUserPlantList': { list: [{ plantUid: 'plant' }] },
        '/monitor/device/getDeviceList': { list: [{ deviceSn: 'sn', activePower: 10 }] },
        '/monitor/home/getDeviceEneryFlowData': { hasBattery: 0 },
        '/monitor/device/getOneDeviceInfo': { deviceStatisticsData: { pvList: [] } },
      }[pathname];
      assert.ok(data, pathname);
      return { ok: true, status: 200, json: async () => ({ errCode: 0, data }) };
    };
    await device.updateData();
    assert.equal(paths.length, 5);
    assert.equal(device.isUpdating, false);
  }
});

test('changing nodes waits for old requests and discards the old token', async () => {
  const device = new Device();
  let finish;
  let refresh;
  device.baseUrl = getBaseUrl('europe');
  device.token = 'old';
  device.log = () => {};
  device.updatePromise = new Promise(resolve => { finish = resolve; });
  device.homey = { setTimeout: fn => { refresh = fn; } };
  const changing = device.onSettings({ oldSettings: { region: 'europe' },
    newSettings: { region: 'international' }, changedKeys: ['region'] });
  assert.equal(device.baseUrl, getBaseUrl('europe'));
  device.token = 'late-old-login';
  finish();
  await changing;
  assert.equal(device.baseUrl, getBaseUrl('international'));
  assert.equal(device.token, null);
  assert.equal(typeof refresh, 'function');
});

test('manifest and compose settings match, with the existing inverter index retained', () => {
  const manifest = require('../app.json').drivers[0];
  const compose = require('../drivers/inverter/driver.compose.json');
  assert.deepEqual(compose.settings, manifest.settings);
  assert.equal(manifest.settings[0].value, 'europe');
  assert.ok(manifest.settings.some(setting => setting.id === 'inverter_index'));
});
