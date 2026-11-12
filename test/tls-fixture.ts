import { generateKeyPairSync, sign } from "node:crypto";

// Disposable certificates generated in memory. No keys/credentials or external
// OpenSSL executable are needed in the repository or default test environment.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const bytes: number[] = [];
  for (let size = body.length; size; size >>>= 8) bytes.unshift(size & 255);
  return Buffer.concat([
    Buffer.from([tag, ...(body.length < 128 ? [body.length] : [128 | bytes.length, ...bytes])]),
    body,
  ]);
}
function oid(text: string): Buffer {
  const [first, second, ...rest] = text.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const encoded = [part & 127];
    for (let left = Math.floor(part / 128); left; left = Math.floor(left / 128))
      encoded.unshift(128 | (left & 127));
    bytes.push(...encoded);
  }
  return der(6, Buffer.from(bytes));
}
export function tlsFixture(hostname = "peer.federation.test") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = der(48, oid("1.2.840.113549.1.1.11"), der(5));
  const subject = der(48, der(49, der(48, oid("2.5.4.3"), der(12, Buffer.from(hostname)))));
  const time = (offset: number) =>
    der(
      24,
      Buffer.from(
        new Date(Date.now() + offset)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d+Z$/, "Z")
          .replace("T", ""),
      ),
    );
  const body = der(
    48,
    der(160, der(2, Buffer.from([2]))),
    der(2, Buffer.from([1])),
    algorithm,
    subject,
    der(48, time(-86_400_000), time(86_400_000)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    der(163, der(48, der(48, oid("2.5.29.17"), der(4, der(48, der(130, Buffer.from(hostname))))))),
  );
  const certificate = der(
    48,
    body,
    algorithm,
    der(3, Buffer.from([0]), sign("sha256", body, privateKey)),
  );
  const pem = (label: string, bytes: Buffer) =>
    `-----BEGIN ${label}-----\n${bytes
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END ${label}-----\n`;
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: pem("CERTIFICATE", certificate),
  };
}
