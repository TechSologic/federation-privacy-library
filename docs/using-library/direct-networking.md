# Direct Networking

Direct Networking is an opt-in HTTPS transport within the existing federation.
Tor, onion identities and onion bootstrap routes remain mandatory. Tor-only nodes
retain full discovery, messaging and archive functionality. There is one DHT and
placement policy; direct capability never changes identity or replica eligibility.

## Configuration And Ownership

Construct the public `createFederation` factory with optional configuration:

```ts
networking: {
  enabled: true,
  directOrigin: "https://node.example.com"
}
```

Omission defaults to Tor-only. Enabling requires an onion identity, a Tor
connector, and an HTTPS domain origin without credentials, path, query or fragment.
IP literals and local-use domains are rejected. Operators provision public DNS,
TLS, ingress routing and Tor before advertising the endpoint.

The built-in runtime selects transport for discovery, public-key lookup, messages
and archives automatically. Its Tor readiness probe remains active in both modes.

Host integrations supply `transport.onion.connect(onionService, signal)` as a
Tor-only socket provider and use `federation.network.connect(onionService)` for
lookup, messages and archives. The returned socket has completed its Tor
connection or HTTPS certificate validation. Use the returned `origin` for the
HTTP Host header and prepend `pathPrefix` to the unchanged protocol path.
The provider detaches the connection signal before returning the socket; the
HTTP owner controls request cancellation and streaming deadlines after handoff.
Preserve bounded parsing, streaming, cancellation and admission. Supplying
`networking` alone does not rewrite custom host transport providers.

## Capability And Bootstrap Protocol

The capability endpoint is a POST to
`/.well-known/unolock-federation/v1/networking`. Requests contain
`type: "unolock.federation.networking.request.v1"` and a fresh 32-byte base64url
`challenge`. `network.describe(request)` produces a strict descriptor containing
`type: "unolock.federation.networking.v1"`, the original `onionService`, `enabled`,
the matching `challenge`, `expiresAt`, and `directOrigin` only when enabled.

Before following an origin, the library fetches its descriptor through the exact
authorized onion service. HTTPS alone does not authenticate an onion identity.
The onion endpoint delegates transport to the declared HTTPS origin, whose
certificate must match its domain and the platform's trusted roots. This adds
Web PKI trust for the opted-in transport; a domain certificate is not an onion
signature. Content encryption, proofs, replay protection and recipient
verification remain required and unchanged.

Capabilities live at most five minutes in a bounded 512-entry memory cache,
separate from permanent address pins. Old peers, absent capabilities, failed
validation and unsuccessful discovery use Tor. Initial verification and later
trust refresh still require Tor. Clocks must be synchronized for expiry checks.

`await federation.network.bootstrap("https://seed.example.com")` reads an HTTPS
introduction and verifies its onion counterpart over Tor before returning an
`{ onionService }` peer for the same discovery network.

For configured domain seeds, set `networking.bootstrapOrigins` (at most 16 HTTPS
origins) and supply `storage.bootstrap` with durable encrypted `get(origin)` and
`set(origin, onionService, { signal })` methods. Writes must honor cancellation
and resolve only after durable storage. Retain configured mappings across
restarts and policy changes, and prune origins removed from configuration.
These introductions remain separate from permanent Receive Address pins.

The facade resolves these seeds during ordinary discovery and merges the verified
onion counterparts into the same graph. Concurrent resolutions share work;
successful introductions refresh after five minutes and failures after 30 seconds.
`network.bootstrapPeers()` exposes the same resolution for host-owned integration
boundaries. A failed refresh uses the retained onion counterpart, never an
unverified replacement. Tor-only mode reads retained counterparts without DNS or
HTTPS. Explicit `bootstrap(origin)` also returns a retained counterpart in that
mode, or fails if none exists. An unknown domain-only entry cannot supply a Tor
fallback; configure an onion seed or verify the domain while direct mode is on.
The library never silently adds public seeds to an explicit private/empty list.

## HTTPS Ingress Boundary

Public HTTPS exposes only `/federation-direct/`, forwarding it without stripping
the prefix to the library's loopback listener. The built-in listener checks
current direct policy before removing the prefix and dispatching the original
operation. It rejects this namespace when direct mode is disabled. The external
capability path is
`/federation-direct/.well-known/unolock-federation/v1/networking`.

The built-in listener retains its total limits of 16 active requests and 600
accepted requests per minute. Direct ingress may use at most eight active slots
and 300 requests in the same rate window, preserving Tor capacity without
increasing total adapter load. External ingress should apply its own per-client
limits before forwarding into this shared node boundary.

Tor forwards original unprefixed paths. Do not publish that raw listener or its
unprefixed capability endpoint over HTTPS: this would bypass the direct ingress
gate and could disclose an onion identity after disabling direct mode. Host
integrations implement the same separation and gate, including discovery, and
expose only federation endpoints. Keep admin endpoints outside this namespace.
Do not log request bodies, address hashes or credentials.

Direct DNS checks every answer, rejecting private, loopback, link-local,
reserved and transition destinations. TLS connects to a checked literal while
retaining domain certificate verification and SNI, without resolving the hostname
again. Redirects are never followed.

## Fallback, Policy Changes And Privacy

Both local policy and a fresh peer capability must enable direct mode. Failed
direct connection preparation falls back to Tor before application bytes are
sent. The selector returns a connection; it never sends or replays an application
request. After an ambiguous write, its durable owner reconciles or retries the
same operation identity and exact authorized bytes. Host transports call
`network.reportFailure(onionService)` to prefer Tor temporarily on the next
attempt. Integrity or authorization failures cannot become successful by changing
transport.

`network.configure({ enabled: false })` stops local direct selection, cancels
pending direct work, clears capabilities and closes open direct sockets. The
built-in direct ingress gate closes too. This cannot revoke delivered bytes,
erase remote caches or remove domain/onion links already observed. Peers can
retain stale capabilities until expiry and still attempt connections. Hosts
persist operator policy and apply it at restart. Capabilities are relearned over
Tor after a library restart.

Enabling or changing an HTTPS origin never rewrites client-signed Receive Address
records. Existing addresses and onion pins remain usable; old peers use Tor.
Direct mode reveals network addresses and connection metadata and links the
domain to the onion identity. This affects the whole hosting node, including
Safes whose individual connections subsequently use Tor.

## Verification Scope

Tests exercise the public factory with separate local SOCKS and HTTPS proxies,
real TLS and disposable test certificates, mixed peers, existing addresses and
signed streaming archive operations. A test-only driver maps checked public
destinations to loopback. Production validation has no private-address or
certificate-check bypass. This is local protocol evidence, not real Tor
interoperability, installed consumer qualification or deployed ingress proof.

See [Architecture](architecture.md), [Privacy](privacy.md), and the
[runtime contracts](runtime.md) for unchanged authority and storage rules.
