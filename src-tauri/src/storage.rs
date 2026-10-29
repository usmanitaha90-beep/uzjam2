use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct StateStore {
    directory: PathBuf,
}

impl StateStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn primary_path(&self) -> PathBuf {
        self.directory.join("app-state.json")
    }

    fn pending_path(&self) -> PathBuf {
        self.directory.join("app-state.pending.json")
    }

    fn backup_path(&self) -> PathBuf {
        self.directory.join("app-state.backup.json")
    }

    pub fn load(&self) -> Result<Option<Value>, String> {
        let primary = self.primary_path();
        let pending = self.pending_path();
        let backup = self.backup_path();
        let mut first_error = None;

        // A valid pending file is a fully staged, newer commit that may have
        // survived interruption just before the final rename.
        for path in [&pending, &primary, &backup] {
            match read_json(path) {
                Ok(Some(value)) => return Ok(Some(value)),
                Ok(None) => {}
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(format!("{}: {error}", path.display()));
                    }
                }
            }
        }

        if primary.exists() || pending.exists() || backup.exists() {
            Err(first_error.unwrap_or_else(|| "Saved state could not be read.".into()))
        } else {
            Ok(None)
        }
    }

    pub fn persist(&self, snapshot: &Value) -> Result<(), String> {
        if !snapshot.is_object() {
            return Err("Application state must be a JSON object.".into());
        }
        let bytes = serde_json::to_vec_pretty(snapshot)
            .map_err(|error| format!("Application state could not be encoded: {error}"))?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err("Application state is unexpectedly large and was not saved.".into());
        }

        fs::create_dir_all(&self.directory)
            .map_err(|error| format!("The settings directory could not be created: {error}"))?;
        let primary = self.primary_path();
        let pending = self.pending_path();
        let backup = self.backup_path();

        write_synced(&pending, &bytes)
            .map_err(|error| format!("The staged settings file could not be written: {error}"))?;

        if primary.exists() {
            if matches!(read_json(&primary), Ok(Some(_))) {
                fs::copy(&primary, &backup).map_err(|error| {
                    format!("The settings backup could not be updated: {error}")
                })?;
            }
            fs::remove_file(&primary).map_err(|error| {
                format!("The previous settings file could not be replaced: {error}")
            })?;
        }

        fs::rename(&pending, &primary)
            .map_err(|error| format!("The settings commit could not be completed: {error}"))?;
        sync_directory(&self.directory);
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        for path in [self.primary_path(), self.pending_path(), self.backup_path()] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("{} could not be removed: {error}", path.display()));
                }
            }
        }
        Ok(())
    }
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let length = file.metadata().map_err(|error| error.to_string())?.len() as usize;
    if length > MAX_STATE_BYTES {
        return Err("file exceeds the application-state size limit".into());
    }
    let mut contents = String::with_capacity(length);
    file.read_to_string(&mut contents)
        .map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    if !value.is_object() {
        return Err("saved application state is not a JSON object".into());
    }
    Ok(Some(value))
}

fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()
}

fn sync_directory(directory: &Path) {
    if let Ok(file) = File::open(directory) {
        let _ = file.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn staged_state_wins_after_interrupted_commit() {
        let directory = tempfile::tempdir().expect("temporary settings directory");
        let store = StateStore::new(directory.path().to_path_buf());
        store
            .persist(&json!({ "schemaVersion": 6, "name": "older" }))
            .unwrap();
        write_synced(
            &store.pending_path(),
            &serde_json::to_vec(&json!({ "schemaVersion": 6, "name": "newer" })).unwrap(),
        )
        .unwrap();

        assert_eq!(store.load().unwrap().unwrap()["name"], "newer");
    }

    #[test]
    fn malformed_primary_never_replaces_last_known_good_backup() {
        let directory = tempfile::tempdir().expect("temporary settings directory");
        let store = StateStore::new(directory.path().to_path_buf());
        store
            .persist(&json!({ "schemaVersion": 6, "name": "safe" }))
            .unwrap();
        store
            .persist(&json!({ "schemaVersion": 6, "name": "current" }))
            .unwrap();
        fs::write(store.primary_path(), b"not-json").unwrap();
        store
            .persist(&json!({ "schemaVersion": 6, "name": "replacement" }))
            .unwrap();

        assert_eq!(
            read_json(&store.backup_path()).unwrap().unwrap()["name"],
            "safe"
        );
        assert_eq!(store.load().unwrap().unwrap()["name"], "replacement");
    }
}
