export function requireDatabaseUrl(env = process.env) {
  const connectionString = env.DATABASE_URL?.trim() || '';
  if (!connectionString) throw new Error('DATABASE_URL is required. Refusing to start without PostgreSQL.');
  return connectionString;
}

export function databaseHost(connectionString) {
  const url = new URL(connectionString);
  const port = url.port || '5432';
  const name = url.pathname.replace(/^\//, '') || '(default)';
  return `${url.hostname}:${port}/${name}`;
}
