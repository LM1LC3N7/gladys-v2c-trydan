// -----------------------------------------------------------------------------
// V2C Trydan local API constants, manifest keys, limits and timings.
//
// The local API of a Trydan is plain HTTP on port 80, WITHOUT any
// authentication, as pytrydan (MIT, dgomes/pytrydan 1.0.6, the library of
// Home Assistant's V2C integration) reads it:
//   GET /RealTimeData              everything, one JSON object
//   GET /read/<Keyword>            one value, as text (keywords some firmware
//                                  versions leave out of RealTimeData)
//   GET /write/<Keyword>=<value>   one setting; the station answers "OK"
// Anyone on the network can read and drive the station: the docs say so.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 80;

export const PATHS = {
  realTime: '/RealTimeData',
  read: (keyword) => `/read/${keyword}`,
  write: (keyword, value) => `/write/${keyword}=${value}`,
};

/** The only keywords this integration ever writes (never Locked, ChargeMode, MinIntensity…). */
export const WRITABLE = Object.freeze(['Paused', 'Intensity', 'DynamicPowerMode']);

/**
 * The charging current: 6 to 32 A (pytrydan's `_is_intensity`, the range of
 * the station), and never outside MinIntensity..MaxIntensity read just before.
 */
export const CURRENT = {
  min: 6,
  max: 32,
};

/** ChargeState of pytrydan (models/trydan.py). 3 is not defined: unknown. */
export const CHARGE_STATE = {
  NOT_CONNECTED: 0,
  CONNECTED: 1,
  CHARGING: 2,
  LEAK_OR_PILOT_SHORT: 4,
  PILOT_OR_GROUND_FAULT: 5,
  VENTILATION: 6,
};
export const CHARGE_STATES = new Set(Object.values(CHARGE_STATE));
export const FAULT_STATES = new Set([
  CHARGE_STATE.LEAK_OR_PILOT_SHORT,
  CHARGE_STATE.PILOT_OR_GROUND_FAULT,
]);

/** ChargeMode of pytrydan: how the station is wired. Read only, never written. */
export const CHARGE_MODES = {
  0: 'single-phase',
  1: 'three-phase',
  2: 'mixed',
};

/**
 * DynamicPowerMode of pytrydan (the solar control of the station), by the
 * value the select sends. These keys are stored in users' scenes: frozen.
 */
export const SOLAR_MODES = Object.freeze({
  timed: 0, // TIMED_POWER_ENABLED: the schedule of the app or the V2C cloud
  'timed-off': 1, // TIMED_POWER_DISABLED
  'solar-min': 2, // FV + minimum power
  'solar-only': 3, // FV exclusive
  'solar-grid': 4, // FV + grid
  stop: 5, // stop mode
});
export const SOLAR_MODE_KEYS = Object.freeze(Object.keys(SOLAR_MODES));
export const solarModeKey = (value) => SOLAR_MODE_KEYS.find((key) => SOLAR_MODES[key] === value);

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  CHARGE_POWER: 'charge-power',
  HOUSE_POWER: 'house-power',
  SOLAR_POWER: 'solar-power',
  BATTERY_POWER: 'battery-power',
  VOLTAGE: 'installation-voltage',
  SESSION_ENERGY: 'session-energy',
  SESSION_DURATION: 'session-duration',
  INTENSITY: 'intensity',
  MIN_INTENSITY: 'min-intensity',
  MAX_INTENSITY: 'max-intensity',
  PAUSED: 'paused',
  LOCKED: 'locked',
  TIMER: 'timer',
  DYNAMIC: 'dynamic',
  PAUSE_DYNAMIC: 'pause-dynamic',
  READY: 'ready',
  CHARGE_MODE: 'charge-mode',
  SOLAR_MODE: 'solar-mode',
  METER: 'meter-status',
  PAUSE: 'pause-charge',
  RESUME: 'resume-charge',
  SET_INTENSITY: 'set-intensity',
  SET_SOLAR_MODE: 'set-solar-mode',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Stations of one integration. */
  addresses: 4,
  /** RealTimeData is about 400 bytes; 16 KB is plenty. */
  responseBytes: 16 * 1024,
  /** Longest text kept from an answer (firmware version). */
  textLength: 40,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** A read of the polling (pytrydan waits 10 s; a LAN station answers in well under 1 s). */
  readTimeout: 5 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429 (unexpected from a station, handled anyway): Retry-After bounded to 1 min .. 6 h, 5 min without. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** ChargeMode missing from RealTimeData: read alone at the first read, then every hour. */
  chargeModeEvery: HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the stations at most this often. */
  testCooldown: 10 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the command
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 1.5 s at most, and 0.3 s left to send after it. */
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until the state moves to what it asked, or 90 s. */
  guard: 90 * SECOND,
  /**
   * One change a minute per station at most for the charging current, the
   * solar mode and resume (no fine regulation; settings likely kept in
   * flash). Never for a pause.
   */
  commandMinInterval: MINUTE,
};
