# KNOCK-KNOCK Admin Backend

獨立的 Cloudflare Worker 後台 API，透過 `DB` binding 使用共用 D1。此服務與公開商店 API 分離，負責後台登入、session 驗證及角色權限。

## API

- `GET /health`
- `POST /api/auth/login`，body：`{"email":"admin@knock-knock.tw","password":"..."}`
- `POST /api/auth/logout`，需要 Bearer token；登出後該帳號既有 token 立即失效
- `GET /api/auth/me`，需要 Bearer token
- `GET /api/admin/roles`，需要 `admins:view` 權限
- `GET /api/admin/admin-users`，需要 `admins:view` 權限
- `POST /api/admin/admin-users`，只有 `super_admin` 且具備 `admins:create` 權限可使用；建立自訂角色、功能權限與管理員帳號
- `GET|POST /api/admin/carousels`、`PUT|DELETE /api/admin/carousels/:id`，需要對應的 `content` 權限
- `POST /api/admin/uploads/content`，上傳輪播圖片，需要 `content:create` 或 `content:edit`
- `GET|POST /api/admin/marquees`、`PUT|DELETE /api/admin/marquees/:id`，需要對應的 `content` 權限
- `GET /api/admin/customers`，需要 `customers:view` 權限；支援 `search`、`loginStatus`、`page`、`pageSize`
- `GET /api/admin/orders`，需要 `orders:view` 權限
- `PATCH /api/admin/orders/:id`，需要 `orders:edit` 權限
- `GET /api/admin/dashboard`，回傳營運總覽的今日指標、近七日銷售、近期訂單及近三十日熱銷商品
- `GET /api/admin/categories`，需要 `categories:view` 權限
- `POST /api/admin/categories`，需要 `categories:create` 權限
- `PATCH /api/admin/categories/:id`，需要 `categories:edit` 權限
- `DELETE /api/admin/categories/:id`，需要 `categories:delete` 權限；有子分類或商品時不可刪除

分類列表以樹狀格式回傳；分類的 `parentId` 若符合上層分類的 `id`，該分類會出現在上層分類的 `children[]` 中。
- `GET /api/admin/products`，需要 `products:view` 權限
- `GET /api/admin/products/:id`，需要 `products:view` 權限
- `POST /api/admin/products`，需要 `products:create` 權限
- `PUT /api/admin/products/:id`，需要 `products:edit` 權限
- `DELETE /api/admin/products/:id`，需要 `products:delete` 權限；已有訂單紀錄時請改為下架
- `POST /api/admin/uploads/products`，multipart 欄位為 `file`，需要商品新增或編輯權限
- `GET /api/uploads/products/:key`，公開讀取已上傳的商品圖片

商品回傳包含 `compareAtPrice`（未設定時為 `null`）、`images[]`、`colorImages[]` 與 `variants[]`。
圖片最多 20 張且只能有一張主圖；未指定主圖時會自動將第一張設為主圖。
上傳支援 JPG、PNG 與 WebP，單張最大 5MB，檔案儲存於 `PRODUCT_IMAGES` R2 binding。

商品規格 request/response 與後台表單一致：

- `specificationsEnabled`：是否啟用多規格
- `specifications[]`：規格群組，包含 `id`、`name`、`sortOrder`、`options[]`
- `colorImages[]`：顏色共用圖片，包含 `optionId`、`optionName`、`imageUrl`；同顏色的所有 SKU 共用一張
- `variants[]`：SKU 組合，包含 `optionValueIds[]`、`optionValues[]`、`price`、`compareAtPrice`、`stock`、`safetyStock`、`reserved`、`imageUrl` 與 `purchasable`

`variants[].imageUrl` 仍會回傳對應顏色圖片，供舊版前台相容使用；資料庫實際只在顏色層級儲存一次。

商品列表支援以下 query parameters：

- `page`：頁碼，預設 `1`
- `pageSize`：每頁筆數，預設 `20`，最大 `100`
- `search`：搜尋商品名稱或商品編號
- `status`：`active`、`inactive` 或 `draft`
- `categoryId`：分類 ID，會包含所有子分類商品
- `category`：分類名稱；未傳 `categoryId` 時使用
- `dateFrom`、`dateTo`：台灣時間建立日期，格式 `YYYY-MM-DD`

登入連續失敗 5 次會鎖定 15 分鐘；access token 預設有效 8 小時。修改帳號的 `token_version` 可讓既有 token 失效。

## 本機啟動

1. 執行 `npm install`。
2. 複製 `.dev.vars.example` 為 `.dev.vars`，設定至少 32 字元的 `JWT_SECRET`。
3. 執行 `npm run d1:migrate:local`。本機 D1 會與公開商店 Worker 共用根目錄的 `.wrangler/shared-state`。
4. 用 `npm run password:hash -- '你的安全密碼'` 產生密碼雜湊。
5. 在 D1 新增第一位管理員（將下方 `HASH` 換成上一步結果）：

```sql
npm run d1:execute:local -- --command \
"INSERT INTO admin_users (id, role_id, email, name, password_hash)
 VALUES (
   'admin-1',
   'role_super_admin',
   'admin@knock.com',
   'Administrator',
   'HASH'
 );"
```

6. 執行 `npm run dev`，預設網址為 `http://localhost:8788`。
7. 後台前端設定 `VITE_API_BASE_URL=http://localhost:8788/api` 與 `VITE_USE_MOCK=false`。

後台商品與分類頁不再提供 mock 分支，所有新增、修改與刪除都會送到 Admin Backend API。商品必須切換為「上架」後，才會出現在公開商店 API。

部署前執行 `npm run typecheck` 與 `npm run build`，並使用 `wrangler secret put JWT_SECRET` 設定登入簽章密鑰。
