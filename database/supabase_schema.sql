-- =====================================================================
-- Share247 — Supabase Database & 7-Day Auto-Purge Lifecycle Schema
-- =====================================================================
-- Project: https://your-project-id.supabase.co
-- This script configures the files table, public-files bucket,
-- Row Level Security (RLS), and pg_cron automated 7-day purging.

-- 1. Create the files metadata table
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) > 0 and char_length(name) <= 255),
  size bigint not null check (size > 0 and size <= 104857600), -- max 100MB
  formatted_size text not null,
  type text not null default 'application/octet-stream',
  extension text default '',
  storage_path text not null,
  download_url text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  downloads_count integer not null default 0
);

-- Index for speedy queries on active unexpired files
create index if not exists idx_files_expires_at on public.files (expires_at asc);
create index if not exists idx_files_created_at on public.files (created_at desc);

-- Optional PIN column for password protected sharing
alter table public.files add column if not exists pin text;

-- 2. Enable Row Level Security (RLS)
alter table public.files enable row level security;

-- Policy A: Anyone can view unexpired files (Public read)
drop policy if exists "Allow public view active files" on public.files;
create policy "Allow public view active files"
  on public.files
  for select
  using (expires_at > now());

-- Policy B: Anyone can insert files (Public upload)
drop policy if exists "Allow public insert files" on public.files;
create policy "Allow public insert files"
  on public.files
  for insert
  with check (
    size <= 104857600
    and expires_at <= (now() + interval '7 days 10 minutes')
  );

-- Policy C: Anyone can increment the download counter
drop policy if exists "Allow public increment download count" on public.files;
create policy "Allow public increment download count"
  on public.files
  for update
  using (expires_at > now())
  with check (true);

-- 3. Create public Storage Bucket for file uploads
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'public-files',
  'public-files',
  true,
  104857600, -- 100 MB
  null       -- all mime types allowed
)
on conflict (id) do update set
  public = true,
  file_size_limit = 104857600;

-- Storage Bucket Policies
drop policy if exists "Public Access to public-files bucket" on storage.objects;
create policy "Public Access to public-files bucket"
  on storage.objects
  for select
  using (bucket_id = 'public-files');

drop policy if exists "Public Upload to public-files bucket" on storage.objects;
create policy "Public Upload to public-files bucket"
  on storage.objects
  for insert
  with check (
    bucket_id = 'public-files'
    and (octet_length(name) <= 255)
  );

drop policy if exists "Public Delete expired files" on storage.objects;
create policy "Public Delete expired files"
  on storage.objects
  for delete
  using (bucket_id = 'public-files');

-- 4. Automated 7-Day File Deletion Routine
-- This function deletes expired database records AND their associated storage objects!
create or replace function public.purge_expired_files()
returns integer
language plpgsql
security definer
as $$
declare
  purged_count integer := 0;
  record_item record;
begin
  -- Loop through expired files
  for record_item in 
    select id, storage_path 
    from public.files 
    where expires_at < now()
  loop
    -- Delete file binary from storage bucket
    delete from storage.objects
    where bucket_id = 'public-files'
      and name = record_item.storage_path;

    -- Delete database metadata record
    delete from public.files where id = record_item.id;
    purged_count := purged_count + 1;
  end loop;

  return purged_count;
end;
$$;

-- 5. Schedule Automated 7-Day Purge with pg_cron
create extension if not exists pg_cron with schema extensions;

-- Run cleanup every hour on the hour
select cron.unschedule('purge-7day-expired-files') where exists (
  select 1 from cron.job where jobname = 'purge-7day-expired-files'
);

select cron.schedule(
  'purge-7day-expired-files',
  '0 * * * *', -- Every hour
  $$ select public.purge_expired_files(); $$
);
