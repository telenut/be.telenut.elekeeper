'use strict';

// Elekeeper web API nodes (not the separate SAJ developer/OpenAPI portals).
const BASE_URLS = Object.freeze({
  europe: 'https://eop.saj-electric.com/dev-api/api/v1',
  international: 'https://iop.saj-electric.com/dev-api/api/v1',
});

function getBaseUrl(region = 'europe') {
  if (!Object.prototype.hasOwnProperty.call(BASE_URLS, region)) {
    throw new Error('Invalid network node. Select Europe or International.');
  }
  return BASE_URLS[region];
}

module.exports = { getBaseUrl };
