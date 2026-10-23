const token = localStorage.getItem('fb_token');
const user = JSON.parse(localStorage.getItem('fb_user') || 'null');
const partnerRoles = new Set(['donor', 'demand_org', 'food_bank', 'biogas_operator']);

if (token && user && partnerRoles.has(user.role)) {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function readDocument(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read the selected document.'));
      reader.readAsDataURL(file);
    });
  }

  function formatDate(value) {
    const date = new Date(String(value || '').replace(' ', 'T') + (String(value || '').includes('Z') ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function loadVerificationRequest() {
    try {
      const response = await fetch('/api/partner-verification', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.request) {
        document.getElementById('partner-verification-widget')?.remove();
        document.getElementById('partner-verification-launcher')?.remove();
        return;
      }
      renderVerificationRequest(data.request);
    } catch (_) {
      // Keep the dashboard usable when verification requests cannot be loaded.
    }
  }

  function renderVerificationRequest(request) {
    let widget = document.getElementById('partner-verification-widget');
    let launcher = document.getElementById('partner-verification-launcher');
    if (!widget) {
      widget = document.createElement('aside');
      widget.id = 'partner-verification-widget';
      widget.className = 'partner-verification-widget';
      widget.setAttribute('aria-labelledby', 'partner-verification-title');
      document.body.append(widget);
    }
    if (!launcher) {
      launcher = document.createElement('button');
      launcher.id = 'partner-verification-launcher';
      launcher.className = 'partner-verification-launcher';
      launcher.type = 'button';
      launcher.textContent = 'Verification request';
      launcher.hidden = true;
      launcher.addEventListener('click', () => {
        widget.hidden = false;
        launcher.hidden = true;
      });
      document.body.append(launcher);
    }

    const requestDate = formatDate(request.createdAt);
    const sent = request.response;
    widget.innerHTML = `
      <div class="partner-verification-head">
        <div><small>Partner verification</small><h2 id="partner-verification-title">Additional information requested</h2></div>
        <button class="partner-verification-dismiss" type="button" aria-label="Minimize verification request">×</button>
      </div>
      <div class="partner-verification-body">
        <p class="partner-verification-label">Requested by FoodBridge${requestDate ? ` · ${escapeHtml(requestDate)}` : ''}</p>
        <div class="partner-verification-request"></div>
        ${sent ? `
          <p class="partner-verification-label">Your response${formatDate(sent.createdAt) ? ` · ${escapeHtml(formatDate(sent.createdAt))}` : ''}</p>
          <div class="partner-verification-sent"></div>
          ${sent.documentUrl ? '<a class="partner-verification-document" target="_blank" rel="noopener">View your attached document</a>' : ''}
        ` : `
          <form class="partner-verification-form">
            <label class="partner-verification-label" for="partner-verification-message">Your response</label>
            <textarea id="partner-verification-message" maxlength="4000" placeholder="Answer the request or explain the information you are providing."></textarea>
            <label class="partner-verification-label" for="partner-verification-file" style="display:block;margin-top:10px">Supporting document (optional)</label>
            <input class="partner-verification-file" id="partner-verification-file" type="file" accept=".pdf,.jpg,.jpeg,.png" />
            <p class="partner-verification-help">PDF, JPG or PNG · up to 4 MB. Submit a written response, a document, or both.</p>
            <button class="partner-verification-submit" type="submit">Send response to admin</button>
            <p class="partner-verification-status" role="status" aria-live="polite"></p>
          </form>
        `}
      </div>`;

    widget.querySelector('.partner-verification-request').textContent = request.notes || 'Please provide the additional information requested by the administrator.';
    if (sent) {
      widget.querySelector('.partner-verification-sent').textContent = sent.text || sent.documentName || 'Your response was sent and is awaiting review.';
      const documentLink = widget.querySelector('.partner-verification-document');
      if (documentLink && String(sent.documentUrl).startsWith('/')) documentLink.href = sent.documentUrl;
    } else {
      widget.querySelector('.partner-verification-form').addEventListener('submit', submitResponse);
    }
    widget.querySelector('.partner-verification-dismiss').addEventListener('click', () => {
      widget.hidden = true;
      launcher.hidden = false;
    });
  }

  async function submitResponse(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = form.querySelector('textarea').value.trim();
    const file = form.querySelector('input[type="file"]').files[0];
    const status = form.querySelector('.partner-verification-status');
    const button = form.querySelector('button[type="submit"]');
    if (!message && !file) {
      status.textContent = 'Write a response or attach a supporting document.';
      return;
    }
    if (file && file.size > 4 * 1024 * 1024) {
      status.textContent = 'Choose a document smaller than 4 MB.';
      return;
    }

    button.disabled = true;
    button.textContent = 'Sending…';
    status.textContent = '';
    status.classList.remove('success');
    try {
      const documentData = file ? await readDocument(file) : '';
      const response = await fetch('/api/partner-verification/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, documentName: file?.name || '', documentData })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Your response could not be sent.');
      status.textContent = 'Response sent. The administrator can now review your application.';
      status.classList.add('success');
      await loadVerificationRequest();
    } catch (error) {
      status.textContent = error.message || 'Your response could not be sent.';
    } finally {
      button.disabled = false;
      button.textContent = 'Send response to admin';
    }
  }

  loadVerificationRequest();
  window.setInterval(loadVerificationRequest, 60000);
}
