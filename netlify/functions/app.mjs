import { getStore } from '@netlify/blobs';
import { withLambda } from '@netlify/aws-lambda-compat';
import { createBlobsStore } from '../../src/blobs-store.js';
import { createNetlifyHandler } from '../../src/netlify-handler.js';
import { blobsAudit, blobsSessions } from '../../src/session-backends.js';

let run;
const invoke = withLambda(async (event, context) => {
  try {
    if (!run) {
      // Site-wide store survives new deployments. Never use a deploy store here.
      const currentStore = () => createBlobsStore(getStore({ name: process.env.BLOBS_STORE_NAME || 'synthetic-society-messages', consistency: 'strong' }));
      // Resolve the SDK client using this invocation's context, not a cached token.
      const sessionBlobs = () => getStore({ name: `${process.env.BLOBS_STORE_NAME || 'synthetic-society-messages'}-sessions`, consistency: 'strong' });
      run = createNetlifyHandler({
        add: (...args) => currentStore().add(...args),
        putIfAbsent: record => currentStore().putIfAbsent(record),
        get: (...args) => currentStore().get(...args),
        recent: () => currentStore().recent(),
        claimOuijaV2: claim => currentStore().claimOuijaV2(claim)
      }, process.env, blobsSessions(sessionBlobs), blobsAudit(sessionBlobs));
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
