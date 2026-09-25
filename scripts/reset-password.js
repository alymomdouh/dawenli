// إعادة تعيين كلمة سر مستخدم.
// يشتغل على الداتابيز المعرّفة في .env — يعني Turso في الإنتاج وملف محلي في التطوير.
// (كان شغال على better-sqlite3 والـ DB_PATH بس، فكان بيفشل مع Turso)
//
//   node scripts/reset-password.js                       → اعرض المستخدمين
//   node scripts/reset-password.js <email> <new-password> → غيّر بالايميل
//   node scripts/reset-password.js --owner <new-password> → غيّر حساب الـ owner
//
// ملاحظة: نفس دالة التجزئة بالظبط اللي في src/server.js (scrypt).
import crypto from "node:crypto";
import { config } from "../src/config.js";
import { listUsers, setUserPassword } from "../src/db.js";

// نفس hashPassword في src/server.js — "salt:hash", scrypt keylen=64
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function showUsers() {
  const rows = (await listUsers()).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email ?? null,
    is_owner: u.is_owner ?? 0,
    has_pw: u.password_hash ? "نعم" : "لا",
  }));
  console.table(rows);
  return rows;
}

const [target, newPassword] = process.argv.slice(2);

if (!target) {
  console.log(`\n📂 الداتابيز: ${config.tursoUrl}\n`);
  console.log("المستخدمين الموجودين:\n");
  await showUsers();
  console.log(`\nالاستخدام:\n  node scripts/reset-password.js <email> <new-password>\n  node scripts/reset-password.js --owner <new-password>\n`);
  process.exit(0);
}

if (!newPassword || String(newPassword).length < 6) {
  console.error("❌ لازم تكتب كلمة سر جديدة (٦ حروف على الأقل).");
  console.error("   مثال: node scripts/reset-password.js --owner 0127533566");
  process.exit(1);
}

const users = await listUsers();
let user;
if (target === "--owner") {
  user = users.find((u) => u.is_owner === 1);
  if (!user) {
    console.error("❌ مفيش حساب owner (is_owner=1) في الداتابيز.");
    process.exit(1);
  }
} else {
  const email = String(target).trim().toLowerCase();
  user = users.find((u) => String(u.email ?? "").toLowerCase() === email);
  if (!user) {
    console.error(`❌ مفيش مستخدم بالإيميل ده: ${email}\n   دي قائمة المستخدمين:`);
    await showUsers();
    process.exit(1);
  }
}

const ok = await setUserPassword(user.id, hashPassword(newPassword));

if (ok) {
  console.log(`\n✅ اتغيّرت كلمة السر بنجاح.\n`);
  console.log(`   المستخدم : ${user.name || "(بدون اسم)"} (id=${user.id})`);
  console.log(`   الإيميل  : ${user.email || "(مفيش إيميل — مش هينفع تسجّل دخول بإيميل)"}`);
  console.log(`   الباسورد : ${newPassword}`);
  console.log(`\n🔐 ادخل من صفحة الدخول بالإيميل + الباسورد دول.`);
  if (!user.email) {
    console.log(`⚠️  الحساب ده ملوش إيميل، فالدخول بالإيميل مش هيشتغل. لازم تحط إيميل للحساب الأول.`);
  }
} else {
  console.error("❌ معرفتش أحدّث — مفيش صف اتغيّر.");
  process.exit(1);
}
