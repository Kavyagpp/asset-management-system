require('dotenv').config();

// Run: npm i express pg jsonwebtoken bcryptjs dotenv
// Env: DATABASE_URL, JWT_SECRET
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const {
  authenticate, authorize, restrictToOwnBase, requestLogger, logAudit,
} = require('./middleware');

const app = express();
app.use(express.json());

// ---------- PUBLIC (no login needed): frontend + login ----------
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

// ---------- EVERYTHING BELOW REQUIRES LOGIN ----------
app.use(authenticate);
app.use(requestLogger);    // logs every POST/PUT/DELETE

// Helper: run a function inside a DB transaction
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- LOOKUPS (used by the frontend dropdowns) ----------
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

// ---------- PURCHASES (admin, logistics) ----------
app.post('/api/purchases',
  authorize('admin', 'logistics'),
  restrictToOwnBase((req) => req.body.baseId),
  async (req, res) => {
    const { baseId, assetTypeId, quantity, unitCost } = req.body;
    try {
      const purchase = await withTx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO purchases (base_id, asset_type_id, quantity, unit_cost, purchased_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [baseId, assetTypeId, quantity, unitCost, req.user.id]);
        await c.query(
          `INSERT INTO inventory (base_id, asset_type_id, quantity) VALUES ($1,$2,$3)
           ON CONFLICT (base_id, asset_type_id)
           DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity`,
          [baseId, assetTypeId, quantity]);
        await logAudit(c, req, 'PURCHASE', 'purchases', rows[0].id, rows[0]);
        return rows[0];
      });
      res.status(201).json(purchase);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

// ---------- TRANSFERS (admin, logistics) ----------
// Logistics can only send FROM their own base
app.post('/api/transfers',
  authorize('admin', 'logistics'),
  restrictToOwnBase((req) => req.body.fromBaseId),
  async (req, res) => {
    const { assetTypeId, fromBaseId, toBaseId, quantity } = req.body;
    try {
      const transfer = await withTx(async (c) => {
        // CHECK (quantity >= 0) makes this fail if stock is insufficient
        await c.query(
          `UPDATE inventory SET quantity = quantity - $3
           WHERE base_id = $1 AND asset_type_id = $2`,
          [fromBaseId, assetTypeId, quantity]);
        await c.query(
          `INSERT INTO inventory (base_id, asset_type_id, quantity) VALUES ($1,$2,$3)
           ON CONFLICT (base_id, asset_type_id)
           DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity`,
          [toBaseId, assetTypeId, quantity]);
        const { rows } = await c.query(
          `INSERT INTO transfers (asset_type_id, from_base_id, to_base_id, quantity, initiated_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [assetTypeId, fromBaseId, toBaseId, quantity, req.user.id]);
        await logAudit(c, req, 'TRANSFER', 'transfers', rows[0].id, rows[0]);
        return rows[0];
      });
      res.status(201).json(transfer);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

// ---------- ASSIGNMENTS (admin, base_commander) ----------
app.post('/api/assignments',
  authorize('admin', 'base_commander'),
  restrictToOwnBase((req) => req.body.baseId),
  async (req, res) => {
    const { assetTypeId, baseId, assignedTo, quantity } = req.body;
    try {
      const assignment = await withTx(async (c) => {
        await c.query(
          `UPDATE inventory SET quantity = quantity - $3
           WHERE base_id = $1 AND asset_type_id = $2`,
          [baseId, assetTypeId, quantity]);
        const { rows } = await c.query(
          `INSERT INTO assignments (asset_type_id, base_id, assigned_to, assigned_by, quantity)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [assetTypeId, baseId, assignedTo, req.user.id, quantity]);
        await logAudit(c, req, 'ASSIGN', 'assignments', rows[0].id, rows[0]);
        return rows[0];
      });
      res.status(201).json(assignment);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

// ---------- READ: active assignments (admin, base_commander) ----------
app.get('/api/assignments',
  authorize('admin', 'base_commander'),
  async (req, res) => {
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

// ---------- RETURN an assignment ----------
app.post('/api/assignments/:id/return',
  authorize('admin', 'base_commander'),
  async (req, res) => {
    try {
      const result = await withTx(async (c) => {
        const { rows } = await c.query(
          `UPDATE assignments SET returned_at = now()
           WHERE id = $1 AND returned_at IS NULL RETURNING *`, [req.params.id]);
        if (!rows[0]) throw new Error('Assignment not found or already returned');
        const a = rows[0];
        if (req.user.role !== 'admin' && a.base_id !== req.user.baseId)
          throw new Error('Outside your base');
        await c.query(
          `UPDATE inventory SET quantity = quantity + $3
           WHERE base_id = $1 AND asset_type_id = $2`,
          [a.base_id, a.asset_type_id, a.quantity]);
        await logAudit(c, req, 'RETURN', 'assignments', a.id, a);
        return a;
      });
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

// ---------- READ: inventory (all roles, scoped to own base) ----------
app.get('/api/inventory', async (req, res) => {
  const scoped = req.user.role !== 'admin';
  const { rows } = await pool.query(
    `SELECT b.name AS base, t.name AS asset, i.quantity
     FROM inventory i
     JOIN bases b ON b.id = i.base_id
     JOIN asset_types t ON t.id = i.asset_type_id
     ${scoped ? 'WHERE i.base_id = $1' : ''}`,
    scoped ? [req.user.baseId] : []);
  res.json(rows);
});

// ---------- READ: audit log (admin only) ----------
app.get('/api/audit', authorize('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
});

app.listen(3000, () => console.log('API running on :3000'));