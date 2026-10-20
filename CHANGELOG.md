# Changelog

## 0.9.0

### Doorbell camera (beta)

- New setting **Doorbell camera** (`doorbellCamera`, off by default; `ffmpegPath`): the ecobee Smart
  Doorbell Camera as its own HomeKit camera, with live view and snapshots. The plugin keeps a session to
  the camera open on your network, reconnects by itself, and the camera shows **No Response** while it is
  down or ecobee can't be reached. Needs an ffmpeg with libfdk_aac and libx264 (the Homebridge Raspberry
  Pi image has one). Live view and recordings carry an ecobee watermark.
- **Doorbell link** (settings > Doorbell camera): pair the plugin with the doorbell's own HomeKit server
  from the settings page. The camera then becomes a **video doorbell** with an instant ring (single,
  double and long press) and a motion sensor, the ecobee sensors the doorbell bridges to HomeKit are
  published by the plugin, and the doorbell's **Chime Doorbell**, **Camera Status Light** and **Night
  Vision Light** switches are kept in sync. Remove ecobee's own doorbell from the Home app first.
- **HomeKit Secure Video**: recordings start about 4 seconds before the motion. Video is encoded in
  software (libx264), which takes about 2 of a Raspberry Pi 4's cores while recording. Motion comes from
  the doorbell link, or from ecobee's cloud every 5 seconds without it. New setting **Motion grace
  period** (`motionGrace`, 15 seconds): the motion sensor stays on this long after motion ends, so clips
  are at least about 10 seconds. `debugRecordings` keeps the last clips for troubleshooting.

### Switches and sensors

- **Home Occupied** now also has an occupancy sensor that follows the switch (Occupied while it is on).
- New setting **Vacation Mode switch** (`vacationSwitch`, off by default): a switch that is on while an
  ecobee vacation is running, for other accessories to follow. Turn it on to start a vacation now, until
  you turn it off (30 days at the latest); set dated vacations in the ecobee app. Turning it off ends the
  vacation. Shows No Response while ecobee can't be reached.
- The two switches have fixed names, **Home Occupied** and **Vacation Mode**; rename them in the Home app.
  The `occupancyName` setting (0.8.0) and the `vacationSwitchName` of earlier test builds still work if
  they are already in your config, but are no longer in the settings page.
- Settings page: **Home Occupied** and **Vacation Mode** are now together in a **Switches and
  sensors** card.

### Settings

- **Offer Night** is now **Enable Night**.
- **Enter Triggered State** is now **Home app alarm**, with the options *When a sensor is tripped (entry
  delay starts)* (default, as before) and *When the siren goes off (entry delay ran out)*, and a clearer
  description: it only changes the Home app's tile and automations, not ecobee's alerts or professional
  monitoring.
- Settings page: cards are now ecobee account, Security system, Door keypads, Security holds, Doorbell
  camera, Switches and sensors. In Doorbell camera the status of the doorbell link comes first, then the
  link, then Recording, with the ffmpeg path under Advanced.
- The doorbell camera needs an ffmpeg with libx264 as well as libfdk_aac; without it the camera isn't
  published and the log says why. The setting's description no longer says ecobee's tile keeps the ring.

### Dependencies

- Added `werift` (MIT) and `hap-controller` (MPL-2.0).

## 0.8.0

- While the plugin can't reach ecobee (three failed reads in a row, or signed out), the security
  tile, the Smoke Alarm and the air quality sensors show **No Response** in the Home app instead of
  their last state. They come back with the next successful read.
- The security tile and Smoke Alarm also show **No Response** when ecobee's cloud can't reach the
  thermostats Smart Security runs on: every thermostat unreachable for a minute. One dropping out
  briefly doesn't count, and it comes back as soon as one is connected. A thermostat's air quality
  sensors show No Response while ecobee can't reach it. Security holds are refused meanwhile.
- New setting **Home Occupied switch** (`occupancySwitch`, off by default; `occupancyName`): a switch
  for your Home app people-arrive and people-leave automations. Off arms Away like the Home app tile
  does (waiting for robots that are out), on turns Away off (never Home, Night or Off). Switches
  don't need the confirmation that automations controlling a security system do.
- Settings page: the Home ID field is now a list of the homes on your ecobee account, shown only
  when there's more than one (the list fills in once the plugin has started).

## 0.7.1

- Keypad unlock: the plugin now reads ecobee's current state first and only disarms when the system
  is armed, arming or alarming. A disarm sent while it was already off was followed by ecobee camera
  activity alerts.
- An intrusion incident only shows as **Alarm triggered** while the system is armed. ecobee also
  opens one for a camera activity alert while the system is off, which briefly showed as an alarm in
  the Home app (and counted as one for security holds). Smoke alarms still show at any time.

## 0.7.0

- New setting **Disarm when a door is unlocked with its keypad** (`keypadDisarm`, off by default,
  in a new **Door keypads** card): entering a code on a smart lock's keypad turns the security system
  off, like Nest Guard with a Nest × Yale lock. Works with locks from the same Homebridge that report
  keypad unlocks (HomeKit's Lock Last Known Action, read over HAP on 127.0.0.1; needs insecure mode).
  The settings page lists the locks found (`keypadLocks`; no list = all).

## 0.6.0

- Security holds now keep Away off while a plugin (a robot vacuum) works, instead of just switching
  Away to Home (ecobee's Stay). A plugin counts as out from its first hold until it releases, even if nothing was held.
- Away from the Home app (a scene, automation, Siri or the tile) while a robot is out waits for it:
  the hold is kept (or started), Home meanwhile, and the release arms Away; the tile shows Arming
  Away while it waits. Home, Night and Off in the Home app, and an alarm, still cancel the hold
  and the waiting Away.
- New setting **Arm Away Now switch** (`armAwayNowSwitch`, in Security holds, off by default): adds
  an Arm Away Now switch to the Home app that arms Away now and sends any robots that are out back to
  their base.
- Away armed in the ecobee app or at the keypad while a robot is out asks the robot to head back to
  its base before the exit delay ends, or to stop where it is if it can't make it. Plugins give a halt
  endpoint with their hold request (`&halt=`), and the request says when the exit delay ends
  (`&armAt=`; left out for a keypad Away, which is only seen once armed: the robot stops at once). A
  robot that moves again asks for a new hold.
- New setting **Extra time for tasks to finish** (`taskWaitSeconds`, default 120, 0 = off):
  when Away is armed from the ecobee app or the Arm Away Now switch while a task is running (like a
  robot heading back to its base), the exit delay is extended by this much, and brought forward again
  once the task is done (never earlier than it would have ended). A robot says it's docked, or stopped, with
  `/release`; robots answer the halt with `returning: true` when they head back.

## 0.5.0

- The `pollInterval` setting is gone: the security state is read every 10 s, as often as the ecobee
  app does (it has no live updates either). A value left in the config is ignored.
- Settings: the whole page is now cards (account, Security system, Sensors, Security holds), with
  **Security holds** at the bottom; the standard settings form is no longer shown.
- Settings: a **Security holds** section with the **Allow security holds** switch and a checkbox per
  plugin (`holdPlugins`): installed plugins that declare they use holds, and any that asked. Hold
  requests can name their plugin (`&plugin=<package>`); unticked plugins are refused.
- Declares the hold socket in package.json (`"homebridge-security-hold": { "socket": … }`), so
  plugins that support the hold, like homebridge-narwal-freo, list it in their settings.
- Hold API: several plugins (e.g. two robot vacuums) can hold Stay at once; Away comes back only
  when the last one releases. `/release` answers `waiting: [names]` while others still hold.
- New setting **Allow security holds** (`allowHolds`, off by default): other plugins can only hold
  Stay with it turned on; otherwise `/hold` and `/release` answer 403 with the reason, and a hold
  left over from before is dropped without re-arming Away. **If you use homebridge-narwal-freo's
  security hold, turn this on and tick Narwal Freo.**
- Hold and release decide on ecobee's live state, read at the moment of the request, not the last
  poll: a disarm in the ecobee app seconds before a robot finishes is no longer armed over with
  Away. If ecobee can't be read, a hold is refused and a release doesn't arm (the caller retries).

## 0.4.2

- New plugin icon.
- Declare HomeKit (HAP) support with the `supports-hap` keyword.

## 0.4.1

First public release.

- Plugin icon in the README.
- Catch and log errors creating the storage folder or control socket instead of stopping the bridge.
