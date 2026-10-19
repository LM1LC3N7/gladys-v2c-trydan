// -----------------------------------------------------------------------------
// The Trydan local API, ported from pytrydan (MIT): one read
// (GET /RealTimeData), one keyword read (GET /read/<Keyword>) and one write
// (GET /write/<Keyword>=<value>, answered "OK"). Reads are never retried here
// (pytrydan retries at once; the app spaces its new tries instead); writes
// are never retried at all (one may have reached the station).
//
// The answer comes from the network: only own fields of a plain object are
// read, each with its exact type (a missing or mistyped value is undefined,
// never a default such as pytrydan's `ReadyState 0`), so that a command is
// refused rather than decided on a guess.
// -----------------------------------------------------------------------------

import { CHARGE_MODES, CHARGE_STATES, LIMITS, PATHS, SOLAR_MODES, WRITABLE } from '../constants.js';
import { ERROR_KINDS, StationError, request as httpRequest } from './http.js';

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const integer = (value) => (Number.isInteger(value) ? value : undefined);
const flag = (value) => (value === 0 || value === 1 ? value : undefined);
const oneOf = (values) => (value) =>
  Number.isInteger(value) && values.has(value) ? value : undefined;

const chargeModeOf = oneOf(new Set(Object.keys(CHARGE_MODES).map(Number)));
const solarModeOf = oneOf(new Set(Object.values(SOLAR_MODES)));
const chargeStateOf = oneOf(CHARGE_STATES);

/** A short text from the station, without control characters. */
function text(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

/**
 * The `ID` of the station, lower case, letters and digits only (never "-":
 * the address ids have one), 64 characters at most; a whole number (a
 * numeric ID sent as a JSON number) is read as its digits. Else undefined.
 */
export function idOf(value) {
  let text = value;
  if (typeof value === 'number') {
    text = Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof text !== 'string') {
    return undefined;
  }
  const id = text.trim().toLowerCase();
  return /^[0-9a-z]{1,64}$/.test(id) ? id : undefined;
}

/**
 * The answer of /RealTimeData -> the station as the rest of the code reads
 * it (pure). Throws a protocol error when it is not a JSON object.
 */
export function parseRealTime(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new StationError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');
  }
  const get = (key) => own(data, key);
  const time = integer(get('ChargeTime'));
  const slave = integer(get('SlaveError'));
  return {
    id: idOf(get('ID')),
    firmware: text(get('FirmwareVersion')),
    chargeState: chargeStateOf(get('ChargeState')),
    ready: flag(get('ReadyState')),
    chargePower: number(get('ChargePower')),
    housePower: number(get('HousePower')),
    solarPower: number(get('FVPower')),
    batteryPower: number(get('BatteryPower')),
    voltage: number(get('VoltageInstallation')),
    chargeEnergy: number(get('ChargeEnergy')),
    chargeTime: time !== undefined && time >= 0 ? time : undefined,
    chargeMode: chargeModeOf(get('ChargeMode')),
    slaveError: slave !== undefined && slave >= 0 ? slave : undefined,
    paused: flag(get('Paused')),
    locked: flag(get('Locked')),
    timer: flag(get('Timer')),
    dynamic: flag(get('Dynamic')),
    pauseDynamic: flag(get('PauseDynamic')),
    intensity: integer(get('Intensity')),
    minIntensity: integer(get('MinIntensity')),
    maxIntensity: integer(get('MaxIntensity')),
    solarMode: solarModeOf(get('DynamicPowerMode')),
  };
}

/** The text answer of /read/ChargeMode -> 0, 1 or 2, else undefined. */
export function parseChargeMode(body) {
  const value = typeof body === 'string' ? body.trim() : '';
  return /^\d$/.test(value) ? chargeModeOf(Number(value)) : undefined;
}

/** Retry-After (seconds or an HTTP date) in ms, else undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  if (/^\s*\d+\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The error of a non-2xx answer. */
function statusError(response, now) {
  if (response.status === 429) {
    return new StationError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status: 429,
      retryAfter: retryAfterOf(response.headers?.['retry-after'], now),
    });
  }
  return new StationError(ERROR_KINDS.HTTP, `HTTP ${response.status}`, {
    status: response.status,
  });
}

/** The reason of an error for a log or a message: its kind and status, never the answer. */
export function errorReason(err) {
  if (err?.kind === ERROR_KINDS.HTTP || err?.kind === ERROR_KINDS.RATE_LIMITED) {
    return `HTTP ${err.status}`;
  }
  return err?.kind ?? 'error';
}

export class TrydanClient {
  constructor({ transport = httpRequest, now = Date.now } = {}) {
    this.transport = transport;
    this.now = now;
  }

  async get({ host, port }, path, timeoutMs) {
    const response = await this.transport({ host, port, path, timeoutMs });
    if (response.status < 200 || response.status > 299) {
      throw statusError(response, this.now());
    }
    return response;
  }

  /** GET /RealTimeData -> parseRealTime(). */
  async read(address, { timeoutMs }) {
    const response = await this.get(address, PATHS.realTime, timeoutMs);
    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new StationError(ERROR_KINDS.PROTOCOL, 'Not JSON');
    }
    return parseRealTime(data);
  }

  /** GET /read/ChargeMode (left out of RealTimeData by some firmware versions). */
  async readChargeMode(address, { timeoutMs }) {
    const response = await this.get(address, PATHS.read('ChargeMode'), timeoutMs);
    return parseChargeMode(response.body);
  }

  /**
   * One write, never retried: `keyword` one of WRITABLE, `value` an integer
   * already checked by the caller. `startBy`: refused unsent (LATE) after it.
   * Resolves when the station answered "OK"; a 200 without it is
   * UNCONFIRMED (received, maybe applied).
   */
  async write(address, keyword, value, { startBy, timeoutMs }) {
    if (!WRITABLE.includes(keyword) || !Number.isInteger(value) || value < 0 || value > 99) {
      throw Object.assign(new Error(`Unknown write ${keyword}`), { notSent: true });
    }
    if (this.now() > startBy) {
      throw new StationError(ERROR_KINDS.LATE, 'Too late to send');
    }
    const response = await this.get(address, PATHS.write(keyword, value), timeoutMs);
    if (response.body.trim() !== 'OK') {
      throw new StationError(ERROR_KINDS.UNCONFIRMED, 'Answer is not OK');
    }
  }
}
