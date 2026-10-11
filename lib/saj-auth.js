'use strict';

const crypto = require('crypto');

class SajAuthenticationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SajAuthenticationError';
    this.reason = reason;
  }
}

function encryptPassword(plainPassword) {
  const key = Buffer.from('ec1840a7c53cf0709eb784be480379b6', 'hex');
  const cipher = crypto.createCipheriv('aes-128-ecb', key, '');
  let encrypted = cipher.update(plainPassword, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function signPayload(payload) {
  const querySignKey = 'ktoKRLgQPjvNyUZO8lVc9kU1Bsip6XIe';
  const keys = Object.keys(payload).sort();
  const keysStr = keys.join(',');
  const sortedItems = keys.map(key => `${key}=${payload[key]}`);
  const queryString = `${sortedItems.join('&')}&key=${querySignKey}`;
  const md5Hash = crypto.createHash('md5').update(queryString, 'latin1').digest('hex');
  const signature = crypto.createHash('sha1').update(md5Hash, 'utf8').digest('hex').toUpperCase();
  return { ...payload, signParams: keysStr, signature };
}

async function login({ baseUrl, username, password, fetchRequest }) {
  const dataToSign = {
    appProjectName: 'elekeeper',
    clientDate: new Date().toISOString().split('T')[0],
    lang: 'en',
    timeStamp: String(Date.now()),
    random: generateRandomString(32),
    clientId: 'esolar-monitor-admin',
  };
  const finalPayload = {
    ...signPayload(dataToSign),
    username,
    password: encryptPassword(password),
    rememberMe: 'false',
    loginType: 1,
  };
  const formParams = new URLSearchParams();
  for (const key in finalPayload) formParams.append(key, finalPayload[key]);

  let response;
  try {
    response = await fetchRequest(`${baseUrl}/sys/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formParams.toString(),
    });
  } catch (error) {
    throw new SajAuthenticationError('connection_failed');
  }

  if (!response.ok) {
    throw new SajAuthenticationError(response.status === 401 || response.status === 403
      ? 'invalid_credentials'
      : 'connection_failed');
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new SajAuthenticationError('connection_failed');
  }
  if (!data || data.errCode !== 0 || !data.data?.token) {
    throw new SajAuthenticationError('invalid_credentials');
  }
  return (data.data.tokenHead || '') + data.data.token;
}

module.exports = {
  SajAuthenticationError,
  encryptPassword,
  generateRandomString,
  login,
  signPayload,
};
