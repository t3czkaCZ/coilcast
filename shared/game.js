/*
 * Coilcast – shared game logic (server + browser).
 * Běží stejně na serveru (Node, multiplayer) i v prohlížeči (offline hra proti botům).
 * Svět je autoritativní: klient posílá jen směr, boost a použití kouzla,
 * zpátky dostává "snapshot" toho, co vidí.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoilGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    ARENA: 2600, SP: 6, CELL: 80, FOOD_N: 700, BOX_N: 26,
    SNAKES_TARGET: 15,      // boti doplňují arénu do tohoto počtu hadů
    MIN_BOTS: 4,
    ENERGY_MAX: 100, ENERGY_DRAIN: 34, ENERGY_REGEN: 17, ENERGY_DELAY: 0.5, ENERGY_MIN_START: 12,
    SPEED: 150, SPEED_BOOST: 280, SPEED_TURBO: 340
  };
  // Pohyb je sdílený se serverem i s předpovědí na klientu, aby obě strany počítaly stejně
  const turnRate = (mass, human) => (4.3 - Math.min(mass / 280, 1.9)) * (human ? 1 : .8);
  const speedOf = (turbo, boosting, slow) => (turbo ? C.SPEED_TURBO : boosting ? C.SPEED_BOOST : C.SPEED) * (slow ? .5 : 1);
  const IK = ['turbo', 'shield', 'rocket', 'mine', 'magnet', 'bolt'];
  const ITEM_COL = { turbo: '#ffb020', shield: '#4fd8ff', rocket: '#ff4f7b', mine: '#c07bff', magnet: '#5cff9d', bolt: '#fff35c' };
  const PAL = ['#ff5d8f', '#46d9ff', '#ffd23f', '#7cff6b', '#b98cff', '#ff8a3d', '#3dffd0', '#ff6bd6', '#9cc3ff', '#f4ff5c'];
  const SKINS = ['klasik', 'zebra', 'duha', 'lava', 'neon', 'galaxie', 'zlato', 'duch'];
  const NAMES = ['Viper', 'Mamba', 'Cobra', 'Python', 'Taipan', 'Boa', 'Noodle', 'Zigzag', 'Wiggles', 'Spaghetti',
    'Shoelace', 'Coily', 'Sssam', 'Squiggle', 'Hissy', 'Ribbon', 'Pretzel', 'Doodle'];

  const R = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const pick = a => a[(Math.random() * a.length) | 0];
  const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  const hyp = Math.hypot;

  function createWorld() {
    const W = {
      time: 0, snakes: [], foods: [], boxes: [], missiles: [], mines: [], players: new Map(),
      log: [], seq: 0, respawns: [], nextId: 1
    };
    const grid = new Map();
    const key = (cx, cy) => (cx + 200) * 1000 + (cy + 200);

    function randIn(m) { const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * (C.ARENA - m); return [Math.cos(a) * d, Math.sin(a) * d]; }
    function emit(ev, only) { W.log.push({ s: ++W.seq, t: W.time, ev, only }); }
    function addFood(x, y, v, ci) { W.foods.push({ x, y, v, c: ci == null ? (Math.random() * PAL.length) | 0 : ci }); }
    function addBox(x, y) { W.boxes.push({ x, y, a: Math.random() * 6.28 }); }

    function makeSnake(name, ci, skin, pid) {
      const [x, y] = randIn(500), ang = Math.random() * 6.283;
      const s = {
        id: W.nextId++, pid: pid || 0, name, ci, skin: SKINS.includes(skin) ? skin : 'klasik',
        angle: ang, want: ang, mass: pid ? 28 : R(15, 40), segs: [],
        boost: false, boosting: false, en: C.ENERGY_MAX, enIdle: 0,
        item: null, roll: 0, itemAge: 0,
        fx: { turbo: 0, shield: 0, magnet: 0, slow: 0, spawn: 2.5 },
        alive: true, kills: 0, sk: pid ? 1 : R(.2, .6), ai: { t: 0, tx: x, ty: y, danger: false }
      };
      for (let i = 0; i < s.mass; i++) s.segs.push({ x: x - Math.cos(ang) * i * C.SP, y: y - Math.sin(ang) * i * C.SP });
      W.snakes.push(s);
      return s;
    }
    const radius = s => 7 + Math.min(s.mass / 32, 14);

    function spawnBot() {
      const used = new Set(W.snakes.map(s => s.name));
      const nm = NAMES.find(n => !used.has(n)) || pick(NAMES);
      makeSnake(nm, (Math.random() * PAL.length) | 0, Math.random() < .35 ? pick(SKINS) : 'klasik', 0);
    }
    function sortedAlive() { return W.snakes.filter(s => s.alive).sort((a, b) => b.mass - a.mass); }
    function rankOf(s) { const al = sortedAlive(); return { i: al.indexOf(s), n: al.length }; }

    function pickItem(s) {
      const { i, n } = rankOf(s); const f = n > 1 ? i / (n - 1) : 0; // 0 = vede, 1 = poslední (jako Mario Kart)
      const w = { turbo: 2 + 1.5 * f, shield: 3 - 2 * f, rocket: 1 + 2.5 * f, mine: 3 - 1.8 * f, magnet: 2 - .8 * f, bolt: .3 + 1.6 * f };
      let sum = 0; for (const k in w) sum += w[k]; let r = Math.random() * sum;
      for (const k in w) { r -= w[k]; if (r <= 0) return k; } return 'turbo';
    }

    function dropBody(s, from, eff) {
      const segs = s.segs, cnt = Math.max(1, Math.floor((segs.length - from) / 2)), val = (segs.length - from) * eff / cnt;
      for (let i = from; i < segs.length; i += 2) { const g = segs[i]; addFood(g.x + R(-6, 6), g.y + R(-6, 6), Math.min(val, 3.5), s.ci); }
    }
    function kill(s, by, how) {
      if (!s.alive) return; s.alive = false;
      dropBody(s, 0, .75);
      const nb = clamp(Math.floor(s.mass / 45), 0, 4) + (Math.random() < .5 ? 1 : 0); // místo části jídla vypadnou kouzla
      for (let k = 0; k < nb; k++) { const g = pick(s.segs); addBox(g.x + R(-20, 20), g.y + R(-20, 20)); }
      emit({ k: 'ex', x: s.segs[0].x, y: s.segs[0].y, c: PAL[s.ci], n: 30, v: 260 });
      if (by && by !== s) { by.kills++; emit({ k: 'fe', f: 'k', a: by.name, b: s.name, h: how || '' }); }
      else emit({ k: 'fe', f: 'c', b: s.name, h: how || '' });
      if (s.pid) {
        const p = W.players.get(s.pid);
        if (p) {
          p.snake = null; p.camX = s.segs[0].x; p.camY = s.segs[0].y;
          p.dead = { why: by && by !== s ? 'k' : 'e', by: by && by !== s ? by.name : '', how: how || '', max: p.max, kills: s.kills, best: p.best };
        }
      }
    }
    function shrink(s, frac) {
      const loss = s.mass * frac, keep = Math.max(8, Math.floor(s.mass - loss));
      if (keep < s.segs.length) dropBody(s, keep, .6);
      s.mass = Math.max(8, s.mass - loss); s.segs.length = Math.min(s.segs.length, Math.floor(s.mass));
    }
    function toast(s, o) { if (s.pid) emit(Object.assign({ k: 'to' }, o), s.pid); } // { it, used } nebo { m }

    function buildGrid() {
      grid.clear();
      for (const s of W.snakes) {
        if (!s.alive) continue;
        for (let i = 0; i < s.segs.length; i += 2) {
          const g = s.segs[i], k = key(Math.floor(g.x / C.CELL), Math.floor(g.y / C.CELL));
          let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(s, i);
        }
      }
    }
    function query(x, y, rad, fn) {
      const x0 = Math.floor((x - rad) / C.CELL), x1 = Math.floor((x + rad) / C.CELL), y0 = Math.floor((y - rad) / C.CELL), y1 = Math.floor((y + rad) / C.CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const a = grid.get(key(cx, cy)); if (!a) continue;
        for (let j = 0; j < a.length; j += 2) {
          const o = a[j], i = a[j + 1];
          if (!o.alive || i >= o.segs.length) continue; // mřížka může být o krok starší
          if (fn(o, i) === true) return;
        }
      }
    }

    function useItem(s) {
      if (!s || !s.alive || !s.item) return;
      const it = s.item, h = s.segs[0]; s.item = null;
      if (it === 'turbo') s.fx.turbo = 3;
      else if (it === 'shield') s.fx.shield = 5;
      else if (it === 'magnet') s.fx.magnet = 7;
      else if (it === 'rocket') {
        let tgt = null, best = 1e9;
        for (const o of W.snakes) {
          if (o === s || !o.alive) continue;
          const dx = o.segs[0].x - h.x, dy = o.segs[0].y - h.y, d = hyp(dx, dy); if (d > 1500) continue;
          const sc = d * (1 + 1.5 * Math.abs(angDiff(Math.atan2(dy, dx), s.angle))); if (sc < best) { best = sc; tgt = o; }
        }
        const r = radius(s);
        W.missiles.push({ x: h.x + Math.cos(s.angle) * r * 1.6, y: h.y + Math.sin(s.angle) * r * 1.6, a: s.angle, owner: s, tgt, t: s.pid ? 4.5 : 3 });
      } else if (it === 'mine') {
        const t = s.segs[s.segs.length - 1]; W.mines.push({ x: t.x, y: t.y, owner: s, t: 0, life: 35 });
      } else if (it === 'bolt') {
        let hit = 0;
        for (const o of W.snakes) {
          if (o === s || !o.alive) continue;
          const d = hyp(o.segs[0].x - h.x, o.segs[0].y - h.y); if (d > 750) continue;
          emit({ k: 'bo', x1: h.x, y1: h.y, x2: o.segs[0].x, y2: o.segs[0].y });
          if (o.fx.shield > 0 || o.fx.spawn > 0) continue;
          o.fx.slow = 3; shrink(o, .15); hit++;
        }
        emit({ k: 'ri', x: h.x, y: h.y });
        if (!hit) toast(s, { m: 'noTarget' });
      }
      toast(s, { it, used: 1 });
    }

    /* ---------- boti ---------- */
    function danger(s, a) {
      const h = s.segs[0], r = radius(s); let sc = 0;
      for (const dd of [r + 14, r + 40 + 30 * s.sk]) { // slabší boti vidí méně dopředu
        const x = h.x + Math.cos(a) * dd, y = h.y + Math.sin(a) * dd;
        if (hyp(x, y) > C.ARENA - 40) sc += 300 / dd;
        query(x, y, r + 12, (o, i) => { if (o !== s && o.fx.spawn <= 0) { const g = o.segs[i]; if (hyp(g.x - x, g.y - y) < r + radius(o) + 6) sc += 100 / dd; } });
        for (const m of W.mines) if (m.owner !== s && hyp(m.x - x, m.y - y) < 30) sc += 80 / dd;
      }
      return sc;
    }
    /*
     * Boti jsou schválně slabší než člověk:
     *  - každý má "šikovnost" sk 0.2–0.6 (reakční doba, jak daleko vidí, jak často si nebezpečí všimne)
     *  - rozhodují se jen ~3–5× za sekundu
     *  - kouzla používají opatrně a jejich rakety hůř zatáčí
     */
    function botThink(s, dt) {
      const ai = s.ai, h = s.segs[0], sk = s.sk; ai.t -= dt; if (ai.t > 0) return; ai.t = R(.2, .32) - sk * .1;
      let best = null, bd = 1e9, isBox = false;
      if (!s.item && s.roll <= 0) for (const b of W.boxes) { const d = hyp(b.x - h.x, b.y - h.y); if (d < 300 && d < bd) { bd = d; best = b; isBox = true; } }
      if (!best) for (const f of W.foods) {
        const dx = f.x - h.x, dy = f.y - h.y; if (dx > 260 || dx < -260 || dy > 260 || dy < -260) continue;
        const d = hyp(dx, dy) / (f.v + .4) + Math.abs(angDiff(Math.atan2(dy, dx), s.angle)) * 90; if (d < bd) { bd = d; best = f; }
      }
      if (best) { ai.tx = best.x; ai.ty = best.y; }
      else if (hyp(ai.tx - h.x, ai.ty - h.y) < 80) { const p = randIn(400); ai.tx = p[0]; ai.ty = p[1]; }
      s.want = Math.atan2(ai.ty - h.y, ai.tx - h.x) + R(-.25, .25) * (1 - sk); // trochu se "motá"
      ai.danger = Math.random() < .45 + sk && danger(s, s.angle) > 0; // občas si nebezpečí nevšimne
      if (ai.danger) {
        let ba = s.want, bs = 1e9;
        for (const off of [-.8, .8, -1.6, 1.6]) { const sc = danger(s, s.angle + off) + Math.abs(off) * .3; if (sc < bs) { bs = sc; ba = s.angle + off; } }
        s.want = ba;
      }
      s.boost = (isBox && bd < 160 && sk > .45) || (s.boosting && s.en > 40);
      if (!s.item) return;
      const it = s.item, age = s.itemAge;
      const near = (rad, cone) => W.snakes.some(o => o !== s && o.alive && o.fx.spawn <= 0 && hyp(o.segs[0].x - h.x, o.segs[0].y - h.y) < rad &&
        (cone == null || Math.abs(angDiff(Math.atan2(o.segs[0].y - h.y, o.segs[0].x - h.x), s.angle)) < cone));
      let use = false;
      if (it === 'turbo') use = age > 3;
      else if (it === 'magnet') use = age > 2;
      else if (it === 'shield') use = (ai.danger && Math.random() < sk) || age > 12;
      else if (it === 'rocket') use = age > 3 && near(650, .35) && Math.random() < .25;
      else if (it === 'mine') use = age > 4;
      else if (it === 'bolt') use = age > 3 && near(450) && Math.random() < .3;
      if (use) useItem(s);
    }

    /* ---------- pohyb ---------- */
    function updSnake(s, dt) {
      const tr = turnRate(s.mass, !!s.pid) * dt;
      s.angle += clamp(angDiff(s.want, s.angle), -tr, tr);
      // Boost bere energii, ne délku. Energie se dobíjí, když nebooostuješ.
      if (s.boost && (s.boosting ? s.en > 0 : s.en > C.ENERGY_MIN_START)) s.boosting = true; else s.boosting = false;
      if (s.boosting && s.fx.turbo <= 0) { s.en = Math.max(0, s.en - C.ENERGY_DRAIN * dt); s.enIdle = 0; }
      else { s.enIdle += dt; if (s.enIdle > C.ENERGY_DELAY) s.en = Math.min(C.ENERGY_MAX, s.en + C.ENERGY_REGEN * dt); }
      const sp = speedOf(s.fx.turbo > 0, s.boosting, s.fx.slow > 0);
      const S = s.segs, h = S[0];
      h.x += Math.cos(s.angle) * sp * dt; h.y += Math.sin(s.angle) * sp * dt;
      for (let i = 1; i < S.length; i++) {
        const a = S[i - 1], b = S[i], dx = a.x - b.x, dy = a.y - b.y, d = hyp(dx, dy);
        if (d > C.SP) { const k = (d - C.SP) / d; b.x += dx * k; b.y += dy * k; }
      }
      const n = Math.max(8, Math.floor(s.mass));
      while (S.length < n) { const t = S[S.length - 1]; S.push({ x: t.x, y: t.y }); }
      if (S.length > n) S.length = n;
      for (const k in s.fx) if (s.fx[k] > 0) s.fx[k] -= dt;
      if (s.item) s.itemAge += dt;
      if (s.roll > 0) { s.roll -= dt; if (s.roll <= 0) { s.item = pickItem(s); s.itemAge = 0; toast(s, { it: s.item }); } }
      if (hyp(h.x, h.y) > C.ARENA) { if (s.fx.spawn > 0) s.angle += Math.PI; else kill(s, null, 'edge'); }
    }
    function collide() {
      for (const s of W.snakes) {
        if (!s.alive || s.fx.shield > 0 || s.fx.spawn > 0) continue;
        const h = s.segs[0], hr = radius(s); let killer = null;
        query(h.x, h.y, hr + 30, (o, i) => {
          if (o === s || !o.alive || o.fx.spawn > 0) return;
          const g = o.segs[i]; if (hyp(g.x - h.x, g.y - h.y) < hr * .7 + radius(o) * .85) { killer = o; return true; }
        });
        if (killer) kill(s, killer);
      }
    }
    function eat(dt) {
      for (const s of W.snakes) {
        if (!s.alive) continue;
        const h = s.segs[0], hr = radius(s), mag = s.fx.magnet > 0, pr = mag ? 280 : hr + 34;
        for (let j = W.foods.length - 1; j >= 0; j--) {
          const f = W.foods[j], dx = h.x - f.x, dy = h.y - f.y;
          if (dx > pr || dx < -pr || dy > pr || dy < -pr) continue;
          const d = hyp(dx, dy), fr = Math.min(3 + f.v * 2.2, 11);
          if (d < hr + fr) { s.mass += s.pid ? f.v : f.v * (s.mass > 200 ? .4 : .7); W.foods[j] = W.foods[W.foods.length - 1]; W.foods.pop(); continue; }
          if (d < pr) { const v = (mag ? 420 : 240) * dt / d; f.x += dx * v; f.y += dy * v; }
        }
        if (!s.item && s.roll <= 0) for (let j = W.boxes.length - 1; j >= 0; j--) {
          const b = W.boxes[j];
          if (hyp(b.x - h.x, b.y - h.y) < hr + 17) { s.roll = 1.1; W.boxes.splice(j, 1); emit({ k: 'ex', x: b.x, y: b.y, c: '#ffcf3a', n: 12, v: 160 }); break; }
        }
      }
    }
    function hitSnake(o, i, owner, how) {
      if (o.fx.shield > 0) { emit({ k: 'ex', x: o.segs[0].x, y: o.segs[0].y, c: '#4fd8ff', n: 18, v: 200 }); return; }
      if (i < 6) { kill(o, owner, how); return; }
      dropBody(o, i, .7); o.mass = i; o.segs.length = i; o.fx.slow = 1;
      if (owner) emit({ k: 'fe', f: 't', a: owner.name, b: o.name });
    }
    function updMissiles(dt) {
      for (let j = W.missiles.length - 1; j >= 0; j--) {
        const m = W.missiles[j]; m.t -= dt;
        if (m.tgt && m.tgt.alive) { const want = Math.atan2(m.tgt.segs[0].y - m.y, m.tgt.segs[0].x - m.x); const tr = m.owner.pid ? 3.4 : 1.9; m.a += clamp(angDiff(want, m.a), -tr * dt, tr * dt); } // raketa bota zatáčí hůř
        m.x += Math.cos(m.a) * 560 * dt; m.y += Math.sin(m.a) * 560 * dt;
        let hit = null, hi = 0;
        query(m.x, m.y, 40, (o, i) => {
          if (o === m.owner || !o.alive || o.fx.spawn > 0) return;
          const g = o.segs[i]; if (hyp(g.x - m.x, g.y - m.y) < radius(o) + 7) { hit = o; hi = i; return true; }
        });
        if (hit) { emit({ k: 'ex', x: m.x, y: m.y, c: '#ff4f7b', n: 26, v: 300 }); hitSnake(hit, hi, m.owner, 'rocket'); W.missiles.splice(j, 1); continue; }
        if (m.t <= 0 || hyp(m.x, m.y) > C.ARENA) { emit({ k: 'ex', x: m.x, y: m.y, c: '#ff8a3d', n: 14, v: 200 }); W.missiles.splice(j, 1); }
      }
    }
    function updMines(dt) {
      for (let j = W.mines.length - 1; j >= 0; j--) {
        const m = W.mines[j]; m.t += dt;
        if (m.t > m.life) { W.mines.splice(j, 1); continue; } if (m.t < .6) continue;
        for (const s of W.snakes) {
          if (!s.alive || s.fx.spawn > 0 || (s === m.owner && m.t < 3)) continue;
          if (hyp(s.segs[0].x - m.x, s.segs[0].y - m.y) < radius(s) + 13) {
            emit({ k: 'ex', x: m.x, y: m.y, c: '#c07bff', n: 30, v: 280 }); W.mines.splice(j, 1);
            if (s.fx.shield <= 0) { shrink(s, .3); s.fx.slow = 2.5; if (m.owner !== s) emit({ k: 'fe', f: 'm', a: m.owner.name, b: s.name }); }
            break;
          }
        }
      }
    }

    /* ---------- veřejné API ---------- */
    function fill() {
      while (W.foods.length < C.FOOD_N) { const p = randIn(30); addFood(p[0], p[1], Math.random() < .12 ? 2 : 1); }
      while (W.boxes.length < C.BOX_N) { const p = randIn(80); addBox(p[0], p[1]); }
    }
    fill();

    function botsWanted() { let humans = 0; for (const p of W.players.values()) if (p.snake) humans++; return Math.max(C.MIN_BOTS, C.SNAKES_TARGET - humans); }
    for (let i = 0; i < C.SNAKES_TARGET; i++) spawnBot();

    function step(dt) {
      W.time += dt;
      for (const s of W.snakes) if (s.alive && !s.pid) botThink(s, dt);
      for (const s of W.snakes) if (s.alive) updSnake(s, dt);
      buildGrid(); collide(); eat(dt); updMissiles(dt); updMines(dt);
      W.snakes = W.snakes.filter(s => s.alive);
      for (let j = W.respawns.length - 1; j >= 0; j--) { W.respawns[j] -= dt; if (W.respawns[j] <= 0) { W.respawns.splice(j, 1); spawnBot(); } }
      const bots = W.snakes.filter(s => !s.pid).length + W.respawns.length, want = botsWanted();
      if (bots < want) W.respawns.push(R(1.5, 4));
      if (bots > want) { // uvolni místo pro lidi: nejmenší bot zmizí
        const b = W.snakes.filter(s => !s.pid).sort((a, b) => a.mass - b.mass)[0];
        if (b && b.mass < 40) { b.alive = false; W.snakes = W.snakes.filter(s => s !== b); }
      }
      if (W.foods.length < C.FOOD_N) for (let k = 0; k < 8 && W.foods.length < C.FOOD_N; k++) { const p = randIn(30); addFood(p[0], p[1], Math.random() < .12 ? 2 : 1); }
      if (W.foods.length > C.FOOD_N * 2.2) W.foods.splice(0, W.foods.length - C.FOOD_N * 2.2);
      if (W.boxes.length < C.BOX_N && Math.random() < dt * 2) { const p = randIn(80); addBox(p[0], p[1]); }
      for (const p of W.players.values()) if (p.snake && p.snake.alive) {
        p.max = Math.max(p.max, Math.floor(p.snake.mass)); p.best = Math.min(p.best, rankOf(p.snake).i + 1);
        p.camX = p.snake.segs[0].x; p.camY = p.snake.segs[0].y;
      }
      while (W.log.length && W.log[0].t < W.time - 3) W.log.shift();
    }

    function addPlayer(name) {
      const pid = W.nextId++;
      W.players.set(pid, { pid, name: String(name || 'Player').slice(0, 14), snake: null, vw: 1600, vh: 1000, seq: W.seq, camX: 0, camY: 0, max: 0, best: 99, dead: null });
      return pid;
    }
    function spawnPlayer(pid, opts) {
      const p = W.players.get(pid); if (!p) return;
      if (p.snake && p.snake.alive) return;
      if (opts && opts.name) p.name = String(opts.name).replace(/[<>]/g, '').trim().slice(0, 14) || 'Player';
      const ci = opts && Number.isInteger(opts.ci) && opts.ci >= 0 && opts.ci < PAL.length ? opts.ci : 1;
      p.snake = makeSnake(p.name, ci, opts && opts.skin, pid);
      p.max = 28; p.best = 99; p.dead = null; p.seq = W.seq;
    }
    function removePlayer(pid) {
      const p = W.players.get(pid); if (!p) return;
      if (p.snake && p.snake.alive) { p.snake.pid = 0; kill(p.snake, null, 'left'); }
      W.players.delete(pid);
    }
    function input(pid, msg) {
      const p = W.players.get(pid); if (!p) return;
      if (typeof msg.vw === 'number') { p.vw = clamp(msg.vw, 300, 3400); p.vh = clamp(msg.vh || 1000, 300, 2400); }
      const s = p.snake; if (!s || !s.alive) return;
      if (typeof msg.a === 'number' && isFinite(msg.a)) s.want = msg.a;
      if (typeof msg.b === 'boolean' || typeof msg.b === 'number') s.boost = !!msg.b;
      if (msg.u) useItem(s);
      if (Number.isFinite(msg.q)) p.q = msg.q; // poslední zpracovaný vstup → klient podle toho dopočítá předpověď
    }

    const r1 = v => Math.round(v * 10) / 10;
    function snapshot(pid, light) { // light = bez minimapy a žebříčku (posílají se jen každý 4. snímek)
      const p = W.players.get(pid);
      const me = p && p.snake && p.snake.alive ? p.snake : null;
      const cx = p ? p.camX : 0, cy = p ? p.camY : 0, hw = (p ? p.vw : 1600) / 2 + 80, hh = (p ? p.vh : 1000) / 2 + 80;
      const inV = (x, y, m) => x > cx - hw - m && x < cx + hw + m && y > cy - hh - m && y < cy + hh + m;
      const sn = [];
      for (const s of W.snakes) {
        if (!s.alive) continue;
        let any = false; for (let i = 0; i < s.segs.length; i += 4) if (inV(s.segs[i].x, s.segs[i].y, 40)) { any = true; break; }
        if (!any) continue;
        const seg = []; for (let i = 0; i < s.segs.length; i += 2) seg.push(Math.round(s.segs[i].x), Math.round(s.segs[i].y));
        const fl = (s.fx.shield > 0 ? 1 : 0) | (s.fx.turbo > 0 ? 2 : 0) | (s.fx.slow > 0 ? 4 : 0) | (s.fx.spawn > 0 ? 8 : 0) | (s.fx.magnet > 0 ? 16 : 0) | (s.boosting ? 32 : 0) | (s.fx.shield > 0 && s.fx.shield < 1.2 ? 64 : 0) | (s.pid ? 128 : 0);
        sn.push([s.id, s.name, s.skin, s.ci, r1(s.mass), Math.round(s.angle * 100) / 100, fl, s.item ? IK.indexOf(s.item) : -1, seg, Math.round(s.want * 100) / 100]);
      }
      const fo = []; for (const f of W.foods) if (inV(f.x, f.y, 10)) fo.push(Math.round(f.x), Math.round(f.y), Math.round(f.v * 10), f.c);
      const bx = []; for (const b of W.boxes) if (inV(b.x, b.y, 30)) bx.push(Math.round(b.x), Math.round(b.y), Math.round(b.a * 100));
      const mi = []; for (const m of W.missiles) if (inV(m.x, m.y, 30)) mi.push(Math.round(m.x), Math.round(m.y), Math.round(m.a * 100));
      const mn = []; for (const m of W.mines) if (inV(m.x, m.y, 30)) mn.push(Math.round(m.x), Math.round(m.y), m.t > .6 ? 1 : 0);
      const al = sortedAlive();
      const tag = s => s === me ? 1 : s.pid ? 2 : 0; // 1 = já, 2 = jiný člověk (kamarád)
      const lb = light ? null : al.slice(0, 8).map(s => [s.name, Math.floor(s.mass), tag(s)]);
      const myRank = me ? al.indexOf(me) : -1;
      if (lb && me && myRank >= 8) lb.push([me.name, Math.floor(me.mass), 1, myRank + 1]);
      const mm = light ? null : []; if (mm) for (const s of al) mm.push(Math.round(s.segs[0].x / 10), Math.round(s.segs[0].y / 10), s.ci, tag(s));
      const bm = light ? null : []; if (bm) for (const b of W.boxes) bm.push(Math.round(b.x / 10), Math.round(b.y / 10));
      const ev = [];
      if (p) { for (const e of W.log) if (e.s > p.seq && (!e.only || e.only === pid)) ev.push(e.ev); p.seq = W.seq; }
      const out = { tm: Math.round(W.time * 1000) / 1000, cx: Math.round(cx), cy: Math.round(cy), sn, fo, bx, mi, mn, ev, A: C.ARENA };
      if (!light) { out.lb = lb; out.mm = mm; out.bm = bm; }
      if (me) {
        out.me = { id: me.id, m: r1(me.mass), it: me.item ? IK.indexOf(me.item) : -1, ro: me.roll > 0 ? 1 : 0, en: Math.round(me.en), k: me.kills,
          fx: [r1(Math.max(0, me.fx.turbo)), r1(Math.max(0, me.fx.shield)), r1(Math.max(0, me.fx.magnet))], b: me.boosting ? 1 : 0, rank: myRank + 1,
          q: p.q || 0, hx: r1(me.segs[0].x), hy: r1(me.segs[0].y), an: Math.round(me.angle * 1000) / 1000, enx: r1(me.en), ei: r1(Math.min(me.enIdle, 9)), sl: r1(Math.max(0, me.fx.slow)) };
      } else if (p && p.dead) out.dead = p.dead;
      return out;
    }

    return { step, addPlayer, spawnPlayer, removePlayer, input, snapshot, W,
      get playerCount() { let n = 0; for (const p of W.players.values()) if (p.snake) n++; return n; } };
  }

  return { createWorld, C, IK, ITEM_COL, PAL, SKINS, turnRate, speedOf };
});
