// POST /functions/v1/dev-tools   ⚠️ ใช้เฉพาะช่วงทดสอบ — ลบ function นี้ + ตาราง dev_settings ก่อนใช้งานจริง
// ต้องส่ง dev_code ที่ตรงกับ dev_settings.key = 'dev_code' ทุกครั้ง
//
// actions:
//   set_test_room      { latitude, longitude, radius_meters? }  ย้ายห้องทดสอบ (building = 'TEST') มาที่พิกัดนี้
//   reset_enrollment   { student_code }                         ลบใบหน้าที่ลงทะเบียนไว้ เพื่อลงทะเบียนใหม่
//   roster             {}                                       รายชื่อนักศึกษาทดสอบ + ลงทะเบียนใบหน้าแล้วหรือยัง
//   recent_attendance  {}                                       ประวัติเช็คชื่อล่าสุด 30 รายการ

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function getServiceRoleKey(): string {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try { const p = JSON.parse(raw); if (p?.default) return p.default; } catch { /* ใช้ของเดิม */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, getServiceRoleKey());

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const fail = (code: string, message: string, status: number) => json({ data: null, error: { code, message } }, status);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }

  const { data: setting } = await supabase.from('dev_settings').select('value').eq('key', 'dev_code').maybeSingle();
  if (!setting || String(body.dev_code ?? '') !== setting.value) {
    await new Promise((r) => setTimeout(r, 1500)); // ชะลอการเดารหัส
    return fail('FORBIDDEN', 'รหัสเครื่องมือทดสอบไม่ถูกต้อง', 403);
  }

  try {
    switch (body.action) {
      case 'set_test_room': {
        const lat = Number(body.latitude), lng = Number(body.longitude);
        const radius = Math.min(500, Math.max(10, Number(body.radius_meters ?? 50)));
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          return fail('BAD_REQUEST', 'พิกัดไม่ถูกต้อง', 400);
        }
        const { data, error } = await supabase
          .from('locations')
          .update({ latitude: lat, longitude: lng, radius_meters: radius })
          .eq('building', 'TEST')
          .select('name, latitude, longitude, radius_meters');
        if (error) throw error;
        return json({ data: { updated: data } });
      }

      case 'reset_enrollment': {
        const code = String(body.student_code ?? '').trim();
        const { data: st } = await supabase.from('students').select('student_id').eq('student_code', code).maybeSingle();
        if (!st) return fail('STUDENT_NOT_FOUND', 'ไม่พบรหัสนักศึกษานี้', 404);
        const { count, error } = await supabase.from('face_templates').delete({ count: 'exact' }).eq('student_id', st.student_id);
        if (error) throw error;
        return json({ data: { student_code: code, removed_templates: count ?? 0 } });
      }

      case 'roster': {
        const { data, error } = await supabase
          .from('section_enrollments')
          .select(`students ( student_code, users ( full_name ), face_templates ( template_id ) ),
                   lab_sections ( section_no, courses ( course_code ) )`);
        if (error) throw error;
        const rows = (data ?? []).map((e: Record<string, any>) => ({
          student_code: e.students?.student_code,
          full_name: e.students?.users?.full_name,
          course: `${e.lab_sections?.courses?.course_code} กลุ่ม ${e.lab_sections?.section_no}`,
          enrolled: (e.students?.face_templates ?? []).length > 0,
        })).sort((a, b) => String(a.student_code).localeCompare(String(b.student_code)));
        return json({ data: { students: rows } });
      }

      case 'recent_attendance': {
        const { data, error } = await supabase
          .from('attendance_records')
          .select(`check_in_time, check_out_time, left_early, note, status, face_match_score, distance_from_location,
                   students ( student_code, users ( full_name ) ),
                   schedules ( class_date, start_time, locations ( name ), lab_sections ( courses ( course_code ) ) )`)
          .order('check_in_time', { ascending: false })
          .limit(30);
        if (error) throw error;
        const rows = (data ?? []).map((r: Record<string, any>) => ({
          check_in_time: r.check_in_time,
          check_out_time: r.check_out_time,
          left_early: r.left_early,
          note: r.note,
          status: r.status,
          student_code: r.students?.student_code,
          full_name: r.students?.users?.full_name,
          course: r.schedules?.lab_sections?.courses?.course_code,
          room: r.schedules?.locations?.name,
          session: `${r.schedules?.class_date} ${String(r.schedules?.start_time ?? '').slice(0, 5)}`,
          face_match_score: r.face_match_score == null ? null : Number(Number(r.face_match_score).toFixed(3)),
          distance_meters: r.distance_from_location == null ? null : Number(Number(r.distance_from_location).toFixed(1)),
        }));
        return json({ data: { records: rows } });
      }

      default:
        return fail('BAD_REQUEST', 'action ไม่รู้จัก', 400);
    }
  } catch (err) {
    console.error(err);
    return fail('INTERNAL_ERROR', String(err), 500);
  }
});
