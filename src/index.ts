import { authenticate, findAdminByEmail, hasPermission } from "./auth";
import { createCategory, deleteCategory, listCategories, updateCategory } from "./categories";
import { createProduct, deleteProduct, getProduct, listProducts, publishScheduledProducts, updateProduct } from "./products";
import { getProductImage, uploadContentImage, uploadProductImage } from "./uploads";
import { createCarousel, deleteCarousel, listCarousels, updateCarousel } from "./carousels";
import { createMarquee, deleteMarquee, listMarquees, updateMarquee } from "./marquees";
import { corsHeaders, errorResponse, respond } from "./http";
import { createAccessToken, verifyPassword } from "./security";
import { createAdminUser, deactivateAdminRole, listAdminUsers, updateAdminRole } from "./admin-users";
import { listCustomers } from "./customers";
import { getBankTransferSettings, updateBankTransferSettings } from "./payment-settings";
import { listOrders, updateOrder } from "./orders";
import { getDashboard } from "./dashboard";
import {
  deleteNotification,
  deleteReadNotifications,
  listHeaderNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notifications";
import type { Env } from "./types";
import {
  createPromotion,
  createPromotionCodes,
  deletePromotionCode,
  getPromotion,
  listPromotionCodes,
  listPromotions,
  listPromotionUsages,
  updatePromotion,
  updatePromotionCode,
  updatePromotionStatus,
} from "./promotions";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function login(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(request, env, "JSON 格式不正確", 400);
  }
  const email = typeof (payload as { email?: unknown } | null)?.email === "string"
    ? (payload as { email: string }).email.trim().toLowerCase()
    : "";
  const password = typeof (payload as { password?: unknown } | null)?.password === "string"
    ? (payload as { password: string }).password
    : "";
  if (!emailPattern.test(email) || password.length < 8 || password.length > 256) {
    return errorResponse(request, env, "帳號或密碼錯誤", 401);
  }

  const admin = await findAdminByEmail(env, email);
  const locked = admin?.locked_until ? Date.parse(admin.locked_until) > Date.now() : false;
  const passwordValid = admin ? await verifyPassword(password, admin.password_hash) : false;
  if (!admin || !admin.active || !admin.role_active || locked || !passwordValid) {
    if (admin && !locked) {
      await env.DB.prepare(`
        UPDATE admin_users
        SET
          failed_login_count = failed_login_count + 1,
          locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN datetime('now', '+15 minutes') ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(admin.id).run();
    }
    return errorResponse(request, env, "帳號或密碼錯誤", 401);
  }

  const lastLoginAt = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE admin_users
    SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(lastLoginAt, admin.id).run();
  const accessToken = await createAccessToken(env, admin.id, admin.role_code, admin.token_version);
  return respond(request, env, {
    accessToken,
    user: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role_code,
      roleName: admin.role_name,
      permissions: JSON.parse(admin.permissions) as unknown,
      avatar: admin.avatar ?? undefined,
      lastLoginAt,
    },
  }, "登入成功");
}

async function me(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  return respond(request, env, {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role_code,
    roleName: admin.role_name,
    avatar: admin.avatar ?? undefined,
    lastLoginAt: admin.last_login_at,
    permissions: JSON.parse(admin.permissions) as unknown,
  });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  await env.DB.prepare(`
    UPDATE admin_users
    SET token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(admin.id).run();
  return respond(request, env, null, "登出成功");
}

async function listRoles(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "admins")) return errorResponse(request, env, "您沒有檢視角色的權限", 403);
  const result = await env.DB.prepare(`
    SELECT id, code, name, description, permissions, is_system, active, created_at, updated_at
    FROM admin_roles
    ORDER BY active DESC, name ASC
  `).all();
  return respond(request, env, result.results.map((role) => ({
    ...role,
    permissions: JSON.parse(String(role.permissions)),
    is_system: Boolean(role.is_system),
    active: Boolean(role.active),
  })));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const url = new URL(request.url);
    try {
      await publishScheduledProducts(env);
      if (request.method === "GET" && url.pathname === "/health") {
        return respond(request, env, { status: "ok", service: "knock-knock-admin-backend" });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") return login(request, env);
      if (request.method === "POST" && url.pathname === "/api/auth/logout") return logout(request, env);
      if (request.method === "GET" && url.pathname === "/api/auth/me") return me(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/dashboard") return getDashboard(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/roles") return listRoles(request, env);
      const roleMatch = url.pathname.match(/^\/api\/admin\/roles\/([^/]+)$/);
      if (roleMatch?.[1]) {
        const roleId = decodeURIComponent(roleMatch[1]);
        if (request.method === "PUT") return updateAdminRole(request, env, roleId);
        if (request.method === "DELETE") return deactivateAdminRole(request, env, roleId);
      }
      if (request.method === "GET" && url.pathname === "/api/admin/admin-users") return listAdminUsers(request, env);
      if (request.method === "POST" && url.pathname === "/api/admin/admin-users") return createAdminUser(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/customers") return listCustomers(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/orders") return listOrders(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/notifications") return listNotifications(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/notifications/header") return listHeaderNotifications(request, env);
      if (request.method === "PATCH" && url.pathname === "/api/admin/notifications/read-all") return markAllNotificationsRead(request, env);
      if (request.method === "DELETE" && url.pathname === "/api/admin/notifications/read") return deleteReadNotifications(request, env);
      const notificationReadMatch = url.pathname.match(/^\/api\/admin\/notifications\/(.+)\/read$/);
      if (request.method === "PATCH" && notificationReadMatch?.[1]) {
        return markNotificationRead(request, env, decodeURIComponent(notificationReadMatch[1]));
      }
      const notificationMatch = url.pathname.match(/^\/api\/admin\/notifications\/(.+)$/);
      if (request.method === "DELETE" && notificationMatch?.[1]) {
        return deleteNotification(request, env, decodeURIComponent(notificationMatch[1]));
      }
      const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
      if (request.method === "PATCH" && orderMatch?.[1]) return updateOrder(request, env, decodeURIComponent(orderMatch[1]));
      if (request.method === "GET" && url.pathname === "/api/admin/payment-settings/bank-transfer") return getBankTransferSettings(request, env);
      if (request.method === "PUT" && url.pathname === "/api/admin/payment-settings/bank-transfer") return updateBankTransferSettings(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/carousels") return listCarousels(request, env);
      if (request.method === "POST" && url.pathname === "/api/admin/carousels") return createCarousel(request, env);
      if (request.method === "GET" && url.pathname === "/api/admin/marquees") return listMarquees(request, env);
      if (request.method === "POST" && url.pathname === "/api/admin/marquees") return createMarquee(request, env);
      if (request.method === "POST" && url.pathname === "/api/admin/uploads/content") return uploadContentImage(request, env);
      if (request.method === "GET" && url.pathname.startsWith("/api/uploads/content/")) {
        return getProductImage(request, env, decodeURIComponent(url.pathname.slice("/api/uploads/content/".length)));
      }
      const carouselMatch = url.pathname.match(/^\/api\/admin\/carousels\/([^/]+)$/);
      if (carouselMatch?.[1]) {
        const id = decodeURIComponent(carouselMatch[1]);
        if (request.method === "PUT") return updateCarousel(request, env, id);
        if (request.method === "DELETE") return deleteCarousel(request, env, id);
      }
      const marqueeMatch = url.pathname.match(/^\/api\/admin\/marquees\/([^/]+)$/);
      if (marqueeMatch?.[1]) {
        const id = decodeURIComponent(marqueeMatch[1]);
        if (request.method === "PUT") return updateMarquee(request, env, id);
        if (request.method === "DELETE") return deleteMarquee(request, env, id);
      }
      if (request.method === "GET" && url.pathname === "/api/admin/promotions") return listPromotions(request, env);
      if (request.method === "POST" && url.pathname === "/api/admin/promotions") return createPromotion(request, env);
      const promotionCodesMatch = url.pathname.match(/^\/api\/admin\/promotions\/([^/]+)\/codes$/);
      if (promotionCodesMatch?.[1]) {
        const id = decodeURIComponent(promotionCodesMatch[1]);
        if (request.method === "GET") return listPromotionCodes(request, env, id);
        if (request.method === "POST") return createPromotionCodes(request, env, id);
      }
      const promotionUsageMatch = url.pathname.match(/^\/api\/admin\/promotions\/([^/]+)\/usages$/);
      if (request.method === "GET" && promotionUsageMatch?.[1]) return listPromotionUsages(request, env, decodeURIComponent(promotionUsageMatch[1]));
      const promotionStatusMatch = url.pathname.match(/^\/api\/admin\/promotions\/([^/]+)\/status$/);
      if (request.method === "PATCH" && promotionStatusMatch?.[1]) return updatePromotionStatus(request, env, decodeURIComponent(promotionStatusMatch[1]));
      const promotionMatch = url.pathname.match(/^\/api\/admin\/promotions\/([^/]+)$/);
      if (promotionMatch?.[1]) {
        const id = decodeURIComponent(promotionMatch[1]);
        if (request.method === "GET") return getPromotion(request, env, id);
        if (request.method === "PUT") return updatePromotion(request, env, id);
      }
      const promotionCodeMatch = url.pathname.match(/^\/api\/admin\/promotion-codes\/([^/]+)$/);
      if (promotionCodeMatch?.[1]) {
        const id = decodeURIComponent(promotionCodeMatch[1]);
        if (request.method === "PUT" || request.method === "PATCH") return updatePromotionCode(request, env, id);
        if (request.method === "DELETE") return deletePromotionCode(request, env, id);
      }
      if (request.method === "GET" && url.pathname === "/api/admin/categories") {
        return listCategories(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/categories") {
        return createCategory(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/admin/products") {
        return listProducts(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/products") {
        return createProduct(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/uploads/products") {
        return uploadProductImage(request, env);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/uploads/products/")) {
        const key = decodeURIComponent(url.pathname.slice("/api/uploads/products/".length));
        return getProductImage(request, env, key);
      }
      const productMatch = url.pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
      if (productMatch) {
        const id = decodeURIComponent(productMatch[1]!);
        if (request.method === "GET") return getProduct(request, env, id);
        if (request.method === "PUT") return updateProduct(request, env, id);
        if (request.method === "DELETE") return deleteProduct(request, env, id);
      }
      const categoryMatch = url.pathname.match(/^\/api\/admin\/categories\/([^/]+)$/);
      if (categoryMatch) {
        const id = decodeURIComponent(categoryMatch[1]!);
        if (request.method === "PATCH" || request.method === "PUT") {
          return updateCategory(request, env, id);
        }
        if (request.method === "DELETE") return deleteCategory(request, env, id);
      }
      return errorResponse(request, env, "找不到路由", 404);
    } catch (error) {
      console.error(error);
      return errorResponse(request, env, "伺服器暫時無法處理請求", 500);
    }
  },
} satisfies ExportedHandler<Env>;
