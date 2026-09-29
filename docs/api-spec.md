# API Specification — ระบบเช็คชื่อเข้าเรียนแล็บ

> อ้างอิงคู่กับ `lab-attendance-system-design.md` (schema/workflow) และ `Context.md` (สถานะโปรเจกต์)

---

## หลักการทั่วไป (Conventions)

- **Base URL**: `https://api.<domain>/v1`
- **Auth**: Bearer JWT ออกโดย Supabase Auth ส่งมาใน header `Authorization: Bearer <token>` — เราไม่สร้างระบบ login เอง ใช้ Supabase Auth endpoints ตรงๆ (`/auth/v1/token`, `/auth/v1/signup`) แล้ว custom API ของเราตรวจ JWT + join กับตาราง `users` เพื่อดึง `role`
- **Response envelope**:
  ```json
  { "data": { ... }, "error": null }
  ```
  กรณี error:
  ```json
  { "data": null, "error": { "code": "OUT_OF_ZONE", "message": "อยู่นอกพื้นที่ที่กำหนด" } }
  ```
- **วันเวลา**: ISO 8601 ทั้งหมด (เช่น `2026-09-12T09:07:00+07:00`)
- **สิทธิ์ (role)**: `student` / `instructor` / `admin` — endpoint ระบุไว้ว่าใครเรียกได้บ้างในแต่ละหัวข้อ

**HTTP Status Codes ที่ใช้**: `200` สำเร็จ, `201` สร้างสำเร็จ, `400` ข้อมูลไม่ถูกต้อง, `401` ไม่ได้ล็อกอิน, `403` ไม่มีสิทธิ์, `404` ไม่พบ, `409` ขัดแย้ง (เช่น ห้องชนกัน), `422` ตรวจสอบเงื่อนไขไม่ผ่าน (เช่น นอกพื้นที่/ใบหน้าไม่ตรง)

---

## 1. Face Enrollment (`/students/{student_id}/face-template`)

**สิทธิ์**: `student` (ตัวเอง), `admin`

### `POST /students/{student_id}/face-template`
ลงทะเบียนใบหน้าครั้งแรก (ทำครั้งเดียวตอนต้นเทอม)

Request:
```json
{
  "embedding_vector": "base64-encoded-float-array",
  "model_version": "mediapipe-face-landmarker-v1",
  "device_info": "iPhone 13, iOS 17.4"
}
```
Response `201`:
```json
{ "data": { "template_id": "uuid", "enrolled_at": "2026-09-12T08:00:00+07:00" } }
```
หมายเหตุ: embedding คำนวณฝั่ง client แล้วส่งมาเฉพาะ vector (ไม่ส่งภาพ) ตาม 4.2 ในเอกสารออกแบบ ต้องมี consent flag ยืนยันมาด้วย (`consent_accepted: true`) ไม่งั้น `400`

### `GET /students/{student_id}/face-template/status`
เช็คว่าลงทะเบียนแล้วหรือยัง — ใช้ตอนเปิดแอปครั้งแรก
```json
{ "data": { "enrolled": true, "model_version": "mediapipe-face-landmarker-v1" } }
```

### `PUT /students/{student_id}/face-template`
Re-enroll (กรณีเปลี่ยนโมเดล embedding หรือหน้าเปลี่ยนมาก) — request/response เหมือน POST

### `DELETE /students/{student_id}/face-template`
ลบข้อมูลชีวมาตร (สิทธิ์ตาม PDPA) — `admin` เท่านั้น หรือ `student` ยื่นคำขอผ่านแอดมิน

---

## 2. Check-in Flow (`/checkin`)

**สิทธิ์**: `student` (ตัวเอง)

### `GET /checkin/current-session`
ดึงคาบเรียนที่กำลังเกิดขึ้น ณ ตำแหน่ง/เวลานี้ — **อิงตำแหน่ง ไม่ใช่ตัวนักศึกษา** เพราะยังไม่รู้ว่าเป็นใครจนกว่าจะสแกนหน้า (ไม่มีล็อกอิน — ดู 4.1 ของเอกสารออกแบบ)

Query params (ใช้อย่างใดอย่างหนึ่ง):
- `location_id` — ถ้าเข้าผ่าน QR ต่อห้อง (แม่นยำที่สุด แนะนำเป็นทางหลัก)
- `lat`, `lng` — ถ้าเข้าทางลิงก์ตรง/bookmark โดยไม่ผ่าน QR (อาจกำกวมถ้าห้องอยู่ใกล้กัน)

Response `200` (พบคาบเดียวชัดเจน):
```json
{
  "data": {
    "resolved": "single",
    "schedule_id": "uuid",
    "section_code": "CPH64-242",
    "lab_no": "LAB1",
    "lab_title": "บทนำปฏิบัติการ",
    "location": { "name": "ห้อง 134 อาคาร B8", "location_id": "uuid" },
    "start_time": "2026-09-12T09:00:00+07:00",
    "end_time": "2026-09-12T12:00:00+07:00",
    "late_threshold_minutes": 15
  }
}
```

Response `200` (กำกวม — เฉพาะกรณีเข้าทาง `lat`/`lng` ไม่ผ่าน QR และมีหลายห้องใกล้กันที่มีคาบพร้อมกันจริง):
```json
{
  "data": {
    "resolved": "ambiguous",
    "candidates": [
      { "schedule_id": "uuid1", "location_name": "ห้อง 134 อาคาร B8", "section_code": "CPH64-242 LAB1" },
      { "schedule_id": "uuid2", "location_name": "ห้อง 135 อาคาร B8", "section_code": "CPH64-243 LAB2" }
    ]
  }
}
```
Frontend แสดงปุ่มเลือกสั้นๆ จาก `candidates` แล้วส่ง `schedule_id` ที่เลือกต่อให้ `verify-eligibility` — เกิดขึ้นเฉพาะกรณีที่ backend หาห้องที่มีคาบเดียวจริงไม่ได้เท่านั้น (ถ้าในบรรดาห้องใกล้เคียง มีแค่ห้องเดียวที่มีคาบเรียนอยู่จริง ณ ขณะนั้น backend จะ resolve เป็น `single` ให้อัตโนมัติโดยไม่ถาม)

`data: null` → ไม่มีคาบเรียนที่ตำแหน่งนี้ตอนนี้ (หน้าแอปแสดง "ยังไม่ถึงเวลาคาบเรียน")

### `POST /checkin/verify-eligibility`
ขั้นที่ 2 ของ flow: ตรวจตำแหน่ง GPS แบบละเอียดอีกครั้ง **ก่อนเปิดกล้อง** โดยใช้ `schedule_id` ที่ resolve มาแล้วจาก `current-session` (ไม่ว่าจะ auto หรือผู้ใช้เลือกเองในกรณีกำกวม)
Request:
```json
{ "schedule_id": "uuid", "latitude": 13.7563, "longitude": 100.5018 }
```
Response `200` (ผ่าน):
```json
{ "data": { "eligible": true, "distance_meters": 12.4 } }
```
Response `422` (ไม่ผ่าน — ตรงกับหน้า "ตำแหน่งไม่ผ่าน" ใน mockup):
```json
{ "data": null, "error": { "code": "OUT_OF_ZONE", "message": "อยู่นอกพื้นที่ที่กำหนด", "distance_meters": 85, "allowed_radius_meters": 30 } }
```

### `POST /checkin`
ขั้นที่ 3-5: ส่ง embedding มาให้จับคู่ + บันทึกผลจริง (ต้องผ่าน `verify-eligibility` มาก่อนเสมอ)
Request:
```json
{
  "schedule_id": "uuid",
  "embedding_vector": "base64-encoded-float-array",
  "latitude": 13.7563,
  "longitude": 100.5018,
  "device_id": "device-fingerprint-hash"
}
```
Response `201` (สำเร็จ):
```json
{
  "data": {
    "attendance_id": "uuid",
    "status": "present",
    "check_in_time": "2026-09-12T09:07:00+07:00",
    "face_match_score": 0.94
  }
}
```
Response `422` (ใบหน้าไม่ตรง):
```json
{ "data": null, "error": { "code": "FACE_MISMATCH", "message": "ไม่สามารถยืนยันใบหน้าได้", "match_score": 0.41 } }
```
หมายเหตุ: `status` คำนวณจาก `check_in_time` เทียบ `late_threshold_minutes` ตามกฎในหัวข้อ 4.7 ของเอกสารออกแบบ (ปกติ/สาย) — บันทึก `device_id` เพื่อกันเครื่องเดียวเช็คชื่อแทนหลายคน (ถ้า `device_id` เดียวกันเช็คชื่อคนละ `student_id` ถี่ผิดปกติในคาบเดียว ให้ตอบ `409 DEVICE_REUSE_SUSPECTED`)

### `GET /checkin/{attendance_id}`
ดูรายละเอียดผลเช็คชื่อ (ใช้แสดงหน้า "สำเร็จ" ใน mockup)

---

## 3. Room Booking (`/bookings`)

**สิทธิ์**: `instructor` (เจ้าของแล็บ), `admin` (ดูทั้งหมด)

### `GET /bookings?section_id=&status=`
List คำขอจอง (filter ตาม section/สถานะ)

### `POST /bookings`
สร้างคำขอจองใหม่
```json
{
  "location_id": "uuid",
  "section_id": "uuid",
  "booking_type": "class_schedule",
  "start_datetime": "2026-09-14T09:00:00+07:00",
  "end_datetime": "2026-09-14T12:00:00+07:00",
  "recurrence_rule": "WEEKLY;UNTIL=2026-12-15",
  "purpose": null
}
```
Response `409` (ห้องชนกัน — ตรงกับหน้า "ปฏิเสธคำขอจอง" ใน flow diagram):
```json
{ "data": null, "error": { "code": "ROOM_CONFLICT", "message": "ห้องไม่ว่างช่วงเวลานี้", "conflicting_booking_id": "uuid" } }
```
Response `201` (ห้องว่าง สร้างคำขอสำเร็จ สถานะ `pending`):
```json
{ "data": { "booking_id": "uuid", "status": "pending" } }
```

### `PATCH /bookings/{booking_id}/approve`
อาจารย์เจ้าของแล็บอนุมัติเอง (ไม่ผ่านแอดมิน) — trigger generate แถวลง `schedules` ทันที (รายสัปดาห์ถ้ามี `recurrence_rule`)
```json
{ "data": { "booking_id": "uuid", "status": "approved", "generated_schedule_count": 14 } }
```

### `PATCH /bookings/{booking_id}/reject`
```json
{ "reason": "ชนกับตารางที่อนุมัติไว้ก่อน" }
```

### `GET /bookings/check-availability?location_id=&start=&end=`
เช็คห้องว่างก่อนส่งคำขอจริง (ใช้ตอน UI แสดง preview ก่อนกดยืนยัน)

---

## 4. Locations — ตั้งค่าห้อง/พิกัด (`/locations`)

**สิทธิ์**: `admin` เท่านั้น (ตามที่ยืนยันไว้ว่าแอดมินเป็นผู้กำหนดโซน)

### `GET /locations`
### `POST /locations`
```json
{
  "name": "ห้อง 134 อาคาร B8",
  "building": "B8",
  "floor": 1,
  "latitude": 13.7563,
  "longitude": 100.5018,
  "radius_meters": 30
}
```
### `PUT /locations/{location_id}`
### `DELETE /locations/{location_id}`

---

## 5. Course / Section Admin (`/courses`, `/semesters`, `/lab-sections`)

**สิทธิ์**: `admin` (สร้าง/แก้), `instructor` (ดูของตัวเอง)

> แทนที่ Schedule Integration Layer เดิมเพราะยังไม่มีระบบภายนอกจริง (ดู Context.md) — เป็น CRUD ธรรมดา

- `GET/POST /courses` — รหัสวิชา, ชื่อวิชา
- `GET/POST /semesters` — ปีการศึกษา/เทอม
- `GET/POST /lab-sections` — กลุ่มเรียน ผูก course + semester + instructor + `late_threshold_minutes`
- `GET /lab-sections/{id}/enrollments` — รายชื่อนักศึกษาในกลุ่ม
- `POST /lab-sections/{id}/enrollments` — เพิ่มนักศึกษาเข้ากลุ่ม (bulk, รับ array ของ `student_id`)

---

## 6. Schedules (`/schedules`)

**สิทธิ์**: `student`, `instructor`, `admin` (อ่านอย่างเดียว — เขียนผ่าน `/bookings` เท่านั้น)

### `GET /schedules?section_id=&date_from=&date_to=`
List คาบเรียนจริงที่ generate จาก booking ที่อนุมัติแล้ว

### `GET /schedules/{schedule_id}`
รวม location, section, booking ต้นทาง

---

## 7. Attendance & Reports (`/attendance`)

**สิทธิ์**: `instructor` (ของ section ตัวเอง), `admin` (ทั้งหมด), `student` (ของตัวเอง)

### `GET /attendance/summary?section_id=&semester_id=&student_id=`
สรุป 3 ระดับตามที่ออกแบบไว้ (4.3)
```json
{
  "data": {
    "level": "section",
    "section_code": "CPH64-242 LAB1",
    "total_sessions": 12,
    "present": 10, "late": 5, "absent": 2, "left_area": 1,
    "students": [
      { "student_id": "uuid", "attendance_rate": 0.92, "present": 10, "late": 1, "absent": 1 }
    ]
  }
}
```
หมายเหตุ: `left_area` แยกออกจาก `absent` เสมอตามนโยบายที่ตกลงไว้ (ไม่ฟันธงอัตโนมัติ)

### `GET /attendance/records?schedule_id=&student_id=`
List raw records

### `PATCH /attendance/{attendance_id}`
อาจารย์แก้สถานะมือ (เช่นเปลี่ยนเป็น `excused`) — ต้องแนบ `reason`

### `GET /attendance/export?section_id=&format=xlsx`
Export รายงาน (คืน presigned URL ให้ดาวน์โหลด หรือ trigger upload ขึ้น Google Drive แล้วคืน `drive_file_id`)

---

## 8. Rosters (`/rosters`)

**สิทธิ์**: `admin`

### `POST /rosters/generate`
```json
{ "semester_id": "uuid" }
```
Trigger job สร้างไฟล์ Excel/CSV ต่อกลุ่มเรียน (dynamic ตามจำนวนกลุ่มจริง) แล้วอัปโหลดเข้า Google Drive Pro ตามโครงสร้างโฟลเดอร์ที่กำหนด (4.4)
```json
{ "data": { "roster_id": "uuid", "status": "processing" } }
```

### `GET /rosters?semester_id=`
```json
{ "data": [{ "roster_id": "uuid", "section_code": "LAB1", "drive_file_id": "...", "generated_at": "..." }] }
```

---

## 9. Push Subscriptions (`/push-subscriptions`)

**สิทธิ์**: `student`, `instructor`, `admin` (ของตัวเอง)

### `POST /push-subscriptions`
บันทึก subscription หลังกดอนุญาตแจ้งเตือนในเบราว์เซอร์
```json
{
  "endpoint": "https://fcm.googleapis.com/...",
  "keys": { "p256dh": "...", "auth": "..." }
}
```

### `DELETE /push-subscriptions/{id}`
ยกเลิกการรับแจ้งเตือน

---

## 10. Notification Logs (`/notifications/logs`) — อ่านอย่างเดียว

**สิทธิ์**: `admin`

### `GET /notifications/logs?schedule_id=&channel=&type=`
ตรวจสอบย้อนหลังว่าส่งอะไรไปบ้าง (LINE/Web Push) ตาม Notification Matrix ในหัวข้อ 4.6 — ครอบคลุมทุก `notification_type`: `mid_class_15min`, `end_of_class`, `booking_submitted`, `booking_approved`, `booking_rejected`, `roster_ready`, `class_reminder`

---

## Internal Jobs (ไม่ใช่ REST endpoint สาธารณะ แต่ระบุไว้เพื่อความครบถ้วน)

รันเป็น **Supabase Edge Function บน Supabase Cron** ทุก 1 นาที (ดูเหตุผลเรื่อง keep-alive ในหัวข้อ 2 ของเอกสารออกแบบ):
1. เช็คคาบที่ครบ `late_threshold_minutes` → ส่ง `mid_class_15min` (LINE + Web Push)
2. เช็คคาบที่ถึง `end_time` → ส่ง `end_of_class`
3. เช็คคาบที่จะเริ่มในอีก 10 นาที → ส่ง `class_reminder` (Web Push เท่านั้น) หา `section_enrollments` ที่มี active subscription

> **หมายเหตุ**: Presence Tracking (`presence_check`, `left_area_alert`) ถูกตัดออกจาก scope ปัจจุบันตามคำขอผู้ใช้ — ดูหัวข้อ 8 ของเอกสารออกแบบถ้าต้องการนำกลับมาในอนาคต

---

## Authorization Matrix สรุป

| Endpoint group | student | instructor | admin |
|---|---|---|---|
| Face Enrollment | ✅ (ตัวเอง) | ❌ | ✅ |
| Check-in | ✅ (ตัวเอง) | ❌ | ❌ |
| Bookings | ❌ | ✅ (ของแล็บตัวเอง) | ✅ (ดูทั้งหมด) |
| Locations | ❌ | ❌ | ✅ |
| Courses/Sections | อ่านของตัวเอง | อ่านของตัวเอง | ✅ เขียนได้ |
| Attendance Reports | ✅ (ตัวเอง) | ✅ (section ตัวเอง) | ✅ ทั้งหมด |
| Rosters | ❌ | ❌ | ✅ |
| Push Subscriptions | ✅ (ตัวเอง) | ✅ (ตัวเอง) | ✅ (ตัวเอง) |
| Notification Logs | ❌ | ❌ | ✅ |
