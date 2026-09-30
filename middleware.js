const jwt = require('jsonwebtoken');
const pool = require('./db');

// 1. Authentication: verify JWT, attach user { id, role, baseId } to req
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// 2. Role-based access: allow only listed roles
const authorize = (...allowedRoles) => (req, res, next) => {
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: insufficient role' });
  }
  next();
};

// 3. Base scoping: non-admins may only act on their own base.
//    `getBaseIds(req)` returns the base id(s) the request touches.
const restrictToOwnBase = (getBaseIds) => (req, res, next) => {
  if (req.user.role === 'admin') return next();
  const ids = [].concat(getBaseIds(req)).filter(Boolean).map(Number);
  // Commanders/logistics can only involve their own base
  if (ids.some((id) => id !== req.user.baseId)) {
    return res.status(403).json({ error: 'Forbidden: outside your base' });
  }
  next();
};

// 4. Request logger: records every mutating API call (success or failure)
function requestLogger(req, res, next) {
  if (req.method === 'GET') return next();
  res.on('finish', () => {
    pool
      .query(
        `INSERT INTO audit_log (user_id, action, entity, details, ip)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.user?.id ?? null,
          `HTTP_${req.method}`,
          req.originalUrl,
          JSON.stringify({ status: res.statusCode, body: req.body }),
          req.ip,
        ]
      )
      .catch((e) => console.error('audit log failed', e));
  });
  next();
}

// 5. Transaction-level audit entry: call inside the same DB transaction
//    as the change, so data and log commit (or roll back) together.
function logAudit(client, req, action, entity, entityId, details) {
  return client.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.user.id, action, entity, entityId, JSON.stringify(details), req.ip]
  );
}

module.exports = { authenticate, authorize, restrictToOwnBase, requestLogger, logAudit };
