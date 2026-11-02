import { withLambda } from '@netlify/aws-lambda-compat';
import { createNetlifyHandler } from '../../src/netlify-handler.js';
import { createPostgresStore } from '../../src/postgres.js';

let run;
const invoke = withLambda(async (event, context) => {
  try {
    if (!run) {
      const connectionString = process.env.DATABASE_URL?.trim() || '';
      if (!connectionString) throw new Error('DATABASE_URL is required. Refusing to start without PostgreSQL.');
      const store = createPostgresStore(connectionString, { serverless: true });
      run = createNetlifyHandler(store, process.env, store.sessions, store.audit, store.identity);
    }
    return await run(event, context);
  } catch (error) {
    console.error('Netlify application initialization or invocation failed:', error.name);
    return { statusCode: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify({ success: false, error: 'Storage service is temporarily unavailable.' }) };
  }
});

export default (request, context) => {
  // Use the trusted platform IP, not a client-supplied forwarding header.
  const headers = new Headers(request.headers);
  headers.delete('x-forwarded-for');
  headers.delete('forwarded');
  headers.set('x-nf-client-connection-ip', context.ip || '127.0.0.1');
  return invoke(new Request(request, { headers }), context);
};

// Enforced by Netlify before invocation; unlike Express memory counters,
// this does not reset when a new function instance starts.
export const config = {
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] }
};
