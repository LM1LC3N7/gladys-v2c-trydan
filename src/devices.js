// -----------------------------------------------------------------------------
// A station -> one Gladys device and its states (pure).
//
// `ext:<selector>:trydan:<platform id>`: one device per station, keyed by the
// `ID` of RealTimeData (lower case) when the station gives one, else by the
// address typed in the configuration ("ip-192-168-1-50": some firmware
// versions give no ID; changing the address then gives a new device). Never
// by a name. The feature roles (the last part of their external ids) are
// published forever: never rename them. Every role is always built, so a
// republished device never loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a charge command. The
// pause state is read only (`unknown/binary`); pausing and resuming are two
// `button/push` features, the charging current and the solar control mode
// two `text/select`. All four refuse unless the configuration allows the
// commands (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W and V on `energy-sensor`
// (instantaneous readings, never an index); kWh and A on
// `electrical-vehicle-charge`; seconds on `duration`. The energy of the
// session is a plain sensor (`last-charge-energy-added`): never an
// `index`/`energy` feature, so the energy tab never counts it (the station is
// already behind the main meter).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  CHARGE_MODES,
  CHARGE_STATE,
  CURRENT,
  FAULT_STATES,
  FEATURES,
  SOLAR_MODE_KEYS,
  solarModeKey,
} from './constants.js';
import {
  CHARGE_MODE_NAMES,
  DEVICE_NAME,
  FEATURE_NAMES,
  SOLAR_MODE_NAMES,
  STATUS_NAMES,
  meterName,
  word,
} from './i18n.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 });
const watts = (min, max) =>
  sensor({ category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.POWER, unit: U.WATT, min, max });
const amps = sensor({
  category: C.ELECTRICAL_VEHICLE_CHARGE,
  type: T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
  unit: U.AMPERE,
  min: 0,
  max: 80,
});
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [FEATURES.CHARGE_POWER]: watts(0, 25_000),
  // The house (grid) power may be negative while the solar power is exported.
  [FEATURES.HOUSE_POWER]: watts(-100_000, 100_000),
  [FEATURES.SOLAR_POWER]: watts(0, 100_000),
  [FEATURES.BATTERY_POWER]: watts(-100_000, 100_000),
  [FEATURES.VOLTAGE]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.VOLTAGE,
    unit: U.VOLT,
    min: 0,
    max: 500,
  }),
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1000,
  }),
  [FEATURES.SESSION_DURATION]: sensor({
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.SECONDS,
    min: 0,
    max: 31_536_000,
  }),
  [FEATURES.INTENSITY]: amps,
  [FEATURES.MIN_INTENSITY]: amps,
  [FEATURES.MAX_INTENSITY]: amps,
  [FEATURES.PAUSED]: binary,
  [FEATURES.LOCKED]: binary,
  [FEATURES.TIMER]: binary,
  [FEATURES.DYNAMIC]: binary,
  [FEATURES.PAUSE_DYNAMIC]: binary,
  [FEATURES.READY]: binary,
  [FEATURES.CHARGE_MODE]: text,
  [FEATURES.SOLAR_MODE]: text,
  [FEATURES.METER]: text,
  [FEATURES.PAUSE]: button,
  [FEATURES.RESUME]: button,
  [FEATURES.SET_INTENSITY]: select,
  [FEATURES.SET_SOLAR_MODE]: select,
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [
  FEATURES.PAUSE,
  FEATURES.RESUME,
  FEATURES.SET_INTENSITY,
  FEATURES.SET_SOLAR_MODE,
];

export const stationIds = (gladys, platformId) => gladys.externalIds('trydan', platformId);

/** A platform id: the lower-case ID of the station, or an address id ("ip-192-168-1-50"). */
export const PLATFORM_ID = /^[0-9a-z][0-9a-z-]{0,299}$/;

/** The platform id and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = /:trydan:([0-9a-z][0-9a-z-]{0,299}):([a-z-]+)$/.exec(externalId);
  return match && ROLES.includes(match[2]) ? { id: match[1], role: match[2] } : undefined;
}

/**
 * The options of the current select: always 6 to 32 A (the range of the
 * station), fixed so a republished device never changes; each command is
 * checked against MinIntensity..MaxIntensity read just before.
 */
export function currentOptions() {
  const options = [];
  for (let a = CURRENT.min; a <= CURRENT.max; a += 1) {
    options.push({ value: String(a), label: `${a} A`, sort_order: a - CURRENT.min });
  }
  return options;
}

export function solarModeOptions(language) {
  return SOLAR_MODE_KEYS.map((key, i) => ({
    value: key,
    label: word(SOLAR_MODE_NAMES[key], language),
    sort_order: i,
  }));
}

/** "V2C Trydan 3F2A" (the end of its ID), else "V2C Trydan 192.168.1.50". */
export const deviceName = (station, language) => `${word(DEVICE_NAME, language)} ${station.label}`;

/** The Gladys device of one station (read at least once). */
export function buildDevice(gladys, station, language) {
  const ids = stationIds(gladys, station.platformId);
  const params = [];
  if (station.id) {
    params.push({ name: 'station_id', value: station.id });
  }
  if (station.firmware) {
    params.push({ name: 'firmware', value: station.firmware });
  }
  return {
    name: deviceName(station, language),
    external_id: ids.device,
    model: 'V2C Trydan',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.SET_INTENSITY ? { supported_options: currentOptions() } : {}),
      ...(role === FEATURES.SET_SOLAR_MODE
        ? { supported_options: solarModeOptions(language) }
        : {}),
    })),
    params,
  };
}

/** The status text of a station, as `{ en, fr }`. */
export function statusOf(station) {
  const state = station.chargeState;
  if (state === undefined) {
    return STATUS_NAMES.unknown;
  }
  if (FAULT_STATES.has(state)) {
    return STATUS_NAMES[state];
  }
  if (station.locked === 1) {
    return STATUS_NAMES.locked;
  }
  if (station.paused === 1 && state !== CHARGE_STATE.NOT_CONNECTED) {
    return STATUS_NAMES.paused;
  }
  return STATUS_NAMES[state];
}

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(state) {
  switch (state) {
    case CHARGE_STATE.NOT_CONNECTED:
      return CONNECTOR_STATUS.AVAILABLE;
    case CHARGE_STATE.CONNECTED:
    case CHARGE_STATE.CHARGING:
    case CHARGE_STATE.VENTILATION:
      return CONNECTOR_STATUS.OCCUPIED;
    case CHARGE_STATE.LEAK_OR_PILOT_SHORT:
    case CHARGE_STATE.PILOT_OR_GROUND_FAULT:
      return CONNECTOR_STATUS.FAULTED;
    default:
      return undefined;
  }
}

/**
 * The charging state (OCPP's chargingState). Not charging and nothing known
 * to be plugged in: IDLE, so a scene never keeps reading "charging" after
 * the car left.
 */
export function chargingStateOf(station) {
  switch (station.chargeState) {
    case CHARGE_STATE.CHARGING:
    case CHARGE_STATE.VENTILATION:
      return CHARGING_STATE.CHARGING;
    case CHARGE_STATE.CONNECTED:
      return station.paused === 1 || station.locked === 1
        ? CHARGING_STATE.PAUSED_BY_CHARGER
        : CHARGING_STATE.EV_CONNECTED;
    case undefined:
      return undefined;
    default:
      return CHARGING_STATE.IDLE;
  }
}

export function pluggedOf(state) {
  if (state === CHARGE_STATE.NOT_CONNECTED) {
    return 0;
  }
  return connectorOf(state) === CONNECTOR_STATUS.OCCUPIED ? 1 : undefined;
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The charging power in W (rounded), undefined when missing or negative. */
export const powerOf = (station) =>
  station.chargePower !== undefined && station.chargePower >= 0
    ? Math.round(station.chargePower)
    : undefined;

/** A current setting of the station: an integer of 6 to 32 A, else undefined. */
export const ampsOf = (value) =>
  Number.isInteger(value) && value >= CURRENT.min && value <= CURRENT.max ? value : undefined;

/**
 * The current values of one station's device. Offline: only the status and
 * the connector (Gladys keeps the last value of the others).
 */
export function deviceStates(ids, station, { online, language }) {
  if (!online) {
    return [
      { role: FEATURES.STATUS, text: word(STATUS_NAMES.offline, language) },
      { role: FEATURES.CONNECTOR, state: CONNECTOR_STATUS.UNAVAILABLE },
    ].map(({ role, ...value }) => ({ device_feature_external_id: ids.feature(role), ...value }));
  }
  const states = [];
  // A value outside the bounds of its feature is dropped (Gladys keeps the last one).
  const add = (role, state) => {
    const { min, max } = DEFINITIONS[role];
    if (state !== undefined && Number.isFinite(state) && state >= min && state <= max) {
      states.push({ role, state });
    }
  };
  const addText = (role, value) => {
    if (value !== undefined) {
      states.push({ role, text: word(value, language) });
    }
  };
  addText(FEATURES.STATUS, statusOf(station));
  add(FEATURES.CONNECTOR, connectorOf(station.chargeState));
  add(FEATURES.CHARGING_STATE, chargingStateOf(station));
  add(FEATURES.PLUGGED, pluggedOf(station.chargeState));
  add(FEATURES.CHARGE_POWER, powerOf(station));
  for (const [role, value] of [
    [FEATURES.HOUSE_POWER, station.housePower],
    [FEATURES.SOLAR_POWER, station.solarPower],
    [FEATURES.BATTERY_POWER, station.batteryPower],
  ]) {
    add(role, value === undefined ? undefined : Math.round(value));
  }
  if (station.voltage !== undefined && station.voltage > 0) {
    add(FEATURES.VOLTAGE, Math.round(station.voltage));
  }
  if (station.chargeEnergy !== undefined && station.chargeEnergy >= 0) {
    add(FEATURES.SESSION_ENERGY, round(station.chargeEnergy, 2));
  }
  add(FEATURES.SESSION_DURATION, station.chargeTime);
  add(FEATURES.INTENSITY, station.intensity);
  add(FEATURES.MIN_INTENSITY, station.minIntensity);
  add(FEATURES.MAX_INTENSITY, station.maxIntensity);
  add(FEATURES.PAUSED, station.paused);
  add(FEATURES.LOCKED, station.locked);
  add(FEATURES.TIMER, station.timer);
  add(FEATURES.DYNAMIC, station.dynamic);
  add(FEATURES.PAUSE_DYNAMIC, station.pauseDynamic);
  add(FEATURES.READY, station.ready);
  addText(
    FEATURES.CHARGE_MODE,
    station.chargeMode === undefined
      ? undefined
      : CHARGE_MODE_NAMES[CHARGE_MODES[station.chargeMode]],
  );
  const mode = solarModeKey(station.solarMode);
  addText(FEATURES.SOLAR_MODE, mode === undefined ? undefined : SOLAR_MODE_NAMES[mode]);
  addText(
    FEATURES.METER,
    station.slaveError === undefined ? undefined : meterName(station.slaveError),
  );
  if (ampsOf(station.intensity) !== undefined) {
    states.push({ role: FEATURES.SET_INTENSITY, text: String(station.intensity) });
  }
  if (mode !== undefined) {
    states.push({ role: FEATURES.SET_SOLAR_MODE, text: mode });
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
