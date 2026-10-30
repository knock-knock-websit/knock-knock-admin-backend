import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let worker;
let db;
let token;
let productId;

const product = {
  name: "成本測試商品", code: "COST-TEST", category: "測試分類", categoryId: "cost-category",
  price: 500, compareAtPrice: null, safetyStock: 0, sortOrder: 0,
  brand: "KNOCK-KNOCK", description: "測試商品", seoTitle: "", seoDescription: "",
  status: "inactive", scheduledPublishAt: null, tagType: "none",
  images: [{ id: "test-image", imageUrl: "https://example.com/product.png", altText: "", sortOrder: 0, isPrimary: true }],
  colorImages: [], specificationsEnabled: false, specifications: [],
  variants: [{ id: "test-variant", sku: "COST-TEST-SKU", optionValueIds: [], optionValues: [],
    price: 500, cost: 0, compareAtPrice: null, stock: 10, safetyStock: 0, reserved: 0,
    imageUrl: null, purchasable: true }],
};

before(async () => {
  const result = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
  worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: result.outputFiles[0].text, compatibilityDate: "2026-05-22",
    d1Databases: ["DB"],
    bindings: { JWT_SECRET: "test-secret-for-product-cost-at-least-32-characters", ADMIN_ORIGIN: "http://localhost:5173" },
  }));
  db = await worker.getD1Database("DB");
  const migrations = new URL("../../knock-knock-database/migrations/", import.meta.url);
  // Product and admin schemas, plus scheduling and view-count fields used by the API.
  const names = (await readdir(migrations)).filter((name) =>
    /^(000[1-9]|001[0-2])_/.test(name) ||
    ["0021_product_scheduled_publish.sql", "0032_product_view_count.sql"].includes(name),
  ).sort();
  for (const name of names) {
    const sql = await readFile(new URL(name, migrations), "utf8");
    for (const statement of sql.split(";").filter((part) => part.trim())) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO products (id, slug, name, category, price, cost, visual, tone) VALUES ('legacy-cost-product', 'legacy-cost', 'Legacy', 'Test', 100, 42, 'image', 'neutral')").run();
  await db.prepare("INSERT INTO product_variants (id, product_id, sku, price, stock) VALUES ('legacy-cost-variant', 'legacy-cost-product', 'LEGACY-COST', 100, 0)").run();
  const costMigration = await readFile(new URL("0037_product_variant_cost.sql", migrations), "utf8");
  for (const statement of costMigration.split(";").filter((part) => part.trim())) await db.prepare(statement).run();
  assert.equal((await db.prepare("SELECT cost FROM product_variants WHERE id = 'legacy-cost-variant'").first()).cost, 42);
  await db.prepare("DELETE FROM product_variants WHERE id = 'legacy-cost-variant'").run();
  await db.prepare("DELETE FROM products WHERE id = 'legacy-cost-product'").run();
  const password = "product-cost-test-password";
  const salt = Buffer.from("0123456789abcdef");
  const hash = `pbkdf2_sha256$100000$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("base64url")}`;
  await db.prepare("INSERT INTO admin_users (id, role_id, email, name, password_hash) VALUES ('cost-admin', 'role_super_admin', 'cost@example.com', 'Test Admin', ?)").bind(hash).run();
  await db.prepare("INSERT INTO product_categories (id, name) VALUES ('cost-category', '測試分類')").run();
  const login = await worker.dispatchFetch("http://localhost/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "cost@example.com", password }),
  });
  assert.equal(login.status, 200);
  token = (await login.json()).data.accessToken;
});

after(async () => { await worker?.dispose(); });

function request(method, path, payload) {
  return worker.dispatchFetch(`http://localhost/api/admin/products${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}

test("SKU cost is saved on create, update, detail, and list, including zero", async () => {
  const created = await request("POST", "", product);
  const body = await created.json();
  assert.equal(created.status, 201, JSON.stringify(body));
  productId = body.data.id;
  assert.equal(body.data.cost, 0);
  for (const cost of [360, 999_999_999, 0]) {
    const updated = await request("PUT", `/${productId}`, { ...product, variants: product.variants.map((variant) => ({ ...variant, cost })) });
    assert.equal(updated.status, 200);
    const saved = (await updated.json()).data;
    assert.equal(saved.cost, cost);
    assert.equal(saved.variants[0].cost, cost);
    const detail = await request("GET", `/${productId}`);
    assert.equal((await detail.json()).data.variants[0].cost, cost);
    const list = await request("GET", "");
    assert.equal((await list.json()).data.find((item) => item.id === productId).variants[0].cost, cost);
    assert.equal((await db.prepare("SELECT cost FROM products WHERE id = ?").bind(productId).first()).cost, cost);
    assert.equal((await db.prepare("SELECT cost FROM product_variants WHERE product_id = ?").bind(productId).first()).cost, cost);
  }
});

test("create and update reject missing, empty, nonnumeric, negative, fractional, and oversized costs without writing", async () => {
  for (const cost of [undefined, null, "", "360", " ", false, -1, 1.5, 1_000_000_000]) {
    for (const [method, path] of [["POST", ""], ["PUT", `/${productId}`]]) {
      const response = await request(method, path, { ...product, variants: product.variants.map((variant) => ({ ...variant, cost })) });
      assert.equal(response.status, 400, `${method}: ${String(cost)}`);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.match(body.message, /SKU COST-TEST-SKU 的成本必填/);
    }
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM products").first()).count, 1);
  assert.equal((await db.prepare("SELECT cost FROM products WHERE id = ?").bind(productId).first()).cost, 0);
});

test("each SKU retains its own cost, and product summary ignores a stale top-level cost", async () => {
  const options = [
    { id: "size-small", name: "S", sortOrder: 0 },
    { id: "size-large", name: "L", sortOrder: 1 },
  ];
  const input = {
    ...product,
    code: "MULTI-COST",
    cost: 999,
    specificationsEnabled: true,
    specifications: [{ id: "size", name: "尺寸", sortOrder: 0, options }],
    variants: options.map((option, index) => ({
      ...product.variants[0], id: `multi-cost-${index}`, sku: `MULTI-COST-${index}`,
      cost: [150, 250][index], optionValueIds: [option.id],
      optionValues: [{ specificationId: "size", specificationName: "尺寸", optionId: option.id, optionName: option.name }],
    })),
  };
  const created = await request("POST", "", input);
  const body = await created.json();
  assert.equal(created.status, 201, JSON.stringify(body));
  assert.equal(body.data.cost, 150);
  assert.deepEqual(body.data.variants.map((variant) => variant.cost), [150, 250]);
  input.variants[1].cost = 50;
  const updated = await request("PUT", `/${body.data.id}`, input);
  const saved = await updated.json();
  assert.equal(updated.status, 200, JSON.stringify(saved));
  assert.equal(saved.data.cost, 50);
  assert.deepEqual(saved.data.variants.map((variant) => variant.cost), [150, 50]);
  const detail = await request("GET", `/${body.data.id}`);
  assert.deepEqual((await detail.json()).data.variants.map((variant) => variant.cost), [150, 50]);
});
