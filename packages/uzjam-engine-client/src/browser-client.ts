import type {
  ClippingPolicy,
  EngineAnalysis,
  EngineAnalysisRequest,
  EqFilter,
  FrequencyResponsePoint,
  FrequencyResponseRequest,
  HeadroomMode,
  PlatformCapabilities,
  UzjamEngineClient,
  UzjamProfile,
} from "@uzjam/contract";

import { analyzeProfile } from "./dsp.js";
import {
  assertClippingPolicy,
  assertFiniteNumber,
  assertHeadroomMode,
  validateAndCloneFilter,
  validateAndCloneProfile,
} from "./validation.js";

const BROWSER_CAPABILITIES: PlatformCapabilities = {
  systemWideEq: "unsupported",
  exclusiveMode: "unsupported",
  usbDirect: "unsupported",
  appSpecificEq: "supported",
  highResolutionAudio: "partial",
  deviceSwitching: "partial",
  channelRouting: "supported",
};

function cloneCapabilities(): PlatformCapabilities {
  return { ...BROWSER_CAPABILITIES };
}

function touched(profile: UzjamProfile): UzjamProfile {
  return {
    ...profile,
    metadata: {
      ...profile.metadata,
      modifiedAtUtc: new Date().toISOString(),
    },
  };
}

/**
 * Strict, deterministic browser implementation of the platform engine boundary.
 * It is the Web fallback until the native/WASM engine can satisfy this contract.
 */
export class BrowserUzjamEngineClient implements UzjamEngineClient {
  #profile: UzjamProfile;

  constructor(initialProfile: UzjamProfile) {
    this.#profile = validateAndCloneProfile(initialProfile);
  }

  getProfileSync(): UzjamProfile {
    return validateAndCloneProfile(this.#profile);
  }

  async getProfile(): Promise<UzjamProfile> {
    return this.getProfileSync();
  }

  replaceProfileSync(profile: UzjamProfile): UzjamProfile {
    this.#profile = validateAndCloneProfile(profile);
    return this.getProfileSync();
  }

  async replaceProfile(profile: UzjamProfile): Promise<UzjamProfile> {
    return this.replaceProfileSync(profile);
  }

  updateFilterSync(filter: EqFilter): UzjamProfile {
    const nextFilter = validateAndCloneFilter(filter);
    const index = this.#profile.filters.findIndex((candidate) => candidate.id === nextFilter.id);
    if (index < 0) throw new RangeError(`filter ${nextFilter.id} does not exist`);
    const next = this.getProfileSync();
    next.filters[index] = nextFilter;
    this.#profile = validateAndCloneProfile(touched(next));
    return this.getProfileSync();
  }

  async updateFilter(filter: EqFilter): Promise<UzjamProfile> {
    return this.updateFilterSync(filter);
  }

  addFilterSync(filter: EqFilter): UzjamProfile {
    const nextFilter = validateAndCloneFilter(filter);
    if (this.#profile.filters.some((candidate) => candidate.id === nextFilter.id)) {
      throw new RangeError(`filter ${nextFilter.id} already exists`);
    }
    const next = this.getProfileSync();
    next.filters.push(nextFilter);
    this.#profile = validateAndCloneProfile(touched(next));
    return this.getProfileSync();
  }

  async addFilter(filter: EqFilter): Promise<UzjamProfile> {
    return this.addFilterSync(filter);
  }

  removeFilterSync(filterId: string): UzjamProfile {
    if (typeof filterId !== "string" || filterId.trim().length === 0) {
      throw new TypeError("filterId must be a non-empty string");
    }
    const index = this.#profile.filters.findIndex((filter) => filter.id === filterId);
    if (index < 0) throw new RangeError(`filter ${filterId} does not exist`);
    const next = this.getProfileSync();
    next.filters.splice(index, 1);
    this.#profile = validateAndCloneProfile(touched(next));
    return this.getProfileSync();
  }

  async removeFilter(filterId: string): Promise<UzjamProfile> {
    return this.removeFilterSync(filterId);
  }

  setPreampSync(preampDb: number, mode: HeadroomMode): UzjamProfile {
    assertFiniteNumber(preampDb, "preampDb");
    assertHeadroomMode(mode);
    const next = this.getProfileSync();
    next.dsp.preampDb = preampDb;
    next.dsp.headroomMode = mode;
    this.#profile = validateAndCloneProfile(touched(next));
    return this.getProfileSync();
  }

  async setPreamp(preampDb: number, mode: HeadroomMode): Promise<UzjamProfile> {
    return this.setPreampSync(preampDb, mode);
  }

  setClippingPolicySync(policy: ClippingPolicy): UzjamProfile {
    assertClippingPolicy(policy);
    const next = this.getProfileSync();
    next.dsp.clippingPolicy = policy;
    this.#profile = validateAndCloneProfile(touched(next));
    return this.getProfileSync();
  }

  async setClippingPolicy(policy: ClippingPolicy): Promise<UzjamProfile> {
    return this.setClippingPolicySync(policy);
  }

  analyzeSync(request: EngineAnalysisRequest): EngineAnalysis {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw new TypeError("analysis request must be an object");
    }
    return analyzeProfile(this.#profile, request);
  }

  async analyze(request: EngineAnalysisRequest): Promise<EngineAnalysis> {
    return this.analyzeSync(request);
  }

  getFrequencyResponseSync(
    request: number | FrequencyResponseRequest,
  ): FrequencyResponsePoint[] {
    const normalizedRequest: FrequencyResponseRequest =
      typeof request === "number" ? { sampleRateHz: request } : request;
    const analysis = this.analyzeSync(normalizedRequest);
    const response =
      normalizedRequest.effective === false
        ? analysis.requestedResponse
        : analysis.effectiveResponse;
    const channel = normalizedRequest.channel ?? "stereo";
    return response[channel].map((point) => ({ ...point }));
  }

  async getFrequencyResponse(
    request: number | FrequencyResponseRequest,
  ): Promise<FrequencyResponsePoint[]> {
    return this.getFrequencyResponseSync(request);
  }

  getCapabilitiesSync(): PlatformCapabilities {
    return cloneCapabilities();
  }

  async getCapabilities(): Promise<PlatformCapabilities> {
    return this.getCapabilitiesSync();
  }
}
