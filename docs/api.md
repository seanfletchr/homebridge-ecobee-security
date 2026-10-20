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

## Connectivity (captured 2026-10-19)
Smart Security runs on the thermostats, so "the system is offline" means ecobee's cloud can't reach
them. `HomesAndDevicesPolling` (every ~10 s in the app) returns each thermostat's
`legacyRuntime { connected }` (false while it's offline); REST `/1/thermostat` with `includeRuntime`
has `runtime.{connected, connectDateTime, disconnectDateTime}`. Cameras report `isConnected` and
`isHealthy` (`query Camera`).

## Location / presence (captured 2026-10-19)
```graphql
query AutopilotSettings($homeID: ID!, $includePresence: Boolean!) { homes(id: $homeID) { id
  monitoring { homeMonitoringSettings {
    arrivalSettings { noAction { isEnabled } }
    departureSettings { prompt { isEnabled } auto { isVisible } noAction { isEnabled } } } }
  members { accountId name presence @include(if: $includePresence)
    mobileDevice { id locationTracking locationPermission locationPrecision } } } }
```
`presence` is `HOME`, `AWAY` or `UNKNOWN` per home member, from the ecobee app's geofence on each
member's registered phone (`locationTracking: ENABLED`, `locationPermission: ALWAYS | NEVER | …`).
A member whose phone has location permission `NEVER`, or whose registered phone is an old one, reads
`AWAY` regardless. `mutation EnableLocationTracking` (`enableLocationTrackingForMobileDevice`,
`input { mobileDeviceId, name }`) registers the current phone; the phone then reports through
`ls-api.ecobee.com` and `SendMobileDeviceStateChange`.

## Doorbell / camera (captured 2026-10-19)
`query Camera($cameraID)` → `devices { cameras(filter: {id}) { id name model isConnected serialNumber
firmwareVersion homeKitLiveEnabledState settings { isLiveEnabled … } firmware { capabilities } } }`.
The Smart Doorbell Camera is model `ASTERIA`; events name it `type: DOORBELL`.

Events (motion, person, doorbell press) come from `query HomeEvents($homeID, $first, $filter: { actorIds: [<camera id>] })`
→ `events.edges[].node { id parentId type startedAt endedAt actor { id name type } media { type uri } }`;
types seen: `PERSON_DETECTED`, `DOORBELL_PRESSED`. A video media `uri` is `<detection id>:DETECT_PERSON`.

Recorded clips: `query CameraSignedPlaylists($deviceID, $playlistFilter: { detectionId, startTime, endTime })`
→ `signedPlaylists.playlists[].uri`, an HLS playlist on `mosaicbee.cam-prod.ecobee.com` with a
short-lived `auth` token (segments from S3). Snapshots: `mutation CapturePreviewSnapshotForCamera`
→ `previewThumbnailUri`.

Live view is WebRTC, signalled over GraphQL:
1. `query IceServers { user { iceServers { username credential serverUris } } }` (Twilio TURN).
2. `mutation InitiateLiveVideoOfferForCamera(input: { cameraId, sessionDescriptionProtocolInformation })`,
   the offer as base64 of `{"type":"offer","sdp":…}` → `sessionDescriptionProtocolAnswer`, the
   answer in the same encoding, its ICE candidates inline (the camera's LAN host candidate included).
3. `mutation SendIceCandidateForCamera(input: { cameraId, candidate })` trickles the app's
   candidates: `candidate` is base64 of a JSON list of base64 JSON
   `{candidate, sdpMid, sdpMLineIndex, serverUrl}` (firmware capability `ICE_CANDIDATE_BATCHING`).
The camera sends H.264 constrained baseline (`profile-level-id=42e029`, packetization-mode 1;
VP8/VP9 also offered) and Opus audio (two-way), plus a data channel.

## Smart Home & Away (probed 2026-10-20, read-only)
- GraphQL `Home` has no occupancy/away/presence field (tried ~20 names; introspection is off).
  `members { presence }` is per phone and unreliable (see above).
- REST `/1/thermostat` with `includeSettings`: `settings.autoAway` (Smart Home & Away enabled) and
  `settings.followMeComfort`; with `includeSensors`: `remoteSensors[].capability[type=occupancy].value` is
  per-sensor motion, not the home state; `program.currentClimateRef` follows the schedule.
- While Smart Home & Away has decided nobody is home, ecobee's REST docs list an event of type `autoAway`
  (and `autoHome` when it switches back). Not observed live: a vacation was running (it pauses the
  feature) and the house was occupied. The plugin treats a running `autoAway` as away, anything else as
  home, and nothing (keeps the last state) when `autoAway` is off or a vacation is running.

## Starting a vacation (REST, not run against a real account)
`functions: [{ type: 'createVacation', params: { name, coolHoldTemp, heatHoldTemp, startDate, startTime,
endDate, endTime, fan, fanMinOnTime } }]`, dates `YYYY-MM-DD` and times `HH:MM:SS` in the thermostat's
own time (`thermostatTime`, with `utcTime`). Hold temperatures in tenths of °F; ecobee's default vacation
settings are the event `type: "template"`, `name: "_Default_"` in `includeEvents`.
