/** Temporary password gate for the app (the landing page stays public).
 * The cookie holds an HMAC of a fixed label keyed by the password, so it
 * reveals nothing about the password and every session ends when the
 * password changes. Works in both the proxy and route handlers. */
import { APP_HOME } from "./routes.ts";

export const GATE_COOKIE = "outcomia_gate";
export const GATE_MAX_AGE = 60 * 60 * 24 * 30;

/** Paths that never need the password. */
export function isPublicPath(pathname: string) {
  return (
    pathname === "/" || pathname === "/unlock" || pathname === "/api/unlock"
  );
}

/** The configured password, or null. Without one, production stays locked
 * and local development stays open. */
export function gatePassword(): string | null {
  const value = process.env.APP_PASSWORD;
  return value && value.length > 0 ? value : null;
}
export function gateDisabled() {
  return !gatePassword() && process.env.NODE_ENV !== "production";
}

export async function gateToken(password: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("outcomia-gate-v1"),
  );
  return Array.from(new Uint8Array(mac), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Constant-time comparison of two equal-format strings. */
export function sameText(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function hasAccess(cookie: string | undefined) {
  if (gateDisabled()) return true;
  const password = gatePassword();
  if (!password || !cookie) return false;
  return sameText(cookie, await gateToken(password));
}

/** Only same-site absolute paths may be redirect targets. */
export function safeNext(value: unknown) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    !value.startsWith("/unlock")
    ? value
    : APP_HOME;
}
