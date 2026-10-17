'use strict';

/**
 * Elekeeper (SAJ eSolar) cloud API client.
 *
 * Elekeeper moved its web client from api/v1 (signed query strings) to api/v2
 * (signed headers + JSON body). The v1 login token makes most v2 endpoints return
 * empty data, while the v2 login token works for both, so this client always logs
 * in through v2 and only uses v1 for per-string PV detail (getOneDeviceInfo).
 *
 * The request signing is ported from the Home Assistant integration
 * elboletaire/ha-saj-esolar-cloud (v1.1.0, AGPL/GPL), which in turn extracted the
 * keys from the Elekeeper web bundle.
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

const REGIONS = {
  eu: 'https://eop.saj-electric.com/dev-api',
  in: 'https://iop.saj-electric.com/dev-api',
  cn: 'https://op.saj-electric.cn/dev-api',
};

const PASSWORD_KEY = 'ec1840a7c53cf0709eb784be480379b6';
const V1_SIGN_KEY = 'ktoKRLgQPjvNyUZO8lVc9kU1Bsip6XIe';
const V2_SIGN_KEY = 'b389a704-31f1-463d-8db7-435b18d1311d';
const V2_UNSIGNED_HEADERS = new Set(['x-timestamp', 'x-trace-id', 'x-sign', 'x-sign-enable']);

const DEFAULT_TIMEOUT_MS = 15 * 1000;
const DEFAULT_TOKEN_MAX_AGE_MS = 30 * 60 * 1000;

const V1 = {
  deviceInfo: '/monitor/device/getOneDeviceInfo',
};

const V2 = {
  login: '/sys/user/login',
  plantList: '/monitor/plant/getEndUserPlantList',
  plantDetail: '/monitor/plant/getOnePlantInfoV2',
  plantCapability: '/monitor/plant/getPlantCapability',
  plantStatistics: '/monitor/plantHome/getPlantEnergyStatistics',
  energyFlow: '/monitor/plantHome/getDeviceEnergyFlowDiagram',
  deviceTree: '/monitor/plantDevice/listForWeb',
  deviceCapability: '/monitor/inverter/getDeviceCapability',
  inverterEnergy: '/monitor/device/getInverterEnergyDetail',
  deviceAlarms: '/devicedata/alarm/device/userAlarmPage',
};

// Error codes Elekeeper returns when the session/token is missing, expired, or invalid.
// Notably, SAJ returns HTTP 200 with errCode 10002 ("Please login first") when a token expires.
const SESSION_ERROR_CODES = [10001, 10002, 10004, 20002, 401, 403];
const SESSION_ERROR_PATTERN = /please login|login first|token|session|unauthorized|unauthenticated|niet.*geldig/i;

class ElekeeperError extends Error {
  constructor(message, { code = null, status = null, session = false } = {}) {
    super(message);
    this.name = 'ElekeeperError';
    this.code = code;
    this.status = status;
    this.session = session;
  }
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars.charAt(crypto.randomInt(chars.length));
  return out;
}

function today() {
  // Elekeeper expects the client's local date (YYYY-MM-DD)
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function encryptPassword(plain) {
  // AES-128-ECB with PKCS7 padding (Node's default), hex output
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(PASSWORD_KEY, 'hex'), null);
  return cipher.update(plain, 'utf8', 'hex') + cipher.final('hex');
}

/** v1: sign query parameters (md5 of the sorted query + key, then upper-case sha1). */
function signV1(params) {
  const keys = Object.keys(params).sort();
  const query = keys.map((k) => `${k}=${params[k]}`).join('&') + `&key=${V1_SIGN_KEY}`;
  const md5 = crypto.createHash('md5').update(query, 'latin1').digest('hex');
  const signature = crypto.createHash('sha1').update(md5, 'utf8').digest('hex').toUpperCase();
  return { ...params, signParams: Object.keys(params).join(','), signature };
}

/** v2: build the signed headers and raw JSON body, as the Elekeeper web client does. */
function signV2(body, token, lang = 'en') {
  const timestamp = Date.now();
  const clientDate = today();

  const data = {};
  const merged = {
    ...body,
    appProjectName: 'elekeeper',
    clientDate,
    lang,
    timeStamp: timestamp,
    clientId: 'esolar-monitor-admin',
    clientCode: 'organization',
    themeColor: 'light',
  };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== null && v !== '') data[k] = v;
  }

  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'X-Trace-Id': randomString(16),
    'X-App-Project-Name': 'elekeeper',
    'X-Client-Date': clientDate,
    'X-Lang': lang,
    'X-Timestamp': String(timestamp),
    'X-Client-Code': 'organization',
    'X-Theme-Color': 'light',
  };
  if (token) headers.Authorization = token;

  const raw = JSON.stringify(data);

  // Signed parameters: the X-* headers without the "x-" prefix (except the unsigned ones),
  // plus the md5 of the body, sorted by name, followed by nonce and timestamp.
  const params = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith('x-') && !V2_UNSIGNED_HEADERS.has(lower)) params[lower.slice(2)] = v;
  }
  params.body = crypto.createHash('md5').update(raw, 'utf8').digest('hex');
  const parts = Object.keys(params)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k}=${params[k]}`);
  parts.push(`nonce=${headers['X-Trace-Id']}`);
  parts.push(`timestamp=${headers['X-Timestamp']}`);
  headers['X-Sign'] = crypto.createHmac('sha256', V2_SIGN_KEY).update(parts.join('&')).digest('hex');

  return { headers, raw };
}

class ElekeeperApi {
  /**
   * @param {object} opts
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {string} [opts.region='eu']
   * @param {number} [opts.timeoutMs=15000]
   * @param {number} [opts.tokenMaxAgeMs=1800000]
   * @param {function} [opts.fetchImpl]
   * @param {function} [opts.log]
   */
  constructor({
    username,
    password,
    region = 'eu',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tokenMaxAgeMs = DEFAULT_TOKEN_MAX_AGE_MS,
    fetchImpl = fetch,
    log = () => {},
  }) {
    this.username = username;
    this.password = password;
    this.baseUrl = REGIONS[region] || REGIONS.eu;
    this.timeoutMs = timeoutMs;
    this.tokenMaxAgeMs = tokenMaxAgeMs;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.token = null;
    this.tokenAt = 0;
    this._loginPromise = null;
  }

  invalidate() {
    this.token = null;
    this.tokenAt = 0;
  }

  hasValidToken() {
    if (!this.token || !this.tokenAt) return false;
    return (Date.now() - this.tokenAt) < this.tokenMaxAgeMs;
  }

  /**
   * Execute an HTTP request and read its JSON response with a strict timeout guard
   * covering connection, headers, and response body streaming.
   */
  async _requestJson(url, options, what) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let response = null;
    let timer = null;

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) {
          try { controller.abort(); } catch (_) { /* ignore */ }
        }
        if (response && response.body && typeof response.body.destroy === 'function') {
          try { response.body.destroy(); } catch (_) { /* ignore */ }
        }
        reject(new ElekeeperError(`${what}: request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    const requestPromise = (async () => {
      const fetchOpts = { ...options, timeout: this.timeoutMs };
      if (controller) fetchOpts.signal = controller.signal;
      response = await this.fetchImpl(url, fetchOpts);
      const data = await this._json(response, what);
      return { response, data };
    })();

    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _json(response, what) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ElekeeperError(`Non-JSON response for ${what} (HTTP ${response.status}): ${text.slice(0, 200)}`, {
        status: response.status,
      });
    }
  }

  _check(response, data, what) {
    if (response.status === 401 || response.status === 403) {
      this.invalidate();
      throw new ElekeeperError(`${what}: HTTP ${response.status}`, { status: response.status, session: true });
    }
    if (!response.ok) {
      throw new ElekeeperError(`${what}: HTTP ${response.status}`, { status: response.status });
    }
    const code = data && data.errCode;
    if (code !== undefined && code !== null && code !== 0) {
      const numericCode = Number(code);
      const msg = (data && data.errMsg) ? String(data.errMsg) : '';
      const session = what !== 'login' && (
        SESSION_ERROR_CODES.includes(numericCode)
        || SESSION_ERROR_CODES.includes(code)
        || SESSION_ERROR_PATTERN.test(msg)
      );
      if (session) this.invalidate();
      throw new ElekeeperError(`${what}: errCode ${code} ${msg}`.trim(), { code, session });
    }
    return data;
  }

  async login() {
    const { headers, raw } = signV2({
      username: this.username,
      password: encryptPassword(this.password),
      rememberMe: false,
      loginType: 1,
    });
    try {
      const { response, data } = await this._requestJson(
        `${this.baseUrl}/api/v2${V2.login}`,
        { method: 'POST', headers, body: raw },
        'login',
      );
      this._check(response, data, 'login');
      const d = data.data || {};
      if (!d.token) throw new ElekeeperError(`login: no token in response (keys: ${Object.keys(d).join(',')})`);
      this.token = (d.tokenHead || 'Bearer ') + d.token;
      this.tokenAt = Date.now();
      return true;
    } catch (err) {
      this.invalidate();
      throw err;
    }
  }

  async _ensureLogin() {
    if (this.hasValidToken()) return;
    this.invalidate();
    if (!this._loginPromise) {
      this._loginPromise = this.login().finally(() => {
        this._loginPromise = null;
      });
    }
    await this._loginPromise;
  }

  /** POST a signed v2 request. Retries once with a fresh login on a session error. */
  async v2(name, body = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this._ensureLogin();
      const { headers, raw } = signV2(body, this.token);
      try {
        const { response, data } = await this._requestJson(
          `${this.baseUrl}/api/v2${V2[name]}`,
          { method: 'POST', headers, body: raw },
          name,
        );
        return this._check(response, data, name);
      } catch (err) {
        if (err instanceof ElekeeperError && err.session && attempt === 0) {
          this.log(`Session expired on ${name} (${err.message}), re-authenticating...`);
          this.invalidate();
          continue;
        }
        throw err;
      }
    }
    throw new ElekeeperError(`${name}: session could not be restored`, { session: true });
  }

  /** GET a signed v1 request (v2 token). Retries once with a fresh login on a session error. */
  async v1(name, params = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this._ensureLogin();
      const query = new URLSearchParams(signV1({
        ...params,
        appProjectName: 'elekeeper',
        clientDate: today(),
        lang: 'en',
        timeStamp: String(Date.now()),
        random: randomString(32),
        clientId: 'esolar-monitor-admin',
      })).toString();
      try {
        const { response, data } = await this._requestJson(
          `${this.baseUrl}/api/v1${V1[name]}?${query}`,
          { headers: { Authorization: this.token, 'Cache-Control': 'no-cache' } },
          `${name} (v1)`,
        );
        return this._check(response, data, `${name} (v1)`);
      } catch (err) {
        if (err instanceof ElekeeperError && err.session && attempt === 0) {
          this.log(`Session expired on ${name} (v1) (${err.message}), re-authenticating...`);
          this.invalidate();
          continue;
        }
        throw err;
      }
    }
    throw new ElekeeperError(`${name}: session could not be restored`, { session: true });
  }

  // ---- High level calls ------------------------------------------------------

  async getPlants() {
    const res = await this.v2('plantList', { pageNo: 1, pageSize: 500 });
    return (res.data && res.data.list) || [];
  }

  /** Serial (inverter or EMS module) the plant home endpoints must be queried with. */
  async getQueryDevice(plantUid) {
    const res = await this.v2('plantCapability', { plantUid });
    const list = (res.data && res.data.snList) || [];
    if (!list.length) return {};
    return { sn: list[0].sn, snType: list[0].snType };
  }

  /** Inverters (deviceType 1) of a plant. */
  async getInverters(plantUid) {
    const res = await this.v2('deviceTree', { plantUid });
    return (res.data || []).filter((d) => d.deviceType === 1);
  }

  async getEnergyFlow(plantUid, queryDevice) {
    const res = await this.v2('energyFlow', { plantUid, ...queryDevice });
    return res.data || {};
  }

  async getPlantStatistics(plantUid, queryDevice) {
    const res = await this.v2('plantStatistics', { plantUid, ...queryDevice });
    return res.data || {};
  }

  async getInverterEnergy(deviceSn) {
    const res = await this.v2('inverterEnergy', { deviceSn });
    return res.data || {};
  }

  /** Per string PV data (pvNo, pvvolt, pvcurr, pvpower), v1 device detail. */
  async getPvStrings(deviceSn) {
    const res = await this.v1('deviceInfo', { deviceSn });
    const list = res.data && res.data.deviceStatisticsData && res.data.deviceStatisticsData.pvList;
    return Array.isArray(list) ? list : [];
  }
}

// ---- Parsing helpers shared by the driver --------------------------------------

/** Number or null if missing/empty/not a number. Tolerates a trailing "%". */
function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseFloat(String(value).replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Value from the plant statistics energyDataList, e.g. stat(stats, 'BUY_AND_SELL', 'energy1Today').
 * Entries are keyed by dataType (PV_ENERGY, LOAD_ENERGY, BUY_AND_SELL, CHARGE_AND_DISCHARGE).
 * For the paired ones energy1 is buy/charge and energy2 is sell/discharge.
 * Returns null if the entry is missing (the HA integration returns 0 there).
 */
function stat(stats, dataType, field) {
  const list = (stats && stats.energyDataList) || [];
  const entry = list.find((e) => e && e.dataType === dataType);
  return entry ? num(entry[field]) : null;
}

/** Direction codes used by the energy flow: -1 / 0 / 1 */
const DIRECTION = { IMPORT_OR_CHARGE: -1, IDLE: 0, EXPORT_OR_DISCHARGE: 1 };

/**
 * Grid power in Homey cumulative/meter convention (import positive, export negative).
 * Elekeeper reports sysGridPowerwatt unsigned with gridDirection 1 = export, -1 = import.
 */
function gridPowerHomey(flow) {
  const p = num(flow && flow.sysGridPowerwatt);
  if (p === null) return null;
  // Same rule as the HA integration: only 1 (export) makes it negative.
  const dir = parseInt(flow.gridDirection, 10) || 0;
  return dir === DIRECTION.EXPORT_OR_DISCHARGE ? -Math.abs(p) : Math.abs(p);
}

module.exports = {
  ElekeeperApi,
  ElekeeperError,
  SESSION_ERROR_CODES,
  num,
  stat,
  gridPowerHomey,
  REGIONS,
  // exported for tests
  _internal: { signV1, signV2, encryptPassword },
};
