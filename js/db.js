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
    const fileId = crypto.randomUUID ? crypto.randomUUID() : 'f_' + Date.now().toString(36);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${fileId}/${safeName}`;

    // Simulate progress updates for UI feedback
    if (onProgress) onProgress(20);

    // 1. Upload binary file to 'public-files' storage bucket
    const { data: uploadData, error: uploadError } = await this.supabase.storage
      .from('public-files')
      .upload(storagePath, file, {
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      throw new Error(uploadError.message || 'Storage upload failed');
    }

    if (onProgress) onProgress(70);

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

    if (onProgress) onProgress(100);

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
}

export const dbService = new DatabaseService();
