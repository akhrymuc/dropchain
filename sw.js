/* オフラインで遊べるようにするための Service Worker（2048 と同じ作り） */

var CACHE = 'dropchain-v4';               // 版が変わるとキャッシュを作り直す
var V = CACHE.replace('dropchain-', '');  // index.html が読み込む ?v4 と揃っている必要がある

/* これが無いとアプリが動かないもの */
var ESSENTIAL = [
  './',
  './index.html',
  './style.css?' + V,
  './game.js?' + V,
  './app.js?' + V
];

/* 欠けても遊べるもの（アイコンなど） */
var OPTIONAL = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

var ASSETS = ESSENTIAL.concat(OPTIONAL);

self.addEventListener('install', function (e) {
  /* 1つずつ取得する。まとめて取得すると、アイコンが1枚欠けただけで
     更新全体が中止され、古い版のまま取り残される。 */
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      var failed = [];
      return Promise.all(ASSETS.map(function (u) {
        return c.add(u).catch(function () { failed.push(u); });
      })).then(function () {
        if (failed.length) console.warn('[dropchain] 取得できなかったファイル: ' + failed.join(', '));

        var missing = failed.filter(function (u) { return ESSENTIAL.indexOf(u) >= 0; });
        if (missing.length) {
          /* 動かない版を入れるくらいなら、今動いている版を残す。
             更新は次回の起動でやり直される。 */
          throw new Error('[dropchain] 必須ファイルを取得できないため更新を中止: ' + missing.join(', '));
        }
        return self.skipWaiting();
      });
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) { return n === CACHE ? null : caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* ブラウザのキャッシュを使わずに取りに行く。
   GitHub Pages は10分間キャッシュを持たせるため、これがないと
   更新したはずのHTMLが古いまま返ってくる。 */
function freshFetch(req) {
  try {
    return fetch(req, { cache: 'no-store' });
  } catch (err) {
    return fetch(req);        // cache オプション未対応のブラウザ向け
  }
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  /* ページ本体（HTML）は必ず新しいものを取りに行く。
     古いHTMLと新しいJSが食い違うのを防ぐため。 */
  if (e.request.mode === 'navigate') {
    var fallback = function () {
      return caches.match(e.request).then(function (r) {
        return r || caches.match('./index.html');
      });
    };
    e.respondWith(
      freshFetch(e.request).then(function (res) {
        /* 404 や 5xx は「新しいページ」ではない。遊べていたアプリを壊さないため、
           キャッシュ済みのページを使い、保存もしない。 */
        if (!res || !res.ok) return fallback().then(function (r) { return r || res; });
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(fallback)          // 通信できないとき（オフライン）
    );
    return;
  }

  /* それ以外はキャッシュを即返しつつ、裏で新しいものを取ってくる */
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request).then(function (cached) {
        var network = fetch(e.request).then(function (res) {
          if (res && res.status === 200) cache.put(e.request, res.clone());
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      });
    })
  );
});
