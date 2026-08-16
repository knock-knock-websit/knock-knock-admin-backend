import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { Env } from "./types";

type NotificationType = "new_order" | "remittance_submitted";
type NotificationRow = {
  id: string; type: NotificationType; orderId: string; customer: string; email: string;
  total: number; itemCount: number; paymentMethod: string; paymentStatus: string;
  shippingStatus: string; occurredAt: string; remittingBank: string;
  transferAccountLastFive: string; itemsJson: string; isRead: number;
};
type CountRow = { type: NotificationType; count: number };

const itemSnapshotSql = `COALESCE((SELECT json_group_array(json_object(
  'id', item.id, 'productId', item.product_id, 'variantId', item.variant_id,
  'name', item.product_name, 'imageUrl', item.product_image_url,
  'specifications', json(item.specifications_json), 'price', item.unit_price,
  'quantity', item.quantity
)) FROM order_items item WHERE item.order_id = orders.id), '[]')`;

const eventQueries: Record<NotificationType, string> = {
  new_order: `
    SELECT 'order:' || orders.id AS id, 'new_order' AS type, orders.id AS orderId,
      COALESCE(member.name, orders.customer_email) AS customer, orders.customer_email AS email,
      orders.total_amount AS total,
      COALESCE((SELECT SUM(quantity) FROM order_items WHERE order_id = orders.id), 0) AS itemCount,
      orders.payment_method AS paymentMethod, orders.payment_status AS paymentStatus,
      orders.shipping_status AS shippingStatus, orders.created_at AS occurredAt,
      '' AS remittingBank, '' AS transferAccountLastFive, ${itemSnapshotSql} AS itemsJson
    FROM orders LEFT JOIN members member ON member.id = orders.member_id
  `,
  remittance_submitted: `
    SELECT 'remittance:' || orders.id AS id, 'remittance_submitted' AS type, orders.id AS orderId,
      COALESCE(member.name, orders.customer_email) AS customer, orders.customer_email AS email,
      orders.total_amount AS total,
      COALESCE((SELECT SUM(quantity) FROM order_items WHERE order_id = orders.id), 0) AS itemCount,
      orders.payment_method AS paymentMethod, orders.payment_status AS paymentStatus,
      orders.shipping_status AS shippingStatus, orders.updated_at AS occurredAt,
      orders.remitting_bank AS remittingBank,
      orders.transfer_account_last_five AS transferAccountLastFive, ${itemSnapshotSql} AS itemsJson
    FROM orders LEFT JOIN members member ON member.id = orders.member_id
    WHERE orders.remitting_bank <> '' AND orders.transfer_account_last_five <> ''
  `,
};
const allEventsQuery = `${eventQueries.new_order} UNION ALL ${eventQueries.remittance_submitted}`;

function asUtc(value: string) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
}
function todayInTaipei() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
async function requirePermission(request: Request, env: Env) {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "content")) return errorResponse(request, env, "您沒有管理通知中心的權限", 403);
  return admin;
}

async function getNotifications(request: Request, env: Env, forceToday = false): Promise<Response> {
  const admin = await requirePermission(request, env);
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const requestedType = forceToday ? "all" : (url.searchParams.get("type") ?? "all");
  if (!["all", "new_order", "remittance_submitted"].includes(requestedType)) {
    return errorResponse(request, env, "通知類型不正確", 400);
  }
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const today = todayInTaipei();
  const from = forceToday ? today : (url.searchParams.get("from") ?? today);
  const to = forceToday ? today : (url.searchParams.get("to") ?? from);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return errorResponse(request, env, "通知日期區間不正確", 400);
  }
  const selectedQuery = requestedType === "all" ? allEventsQuery : eventQueries[requestedType as NotificationType];
  const [events, counts] = await Promise.all([
    env.DB.prepare(`
      SELECT events.*, CASE WHEN state.read_at IS NULL THEN 0 ELSE 1 END AS isRead
      FROM (${selectedQuery}) events
      LEFT JOIN admin_notification_states state ON state.admin_id = ? AND state.event_id = events.id
      WHERE state.deleted_at IS NULL AND date(events.occurredAt, '+8 hours') BETWEEN ? AND ?
      ORDER BY events.occurredAt DESC LIMIT ?
    `).bind(admin.id, from, to, limit).all<NotificationRow>(),
    env.DB.prepare(`
      SELECT events.type, COUNT(*) AS count FROM (${allEventsQuery}) events
      LEFT JOIN admin_notification_states state ON state.admin_id = ? AND state.event_id = events.id
      WHERE state.deleted_at IS NULL AND date(events.occurredAt, '+8 hours') BETWEEN ? AND ?
      GROUP BY events.type
    `).bind(admin.id, from, to).all<CountRow>(),
  ]);
  const countByType = Object.fromEntries(counts.results.map((row) => [row.type, row.count]));
  return respond(request, env, {
    items: events.results.map(({ itemsJson, isRead, ...item }) => ({
      ...item, orderNo: item.orderId.slice(0, 8).toUpperCase(), occurredAt: asUtc(item.occurredAt),
      items: JSON.parse(itemsJson || "[]"), read: Boolean(isRead),
    })),
    summary: { newOrderCount: countByType.new_order ?? 0, remittanceCount: countByType.remittance_submitted ?? 0 },
  });
}

async function notificationExists(env: Env, eventId: string) {
  const separator = eventId.indexOf(":");
  const type = eventId.slice(0, separator);
  const orderId = eventId.slice(separator + 1);
  if (!orderId || !["order", "remittance"].includes(type)) return false;
  const condition = type === "remittance"
    ? "id = ? AND remitting_bank <> '' AND transfer_account_last_five <> ''"
    : "id = ?";
  return Boolean(await env.DB.prepare(`SELECT id FROM orders WHERE ${condition}`).bind(orderId).first());
}

async function updateSingleState(request: Request, env: Env, eventId: string, action: "read" | "delete") {
  const admin = await requirePermission(request, env);
  if (admin instanceof Response) return admin;
  if (!(await notificationExists(env, eventId))) return errorResponse(request, env, "找不到通知紀錄", 404);
  const readAt = action === "read" ? "CURRENT_TIMESTAMP" : "NULL";
  const deletedAt = action === "delete" ? "CURRENT_TIMESTAMP" : "NULL";
  const update = action === "read"
    ? "read_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP"
    : "deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP";
  await env.DB.prepare(`
    INSERT INTO admin_notification_states (admin_id, event_id, read_at, deleted_at)
    VALUES (?, ?, ${readAt}, ${deletedAt})
    ON CONFLICT(admin_id, event_id) DO UPDATE SET ${update}
  `).bind(admin.id, eventId).run();
  return respond(request, env, null, action === "read" ? "通知已讀" : "通知已刪除");
}

export function listNotifications(request: Request, env: Env) { return getNotifications(request, env); }
export function listHeaderNotifications(request: Request, env: Env) { return getNotifications(request, env, true); }
export function markNotificationRead(request: Request, env: Env, eventId: string) {
  return updateSingleState(request, env, eventId, "read");
}
export function deleteNotification(request: Request, env: Env, eventId: string) {
  return updateSingleState(request, env, eventId, "delete");
}

export async function markAllNotificationsRead(request: Request, env: Env): Promise<Response> {
  const admin = await requirePermission(request, env);
  if (admin instanceof Response) return admin;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO admin_notification_states (admin_id, event_id)
      SELECT ?, 'order:' || id FROM orders`).bind(admin.id),
    env.DB.prepare(`INSERT OR IGNORE INTO admin_notification_states (admin_id, event_id)
      SELECT ?, 'remittance:' || id FROM orders
      WHERE remitting_bank <> '' AND transfer_account_last_five <> ''`).bind(admin.id),
    env.DB.prepare(`UPDATE admin_notification_states SET read_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE admin_id = ? AND deleted_at IS NULL`).bind(admin.id),
  ]);
  return respond(request, env, null, "所有通知皆已標示為已讀");
}

export async function deleteReadNotifications(request: Request, env: Env): Promise<Response> {
  const admin = await requirePermission(request, env);
  if (admin instanceof Response) return admin;
  await env.DB.prepare(`UPDATE admin_notification_states SET deleted_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP WHERE admin_id = ? AND read_at IS NOT NULL AND deleted_at IS NULL`)
    .bind(admin.id).run();
  return respond(request, env, null, "已讀通知已刪除");
}
