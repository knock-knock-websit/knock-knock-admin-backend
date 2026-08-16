export type Env = {
  DB: D1Database;
  PRODUCT_IMAGES: R2Bucket;
  JWT_SECRET: string;
  ADMIN_ORIGIN?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
};

export type AdminSessionRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  avatar: string | null;
  active: number;
  failed_login_count: number;
  locked_until: string | null;
  token_version: number;
  last_login_at: string | null;
  role_id: string;
  role_code: string;
  role_name: string;
  role_active: number;
  permissions: string;
};

export type TokenPayload = {
  sub: string;
  role: string;
  version: number;
  iat: number;
  exp: number;
};

export type PermissionMap = Record<string, string[]>;
