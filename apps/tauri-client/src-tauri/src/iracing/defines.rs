// Constants derived from irsdk_defines.h

// Header status
pub const IRSDK_STATUS_CONNECTED: i32 = 1;

// Variable header size (bytes): matches sizeof(irsdk_varHeader) = 144
pub const VAR_HEADER_SIZE: usize = 144;

// Header byte offsets (all i32 fields)
pub const STATUS_OFFSET: usize = 4;
pub const TICK_RATE_OFFSET: usize = 8;
pub const SESSION_INFO_UPDATE_OFFSET: usize = 12;
pub const SESSION_INFO_LEN_OFFSET: usize = 16;
pub const SESSION_INFO_OFFSET_OFFSET: usize = 20;
pub const NUM_VARS_OFFSET: usize = 24;
pub const VAR_HEADER_OFFSET_OFFSET: usize = 28;

pub const IRSDK_MEMMAPFILE: &str = "Local\\IRSDKMemMapFileName";
pub const IRSDK_BROADCASTMSGNAME: &str = "IRSDK_BROADCASTMSG";
pub const IRSDK_DATAVALIDEVENTNAME: &str = "Local\\IRSDKDataValidEvent";

pub const IRSDK_MAX_BUFS: usize = 4;

// irsdk_header varBuf array (follows the 32-byte diskSubHeader at offset 48)
pub const NUM_BUF_OFFSET: usize = 32;   // int numBuf
pub const VAR_BUF_OFFSET: usize = 48;   // irsdk_varBuf[4] starts here (live memory has no diskSubHeader)
pub const VAR_BUF_STRIDE: usize = 16;   // sizeof(irsdk_varBuf) = tickCount+bufOffset+pad[2]
pub const IRSDK_MAX_STRING: usize = 32;
pub const IRSDK_MAX_DESC: usize = 64;

// Variable types
pub const IRSDK_CHAR: i32 = 0;
pub const IRSDK_BOOL: i32 = 1;
pub const IRSDK_INT: i32 = 2;
pub const IRSDK_BITFIELD: i32 = 3;
pub const IRSDK_FLOAT: i32 = 4;
pub const IRSDK_DOUBLE: i32 = 5;

// Broadcast message types
pub const IRSDK_BROADCAST_CAM_SWITCH_POS: u32 = 0;
pub const IRSDK_BROADCAST_CAM_SWITCH_NUM: u32 = 1;
pub const IRSDK_BROADCAST_CAM_SET_STATE: u32 = 2;
pub const IRSDK_BROADCAST_REPLAY_SET_PLAY_SPEED: u32 = 3;
pub const IRSDK_BROADCAST_REPLAY_SET_PLAY_POSITION: u32 = 4;
pub const IRSDK_BROADCAST_REPLAY_SEARCH: u32 = 5;
pub const IRSDK_BROADCAST_REPLAY_SET_STATE: u32 = 6;
pub const IRSDK_BROADCAST_RELOAD_TEXTURES: u32 = 7;
pub const IRSDK_BROADCAST_CHAT_COMMAND: u32 = 8;
pub const IRSDK_BROADCAST_PIT_COMMAND: u32 = 9;

// Session flags
pub const IRSDK_FLAG_CHECKERED: u32 = 0x0001;
pub const IRSDK_FLAG_WHITE: u32 = 0x0002;
pub const IRSDK_FLAG_GREEN: u32 = 0x0004;
pub const IRSDK_FLAG_YELLOW: u32 = 0x0008;
pub const IRSDK_FLAG_RED: u32 = 0x0010;
pub const IRSDK_FLAG_BLUE: u32 = 0x0020;
pub const IRSDK_FLAG_CAUTION: u32 = 0x4000;
pub const IRSDK_FLAG_CAUTION_WAVING: u32 = 0x8000;
