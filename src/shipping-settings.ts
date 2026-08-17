import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { Env } from "./types";

type ShippingSettings = {
  sevenElevenEnabled: number;
  sevenEleven: number;
  homeDeliveryEnabled: number;
  homeDelivery: number;
  updatedAt: string;
};

const columns = `seven_eleven_enabled AS sevenElevenEnabled,
  seven_eleven_fee AS sevenEleven,
  home_delivery_enabled AS homeDeliveryEnabled,
  home_delivery_fee AS homeDelivery, updated_at AS updatedAt`;

function serialize(settings: ShippingSettings) {
  return {
    ...settings,
    sevenElevenEnabled: Boolean(settings.sevenElevenEnabled),
    homeDeliveryEnabled: Boolean(settings.homeDeliveryEnabled),
  };
}

async function authorize(request: Request, env: Env, action: "view" | "edit") {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "logistics", action)) {
    return errorResponse(request, env, "您沒有管理物流設定的權限", 403);
  }
  return admin;
}

export async function getShippingSettings(request: Request, env: Env) {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const row = await env.DB.prepare(
    `SELECT ${columns} FROM shipping_settings WHERE id = 'default'`,
  ).first<ShippingSettings>();
  return respond(request, env, serialize(row ?? {
    sevenElevenEnabled: 1, sevenEleven: 60,
    homeDeliveryEnabled: 1, homeDelivery: 80, updatedAt: "",
  }));
}

export async function updateShippingSettings(request: Request, env: Env) {
  const admin = await authorize(request, env, "edit");
  if (admin instanceof Response) return admin;
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse(request, env, "物流設定格式不正確", 400);
  }
  const sevenEleven = Number(body.sevenEleven);
  const homeDelivery = Number(body.homeDelivery);
  const sevenElevenEnabled = body.sevenElevenEnabled === true;
  const homeDeliveryEnabled = body.homeDeliveryEnabled === true;
  if (!sevenElevenEnabled && !homeDeliveryEnabled) {
    return errorResponse(request, env, "至少需要開啟一種配送方式", 400);
  }
  if (!Number.isSafeInteger(sevenEleven) || sevenEleven < 0 || sevenEleven > 100_000
    || !Number.isSafeInteger(homeDelivery) || homeDelivery < 0 || homeDelivery > 100_000) {
    return errorResponse(request, env, "運費須為 0 至 100,000 的整數", 400);
  }
  await env.DB.prepare(`
    INSERT INTO shipping_settings (
      id, seven_eleven_enabled, seven_eleven_fee,
      home_delivery_enabled, home_delivery_fee
    ) VALUES ('default', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      seven_eleven_enabled = excluded.seven_eleven_enabled,
      seven_eleven_fee = excluded.seven_eleven_fee,
      home_delivery_enabled = excluded.home_delivery_enabled,
      home_delivery_fee = excluded.home_delivery_fee,
      updated_at = CURRENT_TIMESTAMP
  `).bind(sevenElevenEnabled ? 1 : 0, sevenEleven, homeDeliveryEnabled ? 1 : 0, homeDelivery).run();
  const row = await env.DB.prepare(
    `SELECT ${columns} FROM shipping_settings WHERE id = 'default'`,
  ).first<ShippingSettings>();
  return respond(request, env, serialize(row!), "物流設定已儲存");
}
