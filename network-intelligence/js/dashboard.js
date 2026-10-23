/**
 * FoodBridge — Network Intelligence dashboard
 *
 * Visual shell and layout are adapted from the reference portal. All data
 * comes from the IBM_FINALS /api/network endpoints; this build exposes no
 * re-match, force-reserve, allocation-run or forecast-accuracy mutations.
 */

const API_BASE = '/api';
const token = localStorage.getItem('fb_token');
const currentUser = safeJson(localStorage.getItem('fb_user'));

const ALLOWED_ROLES = ['network_intelligence', 'network_admin', 'admin'];
if (!token || !currentUser || !ALLOWED_ROLES.includes(currentUser.role)) {
  window.location.replace('/ops/');
}

const PAGES = {
  overview: {
    title: 'Network Overview',
    subtitle: 'Live coordination status',
    section: 'page-overview'
  },
  'supply-demand': {
    title: 'Supply & Demand',
    subtitle: 'Current surplus and demand registrations',
    section: 'page-supply-demand'
  },
  redistributions: {
    title: 'Redistributions',
    subtitle: 'Match tracking across the network',
    section: 'page-redistributions'
  },
  rebalancing: {
    title: 'Network Rebalancing',
    subtitle: 'Area balance and planning recommendations',
    section: 'page-rebalancing'
  },
  fallback: {
    title: 'Reserve Allocation',
    subtitle: 'Surplus routing to storage-capable hubs',
    section: 'page-fallback'
  },
  community: {
    title: 'Community Intelligence',
    subtitle: 'Hotspots, access gaps and structural mismatches',
    section: 'page-community'
  },
  'waste-risk': {
    title: 'Waste Risk',
    subtitle: 'Expiring surplus advisory queue',
    section: 'page-waste-risk'
  },
  interventions: {
    title: 'Interventions',
    subtitle: 'System-generated network recommendations',
    section: 'page-interventions'
  },
  metrics: {
    title: 'Network Metrics',
    subtitle: 'Measured network performance',
    section: 'page-metrics'
  },
  'network-map': {
    title: 'Network Map',
    subtitle: 'Network-wide coordination view',
    section: 'page-network-map'
  }
};

const state = {
  page: 'overview',
  lastUpdated: null,
  overview: null,
  supplyDemand: { surplus: [], demands: [], type: 'all', search: '', status: 'all', sort: 'newest', limit: 12 },
  redistributions: { items: [], status: 'all', search: '', limit: 10 },
  rebalancing: null,
  reserve: null,
  community: null,
  risks: [],
  riskFilter: 'all',
  interventions: [],
  intFilter: 'all',
  metrics: null
};

/* -------------------------------------------------------------------------- */
/* Initialisation and navigation                                              */
/* -------------------------------------------------------------------------- */

async function init() {
  hydrateAccount();
  const initial = pageFromHash();
  await navigate(initial, null, { skipHash: true });
  if (initial !== 'overview') await refreshBadges();
  setInterval(renderUpdatedLabel, 30000);
}

function hydrateAccount() {
  const name = cleanText(currentUser?.name) || cleanText(currentUser?.email?.split('@')[0]) || 'Coordinator';
  const email = cleanText(currentUser?.email);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'NC';
  setText('sidebar-avatar', initials);
  setText('user-chip', name);
  setText('account-avatar', initials);
  setText('account-menu-avatar', initials);
  setText('account-name', name);
  setText('account-email', email || 'Network account');
}

function pageFromHash() {
  const value = window.location.hash.replace(/^#\/?/, '');
  return PAGES[value] ? value : 'overview';
}

async function navigate(page, _button, options = {}) {
  if (!PAGES[page]) page = 'overview';
  state.page = page;

  document.querySelectorAll('.section').forEach(section => section.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-section]').forEach(item => {
    item.classList.remove('active');
    item.removeAttribute('aria-current');
  });

  const section = document.getElementById(PAGES[page].section);
  const nav = document.getElementById(`nav-${page}`);
  if (section) section.classList.add('active');
  if (nav) {
    nav.classList.add('active');
    nav.setAttribute('aria-current', 'page');
  }

  setText('page-title', PAGES[page].title);
  setText('topbar-sub', PAGES[page].subtitle);
  if (!options.skipHash) history.replaceState(null, '', `#${page}`);

  window.closeSidebar?.();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await loadPageData(page);
}

window.navigate = navigate;

window.addEventListener('hashchange', () => {
  const page = pageFromHash();
  if (page !== state.page) navigate(page, null, { skipHash: true });
});

function loadPageData(page) {
  switch (page) {
    case 'overview': return loadOverview();
    case 'supply-demand': return loadSupplyDemand();
    case 'redistributions': return loadRedistributions();
    case 'rebalancing': return loadRebalancing();
    case 'fallback': return loadReserve();
    case 'community': return loadCommunity();
    case 'waste-risk': return loadWasteRisk();
    case 'interventions': return loadInterventions();
    case 'metrics': return loadMetrics();
    case 'network-map': return loadNetworkMap();
    default: return Promise.resolve();
  }
}

window.refreshCurrentPage = async function refreshCurrentPage() {
  await loadPageData(state.page);
  toast('Network data refreshed.', 'success');
};

window.retryCurrentPage = function retryCurrentPage() {
  loadPageData(state.page);
};

window.logout = function logout() {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.href = '/';
};

/* -------------------------------------------------------------------------- */
/* API and shared formatting helpers                                          */
/* -------------------------------------------------------------------------- */

async function apiFetch(endpoint, options = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const response = await fetch(API_BASE + endpoint, { ...options, headers, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      response.status === 401
        ? 'Your session has expired. Sign in again.'
        : response.status === 403
          ? 'You do not have permission to view this network data.'
          : data.error || `Request failed (${response.status})`
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function icon(name, className = 'icon') {
  if (typeof window.fbIcon === 'function') return window.fbIcon(name, className);
  return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

function toast(message, type = 'info') {
  if (typeof window.fbToast === 'function') {
    window.fbToast(message, type);
    return;
  }
  const host = document.getElementById('toast-container');
  if (host) {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    host.appendChild(item);
  }
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value == null ? '-' : String(value);
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\uFFFD/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function label(value) {
  const text = cleanText(value);
  if (!text) return 'Food';
  if (/^[a-z_]+$/i.test(text) && !text.includes(' ')) {
    return text.replace(/_/g, ' ').replace(/\b[a-z]/g, character => character.toUpperCase());
  }
  return text;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-IN') : (value == null ? '-' : String(value));
}

function formatQuantity(value, unit) {
  return `${formatNumber(value)} ${cleanText(unit) || 'units'}`;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    text = `${text.replace(' ', 'T')}Z`;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeAgo(value) {
  const date = toDate(value);
  if (!date) return 'Unknown time';
  const diff = Date.now() - date.getTime();
  if (diff < -60000) return `in ${formatDuration(Math.abs(diff))}`;
  if (diff < 60000) return 'just now';
  return `${formatDuration(diff)} ago`;
}

function timeUntil(value) {
  const date = toDate(value);
  if (!date) return 'No deadline';
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'Deadline passed';
  return `in ${formatDuration(diff)}`;
}

function formatDuration(milliseconds) {
  const minutes = Math.max(0, Math.round(milliseconds / 60000));
  if (minutes < 1) return 'under 1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

const STATUS_LABELS = {
  available: 'Available',
  matched: 'Matched',
  in_transit: 'In transit',
  completed: 'Completed',
  expired: 'Expired',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  declined: 'Declined',
  open: 'Open',
  partially_fulfilled: 'Partially fulfilled',
  fulfilled: 'Fulfilled',
  pending: 'Pending',
  confirmed: 'Confirmed',
  pending_buffer: 'Pending reserve',
  operational: 'Operational',
  active: 'Active'
};

function statusLabel(status) {
  return STATUS_LABELS[status] || label(status || 'Unknown');
}

function statusBadgeClass(status) {
  const value = String(status || '').toLowerCase();
  if (['available', 'completed', 'fulfilled', 'confirmed', 'operational', 'active', 'accepted'].includes(value)) {
    return 'badge-success';
  }
  if (['pending', 'partially_fulfilled', 'matched', 'near capacity', 'at-risk', 'pending_buffer'].includes(value)) {
    return 'badge-warning';
  }
  if (['in_transit', 'open', 'reserve'].includes(value)) {
    return 'badge-info';
  }
  if (['expired', 'cancelled', 'canceled', 'declined', 'rejected', 'failed'].includes(value)) {
    return 'badge-danger';
  }
  return 'badge-neutral';
}

function statusBadge(status) {
  return `<span class="status-badge ${statusBadgeClass(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function urgencyBadge(urgency) {
  const value = String(urgency || 'regular').toLowerCase();
  const className = value === 'emergency'
    ? 'badge-emergency'
    : value === 'immediate'
      ? 'badge-immediate'
      : value === 'regular'
        ? 'badge-regular'
        : 'badge-neutral';
  return `<span class="badge ${className}">${escapeHtml(label(value))}</span>`;
}

function priorityBadge(priority) {
  const value = ['high', 'medium', 'low'].includes(priority) ? priority : 'medium';
  return `<span class="int-priority ${value}">${value.toUpperCase()} PRIORITY</span>`;
}

function severityClass(severity) {
  return ['high', 'medium', 'low'].includes(severity) ? severity : 'medium';
}

function renderLoading(id, message = 'Loading data', rows = 3) {
  const element = document.getElementById(id);
  if (!element) return;
  element.innerHTML = `
    <div class="loading-state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <span>${escapeHtml(message)}</span>
    </div>
    ${Array.from({ length: Math.max(0, rows - 1) }, () => '<div class="skeleton skeleton-line"></div>').join('')}
    <span class="sr-only">${escapeHtml(message)}</span>
  `;
}

function renderError(id, message) {
  const element = document.getElementById(id);
  if (!element) return;
  element.innerHTML = `
    <div class="error-state" role="alert">
      ${icon('alert-circle', 'icon')}
      <strong>Could not load this section</strong>
      <p>${escapeHtml(cleanText(message) || 'The network service did not return data.')}</p>
      <button class="btn btn-secondary btn-sm" type="button" onclick="retryCurrentPage()">Retry</button>
    </div>
  `;
}

function emptyState(title, description = '', iconName = 'inbox', actionHtml = '') {
  return `
    <div class="empty-state">
      <span class="empty-icon">${icon(iconName, 'icon')}</span>
      <strong>${escapeHtml(title)}</strong>
      ${description ? `<p>${escapeHtml(description)}</p>` : ''}
      ${actionHtml}
    </div>
  `;
}

function markUpdated() {
  state.lastUpdated = Date.now();
  renderUpdatedLabel();
}

function renderUpdatedLabel() {
  const element = document.getElementById('last-updated');
  if (!element) return;
  if (!state.lastUpdated) {
    element.textContent = 'Waiting for data';
    element.classList.remove('stale');
    return;
  }
  const minutes = Math.floor((Date.now() - state.lastUpdated) / 60000);
  if (minutes < 1) {
    element.textContent = 'Updated just now';
    element.classList.remove('stale');
    return;
  }
  if (minutes < 60) {
    element.textContent = `Updated ${minutes}m ago`;
    element.classList.toggle('stale', minutes >= 5);
    return;
  }
  element.textContent = `Updated ${new Date(state.lastUpdated).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  element.classList.add('stale');
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

async function loadOverview() {
  renderLoading('ov-surplus-list', 'Loading latest surplus', 3);
  renderLoading('ov-demand-list', 'Loading urgent demands', 3);
  renderLoading('ov-risk-list', 'Loading waste risks', 2);

  try {
    const data = await apiFetch('/network/overview');
    state.overview = data;

    setText('ov-surplus', formatNumber(data.activeSurplus));
    setText('ov-demand', formatNumber(data.activeDemands));
    setText('ov-redist', formatNumber(data.activeRedistributions));
    setText('ov-rate', `${formatNumber(data.fulfillmentRate)}%`);
    setText('ov-risk', formatNumber(data.wasteRiskCount));
    setText('ov-recovered', cleanText(data.foodRecoveredToday) || '0 kg');

    renderOverviewSurplus(data.recentSurplus || []);
    renderOverviewDemands(data.urgentDemands || []);
    renderOverviewRisks(data.wasteRisks || []);
    updateBadge('risk-badge', data.wasteRiskCount);
    updateBadge('redist-badge', data.activeRedistributions);
    markUpdated();
  } catch (error) {
    ['ov-surplus', 'ov-demand', 'ov-redist', 'ov-rate', 'ov-risk', 'ov-recovered'].forEach(id => setText(id, '--'));
    renderError('ov-surplus-list', error.message);
    renderError('ov-demand-list', error.message);
    renderError('ov-risk-list', error.message);
  }
}

function renderOverviewSurplus(items) {
  const host = document.getElementById('ov-surplus-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState('No surplus posts yet', 'New donor listings will appear here as soon as they are posted.', 'package');
    return;
  }
  host.innerHTML = items.slice(0, 5).map(item => `
    <div class="net-item">
      <div class="net-item-icon ni-surplus">${icon('package')}</div>
      <div class="net-item-body">
        <div class="net-item-title">${escapeHtml(cleanText(item.title || item.foodType) || 'Surplus food')}</div>
        <div class="net-item-meta">
          <span>${icon('building', 'icon icon-sm')} ${escapeHtml(cleanText(item.donorName) || 'Donor')}</span>
          <span>${icon('pin', 'icon icon-sm')} ${escapeHtml(cleanText(item.address) || 'Area not shared')}</span>
          <span>${icon('clock', 'icon icon-sm')} ${escapeHtml(timeAgo(item.createdAt))}</span>
        </div>
        <div class="redist-badges">${statusBadge(item.status)}</div>
      </div>
      <div class="net-item-right">
        <div class="net-qty green">${formatNumber(item.quantity)}</div>
        <div>${escapeHtml(cleanText(item.unit) || 'units')}</div>
      </div>
    </div>
  `).join('');
}

function renderOverviewDemands(items) {
  const host = document.getElementById('ov-demand-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState('No urgent demands', 'Open emergency and immediate needs will appear here.', 'users');
    return;
  }
  host.innerHTML = items.slice(0, 5).map(item => `
    <div class="net-item">
      <div class="net-item-icon ni-demand">${icon('users')}</div>
      <div class="net-item-body">
        <div class="net-item-title">${escapeHtml(cleanText(item.title || item.foodType) || 'Food demand')}</div>
        <div class="net-item-meta">
          <span>${icon('building', 'icon icon-sm')} ${escapeHtml(cleanText(item.orgName) || 'Demand organisation')}</span>
          <span>${icon('clock-fast', 'icon icon-sm')} ${escapeHtml(timeUntil(item.requiredBy))}</span>
        </div>
        <div class="redist-badges">${statusBadge(item.status)} ${urgencyBadge(item.urgency)}</div>
      </div>
      <div class="net-item-right">
        <div class="net-qty indigo">${formatNumber(item.quantity)}</div>
        <div>${escapeHtml(cleanText(item.unit) || 'units')}</div>
      </div>
    </div>
  `).join('');
}

function renderOverviewRisks(items) {
  const host = document.getElementById('ov-risk-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState('No immediate waste risks', 'Surplus within the three-and-a-half-hour risk window will appear here.', 'check-circle');
    return;
  }
  host.innerHTML = items.map(risk => {
    const high = risk.severity === 'high';
    return `
      <div class="risk-item ${high ? 'high' : 'amber'}">
        <div class="risk-icon">${icon(high ? 'alert-circle' : 'clock-fast')}</div>
        <div class="risk-body">
          <div class="risk-title">${escapeHtml(formatQuantity(risk.quantity, risk.unit))} of ${escapeHtml(cleanText(risk.foodType) || 'food')} - ${escapeHtml(cleanText(risk.donorName) || 'Donor')}</div>
          <div class="risk-detail">${escapeHtml(cleanText(risk.detail) || 'No confirmed delivery yet.')}</div>
          <div class="risk-timer">${escapeHtml(cleanText(risk.expiresIn) || 'Expiry not recorded')}</div>
          <div class="risk-status-line">
            <span class="badge ${high ? 'badge-danger' : 'badge-warning'}">${high ? 'High risk' : 'Medium risk'}</span>
            <span class="badge badge-neutral">Advisory only</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function updateBadge(id, count) {
  const element = document.getElementById(id);
  if (!element) return;
  const value = Number(count) || 0;
  element.textContent = String(value);
  element.hidden = value <= 0;
}

async function refreshBadges() {
  try {
    const data = await apiFetch('/network/overview');
    state.overview = data;
    updateBadge('risk-badge', data.wasteRiskCount);
    updateBadge('redist-badge', data.activeRedistributions);
  } catch {
    // Badges are supplementary; page-level errors are the source of truth.
  }
}

/* -------------------------------------------------------------------------- */
/* Supply and demand                                                          */
/* -------------------------------------------------------------------------- */

async function loadSupplyDemand() {
  setText('sd-count', 'Loading supply and demand...');
  renderLoading('sd-list', 'Loading supply and demand', 5);

  try {
    const data = await apiFetch('/network/supply-demand');
    state.supplyDemand.surplus = (data.surplus || []).map(item => ({ ...item, _type: 'surplus' }));
    state.supplyDemand.demands = (data.demands || []).map(item => ({ ...item, _type: 'demand' }));
    updateSdCounts();
    applySdFilters(true);
    markUpdated();
  } catch (error) {
    setText('sd-count', 'Supply and demand could not be loaded.');
    renderError('sd-list', error.message);
  }
}

function allSdItems() {
  return [...state.supplyDemand.surplus, ...state.supplyDemand.demands];
}

function isUnmatched(item) {
  return !item.matchId && !['completed', 'expired', 'fulfilled', 'cancelled', 'canceled'].includes(item.status);
}

function updateSdCounts() {
  const items = allSdItems();
  setText('sd-count-all', items.length);
  setText('sd-count-surplus', items.filter(item => item._type === 'surplus').length);
  setText('sd-count-demand', items.filter(item => item._type === 'demand').length);
  setText('sd-count-unmatched', items.filter(isUnmatched).length);
}

window.setSdType = function setSdType(type, button) {
  state.supplyDemand.type = type;
  document.querySelectorAll('[id^="sd-type-"]').forEach(item => item.classList.remove('active'));
  button?.classList.add('active');
  applySdFilters(true);
};

window.applySdFilters = function applySdFilters(resetLimit = true) {
  const sd = state.supplyDemand;
  const searchInput = document.getElementById('sd-search');
  const statusInput = document.getElementById('sd-status');
  const sortInput = document.getElementById('sd-sort');
  sd.search = searchInput ? searchInput.value.trim().toLowerCase() : '';
  sd.status = statusInput ? statusInput.value : 'all';
  sd.sort = sortInput ? sortInput.value : 'newest';
  if (resetLimit) sd.limit = 12;

  let items = allSdItems();
  if (sd.type === 'surplus') items = items.filter(item => item._type === 'surplus');
  if (sd.type === 'demand') items = items.filter(item => item._type === 'demand');
  if (sd.type === 'unmatched') items = items.filter(isUnmatched);
  if (sd.status !== 'all') items = items.filter(item => item.status === sd.status);

  if (sd.search) {
    items = items.filter(item => [
      item.title,
      item.foodType,
      item.donorName,
      item.orgName,
      item.address,
      item.urgency,
      item.status
    ].some(value => String(value || '').toLowerCase().includes(sd.search)));
  }

  items.sort((a, b) => {
    if (sd.sort === 'oldest') return (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0);
    if (sd.sort === 'quantity') return (Number(b.quantity) || 0) - (Number(a.quantity) || 0);
    if (sd.sort === 'urgency') return urgencyWeight(b.urgency) - urgencyWeight(a.urgency);
    return (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0);
  });

  setText('sd-count', items.length
    ? `Showing ${Math.min(sd.limit, items.length)} of ${items.length} matching item${items.length === 1 ? '' : 's'}.`
    : 'No supply or demand matches the current filters.');

  renderSdList(items.slice(0, sd.limit));
  const loadMore = document.getElementById('sd-load-more');
  if (loadMore) loadMore.hidden = items.length <= sd.limit;
};

function urgencyWeight(value) {
  return { emergency: 3, immediate: 2, regular: 1 }[value] || 0;
}

function renderSdList(items) {
  const host = document.getElementById('sd-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState(
      'No matching supply or demand',
      'Try a different search, status or type filter.',
      'search',
      '<button class="cta" type="button" onclick="clearSdFilters()">Clear filters</button>'
    );
    return;
  }

  host.innerHTML = items.map(item => {
    const surplus = item._type === 'surplus';
    const title = cleanText(item.title || item.foodType) || (surplus ? 'Surplus food' : 'Food demand');
    const organisation = cleanText(item.donorName || item.orgName) || (surplus ? 'Donor' : 'Demand organisation');
    const location = cleanText(item.address);
    const meta = [
      `<span>${icon('building', 'icon icon-sm')} ${escapeHtml(organisation)}</span>`,
      location ? `<span>${icon('pin', 'icon icon-sm')} ${escapeHtml(location)}</span>` : '',
      item.urgency ? `<span>${icon('clock-fast', 'icon icon-sm')} ${escapeHtml(label(item.urgency))}</span>` : '',
      item.requiredBy ? `<span>${icon('clock', 'icon icon-sm')} ${escapeHtml(timeUntil(item.requiredBy))}</span>` : '',
      `<span>${icon('calendar', 'icon icon-sm')} ${escapeHtml(timeAgo(item.createdAt))}</span>`
    ].join('');

    return `
      <div class="net-item">
        <div class="net-item-icon ${surplus ? 'ni-surplus' : 'ni-demand'}">${icon(surplus ? 'package' : 'users')}</div>
        <div class="net-item-body">
          <div class="net-item-title">
            ${escapeHtml(title)}
            <span class="badge ${surplus ? 'badge-success' : 'badge-info'}">${surplus ? 'Surplus' : 'Demand'}</span>
          </div>
          <div class="net-item-meta">${meta}</div>
          <div class="redist-badges">${statusBadge(item.status)}${item.urgency && !surplus ? urgencyBadge(item.urgency) : ''}</div>
        </div>
        <div class="net-item-right">
          <div class="net-qty ${surplus ? 'green' : 'indigo'}">${formatNumber(item.quantity)}</div>
          <div>${escapeHtml(cleanText(item.unit) || 'units')}</div>
        </div>
      </div>
    `;
  }).join('');
}

window.loadMoreSd = function loadMoreSd() {
  state.supplyDemand.limit += 12;
  applySdFilters(false);
};

window.clearSdFilters = function clearSdFilters() {
  state.supplyDemand.type = 'all';
  document.querySelectorAll('[id^="sd-type-"]').forEach(item => item.classList.remove('active'));
  document.getElementById('sd-type-all')?.classList.add('active');
  const searchInput = document.getElementById('sd-search');
  const statusInput = document.getElementById('sd-status');
  const sortInput = document.getElementById('sd-sort');
  if (searchInput) searchInput.value = '';
  if (statusInput) statusInput.value = 'all';
  if (sortInput) sortInput.value = 'newest';
  applySdFilters(true);
};

/* -------------------------------------------------------------------------- */
/* Redistributions                                                            */
/* -------------------------------------------------------------------------- */

async function loadRedistributions() {
  setText('rd-count', 'Loading redistributions...');
  renderLoading('rd-list', 'Loading redistributions', 5);

  try {
    const data = await apiFetch('/network/redistributions');
    state.redistributions.items = data.redistributions || [];
    updateRdCounts();
    applyRedistributionFilters(true);
    markUpdated();
  } catch (error) {
    setText('rd-count', 'Redistributions could not be loaded.');
    renderError('rd-list', error.message);
  }
}

function updateRdCounts() {
  const items = state.redistributions.items;
  setText('rd-count-all', items.length);
  ['pending', 'confirmed', 'in_transit', 'completed', 'declined', 'cancelled'].forEach(status => {
    setText(`rd-count-${status}`, items.filter(item => item.status === status).length);
  });
}

window.setRdStatus = function setRdStatus(status, button) {
  state.redistributions.status = status;
  document.querySelectorAll('[id^="rd-filter-"]').forEach(item => item.classList.remove('active'));
  button?.classList.add('active');
  applyRedistributionFilters(true);
};

window.applyRedistributionFilters = function applyRedistributionFilters(resetLimit = true) {
  const rd = state.redistributions;
  const searchInput = document.getElementById('rd-search');
  rd.search = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (resetLimit) rd.limit = 10;

  let items = rd.items;
  if (rd.status !== 'all') items = items.filter(item => item.status === rd.status);
  if (rd.search) {
    items = items.filter(item => [
      item.foodType,
      item.donorName,
      item.recipientName,
      item.status
    ].some(value => String(value || '').toLowerCase().includes(rd.search)));
  }

  setText('rd-count', items.length
    ? `Showing ${Math.min(rd.limit, items.length)} of ${items.length} redistribution${items.length === 1 ? '' : 's'}.`
    : 'No redistributions match the current filters.');

  renderRedistributionList(items.slice(0, rd.limit));
  const loadMore = document.getElementById('rd-load-more');
  if (loadMore) loadMore.hidden = items.length <= rd.limit;
};

function renderRedistributionList(items) {
  const host = document.getElementById('rd-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState(
      'No redistributions match this filter',
      'Try another status or clear the search.',
      'route',
      '<button class="cta" type="button" onclick="clearRdFilters()">Clear filters</button>'
    );
    return;
  }

  host.innerHTML = items.map(item => `
    <div class="net-item">
      <div class="net-item-icon ni-match">${icon('route')}</div>
      <div class="net-item-body">
        <div class="redist-route">
          <span class="route-org">${escapeHtml(cleanText(item.donorName) || 'Donor')}</span>
          <span class="route-arrow" aria-hidden="true">${icon('arrow-right', 'icon icon-sm')}</span>
          <span class="route-org">${escapeHtml(cleanText(item.recipientName) || 'Recipient')}</span>
        </div>
        <div class="net-item-title">${escapeHtml(cleanText(item.foodType) || 'Food')}</div>
        <div class="net-item-meta">
          <span>${icon('scale', 'icon icon-sm')} ${escapeHtml(formatQuantity(item.quantity, item.unit))}</span>
          <span>${icon('route', 'icon icon-sm')} ${escapeHtml(cleanText(item.distance) || 'Distance unavailable')}</span>
          <span>${icon('clock', 'icon icon-sm')} ${escapeHtml(timeAgo(item.startedAt))}</span>
        </div>
        <div class="redist-badges">${statusBadge(item.status)}</div>
      </div>
      <div class="net-item-right">
        <div class="net-qty indigo">${formatNumber(item.quantity)}</div>
        <div>${escapeHtml(cleanText(item.unit) || 'units')}</div>
      </div>
    </div>
  `).join('');
}

window.loadMoreRd = function loadMoreRd() {
  state.redistributions.limit += 10;
  applyRedistributionFilters(false);
};

window.clearRdFilters = function clearRdFilters() {
  state.redistributions.status = 'all';
  document.querySelectorAll('[id^="rd-filter-"]').forEach(item => item.classList.remove('active'));
  document.getElementById('rd-filter-all')?.classList.add('active');
  const searchInput = document.getElementById('rd-search');
  if (searchInput) searchInput.value = '';
  applyRedistributionFilters(true);
};

/* -------------------------------------------------------------------------- */
/* Rebalancing                                                                */
/* -------------------------------------------------------------------------- */

async function loadRebalancing() {
  renderLoading('surplus-zones', 'Loading surplus zones', 3);
  renderLoading('deficit-zones', 'Loading deficit zones', 3);
  renderLoading('rebalancing-recs', 'Loading recommendations', 2);
  setText('rebalance-summary', 'Loading zone balance...');

  try {
    const data = await apiFetch('/network/rebalancing');
    state.rebalancing = data;
    const zones = data.zones || [];
    const recommendations = data.recommendations || [];
    const surplus = zones.filter(zone => Number(zone.balance) > 0);
    const deficit = zones.filter(zone => Number(zone.balance) < 0);
    const largestDeficit = deficit.reduce((worst, zone) => Math.min(worst, Number(zone.balance) || 0), 0);

    setText('surplus-zone-count', `${surplus.length} zone${surplus.length === 1 ? '' : 's'}`);
    setText('deficit-zone-count', `${deficit.length} zone${deficit.length === 1 ? '' : 's'}`);
    setText('rebalance-summary', zones.length
      ? `${zones.length} measured zone${zones.length === 1 ? '' : 's'} - ${surplus.length} in surplus, ${deficit.length} in deficit, largest deficit ${formatNumber(Math.abs(largestDeficit))} units.`
      : 'No active zones have supply or demand right now.');

    renderZones('surplus-zones', surplus, 'surplus');
    renderZones('deficit-zones', deficit, 'deficit');
    renderRebalancingRecommendations(recommendations);
    markUpdated();
  } catch (error) {
    setText('rebalance-summary', 'Zone balance could not be loaded.');
    renderError('surplus-zones', error.message);
    renderError('deficit-zones', error.message);
    renderError('rebalancing-recs', error.message);
  }
}

function renderZones(id, zones, type) {
  const host = document.getElementById(id);
  if (!host) return;
  if (!zones.length) {
    host.innerHTML = emptyState(
      type === 'surplus' ? 'No surplus zones' : 'No deficit zones',
      type === 'surplus'
        ? 'No measured zone currently has more supply than demand.'
        : 'No measured zone currently has more demand than supply.',
      type === 'surplus' ? 'package' : 'users'
    );
    return;
  }

  host.innerHTML = zones.map(zone => {
    const supply = Number(zone.supply) || 0;
    const demand = Number(zone.demand) || 0;
    const max = Math.max(supply, demand, 1);
    const supplyPercent = Math.max(0, Math.min(100, Math.round((supply / max) * 100)));
    const demandPercent = Math.max(0, Math.min(100, Math.round((demand / max) * 100)));
    const balance = Number(zone.balance) || 0;
    const positive = balance >= 0;
    return `
      <article class="area-card ${type === 'surplus' ? 'surplus-zone' : 'deficit-zone'}">
        <div class="zone-head">
          <div class="zone-name">${escapeHtml(cleanText(zone.name) || 'Unnamed zone')}</div>
          <span class="area-balance ${positive ? 'balance-pos' : 'balance-neg'} zone-balance">${positive ? '+' : '-'}${formatNumber(Math.abs(balance))} units net</span>
        </div>
        <div class="zone-bars">
          <div class="zone-bar-row">
            <span>Supply</span>
            <div class="zone-bar-track"><i style="width:${supplyPercent}%"></i></div>
            <strong>${formatNumber(supply)}</strong>
          </div>
          <div class="zone-bar-row">
            <span>Demand</span>
            <div class="zone-bar-track demand"><i style="width:${demandPercent}%"></i></div>
            <strong>${formatNumber(demand)}</strong>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderRebalancingRecommendations(recommendations) {
  const host = document.getElementById('rebalancing-recs');
  if (!host) return;
  if (!recommendations.length) {
    host.innerHTML = emptyState('No recommendations', 'The network has no planning recommendation for the current zone balance.', 'check-circle');
    return;
  }

  host.innerHTML = recommendations.map(recommendation => `
    <div class="intervention-item rebalance-rec">
      <div class="int-icon">${icon('route')}</div>
      <div class="int-body">
        <div class="int-title">${escapeHtml(cleanText(recommendation.title) || 'Review zone balance')}</div>
        <div class="int-detail">${escapeHtml(cleanText(recommendation.detail) || '')}</div>
        ${priorityBadge(recommendation.priority)}
        <span class="planning-tag">${icon('info')} Planning only - no transfer created</span>
      </div>
    </div>
  `).join('');
}

/* -------------------------------------------------------------------------- */
/* Reserve allocation                                                         */
/* -------------------------------------------------------------------------- */

async function loadReserve() {
  renderLoading('reserve-points', 'Loading reserve capacity', 2);
  renderLoading('pending-reserve', 'Loading pending reserve routing', 3);
  setText('rs-points', '--');
  setText('rs-available', '--');
  setText('rs-pending', '--');

  try {
    const data = await apiFetch('/network/reserve');
    state.reserve = data;
    const points = data.reservePoints || [];
    const pending = data.pendingReserve || [];
    const available = points.reduce((total, point) => {
      const capacity = Number(point.capacity) || 0;
      const load = Number(point.currentLoad) || 0;
      return total + Math.max(0, capacity - load);
    }, 0);

    setText('rs-points', formatNumber(points.length));
    setText('rs-available', formatNumber(available));
    setText('rs-pending', formatNumber(pending.length));
    renderReservePoints(points);
    renderPendingReserve(pending);
    markUpdated();
  } catch (error) {
    renderError('reserve-points', error.message);
    renderError('pending-reserve', error.message);
  }
}

function renderReservePoints(points) {
  const host = document.getElementById('reserve-points');
  if (!host) return;
  if (!points.length) {
    host.innerHTML = emptyState('No reserve points available', 'No active food bank or reserve hub is currently configured.', 'inbox');
    return;
  }

  host.innerHTML = points.map(point => {
    const capacity = Number(point.capacity) || 0;
    const load = Number(point.currentLoad) || 0;
    const available = Math.max(0, capacity - load);
    const percent = capacity > 0 ? Math.min(100, Math.round((load / capacity) * 100)) : 0;
    const tone = percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : '';
    return `
      <article class="reserve-card">
        <div class="reserve-head">
          <div>
            <div class="reserve-name">${escapeHtml(cleanText(point.name) || 'Reserve point')}</div>
            <div class="reserve-address">${escapeHtml(cleanText(point.locationAddress) || 'Address not shared')}</div>
          </div>
          ${statusBadge(point.status)}
        </div>
        <div class="reserve-storage">
          ${icon('box')}
          <span>${escapeHtml(cleanText(point.storageInfo) || 'Storage capacity not declared')}</span>
        </div>
        <div class="reserve-capacity-head">
          <span>Committed load</span>
          <strong>${formatNumber(load)} / ${formatNumber(capacity)} servings</strong>
        </div>
        <div class="reserve-capacity-track"><i class="${tone}" style="width:${percent}%"></i></div>
        <div class="reserve-foot">
          <span>${percent}% used</span>
          <strong>${formatNumber(available)} available</strong>
        </div>
      </article>
    `;
  }).join('');
}

function renderPendingReserve(items) {
  const host = document.getElementById('pending-reserve');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState('No pending reserve routing', 'Available surplus closing within three hours without a match will appear here.', 'check-circle');
    return;
  }

  host.innerHTML = items.map(item => `
    <div class="net-item">
      <div class="net-item-icon ni-reserve">${icon('inbox')}</div>
      <div class="net-item-body">
        <div class="net-item-title">${escapeHtml(cleanText(item.title || item.foodType) || 'Surplus food')}</div>
        <div class="net-item-meta">
          <span>${icon('building', 'icon icon-sm')} ${escapeHtml(cleanText(item.donorName) || 'Donor')}</span>
          <span>${icon('pin', 'icon icon-sm')} ${escapeHtml(cleanText(item.address) || 'Pickup address not shared')}</span>
          <span>${icon('info', 'icon icon-sm')} Coordinator routing required</span>
        </div>
        <div class="redist-badges">${statusBadge(item.status)}</div>
      </div>
      <div class="net-item-right">
        <div class="net-qty amber">${formatNumber(item.quantity)}</div>
        <div>${escapeHtml(cleanText(item.unit) || 'units')}</div>
      </div>
    </div>
  `).join('');
}

/* -------------------------------------------------------------------------- */
/* Community intelligence                                                     */
/* -------------------------------------------------------------------------- */

async function loadCommunity() {
  ['surplus-hotspots', 'demand-hotspots', 'access-gaps', 'recurring-mismatches'].forEach(id => {
    renderLoading(id, 'Loading community intelligence', 3);
  });

  try {
    const data = await apiFetch('/network/community');
    state.community = data;
    setText('ci-surplus', formatNumber((data.surplusHotspots || []).length));
    setText('ci-demand', formatNumber((data.demandHotspots || []).length));
    setText('ci-gaps', formatNumber((data.accessGaps || []).length));

    renderHotspots('surplus-hotspots', data.surplusHotspots || [], 'surplus');
    renderHotspots('demand-hotspots', data.demandHotspots || [], 'demand');
    renderHotspots('access-gaps', data.accessGaps || [], 'gap');
    renderMismatches(data.mismatches || []);
    markUpdated();
  } catch (error) {
    ['surplus-hotspots', 'demand-hotspots', 'access-gaps', 'recurring-mismatches'].forEach(id => renderError(id, error.message));
  }
}

function renderHotspots(id, spots, type) {
  const host = document.getElementById(id);
  if (!host) return;
  if (!spots.length) {
    host.innerHTML = emptyState(
      type === 'surplus' ? 'No surplus hotspots' : type === 'demand' ? 'No demand hotspots' : 'No access gaps',
      type === 'surplus'
        ? 'No organisation currently has concentrated supply.'
        : type === 'demand'
          ? 'No organisation currently has concentrated unmet demand.'
          : 'No open demand is currently waiting without supply.',
      type === 'gap' ? 'check-circle' : 'map'
    );
    return;
  }

  host.innerHTML = spots.map(spot => {
    const severity = severityClass(spot.severity);
    const typeLabel = type === 'surplus' ? 'Surplus hotspot' : type === 'demand' ? 'Demand hotspot' : 'Access gap';
    return `
      <article class="hotspot-item">
        <div class="hotspot-type ${type}">${typeLabel}</div>
        <div class="hotspot-area">${escapeHtml(cleanText(spot.area) || 'Unnamed area')}</div>
        <div class="hotspot-detail">${escapeHtml(cleanText(spot.detail) || '')}</div>
        <span class="hotspot-severity sev-${severity}">${escapeHtml(severity)}</span>
      </article>
    `;
  }).join('');
}

function renderMismatches(items) {
  const host = document.getElementById('recurring-mismatches');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState('No recurring mismatches', 'No structural supply-demand mismatch is currently detected.', 'check-circle');
    return;
  }

  host.innerHTML = items.map(item => `
    <div class="net-item">
      <div class="net-item-icon ni-risk">${icon('lightbulb')}</div>
      <div class="net-item-body">
        <div class="net-item-title">${escapeHtml(cleanText(item.title) || 'Structural mismatch')}</div>
        <div class="net-item-meta"><span>${escapeHtml(cleanText(item.detail) || '')}</span></div>
        ${item.frequency ? `<div class="mismatch-frequency">${icon('recycle')} ${escapeHtml(cleanText(item.frequency))}</div>` : ''}
      </div>
    </div>
  `).join('');
}

/* -------------------------------------------------------------------------- */
/* Waste risk                                                                 */
/* -------------------------------------------------------------------------- */

async function loadWasteRisk() {
  renderLoading('risk-full-list', 'Loading waste-risk queue', 4);
  try {
    const data = await apiFetch('/network/waste-risk');
    state.risks = data.risks || [];
    updateRiskCounts();
    applyRiskFilter();
    updateBadge('risk-badge', state.risks.length);
    markUpdated();
  } catch (error) {
    renderError('risk-full-list', error.message);
  }
}

function updateRiskCounts() {
  const risks = state.risks;
  const high = risks.filter(risk => risk.severity === 'high').length;
  const medium = risks.filter(risk => risk.severity !== 'high').length;

  setText('risk-high-count', formatNumber(high));
  setText('risk-pending-count', formatNumber(medium));
  setText('risk-blocked-count', formatNumber(risks.length));
  setText('risk-filter-all-count', risks.length);
  setText('risk-filter-high-count', high);
  setText('risk-filter-medium-count', medium);
}

window.setRiskFilter = function setRiskFilter(filter, button) {
  state.riskFilter = filter;
  document.querySelectorAll('[id^="risk-filter-"]').forEach(item => item.classList.remove('active'));
  button?.classList.add('active');
  applyRiskFilter();
};

function applyRiskFilter() {
  let items = state.risks;
  if (state.riskFilter === 'high') items = items.filter(risk => risk.severity === 'high');
  if (state.riskFilter === 'medium') items = items.filter(risk => risk.severity !== 'high');
  renderRiskList(items);
}

function renderRiskList(items) {
  const host = document.getElementById('risk-full-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState(
      state.risks.length ? 'No waste risks match this filter' : 'No waste risks right now',
      state.risks.length
        ? 'Try a different risk filter.'
        : 'No available surplus is close to its safe-until window.',
      'check-circle'
    );
    return;
  }

  host.innerHTML = items.map(risk => {
    const high = risk.severity === 'high';
    return `
      <div class="risk-item ${high ? 'high' : 'amber'}">
        <div class="risk-icon">${icon('clock-fast')}</div>
        <div class="risk-body">
          <div class="risk-title">${escapeHtml(formatQuantity(risk.quantity, risk.unit))} of ${escapeHtml(cleanText(risk.foodType) || 'food')} - ${escapeHtml(cleanText(risk.donorName) || 'Donor')}</div>
          <div class="risk-detail">${escapeHtml(cleanText(risk.detail) || 'No confirmed delivery yet.')}</div>
          <div class="risk-timer">Expires in ${escapeHtml(cleanText(risk.expiresIn) || 'unknown')}</div>
          <div class="risk-status-line">
            <span class="badge ${high ? 'badge-danger' : 'badge-warning'}">${high ? 'High risk' : 'Medium risk'}</span>
            <span class="badge badge-neutral">No automated re-route</span>
          </div>
          <div class="risk-actions">
            <button class="risk-btn reserve" type="button" onclick="navigate('network-map', null)">
              ${icon('map', 'icon icon-sm')} View on network map
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/* -------------------------------------------------------------------------- */
/* Interventions                                                              */
/* -------------------------------------------------------------------------- */

async function loadInterventions() {
  renderLoading('interventions-list', 'Loading recommendations', 4);
  try {
    const data = await apiFetch('/network/interventions');
    const seen = new Set();
    state.interventions = (data.interventions || []).filter(item => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    updateInterventionCounts();
    applyInterventionFilter();
    markUpdated();
  } catch (error) {
    renderError('interventions-list', error.message);
  }
}

function updateInterventionCounts() {
  const items = state.interventions;
  const high = items.filter(item => item.priority === 'high').length;
  const medium = items.filter(item => item.priority === 'medium').length;
  const low = items.filter(item => item.priority === 'low').length;
  setText('int-high-count', high);
  setText('int-medium-count', medium);
  setText('int-low-count', low);
  setText('int-count-all', items.length);
  setText('int-count-high', high);
  setText('int-count-medium', medium);
  setText('int-count-low', low);
}

window.setIntFilter = function setIntFilter(filter, button) {
  state.intFilter = filter;
  document.querySelectorAll('[id^="int-filter-"]').forEach(item => item.classList.remove('active'));
  button?.classList.add('active');
  applyInterventionFilter();
};

function applyInterventionFilter() {
  const items = state.intFilter === 'all'
    ? state.interventions
    : state.interventions.filter(item => item.priority === state.intFilter);
  renderInterventions(items);
}

function interventionTarget(id) {
  if (String(id).startsWith('int-surplus') || String(id).startsWith('int-bulk')) {
    return { page: 'waste-risk', label: 'Review waste risk', icon: 'alert-circle' };
  }
  if (String(id).startsWith('int-demand')) {
    return { page: 'supply-demand', label: 'Review supply & demand', icon: 'scale' };
  }
  if (String(id).startsWith('int-match')) {
    return { page: 'redistributions', label: 'Review redistributions', icon: 'route' };
  }
  return { page: 'rebalancing', label: 'Review rebalancing', icon: 'network' };
}

function renderInterventions(items) {
  const host = document.getElementById('interventions-list');
  if (!host) return;
  if (!items.length) {
    host.innerHTML = emptyState(
      'No recommendations match this filter',
      'Try another priority or refresh the recommendation queue.',
      'lightbulb'
    );
    return;
  }

  host.innerHTML = items.map(item => {
    const target = interventionTarget(item.id);
    return `
      <div class="intervention-item">
        <div class="int-icon">${icon('lightbulb')}</div>
        <div class="int-body">
          <div class="int-title">${escapeHtml(cleanText(item.title) || 'Network recommendation')}</div>
          <div class="int-detail">${escapeHtml(cleanText(item.detail) || '')}</div>
          ${priorityBadge(item.priority)}
          <div class="int-actions">
            <button class="btn btn-secondary btn-sm" type="button" onclick="navigate('${target.page}', null)">
              ${icon(target.icon)} ${escapeHtml(target.label)}
            </button>
            <span class="planning-tag">Advisory - coordinator follow-up required</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

async function loadMetrics() {
  const statIds = ['m-total-surplus', 'm-total-demand', 'm-recovered', 'm-waste-prevented', 'm-fulfillment', 'm-unmet'];
  statIds.forEach(id => setText(id, '--'));
  renderLoading('weekly-chart', 'Loading seven-day supply and demand', 2);
  renderLoading('waste-chart', 'Loading seven-day waste data', 2);

  try {
    const metrics = await apiFetch('/network/metrics');
    state.metrics = metrics;
    setText('m-total-surplus', metrics.totalSurplus || '0');
    setText('m-total-demand', metrics.totalDemand || '0');
    setText('m-recovered', metrics.foodRecovered || '0');
    setText('m-waste-prevented', metrics.wastePrevented || '0');
    setText('m-fulfillment', `${formatNumber(metrics.fulfillmentRate)}%`);
    setText('m-unmet', metrics.unmetDemand || '0');

    const weekly = metrics.weeklyData || [];
    const waste = metrics.wasteData || [];
    const sumKey = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
    const weeklySupply = sumKey(weekly, 'surplus');
    const weeklyFulfilled = sumKey(weekly, 'fulfilled');
    const weeklyExpired = sumKey(waste, 'unintercepted');
    const utilization = weeklySupply > 0 ? Math.round((weeklyFulfilled / weeklySupply) * 100) : null;

    setText('m-utilization', utilization == null ? 'No supply' : `${utilization}%`);
    setText('m-success', `${formatNumber(weeklyFulfilled)} kg`);
    setText('m-expired', `${formatNumber(weeklyExpired)} kg`);

    const firstDaySupply = Number(weekly[0]?.surplus) || 0;
    const lastDaySupply = Number(weekly[weekly.length - 1]?.surplus) || 0;
    if (!firstDaySupply && !lastDaySupply) {
      setText('m-trend', 'No activity');
    } else if (!firstDaySupply) {
      setText('m-trend', 'New activity');
    } else {
      const change = Math.round(((lastDaySupply - firstDaySupply) / firstDaySupply) * 100);
      setText('m-trend', `${change > 0 ? '+' : ''}${change}% vs first day`);
    }

    renderGroupedChart('weekly-chart', metrics.weeklyData || [], [
      { key: 'surplus', label: 'surplus', className: '' },
      { key: 'demand', label: 'demand', className: 'demand' },
      { key: 'fulfilled', label: 'fulfilled', className: 'fulfilled' }
    ], 'No supply, demand or completed collections in the last seven days.');

    renderGroupedChart('waste-chart', metrics.wasteData || [], [
      { key: 'intercepted', label: 'intercepted', className: 'intercepted' },
      { key: 'unintercepted', label: 'expired', className: 'wasted' }
    ], 'No recovered or expired quantities in the last seven days.');
    markUpdated();
  } catch (error) {
    renderError('weekly-chart', error.message);
    renderError('waste-chart', error.message);
  }
}

function renderGroupedChart(id, rows, series, emptyMessage) {
  const host = document.getElementById(id);
  if (!host) return;
  const allZero = !rows.length || rows.every(row => series.every(entry => !Number(row[entry.key])));
  if (allZero) {
    host.innerHTML = emptyState('No chart activity', emptyMessage, 'chart');
    host.setAttribute('aria-label', emptyMessage);
    return;
  }

  const max = Math.max(...rows.flatMap(row => series.map(entry => Number(row[entry.key]) || 0)), 1);
  const summary = rows.map(row => `${row.day}: ${series.map(entry => `${formatNumber(row[entry.key] || 0)} ${entry.label}`).join(', ')}`).join('. ');
  host.setAttribute('aria-label', summary);
  host.innerHTML = `
    <div class="net-chart-bars">
      ${rows.map(row => `
        <div class="net-chart-column">
          <div class="net-chart-group">
            ${series.map(entry => {
              const value = Number(row[entry.key]) || 0;
              const percent = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
              const text = `${row.day}: ${formatNumber(value)} ${entry.label}`;
              return `
                <div class="net-chart-bar ${entry.className}" style="height:${percent}%" ${value > 0 ? 'tabindex="0"' : ''} role="img" aria-label="${escapeAttr(text)}">
                  <span class="net-chart-tooltip">${escapeHtml(text)}</span>
                </div>
              `;
            }).join('')}
          </div>
          <span class="net-chart-label">${escapeHtml(row.day)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
