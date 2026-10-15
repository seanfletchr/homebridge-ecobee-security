# ecobee Smart Security — private API notes

What the plugin relies on, captured 2026-10-14. ecobee doesn't document or support this API.

Captured from the ecobee iOS app (build 26.18.0+607111) with mitmproxy. The app doesn't pin certificates.

## Auth (Auth0 at `auth.ecobee.com`, Universal Login + PKCE)

App client: `client_id=CuGkX8Ai7OWD2V1F32rFa7UJGRVRsnbv`,
`redirect_uri=com.ecobee.athenamobile://auth.ecobee.com/ios/com.ecobee.athenamobile/callback`,
`audience=https://prod.ecobee.com/api/v1`, `scope=openid profile offline_access smartWrite piiWrite piiRead`.

1. `GET /authorize?response_type=code&code_challenge=<S256>&code_challenge_method=S256&prompt=login&state&nonce&…`
   → 302 `/u/login/identifier?state=<s>`
2. `POST /u/login/identifier?state=<s>` form: `state, username, js-available=true, webauthn-available=true, is-brave=false, webauthn-platform-available=true` → 302 `/u/login/password`
3. `POST /u/login/password?state=<s>` form: `state, username, password` → 302 `/authorize/resume` → 302 `/u/mfa-otp-challenge?state=<s2>`
4. (accounts with MFA) `POST /u/mfa-otp-challenge?state=<s2>` form: `state, code` (6 digits) → 302 `/authorize/resume` → 302 to the redirect URI with `code`
5. `POST /oauth/token` JSON: `grant_type=authorization_code, client_id, code, code_verifier, redirect_uri`
   → `access_token` (JWT, 2 h), `refresh_token`, `id_token`
6. Renewal (standard Auth0, not seen in capture): `POST /oauth/token` `grant_type=refresh_token, client_id, refresh_token`. Save any new refresh_token returned (rotation).

**Tested 2026-10-14:** scripted email/password sign-in is blocked — Auth0 bot detection
returns a CAPTCHA at the password step. What works: generate the PKCE `/authorize` link, the user signs
in in a real browser (Chrome DevTools > Network, Preserve log), copies the
`com.ecobee.athenamobile://…?code=…` URL (filter `code=`, or the last `resume` request's Location), and
the code is exchanged within a minute (`bin/ecobee-login.js`). After that, `grant_type=refresh_token`
works repeatedly from a server; the refresh token was **not rotated** (the plugin saves a new one if it is).
GraphQL works without the Imperva/Incapsula cookies the app carries.

## GraphQL: `POST https://federated-api.prod.federated-graph.generacapis.com/graphql`

Headers: `authorization: Bearer <access_token>`, `content-type: application/json`,
`apollographql-client-name: com.ecobee.athenamobile-apollo-ios`, `apollographql-client-version: 26.18.0+607111`,
`x-apollo-operation-name: <op>`. The app also sends Imperva/Incapsula cookies; they aren't required.

Read state:
```graphql
query Homes { homes { id name monitoring { armedState delayedArmedState { desiredArmedState delayedUntil } } } }
query HomeIncidentsPolling { homes { id isMfaRequired monitoring { incidents { id status detectedIntrusion detectedSmokeAlarm } } } }
```

Arm / disarm (no PIN needed):
```graphql
mutation SetArmedStateForHome($input: SetArmedStateForHomeInput!) {
  setArmedStateForHome(input: $input) {
    home { id monitoring { armedState delayedArmedState { desiredArmedState delayedUntil } } }
    success
  }
}
```
`input = { homeId, armedState: ARMED_STAY | ARMED_AWAY | DISARMED, exitDelayUntil: <ISO UTC> }`.
The app sends `exitDelayUntil = now` for Stay/Disarm and `now + 60 s` for Away; during the delay the
response is `armedState: DISARMED, delayedArmedState: { desiredArmedState: ARMED_AWAY, delayedUntil }`.
Exit/entry delays per mode are in `homeMonitoringSettings.armedStateSettings.{armedAway,armedStay}`.

## HomeKit mapping
SecuritySystemCurrentState: STAY_ARM 0 / AWAY_ARM 1 / DISARMED 3 / ALARM_TRIGGERED 4 (open intrusion/smoke incident).
TargetState: STAY_ARM 0 / AWAY_ARM 1 / DISARM 3; during an exit delay current = DISARMED, target = AWAY_ARM.

## Incidents (seen 2026-10-14)
Opening a door while armed Stay creates an incident immediately, during the entry delay:
`{"status":"OPEN","detectedIntrusion":true,"detectedSmokeAlarm":false}`. Disarming removes it from
`monitoring.incidents` (the list goes back to `[]`; no resolved status is reported).

## Air quality (captured 2026-10-15)
The app lists thermostats and their air quality scores over GraphQL:
```graphql
query ThermostatsAirQuality($homeID: ID!) { homes(id: $homeID) { id devices { id
  thermostats { id name airQuality { hasAirQualityEnabled carbonDioxideScore vocScore airQualityScore isCalibrating } } } } }
```
Scores run 0 (clean) to 1 (poor); `airQualityScore` = REST `actualAQScore` / 300. The readings come from
the older REST API with the same bearer token, selecting thermostats by id (`selectionType:
"registered"` returns none on this account):
`GET https://api.ecobee.com/1/thermostat?json={"selection":{"selectionType":"thermostats","selectionMatch":"<id>,<id>","includeRuntime":true}}`
→ `thermostatList[].runtime.{actualCO2 (ppm), actualVOC (ppb), actualAQScore, actualAQAccuracy, actualHumidity}`.
