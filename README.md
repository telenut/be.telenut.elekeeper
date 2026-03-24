# Elekeeper / SAJ eSolar Inverters for Homey ☀️

Welcome to the Elekeeper / SAJ eSolar Inverters app for Homey! This app allows you to integrate your SAJ solar inverters directly into your Homey smart home ecosystem, using the Elekeeper cloud API.

## 🚀 Features

This app creates a seamless connection between your SAJ/Elekeeper inverter and Homey, providing live data and automation possibilities:

* **Live Solar Power (W):** Monitor the exact amount of power your solar panels are generating right now.
* **Daily Yield (kWh):** Keep track of the total energy generated today.
* **Total Yield (kWh):** View the all-time generated energy of your system.

### ⚙️ Flow Cards (Automations)

The app comes with built-in Flow triggers, allowing you to create smart automations:
* **Trigger:** *Power changed* - Start automations when your solar power goes above or drops below a certain threshold (e.g., "If power is > 2000W, start the washing machine").
* **Trigger:** *Today yield changed* - Trigger actions based on your daily solar harvest (e.g., "Send a push notification when daily yield reaches 15 kWh").

## 🛠 Installation & Setup

1. Install the Elekeeper app from the Homey App Store.
2. Go to your Homey devices and click the **+** to add a new device.
3. Search for **Elekeeper Inverter**.
4. Enter the **Username** and **Password** that you normally use to log into the official Elekeeper/SAJ mobile app or web portal.
5. The app will automatically authenticate, find your inverter, and start pulling live data!

*Note: The app polls the API for new data every 5 minutes to ensure your values are up to date without overloading the Elekeeper servers.*

## 💬 Community & Support

Do you have questions, feature requests, or want to share your awesome solar flows? Join the conversation on the official Homey Community Forum!

👉 [Elekeeper / SAJ eSolar Inverters on Homey Community Forum](https://community.homey.app/t/app-pro-elekeeper-saj-esolar-inverters/152892)

## 🐛 Bug Reports

If you encounter any issues or bugs, please open an issue in this GitHub repository with a clear description of the problem and your Homey firmware version.

## ⚖️ Disclaimer

*This app is an independent community project and is not affiliated with, endorsed by, or officially connected to SAJ Electric or the Elekeeper brand. Use at your own risk.*
