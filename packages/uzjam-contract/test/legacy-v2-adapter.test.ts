import assert from "node:assert/strict";
import test from "node:test";

import { migrateCurrentV2State, migrateLegacyV2State } from "@uzjam/contract";

test("public contract exports both V2 migration adapters", () => {
  assert.equal(typeof migrateCurrentV2State, "function");
  assert.equal(typeof migrateLegacyV2State, "function");
});

test("current V2 state keeps tone and advanced filters in one canonical profile", () => {
  const profile = migrateCurrentV2State(
    {
      activeProfileId: "profile-edition-xs",
      activeProfileName: "HIFIMAN Edition XS",
      eqEnabled: true,
      preampDb: 1.5,
      handling: "curve",
      headroomEnabled: true,
      manualHeadroom: 5.5,
      truePeakGuard: true,
      toneBands: [
        { id: "tone-sub", type: "lowshelf", frequency: 55, gain: 2, q: 0.707, channel: "both", enabled: true },
      ],
      bands: [
        { id: "b1", type: "peaking", frequency: 1000, gain: 6, q: 1, channel: "left", enabled: true },
      ],
    },
    "2026-10-04T00:00:00.000Z",
  );

  assert.equal(profile.id, "profile-edition-xs");
  assert.equal(profile.filters.length, 2);
  assert.deepEqual(profile.filters[0], {
    id: "tone-sub",
    enabled: true,
    kind: "lowShelf",
    frequencyHz: 55,
    gainDb: 2,
    q: 0.707,
    channel: "stereo",
  });
  assert.equal(profile.filters[1]?.kind, "peak");
  assert.equal(profile.filters[1]?.channel, "left");
  assert.equal(profile.dsp.preampDb, 1.5);
  assert.equal(profile.dsp.manualHeadroomDb, 5.5);
  assert.equal(profile.dsp.headroomMode, "manual");
  assert.equal(profile.dsp.clippingPolicy, "curve");
  assert.equal(profile.dsp.safetyMarginDb, 1);
  assert.equal(profile.dsp.limiterEnabled, true);
});

test("allow clipping maps to off headroom without losing the user preamp", () => {
  const profile = migrateCurrentV2State({
    eqEnabled: true,
    preampDb: -2,
    handling: "clip",
    headroomEnabled: false,
    manualHeadroom: 7,
    bands: [{ id: "b1", type: "peaking", frequency: 1000, gain: 3, q: 1, channel: "both" }],
  });

  assert.equal(profile.dsp.preampDb, -2);
  assert.equal(profile.dsp.manualHeadroomDb, 7);
  assert.equal(profile.dsp.headroomMode, "off");
  assert.equal(profile.dsp.clippingPolicy, "allowClipping");
});
