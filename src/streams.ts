import { createHash } from "node:crypto";
import type {
  ByteRange,
  ByteStream,
  CallOptions,
  DataSource,
  CiphertextInfo,
} from "./contracts.js";
import { fail, integer } from "./errors.js";
export function rangeWithin(range: ByteRange | undefined, size: number): ByteRange {
  integer(size, 0);
  if (!range) return { offset: 0, length: size };
  integer(range.offset, 0);
  integer(range.length, 1);
  if (!Number.isSafeInteger(range.offset + range.length) || range.offset + range.length > size)
    fail("invalid-data", "Range exceeds the encrypted object");
  return { ...range };
}
export function byteSource(bytes: Uint8Array, sourceId?: string): DataSource {
  const immutable = new Uint8Array(bytes);
  const sha256 = createHash("sha256").update(immutable).digest("base64url");
  return {
    sourceId: sourceId ?? sha256,
    async describe() {
      return { byteLength: immutable.length, sha256 };
    },
    async open(options) {
      options.signal?.throwIfAborted();
      const range = rangeWithin(options.range, immutable.length);
      let offset = range.offset;
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (options.signal?.aborted) {
              controller.error(options.signal.reason);
              return;
            }
            if (offset === range.offset + range.length) {
              controller.close();
              return;
            }
            const end = Math.min(offset + 64 * 1024, range.offset + range.length);
            controller.enqueue(immutable.slice(offset, end));
            offset = end;
          },
        },
        { highWaterMark: 1 },
      );
    },
  };
}
export async function collect(
  stream: ByteStream,
  maxBytes: number,
  options: CallOptions = {},
  expected?: number,
): Promise<Uint8Array> {
  integer(maxBytes, 0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    while (true) {
      const item = await reader.read();
      options.signal?.throwIfAborted();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array))
        fail("invalid-data", "The stream must contain bytes");
      length += item.value.byteLength;
      if (length > maxBytes) fail("limit-exceeded", "Encrypted stream exceeds its limit");
      chunks.push(new Uint8Array(item.value));
    }
    if (expected !== undefined && length !== expected)
      fail("invalid-data", "Encrypted stream length mismatch");
    return Buffer.concat(chunks, length);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
export function tracked(
  stream: ByteStream,
  expected: CiphertextInfo,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let length = 0;
  let complete = false;
  let stopped = false;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    if (!stopped) {
      stopped = true;
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  };
  const output = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const item = await reader.read();
          signal.throwIfAborted();
          if (item.done) {
            if (
              length !== expected.byteLength ||
              (expected.sha256 && hash.digest("base64url") !== expected.sha256)
            )
              fail("invalid-data", "Encrypted stream integrity mismatch");
            complete = true;
            cleanup();
            controller.close();
            return;
          }
          if (
            !(item.value instanceof Uint8Array) ||
            length + item.value.byteLength > expected.byteLength
          )
            fail("invalid-data", "Encrypted stream length mismatch");
          length += item.value.byteLength;
          hash.update(item.value);
          progress(length);
          controller.enqueue(item.value);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          cleanup();
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
        cleanup();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream: output,
    assertComplete() {
      if (!complete) fail("invalid-data", "Receiver returned before consuming the stream");
    },
  };
}
