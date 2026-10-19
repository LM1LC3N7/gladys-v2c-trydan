// -----------------------------------------------------------------------------
// Fake V2C Trydan stations behind the transport the integration is given:
// RealTimeData shaped like pytrydan's test fixtures (made up, never captured
// from a real station), /read/<Keyword> and /write/<Keyword>=<value>, which
// changes the station like it is expected to and answers "OK". Records every
// request. No network. Delays use setTimeout, so the mocked clock drives them.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, StationError } from '../../src/trydan/http.js';

export const HOST = '192.168.1.60';
export const ID = 'ab12cd34';
export const NOW = Date.UTC(2026, 9, 19, 18, 0, 0);

/** A charging station (pytrydan's RealTimeData_Charging fixture, with an ID and a voltage). */
export const realTime = (over = {}) => ({
  ID: 'AB12CD34',
  ChargeState: 2,
  ReadyState: 0,
  ChargePower: 2664.0,
  ChargeEnergy: 7.6,
  SlaveError: 0,
  ChargeTime: 9979,
  HousePower: 450.0,
  FVPower: 1800.0,
  BatteryPower: 0.0,
  Paused: 0,
  Locked: 0,
  Timer: 1,
  Intensity: 12,
  Dynamic: 0,
  MinIntensity: 6,
  MaxIntensity: 16,
  PauseDynamic: 0,
  FirmwareVersion: '2.1.7',
  DynamicPowerMode: 2,
  ContractedPower: 4600,
  VoltageInstallation: 230,
  ...over,
});

const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `stations`: host -> { data, ... }. Per station, the test may set:
 * `down` (nothing answers: 'unreachable'), `silent` (connected, no answer),
 * `readDelay` / `writeDelay` (ms), `readStatus` / `writeStatus` (HTTP),
 * `writeBody` (instead of "OK"), `applies` (false: a write changes nothing),
 * `body` (raw RealTimeData answer), `keywords` (answers of /read/<Keyword>).
 */
export function fakeStations(stations = { [HOST]: { data: realTime() } }) {
  const server = {
    stations,
    /** { host, port, path, timeoutMs } */
    requests: [],
    reads: () => server.requests.filter((r) => r.path === '/RealTimeData'),
    writes: () => server.requests.filter((r) => r.path.startsWith('/write/')).map((r) => r.path),
    async transport({ host, port, path, timeoutMs }) {
      server.requests.push({ host, port, path, timeoutMs });
      const station = server.stations[host];
      if (!station || station.down) {
        throw new StationError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      const isWrite = path.startsWith('/write/');
      if (isWrite && station.writeDown) {
        throw new StationError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      const delay = isWrite ? station.writeDelay : station.readDelay;
      if (station.silent || (isWrite && station.writeSilent) || (delay ?? 0) >= timeoutMs) {
        await wait(timeoutMs);
        throw new StationError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      if (delay) {
        await wait(delay);
      }
      if (path === '/RealTimeData') {
        if (station.readStatus) {
          return answer(station.readStatus, 'error', station.headers);
        }
        return answer(200, station.body ?? station.data);
      }
      if (path.startsWith('/read/')) {
        const keyword = path.slice('/read/'.length);
        const value = station.keywords?.[keyword];
        return value === undefined ? answer(404, 'Not found') : answer(200, String(value));
      }
      if (isWrite) {
        if (station.writeStatus) {
          return answer(station.writeStatus, 'error', station.headers);
        }
        const [keyword, value] = path.slice('/write/'.length).split('=');
        if (station.applies !== false) {
          station.data[keyword] = Number(value);
          if (keyword === 'Paused' && Number(value) === 1 && station.data.ChargeState === 2) {
            station.data.ChargeState = 1;
            station.data.ChargePower = 0;
          }
        }
        return answer(200, station.writeBody ?? 'OK');
      }
      return answer(404, 'Not found');
    },
  };
  return server;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
