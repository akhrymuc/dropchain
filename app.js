/* dropchain — 画面・操作・保存。ルールは game.js にある */
(function () {
  'use strict';

  var APP_VERSION = 'v4';   // 画面下に出す版。sw.js の CACHE と揃っている必要がある

  var BEST_KEY = 'dropchain.best.v1';        // ハイスコア
  var SYMBOL_KEY = 'dropchain.symbols.v1';   // 記号を重ねるか
  var SAVE_KEY = 'dropchain.save.v1';        // 一時停止したときのゲームの途中経過
  // 保存するのはこの 3 つだけ

  var COLORS = [null, '#e8475a', '#46c06a', '#3d8ce0', '#e8c33c', '#a661d8'];
  var BOARD_BG = '#121927';
  var GRID = '#1e2738';

  var STEP_MS = 1000 / 60;      // ロジックは固定タイムステップで進める
  var REPEAT_FIRST = 250;       // 左右の長押し: 初回
  var REPEAT_EVERY = 80;        //               以降
  var OVER_MS = 900;            // ゲームオーバーの演出
  var COUNT_FROM = 3;           // 再開のカウントダウン 3, 2, 1
  var COUNT_STEP_MS = 1000;     // 1 つの数字を出す時間

  var $ = function (id) { return document.getElementById(id); };

  var game = null;
  var running = false;          // ゲーム画面で時間が進んでいるか
  var paused = false;
  var overAt = 0;               // ゲームオーバー演出の開始時刻（0 = 演出中でない）
  var countAt = 0;              // 再開カウントダウンの開始時刻（0 = カウントダウン中でない）
  var best = 0;
  var bestAtStart = 0;
  var symbols = false;
  var popups = [];              // 連鎖数・レベルアップの表示 { text, sub, t, dur, kind }
  var vis = null;               // 操作中の組の見た目の位置（補間用） { x, y, ang }
  var lastCur = null;
  var held = {};                // 押されているボタン
  var repeatTimers = {};

  var canvas, ctx, cell = 40, dpr = 1;
  var sprites = {};             // 色ごとの絵（マスの大きさが変わったら作り直す）
  var rafId = 0, lastTime = 0, acc = 0;
  var hudScore = -1, hudLevel = -1;

  /* ---------- 保存 ---------- */

  function load() {
    try { best = Math.max(0, parseInt(localStorage.getItem(BEST_KEY), 10) || 0); } catch (e) { best = 0; }
    try { symbols = localStorage.getItem(SYMBOL_KEY) === '1'; } catch (e) { symbols = false; }
  }
  function saveBest() { try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {} }
  function saveSymbols() { try { localStorage.setItem(SYMBOL_KEY, symbols ? '1' : '0'); } catch (e) {} }

  /* 途中経過。一時停止したとき・アプリを裏に回したときに書き、終わったら消す。
     bestAtStart も持っておかないと、再開した局で「ハイスコア更新！」が正しく出ない。 */
  function saveGame() {
    if (!game || overAt) return;
    var data = DC.serialize(game);
    if (!data) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ game: data, bestAtStart: bestAtStart, savedAt: Date.now() }));
    } catch (e) {}
  }
  function readSave() {
    try {
      var s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (!s || !s.game) return null;
      var g = DC.restore(s.game);
      if (!g) { clearSave(); return null; }        // 壊れた保存は捨てる
      return { game: g, bestAtStart: s.bestAtStart >= 0 ? s.bestAtStart : best };
    } catch (e) { return null; }
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

  function comma(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* ---------- 画面の切り替え ---------- */

  function show(id) {
    ['home', 'game'].forEach(function (s) { $(s).classList.toggle('is-active', s === id); });
    document.documentElement.classList.toggle('is-playing', id === 'game');
  }

  /* ゲーム中は画面を一切動かさない。
     ↓ を押したまま ↻ を叩くと、iPhone は 2 本指のピンチ（拡大）やスクロールと受け取ることがあり、
     画面がずれてボタンの位置が変わってしまう。CSS の touch-action: none に加えて、
     touch-action を無視する場面（Safari のピンチ）もここで止める。 */
  function lockGestures() {
    var playing = function () { return document.documentElement.classList.contains('is-playing'); };
    document.addEventListener('touchmove', function (e) {
      if (playing()) e.preventDefault();
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) {
      document.addEventListener(t, function (e) { if (playing()) e.preventDefault(); }, { passive: false });
    });
  }

  function openOverlay(id, on) { $(id).classList.toggle('is-open', !!on); }

  function goHome() {
    stopLoop();
    releaseAll();
    running = false;
    paused = false;
    openOverlay('pauseOverlay', false);
    openOverlay('overOverlay', false);
    refreshHome();
    show('home');
  }

  /* 続きがあれば「続きから」を一番上に出し、「新しくはじめる」は控えめにする */
  var confirmNewTimer = 0;
  function refreshHome() {
    $('homeBest').textContent = comma(best);
    var s = readSave();
    $('continueBtn').classList.toggle('hidden', !s);
    $('continueInfo').classList.toggle('hidden', !s);
    if (s) $('continueInfo').textContent = 'スコア ' + comma(s.game.score) + ' ・ レベル ' + s.game.info.level + ' の続き';
    $('startBtn').classList.toggle('btn-primary', !s);
    $('startBtn').classList.toggle('btn-secondary', !!s);
    resetStartLabel();
  }
  function resetStartLabel() {
    clearTimeout(confirmNewTimer);
    confirmNewTimer = 0;
    $('startBtn').textContent = $('continueBtn').classList.contains('hidden') ? 'はじめる' : '新しくはじめる';
  }

  /* 続きがあるときの「新しくはじめる」は、うっかり押しで続きが消えないよう 2 回押しにする */
  function onStartClick() {
    if (!$('continueBtn').classList.contains('hidden') && !confirmNewTimer) {
      $('startBtn').textContent = 'もう一度押すと、続きを消して始めます';
      confirmNewTimer = setTimeout(resetStartLabel, 3000);
      return;
    }
    resetStartLabel();
    startGame();
  }

  function continueGame() {
    var s = readSave();
    if (!s) { refreshHome(); return; }
    startGame(s);
  }

  function startGame(saved) {
    if (saved) {
      game = saved.game;
      bestAtStart = saved.bestAtStart;
    } else {
      clearSave();
      game = DC.create();
      DC.step(game, 0.001);       // 最初の組を出す
      bestAtStart = best;
    }
    popups = [];
    vis = null;
    lastCur = null;
    overAt = 0;
    paused = false;
    running = true;
    hudScore = hudLevel = -1;
    openOverlay('pauseOverlay', false);
    openOverlay('overOverlay', false);
    countAt = 0;
    show('game');
    resize();
    updateHud();
    startLoop();
    if (saved) startCountdown();   // 途中からはいきなり動かさず、3, 2, 1 のあとで
  }

  /** 一時停止。止めた瞬間の状態を保存する（このままアプリを閉じても続きから遊べる） */
  function pause() {
    if (!running || overAt || paused) return;
    paused = true;
    countAt = 0;
    releaseAll();
    saveGame();
    openOverlay('pauseOverlay', true);
  }

  /** 再開。すぐには動かさず、3, 2, 1 と数えてから時間を進める */
  function resume() {
    if (!running || !paused) return;
    paused = false;
    openOverlay('pauseOverlay', false);
    startCountdown();
  }

  function startCountdown() {
    releaseAll();
    countAt = performance.now();
    lastTime = 0;
    acc = 0;
  }

  /* ---------- ループ ---------- */

  function startLoop() {
    stopLoop();
    lastTime = 0;
    acc = 0;
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    var dt = lastTime ? Math.min(250, now - lastTime) : 0;   // 裏に回っていた分はまとめて進めない
    lastTime = now;

    if (countAt && now - countAt >= COUNT_FROM * COUNT_STEP_MS) {   // カウントダウンが終わった
      countAt = 0;
      acc = 0;
      dt = 0;
    }

    if (running && !paused && !countAt && game.state !== 'gameover') {
      DC.setSoft(game, !!held.down);
      acc += dt;
      while (acc >= STEP_MS) {
        DC.step(game, STEP_MS);
        acc -= STEP_MS;
      }
      handleEvents(now);
    }
    if (overAt && now - overAt >= OVER_MS && !$('overOverlay').classList.contains('is-open')) {
      showGameOver();
    }
    updateVis(dt);
    render(now);
  }

  function handleEvents(now) {
    DC.takeEvents(game).forEach(function (ev) {
      if (ev.type === 'chain' && ev.chain >= 2) {
        popups.push({ kind: 'chain', text: ev.chain + '連鎖', sub: '+' + comma(ev.gained), t: now, dur: 1100 });
      }
      if (ev.type === 'levelup') {
        popups.push({ kind: 'level', text: 'LEVEL ' + ev.level, sub: ev.colors === 5 ? '紫が加わります' : '', t: now, dur: 1400 });
      }
      if (ev.type === 'gameover') {
        overAt = now;
        releaseAll();
        clearSave();                 // 終わった局は続きから始められない
      }
    });
    updateHud();
  }

  function updateHud() {
    if (!game) return;
    if (game.score !== hudScore) {
      hudScore = game.score;
      $('scoreLabel').textContent = comma(game.score);
      // 6 桁を超えたら字を小さくして、ヘッダーが盤面の幅からはみ出さないようにする
      $('scoreLabel').classList.toggle('is-long', game.score >= 100000);
      $('bestLabel').textContent = comma(Math.max(best, game.score));
    }
    if (game.info.level !== hudLevel) {
      hudLevel = game.info.level;
      $('levelLabel').textContent = game.info.level;
    }
    setNext($('next1'), game.queue[0]);
    setNext($('next2'), game.queue[1]);
  }

  function setNext(el, pair) {
    var i = el.children;
    // 盤面と同じく、子が上・軸が下
    i[0].style.setProperty('--c', COLORS[pair[1]]);
    i[1].style.setProperty('--c', COLORS[pair[0]]);
  }

  function showGameOver() {
    running = false;
    var score = game.score;
    var isNew = score > bestAtStart && score > 0;
    if (score > best) { best = score; saveBest(); }
    $('overScore').textContent = comma(score);
    $('overNew').classList.toggle('hidden', !isNew);
    $('overDetail').textContent = '最大 ' + game.maxChain + ' 連鎖 ・ レベル ' + game.info.level +
      (isNew ? '' : '\nハイスコア ' + comma(best));
    openOverlay('overOverlay', true);
  }

  /* ---------- 入力 ----------
     受け付けるかどうかは game.js の input が状態を見て決める（落下中と設置猶予だけ）。
     ここでは押された・離されたを伝えるだけ。 */

  function act(key) {
    if (!running || paused || countAt || !game) return;    // カウントダウン中の操作は捨てる
    if (key === 'left' || key === 'right' || key === 'rotate') DC.input(game, key);
  }

  function press(key) {
    if (held[key]) return;
    held[key] = true;
    var btn = document.querySelector('.key[data-key="' + key + '"]');
    if (btn) btn.classList.add('is-down');
    if (key === 'down') return;                     // 押している間だけ、毎フレーム setSoft で伝える
    act(key);
    if (key === 'left' || key === 'right') {        // 回転はリピートしない（1 タップ 1 回転）
      repeatTimers[key] = setTimeout(function rep() {
        act(key);
        repeatTimers[key] = setTimeout(rep, REPEAT_EVERY);
      }, REPEAT_FIRST);
    }
  }

  function release(key) {
    if (!held[key]) return;
    held[key] = false;
    clearTimeout(repeatTimers[key]);
    var btn = document.querySelector('.key[data-key="' + key + '"]');
    if (btn) btn.classList.remove('is-down');
  }

  function releaseAll() { Object.keys(held).forEach(release); if (game) DC.setSoft(game, false); }

  function bindPad() {
    Array.prototype.forEach.call(document.querySelectorAll('.key'), function (btn) {
      var key = btn.getAttribute('data-key');
      // click だと遅れるので pointerdown で反応させる
      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (err) {}
        press(key);
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
        btn.addEventListener(t, function () { release(key); });
      });
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });

    var KEYMAP = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down',
      ArrowUp: 'rotate', x: 'rotate', X: 'rotate', z: 'rotate', Z: 'rotate', ' ': 'rotate'
    };
    document.addEventListener('keydown', function (e) {
      if (!$('game').classList.contains('is-active')) return;
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') { if (paused) resume(); else pause(); return; }
      var k = KEYMAP[e.key];
      if (!k) return;
      e.preventDefault();
      if (!e.repeat) press(k);      // リピートは自前で行う（ボタンと同じ間隔にする）
    });
    document.addEventListener('keyup', function (e) {
      var k = KEYMAP[e.key];
      if (k) release(k);
    });
    window.addEventListener('blur', releaseAll);
  }

  /* ---------- 描画（Canvas 1 枚） ---------- */

  function resize() {
    if (!canvas) return;
    var w = canvas.clientWidth;
    if (!w) return;
    dpr = Math.min(3, window.devicePixelRatio || 1);
    cell = w / DC.COLS;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cell * (DC.ROWS - DC.HIDDEN) * dpr);
    sprites = {};
  }

  /* 図形の記号。文字だとフォントで形が変わるので線で描く */
  function symbolPath(g, color, r) {
    g.beginPath();
    var i, a;
    if (color === 1) {                                   // ●
      g.arc(0, 0, r * 0.8, 0, Math.PI * 2);
    } else if (color === 2) {                            // ▲
      g.moveTo(0, -r); g.lineTo(r * 0.95, r * 0.7); g.lineTo(-r * 0.95, r * 0.7);
    } else if (color === 3) {                            // ■
      g.rect(-r * 0.75, -r * 0.75, r * 1.5, r * 1.5);
    } else if (color === 4) {                            // ★
      for (i = 0; i < 10; i++) {
        a = -Math.PI / 2 + i * Math.PI / 5;
        var rr = i % 2 ? r * 0.45 : r * 1.05;
        g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr);
      }
    } else if (color === 5) {                            // ◆
      g.moveTo(0, -r); g.lineTo(r * 0.85, 0); g.lineTo(0, r); g.lineTo(-r * 0.85, 0);
    }
    g.closePath();
  }

  /** 色ごとの玉の絵を作っておく。発光（shadowBlur）は毎フレームだと重いため */
  function sprite(color) {
    var key = color + (symbols ? 's' : '');
    if (sprites[key]) return sprites[key];
    var size = Math.ceil(cell * 2 * dpr);
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    var s = cell * dpr, r = s * 0.42, cx = size / 2;
    g.translate(cx, cx);

    g.shadowColor = COLORS[color];
    g.shadowBlur = s * 0.35;
    g.fillStyle = COLORS[color];
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;

    var grad = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    grad.addColorStop(0, 'rgba(255,255,255,.55)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(0,0,0,.28)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();

    if (symbols) {
      symbolPath(g, color, r * 0.48);
      g.fillStyle = 'rgba(12,16,26,.5)';
      g.fill();
    }
    sprites[key] = c;
    return c;
  }

  /** 玉を 1 つ描く。x, y はマスの左上（盤面の見える範囲が y=0） */
  function drawPuyo(x, y, color, scale, flash, alpha) {
    var sp = sprite(color);
    var w = sp.width / dpr * (scale == null ? 1 : scale);
    var cx = (x + 0.5) * cell, cy = (y + 0.5) * cell;
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.drawImage(sp, cx - w / 2, cy - w / 2, w, w);
    if (flash > 0) {
      ctx.globalAlpha = flash * (alpha == null ? 1 : alpha);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx, cy, cell * 0.44 * (scale == null ? 1 : scale), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* 操作中の組の見た目を、論理上の位置へなめらかに寄せる */
  var ANG = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
  function updateVis(dt) {
    if (!game || !game.cur) { vis = null; lastCur = null; return; }
    var cur = game.cur;
    var frac = 0;
    if (game.state === 'falling' && DC.fits(game.board, { x: cur.x, y: cur.y + 1, rot: cur.rot })) {
      var iv = game.soft ? game.info.fallMs / DC.TIMING.SOFT_DIV : game.info.fallMs;
      frac = Math.min(1, game.fallTimer / iv);
    }
    var ty = cur.y + frac;
    var ta = ANG[cur.rot];
    if (!vis || lastCur !== cur.colors) {                // 新しい組
      vis = { x: cur.x, y: ty, ang: ta };
      lastCur = cur.colors;
      return;
    }
    var k = 1 - Math.exp(-dt / 35);                       // 35ms ほどで追いつく
    vis.x += (cur.x - vis.x) * k;
    if (Math.abs(cur.x - vis.x) < 0.01) vis.x = cur.x;
    if (ty >= vis.y) vis.y = ty; else vis.y += (ty - vis.y) * k;   // 落下はそのまま、床蹴りは寄せる
    // 回転は時計回りに最短で
    var d = ta - vis.ang;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    vis.ang += d * (1 - Math.exp(-dt / 40));
    if (Math.abs(d) < 0.01) vis.ang = ta;
  }

  function render(now) {
    if (!ctx || !game) return;
    var H = DC.HIDDEN, b = game.board, x, y;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = cell * DC.COLS, Ht = cell * (DC.ROWS - H);

    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, W, Ht);

    // 格子
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (x = 1; x < DC.COLS; x++) { ctx.moveTo(Math.round(x * cell) + 0.5, 0); ctx.lineTo(Math.round(x * cell) + 0.5, Ht); }
    for (y = 1; y < DC.ROWS - H; y++) { ctx.moveTo(0, Math.round(y * cell) + 0.5); ctx.lineTo(W, Math.round(y * cell) + 0.5); }
    ctx.stroke();

    // 出現位置の × 。ここが埋まると終わり
    var mx = (DC.SPAWN_X + 0.5) * cell, my = (DC.SPAWN_Y - H + 0.5) * cell, m = cell * 0.2;
    ctx.strokeStyle = 'rgba(232,71,90,.45)';
    ctx.lineWidth = Math.max(2, cell * 0.06);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(mx - m, my - m); ctx.lineTo(mx + m, my + m);
    ctx.moveTo(mx + m, my - m); ctx.lineTo(mx - m, my + m);
    ctx.stroke();

    // 動いている最中のマスは、置かれた玉としては描かない
    var skip = {}, erasingSet = {};
    if (game.phase === 'drop') game.falls.forEach(function (f) { skip[f.to * 8 + f.x] = true; });
    if (game.phase === 'erase') game.erasing.forEach(function (g) {
      g.cells.forEach(function (p) { erasingSet[p[1] * 8 + p[0]] = true; });
    });

    var dim = overAt ? Math.min(1, (now - overAt) / OVER_MS) : 0;
    var ep = game.phase === 'erase' ? game.phaseTimer / game.phaseMs : 0;
    if (ep >= 0.45) Object.keys(erasingSet).forEach(function (k) { skip[k] = true; });   // 縮み始めたら帯を外す

    // 同じ色の隣どうしを細い帯でつなぐ（塊が見えやすいように）
    ctx.globalAlpha = 0.55 * (1 - dim * 0.7);
    for (y = H; y < DC.ROWS; y++) {
      for (x = 0; x < DC.COLS; x++) {
        var v = b[y][x];
        if (!v || skip[y * 8 + x]) continue;
        ctx.fillStyle = COLORS[v];
        if (x + 1 < DC.COLS && b[y][x + 1] === v && !skip[y * 8 + x + 1]) {
          ctx.fillRect((x + 0.5) * cell, (y - H + 0.32) * cell, cell, cell * 0.36);
        }
        if (y + 1 < DC.ROWS && b[y + 1][x] === v && !skip[(y + 1) * 8 + x]) {
          ctx.fillRect((x + 0.32) * cell, (y - H + 0.5) * cell, cell * 0.36, cell);
        }
      }
    }
    ctx.globalAlpha = 1;

    // 置かれた玉
    for (y = H; y < DC.ROWS; y++) {
      for (x = 0; x < DC.COLS; x++) {
        v = b[y][x];
        if (!v || (skip[y * 8 + x] && !erasingSet[y * 8 + x])) continue;
        if (erasingSet[y * 8 + x]) {
          // 白くフラッシュしてから縮んで消える
          if (ep < 0.45) drawPuyo(x, y - H, v, 1, Math.sin(ep / 0.45 * Math.PI / 2) * 0.85);
          else drawPuyo(x, y - H, v, 1 - (ep - 0.45) / 0.55, 0.85 * (1 - (ep - 0.45) / 0.55));
        } else {
          drawPuyo(x, y - H, v, 1, 0, 1 - dim * 0.6);
        }
      }
    }

    // ちぎり・連鎖で落ちている玉
    if (game.phase === 'drop') {
      var moved = game.phaseTimer / DC.TIMING.DROP_CELL_MS;
      game.falls.forEach(function (f) {
        var fy = Math.min(f.to, f.from + moved);
        if (fy >= H - 1) drawPuyo(f.x, fy - H, f.color, 1, 0);
      });
    }

    // 操作中の組
    if (game.cur && vis) {
      var ax = vis.x, ay = vis.y - H;
      var cxp = ax + Math.cos(vis.ang), cyp = ay + Math.sin(vis.ang);
      drawPuyo(cxp, cyp, game.cur.colors[1], 1, 0);
      drawPuyo(ax, ay, game.cur.colors[0], 1, 0);
      // 軸の目印（回転の中心）
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.45 + 0.25 * Math.sin(now / 160)) + ')';
      ctx.lineWidth = Math.max(1.5, cell * 0.05);
      ctx.beginPath();
      ctx.arc((ax + 0.5) * cell, (ay + 0.5) * cell, cell * 0.44, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 連鎖数・レベルアップ
    popups = popups.filter(function (p) { return now - p.t < p.dur; });
    popups.forEach(function (p, i) {
      var t = (now - p.t) / p.dur;
      var pop = t < 0.15 ? 0.6 + t / 0.15 * 0.5 : t < 0.25 ? 1.1 - (t - 0.15) : 1;
      var alpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      var cy = Ht * (p.kind === 'level' ? 0.62 : 0.4) - (t * cell * 0.4);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(W / 2, cy);
      ctx.scale(pop, pop);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var fs = p.kind === 'level' ? Math.max(20, cell * 0.7) : Math.max(28, cell * 1.15);
      ctx.font = '800 ' + fs + 'px -apple-system, "Hiragino Sans", sans-serif';
      ctx.shadowColor = p.kind === 'level' ? '#e8c33c' : '#3d8ce0';
      ctx.shadowBlur = cell * 0.5;
      ctx.lineWidth = Math.max(3, fs * 0.12);
      ctx.strokeStyle = 'rgba(10,14,22,.9)';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.kind === 'level' ? '#ffe27a' : '#ffffff';
      ctx.fillText(p.text, 0, 0);
      if (p.sub) {
        ctx.shadowBlur = 0;
        var fs2 = Math.max(14, fs * 0.42);
        ctx.font = '700 ' + fs2 + 'px -apple-system, "Hiragino Sans", sans-serif';
        ctx.lineWidth = 4;
        ctx.strokeText(p.sub, 0, fs * 0.72);
        ctx.fillStyle = p.kind === 'level' ? '#ffe27a' : '#cfe3ff';
        ctx.fillText(p.sub, 0, fs * 0.72);
      }
      ctx.restore();
    });

    if (dim) {
      ctx.fillStyle = 'rgba(15,20,32,' + (dim * 0.45) + ')';
      ctx.fillRect(0, 0, W, Ht);
    }

    if (countAt || paused) drawCountdown(now, W, Ht);
  }

  /* 再開前の 3, 2, 1。盤面を暗くして、数字を 1 秒ごとに大きく出す */
  function drawCountdown(now, W, Ht) {
    ctx.fillStyle = 'rgba(15,20,32,.55)';
    ctx.fillRect(0, 0, W, Ht);
    if (!countAt) return;                          // 一時停止中は暗くするだけ
    var t = Math.max(0, now - countAt);
    var n = COUNT_FROM - Math.floor(t / COUNT_STEP_MS);
    if (n < 1) return;
    var f = (t % COUNT_STEP_MS) / COUNT_STEP_MS;   // 1 つの数字の中での進み 0→1
    var scale = f < 0.15 ? 1.5 - f / 0.15 * 0.5 : 1;
    var alpha = f > 0.75 ? 1 - (f - 0.75) / 0.25 : 1;
    var fs = Math.max(56, cell * 2.6);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(W / 2, Ht * 0.42);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 ' + fs + 'px -apple-system, "Hiragino Sans", sans-serif';
    ctx.shadowColor = '#3d8ce0';
    ctx.shadowBlur = cell * 0.8;
    ctx.lineWidth = Math.max(4, fs * 0.08);
    ctx.strokeStyle = 'rgba(10,14,22,.9)';
    ctx.strokeText(String(n), 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(n), 0, 0);
    ctx.restore();
  }

  /* ---------- はじめに ---------- */

  function init() {
    load();
    canvas = $('board');
    ctx = canvas.getContext('2d');

    refreshHome();
    $('symbolsToggle').checked = symbols;
    $('symbolsToggle').addEventListener('change', function () {
      symbols = this.checked;
      saveSymbols();
      sprites = {};
    });
    $('version').textContent = 'version ' + APP_VERSION.slice(1);

    $('startBtn').addEventListener('click', onStartClick);
    $('continueBtn').addEventListener('click', continueGame);
    $('againBtn').addEventListener('click', function () { startGame(); });
    $('homeBtn').addEventListener('click', goHome);
    $('pauseBtn').addEventListener('click', pause);
    $('resumeBtn').addEventListener('click', resume);
    $('quitBtn').addEventListener('click', function () {
      saveGame();                    // 一時停止のときに保存済みだが、念のため
      goHome();                      // ホームの「続きから」で再開できる
    });
    bindPad();
    lockGestures();

    window.addEventListener('resize', resize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
    // アプリを裏に回したら止める（電話が来たときなど）
    // 止めた状態は保存されるので、そのままアプリを閉じても続きから遊べる
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && running) pause();
    });
    window.addEventListener('pagehide', function () { if (running) saveGame(); });

    window.dropchain = { game: function () { return game; }, debug: DC.debug };   // コンソールから触る用
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js?' + APP_VERSION).catch(function () {});
    });
  }
})();
