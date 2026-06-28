use anyhow::{anyhow, Result};
use std::collections::HashMap;

use crate::iracing::defines::{
    IRSDK_MEMMAPFILE, IRSDK_STATUS_CONNECTED, NUM_VARS_OFFSET, SESSION_INFO_LEN_OFFSET,
    SESSION_INFO_OFFSET_OFFSET, SESSION_INFO_UPDATE_OFFSET, STATUS_OFFSET,
    VAR_HEADER_OFFSET_OFFSET, VAR_HEADER_SIZE,
};
use crate::iracing::types::{TelemetryField, TelemetryValue, VarType};

pub struct IracingSDK {
    data: Vec<u8>,
    /// name → (var_type, data_offset, count)
    pub var_offsets: HashMap<String, (i32, i32, i32)>,
}

fn read_i32(data: &[u8], offset: usize) -> Option<i32> {
    data.get(offset..offset + 4)
        .and_then(|b| b.try_into().ok())
        .map(i32::from_le_bytes)
}

fn null_terminated(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

impl IracingSDK {
    #[cfg(target_os = "windows")]
    pub fn open() -> Result<Self> {
        use windows::core::PCSTR;
        use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingA, FILE_MAP_READ};

        let name = format!("{}\0", IRSDK_MEMMAPFILE);
        let handle = unsafe { OpenFileMappingA(FILE_MAP_READ.0, false, PCSTR(name.as_ptr())) };
        let handle =
            handle.map_err(|_| anyhow!("OpenFileMappingA failed — iRacing not running"))?;

        let ptr = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 1024 * 1024) };
        if ptr.Value.is_null() {
            return Err(anyhow!("MapViewOfFile failed"));
        }

        let data =
            unsafe { std::slice::from_raw_parts(ptr.Value as *const u8, 1024 * 1024).to_vec() };

        unsafe { windows::Win32::System::Memory::UnmapViewOfFile(ptr).ok() };
        unsafe { windows::Win32::Foundation::CloseHandle(handle).ok() };

        Ok(Self {
            data,
            var_offsets: HashMap::new(),
        })
    }

    #[cfg(not(target_os = "windows"))]
    pub fn open() -> Result<Self> {
        Err(anyhow!(
            "iRacing shared memory is only available on Windows"
        ))
    }

    pub fn is_connected(&self) -> bool {
        read_i32(&self.data, STATUS_OFFSET)
            .map(|s| s == IRSDK_STATUS_CONNECTED)
            .unwrap_or(false)
    }

    pub fn session_info_update(&self) -> i32 {
        read_i32(&self.data, SESSION_INFO_UPDATE_OFFSET).unwrap_or(0)
    }

    pub fn enumerate_vars(&mut self) -> Vec<TelemetryField> {
        let num_vars = match read_i32(&self.data, NUM_VARS_OFFSET) {
            Some(n) if n > 0 => n as usize,
            _ => return Vec::new(),
        };
        let header_offset = match read_i32(&self.data, VAR_HEADER_OFFSET_OFFSET) {
            Some(o) if o > 0 => o as usize,
            _ => return Vec::new(),
        };

        let mut fields = Vec::with_capacity(num_vars);
        self.var_offsets.clear();

        for i in 0..num_vars {
            let base = header_offset + i * VAR_HEADER_SIZE;
            if base + VAR_HEADER_SIZE > self.data.len() {
                break;
            }
            let chunk = &self.data[base..base + VAR_HEADER_SIZE];

            let var_type_raw = i32::from_le_bytes(chunk[0..4].try_into().unwrap_or([0; 4]));
            let offset = i32::from_le_bytes(chunk[4..8].try_into().unwrap_or([0; 4]));
            let count = i32::from_le_bytes(chunk[8..12].try_into().unwrap_or([0; 4]));
            let name = null_terminated(&chunk[16..48]);
            let desc = null_terminated(&chunk[48..112]);
            let unit = null_terminated(&chunk[112..144]);

            if name.is_empty() {
                continue;
            }

            let var_type = match var_type_raw {
                0 => VarType::Char,
                1 => VarType::Bool,
                2 => VarType::Int,
                3 => VarType::Bitfield,
                4 => VarType::Float,
                5 => VarType::Double,
                _ => VarType::Int,
            };

            // Snapshot current value
            let value = self.read_value_at(var_type_raw, offset as usize, count as usize);

            self.var_offsets
                .insert(name.clone(), (var_type_raw, offset, count));
            fields.push(TelemetryField {
                name,
                description: desc,
                unit,
                var_type,
                value,
            });
        }

        fields
    }

    pub fn read_session_info(&self) -> Option<String> {
        let len = read_i32(&self.data, SESSION_INFO_LEN_OFFSET)? as usize;
        let offset = read_i32(&self.data, SESSION_INFO_OFFSET_OFFSET)? as usize;
        if len == 0 || offset + len > self.data.len() {
            return None;
        }
        let raw = &self.data[offset..offset + len];
        let end = raw.iter().position(|&b| b == 0).unwrap_or(len);
        String::from_utf8(raw[..end].to_vec()).ok()
    }

    fn read_value_at(&self, var_type: i32, offset: usize, count: usize) -> TelemetryValue {
        match var_type {
            4 => {
                // Float
                if count > 1 {
                    let vals: Vec<f32> = (0..count)
                        .filter_map(|i| {
                            let o = offset + i * 4;
                            self.data
                                .get(o..o + 4)
                                .and_then(|b| b.try_into().ok())
                                .map(f32::from_le_bytes)
                        })
                        .collect();
                    TelemetryValue::FloatArray(vals)
                } else if let Some(b) = self
                    .data
                    .get(offset..offset + 4)
                    .and_then(|b| b.try_into().ok())
                {
                    TelemetryValue::Float(f32::from_le_bytes(b))
                } else {
                    TelemetryValue::Unavailable
                }
            }
            5 => {
                // Double
                if let Some(b) = self
                    .data
                    .get(offset..offset + 8)
                    .and_then(|b| b.try_into().ok())
                {
                    TelemetryValue::Double(f64::from_le_bytes(b))
                } else {
                    TelemetryValue::Unavailable
                }
            }
            2 | 3 => {
                // Int or Bitfield
                if count > 1 {
                    let vals: Vec<i32> = (0..count)
                        .filter_map(|i| {
                            let o = offset + i * 4;
                            self.data
                                .get(o..o + 4)
                                .and_then(|b| b.try_into().ok())
                                .map(i32::from_le_bytes)
                        })
                        .collect();
                    TelemetryValue::IntArray(vals)
                } else if let Some(b) = self
                    .data
                    .get(offset..offset + 4)
                    .and_then(|b| b.try_into().ok())
                {
                    if var_type == 3 {
                        TelemetryValue::Bitfield(i32::from_le_bytes(b) as u32)
                    } else {
                        TelemetryValue::Int(i32::from_le_bytes(b))
                    }
                } else {
                    TelemetryValue::Unavailable
                }
            }
            1 => {
                // Bool
                if let Some(&b) = self.data.get(offset) {
                    TelemetryValue::Bool(b != 0)
                } else {
                    TelemetryValue::Unavailable
                }
            }
            0 => {
                // Char
                if let Some(b) = self.data.get(offset..offset + count.max(1)) {
                    TelemetryValue::Char(null_terminated(b))
                } else {
                    TelemetryValue::Unavailable
                }
            }
            _ => TelemetryValue::Unavailable,
        }
    }

    // ── Convenience accessors (used by telemetry scaffold) ───────────────────

    pub fn read_var_float(&self, name: &str) -> Option<f32> {
        let &(vt, off, _) = self.var_offsets.get(name)?;
        if vt != 4 {
            return None;
        }
        self.data
            .get(off as usize..off as usize + 4)
            .and_then(|b| b.try_into().ok())
            .map(f32::from_le_bytes)
    }

    pub fn read_var_int(&self, name: &str) -> Option<i32> {
        let &(vt, off, _) = self.var_offsets.get(name)?;
        if vt != 2 && vt != 3 {
            return None;
        }
        self.data
            .get(off as usize..off as usize + 4)
            .and_then(|b| b.try_into().ok())
            .map(i32::from_le_bytes)
    }

    pub fn read_var_bool(&self, name: &str) -> Option<bool> {
        self.read_var_int(name).map(|v| v != 0)
    }

    pub fn read_var_float_array(&self, name: &str) -> Option<Vec<f32>> {
        let &(vt, off, count) = self.var_offsets.get(name)?;
        if vt != 4 {
            return None;
        }
        let o = off as usize;
        let n = count as usize;
        if o + n * 4 > self.data.len() {
            return None;
        }
        Some(
            (0..n)
                .filter_map(|i| {
                    self.data
                        .get(o + i * 4..o + i * 4 + 4)
                        .and_then(|b| b.try_into().ok())
                        .map(f32::from_le_bytes)
                })
                .collect(),
        )
    }

    pub fn read_watchlist_values(&self, watchlist: &[String]) -> HashMap<String, TelemetryValue> {
        watchlist
            .iter()
            .map(|name| {
                let value = if let Some(&(var_type, offset, count)) = self.var_offsets.get(name) {
                    self.read_value_at(var_type, offset as usize, count as usize)
                } else {
                    TelemetryValue::Unavailable
                };
                (name.clone(), value)
            })
            .collect()
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iracing::defines::{IRSDK_STATUS_CONNECTED, STATUS_OFFSET};

    fn make_sdk(data: Vec<u8>) -> IracingSDK {
        IracingSDK {
            data,
            var_offsets: HashMap::new(),
        }
    }

    fn write_i32(buf: &mut Vec<u8>, offset: usize, val: i32) {
        let b = val.to_le_bytes();
        buf[offset..offset + 4].copy_from_slice(&b);
    }

    // ── is_connected ──────────────────────────────────────────────────────────

    #[test]
    fn is_connected_when_status_is_one() {
        let mut data = vec![0u8; 64];
        write_i32(&mut data, STATUS_OFFSET, IRSDK_STATUS_CONNECTED);
        assert!(make_sdk(data).is_connected());
    }

    #[test]
    fn is_disconnected_when_status_is_zero() {
        let data = vec![0u8; 64];
        assert!(!make_sdk(data).is_connected());
    }

    #[test]
    fn crash_detection_status_flip() {
        // Start connected, overwrite to 0 (simulates process death)
        let mut data = vec![0u8; 64];
        write_i32(&mut data, STATUS_OFFSET, IRSDK_STATUS_CONNECTED);
        let mut sdk = make_sdk(data);
        assert!(sdk.is_connected());
        write_i32(&mut sdk.data, STATUS_OFFSET, 0);
        assert!(!sdk.is_connected());
    }

    // ── enumerate_vars ────────────────────────────────────────────────────────

    #[test]
    fn enumerate_vars_parses_one_float_field() {
        let mut data = vec![0u8; 4096];

        // num_vars = 1 at offset 24
        write_i32(&mut data, NUM_VARS_OFFSET, 1);
        // var_header_offset = 256 at offset 28
        let hdr_base: usize = 256;
        write_i32(&mut data, VAR_HEADER_OFFSET_OFFSET, hdr_base as i32);

        // Write one IrsdkVarHeader at hdr_base (144 bytes)
        // var_type = Float (4)
        write_i32(&mut data, hdr_base, 4);
        // offset = 1024
        write_i32(&mut data, hdr_base + 4, 1024);
        // count = 1
        write_i32(&mut data, hdr_base + 8, 1);
        // name at hdr_base+16
        let name = b"Speed\0";
        data[hdr_base + 16..hdr_base + 16 + name.len()].copy_from_slice(name);
        // desc at hdr_base+48
        let desc = b"Speed m/s\0";
        data[hdr_base + 48..hdr_base + 48 + desc.len()].copy_from_slice(desc);
        // unit at hdr_base+112
        let unit = b"m/s\0";
        data[hdr_base + 112..hdr_base + 112 + unit.len()].copy_from_slice(unit);

        // Write float value 42.0 at offset 1024
        data[1024..1028].copy_from_slice(&42.0f32.to_le_bytes());

        let mut sdk = make_sdk(data);
        let fields = sdk.enumerate_vars();

        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].name, "Speed");
        assert_eq!(fields[0].unit, "m/s");
        assert!(matches!(fields[0].var_type, VarType::Float));
        assert!(
            matches!(fields[0].value, TelemetryValue::Float(v) if (v - 42.0).abs() < f32::EPSILON)
        );
        assert!(sdk.var_offsets.contains_key("Speed"));
    }

    // ── read_session_info ─────────────────────────────────────────────────────

    #[test]
    fn read_session_info_extracts_yaml_string() {
        let yaml = b"WeekendInfo:\n  TrackName: Sebring\n";
        let yaml_offset: usize = 512;
        let mut data = vec![0u8; 4096];

        write_i32(&mut data, SESSION_INFO_LEN_OFFSET, yaml.len() as i32);
        write_i32(&mut data, SESSION_INFO_OFFSET_OFFSET, yaml_offset as i32);
        data[yaml_offset..yaml_offset + yaml.len()].copy_from_slice(yaml);

        let sdk = make_sdk(data);
        let result = sdk.read_session_info();
        assert!(result.is_some());
        assert!(result.unwrap().contains("Sebring"));
    }

    #[test]
    fn read_session_info_returns_none_when_len_zero() {
        let data = vec![0u8; 64];
        let sdk = make_sdk(data);
        assert!(sdk.read_session_info().is_none());
    }
}
