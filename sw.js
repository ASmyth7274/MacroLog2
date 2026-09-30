/* MacroLog service worker — offline cache.
   Kept as a real same-origin file because browsers refuse inline/blob SW
   registration. Open Food Facts / USDA API responses are NOT cached here —
   product data is cached structurally in IndexedDB by the app itself (keyed by
   barcode), which survives cache eviction and is queryable.

   v4.0 strategy, per kind of request:
   · the app itself (same origin) — network-first, but a navigation that hasn't
     answered within NAV_TIMEOUT is served from cache while the network carries
     on and refreshes it. A gym basement with one bar of signal used to mean
     staring at a blank screen until the request gave up.
   · CDN libraries + Google Fonts — stale-while-revalidate: instant from cache,
     refreshed in the background.
   · product photos (openfoodfacts image hosts) — NOT cached here at all.

   Only CORS/same-origin responses that came back OK are ever stored. The old
   worker cached whatever arrived: a 404/500 could overwrite the good shell, and
   every product thumbnail went in as an OPAQUE response — which Chrome pads to
   several MB EACH in quota accounting. Dozens of scanned products inflated the
   origin's usage by hundreds of MB, which is exactly the storage pressure that
   gets a best-effort origin evicted whole (see ensurePersistence() in
   index.html). The CDN scripts and font CSS are now requested with CORS (the
   page sets crossorigin) so they cache as normal, unpadded responses. */
const CACHE='macrolog-v4.0';   // renamed → activate reaps the old caches and their padded entries
const NAV_TIMEOUT=3500;
/* Precached on install so the new cache is POPULATED before activate reaps the
   old one — a rename plus a reap with nothing precached would delete the only
   copy of the shell, and the next launch that happens offline would get the
   browser's error page instead of the app. */
const SHELL=['./','./index.html','./manifest.json','./icon-192.png',
  './icon-512.png','./apple-touch-icon.png'];
/* Chart.js is on every Progress visit, but the first page load happens BEFORE
   this worker controls the page, so it never passed through here — charts
   were missing offline until some later online visit happened to re-fetch
   them. Fetched best-effort at install instead; a failure never blocks the
   shell. (The scanner library is left to on-demand caching: most Android
   phones never need it, BarcodeDetector is built in.) */
const CDN_PRE=['https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js'];
const CDN=/^(cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
const PASS=/(^|\.)openfoodfacts\.org$|^api\.nal\.usda\.gov$/;

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>Promise.all([
    // cache:'reload' — straight from the server, never a stale HTTP-cache copy
    c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'}))).catch(()=>{}),
    ...CDN_PRE.map(u=>c.add(new Request(u,{mode:'cors',credentials:'omit'})).catch(()=>{}))
  ])).catch(()=>{}));
  self.skipWaiting();
});
/* Old caches are deleted on activate: dead weight counts towards the origin's
   quota, the same quota pressure that gets a best-effort origin evicted. */
self.addEventListener('activate',e=>e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())));

const cacheable=r=>!!r&&r.status===200&&(r.type==='basic'||r.type==='cors');
function store(req,r){
  if(!cacheable(r))return Promise.resolve();
  const cp=r.clone();
  return caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{});
}
function fromCache(req){
  const nav=req.mode==='navigate';
  // a navigation that was never cached under its exact URL (a shortcut's query
  // string, ./ vs ./index.html) still gets the shell rather than the browser's
  // offline page
  return caches.match(req,{ignoreSearch:nav,ignoreVary:true})
    .then(m=>m||(nav?caches.match('./index.html'):null));
}
/* store() is chained FIRST on the fetch so its clone() runs before anything
   hands the response on and reads its body; waitUntil is registered
   synchronously so the worker stays alive until the copy is written. */
function networkFirst(e,req){
  const net=fetch(req);
  e.waitUntil(net.then(r=>store(req,r),()=>{}));
  return new Promise(resolve=>{
    let settled=false;
    const finish=r=>{if(!settled&&r){settled=true;resolve(r);}};
    const timer=req.mode==='navigate'
      ?setTimeout(()=>fromCache(req).then(finish),NAV_TIMEOUT):0;
    net.then(r=>{
      clearTimeout(timer);
      // a server error on a navigation: the cached shell beats an error page
      if(!r.ok&&req.mode==='navigate')return fromCache(req).then(m=>finish(m||r));
      finish(r);
    },()=>{
      clearTimeout(timer);
      return fromCache(req).then(m=>finish(m||Response.error()));
    });
  });
}
function staleWhileRevalidate(e,req){
  const net=fetch(req);
  e.waitUntil(net.then(r=>store(req,r),()=>{}));
  return caches.match(req,{ignoreVary:true}).then(m=>m||net);
}

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  let url;
  try{url=new URL(req.url);}catch(err){return;}
  if(url.protocol!=='http:'&&url.protocol!=='https:')return;
  // The app handles food-API availability itself (its own IDB cache and
  // offline UI) — stale API responses from a SW cache would mask that.
  // Product images are left to the browser's own HTTP cache (see top).
  if(PASS.test(url.hostname))return;
  if(url.origin===self.location.origin){e.respondWith(networkFirst(e,req));return;}
  if(CDN.test(url.hostname)){e.respondWith(staleWhileRevalidate(e,req));return;}
  // anything else cross-origin: straight to the network, untouched
});
