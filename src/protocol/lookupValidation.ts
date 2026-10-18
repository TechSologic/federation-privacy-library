import { FederationError, fail } from "../errors.js";

// Narrow internal readers for the extracted lookup wire documents. No coercion.
export function lookupObject(
  input: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("invalid-data", "Invalid lookup document");
  const value = input as Record<string, unknown>;
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail("invalid-data", "Invalid lookup fields");
  return value;
}
export function lookupText(value: unknown, min = 1, max = Infinity, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    (pattern && !pattern.test(value))
  )
    fail("invalid-data", "Invalid lookup text");
  return value;
}
export function lookupInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail("invalid-data", "Invalid lookup number");
  return value;
}
export function lookupLiteral<T extends string | boolean>(value: unknown, expected: T): T {
  if (value !== expected) fail("invalid-data", "Invalid lookup discriminator");
  return expected;
}
export function lookupBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("invalid-data", "Invalid lookup flag");
  return value;
}
export function lookupArray(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail("invalid-data", "Invalid lookup list");
  return value;
}
export function parseLookupDocument<T>(parse: () => T, message: string): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof FederationError && error.code === "invalid-data")
      fail("invalid-data", message);
    throw error;
  }
}
