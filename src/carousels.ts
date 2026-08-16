import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { Env } from "./types";

type CarouselRow = {
  id: string;
  title: string;
  imageUrl: string;
  description: string;
  linkUrl: string;
  sortOrder: number;
  active: number;
  createdAt: string;
  updatedAt: string;
};

type CarouselInput = {
  title: string;
  imageUrl: string;
  description: string;
  linkUrl: string;
  sortOrder: number;
  active: boolean;
};

const columns = `
  id, title, image_url AS imageUrl, description, link_url AS linkUrl,
  sort_order AS sortOrder, active, created_at AS createdAt, updated_at AS updatedAt
`;

function serialize(row: CarouselRow) {
  return { ...row, active: Boolean(row.active) };
}

async function parseInput(request: Request): Promise<CarouselInput | null> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const linkUrl = typeof body.linkUrl === "string" ? body.linkUrl.trim() : "";
    const sortOrder = Number(body.sortOrder ?? 0);
    const active = body.active !== false;
    if (!title || title.length > 120 || !imageUrl || imageUrl.length > 2048) return null;
    if (description.length > 1000 || linkUrl.length > 2048 || !Number.isInteger(sortOrder) || sortOrder < 0) return null;
    if (linkUrl && !/^https?:\/\//i.test(linkUrl) && !linkUrl.startsWith("/")) return null;
    return { title, imageUrl, description, linkUrl, sortOrder, active };
  } catch {
    return null;
  }
}

async function authorize(request: Request, env: Env, action: "view" | "create" | "edit" | "delete") {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "content", action)) return errorResponse(request, env, "您沒有管理輪播的權限", 403);
  return admin;
}

export async function listCarousels(request: Request, env: Env): Promise<Response> {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const result = await env.DB.prepare(`SELECT ${columns} FROM carousels ORDER BY sort_order ASC, created_at DESC`).all<CarouselRow>();
  return respond(request, env, result.results.map(serialize));
}

export async function createCarousel(request: Request, env: Env): Promise<Response> {
  const admin = await authorize(request, env, "create");
  if (admin instanceof Response) return admin;
  const input = await parseInput(request);
  if (!input) return errorResponse(request, env, "輪播資料格式不正確", 400);
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO carousels (id, title, image_url, description, link_url, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, input.title, input.imageUrl, input.description, input.linkUrl, input.sortOrder, Number(input.active)).run();
  const row = await env.DB.prepare(`SELECT ${columns} FROM carousels WHERE id = ?`).bind(id).first<CarouselRow>();
  return respond(request, env, serialize(row!), "輪播已建立", 201);
}

export async function updateCarousel(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "edit");
  if (admin instanceof Response) return admin;
  const input = await parseInput(request);
  if (!input) return errorResponse(request, env, "輪播資料格式不正確", 400);
  const result = await env.DB.prepare(`
    UPDATE carousels SET title = ?, image_url = ?, description = ?, link_url = ?,
      sort_order = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(input.title, input.imageUrl, input.description, input.linkUrl, input.sortOrder, Number(input.active), id).run();
  if (!result.meta.changes) return errorResponse(request, env, "找不到輪播", 404);
  const row = await env.DB.prepare(`SELECT ${columns} FROM carousels WHERE id = ?`).bind(id).first<CarouselRow>();
  return respond(request, env, serialize(row!), "輪播已更新");
}

export async function deleteCarousel(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "delete");
  if (admin instanceof Response) return admin;
  const result = await env.DB.prepare("DELETE FROM carousels WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return errorResponse(request, env, "找不到輪播", 404);
  return respond(request, env, null, "輪播已刪除");
}
