-- PostgreSQL schema: purchases, transfers, assignments, audit log

CREATE TABLE roles (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL          -- 'admin', 'base_commander', 'logistics'
);

CREATE TABLE bases (
  id       SERIAL PRIMARY KEY,
  name     TEXT UNIQUE NOT NULL,
  location TEXT
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_id       INT NOT NULL REFERENCES roles(id),
  base_id       INT REFERENCES bases(id)   -- NULL for admin (all bases)
);

CREATE TABLE asset_types (
  id       SERIAL PRIMARY KEY,
  name     TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL              -- e.g. vehicle, weapon, ammunition
);

-- Current stock of each asset type at each base
CREATE TABLE inventory (
  base_id       INT NOT NULL REFERENCES bases(id),
  asset_type_id INT NOT NULL REFERENCES asset_types(id),
  quantity      INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),  -- can never go negative
  PRIMARY KEY (base_id, asset_type_id)
);

CREATE TABLE purchases (
  id            SERIAL PRIMARY KEY,
  base_id       INT NOT NULL REFERENCES bases(id),
  asset_type_id INT NOT NULL REFERENCES asset_types(id),
  quantity      INT NOT NULL CHECK (quantity > 0),
  unit_cost     NUMERIC(12,2) NOT NULL,
  purchased_by  INT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id            SERIAL PRIMARY KEY,
  asset_type_id INT NOT NULL REFERENCES asset_types(id),
  from_base_id  INT NOT NULL REFERENCES bases(id),
  to_base_id    INT NOT NULL REFERENCES bases(id),
  quantity      INT NOT NULL CHECK (quantity > 0),
  initiated_by  INT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_base_id <> to_base_id)
);

CREATE TABLE assignments (
  id            SERIAL PRIMARY KEY,
  asset_type_id INT NOT NULL REFERENCES asset_types(id),
  base_id       INT NOT NULL REFERENCES bases(id),
  assigned_to   INT NOT NULL REFERENCES users(id),
  assigned_by   INT NOT NULL REFERENCES users(id),
  quantity      INT NOT NULL CHECK (quantity > 0),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at   TIMESTAMPTZ            -- NULL = still assigned
);

-- Append-only audit trail
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id),
  action      TEXT NOT NULL,           -- PURCHASE, TRANSFER, ASSIGN, RETURN
  entity      TEXT NOT NULL,
  entity_id   INT,
  details     JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Make audit_log tamper-resistant: app user may INSERT and SELECT only
-- (replace app_user with your application's DB role)
-- REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_user;

-- Indexes for common reports
CREATE INDEX idx_purchases_base_date  ON purchases (base_id, created_at);
CREATE INDEX idx_transfers_from       ON transfers (from_base_id, created_at);
CREATE INDEX idx_transfers_to         ON transfers (to_base_id, created_at);
CREATE INDEX idx_assignments_user     ON assignments (assigned_to);
CREATE INDEX idx_audit_user_date      ON audit_log (user_id, created_at);

-- Seed roles
INSERT INTO roles (name) VALUES ('admin'), ('base_commander'), ('logistics');
