import serverless from 'serverless-http';
import { isIP } from 'node:net';
import { createApp } from './app.js';

export function netlifyPublicUrl(env) {
  return env.PUBLIC_SITE_URL?.trim() || env.URL || '';
}

export function createNetlifyHandler(store, env = process.env) {
  const app = createApp(store, { publicSiteUrl: netlifyPublicUrl(env), serveStatic: false, rateLimitScope: 'per-instance' });
  const run = serverless(app);
  return (event, context) => {
    // Netlify supplies this header. Do not trust arbitrary X-Forwarded-For chains.
    const ip = event.headers?.['x-nf-client-connection-ip'];
    const prefix = '/.netlify/functions/app';
    const path = event.path === prefix ? '/' : event.path?.startsWith(prefix + '/') ? event.path.slice(prefix.length) : event.path;
    return run({ ...event, path, requestContext: { ...event.requestContext, identity: { sourceIp: isIP(ip || '') ? ip : '127.0.0.1' } } }, context);
  };
}
