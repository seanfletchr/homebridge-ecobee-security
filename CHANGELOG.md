# Changelog

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
