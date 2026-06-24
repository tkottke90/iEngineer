import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgresql://iracing:iracing@localhost:5432/iracing_engineer";

export const db = postgres(url);

export async function withTransaction<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return db.begin(fn);
}
