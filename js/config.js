/**
 * Share247 - Configuration Manager
 * Manages Supabase Project URL and Anon Public API Key with localStorage persistence.
 */

export const DEFAULT_SUPABASE_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: ""
};

const STORAGE_KEY = "share247_supabase_config";

export function getStoredSupabaseConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.supabaseUrl && parsed.supabaseAnonKey) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn("Could not read stored Supabase config:", e);
  }
  return DEFAULT_SUPABASE_CONFIG;
}

export function saveStoredSupabaseConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return true;
  } catch (e) {
    console.error("Could not save Supabase config:", e);
    return false;
  }
}

export function clearStoredSupabaseConfig() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

export function isSupabaseConfigured(config) {
  return Boolean(
    config &&
    config.supabaseUrl &&
    config.supabaseAnonKey &&
    config.supabaseUrl.startsWith("https://") &&
    !config.supabaseUrl.includes("YOUR_")
  );
}
