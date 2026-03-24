"use strict";

const { Driver } = require('homey');

class InverterDriver extends Driver {
  async onInit() {
    this.log('Elekeeper Inverter Driver has been initialized');
  }

  async onPair(session) {
    session.setHandler('login', async (data) => {
      this.log('Ontvangen login poging voor:', data.username);
      
      // We bouwen hier het apparaat op dat jouw start.html verwacht
      const device = {
        name: "Elekeeper Inverter",
        data: {
          // Homey eist een unieke ID. We maken er een op basis van je username en de tijd
          id: `elekeeper_${data.username}_${Date.now()}` 
        },
        store: {
          // Hier slaan we je inloggegevens op, zodat device.js ze straks kan gebruiken!
          username: data.username,
          password: data.password
        }
      };

      // Stuur het apparaat terug naar start.html (dit wordt de 'device' in je callback)
      return device; 
    });
  }
}

module.exports = InverterDriver;