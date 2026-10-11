# Install the International-node build on Homey Pro

This is a modified copy of https://github.com/telenut/be.telenut.elekeeper
based on commit bcace59. It has not been published to GitHub or the Homey App Store.

## On your computer

1. Install Node.js 24 or newer, then extract this ZIP.
2. Open a terminal in the extracted `be.telenut.elekeeper` folder.
3. Run:

```sh
npm install --global homey
npm ci
npm test
homey login
homey select
homey app install
```

Select your Homey Pro when prompted. This installs a development build that keeps running when the terminal closes. You do not need `homey app run` for this installation.

This build keeps the original app ID, so it replaces the installed Elekeeper app. Keep your existing device rather than uninstalling it. App Store updates may overwrite this development build; if the selector disappears, reinstall this copy. To return to the official version, reinstall the App Store app.

## In Homey

For an existing Elekeeper device, open the device settings, then Advanced settings. Change **Network node** to **International (Other Countries)** and save.

For a new device, add an Elekeeper Inverter, enter your Elekeeper credentials and select **International** before adding it. Homey checks the credentials against the selected node before it creates the device.

The first refresh is requested about one second after switching nodes, after any existing requests finish. Later refreshes remain every five minutes. If no values appear, use `homey app run --remote` to inspect logs; this is a temporary debugging session and stopping it uninstalls the development app. Do not share passwords, tokens, serial numbers, or full account/device logs publicly.

## Scope and verification

- Adds Europe / International during pairing and in advanced device settings.
- Validates credentials against the selected node before creating a device.
- Localizes the pairing screen in English, Dutch and Spanish.
- Defaults existing devices to Europe until changed.
- Routes login, plant/device lists, energy flow and PV detail requests to one selected node.
- Waits for an in-flight update before discarding its session and switching nodes.
- Five mocked regression tests passed and `homey app validate` passed at publish level.
- Real SAJ login, inverter discovery and physical Homey behavior are not yet tested.
- Does not add whole-house consumption or Panasonic aircon status. These require subsequent work after access is confirmed.

Tests: `npm test`.

SAJ International portal: https://iop.saj-electric.com/
Homey CLI documentation: https://apps.developer.homey.app/the-basics/getting-started/homey-cli
