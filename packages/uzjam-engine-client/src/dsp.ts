import type {
  ChannelFrequencyResponse,
  EngineAnalysis,
  EngineAnalysisRequest,
  EqFilter,
  FrequencyResponsePoint,
  ResponseChannel,
  UzjamProfile,
} from "@uzjam/contract";

const MIN_MAGNITUDE = 1e-12;
const MIN_FREQUENCY_HZ = 20;
const MAX_FREQUENCY_HZ = 20_000;
const DEFAULT_RESPONSE_POINTS = 360;
const HEADROOM_SCAN_POINTS = 1024;
const SMOOTHING_ITERATIONS = 24;

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function validateSampleRate(sampleRateHz: number): void {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= MIN_FREQUENCY_HZ * 2) {
    throw new RangeError(
      `sampleRateHz must be finite and greater than ${MIN_FREQUENCY_HZ * 2} Hz`,
    );
  }
}

function normalized(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): BiquadCoefficients {
  if (![b0, b1, b2, a0, a1, a2].every(Number.isFinite) || a0 === 0) {
    throw new RangeError("filter parameters produced invalid biquad coefficients");
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** RBJ Audio EQ Cookbook coefficients. Shelves intentionally use slope S=1. */
export function biquadCoefficients(
  filter: EqFilter,
  sampleRateHz: number,
  gainDb = filter.gainDb,
): BiquadCoefficients {
  validateSampleRate(sampleRateHz);
  if (
    !Number.isFinite(filter.frequencyHz) ||
    filter.frequencyHz <= 0 ||
    filter.frequencyHz >= sampleRateHz / 2
  ) {
    throw new RangeError(
      `filter ${filter.id} frequencyHz must be between 0 and the Nyquist frequency`,
    );
  }
  if (!Number.isFinite(filter.q) || filter.q <= 0) {
    throw new RangeError(`filter ${filter.id} q must be finite and greater than zero`);
  }
  if (!Number.isFinite(gainDb)) {
    throw new RangeError(`filter ${filter.id} gainDb must be finite`);
  }

  const w0 = (2 * Math.PI * filter.frequencyHz) / sampleRateHz;
  const cosine = Math.cos(w0);
  const sine = Math.sin(w0);
  const qAlpha = sine / (2 * filter.q);
  const amplitude = 10 ** (gainDb / 40);
  const squareRootAmplitude = Math.sqrt(amplitude);
  // Cookbook shelf alpha: sin(w0)/2 * sqrt((A + 1/A)(1/S - 1) + 2), S=1.
  const shelfAlpha = (sine / 2) * Math.SQRT2;

  switch (filter.kind) {
    case "peak":
      return normalized(
        1 + qAlpha * amplitude,
        -2 * cosine,
        1 - qAlpha * amplitude,
        1 + qAlpha / amplitude,
        -2 * cosine,
        1 - qAlpha / amplitude,
      );
    case "lowShelf":
      return normalized(
        amplitude *
          (amplitude + 1 - (amplitude - 1) * cosine + 2 * squareRootAmplitude * shelfAlpha),
        2 * amplitude * (amplitude - 1 - (amplitude + 1) * cosine),
        amplitude *
          (amplitude + 1 - (amplitude - 1) * cosine - 2 * squareRootAmplitude * shelfAlpha),
        amplitude + 1 + (amplitude - 1) * cosine + 2 * squareRootAmplitude * shelfAlpha,
        -2 * (amplitude - 1 + (amplitude + 1) * cosine),
        amplitude + 1 + (amplitude - 1) * cosine - 2 * squareRootAmplitude * shelfAlpha,
      );
    case "highShelf":
      return normalized(
        amplitude *
          (amplitude + 1 + (amplitude - 1) * cosine + 2 * squareRootAmplitude * shelfAlpha),
        -2 * amplitude * (amplitude - 1 + (amplitude + 1) * cosine),
        amplitude *
          (amplitude + 1 + (amplitude - 1) * cosine - 2 * squareRootAmplitude * shelfAlpha),
        amplitude + 1 - (amplitude - 1) * cosine + 2 * squareRootAmplitude * shelfAlpha,
        2 * (amplitude - 1 - (amplitude + 1) * cosine),
        amplitude + 1 - (amplitude - 1) * cosine - 2 * squareRootAmplitude * shelfAlpha,
      );
    case "lowPass":
      return normalized(
        (1 - cosine) / 2,
        1 - cosine,
        (1 - cosine) / 2,
        1 + qAlpha,
        -2 * cosine,
        1 - qAlpha,
      );
    case "highPass":
      return normalized(
        (1 + cosine) / 2,
        -(1 + cosine),
        (1 + cosine) / 2,
        1 + qAlpha,
        -2 * cosine,
        1 - qAlpha,
      );
    case "notch":
      return normalized(1, -2 * cosine, 1, 1 + qAlpha, -2 * cosine, 1 - qAlpha);
    case "bandPass":
      return normalized(qAlpha, 0, -qAlpha, 1 + qAlpha, -2 * cosine, 1 - qAlpha);
    case "allPass":
      return normalized(
        1 - qAlpha,
        -2 * cosine,
        1 + qAlpha,
        1 + qAlpha,
        -2 * cosine,
        1 - qAlpha,
      );
  }
}

export function coefficientMagnitudeDb(
  coefficients: BiquadCoefficients,
  frequencyHz: number,
  sampleRateHz: number,
): number {
  if (!Number.isFinite(frequencyHz) || frequencyHz < 0 || frequencyHz > sampleRateHz / 2) {
    throw new RangeError("frequencyHz must be finite and between 0 and Nyquist");
  }
  const omega = (2 * Math.PI * frequencyHz) / sampleRateHz;
  const z1Real = Math.cos(omega);
  const z1Imaginary = -Math.sin(omega);
  const z2Real = Math.cos(2 * omega);
  const z2Imaginary = -Math.sin(2 * omega);
  const numeratorReal =
    coefficients.b0 + coefficients.b1 * z1Real + coefficients.b2 * z2Real;
  const numeratorImaginary = coefficients.b1 * z1Imaginary + coefficients.b2 * z2Imaginary;
  const denominatorReal = 1 + coefficients.a1 * z1Real + coefficients.a2 * z2Real;
  const denominatorImaginary =
    coefficients.a1 * z1Imaginary + coefficients.a2 * z2Imaginary;
  const numerator = Math.max(MIN_MAGNITUDE, Math.hypot(numeratorReal, numeratorImaginary));
  const denominator = Math.max(
    MIN_MAGNITUDE,
    Math.hypot(denominatorReal, denominatorImaginary),
  );
  return 20 * Math.log10(numerator / denominator);
}

export function filterMagnitudeDb(
  filter: EqFilter,
  sampleRateHz: number,
  frequencyHz: number,
  gainDb = filter.gainDb,
): number {
  return coefficientMagnitudeDb(
    biquadCoefficients(filter, sampleRateHz, gainDb),
    frequencyHz,
    sampleRateHz,
  );
}

function logFrequencyGrid(sampleRateHz: number, pointCount: number): number[] {
  const maximumFrequency = Math.min(MAX_FREQUENCY_HZ, sampleRateHz * 0.5 * 0.999);
  const ratio = maximumFrequency / MIN_FREQUENCY_HZ;
  return Array.from({ length: pointCount }, (_, index) => {
    const position = index / (pointCount - 1);
    return MIN_FREQUENCY_HZ * ratio ** position;
  });
}

function channelIncludes(filter: EqFilter, channel: Exclude<ResponseChannel, "stereo">): boolean {
  return filter.channel === "stereo" || filter.channel === channel;
}

function effectiveGain(filter: EqFilter, smoothingFactor: number): number {
  return filter.gainDb > 0 ? filter.gainDb * smoothingFactor : filter.gainDb;
}

interface PreparedFilter {
  filter: EqFilter;
  coefficients: BiquadCoefficients;
}

function prepareFilters(
  filters: readonly EqFilter[],
  sampleRateHz: number,
  smoothingFactor: number,
): PreparedFilter[] {
  return filters.map((filter) => ({
    filter,
    coefficients: biquadCoefficients(filter, sampleRateHz, effectiveGain(filter, smoothingFactor)),
  }));
}

function channelSeries(
  filters: readonly PreparedFilter[],
  frequencies: readonly number[],
  channel: Exclude<ResponseChannel, "stereo">,
  sampleRateHz: number,
): FrequencyResponsePoint[] {
  return frequencies.map((frequencyHz) => {
    let magnitudeDb = 0;
    for (const prepared of filters) {
      if (channelIncludes(prepared.filter, channel)) {
        magnitudeDb += coefficientMagnitudeDb(prepared.coefficients, frequencyHz, sampleRateHz);
      }
    }
    return { frequencyHz, magnitudeDb };
  });
}

function responses(
  filters: readonly EqFilter[],
  frequencies: readonly number[],
  sampleRateHz: number,
  smoothingFactor: number,
): ChannelFrequencyResponse {
  const prepared = prepareFilters(filters, sampleRateHz, smoothingFactor);
  const left = channelSeries(prepared, frequencies, "left", sampleRateHz);
  const right = channelSeries(prepared, frequencies, "right", sampleRateHz);
  const stereo = left.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    magnitudeDb: (point.magnitudeDb + right[index]!.magnitudeDb) / 2,
  }));
  return { left, right, stereo };
}

function responsePeak(response: ChannelFrequencyResponse): number {
  let peak = 0;
  for (const point of response.left) peak = Math.max(peak, point.magnitudeDb);
  for (const point of response.right) peak = Math.max(peak, point.magnitudeDb);
  return peak;
}

function headroomFrequencies(
  activeFilters: readonly EqFilter[],
  sampleRateHz: number,
  requestedPointCount: number,
): number[] {
  const frequencies = logFrequencyGrid(
    sampleRateHz,
    Math.max(HEADROOM_SCAN_POINTS, requestedPointCount),
  );
  const maximumFrequency = frequencies[frequencies.length - 1]!;
  for (const filter of activeFilters) {
    if (filter.frequencyHz >= MIN_FREQUENCY_HZ && filter.frequencyHz <= maximumFrequency) {
      frequencies.push(filter.frequencyHz);
    }
  }
  return [...new Set(frequencies)].sort((a, b) => a - b);
}

function pointCount(request: EngineAnalysisRequest): number {
  const result = request.pointCount ?? DEFAULT_RESPONSE_POINTS;
  if (!Number.isInteger(result) || result < 2) {
    throw new RangeError("pointCount must be an integer greater than or equal to 2");
  }
  return result;
}

function activeFilters(profile: UzjamProfile, auditionFilterId?: string | null): EqFilter[] {
  if (auditionFilterId !== undefined && auditionFilterId !== null) {
    if (typeof auditionFilterId !== "string" || auditionFilterId.trim().length === 0) {
      throw new TypeError("auditionFilterId must be a non-empty string or null");
    }
  }
  return profile.filters.filter(
    (filter) =>
      filter.enabled &&
      (auditionFilterId === undefined ||
        auditionFilterId === null ||
        filter.id === auditionFilterId),
  );
}

function flatResponse(frequencies: readonly number[]): ChannelFrequencyResponse {
  const make = (): FrequencyResponsePoint[] =>
    frequencies.map((frequencyHz) => ({ frequencyHz, magnitudeDb: 0 }));
  return { left: make(), right: make(), stereo: make() };
}

function smoothingFactor(
  filters: readonly EqFilter[],
  frequencies: readonly number[],
  sampleRateHz: number,
  preampDb: number,
  targetCurvePeakDb: number,
  requestedCurvePeakDb: number,
): number {
  if (requestedCurvePeakDb <= targetCurvePeakDb + 1e-9) return 1;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < SMOOTHING_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    const peak = Math.max(0, responsePeak(responses(filters, frequencies, sampleRateHz, middle)) + preampDb);
    if (peak > targetCurvePeakDb) high = middle;
    else low = middle;
  }
  return low;
}

/** Pure browser fallback analysis used by BrowserUzjamEngineClient. */
export function analyzeProfile(
  profile: UzjamProfile,
  request: EngineAnalysisRequest,
): EngineAnalysis {
  validateSampleRate(request.sampleRateHz);
  if (request.bypass !== undefined && typeof request.bypass !== "boolean") {
    throw new TypeError("bypass must be a boolean when provided");
  }
  const count = pointCount(request);
  const displayFrequencies = logFrequencyGrid(request.sampleRateHz, count);
  const bypassed = !profile.dsp.enabled || request.bypass === true;
  const selectedFilters = bypassed ? [] : activeFilters(profile, request.auditionFilterId);

  if (bypassed) {
    const requestedResponse = flatResponse(displayFrequencies);
    const effectiveResponse = flatResponse(displayFrequencies);
    return {
      sampleRateHz: request.sampleRateHz,
      requestedResponse,
      effectiveResponse,
      headroom: {
        maximumEqGainDb: 0,
        requestedCurvePeakDb: 0,
        effectiveCurvePeakDb: 0,
        requiredHeadroomDb: 0,
        appliedHeadroomDb: 0,
        effectivePreampDb: 0,
        effectivePreampLinear: 1,
        remainingMarginDb: 0,
        predictedOverDb: 0,
        smoothingFactor: 1,
        safetyMarginDb: profile.dsp.safetyMarginDb,
      },
      effectiveFilters: profile.filters.map((filter) => ({ id: filter.id, gainDb: 0 })),
    };
  }

  const scanFrequencies = headroomFrequencies(selectedFilters, request.sampleRateHz, count);
  const requestedScan = responses(selectedFilters, scanFrequencies, request.sampleRateHz, 1);
  const maximumEqGainDb = responsePeak(requestedScan);
  const requestedCurvePeakDb = Math.max(0, maximumEqGainDb + profile.dsp.preampDb);
  const requiredHeadroomDb = Math.max(
    0,
    requestedCurvePeakDb + profile.dsp.safetyMarginDb,
  );

  const protectionOff =
    profile.dsp.headroomMode === "off" || profile.dsp.clippingPolicy === "allowClipping";
  let appliedHeadroomDb = 0;
  if (!protectionOff) {
    if (
      profile.dsp.clippingPolicy === "smooth" ||
      profile.dsp.clippingPolicy === "curve" ||
      profile.dsp.headroomMode === "manual"
    ) {
      appliedHeadroomDb = profile.dsp.manualHeadroomDb;
    } else {
      appliedHeadroomDb = requiredHeadroomDb;
    }
  }

  let scale = 1;
  if (!protectionOff && profile.dsp.clippingPolicy === "smooth") {
    scale = smoothingFactor(
      selectedFilters,
      scanFrequencies,
      request.sampleRateHz,
      profile.dsp.preampDb,
      Math.max(0, appliedHeadroomDb - profile.dsp.safetyMarginDb),
      requestedCurvePeakDb,
    );
  }

  const effectiveScan =
    scale === 1
      ? requestedScan
      : responses(selectedFilters, scanFrequencies, request.sampleRateHz, scale);
  const effectiveCurvePeakDb = Math.max(
    0,
    responsePeak(effectiveScan) + profile.dsp.preampDb,
  );
  const remainingMarginDb = appliedHeadroomDb - effectiveCurvePeakDb;
  const effectivePreampDb = profile.dsp.preampDb - appliedHeadroomDb;
  const requestedResponse = responses(selectedFilters, displayFrequencies, request.sampleRateHz, 1);
  const effectiveResponse =
    scale === 1
      ? requestedResponse
      : responses(selectedFilters, displayFrequencies, request.sampleRateHz, scale);
  const selectedIds = new Set(selectedFilters.map((filter) => filter.id));

  return {
    sampleRateHz: request.sampleRateHz,
    requestedResponse,
    effectiveResponse,
    headroom: {
      maximumEqGainDb,
      requestedCurvePeakDb,
      effectiveCurvePeakDb,
      requiredHeadroomDb,
      appliedHeadroomDb,
      effectivePreampDb,
      effectivePreampLinear: 10 ** (effectivePreampDb / 20),
      remainingMarginDb,
      predictedOverDb: Math.max(0, -remainingMarginDb),
      smoothingFactor: scale,
      safetyMarginDb: profile.dsp.safetyMarginDb,
    },
    effectiveFilters: profile.filters.map((filter) => ({
      id: filter.id,
      gainDb:
        filter.enabled && selectedIds.has(filter.id) ? effectiveGain(filter, scale) : 0,
    })),
  };
}
