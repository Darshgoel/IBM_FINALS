/**
 * FoodBridge — Network Intelligence Dashboard JS
 * Sections: Overview, Supply/Demand, Redistributions, Rebalancing,
 *           Reserve Allocation, Community Intel, Waste Risk, Interventions, Metrics
 */

const API_BASE = 'http://localhost:3000/api';
const token    = localStorage.getItem('fb_token');
const user     = JSON.parse(localStorage.getItem('fb_user') || 'null');

// Auth guard — must be network coordinator or admin
if (!token || !user || !['network_intelligence', 'network_admin', 'admin'].includes(user.role)) {
  window.location.href = '/network-intelligence/';
}

// ── State ───────────────────────────────────────────────────
let networkData = {};
let sdFilterVal  = 'all';
let rdFilterVal  = 'all';
let intFilterVal = 'all';
let allInterventions = [];
let allRedistributions = [];
let allSdItems = [];

// ── Page Router ─────────────────────────────────────────────
const pages = {
  'overview':       ['Network Overview',          'Real-time food network status'],
  'supply-demand':  ['Supply & Demand',           'All current surplus and demand registrations'],
  'redistributions':['Active Redistributions',    'Match tracking across the network'],
  'rebalancing':    ['Network Rebalancing',        'Area surplus/deficit and redirection'],
  'fallback':       ['Reserve Allocation',         'Surplus routed to food banks and storage'],
  'community':      ['Community Food Intelligence','Hotspots, gaps, and structural patterns'],
  'waste-risk':     ['Waste Risk',                '⚠️ Surplus approaching expiry with no match'],
  'interventions':  ['Interventions',             'System-generated action recommendations'],
  'metrics':        ['Network Metrics',           'High-level network performance data'],
};

window.showPage = function(page) {
  document.querySelectorAll('.page-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item:not(.locked)').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.getElementById(`nav-${page}`)?.classList.add('active');
  const [title, sub] = pages[page] || [page, ''];
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-sub').textContent   = sub;
  loadPageData(page);
};

async function loadPageData(page) {
  try {
    switch(page) {
      case 'overview':       await loadOverview();        break;
      case 'supply-demand':  await loadSupplyDemand();    break;
      case 'redistributions':await loadRedistributions(); break;
      case 'rebalancing':    await loadRebalancing();     break;
      case 'fallback':       await loadFallback();        break;
      case 'community':      await loadCommunity();       break;
      case 'waste-risk':     await loadWasteRisk();       break;
      case 'interventions':  await loadInterventions();   break;
      case 'metrics':        await loadMetrics();         break;
    }
  } catch(err) { console.error('loadPageData', page, err); }
}

// ── Init ─────────────────────────────────────────────────────
async function init() {
  const name     = user?.name || 'Coordinator';
  const initials = name.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
  document.getElementById('sidebar-avatar').textContent = initials;
  document.getElementById('sidebar-name').textContent   = name;
  await loadOverview();
  await checkBadges();
}

// ── API helper ───────────────────────────────────────────────
async function apiFetch(endpoint) {
  const res  = await fetch(API_BASE + endpoint, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// ── OVERVIEW ────────────────────────────────────────────────
async function loadOverview() {
  let d;
  try   { d = await apiFetch('/network/overview'); }
  catch { d = {}; }

  setText('ov-surplus',       d.activeSurplus ?? '0');
  setText('ov-demand',        d.activeDemands ?? '0');
  setText('ov-redist',        d.activeRedistributions ?? '0');
  setText('ov-rate',          (d.fulfillmentRate ?? 0) + '%');
  setText('ov-risk',          d.wasteRiskCount ?? '0');
  setText('ov-recovered',     d.foodRecoveredToday ?? '0 kg');

  renderNetList('ov-surplus-list', (d.recentSurplus || []), 'surplus');
  renderNetList('ov-demand-list',  (d.urgentDemands || []), 'demand');
  renderRiskList('ov-risk-list',   (d.wasteRisks    || []));
}

// ── SUPPLY & DEMAND ──────────────────────────────────────────
async function loadSupplyDemand() {
  let surplus = [], demands = [];
  try {
    const d = await apiFetch('/network/supply-demand');
    surplus  = d.surplus || [];
    demands  = d.demands || [];
  } catch {
    surplus = [];
    demands = [];
  }
  allSdItems = [
    ...surplus.map(s => ({ ...s, _type: 'surplus' })),
    ...demands.map(d  => ({ ...d,  _type: 'demand'  })),
  ].sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
  renderSdList(sdFilterVal);
}

window.sdFilter = function(val) {
  sdFilterVal = val;
  document.querySelectorAll('[id^="sd-filter-"]').forEach(b => b.classList.remove('active'));
  document.getElementById(`sd-filter-${val}`).classList.add('active');
  renderSdList(val);
};

function renderSdList(filter) {
  let items = allSdItems;
  if (filter === 'surplus')   items = items.filter(i => i._type === 'surplus');
  if (filter === 'demand')    items = items.filter(i => i._type === 'demand');
  if (filter === 'unmatched') items = items.filter(i => !i.matchId && i.status !== 'fulfilled');
  renderNetList('sd-list', items, 'mixed');
}

// ── REDISTRIBUTIONS ──────────────────────────────────────────
async function loadRedistributions() {
  try {
    const d = await apiFetch('/network/redistributions');
    allRedistributions = d.redistributions || [];
  } catch {
    allRedistributions = [];
  }
  renderRedistList(rdFilterVal);
}

window.rdFilter = function(val) {
  rdFilterVal = val;
  document.querySelectorAll('[id^="rd-filter-"]').forEach(b => b.classList.remove('active'));
  document.getElementById(`rd-filter-${val}`).classList.add('active');
  renderRedistList(val);
};

function renderRedistList(filter) {
  let items = allRedistributions;
  if (filter !== 'all') items = items.filter(i => i.status === filter);
  const el = document.getElementById('rd-list');
  if (!items.length) { el.innerHTML = emptyState('🔄', 'No redistributions match this filter.'); return; }
  el.innerHTML = items.map(r => `
    <div class="net-item">
      <div class="net-item-icon ni-match">🔄</div>
      <div class="net-item-body">
        <div class="net-item-title">${r.foodType || 'Food'} — ${r.donorName || 'Donor'} → ${r.recipientName || 'Recipient'}</div>
        <div class="net-item-meta">
          <span>📦 ${r.quantity || '—'} ${r.unit || 'servings'}</span>
          <span>📍 ${r.distance || '—'}</span>
          <span>⏱️ ${r.startedAt ? timeAgo(r.startedAt) : '—'}</span>
        </div>
        <span class="status-badge sb-${r.status}">${statusLabel(r.status)}</span>
      </div>
      <div class="net-item-right">
        <div class="net-qty ${qtyColor(r.status)}">${progressIcon(r.status)}</div>
      </div>
    </div>
  `).join('');
}

// ── REBALANCING ──────────────────────────────────────────────
async function loadRebalancing() {
  let zones, recs;
  try {
    const d = await apiFetch('/network/rebalancing');
    zones = d.zones || [];
    recs  = d.recommendations || [];
  } catch {
    zones = [];
    recs  = [];
  }

  const surplus = zones.filter(z => z.balance > 0);
  const deficit = zones.filter(z => z.balance < 0);

  renderZones('surplus-zones', surplus, 'surplus');
  renderZones('deficit-zones', deficit, 'deficit');
  renderInterventionList('rebalancing-recs', recs);
}

function renderZones(id, zones, type) {
  const el = document.getElementById(id);
  if (!zones.length) { el.innerHTML = `<div class="empty-state"><div class="ei">${type==='surplus'?'🟢':'🔴'}</div><p>None right now.</p></div>`; return; }
  el.innerHTML = zones.map(z => {
    const absBalance = Math.abs(z.balance);
    const surplusPct = Math.min(Math.round((z.supply / Math.max(z.supply, z.demand)) * 100), 100);
    const demandPct  = Math.min(Math.round((z.demand / Math.max(z.supply, z.demand)) * 100), 100);
    return `
      <div class="area-card ${type === 'surplus' ? 'surplus-zone' : 'deficit-zone'}">
        <div class="area-name">📍 ${z.name}</div>
        <div class="area-bar-wrap">
          <div class="area-bar-label">Supply</div>
          <div class="area-bar-track"><div class="area-bar-fill fill-green" style="width:${surplusPct}%"></div></div>
        </div>
        <div class="area-bar-wrap">
          <div class="area-bar-label">Demand</div>
          <div class="area-bar-track"><div class="area-bar-fill fill-indigo" style="width:${demandPct}%"></div></div>
        </div>
        <span class="area-balance ${type==='surplus'?'balance-pos':'balance-neg'}">
          ${type==='surplus'?'+':'−'}${absBalance} meals net
        </span>
      </div>`;
  }).join('');
}

// ── FALLBACK / RESERVE ───────────────────────────────────────
async function loadFallback() {
  let points, pending;
  try {
    const d = await apiFetch('/network/reserve');
    points  = d.reservePoints || [];
    pending = d.pendingReserve || [];
  } catch {
    points  = [];
    pending = [];
  }

  renderNetList('reserve-points', points, 'reserve');
  renderNetList('pending-reserve', pending, 'surplus');
}

// ── COMMUNITY INTEL ──────────────────────────────────────────
async function loadCommunity() {
  let ci;
  try   { ci = await apiFetch('/network/community'); }
  catch { ci = {}; }

  renderHotspots('surplus-hotspots', ci.surplusHotspots || [], 'surplus');
  renderHotspots('demand-hotspots',  ci.demandHotspots  || [], 'demand');
  renderHotspots('access-gaps',      ci.accessGaps      || [], 'gap');
  renderNetList('recurring-mismatches', ci.mismatches || [], 'mismatch');
}

function renderHotspots(id, spots, type) {
  const el = document.getElementById(id);
  if (!spots.length) { el.innerHTML = `<div style="color:var(--sub); font-size:0.82rem; padding:12px 0;">None identified.</div>`; return; }
  el.innerHTML = spots.map(s => `
    <div class="hotspot-item">
      <div class="hotspot-type ${type}">${type === 'surplus' ? '🟢 Surplus Hotspot' : type === 'demand' ? '🔴 Demand Hotspot' : '🕳️ Access Gap'}</div>
      <div class="hotspot-area">${s.area}</div>
      <div class="hotspot-detail">${s.detail}</div>
      <span class="hotspot-severity sev-${s.severity || 'medium'}">${s.severity || 'medium'}</span>
    </div>
  `).join('');
}

// ── WASTE RISK ───────────────────────────────────────────────
window.loadWasteRisk = async function() {
  let risks;
  try   { const d = await apiFetch('/network/waste-risk'); risks = d.risks || []; }
  catch { risks = []; }
  renderRiskList('risk-full-list', risks);
  updateBadge('risk-badge', risks.filter(r => !r.resolved).length);
};

function renderRiskList(id, risks) {
  const el = document.getElementById(id);
  if (!risks.length) { el.innerHTML = `<div class="empty-state"><div class="ei">✅</div><p>No waste risks right now. Great network coverage!</p></div>`; return; }
  el.innerHTML = risks.map(r => `
    <div class="risk-item ${r.severity === 'medium' ? 'amber' : ''}">
      <div class="risk-icon">${r.severity === 'high' ? '🚨' : '⚠️'}</div>
      <div class="risk-body">
        <div class="risk-title">${r.quantity || '—'} ${r.unit || 'servings'} of ${r.foodType || 'food'} — ${r.donorName || 'Donor'}</div>
        <div class="risk-detail">${r.detail || 'No match found. Food at risk of expiry.'}</div>
        <div class="risk-timer">⏱️ Expires in: ${r.expiresIn || '—'}</div>
        <div class="risk-actions">
          <button class="risk-btn intervene" onclick="triggerIntervention('${r.id}')">🎯 Find Match</button>
          <button class="risk-btn reserve"   onclick="routeToReserve('${r.id}')">🏦 Route to Reserve</button>
        </div>
      </div>
    </div>
  `).join('');
}

window.triggerIntervention = function(id) { toast('🎯 Searching for emergency match…', 'info'); };
window.routeToReserve      = function(id) { toast('🏦 Routing to nearest reserve point…', 'info'); };

// ── INTERVENTIONS ────────────────────────────────────────────
async function loadInterventions() {
  try   { const d = await apiFetch('/network/interventions'); allInterventions = d.interventions || []; }
  catch { allInterventions = []; }
  renderInterventionList('interventions-list', filterInterventions(intFilterVal));
}

window.intFilter = function(val) {
  intFilterVal = val;
  document.querySelectorAll('[id^="int-filter-"]').forEach(b => b.classList.remove('active'));
  document.getElementById(`int-filter-${val}`).classList.add('active');
  renderInterventionList('interventions-list', filterInterventions(val));
};
function filterInterventions(val) {
  return val === 'all' ? allInterventions : allInterventions.filter(i => i.priority === val);
}
function renderInterventionList(id, items) {
  const el = document.getElementById(id);
  if (!items || !items.length) { el.innerHTML = `<div class="empty-state"><div class="ei">💡</div><p>No recommendations at this time.</p></div>`; return; }
  el.innerHTML = items.map(i => `
    <div class="intervention-item">
      <div class="int-icon">${i.icon || '💡'}</div>
      <div class="int-body">
        <div class="int-title">${i.title}</div>
        <div class="int-detail">${i.detail}</div>
        <div class="int-priority ${i.priority}">${i.priority?.toUpperCase()} PRIORITY</div>
        <div class="int-actions">
          <button class="int-btn apply"   onclick="applyIntervention('${i.id}', this)">✓ Apply</button>
          <button class="int-btn dismiss" onclick="dismissIntervention('${i.id}', this)">Dismiss</button>
        </div>
      </div>
    </div>
  `).join('');
}

window.applyIntervention = function(id, btn) {
  const card = btn.closest('.intervention-item');
  toast('✅ Intervention applied and logged.', 'success');
  setTimeout(() => card?.remove(), 300);
};
window.dismissIntervention = function(id, btn) {
  btn.closest('.intervention-item')?.remove();
  toast('Recommendation dismissed.', 'info');
};

// ── METRICS ──────────────────────────────────────────────────
async function loadMetrics() {
  let m;
  try   { m = await apiFetch('/network/metrics'); }
  catch { m = {}; }

  setText('m-total-surplus',   m.totalSurplus    || '0 kg');
  setText('m-total-demand',    m.totalDemand     || '0 servings');
  setText('m-recovered',       m.foodRecovered   || '0 kg');
  setText('m-waste-prevented', m.wastePrevented  || '0 kg CO₂e');
  setText('m-fulfillment',     (m.fulfillmentRate ?? 0) + '%');
  setText('m-unmet',           m.unmetDemand     || '0 servings');

  renderSdChart(m.weeklyData   || []);
  renderWasteChart(m.wasteData || []);
}

function renderSdChart(data) {
  const wrap = document.getElementById('sd-chart');
  if (!wrap) return;
  const max = Math.max(...data.map(d => Math.max(d.surplus||0, d.demand||0)), 1);
  wrap.innerHTML = `
    <div style="display:flex; gap:6px; align-items:flex-end; width:100%; height:100%;">
      ${data.map(d => `
        <div style="flex:1; display:flex; align-items:flex-end; gap:2px; height:${Math.round((Math.max(d.surplus,d.demand)/max)*100)}%;">
          <div class="chart-bar bar-surplus" style="height:${Math.round((d.surplus/Math.max(d.surplus,d.demand))*100)||10}%;">
            <div class="tip">${d.day}: ${d.surplus} surplus</div>
          </div>
          <div class="chart-bar bar-demand" style="height:${Math.round((d.demand/Math.max(d.surplus,d.demand))*100)||10}%;">
            <div class="tip">${d.day}: ${d.demand} demand</div>
          </div>
          <div class="chart-bar bar-fulfilled" style="height:${Math.round((d.fulfilled/Math.max(d.surplus,d.demand))*100)||5}%;">
            <div class="tip">${d.day}: ${d.fulfilled} fulfilled</div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="chart-x-labels">${data.map(d=>`<div class="chart-x-label">${d.day}</div>`).join('')}</div>`;
}

function renderWasteChart(data) {
  const wrap = document.getElementById('waste-chart');
  if (!wrap) return;
  const max = Math.max(...data.map(d => (d.intercepted||0) + (d.wasted||0)), 1);
  wrap.innerHTML = `
    <div style="display:flex; gap:6px; align-items:flex-end; width:100%; height:100%;">
      ${data.map(d => {
        const total = (d.intercepted||0) + (d.wasted||0);
        const pct = Math.round((total/max)*100);
        const iPct = total ? Math.round((d.intercepted/total)*100) : 0;
        return `
          <div style="flex:1; display:flex; align-items:flex-end; gap:2px; height:${pct}%;">
            <div class="chart-bar bar-surplus" style="height:${iPct}%;">
              <div class="tip">${d.day}: ${d.intercepted} saved</div>
            </div>
            <div class="chart-bar bar-waste" style="height:${100-iPct}%;">
              <div class="tip">${d.day}: ${d.wasted} wasted</div>
            </div>
          </div>`;
      }).join('')}
    </div>
    <div class="chart-x-labels">${data.map(d=>`<div class="chart-x-label">${d.day}</div>`).join('')}</div>`;
}

// ── Generic Net List renderer ────────────────────────────────
function renderNetList(id, items, type) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!items || !items.length) { el.innerHTML = emptyState('📭', 'Nothing to display.'); return; }
  el.innerHTML = items.map(item => {
    const t = item._type || type;
    const icon    = t === 'surplus' ? 'ni-surplus' : t === 'demand' ? 'ni-demand' : t === 'reserve' ? 'ni-reserve' : 'ni-match';
    const emoji   = t === 'surplus' ? '🍽️' : t === 'demand' ? '📋' : t === 'reserve' ? '🏦' : '🔄';
    const qty     = item.quantity || item.remainingCapacity || '—';
    const unit    = item.unit || 'servings';
    const qColor  = t === 'surplus' ? 'green' : t === 'demand' ? 'indigo' : 'amber';
    const org     = item.donorName || item.orgName || item.name || 'Organization';
    const status  = item.status || 'active';
    const badge   = statusBadgeClass(status);
    return `
      <div class="net-item">
        <div class="net-item-icon ${icon}">${emoji}</div>
        <div class="net-item-body">
          <div class="net-item-title">${item.foodType || item.food_type || 'Food'}</div>
          <div class="net-item-meta">
            <span>🏢 ${org}</span>
            ${item.locationAddress || item.area ? `<span>📍 ${item.locationAddress || item.area}</span>` : ''}
            ${item.urgency ? `<span>⚡ ${item.urgency}</span>` : ''}
            ${item.expiresAt ? `<span>⏱️ ${timeAgo(item.expiresAt)}</span>` : ''}
            ${item.createdAt ? `<span>🕐 ${timeAgo(item.createdAt)}</span>` : ''}
          </div>
          <span class="status-badge ${badge}">${status}</span>
        </div>
        <div class="net-item-right">
          <div class="net-qty ${qColor}">${qty}</div>
          <div style="font-size:0.68rem; color:var(--sub);">${unit}</div>
        </div>
      </div>`;
  }).join('');
}

// ── Badges ───────────────────────────────────────────────────
async function checkBadges() {
  try {
    const d = await apiFetch('/network/overview');
    updateBadge('risk-badge',   d.wasteRiskCount         || 0);
    updateBadge('redist-badge', d.activeRedistributions   || 0);
  } catch {
    updateBadge('risk-badge',   0);
    updateBadge('redist-badge', 0);
  }
}
function updateBadge(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  if (n > 0) { el.textContent = n; el.style.display = 'inline'; }
  else        { el.style.display = 'none'; }
}

// ── Refresh ──────────────────────────────────────────────────
window.refreshAll = async function() {
  const active = document.querySelector('.page-content.active')?.id?.replace('page-','');
  if (active) await loadPageData(active);
  toast('↻ Refreshed', 'info');
};

// ── FALLBACK / EMPTY STATE HELPERS ───────────────────────────
function demoOverview() {
  return {
    activeSurplus: 0, activeDemands: 0, activeRedistributions: 0,
    fulfillmentRate: 0, wasteRiskCount: 0, foodRecoveredToday: '0 kg',
    recentSurplus: [], urgentDemands: [], wasteRisks: [],
  };
}
function demoSurplus() { return []; }
function demoDemands() { return []; }
function demoRedistributions() { return []; }
function demoZones() { return []; }
function demoRebalancingRecs() { return []; }
function demoReservePoints() { return []; }
function demoPendingReserve() { return []; }
function demoCommunity() {
  return { surplusHotspots: [], demandHotspots: [], accessGaps: [], mismatches: [] };
}
function demoWasteRisks() { return []; }
function demoInterventions() { return []; }
function demoMetrics() {
  return {
    totalSurplus: '0 kg', totalDemand: '0 servings', foodRecovered: '0 kg',
    wastePrevented: '0 kg CO₂e', fulfillmentRate: 0, unmetDemand: '0 servings',
    weeklyData: [], wasteData: [],
  };
}
function demoWeekly() { return []; }
function demoWasteWeekly() { return []; }
function demoMismatches() { return []; }

// ── Utilities ─────────────────────────────────────────────────
function statusBadgeClass(s) {
  const m = { finding:'sb-finding', matched:'sb-matched', progress:'sb-progress', completed:'sb-completed', 'at-risk':'sb-at-risk', reserve:'sb-reserve', active:'sb-matched', searching:'sb-finding', fulfilled:'sb-completed' };
  return m[s] || 'sb-finding';
}
function statusLabel(s) {
  const m = { finding:'Finding Recipient', matched:'Matched', progress:'In Progress', completed:'Completed', active:'Active', searching:'Searching' };
  return m[s] || s;
}
function progressIcon(s) {
  const m = { finding:'🔍', matched:'🔗', progress:'🚚', completed:'✅', active:'📋' };
  return m[s] || '—';
}
function qtyColor(s) {
  const m = { finding:'amber', matched:'cyan', progress:'indigo', completed:'green' };
  return m[s] || 'cyan';
}
function emptyState(icon, msg) { return `<div class="empty-state"><div class="ei">${icon}</div><p>${msg}</p></div>`; }
function setText(id, v) { const el=document.getElementById(id); if(el) el.textContent=v; }
function ago(mins) { return new Date(Date.now() + mins*60000).toISOString(); }
function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso))/60000);
  if (diff < 0)     return `in ${Math.abs(diff)}m`;
  if (diff < 1)     return 'just now';
  if (diff < 60)    return `${diff}m ago`;
  if (diff < 1440)  return `${Math.floor(diff/60)}h ago`;
  return `${Math.floor(diff/1440)}d ago`;
}

function toast(msg, type='info') {
  const icons = { success:'✅', error:'❌', info:'ℹ️', warn:'⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

window.logout = function() {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.href = '/';
};

// ── Start ─────────────────────────────────────────────────────
init();
