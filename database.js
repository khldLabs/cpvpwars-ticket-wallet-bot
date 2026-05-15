// database.js  –  SQLite wallet store
import Database from "better-sqlite3";
import { mkdirSync } from "fs";

mkdirSync("./data", { recursive: true });
const db = new Database("./data/wallet.db");

// WAL mode: readers never block writers and vice-versa.
// busy_timeout: retry for up to 5 s if a write lock is briefly held.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    user_id   TEXT PRIMARY KEY,
    username  TEXT NOT NULL,
    balance   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    username   TEXT    NOT NULL,
    action     TEXT    NOT NULL,   -- 'add' | 'use' | 'remove' | 'set'
    amount     INTEGER NOT NULL,
    reason     TEXT,
    staff_id   TEXT,
    staff_name TEXT,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Composite primary key: one row per (transaction, product, recipient).
  -- INSERT OR IGNORE is the atomic "claim" — if changes() == 0, it's a duplicate.
  CREATE TABLE IF NOT EXISTS processed_transactions (
    tx_id        TEXT NOT NULL,
    product_id   TEXT NOT NULL,
    discord_id   TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tx_id, product_id, discord_id)
  );
`);

// ── Internal helpers ──────────────────────────────────────────────────────────

const _ensureWallet = db.prepare(`
  INSERT INTO wallets (user_id, username, balance)
  VALUES (?, ?, 0)
  ON CONFLICT(user_id) DO UPDATE SET username = excluded.username
`);

const _getBalance = db.prepare(
  `SELECT balance FROM wallets WHERE user_id = ?`
);

const _insertHistory = db.prepare(`
  INSERT INTO history (user_id, username, action, amount, reason, staff_id, staff_name)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// ── Public API ────────────────────────────────────────────────────────────────

/** Get balance (0 if wallet doesn't exist yet). */
export function getBalance(userId) {
  return _getBalance.get(userId)?.balance ?? 0;
}

/**
 * Add tickets.
 * Wrapped in a SQLite transaction — balance update and history log are atomic.
 * Returns new balance.
 */
export const addTickets = db.transaction(
  (userId, username, amount, reason, staffId, staffName) => {
    _ensureWallet.run(userId, username);
    db.prepare(
      `UPDATE wallets SET balance = balance + ? WHERE user_id = ?`
    ).run(amount, userId);
    const newBalance = _getBalance.get(userId).balance;
    _insertHistory.run(userId, username, "add", amount, reason ?? null, staffId, staffName);
    return newBalance;
  }
);

/**
 * Use (deduct) tickets with a required reason.
 * Throws if balance is insufficient.
 * Returns new balance.
 */
export const useTickets = db.transaction(
  (userId, username, amount, reason, staffId, staffName) => {
    _ensureWallet.run(userId, username);
    const current = _getBalance.get(userId)?.balance ?? 0;
    if (current < amount) {
      throw new Error(
        `Insufficient balance — **${username}** only has **${current}** ticket(s).`
      );
    }
    db.prepare(
      `UPDATE wallets SET balance = balance - ? WHERE user_id = ?`
    ).run(amount, userId);
    const newBalance = _getBalance.get(userId).balance;
    _insertHistory.run(userId, username, "use", amount, reason, staffId, staffName);
    return newBalance;
  }
);

/**
 * Remove tickets (admin correction — no "game used" semantics).
 * Throws if balance is insufficient.
 * Returns new balance.
 */
export const removeTickets = db.transaction(
  (userId, username, amount, reason, staffId, staffName) => {
    _ensureWallet.run(userId, username);
    const current = _getBalance.get(userId)?.balance ?? 0;
    if (current < amount) {
      throw new Error(
        `Cannot remove — **${username}** only has **${current}** ticket(s).`
      );
    }
    db.prepare(
      `UPDATE wallets SET balance = balance - ? WHERE user_id = ?`
    ).run(amount, userId);
    const newBalance = _getBalance.get(userId).balance;
    _insertHistory.run(userId, username, "remove", amount, reason, staffId, staffName);
    return newBalance;
  }
);

/**
 * Set balance to an exact number.
 * Records the difference as the history amount.
 * Returns new balance.
 */
export const setTickets = db.transaction(
  (userId, username, newAmount, reason, staffId, staffName) => {
    _ensureWallet.run(userId, username);
    const current = _getBalance.get(userId)?.balance ?? 0;
    db.prepare(
      `UPDATE wallets SET balance = ? WHERE user_id = ?`
    ).run(newAmount, userId);
    _insertHistory.run(userId, username, "set", newAmount - current, reason, staffId, staffName);
    return newAmount;
  }
);

/** Last N history rows for a user (most recent first). */
export function getHistory(userId, limit = 10) {
  return db.prepare(`
    SELECT * FROM history
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, limit);
}

// ── Tebex grant (claim + wallet + history in one SQLite transaction) ──────────

const _claimGrant = db.prepare(`
  INSERT OR IGNORE INTO processed_transactions (tx_id, product_id, discord_id)
  VALUES (?, ?, ?)
`);

/**
 * Atomically grant tickets from a Tebex purchase.
 *
 * All three writes — claim row, balance update, history insert — happen inside
 * one SQLite transaction. SQLite either commits all three or none of them, so
 * there is no window where the grant is claimed but tickets are not yet added.
 *
 * Returns:
 *   { granted: true,  newBalance: number }  – first time; tickets added.
 *   { granted: false, newBalance: number }  – duplicate delivery; nothing changed.
 */
export const grantTebexTickets = db.transaction(
  (txId, productId, userId, username, amount) => {
    // Step 1: attempt to claim this (tx, product, user) combination.
    // INSERT OR IGNORE means this is a no-op if the row already exists.
    const claim = _claimGrant.run(txId, String(productId), userId);

    // If changes() == 0, the row already existed → duplicate delivery, skip.
    if (claim.changes === 0) {
      const currentBalance = _getBalance.get(userId)?.balance ?? 0;
      return { granted: false, newBalance: currentBalance };
    }

    // Step 2: ensure wallet row exists for this user.
    _ensureWallet.run(userId, username);

    // Step 3: add tickets to balance.
    db.prepare(
      `UPDATE wallets SET balance = balance + ? WHERE user_id = ?`
    ).run(amount, userId);

    const newBalance = _getBalance.get(userId).balance;

    // Step 4: write history record.
    _insertHistory.run(
      userId, username, "add", amount,
      `Tebex purchase ${txId}`,
      "tebex-webhook", "Tebex (auto)"
    );

    return { granted: true, newBalance };
  }
);

export default db;
