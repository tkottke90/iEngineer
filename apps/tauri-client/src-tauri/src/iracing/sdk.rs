use anyhow::{anyhow, Result};
use std::collections::HashMap;

pub struct IracingSDK {
    // On Windows: pointer to MapViewOfFile base
    // Using Vec<u8> as a portable stand-in for the mapped region
    data: Vec<u8>,
    var_offsets: HashMap<String, (i32, i32, i32)>, // name → (type, offset, count)
}

impl IracingSDK {
    pub fn open() -> Result<Self> {
        #[cfg(target_os = "windows")]
        {
            // TODO: OpenFileMapping + MapViewOfFile using windows crate
            // let handle = unsafe { OpenFileMapping(...) };
        }

        // Stub for non-Windows build
        Ok(Self {
            data: vec![0u8; 1024 * 1024],
            var_offsets: HashMap::new(),
        })
    }

    pub fn is_connected(&self) -> bool {
        // Check header.status field at offset 4
        if self.data.len() < 8 {
            return false;
        }
        let status = i32::from_le_bytes([self.data[4], self.data[5], self.data[6], self.data[7]]);
        status == 1
    }

    pub fn read_var_float(&self, name: &str) -> Option<f32> {
        let (_, offset, _) = self.var_offsets.get(name)?;
        let o = *offset as usize;
        if o + 4 > self.data.len() { return None; }
        Some(f32::from_le_bytes(self.data[o..o + 4].try_into().ok()?))
    }

    pub fn read_var_int(&self, name: &str) -> Option<i32> {
        let (_, offset, _) = self.var_offsets.get(name)?;
        let o = *offset as usize;
        if o + 4 > self.data.len() { return None; }
        Some(i32::from_le_bytes(self.data[o..o + 4].try_into().ok()?))
    }

    pub fn read_var_bool(&self, name: &str) -> Option<bool> {
        self.read_var_int(name).map(|v| v != 0)
    }

    pub fn read_var_float_array(&self, name: &str) -> Option<Vec<f32>> {
        let (_, offset, count) = self.var_offsets.get(name)?;
        let o = *offset as usize;
        let n = *count as usize;
        if o + n * 4 > self.data.len() { return None; }
        Some(
            (0..n)
                .map(|i| f32::from_le_bytes(self.data[o + i * 4..o + i * 4 + 4].try_into().unwrap()))
                .collect(),
        )
    }

    pub fn read_session_info(&self) -> Option<String> {
        // TODO: read session_info_offset + session_info_len from header,
        // extract UTF-8 YAML string from data buffer
        None
    }
}
