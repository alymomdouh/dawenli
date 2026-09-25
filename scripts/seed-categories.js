// زرع أصناف الصرف الإضافية. آمن للتكرار: التطبيع بيمتعامل مع «اختى»/«أختي»
// كاسم واحد، فالتشغيل التاني مش هيعمل تكرار.
//
//   node scripts/seed-categories.js [بريد المستخدم]
import { db } from "../src/sqlite.js";
import { addFinanceCategory, listFinanceCategories, ensureFinanceCategories } from "../src/db.js";

// أصناف مصروفات متكرّرة: شحن رصيد (هاتف/أنت/أهلك) — دي مصروفات عادية بتتقفل
// في «على ماذا تُنفق».
const WANTED = [
  ["رصيد انا",     "💳"],
  ["رصيد الهاتف",  "📱"],
  ["رصيد ابوى",    "👨"],
  ["رصيد اختى",    "👩"],
  ["هبه",          "👧"],
  ["اختى اسماء",   "👩‍🦱"],
];

const email = process.argv[2];
const row = email
  ? await db.prepare(`SELECT id, email FROM users WHERE email = ?`).get(email)
  : await db.prepare(`SELECT id, email FROM users WHERE email IS NOT NULL AND email <> '' ORDER BY id LIMIT 1`).get();
if (!row) { console.error("مفيش مستخدم بالبريد ده:", email); process.exit(1); }

const USER_ID = Number(row.id);
console.log(`target: id=${USER_ID}  ${row.email}`);

const before = await ensureFinanceCategories(USER_ID);
console.log(`before (${before.length}): ${before.map((c) => c.name).join(" | ")}`);

for (const [name, icon] of WANTED) {
  const r = await addFinanceCategory({ userId: USER_ID, name, icon });
  if (r.error) console.log(`  skip  ${name}  (${r.error})`);
  else console.log(`  add   ${name} ${icon}  id=${r.id}`);
}

const after = await listFinanceCategories(USER_ID);
console.log(`\nafter (${after.length}): ${after.map((c) => `${c.name}${c.icon || ""}`).join(" | ")}`);
process.exit(0);
