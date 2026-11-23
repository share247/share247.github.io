/**
 * Share247 — Admin Dashboard Controller
 * Handles authentication, content safety auditing, Gemini AI scanning,
 * file management, and instant purge controls for prohibited material.
 */

import { dbService } from './db.js?v=20261123-final';
import { moderationService } from './moderation.js?v=20261123-final';

// DOM Elements
const authOverlay = document.getElementById('auth-overlay');
const authForm = document.getElementById('auth-form');
const authPasscodeInput = document.getElementById('auth-passcode');
const authError = document.getElementById('auth-error');

function hideAuthOverlay() {
  if (authOverlay) {
    authOverlay.hidden = true;
    authOverlay.style.display = 'none';
  }
}

function showAuthOverlay() {
  if (authOverlay) {
    authOverlay.hidden = false;
    authOverlay.style.display = 'flex';
  }
}

const metricTotalItems = document.getElementById('metric-total-items');
const metricFlaggedItems = document.getElementById('metric-flagged-items');
const metricSafeItems = document.getElementById('metric-safe-items');
const metricStorageUsed = document.getElementById('metric-storage-used');

const alertBanner = document.getElementById('alert-banner');
const alertFlaggedCount = document.getElementById('alert-flagged-count');
const btnAlertDeleteAll = document.getElementById('btn-alert-delete-all');
const btnAlertMailOwner = document.getElementById('btn-alert-mail-owner');

const filterTabs = document.querySelectorAll('.tab-btn');
const adminSearchInput = document.getElementById('admin-search-input');
const adminTableBody = document.getElementById('admin-table-body');
const adminEmptyState = document.getElementById('admin-empty-state');

const btnScanAll = document.getElementById('btn-scan-all');
const btnDeleteAllFlagged = document.getElementById('btn-delete-all-flagged');
const btnClearEntireVault = document.getElementById('btn-clear-entire-vault');
const btnRefresh = document.getElementById('btn-refresh');
const btnOpenSettings = document.getElementById('btn-open-settings');
const btnLogout = document.getElementById('btn-logout');

// Settings Modal
const settingsModal = document.getElementById('settings-modal');
const settingsForm = document.getElementById('settings-form');
const settingGeminiKey = document.getElementById('setting-gemini-key');
const settingAdminEmail = document.getElementById('setting-admin-email');
const settingWebhookUrl = document.getElementById('setting-webhook-url');
const settingNewPasscode = document.getElementById('setting-new-passcode');
const btnTestGeminiKey = document.getElementById('btn-test-gemini-key');
const testKeyStatus = document.getElementById('test-key-status');

// State
let allVaultFiles = [];
let activeFilter = 'all'; // 'all' | 'flagged' | 'safe' | 'files' | 'links'
let searchQuery = '';

// ==========================================
// INITIALIZATION & AUTH
// ==========================================

document.addEventListener('DOMContentLoaded', initAdminApp);

async function initAdminApp() {
  setupEventListeners();

  const isAuth = sessionStorage.getItem('share247_admin_auth') === 'true';
  if (isAuth) {
    hideAuthOverlay();
    await loadVaultData();
  } else {
    showAuthOverlay();
    setTimeout(() => authPasscodeInput.focus(), 100);
  }
}

function setupEventListeners() {
  // Auth Form
  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const candidate = authPasscodeInput.value.trim();
    if (moderationService.verifyPasscode(candidate)) {
      sessionStorage.setItem('share247_admin_auth', 'true');
      hideAuthOverlay();
      if (authError) {
        authError.hidden = true;
        authError.style.display = 'none';
      }
      loadVaultData();
    } else {
      if (authError) {
        authError.hidden = false;
        authError.style.display = 'block';
      }
      authPasscodeInput.select();
      authPasscodeInput.focus();
    }
  });

  // Logout
  btnLogout.addEventListener('click', () => {
    sessionStorage.removeItem('share247_admin_auth');
    showAuthOverlay();
    authPasscodeInput.value = '';
    if (authError) {
      authError.hidden = true;
      authError.style.display = 'none';
    }
  });

  // Refresh
  btnRefresh.addEventListener('click', () => {
    loadVaultData(true);
  });

  // Search
  adminSearchInput.addEventListener('input', () => {
    searchQuery = adminSearchInput.value.trim().toLowerCase();
    renderVaultTable();
  });

  // Filter Tabs
  filterTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      filterTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.dataset.filter || 'all';
      renderVaultTable();
    });
  });

  // Scan All with Gemini
  btnScanAll.addEventListener('click', handleScanAllWithAI);

  // Bulk Delete Flagged
  if (btnDeleteAllFlagged) {
    btnDeleteAllFlagged.addEventListener('click', handleDeleteAllFlagged);
  }
  if (btnAlertDeleteAll) {
    btnAlertDeleteAll.addEventListener('click', handleDeleteAllFlagged);
  }

  // Clear Entire Vault
  if (btnClearEntireVault) {
    btnClearEntireVault.addEventListener('click', handleClearEntireVault);
  }

  // Mail Owner Alert
  if (btnAlertMailOwner) {
    btnAlertMailOwner.addEventListener('click', (e) => {
      e.preventDefault();
      const flagged = allVaultFiles.filter(f => f.moderationStatus === 'flagged');
      if (flagged.length === 0) return;
      const first = flagged[0];
      const mailto = moderationService.generateMailtoLink(first, `Action needed: ${flagged.length} flagged file(s) require review`);
      window.location.href = mailto;
    });
  }

  // Settings Modal Controls
  btnOpenSettings.addEventListener('click', openSettingsModal);

  const btnCancelSettings = document.getElementById('btn-cancel-settings');
  if (btnCancelSettings) {
    btnCancelSettings.addEventListener('click', () => settingsModal.close());
  }

  const btnCloseSettingsX = document.getElementById('btn-close-settings-x');
  if (btnCloseSettingsX) {
    btnCloseSettingsX.addEventListener('click', () => settingsModal.close());
  }

  // Backdrop click to close settings modal
  settingsModal.addEventListener('click', (e) => {
    const rect = settingsModal.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      settingsModal.close();
    }
  });

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    moderationService.setApiKey(settingGeminiKey.value.trim());
    moderationService.setAdminEmail(settingAdminEmail.value.trim());
    moderationService.setWebhookUrl(settingWebhookUrl.value.trim());
    if (settingNewPasscode.value.trim()) {
      moderationService.setAdminPasscode(settingNewPasscode.value.trim());
    }
    settingsModal.close();
    showAdminToast('Settings saved successfully!', 'success');
  });

  btnTestGeminiKey.addEventListener('click', async () => {
    const key = settingGeminiKey.value.trim();
    if (!key) {
      testKeyStatus.textContent = 'Please enter an API key first';
      testKeyStatus.style.color = '#fbbf24';
      return;
    }
    testKeyStatus.textContent = 'Testing connection...';
    testKeyStatus.style.color = '#38bdf8';
    try {
      await moderationService.testApiKey(key);
      testKeyStatus.textContent = 'API key verified & functional!';
      testKeyStatus.style.color = '#34d399';
    } catch (err) {
      testKeyStatus.textContent = err.message || 'Verification failed';
      testKeyStatus.style.color = '#f87171';
    }
  });
}

// ==========================================
// VAULT DATA LOADING & RENDERING
// ==========================================

async function loadVaultData(showToastFeedback = false) {
  try {
    await dbService.init();
    allVaultFiles = await dbService.getActiveFiles();

    updateMetrics();
    renderVaultTable();

    if (showToastFeedback) {
      showAdminToast('Vault data reloaded.', 'info');
    }
  } catch (err) {
    console.error('Failed to load vault data:', err);
    showAdminToast('Error loading database files.', 'error');
  }
}

function updateMetrics() {
  const total = allVaultFiles.length;
  const flagged = allVaultFiles.filter(f => f.moderationStatus === 'flagged');
  const safe = allVaultFiles.filter(f => f.moderationStatus === 'safe');

  let totalBytes = 0;
  allVaultFiles.forEach((f) => {
    if (!f.isLink && f.size) {
      totalBytes += Number(f.size);
    }
  });

  if (metricTotalItems) metricTotalItems.textContent = total;
  if (metricStorageUsed) metricStorageUsed.textContent = dbService.formatBytes(totalBytes);
  if (metricFlaggedItems) metricFlaggedItems.textContent = flagged.length;
  if (metricSafeItems) metricSafeItems.textContent = safe.length;

  // Update tab counters
  const tabAllCount = document.getElementById('tab-all-count');
  const tabFlaggedCount = document.getElementById('tab-flagged-count');
  const tabSafeCount = document.getElementById('tab-safe-count');
  const tabFilesCount = document.getElementById('tab-files-count');
  const tabLinksCount = document.getElementById('tab-links-count');

  if (tabAllCount) tabAllCount.textContent = total;
  if (tabFlaggedCount) tabFlaggedCount.textContent = flagged.length;
  if (tabSafeCount) tabSafeCount.textContent = safe.length;
  if (tabFilesCount) tabFilesCount.textContent = allVaultFiles.filter(f => !f.isLink).length;
  if (tabLinksCount) tabLinksCount.textContent = allVaultFiles.filter(f => f.isLink).length;

  // Alert Banner
  if (alertBanner) {
    if (flagged.length > 0) {
      alertBanner.hidden = false;
      if (alertFlaggedCount) alertFlaggedCount.textContent = `${flagged.length} Prohibited / Flagged ${flagged.length === 1 ? 'Item' : 'Items'} Detected`;
    } else {
      alertBanner.hidden = true;
    }
  }
}

function renderVaultTable() {
  let filtered = allVaultFiles.slice();

  // 1. Filter by Tab
  if (activeFilter === 'flagged') {
    filtered = filtered.filter(f => f.moderationStatus === 'flagged');
  } else if (activeFilter === 'safe') {
    filtered = filtered.filter(f => f.moderationStatus === 'safe');
  } else if (activeFilter === 'files') {
    filtered = filtered.filter(f => !f.isLink);
  } else if (activeFilter === 'links') {
    filtered = filtered.filter(f => f.isLink);
  }

  // 2. Search Query
  if (searchQuery) {
    filtered = filtered.filter((f) =>
      (f.name && f.name.toLowerCase().includes(searchQuery)) ||
      (f.downloadUrl && f.downloadUrl.toLowerCase().includes(searchQuery)) ||
      (f.id && f.id.toLowerCase().includes(searchQuery))
    );
  }

  adminTableBody.innerHTML = '';

  if (filtered.length === 0) {
    adminEmptyState.hidden = false;
    return;
  }

  adminEmptyState.hidden = true;

  filtered.forEach((file) => {
    const tr = document.createElement('tr');
    if (file.moderationStatus === 'flagged') {
      tr.classList.add('row-flagged');
    }

    const { badgeClass, label } = getFileBadgeInfo(file);
    const modStatus = file.moderationStatus || 'pending';

    let modBadgeHtml = '';
    if (modStatus === 'flagged') {
      modBadgeHtml = `
        <div>
          <span class="mod-badge mod-badge-flagged">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            <span>FLAGGED</span>
          </span>
          <div class="mod-reason-text" title="${escapeHtml(file.moderationReason)}">${escapeHtml(file.moderationReason || 'Prohibited content')}</div>
        </div>
      `;
    } else if (modStatus === 'safe') {
      modBadgeHtml = `
        <span class="mod-badge mod-badge-safe">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>SAFE</span>
        </span>
      `;
    } else {
      modBadgeHtml = `
        <span class="mod-badge mod-badge-pending">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          <span>UNCHECKED</span>
        </span>
      `;
    }

    const remainingDays = getDaysRemaining(file.expiresAt);
    const isItemLink = Boolean(file.isLink || file.type === 'url' || file.extension === 'link');
    const websiteName = isItemLink ? (extractDomain(file.downloadUrl || file.name) || file.name) : file.name;

    tr.innerHTML = `
      <td>
        <div class="cell-item">
          <span class="item-badge ${badgeClass}">${label}</span>
          <div class="item-meta">
            <a href="${escapeHtml(file.downloadUrl)}" target="_blank" rel="noopener noreferrer" class="item-name-link" title="${escapeHtml(websiteName)}">
              ${escapeHtml(websiteName)}
            </a>
            <div class="item-subtext">
              <span>ID: ${escapeHtml(file.id.slice(0, 8))}...</span>
              ${file.hasPin ? '<span class="badge-sub-pill"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> PIN</span>' : ''}
              ${isItemLink ? '<span class="badge-sub-pill"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Link</span>' : ''}
            </div>
          </div>
        </div>
      </td>
      <td>
        ${modBadgeHtml}
      </td>
      <td>
        <span style="color: #cbd5e1;">${file.isLink ? 'Web Link' : (file.formattedSize || dbService.formatBytes(file.size))}</span>
      </td>
      <td>
        <span style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8125rem; color: #94a3b8;" title="${file.downloadsCount || 0} views">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
          <span>${file.downloadsCount || 0}</span>
        </span>
      </td>
      <td>
        <span style="color: #94a3b8; font-size: 0.8125rem;">${remainingDays}</span>
      </td>
      <td>
        <div class="row-actions">
          <button class="action-btn btn-scan" type="button" title="Run AI Content Moderation Scan" data-id="${file.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
            </svg>
          </button>
          <a class="action-btn" href="${escapeHtml(file.downloadUrl)}" target="_blank" rel="noopener noreferrer" title="Direct Preview / Open">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </a>
          <button class="action-btn btn-del" type="button" title="Delete from Vault Immediately" data-id="${file.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </td>
    `;

    // Action button handlers
    const btnScan = tr.querySelector('.btn-scan');
    btnScan.addEventListener('click', () => handleScanSingleItem(file, btnScan));

    const btnDel = tr.querySelector('.btn-del');
    btnDel.addEventListener('click', () => handleDeleteSingleItem(file));

    // Handle 404 NoSuchKey object protection in admin
    const openLink = tr.querySelector('.item-name-link');
    const btnPreviewLink = tr.querySelector('a.action-btn');

    const handleItemOpen = async (e) => {
      if (isItemLink) return;
      try {
        const resp = await fetch(file.downloadUrl, { method: 'HEAD' }).catch(() => null);
        if (resp && resp.status === 404) {
          e.preventDefault();
          showAdminToast(`File "${file.name}" object is missing from storage (404 NoSuchKey). Delete this dead record using the trash button.`, 'error');
        }
      } catch (_) {}
    };

    if (openLink) openLink.addEventListener('click', handleItemOpen);
    if (btnPreviewLink) btnPreviewLink.addEventListener('click', handleItemOpen);

    adminTableBody.appendChild(tr);
  });
}

// ==========================================
// ITEM ACTIONS
// ==========================================

async function handleScanSingleItem(file, triggerBtn) {
  triggerBtn.style.animation = 'spin 1s linear infinite';
  showAdminToast(`Scanning "${file.name}" with Gemini AI...`);

  try {
    const result = await moderationService.screenItem(file);

    if (result.decision === 'NO' || !result.safe) {
      allVaultFiles = allVaultFiles.filter(f => String(f.id) !== String(file.id));
      updateMetrics();
      renderVaultTable();
      showAdminToast(`Prohibited content in "${file.name}". Automatically deleted: ${result.reason}`, 'error');
    } else {
      file.moderationStatus = result.status;
      file.moderationReason = result.reason;
      updateMetrics();
      renderVaultTable();
      showAdminToast(`"${file.name}" verified safe (Gemini AI: YES).`, 'success');
    }
  } catch (err) {
    console.error('Scan error:', err);
    showAdminToast('Moderation scan failed.', 'error');
  } finally {
    triggerBtn.style.animation = '';
  }
}

async function handleToggleFlag(file) {
  const current = file.moderationStatus || 'safe';
  const newStatus = current === 'flagged' ? 'safe' : 'flagged';
  const newReason = newStatus === 'flagged' ? 'Manually flagged by Administrator' : 'Manually approved by Administrator';

  try {
    await dbService.updateModerationStatus(file.id, newStatus, newReason);
    file.moderationStatus = newStatus;
    file.moderationReason = newReason;

    updateMetrics();
    renderVaultTable();
    showAdminToast(`Marked "${file.name}" as ${newStatus.toUpperCase()}.`, 'info');
  } catch (err) {
    showAdminToast(`Failed to update status: ${err.message || err}`, 'error');
  }
}

// ==========================================
// CLASSIC CONFIRMATION MODAL (NO NATIVE ALERTS)
// ==========================================

function showClassicConfirm({ title, message, requireClear = false, confirmBtnText = 'Confirm Delete' }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    if (!modal) {
      return resolve(requireClear ? window.prompt(message) === 'CLEAR' : window.confirm(message));
    }

    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl = document.getElementById('confirm-modal-msg');
    const inputContainer = document.getElementById('confirm-input-container');
    const inputEl = document.getElementById('confirm-input');
    const btnCancel = document.getElementById('btn-confirm-cancel');
    const btnCloseX = document.getElementById('btn-confirm-close-x');
    const btnOk = document.getElementById('btn-confirm-ok');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (btnOk) btnOk.textContent = confirmBtnText;

    if (requireClear) {
      if (inputContainer) inputContainer.hidden = false;
      if (inputEl) {
        inputEl.value = '';
        inputEl.placeholder = 'CLEAR';
      }
    } else {
      if (inputContainer) inputContainer.hidden = true;
    }

    const cleanup = () => {
      btnCancel?.removeEventListener('click', onCancel);
      btnCloseX?.removeEventListener('click', onCancel);
      btnOk?.removeEventListener('click', onOk);
      modal.removeEventListener('cancel', onCancel);
    };

    const onCancel = () => {
      cleanup();
      modal.close();
      resolve(false);
    };

    const onOk = () => {
      if (requireClear && inputEl && inputEl.value.trim().toUpperCase() !== 'CLEAR') {
        showAdminToast('You must type CLEAR to confirm.', 'error');
        inputEl.focus();
        return;
      }
      cleanup();
      modal.close();
      resolve(true);
    };

    btnCancel?.addEventListener('click', onCancel);
    btnCloseX?.addEventListener('click', onCancel);
    btnOk?.addEventListener('click', onOk);
    modal.addEventListener('cancel', onCancel);

    modal.showModal();
    if (requireClear && inputEl) {
      inputEl.focus();
    }
  });
}

async function handleDeleteSingleItem(file) {
  const confirmed = await showClassicConfirm({
    title: 'Delete Item',
    message: `Are you sure you want to permanently delete "${file.name}" from public cloud storage and database?`,
    requireClear: false,
    confirmBtnText: 'Delete File'
  });
  if (!confirmed) return;

  try {
    await dbService.deleteFile(file.id, file.storagePath);
    allVaultFiles = allVaultFiles.filter(f => String(f.id) !== String(file.id));
    updateMetrics();
    renderVaultTable();
    showAdminToast(`Deleted "${file.name}" from vault.`, 'success');
  } catch (err) {
    showAdminToast(`Delete error: ${err.message || err}`, 'error');
  }
}

async function handleDeleteAllFlagged() {
  const flagged = allVaultFiles.filter(f => f.moderationStatus === 'flagged');
  if (flagged.length === 0) {
    showAdminToast('No flagged files found to delete.', 'info');
    return;
  }

  const confirmed = await showClassicConfirm({
    title: 'Purge Flagged Items',
    message: `Are you sure you want to permanently delete all ${flagged.length} flagged items? This cannot be undone.`,
    requireClear: false,
    confirmBtnText: 'Purge Flagged'
  });
  if (!confirmed) return;

  let deletedCount = 0;
  for (const file of flagged) {
    try {
      await dbService.deleteFile(file.id, file.storagePath);
      allVaultFiles = allVaultFiles.filter(f => String(f.id) !== String(file.id));
      deletedCount++;
    } catch (e) {
      console.warn(`Could not delete flagged file ${file.id}:`, e);
    }
  }

  moderationService.clearAllAlerts();
  updateMetrics();
  renderVaultTable();
  showAdminToast(`Successfully purged ${deletedCount} prohibited item(s).`, 'success');
}

async function handleClearEntireVault() {
  const confirmed = await showClassicConfirm({
    title: 'Clear Entire Vault',
    message: 'DANGER: Are you sure you want to permanently clear the ENTIRE vault? All active files, links, and database records will be permanently deleted.',
    requireClear: true,
    confirmBtnText: 'Delete All Files'
  });
  if (!confirmed) return;

  showAdminToast('Purging all vault files from database and storage...', 'info');

  try {
    await dbService.purgeAllVaultFiles();
    allVaultFiles = [];
    moderationService.clearAllAlerts();
    updateMetrics();
    renderVaultTable();
    showAdminToast('Entire database vault cleared successfully.', 'success');
  } catch (err) {
    console.error('Purge error:', err);
    showAdminToast(`Failed to clear vault: ${err.message || err}`, 'error');
  }
}

async function handleScanAllWithAI() {
  if (allVaultFiles.length === 0) {
    showAdminToast('No files to scan.', 'info');
    return;
  }

  btnScanAll.disabled = true;
  btnScanAll.textContent = 'Scanning...';
  showAdminToast(`Starting Gemini AI screening on ${allVaultFiles.length} item(s)...`, 'info');

  let autoDeletedCount = 0;
  const remainingFiles = [];
  for (const file of allVaultFiles) {
    try {
      const res = await moderationService.screenItem(file);
      if (res.decision === 'NO' || !res.safe || res.status === 'flagged') {
        autoDeletedCount++;
      } else {
        file.moderationStatus = res.status;
        file.moderationReason = res.reason;
        remainingFiles.push(file);
      }
    } catch (_) {
      remainingFiles.push(file);
    }
  }
  allVaultFiles = remainingFiles;

  btnScanAll.disabled = false;
  btnScanAll.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
      <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"></path>
    </svg>
    <span>AI Scan All</span>
  `;

  updateMetrics();
  renderVaultTable();

  if (autoDeletedCount > 0) {
    showAdminToast(`Audit complete: ${autoDeletedCount} prohibited item(s) detected and automatically deleted.`, 'error');
  } else {
    showAdminToast('Audit complete: All vault items approved safe.', 'success');
  }
}

// ==========================================
// SETTINGS MODAL
// ==========================================

function openSettingsModal() {
  settingGeminiKey.value = moderationService.getApiKey();
  settingAdminEmail.value = moderationService.getAdminEmail();
  settingWebhookUrl.value = moderationService.getWebhookUrl();
  settingNewPasscode.value = '';
  testKeyStatus.textContent = '';
  settingsModal.showModal();
}

// ==========================================
// HELPERS
// ==========================================

function getFileBadgeInfo(file) {
  if (file.isLink) {
    return { badgeClass: 'badge-link', label: 'LINK' };
  }
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (['doc', 'docx', 'txt', 'rtf', 'md'].includes(ext)) {
    return { badgeClass: 'badge-doc', label: 'DOC' };
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    return { badgeClass: 'badge-img', label: 'IMG' };
  }
  if (['pdf'].includes(ext)) {
    return { badgeClass: 'badge-pdf', label: 'PDF' };
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return { badgeClass: 'badge-zip', label: 'ZIP' };
  }
  return { badgeClass: 'badge-doc', label: ext ? ext.slice(0, 3).toUpperCase() : 'FILE' };
}

function getDaysRemaining(expiresAtStr) {
  const now = Date.now();
  const exp = new Date(expiresAtStr).getTime();
  const diff = exp - now;
  if (diff <= 0) return 'Expired';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days > 0) return `${days}d ${remHours}h left`;
  return `${hours}h left`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[m]);
}

function showAdminToast(msg, type = 'info') {
  const container = document.getElementById('admin-toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = 'admin-toast';
  if (type === 'error') {
    t.style.borderColor = '#ef4444';
    t.style.color = '#fca5a5';
  } else if (type === 'success') {
    t.style.borderColor = '#34d399';
    t.style.color = '#6ee7b7';
  }
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, 3500);
}

function extractDomain(urlStr) {
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
