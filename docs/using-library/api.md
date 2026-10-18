# Public API

Applications construct one federation object through `createFederation` and supply
`storage`, `handlers`, and Tor configuration or transport providers. The object
exposes `addresses`, `messages`, `archives`, `transfers`, `peers`, and one
`start`/`stop` lifecycle. Available operations depend on the configured capabilities.

| Entry point  | Purpose                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| Package root | Factory, public types, errors, address utilities and the `protocol` codec namespace |
| `/adapters`  | Reference memory storage and tools for implementing storage providers               |
| `/testing`   | Synthetic routing and internal compatibility fixtures for tests                     |

Use the [architecture capability matrix](architecture.md#capability-matrix) to
choose providers for the operations your application needs.

Stateful coordinators and workers are internal. Applications use the facade
rather than constructing its services.

The authoritative public contract is exported from [src/index.ts](https://github.com/TechSologic/federation-privacy-library/blob/main/src/index.ts),
with provider configuration in [src/api.ts](https://github.com/TechSologic/federation-privacy-library/blob/main/src/api.ts).
The [typechecked application example](api-example.ts) imports the package's public
entry point and shows provider wiring, address registration, message submission,
transfer recovery, archive upload/download, and shutdown. Start with the
[application walkthrough](../../examples/README.md); its
[two-node example](../../examples/two-nodes.mjs) constructs both nodes with
`createFederation` and typechecked public providers. A separate offline runner
supplies loopback SOCKS configuration; real Tor configuration uses the same example.

Read the [runtime guide](runtime.md) for provider guarantees, errors, lifecycle,
current limits and host integration. Return to [Using the library](README.md).
