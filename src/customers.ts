import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { Env } from "./types";

type CustomerRow = {
  id: string;
  name: string;
  email: string;
  birthday: string | null;
  gender: "undisclosed" | "female" | "male" | "other";
  spent: number;
  joinedAt: string;
  status: "active" | "suspended";
  loginStatus: "online" | "offline";
};

export async function listCustomers(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "customers")) return errorResponse(request, env, "您沒有檢視會員的權限", 403);

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim().slice(0, 100) ?? "";
  const loginStatus = url.searchParams.get("loginStatus");
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20));
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (search) {
    conditions.push("(m.name LIKE ? ESCAPE '\\' OR m.email LIKE ? ESCAPE '\\')");
    const pattern = `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    bindings.push(pattern, pattern);
  }
  if (loginStatus === "online") conditions.push(`EXISTS (
    SELECT 1 FROM member_sessions session
    WHERE session.member_id = m.id AND session.revoked_at IS NULL
      AND session.expires_at > CURRENT_TIMESTAMP
      AND session.last_active_at > datetime('now', '-30 minutes')
  )`);
  if (loginStatus === "offline") conditions.push(`NOT EXISTS (
    SELECT 1 FROM member_sessions session
    WHERE session.member_id = m.id AND session.revoked_at IS NULL
      AND session.expires_at > CURRENT_TIMESTAMP
      AND session.last_active_at > datetime('now', '-30 minutes')
  )`);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM members m ${where}`)
    .bind(...bindings).first<{ total: number }>();
  const result = await env.DB.prepare(`
    SELECT
      m.id, m.name, m.email, m.birthday, m.gender, m.status,
      strftime('%Y-%m-%dT%H:%M:%S+08:00', datetime(m.created_at, '+8 hours')) AS joinedAt,
      COALESCE(SUM(CASE WHEN o.status IN ('paid', 'fulfilled') THEN o.total ELSE 0 END), 0) AS spent,
      CASE WHEN EXISTS (
        SELECT 1 FROM member_sessions session
        WHERE session.member_id = m.id AND session.revoked_at IS NULL
          AND session.expires_at > CURRENT_TIMESTAMP
          AND session.last_active_at > datetime('now', '-30 minutes')
      ) THEN 'online' ELSE 'offline' END AS loginStatus
    FROM members m
    LEFT JOIN orders o ON o.member_id = m.id
    ${where}
    GROUP BY m.id
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, pageSize, (page - 1) * pageSize).all<CustomerRow>();
  return respond(request, env, result.results, "會員資料載入成功", 200, {
    page, pageSize, total: count?.total ?? 0,
  });
}
