# iRacing Positional Telemetry Research

## Summary

iRacing does expose car position data, but the form it takes—and whether it's available live or only post-session—matters significantly for how we design around it. The short answer: **full GPS-equivalent XY coordinates are only available in recorded IBT files (disk), not the live memory-mapped telemetry stream.** Live sessions expose only `LapDistPct`, which is the car's position as a fraction of lap distance (0.0–1.0). Tools like Garage61 that display car position on a live track map bridge the gap with a reference geometry strategy described below.

---

## Available Positional Variables

### IBT (Disk) Only — GPS Coordinates

These variables are written to `.ibt` files when disk logging is enabled (Alt-L in iRacing). They are **not** available in the live SDK memory-mapped stream.

- `Lat` — latitude of the car in degrees
- `Lon` — longitude of the car in degrees
- `Alt` — altitude of the car in meters

The values are GPS-equivalent coordinates from iRacing's internal world simulation. They are not real-world GPS — the values are realistic-looking but exist only within iRacing's coordinate system. At 60 Hz across a session, they provide a complete trace of the car's path through every corner, including lateral position relative to the track edges.

The session YAML also exposes the track's `TrackLatitude`, `TrackLongitude`, and `TrackNorthOffset` (a heading offset used to orient track maps north-up), which can serve as an anchor for transforming coordinates to a display-friendly frame.

### Live (60 Hz) — Track Progress Only

- `LapDistPct` — position as a fraction of lap distance (0.0–1.0); available for the player and all competitors via `CarIdxLapDistPct`
- `LapDist` — absolute distance in meters from the start/finish line

These tell you _where around the lap_ a car is, but not its lateral position on track (i.e., which part of the road width it's using). `LapDistPct` follows the centerline; two cars side-by-side at the same corner will read the same value.

### Live — Velocity Components (World Frame)

- `VelocityX` / `VelocityY` / `VelocityZ` — velocity in m/s in the world frame

These can be integrated over time to estimate position delta from a starting point (dead reckoning). This is unreliable for sustained tracking because integration error accumulates, but could be useful for short-window lateral movement analysis (e.g., how far left or right the car moved during a specific braking zone in the last few frames).

### No Direct World-Space XY Variables

A search of the full SDK variable list confirms: there are no `PosX`, `PosY`, `PosZ`, or equivalent world-space Cartesian coordinate variables exposed in the SDK, in either live or disk mode. The only true position data is the GPS-equivalent `Lat`/`Lon`/`Alt` trio in IBT files.

---

## How Track Map Tools Implement XY Positioning

### Live Track Maps (Garage61, iRacing Browser Apps, iOverlay, etc.)

These tools don't use Lat/Lon in real-time because it isn't available. Instead, they use a **pre-rendered geometry + LapDistPct** approach:

1. A track outline (SVG or polyline) is stored as a static asset, either manually drawn or extracted from a prior reference lap's IBT data.
2. The outline is parameterized — each point on the path corresponds to a LapDistPct value (0.0–1.0).
3. At runtime, the live `CarIdxLapDistPct` for each car is used to interpolate a pixel position along the pre-rendered path, placing the car dot on the display.

Joel Real Timing's source documentation confirms this: "The trackmap are auto-generated when you do a complete lap. The coordinates are saved in a coord file." The tool records Lat/Lon from a reference lap IBT, builds the geometry once, then uses LapDistPct for all subsequent live positioning.

**Implication:** Live track map = centerline position only. It shows roughly where around the lap a car is, but not lateral position. The car dots "follow an actual racing line" only if the pre-drawn geometry was traced from a real lap, and even then they don't reflect the current driver's lateral line choice.

### Post-Session Racing Line Analysis (Open Racer, MoTeC, Track Titan, RaceData AI, Garage61 analysis)

These tools work from IBT files and read Lat/Lon directly. This gives true XY position at every moment:

- Open Racer: "Upload your .ibt file and we'll create your 3D racing line. Valid GPS position data required." — explicitly reads Lat/Lon from IBT and projects it into a 3D visualization.
- MoTeC (via Mu conversion): Mu converts IBT files to MoTeC format, and the resulting channels include GPS coordinates which MoTeC uses to build its Circuit Map and overlay telemetry channels (throttle, brake, speed) as color overlays on the track shape.
- Track Titan / RaceData AI: Record sessions via their data agents, analyze IBT-derived data post-session, and compare the driver's racing line against a reference. "Distance to the ideal racing line" is one of their primary AI coaching metrics.

---

## Converting Lat/Lon to Usable XY Coordinates

IBT `Lat`/`Lon` values are in decimal degrees. To plot them as XY coordinates for a track map, the standard approach is to convert them to a local flat-plane coordinate system using a reference point (e.g., the track's start/finish coordinates from `TrackLatitude`/`TrackLongitude` in YAML):

```python
import math

def latlon_to_xy(lat, lon, ref_lat, ref_lon):
    """Convert lat/lon (degrees) to local XY (meters) relative to a reference point."""
    R = 6371000  # Earth radius in meters
    x = R * math.radians(lon - ref_lon) * math.cos(math.radians(ref_lat))
    y = R * math.radians(lat - ref_lat)
    return x, y
```

After conversion, the `TrackNorthOffset` from the YAML can be applied as a rotation to orient the map correctly. This gives you a flat, metric XY plane where the full lap trace is a polyline with ~3,600 points at 60 Hz for a 60-second lap.

---

## Approaches for the AI Race Engineer

### Option 1: Post-Session IBT Analysis (Best Fit for Racing Line)

Read `Lat`/`Lon`/`Alt` from IBT files after each session. This is the exact data pipeline used by every serious telemetry analysis tool in the ecosystem.

**What you get:**

- Full 60 Hz XY position trace for the entire session
- Can compare driver's line vs. a stored reference lap (e.g., their own best lap, a coach's lap)
- Can compute lateral deviation at each track position
- Can overlay throttle, brake, speed on the track map at each point

**Constraint:** No live feedback during the session. Analysis happens post-session. For a race engineer use case, this is appropriate — setup recommendations based on racing line analysis happen between sessions, not mid-race.

**Implementation path:**

- Read IBT with pyirsdk `IBT()` class
- Extract `Lat`, `Lon`, `LapDistPct`, `Throttle`, `Brake`, `Speed`, `SteeringWheelAngle` per frame
- Convert to XY using the simple flat-earth projection above
- Segment by lap using `LapDistPct` resets
- Compare against reference lap using distance-aligned interpolation

### Option 2: Live Track Position via Reference Geometry

Build a one-time per-track lookup table by recording a reference lap IBT. Map `LapDistPct` → `(x, y)` at fine resolution (~1000 points per lap). During live sessions, use the live `CarIdxLapDistPct` to look up approximate XY from the table.

**What you get:**

- Live XY position for any car at 60 Hz
- Useful for showing car position on a track map overlay

**Constraint:** This gives centerline position, not actual lateral position. If the engineer needs to know which line the driver took through a specific corner during a live session, this won't show it — only post-session IBT will.

### Option 3: Dead Reckoning from VelocityX/VelocityY (Not Recommended)

Integrate `VelocityX`/`VelocityY` over time from a known starting position. Drift accumulates rapidly (a 60-second lap at 60 Hz means 3,600 integrations before any correction). The S/F line crossing could be used to reset and correct, but mid-lap error will be significant. This is not how any production tool approaches it and is not recommended.

---

## Relevance to the Race Engineer Feature Set

From a race engineer's perspective, the most valuable positional analysis is **post-session racing line review**, not live tracking. The typical workflow in real-world racing is:

1. Driver completes a stint or qualifying session
2. Engineer reviews the racing line against a reference (best lap, teammate lap, coach lap)
3. Setup changes are discussed in the context of observed line deviations ("you're early-apexing T3, which is loading the front and causing understeer mid-corner")

This workflow maps well to iRacing's IBT-based Lat/Lon approach:

- **Setup correlation**: If the driver is carrying a specific setup problem (understeer, oversteer, inconsistent entry), it will manifest in their racing line. A loose car tends to result in late-apex, wide exits. An understeering car tends to show shallow entry, tight apex, or heavy braking at entry.
- **Coaching value**: Showing a driver their line overlaid against a reference lap — with setup-relevant data like throttle trace and steering angle colored on top — communicates setup effects in visual, intuitive terms.
- **Benchmark comparison**: Storing reference laps for each car/track combination and comparing setup variants over the same driver trace is a core race engineering workflow.

---

## Existing AI Coach Implementations

Several products already implement AI coaching using this data pipeline:

- **Track Titan** (tracktitan.io) — AI coaching for iRacing, ACC, AC, F1, Forza. Analyzes sessions post-run, compares line and inputs to a reference, provides turn-by-turn coaching prompts. Uses IBT data.
- **RaceData AI** (racedata.ai) — AI tips on braking and racing line, analysis mode comparing driver to reference. Targets iRacing, ACC, Assetto Corsa, LMU, AMS2, rFactor2.
- **Coach Dave Delta / Auto Insights** (coachdaveacademy.com) — AI breaks down Braking, Entry, Apex, Exit per corner. IBT-based.
- **Garage61** (garage61.net) — Live timing + post-session analysis. Live track map uses LapDistPct with pre-rendered geometry. Post-session analysis uses IBT Lat/Lon for racing line overlays.

None of these are specifically oriented toward **setup engineering** — they all focus on driver coaching (line, inputs, consistency). The gap our application targets is connecting the positional/racing line data back to setup parameters, which none of these tools currently address.

---

## Open Questions

- **IBT read latency**: How quickly after a session does the IBT file become available for reading? If it's available within seconds of the car stopping, a near-real-time post-session flow (analyze the last stint immediately after the car pits) becomes viable.
- **Reference lap storage strategy**: We'll need a database or file store for reference laps keyed by `TrackID` + car configuration. A driver's personal best lap per track/car combination is the most useful reference, but a community "fast lap" reference would also be valuable for coaching.
- **Lat/Lon availability in AI sessions**: Confirmed available in the IBT file variable list, but whether the values are populated correctly in offline AI sessions (where the player is the only human) needs testing.
- **Lateral position quantification**: Computing "distance from centerline" or "distance from ideal line" requires a known reference for the ideal line, which in turn requires either a pre-recorded fast lap IBT or a manually authored centerline path. Confirming the data resolution and accuracy of the Lat/Lon values for this purpose is a worthwhile POC target.

---

## References

- [iRacing SDK Telemetry Variable Index](https://sajax.github.io/irsdkdocs/telemetry/) — confirms `Lat`/`Lon`/`Alt` are Disk Only
- [Lat variable documentation](https://sajax.github.io/irsdkdocs/telemetry/lat.html) — unit: degrees, disk only
- [Lon variable documentation](https://sajax.github.io/irsdkdocs/telemetry/lon.html) — unit: degrees, disk only
- [node-irsdk GitHub Issue #63](https://github.com/apihlaja/node-irsdk/issues/63) — community discussion confirming historical unavailability of Lat/Lon in live stream, now available in IBT
- [Open Racer iRacing page](https://open-racer.com/iracing) — confirms "Valid GPS position data" from IBT for 3D racing line visualization
- [Joel Real Timing Track Map docs](https://joel-real-timing.com/trackmap_en.html) — reveals auto-generation from reference lap coordinates, LapDistPct for live positioning
- [Track Titan](https://www.tracktitan.io/) — AI coaching using IBT-based racing line data
- [RaceData AI](https://www.racedata.ai/) — AI coaching using IBT-based racing line analysis
- [Garage61 Telemetry Agent docs](https://garage61.net/docs/usage/agent) — live timing + IBT-based post-session analysis
- [ir-mapoverlay GitHub (archived)](https://github.com/MorisatoK/ir-mapoverlay) — confirms live track maps use pre-drawn geometries + LapDistPct
