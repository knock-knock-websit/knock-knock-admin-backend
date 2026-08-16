import type { Env } from "./types";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

export function corsHeaders(request: Request, env: Env): HeadersInit {
  const configuredOrigin = env.ADMIN_ORIGIN?.trim();
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigin = configuredOrigin && configuredOrigin !== "*"
    ? (requestOrigin === configuredOrigin ? configuredOrigin : "null")
    : "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    Vary: "Origin",
  };
}

export function respond<T>(
  request: Request,
  env: Env,
  data: T,
  message = "操作成功",
  status = 200,
  pagination?: { page: number; pageSize: number; total: number },
): Response {
  return new Response(JSON.stringify({
    success: status < 400,
    message,
    data,
    ...(pagination ? { pagination } : {}),
  }), {
    status,
    headers: { ...jsonHeaders, ...corsHeaders(request, env) },
  });
}

export function errorResponse(
  request: Request,
  env: Env,
  message: string,
  status: number,
): Response {
  return respond(request, env, null, message, status);
}
