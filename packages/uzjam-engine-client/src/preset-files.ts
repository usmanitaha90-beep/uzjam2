import type { UzjamProfile } from "@uzjam/contract";
import { UzjamProfileValidationError, validateAndCloneProfile } from "./validation.js";

export class UzjamPresetFileError extends TypeError {
  readonly code: "invalid-json" | "invalid-profile";

  constructor(code: "invalid-json" | "invalid-profile", message: string) {
    super(message);
    this.name = "UzjamPresetFileError";
    this.code = code;
  }
}

/** Parses and validates a canonical `.uzjam.json` file at the file boundary. */
export function parseUzjamPresetFile(contents: string): UzjamProfile {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new UzjamPresetFileError("invalid-json", "The preset is not valid JSON.");
  }

  try {
    return validateAndCloneProfile(value as UzjamProfile);
  } catch (error) {
    if (error instanceof UzjamProfileValidationError) {
      throw new UzjamPresetFileError("invalid-profile", `The preset is invalid: ${error.message}`);
    }
    throw error;
  }
}

/** Validates before serialization so an invalid profile is never exported. */
export function serializeUzjamPresetFile(profile: UzjamProfile): string {
  return `${JSON.stringify(validateAndCloneProfile(profile), null, 2)}\n`;
}

export function uzjamPresetFilename(profileName: string): string {
  const slug = profileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `uzjam-${slug || "profile"}.uzjam.json`;
}
