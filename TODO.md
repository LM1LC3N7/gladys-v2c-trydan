# TODO — V2C Trydan v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  of lot 9 gets one recap message in /t/10385.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-19): HTTP reads of RealTimeData (and
      ChargeMode alone when missing), up to four stations, one device per
      ID (else per address), 27 features, pause/resume buttons and current
      and solar mode selects behind `allow_commands` (off), backoff, 429
      pause in /data, test button, docs en/fr, cover. Tested against made-up
      answers only.
- [x] **Milestone 1 fixes — review** (2026-10-19): a refused command never
      cancels the pause sent again (I1), a pause over a command in flight
      goes without a read (I2), the modes that take power refused like
      resume (I3), and M1-M9 (see Decisions). Scenarios S1-S7 of the
      reviewer, inverted, and one test per point in `test/review.test.js`.
- [ ] **Milestone 2 — real station**: run against a real Trydan (firmware
      1.6.x and 2.x), turn the answers (anonymized) into fixtures, check the
      points below.
- [ ] **Milestone 3 — more**: contracted power (read only, then behind the
      option), LED brightness, SignalStatus, the lock (behind the option,
      never a switch) if users ask.

## To check on a real station

- The format of `ID` (letters and digits? its length) and whether every
  firmware gives it; what `/read/ID` answers.
- Whether `ChargeMode` is in RealTimeData on recent firmware, and what
  `/read/ChargeMode` answers on old ones (a digit? a 404?).
- What `/write/…` answers on a refusal (not "OK"? an HTTP error?), and
  whether a value outside MinIntensity..MaxIntensity is refused or clamped.
- Whether `Intensity` is written to flash (wear with frequent changes: kept
  at one a minute) and whether the station overrides it in a solar mode with
  dynamic modulation on (then "accepted without applying it" shows).
- What `Paused=1` does while no vehicle is plugged in, and whether it
  survives a restart of the station or the end of a session.
- The sign of `HousePower` while exporting and of `BatteryPower`.
- Whether `ChargeEnergy` and `ChargeTime` reset at each session.
- How the station behaves with two clients (V2C app, Home Assistant, evcc)
  writing at the same time.
- The effect of each solar mode: whether "stop" (5) stops a charge in
  progress and what it does to `Paused`; what "timed" (0) and "timed-off"
  (1) really do (charge from the grid at once? follow the app profile?);
  whether a change of mode lifts `Paused` (a pause pressed, then a mode set
  from a scene: does the charge restart?).
- Whether the station handles one HTTP request at a time (ESP-IDF httpd):
  a read waiting behind a slow write (I2), the timeouts to choose.
- Whether the solar mode is kept in flash (one change a minute kept for it).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-v2c-trydan:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Reference**: pytrydan 1.0.6 (MIT, Diogo Gomes, dgomes/pytrydan, commit
  9f4ea76), the library of Home Assistant's V2C integration — license
  checked: MIT, not GPL. Cloned read only in `_ref/pytrydan`; Home
  Assistant's `components/v2c` read for the entities it offers. Ported to
  JavaScript (`src/trydan/client.js`, `src/constants.js`), no Python, no
  runtime dependency but the SDK; full MIT notice in
  `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE` (the
  standard Apache-2.0 text, no name).
- **Structure**: follows gladys-technove (local HTTP charging station, same
  transport, client, publisher, store, app layout) with the command rules of
  gladys-keba (approved): a pause never blocked, the current bounded by the
  range read back, one current a minute.
- **No authentication**: the API has none; documented ("trusted network",
  no port forwarding, separate network advised). No secret field, nothing
  secret in /data. Addresses: unicast IPv4 only — 0/8, 127/8, 224 and above
  and addresses ending in .255 refused and named in the status ("not a
  unicast address"); host names resolved by a `lookup` that keeps unicast
  IPv4 answers only (`ENOTUNICAST` otherwise, never contacted).
- **Reads**: `/RealTimeData` only. pytrydan reads every missing keyword one by
  one at each poll; here only `ChargeMode` (the one Home Assistant uses) is
  read alone, at the first read then once an hour, stopped by a 404 until a
  restart; its failure never blocks the main data (last value kept). The
  other missing keywords (LEDs, voltage) are simply not published. Reads are
  never retried at once (pytrydan's tenacity retry is not ported): spaced
  new tries 30 s, 1, 2, 5 min, never under the interval.
- **Identity kept per address** (M1): the last `ID` given at an address is
  kept in memory and in `/data` (`ids`, 16 at most, strict patterns when
  read back); a read without ID keeps that identity (no flip to the address
  id, no "not read any more"); another ID at that address is another station
  and replaces it. The fresh read of a command uses the same rule.
- **ID format** (M7): letters and digits, lower case, up to 64 characters,
  never a "-" (the address ids have one); a whole JSON number is read as its
  digits.
- **Identity**: `ID` lower case when given, else the
  address (`ip-192-168-1-60`, `host-trydan-local`, `-<port>`). The fixtures
  of pytrydan have no `ID`: such a station is keyed by its address, and
  changing the address gives a new device (docs). A station whose ID appears
  later gets a new device; the old one becomes "not read any more". The
  fresh read of a command must give the same platform id.
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): powers
  and voltage on `energy-sensor` (W, V); house and battery power signed
  (±100 kW); the session energy on
  `electrical-vehicle-charge/last-charge-energy-added` (kWh) — **a plain
  sensor, never an index** (behind the main meter: no
  `publishEnergyConsumption`, no daily consumption); the three currents on
  `electrical-vehicle-charge/target-current` (A, read only: the station gives
  no measured current); the session duration on `duration/integer`
  (seconds); connector and charging state on `charging-station` (values
  copied from the core); plugged on `electrical-vehicle-charge/plugged`;
  Paused, Locked, Timer, Dynamic, PauseDynamic, ReadyState `unknown/binary`;
  wiring, solar mode, meter link as texts. Every role always built, the
  select options fixed (6 – 32 A; six modes), so a republished device never
  loses or changes a feature.
- **States**: ChargeState 0 → AVAILABLE/IDLE, 1 → OCCUPIED/EV_CONNECTED (or
  PAUSED_BY_CHARGER when paused or locked), 2 and 6 → OCCUPIED/CHARGING, 4
  and 5 → FAULTED/IDLE, 3 or anything else → unknown (nothing published).
  Status text: fault > locked > paused > state. Offline: status "Station
  unreachable", connector UNAVAILABLE, other values kept.
- **Commands** (`allow_commands`, off by default, only `true` allows): pause
  and resume as two `button/push` (value 1 only) writing `Paused=1` /
  `Paused=0`; the charging current as a `text/select` of 6 to 32 A writing
  `Intensity`; the solar control mode as a `text/select` of frozen keys
  (`timed`, `timed-off`, `solar-min`, `solar-only`, `solar-grid`, `stop`)
  writing `DynamicPowerMode` 0 – 5. Never a switch nor a writable binary.
  Only `Paused`, `Intensity` and `DynamicPowerMode` are ever written
  (`WRITABLE`, checked by the client): never `Locked`, `ChargeMode` (phase
  wiring, an installation setting that Home Assistant does offer),
  `MinIntensity`/`MaxIntensity`, `Dynamic`, `Timer`, `ContractedPower`,
  `VoltageInstallation`, the LEDs.
- **"Mode"** of the brief read as the solar control mode
  (`DynamicPowerMode`: FV + min, FV only, FV + grid, stop, schedule), the
  setting users switch from day to day; the wiring (`ChargeMode`) is read
  only, see above.
- **Command rules** (lot 6 and wave 2/3 lessons, gladys-keba): value
  validated strictly (null, '', '10.5', 33, `__proto__` refused); the option
  checked on arrival and right before the write, with the start
  (generation), the station still read, no 429 pause and no pause of this
  station arrived since (`checkBeforeSend`); a fresh RealTimeData (1.5 s at
  most) decides, never memory; resume refused on a fault or an unknown state
  or without `Paused`; the current refused outside `MinIntensity` ..
  `MaxIntensity` read then (each 6 – 32 A, min ≤ max) or when they are
  missing; nothing sent when already so (unless a guard holds); sent within
  3.5 s of the click or refused unsent, answered by 4.3 s. Outcomes: 200
  "OK" → success (accepted); a 4xx → "refused by the station"; 200 without
  "OK" (M2), silence, a cut or a 5xx → **"sent, without confirmation"** +
  guard; nothing connected → "not sent"; deadline passed → "answered too
  slowly". Reads 5 s and 20 s after, each a new read (`freshTick`). The ack
  never waits for Gladys.
- **Review fixes** (2026-10-19):
  - I1: the pause is sent again after the command it overtook unless a newer
    command **reached the station** since (`lastAccepted`, set only when a
    write may have left); a command refused ("still running", "a pause is
    already being sent", too often…) never cancels it. `lastPause` stays set
    on arrival.
  - I2: a pause over a command in flight writes `Paused=1` without a fresh
    read (a station handling one request at a time would make the read wait
    behind the slow write and time out); the option and the station are
    still checked before the write.
  - I3: any solar mode but "stop" may take power and start a charge: refused
    like "Resume" on a fault (ChargeState 4, 5) or an unknown state; "stop"
    always allowed. Docs say a mode that takes grid power may start a charge.
  - M2: a 200 whose body is not exactly "OK" is "sent, without
    confirmation" (kind `unexpected_answer`), with guard and reads after;
    only a 4xx is "refused by the station".
  - M3: writes are numbered per kind; the "accepted without applying it"
    check of a write is skipped when a newer write of that kind left after
    it (a pause over a resume, the pause sent again).
  - M4: one change a minute per station for the current, the solar mode and
    resume (`TIMINGS.commandMinInterval`), counted from the write, restored
    when the write never connected; never for the pause.
  - M5: docs of each mode (grid or not, "timed", "Stop" is not the pause,
    the current is not a ceiling under dynamic modulation); a mode other
    than stop set while `Dynamic` is 0 is said in the status until a read
    shows `Dynamic` 1.
  - M6: a host name is resolved once per command (`resolveUnicast`, unicast
    IPv4 only): the read, the write and the pause sent again go to that one
    address; no usable address refuses the command unsent.
  - M8: docs of a station typed twice (one device by ID, read twice, commands
    through the address that answers).
  - M9: a second pause while one is being sent: "a pause is already being
    sent", not "another command is running".
- **Pause first** (gladys-keba I1): never refused for a command in flight
  (the other kinds are refused at once while one runs); it goes at once; a
  command that arrived before it and has not written yet is refused unsent
  ("a pause arrived meanwhile"); it is sent once more when the command it
  overtook settles, if that one did write and no newer command arrived.
  Never limited by the one-a-minute rule. A 429 pause (station asking to
  slow down) still holds it, as every path.
- **One change a minute per station** (gladys-keba I3, review M4,
  `TIMINGS.commandMinInterval`): the current, the solar mode and resume;
  counted from the write; a change sooner is refused unsent ("Pause
  charging stays available"); a write that never connected does not start
  the minute.
- **Accepted, not applied** (gladys-keba I4): "OK" means accepted; after the
  last read (20 s) a value still not the one asked is logged once (warning)
  and added to the status ("accepted … without applying it (solar control,
  schedule or setting of the station?)"), cleared when a read shows that
  value.
- **Guards**: after a write that may have been applied, a guard per station
  and kind (paused, intensity, mode) keeps the start and wanted values;
  while it holds (a move then the wanted value, or 90 s), a command of that
  kind is always sent. A read equal to the start value never lifts it.
- **429**: unlikely from a station, handled anyway: Retry-After bounded to
  1 min – 6 h (5 min without), never shorter than the interval, every path,
  persisted in `/data/trydan-state.json` (0600, bounded when read back),
  kept across a reconnection.
- **Hostile answers**: 16 KB at most; only own fields of a plain object,
  each with its exact type (`Paused: "1"` is unknown); enumerations matched
  exactly; texts printable and cut at 40 characters; the config takes only
  its known keys; feature ids matched by a strict pattern and a fixed role
  list. Logs carry error kinds and HTTP statuses only, never an answer.
- **Gladys**: reconnection (`connected`) republishes status, devices, states
  and badge (the core keeps them in memory), the 429 pause stays; a changed
  address list or interval restarts the stations.
- **gladys_version >= 5.1.0** (as the sibling local modules); **category
  `energy`**, transport `local`.
- **Demo files of the template** (`src/devices/*`, `scenes.js`, `widgets.js`,
  `weather.js` and their tests) deleted with `git rm`.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved. No
  Docker on this PC: the image was not built locally. The store validator
  (`npx github:GladysAssistant/integration-store .`) cannot be run from the
  agent sandbox: to run from the real terminal (`validate.ps1`).
