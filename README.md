# homebridge-ecobee-security

Shows **ecobee Smart Security** in Apple Home as a security system: arm **Stay**, arm **Away**,
**disarm**, and **Alarm triggered** when ecobee has an open intrusion or smoke incident. Works with
Siri ("set the security system to away") and Home automations. ecobee removed Smart Security from
its HomeKit integration; this brings it back.

Unofficial. It uses the same cloud API as the ecobee iOS app (Auth0 sign-in at `auth.ecobee.com`,
GraphQL at `federated-api.prod.federated-graph.generacapis.com`), which ecobee can change at any time.
No dependencies.

> [!WARNING]
> Not affiliated with or endorsed by ecobee. The plugin signs in as the ecobee iOS app, which
> ecobee may not allow, and it can stop working whenever ecobee changes its app or API.
> If you have **professional monitoring**, testing an alarm (opening a door while armed) can
> lead to a call from the monitoring centre or a dispatch, just as it would with the ecobee app.

## Install

In the Homebridge UI, search the Plugins tab for **ecobee Smart Security**, or:

```
npm install -g homebridge-ecobee-security
```

Running it as a child bridge is recommended. Requires Node 22 or 24 and Homebridge 1.8 or 2.x.

## Sign-in

Open the plugin's **Settings** in the Homebridge UI and sign in with your ecobee email and password,
then the verification code if your account uses MFA. The plugin saves a refresh token in its config;
your password is sent only to ecobee and isn't stored. Restart the bridge afterwards.

The plugin renews its access token every 2 hours and keeps the current refresh token in
`<homebridge storage>/ecobee-security/state.json` (mode 600). A newly saved token always replaces the
stored one. You only need to sign in again if ecobee revokes the token (for example after a password
change or "sign out of all devices"); the log then says so and the accessory shows a fault.

**If sign-in fails** (for example ecobee asks for a CAPTCHA), the settings page also offers sign-in
on ecobee's website: you sign in in a desktop browser and paste the final redirect URL from its
developer tools.

**Without the Homebridge UI**, sign in from a terminal and paste the printed token into the config:

```
node <plugin folder>/bin/ecobee-login.js            # email, password, MFA code
node <plugin folder>/bin/ecobee-login.js --browser  # website sign-in
```

## Config

```json
{
  "platform": "EcobeeSecurityPlatform",
  "name": "Security System",
  "refreshToken": "…",
  "pollInterval": 10,
  "_bridge": { "username": "…", "port": 51926, "name": "Ecobee Security Bridge" }
}
```

`homeId` is only needed if the account has several homes (the log lists them).

## How it behaves

- **Arm Away** uses ecobee's Away exit delay (60 s by default), just like the app. During the
  delay the Home app shows "Arming…" (current Disarmed, target Away). Stay uses the Stay exit delay
  (0 by default). Disarm needs no PIN.
- **Changes from elsewhere** (ecobee app, keypad, ecobee automations) show up within the poll
  interval (10 s by default), and quickly after an exit delay ends.
- **Alarm triggered** while ecobee lists an incident whose status isn't resolved/closed/cancelled.
  ecobee opens an incident as soon as a door opens while armed, during the entry delay, so the
  tile shows Alarm triggered from that moment, as the ecobee app does; disarming clears it.
  Every change in the incident list is logged.
- **Siri** calls Stay "Home": "set the security system to Home". Saying "arm … for stay" makes
  Siri pick Away.
- **Night** isn't offered; ecobee has no Night mode.
- After three failed reads in a row the accessory shows a fault; reads back off up to 5 minutes.
- **Hold for other plugins:** a Unix socket at `<homebridge storage>/ecobee-security/control.sock`
  (mode 600, homebridge user only) lets another plugin, e.g. homebridge-narwal, ask for a temporary
  Stay: `POST /hold?by=<name>` switches Away (or arming Away) to Stay and remembers it;
  `POST /release?by=<name>` arms Away again — unless the state was changed by anyone in between, in
  which case the hold is just dropped. The hold survives restarts (in `state.json`). `/hold`
  answers `ok: false` when the alarm is triggered or the state is unknown.

## API notes

[docs/api.md](docs/api.md) describes the sign-in flow and GraphQL calls the plugin uses, for anyone
fixing it after an ecobee change or adding features.

## License

MIT
