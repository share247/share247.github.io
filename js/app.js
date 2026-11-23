/**
 * Share247 — Cloud Vault Application Controller
 * Handles table rendering, navbar uploads, drag-and-drop,
 * sorting, live 7-day countdown, and Supabase / Local storage switching.
 */

import { dbService } from './db.js';
import { moderationService } from './moderation.js';

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
const dateSortArrow = document.getElementById('date-sort-arrow');
const sizeSortArrow = document.getElementById('size-sort-arrow');

// Modals
const shareDialog = document.getElementById('share-dialog');
const shareModalIconBadge = document.getElementById('share-modal-icon-badge');
const shareModalName = document.getElementById('share-modal-name');
const shareModalSize = document.getElementById('share-modal-size');
const shareModalExpires = document.getElementById('share-modal-expires');
const shareUrlInput = document.getElementById('share-url-input');
const btnCopyShareUrl = document.getElementById('btn-copy-share-url');
const btnModalDownload = document.getElementById('btn-modal-download');
const btnTogglePinVisibility = document.getElementById('btn-toggle-pin-visibility');
const unlockPinCode = document.getElementById('unlock-pin-code');

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
    showLoader(true);
    const { mode } = await dbService.init();
    updateFooterDbMode(mode);
    await refreshFilesList(false);
    showLoader(false);
    checkUrlQueryParams();
    startCountdownTicker();

    updateSortUI();

    // Realtime: Listen for file changes (INSERT, DELETE, UPDATE) from other devices!
    dbService.subscribeToFiles((eventType, record) => {
      if (eventType === 'INSERT') {
        const existingIdx = activeFiles.findIndex(f => f.id === record.id);
        if (existingIdx === -1) {
          activeFiles.unshift(record);
          renderFilesTable();
          updateFooterStorageTracker();
          showToast(`New file shared: "${record.name}"`, 'info');
          announcePolitely(`New file shared: ${record.name}`);
        }
      } else if (eventType === 'DELETE') {
        activeFiles = activeFiles.filter(f => f.id !== record.id);
        renderFilesTable();
        updateFooterStorageTracker();
      } else if (eventType === 'UPDATE') {
        const idx = activeFiles.findIndex(f => f.id === record.id);
        if (idx !== -1) {
          activeFiles[idx] = record;
          renderFilesTable();
          updateFooterStorageTracker();
        }
      }
    });

    // Background sync polling every 8s as fallback
    setInterval(async () => {
      try {
        const latest = await dbService.getActiveFiles();
        if (latest && JSON.stringify(latest.map(f => f.id)) !== JSON.stringify(activeFiles.map(f => f.id))) {
          activeFiles = latest;
          renderFilesTable();
        }
      } catch (_) {}
    }, 8000);

  } catch (err) {
    showLoader(false);
    console.error('Initialization error:', err);
    showToast('Failed to initialize database.', 'error');
  }
}

function showLoader(visible) {
  const loader = document.getElementById('vault-loader');
  if (!loader) return;
  if (visible) {
    loader.classList.remove('fade-out');
    loader.hidden = false;
  } else {
    loader.classList.add('fade-out');
    setTimeout(() => {
      if (loader.classList.contains('fade-out')) {
        loader.hidden = true;
      }
    }, 300);
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

  // Navbar & Empty State Link Trigger
  const btnNavbarLink = document.getElementById('btn-navbar-link');
  if (btnNavbarLink) {
    btnNavbarLink.addEventListener('click', () => openLinkDialog());
  }

  const btnEmptyLink = document.getElementById('btn-empty-link');
  if (btnEmptyLink) {
    btnEmptyLink.addEventListener('click', () => openLinkDialog());
  }

  // Copy destination URL button in share modal
  const btnCopyDestinationUrl = document.getElementById('btn-copy-destination-url');
  if (btnCopyDestinationUrl) {
    btnCopyDestinationUrl.addEventListener('click', () => {
      const destInput = document.getElementById('share-destination-input');
      if (destInput && destInput.value) {
        copyTextToClipboard(destInput.value, 'Destination URL copied to clipboard!');
        btnCopyDestinationUrl.classList.add('copied');
        const label = btnCopyDestinationUrl.querySelector('.copy-label');
        if (label) label.textContent = 'Copied! ✓';
        setTimeout(() => {
          btnCopyDestinationUrl.classList.remove('copied');
          if (label) label.textContent = 'Copy URL';
        }, 2000);
      }
    });
  }

  // Paste Event: if user presses Ctrl+V anywhere and clipboard is a URL, open Link Dialog!
  window.addEventListener('paste', (e) => {
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTag === 'input' || activeTag === 'textarea') return;
    const pastedText = (e.clipboardData || window.clipboardData).getData('text');
    if (pastedText && isPotentialUrl(pastedText.trim())) {
      e.preventDefault();
      openLinkDialog(pastedText.trim());
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFiles(Array.from(fileInput.files));
      fileInput.value = '';
    }
  });

  // Full-window Drag and Drop (Reliable counter with file & link type verification)
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    const uploadDialog = document.getElementById('upload-dialog');
    const linkDialog = document.getElementById('link-dialog');
    if ((uploadDialog && uploadDialog.open) || (linkDialog && linkDialog.open)) return;
    if (e.dataTransfer && e.dataTransfer.types && (Array.from(e.dataTransfer.types).includes('Files') || Array.from(e.dataTransfer.types).includes('text/uri-list'))) {
      dragCounter++;
      if (dragCounter === 1) {
        dragOverlay.classList.add('active');
        dragOverlay.hidden = false;
      }
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

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove('active');
    dragOverlay.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    } else if (e.dataTransfer) {
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (text && isPotentialUrl(text.trim())) {
        openLinkDialog(text.trim());
      }
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

  [colSortName, colSortDate, colSortSize].forEach(th => {
    if (th) {
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          th.click();
        }
      });
    }
  });

  // Upload widget close
  btnCloseUploadWidget.addEventListener('click', () => {
    uploadWidget.hidden = true;
  });

  // Dialog backdrop click-to-close & close buttons
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => {
      dialog.scrollLeft = 0;
    });
    dialog.addEventListener('click', (e) => {
      const rect = dialog.getBoundingClientRect();
      const isInDialog = (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      );
      if (!isInDialog) {
        dialog.close();
      }
    });
  });

  document.querySelectorAll('.btn-dialog-close, .btn-dialog-cancel').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const dialog = e.target.closest('dialog');
      if (dialog) dialog.close();
    });
  });

  // PIN visibility toggle
  if (btnTogglePinVisibility && unlockPinCode) {
    btnTogglePinVisibility.addEventListener('click', () => {
      const isPassword = unlockPinCode.type === 'password';
      unlockPinCode.type = isPassword ? 'text' : 'password';
      const eyeIcon = document.getElementById('pin-eye-icon');
      if (eyeIcon) {
        eyeIcon.innerHTML = isPassword
          ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`
          : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`;
      }
    });
  }

  btnCopyShareUrl.addEventListener('click', () => {
    copyTextToClipboard(shareUrlInput.value, 'Direct link copied to clipboard!');
    btnCopyShareUrl.classList.add('copied');
    const labelSpan = btnCopyShareUrl.querySelector('.copy-label');
    if (labelSpan) labelSpan.textContent = 'Copied! ✓';
    setTimeout(() => {
      btnCopyShareUrl.classList.remove('copied');
      if (labelSpan) labelSpan.textContent = 'Copy Link';
    }, 2000);
  });
}

function updateSortUI() {
  const arrows = {
    name: document.getElementById('name-sort-arrow'),
    date: document.getElementById('date-sort-arrow'),
    size: document.getElementById('size-sort-arrow')
  };
  const headers = {
    name: colSortName,
    date: colSortDate,
    size: colSortSize
  };

  ['name', 'date', 'size'].forEach(col => {
    const arrow = arrows[col];
    const header = headers[col];
    if (arrow) {
      if (sortColumn === col) {
        arrow.classList.add('active');
        arrow.classList.toggle('desc', !sortAsc);
      } else {
        arrow.classList.remove('active', 'desc');
      }
    }
    if (header) {
      header.setAttribute('aria-sort', sortColumn === col ? (sortAsc ? 'ascending' : 'descending') : 'none');
    }
  });
}

function cycleSort() {
  const columns = ['date', 'name', 'size'];
  const nextIdx = (columns.indexOf(sortColumn) + 1) % columns.length;
  sortColumn = columns[nextIdx];
  sortAsc = sortColumn === 'name';
  updateSortUI();
  renderFilesTable();
}

function toggleSort(column) {
  if (sortColumn === column) {
    sortAsc = !sortAsc;
  } else {
    sortColumn = column;
    sortAsc = column === 'name';
  }
  updateSortUI();
  renderFilesTable();
}

// ==========================================
// UPLOAD HANDLING & STORAGE CAPACITY MANAGEMENT (FIFO AUTO-PURGE)
// ==========================================

const MAX_VAULT_BYTES = 1073741824; // 1 GB capacity allocation

async function ensureStorageCapacity(newFileSize) {
  if (newFileSize > MAX_VAULT_BYTES) {
    throw new Error(`File size (${dbService.formatBytes(newFileSize)}) exceeds maximum 1 GB vault capacity.`);
  }

  // Refresh active files from DB for live usage check
  try {
    const liveFiles = await dbService.getActiveFiles();
    if (liveFiles && Array.isArray(liveFiles)) {
      activeFiles = liveFiles;
    }
  } catch (_) {}

  const now = Date.now();
  const validFiles = (activeFiles || []).filter(f => new Date(f.expiresAt).getTime() > now);
  const currentTotal = validFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0);

  if (currentTotal + newFileSize > MAX_VAULT_BYTES) {
    const spaceNeeded = (currentTotal + newFileSize) - MAX_VAULT_BYTES;
    console.info(`Share247: Vault full! Freeing ${dbService.formatBytes(spaceNeeded)} by purging oldest files...`);

    // Sort ascending by createdAt (oldest uploaded files first - FIFO)
    const oldestFirst = [...validFiles].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    let freedBytes = 0;
    const evictedFiles = [];

    for (const oldFile of oldestFirst) {
      if (freedBytes >= spaceNeeded) break;
      try {
        await dbService.deleteFile(oldFile.id, oldFile.storagePath);
        freedBytes += Number(oldFile.size) || 0;
        evictedFiles.push(oldFile);
        activeFiles = activeFiles.filter(f => f.id !== oldFile.id);
      } catch (err) {
        console.error('Failed to auto-purge oldest file:', oldFile.id, err);
      }
    }

    if (evictedFiles.length > 0) {
      renderFilesTable();
      updateFooterStorageTracker();
      const names = evictedFiles.map(f => `"${f.name}"`).join(', ');
      showToast(`Database space full: Automatically deleted older file(s) (${names}) to accommodate your current upload.`, 'info');
    }
  }
}

function promptUploadOptions(initialFile) {
  return new Promise((resolve) => {
    let currentFile = initialFile;
    const uploadDialog = document.getElementById('upload-dialog');
    const uploadModalName = document.getElementById('upload-modal-name');
    const uploadModalMeta = document.getElementById('upload-modal-meta');
    const uploadModalBadge = document.getElementById('upload-modal-badge');
    const radioPublic = document.getElementById('radio-access-public');
    const radioPin = document.getElementById('radio-access-pin');
    const pinGroup = document.getElementById('pin-input-group');
    const pinInput = document.getElementById('upload-pin-code');
    const uploadForm = document.getElementById('upload-options-form');
    const modalDropzone = document.getElementById('modal-dropzone');
    const modalFilePicker = document.getElementById('modal-file-picker');

    function updateModalCard(f) {
      const { iconClass, label } = getFileTypeDetails(f.name);
      uploadModalBadge.className = `file-badge ${iconClass}`;
      uploadModalBadge.textContent = label;
      uploadModalName.textContent = f.name;
      uploadModalMeta.textContent = `${dbService.formatBytes(f.size)} • Auto-purges after 7 days`;
    }

    updateModalCard(currentFile);

    radioPublic.checked = true;
    radioPin.checked = false;
    pinGroup.hidden = true;
    pinInput.value = '';

    const handleRadioChange = () => {
      pinGroup.hidden = !radioPin.checked;
      if (radioPin.checked) {
        pinInput.focus();
      }
    };

    radioPublic.onchange = handleRadioChange;
    radioPin.onchange = handleRadioChange;

    // In-Modal Drag & Drop & Browse
    if (modalDropzone && modalFilePicker) {
      modalDropzone.onclick = () => modalFilePicker.click();
      modalDropzone.ondragover = (e) => {
        e.preventDefault();
        modalDropzone.classList.add('dragover');
      };
      modalDropzone.ondragleave = () => {
        modalDropzone.classList.remove('dragover');
      };
      modalDropzone.ondrop = (e) => {
        e.preventDefault();
        modalDropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          currentFile = e.dataTransfer.files[0];
          updateModalCard(currentFile);
        }
      };

      modalFilePicker.onchange = () => {
        if (modalFilePicker.files && modalFilePicker.files.length > 0) {
          currentFile = modalFilePicker.files[0];
          updateModalCard(currentFile);
          modalFilePicker.value = '';
        }
      };
    }

    const handleSubmit = (e) => {
      e.preventDefault();
      uploadForm.removeEventListener('submit', handleSubmit);
      uploadDialog.removeEventListener('close', handleCancel);

      let pin = null;
      if (radioPin.checked) {
        pin = pinInput.value.trim();
        if (!pin) {
          showToast('Please enter a PIN or select Public.', 'error');
          return;
        }
      }

      uploadDialog.close();
      resolve({ proceed: true, file: currentFile, pin });
    };

    const handleCancel = () => {
      uploadForm.removeEventListener('submit', handleSubmit);
      uploadDialog.removeEventListener('close', handleCancel);
      resolve({ proceed: false, file: null, pin: null });
    };

    uploadForm.addEventListener('submit', handleSubmit);
    uploadDialog.addEventListener('close', handleCancel, { once: true });

    uploadDialog.scrollLeft = 0;
    uploadDialog.showModal();
  });
}

async function handleFiles(files) {
  for (const file of files) {
    if (file.size > 100 * 1024 * 1024) {
      showToast(`"${file.name}" exceeds 100 MB limit.`, 'error');
      continue;
    }
    const { proceed, file: chosenFile, pin } = await promptUploadOptions(file);
    if (proceed && chosenFile) {
      await uploadSingleFile(chosenFile, pin);
    }
  }
}

async function uploadSingleFile(file, pin = null) {
  // 1. Ensure storage capacity (FIFO Auto-Purge oldest files if database becomes full)
  try {
    await ensureStorageCapacity(file.size);
  } catch (capErr) {
    showToast(capErr.message || 'Vault capacity exceeded', 'error');
    return;
  }

  uploadWidget.hidden = false;
  uploadWidgetTitle.textContent = 'Uploading File';
  widgetFileName.textContent = file.name;

  const tracerBarFill = document.getElementById('tracer-bar-fill');
  const widgetFilePercent = document.getElementById('widget-file-percent');
  const tracerSize = document.getElementById('tracer-size');
  const tracerSpeed = document.getElementById('tracer-speed');
  const tracerEta = document.getElementById('tracer-eta');
  const pulseDot = document.getElementById('tracer-pulse-dot');

  if (pulseDot) pulseDot.style.backgroundColor = '#38bdf8';
  if (tracerBarFill) tracerBarFill.style.width = '0%';
  if (widgetFilePercent) widgetFilePercent.textContent = '0%';
  if (tracerSize) tracerSize.textContent = `0 B / ${dbService.formatBytes(file.size)}`;
  if (tracerSpeed) tracerSpeed.textContent = 'Measuring...';
  if (tracerEta) tracerEta.textContent = 'Calculating...';

  const { iconClass, label } = getFileTypeDetails(file.name);
  widgetFileIcon.className = `widget-badge ${iconClass}`;
  widgetFileIcon.textContent = label;

  try {
    const uploaded = await dbService.uploadFile(file, (telemetry) => {
      if (typeof telemetry === 'number') {
        telemetry = { percent: telemetry };
      }
      const {
        percent = 0,
        formattedLoaded = '0 B',
        formattedTotal = dbService.formatBytes(file.size),
        formattedSpeed = '--',
        formattedEta = '--'
      } = telemetry;

      if (tracerBarFill) tracerBarFill.style.width = `${percent}%`;
      if (widgetFilePercent) widgetFilePercent.textContent = `${percent}%`;
      if (tracerSize) tracerSize.textContent = `${formattedLoaded} / ${formattedTotal}`;
      if (tracerSpeed) tracerSpeed.textContent = formattedSpeed;
      if (tracerEta) tracerEta.textContent = formattedEta;
    }, pin);

    uploadWidgetTitle.textContent = 'Upload Complete';
    if (widgetFilePercent) widgetFilePercent.textContent = '100%';
    if (tracerBarFill) tracerBarFill.style.width = '100%';
    if (tracerSpeed) tracerSpeed.textContent = 'Done';
    if (tracerEta) tracerEta.textContent = 'Saved';
    if (pulseDot) pulseDot.style.backgroundColor = '#4ade80';

    announcePolitely(`Uploaded ${file.name} successfully`);
    showToast(pin ? `Shared "${file.name}" (PIN Protected)!` : `Shared "${file.name}" for 7 days!`, 'success');

    // Instantly add to dashboard runtime so it views instantly!
    const existingIdx = activeFiles.findIndex(f => f.id === uploaded.id);
    if (existingIdx >= 0) {
      activeFiles[existingIdx] = uploaded;
    } else {
      activeFiles.unshift(uploaded);
    }
    renderFilesTable();
    updateFooterStorageTracker();

    // Auto open share modal
    openShareDialog(uploaded);

    // Asynchronous background AI safety scan (Gemini API)
    moderationService.screenItem(uploaded).then((modResult) => {
      if (modResult.decision === 'NO' || !modResult.safe) {
        uploaded.moderationStatus = 'flagged';
        uploaded.moderationReason = modResult.reason;
        renderFilesTable();
        showToast(`⚠️ AI Safety Alert: "${uploaded.name}" flagged (${modResult.reason}). Owner notified.`, 'error');
      }
    }).catch((e) => console.warn('Moderation error:', e));

    // Asynchronous background AI safety scan (Gemini API)
    moderationService.screenItem(uploaded, file).then((modResult) => {
      if (modResult.decision === 'NO' || !modResult.safe) {
        uploaded.moderationStatus = 'flagged';
        uploaded.moderationReason = modResult.reason;
        renderFilesTable();
        showToast(`⚠️ AI Safety Alert: "${uploaded.name}" flagged (${modResult.reason}). Owner notified.`, 'error');
      }
    }).catch((e) => console.warn('Moderation error:', e));
  } catch (err) {
    console.error('Upload failed:', err);
    uploadWidgetTitle.textContent = 'Upload Failed';
    if (pulseDot) pulseDot.style.backgroundColor = '#ef4444';
    showToast(`Upload failed: ${err.message || err}`, 'error');
  } finally {
    setTimeout(() => {
      uploadWidget.hidden = true;
    }, 4500);
  }
}

function openLinkDialog(initialUrl = '') {
  const linkDialog = document.getElementById('link-dialog');
  const linkForm = document.getElementById('link-options-form');
  const urlInput = document.getElementById('link-url-input');

  if (!linkDialog || !linkForm || !urlInput) return;

  urlInput.value = initialUrl;

  const handleSubmit = async (e) => {
    e.preventDefault();
    const rawUrl = urlInput.value.trim();
    if (!rawUrl) {
      showToast('Please enter a destination URL.', 'error');
      urlInput.focus();
      return;
    }

    const normalized = normalizeUrl(rawUrl);
    try {
      new URL(normalized);
    } catch (_) {
      showToast('Please enter a valid URL (e.g. https://example.com)', 'error');
      urlInput.focus();
      return;
    }

    linkForm.removeEventListener('submit', handleSubmit);
    linkDialog.close();

    await uploadSingleLink(normalized);
  };

  linkForm.onsubmit = handleSubmit;
  linkDialog.scrollLeft = 0;
  linkDialog.showModal();

  setTimeout(() => {
    urlInput.focus();
  }, 60);
}

async function uploadSingleLink(url) {
  uploadWidget.hidden = false;
  uploadWidgetTitle.textContent = 'Saving Link';
  const websiteName = extractDomain(url) || url.replace(/^https?:\/\//i, '').split('/')[0];
  widgetFileName.textContent = websiteName;

  const tracerBarFill = document.getElementById('tracer-bar-fill');
  const widgetFilePercent = document.getElementById('widget-file-percent');
  const tracerSize = document.getElementById('tracer-size');
  const tracerSpeed = document.getElementById('tracer-speed');
  const tracerEta = document.getElementById('tracer-eta');
  const pulseDot = document.getElementById('tracer-pulse-dot');

  if (pulseDot) pulseDot.style.backgroundColor = '#38bdf8';
  if (tracerBarFill) tracerBarFill.style.width = '40%';
  if (widgetFilePercent) widgetFilePercent.textContent = '40%';
  if (tracerSize) tracerSize.textContent = 'Web Link';
  if (tracerSpeed) tracerSpeed.textContent = 'Saving...';
  if (tracerEta) tracerEta.textContent = 'Instant';

  widgetFileIcon.className = 'widget-badge icon-type-cyan';
  widgetFileIcon.textContent = 'LINK';

  try {
    const uploaded = await dbService.uploadLink(url, websiteName);
    uploaded.name = websiteName;

    uploadWidgetTitle.textContent = 'Link Saved';
    if (widgetFilePercent) widgetFilePercent.textContent = '100%';
    if (tracerBarFill) tracerBarFill.style.width = '100%';
    if (tracerSpeed) tracerSpeed.textContent = 'Done';
    if (tracerEta) tracerEta.textContent = 'Saved';
    if (pulseDot) pulseDot.style.backgroundColor = '#4ade80';

    announcePolitely(`Shared link ${websiteName} successfully`);
    showToast(`Shared link "${websiteName}" for 7 days!`, 'success');

    const existingIdx = activeFiles.findIndex(f => f.id === uploaded.id);
    if (existingIdx >= 0) {
      activeFiles[existingIdx] = uploaded;
    } else {
      activeFiles.unshift(uploaded);
    }
    renderFilesTable();
    updateFooterStorageTracker();

    openShareDialog(uploaded);

    // Asynchronous background AI safety scan (Gemini API)
    moderationService.screenItem(uploaded).then((modResult) => {
      if (modResult.decision === 'NO' || !modResult.safe) {
        uploaded.moderationStatus = 'flagged';
        uploaded.moderationReason = modResult.reason;
        renderFilesTable();
        showToast(`⚠️ AI Safety Alert: "${uploaded.name}" flagged (${modResult.reason}). Owner notified.`, 'error');
      }
    }).catch((e) => console.warn('Moderation error:', e));
  } catch (err) {
    console.error('Link save failed:', err);
    uploadWidgetTitle.textContent = 'Save Failed';
    if (pulseDot) pulseDot.style.backgroundColor = '#ef4444';
    showToast(`Could not save link: ${err.message || err}`, 'error');
  } finally {
    setTimeout(() => {
      uploadWidget.hidden = true;
    }, 4000);
  }
}

// ==========================================
// TABLE RENDERING
// ==========================================

async function refreshFilesList(showSpinner = true) {
  try {
    if (showSpinner) showLoader(true);
    activeFiles = await dbService.getActiveFiles();
    renderFilesTable();
  } catch (err) {
    console.error('Failed to load files:', err);
    showToast('Could not fetch active files.', 'error');
  } finally {
    if (showSpinner) showLoader(false);
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
      (f.downloadUrl && f.downloadUrl.toLowerCase().includes(query)) ||
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
    const emptyTitle = emptyState.querySelector('h2');
    const emptyDesc = emptyState.querySelector('p');
    const btnEmptyUpload = document.getElementById('btn-empty-upload');
    const btnEmptyLink = document.getElementById('btn-empty-link');
    if (query) {
      if (emptyTitle) emptyTitle.textContent = `No items matching "${query}"`;
      if (emptyDesc) emptyDesc.innerHTML = 'Try adjusting your search query or clear the filter.';
      if (btnEmptyUpload) btnEmptyUpload.hidden = true;
      if (btnEmptyLink) btnEmptyLink.hidden = true;
    } else {
      if (emptyTitle) emptyTitle.textContent = 'Vault is empty';
      if (emptyDesc) emptyDesc.innerHTML = 'Upload a file or share a link to store it for 7 days with automatic purging.';
      if (btnEmptyUpload) btnEmptyUpload.hidden = false;
      if (btnEmptyLink) btnEmptyLink.hidden = false;
    }
    updateFooterStorageTracker();
    return;
  }

  emptyState.hidden = true;

  filtered.forEach((file) => {
    const tr = document.createElement('tr');
    const isItemLink = Boolean(file.isLink || file.type === 'url' || file.extension === 'link');
    const displayName = isItemLink ? (extractDomain(file.downloadUrl || file.name) || file.name) : file.name;
    const { iconClass, label } = getFileTypeDetails(file.name, isItemLink);
    const { countdownText, badgeStyle } = getCountdownBadgeInfo(file.expiresAt);
    const formattedDate = formatDriveDate(file.createdAt);

    const iconHtml = isItemLink
      ? `<div class="row-file-icon icon-type-cyan" title="Shared Web Link">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
          </svg>
        </div>`
      : `<div class="row-file-icon ${iconClass}">${label}</div>`;

    const sizeHtml = isItemLink
      ? `<span class="badge-link-size">Link</span>`
      : (file.formattedSize || dbService.formatBytes(file.size));

    const actionBtnHtml = isItemLink
      ? `<button class="row-action-btn btn-open-link" data-id="${file.id}" type="button" title="Open destination link" aria-label="Open Link">
           <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
         </button>`
      : `<button class="row-action-btn btn-download" data-id="${file.id}" type="button" title="Download" aria-label="Download">
           <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
         </button>`;

    tr.innerHTML = `
      <td class="cell-name">
        <div class="cell-name-content">
          ${iconHtml}
          <div class="row-filename" title="${escapeHtml(displayName)}">
            <span class="row-title-text">${escapeHtml(displayName)}</span>
            ${file.hasPin ? `<span class="badge-pin-protected" title="Protected with PIN"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>PIN</span>` : ''}
            ${file.moderationStatus === 'flagged' ? `<span class="badge-flagged" title="Flagged by AI safety scan: ${escapeHtml(file.moderationReason || 'Prohibited content')}">⚠️ Flagged</span>` : ''}
          </div>
        </div>
      </td>
      <td class="cell-date">${formattedDate}</td>
      <td class="cell-expires">
        <span class="expires-pill ${badgeStyle}" data-expires="${file.expiresAt}" title="Auto-purges in ${countdownText}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          <span class="countdown-label">${countdownText}</span>
        </span>
      </td>
      <td class="cell-size">${sizeHtml}</td>
      <td class="cell-actions">
        <div class="row-hover-actions">
          <button class="row-action-btn btn-share" data-id="${file.id}" type="button" title="Share" aria-label="Share">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
          </button>
          ${actionBtnHtml}
          <button class="row-action-btn btn-details" data-id="${file.id}" type="button" title="More options" aria-label="More options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
          </button>
        </div>
      </td>
    `;

    // Action handlers
    const btnDownload = tr.querySelector('.btn-download');
    if (btnDownload) {
      btnDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDownloadAttempt(file);
      });
    }

    const btnOpenLink = tr.querySelector('.btn-open-link');
    if (btnOpenLink) {
      btnOpenLink.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDownloadAttempt(file);
      });
    }

    tr.querySelector('.btn-share').addEventListener('click', (e) => {
      e.stopPropagation();
      openShareDialog(file);
    });

    tr.querySelector('.btn-details').addEventListener('click', (e) => {
      e.stopPropagation();
      openShareDialog(file);
    });

    tr.addEventListener('dblclick', () => {
      if (isItemLink) {
        handleDownloadAttempt(file);
      } else {
        openShareDialog(file);
      }
    });

    filesTbody.appendChild(tr);
  });

  updateFooterStorageTracker();
}

function updateFooterStorageTracker() {
  const footerStorageUsed = document.getElementById('footer-storage-used');
  const footerStoragePercent = document.getElementById('footer-storage-percent');
  const footerFilesCount = document.getElementById('footer-files-count');
  const footerStorageFill = document.getElementById('footer-storage-fill');

  if (!footerStorageFill) return;

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

  if (footerStorageUsed) footerStorageUsed.textContent = `${formattedUsed} / 1 GB`;
  if (footerStoragePercent) footerStoragePercent.textContent = `(${percentDisplay})`;
  if (footerFilesCount) footerFilesCount.textContent = `${count} ${count === 1 ? 'active file' : 'active files'}`;

  // Red filled space bar expanding across the full footer width
  // Ensure a minimum visible trace of 0.8% if any files exist so the red fill is clearly visible
  const fillWidth = totalBytes > 0 ? Math.max(0.8, percent) : 0;
  footerStorageFill.style.width = `${fillWidth}%`;

  const vaultFooter = document.getElementById('vault-footer');
  if (vaultFooter) {
    vaultFooter.title = `Database Space: ${formattedUsed} / 1 GB (${percentDisplay}) • ${count} active files`;
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

const unlockedFileIds = new Set();

function handleDownloadAttempt(file, onSuccess) {
  if (file.hasPin && !unlockedFileIds.has(file.id)) {
    openPinModal(file, () => {
      unlockedFileIds.add(file.id);
      if (onSuccess) {
        onSuccess();
      } else {
        triggerItemAction(file);
      }
    });
    return;
  }

  if (onSuccess) {
    onSuccess();
  } else {
    triggerItemAction(file);
  }
}

async function triggerItemAction(file) {
  if (file.isLink) {
    try {
      await dbService.incrementDownload(file.id);
      file.downloadsCount = (file.downloadsCount || 0) + 1;
      window.open(file.downloadUrl, '_blank', 'noopener,noreferrer');
      showToast(`Opening "${file.name}"...`, 'info');
    } catch (_) {
      window.open(file.downloadUrl, '_blank', 'noopener,noreferrer');
    }
  } else {
    triggerDownload(file);
  }
}

function openPinModal(file, onUnlocked) {
  const pinDialog = document.getElementById('pin-dialog');
  const pinDialogTitle = document.getElementById('pin-dialog-title');
  const pinDialogDesc = document.getElementById('pin-dialog-desc');
  const pinModalName = document.getElementById('pin-modal-name');
  const pinModalMeta = document.getElementById('pin-modal-meta');
  const pinModalBadge = document.getElementById('pin-modal-badge');
  const pinInput = document.getElementById('unlock-pin-code');
  const errorFeedback = document.getElementById('pin-error-feedback');
  const pinForm = document.getElementById('pin-unlock-form');
  const pinSubmitText = document.getElementById('pin-submit-text');

  if (file.isLink) {
    if (pinDialogTitle) pinDialogTitle.textContent = 'Protected Link';
    if (pinDialogDesc) pinDialogDesc.textContent = 'This link is secured with an access PIN. Enter the PIN to unlock and open.';
    pinModalBadge.className = 'file-badge icon-type-cyan';
    pinModalBadge.textContent = 'LINK';
    const websiteName = extractDomain(file.downloadUrl || file.name) || file.name;
    pinModalName.textContent = websiteName;
    pinModalMeta.textContent = 'Web Link • 🔒 PIN Protected';
    if (pinSubmitText) pinSubmitText.textContent = 'Unlock & Open';
  } else {
    const { iconClass, label } = getFileTypeDetails(file.name);
    if (pinDialogTitle) pinDialogTitle.textContent = 'Protected File';
    if (pinDialogDesc) pinDialogDesc.textContent = 'This file is secured with an access PIN. Enter the PIN to unlock and download.';
    pinModalBadge.className = `file-badge ${iconClass}`;
    pinModalBadge.textContent = label;
    pinModalName.textContent = file.name;
    pinModalMeta.textContent = `${file.formattedSize || dbService.formatBytes(file.size)} • 🔒 PIN Protected`;
    if (pinSubmitText) pinSubmitText.textContent = 'Unlock & Download';
  }

  pinInput.value = '';
  pinInput.type = 'password';
  const eyeIcon = document.getElementById('pin-eye-icon');
  if (eyeIcon) {
    eyeIcon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="3" r="3"></circle>`;
  }
  errorFeedback.hidden = true;

  const handleSubmit = (e) => {
    e.preventDefault();
    const enteredPin = pinInput.value.trim();
    if (enteredPin === String(file.pin).trim()) {
      pinForm.removeEventListener('submit', handleSubmit);
      unlockedFileIds.add(file.id);
      pinDialog.close();
      showToast('PIN verified successfully!', 'success');
      if (onUnlocked) onUnlocked();
    } else {
      errorFeedback.hidden = false;
      const box = pinDialog.querySelector('.dialog-box');
      if (box) {
        box.classList.remove('shake');
        void box.offsetWidth;
        box.classList.add('shake');
        setTimeout(() => box.classList.remove('shake'), 400);
      }
      pinInput.select();
      pinInput.focus();
    }
  };

  pinForm.onsubmit = handleSubmit;
  pinDialog.showModal();
}

async function triggerDownload(file) {
  try {
    showToast(`Preparing download for "${file.name}"...`);
    await dbService.incrementDownload(file.id);
    file.downloadsCount = (file.downloadsCount || 0) + 1;

    try {
      // Fetch as blob to guarantee cross-origin download attribute is honored by browser
      const response = await fetch(file.downloadUrl, { mode: 'cors' });
      if (!response.ok) throw new Error('Blob fetch failed');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      showToast(`Downloading "${file.name}"...`, 'success');
    } catch (blobErr) {
      // Fallback for direct link navigation
      const a = document.createElement('a');
      a.href = file.downloadUrl;
      a.download = file.name;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`Downloading "${file.name}"...`);
    }
  } catch (err) {
    console.error('Download error:', err);
    showToast('Failed to trigger download.', 'error');
  }
}

async function handleDeleteFile(file) {
  const confirmed = window.confirm(`Are you sure you want to permanently delete "${file.name}" from the vault?`);
  if (!confirmed) return;

  try {
    await dbService.deleteFile(file.id, file.storagePath);
    activeFiles = activeFiles.filter(f => f.id !== file.id);
    renderFilesTable();
    updateFooterStorageTracker();
    showToast(`Deleted "${file.name}" from public vault.`, 'success');
    const shareDialog = document.getElementById('share-dialog');
    if (shareDialog && shareDialog.open) {
      shareDialog.close();
    }
  } catch (err) {
    console.error('Delete error:', err);
    showToast(`Could not delete file: ${err.message || err}`, 'error');
  }
}

function openShareDialog(file) {
  const isLink = Boolean(file.isLink || (file.storagePath && file.storagePath.startsWith('link://')));
  const { iconClass, label } = getFileTypeDetails(file.name, isLink);
  const { countdownText } = getCountdownBadgeInfo(file.expiresAt);

  shareModalIconBadge.className = `file-badge ${iconClass}`;
  shareModalIconBadge.textContent = label;
  const displayName = isLink ? (extractDomain(file.downloadUrl || file.name) || file.name) : file.name;
  shareModalName.textContent = displayName;
  shareModalSize.textContent = `${isLink ? 'Web Link' : (file.formattedSize || dbService.formatBytes(file.size))}${file.hasPin ? ' • 🔒 PIN Protected' : ''}`;
  shareModalExpires.textContent = `Auto-purges in ${countdownText}`;

  const shareTitle = document.getElementById('share-dialog-title');
  if (shareTitle) {
    shareTitle.textContent = isLink ? 'Link Details' : 'File Details';
  }

  const shareHeaderSvg = document.getElementById('share-dialog-header-svg');
  if (shareHeaderSvg) {
    if (isLink) {
      shareHeaderSvg.innerHTML = `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>`;
    } else {
      shareHeaderSvg.innerHTML = `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline>`;
    }
  }

  const destGroup = document.getElementById('share-destination-group');
  const destInput = document.getElementById('share-destination-input');
  if (isLink) {
    if (destGroup) destGroup.hidden = false;
    if (destInput) destInput.value = file.downloadUrl || '';
  } else {
    if (destGroup) destGroup.hidden = true;
  }

  const shareHint = document.getElementById('share-dialog-hint');
  if (shareHint) {
    shareHint.textContent = isLink
      ? 'Anyone with this link can view and open this web resource directly.'
      : 'Anyone with this link can view and download this file directly.';
  }

  const modalDownloadLabel = document.getElementById('modal-download-label');
  if (modalDownloadLabel) {
    modalDownloadLabel.textContent = isLink ? 'Open Link' : 'Download';
  }

  const modalDownloadIcon = document.getElementById('modal-download-icon');
  if (modalDownloadIcon) {
    if (isLink) {
      modalDownloadIcon.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
    } else {
      modalDownloadIcon.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    }
  }

  const shareUrl = `${window.location.origin}${window.location.pathname}?file=${encodeURIComponent(file.id)}`;
  shareUrlInput.value = shareUrl;

  btnModalDownload.href = '#';
  btnModalDownload.removeAttribute('download');
  btnModalDownload.onclick = (e) => {
    e.preventDefault();
    handleDownloadAttempt(file);
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
        if (file.hasPin && !unlockedFileIds.has(file.id)) {
          openPinModal(file, () => {
            unlockedFileIds.add(file.id);
            openShareDialog(file);
          });
        } else {
          openShareDialog(file);
        }
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

function getFileTypeDetails(filename, isLink = false) {
  if (isLink || (filename && (filename.endsWith('.link') || filename.endsWith('.url')))) {
    return { iconClass: 'icon-type-cyan', label: 'LINK', isLink: true };
  }
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

function isPotentialUrl(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (s.length > 2000) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^www\.[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(s)) return true;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(:\d+)?(\/.*)?$/i.test(s) && !/\s/.test(s)) return true;
  return false;
}

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') return '';
  let trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

function extractDomain(urlStr) {
  if (!urlStr) return '';
  try {
    const url = new URL(normalizeUrl(urlStr));
    return url.hostname.replace(/^www\./i, '');
  } catch (_) {
    return urlStr;
  }
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

  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  const year = d.getFullYear();

  return `${timeStr} • ${month} ${day}, ${year}`;
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
