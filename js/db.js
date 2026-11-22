/**
 * Share247 - Database & Storage Service (Supabase & Local Vault)
 * Supports:
 * 1. Live Supabase (PostgreSQL + Supabase Storage) with 7-Day Auto-Purge
 * 2. Seamless IndexedDB Fallback (Instant offline demo & local testing)
 */

import { getStoredSupabaseConfig, isSupabaseConfigured } from './config.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

  // ==========================================
  // SUPABASE IMPLEMENTATION
  // ==========================================

  async initSupabase(config) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  }

  mapSupabaseRecord(r) {
    if (!r) return null;
    const rawType = r.type || '';
    const hasPinInType = rawType.includes('; pin=');
    const pinVal = r.pin || (hasPinInType ? decodeURIComponent(rawType.split('; pin=')[1]) : null);
    const cleanType = rawType.split(';')[0];

    return {
      id: r.id,
      name: r.name,
      size: r.size,
      formattedSize: r.formatted_size,
      type: cleanType,
      extension: r.extension,
      storagePath: r.storage_path,
      downloadUrl: r.download_url,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      downloadsCount: r.downloads_count,
      hasPin: Boolean(pinVal),
      pin: pinVal
    };
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

  async getActiveFilesFromSupabase() {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('files')
      .select('*')
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    return (data || []).map(r => this.mapSupabaseRecord(r));
  }

  async getFileByIdFromSupabase(fileId) {
    const { data, error } = await this.supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .single();

    if (error || !data) return null;
    if (new Date(data.expires_at).getTime() <= Date.now()) return null; // Expired

    return this.mapSupabaseRecord(data);
  }

  async incrementSupabaseDownload(fileId) {
    // Increment download counter
    const { data } = await this.supabase
      .from('files')
      .select('downloads_count')
      .eq('id', fileId)
      .single();

    if (data) {
      await this.supabase
        .from('files')
        .update({ downloads_count: (data.downloads_count || 0) + 1 })
        .eq('id', fileId);
    }
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

  async uploadFileToLocal(file, onProgress) {
    const fileId = crypto.randomUUID ? crypto.randomUUID() : 'f_' + Date.now().toString(36);
    const now = Date.now();
    const expiresAt = new Date(now + SEVEN_DAYS_MS).toISOString();

    for (let p = 20; p <= 100; p += 25) {
      if (onProgress) onProgress(p);
      await new Promise(r => setTimeout(r, 40));
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
          .filter(r => new Date(r.expiresAt).getTime() > now)
          .map(r => {
            const { blob, ...meta } = r;
            meta.downloadUrl = blob ? URL.createObjectURL(blob) : '#';
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
        if (!record) return resolve(null);
        if (new Date(record.expiresAt).getTime() <= Date.now()) {
          return resolve(null);
        }
        const { blob, ...meta } = record;
        meta.downloadUrl = blob ? URL.createObjectURL(blob) : '#';
        resolve(meta);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async incrementLocalDownload(fileId) {
    return new Promise((resolve) => {
      const tx = this.idb.transaction(['files'], 'readwrite');
      const store = tx.objectStore('files');
      const req = store.get(fileId);
      req.onsuccess = () => {
        const record = req.result;
        if (record) {
          record.downloadsCount = (record.downloadsCount || 0) + 1;
          store.put(record);
        }
        resolve();
      };
      req.onerror = () => resolve();
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

  async getActiveFiles() {
    if (this.mode === 'supabase') {
      return this.getActiveFilesFromSupabase();
    }
    return this.getActiveFilesFromLocal();
  }

  async getFileById(fileId) {
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

  subscribeToFiles(onFileAdded) {
    if (this.mode !== 'supabase' || !this.supabase) return null;
    try {
      const channel = this.supabase
        .channel('realtime:files')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'files' }, (payload) => {
          if (payload && payload.new) {
            const mapped = this.mapSupabaseRecord(payload.new);
            if (onFileAdded) onFileAdded(mapped);
          }
        })
        .subscribe();
      return channel;
    } catch (e) {
      console.warn('Realtime subscription error:', e);
      return null;
    }
  }
}

export const dbService = new DatabaseService();
