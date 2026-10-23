/**
 * FoodBridge — Food Bank Dashboard JS
 * Uses /api/demand-org/* endpoints (food_bank role shares demand_org API).
 */
import api from './api.js';

// ── Auth guard ───────────────────────────────────────────────────────────────
const token = localStorage.getItem('fb_token');
const user  = JSON.parse(localStorage.getItem('fb_user') || 'null');
if (!token || !user || user.role !== 'food_bank') {
  window.location.href = '/food-bank/index.html';
  throw new Error('Food bank authentication required');
}

// ── State ────────────────────────────────────────────────────────────────────
let allMatches   = [];
let allInventory = [];
let allAlerts    = [];
let allDemands   = [];
let matchFilter  = 'all';
let matchSearch  = '';
let invFilter    = 'all';
let invSearch    = '';
let org          = null;
let locationMap  = null;
let locationMarker = null;
let miniMap      = null;

// ── Page map ─────────────────────────────────────────────────────────────────
const PAGE_MAP = {
  overview: 'page-overview', matches: 'page-matches', requests: 'page-requests',
  inventory: 'page-inventory', capacity: 'page-capacity',
  alerts: 'page-alerts', profile: 'page-profile'
};

window.showPage = function (page) {
  Object.values(PAGE_MAP).forEach(id => document.getElementById(id)?.classList.remove('active'));
  document.getElementById(PAGE_MAP[page])?.classList.add('active');
  Object.keys(PAGE_MAP).forEach(k => {
    const n = document.getElementById(`nav-${k}`);
    n?.classList.toggle('active', k === page);
    n?.toggleAttribute('aria-current', k === page);
  });
  setText('topbar-title', {
    overview:'Overview', matches:'Incoming Matches', requests:'Food Requests',
    inventory:'Inventory', capacity:'Capacity', alerts:'Alerts', profile:'Profile & Location'
  }[page] || page);
  _loadPage(page);
};

function _loadPage(page) {
  if (page === 'overview')  loadOverview();
  if (page === 'matches')   renderMatches();
  if (page === 'requests')  loadDemands();
  if (page === 'inventory') renderInventory();
  if (page === 'capacity')  loadCapacity();
  if (page === 'alerts')    loadAlerts();
  if (page === 'profile')   loadProfile();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setText(id, v) { const e = $(id); if (e) e.textContent = v ?? ''; }
function setVal(id, v)  { const e = $(id); if (e) e.value = v ?? ''; }
function showMsg(id, txt, type) {
  const e = $(id); if (!e) return;
  e.textContent = txt; e.className = `msg${type === 'success' ? ' success' : type === 'info' ? ' info' : ''}`;
  e.style.display = txt ? '' : 'none';
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function fmtDateShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
}
function indiaDateInputValue(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value).slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function statusBadge(s) {
  const cls = {
    open:'badge-open', matched:'badge-matched', pending:'badge-pending',
    confirmed:'badge-matched', completed:'badge-completed badge-success',
    fulfilled:'badge-fulfilled badge-success', cancelled:'badge-cancelled badge-danger',
    declined:'badge-declined badge-danger'
  };
  return `<span class="badge ${cls[s]||'badge-neutral'}">${esc(s||'—').replace(/_/g,' ')}</span>`;
}
function isExpiringSoon(dateStr) {
  if (!dateStr) return false;
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))
    ? new Date(`${dateStr}T23:59:59.999+05:30`)
    : new Date(dateStr);
  const diff = expiry - new Date();
  return diff >= 0 && diff < 3 * 86400000;
}
function isExpired(dateStr) {
  if (!dateStr) return false;
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))
    ? new Date(`${dateStr}T23:59:59.999+05:30`)
    : new Date(dateStr);
  return expiry < new Date();
}

window.signOut = function () {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.href = '/';
};

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const initials = (user.name || 'FB').split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
  setText('user-chip', user.name || user.email);
  setText('account-name', user.name || '');
  setText('account-email', user.email || '');
  ['account-avatar','account-menu-avatar'].forEach(id => setText(id, initials));

  try {
    const me = await api.auth.me(token);
    org = me.org;
    if (org) {
      const av = (org.name||'FB').split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
      setText('sidebar-avatar', av);
      setText('sidebar-org-name', org.name || 'Food Bank');
      const st = org.status === 'active' ? 'Active' : 'Pending verification';
      setText('sidebar-org-status', st);
      setText('welcome-name', org.name || user.name || 'Food Bank');
    }
  } catch(e) { console.warn('[FoodBank] me failed', e); }

  loadOverview();
  loadAlertsCount();
}

// ── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const [matchData, outboundData, statsData] = await Promise.all([
      api.foodBank.getMatches(token),
      api.foodBank.getInventoryMatches(token),
      api.foodBank.getInventoryStats(token)
    ]);
    const incoming = Array.isArray(matchData) ? matchData : (matchData.matches || []);
    const outgoing = Array.isArray(outboundData) ? outboundData : (outboundData.matches || []);
    allMatches = [...incoming, ...outgoing].sort((a,b) => new Date(b.matched_at || 0) - new Date(a.matched_at || 0));

    const pending   = incoming.filter(m => m.status === 'pending').length;
    const thisMonth = allMatches.filter(m => m.status === 'completed' && m.completed_at &&
      new Date(m.completed_at).getMonth() === new Date().getMonth()).length;

    setText('ov-pending', pending);
    setText('ov-received', thisMonth);
    setText('ov-stock-items', statsData.totalItems ?? 0);
    setText('ov-stock-kg', formatAvailableStock(statsData.availableInventory));
    setText('ov-expiring', statsData.expiringSoon?.length ?? 0);

    const badge = $('match-badge');
    if (badge) { badge.textContent = pending; badge.hidden = pending === 0; }
    const dot = $('topbar-alert-dot');
    if (dot) dot.hidden = pending === 0;

    renderMatchItems('ov-matches-list', allMatches.slice(0,5), true);

    // Inventory snapshot — sort by expiry, show top 5
    const invData = await api.foodBank.getInventory(token);
    allInventory = Array.isArray(invData) ? invData : [];
    const sorted = [...allInventory].filter(i => (i.quantity_remaining||0) > 0)
      .sort((a,b) => (a.expiry_date||'9') < (b.expiry_date||'9') ? -1 : 1)
      .slice(0,5);
    renderInvItems('ov-inventory-list', sorted, true);
  } catch(e) { console.error('[FoodBank] Overview error', e); }
}

// ── Matches ───────────────────────────────────────────────────────────────────
window.setMatchFilter = function(f, btn) {
  matchFilter = f;
  document.querySelectorAll('#page-matches .filter-chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderMatches();
};
window.filterMatches = function() {
  matchSearch = ($('match-search')?.value||'').toLowerCase();
  renderMatches();
};

function renderMatches() {
  let items = allMatches;
  if (matchFilter !== 'all') items = items.filter(m => m.status === matchFilter);
  if (matchSearch) items = items.filter(m =>
    (m.food_name||m.foodName||'').toLowerCase().includes(matchSearch) ||
    (m.donor_name||m.donorName||m.recipient_name||'').toLowerCase().includes(matchSearch)
  );
  renderMatchItems('matches-list', items, false);
}

function renderMatchItems(containerId, items, compact) {
  const el = $(containerId); if (!el) return;
  if (!items.length) {
    el.innerHTML = `<div class="empty-state"><span class="empty-icon"><svg class="icon" aria-hidden="true"><use href="#i-truck"></use></svg></span><p>No matches found.</p></div>`;
    return;
  }
  el.innerHTML = items.map(m => {
    const foodName = m.food_name || m.foodName || 'Food match';
    const partner  = m.direction === 'outgoing' ? (m.recipient_name || 'Recipient organization') : (m.donor_name || m.donorName || '');
    const qty      = m.allocated_quantity ?? m.quantity ?? '';
    const unit     = m.allocated_unit || m.unit || 'kg';
    const dist     = m.route_distance_km ? `${Number(m.route_distance_km).toFixed(1)} km` : '';
    return `<div class="match-card">
      <div class="match-head">
        <div class="match-name">${esc(foodName)}</div>
        ${statusBadge(m.status)}
      </div>
      <div class="match-details">
        ${qty ? `<span>${qty} ${unit}</span>` : ''}
        ${partner ? `<span>${m.direction === 'outgoing' ? 'To' : 'From'}: ${esc(partner)}</span>` : ''}
        ${dist ? `<span>${dist}</span>` : ''}
        ${m.match_score!=null ? `<span>Score: ${m.match_score}</span>` : ''}
      </div>
      ${m.explanation||m.notes ? `<div class="match-note">${esc(m.explanation||m.notes)}</div>` : ''}
      ${compact || m.direction === 'outgoing' ? '' : `<div class="match-actions">
        ${m.status==='pending' ? `
          <button class="btn btn-primary btn-sm" onclick="acceptMatch('${m.id}')">Accept</button>
          <button class="btn btn-secondary btn-sm" onclick="declineMatch('${m.id}')">Decline</button>
        ` : ''}
        ${m.status==='confirmed' ? `<button class="btn btn-primary btn-sm" onclick="openReceiptModal('${m.id}')">Confirm Receipt</button>` : ''}
        ${m.status==='completed' ? `<button class="btn btn-ghost btn-sm" onclick="openReceiptModal('${m.id}')">View Receipt</button>` : ''}
      </div>`}
    </div>`;
  }).join('');
}

window.acceptMatch = async function(id) {
  try {
    await api.foodBank.acceptMatch(token, id);
    const m = allMatches.find(x=>x.id===id); if(m) m.status='confirmed';
    renderMatches(); loadOverview();
  } catch(e) { alert('Could not accept: '+e.message); }
};
window.declineMatch = async function(id) {
  if (!confirm('Decline this match?')) return;
  try {
    await api.foodBank.declineMatch(token, id);
    const m = allMatches.find(x=>x.id===id); if(m) m.status='declined';
    renderMatches(); loadOverview();
  } catch(e) { alert('Could not decline: '+e.message); }
};

// ── Receipt Confirmation Modal ────────────────────────────────────────────────
window.openReceiptModal = function(matchId) {
  const m = allMatches.find(x=>x.id===matchId); if(!m) return;
  const foodName = m.food_name || m.foodName || 'Food match';
  const qty      = m.allocated_quantity ?? m.quantity ?? '';
  const unit     = m.allocated_unit || m.unit || 'kg';
  const expiryDate = indiaDateInputValue(m.inventory_expiry_date || m.remaining_usable_time || m.availableUntil);
  const isComplete = m.status === 'completed';

  $('receipt-modal-body').innerHTML = `
    <div class="fb-detail-grid" style="margin-bottom:16px">
      <span class="fb-detail-label">Food</span><span class="fb-detail-value">${esc(foodName)}</span>
      <span class="fb-detail-label">Expected qty</span><span class="fb-detail-value">${qty} ${unit}</span>
      <span class="fb-detail-label">Status</span><span class="fb-detail-value">${statusBadge(m.status)}</span>
    </div>
    ${isComplete ? '<p class="form-help">This match has already been confirmed.</p>' : `
    <div id="receipt-form-msg" class="msg" style="display:none"></div>
    <div class="form-grid">
      <div class="form-group">
        <label for="rc-qty">Quantity received <span class="req">*</span></label>
        <input type="number" id="rc-qty" step="0.1" value="${qty}" />
      </div>
      <div class="form-group">
        <label for="rc-unit">Unit</label>
        <select id="rc-unit">
          <option value="kg"${unit==='kg'?' selected':''}>kg</option>
          <option value="servings"${unit==='servings'?' selected':''}>servings</option>
          <option value="liters"${unit==='liters'?' selected':''}>liters</option>
          <option value="boxes">boxes</option>
        </select>
      </div>
      <div class="form-group full">
        <label><input type="checkbox" id="rc-discrepancy" onchange="toggleDiscrepancy()"> Quantity discrepancy noted</label>
      </div>
      <div class="form-group full" id="rc-discrepancy-notes-row" style="display:none">
        <label for="rc-discrepancy-notes">Describe discrepancy</label>
        <textarea id="rc-discrepancy-notes" rows="2" placeholder="e.g. Received 40 kg instead of 50 kg — packaging damaged"></textarea>
      </div>
      <div class="form-group full">
        <label><input type="checkbox" id="rc-condition-bad" onchange="toggleCondition()"> Condition issue noted</label>
      </div>
      <div class="form-group full" id="rc-condition-notes-row" style="display:none">
        <label for="rc-condition-notes">Describe condition issue</label>
        <textarea id="rc-condition-notes" rows="2" placeholder="e.g. Packaging torn, slight temperature deviation"></textarea>
      </div>
      <div id="rc-inv-fields">
        <div class="form-grid" style="margin-top:8px">
          <div class="form-group"><label>Source expiry</label><input type="date" value="${esc(expiryDate)}" disabled /><small class="form-help">The simulation adds 3 hours to this expiry when receipt is confirmed.</small></div>
          <div class="form-group"><label for="rc-location">Storage location</label><input type="text" id="rc-location" placeholder="e.g. Cold room 1" /></div>
        </div>
        <p class="form-help">Confirming receipt automatically records the received quantity and adjusted expiry in your inventory.</p>
      </div>
    </div>`}
  `;
  $('receipt-modal-footer').innerHTML = isComplete
    ? `<button class="btn btn-ghost" onclick="closeReceiptModal()">Close</button>`
    : `<button class="btn btn-ghost" onclick="closeReceiptModal()">Cancel</button>
       <button class="btn btn-primary" id="rc-confirm-btn" onclick="confirmReceipt('${matchId}')">Confirm Receipt</button>`;

  const modal = $('receipt-modal');
  modal.classList.add('open'); modal.setAttribute('aria-hidden','false');
};

window.toggleDiscrepancy = function() {
  $('rc-discrepancy-notes-row').style.display = $('rc-discrepancy')?.checked ? '' : 'none';
};
window.toggleCondition = function() {
  $('rc-condition-notes-row').style.display = $('rc-condition-bad')?.checked ? '' : 'none';
};

window.confirmReceipt = async function(matchId) {
  const btn = $('rc-confirm-btn'); if(btn) { btn.disabled=true; btn.textContent='Saving…'; }
  const m = allMatches.find(x=>x.id===matchId);
  const foodName = m?.food_name || m?.foodName || 'Food';
  const foodType = m?.food_type || m?.foodType || '';
  try {
    await api.foodBank.confirmReceipt(token, matchId, {
      quantityConfirmed: parseFloat($('rc-qty')?.value||0),
      quantityUnit:      $('rc-unit')?.value || 'kg',
      discrepancyNoted:  !!$('rc-discrepancy')?.checked,
      discrepancyNotes:  $('rc-discrepancy-notes')?.value || '',
      conditionOk:       !$('rc-condition-bad')?.checked,
      conditionNotes:    $('rc-condition-notes')?.value || '',
      addToInventory:    true,
      foodName, foodType,
      expiryDate:        m?.inventory_expiry_date || m?.remaining_usable_time || null,
      storageLocation:   $('rc-location')?.value || ''
    });
    if(m) m.status = 'completed';
    closeReceiptModal();
    loadOverview();
    renderMatches();
  } catch(e) {
    showMsg('receipt-form-msg', e.message || 'Could not confirm receipt.', 'error');
    if(btn) { btn.disabled=false; btn.textContent='Confirm Receipt'; }
  }
};

window.closeReceiptModal = function() {
  const modal = $('receipt-modal');
  modal.classList.remove('open'); modal.setAttribute('aria-hidden','true');
};

// ── Demands / Requests ────────────────────────────────────────────────────────
async function loadDemands() {
  try {
    const data = await api.foodBank.getDemands(token);
    allDemands = Array.isArray(data) ? data : (data.demands || []);
    renderDemandList();
  } catch(e) { console.warn('[FoodBank] Demands load failed', e); }
}

function renderDemandList() {
  const el = $('demands-list'); if(!el) return;
  const open = allDemands.filter(d => d.status==='open' || d.status==='matched');
  if (!open.length) { el.innerHTML='<div class="empty-state"><p>No open requests.</p></div>'; return; }
  el.innerHTML = open.map(d => `
    <div class="demand-item">
      <div class="demand-main">
        <div class="demand-name">${esc(d.food_requirement)}</div>
        <div class="demand-meta">
          <span>${d.quantity_needed} ${d.quantity_unit||'kg'}</span>
          <span>${statusBadge(d.status)}</span>
          ${d.required_by ? `<span>By ${fmtDate(d.required_by)}</span>` : ''}
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="cancelDemand('${d.id}')">Cancel</button>
    </div>
  `).join('');
}

window.cancelDemand = async function(id) {
  if (!confirm('Cancel this request?')) return;
  try {
    await api.foodBank.cancelDemand(token, id);
    allDemands = allDemands.filter(d=>d.id!==id);
    renderDemandList();
  } catch(e) { alert('Could not cancel: '+e.message); }
};

window.submitDemand = async function() {
  showMsg('demand-msg','');
  const btn = $('submit-demand-btn'); btn.disabled=true; btn.textContent='Submitting…';
  const req = ($('d-food-type')?.value||'').trim();
  const qty = parseFloat($('d-quantity')?.value||0);
  if (!req || !qty) { showMsg('demand-msg','Food type and quantity are required.','error'); btn.disabled=false; btn.textContent='Submit request'; return; }
  const dietary = ($('d-dietary')?.value||'').trim();
  try {
    await api.foodBank.postDemand(token, {
      foodRequirement: req,
      quantityNeeded:  qty,
      quantityUnit:    $('d-unit')?.value || 'kg',
      requiredBy:      $('d-needed-by')?.value ? new Date($('d-needed-by').value).toISOString() : null,
      urgency:         $('d-urgency')?.value || 'regular',
      dietaryRequirements: dietary ? dietary.split(',').map(s=>s.trim()).filter(Boolean) : [],
      specialInstructions: $('d-notes')?.value || ''
    });
    showMsg('demand-msg','Request submitted. The network will match available surplus.','success');
    ['d-quantity','d-needed-by','d-dietary','d-notes'].forEach(id => setVal(id,''));
    const fresh = await api.foodBank.getDemands(token);
    allDemands = Array.isArray(fresh) ? fresh : (fresh.demands || []);
    renderDemandList();
  } catch(e) { showMsg('demand-msg', e.message||'Submission failed.','error'); }
  finally { btn.disabled=false; btn.textContent='Submit request'; }
};

// ── Inventory ─────────────────────────────────────────────────────────────────
window.setInvFilter = function(f, btn) {
  invFilter = f;
  document.querySelectorAll('#page-inventory .filter-chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderInventory();
};
window.filterInventory = function() {
  invSearch = ($('inv-search')?.value||'').toLowerCase();
  renderInventory();
};

async function renderInventory() {
  try {
    const data = await api.foodBank.getInventory(token);
    allInventory = Array.isArray(data) ? data : [];
  } catch(e) {}
  let items = allInventory.filter(i => Number(i.quantity_remaining || 0) > 0);
  if (invFilter === 'expiring') items = items.filter(i => isExpiringSoon(i.expiry_date) && !isExpired(i.expiry_date));
  if (invSearch) items = items.filter(i => (i.food_name||'').toLowerCase().includes(invSearch));
  renderInvItems('inventory-list', items, false);
}

function renderInvItems(containerId, items, compact) {
  const el = $(containerId); if(!el) return;
  if (!items.length) {
    el.innerHTML='<div class="empty-state"><span class="empty-icon"><svg class="icon" aria-hidden="true"><use href="#i-box"></use></svg></span><p>No inventory items found.</p></div>';
    return;
  }
  el.innerHTML = items.map(item => {
    const expired  = isExpired(item.expiry_date);
    const expiring = isExpiringSoon(item.expiry_date);
    const pct      = item.quantity_received ? Math.min(100, Math.round(((item.quantity_remaining||0)/item.quantity_received)*100)) : 0;
    const biogasStatus = {
      pending: 'Biogas request pending', accepted: 'Accepted by biogas centre',
      received: 'Received by biogas centre', review_required: 'Biogas routing needs review'
    }[item.biogas_status];
    return `<div class="demand-item${expired?' inv-expired':expiring?' inv-expiring':''}">
      <div class="demand-main">
        <div class="demand-name">${esc(item.food_name)}
          ${expired ? '<span class="badge badge-danger" style="margin-left:6px">Expired</span>' : ''}
          ${expiring && !expired ? '<span class="badge badge-warning" style="margin-left:6px">Expiring soon</span>' : ''}
          ${biogasStatus ? `<span class="badge badge-neutral" style="margin-left:6px">${esc(biogasStatus)}</span>` : ''}
        </div>
        <div class="demand-meta">
          <span>${item.quantity_remaining??item.quantity_received} / ${item.quantity_received} ${item.quantity_unit||'kg'} remaining (${pct}%)</span>
          ${item.expiry_date ? `<span>Expires ${fmtDate(item.expiry_date)}</span>` : ''}
          ${item.storage_location ? `<span>${esc(item.storage_location)}</span>` : ''}
          ${item.biogas_reason ? `<span>${esc(item.biogas_reason)}</span>` : ''}
          <span>Received ${fmtDateShort(item.received_at)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function formatAvailableStock(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'No available stock';
  const parts = rows.map(row => {
    const quantity = Number(row.quantity || 0);
    const amount = Number.isInteger(quantity) ? quantity : quantity.toFixed(1);
    return `${amount} ${row.unit || 'units'}`;
  });
  return `${parts.join(' · ')} available`;
}

// ── Capacity ──────────────────────────────────────────────────────────────────
async function loadCapacity() {
  try {
    const [profData, statsData] = await Promise.all([
      api.foodBank.getProfile(token),
      api.foodBank.getInventoryStats(token)
    ]);
    const p = profData.org || profData;
    setVal('cap-serving',  p.serving_capacity||'');
    setVal('cap-recv-kg',  p.receiving_capacity_kg||'');
    setVal('cap-storage',  p.storage_capacity||'');
    setText('cap-display-serving', p.serving_capacity ? `${p.serving_capacity} meals/day` : '—');
    setText('cap-display-recv',    p.receiving_capacity_kg ? `${p.receiving_capacity_kg} kg/day` : '—');
    setText('cap-display-storage', p.storage_capacity || '—');
    setText('cap-display-stock',   statsData.totalItems ?? '—');
    setText('cap-display-kg',      `${Number(statsData.totalKgStored||0).toFixed(1)} kg`);
  } catch(e) { console.warn('[FoodBank] Capacity load failed', e); }
}

window.saveCapacity = async function() {
  showMsg('cap-msg','');
  const btn = $('save-cap-btn'); btn.disabled=true; btn.textContent='Saving…';
  try {
    await api.foodBank.updateCapacity(token, {
      servingCapacity:     parseInt($('cap-serving')?.value||0) || undefined,
      storageCapacity:     $('cap-storage')?.value || undefined,
      receivingCapacityKg: parseFloat($('cap-recv-kg')?.value||0) || undefined
    });
    showMsg('cap-msg','Settings saved.','success');
    await loadCapacity();
  } catch(e) { showMsg('cap-msg', e.message||'Save failed.','error'); }
  finally { btn.disabled=false; btn.textContent='Save settings'; }
};

// ── Alerts ────────────────────────────────────────────────────────────────────
async function loadAlerts() {
  try {
    const data = await api.foodBank.getAlerts(token);
    allAlerts = Array.isArray(data) ? data : (data.alerts||[]);
    renderAlerts();
  } catch(e) {}
}
async function loadAlertsCount() {
  try {
    const data = await api.foodBank.getAlerts(token);
    allAlerts = Array.isArray(data) ? data : (data.alerts||[]);
    const unread = allAlerts.filter(a=>!a.is_read).length;
    const badge = $('alert-badge');
    if (badge) { badge.textContent=unread; badge.hidden=unread===0; }
    const dot = $('topbar-alert-dot');
    if (dot) dot.hidden = unread === 0;
  } catch(e) {}
}
function renderAlerts() {
  const el = $('alerts-list'); if (!el) return;
  if (!allAlerts.length) { el.innerHTML='<div class="empty-state"><span class="empty-icon"><svg class="icon" aria-hidden="true"><use href="#i-bell"></use></svg></span><p>No alerts yet.</p></div>'; return; }
  el.innerHTML = allAlerts.map(a => `
    <div class="alert-item${a.is_read?'':' alert-unread'}">
      <div class="alert-body">
        <div class="alert-title">${esc(a.title)}</div>
        <div class="alert-msg">${esc(a.message)}</div>
        <div class="alert-time">${fmtDate(a.created_at)}</div>
      </div>
      ${!a.is_read ? `<button class="btn btn-ghost btn-sm" onclick="markRead('${a.id}')">Mark read</button>` : ''}
    </div>
  `).join('');
}
window.markRead = async function(id) {
  try { await api.foodBank.markAlertRead(token, id); const a=allAlerts.find(x=>x.id===id); if(a) a.is_read=1; renderAlerts(); loadAlertsCount(); } catch(e){}
};
window.markAllRead = async function() {
  try { await api.foodBank.markAllRead(token); allAlerts.forEach(a=>a.is_read=1); renderAlerts(); loadAlertsCount(); } catch(e){}
};

// ── Profile & Location ────────────────────────────────────────────────────────
async function loadProfile() {
  try {
    const data = await api.auth.me(token);
    const o = data.org;
    if (!o) { showMsg('profile-msg','Organisation profile not found. Please contact support.','error'); return; }
    org = o;
    setVal('p-name',    o.name||'');
    setVal('p-address', o.location_address||'');
    setVal('p-phone',   o.contact_phone||'');
    setVal('p-hours',   o.operating_hours||'');
    setVal('p-desc',    o.description||'');
    setVal('p-lat',     o.location_lat||'');
    setVal('p-lng',     o.location_lng||'');

    const row = $('profile-status-row');
    if (row) {
      row.innerHTML = `
        <span class="badge badge-${o.status==='active'?'success':'warning'}">${o.status||'pending'}</span>
        ${o.verified ? '<span class="badge badge-success">Verified</span>' : '<span class="badge badge-warning">Pending verification</span>'}
        ${o.status!=='active' ? '<p class="form-help" style="margin:4px 0 0">Your food bank will appear on the map once approved and active.</p>' : ''}
      `;
    }

    const lat = parseFloat(o.location_lat)||0;
    const lng = parseFloat(o.location_lng)||0;
    initLocationMap(lat||12.9716, lng||77.5946);
    initMiniMap(lat||12.9716, lng||77.5946);
  } catch(e) { showMsg('profile-msg','Could not load profile.','error'); }
}

function initLocationMap(lat, lng) {
  if (locationMap) { locationMap.setView([lat, lng], 14); if(locationMarker) locationMarker.setLatLng([lat,lng]); return; }
  locationMap = L.map('location-map').setView([lat, lng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap contributors'}).addTo(locationMap);
  locationMarker = L.marker([lat, lng], {draggable: true}).addTo(locationMap);
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

function initMiniMap(lat, lng) {
  if (!lat || !lng) return;
  const el = $('profile-mini-map'); if (!el) return;
  if (miniMap) { miniMap.setView([lat, lng], 14); return; }
  miniMap = L.map('profile-mini-map', {zoomControl:false, interactive:false}).setView([lat, lng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(miniMap);
  L.marker([lat, lng]).addTo(miniMap);
}

window.saveProfile = async function() {
  showMsg('profile-msg','');
  const btn = $('save-profile-btn'); btn.disabled=true; btn.textContent='Saving…';
  const lat = parseFloat($('p-lat')?.value);
  const lng = parseFloat($('p-lng')?.value);
  try {
    await api.foodBank.updateProfile(token, {
      name:           $('p-name')?.value?.trim() || undefined,
      locationAddress:$('p-address')?.value?.trim() || undefined,
      contactPhone:   $('p-phone')?.value?.trim() || undefined,
      operatingHours: $('p-hours')?.value?.trim() || undefined,
      description:    $('p-desc')?.value?.trim() || undefined,
      locationLat:    isNaN(lat) ? undefined : lat,
      locationLng:    isNaN(lng) ? undefined : lng
    });
    showMsg('profile-msg','Profile saved.','success');
    if (!isNaN(lat) && !isNaN(lng)) {
      if (locationMarker) locationMarker.setLatLng([lat, lng]);
      if (locationMap) locationMap.setView([lat, lng]);
      initMiniMap(lat, lng);
    }
  } catch(e) { showMsg('profile-msg', e.message||'Save failed.','error'); }
  finally { btn.disabled=false; btn.textContent='Save profile'; }
};

// ── Boot ─────────────────────────────────────────────────────────────────────
init();
