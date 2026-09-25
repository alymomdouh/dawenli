// نسخة احتياطية آمنة من قاعدة البيانات — online + WAL-safe (مش بيوقف التطبيق)،
// مع الاحتفاظ بآخر N نسخة بس. بيتشغّل من cron يوميًا.
// التشغيل اليدوي: node scripts/backup-db.js
import "dotenv/config";
import Database from "better-sqlite3";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";

// السكربت ده بيشتغل على ملف محلي بس. لو الداتابيز ريموتة (Turso) فمش هينفع
// ينسخ ملف — وTurbo عنده point-in-time recovery فالنسخ اليدوي مش محتاج.
if (!config.tursoUrl.startsWith("file:")) {
  console.error("❌ النسخ الاحتياطي المحلي مش متاح على داتابيز ريموتة.");
  console.error(`  TURSO_DATABASE_URL = ${config.tursoUrl}`);
  console.error("   استخدم scripts/migrate-to-turso.js للترحيل، أو صدّر نسخة من Turso dashboard.");
  process.exit(1);
}

const KEEP = Number(process.env.BACKUP_KEEP || 14);
// المسار الفعلي بقى من config (شيلنا file:) — مش DB_PATH، لإنه لما TURSO فاضي
// التطبيق بيشتغل على data/dawenli-local.db لا على داتابيز قديمة.
const dbPath = config.tursoUrl.replace(/^file:/, "");
const dir = join(dirOf(dbPath), "backups");

function dirOf(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : ".";
}

mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dest = join(dir, `dawenli-${stamp}.db`);

const db = new Database(dbPath, { readonly: true });
await db.backup(dest); // لقطة متّسقة حتى والتطبيق شغّال
db.close();

// التدوير: سيب آخر KEEP نسخة وامسح الأقدم
const files = readdirSync(dir)
  .filter((f) => f.startsWith("dawenli-") && f.endsWith(".db"))
  .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
for (const x of files.slice(KEEP)) unlinkSync(join(dir, x.f));

console.log(`[${new Date().toISOString()}] backup -> ${dest} | kept ${Math.min(files.length, KEEP)}`);
