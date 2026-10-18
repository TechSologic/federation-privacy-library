// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
import {
  decodeLookupValue,
  normalizeReceiveLookupTargets,
  type FederationLookupValue,
  type ReceiveLookupTarget,
} from "../protocol/lookupRecords.js";
import { openAddressRouteAuthorization } from "../protocol/addressRoutes.js";
import type { LookupPinStorage } from "../host/storage.js";
import type {
  FederationDeliveryRoutingSink,
  FederationDeliveryTarget,
  FederationDeliveryTargetResolution,
  FederationDeliveryTargetResolver,
} from "./coordinator.js";

export interface FederationDeliveryLookupResolution {
  source: "local" | "bootstrap" | "discovered" | "missing" | "unavailable";
  value?: FederationLookupValue;
}

/** Supplies bounded lookup records from local storage or discovery.
 * Providers enforce protocol byte bounds and finite I/O lifetimes. Incomplete
 * discovery returns unavailable, not missing. Records remain untrusted here.
 */
export interface FederationDeliveryLookupProvider {
  resolve(
    addressHash: string,
    signal?: AbortSignal,
    acceptValue?: (value: FederationLookupValue) => boolean,
  ): Promise<FederationDeliveryLookupResolution>;
}

/** Consumer-owned synchronous cache with bounded retention and isolated snapshots.
 * Cache entries are routing hints, never recipient identity or key authority.
 */
export interface FederationDeliveryRoutingCache extends FederationDeliveryRoutingSink {
  getLookupTargets(addressHash: string): ReceiveLookupTarget[] | undefined;
}

/** Client-authorized destination resolution. The first verified sealed route is
 * durably pinned before use. Replicas and plaintext routing hints cannot replace
 * that binding, including after restart or temporary unavailability.
 */
export class LookupFederationDeliveryTargetResolver implements FederationDeliveryTargetResolver {
  constructor(
    private readonly lookupProvider: FederationDeliveryLookupProvider,
    private readonly pins: LookupPinStorage,
  ) {}

  async resolveTargets(request: {
    addressHash: string;
    expectedValidationFingerprint?: string;
    signal?: AbortSignal;
  }): Promise<FederationDeliveryTargetResolution> {
    const { addressHash, expectedValidationFingerprint } = request;
    if (!expectedValidationFingerprint) {
      return {
        status: "unavailable",
        retryDelayMs: 60_000,
        retryReason: "route-authorization-required",
      };
    }
    request.signal?.throwIfAborted();
    const pinned = await this.pins.findPinnedValue(addressHash);
    if (pinned) {
      const record = openAddressRouteAuthorization(decodeLookupValue(pinned.lookupValue), {
        addressHash,
        validationFingerprint: expectedValidationFingerprint,
      });
      return { status: "resolved", targets: toDeliveryTargets(record.targets) };
    }
    const resolved = await this.lookupProvider.resolve(addressHash, request.signal, (value) => {
      try {
        openAddressRouteAuthorization(decodeLookupValue(value.lookupValue), {
          addressHash,
          validationFingerprint: expectedValidationFingerprint,
        });
        return true;
      } catch {
        return false;
      }
    });
    if (resolved.source === "unavailable") {
      return {
        status: "unavailable",
        retryDelayMs: 5_000,
        retryReason: "lookup-unavailable",
      };
    }
    if (!resolved.value) {
      return { status: "resolved", targets: [] };
    }

    try {
      const decoded = decodeLookupValue(resolved.value.lookupValue);
      openAddressRouteAuthorization(decoded, {
        addressHash,
        validationFingerprint: expectedValidationFingerprint,
      });
    } catch {
      // Preserve fail-closed behavior for unusable or unauthorized records.
      // Provider failures occur outside this boundary and propagate.
      return { status: "resolved", targets: [] };
    }
    // Commit failures must not be mistaken for an absent destination. If two
    // resolutions race, use only the binding that won the atomic insert.
    request.signal?.throwIfAborted();
    const winner = await this.pins.pinValue(resolved.value);
    const record = openAddressRouteAuthorization(decodeLookupValue(winner.lookupValue), {
      addressHash,
      validationFingerprint: expectedValidationFingerprint,
    });
    return { status: "resolved", targets: toDeliveryTargets(record.targets) };
  }
}

function toDeliveryTargets(targets: readonly ReceiveLookupTarget[]): FederationDeliveryTarget[] {
  return normalizeReceiveLookupTargets([...targets]).map((target) => ({
    onionService: target.onionService,
    deliveryPath: target.deliveryPath,
    priority: target.priority,
  }));
}
