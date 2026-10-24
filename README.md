# FoodBridge

> AI-powered food access and circular recovery network connecting food donors, demand organizations (NGOs), food banks, biogas recovery operators, and community recipients.

---

## Live Deployment

If you do not wish to run the project locally, the live production application is deployed on **Render**:

🔗 **Live Website:** [https://foodbridge-rwni.onrender.com](https://foodbridge-rwni.onrender.com)

> **Note:** If visiting for the first time after inactivity, Render's free tier may take ~30–50 seconds to spin up from a cold start.

---

## Codebase Skeleton

```
├── backend/                         # Node.js / Express backend server
│   ├── database/                    # Database layer (SQLite & PostgreSQL sync)
│   │   ├── db.js                    # Database connection & schema migration
│   │   ├── postgres-sync.js         # Synchronous worker-thread bridge for PostgreSQL
│   │   └── postgres-worker.js       # Background thread executing Postgres queries
│   ├── middleware/
│   │   └── auth.js                  # JWT authentication & role-based guard middleware
│   ├── routes/                      # REST API endpoint controllers
│   │   ├── admin.js                 # Admin verification, flags & compliance
│   │   ├── auth.js                  # User registration, login & token issuance
│   │   ├── biogas.js                # Biogas facility routing & intake tracking
│   │   ├── demand.js                # Demand registration & match management
│   │   ├── documents.js             # Secure verification certificate retrieval
│   │   ├── donor.js                 # Surplus posting, impact stats & predictions
│   │   ├── network.js               # Network intelligence & rebalancing metrics
│   │   ├── notifications.js         # SSE stream & delivery audit logs
│   │   ├── partner-verification.js  # Partner verification response portal
│   │   └── recipient.js             # Public food access point discovery
│   ├── services/                    # Core business logic & algorithm services
│   │   ├── document-storage.js      # In-database base64 document storage
│   │   ├── geocoding.js             # OpenStreetMap / Nominatim geocoder
│   │   ├── matching.js              # Multi-tier matching algorithm & expiry sweep
│   │   ├── notifications.js         # Multi-channel notification engine (SSE / Push)
│   │   └── routing.js               # OSRM road distance & Haversine routing
│   ├── test_e2e.js                  # Automated 33-point end-to-end integration test suite
│   ├── server.js                    # Express application entry point & cron daemon
│   └── package.json                 # Backend dependencies & script definitions
│
├── donor/                           # Food Donor Portal (surplus posting, tracking, impact)
├── demand-org/                      # NGO / Community Kitchen Portal (demands, matches, receipts)
├── food-bank/                       # Food Bank Portal (inventory, reserve stock & redistribution)
├── biogas/                          # Biogas Operator Portal (recovery intake & weigh-in logs)
├── recipient/                       # Public Food Finder (zero-login nearby access point map)
├── network-intelligence/            # Coordinator Dashboard (network oversight & rebalancing)
├── admin/                           # Platform Administration & Verification Portal
├── ops/                             # Unified Operations Navigation Hub
│
├── assets/                          # Shared styles, typography & static media
│   ├── css/                         # Design system tokens & modular stylesheets
│   ├── images/                      # Optimized image assets
│   └── js/                          # Client-side utility libraries & UI components
│
├── index.html                       # Public landing page & unified registration
├── about.html                       # Mission, principles & operational standards
├── how-it-works.html                # Step-by-step lifecycle guide
├── impact.html                      # Network-wide redistribution statistics
├── contact.html                     # Contact & support directory
├── get-involved.html                # Partner onboarding directory
│
├── render.yaml                      # Render Infrastructure-as-Code deployment blueprint
└── README.md                        # Project documentation
```

---

## Quick Start (Local Setup)

### Prerequisites

- **Node.js** (v18.0.0 or higher recommended)
- **npm** (v9.0.0 or higher)

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/FoodBridge.git
cd FoodBridge
```

### 2. Install Backend Dependencies

```bash
cd backend
npm install
```

### 3. Environment Configuration (Optional)

A sample configuration is provided in `backend/.env.example`. For local development, sensible defaults are automatically loaded:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|:---|:---|:---|
| `PORT` | `3000` | Port for the Express HTTP server |
| `JWT_SECRET` | Auto-generated in production | Secret key used for signing JWT tokens |
| `JWT_EXPIRES_IN` | `7d` | Token validity duration |
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `FOODBRIDGE_DATABASE_DRIVER` | `sqlite` | Database driver (`sqlite` locally, `postgres` on cloud) |
| `DATABASE_URL` | *(none)* | PostgreSQL connection string (when driver is `postgres`) |

### 4. Start the Application

```bash
npm start
```

For live reloading during development:

```bash
npm run dev
```

The application will start at: **`http://localhost:3000`**

---

## Local Interface Routes

Once the server is running, the portals can be accessed at:

| Portal | URL Path | Description |
|:---|:---|:---|
| **Landing Page** | `http://localhost:3000/` | Main website & registration portal |
| **Recipient Finder** | `http://localhost:3000/recipient` | Public food finder (No login required) |
| **Donor Portal** | `http://localhost:3000/donor` | Surplus food posting & analytics |
| **Demand Org (NGO)** | `http://localhost:3000/demand-org` | Food requests & match confirmation |
| **Food Bank** | `http://localhost:3000/food-bank` | Cold-storage inventory & reserve routing |
| **Biogas Operator** | `http://localhost:3000/biogas` | Organic waste recovery & weigh-in |
| **Network Intelligence** | `http://localhost:3000/network-intelligence` | Operational metrics & zone rebalancing |
| **Admin Portal** | `http://localhost:3000/admin` | Verification queue & compliance audit |
| **Operations Hub** | `http://localhost:3000/ops` | Unified operations switcher |

> **User Registration:** You can register new donor, NGO, food bank, or biogas accounts directly via the **Sign In / Register** modal on the landing page (`/`).

---

## Running the Test Suite

FoodBridge includes an automated end-to-end integration test suite that tests registration, document uploads, verification approval, surplus posting, matching logic, and notifications:

```bash
cd backend
node test_e2e.js
```

---

## Deployment (Render)

This repository includes a [`render.yaml`](render.yaml) blueprint for one-click deployment:

1. Push your repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click **New** $\to$ **Blueprint**.
3. Select your repository. Render will automatically provision:
   - A **Node.js Web Service** running `npm --prefix backend start`.
   - Health check endpoint configured at `/api/health`.
   - Automatic generation of production `JWT_SECRET`.
   - Connection to managed PostgreSQL for persistent production storage.

---

## 📄 License

This project was built for the **IBM SkillsBuild Hackathon**. Licensed under the [MIT License](LICENSE).
