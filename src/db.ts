
const Database = require('better-sqlite3')

export type DbUser = {
  id: number
  name: string
  rate_violence: number,
  rate_insult: number,
  rate_political: number,
  rate_trolling: number,
  rate_inappropriate: number,
  rate_total: number,
}

export async function createDB(dbName: string): Promise<InstanceType<typeof Database>> {
  const db: InstanceType<typeof Database> = new Database(dbName);
  db.pragma('journal_mode = WAL');
  db.exec(`
      CREATE TABLE IF NOT EXISTS users (
                                           id INTEGER PRIMARY KEY,
                                           name TEXT NOT NULL,
                                           rate_violence INTEGER NOT NULL DEFAULT 0,
                                           rate_insult INTEGER NOT NULL DEFAULT 0,
                                           rate_political INTEGER NOT NULL DEFAULT 0,
                                           rate_trolling INTEGER NOT NULL DEFAULT 0,
                                           rate_inappropriate INTEGER NOT NULL DEFAULT 0,
                                               rate_total INTEGER NOT NULL DEFAULT 0
      );
  `);
  return db;
}

export function upsertUser(db: ReturnType<typeof Database>, user: DbUser): void {
  try {
    const stmt = db.prepare(`
        INSERT INTO users (
            id,
            name,
            rate_violence,
            rate_insult,
            rate_political,
            rate_trolling,
            rate_inappropriate,
            rate_total
        ) VALUES (
                     @id,
                     @name,
                     @rate_violence,
                     @rate_insult,
                     @rate_political,
                     @rate_trolling,
                     @rate_inappropriate,
                     @rate_total
                 )
        ON CONFLICT(id) DO UPDATE SET
                                      name = excluded.name,
                                      rate_violence = excluded.rate_violence,
                                      rate_insult = excluded.rate_insult,
                                      rate_political = excluded.rate_political,
                                      rate_trolling = excluded.rate_trolling,
                                      rate_inappropriate = excluded.rate_inappropriate,
        rate_total = excluded.rate_total;
    `);
    stmt.run(user);
  } catch (err) {
    console.error('Error upserting user:', err);
  }
}

export function getUser(db: ReturnType<typeof Database>, id: number): DbUser | undefined {
  try {
    const row = db.prepare(`
        SELECT
            id,
            name,
            rate_violence,
            rate_insult,
            rate_political,
            rate_trolling,
            rate_inappropriate,
            rate_total
        FROM users WHERE id = ?;
    `).get(id);
    return row as DbUser ?? undefined;
  } catch (err) {
    console.error('Error fetching user:', err);
  }
}

