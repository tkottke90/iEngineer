use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ── Connection ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum ConnectionStatus {
    Connected,
    Disconnected,
    Connecting,
}

// ── Session info (parsed from YAML blob) ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionInfo {
    pub track_name: String,
    pub session_type: String,
    pub car_name: String,
    /// HH:MM:SS in local time, captured from system clock at emission
    pub wall_clock_time: String,
    /// Player car index; from DriverInfo.DriverCarIdx (root-level) in session YAML
    pub player_car_idx: u32,
}

// ── Telemetry types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum VarType {
    Char,
    Bool,
    Int,
    Bitfield,
    Float,
    Double,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum TelemetryValue {
    Float(f32),
    Double(f64),
    Int(i32),
    Bool(bool),
    Bitfield(u32),
    Char(String),
    FloatArray(Vec<f32>),
    IntArray(Vec<i32>),
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TelemetryField {
    pub name: String,
    pub description: String,
    pub unit: String,
    pub var_type: VarType,
    pub value: TelemetryValue,
}

// ── C-layout structs (shared memory) ─────────────────────────────────────────

#[repr(C)]
pub struct IrsdkHeader {
    pub ver: i32,
    pub status: i32,
    pub tick_rate: i32,
    pub session_info_update: i32,
    pub session_info_len: i32,
    pub session_info_offset: i32,
    pub num_vars: i32,
    pub var_header_offset: i32,
    pub num_buf: i32,
    pub buf_len: i32,
    pub pad: [i32; 2],
    pub var_buf: [IrsdkVarBuf; 4],
}

#[repr(C)]
pub struct IrsdkVarBuf {
    pub tick_count: i32,
    pub buf_offset: i32,
    pub pad: [i32; 2],
}

#[repr(C)]
pub struct IrsdkVarHeader {
    pub var_type: i32,
    pub offset: i32,
    pub count: i32,
    pub count_as_time: u8,
    pub pad: [u8; 3],
    pub name: [u8; 32],
    pub desc: [u8; 64],
    pub unit: [u8; 32],
}

// ── Legacy types (kept for backward compat with existing code) ────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionData {
    pub track_name: Option<String>,
    pub track_length: Option<String>,
    pub session_type: Option<String>,
    pub num_cars: Option<u32>,
    pub drivers: Vec<DriverInfo>,
    pub camera_groups: Vec<CameraGroup>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DriverInfo {
    pub car_idx: u32,
    pub user_name: String,
    pub car_number: String,
    pub team_name: String,
    pub car_class_id: u32,
    pub cust_id: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CameraGroup {
    pub group_num: u32,
    pub group_name: String,
    pub cameras: Vec<CameraInfo>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CameraInfo {
    pub camera_num: u32,
    pub camera_name: String,
}
