// POST /functions/v1/work — งานประจำของบุคลากร (ระยะ 1) · deploy verify_jwt:false (ตรวจ token เอง)
//
// หลัก: ผู้ใช้เห็น "ข้อมูลกลาง + ของตนเอง" · ปฏิทินแบบ Google Calendar = ค่าเริ่มเห็นของตัวเอง เลือกซ้อนของคนอื่น/ห้อง/วิชาได้
//       การเขียนผ่านฟังก์ชันในฐานข้อมูล (บันทึกผู้ทำลง audit_log) — migration phase1_work_fns
//
// actions:
//   init                                  ผู้ใช้ + หน้าที่ (งานมอบหมาย) + รายชื่อบุคลากร/ห้อง/วิชา (ใช้ทำตัวเลือก) + ตั้งค่าปฏิทิน
//   cal_feed     { from, to, show?, people?, rooms?, courses?, layers? }   รายการในปฏิทิน (คาบ งาน จองห้อง วันหยุด ไม่อยู่)
//   cal_settings_save { settings }       จำการตั้งค่าปฏิทิน (show/people/rooms/courses/layers/view)
//   task_list    { from?, to?, scope?: mine|created|course|all, include_done? }
//   task_save    { task_id?, title, task_type?, task_date, start_time?, duration_hours?, assignee_id?, is_private?, note?, course_id?, semester_id?, schedule_id? }
//   task_status  { task_id, status: todo|done|cancelled, actual_hours? }
//   task_remove  { task_id }              ("ลบ" = ยกเลิก เก็บประวัติ)
//   task_generate { course_id, semester_id, from?, to? }   สร้างงานจาก "สิ่งที่ต้องเตรียมต่อบท" ให้คาบของวิชา (ผู้ประสาน)
//   leave_queue  { status? }              คำขอลาของกลุ่มเรียนที่ฉันสอน (แอดมิน = ทั้งหมด)
//   leave_decide { request_id, approve, note? }
//   session_cancel   { schedule_id, reason: not_needed|other_held, note? }   ผู้ประสานรายวิชา
//   session_postpone { schedule_id, date, start_time, end_time, location_id?, note? }
//   session_restore  { schedule_id }
//   session_set_room { schedule_id, location_id }   เปลี่ยนห้อง/ขอห้องใหม่ให้คาบ (ห้องชน → ไม่เปลี่ยน)
//   inbox                                 ตัวเลขรออนุมัติ/รอตอบ/งานวันนี้ (ป้ายบนเมนู)
// deno-lint-ignore-file no-explicit-any
import { bkkDate, CORS, fail, json, serviceClient } from '../_shared/http.ts';
import { approverIndex, authStaff, type Staff } from '../_shared/staff-auth.ts';
import { hasTelegram, tgSend } from '../_shared/notify-core.ts';

const sb = serviceClient();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAYERS = ['sessions', 'tasks', 'bookings', 'holidays', 'leaves'];
const CLASS_KINDS = ['class', 'makeup'];
const KIND_TH: Record<string, string> = {
  class: 'คาบเรียน', makeup: 'คาบชดเชย', prep: 'เตรียมแล็บ', reading: 'อ่านผล', research: 'วิจัย', project: 'โครงงาน',
  service: 'บริการ', exam: 'สอบ', event: 'กิจกรรม', training: 'อบรม', maintenance: 'ปิดซ่อม',
};
const TASK_TH: Record<string, string> = { prep: 'เตรียมแล็บ', supervise: 'คุมแล็บ', reading: 'อ่านผล', cleanup: 'เก็บแล็บ', other: 'งาน' };
const ROLE_TH: Record<string, string> = {
  course_owner: 'ผู้ประสานหลัก', course_backup: 'ผู้ประสานรอง', instructor: 'ผู้สอน', lab_staff: 'เจ้าหน้าที่ห้องปฏิบัติการ', lab_worker: 'พนักงานจัดแล็บ',
  room_manager: 'ผู้ดูแลห้อง', room_backup: 'ผู้ดูแลห้อง (สำรอง)', room_delegate: 'ผู้แทนดูแลห้อง', cost_viewer: 'ดูต้นทุน',
};
const RESULT_TH: Record<string, string> = {
  not_coordinator: 'ทำได้เฉพาะผู้ประสานรายวิชา (หลัก หรือรองเมื่อหลักไม่อยู่) หรือแอดมิน',
  already_cancelled: 'คาบนี้ถูกงด/เลื่อนไปแล้ว', not_cancelled: 'คาบนี้ไม่ได้ถูกงด', postponed: 'คาบนี้ถูกเลื่อนไปแล้ว — ถ้าจะยกเลิกการเลื่อน ให้งดคาบชดเชยแทน',
  bad_reason: 'เหตุผลไม่ถูกต้อง', bad_time: 'เวลาเลิกต้องหลังเวลาเริ่ม', past: 'เลื่อนไปเวลาที่ผ่านมาแล้วไม่ได้', not_found: 'ไม่พบรายการ',
  forbidden: 'ไม่มีสิทธิ์แก้งานนี้', no_title: 'ใส่ชื่องาน', no_date: 'ใส่วันที่', no_semester: 'ระบุเทอมของวิชา',
  not_in_course: 'สร้างงานของวิชาได้เฉพาะผู้ที่มีหน้าที่ในวิชานั้น', bad_status: 'สถานะไม่ถูกต้อง',
  not_instructor: 'อนุมัติได้เฉพาะอาจารย์ผู้สอนกลุ่มเรียนนั้น', not_pending: 'คำขอนี้ตัดสินไปแล้ว',
  conflict: 'ห้องนี้ไม่ว่างช่วงเวลาของคาบ — เลือกห้องอื่น',
};
const why = (r: any) => RESULT_TH[r?.result] ?? `ทำไม่สำเร็จ (${r?.result ?? 'unknown'})`;

const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const hm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const dayOf = (iso: string) => bkkDate(new Date(iso));
const t5 = (t: string | null | undefined) => (t ? String(t).slice(0, 5) : null);
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const thDay = (d: string) => new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00+07:00`));
const ids = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x) => UUID.test(x)).slice(0, 100) : []);
const addHours = (t: string, h: number) => { const [a, b] = t.split(':').map(Number); const m = Math.min(24 * 60 - 1, a * 60 + b + Math.round(h * 60)); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// โหลดทีละ 1000 แถว (ขีดจำกัดของ API)
async function all(q: () => any, max = 20000) {
  const out: any[] = [];
  for (let i = 0; i < max; i += 1000) {
    const { data, error } = await q().range(i, i + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ---------- หน้าที่ของผู้ใช้ (งานมอบหมาย) ----------
type Ctx = {
  me: Staff; admin: boolean;
  courseRoles: Map<string, string[]>;   // course|sem → kinds
  sectionTeach: Set<string>;            // section_id ที่สอน
  rooms: Map<string, string[]>;         // location_id → kinds
};
async function context(me: Staff): Promise<Ctx> {
  const today = bkkDate(new Date());
  const [{ data: as }, { data: secs }] = await Promise.all([
    sb.from('staff_assignments').select('kind, course_id, semester_id, section_id, location_id, valid_from, valid_to').eq('user_id', me.user_id),
    sb.from('lab_sections').select('section_id').eq('instructor_id', me.user_id),
  ]);
  const ctx: Ctx = { me, admin: me.role === 'admin', courseRoles: new Map(), sectionTeach: new Set((secs ?? []).map((s: any) => s.section_id)), rooms: new Map() };
  for (const a of as ?? []) {
    if (a.valid_to && a.valid_to < today && a.kind !== 'room_delegate') continue;
    if (a.course_id) { const k = `${a.course_id}|${a.semester_id}`; ctx.courseRoles.set(k, [...(ctx.courseRoles.get(k) ?? []), a.kind]); }
    if (a.kind === 'instructor' && a.section_id) ctx.sectionTeach.add(a.section_id);
    if (a.location_id) ctx.rooms.set(a.location_id, [...(ctx.rooms.get(a.location_id) ?? []), a.kind]);
  }
  return ctx;
}
const courseKinds = (ctx: Ctx, course: string, sem: string) => ctx.courseRoles.get(`${course}|${sem}`) ?? [];
const coordinates = (ctx: Ctx, course: string, sem: string) => ctx.admin || courseKinds(ctx, course, sem).some((k) => k === 'course_owner' || k === 'course_backup');

async function semestersNow() {
  const today = bkkDate(new Date());
  const { data } = await sb.from('semesters').select('semester_id, academic_year, term, start_date, end_date').order('start_date', { ascending: false });
  const list = (data ?? []).map((t: any) => ({ ...t, label: `${t.term === 'summer' ? 'ฤดูร้อน' : t.term}/${t.academic_year}`, current: t.start_date <= today && t.end_date >= today }));
  return list;
}

async function notifyUsers(userIds: string[], html: string) {
  if (!hasTelegram() || !userIds.length) return;
  try {
    const { data } = await sb.from('users').select('telegram_chat_id').in('user_id', [...new Set(userIds)]).not('telegram_chat_id', 'is', null);
    await Promise.all((data ?? []).map((u: any) => tgSend(u.telegram_chat_id, html).catch((e) => console.error('tg', String(e?.message ?? e)))));
  } catch (e) { console.error('notify', String((e as Error)?.message ?? e)); }
}
// ผู้เกี่ยวข้องกับกลุ่มเรียน: ผู้สอน + เจ้าหน้าที่/พนักงานของวิชา + ผู้ประสาน
async function sectionPeople(sectionId: string) {
  const { data: sec } = await sb.from('lab_sections').select('section_id, section_no, course_id, semester_id, instructor_id, courses ( course_code, course_name )').eq('section_id', sectionId).maybeSingle();
  if (!sec) return { sec: null, users: [] as string[] };
  const { data: as } = await sb.from('staff_assignments').select('user_id, kind, section_id, course_id, semester_id')
    .or(`section_id.eq.${sectionId},and(course_id.eq.${sec.course_id},semester_id.eq.${sec.semester_id})`);
  const users = new Set<string>((as ?? []).map((a: any) => a.user_id));
  if (sec.instructor_id) users.add(sec.instructor_id);
  return { sec, users: [...users] };
}

// ---------- ปฏิทิน ----------
type Item = {
  id: string; type: 'session' | 'task' | 'booking' | 'holiday' | 'away'; date: string; end_date?: string; start: string | null; end: string | null;
  title: string; sub?: string | null; room?: string | null; location_id?: string | null; course_id?: string | null; course_code?: string | null;
  status?: string | null; mine: boolean; who?: string | null; owner_id?: string | null; flags?: string[]; ref?: Record<string, unknown>;
};

async function calFeed(ctx: Ctx, body: any) {
  const today = bkkDate(new Date());
  const from = DATE.test(String(body.from)) ? String(body.from) : today;
  let to = DATE.test(String(body.to)) ? String(body.to) : addDay(from, 6);
  if (to < from) to = from;
  if (to > addDay(from, 62)) to = addDay(from, 62);
  const show = ['mine', 'all', 'selected'].includes(body.show) ? body.show : 'mine';
  const people = new Set(ids(body.people)), rooms = new Set(ids(body.rooms)), courses = new Set(ids(body.courses));
  const layers = new Set((Array.isArray(body.layers) ? body.layers : LAYERS).filter((l: string) => LAYERS.includes(l)));
  const uid = ctx.me.user_id;

  // คนที่เลือก → หน้าที่ของเขา (ใช้ดูคาบของเขา)
  const peopleCourse = new Map<string, Set<string>>(), peopleSection = new Map<string, Set<string>>();
  if (show === 'selected' && people.size) {
    const { data } = await sb.from('staff_assignments').select('user_id, kind, course_id, semester_id, section_id').in('user_id', [...people]);
    for (const a of data ?? []) {
      if (a.course_id && ['course_owner', 'course_backup', 'lab_staff', 'lab_worker'].includes(a.kind)) {
        const k = `${a.course_id}|${a.semester_id}`; peopleCourse.set(k, (peopleCourse.get(k) ?? new Set()).add(a.user_id));
      }
      if (a.kind === 'instructor' && a.section_id) peopleSection.set(a.section_id, (peopleSection.get(a.section_id) ?? new Set()).add(a.user_id));
    }
  }

  const { data: users } = await sb.from('users').select('user_id, full_name').neq('role', 'student');
  const nameOf = new Map<string, string>((users ?? []).map((u: any) => [u.user_id, u.full_name]));
  const items: Item[] = [];
  const startIso = `${from}T00:00:00+07:00`, endIso = `${addDay(to, 1)}T00:00:00+07:00`;

  // ---- คาบเรียน ----
  if (layers.has('sessions')) {
    const rows = await all(() => sb.from('schedules')
      .select('schedule_id, section_id, location_id, class_date, start_time, end_time, status, kind, makeup_of, cancel_reason, cancel_note, note, ' +
        'locations ( name, room_code ), lab_topics!schedules_topic_id_fkey ( seq, title_th ), lab_sections!inner ( section_no, course_id, semester_id, instructor_id, courses ( course_code, course_name ) )')
      .gte('class_date', from).lte('class_date', to).order('class_date').order('start_time'));
    const schIds = rows.filter((r: any) => r.status === 'scheduled').map((r: any) => r.schedule_id);
    const resvBy = new Map<string, any[]>();
    for (let i = 0; i < schIds.length; i += 300) {
      const { data } = await sb.from('room_reservations').select('schedule_id, location_id, status').in('schedule_id', schIds.slice(i, i + 300)).in('status', ['pending', 'approved']);
      for (const r of data ?? []) resvBy.set(r.schedule_id, [...(resvBy.get(r.schedule_id) ?? []), r]);
    }
    for (const r of rows) {
      const ls = r.lab_sections, ck = `${ls.course_id}|${ls.semester_id}`;
      const myKinds = [...courseKinds(ctx, ls.course_id, ls.semester_id).filter((k) => k !== 'instructor'), ...(ctx.sectionTeach.has(r.section_id) ? ['instructor'] : [])];
      const mine = myKinds.length > 0;
      let include = show === 'all' || mine;
      let who: string | null = null;
      if (!include && show === 'selected') {
        if (rooms.has(r.location_id) || courses.has(ls.course_id)) include = true;
        const ps = new Set<string>([...(peopleCourse.get(ck) ?? []), ...(peopleSection.get(r.section_id) ?? [])]);
        if (ls.instructor_id && people.has(ls.instructor_id)) ps.add(ls.instructor_id);
        if (ps.size) { include = true; who = [...ps].map((p) => nameOf.get(p)).filter(Boolean).join(', '); }
      }
      if (!include) continue;
      if (r.status === 'cancelled' && r.cancel_reason === 'postponed' && !mine && show !== 'all') continue;
      const rs = resvBy.get(r.schedule_id) ?? [];
      const flags: string[] = [];
      if (r.status === 'scheduled') {
        const primary = rs.filter((x) => x.location_id === r.location_id);
        if (!primary.length) flags.push('no_room'); else if (!primary.some((x) => x.status === 'approved')) flags.push('room_pending');
      }
      if (r.kind === 'makeup') flags.push('makeup');
      items.push({
        id: `s:${r.schedule_id}`, type: 'session', date: r.class_date, start: t5(r.start_time), end: t5(r.end_time),
        title: `${ls.courses?.course_code ?? ''} กลุ่ม ${ls.section_no}`, sub: r.lab_topics ? `บทที่ ${r.lab_topics.seq} ${r.lab_topics.title_th}` : (ls.courses?.course_name ?? null),
        room: r.locations?.name ?? null, location_id: r.location_id, course_id: ls.course_id, course_code: ls.courses?.course_code ?? null,
        status: r.status, mine, who, flags,
        ref: {
          schedule_id: r.schedule_id, section_id: r.section_id, semester_id: ls.semester_id, course_name: ls.courses?.course_name, section_no: ls.section_no,
          roles: myKinds.map((k) => ROLE_TH[k] ?? k), can_manage: coordinates(ctx, ls.course_id, ls.semester_id),
          kind: r.kind, makeup_of: r.makeup_of, cancel_reason: r.cancel_reason, cancel_note: r.cancel_note, note: r.note,
          room_code: r.locations?.room_code ?? null, instructor: ls.instructor_id ? nameOf.get(ls.instructor_id) ?? null : null,
        },
      });
    }
  }

  // ---- จองห้อง (ที่ไม่ใช่คาบเรียน) ----
  if (layers.has('bookings')) {
    const rows = await all(() => sb.from('room_reservations')
      .select('reservation_id, location_id, kind, status, starts_at, ends_at, requested_by, project_name, title, purpose, actual_user, series_id, course_id, ' +
        'locations ( name, room_code ), courses ( course_code )')
      .in('status', ['pending', 'approved']).not('kind', 'in', `(${CLASS_KINDS.join(',')})`).lt('starts_at', endIso).gt('ends_at', startIso).order('starts_at'));
    for (const r of rows) {
      const mine = r.requested_by === uid;
      let include = show === 'all' || mine;
      if (!include && show === 'selected') include = people.has(r.requested_by) || rooms.has(r.location_id) || (!!r.course_id && courses.has(r.course_id));
      if (!include) continue;
      const d0 = dayOf(r.starts_at), d1 = dayOf(new Date(Date.parse(r.ends_at) - 1).toISOString());
      items.push({
        id: `b:${r.reservation_id}`, type: 'booking', date: d0, end_date: d1 !== d0 ? d1 : undefined, start: hm(r.starts_at), end: hm(r.ends_at),
        title: r.title || KIND_TH[r.kind] || r.kind, sub: r.project_name || r.courses?.course_code || r.purpose || null,
        room: r.locations?.name ?? null, location_id: r.location_id, course_id: r.course_id, course_code: r.courses?.course_code ?? null,
        status: r.status, mine, who: mine ? null : nameOf.get(r.requested_by) ?? null, owner_id: r.requested_by,
        flags: r.status === 'pending' ? ['pending'] : [],
        ref: { reservation_id: r.reservation_id, kind: r.kind, kind_th: KIND_TH[r.kind] ?? r.kind, series_id: r.series_id, actual_user: r.actual_user, purpose: r.purpose, starts_at: r.starts_at, ends_at: r.ends_at, room_code: r.locations?.room_code ?? null },
      });
    }
  }

  // ---- งาน ----
  if (layers.has('tasks')) {
    const rows = await all(() => sb.from('tasks')
      .select('task_id, source, schedule_id, course_id, semester_id, task_type, title, assignee_id, task_date, start_time, duration_hours, status, is_private, note, created_by, done_at, ' +
        'courses ( course_code ), schedules ( location_id, locations ( name ) )')
      .gte('task_date', from).lte('task_date', to).neq('status', 'cancelled').order('task_date'));
    for (const t of rows) {
      const mine = t.assignee_id === uid || t.created_by === uid;
      if (t.is_private && !mine) continue;
      let include = show === 'all' || mine;
      if (!include && show === 'selected') include = people.has(t.assignee_id) || (!!t.course_id && courses.has(t.course_id)) || (!!t.schedules?.location_id && rooms.has(t.schedules.location_id));
      if (!include) continue;
      const start = t5(t.start_time);
      items.push({
        id: `t:${t.task_id}`, type: 'task', date: t.task_date, start, end: start && t.duration_hours ? addHours(start, Number(t.duration_hours)) : null,
        title: t.title, sub: t.courses?.course_code ? `${TASK_TH[t.task_type] ?? 'งาน'} · ${t.courses.course_code}` : (TASK_TH[t.task_type] ?? 'งาน'),
        room: t.schedules?.locations?.name ?? null, location_id: t.schedules?.location_id ?? null, course_id: t.course_id, course_code: t.courses?.course_code ?? null,
        status: t.status, mine, who: t.assignee_id === uid ? null : nameOf.get(t.assignee_id) ?? null, owner_id: t.assignee_id,
        flags: [t.is_private ? 'private' : '', t.status === 'done' ? 'done' : '', t.status === 'todo' && t.task_date < today ? 'overdue' : ''].filter(Boolean),
        ref: { task_id: t.task_id, source: t.source, task_type: t.task_type, schedule_id: t.schedule_id, semester_id: t.semester_id, note: t.note, duration_hours: t.duration_hours, assignee_id: t.assignee_id, created_by: t.created_by, is_private: t.is_private, can_edit: ctx.admin || mine || (!!t.course_id && coordinates(ctx, t.course_id, t.semester_id)) },
      });
    }
  }

  // ---- วันหยุด ----
  if (layers.has('holidays')) {
    const { data } = await sb.from('term_holidays').select('holiday_id, holiday_date, name').gte('holiday_date', from).lte('holiday_date', to);
    const seen = new Set<string>();
    for (const h of data ?? []) {
      if (seen.has(h.holiday_date)) continue; seen.add(h.holiday_date);
      items.push({ id: `h:${h.holiday_id}`, type: 'holiday', date: h.holiday_date, start: null, end: null, title: h.name, mine: true });
    }
  }

  // ---- ไม่อยู่ / ลา ----
  if (layers.has('leaves')) {
    const [{ data: away }, { data: leaves }] = await Promise.all([
      sb.from('user_away').select('away_id, user_id, from_date, to_date, note').lte('from_date', to).gte('to_date', from),
      sb.from('staff_leaves').select('leave_id, user_id, from_date, to_date, note').lte('from_date', to).gte('to_date', from),
    ]);
    for (const [pre, list] of [['a', away], ['l', leaves]] as const) {
      for (const a of (list ?? []) as any[]) {
        const mine = a.user_id === uid;
        if (!(show === 'all' || mine || (show === 'selected' && people.has(a.user_id)))) continue;
        items.push({
          id: `${pre}:${a.away_id ?? a.leave_id}`, type: 'away', date: a.from_date, end_date: a.to_date !== a.from_date ? a.to_date : undefined, start: null, end: null,
          title: mine ? (pre === 'a' ? 'ฉันไม่อยู่' : 'ฉันลา') : `${nameOf.get(a.user_id) ?? ''} ${pre === 'a' ? 'ไม่อยู่' : 'ลา'}`, sub: a.note ?? null,
          mine, who: mine ? null : nameOf.get(a.user_id) ?? null, owner_id: a.user_id, ref: { away_id: a.away_id ?? null, leave_id: a.leave_id ?? null },
        });
      }
    }
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || String(a.start ?? '').localeCompare(String(b.start ?? '')) || a.title.localeCompare(b.title));
  return { from, to, show, items, counts: { total: items.length, mine: items.filter((i) => i.mine).length } };
}

// ---------- งาน ----------
async function taskList(ctx: Ctx, body: any) {
  const today = bkkDate(new Date());
  const from = DATE.test(String(body.from)) ? String(body.from) : addDay(today, -14);
  const to = DATE.test(String(body.to)) ? String(body.to) : addDay(today, 60);
  const scope = ['mine', 'created', 'course', 'all'].includes(body.scope) ? body.scope : 'mine';
  const uid = ctx.me.user_id;
  let q = () => {
    let x = sb.from('tasks').select('task_id, source, schedule_id, course_id, semester_id, task_type, title, assignee_id, task_date, start_time, duration_hours, status, actual_hours, ' +
      'is_private, note, created_by, done_by, done_at, handed_over_from, manually_edited, updated_at, courses ( course_code, course_name ), ' +
      'schedules ( class_date, start_time, lab_sections ( section_no ), locations ( name ) )')
      .gte('task_date', from).lte('task_date', to).order('task_date').order('start_time', { nullsFirst: true });
    if (!body.include_done) x = x.eq('status', 'todo'); else x = x.neq('status', 'cancelled');
    if (scope === 'mine') x = x.eq('assignee_id', uid);
    if (scope === 'created') x = x.eq('created_by', uid);
    return x;
  };
  let rows = await all(q, 5000);
  if (scope === 'course') {
    const keys = new Set([...ctx.courseRoles.keys()]);
    rows = rows.filter((t: any) => t.course_id && (ctx.admin || keys.has(`${t.course_id}|${t.semester_id}`)));
  }
  if (scope === 'all' && !ctx.admin) rows = rows.filter((t: any) => !t.is_private || t.assignee_id === uid || t.created_by === uid);
  if (scope === 'all' && ctx.admin) rows = rows.filter((t: any) => !t.is_private || t.assignee_id === uid || t.created_by === uid);
  const { data: users } = await sb.from('users').select('user_id, full_name').neq('role', 'student');
  const nameOf = new Map<string, string>((users ?? []).map((u: any) => [u.user_id, u.full_name]));
  return {
    from, to, scope,
    tasks: rows.map((t: any) => ({
      ...t, start_time: t5(t.start_time), task_type_th: TASK_TH[t.task_type] ?? 'งาน', course_code: t.courses?.course_code ?? null, course_name: t.courses?.course_name ?? null,
      session: t.schedules ? { class_date: t.schedules.class_date, start_time: t5(t.schedules.start_time), section_no: t.schedules.lab_sections?.section_no, room: t.schedules.locations?.name } : null,
      courses: undefined, schedules: undefined,
      assignee_name: nameOf.get(t.assignee_id) ?? null, created_by_name: nameOf.get(t.created_by) ?? null, done_by_name: t.done_by ? nameOf.get(t.done_by) ?? null : null,
      handed_over_from_name: t.handed_over_from ? nameOf.get(t.handed_over_from) ?? null : null,
      overdue: t.status === 'todo' && t.task_date < today,
      can_edit: ctx.admin || t.assignee_id === uid || t.created_by === uid || (!!t.course_id && coordinates(ctx, t.course_id, t.semester_id)),
    })),
  };
}

// ---------- คำขอลา ----------
async function leaveQueue(ctx: Ctx, body: any) {
  const status = ['pending', 'approved', 'rejected', 'all'].includes(body.status) ? body.status : 'pending';
  let q = sb.from('leave_requests').select('request_id, schedule_id, student_id, submitted_via, reason, attachment_file_id, status, decided_at, decision_note, created_at, ' +
    'decider:decided_by ( full_name ), students ( student_code, users ( full_name ) ), ' +
    'schedules!inner ( class_date, start_time, end_time, section_id, locations ( name ), lab_sections ( section_no, courses ( course_code, course_name ) ) )')
    .order('created_at', { ascending: false }).limit(300);
  if (status !== 'all') q = q.eq('status', status);
  if (!ctx.admin) {
    if (!ctx.sectionTeach.size) return { requests: [] };
    q = q.in('schedules.section_id', [...ctx.sectionTeach]);
  }
  const { data, error } = await q;
  if (error) throw error;
  return {
    requests: (data ?? []).map((r: any) => ({
      request_id: r.request_id, status: r.status, reason: r.reason, submitted_via: r.submitted_via, created_at: r.created_at,
      decided_at: r.decided_at, decision_note: r.decision_note, decider: r.decider?.full_name ?? null, has_attachment: !!r.attachment_file_id,
      student_code: r.students?.student_code, student_name: r.students?.users?.full_name,
      schedule_id: r.schedule_id, class_date: r.schedules?.class_date, start_time: t5(r.schedules?.start_time), end_time: t5(r.schedules?.end_time),
      room: r.schedules?.locations?.name ?? null, section_no: r.schedules?.lab_sections?.section_no,
      course_code: r.schedules?.lab_sections?.courses?.course_code, course_name: r.schedules?.lab_sections?.courses?.course_name,
    })),
  };
}

// ---------- ป้ายตัวเลข ----------
async function inbox(ctx: Ctx) {
  const uid = ctx.me.user_id, today = bkkDate(new Date());
  const since = new Date(Date.now() - 86400000).toISOString();
  const [{ data: pend }, { data: moves }, leaves, { data: tasks }] = await Promise.all([
    sb.from('room_reservations').select('reservation_id, location_id, starts_at, pending_change, status')
      .or('status.eq.pending,and(status.eq.approved,pending_change.not.is.null)').gte('ends_at', since).limit(3000),
    sb.from('room_move_requests').select('move_request_id, reservation_id, room_reservations!inner ( requested_by, course_id, semester_id, schedule_id )').eq('status', 'pending'),
    leaveQueue(ctx, { status: 'pending' }),
    sb.from('tasks').select('task_id, task_date').eq('assignee_id', uid).eq('status', 'todo').lte('task_date', today),
  ]);
  let queue = 0;
  if ((pend ?? []).length) {
    if (ctx.admin) queue = pend!.length;
    else {
      const idx = await approverIndex(sb, pend!.map((r: any) => r.location_id));
      queue = pend!.filter((r: any) => idx.can(uid, r.location_id, dayOf(r.pending_change?.starts_at ?? r.starts_at))).length;
    }
  }
  const movesForMe = (moves ?? []).filter((m: any) => {
    const r = m.room_reservations;
    return r.requested_by === uid || ctx.admin || (r.schedule_id && r.course_id && coordinates(ctx, r.course_id, r.semester_id));
  }).length;
  return {
    booking_queue: queue, move_requests: movesForMe, leave_requests: leaves.requests.length,
    tasks_today: (tasks ?? []).filter((t: any) => t.task_date === today).length, tasks_overdue: (tasks ?? []).filter((t: any) => t.task_date < today).length,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);
  const me = await authStaff(sb, req);
  if (me instanceof Response) return me;
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }

  try {
    const ctx = await context(me);
    const uid = me.user_id;
    switch (body.action) {
      case 'init': {
        const [{ data: users }, { data: rooms }, { data: zones }, terms, { data: me2 }] = await Promise.all([
          sb.from('users').select('user_id, full_name, role, is_scientist, department_id').neq('role', 'student').order('full_name'),
          sb.from('locations').select('location_id, name, room_code, zone_id, building, floor, setup_minutes, teardown_minutes, room_status').order('name'),
          sb.from('zones').select('zone_id, name, sort_order').order('sort_order'),
          semestersNow(),
          sb.from('users').select('calendar_settings').eq('user_id', uid).maybeSingle(),
        ]);
        const termIds = terms.filter((t: any) => t.end_date >= addDay(bkkDate(new Date()), -120)).map((t: any) => t.semester_id);
        const { data: secs } = termIds.length ? await sb.from('lab_sections').select('course_id, semester_id, courses ( course_code, course_name )').in('semester_id', termIds) : { data: [] };
        const cmap = new Map<string, any>();
        for (const s of secs ?? []) {
          const k = `${s.course_id}|${s.semester_id}`;
          if (!cmap.has(k)) cmap.set(k, { course_id: s.course_id, semester_id: s.semester_id, course_code: s.courses?.course_code, course_name: s.courses?.course_name, my_roles: courseKinds(ctx, s.course_id, s.semester_id).map((x) => ROLE_TH[x] ?? x), can_manage: coordinates(ctx, s.course_id, s.semester_id) });
        }
        const { data: allAs } = await sb.from('staff_assignments').select('user_id, kind');
        const kindsOf = new Map<string, Set<string>>();
        for (const a of allAs ?? []) kindsOf.set(a.user_id, (kindsOf.get(a.user_id) ?? new Set()).add(a.kind));
        const position = (u: any) => u.role === 'admin' ? 'ผู้ดูแลระบบ'
          : u.is_scientist ? 'นักวิทยาศาสตร์'
          : kindsOf.get(u.user_id)?.has('lab_worker') ? 'พนักงานจัดแล็บ'
          : kindsOf.get(u.user_id)?.has('lab_staff') ? 'เจ้าหน้าที่ห้องปฏิบัติการ'
          : kindsOf.get(u.user_id)?.has('instructor') ? 'อาจารย์' : 'บุคลากร';
        const myKinds = new Set<string>([...ctx.courseRoles.values()].flat().concat([...ctx.rooms.values()].flat()));
        if (ctx.sectionTeach.size) myKinds.add('instructor');
        return json({ data: {
          me: { user_id: uid, full_name: me.full_name, role: me.role, is_scientist: me.is_scientist, position: position({ ...me }), kinds: [...myKinds].map((k) => ({ kind: k, th: ROLE_TH[k] ?? k })) },
          caps: {
            admin: ctx.admin, coordinator: ctx.admin || myKinds.has('course_owner') || myKinds.has('course_backup'),
            room_manager: ctx.admin || ctx.rooms.size > 0, instructor: ctx.admin || ctx.sectionTeach.size > 0,
            my_rooms: [...ctx.rooms.keys()],
          },
          people: (users ?? []).map((u: any) => ({ user_id: u.user_id, full_name: u.full_name, position: position(u), is_me: u.user_id === uid })),
          rooms: (rooms ?? []).map((r: any) => ({ ...r, zone: (zones ?? []).find((z: any) => z.zone_id === r.zone_id)?.name ?? null, my_roles: (ctx.rooms.get(r.location_id) ?? []).map((k) => ROLE_TH[k] ?? k) })),
          zones: zones ?? [], terms, courses: [...cmap.values()].sort((a, b) => String(a.course_code).localeCompare(String(b.course_code))),
          calendar_settings: me2?.calendar_settings ?? { show: 'mine' },
          task_types: TASK_TH, booking_kinds: KIND_TH,
        } });
      }

      case 'cal_feed': return json({ data: await calFeed(ctx, body) });

      case 'cal_settings_save': {
        const s = body.settings ?? {};
        const clean = {
          show: ['mine', 'all', 'selected'].includes(s.show) ? s.show : 'mine',
          people: ids(s.people), rooms: ids(s.rooms), courses: ids(s.courses),
          layers: (Array.isArray(s.layers) ? s.layers : LAYERS).filter((l: string) => LAYERS.includes(l)),
          view: ['week', 'month', 'agenda', 'day'].includes(s.view) ? s.view : 'week',
        };
        const { error } = await sb.from('users').update({ calendar_settings: clean }).eq('user_id', uid);
        if (error) throw error;
        return json({ data: clean });
      }

      // ---------------- งาน ----------------
      case 'task_list': return json({ data: await taskList(ctx, body) });

      case 'task_save': {
        const p: Record<string, unknown> = {};
        for (const k of ['title', 'task_type', 'task_date', 'start_time', 'duration_hours', 'assignee_id', 'is_private', 'note', 'course_id', 'semester_id', 'schedule_id']) if (k in body) p[k] = body[k];
        if (p.task_date && !DATE.test(String(p.task_date))) return fail('BAD_REQUEST', 'วันที่ไม่ถูกต้อง', 400);
        if (p.start_time && !TIME.test(String(p.start_time))) return fail('BAD_REQUEST', 'เวลาไม่ถูกต้อง (HH:MM)', 400);
        if (p.task_type && !TASK_TH[String(p.task_type)]) return fail('BAD_REQUEST', 'ประเภทงานไม่ถูกต้อง', 400);
        if (p.duration_hours !== undefined && p.duration_hours !== '' && p.duration_hours !== null) {
          const h = Number(p.duration_hours); if (!(h > 0 && h <= 24)) return fail('BAD_REQUEST', 'ชั่วโมงต้องอยู่ระหว่าง 0–24', 400);
        }
        for (const k of ['assignee_id', 'course_id', 'semester_id', 'schedule_id']) if (p[k] && !UUID.test(String(p[k]))) return fail('BAD_REQUEST', `${k} ไม่ถูกต้อง`, 400);
        const taskId = body.task_id && UUID.test(String(body.task_id)) ? String(body.task_id) : null;
        const { data: res, error } = await sb.rpc('task_write', { p_by: uid, p_action: 'save', p_id: taskId, p });
        if (error) throw error;
        if (!res?.ok) return fail(res?.result === 'forbidden' || res?.result === 'not_in_course' ? 'FORBIDDEN' : 'BAD_REQUEST', why(res), res?.result === 'forbidden' ? 403 : 400);
        // แจ้งผู้รับงาน (ถ้าเป็นคนอื่น)
        const assignee = p.assignee_id ? String(p.assignee_id) : null;
        if (assignee && assignee !== uid && (res.created || body.notify_assignee)) {
          await notifyUsers([assignee], `📝 <b>งานใหม่ถึงคุณ</b>\n${esc(p.title)}\n${esc(thDay(String(p.task_date)))}${p.start_time ? ' ' + esc(p.start_time) : ''}\nโดย ${esc(me.full_name)}`);
        }
        return json({ data: res });
      }

      case 'task_status': {
        const { data: res, error } = await sb.rpc('task_write', { p_by: uid, p_action: 'status', p_id: String(body.task_id ?? ''), p: { status: body.status, ...(body.actual_hours !== undefined ? { actual_hours: body.actual_hours } : {}) } });
        if (error) throw error;
        if (!res?.ok) return fail('BAD_REQUEST', why(res), res?.result === 'forbidden' ? 403 : 400);
        return json({ data: res });
      }

      case 'task_remove': {
        const { data: res, error } = await sb.rpc('task_write', { p_by: uid, p_action: 'remove', p_id: String(body.task_id ?? ''), p: {} });
        if (error) throw error;
        if (!res?.ok) return fail('BAD_REQUEST', why(res), res?.result === 'forbidden' ? 403 : 400);
        return json({ data: res });
      }

      case 'task_generate': {
        const course = String(body.course_id ?? ''), sem = String(body.semester_id ?? '');
        if (!UUID.test(course) || !UUID.test(sem)) return fail('BAD_REQUEST', 'ระบุวิชาและเทอม', 400);
        if (!coordinates(ctx, course, sem)) return fail('FORBIDDEN', 'สร้างงานจากสิ่งที่ต้องเตรียมได้เฉพาะผู้ประสานรายวิชา', 403);
        const today = bkkDate(new Date());
        const from = DATE.test(String(body.from)) ? String(body.from) : today;
        const to = DATE.test(String(body.to)) ? String(body.to) : addDay(today, 180);
        const { data: secs } = await sb.from('lab_sections').select('section_id').eq('course_id', course).eq('semester_id', sem);
        const secIds = (secs ?? []).map((s: any) => s.section_id);
        if (!secIds.length) return json({ data: { created: 0, sessions: 0 } });
        const { data: sch } = await sb.from('schedules').select('schedule_id').in('section_id', secIds).eq('status', 'scheduled').gte('class_date', from).lte('class_date', to);
        const sids = (sch ?? []).map((s: any) => s.schedule_id);
        if (!sids.length) return json({ data: { created: 0, sessions: 0 } });
        const { data: n, error } = await sb.rpc('generate_rule_tasks', { p_schedule_ids: sids, p_by: uid });
        if (error) throw error;
        return json({ data: { created: n ?? 0, sessions: sids.length } });
      }

      // ---------------- คำขอลา ----------------
      case 'leave_queue': return json({ data: await leaveQueue(ctx, body) });

      case 'leave_decide': {
        const approve = body.approve === true;
        const note = String(body.note ?? '').trim().slice(0, 300) || null;
        if (!approve && !note) return fail('BAD_REQUEST', 'ไม่อนุมัติต้องระบุเหตุผล', 400);
        const { data: res, error } = await sb.rpc('leave_decide', { p_by: uid, p_request: String(body.request_id ?? ''), p_approve: approve, p_note: note });
        if (error) throw error;
        if (!res?.ok) return fail(res?.result === 'not_instructor' ? 'FORBIDDEN' : 'BAD_REQUEST', why(res), res?.result === 'not_instructor' ? 403 : 400);
        return json({ data: res });
      }

      // ---------------- เลื่อน / งดคาบ (ผู้ประสานรายวิชา) ----------------
      case 'session_cancel': {
        const reason = String(body.reason ?? '');
        const note = String(body.note ?? '').trim().slice(0, 500) || null;
        if (!note) return fail('BAD_REQUEST', 'ระบุรายละเอียดการงด (บันทึกไว้ในประวัติ)', 400);
        const { data: res, error } = await sb.rpc('session_cancel', { p_by: uid, p_schedule: String(body.schedule_id ?? ''), p_reason: reason, p_note: note });
        if (error) throw error;
        if (!res?.ok) return fail(res?.result === 'not_coordinator' ? 'FORBIDDEN' : 'BAD_REQUEST', why(res), res?.result === 'not_coordinator' ? 403 : 400);
        const { sec, users } = await sectionPeople(res.section_id);
        const { data: sc } = await sb.from('schedules').select('class_date, start_time, end_time').eq('schedule_id', res.schedule_id).maybeSingle();
        if (sec && sc) await notifyUsers(users.filter((u) => u !== uid),
          `🚫 <b>งดคาบ ${esc(sec.courses?.course_code)} กลุ่ม ${esc(sec.section_no)}</b>\n${esc(thDay(sc.class_date))} ${esc(t5(sc.start_time))}–${esc(t5(sc.end_time))}\n` +
          `${reason === 'not_needed' ? 'ไม่ต้องเรียนคาบนี้แล้ว' : 'มีการเรียนในรูปแบบอื่น'} — ${esc(note)}\nโดย ${esc(me.full_name)}`);
        return json({ data: res });
      }

      case 'session_postpone': {
        const date = String(body.date ?? ''), st = String(body.start_time ?? ''), en = String(body.end_time ?? '');
        if (!DATE.test(date) || !TIME.test(st) || !TIME.test(en)) return fail('BAD_REQUEST', 'ระบุวันและเวลาใหม่ให้ครบ', 400);
        const loc = body.location_id && UUID.test(String(body.location_id)) ? String(body.location_id) : null;
        const note = String(body.note ?? '').trim().slice(0, 400) || null;
        const { data: res, error } = await sb.rpc('session_postpone', { p_by: uid, p_schedule: String(body.schedule_id ?? ''), p_date: date, p_start: st, p_end: en, p_location: loc, p_note: note });
        if (error) throw error;
        if (!res?.ok) return fail(res?.result === 'not_coordinator' ? 'FORBIDDEN' : 'BAD_REQUEST', why(res), res?.result === 'not_coordinator' ? 403 : 400);
        const { sec, users } = await sectionPeople(res.section_id);
        if (sec) await notifyUsers(users.filter((u) => u !== uid),
          `🔁 <b>เลื่อนคาบ ${esc(sec.courses?.course_code)} กลุ่ม ${esc(sec.section_no)}</b>\n${esc(res.summary)}${note ? '\n' + esc(note) : ''}\n` +
          `${res.has_room ? 'ส่งคำขอห้องให้แล้ว — รอผู้ดูแลห้องอนุมัติ' : '⚠️ ห้องเดิมไม่ว่างช่วงใหม่ — ต้องจองห้องเพิ่ม'}\nโดย ${esc(me.full_name)}`);
        return json({ data: res });
      }

      case 'session_restore': {
        const { data: res, error } = await sb.rpc('session_restore', { p_by: uid, p_schedule: String(body.schedule_id ?? '') });
        if (error) throw error;
        if (!res?.ok) return fail(res?.result === 'not_coordinator' ? 'FORBIDDEN' : 'BAD_REQUEST', why(res), res?.result === 'not_coordinator' ? 403 : 400);
        return json({ data: res });
      }

      case 'session_set_room': {
        const loc = String(body.location_id ?? '');
        if (!UUID.test(loc)) return fail('BAD_REQUEST', 'เลือกห้อง', 400);
        const { data: res, error } = await sb.rpc('session_set_room', { p_by: uid, p_schedule: String(body.schedule_id ?? ''), p_location: loc });
        if (error) throw error;
        if (!res?.ok) return fail(res?.result === 'not_coordinator' ? 'FORBIDDEN' : res?.result === 'conflict' ? 'ROOM_CONFLICT' : 'BAD_REQUEST', why(res), res?.result === 'not_coordinator' ? 403 : res?.result === 'conflict' ? 409 : 400);
        return json({ data: res });
      }

      case 'inbox': return json({ data: await inbox(ctx) });

      default:
        return fail('BAD_REQUEST', 'action ไม่รู้จัก', 400);
    }
  } catch (err) {
    console.error(err);
    return fail('INTERNAL_ERROR', String((err as Error)?.message ?? err), 500);
  }
});
