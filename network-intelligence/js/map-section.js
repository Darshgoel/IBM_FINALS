/**
 * FoodBridge — Network Intelligence dashboard, embedded Network Map section.
 *
 * The map used to live only on the standalone ./map.html page, which forced a
 * full page navigation ("redirect") whenever coordinators opened the map from
 * the dashboard. This module embeds the very same map — markers, layer
 * toggles, OSM discovery, import and donor routing — as an in-dashboard
 * section (#page-network-map) so no navigation is required.
 *
 * Behaviour is intentionally identical to network-intelligence/map.html:
 *   - live data only, sourced from /api/network/map-data (no demo fallback)
 *   - OSM discoveries are map-sourced only, importable via osm-import
 *   - road routes via /api/network/route-preview (OSRM with haversine fallback)
 * The standalone ./map.html page remains for direct links/bookmarks.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id) || null;
  const token = () => localStorage.getItem('token') || localStorage.getItem('fb_token');

  const state = {
    inited: false,
    map: null,
    layers: null,
    allMarkers: [],
    osmSeen: new Set(),
    markerMap: new Map(),
    routePolyline: null,
    originMarker: null,
    discoverTimer: null
  };

  const DONOR_TYPES = new Set(['hotel', 'caterer', 'retailer', 'institution', 'donor', 'other_donor']);
  const ORG_COLORS = { donor: '#2563EB', demand: '#16833B', foodbank: '#D97706' };

  function classifyOrg(type) {
    if (DONOR_TYPES.has(type)) return 'donor';
    if (type === 'food_bank') return 'foodbank';
    return 'demand';
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setStatus(msg) {
    const el = $('nmap-status');
    if (el) el.textContent = msg;
  }

  function circleOpts(color, r) {
    return { radius: r || 8, fillColor: color, color: '#fff', weight: 1.5, opacity: 0.9, fillOpacity: 0.85 };
  }

  /* ── Side panel ────────────────────────────────────────────────────── */

  function openPanel(title, bodyHtml) {
    $('nmap-sp-title').textContent = title;
    $('nmap-sp-body').innerHTML = bodyHtml;
    $('nmap-sp-route').innerHTML = '';
    $('nmap-panel').classList.add('open');
  }

  function closePanel() {
    $('nmap-panel').classList.remove('open');
    clearRoute();
  }

  function row(label, value) {
    return `<div class="nmap-row"><span class="nmap-row-label">${label}</span><span class="nmap-row-value">${value}</span></div>`;
  }

  /* ── Route overlays ────────────────────────────────────────────────── */

  function clearRoute() {
    const spRoute = $('nmap-sp-route');
    if (spRoute) spRoute.innerHTML = '';
    if (state.routePolyline) { state.map.removeLayer(state.routePolyline); state.routePolyline = null; }
    if (state.originMarker) { state.map.removeLayer(state.originMarker); state.originMarker = null; }
  }

  // originLatLng = marker we route FROM (must be a donor), destLatLng = target
  function showRoute(originLatLng, destLatLng, destName) {
    clearRoute();
    const spRoute = $('nmap-sp-route');
    spRoute.innerHTML = '<p class="nmap-route-loading">⏳ Loading road route…</p>';

    const url = `/api/network/route-preview?oLat=${originLatLng[0]}&oLng=${originLatLng[1]}&dLat=${destLatLng[0]}&dLng=${destLatLng[1]}`;
    fetch(url, { headers: { Authorization: 'Bearer ' + token() } })
      .then(r => r.json())
      .then(data => {
        const dist = data.distanceKm != null ? data.distanceKm.toFixed(1) + ' km' : '—';
        const dur = data.durationMinutes != null ? Math.round(data.durationMinutes) + ' min' : '—';
        const isApprox = (data.provider || '').includes('haversine') || (data.provider || '').includes('approx');
        const provClass = isApprox ? 'approx' : '';
        const provLabel = isApprox ? '⚠ Approximate (straight-line)' : `Road route (${data.provider})`;

        spRoute.innerHTML = `
          <div class="nmap-route-info">
            <div class="nmap-ri-title">🛣️ Route to ${escHtml(destName)}</div>
            <div class="nmap-ri-row"><span>Distance</span><strong>${dist}</strong></div>
            <div class="nmap-ri-row"><span>ETA</span><strong>${dur}</strong></div>
            <div class="nmap-ri-row"><span>Provider</span><span class="nmap-provider ${provClass}">${provLabel}</span></div>
            ${data.error ? `<div class="nmap-note">Note: ${escHtml(data.error)}</div>` : ''}
          </div>`;

        const coords = (data.geometry && data.geometry.length > 1) ? data.geometry : [originLatLng, destLatLng];
        state.routePolyline = L.polyline(coords, {
          color: isApprox ? '#D97706' : '#2563EB',
          weight: isApprox ? 2 : 3,
          opacity: 0.8,
          dashArray: isApprox ? '6 4' : null
        }).addTo(state.map);

        state.originMarker = L.circleMarker(originLatLng, { radius: 6, fillColor: '#fff', color: '#2563EB', weight: 2, fillOpacity: 1 }).addTo(state.map);
        state.map.fitBounds(state.routePolyline.getBounds(), { padding: [40, 40] });
        setStatus(`Route: ${dist} / ${dur} via ${provLabel}`);
      })
      .catch(err => {
        spRoute.innerHTML = `<p class="nmap-note" style="color:var(--fb-error);">Route unavailable: ${escHtml(err.message)}</p>`;
      });
  }

  window._nmapShowRouteFrom = function (lat, lng, name) {
    mapObj().closePopup();
    setStatus(`Route origin set: ${name}. Now click any destination marker to open its route.`);
    if (state.originMarker) state.map.removeLayer(state.originMarker);
    state.originMarker = L.circleMarker([lat, lng], { radius: 9, fillColor: '#fff', color: '#2563EB', weight: 3, fillOpacity: 0.9 }).addTo(state.map);
    state.allMarkers.forEach(({ latlng, name: mName, marker }) => {
      if (latlng[0] === lat && latlng[1] === lng) return;
      marker.off('click').on('click', () => {
        openPanel(mName, `<p class="nmap-panel-hint">Showing route from <strong>${escHtml(name)}</strong></p>`);
        showRoute([lat, lng], latlng, mName);
      });
    });
  };

  // Late-bound map access while init() is in progress
  function mapObj() { return state.map; }

  /* ── Data load ─────────────────────────────────────────────────────── */

  function clearDataLayers() {
    ['donor', 'demand', 'foodbank', 'biogas'].forEach(key => state.layers[key].clearLayers());
    // note: OSM-discovered layer intentionally persists (still valid)
    state.allMarkers = state.allMarkers.filter(m => !m.db);
    state.osmSeen.forEach(() => {}); // discovery cache kept
  }

  async function refreshNmapData(announce) {
    if (!state.map) return;
    if (announce) setStatus('Reloading network data…');

    try {
      const res = await fetch('/api/network/map-data', { headers: { Authorization: 'Bearer ' + token() } });
      if (res.status === 401 || res.status === 403) { window.location.replace('/ops/'); throw new Error('Auth'); }
      const data = await res.json();
      const orgs = data.organizations || [];
      const facs = data.biogas_facilities || [];

      clearDataLayers();

      orgs.forEach(org => {
        if (!org.lat || !org.lng) return;
        const cls = classifyOrg(org.type);
        const color = ORG_COLORS[cls] || '#5D685F';
        const vBadge = org.verified ? '<span class="nmap-badge-v">✓ Verified</span>' : '<span class="nmap-badge-p">Pending</span>';
        const mvBadge = org.mapVerified ? ' <span class="nmap-badge-v">📍 Map OK</span>' : '';
        const latlng = [org.lat, org.lng];

        const marker = L.circleMarker(latlng, circleOpts(color))
          .bindPopup(`
            <div class="nmap-pop-name">${escHtml(org.name)}${vBadge}${mvBadge}</div>
            <div class="nmap-pop-type">${(org.type || '').replace(/_/g, ' ')}</div>
            <div class="nmap-pop-addr">📍 ${escHtml(org.address || 'Address not set')}</div>
            <div class="nmap-pop-status">Status: ${escHtml(org.status)}</div>
            ${cls === 'donor' ? `<button class="nmap-pop-btn" onclick="window._nmapShowRouteFrom(${org.lat},${org.lng},'${escHtml(org.name)}')">🛣 Show routes from here</button>` : ''}
          `);

        marker.on('click', () => {
          openPanel(org.name, `
            ${row('Type', (org.type || '').replace(/_/g, ' '))}
            ${row('Address', escHtml(org.address || '—'))}
            ${row('Status', escHtml(org.status))}
            ${row('Verified', org.verified ? '✓ Yes' : '✗ No')}
            ${row('Map verified', org.mapVerified ? '✓ Yes' : '✗ No')}
          `);
        });

        state.layers[cls].addLayer(marker);
        state.allMarkers.push({ latlng, name: org.name, marker, db: true });
      });

      facs.forEach(fac => {
        if (!fac.lat || !fac.lng) return;
        const vBadge = fac.verified ? '<span class="nmap-badge-v">✓ Verified</span>' : '<span class="nmap-badge-p">Pending</span>';
        const waste = Array.isArray(fac.acceptedWasteTypes) && fac.acceptedWasteTypes.length ? fac.acceptedWasteTypes.join(', ') : 'All types';
        const latlng = [fac.lat, fac.lng];

        const marker = L.circleMarker(latlng, circleOpts('#7C3AED', 10))
          .bindPopup(`
            <div class="nmap-pop-name">♻️ ${escHtml(fac.name)}${vBadge}</div>
            <div class="nmap-pop-type">Biogas Facility</div>
            <div class="nmap-pop-addr">📍 ${escHtml(fac.address || 'Address not set')}</div>
            <div class="nmap-pop-meta">Capacity: ${fac.maxDailyIntakeKg || '—'} kg/day</div>
            <div class="nmap-pop-meta">Accepts: ${escHtml(waste)}</div>
            <div class="nmap-pop-status">Status: ${escHtml(fac.status)}</div>
          `);

        marker.on('click', () => {
          openPanel('♻️ ' + fac.name, `
            ${row('Type', 'Biogas Facility')}
            ${row('Address', escHtml(fac.address || '—'))}
            ${row('Status', escHtml(fac.status))}
            ${row('Verified', fac.verified ? '✓ Yes' : '✗ No')}
            ${row('Daily capacity', (fac.maxDailyIntakeKg || '—') + ' kg/day')}
            ${row('Accepts', escHtml(waste))}
          `);
        });

        state.layers.biogas.addLayer(marker);
        state.allMarkers.push({ latlng, name: fac.name, marker, db: true });
      });

      const total = orgs.length + facs.length;
      $('nm-count').textContent = `${total} DB locations`;
      setStatus(`${total} markers loaded. Click a marker for details, or click a donor → "Show routes from here". Use "Discover area" to find more from OSM.`);

      window._nmapFitAll();
    } catch (err) {
      if (err.message !== 'Auth') setStatus('Failed to load map data: ' + err.message);
    }
  }
  window.refreshNmapData = refreshNmapData;

  /* ── Fit all ───────────────────────────────────────────────────────── */

  window._nmapFitAll = function () {
    if (!state.map) return;
    const pts = state.allMarkers.map(m => m.latlng);
    if (pts.length === 0) return;
    state.map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  };

  /* ── Search ────────────────────────────────────────────────────────── */

  function doSearch() {
    const q = ($('nmap-search-input')?.value || '').trim().toLowerCase();
    if (!q) return;

    const match = state.allMarkers.find(m => m.name.toLowerCase().includes(q));
    if (match) {
      state.map.setView(match.latlng, 15);
      match.marker.openPopup();
      setStatus(`Found: ${match.name}`);
      return;
    }

    setStatus('Searching via geocoder…');
    fetch(`/api/network/geocode-suggest?q=${encodeURIComponent(q)}`, { headers: { Authorization: 'Bearer ' + token() } })
      .then(r => r.json())
      .then(data => {
        const s = (data.suggestions || [])[0];
        if (s && s.lat && s.lon) {
          state.map.setView([s.lat, s.lon], 15);
          L.popup().setLatLng([s.lat, s.lon])
            .setContent(`<b>📍 ${escHtml(s.display_name)}</b><br><small>OSM result — not a verified facility</small>`)
            .openOn(state.map);
          setStatus(`Geocoded: ${s.display_name}`);
        } else {
          setStatus('No results found for "' + q + '"');
        }
      })
      .catch(() => setStatus('Search error'));
  }

  /* ── OSM Overpass discovery (same contract as the standalone map) ──── */

  function updateOsmCountLabel() {
    const n = state.osmSeen.size;
    const el = $('nm-osm-count');
    if (el) el.textContent = n ? `(${n})` : '';
  }

  function discoverArea(silent) {
    const bounds = state.map.getBounds();
    if (state.map.getZoom() < 12) {
      if (!silent) setStatus('Zoom in to zoom level 12 or higher before discovering OSM facilities.');
      return;
    }

    const params = new URLSearchParams({
      south: bounds.getSouth().toFixed(5),
      west: bounds.getWest().toFixed(5),
      north: bounds.getNorth().toFixed(5),
      east: bounds.getEast().toFixed(5)
    });

    const types = ['biogas', 'food_bank'];
    if (!silent) setStatus('Querying OpenStreetMap for facilities in this area…');

    let newCount = 0;

    function fetchType(idx) {
      if (idx >= types.length) {
        if (newCount > 0) setStatus(`Found ${newCount} new OSM location${newCount !== 1 ? 's' : ''} in this area (map-sourced, not yet verified).`);
        else if (!silent) setStatus('No new OSM facilities found in this area.');
        updateOsmCountLabel();
        return;
      }
      const type = types[idx];
      params.set('type', type);
      fetch(`/api/network/overpass-bounds?${params}`, { headers: { Authorization: 'Bearer ' + token() } })
        .then(r => {
          if (r.status === 400 || r.status === 429) return r.json().then(d => { throw new Error(d.error); });
          return r.json();
        })
        .then(data => {
          (data.results || []).forEach(item => {
            const key = `${item.osmType}:${item.osmId}`;
            if (state.osmSeen.has(key)) return;
            state.osmSeen.add(key);
            newCount++;

            const latlng = [item.lat, item.lng];
            const isBiogas = type === 'biogas';
            const typeLabel = isBiogas ? 'Biogas Plant' : 'Food Bank';
            const color = isBiogas ? '#FF781F' : '#F5A623';
            const imported = { value: false };

            const buildPopup = () => `
              <div class="nmap-pop-name">${escHtml(item.name)} <span class="nmap-osm-badge">${imported.value ? 'IN NETWORK' : 'MAP-SOURCED'}</span></div>
              <div class="nmap-pop-type">${typeLabel} — OpenStreetMap</div>
              <div class="nmap-pop-addr">📍 ${escHtml(item.address || 'Address unknown')}</div>
              <div class="nmap-pop-meta">
                Capacity: unknown · Hours: ${escHtml(item.openingHours || 'unknown')}<br>
                Contact: ${escHtml(item.phone || item.email || 'unknown')}
              </div>
              ${imported.value
                ? '<div class="nmap-imported-note">✔ Added to routing network</div>'
                : `<button onclick="importNmapOsmSite('${key}')" class="nmap-pop-btn">＋ Add to routing network</button>`
              }
            `;

            const marker = L.circleMarker(latlng, {
              radius: 7, fillColor: color, color: color, weight: 2, opacity: 1, fillOpacity: 0.2, dashArray: '4 3'
            }).bindPopup(buildPopup());

            marker._osmItem = item;
            marker._osmImported = imported;
            marker._buildPopup = buildPopup;
            state.markerMap.set(key, marker);

            marker.on('click', () => {
              const eligibility = imported.value
                ? '✔ Yes — active in routing network'
                : '✗ No — click "Add to routing network" on popup';
              openPanel(item.name, `
                ${row('Type', typeLabel)}
                ${row('Source', 'OpenStreetMap (OSM ID ' + escHtml(String(item.osmId)) + ')')}
                ${row('Address', escHtml(item.address || 'unknown'))}
                ${row('Capacity', 'unknown (default 0 kg)')}
                ${row('Hours', escHtml(item.openingHours || 'unknown'))}
                ${row('Phone', escHtml(item.phone || 'unknown'))}
                ${row('Email', escHtml(item.email || 'unknown'))}
                ${row('Operator', escHtml(item.operator || 'unknown'))}
                ${row('Routing eligible', eligibility)}
              `);
            });

            state.layers.osm.addLayer(marker);
            state.allMarkers.push({ latlng, name: item.name, marker, db: false });
          });
          setTimeout(() => fetchType(idx + 1), 2100);
        })
        .catch(err => {
          if (!silent) setStatus('OSM discovery: ' + err.message);
          setTimeout(() => fetchType(idx + 1), 2100);
        });
    }

    fetchType(0);
  }

  // Global OSM import handler (called from marker popup buttons)
  window.importNmapOsmSite = async function (itemKey) {
    const marker = state.markerMap.get(itemKey);
    if (!marker || marker._osmImported.value) return;
    const item = marker._osmItem;
    const btn = document.querySelector(`button[onclick="importNmapOsmSite('${itemKey}')"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

    try {
      const res = await fetch('/api/network/osm-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify({
          osmId: item.osmId, osmType: item.osmType,
          name: item.name, lat: item.lat, lng: item.lng,
          address: item.address, phone: item.phone, email: item.email,
          openingHours: item.openingHours, operator: item.operator,
          facilityType: item.osmType === 'biogas' ? 'biogas' : 'food_bank'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      marker._osmImported.value = true;
      marker.setPopupContent(marker._buildPopup());
      marker.openPopup();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '＋ Add to routing network'; }
      setStatus('OSM import failed: ' + err.message);
    }
  };

  /* ── Init ──────────────────────────────────────────────────────────── */

  function initInteraction() {
    // layer toggles
    const wire = (id, key) => {
      const cb = $(id);
      if (!cb) return;
      cb.addEventListener('change', function () {
        this.checked ? state.map.addLayer(state.layers[key]) : state.map.removeLayer(state.layers[key]);
      });
    };
    wire('nm-toggle-donor', 'donor');
    wire('nm-toggle-demand', 'demand');
    wire('nm-toggle-foodbank', 'foodbank');
    wire('nm-toggle-biogas', 'biogas');
    wire('nm-toggle-osm', 'osm');

    $('nmap-fit').addEventListener('click', window._nmapFitAll);
    $('nmap-clear').addEventListener('click', clearRoute);
    $('nmap-close').addEventListener('click', closePanel);
    $('nmap-discover').addEventListener('click', () => discoverArea(false));
    $('nmap-search-btn').addEventListener('click', doSearch);
    $('nmap-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    $('nmap-near').addEventListener('click', () => {
      if (!navigator.geolocation) { setStatus('Geolocation not supported by this browser.'); return; }
      setStatus('Requesting your location…');
      navigator.geolocation.getCurrentPosition(pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        state.map.setView([lat, lng], 14);
        const me = L.circleMarker([lat, lng], { radius: 10, fillColor: '#F05252', color: '#fff', weight: 2, fillOpacity: 0.9 })
          .bindPopup('<b>📍 You are here</b>').addTo(state.map).openPopup();
        setTimeout(() => state.map.removeLayer(me), 8000);
        setStatus(`Centred on your location (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
      }, err => setStatus('Location error: ' + err.message));
    });

    // OSM auto-discovery on pan/zoom stop
    state.map.on('moveend zoomend', () => {
      clearTimeout(state.discoverTimer);
      state.discoverTimer = setTimeout(() => discoverArea(true), 1500);
    });
  }

  window.loadNetworkMap = function loadNetworkMap() {
    const section = $('page-network-map');
    if (!section) return Promise.resolve();
    return (async () => {
      if (!state.inited) {
        state.map = L.map('nmap', { zoomControl: true }).setView([12.97, 77.59], 12);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19
        }).addTo(state.map);

        state.layers = {
          donor: L.layerGroup().addTo(state.map),
          demand: L.layerGroup().addTo(state.map),
          foodbank: L.layerGroup().addTo(state.map),
          biogas: L.layerGroup().addTo(state.map),
          osm: L.layerGroup().addTo(state.map)
        };

        initInteraction();

        // The section was display:none until now — help Leaflet size correctly
        setTimeout(() => state.map.invalidateSize(), 150);
        setTimeout(() => state.map.invalidateSize(), 500);

        state.inited = true;
      }
      await refreshNmapData(false);
    })();
  };
})();
