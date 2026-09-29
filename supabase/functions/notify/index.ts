// POST /functions/v1/notify   — เรียกโดย pg_cron ทุก 1 นาที (ดู migration 008)
// ยืนยันตัวด้วย header x-cron-secret = app_settings.cron_secret  (deploy ด้วย verify_jwt: false)
//
// body: { action: 'tick', now?: ISO (ทดสอบ), dry_run?: boolean }
//   - ครบเกณฑ์สายหลังเริ่มคาบ → ส่งสรุประหว่างคาบเข้ากลุ่ม Telegram ที่เปิดไว้
//   - จบคาบ → ใส่ "ขาด" ให้คนที่ยังไม่เช็ค (ถ้ากลุ่มเรียนเปิด auto_absent) แล้วส่งสรุปจบคาบ
//   - ทุกงานบันทึกใน notification_logs (unique กันส่งซ้ำ)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { tick } from '../_shared/notify-core.ts';

function getServiceRoleKey(): string {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) { try { const p = JSON.parse(raw); if (p?.default) return p.default; } catch { /* ใช้ของเดิม */ } }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, getServiceRoleKey());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let cachedSecret: string | null = null;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!cachedSecret) {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'cron_secret').maybeSingle();
    cachedSecret = data?.value ?? null;
  }
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!cachedSecret || given !== cachedSecret) return json({ error: 'FORBIDDEN' }, 403);

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* ใช้ค่าเริ่มต้น */ }
  const now = body.now ? new Date(body.now) : new Date();
  if (isNaN(now.getTime())) return json({ error: 'BAD_NOW' }, 400);

  try {
    const result = await tick(supabase, now, { dryRun: !!body.dry_run });
    if (result.jobs) console.log(JSON.stringify(result.done.map(({ preview, ...r }: any) => r)));
    return json({ data: result });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
