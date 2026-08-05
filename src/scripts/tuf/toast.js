/**
 * TUFHub In-Page Floating Toast Notification
 * Robust dismissal, timer cancellation, and z-index management
 * Author: Mohit Arora (@Arora-Sir)
 */

let activeTimer = null;
let transitionTimer = null;

export function hideToast() {
  const toast = document.getElementById('tufhub-toast');
  if (!toast) return;

  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (transitionTimer) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }

  toast.style.opacity = '0';
  toast.style.transform = 'translateY(20px)';
  toast.style.pointerEvents = 'none';

  transitionTimer = setTimeout(() => {
    toast.style.display = 'none';
    transitionTimer = null;
  }, 350);
}

export function showToast(message, type = 'info', reasonCode = '', actionCallback = null, actionLabel = 'Fix it') {
  let toast = document.getElementById('tufhub-toast');

  // Cancel any active dismiss or transition timers from previous toasts
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (transitionTimer) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }

  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tufhub-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: rgba(15, 15, 17, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      padding: 12px 16px;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      gap: 10px;
      transition: opacity 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      opacity: 0;
      transform: translateY(20px);
      pointer-events: none;
    `;
    document.body.appendChild(toast);
  }

  // Ensure toast is visible & interactive
  toast.style.display = 'flex';
  toast.style.pointerEvents = 'auto';

  let icon = 'ℹ️';
  let borderColor = 'rgba(255, 255, 255, 0.15)';

  if (type === 'success') {
    icon = '✅';
    borderColor = 'rgba(34, 197, 94, 0.4)';
  } else if (type === 'error') {
    icon = '❌';
    borderColor = 'rgba(239, 68, 68, 0.4)';
  } else if (type === 'syncing') {
    icon = '🔄';
    borderColor = 'rgba(59, 130, 246, 0.4)';
  }

  toast.style.borderColor = borderColor;

  // Clear previous contents safely
  toast.replaceChildren();

  const iconSpan = document.createElement('span');
  iconSpan.textContent = icon;
  toast.appendChild(iconSpan);

  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;
  toast.appendChild(messageSpan);

  if (reasonCode) {
    const codeSpan = document.createElement('span');
    codeSpan.style.cssText = 'font-size: 11px; opacity: 0.7; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px;';
    codeSpan.textContent = reasonCode;
    toast.appendChild(codeSpan);
  }

  if (actionCallback) {
    const actionBtn = document.createElement('a');
    actionBtn.href = '#';
    actionBtn.style.cssText = 'color: #fff; font-weight: 600; font-size: 12px; background: rgba(249,115,22,0.85); padding: 2px 10px; border-radius: 20px; text-decoration: none; margin-left: 8px; white-space: nowrap; flex-shrink: 0;';
    actionBtn.textContent = actionLabel;
    actionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      actionCallback();
    });
    toast.appendChild(actionBtn);
  }

  // Close Button (x)
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-size: 14px;
    cursor: pointer;
    margin-left: 8px;
    padding: 0 4px;
    line-height: 1;
    transition: color 0.15s;
  `;
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#ffffff'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'rgba(255, 255, 255, 0.5)'; });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideToast();
  });
  toast.appendChild(closeBtn);

  // Animate In
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  // Auto Dismiss logic
  const duration = type === 'error' ? 8000 : (type === 'syncing' ? 15000 : (actionCallback ? 10000 : 7000));
  activeTimer = setTimeout(() => {
    hideToast();
  }, duration);
}
