/**
 * Share247 - Configuration Manager
 * Live Supabase Project Credentials
 */

export const DEFAULT_SUPABASE_CONFIG = {
  supabaseUrl: "__SUPABASE_URL__",
  supabaseAnonKey: "__SUPABASE_ANON_KEY__"
};

const STORAGE_KEY = "share247_supabase_config";

export function getStoredSupabaseConfig() {
  // If live credentials have been injected during build, ALWAYS prioritize them
  if (isSupabaseConfigured(DEFAULT_SUPABASE_CONFIG)) {
    return DEFAULT_SUPABASE_CONFIG;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && isSupabaseConfigured(parsed)) {
        return parsed;
      }
      // Clean up invalid or placeholder configurations from previous builds
      localStorage.removeItem(STORAGE_KEY);
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
    !config.supabaseUrl.includes("YOUR_") &&
    !config.supabaseUrl.includes("__SUPABASE_")
  );
}
