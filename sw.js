/* MacroLog service worker — offline cache.
   Kept as a real same-origin file because browsers refuse inline/blob SW
   registration. Strategy: network-first with cache fallback — always fresh
   while online, and the app (plus CDN libs: Chart.js, ZXing, Google Fonts)
   keeps working offline after the first load. Open Food Facts API responses
   are NOT cached here — product data is cached structurally in IndexedDB by
   the app itself (keyed by barcode), which survives cache eviction and is
   queryable. */
const CACHE='macrolog-v2';   // bumped for v3.3 — drops the v3.2 cached shell
/* Precached on install so the new cache is POPULATED before activate reaps the
   old one. Without this the rename and the reap together delete the only copy of
   the shell and leave nothing in its place: the page has already loaded by the
   time the new worker activates, index.html never touches CacheStorage and never
   reloads itself, so nothing re-requests the document — and the next launch that
   happens offline gets the browser's error page instead of the app. A bare
   rename was survivable (caches.match searches every cache in the origin); a
   rename PLUS a reap is not. */
const SHELL=['./','./index.html','./manifest.json','./icon-192.png',
  './icon-512.png','./apple-touch-icon.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});
/* v3.3: old caches are now deleted on activate. Every previous cache name was
   kept forever, and that dead weight counts towards the origin's quota — which
   is the same quota pressure that gets a "best-effort" origin evicted whole
   (see ensurePersistence() in index.html). Reaping them is part of the
   data-loss fix, not just tidiness. */
self.addEventListener('activate',e=>e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())));

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  // Let the app handle food-API availability itself (it has its own IDB
  // cache and offline UI) — stale API responses from a SW cache would mask
  // that. Applies to Open Food Facts AND USDA FoodData Central.
  if(url.hostname.endsWith('openfoodfacts.org')||url.hostname==='api.nal.usda.gov')return;
  e.respondWith(
    fetch(e.request).then(r=>{
      const cp=r.clone();
      caches.open(CACHE).then(c=>c.put(e.request,cp)).catch(()=>{});
      return r;
    }).catch(()=>caches.match(e.request)
      // a navigation that was never cached under its exact URL (a shortcut
      // query string, ./ vs ./index.html) still gets the shell rather than the
      // browser's offline page
      .then(m=>m||(e.request.mode==='navigate'?caches.match('./index.html'):null))
      .then(m=>m||Response.error()))
  );
});
