// POST /functions/v1/staff   — API สำหรับหน้าอาจารย์/แอดมิน (ต้องล็อกอิน)
// ตรวจ token ในโค้ดเอง (auth.getUser) เพราะโปรเจกต์ใช้ JWT signing key แบบใหม่ — deploy ด้วย verify_jwt: false
// สิทธิ์: admin เห็นทุกกลุ่มเรียน, instructor เห็นเฉพาะกลุ่มที่ตัวเองสอน
//
// actions:
//   me                                   ข้อมูลผู้ใช้ + กลุ่มเรียนที่ดูได้
//   sessions   { date? }                 คาบของวันนั้น (ค่าเริ่มต้น = วันนี้ เวลาไทย) + ยอดมา/สาย/ขาด/ลา/ออก
//   session    { schedule_id }           รายชื่อทั้งกลุ่ม + สถานะเช็คชื่อรายคน
//   mark       { schedule_id, student_id, status, note? }   เช็คชื่อแทน/แก้สถานะ (present|late|absent|excused)
//   note       { attendance_id, note }   แก้หมายเหตุ
//   notify_get { section_id }            การตั้งค่าแจ้งเตือน (auto_absent + กลุ่ม Telegram)
//   notify_set { section_id, auto_absent?, chat_id?, is_active?, notify_mid?, notify_end?, title?, remove? }
//              อาจารย์: เปิด/ปิดได้เฉพาะกลุ่มของตัวเอง · เพิ่ม/ลบ chat_id ได้เฉพาะแอดมิน
//   notify_send_now { schedule_id }      ส่งสรุปสถานะ ณ ตอนนี้เข้ากลุ่ม Telegram ที่เปิดอยู่
//   tg_chats                             (แอดมิน) กลุ่ม Telegram ที่บอทเพิ่งได้รับข้อความ — ใช้หา chat_id

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildSummary, hasTelegram, scrub, tg, tgSend } from '../_shared/notify-core.ts';

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

const STATUSES = ['present', 'late', 'absent', 'excused'];
const bkkDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const fail = (code: string, message: string, status: number) => json({ data: null, error: { code, message } }, status);

type Staff = { user_id: string; full_name: string; role: string; email: string | null };

async function authStaff(req: Request): Promise<Staff | Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ', 401);
  const { data: auth, error } = await supabase.auth.getUser(token);
  if (error || !auth?.user) return fail('UNAUTHORIZED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  const { data: me } = await supabase.from('users').select('user_id, full_name, role, email').eq('user_id', auth.user.id).maybeSingle();
  if (!me || !['instructor', 'admin'].includes(me.role)) return fail('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์เข้าหน้าอาจารย์/แอดมิน', 403);
  return me as Staff;
}

async function allowedSections(me: Staff) {
  let q = supabase.from('lab_sections').select('section_id, section_no, instructor_id, courses ( course_code, course_name ), semesters ( academic_year, term )');
  if (me.role !== 'admin') q = q.eq('instructor_id', me.user_id);
  const { data } = await q;
  return (data ?? []).map((s: Record<string, any>) => ({
    section_id: s.section_id, section_no: s.section_no,
    course_code: s.courses?.course_code, course_name: s.courses?.course_name,
    term: s.semesters ? `${s.semesters.term}/${s.semesters.academic_year}` : null,
  }));
}

async function canAccessSection(me: Staff, sectionId: string) {
  const { data } = await supabase.from('lab_sections').select('section_id, instructor_id, auto_absent').eq('section_id', sectionId).maybeSingle();
  if (!data || (me.role !== 'admin' && data.instructor_id !== me.user_id)) return null;
  return data;
}

async function notifySettings(sectionId: string) {
  const [{ data: sec }, { data: ch }] = await Promise.all([
    supabase.from('lab_sections').select('auto_absent').eq('section_id', sectionId).single(),
    supabase.from('telegram_channels').select('chat_id, title, is_active, notify_mid, notify_end, updated_at').eq('section_id', sectionId).order('created_at'),
  ]);
  return { section_id: sectionId, auto_absent: !!sec?.auto_absent, telegram_ready: hasTelegram(), channels: ch ?? [] };
}

async function canAccessSchedule(me: Staff, scheduleId: string) {
  const { data: sc } = await supabase.from('schedules')
    .select('schedule_id, section_id, class_date, start_time, end_time, status, locations ( name ), lab_sections ( section_no, instructor_id, late_threshold_minutes, courses ( course_code, course_name ) )')
    .eq('schedule_id', scheduleId).maybeSingle();
  if (!sc) return null;
  const sec = sc.lab_sections as unknown as { instructor_id: string };
  if (me.role !== 'admin' && sec?.instructor_id !== me.user_id) return null;
  return sc as Record<string, any>;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);

  const me = await authStaff(req);
  if (me instanceof Response) return me;

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }

  try {
    switch (body.action) {
      case 'me':
        return json({ data: { user: me, sections: await allowedSections(me) } });

      case 'sessions': {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? '')) ? String(body.date) : bkkDate(new Date());
        const sections = await allowedSections(me);
        if (sections.length === 0) return json({ data: { date, sessions: [] } });
        const secIds = sections.map((s) => s.section_id);
        const { data: sch } = await supabase.from('schedules')
          .select('schedule_id, section_id, class_date, start_time, end_time, status, locations ( name )')
          .eq('class_date', date).in('section_id', secIds).order('start_time');
        const ids = (sch ?? []).map((s) => s.schedule_id);
        const [{ data: att }, { data: enr }] = await Promise.all([
          ids.length ? supabase.from('attendance_records').select('schedule_id, status, check_out_time').in('schedule_id', ids) : Promise.resolve({ data: [] as any[] }),
          supabase.from('section_enrollments').select('section_id').in('section_id', secIds),
        ]);
        const enrolled = new Map<string, number>();
        for (const e of enr ?? []) enrolled.set(e.section_id, (enrolled.get(e.section_id) ?? 0) + 1);
        const secMap = new Map(sections.map((s) => [s.section_id, s]));
        const sessions = (sch ?? []).map((s: Record<string, any>) => {
          const rows = (att ?? []).filter((a) => a.schedule_id === s.schedule_id);
          const c = (st: string) => rows.filter((a) => a.status === st).length;
          const sec = secMap.get(s.section_id)!;
          return {
            schedule_id: s.schedule_id, class_date: s.class_date, start_time: s.start_time.slice(0, 5), end_time: s.end_time.slice(0, 5),
            status: s.status, room: s.locations?.name, course_code: sec.course_code, course_name: sec.course_name, section_no: sec.section_no,
            total: enrolled.get(s.section_id) ?? 0, present: c('present'), late: c('late'), absent: c('absent'), excused: c('excused'),
            checked_out: rows.filter((a) => a.check_out_time).length,
          };
        });
        return json({ data: { date, sessions } });
      }

      case 'session': {
        const sc = await canAccessSchedule(me, String(body.schedule_id ?? ''));
        if (!sc) return fail('NOT_FOUND', 'ไม่พบคาบนี้ หรือไม่มีสิทธิ์ดู', 404);
        const [{ data: enr }, { data: att }] = await Promise.all([
          supabase.from('section_enrollments').select('student_id, students ( student_code, users ( full_name ), face_templates ( template_id ) )').eq('section_id', sc.section_id),
          supabase.from('attendance_records')
            .select('attendance_id, student_id, status, check_in_time, check_out_time, left_early, note, face_match_score, distance_from_location, is_manual, marked_at, users:marked_by ( full_name )')
            .eq('schedule_id', sc.schedule_id),
        ]);
        const byStudent = new Map((att ?? []).map((a: Record<string, any>) => [a.student_id, a]));
        const roster = (enr ?? []).map((e: Record<string, any>) => {
          const a = byStudent.get(e.student_id) as Record<string, any> | undefined;
          return {
            student_id: e.student_id, student_code: e.students?.student_code, full_name: e.students?.users?.full_name,
            face_enrolled: (e.students?.face_templates ?? []).length > 0,
            attendance: a ? {
              attendance_id: a.attendance_id, status: a.status, check_in_time: a.check_in_time, check_out_time: a.check_out_time,
              left_early: a.left_early, note: a.note, is_manual: a.is_manual, marked_by: a.users?.full_name ?? null, marked_at: a.marked_at,
              face_match_score: a.face_match_score == null ? null : Number(Number(a.face_match_score).toFixed(3)),
              distance_meters: a.distance_from_location == null ? null : Number(Number(a.distance_from_location).toFixed(1)),
            } : null,
          };
        }).sort((x, y) => String(x.student_code).localeCompare(String(y.student_code)));
        const sec = sc.lab_sections;
        return json({ data: {
          schedule: {
            schedule_id: sc.schedule_id, class_date: sc.class_date, start_time: sc.start_time.slice(0, 5), end_time: sc.end_time.slice(0, 5),
            status: sc.status, room: sc.locations?.name, course_code: sec?.courses?.course_code, course_name: sec?.courses?.course_name,
            section_no: sec?.section_no, late_threshold_minutes: sec?.late_threshold_minutes, section_id: sc.section_id,
          },
          roster,
        } });
      }

      case 'mark': {
        const status = String(body.status ?? '');
        if (!STATUSES.includes(status)) return fail('BAD_REQUEST', 'สถานะไม่ถูกต้อง', 400);
        const sc = await canAccessSchedule(me, String(body.schedule_id ?? ''));
        if (!sc) return fail('NOT_FOUND', 'ไม่พบคาบนี้ หรือไม่มีสิทธิ์แก้', 404);
        const studentId = String(body.student_id ?? '');
        const { data: enrolled } = await supabase.from('section_enrollments').select('student_id').eq('section_id', sc.section_id).eq('student_id', studentId).maybeSingle();
        if (!enrolled) return fail('NOT_IN_SECTION', 'นักศึกษาคนนี้ไม่ได้อยู่ในกลุ่มเรียนนี้', 400);
        const now = new Date().toISOString();
        const patch: Record<string, unknown> = { status, is_manual: true, marked_by: me.user_id, marked_at: now };
        if (typeof body.note === 'string') { patch.note = body.note.trim().slice(0, 300) || null; patch.note_updated_at = now; }
        const { data: existing } = await supabase.from('attendance_records').select('attendance_id').eq('schedule_id', sc.schedule_id).eq('student_id', studentId).maybeSingle();
        const q = existing
          ? supabase.from('attendance_records').update(patch).eq('attendance_id', existing.attendance_id)
          : supabase.from('attendance_records').insert({ ...patch, schedule_id: sc.schedule_id, student_id: studentId, check_in_time: now, device_id: 'manual' });
        const { data, error } = await q.select('attendance_id, status').single();
        if (error) throw error;
        return json({ data });
      }

      case 'note': {
        const { data: rec } = await supabase.from('attendance_records').select('attendance_id, schedule_id').eq('attendance_id', String(body.attendance_id ?? '')).maybeSingle();
        if (!rec || !(await canAccessSchedule(me, rec.schedule_id))) return fail('NOT_FOUND', 'ไม่พบรายการ หรือไม่มีสิทธิ์แก้', 404);
        const note = String(body.note ?? '').trim().slice(0, 300) || null;
        const { error } = await supabase.from('attendance_records').update({ note, note_updated_at: new Date().toISOString() }).eq('attendance_id', rec.attendance_id);
        if (error) throw error;
        return json({ data: { attendance_id: rec.attendance_id, note } });
      }

      case 'notify_get': {
        const sec = await canAccessSection(me, String(body.section_id ?? ''));
        if (!sec) return fail('NOT_FOUND', 'ไม่พบกลุ่มเรียน หรือไม่มีสิทธิ์', 404);
        return json({ data: await notifySettings(sec.section_id) });
      }

      case 'notify_set': {
        const sec = await canAccessSection(me, String(body.section_id ?? ''));
        if (!sec) return fail('NOT_FOUND', 'ไม่พบกลุ่มเรียน หรือไม่มีสิทธิ์', 404);
        if (typeof body.auto_absent === 'boolean') {
          const { error } = await supabase.from('lab_sections').update({ auto_absent: body.auto_absent }).eq('section_id', sec.section_id);
          if (error) throw error;
        }
        const chatId = String(body.chat_id ?? '').trim();
        if (chatId) {
          if (!/^-?\d{3,20}$/.test(chatId)) return fail('BAD_REQUEST', 'chat_id ต้องเป็นตัวเลข เช่น -5369869395', 400);
          const { data: existing } = await supabase.from('telegram_channels').select('channel_id').eq('section_id', sec.section_id).eq('chat_id', chatId).maybeSingle();
          if (body.remove === true) {
            if (me.role !== 'admin') return fail('FORBIDDEN', 'เฉพาะแอดมินที่ลบกลุ่ม Telegram ได้', 403);
            if (existing) await supabase.from('telegram_channels').delete().eq('channel_id', existing.channel_id);
          } else {
            const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
            for (const k of ['is_active', 'notify_mid', 'notify_end']) if (typeof body[k] === 'boolean') patch[k] = body[k];
            if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 100) || null;
            if (existing) {
              const { error } = await supabase.from('telegram_channels').update(patch).eq('channel_id', existing.channel_id);
              if (error) throw error;
            } else {
              if (me.role !== 'admin') return fail('FORBIDDEN', 'เฉพาะแอดมินที่เพิ่มกลุ่ม Telegram ได้', 403);
              const { error } = await supabase.from('telegram_channels').insert({ ...patch, section_id: sec.section_id, chat_id: chatId });
              if (error) throw error;
            }
          }
        }
        return json({ data: await notifySettings(sec.section_id) });
      }

      case 'notify_send_now': {
        const sc = await canAccessSchedule(me, String(body.schedule_id ?? ''));
        if (!sc) return fail('NOT_FOUND', 'ไม่พบคาบนี้ หรือไม่มีสิทธิ์', 404);
        if (!hasTelegram()) return fail('NO_TOKEN', 'ยังไม่ได้ตั้งค่า Telegram bot', 500);
        const { data: chans } = await supabase.from('telegram_channels').select('chat_id').eq('section_id', sc.section_id).eq('is_active', true);
        if (!chans?.length) return fail('NO_CHANNEL', 'กลุ่มเรียนนี้ยังไม่ได้เปิดแจ้งเตือน Telegram', 409);
        const { text } = await buildSummary(supabase, sc.schedule_id, 'now');
        const sent: unknown[] = [];
        for (const c of chans) {
          try { sent.push({ chat_id: c.chat_id, message_id: await tgSend(c.chat_id, text) }); }
          catch (e) { sent.push({ chat_id: c.chat_id, error: scrub(String((e as Error).message)) }); }
        }
        return json({ data: { sent } });
      }

      case 'tg_chats': {
        if (me.role !== 'admin') return fail('FORBIDDEN', 'เฉพาะแอดมิน', 403);
        if (!hasTelegram()) return fail('NO_TOKEN', 'ยังไม่ได้ตั้งค่า Telegram bot', 500);
        try {
          const updates = await tg('getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member'] });
          const chats = new Map<number, Record<string, unknown>>();
          for (const u of updates) {
            const c = u.message?.chat ?? u.my_chat_member?.chat;
            if (c && c.type !== 'private') chats.set(c.id, { chat_id: String(c.id), title: c.title ?? '' });
          }
          return json({ data: { chats: [...chats.values()] } });
        } catch (e) {
          return fail('TELEGRAM_ERROR', scrub(String((e as Error).message)), 502);
        }
      }

      default:
        return fail('BAD_REQUEST', 'action ไม่รู้จัก', 400);
    }
  } catch (err) {
    console.error(err);
    return fail('INTERNAL_ERROR', String(err), 500);
  }
});
