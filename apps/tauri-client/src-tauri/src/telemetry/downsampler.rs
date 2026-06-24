const SESSION_DIVISOR: u64 = 4; // 60 Hz / 4 = 15 Hz

pub struct Downsampler {
    tick: u64,
}

impl Downsampler {
    pub fn new() -> Self {
        Self { tick: 0 }
    }

    /// Returns true every 4th tick (60 Hz → 15 Hz)
    pub fn should_emit_session(&mut self) -> bool {
        self.tick += 1;
        self.tick % SESSION_DIVISOR == 0
    }
}
