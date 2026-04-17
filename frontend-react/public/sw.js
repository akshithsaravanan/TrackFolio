// Portfolio Tracker — Service Worker
// Strategy: cache-first for app shell assets, network-first for API calls

const CACHE_NAME = 'vriddhi-v2'

// App shell assets to precache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
]

// ── Install: precache the app shell ──────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  )
  self.skipWaiting()
})

// ── Activate: remove old caches ───────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  )
  self.clients.claim()
})

// ── Fetch: network-first for API, cache-first for assets ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // Never intercept API calls — always go to network
  if (url.port === '8000' || url.pathname.startsWith('/api/')) {
    return
  }

  // Never intercept Supabase calls
  if (url.hostname.includes('supabase')) {
    return
  }

  // For navigation requests (HTML pages): network-first, fall back to cached index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html')
      )
    )
    return
  }

  // For static assets: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached
      return fetch(event.request).then(response => {
        // Only cache successful same-origin responses
        if (
          response.ok &&
          response.type === 'basic' &&
          event.request.method === 'GET'
        ) {
          const toCache = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache))
        }
        return response
      })
    })
  )
})
