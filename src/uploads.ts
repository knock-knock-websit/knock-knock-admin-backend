import { authenticate, hasPermission } from "./auth";
import { corsHeaders, errorResponse, respond } from "./http";
import type { Env } from "./types";

const maximumImageSize = 5 * 1024 * 1024;

type UploadedFile = {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function isUploadedFile(value: unknown): value is UploadedFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UploadedFile>;
  return typeof candidate.name === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.arrayBuffer === "function";
}

function detectImageType(bytes: Uint8Array): { contentType: string; extension: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { contentType: "image/png", extension: "png" };
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

export async function uploadProductImage(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "products", "create") && !hasPermission(admin, "products", "edit")) {
    return errorResponse(request, env, "您沒有上傳商品圖片的權限", 403);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(request, env, "上傳格式不正確", 400);
  }
  const file: unknown = formData.get("file");
  if (!isUploadedFile(file)) {
    return errorResponse(request, env, "請選擇商品圖片", 400);
  }
  if (file.size === 0) return errorResponse(request, env, "圖片內容不可為空", 400);
  if (file.size > maximumImageSize) return errorResponse(request, env, "圖片大小不可超過 5MB", 413);

  const contents = await file.arrayBuffer();
  const imageType = detectImageType(new Uint8Array(contents));
  if (!imageType) return errorResponse(request, env, "僅支援 JPG、PNG 或 WebP 圖片", 415);

  const key = `${crypto.randomUUID()}.${imageType.extension}`;
  await env.PRODUCT_IMAGES.put(key, contents, {
    httpMetadata: {
      contentType: imageType.contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      uploadedBy: admin.id,
      originalName: file.name.slice(0, 200),
    },
  });
  const imageUrl = new URL(`/api/uploads/products/${key}`, request.url).toString();
  return respond(request, env, { imageUrl }, "圖片已上傳", 201);
}

export async function uploadContentImage(request: Request, env: Env): Promise<Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "content", "create") && !hasPermission(admin, "content", "edit")) {
    return errorResponse(request, env, "您沒有上傳輪播圖片的權限", 403);
  }
  let formData: FormData;
  try { formData = await request.formData(); } catch { return errorResponse(request, env, "上傳格式不正確", 400); }
  const file: unknown = formData.get("file");
  if (!isUploadedFile(file)) return errorResponse(request, env, "請選擇輪播圖片", 400);
  if (file.size === 0) return errorResponse(request, env, "圖片內容不可為空", 400);
  if (file.size > maximumImageSize) return errorResponse(request, env, "圖片大小不可超過 5MB", 413);
  const contents = await file.arrayBuffer();
  const imageType = detectImageType(new Uint8Array(contents));
  if (!imageType) return errorResponse(request, env, "僅支援 JPG、PNG 或 WebP 圖片", 415);
  const key = `${crypto.randomUUID()}.${imageType.extension}`;
  await env.PRODUCT_IMAGES.put(key, contents, {
    httpMetadata: { contentType: imageType.contentType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { uploadedBy: admin.id, originalName: file.name.slice(0, 200), resource: "carousel" },
  });
  const imageUrl = new URL(`/api/uploads/content/${key}`, request.url).toString();
  return respond(request, env, { imageUrl }, "圖片已上傳", 201);
}

export async function getProductImage(request: Request, env: Env, key: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(key)) {
    return errorResponse(request, env, "找不到圖片", 404);
  }
  const object = await env.PRODUCT_IMAGES.get(key);
  if (!object) return errorResponse(request, env, "找不到圖片", 404);

  const headers = new Headers(corsHeaders(request, env));
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
