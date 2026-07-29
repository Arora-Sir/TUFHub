/**
 * TUFHub In-Page Floating Toast Notification
 * Author: Mohit Arora (@Arora-Sir)
 */

export function showToast(message, type = 'info', reasonCode = '', actionCallback = null) {
  let toast = document.getElementById('tufhub-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tufhub-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: rgba(15, 15, 17, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      padding: 12px 18px;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      gap: 10px;
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      opacity: 0;
      transform: translateY(20px);
    `;
    document.body.appendChild(toast);
  }

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
  }

  toast.style.borderColor = borderColor;

  // Clear previous toast contents safely without innerHTML
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
    actionBtn.style.cssText = 'color: #f97316; font-weight: 600; text-decoration: underline; margin-left: 6px;';
    actionBtn.textContent = '[Fix it]';
    actionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      actionCallback();
    });
    toast.appendChild(actionBtn);
  }

  // Animate In
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  // Auto Dismiss
  const duration = type === 'error' ? 8000 : 3500;
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
  }, duration);
}
