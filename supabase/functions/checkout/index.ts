// POST /functions/v1/checkout
// สแกนออกตอนจบคาบ (แทนช่อง "ออก" ในใบเซ็นชื่อ) + บันทึกหมายเหตุ
//
// body:
//   { schedule_ids: [...], embedding, latitude, longitude }       → สแกนออก (ต้องเช็คชื่อเข้าแล้ว)
//   { action: 'note', attendance_id, note }                       → เพิ่ม/แก้หมายเหตุของตัวเอง
//        (attendance_id เป็น uuid ที่เครื่องได้รับตอนเช็คชื่อสำเร็จเท่านั้น, แก้ได้ภายใน 2 ชม.)

import { CORS, bkkAt, fail, json, serviceClient } from '../_shared/http.ts';
import { MATCH_THRESHOLD, matchAmong, validEmbedding } from '../_shared/face.ts';
import { haversineMeters } from '../_shared/geo.ts';

const supabase = serviceClient();
const CHECKOUT_GRACE_MIN = 30;   // สแกนออกได้ถึงหลังจบคาบกี่นาที
const EARLY_LEAVE_MIN = 10;      // ออกก่อนจบคาบเกินกี่นาที = ออกก่อนเวลา
const NOTE_EDIT_WINDOW_MIN = 120;
const bkk = bkkAt;

async function saveNote(attendanceId: string, note: string) {
  const text = note.trim().slice(0, 300);
  const { data: rec } = await supabase
    .from('attendance_records').select('attendance_id, check_in_time, check_out_time').eq('attendance_id', attendanceId).maybeSingle();
  if (!rec) return fail('NOT_FOUND', 'ไม่พบรายการเช็คชื่อ', 404);
  const last = new Date(rec.check_out_time ?? rec.check_in_time).getTime();
  if (Date.now() - last > NOTE_EDIT_WINDOW_MIN * 60000) return fail('NOTE_LOCKED', 'เลยเวลาแก้หมายเหตุแล้ว ติดต่อเจ้าหน้าที่', 409);
  const { error } = await supabase.from('attendance_records')
    .update({ note: text || null, note_updated_at: new Date().toISOString() }).eq('attendance_id', attendanceId);
  if (error) throw error;
  return json({ data: { attendance_id: attendanceId, note: text || null } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);

  let body: { action?: string; attendance_id?: string; note?: string; schedule_id?: string; schedule_ids?: string[]; embedding?: number[]; latitude?: number; longitude?: number; device_id?: string };
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }

  try {
    if (body.action === 'note') {
      if (!body.attendance_id || !/^[0-9a-f-]{36}$/i.test(body.attendance_id)) return fail('BAD_REQUEST', 'attendance_id ไม่ถูกต้อง', 400);
      return await saveNote(body.attendance_id, String(body.note ?? ''));
    }

    // รับได้หลายคาบ (คาบที่เปิดสแกนออกอยู่ในพื้นที่นี้) — ระบบหาเองว่าคนนี้เช็คชื่อเข้าคาบไหน
    const { embedding, latitude, longitude } = body;
    const ids = [...new Set([...(body.schedule_ids ?? []), ...(body.schedule_id ? [body.schedule_id] : [])])].slice(0, 10);
    if (ids.length === 0 || !validEmbedding(embedding) || latitude == null || longitude == null) {
      return fail('BAD_REQUEST', 'ข้อมูลไม่ครบ (ต้องการ schedule_ids, embedding, latitude, longitude)', 400);
    }

    // 1) คาบที่อยู่ในช่วงสแกนออก (เริ่มคาบ → หลังจบคาบ CHECKOUT_GRACE_MIN นาที) และตำแหน่งอยู่ในรัศมีห้อง
    const { data: schedules } = await supabase
      .from('schedules')
      .select(`schedule_id, class_date, start_time, end_time, locations ( latitude, longitude, radius_meters, name )`)
      .in('schedule_id', ids);
    const now = new Date();
    type Loc = { latitude: number; longitude: number; radius_meters: number; name: string };
    const valid = (schedules ?? []).map((s) => {
      const loc = s.locations as unknown as Loc;
      const start = bkk(s.class_date, s.start_time), end = bkk(s.class_date, s.end_time);
      const distance = haversineMeters(latitude, longitude, loc.latitude, loc.longitude);
      return { s, loc, start, end, distance };
    });
    const inTime = valid.filter((v) => now >= v.start && now.getTime() <= v.end.getTime() + CHECKOUT_GRACE_MIN * 60000);
    if (inTime.length === 0) return fail('SESSION_NOT_ACTIVE', 'ไม่อยู่ในช่วงเวลาสแกนออกของคาบนี้', 409);
    const inZone = inTime.filter((v) => v.distance <= v.loc.radius_meters);
    if (inZone.length === 0) {
      const n = inTime.sort((a, b) => a.distance - b.distance)[0];
      return fail('OUT_OF_ZONE', 'อยู่นอกพื้นที่ที่กำหนด', 422, { distance_meters: Number(n.distance.toFixed(1)), allowed_radius_meters: n.loc.radius_meters });
    }

    // 2) ใบหน้า — เทียบเฉพาะคนที่เช็คชื่อเข้าคาบเหล่านี้แล้ว
    const { data: checkedIn } = await supabase
      .from('attendance_records').select('attendance_id, student_id, schedule_id, check_out_time')
      .in('schedule_id', inZone.map((v) => v.s.schedule_id))
      .in('status', ['present', 'late']); // คนที่ถูกบันทึกขาด/ลา สแกนออกไม่ได้
    if (!checkedIn || checkedIn.length === 0) return fail('NOT_CHECKED_IN', 'ยังไม่มีใครเช็คชื่อเข้าคาบนี้', 409);
    const best = await matchAmong(supabase, embedding, [...new Set<string>(checkedIn.map((r) => String(r.student_id)))]);
    const bestStudentId = best?.student_id ?? null, bestSim = best?.similarity ?? -1;
    if (!bestStudentId || bestSim < MATCH_THRESHOLD) {
      return fail('NOT_CHECKED_IN', 'ไม่พบใบหน้านี้ในรายชื่อที่เช็คชื่อเข้าคาบนี้ — เช็คชื่อเข้าแล้วหรือยัง?', 422, { match_score: Number(Math.max(0, bestSim).toFixed(3)) });
    }

    // ถ้าคนนี้อยู่หลายคาบ (เช่น คาบติดกัน) เลือกคาบที่ยังไม่สแกนออกและจบเร็วที่สุด
    const mine = checkedIn.filter((r) => r.student_id === bestStudentId)
      .map((r) => ({ r, v: inZone.find((v) => v.s.schedule_id === r.schedule_id)! }))
      .sort((a, b) => Number(!!a.r.check_out_time) - Number(!!b.r.check_out_time) || a.v.end.getTime() - b.v.end.getTime());
    const rec = mine[0].r, loc = mine[0].v.loc, end = mine[0].v.end, distance = mine[0].v.distance;

    const { data: person } = await supabase.from('students').select('student_code, users ( full_name )').eq('student_id', bestStudentId).single();
    const who = {
      student_code: person?.student_code ?? null,
      full_name: (person?.users as unknown as { full_name: string } | null)?.full_name ?? null,
    };
    if (rec.check_out_time) return fail('ALREADY_CHECKED_OUT', 'สแกนออกคาบนี้ไปแล้ว', 409, { ...who, check_out_time: rec.check_out_time });

    const leftEarly = now.getTime() < end.getTime() - EARLY_LEAVE_MIN * 60000;
    const { data: updated, error } = await supabase.from('attendance_records')
      .update({
        check_out_time: now.toISOString(), check_out_lat: latitude, check_out_lng: longitude,
        check_out_distance: distance, check_out_face_score: bestSim, left_early: leftEarly,
      })
      .eq('attendance_id', rec.attendance_id).is('check_out_time', null)
      .select('attendance_id, check_in_time, check_out_time, status, note').single();
    if (error || !updated) return fail('ALREADY_CHECKED_OUT', 'สแกนออกคาบนี้ไปแล้ว', 409, who);

    return json({
      data: {
        ...updated, ...who, room: loc.name, left_early: leftEarly,
        minutes_before_end: leftEarly ? Math.round((end.getTime() - now.getTime()) / 60000) : 0,
        face_match_score: Number(bestSim.toFixed(3)), distance_meters: Number(distance.toFixed(1)),
      },
    });
  } catch (err) {
    console.error(err);
    return fail('INTERNAL_ERROR', String(err), 500);
  }
});
