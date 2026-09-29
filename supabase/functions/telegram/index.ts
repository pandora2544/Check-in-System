// POST /functions/v1/telegram   — เครื่องมือตั้งค่า Telegram bot (ช่วงทดสอบ ต้องใช้ dev_code)
// อ่าน token จาก secret TELEGRAM_BOT_TOKEN — ไม่ส่ง token กลับไปให้ใครเห็น
//
// actions:
//   me        ตรวจว่า token ใช้ได้ → ชื่อ bot / username
//   chats     แชท/กลุ่มที่ bot เพิ่งได้รับข้อความ (ใช้หา chat_id ของกลุ่มรายวิชา)
//   send      { chat_id, text }  ส่งข้อความทดสอบ

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function getServiceRoleKey(): string {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) { try { const p = JSON.parse(raw); if (p?.default) return p.default; } catch { /* ใช้ของเดิม */ } }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, getServiceRoleKey());
const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const fail = (code: string, message: string, status: number) => json({ data: null, error: { code, message } }, status);

async function tg(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? res.status}`);
  return j.result;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }

  const { data: setting } = await supabase.from('dev_settings').select('value').eq('key', 'dev_code').maybeSingle();
  if (!setting || String(body.dev_code ?? '') !== setting.value) {
    await new Promise((r) => setTimeout(r, 1500));
    return fail('FORBIDDEN', 'รหัสเครื่องมือทดสอบไม่ถูกต้อง', 403);
  }
  if (!TOKEN) return fail('NO_TOKEN', 'ยังไม่ได้ตั้ง secret TELEGRAM_BOT_TOKEN', 500);

  try {
    switch (body.action) {
      case 'me': {
        const me = await tg('getMe');
        return json({ data: { id: me.id, username: me.username, name: me.first_name, can_join_groups: me.can_join_groups, can_read_all_group_messages: me.can_read_all_group_messages } });
      }
      case 'chats': {
        const updates = await tg('getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member'] });
        const chats = new Map<number, Record<string, unknown>>();
        for (const u of updates) {
          const c = u.message?.chat ?? u.my_chat_member?.chat;
          if (c) chats.set(c.id, { chat_id: c.id, type: c.type, title: c.title ?? [c.first_name, c.last_name].filter(Boolean).join(' ') });
        }
        return json({ data: { chats: [...chats.values()] } });
      }
      case 'send': {
        const r = await tg('sendMessage', { chat_id: body.chat_id, text: String(body.text ?? '').slice(0, 4000) });
        return json({ data: { message_id: r.message_id } });
      }
      default:
        return fail('BAD_REQUEST', 'action ไม่รู้จัก', 400);
    }
  } catch (err) {
    return fail('TELEGRAM_ERROR', String((err as Error).message).replace(TOKEN, '***'), 502);
  }
});
