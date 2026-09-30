// ===== Changes to server.js =====
// First run:  npm i bcryptjs

// --- 1. Add these requires near the top ---
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// --- 2. Put this block AFTER app.use(express.json())
//        and BEFORE app.use(authenticate) ---
app.use(express.static(path.join(__dirname, 'public')));   // serves public/index.html

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.password_hash, u.base_id, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = $1`, [email]);
    const u = rows[0];
    const ok = u && await bcrypt.compare(password || '', u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong email or password' });
    const user = { id: u.id, name: u.name, role: u.role, baseId: u.base_id };
    const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user });
  } catch (e) { res.status(500).json({ error: 'Login failed' }); }
});

// --- 3. Put these routes AFTER app.use(authenticate), e.g. above "READ: inventory" ---
app.get('/api/bases', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM bases ORDER BY name');
  res.json(rows);
});

app.get('/api/asset-types', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, category FROM asset_types ORDER BY name');
  res.json(rows);
});

app.get('/api/users', async (req, res) => {
  const scoped = req.user.role !== 'admin';
  const { rows } = await pool.query(
    `SELECT id, name, base_id FROM users ${scoped ? 'WHERE base_id = $1' : ''} ORDER BY name`,
    scoped ? [req.user.baseId] : []);
  res.json(rows);
});

// Active (not yet returned) assignments
app.get('/api/assignments', authorize('admin', 'base_commander'), async (req, res) => {
  const scoped = req.user.role !== 'admin';
  const { rows } = await pool.query(
    `SELECT a.id, t.name AS asset, b.name AS base, u.name AS assigned_to_name,
            a.quantity, a.assigned_at
     FROM assignments a
     JOIN asset_types t ON t.id = a.asset_type_id
     JOIN bases b ON b.id = a.base_id
     JOIN users u ON u.id = a.assigned_to
     WHERE a.returned_at IS NULL ${scoped ? 'AND a.base_id = $1' : ''}
     ORDER BY a.assigned_at DESC`,
    scoped ? [req.user.baseId] : []);
  res.json(rows);
});

// ===== One-time SQL: give the test admin a real password (run in psql, -d assets) =====
// CREATE EXTENSION IF NOT EXISTS pgcrypto;
// UPDATE users SET password_hash = crypt('admin123', gen_salt('bf')) WHERE email = 'a@x.com';
