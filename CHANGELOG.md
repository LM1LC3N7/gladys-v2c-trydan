# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- V2C Trydan stations read over their local HTTP API (no cloud, no account,
  no authentication: a trusted network is assumed and documented), up to four
  stations by IPv4 address or host name; loopback, multicast and broadcast
  addresses are refused, host names resolve to unicast IPv4 only. One device
  per station, keyed by its `ID` (by its address when the firmware gives
  none).
- Status, connector and charging state (charging-station category), vehicle
  plugged in, charging, house, solar and battery power, installation
  voltage, energy of the session (a plain sensor, never an energy index),
  duration of the session, charging current with its minimum and maximum,
  pause, lock, schedule, dynamic modulation and its pause, ready, wiring
  (phases), solar control mode and meter link (read only).
- Pause and resume buttons, a charging current list (6 to 32 A, always
  within the minimum and maximum read just before, one change a minute) and
  a solar control mode list, refused unless "Allow the commands" is on (off
  by default); each command reads the station first and is answered within
  Gladys' 5 s; "OK" accepted but not applied is reported in the status.
- Pause is never blocked: sent over a command in flight and once more after
  it; an older command not sent yet gives way to it.
- Reads every 30 s (configurable); `ChargeMode` read alone at most once an
  hour when RealTimeData lacks it; failures retried after 30 s to 5 minutes;
  a 429 pauses every path, kept in `/data`.
- Review fixes: a refused command never cancels the pause sent again; a
  pause over a command in flight is sent without waiting for a read; a solar
  mode that may take power is refused on a fault or an unknown state, like
  resume; the station keeps its device when one read misses its ID (kept in
  `/data`); a 200 other than "OK" is "sent, without confirmation"; no "not
  applied" note for a command a newer one overrode; one change a minute for
  the solar mode and resume too (never the pause); one DNS resolution per
  command; numeric IDs up to 64 characters; a solar mode set while dynamic
  modulation is off is said in the status; docs of the modes and of a
  station typed twice.
- Approval fixes: a command needs the station to give the ID of its device
  in the read just before (else refused unsent); after a swap of addresses
  the device follows its real ID; a slow DNS answer refuses the command in
  time, unsent; a pause sent again that the station ignores is reported;
  `/data` keeps the IDs of the configured addresses only.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` (pytrydan, MIT) shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-v2c-trydan/commits/main
