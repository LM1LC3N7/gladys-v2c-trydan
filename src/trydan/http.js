// -----------------------------------------------------------------------------
// One plain HTTP/1.1 GET to a station (node:http, no keep-alive, no redirect
// followed, bounded time and size). Every failure becomes a StationError
// whose kind says whether the request may have reached the station:
// 'unreachable' (nothing accepted the connection: nothing was sent) or
// 'timeout' (connected, then silent or cut: it may have been received).
//
// A host name is resolved to IPv4 unicast addresses only (unicastLookup): a
// name that resolves to a loopback, multicast or broadcast address is never
// contacted. IPv4 literals are checked by the configuration.
// -----------------------------------------------------------------------------

import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection. Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status other than 2xx (`status` holds it). */
  HTTP: 'http',
  /** 429 (`retryAfter` in ms when the station gave one). */
  RATE_LIMITED: 'rate_limited',
  /** Too large, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The time a command was given ran out before its request: nothing was sent. */
  LATE: 'late',
  /**
   * A write answered 200 without "OK" (another spelling, an empty body):
   * received, maybe applied; never announced as refused.
   */
  UNCONFIRMED: 'unexpected_answer',
});

export class StationError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'StationError';
    this.kind = kind;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

/**
 * An IPv4 unicast address a station can have: not 0/8 ("this network"),
 * 127/8 (loopback), 224/4 multicast nor 240/4 (reserved, 255.255.255.255
 * included), nor an address ending in .255 (the broadcast of a home /24).
 */
export function isUnicastIPv4(address) {
  if (isIP(address) !== 4) {
    return false;
  }
  const [a, , , d] = address.split('.').map(Number);
  return a !== 0 && a !== 127 && a < 224 && d !== 255;
}

/**
 * A `lookup` for node:http: IPv4 only, and only the unicast addresses of the
 * answer. `resolve` is dns.lookup (injected by the tests).
 */
export function unicastLookup(resolve = dnsLookup) {
  return (hostname, options, callback) => {
    resolve(hostname, { family: 4, all: true }, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      const usable = (addresses ?? []).filter((a) => isUnicastIPv4(a?.address));
      if (usable.length === 0) {
        callback(Object.assign(new Error('Not a unicast address'), { code: 'ENOTUNICAST' }));
        return;
      }
      if (options?.all) {
        callback(
          null,
          usable.map((a) => ({ address: a.address, family: 4 })),
        );
      } else {
        callback(null, usable[0].address, 4);
      }
    });
  };
}

/**
 * A host name -> one unicast IPv4 address (a promise), resolved once so the
 * read and the write of a command go to the same station. Rejects with
 * ENOTUNICAST when the name gives none.
 */
export function resolveUnicast(hostname, resolve = dnsLookup) {
  return new Promise((done, fail) => {
    unicastLookup(resolve)(hostname, {}, (err, address) => (err ? fail(err) : done(address)));
  });
}

const lookup = unicastLookup();

/**
 * @param {{ host: string, port: number, path: string, timeoutMs?: number }} options
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function request({ host, port, path, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const failure = (err) =>
      connected
        ? new StationError(ERROR_KINDS.TIMEOUT, `Connection lost: ${err.code ?? 'error'}`)
        : new StationError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${err.code ?? 'error'}`);
    const req = httpRequest(
      {
        host,
        port,
        method: 'GET',
        path,
        agent: false,
        lookup,
        headers: {
          Connection: 'close',
          Accept: 'application/json, text/plain, */*',
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) {
            req.destroy();
            finish(reject, new StationError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            headers: res.headers ?? {},
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => finish(reject, failure(err)));
      },
    );
    req.on('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', () => {
          connected = true;
        });
      } else {
        connected = true;
      }
    });
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(() => {
      req.destroy();
      finish(
        reject,
        connected
          ? new StationError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
          : new StationError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
      );
    }, timeoutMs);
    req.on('error', (err) => finish(reject, failure(err)));
    req.end();
  });
}
