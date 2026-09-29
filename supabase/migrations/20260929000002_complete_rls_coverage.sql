-- ============================================================
-- ปิดช่องโหว่ที่ advisor เจอ: เปิด RLS ให้ครบทุกตาราง + policy พื้นฐาน
-- หลักการ: นักศึกษาไม่มีการล็อกอินระหว่างเช็คชื่อ (ใช้ service_role ผ่าน
-- Edge Function เท่านั้น) ดังนั้น anon/authenticated ไม่ควรอ่านตารางเหล่านี้ตรงๆ
-- ยกเว้นสิ่งที่จำเป็นต่อ UI (เช่น นักศึกษาดูตารางเรียน/ห้องของ section ตัวเอง)
-- ============================================================

-- แก้ search_path ของ is_admin() ให้ fix ค่าไว้ ป้องกัน search_path hijacking
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where user_id = auth.uid() and role = 'admin');
$$;

-- นักศึกษา/ผู้ใช้ทุกคนเห็นข้อมูลอ้างอิงพื้นฐานได้ (ไม่ sensitive) — วิชา, เทอม, ห้อง
alter table public.courses enable row level security;
create policy "authenticated read courses" on public.courses for select using (auth.role() = 'authenticated');
create policy "admin full access courses" on public.courses for all using (public.is_admin());

alter table public.semesters enable row level security;
create policy "authenticated read semesters" on public.semesters for select using (auth.role() = 'authenticated');
create policy "admin full access semesters" on public.semesters for all using (public.is_admin());

alter table public.locations enable row level security;
create policy "authenticated read locations" on public.locations for select using (auth.role() = 'authenticated');
create policy "admin full access locations" on public.locations for all using (public.is_admin());

-- lab_sections: นักศึกษา/อาจารย์เห็น section ที่ตัวเองเกี่ยวข้อง, แอดมินเห็นหมด
alter table public.lab_sections enable row level security;
create policy "instructor own sections" on public.lab_sections
  for select using (instructor_id = auth.uid());
create policy "student enrolled sections" on public.lab_sections
  for select using (
    exists (
      select 1 from public.section_enrollments se
      where se.section_id = lab_sections.section_id and se.student_id = auth.uid()
    )
  );
create policy "admin full access lab_sections" on public.lab_sections for all using (public.is_admin());

-- section_enrollments: นักศึกษาเห็นแถวตัวเอง, อาจารย์เห็นของ section ตัวเอง
alter table public.section_enrollments enable row level security;
create policy "own enrollment" on public.section_enrollments
  for select using (student_id = auth.uid());
create policy "instructor section enrollments" on public.section_enrollments
  for select using (
    exists (
      select 1 from public.lab_sections ls
      where ls.section_id = section_enrollments.section_id and ls.instructor_id = auth.uid()
    )
  );
create policy "admin full access enrollments" on public.section_enrollments for all using (public.is_admin());

-- schedules: นักศึกษา/อาจารย์เห็นคาบของ section ตัวเอง
alter table public.schedules enable row level security;
create policy "instructor own schedules" on public.schedules
  for select using (
    exists (
      select 1 from public.lab_sections ls
      where ls.section_id = schedules.section_id and ls.instructor_id = auth.uid()
    )
  );
create policy "student enrolled schedules" on public.schedules
  for select using (
    exists (
      select 1 from public.section_enrollments se
      where se.section_id = schedules.section_id and se.student_id = auth.uid()
    )
  );
create policy "admin full access schedules" on public.schedules for all using (public.is_admin());

-- line_channels: เฉพาะอาจารย์เจ้าของ section และแอดมิน (มี line_group_id ไม่ควรเปิดกว้าง)
alter table public.line_channels enable row level security;
create policy "instructor own line_channels" on public.line_channels
  for select using (
    exists (
      select 1 from public.lab_sections ls
      where ls.section_id = line_channels.section_id and ls.instructor_id = auth.uid()
    )
  );
create policy "admin full access line_channels" on public.line_channels for all using (public.is_admin());

-- notification_logs: เจ้าของแจ้งเตือนดู log ตัวเองได้, แอดมินดูหมด
alter table public.notification_logs enable row level security;
create policy "own notification logs" on public.notification_logs
  for select using (recipient_user_id = auth.uid());
create policy "admin full access notification_logs" on public.notification_logs for all using (public.is_admin());

-- rosters: อาจารย์เจ้าของ section และแอดมินเท่านั้น
alter table public.rosters enable row level security;
create policy "instructor own rosters" on public.rosters
  for select using (
    exists (
      select 1 from public.lab_sections ls
      where ls.section_id = rosters.section_id and ls.instructor_id = auth.uid()
    )
  );
create policy "admin full access rosters" on public.rosters for all using (public.is_admin());

-- students: เจ้าตัวเห็นตัวเอง, อาจารย์เห็นนักศึกษาใน section ตัวเอง, แอดมินเห็นหมด
-- (ตารางนี้เปิด RLS ไว้แล้วตอน schema เดิมแต่ยังไม่มี policy เลย = ล็อกหมดโดยปริยาย)
create policy "own student row" on public.students
  for select using (student_id = auth.uid());
create policy "instructor section students" on public.students
  for select using (
    exists (
      select 1 from public.section_enrollments se
      join public.lab_sections ls on ls.section_id = se.section_id
      where se.student_id = students.student_id and ls.instructor_id = auth.uid()
    )
  );
create policy "admin full access students" on public.students for all using (public.is_admin());

-- face_templates: ห้ามใครอ่าน/เขียนตรงๆ ผ่าน client เลย นอกจากแอดมิน
-- (การเช็คชื่อจริงใช้ service_role ผ่าน Edge Function เท่านั้น ไม่ผ่าน policy พวกนี้)
create policy "admin full access face_templates" on public.face_templates for all using (public.is_admin());
