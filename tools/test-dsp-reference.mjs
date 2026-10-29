import assert from "node:assert/strict";
import { magnitudeDb } from "./dsp-reference.mjs";

const peak={kind:"peak",frequencyHz:1000,gainDb:6,q:1};
assert.ok(Math.abs(magnitudeDb(peak,48000,1000)-6) < 1e-9, "peak center gain");

const notch={kind:"notch",frequencyHz:1000,gainDb:0,q:3};
assert.ok(magnitudeDb(notch,48000,1000) < -180, "notch center attenuation");

const allpass={kind:"allPass",frequencyHz:1000,gainDb:0,q:0.7};
for (const f of [20,100,1000,10000,20000]) {
  assert.ok(Math.abs(magnitudeDb(allpass,48000,f)) < 1e-9, `all-pass magnitude at ${f}`);
}

const lowShelf={kind:"lowShelf",frequencyHz:200,gainDb:6,q:0.2};
assert.ok(Math.abs(magnitudeDb(lowShelf,48000,0)-6) < 1e-9, "S=1 low-shelf asymptote");

const highShelf={kind:"highShelf",frequencyHz:4000,gainDb:-5,q:8};
assert.ok(Math.abs(magnitudeDb(highShelf,48000,24000)+5) < 1e-9, "S=1 high-shelf asymptote");

console.log("UZjam DSP reference checks passed");
