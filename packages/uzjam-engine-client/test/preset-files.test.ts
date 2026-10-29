import assert from "node:assert/strict";
import test from "node:test";
import type { UzjamProfile } from "@uzjam/contract";
import {
  UzjamPresetFileError,
  parseUzjamPresetFile,
  serializeUzjamPresetFile,
  uzjamPresetFilename,
} from "../src/index.js";

const profile: UzjamProfile = {
  schemaVersion: 1,
  id: "listening-room",
  name: "Beyerdynamic / Listening Room",
  filters: [
    {
      id: "presence",
      enabled: true,
      kind: "peak",
      frequencyHz: 2800,
      gainDb: -2.5,
      q: 1.4,
      channel: "stereo",
    },
  ],
  dsp: {
    enabled: true,
    preampDb: 0,
    headroomMode: "auto",
    manualHeadroomDb: 0,
    safetyMarginDb: 1,
    clippingPolicy: "auto",
    limiterEnabled: false,
  },
  metadata: {
    createdAtUtc: "2026-10-07T12:00:00.000Z",
    modifiedAtUtc: "2026-10-07T12:00:00.000Z",
  },
};

test("canonical preset files round-trip through validation", () => {
  const serialized = serializeUzjamPresetFile(profile);
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(parseUzjamPresetFile(serialized), profile);
});

test("preset parsing returns actionable file errors", () => {
  assert.throws(
    () => parseUzjamPresetFile("not json"),
    (error: unknown) => error instanceof UzjamPresetFileError && error.code === "invalid-json",
  );
  assert.throws(
    () => parseUzjamPresetFile(JSON.stringify({ schemaVersion: 1 })),
    (error: unknown) => error instanceof UzjamPresetFileError && error.code === "invalid-profile",
  );
});

test("preset filenames are portable and bounded", () => {
  assert.equal(uzjamPresetFilename("Beyerdynamic / Listening Room"), "uzjam-beyerdynamic-listening-room.uzjam.json");
  assert.equal(uzjamPresetFilename("🎧"), "uzjam-profile.uzjam.json");
  assert.ok(uzjamPresetFilename("x".repeat(200)).length <= 98);
});
