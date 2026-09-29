-- สแกนออกตอนจบคาบ + หมายเหตุรายคน (ตามช่อง "ออก" และ "หมายเหตุ" ในใบเซ็นชื่อเดิม)
alter table public.attendance_records
  add column check_out_time          timestamptz,
  add column check_out_lat           double precision,
  add column check_out_lng           double precision,
  add column check_out_distance      double precision,
  add column check_out_face_score    double precision,
  add column left_early              boolean,
  add column note                    text check (char_length(note) <= 300),
  add column note_updated_at         timestamptz;
comment on column public.attendance_records.left_early is 'สแกนออกก่อนเวลาจบคาบเกิน 10 นาที';
comment on column public.attendance_records.note is 'หมายเหตุรายคน (เช่น เหตุผลที่มาสาย/ออกก่อน) — นักศึกษาเพิ่มได้หลังเช็คชื่อ, เจ้าหน้าที่แก้ได้ในหน้าแอดมิน';
