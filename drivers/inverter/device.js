const { Device } = require('homey');
const fetch = require('node-fetch');
const crypto = require('crypto');

class InverterDevice extends Device {
  async onInit() {
    this.log('Elekeeper SAJ Inverter is gestart');
    
    if (!this.hasCapability('meter_power.today')) {
      await this.addCapability('meter_power.today').catch(this.error);
    }
    
    // Zorg dat de nieuwe batterij-capabilities dynamisch worden toegevoegd bij bestaande gebruikers
    if (!this.hasCapability('measure_battery')) {
      await this.addCapability('measure_battery').catch(this.error);
    }
    if (!this.hasCapability('measure_power.battery')) {
      await this.addCapability('measure_power.battery').catch(this.error);
    }
    
    this.username = this.getStoreValue('username');
    this.password = this.getStoreValue('password');
    this.baseUrl = 'https://eop.saj-electric.com/dev-api/api/v1'; 
    this.token = null;
    this.lastPower = null;
    this.lastYield = null;

    this.pollInterval = this.homey.setInterval(() => {
      this.updateData();
    }, 1000 * 60 * 5); 
    
    await this.updateData();

    // EN kaart: Opbrengst groter dan
    this.homey.flow.getConditionCard('power_greater_than')
      .registerRunListener(async (args, state) => {
        const currentPower = args.device.getCapabilityValue('measure_power') || 0;
        return currentPower > args.power;
      });

    // EN kaart: Opbrengst lager dan
    this.homey.flow.getConditionCard('power_less_than')
      .registerRunListener(async (args, state) => {
        const currentPower = args.device.getCapabilityValue('measure_power') || 0;
        return currentPower < args.power;
      });

    // EN kaart: Batterijniveau hoger dan
    this.homey.flow.getConditionCard('battery_greater_than')
      .registerRunListener(async (args, state) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc > args.percentage;
      });

    // EN kaart: Batterijniveau lager dan
    this.homey.flow.getConditionCard('battery_less_than')
      .registerRunListener(async (args, state) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc < args.percentage;
      });
  }

  encryptPassword(plainPassword) {
    const key = Buffer.from('ec1840a7c53cf0709eb784be480379b6', 'hex');
    const cipher = crypto.createCipheriv('aes-128-ecb', key, '');
    let encrypted = cipher.update(plainPassword, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  }

  generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  signPayload(payload) {
    const QUERY_SIGN_KEY = 'ktoKRLgQPjvNyUZO8lVc9kU1Bsip6XIe';
    const keys = Object.keys(payload).sort();
    const keysStr = keys.join(',');
    const sortedItems = keys.map(k => `${k}=${payload[k]}`);
    const queryString = sortedItems.join('&') + '&key=' + QUERY_SIGN_KEY;
    const md5Hash = crypto.createHash('md5').update(queryString, 'latin1').digest('hex');
    const signature = crypto.createHash('sha1').update(md5Hash, 'utf8').digest('hex').toUpperCase();
    return { ...payload, signParams: keysStr, signature: signature };
  }

  async login() {
    try {
      const loginUrl = `${this.baseUrl}/sys/login`;
      const dataToSign = {
        appProjectName: 'elekeeper', clientDate: new Date().toISOString().split('T')[0], lang: 'en',
        timeStamp: String(Date.now()), random: this.generateRandomString(32), clientId: 'esolar-monitor-admin'
      };
      const finalPayload = {
        ...this.signPayload(dataToSign),
        username: this.username, password: this.encryptPassword(this.password),
        rememberMe: 'false', loginType: 1
      };
      const formParams = new URLSearchParams();
      for (const key in finalPayload) { formParams.append(key, finalPayload[key]); }
      const response = await fetch(loginUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formParams.toString()
      });
      const data = await response.json();
      if (data && data.errCode === 0 && data.data) {
        this.token = (data.data.tokenHead || '') + data.data.token;
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  async updateData() {
    if (!this.token) {
      this.log('Geen actieve token gevonden. Bezig met inloggen...');
      const loggedIn = await this.login();
      if (!loggedIn) {
        this.error('Inloggen mislukt, update overgeslagen.');
        return; 
      }
    }

    try {
      const basePayload = {
        appProjectName: 'elekeeper', clientDate: new Date().toISOString().split('T')[0], lang: 'en',
        timeStamp: String(Date.now()), random: this.generateRandomString(32), clientId: 'esolar-monitor-admin'
      };
      const fetchHeaders = { 
        'Authorization': this.token, 
        'Cache-Control': 'no-cache',
        'User-Agent': 'Homey (be.telenut.elekeeper)' 
      };

      const listParams = new URLSearchParams(this.signPayload({ ...basePayload, pageNo: 1, pageSize: 50 })).toString();
      const listResponse = await fetch(`${this.baseUrl}/monitor/plant/getEndUserPlantList?${listParams}`, { headers: fetchHeaders });
      
      if (listResponse.status === 401 || listResponse.status === 403) {
        this.log('⚠️ HTTP 401/403: Sessie niet langer geldig. Token wordt gereset...');
        this.token = null;
        return;
      }
      
      const listData = await listResponse.json();
      
      if (listData && listData.errCode !== 0) {
        this.log(`⚠️ API Fout bij plant-lijst: ${listData.errCode} - ${listData.errMsg}`);
        if ([10001, 10004, 20002].includes(listData.errCode)) {
          this.token = null;
        }
        return;
      }
      
      if (!listData.data?.list?.length) return;
      const plantUid = listData.data.list[0].plantUid;

      const devParams = new URLSearchParams(this.signPayload({ 
        ...basePayload, plantUid: plantUid, pageSize: 100, pageNo: 1, searchOfficeIdArr: "1"
      })).toString();
      const devResponse = await fetch(`${this.baseUrl}/monitor/device/getDeviceList?${devParams}`, { headers: fetchHeaders });
      const devData = await devResponse.json();

      if (devData.errCode === 0 && devData.data?.list?.length > 0) {
        const inverterIndex = this.getSetting('inverter_index') || 0;
        
        if (inverterIndex >= devData.data.list.length) {
          this.log(`⚠️ Gevraagde index ${inverterIndex} bestaat niet. Er zijn maar ${devData.data.list.length} omvormers.`);
          return;
        }

        const device = devData.data.list[inverterIndex];
        
        // Print de röntgenfoto zodat testers met een batterij hun JSON met ons kunnen delen!
        this.log(`Röntgenfoto [Index ${inverterIndex}]:`, JSON.stringify(device));

        const currentPower = parseFloat(device.active_power || device.power || device.activePower || device.powerNow || 0); 
        const totalYield = parseFloat(device.total_yield || device.energy_total || device.totalEnergy || device.totalYield || 0); 
        const todayYield = parseFloat(device.daily_yield || device.todayEnergy || device.todayYield || 0); 

        // Batterij-uitlezing logica
        // De devicelijst zet hasBattery soms op 0 terwijl er wel een batterij is (bv. SAJ CH2 ESS-cabinet).
        // Daarom: batterij aanwezig als hasBattery==1 OF als er een geldig batEnergyPercent in de lijst staat
        // OF als het energiestroom-endpoint hasBattery==1 meldt.
        const listSoc = this.parseNumber(device.batEnergyPercent);
        let energyFlow = null;
        if (device.deviceSn) {
          energyFlow = await this.fetchEnergyFlow(basePayload, fetchHeaders, plantUid, device.deviceSn);
        }
        const flowSoc = energyFlow ? this.parseNumber(energyFlow.batEnergyPercent) : null;

        const hasBattery = parseInt(device.hasBattery || 0) === 1
          || listSoc !== null
          || (energyFlow && parseInt(energyFlow.hasBattery || 0) === 1);

        let batterySoc = null;
        let batteryPower = null;

        if (hasBattery) {
          batterySoc = flowSoc !== null ? flowSoc : listSoc;

          // batteryDirection: -1 = laden, 0 = stand-by, 1 = ontladen (bevestigd met een CH2 cabinet en
          // de Home Assistant integratie ha-saj-esolar-cloud).
          // Homey-richtlijn: laden is positief (+), ontladen is negatief (-).
          const rawBatPower = this.parseNumber(
            energyFlow?.batPower ?? device.batPower ?? device.batteryPower
          );
          const direction = parseInt(energyFlow?.batteryDirection ?? device.batteryDirection ?? 0);
          if (rawBatPower !== null) {
            batteryPower = direction === 1 ? -Math.abs(rawBatPower) : Math.abs(rawBatPower);
            if (direction === 0 && rawBatPower === 0) batteryPower = 0;
          }
        }

        // Updates sturen naar Homey interface
        await this.setCapabilityValue('measure_power', currentPower).catch(this.error);
        await this.setCapabilityValue('meter_power', totalYield).catch(this.error);
        await this.setCapabilityValue('meter_power.today', todayYield).catch(this.error);
        
        // Alleen updaten als er daadwerkelijk een batterij is; anders netjes op null
        await this.setCapabilityValue('measure_battery', hasBattery ? batterySoc : null).catch(this.error);
        await this.setCapabilityValue('measure_power.battery', hasBattery ? batteryPower : null).catch(this.error);

        if (currentPower !== this.lastPower) {
          this.homey.app.triggerPowerChanged(this, { power: currentPower }).catch(this.error);
          this.lastPower = currentPower;
        }
        if (todayYield !== this.lastYield) {
          this.homey.app.triggerTodayYieldChanged(this, { yield: todayYield }).catch(this.error);
          this.lastYield = todayYield;
        }
        this.log(`✅ Update [Index ${inverterIndex}]: Nu=${currentPower}W | Vandaag=${todayYield}kWh | Batterij=${hasBattery ? `${batterySoc}% (${batteryPower}W)` : 'geen'}`);
      } else if (devData.errCode !== 0) {
        this.log(`⚠️ API Fout bij device-lijst: ${devData.errCode}`);
        if ([10001, 10004, 20002].includes(devData.errCode)) {
          this.token = null;
        }
      }
    } catch (error) {
      this.error('Update fout:', error.message);
    }
  }

  // Geeft een getal terug, of null als het veld ontbreekt/leeg/geen getal is
  parseNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }

  // Energiestroom-endpoint: bevat hasBattery, batEnergyPercent, batPower en batteryDirection,
  // ook voor systemen waar de devicelijst hasBattery=0 meldt.
  async fetchEnergyFlow(basePayload, fetchHeaders, plantUid, deviceSn) {
    try {
      const params = new URLSearchParams(this.signPayload({
        ...basePayload, random: this.generateRandomString(32), timeStamp: String(Date.now()),
        plantUid, deviceSn
      })).toString();
      const response = await fetch(`${this.baseUrl}/monitor/home/getDeviceEneryFlowData?${params}`, { headers: fetchHeaders });
      const data = await response.json();
      if (data && data.errCode === 0 && data.data) return data.data;
      this.log(`⚠️ Energiestroom niet beschikbaar: ${data && data.errCode} - ${data && data.errMsg}`);
    } catch (error) {
      this.log('⚠️ Energiestroom ophalen mislukt:', error.message);
    }
    return null;
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('inverter_index')) {
      this.log(`Index gewijzigd van ${oldSettings.inverter_index} naar ${newSettings.inverter_index}. Verversen...`);
      this.homey.setTimeout(() => { this.updateData(); }, 1000);
    }
  }

  onDeleted() {
    if (this.pollInterval) this.homey.clearInterval(this.pollInterval);
  }
}

module.exports = InverterDevice;