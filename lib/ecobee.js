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

const CAMERAS_QUERY = 'query HomesCameras { homes { id name devices { cameras { id name model isConnected serialNumber firmwareVersion } } } }';

const EVENTS_QUERY = 'query HomeEvents($homeID: ID!, $first: Int, $filter: HomeEventsFilter) { homes(id: $homeID) { id '
  + 'events(first: $first, filter: $filter) { edges { node { id type startedAt endedAt } } } } }';

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

  /** The cameras of one home (id, name, model, isConnected, serialNumber, firmwareVersion). */
  async getCameras(homeId) {
    const data = await this.graphql('HomesCameras', CAMERAS_QUERY);
    return (data.homes ?? []).find(h => h.id === homeId)?.devices?.cameras ?? [];
  }

  /** The newest events (motion, person, doorbell press) of one camera, newest first: {id, type, startedAt, endedAt}. */
  async getCameraEvents(homeId, cameraId, first = 5) {
    const data = await this.graphql('HomeEvents', EVENTS_QUERY, { homeID: homeId, first, filter: { actorIds: [cameraId] } });
    return (data.homes?.[0]?.events?.edges ?? []).map(edge => edge.node);
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

  /**
   * The home's thermostat ids from GraphQL, cached for at most 10 minutes, and
   * dropped after a failed or short REST read so the next read fetches them again.
   */
  async thermostatIdsOf(homeId) {
    if (!this.thermostatIds || Date.now() - this.thermostatIdsAt > 10 * 60 * 1000) {
      const data = await this.graphql('ThermostatsAirQuality', AIR_QUALITY_QUERY, { homeID: homeId });
      this.thermostatIds = (data.homes?.[0]?.devices?.thermostats ?? []).map(t => t.id);
      this.thermostatIdsAt = Date.now();
    }
    return this.thermostatIds;
  }

  /**
   * One REST read of the home's thermostats with their events, settings and time, shared by whoever
   * needs it (the vacation switch and the Home Occupied source): [{ id, name, events, settings,
   * thermostatTime, utcTime }]. A read at most `maxAge` ms old is shared, as is a pending one that
   * started within `maxAge`; otherwise (`maxAge` 0 always) the read starts after the call, after any
   * pending one finishes.
   */
  async getThermostats(homeId, maxAge = 20 * 1000) {
    if (this.thermostatsRead && Date.now() - this.thermostatsRead.at < maxAge) {
      return this.thermostatsRead.list;
    }
    const pending = this.thermostatsPending;
    if (!pending) {
      return this.readThermostats(homeId);
    }
    if (maxAge > 0 && pending.startedAt >= Date.now() - maxAge) {
      return pending.promise;
    }
    this.thermostatsNext ??= pending.promise.catch(() => {}).then(() => {
      this.thermostatsNext = undefined;
      return this.readThermostats(homeId);
    });
    return this.thermostatsNext;
  }

  readThermostats(homeId) {
    const promise = (async () => {
      let ids = [];
      try {
        ids = await this.thermostatIdsOf(homeId);
        let list = [];
        if (ids.length) {
          const json = await this.rest('/thermostat', {
            selectionType: 'thermostats', selectionMatch: ids.join(','), includeEvents: true, includeSettings: true,
          });
          list = (json.thermostatList ?? []).map(t => ({
            id: t.identifier, name: t.name, events: t.events ?? [], settings: t.settings ?? {},
            thermostatTime: t.thermostatTime, utcTime: t.utcTime,
          }));
        }
        if (list.length < ids.length) {
          this.thermostatIds = undefined;
        }
        this.thermostatsRead = { at: Date.now(), list };
        return list;
      } catch (error) {
        this.thermostatIds = undefined;
        throw error;
      }
    })().finally(() => {
      if (this.thermostatsPending?.promise === promise) {
        this.thermostatsPending = undefined;
      }
    });
    this.thermostatsPending = { startedAt: Date.now(), promise };
    return promise;
  }

  /** The running vacation events of the home's thermostats: [{ thermostatId, name, endDate, endTime }]. */
  async getVacations(homeId, maxAge) {
    return vacationsOf(await this.getThermostats(homeId, maxAge));
  }

  /**
   * Smart Home & Away as ecobee reports it: `true` someone is home, `false` ecobee has set Away
   * because nobody is, `undefined` unknown. See smartOccupancyOf().
   */
  async getSmartOccupancy(homeId, maxAge) {
    return smartOccupancyOf(await this.getThermostats(homeId, maxAge));
  }

  /** Starts a vacation on one thermostat (dates and times in the thermostat's own time). */
  async createVacation(thermostatId, { name, coolHoldTemp, heatHoldTemp, startDate, startTime, endDate, endTime }) {
    return this.restPost('/thermostat', {
      selection: { selectionType: 'thermostats', selectionMatch: thermostatId },
      functions: [{
        type: 'createVacation',
        params: { name, coolHoldTemp, heatHoldTemp, startDate, startTime, endDate, endTime, fan: 'auto', fanMinOnTime: 0 },
      }],
    });
  }

  /** Ends a running vacation event (by its name) on one thermostat. */
  async deleteVacation(thermostatId, name) {
    return this.restPost('/thermostat', {
      selection: { selectionType: 'thermostats', selectionMatch: thermostatId },
      functions: [{ type: 'deleteVacation', params: { name } }],
    });
  }

  /** POST to the REST API (same sign-in and refresh handling as rest()). */
  async restPost(path, body, retry = true) {
    const token = await this.token();
    const res = await fetch(`${REST}${path}?format=json`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json;charset=UTF-8', 'user-agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 401 && retry) {
      this.accessToken = undefined;
      return this.restPost(path, body, false);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (json.status?.code ?? 0) !== 0) {
      throw new Error(`${path}: HTTP ${res.status} ${json.status?.message ?? ''}`.trim());
    }
    return json;
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

export function vacationsOf(thermostats) {
  const vacations = [];
  for (const t of thermostats) {
    for (const e of t.events ?? []) {
      if (e.type === 'vacation' && e.running) {
        vacations.push({ thermostatId: t.id, name: e.name, endDate: e.endDate, endTime: e.endTime });
      }
    }
  }
  return vacations;
}

/**
 * Smart Home & Away from the thermostats' REST data. While it has decided nobody is home, the
 * thermostat runs an `autoAway` event (REST event types `autoAway` / `autoHome`); otherwise the
 * schedule runs and someone is home. Not seen live (a vacation was running when this was written, and
 * the house was occupied): the shape is from ecobee's REST documentation. Unknown (undefined) when
 * Smart Home & Away is off on every thermostat, or a vacation is running (it pauses the feature).
 * Several thermostats: someone is home if any says so.
 */
export function smartOccupancyOf(thermostats) {
  const states = [];
  for (const t of thermostats) {
    const events = t.events ?? [];
    if (t.settings?.autoAway === false || events.some(e => e.type === 'vacation' && e.running)) {
      continue;
    }
    states.push(!events.some(e => e.type === 'autoAway' && e.running));
  }
  if (!states.length) {
    return undefined;
  }
  return states.some(Boolean);
}

/**
 * The details of a new vacation for one thermostat from a getThermostats() entry: starts now (in the
 * thermostat's own time) and ends `days` later; temperatures from ecobee's `_Default_` vacation
 * template (an error without one: the settings' range limits would be extreme temperatures).
 */
export function vacationPlan(thermostat, name, days = 30) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(thermostat.thermostatTime ?? '');
  if (!m) {
    throw new Error(`unexpected thermostat time "${thermostat.thermostatTime}"`);
  }
  const [startDate, startTime] = thermostat.thermostatTime.split(' ');
  // Wall-clock arithmetic on a UTC date, so only the calendar moves (never a DST shift).
  const end = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days, +m[4], +m[5], +m[6]));
  const endDate = end.toISOString().slice(0, 10);
  const template = (thermostat.events ?? []).find(e => e.type === 'template' && e.name === '_Default_');
  const heatHoldTemp = template?.heatHoldTemp;
  const coolHoldTemp = template?.coolHoldTemp;
  if (!Number.isFinite(heatHoldTemp) || !Number.isFinite(coolHoldTemp)) {
    throw new Error('ecobee has no default vacation temperatures; set one vacation in the ecobee app first');
  }
  return { name, coolHoldTemp, heatHoldTemp, startDate, startTime, endDate, endTime: startTime };
}
