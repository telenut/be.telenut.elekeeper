'use strict';

// Settings use human-readable values; the v2 client uses these node IDs.
const API_REGIONS = Object.freeze({
  europe: 'eu',
  international: 'in',
});

function getApiRegion(region = 'europe') {
  if (!Object.prototype.hasOwnProperty.call(API_REGIONS, region)) {
    throw new Error('Invalid network node. Select Europe or International.');
  }
  return API_REGIONS[region];
}

module.exports = { getApiRegion };
