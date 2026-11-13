import { isIP } from "node:net";
import { fail, integer } from "../errors.js";

export const federationArchiveEndpointHeader = "x-unolock-archive-endpoint";
export const federationDirectPathPrefix = "/federation-direct";
/** HTTPS ingress and transport selection are restricted to encrypted archive bytes. */
export function isFederationArchiveDataRequest(method: string, path: string): boolean {
  return (
    (method === "POST" && path === "/federation/v1/archive/object/read") ||
    (method === "PUT" &&
      [
        "/federation/v1/archive/object",
        "/federation/v1/archive/multipart/part",
        "/federation/v1/archive/relay/part",
      ].includes(path))
  );
}
export function normalizeFederationDirectOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || value !== value.trim())
    fail("invalid-data", "Invalid direct federation origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("invalid-data", "Invalid direct federation origin");
  }
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    isIP(host) ||
    host.startsWith("[") ||
    host.endsWith(".") ||
    !host.includes(".") ||
    host.length > 253 ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /(?:^|\.)(?:onion|localhost|local|internal)$/.test(host) ||
    host.endsWith(".home.arpa")
  )
    fail("invalid-data", "Direct federation requires a public HTTPS domain origin");
  if (url.port) integer(Number(url.port), 1, 65535);
  return url.origin;
}
