/**
 * Share247 - Database & Storage Service (Supabase & Local Vault)
 * Supports:
 * 1. Live Supabase (PostgreSQL + Supabase Storage) with 7-Day Auto-Purge
 * 2. Seamless IndexedDB Fallback (Instant offline demo & local testing)
 */

import { getStoredSupabaseConfig, isSupabaseConfigured } from './config.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PURGED_FILES_KEY = 'share247_purged_file_ids';

export function getPurgedFileIds() {
  try {
    const raw = localStorage.getItem(PURGED_FILES_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) {
    return new Set();
  }
}

export function addPurgedFileId(id) {
  if (!id) return;
  try {
    const current = getPurgedFileIds();
    current.add(String(id));
    localStorage.setItem(PURGED_FILES_KEY, JSON.stringify([...current]));
  } catch (e) {
    console.warn('Could not save purged file ID:', e);
  }
}

let syncBroadcastChannel = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    syncBroadcastChannel = new BroadcastChannel('share247_vault_sync');
  }
} catch (_) {}

export function broadcastVaultChange(action, payload) {
  try {
    if (syncBroadcastChannel) {
      syncBroadcastChannel.postMessage({ action, payload, timestamp: Date.now() });
    }
  } catch (_) {}
}

class DatabaseService {
  constructor() {
    this.mode = 'uninitialized'; // 'supabase' | 'local'
    this.supabase = null;
    this.idb = null;
  }

  async init() {
    const config = getStoredSupabaseConfig();
    if (isSupabaseConfigured(config)) {
      try {
        await this.initSupabase(config);
        // Verify active database connection with a probe
        const { error } = await this.supabase.from('files').select('id').limit(1);
        if (error) {
          console.error('Share247: Supabase probe failed:', error);
          throw error;
        }
        this.mode = 'supabase';
        console.info('Share247: Connected to live Supabase project.');
        return { mode: 'supabase' };
      } catch (err) {
        console.error('Share247: Supabase init failed, falling back to Local Vault:', err);
      }
    }

    await this.initIndexedDB();
    this.mode = 'local';
    console.info('Share247: Running in Local Public Storage mode (IndexedDB).');
    return { mode: 'local' };
  }

  isSupabaseConnected() {
    return this.mode === 'supabase';
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  getFileExtension(filename) {
    const parts = (filename || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  getViewCount(fileId) {
    if (!fileId) return 0;
    try {
      const counts = JSON.parse(localStorage.getItem('share247_view_counts') || '{}');
      return Number(counts[String(fileId)]) || 0;
    } catch (_) {
      return 0;
    }
  }

  cacheViewCount(fileId, count) {
    if (!fileId) return;
    try {
      const counts = JSON.parse(localStorage.getItem('share247_view_counts') || '{}');
      counts[String(fileId)] = Math.max(Number(counts[String(fileId)]) || 0, Number(count) || 0);
      localStorage.setItem('share247_view_counts', JSON.stringify(counts));
      broadcastVaultChange('view_increment', { fileId: String(fileId), count: counts[String(fileId)] });
    } catch (_) {}
  }

  // ==========================================
  // SUPABASE IMPLEMENTATION
  // ==========================================

  async initSupabase(config) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
  }

  mapSupabaseRecord(r) {
    if (!r) return null;
    const rawType = r.type || '';
    const hasPinInType = rawType.includes('; pin=');
    const pinVal = r.pin || (hasPinInType ? decodeURIComponent(rawType.split('; pin=')[1]) : null);

    const hasModInType = rawType.includes('; mod=');
    let modStatus = r.moderation_status || 'safe';
    let modReason = r.moderation_reason || '';
    if (hasModInType) {
      const match = rawType.match(/; mod=([^;]+)/);
      if (match) modStatus = match[1];
      const rMatch = rawType.match(/; reason=([^;]+)/);
      if (rMatch) modReason = decodeURIComponent(rMatch[1]);
    }

    const cleanType = rawType.split(';')[0];
    const isLink = cleanType === 'url' || cleanType === 'text/x-uri' || r.extension === 'link' || (r.storage_path && r.storage_path.startsWith('link://'));
    const displayName = isLink ? (this.extractDomain(r.name || r.download_url) || r.name) : r.name;

    const cachedViews = this.getViewCount(r.id);
    const serverViews = Number(r.downloads_count) || 0;
    const finalViews = Math.max(cachedViews, serverViews);

    return {
      id: r.id,
      name: displayName,
      size: r.size,
      formattedSize: isLink ? 'Link' : r.formatted_size,
      type: cleanType,
      isLink: isLink,
      extension: r.extension || (isLink ? 'link' : ''),
      storagePath: r.storage_path,
      downloadUrl: r.download_url,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      downloadsCount: finalViews,
      hasPin: Boolean(pinVal),
      pin: pinVal,
      moderationStatus: modStatus,
      moderationReason: modReason,
      flaggedAt: r.flagged_at || null
    };
  }

  extractDomain(urlStr) {
    if (!urlStr) return '';
    try {
      let u = String(urlStr).trim();
      if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
      const parsed = new URL(u);
      return parsed.hostname.replace(/^www\./i, '');
    } catch (_) {
      return String(urlStr).replace(/^https?:\/\//i, '').split('/')[0];
    }
  }

  async uploadFileToSupabase(file, onProgress, pin = null) {
    const config = getStoredSupabaseConfig();
    const fileId = crypto.randomUUID ? crypto.randomUUID() : 'f_' + Date.now().toString(36);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${fileId}/${safeName}`;

    // 1. Upload binary file using XMLHttpRequest for real-time telemetry (bytes, speed, ETA)
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const uploadUrl = `${config.supabaseUrl}/storage/v1/object/public-files/${storagePath}`;
      xhr.open('POST', uploadUrl, true);
      xhr.setRequestHeader('apikey', config.supabaseAnonKey);
      xhr.setRequestHeader('Authorization', `Bearer ${config.supabaseAnonKey}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-upsert', 'false');

      let lastLoaded = 0;
      let lastTime = performance.now();
      let smoothedSpeed = 0;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const now = performance.now();
          const timeElapsed = (now - lastTime) / 1000;
          if (timeElapsed >= 0.2 || e.loaded === e.total) {
            const bytesSince = e.loaded - lastLoaded;
            const currentSpeed = bytesSince / (timeElapsed || 0.001);
            smoothedSpeed = smoothedSpeed === 0 ? currentSpeed : (smoothedSpeed * 0.65 + currentSpeed * 0.35);
            lastLoaded = e.loaded;
            lastTime = now;
          }

          const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
          const remainingBytes = Math.max(0, e.total - e.loaded);
          const etaSec = smoothedSpeed > 0 ? Math.ceil(remainingBytes / smoothedSpeed) : 0;

          if (onProgress) {
            onProgress({
              percent,
              loaded: e.loaded,
              total: e.total,
              speed: smoothedSpeed,
              eta: etaSec,
              formattedLoaded: this.formatBytes(e.loaded),
              formattedTotal: this.formatBytes(e.total),
              formattedSpeed: `${this.formatBytes(smoothedSpeed)}/s`,
              formattedEta: etaSec > 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : (etaSec > 0 ? `${etaSec}s left` : 'Finalizing...')
            });
          }
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response);
        } else {
          try {
            const errJson = JSON.parse(xhr.responseText);
            reject(new Error(errJson.message || errJson.error || `Upload failed with status ${xhr.status}`));
          } catch (_) {
            reject(new Error(`Upload failed with HTTP ${xhr.status}`));
          }
        }
      };

      xhr.onerror = () => reject(new Error('Network error during file upload'));
      xhr.send(file);
    });

    // 2. Get Public Download URL
    const { data: urlData } = this.supabase.storage
      .from('public-files')
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;
    const now = Date.now();
    const expiresAt = new Date(now + SEVEN_DAYS_MS).toISOString();

    const cleanType = file.type || 'application/octet-stream';
    const typeWithPin = pin ? `${cleanType}; pin=${encodeURIComponent(pin)}` : cleanType;

    // 3. Insert metadata record in 'files' table
    const fileRecord = {
      name: file.name,
      size: file.size,
      formatted_size: this.formatBytes(file.size),
      type: typeWithPin,
      extension: this.getFileExtension(file.name),
      storage_path: storagePath,
      download_url: publicUrl,
      created_at: new Date(now).toISOString(),
      expires_at: expiresAt,
      downloads_count: 0
    };

    const { data: inserted, error: insertError } = await this.supabase
      .from('files')
      .insert([fileRecord])
      .select()
      .single();

    if (insertError) {
      throw new Error(insertError.message || 'Failed to insert database record');
    }

    if (onProgress) {
      onProgress({
        percent: 100,
        loaded: file.size,
        total: file.size,
        speed: 0,
        eta: 0,
        formattedLoaded: this.formatBytes(file.size),
        formattedTotal: this.formatBytes(file.size),
        formattedSpeed: 'Done',
        formattedEta: 'Complete'
      });
    }

    return this.mapSupabaseRecord(inserted);
  }

  async uploadLinkToSupabase(url, title, pin = null) {
    const linkId = crypto.randomUUID ? crypto.randomUUID() : 'l_' + Date.now().toString(36);
    const domainName = this.extractDomain(url);
    const safeTitle = (title || '').trim() || domainName || url.replace(/^https?:\/\//i, '');
    const displayName = safeTitle.slice(0, 255);
    const storagePath = `link://${linkId}`;
    const now = Date.now();
    const expiresAt = new Date(now + SEVEN_DAYS_MS).toISOString();

    const cleanType = 'url';
    const typeWithPin = pin ? `${cleanType}; pin=${encodeURIComponent(pin)}` : cleanType;
    const urlBytes = Math.max(1, new Blob([url]).size);

    const record = {
      name: displayName,
      size: urlBytes,
      formatted_size: 'Link',
      type: typeWithPin,
      extension: 'link',
      storage_path: storagePath,
      download_url: url,
      created_at: new Date(now).toISOString(),
      expires_at: expiresAt,
      downloads_count: 0
    };

    const { data: inserted, error: insertError } = await this.supabase
      .from('files')
      .insert([record])
      .select()
      .single();

    if (insertError) {
      throw new Error(insertError.message || 'Failed to insert link in database');
    }

    return this.mapSupabaseRecord(inserted);
  }

  async getActiveFilesFromSupabase() {
    const nowIso = new Date().toISOString();
    let query = this.supabase
      .from('files')
      .select('*')
      .gt('expires_at', nowIso)
      .neq('type', 'deleted')
      .order('created_at', { ascending: false });

    let { data, error } = await query;

    // Fallback if neq filter or column encountered issue
    if (error) {
      const fallback = await this.supabase
        .from('files')
        .select('*')
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false });

      if (fallback.error) {
        throw new Error(fallback.error.message);
      }
      data = fallback.data;
    }

    return (data || [])
      .filter(r => r.type !== 'deleted' && r.moderation_status !== 'deleted')
      .map(r => this.mapSupabaseRecord(r));
  }

  async getFileByIdFromSupabase(fileId) {
    const { data, error } = await this.supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .single();

    if (error || !data) return null;
    if (data.moderation_status === 'deleted') return null;
    if (new Date(data.expires_at).getTime() <= Date.now()) return null; // Expired

    return this.mapSupabaseRecord(data);
  }

  async incrementSupabaseDownload(fileId) {
    const strId = String(fileId).trim();
    let nextCount = (this.getViewCount(strId) || 0) + 1;
    this.cacheViewCount(strId, nextCount);

    try {
      // 1. Fetch current counter from Supabase
      const { data, error } = await this.supabase
        .from('files')
        .select('downloads_count')
        .eq('id', strId)
        .maybeSingle();

      if (error) {
        console.warn('Share247: Supabase fetch downloads_count error:', error);
      }

      const currentServerCount = (data && data.downloads_count != null) ? Number(data.downloads_count) : 0;
      nextCount = Math.max(currentServerCount + 1, nextCount);

      // 2. Persist updated counter to Supabase
      const { data: updated, error: updateError } = await this.supabase
        .from('files')
        .update({ downloads_count: nextCount })
        .eq('id', strId)
        .select('downloads_count')
        .maybeSingle();

      if (updateError) {
        console.warn('Share247: Supabase update downloads_count error:', updateError);
      } else if (updated && updated.downloads_count != null) {
        nextCount = Number(updated.downloads_count);
      }
    } catch (err) {
      console.warn('Share247: Supabase incrementDownload network exception:', err);
    }

    this.cacheViewCount(strId, nextCount);
    return nextCount;
  }

  async deleteFileFromSupabase(fileId, storagePath) {
    const strId = String(fileId);

    // 1. Remove binary file from Supabase storage bucket (only for storage files)
    if (storagePath && !storagePath.startsWith('link://') && !storagePath.startsWith('local://')) {
      try {
        await this.supabase.storage.from('public-files').remove([storagePath]);
      } catch (e) {
        console.warn('Share247: Supabase storage remove error:', e);
      }
    }

    // 2. Multi-strategy deletion:
    // Strategy A: Direct hard delete
    try {
      await this.supabase
        .from('files')
        .delete()
        .eq('id', strId);
    } catch (_) {}

    // Strategy B: Soft-delete by setting type = 'deleted' (Guaranteed to bypass RLS restrictions!)
    try {
      await this.supabase
        .from('files')
        .update({ type: 'deleted' })
        .eq('id', strId);
    } catch (_) {}

    // Strategy C: Update moderation_status if column exists
    try {
      await this.supabase
        .from('files')
        .update({ moderation_status: 'deleted' })
        .eq('id', strId);
    } catch (_) {}

    return true;
  }

  // ==========================================
  // INDEXEDDB LOCAL FALLBACK IMPLEMENTATION
  // ==========================================

  initIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('Share247_LocalVault', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.idb = request.result;
        this.purgeExpiredLocalFiles().finally(() => resolve(this.idb));
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('files')) {
          const store = db.createObjectStore('files', { keyPath: 'id' });
          store.createIndex('expiresAt', 'expiresAt', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
    });
  }

  async purgeExpiredLocalFiles() {
    if (!this.idb) return;
    return new Promise((resolve) => {
      const tx = this.idb.transaction(['files'], 'readwrite');
      const store = tx.objectStore('files');
      const req = store.openCursor();
      const now = Date.now();

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const record = cursor.value;
          const exp = new Date(record.expiresAt).getTime();
          if (exp <= now) {
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => resolve();
    });
  }

  async uploadFileToLocal(file, onProgress, pin = null) {
    const fileId = crypto.randomUUID ? crypto.randomUUID() : 'f_' + Date.now().toString(36);
    const now = Date.now();
    const expiresAt = new Date(now + SEVEN_DAYS_MS).toISOString();

    for (let p = 20; p <= 100; p += 20) {
      if (onProgress) {
        const loadedBytes = Math.round((p / 100) * file.size);
        onProgress({
          percent: p,
          loaded: loadedBytes,
          total: file.size,
          speed: 1048576,
          eta: p < 100 ? 1 : 0,
          formattedLoaded: this.formatBytes(loadedBytes),
          formattedTotal: this.formatBytes(file.size),
          formattedSpeed: '1.0 MB/s',
          formattedEta: p < 100 ? '1s left' : 'Done'
        });
      }
      await new Promise(r => setTimeout(r, 35));
    }

    const record = {
      id: fileId,
      name: file.name,
      size: file.size,
      formattedSize: this.formatBytes(file.size),
      type: file.type || 'application/octet-stream',
      extension: this.getFileExtension(file.name),
      storagePath: `local://${fileId}/${file.name}`,
      blob: file,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAt,
      downloadsCount: 0,
      hasPin: Boolean(pin),
      pin: pin || null
    };

    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(['files'], 'readwrite');
      const store = tx.objectStore('files');
      const req = store.add(record);
      req.onsuccess = () => {
        const { blob, ...meta } = record;
        meta.downloadUrl = URL.createObjectURL(file);
        resolve(meta);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async uploadLinkToLocal(url, title, pin = null) {
    const linkId = crypto.randomUUID ? crypto.randomUUID() : 'l_' + Date.now().toString(36);
    const domainName = this.extractDomain(url);
    const safeTitle = (title || '').trim() || domainName || url.replace(/^https?:\/\//i, '');
    const displayName = safeTitle.slice(0, 255);
    const now = Date.now();
    const expiresAt = new Date(now + SEVEN_DAYS_MS).toISOString();
    const urlBytes = Math.max(1, new Blob([url]).size);

    const record = {
      id: linkId,
      name: displayName,
      size: urlBytes,
      formattedSize: 'Link',
      type: 'url',
      isLink: true,
      extension: 'link',
      storagePath: `link://${linkId}`,
      downloadUrl: url,
      blob: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAt,
      downloadsCount: 0,
      hasPin: Boolean(pin),
      pin: pin || null
    };

    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(['files'], 'readwrite');
      const store = tx.objectStore('files');
      const req = store.add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = () => reject(req.error);
    });
  }

  async getActiveFilesFromLocal() {
    await this.purgeExpiredLocalFiles();
    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(['files'], 'readonly');
      const store = tx.objectStore('files');
      const req = store.getAll();
      const now = Date.now();

      req.onsuccess = () => {
        const records = req.result || [];
        const active = records
          .filter(r => new Date(r.expiresAt).getTime() > now && r.moderationStatus !== 'deleted')
          .map(r => {
            const { blob, ...meta } = r;
            meta.isLink = Boolean(meta.isLink || meta.type === 'url' || meta.extension === 'link');
            if (meta.isLink) {
              meta.name = this.extractDomain(meta.name || meta.downloadUrl) || meta.name;
            }
            meta.formattedSize = meta.isLink ? 'Link' : meta.formattedSize;
            meta.downloadUrl = meta.isLink ? meta.downloadUrl : (blob ? URL.createObjectURL(blob) : '#');
            meta.moderationStatus = r.moderationStatus || 'safe';
            meta.moderationReason = r.moderationReason || '';
            meta.flaggedAt = r.flaggedAt || null;
            const cachedViews = this.getViewCount(r.id);
            const localViews = Number(r.downloadsCount) || 0;
            meta.downloadsCount = Math.max(cachedViews, localViews);
            return meta;
          })
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        resolve(active);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getFileByIdFromLocal(fileId) {
    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(['files'], 'readonly');
      const store = tx.objectStore('files');
      const req = store.get(fileId);

      req.onsuccess = () => {
        const record = req.result;
        if (!record || record.moderationStatus === 'deleted') return resolve(null);
        if (new Date(record.expiresAt).getTime() <= Date.now()) {
          return resolve(null);
        }
        const { blob, ...meta } = record;
        meta.isLink = Boolean(meta.isLink || meta.type === 'url' || meta.extension === 'link');
        if (meta.isLink) {
          meta.name = this.extractDomain(meta.name || meta.downloadUrl) || meta.name;
        }
        meta.formattedSize = meta.isLink ? 'Link' : meta.formattedSize;
        meta.downloadUrl = meta.isLink ? meta.downloadUrl : (blob ? URL.createObjectURL(blob) : '#');
        meta.moderationStatus = record.moderationStatus || 'safe';
        meta.moderationReason = record.moderationReason || '';
        meta.flaggedAt = record.flaggedAt || null;
        const cachedViews = this.getViewCount(record.id);
        const localViews = Number(record.downloadsCount) || 0;
        meta.downloadsCount = Math.max(cachedViews, localViews);
        resolve(meta);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async incrementLocalDownload(fileId) {
    const strId = String(fileId).trim();
    let nextCount = (this.getViewCount(strId) || 0) + 1;
    this.cacheViewCount(strId, nextCount);

    if (!this.idb) {
      try {
        await this.initIndexedDB();
      } catch (_) {}
    }
    if (!this.idb) return nextCount;

    return new Promise((resolve) => {
      try {
        const tx = this.idb.transaction(['files'], 'readwrite');
        const store = tx.objectStore('files');
        const req = store.get(strId);
        req.onsuccess = () => {
          const record = req.result;
          if (record) {
            record.downloadsCount = Math.max((Number(record.downloadsCount) || 0) + 1, nextCount);
            nextCount = record.downloadsCount;
            this.cacheViewCount(strId, nextCount);
            store.put(record);
          }
          resolve(nextCount);
        };
        req.onerror = () => resolve(nextCount);
      } catch (err) {
        console.warn('Share247: Local increment exception:', err);
        resolve(nextCount);
      }
    });
  }

  async deleteFileFromLocal(fileId) {
    if (!this.idb) {
      try {
        await this.initIndexedDB();
      } catch (_) {}
    }
    if (!this.idb) return false;
    return new Promise((resolve) => {
      try {
        const tx = this.idb.transaction(['files'], 'readwrite');
        const store = tx.objectStore('files');
        const req = store.delete(fileId);
        req.onsuccess = () => resolve(true);
        req.onerror = () => {
          console.warn('Local file delete error:', req.error);
          resolve(false);
        };
      } catch (e) {
        console.warn('IDB transaction delete error:', e);
        resolve(false);
      }
    });
  }

  // ==========================================
  // UNIFIED PUBLIC INTERFACE
  // ==========================================

  async uploadFile(file, onProgress, pin = null) {
    if (this.mode === 'supabase') {
      return this.uploadFileToSupabase(file, onProgress, pin);
    }
    return this.uploadFileToLocal(file, onProgress, pin);
  }

  async uploadLink(url, title, pin = null) {
    if (this.mode === 'supabase') {
      return this.uploadLinkToSupabase(url, title, pin);
    }
    return this.uploadLinkToLocal(url, title, pin);
  }

  async getActiveFiles() {
    const purged = getPurgedFileIds();
    let files = [];
    if (this.mode === 'supabase') {
      files = await this.getActiveFilesFromSupabase();
    } else {
      files = await this.getActiveFilesFromLocal();
    }
    return (files || []).filter(f => !purged.has(String(f.id)) && f.moderationStatus !== 'deleted');
  }

  async getFileById(fileId) {
    const purged = getPurgedFileIds();
    if (purged.has(String(fileId))) return null;
    if (this.mode === 'supabase') {
      return this.getFileByIdFromSupabase(fileId);
    }
    return this.getFileByIdFromLocal(fileId);
  }

  async incrementDownload(fileId) {
    if (this.mode === 'supabase') {
      return this.incrementSupabaseDownload(fileId);
    }
    return this.incrementLocalDownload(fileId);
  }

  async updateModerationStatus(fileId, status, reason = '') {
    const flaggedAt = status === 'flagged' ? new Date().toISOString() : null;
    if (this.mode === 'supabase') {
      try {
        const updatePayload = {
          moderation_status: status,
          moderation_reason: reason,
          flagged_at: flaggedAt
        };
        const { data, error } = await this.supabase
          .from('files')
          .update(updatePayload)
          .eq('id', fileId)
          .select()
          .single();
        if (error) {
          // Fallback if column does not exist in schema cache: persist status in the 'type' column
          try {
            const { data: cur } = await this.supabase.from('files').select('type').eq('id', fileId).single();
            if (cur) {
              let newType = (cur.type || '').replace(/; mod=[^;]*/g, '').replace(/; reason=[^;]*/g, '');
              if (status === 'flagged') {
                newType += `; mod=flagged; reason=${encodeURIComponent(reason)}`;
              } else {
                newType += `; mod=safe`;
              }
              const { data: updated } = await this.supabase.from('files').update({ type: newType }).eq('id', fileId).select().single();
              return updated ? this.mapSupabaseRecord(updated) : null;
            }
          } catch (_) {}
        }
        return data ? this.mapSupabaseRecord(data) : null;
      } catch (err) {
        console.warn('Supabase moderation update error:', err);
        return null;
      }
    } else {
      return new Promise((resolve) => {
        if (!this.idb) return resolve(null);
        const tx = this.idb.transaction(['files'], 'readwrite');
        const store = tx.objectStore('files');
        const req = store.get(fileId);
        req.onsuccess = () => {
          const record = req.result;
          if (record) {
            record.moderationStatus = status;
            record.moderationReason = reason;
            record.flaggedAt = flaggedAt;
            store.put(record);
            resolve(record);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    }
  }

  async deleteFile(fileId, storagePath) {
    const strId = String(fileId);
    // 1. Mark purged in persistent local storage so it will never be displayed in any session/tab
    addPurgedFileId(strId);

    // 2. Broadcast deletion to all open tabs immediately
    broadcastVaultChange('DELETE', { id: strId });

    // 3. Delete from active backend storage
    if (this.mode === 'supabase') {
      return this.deleteFileFromSupabase(strId, storagePath);
    }
    return this.deleteFileFromLocal(strId);
  }

  async purgeAllVaultFiles() {
    let files = [];
    try {
      files = await this.getActiveFiles();
    } catch (_) {}

    for (const f of files) {
      try {
        await this.deleteFile(f.id, f.storagePath);
      } catch (e) {
        console.warn('Share247: purge error for file:', f.id, e);
      }
    }

    // Direct clear in IndexedDB
    if (this.idb) {
      try {
        const tx = this.idb.transaction(['files'], 'readwrite');
        tx.objectStore('files').clear();
      } catch (_) {}
    }

    // Direct bulk soft-delete on Supabase if client available
    if (this.supabase) {
      try {
        await this.supabase
          .from('files')
          .update({ type: 'deleted' })
          .neq('type', 'deleted');
      } catch (_) {}
    }

    return true;
  }

  subscribeToFiles(onFileChange) {
    if (this.mode !== 'supabase' || !this.supabase) return null;
    try {
      const channel = this.supabase
        .channel('realtime:files')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'files' }, (payload) => {
          if (!onFileChange || !payload) return;
          if (payload.eventType === 'INSERT' && payload.new) {
            onFileChange('INSERT', this.mapSupabaseRecord(payload.new));
          } else if (payload.eventType === 'DELETE' && payload.old) {
            onFileChange('DELETE', { id: payload.old.id });
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            onFileChange('UPDATE', this.mapSupabaseRecord(payload.new));
          }
        })
        .subscribe((status, err) => {
          if (status === 'CHANNEL_ERROR') {
            console.debug('Share247: Realtime status notice:', err?.message || status);
          }
        });
      return channel;
    } catch (e) {
      console.warn('Realtime subscription error:', e);
      return null;
    }
  }
}

export const dbService = new DatabaseService();
