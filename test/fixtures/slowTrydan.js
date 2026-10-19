// -----------------------------------------------------------------------------
// A fake Trydan for the review scenarios: per-path delays (a write is applied
// when its delay ends, i.e. when the station processes it), an optional "one
// request at a time" station (like an ESP-IDF httpd, whose handlers run one
// after the other), and a client-side timeout after which the station still
// processes the request. Made up, never captured from a real station.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, StationError } from '../../src/trydan/http.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * st: { data, delays: { [path]: ms }, readDelay, serial, writeBody, applies,
 * ignore: [paths answered "OK" but not applied], body() }.
 */
export function fakeNet(st) {
  const net = {
    st,
    log: [],
    queue: Promise.resolve(),
    writes: () => net.log.filter((l) => l.path.startsWith('/write/')).map((l) => l.path),
    async transport({ host, port, path, timeoutMs }) {
      net.log.push({ host, port, path, at: Date.now() });
      const work = async () => {
        const delay = st.delays?.[path] ?? (path === '/RealTimeData' ? (st.readDelay ?? 0) : 0);
        if (delay) await wait(delay);
        if (path === '/RealTimeData') {
          const body = st.body ? st.body() : st.data;
          return {
            status: 200,
            headers: {},
            body: typeof body === 'string' ? body : JSON.stringify(body),
          };
        }
        if (path.startsWith('/read/')) return { status: 404, headers: {}, body: 'Not found' };
        const [keyword, value] = path.slice('/write/'.length).split('=');
        if (st.applies !== false && !st.ignore?.includes(path)) {
          st.data[keyword] = Number(value);
        }
        return { status: 200, headers: {}, body: st.writeBody ?? 'OK' };
      };
      let job;
      if (st.serial) {
        job = net.queue.then(work);
        net.queue = job.catch(() => {});
      } else {
        job = work();
      }
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new StationError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([job, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return net;
}
