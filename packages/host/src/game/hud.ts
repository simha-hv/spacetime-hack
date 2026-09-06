import type { HudState, Standing } from './match.js';

/**
 * Cache key for the standings list.
 *
 * Extracted and exported purely so it can be tested. Every field the row
 * RENDERS has to appear here: the first version covered only slot, place and
 * alive, so setting your name or colour on your phone did not repaint the big
 * screen — the standings kept showing "P3" until the next elimination happened
 * to change the key for an unrelated reason.
 */
export function standingsKey(standings: readonly Standing[]): string {
  return standings.map((s) => `${s.slot}:${s.place}:${s.alive}:${s.name}:${s.color}`).join('|');
}

/**
 * The big-screen overlay: banner, round clock and standings.
 *
 * Plain DOM over the canvas rather than drawn into it — crisper text at TV
 * distance, free to style, and it costs the render loop nothing.
 */
export class Hud {
  private lastStandings = '';

  constructor(
    private readonly banner: HTMLElement,
    private readonly bannerSub: HTMLElement,
    private readonly timer: HTMLElement,
    private readonly standings: HTMLElement,
    private readonly title: HTMLElement,
  ) {}

  update(state: HudState): void {
    this.title.textContent = state.gameName;
    this.banner.textContent = state.banner;
    this.banner.classList.toggle('hidden', state.banner === '');
    // A short banner is a countdown digit; make it enormous.
    this.banner.classList.toggle('huge', state.banner.length <= 2);

    this.bannerSub.textContent = state.subBanner;
    this.bannerSub.classList.toggle('hidden', state.subBanner === '');

    this.timer.textContent =
      state.phase === 'playing' || state.phase === 'round_over'
        ? `${state.elapsed.toFixed(1)}s · ${state.aliveCount} left`
        : `${state.gameLose} · A punch · B grab · C jump`;

    // Rebuild only when the visible content changes, not every frame.
    const key = standingsKey(state.standings);
    if (key === this.lastStandings) return;
    this.lastStandings = key;

    this.standings.replaceChildren(
      ...state.standings.map((s) => {
        const row = document.createElement('div');
        row.className = s.alive ? 'standing' : 'standing out';
        const dot = document.createElement('i');
        dot.style.background = s.color;
        const name = document.createElement('span');
        name.textContent = s.name;
        const status = document.createElement('b');
        status.textContent = s.alive ? 'IN' : 'OUT';
        row.append(dot, name, status);
        return row;
      }),
    );
  }
}
