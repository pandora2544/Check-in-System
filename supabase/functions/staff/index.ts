// POST /functions/v1/staff   — API สำหรับหน้าอาจารย์/แอดมิน (ต้องล็อกอิน)
// ตรวจ token ในโค้ดเอง (auth.getUser) เพราะโปรเจกต์ใช้ JWT signing key แบบใหม่ — deploy ด้วย verify_jwt: false
//
// สิทธิ์
//   ดู:   แอดมิน = ทุกกลุ่มเรียน · บุคลากรที่สังกัดสาขา = ทุกกลุ่มเรียนของวิชาในสาขา + กลุ่มที่ตัวเองสอน · ไม่มีสาขา = เฉพาะที่ตัวเองสอน
//   แก้:  แอดมิน = ทุกกลุ่ม · อาจารย์ = เฉพาะกลุ่มที่ตัวเองสอน (เช็คชื่อแทน, หมายเหตุ, ตั้งค่าแจ้งเตือน)
//
// actions:
//   me                                   ผู้ใช้ + สาขา + รายการสาขา (แอดมินใช้กรอง)
//   calendar   { month: 'YYYY-MM', department_id? }   ภาพรวมรายวันทั้งเดือน (จำนวนคาบ, วิชา, ยอดเข้าเรียน)
//   day        { date?, department_id? }  คาบทั้งหมดของวันนั้น + ยอดมา/สาย/ขาด/ลา/ออก (เดิมชื่อ sessions — ยังเรียกชื่อเดิมได้)
//   session    { schedule_id }           รายชื่อทั้งกลุ่ม + สถานะเช็คชื่อรายคน
//   mark       { schedule_id, student_id, status, note? }   เช็คชื่อแทน/แก้สถานะ (present|late|absent|excused)
//   note       { attendance_id, note }   แก้หมายเหตุ
//   notify_get / notify_set / notify_send_now / tg_chats   ตั้งค่าแจ้งเตือน Telegram (ดูรายละเอียดใน case)

import { CORS, bkkAt, bkkDate, fail, json, serviceClient } from '../_shared/http.ts';
import { buildSummary, hasTelegram, scrub, tg, tgSend } from '../_shared/notify-core.ts';

const supabase = serviceClient();
const STATUSES = ['present', 'late', 'absent', 'excused'];

type Staff = { user_id: string; full_name: string; role: string; email: string | null; department_id: string | null };
type Section = {
  section_id: string; section_no: string; instructor_id: string | null; instructor_name: string | null;
  course_code: string; course_name: string; department_id: string | null; department_code: string | null;
  department_name: string | null; color: string | null; term: string | null; mine: boolean; editable: boolean;
};

async function authStaff(req: Request): Promise<Staff | Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ', 401);
  const { data: auth, error } = await supabase.auth.getUser(token);
  if (error || !auth?.user) return fail('UNAUTHORIZED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  const { data: me } = await supabase.from('users').select('user_id, full_name, role, email, department_id').eq('user_id', auth.user.id).maybeSingle();
  if (!me || !['instructor', 'admin'].includes(me.role)) return fail('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์เข้าหน้าอาจารย์/แอดมิน', 403);
  return me as Staff;
}

// กลุ่มเรียนที่ผู้ใช้ "ดู" ได้ (พร้อมข้อมูลวิชา/สาขา/อาจารย์) — ใช้ร่วมทุก action
async function visibleSections(me: Staff, departmentFilter?: string | null): Promise<Section[]> {
  const { data } = await supabase.from('lab_sections').select(
    'section_id, section_no, instructor_id, instructor:instructor_id ( full_name ), semesters ( academic_year, term ), ' +
    'courses!inner ( course_code, course_name, department_id, departments ( code, name, color ) )',
  );
  const all = (data ?? []).map((s: Record<string, any>): Section => ({
    section_id: s.section_id, section_no: s.section_no, instructor_id: s.instructor_id, instructor_name: s.instructor?.full_name ?? null,
    course_code: s.courses?.course_code, course_name: s.courses?.course_name,
    department_id: s.courses?.department_id ?? null, department_code: s.courses?.departments?.code ?? null,
    department_name: s.courses?.departments?.name ?? null, color: s.courses?.departments?.color ?? null,
    term: s.semesters ? `${s.semesters.term}/${s.semesters.academic_year}` : null,
    mine: s.instructor_id === me.user_id, editable: me.role === 'admin' || s.instructor_id === me.user_id,
  }));
  let list = me.role === 'admin' ? all
    : all.filter((s) => s.mine || (me.department_id && s.department_id === me.department_id));
  if (departmentFilter) list = list.filter((s) => s.department_id === departmentFilter);
  return list.sort((a, b) => a.course_code.localeCompare(b.course_code) || a.section_no.localeCompare(b.section_no));
}

async function sectionAccess(me: Staff, sectionId: string) {
  const s = (await visibleSections(me)).find((x) => x.section_id === sectionId);
  return s ?? null;
}

async function scheduleAccess(me: Staff, scheduleId: string) {
  const { data: sc } = await supabase.from('schedules')
    .select('schedule_id, section_id, class_date, start_time, end_time, status, locations ( name ), lab_sections ( late_threshold_minutes )')
    .eq('schedule_id', scheduleId).maybeSingle();
  if (!sc) return null;
  const sec = await sectionAccess(me, sc.section_id);
  if (!sec) return null;
  return { sc: sc as Record<string, any>, sec };
}

async function notifySettings(sectionId: string) {
  const [{ data: sec }, { data: ch }] = await Promise.all([
    supabase.from('lab_sections').select('auto_absent').eq('section_id', sectionId).single(),
    supabase.from('telegram_channels').select('chat_id, title, is_active, notify_mid, notify_end, updated_at').eq('section_id', sectionId).order('created_at'),
  ]);
  return { section_id: sectionId, auto_absent: !!sec?.auto_absent, telegram_ready: hasTelegram(), channels: ch ?? [] };
}

async function stats(from: string, to: string, sections: Section[]) {
  if (!sections.length) return [];
  const { data, error } = await supabase.rpc('staff_schedule_stats', { p_from: from, p_to: to, p_section_ids: sections.map((s) => s.section_id) });
  if (error) throw error;
  return (data ?? []) as Record<string, any>[];
}

const phase = (row: Record<string, any>, now: number) => {
  if (row.status === 'cancelled') return 'cancelled';
  const st = bkkAt(row.class_date, row.start_time).getTime(), en = bkkAt(row.class_date, row.end_time).getTime();
  return now < st ? 'upcoming' : now < en ? 'live' : 'done';
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);

  const me = await authStaff(req);
  if (me instanceof Response) return me;

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }
  const deptFilter = typeof body.department_id === 'string' && body.department_id ? body.department_id : null;

  try {
    switch (body.action) {
      case 'me': {
        const [sections, { data: depts }] = await Promise.all([
          visibleSections(me),
          supabase.from('departments').select('department_id, code, name, color').order('code'),
        ]);
        const myDept = (depts ?? []).find((d) => d.department_id === me.department_id) ?? null;
        const shownDepts = me.role === 'admin' ? depts ?? [] : (depts ?? []).filter((d) => sections.some((s) => s.department_id === d.department_id));
        return json({ data: { user: { ...me, department: myDept }, sections, departments: shownDepts } });
      }

      case 'calendar': {
        const m = /^(\d{4})-(\d{2})$/.exec(String(body.month ?? '')) ?? /^(\d{4})-(\d{2})/.exec(bkkDate(new Date()))!;
        const y = Number(m[1]), mo = Number(m[2]);
        const from = `${m[1]}-${m[2]}-01`;
        const to = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
        const sections = await visibleSections(me, deptFilter);
        const rows = await stats(from, to, sections);
        const secMap = new Map(sections.map((s) => [s.section_id, s]));
        const now = Date.now();
        const days: Record<string, any> = {};
        for (const r of rows) {
          const sec = secMap.get(r.section_id)!;
          const d = (days[r.class_date] ??= { date: r.class_date, sessions: 0, live: 0, done: 0, expected: 0, attended: 0, absent: 0, excused: 0, courses: {} as Record<string, any> });
          const ph = phase(r, now);
          if (ph === 'cancelled') continue;
          d.sessions++;
          if (ph === 'live') d.live++;
          if (ph === 'done') { d.done++; d.expected += r.enrolled; d.attended += r.present + r.late; d.absent += r.absent; d.excused += r.excused; }
          const c = (d.courses[sec.course_code] ??= { course_code: sec.course_code, course_name: sec.course_name, department_code: sec.department_code, color: sec.color, sessions: 0, mine: false });
          c.sessions++; c.mine ||= sec.mine;
        }
        const list = Object.values(days).map((d: any) => ({ ...d, courses: Object.values(d.courses).sort((a: any, b: any) => a.course_code.localeCompare(b.course_code)) }));
        return json({ data: { month: `${m[1]}-${m[2]}`, from, to, days: list } });
      }

      case 'day':
      case 'sessions': {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? '')) ? String(body.date) : bkkDate(new Date());
        const sections = await visibleSections(me, deptFilter);
        const rows = await stats(date, date, sections);
        const secMap = new Map(sections.map((s) => [s.section_id, s]));
        const now = Date.now();
        const sessions = rows.map((r) => {
          const sec = secMap.get(r.section_id)!;
          return {
            schedule_id: r.schedule_id, section_id: r.section_id, class_date: r.class_date,
            start_time: String(r.start_time).slice(0, 5), end_time: String(r.end_time).slice(0, 5), status: r.status, phase: phase(r, now),
            room: r.room, course_code: sec.course_code, course_name: sec.course_name, section_no: sec.section_no,
            instructor_name: sec.instructor_name, department_code: sec.department_code, department_name: sec.department_name, color: sec.color,
            mine: sec.mine, editable: sec.editable,
            total: r.enrolled, present: r.present, late: r.late, absent: r.absent, excused: r.excused, checked_out: r.checked_out,
          };
        });
        return json({ data: { date, sessions } });
      }

      case 'session': {
        const acc = await scheduleAccess(me, String(body.schedule_id ?? ''));
        if (!acc) return fail('NOT_FOUND', 'ไม่พบคาบนี้ หรือไม่มีสิทธิ์ดู', 404);
        const { sc, sec } = acc;
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
        return json({ data: {
          schedule: {
            schedule_id: sc.schedule_id, class_date: sc.class_date, start_time: sc.start_time.slice(0, 5), end_time: sc.end_time.slice(0, 5),
            status: sc.status, room: sc.locations?.name, course_code: sec.course_code, course_name: sec.course_name,
            section_no: sec.section_no, late_threshold_minutes: sc.lab_sections?.late_threshold_minutes, section_id: sc.section_id,
            instructor_name: sec.instructor_name, department_name: sec.department_name, term: sec.term, editable: sec.editable,
          },
          roster,
        } });
      }

      case 'mark': {
        const status = String(body.status ?? '');
        if (!STATUSES.includes(status)) return fail('BAD_REQUEST', 'สถานะไม่ถูกต้อง', 400);
        const acc = await scheduleAccess(me, String(body.schedule_id ?? ''));
        if (!acc) return fail('NOT_FOUND', 'ไม่พบคาบนี้ หรือไม่มีสิทธิ์แก้', 404);
        if (!acc.sec.editable) return fail('FORBIDDEN', 'แก้ได้เฉพาะกลุ่มเรียนที่ตัวเองสอน', 403);
        const sc = acc.sc;
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
        const acc = rec ? await scheduleAccess(me, rec.schedule_id) : null;
        if (!rec || !acc) return fail('NOT_FOUND', 'ไม่พบรายการ หรือไม่มีสิทธิ์แก้', 404);
        if (!acc.sec.editable) return fail('FORBIDDEN', 'แก้ได้เฉพาะกลุ่มเรียนที่ตัวเองสอน', 403);
        const note = String(body.note ?? '').trim().slice(0, 300) || null;
        const { error } = await supabase.from('attendance_records').update({ note, note_updated_at: new Date().toISOString() }).eq('attendance_id', rec.attendance_id);
        if (error) throw error;
        return json({ data: { attendance_id: rec.attendance_id, note } });
      }

      // ---- แจ้งเตือน Telegram ----
      case 'notify_get': {
        const sec = await sectionAccess(me, String(body.section_id ?? ''));
        if (!sec) return fail('NOT_FOUND', 'ไม่พบกลุ่มเรียน หรือไม่มีสิทธิ์', 404);
        return json({ data: { ...(await notifySettings(sec.section_id)), editable: sec.editable } });
      }

      case 'notify_set': {
        // { section_id, auto_absent?, chat_id?, is_active?, notify_mid?, notify_end?, title?, remove? }
        const sec = await sectionAccess(me, String(body.section_id ?? ''));
        if (!sec) return fail('NOT_FOUND', 'ไม่พบกลุ่มเรียน หรือไม่มีสิทธิ์', 404);
        if (!sec.editable) return fail('FORBIDDEN', 'ตั้งค่าได้เฉพาะกลุ่มเรียนที่ตัวเองสอน', 403);
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
        return json({ data: { ...(await notifySettings(sec.section_id)), editable: true } });
      }

      case 'notify_send_now': {
        const acc = await scheduleAccess(me, String(body.schedule_id ?? ''));
        if (!acc) return fail('NOT_FOUND', 'ไม่พบคาบนี้ หรือไม่มีสิทธิ์', 404);
        if (!acc.sec.editable) return fail('FORBIDDEN', 'ส่งได้เฉพาะกลุ่มเรียนที่ตัวเองสอน', 403);
        if (!hasTelegram()) return fail('NO_TOKEN', 'ยังไม่ได้ตั้งค่า Telegram bot', 500);
        const { data: chans } = await supabase.from('telegram_channels').select('chat_id').eq('section_id', acc.sc.section_id).eq('is_active', true);
        if (!chans?.length) return fail('NO_CHANNEL', 'กลุ่มเรียนนี้ยังไม่ได้เปิดแจ้งเตือน Telegram', 409);
        const { text } = await buildSummary(supabase, acc.sc.schedule_id, 'now');
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
    return fail('INTERNAL_ERROR', String((err as Error)?.message ?? err), 500);
  }
});
