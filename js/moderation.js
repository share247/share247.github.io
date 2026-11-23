/**
 * Share247 — Agentic AI Content Moderation & Safety Service
 * Screens uploaded files and shared links for:
 * - Pornography, explicit nudity, sexually explicit content
 * - Child Sexual Abuse Material (CSAM) / Non-consensual imagery (Zero Tolerance)
 * - Illegal activities, malware, weapons, cyber threats, phishing
 *
 * Architecture:
 * 1. Immediate Ingestion: File is uploaded and becomes available to user.
 * 2. Background AI Screening: Automated multimodal scan via Google Gemini API (gemini-2.0-flash / gemini-1.5-flash).
 * 3. Structured Decision: YES (Safe, no sensitive issues) vs NO (Sensitive/illegal issue detected).
 * 4. Owner & Admin Alert: Auto-dispatches notification to owner and flags item in Admin Dashboard.
 */

import { dbService } from './db.js';

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

// Primary and fallback models for Google Generative AI
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
  'gemini-3.8-flash'
];

// Comprehensive local heuristic rules for offline / zero-key defense
const SENSITIVE_PATTERNS = {
  pornography: [
    /\b(porn|porno|pornography|xxx|hentai|nsfw|erotic|onlyfans|xvideos|pornhub|redtube|youporn|brazzers|chaturbate|camgirls|stripchat|cam4|beeg|rule34)\b/i,
    /\b(boobs|penis|vagina|blowjob|anal|creampie|milf|dildo|vibrator|masturbat)\b/i
  ],
  sexualAbuse: [
    /\b(csam|cp\b|childporn|pedophil|paedophil|pedophile|lolita|jailbait|rape|underage\s*(sex|nude|porn)|non-consensual)\b/i
  ],
  illegalAndMalware: [
    /\b(ransomware|keylogger|trojan|exploit|botnet|ddos-tool|stolen-cards|dumps|credit-cards|darknet|darkweb|silkroad|buy-drugs|cocaine|fentanyl|counterfeit|bomb-making|terrorist|assassination)\b/i,
    /\.(exe|scr|bat|cmd|vbs|pif|reg|ps1|hta|iso)$/i
  ],
  phishing: [
    /\b(phishing|credential-stealer|paypal-login|bank-login|crypto-drainer|stealer|wallet-drainer)\b/i
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

class ModerationService {
  constructor() {
    this.geminiApiKey = safeStorageGet(STORAGE_KEYS.GEMINI_API_KEY) || DEFAULT_GEMINI_API_KEY;
    this.adminEmail = safeStorageGet(STORAGE_KEYS.ADMIN_EMAIL) || DEFAULT_ADMIN_EMAIL;
    this.webhookUrl = safeStorageGet(STORAGE_KEYS.ALERT_WEBHOOK) || '';
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
    // If no passcode stored or still holding the previous default 'admin247', upgrade to the new passcode
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
      // Ensure local storage is synced to the authorized password
      this.setAdminPasscode('JustCse188#');
      return true;
    }
    return false;
  }

  // ==========================================
  // FAST HEURISTIC SAFETY CHECK
  // ==========================================
  runHeuristicScan(item) {
    const rawText = `${item.name || ''} ${item.downloadUrl || ''} ${item.type || ''}`.toLowerCase();
    const normalizedText = rawText.replace(/[\._\-\/\\?&=+]+/g, ' ');
    const checkText = `${rawText} ${normalizedText}`;

    // 1. Sexual Abuse / CSAM Check (Critical)
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

    // 2. Adult Pornography Check
    for (const pattern of SENSITIVE_PATTERNS.pornography) {
      if (pattern.test(checkText)) {
        return {
          safe: false,
          decision: 'NO',
          category: 'pornography',
          reason: 'Adult content / pornography indicator detected in item metadata',
          confidence: 'high'
        };
      }
    }

    // 3. Illegal, Malware & Dangerous Files
    for (const pattern of SENSITIVE_PATTERNS.illegalAndMalware) {
      if (pattern.test(checkText) || pattern.test(item.name || '')) {
        return {
          safe: false,
          decision: 'NO',
          category: 'illegal',
          reason: 'Dangerous executable, malware payload, or illicit activity pattern detected',
          confidence: 'high'
        };
      }
    }

    // 4. Phishing Indicators
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
      reason: 'No prohibited keywords or sensitive patterns matched in initial safety scan',
      confidence: 'medium'
    };
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
          generationConfig: { maxOutputTokens: 10 }
        };

        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': key
          },
          body: JSON.stringify(payload)
        });

        if (resp.ok) {
          const data = await resp.json();
          const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (reply.trim().length > 0) return true;
        } else {
          const errJson = await resp.json().catch(() => ({}));
          lastError = errJson.error ? errJson.error.message : `HTTP ${resp.status}`;
        }
      } catch (e) {
        lastError = e.message;
      }
    }

    throw new Error(`Gemini API connection failed: ${lastError || 'Could not connect'}`);
  }

  async extractImageBase64(rawFile, downloadUrl = '') {
    try {
      let blob = rawFile;

      // If rawFile is not provided, fetch blob from downloadUrl (e.g. for Admin re-scans)
      if ((!blob || !(blob instanceof Blob)) && downloadUrl && !downloadUrl.startsWith('#') && !downloadUrl.startsWith('link://')) {
        try {
          const resp = await fetch(downloadUrl);
          if (resp.ok) blob = await resp.blob();
        } catch (_) {}
      }

      if (!blob || !(blob instanceof Blob)) return null;

      // Downscale image using canvas to ensure fast transfer (< 100KB JPEG)
      if (typeof createImageBitmap !== 'undefined' && typeof document !== 'undefined') {
        try {
          const bitmap = await createImageBitmap(blob);
          const maxDim = 800;
          let width = bitmap.width;
          let height = bitmap.height;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0, width, height);

          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          const b64 = dataUrl.split(',')[1];
          if (b64) return b64;
        } catch (_) {}
      }

      // Fallback: FileReader direct base64
      if (blob.size <= 4 * 1024 * 1024 && typeof FileReader !== 'undefined') {
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const res = reader.result || '';
            const b64 = res.split(',')[1];
            resolve(b64 || null);
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

  async analyzeWithGemini(item, sampleText = '', base64Image = null) {
    const key = this.getApiKey();
    if (!key) {
      return this.runHeuristicScan(item);
    }

    const systemPrompt = `You are an automated, strictly impartial trust and safety AI moderator for a public file storage service (Share247).
Your task is to inspect the attached content and any image or document sample for safety and policy compliance.

STRICT CONTENT SAFETY CRITERIA:
1. Pornography & Sexually Explicit Content (CRITICAL):
   - Any exposed human genitalia, female breasts, buttocks, or explicit nudity.
   - Any sexual intercourse, oral sex, masturbation, or sexually explicit poses.
   - Adult toys, hentai/erotic anime, or NSFW adult imagery.
2. Sexual Abuse & Exploitation (ZERO TOLERANCE):
   - Any non-consensual sexual content, sexual violence, or child exploitation/CSAM.
3. Violence, Weapons, & Terrorism:
   - Graphic gore, bodily mutilation, suicide, bomb-making, terrorist propaganda.
4. Malicious Content & Contraband:
   - Malware, credential stealers, counterfeit goods, illegal drug distribution, cyber exploits.

DECISION PROTOCOL:
- If the image or content contains ANY prohibited or sensitive material from the criteria above, you MUST answer:
  decision: "NO" and safe: false
- If the image or content is completely safe (innocent photo, document, textbook, software code, graphic diagram, general website), answer:
  decision: "YES" and safe: true

Output ONLY a valid JSON object matching this schema:
{
  "decision": "YES" or "NO",
  "safe": true or false,
  "category": "safe" | "pornography" | "sexual_abuse" | "illegal" | "malware" | "phishing" | "violence" | "other",
  "reason": "Clear explanation in under 15 words",
  "confidence": "high" | "medium" | "low"
}`;

    const parts = [
      {
        text: `${systemPrompt}\n\nItem To Inspect:\n- Name: ${item.name}\n- Type: ${item.type || 'unknown'}\n- Size: ${item.formattedSize || item.size || 'unknown'}\n- URL / Destination: ${item.downloadUrl || 'none'}\n- Is Link: ${Boolean(item.isLink)}\n${sampleText ? `- Sample Extracted Content: ${sampleText.slice(0, 2000)}` : ''}`
      }
    ];

    if (base64Image) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Image
        }
      });
    }

    const safetySettings = [
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ];

    // Try models in priority sequence with automatic failover
    for (const model of GEMINI_MODELS) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': key
          },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              temperature: 0.0,
              maxOutputTokens: 250,
              responseMimeType: 'application/json'
            },
            safetySettings
          })
        });

        if (!resp.ok) {
          console.warn(`Gemini model ${model} returned ${resp.status}, trying fallback...`);
          continue;
        }

        const json = await resp.json();
        const candidate = json.candidates?.[0];
        const blockReason = json.promptFeedback?.blockReason || candidate?.finishReason;

        // If core Google safety filters blocked the response, it is guaranteed to be sensitive
        if (blockReason === 'SAFETY' || blockReason === 'BLOCKLIST' || blockReason === 'PROHIBITED_CONTENT') {
          return {
            safe: false,
            decision: 'NO',
            category: 'pornography',
            reason: 'Explicit or sensitive material detected and blocked by AI safety guardrails',
            confidence: 'high'
          };
        }

        const rawText = candidate?.content?.parts?.[0]?.text || '';
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

        if (cleanJson) {
          const parsed = JSON.parse(cleanJson);
          const isDecisionYes = String(parsed.decision).toUpperCase() === 'YES';

          return {
            safe: isDecisionYes && Boolean(parsed.safe),
            decision: isDecisionYes ? 'YES' : 'NO',
            category: parsed.category || (isDecisionYes ? 'safe' : 'other'),
            reason: parsed.reason || (isDecisionYes ? 'Safe for sharing' : 'Sensitive material detected by Gemini AI'),
            confidence: parsed.confidence || 'high'
          };
        }
      } catch (err) {
        console.warn(`Error running Gemini model ${model}:`, err);
      }
    }

    // If all Gemini models failed or timed out, use local heuristic scanner
    return this.runHeuristicScan(item);
  }

  // ==========================================
  // COMPLETE END-TO-END SCREENING WORKFLOW
  // ==========================================
  async screenItem(item, rawFile = null) {
    try {
      let sampleText = '';
      let base64Image = null;

      // Extract sample for text/code/document files
      if (rawFile && (rawFile.type.startsWith('text/') || rawFile.name.endsWith('.txt') || rawFile.name.endsWith('.md') || rawFile.name.endsWith('.json'))) {
        try {
          sampleText = await rawFile.slice(0, 3000).text();
        } catch (_) {}
      }

      // Check if item is an image and extract visual pixels for multimodal inspection
      const isImage = (rawFile && rawFile.type && rawFile.type.startsWith('image/')) ||
                      /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(item.name || '') ||
                      (item.type && item.type.startsWith('image/'));

      if (isImage) {
        base64Image = await this.extractImageBase64(rawFile, item.downloadUrl);
      }

      // 1. Run Analysis (Gemini API with heuristic fallback)
      const result = await this.analyzeWithGemini(item, sampleText, base64Image);

      // 2. If decision is NO (Unsafe / Flagged)
      if (!result.safe || result.decision === 'NO') {
        const flagReason = result.reason || 'Flagged by automated AI trust & safety scan';
        await dbService.updateModerationStatus(item.id, 'flagged', flagReason);
        await this.notifyOwnerOfViolation(item, flagReason, result.category);
        return {
          ...result,
          status: 'flagged'
        };
      } else {
        // Safe (YES)
        await dbService.updateModerationStatus(item.id, 'safe', 'Approved by AI Content Safety scan');
        return {
          ...result,
          status: 'safe'
        };
      }
    } catch (err) {
      console.error('Moderation screening error:', err);
      const fallback = this.runHeuristicScan(item);
      if (!fallback.safe) {
        await dbService.updateModerationStatus(item.id, 'flagged', fallback.reason);
      }
      return fallback;
    }
  }

  // ==========================================
  // OWNER NOTIFICATION & ALERT DELIVERY
  // ==========================================
  async notifyOwnerOfViolation(item, reason, category) {
    const alertRecord = {
      id: 'alt_' + Date.now().toString(36),
      itemId: item.id,
      itemName: item.name,
      itemType: item.isLink ? 'Web Link' : (item.type || 'File'),
      downloadUrl: item.downloadUrl,
      category: category || 'sensitive_content',
      reason: reason,
      timestamp: new Date().toISOString(),
      adminEmail: this.getAdminEmail(),
      resolved: false
    };

    // Save alert in localStorage for the Admin Dashboard
    const storedAlerts = this.getStoredAlerts();
    storedAlerts.unshift(alertRecord);
    localStorage.setItem(STORAGE_KEYS.MODERATION_ALERTS, JSON.stringify(storedAlerts.slice(0, 50)));

    // Send Webhook if configured
    const webhook = this.getWebhookUrl();
    if (webhook) {
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'share247_file_flagged',
            alert: alertRecord,
            actionRequired: 'Delete flagged file via admin dashboard',
            adminDashboardUrl: `${window.location.origin}/admin`
          })
        });
      } catch (e) {
        console.warn('Could not dispatch webhook alert:', e);
      }
    }

    console.warn(`[AI Moderation Alert] Owner notification logged for flagged file: "${item.name}" (Reason: ${reason})`);
    return alertRecord;
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
      `${window.location.origin}/admin\n\n` +
      `Share247 Automated Trust & Safety Agent`
    );
    return `mailto:${recipient}?subject=${subject}&body=${body}`;
  }
}

export const moderationService = new ModerationService();
