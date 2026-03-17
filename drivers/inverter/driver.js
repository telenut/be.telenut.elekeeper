const { Driver } = require('homey');

class InverterDriver extends Driver {
  async onPair(session) {
    // Luister naar het 'login' event vanuit start.html
    session.setHandler('login', async (data) => {
      if (!data.username || !data.password) {
        throw new Error('Vul a.u.b. zowel gebruikersnaam als wachtwoord in.');
      }

      // We slaan de gegevens veilig op in de "store" van het apparaat
      return {
        name: 'SAJ Omvormer',
        data: {
          id: 'saj_inverter_' + data.username 
        },
        store: {
          username: data.username,
          password: data.password
        }
      };
    });
  }
}

module.exports = InverterDriver;