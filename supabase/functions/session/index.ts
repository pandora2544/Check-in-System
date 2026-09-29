// POST /functions/v1/session
// หาคาบเรียนที่ "กำลังเรียนอยู่ตอนนี้" จากตำแหน่งของผู้ใช้ (ไม่ต้องล็อกอิน)
// ลำดับการตัดสิน (ดู Context.md หัวข้อห้องใกล้กัน):
//   1) ถ้ามี location_id (สแกน QR หน้าห้อง) → ใช้ห้องนั้นเลย
//   2) ถ้าไม่มี → เอาคาบที่กำลังเรียนและตำแหน่งอยู่ในรัศมี ถ้ามีคาบเดียว = resolved: single
//   3) ถ้ามีหลายคาบในรัศมี → resolved: ambiguous ให้ผู้ใช้เลือก
// body: { latitude, longitude, location_id? }

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

const EARLY_MINUTES = 15;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const bkk = (date: string, time: string) => new Date(`${date}T${time}+07:00`);
const bkkDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

type Row = {
  schedule_id: string; class_date: string; start_time: string; end_time: string; section_id: string; location_id: string;
  locations: { name: string; latitude: number; longitude: number; radius_meters: number };
  lab_sections: { section_no: string; late_threshold_minutes: number; courses: { course_code: string; course_name: string } };
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ data: null, error: { code: 'METHOD_NOT_ALLOWED', message: 'ใช้ POST เท่านั้น' } }, 405);

  let body: { latitude?: number; longitude?: number; location_id?: string };
  try { body = await req.json(); } catch { return json({ data: null, error: { code: 'BAD_REQUEST', message: 'JSON body ไม่ถูกต้อง' } }, 400); }
  const { latitude, longitude, location_id } = body;
  if (latitude == null || longitude == null) {
    return json({ data: null, error: { code: 'BAD_REQUEST', message: 'ต้องส่ง latitude, longitude' } }, 400);
  }

  const now = new Date();
  const today = bkkDate(now);

  let q = supabase
    .from('schedules')
    .select(`schedule_id, class_date, start_time, end_time, section_id, location_id,
             locations ( name, latitude, longitude, radius_meters ),
             lab_sections ( section_no, late_threshold_minutes, courses ( course_code, course_name ) )`)
    .eq('class_date', today)
    .eq('status', 'scheduled');
  if (location_id) q = q.eq('location_id', location_id);
  const { data, error } = await q;
  if (error) return json({ data: null, error: { code: 'INTERNAL_ERROR', message: error.message } }, 500);

  const t = now.getTime();
  const active = ((data ?? []) as unknown as Row[])
    .map((r) => {
      const start = bkk(r.class_date, r.start_time).getTime();
      const end = bkk(r.class_date, r.end_time).getTime();
      return { r, start, end, running: t >= start && t <= end, open: t >= start - EARLY_MINUTES * 60000 && t <= end };
    })
    .filter((x) => x.open);

  // คาบต่อเนื่องของกลุ่มเดียวกันในห้องเดียวกัน (เช่น ช่วง 15 นาทีก่อนคาบถัดไป) — เลือกคาบที่กำลังเรียนอยู่ก่อน
  const byKey = new Map<string, typeof active[number]>();
  for (const x of active) {
    const key = `${x.r.section_id}|${x.r.location_id}`;
    const cur = byKey.get(key);
    if (!cur || (x.running && !cur.running) || (x.running === cur.running && x.start < cur.start)) byKey.set(key, x);
  }

  const sessions = [...byKey.values()].map(({ r }) => {
    const distance = haversineMeters(latitude, longitude, r.locations.latitude, r.locations.longitude);
    return {
      schedule_id: r.schedule_id,
      location_id: r.location_id,
      room: r.locations.name,
      course_code: r.lab_sections.courses.course_code,
      course_name: r.lab_sections.courses.course_name,
      section_no: r.lab_sections.section_no,
      class_date: r.class_date,
      start_time: r.start_time.slice(0, 5),
      end_time: r.end_time.slice(0, 5),
      late_threshold_minutes: r.lab_sections.late_threshold_minutes,
      distance_meters: Number(distance.toFixed(1)),
      radius_meters: r.locations.radius_meters,
      latitude: r.locations.latitude,
      longitude: r.locations.longitude,
      in_zone: distance <= r.locations.radius_meters,
    };
  }).sort((a, b) => a.distance_meters - b.distance_meters);

  const inZone = sessions.filter((s) => s.in_zone);
  const resolved = inZone.length === 0 ? 'none' : inZone.length === 1 ? 'single' : 'ambiguous';

  return json({
    data: {
      resolved,
      sessions: inZone,
      // ทุกห้องที่มีคาบเปิดเช็คชื่ออยู่ตอนนี้ (ใกล้สุดก่อน) — ใช้วาดแผนที่พื้นที่เช็คชื่อบนหน้าเว็บ
      active: sessions.slice(0, 20),
      // ไว้ช่วยบอกผู้ใช้ว่าห้องที่มีคาบอยู่ใกล้สุดห่างเท่าไหร่ (กรณีอยู่นอกรัศมี)
      nearest_out_of_zone: inZone.length === 0 ? sessions[0] ?? null : null,
      server_time_bkk: new Date(t + 7 * 3600_000).toISOString().slice(0, 16).replace('T', ' '),
    },
  });
});
