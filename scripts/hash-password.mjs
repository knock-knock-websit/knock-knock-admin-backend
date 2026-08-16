import { pbkdf2Sync, randomBytes } from "node:crypto";

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error("用法：npm run password:hash -- '至少 12 字元的密碼'");
  process.exit(1);
}

const iterations = 210_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const base64Url = (value) => value.toString("base64url");
process.stdout.write(`pbkdf2_sha256$${iterations}$${base64Url(salt)}$${base64Url(hash)}\n`);
