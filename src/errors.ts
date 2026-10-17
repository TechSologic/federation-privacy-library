import type { TransferFailure } from "./contracts.js";
export class FederationError extends Error {
  constructor(
    readonly code: TransferFailure["code"],
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "FederationError";
  }
}
export function fail(code: TransferFailure["code"], message: string, retryable = false): never {
  throw new FederationError(code, message, retryable);
}
export function failure(error: unknown): TransferFailure {
  return error instanceof FederationError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: "internal", message: "Federation operation failed", retryable: true };
}
export function integer(value: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail("invalid-data", "Invalid numeric limit");
  return value;
}
