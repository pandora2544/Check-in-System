// POST /functions/v1/booking — จองห้อง (plan.md ส่วนที่ 3 · DEC-035) · deploy verify_jwt:false (ตรวจ token เอง)
//
// หลัก: ฐานข้อมูลกันห้องชน (exclusion) · การเขียนทุกครั้งผ่านฟังก์ชัน transaction (migration 017)
//       คาบเรียน/ชดเชยสร้างและแก้ผ่านคาบเท่านั้น (ตั้งค่าเทอม / เปลี่ยนคาบ) — ที่นี่อนุมัติได้แต่ไม่แก้/ยกเลิกตรง
//
// actions:
//   rooms_board   { date, days?=1, zone_id? }             ตารางห้อง (บุคลากรทุกคนเห็นทุกห้อง B8)
//   free_rooms    { starts_at, ends_at }                   ห้องที่ว่างช่วงนี้ (B5 แนะนำห้องแทน)
//   request_preview { location_id, pattern, start_time, end_time, setup_minutes?, teardown_minutes? }
//   request_create  { ...preview, kind, dates?, course_id?, semester_id?, project_name?, title?, purpose?, actual_user?, override?, override_note? }
//     pattern: {type:'once',date} | {type:'range',from,to,skip_weekend?} | {type:'weekly',from,weekdays:[1-7],every?,until?|count?} | {type:'dates',dates:[]}
//   decide        { reservation_ids? | series_id?, approve, note? }
//   change        { reservation_id, location_id?, starts_at, ends_at, setup_minutes?, teardown_minutes? }
//   cancel        { reservation_id, scope?: this|following|all, note? }
//   queue         {}                                       คำขอที่ฉันอนุมัติได้ (แอดมิน = ทั้งหมด)
//   mine          {}                                       คำขอของฉัน (อนาคต)
//   dashboard     { semester_id? }                         การจองต้นเทอมรายวิชา (B6)
//   settings_save { course_id, semester_id, request_lead_days, approve_lead_days, first_class_date }
//   away_list / away_save { from_date, to_date, note? } / away_delete { away_id }
// deno-lint-ignore-file no-explicit-any
import { bkkDate, CORS, fail, json, serviceClient } from '../_shared/http.ts';
import { approverIndex as approverIndexShared, authStaff, isCourseOwner, roomContacts } from '../_shared/staff-auth.ts';
import { hasTelegram, tgSend } from '../_shared/notify-core.ts';

const sb = serviceClient();
const approverIndex = (locIds: string[]) => approverIndexShared(sb, locIds);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const MAX_ITEMS = 200;
const OPEN_KINDS = ['prep', 'reading', 'research', 'project', 'service', 'exam', 'event', 'training', 'maintenance'];
const CLASS_KINDS = ['class', 'makeup'];
const KIND_TH: Record<string, string> = {
  class: 'คาบเรียน', makeup: 'คาบชดเชย', prep: 'เตรียมแล็บ', reading: 'อ่านผล', research: 'วิจัย', project: 'โครงงาน',
  service: 'บริการ', exam: 'สอบ', event: 'กิจกรรม', training: 'อบรม', maintenance: 'ปิดซ่อม',
};
const STATUS_TH: Record<string, string> = { pending: 'รออนุมัติ', approved: 'อนุมัติ', rejected: 'ปฏิเสธ', cancelled: 'ยกเลิก' };

const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const isoDow = (d: string) => { const x = new Date(`${d}T00:00:00Z`).getUTCDay(); return x === 0 ? 7 : x; };
const at = (d: string, t: string) => `${d}T${t}:00+07:00`;
const dayOf = (iso: string) => bkkDate(new Date(iso));
const hm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const thDay = (d: string) => new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00+07:00`));
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mins = (v: unknown, dflt: number) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? Math.max(0, Math.min(600, Math.round(n))) : dflt; };

// ---------- แตกรูปแบบซ้ำเป็นรายวัน (3.4) ----------
function expandPattern(p: any): string[] | string {
  const out: string[] = [];
  const push = (d: string) => { if (!out.includes(d)) out.push(d); };
  switch (p?.type) {
    case 'once':
      if (!DATE.test(String(p.date))) return 'วันที่ไม่ถูกต้อง';
      push(p.date); break;
    case 'range': {
      if (!DATE.test(String(p.from)) || !DATE.test(String(p.to)) || p.to < p.from) return 'ช่วงวันที่ไม่ถูกต้อง';
      for (let d = p.from; d <= p.to && out.length <= MAX_ITEMS; d = addDay(d, 1)) if (!(p.skip_weekend && isoDow(d) >= 6)) push(d);
      break;
    }
    case 'weekly': {
      const days = (Array.isArray(p.weekdays) ? p.weekdays : []).map(Number).filter((w: number) => w >= 1 && w <= 7);
      const every = Math.max(1, Math.min(8, Number(p.every) || 1));
      const count = p.count ? Math.max(1, Math.min(MAX_ITEMS, Number(p.count))) : null;
      if (!DATE.test(String(p.from)) || !days.length) return 'ต้องมีวันเริ่มและวันในสัปดาห์';
      if (!count && !DATE.test(String(p.until ?? ''))) return 'ต้องกำหนดวันสิ้นสุดหรือจำนวนครั้ง';
      const start = p.from, weekStart = addDay(start, 1 - isoDow(start));
      for (let d = start; out.length <= MAX_ITEMS; d = addDay(d, 1)) {
        if (count ? out.length >= count : d > p.until) break;
        const week = Math.floor((new Date(`${d}T00:00:00Z`).getTime() - new Date(`${weekStart}T00:00:00Z`).getTime()) / (7 * 86400000));
        if (week % every === 0 && days.includes(isoDow(d))) push(d);
        if (d > addDay(start, 3 * 366)) break;
      }
      break;
    }
    case 'dates':
      for (const d of Array.isArray(p.dates) ? p.dates : []) { if (!DATE.test(String(d))) return `วันที่ไม่ถูกต้อง: ${d}`; push(d); }
      out.sort(); break;
    default: return 'รูปแบบการจองไม่รู้จัก';
  }
  if (!out.length) return 'ไม่มีวันที่ตรงรูปแบบ';
  if (out.length > MAX_ITEMS) return `เกิน ${MAX_ITEMS} ครั้ง — แบ่งเป็นหลายชุด`;
  return out;
}

// ---------- รายละเอียดรายการ (ใช้ทั้งตารางห้อง คิว และรายการที่ชน) ----------
const RESV_COLS = 'reservation_id, location_id, kind, status, starts_at, ends_at, setup_minutes, teardown_minutes, schedule_id, section_id, course_id, semester_id, ' +
  'project_name, title, purpose, actual_user, decision_note, decided_at, series_id, replaces_id, pending_change, requested_by, created_at, ' +
  'requester:requested_by ( full_name, phone, email, line_id ), decider:decided_by ( full_name ), courses ( course_code, course_name ), ' +
  'lab_sections ( section_no ), locations ( name, room_code )';
function shape(r: any) {
  return {
    reservation_id: r.reservation_id, location_id: r.location_id, room: r.locations?.name ?? null, room_code: r.locations?.room_code ?? null,
    kind: r.kind, kind_th: KIND_TH[r.kind] ?? r.kind, status: r.status, status_th: STATUS_TH[r.status] ?? r.status,
    starts_at: r.starts_at, ends_at: r.ends_at, date: dayOf(r.starts_at), start: hm(r.starts_at), end: hm(r.ends_at),
    setup_minutes: r.setup_minutes, teardown_minutes: r.teardown_minutes,
    schedule_id: r.schedule_id, section_id: r.section_id, section_no: r.lab_sections?.section_no ?? null,
    course_id: r.course_id, semester_id: r.semester_id, course_code: r.courses?.course_code ?? null, course_name: r.courses?.course_name ?? null,
    project_name: r.project_name, title: r.title, purpose: r.purpose, actual_user: r.actual_user,
    requested_by: r.requested_by, requester: r.requester ? { full_name: r.requester.full_name, phone: r.requester.phone, email: r.requester.email, line_id: r.requester.line_id } : null,
    decider: r.decider?.full_name ?? null, decided_at: r.decided_at, decision_note: r.decision_note,
    series_id: r.series_id, replaces_id: r.replaces_id, pending_change: r.pending_change, created_at: r.created_at,
  };
}
async function details(ids: string[]) {
  if (!ids.length) return [];
  const { data } = await sb.from('room_reservations').select(RESV_COLS).in('reservation_id', ids);
  return (data ?? []).map(shape);
}
async function withContacts(conflictIds: string[], locIds: string[]) {
  const [list, contacts] = await Promise.all([details(conflictIds), roomContacts(sb, locIds)]);
  return { conflicts: list, room_contacts: Object.fromEntries(contacts) };
}

// ---------- แจ้งเตือน (ไม่ทำให้งานหลักล้ม) ----------
async function notifyUsers(userIds: string[], html: string) {
  if (!hasTelegram() || !userIds.length) return;
  try {
    const { data } = await sb.from('users').select('telegram_chat_id').in('user_id', [...new Set(userIds)]).not('telegram_chat_id', 'is', null);
    await Promise.all((data ?? []).map((u: any) => tgSend(u.telegram_chat_id, html).catch((e) => console.error('tg', String(e?.message ?? e)))));
  } catch (e) { console.error('notify', String((e as Error)?.message ?? e)); }
}

async function roomOf(locationId: string) {
  const { data } = await sb.from('locations').select('location_id, name, room_code, setup_minutes, teardown_minutes, room_status').eq('location_id', locationId).maybeSingle();
  return data;
}

// ---------- ตรวจชนสำหรับดูตัวอย่าง (ไม่บันทึก) ----------
async function previewItems(locationId: string, dates: string[], startT: string, endT: string, setup: number, tear: number) {
  const items = dates.map((d) => ({ date: d, starts_at: at(d, startT), ends_at: at(d, endT) }));
  const lo = new Date(new Date(items[0].starts_at).getTime() - setup * 60000 - 86400000).toISOString();
  const hi = new Date(new Date(items[items.length - 1].ends_at).getTime() + tear * 60000 + 86400000).toISOString();
  const [{ data: ex }, { data: hol }] = await Promise.all([
    sb.from('room_reservations').select(RESV_COLS).eq('location_id', locationId).in('status', ['pending', 'approved']).gte('ends_at', lo).lte('starts_at', hi),
    sb.from('term_holidays').select('holiday_date, name').in('holiday_date', dates),
  ]);
  const holMap = new Map<string, string>((hol ?? []).map((h: any): [string, string] => [h.holiday_date, h.name]));
  return items.map((it) => {
    const b0 = new Date(it.starts_at).getTime() - setup * 60000, b1 = new Date(it.ends_at).getTime() + tear * 60000;
    const hits = (ex ?? []).filter((r: any) => {
      const r0 = new Date(r.starts_at).getTime() - r.setup_minutes * 60000, r1 = new Date(r.ends_at).getTime() + r.teardown_minutes * 60000;
      return r0 < b1 && r1 > b0;
    }).map(shape);
    return { ...it, weekday_th: thDay(it.date), holiday: holMap.get(it.date) ?? null, conflicts: hits, has_approved_conflict: hits.some((h) => h.status === 'approved') };
  });
}

function isPast(iso: string) { return new Date(iso).getTime() < Date.now(); }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);
  const me = await authStaff(sb, req);
  if (me instanceof Response) return me;
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }
  const isAdmin = me.role === 'admin';

  try {
    switch (body.action) {
      // ---------------- ตารางห้อง ----------------
      case 'rooms_board': {
        const date = DATE.test(String(body.date)) ? String(body.date) : bkkDate(new Date());
        const days = Math.max(1, Math.min(14, Number(body.days) || 1));
        const end = addDay(date, days);
        let rq = sb.from('locations').select('location_id, name, room_code, building, floor, zone_id, setup_minutes, teardown_minutes, room_status, note, zones ( name, building, floor, sort_order )').order('name');
        if (body.zone_id) rq = rq.eq('zone_id', body.zone_id);
        const [{ data: rooms }, { data: zones }] = await Promise.all([rq, sb.from('zones').select('*').order('sort_order').order('name')]);
        const locIds = (rooms ?? []).map((r: any) => r.location_id);
        const [{ data: resv }, contacts, idx] = await Promise.all([
          locIds.length ? sb.from('room_reservations').select(RESV_COLS).in('location_id', locIds).in('status', ['pending', 'approved'])
            .lt('starts_at', at(end, '00:00')).gt('ends_at', at(date, '00:00')).order('starts_at') : Promise.resolve({ data: [] }),
          roomContacts(sb, locIds),
          approverIndex(locIds),
        ]);
        return json({ data: {
          date, days, zones: zones ?? [],
          rooms: (rooms ?? []).map((r: any) => ({ ...r, zone: r.zones?.name ?? null, zones: undefined, contacts: contacts.get(r.location_id) ?? [], can_approve: isAdmin || idx.can(me.user_id, r.location_id, date) })),
          reservations: (resv ?? []).map(shape),
        } });
      }

      case 'free_rooms': {
        const s = String(body.starts_at ?? ''), e = String(body.ends_at ?? '');
        if (isNaN(Date.parse(s)) || isNaN(Date.parse(e)) || Date.parse(e) <= Date.parse(s)) return fail('BAD_REQUEST', 'ช่วงเวลาไม่ถูกต้อง', 400);
        const [{ data: rooms }, { data: busy }] = await Promise.all([
          sb.from('locations').select('location_id, name, room_code, zone_id, setup_minutes, teardown_minutes, zones ( name )').eq('room_status', 'active').order('name'),
          sb.from('room_reservations').select('location_id, starts_at, ends_at, setup_minutes, teardown_minutes').in('status', ['pending', 'approved'])
            .lt('starts_at', new Date(Date.parse(e) + 600 * 60000).toISOString()).gt('ends_at', new Date(Date.parse(s) - 600 * 60000).toISOString()),
        ]);
        const free = (rooms ?? []).filter((r: any) => {
          const b0 = Date.parse(s) - r.setup_minutes * 60000, b1 = Date.parse(e) + r.teardown_minutes * 60000;
          return !(busy ?? []).some((x: any) => x.location_id === r.location_id && Date.parse(x.starts_at) - x.setup_minutes * 60000 < b1 && Date.parse(x.ends_at) + x.teardown_minutes * 60000 > b0);
        }).map((r: any) => ({ location_id: r.location_id, name: r.name, room_code: r.room_code, zone: r.zones?.name ?? null }));
        return json({ data: { rooms: free } });
      }

      // ---------------- ขอจอง ----------------
      case 'request_preview':
      case 'request_create': {
        const room = await roomOf(String(body.location_id ?? ''));
        if (!room) return fail('NOT_FOUND', 'ไม่พบห้อง', 404);
        const startT = String(body.start_time ?? ''), endT = String(body.end_time ?? '');
        if (!TIME.test(startT) || !TIME.test(endT) || endT <= startT) return fail('BAD_REQUEST', 'เวลาเริ่ม/เลิกไม่ถูกต้อง (HH:MM)', 400);
        const expanded = expandPattern(body.pattern);
        if (typeof expanded === 'string') return fail('BAD_REQUEST', expanded, 400);
        const setup = mins(body.setup_minutes, room.setup_minutes), tear = mins(body.teardown_minutes, room.teardown_minutes);
        const idx = await approverIndex([room.location_id]);
        const preview = await previewItems(room.location_id, expanded, startT, endT, setup, tear);
        const canOverride = isAdmin || expanded.every((d) => idx.can(me.user_id, room.location_id, d));
        if (body.action === 'request_preview') {
          return json({ data: {
            room, setup_minutes: setup, teardown_minutes: tear, items: preview, can_override: canOverride,
            counts: { total: preview.length, conflict: preview.filter((p) => p.conflicts.length).length, holiday: preview.filter((p) => p.holiday).length },
            room_contacts: (await roomContacts(sb, [room.location_id])).get(room.location_id) ?? [],
          } });
        }

        // บันทึก
        const kind = String(body.kind ?? '');
        if (CLASS_KINDS.includes(kind)) return fail('BAD_REQUEST', 'คาบเรียน/ชดเชย สร้างผ่านตั้งค่าเทอมหรือเปลี่ยนคาบ', 400);
        if (!OPEN_KINDS.includes(kind)) return fail('BAD_REQUEST', 'ประเภทการจองไม่ถูกต้อง', 400);
        if (room.room_status === 'closed' && kind !== 'maintenance') return fail('ROOM_CLOSED', 'ห้องนี้ปิดใช้งาน', 400);
        const courseId = body.course_id ? String(body.course_id) : null, semesterId = body.semester_id ? String(body.semester_id) : null;
        const project = String(body.project_name ?? '').trim().slice(0, 200) || null;
        if (kind !== 'maintenance' && !courseId && !project) return fail('BAD_REQUEST', 'ระบุรายวิชา หรือชื่อโครงการ/บริการ (ใช้คิดต้นทุน)', 400);
        if (courseId && !semesterId) return fail('BAD_REQUEST', 'ระบุเทอมของรายวิชา', 400);
        const chosen = Array.isArray(body.dates) ? new Set(body.dates.map(String)) : null;
        const items = preview.filter((p) => (!chosen || chosen.has(p.date)) && !isPast(p.starts_at));
        if (!items.length) return fail('BAD_REQUEST', 'ไม่มีครั้งที่จะส่ง (ติ๊กออกหมด หรือเป็นเวลาที่ผ่านมาแล้ว)', 400);
        const override = body.override === true;
        if (override && !canOverride) return fail('FORBIDDEN', 'แทรกคำขอที่รออนุมัติได้เฉพาะผู้ดูแลห้องหรือแอดมิน', 403);

        const { data: res, error } = await sb.rpc('booking_request', { p: {
          location_id: room.location_id, kind, setup_minutes: setup, teardown_minutes: tear, requested_by: me.user_id,
          course_id: courseId, semester_id: semesterId, project_name: project,
          title: String(body.title ?? '').trim().slice(0, 200) || null, purpose: String(body.purpose ?? '').trim().slice(0, 1000) || null,
          actual_user: String(body.actual_user ?? '').trim().slice(0, 200) || null,
          override, override_note: String(body.override_note ?? '').slice(0, 300),
          series: { title: String(body.title ?? '') || KIND_TH[kind], pattern: { ...body.pattern, start_time: startT, end_time: endT } },
          items: items.map((p) => ({ starts_at: p.starts_at, ends_at: p.ends_at, approve: isAdmin || idx.can(me.user_id, room.location_id, p.date) })),
        } });
        if (error) throw error;
        const results = (res?.results ?? []) as any[];
        const conflictIds = [...new Set(results.flatMap((r) => r.conflicts ?? []))] as string[];
        const extra = conflictIds.length ? await withContacts(conflictIds, [room.location_id]) : { conflicts: [], room_contacts: {} };
        // แจ้งผู้อนุมัติ (คำขอที่ยังรอ) · แจ้งผู้ถูกแทรก
        const pending = results.filter((r) => r.ok && r.status === 'pending');
        if (pending.length) {
          const first = dayOf(pending[0].starts_at);
          await notifyUsers(idx.who(room.location_id, first).filter((u) => u !== me.user_id),
            `🏷️ <b>คำขอจองห้อง ${esc(room.name)}</b>\n${esc(KIND_TH[kind])} · ${pending.length} ครั้ง เริ่ม ${esc(thDay(first))} ${esc(startT)}–${esc(endT)}\nโดย ${esc(me.full_name)}\nเปิดหน้าบุคลากร → คิวอนุมัติ`);
        }
        if ((res?.overridden ?? []).length) {
          const victims = await details(res.overridden);
          await notifyUsers(victims.map((v) => v.requested_by),
            `⚠️ <b>คำขอจองห้อง ${esc(room.name)} ถูกปฏิเสธ</b>\nผู้ดูแลห้องใช้ช่วงนี้${body.override_note ? ' — ' + esc(body.override_note) : ''}\nกรุณาขอห้อง/เวลาอื่น`);
        }
        return json({ data: {
          series_id: res?.series_id ?? null, results,
          counts: { sent: results.filter((r) => r.ok).length, approved: results.filter((r) => r.ok && r.status === 'approved').length, conflict: results.filter((r) => !r.ok).length, overridden: (res?.overridden ?? []).length },
          ...extra,
        } });
      }

      // ---------------- อนุมัติ / ปฏิเสธ ----------------
      case 'decide': {
        const approve = body.approve === true;
        let q = sb.from('room_reservations').select('reservation_id, location_id, starts_at, status, pending_change, requested_by, series_id');
        if (body.series_id) q = q.eq('series_id', String(body.series_id));
        else if (Array.isArray(body.reservation_ids) && body.reservation_ids.length) q = q.in('reservation_id', body.reservation_ids.slice(0, 500).map(String));
        else return fail('BAD_REQUEST', 'ระบุรายการหรือชุด', 400);
        const { data: rows } = await q;
        const open = (rows ?? []).filter((r: any) => r.status === 'pending' || (r.status === 'approved' && r.pending_change));
        if (!open.length) return fail('NOTHING_TO_DECIDE', 'ไม่มีรายการที่รอการตัดสิน', 400);
        const idx = await approverIndex(open.map((r: any) => r.location_id));
        const dateOf = (r: any) => dayOf(r.pending_change?.starts_at ?? r.starts_at);
        const allowed = open.filter((r: any) => isAdmin || idx.can(me.user_id, r.location_id, dateOf(r)));
        const denied = open.length - allowed.length;
        if (!allowed.length) return fail('FORBIDDEN', 'ไม่มีสิทธิ์อนุมัติห้องนี้ในวันดังกล่าว', 403);
        const note = String(body.note ?? '').trim().slice(0, 500) || null;
        if (!approve && !note) return fail('BAD_REQUEST', 'ปฏิเสธต้องระบุเหตุผล', 400);
        const { data: res, error } = await sb.rpc('booking_decide', { p_ids: allowed.map((r: any) => r.reservation_id), p_approve: approve, p_by: me.user_id, p_note: note });
        if (error) throw error;
        const list = (res ?? []) as any[];
        // แจ้งผู้ขอ
        const byReq = new Map<string, number>();
        for (const r of allowed) if (r.requested_by !== me.user_id) byReq.set(r.requested_by, (byReq.get(r.requested_by) ?? 0) + 1);
        const sample = (await details([allowed[0].reservation_id]))[0];
        for (const [u, n] of byReq) {
          await notifyUsers([u], `${approve ? '✅' : '❌'} <b>${approve ? 'อนุมัติ' : 'ไม่อนุมัติ'}การจองห้อง ${esc(sample?.room ?? '')}</b>\n${n} รายการ เริ่ม ${esc(thDay(sample?.date ?? ''))} ${esc(sample?.start ?? '')}–${esc(sample?.end ?? '')}\nโดย ${esc(me.full_name)}${note ? '\nเหตุผล: ' + esc(note) : ''}`);
        }
        return json({ data: { results: list, counts: { ok: list.filter((r) => r.ok).length, failed: list.filter((r) => !r.ok).length, denied } } });
      }

      // ---------------- ย้าย / แก้เวลา ----------------
      case 'change': {
        const [cur] = await details([String(body.reservation_id ?? '')]);
        if (!cur) return fail('NOT_FOUND', 'ไม่พบการจอง', 404);
        if (CLASS_KINDS.includes(cur.kind)) return fail('USE_SESSION_CHANGE', 'คาบเรียน/ชดเชย เลื่อนหรือย้ายผ่านหน้าคาบ', 400);
        if (!['pending', 'approved'].includes(cur.status)) return fail('BAD_REQUEST', 'รายการนี้ไม่ได้ใช้งานแล้ว', 400);
        const locId = String(body.location_id || cur.location_id);
        const idxAll = await approverIndex([cur.location_id, locId]);
        const mineOrRight = isAdmin || cur.requested_by === me.user_id || idxAll.can(me.user_id, cur.location_id, cur.date);
        if (!mineOrRight) return fail('FORBIDDEN', 'แก้ได้เฉพาะผู้ขอ ผู้ดูแลห้อง หรือแอดมิน', 403);
        const s = String(body.starts_at ?? ''), e = String(body.ends_at ?? '');
        if (isNaN(Date.parse(s)) || isNaN(Date.parse(e)) || Date.parse(e) <= Date.parse(s)) return fail('BAD_REQUEST', 'เวลาไม่ถูกต้อง', 400);
        if (isPast(s)) return fail('BAD_REQUEST', 'ย้ายไปเวลาที่ผ่านมาแล้วไม่ได้', 400);
        const auto = isAdmin || idxAll.can(me.user_id, locId, dayOf(s));
        const { data: res, error } = await sb.rpc('booking_change', {
          p_id: cur.reservation_id, p_location: locId, p_starts: new Date(s).toISOString(), p_ends: new Date(e).toISOString(),
          p_setup: body.setup_minutes == null || body.setup_minutes === '' ? null : mins(body.setup_minutes, 0),
          p_teardown: body.teardown_minutes == null || body.teardown_minutes === '' ? null : mins(body.teardown_minutes, 0),
          p_by: me.user_id, p_auto: auto,
        });
        if (error) throw error;
        if (!res?.ok) {
          if (res?.result === 'conflict') return fail('ROOM_CONFLICT', 'ช่วงเวลานี้มีการจองอยู่แล้ว', 409, await withContacts(res.conflicts ?? [], [locId]));
          return fail('BAD_REQUEST', `แก้ไม่ได้ (${res?.result})`, 400);
        }
        if (!auto) {
          const room = await roomOf(locId);
          await notifyUsers(idxAll.who(locId, dayOf(s)), `🔁 <b>คำขอเปลี่ยนการจอง ${esc(room?.name ?? '')}</b>\n${esc(thDay(dayOf(s)))} ${esc(hm(s))}–${esc(hm(e))} โดย ${esc(me.full_name)}`);
        }
        return json({ data: res });
      }

      // ---------------- ยกเลิก ----------------
      case 'cancel': {
        const [cur] = await details([String(body.reservation_id ?? '')]);
        if (!cur) return fail('NOT_FOUND', 'ไม่พบการจอง', 404);
        if (CLASS_KINDS.includes(cur.kind)) return fail('USE_SESSION_CHANGE', 'คาบเรียน/ชดเชย งดผ่านหน้าคาบ', 400);
        const idx = await approverIndex([cur.location_id]);
        if (!(isAdmin || cur.requested_by === me.user_id || idx.can(me.user_id, cur.location_id, cur.date))) return fail('FORBIDDEN', 'ยกเลิกได้เฉพาะผู้ขอ ผู้ดูแลห้อง หรือแอดมิน', 403);
        const scope = ['this', 'following', 'all'].includes(body.scope) ? body.scope : 'this';
        let ids = [cur.reservation_id];
        if (scope !== 'this' && cur.series_id) {
          let q = sb.from('room_reservations').select('reservation_id').eq('series_id', cur.series_id).in('status', ['pending', 'approved']).gt('starts_at', new Date().toISOString());
          if (scope === 'following') q = q.gte('starts_at', cur.starts_at);
          const { data } = await q;
          ids = [...new Set([cur.reservation_id, ...(data ?? []).map((r: any) => r.reservation_id)])];
        }
        const { data: n, error } = await sb.rpc('booking_cancel', { p_ids: ids, p_by: me.user_id, p_note: String(body.note ?? '').slice(0, 300) || null });
        if (error) throw error;
        if (cur.requested_by !== me.user_id) await notifyUsers([cur.requested_by], `🚫 <b>การจองห้อง ${esc(cur.room)} ถูกยกเลิก</b> ${n} รายการ โดย ${esc(me.full_name)}`);
        return json({ data: { cancelled: n } });
      }

      // ---------------- คิวอนุมัติ ----------------
      case 'queue': {
        const since = new Date(Date.now() - 86400000).toISOString();
        const { data } = await sb.from('room_reservations').select(RESV_COLS)
          .or('status.eq.pending,and(status.eq.approved,pending_change.not.is.null)').gte('ends_at', since).order('starts_at').limit(2000);
        const rows = (data ?? []).map(shape);
        const idx = await approverIndex(rows.map((r) => r.location_id));
        const mine = isAdmin ? rows : rows.filter((r) => idx.can(me.user_id, r.location_id, r.pending_change ? dayOf(r.pending_change.starts_at) : r.date));
        // จัดกลุ่มตามชุด (คลิกเดียวอนุมัติทั้งชุด)
        const groups = new Map<string, any>();
        for (const r of mine) {
          const k = r.series_id ?? r.reservation_id;
          const g = groups.get(k) ?? { key: k, series_id: r.series_id, room: r.room, location_id: r.location_id, kind_th: r.kind_th, course_code: r.course_code, project_name: r.project_name, requester: r.requester, first: r.date, items: [] as any[] };
          g.items.push(r); groups.set(k, g);
        }
        return json({ data: { groups: [...groups.values()], total: mine.length } });
      }

      case 'mine': {
        const { data } = await sb.from('room_reservations').select(RESV_COLS).eq('requested_by', me.user_id)
          .gte('ends_at', new Date(Date.now() - 7 * 86400000).toISOString()).order('starts_at').limit(1000);
        return json({ data: { reservations: (data ?? []).map(shape) } });
      }

      // ---------------- แดชบอร์ดการจองต้นเทอม (B6) ----------------
      case 'dashboard': {
        const today = bkkDate(new Date());
        let semId = body.semester_id ? String(body.semester_id) : null;
        if (!semId) {
          const { data: terms } = await sb.from('semesters').select('semester_id, start_date, end_date').order('start_date', { ascending: false });
          semId = ((terms ?? []).find((t: any) => t.start_date <= today && t.end_date >= today) ?? (terms ?? []).find((t: any) => t.start_date > today) ?? terms?.[0])?.semester_id ?? null;
        }
        if (!semId) return json({ data: { courses: [] } });
        const { data: secs } = await sb.from('lab_sections').select('section_id, section_no, course_id, courses ( course_code, course_name )').eq('semester_id', semId);
        const secIds = (secs ?? []).map((s: any) => s.section_id);
        const courseIds = [...new Set((secs ?? []).map((s: any) => s.course_id))] as string[];
        const sch: any[] = [];
        for (let i = 0; i < secIds.length; i += 100) {
          const { data } = await sb.from('schedules').select('schedule_id, section_id, class_date, location_id').in('section_id', secIds.slice(i, i + 100)).eq('status', 'scheduled').limit(10000);
          sch.push(...(data ?? []));
        }
        const resv: any[] = [];
        const schIds = sch.map((s) => s.schedule_id);
        for (let i = 0; i < schIds.length; i += 300) {
          const { data } = await sb.from('room_reservations').select('schedule_id, location_id, status, locations ( zones ( name ) )').in('schedule_id', schIds.slice(i, i + 300)).in('status', ['pending', 'approved']);
          resv.push(...(data ?? []));
        }
        const { data: settings } = courseIds.length ? await sb.from('course_term_settings').select('*').eq('semester_id', semId).in('course_id', courseIds) : { data: [] };
        const setMap = new Map<string, any>((settings ?? []).map((s: any): [string, any] => [s.course_id, s]));
        const bySch = new Map<string, any[]>();
        for (const r of resv) { const a = bySch.get(r.schedule_id) ?? []; a.push(r); bySch.set(r.schedule_id, a); }
        const secCourse = new Map<string, any>((secs ?? []).map((s: any): [string, any] => [s.section_id, s]));
        const out = courseIds.map((cid) => {
          const c = (secs ?? []).find((s: any) => s.course_id === cid)?.courses;
          const list = sch.filter((s) => secCourse.get(s.section_id)?.course_id === cid);
          const st = setMap.get(cid);
          const reqLead = st ? st.request_lead_days : 14, apprLead = st ? st.approve_lead_days : 7;
          const first = st?.first_class_date ?? (list.length ? list.reduce((m, s) => (s.class_date < m ? s.class_date : m), list[0].class_date) : null);
          let approved = 0, pending = 0, none = 0;
          const pendingZones = new Map<string, number>();
          for (const s of list) {
            const rs = bySch.get(s.schedule_id) ?? [];
            const primary = rs.filter((r) => r.location_id === s.location_id);
            if (primary.some((r) => r.status === 'approved')) approved++;
            else if (primary.length) pending++;
            else none++;
            for (const r of rs.filter((x) => x.status === 'pending')) { const z = r.locations?.zones?.name ?? 'ไม่ระบุโซน'; pendingZones.set(z, (pendingZones.get(z) ?? 0) + 1); }
          }
          const status = !list.length ? 'no_sessions' : approved === list.length ? 'complete' : none === list.length ? 'not_sent' : none ? 'incomplete' : 'pending';
          const reqDue = first && reqLead != null ? addDay(first, -reqLead) : null;
          const apprDue = first && apprLead != null ? addDay(first, -apprLead) : null;
          return {
            course_id: cid, course_code: c?.course_code, course_name: c?.course_name, first_class_date: first, first_class_custom: !!st?.first_class_date,
            request_lead_days: reqLead, approve_lead_days: apprLead, request_due: reqDue, approve_due: apprDue,
            sessions: list.length, approved, pending, none, status, pending_zones: Object.fromEntries(pendingZones),
            request_overdue: !!reqDue && today > reqDue && (status === 'not_sent' || status === 'incomplete'),
            approve_overdue: !!apprDue && today > apprDue && status !== 'complete' && status !== 'no_sessions',
            next_due: status === 'complete' ? null : (status === 'not_sent' || status === 'incomplete' ? reqDue : apprDue),
          };
        }).sort((a, b) => (a.status === 'complete' ? 1 : 0) - (b.status === 'complete' ? 1 : 0) || String(a.next_due ?? '9999').localeCompare(String(b.next_due ?? '9999')) || String(a.course_code).localeCompare(String(b.course_code)));
        return json({ data: { semester_id: semId, today, courses: out } });
      }

      case 'settings_save': {
        const courseId = String(body.course_id ?? ''), semId = String(body.semester_id ?? '');
        if (!(await isCourseOwner(sb, me, courseId, semId))) return fail('FORBIDDEN', 'ตั้งได้เฉพาะผู้ตั้งรายวิชาหรือแอดมิน', 403);
        const lead = (v: unknown) => (v === null || v === '' ? null : Math.max(0, Math.min(365, Math.round(Number(v)))));
        const row = {
          course_id: courseId, semester_id: semId, request_lead_days: lead(body.request_lead_days), approve_lead_days: lead(body.approve_lead_days),
          first_class_date: DATE.test(String(body.first_class_date ?? '')) ? body.first_class_date : null, updated_by: me.user_id, updated_at: new Date().toISOString(),
        };
        if ([row.request_lead_days, row.approve_lead_days].some((x) => x !== null && Number.isNaN(x))) return fail('BAD_REQUEST', 'จำนวนวันไม่ถูกต้อง', 400);
        const { data, error } = await sb.from('course_term_settings').upsert(row, { onConflict: 'course_id,semester_id' }).select().single();
        if (error) throw error;
        return json({ data });
      }

      // ---------------- สถานะไม่อยู่ของผู้ดูแลห้อง ----------------
      case 'away_list': {
        let q = sb.from('user_away').select('away_id, user_id, from_date, to_date, note, users ( full_name )').gte('to_date', bkkDate(new Date())).order('from_date');
        if (!isAdmin) q = q.eq('user_id', me.user_id);
        const { data } = await q;
        return json({ data: { away: data ?? [] } });
      }
      case 'away_save': {
        const from = String(body.from_date ?? ''), to = String(body.to_date ?? '');
        if (!DATE.test(from) || !DATE.test(to) || to < from) return fail('BAD_REQUEST', 'ช่วงวันที่ไม่ถูกต้อง', 400);
        const uid = isAdmin && body.user_id ? String(body.user_id) : me.user_id;
        const { data, error } = await sb.from('user_away').insert({ user_id: uid, from_date: from, to_date: to, note: String(body.note ?? '').slice(0, 200) || null }).select().single();
        if (error) throw error;
        return json({ data });
      }
      case 'away_delete': {
        let q = sb.from('user_away').delete().eq('away_id', String(body.away_id ?? ''));
        if (!isAdmin) q = q.eq('user_id', me.user_id);
        const { error } = await q;
        if (error) throw error;
        return json({ data: { ok: true } });
      }

      default:
        return fail('BAD_REQUEST', 'action ไม่รู้จัก', 400);
    }
  } catch (err) {
    console.error(err);
    return fail('INTERNAL_ERROR', String((err as Error)?.message ?? err), 500);
  }
});
