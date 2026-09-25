// طبقة تشغيل الداتابيز — بتغلّف libSQL (Turso) وبتحاكي واجهة better-sqlite3 القديمة.
//
// ليه ده موجود: db.js كان مكتوب على better-sqlite3، وده API **متزامن (sync)**.
// لكن Turso بيشتغل over HTTP، فكل نداء بقى **Promise**. عشان ما نكتبش await في
// كل سطر من الـ 1944 سطر، عاملين adapter بيرجّع نفس الأسماء والأشكال:
//
//   stmt.get(...)   -> الصف الأول أو null            (libSQL بيرجّع مصفوفة)
//   stmt.all(...)   -> مصفوفة صفوف
//   stmt.run(...)   -> { changes, lastInsertRowid }  (libSQL: rowsAffected)
//
// يعني كل الـ SQL في db.js فضل زي ما هو حرف بحرف، والتغيير كله async/await.
import { createClient } from "@libsql/client";
import { config } from "./config.js";

export const client = createClient({
  url: config.tursoUrl,
  authToken: config.tursoAuthToken || undefined,
  // نخلّي الأعدادnumbers عادية (مش bigint) عشان الـ arithmetic في الكود ميتكسرش
  intMode: "number",
});

// نستخدم execute بدل prepare/Statement عن قصد:
// execute موجود في الـ Client interface لكل الـ backends (Turso over HTTP،
// و file: المحلي للتطوير)، بينما prepare/statement موجود في الريموت بس.
// الب contrap: مفيش تخزين مؤقت للـ prepared statements، بس مقبول لحجم المشروع ده.
function prep(sql) {
  const run = async (args) => {
    const a = args || [];
    // better-sqlite3 كان بميت لو حد مرّر undefined، و libSQL بيميت برضه.
    // بنقولنا الجملة اللي فيها المشكلة بدل ما نتعامل مع stack trace غامض.
    const undef = a.findIndex((v) => v === undefined);
    if (undef >= 0) {
      throw new Error(
        `undefined في المعامل رقم ${undef + 1} من الجملة:\n${sql}\nargs=${JSON.stringify(a)}`
      );
    }
    // libSQL بيقبل numbers/strings/bigints/buffers/null بس. أي حاجة تانية
    // (boolean / object / array) بتقع جوه الـ generator فما بيطلعش منها stack
    // مفيد، فبنتش ourselves ونقولنا الجملة والمعامل.
    const badAt = a.findIndex(
      (v) =>
        v !== null &&
        typeof v !== "string" &&
        typeof v !== "number" &&
        typeof v !== "bigint" &&
        !ArrayBuffer.isView(v)
    );
    if (badAt >= 0) {
      throw new Error(
        `معامل رقم ${badAt + 1} من نوع ${typeof a[badAt]} (مش مفعول لـ SQLite) في الجملة:\n${sql}\nargs=${JSON.stringify(a)}`
      );
    }
    return client.execute({ sql, args: a });
  };
  return {
    async get(...args) {
      const rows = (await run(args)).rows;
      return rows[0] ?? null;
    },
    async all(...args) {
      return (await run(args)).rows;
    },
    async run(...args) {
      const rs = await run(args);
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
    },
  };
}

export const db = {
  prepare: prep,
  // جملة واحدة أو أكتر (الـ schema كله) — libSQL عندها executeMultiple
  async exec(sql) {
    await client.executeMultiple(sql);
  },
  // PRAGMAs بتاعة الملف المحلي (WAL / busy_timeout / synchronous) مالهاش لازمة
  // علىTurso — الـ libSQL بيتولّى الـ concurrency بنفسه. بنتجاهلها بأمان.
  pragma() {},
  // جدول الأعمدة — بنستخدم table-valued pragma لأنها أدق من PRAGMA عبر HTTP
  async columns(table) {
    const rs = await client.execute({
      sql: `SELECT name FROM pragma_table_info(?)`,
      args: [table],
    });
    return rs.rows.map((r) => r.name);
  },
  // transaction تفاعلي — نفس روح db.transaction بتاع better-sqlite3
  transaction(mode = "write") {
    const tx = client.transaction(mode);
    return async (fn) => tx(fn);
  },
};

// فاضي/مكرر؟ small helpers
export const noop = async () => {};
