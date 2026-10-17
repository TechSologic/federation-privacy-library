# Interface Comparison With Existing Implementations

Status: source review and proposed contract adjustments, not executed
interoperability evidence. Reviewed on 2026-10-17.

Subsequent runtime and selected codec execution results are recorded separately
in [runtime status](../runtime.md). This table preserves the design review and
does not imply all reference behavior has been extracted.

Reference checkouts were clean when inspected:

- UnoLock node revision: `6a42004519c9d72d3e1d68793e52ed0c27efe43b`.
- Managed server revision: `5e48fb5a52f64996f87942f96744edf04bafe3ec`.

Paths below identify files within those respective repositories. These
references are optional review evidence; building or reading this proposal
does not require either checkout. No reference repository was modified.

## Coverage And Adjustments

| Requirement found in source | Source evidence | Proposed public contract |
| --- | --- | --- |
| Generate current addresses and derive hashes with the actual domain separation and key commitments | Node: `client/src/app/lib/receiveAddressFormat.ts` | Address generation/derivation utilities; server records carry derived identity, not the address secret |
| Enumerate active records, change status, maintain public keys | Node: `src/dao/ReceiveAddressDao.ts` | Paged address store plus register/update/remove; local durability separate from publication |
| Preserve routing identity while publishing and retrying | Node: `src/federation/federationReceiveAddressPublicationService.ts`; managed: `managed-federation/src/lookup-publication-worker.mjs` | Durable publication intent, active-record checks, conditional work and explicit readiness |
| Lookup returns keys, numeric key ids, attachment policy and possibly a separate archive route | Managed: `safe-server/services/managedFederationInlineResolver.ts` | Resolved address includes keys, expiry, policy and both route types |
| An exact send retry retains envelope bytes, destination and expected commitment | Node: `src/federation/federationDeliveryQueue.ts` | Bounded persisted envelope, stable operation id, conflicting resubmissions rejected |
| Persist outbound work before notification; recovery reclaims due work | Managed: `safe-server/services/managedFederationOutboundDelivery.ts`, `managed-federation/src/outbound-delivery-recovery.mjs` | Durable send result; notification is not the source of truth; state batches support conditional claims |
| Late acceptance must match the saved payload and destination | Managed: `managed-federation/src/main.mjs`, `markManagedOutboundDeliveryAccepted` | Expected-revision completion plus immutable operation identity |
| Transport acceptance establishes endpoint custody only | Node: `src/federation/federationDeliveryAcceptance.ts` | Message result is endpoint custody; no user-delivery state |
| Replay, current policy, limits and inbox insertion are atomic locally | Node: `src/persistence/sqlite/SqliteMessageQueueDao.ts`, `admitFederatedEyesMessage` | Receiver adapter owns atomic final effects and stable admission deduplication; policy preflight cannot consume allowances |
| Managed ingress and final application processing can be separate | Managed: `managed-federation/src/main.mjs`, `handleFederationDelivery`; `safe-server/handlers/managedFederationInbound.ts` | Receiver may take custody through a durable app queue; no same-process final inbox assumption |
| Byte streams, metadata, ranges, delete, and serving already stored objects | Node: `src/storage/archiveObjectStore.ts`, `src/storage/nodeArchiveGatewayClient.ts` | Source and receiver interfaces plus archive serving/storage methods |
| List pagination distinguishes deleted collections from empty results | Node: `src/storage/nodeArchiveGatewayClient.ts`, `listNodeArchives` | Bounded pages and explicit deleted/tombstone outcome |
| Upload response can be staged rather than committed | Node: `src/storage/federationArchiveWire.ts` | Distinct staged/committed result with validated receipt; signed version commit remains separate |
| Object revisions and content length/hash constrain writes | Node: `src/storage/managedArchiveGateway.ts`, `src/storage/federationArchiveWire.ts` | Expected revision, immutable source descriptor, full ciphertext digest and operation-bound proof |
| Unknown commit must be recovered before cleanup releases storage | Node: `src/storage/archiveUploadRecovery.ts` | Committing inspection state; idempotent commit; pending or already-committed discard results |
| Managed upload parts, completion and reservations use conditional versions | Managed: `managed-federation/src/managed-archive-upload-session-store.mjs` | Conditional operational state and durable interval staging; no whole-archive buffering requirement |
| Signed requests bind operation, archive, hash, nonce, lifetime and authority | Node: `src/storage/federationSpaceAccess.ts` | Trusted-authority resolver, policy hook and exact-request proof provider; mandatory checks retained in core |
| Signed mutable successor binds predecessor, content and writer authority | Node: `src/storage/mutableArchivePointer.ts` | Separate signed version commit with expected predecessor; preserve signed wire fields |
| Create/list/delete carry authority references and existing control descriptors | Node: `src/storage/nodeArchiveGatewayClient.ts`, `src/storage/federatedNodeArchiveGateway.ts`, `src/storage/archiveControlData.ts` | Collection authority reference and versioned operation/control documents; exact codec types remain to be finalized |

## Important Limits Of This Review

The TypeScript declarations and examples type-check. No runtime exists in this
repository, so this does not prove adapter feasibility, wire compatibility,
concurrency correctness, or recovery behavior.

The generic conditional storage batch is a proposed extraction boundary.
Neither current database interface already implements that exact API. Node
admission and managed final inbox admission must retain their transactional
effects behind their respective application adapters.

Existing archive code contains application-shaped control fields and checks,
including authority archive metadata and type restrictions. The generic facade
must map them faithfully through a defined protocol profile. It cannot silently
drop those fields or pretend the current wire protocol accepts arbitrary new
archive schemas. Application workflows remain outside the library.

The current node delivery queue allows a 256 KiB envelope, while the managed
outbound submission code imposes 180 KiB. These are source observations, not a
new default selected for this library. Numeric validation-key ids must preserve
their full safe-integer range; no 32-bit coercion is allowed.

Managed deployment details, queue vendor behavior, object-store SDKs and
replication handling belong behind adapters. The review did not add regions,
provider identifiers, or cross-region consistency controls to the public API.

## Adapter Validation Scenarios Before API Freeze

1. Register/update/remove an address while publication work is interrupted.
   Recover the correct revision; never republish a disabled or removed record.
2. Resolve a current address through both routes. Reject mismatched commitments;
   distinguish completed absence from temporary unavailability.
3. Lose a send response after durable queuing. Retry the same operation, verify
   exact-byte deduplication, and reject changed payloads under the same id.
4. Commit node application admission, then interrupt before the library records
   completion. Repeat the receiver call without consuming another allowance or
   writing another inbox entry.
5. Confirm a managed durable handoff, then lose the notification/response.
   Recover through adapter guarantees without claiming end-user delivery.
6. Resume a source after process restart and reattach a listener. Pause missing
   sources; reject changed length/digest; bound resources during retries.
7. Interrupt an archive part and repeat its range. Prevent partial visibility,
   overlapping conflicts, and duplicate reservation consumption.
8. Lose a commit response after local rename or remote object-store completion.
   Reconcile the same stage before retry, discard, or cancellation.
9. Race two object writes and two signed version successors. Preserve revision
   and predecessor preconditions; never overwrite a newer accepted version.
10. Verify every proof type against its real canonical request, including
    create/list/delete, multipart steps, reads, writes and mutable commits.
    Missing, expired, mismatched or self-authorized proofs fail closed.
11. Consume large archives and ranges slowly. Confirm backpressure, memory
    limits, cancellation, shutdown and resource cleanup on both host adapters.
12. Exercise collection tombstones, unavailable storage, stale worker finishes,
    pagination bounds, Tor loss and identity changes without conflating absence,
    temporary failure, or successful node custody.

These scenarios are a future validation plan, not tests claimed to have run.
