# Share247 — Public Ephemeral Cloud Vault (Supabase Edition)

A fast, dark-themed public file vault built for **GitHub Pages** with **Supabase (PostgreSQL + Storage)** and automatic 7-day file purging.

---

## 🏛 Architecture Overview

Since GitHub Pages exclusively hosts static client assets, **Supabase** acts as the serverless backend.

```
+-------------------------------------------------------------+
|               GITHUB PAGES (share247.github.io)             |
|   HTML5 Semantic Structure | Dark CSS | Vanilla ES6+ JS     |
+------------------------------+------------------------------+
                               |
            +------------------+------------------+
            | Direct Client SDK Connection        |
            v                                     v
+-----------------------+             +-----------------------+
|  POSTGRESQL (SUPABASE)|             |   SUPABASE STORAGE    |
| (Files Table Metadata)|             | (Binary Blobs Bucket) |
|                       |             |                       |
|   Auto-Delete via     |             |   Auto-Delete via     |
|   pg_cron hourly job  |             |   pg_cron function    |
+-----------------------+             +-----------------------+
```

---

## 🗄 1. Database Schema & Setup

The complete SQL setup script is provided in [`database/supabase_schema.sql`](file:///home/m0stafa/Documents/share247.github.io/database/supabase_schema.sql).

### Table: `public.files`
```sql
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  size bigint not null,
  formatted_size text not null,
  type text not null,
  extension text default '',
  storage_path text not null,
  download_url text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  downloads_count integer not null default 0
);
```

### Storage Bucket: `public-files`
- Public bucket for up to 100 MB files.
- Binary blobs stored at `${id}/${filename}`.

---

## ⏱ 2. Automated 7-Day File Purging

Automated deletion of both storage objects and database records is handled by PostgreSQL:

1. **Purge Routine (`public.purge_expired_files()`)**:
   Deletes expired binary blobs from `storage.objects` and purges their matching metadata rows from `public.files`.
2. **`pg_cron` Scheduled Job**:
   Runs automatically every hour (`0 * * * *`) in Supabase.
3. **Client-Side Query Guard**:
   Queries `where('expires_at', '>', now)` so expired files disappear from view immediately without waiting for the hourly cron.

---

## 🎨 3. User Interface

- **Top Navbar Only**: Contains brand title, pill search bar, prominent **+ Upload** button, and Supabase connection settings.
- **No Sidebar, No Footer**: 100% full-viewport table layout.
- **Drive-Inspired List View**:
  - Columns: `Name`, `Owner` (me/avatar), `Date modified`, `Expires in` (7-day countdown badge), `File size`, and `Actions`.
  - Row hover actions: Direct **Download**, **Share Link**, and **Details**.
  - Sorting by Name, Date, or Size.
  - Fullscreen drag-and-drop overlay.
  - Floating upload widget with progress feedback.

---

## 👥 Contributors

- [**Mostafa Kamal** (@mostafa-cse)](https://github.com/mostafa-cse)

