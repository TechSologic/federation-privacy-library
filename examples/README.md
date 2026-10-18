# Application Examples

The usual flow is: start a node, register an application's receive address,
look up the recipient's public keys, submit an already-encrypted message, and
store incoming envelopes through an application receiver. Keep the node running
until application shutdown.

| Example                                                | What to read it for                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [two-nodes.mjs](two-nodes.mjs)                         | Public `createFederation` API: registration → lookup → send → receive → exact retry                               |
| [api-example.ts](../docs/using-library/api-example.ts) | Application integration with `createFederation`, supplied providers, transfer status, and archive upload/download |
| [support/local-demo.mjs](support/local-demo.mjs)       | Example implementations of `MessageReceiver` and `AuthorizationHandler`, with a memory inbox                      |

The example's address remains fixed to the receiving node. Production storage
must retain the library's verified route and key pins across restarts; the example's
memory adapter loses them on exit. See [fixed node addresses](../docs/using-library/architecture.md#fixed-node-addresses).

## Run The Local Walkthrough

With Node.js 22 or later, install the beta in your application's project:

```bash
npm install --save-exact @techsologic/federation-privacy-library@0.1.0-beta.1
node node_modules/@techsologic/federation-privacy-library/scripts/run-example.mjs
```

The package includes this walkthrough, the example sources and the offline
runner. It also includes the Node.js types needed by its declarations. To adapt
the TypeScript example, use your application's TypeScript compiler.

Alternatively, from a repository checkout:

```bash
npm ci
npm run example
```

The repository command builds the library, typechecks the examples against the public package
interfaces, and runs the two-node application through `createFederation` and its
normal SOCKS connector. The separate [offline runner](../scripts/run-example.mjs)
supplies a loopback-only SOCKS proxy and two `TorConfiguration` objects. It does
not replace the library factory, connector, or runtime. No Tor process,
credentials, sibling repository, or published npm package is needed for this check.
The offline proxy does not provide Tor privacy. Keys and ciphertext are synthetic
fixtures, not usable cryptography.

Expected output:

```text
1. Both application nodes started.
2. Recipient address registered; publication scheduled.
3. Recipient discovered and address-bound public keys verified.
4. Encrypted envelope queued in the sender's store.
5. Remote node accepted custody (not a read receipt).
6. Receiving app validated its signature and stored the exact envelope.
7. Exact retry recovered the same transfer.
```

Read the numbered application flow in `two-nodes.mjs` first. It verifies the
received envelope and retry identity and exits unsuccessfully if either check
fails. Configuration is checked against `FederationConfiguration`, outgoing
content uses `EncryptedMessage` and `DataSource`, and the application receivers
implement `MessageReceiver` and `AuthorizationHandler`. All of these types come
from the package root. No application example imports `/testing` or internal engines.

## Run The Same Example With Tor

Operate Tor separately and forward two onion services to the two local listeners:

```text
SocksPort 127.0.0.1:9050
HiddenServiceDir /var/lib/tor/federation-sender/
HiddenServicePort 80 127.0.0.1:8081
HiddenServiceDir /var/lib/tor/federation-receiver/
HiddenServicePort 80 127.0.0.1:8082
```

Create a local JSON configuration file with the following shape. Replace each
hostname placeholder with the corresponding Tor-generated hostname (including
its `.onion` suffix):

```json
{
  "senderTor": {
    "onionService": "http://<sender-hostname>",
    "socksProxy": { "host": "127.0.0.1", "port": 9050 },
    "listen": { "host": "127.0.0.1", "port": 8081 },
    "bootstrap": [{ "onionService": "http://<receiver-hostname>" }]
  },
  "receiverTor": {
    "onionService": "http://<receiver-hostname>",
    "socksProxy": { "host": "127.0.0.1", "port": 9050 },
    "listen": { "host": "127.0.0.1", "port": 8082 },
    "bootstrap": [{ "onionService": "http://<sender-hostname>" }]
  }
}
```

Wait for Tor to bootstrap and publish the onion descriptors, then run:

```bash
# From an npm consumer:
node node_modules/@techsologic/federation-privacy-library/examples/two-nodes.mjs /path/to/tor-config.json

# From a repository checkout:
npm run build
node examples/two-nodes.mjs /path/to/tor-config.json
```

Both execution paths call the same `runTwoNodes({ senderTor, receiverTor })`
function. Tor reachability is an additional requirement for this mode. The
example still uses memory stores and synthetic content; replace those providers
with your application's durable storage and encrypted content when integrating.

## Connect Your Application

The helpers below are defined in the [TypeScript example](../docs/using-library/api-example.ts).
They illustrate integration boundaries; they do not provide a database, a content
encryption scheme, or an authorization service. Install the package version you
intend to use and copy/adapt the example to your application. The API is experimental.

### 1. Start A Host With Its Providers

`startMessagingNode({ storage, tor, authorization, routes, inbox })` calls
`createFederation` and starts one long-lived instance. Supply:

- `storage`: durable atomic address/state/lease/commit capabilities satisfying the
  [storage contract](../docs/using-library/runtime.md#construction-and-storage).
- `authorization`: your trusted authority lookup and application access policy.
- `routes`: an `AddressRouteProofProvider` that sends the exact proposed route
  to the address-owning client. The client verifies the configured onion target
  and signs it with the validation key committed by the address. The host must
  never receive that private key. Initial authorization binds the address to this
  node's onion service; subsequent publication reuses it while the client is
  offline. Moving to a different service requires a new address.
- `inbox`: a `MessageReceiver` that consumes the complete encrypted stream and
  durably inserts it once per `metadata.deliveryId` before resolving. Deduplication
  and the durable write belong in the same application transaction.
- `tor`: your actual onion service, listener, SOCKS proxy, and bootstrap peers.

Operate Tor separately. For example, the following Tor configuration forwards
an onion service's port 80 to this application's listener:

```text
SocksPort 127.0.0.1:9050
HiddenServiceDir /var/lib/tor/federation/
HiddenServicePort 80 127.0.0.1:8080
```

Use the hostname generated by that Tor instance and reachable bootstrap peers
in your application configuration. For a second node, use its own onion identity,
storage, and listener port. Configure each node's bootstrap list with a reachable
peer; the two-node example uses the other node.

```ts
const federation = await startMessagingNode({
  storage: application.federationStorage,
  authorization: application.authorization,
  routes: application.addressRouteProofProvider,
  inbox: application.encryptedInboxReceiver,
  tor: {
    onionService: application.config.onionService,
    socksProxy: { host: "127.0.0.1", port: 9050 },
    listen: { host: "127.0.0.1", port: 8080 },
    bootstrap: application.config.bootstrapPeers,
  },
});
```

`application` represents your own providers and configuration. The reference
`MemoryFederationStorage` and demo inbox lose all data when the process exits.
The project does not currently ship a verified production storage adapter.

### 2. Create And Register A Receive Address

In the receiving client, create keys using your application's content protocol,
then prepare the public registration:

```ts
const { address, registration } = await prepareReceiveAddress(
  clientKeys.publicKey,
  clientKeys.validationKey,
);
```

Keep private keys in the client. Send only `registration` to your receiving host,
where it runs:

```ts
const registered = await registerReceiveAddress(federation, registration);
// registered.publication can still be "pending".
```

Share `address` privately with sending clients through your application. The
host's registration contains the derived identity, public keys, and attachment
policy. Registration already queues publication; there is no need to call
`publish` for every new address.

### 3. Look Up Keys, Encrypt, And Queue A Message

The sending client derives the identity from the privately shared address with
`deriveAddress(address)`. On its federation instance, look up that identity:

```ts
const recipient = await federation.addresses.lookup(recipientIdentity, {
  signal: AbortSignal.timeout(60_000),
});
if (!recipient) throw new Error("No published recipient was found");
```

A lookup verifies the returned public keys against the address commitments.
A completed lookup with no result returns `null`; temporary unavailability
rejects. Handle that failure separately from an unknown recipient.

Pass the verified `recipient.keys` to your client's encryption/signing code.
It prepares an `EncryptedMessage` containing `messageId`, `senderAddressHash`,
`sealedHeader`, and `encryptedAttachmentDescriptors`. Store the exact encrypted
envelope, destination identity, and a stable operation ID in your application's
outbox before calling:

```ts
const transfer = await queueEncryptedMessage(
  federation,
  recipientIdentity,
  encryptedMessage,
  operationId,
);
```

`messages.source()` only encodes those fields; passing plaintext does not encrypt
it. `messages.send()` returns after local queuing. The library owns destination
routing and retries; your application need not select onion routes.

The application signature belongs inside the encrypted application protocol.
The library neither decrypts nor validates it. A receiving application must
validate the signature before committing any message effect; the example inbox
shows that check in its `MessageReceiver`.

### 4. Observe Custody And Process The Inbox

```ts
await waitForMessageCustody(federation, transfer.id, AbortSignal.timeout(60_000));
```

Completion establishes remote node custody. Receiver processing happens
separately, after address and application policy checks. Your client later
decrypts and authenticates envelopes stored by your inbox receiver. If your
product needs a read receipt, implement that application protocol separately.

After a restart, recover status with `federation.transfers.get(operationId)`.
For an uncertain submission, retry with the same operation ID, destination, and
exact encrypted envelope. Re-encrypting creates different bytes and is not an
exact retry. A wait timeout leaves delivery running; use `transfer.cancel()`
to request cancellation. Cancellation cannot undo custody already accepted.

### 5. Add Encrypted Archives When Needed

The TypeScript example also includes `uploadEncryptedArchive` and
`readEncryptedArchive`. These need additional providers: an archive store and
staging receiver, a source resolver for restart recovery, and client-authorized
proofs. Configure them through `storage.archives`, `storage.sources`,
`handlers.archives`, and `handlers.proofs` on the same `createFederation` call.
The messaging-only startup helper does not configure archives.

Supply an `ArchiveSource` for a file your client has already encrypted:
`describe()` returns encrypted length and SHA-256, and `open({ range, signal })`
streams the same bytes or requested interval on every attempt. Keep those bytes
available for the transfer's lifetime and resolve the stable source ID after
restart. Do not read a large archive into memory to create a message envelope.

Uploads can return `staged` or `committed`. Mutable content needs a separate
`commitVersion()` with a client-signed successor and expected predecessor.
Downloads require trusted length/digest metadata and a receiver that stages
bytes until verified completion. See [archive authorization and streaming](../docs/using-library/runtime.md#archive-streams-and-authorization)
before implementing these providers. The local messaging demo does not exercise archives.

### 6. Stop During Application Shutdown

Close admission to new application requests, await `stopMessagingNode(federation)`,
then close your provider connections. Do not stop immediately after startup or
close storage while library work is still draining.

## Check The TypeScript Example

From the repository root:

```bash
npm run build
npm run example:check
```

This checks both the runnable JavaScript example (including its supplied handlers)
and the TypeScript example against the built package's public declarations. It does
not validate your adapters, real Tor connectivity, or application encryption.
