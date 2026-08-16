import { authenticate, hasPermission } from "./auth";
import { errorResponse, respond } from "./http";
import type { Env } from "./types";

type BankTransferSettings = { bankCode: string; bankName: string; branchName: string; accountName: string; accountNumber: string; note: string; updatedAt: string };
const columns = `bank_code AS bankCode, bank_name AS bankName, branch_name AS branchName,
  account_name AS accountName, account_number AS accountNumber, note, updated_at AS updatedAt`;

async function authorize(request: Request, env: Env, action: "view" | "edit") {
  const admin = await authenticate(request, env);
  if (admin instanceof Response) return admin;
  if (!hasPermission(admin, "payments", action)) return errorResponse(request, env, "您沒有管理銀行轉帳設定的權限", 403);
  return admin;
}

export async function getBankTransferSettings(request: Request, env: Env) {
  const admin = await authorize(request, env, "view"); if (admin instanceof Response) return admin;
  const row = await env.DB.prepare(`SELECT ${columns} FROM bank_transfer_settings WHERE id = 'default'`).first<BankTransferSettings>();
  return respond(request, env, row ?? { bankCode: "", bankName: "", branchName: "", accountName: "", accountNumber: "", note: "", updatedAt: "" });
}

export async function updateBankTransferSettings(request: Request, env: Env) {
  const admin = await authorize(request, env, "edit"); if (admin instanceof Response) return admin;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return errorResponse(request, env, "銀行資料格式不正確", 400); }
  const value = {
    bankCode: typeof body.bankCode === "string" ? body.bankCode.trim() : "",
    bankName: typeof body.bankName === "string" ? body.bankName.trim() : "",
    branchName: typeof body.branchName === "string" ? body.branchName.trim() : "",
    accountName: typeof body.accountName === "string" ? body.accountName.trim() : "",
    accountNumber: typeof body.accountNumber === "string" ? body.accountNumber.replace(/\s+/g, "").trim() : "",
    note: typeof body.note === "string" ? body.note.trim() : "",
  };
  if (!/^\d{3}$/.test(value.bankCode) || !value.bankName || !value.accountName || !/^\d{6,20}$/.test(value.accountNumber)
    || value.bankName.length > 100 || value.branchName.length > 100 || value.accountName.length > 100 || value.note.length > 500) {
    return errorResponse(request, env, "請確認銀行代碼、銀行名稱、戶名與帳號格式", 400);
  }
  await env.DB.prepare(`INSERT INTO bank_transfer_settings (id, bank_code, bank_name, branch_name, account_name, account_number, note)
    VALUES ('default', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET bank_code = excluded.bank_code,
    bank_name = excluded.bank_name, branch_name = excluded.branch_name, account_name = excluded.account_name,
    account_number = excluded.account_number, note = excluded.note, updated_at = CURRENT_TIMESTAMP`)
    .bind(value.bankCode, value.bankName, value.branchName, value.accountName, value.accountNumber, value.note).run();
  const row = await env.DB.prepare(`SELECT ${columns} FROM bank_transfer_settings WHERE id = 'default'`).first<BankTransferSettings>();
  return respond(request, env, row, "銀行轉帳資料已儲存");
}
