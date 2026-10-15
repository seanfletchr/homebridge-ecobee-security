# Changelog

## 0.4.0

- `offerNight`: adds Night to the Home app; it arms ecobee's Stay and keeps showing Night. Changing
  the setting recreates the security system in HomeKit (the Home app doesn't pick up new modes on an
  existing control).
- `alarmTrigger: "entryDelay"`: show Alarm triggered only once an intrusion has outlasted the entry
  delay without a disarm, instead of as soon as ecobee opens the incident. Smoke still shows at once.
- `smokeSensor` (on by default): a Smoke Sensor that detects smoke while ecobee has a smoke-alarm
  incident open.
- Air quality (`airQuality`, on by default): for ecobee thermostats with an air quality sensor, an
  Air Quality Sensor (level, VOC) and a Carbon Dioxide Sensor (ppm, alert at `co2Alert`, 1000 ppm).
- The accessory reports the plugin version as its firmware version.
- The hold API refuses a hold while any alarm incident is open, whichever `alarmTrigger` is set.

## 0.3.0

- Sign in from the plugin's settings page in the Homebridge UI with your ecobee email, password
  and MFA code. No terminal or browser developer tools needed; the website sign-in is still there
  as a fallback.
- `bin/ecobee-login.js` signs in with email and password by default; `--browser` for the old way.

## 0.2.0

- Control socket (`control.sock`) so other plugins can hold the system at Stay and release it to
  Away afterwards (used by homebridge-narwal while the robot vacuum cleans).

## 0.1.0

- First release: arm Stay / Away, disarm and alarm state in Apple Home, browser sign-in script.
