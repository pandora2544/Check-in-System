// ตัวช่วยที่ทุก Edge Function ใช้ซ้ำกัน (CORS, JSON response, service-role client, เวลาไทย)
// function เดิมยังมีสำเนาของตัวเองอยู่ — ย้ายมาใช้ไฟล์นี้ทีละตัวเมื่อแก้ครั้งถัดไป
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function serviceClient() {
  let key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) { try { const p = JSON.parse(raw); if (p?.default) key = p.default; } catch { /* ใช้ของเดิม */ } }
  return createClient(Deno.env.get('SUPABASE_URL')!, key);
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
export const fail = (code: string, message: string, status: number, extra: Record<string, unknown> = {}) =>
  json({ data: null, error: { code, message, ...extra } }, status);

// เวลาใน schedules เป็นเวลาไทย
export const bkkDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
export const bkkAt = (date: string, time: string) => new Date(`${date}T${time.length === 5 ? time + ':00' : time}+07:00`);
