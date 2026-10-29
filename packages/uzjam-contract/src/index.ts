/**
 * Frontend mirror of uzjam-core's serialized contract.
 * Rust remains the long-term source of truth; JSON uses camelCase.
 */
export type FilterKind =
  | "peak"
  | "lowShelf"
  | "highShelf"
  | "lowPass"
  | "highPass"
  | "notch"
  | "bandPass"
  | "allPass";

export type ChannelMode = "stereo" | "left" | "right";
export type HeadroomMode = "auto" | "manual" | "off";
export type ClippingPolicy = "auto" | "smooth" | "curve" | "allowClipping";

export interface EqFilter {
  id: string;
  enabled: boolean;
  kind: FilterKind;
  frequencyHz: number;
  gainDb: number;
  q: number;
  channel: ChannelMode;
}

export interface DspSettings {
  enabled: boolean;
  /** User-authored gain applied before protection. */
  preampDb: number;
  headroomMode: HeadroomMode;
  /** Positive attenuation budget used by manual and smooth policies. */
  manualHeadroomDb: number;
  safetyMarginDb: number;
  clippingPolicy: ClippingPolicy;
  limiterEnabled: boolean;
}

export interface TargetRef {
  id: string;
  name: string;
  correctionStrength: number;
}

export interface DeviceBinding {
  headphoneId?: string | null;
  outputDeviceId?: string | null;
}

export interface ProfileMetadata {
  createdAtUtc: string;
  modifiedAtUtc: string;
  source?: string | null;
}

export interface UzjamProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  filters: EqFilter[];
  dsp: DspSettings;
  target?: TargetRef | null;
  deviceBinding?: DeviceBinding | null;
  metadata: ProfileMetadata;
}

export type SupportLevel = "supported" | "partial" | "unsupported" | "unknown";

export interface PlatformCapabilities {
  systemWideEq: SupportLevel;
  exclusiveMode: SupportLevel;
  usbDirect: SupportLevel;
  appSpecificEq: SupportLevel;
  highResolutionAudio: SupportLevel;
  deviceSwitching: SupportLevel;
  channelRouting: SupportLevel;
}

export interface FrequencyResponsePoint {
  frequencyHz: number;
  magnitudeDb: number;
}

export type ResponseChannel = "stereo" | "left" | "right";

export interface EngineAnalysisRequest {
  sampleRateHz: number;
  pointCount?: number;
  /** Transient A/B bypass; never written back into the profile. */
  bypass?: boolean;
  /** A non-persistent audition state used by the UI's Solo control. */
  auditionFilterId?: string | null;
}

export interface ChannelFrequencyResponse {
  left: FrequencyResponsePoint[];
  right: FrequencyResponsePoint[];
  /** Visual composite: the arithmetic mean of left/right magnitude in dB. */
  stereo: FrequencyResponsePoint[];
}

export interface HeadroomAnalysis {
  /** Largest requested filter-cascade gain, excluding preamp/headroom. */
  maximumEqGainDb: number;
  /** Requested filter peak plus the user's independent preamp, floored at 0 dB. */
  requestedCurvePeakDb: number;
  /** Effective peak after any positive-gain smoothing, before headroom. */
  effectiveCurvePeakDb: number;
  requiredHeadroomDb: number;
  appliedHeadroomDb: number;
  /** User preamp minus the engine-selected headroom attenuation. */
  effectivePreampDb: number;
  /** Linear form supplied for realtime backends such as Web Audio. */
  effectivePreampLinear: number;
  remainingMarginDb: number;
  predictedOverDb: number;
  smoothingFactor: number;
  safetyMarginDb: number;
}

export interface EffectiveFilter {
  id: string;
  gainDb: number;
}

export interface EngineAnalysis {
  sampleRateHz: number;
  requestedResponse: ChannelFrequencyResponse;
  effectiveResponse: ChannelFrequencyResponse;
  headroom: HeadroomAnalysis;
  effectiveFilters: EffectiveFilter[];
}

export interface FrequencyResponseRequest extends EngineAnalysisRequest {
  channel?: ResponseChannel;
  effective?: boolean;
}

/** UI talks to this boundary. It does not calculate DSP itself. */
export interface UzjamEngineClient {
  getProfile(): Promise<UzjamProfile>;
  replaceProfile(profile: UzjamProfile): Promise<UzjamProfile>;
  updateFilter(filter: EqFilter): Promise<UzjamProfile>;
  addFilter(filter: EqFilter): Promise<UzjamProfile>;
  removeFilter(filterId: string): Promise<UzjamProfile>;
  setPreamp(preampDb: number, mode: HeadroomMode): Promise<UzjamProfile>;
  setClippingPolicy(policy: ClippingPolicy): Promise<UzjamProfile>;
  analyze(request: EngineAnalysisRequest): Promise<EngineAnalysis>;
  getFrequencyResponse(request: number | FrequencyResponseRequest): Promise<FrequencyResponsePoint[]>;
  getCapabilities(): Promise<PlatformCapabilities>;
}

export {
  migrateCurrentV2State,
  migrateLegacyV2State,
  type CurrentV2State,
  type LegacyV2State,
} from "./legacy-v2-adapter.js";
