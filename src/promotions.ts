import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { AdminSessionRow, Env } from "./types";

type PromotionInput = {
  name: string;
  description: string;
  promotionMethod: "coupon" | "promo_code" | "automatic";
  discountType: "fixed" | "percentage" | "free_shipping";
  discountValue: number;
  maxDiscount: number | null;
  minOrderAmount: number;
  scopeType: "all" | "products" | "categories";
  memberType: "all" | "new_member" | "vip" | "specific_users";
  startAt: string;
  endAt: string;
  totalUsageLimit: number | null;
  perUserLimit: number;
  claimLimit: number | null;
  couponValidDays: number | null;
  autoGrantNewMember: boolean;
  status: "draft" | "active" | "disabled" | "expired";
  productIds: string[];
  categoryIds: string[];
  userIds: string[];
};

const columns = `
  promotion.id, promotion.name, promotion.description,
  promotion.promotion_method AS promotionMethod,
  promotion.discount_type AS discountType,
  promotion.discount_value AS discountValue,
  promotion.max_discount AS maxDiscount,
  promotion.min_order_amount AS minOrderAmount,
  promotion.scope_type AS scopeType,
  promotion.member_type AS memberType,
  promotion.start_at AS startAt, promotion.end_at AS endAt,
  promotion.total_usage_limit AS totalUsageLimit,
  promotion.per_user_limit AS perUserLimit,
  promotion.claim_limit AS claimLimit,
  promotion.coupon_valid_days AS couponValidDays,
  promotion.auto_grant_new_member AS autoGrantNewMember,
  promotion.claimed_count AS claimedCount,
  promotion.used_count AS usedCount,
  promotion.status, promotion.created_at AS createdAt,
  promotion.updated_at AS updatedAt
`;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

async function parseInput(request: Request): Promise<PromotionInput | string> {
  let raw: Record<string, unknown>;
  try { raw = await request.json() as Record<string, unknown>; } catch { return "JSON 格式不正確"; }
  const value: PromotionInput = {
    name: typeof raw.name === "string" ? raw.name.trim() : "",
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    promotionMethod: raw.promotionMethod as PromotionInput["promotionMethod"],
    discountType: raw.discountType as PromotionInput["discountType"],
    discountValue: Number(raw.discountValue ?? 0),
    maxDiscount: numberOrNull(raw.maxDiscount),
    minOrderAmount: Number(raw.minOrderAmount ?? 0),
    scopeType: raw.scopeType as PromotionInput["scopeType"],
    memberType: raw.memberType as PromotionInput["memberType"],
    startAt: typeof raw.startAt === "string" ? raw.startAt : "",
    endAt: typeof raw.endAt === "string" ? raw.endAt : "",
    totalUsageLimit: numberOrNull(raw.totalUsageLimit),
    perUserLimit: Number(raw.perUserLimit ?? 1),
    claimLimit: numberOrNull(raw.claimLimit),
    couponValidDays: numberOrNull(raw.couponValidDays),
    autoGrantNewMember: raw.autoGrantNewMember === true,
    status: (raw.status ?? "draft") as PromotionInput["status"],
    productIds: stringIds(raw.productIds), categoryIds: stringIds(raw.categoryIds), userIds: stringIds(raw.userIds),
  };
  if (!value.name || value.name.length > 120) return "優惠名稱需為 1 至 120 個字元";
  if (value.description.length > 2000) return "優惠說明不可超過 2,000 個字元";
  if (!["coupon", "promo_code", "automatic"].includes(value.promotionMethod)) return "優惠方式不正確";
  if (!["fixed", "percentage", "free_shipping"].includes(value.discountType)) return "優惠類型不正確";
  if (!Number.isInteger(value.discountValue) || value.discountValue < 0) return "折扣值不正確";
  if (value.discountType === "fixed" && value.discountValue <= 0) return "固定折抵金額必須大於 0";
  if (value.discountType === "percentage" && (value.discountValue <= 0 || value.discountValue > 100)) return "折扣百分比需介於 1 至 100";
  if (value.discountType === "free_shipping") value.discountValue = 0;
  if (Number.isNaN(value.maxDiscount) || (value.maxDiscount !== null && value.maxDiscount < 0)) return "最高折抵金額不正確";
  if (!Number.isInteger(value.minOrderAmount) || value.minOrderAmount < 0) return "最低消費金額不正確";
  if (!["all", "products", "categories"].includes(value.scopeType)) return "適用商品範圍不正確";
  if (value.scopeType === "products" && !value.productIds.length) return "請至少選擇一項商品";
  if (value.scopeType === "categories" && !value.categoryIds.length) return "請至少選擇一項分類";
  if (!["all", "new_member", "vip", "specific_users"].includes(value.memberType)) return "會員限制不正確";
  if (value.memberType === "specific_users" && !value.userIds.length) return "請至少選擇一位會員";
  if (!value.startAt || !value.endAt || Number.isNaN(Date.parse(value.startAt)) || Number.isNaN(Date.parse(value.endAt)) || Date.parse(value.endAt) <= Date.parse(value.startAt)) return "優惠時間不正確";
  if (![value.totalUsageLimit, value.claimLimit, value.couponValidDays].every((item) => item === null || (Number.isInteger(item) && item > 0))) return "使用限制必須為正整數";
  if (!Number.isInteger(value.perUserLimit) || value.perUserLimit <= 0) return "每會員使用次數必須為正整數";
  if (!["draft", "active", "disabled", "expired"].includes(value.status)) return "優惠狀態不正確";
  return value;
}

async function authorize(request: Request, env: Env, action: string): Promise<AdminSessionRow | Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  const allowed = hasPermission(admin, "coupons", action)
    || hasPermission(admin, "marketing", action)
    || hasPermission(admin, "coupons")
    || hasPermission(admin, "marketing");
  if (!allowed) {
    return errorResponse(request, env, "您沒有優惠管理權限", 403);
  }
  return admin;
}

function relationStatements(env: Env, id: string, input: PromotionInput): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM promotion_products WHERE promotion_id = ?").bind(id),
    env.DB.prepare("DELETE FROM promotion_categories WHERE promotion_id = ?").bind(id),
    env.DB.prepare("DELETE FROM promotion_users WHERE promotion_id = ?").bind(id),
  ];
  if (input.scopeType === "products") input.productIds.forEach((productId) => statements.push(
    env.DB.prepare("INSERT INTO promotion_products (promotion_id, product_id) VALUES (?, ?)").bind(id, productId),
  ));
  if (input.scopeType === "categories") input.categoryIds.forEach((categoryId) => statements.push(
    env.DB.prepare("INSERT INTO promotion_categories (promotion_id, category_id) VALUES (?, ?)").bind(id, categoryId),
  ));
  if (input.memberType === "specific_users") input.userIds.forEach((userId) => statements.push(
    env.DB.prepare("INSERT INTO promotion_users (promotion_id, user_id) VALUES (?, ?)").bind(id, userId),
  ));
  return statements;
}

async function grantSpecificUserCoupons(env: Env, promotionId: string): Promise<number> {
  const promotion = await env.DB.prepare(`
    SELECT promotion_method AS promotionMethod, member_type AS memberType,
      status, end_at AS endAt, coupon_valid_days AS couponValidDays
    FROM promotions WHERE id = ?
  `).bind(promotionId).first<{
    promotionMethod: string;
    memberType: string;
    status: string;
    endAt: string;
    couponValidDays: number | null;
  }>();
  if (!promotion || promotion.promotionMethod !== "coupon" ||
      promotion.memberType !== "specific_users" || promotion.status !== "active" ||
      Date.parse(promotion.endAt) < Date.now()) return 0;

  const users = await env.DB.prepare(`
    SELECT user_id AS userId FROM promotion_users WHERE promotion_id = ?
  `).bind(promotionId).all<{ userId: string }>();
  const daysExpiry = promotion.couponValidDays
    ? Date.now() + promotion.couponValidDays * 86_400_000
    : Date.parse(promotion.endAt);
  const expiresAt = new Date(Math.min(daysExpiry, Date.parse(promotion.endAt))).toISOString();
  let grantedCount = 0;
  for (const user of users.results) {
    try {
      const result = await env.DB.prepare(`
        INSERT INTO user_coupons (id, user_id, promotion_id, expires_at)
        SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM user_coupons WHERE user_id = ? AND promotion_id = ?
        )
      `).bind(
        crypto.randomUUID(), user.userId, promotionId, expiresAt,
        user.userId, promotionId,
      ).run();
      grantedCount += Number(result.meta.changes ?? 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ALREADY_CLAIMED")) continue;
      if (message.includes("CLAIM_LIMIT_REACHED")) break;
      throw error;
    }
  }
  return grantedCount;
}

export async function listPromotions(request: Request, env: Env): Promise<Response> {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 20));
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search")?.trim();
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (status && ["draft", "active", "disabled", "expired"].includes(status)) { conditions.push("promotion.status = ?"); bindings.push(status); }
  if (search) { conditions.push("(promotion.name LIKE ? OR promotion.description LIKE ?)"); bindings.push(`%${search}%`, `%${search}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM promotions promotion ${where}`).bind(...bindings).first<{ count: number }>();
  const result = await env.DB.prepare(`
    SELECT ${columns} FROM promotions promotion ${where}
    ORDER BY promotion.created_at DESC LIMIT ? OFFSET ?
  `).bind(...bindings, pageSize, (page - 1) * pageSize).all<Record<string, unknown>>();
  return respond(request, env, result.results.map((row) => ({ ...row, autoGrantNewMember: Boolean(row.autoGrantNewMember) })), "優惠列表載入成功", 200, { page, pageSize, total: Number(count?.count ?? 0) });
}

export async function getPromotion(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const promotion = await env.DB.prepare(`SELECT ${columns} FROM promotions promotion WHERE promotion.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!promotion) return errorResponse(request, env, "找不到優惠活動", 404);
  const [products, categories, users] = await Promise.all([
    env.DB.prepare("SELECT product_id AS id FROM promotion_products WHERE promotion_id = ?").bind(id).all<{ id: string }>(),
    env.DB.prepare("SELECT category_id AS id FROM promotion_categories WHERE promotion_id = ?").bind(id).all<{ id: string }>(),
    env.DB.prepare("SELECT user_id AS id FROM promotion_users WHERE promotion_id = ?").bind(id).all<{ id: string }>(),
  ]);
  return respond(request, env, {
    ...promotion, autoGrantNewMember: Boolean(promotion.autoGrantNewMember),
    productIds: products.results.map((row) => row.id), categoryIds: categories.results.map((row) => row.id),
    userIds: users.results.map((row) => row.id),
  });
}

export async function createPromotion(request: Request, env: Env): Promise<Response> {
  const admin = await authorize(request, env, "create");
  if (admin instanceof Response) return admin;
  const input = await parseInput(request);
  if (typeof input === "string") return errorResponse(request, env, input, 400);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO promotions (
        id, name, description, promotion_method, discount_type, discount_value,
        max_discount, min_order_amount, scope_type, member_type, start_at, end_at,
        total_usage_limit, per_user_limit, claim_limit, coupon_valid_days,
        auto_grant_new_member, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, input.name, input.description, input.promotionMethod, input.discountType, input.discountValue,
      input.maxDiscount, input.minOrderAmount, input.scopeType, input.memberType,
      input.startAt, input.endAt, input.totalUsageLimit, input.perUserLimit, input.claimLimit,
      input.couponValidDays, input.autoGrantNewMember ? 1 : 0, input.status,
    ),
    ...relationStatements(env, id, input),
  ]);
  const grantedCount = await grantSpecificUserCoupons(env, id);
  return respond(request, env, { id, grantedCount }, "優惠建立成功", 201);
}

export async function updatePromotion(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "edit");
  if (admin instanceof Response) return admin;
  if (!await env.DB.prepare("SELECT 1 FROM promotions WHERE id = ?").bind(id).first()) return errorResponse(request, env, "找不到優惠活動", 404);
  const input = await parseInput(request);
  if (typeof input === "string") return errorResponse(request, env, input, 400);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE promotions SET name = ?, description = ?, promotion_method = ?, discount_type = ?,
        discount_value = ?, max_discount = ?, min_order_amount = ?, scope_type = ?, member_type = ?,
        start_at = ?, end_at = ?, total_usage_limit = ?, per_user_limit = ?, claim_limit = ?,
        coupon_valid_days = ?, auto_grant_new_member = ?, status = ?,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      input.name, input.description, input.promotionMethod, input.discountType, input.discountValue,
      input.maxDiscount, input.minOrderAmount, input.scopeType, input.memberType, input.startAt,
      input.endAt, input.totalUsageLimit, input.perUserLimit, input.claimLimit, input.couponValidDays,
      input.autoGrantNewMember ? 1 : 0, input.status, id,
    ),
    ...relationStatements(env, id, input),
  ]);
  const grantedCount = await grantSpecificUserCoupons(env, id);
  return respond(request, env, { id, grantedCount }, "優惠已更新");
}

export async function updatePromotionStatus(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "edit");
  if (admin instanceof Response) return admin;
  let body: { status?: unknown };
  try { body = await request.json(); } catch { return errorResponse(request, env, "JSON 格式不正確", 400); }
  const status = String(body.status ?? "");
  if (!["draft", "active", "disabled", "expired"].includes(status)) return errorResponse(request, env, "優惠狀態不正確", 400);
  const result = await env.DB.prepare("UPDATE promotions SET status = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, id).run();
  if (!result.meta.changes) return errorResponse(request, env, "找不到優惠活動", 404);
  const grantedCount = await grantSpecificUserCoupons(env, id);
  return respond(request, env, { id, status, grantedCount }, "優惠狀態已更新");
}

export async function listPromotionUsages(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const result = await env.DB.prepare(`
    SELECT usage.id, usage.user_id AS userId, member.name AS userName, member.email,
      usage.promotion_id AS promotionId, usage.user_coupon_id AS userCouponId,
      usage.coupon_code_id AS couponCodeId, code.code, usage.order_id AS orderId,
      usage.discount_amount AS discountAmount, usage.used_at AS usedAt
    FROM coupon_usages usage
    INNER JOIN members member ON member.id = usage.user_id
    LEFT JOIN coupon_codes code ON code.id = usage.coupon_code_id
    WHERE usage.promotion_id = ? ORDER BY usage.used_at DESC
  `).bind(id).all();
  return respond(request, env, result.results, "優惠使用紀錄載入成功");
}

export async function listPromotionCodes(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const result = await env.DB.prepare(`
    SELECT id, code, usage_limit AS usageLimit, used_count AS usedCount,
      enabled, created_at AS createdAt, updated_at AS updatedAt
    FROM coupon_codes WHERE promotion_id = ? ORDER BY created_at DESC
  `).bind(id).all<Record<string, unknown>>();
  return respond(request, env, result.results.map((row) => ({ ...row, enabled: Boolean(row.enabled) })), "優惠碼載入成功");
}

export async function createPromotionCodes(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "create");
  if (admin instanceof Response) return admin;
  const promotion = await env.DB.prepare("SELECT promotion_method AS method FROM promotions WHERE id = ?").bind(id).first<{ method: string }>();
  if (!promotion) return errorResponse(request, env, "找不到優惠活動", 404);
  if (promotion.method !== "promo_code") return errorResponse(request, env, "只有優惠碼活動可以建立優惠碼", 400);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return errorResponse(request, env, "JSON 格式不正確", 400); }
  const usageLimit = numberOrNull(body.usageLimit);
  if (Number.isNaN(usageLimit) || (usageLimit !== null && usageLimit <= 0)) return errorResponse(request, env, "最大使用次數不正確", 400);
  const count = body.count === undefined ? 1 : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > 1000) return errorResponse(request, env, "批次產生數量需介於 1 至 1,000", 400);
  const explicit = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const prefix = typeof body.prefix === "string" ? body.prefix.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "") : "";
  if (!explicit && !prefix) return errorResponse(request, env, "請輸入優惠碼或批次前綴", 400);
  if (explicit && count !== 1) return errorResponse(request, env, "指定優惠碼時只能建立一筆", 400);
  const latest = explicit ? null : await env.DB.prepare(`
    SELECT MAX(CAST(substr(code, ?) AS INTEGER)) AS value
    FROM coupon_codes WHERE promotion_id = ? AND code LIKE ? ESCAPE '\\'
  `).bind(prefix.length + 2, id, `${prefix.replaceAll("%", "\\%").replaceAll("_", "\\_")}-%`).first<{ value: number | null }>();
  const startNumber = Number(latest?.value ?? 0) + 1;
  const codes = explicit ? [explicit] : Array.from({ length: count }, (_, index) => `${prefix}-${String(startNumber + index).padStart(6, "0")}`);
  if (codes.some((code) => code.length < 3 || code.length > 64)) return errorResponse(request, env, "優惠碼長度需為 3 至 64 個字元", 400);
  try {
    await env.DB.batch(codes.map((code) => env.DB.prepare(`
      INSERT INTO coupon_codes (id, promotion_id, code, usage_limit) VALUES (?, ?, ?, ?)
    `).bind(crypto.randomUUID(), id, code, usageLimit)));
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) return errorResponse(request, env, "優惠碼已存在", 409);
    throw error;
  }
  return respond(request, env, { count: codes.length, codes }, "優惠碼建立成功", 201);
}

export async function updatePromotionCode(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "edit");
  if (admin instanceof Response) return admin;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return errorResponse(request, env, "JSON 格式不正確", 400); }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const usageLimit = numberOrNull(body.usageLimit);
  const enabled = body.enabled === undefined ? true : body.enabled === true;
  if (code.length < 3 || code.length > 64 || Number.isNaN(usageLimit) || (usageLimit !== null && usageLimit <= 0)) return errorResponse(request, env, "優惠碼資料不正確", 400);
  const result = await env.DB.prepare(`
    UPDATE coupon_codes SET code = ?, usage_limit = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(code, usageLimit, enabled ? 1 : 0, id).run();
  if (!result.meta.changes) return errorResponse(request, env, "找不到優惠碼", 404);
  return respond(request, env, { id, code, usageLimit, enabled }, "優惠碼已更新");
}

export async function deletePromotionCode(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "delete");
  if (admin instanceof Response) return admin;
  const existing = await env.DB.prepare("SELECT used_count AS usedCount FROM coupon_codes WHERE id = ?").bind(id).first<{ usedCount: number }>();
  if (!existing) return errorResponse(request, env, "找不到優惠碼", 404);
  if (existing.usedCount > 0) {
    await env.DB.prepare("UPDATE coupon_codes SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return respond(request, env, { id, enabled: false }, "優惠碼已有使用紀錄，已改為停用");
  }
  await env.DB.prepare("DELETE FROM coupon_codes WHERE id = ?").bind(id).run();
  return respond(request, env, { id }, "優惠碼已刪除");
}
