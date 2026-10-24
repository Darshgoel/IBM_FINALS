/**
 * FoodBridge — Admin & Verification Dashboard
 *
 * Sections: Overview, Org Verification, All Participants,
 *           Safety Review, Disputes, Compliance Records
 *
 * Every screen is driven by the target Express/SQLite admin API.
 * There is no demo-data fallback: when the API cannot be reached the UI
 * reports the failure instead of inventing platform activity.
 */

const API_BASE = '/api';
const token = localStorage.getItem('fb_token');
const currentUser = (() => {
  try { return JSON.parse(localStorage.getItem('fb_user') || 'null'); }
  catch { return null; }
})();

if (!token || !currentUser || currentUser.role !== 'admin') {
  window.location.replace('/admin/index.html');
}

const PAGE_META = {
  overview:     ['Overview',                    'Platform administration at a glance'],
  verification: ['Org Verification',            'Review and approve pending registrations'],
  participants: ['All Participants',            'Every organization on the platform'],
  safety:       ['Safety & Trust Review',       'Flagged cases and safety incidents'],
  disputes:     ['Dispute Resolution',          'Complaints, handover failures, and conflicts'],
  records:      ['Compliance Records',           'Audit trail of administrative decisions']
};

const state = {
  currentPage: 'overview',
  overview: null,
  pending: [],
  participants: [],
  flags: [],
  disputes: [],
  records: [],
  orgIndex: new Map(),
  verification: { q: '', filter: 'all' },
  participantFilters: { q: '', filter: 'all' },
  safetyFilters: { q: '', filter: 'all' },
  disputeFilters: { q: '', filter: 'all' },
  recordFilters: { q: '' },
  pendingAction: null,
  loggingOut: false
};

/* ── Helpers ───────────────────────────────────────────────────────────── */

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPE[ch]);
}

function icon(name, className = '') {
  return `<svg class="icon${className ? ` ${className}` : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value == null ? '' : String(value);
}

function setHTML(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = value;
}

function formatNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? new Intl.NumberFormat().format(num) : '—';
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

function humanize(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.replace(/[_-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function truncate(value, max = 110) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}…` : text;
}

function initialsFrom(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function parseDbTime(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/.test(text)) {
    return new Date(`${text.replace(' ', 'T')}Z`);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function timeAgo(value) {
  const date = parseDbTime(value);
  if (!date) return '—';
  const diff = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diff <= 0) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  if (diff < 10080) return `${Math.floor(diff / 1440)}d ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function absoluteTime(value) {
  const date = parseDbTime(value);
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function formatDate(value) {
  const date = parseDbTime(value);
  if (!date) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatOrgType(type) {
  const map = {
    restaurant: 'Restaurant', hotel: 'Hotel', caterer: 'Caterer', retailer: 'Retailer',
    institution: 'Institution', donor: 'Donor', other_donor: 'Other donor',
    ngo: 'NGO', shelter: 'Shelter', food_bank: 'Food bank',
    community_kitchen: 'Community kitchen', demand_org: 'Demand organization'
  };
  return map[String(type || '').toLowerCase()] || humanize(type) || 'Organization';
}

function formatRole(role) {
  if (role === 'donor') return 'Donor';
  if (role === 'demand_org') return 'Demand organization';
  return humanize(role) || 'Participant';
}

function orgStatus(org) {
  const raw = String(org.status || 'pending');
  if (raw === 'active') return org.verified ? 'verified' : 'pending';
  if (raw === 'approved') return 'verified';
  return raw;
}

function orgTone(status) {
  if (status === 'verified') return 'verified';
  if (status === 'pending') return 'pending';
  if (status === 'restricted') return 'restricted';
  if (status === 'suspended' || status === 'rejected') return 'suspended';
  return 'gray';
}

function orgAvatarTone(status) {
  if (status === 'pending') return 'amber';
  if (status === 'suspended' || status === 'rejected') return 'red';
  if (status === 'restricted') return 'purple';
  return '';
}

function recordTone(type) {
  const key = String(type || '').toLowerCase();
  if (['approved', 'reinstated', 'resolved'].includes(key)) return 'verified';
  if (['rejected', 'suspended', 'removed', 'flagged'].includes(key)) return 'high';
  if (key === 'restricted') return 'restricted';
  if (key === 'request_info') return 'new';
  return 'info';
}

function badge(text, tone = 'gray') {
  return `<span class="status-badge sb-${esc(tone)}">${esc(text)}</span>`;
}

function compactAvatar(name, tone = '') {
  return `<span class="compact-avatar${tone ? ` ${tone}` : ''}">${esc(initialsFrom(name))}</span>`;
}

function entityAvatar(name, tone = '') {
  return `<span class="entity-avatar${tone ? ` ${tone}` : ''}">${esc(initialsFrom(name))}</span>`;
}

function tableLoading(label = 'Loading…') {
  return `<div class="table-loading"><span class="spinner" aria-hidden="true"></span>${esc(label)}</div>`;
}

function tableEmpty(iconName, title, message) {
  return `<div class="table-empty">${icon(iconName)}<strong>${esc(title)}</strong><span>${esc(message)}</span></div>`;
}

function compactEmpty(iconName, title, message) {
  return `<div class="compact-empty">${icon(iconName)}<strong>${esc(title)}</strong><span>${esc(message)}</span></div>`;
}

function compactLoading(label = 'Loading…') {
  return `<div class="compact-empty"><span class="spinner" aria-hidden="true"></span>${esc(label)}</div>`;
}

function renderSummaryChips(containerId, chips) {
  setHTML(containerId, chips.map(chip => `
    <div class="summary-chip${chip.tone ? ` ${esc(chip.tone)}` : ''}">
      <strong>${esc(chip.value)}</strong><span>${esc(chip.label)}</span>
    </div>`).join(''));
}

function updateFilterChips(prefix, values, active) {
  values.forEach(value => {
    const el = document.getElementById(`${prefix}-${value}`);
    if (!el) return;
    const on = value === active;
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', String(on));
  });
}

function markUpdated(id) {
  const el = document.getElementById(`${id}-updated`);
  if (!el) return;
  el.textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function setLive(ok) {
  const indicator = document.getElementById('live-indicator');
  const label = document.getElementById('live-text');
  if (!indicator || !label) return;
  indicator.classList.toggle('stale', !ok);
  label.textContent = ok ? 'Live data' : 'API unavailable';
}

function emptyText(value, fallback = 'Not provided') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

/* ── Toasts ───────────────────────────────────────────────────────────── */

function toast(message, type = 'info') {
  const host = document.getElementById('toast-container');
  if (!host) return;
  const iconName = type === 'success' ? 'check' : type === 'error' ? 'x' : type === 'warn' ? 'alert' : 'activity';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>`;
  el.addEventListener('click', () => el.remove());
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 5600);
}

function reportError(error, context) {
  console.error(`[FoodBridge Admin] ${context}`, error);
}

/* ── API ──────────────────────────────────────────────────────────────── */

async function apiFetch(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, options);
  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (res.status === 401 || res.status === 403) {
    logout();
    throw new Error('Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    throw new Error((data && (data.error || data.message)) || `Request failed (${res.status}).`);
  }
  return data || {};
}

/* ── Normalization ────────────────────────────────────────────────────── */

function normalizeOrg(org) {
  const type = org.type || '';
  const role = org.role || (['restaurant', 'hotel', 'caterer', 'retailer', 'institution', 'donor', 'other_donor'].includes(type) ? 'donor' : 'demand_org');
  return {
    id: org.id,
    name: org.name || org.orgName || 'Organization',
    role,
    type,
    _kind: org._kind || 'org',
    locationAddress: org.locationAddress || '',
    locationLat: org.locationLat || 0,
    locationLng: org.locationLng || 0,
    email: org.email || org.contactEmail || '',
    contactPhone: org.contactPhone || '',
    operatingHours: org.operatingHours || '',
    servingCapacity: org.servingCapacity,
    acceptedWasteTypes: org.acceptedWasteTypes || [],
    maxDailyIntakeKg: org.maxDailyIntakeKg || 0,
    operatorUserId: org.operatorUserId || null,
    operatorName: org.operatorName || '',
    status: orgStatus(org),
    verified: !!org.verified,
    documentUrl: org.documentUrl || '',
    documentName: org.documentName || '',
    infoRequestNotes: org.infoRequestNotes || '',
    infoRequestAt: org.infoRequestAt || '',
    infoResponseNotes: org.infoResponseNotes || '',
    infoResponseDocumentName: org.infoResponseDocumentName || '',
    infoResponseDocumentUrl: org.infoResponseDocumentUrl || '',
    infoResponseAt: org.infoResponseAt || '',
    createdAt: org.createdAt || null
  };
}

function cacheOrg(org) {
  if (org && org.id) state.orgIndex.set(String(org.id), org);
}

/* ── Navigation ───────────────────────────────────────────────────────── */

function showPage(page) {
  if (!PAGE_META[page]) return;
  state.currentPage = page;

  document.querySelectorAll('.page-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page], .nav-item[id^="nav-"]').forEach(el => {
    el.classList.remove('active');
    el.removeAttribute('aria-current');
  });

  const section = document.getElementById(`page-${page}`);
  const nav = document.getElementById(`nav-${page}`);
  if (section) section.classList.add('active');
  if (nav) {
    nav.classList.add('active');
    nav.setAttribute('aria-current', 'page');
  }

  const [title, sub] = PAGE_META[page];
  setText('topbar-title', title);
  setText('topbar-sub', sub);
  document.title = `FoodBridge — ${title}`;

  closeSidebar();
  loadPageData(page);
}

async function loadPageData(page = state.currentPage) {
  try {
    switch (page) {
      case 'overview':      await loadOverview();      break;
      case 'verification':  await loadVerification();  break;
      case 'participants':  await loadParticipants();  break;
      case 'safety':        await loadSafety();        break;
      case 'disputes':      await loadDisputes();      break;
      case 'records':       await loadRecords();       break;
    }
    setLive(true);
  } catch (error) {
    setLive(false);
    reportError(error, `loadPageData:${page}`);
  }
}

async function refreshPage(button) {
  const label = button ? button.innerHTML : '';
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span> Refreshing…`;
  }
  try {
    await loadPageData(state.currentPage);
    if (state.currentPage !== 'overview') await refreshBadges();
    toast('Data refreshed from the live API.', 'success');
  } catch (error) {
    reportError(error, 'refreshPage');
    toast(error.message || 'Refresh failed.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const toggle = document.getElementById('nav-toggle');
  sidebar?.classList.remove('open');
  document.body.classList.remove('nav-open');
  backdrop?.classList.remove('show');
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open navigation menu');
  }
}

function logout() {
  if (state.loggingOut) return;
  state.loggingOut = true;
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.replace('/admin/index.html');
}

/* ── Overview ─────────────────────────────────────────────────────────── */

async function loadOverview() {
  setHTML('ov-pending-list', compactLoading('Loading pending reviews…'));
  setHTML('ov-flag-list', compactLoading('Loading recent flags…'));
  setHTML('ov-records', compactLoading('Loading administrative activity…'));

  try {
    const data = await apiFetch('/admin/overview');
    state.overview = data;
    applyOverviewCounts(data);

    setText('ov-pending', formatNumber(data.pendingCount));
    setText('ov-verified', formatNumber(data.verifiedCount));
    setText('ov-flagged', formatNumber(data.flaggedCount));
    setText('ov-disputes', formatNumber(data.disputeCount));
    setText('ov-suspended', formatNumber(data.suspendedCount));
    setText('ov-actions', formatNumber(data.actionsToday));

    data.recentPending = (data.recentPending || []).map(normalizeOrg);
    data.recentPending.forEach(cacheOrg);
    renderOverviewPending(data.recentPending);
    renderOverviewFlags(data.recentFlags || []);
    renderOverviewRecords(data.recentActions || []);
    markUpdated('overview');
    setLive(true);
  } catch (error) {
    reportError(error, 'loadOverview');
    setLive(false);
    ['ov-pending', 'ov-verified', 'ov-flagged', 'ov-disputes', 'ov-suspended', 'ov-actions']
      .forEach(id => setText(id, '—'));
    const message = error.message || 'The admin overview could not be loaded.';
    setHTML('ov-pending-list', compactEmpty('alert', 'Overview unavailable', message));
    setHTML('ov-flag-list', compactEmpty('alert', 'Overview unavailable', message));
    setHTML('ov-records', compactEmpty('alert', 'Overview unavailable', message));
  }
}

function applyOverviewCounts(data) {
  updateBadge('badge-pending', Number(data.pendingCount));
  updateBadge('badge-flags', Number(data.flaggedCount));
  updateBadge('badge-disputes', Number(data.disputeCount));
}

function updateBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (Number.isFinite(count) && count > 0) {
    el.textContent = String(count);
    el.hidden = false;
  } else {
    el.hidden = true;
    el.textContent = '0';
  }
}

async function refreshBadges() {
  try {
    const data = await apiFetch('/admin/overview');
    state.overview = data;
    applyOverviewCounts(data);
  } catch (error) {
    reportError(error, 'refreshBadges');
  }
}

function renderOverviewPending(items) {
  const host = document.getElementById('ov-pending-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = compactEmpty('check', 'No pending reviews', 'Every submitted organization has been reviewed.');
    return;
  }
  host.innerHTML = items.map(org => `
    <div class="compact-row">
      ${compactAvatar(org.name, 'amber')}
      <div class="compact-body">
        <div class="compact-title">${esc(org.name)}</div>
        <div class="compact-meta">
          <span>${esc(formatRole(org.role))}</span><span class="dot"></span>
          <span>${esc(org.locationAddress || org.email || 'Details not provided')}</span>
        </div>
      </div>
      <div class="compact-right">
        <span class="compact-time">${esc(timeAgo(org.createdAt))}</span>
        <button class="compact-action" type="button" data-action="goto" data-page="verification">
          Review ${icon('chevron-right')}
        </button>
      </div>
    </div>`).join('');
}

function renderOverviewFlags(items) {
  const host = document.getElementById('ov-flag-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = compactEmpty('shield', 'No recent flags', 'No safety reports have been filed.');
    return;
  }
  host.innerHTML = items.map(flag => {
    const severity = ['high', 'medium', 'low'].includes(String(flag.severity)) ? flag.severity : 'medium';
    return `
      <div class="compact-row">
        ${compactAvatar(flag.org || 'Participant', severity === 'high' ? 'red' : 'amber')}
        <div class="compact-body">
          <div class="compact-title">${esc(flag.title || 'Safety report')}</div>
          <div class="compact-meta">
            <span>${esc(flag.org || 'Participant')}</span><span class="dot"></span>
            <span>${esc(timeAgo(flag.createdAt))}</span>
          </div>
        </div>
        <div class="compact-right">
          ${badge(flag.resolved ? 'Closed' : humanize(severity), flag.resolved ? 'resolved' : severity)}
        </div>
      </div>`;
  }).join('');
}

function renderOverviewRecords(items) {
  const host = document.getElementById('ov-records');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = compactEmpty('file', 'No records yet', 'Administrative decisions will be recorded here.');
    return;
  }
  host.innerHTML = items.map(record => `
    <div class="compact-row">
      ${compactAvatar(record.admin || 'Admin', 'purple')}
      <div class="compact-body">
        <div class="compact-title">${esc(record.title || humanize(record.type))}</div>
        <div class="compact-meta">
          <span>${esc(record.admin || 'Platform Administrator')}</span><span class="dot"></span>
          <span>${esc(timeAgo(record.createdAt))}</span>
        </div>
      </div>
      <div class="compact-right">
        ${badge(humanize(record.type), recordTone(record.type))}
      </div>
    </div>`).join('');
}

/* ── Organization verification ────────────────────────────────────────── */

async function loadVerification() {
  setHTML('verification-list', tableLoading('Loading pending registrations…'));
  // Load the setting independently so a failed verification queue does not
  // prevent an admin from seeing or changing automatic approval.
  loadAutomaticApprovalSetting();
  try {
    const data = await apiFetch('/admin/pending');
    state.pending = (data.orgs || []).map(normalizeOrg);
    state.pending.forEach(cacheOrg);
    renderVerification();
    setLive(true);
  } catch (error) {
    reportError(error, 'loadVerification');
    setLive(false);
    state.pending = [];
    setText('verification-count', '—');
    setHTML('verification-list', tableEmpty('alert', 'Verification queue unavailable', error.message || 'The pending registrations could not be loaded.'));
  }
}

async function loadAutomaticApprovalSetting() {
  const toggle = document.getElementById('auto-approval-toggle');
  if (!toggle) return;
  toggle.disabled = true;
  setText('auto-approval-status', 'Loading setting…');
  try {
    const data = await apiFetch('/admin/settings/auto-approval');
    toggle.checked = data.enabled === true;
    toggle.disabled = false;
    setText('auto-approval-status', toggle.checked
      ? 'On — future partner registrations will be activated automatically.'
      : 'Off — new registrations stay in the manual review queue.');
  } catch (error) {
    reportError(error, 'loadAutomaticApprovalSetting');
    toggle.checked = false;
    setText('auto-approval-status', 'Setting unavailable; automatic approval cannot be changed.');
  }
}

async function saveAutomaticApprovalSetting(event) {
  const toggle = event.currentTarget;
  const requestedValue = toggle.checked;
  if (requestedValue && !window.confirm(
    'Enable automatic approval? Future donor, NGO, food-bank, and biogas registrations will be activated without manual review. Existing pending registrations will not change.'
  )) {
    toggle.checked = false;
    return;
  }

  toggle.disabled = true;
  setText('auto-approval-status', 'Saving setting…');
  try {
    const data = await apiFetch('/admin/settings/auto-approval', 'PUT', { enabled: requestedValue });
    toggle.checked = data.enabled === true;
    setText('auto-approval-status', toggle.checked
      ? 'On — future partner registrations will be activated automatically.'
      : 'Off — new registrations stay in the manual review queue.');
    toast(toggle.checked
      ? 'Automatic approval enabled for future partner registrations.'
      : 'Automatic approval disabled. New registrations will need review.', 'success');
  } catch (error) {
    toggle.checked = !requestedValue;
    setText('auto-approval-status', toggle.checked
      ? 'On — future partner registrations will be activated automatically.'
      : 'Off — new registrations stay in the manual review queue.');
    toast(error.message || 'Could not save the automatic approval setting.', 'error');
  } finally {
    toggle.disabled = false;
  }
}

async function createBengaluruDemoNgos() {
  const button = document.getElementById('ngo-seed-button');
  if (!button) return;
  const confirmed = window.confirm(
    'Create six synthetic NGO accounts across Bengaluru? These demo NGOs will be automatically approved, receive clearly marked generic demo PDFs, and have no posts. Credentials will be shown once.'
  );
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = 'Creating accounts…';
  try {
    const data = await apiFetch('/admin/demo/seed-bengaluru-ngos', 'POST', {});
    const credentials = (data.created || []).map(account =>
      `${account.type} | ${account.name} | ${account.area}\nEmail: ${account.email}\nPassword: ${account.password}\nStatus: ${account.status}`
    ).join('\n\n');
    setText('ngo-seed-credentials', credentials);
    const result = document.getElementById('ngo-seed-result');
    if (result) result.hidden = false;
    button.textContent = 'NGO accounts created';
    toast('Six Bengaluru NGO demo accounts created and automatically approved. Save the credentials now.', 'success');
    await Promise.all([loadVerification(), loadParticipants()]);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Create 6 NGO accounts';
    toast(error.message || 'Could not create the demo accounts.', 'error');
  }
}

function verificationFiltered() {
  const query = state.verification.q.toLowerCase();
  return state.pending.filter(org => {
    if (state.verification.filter === 'donor' && org.role !== 'donor') return false;
    if (state.verification.filter === 'demand_org' && org.role !== 'demand_org') return false;
    if (state.verification.filter === 'food_bank' && org.type !== 'food_bank') return false;
    if (state.verification.filter === 'biogas_operator' && org.role !== 'biogas_operator') return false;
    if (state.verification.filter === 'nodoc' && (org.documentUrl || org.role === 'biogas_operator')) return false;
    if (!query) return true;
    return [org.name, org.email, org.locationAddress, org.type, org.role, org.documentName, org.operatorName]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderVerification() {
  const all = state.pending;
  const donors   = all.filter(org => org.role === 'donor').length;
  const foodBanks = all.filter(org => org.type === 'food_bank').length;
  const biogas   = all.filter(org => org.role === 'biogas_operator').length;
  const missingDocs = all.filter(org => org.role !== 'biogas_operator' && !org.documentUrl).length;

  setText('verification-count', formatNumber(all.length));
  renderSummaryChips('verification-summary', [
    { value: all.length,    label: 'awaiting review',    tone: 'amber' },
    { value: donors,        label: 'donors',             tone: 'green' },
    { value: foodBanks,     label: 'food banks',         tone: 'blue' },
    { value: biogas,        label: 'biogas operators',   tone: 'violet' },
    { value: missingDocs,   label: 'missing documents',  tone: missingDocs ? 'red' : 'green' }
  ]);

  const host = document.getElementById('verification-list');
  if (!host) return;

  if (!all.length) {
    host.innerHTML = tableEmpty('check', 'No pending verifications', 'Every submitted registration has been reviewed.');
    return;
  }

  const items = verificationFiltered();
  if (!items.length) {
    host.innerHTML = tableEmpty('search', 'No matching registrations', 'Adjust the search or filter to see pending registrations.');
    return;
  }

  host.innerHTML = `<table>
    <caption class="sr-only">Registrations awaiting verification</caption>
    <thead><tr>
      <th scope="col">Name</th><th scope="col">Contact</th><th scope="col">Location</th>
      <th scope="col">Submitted</th><th scope="col">Document</th><th scope="col">Information exchange</th><th scope="col">Actions</th>
    </tr></thead>
    <tbody>${items.map(org => {
      const isBiogas = org.role === 'biogas_operator';
      const approveAction  = isBiogas ? 'biogas-approve'  : 'org-approve';
      const requestAction  = isBiogas ? 'biogas-request'  : 'org-request';
      const rejectAction   = isBiogas ? 'biogas-reject'   : 'org-reject';
      const subtitleLine   = isBiogas
        ? `Biogas Operator${org.operatorName ? ` · ${esc(org.operatorName)}` : ''}`
        : `${esc(formatRole(org.role))} · ${esc(formatOrgType(org.type))}`;
      const contactDetail  = isBiogas && org.maxDailyIntakeKg
        ? `<br><span class="cell-muted">${esc(org.maxDailyIntakeKg)} kg/day capacity</span>`
        : (org.servingCapacity ? `<br><span class="cell-muted">${esc(org.servingCapacity)} meals/day</span>` : '');
      const docCell = isBiogas
        ? badge('N/A', 'gray')
        : (org.documentUrl
            ? `<a class="action-btn btn-view" href="${esc(org.documentUrl)}" target="_blank" rel="noopener">${icon('file')} View</a>`
            : badge('Missing', 'high'));
      const infoExchange = org.infoResponseAt
        ? `<strong class="cell-strong">Partner responded</strong><br><span class="cell-muted">${esc(truncate(org.infoResponseNotes || 'Supporting information sent', 90))}</span>${org.infoResponseDocumentUrl ? `<br><a class="action-btn btn-view" href="${esc(org.infoResponseDocumentUrl)}" target="_blank" rel="noopener">${icon('file')} View response</a>` : ''}`
        : (org.infoRequestNotes
            ? `<strong class="cell-muted">Awaiting partner response</strong><br><span class="cell-muted">${esc(truncate(org.infoRequestNotes, 90))}</span>`
            : '<span class="cell-muted">—</span>');
      return `<tr>
        <td><div class="cell-title">${entityAvatar(org.name, isBiogas ? 'violet' : 'amber')}<div class="cell-title-copy">
          <strong>${esc(org.name)}</strong><small>${subtitleLine}</small>
        </div></div></td>
        <td><span class="cell-strong">${esc(emptyText(org.email))}</span>${contactDetail}</td>
        <td><span class="cell-wrap">${esc(emptyText(org.locationAddress))}</span></td>
        <td><span class="cell-muted" title="${esc(absoluteTime(org.createdAt))}">${esc(timeAgo(org.createdAt))}</span></td>
        <td>${docCell}</td>
        <td><div class="cell-wrap">${infoExchange}</div></td>
        <td><div class="row-actions">
          <button class="action-btn btn-approve" type="button" data-action="${approveAction}" data-id="${esc(org.id)}">Approve</button>
          <button class="action-btn btn-request" type="button" data-action="${requestAction}" data-id="${esc(org.id)}">More info</button>
          <button class="action-btn btn-reject"  type="button" data-action="${rejectAction}"  data-id="${esc(org.id)}">Reject</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function vFilter(value) {
  state.verification.filter = value;
  updateFilterChips('vf', ['all', 'donor', 'demand_org', 'food_bank', 'biogas_operator', 'nodoc'], value);
  renderVerification();
}

function searchVerification() {
  state.verification.q = document.getElementById('verification-search')?.value.trim() || '';
  renderVerification();
}

function resetVerificationFilters() {
  state.verification = { q: '', filter: 'all' };
  const input = document.getElementById('verification-search');
  if (input) input.value = '';
  updateFilterChips('vf', ['all', 'donor', 'demand_org', 'food_bank', 'biogas_operator', 'nodoc'], 'all');
  renderVerification();
}

/* ── Participants ─────────────────────────────────────────────────────── */

async function loadParticipants() {
  setHTML('participants-list', tableLoading('Loading participants…'));
  try {
    const data = await apiFetch('/admin/participants');
    state.participants = (data.orgs || []).map(normalizeOrg);
    state.participants.forEach(cacheOrg);
    renderParticipants();
    setLive(true);
  } catch (error) {
    reportError(error, 'loadParticipants');
    setLive(false);
    state.participants = [];
    setText('participants-count', '—');
    setHTML('participants-list', tableEmpty('alert', 'Participants unavailable', error.message || 'Registered organizations could not be loaded.'));
  }
}

function participantFiltered() {
  const query = state.participantFilters.q.toLowerCase();
  return state.participants.filter(org => {
    const filter = state.participantFilters.filter;
    if (filter !== 'all' && org.status !== filter) return false;
    if (!query) return true;
    return [org.name, org.email, org.locationAddress, org.type, org.role]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderParticipants() {
  const all = state.participants;
  const items = participantFiltered();
  setText('participants-count', formatNumber(all.length));

  const host = document.getElementById('participants-list');
  if (!host) return;

  if (!all.length) {
    host.innerHTML = tableEmpty('building', 'No partners registered', 'New donors, NGOs, food banks, and biogas centres will appear here.');
    return;
  }
  if (!items.length) {
    host.innerHTML = tableEmpty('search', 'No matching participants', 'Adjust the search or status filter.');
    return;
  }

  host.innerHTML = `<table class="table-wide">
    <caption class="sr-only">Registered platform participants</caption>
    <thead><tr>
      <th scope="col">Organization</th><th scope="col">Status</th><th scope="col">Location</th>
      <th scope="col">Contact</th><th scope="col">Registered</th><th scope="col">Actions</th>
    </tr></thead>
    <tbody>${items.map(org => {
      const isBiogas = org.role === 'biogas_operator';
      const actionPrefix = isBiogas ? 'biogas' : 'org';
      return `<tr>
      <td><div class="cell-title">${entityAvatar(org.name, orgAvatarTone(org.status))}<div class="cell-title-copy">
        <strong>${esc(org.name)}</strong><small>${esc(formatRole(org.role))} · ${esc(formatOrgType(org.type))}</small>
      </div></div></td>
      <td>${badge(humanize(org.status), orgTone(org.status))}</td>
      <td><span class="cell-wrap">${esc(emptyText(org.locationAddress))}</span></td>
      <td><span class="cell-strong">${esc(emptyText(org.email))}</span>${org.contactPhone ? `<br><span class="cell-muted">${esc(org.contactPhone)}</span>` : ''}</td>
      <td><span class="cell-muted" title="${esc(absoluteTime(org.createdAt))}">${esc(timeAgo(org.createdAt))}</span></td>
      <td><div class="row-actions">
        ${org.status === 'pending' ? `<button class="action-btn btn-view" type="button" data-action="goto" data-page="verification">Review</button>` : ''}
        ${org.status === 'verified' ? `
          <button class="action-btn btn-suspend" type="button" data-action="${actionPrefix}-suspend" data-id="${esc(org.id)}">Suspend</button>
          <button class="action-btn btn-restrict" type="button" data-action="${actionPrefix}-restrict" data-id="${esc(org.id)}">Restrict</button>` : ''}
        ${org.status === 'suspended' || org.status === 'restricted' ? `
          <button class="action-btn btn-reinstate" type="button" data-action="${actionPrefix}-reinstate" data-id="${esc(org.id)}">Reinstate</button>` : ''}
        ${org.status === 'rejected' ? `<span class="cell-muted">Application closed</span>` : ''}
      </div></td>
    </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function pFilter(value) {
  state.participantFilters.filter = value;
  updateFilterChips('pf', ['all', 'verified', 'pending', 'suspended', 'restricted', 'rejected'], value);
  renderParticipants();
}

function searchParticipants() {
  state.participantFilters.q = document.getElementById('participant-search')?.value.trim() || '';
  renderParticipants();
}

function resetParticipantFilters() {
  state.participantFilters = { q: '', filter: 'all' };
  const input = document.getElementById('participant-search');
  if (input) input.value = '';
  updateFilterChips('pf', ['all', 'verified', 'pending', 'suspended', 'restricted', 'rejected'], 'all');
  renderParticipants();
}

async function viewOrg(orgId) {
  if (!orgId) return;
  let org = state.orgIndex.get(String(orgId));
  if (!state.participants.length) {
    try {
      const data = await apiFetch('/admin/participants');
      state.participants = (data.orgs || []).map(normalizeOrg);
      state.participants.forEach(cacheOrg);
      org = org || state.orgIndex.get(String(orgId));
    } catch (error) {
      reportError(error, 'viewOrg');
    }
  }
  showPage('participants');
  pFilter('all');
  if (org) {
    const input = document.getElementById('participant-search');
    if (input) input.value = org.name;
    state.participantFilters.q = org.name;
    renderParticipants();
  }
}

/* ── Safety review ────────────────────────────────────────────────────── */

async function loadSafety() {
  setHTML('safety-list', tableLoading('Loading safety reports…'));
  try {
    const data = await apiFetch('/admin/flags');
    state.flags = data.flags || [];
    renderSafety();
    markUpdated('safety');
    setLive(true);
  } catch (error) {
    reportError(error, 'loadSafety');
    setLive(false);
    state.flags = [];
    setHTML('safety-list', tableEmpty('alert', 'Safety reports unavailable', error.message || 'Open reports could not be loaded.'));
  }
}

function safetyFiltered() {
  const query = state.safetyFilters.q.toLowerCase();
  return state.flags.filter(flag => {
    const filter = state.safetyFilters.filter;
    if (filter === 'high' && flag.severity !== 'high') return false;
    if (filter === 'medium' && flag.severity !== 'medium') return false;
    if (filter === 'open' && flag.resolved) return false;
    if (filter === 'closed' && !flag.resolved) return false;
    if (!query) return true;
    return [flag.title, flag.detail, flag.org, flag.severity]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderSafety() {
  const all = state.flags;
  const open = all.filter(flag => !flag.resolved).length;
  const high = all.filter(flag => flag.severity === 'high' && !flag.resolved).length;

  renderSummaryChips('safety-summary', [
    { value: all.length, label: 'total reports', tone: 'blue' },
    { value: high, label: 'high priority open', tone: high ? 'red' : 'green' },
    { value: open, label: 'open cases', tone: open ? 'amber' : 'green' },
    { value: all.length - open, label: 'closed cases', tone: 'green' }
  ]);

  const host = document.getElementById('safety-list');
  if (!host) return;
  if (!all.length) {
    host.innerHTML = tableEmpty('shield', 'No safety reports', 'Flagged cases from participants will appear here.');
    return;
  }
  const items = safetyFiltered();
  if (!items.length) {
    host.innerHTML = tableEmpty('search', 'No matching reports', 'Adjust the search or filter to see safety reports.');
    return;
  }

  host.innerHTML = `<table class="table-wide">
    <caption class="sr-only">Safety and trust reports</caption>
    <thead><tr>
      <th scope="col">Case</th><th scope="col">Organization</th><th scope="col">Severity</th>
      <th scope="col">Status</th><th scope="col">Reported</th><th scope="col">Actions</th>
    </tr></thead>
    <tbody>${items.map(flag => `<tr>
      <td><div class="cell-title">${entityAvatar(flag.org || 'Case', flag.severity === 'high' ? 'red' : 'amber')}<div class="cell-title-copy">
        <strong>${esc(flag.title || 'Safety report')}</strong><small title="${esc(flag.detail || '')}">${esc(truncate(flag.detail || 'No description provided.', 72))}</small>
      </div></div></td>
      <td><span class="cell-strong">${esc(flag.org || 'Participant')}</span></td>
      <td>${badge(humanize(flag.severity || 'medium'), flag.severity === 'high' ? 'high' : 'medium')}</td>
      <td>${badge(flag.resolved ? 'Closed' : 'Open', flag.resolved ? 'resolved' : 'open')}</td>
      <td><span class="cell-muted" title="${esc(absoluteTime(flag.createdAt))}">${esc(timeAgo(flag.createdAt))}</span></td>
      <td><div class="row-actions">
        ${flag.orgId ? `<button class="action-btn btn-view" type="button" data-action="view-org" data-id="${esc(flag.orgId)}">View org</button>` : ''}
        ${!flag.resolved ? `<button class="action-btn btn-resolve" type="button" data-action="close-flag" data-id="${esc(flag.id)}">Close</button>` : ''}
        ${!flag.resolved && flag.orgId ? `<button class="action-btn btn-suspend" type="button" data-action="org-suspend" data-id="${esc(flag.orgId)}">Suspend</button>` : ''}
      </div></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function sFilter(value) {
  state.safetyFilters.filter = value;
  updateFilterChips('sf', ['all', 'high', 'medium', 'open', 'closed'], value);
  renderSafety();
}

function searchSafety() {
  state.safetyFilters.q = document.getElementById('safety-search')?.value.trim() || '';
  renderSafety();
}

function resetSafetyFilters() {
  state.safetyFilters = { q: '', filter: 'all' };
  const input = document.getElementById('safety-search');
  if (input) input.value = '';
  updateFilterChips('sf', ['all', 'high', 'medium', 'open', 'closed'], 'all');
  renderSafety();
}

/* ── Disputes ─────────────────────────────────────────────────────────── */

async function loadDisputes() {
  setHTML('disputes-list', tableLoading('Loading disputes…'));
  try {
    const data = await apiFetch('/admin/disputes');
    state.disputes = data.disputes || [];
    renderDisputes();
    setLive(true);
  } catch (error) {
    reportError(error, 'loadDisputes');
    setLive(false);
    state.disputes = [];
    setText('disputes-count', '—');
    setHTML('disputes-list', tableEmpty('alert', 'Disputes unavailable', error.message || 'Disputes could not be loaded.'));
  }
}

function disputeFiltered() {
  const query = state.disputeFilters.q.toLowerCase();
  return state.disputes.filter(dispute => {
    const filter = state.disputeFilters.filter;
    if (filter !== 'all' && dispute.status !== filter) return false;
    if (!query) return true;
    return [dispute.type, dispute.party1, dispute.party2, dispute.description, dispute.status]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderDisputes() {
  const all = state.disputes;
  const open = all.filter(dispute => dispute.status !== 'resolved').length;
  setText('disputes-count', formatNumber(open));

  const host = document.getElementById('disputes-list');
  if (!host) return;
  if (!all.length) {
    host.innerHTML = tableEmpty('scale', 'No disputes recorded', 'Participant disputes will appear here when they are reported.');
    return;
  }
  const items = disputeFiltered();
  if (!items.length) {
    host.innerHTML = tableEmpty('search', 'No matching disputes', 'Adjust the search or filter to see disputes.');
    return;
  }

  host.innerHTML = `<table class="table-wide">
    <caption class="sr-only">Participant disputes</caption>
    <thead><tr>
      <th scope="col">Case</th><th scope="col">Parties</th><th scope="col">Description</th>
      <th scope="col">Status</th><th scope="col">Reported</th><th scope="col">Actions</th>
    </tr></thead>
    <tbody>${items.map(dispute => `<tr>
      <td><div class="cell-title">${entityAvatar(dispute.type || 'Dispute', 'purple')}<div class="cell-title-copy">
        <strong>${esc(humanize(dispute.type || 'Dispute'))}</strong><small>${esc(String(dispute.id || '').slice(0, 8))}</small>
      </div></div></td>
      <td><div class="cell-title-copy"><strong>${esc(dispute.party1 || 'Reporter')}</strong><small>vs ${esc(dispute.party2 || 'Respondent')}</small></div></td>
      <td><span class="cell-wrap" title="${esc(dispute.description || '')}">${esc(truncate(dispute.description || 'No description provided.', 96))}</span></td>
      <td>${badge(dispute.status === 'resolved' ? 'Resolved' : 'Open', dispute.status === 'resolved' ? 'resolved' : 'open')}</td>
      <td><span class="cell-muted" title="${esc(absoluteTime(dispute.createdAt))}">${esc(timeAgo(dispute.createdAt))}</span></td>
      <td><div class="row-actions">
        ${dispute.status !== 'resolved' ? `<button class="action-btn btn-resolve" type="button" data-action="resolve-dispute" data-id="${esc(dispute.id)}">Resolve</button>` : ''}
      </div></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function dFilter(value) {
  state.disputeFilters.filter = value;
  updateFilterChips('df', ['all', 'open', 'resolved'], value);
  renderDisputes();
}

function searchDisputes() {
  state.disputeFilters.q = document.getElementById('dispute-search')?.value.trim() || '';
  renderDisputes();
}

function resetDisputeFilters() {
  state.disputeFilters = { q: '', filter: 'all' };
  const input = document.getElementById('dispute-search');
  if (input) input.value = '';
  updateFilterChips('df', ['all', 'open', 'resolved'], 'all');
  renderDisputes();
}

/* ── Compliance records ───────────────────────────────────────────────── */

async function loadRecords() {
  setHTML('records-list', tableLoading('Loading compliance records…'));
  try {
    const data = await apiFetch('/admin/records');
    state.records = data.records || [];
    renderRecords();
    setLive(true);
  } catch (error) {
    reportError(error, 'loadRecords');
    setLive(false);
    state.records = [];
    setText('records-count', '—');
    setHTML('records-list', tableEmpty('alert', 'Compliance records unavailable', error.message || 'The audit trail could not be loaded.'));
  }
}

function recordFiltered() {
  const query = state.recordFilters.q.toLowerCase();
  if (!query) return state.records;
  return state.records.filter(record => [record.title, record.detail, record.admin, record.type]
    .some(value => String(value || '').toLowerCase().includes(query)));
}

function renderRecords() {
  const items = recordFiltered();
  setText('records-count', formatNumber(state.records.length));

  const host = document.getElementById('records-list');
  if (!host) return;
  if (!state.records.length) {
    host.innerHTML = tableEmpty('file', 'No compliance records', 'Administrative decisions will be recorded here.');
    return;
  }
  if (!items.length) {
    host.innerHTML = tableEmpty('search', 'No matching records', 'Adjust the search to see compliance records.');
    return;
  }

  host.innerHTML = `<table class="table-wide">
    <caption class="sr-only">Administrative compliance records</caption>
    <thead><tr>
      <th scope="col">Recorded</th><th scope="col">Action</th><th scope="col">Record</th>
      <th scope="col">Notes</th><th scope="col">Document</th><th scope="col">Recorded by</th>
    </tr></thead>
    <tbody>${items.map(record => `<tr>
      <td><span class="cell-strong">${esc(formatDate(record.createdAt))}</span><br><span class="cell-muted" title="${esc(absoluteTime(record.createdAt))}">${esc(timeAgo(record.createdAt))}</span></td>
      <td>${badge(humanize(record.type), recordTone(record.type))}</td>
      <td><span class="cell-wrap">${esc(record.title || 'Administrative record')}</span></td>
      <td><span class="cell-wrap" title="${esc(record.detail || '')}">${esc(truncate(record.detail || '—', 110))}</span></td>
      <td>${record.documentUrl
        ? `<a class="action-btn btn-view" href="${esc(record.documentUrl)}" target="_blank" rel="noopener">${icon('file')} ${esc(record.documentName || 'View licence')}</a>`
        : '<span class="cell-muted">—</span>'}</td>
      <td><span class="cell-strong">${esc(record.admin || 'Platform Administrator')}</span></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function searchRecords() {
  state.recordFilters.q = document.getElementById('records-search')?.value.trim() || '';
  renderRecords();
}

/* ── Confirmation modal & actions ─────────────────────────────────────── */

const ORG_ACTIONS = {
  approve: {
    title: 'Approve organization',
    kicker: 'Verification decision',
    style: 'success',
    endpoint: 'approve',
    message: 'Organization approved and activated.',
    requireNotes: false
  },
  reject: {
    title: 'Reject application',
    kicker: 'Verification decision',
    style: 'danger',
    endpoint: 'reject',
    message: 'Application rejected.',
    requireNotes: true
  },
  request: {
    title: 'Request more information',
    kicker: 'Verification decision',
    style: 'violet',
    endpoint: 'request-info',
    message: 'Information request sent to the organization.',
    requireNotes: true
  },
  suspend: {
    title: 'Suspend organization',
    kicker: 'Trust & safety',
    style: 'danger',
    endpoint: 'suspend',
    message: 'Organization suspended.',
    requireNotes: true
  },
  reinstate: {
    title: 'Reinstate organization',
    kicker: 'Trust & safety',
    style: 'success',
    endpoint: 'reinstate',
    message: 'Organization reinstated.',
    requireNotes: false
  },
  restrict: {
    title: 'Restrict organization',
    kicker: 'Trust & safety',
    style: 'violet',
    endpoint: 'restrict',
    message: 'Restrictions applied to the organization.',
    requireNotes: true
  }
};

const BIOGAS_ACTIONS = {
  approve: {
    title: 'Approve biogas operator',
    kicker: 'Verification decision',
    style: 'success',
    endpoint: 'approve',
    message: 'Biogas operator approved and facility activated.',
    requireNotes: false
  },
  reject: {
    title: 'Reject biogas application',
    kicker: 'Verification decision',
    style: 'danger',
    endpoint: 'reject',
    message: 'Biogas operator application rejected.',
    requireNotes: true
  },
  request: {
    title: 'Request more information',
    kicker: 'Verification decision',
    style: 'violet',
    endpoint: 'request-info',
    message: 'Information request logged for this biogas operator.',
    requireNotes: true
  },
  suspend: {
    title: 'Suspend biogas partner', kicker: 'Partner status', style: 'danger', endpoint: 'suspend',
    message: 'Biogas partner suspended.', requireNotes: true
  },
  reinstate: {
    title: 'Reinstate biogas partner', kicker: 'Partner status', style: 'success', endpoint: 'reinstate',
    message: 'Biogas partner reinstated.', requireNotes: false
  },
  restrict: {
    title: 'Restrict biogas partner', kicker: 'Partner status', style: 'violet', endpoint: 'restrict',
    message: 'Restrictions applied to the biogas partner.', requireNotes: true
  }
};

function openOrgModal(action, orgId) {
  const config = ORG_ACTIONS[action];
  if (!config) return;
  const org = state.orgIndex.get(String(orgId));
  const name = org?.name || 'this organization';
  const description = {
    approve: `Approve and activate ${name} on the FoodBridge network?`,
    reject: `Reject the application from ${name}? The decision will be recorded in the compliance log.`,
    request: `What additional information is required from ${name}?`,
    suspend: `Suspend ${name} pending investigation? Their account will remain restricted until reinstated.`,
    reinstate: `Reinstate ${name} to active participation on the network?`,
    restrict: `Apply restrictions to ${name}? Describe the restriction so it can be logged.`
  }[action];

  state.pendingAction = { type: 'org', action, id: String(orgId), config };
  fillModal({
    kicker: config.kicker,
    title: config.title,
    desc: description,
    style: config.style,
    requireNotes: config.requireNotes,
    confirmLabel: config.title
  });
}

function openBiogasModal(action, facilityId) {
  const config = BIOGAS_ACTIONS[action];
  if (!config) return;
  const org = state.orgIndex.get(String(facilityId));
  const name = org?.name || 'this biogas operator';
  const description = {
    approve: `Approve ${name}? The facility will be activated as a routing candidate.`,
    reject: `Reject the application from ${name}? The decision will be recorded in the compliance log.`,
    request: `What additional information is required from ${name}?`,
    suspend: `Suspend ${name} pending investigation? Their facility will be removed from active operations.`,
    reinstate: `Reinstate ${name} to active participation on the network?`,
    restrict: `Apply restrictions to ${name}? Describe the restriction so it can be logged.`
  }[action];

  state.pendingAction = { type: 'biogas', action, id: String(facilityId), config };
  fillModal({
    kicker: config.kicker,
    title: config.title,
    desc: description,
    style: config.style,
    requireNotes: config.requireNotes,
    confirmLabel: config.title
  });
}

function openFlagModal(flagId) {
  const flag = state.flags.find(item => String(item.id) === String(flagId));
  state.pendingAction = { type: 'flag', id: String(flagId), config: { message: 'Safety flag closed.' } };
  fillModal({
    kicker: 'Safety review',
    title: 'Close safety flag',
    desc: `Close “${flag?.title || 'this safety report'}”? The case will be marked as resolved.`,
    style: 'success',
    requireNotes: false,
    confirmLabel: 'Close flag'
  });
}

function openDisputeModal(disputeId) {
  const dispute = state.disputes.find(item => String(item.id) === String(disputeId));
  state.pendingAction = { type: 'dispute', id: String(disputeId), config: { message: 'Dispute marked as resolved.' } };
  fillModal({
    kicker: 'Dispute resolution',
    title: 'Resolve dispute',
    desc: `Resolve the ${humanize(dispute?.type || 'dispute')} between ${dispute?.party1 || 'the reporter'} and ${dispute?.party2 || 'the respondent'}?`,
    style: 'success',
    requireNotes: true,
    confirmLabel: 'Resolve dispute'
  });
}

function fillModal({ kicker, title, desc, style, requireNotes, confirmLabel }) {
  setText('modal-kicker', kicker || 'Confirm action');
  setText('modal-title', title);
  setText('modal-desc', desc);
  const required = document.getElementById('modal-notes-required');
  if (required) required.hidden = !requireNotes;

  const warning = document.getElementById('modal-warning');
  if (warning) {
    warning.hidden = true;
    warning.textContent = '';
  }

  const notes = document.getElementById('modal-notes');
  if (notes) notes.value = '';

  const button = document.getElementById('modal-confirm-btn');
  if (button) {
    button.className = `modal-confirm ${style || 'violet'}`;
    button.textContent = confirmLabel || 'Confirm';
    button.disabled = false;
  }

  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.add('show');
  window.setTimeout(() => (requireNotes ? notes : button)?.focus(), 40);
}

function closeModal() {
  document.getElementById('modal-overlay')?.classList.remove('show');
  state.pendingAction = null;
}

async function executePendingAction() {
  const pending = state.pendingAction;
  if (!pending) return;

  const notes = document.getElementById('modal-notes')?.value.trim() || '';
  const config = pending.config || {};
  if (config.requireNotes && !notes) {
    const warning = document.getElementById('modal-warning');
    if (warning) {
      warning.hidden = false;
      warning.textContent = 'A reason is required before continuing.';
    }
    document.getElementById('modal-notes')?.focus();
    return;
  }

  const button = document.getElementById('modal-confirm-btn');
  if (button) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = 'Working…';
  }

  try {
    if (pending.type === 'org') {
      await apiFetch(`/admin/orgs/${encodeURIComponent(pending.id)}/${config.endpoint}`, 'PUT', {
        notes,
        reason: notes
      });
      toast(config.message || 'Organization updated.', 'success');
    } else if (pending.type === 'biogas') {
      await apiFetch(`/admin/biogas/${encodeURIComponent(pending.id)}/${config.endpoint}`, 'PUT', { notes });
      toast(config.message || 'Biogas operator updated.', 'success');
    } else if (pending.type === 'flag') {
      await apiFetch(`/admin/flags/${encodeURIComponent(pending.id)}/close`, 'PUT');
      toast('Safety flag closed.', 'success');
    } else if (pending.type === 'dispute') {
      await apiFetch(`/admin/disputes/${encodeURIComponent(pending.id)}/resolve`, 'PUT', {
        resolutionNotes: notes || 'Marked resolved by platform admin.'
      });
      toast('Dispute marked as resolved.', 'success');
    }

    closeModal();
    await refreshBadges();

    if (state.currentPage === 'overview') {
      await loadOverview();
    } else {
      await loadPageData(state.currentPage);
    }
  } catch (error) {
    reportError(error, 'executePendingAction');
    const warning = document.getElementById('modal-warning');
    if (warning) {
      warning.hidden = false;
      warning.textContent = error.message || 'The action could not be completed.';
    }
    toast(error.message || 'Action failed.', 'error');
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.originalText || 'Confirm';
    }
  }
}

/* ── Wiring ───────────────────────────────────────────────────────────── */

function wireNavigation() {
  document.querySelectorAll('.nav-item[id^="nav-"]').forEach(item => {
    item.addEventListener('click', () => {
      if (item.classList.contains('active')) closeSidebar();
    });
  });

  const toggle = document.getElementById('nav-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      const open = !sidebar?.classList.contains('open');
      sidebar?.classList.toggle('open', open);
      document.body.classList.toggle('nav-open', open);
      backdrop?.classList.toggle('show', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    });
  }

  document.getElementById('sidebar-backdrop')?.addEventListener('click', closeSidebar);

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeModal();
      closeSidebar();
    }
  });
}

function wireDelegatedActions() {
  document.getElementById('auto-approval-toggle')?.addEventListener('change', saveAutomaticApprovalSetting);
  document.getElementById('ngo-seed-button')?.addEventListener('click', createBengaluruDemoNgos);

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (target) {
      const action = target.dataset.action;
      const id = target.dataset.id;
      if (action === 'goto') {
        showPage(target.dataset.page || 'overview');
        return;
      }
      if (action === 'view-org') { viewOrg(id); return; }
      if (action === 'org-approve') { openOrgModal('approve', id); return; }
      if (action === 'org-request') { openOrgModal('request', id); return; }
      if (action === 'org-reject') { openOrgModal('reject', id); return; }
      if (action === 'org-suspend') { openOrgModal('suspend', id); return; }
      if (action === 'org-reinstate') { openOrgModal('reinstate', id); return; }
      if (action === 'org-restrict') { openOrgModal('restrict', id); return; }
      if (action === 'biogas-suspend') { openBiogasModal('suspend', id); return; }
      if (action === 'biogas-reinstate') { openBiogasModal('reinstate', id); return; }
      if (action === 'biogas-restrict') { openBiogasModal('restrict', id); return; }
      if (action === 'biogas-approve') { openBiogasModal('approve', id); return; }
      if (action === 'biogas-request') { openBiogasModal('request', id); return; }
      if (action === 'biogas-reject')  { openBiogasModal('reject', id); return; }
      if (action === 'close-flag') { openFlagModal(id); return; }
      if (action === 'resolve-dispute') { openDisputeModal(id); return; }
    }

    const stat = event.target.closest('.stat-card.clickable');
    if (stat) {
      const page = stat.dataset.page;
      if (page === 'participants' && stat.dataset.filter) {
        pFilter(stat.dataset.filter);
      }
      showPage(page);
    }
  });

  document.getElementById('modal-confirm-btn')?.addEventListener('click', executePendingAction);
  document.getElementById('modal-overlay')?.addEventListener('click', event => {
    if (event.target.id === 'modal-overlay') closeModal();
  });
  document.querySelector('.modal-x')?.addEventListener('click', closeModal);
}

function renderUser() {
  const name = currentUser?.name || currentUser?.email || 'Administrator';
  const email = currentUser?.email || 'Administrator account';
  const initials = initialsFrom(name);

  setText('sidebar-avatar', initials);
  setText('sidebar-name', name);
  setText('sidebar-role', 'Platform Administrator');
  setText('account-avatar', initials);
  setText('account-name', name);
  setText('account-email', email);
}

/* ── Bootstrap ────────────────────────────────────────────────────────── */

function init() {
  renderUser();
  wireNavigation();
  wireDelegatedActions();
  showPage('overview');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose the handlers used by markup and generated rows.
Object.assign(window, {
  showPage,
  refreshPage,
  loadVerification,
  vFilter,
  searchVerification,
  resetVerificationFilters,
  openBiogasModal,
  loadParticipants,
  pFilter,
  searchParticipants,
  resetParticipantFilters,
  loadSafety,
  sFilter,
  searchSafety,
  resetSafetyFilters,
  loadDisputes,
  dFilter,
  searchDisputes,
  resetDisputeFilters,
  loadRecords,
  searchRecords,
  closeModal,
  closeSidebar,
  logout,
  viewOrg
});
