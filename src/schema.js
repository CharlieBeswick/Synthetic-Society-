import { createPgExecutor, applySchema, schemaStatus } from './postgres.js';
import { databaseHost } from './storage.js';

const command = process.argv[2] || 'status';
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set DATABASE_URL_UNPOOLED for migrations, or DATABASE_URL when you only have one connection string.');
  process.exitCode = 1;
} else if (!['migrate', 'status'].includes(command)) {
  console.error('Use: npm run db:migrate   or   npm run db:status');
  process.exitCode = 1;
} else {
  const executor = createPgExecutor(connectionString, { serverless: false });
  const target = databaseHost(connectionString);
  const run = command === 'migrate' ? applySchema(executor) : schemaStatus(executor);
  run.then(result => {
    console.log(JSON.stringify({ command, target, ...result }));
  }).catch(error => {
    console.error(error.name === 'DatabaseError' ? error.message : 'Schema command failed.');
    process.exitCode = 1;
  }).finally(() => executor.close());
}
