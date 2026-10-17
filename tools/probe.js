#!/usr/bin/env node
'use strict';

/**
 * Elekeeper probe: logs in and dumps the raw responses of every endpoint the app uses,
 * so field names can be verified for a given inverter model.
 *
 * Usage (from the app folder, after `npm install`):
 *   ELEKEEPER_USER='you@example.com' ELEKEEPER_PASS='secret' node tools/probe.js [region]
 *
 * region: eu (default), in or cn. The result is written to elekeeper-probe.json.
 * Credentials, tokens, addresses and coordinates are redacted from the output.
 */

const fs = require('fs');
const path = require('path');
const { ElekeeperApi } = require('../lib/ElekeeperApi');

const REDACT = /^(token|tokenHead|password|email|phone|mobile|address|addr|.*Address|latitude|longitude|lat|lng|lon|userName|username|ownerName|nickName|realName|contact.*)$/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.test(k) && v !== null && v !== '' && typeof v !== 'object' ? '<redacted>' : redact(v);
    }
    return out;
  }
  return value;
}

async function main() {
  const username = process.env.ELEKEEPER_USER;
  const password = process.env.ELEKEEPER_PASS;
  const region = process.argv[2] || 'eu';
  if (!username || !password) {
    console.error('Set ELEKEEPER_USER and ELEKEEPER_PASS');
    process.exit(1);
  }

  const api = new ElekeeperApi({ username, password, region, log: console.log });
  const out = { probedAt: new Date().toISOString(), region, results: {} };

  // Run a call, store its full response (or the error) under a name
  const step = async (name, fn) => {
    try {
      const res = await fn();
      out.results[name] = res;
      console.log(`OK    ${name}`);
      return res;
    } catch (err) {
      out.results[name] = { error: err.message, code: err.code, status: err.status };
      console.log(`FAIL  ${name}: ${err.message}`);
      return null;
    }
  };

  await step('login', async () => { await api.login(); return { ok: true }; });

  const plants = await step('plantList', () => api.v2('plantList', { pageNo: 1, pageSize: 500 }));
  const list = (plants && plants.data && plants.data.list) || [];
  if (!list.length) {
    console.log('No plants found.');
  }

  for (const [i, plant] of list.entries()) {
    const plantUid = plant.plantUid;
    const p = `plant${i}`;
    await step(`${p}.detail`, () => api.v2('plantDetail', { plantUid }));
    const cap = await step(`${p}.capability`, () => api.v2('plantCapability', { plantUid }));
    const snList = (cap && cap.data && cap.data.snList) || [];
    const query = snList.length ? { sn: snList[0].sn, snType: snList[0].snType } : {};
    await step(`${p}.energyFlow`, () => api.v2('energyFlow', { plantUid, ...query }));
    await step(`${p}.statistics`, () => api.v2('plantStatistics', { plantUid, ...query }));
    const tree = await step(`${p}.deviceTree`, () => api.v2('deviceTree', { plantUid }));

    const devices = (tree && tree.data) || [];
    for (const dev of devices.filter((d) => d.deviceType === 1)) {
      const deviceSn = dev.deviceSn;
      const d = `${p}.inverter.${deviceSn}`;
      await step(`${d}.energy`, () => api.v2('inverterEnergy', { deviceSn }));
      await step(`${d}.capability`, () => api.v2('deviceCapability', { deviceSn }));
      await step(`${d}.pvStrings.v1`, () => api.v1('deviceInfo', { deviceSn }));
      await step(`${d}.alarms`, () => api.v2('deviceAlarms', { deviceSn, alarmCommonState: 1, pageNo: 1, pageSize: 10 }));
    }
  }

  const file = path.resolve(process.cwd(), 'elekeeper-probe.json');
  fs.writeFileSync(file, JSON.stringify(redact(out), null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
