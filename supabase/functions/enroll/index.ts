// POST /functions/v1/enroll
// ลงทะเบียนใบหน้าครั้งแรก (ไม่ต้องล็อกอิน — ช่วงทดสอบใช้รหัสนักศึกษาอย่างเดียว)
// ⚠️ ก่อนใช้งานจริง: ควรเพิ่มการยืนยันตัวตนตอนลงทะเบียน (เช่น OTP อีเมลมหาวิทยาลัย หรือให้อาจารย์ยืนยันหน้าห้อง)
//
// body:
//   { action: 'lookup', student_code }                              → ชื่อ + ลงทะเบียนแล้วหรือยัง
//   { action: 'enroll', student_code, embedding, model_version,
//     consent: true, device_info? }                                 → บันทึก embedding (ไม่เก็บภาพ)

import { CORS, fail, json, serviceClient } from '../_shared/http.ts';
import { matchGlobal, toVector, validEmbedding } from '../_shared/face.ts';

const supabase = serviceClient();

// ใบหน้าที่คล้ายกับคนที่ลงทะเบียนไว้แล้วเกินค่านี้ = น่าจะเป็นคนเดียวกัน → กันคนเดียวลงทะเบียนแทนหลายรหัส
const DUPLICATE_THRESHOLD = 0.6;

async function findStudent(code: string) {
  const { data } = await supabase
    .from('students')
    .select('student_id, student_code, status, users ( full_name ), face_templates ( template_id )')
    .eq('student_code', code)
    .maybeSingle();
  if (!data) return null;
  return {
    student_id: data.student_id as string,
    student_code: data.student_code as string,
    status: data.status as string,
    full_name: (data.users as unknown as { full_name: string } | null)?.full_name ?? '',
    enrolled: ((data.face_templates as unknown[]) ?? []).length > 0,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);

  let body: { action?: string; student_code?: string; embedding?: number[]; model_version?: string; consent?: boolean; device_info?: string };
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }

  const code = String(body.student_code ?? '').trim();
  if (!/^\d{6,12}$/.test(code)) return fail('BAD_REQUEST', 'รหัสนักศึกษาไม่ถูกต้อง', 400);

  try {
    const student = await findStudent(code);
    if (!student) return fail('STUDENT_NOT_FOUND', 'ไม่พบรหัสนักศึกษานี้ในระบบ', 404);
    if (student.status !== 'active') return fail('STUDENT_INACTIVE', 'สถานะนักศึกษาไม่ใช่ปกติ', 403);

    if (body.action === 'lookup') {
      return json({ data: { student_code: student.student_code, full_name: student.full_name, enrolled: student.enrolled } });
    }

    if (body.action !== 'enroll') return fail('BAD_REQUEST', 'action ต้องเป็น lookup หรือ enroll', 400);
    if (body.consent !== true) return fail('CONSENT_REQUIRED', 'ต้องยินยอมให้ใช้ข้อมูลใบหน้าก่อน (PDPA)', 400);
    if (student.enrolled) return fail('ALREADY_ENROLLED', 'รหัสนี้ลงทะเบียนใบหน้าไว้แล้ว', 409);

    const emb = body.embedding;
    if (!validEmbedding(emb)) return fail('BAD_REQUEST', 'ข้อมูลใบหน้าไม่ถูกต้อง', 400);

    // กันคนเดียวลงทะเบียนหลายรหัส — ค้นทั้งระบบในฐานข้อมูลผ่าน index (pgvector HNSW)
    const [best] = await matchGlobal(supabase, emb, 1);
    if (best && best.similarity >= DUPLICATE_THRESHOLD) {
      return fail('DUPLICATE_FACE', 'ใบหน้านี้ลงทะเบียนไว้กับรหัสนักศึกษาอื่นแล้ว', 409, { match_score: Number(best.similarity.toFixed(3)) });
    }

    const { error } = await supabase.from('face_templates').insert({
      student_id: student.student_id,
      embedding: toVector(emb),
      model_version: String(body.model_version ?? 'unknown').slice(0, 64),
      device_info: body.device_info ? String(body.device_info).slice(0, 255) : null,
    });
    if (error) throw error;

    return json({ data: { student_code: student.student_code, full_name: student.full_name, enrolled: true } }, 201);
  } catch (err) {
    console.error(err);
    return fail('INTERNAL_ERROR', String(err), 500);
  }
});
