// Offline validation driver, not application setup. The example itself uses
// createFederation and its normal SOCKS connector with no factory substitution.
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { runTwoNodes } from "../examples/two-nodes.mjs";

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
const close = (server) => new Promise((resolve) => server.close(resolve));

// Reserve distinct listener ports while configuring the proxy, then hand them
// to the example's public TorConfiguration. No library internals are imported.
const reservations = [createServer(), createServer()];
const sockets = new Set();
const requestedHosts = new Set();
const senderHost = `${"a".repeat(56)}.onion`;
const receiverHost = `${"b".repeat(56)}.onion`;
const proxy = createServer();
try {
  const [senderPort, receiverPort] = await Promise.all(reservations.map(listen));
  const routes = new Map([
    [senderHost, senderPort],
    [receiverHost, receiverPort],
  ]);
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(15_000, () => socket.destroy());
    let buffered = Buffer.alloc(0);
    let greeted = false;
    const receive = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 1024) return socket.destroy();
      if (!greeted && buffered.length >= 3) {
        if (!buffered.subarray(0, 3).equals(Buffer.from([5, 1, 0]))) return socket.destroy();
        buffered = buffered.subarray(3);
        greeted = true;
        socket.write(Buffer.from([5, 0]));
      }
      if (!greeted || buffered.length < 5) return;
      const length = buffered[4];
      if (buffered.length < 7 + length) return;
      const host = buffered.subarray(5, 5 + length).toString("ascii");
      const port = routes.get(host);
      if (
        !buffered.subarray(0, 4).equals(Buffer.from([5, 1, 0, 3])) ||
        buffered.readUInt16BE(5 + length) !== 80 ||
        !port
      ) {
        return socket.destroy();
      }
      requestedHosts.add(host);
      socket.removeListener("data", receive);
      const upstream = connect(port, "127.0.0.1");
      sockets.add(upstream);
      upstream.on("error", () => socket.destroy());
      upstream.once("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
      socket.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        const remainder = buffered.subarray(7 + length);
        if (remainder.length) upstream.write(remainder);
        socket.pipe(upstream).pipe(socket);
      });
    };
    socket.on("data", receive);
  });
  const socksPort = await listen(proxy);
  await Promise.all(reservations.map(close));
  await runTwoNodes({
    senderTor: {
      onionService: `http://${senderHost}`,
      socksProxy: { host: "127.0.0.1", port: socksPort },
      listen: { host: "127.0.0.1", port: senderPort },
      bootstrap: [{ onionService: `http://${receiverHost}` }],
    },
    receiverTor: {
      onionService: `http://${receiverHost}`,
      socksProxy: { host: "127.0.0.1", port: socksPort },
      listen: { host: "127.0.0.1", port: receiverPort },
      bootstrap: [{ onionService: `http://${senderHost}` }],
    },
  });
  assert.ok(requestedHosts.has(receiverHost), "Example must reach the receiver through SOCKS");
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all([close(proxy), ...reservations.map(close)]);
}
