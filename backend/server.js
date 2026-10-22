require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// A local checkout may not have a .env file. Keep sign-up and sign-in usable
// during development, while still requiring an explicit secret in production.
if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'production') {
  process.env.JWT_SECRET = 'foodbridge-local-development-secret-change-me';
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Serve uploaded documents statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/donor',         require('./routes/donor'));
app.use('/api/demand',        require('./routes/demand'));
app.use('/api/demand-org',    require('./routes/demand'));
app.use('/api/recipient',     require('./routes/recipient'));
app.use('/api/network',       require('./routes/network'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/notifications', require('./routes/notifications'));

// Serve landing / auth page at root
app.use('/', express.static(path.join(__dirname, '..')));

// Serve each frontend interface as a static site
app.use('/donor',                express.static(path.join(__dirname, '../donor')));
app.use('/demand-org',           express.static(path.join(__dirname, '../demand-org')));
app.use('/recipient',            express.static(path.join(__dirname, '../recipient')));
app.use('/network-intelligence', express.static(path.join(__dirname, '../network-intelligence')));
app.use('/admin',                express.static(path.join(__dirname, '../admin')));
app.use('/ops',                  express.static(path.join(__dirname, '../ops')));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🌉 FoodBridge server running at http://localhost:${PORT}`);
  console.log(`   Landing Page:                  http://localhost:${PORT}`);
  console.log(`   Donor Interface:               http://localhost:${PORT}/donor`);
  console.log(`   Demand Org Interface:          http://localhost:${PORT}/demand-org`);
  console.log(`   Recipient Interface:           http://localhost:${PORT}/recipient`);
  console.log(`   Network Intelligence:          http://localhost:${PORT}/network-intelligence`);
  console.log(`   Admin Interface:               http://localhost:${PORT}/admin\n`);
  console.log(`   Default accounts:`);
  console.log(`     Admin:         admin@foodbridge.org / admin123`);
  console.log(`     Network Admin: network@foodbridge.org / network123\n`);
});
