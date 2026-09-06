/**
 * A shared, fake brawl.
 *
 * Every visual prototype renders THIS data, so the only thing that differs
 * between them is the look. Same choreography, same HUD, same impacts — an
 * apples-to-apples comparison rather than four different scenes.
 *
 * Deliberately not real physics: it is a scripted loop that reliably produces
 * the moments worth judging (a hit landing, a knockdown, someone tumbling off
 * the edge, the winner banner) every ~20 seconds.
 */

export const PLAYERS = [
  { name: 'Priya', color: '#ff4d4d', hue: 0 },
  { name: 'Harshit', color: '#3d7dff', hue: 220 },
  { name: 'Sam', color: '#3ddc84', hue: 145 },
  { name: 'Ravi', color: '#ffd23d', hue: 45 },
];

export const STAGE_RADIUS = 7.2;

/** Deterministic noise so every prototype animates identically. */
function wobble(seed, t, freq) {
  return Math.sin(t * freq + seed * 2.399) * 0.5 + Math.sin(t * freq * 0.61 + seed * 5.1) * 0.5;
}

export function createSim() {
  const fighters = PLAYERS.map((p, i) => ({
    ...p,
    i,
    x: Math.cos((i / 4) * Math.PI * 2 + 0.7) * 3.6,
    z: Math.sin((i / 4) * Math.PI * 2 + 0.7) * 3.6,
    y: 0,
    vx: 0,
    vz: 0,
    /** Lean from upright, radians. This is the active-ragdoll read. */
    tilt: 0,
    tiltDir: 0,
    facing: 0,
    /** 0..1, decays. Drives squash and the hit flash. */
    hit: 0,
    /** 0..1 while the punch arm is out. */
    punch: 0,
    alive: true,
    outAt: 0,
  }));

  /** Impact rings/particles for the renderers to draw. */
  const impacts = [];
  let t = 0;
  let shake = 0;
  let banner = '';
  let bannerSub = '';
  let phase = 'fight';
  let phaseT = 0;

  function reset() {
    for (const f of fighters) {
      f.x = Math.cos((f.i / 4) * Math.PI * 2 + 0.7) * 3.6;
      f.z = Math.sin((f.i / 4) * Math.PI * 2 + 0.7) * 3.6;
      f.y = 0;
      f.vx = 0;
      f.vz = 0;
      f.tilt = 0;
      f.hit = 0;
      f.punch = 0;
      f.alive = true;
      f.outAt = 0;
    }
    impacts.length = 0;
  }

  function hit(a, b, power) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dz) || 1;
    b.vx += (dx / d) * 9 * power;
    b.vz += (dz / d) * 9 * power;
    b.y = 0.5 * power;
    b.hit = 1;
    b.tilt = 1.5 * power;
    b.tiltDir = Math.atan2(dz, dx);
    a.punch = 1;
    a.facing = Math.atan2(dx, dz);
    shake = Math.min(1, shake + power);
    impacts.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, age: 0, power });
  }

  /** Advance by `dt` seconds. */
  function update(dt) {
    t += dt;
    phaseT += dt;
    shake *= Math.exp(-dt * 9);

    if (phase === 'fight') {
      banner = '';
      bannerSub = '';

      for (const f of fighters) {
        if (!f.alive) continue;

        // Drift toward the middle with a personal wobble, so they collide.
        const toC = Math.hypot(f.x, f.z) || 1;
        const seek = 1.6;
        f.vx += (-f.x / toC) * seek * dt + wobble(f.i, t, 1.1) * 5 * dt;
        f.vz += (-f.z / toC) * seek * dt + wobble(f.i + 9, t, 0.9) * 5 * dt;

        f.vx *= Math.exp(-dt * 2.2);
        f.vz *= Math.exp(-dt * 2.2);
        f.x += f.vx * dt;
        f.z += f.vz * dt;

        if (Math.hypot(f.vx, f.vz) > 0.4) f.facing = Math.atan2(f.vx, f.vz);

        // Airborne arc after a hit.
        if (f.y > 0 || f.hit > 0.4) {
          f.y = Math.max(0, f.y + (0.9 - f.y * 4) * dt);
        }

        // Lean: driven by the hit, then the upright controller wins it back.
        f.tilt = Math.max(0, f.tilt - dt * (f.hit > 0.3 ? 0.35 : 1.5));
        // A little permanent sway so nobody stands perfectly still.
        f.hit = Math.max(0, f.hit - dt * 1.5);
        f.punch = Math.max(0, f.punch - dt * 4);

        // Off the edge.
        if (Math.hypot(f.x, f.z) > STAGE_RADIUS + 0.4) {
          f.alive = false;
          f.outAt = t;
        }
      }

      // Scripted exchanges: someone lands a punch about twice a second.
      const beat = Math.floor(t * 1.7);
      if (beat !== update._beat) {
        update._beat = beat;
        const live = fighters.filter((f) => f.alive);
        if (live.length >= 2) {
          const a = live[beat % live.length];
          // Hit whoever is nearest.
          let best = null;
          let bestD = 9;
          for (const b of live) {
            if (b === a) continue;
            const d = Math.hypot(b.x - a.x, b.z - a.z);
            if (d < bestD) {
              bestD = d;
              best = b;
            }
          }
          if (best && bestD < 4.5) hit(a, best, bestD < 2.2 ? 1 : 0.55);
        }
      }

      const live = fighters.filter((f) => f.alive);
      if (live.length <= 1 || phaseT > 26) {
        phase = 'win';
        phaseT = 0;
        banner = live.length === 1 ? `${live[0].name} WINS` : 'EVERYONE LOST';
        bannerSub = `${phaseT.toFixed(1)}s`;
      }
    } else if (phase === 'win') {
      if (phaseT > 3.5) {
        phase = 'fight';
        phaseT = 0;
        reset();
      }
    }

    for (let i = impacts.length - 1; i >= 0; i--) {
      impacts[i].age += dt;
      if (impacts[i].age > 0.6) impacts.splice(i, 1);
    }
  }
  update._beat = -1;

  return {
    fighters,
    impacts,
    get t() {
      return t;
    },
    get shake() {
      return shake;
    },
    get banner() {
      return banner;
    },
    get bannerSub() {
      return bannerSub;
    },
    get elapsed() {
      return phaseT;
    },
    get aliveCount() {
      return fighters.filter((f) => f.alive).length;
    },
    update,
  };
}

/** The HUD markup every prototype shares, so the comparison includes the UI. */
export function mountHud(root, styleAccent) {
  root.insertAdjacentHTML(
    'beforeend',
    `
    <div class="hud">
      <div class="join">
        <div class="qr"></div>
        <div>
          <div class="join-label">Scan to join</div>
          <div class="code">NDME</div>
        </div>
      </div>
      <div class="round">
        <div class="round-name">KNOCKOUT</div>
        <div class="round-sub"></div>
      </div>
      <div class="standings"></div>
      <div class="banner"></div>
      <div class="banner-sub"></div>
    </div>`,
  );
  const hud = root.querySelector('.hud');
  if (styleAccent) hud.style.setProperty('--accent', styleAccent);

  // A fake QR block — this is about layout weight, not scannability.
  const qr = hud.querySelector('.qr');
  const cells = 21;
  let svg = `<svg viewBox="0 0 ${cells} ${cells}" width="100%" height="100%">`;
  let seed = 7;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const corner = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      const on = corner ? (x + y) % 3 !== 0 : (seed >> 16) % 2 === 0;
      if (on) svg += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  qr.innerHTML = svg + '</svg>';

  const standings = hud.querySelector('.standings');
  const rows = PLAYERS.map((p) => {
    const el = document.createElement('div');
    el.className = 'standing';
    el.innerHTML = `<i style="background:${p.color}"></i><span>${p.name}</span><b>IN</b>`;
    standings.append(el);
    return el;
  });

  const bannerEl = hud.querySelector('.banner');
  const bannerSubEl = hud.querySelector('.banner-sub');
  const roundSub = hud.querySelector('.round-sub');

  return function updateHud(sim) {
    for (let i = 0; i < rows.length; i++) {
      const alive = sim.fighters[i].alive;
      rows[i].classList.toggle('out', !alive);
      rows[i].querySelector('b').textContent = alive ? 'IN' : 'OUT';
    }
    roundSub.textContent = `${sim.elapsed.toFixed(1)}s · ${sim.aliveCount} left`;
    bannerEl.textContent = sim.banner;
    bannerEl.style.display = sim.banner ? '' : 'none';
    bannerSubEl.textContent = sim.bannerSub;
    bannerSubEl.style.display = sim.bannerSub ? '' : 'none';
  };
}
