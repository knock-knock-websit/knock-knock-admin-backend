import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const password = "test-password-for-migration";
const salt = Buffer.from("0123456789abcdef");
function hash(iterations) {
  return `pbkdf2_sha256$${iterations}$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url")}`;
}
const legacyHash = hash(210_000);
let worker;
let db;

before(async () => {
  const result = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
  worker = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: "2026-05-22",
    d1Databases: ["DB"],
    bindings: { JWT_SECRET: "test-secret-for-auth-migration-at-least-32-characters", ADMIN_ORIGIN: "http://localhost:5173" },
  }));
  db = await worker.getD1Database("DB");
  for (const name of ["0002_admin_roles.sql", "0003_admin_users.sql"]) {
    const sql = await readFile(new URL(`../../knock-knock-database/migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").filter((part) => part.trim())) await db.prepare(statement).run();
  }
  await db.prepare("CREATE TABLE products (status TEXT, active INTEGER, scheduled_publish_at TEXT, updated_at TEXT)").run();
  await db.prepare("INSERT INTO admin_users (id, role_id, email, name, password_hash) VALUES ('test-admin', 'role_super_admin', 'test@example.com', 'Test Admin', ?)").bind(legacyHash).run();
});

after(async () => { await worker?.dispose(); });

async function reset(encodedHash = legacyHash, active = 1, lockedUntil = null) {
  await db.prepare("UPDATE admin_users SET password_hash = ?, active = ?, locked_until = ?, failed_login_count = 0").bind(encodedHash, active, lockedUntil).run();
}
async function login(value = password) {
  return worker.dispatchFetch("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ email: "test@example.com", password: value }),
  });
}
async function account() {
  return db.prepare("SELECT password_hash, failed_login_count FROM admin_users").first();
}

test("legacy password logs in, migrates once, and issues a valid session", async () => {
  await reset();
  const response = await login();
  assert.equal(response.status, 200);
  const { data } = await response.json();
  const migrated = await account();
  assert.match(migrated.password_hash, /^pbkdf2_sha256\$100000\$/);
  assert.notEqual(migrated.password_hash.split("$")[2], salt.toString("base64url"));
  assert.equal(migrated.failed_login_count, 0);
  const me = await worker.dispatchFetch("http://localhost/api/auth/me", { headers: { Authorization: `Bearer ${data.accessToken}` } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.email, "test@example.com");
  assert.equal((await login()).status, 200);
  assert.equal((await account()).password_hash, migrated.password_hash);
});

test("wrong legacy password is rejected without migrating", async () => {
  await reset();
  assert.equal((await login("wrong-password")).status, 401);
  assert.deepEqual(await account(), { password_hash: legacyHash, failed_login_count: 1 });
});

test("current hashes still reject wrong passwords and accept correct ones", async () => {
  const current = hash(100_000);
  await reset(current);
  assert.equal((await login("wrong-password")).status, 401);
  assert.equal((await login()).status, 200);
  assert.equal((await account()).password_hash, current);
});

test("inactive and locked accounts cannot migrate with a correct password", async () => {
  for (const [active, locked] of [[0, null], [1, "2999-01-01T00:00:00Z"]]) {
    await reset(legacyHash, active, locked);
    assert.equal((await login()).status, 401);
    assert.equal((await account()).password_hash, legacyHash);
  }
});

test("unsupported iterations and malformed hashes fail closed", async () => {
  for (const encoded of [hash(100_001), legacyHash + "$extra", legacyHash.replace("pbkdf2_sha256", "unknown"), "pbkdf2_sha256$210000$invalid!$invalid!", "pbkdf2_sha256$210000$YQ$YQ"]) {
    await reset(encoded);
    assert.equal((await login()).status, 401);
    assert.equal((await account()).password_hash, encoded);
  }
});
