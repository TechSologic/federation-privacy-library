# Privacy And Application Responsibilities

Federation transports already-encrypted content. Your application owns content
encryption, client-held keys, recipient verification and access policy. Onion
endpoint authentication and endpoint custody do not grant content authority or
prove that a recipient received or read a message.

## Tor And Diagnostics

Operate Tor separately. When providing a transport, enforce finite I/O budgets,
permitted onion endpoints and response bounds. Do not introduce clearnet fallback
or follow arbitrary redirects. Tor does not remove timing, size or application
behavior signals.

The DHT resolves address hashes to onion services. Address-to-service association,
including correlation between addresses hosted by one service, is an accepted
part of this routing model. It does not identify the service operator or reveal
the server's IP address by itself. Sealed routes limit disclosure of routing
records; they do not guarantee address-to-service unlinkability.

Use aggregate events for diagnostics. Keep raw addresses, onion routes,
credentials, proofs, private keys and identifying traffic out of logs. Avoid
persistent relationship metadata added solely for diagnostics. An unavailable
lookup is not proof that a destination does not exist; preserve that distinction
and the documented generic ingress responses.

## Fixed Addresses And Trust State

An address's original node binding is a security property. After verifying a route,
the library persists it before use and never replaces it with a later DHT answer.
This prevents silent redirection even when another route is advertised or the
original node is offline. A different onion service requires a new address.

Treat pins as durable trust state, not disposable performance caches. They have
no automatic expiry or eviction. Storage errors and exhausted pin capacity must
prevent new lookups from being used. Erasing pins or restoring an older backup
loses the bindings learned since that snapshot. Encrypt and back up these records
with the rest of the application's federation state.

See [fixed node addresses](architecture.md#fixed-node-addresses) for recovery and
offline-client behavior.

## Providers And Handlers

Implement the [storage guarantees](runtime.md#construction-and-storage) before
relying on durable submission or recovery. Receivers must consume and durably
store or queue accepted bytes before resolving, and deduplicate repeated callbacks.
Separate stores do not automatically form a transaction.

Encrypt all application-owned federation storage at rest, including payloads,
routing values, identifying indexes, journals, temporary files and backups. Keep
the encryption keys separate from those stores and rotate them under application
policy. Content encryption does not protect address, route or operation metadata
that an adapter writes outside the encrypted envelope.

Supply trusted authorization bindings and client-authorized proofs. Peer-returned
keys, routing hints and custody metadata must not replace client-held authority.
Preserve cancellation, fencing and conditional-write guarantees in adapters.

Read the [handler and failure contracts](runtime.md#event-and-failure-contracts)
and [lifecycle](runtime.md#lifecycle) when handling uncertain submissions or shutdown.
The [runtime guide](runtime.md) records supported behavior and remaining limits.

Report suspected vulnerabilities through [SECURITY.md](../../SECURITY.md).
Return to [Using the library](README.md).
