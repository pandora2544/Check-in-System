# CSE-SMART-LAB — ระบบเช็คชื่อเข้าเรียนแล็บและบริหารงานแล็บ

สแกนใบหน้า (Human library, ประมวลผลในเบราว์เซอร์) + ตรวจตำแหน่ง GPS/QR ต่อห้อง

## Stack
- **GitHub** — เก็บโค้ด
- **Supabase** (`cph-smart-checkin`) — Postgres + Auth + Edge Functions
- **Vercel** — hosting หน้าเว็บ (`web/`)

## โครงสร้าง
| โฟลเดอร์ | เนื้อหา |
|---|---|
| `supabase/migrations/` | SQL schema ตามลำดับที่รันจริงบนโปรเจกต์ |
| `supabase/functions/` | Edge Functions (verify_jwt: false): `session` หาคาบที่กำลังเรียน, `enroll` ลงทะเบียนใบหน้า, `checkin` เช็คชื่อ, `dev-tools` เครื่องมือทดสอบ |
| `supabase/seed/` | ข้อมูลจำลองสำหรับทดสอบ + สคริปต์ลบ |
| `web/` | หน้าเว็บเช็คชื่อ (ต่อ Supabase จริง) — Vercel deploy จากโฟลเดอร์นี้ → https://cse-smart-lab.vercel.app (โดเมนเดิม cph-smart-checkin.vercel.app ยังใช้ได้) |
| `docs/` | เอกสารออกแบบ, API spec, mockup, Context.md |

## ห้าม commit
คีย์ service role / secret keys — ตั้งเป็น Environment Variable ใน Vercel/Supabase เท่านั้น

## ทดสอบ
ดู [docs/test-guide.md](docs/test-guide.md)
