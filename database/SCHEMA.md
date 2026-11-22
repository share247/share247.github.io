# Database & Storage Design Specification: Share247

## 1. Architectural Overview

Since **Share247** is hosted entirely on **GitHub Pages**, there is no persistent backend server (like a custom Node.js, Go, or Python daemon) running within the repository. GitHub Pages serves purely static client-side files (HTML, CSS, JavaScript).

To fulfill the requirements:
1. **Public file sharing** (no authentication required).
2. **Easy download** for anyone with or without a direct link.
3. **Automatic 7-day file deletion** handled directly by the database/storage backend.

The backend is built using **Google Firebase / Google Cloud Platform (Cloud Firestore + Cloud Storage)** as the serverless database and storage provider, coupled with native serverless lifecycle policies.

```
+-------------------------------------------------------------+
|                      GITHUB PAGES                           |
|  (Static Web App: HTML5, Classic CSS, Modular Vanilla JS)   |
+------------------------------+------------------------------+
                               |
            +------------------+------------------+
            | Direct Client SDK Connection        |
            v                                     v
+-----------------------+             +-----------------------+
|    CLOUD FIRESTORE    |             |     CLOUD STORAGE     |
| (Metadata & Metadata) |             | (Binary File Blobs)   |
|                       |             |                       |
|   Auto-Delete via     |             |   Auto-Delete via     |
|   Firestore TTL       |             |   GCS Lifecycle Rule  |
|   (expiresAt Field)   |             |   (Age: 7 Days)       |
+-----------------------+             +-----------------------+
```

---

## 2. Firestore Database Schema

### Collection: `files`
Each shared file is stored as a document in the root `files` collection.

#### Document ID:
- An auto-generated alphanumeric unique identifier (e.g., `aZ7kM9pQ2L1xW8yT4uV0`).

#### Document Fields:

| Field Name | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | Unique file/document ID | `"aZ7kM9pQ2L1xW8yT4uV0"` |
| `name` | `string` | Yes | Original file name | `"quarterly-report.pdf"` |
| `size` | `number` | Yes | Size of the file in bytes | `4194304` |
| `formattedSize`| `string` | Yes | Human-readable size | `"4.00 MB"` |
| `type` | `string` | Yes | MIME type | `"application/pdf"` |
| `extension` | `string` | Yes | Normalized lowercase file extension | `"pdf"` |
| `storagePath` | `string` | Yes | Path in Cloud Storage bucket | `"uploads/aZ7kM9pQ2L1xW8yT4uV0/quarterly-report.pdf"` |
| `downloadUrl` | `string` | Yes | Direct public download link | `"https://firebasestorage.googleapis.com/..."` |
| `createdAt` | `timestamp` | Yes | Exact UTC timestamp of upload | `2026-11-22T10:00:00.000Z` |
| `expiresAt` | `timestamp` | Yes | **TTL Field:** Exactly `createdAt + 7 days` | `2026-11-29T10:00:00.000Z` |
| `downloadsCount`| `number`| Yes | Counter of successful downloads | `12` |

---

## 3. Seven-Day Automatic Deletion Strategy

The 7-day automatic deletion is implemented across **three complementary tiers** to ensure zero server maintenance, 100% reliability, and instant user-facing expiration:

### Tier 1: Cloud Storage Object Lifecycle Rule (Backend Storage Tier)
Google Cloud Storage natively enforces automated file deletion at the storage layer without any code execution or cloud functions.
- **Rule Definition (`gcs-lifecycle.json`)**:
  ```json
  {
    "lifecycle": {
      "rule": [
        {
          "action": { "type": "Delete" },
          "condition": { "age": 7 }
        }
      ]
    }
  }
  ```
- **How it works**: Google Cloud Storage inspects every stored object daily. Any object whose creation time exceeds **7 days** (`age: 7`) is automatically and irreversibly deleted by Google's infrastructure.
- **Activation Command**:
  ```bash
  gsutil lifecycle set database/gcs-lifecycle.json gs://<YOUR-FIREBASE-STORAGE-BUCKET>
  ```

### Tier 2: Firestore Native TTL (Backend Database Tier)
Cloud Firestore includes a native serverless Time-to-Live (TTL) service.
- **How it works**: Firestore monitors the designated `expiresAt` timestamp attribute. When a document's `expiresAt` is earlier than the current time, Firestore's automated background deletion workers delete the document from the database.
- **Activation Command**:
  ```bash
  gcloud firestore fields ttls update expiresAt --collection-group=files --enable-ttl
  ```

### Tier 3: Client-Side Query Guard (Zero-Latency Presentation Tier)
Background TTL runs at scheduled intervals (typically within hours of expiration). To guarantee that users never see or download an expired file the instant its 7-day period lapses, client queries enforce:
```javascript
const q = query(
  collection(db, "files"),
  where("expiresAt", ">", Timestamp.now()),
  orderBy("expiresAt", "asc")
);
```
Any file past 7 days is instantly hidden from directory listings and rejected upon direct URL access.

---

## 4. Storage Bucket Structure

Files are organized in the bucket under a namespaced directory to prevent collisions:
```
gs://<BUCKET_NAME>/
  └── uploads/
      └── <fileId>/
          └── <fileName>
```
Example:
`uploads/aZ7kM9pQ2L1xW8yT4uV0/quarterly-report.pdf`

---

## 5. Security Rules

Because the user requested **public file sharing without authentication**:
- **Read**: Anyone can read metadata and download binary files if the file has not yet expired (`request.time < resource.data.expiresAt`).
- **Create**: Anyone can upload a file and create its metadata, provided:
  - File size does not exceed the allowed maximum (e.g., 100 MB).
  - The document `expiresAt` is set correctly to `request.time + duration.value(7, 'd')`.
- **Update**: Allowed exclusively to increment the `downloadsCount` field. All other metadata fields are immutable.
- **Delete**: Automated via backend lifecycle and TTL.

See `database/firestore.rules` and `database/storage.rules` for the complete production rulesets.
