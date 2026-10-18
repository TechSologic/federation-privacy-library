# Using The Library

For developers building an application or service with Federation Privacy Library.
You supply storage, encrypted content, application handlers and policy; the library
owns federation protocol behavior and orchestration.

Receive Addresses are [fixed to their original node](architecture.md#fixed-node-addresses)
for security. Integrations must preserve verified pins and use a new address when
changing the destination onion service.

## Reading Order

1. [Architecture](architecture.md): components, interfaces, capability matrix and
   operation flows.
2. [Application walkthrough](../../examples/README.md): run the example, then
   connect your storage, receiver, policy, and Tor configuration.
3. [Public API](api.md): one factory, supported entry points and authoritative types.
4. [Runtime and provider contracts](runtime.md): construction, storage, handlers,
   completion, failure and shutdown.
5. [Host queue integration](runtime.md#host-queue-integration): connect
   lookup, publication and delivery stores through the same facade.
6. [Privacy and application responsibilities](privacy.md): Tor, authority,
   diagnostics and durable application effects.

The API is experimental. Check the public declarations and package version
your application installs.
Production adapters must satisfy the documented storage guarantees. The reference
memory adapter is intended for tests and examples.

## Examples And Contracts

Examples and application guides ship in the npm package. Implementation source
and developer guides are linked from the repository.

- [Runnable two-node example](../../examples/two-nodes.mjs), using `createFederation`
  with public provider interfaces. Run with real Tor configuration or the separate
  offline SOCKS driver.
- [Typechecked application integration](api-example.ts), covering startup,
  address registration, message submission/status, archive upload/download, and shutdown.
- [Public exports](https://github.com/TechSologic/federation-privacy-library/blob/main/src/index.ts) and [provider configuration](https://github.com/TechSologic/federation-privacy-library/blob/main/src/api.ts).
- [Software license](../../LICENSE), [third-party notices](../../NOTICE.md) and
  [support policy](../../SUPPORT.md).

To change the library itself, use [Developing the library](https://github.com/TechSologic/federation-privacy-library/blob/main/docs/developing-library/README.md).
Return to the [documentation index](../README.md).
