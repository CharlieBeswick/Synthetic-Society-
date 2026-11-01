// Cache-busting label for the advertised session-start hyperlink.
// It is not a session identifier. /ouija/start without the query still works.
export const ouijaStartHref = '/ouija/start?v=phase13-hyperlink-board-2';
export const ouijaBoardMarker = 'Ouija Hyperlink Board — Phase 1.3 / Build 2';
export const ouijaDynamicCacheControl = 'private, no-store, no-cache, max-age=0, must-revalidate';
// These headers ask browsers and the Netlify CDN not to store session pages.
// A third-party retrieval tool can still ignore them and replay an old response.
