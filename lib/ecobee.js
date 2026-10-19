// ecobee cloud client: Auth0 refresh-token sign-in + the app's GraphQL API (see docs in README).

export const AUTH = 'https://auth.ecobee.com';
export const GRAPHQL = 'https://federated-api.prod.federated-graph.generacapis.com/graphql';
// ecobee's older REST API; the app still reads thermostat runtime (CO2 ppm, VOC) from it.
export const REST = 'https://api.ecobee.com/1';
export const CLIENT_ID = 'CuGkX8Ai7OWD2V1F32rFa7UJGRVRsnbv';
export const REDIRECT_URI = 'com.ecobee.athenamobile://auth.ecobee.com/ios/com.ecobee.athenamobile/callback';
export const AUDIENCE = 'https://prod.ecobee.com/api/v1';
export const SCOPE = 'openid profile offline_access smartWrite piiWrite piiRead';

const APP_VERSION = '26.18.0+607111';
const USER_AGENT = 'ecobee/607111 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';
const TIMEOUT = 20 * 1000;

export const ArmedState = {
  STAY: 'ARMED_STAY',
  AWAY: 'ARMED_AWAY',
  DISARMED: 'DISARMED',
};

const MONITORING_FIELDS = 'armedState delayedArmedState { desiredArmedState delayedUntil }';

// Smart Security runs on the thermostats; `connected` is false while ecobee's cloud can't reach one.
const DEVICE_FIELDS = 'devices { thermostats { id name legacyRuntime { connected } } } ';

const stateQuery = withDevices => `query HomesSecurity { homes { id name capabilities ${withDevices ? DEVICE_FIELDS : ''}`
  + `monitoring { ${MONITORING_FIELDS} `
  + 'incidents { id status detectedIntrusion detectedSmokeAlarm } '
  + 'homeMonitoringSettings { isProfessionalMonitoringEnabled armedStateSettings { '
  + 'armedAway { entryDelayDuration exitDelayDuration } armedStay { entryDelayDuration exitDelayDuration } } } } } }';

const AIR_QUALITY_QUERY = 'query ThermostatsAirQuality($homeID: ID!) { homes(id: $homeID) { id devices { id '
  + 'thermostats { id name airQuality { hasAirQualityEnabled carbonDioxideScore vocScore airQualityScore isCalibrating } } } } }';

const SET_MUTATION = 'mutation SetArmedStateForHome($input: SetArmedStateForHomeInput!) { '
  + `setArmedStateForHome(input: $input) { home { id monitoring { ${MONITORING_FIELDS} } } success } }`;

/** The refresh token was rejected; a new browser sign-in is needed. */
export class SignInRequiredError extends Error {}

export class EcobeeCloud {
  /**
   * @param {object} options
   * @param {string} options.refreshToken
   * @param {(token: string) => void} options.onRefreshToken called when Auth0 hands out a new refresh token
   * @param {import('homebridge').Logging} options.log
   */
  constructor({ refreshToken, onRefreshToken, log }) {
    this.refreshToken = refreshToken;
    this.onRefreshToken = onRefreshToken;
    this.log = log;
    this.accessToken = undefined;
    this.expiresAt = 0;
    this.renewing = undefined;
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 5 * 60 * 1000) {
      return this.accessToken;
    }
    // Several polls/commands may need a token at once; renew only once.
    this.renewing ??= this.renew().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  async renew() {
    if (!this.refreshToken) {
      throw new SignInRequiredError('no refresh token');
    }
    const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: this.refreshToken });
    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
    if (json.refresh_token && json.refresh_token !== this.refreshToken) {
      this.refreshToken = json.refresh_token;
      this.onRefreshToken(json.refresh_token);
    }
    this.log.debug(`Signed in to ecobee (token valid ${Math.round((json.expires_in ?? 7200) / 60)} min)`);
    return this.accessToken;
  }

  async graphql(operationName, query, variables, retry = true) {
    const token = await this.token();
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'apollographql-client-name': 'com.ecobee.athenamobile-apollo-ios',
        'apollographql-client-version': APP_VERSION,
        'x-apollo-operation-name': operationName,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ operationName, query, variables }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 401 && retry) {
      this.accessToken = undefined;
      return this.graphql(operationName, query, variables, false);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${operationName}: HTTP ${res.status}, unexpected reply ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    if (json.errors?.length) {
      const message = json.errors.map(e => e.message).join('; ');
      if (retry && /unauth|expired|jwt/i.test(message)) {
        this.accessToken = undefined;
        return this.graphql(operationName, query, variables, false);
      }
      const error = new Error(`${operationName}: ${message}`);
      // The query itself was rejected (a field ecobee doesn't have), not the request.
      error.validation = json.errors.some(e => e.extensions?.code === 'GRAPHQL_VALIDATION_FAILED'
        || /cannot query field|unknown (field|type)/i.test(e.message));
      throw error;
    }
    if (!res.ok) {
      throw new Error(`${operationName}: HTTP ${res.status}`);
    }
    return json.data;
  }

  /**
   * All homes on the account with their security state and thermostat connectivity. If ecobee
   * rejects the connectivity fields, they're dropped for good (logged once) and the security state
   * is read without them.
   */
  async getHomes() {
    if (!this.withoutDevices) {
      try {
        return (await this.graphql('HomesSecurity', stateQuery(true))).homes ?? [];
      } catch (error) {
        if (!error.validation) {
          throw error;
        }
        this.withoutDevices = true;
        this.log.warn(`ecobee doesn't accept the thermostat connectivity check (${error.message}); `
          + 'carrying on without it.');
      }
    }
    return (await this.graphql('HomesSecurity', stateQuery(false))).homes ?? [];
  }

  /**
   * The home's thermostats with ecobee's air quality scores (0 = clean … 1 = poor), plus the
   * runtime readings (`actualCO2` ppm, `actualVOC` ppb, `actualAQScore`) from the REST API.
   */
  async getAirQuality(homeId) {
    const data = await this.graphql('ThermostatsAirQuality', AIR_QUALITY_QUERY, { homeID: homeId });
    const thermostats = data.homes?.[0]?.devices?.thermostats ?? [];
    if (!thermostats.length) {
      return [];
    }
    const json = await this.rest('/thermostat', {
      selectionType: 'thermostats', selectionMatch: thermostats.map(t => t.id).join(','), includeRuntime: true,
    });
    const runtime = new Map((json.thermostatList ?? []).map(t => [t.identifier, t.runtime ?? {}]));
    return thermostats.map(t => ({ ...t, runtime: runtime.get(t.id) ?? {} }));
  }

  async rest(path, selection, retry = true) {
    const token = await this.token();
    const url = `${REST}${path}?json=${encodeURIComponent(JSON.stringify({ selection }))}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json;charset=UTF-8', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 401 && retry) {
      this.accessToken = undefined;
      return this.rest(path, selection, false);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (json.status?.code ?? 0) !== 0) {
      throw new Error(`${path}: HTTP ${res.status} ${json.status?.message ?? ''}`.trim());
    }
    return json;
  }

  /**
   * @param {string} homeId
   * @param {string} armedState one of ArmedState
   * @param {number} exitDelay seconds; the app sends the exit delay as a timestamp
   * @param {number} [until] the exit delay's end (ms) instead of `exitDelay`
   * @returns the home's monitoring state after the change
   */
  async setArmedState(homeId, armedState, exitDelay = 0, until = Date.now() + exitDelay * 1000) {
    const exitDelayUntil = new Date(until).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const data = await this.graphql('SetArmedStateForHome', SET_MUTATION, {
      input: { homeId, armedState, exitDelayUntil },
    });
    const result = data.setArmedStateForHome;
    if (!result?.success) {
      throw new Error(`ecobee refused ${armedState}`);
    }
    return result.home?.monitoring;
  }
}

export async function tokenRequest(body) {
  const res = await fetch(`${AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = `ecobee sign-in failed (${res.status} ${json.error ?? ''}: ${json.error_description ?? ''})`;
    if (json.error === 'invalid_grant' || json.error === 'unauthorized_client') {
      throw new SignInRequiredError(message);
    }
    throw new Error(message);
  }
  return json;
}
