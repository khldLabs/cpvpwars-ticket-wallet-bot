// backup.js  –  Safe daily backup using better-sqlite3's online backup API.
//
// Why db.backup() instead of copyFileSync:
//   WAL mode keeps recent writes in wallet.db-wal until a checkpoint flushes
//   them into the main file. Copying wallet.db directly can silently miss those
//   writes. db.backup() uses SQLite's online backup API, which reads through
//   the WAL and produces a fully consistent, single-file snapshot — no separate
//   -wal or -shm files needed, safe to copy while the bot is running.
//
// Two ways to use this:
//
// 1. Standalone (run immediately and exit):
//      node backup.js
//    Cron example — daily at 3 AM:
//      0 3 * * * cd /path/to/ticket-wallet-bot && node backup.js >> logs/backup.log 2>&1
//
// 2. Auto-scheduled from index.js:
//      import { scheduleBackups } from "./backup.js";
//      scheduleBackups();  // backs up every 24 h while the bot is running

import { mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import db from "./database.js";  // the live better-sqlite3 instance

const BACKUP_DIR = "./data/backups";
const KEEP_DAYS  = 7;
const MS_PER_DAY = 86_400_000;

async function runBackup() {
  mkdirSync(BACKUP_DIR, { recursive: true });

  // Timestamp: wallet-2025-01-31T03-00-00.db
  const stamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
  const dest  = join(BACKUP_DIR, `wallet-${stamp}.db`);

  // db.backup() performs an online backup via SQLite's backup API.
  // It reads through the WAL so the destination is always fully consistent,
  // even if there are uncommitted WAL pages that haven't been checkpointed yet.
  await db.backup(dest);
  console.log(`[backup] ✅ ${dest}`);

  // Prune backups older than KEEP_DAYS
  const cutoff = Date.now() - KEEP_DAYS * MS_PER_DAY;
  for (const file of readdirSync(BACKUP_DIR)) {
    if (!file.startsWith("wallet-") || !file.endsWith(".db")) continue;
    const full = join(BACKUP_DIR, file);
    // Reconstruct ISO string from filename: wallet-YYYY-MM-DDTHH-MM-SS.db
    const raw  = file.slice(7, -3).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
    const ts   = Date.parse(raw);
    if (!isNaN(ts) && ts < cutoff) {
      unlinkSync(full);
      console.log(`[backup] 🗑️  Removed old backup: ${file}`);
    }
  }
}

// ── Standalone mode ───────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith("backup.js");
if (isMain) {
  runBackup().catch((err) => {
    console.error("[backup] ❌ Failed:", err.message);
    process.exit(1);
  });
}

// ── Scheduled mode ────────────────────────────────────────────────────────────
export function scheduleBackups(intervalMs = MS_PER_DAY) {
  // First backup 1 min after startup, then every 24 h
  setTimeout(() => {
    runBackup().catch((err) => console.error("[backup] ❌", err.message));
    setInterval(() => {
      runBackup().catch((err) => console.error("[backup] ❌", err.message));
    }, intervalMs);
  }, 60_000);
  console.log(`[backup] Scheduled — daily backups to ${BACKUP_DIR}, keeping ${KEEP_DAYS} days.`);
}
