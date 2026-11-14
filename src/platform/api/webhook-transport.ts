import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { checkWebhookUrl, isBlockedAddress } from "./webhook-target";

/**
 * One attempt to deliver a webhook (WMS-60, ADR 0058). The name is
 * resolved here and every address is checked; the connection goes to the
 * address already validated (a fixed `lookup`), with the original name for
 * TLS. No redirects are followed, the attempt has a time limit and at most
 * RESPONSE_MAX_BYTES of the answer are read and thrown away.
 */

export const DELIVERY_TIMEOUT_MS = 10_000;
export const RESPONSE_MAX_BYTES = 64 * 1024;

export type DeliveryAttempt =
  | { kind: "delivered"; status: number }
  | { kind: "failed"; reason: string; status?: number };

export type Resolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

export type WebhookTransport = (input: {
  url: string;
  body: string;
  headers: Record<string, string>;
}) => Promise<DeliveryAttempt>;

const defaultResolver: Resolver = (host) =>
  dnsLookup(host, { all: true, verbatim: true });

/** The address to connect to, or why there is none. */
export async function resolveTarget(
  host: string,
  resolver: Resolver = defaultResolver,
): Promise<
  { ok: true; address: string; family: number } | { ok: false; reason: string }
> {
  const literal = host.replace(/^\[|\]$/g, "");
  const kind = isIP(literal);
  let addresses: { address: string; family: number }[];
  if (kind !== 0) {
    addresses = [{ address: literal, family: kind }];
  } else {
    try {
      addresses = await resolver(literal);
    } catch {
      return { ok: false, reason: "No se encontró la dirección del destino." };
    }
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "No se encontró la dirección del destino." };
  }
  // If any address is private, none is used: the name could alternate.
  if (addresses.some((each) => isBlockedAddress(each.address))) {
    return {
      ok: false,
      reason: "La dirección apunta a una red privada o reservada.",
    };
  }
  const first = addresses[0]!;
  return {
    ok: true,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

/**
 * A `lookup` for node:https that always answers the validated address,
 * whatever it is asked, so the connection cannot go elsewhere.
 */
export function pinnedLookup(address: string, family: number) {
  return (
    _host: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ) => {
    const all =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: boolean }).all;
    if (all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

export function createTransport(
  options: { resolver?: Resolver; timeoutMs?: number } = {},
): WebhookTransport {
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  return async ({ url, body, headers }) => {
    const checked = checkWebhookUrl(url);
    if (!checked.ok) return { kind: "failed", reason: checked.reason };
    const target = checked.url;
    const resolved = await resolveTarget(target.hostname, options.resolver);
    if (!resolved.ok) return { kind: "failed", reason: resolved.reason };
    return new Promise<DeliveryAttempt>((resolve) => {
      let settled = false;
      const finish = (outcome: DeliveryAttempt) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      const request = httpsRequest(
        {
          protocol: "https:",
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            "user-agent": "WMS-Webhooks/1",
          },
          lookup: pinnedLookup(resolved.address, resolved.family) as never,
          timeout: timeoutMs,
          // Never through a proxy of the environment: the address is fixed.
          agent: false,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          let read = 0;
          response.on("data", (chunk: Buffer) => {
            read += chunk.length;
            if (read > RESPONSE_MAX_BYTES) response.destroy();
          });
          const done = () => {
            if (status >= 200 && status < 300)
              finish({ kind: "delivered", status });
            else if (status >= 300 && status < 400) {
              finish({
                kind: "failed",
                status,
                reason:
                  "El destino respondió con una redirección; no se siguen.",
              });
            } else {
              finish({
                kind: "failed",
                status,
                reason: `El destino respondió ${status}.`,
              });
            }
          };
          response.on("end", done);
          response.on("close", done);
          response.on("error", done);
        },
      );
      const timer = setTimeout(() => {
        request.destroy();
        finish({
          kind: "failed",
          reason: `El destino tardó más de ${Math.round(timeoutMs / 1000)} segundos.`,
        });
      }, timeoutMs);
      timer.unref();
      request.on("timeout", () => {
        request.destroy();
        finish({
          kind: "failed",
          reason: `El destino tardó más de ${Math.round(timeoutMs / 1000)} segundos.`,
        });
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const tls = /CERT|SSL|TLS/i.test(error.code ?? "");
        finish({
          kind: "failed",
          reason: tls
            ? "El certificado del destino no es válido."
            : "No se pudo conectar con el destino.",
        });
      });
      request.on("close", () => clearTimeout(timer));
      request.end(body);
    });
  };
}
