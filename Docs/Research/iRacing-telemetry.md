# iRacing Telemetry Research

## 1. Overview

The iRacing SDK exposes telemetry through a Windows **memory-mapped file** (`Local\IRSDKMemMapFileName`) that the simulator writes to while running. Any process on the same machine can open and read this file, which means third-party apps, dashboards, and AI agents can consume live data without modifying the game.

There are three distinct data outputs:

**Live telemetry variables** — updated at 60 Hz (general telemetry) or 360 Hz (force feedback). These are binary-encoded values for everything that changes moment-to-moment: speed, throttle, position, lap timing, etc. The number of variables available depends on the car being driven.

**Session string (YAML)** — a semi-static blob updated occasionally (not every frame). Contains structured information about the track, session configuration, all drivers, camera groups, and radio setup. This is the "who, where, and what rules" of the session.

**IBT files** — disk-logged binary files written to `Documents/iRacing/telemetry/` at 60 Hz when disk logging is enabled (Alt-L toggles it). These contain the same live variables plus the YAML session string appended at the end. They can be parsed offline via pyirsdk or converted to MoTeC format using the Mu tool.

The SDK is officially C++ but the community has produced wrappers in Python ([pyirsdk](https://github.com/kutu/pyirsdk)), C# ([iRacingSdkWrapper](https://github.com/NickThissen/iRacingSdkWrapper), [IRSDKSharper](https://github.com/SlevinthHeaven/irsdkSharp)), Node.js ([node-irsdk](https://github.com/apihlaja/node-irsdk)), and Rust. The Python wrapper is the most accessible starting point and can read both live sessions and IBT files.

A separate **iRacing Data API** (REST) exists for fetching historical results, car/track metadata, and member statistics outside of an active session — it is not the same as the SDK and is not covered here.

---

## 2. Race-Level Details

This data lives primarily in the YAML session string under `WeekendInfo` and `SessionInfo`, plus a set of live telemetry variables for real-time session state.

### Track Information (WeekendInfo)
- `TrackName` / `TrackDisplayName` / `TrackDisplayShortName` / `TrackConfigName` — full and abbreviated track and layout names
- `TrackID` — numeric identifier
- `TrackType` — e.g. "road course", "oval", "short oval", "superspeedway", "dirt road", "dirt oval"
- `TrackLength` — length in km
- `TrackNumTurns` — number of turns
- `TrackCity` / `TrackCountry` — real-world location
- `TrackLatitude` / `TrackLongitude` / `TrackAltitude` — GPS coordinates
- `TrackNorthOffset` — heading offset for the track map
- `TrackDirection` — clockwise vs. counter-clockwise
- `TrackPitSpeedLimit` — pit lane speed limit
- `TrackDynamicTrack` — whether the track surface evolves with rubber (boolean)
- `TrackCleanup` — whether the track resets rubber at session start

### Weather Information (WeekendInfo + live variables)
Static (YAML):
- `TrackWeatherType` — one of: "Realistic", "Static", "Classic Specified / Dynamic Sky", "Classic Generated / Dynamic Sky", "Timeline", etc.
- `TrackAirTemp` / `TrackAirPressure` — ambient conditions
- `TrackSurfaceTemp` — initial track surface temperature
- `TrackWindDir` / `TrackWindVel` — wind direction and speed
- `TrackFogLevel` / `TrackPrecipitation` / `TrackRelativeHumidity` / `TrackSkies`

Live (60 Hz):
- `AirTemp` / `AirPressure` / `AirDensity` — current air conditions
- `TrackTemp` / `TrackTempCrew` — track surface temperature (driver view vs. crew view)
- `TrackWetness` — enum estimating overall track wetness level
- `WeatherDeclaredWet` — boolean set by race control when rain tires are permitted
- `WindDir` / `WindVel` / `RelativeHumidity` / `FogLevel` / `Precipitation`
- `Skies` — sky condition code
- `SolarAltitude` / `SolarAzimuth` — sun position (affects dynamic lighting and time-of-day)

### Session Configuration (WeekendInfo)
- `EventType` — Practice, Qualify, Race, Time Trial, etc.
- `Official` — whether this is an official iRacing-scored session
- `SessionID` / `SubSessionID` / `SeasonID` / `SeriesID` / `LeagueID`
- `RaceWeek` — week number within the season
- `HeatRacing` — whether heat racing format is enabled
- `TeamRacing` — whether multi-driver team swaps are enabled
- `MaxDrivers` / `MinDrivers` — team driver count limits
- `NumCarClasses` / `NumCarTypes` — multi-class configuration
- `SimMode` — consumer vs. offline/commercial simulator mode

### Session Rules (WeekendOptions)
- `Date` / `TimeOfDay` — in-game date and starting time of day
- `WeatherType` / `WeatherTemp` — weather configuration
- `Restarts` — restart type (single-file, double-file, etc.)
- `CourseCautions` — caution rules
- `StandingStart` / `StartingGrid` — rolling vs. standing start, grid formation
- `NumStarters` — number of starting positions
- `IsFixedSetup` — whether car setups are locked
- `IncidentLimit` / `FastRepairsLimit` — per-session limits
- `GreenWhiteCheckeredLimit` — overtime attempt limit
- `NumJokerLaps` — joker lap count (rallycross format)
- `StrictLapsChecking` — lap validity rules
- `NightMode` — forced night lighting
- `EarthRotationSpeedupFactor` — time acceleration for day/night cycle

### Live Session State (60 Hz telemetry)
- `SessionTime` / `SessionTimeOfDay` — elapsed session time and in-game clock
- `SessionTimeRemain` / `SessionTimeTotal` — time-based race countdown
- `SessionLapsRemain` / `SessionLapsRemainEx` / `SessionLapsTotal` — lap-count race state
- `RaceLaps` — current race lap number
- `SessionNum` — index of current session (practice=0, qualify=1, race=2, etc.)
- `SessionState` — state enum: Checkered, CoolDown, GetInCar, ParadeLaps, Racing, Warmup, Invalid
- `SessionFlags` — bitfield: green, yellow, red, white, checkered, caution, repair, disqualify, furled, black, blue, debris, crossed, yellowWaving, oneLapToGreen, greenHeld, tenToGo, fiveToGo, randomWaving, caution_waving, black_and_white, disqualify
- `PaceMode` — pace car mode enum (not pacing, single-file, double-file, etc.)
- `PitsOpen` — whether pit lane is currently open
- `SessionTick` — monotonic tick counter
- `SessionUniqueID` — unique identifier for the current session

### Session Results (SessionInfo YAML, updated at session end)
- `ResultsAverageLapTime` / `ResultsFastestLap` / `ResultsLapsComplete`
- `ResultsNumCautionFlags` / `ResultsNumCautionLaps` / `ResultsNumLeadChanges`
- `SessionTrackRubberState` — text description of rubber level (e.g. "moderate usage")

### Camera Information (CameraInfo YAML)
- `Groups` array — each group has `GroupName` and `GroupNum`
- `Cameras` array per group — each camera has `CameraName` and `CameraNum`

Live camera state (60 Hz):
- `CamCameraNumber` / `CamGroupNumber` — currently active camera
- `CamCarIdx` — which car the camera is following
- `CamCameraState` — bitfield of camera state flags (is session screen, TV style, pit lane, scenic, etc.)
- `CamSwitchNum` — used to command camera switches via broadcast API

Camera control (switching cameras programmatically) is covered in detail in `research/iRacing-camera.md`.

### Radio (RadioInfo YAML + live)
- `RadioInfo` YAML section lists available radio frequencies and channels
- `RadioTransmitCarIdx` / `RadioTransmitFrequencyIdx` / `RadioTransmitRadioIdx` — live indicators of who is currently transmitting

---

## 3. Competitor-Level Details

All per-competitor data is accessed through **CarIdx arrays** — arrays indexed by a car's position in the `DriverInfo.Drivers` array. The live 60 Hz telemetry exposes the following for every car on track:

### Position & Track State
- `CarIdxPosition` — race position (overall)
- `CarIdxClassPosition` — position within car class
- `CarIdxLapDistPct` — track position as percentage of lap distance (0.0–1.0), the primary field for computing gaps
- `CarIdxTrackSurface` — surface type the car is on (off-track, pit road, track, out-of-world)
- `CarIdxTrackSurfaceMaterial` — material type (asphalt, dirt, etc.)
- `CarIdxOnPitRoad` — boolean, currently on pit road
- `CarIdxPaceFlags` — bitfield for pace car flags (hold position, pit lane, etc.)
- `CarIdxPaceLine` / `CarIdxPaceRow` — pace lap formation position

### Lap Timing
- `CarIdxLap` — current lap number
- `CarIdxLapCompleted` — number of laps completed
- `CarIdxBestLapNum` — lap number on which best time was set
- `CarIdxBestLapTime` — best lap time this session
- `CarIdxLastLapTime` — most recently completed lap time
- `CarIdxEstTime` — estimated time to complete current lap (used for live gap calculations)
- `CarIdxF2Time` — time behind race leader (or fastest lap time in qualifying)

### Car State
- `CarIdxGear` — current gear
- `CarIdxRPM` — engine RPM
- `CarIdxSteer` — steering angle in radians
- `CarIdxClass` — car class identifier
- `CarIdxTireCompound` — current tire compound code
- `CarIdxQualTireCompound` / `CarIdxQualTireCompoundLocked` — qualifying tire compound state

### Pit & Repair
- `CarIdxFastRepairsUsed` — number of fast repairs this car has used
- `CarIdxP2P_Count` / `CarIdxP2P_Status` — push-to-pass activations remaining and current status

### Driver Identity (DriverInfo YAML — per-entry in Drivers array)
- `UserName` / `AbbrevName` / `Initials` / `UserID`
- `CarNumber` / `CarNumberRaw` / `CarID` / `CarPath` / `CarScreenName`
- `IRating` — iRating at session start
- `LicLevel` / `LicString` / `LicSubLevel` / `LicColor` — license class
- `ClubName` / `DivisionName`
- `TeamID` / `TeamName`
- `IsSpectator` / `CarIsAI` / `CarIsPaceCar`
- `CurDriverIncidentCount` / `TeamIncidentCount` — incidents accumulated
- `CarClassID` / `CarClassShortName` / `CarClassColor` / `CarClassRelSpeed` / `CarClassMaxFuelPct` / `CarClassWeightPenalty` / `CarClassLicenseLevel`

### Qualifying Results (QualifyResultsInfo YAML)
Available after qualifying sessions — position, times, and CarIdx mappings.

### Post-Session Results (SessionInfo YAML — ResultsPositions array)
- `Position` / `ClassPosition` / `CarIdx`
- `LapsComplete` / `LapsDriven` / `LapsLed`
- `FastestLap` / `FastestTime` / `LastTime` / `Time`
- `Incidents` / `JokerLapsComplete`
- `ReasonOutId` / `ReasonOutStr` — why a car left (crash, disqualify, etc.)

---

## 4. Player-Level Details

The player's own car has significantly more data than competitors, because the SDK has direct access to the simulation state for the player's vehicle.

### Car Identity & Configuration (DriverInfo YAML)
- `DriverSetupName` — name of the loaded setup file
- `DriverSetupIsModified` — whether the setup has been modified from the saved version
- `DriverSetupPassedTech` — whether the setup passes technical inspection
- `DriverSetupLoadTypeName` — setup type (e.g. "user", "default")
- `DriverCarEstLapTime` — estimated lap time for this car/track combination
- `DriverCarFuelMaxLtr` — maximum fuel tank capacity in liters
- `DriverCarFuelKgPerLtr` — fuel density
- `DriverCarMaxFuelPct` — maximum fill percentage allowed for this class
- `DriverCarRedLine` / `DriverCarIdleRPM` — engine RPM limits
- `DriverCarSLFirstRPM` / `DriverCarSLShiftRPM` / `DriverCarSLLastRPM` / `DriverCarSLBlinkRPM` — shift light RPM thresholds
- `DriverPitTrkPct` — track percentage position of player's pit stall
- `DriverHeadPosX/Y/Z` — driver head position offset for VR/head tracking

### Driver Inputs (60 Hz live)
- `Throttle` / `ThrottleRaw` — processed and raw throttle input (0.0–1.0)
- `Brake` / `BrakeRaw` — processed and raw brake input
- `BrakeABSactive` / `BrakeABSCutPct` — ABS intervention state
- `Clutch` / `ClutchRaw` — clutch pedal input
- `HandBrake` / `HandBrakeRaw` — handbrake state
- `SteeringWheelAngle` / `SteeringWheelAngleMax` — current and maximum steering angle
- `SteeringWheelTorque` / `SteeringWheelPctTorque` / `SteeringWheelPctDamper` — force feedback values
- `SteeringWheelLimiter` / `SteeringWheelPeakForceNm` — FFB limits

### Vehicle Dynamics (60 Hz live)
- `Speed` — vehicle speed (m/s)
- `RPM` — engine RPM
- `Gear` — current gear (-1 to N)
- `VelocityX` / `VelocityY` / `VelocityZ` — velocity components in world frame
- `LatAccel` / `LongAccel` / `VertAccel` — lateral, longitudinal, and vertical acceleration (m/s²)
- `Pitch` / `PitchRate` — nose up/down angle and rate
- `Roll` / `RollRate` — left/right lean and rate
- `Yaw` / `YawRate` / `YawNorth` — heading and rotation rate
- `Lat` / `Lon` / `Alt` — GPS-equivalent position on track (useful for mapping)
- `HFshockDefl` / `HFshockVel` (and `_ST` variants) — high-frequency suspension deflection and velocity for front-left and rear corners (available at higher sampling rate for suspension analysis)
- `TireLF_RumblePitch` / `TireLR_RumblePitch` / `TireRF_RumblePitch` / `TireRR_RumblePitch` — tire rumble frequency per corner

### Engine & Powertrain
- `FuelLevel` / `FuelLevelPct` — current fuel quantity and percentage
- `FuelPress` / `FuelUsePerHour` — fuel pressure and consumption rate
- `OilLevel` / `OilPress` / `OilTemp` — oil system
- `WaterLevel` / `WaterTemp` — coolant system
- `Voltage` — electrical system voltage
- `ManifoldPress` — intake manifold pressure
- `EngineWarnings` — bitfield of active warnings (water temp, fuel pressure, oil pressure, engine stall, pit speed limiter, rev limiter)
- `ShiftIndicatorPct` / `ShiftPowerPct` / `ShiftGrindRPM` — shift light and power delivery feedback

### Hybrid / ERS (car-specific, where applicable)
- `EnergyERSBattery` / `EnergyERSBatteryPct` — battery state
- `EnergyBatteryToMGU_KLap` / `EnergyMGU_KLapDeployPct` — per-lap energy deployment
- `P2P_Count` / `P2P_Status` — push-to-pass activations remaining and active
- `PushToPass` — push-to-pass button state
- `ManualBoost` / `ManualNoBoost` — manual ERS override controls

### Lap Timing (player)
- `Lap` — current lap number
- `LapCompleted` — laps completed
- `LapBestLap` / `LapBestLapTime` — best lap number and time
- `LapCurrentLapTime` / `LapLastLapTime`
- `LapBestNLapTime` / `LapBestNLapLap` — rolling N-lap average best
- `LapDist` / `LapDistPct` — distance and percentage into current lap
- `LapDeltaToBestLap` / `LapDeltaToBestLap_DD` / `LapDeltaToBestLap_OK` — delta to player's best lap (value, rate of change, validity flag)
- `LapDeltaToOptimalLap` — delta to theoretical best (mini-sector optimal)
- `LapDeltaToSessionBestLap` / `LapDeltaToSessionOptimalLap` — delta relative to session-wide bests
- `LapDeltaToSessionLastlLap` — delta to most recent session lap
- `LapLasNLapSeq` / `LapLastNLapTime` — rolling N-lap sequence tracking

### Pit & Repair (player)
- `OnPitRoad` — boolean, player is in pit lane
- `PitstopActive` — a pit stop service is in progress
- `PlayerCarInPitStall` — player car is in their assigned pit stall
- `PlayerCarPitSvStatus` — pit service status enum
- `PitRepairLeft` / `PitOptRepairLeft` — mandatory and optional repair time remaining
- `PitSvFlags` — bitfield of requested pit services (fuel, LF tire, RF tire, LR tire, RR tire, windshield, fast repair, etc.)
- `PitSvFuel` — fuel to add (liters)
- `PitSvLFP` / `PitSvRFP` / `PitSvLRP` / `PitSvRRP` — tire pressure targets per corner
- `PitSvTireCompound` — tire compound to fit

### Tire Set Management
- `PlayerTireCompound` — current tire compound
- `TireSetsAvailable` / `TireSetsUsed` — total tire set counts
- `LeftTireSetsAvailable` / `LeftTireSetsUsed` — left-side specific counts
- `RightTireSetsAvailable` / `RightTireSetsUsed` — right-side specific counts
- `RearTireSetsAvailable` / `RearTireSetsUsed` — rear-specific counts
- `PlayerCarDryTireSetLimit` — maximum dry tire sets allowed
- `FastRepairAvailable` / `FastRepairUsed` — fast repair counts
- `PlayerFastRepairsUsed` — player's fast repair consumption

### Player Race State
- `PlayerCarIdx` — the player's CarIdx (to cross-reference competitor arrays)
- `PlayerCarPosition` / `PlayerCarClassPosition` — overall and class race positions
- `PlayerCarClass` — car class identifier
- `PlayerCarTowTime` — tow time remaining after an incident
- `PlayerCarPowerAdjust` — balance-of-performance power adjustment (%)
- `PlayerCarWeightPenalty` — balance-of-performance weight penalty (kg)
- `PlayerCarDriverIncidentCount` — incidents for the current driver in this car
- `PlayerCarMyIncidentCount` — player's personal incident count
- `PlayerCarTeamIncidentCount` — team's total incident count
- `PlayerTrackSurface` / `PlayerTrackSurfaceMaterial` — what the player's car is currently on
- `CarLeftRight` — proximity indicator (clear, car left, car right, car left/right, car behind)
- `DCDriversSoFar` / `DCLapStatus` — driver change tracking in team sessions
- `DriverMarker` — driver-set in-lap marker (used in replay analysis)
- `EnterExitReset` — whether the player is in the enter/exit/reset state

### Display & System
- `DisplayUnits` — 0 = imperial, 1 = metric
- `IsInGarage` / `IsOnTrack` / `IsOnTrackCar` / `IsReplayPlaying` — session presence flags
- `IsDiskLoggingActive` / `IsDiskLoggingEnabled` — IBT file logging state

### Sector Splits (SplitTimeInfo YAML)
Split time sector definitions are available in the YAML, though individual sector times during a live lap are not directly exposed as named telemetry variables — they would need to be calculated by tracking `LapDistPct` thresholds at sector boundaries.

---

## 5. POC Findings

The `poc-ir-py-sdk` repository validated the core SDK access patterns and confirmed a number of behaviors. Key findings:

**TelemetryHandler abstraction.** The POC separates live and file telemetry behind a common interface (`TelemetryHandler`) with two concrete implementations:

- `LiveTelemetryHandler` — wraps `IRSDK()`, connects to the live memory-mapped file, supports `freeze_var_buffer_latest()`
- `FileTelemetryHandler` — wraps `IBT()`, reads `.ibt` files frame-by-frame. Supports configurable playback speed (0.25×, 1×, 2×) and a `skip_to` parameter (0.0–1.0) to seek within the file. Frame count and tick rate are read from the IBT header.

Both support `ir['VariableName']` dictionary-style access, making handler type transparent to callers.

**Variables confirmed working in the POC.**

Session-level: `SessionTime`, `SessionFlags`, `SessionNum`, `SessionState`, `RaceLaps`

Player: `Lap`, `LapCompleted`, `LapDistPct`, `IsOnTrack`, `IsOnTrackCar`, `PlayerTrackSurface`, `PlayerCarIdx`, `PlayerCarMyIncidentCount`, `PlayerCarDriverIncidentCount`, `PlayerCarTeamIncidentCount`, `PlayerIncidents`, `DCLapStatus`, `PitsOpen`, `PitRepairLeft`, `PitOptRepairLeft`, `TelemetryDiskFile`

Competitors: `CarIdx`, `CarIdxTrackSurface`

Camera: `CamCarIdx`, `CamGroupNumber`

YAML sections: `WeekendInfo`, `DriverInfo`, `CameraInfo`

**`freeze_var_buffer_latest()` is important for consistent reads.** Without it, CarIdx array reads within a single loop iteration can reflect different iRacing internal ticks, producing inconsistent results. The POC calls this at the start of each loop.

**Camera control confirmed working.** `cam_switch_num(car_number, group_id)` successfully switches the camera to follow a specific car in a specific group. Camera group IDs must be read from the `CameraInfo` YAML each session — they are not stable across tracks. See `research/iRacing-camera.md` for full details.

**Pit state tracking requires client-side state.** There is no single SDK variable for "driver is in the middle of a pit stop." The POC tracks pit phase by monitoring `CarIdxTrackSurface` transitions across three states (`aproaching_pits` → `in_pit_stall` → back to `on_track`) and maintaining local boolean flags (`driver_in_pits`, `driver_in_stall`, `driver_exit_pits`).

**HTTP server pattern.** The POC exposes telemetry over a local HTTP server (port 9000) using Python's built-in `http.server`, with a dependency-injection `ServerContext` passed to each endpoint handler. This avoids global state and makes the handler functions testable in isolation.

---

## 6. Unclear Areas Requiring Further Investigation

The following areas remain undocumented, ambiguous, or untested:

**Car setup parameters** — The YAML exposes `DriverSetupName` and whether it has been modified, but the actual setup values (spring rates, camber, toe, ride height, ARB settings, brake bias, etc.) do not appear to be exposed via the SDK telemetry at all. The setup file itself is a separate XML/JSON-like file in `Documents/iRacing/setups/`. Whether any setup values are surfaced via the session string or a separate API needs confirmation. This is a significant gap for an AI engineer application.

**Per-competitor pit stop history** — `CarIdxOnPitRoad` tells you whether a competitor is currently in pit lane, but there is no documented `CarIdxPitStopCount` or per-stop timing. Building pit stop history requires the client to monitor `CarIdxOnPitRoad` and `CarIdxTrackSurface` transitions and store them locally — consistent with the pattern the POC used for the player's own car. Whether `ResultsPositions` in the YAML provides historical pit data post-race is still unclear.

**Tire temperature and wear per corner** — No `TireTempLF`, `TireWearLF`, etc. variables appear in the documented telemetry list. Some community resources reference tire data as car-specific variables that only appear for certain cars or in certain conditions, but this is not confirmed. The MoTeC/Mu workflow does capture tire data from IBT files, which suggests the variables exist but may not be consistently available in the live stream.

**High-frequency shock data availability** — The `HFshockDefl` and `HFshockVel` variables exist in the variable list but whether they are available at standard 60 Hz or require a higher-rate sampling path needs testing. The documentation does not specify update frequency for these channels.

**CarIdx array size and AI session behavior** — The maximum concurrent car count for CarIdx arrays is not documented. In AI sessions there may be only one entry in DriverInfo while AI cars still populate CarIdx arrays; exact behavior during mid-race AI car dropout or retirement is unclear.

**Variable availability by session context** — Many variables behave differently or return invalid/zero values during replays, spectating, qualifying vs. race, and offline AI sessions. The POC confirmed the live vs. IBT distinction, but a complete matrix across all session types has not been built.

**Push-to-Pass / ERS variable car-specificity** — `P2P_Count`, `P2P_Status`, `EnergyERSBattery`, etc. only apply to cars with those systems. Whether these return zero, a sentinel value, or simply don't appear in the variable header for unsupported cars is not documented.

**Caution lap details** — `SessionFlags` carries yellow flag state and post-session counts are available, but there is no variable tracking which specific lap a caution was thrown or the reason. This matters for pit strategy reconstruction.

**Network quality variables** — `ChanAvgLatency`, `ChanLatency`, `ChanClockSkew`, `ChanQuality`, `ChanPartnerQuality` are present in the variable list but not documented. Their reliability for detecting connectivity issues in a multiplayer session is unknown.

---

## References

- [iRacing SDK Community Documentation](https://sajax.github.io/irsdkdocs/) — primary reference for variable names and YAML structure
- [WeekendInfo YAML](https://sajax.github.io/irsdkdocs/yaml/weekendinfo.html)
- [SessionInfo YAML](https://sajax.github.io/irsdkdocs/yaml/sessioninfo.html)
- [DriverInfo YAML](https://sajax.github.io/irsdkdocs/yaml/driverinfo.html)
- [CameraInfo YAML](https://sajax.github.io/irsdkdocs/yaml/camerainfo.html)
- [Telemetry Variable Index](https://sajax.github.io/irsdkdocs/telemetry/)
- [SDK Contexts Reference](https://sajax.github.io/irsdkdocs/contexts.html)
- [pyirsdk — Python SDK](https://github.com/kutu/pyirsdk)
- [iRacing SDK Forum Thread](https://forums.iracing.com/discussion/62/iracing-sdk/p1)
- [iRacing Telemetry APIs & SDKs — Byte Insight](https://byteinsight.co.uk/2023/12/iracing-telemetry-apis-sdks/)
- [poc-ir-py-sdk — POC Repository](https://github.com/tkottke90/poc-ir-py-sdk) — Python POC validating live telemetry, IBT file playback, camera control, and HTTP server pattern
