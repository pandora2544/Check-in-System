// ใช้ร่วมกันระหว่าง notify (cron) และ staff (ปุ่ม "ส่งสรุปตอนนี้")
// - buildSummary: ข้อความสรุปการเช็คชื่อของคาบ (Telegram HTML)
// - markAbsent:  ใส่ "ขาด" ให้คนที่ยังไม่มีรายการเช็คชื่อ
// - tgSend:      ส่งข้อความเข้า Telegram (token จาก secret TELEGRAM_BOT_TOKEN)
// - tick:        งานที่ cron เรียกทุก 1 นาที

// deno-lint-ignore-file no-explicit-any
type SB = any;

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
export const hasTelegram = () => TOKEN.length > 0;

export const bkkDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
export const at = (date: string, time: string) => new Date(`${date}T${time.length === 5 ? time + ':00' : time}+07:00`);
const hhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const thDate = (d: Date) => new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function tg(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? res.status}`);
  return j.result;
}
export const scrub = (msg: string) => (TOKEN ? msg.split(TOKEN).join('***') : msg);

export async function tgSend(chatId: string, html: string) {
  const r = await tg('sendMessage', { chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });
  return r.message_id as number;
}

async function loadSchedule(sb: SB, scheduleId: string) {
  const { data: sc } = await sb.from('schedules')
    .select('schedule_id, section_id, class_date, start_time, end_time, status, locations ( name ), lab_sections ( section_no, late_threshold_minutes, auto_absent, courses ( course_code, course_name ) )')
    .eq('schedule_id', scheduleId).maybeSingle();
  return sc;
}

export async function markAbsent(sb: SB, scheduleId: string) {
  const sc = await loadSchedule(sb, scheduleId);
  if (!sc) return 0;
  const [{ data: enr }, { data: att }] = await Promise.all([
    sb.from('section_enrollments').select('student_id').eq('section_id', sc.section_id),
    sb.from('attendance_records').select('student_id').eq('schedule_id', scheduleId),
  ]);
  const has = new Set((att ?? []).map((a: any) => a.student_id));
  const missing = (enr ?? []).map((e: any) => e.student_id).filter((id: string) => !has.has(id));
  if (missing.length === 0) return 0;
  const endIso = at(sc.class_date, sc.end_time).toISOString();
  const { data, error } = await sb.from('attendance_records').upsert(
    missing.map((student_id: string) => ({
      student_id, schedule_id: scheduleId, status: 'absent', check_in_time: endIso,
      device_id: 'auto', is_manual: false, marked_at: new Date().toISOString(),
    })),
    { onConflict: 'student_id,schedule_id', ignoreDuplicates: true },
  ).select('attendance_id');
  if (error) throw error;
  return (data ?? []).length;
}

export type SummaryKind = 'mid' | 'end' | 'now';

export async function buildSummary(sb: SB, scheduleId: string, kind: SummaryKind, now = new Date()) {
  const sc = await loadSchedule(sb, scheduleId);
  if (!sc) throw new Error('schedule not found');
  const sec = sc.lab_sections ?? {};
  const [{ data: enr }, { data: att }] = await Promise.all([
    sb.from('section_enrollments').select('student_id, students ( student_code, users ( full_name ) )').eq('section_id', sc.section_id),
    sb.from('attendance_records').select('student_id, status, check_in_time, check_out_time, left_early').eq('schedule_id', scheduleId),
  ]);
  const byId = new Map((att ?? []).map((a: any) => [a.student_id, a]));
  const people = (enr ?? []).map((e: any) => ({
    code: e.students?.student_code ?? '', name: e.students?.users?.full_name ?? '', a: byId.get(e.student_id) as any,
  })).sort((x: any, y: any) => String(x.code).localeCompare(String(y.code)));

  const count = (st: string) => people.filter((p: any) => p.a?.status === st).length;
  const c = { present: count('present'), late: count('late'), excused: count('excused'), absent: count('absent') };
  const none = people.filter((p: any) => !p.a);
  const attended = people.filter((p: any) => p.a && (p.a.status === 'present' || p.a.status === 'late'));
  const out = attended.filter((p: any) => p.a.check_out_time);
  const early = attended.filter((p: any) => p.a.left_early);

  const start = at(sc.class_date, sc.start_time), end = at(sc.class_date, sc.end_time);
  const head = kind === 'mid' ? `🕐 <b>สรุปหลังเริ่มคาบ ${sec.late_threshold_minutes ?? 15} นาที</b>`
    : kind === 'end' ? '🏁 <b>สรุปจบคาบ</b>'
    : `📊 <b>สถานะ ณ ${hhmm(now)} น.</b>`;

  const L: string[] = [
    `📋 <b>${esc(sec.courses?.course_code)} กลุ่ม ${esc(sec.section_no)}</b> · ${esc(sec.courses?.course_name)}`,
    `📅 ${esc(thDate(start))} · ${hhmm(start)}–${hhmm(end)} · 📍 ${esc(sc.locations?.name ?? '-')}`,
    '',
    head,
    `✅ มา ${c.present} · ⏰ สาย ${c.late} · 📝 ลา ${c.excused} · ❌ ขาด ${c.absent}` + (none.length ? ` · ⬜ ยังไม่เช็ค ${none.length}` : ''),
    `👥 รวม ${people.length} คน`,
  ];
  if (kind !== 'mid' && attended.length) L.push(`🚪 สแกนออกแล้ว ${out.length}/${attended.length}` + (early.length ? ` · ออกก่อนเวลา ${early.length}` : ''));

  const list = (title: string, arr: any[], extra?: (p: any) => string) => {
    if (!arr.length) return;
    const MAX = 40;
    L.push('', `<b>${title} (${arr.length})</b>`);
    for (const p of arr.slice(0, MAX)) L.push(`• ${esc(p.code)} ${esc(p.name)}${extra ? extra(p) : ''}`);
    if (arr.length > MAX) L.push(`…และอีก ${arr.length - MAX} คน`);
  };
  list('ยังไม่เช็คชื่อ', none);
  if (kind !== 'mid') {
    list('ขาด', people.filter((p: any) => p.a?.status === 'absent'));
    list('สาย', people.filter((p: any) => p.a?.status === 'late'), (p) => p.a.check_in_time ? ` (${hhmm(new Date(p.a.check_in_time))})` : '');
    list('ออกก่อนเวลา', early, (p) => ` (${hhmm(new Date(p.a.check_out_time))})`);
  }
  return { text: L.join('\n'), section_id: sc.section_id, counts: { ...c, none: none.length, total: people.length } };
}

// ---------- cron tick ----------
type Job = { schedule_id: string; type: 'mid_class_15min' | 'end_of_class' | 'auto_absent'; channel: 'telegram' | 'system'; chat: string };

async function claim(sb: SB, j: Job) {
  const { data, error } = await sb.from('notification_logs').upsert({
    schedule_id: j.schedule_id, notification_type: j.type, channel: j.channel, recipient_chat_id: j.chat, status: 'pending',
  }, { onConflict: 'schedule_id,notification_type,channel,recipient_chat_id', ignoreDuplicates: true }).select('notification_id');
  if (error) throw error;
  return data?.[0]?.notification_id as string | undefined;
}
const finish = (sb: SB, id: string, patch: Record<string, unknown>) =>
  sb.from('notification_logs').update({ sent_at: new Date().toISOString(), ...patch }).eq('notification_id', id);

const SEND_GRACE_MIN = 20;        // ส่งสรุปจบคาบได้ไม่เกิน 20 นาทีหลังจบ (กันส่งย้อนหลังตอนเพิ่งเปิดสวิตช์)
const ABSENT_GRACE_H = 6;         // ตัดขาดย้อนหลังได้ไม่เกิน 6 ชม.

export async function tick(sb: SB, now = new Date(), opts: { dryRun?: boolean } = {}) {
  const days = [bkkDate(new Date(now.getTime() - 86400_000)), bkkDate(now)];
  const [{ data: sch }, { data: chans }] = await Promise.all([
    sb.from('schedules').select('schedule_id, section_id, class_date, start_time, end_time, lab_sections ( late_threshold_minutes, auto_absent )')
      .eq('status', 'scheduled').in('class_date', days),
    sb.from('telegram_channels').select('section_id, chat_id, notify_mid, notify_end').eq('is_active', true),
  ]);

  const jobs: Job[] = [];
  for (const s of sch ?? []) {
    const start = at(s.class_date, s.start_time), end = at(s.class_date, s.end_time);
    const lateAt = new Date(start.getTime() + (s.lab_sections?.late_threshold_minutes ?? 15) * 60000);
    const mine = (chans ?? []).filter((c: any) => c.section_id === s.section_id);
    const t = now.getTime();
    if (t >= lateAt.getTime() && t < end.getTime())
      for (const c of mine) if (c.notify_mid) jobs.push({ schedule_id: s.schedule_id, type: 'mid_class_15min', channel: 'telegram', chat: c.chat_id });
    if (t >= end.getTime() && t < end.getTime() + ABSENT_GRACE_H * 3600_000 && s.lab_sections?.auto_absent)
      jobs.push({ schedule_id: s.schedule_id, type: 'auto_absent', channel: 'system', chat: '' });
    if (t >= end.getTime() && t < end.getTime() + SEND_GRACE_MIN * 60000)
      for (const c of mine) if (c.notify_end) jobs.push({ schedule_id: s.schedule_id, type: 'end_of_class', channel: 'telegram', chat: c.chat_id });
  }
  if (jobs.length === 0) return { jobs: 0, done: [] };

  // ข้ามงานที่เคยทำแล้ว (ไม่ต้อง upsert ซ้ำทุกนาที)
  const { data: logs } = await sb.from('notification_logs').select('schedule_id, notification_type, channel, recipient_chat_id')
    .in('schedule_id', [...new Set(jobs.map((j) => j.schedule_id))]);
  const seen = new Set((logs ?? []).map((l: any) => `${l.schedule_id}|${l.notification_type}|${l.channel}|${l.recipient_chat_id}`));
  const todo = jobs.filter((j) => !seen.has(`${j.schedule_id}|${j.type}|${j.channel}|${j.chat}`));
  // ตัดขาดก่อน แล้วค่อยสรุปจบคาบ เพื่อให้ตัวเลขตรง
  const order = { auto_absent: 0, mid_class_15min: 1, end_of_class: 2 };
  todo.sort((a, b) => order[a.type] - order[b.type]);

  const done: Record<string, unknown>[] = [];
  for (const j of todo) {
    if (opts.dryRun) {
      const preview = j.channel === 'telegram' ? (await buildSummary(sb, j.schedule_id, j.type === 'mid_class_15min' ? 'mid' : 'end', now)).text : null;
      done.push({ ...j, dry_run: true, preview });
      continue;
    }
    const id = await claim(sb, j);
    if (!id) continue; // อีก instance ทำไปแล้ว
    try {
      if (j.type === 'auto_absent') {
        const n = await markAbsent(sb, j.schedule_id);
        await finish(sb, id, { status: 'sent', message_content: `auto-absent ${n}` });
        done.push({ ...j, marked: n });
      } else {
        if (!hasTelegram()) throw new Error('TELEGRAM_BOT_TOKEN not set');
        const { text } = await buildSummary(sb, j.schedule_id, j.type === 'mid_class_15min' ? 'mid' : 'end', now);
        const mid = await tgSend(j.chat, text);
        await finish(sb, id, { status: 'sent', message_content: text });
        done.push({ ...j, message_id: mid });
      }
    } catch (e) {
      const msg = scrub(String((e as Error).message ?? e));
      await finish(sb, id, { status: 'failed', error: msg.slice(0, 500) });
      done.push({ ...j, error: msg });
    }
  }
  return { jobs: todo.length, done };
}
