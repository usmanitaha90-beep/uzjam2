import type {
  ChannelMode,
  ClippingPolicy,
  EqFilter,
  FilterKind,
  HeadroomMode,
  UzjamProfile,
} from "./index.js";

type LegacyFilter = { type: string; f: number; g: number; q: number; ch: string };
export type LegacyV2State = {
  protection: "smooth" | "auto" | "unrestricted" | string;
  headroom: "auto" | "manual" | "off";
  preamp: number;
  limiter: boolean;
  bypass: boolean;
  filters: LegacyFilter[];
};

export interface CurrentV2Filter {
  id?: string;
  type?: string;
  kind?: string;
  frequency?: number;
  frequencyHz?: number;
  gain?: number;
  gainDb?: number;
  q?: number;
  channel?: string;
  enabled?: boolean;
}

export interface CurrentV2State {
  activeProfileId?: string;
  activeProfileName?: string;
  eqEnabled?: boolean;
  preampDb?: number;
  handling?: "auto" | "curve" | "smooth" | "clip" | string;
  headroomEnabled?: boolean;
  manualHeadroom?: number;
  truePeakGuard?: boolean;
  bands?: CurrentV2Filter[];
  toneBands?: CurrentV2Filter[];
}

const kindMap: Record<string, FilterKind> = {
  "Peak": "peak",
  "Low Shelf": "lowShelf",
  "High Shelf": "highShelf",
  "Low Pass": "lowPass",
  "High Pass": "highPass",
  "Notch": "notch",
  "Band Pass": "bandPass",
  "All Pass": "allPass",
};

function clippingPolicy(value: string): ClippingPolicy {
  if (value === "smooth") return "smooth";
  if (value === "unrestricted") return "allowClipping";
  return "auto";
}

const currentKindMap: Record<string, FilterKind> = {
  peak: "peak",
  peaking: "peak",
  bell: "peak",
  pk: "peak",
  lowshelf: "lowShelf",
  highshelf: "highShelf",
  lowpass: "lowPass",
  highpass: "highPass",
  notch: "notch",
  bandpass: "bandPass",
  allpass: "allPass",
};

function currentKind(value: string | undefined): FilterKind {
  const key = String(value ?? "peak").toLowerCase().replace(/[\s_-]/g, "");
  return currentKindMap[key] ?? "peak";
}

function currentChannel(value: string | undefined): ChannelMode {
  if (value === "left" || value === "L") return "left";
  if (value === "right" || value === "R") return "right";
  return "stereo";
}

function policySettings(state: CurrentV2State): {
  headroomMode: HeadroomMode;
  clippingPolicy: ClippingPolicy;
} {
  if (state.handling === "clip" || state.headroomEnabled === false) {
    return { headroomMode: "off", clippingPolicy: "allowClipping" };
  }
  if (state.handling === "smooth") {
    return { headroomMode: "manual", clippingPolicy: "smooth" };
  }
  if (state.handling === "curve") {
    return { headroomMode: "manual", clippingPolicy: "curve" };
  }
  return { headroomMode: "auto", clippingPolicy: "auto" };
}

/** Convert the persisted shape used by the current V2 browser UI. */
export function migrateCurrentV2State(
  state: CurrentV2State,
  nowUtc = new Date().toISOString(),
): UzjamProfile {
  const sourceFilters = [...(state.toneBands ?? []), ...(state.bands ?? [])];
  const filters: EqFilter[] = sourceFilters.map((filter, index) => {
    const frequency = Number(filter.frequencyHz ?? filter.frequency ?? 1000);
    const gain = Number(filter.gainDb ?? filter.gain ?? 0);
    const q = Number(filter.q ?? 0.707);
    return {
      id: filter.id?.trim() || `filter-${index + 1}`,
      enabled: filter.enabled !== false,
      kind: currentKind(filter.kind ?? filter.type),
      frequencyHz: Number.isFinite(frequency) && frequency > 0 ? frequency : 1000,
      gainDb: Number.isFinite(gain) ? gain : 0,
      q: Number.isFinite(q) && q > 0 ? q : 0.707,
      channel: currentChannel(filter.channel),
    };
  });
  const policy = policySettings(state);

  return {
    schemaVersion: 1,
    id: state.activeProfileId?.trim() || "v2-browser-profile",
    name: state.activeProfileName?.trim() || "UZjam V2 profile",
    filters,
    dsp: {
      enabled: state.eqEnabled !== false,
      preampDb: Number.isFinite(Number(state.preampDb)) ? Number(state.preampDb) : 0,
      headroomMode: policy.headroomMode,
      manualHeadroomDb: Math.max(0, Number(state.manualHeadroom) || 0),
      safetyMarginDb: state.truePeakGuard ? 1 : 0.3,
      clippingPolicy: policy.clippingPolicy,
      limiterEnabled: Boolean(state.truePeakGuard),
    },
    target: null,
    deviceBinding: null,
    metadata: {
      createdAtUtc: nowUtc,
      modifiedAtUtc: nowUtc,
      source: "uzjam-v2-browser-state",
    },
  };
}

export function migrateLegacyV2State(state: LegacyV2State, nowUtc = new Date().toISOString()): UzjamProfile {
  const filters: EqFilter[] = state.filters.map((filter, index) => ({
    id: `filter-${index + 1}`,
    enabled: true,
    kind: kindMap[filter.type] ?? "peak",
    frequencyHz: filter.f,
    gainDb: filter.g,
    q: filter.q,
    channel: filter.ch === "L" ? "left" : filter.ch === "R" ? "right" : "stereo",
  }));

  return {
    schemaVersion: 1,
    id: "legacy-v2-profile",
    name: "UZjam V2 migrated profile",
    filters,
    dsp: {
      enabled: !state.bypass,
      preampDb: state.preamp,
      headroomMode: state.headroom,
      manualHeadroomDb: Math.max(0, -state.preamp),
      safetyMarginDb: 0.3,
      clippingPolicy: clippingPolicy(state.protection),
      limiterEnabled: state.limiter,
    },
    target: null,
    deviceBinding: null,
    metadata: {
      createdAtUtc: nowUtc,
      modifiedAtUtc: nowUtc,
      source: "uzjam-v2-inline-state",
    },
  };
}
