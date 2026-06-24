# Future Ideas

Ideas that emerged during design and brainstorming that are worth revisiting but are explicitly out of scope for v1. Data collection to support some of these begins at v1.

---

## Racing Engineer

**Community radio blackout zones**
Individual drivers configure blackout zones (sections of track where Tier 2/3 messages are suppressed) via the post-session UI. If enough drivers on the same track share their zones, a community-generated default map emerges — new drivers get a sensible baseline on their first session rather than tuning from scratch. Zones could be exported and imported as JSON for sharing. Data collection starts at v1; aggregation is a future feature.

**Cross-session learned preferences**
The engineer tracks override patterns and outcomes within a session. Extending this across sessions would allow the engineer to learn persistent driver tendencies — "this driver always extends stints 3 laps past the model" — and factor them into future recommendations. Requires a persistent driver profile store. Session-level data collection starts at v1.

**Adaptive deference score as a visible setting**
The engineer's adaptive deference behavior (shifting from recommendations to questions when the driver consistently overrides) currently happens automatically. Surfacing this as a visible, resettable metric in the UI could help drivers understand the relationship dynamic and deliberately reset it if they want more assertive guidance.
