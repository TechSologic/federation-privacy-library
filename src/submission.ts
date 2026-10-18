import { FederationError, failure } from "./errors.js";
import type { TransferFailure } from "./contracts.js";

/** Local submission state, never a recipient read receipt. No raw provider error is exposed. */
export class FederationSubmissionError extends FederationError {
  readonly failure: TransferFailure;
  constructor(
    readonly operationId: string,
    readonly outcome: "not-queued" | "unknown" | "queued" | "accepted",
    error: unknown,
  ) {
    const detail = failure(error);
    super(
      detail.code,
      outcome === "accepted"
        ? "Custody accepted; application status notification failed"
        : "Federation submission failed",
      outcome !== "accepted" && detail.retryable,
    );
    this.name = "FederationSubmissionError";
    this.failure = { code: this.code, message: this.message, retryable: this.retryable };
  }
}
