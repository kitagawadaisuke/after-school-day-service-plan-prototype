import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config.js";
import { createPgPool } from "../server/db/pool.js";

if (!process.argv.includes("--apply")) throw new Error("--apply を指定してください。");

const config = loadConfig();
if (config.nodeEnv === "production") throw new Error("本番環境では実行できません。");
const pool = createPgPool(config);
if (!pool) throw new Error("データベース接続が設定されていません。");

try {
  const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const migration = await readFile(resolve(projectRoot, "db/migrations/0031_contact_book_photos.sql"), "utf8");
  await pool.query(migration);
  console.log("contact-photo-schema-applied");
} finally {
  await pool.end();
}
