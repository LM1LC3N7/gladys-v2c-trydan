// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, POLL_INTERVAL } from './constants.js';
import { isUnicastIPv4 } from './trydan/http.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  allow_commands: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of a station typed by the user: an IPv4 unicast address or a
 * host name (resolved to unicast IPv4 addresses only, src/trydan/http.js),
 * with an optional port (a pasted URL is reduced to its host and port).
 * @returns {{ host: string, port: number } | { refused: 'not_unicast' } | undefined}
 *   undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return isUnicastIPv4(host) ? { host, port } : { refused: 'not_unicast' };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/**
 * The platform id of a station that gives no `ID`: its address, as typed
 * ("ip-192-168-1-50", "host-trydan-local", "-8080" for another port).
 */
export function addressId({ host, port }) {
  const base = `${isIP(host) === 4 ? 'ip' : 'host'}-${host.replace(/\./g, '-')}`;
  return port === DEFAULT_PORT ? base : `${base}-${port}`;
}

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push({ text: entry.slice(0, 100), reason: 'invalid' });
    } else if (address.refused) {
      invalid.push({ text: entry.slice(0, 100), reason: address.refused });
    } else if (addresses.some((a) => addressKey(a) === addressKey(address))) {
      // The same address twice: read once.
    } else if (addresses.length >= LIMITS.addresses) {
      // Never dropped silently: shown with its reason, "four at most".
      invalid.push({ text: addressKey(address), reason: 'too_many' });
    } else {
      addresses.push(address);
    }
  }
  const interval = Number(c.poll_interval);
  return {
    addresses,
    invalid,
    allowCommands: strictTrue(c.allow_commands),
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
