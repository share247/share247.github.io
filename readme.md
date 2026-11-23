# Share247 — Public Ephemeral Cloud Vault (Files & Links)

A fast, dark-themed public file and web link vault built for **GitHub Pages** with **Supabase (PostgreSQL + Storage)** and automatic 7-day purging.

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
| (Files & Links Table) |             | (Binary Blobs Bucket) |
|                       |             |                       |
|   Auto-Delete via     |             |   Auto-Delete via     |
|   pg_cron hourly job  |             |   pg_cron function    |
+-----------------------+             +-----------------------+
```

---

## 🔗 Link Sharing & File Uploads

Share247 supports both binary file uploads and web links/URLs:
- **Web Link Sharing**: Instantly share any website, video, document, or online resource link with a clean destination URL input and automatic 7-day purging.
- **File Upload Security**: Uploaded files can optionally be secured with a PIN code.
- **Ephemeral Auto-Purge**: Both files and links are stored for exactly 7 days before being automatically purged.
- **Convenient Discovery**: Add links via the **+ Link** navbar button, the empty-state action button, dragging & dropping a URL onto the window, or pressing `Ctrl+V` anywhere on the page.

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
  downloads_count integer not null default 0,
  pin text
);
```

### Storage Bucket: `public-files`
- Public bucket for up to 100 MB files.
- Binary blobs stored at `${id}/${filename}`.
- Web links bypass bucket storage (`storage_path` prefixed with `link://`).

---

## ⏱ 2. Automated 7-Day Purging

Automated deletion of both storage objects and database records is handled by PostgreSQL:

1. **Purge Routine (`public.purge_expired_files()`)**:
   Deletes expired binary blobs from `storage.objects` (bypassing link entries) and purges their matching metadata rows from `public.files`.
2. **`pg_cron` Scheduled Job**:
   Runs automatically every hour (`0 * * * *`) in Supabase.
3. **Client-Side Query Guard**:
   Queries `where('expires_at', '>', now)` so expired files and links disappear from view immediately without waiting for the hourly cron.

---

## 🛡 3. AI Content Moderation & Safety (Gemini API)

Share247 features an automated Trust & Safety agent powered by **Google Gemini API** (`gemini-2.0-flash`) and layered heuristic rules:

1. **Immediate Ingestion**: When a user uploads a file or shares a link, it is immediately visible in the public vault.
2. **Automated Background Screening**:
   - The AI agent screens files and links for pornography, adult content, Child Sexual Abuse Material (CSAM - zero tolerance), malware/exploits, terrorism, and phishing.
   - Summarizes the inspection into a structured binary decision:
     - **`YES`**: Safe for sharing, no sensitive or prohibited issues detected.
     - **`NO`**: Prohibited content detected with specific classification and rationale.
3. **Automated Owner Alert**:
   - When an item receives a `NO` response, it is automatically flagged in the database (`moderation_status = 'flagged'`) and an urgent alert email/webhook notification is generated for the owner with item details and removal instructions.

---

## 👮 4. Admin Dashboard (`share247.github.io/admin`)

Vault administrators can supervise and control public files via the dedicated Admin Console:
- **Direct Access**: Navigate to `share247.github.io/admin` (or `/admin/` / `/admin.html`).
- **Master Passcode Protection**: Gated with a secure master passcode (initial default: `admin247`, customizable in AI Settings).
- **Prohibited Item Management**:
  - Live filter tabs: `All Items`, `🚨 Flagged Only`, `✅ Safe`, `Files`, and `Links`.
  - **1-Click Bulk Purge**: Purge all flagged or prohibited items immediately from both database metadata and Supabase storage bucket objects.
  - **On-Demand AI Audits**: Trigger single-item or bulk Gemini AI content safety scans across the entire vault.
  - **Manual Overrides**: Toggle flags between Safe and Flagged.
- **Settings Console**: Configure Google Gemini API keys, owner notification email, and alert webhooks.

---

## 🎨 5. User Interface

- **Top Navbar**: Contains brand title, pill search bar, **+ Upload** file button, **+ Link** button, and connection status indicator.
- **Drive-Inspired List View**:
  - Columns: `Name`, `Owner` (me/avatar), `Date modified`, `Expires in` (7-day countdown badge), `File size` (or `Link` badge), and `Actions`.
  - Row hover actions: Direct **Download / Open**, **Share Link**, and **Details**.
  - Sorting by Name, Date, or Size.
  - Fullscreen drag-and-drop overlay for both files and dropped URLs.
  - Floating tracer widget with real-time feedback.
  - Share modal with one-click copy for shareable URL and destination URL.

---

## 👥 Contributors

- [**Mostafa Kamal** (@mostafa-cse)](https://github.com/mostafa-cse)

