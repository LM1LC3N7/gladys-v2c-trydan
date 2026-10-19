# V2C Trydan for Gladys

Shows your **V2C Trydan** charging station in Gladys through its **local
API**: no cloud, no account, straight on your network.

> **Unofficial API, never tested with a real station.**
> Not affiliated with V2C. It talks to the local API of the station as the
> pytrydan library (used by Home Assistant) does. V2C may change it without
> notice.

## What you get

One device per station with:

| Feature                                                                                  | Content                                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Status                                                                                   | No vehicle, plugged in, charging, paused, station locked, faults                         |
| Connector                                                                                | Available, occupied, faulted or unavailable (Gladys' "charging station" category)        |
| Charging state                                                                           | Charging, vehicle plugged in, paused (by the station), idle                              |
| Vehicle plugged in                                                                       | Yes / no                                                                                 |
| Charging power                                                                           | In W                                                                                     |
| House, solar, battery power                                                              | In W, measured by the clamp or inverter linked to the station (house negative on export) |
| Installation voltage                                                                     | In V, when the station gives it                                                          |
| Energy of the session                                                                    | In kWh, a plain sensor                                                                   |
| Duration of the session                                                                  | In seconds                                                                               |
| Charging, minimum, maximum current                                                       | In A: the current setpoint and the range set on the station                              |
| Charge paused, station locked, schedule on, dynamic modulation, modulation paused, ready | Yes / no, read only                                                                      |
| Wiring (phases)                                                                          | Single-phase, three-phase, mixed (read only)                                             |
| Solar control mode                                                                       | Schedule, no schedule, solar + minimum power, solar only, solar + grid, stop             |
| Meter link                                                                               | No error, clamp not connected, Modbus errors…                                            |
| Pause charging                                                                           | Button (commands allowed only)                                                           |
| Resume charging                                                                          | Button (commands allowed only)                                                           |
| Set the charging current                                                                 | List of 6 to 32 A (commands allowed only)                                                |
| Set the solar control mode                                                               | List of the six modes (commands allowed only)                                            |

Read every 30 seconds by default (10 s to 10 min, configurable).

**Energy**: the energy of the session is a **plain sensor**, never an index:
it does not enter Gladys' Energy tab (the station is already counted by your
main meter). No daily consumption is published.

## Installation

1. Give the station a **fixed IP address** in your router.
2. Install the integration from the Gladys store.
3. In its configuration, enter the **IP address of the station** (or its
   host name; several stations: separated by commas, four at most).
   Loopback (127.x), multicast and broadcast (ending in .255) addresses are
   refused, and a host name is only followed when it points to an IPv4
   device address.
4. Save, then add the station from the **Discovery** tab.

The device takes the **identifier** (`ID`) the station gives. Some firmware
versions give none: the device then takes the address typed, and changing
that address creates a new device.

The **Test the connection** button reads each station once (at most every
10 seconds).

## Security: an API without a password

The local API of the Trydan has **no authentication at all**: any machine
on your network can read the station and drive it (pause, current, mode),
Gladys included. This module assumes a **trusted network**: never make the
station reachable from the Internet (no port forwarding), and preferably put
it on a separate network for connected devices. This module asks for and
keeps no secret.

## Commands (off by default)

"Pause charging", "Resume charging", "Set the charging current" and "Set the
solar control mode" refuse every command while the **Allow the commands**
option is off. On:

- **Pause** suspends the charge (`Paused=1`); it is **never blocked**: not by
  a command in flight (it leaves at once, and once more when that command
  ends), not by the current limit. An older command that has not left yet
  gives way to it;
- **Resume** restarts the charge (`Paused=0`); refused when the station
  reports a fault or an unknown state;
- **Charging current**: whole amperes, 6 to 32 A, and **always within the
  range set on the station** (minimum and maximum current read just before);
  refused when the station does not give that range. **One change a minute
  at most**: not meant for fine regulation;
- **Solar control**: the dynamic power mode of the station (schedule,
  solar + minimum, solar only, solar + grid, stop…). It only acts when
  **dynamic modulation** is on in the station (in the V2C app).

Neither the lock, the wiring (phases), the current range, the schedule nor
the contracted power can be changed from Gladys.

They are **buttons** and **lists**, never switches: a "turn everything off"
(from Gladys, Google Home, Alexa or HomeKit) does not touch them. A scene
can trigger them, but only through an explicit action, and only when the
commands are allowed. Beware: Gladys' AI chat (MCP) can create and run such
a scene: while the commands are allowed, it can resume the charge or change
the current.

Before each command, the integration **reads the station again** and
decides on that read only; the option is checked again right before
sending. A useless command (already so) is not sent. A command that cannot
leave within 3.5 seconds is refused unsent. When the station does not
confirm (silence, a 5xx error), Gladys shows "Command sent, without
confirmation": check the state, read again 5 then 20 seconds later. The
station answers "OK" when it **accepts** a setting; when the read after
shows it did not apply it (solar control, schedule…), the configuration
screen says so. One command at a time per station, the pause aside.

## Errors and limits

- **Station unreachable**: only the connector ("unavailable") and the status
  ("Station unreachable") change; the other values keep their last value. A
  station removed from the configuration, or that never answered since the
  start, shows the same, and the configuration screen names it. New tries
  after 30 s, 1, 2 then 5 minutes, never faster than the interval.
- **429 (too many requests)**, unlikely from a local station: a pause of
  1 minute to 6 hours for everything (reads, button, commands), never
  shorter than the refresh interval, kept in `/data` across a restart.
- The **wiring** (`ChargeMode`) is missing from the main read of some
  firmware versions: it is then read alone, at most once an hour.
- The station gives no measured current: "Charging current" is the setpoint.
- The logs never contain the text of the answers of the station.

## Credits

Ported from [pytrydan](https://github.com/dgomes/pytrydan) (Diogo Gomes,
MIT, version 1.0.6). Apache-2.0 license.
