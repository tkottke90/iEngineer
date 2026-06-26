# iRacing Data API Research

## Overview

The iRacing Data API is a REST API introduced in January 2022 that provides access to **offline, historical iRacing data** — driver profiles, race results, series standings, iRating history, car and track metadata, league data, and more. It is accessed at:

```
https://members-ng.iracing.com/data/
```

**Important distinction:** The Data API is entirely separate from the iRacing SDK (the shared memory / `.ibt` telemetry API). The SDK provides real-time, in-sim telemetry at 60 Hz. The Data API is a request-response REST API for historical and contextual data. Both are relevant but serve different purposes.

---

## Authentication

### Current Status: OAuth Client Registration Paused

As of March 2026, iRacing has **paused the creation of new OAuth client IDs** while they evaluate existing third-party usage. New applications cannot register an OAuth client until iRacing re-opens registration. They will announce it on their forums when it resumes.

Reference: [OAuth Client Id Creation — iRacing Forums](https://forums.iracing.com/discussion/93956/oauth-client-id-creation/p1)

### Authentication Methods

#### 1. OAuth 2.1 (Preferred / Required for new apps eventually)

iRacing uses OAuth 2.1 via `oauth.iracing.com`. The flow for server-side/unattended clients uses a "Password Limited Grant" (an in-house OAuth 2.1 extension):

1. Register a client with audience `data-server` at `oauth.iracing.com` (currently paused)
2. Authenticate via `/authorize` endpoint to get a `code`
3. Exchange `code` for an access token and refresh token via `/token`
4. Use the access token as a `Bearer` token in the `Authorization` header
5. Use the refresh token to obtain new tokens when the access token expires

```
Authorization: Bearer <access_token>
GET https://members-ng.iracing.com/data/<endpoint>
```

#### 2. Username/Password (Legacy, Deprecated but Still Functional)

For accounts without 2FA, credentials can be hashed and posted to:

```
POST https://members-ng.iracing.com/auth
{ "email": "<username>", "password": "<sha256_base64_encoded_password>" }
```

The password is encoded as: `Base64(SHA256(password + username.toLowerCase()))`

This method is deprecated and **requires the iRacing account to have 2FA disabled**. It remains the most practical path while new OAuth client registration is paused.

### Rate Limiting

The API enforces rate limiting. Response headers expose:

| Header                  | Description                           |
| ----------------------- | ------------------------------------- |
| `x-ratelimit-limit`     | Total requests allowed per window     |
| `x-ratelimit-remaining` | Requests remaining in current window  |
| `x-ratelimit-reset`     | Unix timestamp when the window resets |

HTTP 429 responses indicate rate limit exhaustion. Client libraries handle this automatically by sleeping until reset.

---

## Data Available

The API is organized into the following categories. All endpoints live under `https://members-ng.iracing.com/data/`.

### Cars & Tracks

| Endpoint             | Data                                             |
| -------------------- | ------------------------------------------------ |
| `/data/car/get`      | Full car list — name, class, specs, SKU          |
| `/data/car/assets`   | Car images, tech spec images, descriptions       |
| `/data/carclass/get` | Car classes with member cars                     |
| `/data/track/get`    | Full track list — name, config, category, length |
| `/data/track/assets` | Track images, map images, descriptions           |

### Constants / Lookup

| Endpoint                      | Data                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| `/data/constants/categories`  | Racing categories (Oval, Road, Dirt Oval, Dirt Road, Sports Car, Formula) |
| `/data/constants/divisions`   | iRacing license divisions (D1–D5, Rookie, etc.)                           |
| `/data/constants/event_types` | Event types (Practice, Qualify, Time Trial, Race)                         |
| `/data/lookup/countries`      | Country names and codes                                                   |
| `/data/lookup/drivers`        | Driver search by name or cust_id                                          |
| `/data/lookup/licenses`       | License levels (Rookie to Pro/WC)                                         |
| `/data/lookup/flairs`         | Available profile flairs                                                  |

### Member / Driver Data

| Endpoint                             | Data                                                  |
| ------------------------------------ | ----------------------------------------------------- |
| `/data/member/get`                   | Member profile (name, licenses, iRating per category) |
| `/data/member/info`                  | Authenticated member's own profile                    |
| `/data/member/chart_data`            | iRating and Safety Rating history over time           |
| `/data/member/awards`                | Awards earned by a member                             |
| `/data/member/profile`               | Public profile                                        |
| `/data/member/participation_credits` | Participation credit history                          |

### Driver Statistics

| Endpoint                           | Data                                                       |
| ---------------------------------- | ---------------------------------------------------------- |
| `/data/stats/member_summary`       | Career summary — starts, wins, top-5s, poles, avg finish   |
| `/data/stats/member_career`        | Career stats broken down by category                       |
| `/data/stats/member_yearly`        | Year-by-year stats                                         |
| `/data/stats/member_recent_races`  | Most recent races with results                             |
| `/data/stats/member_bests`         | Best laps by car and track                                 |
| `/data/stats/member_recap`         | Season recap for a given year/quarter                      |
| `/data/stats/member_division`      | Division standing for a season                             |
| `/data/stats/world_records`        | World record lap times by car and track                    |
| `/data/driver_stats_by_category/*` | Full driver list with stats by category (oval, road, etc.) |

### Race Results

| Endpoint                       | Data                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `/data/results/get`            | Full subsession results — grid, finish order, laps led, incidents, iRating change, fastest lap |
| `/data/results/lap_data`       | Per-lap data for a specific driver in a subsession                                             |
| `/data/results/lap_chart_data` | All laps for all drivers in a session — the full lap chart                                     |
| `/data/results/event_log`      | Race event log — flags, incidents, off-tracks, pit stops                                       |
| `/data/results/search_series`  | Search official series results by date range, driver, car, track                               |
| `/data/results/search_hosted`  | Search hosted session results                                                                  |
| `/data/results/season_results` | Results for a specific series/season/race week                                                 |

### Series & Seasons

| Endpoint                       | Data                                |
| ------------------------------ | ----------------------------------- |
| `/data/series/get`             | All active series                   |
| `/data/series/assets`          | Series logos and images             |
| `/data/series/seasons`         | Seasons for a series, with schedule |
| `/data/series/season_list`     | All current seasons                 |
| `/data/series/season_schedule` | Race schedule for a season          |
| `/data/series/past_seasons`    | Historical seasons for a series     |
| `/data/series/stats_series`    | Series-level statistics             |

### Season Standings

| Endpoint                                      | Data                                                      |
| --------------------------------------------- | --------------------------------------------------------- |
| `/data/stats/season_driver_standings`         | Championship standings for a season                       |
| `/data/stats/season_tt_standings`             | Time trial standings                                      |
| `/data/stats/season_qualify_results`          | Qualifying results for a season/week                      |
| `/data/stats/season_tt_results`               | Time trial results                                        |
| `/data/stats/season_supersession_standings`   | Supersession standings                                    |
| `/data/stats/season_team_standings`           | Team championship standings                               |
| `/data/season/list`                           | Season list for a given year/quarter                      |
| `/data/season/race_guide`                     | Upcoming races for a season                               |
| `/data/season/spectator_subsessionids`        | **Active subsession IDs currently available to spectate** |
| `/data/season/spectator_subsessionids_detail` | Detailed info on spectatable sessions                     |

### Leagues

| Endpoint                            | Data                                      |
| ----------------------------------- | ----------------------------------------- |
| `/data/league/get`                  | League details                            |
| `/data/league/directory`            | Search all iRacing leagues                |
| `/data/league/membership`           | Leagues the authenticated user belongs to |
| `/data/league/roster`               | Members in a league                       |
| `/data/league/seasons`              | Seasons in a league                       |
| `/data/league/season_standings`     | Standings for a league season             |
| `/data/league/season_sessions`      | Sessions in a league season               |
| `/data/league/get_points_systems`   | Points systems for a league               |
| `/data/league/cust_league_sessions` | League sessions created by the user       |

### Hosted Sessions

| Endpoint                         | Data                                               |
| -------------------------------- | -------------------------------------------------- |
| `/data/hosted/sessions`          | Hosted sessions joinable as driver                 |
| `/data/hosted/combined_sessions` | All hosted sessions (driver + spectator + pending) |

### Teams

| Endpoint                | Data                                    |
| ----------------------- | --------------------------------------- |
| `/data/team/get`        | Team details                            |
| `/data/team/membership` | Teams the authenticated user belongs to |

---

## Data Format Notes

- Most endpoints return JSON directly, or a `{ "link": "<s3_url>" }` redirect to an S3-hosted JSON payload (for large datasets)
- Large result sets (lap charts, driver lists) are returned as "chunks" — multiple S3 files that must be concatenated
- Image asset paths are relative to `https://images-static.iracing.com/`
- Series logo paths are relative to `https://images-static.iracing.com/img/logos/series/`
- The API is versioned implicitly; iRacing adds/adjusts endpoints over time

---

## Available Client Libraries

| Language   | Library                                                                   | Notes                                                   |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| Python     | [iracingdataapi](https://github.com/jasondilworth56/iracingdataapi)       | Most maintained; OAuth + password auth; Pydantic models |
| .NET/C#    | [aydsko-iracingdata](https://github.com/AdrianJSClark/aydsko-iracingdata) | Full typed client                                       |
| TypeScript | [iracing-data-api](https://github.com/racedirector/iracing-data-api)      | Axios-based, includes CLI                               |
| PHP        | [iracing-php](https://github.com/mwgg/iracing-php)                        | Wrapper for PHP                                         |

---

## Relevance to an LLM

The Data API is well-suited as a **context enrichment layer** for an LLM-powered racing assistant or engineer. Specific use cases:

### Pre-Session Context

Before a race session begins, the LLM can pull:

- Driver's iRating history (`/data/member/chart_data`) to understand trajectory and current rating confidence
- Career stats (`/data/stats/member_career`, `member_summary`) to know wins, avg finish, incident tendencies
- Best laps at this specific track in this specific car (`/data/stats/member_bests`) to anchor strategy expectations
- Season standings (`/data/stats/season_driver_standings`) to understand championship context

### Car & Track Knowledge

- Full car specs via `/data/car/get` and assets — useful for building system prompts with correct car names, classes, rules
- Track metadata via `/data/track/get` — length, config name, category, pit lane specifics

### Post-Session Debrief

- Full lap chart (`/data/results/lap_chart_data`) — LLM can analyze lap-by-lap progression, stint strategy, battles
- Event log (`/data/results/event_log`) — incidents, flags, pit activity for narrative construction
- iRating change from `results/get` — emotional context for the debrief ("you gained 42 iRating despite starting 12th")

### Historical Comparisons

- World records (`/data/stats/world_records`) — give the LLM reference benchmarks
- Member bests vs. world records as a gap analysis
- Recent races (`/data/stats/member_recent_races`) — trend identification

### Limitations for LLM Use

- All data is historical/request-response — there is no streaming or webhook capability
- The API does not expose telemetry (throttle, brake, tire temps, etc.) — that requires the iRacing SDK
- Rate limits mean aggressive polling is not appropriate; data should be fetched purposefully

---

## Relevance to Live Broadcast

The Data API has meaningful but **limited** live-broadcast utility. Its primary constraint is that it is not a real-time push API — data must be polled.

### What It Can Do for Broadcast

**Finding Active Sessions (`/data/season/spectator_subsessionids`)**
This is the most critical broadcast endpoint. It returns the subsession IDs of races currently available to spectate. A broadcast tool can use this to:

- Discover which official series races are currently running
- Fetch session metadata to identify car class, track, race week
- Feed the subsession ID to the SDK for spectator telemetry overlay

**Pre-Race Driver Cards**
Before a race starts, the API can populate driver stat overlays:

- iRating, license class, career wins, recent form
- Championship position and points gap
- Best lap at this track

**Post-Qualifying Grid**
After qualifying but before the race:

- Pull qualifying results (`/data/stats/season_qualify_results`) to display grid positions with driver context

**Championship Standings Banner**
Real-time standings can be polled from `/data/stats/season_driver_standings` to display the points table during commercial breaks or pre-race.

**Lap Chart Replay**
After a session, the full lap-by-lap chart (`/data/results/lap_chart_data`) provides position changes over the race — useful for broadcast recap segments.

### What It Cannot Do for Broadcast

- **Live lap times, positions, or gaps during a race** — those require the iRacing SDK (shared memory) or a third-party live timing layer like iRacing Live Timing SDK
- **Tire wear, fuel load, weather** — SDK-only
- **Caution/flag status in real time** — SDK-only

### Broadcast Architecture Pattern

The practical broadcast pattern combines both:

```
iRacing SDK (shared memory / spectator client)
    → real-time positions, gaps, telemetry, flags

iRacing Data API (polled, ~30–60 second intervals)
    → driver context, career stats, championship standings

LLM
    → receives both streams as context
    → generates commentary, strategy analysis, engineer briefings
```

---

## Key Constraint: OAuth Registration Paused

**As of June 2026**, new OAuth client IDs cannot be registered. Any application needing Data API access must use legacy username/password authentication, which requires the iRacing account to have 2FA disabled. This is a significant practical barrier for production applications.

Workaround options:

1. Use a dedicated iRacing "service account" with 2FA disabled solely for API access
2. Monitor the [iRacing forums thread](https://forums.iracing.com/discussion/93956/oauth-client-id-creation/p1) for when OAuth registration reopens
3. Token management: once OAuth access is obtained (via an existing registered client or when registration reopens), tokens can be refreshed without re-authenticating

---

## Summary

| Dimension                   | Assessment                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| **Data richness**           | High — career stats, lap data, full results, standings, car/track metadata                     |
| **Real-time capability**    | Low — REST polling only, not streaming                                                         |
| **LLM value**               | High — excellent for context enrichment, pre/post session briefings                            |
| **Broadcast live value**    | Medium — useful for driver cards, standings, session discovery; not for live gaps or telemetry |
| **Authentication friction** | High currently — new OAuth registration is paused                                              |
| **SDK required alongside**  | Yes, for any real-time race data                                                               |

---

## References

- [iRacing Data API Forum Announcement](https://forums.iracing.com/discussion/15068/general-availability-of-data-api/)
- [iRacing OAuth Documentation](https://oauth.iracing.com/oauth2/book/introduction.html)
- [OAuth Client Registration Status](https://support.iracing.com/support/solutions/articles/31000177790-oauth-client-credentials)
- [iracingdataapi Python Client](https://github.com/jasondilworth56/iracingdataapi)
- [Aydsko .NET Client](https://github.com/AdrianJSClark/aydsko-iracingdata)
- [iRacing API Postman Collection](https://www.postman.com/rankupgamers/iracing-new-api/documentation/uc5dzd8/iracing)
