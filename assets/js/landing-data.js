/* ────────────────────────────────────────────────────────────────────────
   FoodBridge — public landing page live access-point data and map
   Uses the target backend's public recipient directory:
   GET /api/recipient/search

   Nothing on this page invents impact totals. Only verified access points
   returned by the API are shown.
   ──────────────────────────────────────────────────────────────────────── */

const FOOD_TYPE_CATEGORY = {
  cooked_meal: 'cooked',
  cooked_meals: 'cooked',
  bakery: 'bakery',
  produce: 'vegetables',
  fruits: 'fruits',
  fruit: 'fruits',
  vegetables: 'vegetables',
  dairy: 'packaged',
  packaged: 'packaged',
  beverages: 'other',
  other: 'other'
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

function categoryFor(type) {
  return FOOD_TYPE_CATEGORY[String(type || '').toLowerCase()] || 'other';
}

function parseTags(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  }
}

function normalizePoint(accessPoint) {
  const recent = Array.isArray(accessPoint.recentSurplus) ? accessPoint.recentSurplus : [];
  const currentFood = recent.slice(0, 3).map(item => ({
    name: item.food_name || 'Surplus food',
    category: categoryFor(item.food_type),
    quantity: item.quantity,
    unit: item.quantity_unit || 'servings',
    status: 'reserved',
    dietBadges: parseTags(item.dietary_tags).slice(0, 2).map(tag => ({
      label: String(tag).replace(/_/g, ' '),
      tone: 'blue'
    }))
  }));

  const area = String(accessPoint.location_address || '').split(',').map(part => part.trim()).filter(Boolean).pop() || '';

  return {
    id: accessPoint.id,
    name: accessPoint.name || 'Community food point',
    type: accessPoint.type || 'ngo',
    address: accessPoint.location_address || 'Address not published',
    area,
    locationAddress: accessPoint.location_address,
    lat: Number(accessPoint.location_lat),
    lng: Number(accessPoint.location_lng),
    operatingHours: accessPoint.operating_hours || 'Hours not published',
    hoursWindow: accessPoint.operating_hours || 'Hours not published',
    contactPhone: accessPoint.contact_phone || '',
    description: accessPoint.description || '',
    servingCapacity: Number(accessPoint.serving_capacity) || 0,
    activeIncoming: Number(accessPoint.activeIncoming) || 0,
    currentFood,
    distanceKm: accessPoint.distance == null ? null : Number(accessPoint.distance),
    openNow: null,
    verified: true
  };
}

async function loadHomeData() {
  let points = [];
  try {
    const data = await fetchJson(`${API}/recipient/search`);
    points = (Array.isArray(data.accessPoints) ? data.accessPoints : []).map(normalizePoint);
  } catch (err) {
    points = [];
    const note = $('impactNote');
    if (note) {
      note.textContent = 'Live access-point data is temporarily unavailable. You can still open the food finder.';
      note.classList.add('is-error');
    }
  }

  state.points = points;
  state.listings = [];
  renderAccessStats(points);
  renderListings();
  initMap();
}

function renderAccessStats(points) {
  const incoming = points.reduce((sum, point) => sum + (point.activeIncoming || 0), 0);
  const areas = new Set(points.map(point => point.area).filter(Boolean)).size;
  const capacity = points.reduce((sum, point) => sum + (point.servingCapacity || 0), 0);

  const values = {
    points: formatNumber(points.length),
    incoming: formatNumber(incoming),
    areas: formatNumber(areas),
    servings: formatNumber(capacity)
  };

  document.querySelectorAll('[data-stat]').forEach(el => {
    const key = el.getAttribute('data-stat');
    if (key && values[key] != null) el.textContent = values[key];
  });

  const note = $('impactNote');
  if (note) {
    note.classList.remove('is-error');
    note.textContent = points.length
      ? `Live directory: ${formatNumber(points.length)} verified access point${points.length === 1 ? '' : 's'} accepting community food referrals.`
      : 'No verified access points are published yet. Check back after coordinator approval.';
  }
}

/* ── Access-point rows ────────────────────────────────────────────────── */
function foodImage(category) {
  return CATEGORY_IMAGES[category] || CATEGORY_IMAGES.other;
}

function pointCategory(point) {
  return point.currentFood.length ? point.currentFood[0].category : 'vegetables';
}

function quantityLabel(item) {
  const unit = String(item.unit || 'servings').toLowerCase();
  if (unit === 'servings' || unit === 'meal' || unit === 'meals') {
    return `${formatNumber(item.quantity)} servings`;
  }
  if (unit === 'kg' || unit === 'kilogram' || unit === 'kilograms') {
    return `${formatNumber(item.quantity)} kg`;
  }
  if (unit === 'litre' || unit === 'litres' || unit === 'liter' || unit === 'liters') {
    return `${formatNumber(item.quantity)} litres`;
  }
  return `${formatNumber(item.quantity)} ${escapeHtml(item.unit || 'servings')}`;
}

function dietBadgesHtml(badges, limit) {
  const list = Array.isArray(badges) ? badges : [];
  return list.slice(0, limit || list.length).map(badge =>
    `<span class="badge ${escapeHtml(badge.tone || 'blue')}">${escapeHtml(badge.label)}</span>`
  ).join('');
}

function pointMatchesFilters(point) {
  if (state.category) {
    if (!point.currentFood.some(food => food.category === state.category)) return false;
  }
  if (!state.search) return true;
  const haystack = [
    point.name, point.address, point.area, point.type,
    ...point.currentFood.map(food => food.name)
  ].join(' ').toLowerCase();
  return haystack.includes(state.search);
}

function filteredPoints() {
  return state.points.filter(pointMatchesFilters);
}

function renderListings() {
  const container = $('listings');
  if (!container) return;
  const items = filteredPoints().slice(0, 4);

  if (!items.length) {
    const noData = state.points.length === 0;
    container.innerHTML = `
      <div class="empty-state">
        <svg class="ico" aria-hidden="true"><use href="#${noData ? 'i-package' : 'i-search'}"></use></svg>
        <strong>${noData ? 'No verified access points yet' : 'No access points match your filters'}</strong>
        <p>${noData ? 'Coordinator-approved community partners will appear here.' : 'Try a different area or food type.'}</p>
        <button type="button" onclick="resetFilters()">Clear filters</button>
      </div>`;
    return;
  }

  container.innerHTML = items.map(point => {
    const food = point.currentFood[0];
    const badges = [
      `<span class="badge status is-available">Verified partner</span>`,
      point.activeIncoming ? `<span class="badge green">${point.activeIncoming} incoming match${point.activeIncoming === 1 ? '' : 'es'}</span>` : '',
      food ? dietBadgesHtml(food.dietBadges, 1) : ''
    ].join('');

    return `
      <article class="listing">
        <a class="listing-thumb-link" href="#" aria-label="View ${escapeHtml(point.name)}"
           onclick="openDetail('point','${escapeHtml(point.id)}'); return false;">
          <img class="listing-thumb" src="${foodImage(pointCategory(point))}" alt="${escapeHtml(point.name)}" decoding="async" />
        </a>
        <div class="listing-info">
          <h3 title="${escapeHtml(point.name)}">${escapeHtml(point.name)}</h3>
          <p class="listing-source">${escapeHtml(point.address)}</p>
          <div class="listing-meta">
            <span>${point.servingCapacity ? `${formatNumber(point.servingCapacity)} meals/day capacity` : 'Capacity not published'}</span>
            <span class="meta-dot">•</span>
            <span>${escapeHtml(point.operatingHours)}</span>
          </div>
          <div class="badges">${badges}</div>
        </div>
        <div class="listing-actions">
          <button class="btn-view" type="button" onclick="openDetail('point','${escapeHtml(point.id)}')">View</button>
          <span class="listing-time">${escapeHtml(CATEGORY_LABELS[food ? food.category : 'vegetables'] || 'Community food')}</span>
        </div>
      </article>`;
  }).join('');
}

/* ── Map ───────────────────────────────────────────────────────────────── */
function initMap() {
  const loading = $('mapLoading');
  const fallback = $('mapFallback');

  if (typeof window.L === 'undefined') {
    if (loading) loading.hidden = true;
    if (fallback) fallback.hidden = false;
    return;
  }

  if (!state.map) {
    state.map = window.L.map('map', {
      center: [12.9716, 77.5946],
      zoom: 12,
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: true
    });

    const tiles = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    });

    tiles.on('tileerror', () => {
      state.tileErrors += 1;
      if (state.tileErrors === 4) {
        if (loading) loading.hidden = true;
        if (fallback) fallback.hidden = false;
        const count = $('mapCount');
        if (count) count.hidden = true;
      }
    });

    tiles.addTo(state.map);
    state.markerLayer = window.L.layerGroup().addTo(state.map);
  }

  state.mapReady = true;
  if (loading) loading.hidden = true;
  renderMapMarkers();
  setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 120);
}

function markerIcon(color) {
  return window.L.divIcon({
    className: 'fb-marker',
    html: `<div class="marker-pin ${color}"><svg class="ico" aria-hidden="true"><use href="#i-utensils"></use></svg></div>`,
    iconSize: [29, 29],
    iconAnchor: [14, 28],
    popupAnchor: [0, -25]
  });
}

function renderMapMarkers() {
  if (!state.mapReady || !state.map || !state.markerLayer) return;
  state.markerLayer.clearLayers();

  const points = filteredPoints();
  const bounds = [];

  points.forEach(point => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
    const hasFood = point.currentFood.length > 0;
    const marker = window.L.marker([point.lat, point.lng], { icon: markerIcon(hasFood ? 'green' : 'blue'), title: point.name });
    marker.bindPopup(pointPopupHtml(point), { maxWidth: 340, minWidth: 300, autoPanPadding: [26, 26] });
    marker.addTo(state.markerLayer);
    bounds.push([point.lat, point.lng]);
  });

  const count = $('mapCount');
  if (count) {
    count.hidden = false;
    count.textContent = `${points.length} verified food point${points.length === 1 ? '' : 's'}`;
  }

  if (bounds.length === 1) {
    state.map.setView(bounds[0], 13);
  } else if (bounds.length > 1) {
    state.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 13 });
  } else {
    state.map.setView([12.9716, 77.5946], 12);
  }
}

function pointPopupHtml(point) {
  const foods = point.currentFood;
  const food = foods[0];
  const category = food ? food.category : 'vegetables';
  const badges = food
    ? `<span class="badge blue">${escapeHtml(CATEGORY_LABELS[food.category] || 'Food')}</span>${dietBadgesHtml(food.dietBadges, 1)}`
    : `<span class="badge green">Verified partner</span>`;

  return `
    <div class="fb-map-pop">
      <div class="fb-map-pop-media"><img src="${foodImage(category)}" alt="${escapeHtml(food ? food.name : point.name)}" decoding="async" /></div>
      <div class="fb-map-pop-body">
        <p class="fb-map-pop-kicker">${food ? 'Incoming food nearby' : 'Community food point'}</p>
        <h3 class="fb-map-pop-title">${escapeHtml(point.name)}</h3>
        <div class="fb-map-pop-badges">${badges}</div>
        <div class="fb-map-pop-meta"><svg class="ico" aria-hidden="true"><use href="#i-utensils"></use></svg><span>${food ? quantityLabel(food) : 'No matched food listed right now'}</span></div>
        <div class="fb-map-pop-meta"><svg class="ico" aria-hidden="true"><use href="#i-clock"></use></svg><span>${escapeHtml(point.operatingHours)}</span></div>
        <div class="fb-map-pop-meta"><svg class="ico" aria-hidden="true"><use href="#i-map-pin"></use></svg><span>${point.distanceKm != null ? `${formatDistance(point.distanceKm)} away` : escapeHtml(point.address)}</span></div>
        <button class="fb-map-pop-btn" type="button" onclick="openDetail('point','${escapeHtml(point.id)}')">View details</button>
      </div>
    </div>`;
}

function formatDistance(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)} km` : 'Nearby';
}

function applyFilters() {
  renderListings();
  renderMapMarkers();
}

function resetFilters() {
  state.search = '';
  state.category = '';
  const search = $('mapSearch');
  const category = $('categoryFilter');
  if (search) search.value = '';
  if (category) category.value = '';
  applyFilters();
}

/* ── Detail modal ──────────────────────────────────────────────────────── */
function openDetail(kind, id) {
  const modal = $('detailModal');
  const content = $('detailContent');
  if (!modal || !content) return;

  const item = state.points.find(point => String(point.id) === String(id));
  if (!item) {
    showToast('That food point is no longer available.');
    return;
  }

  content.innerHTML = pointDetailHtml(item);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  syncBodyLock();
  const close = modal.querySelector('.modal-close');
  if (close) close.focus();
}

function closeDetail() {
  const modal = $('detailModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  syncBodyLock();
}

function pointDetailHtml(point) {
  const foods = point.currentFood;
  const food = foods[0];
  const category = food ? food.category : 'vegetables';
  const foodItems = foods.map(f => {
    return `<li><svg class="ico" aria-hidden="true"><use href="#i-utensils"></use></svg>
      <span>${escapeHtml(f.name)} · ${quantityLabel(f)} <em style="font-style:normal;color:#7B877F">(incoming match)</em></span></li>`;
  }).join('');

  return `
    <div class="detail-hero">
      <img src="${foodImage(category)}" alt="${escapeHtml(food ? food.name : point.name)}" />
      <span class="detail-kicker">Verified community food point</span>
    </div>
    <div class="detail-body">
      <h2 class="detail-title" id="detail-title">${escapeHtml(point.name)}</h2>
      <p class="detail-sub">${escapeHtml(point.address)}</p>
      <div class="detail-badges">
        <span class="badge green">Verified partner</span>
        ${point.activeIncoming ? `<span class="badge blue">${point.activeIncoming} active incoming match${point.activeIncoming === 1 ? '' : 'es'}</span>` : ''}
        ${food ? `<span class="badge blue">${escapeHtml(CATEGORY_LABELS[food.category] || 'Food')}</span>` : ''}
      </div>
      <div class="detail-grid">
        <div class="detail-row"><small>Hours</small><span>${escapeHtml(point.operatingHours)}</span></div>
        <div class="detail-row"><small>Distance</small><span>${point.distanceKm != null ? `${formatDistance(point.distanceKm)} from city centre` : 'Set your location in the food finder'}</span></div>
        <div class="detail-row"><small>Meal capacity</small><strong>${point.servingCapacity ? `${formatNumber(point.servingCapacity)} meals/day` : 'Not published'}</strong></div>
        <div class="detail-row"><small>Contact</small><span>${escapeHtml(point.contactPhone || 'Use the food finder for details')}</span></div>
      </div>
      ${foodItems ? `<ul class="detail-list">${foodItems}</ul>` : ''}
      <p class="detail-note">${escapeHtml(point.description || 'Contact the access point for collection instructions and current availability.')}</p>
      <div class="detail-actions">
        <a class="btn-card btn-card-green" href="/recipient/">Open food finder <svg class="ico" aria-hidden="true"><use href="#i-arrow-right"></use></svg></a>
        <button class="btn-card btn-card-outline" type="button" onclick="closeDetail()">Close</button>
      </div>
    </div>`;
}

/* ── Navigation, scrollspy and page init ──────────────────────────────── */
function setupHeaderScroll() {
  const header = $('siteHeader');
  if (!header) return;
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

function setupScrollspy() {
  const links = Array.from(document.querySelectorAll('.nav-link'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  const sections = Array.from(document.querySelectorAll('main section[id]'));
  if (!sections.length) return;

  const setActive = id => {
    links.forEach(link => {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${id}`);
    });
  };

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) setActive(entry.target.id);
    });
  }, { rootMargin: '-34% 0px -58% 0px', threshold: 0 });

  sections.forEach(section => observer.observe(section));
}

function setupFilters() {
  const search = $('mapSearch');
  const category = $('categoryFilter');

  if (search) {
    search.addEventListener('input', debounce(() => {
      state.search = String(search.value || '').trim().toLowerCase();
      applyFilters();
    }, 140));
  }

  if (category) {
    category.addEventListener('change', () => {
      state.category = category.value;
      applyFilters();
    });
  }
}

function setupAccessibility() {
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const detail = $('detailModal');
    const auth = $('authModal');
    if (detail && detail.classList.contains('open')) {
      closeDetail();
    } else if (auth && auth.classList.contains('open')) {
      closeAuth();
    } else {
      closeMobileMenu();
    }
  });

  document.querySelectorAll('.mobile-link').forEach(link => {
    link.addEventListener('click', closeMobileMenu);
  });
}

function initLanding() {
  updateSessionUI();
  setupHeaderScroll();
  setupScrollspy();
  setupFilters();
  setupAccessibility();

  const year = $('footerYear');
  if (year) year.textContent = String(new Date().getFullYear());

  window.addEventListener('resize', debounce(() => {
    if (state.map) state.map.invalidateSize();
  }, 180));

  loadHomeData();
}

document.addEventListener('DOMContentLoaded', initLanding);
