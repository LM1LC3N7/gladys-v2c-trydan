// -----------------------------------------------------------------------------
// The scenarios of the review of ec8dab1 (S1-S7), inverted: they showed the
// faults, they now check the fixes; and one test per minor point (M1-M9).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TrydanApp } from '../src/app.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore, normalizeMemory } from '../src/store.js';
import { HOST, ID, NOW, fakeStations, realTime, settle } from './fixtures/fakeTrydan.js';
import { fakeNet } from './fixtures/slowTrydan.js';

const ALLOWED = { addresses: HOST, allow_commands: true };
const DEVICE = `ext:test-integration:trydan:${ID}`;

async function setup(t, { config = ALLOWED, net, store = memoryStore(), resolve } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(`${l}: ${a.join(' ')}`)]),
  );
  const app = new TrydanApp({
    gladys,
    logger,
    transport: net.transport,
    now: () => Date.now(),
    store,
    ...(resolve ? { resolve } : {}),
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = 50) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(5);
    }
  };
  for (const d of [...gladys.fake.discoveredDevices]) {
    await gladys.fake.deviceCreated(d);
    await settle();
  }
  const fire = (role, value = 1, device = DEVICE) => {
    const created = gladys.fake.devices.find((d) => d.external_id === device);
    const feature = created.features.find((f) => f.external_id === `${device}:${role}`);
    return gladys.fake.setValue(created, feature, value);
  };
  return { gladys, app, advance, logs, fire, store };
}

const pausedStation = (over = {}) =>
  realTime({ ChargeState: 1, Paused: 1, ChargePower: 0, ...over });

// S1 / I1 — a command refused while the pause waits for the one it
// overtook never cancels the second "Paused=1".
for (const [name, extra, refusal] of [
  ['a second press of Pause', ['pause-charge', 1], /déjà en cours d'envoi/],
  ['a solar mode from a scene', ['set-solar-mode', 'solar-grid'], /encore en cours/],
  ['a current', ['set-intensity', '10'], /encore en cours/],
]) {
  test(`S1: ${name}, refused, never cancels the pause sent again`, async (t) => {
    const net = fakeNet({ data: pausedStation(), delays: { '/write/Paused=0': 3000 } });
    const { advance, fire } = await setup(t, { net });
    const resume = fire('resume-charge');
    await settle();
    await advance(500);
    const pause = fire('pause-charge');
    await settle();
    await advance(500);
    const other = fire(...extra);
    await settle();
    await advance(8 * SECOND);
    assert.equal((await resume).success, true);
    assert.equal((await pause).success, true);
    const o = await other;
    assert.equal(o.success, false);
    assert.match(o.error, refusal);
    assert.deepEqual(net.writes(), ['/write/Paused=0', '/write/Paused=1', '/write/Paused=1']);
    // The resume was processed after the first pause: the second one holds.
    assert.equal(net.st.data.Paused, 1);
  });
}

test('S1 control: without the refused command, the pause is sent again and holds', async (t) => {
  const net = fakeNet({ data: pausedStation(), delays: { '/write/Paused=0': 3000 } });
  const { advance, fire } = await setup(t, { net });
  const resume = fire('resume-charge');
  await settle();
  await advance(500);
  const pause = fire('pause-charge');
  await settle();
  await advance(8 * SECOND);
  await resume;
  await pause;
  assert.deepEqual(net.writes(), ['/write/Paused=0', '/write/Paused=1', '/write/Paused=1']);
  assert.equal(net.st.data.Paused, 1);
});

// S2 / I2 — a station that handles one request at a time: the pause over a
// command in flight goes without a read (which would wait behind the slow
// write and time out).
test('S2: one-request-at-a-time station: the pause over a slow write is sent', async (t) => {
  const net = fakeNet({
    data: pausedStation(),
    delays: { '/write/Paused=0': 2500 },
    serial: true,
  });
  const { advance, fire } = await setup(t, { net });
  const resume = fire('resume-charge');
  await settle();
  await advance(500);
  const reads = net.log.filter((l) => l.path === '/RealTimeData').length;
  const pause = fire('pause-charge');
  await settle();
  await advance(8 * SECOND);
  assert.equal((await resume).success, true);
  const p = await pause;
  assert.equal(p.success, true, p.error);
  assert.deepEqual(net.writes(), ['/write/Paused=0', '/write/Paused=1', '/write/Paused=1']);
  assert.equal(net.st.data.Paused, 1, 'paused');
  const before = net.log.slice(
    0,
    net.log.findIndex((l) => l.path === '/write/Paused=1'),
  );
  assert.equal(before.filter((l) => l.path === '/RealTimeData').length, reads, 'no read first');
});

// S3 / I3 — any mode but "stop" may start a charge: the checks of Resume.
for (const state of [5, 4, 3]) {
  test(`S3: ChargeState ${state}: a mode that takes power is refused like resume`, async (t) => {
    const net = fakeNet({
      data: pausedStation({ ChargeState: state, DynamicPowerMode: 2 }),
    });
    const { advance, fire } = await setup(t, { net });
    const resume = fire('resume-charge');
    await settle();
    await advance(5 * SECOND, 100);
    assert.equal((await resume).success, false);
    for (const mode of ['solar-grid', 'solar-only', 'timed', 'timed-off']) {
      const ack = fire('set-solar-mode', mode);
      await settle();
      await advance(5 * SECOND, 100);
      const result = await ack;
      assert.equal(result.success, false, mode);
      assert.match(result.error, /rien qui puisse démarrer une charge/);
    }
    assert.deepEqual(net.writes(), []);
    // "stop" never starts a charge: sent.
    const stop = fire('set-solar-mode', 'stop');
    await settle();
    await advance(5 * SECOND, 100);
    assert.equal((await stop).success, true);
    assert.deepEqual(net.writes(), ['/write/DynamicPowerMode=5']);
  });
}

// S4 / M1 — one read without ID keeps the identity; kept in /data.
test('S4 / M1: a read without ID keeps the device, across a restart', async (t) => {
  let drop = false;
  const net = fakeNet({ data: realTime() });
  net.st.body = () => {
    if (!drop) return net.st.data;
    const { ID: _omit, ...rest } = net.st.data;
    return rest;
  };
  const store = memoryStore();
  const { gladys, app, advance } = await setup(t, { config: { addresses: HOST }, net, store });
  assert.deepEqual({ ...store.data.ids }, { [HOST]: ID });
  drop = true;
  await advance(30 * SECOND, 500);
  assert.equal(gladys.fake.discoveredDevices.at(-1).external_id, DEVICE);
  assert.equal(gladys.fake.lastState(`${DEVICE}:status`), 'En charge');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /Not read any more/);
  // A restart reading no ID at all: the ID kept in /data.
  await app.start({ addresses: HOST });
  await settle();
  assert.equal(gladys.fake.discoveredDevices.at(-1).external_id, DEVICE);
  // Another ID at this address: another station.
  drop = false;
  net.st.data.ID = 'FF00FF00';
  await advance(30 * SECOND, 500);
  assert.equal(
    gladys.fake.discoveredDevices.at(-1).external_id,
    'ext:test-integration:trydan:ff00ff00',
  );
  assert.equal(store.data.ids[HOST], 'ff00ff00');
});

test('M1: the IDs read back from /data are bounded and checked', () => {
  const memory = normalizeMemory(
    JSON.parse(
      '{"ids":{"192.168.1.60":"ab12","bad key":"x","10.0.0.1":"a-b","__proto__":"zz","10.0.0.2":5}}',
    ),
    0,
  );
  assert.deepEqual({ ...memory.ids }, { '192.168.1.60': 'ab12' });
  assert.deepEqual({ ...normalizeMemory(null, 0).ids }, {});
  assert.deepEqual({ ...normalizeMemory({ ids: [1, 2] }, 0).ids }, {});
});

// S5 / M2 — a 200 that is not exactly "OK": sent, without confirmation.
test('S5 / M2: 200 "Ok": "sent, without confirmation", guard and reads after', async (t) => {
  const net = fakeNet({ data: realTime(), writeBody: 'Ok' });
  const { advance, fire, app } = await setup(t, { net });
  const ack = fire('pause-charge');
  await settle();
  await advance(5 * SECOND, 100);
  const r = await ack;
  assert.equal(r.success, false);
  assert.match(r.error, /envoyée, sans confirmation/);
  assert.equal(app.guards.has(`${ID}:paused`) || net.st.data.Paused === 1, true);
  await advance(20 * SECOND, 500);
  const after = net.log.slice(net.log.findIndex((l) => l.path === '/write/Paused=1') + 1);
  // Reads 5 s and 20 s after the write (the polling one at 30 s not yet).
  assert.equal(after.filter((l) => l.path === '/RealTimeData').length, 2);
});

// S7 / M3 — a resume overridden by a newer pause is not "not applied".
test('S7 / M3: a resume overridden by a pause is never reported "not applied"', async (t) => {
  const net = fakeNet({ data: pausedStation(), delays: { '/write/Paused=0': 3000 } });
  const { gladys, advance, fire } = await setup(t, { net });
  const resume = fire('resume-charge');
  await settle();
  await advance(500);
  const pause = fire('pause-charge');
  await settle();
  await advance(8 * SECOND);
  await resume;
  await pause;
  assert.equal(net.st.data.Paused, 1);
  await advance(30 * SECOND, 500);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /without applying it/);
});

test('M3 control: a resume the station ignores is still reported', async (t) => {
  const net = fakeNet({ data: pausedStation(), applies: false });
  const { gladys, advance, fire } = await setup(t, { net });
  const resume = fire('resume-charge');
  await settle();
  await advance(30 * SECOND, 500);
  assert.equal((await resume).success, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /accepted the pause or resume without applying it/,
  );
});

// S6 / M4 — one change a minute for the mode and resume too, never for pause.
test('S6 / M4: the mode and resume once a minute; pause always', async (t) => {
  const net = fakeNet({ data: realTime() });
  const { advance, fire } = await setup(t, { net });
  const send = async (role, value) => {
    const ack = fire(role, value);
    await settle();
    await advance(5 * SECOND, 100);
    return ack;
  };
  assert.equal((await send('set-solar-mode', 'solar-only')).success, true);
  const again = await send('set-solar-mode', 'solar-grid');
  assert.equal(again.success, false);
  assert.match(again.error, /par minute au plus/);
  assert.equal((await send('pause-charge', 1)).success, true);
  assert.equal((await send('resume-charge', 1)).success, true);
  assert.equal((await send('pause-charge', 1)).success, true);
  const resume = await send('resume-charge', 1);
  assert.equal(resume.success, false);
  assert.match(resume.error, /par minute au plus/);
  assert.equal((await send('pause-charge', 1)).success, true, 'pause is never limited');
  await advance(MINUTE, 500);
  assert.equal((await send('set-solar-mode', 'solar-grid')).success, true);
  assert.deepEqual(net.writes(), [
    '/write/DynamicPowerMode=3',
    '/write/Paused=1',
    '/write/Paused=0',
    '/write/Paused=1',
    '/write/DynamicPowerMode=4',
  ]);
});

// M5 — a solar mode set while dynamic modulation is off: said in the status.
test('M5: a solar mode with dynamic modulation off is reported until it is on', async (t) => {
  const net = fakeNet({ data: realTime({ Dynamic: 0 }) });
  const { gladys, advance, fire } = await setup(t, { net });
  const ack = fire('set-solar-mode', 'solar-only');
  await settle();
  await advance(5 * SECOND, 100);
  assert.equal((await ack).success, true);
  assert.match(gladys.fake.connectionStatus.message.en, /dynamic modulation is off/);
  net.st.data.Dynamic = 1;
  await advance(30 * SECOND, 500);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /dynamic modulation is off/);
});

// M6 — one DNS resolution per command: the read and the write go to one address.
test('M6: a host name is resolved once per command', async (t) => {
  const station = { data: realTime() };
  const server = fakeStations({ 'trydan.lan': station, '192.168.1.60': station });
  const answers = ['192.168.1.60', '192.168.1.99'];
  const calls = [];
  const resolve = async (host) => {
    calls.push(host);
    return answers[(calls.length - 1) % 2];
  };
  const { advance, fire } = await setup(t, {
    config: { addresses: 'trydan.lan', allow_commands: true },
    net: server,
    resolve,
  });
  const ack = fire('pause-charge');
  await settle();
  await advance(5 * SECOND, 100);
  assert.equal((await ack).success, true);
  assert.deepEqual(calls, ['trydan.lan']);
  const command = server.requests.filter((r) => r.host === '192.168.1.60');
  assert.deepEqual(
    command.map((r) => r.path),
    ['/RealTimeData', '/write/Paused=1'],
  );
});

test('M6: a name that does not resolve to a unicast address refuses the command', async (t) => {
  const station = { data: realTime() };
  const server = fakeStations({ 'trydan.lan': station });
  const resolve = async () => {
    throw Object.assign(new Error('Not a unicast address'), { code: 'ENOTUNICAST' });
  };
  const { advance, fire } = await setup(t, {
    config: { addresses: 'trydan.lan', allow_commands: true },
    net: server,
    resolve,
  });
  const ack = fire('pause-charge');
  await settle();
  await advance(5 * SECOND, 100);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /non envoyée/);
  assert.deepEqual(server.writes(), []);
});
