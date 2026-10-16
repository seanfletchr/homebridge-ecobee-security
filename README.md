<p align="center"><img src="icon.png" alt="" width="100" height="100"></p>

# homebridge-ecobee-security

Shows **ecobee Smart Security** in Apple Home as a security system: set it to **Home**, **Away** or
**Off** (ecobee's Stay, Away and disarmed), and see **Alarm triggered** when ecobee has an open
intrusion or smoke incident. It also adds
**air quality** sensors for ecobee thermostats that have one (ecobee Premium), which ecobee's own
HomeKit integration leaves out. Works with
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
  "offerNight": false,
  "alarmTrigger": "incident",
  "smokeSensor": true,
  "allowHolds": false,
  "airQuality": true,
  "co2Alert": 1000,
  "_bridge": { "username": "…", "port": 51926, "name": "Ecobee Security Bridge" }
}
```

`homeId` is only needed if the account has several homes (the log lists them).

| Setting | Default | |
|---|---|---|
| `offerNight` | `false` | Adds Night to the Home app. ecobee has no Night mode, so Night arms ecobee's Stay, and the tile keeps showing Night until the state changes (Stay armed in the ecobee app or at the keypad shows as Home). HomeKit only picks up a changed list of modes on a new control, so changing this setting recreates the security system in the Home app: set up scenes and automations that use it again. |
| `alarmTrigger` | `"incident"` | When the tile enters **Triggered**: `"incident"` immediately, when ecobee opens an incident as a door or sensor trips while armed (mirrors the ecobee app); `"entryDelay"` only after the entry (disarm) delay runs out without a disarm. Smoke alarms always trigger immediately. |
| `smokeSensor` | `true` | Adds a separate **Smoke Alarm** accessory (a Smoke Sensor) that detects smoke while ecobee has a smoke-alarm incident open, for automations and Home app smoke notifications. Set to `false` to remove it. |
| `allowHolds` | `false` | Lets other plugins, like a robot vacuum, keep the system from arming Away while their task runs (see [Security holds](#security-holds)). |
| `holdPlugins` | all | The plugins allowed to do that; the settings page lists them. |
| `armAwayNowSwitch` | `false` | Adds an **Arm Away Now** switch: arms Away immediately and asks any task in progress to stop (a robot goes home). |
| `taskWaitSeconds` | `120` | How much longer the Away countdown may wait for a task to finish, e.g. a robot getting home (0: don't wait). |
| `airQuality` | `true` | For each thermostat with an air quality sensor: an accessory "&lt;thermostat&gt; Air Quality" with an **Air Quality Sensor** (overall level; VOC as ecobee reports it, in ppb, which the Home app labels µg/m³) and a **Carbon Dioxide Sensor** (ppm). Read every 5 minutes. The level follows the ecobee app's Clean–Poor bar: its first two segments are Excellent, then Good, Fair, Inferior, Poor; Unknown while the sensor calibrates. |
| `co2Alert` | `1000` | CO2 (ppm) at or above which the Carbon Dioxide Sensor reports abnormal levels. |

## How it behaves

- **Arm Away** uses ecobee's Away exit delay (60 s by default), just like the app. During the
  delay the Home app shows "Arming…" (current Off, target Away). Home and Night use ecobee's Stay
  exit delay (0 by default). Off needs no PIN.
- **Changes from elsewhere** (ecobee app, keypad, ecobee automations) show up within 10 s, about
  as fast as in the ecobee app (it polls too), and quickly after an exit delay ends.
- **Alarm triggered** while ecobee lists an open incident (see `alarmTrigger` above for when it
  starts showing). Disarming clears it. Every change in the incident list is logged.
- **Siri:** asking for Home or for Stay mode both set Home (ecobee's Stay).
- **Night** is only offered with `offerNight`; ecobee has no Night mode of its own.
- After three failed reads in a row the accessory shows a fault; reads back off up to 5 minutes.
- **Security holds** let other plugins, like a robot vacuum, keep the system from arming Away while they work: see below.

## Security holds

Things that move while you're out set off ecobee's motion sensors: a robot vacuum cleaning, or an AC
blowing plants around in front of a sensor. **Security holds** let other Homebridge plugins keep the
system from arming **Away** while their task runs. Instead the system is set to **Home** (Stay in the
ecobee app): doors and windows stay armed, motion sensors don't.

Plugins that support holds include
[homebridge-narwal-freo](https://github.com/seanfletchr/homebridge-narwal-freo) (robot vacuum). Any
plugin can add support; see [For plugin authors](#for-plugin-authors).

### Turning it on

1. In this plugin's settings, open **Security holds**, turn on **Allow security holds**, and tick the
   plugins that may use them. (Plugins appear in the list once installed, or after they first ask.)
2. Turn on the matching option in the other plugin's settings.

### What happens

Using a robot vacuum as the example:

| Situation | What the security system does |
|---|---|
| The robot starts cleaning while the system is armed **Away** | Switches to Home, and goes back to Away when the robot is done. |
| The robot starts while the system is set to **Home**, **Night** or **Off** | Nothing changes. |
| You arm **Away in the Home app** while the robot is cleaning (the tile, a scene, an automation or Siri) | Stays in Home until the robot is done, then arms Away. The tile shows "Arming…" meanwhile. |
| You want Away **now** | Turn on the **Arm Away Now** switch (see below). It arms Away right away and sends the robot home. |
| You arm **Away in the ecobee app** while the robot is cleaning | Sends the robot home, and gives it up to 2 extra minutes on the countdown. It arms as soon as the robot is docked, but never earlier than your normal countdown. If the robot won't make it in time, it stops where it is before the sensors arm. |
| You arm **Away at the keypad** while the robot is cleaning | Stops the robot where it is. ecobee doesn't report keypad countdowns, so this happens once Away is already armed: there's a window of up to 10 seconds in which a motion sensor could still catch the robot. |
| You change the mode yourself while the robot is cleaning (in any app or at the keypad) | Your choice wins: when the robot is done, the system is left as you set it. |
| An alarm is going off, or ecobee can't be reached | The robot isn't allowed to start. |

Other plugins work the same way; what "stop" means is up to each one (a robot pauses or goes home,
an AC turns off). Several at once are fine: Away comes back once all of them are done.

### Settings

In the **Security holds** section of the settings:

- **Allow security holds** (`allowHolds`) and the list of plugins allowed to ask (`holdPlugins`).
  Turning holds off cancels any hold in progress without re-arming Away.
- **Arm Away Now switch** (`armAwayNowSwitch`): adds a switch to the Home app that arms Away
  immediately, as from the ecobee app, asking any task in progress to stop (a robot goes home). Use it
  from the Home app, a scene, or Siri ("turn on Arm Away Now").
- **Extra time for tasks to finish** (`taskWaitSeconds`, default 120 seconds, 0 to turn it off): how
  much longer the Away countdown may wait for a task to wrap up, e.g. a robot getting back to its
  base. It arms as soon as the task is done.

### Good to know

- **Only Away is affected.** If your ecobee Stay mode also watches the motion sensors in question,
  holds won't help there.
- **A quick re-arm in the ecobee app can be missed.** If you disarm and re-arm Stay within a few
  seconds in the ecobee app or at the keypad (or while Homebridge restarts), the plugin may not
  notice, and will arm Away when the task is done. Changes in the Home app are always noticed.
- **A plugin that can't be told to stop** keeps going when Away is armed at the keypad or in the
  ecobee app. The log says so.
- **A plugin that never reports it's done** leaves the system in Home until you change it.
  (homebridge-narwal-freo also lets go if its robot hasn't moved for 10 minutes, e.g. when it's
  stuck.)
- **The allowed-plugins list is a courtesy, not a lock.** Any plugin running in your Homebridge can
  reach the hold API and give any name.

### For plugin authors

Holds suit any plugin whose task could trip a motion sensor. Plugins ask over a Unix socket at `<homebridge storage>/ecobee-security/control.sock` (homebridge user
only). This plugin declares it in `package.json` as
`"homebridge-security-hold": { "socket": "ecobee-security/control.sock" }`; plugins that ask for holds
can declare `"homebridge-security-hold": { "client": true }` to appear in the settings list. The API
(hold, release, and being asked to stop or finish before Away arms) is documented in
[Security hold](https://github.com/seanfletchr/homebridge-narwal-freo/blob/main/docs/security-hold.md).

## API notes

[docs/api.md](docs/api.md) describes the sign-in flow and GraphQL calls the plugin uses, for anyone
fixing it after an ecobee change or adding features.

## License

MIT
