/**
 * Share247 — Cloud Vault Application Controller
 * Handles table rendering, navbar uploads, drag-and-drop,
 * sorting, live 7-day countdown, and Supabase / Local storage switching.
 */

import { dbService } from './db.js';

// DOM Elements
const btnNavbarUpload = document.getElementById('btn-navbar-upload');
const fileInput = document.getElementById('file-input');
const dragOverlay = document.getElementById('drag-overlay');

const uploadWidget = document.getElementById('upload-widget');
const uploadWidgetTitle = document.getElementById('upload-widget-title');
const widgetFileName = document.getElementById('widget-file-name');
const widgetFilePercent = document.getElementById('widget-file-percent');
const widgetFileIcon = document.getElementById('widget-file-icon');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const btnCloseUploadWidget = document.getElementById('btn-close-upload-widget');

const filesTbody = document.getElementById('files-tbody');
const emptyState = document.getElementById('empty-state');
const filesCounter = document.getElementById('files-counter');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const btnRefresh = document.getElementById('btn-refresh');

// Sorting
const colSortName = document.getElementById('col-sort-name');
const colSortDate = document.getElementById('col-sort-date');
const colSortSize = document.getElementById('col-sort-size');
const nameSortArrow = document.getElementById('name-sort-arrow');

// Modals
const shareDialog = document.getElementById('share-dialog');
const shareModalIconBadge = document.getElementById('share-modal-icon-badge');
const shareModalName = document.getElementById('share-modal-name');
const shareModalSize = document.getElementById('share-modal-size');
const shareModalExpires = document.getElementById('share-modal-expires');
const shareUrlInput = document.getElementById('share-url-input');
const btnCopyShareUrl = document.getElementById('btn-copy-share-url');
const btnModalDownload = document.getElementById('btn-modal-download');

const toastContainer = document.getElementById('toast-container');
const liveAnnouncer = document.getElementById('live-announcer');

// State
let activeFiles = [];
let sortColumn = 'date'; // 'name' | 'date' | 'size'
let sortAsc = false;
let countdownTimerId = null;
let dragCounter = 0;

// ==========================================
// INITIALIZATION
// ==========================================

async function initApp() {
  setupEventListeners();

  try {
    const { mode } = await dbService.init();
    updateFooterDbMode(mode);
    await refreshFilesList();
    checkUrlQueryParams();
    startCountdownTicker();
  } catch (err) {
    console.error('Initialization error:', err);
    showToast('Failed to initialize database.', 'error');
  }
}

// ==========================================
// EVENT LISTENERS
// ==========================================

function setupEventListeners() {
  // Navbar & Empty State Upload Trigger
  btnNavbarUpload.addEventListener('click', () => {
    fileInput.click();
  });

  const btnEmptyUpload = document.getElementById('btn-empty-upload');
  if (btnEmptyUpload) {
    btnEmptyUpload.addEventListener('click', () => fileInput.click());
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFiles(Array.from(fileInput.files));
      fileInput.value = '';
    }
  });

  // Full-window Drag and Drop
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      dragOverlay.classList.add('active');
      dragOverlay.hidden = false;
    }
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dragOverlay.classList.remove('active');
      dragOverlay.hidden = true;
    }
  });

  window.addEventListener('dragover', (e) => e.preventDefault());

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove('active');
    dragOverlay.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  });

  // Search & Filter
  searchInput.addEventListener('input', () => {
    searchClear.hidden = !searchInput.value;
    renderFilesTable();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.hidden = true;
    searchInput.focus();
    renderFilesTable();
  });

  btnRefresh.addEventListener('click', () => refreshFilesList());

  // Sorting
  colSortName.addEventListener('click', () => toggleSort('name'));
  colSortDate.addEventListener('click', () => toggleSort('date'));
  colSortSize.addEventListener('click', () => toggleSort('size'));

  // Upload widget close
  btnCloseUploadWidget.addEventListener('click', () => {
    uploadWidget.hidden = true;
  });

  // Modals
  document.querySelectorAll('.btn-dialog-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const dialog = e.target.closest('dialog');
      if (dialog) dialog.close();
    });
  });

  btnCopyShareUrl.addEventListener('click', () => {
    copyTextToClipboard(shareUrlInput.value, 'Direct link copied to clipboard!');
  });
}

function toggleSort(column) {
  if (sortColumn === column) {
    sortAsc = !sortAsc;
  } else {
    sortColumn = column;
    sortAsc = true;
  }

  // Update arrow rotation on name column
  if (sortColumn === 'name') {
    nameSortArrow.classList.toggle('desc', !sortAsc);
  }

  renderFilesTable();
}

// ==========================================
// UPLOAD HANDLING
// ==========================================

async function handleFiles(files) {
  for (const file of files) {
    if (file.size > 100 * 1024 * 1024) {
      showToast(`"${file.name}" exceeds 100 MB limit.`, 'error');
      continue;
    }
    await uploadSingleFile(file);
  }
}

async function uploadSingleFile(file) {
  uploadWidget.hidden = false;
  uploadWidgetTitle.textContent = 'Uploading 1 item';
  widgetFileName.textContent = file.name;
  widgetFilePercent.textContent = '0%';
  uploadProgressBar.value = 0;

  const { iconClass, label } = getFileTypeDetails(file.name);
  widgetFileIcon.className = `widget-badge ${iconClass}`;
  widgetFileIcon.textContent = label;

  try {
    const uploaded = await dbService.uploadFile(file, (percent) => {
      const p = Math.round(percent);
      uploadProgressBar.value = p;
      widgetFilePercent.textContent = `${p}%`;
    });

    uploadWidgetTitle.textContent = 'Upload complete';
    widgetFilePercent.textContent = 'Done';
    announcePolitely(`Uploaded ${file.name} successfully`);
    showToast(`Shared "${file.name}" for 7 days!`, 'success');
    await refreshFilesList();

    // Auto open share modal
    openShareDialog(uploaded);
  } catch (err) {
    console.error('Upload failed:', err);
    uploadWidgetTitle.textContent = 'Upload failed';
    showToast(`Upload failed: ${err.message || err}`, 'error');
  } finally {
    setTimeout(() => {
      uploadWidget.hidden = true;
    }, 4000);
  }
}

// ==========================================
// TABLE RENDERING
// ==========================================

async function refreshFilesList() {
  try {
    activeFiles = await dbService.getActiveFiles();
    renderFilesTable();
  } catch (err) {
    console.error('Failed to load files:', err);
    showToast('Could not fetch active files.', 'error');
  }
}

function renderFilesTable() {
  const query = searchInput.value.trim().toLowerCase();
  const now = Date.now();

  // Filter unexpired files matching search query
  let filtered = activeFiles.filter((f) => {
    const exp = new Date(f.expiresAt).getTime();
    if (exp <= now) return false;

    if (!query) return true;
    return (
      f.name.toLowerCase().includes(query) ||
      (f.extension && f.extension.toLowerCase().includes(query))
    );
  });

  // Sort
  filtered.sort((a, b) => {
    let comparison = 0;
    if (sortColumn === 'name') {
      comparison = a.name.localeCompare(b.name);
    } else if (sortColumn === 'size') {
      comparison = a.size - b.size;
    } else { // 'date'
      comparison = new Date(a.createdAt) - new Date(b.createdAt);
    }
    return sortAsc ? comparison : -comparison;
  });

  filesCounter.textContent = `${filtered.length} ${filtered.length === 1 ? 'item' : 'items'}`;
  filesTbody.innerHTML = '';

  if (filtered.length === 0) {
    emptyState.hidden = false;
    updateFooterStorageTracker();
    return;
  }

  emptyState.hidden = true;

  filtered.forEach((file) => {
    const tr = document.createElement('tr');
    const { iconClass, label } = getFileTypeDetails(file.name);
    const { countdownText, badgeStyle } = getCountdownBadgeInfo(file.expiresAt);
    const formattedDate = formatDriveDate(file.createdAt);

    tr.innerHTML = `
      <td class="cell-name">
        <div class="cell-name-content">
          <div class="row-file-icon ${iconClass}">${label}</div>
          <div class="row-filename" title="${escapeHtml(file.name)}">
            <span>${escapeHtml(file.name)}</span>
          </div>
        </div>
      </td>
      <td class="cell-owner">
        <div class="cell-owner-content">
          <div class="owner-avatar" aria-hidden="true">me</div>
          <span class="owner-name">me</span>
        </div>
      </td>
      <td class="cell-date">${formattedDate}</td>
      <td class="cell-expires">
        <span class="expires-pill ${badgeStyle}" data-expires="${file.expiresAt}" title="Auto-purges in ${countdownText}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          <span class="countdown-label">${countdownText}</span>
        </span>
      </td>
      <td class="cell-size">${file.formattedSize || dbService.formatBytes(file.size)}</td>
      <td class="cell-actions">
        <div class="row-hover-actions">
          <button class="row-action-btn btn-share" data-id="${file.id}" type="button" title="Share link" aria-label="Share">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
          </button>
          <button class="row-action-btn btn-download" data-id="${file.id}" type="button" title="Download" aria-label="Download">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </button>
          <button class="row-action-btn btn-details" data-id="${file.id}" type="button" title="More options" aria-label="More options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
          </button>
        </div>
      </td>
    `;

    // Action handlers
    tr.querySelector('.btn-download').addEventListener('click', (e) => {
      e.stopPropagation();
      triggerDownload(file);
    });

    tr.querySelector('.btn-share').addEventListener('click', (e) => {
      e.stopPropagation();
      openShareDialog(file);
    });

    tr.querySelector('.btn-details').addEventListener('click', (e) => {
      e.stopPropagation();
      openShareDialog(file);
    });

    tr.addEventListener('dblclick', () => {
      openShareDialog(file);
    });

    filesTbody.appendChild(tr);
  });

  updateFooterStorageTracker();
}

function updateFooterStorageTracker() {
  const footerStorageUsed = document.getElementById('footer-storage-used');
  const footerStoragePercent = document.getElementById('footer-storage-percent');
  const footerFilesCount = document.getElementById('footer-files-count');
  const footerStorageBar = document.getElementById('footer-storage-bar');
  const footerStorageProgressbar = document.getElementById('footer-storage-progressbar');

  if (!footerStorageUsed || !footerStorageBar) return;

  const now = Date.now();
  const validFiles = (activeFiles || []).filter((f) => {
    const exp = new Date(f.expiresAt).getTime();
    return exp > now;
  });

  const totalBytes = validFiles.reduce((acc, file) => acc + (Number(file.size) || 0), 0);
  const count = validFiles.length;

  // Supabase free tier storage allocation (1 GB = 1,073,741,824 bytes)
  const MAX_STORAGE_BYTES = 1073741824;
  const percent = Math.min(100, (totalBytes / MAX_STORAGE_BYTES) * 100);
  const formattedUsed = dbService.formatBytes(totalBytes);
  const percentDisplay = percent < 0.1 && percent > 0 ? '<0.1%' : `${percent.toFixed(1)}%`;

  footerStorageUsed.textContent = `${formattedUsed} / 1 GB`;
  footerStoragePercent.textContent = `(${percentDisplay})`;
  footerFilesCount.textContent = `${count} ${count === 1 ? 'active file' : 'active files'}`;

  // Min 1% visual fill when there is data so user sees the bar
  const visualFill = totalBytes > 0 ? Math.max(1, percent) : 0;
  footerStorageBar.style.width = `${visualFill}%`;

  if (footerStorageProgressbar) {
    footerStorageProgressbar.setAttribute('aria-valuenow', percent.toFixed(1));
  }

  if (percent >= 90) {
    footerStorageBar.style.background = 'linear-gradient(90deg, #f87171, #ef4444)';
  } else if (percent >= 75) {
    footerStorageBar.style.background = 'linear-gradient(90deg, #fbbf24, #f59e0b)';
  } else {
    footerStorageBar.style.background = 'linear-gradient(90deg, #38bdf8, #818cf8)';
  }
}

function updateFooterDbMode(mode) {
  const badge = document.getElementById('footer-db-badge');
  if (!badge) return;
  if (mode === 'supabase') {
    badge.className = 'db-badge status-supabase';
    badge.textContent = 'Supabase Live';
    badge.title = 'Connected to live Supabase Cloud Database & Storage';
  } else {
    badge.className = 'db-badge status-local';
    badge.textContent = 'Local Vault';
    badge.title = 'Running in browser local storage';
  }
}

function startCountdownTicker() {
  if (countdownTimerId) clearInterval(countdownTimerId);

  // Update countdown timers every 30 seconds
  countdownTimerId = setInterval(() => {
    const badges = document.querySelectorAll('.expires-pill[data-expires]');
    let hasExpiredAny = false;

    badges.forEach((badge) => {
      const expires = badge.getAttribute('data-expires');
      if (expires) {
        const { countdownText, badgeStyle, isExpired } = getCountdownBadgeInfo(expires);
        if (isExpired) {
          hasExpiredAny = true;
        } else {
          badge.className = `expires-pill ${badgeStyle}`;
          const label = badge.querySelector('.countdown-label');
          if (label) label.textContent = countdownText;
        }
      }
    });

    if (hasExpiredAny) {
      refreshFilesList();
    }
  }, 30000);
}

// ==========================================
// DOWNLOAD & SHARE MODAL
// ==========================================

async function triggerDownload(file) {
  try {
    await dbService.incrementDownload(file.id);
    file.downloadsCount = (file.downloadsCount || 0) + 1;

    const a = document.createElement('a');
    a.href = file.downloadUrl;
    a.download = file.name;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    showToast(`Downloading "${file.name}"...`);
  } catch (err) {
    console.error('Download error:', err);
    showToast('Failed to trigger download.', 'error');
  }
}

function openShareDialog(file) {
  const { iconClass, label } = getFileTypeDetails(file.name);
  const { countdownText } = getCountdownBadgeInfo(file.expiresAt);

  shareModalIconBadge.className = `file-badge ${iconClass}`;
  shareModalIconBadge.textContent = label;
  shareModalName.textContent = file.name;
  shareModalSize.textContent = file.formattedSize || dbService.formatBytes(file.size);
  shareModalExpires.textContent = `Auto-purges in ${countdownText}`;

  const shareUrl = `${window.location.origin}${window.location.pathname}?file=${encodeURIComponent(file.id)}`;
  shareUrlInput.value = shareUrl;

  btnModalDownload.href = file.downloadUrl;
  btnModalDownload.download = file.name;
  btnModalDownload.onclick = () => {
    dbService.incrementDownload(file.id);
  };

  shareDialog.showModal();
}

async function checkUrlQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const fileId = params.get('file');
  if (fileId) {
    try {
      const file = await dbService.getFileById(fileId);
      if (file) {
        openShareDialog(file);
      } else {
        showToast('Requested file does not exist or has already expired after 7 days.', 'error');
      }
    } catch (e) {
      console.warn('Could not retrieve file from URL param:', e);
    }
  }
}

// ==========================================
// HELPERS
// ==========================================

function getFileTypeDetails(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  if (['doc', 'docx', 'txt', 'rtf', 'odt', 'md'].includes(ext)) {
    return { iconClass: 'icon-type-blue', label: 'DOC' };
  }
  if (['xls', 'xlsx', 'csv', 'ods', 'py', 'c', 'cpp', 'java', 'js', 'ts', 'html', 'css', 'json'].includes(ext)) {
    return { iconClass: 'icon-type-green', label: ext.slice(0, 3).toUpperCase() };
  }
  if (['pdf'].includes(ext)) {
    return { iconClass: 'icon-type-red', label: 'PDF' };
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
    return { iconClass: 'icon-type-amber', label: 'ZIP' };
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
    return { iconClass: 'icon-type-purple', label: 'IMG' };
  }
  return { iconClass: 'icon-type-blue', label: ext ? ext.slice(0, 3).toUpperCase() : 'FILE' };
}

function getCountdownBadgeInfo(expiresAtStr) {
  const now = Date.now();
  const exp = new Date(expiresAtStr).getTime();
  const diffMs = exp - now;

  if (diffMs <= 0) {
    return { countdownText: 'Expired', badgeStyle: 'danger', isExpired: true };
  }

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  let countdownText = '';
  if (days > 0) {
    countdownText = `${days}d ${remHours}h`;
  } else if (hours > 0) {
    countdownText = `${hours}h ${minutes}m`;
  } else {
    countdownText = `${Math.max(1, minutes)}m`;
  }

  let badgeStyle = '';
  if (hours < 2) {
    badgeStyle = 'danger';
  } else if (hours < 24) {
    badgeStyle = 'warning';
  }

  return { countdownText, badgeStyle, isExpired: false };
}

function formatDriveDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();

  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();

  if (sameYear) {
    return `${month} ${day}`;
  }
  return `${month} ${day}, ${d.getFullYear()}`;
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

function copyTextToClipboard(text, successMsg) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(successMsg);
  }).catch(() => {
    const input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast(successMsg);
  });
}

function announcePolitely(msg) {
  if (liveAnnouncer) {
    liveAnnouncer.textContent = '';
    setTimeout(() => {
      liveAnnouncer.textContent = msg;
    }, 50);
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  if (type === 'error') {
    toast.style.borderColor = '#ef4444';
  } else if (type === 'success') {
    toast.style.borderColor = '#22c55e';
  }

  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}

// Bootstrap
document.addEventListener('DOMContentLoaded', initApp);
