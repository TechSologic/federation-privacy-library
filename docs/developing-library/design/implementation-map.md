# Implementation Map

The [architecture overview](../../using-library/architecture.md) describes the
public API, provider boundaries and operation flows. This map connects those
responsibilities to source modules.

| Responsibility                                  | Source                                              |
| ----------------------------------------------- | --------------------------------------------------- |
| Public exports and factory                      | [src/index.ts](../../../src/index.ts)               |
| Grouped provider configuration                  | [src/api.ts](../../../src/api.ts)                   |
| Composition and lifecycle                       | [src/federation.ts](../../../src/federation.ts)     |
| Atomic runtime, ingress and transfer scheduling | [src/runtime.ts](../../../src/runtime.ts)           |
| Address generation and key commitments          | [src/address.ts](../../../src/address.ts)           |
| Built-in address discovery                      | [src/discovery.ts](../../../src/discovery.ts)       |
| Host lookup and publication coordination        | [src/host/lookup.ts](../../../src/host/lookup.ts)   |
| Host lookup and publication storage contracts   | [src/host/storage.ts](../../../src/host/storage.ts) |
| DHT routing and maintenance                     | [src/dht/](../../../src/dht/)                       |
| Host queue delivery and target resolution       | [src/delivery/](../../../src/delivery/)             |
| Archive operations and streams                  | [src/archives.ts](../../../src/archives.ts)         |
| Wire codecs and validation                      | [src/protocol/](../../../src/protocol/)             |
| Built-in Tor transport and HTTP listener        | [src/transport.ts](../../../src/transport.ts)       |
| Atomic state encoding and conditional mutations | [src/state.ts](../../../src/state.ts)               |
| Stream handling and integrity checks            | [src/streams.ts](../../../src/streams.ts)           |
| Bounded diagnostic dispatch                     | [src/observers.ts](../../../src/observers.ts)       |
| Reference storage and adapter utilities         | [src/adapters/](../../../src/adapters/)             |
| Internal test fixtures                          | [src/testing/](../../../src/testing/)               |

## Internal Composition

`FederationFacade` validates provider dependencies and constructs the enabled
services. Atomic storage enables `FederationRuntime`, which owns a `Discovery`,
`HttpWire`, `State`, archive service, listener and independent background loops.

Host lookup storage enables a lookup coordinator and delivery-target resolver.
Host delivery storage adds a delivery coordinator and retry worker. Publication
storage adds a publication worker. The facade owns these workers and their
shared start/stop lifecycle. Host transport providers own I/O; storage providers
own persistence guarantees.

Wire codecs and validation are shared protocol building blocks. The pure public
helpers live under `protocol`; stateful services stay internal. `/adapters`
contains tools for implementing providers, while `/testing` supports library
fixtures and is not an application construction API.

## Application Boundary

Applications own content encryption, client authority, private address handling,
access policy, durable storage, product workflows and Tor provisioning. The
built-in runtime invokes supplied receivers. A host queue integration provides
its own inbound listener and processing. The library does not supply production
database or filesystem adapters.

See the [library contract](library-contract.md),
[provider contracts](../../using-library/runtime.md) and
[validation guide](../validation.md).
