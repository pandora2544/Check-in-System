/*
 * Service worker — CSE-SMART-LAB (ชื่อ cache cph-* คงไว้เพื่อไม่ให้เครื่องที่ติดตั้งแล้วโหลดใหม่ทั้งหมด)
 * เวอร์ชันถูกแทนตอน build บน Vercel (build.sh) → ไฟล์นี้เปลี่ยนทุก deploy → เบราว์เซอร์รู้ว่ามีตัวใหม่
 *
 * กลยุทธ์
 *   หน้าเว็บ (HTML)            network-first  → มีเน็ตได้ของใหม่เสมอ ไม่มีเน็ตใช้ของที่เก็บไว้
 *   ไฟล์ในเว็บ (lib/icons)      stale-while-revalidate
 *   CDN ที่ระบุเวอร์ชันแน่นอน   cache-first (เช่น human@3.3.6 + โมเดลหลาย MB → เปิดครั้งต่อไปเร็วมาก)
 *   CDN ที่ไม่ระบุเวอร์ชัน      stale-while-revalidate (เช่น supabase-js@2, Google Fonts CSS)
 *   API (supabase.co), version.json, แผนที่ → ไม่ผ่าน cache
 */
const VERSION = '__APP_VERSION__';
const SHELL = `cph-shell-${VERSION}`;
const RUNTIME = `cph-rt-${VERSION}`;
const CDN = 'cph-cdn-v1'; // ไม่ผูกเวอร์ชันแอป — โมเดลใบหน้าไม่ต้องโหลดใหม่ทุก deploy

const PRECACHE = [
  '/', '/staff', '/manifest.webmanifest', '/staff.webmanifest',
  '/lib/pwa.js', '/lib/xlsx-lite.js', '/lib/work.js', '/lib/work.css',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const PINNED = /@\d+\.\d+\.\d+|\/ajax\/libs\/[^/]+\/\d+\.\d+\.\d+\/|fonts\.gstatic\.com/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // ทีละไฟล์ — ไฟล์ไหนโหลดไม่ได้ไม่ทำให้ติดตั้งล้มทั้งหมด
    await Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting(); // หน้าเว็บเป็น network-first อยู่แล้ว เปลี่ยนตัวคุมทันทีได้อย่างปลอดภัย
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => (k.startsWith('cph-shell-') && k !== SHELL) || (k.startsWith('cph-rt-') && k !== RUNTIME)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'VERSION') event.source?.postMessage({ type: 'SW_VERSION', version: VERSION });
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(req), timeout(6000)]);
    if (res.ok) cache.put(new URL(req.url).pathname, res.clone());
    return res;
  } catch {
    const path = new URL(req.url).pathname;
    return (await cache.match(path)) || (await cache.match(path.replace(/\.html$/, ''))) || (await cache.match('/')) ||
      new Response('<meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">ไม่มีอินเทอร์เน็ต — ต่อเน็ตแล้วลองใหม่</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || new Response('', { status: 504 });
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname === '/version.json' || url.pathname === '/sw.js') return; // ต้องสดเสมอ
    if (req.mode === 'navigate') return event.respondWith(networkFirst(req));
    return event.respondWith(staleWhileRevalidate(req, RUNTIME));
  }
  if (CDN_HOSTS.includes(url.hostname)) {
    return event.respondWith(PINNED.test(req.url) ? cacheFirst(req, CDN) : staleWhileRevalidate(req, CDN));
  }
  // อื่นๆ (Supabase API, แผนที่ OSM) → ปล่อยเบราว์เซอร์จัดการตามปกติ
});
