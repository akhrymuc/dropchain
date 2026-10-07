/* dropchain — ルールだけ。画面（DOM）には一切触らない。
   ここを node から呼んで game-test.js で検証している。

   盤面は board[行][列]。行 0 が出現用の隠し行、1〜12 が見える 12 行（下がいちばん大きい）。
   マスの値は 0 = 空き、1〜5 = 色（赤 緑 青 黄 紫）。 */
var DC = (function () {
  'use strict';

  var COLS = 6;
  var ROWS = 13;           // 隠し行 1 + 表示 12
  var HIDDEN = 1;          // 行 0 は消去判定の対象外
  var SPAWN_X = 2;         // 3列目（0始まりで列2）
  var SPAWN_Y = 1;         // 見える最上段。ここが埋まっていたら次の組を出せない

  var COLOR_CHARS = '.RGBYP';            // 文字列で盤面を書くときの記号
  var COLOR_NAMES = ['', '赤', '緑', '青', '黄', '紫'];

  /* ---------- 調整する数値はこの表にまとめる ---------- */

  /* レベル。進行はスコアではなく累計消去数で決める
     （スコアだと 1 回の大連鎖で数レベル飛んでしまうため）。
     色が 4 → 5 に増えるのはレベル 4 の 1 か所だけ。 */
  var LEVELS = [
    { level: 1, need: 0,   colors: 4, fallMs: 500 },
    { level: 2, need: 16,  colors: 4, fallMs: 420 },
    { level: 3, need: 36,  colors: 4, fallMs: 350 },
    { level: 4, need: 60,  colors: 5, fallMs: 290 },
    { level: 5, need: 90,  colors: 5, fallMs: 240 },
    { level: 6, need: 130, colors: 5, fallMs: 200 },
    { level: 7, need: 180, colors: 5, fallMs: 165 }
  ];
  /* 序盤が易しすぎたので 2 回詰めた。落下間隔はそのまま、レベルが上がるまでの消去数をさらに約半分に
     （初版: 800/650/520/420/340/270/200ms、60/150/280/450/700/1000 個、以降 +400 ごと ×0.8
       2版:  500/420/350/290/240/200/165ms、30/70/120/180/260/360 個、以降 +150 ごと ×0.85） */
  var LEVEL_STEP_NEED = 80;     // レベル 8 以降は前段 +80 ごと
  var LEVEL_STEP_RATE = 0.85;   // 落下間隔は前段 × 0.85
  var FALL_MS_MIN = 80;

  var TIMING = {
    LOCK_MS: 500,        // 設置猶予
    LOCK_RESETS: 3,      // 猶予中に動かして猶予を戻せる回数
    SOFT_DIV: 8,         // 下ボタンで落下間隔を 1/8 に
    DROP_CELL_MS: 45,    // ちぎり・連鎖で 1 マス落ちるのにかける時間（見た目用）
    ERASE_MS: 200,       // 消えるときのフラッシュ＋縮小
    CHAIN_GAP_MS: 80     // 消えたあと次の落下までの間
  };

  /* スコア式: 消去数 × 10 × (連鎖ボーナス + 連結ボーナス + 色数ボーナス)
     ここがゲームの中心なので、数値はあとから触らない。 */
  var CHAIN_BONUS = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224];   // 1〜10 連鎖。以降 +32
  var LINK_BONUS = [0, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7];             // 添字 = 連結した個数。11 以上は 10
  var COLOR_BONUS = [0, 0, 3, 6, 12, 24];                          // 添字 = 同時に消えた色数

  /* 子ぷよの位置。回転 0=上 1=右 2=下 3=左（時計回り） */
  var DX = [0, 1, 0, -1];
  var DY = [-1, 0, 1, 0];

  /* ---------- レベル ---------- */

  function levelInfo(erasedTotal) {
    var i, cur = LEVELS[0];
    for (i = 0; i < LEVELS.length; i++) if (erasedTotal >= LEVELS[i].need) cur = LEVELS[i];
    if (cur !== LEVELS[LEVELS.length - 1]) return cur;

    var last = LEVELS[LEVELS.length - 1];
    var extra = Math.floor((erasedTotal - last.need) / LEVEL_STEP_NEED);
    if (extra <= 0) return last;
    return {
      level: last.level + extra,
      need: last.need + extra * LEVEL_STEP_NEED,
      colors: last.colors,
      fallMs: Math.max(FALL_MS_MIN, Math.round(last.fallMs * Math.pow(LEVEL_STEP_RATE, extra)))
    };
  }

  /* ---------- スコア ---------- */

  function chainBonus(chain) {
    if (chain <= CHAIN_BONUS.length) return CHAIN_BONUS[chain - 1];
    return CHAIN_BONUS[CHAIN_BONUS.length - 1] + 32 * (chain - CHAIN_BONUS.length);
  }

  function linkBonus(n) {
    if (n >= 11) return 10;
    return LINK_BONUS[n] || 0;
  }

  function colorBonus(n) {
    return COLOR_BONUS[Math.min(n, COLOR_BONUS.length - 1)] || 0;
  }

  /** 1 回の消去（＝ある連鎖段）の得点。groups は findGroups の結果 */
  function calcScore(chain, groups) {
    var erased = 0, colors = {}, nColors = 0, link = 0;
    groups.forEach(function (g) {
      erased += g.cells.length;
      link += linkBonus(g.cells.length);            // 連結ボーナスは塊ごとに足す
      if (!colors[g.color]) { colors[g.color] = 1; nColors++; }
    });
    var bonus = chainBonus(chain) + link + colorBonus(nColors);
    if (bonus < 1) bonus = 1;                         // 括弧内が 0 なら 1
    return { score: erased * 10 * bonus, erased: erased, bonus: bonus, colors: nColors };
  }

  /* ---------- 盤面 ---------- */

  function emptyBoard() {
    var b = [], r;
    for (r = 0; r < ROWS; r++) b.push([0, 0, 0, 0, 0, 0]);
    return b;
  }

  function copyBoard(b) { return b.map(function (row) { return row.slice(); }); }

  function inside(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }

  function isFree(b, x, y) { return inside(x, y) && b[y][x] === 0; }

  /** 浮いているぷよを落とす。動いたぷよの一覧を返す（描画の補間用） */
  function applyGravity(b) {
    var falls = [], x, y, to;
    for (x = 0; x < COLS; x++) {
      to = ROWS - 1;
      for (y = ROWS - 1; y >= 0; y--) {
        if (b[y][x] === 0) continue;
        if (y !== to) {
          falls.push({ x: x, from: y, to: to, color: b[y][x] });
          b[to][x] = b[y][x];
          b[y][x] = 0;
        }
        to--;
      }
    }
    return falls;
  }

  /** 上下左右でつながった同色 4 つ以上の塊（BFS）。隠し行は数えない */
  function findGroups(b) {
    var seen = [], groups = [], x, y, r;
    for (r = 0; r < ROWS; r++) seen.push([false, false, false, false, false, false]);

    for (y = HIDDEN; y < ROWS; y++) {
      for (x = 0; x < COLS; x++) {
        if (seen[y][x] || b[y][x] === 0) continue;
        var color = b[y][x], cells = [], queue = [[x, y]], k;
        seen[y][x] = true;
        while (queue.length) {
          var p = queue.shift();
          cells.push(p);
          for (k = 0; k < 4; k++) {
            var nx = p[0] + DX[k], ny = p[1] + DY[k];
            if (nx < 0 || nx >= COLS || ny < HIDDEN || ny >= ROWS) continue;
            if (seen[ny][nx] || b[ny][nx] !== color) continue;
            seen[ny][nx] = true;
            queue.push([nx, ny]);
          }
        }
        if (cells.length >= 4) groups.push({ color: color, cells: cells });
      }
    }
    return groups;
  }

  function erase(b, groups) {
    groups.forEach(function (g) {
      g.cells.forEach(function (p) { b[p[1]][p[0]] = 0; });
    });
  }

  /** 連鎖を最後まで解く。再帰ではなく単純なループ */
  function resolveChain(b) {
    var chain = 0, score = 0, erased = 0, steps = [];
    while (true) {
      applyGravity(b);
      var groups = findGroups(b);
      if (groups.length === 0) break;
      chain++;
      var s = calcScore(chain, groups);
      score += s.score;
      erased += s.erased;
      steps.push({ chain: chain, score: s.score, erased: s.erased, bonus: s.bonus, colors: s.colors });
      erase(b, groups);
    }
    return { chain: chain, score: score, erased: erased, steps: steps };
  }

  /* ---------- 文字列との行き来（デバッグ・テスト用） ---------- */

  /**
   * 盤面を文字列から作る。1 行 6 文字、上から下へ。
   *   . 空き  R 赤  G 緑  B 青  Y 黄  P 紫
   * 12 行なら見える盤面だけとみなし、隠し行は空にする。13 行なら先頭が隠し行。
   * 12 行より少なければ、足りないぶん上を空で埋める（下に揃える）。
   * 空白・| は読み飛ばすので、見やすく区切って書いてよい。
   */
  function parseBoard(str) {
    var lines = String(str).split('\n')
      .map(function (s) { return s.replace(/[\s|]/g, ''); })
      .filter(function (s) { return s.length > 0; });
    if (lines.length > ROWS) throw new Error('行が多すぎる: ' + lines.length);
    var b = emptyBoard(), offset = ROWS - lines.length;
    lines.forEach(function (line, i) {
      if (line.length !== COLS) throw new Error((i + 1) + '行目が' + COLS + '文字ではない: ' + line);
      for (var x = 0; x < COLS; x++) {
        var v = COLOR_CHARS.indexOf(line[x].toUpperCase());
        if (v < 0) throw new Error('読めない文字: ' + line[x]);
        b[offset + i][x] = v;
      }
    });
    return b;
  }

  /** 盤面を文字列に。hidden を真にすると隠し行も出す */
  function boardToString(b, hidden) {
    var out = [], y;
    for (y = hidden ? 0 : HIDDEN; y < ROWS; y++) {
      out.push(b[y].map(function (v) { return COLOR_CHARS[v]; }).join(''));
    }
    return out.join('\n');
  }

  /**
   * デバッグ関数。盤面の文字列を読み込み、連鎖を最後まで解いて連鎖数とスコアを返す。
   *   DC.debug(`
   *     ......
   *     R.....
   *     RRR...`)  → { chain: 1, score: 40, ... }
   * ブラウザのコンソールからも呼べる。
   */
  function debug(str) {
    var b = parseBoard(str);
    var r = resolveChain(b);
    r.board = boardToString(b);
    return r;
  }

  /* ---------- 組（2 個 1 組） ---------- */

  function randomPair(nColors, rng) {
    return [1 + Math.floor(rng() * nColors), 1 + Math.floor(rng() * nColors)];   // [軸, 子]
  }

  function childPos(p) { return { x: p.x + DX[p.rot], y: p.y + DY[p.rot] }; }

  function fits(b, p) {
    var c = childPos(p);
    return isFree(b, p.x, p.y) && isFree(b, c.x, c.y);
  }

  /** 真下が埋まっているか床に着いているか（軸と子のどちらか） */
  function grounded(b, p) {
    return !fits(b, { x: p.x, y: p.y + 1, rot: p.rot, colors: p.colors });
  }

  function tryShift(b, p, dx) {
    var q = { x: p.x + dx, y: p.y, rot: p.rot, colors: p.colors };
    return fits(b, q) ? q : null;
  }

  /**
   * 時計回りに 90 度。子の行き先が壁かぷよで塞がっていれば、
   * 軸を 1 マス反対側へ押し込む（壁蹴り。下向きなら床蹴りで 1 マス上へ）。
   * 押し込む先も塞がっていれば回転しない。クイックターンはしない。
   */
  function tryRotate(b, p) {
    var rot = (p.rot + 1) % 4;
    var q = { x: p.x, y: p.y, rot: rot, colors: p.colors };
    if (fits(b, q)) return q;
    var k = { x: p.x - DX[rot], y: p.y - DY[rot], rot: rot, colors: p.colors };
    if (fits(b, k)) return k;
    return null;
  }

  /** 組を盤面に固定する。最初に 2 個の独立したぷよへ分解する（ちぎり） */
  function placePair(b, p) {
    var c = childPos(p);
    if (inside(p.x, p.y)) b[p.y][p.x] = p.colors[0];
    if (inside(c.x, c.y)) b[c.y][c.x] = p.colors[1];
  }

  /* ---------- ゲームの進行（状態機械） ----------
     状態は 5 つだけ:
       spawn     出現。出現位置が埋まっていれば gameover へ
       falling   落下中        ← 入力を受け付ける
       locking   設置猶予      ← 入力を受け付ける
       resolving 連鎖解決（ちぎりの落下・消去・連鎖の落下）
       gameover
     時間は step(g, ms) で進める。画面側は固定タイムステップで呼ぶ。 */

  function create(opts) {
    opts = opts || {};
    var rng = opts.rng || Math.random;
    var g = {
      board: opts.board ? copyBoard(opts.board) : emptyBoard(),
      rng: rng,
      state: 'spawn',
      cur: null,
      queue: [],
      score: 0,
      erasedTotal: opts.erasedTotal || 0,
      info: null,
      chain: 0,
      maxChain: 0,
      soft: false,
      fallTimer: 0,
      lockTimer: 0,
      lockResets: 0,
      phase: null,        // resolving の中の段階: drop / erase / gap
      phaseTimer: 0,
      phaseMs: 0,
      falls: [],          // いま落ちている最中のぷよ（描画の補間用）
      erasing: [],        // いま消えている最中の塊
      events: []          // 画面側へ知らせること（連鎖・レベルアップ・終了）
    };
    g.info = levelInfo(g.erasedTotal);
    while (g.queue.length < 2) g.queue.push(randomPair(g.info.colors, rng));
    return g;
  }

  function emit(g, ev) { g.events.push(ev); }

  function takeEvents(g) { var e = g.events; g.events = []; return e; }

  function fallInterval(g) {
    return g.soft ? g.info.fallMs / TIMING.SOFT_DIV : g.info.fallMs;
  }

  function spawn(g) {
    if (g.board[SPAWN_Y][SPAWN_X] !== 0) {        // 盤面全体ではなく、この 1 マスだけで判定
      g.state = 'gameover';
      g.cur = null;
      emit(g, { type: 'gameover', score: g.score });
      return;
    }
    var colors = g.queue.shift();
    g.queue.push(randomPair(g.info.colors, g.rng));   // 色が増えたら、次に作る組から混ぜる
    g.cur = { x: SPAWN_X, y: SPAWN_Y, rot: 0, colors: colors };
    g.state = 'falling';
    g.fallTimer = 0;
    g.lockTimer = 0;
    g.lockResets = 0;
    g.chain = 0;
    if (grounded(g.board, g.cur)) g.state = 'locking';
  }

  function lockPiece(g) {
    placePair(g.board, g.cur);      // ちぎり: ここで 2 個に分かれる
    g.cur = null;
    g.state = 'resolving';
    g.chain = 0;
    emit(g, { type: 'lock' });
    startDrop(g);
  }

  function startDrop(g) {
    g.falls = applyGravity(g.board);
    var far = g.falls.reduce(function (m, f) { return Math.max(m, f.to - f.from); }, 0);
    g.phase = 'drop';
    g.phaseTimer = 0;
    g.phaseMs = far * TIMING.DROP_CELL_MS;
  }

  function afterDrop(g) {
    g.falls = [];
    var groups = findGroups(g.board);
    if (groups.length === 0) {                     // 消去なしで連鎖終了 → 次の組
      g.phase = null;
      g.erasing = [];
      g.state = 'spawn';
      spawn(g);
      return;
    }
    g.chain++;
    if (g.chain > g.maxChain) g.maxChain = g.chain;
    var s = calcScore(g.chain, groups);
    g.score += s.score;
    g.erasedTotal += s.erased;
    g.erasing = groups;
    g.phase = 'erase';
    g.phaseTimer = 0;
    g.phaseMs = TIMING.ERASE_MS;
    emit(g, { type: 'chain', chain: g.chain, gained: s.score, erased: s.erased, bonus: s.bonus });

    var info = levelInfo(g.erasedTotal);
    if (info.level > g.info.level) {
      g.info = info;
      emit(g, { type: 'levelup', level: info.level, colors: info.colors });
    }
  }

  function afterErase(g) {
    erase(g.board, g.erasing);
    g.erasing = [];
    g.phase = 'gap';
    g.phaseTimer = 0;
    g.phaseMs = TIMING.CHAIN_GAP_MS;
  }

  /** 時間を ms だけ進める */
  function step(g, ms) {
    var guard = 0;
    while (ms > 0 && guard++ < 1000) {
      if (g.state === 'spawn') { spawn(g); continue; }
      if (g.state === 'gameover') return;

      if (g.state === 'falling') {
        var iv = fallInterval(g);
        var use = Math.min(ms, iv - g.fallTimer);
        g.fallTimer += use;
        ms -= use;
        if (g.fallTimer >= iv) {
          g.fallTimer = 0;
          var down = { x: g.cur.x, y: g.cur.y + 1, rot: g.cur.rot, colors: g.cur.colors };
          if (fits(g.board, down)) g.cur = down;
          if (grounded(g.board, g.cur)) { g.state = 'locking'; g.lockTimer = 0; }
        }
        continue;
      }

      if (g.state === 'locking') {
        if (!grounded(g.board, g.cur)) { g.state = 'falling'; g.fallTimer = 0; continue; }
        var rate = g.soft ? TIMING.SOFT_DIV : 1;    // 下を押していれば猶予も早く切れる
        var need = (TIMING.LOCK_MS - g.lockTimer) / rate;
        if (ms < need) { g.lockTimer += ms * rate; ms = 0; continue; }
        ms -= need;
        lockPiece(g);
        continue;
      }

      if (g.state === 'resolving') {
        var left = g.phaseMs - g.phaseTimer;
        if (ms < left) { g.phaseTimer += ms; ms = 0; continue; }
        ms -= left;
        g.phaseTimer = g.phaseMs;
        if (g.phase === 'drop') afterDrop(g);
        else if (g.phase === 'erase') afterErase(g);
        else if (g.phase === 'gap') startDrop(g);
        continue;
      }
    }
  }

  /**
   * 入力。受け付けるのは falling と locking の 2 状態だけで、それ以外は捨てる。
   * action: 'left' | 'right' | 'rotate'。動けたら true。
   */
  function input(g, action) {
    if (g.state !== 'falling' && g.state !== 'locking') return false;
    var q = null;
    if (action === 'left') q = tryShift(g.board, g.cur, -1);
    else if (action === 'right') q = tryShift(g.board, g.cur, 1);
    else if (action === 'rotate') q = tryRotate(g.board, g.cur);
    if (!q) return false;
    var kickedUp = q.y < g.cur.y;
    g.cur = q;
    if (g.state === 'locking') {
      if (g.lockResets < TIMING.LOCK_RESETS) {    // 上限がないと永久に固定されない
        g.lockResets++;
        g.lockTimer = 0;
      }
      if (!grounded(g.board, g.cur)) { g.state = 'falling'; g.fallTimer = 0; }
    } else if (grounded(g.board, g.cur)) {
      g.state = 'locking';
      g.lockTimer = 0;
    }
    if (kickedUp) g.fallTimer = 0;
    return true;
  }

  /** 下ボタン。押している間だけ落下を加速する */
  function setSoft(g, on) {
    if (on && g.state !== 'falling' && g.state !== 'locking') return;
    if (g.soft !== !!on && g.state === 'falling') {
      // 間隔が変わる瞬間に、いまの進み具合を割合のまま引き継ぐ
      var ratio = g.fallTimer / fallInterval(g);
      g.soft = !!on;
      g.fallTimer = ratio * fallInterval(g);
      return;
    }
    g.soft = !!on;
  }

  /** 次の組を出そうとしたらゲームオーバーになるか（テスト用） */
  function blocked(b) { return b[SPAWN_Y][SPAWN_X] !== 0; }

  /* ---------- 途中保存 ----------
     一時停止したときの状態を、そのまま JSON にできる形で取り出す・戻す。
     連鎖の途中（resolving）で止めても、続きの連鎖と得点がそのまま進むように、
     タイマーや落下中・消去中の玉も含めて全部持つ。乱数は持たない（次の組は queue にある）。 */
  var SAVE_FORMAT = 1;
  var SAVE_FIELDS = ['state', 'cur', 'queue', 'score', 'erasedTotal', 'chain', 'maxChain',
    'fallTimer', 'lockTimer', 'lockResets', 'phase', 'phaseTimer', 'phaseMs', 'falls', 'erasing'];

  function serialize(g) {
    if (!g || g.state === 'gameover') return null;
    var out = { format: SAVE_FORMAT, board: copyBoard(g.board) };
    SAVE_FIELDS.forEach(function (k) { out[k] = g[k]; });
    return JSON.parse(JSON.stringify(out));      // 盤面と切り離した写しにする
  }

  /** serialize の結果からゲームを戻す。壊れていれば null（そのときは新しく始める） */
  function restore(data, rng) {
    try {
      if (!data || data.format !== SAVE_FORMAT) return null;
      var b = data.board;
      if (!Array.isArray(b) || b.length !== ROWS) return null;
      for (var y = 0; y < ROWS; y++) {
        if (!Array.isArray(b[y]) || b[y].length !== COLS) return null;
        for (var x = 0; x < COLS; x++) {
          if (!(b[y][x] >= 0 && b[y][x] <= 5 && b[y][x] % 1 === 0)) return null;
        }
      }
      var okPair = function (p) { return Array.isArray(p) && p.length === 2 && p[0] >= 1 && p[0] <= 5 && p[1] >= 1 && p[1] <= 5; };
      if (!Array.isArray(data.queue) || data.queue.length !== 2 || !data.queue.every(okPair)) return null;
      if (['spawn', 'falling', 'locking', 'resolving'].indexOf(data.state) < 0) return null;
      if (!(data.score >= 0) || !(data.erasedTotal >= 0)) return null;

      var g = create({ board: b, rng: rng, erasedTotal: data.erasedTotal });
      SAVE_FIELDS.forEach(function (k) { if (data[k] !== undefined) g[k] = JSON.parse(JSON.stringify(data[k])); });
      g.soft = false;
      g.events = [];
      g.falls = g.falls || [];
      g.erasing = g.erasing || [];

      if (g.state === 'falling' || g.state === 'locking') {
        if (!g.cur || !okPair(g.cur.colors) || !(g.cur.rot >= 0 && g.cur.rot <= 3) || !fits(g.board, g.cur)) return null;
      } else {
        g.cur = null;
      }
      if (g.state === 'resolving' && ['drop', 'erase', 'gap'].indexOf(g.phase) < 0) return null;
      return g;
    } catch (e) {
      return null;
    }
  }

  return {
    COLS: COLS, ROWS: ROWS, HIDDEN: HIDDEN, SPAWN_X: SPAWN_X, SPAWN_Y: SPAWN_Y,
    LEVELS: LEVELS, TIMING: TIMING, COLOR_CHARS: COLOR_CHARS, COLOR_NAMES: COLOR_NAMES,
    levelInfo: levelInfo, chainBonus: chainBonus, linkBonus: linkBonus, colorBonus: colorBonus,
    calcScore: calcScore,
    emptyBoard: emptyBoard, copyBoard: copyBoard, applyGravity: applyGravity,
    findGroups: findGroups, erase: erase, resolveChain: resolveChain,
    parseBoard: parseBoard, boardToString: boardToString, debug: debug,
    childPos: childPos, fits: fits, grounded: grounded,
    tryShift: tryShift, tryRotate: tryRotate, placePair: placePair, blocked: blocked,
    create: create, step: step, input: input, setSoft: setSoft, takeEvents: takeEvents,
    serialize: serialize, restore: restore
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DC;
