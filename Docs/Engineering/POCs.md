# Proof of Concepts

A running list of topics that require hands-on prototyping to validate assumptions before committing to design or architecture decisions. Each entry notes what needs to be tested and why it matters.

---

## Telemetry & Data Access

**Car setup parameter access**
The iRacing SDK exposes the setup name and modification state but not the actual setup values (spring rates, camber, ride height, etc.). Need to confirm whether setup values can be read from the XML setup files on disk (`Documents/iRacing/setups/`) and what their format looks like. This matters if the AI should reason about car balance or give setup-aware coaching.

**Tire temperature and wear data availability**
No tire temp or wear variables appear in the documented telemetry index. Need to run a live session or parse an IBT file to inspect the actual variable list returned by the SDK header, since available variables are car-dependent and the documentation may be incomplete. Tire condition is important context for pit strategy recommendations.

**Per-competitor pit stop tracking**
The SDK has no explicit pit stop count or history variable for competitors. Need to prototype a state-tracking layer that monitors `CarIdxOnPitRoad` transitions and correlates them with `CarIdxLap` to reconstruct pit stop history in real time. Validate accuracy and latency of this approach before building strategy logic on top of it.

**High-frequency shock/suspension data**
The `HFshockDefl` and `HFshockVel` variables exist but their update rate is undocumented. Need to confirm whether they are available at 60 Hz like other live variables or require a different sampling path. Relevant if the AI will ever comment on mechanical balance or suspension behavior.

**Session context variable validity**
Many SDK variables return incorrect or zero values in replay, spectator, AI, and offline test modes. Need a test matrix that checks which variables the application depends on are valid across each context type. Important for deciding which session modes the application will support at launch.

**CarIdx array sizing and car dropout behavior**
Need to confirm the maximum CarIdx array length (likely 64 but undocumented) and what happens to CarIdx entries when a car retires or disconnects mid-race. Relevant for defensive coding in the competitor tracking layer.

**IBT-based racing line data pipeline**
`Lat`/`Lon`/`Alt` are only available in `.ibt` disk files, not the live SDK stream. Need to validate the full pipeline: read an IBT file with pyirsdk's `IBT()` class, extract `Lat`, `Lon`, and `LapDistPct` at 60 Hz, project to local XY using the flat-earth conversion with `TrackLatitude`/`TrackLongitude` from the session YAML as the reference point, and segment the trace into individual laps. Also need to confirm how quickly the `.ibt` file becomes readable after a session or stint ends — if it's available within seconds of the car stopping, a near-real-time post-stint analysis flow becomes viable. The research notes that coordinate resolution and accuracy for lateral position quantification (e.g. "distance from ideal line") needs hands-on verification before building on it.

---

## AI & Language Model Integration

**Latency of LLM response in a live race context**
A driver asking a question mid-corner needs a response within a few seconds. Need to prototype the full round-trip: capture telemetry snapshot → construct prompt → call LLM → return spoken/displayed response. Validate whether acceptable latency is achievable with the target model and infrastructure.

**Prompt design for race situation summarization**
The raw telemetry is numerical and dense. Need to experiment with how to translate a telemetry snapshot (position, gap, fuel, tires, session time) into a concise natural-language context block that an LLM can reason over accurately without hallucinating race state.

**Pit strategy recommendation quality**
Core value proposition of the application. Need to validate that an LLM given lap times, fuel burn rate, tire compound data, and competitor positions can produce plausible and accurate pit window recommendations. Should test against known historical race scenarios where the correct answer is knowable.

---

## Audio / Voice Interface

**Voice input recognition accuracy under sim conditions**
Drivers may be breathing heavily, using a headset with ambient cockpit noise, and speaking in short clipped phrases. Need to test STT accuracy under these conditions with the target recognition library/service before designing the interaction model around voice.

**Push-to-talk vs. always-on activation**
Need to prototype both models and evaluate which is more natural for a driver who has limited hand availability. Push-to-talk is predictable but requires a keybind; always-on requires reliable silence detection to avoid spurious triggers.

---

## Integration & Architecture

**iRacing SDK connection lifecycle**
Need to prototype connecting to the SDK memory-mapped file, detecting when iRacing starts and stops, handling session changes (practice → qualify → race), and reconnecting gracefully after a crash or disconnect. This is foundational plumbing that affects the entire application architecture.

**Data polling vs. event-driven architecture**
The SDK is a shared memory buffer, not an event system. Need to evaluate whether a simple polling loop at 10–20 Hz is sufficient for the application's needs, or whether a more sophisticated approach (e.g. detecting variable change via the session tick counter) is warranted.

---

## Racing Engineer Behavior

**Personality knob system**
The behavior spec defines three personality dimensions (Chattiness, Familiarity, Aggression) that govern the engineer's output. Need to prototype how these translate into system prompt construction — specifically, whether a parameterized prompt template produces meaningfully different and consistent behavior across the knob range, or whether edge values produce degenerate outputs. Also validate that "Aggression" (strategy philosophy) produces measurably different pit recommendations, not just different phrasing.

**Safe window detection accuracy**
The three-signal heuristic (lateral G below threshold + throttle open + no recent brake input) needs real-session testing across a range of track types. Need to validate that the signal correctly identifies post-corner windows without false positives in sweeping high-speed sections (Eau Rouge, Maggots/Becketts) and without false negatives in low-speed technical sections (chicanes). Output: a labelled dataset of "safe" vs. "not safe" moments to tune thresholds.
