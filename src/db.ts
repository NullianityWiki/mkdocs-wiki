
const Database = require('better-sqlite3')

export type DbUser = {
  id: number
  name: string
  toxicLevel: number
}

export async function createDB(dbName: string): Promise<InstanceType<typeof Database>> {
  const db: InstanceType<typeof Database> = new Database(dbName)
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      toxicLevel INTEGER NOT NULL
    );
  `)
  return db;
}

export function upsertUser(db: ReturnType<typeof Database>, user: DbUser): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO users (id, name, toxicLevel)
      VALUES (@id, @name, @toxicLevel)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        toxicLevel = excluded.toxicLevel;
    `)
    stmt.run(user)
  } catch (err) {
    console.error('Error upserting user:', err)
  }
}

export function getUser(db: ReturnType<typeof Database>, id: number): DbUser | undefined {
  try {
    const row = db
      .prepare(`SELECT id, name, toxicLevel FROM users WHERE id = ?;`)
      .get(id)
    return (row as DbUser) ?? undefined
  } catch (err) {
    console.error('Error fetching user:', err)
  }
}
