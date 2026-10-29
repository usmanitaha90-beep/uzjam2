export const APP_STATE_SCHEMA_VERSION = 6;

export const STORAGE_KEYS = Object.freeze({
  primary: "uzjam-v2-state",
  pending: "uzjam-v2-state-pending",
  backup: "uzjam-v2-state-backup",
});

function parseObject(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    var value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    return null;
  }
}

function read(storage, key) {
  try {
    return storage.getItem(key);
  } catch (error) {
    return null;
  }
}

/**
 * Reads the newest complete state. The pending slot covers interruption between
 * staging and committing a write; the backup slot retains the previous valid
 * commit. Returned metadata lets the UI explain when recovery was necessary.
 */
export function loadPersistedState(storage, keys = STORAGE_KEYS) {
  if (!storage) return { state: null, source: "none", recovered: false };

  var primaryRaw = read(storage, keys.primary);
  var primary = parseObject(primaryRaw);
  var pendingRaw = read(storage, keys.pending);
  var pending = parseObject(pendingRaw);
  // A different staged value was written after the last primary commit. It is
  // therefore the newest complete snapshot after an interrupted commit.
  if (pending && pendingRaw !== primaryRaw) {
    return {
      state: pending,
      source: "pending",
      recovered: true,
      reason: primary ? "interrupted-write" : primaryRaw ? "invalid-primary" : "interrupted-write",
    };
  }

  if (primary) return { state: primary, source: "primary", recovered: false };

  if (pending) {
    return { state: pending, source: "pending", recovered: true, reason: "interrupted-write" };
  }

  var backup = parseObject(read(storage, keys.backup));
  if (backup) {
    return {
      state: backup,
      source: "backup",
      recovered: true,
      reason: primaryRaw ? "invalid-primary" : "missing-primary",
    };
  }

  return {
    state: null,
    source: "none",
    recovered: false,
    reason: primaryRaw ? "invalid-primary" : undefined,
  };
}

/**
 * Stages state before replacing the primary value and keeps the prior valid
 * primary as a last-known-good backup. This is intentionally storage-agnostic
 * so a native shell can provide the same getItem/setItem/removeItem contract.
 */
export function savePersistedState(storage, state, keys = STORAGE_KEYS) {
  if (!storage) throw new Error("Persistent storage is unavailable.");
  var serialized = JSON.stringify(state);
  var previousRaw = read(storage, keys.primary);
  var previous = parseObject(previousRaw);

  if (previous && previousRaw !== serialized) storage.setItem(keys.backup, previousRaw);
  storage.setItem(keys.pending, serialized);
  storage.setItem(keys.primary, serialized);
  storage.removeItem(keys.pending);
}

export function clearPersistedState(storage, keys = STORAGE_KEYS) {
  if (!storage) return;
  storage.removeItem(keys.primary);
  storage.removeItem(keys.pending);
  storage.removeItem(keys.backup);
}

/** A portable envelope for full settings/profile backup files. */
export function createSettingsBackup(state, createdAtUtc = new Date().toISOString()) {
  return {
    format: "uzjam-settings-backup",
    formatVersion: 1,
    createdAtUtc,
    appState: state,
  };
}

export function readSettingsBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("This is not a UZjam settings backup.");
  }

  var enveloped = value.format === "uzjam-settings-backup";
  if (enveloped && value.formatVersion !== 1) {
    throw new Error("This settings backup version is not supported by this UZjam build.");
  }

  var state = enveloped ? value.appState : value;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("The backup does not contain application settings.");
  }
  if (!state.settings || !Array.isArray(state.profiles) || !Array.isArray(state.bands)) {
    throw new Error("The backup is missing settings, profiles, or EQ bands.");
  }
  var stateVersion = Number(state.schemaVersion) || 0;
  if (stateVersion > APP_STATE_SCHEMA_VERSION) {
    throw new Error("This backup was created by a newer UZjam build.");
  }
  return state;
}
