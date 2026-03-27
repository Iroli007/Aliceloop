import Database from "better-sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const dbDir = process.env.ALICELOOP_DATA_DIR?.trim()
  ? process.env.ALICELOOP_DATA_DIR.trim()
  : join(currentDir, "../.data");
const dbPath = join(dbDir, "aliceloop.db");
const db = new Database(dbPath);

const rows = db.prepare("SELECT * FROM provider_configs WHERE enabled = 1").all();
console.log(JSON.stringify(rows, null, 2));

db.close();
