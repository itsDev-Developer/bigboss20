/**
 * Ottfree frontend — global configuration.
 *
 * BASE_URL is "wherever the backend appears to live, from this frontend's
 * point of view". It defaults to "/api-proxy" — a path on THIS SAME origin
 * that server.js transparently forwards to the real backend server-side.
 * That's what avoids CORS entirely: the browser never talks cross-origin.
 *
 *   - Running via `npm start` (Render Web Service, Termux, any Node host)?
 *     Leave BASE_URL as "/api-proxy" and instead point the *proxy* at your
 *     backend with the OTTFREE_API_URL environment variable (defaults to
 *     https://ucapi-jtrl.onrender.com — see server.js / .env.example).
 *   - Deploying as a plain static site with no Node process behind it?
 *     There's nothing to proxy through, so set BASE_URL below to your full
 *     backend URL instead (e.g. "https://ucapi-jtrl.onrender.com") — but
 *     then the backend itself must send CORS headers, since the browser
 *     will be calling it directly cross-origin. See DEPLOY.md.
 *
 * Either way, `npm run build` can also bake these in from environment
 * variables instead of hand-editing this file — see .env.example.
 */
window.OTTFREE_CONFIG = {
  BASE_URL: "/api-proxy",

  // TMDb v3 API key, used client-side only to fetch episode lists, overviews,
  // backdrops and ratings that the backend doesn't already provide.
  // Get one free at https://www.themoviedb.org/settings/api
  TMDB_API_KEY: "",
  TMDB_IMG: "https://image.tmdb.org/t/p",

  // How many channels to sample when building the Home page's aggregated
  // rows (New Releases / Trending / Featured). Keep this modest — each
  // channel costs one extra request.
  HOME_CHANNEL_SAMPLE: 6,

  // How many channel pages to walk when building a season's episode map on
  // the watch page, before giving up looking for more matches.
  MAX_EPISODE_SCAN_PAGES: 6,
};
