// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and fake stations behind the transport. Timers and Date are mocked:
// the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TrydanApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { HOST, ID, NOW, fakeStations, realTime, settle } from './fixtures/fakeTrydan.js';

const CONFIG = { addresses: HOST };
const ALLOWED = { addresses: HOST, allow_commands: true };
const DEVICE = `ext:test-integration:trydan:${ID}`;
const feature = (role, device = DEVICE) => `${device}:${role}`;

async function setup(
  t,
  {
    config = CONFIG,
    server = fakeStations(),
    store = memoryStore(),
    create = true,
    logs = [],
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new TrydanApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  /** Sends a command; returns the ack (a promise) after `wait` ms of clock. */
  const send = (role, value = 1, device = DEVICE) => {
    const created = gladys.fake.devices.find((d) => d.external_id === device);
    const target = created.features.find((f) => f.external_id === feature(role, device));
    return gladys.fake.setValue(created, target, value);
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = send(role, value);
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys, app, server, store, advance, logs, send, press, station: server.stations[HOST] };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role, device = DEVICE) => gladys.fake.lastState(feature(role, device));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);
const failure = async (ack) => {
  const result = await ack;
  assert.equal(result.success, false, 'the command should fail');
  return result.error;
};
const ok = async (ack) => {
  const result = await ack;
  assert.equal(result.success, true, result.error);
};

test('without an address, the status asks for it and nothing is requested', async (t) => {
  const server = fakeStations();
  const { gladys } = await setup(t, { config: {}, server });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(server.requests.length, 0);
});

test('a non-unicast address is refused and named, never read', async (t) => {
  const server = fakeStations();
  const { gladys } = await setup(t, { config: { addresses: '127.0.0.1, 224.0.0.1' }, server });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).en, /127\.0\.0\.1 \(not a unicast address\)/);
  assert.match(message(gladys).fr, /224\.0\.0\.1 \(pas une adresse d'appareil\)/);
});

test('one read: the device, its features, then its states', async (t) => {
  const { gladys, server } = await setup(t);
  assert.deepEqual(
    server.requests.map((r) => `${r.host}:${r.port}${r.path}`),
    [`${HOST}:80/RealTimeData`, `${HOST}:80/read/ChargeMode`],
  );
  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'V2C Trydan CD34');
  assert.deepEqual(device.params, [
    { name: 'station_id', value: ID },
    { name: 'firmware', value: '2.1.7' },
  ]);
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.slice(DEVICE.length + 1),
      f.category,
      f.type,
      f.unit,
      f.read_only,
    ]),
    [
      ['status', 'text', 'text', undefined, true],
      ['connector-status', 'charging-station', 'connector-status', undefined, true],
      ['charging-state', 'charging-station', 'charging-state', undefined, true],
      ['plugged', 'electrical-vehicle-charge', 'plugged', undefined, true],
      ['charge-power', 'energy-sensor', 'power', 'watt', true],
      ['house-power', 'energy-sensor', 'power', 'watt', true],
      ['solar-power', 'energy-sensor', 'power', 'watt', true],
      ['battery-power', 'energy-sensor', 'power', 'watt', true],
      ['installation-voltage', 'energy-sensor', 'voltage', 'volt', true],
      [
        'session-energy',
        'electrical-vehicle-charge',
        'last-charge-energy-added',
        'kilowatt-hour',
        true,
      ],
      ['session-duration', 'duration', 'integer', 'seconds', true],
      ['intensity', 'electrical-vehicle-charge', 'target-current', 'ampere', true],
      ['min-intensity', 'electrical-vehicle-charge', 'target-current', 'ampere', true],
      ['max-intensity', 'electrical-vehicle-charge', 'target-current', 'ampere', true],
      ['paused', 'unknown', 'binary', undefined, true],
      ['locked', 'unknown', 'binary', undefined, true],
      ['timer', 'unknown', 'binary', undefined, true],
      ['dynamic', 'unknown', 'binary', undefined, true],
      ['pause-dynamic', 'unknown', 'binary', undefined, true],
      ['ready', 'unknown', 'binary', undefined, true],
      ['charge-mode', 'text', 'text', undefined, true],
      ['solar-mode', 'text', 'text', undefined, true],
      ['meter-status', 'text', 'text', undefined, true],
      ['pause-charge', 'button', 'push', undefined, false],
      ['resume-charge', 'button', 'push', undefined, false],
      ['set-intensity', 'text', 'select', undefined, false],
      ['set-solar-mode', 'text', 'select', undefined, false],
    ],
  );
  const options = (role) =>
    device.features.find((f) => f.external_id === feature(role)).supported_options;
  assert.deepEqual(
    options('set-intensity').map((o) => o.value),
    Array.from({ length: 27 }, (_, i) => String(i + 6)),
  );
  assert.deepEqual(
    options('set-solar-mode').map((o) => o.value),
    ['timed', 'timed-off', 'solar-min', 'solar-only', 'solar-grid', 'stop'],
  );
  // No feature may be a switch or a writable binary.
  for (const f of device.features) {
    assert.notEqual(f.category, 'switch');
    assert.ok(f.read_only || f.type !== 'binary', f.external_id);
  }

  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.CHARGING);
  assert.equal(last(gladys, 'plugged'), 1);
  assert.equal(last(gladys, 'charge-power'), 2664);
  assert.equal(last(gladys, 'house-power'), 450);
  assert.equal(last(gladys, 'solar-power'), 1800);
  assert.equal(last(gladys, 'battery-power'), 0);
  assert.equal(last(gladys, 'installation-voltage'), 230);
  assert.equal(last(gladys, 'session-energy'), 7.6);
  assert.equal(last(gladys, 'session-duration'), 9979);
  assert.equal(last(gladys, 'intensity'), 12);
  assert.equal(last(gladys, 'min-intensity'), 6);
  assert.equal(last(gladys, 'max-intensity'), 16);
  assert.equal(last(gladys, 'paused'), 0);
  assert.equal(last(gladys, 'timer'), 1);
  assert.equal(last(gladys, 'solar-mode'), 'Solaire + puissance minimale');
  assert.equal(last(gladys, 'meter-status'), 'Sans erreur');
  assert.equal(last(gladys, 'set-intensity'), '12');
  assert.equal(last(gladys, 'set-solar-mode'), 'solar-min');
  assert.equal(last(gladys, 'charge-mode'), undefined, 'not given, 404 on /read');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /V2C Trydan CD34 : En charge, 2664 W, 12 A/);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
});

test('the session energy is a plain sensor: never an index, never a consumption', async (t) => {
  const { gladys, advance } = await setup(t);
  await advance(2 * MINUTE, 10 * SECOND);
  for (const f of deviceOf(gladys).features) {
    assert.ok(
      !(f.category === 'energy-sensor' && ['energy', 'index'].includes(f.type)),
      `${f.external_id} is an energy index`,
    );
  }
  assert.deepEqual(gladys.fake.publishedEnergyConsumption, []);
});

test('ChargeMode: from RealTimeData, else /read every hour, a 404 stops it', async (t) => {
  const server = fakeStations({ [HOST]: { data: realTime(), keywords: { ChargeMode: 1 } } });
  const { gladys, advance } = await setup(t, { server });
  assert.equal(last(gladys, 'charge-mode'), 'Triphasé');
  const reads = () => server.requests.filter((r) => r.path === '/read/ChargeMode').length;
  await advance(30 * MINUTE, 30 * SECOND);
  assert.equal(reads(), 1, 'once an hour at most');
  await advance(31 * MINUTE, 30 * SECOND);
  assert.equal(reads(), 2);
  // A failing secondary read never blocks the main data; the last value is kept.
  delete server.stations[HOST].keywords.ChargeMode;
  server.stations[HOST].data.ChargePower = 1000;
  await advance(HOUR, 30 * SECOND);
  assert.equal(last(gladys, 'charge-power'), 1000);
  assert.equal(last(gladys, 'charge-mode'), 'Triphasé');
  const count = reads();
  await advance(2 * HOUR, MINUTE);
  assert.equal(reads(), count, 'a 404 stops it');
  // Given by RealTimeData: never read alone.
  server.stations[HOST].data.ChargeMode = 0;
  await advance(MINUTE);
  assert.equal(last(gladys, 'charge-mode'), 'Monophasé');
});

test('statuses: paused, locked, no vehicle, faults, unknown', async (t) => {
  const { gladys, advance, station } = await setup(t);
  station.data = realTime({ ChargeState: 1, Paused: 1, ChargePower: 0 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Branché, en pause');
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.PAUSED_BY_CHARGER);
  station.data = realTime({ ChargeState: 1, ChargePower: 0 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Branché, pas en charge');
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.EV_CONNECTED);
  station.data = realTime({ ChargeState: 1, Locked: 1, ChargePower: 0 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Borne verrouillée');
  station.data = realTime({ ChargeState: 0, ChargePower: 0 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Aucun véhicule');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.AVAILABLE);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.IDLE);
  assert.equal(last(gladys, 'plugged'), 0);
  station.data = realTime({ ChargeState: 5, ChargePower: 0 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Défaut : pilote ou terre');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.FAULTED);
  station.data = realTime({ ChargeState: 3, HousePower: -2500, SlaveError: 10 });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'État inconnu');
  assert.equal(last(gladys, 'house-power'), -2500, 'exporting');
  assert.equal(last(gladys, 'meter-status'), 'Pince non branchée');
});

test('a station that stops answering: offline states, badge, spaced new tries', async (t) => {
  const { gladys, server, advance, station } = await setup(t);
  station.down = true;
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(last(gladys, 'charge-power'), 2664, 'the last power is kept');
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /No answer from 192\.168\.1\.60/);
  // Never read again sooner than the interval: 30 s, 1 min, 2 min, 5 min.
  const before = server.reads().length;
  await advance(29 * SECOND);
  assert.equal(server.reads().length, before);
  await advance(SECOND);
  assert.equal(server.reads().length, before + 1);
  await advance(59 * SECOND);
  assert.equal(server.reads().length, before + 1);
  await advance(SECOND);
  assert.equal(server.reads().length, before + 2);
  station.down = false;
  await advance(2 * MINUTE);
  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a station without ID: keyed by its address', async (t) => {
  const data = realTime();
  delete data.ID;
  const server = fakeStations({ [HOST]: { data } });
  const { gladys } = await setup(t, { server });
  const device = deviceOf(gladys);
  assert.equal(device.external_id, 'ext:test-integration:trydan:ip-192-168-1-60');
  assert.equal(device.name, `V2C Trydan ${HOST}`);
  assert.deepEqual(device.params, [{ name: 'firmware', value: '2.1.7' }]);
});

test('commands are refused while the option is off (the default)', async (t) => {
  const { server, press } = await setup(t);
  for (const [role, value] of [
    ['pause-charge', 1],
    ['resume-charge', 1],
    ['set-intensity', '10'],
    ['set-solar-mode', 'solar-only'],
  ]) {
    assert.match(await failure(press(role, value)), /Autoriser les commandes/);
  }
  assert.deepEqual(server.writes(), []);
});

test('read-only features and bad values are refused unsent', async (t) => {
  const { server, press } = await setup(t, { config: ALLOWED });
  assert.match(await failure(press('paused', 1)), /lecture seule/);
  for (const value of [0, 2, '', null, true]) {
    assert.match(await failure(press('pause-charge', value)), /valeur 1/);
  }
  for (const value of ['', ' ', '10.5', 10.5, null, true, '5', 33, '1e1']) {
    assert.match(await failure(press('set-intensity', value)), /courant de charge/);
  }
  for (const value of ['', 'fast', '__proto__', 'toString', 3, null]) {
    assert.match(await failure(press('set-solar-mode', value)), /Mode de pilotage solaire inconnu/);
  }
  assert.deepEqual(server.writes(), []);
});

test('pause: decided on a fresh read, sent, then read again', async (t) => {
  const { gladys, server, press, advance } = await setup(t, { config: ALLOWED });
  const before = server.reads().length;
  await ok(press('pause-charge'));
  assert.deepEqual(server.writes(), ['/write/Paused=1']);
  assert.ok(server.reads().length >= before + 1, 'read just before');
  await advance(20 * SECOND);
  assert.equal(last(gladys, 'paused'), 1);
  assert.equal(last(gladys, 'status'), 'Branché, en pause');
  // Already paused (no guard any more): nothing sent.
  await advance(2 * MINUTE);
  await ok(press('pause-charge'));
  assert.deepEqual(server.writes(), ['/write/Paused=1']);
  await ok(press('resume-charge'));
  assert.deepEqual(server.writes(), ['/write/Paused=1', '/write/Paused=0']);
});

test('resume is refused on a fault or an unknown state', async (t) => {
  const { server, press, station } = await setup(t, { config: ALLOWED });
  station.data = realTime({ ChargeState: 4, Paused: 1 });
  assert.match(await failure(press('resume-charge')), /fuite ou court-circuit/);
  station.data = realTime({ ChargeState: 3, Paused: 1 });
  assert.match(await failure(press('resume-charge')), /état de la borne est inconnu/);
  station.data = realTime({ Paused: undefined });
  assert.match(await failure(press('resume-charge')), /n'a pas donné l'état/);
  assert.deepEqual(server.writes(), []);
  // A pause goes even without Paused: pausing once more is harmless.
  await ok(press('pause-charge'));
  assert.deepEqual(server.writes(), ['/write/Paused=1']);
});

test('the option turned off during the fresh read: refused unsent', async (t) => {
  const { app, server, send, advance, station } = await setup(t, { config: ALLOWED });
  station.readDelay = 500;
  const ack = send('pause-charge');
  await settle();
  await app.configUpdated({ addresses: HOST, allow_commands: false });
  await advance(5 * SECOND, 100);
  await failure(ack);
  assert.deepEqual(server.writes(), []);
});

test('the current: within MinIntensity..MaxIntensity read just before, one a minute', async (t) => {
  const { server, press, advance, station } = await setup(t, { config: ALLOWED });
  assert.match(await failure(press('set-intensity', '20')), /entre 6 et 16 A/);
  station.data.MaxIntensity = 32;
  station.data.MinIntensity = 8;
  assert.match(await failure(press('set-intensity', 6)), /entre 8 et 32 A/);
  assert.deepEqual(server.writes(), []);
  await ok(press('set-intensity', '20'));
  assert.deepEqual(server.writes(), ['/write/Intensity=20']);
  assert.match(await failure(press('set-intensity', '16')), /par minute au plus/);
  // Pause stays available.
  await ok(press('pause-charge'));
  await advance(MINUTE);
  await ok(press('set-intensity', '16'));
  assert.deepEqual(server.writes(), [
    '/write/Intensity=20',
    '/write/Paused=1',
    '/write/Intensity=16',
  ]);
  // A range the station does not give (or gives wrong) refuses.
  await advance(MINUTE);
  station.data.MaxIntensity = undefined;
  assert.match(await failure(press('set-intensity', '10')), /courant minimal et maximal/);
  station.data.MaxIntensity = 6;
  station.data.MinIntensity = 10;
  assert.match(await failure(press('set-intensity', '8')), /courant minimal et maximal/);
  assert.equal(server.writes().length, 3);
});

test('a current refused unsent does not start the minute', async (t) => {
  const { server, press, station } = await setup(t, { config: ALLOWED });
  station.writeDown = true;
  assert.match(await failure(press('set-intensity', '10')), /pas pu être jointe.*non envoyée/);
  station.writeDown = false;
  await ok(press('set-intensity', '10'));
  // The first one never connected.
  assert.deepEqual(server.writes(), ['/write/Intensity=10', '/write/Intensity=10']);
});

test('the solar control mode', async (t) => {
  const { gladys, server, press, advance } = await setup(t, { config: ALLOWED });
  await ok(press('set-solar-mode', 'solar-only'));
  assert.deepEqual(server.writes(), ['/write/DynamicPowerMode=3']);
  await advance(20 * SECOND);
  assert.equal(last(gladys, 'solar-mode'), 'Solaire seul');
  assert.equal(last(gladys, 'set-solar-mode'), 'solar-only');
  await advance(2 * MINUTE);
  await ok(press('set-solar-mode', 'solar-only'));
  assert.equal(server.writes().length, 1, 'already so: not sent');
});

test('outcomes: "OK" missing, unreachable, silence', async (t) => {
  const { server, press, station, advance } = await setup(t, { config: ALLOWED });
  station.applies = false;
  station.writeBody = 'ERROR';
  // M2: an answer other than "OK" may still have been applied.
  assert.match(
    await failure(press('pause-charge')),
    /envoyée, sans confirmation \(unexpected_answer\)/,
  );
  station.writeBody = undefined;
  station.writeStatus = 500;
  assert.match(await failure(press('pause-charge')), /envoyée, sans confirmation \(HTTP 500\)/);
  station.writeStatus = 404;
  await advance(2 * MINUTE);
  assert.match(await failure(press('pause-charge')), /a refusé la commande \(HTTP 404\)/);
  station.writeStatus = undefined;
  station.writeSilent = true;
  assert.match(await failure(press('pause-charge')), /envoyée, sans confirmation \(timeout\)/);
  assert.equal(server.writes().length, 4);
});

test('a slow fresh read: refused unsent, within the 5 s of Gladys', async (t) => {
  const { server, send, advance, station } = await setup(t, { config: ALLOWED });
  station.readDelay = 3_000;
  const ack = send('pause-charge');
  await settle();
  await advance(4_500, 100);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /relu juste avant \(timeout\)/);
  assert.deepEqual(server.writes(), []);
});

test('another command while one runs is refused; a pause never is', async (t) => {
  const { server, send, advance, station } = await setup(t, { config: ALLOWED });
  station.data.MaxIntensity = 32;
  station.writeDelay = 2_000;
  const current = send('set-intensity', '20');
  await settle();
  await advance(500, 100);
  const mode = send('set-solar-mode', 'stop');
  await settle();
  const pause = send('pause-charge');
  await settle();
  await advance(8 * SECOND, 100);
  assert.match(await failure(mode), /encore en cours/);
  await ok(current);
  await ok(pause);
  // The pause left while the current was in flight, then once more after it.
  assert.deepEqual(server.writes(), ['/write/Intensity=20', '/write/Paused=1', '/write/Paused=1']);
  assert.equal(station.data.Paused, 1);
});

test('a pause makes an older command that has not left yet give way', async (t) => {
  const { server, send, advance, station } = await setup(t, { config: ALLOWED });
  station.data.Paused = 1;
  station.readDelay = 1_000;
  const resume = send('resume-charge');
  await settle();
  await advance(200, 100);
  const pause = send('pause-charge');
  await settle();
  await advance(6 * SECOND, 100);
  assert.match(await failure(resume), /pause de cette borne est arrivée/);
  await ok(pause);
  // Never "already paused" over a command in flight; never sent again for one that never left.
  assert.deepEqual(server.writes(), ['/write/Paused=1']);
  assert.equal(station.data.Paused, 1);
});

test('accepted but not applied: reported once in the status', async (t) => {
  const { gladys, server, press, advance, station, logs } = await setup(t, { config: ALLOWED });
  station.applies = false;
  await ok(press('set-solar-mode', 'stop'));
  await advance(20 * SECOND);
  assert.match(message(gladys).en, /accepted the solar control mode without applying it/);
  assert.equal(logs.filter((l) => /mode accepted but not applied/.test(l)).length, 1);
  // Applied later (by the app of V2C, for instance): the note goes.
  station.data.DynamicPowerMode = 5;
  await advance(30 * SECOND);
  assert.doesNotMatch(message(gladys).en, /without applying/);
  assert.equal(server.writes().length, 1);
});

test('a 429 pauses every path, kept in /data across a restart, never shorter than the interval', async (t) => {
  const store = memoryStore();
  const { gladys, server, press, advance, station } = await setup(t, { config: ALLOWED, store });
  station.readStatus = 429;
  station.headers = { 'retry-after': '120' };
  await advance(30 * SECOND);
  assert.match(message(gladys).en, /HTTP 429/);
  assert.ok(store.data.pause.until > Date.now());
  const reads = server.reads().length;
  assert.match(await failure(press('pause-charge')), /ralentir/);
  await advance(90 * SECOND);
  assert.equal(server.reads().length, reads, 'nothing read during the pause');
  assert.equal(server.writes().length, 0);
  station.readStatus = undefined;
  await advance(MINUTE);
  assert.ok(server.reads().length > reads);
});

test('a reconnection to Gladys resends status, device, states and badge', async (t) => {
  const { gladys, server } = await setup(t);
  const devices = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  const reads = server.reads().length;
  await gladys.connect();
  await settle();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, devices + 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(server.reads().length, reads, 'no new read, no restart');
});

test('a reconnection never clears the 429 pause', async (t) => {
  const { gladys, app, advance, station } = await setup(t);
  station.readStatus = 429;
  await advance(30 * SECOND);
  const until = app.pausedUntil;
  assert.ok(until > Date.now());
  await gladys.connect();
  await settle();
  assert.equal(app.pausedUntil, until);
  assert.match(message(gladys).en, /HTTP 429/);
});

test('a created device no station gives any more: unreachable, named in the status', async (t) => {
  const { gladys, app } = await setup(t);
  await app.configUpdated({ addresses: '192.168.1.61' });
  await settle();
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /Not read any more: V2C Trydan CD34 \(ab12cd34\)/);
});

test('logs never carry the answers of the station', async (t) => {
  const logs = [];
  const server = fakeStations({
    [HOST]: { data: realTime(), writeBody: 'SECRET-ANSWER' },
  });
  const { press } = await setup(t, { config: ALLOWED, server, logs });
  await failure(press('pause-charge'));
  assert.ok(logs.every((l) => !l.includes('SECRET-ANSWER')));
});
