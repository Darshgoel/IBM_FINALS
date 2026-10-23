/**
 * FoodBridge — Biogas Operator Dashboard JS
 * Handles: Overview, Incoming Routes (with weigh-in modal), Capacity & Intake,
 *          Accepted Waste Types, Alerts, Profile & Location, Claim Facility.
 *
 * API shape note: GET /api/biogas/routes returns { routes, todayIntakeKg }
 */
import api from './api.js';

// ── Auth guard ─────────────────────────────────────────────────────────────
const token = localStorage.getItem('fb_token');
const user  = JSON.parse(localStorage.getItem('fb_user') || 'null');
if (!token || !user || user.role !== 'biogas_operator') {
  window.location.href = '/biogas/index.html';
  throw new Error('Biogas operator authentication required');
}

// ── State ──────────────────────────────────────────────────────────────────
let facility      = null;
let allRoutes     = [];
let todayIntakeKg = 0;
let allAlerts     = [];
let routeFilter   = 'all';
let routeSearch   = '';
let isAvailable   = true;
let locationMap   = null;
let locationMarker = null;

// ── Page router ────────────────────────────────────────────────────────────
const PAGE_MAP = {
  overview:      'page-overview',
  routes:        'page-routes',
  capacity:      'page-capacity',
  'waste-types': 'page-waste-types',
  alerts:        'page-alerts',
  profile:       'page-profile',
  claim:         'page-claim'
};

const PAGE_TITLES = {
  overview:      ['Overview',              'Your biogas facility at a glance'],
  routes:        ['Incoming Routes',       'Waste-food routes assigned to your facility'],
  capacity:      ['Capacity & Intake',     'Daily intake limits and current received volume'],
  'waste-types': ['Accepted Waste Types',  'Food categories your facility accepts for processing'],
  alerts:        ['Alerts',               'Network notifications for your facility'],
  profile:       ['Profile & Location',    'Manage facility contact info and map pin'],
  claim:         ['Claim Facility',        'Link your account to an existing FoodBridge facility record']
};

window.showPage = function (page) {
  Object.values(PAGE_MAP).forEach(id => document.getElementById(id)?.classList.remove('active'));
  document.getElementById(PAGE_MAP[page])?.classList.add('active');

  Object.keys(PAGE_MAP).forEach(key => {
    const nav = document.getElementById(`nav-${key}`);
    nav?.classList.toggle('active', key === page);
    key === page ? nav?.setAttribute('aria-current','page') : nav?.removeAttribute('aria-current');
  });

  const [title, sub] = PAGE_TITLES[page] || [page, ''];
  setText('topbar-title', title);
  setText('topbar-sub', sub);

  if (page === 'overview')      loadOverview();
  if (page === 'routes')        renderRoutes();
  if (page === 'capacity')      loadCapacity();
  if (page === 'waste-types')   loadWasteTypes();
  if (page === 'alerts')        loadAlerts();
  if (page === 'profile')       loadProfile();
  if (page === 'claim')         loadClaim();
};

// ── Utilities ──────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setText(id, v)  { const e = $(id); if (e) e.textContent = v ?? ''; }
function setVal(id, v)   { const e = $(id); if (e) e.value = v ?? ''; }
function showMsg(id, txt, type) {
  const e = $(id); if (!e) return;
  e.textContent = txt;
  e.className   = `msg${type === 'success' ? ' success' : ''}`;
  e.style.display = txt ? '' : 'none';
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'
  });
}
function statusBadge(s) {
  const cls = {
    pending:    'badge-pending',
    accepted:   'badge-matched',
    received:   'badge-completed badge-success',
    rejected:   'badge-cancelled badge-danger'
  };
  return `<span class="badge ${cls[s]||'badge-neutral'}">${esc(s||'—').replace(/_/g,' ')}</span>`;
}

window.signOut = function () {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.href = '/';
};

window.toggleAccountMenu = function () {
  $('account-menu')?.classList.toggle('open');
};

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  const initials = (user.name || 'BG').split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
  setText('account-name', user.name || user.email);
  setText('account-menu-name', user.name || '');
  setText('account-menu-email', user.email || '');
  ['account-avatar','account-menu-avatar'].forEach(id => setText(id, initials));

  try {
    facility    = await api.biogas.getFacility(token);
    const av    = (facility.name || 'BG').split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
    setText('sidebar-avatar', av);
    setText('sidebar-org-name', facility.name || 'My Facility');
    isAvailable = !!facility.is_available;
    updateAvailabilityUI();
  } catch (e) {
    console.warn('[Biogas] No facility linked yet', e);
    setText('sidebar-org-name', user.name || 'Biogas Operator');
    setText('sidebar-availability', 'No facility linked');
    updateAvailabilityUI();
  }
  loadOverview();
  loadAlertsCount();

  // Mobile nav toggle
  $('nav-toggle')?.addEventListener('click', () => {
    $('sidebar')?.classList.toggle('open');
    $('sidebar-backdrop')?.classList.toggle('show');
  });
  $('sidebar-backdrop')?.addEventListener('click', () => {
    $('sidebar')?.classList.remove('open');
    $('sidebar-backdrop')?.classList.remove('show');
  });
  // Close account menu on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#account-menu') && !e.target.closest('#account-trigger')) {
      $('account-menu')?.classList.remove('open');
    }
  });
}

function updateAvailabilityUI() {
  const btn   = $('avail-toggle');
  const label = $('avail-label');
  const side  = $('sidebar-availability');
  if (btn)   btn.className = `availability-toggle${isAvailable ? ' avail-on' : ' avail-off'}`;
  if (label) label.textContent = isAvailable ? '● Available' : '○ Unavailable';
  if (side && facility)  side.textContent  = isAvailable ? 'Accepting routes' : 'Not accepting routes';
}

window.toggleAvailability = async function () {
  if (!facility) { alert('No facility linked. Claim or register a facility first.'); return; }
  const next = !isAvailable;
  try {
    await api.biogas.setAvailability(token, { available: next });
    isAvailable = next;
    facility.is_available = next ? 1 : 0;
    updateAvailabilityUI();
    renderFacilityCard();
  } catch (e) { alert('Could not update availability: ' + e.message); }
};

// ── Overview ───────────────────────────────────────────────────────────────
async function loadOverview() {
  if (!facility) {
    $('ov-facility-card').innerHTML =
      `<div style="padding:1rem;background:#fff8e1;border-radius:8px;font-size:.875rem;color:#5d4037">
        <strong>No facility linked.</strong> Use <em>Claim Facility</em> to link your account to an existing record.
       </div>`;
    ['ov-pending-routes','ov-received-today','ov-capacity-remaining','ov-total-received']
      .forEach(id => setText(id, '—'));
    return;
  }
  try {
    const result = await api.biogas.getRoutes(token);
    // API returns { routes, todayIntakeKg }
    allRoutes     = Array.isArray(result) ? result : (result.routes || []);
    todayIntakeKg = result.todayIntakeKg ?? allRoutes
      .filter(r => r.status === 'received')
      .reduce((s, r) => s + (Number(r.quantity) || 0), 0);

    const pending   = allRoutes.filter(r => !r.status || r.status === 'pending').length;
    const totalRecv = allRoutes.filter(r => r.status === 'received').length;
    const max       = Number(facility.max_daily_intake_kg) || 0;
    const remaining = Math.max(0, max - todayIntakeKg);

    setText('ov-pending-routes',    pending);
    setText('ov-received-today',    `${Number(todayIntakeKg).toFixed(1)} kg`);
    setText('ov-capacity-remaining',`${remaining.toFixed(0)} kg`);
    setText('ov-total-received',    totalRecv);

    const badge = $('route-badge');
    if (badge) { badge.textContent = pending; badge.hidden = pending === 0; }
    const dot = $('topbar-alert-dot');
    if (dot) dot.hidden = pending === 0;

    renderFacilityCard();
    renderRouteItems('ov-routes-list', allRoutes.slice(0, 5), true);
  } catch (e) {
    console.error('[Biogas] Overview load failed', e);
  }
}

function renderFacilityCard() {
  const el = $('ov-facility-card'); if (!el || !facility) return;
  const wasteTypes = (() => { try { return JSON.parse(facility.accepted_waste_types || '[]'); } catch { return []; } })();
  const max       = Number(facility.max_daily_intake_kg) || 0;
  const remaining = Math.max(0, max - todayIntakeKg);
  el.innerHTML = `
    <div class="fb-detail-grid" style="padding:.8rem 1.2rem">
      <span class="fb-detail-label">Status</span>
      <span class="fb-detail-value">
        <span class="badge ${facility.status==='active'?'badge-matched':'badge-pending'}">${facility.status||'pending'}</span>
        ${isAvailable ? '<span class="badge badge-matched" style="margin-left:4px">Available</span>' : '<span class="badge badge-cancelled" style="margin-left:4px">Unavailable</span>'}
      </span>
      <span class="fb-detail-label">Max daily intake</span>
      <span class="fb-detail-value">${max ? `${max} ${facility.capacity_unit||'kg'}` : '—'}</span>
      <span class="fb-detail-label">Received today</span>
      <span class="fb-detail-value">${Number(todayIntakeKg).toFixed(1)} kg</span>
      <span class="fb-detail-label">Remaining capacity</span>
      <span class="fb-detail-value">${remaining.toFixed(0)} kg</span>
      <span class="fb-detail-label">Accepted waste types</span>
      <span class="fb-detail-value">${wasteTypes.length ? wasteTypes.join(', ') : '—'}</span>
      <span class="fb-detail-label">Operating hours</span>
      <span class="fb-detail-value">${esc(facility.operating_hours||'—')}</span>
      <span class="fb-detail-label">Address</span>
      <span class="fb-detail-value">${esc(facility.location_address||'—')}</span>
    </div>`;
}

// ── Routes ─────────────────────────────────────────────────────────────────
window.setRouteFilter = function (f, btn) {
  routeFilter = f;
  document.querySelectorAll('#page-routes .filter-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderRoutes();
};

window.filterRoutes = function () {
  routeSearch = ($('route-search')?.value || '').toLowerCase();
  renderRoutes();
};

function renderRoutes() {
  let items = allRoutes;
  if (routeFilter !== 'all') {
    if (routeFilter === 'pending') items = items.filter(r => !r.status || r.status === 'pending');
    else items = items.filter(r => r.status === routeFilter);
  }
  if (routeSearch) items = items.filter(r =>
    (r.food_name||'').toLowerCase().includes(routeSearch) ||
    (r.donor_name||'').toLowerCase().includes(routeSearch)
  );
  renderRouteItems('routes-list', items, false);
}

function renderRouteItems(containerId, items, compact) {
  const el = $(containerId); if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="empty-state">No routes found.</div>';
    return;
  }
  el.innerHTML = items.map(r => `
    <div class="match-card">
      <div class="match-head">
        <div class="match-name">${esc(r.food_name || 'Food waste route')}</div>
        ${statusBadge(r.status || 'pending')}
      </div>
      <div class="match-details">
        ${r.quantity ? `<span>${r.quantity} ${r.quantity_unit||'kg'}</span>` : ''}
        ${r.donor_name ? `<span>From: ${esc(r.donor_name)}</span>` : ''}
        ${r.route_distance_km ? `<span>${Number(r.route_distance_km).toFixed(1)} km</span>` : ''}
        ${r.weigh_in_kg ? `<span>Weighed: ${r.weigh_in_kg} kg</span>` : ''}
      </div>
      ${r.processing_notes ? `<div class="match-note">${esc(r.processing_notes)}</div>` : ''}
      ${compact ? '' : `<div class="match-actions">
        ${(!r.status || r.status==='pending') ? `
          <button class="btn btn-primary btn-sm" onclick="setRouteStatus('${r.id}','accepted')">Accept</button>
          <button class="btn btn-secondary btn-sm" onclick="setRouteStatus('${r.id}','rejected')">Reject</button>
        ` : ''}
        ${r.status==='accepted' ? `<button class="btn btn-primary btn-sm" onclick="openWeighIn('${r.id}')">Mark Received</button>` : ''}
      </div>`}
    </div>
  `).join('');
}

window.setRouteStatus = async function (id, status) {
  try {
    await api.biogas.updateRouteStatus(token, id, { status });
    const r = allRoutes.find(x => x.id === id);
    if (r) r.status = status;
    renderRoutes();
    renderRouteItems('ov-routes-list', allRoutes.slice(0, 5), true);
    if (facility) loadOverview();
  } catch (e) { alert('Could not update route: ' + e.message); }
};

// ── Weigh-in Modal ─────────────────────────────────────────────────────────
window.openWeighIn = function (routeId) {
  const r = allRoutes.find(x => x.id === routeId); if (!r) return;

  $('weighin-modal-body').innerHTML = `
    <div class="fb-detail-grid" style="margin-bottom:16px">
      <span class="fb-detail-label">Route</span><span class="fb-detail-value">${esc(r.food_name||'Food waste route')}</span>
      <span class="fb-detail-label">Donor</span><span class="fb-detail-value">${esc(r.donor_name||'—')}</span>
      <span class="fb-detail-label">Expected qty</span><span class="fb-detail-value">${r.quantity||'—'} ${r.quantity_unit||'kg'}</span>
    </div>
    <div id="weighin-msg" class="msg" style="display:none"></div>
    <div class="form-grid">
      <div class="form-group">
        <label for="wi-qty">Actual weight received (kg) <span style="color:var(--fb-error)">*</span></label>
        <input type="number" id="wi-qty" step="0.1" min="0" value="${r.quantity||''}" placeholder="e.g. 45.5" />
      </div>
      <div class="form-group full">
        <label for="wi-notes">Processing notes (optional)</label>
        <textarea id="wi-notes" rows="2" placeholder="e.g. Batch quality good, delivered by vendor truck"></textarea>
      </div>
    </div>`;

  $('weighin-modal-footer').innerHTML = `
    <button class="btn btn-ghost" onclick="closeWeighInModal()">Cancel</button>
    <button class="btn btn-primary" id="wi-confirm-btn" onclick="confirmWeighIn('${routeId}')">Confirm Receipt</button>`;

  const modal = $('weighin-modal');
  modal.classList.add('open'); modal.setAttribute('aria-hidden','false');
};

window.closeWeighInModal = function () {
  const modal = $('weighin-modal');
  modal.classList.remove('open'); modal.setAttribute('aria-hidden','true');
};

window.confirmWeighIn = async function (routeId) {
  const weighInKg = parseFloat($('wi-qty')?.value || 0);
  if (!weighInKg || weighInKg <= 0) {
    showMsg('weighin-msg', 'Enter the actual weight received.', 'error'); return;
  }
  const btn = $('wi-confirm-btn'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api.biogas.updateRouteStatus(token, routeId, {
      status:          'received',
      weighInKg,
      processingNotes: $('wi-notes')?.value || ''
    });
    const r = allRoutes.find(x => x.id === routeId);
    if (r) { r.status = 'received'; r.weigh_in_kg = weighInKg; }
    todayIntakeKg += weighInKg;
    closeWeighInModal();
    renderRoutes();
    renderFacilityCard();
    loadOverview();
  } catch (e) {
    showMsg('weighin-msg', e.message || 'Could not confirm receipt.', 'error');
    btn.disabled = false; btn.textContent = 'Confirm Receipt';
  }
};

// ── Capacity ───────────────────────────────────────────────────────────────
async function loadCapacity() {
  if (!facility) { showMsg('cap-msg','No facility linked to your account.','error'); return; }
  try {
    // Re-fetch routes to get accurate todayIntakeKg from the API
    const result  = await api.biogas.getRoutes(token);
    allRoutes     = Array.isArray(result) ? result : (result.routes || []);
    todayIntakeKg = result.todayIntakeKg ?? 0;
  } catch (e) {}

  const max       = Number(facility.max_daily_intake_kg) || 0;
  const remaining = Math.max(0, max - todayIntakeKg);
  setText('cap-max',       max ? `${max} ${facility.capacity_unit||'kg'}` : '—');
  setText('cap-today',     `${Number(todayIntakeKg).toFixed(1)} kg`);
  setText('cap-remaining', `${remaining.toFixed(0)} kg`);
  setVal('cap-max-input',  facility.max_daily_intake_kg || '');
  setVal('cap-unit-input', facility.capacity_unit || 'kg');
}

window.saveCapacity = async function () {
  showMsg('cap-msg','');
  const btn = $('save-cap-btn'); btn.disabled = true; btn.textContent = 'Saving…';
  const maxKg = parseFloat($('cap-max-input')?.value || 0);
  const unit  = $('cap-unit-input')?.value || 'kg';
  try {
    await api.biogas.updateCapacity(token, { maxDailyIntakeKg: maxKg, capacityUnit: unit });
    if (facility) { facility.max_daily_intake_kg = maxKg; facility.capacity_unit = unit; }
    showMsg('cap-msg', 'Capacity saved.', 'success');
    loadCapacity();
  } catch (e) {
    showMsg('cap-msg', e.message || 'Save failed.');
  } finally { btn.disabled = false; btn.textContent = 'Save capacity'; }
};

window.resetIntake = async function () {
  if (!confirm('Reset today\'s intake counter to 0? This will not change any received routes — only the running total for today.')) return;
  try {
    await api.biogas.resetIntake(token);
    todayIntakeKg = 0;
    if (facility) facility.current_intake_kg = 0;
    showMsg('cap-msg','Today\'s intake has been reset.','success');
    loadCapacity();
  } catch (e) { showMsg('cap-msg', e.message || 'Reset failed.'); }
};

// ── Waste Types ────────────────────────────────────────────────────────────
async function loadWasteTypes() {
  if (!facility) return;
  const types = (() => { try { return JSON.parse(facility.accepted_waste_types || '[]'); } catch { return []; } })();
  document.querySelectorAll('#wt-checkboxes input[type="checkbox"]').forEach(cb => {
    cb.checked = types.includes(cb.value);
  });
}

window.saveWasteTypes = async function () {
  showMsg('wt-msg','');
  const btn      = $('save-wt-btn'); btn.disabled = true; btn.textContent = 'Saving…';
  const selected = Array.from(document.querySelectorAll('#wt-checkboxes input[type="checkbox"]:checked')).map(cb => cb.value);
  if (!selected.length) { showMsg('wt-msg','Select at least one waste type.'); btn.disabled=false; btn.textContent='Save waste types'; return; }
  try {
    await api.biogas.updateFacility(token, { acceptedWasteTypes: selected });
    if (facility) facility.accepted_waste_types = JSON.stringify(selected);
    showMsg('wt-msg','Waste types saved.','success');
    renderFacilityCard();
  } catch (e) {
    showMsg('wt-msg', e.message || 'Save failed.');
  } finally { btn.disabled = false; btn.textContent = 'Save waste types'; }
};

// ── Alerts ─────────────────────────────────────────────────────────────────
async function loadAlerts() {
  try {
    const data  = await api.biogas.getAlerts(token);
    allAlerts   = Array.isArray(data) ? data : [];
    renderAlertItems();
  } catch (e) { console.warn('[Biogas] Alerts load failed', e); }
}

async function loadAlertsCount() {
  try {
    const data  = await api.biogas.getAlerts(token);
    allAlerts   = Array.isArray(data) ? data : [];
    const unread = allAlerts.filter(a => !a.is_read).length;
    const badge  = $('alert-badge');
    if (badge) { badge.textContent = unread; badge.hidden = unread === 0; }
    const dot = $('topbar-alert-dot');
    if (dot) dot.hidden = unread === 0;
  } catch (e) {}
}

function renderAlertItems() {
  const el = $('alerts-list'); if (!el) return;
  if (!allAlerts.length) {
    el.innerHTML = '<div class="alert-empty">No alerts yet.</div>';
    return;
  }
  el.innerHTML = allAlerts.map(a => `
    <div class="alert-item${a.is_read ? '' : ' alert-unread'}">
      <div class="alert-body">
        <div class="alert-title">${esc(a.title)}</div>
        <div class="alert-msg">${esc(a.message)}</div>
        <div class="alert-time">${fmtDate(a.created_at)}</div>
      </div>
      ${!a.is_read ? `<button class="btn btn-ghost btn-sm" onclick="markAlertRead('${a.id}')">Mark read</button>` : ''}
    </div>
  `).join('');
}

window.markAlertRead = async function (id) {
  try {
    await api.biogas.markAlertRead(token, id);
    const a = allAlerts.find(x => x.id === id); if (a) a.is_read = 1;
    renderAlertItems(); loadAlertsCount();
  } catch (e) {}
};

window.markAllAlertsRead = async function () {
  for (const a of allAlerts.filter(x => !x.is_read)) {
    try { await api.biogas.markAlertRead(token, a.id); a.is_read = 1; } catch (e) {}
  }
  renderAlertItems(); loadAlertsCount();
};

// ── Profile & Location ─────────────────────────────────────────────────────
async function loadProfile() {
  if (!facility) {
    showMsg('profile-msg', 'No facility linked. Use the Claim Facility page first.', 'error'); return;
  }
  setVal('p-name',    facility.name || '');
  setVal('p-address', facility.location_address || '');
  setVal('p-phone',   facility.contact_phone || '');
  setVal('p-email',   facility.contact_email || '');
  setVal('p-hours',   facility.operating_hours || '');
  setVal('p-notes',   facility.notes || '');
  setVal('p-lat',     facility.location_lat || '');
  setVal('p-lng',     facility.location_lng || '');

  const row = $('profile-status-row');
  if (row) {
    const status = facility.status || 'pending';
    row.innerHTML = `
      <span class="badge ${status==='active'?'badge-matched':'badge-pending'}">${status}</span>
      ${facility.verified
        ? '<span class="badge badge-matched">Verified</span>'
        : '<span class="badge badge-pending">Pending verification</span>'}
      ${status !== 'active' ? '<p class="form-help" style="margin:4px 0 0">Your facility will appear on the map and receive routes once active and verified.</p>' : ''}
    `;
  }

  const lat = parseFloat(facility.location_lat) || 0;
  const lng = parseFloat(facility.location_lng) || 0;
  // Defer map init until Leaflet has loaded
  setTimeout(() => initLocationMap(lat || 12.9716, lng || 77.5946), 50);
}

function initLocationMap(lat, lng) {
  if (typeof L === 'undefined') return;
  if (locationMap) {
    locationMap.setView([lat, lng], 14);
    if (locationMarker) locationMarker.setLatLng([lat, lng]);
    return;
  }
  locationMap   = L.map('location-map').setView([lat, lng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(locationMap);
  locationMarker = L.marker([lat, lng], { draggable: true }).addTo(locationMap);

  function updateCoords(latlng) {
    setVal('p-lat', latlng.lat.toFixed(6));
    setVal('p-lng', latlng.lng.toFixed(6));
  }
  locationMarker.on('dragend', e => updateCoords(e.target.getLatLng()));
  locationMap.on('click', e => {
    locationMarker.setLatLng(e.latlng);
    updateCoords(e.latlng);
  });
}

window.saveProfile = async function () {
  showMsg('profile-msg','');
  if (!facility) { showMsg('profile-msg','No facility linked.','error'); return; }
  const btn = $('save-profile-btn'); btn.disabled = true; btn.textContent = 'Saving…';
  const lat = parseFloat($('p-lat')?.value);
  const lng = parseFloat($('p-lng')?.value);
  try {
    await api.biogas.updateFacility(token, {
      name:            ($('p-name')?.value||'').trim()    || undefined,
      locationAddress: ($('p-address')?.value||'').trim() || undefined,
      contactPhone:    ($('p-phone')?.value||'').trim()   || undefined,
      contactEmail:    ($('p-email')?.value||'').trim()   || undefined,
      operatingHours:  ($('p-hours')?.value||'').trim()   || undefined,
      notes:           ($('p-notes')?.value||'').trim()   || undefined,
      locationLat:     isNaN(lat) ? undefined : lat,
      locationLng:     isNaN(lng) ? undefined : lng
    });
    facility = await api.biogas.getFacility(token);
    setText('sidebar-org-name', facility.name || 'My Facility');
    if (!isNaN(lat) && !isNaN(lng) && locationMarker) {
      locationMarker.setLatLng([lat, lng]);
      locationMap?.setView([lat, lng]);
    }
    showMsg('profile-msg','Profile saved.','success');
  } catch (e) {
    showMsg('profile-msg', e.message || 'Save failed.');
  } finally { btn.disabled = false; btn.textContent = 'Save profile'; }
};

// ── Claim Facility ─────────────────────────────────────────────────────────
async function loadClaim() {
  const el = $('claim-list');
  showMsg('claim-msg','');
  if (!el) return;

  if (facility) {
    el.innerHTML = '<div class="empty-state">Your account is already linked to a facility. Manage it in Profile &amp; Location.</div>';
    return;
  }

  try {
    const unowned = await api.biogas.getUnowned(token);
    if (!unowned.length) {
      el.innerHTML = '<div class="empty-state">No unclaimed facilities found. Your new facility was created on registration.</div>';
      return;
    }
    el.innerHTML = unowned.map(f => `
      <div class="match-card">
        <div class="match-head">
          <div class="match-name">${esc(f.name)}</div>
          <span class="badge badge-pending">Unclaimed</span>
        </div>
        <div class="match-details">
          <span>${esc(f.location_address||'—')}</span>
          ${f.max_daily_intake_kg ? `<span>Max: ${f.max_daily_intake_kg} kg/day</span>` : ''}
        </div>
        <div class="match-actions">
          <button class="btn btn-primary btn-sm" onclick="claimFacility('${f.id}')">Claim this facility</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    showMsg('claim-msg', 'Could not load facilities: ' + e.message);
  }
}

window.claimFacility = async function (id) {
  showMsg('claim-msg','');
  if (!confirm('Claim this facility? Your operator account will be linked to it.')) return;
  try {
    await api.biogas.claimFacility(token, id);
    showMsg('claim-msg','Facility claimed! Refreshing…','success');
    facility   = await api.biogas.getFacility(token);
    isAvailable = !!facility.is_available;
    updateAvailabilityUI();
    setText('sidebar-org-name', facility.name || 'My Facility');
    setTimeout(() => loadClaim(), 1200);
  } catch (e) {
    showMsg('claim-msg', e.message || 'Could not claim facility.');
  }
};

// ── Boot ────────────────────────────────────────────────────────────────────
init();
