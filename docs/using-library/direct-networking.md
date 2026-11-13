# Direct archive networking

Direct networking is an optional HTTPS transport for encrypted archive bytes,
including large message attachments. DHT bootstrap, discovery, publication,
Receive Address lookup, public-key lookup, messages and archive control requests
always use Tor. There is no separate direct discovery or capability probe.

## Configuration and ownership

```ts
networking: { enabled: true, directOrigin: "https://node.example.com" }
```

Enabling requires a Tor connector, an onion identity and a public HTTPS domain
origin without credentials, path, query or fragment. IP literals, local domains,
private DNS answers and mixed public/private answers are rejected. TLS verifies
the configured hostname and platform trust roots. Redirects are never followed.

The library learns the archive endpoint from the `x-unolock-archive-endpoint`
header on existing successful Tor responses from that exact onion service.
The receiving host advertises `network.archiveDirectOrigin` when enabled, or its
onion URL when disabled. This is a server transport detail: clients, signed DHT
records, archive metadata and authorization proofs remain unchanged. Existing
Safes, Receive Addresses and saved archives continue working without migration.

The built-in runtime handles these headers and transport selection automatically.
Host HTTP adapters use the same public interface:

```ts
// Discovery, messages and archive controls always use Tor.
const control = await federation.network.connect(onionService, { signal });
// After a successful response on that Tor connection only:
federation.network.acceptTorArchiveEndpoint(onionService, responseHeader);
// Encrypted archive bytes may use the learned HTTPS origin.
const transfer = await federation.network.connectArchive(onionService, { signal });
```

Only the adapter receiving a successful response through the authenticated Tor
connection to that onion may call `acceptTorArchiveEndpoint`. Never learn an
endpoint from a client, a DHT record, another peer's assertions or a direct HTTPS
response. Missing, invalid or onion-valued headers clear the learned endpoint.
The in-memory cache holds at most 512 peers for five minutes; it is cleared on
policy changes and shutdown. Cold or expired entries use Tor immediately, without
a discovery request. Their response can warm the cache for later archive parts.

Use the socket, HTTP `origin` and `pathPrefix` returned by the library. Preserve
request proof verification, streaming bounds and cancellation. The Tor provider
must detach its setup signal before returning a socket; the HTTP owner controls
request and streaming deadlines after handoff.

## Ingress and fallback

The public HTTPS proxy forwards `/federation-direct/` unchanged. The application
admits only these method/path pairs while direct policy is enabled:

- `POST /federation/v1/archive/object/read`
- `PUT /federation/v1/archive/object`
- `PUT /federation/v1/archive/multipart/part`
- `PUT /federation/v1/archive/relay/part`

DHT, public keys, messages, archive lists, grants, multipart initialization and
completion remain on onion listeners. Public proxies must block the unprefixed
federation namespaces. Reserve inbound capacity for Tor requests and retain
archive idle deadlines, byte limits and log redaction.

DNS and TLS setup failures may fall back to Tor before any application bytes are
written. Once a request has started, the operation's durable owner controls
retries; the transport never replays an uncertain write. Direct failures have
bounded backoff. Disabling direct aborts pending direct setup and closes open
direct sockets. A remote withdrawal is learned on the next successful Tor response;
a stale direct request can fail and its owner retries through Tor.

## Bootstrap

Configure onion bootstrap peers. HTTPS bootstrap introductions, retained
onion-to-domain hints and the node-wide networking descriptor protocol are removed.
There is no capability refresh or direct discovery step.

## Privacy

Direct archive connections reveal server network addresses, timing and sizes.
The advertised endpoint links an HTTPS domain to an onion identity. Disabling
direct cannot undo information already disclosed. TLS protects transport; client
ciphertext, authenticated archive proofs and exact revision checks remain required.
Tor identity and Tor discovery remain mandatory in both modes.
