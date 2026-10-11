'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  batteryPowerHomey,
  gridPowerHomey,
  _internal,
} = require('../lib/ElekeeperApi');
const { getApiRegion } = require('../lib/regions');

test('maps the selectable Elekeeper nodes to API v2 regions', () => {
  assert.equal(getApiRegion('europe'), 'eu');
  assert.equal(getApiRegion('international'), 'in');
  assert.throws(() => getApiRegion('invalid'), /Invalid network node/);
});

test('uses Homey charge/discharge and import/export power conventions', () => {
  assert.equal(batteryPowerHomey({ batPower: 800, batteryDirection: -1 }), 800);
  assert.equal(batteryPowerHomey({ batPower: 800, batteryDirection: 1 }), -800);
  assert.equal(gridPowerHomey({ sysGridPowerwatt: 500, gridDirection: -1 }), 500);
  assert.equal(gridPowerHomey({ sysGridPowerwatt: 500, gridDirection: 1 }), -500);
});

test('signs v2 requests without exposing the plaintext password', () => {
  const encrypted = _internal.encryptPassword('secret');
  assert.notEqual(encrypted, 'secret');
  const signed = _internal.signV2({ username: 'test', password: encrypted });
  assert.ok(signed.headers['X-Sign']);
  assert.match(signed.raw, /"username":"test"/);
  assert.doesNotMatch(signed.raw, /"password":"secret"/);
});
