import assert from "node:assert/strict";
import test from "node:test";

import type { EqFilter, UzjamProfile } from "../../uzjam-contract/src/index.js";
import {
  BrowserUzjamEngineClient,
  filterMagnitudeDb,
  UzjamProfileValidationError,
} from "../src/index.js";

function peak(
  id: string,
  gainDb: number,
  frequencyHz = 1_000,
  channel: EqFilter["channel"] = "stereo",
): EqFilter {
  return {
    id,
    enabled: true,
    kind: "peak",
    frequencyHz,
    gainDb,
    q: 1,
    channel,
  };
}

function profile(filters: EqFilter[] = []): UzjamProfile {
  return {
    schemaVersion: 1,
    id: "test-profile",
    name: "Test profile",
    filters,
    dsp: {
      enabled: true,
      preampDb: 0,
      headroomMode: "auto",
      manualHeadroomDb: 4,
      safetyMarginDb: 0.3,
      clippingPolicy: "auto",
      limiterEnabled: false,
    },
    target: null,
    deviceBinding: null,
    metadata: {
      createdAtUtc: "2026-10-04T00:00:00.000Z",
      modifiedAtUtc: "2026-10-04T00:00:00.000Z",
      source: "test",
    },
  };
}

function closeTo(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("owns validated clones rather than caller objects", async () => {
  const initial = profile([peak("one", 6)]);
  const client = new BrowserUzjamEngineClient(initial);
  initial.filters[0]!.gainDb = 100;

  const firstRead = client.getProfileSync();
  assert.equal(firstRead.filters[0]!.gainDb, 6);
  firstRead.filters[0]!.gainDb = 50;
  assert.equal((await client.getProfile()).filters[0]!.gainDb, 6);

  const invalid = profile([peak("duplicate", 1), peak("duplicate", 2)]);
  assert.throws(() => new BrowserUzjamEngineClient(invalid), UzjamProfileValidationError);
});

test("RBJ peak and S=1 shelves reach their requested asymptotic gains", () => {
  closeTo(filterMagnitudeDb(peak("center", 6), 48_000, 1_000), 6, 1e-9);
  const lowShelf: EqFilter = { ...peak("low", 6, 200), kind: "lowShelf" };
  const highShelf: EqFilter = { ...peak("high", -5, 4_000), kind: "highShelf" };
  closeTo(filterMagnitudeDb(lowShelf, 48_000, 0), 6, 1e-9);
  closeTo(filterMagnitudeDb(highShelf, 48_000, 24_000), -5, 1e-9);
});

test("auto headroom uses the cascaded L/R peak plus independent preamp and safety", () => {
  const input = profile([peak("one", 6), peak("two", 3)]);
  input.dsp.preampDb = 1;
  const analysis = new BrowserUzjamEngineClient(input).analyzeSync({
    sampleRateHz: 48_000,
    pointCount: 37,
  });

  closeTo(analysis.headroom.maximumEqGainDb, 9, 1e-8);
  closeTo(analysis.headroom.requestedCurvePeakDb, 10, 1e-8);
  closeTo(analysis.headroom.requiredHeadroomDb, 10.3, 1e-8);
  closeTo(analysis.headroom.appliedHeadroomDb, 10.3, 1e-8);
  closeTo(analysis.headroom.effectivePreampDb, -9.3, 1e-8);
  closeTo(analysis.headroom.effectivePreampLinear, 10 ** (-9.3 / 20), 1e-12);
  closeTo(analysis.headroom.remainingMarginDb, 0.3, 1e-8);
  closeTo(analysis.headroom.predictedOverDb, 0, 1e-12);
});

test("stereo response is the dB average of independent left and right responses", () => {
  const input = profile([peak("left-only", 6, 1_000, "left")]);
  const analysis = new BrowserUzjamEngineClient(input).analyzeSync({
    sampleRateHz: 48_000,
    pointCount: 19,
  });

  analysis.requestedResponse.stereo.forEach((point, index) => {
    closeTo(
      point.magnitudeDb,
      (analysis.requestedResponse.left[index]!.magnitudeDb +
        analysis.requestedResponse.right[index]!.magnitudeDb) /
        2,
      1e-12,
    );
    closeTo(analysis.requestedResponse.right[index]!.magnitudeDb, 0, 1e-12);
  });
});

test("manual curve preserves filters while applying exactly the manual headroom", () => {
  const input = profile([peak("boost", 8)]);
  input.dsp.headroomMode = "manual";
  input.dsp.clippingPolicy = "curve";
  input.dsp.manualHeadroomDb = 3;
  const analysis = new BrowserUzjamEngineClient(input).analyzeSync({ sampleRateHz: 48_000 });

  assert.equal(analysis.headroom.appliedHeadroomDb, 3);
  assert.equal(analysis.headroom.smoothingFactor, 1);
  closeTo(analysis.effectiveFilters[0]!.gainDb, 8);
  assert.ok(analysis.headroom.predictedOverDb > 4.9);
});

test("smooth uses the manual budget and scales only positive gains", () => {
  const input = profile([peak("boost", 12), peak("cut", -6, 4_000)]);
  input.dsp.headroomMode = "manual";
  input.dsp.clippingPolicy = "smooth";
  input.dsp.manualHeadroomDb = 4;
  const analysis = new BrowserUzjamEngineClient(input).analyzeSync({ sampleRateHz: 48_000 });

  assert.equal(analysis.headroom.appliedHeadroomDb, 4);
  assert.ok(analysis.headroom.smoothingFactor > 0);
  assert.ok(analysis.headroom.smoothingFactor < 1);
  closeTo(
    analysis.effectiveFilters.find((filter) => filter.id === "boost")!.gainDb,
    12 * analysis.headroom.smoothingFactor,
    1e-12,
  );
  closeTo(analysis.effectiveFilters.find((filter) => filter.id === "cut")!.gainDb, -6);
  assert.ok(analysis.headroom.remainingMarginDb >= 0.29999);
  assert.equal(analysis.headroom.predictedOverDb, 0);
});

test("allow-clipping and headroom-off both force zero attenuation", () => {
  const clipping = profile([peak("boost", 8)]);
  clipping.dsp.headroomMode = "manual";
  clipping.dsp.clippingPolicy = "allowClipping";
  clipping.dsp.manualHeadroomDb = 12;
  const clippingAnalysis = new BrowserUzjamEngineClient(clipping).analyzeSync({
    sampleRateHz: 48_000,
  });
  assert.equal(clippingAnalysis.headroom.appliedHeadroomDb, 0);
  assert.equal(clippingAnalysis.headroom.smoothingFactor, 1);
  assert.ok(clippingAnalysis.headroom.predictedOverDb > 7.9);

  const off = profile([peak("boost", 8)]);
  off.dsp.headroomMode = "off";
  off.dsp.clippingPolicy = "smooth";
  assert.equal(
    new BrowserUzjamEngineClient(off).analyzeSync({ sampleRateHz: 48_000 }).headroom
      .appliedHeadroomDb,
    0,
  );
});

test("transient bypass is flat and does not mutate the stored profile", () => {
  const client = new BrowserUzjamEngineClient(profile([peak("boost", 9)]));
  const analysis = client.analyzeSync({ sampleRateHz: 48_000, pointCount: 13, bypass: true });
  for (const channel of ["left", "right", "stereo"] as const) {
    assert.ok(analysis.requestedResponse[channel].every((point) => point.magnitudeDb === 0));
    assert.ok(analysis.effectiveResponse[channel].every((point) => point.magnitudeDb === 0));
  }
  assert.equal(analysis.headroom.appliedHeadroomDb, 0);
  assert.equal(analysis.headroom.effectivePreampLinear, 1);
  assert.equal(analysis.effectiveFilters[0]!.gainDb, 0);
  assert.equal(client.getProfileSync().dsp.enabled, true);
  assert.equal(client.getProfileSync().filters[0]!.gainDb, 9);
});

test("auditionFilterId analyzes only that enabled filter", () => {
  const client = new BrowserUzjamEngineClient(profile([peak("one", 6), peak("two", 3)]));
  const all = client.analyzeSync({ sampleRateHz: 48_000 });
  const audition = client.analyzeSync({ sampleRateHz: 48_000, auditionFilterId: "one" });
  closeTo(all.headroom.maximumEqGainDb, 9, 1e-8);
  closeTo(audition.headroom.maximumEqGainDb, 6, 1e-8);
  assert.equal(audition.effectiveFilters.find((filter) => filter.id === "two")!.gainDb, 0);
  assert.equal(client.getProfileSync().filters.length, 2);
});

test("implements mutation, response, and capability methods", async () => {
  const client = new BrowserUzjamEngineClient(profile());
  await client.addFilter(peak("one", 4));
  await client.updateFilter(peak("one", 5));
  await client.setPreamp(-2, "manual");
  await client.setClippingPolicy("curve");
  assert.equal((await client.getProfile()).filters[0]!.gainDb, 5);
  assert.equal((await client.getProfile()).dsp.preampDb, -2);

  const requested = await client.getFrequencyResponse({
    sampleRateHz: 48_000,
    pointCount: 17,
    channel: "left",
    effective: false,
  });
  assert.equal(requested.length, 17);
  assert.equal((await client.getCapabilities()).appSpecificEq, "supported");
  assert.equal((await client.removeFilter("one")).filters.length, 0);
});
