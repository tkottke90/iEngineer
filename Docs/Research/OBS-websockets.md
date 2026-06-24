# OBS WebSocket Protocol Reference

**Source:** obsproject/obs-websocket — official protocol.md (v5.x.x)  
**Protocol Version:** RPC v1  
**Default Port:** 4455  
**Default Subprotocol:** `obswebsocket.json`

---

## Overview

OBS Studio ships with a built-in WebSocket server (obs-websocket 5.x) that exposes a rich RPC interface for remote control. It supports:

- Full stream and recording lifecycle control (start, stop, pause, split)
- Scene switching and scene item manipulation
- Output status monitoring with real-time events
- Studio mode control (preview/program)
- Replay buffer and virtual camera control
- Batch requests for atomic multi-step operations
- A pub/sub event system with fine-grained subscriptions

Two encoding options are available: JSON over text frames (`obswebsocket.json`) or MsgPack over binary frames (`obswebsocket.msgpack`), specified via the `Sec-WebSocket-Protocol` HTTP header at connection time.

---

## Connection & Handshake

### Steps

1. Client opens a WebSocket connection to `ws://localhost:4455`
2. Server immediately sends **OpCode 0 `Hello`** with version info and optional authentication challenge
3. Client responds with **OpCode 1 `Identify`**, including auth string (if required) and event subscription bitmask
4. Server responds with **OpCode 2 `Identified`** confirming the negotiated RPC version
5. Client can now send requests and receive events

After identification, a client may send **OpCode 3 `Reidentify`** to update its event subscriptions without reconnecting.

### Base Message Format

All messages follow this structure:

```json
{
  "op": <OpCode number>,
  "d": { ...data fields }
}
```

### OpCodes

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| 0 | Hello | Server → Client | Initial connection info + auth challenge |
| 1 | Identify | Client → Server | Authentication + session parameters |
| 2 | Identified | Server → Client | Confirms successful identification |
| 3 | Reidentify | Client → Server | Update session parameters (e.g. subscriptions) |
| 5 | Event | Server → Client | An OBS event occurred |
| 6 | Request | Client → Server | Make a request |
| 7 | RequestResponse | Server → Client | Response to a request |
| 8 | RequestBatch | Client → Server | Batch of requests, processed serially |
| 9 | RequestBatchResponse | Server → Client | Response to a batch |

### Authentication

If the `Hello` message contains an `authentication` field, auth is required:

```json
{
  "op": 0,
  "d": {
    "obsStudioVersion": "30.2.2",
    "obsWebSocketVersion": "5.5.2",
    "rpcVersion": 1,
    "authentication": {
      "challenge": "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=",
      "salt": "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI="
    }
  }
}
```

To generate the `authentication` string:

1. Concatenate `password + salt`
2. SHA256 hash → base64 encode → `base64_secret`
3. Concatenate `base64_secret + challenge`
4. SHA256 hash → base64 encode → final `authentication` string

### Identify Example

```json
{
  "op": 1,
  "d": {
    "rpcVersion": 1,
    "authentication": "Dj6cLS+jrNA0HpCArRg0Z/Fc+YHdt2FQfAvgD1mip6Y=",
    "eventSubscriptions": 33
  }
}
```

---

## Event Subscriptions

The `eventSubscriptions` field in `Identify` is a bitmask. By default all standard categories are subscribed (`All`). High-volume events must be explicitly opted into.

| Category | Bitmask Value |
|----------|--------------|
| None | `0` |
| General | `1 << 0` = 1 |
| Config | `1 << 1` = 2 |
| Scenes | `1 << 2` = 4 |
| Inputs | `1 << 3` = 8 |
| Transitions | `1 << 4` = 16 |
| Filters | `1 << 5` = 32 |
| Outputs | `1 << 6` = 64 |
| SceneItems | `1 << 7` = 128 |
| MediaInputs | `1 << 8` = 256 |
| Vendors | `1 << 9` = 512 |
| Ui | `1 << 10` = 1024 |
| Canvases | `1 << 11` = 2048 |
| **All** | OR of all above |
| InputVolumeMeters *(high-volume)* | `1 << 16` |
| InputActiveStateChanged *(high-volume)* | `1 << 17` |
| InputShowStateChanged *(high-volume)* | `1 << 18` |
| SceneItemTransformChanged *(high-volume)* | `1 << 19` |

To receive only Output and Scene events (relevant for iRacing engineer): subscribe with `64 | 4 = 68`.

---

## Making Requests

```json
{
  "op": 6,
  "d": {
    "requestType": "StartStream",
    "requestId": "unique-id-123"
  }
}
```

Response:

```json
{
  "op": 7,
  "d": {
    "requestType": "StartStream",
    "requestId": "unique-id-123",
    "requestStatus": {
      "result": true,
      "code": 100
    }
  }
}
```

`requestId` is a client-generated string for correlating responses. Any unique string works (UUID recommended).

### Output State Values (`ObsOutputState`)

These appear in stream/record/replay buffer state events and status responses:

| Value | Meaning |
|-------|---------|
| `OBS_WEBSOCKET_OUTPUT_UNKNOWN` | Unknown state |
| `OBS_WEBSOCKET_OUTPUT_STARTING` | Output is starting |
| `OBS_WEBSOCKET_OUTPUT_STARTED` | Output has started |
| `OBS_WEBSOCKET_OUTPUT_STOPPING` | Output is stopping |
| `OBS_WEBSOCKET_OUTPUT_STOPPED` | Output has stopped |
| `OBS_WEBSOCKET_OUTPUT_RECONNECTING` | Disconnected, reconnecting |
| `OBS_WEBSOCKET_OUTPUT_RECONNECTED` | Reconnected successfully |
| `OBS_WEBSOCKET_OUTPUT_PAUSED` | Output is paused (record only) |
| `OBS_WEBSOCKET_OUTPUT_RESUMED` | Output has been resumed |

---

## Stream Requests

### `GetStreamStatus`

Gets the current status of the stream output.

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| outputActive | Boolean | Whether the stream is active |
| outputReconnecting | Boolean | Whether the stream is reconnecting |
| outputTimecode | String | Current stream timecode (`HH:MM:SS.mmm`) |
| outputDuration | Number | Duration of the stream in milliseconds |
| outputCongestion | Number | Congestion of the stream (0–1) |
| outputBytes | Number | Total bytes sent |
| outputSkippedFrames | Number | Number of frames skipped |
| outputTotalFrames | Number | Total frames transmitted |

### `ToggleStream`

Toggles the stream output on or off.

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| outputActive | Boolean | New active state of the stream |

### `StartStream`

Starts the stream output. No request or response fields.

### `StopStream`

Stops the stream output. No request or response fields.

### `SendStreamCaption`

Sends CEA-608 caption text over the stream output.

**Request Fields:**

| Field | Type | Description |
|-------|------|-------------|
| captionText | String | Caption text to send |

---

## Record Requests

### `GetRecordStatus`

Gets the current status of the record output.

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| outputActive | Boolean | Whether recording is active |
| outputPaused | Boolean | Whether recording is paused |
| outputTimecode | String | Current recording timecode (`HH:MM:SS.mmm`) |
| outputDuration | Number | Duration of the recording in milliseconds |
| outputBytes | Number | Total bytes written |

### `ToggleRecord`

Toggles recording on or off. No fields.

### `StartRecord`

Starts the record output. No fields.

### `StopRecord`

Stops the record output.

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| outputPath | String | File path of the saved recording |

### `ToggleRecordPause`

Toggles pause state of the record output. No fields.

### `PauseRecord`

Pauses the record output. No fields.

### `ResumeRecord`

Resumes the record output. No fields.

### `SplitRecordFile` *(added v5.5.0)*

Splits the current recording file into a new file. No fields.

### `CreateRecordChapter` *(added v5.5.0)*

Adds a chapter marker to the current recording.

**Request Fields:**

| Field | Type | Description |
|-------|------|-------------|
| ?chapterName | String | Name of the chapter marker (optional) |

---

## Scene Requests

### `GetSceneList`

Gets all scenes in OBS.

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| currentProgramSceneName | String | Active program scene name |
| currentProgramSceneUuid | String | Active program scene UUID |
| currentPreviewSceneName | String | Preview scene name (studio mode only) |
| currentPreviewSceneUuid | String | Preview scene UUID (studio mode only) |
| scenes | Array\<Object\> | Array of all scenes |

### `GetCurrentProgramScene`

**Response:** `sceneName`, `sceneUuid`

### `SetCurrentProgramScene`

Switches the active (program) scene.

**Request Fields:**

| Field | Type | Description |
|-------|------|-------------|
| ?sceneName | String | Scene name to switch to |
| ?sceneUuid | String | Scene UUID to switch to |

### `GetCurrentPreviewScene` / `SetCurrentPreviewScene`

Gets or sets the preview scene in Studio Mode. Requires Studio Mode to be enabled.

### Other Scene Requests

`CreateScene`, `RemoveScene`, `SetSceneName`, `GetSceneSceneTransitionOverride`, `SetSceneSceneTransitionOverride`

---

## Scene Item Requests

Useful for showing/hiding camera overlays or info panels during a race.

| Request | Description |
|---------|-------------|
| `GetSceneItemList` | Get all items in a scene |
| `GetSceneItemId` | Find an item's numeric ID by source name |
| `CreateSceneItem` | Add a source to a scene |
| `RemoveSceneItem` | Remove an item from a scene |
| `GetSceneItemEnabled` | Check if an item is visible |
| `SetSceneItemEnabled` | Show or hide a scene item |
| `GetSceneItemTransform` | Get position/size/crop info |
| `SetSceneItemTransform` | Set position/size/crop info |
| `GetSceneItemLocked` / `SetSceneItemLocked` | Lock/unlock item |
| `GetSceneItemIndex` / `SetSceneItemIndex` | Reorder items in scene |
| `GetSceneItemBlendMode` / `SetSceneItemBlendMode` | Set blend mode |
| `DuplicateSceneItem` | Duplicate an item |

**Key use case:** `SetSceneItemEnabled` with `sceneItemId` can toggle a camera, overlay, or telemetry panel on/off without switching the entire scene.

---

## Output Requests (Virtual Cam, Replay Buffer)

| Request | Description |
|---------|-------------|
| `GetVirtualCamStatus` | Get virtualcam state |
| `ToggleVirtualCam` / `StartVirtualCam` / `StopVirtualCam` | Control virtual camera |
| `GetReplayBufferStatus` | Get replay buffer state |
| `ToggleReplayBuffer` / `StartReplayBuffer` / `StopReplayBuffer` | Control replay buffer |
| `SaveReplayBuffer` | Trigger a replay save |
| `GetLastReplayBufferReplay` | Get path of last saved replay |
| `GetOutputList` | List all outputs |
| `GetOutputStatus` / `ToggleOutput` / `StartOutput` / `StopOutput` | Generic output control |
| `GetOutputSettings` / `SetOutputSettings` | Read/write output config |

---

## UI / Studio Mode Requests

| Request | Description |
|---------|-------------|
| `GetStudioModeEnabled` | Returns `studioModeEnabled` (bool) |
| `SetStudioModeEnabled` | Enable or disable Studio Mode |
| `OpenInputPropertiesDialog` | Opens source properties in OBS UI |
| `OpenVideoMixProjector` | Opens a video projector window |

---

## Events Reference

Events are received as OpCode 5 messages. Subscribe to the relevant category bitmask to receive them.

### Outputs Category Events

#### `StreamStateChanged`

Fires whenever the stream output state changes.

| Field | Type | Description |
|-------|------|-------------|
| outputActive | Boolean | Whether the stream is now active |
| outputState | String | New state (see `ObsOutputState`) |

#### `RecordStateChanged`

| Field | Type | Description |
|-------|------|-------------|
| outputActive | Boolean | Whether recording is active |
| outputState | String | New state |
| outputPath | String | File path if recording stopped, `null` otherwise |

#### `RecordFileChanged` *(v5.5.0)*

Fires when recording splits to a new file.

| Field | Type | Description |
|-------|------|-------------|
| newOutputPath | String | New file path being written |

#### `ReplayBufferStateChanged`

| Field | Type | Description |
|-------|------|-------------|
| outputActive | Boolean | Whether replay buffer is active |
| outputState | String | New state |

#### `ReplayBufferSaved`

| Field | Type | Description |
|-------|------|-------------|
| savedReplayPath | String | Path of the saved replay file |

#### `VirtualcamStateChanged`

| Field | Type | Description |
|-------|------|-------------|
| outputActive | Boolean | Whether virtualcam is active |
| outputState | String | New state |

### Scenes Category Events

| Event | Key Fields | Description |
|-------|-----------|-------------|
| `CurrentProgramSceneChanged` | `sceneName`, `sceneUuid` | Program scene switched |
| `CurrentPreviewSceneChanged` | `sceneName`, `sceneUuid` | Preview scene switched |
| `SceneCreated` | `sceneName`, `sceneUuid`, `isGroup` | New scene created |
| `SceneRemoved` | `sceneName`, `sceneUuid` | Scene deleted |
| `SceneNameChanged` | `oldSceneName`, `sceneName`, `sceneUuid` | Scene renamed |
| `SceneListChanged` | `scenes` | Scene list updated |

### Scene Items Category Events

| Event | Key Fields | Description |
|-------|-----------|-------------|
| `SceneItemCreated` | `sceneName`, `sourceName`, `sceneItemId` | Item added to scene |
| `SceneItemRemoved` | `sceneName`, `sourceName`, `sceneItemId` | Item removed |
| `SceneItemEnableStateChanged` | `sceneItemId`, `sceneItemEnabled` | Item visibility toggled |
| `SceneItemLockStateChanged` | `sceneItemId`, `sceneItemLocked` | Item lock toggled |
| `SceneItemTransformChanged` | `sceneItemId`, `sceneItemTransform` | Position/size changed *(high-volume)* |

### UI Category Events

| Event | Key Fields | Description |
|-------|-----------|-------------|
| `StudioModeStateChanged` | `studioModeEnabled` | Studio mode toggled |
| `ScreenshotSaved` | `savedScreenshotPath` | Screenshot saved via OBS hotkey |

### General Category Events

| Event | Description |
|-------|-------------|
| `ExitStarted` | OBS is shutting down |
| `VendorEvent` | Event from a third-party plugin vendor |
| `CustomEvent` | Custom event from `BroadcastCustomEvent` |

---

## Batch Requests

Multiple requests can be sent as a single atomic batch:

```json
{
  "op": 8,
  "d": {
    "requestId": "batch-001",
    "haltOnFailure": false,
    "executionType": 0,
    "requests": [
      { "requestType": "SetCurrentProgramScene", "requestData": { "sceneName": "Race Cam" } },
      { "requestType": "StartStream" }
    ]
  }
}
```

`executionType` values: `0` = SerialRealtime (default), `1` = SerialFrame, `2` = Parallel.

The `Sleep` request (only in serial batch) can add delays between steps: `{ "requestType": "Sleep", "requestData": { "sleepMillis": 500 } }`.

---

## General Utility Requests

### `GetVersion`

Returns OBS and obs-websocket version info, the list of all available request types, and supported image formats.

### `GetStats`

Returns live performance metrics:

| Field | Description |
|-------|-------------|
| cpuUsage | CPU % |
| memoryUsage | Memory in MB |
| availableDiskSpace | Disk space for recordings |
| activeFps | Current rendered FPS |
| averageFrameRenderTime | Avg ms per frame |
| renderSkippedFrames | Render thread skips |
| outputSkippedFrames | Output thread skips |

### `BroadcastCustomEvent`

Sends a custom payload to all connected WebSocket clients — useful for inter-process signaling between the iRacing engineer backend and any other connected OBS clients.

```json
{
  "op": 6,
  "d": {
    "requestType": "BroadcastCustomEvent",
    "requestId": "evt-001",
    "requestData": {
      "eventData": { "type": "lap_complete", "lapTime": 85.4 }
    }
  }
}
```

---

## Relevance to iRacing Engineer

| Capability | OBS WebSocket API |
|------------|------------------|
| Start/stop stream on session start/end | `StartStream` / `StopStream` |
| Monitor stream health | `GetStreamStatus`, `StreamStateChanged` events |
| Switch camera scenes on track position | `SetCurrentProgramScene` |
| Toggle overlays (telemetry, standings) | `SetSceneItemEnabled` |
| Auto-record race sessions | `StartRecord` / `StopRecord` |
| Chapter markers at lap changes | `CreateRecordChapter` |
| Split recording files at stint boundaries | `SplitRecordFile` |
| Pause/resume recording during caution laps | `PauseRecord` / `ResumeRecord` |
| Save replay clips on incidents | `SaveReplayBuffer` |
| React to stream drops/reconnects | `StreamStateChanged` with `OBS_WEBSOCKET_OUTPUT_RECONNECTING` |
| Batch scene + stream ops atomically | `RequestBatch` (OpCode 8) |
| Signal other clients of race events | `BroadcastCustomEvent` |

---

## Reference Links

- Protocol source: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
- Notable changes from 4.x to 5.x: https://github.com/obsproject/obs-websocket/wiki/Notable-changes-between-4.x-and-5.x
- OBS hotkey IDs: https://github.com/obsproject/obs-studio/blob/master/libobs/obs-hotkeys.h
