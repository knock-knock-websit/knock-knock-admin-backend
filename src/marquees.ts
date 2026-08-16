import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { Env } from "./types";

type Row = { id: string; content: string; linkUrl: string; sortOrder: number; active: number; createdAt: string; updatedAt: string };
type Input = { content: string; linkUrl: string; sortOrder: number; active: boolean };
const columns = "id, content, link_url AS linkUrl, sort_order AS sortOrder, active, created_at AS createdAt, updated_at AS updatedAt";

async function authorize(request: Request, env: Env, action: "view" | "create" | "edit" | "delete") {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "content", action)) return errorResponse(request, env, "您沒有管理跑馬燈的權限", 403);
  return admin;
}
async function input(request: Request): Promise<Input | null> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const linkUrl = typeof body.linkUrl === "string" ? body.linkUrl.trim() : "";
    const sortOrder = Number(body.sortOrder ?? 0);
    if (!content || content.length > 300 || linkUrl.length > 2048 || !Number.isInteger(sortOrder) || sortOrder < 0) return null;
    if (linkUrl && !/^https?:\/\//i.test(linkUrl) && !linkUrl.startsWith("/")) return null;
    return { content, linkUrl, sortOrder, active: body.active !== false };
  } catch { return null; }
}
const serialize = (row: Row) => ({ ...row, active: Boolean(row.active) });

export async function listMarquees(request: Request, env: Env) {
  const admin = await authorize(request, env, "view"); if (admin instanceof Response) return admin;
  const result = await env.DB.prepare(`SELECT ${columns} FROM marquees ORDER BY sort_order ASC, created_at DESC`).all<Row>();
  return respond(request, env, result.results.map(serialize));
}
export async function createMarquee(request: Request, env: Env) {
  const admin = await authorize(request, env, "create"); if (admin instanceof Response) return admin;
  const value = await input(request); if (!value) return errorResponse(request, env, "跑馬燈資料格式不正確", 400);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO marquees (id, content, link_url, sort_order, active) VALUES (?, ?, ?, ?, ?)")
    .bind(id, value.content, value.linkUrl, value.sortOrder, Number(value.active)).run();
  const row = await env.DB.prepare(`SELECT ${columns} FROM marquees WHERE id = ?`).bind(id).first<Row>();
  return respond(request, env, serialize(row!), "跑馬燈已建立", 201);
}
export async function updateMarquee(request: Request, env: Env, id: string) {
  const admin = await authorize(request, env, "edit"); if (admin instanceof Response) return admin;
  const value = await input(request); if (!value) return errorResponse(request, env, "跑馬燈資料格式不正確", 400);
  const result = await env.DB.prepare("UPDATE marquees SET content = ?, link_url = ?, sort_order = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(value.content, value.linkUrl, value.sortOrder, Number(value.active), id).run();
  if (!result.meta.changes) return errorResponse(request, env, "找不到跑馬燈", 404);
  const row = await env.DB.prepare(`SELECT ${columns} FROM marquees WHERE id = ?`).bind(id).first<Row>();
  return respond(request, env, serialize(row!), "跑馬燈已更新");
}
export async function deleteMarquee(request: Request, env: Env, id: string) {
  const admin = await authorize(request, env, "delete"); if (admin instanceof Response) return admin;
  const result = await env.DB.prepare("DELETE FROM marquees WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return errorResponse(request, env, "找不到跑馬燈", 404);
  return respond(request, env, null, "跑馬燈已刪除");
}
