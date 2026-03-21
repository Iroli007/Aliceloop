import Database from "better-sqlite3";
import { join } from "path";

const dbPath = join(process.cwd(), ".data", "aliceloop.db");
const db = new Database(dbPath);

const rows = db.prepare("SELECT * FROM provider_configs WHERE enabled = 1").all();
console.log(JSON.stringify(rows, null, 2));

db.close();
