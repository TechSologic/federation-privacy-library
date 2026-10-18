/** Compile-time checks of the installed application's intended contract. */
import { createFederation, type FederationDeliveryResult } from "../src/index.js";
// @ts-expect-error Accepted custody cannot simultaneously instruct a retry.
const contradictory: FederationDeliveryResult = { status: "accepted", retryAfterMs: 1000 };
void contradictory;
// @ts-expect-error Handlers belong in the explicit handlers object.
createFederation({ storage: {}, messages: { receiver: { async receive() {} } } });
