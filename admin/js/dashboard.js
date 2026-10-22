/**
 * FoodBridge — Admin & Verification Dashboard JS
 * Sections: Overview, Verification Queue, All Participants,
 *           Safety Review, Disputes, Compliance Records
 */

const API_BASE = 'http://localhost:3000/api';
const token    = localStorage.getItem('fb_token');
const user     = JSON.parse(localStorage.getItem('fb_user') || 'null');

if (!token || !user || user.role !== 'admin') {
  window.location.href = '/admin/index.html';
}

// ── State ───────────────────────────────────────────────────
let allOrgs           = [];
let allSafetyFlags    = [];
let allDisputes       = [];
let allRecords        = [];
let vFilterVal        = 'all';
let pFilterVal        = 'all';
let sFilterVal        = 'all';
let dFilterVal        = 'all';
let pendingAction     = null;

// ── Page Router ─────────────────────────────────────────────
const pageTitles = {
  'overview':      ['Overview',              'Platform administration at a glance'],
  'verification':  ['Org Verification',      'Review and approve pending registrations'],
  'participants':  ['All Participants',      'Manage every org on the platform'],
  'safety':        ['Safety & Trust Review', 'Flagged cases and safety incidents'],
  'disputes':      ['Dispute Resolution',    'Complaints, handover failures, and conflicts'],
  'records':       ['Compliance Records',    'Full audit trail of admin actions'],
};

window.showPage = function(page) {
  document.querySelectorAll('.page-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.getElementById(`nav-${page}`)?.classList.add('active');
  const [title, sub] = pageTitles[page] || [page, ''];
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-sub').textContent   = sub;
  loadPageData(page);
};

async function loadPageData(page) {
  switch (page) {
    case 'overview':      await loadOverview();      break;
    case 'verification':  await loadVerification();  break;
    case 'participants':  await loadParticipants();  break;
    case 'safety':        await loadSafety();        break;
    case 'disputes':      await loadDisputes();      break;
    case 'records':       await loadRecords();       break;
  }
}

window.refreshPage = function() {
  const active = document.querySelector('.page-content.active')?.id?.replace('page-', '');
  if (active) loadPageData(active);
};

// ── Init ─────────────────────────────────────────────────────
async function init() {
  const name     = user?.name || 'Admin';
  const initials = name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  document.getElementById('sidebar-avatar').textContent = initials;
  document.getElementById('sidebar-name').textContent   = name;
  await loadOverview();
  await loadBadges();
}

// ── API ───────────────────────────────────────────────────────
async function apiFetch(endpoint, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(API_BASE + endpoint, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// ── OVERVIEW ────────────────────────────────────────────────
async function loadOverview() {
  let stats, pendingOrgs, flags, records;
  try {
    const d  = await apiFetch('/admin/overview');
    stats    = d;
    pendingOrgs = d.recentPending || [];
    flags    = d.recentFlags    || [];
    records  = d.recentActions  || [];
  } catch {
    stats    = demoStats();
    pendingOrgs = demoOrgs().filter(o => o.status === 'pending').slice(0, 3);
    flags    = demoFlags().slice(0, 3);
    records  = demoRecords().slice(0, 5);
  }

  setText('ov-pending',   stats.pendingCount   ?? '—');
  setText('ov-verified',  stats.verifiedCount  ?? '—');
  setText('ov-flagged',   stats.flaggedCount   ?? '—');
  setText('ov-disputes',  stats.disputeCount   ?? '—');
  setText('ov-suspended', stats.suspendedCount ?? '—');
  setText('ov-actions',   stats.actionsToday   ?? '—');

  renderOrgList('ov-pending-list', pendingOrgs, 'pending');
  renderFlagList('ov-flag-list',   flags.slice(0, 3));
  renderRecordList('ov-records',   records.slice(0, 5));
}

// ── VERIFICATION QUEUE ───────────────────────────────────────
async function loadVerification() {
  try {
    const d  = await apiFetch('/admin/pending');
    allOrgs  = d.orgs || [];
  } catch {
    allOrgs  = demoOrgs().filter(o => o.status === 'pending');
  }
  renderVerificationList();
}

function renderVerificationList() {
  let items = allOrgs;
  if (vFilterVal !== 'all') items = items.filter(o => o.role === vFilterVal);
  renderOrgList('verification-list', items, 'pending');
}

window.vFilter = function(val) {
  vFilterVal = val;
  ['all', 'donor', 'demand_org'].forEach(v =>
    document.getElementById(`vf-${v === 'demand_org' ? 'demand' : v}`)?.classList.toggle('active', v === val)
  );
  renderVerificationList();
};

// ── ALL PARTICIPANTS ─────────────────────────────────────────
async function loadParticipants() {
  try {
    const d  = await apiFetch('/admin/participants');
    allOrgs  = d.orgs || [];
  } catch {
    allOrgs  = demoOrgs();
  }
  renderParticipantList(pFilterVal);
}

function renderParticipantList(filter) {
  let items = allOrgs;
  if (filter !== 'all') items = items.filter(o => o.status === filter);
  const q = document.getElementById('participant-search')?.value.toLowerCase() || '';
  if (q) items = items.filter(o =>
    (o.orgName || o.name || '').toLowerCase().includes(q) ||
    (o.email || '').toLowerCase().includes(q) ||
    (o.role || '').toLowerCase().includes(q)
  );
  renderOrgList('participants-list', items, 'all');
}

window.pFilter = function(val) {
  pFilterVal = val;
  ['all','verified','pending','suspended','flagged'].forEach(v =>
    document.getElementById(`pf-${v}`)?.classList.toggle('active', v === val)
  );
  renderParticipantList(val);
};

window.searchParticipants = function() { renderParticipantList(pFilterVal); };

// ── SAFETY REVIEW ────────────────────────────────────────────
async function loadSafety() {
  try {
    const d    = await apiFetch('/admin/flags');
    allSafetyFlags = d.flags || [];
  } catch {
    allSafetyFlags = demoFlags();
  }
  renderSafetyList(sFilterVal);
}

function renderSafetyList(filter) {
  let items = allSafetyFlags;
  if (filter === 'high')   items = items.filter(f => f.severity === 'high');
  if (filter === 'medium') items = items.filter(f => f.severity === 'medium');
  if (filter === 'open')   items = items.filter(f => !f.resolved);
  if (filter === 'closed') items = items.filter(f => f.resolved);
  renderFlagList('safety-list', items);
}

window.sFilter = function(val) {
  sFilterVal = val;
  ['all','high','medium','open','closed'].forEach(v =>
    document.getElementById(`sf-${v}`)?.classList.toggle('active', v === val)
  );
  renderSafetyList(val);
};

// ── DISPUTES ─────────────────────────────────────────────────
async function loadDisputes() {
  try {
    const d    = await apiFetch('/admin/disputes');
    allDisputes = d.disputes || [];
  } catch {
    allDisputes = demoDisputes();
  }
  renderDisputeList(dFilterVal);
}

function renderDisputeList(filter) {
  let items = allDisputes;
  if (filter !== 'all') items = items.filter(d => d.status === filter);
  const el = document.getElementById('disputes-list');
  if (!items.length) { el.innerHTML = emptyState('⚖️', 'No disputes match this filter.'); return; }
  el.innerHTML = items.map(d => `
    <div class="dispute-item" id="dispute-${d.id}">
      <div class="dispute-header">
        <div>
          <div class="dispute-type">${disputeIcon(d.type)} ${d.type || 'Dispute'}</div>
          <div class="dispute-between">Between: ${d.party1 || '—'} & ${d.party2 || '—'}</div>
        </div>
        <span class="status-badge sb-${d.status || 'open'}">${d.status || 'open'}</span>
      </div>
      <div class="dispute-body">${d.description || 'No description provided.'}</div>
      <div style="font-size:0.72rem; color:var(--sub); margin-bottom:10px;">
        Reported: ${d.createdAt ? timeAgo(d.createdAt) : '—'} · Ref: #${d.id}
      </div>
      <div class="dispute-actions">
        ${d.status === 'open' ? `
          <button class="action-btn btn-resolve" onclick="resolveDispute('${d.id}')">✓ Mark Resolved</button>
          <button class="action-btn btn-suspend" onclick="openModal('suspend','${d.id}','Suspend Participant','Suspend one of the parties pending investigation?')">Suspend Party</button>
        ` : ''}
        <button class="action-btn btn-view" onclick="viewRecord('${d.id}')">View History</button>
      </div>
    </div>
  `).join('');
}

window.dFilter = function(val) {
  dFilterVal = val;
  ['all','open','resolved'].forEach(v =>
    document.getElementById(`df-${v}`)?.classList.toggle('active', v === val)
  );
  renderDisputeList(val);
};

window.resolveDispute = async function(id) {
  try { await apiFetch(`/admin/disputes/${id}/resolve`, 'PUT'); }
  catch { /* demo */ }
  document.getElementById(`dispute-${id}`)?.querySelector('.dispute-header')
    ?.querySelector('.status-badge')?.setAttribute('class', 'status-badge sb-resolved');
  document.getElementById(`dispute-${id}`)?.querySelector('.dispute-actions')
    ?.querySelectorAll('.btn-resolve, .btn-suspend')?.forEach(b => b.remove());
  toast('✅ Dispute marked as resolved.', 'success');
  addRecord({ type: 'resolve', title: `Dispute #${id} resolved`, detail: 'Marked resolved by admin.' });
};

// ── RECORDS ──────────────────────────────────────────────────
async function loadRecords() {
  try {
    const d   = await apiFetch('/admin/records');
    allRecords = d.records || [];
  } catch {
    allRecords = demoRecords();
  }
  renderRecordList('records-list', allRecords);
}

window.searchRecords = function() {
  const q   = document.getElementById('records-search')?.value.toLowerCase() || '';
  const items = q ? allRecords.filter(r =>
    (r.title || '').toLowerCase().includes(q) ||
    (r.detail || '').toLowerCase().includes(q) ||
    (r.admin || '').toLowerCase().includes(q)
  ) : allRecords;
  renderRecordList('records-list', items);
};

// ── ORG RENDERER ─────────────────────────────────────────────
function renderOrgList(id, orgs, context) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!orgs || !orgs.length) {
    el.innerHTML = emptyState('🏢', context === 'pending' ? 'No pending verifications. All caught up!' : 'No organizations match this filter.');
    return;
  }
  el.innerHTML = orgs.map(org => {
    const status  = org.status || 'pending';
    const roleLabel = formatRole(org.role);
    const avatarClass = `oa-${status === 'flagged' ? 'flagged' : status === 'verified' ? 'verified' : status === 'suspended' ? 'suspended' : 'pending'}`;
    const emoji = org.role === 'donor' ? '🏪' : org.role === 'demand_org' ? '🤝' : '🏢';
    return `
      <div class="org-item ${status === 'pending' ? 'pending-review' : status === 'flagged' ? 'flagged' : status === 'verified' ? 'verified' : status === 'suspended' ? 'suspended' : ''}" id="org-${org.id}">
        <div class="org-avatar-wrap ${avatarClass}">${emoji}</div>
        <div class="org-info">
          <div class="org-name">${org.orgName || org.name || 'Organization'}</div>
          <div class="org-meta">
            <span>📋 ${roleLabel}</span>
            <span>📍 ${org.locationAddress || org.address || '—'}</span>
            <span>📧 ${org.email || '—'}</span>
            ${org.servingCapacity ? `<span>👥 ${org.servingCapacity} meals/day</span>` : ''}
            ${org.documentUrl ? `<a href="${org.documentUrl}" target="_blank" style="color:#38BDF8; font-weight:600; text-decoration:none;">📎 ${org.documentName || 'Verification Doc'}</a>` : ''}
            <span>🕐 ${org.createdAt ? timeAgo(org.createdAt) : '—'}</span>
          </div>
          <div class="org-actions">
            ${org.documentUrl ? `<a href="${org.documentUrl}" target="_blank" class="action-btn btn-view" style="text-decoration:none;">📄 View Document</a>` : ''}
            ${status === 'pending' ? `
              <button class="action-btn btn-approve"  onclick="openModal('approve','${org.id}','Approve ${org.orgName || 'Organization'}','Approve and activate this organization on the network?','success')">✓ Approve</button>
              <button class="action-btn btn-request"  onclick="openModal('request','${org.id}','Request More Info','What additional information do you need?','violet')">? More Info</button>
              <button class="action-btn btn-reject"   onclick="openModal('reject','${org.id}','Reject Application','Provide a reason for rejecting this application.','danger')">✗ Reject</button>
            ` : ''}
            ${status === 'verified' ? `
              <button class="action-btn btn-suspend"  onclick="openModal('suspend','${org.id}','Suspend ${org.orgName || 'Organization'}','Provide a reason for suspension.','danger')">⏸ Suspend</button>
              <button class="action-btn btn-restrict" onclick="openModal('restrict','${org.id}','Restrict Organization','Specify the restriction and reason.','danger')">🔒 Restrict</button>
            ` : ''}
            ${status === 'suspended' ? `
              <button class="action-btn btn-reinstate" onclick="openModal('reinstate','${org.id}','Reinstate ${org.orgName || 'Organization'}','Confirm reinstatement to the network.','success')">↩ Reinstate</button>
            ` : ''}
            <span class="status-badge sb-${status}">${status}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderFlagList(id, flags) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!flags || !flags.length) { el.innerHTML = emptyState('🛡️', 'No flags to review. Network looks clean!'); return; }
  el.innerHTML = flags.map(f => `
    <div class="flag-item ${f.severity || 'medium'}" id="flag-${f.id}">
      <div class="flag-icon">${f.severity === 'high' ? '🚨' : '⚠️'}</div>
      <div class="flag-body">
        <div class="flag-title">${f.title}</div>
        <div class="flag-detail">${f.detail}</div>
        <div class="flag-meta">
          <span>🏢 ${f.org || '—'}</span>
          <span>🕐 ${f.createdAt ? timeAgo(f.createdAt) : '—'}</span>
          <span class="status-badge sb-${f.resolved ? 'resolved' : 'open'}">${f.resolved ? 'Closed' : 'Open'}</span>
        </div>
        ${!f.resolved ? `
        <div class="flag-actions">
          <button class="action-btn btn-suspend" onclick="openModal('suspend','${f.orgId}','Suspend Organization','Suspend this organization pending investigation?','danger')">⏸ Suspend Org</button>
          <button class="action-btn btn-resolve" onclick="closeFlag('${f.id}')">✓ Close Flag</button>
          <button class="action-btn btn-view"    onclick="">View Org</button>
        </div>` : ''}
      </div>
    </div>
  `).join('');
}

function renderRecordList(id, records) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!records || !records.length) { el.innerHTML = emptyState('📝', 'No records found.'); return; }
  el.innerHTML = records.map(r => `
    <div class="record-item">
      <div class="record-icon ${recordIconClass(r.type)}">${recordEmoji(r.type)}</div>
      <div class="record-body">
        <div class="record-title">${r.title}</div>
        <div class="record-detail">${r.detail || ''}</div>
      </div>
      <div class="record-right">
        <div class="record-time">${r.createdAt ? timeAgo(r.createdAt) : '—'}</div>
        <div class="record-admin">${r.admin || 'Admin'}</div>
      </div>
    </div>
  `).join('');
}

// ── MODAL ─────────────────────────────────────────────────────
window.openModal = function(action, entityId, title, desc, style = 'violet') {
  pendingAction = { action, entityId };
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-desc').textContent  = desc;
  document.getElementById('modal-notes').value       = '';
  const btn = document.getElementById('modal-confirm-btn');
  btn.className = `modal-confirm ${style}`;
  btn.textContent = 'Confirm';
  btn.onclick = () => executeAction(action, entityId);
  document.getElementById('modal-overlay').classList.add('show');
};

window.closeModal = function() {
  document.getElementById('modal-overlay').classList.remove('show');
  pendingAction = null;
};

async function executeAction(action, entityId) {
  const notes = document.getElementById('modal-notes').value.trim();
  closeModal();

  const actionMap = {
    approve:   { endpoint: `/admin/orgs/${entityId}/approve`,   method: 'PUT', msg: '✅ Organization approved!',    newStatus: 'verified',   record: { type:'approve', title:`Org approved: ${entityId}`, detail: notes || 'Approved.' } },
    reject:    { endpoint: `/admin/orgs/${entityId}/reject`,    method: 'PUT', msg: '❌ Application rejected.',     newStatus: 'rejected',   record: { type:'reject',  title:`Org rejected: ${entityId}`, detail: notes || 'Rejected.' } },
    request:   { endpoint: `/admin/orgs/${entityId}/request-info`, method:'PUT', msg: 'ℹ️ Info request sent.',     newStatus: 'pending',    record: { type:'info',    title:`Info requested: ${entityId}`, detail: notes } },
    suspend:   { endpoint: `/admin/orgs/${entityId}/suspend`,   method: 'PUT', msg: '⏸ Organization suspended.',  newStatus: 'suspended',  record: { type:'suspend', title:`Org suspended: ${entityId}`, detail: notes || 'Suspended.' } },
    reinstate: { endpoint: `/admin/orgs/${entityId}/reinstate`, method: 'PUT', msg: '↩ Organization reinstated.', newStatus: 'verified',   record: { type:'approve', title:`Org reinstated: ${entityId}`, detail: notes || 'Reinstated.' } },
    restrict:  { endpoint: `/admin/orgs/${entityId}/restrict`,  method: 'PUT', msg: '🔒 Restrictions applied.',   newStatus: 'restricted', record: { type:'flag',    title:`Org restricted: ${entityId}`, detail: notes } },
  };

  const def = actionMap[action];
  if (!def) return;

  try { await apiFetch(def.endpoint, def.method, { notes, reason: notes }); }
  catch { /* demo */ }

  toast(def.msg, action === 'approve' || action === 'reinstate' ? 'success' : 'info');
  addRecord(def.record);

  // Update org item status in DOM
  const orgEl = document.getElementById(`org-${entityId}`);
  if (orgEl) {
    const badge = orgEl.querySelector('.status-badge');
    if (badge) { badge.className = `status-badge sb-${def.newStatus}`; badge.textContent = def.newStatus; }
    // Remove action buttons
    setTimeout(() => loadPageData(document.querySelector('.page-content.active')?.id?.replace('page-', '')), 500);
  }
}

// ── MISC ACTIONS ─────────────────────────────────────────────
window.closeFlag = async function(flagId) {
  try { await apiFetch(`/admin/flags/${flagId}/close`, 'PUT'); } catch { /* demo */ }
  const el = document.getElementById(`flag-${flagId}`);
  if (el) el.querySelector('.flag-actions')?.remove();
  toast('Flag closed.', 'info');
};

window.viewRecord = function(id) {
  toast(`ℹ️ Opening record #${id}…`, 'info');
};

// ── BADGES ───────────────────────────────────────────────────
async function loadBadges() {
  try {
    const d = await apiFetch('/admin/overview');
    updateBadge('badge-pending',  d.pendingCount  || 0);
    updateBadge('badge-flags',    d.flaggedCount  || 0);
    updateBadge('badge-disputes', d.disputeCount  || 0);
  } catch {
    updateBadge('badge-pending',  4);
    updateBadge('badge-flags',    2);
    updateBadge('badge-disputes', 3);
  }
}
function updateBadge(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  if (n > 0) { el.textContent = n; el.style.display = 'inline'; }
  else { el.style.display = 'none'; }
}

// ── In-memory record log ─────────────────────────────────────
function addRecord(rec) {
  rec.createdAt = new Date().toISOString();
  rec.admin     = user?.name || 'Admin';
  allRecords.unshift(rec);
}

// ── DEMO DATA ─────────────────────────────────────────────────
function demoStats() {
  return { pendingCount:4, verifiedCount:38, flaggedCount:2, disputeCount:3, suspendedCount:2, actionsToday:7 };
}

function demoOrgs() {
  return [
    { id:'o1', orgName:'Spice Garden Restaurant', role:'donor',      email:'spice@example.com', locationAddress:'Kondapur, Hyderabad',    status:'pending',   createdAt: ago(120),  servingCapacity:null },
    { id:'o2', orgName:'Hope Foundation NGO',     role:'demand_org', email:'hope@example.com',  locationAddress:'Khairatabad, Hyderabad', status:'pending',   createdAt: ago(240) },
    { id:'o3', orgName:'City Bakery',             role:'donor',      email:'bakery@example.com',locationAddress:'Jubilee Hills',          status:'pending',   createdAt: ago(60) },
    { id:'o4', orgName:'FoodSafe Depot',          role:'demand_org', email:'depot@example.com', locationAddress:'Uppal, Hyderabad',       status:'pending',   createdAt: ago(480) },
    { id:'o5', orgName:'Grand Hyatt Hotel',       role:'donor',      email:'hyatt@example.com', locationAddress:'Banjara Hills',          status:'verified',  createdAt: ago(14400) },
    { id:'o6', orgName:'Helping Hands Kitchen',   role:'demand_org', email:'hands@example.com', locationAddress:'Secunderabad',           status:'verified',  createdAt: ago(28800), servingCapacity:200 },
    { id:'o7', orgName:'Dodgy Caterers Ltd',      role:'donor',      email:'dodgy@example.com', locationAddress:'Unknown',                status:'suspended', createdAt: ago(72000) },
    { id:'o8', orgName:'Quick Meals Co',          role:'donor',      email:'quick@example.com', locationAddress:'Madhapur',               status:'flagged',   createdAt: ago(5760) },
  ];
}

function demoFlags() {
  return [
    { id:'f1', orgId:'o8', severity:'high',   resolved:false, title:'Quantity misrepresentation — Quick Meals Co', detail:'Recipient reported 80 meals delivered vs 200 claimed. Third instance in 30 days.', org:'Quick Meals Co', createdAt: ago(45) },
    { id:'f2', orgId:'o7', severity:'high',   resolved:false, title:'Suspicious registration pattern — Dodgy Caterers', detail:'Multiple accounts registered from same IP. Org address unverifiable. Activity flagged by system.', org:'Dodgy Caterers Ltd', createdAt: ago(180) },
    { id:'f3', orgId:'o5', severity:'medium', resolved:true,  title:'Late handover — Grand Hyatt Hotel (Resolved)', detail:'Food collected 40 mins past window. Reported by receiving NGO. Org has good track record — resolved as one-off.', org:'Grand Hyatt Hotel', createdAt: ago(2880) },
  ];
}

function demoDisputes() {
  return [
    { id:'dp1', type:'Quantity Dispute',   party1:'Quick Meals Co',      party2:'Hope Foundation NGO', description:'NGO received 80 meals but donor posted 200. NGO requests credit or explanation. Third occurrence.', status:'open',     createdAt: ago(60) },
    { id:'dp2', type:'Failed Handover',    party1:'City Bakery',         party2:'Community Food Bank', description:'Pickup window missed. Food expired before collection. Bank requests policy clarification.', status:'open',     createdAt: ago(300) },
    { id:'dp3', type:'Participant Conflict',party1:'FreshMart Superstore',party2:'Helping Hands Kitchen','description':'Recurring scheduling conflicts. Kitchen claims store changes pickup times without notice.', status:'open',     createdAt: ago(720) },
    { id:'dp4', type:'Safety Complaint',   party1:'Anonymous',           party2:'Dodgy Caterers Ltd',  description:'Food quality concerns raised. Recipients reported food odor issues on two occasions.', status:'resolved', createdAt: ago(4320) },
  ];
}

function demoRecords() {
  return [
    { type:'approve',  title:'Organization approved: Grand Hyatt Hotel',      detail:'Standard verification. Documents verified.',       admin:'Admin', createdAt: ago(14400) },
    { type:'suspend',  title:'Organization suspended: Dodgy Caterers Ltd',    detail:'Multiple suspicious activity flags.',              admin:'Admin', createdAt: ago(72000) },
    { type:'flag',     title:'Flag raised: Quick Meals Co (quantity issue)',   detail:'Third quantity discrepancy reported.',             admin:'System',createdAt: ago(45) },
    { type:'resolve',  title:'Dispute resolved: Grand Hyatt / NGO handover',  detail:'Resolved as scheduling error.',                   admin:'Admin', createdAt: ago(2880) },
    { type:'approve',  title:'Organization approved: Helping Hands Kitchen',  detail:'Verified NGO registration documents.',            admin:'Admin', createdAt: ago(28800) },
    { type:'info',     title:'More info requested: FoodSafe Depot',           detail:'Storage certification documentation requested.',  admin:'Admin', createdAt: ago(1440) },
    { type:'reject',   title:'Application rejected: Unknown Catering Co',     detail:'Unverifiable address, no contact response.',      admin:'Admin', createdAt: ago(86400) },
  ];
}

// ── Helpers ───────────────────────────────────────────────────
function formatRole(role) {
  const m = { donor:'Donor Org', demand_org:'Demand Org', admin:'Administrator', network_intelligence:'Network Coordinator' };
  return m[role] || role || '—';
}
function disputeIcon(type) {
  const m = { 'Quantity Dispute':'📦', 'Failed Handover':'🚚', 'Participant Conflict':'⚠️', 'Safety Complaint':'🛡️' };
  return m[type] || '⚖️';
}
function recordIconClass(type) {
  const m = { approve:'ri-approve', reject:'ri-reject', suspend:'ri-suspend', flag:'ri-flag', resolve:'ri-approve', info:'ri-info' };
  return m[type] || 'ri-info';
}
function recordEmoji(type) {
  const m = { approve:'✅', reject:'❌', suspend:'⏸', flag:'🚩', resolve:'✓', info:'ℹ️' };
  return m[type] || '📝';
}
function emptyState(icon, msg) { return `<div class="empty-state"><div class="ei">${icon}</div><p>${msg}</p></div>`; }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function ago(mins) { return new Date(Date.now() - mins * 60000).toISOString(); }
function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diff < 1)    return 'just now';
  if (diff < 60)   return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}
function toast(msg, type = 'info') {
  const icons = { success:'✅', error:'❌', info:'ℹ️', warn:'⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
window.logout = function() {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.href = '/admin/index.html';
};

// ── Start ─────────────────────────────────────────────────────
init();
