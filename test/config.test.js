import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressId, normalizeConfig, parseAddress } from '../src/config.js';
import { POLL_INTERVAL } from '../src/constants.js';

test('addresses: unicast IPv4 or host names, a pasted URL reduced, four at most', () => {
  assert.deepEqual(parseAddress(' 192.168.1.60 '), { host: '192.168.1.60', port: 80 });
  assert.deepEqual(parseAddress('http://192.168.1.60:8080/RealTimeData'), {
    host: '192.168.1.60',
    port: 8080,
  });
  assert.deepEqual(parseAddress('Trydan.local'), { host: 'trydan.local', port: 80 });
  for (const bad of ['', '300.1.1.1', '1.2.3', 'a b', 'x:0', 'x:70000', '-x', 'a_b']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  for (const refused of ['127.0.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.168.1.255']) {
    assert.deepEqual(parseAddress(refused), { refused: 'not_unicast' }, refused);
  }
  const config = normalizeConfig({
    addresses: '10.0.0.1,10.0.0.1;127.0.0.1 10.0.0.2 10.0.0.3 10.0.0.4 10.0.0.5 a_b',
  });
  assert.deepEqual(
    config.addresses.map((a) => a.host),
    ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
  );
  // Never dropped silently: "not unicast", "four at most".
  assert.deepEqual(config.invalid, [
    { text: '127.0.0.1', reason: 'not_unicast' },
    { text: '10.0.0.5', reason: 'too_many' },
    { text: 'a_b', reason: 'invalid' },
  ]);
});

test('the id of a station without ID: its address', () => {
  assert.equal(addressId({ host: '192.168.1.60', port: 80 }), 'ip-192-168-1-60');
  assert.equal(addressId({ host: '192.168.1.60', port: 8080 }), 'ip-192-168-1-60-8080');
  assert.equal(addressId({ host: 'trydan.local', port: 80 }), 'host-trydan-local');
});

test('the commands are allowed by true only', () => {
  assert.equal(normalizeConfig({}).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  for (const value of [1, '1', 'yes', 'TRUE', {}, [], null, undefined, false, 'false']) {
    assert.equal(normalizeConfig({ allow_commands: value }).allowCommands, false, String(value));
  }
});

test('interval bounded, language fr or en, unknown keys ignored', () => {
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, POLL_INTERVAL.min);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, POLL_INTERVAL.max);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, POLL_INTERVAL.default);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, POLL_INTERVAL.default);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  const polluted = normalizeConfig(JSON.parse('{"__proto__":{"allow_commands":true}}'));
  assert.equal(polluted.allowCommands, false);
  assert.equal({}.allow_commands, undefined);
});
