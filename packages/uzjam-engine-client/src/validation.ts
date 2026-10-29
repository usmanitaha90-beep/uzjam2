import type {
  ChannelMode,
  ClippingPolicy,
  DeviceBinding,
  DspSettings,
  EqFilter,
  FilterKind,
  HeadroomMode,
  ProfileMetadata,
  TargetRef,
  UzjamProfile,
} from "@uzjam/contract";

const FILTER_KINDS = new Set<FilterKind>([
  "peak",
  "lowShelf",
  "highShelf",
  "lowPass",
  "highPass",
  "notch",
  "bandPass",
  "allPass",
]);
const CHANNEL_MODES = new Set<ChannelMode>(["stereo", "left", "right"]);
const HEADROOM_MODES = new Set<HeadroomMode>(["auto", "manual", "off"]);
const CLIPPING_POLICIES = new Set<ClippingPolicy>([
  "auto",
  "smooth",
  "curve",
  "allowClipping",
]);

export class UzjamProfileValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "UzjamProfileValidationError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new UzjamProfileValidationError(path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    fail(path, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a finite number");
  }
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0) fail(path, "must be greater than or equal to zero");
  return result;
}

function enumValue<T extends string>(
  value: unknown,
  choices: ReadonlySet<T>,
  path: string,
): T {
  if (typeof value !== "string" || !choices.has(value as T)) {
    fail(path, `must be one of ${[...choices].join(", ")}`);
  }
  return value as T;
}

export function validateAndCloneFilter(value: EqFilter, path = "filter"): EqFilter {
  const input = record(value, path);
  const frequencyHz = finiteNumber(input.frequencyHz, `${path}.frequencyHz`);
  if (frequencyHz <= 0) fail(`${path}.frequencyHz`, "must be greater than zero");
  const q = finiteNumber(input.q, `${path}.q`);
  if (q <= 0) fail(`${path}.q`, "must be greater than zero");

  return {
    id: stringValue(input.id, `${path}.id`),
    enabled: booleanValue(input.enabled, `${path}.enabled`),
    kind: enumValue(input.kind, FILTER_KINDS, `${path}.kind`),
    frequencyHz,
    gainDb: finiteNumber(input.gainDb, `${path}.gainDb`),
    q,
    channel: enumValue(input.channel, CHANNEL_MODES, `${path}.channel`),
  };
}

function cloneDsp(value: unknown): DspSettings {
  const input = record(value, "dsp");
  return {
    enabled: booleanValue(input.enabled, "dsp.enabled"),
    preampDb: finiteNumber(input.preampDb, "dsp.preampDb"),
    headroomMode: enumValue(input.headroomMode, HEADROOM_MODES, "dsp.headroomMode"),
    manualHeadroomDb: nonNegativeNumber(input.manualHeadroomDb, "dsp.manualHeadroomDb"),
    safetyMarginDb: nonNegativeNumber(input.safetyMarginDb, "dsp.safetyMarginDb"),
    clippingPolicy: enumValue(
      input.clippingPolicy,
      CLIPPING_POLICIES,
      "dsp.clippingPolicy",
    ),
    limiterEnabled: booleanValue(input.limiterEnabled, "dsp.limiterEnabled"),
  };
}

function cloneTarget(value: unknown): TargetRef | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const input = record(value, "target");
  return {
    id: stringValue(input.id, "target.id"),
    name: stringValue(input.name, "target.name"),
    correctionStrength: finiteNumber(input.correctionStrength, "target.correctionStrength"),
  };
}

function optionalNullableString(value: unknown, path: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return stringValue(value, path);
}

function cloneDeviceBinding(value: unknown): DeviceBinding | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const input = record(value, "deviceBinding");
  const result: DeviceBinding = {};
  const headphoneId = optionalNullableString(input.headphoneId, "deviceBinding.headphoneId");
  const outputDeviceId = optionalNullableString(
    input.outputDeviceId,
    "deviceBinding.outputDeviceId",
  );
  if (headphoneId !== undefined) result.headphoneId = headphoneId;
  if (outputDeviceId !== undefined) result.outputDeviceId = outputDeviceId;
  return result;
}

function cloneMetadata(value: unknown): ProfileMetadata {
  const input = record(value, "metadata");
  const result: ProfileMetadata = {
    createdAtUtc: stringValue(input.createdAtUtc, "metadata.createdAtUtc"),
    modifiedAtUtc: stringValue(input.modifiedAtUtc, "metadata.modifiedAtUtc"),
  };
  const source = optionalNullableString(input.source, "metadata.source");
  if (source !== undefined) result.source = source;
  return result;
}

/**
 * Runtime-validates the serialized profile boundary and returns an isolated,
 * canonical clone. Unknown object properties are deliberately not retained.
 */
export function validateAndCloneProfile(value: UzjamProfile): UzjamProfile {
  const input = record(value, "profile");
  if (input.schemaVersion !== 1) {
    fail("schemaVersion", "must be the supported canonical schema version 1");
  }
  if (!Array.isArray(input.filters)) fail("filters", "must be an array");

  const filters = input.filters.map((filter, index) =>
    validateAndCloneFilter(filter as EqFilter, `filters[${index}]`),
  );
  const filterIds = new Set<string>();
  for (let index = 0; index < filters.length; index += 1) {
    const id = filters[index]!.id;
    if (filterIds.has(id)) fail(`filters[${index}].id`, "must be unique within the profile");
    filterIds.add(id);
  }

  const result: UzjamProfile = {
    schemaVersion: 1,
    id: stringValue(input.id, "id"),
    name: stringValue(input.name, "name"),
    filters,
    dsp: cloneDsp(input.dsp),
    metadata: cloneMetadata(input.metadata),
  };
  const target = cloneTarget(input.target);
  const deviceBinding = cloneDeviceBinding(input.deviceBinding);
  if (target !== undefined) result.target = target;
  if (deviceBinding !== undefined) result.deviceBinding = deviceBinding;
  return result;
}

export function assertFiniteNumber(value: number, path: string): void {
  finiteNumber(value, path);
}

export function assertHeadroomMode(value: HeadroomMode): void {
  enumValue(value, HEADROOM_MODES, "headroomMode");
}

export function assertClippingPolicy(value: ClippingPolicy): void {
  enumValue(value, CLIPPING_POLICIES, "clippingPolicy");
}
