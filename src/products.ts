import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { AdminSessionRow, Env } from "./types";

type ProductStatus = "active" | "inactive" | "draft";
type ProductTagType = "popular" | "preorder" | "new" | "none";

type ProductRow = {
  id: string;
  name: string;
  code: string;
  category: string;
  categoryId: string | null;
  price: number;
  compareAtPrice: number | null;
  cost: number;
  stock: number;
  safetyStock: number;
  status: ProductStatus;
  scheduledPublishAt: string | null;
  tagType: ProductTagType;
  image: string | null;
  brand: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  specificationsEnabled: number;
  sortOrder: number;
  viewCount: number;
  createdAt: string;
  imagesJson: string;
  colorImagesJson: string;
  specificationsJson: string;
  variantsJson: string;
};

type ProductImageInput = {
  id?: string;
  imageUrl: string;
  altText: string;
  sortOrder: number;
  isPrimary: boolean;
};

type ProductColorImageInput = {
  optionId: string;
  optionName: string;
  imageUrl: string;
};

type ProductVariantInput = {
  id?: string;
  sku: string;
  optionValueIds: string[];
  optionValues: ProductVariantOptionValueInput[];
  price: number;
  compareAtPrice: number | null;
  stock: number;
  safetyStock: number;
  reserved: number;
  imageUrl: string | null;
  purchasable: boolean;
};

type ProductVariantOptionValueInput = {
  specificationId: string;
  specificationName: string;
  optionId: string;
  optionName: string;
};

type ProductSpecificationOptionInput = {
  id?: string;
  name: string;
  sortOrder: number;
};

type ProductSpecificationInput = {
  id?: string;
  name: string;
  sortOrder: number;
  options: ProductSpecificationOptionInput[];
};

type ProductInput = {
  name: string;
  code: string;
  category: string;
  categoryId: string | null;
  price: number;
  compareAtPrice: number | null;
  cost: number;
  safetyStock: number;
  status: ProductStatus;
  scheduledPublishAt: string | null;
  tagType: ProductTagType;
  images: ProductImageInput[];
  colorImages: ProductColorImageInput[];
  brand: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  specificationsEnabled: boolean;
  specifications: ProductSpecificationInput[];
  variants: ProductVariantInput[];
  sortOrder: number;
};

const productColumns = `
  p.id, p.name, p.code, p.category, p.category_id AS categoryId,
  p.price, p.compare_at_price AS compareAtPrice, p.cost,
  p.inventory AS stock, p.safety_stock AS safetyStock, p.status,
  p.scheduled_publish_at AS scheduledPublishAt,
  p.tag_type AS tagType,
  COALESCE(
    (SELECT image_url FROM product_images WHERE product_id = p.id AND active = 1
     ORDER BY is_primary DESC, sort_order ASC LIMIT 1),
    p.image_url
  ) AS image,
  p.brand, p.description,
  p.seo_title AS seoTitle, p.seo_description AS seoDescription,
  p.specifications_enabled AS specificationsEnabled,
  p.sort_order AS sortOrder,
  p.view_count AS viewCount,
  strftime('%Y-%m-%d %H:%M', datetime(p.created_at, '+8 hours')) AS createdAt,
  COALESCE((
    SELECT json_group_array(json_object(
      'id', image.id, 'imageUrl', image.image_url, 'altText', image.alt_text,
      'sortOrder', image.sort_order, 'isPrimary', image.is_primary
    ))
    FROM (
      SELECT id, image_url, alt_text, sort_order, is_primary
      FROM product_images WHERE product_id = p.id AND active = 1
      ORDER BY is_primary DESC, sort_order ASC, created_at ASC
    ) image
  ), '[]') AS imagesJson,
  COALESCE((
    SELECT json_group_array(json_object(
      'optionId', color_image.option_id,
      'optionName', color_image.option_name,
      'imageUrl', color_image.image_url
    ))
    FROM (
      SELECT image.option_id, option.name AS option_name, image.image_url
      FROM product_color_images image
      INNER JOIN product_specification_options option ON option.id = image.option_id
      WHERE image.product_id = p.id
      ORDER BY option.sort_order ASC, image.created_at ASC
    ) color_image
  ), '[]') AS colorImagesJson,
  COALESCE((
    SELECT json_group_array(json_object(
      'id', specification.id,
      'name', specification.name,
      'sortOrder', specification.sort_order,
      'options', json(COALESCE((
        SELECT json_group_array(json_object(
          'id', option.id, 'name', option.name, 'sortOrder', option.sort_order
        ))
        FROM (
          SELECT id, name, sort_order
          FROM product_specification_options
          WHERE specification_id = specification.id
          ORDER BY sort_order ASC, created_at ASC
        ) option
      ), '[]'))
    ))
    FROM (
      SELECT id, name, sort_order
      FROM product_specifications WHERE product_id = p.id
      ORDER BY sort_order ASC, created_at ASC
    ) specification
  ), '[]') AS specificationsJson,
  COALESCE((
    SELECT json_group_array(json_object(
      'id', variant.id, 'sku', variant.sku,
      'optionValueIds', json(COALESCE((
        SELECT json_group_array(value.option_id)
        FROM (
          SELECT option_id FROM product_variant_option_values
          WHERE variant_id = variant.id ORDER BY sort_order ASC
        ) value
      ), '[]')),
      'optionValues', json(COALESCE((
        SELECT json_group_array(json_object(
          'specificationId', value.specification_id,
          'specificationName', value.specification_name,
          'optionId', value.option_id,
          'optionName', value.option_name
        ))
        FROM (
          SELECT
            relation.specification_id, specification.name AS specification_name,
            relation.option_id, option.name AS option_name
          FROM product_variant_option_values relation
          INNER JOIN product_specifications specification ON specification.id = relation.specification_id
          INNER JOIN product_specification_options option ON option.id = relation.option_id
          WHERE relation.variant_id = variant.id
          ORDER BY relation.sort_order ASC
        ) value
      ), '[]')),
      'price', variant.price, 'compareAtPrice', variant.compare_at_price,
      'stock', variant.stock, 'safetyStock', variant.safety_stock,
      'reserved', variant.reserved, 'imageUrl', variant.image_url,
      'purchasable', variant.purchasable
    ))
    FROM (
      SELECT variant.id, variant.sku, variant.price, variant.compare_at_price,
             variant.stock, variant.safety_stock, variant.reserved,
             COALESCE((
               SELECT color_image.image_url
               FROM product_color_images color_image
               INNER JOIN product_variant_option_values value
                 ON value.option_id = color_image.option_id
               WHERE color_image.product_id = variant.product_id
                 AND value.variant_id = variant.id
               LIMIT 1
             ), variant.image_url) AS image_url,
             variant.purchasable
      FROM product_variants variant
      WHERE variant.product_id = p.id
      ORDER BY variant.sort_order ASC, variant.created_at ASC
    ) variant
  ), '[]') AS variantsJson
`;

async function authorize(
  request: Request,
  env: Env,
  action: "view" | "create" | "edit" | "delete",
): Promise<AdminSessionRow | Response> {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "products", action)) {
    return errorResponse(request, env, "您沒有執行此商品操作的權限", 403);
  }
  return admin;
}

function serializeProduct(row: ProductRow) {
  let images: Array<Omit<ProductImageInput, "isPrimary"> & { isPrimary: number }> = [];
  let colorImages: ProductColorImageInput[] = [];
  let specifications: ProductSpecificationInput[] = [];
  let variants: Array<Omit<ProductVariantInput, "purchasable"> & { purchasable: number }> = [];
  try { images = JSON.parse(row.imagesJson) as typeof images; } catch { images = []; }
  try { colorImages = JSON.parse(row.colorImagesJson) as ProductColorImageInput[]; } catch { colorImages = []; }
  try { specifications = JSON.parse(row.specificationsJson) as ProductSpecificationInput[]; } catch { specifications = []; }
  try { variants = JSON.parse(row.variantsJson) as typeof variants; } catch { variants = []; }
  const { imagesJson, colorImagesJson, specificationsJson, variantsJson, ...product } = row;
  return {
    ...product,
    image: product.image ?? "",
    categoryId: product.categoryId ?? "",
    specificationsEnabled: Boolean(product.specificationsEnabled),
    images: images.map((image) => ({ ...image, isPrimary: Boolean(image.isPrimary) })),
    colorImages,
    specifications,
    variants: variants.map((variant) => ({
      ...variant,
      purchasable: Boolean(variant.purchasable),
    })),
  };
}

async function getRow(env: Env, id: string): Promise<ProductRow | null> {
  return env.DB.prepare(`SELECT ${productColumns} FROM products p WHERE p.id = ?`)
    .bind(id).first<ProductRow>();
}

function stringValue(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maxLength) return null;
  return normalized;
}

function integerValue(value: unknown, maximum = 999_999_999): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

async function parseInput(request: Request, env: Env): Promise<ProductInput | Response> {
  let raw: Record<string, unknown>;
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    raw = payload as Record<string, unknown>;
  } catch {
    return errorResponse(request, env, "JSON 格式不正確", 400);
  }

  const name = stringValue(raw.name, 120);
  const code = stringValue(raw.code, 80)?.toUpperCase() ?? null;
  const category = stringValue(raw.category, 80);
  const categoryId = raw.categoryId == null ? null : stringValue(raw.categoryId, 100);
  const price = integerValue(raw.price);
  const compareAtPrice = raw.compareAtPrice == null ? null : integerValue(raw.compareAtPrice);
  const cost = integerValue(raw.cost);
  const safetyStock = integerValue(raw.safetyStock);
  const sortOrder = integerValue(raw.sortOrder, 999_999);
  const brand = stringValue(raw.brand, 80, true);
  const description = stringValue(raw.description, 2_000, true);
  const seoTitle = stringValue(raw.seoTitle, 60, true);
  const seoDescription = stringValue(raw.seoDescription, 160, true);
  const status = raw.status;
  const scheduledPublishAt = raw.scheduledPublishAt == null || raw.scheduledPublishAt === ""
    ? null
    : typeof raw.scheduledPublishAt === "string" ? raw.scheduledPublishAt : undefined;
  const tagType = raw.tagType;
  if (!name || !code || !category || cost === null || safetyStock === null || sortOrder === null ||
      price === null || !brand || description === null || seoTitle === null || seoDescription === null ||
      !["active", "inactive", "draft"].includes(String(status)) ||
      !["popular", "preorder", "new", "none"].includes(String(tagType))) {
    return errorResponse(request, env, "商品基本資料格式不正確", 400);
  }
  if (scheduledPublishAt === undefined || (scheduledPublishAt !== null &&
      (Number.isNaN(Date.parse(scheduledPublishAt)) || Date.parse(scheduledPublishAt) <= Date.now()))) {
    return errorResponse(request, env, "預約上架時間必須晚於目前時間", 400);
  }
  if (compareAtPrice !== null && compareAtPrice < price) {
    return errorResponse(request, env, "舊價格不得低於目前售價", 400);
  }

  if (!Array.isArray(raw.images) || raw.images.length > 20) {
    return errorResponse(request, env, "商品圖片格式不正確", 400);
  }
  const images: ProductImageInput[] = [];
  for (const [index, value] of raw.images.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return errorResponse(request, env, "商品圖片格式不正確", 400);
    }
    const image = value as Record<string, unknown>;
    const imageUrl = stringValue(image.imageUrl, 2_048);
    const altText = stringValue(image.altText ?? "", 200, true);
    const imageSortOrder = image.sortOrder === undefined ? index : integerValue(image.sortOrder, 999_999);
    if (!imageUrl || altText === null || imageSortOrder === null ||
        (image.isPrimary !== undefined && typeof image.isPrimary !== "boolean")) {
      return errorResponse(request, env, "商品圖片格式不正確", 400);
    }
    images.push({
      id: typeof image.id === "string" ? image.id : undefined,
      imageUrl,
      altText,
      sortOrder: imageSortOrder,
      isPrimary: image.isPrimary === true,
    });
  }
  if (new Set(images.map((image) => image.imageUrl)).size !== images.length) {
    return errorResponse(request, env, "商品圖片不可重複", 400);
  }
  if (images.filter((image) => image.isPrimary).length > 1) {
    return errorResponse(request, env, "只能設定一張主要商品圖片", 400);
  }
  if (images.length > 0 && !images.some((image) => image.isPrimary)) images[0]!.isPrimary = true;

  if (typeof raw.specificationsEnabled !== "boolean" || !Array.isArray(raw.specifications) ||
      raw.specifications.length > 5) {
    return errorResponse(request, env, "商品規格設定格式不正確", 400);
  }
  const specificationsEnabled = raw.specificationsEnabled;
  if (specificationsEnabled && raw.specifications.length === 0) {
    return errorResponse(request, env, "啟用商品規格時至少需要一組規格", 400);
  }
  const specifications: ProductSpecificationInput[] = [];
  const specificationIds = new Set<string>();
  const specificationNames = new Set<string>();
  const optionById = new Map<string, {
    specificationId: string;
    specificationName: string;
    optionId: string;
    optionName: string;
  }>();
  for (const [specificationIndex, value] of raw.specifications.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return errorResponse(request, env, "商品規格設定格式不正確", 400);
    }
    const specification = value as Record<string, unknown>;
    const specificationId = stringValue(specification.id, 160);
    const specificationName = stringValue(specification.name, 80);
    const specificationSortOrder = specification.sortOrder === undefined
      ? specificationIndex
      : integerValue(specification.sortOrder, 999_999);
    if (!specificationId || !specificationName || specificationSortOrder === null ||
        !Array.isArray(specification.options) || specification.options.length === 0 ||
        specification.options.length > 20) {
      return errorResponse(request, env, "商品規格設定格式不正確", 400);
    }
    const specificationNameKey = specificationName.toLocaleLowerCase("zh-Hant");
    if (specificationIds.has(specificationId) || specificationNames.has(specificationNameKey)) {
      return errorResponse(request, env, "規格 ID 或名稱不可重複", 400);
    }
    specificationIds.add(specificationId);
    specificationNames.add(specificationNameKey);

    const options: ProductSpecificationOptionInput[] = [];
    const optionNames = new Set<string>();
    for (const [optionIndex, optionValue] of specification.options.entries()) {
      if (!optionValue || typeof optionValue !== "object" || Array.isArray(optionValue)) {
        return errorResponse(request, env, "商品規格選項格式不正確", 400);
      }
      const option = optionValue as Record<string, unknown>;
      const optionId = stringValue(option.id, 160);
      const optionName = stringValue(option.name, 80);
      const optionSortOrder = option.sortOrder === undefined
        ? optionIndex
        : integerValue(option.sortOrder, 999_999);
      const optionNameKey = optionName?.toLocaleLowerCase("zh-Hant") ?? "";
      if (!optionId || !optionName || optionSortOrder === null || optionById.has(optionId) ||
          optionNames.has(optionNameKey)) {
        return errorResponse(request, env, "規格選項 ID 或名稱不可重複", 400);
      }
      optionNames.add(optionNameKey);
      optionById.set(optionId, {
        specificationId,
        specificationName,
        optionId,
        optionName,
      });
      options.push({ id: optionId, name: optionName, sortOrder: optionSortOrder });
    }
    specifications.push({
      id: specificationId,
      name: specificationName,
      sortOrder: specificationSortOrder,
      options,
    });
  }

  if (!Array.isArray(raw.variants) || raw.variants.length === 0 || raw.variants.length > 50) {
    return errorResponse(request, env, "商品至少需要一項規格", 400);
  }
  const variants: ProductVariantInput[] = [];
  const variantSignatures = new Set<string>();
  for (const value of raw.variants) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return errorResponse(request, env, "商品規格格式不正確", 400);
    }
    const variant = value as Record<string, unknown>;
    const sku = stringValue(variant.sku, 100)?.toUpperCase() ?? null;
    const variantPrice = integerValue(variant.price);
    const variantCompareAtPrice = variant.compareAtPrice == null
      ? null
      : integerValue(variant.compareAtPrice);
    const stock = integerValue(variant.stock);
    const variantSafetyStock = integerValue(variant.safetyStock);
    const reserved = integerValue(variant.reserved);
    const imageUrl = variant.imageUrl == null ? null : stringValue(variant.imageUrl, 2_048);
    if (!sku || variantPrice === null || variantSafetyStock === null || stock === null ||
        reserved === null || reserved > stock || (variant.imageUrl != null && !imageUrl) ||
        typeof variant.purchasable !== "boolean" || !Array.isArray(variant.optionValueIds) ||
        !Array.isArray(variant.optionValues)) {
      return errorResponse(request, env, "商品規格格式不正確", 400);
    }
    if (variantCompareAtPrice !== null && variantCompareAtPrice < variantPrice) {
      return errorResponse(request, env, `SKU ${sku} 的原價不得低於售價`, 400);
    }
    const optionValueIds = variant.optionValueIds.filter(
      (optionId): optionId is string => typeof optionId === "string",
    );
    if (optionValueIds.length !== variant.optionValueIds.length ||
        new Set(optionValueIds).size !== optionValueIds.length) {
      return errorResponse(request, env, `SKU ${sku} 的規格選項格式不正確`, 400);
    }
    const optionValues = optionValueIds.map((optionId) => optionById.get(optionId));
    if (optionValues.some((option) => !option)) {
      return errorResponse(request, env, `SKU ${sku} 使用了不存在的規格選項`, 400);
    }
    if (variant.optionValues.length !== optionValueIds.length ||
        variant.optionValues.some((value, index) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return true;
          const supplied = value as Record<string, unknown>;
          const canonical = optionValues[index];
          return supplied.specificationId !== canonical?.specificationId ||
            supplied.specificationName !== canonical?.specificationName ||
            supplied.optionId !== canonical?.optionId ||
            supplied.optionName !== canonical?.optionName;
        })) {
      return errorResponse(request, env, `SKU ${sku} 的規格明細與選項不一致`, 400);
    }
    if (specificationsEnabled) {
      const selectedSpecificationIds = new Set(
        optionValues.map((option) => option!.specificationId),
      );
      if (optionValues.length !== specifications.length ||
          selectedSpecificationIds.size !== specifications.length) {
        return errorResponse(request, env, `SKU ${sku} 必須各選擇一個規格選項`, 400);
      }
    } else if (optionValueIds.length > 0) {
      return errorResponse(request, env, "未啟用商品規格時，SKU 不可包含規格選項", 400);
    }
    const optionSignature = optionValueIds.length
      ? [...optionValueIds].sort().join("|")
      : "default";
    if (variantSignatures.has(optionSignature)) {
      return errorResponse(request, env, `SKU ${sku} 的規格組合重複`, 409);
    }
    variantSignatures.add(optionSignature);
    variants.push({
      id: typeof variant.id === "string" ? variant.id : undefined,
      sku,
      optionValueIds,
      optionValues: optionValues as ProductVariantOptionValueInput[],
      price: variantPrice,
      compareAtPrice: variantCompareAtPrice,
      stock,
      safetyStock: variantSafetyStock,
      reserved,
      imageUrl,
      purchasable: variant.purchasable,
    });
  }
  if (new Set(variants.map((variant) => variant.sku)).size !== variants.length) {
    return errorResponse(request, env, "商品規格 SKU 不可重複", 400);
  }

  const colorImages: ProductColorImageInput[] = [];
  if (raw.colorImages !== undefined && !Array.isArray(raw.colorImages)) {
    return errorResponse(request, env, "顏色圖片格式不正確", 400);
  }
  if (Array.isArray(raw.colorImages) && raw.colorImages.length > 20) {
    return errorResponse(request, env, "顏色圖片最多 20 張", 400);
  }
  const colorOptionIds = new Set(
    specifications
      .filter((specification) =>
        ["顏色", "颜色", "color"].includes(specification.name.trim().toLocaleLowerCase()),
      )
      .flatMap((specification) => specification.options.map((option) => option.id!)),
  );
  for (const value of (raw.colorImages as unknown[] | undefined) ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return errorResponse(request, env, "顏色圖片格式不正確", 400);
    }
    const image = value as Record<string, unknown>;
    const optionId = stringValue(image.optionId, 160);
    const imageUrl = stringValue(image.imageUrl, 2_048);
    const canonicalOption = optionId ? optionById.get(optionId) : undefined;
    if (!optionId || !imageUrl || !canonicalOption || !colorOptionIds.has(optionId) ||
        colorImages.some((item) => item.optionId === optionId)) {
      return errorResponse(request, env, "顏色圖片必須對應不重複的顏色選項", 400);
    }
    colorImages.push({ optionId, optionName: canonicalOption.optionName, imageUrl });
  }
  // 相容舊版後台：未傳 colorImages 時，從同顏色 SKU 的第一張既有圖片搬移。
  if (raw.colorImages === undefined) {
    variants.forEach((variant) => {
      const colorOption = variant.optionValues.find((value) => colorOptionIds.has(value.optionId));
      if (colorOption && variant.imageUrl &&
          !colorImages.some((image) => image.optionId === colorOption.optionId)) {
        colorImages.push({
          optionId: colorOption.optionId,
          optionName: colorOption.optionName,
          imageUrl: variant.imageUrl,
        });
      }
    });
  }

  return {
    name, code, category, categoryId, price, compareAtPrice, cost, safetyStock,
    status: scheduledPublishAt ? "inactive" : status as ProductStatus,
    scheduledPublishAt, tagType: tagType as ProductTagType,
    images, colorImages, brand, description, seoTitle,
    seoDescription, specificationsEnabled, specifications, variants, sortOrder,
  };
}

async function validateRelations(
  request: Request,
  env: Env,
  input: ProductInput,
  excludingId?: string,
): Promise<{ categoryId: string; category: string } | Response> {
  const category = input.categoryId
    ? await env.DB.prepare("SELECT id, name FROM product_categories WHERE id = ?")
      .bind(input.categoryId).first<{ id: string; name: string }>()
    : await env.DB.prepare("SELECT id, name FROM product_categories WHERE name = ?")
      .bind(input.category).first<{ id: string; name: string }>();
  if (!category) return errorResponse(request, env, "找不到指定商品分類", 400);

  const duplicateCode = await env.DB.prepare(`
    SELECT id FROM products WHERE code = ? AND (? IS NULL OR id <> ?) LIMIT 1
  `).bind(input.code, excludingId ?? null, excludingId ?? null).first<{ id: string }>();
  if (duplicateCode) return errorResponse(request, env, "商品編號已存在", 409);

  const placeholders = input.variants.map(() => "?").join(",");
  const duplicateSku = await env.DB.prepare(`
    SELECT sku FROM product_variants
    WHERE sku IN (${placeholders}) AND (? IS NULL OR product_id <> ?) LIMIT 1
  `).bind(...input.variants.map((variant) => variant.sku), excludingId ?? null, excludingId ?? null)
    .first<{ sku: string }>();
  if (duplicateSku) return errorResponse(request, env, `SKU ${duplicateSku.sku} 已存在`, 409);
  return { categoryId: category.id, category: category.name };
}

function slugFromCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function scopedId(kind: "image" | "color" | "spec" | "option" | "variant", productId: string, id?: string): string {
  const prefix = `${kind}_${productId}_`;
  if (id?.startsWith(prefix)) return id;
  const suffix = id && /^[a-zA-Z0-9_-]{1,160}$/.test(id) ? id : crypto.randomUUID();
  return `${prefix}${suffix}`;
}

type SqlValue = string | number | null;

function appendBatchedInsert(
  statements: D1PreparedStatement[],
  env: Env,
  table: string,
  columns: string,
  rows: SqlValue[][],
  chunkSize: number,
) {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const width = chunk[0]?.length ?? 0;
    const placeholders = chunk
      .map(() => `(${Array.from({ length: width }, () => "?").join(",")})`)
      .join(",");
    statements.push(
      env.DB.prepare(`INSERT INTO ${table} (${columns}) VALUES ${placeholders}`)
        .bind(...chunk.flat()),
    );
  }
}

export async function listProducts(request: Request, env: Env): Promise<Response> {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const pageValue = url.searchParams.get("page");
  const pageSizeValue = url.searchParams.get("pageSize");
  const page = pageValue === null ? 1 : Number(pageValue);
  const pageSize = pageSizeValue === null ? 20 : Number(pageSizeValue);
  if (!Number.isInteger(page) || page < 1) {
    return errorResponse(request, env, "page 必須是大於 0 的整數", 400);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return errorResponse(request, env, "pageSize 必須是 1 至 100 的整數", 400);
  }

  const search = url.searchParams.get("search")?.trim() ?? "";
  const status = url.searchParams.get("status")?.trim() ?? "";
  const tagType = url.searchParams.get("tagType")?.trim() ?? "";
  const categoryId = url.searchParams.get("categoryId")?.trim() ?? "";
  const category = url.searchParams.get("category")?.trim() ?? "";
  const dateFrom = url.searchParams.get("dateFrom")?.trim() ?? "";
  const dateTo = url.searchParams.get("dateTo")?.trim() ?? "";
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (search.length > 100) return errorResponse(request, env, "搜尋文字不可超過 100 字", 400);
  if (status && !["active", "inactive", "draft"].includes(status)) {
    return errorResponse(request, env, "商品狀態篩選格式不正確", 400);
  }
  if (tagType && !["popular", "preorder", "new", "none"].includes(tagType)) {
    return errorResponse(request, env, "分類標籤篩選格式不正確", 400);
  }
  if (categoryId.length > 100 || category.length > 80) {
    return errorResponse(request, env, "商品分類篩選格式不正確", 400);
  }
  if ((dateFrom && !datePattern.test(dateFrom)) || (dateTo && !datePattern.test(dateTo)) ||
      (dateFrom && dateTo && dateFrom > dateTo)) {
    return errorResponse(request, env, "建立日期篩選格式不正確", 400);
  }

  const conditions: string[] = [];
  const bindings: SqlValue[] = [];
  if (search) {
    const keyword = `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    conditions.push("(p.name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\')");
    bindings.push(keyword, keyword);
  }
  if (status) {
    conditions.push("p.status = ?");
    bindings.push(status);
  }
  if (tagType) {
    conditions.push("p.tag_type = ?");
    bindings.push(tagType);
    if (tagType !== "none") conditions.push("p.status = 'active'");
  }
  if (categoryId) {
    conditions.push(`p.category_id IN (
      WITH RECURSIVE category_tree(id) AS (
        SELECT id FROM product_categories WHERE id = ?
        UNION ALL
        SELECT child.id FROM product_categories child
        INNER JOIN category_tree parent ON child.parent_id = parent.id
      )
      SELECT id FROM category_tree
    )`);
    bindings.push(categoryId);
  } else if (category) {
    conditions.push("p.category = ?");
    bindings.push(category);
  }
  if (dateFrom) {
    conditions.push("date(datetime(p.created_at, '+8 hours')) >= ?");
    bindings.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("date(datetime(p.created_at, '+8 hours')) <= ?");
    bindings.push(dateTo);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM products p ${where}`)
    .bind(...bindings).first<{ total: number }>();
  const total = count?.total ?? 0;
  const result = await env.DB.prepare(`
    SELECT ${productColumns}
    FROM products p
    ${where}
    ORDER BY p.created_at DESC, p.sort_order ASC
    LIMIT ? OFFSET ?
  `).bind(...bindings, pageSize, (page - 1) * pageSize).all<ProductRow>();
  return respond(
    request,
    env,
    result.results.map(serializeProduct),
    "操作成功",
    200,
    { page, pageSize, total },
  );
}

export async function getProduct(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "view");
  if (admin instanceof Response) return admin;
  const row = await getRow(env, id);
  return row
    ? respond(request, env, serializeProduct(row))
    : errorResponse(request, env, "找不到指定商品", 404);
}

async function writeProduct(
  request: Request,
  env: Env,
  id?: string,
): Promise<Response> {
  const action = id ? "edit" : "create";
  const admin = await authorize(request, env, action);
  if (admin instanceof Response) return admin;
  if (id && !(await getRow(env, id))) return errorResponse(request, env, "找不到指定商品", 404);
  const input = await parseInput(request, env);
  if (input instanceof Response) return input;
  const relation = await validateRelations(request, env, input, id);
  if (relation instanceof Response) return relation;

  const productId = id ?? `prod_${crypto.randomUUID()}`;
  const stock = input.variants.reduce((sum, variant) => sum + variant.stock, 0);
  const primaryImage = input.images.find((image) => image.isPrimary)?.imageUrl ?? null;
  const specificationIdMap = new Map(
    input.specifications.map((specification) => [
      specification.id!,
      scopedId("spec", productId, specification.id),
    ]),
  );
  const optionIdMap = new Map<string, string>();
  input.specifications.forEach((specification) => {
    specification.options.forEach((option) => {
      optionIdMap.set(option.id!, scopedId("option", productId, option.id));
    });
  });
  const statements: D1PreparedStatement[] = [];
  if (id) {
    statements.push(env.DB.prepare(`
      UPDATE products SET
        name = ?, code = ?, category = ?, category_id = ?, description = ?, price = ?,
        compare_at_price = ?, cost = ?, inventory = ?, safety_stock = ?, status = ?,
        scheduled_publish_at = ?,
        tag_type = ?, active = ?, image_url = ?, brand = ?, seo_title = ?,
        seo_description = ?, specifications_enabled = ?, sort_order = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      input.name, input.code, relation.category, relation.categoryId, input.description, input.price,
      input.compareAtPrice, input.cost, stock, input.safetyStock, input.status,
      input.scheduledPublishAt,
      input.tagType, input.status === "active" ? 1 : 0, primaryImage,
      input.brand, input.seoTitle, input.seoDescription,
      input.specificationsEnabled ? 1 : 0, input.sortOrder, productId,
    ));
    statements.push(
      env.DB.prepare("DELETE FROM product_images WHERE product_id = ?").bind(productId),
      env.DB.prepare("DELETE FROM product_variants WHERE product_id = ?").bind(productId),
      env.DB.prepare("DELETE FROM product_specifications WHERE product_id = ?").bind(productId),
    );
  } else {
    let slug = slugFromCode(input.code) || productId;
    const slugExists = await env.DB.prepare("SELECT id FROM products WHERE slug = ? LIMIT 1")
      .bind(slug).first<{ id: string }>();
    if (slugExists) slug = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
    statements.push(env.DB.prepare(`
      INSERT INTO products (
        id, slug, name, code, category, category_id, description, price, compare_at_price,
        cost, inventory, safety_stock, status, scheduled_publish_at, tag_type, active, image_url, brand,
        seo_title, seo_description, specifications_enabled, visual, tone, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'product', 'cream', ?)
    `).bind(
      productId, slug, input.name, input.code, relation.category, relation.categoryId,
      input.description, input.price, input.compareAtPrice, input.cost, stock,
      input.safetyStock, input.status, input.scheduledPublishAt, input.tagType,
      input.status === "active" && !input.scheduledPublishAt ? 1 : 0,
      primaryImage, input.brand,
      input.seoTitle, input.seoDescription, input.specificationsEnabled ? 1 : 0,
      input.sortOrder,
    ));
  }
  const imageRows: SqlValue[][] = input.images.map((image) => [
      scopedId("image", productId, image.id), productId, image.imageUrl,
      image.altText, image.sortOrder, image.isPrimary ? 1 : 0,
  ]);
  appendBatchedInsert(
    statements,
    env,
    "product_images",
    "id, product_id, image_url, alt_text, sort_order, is_primary",
    imageRows,
    15,
  );
  const specificationRows: SqlValue[][] = [];
  const optionRows: SqlValue[][] = [];
  input.specifications.forEach((specification) => {
    const specificationId = specificationIdMap.get(specification.id!)!;
    specificationRows.push([
      specificationId, productId, specification.name, specification.sortOrder,
    ]);
    specification.options.forEach((option) => {
      optionRows.push([
        optionIdMap.get(option.id!)!, specificationId, option.name, option.sortOrder,
      ]);
    });
  });
  appendBatchedInsert(
    statements,
    env,
    "product_specifications",
    "id, product_id, name, sort_order",
    specificationRows,
    20,
  );
  appendBatchedInsert(
    statements,
    env,
    "product_specification_options",
    "id, specification_id, name, sort_order",
    optionRows,
    20,
  );
  const colorImageRows: SqlValue[][] = input.colorImages.map((image) => [
    scopedId("color", productId, image.optionId),
    productId,
    optionIdMap.get(image.optionId)!,
    image.imageUrl,
  ]);
  appendBatchedInsert(
    statements,
    env,
    "product_color_images",
    "id, product_id, option_id, image_url",
    colorImageRows,
    20,
  );
  const variantRows: SqlValue[][] = [];
  const variantOptionRows: SqlValue[][] = [];
  input.variants.forEach((variant, index) => {
    const variantId = scopedId("variant", productId, variant.id);
    variantRows.push([
      variantId, productId, variant.sku, variant.price, variant.compareAtPrice,
      variant.stock, variant.safetyStock, variant.reserved,
      variant.optionValues.some((value) =>
        input.colorImages.some((image) => image.optionId === value.optionId)
      ) ? null : variant.imageUrl,
      variant.purchasable ? 1 : 0, index,
      variant.optionValueIds.length ? [...variant.optionValueIds].sort().join("|") : "default",
    ]);
    variant.optionValueIds.forEach((optionId, optionIndex) => {
      const option = variant.optionValues[optionIndex]!;
      variantOptionRows.push([
        variantId,
        specificationIdMap.get(option.specificationId)!,
        optionIdMap.get(optionId)!,
        optionIndex,
      ]);
    });
  });
  appendBatchedInsert(
    statements,
    env,
    "product_variants",
    "id, product_id, sku, price, compare_at_price, stock, safety_stock, reserved, image_url, purchasable, sort_order, option_signature",
    variantRows,
    8,
  );
  appendBatchedInsert(
    statements,
    env,
    "product_variant_option_values",
    "variant_id, specification_id, option_id, sort_order",
    variantOptionRows,
    20,
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("product_variants.product_id") && detail.includes("option_signature")) {
      return errorResponse(request, env, "商品包含重複的 SKU 規格組合", 409);
    }
    if (detail.includes("product_variants.sku")) {
      return errorResponse(request, env, "SKU 編號已被其他商品使用", 409);
    }
    throw error;
  }
  const row = await getRow(env, productId);
  return respond(request, env, serializeProduct(row!), id ? "商品已更新" : "商品已建立", id ? 200 : 201);
}

export function createProduct(request: Request, env: Env): Promise<Response> {
  return writeProduct(request, env);
}

export function updateProduct(request: Request, env: Env, id: string): Promise<Response> {
  return writeProduct(request, env, id);
}

export async function publishScheduledProducts(env: Env): Promise<void> {
  await env.DB.prepare(`
    UPDATE products
    SET status = 'active', active = 1, scheduled_publish_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE active = 0 AND scheduled_publish_at IS NOT NULL
      AND datetime(scheduled_publish_at) <= CURRENT_TIMESTAMP
  `).run();
}

export async function deleteProduct(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await authorize(request, env, "delete");
  if (admin instanceof Response) return admin;
  const row = await getRow(env, id);
  if (!row) return errorResponse(request, env, "找不到指定商品", 404);
  const orderItem = await env.DB.prepare("SELECT id FROM order_items WHERE product_id = ? LIMIT 1")
    .bind(id).first<{ id: string }>();
  if (orderItem) return errorResponse(request, env, "商品已有訂單紀錄，無法刪除；請改為下架", 409);
  await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return respond(request, env, null, "商品已刪除");
}
