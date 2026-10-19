# gladys-v2c-trydan

[Gladys Assistant](https://gladysassistant.com) external integration for the
**V2C Trydan** EV charging station through its local HTTP API: status,
connector and charging state, charging, house, solar and battery power,
charging current and its range, energy and duration of the session, pause,
lock, schedule, dynamic modulation, wiring and solar control mode (read
only); pause, resume, the charging current and the solar control mode behind
an off-by-default option. **Unofficial API, never tested with a real
station. Not affiliated with V2C.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (TrydanApp)
                                  ├─ src/trydan/client.js  read, ChargeMode, write, parsing (own fields, exact types)
                                  ├─ src/trydan/http.js    the only network access (node:http GET, bounded, unicast lookup)
                                  ├─ src/devices.js        the device and its states (pure)
                                  ├─ src/publisher.js      states within 300/min
                                  └─ src/store.js          /data/trydan-state.json (429 pause)
```

- **No authentication**: the Trydan's local API has none. Anyone on the LAN
  can read and drive the station; the docs say so and recommend a trusted,
  separate network. Addresses: unicast IPv4 or host names resolved to
  unicast IPv4 only (loopback, multicast, broadcast refused).
- **Reads**: `GET http://<station>/RealTimeData` every 30 s (configurable,
  10 s – 10 min); `GET /read/ChargeMode` only when RealTimeData lacks it, at
  most once an hour (a 404 stops it). Failures retried after 30 s, 1, 2,
  5 min, never under the interval.
- **Device**: `ext:<selector>:trydan:<ID>` (the `ID` of RealTimeData, lower
  case), else `ip-<address>` for firmware without ID. Readings on
  `energy-sensor` (W, V), the session energy on
  `electrical-vehicle-charge/last-charge-energy-added` (kWh, a plain sensor:
  never an index, never `publishEnergyConsumption`), currents on
  `electrical-vehicle-charge/target-current`, the session duration on
  `duration` (s), the connector and the charging state on the core's
  `charging-station` category.
- **Commands** (`allow_commands`, off by default): two `button/push`
  (`Paused=1`, `Paused=0`) and two `text/select` (`Intensity` 6 – 32 A,
  `DynamicPowerMode` by frozen keys), never a switch nor a writable binary;
  only these three keywords are ever written. Each command reads the station
  first and decides on that read only, checks the option again right before
  sending, leaves within 3.5 s of the click or is refused unsent, and is
  answered by 4.3 s; a silence or a 5xx is "sent, without confirmation",
  followed by reads 5 s and 20 s later; "OK" is "accepted", checked against
  the last read. The current stays within `MinIntensity`..`MaxIntensity`
  read just before; the current, the solar mode and resume one change a
  minute; a mode other than stop refused like resume on a fault or an
  unknown state. **Pause is never blocked** (sent over a command in flight
  without a read, again after it; older unsent commands give way). The ID
  seen at an address is kept in `/data`; a host name is resolved once per
  command.
- **Hostile answers**: 16 KB at most, only own fields read with their exact
  type (no prototype pollution; a missing value refuses a command), no
  answer text in the logs.

## Credits

The local API, its keywords, enumerations and the write endpoint are ported
from [pytrydan](https://github.com/dgomes/pytrydan) (Diogo Gomes, MIT, 1.0.6).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the sibling
integrations [gladys-technove](https://github.com/LM1LC3N7/gladys-technove)
(local HTTP charging station) and
[gladys-keba](https://github.com/LM1LC3N7/gladys-keba) (command rules).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: the stations are a fake behind the injected
transport, Gladys is the SDK's fake; `test/client.test.js` runs the real
transport against a loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
