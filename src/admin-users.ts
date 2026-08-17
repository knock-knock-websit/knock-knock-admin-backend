import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import { createPasswordHash } from "./security";
import type { Env, PermissionMap } from "./types";

const resources = ["products", "categories", "orders", "customers", "payments", "logistics", "coupons", "content", "reports", "admins", "logs", "settings"] as const;
const allActions = ["view", "create", "edit", "delete", "export"];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function superAdmin(request: Request, env: Env, action: "create" | "edit" | "delete") {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (admin.role_code !== "super_admin" || !hasPermission(admin, "admins", action)) {
    const actionLabel = action === "create" ? "新增" : action === "edit" ? "編輯" : "刪除";
    return errorResponse(request, env, `只有超級管理員可以${actionLabel}角色`, 403);
  }
  return admin;
}

export async function listAdminUsers(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "admins", "view")) return errorResponse(request, env, "您沒有檢視管理員帳號的權限", 403);
  const result = await env.DB.prepare(`
    SELECT user.id, user.email, user.name, user.active, user.last_login_at AS lastLoginAt,
      user.created_at AS createdAt, role.id AS roleId, role.code AS roleCode,
      role.name AS roleName, role.permissions
    FROM admin_users user INNER JOIN admin_roles role ON role.id = user.role_id
    WHERE role.active = 1
    ORDER BY user.created_at DESC
  `).all<{ id: string; email: string; name: string; active: number; lastLoginAt: string | null; createdAt: string; roleId: string; roleCode: string; roleName: string; permissions: string }>();
  return respond(request, env, result.results.map((row) => ({
    ...row, active: Boolean(row.active), permissions: JSON.parse(row.permissions) as PermissionMap,
  })));
}

export async function createAdminUser(request: Request, env: Env): Promise<Response> {
  const admin = await superAdmin(request, env, "create");
  if (admin instanceof Response) return admin;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return errorResponse(request, env, "JSON 格式不正確", 400); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const roleName = typeof body.roleName === "string" ? body.roleName.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const selected = Array.isArray(body.resources) ? body.resources.filter((value): value is string => typeof value === "string") : [];
  if (!emailPattern.test(email) || !name || name.length > 80 || !roleName || roleName.length > 80) {
    return errorResponse(request, env, "帳號、姓名或角色格式不正確", 400);
  }
  if (password.length < 8 || password.length > 128) return errorResponse(request, env, "密碼需為 8 至 128 個字元", 400);
  const selectedResources = [...new Set(selected)].filter((value): value is typeof resources[number] => resources.includes(value as typeof resources[number]));
  const existing = await env.DB.prepare("SELECT 1 FROM admin_users WHERE email = ?").bind(email).first();
  if (existing) return errorResponse(request, env, "此管理員帳號已存在", 409);
  const permissions = Object.fromEntries(selectedResources.map((resource) => [resource, allActions]));
  const roleId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const roleCode = `custom_${roleId.replaceAll("-", "").slice(0, 16)}`;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO admin_roles (id, code, name, description, permissions, is_system)
      VALUES (?, ?, ?, ?, ?, 0)
    `).bind(roleId, roleCode, roleName, `${name} 的自訂角色`, JSON.stringify(permissions)),
    env.DB.prepare(`
      INSERT INTO admin_users (id, role_id, email, name, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, roleId, email, name, await createPasswordHash(password)),
  ]);
  return respond(request, env, {
    id: userId, email, name, roleId, roleCode, roleName, permissions,
    active: true, lastLoginAt: null,
  }, "管理員帳號與角色已建立", 201);
}

function roleInput(body: Record<string, unknown>) {
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const roleName = typeof body.roleName === "string" ? body.roleName.trim() : "";
  const selected = Array.isArray(body.resources)
    ? body.resources.filter((value): value is string => typeof value === "string")
    : [];
  if (!accountId || !name || name.length > 80 || !roleName || roleName.length > 80) return null;
  const selectedResources = [...new Set(selected)]
    .filter((value): value is typeof resources[number] => resources.includes(value as typeof resources[number]));
  return {
    accountId,
    name,
    roleName,
    permissions: Object.fromEntries(selectedResources.map((resource) => [resource, allActions])),
  };
}

export async function updateAdminRole(request: Request, env: Env, roleId: string): Promise<Response> {
  const admin = await superAdmin(request, env, "edit");
  if (admin instanceof Response) return admin;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return errorResponse(request, env, "JSON 格式不正確", 400); }
  const input = roleInput(body);
  if (!input) return errorResponse(request, env, "角色資料格式不正確", 400);
  const [role, account] = await Promise.all([
    env.DB.prepare(`SELECT id FROM admin_roles WHERE id = ? AND is_system = 0 AND active = 1`).bind(roleId).first(),
    env.DB.prepare(`SELECT id FROM admin_users WHERE id = ? AND role_id = ? AND active = 1`).bind(input.accountId, roleId).first(),
  ]);
  if (!role) return errorResponse(request, env, "找不到可編輯的自訂角色；系統角色不可編輯", 404);
  if (!account) return errorResponse(request, env, "找不到此角色綁定的管理員帳號", 404);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE admin_roles SET name = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(input.roleName, JSON.stringify(input.permissions), roleId),
    env.DB.prepare(`
      UPDATE admin_users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND role_id = ?
    `).bind(input.name, input.accountId, roleId),
  ]);
  return respond(request, env, { roleId, roleName: input.roleName, accountId: input.accountId, name: input.name, permissions: input.permissions }, "管理員帳號與角色已更新");
}

export async function deactivateAdminRole(request: Request, env: Env, roleId: string): Promise<Response> {
  const admin = await superAdmin(request, env, "delete");
  if (admin instanceof Response) return admin;
  const role = await env.DB.prepare(`
    SELECT id, code, name, is_system AS isSystem FROM admin_roles WHERE id = ? AND active = 1
  `).bind(roleId).first<{ id: string; code: string; name: string; isSystem: number }>();
  if (!role) return errorResponse(request, env, "找不到角色", 404);
  if (role.isSystem || role.code === "super_admin") return errorResponse(request, env, "系統角色不可刪除", 409);
  await env.DB.batch([
    env.DB.prepare(`UPDATE admin_roles SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(roleId),
    env.DB.prepare(`UPDATE admin_users SET active = 0, token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP WHERE role_id = ?`).bind(roleId),
  ]);
  return respond(request, env, { roleId, roleName: role.name }, "角色已刪除");
}
