/**
 * Which "page" a URL is, for the purpose of deciding which threads it shows.
 *
 * A thread left on `/users/42` is about the user page, not about user 42: the
 * next session will be looking at user 7, or at a freshly seeded database where
 * 42 does not exist. So ids collapse to `:id`. What counts as an id is
 * deliberately conservative — numbers, UUIDs, long hex, Mongo-style object ids —
 * because collapsing a real word (`/settings` → `/:id`) would merge pages the
 * reviewer thinks of as different, and that is a worse failure than two user
 * pages holding separate threads.
 *
 * The host is dropped on purpose: the same app runs on `localhost:4200` today
 * and `localhost:4201` tomorrow, or on a staging host, and the threads belong
 * to the app. The query string is dropped too (filters, tracking params). Hash
 * routing (`#/route`, `#!/route`) IS the route, so it replaces the path.
 *
 * Same algorithm as the refiner TUI's `src/web/page.ts`: both write page keys
 * into the shared file, so they must agree.
 */

const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  /^[0-9a-z]{20,}$/i,
];

export function pageKey(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
    return url.protocol + url.pathname;
  }
  let path = url.pathname;
  const hash = url.hash.match(/^#!?(\/[^?]*)/);
  if (hash) {
    path = hash[1];
  }
  const segs = path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (ID_SEGMENT.some((re) => re.test(s)) ? ':id' : decodeURIComponent(s)));
  return '/' + segs.join('/');
}

/** `localhost:4200/x` → `http://localhost:4200/x`; anything with a scheme passes. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^localhost:\d/i.test(trimmed)) {
    return trimmed;
  }
  const host = trimmed.replace(/^\/+/, '');
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host);
  return `${local ? 'http' : 'https'}://${host}`;
}
