# FoodBridge — Master Project Status

> Last updated: 22 Oct 2026
> All files live under `C:\Users\shobi\OneDrive\Desktop\IBM NATIONALS\`

---

## 🗂️ Project Overview

FoodBridge is a 5-interface food redistribution platform connecting donors, demand orgs, individual recipients, network coordinators, and admins. It has a Node.js/SQLite backend and vanilla HTML/CSS/JS frontends.

---

## ✅ Backend Architecture & Services

| File | Status | Notes |
|---|---|---|
| `backend/server.js` | ✅ Complete | Express server, CORS, static mounts (`/`, `/donor`, `/demand-org`, `/recipient`, `/network-intelligence`, `/admin`, `/ops`, `/uploads`) |
| `backend/.env` | ✅ Complete | `PORT`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `NODE_ENV` configured |
| `backend/package.json` | ✅ Complete | Express, better-sqlite3, bcryptjs, jsonwebtoken, uuid, dotenv |
| `backend/database/db.js` | ✅ Complete | better-sqlite3 WAL mode, auto-creates all 11 tables on startup, seeded with realistic network state |
| `backend/middleware/auth.js` | ✅ Complete | JWT verification middleware + role guard |
| `backend/routes/auth.js` | ✅ Complete | POST `/register` (with base64 document upload), POST `/login`, GET `/me`, POST `/upload` |
| `backend/routes/donor.js` | ✅ Complete | Profile CRUD, surplus post/get/delete, impact, predictions, alerts |
| `backend/routes/demand.js` | ✅ Complete | Mounted on `/api/demand` and `/api/demand-org`: Profile, demands, auto-matching, accept/decline, capacity, insights, alerts |
| `backend/routes/network.js` | ✅ Complete | All 9 endpoints return real DB data: `/overview`, `/supply-demand`, `/redistributions`, `/rebalancing`, `/reserve`, `/community`, `/waste-risk`, `/interventions`, `/metrics` |
| `backend/routes/admin.js` | ✅ Complete | Real DB data: `/overview`, `/pending`, `/participants`, `/flags`, `/disputes`, `/records` + live org actions (`approve`/`reject`/`suspend`/`reinstate`/`restrict`/`request-info`) |
| `backend/routes/recipient.js` | ✅ Complete | GET `/search`, GET `/access-point/:id` — returns nearby verified access points |
| `backend/routes/notifications.js`| ✅ Complete | GET `/stream` (live SSE broadcast to dashboards), GET `/deliveries` (audit log), POST `/test` |
| `backend/services/matching.js` | ✅ Complete | Matching algorithm: urgency, food type, remaining expiry time, distance scoring, fallback to food banks |
| `backend/services/notifications.js`| ✅ Complete | Multichannel notification engine: live SSE stream, in-app alerts, browser Web Push payloads, and simulated email dispatch logs |
| `backend/test_e2e.js` | ✅ Complete | Full automated test suite (33 / 33 tests passed, 100% pass rate) |
| `backend/uploads/` | ✅ Complete | Storage directory for uploaded verification documents (FSSAI licenses, NGO certificates) |

---

## 🖥️ Frontend Interfaces

### 1. 🏪 Donor Interface — ✅ Complete

| File | Status |
|---|---|
| `donor/index.html` | ✅ Login + Register portal |
| `donor/dashboard.html` | ✅ Full dashboard (Overview, Post Surplus, My Surplus, Impact, Predictions, Profile) |
| `donor/styles/main.css` | ✅ Full styling — orange accent, sidebar, responsive section styles |
| `donor/js/api.js` | ✅ API client for all donor endpoints |
| `donor/js/dashboard.js` | ✅ Full dashboard logic — surplus CRUD, charts, predictions, profile, alerts + live SSE notification listener |

**Features working:** Auth guard, post surplus form, surplus list + filter/cancel, impact stats, mini charts, surplus prediction panel, profile save, live push notifications via SSE and desktop Web Notifications, toast alerts, demo data fallback.

---

### 2. 🤝 Demand-Org Interface — ✅ Complete

| File | Status |
|---|---|
| `demand-org/index.html` | ✅ Login + Register portal |
| `demand-org/dashboard.html` | ✅ Full dashboard (8 sections) |
| `demand-org/styles/main.css` | ✅ Full styling — teal/green accent |
| `demand-org/js/api.js` | ✅ API client for all demand-org endpoints |
| `demand-org/js/dashboard.js` | ✅ Full dashboard logic + live SSE notification listener |

**Features working:** Register demand (urgency selector, recurring toggle), demand list + filter/cancel, matched supply with accept/decline, capacity bars + update form, insights charts, alerts with mark-read, live push notifications, profile save, demo data fallback.

---

### 3. 👤 Individual Recipient Interface — ✅ Complete

| File | Status |
|---|---|
| `recipient/index.html` | ✅ Single-page search UI — location input, GPS button, people/dietary/urgency selectors, recommendation banner, access-point list, slide-up detail panel |
| `recipient/styles/main.css` | ✅ Full styling — warm orange accent, search card, access-point cards, detail panel, availability dots |
| `recipient/js/app.js` | ✅ Full client app logic — GPS & area search, intelligent recommendation engine, card rendering with live availability dots, slide-up detail panel, multi-criteria sorting, directions, browser push notifications + SSE live stream, and offline demo fallback |
| `recipient/STATUS.md` | ✅ Updated status doc marking 100% completion |

**Features working:** No-login public access, GPS geolocation detection, area keyword resolution, smart matching algorithm (distance, availability, dietary compatibility, capacity, urgency), top-pick recommendation banner, animated slide-up detail sheet, Google Maps directions links, browser Web Notifications, multi-criteria sorting, and responsive layout.

---

### 4. 🌐 Network Intelligence Interface — ✅ Complete

| File | Status |
|---|---|
| `network-intelligence/index.html` | ✅ Dedicated Coordinator login portal with restricted access warning & auto-redirect |
| `network-intelligence/dashboard.html` | ✅ Full dashboard (9 operational sections) |
| `network-intelligence/styles/main.css` | ✅ Full styling — indigo/cyan accent |
| `network-intelligence/js/dashboard.js` | ✅ Full dashboard logic connected to real SQLite backend APIs with demo fallback |
| `network-intelligence/SCOPE.md` | ✅ Documents operational capabilities vs deferred Phase 2 ML |

**Features working:** Real-time network overview, live supply/demand feed, redistribution tracking with route distances, area rebalancing zones, reserve allocation hierarchy, community hotspot/gap intelligence, waste-risk alerts with one-click intervention, intervention recommendations, 7-day network metrics charts.

---

### 5. ⚙️ Admin & Verification Interface — ✅ Complete

| File | Status |
|---|---|
| `admin/index.html` | ✅ Restricted login portal with warning banner & auth guard |
| `admin/dashboard.html` | ✅ Full dashboard (6 sections) |
| `admin/styles/main.css` | ✅ Full styling — violet accent |
| `admin/js/dashboard.js` | ✅ Full dashboard logic wired to real backend endpoints + document inspection |

**Features working:** Org verification queue with uploaded document inspection (`📄 View Document`), approve/reject/request info/suspend/reinstate/restrict actions, all participants with search+filter, safety flag review with resolution, dispute management, full compliance audit trail, confirmation modal with notes field.

---

### 6. 🏠 Landing & Shared Portals — ✅ Complete

| File | Status |
|---|---|
| `index.html` | ✅ Unified landing page with 3-step registration (Donor, NGO, Recipient) + document upload drag & drop + direct role sign-in routing |
| `ops/index.html` | ✅ Unified operations portal for coordinators and platform administrators |

---

## 🔧 Work Status & Priority Audit

### 🔴 High Priority
- [x] **Network Intelligence login portal** — `network-intelligence/index.html` built, styled, and authenticated.
- [x] **Backend end-to-end test** — `backend/test_e2e.js` executed (33 / 33 tests passed, 100% pass rate).
- [ ] **`recipient/js/app.js`** — ⏸ Paused per instruction (CSS & HTML complete, see `recipient/STATUS.md`).

### 🟡 Medium Priority
- [x] **Backend route stub → real data** — All network and admin routes return live DB data with realistic seed records and live audit logs.
- [x] **Alert delivery** — Multichannel notification engine built (`backend/services/notifications.js`): SSE stream, native browser Web Notifications, and simulated email dispatch logs.
- [x] **Document upload** — Org registration in `index.html` supports document upload (FSSAI/NGO certs), saved to `backend/uploads/` and verified in admin queue with clickable document inspection.

### 🔵 Low Priority / Phase 2 (Future Enhancements)
1. **Supply & Demand Prediction ML** — integration with trained machine learning model (see `network-intelligence/SCOPE.md`).
2. **External Geolocation API** — integration with Google Maps / OpenStreetMap for turn-by-turn routing.
3. **Dedicated Transport Logistics Module** — driver/fleet app for live dispatch coordination.

---

## 🚀 How to Run

```bash
cd backend
npm install
node server.js
```

Then open `http://localhost:3000` in your browser.

**To run the test suite:**
```bash
cd backend
node test_e2e.js
```

**Default Accounts (seeded in database):**
- **Platform Admin:** `admin@foodbridge.org` / `admin123`
- **Network Coordinator:** `network@foodbridge.org` / `network123`
- **Active Donor:** `donor@grandhotel.com` / `password123`
- **Active Demand Org (NGO):** `ngo@helpinghands.org` / `password123`
