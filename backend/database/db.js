/**
 * Database layer. Local development keeps better-sqlite3; deployments can use
 * PostgreSQL while retaining the existing synchronous business-flow calls.
 */
const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { createPostgresSyncDatabase } = require('./postgres-sync');

const DB_FILE = process.env.FOODBRIDGE_DB_PATH
  ? path.resolve(process.env.FOODBRIDGE_DB_PATH)
  : path.join(__dirname, 'foodbridge.db');

const requestedDriver = (process.env.FOODBRIDGE_DATABASE_DRIVER || '').toLowerCase();
if (requestedDriver && !['sqlite', 'postgres'].includes(requestedDriver)) {
  throw new Error('FOODBRIDGE_DATABASE_DRIVER must be either "sqlite" or "postgres"');
}
const isPostgres = requestedDriver
  ? requestedDriver === 'postgres'
  : Boolean(process.env.DATABASE_URL);
if (isPostgres && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required when FOODBRIDGE_DATABASE_DRIVER=postgres');
}
const db = isPostgres
  ? createPostgresSyncDatabase(process.env.DATABASE_URL)
  : new Database(DB_FILE);
if (!isPostgres) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

// ── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    org_id TEXT,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    location_address TEXT DEFAULT '',
    location_lat REAL DEFAULT 0,
    location_lng REAL DEFAULT 0,
    operating_hours TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    description TEXT DEFAULT '',
    document_url TEXT DEFAULT '',
    document_name TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS organization_documents (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    doc_type TEXT DEFAULT 'verification_certificate',
    file_size INTEGER DEFAULT 0,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stored_documents (
    storage_key TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    data_base64 TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS donor_profiles (
    org_id TEXT PRIMARY KEY,
    food_categories TEXT DEFAULT '[]',
    historical_info TEXT DEFAULT '',
    avg_weekly_surplus REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS demand_org_profiles (
    org_id TEXT PRIMARY KEY,
    population_served TEXT DEFAULT '',
    serving_capacity INTEGER DEFAULT 0,
    storage_capacity TEXT DEFAULT '',
    receiving_capacity TEXT DEFAULT '',
    food_requirements TEXT DEFAULT '[]',
    dietary_restrictions TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS surplus_posts (
    id TEXT PRIMARY KEY,
    donor_org_id TEXT NOT NULL,
    food_name TEXT NOT NULL,
    food_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    remaining_quantity REAL,
    quantity_unit TEXT DEFAULT 'kg',
    preparation_state TEXT DEFAULT '',
    dietary_tags TEXT DEFAULT '[]',
    availability_time TEXT,
    remaining_usable_time TEXT,
    pickup_address TEXT DEFAULT '',
    special_instructions TEXT DEFAULT '',
    status TEXT DEFAULT 'available',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS demand_registrations (
    id TEXT PRIMARY KEY,
    demand_org_id TEXT NOT NULL,
    food_requirement TEXT NOT NULL,
    quantity_needed REAL DEFAULT 0,
    remaining_quantity REAL,
    quantity_unit TEXT DEFAULT 'kg',
    required_by TEXT,
    urgency TEXT DEFAULT 'regular',
    dietary_requirements TEXT DEFAULT '[]',
    is_recurring INTEGER DEFAULT 0,
    recurring_pattern TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    surplus_id TEXT NOT NULL,
    demand_id TEXT,
    demand_org_id TEXT,
    match_score REAL DEFAULT 0,
    allocated_quantity REAL,
    allocated_unit TEXT,
    explanation TEXT,
    status TEXT DEFAULT 'pending',
    matched_by TEXT DEFAULT 'system',
    notes TEXT DEFAULT '',
    matched_at TEXT DEFAULT (datetime('now')),
    confirmed_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    org_id TEXT,
    user_id TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY,
    alert_id TEXT,
    recipient_email TEXT,
    org_id TEXT,
    user_id TEXT,
    channel TEXT DEFAULT 'email+push',
    status TEXT DEFAULT 'delivered',
    title TEXT,
    body TEXT,
    dispatched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS verification_records (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    verified_by TEXT,
    action TEXT NOT NULL,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS platform_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  INSERT INTO platform_settings (setting_key, setting_value)
  VALUES ('automatic_organization_approval', 'false')
  ON CONFLICT(setting_key) DO NOTHING;

  CREATE TABLE IF NOT EXISTS partner_verification_responses (
    id TEXT PRIMARY KEY,
    request_record_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    response_text TEXT DEFAULT '',
    document_name TEXT DEFAULT '',
    document_url TEXT DEFAULT '',
    submitted_by TEXT NOT NULL,
    audit_record_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS issue_reports (
    id TEXT PRIMARY KEY,
    reporter_org_id TEXT,
    reported_org_id TEXT,
    match_id TEXT,
    title TEXT DEFAULT '',
    severity TEXT DEFAULT 'medium',
    issue_type TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'open',
    resolution_notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS surplus_predictions (
    id TEXT PRIMARY KEY,
    donor_org_id TEXT NOT NULL,
    predicted_quantity REAL,
    predicted_food_type TEXT,
    prediction_date TEXT,
    confidence_score REAL DEFAULT 0.5,
    actual_quantity REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS biogas_routes (
    id TEXT PRIMARY KEY,
    surplus_id TEXT NOT NULL,
    donor_org_id TEXT,
    food_name TEXT,
    food_type TEXT,
    quantity REAL,
    quantity_unit TEXT,
    reason TEXT,
    destination_name TEXT DEFAULT 'Biogas Centre',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Safe migrations in case table already existed
try { db.exec("ALTER TABLE organizations ADD COLUMN document_url TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE organizations ADD COLUMN document_name TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE issue_reports ADD COLUMN title TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE issue_reports ADD COLUMN severity TEXT DEFAULT 'medium'"); } catch(e){}
try { db.exec("ALTER TABLE surplus_posts ADD COLUMN remaining_quantity REAL"); } catch(e){}
try { db.exec("ALTER TABLE demand_registrations ADD COLUMN remaining_quantity REAL"); } catch(e){}
try { db.exec("ALTER TABLE matches ADD COLUMN allocated_quantity REAL"); } catch(e){}
try { db.exec("ALTER TABLE matches ADD COLUMN allocated_unit TEXT"); } catch(e){}
try { db.exec("ALTER TABLE matches ADD COLUMN explanation TEXT"); } catch(e){}
// Lifecycle routing fields
try { db.exec("ALTER TABLE surplus_posts ADD COLUMN unsafe INTEGER DEFAULT 0"); } catch(e){}
try { db.exec("ALTER TABLE surplus_posts ADD COLUMN review_reason TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE surplus_posts ADD COLUMN biogas_reason TEXT DEFAULT ''"); } catch(e){}

// ── Routing / Map migrations ─────────────────────────────────────────────────
try { db.exec("ALTER TABLE organizations ADD COLUMN map_verified INTEGER DEFAULT 0"); } catch(e){}
try { db.exec("ALTER TABLE matches ADD COLUMN route_distance_km REAL"); } catch(e){}
try { db.exec("ALTER TABLE matches ADD COLUMN route_duration_minutes REAL"); } catch(e){}
try { db.exec("ALTER TABLE matches ADD COLUMN route_provider TEXT DEFAULT 'haversine'"); } catch(e){}
try { db.exec("ALTER TABLE matches ADD COLUMN routing_audit TEXT DEFAULT NULL"); } catch(e){}
// Match source metadata allows verified food-bank inventory to supply demands
// without creating fake donor surplus rows. Existing matches remain 'surplus'.
try { db.exec("ALTER TABLE matches ADD COLUMN source_type TEXT NOT NULL DEFAULT 'surplus'"); } catch(e){}
try { db.exec("ALTER TABLE matches ADD COLUMN source_inventory_id TEXT DEFAULT NULL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN biogas_facility_id TEXT DEFAULT NULL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN route_distance_km REAL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN route_duration_minutes REAL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN route_provider TEXT DEFAULT 'haversine'"); } catch(e){}
// Structured capacity fields for biogas_facilities and demand_org_profiles
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN capacity_unit TEXT DEFAULT 'kg'"); } catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN osm_source INTEGER DEFAULT 0"); } catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN osm_place_id TEXT DEFAULT NULL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN osm_id TEXT DEFAULT NULL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN osm_type TEXT DEFAULT NULL"); } catch(e){}
try { db.exec("ALTER TABLE demand_org_profiles ADD COLUMN receiving_capacity_kg REAL DEFAULT 0"); } catch(e){}
// Biogas operator account linkage
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN operator_user_id TEXT DEFAULT NULL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN is_available INTEGER DEFAULT 1"); } catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN current_intake_kg REAL DEFAULT 0"); } catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN intake_date TEXT DEFAULT NULL"); } catch(e){}
// food_bank org type is handled by reusing demand_org_profiles; no schema change needed
// Biogas route traceability fields
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN status TEXT DEFAULT 'pending'"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN received_at TEXT DEFAULT NULL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN weigh_in_kg REAL DEFAULT NULL"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN processing_notes TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN source_type TEXT NOT NULL DEFAULT 'surplus'"); } catch(e){}
try { db.exec("ALTER TABLE biogas_routes ADD COLUMN source_inventory_id TEXT DEFAULT NULL"); } catch(e){}

// biogas_facilities table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS biogas_facilities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location_address TEXT DEFAULT '',
      location_lat REAL DEFAULT 0,
      location_lng REAL DEFAULT 0,
      contact_phone TEXT DEFAULT '',
      contact_email TEXT DEFAULT '',
      operating_hours TEXT DEFAULT '',
      accepted_waste_types TEXT DEFAULT '[]',
      max_daily_intake_kg REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      verified INTEGER DEFAULT 0,
      verified_by TEXT,
      notes TEXT DEFAULT '',
      document_url TEXT DEFAULT '',
      document_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
} catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN document_url TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE biogas_facilities ADD COLUMN document_name TEXT DEFAULT ''"); } catch(e){}

// food_bank_inventory table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS food_bank_inventory (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      match_id TEXT,
      food_name TEXT NOT NULL,
      food_type TEXT DEFAULT '',
      quantity_received REAL NOT NULL,
      quantity_unit TEXT DEFAULT 'kg',
      quantity_remaining REAL,
      expiry_date TEXT,
      storage_location TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      received_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fbi_org ON food_bank_inventory(org_id)`);
  try { db.exec("ALTER TABLE food_bank_inventory ADD COLUMN biogas_status TEXT DEFAULT 'available'"); } catch(e){}
  try { db.exec("ALTER TABLE food_bank_inventory ADD COLUMN biogas_reason TEXT DEFAULT ''"); } catch(e){}
  try { db.exec("ALTER TABLE food_bank_inventory ADD COLUMN dietary_tags TEXT DEFAULT '[]'"); } catch(e){}
  try { db.exec(`UPDATE food_bank_inventory SET dietary_tags = COALESCE((
    SELECT sp.dietary_tags FROM matches m JOIN surplus_posts sp ON sp.id = m.surplus_id
    WHERE m.id = food_bank_inventory.match_id AND m.source_type = 'surplus'
  ), '[]') WHERE dietary_tags IS NULL OR TRIM(dietary_tags) = '' OR dietary_tags = '[]'`); } catch(e){}
} catch(e){}

// receipt_confirmations table (food bank confirms receipt of a match)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipt_confirmations (
      id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      quantity_confirmed REAL,
      quantity_unit TEXT DEFAULT 'kg',
      discrepancy_noted INTEGER DEFAULT 0,
      discrepancy_notes TEXT DEFAULT '',
      condition_ok INTEGER DEFAULT 1,
      condition_notes TEXT DEFAULT '',
      confirmed_at TEXT DEFAULT (datetime('now'))
    )
  `);
} catch(e){}

// Collapse the retired transit phase into the existing accepted state while
// preserving the later receipt confirmation step.
try { db.exec("UPDATE matches SET status = 'confirmed' WHERE status = 'in_transit'"); } catch(e){}
try { db.exec("UPDATE surplus_posts SET status = 'matched' WHERE status = 'in_transit'"); } catch(e){}
try { db.exec("UPDATE biogas_routes SET status = 'accepted' WHERE status = 'in_transit'"); } catch(e){}
try { db.exec("UPDATE food_bank_inventory SET biogas_status = 'accepted' WHERE biogas_status = 'in_transit'"); } catch(e){}

// route_cache table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_cache (
      id TEXT PRIMARY KEY,
      cache_key TEXT UNIQUE,
      origin_lat REAL,
      origin_lng REAL,
      dest_lat REAL,
      dest_lng REAL,
      distance_km REAL,
      duration_minutes REAL,
      provider TEXT DEFAULT 'osrm',
      result_json TEXT,
      cached_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_route_cache_key ON route_cache(cache_key)`);
} catch(e){}

// Initialize null remaining_quantity values
try {
  db.exec("UPDATE surplus_posts SET remaining_quantity = quantity WHERE remaining_quantity IS NULL");
  db.exec("UPDATE demand_registrations SET remaining_quantity = quantity_needed WHERE remaining_quantity IS NULL");
} catch(e){}

// ── Seed Accounts & Demo Data ────────────────────────────────────────────────
function seedInitialData() {
  const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (adminExists) return;
  if (isPostgres && process.env.FOODBRIDGE_SEED_DEMO !== '1') {
    console.log('[DB] PostgreSQL is empty; skipping demo seed data.');
    return;
  }

  console.log('[DB] Seeding database with initial accounts and realistic network state…');

  const passwordHash = bcrypt.hashSync('admin123', 10);
  const userPasswordHash = bcrypt.hashSync('password123', 10);

  // 1. Core Platform Staff
  const adminId = uuidv4();
  db.prepare(`INSERT INTO users (id, email, password_hash, role, name) VALUES (?, ?, ?, ?, ?)`).run(
    adminId, 'admin@foodbridge.org', passwordHash, 'admin', 'Platform Administrator'
  );

  const coordId = uuidv4();
  db.prepare(`INSERT INTO users (id, email, password_hash, role, name) VALUES (?, ?, ?, ?, ?)`).run(
    coordId, 'network@foodbridge.org', bcrypt.hashSync('network123', 10), 'network_admin', 'Network Coordinator'
  );

  // Also support network_intelligence alias
  const coordId2 = uuidv4();
  db.prepare(`INSERT INTO users (id, email, password_hash, role, name) VALUES (?, ?, ?, ?, ?)`).run(
    coordId2, 'coordinator@foodbridge.org', bcrypt.hashSync('network123', 10), 'network_intelligence', 'Food Logistics Coordinator'
  );

  // 2. Active Donor Organizations
  const donorOrg1 = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, '/uploads/sample_fssai_cert.pdf', 'FSSAI_Lic_TheGrandHotel.pdf')`)
    .run(donorOrg1, 'The Grand Hotel & Banquets', 'hotel', 'MG Road, Central Business District, Bengaluru', 12.9716, 77.5946, '24/7 Kitchen', '+91 80 2234 5678', 'chef@grandhotel.com', '5-star banquet kitchen and multi-cuisine restaurant');
  db.prepare(`INSERT INTO donor_profiles (org_id, food_categories, avg_weekly_surplus) VALUES (?, ?, ?)`).run(donorOrg1, JSON.stringify(['prepared_meals', 'bakery', 'desserts']), 140.0);
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'donor', ?, ?)`).run(uuidv4(), 'donor@grandhotel.com', userPasswordHash, donorOrg1, 'Vikram Mehta');

  const donorOrg2 = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, '/uploads/sample_fssai_cert.pdf', 'FSSAI_FreshBites_Catering.pdf')`)
    .run(donorOrg2, 'FreshBites Corporate Catering', 'caterer', 'Indiranagar 100ft Road, Bengaluru', 12.9784, 77.6408, 'Mon-Sat 7am - 8pm', '+91 80 4123 9900', 'events@freshbites.in', 'Large tech park catering service with fresh hot lunch surplus');
  db.prepare(`INSERT INTO donor_profiles (org_id, food_categories, avg_weekly_surplus) VALUES (?, ?, ?)`).run(donorOrg2, JSON.stringify(['prepared_meals', 'rice_curry', 'salads']), 85.0);
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'donor', ?, ?)`).run(uuidv4(), 'catering@freshbites.in', userPasswordHash, donorOrg2, 'Sunita Rao');

  const donorOrg3 = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, '/uploads/sample_fssai_cert.pdf', 'GreenLeaf_Retail_Cert.pdf')`)
    .run(donorOrg3, 'GreenLeaf Organic Supermarket', 'retailer', 'Koramangala 4th Block, Bengaluru', 12.9340, 77.6225, 'Daily 8am - 10pm', '+91 80 2553 1122', 'supply@greenleaf.com', 'Organic grocer with fresh dairy, fruits, bakery and packaged goods');
  db.prepare(`INSERT INTO donor_profiles (org_id, food_categories, avg_weekly_surplus) VALUES (?, ?, ?)`).run(donorOrg3, JSON.stringify(['produce', 'dairy', 'packaged']), 60.0);
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'donor', ?, ?)`).run(uuidv4(), 'donor@greenleaf.com', userPasswordHash, donorOrg3, 'Deepak Verma');

  // 3. Active Demand Organizations (NGOs & Food Banks)
  const ngoOrg1 = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, '/uploads/sample_fssai_cert.pdf', 'HelpingHands_Trust_80G.pdf')`)
    .run(ngoOrg1, 'Helping Hands Food Mission', 'ngo', 'Shanthi Nagar, Bengaluru', 12.9560, 77.5990, 'Daily 11am - 8pm', '+91 80 2221 4455', 'director@helpinghands.org', 'Community feeding program serving 300+ daily wage earners and families');
  db.prepare(`INSERT INTO demand_org_profiles (org_id, population_served, serving_capacity, storage_capacity, food_requirements, dietary_restrictions)
    VALUES (?, 'Families and migrant workers', 350, 'Dry storage + 2 refrigerators', ?, ?)`).run(ngoOrg1, JSON.stringify(['cooked_meals', 'rice', 'dal', 'chapati']), JSON.stringify(['vegetarian', 'halal']));
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'demand_org', ?, ?)`).run(uuidv4(), 'ngo@helpinghands.org', userPasswordHash, ngoOrg1, 'Sister Agnes');

  const ngoOrg2 = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, '/uploads/sample_fssai_cert.pdf', 'CityHope_Shelter_NGO.pdf')`)
    .run(ngoOrg2, 'City Hope Night Shelter & Kitchen', 'shelter', 'Shivajinagar, Bengaluru', 12.9850, 77.6050, 'Daily 6pm - 10am', '+91 80 2559 7800', 'shelter@cityhope.org', 'Overnight shelter offering hot dinner and breakfast to unhoused individuals');
  db.prepare(`INSERT INTO demand_org_profiles (org_id, population_served, serving_capacity, storage_capacity, food_requirements, dietary_restrictions)
    VALUES (?, 'Unhoused and elderly citizens', 180, 'Cold storage available', ?, ?)`).run(ngoOrg2, JSON.stringify(['hot_meals', 'bread', 'milk']), JSON.stringify(['nutritious']));
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'demand_org', ?, ?)`).run(uuidv4(), 'shelter@cityhope.org', userPasswordHash, ngoOrg2, 'Rahul Pillai');

  const foodBankOrg = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, '/uploads/sample_fssai_cert.pdf', 'Central_Food_Bank_Lic.pdf')`)
    .run(foodBankOrg, 'Central Food Bank & Reserve Hub', 'food_bank', 'Yeshwanthpur Industrial Area, Bengaluru', 13.0230, 77.5510, '24/7 Logistics Hub', '+91 80 2337 9911', 'hub@centralfoodbank.org', 'Large capacity cold chain and dry food reserve point for surplus buffering');
  db.prepare(`INSERT INTO demand_org_profiles (org_id, population_served, serving_capacity, storage_capacity, food_requirements, dietary_restrictions)
    VALUES (?, 'Network reserve and redistribution', 1500, '5000kg dry + 1000kg cold storage', ?, ?)`).run(foodBankOrg, JSON.stringify(['all_types']), JSON.stringify([]));
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'demand_org', ?, ?)`).run(uuidv4(), 'hub@centralfoodbank.org', userPasswordHash, foodBankOrg, 'Major Anand');

  // 4. Pending Organizations for Admin Verification Queue
  const pendingOrg1 = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, '/uploads/sample_fssai_cert.pdf', 'ApexCaterers_FSSAI_Application.pdf')`)
    .run(pendingOrg1, 'Apex Event & Banquet Caterers', 'caterer', 'Whitefield IT Corridor, Bengaluru', 12.9698, 77.7500, 'Events as scheduled', '+91 80 6789 0123', 'admin@apexcatering.in', 'Large corporate event catering. Average surplus 40-70 meals per conference.');
  db.prepare(`INSERT INTO donor_profiles (org_id, food_categories, avg_weekly_surplus) VALUES (?, ?, ?)`).run(pendingOrg1, JSON.stringify(['cooked_food', 'bakery']), 60);
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'donor', ?, ?)`).run(uuidv4(), 'admin@apexcatering.in', userPasswordHash, pendingOrg1, 'Amit Shah');

  const pendingOrg2 = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, '/uploads/sample_fssai_cert.pdf', 'NourishKids_NGO_Certificate.pdf')`)
    .run(pendingOrg2, 'Nourish Kids Foundation', 'ngo', 'BTM Layout 2nd Stage, Bengaluru', 12.9166, 77.6101, 'Mon-Sat 10am - 6pm', '+91 80 2668 5544', 'contact@nourishkids.org', 'After-school nutrition and evening snack center supporting 120 underprivileged students.');
  db.prepare(`INSERT INTO demand_org_profiles (org_id, population_served, serving_capacity, storage_capacity, food_requirements, dietary_restrictions)
    VALUES (?, 'Underprivileged students and children', 120, 'Small pantry', ?, ?)`).run(pendingOrg2, JSON.stringify(['fruits', 'milk', 'cooked_snacks', 'biscuits']), JSON.stringify(['mild_spice', 'vegetarian']));
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'demand_org', ?, ?)`).run(uuidv4(), 'contact@nourishkids.org', userPasswordHash, pendingOrg2, 'Kavita Menon');

  // 5. Surplus Posts
  // Post A: Matched and awaiting receipt confirmation
  const surplusA = uuidv4();
  db.prepare(`INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, remaining_quantity, quantity_unit, preparation_state, dietary_tags, availability_time, remaining_usable_time, pickup_address, special_instructions, status)
    VALUES (?, ?, 'Paneer Butter Masala & Jeera Rice', 'cooked_meals', 45, 0, 'servings', 'Freshly packed warm containers', '["veg","gluten_free"]', datetime('now', '-1 hour'), datetime('now', '+3 hours'), 'The Grand Hotel, Kitchen Dock #2', 'Enter via rear service lane', 'matched')`)
    .run(surplusA, donorOrg1);

  // Post B: Available, near expiry (Waste Risk!)
  const surplusB = uuidv4();
  db.prepare(`INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, remaining_quantity, quantity_unit, preparation_state, dietary_tags, availability_time, remaining_usable_time, pickup_address, special_instructions, status)
    VALUES (?, ?, 'Assorted Sandwiches & Fruit Bowls', 'sandwiches', 30, 30, 'servings', 'Chilled grab-and-go boxes', '["vegetarian"]', datetime('now', '-2 hours'), datetime('now', '+90 minutes'), 'FreshBites Indiranagar Outlet', 'Needs immediate pickup before 5pm', 'available')`)
    .run(surplusB, donorOrg2);

  // Post C: Available surplus
  const surplusC = uuidv4();
  db.prepare(`INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, remaining_quantity, quantity_unit, preparation_state, dietary_tags, availability_time, remaining_usable_time, pickup_address, special_instructions, status)
    VALUES (?, ?, 'Fresh Pasteurized Whole Milk & Yogurt', 'dairy', 25, 25, 'liters', 'Refrigerated crates at 4°C', '["dairy"]', datetime('now'), datetime('now', '+8 hours'), 'GreenLeaf Supermarket Loading Bay', 'Cold chain vehicle recommended', 'available')`)
    .run(surplusC, donorOrg3);

  // Post D: Completed earlier today
  const surplusD = uuidv4();
  db.prepare(`INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, remaining_quantity, quantity_unit, preparation_state, dietary_tags, availability_time, remaining_usable_time, pickup_address, special_instructions, status)
    VALUES (?, ?, 'Vegetable Biryani with Raita', 'cooked_meals', 70, 0, 'servings', 'Thermal transport boxes', '["veg"]', datetime('now', '-5 hours'), datetime('now', '-1 hour'), 'The Grand Hotel Dock', 'Delivered cleanly', 'completed')`)
    .run(surplusD, donorOrg1);

  // 6. Demand Registrations
  // Demand 1: Emergency hot meals
  const demand1 = uuidv4();
  db.prepare(`INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, remaining_quantity, quantity_unit, required_by, urgency, dietary_requirements, status)
    VALUES (?, ?, 'Cooked Dinner Meals for Shelter Residents', 50, 50, 'servings', datetime('now', '+2 hours'), 'emergency', '["hot_meal","hygienic"]', 'open')`)
    .run(demand1, ngoOrg2);

  // Demand 2: Matched demand
  const demand2 = uuidv4();
  db.prepare(`INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, remaining_quantity, quantity_unit, required_by, urgency, dietary_requirements, status)
    VALUES (?, ?, 'Lunch distribution for community dining hall', 45, 0, 'servings', datetime('now', '+3 hours'), 'immediate', '["veg"]', 'fulfilled')`)
    .run(demand2, ngoOrg1);

  // Demand 3: Regular breakfast staples
  const demand3 = uuidv4();
  db.prepare(`INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, remaining_quantity, quantity_unit, required_by, urgency, dietary_requirements, status)
    VALUES (?, ?, 'Dairy or nutritious breakfast beverages', 20, 20, 'liters', datetime('now', '+6 hours'), 'regular', '["dairy"]', 'open')`)
    .run(demand3, ngoOrg2);

  // 7. Matches
  const match1 = uuidv4();
  db.prepare(`INSERT INTO matches (id, surplus_id, demand_id, demand_org_id, match_score, allocated_quantity, allocated_unit, explanation, status, notes, matched_at)
    VALUES (?, ?, ?, ?, 92, 45, 'servings', 'Direct match: high urgency match within 3.5km, covers 100% of demand', 'confirmed', 'Direct match: high urgency match within 3.5km', datetime('now', '-45 minutes'))`)
    .run(match1, surplusA, demand2, ngoOrg1);

  const match2 = uuidv4();
  db.prepare(`INSERT INTO matches (id, surplus_id, demand_id, demand_org_id, match_score, allocated_quantity, allocated_unit, explanation, status, notes, matched_at, completed_at)
    VALUES (?, ?, NULL, ?, 96, 70, 'servings', 'Delivered 70 portions to Shanthi Nagar center', 'completed', 'Delivered 70 portions to Shanthi Nagar center', datetime('now', '-5 hours'), datetime('now', '-3 hours'))`)
    .run(match2, surplusD, ngoOrg1);

  // 8. Safety Flags & Disputes
  db.prepare(`INSERT INTO issue_reports (id, reporter_org_id, reported_org_id, match_id, title, severity, issue_type, description, status)
    VALUES (?, ?, ?, ?, 'Packaging Temperature Notice', 'medium', 'packaging_temperature', 'Thermal containers were slightly below recommended 60C at dispatch. Inspected and approved with advice.', 'open')`)
    .run(uuidv4(), ngoOrg1, donorOrg1, match1);

  db.prepare(`INSERT INTO issue_reports (id, reporter_org_id, reported_org_id, match_id, title, severity, issue_type, description, status)
    VALUES (?, ?, ?, NULL, 'Delayed Pickup Communication', 'low', 'logistics_timing', 'Volunteer transport arrived 25 minutes after stated window due to traffic.', 'resolved')`)
    .run(uuidv4(), donorOrg2, ngoOrg2);

  // 9. Compliance / Verification Records
  db.prepare(`INSERT INTO verification_records (id, org_id, verified_by, action, notes)
    VALUES (?, ?, ?, 'approved', 'FSSAI License verified against state database. Hygiene audit confirmed.')`)
    .run(uuidv4(), donorOrg1, adminId);
  db.prepare(`INSERT INTO verification_records (id, org_id, verified_by, action, notes)
    VALUES (?, ?, ?, 'approved', 'NGO registration certificate and FCRA/80G status verified.')`)
    .run(uuidv4(), ngoOrg1, adminId);

  // 10. Sample Alerts
  db.prepare(`INSERT INTO alerts (id, org_id, user_id, type, title, message)
    VALUES (?, ?, NULL, 'match', '🍱 Urgent Match Confirmed', '45 portions of warm dinner matched with Helping Hands Mission.')`)
    .run(uuidv4(), donorOrg1);
  db.prepare(`INSERT INTO alerts (id, org_id, user_id, type, title, message)
    VALUES (?, ?, NULL, 'risk', '⚠️ Food at Waste Risk', '30 servings of sandwiches approaching expiry window (90 mins remaining).')`)
    .run(uuidv4(), donorOrg2);

  // 11. Food Bank operator demo account (food_bank role, reuses demand_org flow)
  const fbOrg = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, verified, document_url, document_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, '/uploads/sample_fssai_cert.pdf', 'CityCare_FoodBank_Cert.pdf')`)
    .run(fbOrg, 'CityCare Community Food Bank', 'food_bank', 'Rajajinagar, Bengaluru', 12.9950, 77.5550, 'Mon-Sat 8am-8pm', '+91 80 2345 6789', 'ops@citycarefoodbank.org', 'Cold-chain and dry storage reserve food bank serving 600+ beneficiaries weekly.');
  db.prepare(`INSERT INTO demand_org_profiles (org_id, population_served, serving_capacity, storage_capacity, food_requirements, dietary_restrictions)
    VALUES (?, 'Low-income families and children', 600, '3000kg dry + 800kg cold storage', ?, ?)`).run(fbOrg, JSON.stringify(['all_types']), JSON.stringify([]));
  db.prepare(`INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, 'food_bank', ?, ?)`).run(uuidv4(), 'ops@citycarefoodbank.org', userPasswordHash, fbOrg, 'Priya Nair');

  console.log('[DB] Realistic network state seeded successfully.');
}

// Seed biogas facilities on a fresh install only.
function seedBiogasFacilities() {
  const existing = db.prepare("SELECT COUNT(*) as c FROM biogas_facilities").get();
  if (existing.c > 0) return;

  const { v4: uuid } = require('uuid');
  db.prepare(`
    INSERT INTO biogas_facilities (id, name, location_address, location_lat, location_lng, contact_phone, contact_email,
      operating_hours, accepted_waste_types, max_daily_intake_kg, status, verified, verified_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 'system', ?)
  `).run(
    uuid(),
    'Green Energy Biogas Plant',
    'Peenya Industrial Area, Bengaluru',
    13.0100, 77.5700,
    '+91 80 2839 4400',
    'contact@greenenergybiogas.in',
    'Mon-Sat 6am - 8pm',
    JSON.stringify(['cooked_meals', 'dairy', 'produce', 'bakery', 'packaged', 'all_food_waste']),
    500,
    'Large capacity biogas plant accepting all food waste types up to 500 kg/day'
  );

  db.prepare(`
    INSERT INTO biogas_facilities (id, name, location_address, location_lat, location_lng, contact_phone, contact_email,
      operating_hours, accepted_waste_types, max_daily_intake_kg, status, verified, verified_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 'system', ?)
  `).run(
    uuid(),
    'Eco Waste Solutions',
    'Electronic City Phase 1, Bengaluru',
    12.9200, 77.6400,
    '+91 80 6745 2211',
    'info@ecowastesolutions.in',
    'Daily 7am - 7pm',
    JSON.stringify(['cooked_meals', 'dairy', 'produce']),
    300,
    'Eco biogas processing unit specializing in cooked meals, dairy and produce; 300 kg/day capacity'
  );

  // Biogas operator demo account linked to Green Energy Biogas Plant
  const bioOpsExists = db.prepare("SELECT id FROM users WHERE email = 'operator@greenenergybiogas.in' LIMIT 1").get();
  if (!bioOpsExists) {
    const bioUserPasswordHash = bcrypt.hashSync('password123', 10);
    const bioUserId = uuidv4();
    const facility = db.prepare("SELECT id FROM biogas_facilities WHERE name = 'Green Energy Biogas Plant' LIMIT 1").get();
    if (facility) {
      db.prepare(`INSERT INTO users (id, email, password_hash, role, name) VALUES (?, ?, ?, 'biogas_operator', ?)`).run(
        bioUserId, 'operator@greenenergybiogas.in', bioUserPasswordHash, 'Rajan Kumar'
      );
      db.prepare('UPDATE biogas_facilities SET operator_user_id = ?, is_available = 1, status = ? WHERE id = ?').run(bioUserId, 'active', facility.id);
    }
  }

  console.log('[DB] Biogas facilities seeded.');
}

// Preserve a clean test database after initial setup. In particular, deleting
// partner accounts from an existing database must not cause demo partners or
// biogas facilities to be recreated when the backend restarts.
const isFreshInstall = !db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
seedInitialData();
if (isFreshInstall && (!isPostgres || process.env.FOODBRIDGE_SEED_DEMO === '1')) seedBiogasFacilities();

console.log(`[DB] ${isPostgres ? 'PostgreSQL' : 'SQLite'} database ready.`);

module.exports = db;
