import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { Env } from "./types";

type OrderRow = {
  id: string; customer: string; email: string; recipientName: string; recipientPhone: string;
  total: number; subtotal: number; discount: number; shipping: number; paymentMethod: string;
  paymentStatus: string; shippingStatus: string; status: string; shippingMethod: string;
  storeName: string; storeId: string; storeAddress: string; storePhone: string;
  deliveryAddress: string;
  promotionName: string | null; couponCode: string | null; orderNote: string; internalNote: string;
  trackingNo: string; createdAt: string; updatedAt: string; itemsJson: string;
  bankCode: string; bankName: string; bankBranchName: string; bankAccountName: string;
  bankAccountNumber: string; bankTransferNote: string;
  remittingBank: string; transferAccountLastFive: string;
};

const columns = `
  orders.id, member.name AS customer, orders.customer_email AS email,
  orders.recipient_name AS recipientName, orders.recipient_phone AS recipientPhone,
  orders.total_amount AS total, orders.subtotal, orders.discount_amount AS discount,
  orders.shipping_amount AS shipping, orders.payment_method AS paymentMethod,
  orders.payment_status AS paymentStatus, orders.shipping_status AS shippingStatus,
  orders.status, orders.shipping_method AS shippingMethod,
  COALESCE(orders.pickup_store_name, '') AS storeName,
  COALESCE(orders.pickup_store_id, '') AS storeId,
  COALESCE(orders.pickup_store_address, '') AS storeAddress,
  COALESCE(orders.pickup_store_phone, '') AS storePhone,
  COALESCE(orders.delivery_address, '') AS deliveryAddress,
  orders.promotion_name AS promotionName, orders.coupon_code AS couponCode,
  orders.order_note AS orderNote, orders.internal_note AS internalNote,
  orders.tracking_no AS trackingNo, orders.created_at AS createdAt, orders.updated_at AS updatedAt,
  orders.bank_code AS bankCode, orders.bank_name AS bankName,
  orders.bank_branch_name AS bankBranchName, orders.bank_account_name AS bankAccountName,
  orders.bank_account_number AS bankAccountNumber, orders.bank_transfer_note AS bankTransferNote,
  orders.remitting_bank AS remittingBank,
  orders.transfer_account_last_five AS transferAccountLastFive,
  COALESCE((SELECT json_group_array(json_object(
    'id', item.id, 'productId', item.product_id, 'variantId', item.variant_id,
    'name', item.product_name, 'imageUrl', item.product_image_url,
    'specifications', json(item.specifications_json), 'price', item.unit_price,
    'quantity', item.quantity
  )) FROM order_items item WHERE item.order_id = orders.id), '[]') AS itemsJson
`;

function serialize(row: OrderRow) {
  const items = JSON.parse(row.itemsJson || "[]") as Array<{ quantity: number }>;
  const asUtc = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const { status: _internalStatus, ...publicRow } = row;
  void _internalStatus;
  return {
    ...publicRow,
    createdAt: asUtc(row.createdAt),
    updatedAt: asUtc(row.updatedAt),
    orderNo: row.id.slice(0, 8).toUpperCase(),
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    itemsJson: undefined,
  };
}

export async function listOrders(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "orders")) return errorResponse(request, env, "您沒有檢視訂單的權限", 403);
  const result = await env.DB.prepare(`SELECT ${columns} FROM orders LEFT JOIN members member ON member.id = orders.member_id ORDER BY orders.created_at DESC`).all<OrderRow>();
  return respond(request, env, result.results.map(serialize));
}

export async function updateOrder(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "orders", "edit")) return errorResponse(request, env, "您沒有更新訂單的權限", 403);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return errorResponse(request, env, "JSON 格式不正確", 400); }
  const paymentStatus = String(body.paymentStatus ?? "");
  const shippingStatus = String(body.shippingStatus ?? "");
  const trackingNo = String(body.trackingNo ?? "").trim();
  const internalNote = String(body.internalNote ?? body.note ?? "").trim();
  const recipientName = String(body.recipientName ?? "").trim();
  const recipientPhone = String(body.recipientPhone ?? "").trim();
  const orderNote = String(body.orderNote ?? "").trim();
  if (!["pending", "paid", "refunded", "failed"].includes(paymentStatus)
    || !["unfulfilled", "preparing", "shipped", "delivered"].includes(shippingStatus)
    || !recipientName || recipientName.length > 80 || !/^09\d{8}$/.test(recipientPhone)
    || orderNote.length > 1000 || trackingNo.length > 100 || internalNote.length > 1000) {
    return errorResponse(request, env, "付款或出貨狀態資料格式不正確", 400);
  }
  const result = await env.DB.prepare(`
    UPDATE orders SET payment_status = ?, shipping_status = ?,
      tracking_no = ?, internal_note = ?, recipient_name = ?, recipient_phone = ?,
      order_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(paymentStatus, shippingStatus, trackingNo, internalNote, recipientName, recipientPhone, orderNote, id).run();
  if (!result.meta.changes) return errorResponse(request, env, "找不到訂單", 404);
  const row = await env.DB.prepare(`SELECT ${columns} FROM orders LEFT JOIN members member ON member.id = orders.member_id WHERE orders.id = ?`).bind(id).first<OrderRow>();
  return respond(request, env, serialize(row!), "付款與出貨狀態已更新");
}
