import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Env, TokenPayload } from "./types";

const encoder = new TextEncoder();
const passwordHashIterations = 100_000;
const legacyPasswordHashIterations = 210_000;

export function passwordHashNeedsMigration(encodedHash: string): boolean {
  return encodedHash.startsWith(`pbkdf2_sha256$${legacyPasswordHashIterations}$`);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split("$");
  const [algorithm, iterationsText, saltText, expectedText] = parts;
  const iterations = Number(iterationsText);
  if (parts.length !== 4 || algorithm !== "pbkdf2_sha256") return false;
  if (iterationsText !== String(passwordHashIterations) && iterationsText !== String(legacyPasswordHashIterations)) return false;
  if (!saltText || !expectedText) return false;

  try {
    const salt = fromBase64Url(saltText);
    const expected = fromBase64Url(expectedText);
    if (salt.length !== 16 || expected.length !== 32) return false;
    // Legacy hashes exceed Workers' Web Crypto PBKDF2 limit. Use the
    // portable implementation only for these existing hashes.
    if (iterations === legacyPasswordHashIterations) {
      const actual = await pbkdf2Async(sha256, encoder.encode(password), salt, { c: iterations, dkLen: 32 });
      return timingSafeEqual(actual, expected);
    }
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const actual = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      256,
    ));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function createPasswordHash(password: string): Promise<string> {
  const iterations = passwordHashIterations;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256,
  ));
  return `pbkdf2_sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createAccessToken(
  env: Env,
  subject: string,
  role: string,
  version: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const configuredTtl = Number(env.ACCESS_TOKEN_TTL_SECONDS ?? 28_800);
  const ttl = Number.isFinite(configuredTtl) ? Math.min(Math.max(configuredTtl, 300), 86_400) : 28_800;
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = toBase64Url(encoder.encode(JSON.stringify({ sub: subject, role, version, iat: now, exp: now + ttl })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env.JWT_SECRET), encoder.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${toBase64Url(signature)}`;
}

export async function verifyAccessToken(env: Env, token: string): Promise<TokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const verified = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env.JWT_SECRET),
      fromBase64Url(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!verified) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as Partial<TokenPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.sub !== "string" || typeof payload.role !== "string") return null;
    if (!Number.isInteger(payload.version) || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if ((payload.exp as number) <= now || (payload.iat as number) > now + 60) return null;
    return payload as TokenPayload;
  } catch {
    return null;
  }
}
