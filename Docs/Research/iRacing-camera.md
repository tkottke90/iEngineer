# iRacing Camera Control Research

## 1. Overview

iRacing exposes camera control through two mechanisms: **read-only telemetry variables** (live state of the camera system) and **broadcast commands** (one-way commands to switch cameras). Both are accessible through the same memory-mapped SDK interface used for telemetry.

Camera control is a **live-session-only** feature. IBT replay files do not support camera switching — the camera state variables exist in IBT data, but broadcast commands have no effect when reading from a file. Any implementation must gate camera commands behind a live-session check.

The iRacing camera system is organized into **groups**, where each group represents a named camera style (e.g., "TV1", "Chase", "Pit Lane"). Within each group there are one or more individual camera positions. The active camera at any time is identified by a group number plus a camera number within that group.

---

## 2. Reading Camera State

Camera state is exposed as live telemetry variables updated at 60 Hz:

- `CamGroupNumber` — the currently active camera group ID (integer)
- `CamCameraNumber` — the currently active camera number within the group
- `CamCarIdx` — CarIdx of the car the camera is currently following
- `CamCameraState` — bitfield of camera state flags

The `CamCameraState` bitfield includes flags for:

- `is_session_screen` — camera is on a session/results screen
- `is_scenic_active` — scenic camera mode is active
- `cam_tool_active` — camera tool is active
- `ui_hidden` — the in-game UI overlay is hidden
- `use_auto_shot_selection` — iRacing's automatic camera direction is active
- `use_temporary_edits` — temporary camera edits are in effect
- `use_key_acceleration`, `use_key_10x_acceleration` — keyboard camera speed modes
- `use_mouse_aim_mode` — mouse aim camera control is active

The `CamCameraState` flags are readable but also writable via the `cam_set_state` broadcast command.

### Camera Groups (CameraInfo YAML)

Available camera groups for the current session are in the `CameraInfo` YAML section, which is part of the session string (not a live telemetry variable):

```yaml
CameraInfo:
  Groups:
  - GroupNum: 1
    GroupName: Nose
    Cameras:
    - CameraNum: 1
      CameraName: CamNose
  - GroupNum: 2
    GroupName: Gearbox
    Cameras:
    - CameraNum: 1
      CameraName: CamGearbox
  ...
```

**Important:** Camera group numbers are **not stable across tracks or sessions**. The same group name (e.g., "Pit Lane") will have different `GroupNum` values depending on the track and session configuration. Always look up group IDs from `CameraInfo` at session start rather than hardcoding them.

---

## 3. Broadcast Commands

Camera control uses **broadcast commands** sent via pyirsdk. These are fire-and-forget — there is no return value or acknowledgment. The change is visible on the next telemetry read after iRacing processes the command.

### cam_switch_pos

```python
ir.cam_switch_pos(position, group, camera)
```

Switches the camera to a car by its **position on track** (1st, 2nd, 3rd, etc.) using a specific group and camera number. Less useful for production code since positions change constantly.

### cam_switch_num

```python
ir.cam_switch_num(car_num, group, camera)
```

Switches the camera to follow a specific **car number** (the number on the car, not CarIdx) with the specified camera group. This is the primary command for directing the camera at a known car. Camera defaults to `0` which selects the active camera within the group.

```python
# Switch to car #42 using camera group 5
ir.cam_switch_num(42, 5)
```

### cam_set_state

```python
ir.cam_set_state(state_flags)
```

Sets camera state flags using the `CameraState` enum from irsdk. Primarily useful for hiding the iRacing UI overlay:

```python
from irsdk import CameraState
ir.cam_set_state(CameraState.ui_hidden)
```

---

## 4. POC Implementation

The POC (`poc-ir-py-sdk`) implemented a complete camera management layer. The architecture is:

### Data Models (`src/camera.py`)

- `iRacingCamera` — represents a single camera (`id`, `name`)
- `iRacingCameraGroup` — represents a group (`id`, `name`, `cameras: list[iRacingCamera]`)
- `CameraManager` — top-level manager that reads `CameraInfo` from the session YAML and tracks the currently active group

`CameraManager` is initialized lazily on first camera access and refreshed each tick via `CameraManager.refresh(ir)`. It reads `CameraInfo` from the YAML and builds the group/camera tree. For IBT files it returns empty lists rather than erroring.

### State Machine (`src/iracing.py`)

The `State` class implements an automatic pit camera sequencer in `set_camera_by_driver`. It tracks three phases of a pit stop and switches to appropriate camera groups at each transition:

| Phase            | Trigger                                                      | Camera Group Used        |
| ---------------- | ------------------------------------------------------------ | ------------------------ |
| Approaching pits | `driver_on_pit_road == True` and `driver_in_pits == False`   | Group 16 ("Pit Lane 2")  |
| In pit stall     | `driver_in_pit_stall == True` and `driver_in_stall == False` | Group 21 ("Pit Stall")   |
| Pit exit         | `driver_in_stall == True` and no longer in stall             | Group 14 ("Pit Exit")    |
| Back on track    | `driver_on_track == True` and `driver_in_pits == True`       | Restores previous camera |

**Note:** The group IDs 14, 16, and 21 used in the POC were hardcoded from a specific session. In production, these must be resolved dynamically by name from `CameraInfo`.

The `last_camera` field saves the active group ID before a pit entry so it can be restored when the driver rejoins the track.

`set_camera_by_driver` returns `False` (no-op) when:

- The telemetry source is an IBT file
- The `show_pit_cams` toggle is `False` (opt-in feature disabled by default)

### HTTP API (`src/server/`)

Three endpoints expose camera control:

| Endpoint                      | Method | Description                                                                                                   |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `/api/camera`                 | GET    | Returns `current_camera` name, `camera_target` group ID, full `camera_groups` list, and `show_pit_cams` state |
| `/api/camera/set`             | POST   | Accepts `{ "camera_group_id": int }`, switches camera to that group for the player's car                      |
| `/api/camera/toggle-pit-cams` | POST   | Toggles the automatic pit camera sequencer on/off                                                             |

The `camera_groups` response from `GET /api/camera` provides the full list of available groups (id + name) discovered from `CameraInfo`, enabling a UI to display group options without hardcoding.

### Standalone Script (`changeCamera.py`)

A minimal root-level script demonstrates direct camera switching with no state management:

```python
ir = irsdk.IRSDK()
ir.startup()
ir.cam_switch_pos(group=args.group)
```

This is the simplest possible camera switch — no car targeting, just switching the active group by number passed as a CLI argument.

---

## 5. Limitations and Gotchas

**Group IDs are session-specific.** Always read `CameraInfo` YAML to discover group IDs rather than hardcoding. Group names are stable (e.g., "TV1", "Chase"), but their numeric IDs vary.

**No confirmation of camera switch.** `cam_switch_num` and `cam_switch_pos` are broadcast messages with no acknowledgment. Verify the switch succeeded by reading `CamGroupNumber` on the next tick.

**Camera can be overridden by iRacing.** If iRacing's director AI (`use_auto_shot_selection`) is active, or if the user interacts with the camera directly, the programmatic camera state can be overridden without warning. The `CamCameraState` bitfield can be checked for the `use_auto_shot_selection` flag to detect this.

**IBT files are read-only.** Camera commands are silently ignored when the telemetry source is a `FileTelemetryHandler`. Guard every camera write with `isinstance(ir, LiveTelemetryHandler)`.

**`cam_switch_num` uses car number, not CarIdx.** The first argument is the integer car number (the number painted on the car body), not the `CarIdx` used by telemetry arrays. Use `Driver.car_number_int()` to convert from the `CarNumber` string field.

**UI state is separate from camera group.** `cam_set_state(CameraState.ui_hidden)` hides the iRacing HUD overlay but does not change which camera or car is being viewed.

---

## 6. Open Questions

**Group ID stability within a series.** While group IDs differ across tracks, it's unclear whether they are stable within the same track and session type (e.g., Road Atlanta oval always assigns Group 14 to pit exit). If stable within a series, lookup could be cached rather than queried every session.

**Camera switching latency.** The round-trip time from `cam_switch_num` call to `CamGroupNumber` reflecting the change is undocumented. In practice it appears to be one or two 60 Hz ticks, but this hasn't been measured precisely.

**AI session camera behavior.** Whether camera broadcast commands work in AI-only sessions (no human driver) is untested. The iRacing director may override commands differently in AI sessions.

**Scenic camera access.** The `is_scenic_active` flag exists in `CamCameraState` but there is no documented broadcast command to activate scenic cameras programmatically.

---

## References

- [iRacing SDK Community Documentation](https://sajax.github.io/irsdkdocs/)
- [CameraInfo YAML](https://sajax.github.io/irsdkdocs/yaml/camerainfo.html)
- [Telemetry Variable Index — Camera variables](https://sajax.github.io/irsdkdocs/telemetry/)
- [pyirsdk](https://github.com/kutu/pyirsdk)
- [POC Repository](https://github.com/tkottke90/poc-ir-py-sdk)
  - [`src/camera.py`](https://github.com/tkottke90/poc-ir-py-sdk/blob/main/src/camera.py) — CameraManager, iRacingCameraGroup, iRacingCamera
  - [`src/iracing.py`](https://github.com/tkottke90/poc-ir-py-sdk/blob/main/src/iracing.py) — State class with pit camera sequencer
  - [`src/server/camera.py`](https://github.com/tkottke90/poc-ir-py-sdk/blob/main/src/server/camera.py) — GET /api/camera endpoint
  - [`src/server/set_camera.py`](https://github.com/tkottke90/poc-ir-py-sdk/blob/main/src/server/set_camera.py) — POST /api/camera/set endpoint
  - [`changeCamera.py`](https://github.com/tkottke90/poc-ir-py-sdk/blob/main/changeCamera.py) — minimal standalone camera switch script
