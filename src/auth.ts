import { errorResponse } from "./http";
import { verifyAccessToken } from "./security";
import type { AdminSessionRow, Env, PermissionMap } from "./types";

const sessionQuery = `
  SELECT
    u.id, u.name, u.email, u.password_hash, u.avatar, u.active,
    u.failed_login_count, u.locked_until, u.token_version, u.last_login_at,
    r.id AS role_id, r.code AS role_code, r.name AS role_name,
    r.active AS role_active, r.permissions
  FROM admin_users u
  INNER JOIN admin_roles r ON r.id = u.role_id
`;

export async function findAdminByEmail(env: Env, email: string): Promise<AdminSessionRow | null> {
  return env.DB.prepare(`${sessionQuery} WHERE u.email = ?`).bind(email).first<AdminSessionRow>();
}

export async function authenticate(request: Request, env: Env): Promise<AdminSessionRow | Response> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return errorResponse(request, env, "請先登入", 401);
  const payload = await verifyAccessToken(env, authorization.slice(7).trim());
  if (!payload) return errorResponse(request, env, "登入已逾期，請重新登入", 401);

  const admin = await env.DB.prepare(`${sessionQuery} WHERE u.id = ?`).bind(payload.sub).first<AdminSessionRow>();
  if (!admin || !admin.active || !admin.role_active || admin.token_version !== payload.version || admin.role_code !== payload.role) {
    return errorResponse(request, env, "登入已失效，請重新登入", 401);
  }
  return admin;
}

export function hasPermission(admin: AdminSessionRow, resource: string, action = "view"): boolean {
  if (resource === "dashboard" || resource === "inventory") return true;
  try {
    const permissions = JSON.parse(admin.permissions) as PermissionMap;
    return permissions[resource]?.includes(action) ?? false;
  } catch {
    return false;
  }
}
