// Cache-busting label for the public session-start hyperlink.
// It is not a session identifier. /ouija/start and older ?v= values still create a session.
// A retrieval tool can cache this exact URL, so a live session page offers a different Start Fresh link.
export const ouijaStartHref = '/ouija/start?v=phase14-fresh-session-1';
export const ouijaV2StartHref = '/ouija/v2/start?v=v2-fresh-1';
// One query value, with no ampersand, so a text tool can copy the href without decoding HTML.
// The embedded response id selects nothing and authorizes nothing.
export const freshSessionHref = responseId => /^resp_[0-9a-f]{8}$/.test(responseId) ? `/ouija/start?v=phase14-recover-${responseId}` : ouijaStartHref;
export const ouijaV2FreshHref = responseId => /^resp_[0-9a-f]{8}$/.test(responseId) ? `/ouija/v2/start?v=recover-${responseId}` : ouijaV2StartHref;
export function recoveryResponseId(query = {}) {
  if (/^resp_[0-9a-f]{8}$/.test(query.recover)) return query.recover;
  const embedded = typeof query.v === 'string' && query.v.match(/^phase14-recover-(resp_[0-9a-f]{8})$/);
  return embedded ? embedded[1] : null;
}
export const ouijaBoardMarker = 'Ouija Hyperlink Board — Phase 1.3 / Build 2';
export const ouijaDynamicCacheControl = 'private, no-store, no-cache, max-age=0, must-revalidate';
// These headers ask browsers and the Netlify CDN not to store session pages.
// A third-party retrieval tool can still ignore them and replay an old response.
