import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/web/src/app.js", import.meta.url), "utf8");
const forbidden = [
  "rbjCoefficients",
  "coefficientMagnitudeDb",
  "responseAt",
  "responseSeries",
  "rawCurvePeak",
  "smoothingFactor(",
  "derivedSafety",
];

for (const name of forbidden) {
  assert.equal(source.includes(name), false, `frontend owns forbidden DSP helper: ${name}`);
}

assert.match(source, /BrowserUzjamEngineClient/);
assert.match(source, /analysis\.effectiveResponse/);
assert.match(source, /\.headroom/);

console.log("Frontend boundary check passed: response and headroom are engine-owned.");
