import { applySchema, createStoreFromExecutor, storageContext } from './postgres.js';

const contexts = storageContext;

function normalize(result) {
  return { rows: result?.rows || [], rowCount: result?.rowCount ?? result?.affectedRows ?? 0 };
}

export async function createPgliteStore(options = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  let chain = Promise.resolve();
  const executor = {
    async query(text, params = []) {
      const current = contexts.getStore() || db;
      try {
        return normalize(await current.query(text, params));
      } catch (error) {
        if (error?.code === '23505' || error?.name === 'DatabaseError') throw error;
        const wrapped = new Error(error?.code === '42P01' ? 'Database schema is not installed. Run npm run db:migrate.' : 'Database request failed.');
        wrapped.name = 'DatabaseError';
        wrapped.status = 503;
        wrapped.code = error?.code;
        throw wrapped;
      }
    },
    transaction(work) {
      if (contexts.getStore()) return work();
      const run = chain.then(async () => {
        await db.exec('BEGIN');
        try {
          const result = await contexts.run(db, work);
          await db.exec('COMMIT');
          return result;
        } catch (error) {
          try { await db.exec('ROLLBACK'); } catch { /* already closed */ }
          throw error;
        }
      });
      chain = run.then(() => {}, () => {});
      return run;
    },
    close: () => db.close()
  };
  await applySchema(executor);
  const store = createStoreFromExecutor(executor, options);
  store.executor = executor;
  return store;
}
