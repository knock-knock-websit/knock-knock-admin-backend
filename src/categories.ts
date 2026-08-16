import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { AdminSessionRow, Env } from "./types";

type CategoryRow = {
  id: string;
  name: string;
  parent_id: string | null;
  level: number;
  product_count: number;
  sort_order: number;
  active: number;
};

type CategoryPayload = {
  name?: unknown;
  parentId?: unknown;
  sortOrder?: unknown;
  enabled?: unknown;
};

function serializeCategory(row: CategoryRow) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id ?? undefined,
    level: row.level,
    productCount: row.product_count,
    sortOrder: row.sort_order,
    enabled: Boolean(row.active),
    children: [] as CategoryData[],
  };
}

type CategoryData = {
  id: string;
  name: string;
  parentId?: string;
  level: number;
  productCount: number;
  sortOrder: number;
  enabled: boolean;
  children: CategoryData[];
};

function buildCategoryTree(rows: CategoryRow[]): CategoryData[] {
  const nodes = new Map(rows.map((row) => {
    const category = serializeCategory(row);
    return [category.id, category] as const;
  }));
  const roots: CategoryData[] = [];

  for (const category of nodes.values()) {
    const parent = category.parentId ? nodes.get(category.parentId) : undefined;
    if (parent) parent.children.push(category);
    else roots.push(category);
  }

  const sort = (categories: CategoryData[]) => {
    categories.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-TW"));
    categories.forEach((category) => sort(category.children));
  };
  sort(roots);
  return roots;
}

async function authorize(
  request: Request,
  env: Env,
  action: "view" | "create" | "edit" | "delete",
): Promise<AdminSessionRow | Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "categories", action)) {
    return errorResponse(request, env, "您沒有執行此分類操作的權限", 403);
  }
  return admin;
}

async function parsePayload(request: Request, env: Env): Promise<CategoryPayload | Response> {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return errorResponse(request, env, "JSON 格式不正確", 400);
    }
    return payload as CategoryPayload;
  } catch {
    return errorResponse(request, env, "JSON 格式不正確", 400);
  }
}

function readName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 80 ? name : null;
}

function readParentId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return typeof value === "string" && value.length <= 100 ? value : undefined;
}

function readSortOrder(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999_999
    ? value
    : null;
}

async function getRow(env: Env, id: string): Promise<CategoryRow | null> {
  return env.DB.prepare(`
    SELECT
      c.id, c.name, c.parent_id, c.level, c.sort_order, c.active,
      (SELECT COUNT(*) FROM products p WHERE p.category = c.name) AS product_count
    FROM product_categories c
    WHERE c.id = ?
  `).bind(id).first<CategoryRow>();
}

async function nameExists(env: Env, name: string, excludingId?: string): Promise<boolean> {
  const duplicate = await env.DB.prepare(`
    SELECT id FROM product_categories
    WHERE lower(name) = lower(?) AND (? IS NULL OR id <> ?)
    LIMIT 1
  `).bind(name, excludingId ?? null, excludingId ?? null).first<{ id: string }>();
  return Boolean(duplicate);
}

async function resolveLevel(
  request: Request,
  env: Env,
  parentId: string | null,
  currentId?: string,
): Promise<number | Response> {
  if (!parentId) return 0;
  if (parentId === currentId) return errorResponse(request, env, "分類不能設為自己的上層分類", 400);

  const parent = await env.DB.prepare(
    "SELECT id, level FROM product_categories WHERE id = ?",
  ).bind(parentId).first<{ id: string; level: number }>();
  if (!parent) return errorResponse(request, env, "找不到指定的上層分類", 400);

  if (currentId) {
    const cycle = await env.DB.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM product_categories WHERE parent_id = ?
        UNION ALL
        SELECT child.id
        FROM product_categories child
        INNER JOIN descendants d ON child.parent_id = d.id
      )
      SELECT id FROM descendants WHERE id = ? LIMIT 1
    `).bind(currentId, parentId).first<{ id: string }>();
    if (cycle) return errorResponse(request, env, "上層分類不能選擇目前分類的子分類", 400);
  }

  const level = parent.level + 1;
  if (level > 2) return errorResponse(request, env, "商品分類最多支援三層", 400);
  return level;
}

export async function listCategories(request: Request, env: Env): Promise<Response> {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const result = await env.DB.prepare(`
    SELECT
      c.id, c.name, c.parent_id, c.level, c.sort_order, c.active,
      (SELECT COUNT(*) FROM products p WHERE p.category = c.name) AS product_count
    FROM product_categories c
    ORDER BY c.level ASC, c.sort_order ASC, c.name ASC
  `).all<CategoryRow>();
  return respond(request, env, buildCategoryTree(result.results));
}

export async function createCategory(request: Request, env: Env): Promise<Response> {
  const admin = await authorize(request, env, "create");
  if (admin instanceof Response) return admin;
  const payload = await parsePayload(request, env);
  if (payload instanceof Response) return payload;

  const name = readName(payload.name);
  const parentId = payload.parentId === undefined ? null : readParentId(payload.parentId);
  const sortOrder = payload.sortOrder === undefined ? 0 : readSortOrder(payload.sortOrder);
  const enabled = payload.enabled === undefined ? true : payload.enabled;
  if (!name) return errorResponse(request, env, "分類名稱須為 1 至 80 個字元", 400);
  if (parentId === undefined) return errorResponse(request, env, "上層分類格式不正確", 400);
  if (sortOrder === null) return errorResponse(request, env, "排序須為 0 至 999999 的整數", 400);
  if (typeof enabled !== "boolean") return errorResponse(request, env, "啟用狀態格式不正確", 400);
  if (await nameExists(env, name)) return errorResponse(request, env, "分類名稱已存在", 409);

  const level = await resolveLevel(request, env, parentId);
  if (level instanceof Response) return level;
  const id = `cat_${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO product_categories (id, name, parent_id, level, product_count, sort_order, active)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).bind(id, name, parentId, level, sortOrder, enabled ? 1 : 0).run();
  const row = await getRow(env, id);
  return respond(request, env, serializeCategory(row!), "分類已建立", 201);
}

export async function updateCategory(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const admin = await authorize(request, env, "edit");
  if (admin instanceof Response) return admin;
  const current = await getRow(env, id);
  if (!current) return errorResponse(request, env, "找不到指定分類", 404);
  const payload = await parsePayload(request, env);
  if (payload instanceof Response) return payload;

  const name = payload.name === undefined ? current.name : readName(payload.name);
  const parentIdValue = readParentId(payload.parentId);
  const parentId = payload.parentId === undefined ? current.parent_id : parentIdValue;
  const sortOrder = payload.sortOrder === undefined ? current.sort_order : readSortOrder(payload.sortOrder);
  const enabled = payload.enabled === undefined ? Boolean(current.active) : payload.enabled;
  if (!name) return errorResponse(request, env, "分類名稱須為 1 至 80 個字元", 400);
  if (parentId === undefined) return errorResponse(request, env, "上層分類格式不正確", 400);
  if (sortOrder === null) return errorResponse(request, env, "排序須為 0 至 999999 的整數", 400);
  if (typeof enabled !== "boolean") return errorResponse(request, env, "啟用狀態格式不正確", 400);
  if (await nameExists(env, name, id)) return errorResponse(request, env, "分類名稱已存在", 409);

  const level = await resolveLevel(request, env, parentId, id);
  if (level instanceof Response) return level;
  const depth = await env.DB.prepare(`
    WITH RECURSIVE descendants(id, depth) AS (
      SELECT id, 1 FROM product_categories WHERE parent_id = ?
      UNION ALL
      SELECT child.id, d.depth + 1
      FROM product_categories child
      INNER JOIN descendants d ON child.parent_id = d.id
    )
    SELECT COALESCE(MAX(depth), 0) AS max_depth FROM descendants
  `).bind(id).first<{ max_depth: number }>();
  if (level + (depth?.max_depth ?? 0) > 2) {
    return errorResponse(request, env, "移動後的分類結構會超過三層", 400);
  }

  const delta = level - current.level;
  const statements = [
    env.DB.prepare(`
      UPDATE product_categories
      SET name = ?, parent_id = ?, level = ?, sort_order = ?, active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(name, parentId, level, sortOrder, enabled ? 1 : 0, id),
  ];
  if (delta !== 0) {
    statements.push(env.DB.prepare(`
      UPDATE product_categories
      SET level = level + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM product_categories WHERE parent_id = ?
          UNION ALL
          SELECT child.id
          FROM product_categories child
          INNER JOIN descendants d ON child.parent_id = d.id
        )
        SELECT id FROM descendants
      )
    `).bind(delta, id));
  }
  if (name !== current.name) {
    statements.push(env.DB.prepare(`
      UPDATE products SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ?
    `).bind(name, current.name));
  }
  await env.DB.batch(statements);
  const row = await getRow(env, id);
  return respond(request, env, serializeCategory(row!), "分類已更新");
}

export async function deleteCategory(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const admin = await authorize(request, env, "delete");
  if (admin instanceof Response) return admin;
  const current = await getRow(env, id);
  if (!current) return errorResponse(request, env, "找不到指定分類", 404);
  const child = await env.DB.prepare(
    "SELECT id FROM product_categories WHERE parent_id = ? LIMIT 1",
  ).bind(id).first<{ id: string }>();
  if (child) return errorResponse(request, env, "請先移動或刪除此分類的子分類", 409);
  if (current.product_count > 0) return errorResponse(request, env, "仍有商品使用此分類，無法刪除", 409);
  await env.DB.prepare("DELETE FROM product_categories WHERE id = ?").bind(id).run();
  return respond(request, env, null, "分類已刪除");
}
