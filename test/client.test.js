// -----------------------------------------------------------------------------
// The client (pure parsing, the requests it builds), the unicast checks and
// the real HTTP transport against a loopback server (127.0.0.1 only: no
// network; the configuration refuses 127/8, the transport itself does not).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  TrydanClient,
  idOf,
  parseChargeMode,
  parseRealTime,
  retryAfterOf,
} from '../src/trydan/client.js';
import { ERROR_KINDS, isUnicastIPv4, request, unicastLookup } from '../src/trydan/http.js';
import { realTime } from './fixtures/fakeTrydan.js';

test('parseRealTime: the fields of pytrydan, exact types only', () => {
  assert.deepEqual(parseRealTime(realTime()), {
    id: 'ab12cd34',
    firmware: '2.1.7',
    chargeState: 2,
    ready: 0,
    chargePower: 2664,
    housePower: 450,
    solarPower: 1800,
    batteryPower: 0,
    voltage: 230,
    chargeEnergy: 7.6,
    chargeTime: 9979,
    chargeMode: undefined,
    slaveError: 0,
    paused: 0,
    locked: 0,
    timer: 1,
    dynamic: 0,
    pauseDynamic: 0,
    intensity: 12,
    minIntensity: 6,
    maxIntensity: 16,
    solarMode: 2,
  });
  const empty = parseRealTime({});
  for (const [key, value] of Object.entries(empty)) {
    assert.equal(value, undefined, key);
  }
  const odd = parseRealTime(
    realTime({
      ChargeState: 3,
      Paused: '1',
      Intensity: 12.5,
      MaxIntensity: '16',
      DynamicPowerMode: 9,
      ChargeTime: -1,
      ChargePower: 'x',
      ID: 'a b',
    }),
  );
  assert.equal(odd.chargeState, undefined, '3 is not a ChargeState');
  assert.equal(odd.paused, undefined);
  assert.equal(odd.intensity, undefined);
  assert.equal(odd.maxIntensity, undefined);
  assert.equal(odd.solarMode, undefined);
  assert.equal(odd.chargeTime, undefined);
  assert.equal(odd.chargePower, undefined);
  assert.equal(odd.id, undefined);
  for (const value of [null, [], 'text', 3]) {
    assert.throws(() => parseRealTime(value), { kind: ERROR_KINDS.PROTOCOL });
  }
});

test('parseRealTime reads own fields only', () => {
  const inherited = Object.create({ Paused: 1, ChargeState: 2, MaxIntensity: 32 });
  const station = parseRealTime(inherited);
  assert.equal(station.paused, undefined);
  assert.equal(station.chargeState, undefined);
  assert.equal(station.maxIntensity, undefined);
  const parsed = parseRealTime(JSON.parse('{"__proto__":{"Paused":1}}'));
  assert.equal(parsed.paused, undefined);
  assert.equal({}.Paused, undefined);
});

test('the ID and ChargeMode', () => {
  assert.equal(idOf(' AB12cd '), 'ab12cd');
  for (const value of ['', 'a-b', 'é', 'x'.repeat(33), 12, null]) {
    assert.equal(idOf(value), undefined, String(value));
  }
  assert.equal(parseChargeMode('1\r\n'), 1);
  for (const value of ['3', '', 'x', '01', undefined]) {
    assert.equal(parseChargeMode(value), undefined, String(value));
  }
});

test('Retry-After: seconds or a date', () => {
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(retryAfterOf(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(retryAfterOf('soon'), undefined);
});

test('writes: three keywords only, integers only, "OK" required, never sent late', async () => {
  const requests = [];
  let now = 1000;
  let body = 'OK\r\n';
  const client = new TrydanClient({
    transport: async (r) => {
      requests.push(r.path);
      return { status: 200, headers: {}, body };
    },
    now: () => now,
  });
  const address = { host: '10.0.0.2', port: 80 };
  const options = { startBy: 2000, timeoutMs: 500 };
  await client.write(address, 'Paused', 1, options);
  await client.write(address, 'Intensity', 16, options);
  await client.write(address, 'DynamicPowerMode', 3, options);
  assert.deepEqual(requests, [
    '/write/Paused=1',
    '/write/Intensity=16',
    '/write/DynamicPowerMode=3',
  ]);
  for (const [keyword, value] of [
    ['Locked', 1],
    ['ChargeMode', 1],
    ['MaxIntensity', 32],
    ['Intensity', '16'],
    ['Intensity', 16.5],
    ['Intensity', -1],
    ['__proto__', 1],
  ]) {
    await assert.rejects(client.write(address, keyword, value, options), /Unknown write/);
  }
  body = 'ERROR';
  await assert.rejects(client.write(address, 'Paused', 1, options), {
    kind: ERROR_KINDS.REFUSED,
  });
  now = 2001;
  await assert.rejects(client.write(address, 'Paused', 1, options), { kind: ERROR_KINDS.LATE });
  assert.equal(requests.length, 4);
});

test('unicast IPv4 only', () => {
  for (const ok of ['192.168.1.60', '10.0.0.1', '172.16.5.4', '169.254.10.20', '8.8.8.8']) {
    assert.equal(isUnicastIPv4(ok), true, ok);
  }
  for (const bad of [
    '0.0.0.0',
    '127.0.0.1',
    '224.0.0.1',
    '239.255.255.250',
    '255.255.255.255',
    '240.0.0.1',
    '192.168.1.255',
    '::1',
    'trydan.local',
  ]) {
    assert.equal(isUnicastIPv4(bad), false, bad);
  }
});

test('a host name resolving to a non-unicast address is never contacted', async () => {
  const resolver = (answers) => (_host, _options, callback) => callback(null, answers);
  const run = (answers, options = {}) =>
    new Promise((resolve) =>
      unicastLookup(resolver(answers))('trydan.lan', options, (...args) => resolve(args)),
    );
  const [err] = await run([{ address: '127.0.0.1', family: 4 }]);
  assert.equal(err.code, 'ENOTUNICAST');
  const [err2, address, family] = await run([
    { address: '224.0.0.251', family: 4 },
    { address: '192.168.1.60', family: 4 },
  ]);
  assert.equal(err2, null);
  assert.equal(address, '192.168.1.60');
  assert.equal(family, 4);
  const [, all] = await run([{ address: '192.168.1.60', family: 4 }], { all: true });
  assert.deepEqual(all, [{ address: '192.168.1.60', family: 4 }]);
});

test('the real transport against a loopback server', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/RealTimeData') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(realTime()));
    } else if (req.url === '/read/ChargeMode') {
      res.writeHead(200);
      res.end('1');
    } else if (req.url.startsWith('/write/')) {
      res.writeHead(200);
      res.end('OK');
    } else if (req.url === '/big') {
      res.writeHead(200);
      res.end('x'.repeat(20 * 1024));
    } else if (req.url === '/silent') {
      // Never answers.
    } else {
      res.writeHead(429, { 'Retry-After': '30' });
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  const host = '127.0.0.1';
  const client = new TrydanClient({ transport: request });
  const station = await client.read({ host, port }, { timeoutMs: 2000 });
  assert.equal(station.id, 'ab12cd34');
  assert.equal(await client.readChargeMode({ host, port }, { timeoutMs: 2000 }), 1);
  await client.write({ host, port }, 'Intensity', 10, {
    startBy: Date.now() + 1000,
    timeoutMs: 2000,
  });
  assert.equal(seen.at(-1), 'GET /write/Intensity=10');
  await assert.rejects(request({ host, port, path: '/big', timeoutMs: 2000 }), {
    kind: ERROR_KINDS.PROTOCOL,
  });
  await assert.rejects(request({ host, port, path: '/silent', timeoutMs: 200 }), {
    kind: ERROR_KINDS.TIMEOUT,
  });
  const limited = await request({ host, port, path: '/x', timeoutMs: 2000 });
  assert.equal(limited.status, 429);
  assert.equal(retryAfterOf(limited.headers['retry-after']), 30_000);
});

test('nothing listening: unreachable (nothing was sent)', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(request({ host: '127.0.0.1', port, path: '/', timeoutMs: 2000 }), {
    kind: ERROR_KINDS.UNREACHABLE,
  });
});
