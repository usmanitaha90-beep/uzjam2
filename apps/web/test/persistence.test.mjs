import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_STATE_SCHEMA_VERSION,
  STORAGE_KEYS,
  clearPersistedState,
  createSettingsBackup,
  loadPersistedState,
  readSettingsBackup,
  savePersistedState,
} from "../src/persistence.js";
import { createSessionPersistence } from "../src/session-persistence.js";

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("commits state and retains the prior valid commit", () => {
  const storage = new MemoryStorage();
  const first = { schemaVersion: APP_STATE_SCHEMA_VERSION, activeProfileName: "First" };
  const second = { schemaVersion: APP_STATE_SCHEMA_VERSION, activeProfileName: "Second" };

  savePersistedState(storage, first);
  savePersistedState(storage, second);

  assert.deepEqual(loadPersistedState(storage), {
    state: second,
    source: "primary",
    recovered: false,
  });
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.backup)), first);
  assert.equal(storage.getItem(STORAGE_KEYS.pending), null);
});

test("recovers an interrupted staged write before the older backup", () => {
  const pending = { schemaVersion: APP_STATE_SCHEMA_VERSION, activeProfileName: "Staged" };
  const backup = { schemaVersion: 5, activeProfileName: "Backup" };
  const storage = new MemoryStorage({
    [STORAGE_KEYS.primary]: "{broken",
    [STORAGE_KEYS.pending]: JSON.stringify(pending),
    [STORAGE_KEYS.backup]: JSON.stringify(backup),
  });

  const result = loadPersistedState(storage);
  assert.deepEqual(result.state, pending);
  assert.equal(result.source, "pending");
  assert.equal(result.recovered, true);
  assert.equal(result.reason, "invalid-primary");
});

test("prefers a newer staged commit over a still-valid older primary", () => {
  const primary = { schemaVersion: APP_STATE_SCHEMA_VERSION, revision: 1 };
  const pending = { schemaVersion: APP_STATE_SCHEMA_VERSION, revision: 2 };
  const storage = new MemoryStorage({
    [STORAGE_KEYS.primary]: JSON.stringify(primary),
    [STORAGE_KEYS.pending]: JSON.stringify(pending),
  });

  const result = loadPersistedState(storage);
  assert.deepEqual(result.state, pending);
  assert.equal(result.source, "pending");
  assert.equal(result.reason, "interrupted-write");
});

test("recovers the last-known-good backup when primary is malformed", () => {
  const backup = { schemaVersion: 5, activeProfileName: "Safe" };
  const storage = new MemoryStorage({
    [STORAGE_KEYS.primary]: "not-json",
    [STORAGE_KEYS.backup]: JSON.stringify(backup),
  });

  const result = loadPersistedState(storage);
  assert.deepEqual(result.state, backup);
  assert.equal(result.source, "backup");
  assert.equal(result.recovered, true);
});

test("clearing data removes primary, staged, and backup state", () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.primary]: "{}",
    [STORAGE_KEYS.pending]: "{}",
    [STORAGE_KEYS.backup]: "{}",
  });

  clearPersistedState(storage);
  assert.deepEqual([...storage.values.keys()], []);
});

test("settings backup envelope round-trips and rejects profile-only JSON", () => {
  const state = { schemaVersion: APP_STATE_SCHEMA_VERSION, settings: { theme: "dark" }, profiles: [], bands: [] };
  const backup = createSettingsBackup(state, "2026-10-07T12:00:00.000Z");

  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.createdAtUtc, "2026-10-07T12:00:00.000Z");
  assert.deepEqual(readSettingsBackup(backup), state);
  assert.throws(() => readSettingsBackup({ schemaVersion: 1, filters: [] }), /missing settings/i);
  assert.throws(
    () => readSettingsBackup({ ...backup, formatVersion: 2 }),
    /backup version is not supported/i,
  );
  assert.throws(
    () => readSettingsBackup({ ...backup, appState: { ...state, schemaVersion: APP_STATE_SCHEMA_VERSION + 1 } }),
    /newer UZjam build/i,
  );
});

test("session persistence flushes synchronously before shutdown", () => {
  const storage = new MemoryStorage();
  let revision = 1;
  let stopped = 0;
  const session = createSessionPersistence({
    storage,
    snapshot: () => ({ schemaVersion: APP_STATE_SCHEMA_VERSION, revision }),
    debounceMs: 10_000,
  });

  session.schedule();
  revision = 2;
  assert.equal(session.shutdown(() => { stopped += 1; }), true);
  assert.equal(stopped, 1);
  assert.equal(loadPersistedState(storage).state.revision, 2);
  session.dispose();
});

test("session persistence reports storage errors without throwing from lifecycle code", () => {
  const errors = [];
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("quota exceeded"); };
  const session = createSessionPersistence({
    storage,
    snapshot: () => ({ schemaVersion: APP_STATE_SCHEMA_VERSION }),
    onError: (error) => errors.push(error.message),
  });

  assert.equal(session.flush(), false);
  assert.deepEqual(errors, ["quota exceeded"]);
  session.dispose();
});

test("clear is durable against a later pagehide flush", () => {
  const storage = new MemoryStorage();
  const session = createSessionPersistence({
    storage,
    snapshot: () => ({ stale: true }),
  });
  session.flush();

  assert.equal(session.clear(), true);
  assert.equal(session.flush(), false);
  assert.equal(loadPersistedState(storage).state, null);
});

test("replacement backup cannot be overwritten by the pre-import snapshot", () => {
  const storage = new MemoryStorage();
  const session = createSessionPersistence({
    storage,
    snapshot: () => ({ profile: "old" }),
  });
  session.flush();

  assert.equal(session.replaceAndSuspend({ profile: "restored" }), true);
  assert.equal(session.flush(), false);
  assert.equal(loadPersistedState(storage).state.profile, "restored");
});
