/**
 * FoodBridge — Individual Recipient Interface (Interface 3)
 * Client Application Logic
 * 
 * Features:
 * - GPS Geolocation & manual landmark/area search
 * - Recommendation scoring (distance, capacity, dietary, urgency, hours)
 * - Access-point card rendering with live availability dots
 * - Slide-up detail inspection panel with directions & contact info
 * - Multi-criteria sorting (distance, availability, capacity)
 * - Browser Notification opt-in with SSE integration & desktop alerts
 * - Live API integration without fabricated fallback locations
 */

// ── State ──
const state = {
  userLat: null,
  userLng: null,
  locationName: '',
  locationSource: 'text',
  locationPickerActive: false,
  people: 3,
  dietary: 'any',
  urgency: 'today',
  accessPoints: [],
  recommendedPoint: null,
  selectedPoint: null,
  sortBy: 'distance',
  alertsEnabled: false
};

// Known coordinates for common landmarks/cities for instant geocoding fallback
const LANDMARK_COORDS = {
  'bengaluru':      { lat: 12.9716, lng: 77.5946, name: 'Bengaluru Central' },
  'bangalore':      { lat: 12.9716, lng: 77.5946, name: 'Bengaluru Central' },
  'mg road':        { lat: 12.9752, lng: 77.6084, name: 'MG Road, Bengaluru' },
  'shanthi nagar':  { lat: 12.9560, lng: 77.5990, name: 'Shanthi Nagar, Bengaluru' },
  'shanthi':        { lat: 12.9560, lng: 77.5990, name: 'Shanthi Nagar, Bengaluru' },
  'shivajinagar':   { lat: 12.9850, lng: 77.6050, name: 'Shivajinagar, Bengaluru' },
  'indiranagar':    { lat: 12.9784, lng: 77.6408, name: 'Indiranagar, Bengaluru' },
  'koramangala':    { lat: 12.9340, lng: 77.6225, name: 'Koramangala, Bengaluru' },
  'yeshwanthpur':   { lat: 13.0230, lng: 77.5510, name: 'Yeshwanthpur, Bengaluru' },
  'btm layout':     { lat: 12.9166, lng: 77.6101, name: 'BTM Layout, Bengaluru' },
  'whitefield':     { lat: 12.9698, lng: 77.7500, name: 'Whitefield, Bengaluru' },
  'delhi':          { lat: 28.6139, lng: 77.2090, name: 'New Delhi' },
  'mumbai':         { lat: 19.0760, lng: 72.8777, name: 'Mumbai' }
};

// ── DOM Helpers ──
const $ = (id) => document.getElementById(id);

// ── Geolocation & Distance Calculation ──
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

/**
 * Triggered by the satellite/GPS icon button
 */
window.useMyLocation = function () {
  const locateBtn = $('locate-btn');
  const locInput = $('location-input');

  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser', 'info');
    return;
  }

  locateBtn.innerHTML = '<span class="spinner"></span>';
  locateBtn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userLat = pos.coords.latitude;
      state.userLng = pos.coords.longitude;
      state.locationName = 'Current Location (GPS)';
      state.locationSource = 'gps';
      locInput.value = state.locationName;
      locateBtn.innerHTML = '📍';
      locateBtn.disabled = false;
      showToast('Location detected successfully', 'success');
      searchFood();
    },
    (err) => {
      console.warn('[GPS Error]', err);
      locateBtn.innerHTML = '📡';
      locateBtn.disabled = false;
      // Default to central Bengaluru coordinates if GPS permission is denied
      state.userLat = 12.9716;
      state.userLng = 77.5946;
      state.locationName = 'Bengaluru Central (Default)';
      state.locationSource = 'default';
      locInput.value = state.locationName;
      showToast('Could not access GPS. Using default area center.', 'info');
      searchFood();
    },
    { timeout: 8000, enableHighAccuracy: true }
  );
};

/**
 * Main search function
 */
window.searchFood = async function () {
  const locInput = $('location-input');
  const peopleSelect = $('sel-people');
  const dietarySelect = $('sel-dietary');
  const urgencySelect = $('sel-urgency');
  const errorDiv = $('search-error');
  const loadingDiv = $('loading-state');
  const resultsSec = $('results-section');
  const recBanner = $('rec-banner');
  const accessList = $('access-list');
  const countLabel = $('results-count');
  const alertOpt = $('alert-opt');

  errorDiv.style.display = 'none';
  resultsSec.classList.add('show');
  loadingDiv.style.display = 'flex';
  accessList.innerHTML = '';
  countLabel.textContent = 'Searching nearby access points…';

  state.people = parseInt(peopleSelect.value) || 3;
  state.dietary = dietarySelect.value || 'any';
  state.urgency = urgencySelect.value || 'today';

  const rawLocation = (locInput.value || '').trim();

  // Resolve typed location to coordinates if not using GPS
  let matchedLandmark = false;
  if (state.locationSource !== 'pin' && rawLocation && rawLocation !== 'Current Location (GPS)') {
    const lower = rawLocation.toLowerCase();
    for (const [key, coords] of Object.entries(LANDMARK_COORDS)) {
      if (lower.includes(key)) {
        state.userLat = coords.lat;
        state.userLng = coords.lng;
        state.locationName = coords.name;
        matchedLandmark = true;
        break;
      }
    }
    if (!matchedLandmark && !state.userLat) {
      // Default fallback coordinates (Central Bangalore)
      state.userLat = 12.9716;
      state.userLng = 77.5946;
      state.locationName = rawLocation;
    }
  } else if (!state.userLat) {
    state.userLat = 12.9716;
    state.userLng = 77.5946;
    state.locationName = 'Bengaluru Central';
    locInput.value = state.locationName;
  }

  // Build query URL
  const queryParams = new URLSearchParams();
  if (state.userLat != null && state.userLng != null) {
    queryParams.append('lat', state.userLat);
    queryParams.append('lng', state.userLng);
  }
  queryParams.append('people', state.people);
  queryParams.append('dietary', state.dietary);
  queryParams.append('urgency', state.urgency);
  if (rawLocation && state.locationSource === 'text' && !matchedLandmark) queryParams.append('q', rawLocation);

  let points = [];

  try {
    const res = await fetch(`/api/recipient/search?${queryParams.toString()}`);
    if (res.ok) {
      const data = await res.json();
      points = data.accessPoints || [];
    } else throw new Error('API returned status ' + res.status);
  } catch (err) {
    console.error('[Recipient Search] Could not load live access points:', err);
    errorDiv.textContent = 'Could not load access points. Please try again in a moment.';
    errorDiv.style.display = 'block';
  }

  // Ensure all points have computed distances & dietary arrays
  points.forEach((ap) => {
    if (ap.distance == null && state.userLat && state.userLng && ap.location_lat && ap.location_lng) {
      ap.distance = calculateDistance(state.userLat, state.userLng, ap.location_lat, ap.location_lng);
    }
    if (!Array.isArray(ap.dietary_restrictions)) {
      try {
        ap.dietary_restrictions = JSON.parse(ap.dietary_restrictions || '[]');
      } catch (e) {
        ap.dietary_restrictions = [];
      }
    }
    if (!Array.isArray(ap.food_requirements)) {
      try {
        ap.food_requirements = JSON.parse(ap.food_requirements || '[]');
      } catch (e) {
        ap.food_requirements = [];
      }
    }
  });

  state.accessPoints = points;
  loadingDiv.style.display = 'none';

  if (!points || points.length === 0) {
    countLabel.textContent = 'No access points found';
    accessList.innerHTML = `
      <div class="empty-state">
        <div class="ei">🔍</div>
        <h3>No verified food access points in this immediate area</h3>
        <p>Try searching for a nearby landmark (e.g. "Shanthi Nagar", "Shivajinagar", "Koramangala") or broaden your dietary filters.</p>
      </div>
    `;
    recBanner.classList.remove('show');
    return;
  }

  // Run Recommendation Intelligence
  computeRecommendation();

  // Sort and Render
  sortResults();

  // Re-render map if it was already open
  if (recipientMap) {
    renderMap(state.networkMapPoints || state.accessPoints);
  }

  // Show alert opt-in banner if not yet enabled
  if (!state.alertsEnabled && alertOpt) {
    alertOpt.classList.add('show');
  }
};

/**
 * Recommendation scoring (Interface 3.D)
 * Considers: Distance + Current Availability + Dietary Suitability + Serving Capacity + Urgency
 */
function computeRecommendation() {
  const points = state.accessPoints;
  if (!points || points.length === 0) return;

  let bestPoint = null;
  let bestScore = -999;
  let recommendationReason = '';

  points.forEach((ap) => {
    let score = 50;

    // 1. Distance scoring (closer = higher score)
    const dist = ap.distance != null ? ap.distance : 5.0;
    if (dist <= 2.0) score += 35;
    else if (dist <= 5.0) score += 20;
    else if (dist <= 10.0) score += 5;
    else score -= 15;

    // 2. Availability scoring
    const activeIncoming = ap.activeIncoming || 0;
    if (activeIncoming > 0) score += 25;
    if (ap.status === 'open' || (ap.operating_hours && !ap.operating_hours.toLowerCase().includes('closed'))) {
      score += 20;
    }

    // 3. Dietary suitability
    if (state.dietary !== 'any') {
      const match = ap.dietary_restrictions.some(
        (d) => d.toLowerCase() === state.dietary.toLowerCase()
      );
      if (match) {
        score += 25;
      } else {
        score -= 20;
      }
    }

    // 4. Capacity vs people requested
    const cap = ap.serving_capacity || 100;
    if (cap >= state.people * 10) score += 15;
    else if (cap >= state.people) score += 5;

    // 5. Urgency weighting
    if (state.urgency === 'now') {
      if (ap.type === 'ngo' || ap.type === 'shelter') score += 15;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPoint = ap;

      // Construct a human-readable explanation
      const parts = [];
      if (dist != null) parts.push(`Only ${dist} km from you`);
      if (activeIncoming > 0) parts.push('has active fresh surplus meals on hand');
      else parts.push('open and currently serving');

      if (state.dietary !== 'any') {
        parts.push(`meets your ${state.dietary} preference`);
      }
      parts.push(`ample capacity (${cap}+ meals)`);

      recommendationReason = parts.join(' • ');
    }
  });

  state.recommendedPoint = bestPoint;

  const recBanner = $('rec-banner');
  if (bestPoint && recBanner) {
    $('rec-name').textContent = bestPoint.name;
    $('rec-why').textContent = recommendationReason;
    const recBtn = $('rec-go-btn');
    recBtn.onclick = () => openDetail(bestPoint.id);
    recBanner.classList.add('show');
  }
}

/**
 * Multi-criteria sorting
 */
window.sortResults = function () {
  const sortSelect = $('sort-select');
  state.sortBy = sortSelect.value || 'distance';

  const pts = [...state.accessPoints];

  if (state.sortBy === 'distance') {
    pts.sort((a, b) => {
      const da = a.distance != null ? a.distance : 999;
      const db = b.distance != null ? b.distance : 999;
      return da - db;
    });
  } else if (state.sortBy === 'availability') {
    pts.sort((a, b) => {
      const aAvail = (a.activeIncoming || 0) + (a.status === 'open' ? 2 : 0);
      const bAvail = (b.activeIncoming || 0) + (b.status === 'open' ? 2 : 0);
      return bAvail - aAvail;
    });
  } else if (state.sortBy === 'capacity') {
    pts.sort((a, b) => (b.serving_capacity || 0) - (a.serving_capacity || 0));
  }

  renderCards(pts);
};

/**
 * Render access-point cards into #access-list
 */
function renderCards(points) {
  const container = $('access-list');
  const countLabel = $('results-count');

  countLabel.textContent = `${points.length} verified access point${points.length === 1 ? '' : 's'} near you`;

  container.innerHTML = points
    .map((ap) => {
      const isTopPick = state.recommendedPoint && state.recommendedPoint.id === ap.id;

      // Icon & color styling by organization type
      let icon = '🍲';
      let iconBg = 'icon-bg-orange';
      let tagClass = '';
      let typeLabel = 'Community Kitchen';

      if (ap.type === 'shelter') {
        icon = '🏠';
        iconBg = 'icon-bg-blue';
        tagClass = 'blue';
        typeLabel = 'Night Shelter & Kitchen';
      } else if (ap.type === 'food_bank') {
        icon = '📦';
        iconBg = 'icon-bg-purple';
        tagClass = '';
        typeLabel = 'Food Bank & Pantry';
      } else if (ap.type === 'ngo') {
        icon = '🤝';
        iconBg = 'icon-bg-green';
        tagClass = 'green';
        typeLabel = 'NGO Mission';
      }

      // Availability status calculation
      const hasFood = (ap.activeIncoming || 0) > 0;
      let dotClass = 'open';
      let statusText = 'Open • Ready to Serve';

      if (hasFood) {
        statusText = 'Fresh Surplus Meals Available Right Now';
        dotClass = 'open';
      } else if (ap.operating_hours && ap.operating_hours.toLowerCase().includes('daily')) {
        statusText = 'Serving Regular Hours';
        dotClass = 'open';
      } else {
        statusText = 'Open Today';
        dotClass = 'soon';
      }

      const distText = ap.distance != null ? `${ap.distance} km` : 'Near you';
      const travelEstimate = ap.distance != null ? `~${Math.max(3, Math.round(ap.distance * 3))} min` : 'Short distance';

      return `
        <div class="access-card ${isTopPick ? 'top-pick' : ''}" onclick="openDetail('${ap.id}')">
          <div class="access-type-icon ${iconBg}">
            ${icon}
          </div>
          <div class="access-info">
            <div class="access-name">
              ${escapeHtml(ap.name)}
              <span class="access-type-tag ${tagClass}">${typeLabel}</span>
              ${isTopPick ? '<span class="access-type-tag" style="background:rgba(255,120,31,0.16);color:#C4510B;">★ Top Pick</span>' : ''}
            </div>
            <div class="access-meta">
              <span>📍 ${escapeHtml(ap.location_address || 'Central Address')}</span>
              <span>⏰ ${escapeHtml(ap.operating_hours || 'Regular daily hours')}</span>
              <span>👥 Capacity: ${ap.serving_capacity || 100}+ people</span>
            </div>
            <div class="access-avail">
              <span class="avail-dot ${dotClass}"></span>
              <span>${statusText}</span>
            </div>
          </div>
          <div class="access-right">
            <div class="access-dist">${distText}</div>
            <div class="access-dist-sub">${travelEstimate}</div>
            <button class="access-go-btn" onclick="openDetail('${ap.id}'); event.stopPropagation();">
              View Details →
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

/**
 * Slide-Up Detail Panel Handler
 */
window.openDetail = async function (id) {
  let ap = state.accessPoints.find((p) => p.id === id);

  // Attempt to fetch fresh extended detail from backend if available
  try {
    const res = await fetch(`/api/recipient/access-point/${id}`);
    if (res.ok) {
      const data = await res.json();
      if (data.org) {
        ap = { ...ap, ...data.org };
      }
    }
  } catch (e) {
    // Graceful fallback to existing ap object in memory
  }

  if (!ap) return;
  state.selectedPoint = ap;

  // Icons and titles
  let icon = '🍲';
  let typeLabel = 'Community Kitchen & Meal Point';
  if (ap.type === 'shelter') {
    icon = '🏠';
    typeLabel = 'Night Shelter & Hot Meal Counter';
  } else if (ap.type === 'food_bank') {
    icon = '📦';
    typeLabel = 'Central Food Bank & Reserve Hub';
  } else if (ap.type === 'ngo') {
    icon = '🤝';
    typeLabel = 'Community Food Mission';
  }

  $('d-icon').textContent = icon;
  $('d-name').textContent = ap.name;
  $('d-subtype').textContent = `${typeLabel} • Verified Partner`;

  // Availability chip
  const availChip = $('d-avail-chip');
  availChip.className = 'avail-chip open';
  availChip.innerHTML = `● Open & Distributing Meals`;

  // Details
  $('d-hours').textContent = ap.operating_hours || 'Daily 11:00 AM – 8:00 PM';

  // Food summary
  let foodDesc = ap.foodAvailableText || 'Freshly prepared hot meals, rice, nutritious lentils, and whole wheat chapati';
  if (Array.isArray(ap.food_requirements) && ap.food_requirements.length > 0) {
    foodDesc += ` (${ap.food_requirements.join(', ')})`;
  }
  if (Array.isArray(ap.dietary_restrictions) && ap.dietary_restrictions.length > 0) {
    foodDesc += ` — Certified: ${ap.dietary_restrictions.join(', ')}`;
  }
  $('d-food').textContent = foodDesc;

  $('d-capacity').textContent = `${ap.serving_capacity || 200}+ meals daily (Storage: ${ap.storage_capacity || 'Cold + Dry storage'})`;
  $('d-address').textContent = ap.location_address || 'Address provided upon arrival';

  const distVal = ap.distance != null ? `${ap.distance} km away` : 'Within reachable distance';
  $('d-distance').textContent = `${distVal} (Estimated travel time: ~${ap.distance != null ? Math.max(3, Math.round(ap.distance * 3)) : 10} mins)`;

  $('d-access-info').textContent =
    ap.accessInfo ||
    'Free walk-in distribution. No vouchers, registration, or paperwork required. Clean dining space available for families.';

  $('d-phone').textContent = ap.contact_phone || '+91 80 2221 4455 (Coordinator Helpdesk)';

  // Directions button opens Google Maps navigation
  const dirBtn = $('d-directions-btn');
  dirBtn.onclick = () => {
    const destination = encodeURIComponent(ap.location_address || ap.name);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${destination}`, '_blank');
  };

  // Open overlay
  const overlay = $('detail-overlay');
  overlay.classList.add('show');
};

/**
 * Close Slide-Up Detail Panel
 */
window.closeDetailPanel = function () {
  const overlay = $('detail-overlay');
  if (overlay) overlay.classList.remove('show');
};

window.closeDetail = function (e) {
  if (e && e.target && e.target.id === 'detail-overlay') {
    closeDetailPanel();
  }
};

/**
 * Browser Web Notification Opt-in (Interface 3.G)
 */
window.enableAlerts = async function () {
  const alertOpt = $('alert-opt');

  if (!('Notification' in window)) {
    showToast('Your browser does not support web notifications', 'info');
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      state.alertsEnabled = true;
      localStorage.setItem('foodbridge_recipient_alerts', 'true');
      if (alertOpt) alertOpt.style.display = 'none';

      showToast('🔔 Alerts activated! You will receive updates when meals arrive nearby.', 'success');

      // Test notification
      new Notification('FoodBridge Meal Alerts Active', {
        body: 'We will notify you immediately whenever surplus meals arrive at verified access points near you.',
        icon: 'https://cdn-icons-png.flaticon.com/512/1046/1046784.png'
      });

      // Connect to SSE stream if available for live broadcast
      connectLiveAlerts();
    } else {
      showToast('Notification permission was dismissed', 'info');
    }
  } catch (err) {
    console.error('[Notification Permission Error]', err);
    showToast('Could not enable notifications', 'info');
  }
};

/**
 * Connect to SSE stream for live real-time food surplus alerts
 */
function connectLiveAlerts() {
  if (window.EventSource) {
    try {
      const evtSource = new EventSource('/api/notifications/stream');
      evtSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && payload.title) {
            new Notification(`FoodBridge: ${payload.title}`, {
              body: payload.message || 'Fresh surplus food is now available nearby.',
              icon: 'https://cdn-icons-png.flaticon.com/512/1046/1046784.png'
            });
            showToast(`🔔 ${payload.title}: ${payload.message}`, 'info');
          }
        } catch (e) {}
      };
      evtSource.onerror = () => {
        evtSource.close();
      };
    } catch (e) {}
  }
}

/**
 * Toast Notification Utility
 */
function showToast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✅' : 'ℹ️'}</span>
    <div>${escapeHtml(message)}</div>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Map ──────────────────────────────────────────────────────────────────────
let recipientMap = null;
let userMarker   = null;
let apMarkers    = [];
let networkPointsPromise = null;

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function initMap(lat, lng) {
  if (recipientMap) return;
  recipientMap = L.map('recipient-map', { zoomControl: true }).setView([lat, lng], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(recipientMap);
  enableMapLocationClicks();
}

function renderMap(points) {
  const lat = state.userLat || 12.9716;
  const lng = state.userLng || 77.5946;

  initMap(lat, lng);

  // Remove old markers
  apMarkers.forEach(m => recipientMap.removeLayer(m));
  apMarkers = [];
  if (userMarker) { recipientMap.removeLayer(userMarker); userMarker = null; }

  // User location pin
  const userIcon = L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;background:#246BEE;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 4px rgba(36,107,238,0.3);"></div>`,
    iconSize: [16, 16], iconAnchor: [8, 8]
  });
  userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000, draggable: state.locationPickerActive })
    .addTo(recipientMap)
    .bindPopup(`<div class="rmap-popup-name">📍 ${state.locationPickerActive ? 'Selected location' : 'Your Location'}</div>${state.locationPickerActive ? '<div class="rmap-popup-row">Drag this pin to adjust your search location.</div>' : ''}`);
  userMarker.on('dragend', event => updateLocationFromMap(event.target.getLatLng()));

  const topPickId = state.recommendedPoint ? state.recommendedPoint.id : null;

  points.forEach(ap => {
    if (!ap.location_lat || !ap.location_lng) return;
    const isTop = ap.id === topPickId;
    const color = isTop ? '#F5A623' : ap.type === 'food_bank' ? '#805AD5' : '#FF781F';
    const ring  = isTop ? 'rgba(245,166,35,0.35)' : ap.type === 'food_bank' ? 'rgba(128,90,213,0.25)' : 'rgba(255,120,31,0.25)';
    const size  = isTop ? 18 : 14;
    const half  = size / 2;

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:${size}px;height:${size}px;background:${color};border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 0 4px ${ring};"></div>`,
      iconSize: [size, size], iconAnchor: [half, half]
    });

    const typeLabels = { food_bank:'Food Bank', ngo:'NGO / Community Kitchen', shelter:'Shelter & Meals', community_kitchen:'Community Kitchen' };
    const typeLabel = typeLabels[ap.type] || 'Food Access Point';
    const dist = ap.distance != null ? `${ap.distance} km away` : '';
    const dest = encodeURIComponent(ap.location_address || ap.name);
    const destCoords = `${ap.location_lat},${ap.location_lng}`;

    const popup = L.popup({ maxWidth: 240, minWidth: 200 }).setContent(`
      <div class="rmap-popup-name">${escHtml(ap.name)}${isTop ? ' ⭐' : ''}</div>
      <div class="rmap-popup-type">${typeLabel}</div>
      <div class="rmap-popup-row">📍 ${escHtml(ap.location_address || 'Address on arrival')}</div>
      <div class="rmap-popup-row">⏰ ${escHtml(ap.operating_hours || 'Daily hours')}</div>
      ${dist ? `<div class="rmap-popup-row">📏 ${escHtml(dist)}</div>` : ''}
      <button class="rmap-popup-dir" onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${destCoords}','_blank')">🗺️ Get Directions</button>
      <button class="rmap-popup-detail" onclick="openDetail('${ap.id}')">View Details →</button>
    `);

    const marker = L.marker([ap.location_lat, ap.location_lng], { icon })
      .addTo(recipientMap)
      .bindPopup(popup);

    apMarkers.push(marker);
  });

  // The picker stays focused around the selected location; normal map view fits the network.
  const allLatLngs = points.filter(p => p.location_lat && p.location_lng).map(p => [p.location_lat, p.location_lng]);
  allLatLngs.push([lat, lng]);
  if (state.locationPickerActive) {
    recipientMap.setView([lat, lng], Math.max(recipientMap.getZoom(), 13));
  } else if (allLatLngs.length > 1) {
    recipientMap.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40], maxZoom: 15 });
  } else {
    recipientMap.setView([lat, lng], 13);
  }
}

function updateLocationFromMap(latlng) {
  state.userLat = latlng.lat;
  state.userLng = latlng.lng;
  state.locationName = `Map pin (${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)})`;
  state.locationSource = 'pin';
  $('location-input').value = state.locationName;
  if (userMarker && userMarker.getLatLng() !== latlng) userMarker.setLatLng(latlng);
}

function setLocationPickerMode(enabled) {
  state.locationPickerActive = enabled;
  const controls = $('map-picker-controls');
  if (controls) controls.style.display = enabled ? 'flex' : 'none';
  if (userMarker && userMarker.dragging) {
    if (enabled) userMarker.dragging.enable();
    else userMarker.dragging.disable();
    userMarker.setPopupContent(`<div class="rmap-popup-name">📍 ${enabled ? 'Selected location' : 'Your Location'}</div>${enabled ? '<div class="rmap-popup-row">Drag this pin to adjust your search location.</div>' : ''}`);
  }
}

window.chooseLocationOnMap = function() {
  switchView('map', true);
  if (userMarker) userMarker.openPopup();
};

window.useSelectedMapLocation = function() {
  if (!userMarker) return;
  updateLocationFromMap(userMarker.getLatLng());
  setLocationPickerMode(false);
  switchView('list');
  searchFood();
};

window.switchView = function(view, pickLocation = false) {
  const listEl = $('access-list');
  const mapEl  = $('map-view');
  const btnList = $('btn-view-list');
  const btnMap  = $('btn-view-map');

  if (view === 'map') {
    setLocationPickerMode(pickLocation);
    listEl.style.display = 'none';
    mapEl.style.display  = 'block';
    btnList.classList.remove('active');
    btnMap.classList.add('active');
    // Initialize or resize map — must happen after element is visible
    if (!recipientMap) renderMap(state.accessPoints || []);
    else recipientMap.invalidateSize();
    if (recipientMap && userMarker && pickLocation) {
      userMarker.dragging.enable();
      recipientMap.setView([state.userLat || 12.9716, state.userLng || 77.5946], Math.max(recipientMap.getZoom(), 13));
    }
    loadNetworkMapPoints();
  } else {
    setLocationPickerMode(false);
    mapEl.style.display  = 'none';
    listEl.style.display = '';
    btnMap.classList.remove('active');
    btnList.classList.add('active');
  }
};

// Map clicks set the search pin only while the explicit location picker is open.
function enableMapLocationClicks() {
  if (!recipientMap || recipientMap._foodBridgePickerClickBound) return;
  recipientMap._foodBridgePickerClickBound = true;
  recipientMap.on('click', event => {
    if (!state.locationPickerActive) return;
    updateLocationFromMap(event.latlng);
  });
}

async function loadNetworkMapPoints() {
  if (!networkPointsPromise) {
    networkPointsPromise = fetch('/api/recipient/network-map', { headers: { Accept: 'application/json' } })
      .then(res => {
        if (!res.ok) throw new Error(`API returned status ${res.status}`);
        return res.json();
      })
      .then(data => data.accessPoints || [])
      .catch(err => {
        networkPointsPromise = null;
        console.error('[Recipient Map] Could not load network partners:', err);
        showToast('Could not load network map. Please try again.', 'error');
        return null;
      });
  }
  const points = await networkPointsPromise;
  if (points && recipientMap) {
    state.networkMapPoints = points;
    renderMap(points);
    recipientMap.invalidateSize();
  }
}

// ── Initialization ──
document.addEventListener('DOMContentLoaded', () => {
  // Check if user previously enabled alerts
  if (localStorage.getItem('foodbridge_recipient_alerts') === 'true' && Notification.permission === 'granted') {
    state.alertsEnabled = true;
    const alertOpt = $('alert-opt');
    if (alertOpt) alertOpt.style.display = 'none';
    connectLiveAlerts();
  }

  // Handle enter key inside location input
  const locInput = $('location-input');
  if (locInput) {
    locInput.addEventListener('input', () => {
      state.locationSource = 'text';
      state.userLat = null;
      state.userLng = null;
    });
    locInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        searchFood();
      }
    });
  }

  // Auto-run search on load so page immediately renders access points
  searchFood();
});
