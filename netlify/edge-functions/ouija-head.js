const privateOuijaPath = /^\/ouija\/.+/i;

// Netlify's edge routing turns HEAD into GET before a function runs, which
// would create an Ouija session. Reject HEAD here, before that rewrite.
// The deploy manifest rejects method: "HEAD", so the method is checked below.
export default (request) => {
  const path = new URL(request.url).pathname;
  if (request.method !== 'HEAD' || !privateOuijaPath.test(path)) return;
  return new Response(null, {
    status: 405,
    headers: {
      Allow: 'GET',
      'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
      'CDN-Cache-Control': 'no-store',
      'Netlify-CDN-Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive'
    }
  });
};

export const config = { pattern: '/[Oo][Uu][Ii][Jj][Aa]/.+' };
