create table if not exists public.locations (
  id text primary key check (id ~ '^[A-Za-z0-9-]{1,20}$'),
  building text not null check (char_length(building) between 1 and 80),
  floor text not null check (char_length(floor) between 1 and 40),
  area text not null check (char_length(area) between 1 and 100),
  position text not null check (char_length(position) between 1 and 150),
  outlets integer not null check (outlets between 1 and 99),
  ports text[] not null default array['Stopkontak listrik']::text[],
  status text not null check (status in ('Berfungsi', 'Dalam Verifikasi', 'Tidak Berfungsi', 'Tidak Tersedia')),
  verified_at date not null default current_date,
  category text not null default 'Area publik' check (char_length(category) <= 50),
  art integer not null default 1 check (art between 1 and 6),
  photo_path text
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table if not exists public.reports (
  id text primary key check (char_length(id) <= 40),
  location_id text not null,
  new_location jsonb,
  type text not null check (type in (
    'Colokan rusak', 'Colokan tidak berfungsi', 'Stopkontak longgar',
    'Port USB tidak berfungsi', 'Titik colokan sudah tidak tersedia',
    'Informasi lokasi tidak sesuai', 'Menambahkan titik colokan baru'
  )),
  name text not null default '' check (char_length(name) <= 60),
  description text not null check (char_length(description) between 1 and 1000),
  photo_path text,
  status text not null default 'Menunggu Verifikasi'
    check (status in ('Menunggu Verifikasi', 'Disetujui', 'Ditolak')),
  rejection_reason text not null default '' check (char_length(rejection_reason) <= 250),
  created_at timestamptz not null default now(),
  check (
    (location_id = 'new' and new_location is not null and jsonb_typeof(new_location) = 'object')
    or (location_id <> 'new' and new_location is null)
  )
);

create table if not exists public.activity (
  id bigint generated always as identity primary key,
  message text not null check (char_length(message) <= 1000),
  timestamp timestamptz not null default now()
);

create table if not exists public.report_submission_limits (
  ip_hash text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0)
);
create index if not exists report_submission_limits_window_idx
  on public.report_submission_limits (window_started_at);
alter table public.report_submission_limits enable row level security;

grant select on public.locations to anon, authenticated;
grant insert, update, delete on public.locations to authenticated;
grant select on public.admin_users to authenticated;
grant insert on public.reports to service_role;
grant select, update, delete on public.reports to authenticated;
grant select, insert on public.activity to authenticated;
grant usage, select on sequence public.activity_id_seq to authenticated;
grant all on public.report_submission_limits to service_role;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.consume_report_submission_limit(p_ip_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempts integer;
begin
  insert into public.report_submission_limits as limits (ip_hash, window_started_at, request_count)
  values (p_ip_hash, now(), 1)
  on conflict (ip_hash) do update set
    window_started_at = case
      when limits.window_started_at <= now() - interval '1 hour' then now()
      else limits.window_started_at
    end,
    request_count = case
      when limits.window_started_at <= now() - interval '1 hour' then 1
      else limits.request_count + 1
    end
  returning request_count into attempts;

  delete from public.report_submission_limits
  where window_started_at < now() - interval '24 hours';
  return attempts <= 5;
end;
$$;

revoke all on function public.consume_report_submission_limit(text) from public;
grant execute on function public.consume_report_submission_limit(text) to service_role;

alter table public.locations enable row level security;
alter table public.admin_users enable row level security;
alter table public.reports enable row level security;
alter table public.activity enable row level security;

drop policy if exists "Locations are public to read" on public.locations;
create policy "Locations are public to read"
  on public.locations for select to anon, authenticated using (true);
drop policy if exists "Admins manage locations" on public.locations;
create policy "Admins manage locations"
  on public.locations for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "Admins can read their own role" on public.admin_users;
create policy "Admins can read their own role"
  on public.admin_users for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Public can submit reports" on public.reports;
drop policy if exists "Admins manage reports" on public.reports;
create policy "Admins manage reports"
  on public.reports for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "Admins read activity" on public.activity;
create policy "Admins read activity"
  on public.activity for select to authenticated using ((select public.is_admin()));
drop policy if exists "Admins add activity" on public.activity;
create policy "Admins add activity"
  on public.activity for insert to authenticated with check ((select public.is_admin()));

create or replace function public.approve_report(report_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  report_row public.reports%rowtype;
  next_status text;
  new_id text;
  suffix integer := 1;
  prefix text;
begin
  if not (select public.is_admin()) then
    raise exception 'Admin access required';
  end if;

  select * into report_row
  from public.reports
  where id = report_id and status = 'Menunggu Verifikasi'
  for update;
  if not found then
    raise exception 'Report is no longer pending';
  end if;

  if report_row.location_id = 'new' then
    prefix := upper(left(regexp_replace(report_row.new_location->>'building', '[^A-Za-z0-9]', '', 'g'), 3));
    if prefix = '' then prefix := 'NEW'; end if;
    loop
      new_id := prefix || '-' || lpad(suffix::text, 2, '0');
      exit when not exists (select 1 from public.locations where id = new_id);
      suffix := suffix + 1;
    end loop;
    insert into public.locations (
      id, building, floor, area, position, outlets, ports, status,
      verified_at, category, art, photo_path
    ) values (
      new_id, report_row.new_location->>'building', report_row.new_location->>'floor',
      report_row.new_location->>'area', report_row.description, 1,
      array['Stopkontak listrik']::text[], 'Berfungsi', current_date,
      'Area belajar', 1, null
    );
    insert into public.activity(message) values (
      'Laporan ' || report_id || ' disetujui; titik baru ' || new_id || ' ditambahkan ke direktori.'
    );
  else
    next_status := case
      when report_row.type = 'Titik colokan sudah tidak tersedia' then 'Tidak Tersedia'
      when report_row.type in ('Colokan rusak', 'Colokan tidak berfungsi', 'Stopkontak longgar', 'Port USB tidak berfungsi') then 'Tidak Berfungsi'
      else null
    end;
    if next_status is not null then
      update public.locations set status = next_status, verified_at = current_date
      where id = report_row.location_id;
    end if;
    insert into public.activity(message) values (
      case when next_status is null
        then 'Laporan ' || report_id || ' disetujui setelah ditinjau.'
        else 'Laporan ' || report_id || ' disetujui; status titik ' || report_row.location_id || ' diperbarui menjadi ' || next_status || '.'
      end
    );
  end if;

  update public.reports set status = 'Disetujui', rejection_reason = '' where id = report_id;
end;
$$;

create or replace function public.reject_report(report_id text, reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'Admin access required';
  end if;
  if char_length(trim(reason)) not between 1 and 250 then
    raise exception 'Rejection reason must contain 1 to 250 characters';
  end if;
  update public.reports
  set status = 'Ditolak', rejection_reason = trim(reason)
  where id = report_id and status = 'Menunggu Verifikasi';
  if not found then
    raise exception 'Report is no longer pending';
  end if;
  insert into public.activity(message) values ('Laporan ' || report_id || ' ditolak.');
end;
$$;

revoke all on function public.approve_report(text) from public;
revoke all on function public.reject_report(text, text) from public;
grant execute on function public.approve_report(text) to authenticated;
grant execute on function public.reject_report(text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('location-photos', 'location-photos', true, 4194304, array['image/jpeg']),
  ('report-evidence', 'report-evidence', false, 4194304, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public read location photos" on storage.objects;
create policy "Public read location photos"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'location-photos');
drop policy if exists "Admins manage location photos" on storage.objects;
create policy "Admins manage location photos"
  on storage.objects for all to authenticated
  using (bucket_id = 'location-photos' and (select public.is_admin()))
  with check (bucket_id = 'location-photos' and (select public.is_admin()));
drop policy if exists "Reports can upload their evidence" on storage.objects;
drop policy if exists "Admins read report evidence" on storage.objects;
create policy "Admins read report evidence"
  on storage.objects for select to authenticated
  using (bucket_id = 'report-evidence' and (select public.is_admin()));

create or replace function public.record_report_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.activity(message) values ('Laporan baru ' || new.id || ' menunggu verifikasi admin.');
  return new;
end;
$$;

drop trigger if exists report_submission_activity on public.reports;
create trigger report_submission_activity
  after insert on public.reports
  for each row execute function public.record_report_submission();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'locations'
  ) then
    alter publication supabase_realtime add table public.locations;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reports'
  ) then
    alter publication supabase_realtime add table public.reports;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity'
  ) then
    alter publication supabase_realtime add table public.activity;
  end if;
end
$$;

insert into public.locations (id, building, floor, area, position, outlets, ports, status, verified_at, category, art)
values
  ('VA-01', 'Gedung VA', 'Lantai 1', 'Ruang belajar mahasiswa', 'Sisi kanan area duduk dekat jendela', 4, array['Stopkontak listrik'], 'Berfungsi', '2025-10-12', 'Area belajar', 1),
  ('VA-02', 'Gedung VA', 'Lantai 2', 'Area duduk koridor timur', 'Dinding dekat bangku panjang', 3, array['Stopkontak listrik'], 'Berfungsi', '2025-10-10', 'Area duduk', 2),
  ('VA-03', 'Gedung VA', 'Lantai 3', 'Ruang diskusi', 'Di bawah meja panjang', 2, array['Stopkontak listrik', 'USB-A'], 'Dalam Verifikasi', '2025-10-08', 'Ruang belajar', 3),
  ('VA-04', 'Gedung VA', 'Lantai 1', 'Lobi utama', 'Pilar di dekat area tunggu', 2, array['Stopkontak listrik'], 'Tidak Berfungsi', '2025-10-06', 'Area publik', 4),
  ('VB-01', 'Gedung VB', 'Lantai 2', 'Area komunal barat', 'Dinding dekat papan informasi', 3, array['Stopkontak listrik'], 'Berfungsi', '2025-10-14', 'Area duduk', 5),
  ('VB-02', 'Gedung VB', 'Lantai 1', 'Selasar selatan', 'Dekat kursi panjang sisi selatan', 2, array['Stopkontak listrik'], 'Berfungsi', '2025-10-11', 'Area publik', 6),
  ('VC-01', 'Gedung VC', 'Lantai 1', 'Area tunggu gedung', 'Di dekat meja komunal', 3, array['Stopkontak listrik', 'USB-A'], 'Tidak Tersedia', '2025-10-03', 'Area duduk', 2),
  ('TL-01', 'Taman Literasi', 'Area luar', 'Area belajar terbuka', 'Tiang di sisi barat area duduk', 2, array['Stopkontak listrik'], 'Berfungsi', '2025-10-13', 'Area luar', 3)
on conflict (id) do nothing;
