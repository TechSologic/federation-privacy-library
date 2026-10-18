import test from "node:test";
import assert from "node:assert/strict";
import { createFederation, FederationSubmissionError, protocol } from "../../src/index.js";
import { TestDeliveryQueue } from "../delivery-queue.js";
import { ObserverDispatcher } from "../../src/observers.js";
import type { LookupStorage } from "../../src/api.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { fingerprint } from "../../src/address.js";

const hash = "a".repeat(64);
const target = {
  onionService: `http://${"b".repeat(56)}.onion`,
  deliveryPath: "/federation/v1/message/receive" as const,
  priority: 0,
};
const routeKeys = ml_dsa65.keygen(new Uint8Array(32).fill(9));
const routeValidationKey = Buffer.from(routeKeys.publicKey).toString("base64url");
const routeValidationFingerprint = fingerprint(routeValidationKey, true);
const unsignedRoute = {
  type: "unolock.receive.route.v1" as const,
  recordKey: hash,
  targets: [target],
  issuedAt: Date.now() - 1_000,
  expiresAt: Date.now() + 60 * 60_000,
  nonce: protocol.newAddressRouteNonce(),
  validationKey: routeValidationKey,
};
const signedRoute = {
  ...unsignedRoute,
  signature: Buffer.from(
    ml_dsa65.sign(protocol.addressRouteSigningBytes(unsignedRoute), routeKeys.secretKey),
  ).toString("base64url"),
};
const value = {
  addressHash: hash,
  storedAt: 1,
  lookupValue: protocol.encodeLookupValue(
    protocol.sealAddressRouteAuthorization(signedRoute, {
      addressHash: hash,
      validationFingerprint: routeValidationFingerprint,
    }),
  ),
};
const request = {
  ...target,
  addressHash: hash,
  expectedValidationFingerprint: routeValidationFingerprint,
  envelope: new Uint8Array([1]),
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function lookup(): LookupStorage {
  let pin: typeof value | undefined;
  return {
    async findPinnedValue() {
      return pin && structuredClone(pin);
    },
    async pinValue(input) {
      pin ??= structuredClone(input);
      return structuredClone(pin);
    },
    async findValue() {
      return value;
    },
    async findOwnedValue() {
      return value;
    },
    async putValue() {
      return value;
    },
    async putReplica() {
      return value;
    },
    async findNode() {
      return [];
    },
    configureRouting() {},
    findPeersForMaintenance() {
      return [];
    },
    async recordPeerFailure() {},
    offerPeerCandidate() {
      return false;
    },
    findPeerCandidates() {
      return [];
    },
    async ping() {
      return { ok: true, checkedAt: 1 };
    },
  };
}
const unavailable = {
  async postJson(): Promise<never> {
    throw new Error("No network expected");
  },
};

test("immediate submission pins before contact and ignores conflicting caller routes", async () => {
  const store = lookup();
  const queue = new TestDeliveryQueue();
  const events: string[] = [];
  const pin = store.pinValue.bind(store);
  store.pinValue = async (input) => {
    events.push("pin");
    assert.equal(queue.records.size, 1, "Durable intent precedes resolution");
    return pin(input);
  };
  const federation = createFederation({
    storage: { lookup: store, delivery: queue },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver(input) {
          events.push("send");
          assert.deepEqual(await store.findPinnedValue(hash), value);
          assert.equal(input.onionService, target.onionService);
          assert.equal(input.deliveryPath, target.deliveryPath);
          assert.deepEqual(input.envelope, request.envelope);
          return { status: "accepted" };
        },
      },
    },
  });
  try {
    const changed = {
      ...request,
      onionService: `http://${"c".repeat(56)}.onion`,
      deliveryPath: protocol.federationDeliveryPaths[1],
    };
    assert.equal((await federation.messages.submit(changed)).status, "accepted");
    store.findValue = async () => {
      throw new Error("Pinned delivery must not query changed DHT records");
    };
    assert.equal((await federation.messages.submit(changed)).status, "accepted");
    assert.deepEqual(events, ["pin", "send", "send"]);
  } finally {
    await federation.stop();
  }
});

test("immediate submission fails closed on pin read and write errors", async () => {
  for (const operation of ["findPinnedValue", "pinValue"] as const) {
    const store = lookup();
    store[operation] = async () => {
      throw new Error("private storage error");
    };
    const queue = new TestDeliveryQueue();
    let sent = 0;
    const federation = createFederation({
      storage: { lookup: store, delivery: queue },
      transport: {
        lookup: unavailable,
        delivery: {
          async deliver() {
            sent++;
            return { status: "accepted" };
          },
        },
      },
    });
    try {
      await assert.rejects(
        federation.messages.submit(request, { deliveryId: "pin_failure_delivery" }),
        (error) =>
          error instanceof FederationSubmissionError &&
          error.outcome === "unknown" &&
          error.operationId === "pin_failure_delivery" &&
          !error.message.includes("private"),
      );
      assert.equal(sent, 0);
      assert.equal(queue.records.size, 1);
    } finally {
      await federation.stop();
    }
  }
});

test("immediate submission cannot contact a route without a matching commitment", async () => {
  for (const commitment of [undefined, "x".repeat(32)]) {
    const queue = new TestDeliveryQueue();
    let sent = 0;
    const federation = createFederation({
      storage: { lookup: lookup(), delivery: queue },
      transport: {
        lookup: unavailable,
        delivery: {
          async deliver() {
            sent++;
            return { status: "accepted" };
          },
        },
      },
    });
    try {
      const result = await federation.messages.submit(
        {
          ...request,
          expectedValidationFingerprint: commitment,
        },
        { deliveryId: "unverified_delivery" },
      );
      assert.deepEqual(result, { status: "queued", deliveryId: "unverified_delivery" });
      assert.equal(sent, 0);
      assert.equal(queue.records.size, 1);
      if (!commitment) assert.equal(queue.records.get(result.deliveryId)!.attempts, 0);
    } finally {
      await federation.stop();
    }
  }
});

test("shutdown during immediate pin persistence retains work without contacting a target", async () => {
  const store = lookup();
  const pin = store.pinValue.bind(store);
  let release!: () => void;
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.pinValue = async (input) => {
    entered();
    await gate;
    return pin(input);
  };
  const queue = new TestDeliveryQueue();
  let sent = 0;
  const federation = createFederation({
    storage: { lookup: store, delivery: queue },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver() {
          sent++;
          return { status: "accepted" };
        },
      },
    },
    scheduling: { discovery: false, publication: false, delivery: false },
  });
  const submission = federation.messages.submit(request, { deliveryId: "shutdown_pin_delivery" });
  await entering;
  let stopped = false;
  const stopping = federation.stop().then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(stopped, false);
  release();
  assert.equal((await submission).status, "queued");
  await stopping;
  assert.equal(sent, 0);
  assert.equal(queue.records.size, 1);
  await federation.start();
  try {
    assert.equal((await federation.messages.processDue()).accepted, 1);
    assert.equal(sent, 1);
  } finally {
    await federation.stop();
  }
});

test("immediate resolution uses the queued snapshot across caller mutations", async () => {
  const store = lookup();
  let entered!: () => void;
  let release!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.findPinnedValue = async () => {
    entered();
    await gate;
    return structuredClone(value);
  };
  const queue = new TestDeliveryQueue();
  let sent = 0;
  const mutable = { ...request, envelope: new Uint8Array(request.envelope) };
  const federation = createFederation({
    storage: { lookup: store, delivery: queue },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver(input) {
          sent++;
          assert.equal(input.addressHash, hash);
          assert.equal(input.expectedValidationFingerprint, routeValidationFingerprint);
          assert.deepEqual(input.envelope, request.envelope);
          assert.equal(input.onionService, target.onionService);
          return { status: "accepted" };
        },
      },
    },
  });
  try {
    const submitting = federation.messages.submit(mutable);
    await entering;
    mutable.addressHash = "d".repeat(64);
    mutable.expectedValidationFingerprint = "x".repeat(32);
    mutable.envelope[0] = 99;
    mutable.onionService = `http://${"c".repeat(56)}.onion`;
    release();
    assert.equal((await submitting).status, "accepted");
    assert.equal(sent, 1);
  } finally {
    release();
    await federation.stop();
  }
});

test("a cold lookup resolves and pins a signed route received from a peer", async () => {
  const store: LookupStorage = {
    ...lookup(),
    async findValue() {
      return undefined;
    },
    async findOwnedValue() {
      return undefined;
    },
  };
  const encoded = Buffer.from(value.lookupValue).toString("base64url");
  assert.ok(encoded.length > 6000, "Signed routes exceed the former RPC text limit");
  let requests = 0;
  const federation = createFederation({
    storage: { lookup: store },
    tor: { bootstrap: [{ onionService: target.onionService }] },
    transport: {
      lookup: {
        async postJson(_peer, path, body) {
          requests++;
          assert.equal(path, "/.well-known/unolock-grid/v1/find-value");
          assert.deepEqual(body, { type: "unolock.grid.findValue.v1", addressHash: hash });
          return JSON.parse(
            JSON.stringify({
              type: "unolock.grid.findValue.response.v1",
              found: true,
              addressHash: hash,
              lookupValue: encoded,
              storedAt: value.storedAt,
            }),
          );
        },
      },
    },
    scheduling: { discovery: false, publication: false, delivery: false },
  });
  try {
    const expected = { status: "resolved", targets: [target] };
    assert.deepEqual(
      await federation.addresses.resolveTargets(hash, routeValidationFingerprint),
      expected,
    );
    assert.deepEqual(await store.findPinnedValue(hash), value);
    assert.deepEqual(
      await federation.addresses.resolveTargets(hash, routeValidationFingerprint),
      expected,
    );
    assert.equal(requests, 1, "The second lookup must use the verified pin");
  } finally {
    await federation.stop();
  }
});

test("one facade constructs resolution and delivery from providers and returns stable identity", async () => {
  const queue = new TestDeliveryQueue();
  let calls = 0;
  const federation = createFederation({
    storage: { lookup: lookup(), delivery: queue },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver(input) {
          calls++;
          assert.equal(queue.records.size, 1);
          assert.deepEqual(input.envelope, request.envelope);
          return { status: "accepted" };
        },
      },
    },
    scheduling: { discovery: false, publication: false, delivery: false },
  });
  assert.deepEqual(await federation.addresses.resolveTargets(hash, routeValidationFingerprint), {
    status: "resolved",
    targets: [target],
  });
  const result = await federation.messages.submit(request, { deliveryId: "facade_delivery_1" });
  assert.deepEqual(result, { status: "accepted", deliveryId: "facade_delivery_1" });
  assert.equal(calls, 1);
  assert.equal(queue.records.size, 0);
  await federation.start();
  await federation.stop();
  await assert.rejects(federation.messages.processDue(), { code: "unavailable" });
  await federation.start();
  await federation.stop();
});

test("accepted custody remains explicit when a durable application handler fails", async () => {
  const queue = new TestDeliveryQueue();
  const federation = createFederation({
    storage: { lookup: lookup(), delivery: queue },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver() {
          return { status: "accepted" };
        },
      },
    },
    handlers: {
      deliveryStatus: {
        async setDeliveryStatus() {
          throw new Error("private provider payload");
        },
      },
    },
  });
  await assert.rejects(
    federation.messages.submit(request, { deliveryId: "facade_delivery_2" }),
    (error) => {
      assert.ok(error instanceof FederationSubmissionError);
      assert.equal(error.outcome, "accepted");
      assert.equal(error.operationId, "facade_delivery_2");
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes("private"));
      return true;
    },
  );
  assert.equal(queue.records.size, 0);
  await federation.stop();
});

test("facade shutdown waits for a submission still entering durable storage", async () => {
  const queue = new TestDeliveryQueue();
  const enqueue = queue.enqueue.bind(queue);
  let release!: () => void;
  let entered!: () => void;
  const entering = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  queue.enqueue = async (input) => {
    entered();
    await gate;
    return enqueue(input);
  };
  let sent = 0;
  const federation = createFederation({
    storage: { lookup: lookup(), delivery: queue },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver() {
          sent++;
          return { status: "accepted" };
        },
      },
    },
  });
  const submitted = federation.messages.submit(request, { deliveryId: "facade_delivery_3" });
  await entering;
  let stopped = false;
  const stopping = federation.stop().then(() => (stopped = true));
  await tick();
  assert.equal(stopped, false);
  release();
  assert.equal((await submitted).status, "queued");
  await stopping;
  assert.equal(sent, 0);
  assert.equal(queue.records.size, 1);
});

test("async diagnostics are isolated and bounded without delaying shutdown", async () => {
  const dispatcher = new ObserverDispatcher(),
    observer = {};
  const called: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  dispatcher.dispatch(observer, async () => {
    called.push(1);
    await gate;
    throw new Error("synthetic diagnostic rejection");
  });
  dispatcher.dispatch(observer, () => {
    called.push(2);
  });
  dispatcher.dispatch(observer, () => {
    called.push(3);
  });
  assert.deepEqual(called, [1]);
  release();
  await tick();
  assert.deepEqual(called, [1, 3]);
  const federation = createFederation({
    storage: { lookup: lookup(), delivery: new TestDeliveryQueue() },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver() {
          return { status: "accepted" };
        },
      },
    },
    handlers: {
      async onEvent() {
        await new Promise(() => {});
      },
    },
    scheduling: { discovery: false, publication: false },
  });
  await federation.start();
  await tick();
  await federation.stop();
});

test("incomplete provider configurations fail before network or persistence", () => {
  assert.throws(() => createFederation({ storage: { delivery: new TestDeliveryQueue() } }), {
    code: "invalid-data",
  });
  assert.throws(() => createFederation({ storage: { lookup: lookup() } }), {
    code: "invalid-data",
  });
});

test("unsupported runtime providers are rejected rather than silently ignored", () => {
  assert.throws(
    () =>
      createFederation({
        storage: {},
        handlers: { messages: { async receive() {} } },
      }),
    { code: "invalid-data" },
  );
  assert.throws(
    () =>
      createFederation({
        storage: {},
        limits: { maxAttempts: 1 },
      }),
    { code: "invalid-data" },
  );
});

test("all public peer calls including key lookup accept cancellable call options", async () => {
  let calls = 0;
  const federation = createFederation({
    storage: {},
    transport: {
      lookup: {
        async postJson() {
          calls++;
          throw new Error("Unexpected I/O");
        },
      },
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    federation.peers.getReceiveAddressPublicKey(target, hash, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
  await federation.stop();
});

test("submission returns the canonical durable ID and rejects an empty explicit ID", async () => {
  const queue = new TestDeliveryQueue();
  const federation = createFederation({
    storage: { lookup: lookup(), delivery: queue },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver() {
          return { status: "accepted" };
        },
      },
    },
  });
  assert.equal(
    (await federation.messages.submit(request, { deliveryId: "  facade_delivery_id  " }))
      .deliveryId,
    "facade_delivery_id",
  );
  await assert.rejects(
    federation.messages.submit(request, { deliveryId: "" }),
    (error) => error instanceof FederationSubmissionError && error.outcome === "not-queued",
  );
  assert.equal(queue.records.size, 0);
  await federation.stop();
});

test("publication preparation does not block delivery and shutdown drains its provider", async () => {
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preparationSignal: AbortSignal | undefined;
  let listed = 0,
    woke = false;
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected publication mutation");
  };
  const queue = new TestDeliveryQueue();
  await queue.enqueue({ ...request, deliveryId: "independent_worker_1" });
  const federation = createFederation({
    storage: {
      lookup: lookup(),
      delivery: queue,
      publications: {
        enqueue: unused,
        markFailed: unused,
        async listDue() {
          listed++;
          return [];
        },
        async countPending() {
          return 0;
        },
        async markSucceeded() {},
        async remove() {},
        async requestRepair() {},
      },
    },
    transport: {
      lookup: unavailable,
      delivery: {
        async deliver() {
          return { status: "accepted" };
        },
      },
    },
    handlers: {
      async preparePublications({ signal }) {
        preparationSignal = signal;
        entered();
        await gate;
      },
      onEvent(event) {
        if (event.type === "delivery-wake") woke = true;
      },
    },
    scheduling: { discovery: false },
  });
  await federation.start();
  await entering;
  await tick();
  assert.equal(woke, true);
  assert.equal(queue.records.size, 0);
  assert.equal(listed, 0);
  let stopped = false;
  const stopping = federation.stop().then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(preparationSignal?.aborted, true);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(listed, 0);
});

test("verified resolution skips an unusable local record and fast invalid peer reply", async () => {
  const badPeer = { onionService: `http://${"c".repeat(56)}.onion` };
  const bad = { ...value, lookupValue: new Uint8Array([1, 2, 3]) };
  const store = {
    ...lookup(),
    async findValue() {
      return bad;
    },
  };
  const contacted: string[] = [];
  const federation = createFederation({
    storage: { lookup: store },
    tor: { bootstrap: [badPeer, target] },
    transport: {
      lookup: {
        async postJson(peer, path) {
          contacted.push(peer);
          if (path.endsWith("/find-node"))
            return { type: "unolock.grid.findNode.response.v1", peers: [] };
          if (peer === target.onionService) await tick();
          return JSON.parse(
            JSON.stringify({
              type: "unolock.grid.findValue.response.v1",
              found: true,
              addressHash: hash,
              storedAt: 1,
              lookupValue: Buffer.from(
                peer === badPeer.onionService ? bad.lookupValue : value.lookupValue,
              ).toString("base64url"),
            }),
          );
        },
      },
    },
    scheduling: { discovery: false, publication: false, delivery: false },
  });
  try {
    assert.deepEqual(await federation.addresses.resolveTargets(hash, routeValidationFingerprint), {
      status: "resolved",
      targets: [target],
    });
    assert.ok(contacted.includes(badPeer.onionService));
    assert.deepEqual(await store.findPinnedValue(hash), value);
  } finally {
    await federation.stop();
  }
});

test("peer maintenance awaits asynchronous storage providers", async () => {
  const federation = createFederation({
    storage: {
      lookup: {
        ...lookup(),
        async findPeersForMaintenance() {
          await tick();
          return [];
        },
        async findPeerCandidates() {
          await tick();
          return [];
        },
        async findBootstrapPeers() {
          await tick();
          return [target];
        },
      },
    },
    tor: { onionService: `http://${"d".repeat(56)}.onion` },
    transport: {
      lookup: {
        async postJson(_peer, path) {
          return path.endsWith("/ping")
            ? { type: "unolock.grid.ping.response.v1", ok: true, checkedAt: 1 }
            : { type: "unolock.grid.findNode.response.v1", peers: [] };
        },
      },
    },
    scheduling: { discovery: false, publication: false, delivery: false },
  });
  try {
    assert.equal((await federation.addresses.refreshPeers())?.probeCount, 1);
  } finally {
    await federation.stop();
  }
});

test("claimed publication uses its fenced snapshot and cannot complete a successor claim", async () => {
  let token = 0;
  let completed = 0;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = {
    async listDue() {
      return [{ addressHash: hash }];
    },
    async requestRepair() {},
    async claim() {
      const mine = ++token;
      return {
        value,
        async complete(success: boolean) {
          assert.equal(mine, token, "stale publication lease");
          if (success) completed++;
        },
      };
    },
  };
  const make = (slow: boolean) =>
    createFederation({
      storage: {
        lookup: {
          ...lookup(),
          async findOwnedValue() {
            throw new Error("Must use the claimed snapshot");
          },
        },
        publications: queue,
      },
      tor: { bootstrap: [target] },
      transport: {
        lookup: {
          async postJson(_peer, path, body) {
            if (path.endsWith("/find-node"))
              return { type: "unolock.grid.findNode.response.v1", peers: [] };
            assert.equal(
              (body as { lookupValue: string }).lookupValue,
              Buffer.from(value.lookupValue).toString("base64url"),
            );
            if (slow) {
              entered();
              await pending;
            }
            return {
              type: "unolock.grid.putValue.response.v1",
              stored: true,
              addressHash: hash,
              storedAt: 1,
            };
          },
        },
      },
      scheduling: { discovery: false, publication: false, delivery: false },
    });
  const first = make(true),
    second = make(false);
  try {
    const stale = first.addresses.processPublications();
    await started;
    assert.equal((await second.addresses.processPublications()).queued, 0);
    release();
    await assert.rejects(stale, /stale publication lease/);
    assert.equal(completed, 1);
  } finally {
    release();
    await Promise.all([first.stop(), second.stop()]);
  }
});
