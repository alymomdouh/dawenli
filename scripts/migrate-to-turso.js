// ترحيل البيانات من SQLite المحلي → Turso (libSQL).
//
// ليش ده لازم: الداتابيز القديمة `data/dawenli.db` فيها حسابات المستخدم
// وكل البيانات. من غير ترحيل، النشر على Vercel هيفتح داتابيز فاضية.
//
// التشغيل:  node scripts/migrate-to-turso.js [--dry-run] [--from=./data/dawenli.db]
//
// ملاحظات:
//   - بننسخ كل الجداول اللي موجودة في الاتنين، ونحافظ على الـ id والـ password_hash
//     زي ما هما (مفيش إعادة توليد — الحساب هيفضل شغال بنفس كلمة السر).
//   - الـ script آمن يتعاد تشغيله: INSERT OR REPLACE بالـ primary key، فالتشغيل
//     التاني بيحدّث الصفوف الموجودة بدل ما يعمل duplicate.
//   - جداول الجلسات والجلسات rate limiting (sessions / rate_limits) مش بيتبعتوا
//     عن قصد — دي جلسات محلية مش عايزينها تفضل شغالة بعد الترحيل.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { config } from "../src/config.js";

// import دول بيعمل الـ schema والـ migrations في داتابيز الوجهة لو مش موجودة.
// من غيره أول تشغيل على داتابيز فاضية بيفشل لأن الجداول لسه معمولةش.
import "../src/db.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { createClient } = require("@libsql/client");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fromArg = args.find((a) => a.startsWith("--from="));
const FROM = fromArg ? fromArg.slice(7) : "./data/dawenli.db";

// جداول 本公司 نبدأ بيها: الترتيب بيفترض وجود قيود مرجعية
const SKIP = new Set(["sessions", "rate_limits"]);

if (!existsSync(FROM)) {
  console.error(`❌ مفيش قاعدة بيانات قديمة عند: ${FROM}`);
  process.exit(1);
}

const old = new Database(FROM, { readonly: true });
const tables = old
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name)
  .filter((t) => !SKIP.has(t));

console.log(`📦 المصدر:    ${FROM}`);
console.log(`🎯 الوجهة:    ${config.tursoUrl}`);
console.log(`📋 جداول:     ${tables.length}${SKIP.size ? ` (مستبعدة: ${[...SKIP].join(", ")})` : ""}`);
if (dryRun) console.log("\n⚠️  وضع --dry-run: مش هينكتب حاجة.\n");

const client = createClient({
  url: config.tursoUrl,
  authToken: config.tursoAuthToken || undefined,
  intMode: "number",
});

// better-sqlite3 بيرجّع Buffer للـ BLOB، و libSQL عايز Uint8Array
const toBindable = (v) => (Buffer.isBuffer(v) ? new Uint8Array(v) : v);

const remoteTables = (
  await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'"
  )
).rows.map((r) => r.name);

let totalRows = 0;
let copied = 0;
let skipped = 0;
const report = [];

for (const t of tables) {
  if (!remoteTables.includes(t)) {
    console.log(`  ⏭️  ${t} — مش موجودة في الوجهة، تخطّت`);
    skipped++;
    continue;
  }
  const cols = (
    await client.execute({ sql: "SELECT name FROM pragma_table_info(?)", args: [t] })
  ).rows.map((r) => r.name);

  const q = `SELECT * FROM "${t}"`;
  const rows = old.prepare(q).all();
  totalRows += rows.length;
  if (!rows.length) {
    report.push({ t, n: 0 });
    continue;
  }

  if (!dryRun) {
    // الأعمدة المشتركة بس — لو زاد عمود في بنية الوجهة بعد الترحيل
    const shared = cols.filter((c) => c in rows[0]);
    const placeholders = shared.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO "${t}" (${shared.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;
    // chunks عشان متكسرش حد الـ bind params في أي backend
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const argsRows = chunk.map((r) => shared.map((c) => toBindable(r[c])));
      for (const a of argsRows) await client.execute({ sql, args: a });
    }
  }
  copied += rows.length;
  report.push({ t, n: rows.length });
}

old.close();

console.log("\n📊 النتيجة:");
for (const { t, n } of report.filter((r) => r.n)) console.log(`   ${String(n).padStart(5)}  ${t}`);
console.log(`\n✅ اتنقل ${copied} صف من إجمالي ${totalRows}${skipped ? ` (${skipped} جدول اتخطّى)` : ""}`);
if (dryRun) console.log("ℹ️  ده كان dry-run — شغّل تاني من غير --dry-run للتطبيق.");

if (!dryRun && copied) {
  const users = (await client.execute("SELECT id, name, email, is_owner FROM users ORDER BY id")).rows;
  console.log("\n👥 المستخدمين في الوجهة:");
  for (const u of users) console.log(`   #${u.id} ${u.name} <${u.email ?? "—"}>${u.is_owner ? " (owner)" : ""}`);
}
