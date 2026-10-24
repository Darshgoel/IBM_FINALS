# Technology Used – IBM Bob

**FoodBridge** is an AI-powered food redistribution platform built for the **IBM SkillsBuild National Finale**. IBM Bob served as the primary development partner across every layer of the project — from the first architectural conversation to the final competition presentation. Rather than using Bob as an occasional search tool or code-snippet generator, the team used it as a continuous, context-aware engineering collaborator throughout the entire build lifecycle.

---

## 1. System Architecture & Design

The project began with a problem statement and an ambition: move beyond simple donor-recipient matching and build a living, coordinated food network. IBM Bob was used to translate that intent into a concrete, implementable architecture. Through an iterative design conversation, Bob helped define:

- **Seven distinct user interfaces** with clearly separated responsibilities — Donor, Demand Organisation, Individual Recipient, Food Bank, Biogas Centre, Network Intelligence, and Admin/Verification.
- **Cross-system constraints** such as the food safety rule (*AI assists, humans authorise*), the redistribution hierarchy (*immediate demand → food-bank reserve → biogas → waste*), and the principle that individuals are routed to access points rather than offered home delivery.
- **A clear boundary** between what belongs to network intelligence (optimization, prediction, rebalancing) and what belongs to admin (governance, trust, exceptions) — preventing feature duplication before a single line of code was written.

This design phase produced [`interface.md`](interface.md), a locked architectural specification that guided every subsequent development decision.

---

## 2. Full-Stack Backend Development

IBM Bob wrote the entire Node.js/Express backend. Key activities included:

- **Database schema design:** Bob designed and implemented all 11 SQLite tables in [`backend/database/db.js`](backend/database/db.js), with WAL mode for concurrency and realistic seed data for demonstration.
- **Authentication system:** JWT-based login, role guards, and base64 document upload in [`backend/routes/auth.js`](backend/routes/auth.js) and [`backend/middleware/auth.js`](backend/middleware/auth.js).
- **All seven route modules:** Donor, demand-org, recipient, network intelligence, admin, notifications, and auth — each returning live database data rather than stubs.
- **Matching algorithm:** [`backend/services/matching.js`](backend/services/matching.js) implements a multi-stage surplus routing lifecycle:  
  `Safety Gate` → `Delivery Feasibility` → `Demand Matching` → `Food-Bank Fallback` → `Operator Escalation` → `Biogas Disposal`  
  Each allocation is scored on urgency, food type, dietary compatibility, remaining expiry window, distance, and recipient capacity.
- **Notification engine:** [`backend/services/notifications.js`](backend/services/notifications.js) broadcasts via Server-Sent Events (SSE), constructs browser Web Push payloads, and logs simulated email dispatches — all from a single service layer.
- **End-to-end test suite:** Bob wrote [`backend/test_e2e.js`](backend/test_e2e.js) covering all API endpoints; **33/33 tests passed at 100%** on first run.

---

## 3. Seven Complete Frontend Interfaces

Bob built every frontend interface — HTML, CSS, and JavaScript — from scratch, including:

- **Donor dashboard:** Surplus CRUD, prediction panels, impact charts, live SSE notification listener, and demo-data fallback.
- **Demand-org dashboard:** Demand registration (urgency, recurring toggle), auto-matched supply queue with accept/decline, capacity bars, and insights charts.
- **Recipient interface:** A fully public, no-login single-page app with GPS geolocation, intelligent multi-criteria recommendation engine, animated slide-up detail panel, Google Maps directions links, and offline fallback.
- **Food Bank interface:** Dedicated portal for food bank operators to manage incoming surplus allocations, current stock levels, and outbound distribution from the reserve pool.
- **Biogas Centre interface:** Dedicated portal for biogas facility operators to receive and log confirmed-undeliverable food waste routed from the matching engine's final fallback stage.
- **Network Intelligence dashboard:** 9 operational sections covering real-time supply/demand feeds, redistribution tracking with route distances, area rebalancing zones, reserve allocation hierarchy, waste-risk alerts, and 7-day metrics charts.
- **Admin dashboard:** Restricted login portal with document inspection, approve/reject/suspend/reinstate/restrict actions, dispute management, and a full compliance audit trail.

All interfaces are connected to the live backend, with graceful demo-data fallback for offline demonstration.

---

## 4. Presentation Build

The IBM National Finale PowerPoint ([`ppt_output/FoodBridge_National_Finale.pptx`](ppt_output/FoodBridge_National_Finale.pptx)) was also built with Bob. Using Bob's `office_edit` tool in batch mode, Bob constructed the full slide deck programmatically — writing slide content, applying consistent styling, and iterating through multiple render passes until the deck met presentation standards.

---

## 5. Project Management & Documentation

Throughout the build, Bob maintained [`PROJECT_STATUS.md`](PROJECT_STATUS.md) as a living master tracker — recording completion status for every file, flagging priorities, and documenting Phase 2 deferrals. It also produced [`intent.md`](intent.md) as the project's mission statement and [`interface.md`](interface.md) as the locked feature specification.
