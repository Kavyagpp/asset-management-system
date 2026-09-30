# Database Choice and Design

## Choice: PostgreSQL (relational SQL)

**Why relational:** the data is highly connected (users, bases, assets, purchases, transfers, assignments) and every operation touches several records that must stay consistent.

**Why PostgreSQL specifically:**
- **ACID transactions:** a transfer subtracts stock from one base and adds it to another. Both happen together or not at all.
- **Integrity constraints:** foreign keys tie every record to a valid user, base, and asset type. `CHECK (quantity >= 0)` makes overselling or over-assigning impossible at the database level.
- **Auditability:** an append-only `audit_log` table with JSONB details. UPDATE/DELETE can be revoked from the application role.
- **Security:** roles and row-level security can back up the API middleware.
- **Reporting:** balances by base and period are simple joins and aggregates.
- Free, mature, and widely supported.

**Why not NoSQL:** cross-record transactions and joins would have to be rebuilt in application code, with weaker integrity guarantees.

## Schema Overview

| Table | Purpose |
|---|---|
| roles, users | Identity and role (admin, base_commander, logistics) |
| bases | Physical locations |
| asset_types | What is tracked (vehicles, weapons, ammunition, etc.) |
| inventory | Current quantity of each asset type at each base |
| purchases | Immutable record of every acquisition |
| transfers | Immutable record of every base-to-base movement |
| assignments | Assets given to a person; `returned_at IS NULL` = still assigned |
| audit_log | Who did what, when, from which IP, with full details |

## How the design supports the requirements

- **Purchases:** each purchase inserts a row in `purchases` and increases `inventory` in one transaction.
- **Movements (transfers):** each transfer records source, destination, quantity, and initiator, and moves stock in `inventory` atomically. History is queryable per base or asset type.
- **Assignments:** each assignment records who received it, who approved it, and when. Stock is reduced on assignment and restored on return.
- **Balance reporting:** closing balance = opening + purchases + transfers in - transfers out - net assignments.
- **Role-based access:** middleware (`authenticate`, `authorize`, `restrictToOwnBase`) enforces:
  - Admin: everything, all bases
  - Base Commander: assignments and viewing, own base only
  - Logistics: purchases and transfers, own base only
- **API logging:** two layers.
  1. `requestLogger` records every mutating HTTP request (user, URL, status, IP).
  2. `logAudit` writes a detailed entry inside the same transaction as each purchase, transfer, assignment, or return, so the log and the data can never disagree.

## Setup

```
npm i express pg jsonwebtoken
psql $DATABASE_URL -f schema.sql
JWT_SECRET=change-me DATABASE_URL=postgres://... node server.js
```

JWT payload expected: `{ id, role, baseId }`.
