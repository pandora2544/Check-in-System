# Check-in System — ระบบเช็คชื่อเข้าเรียนแล็บ

สแกนใบหน้า (Human library, ประมวลผลในเบราว์เซอร์) + ตรวจตำแหน่ง GPS/QR ต่อห้อง

## Stack
- **GitHub** — เก็บโค้ด
- **Supabase** (`cph-smart-checkin`) — Postgres + Auth + Edge Functions
- **Vercel** — hosting หน้าเว็บ (`web/`)

## โครงสร้าง
| โฟลเดอร์ | เนื้อหา |
|---|---|
| `supabase/migrations/` | SQL schema ตามลำดับที่รันจริงบนโปรเจกต์ |
| `supabase/functions/checkin/` | Edge Function `POST /checkin` (verify_jwt: false) |
| `web/` | หน้าเว็บ PWA (ตอนนี้เป็น prototype) — Vercel deploy จากโฟลเดอร์นี้ |
| `docs/` | เอกสารออกแบบ, API spec, mockup, Context.md |

## ห้าม commit
คีย์ service role / secret keys — ตั้งเป็น Environment Variable ใน Vercel/Supabase เท่านั้น
