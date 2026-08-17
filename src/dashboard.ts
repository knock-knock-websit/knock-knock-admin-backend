import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { Env } from "./types";

type SummaryRow = Record<
  | "todayOrders" | "yesterdayOrders" | "todayRevenue" | "yesterdayRevenue"
  | "todayUnpaid" | "yesterdayUnpaid" | "todayShipping" | "yesterdayShipping"
  | "todayRefunds" | "yesterdayRefunds" | "lowStock",
  number
>;

type TrendRow = { date: string; revenue: number; orders: number };
type RecentOrderRow = {
  id: string; orderNo: string; customer: string; total: number;
  paymentStatus: string; createdAt: string;
};
type TopProductRow = { name: string; sales: number; revenue: number };

function delta(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 1_000) / 10;
}

function asUtc(value: string) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
}

export async function getDashboard(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "dashboard")) {
    return errorResponse(request, env, "您沒有檢視營運總覽的權限", 403);
  }

  const today = "date('now', '+8 hours')";
  const orderDay = "date(orders.created_at, '+8 hours')";
  const [summaryResult, trendResult, recentResult, topProductsResult] = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN ${orderDay} = ${today} THEN 1 ELSE 0 END) AS todayOrders,
        SUM(CASE WHEN ${orderDay} = date(${today}, '-1 day') THEN 1 ELSE 0 END) AS yesterdayOrders,
        SUM(CASE WHEN ${orderDay} = ${today} AND orders.payment_status = 'paid' AND orders.status != 'cancelled' THEN MAX(0, orders.total_amount - COALESCE(orders.shipping_amount, 0)) ELSE 0 END) AS todayRevenue,
        SUM(CASE WHEN ${orderDay} = date(${today}, '-1 day') AND orders.payment_status = 'paid' AND orders.status != 'cancelled' THEN MAX(0, orders.total_amount - COALESCE(orders.shipping_amount, 0)) ELSE 0 END) AS yesterdayRevenue,
        SUM(CASE WHEN ${orderDay} = ${today} AND orders.payment_status = 'pending' AND orders.status != 'cancelled' THEN 1 ELSE 0 END) AS todayUnpaid,
        SUM(CASE WHEN ${orderDay} = date(${today}, '-1 day') AND orders.payment_status = 'pending' AND orders.status != 'cancelled' THEN 1 ELSE 0 END) AS yesterdayUnpaid,
        SUM(CASE WHEN ${orderDay} = ${today} AND orders.payment_status = 'paid' AND orders.shipping_status IN ('unfulfilled', 'preparing') AND orders.status != 'cancelled' THEN 1 ELSE 0 END) AS todayShipping,
        SUM(CASE WHEN ${orderDay} = date(${today}, '-1 day') AND orders.payment_status = 'paid' AND orders.shipping_status IN ('unfulfilled', 'preparing') AND orders.status != 'cancelled' THEN 1 ELSE 0 END) AS yesterdayShipping,
        SUM(CASE WHEN ${orderDay} = ${today} AND orders.payment_status = 'refunded' THEN 1 ELSE 0 END) AS todayRefunds,
        SUM(CASE WHEN ${orderDay} = date(${today}, '-1 day') AND orders.payment_status = 'refunded' THEN 1 ELSE 0 END) AS yesterdayRefunds,
        (SELECT COUNT(*) FROM products product WHERE product.status = 'active' AND (
          EXISTS (SELECT 1 FROM product_variants variant WHERE variant.product_id = product.id AND variant.purchasable = 1 AND variant.stock - variant.reserved <= variant.safety_stock)
          OR (NOT EXISTS (SELECT 1 FROM product_variants variant WHERE variant.product_id = product.id) AND product.inventory <= product.safety_stock)
        )) AS lowStock
      FROM orders
    `),
    env.DB.prepare(`
      WITH RECURSIVE days(day) AS (
        SELECT date(${today}, '-6 days')
        UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < ${today}
      ), totals AS (
        SELECT ${orderDay} AS day,
          SUM(CASE WHEN orders.payment_status = 'paid' AND orders.status != 'cancelled' THEN MAX(0, orders.total_amount - COALESCE(orders.shipping_amount, 0)) ELSE 0 END) AS revenue,
          SUM(CASE WHEN orders.status != 'cancelled' THEN 1 ELSE 0 END) AS orders
        FROM orders
        WHERE ${orderDay} >= date(${today}, '-6 days')
        GROUP BY ${orderDay}
      )
      SELECT strftime('%m/%d', days.day) AS date,
        COALESCE(totals.revenue, 0) AS revenue, COALESCE(totals.orders, 0) AS orders
      FROM days LEFT JOIN totals ON totals.day = days.day ORDER BY days.day
    `),
    env.DB.prepare(`
      SELECT orders.id, upper(substr(orders.id, 1, 8)) AS orderNo,
        COALESCE(NULLIF(member.name, ''), NULLIF(orders.recipient_name, ''), orders.customer_email, '訪客') AS customer,
        orders.total_amount AS total, orders.payment_status AS paymentStatus, orders.created_at AS createdAt
      FROM orders LEFT JOIN members member ON member.id = orders.member_id
      ORDER BY orders.created_at DESC LIMIT 4
    `),
    env.DB.prepare(`
      SELECT item.product_name AS name, SUM(item.quantity) AS sales,
        SUM(item.unit_price * item.quantity) AS revenue
      FROM order_items item INNER JOIN orders ON orders.id = item.order_id
      WHERE date(orders.created_at, '+8 hours') >= date(${today}, '-29 days')
        AND orders.payment_status = 'paid' AND orders.status != 'cancelled'
      GROUP BY item.product_id, item.product_name
      ORDER BY sales DESC, revenue DESC, name ASC LIMIT 4
    `),
  ]);

  const raw = summaryResult.results[0] as unknown as Partial<SummaryRow> | undefined;
  const summary = new Proxy(raw ?? {}, { get: (target, property) => Number(target[property as keyof SummaryRow] ?? 0) }) as SummaryRow;
  const metrics = [
    { key: "orders", label: "今日訂單", value: summary.todayOrders, delta: delta(summary.todayOrders, summary.yesterdayOrders) },
    { key: "revenue", label: "今日營業額", value: summary.todayRevenue, prefix: "NT$", delta: delta(summary.todayRevenue, summary.yesterdayRevenue) },
    { key: "unpaid", label: "待付款訂單", value: summary.todayUnpaid, delta: delta(summary.todayUnpaid, summary.yesterdayUnpaid) },
    { key: "shipping", label: "待出貨訂單", value: summary.todayShipping, delta: delta(summary.todayShipping, summary.yesterdayShipping) },
    { key: "refund", label: "退款申請", value: summary.todayRefunds, delta: delta(summary.todayRefunds, summary.yesterdayRefunds) },
    { key: "stock", label: "低庫存商品", value: summary.lowStock, delta: 0 },
  ];
  const salesTrend = trendResult.results as unknown as TrendRow[];
  const recentOrders = (recentResult.results as unknown as RecentOrderRow[]).map((order) => ({
    ...order, total: Number(order.total), createdAt: asUtc(order.createdAt),
  }));
  const topProducts = (topProductsResult.results as unknown as TopProductRow[]).map((product) => ({
    ...product, sales: Number(product.sales), revenue: Number(product.revenue),
  }));

  return respond(request, env, {
    attentionCount: summary.todayUnpaid + summary.todayShipping + summary.todayRefunds + summary.lowStock,
    metrics,
    salesTrend,
    salesTrendTotal: salesTrend.reduce((total, item) => total + Number(item.revenue), 0),
    recentOrders,
    topProducts,
  });
}
