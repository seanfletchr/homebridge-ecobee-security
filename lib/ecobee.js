// ecobee cloud client: Auth0 refresh-token sign-in + the app's GraphQL API (see docs in README).

export const AUTH = 'https://auth.ecobee.com';
export const GRAPHQL = 'https://federated-api.prod.federated-graph.generacapis.com/graphql';
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

const STATE_QUERY = `query HomesSecurity { homes { id name capabilities monitoring { ${MONITORING_FIELDS} `
  + 'incidents { id status detectedIntrusion detectedSmokeAlarm } '
  + 'homeMonitoringSettings { isProfessionalMonitoringEnabled armedStateSettings { '
  + 'armedAway { entryDelayDuration exitDelayDuration } armedStay { entryDelayDuration exitDelayDuration } } } } } }';

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
      throw new Error(`${operationName}: ${message}`);
    }
    if (!res.ok) {
      throw new Error(`${operationName}: HTTP ${res.status}`);
    }
    return json.data;
  }

  /** All homes on the account with their security state. */
  async getHomes() {
    const data = await this.graphql('HomesSecurity', STATE_QUERY);
    return data.homes ?? [];
  }

  /**
   * @param {string} homeId
   * @param {string} armedState one of ArmedState
   * @param {number} exitDelay seconds; the app sends the exit delay as a timestamp
   * @returns the home's monitoring state after the change
   */
  async setArmedState(homeId, armedState, exitDelay = 0) {
    const exitDelayUntil = new Date(Date.now() + exitDelay * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
