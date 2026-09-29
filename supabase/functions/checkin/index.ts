// supabase/functions/checkin/index.ts
//
// Deploy: supabase functions deploy checkin
// เรียกใช้: POST https://<project>.supabase.co/functions/v1/checkin
//
// ตรงกับ POST /checkin ใน api-spec.md (หัวข้อ 2) — รวม step ตรวจตำแหน่ง GPS
// + จับคู่ใบหน้าแบบ 1-to-N (เฉพาะนักศึกษาที่ลงทะเบียนใน section นั้น ไม่ query ทั้งมหาวิทยาลัย)
// + บันทึกผลในคำเรียกเดียว ใช้ Service Role Key ฝั่งเซิร์ฟเวอร์เท่านั้น
// (ไม่มีการล็อกอินของนักศึกษา ณ จุดนี้ ตามหลักการที่ตัดสินใจไว้ — ดู 4.1 ของเอกสารออกแบบ)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

// Supabase กำลังเปลี่ยนจาก SUPABASE_SERVICE_ROLE_KEY (เดิม) ไปเป็น SUPABASE_SECRET_KEYS
// (JSON dictionary ใหม่) — ของเดิมยังใช้ได้แต่จะเลิกรองรับปลายปี 2026 โค้ดนี้รองรับทั้งคู่
function getServiceRoleKey(): string {
  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw);
      if (parsed?.default) return parsed.default;
    } catch { /* fallthrough ไปใช้ของเดิม */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}
const serviceRoleKey = getServiceRoleKey();

// ค่าเริ่มต้น ยังไม่ผ่านการปรับจูนจริงกับ Human library — ดูหมายเหตุใน real-checkin-prototype.html
const MATCH_THRESHOLD = 0.6;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return json({ data: null, error: { code: 'METHOD_NOT_ALLOWED', message: 'ใช้ POST เท่านั้น' } }, 405);
  }

  let body: { schedule_id?: string; embedding?: number[]; latitude?: number; longitude?: number; device_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ data: null, error: { code: 'BAD_REQUEST', message: 'JSON body ไม่ถูกต้อง' } }, 400);
  }

  const { schedule_id, embedding, latitude, longitude, device_id } = body;
  if (!schedule_id || !embedding || latitude == null || longitude == null) {
    return json({ data: null, error: { code: 'BAD_REQUEST', message: 'ข้อมูลไม่ครบ (ต้องการ schedule_id, embedding, latitude, longitude)' } }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  // ใช้ schema เริ่มต้น (public) — โปรเจกต์ "cph-smart-checkin" แยกเฉพาะระบบนี้แล้ว
  // ไม่ต้องแยก schema แบบตอนที่ยังใช้ร่วมกับโปรเจกต์ "rov-system" เดิม

  try {
    // 1) ดึงคาบเรียน + ห้อง + เกณฑ์สายของ section
    const { data: schedule, error: schedErr } = await supabase
      .from('schedules')
      .select(`
        schedule_id, class_date, start_time, end_time, section_id, location_id,
        locations ( latitude, longitude, radius_meters, name ),
        lab_sections ( late_threshold_minutes )
      `)
      .eq('schedule_id', schedule_id)
      .single();

    if (schedErr || !schedule) {
      return json({ data: null, error: { code: 'SCHEDULE_NOT_FOUND', message: 'ไม่พบคาบเรียนนี้' } }, 404);
    }

    const loc = schedule.locations as unknown as { latitude: number; longitude: number; radius_meters: number; name: string };
    const section = schedule.lab_sections as unknown as { late_threshold_minutes: number };

    // 2) ตรวจตำแหน่ง GPS — ปฏิเสธก่อนแตะข้อมูลใบหน้าใดๆ เลย
    const distance = haversineMeters(latitude, longitude, loc.latitude, loc.longitude);
    if (distance > loc.radius_meters) {
      return json({
        data: null,
        error: { code: 'OUT_OF_ZONE', message: 'อยู่นอกพื้นที่ที่กำหนด', distance_meters: distance, allowed_radius_meters: loc.radius_meters },
      }, 422);
    }

    // 3) ดึง face_templates เฉพาะนักศึกษาที่ลงทะเบียนใน section นี้เท่านั้น (1-to-N แบบจำกัดขอบเขต)
    const { data: enrollments } = await supabase
      .from('section_enrollments')
      .select('student_id')
      .eq('section_id', schedule.section_id);

    const studentIds = (enrollments ?? []).map((e) => e.student_id);
    if (studentIds.length === 0) {
      return json({ data: null, error: { code: 'NO_ENROLLED_STUDENTS', message: 'กลุ่มเรียนนี้ยังไม่มีนักศึกษาลงทะเบียน' } }, 404);
    }

    const { data: templates } = await supabase
      .from('face_templates')
      .select('student_id, embedding_vector')
      .in('student_id', studentIds);

    // 4) หาคนที่ตรงที่สุด
    let bestStudentId: string | null = null;
    let bestSim = -1;
    for (const t of templates ?? []) {
      const stored: number[] = JSON.parse(t.embedding_vector);
      const sim = cosineSimilarity(stored, embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestStudentId = t.student_id;
      }
    }

    if (!bestStudentId || bestSim < MATCH_THRESHOLD) {
      return json({
        data: null,
        error: { code: 'FACE_MISMATCH', message: 'ไม่พบคนที่ตรงกับใบหน้านี้ในกลุ่มเรียน', match_score: Math.max(0, bestSim) },
      }, 422);
    }

    // 5) คำนวณสถานะ ปกติ/สาย จากเวลาจริง
    const now = new Date();
    const startDateTime = new Date(`${schedule.class_date}T${schedule.start_time}`);
    const minutesSinceStart = (now.getTime() - startDateTime.getTime()) / 60000;
    const status = minutesSinceStart > (section?.late_threshold_minutes ?? 15) ? 'late' : 'present';

    // 6) บันทึกผล — unique(student_id, schedule_id) กันเช็คซ้ำคาบเดียวกันในตัว
    const { data: record, error: insertErr } = await supabase
      .from('attendance_records')
      .insert({
        student_id: bestStudentId,
        schedule_id,
        check_in_lat: latitude,
        check_in_lng: longitude,
        distance_from_location: distance,
        face_match_score: bestSim,
        status,
        device_id: device_id ?? null,
      })
      .select('attendance_id, check_in_time')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        return json({ data: null, error: { code: 'ALREADY_CHECKED_IN', message: 'เช็คชื่อคาบนี้ไปแล้ว' } }, 409);
      }
      throw insertErr;
    }

    return json({
      data: {
        attendance_id: record.attendance_id,
        status,
        check_in_time: record.check_in_time,
        face_match_score: Number(bestSim.toFixed(3)),
        distance_meters: Number(distance.toFixed(1)),
      },
    }, 201);
  } catch (err) {
    console.error(err);
    return json({ data: null, error: { code: 'INTERNAL_ERROR', message: String(err) } }, 500);
  }
});
