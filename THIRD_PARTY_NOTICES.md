# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## pytrydan

<https://github.com/dgomes/pytrydan> (package `pytrydan`), by Diogo Gomes,
the library of Home Assistant's V2C integration. MIT License (`LICENSE` of
the repository, version 1.0.6, commit 9f4ea76). Its notice:

```
MIT License

Copyright (c) 2023 Diogo Gomes

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ported in `src/constants.js`, `src/trydan/client.js` and `src/devices.js`:
the local HTTP API on port 80 without authentication, the read of
`/RealTimeData` and its keywords (`ID`, `ChargeState`, `ReadyState`,
`ChargePower`, `ChargeEnergy`, `ChargeTime`, `HousePower`, `FVPower`,
`BatteryPower`, `VoltageInstallation`, `SlaveError`, `Paused`, `Locked`,
`Timer`, `Intensity`, `MinIntensity`, `MaxIntensity`, `Dynamic`,
`PauseDynamic`, `DynamicPowerMode`, `ChargeMode`, `FirmwareVersion`), the
read of one keyword by `/read/<Keyword>` for the ones a firmware leaves out,
the write `/write/<Keyword>=<value>` answered `OK`, the values of the
ChargeState, ChargeMode, DynamicPowerMode and SlaveCommunicationState
enumerations, and the current range of 6 to 32 A.

Changed: a missing or mistyped value is unknown (never a default), and a
command that needs it is refused; only `ChargeMode` is read alone, at most
once an hour; the station is read again right before each command, and the
command decided on that read only; the charging current is also bounded by
`MinIntensity` and `MaxIntensity` read then, and the current, the solar
mode and resume are held to one change a minute;
only `Paused`, `Intensity` and `DynamicPowerMode` are ever written (never
`Locked`, `ChargeMode`, `MinIntensity`, `MaxIntensity`, `Dynamic`, `Timer`,
`ContractedPower`, `VoltageInstallation` or the LEDs); reads are not retried
at once (spaced new tries) and writes never; host names resolve to unicast
IPv4 addresses only.
