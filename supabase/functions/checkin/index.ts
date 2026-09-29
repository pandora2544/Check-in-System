// POST /functions/v1/checkin
// ตรวจ GPS → จับคู่ใบหน้าแบบ 1-to-N (เฉพาะนักศึกษาใน section ของคาบนั้น) → บันทึกผล
// นักศึกษาไม่ล็อกอิน (verify_jwt: false) — ใช้ service role ฝั่งเซิร์ฟเวอร์เท่านั้น
// เวลาใน schedules เก็บเป็นเวลาท้องถิ่นไทย (Asia/Bangkok, UTC+7)

import { CORS, bkkAt, fail, json, serviceClient } from '../_shared/http.ts';
import { MATCH_THRESHOLD, matchAmong, validEmbedding } from '../_shared/face.ts';
import { haversineMeters } from '../_shared/geo.ts';

const supabase = serviceClient();
const EARLY_MINUTES = 15; // เปิดให้เช็คชื่อก่อนคาบเริ่มได้กี่นาที
const bkk = bkkAt;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);

  let body: { schedule_id?: string; embedding?: number[]; latitude?: number; longitude?: number; device_id?: string };
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }

  const { schedule_id, embedding, latitude, longitude, device_id } = body;
  if (!schedule_id || !validEmbedding(embedding) || latitude == null || longitude == null) {
    return fail('BAD_REQUEST', 'ข้อมูลไม่ครบ (ต้องการ schedule_id, embedding, latitude, longitude)', 400);
  }

  try {
    // 1) คาบเรียน + ห้อง + เกณฑ์สาย
    const { data: schedule, error: schedErr } = await supabase
      .from('schedules')
      .select(`schedule_id, class_date, start_time, end_time, status, section_id,
               locations ( latitude, longitude, radius_meters, name ),
               lab_sections ( late_threshold_minutes )`)
      .eq('schedule_id', schedule_id)
      .single();
    if (schedErr || !schedule) return fail('SCHEDULE_NOT_FOUND', 'ไม่พบคาบเรียนนี้', 404);
    if (schedule.status !== 'scheduled') return fail('SESSION_CANCELLED', 'คาบนี้ถูกยกเลิก', 409);

    // 2) ต้องอยู่ในช่วงเวลาคาบ (เปิดก่อนเริ่ม EARLY_MINUTES นาที ถึงเวลาจบ)
    const now = new Date();
    const start = bkk(schedule.class_date, schedule.start_time);
    const end = bkk(schedule.class_date, schedule.end_time);
    if (now.getTime() < start.getTime() - EARLY_MINUTES * 60000 || now.getTime() > end.getTime()) {
      return fail('SESSION_NOT_ACTIVE', 'ไม่อยู่ในช่วงเวลาของคาบนี้', 409);
    }

    const loc = schedule.locations as unknown as { latitude: number; longitude: number; radius_meters: number; name: string };
    const section = schedule.lab_sections as unknown as { late_threshold_minutes: number };

    // 3) ตำแหน่ง — ปฏิเสธก่อนแตะข้อมูลใบหน้า
    const distance = haversineMeters(latitude, longitude, loc.latitude, loc.longitude);
    if (distance > loc.radius_meters) {
      return fail('OUT_OF_ZONE', 'อยู่นอกพื้นที่ที่กำหนด', 422,
        { distance_meters: Number(distance.toFixed(1)), allowed_radius_meters: loc.radius_meters });
    }

    // 4) ใบหน้า — เทียบเฉพาะนักศึกษาที่ลงทะเบียนใน section นี้
    const { data: enrollments } = await supabase.from('section_enrollments').select('student_id').eq('section_id', schedule.section_id);
    const studentIds = (enrollments ?? []).map((e) => e.student_id);
    if (studentIds.length === 0) return fail('NO_ENROLLED_STUDENTS', 'กลุ่มเรียนนี้ยังไม่มีนักศึกษา', 404);

    // เทียบในฐานข้อมูล (pgvector) — ไม่ต้องดึง embedding ของทั้งกลุ่มมาที่ function
    const best = await matchAmong(supabase, embedding, studentIds);
    if (!best) return fail('NO_FACE_TEMPLATES', 'ยังไม่มีนักศึกษาในกลุ่มนี้ลงทะเบียนใบหน้า', 404);
    const bestStudentId = best.student_id, bestSim = best.similarity;
    if (bestSim < MATCH_THRESHOLD) {
      return fail('FACE_MISMATCH', 'ไม่พบใบหน้านี้ในรายชื่อของกลุ่มเรียน', 422, { match_score: Number(Math.max(0, bestSim).toFixed(3)) });
    }

    // 5) ปกติ / สาย
    const minutesSinceStart = (now.getTime() - start.getTime()) / 60000;
    const status = minutesSinceStart > (section?.late_threshold_minutes ?? 15) ? 'late' : 'present';

    // 6) บันทึก — unique(student_id, schedule_id) กันเช็คซ้ำ
    const { data: person } = await supabase
      .from('students').select('student_code, users ( full_name )').eq('student_id', bestStudentId).single();
    const who = {
      student_code: person?.student_code ?? null,
      full_name: (person?.users as unknown as { full_name: string } | null)?.full_name ?? null,
    };

    const { data: record, error: insertErr } = await supabase
      .from('attendance_records')
      .insert({
        student_id: bestStudentId, schedule_id,
        check_in_lat: latitude, check_in_lng: longitude,
        distance_from_location: distance, face_match_score: bestSim,
        status, device_id: device_id ?? null,
      })
      .select('attendance_id, check_in_time')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') return fail('ALREADY_CHECKED_IN', 'เช็คชื่อคาบนี้ไปแล้ว', 409, who);
      throw insertErr;
    }

    return json({
      data: {
        attendance_id: record.attendance_id, status, check_in_time: record.check_in_time,
        ...who, room: loc.name,
        face_match_score: Number(bestSim.toFixed(3)), distance_meters: Number(distance.toFixed(1)),
      },
    }, 201);
  } catch (err) {
    console.error(err);
    return fail('INTERNAL_ERROR', String(err), 500);
  }
});
