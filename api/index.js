// نقطة دخول Vercel — بيصدّر Express app كـ serverless function.
// بنبني الـ app مرة واحدة على مستوى الموديل (top-level await) عشان كل نداء
// للـ function يلاقي الـ app جاهز، مش يعمل setup تاني كل مرة.
import { createApp } from "../src/server.js";

const app = await createApp();

export default app;
