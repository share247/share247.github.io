/**
 * Share247 — Dedicated /home Overview Page Controller
 */

const btnShareSite = document.getElementById('btn-share-site');
const shareStatus = document.getElementById('share-site-status');

function setShareFeedback(message) {
  if (!shareStatus) return;
  shareStatus.textContent = message;
  window.clearTimeout(setShareFeedback.timerId);
  setShareFeedback.timerId = window.setTimeout(() => {
    shareStatus.textContent = '';
  }, 3200);
}

if (btnShareSite) {
  btnShareSite.addEventListener('click', async () => {
    const shareUrl = `${window.location.origin}/`;
    const shareData = {
      title: 'Share247 — Free Anonymous File, Text & Link Sharing',
      text: 'Upload files up to 100 MB, share text or source code snippets, and send web links with optional PIN protection.',
      url: shareUrl
    };

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareFeedback('Share247 link copied to clipboard!');
    } catch (_) {
      setShareFeedback(`Share URL: ${shareUrl}`);
    }
  });
}
