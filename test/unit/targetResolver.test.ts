import test from "node:test";
import assert from "node:assert/strict";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import {
  LookupFederationDeliveryTargetResolver as Resolver,
  FederationDeliveryCoordinator,
  type FederationDeliveryLookupResolution,
  type FederationDeliveryRoutingCache,
} from "../../src/delivery/index.js";
import {
  addressRouteSigningBytes,
  encodeLookupValue,
  newAddressRouteNonce,
  sealAddressRouteAuthorization,
  type AddressRouteAuthorizationInput,
  type ReceiveLookupTarget,
} from "../../src/protocol/index.js";
import { fingerprint } from "../../src/address.js";
import { TestDeliveryQueue } from "../delivery-queue.js";

const addressHash = "a".repeat(64);
const target: ReceiveLookupTarget = {
  onionService: `http://${"b".repeat(56)}.onion`,
  deliveryPath: "/federation/v1/message/receive",
  priority: 0,
};
const fallback: ReceiveLookupTarget = {
  ...target,
  onionService: `http://${"c".repeat(56)}.onion`,
  priority: 1,
};
const keys = ml_dsa65.keygen(new Uint8Array(32).fill(7));
const validationKey = Buffer.from(keys.publicKey).toString("base64url");
const validationFingerprint = fingerprint(validationKey, true);

function authorizedValue(
  targets: ReceiveLookupTarget[] = [fallback, target, { ...target, priority: 3 }],
): FederationDeliveryLookupResolution {
  const route: AddressRouteAuthorizationInput = {
    type: "unolock.receive.route.v1",
    recordKey: addressHash,
    targets,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    nonce: newAddressRouteNonce(),
    validationKey,
  };
  const signature = Buffer.from(
    ml_dsa65.sign(addressRouteSigningBytes(route), keys.secretKey),
  ).toString("base64url");
  const sealed = sealAddressRouteAuthorization(
    { ...route, signature },
    { addressHash, validationFingerprint },
  );
  return {
    source: "local",
    value: { addressHash, storedAt: Date.now(), lookupValue: encodeLookupValue(sealed) },
  };
}

class LookupFederationDeliveryTargetResolver extends Resolver {
  constructor(provider: ConstructorParameters<typeof Resolver>[0], pins = new Cache()) {
    super(provider, pins);
  }
}

class Cache implements FederationDeliveryRoutingCache {
  pins = new Map<string, NonNullable<FederationDeliveryLookupResolution["value"]>>();
  async findPinnedValue(hash: string) {
    return structuredClone(this.pins.get(hash));
  }
  async pinValue(value: NonNullable<FederationDeliveryLookupResolution["value"]>) {
    if (!this.pins.has(value.addressHash)) this.pins.set(value.addressHash, structuredClone(value));
    return structuredClone(this.pins.get(value.addressHash)!);
  }
  entries = new Map<string, ReceiveLookupTarget[]>();
  writes = 0;
  reads = 0;
  getLookupTargets(hash: string) {
    this.reads++;
    return this.entries.get(hash);
  }
  setLookupTargets(hash: string, targets: ReceiveLookupTarget[]) {
    this.writes++;
    this.entries.set(hash, targets);
  }
}

test("a verified pin survives resolver recreation and ignores a changed signed DHT route", async () => {
  const pins = new Cache();
  let calls = 0;
  let response = authorizedValue([target]);
  const provider = {
    async resolve() {
      calls++;
      return response;
    },
  };
  const request = { addressHash, expectedValidationFingerprint: validationFingerprint };
  assert.deepEqual(await new Resolver(provider, pins).resolveTargets(request), {
    status: "resolved",
    targets: [target],
  });
  response = authorizedValue([fallback]);
  assert.deepEqual(await new Resolver(provider, pins).resolveTargets(request), {
    status: "resolved",
    targets: [target],
  });
  assert.equal(calls, 1);
  await assert.rejects(
    new Resolver(provider, pins).resolveTargets({
      ...request,
      expectedValidationFingerprint: "x".repeat(32),
    }),
  );
  assert.equal(calls, 1);
});

test("pin persistence failure prevents use and a concurrent insert determines the trusted route", async () => {
  const request = { addressHash, expectedValidationFingerprint: validationFingerprint };
  const provider = {
    async resolve() {
      return authorizedValue([fallback]);
    },
  };
  const pins = new Cache();
  const storageFailure = new Error("synthetic storage failure");
  pins.pinValue = async () => {
    throw storageFailure;
  };
  await assert.rejects(
    new Resolver(provider, pins).resolveTargets(request),
    (error) => error === storageFailure,
  );
  const winner = authorizedValue([target]).value!;
  pins.pinValue = async () => winner;
  assert.deepEqual(await new Resolver(provider, pins).resolveTargets(request), {
    status: "resolved",
    targets: [target],
  });
});

test("destination resolver opens and verifies the client-authorized sealed route", async () => {
  const cache = new Cache();
  cache.entries.set(addressHash, [{ ...target, onionService: `http://${"d".repeat(56)}.onion` }]);
  const resolver = new LookupFederationDeliveryTargetResolver(
    {
      async resolve() {
        return authorizedValue();
      },
    },
    cache,
  );
  assert.deepEqual(
    await resolver.resolveTargets({
      addressHash,
      expectedValidationFingerprint: validationFingerprint,
    }),
    { status: "resolved", targets: [target, fallback] },
  );
  assert.equal(cache.reads, 0);
  assert.equal(cache.writes, 0);
});

test("missing client route commitment fails closed without querying the DHT", async () => {
  let lookups = 0;
  const resolver = new LookupFederationDeliveryTargetResolver({
    async resolve() {
      lookups++;
      return authorizedValue();
    },
  });
  assert.deepEqual(await resolver.resolveTargets({ addressHash }), {
    status: "unavailable",
    retryDelayMs: 60_000,
    retryReason: "route-authorization-required",
  });
  assert.equal(lookups, 0);
});

test("plaintext, tampered, and wrong-key routes yield no targets", async () => {
  const plaintext = {
    type: "unolock.receive.lookup.v1",
    recordKey: addressHash,
    targets: [target],
    createdAt: Date.now(),
    recordNonce: "nonce",
    recordCommitment: "commitment",
  };
  const valid = authorizedValue();
  const sealed = JSON.parse(new TextDecoder().decode(valid.value!.lookupValue)) as Record<
    string,
    string
  >;
  const cases: FederationDeliveryLookupResolution[] = [
    {
      source: "local",
      value: { addressHash, storedAt: Date.now(), lookupValue: encodeLookupValue(plaintext) },
    },
    {
      source: "local",
      value: {
        addressHash,
        storedAt: Date.now(),
        lookupValue: encodeLookupValue({ ...sealed, ciphertext: `${sealed.ciphertext}A` }),
      },
    },
  ];
  for (const resolution of cases) {
    const resolver = new LookupFederationDeliveryTargetResolver({
      async resolve() {
        return resolution;
      },
    });
    assert.deepEqual(
      await resolver.resolveTargets({
        addressHash,
        expectedValidationFingerprint: validationFingerprint,
      }),
      { status: "resolved", targets: [] },
    );
  }
  const wrong = new LookupFederationDeliveryTargetResolver({
    async resolve() {
      return valid;
    },
  });
  assert.deepEqual(
    await wrong.resolveTargets({ addressHash, expectedValidationFingerprint: "z".repeat(32) }),
    { status: "resolved", targets: [] },
  );
});

test("unavailable lookup differs from missing and provider failures propagate", async () => {
  for (const resolution of [
    { source: "unavailable" },
    { source: "missing" },
  ] as FederationDeliveryLookupResolution[]) {
    const resolver = new LookupFederationDeliveryTargetResolver({
      async resolve() {
        return resolution;
      },
    });
    assert.deepEqual(
      await resolver.resolveTargets({
        addressHash,
        expectedValidationFingerprint: validationFingerprint,
      }),
      resolution.source === "unavailable"
        ? { status: "unavailable", retryDelayMs: 5_000, retryReason: "lookup-unavailable" }
        : { status: "resolved", targets: [] },
    );
  }
  const failure = new Error("synthetic provider failure");
  await assert.rejects(
    new LookupFederationDeliveryTargetResolver({
      async resolve() {
        throw failure;
      },
    }).resolveTargets({
      addressHash,
      expectedValidationFingerprint: validationFingerprint,
    }),
    (error) => error === failure,
  );
});

test("authenticated resolution drives retries without persisting decrypted routes", async () => {
  const queue = new TestDeliveryQueue();
  const deliveryId = "synthetic_delivery_resolver";
  const envelope = new Uint8Array([1, 2, 3]);
  await queue.enqueue({
    deliveryId,
    addressHash,
    expectedValidationFingerprint: validationFingerprint,
    envelope,
    now: 1_000,
  });
  let available = false;
  const cache = new Cache();
  const resolver = new LookupFederationDeliveryTargetResolver(
    {
      async resolve() {
        return available ? authorizedValue() : { source: "unavailable" };
      },
    },
    cache,
  );
  let sends = 0;
  const engine = new FederationDeliveryCoordinator({
    queue,
    targetResolver: resolver,
    transport: {
      async deliver(request) {
        sends++;
        assert.equal(request.onionService, target.onionService);
        return { status: "accepted" };
      },
    },
  });
  try {
    assert.equal((await engine.processDue({ now: 1_000 })).attempted, 0);
    available = true;
    assert.equal((await engine.processDue({ now: 6_000 })).accepted, 1);
    assert.equal(sends, 1);
    assert.equal(cache.writes, 0);
  } finally {
    await engine.stopProcessing();
  }
});
