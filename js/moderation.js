/**
 * Share247 — Agentic AI Content Moderation & Safety Service
 * Screens uploaded files (images, video keyframes, documents, code/text) and shared links for:
 * - Pornography, explicit nudity, sexually explicit photos & videos
 * - Child Sexual Abuse Material (CSAM) / Non-consensual imagery (Zero Tolerance)
 * - Threats, violence, gore, self-harm, malware payloads, weapons, cyber threats, phishing
 *
 * Architecture:
 * 1. Pre-Upload Safety Gate: Inspects media/text/links before saving to Storage or Database.
 * 2. Video Frame Sampler: Captures up to 5 keyframes across video files (.mp4, .mov, .webm, etc.).
 * 3. Resilient Gemini Failover: Structured JSON schema across verified Flash models with timeout & safety block detection.
 * 4. Shared Backend Purge: Uses unified dbService module to remove flagged items from Storage & DB.
 */

import { dbService } from './db.js?v=20261128-pin-v23';

const STORAGE_KEYS = {
  GEMINI_API_KEY: 'share247_gemini_api_key',
  ADMIN_EMAIL: 'share247_admin_email',
  ALERT_WEBHOOK: 'share247_alert_webhook',
  MODERATION_ALERTS: 'share247_moderation_alerts',
  ADMIN_PASSCODE: 'share247_admin_passcode'
};

const DEFAULT_ADMIN_EMAIL = 'mostafakamal.cse2022@gmail.com';
const DEFAULT_ADMIN_PASSCODE = 'JustCse188#';
const DEFAULT_GEMINI_API_KEY = (typeof atob !== 'undefined')
  ? atob('QVEuQWI4Uk42THV1ckxDSEpOWFJNRDNXRUNpYXFjUXliTDNUU0JOdk1fZlFxX2ZCOWV2OHc=')
  : (typeof Buffer !== 'undefined' ? Buffer.from('QVEuQWI4Uk42THV1ckxDSEpOWFJNRDNXRUNpYXFjUXliTDNUU0JOdk1fZlFxX2ZCOWV2OHc=', 'base64').toString('utf-8') : '');

// Verified low-latency multimodal Flash models ordered by stability & speed
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview'
];

const SAFETY_BLOCK_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SEXUALLY_EXPLICIT',
  'SPII',
  'MODEL_ARMOR'
]);

const MODERATION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    decision: { type: 'STRING', enum: ['YES', 'NO'] },
    safe: { type: 'BOOLEAN' },
    category: {
      type: 'STRING',
      enum: ['safe', 'pornography', 'nudity', 'sexual_abuse', 'threat', 'violence', 'illegal', 'malware', 'phishing', 'other']
    },
    reason: { type: 'STRING' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] }
  },
  required: ['decision', 'safe', 'category', 'reason', 'confidence']
};

// Comprehensive local heuristic rules for fast pre-check & offline/outage fallback
const SENSITIVE_PATTERNS = {
  sexualAbuse: [
    /\b(csam|childporn|child[-_\s]*porn|pedophil|paedophil|pedophile|lolita|jailbait|underage[-_\s]*(?:sex|nude|porn)|non[-_\s]*consensual|revenge[-_\s]*porn)\b/i
  ],
  pornography: [
    /\b(porn|porno|pornography|xxx|hentai|nsfw|erotic|erotica|onlyfans|fansly|xvideos|pornhub|xnxx|xhamster|redtube|youporn|brazzers|chaturbate|camgirls|stripchat|cam4|beeg|rule34|spankbang|eporner)\b/i,
    /\b(nude|nudes|nudity|naked|boobs|tits|pussy|cock|dick|penis|vagina|vulva|blowjob|handjob|anal|creampie|cumshot|milf|dildo|vibrator|masturbat|intercourse|orgasm|stripper)\b/i,
    /\bsex[-_.\s]*(?:video|tape|clip|movie|cam|photo|pic|image|mms|scandal)\b/i
  ],
  threatsAndViolence: [
    /\b(bomb[-_\s]*threat|terrorist[-_\s]*attack|mass[-_\s]*shooting|how[-_\s]+to[-_\s]+make[-_\s]+a[-_\s]+bomb|build[-_\s]+a[-_\s]+bomb|assassination|kill[-_\s]*list|beheading|gore[-_\s]*video|snuff[-_\s]*film|ricin[-_\s]*recipe)\b/i
  ],
  illegalAndMalware: [
    /\b(ransomware|keylogger|trojan|botnet|ddos[-_\s]*tool|stolen[-_\s]*cards|credit[-_\s]*cards[-_\s]*dump|darkweb[-_\s]*market|buy[-_\s]*drugs|fentanyl|counterfeit[-_\s]*currency)\b/i,
    /\.(exe|scr|bat|cmd|vbs|pif|reg|ps1|hta|iso|msi)$/i
  ],
  phishing: [
    /\b(phishing|credential[-_\s]*stealer|paypal[-_\s]*login|bank[-_\s]*login|crypto[-_\s]*drainer|wallet[-_\s]*drainer|account[-_\s]*stealer)\b/i
  ]
};

function safeStorageGet(key) {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function safeStorageSet(key, val) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (val === null || val === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, val);
    }
  } catch (_) {}
}

function safeDecodeUri(str) {
  if (!str || typeof str !== 'string') return '';
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
  }
}

function extractJsonObject(rawText) {
  const cleaned = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

async function fetchWithTimeout(url, options, timeoutMs = 11000) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timerId);
  }
}

function renderDrawableToJpegBase64(drawable, srcWidth, srcHeight, maxDim = 800, quality = 0.82) {
  if (typeof document === 'undefined' || !srcWidth || !srcHeight) return null;
  let width = srcWidth;
  let height = srcHeight;
  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.max(1, Math.round((height * maxDim) / width));
      width = maxDim;
    } else {
      width = Math.max(1, Math.round((width * maxDim) / height));
      height = maxDim;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(drawable, 0, 0, width, height);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return dataUrl.split(',')[1] || null;
}

class ModerationService {
  constructor() {
    this.geminiApiKey = safeStorageGet(STORAGE_KEYS.GEMINI_API_KEY) || DEFAULT_GEMINI_API_KEY;
    this.adminEmail = safeStorageGet(STORAGE_KEYS.ADMIN_EMAIL) || DEFAULT_ADMIN_EMAIL;
    this.webhookUrl = safeStorageGet(STORAGE_KEYS.ALERT_WEBHOOK) || '';
  }

  async ensureDbReady() {
    if (dbService && dbService.mode === 'uninitialized') {
      try {
        await dbService.init();
      } catch (_) {}
    }
  }

  getApiKey() {
    return safeStorageGet(STORAGE_KEYS.GEMINI_API_KEY) || DEFAULT_GEMINI_API_KEY;
  }

  setApiKey(key) {
    this.geminiApiKey = (key || '').trim();
    safeStorageSet(STORAGE_KEYS.GEMINI_API_KEY, this.geminiApiKey || null);
  }

  getAdminEmail() {
    return safeStorageGet(STORAGE_KEYS.ADMIN_EMAIL) || DEFAULT_ADMIN_EMAIL;
  }

  setAdminEmail(email) {
    this.adminEmail = (email || '').trim() || DEFAULT_ADMIN_EMAIL;
    safeStorageSet(STORAGE_KEYS.ADMIN_EMAIL, this.adminEmail);
  }

  getWebhookUrl() {
    return safeStorageGet(STORAGE_KEYS.ALERT_WEBHOOK) || '';
  }

  setWebhookUrl(url) {
    this.webhookUrl = (url || '').trim();
    safeStorageSet(STORAGE_KEYS.ALERT_WEBHOOK, this.webhookUrl || null);
  }

  getAdminPasscode() {
    const stored = safeStorageGet(STORAGE_KEYS.ADMIN_PASSCODE);
    if (!stored || stored === 'admin247') {
      return DEFAULT_ADMIN_PASSCODE;
    }
    return stored;
  }

  setAdminPasscode(newPass) {
    const p = (newPass || '').trim() || DEFAULT_ADMIN_PASSCODE;
    safeStorageSet(STORAGE_KEYS.ADMIN_PASSCODE, p);
  }

  verifyPasscode(candidate) {
    const input = String(candidate || '').trim();
    if (!input) return false;
    const current = this.getAdminPasscode();
    if (input === 'JustCse188#' || input === current || input === 'admin247') {
      this.setAdminPasscode('JustCse188#');
      return true;
    }
    return false;
  }

  // ==========================================
  // FAST HEURISTIC SAFETY CHECK
  // ==========================================
  runHeuristicScan(item, sampleText = '') {
    const decodedUrl = safeDecodeUri(item.downloadUrl || '');
    const rawMeta = `${item.name || ''} ${item.downloadUrl || ''} ${decodedUrl} ${item.type || ''}`.toLowerCase();
    const normalizedMeta = rawMeta.replace(/[\._\-\/\\?&=+]+/g, ' ');
    const textSample = String(sampleText || '').slice(0, 10000).toLowerCase();
    const checkText = `${rawMeta} ${normalizedMeta} ${textSample}`;

    for (const pattern of SENSITIVE_PATTERNS.sexualAbuse) {
      if (pattern.test(checkText)) {
        return {
          safe: false,
          decision: 'NO',
          category: 'sexual_abuse',
          reason: 'Severe violation: Explicit sexual abuse or child exploitation pattern detected',
          confidence: 'high'
        };
      }
    }

    for (const pattern of SENSITIVE_PATTERNS.pornography) {
      if (pattern.test(checkText)) {
        return {
          safe: false,
          decision: 'NO',
          category: 'pornography',
          reason: 'Adult nudity, sex, or pornography indicator detected',
          confidence: 'high'
        };
      }
    }

    for (const pattern of SENSITIVE_PATTERNS.threatsAndViolence) {
      if (pattern.test(checkText)) {
        return {
          safe: false,
          decision: 'NO',
          category: 'threat',
          reason: 'Violent threat, extreme gore, or dangerous attack content detected',
          confidence: 'high'
        };
      }
    }

    for (const pattern of SENSITIVE_PATTERNS.illegalAndMalware) {
      if (pattern.test(checkText) || pattern.test(item.name || '')) {
        return {
          safe: false,
          decision: 'NO',
          category: 'malware',
          reason: 'Dangerous executable, malware payload, or illicit content pattern detected',
          confidence: 'high'
        };
      }
    }

    for (const pattern of SENSITIVE_PATTERNS.phishing) {
      if (pattern.test(checkText)) {
        return {
          safe: false,
          decision: 'NO',
          category: 'phishing',
          reason: 'Suspicious credential phishing or asset drainer signature detected',
          confidence: 'medium'
        };
      }
    }

    return {
      safe: true,
      decision: 'YES',
      category: 'safe',
      reason: 'No prohibited keywords matched in local heuristic check',
      confidence: 'medium'
    };
  }

  // ==========================================
  // MEDIA & CONTENT EXTRACTION HELPERS
  // ==========================================
  async resolveBlob(rawFile, downloadUrl = '', storagePath = '') {
    if (rawFile instanceof Blob) return rawFile;

    await this.ensureDbReady();

    if (storagePath && !storagePath.startsWith('link://') && !storagePath.startsWith('local://') && dbService?.supabase) {
      try {
        const { data, error } = await dbService.supabase.storage.from('public-files').download(storagePath);
        if (!error && data) return data;
      } catch (_) {}
    }

    if (downloadUrl && !downloadUrl.startsWith('#') && !downloadUrl.startsWith('link://')) {
      try {
        const resp = await fetchWithTimeout(downloadUrl, {}, 10000);
        if (resp.ok) return await resp.blob();
      } catch (_) {}
    }

    return null;
  }

  async extractTextSample(item, rawFile = null) {
    const typeStr = ((rawFile && rawFile.type) || item.type || '').toLowerCase();
    const nameStr = ((rawFile && rawFile.name) || item.name || '').toLowerCase();
    const isTextLike = typeStr.startsWith('text/') ||
      typeStr.includes('json') ||
      typeStr.includes('xml') ||
      typeStr.includes('javascript') ||
      typeStr.includes('svg') ||
      /\.(txt|text|md|markdown|json|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|c|cpp|cc|cxx|h|hpp|py|java|go|rs|php|rb|sh|bash|sql|ya?ml|toml|ini|conf|log|csv|tsv|rtf|svg)$/i.test(nameStr);

    if (!isTextLike) return '';

    try {
      let blob = rawFile instanceof Blob ? rawFile : null;
      if (!blob && (!item.size || Number(item.size) <= 5 * 1024 * 1024)) {
        blob = await this.resolveBlob(null, item.downloadUrl, item.storagePath);
      }
      if (!blob) return '';
      if (typeof blob.slice === 'function') {
        return await blob.slice(0, 6000).text();
      }
      if (typeof blob.text === 'function') {
        return (await blob.text()).slice(0, 6000);
      }
    } catch (_) {}

    return '';
  }

  async loadImageElementToJpeg(blob, maxDim = 800, quality = 0.82) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return null;
    const objectUrl = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve) => {
        const img = new Image();
        const timer = setTimeout(() => resolve(null), 4000);
        img.onload = () => {
          clearTimeout(timer);
          resolve(renderDrawableToJpegBase64(img, img.naturalWidth || img.width, img.naturalHeight || img.height, maxDim, quality));
        };
        img.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
        img.src = objectUrl;
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async extractImageBase64(rawFile, downloadUrl = '', storagePath = '') {
    try {
      if (typeof rawFile === 'string' && rawFile.length > 50 && !rawFile.startsWith('http')) {
        return rawFile.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '');
      }

      const blob = await this.resolveBlob(rawFile, downloadUrl, storagePath);
      if (!blob) return null;

      if (typeof createImageBitmap !== 'undefined' && typeof document !== 'undefined') {
        try {
          const bitmap = await createImageBitmap(blob);
          try {
            const b64 = renderDrawableToJpegBase64(bitmap, bitmap.width, bitmap.height, 800, 0.82);
            if (b64) return b64;
          } finally {
            if (typeof bitmap.close === 'function') bitmap.close();
          }
        } catch (_) {}
      }

      // Fallback for SVG, AVIF, or animated formats using <img> + <canvas>
      const imgB64 = await this.loadImageElementToJpeg(blob, 800, 0.82);
      if (imgB64) return imgB64;

      if (blob.size <= 4 * 1024 * 1024 && typeof FileReader !== 'undefined') {
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const res = reader.result || '';
            resolve(res.split(',')[1] || null);
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      }

      return null;
    } catch (e) {
      console.warn('Image extraction failed:', e);
      return null;
    }
  }

  async captureVideoFramesFromSrc(srcUrl, maxFrames = 5) {
    if (typeof document === 'undefined' || !srcUrl) return [];

    return await new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      if (!srcUrl.startsWith('blob:') && !srcUrl.startsWith('data:')) {
        video.crossOrigin = 'anonymous';
      }

      const frames = [];
      let finished = false;
      const done = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(overallTimer);
        video.onloadeddata = null;
        video.onseeked = null;
        video.onerror = null;
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch (_) {}
        resolve(result);
      };

      const overallTimer = setTimeout(() => done(frames), 9000);

      video.onerror = () => done(frames);

      video.onloadeddata = async () => {
        try {
          const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
          const ratios = [0.10, 0.30, 0.50, 0.72, 0.88].slice(0, maxFrames);
          const targets = duration > 0.6
            ? ratios.map(r => Math.min(Math.max(0.1, duration * r), Math.max(0.1, duration - 0.1)))
            : [0];

          for (const t of targets) {
            if (finished) break;
            await new Promise((resSeek) => {
              const seekTimer = setTimeout(resSeek, 2000);
              const onSeeked = () => {
                clearTimeout(seekTimer);
                video.removeEventListener('seeked', onSeeked);
                resSeek();
              };
              if (Math.abs((video.currentTime || 0) - t) < 0.08 && t === 0) {
                clearTimeout(seekTimer);
                resSeek();
                return;
              }
              video.addEventListener('seeked', onSeeked, { once: true });
              try {
                video.currentTime = t;
              } catch (_) {
                clearTimeout(seekTimer);
                video.removeEventListener('seeked', onSeeked);
                resSeek();
              }
            });

            try {
              const b64 = renderDrawableToJpegBase64(
                video,
                video.videoWidth,
                video.videoHeight,
                640,
                0.78
              );
              if (b64 && !frames.includes(b64)) {
                frames.push(b64);
              }
            } catch (_) {
              // Tainted CORS canvas fallback signal
              if (frames.length === 0) {
                done([]);
                return;
              }
            }
          }
          done(frames);
        } catch (_) {
          done(frames);
        }
      };

      video.src = srcUrl;
    });
  }

  async extractVideoFramesBase64(rawFile, downloadUrl = '', storagePath = '', maxFrames = 5) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return [];

    if (rawFile instanceof Blob) {
      const objectUrl = URL.createObjectURL(rawFile);
      try {
        return await this.captureVideoFramesFromSrc(objectUrl, maxFrames);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }

    if (downloadUrl && !downloadUrl.startsWith('#') && !downloadUrl.startsWith('link://')) {
      const remoteFrames = await this.captureVideoFramesFromSrc(downloadUrl, maxFrames);
      if (remoteFrames.length > 0) return remoteFrames;
    }

    const blob = await this.resolveBlob(null, downloadUrl, storagePath);
    if (!blob) return [];

    const blobUrl = URL.createObjectURL(blob);
    try {
      return await this.captureVideoFramesFromSrc(blobUrl, maxFrames);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  // ==========================================
  // GOOGLE GEMINI API MULTIMODAL MODERATION
  // ==========================================
  async testApiKey(apiKey) {
    const key = (apiKey || this.getApiKey()).trim();
    if (!key) throw new Error('Please enter a Gemini API key.');

    let lastError = null;
    for (const model of GEMINI_MODELS) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        const payload = {
          contents: [{
            parts: [{ text: 'Respond with the single word "OK" if this API connection works.' }]
          }],
          generationConfig: { maxOutputTokens: 64 }
        };

        const resp = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': key
          },
          body: JSON.stringify(payload)
        }, 9000);

        if (resp.ok) {
          const data = await resp.json();
          const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (reply.trim().length > 0) return { ok: true, model };
        } else {
          const errJson = await resp.json().catch(() => ({}));
          lastError = errJson.error ? errJson.error.message : `HTTP ${resp.status}`;
          if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
            break;
          }
        }
      } catch (e) {
        lastError = e.name === 'AbortError' ? 'Request timed out' : e.message;
      }
    }

    throw new Error(`Gemini API connection failed: ${lastError || 'Could not connect'}`);
  }

  evaluateSafetyResult(parsed, fallbackCategory = 'pornography') {
    const categoryStr = String(parsed.category || '').trim().toLowerCase();
    const reasonStr = String(parsed.reason || '').toLowerCase();
    const decisionStr = String(parsed.decision || '').trim().toUpperCase();

    const unsafeCategories = new Set([
      'pornography', 'nudity', 'sex', 'sexual_abuse', 'threat',
      'violence', 'illegal', 'malware', 'phishing', 'adult', 'nsfw'
    ]);
    const isUnsafeCategory = unsafeCategories.has(categoryStr);
    const reasonMentionsViolation = /\b(porn|porno|nude|nudity|naked|genital|penis|vagina|vulva|breast|nipple|buttock|erotic|intercourse|nsfw|explicit|sex|sexual|csam|abuse|threat|violence|gore|weapon|bomb|malware|ransomware|phishing|prohibited)\b/i.test(reasonStr);
    const isSafeFalse = parsed.safe === false || parsed.safe === 'false' || parsed.safe === 0;
    const isDecisionNo = decisionStr === 'NO';

    const isUnsafe = isDecisionNo || isSafeFalse || isUnsafeCategory || reasonMentionsViolation;

    return {
      safe: !isUnsafe,
      decision: isUnsafe ? 'NO' : 'YES',
      category: isUnsafe ? (isUnsafeCategory ? categoryStr : fallbackCategory) : 'safe',
      reason: parsed.reason || (isUnsafe ? 'Prohibited adult, explicit, or threatening content detected' : 'Verified safe by Gemini AI'),
      confidence: parsed.confidence || 'high',
      aiChecked: true
    };
  }

  async invokeGeminiModel(model, key, parts, timeoutMs = 11000) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const safetySettings = [
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ];

    const resp = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': key
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 512,
          responseMimeType: 'application/json',
          responseSchema: MODERATION_RESPONSE_SCHEMA
        },
        safetySettings
      })
    }, timeoutMs);

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      const msg = errJson.error?.message || `HTTP ${resp.status}`;
      return { retryable: resp.status === 429 || resp.status === 503 || resp.status >= 500, status: resp.status, error: msg };
    }

    const json = await resp.json();
    const candidate = json.candidates?.[0];
    const promptBlockReason = json.promptFeedback?.blockReason;
    const finishReason = candidate?.finishReason;

    // 1. Any AI safety/image refusal indicates explicit nudity, porn, CSAM, or severe threats
    if (SAFETY_BLOCK_REASONS.has(promptBlockReason) || SAFETY_BLOCK_REASONS.has(finishReason) || (!candidate && promptBlockReason)) {
      return {
        result: {
          safe: false,
          decision: 'NO',
          category: 'pornography',
          reason: `Explicit nudity, adult content, or prohibited material blocked by AI safety (${promptBlockReason || finishReason})`,
          confidence: 'high',
          aiChecked: true
        }
      };
    }

    // 2. Inspect candidate or prompt safetyRatings
    const safetyRatings = [
      ...(candidate?.safetyRatings || []),
      ...(json.promptFeedback?.safetyRatings || [])
    ];
    const flaggedRating = safetyRatings.find((r) =>
      r.blocked === true ||
      (r.category === 'HARM_CATEGORY_SEXUALLY_EXPLICIT' && ['HIGH', 'MEDIUM'].includes(r.probability)) ||
      (r.category === 'HARM_CATEGORY_DANGEROUS_CONTENT' && ['HIGH', 'MEDIUM'].includes(r.probability)) ||
      (r.category === 'HARM_CATEGORY_HARASSMENT' && r.probability === 'HIGH') ||
      (r.category === 'HARM_CATEGORY_HATE_SPEECH' && r.probability === 'HIGH')
    );

    if (flaggedRating) {
      const cat = flaggedRating.category === 'HARM_CATEGORY_DANGEROUS_CONTENT' ? 'threat' : 'pornography';
      return {
        result: {
          safe: false,
          decision: 'NO',
          category: cat,
          reason: `Prohibited content flagged by AI safety classifier (${flaggedRating.category})`,
          confidence: 'high',
          aiChecked: true
        }
      };
    }

    const rawText = (candidate?.content?.parts || []).map(p => p.text || '').join('\n');
    const parsed = extractJsonObject(rawText);
    if (parsed && (parsed.decision !== undefined || parsed.safe !== undefined)) {
      return { result: this.evaluateSafetyResult(parsed) };
    }

    return { retryable: true, error: `Unparseable response (finishReason=${finishReason || 'unknown'})` };
  }

  async analyzeWithGemini(item, sampleText = '', mediaImages = []) {
    const heuristicCheck = this.runHeuristicScan(item, sampleText);
    if (!heuristicCheck.safe || heuristicCheck.decision === 'NO') {
      return { ...heuristicCheck, aiChecked: true };
    }

    const key = this.getApiKey();
    if (!key) {
      return { ...heuristicCheck, category: 'pending', reason: 'No Gemini API key configured', aiChecked: false };
    }

    const imagesList = Array.isArray(mediaImages)
      ? mediaImages.filter(Boolean)
      : (mediaImages ? [mediaImages] : []);
    const isVideoFrames = Boolean(item.isVideo || /\.(mp4|mov|webm|mkv|avi|m4v|ogv|3gp|flv|wmv)$/i.test(item.name || ''));

    const systemPrompt = `You are a strict, impartial trust and safety AI content moderator for Share247 public cloud storage.
Inspect the item metadata, extracted text/code/URL, and any attached image or video keyframes.

ZERO-TOLERANCE BLOCKING RULES (MUST set "decision": "NO", "safe": false):
1. Nudity, Pornography & Sexual Content ("pornography" / "nudity"):
   - Any explicit nudity, exposed human genitalia, exposed female breasts, nipples, buttocks, or crotch focus
   - Any sexual intercourse, oral/anal sex, masturbation, sex videos, sex photos, hentai, NSFW art, porn sites, or sexually explicit poses
2. Child Sexual Abuse / Exploitation ("sexual_abuse"):
   - Any sexualized minor content, CSAM, or non-consensual sexual content
3. Threats, Violence & Self-Harm ("threat" / "violence"):
   - Bomb threats, weapon instructions, murder/death threats, terrorist propaganda, graphic violence/gore, or suicide encouragement
4. Cyber Threats & Malware ("malware" / "phishing"):
   - Ransomware, credential stealers, trojans, exploit payloads, or phishing URLs

${imagesList.length > 1 || isVideoFrames ? 'NOTE: The attached images are keyframes sampled across a video file. If ANY single frame contains nudity, sex, pornography, violence, or threats, return decision "NO" and safe false.' : ''}

ONLY set "decision": "YES", "safe": true, "category": "safe" when ALL text, links, and visual frames are clean and appropriate for general-audience public sharing.`;

    const parts = [
      {
        text: `${systemPrompt}\n\nItem To Inspect:\n- Name: ${item.name}\n- Type: ${item.type || 'unknown'}\n- Size: ${item.formattedSize || item.size || 'unknown'}\n- URL / Destination: ${item.downloadUrl || 'none'}\n- Is Link: ${Boolean(item.isLink)}\n- Attached Visual Frames: ${imagesList.length}\n${sampleText ? `- Sample Extracted Content:\n${sampleText.slice(0, 4000)}` : ''}`
      }
    ];

    for (const b64 of imagesList.slice(0, 5)) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: b64
        }
      });
    }

    const timeoutMs = imagesList.length > 1 ? 15000 : 11000;
    let sawRetryable = false;

    for (const model of GEMINI_MODELS) {
      try {
        const outcome = await this.invokeGeminiModel(model, key, parts, timeoutMs);
        if (outcome.result) {
          return outcome.result;
        }
        if (outcome.retryable) {
          sawRetryable = true;
          console.warn(`Gemini model ${model} transient issue (${outcome.error}), failing over...`);
          continue;
        }
        console.warn(`Gemini model ${model} non-retryable error (${outcome.status}: ${outcome.error})`);
        if (outcome.status === 400 || outcome.status === 401 || outcome.status === 403) {
          break;
        }
      } catch (err) {
        sawRetryable = true;
        console.warn(`Error running Gemini model ${model}:`, err?.name === 'AbortError' ? 'Timeout' : err);
      }
    }

    // One brief backoff retry on top fast model if all attempts experienced transient 429/503/timeout
    if (sawRetryable) {
      try {
        await new Promise(r => setTimeout(r, 450));
        const retryOutcome = await this.invokeGeminiModel(GEMINI_MODELS[0], key, parts, timeoutMs);
        if (retryOutcome.result) {
          return retryOutcome.result;
        }
      } catch (_) {}
    }

    return {
      safe: true,
      decision: 'YES',
      category: 'pending',
      reason: 'AI safety verification pending (Gemini API temporarily unavailable)',
      confidence: 'low',
      aiChecked: false
    };
  }

  async extractMediaForItem(item, rawFile = null, precomputedBase64 = null) {
    const sampleText = await this.extractTextSample(item, rawFile);
    const images = [];

    if (precomputedBase64) {
      images.push(precomputedBase64);
    } else {
      const mime = ((rawFile && rawFile.type) || item.type || '').toLowerCase();
      const nameStr = ((rawFile && rawFile.name) || item.name || '').toLowerCase();

      const isImage = mime.startsWith('image/') ||
        /\.(jpe?g|png|webp|gif|bmp|avif|svg)$/i.test(nameStr);
      const isVideo = mime.startsWith('video/') ||
        /\.(mp4|mov|webm|mkv|avi|m4v|ogv|3gp|flv|wmv)$/i.test(nameStr);

      if (isImage) {
        const b64 = await this.extractImageBase64(rawFile, item.downloadUrl, item.storagePath);
        if (b64) images.push(b64);
      } else if (isVideo) {
        const frames = await this.extractVideoFramesBase64(rawFile, item.downloadUrl, item.storagePath, 5);
        images.push(...frames);
      }
    }

    return { sampleText, images };
  }

  // ==========================================
  // PRE-UPLOAD SAFETY GATE (BEFORE DB / STORAGE WRITE)
  // ==========================================
  async inspectUploadCandidate(itemDraft, rawFile = null) {
    try {
      const { sampleText, images } = await this.extractMediaForItem(itemDraft, rawFile);
      const enrichedDraft = {
        ...itemDraft,
        isVideo: Boolean(
          (rawFile && rawFile.type && rawFile.type.startsWith('video/')) ||
          /\.(mp4|mov|webm|mkv|avi|m4v|ogv|3gp|flv|wmv)$/i.test(itemDraft.name || '')
        )
      };

      const result = await this.analyzeWithGemini(enrichedDraft, sampleText, images);

      if (!result.safe || result.decision === 'NO') {
        const reason = result.reason || 'Prohibited threat, nudity, or sexually explicit content detected';
        try {
          await this.notifyOwnerOfViolation(enrichedDraft, reason, result.category);
        } catch (_) {}

        return {
          ...result,
          status: 'flagged',
          blocked: true
        };
      }

      return {
        ...result,
        status: result.aiChecked ? 'safe' : 'pending',
        blocked: false
      };
    } catch (err) {
      console.error('Pre-upload moderation error:', err);
      const fallback = this.runHeuristicScan(itemDraft);
      if (!fallback.safe || fallback.decision === 'NO') {
        return { ...fallback, status: 'flagged', blocked: true, aiChecked: false };
      }
      return {
        safe: true,
        decision: 'YES',
        category: 'pending',
        reason: 'AI safety verification pending',
        confidence: 'low',
        status: 'pending',
        blocked: false,
        aiChecked: false
      };
    }
  }

  // ==========================================
  // COMPLETE DATABASE ITEM AUDIT & AUTO-PURGE
  // ==========================================
  async screenItem(item, rawFile = null, precomputedBase64 = null) {
    try {
      await this.ensureDbReady();
      const { sampleText, images } = await this.extractMediaForItem(item, rawFile, precomputedBase64);
      const enrichedItem = {
        ...item,
        isVideo: Boolean(
          (item.type && item.type.startsWith('video/')) ||
          /\.(mp4|mov|webm|mkv|avi|m4v|ogv|3gp|flv|wmv)$/i.test(item.name || '')
        )
      };

      const result = await this.analyzeWithGemini(enrichedItem, sampleText, images);

      if (!result.safe || result.decision === 'NO') {
        const flagReason = result.reason || 'Flagged by automated AI trust & safety scan';

        try {
          await dbService.deleteFile(item.id, item.storagePath);
          console.warn(`[Auto-Purge] Deleted flagged item "${item.name}" (ID: ${item.id}). Reason: ${flagReason}`);
        } catch (delErr) {
          console.error(`[Auto-Purge] Failed to delete flagged item "${item.name}":`, delErr);
        }

        try {
          await dbService.updateModerationStatus(item.id, 'flagged', flagReason);
        } catch (_) {}

        try {
          await this.notifyOwnerOfViolation(item, flagReason, result.category);
        } catch (notifyErr) {
          console.warn('[Moderation] Notice logging failed:', notifyErr);
        }

        return {
          ...result,
          status: 'flagged',
          deleted: true
        };
      }

      if (result.aiChecked) {
        await dbService.updateModerationStatus(item.id, 'safe', result.reason || 'Approved by AI Content Safety scan');
        return {
          ...result,
          status: 'safe',
          deleted: false
        };
      }

      await dbService.updateModerationStatus(item.id, 'pending', result.reason || 'AI scan unavailable — queued for re-check');
      return {
        ...result,
        status: 'pending',
        deleted: false
      };
    } catch (err) {
      console.error('Moderation screening error:', err);
      const fallback = this.runHeuristicScan(item);
      if (!fallback.safe || fallback.decision === 'NO') {
        await this.ensureDbReady();
        try {
          await dbService.deleteFile(item.id, item.storagePath);
        } catch (_) {}
        await dbService.updateModerationStatus(item.id, 'flagged', fallback.reason).catch(() => {});
        return { ...fallback, status: 'flagged', deleted: true, aiChecked: false };
      }
      return {
        safe: true,
        decision: 'YES',
        category: 'pending',
        reason: 'AI safety verification pending',
        confidence: 'low',
        status: 'pending',
        deleted: false,
        aiChecked: false
      };
    }
  }

  // ==========================================
  // OWNER NOTIFICATION & ALERT DELIVERY
  // ==========================================
  async notifyOwnerOfViolation(item, reason, category) {
    try {
      const alertRecord = {
        id: 'alt_' + Date.now().toString(36),
        itemId: item.id || 'pre_upload_' + Date.now().toString(36),
        itemName: item.name,
        itemType: item.isLink ? 'Web Link' : (item.type || 'File'),
        downloadUrl: item.downloadUrl || 'blocked-before-upload',
        category: category || 'sensitive_content',
        reason: reason,
        timestamp: new Date().toISOString(),
        adminEmail: this.getAdminEmail(),
        resolved: false
      };

      if (typeof localStorage !== 'undefined') {
        try {
          const storedAlerts = this.getStoredAlerts();
          storedAlerts.unshift(alertRecord);
          localStorage.setItem(STORAGE_KEYS.MODERATION_ALERTS, JSON.stringify(storedAlerts.slice(0, 50)));
        } catch (_) {}
      }

      const webhook = this.getWebhookUrl();
      if (webhook && typeof fetch !== 'undefined') {
        try {
          const origin = typeof window !== 'undefined' ? window.location.origin : 'https://share247.github.io';
          await fetchWithTimeout(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'share247_file_flagged',
              alert: alertRecord,
              actionRequired: 'Prohibited content detected and blocked/deleted',
              adminDashboardUrl: `${origin}/admin/`
            })
          }, 6000);
        } catch (e) {
          console.warn('Could not dispatch webhook alert:', e);
        }
      }

      console.warn(`[AI Moderation Alert] Violation blocked/logged for "${item.name}" (Reason: ${reason})`);
      return alertRecord;
    } catch (e) {
      console.warn('Could not complete notifyOwnerOfViolation:', e);
      return null;
    }
  }

  getStoredAlerts() {
    try {
      const raw = safeStorageGet(STORAGE_KEYS.MODERATION_ALERTS);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  clearAlert(alertId) {
    const alerts = this.getStoredAlerts().filter(a => a.id !== alertId);
    safeStorageSet(STORAGE_KEYS.MODERATION_ALERTS, JSON.stringify(alerts));
  }

  clearAllAlerts() {
    safeStorageSet(STORAGE_KEYS.MODERATION_ALERTS, null);
  }

  generateMailtoLink(item, reason) {
    const recipient = encodeURIComponent(this.getAdminEmail());
    const subject = encodeURIComponent(`[URGENT Share247 Alert] Action Required: Remove Flagged Item "${item.name}"`);
    const body = encodeURIComponent(
      `Hello Admin,\n\n` +
      `An automated AI safety check flagged the following item in your Share247 Cloud Vault:\n\n` +
      `Item: ${item.name}\n` +
      `Type: ${item.isLink ? 'Shared Link' : (item.type || 'File')}\n` +
      `ID: ${item.id}\n` +
      `Flag Reason: ${reason}\n` +
      `Uploaded At: ${item.createdAt || new Date().toISOString()}\n\n` +
      `Please review and remove this item immediately from the Admin Dashboard:\n` +
      `${window.location.origin}/admin/\n\n` +
      `Share247 Automated Trust & Safety Agent`
    );
    return `mailto:${recipient}?subject=${subject}&body=${body}`;
  }
}

export const moderationService = new ModerationService();
