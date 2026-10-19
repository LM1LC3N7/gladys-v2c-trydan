// -----------------------------------------------------------------------------
// The integration: the stations typed in the configuration (IP addresses or
// host names), one read of each every poll interval, the Gladys devices and
// their states, the transport badge, the "Test the connection" button, and
// the four commands (pause, resume, charging current, solar control mode),
// refused unless the configuration allows them. index.js only wires the SDK
// handlers to it.
//
// Commands follow the rules learnt on the previous modules (gladys-technove,
// gladys-keba):
//   - decided on a fresh read of the station only, never on the state kept in
//     memory, and refused when a value they need is missing;
//   - the "Allow the commands" option is checked on arrival and again right
//     before sending;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a command that may have reached the station (silence, a 5xx) is never
//     answered "not sent": "sent, without confirmation", then spaced reads;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time per station, except "pause", which is never
//     blocked: it never waits for another command, an older command not sent
//     yet gives way to it, and it is sent again once a command in flight
//     settles; never retried otherwise;
//   - the charging current: within MinIntensity..MaxIntensity read just
//     before, one change a minute per station at most.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressId, addressKey, normalizeConfig } from './config.js';
import {
  CURRENT,
  FAULT_STATES,
  FEATURES,
  PRESSED,
  SECOND,
  SOLAR_MODES,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  ampsOf,
  buildDevice,
  deviceStates,
  parseFeatureId,
  powerOf,
  stationIds,
  statusOf,
} from './devices.js';
import { ERRORS, STATUS_NAMES, T, age, summaryOf, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';
import { TrydanClient, errorReason } from './trydan/client.js';
import { ERROR_KINDS, resolveUnicast } from './trydan/http.js';

const both = (en, fr) => ({ en, fr });
const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** The commands held to one change a minute per station (never the pause), by key. */
const RATE_LIMITED_ROLES = {
  [FEATURES.SET_INTENSITY]: 'intensity',
  [FEATURES.SET_SOLAR_MODE]: 'mode',
  [FEATURES.RESUME]: 'resume',
};

/** The value a command kind watches in a read. */
const WATCHED = {
  paused: (s) => s.paused,
  intensity: (s) => s.intensity,
  mode: (s) => s.solarMode,
};

export class TrydanApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'v2c-trydan' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    resolve = resolveUnicast,
  }) {
    this.gladys = gladys;
    this.resolve = resolve;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new TrydanClient({ transport, now });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** addressKey -> station: { key, address, snapshot, online, failures, wait, timer, running, followUps, chargeMode… }. */
    this.stations = new Map();
    this.generation = 0;
    this.started = false;
    this.pausedUntil = 0;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** id -> the command holding the station: { role, seq, overtaken, again, promise }. */
    this.inFlight = new Map();
    /** id -> number of commands that arrived; id -> number of the last pause. */
    this.commandCount = new Map();
    this.lastPause = new Map();
    /** id -> the number of the newest command that reached the station. */
    this.lastAccepted = new Map();
    /** `${id}:intensity|mode|resume` -> when it was last sent (one a minute). */
    this.lastSentAt = new Map();
    /** `${id}:${kind}` -> number of writes of that kind. */
    this.writes = new Map();
    /** ids whose solar mode was set while dynamic modulation is off. */
    this.dynamicOff = new Set();
    /** `${id}:${kind}` -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** `${id}:${kind}` -> expected: accepted ("OK") but not applied by the last check. */
    this.notApplied = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await Promise.all([...this.stations.values()].map((s) => s.running));
    this.config = normalizeConfig(raw);
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    // A 429 pause survives a restart and a new configuration.
    if (this.memory.pause) {
      this.pausedUntil = Math.max(this.pausedUntil, this.memory.pause.until);
    }
    this.stations = new Map(
      this.config.addresses.map((address) => [
        addressKey(address),
        {
          key: addressKey(address),
          address,
          snapshot: undefined,
          online: undefined,
          failures: 0,
          wait: undefined,
          timer: undefined,
          running: undefined,
          followUps: new Set(),
          chargeMode: undefined,
          chargeModeAt: -Infinity,
          chargeModeMissing: false,
          // The ID last given at this address (kept in /data): a read
          // without ID keeps this identity (M1).
          knownId: this.memory.ids[addressKey(address)],
        },
      ]),
    );
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (this.stations.size === 0) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.withInvalid(this.pauseMessage() ?? T.connecting));
    await Promise.all([...this.stations.values()].map((station) => this.tick(station)));
  }

  stop() {
    this.generation += 1;
    for (const station of this.stations.values()) {
      this.clearTimer(station);
      for (const handle of station.followUps) {
        this.timers.clearTimeout(handle);
      }
      station.followUps.clear();
    }
    this.publisher.stop();
  }

  clearTimer(station) {
    if (station.timer) {
      this.timers.clearTimeout(station.timer);
      station.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. The 429 pause stays.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    await this.publishAll();
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      next.pollInterval !== this.config.pollInterval ||
      JSON.stringify(next.addresses) !== JSON.stringify(this.config.addresses) ||
      JSON.stringify(next.invalid) !== JSON.stringify(this.config.invalid)
    );
  }

  /** New addresses or interval restart; the option and the language apply at once. */
  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Trydan commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  get paused() {
    return this.now() < this.pausedUntil;
  }

  /**
   * The next read of a station: after the pause (never sooner than the
   * interval), after its backoff, else the interval.
   */
  schedule(station, delay) {
    this.clearTimer(station);
    const wait = this.paused
      ? Math.max(this.pausedUntil - this.now(), this.interval)
      : (delay ?? (station.online === false ? station.wait : this.interval));
    const generation = this.generation;
    station.timer = this.timers.setTimeout(
      () => {
        station.timer = undefined;
        if (generation === this.generation) {
          this.tick(station).catch(() => this.logger.error('Trydan refresh failed'));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time per station: a tick during a read joins it. */
  tick(station) {
    if (!station.running) {
      station.running = this.run(station).finally(() => {
        station.running = undefined;
      });
    }
    return station.running;
  }

  /** A read that starts now, never joining one begun before (after a command). */
  async freshTick(station) {
    if (station.running) {
      await station.running.catch(() => {});
    }
    return this.tick(station);
  }

  async run(station) {
    const generation = this.generation;
    if (this.paused) {
      await this.updateStatus();
      this.schedule(station);
      return;
    }
    try {
      const snapshot = await this.client.read(station.address, {
        timeoutMs: TIMINGS.readTimeout,
      });
      if (generation !== this.generation) {
        return;
      }
      await this.fillChargeMode(station, snapshot);
      if (generation !== this.generation) {
        return;
      }
      this.applyRead(station, snapshot);
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(station, err);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(station);
    }
  }

  /**
   * ChargeMode left out of RealTimeData (some firmware versions): read alone
   * at the first read, then every hour; a 404 stops it until a restart. Its
   * failure never blocks the main read: the last value is kept.
   */
  async fillChargeMode(station, snapshot) {
    if (snapshot.chargeMode !== undefined) {
      station.chargeMode = snapshot.chargeMode;
      return;
    }
    if (
      !station.chargeModeMissing &&
      !this.paused &&
      this.now() - station.chargeModeAt >= TIMINGS.chargeModeEvery
    ) {
      station.chargeModeAt = this.now();
      try {
        const mode = await this.client.readChargeMode(station.address, {
          timeoutMs: TIMINGS.readTimeout,
        });
        if (mode !== undefined) {
          station.chargeMode = mode;
        }
      } catch (err) {
        if (err.kind === ERROR_KINDS.HTTP && err.status === 404) {
          station.chargeModeMissing = true;
        } else if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
        }
        this.logger.info(`Trydan ${station.key}: ChargeMode not read (${errorReason(err)})`);
      }
    }
  }

  /** A read answered: the station as read, and the guards it may lift. */
  /**
   * The platform id of a read: its ID, else the ID last given at this
   * address (M1: a read without ID never flips the identity), else the address.
   */
  platformIdOf(station, snapshot) {
    return snapshot.id ?? station.knownId ?? addressId(station.address);
  }

  applyRead(station, snapshot) {
    if (snapshot.id && snapshot.id !== station.knownId) {
      station.knownId = snapshot.id;
      this.memory.ids[station.key] = snapshot.id;
      this.saveMemory();
    }
    snapshot.platformId = this.platformIdOf(station, snapshot);
    const id = snapshot.id ?? station.knownId;
    snapshot.label = id ? id.slice(-4).toUpperCase() : station.key;
    if (snapshot.chargeMode === undefined) {
      snapshot.chargeMode = station.chargeMode;
    }
    station.snapshot = snapshot;
    station.online = true;
    station.failures = 0;
    station.wait = undefined;
    station.error = undefined;
    this.observe(snapshot);
  }

  async failed(station, err) {
    const reason = errorReason(err);
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      await this.pause(err);
      this.logger.warn(`Trydan ${station.key}: ${reason}, pause`);
      return;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(station.failures, TIMINGS.backoff.length - 1)],
    );
    station.failures += 1;
    station.online = false;
    station.wait = wait;
    station.error = reason;
    this.logger.warn(`Trydan ${station.key}: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** A 429: every path waits (polling, button, commands), kept in /data. */
  async pause(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, this.interval, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.memory.pause = { until: this.pausedUntil };
    await this.saveMemory();
  }

  pauseMessage() {
    return this.paused ? T.rateLimited(age(this.pausedUntil - this.now())) : undefined;
  }

  withInvalid(message) {
    return this.config.invalid.length > 0 ? join(message, T.invalid(this.config.invalid)) : message;
  }

  summary(station) {
    const s = station.snapshot;
    const name = `V2C Trydan ${s.label}`;
    let summary = summaryOf({
      name,
      status: statusOf(s),
      power: powerOf(s),
      intensity: ampsOf(s.intensity),
    });
    const kinds = [...this.notApplied.keys()]
      .filter((key) => key.startsWith(`${s.platformId}:`))
      .map((key) => T.kinds[key.slice(s.platformId.length + 1)]);
    if (kinds.length > 0) {
      const list = both(kinds.map((k) => k.en).join(', '), kinds.map((k) => k.fr).join(', '));
      summary = join(summary, T.notApplied(name, list));
    }
    if (this.dynamicOff.has(s.platformId)) {
      summary = join(summary, T.dynamicOff(name));
    }
    return summary;
  }

  /** The connection status of the configuration screen, from every station. */
  async updateStatus() {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message);
      return;
    }
    const names = orphans
      .map((id) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === stationIds(this.gladys, id).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${id})`
          : id;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.orphans(names)));
  }

  /**
   * `[connected, message, plain]` from the configured stations; `plain`:
   * the same summary without "Connected", for a status shown as not connected.
   */
  status() {
    const stations = [...this.stations.values()];
    if (stations.length === 0) {
      return [
        false,
        this.config.invalid.length > 0
          ? join(T.noAddress, T.invalid(this.config.invalid))
          : T.noAddress,
      ];
    }
    const pause = this.pauseMessage();
    if (pause) {
      return [stations.some((s) => s.snapshot), this.withInvalid(pause)];
    }
    const down = stations.filter((s) => s.online === false);
    if (down.length > 0) {
      const wait = Math.min(...down.map((s) => s.wait ?? this.interval));
      return [false, this.withInvalid(T.unreachable(down.map((s) => s.key).join(', '), age(wait)))];
    }
    if (stations.some((s) => s.online === undefined)) {
      return [false, this.withInvalid(T.connecting)];
    }
    const summaries = stations.map((s) => this.summary(s));
    const summary = both(
      summaries.map((m) => m.en).join(' '),
      summaries.map((m) => m.fr).join(' '),
    );
    return [true, this.withInvalid(T.connected(summary)), this.withInvalid(summary)];
  }

  // --- Gladys ----------------------------------------------------------------

  /**
   * The stations read, one per platform id: an address online wins over one
   * that stopped answering, else the first address.
   */
  known() {
    const byId = new Map();
    for (const station of this.stations.values()) {
      const id = station.snapshot?.platformId;
      if (!id) {
        continue;
      }
      const held = byId.get(id);
      if (!held || (held.online === false && station.online !== false)) {
        byId.set(id, station);
      }
    }
    return byId;
  }

  /**
   * The platform ids of the devices created in Gladys that no station read
   * gives (an address removed, a station that never answered since the
   * start, or an ID that appeared). Empty while a first read is under way.
   */
  orphans() {
    if ([...this.stations.values()].some((s) => s.online === undefined)) {
      return [];
    }
    const known = this.known();
    const ids = [];
    for (const device of this.gladys.devices ?? []) {
      const match = /:trydan:([0-9a-z][0-9a-z-]{0,299})$/.exec(String(device?.external_id ?? ''));
      if (
        match &&
        !known.has(match[1]) &&
        stationIds(this.gladys, match[1]).device === device.external_id
      ) {
        ids.push(match[1]);
      }
    }
    return ids;
  }

  stationOf(id) {
    return this.known().get(id);
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const devices = [...this.known().values()].map((s) =>
      buildDevice(this.gladys, s.snapshot, this.config.language),
    );
    if (devices.length === 0) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const push = (states) => {
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    };
    for (const [id, station] of this.known()) {
      push(
        deviceStates(stationIds(this.gladys, id), station.snapshot, {
          online: station.online !== false,
          language: this.config.language,
        }),
      );
    }
    // A created device no station gives: unreachable, never left "charging".
    for (const id of this.orphans()) {
      push(
        deviceStates(
          stationIds(this.gladys, id),
          {},
          { online: false, language: this.config.language },
        ),
      );
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    for (const [id, station] of this.known()) {
      const externalId = stationIds(this.gladys, id).device;
      if (created.has(externalId)) {
        entries.push({
          external_id: externalId,
          transport:
            station.online === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL,
        });
      }
    }
    for (const id of this.orphans()) {
      entries.push({
        external_id: stationIds(this.gladys, id).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last reads, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  async testConnection() {
    if (this.stations.size === 0) {
      return this.config.invalid.length > 0
        ? join(T.noAddress, T.invalid(this.config.invalid))
        : T.noAddress;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown && this.now() >= this.lastTestAt) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    this.lastTestAt = this.now();
    // A read now of every station (a read in progress is joined).
    await Promise.all([...this.stations.values()].map((station) => this.tick(station)));
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, strictly: null, '', ' ', true or 12.5 are never
   * read as a number; a mode is one of the frozen keys. Throws a refusal
   * when it is not valid.
   */
  commandValue(role, value) {
    if (role === FEATURES.PAUSE || role === FEATURES.RESUME) {
      if (value === PRESSED || value === String(PRESSED)) {
        return PRESSED;
      }
      throw this.refusal(ERRORS.badButton);
    }
    if (role === FEATURES.SET_SOLAR_MODE) {
      if (typeof value === 'string' && Object.hasOwn(SOLAR_MODES, value)) {
        return value;
      }
      throw this.refusal(ERRORS.badMode);
    }
    const amps =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d{1,2}\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    if (!Number.isInteger(amps)) {
      throw this.refusal(ERRORS.badCurrent);
    }
    if (amps < CURRENT.min || amps > CURRENT.max) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, CURRENT.max));
    }
    return amps;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.commandValue(target.role, value);
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    const { id, role } = target;
    const pause = role === FEATURES.PAUSE;
    // One change a minute per station for the current, the mode and resume
    // (M4); never for a pause.
    const limited = RATE_LIMITED_ROLES[role];
    if (limited) {
      const last = this.lastSentAt.get(`${id}:${limited}`);
      const since = last === undefined ? Infinity : received - last;
      if (since >= 0 && since < TIMINGS.commandMinInterval) {
        throw this.refusal(ERRORS.tooOften(age(TIMINGS.commandMinInterval - since)));
      }
    }
    const seq = (this.commandCount.get(id) ?? 0) + 1;
    this.commandCount.set(id, seq);
    if (pause) {
      // Set on arrival: an older command of this station that has not left
      // yet gives way (checkBeforeSend).
      this.lastPause.set(id, seq);
    }
    // One command at a time per station; a pause is never refused for a
    // command in flight (it goes at once, and again once that one settles).
    const previous = this.inFlight.get(id);
    if (previous && previous.role === FEATURES.PAUSE) {
      throw this.refusal(pause ? ERRORS.pauseRunning : ERRORS.stillRunning);
    }
    if (previous && !pause) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = {
      role,
      seq,
      previous,
      overtaken: undefined,
      sent: false,
      again: undefined,
      promise: undefined,
    };
    let previousRunning = false;
    if (previous) {
      entry.overtaken = previous.promise;
      previousRunning = true;
      previous.promise
        .catch(() => {})
        .finally(() => {
          previousRunning = false;
        });
    }
    this.inFlight.set(id, entry);
    entry.promise = this.command(target, wanted, received, entry);
    const release = () => {
      if (this.inFlight.get(id) !== entry) {
        return;
      }
      // The command it overtook still runs: it holds the station again.
      if (previousRunning) {
        this.inFlight.set(id, previous);
      } else {
        this.inFlight.delete(id);
      }
    };
    try {
      return await entry.promise;
    } finally {
      // A pause to send again keeps the station busy until it is done (the
      // ack does not wait for it): a newer command is refused meanwhile.
      if (entry.again) {
        entry.again.finally(release);
      } else {
        release();
      }
    }
  }

  /** A command that may start a charge: refused on a fault or an unknown state. */
  refuseUnsafeStart(s) {
    if (FAULT_STATES.has(s.chargeState)) {
      throw this.refusal(ERRORS.fault(STATUS_NAMES[s.chargeState]));
    }
    if (s.chargeState === undefined) {
      throw this.refusal(ERRORS.unknownStatus);
    }
  }

  /** What to send, from the station just read; undefined when it is already so. */
  plan(role, wanted, s, id, entry) {
    if (role === FEATURES.PAUSE) {
      // Sent even when Paused is missing: pausing once more is harmless.
      // A command still in flight is pending too: never "already paused" over it.
      if (s.paused === 1 && !this.guardActive(id, 'paused') && !entry.overtaken) {
        return undefined;
      }
      return { keyword: 'Paused', value: 1, kind: 'paused', from: s.paused, expected: 1 };
    }
    if (role === FEATURES.RESUME) {
      if (s.paused === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      this.refuseUnsafeStart(s);
      if (s.paused === 0 && !this.guardActive(id, 'paused')) {
        return undefined;
      }
      return { keyword: 'Paused', value: 0, kind: 'paused', from: s.paused, expected: 0 };
    }
    if (role === FEATURES.SET_SOLAR_MODE) {
      if (s.solarMode === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      const value = SOLAR_MODES[wanted];
      // Any mode but "stop" may take power (from the grid, the sun or a
      // schedule) and so start a charge: the checks of "Resume" (I3).
      if (value !== SOLAR_MODES.stop) {
        this.refuseUnsafeStart(s);
      }
      if (s.solarMode === value && !this.guardActive(id, 'mode')) {
        return undefined;
      }
      return {
        keyword: 'DynamicPowerMode',
        value,
        kind: 'mode',
        from: s.solarMode,
        expected: value,
      };
    }
    // The charging current: within the range the station declares, read just before.
    const min = ampsOf(s.minIntensity);
    const max = ampsOf(s.maxIntensity);
    if (min === undefined || max === undefined || min > max) {
      throw this.refusal(ERRORS.unknownBounds);
    }
    if (wanted < min || wanted > max) {
      throw this.refusal(ERRORS.outOfBounds(min, max));
    }
    if (s.intensity === wanted && !this.guardActive(id, 'intensity')) {
      return undefined;
    }
    return {
      keyword: 'Intensity',
      value: wanted,
      kind: 'intensity',
      from: s.intensity,
      expected: wanted,
    };
  }

  /**
   * The checks before sending, on the latest configuration: the option, the
   * same start, the station still read, no 429 pause, and no pause of this
   * station arrived since this command (a pause is never held back).
   */
  checkBeforeSend(generation, id, entry) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || !this.stationOf(id)) {
      throw this.refusal(ERRORS.unknownStation);
    }
    if (entry.role !== FEATURES.PAUSE && (this.lastPause.get(id) ?? 0) > entry.seq) {
      throw this.refusal(ERRORS.pauseMeanwhile);
    }
    const paused = this.pauseMessage();
    if (paused) {
      throw this.refusal(ERRORS.paused(age(this.pausedUntil - this.now())));
    }
  }

  async command({ id, role }, wanted, received, entry) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    this.checkBeforeSend(generation, id, entry);
    const station = this.stationOf(id);
    // One DNS resolution per command: the read and the write go to the
    // same address (M6).
    let address;
    try {
      address = await this.addressOf(station.address);
    } catch {
      throw this.refusal(ERRORS.notSent('unreachable'));
    }
    entry.address = address;
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownStation);
    }

    let plan;
    if (role === FEATURES.PAUSE && entry.overtaken) {
      // A command is in flight: a read now may wait behind its write (a
      // station that handles one request at a time) and time out. The pause
      // goes without it (I2): pausing once more is harmless.
      plan = { keyword: 'Paused', value: 1, kind: 'paused', from: undefined, expected: 1 };
    } else {
      const readBudget = Math.min(
        TIMINGS.commandReadMax,
        sendBy - TIMINGS.commandMinSend - this.now(),
      );
      if (readBudget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      // The state just before acting, never the one in memory.
      let fresh;
      try {
        fresh = await this.client.read(address, { timeoutMs: readBudget });
      } catch (err) {
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
          this.updateStatus().catch(() => {});
        }
        throw this.refusal(ERRORS.unknownState(errorReason(err)));
      }
      if (generation !== this.generation) {
        throw this.refusal(ERRORS.unknownStation);
      }
      if (this.platformIdOf(station, fresh) !== id) {
        throw this.refusal(ERRORS.otherStation);
      }
      this.applyRead(station, fresh);
      // Shown in the background: the ack never waits for Gladys.
      this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
      plan = this.plan(role, wanted, fresh, id, entry);
      if (!plan) {
        return;
      }
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, id, entry);
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const timeoutMs = Math.max(200, received + TIMINGS.commandAnswerBy - this.now());
    const limited = RATE_LIMITED_ROLES[role];
    const minuteKey = limited ? `${id}:${limited}` : undefined;
    const previousSent = minuteKey ? this.lastSentAt.get(minuteKey) : undefined;
    if (minuteKey) {
      this.lastSentAt.set(minuteKey, this.now());
    }
    this.logger.info(`Trydan ${station.key}: ${plan.keyword}=${plan.value}`);
    entry.sent = true;
    const write = this.countWrite(id, plan.kind);
    try {
      await this.client.write(address, plan.keyword, plan.value, {
        startBy: sendBy,
        timeoutMs,
      });
    } catch (err) {
      const reason = errorReason(err);
      this.logger.warn(`Trydan ${station.key}: ${plan.keyword} failed (${reason})`);
      const unsent =
        err.kind === ERROR_KINDS.LATE || err.kind === ERROR_KINDS.UNREACHABLE || err.notSent;
      if (unsent) {
        // Never left: the minute starts from the previous one, and it does
        // not count as a write (a pause is still sent again, M3 check).
        entry.sent = false;
        this.uncountWrite(id, plan.kind, write);
        if (minuteKey) {
          if (previousSent === undefined) this.lastSentAt.delete(minuteKey);
          else this.lastSentAt.set(minuteKey, previousSent);
        }
      }
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (unsent) {
        // Nothing accepted the connection, or the error came before the transport.
        throw this.refusal(ERRORS.notSent(reason));
      }
      this.accepted(id, entry);
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.HTTP && err.status < 500) {
        this.followUp(station);
        throw this.refusal(ERRORS.refused(reason));
      }
      // A 5xx, a silence, an answer other than "OK" (M2), or any other error
      // after the transport started: it may have reached the station.
      this.guard(id, plan);
      this.followUp(station);
      this.pauseAgain(station, id, entry, plan);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.accepted(id, entry);
    if (plan.kind === 'mode') {
      // A solar mode does nothing while dynamic modulation is off (M5): said
      // in the status until a read shows it on.
      if (station.snapshot?.dynamic === 0 && plan.value !== SOLAR_MODES.stop) {
        this.dynamicOff.add(id);
        this.logger.warn(`Trydan ${station.key}: solar mode set while dynamic modulation is off`);
        this.updateStatus().catch(() => {});
      } else {
        this.dynamicOff.delete(id);
      }
    }
    // "OK" means accepted, not applied: checked after the reads.
    this.guard(id, plan);
    this.followUp(station, { id, kind: plan.kind, expected: plan.expected, write });
    this.pauseAgain(station, id, entry, plan);
  }

  /** The address to talk to for one command: a host name resolved once (M6). */
  async addressOf({ host, port }) {
    return isIP(host) ? { host, port } : { host: await this.resolve(host), port };
  }

  /** A command that reached the station (sent, answered or not): its intent counts (I1). */
  accepted(id, entry) {
    this.lastAccepted.set(id, Math.max(this.lastAccepted.get(id) ?? 0, entry.seq));
  }

  /** Numbers the writes of one kind: an older check never reports over a newer write (M3). */
  countWrite(id, kind) {
    const key = `${id}:${kind}`;
    const n = (this.writes.get(key) ?? 0) + 1;
    this.writes.set(key, n);
    return n;
  }

  uncountWrite(id, kind, n) {
    const key = `${id}:${kind}`;
    if (this.writes.get(key) === n) {
      this.writes.set(key, n - 1);
    }
  }

  /**
   * A pause that overtook a command still in flight (a resume or a current
   * may land after it): sent once more when that command settles. Same
   * write, no state read: it repeats a pause already decided.
   */
  pauseAgain(station, id, entry, plan) {
    if (!entry.overtaken || plan.keyword !== 'Paused' || plan.value !== 1) {
      return;
    }
    const generation = this.generation;
    // Kept in entry.again: the pause holds the station (inFlight) until it ends.
    entry.again = entry.overtaken
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || !this.config.allowCommands) {
          return;
        }
        if (!entry.previous?.sent) {
          // The overtaken command never left (it gave way): nothing to undo.
          return;
        }
        if ((this.lastAccepted.get(id) ?? 0) > entry.seq) {
          // A newer command reached the station since this pause: its intent
          // wins. A refused one ("still running") never counts (I1).
          this.logger.info(`Trydan ${station.key}: pause not sent again (newer command)`);
          return;
        }
        if (this.paused) {
          this.logger.info(`Trydan ${station.key}: pause not sent again (paused after a 429)`);
          return;
        }
        this.logger.warn(`Trydan ${station.key}: pause sent again after the command in flight`);
        this.countWrite(id, 'paused');
        await this.client.write(entry.address, 'Paused', 1, {
          startBy: Infinity,
          timeoutMs: TIMINGS.readTimeout,
        });
        this.guard(id, plan);
      })
      .catch(async (err) => {
        this.logger.warn(`Trydan ${station.key}: pause again failed (${errorReason(err)})`);
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
          await this.updateStatus();
        }
      })
      .catch(() => {});
  }

  /**
   * Spaced reads after a command: its effect, then a check. Each starts
   * after its time, never joining a read begun before. `check`: after the
   * last one, whether an accepted command was applied.
   */
  followUp(station, check) {
    const generation = this.generation;
    TIMINGS.followUps.forEach((delay, i) => {
      const handle = this.timers.setTimeout(() => {
        station.followUps.delete(handle);
        if (generation !== this.generation) {
          return;
        }
        const last = check && i === TIMINGS.followUps.length - 1;
        this.freshTick(station)
          .then(() => (last ? this.checkApplied(station, check) : undefined))
          .catch(() => this.logger.error('Trydan refresh failed'));
      }, delay);
      station.followUps.add(handle);
    });
  }

  /** After the last read: an accepted command whose value never came is reported once. */
  async checkApplied(station, { id, kind, expected, write }) {
    const s = station.snapshot;
    const key = `${id}:${kind}`;
    if (station.online === false || s?.platformId !== id) {
      return;
    }
    if (this.writes.get(key) !== write) {
      // A newer write of this kind left after it (a pause over a resume):
      // it overrode this one on purpose, nothing to report (M3).
      return;
    }
    const value = WATCHED[kind](s);
    if (value === expected) {
      this.notApplied.delete(key);
      return;
    }
    if (value !== undefined && !this.notApplied.has(key)) {
      this.notApplied.set(key, expected);
      this.logger.warn(`Trydan ${station.key}: ${kind} accepted but not applied`);
      await this.updateStatus();
    }
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a command, until the station shows it: a new command of the same
   * kind is always sent, never answered "already so" on a state that may not
   * show the previous one yet. The start state is kept: a read equal to it
   * lifts nothing until a move was seen.
   */
  guard(id, plan) {
    this.guards.set(`${id}:${plan.kind}`, {
      from: plan.from,
      expected: plan.expected,
      moved: plan.from === undefined,
      until: this.now() + TIMINGS.guard,
    });
  }

  guardActive(id, kind) {
    const key = `${id}:${kind}`;
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read of a station, through its guards: never lifted on an unknown value. */
  observe(snapshot) {
    const id = snapshot.platformId;
    if (snapshot.dynamic === 1) {
      this.dynamicOff.delete(id);
    }
    for (const [kind, read] of Object.entries(WATCHED)) {
      const value = read(snapshot);
      if (value === undefined) {
        continue;
      }
      const key = `${id}:${kind}`;
      if (this.notApplied.get(key) === value) {
        this.notApplied.delete(key);
      }
      if (!this.guardActive(id, kind)) {
        continue;
      }
      const guard = this.guards.get(key);
      if (value !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && value === guard.expected) {
        this.guards.delete(key);
      }
    }
  }
}
