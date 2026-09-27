use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WALEntry {
    pub seq_id: u64,
    pub timestamp_ns: u64,
    pub event_type: String,
    pub payload_json: String,
    pub checksum: String,
}

pub struct EngineWAL {
    seq_counter: AtomicU64,
    file_writer: Option<File>,
    last_checksum: parking_lot::Mutex<String>,
}

impl EngineWAL {
    pub fn new(path: Option<&str>) -> Self {
        let file_writer =
            path.and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok());

        Self {
            seq_counter: AtomicU64::new(0),
            file_writer,
            last_checksum: parking_lot::Mutex::new("0".repeat(64)),
        }
    }

    pub fn record(&self, event_type: &str, payload_json: &str) -> WALEntry {
        let seq = self.seq_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let ts_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        let mut last_ck = self.last_checksum.lock();
        let mut hasher = Sha256::new();
        hasher.update(format!(
            "{}|{}|{}|{}|{}",
            seq, ts_ns, event_type, payload_json, *last_ck
        ));
        let checksum = format!("{:x}", hasher.finalize());
        *last_ck = checksum.clone();

        let entry = WALEntry {
            seq_id: seq,
            timestamp_ns: ts_ns,
            event_type: event_type.to_string(),
            payload_json: payload_json.to_string(),
            checksum,
        };

        if let Some(mut file) = self.file_writer.as_ref() {
            if let Ok(serialized) = serde_json::to_string(&entry) {
                let _ = writeln!(file, "{}", serialized);
            }
        }

        entry
    }

    pub fn current_seq(&self) -> u64 {
        self.seq_counter.load(Ordering::Relaxed)
    }
}
