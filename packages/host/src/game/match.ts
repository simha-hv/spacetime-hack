import type RAPIER from '@dimforge/rapier3d-compat';

import { PALETTE } from '@brawl/protocol';

import type { SlotInput } from '../input-state.js';
import { SPECIES } from './animal.js';
import { Sfx } from './audio.js';
import { ChaseCamera } from './camera.js';
import { stickToMove } from './controls.js';
import { Cpu, type CpuView } from './cpu.js';
import { Effects } from './effects.js';
import { createEngine, STEP_MS, type Engine } from './engine.js';
import { Fighter, type FighterEvents } from './fighter.js';
import { Juice } from './juice.js';
import { DEFAULT_GAME, GAMES, gameById, type GameDef } from './games.js';
import type { Arena } from './arena.js';
import { makeNameTag, type NameTag } from './nametag.js';

/**
 * ROOFTOP RUMBLE — the match loop.
 *
 * Host-authoritative in the strictest sense: this is the only simulation
 * anywhere. Phones send input snapshots and receive a banner and a couple of
 * booleans. Nothing about a body's position ever leaves this machine, so
 * there is no state to sync and nothing to predict or roll back.
 */

export type Phase = 'lobby' | 'countdown' | 'playing' | 'round_over';

export interface Standing {
  slot: number;
  name: string;
  color: string;
  alive: boolean;
  /** 1 = winner. 0 while still fighting. */
  place: number;
}

export interface HudState {
  phase: Phase;
  /** The game being played, for the corner title. */
  gameName: string;
  /** Its one-line goal, shown under the title. */
  gameLose: string;
  banner: string;
  subBanner: string;
  elapsed: number;
  aliveCount: number;
  standings: Standing[];
}

export interface PhoneStatus {
  slot: number;
  phase: Phase;
  title: string;
  detail: string;
  youAlive: boolean;
  secondsLeft?: number;
}

export interface PlayerInfo {
  slot: number;
  name: string;
  color: string;
}

export interface GameMenuState {
  slot: number;
  games: { id: string; name: string; tagline: string; lose: string }[];
  current: string;
  canPick: boolean;
}

export interface MatchOptions {
  onPhoneStatus(status: PhoneStatus): void;
  onHud(state: HudState): void;
  onGameMenu(menu: GameMenuState): void;
}

const COUNTDOWN_MS = 3200;
/** How long a bots-only lobby waits before starting itself. */
const ATTRACT_DELAY_MS = 6000;
const ROUND_OVER_MS = 4200;
/** Below this nobody can win, so the round never starts. */
const MIN_PLAYERS = 2;

/** Players below this height are falling and stop counting for camera framing. */
const FRAMING_FLOOR = -1.5;

/**
 * CPU players are seated from 100 upward.
 *
 * Well clear of the 0..3 the server hands to phones, so a CPU can never be
 * handed a seat a phone is about to claim, and `inputs` (keyed by the same
 * slot numbers) can never have a phone's snapshots routed into a bot.
 */
const CPU_SLOT_BASE = 100;

/** Every seat, human or otherwise. The level has four spawn points. */
const MAX_SEATS = 4;

const CPU_NAMES = ['ROOK', 'PIXEL', 'BOLT', 'MOSS', 'ZIGGY', 'NOVA'];

/**
 * What to show when a player has not set a name.
 *
 * Empty is a real state — a phone that joined and never opened the customise
 * sheet — and it rendered as a blank standings row and an ellipsis floating
 * over the character's head, neither of which identifies anybody. The slot
 * number always exists and always matches the badge on their own phone.
 */
function displayName(name: string, slot: number): string {
  return name.trim() || `P${slot + 1}`;
}

interface Player extends PlayerInfo {
  fighter: Fighter;
  tag: NameTag;
  place: number;
  wins: number;
  /** Non-null for a CPU seat; the brain that drives it. */
  cpu: Cpu | null;
  /** 0..3. Picks the species and the spawn point, and is never shared. */
  seatIndex: number;
  /** Only meaningful when the current game has a health system. */
  health: number;
  /** This player's slice of `cpuViews`, refreshed each step. */
  view?: CpuView;
}

export class Match {
  private engine: Engine | null = null;
  private arena: Arena | null = null;
  private game: GameDef = gameById(DEFAULT_GAME);
  private chase: ChaseCamera | null = null;
  private effects: Effects | null = null;
  private readonly sfx = new Sfx();
  private readonly juice = new Juice();

  private readonly players = new Map<number, Player>();
  /** Collider handle -> slot, for routing contact events. */
  private readonly byCollider = new Map<number, number>();
  private inputs: Map<number, SlotInput> = new Map();

  private phase: Phase = 'lobby';
  private phaseMs = 0;
  private roundMs = 0;
  private lastCountdownSecond = -1;
  private winnerSlot: number | null = null;
  /** A game picked mid-round, applied as soon as the round is over. */
  private pendingGame: string | null = null;
  /**
   * How long the lobby has been ABLE to auto-start, not how long it has been
   * the lobby.
   *
   * Using the phase clock counted from page load, so by the time anyone pressed
   * "Add CPU" it was already tens of seconds past the threshold and the second
   * bot to sit down launched a round instantly — before the person who had just
   * scanned could pick anything, making their first tap do nothing.
   */
  private attractMs = 0;

  private raf = 0;
  private lastFrame = 0;
  private accumulator = 0;
  private hudAccum = 0;
  private phoneAccum = 0;
  private disposed = false;

  private readonly points: { x: number; y: number; z: number }[] = [];
  /** Reused every step so the CPUs never allocate. */
  private readonly cpuViews: CpuView[] = [];

  constructor(private readonly opts: MatchOptions) {}

  async start(canvas: HTMLCanvasElement, inputs: Map<number, SlotInput>): Promise<void> {
    this.inputs = inputs;
    const engine = await createEngine(canvas);
    if (this.disposed) {
      engine.dispose();
      return;
    }
    this.engine = engine;
    this.chase = new ChaseCamera(engine.camera);
    this.effects = new Effects(engine.scene);
    this.buildArena();

    window.addEventListener('resize', this.onResize);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.pushHud();
  }

  unlockAudio(): void {
    this.sfx.resume();
  }

  /* --------------------------------- games -------------------------------- */

  get currentGame(): GameDef {
    return this.game;
  }

  /** Diagnostics for the debug overlay. */
  get debugState(): string {
    return `${this.phase} h${this.humanCount}/a${this.humansAlive} q${this.pendingGame ?? '-'}`;
  }

  /**
   * Switch games. Tears the old arena down and rebuilds, then reseats everyone.
   *
   * Only allowed out of a live round — swapping the floor out from under four
   * players mid-fight is not a feature. The lobby is where this happens.
   */
  setGame(id: string): void {
    // `gameById` falls back to the default, so an id from a stale phone can
    // never leave the host without an arena.
    const next = gameById(id);

    if (this.phase === 'playing' || this.phase === 'countdown') {
      /*
       * A tap during a live round must never just vanish.
       *
       * Two cases, and they want opposite things. If nobody human is playing,
       * this is the attract round the host started on its own while waiting —
       * a person has just arrived and asked for a game, so cut it short and
       * give them theirs. If people ARE playing, they are mid-fight and do not
       * want the floor swapped out; hold the request and honour it the moment
       * the round ends.
       */
      if (this.humansAlive === 0) {
        this.pendingGame = null;
        this.endRound(null);
        this.phase = 'lobby';
        this.phaseMs = 0;
        this.applyGame(next);
        return;
      }
      this.pendingGame = next.id;
      this.pushMenu();
      return;
    }

    this.applyGame(next);
  }

  private applyGame(next: GameDef): void {
    this.pendingGame = null;
    if (this.game.id === next.id) {
      // Tapping the game that is already selected is how you start it.
      this.beginCountdown();
      return;
    }
    this.game = next;
    this.buildArena();

    // Everyone comes back for the new arena — spawn points differ, and a body
    // left where the old level put it can be inside the new level's geometry.
    const spawns = this.arena!.spawnPoints();
    for (const p of this.players.values()) {
      p.health = this.game.health ?? 0;
      p.place = 0;
      p.fighter.respawn(spawns[p.seatIndex % spawns.length]!);
      p.tag.setHealth(this.game.health === null ? null : 1);
      p.tag.sprite.visible = true;
    }
    this.phase = 'lobby';
    this.phaseMs = 0;
    this.winnerSlot = null;
    this.pushHud();
    this.pushPhones();
    this.pushMenu();

    // Picking a game IS starting it. Requiring a second, different tap to
    // begin turns one decision into two and leaves everyone staring at a
    // lobby wondering who is supposed to press what.
    this.beginCountdown();
  }

  /** Send the catalogue and the current selection to every phone. */
  private pushMenu(): void {
    const between = this.phase === 'lobby' || this.phase === 'round_over';
    const games = GAMES.map((g) => ({
      id: g.id,
      name: g.name,
      tagline: g.tagline,
      lose: g.lose,
    }));
    // While a round runs the picker shows the QUEUED game, so a tap has visible
    // feedback even when it takes effect at the next round.
    const current = this.pendingGame ?? this.game.id;

    for (const player of this.players.values()) {
      if (player.cpu) continue;
      // Per player, not per match. Someone who scanned during a round is
      // sitting out as a spectator with nothing else to do with their pad —
      // and if the round they are watching is bots-only, their tap ends it.
      const canPick = between || !player.fighter.alive;
      this.opts.onGameMenu({ slot: player.slot, games, current, canPick });
    }
  }

  private buildArena(): void {
    const engine = this.engine;
    if (!engine) return;
    this.arena?.dispose();
    this.arena = this.game.createArena();
    this.arena.build({ rapier: engine.rapier, world: engine.world, scene: engine.scene });
    this.chase?.snap(this.arena.spawnPoints().map((p) => ({ x: p.x, y: 1, z: p.z })));
  }

  /* -------------------------------- roster ------------------------------- */

  addPlayer(info: PlayerInfo): void {
    if (this.players.has(info.slot)) {
      this.updatePlayer(info);
      return;
    }
    // A phone always outranks a bot. If the roof is full of CPUs, one stands
    // down rather than the arriving human being turned away.
    if (this.players.size >= MAX_SEATS) this.removeCpu();
    this.seat(info, null);
  }

  /**
   * Add one CPU brawler. Returns false when every seat is taken.
   *
   * CPUs exist so that one person with one phone can actually play — and so a
   * three-player group is not stuck with a lopsided round.
   */
  addCpu(): boolean {
    if (!this.engine || this.players.size >= MAX_SEATS) return false;

    let slot = CPU_SLOT_BASE;
    while (this.players.has(slot)) slot++;

    // Pick a colour nothing on the roof is already using, so a bot is never
    // mistaken for a person's character.
    const taken = new Set([...this.players.values()].map((p) => p.color.toLowerCase()));
    const color =
      PALETTE.find((c) => !taken.has(c.hex.toLowerCase()))?.hex ?? PALETTE[0]!.hex;

    this.seat(
      { slot, name: CPU_NAMES[(slot - CPU_SLOT_BASE) % CPU_NAMES.length]!, color },
      new Cpu(Math.random()),
    );
    return true;
  }

  /** Remove the most recently added CPU. Returns false if there were none. */
  removeCpu(): boolean {
    let victim = -1;
    for (const [slot, p] of this.players) if (p.cpu && slot > victim) victim = slot;
    if (victim < 0) return false;
    this.removePlayer(victim);
    return true;
  }

  get seats(): { used: number; total: number; cpus: number } {
    let cpus = 0;
    for (const p of this.players.values()) if (p.cpu) cpus++;
    return { used: this.players.size, total: MAX_SEATS, cpus };
  }

  /** Everything both a phone and a CPU need to take a seat on the roof. */
  private seat(info: PlayerInfo, cpu: Cpu | null): void {
    const engine = this.engine;
    if (!engine) return;

    // Species and spawn come from the SEAT INDEX, not the slot number: CPU
    // slots start at 100, and `slot % 4` would sit a bot on top of a phone.
    // It is the lowest FREE index rather than the roster size, so someone
    // joining after a departure reuses the empty chair instead of spawning
    // inside whoever currently holds that number.
    const used = new Set([...this.players.values()].map((p) => p.seatIndex));
    let index = 0;
    while (used.has(index) && index < MAX_SEATS) index++;
    const species = SPECIES[index % SPECIES.length]!;
    const spawn = this.arena!.spawnPoints()[index % MAX_SEATS]!;

    const fighter = new Fighter(
      engine.rapier,
      engine.world,
      info.slot,
      species.id,
      info.color,
      species.bulk,
      spawn,
    );
    engine.scene.add(fighter.animal.root);

    const tag = makeNameTag(displayName(info.name, info.slot), info.color);
    engine.scene.add(tag.sprite);

    this.byCollider.set(fighter.collider.handle, info.slot);
    // Any roster change restarts the wait: somebody is clearly still setting up.
    this.attractMs = 0;
    this.players.set(info.slot, {
      ...info,
      fighter,
      tag,
      place: 0,
      wins: 0,
      cpu,
      seatIndex: index,
      health: this.game.health ?? 0,
    });
    tag.setHealth(this.game.health === null ? null : 1);

    // Someone arriving mid-round joins as a spectator rather than materialising
    // into the fight; they are in from the next round.
    if (this.phase === 'playing' || this.phase === 'round_over') {
      fighter.eliminate();
      tag.sprite.visible = false;
    }
    this.pushHud();
  }

  updatePlayer(info: PlayerInfo): void {
    const player = this.players.get(info.slot);
    if (!player) return;
    player.name = info.name;
    player.color = info.color;
    player.fighter.setColor(info.color);
    player.tag.setLabel(displayName(info.name, info.slot), info.color);
    this.pushHud();
  }

  removePlayer(slot: number): void {
    const player = this.players.get(slot);
    if (!player) return;
    this.attractMs = 0;
    this.byCollider.delete(player.fighter.collider.handle);
    this.engine?.scene.remove(player.fighter.animal.root);
    this.engine?.scene.remove(player.tag.sprite);
    player.fighter.dispose();
    player.tag.dispose();
    this.players.delete(slot);

    // A departure can leave one player standing; that still ends the round.
    if (this.phase === 'playing') this.checkRoundEnd();
    this.pushHud();
  }

  /* --------------------------------- loop -------------------------------- */

  private readonly onResize = (): void => {
    this.engine?.resize();
  };

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const engine = this.engine;
    if (!engine) return;

    // Clamped: a backgrounded tab returns with a huge delta, and replaying
    // seconds of physics at once explodes the world.
    const frameMs = Math.min(now - this.lastFrame, 100);
    this.lastFrame = now;

    this.juice.update(frameMs);
    this.advancePhase(frameMs);

    if (!this.juice.frozen) {
      this.accumulator += frameMs;
      // Bounded catch-up. Without the cap a slow frame begets more slow frames
      // and the loop spirals.
      let steps = 0;
      while (this.accumulator >= STEP_MS && steps < 5) {
        this.accumulator -= STEP_MS;
        steps++;
        this.simulate(engine);
      }
      if (steps === 5) this.accumulator = 0;
    }

    // Effects advance even while the simulation is frozen — hit-stop is meant
    // to hold the BODIES still so you can see the impact, not freeze the impact
    // itself, which would just look like a dropped frame.
    this.effects?.update(frameMs);

    const alpha = this.juice.frozen ? 1 : this.accumulator / STEP_MS;
    this.render(engine, frameMs, alpha);

    this.hudAccum += frameMs;
    if (this.hudAccum >= 100) {
      this.hudAccum = 0;
      this.pushHud();
    }
    this.phoneAccum += frameMs;
    if (this.phoneAccum >= 400) {
      this.phoneAccum = 0;
      this.pushPhones();
      this.pushMenu();
    }
  };

  private simulate(engine: Engine): void {
    const now = performance.now();
    const peers: Fighter[] = [];
    for (const p of this.players.values()) peers.push(p.fighter);

    const live = this.phase === 'playing';

    // Rebuilt each step and handed to every brain, so a CPU sees exactly what
    // is on the roof right now and nothing else — no velocities, no intentions.
    if (this.cpuViews.length !== this.players.size) this.cpuViews.length = this.players.size;
    let v = 0;
    for (const p of this.players.values()) {
      const t = p.fighter.position;
      const view = (this.cpuViews[v] ??= { x: 0, y: 0, z: 0, alive: true });
      view.x = t.x;
      view.y = t.y;
      view.z = t.z;
      view.alive = p.fighter.alive;
      p.view = view;
      v++;
    }

    for (const player of this.players.values()) {
      player.fighter.captureTransform();

      if (player.cpu) {
        // A CPU produces the same FighterInput a phone does, and goes through
        // the same `step`. It has no privileged physics — if it can do
        // something a player cannot, that is a bug.
        if (!live) continue;
        const input = player.cpu.think(
          player.view!,
          this.cpuViews,
          player.fighter.holding !== null,
          STEP_MS,
          this.arena!.safeZone(),
        );
        player.fighter.step(STEP_MS, input, peers, this.events);
        continue;
      }

      const input = this.inputs.get(player.slot);
      input?.expireIfSilent(now);

      // Buttons must be drained every step even when the round is not live,
      // otherwise presses queue up and all fire at once on the first frame
      // of the countdown.
      const presses = input?.takePresses() ?? { a: 0, b: 0, c: 0 };

      // Presses are still DRAINED outside a round — otherwise they queue up and
      // all fire on the first frame of play — but they no longer start it.
      // Starting is the picker's job now: a stray thumb on the pad used to
      // launch whatever game happened to be selected before anyone had chosen.
      if (!live) continue;

      const move = stickToMove(input?.axisX ?? 0, input?.axisY ?? 0);
      player.fighter.step(
        STEP_MS,
        {
          moveX: move.moveX,
          moveZ: move.moveZ,
          punches: presses.a,
          grabs: presses.b,
          jumps: presses.c,
        },
        peers,
        this.events,
      );
    }

    // The level gets its turn BEFORE the solver runs, so belts and presses act
    // on the same step as the players do rather than a frame behind them.
    if (live) this.arena?.step?.(STEP_MS, peers);

    engine.world.step(engine.eventQueue);
    this.drainContacts(engine);
    this.arena?.sync();

    if (!live) return;

    for (const player of this.players.values()) {
      if (player.fighter.checkFall(this.arena!.killY)) {
        this.sfx.fall();
        player.place = this.remainingPlaces();
      }
    }
    this.roundMs += STEP_MS;
    this.checkRoundEnd();
  }

  /**
   * Body-to-body impacts.
   *
   * Rapier reports these only because the colliders opted in with
   * `ActiveEvents.CONTACT_FORCE_EVENTS`; without that flag this callback never
   * fires at all and hard collisions silently do nothing.
   */
  private drainContacts(engine: Engine): void {
    engine.eventQueue.drainContactForceEvents((event: RAPIER.TempContactForceEvent) => {
      const magnitude = event.totalForceMagnitude();
      if (magnitude < 260) return;

      const a = this.byCollider.get(event.collider1());
      const b = this.byCollider.get(event.collider2());
      if (a === undefined && b === undefined) return;

      const power = Math.min(1, (magnitude - 260) / 900);
      for (const slot of [a, b]) {
        if (slot === undefined) continue;
        this.players.get(slot)?.fighter.onImpact(power * 10);
      }
      if (power > 0.25) {
        this.juice.impact(power * 0.6);
        this.sfx.land(power);
        // Body-to-body collisions get a burst as well, at the midpoint — being
        // bowled over by someone who was thrown at you is a real event and it
        // should look like one.
        if (a !== undefined && b !== undefined) {
          const pa = this.players.get(a)!.fighter.position;
          const pb = this.players.get(b)!.fighter.position;
          this.effects?.burst(
            (pa.x + pb.x) / 2,
            (pa.y + pb.y) / 2 + 0.5,
            (pa.z + pb.z) / 2,
            power * 0.7,
          );
        }
      }
    });
  }

  private render(engine: Engine, frameMs: number, alpha: number): void {
    this.points.length = 0;
    for (const player of this.players.values()) {
      player.fighter.render(alpha);
      if (!player.fighter.alive) {
        player.tag.sprite.visible = false;
        continue;
      }

      const p = player.fighter.animal.root.position;

      /*
       * Once you are below the roof you are, in practice, already out — the
       * elimination just has not been recorded yet. Two things follow, and they
       * are the same rule so they use the same constant:
       *
       *  - Your name tag comes down with you. Tags ignore depth so they draw
       *    through the building, and a punch can throw a body twenty metres
       *    clear of the roof: the label was left hovering over the arena with
       *    nothing underneath it, which reads as a character that vanished.
       *  - You stop voting on the camera framing, so falling out does not yank
       *    the camera away from the fight still happening on the roof.
       */
      const onStage = p.y > FRAMING_FLOOR;
      player.tag.sprite.visible = onStage;
      if (!onStage) continue;

      player.tag.sprite.position.set(p.x, p.y + 2.1, p.z);
      this.points.push({ x: p.x, y: p.y, z: p.z });
    }
    // With nobody left the camera would snap to the origin at full zoom; hold
    // the last framing instead so the winner shot does not lurch.
    if (this.points.length > 0) {
      this.chase?.update(this.points, frameMs / 1000, this.juice.shakeOffset);
    }
    engine.renderer.render(engine.scene, engine.camera);
  }

  /* --------------------------- fighter callbacks -------------------------- */

  private readonly events: FighterEvents = {
    onPunchThrown: () => this.sfx.punchWhiff(),
    onHit: (power, x, y, z, victimSlot) => {
      this.sfx.punchHit(power);
      this.juice.impact(power);
      this.damage(victimSlot, this.game.punchDamage);
      // The burst is the whole point: audio and shake say "something happened",
      // only this says where and to whom.
      this.effects?.burst(x, y, z, power);
    },
    onGrab: () => this.sfx.grab(),
    onThrow: (victimSlot) => {
      this.sfx.throwing();
      this.juice.impact(0.6);
      this.damage(victimSlot, this.game.throwDamage);
    },
    onLand: (power) => this.sfx.land(power),
  };

  /**
   * Apply damage, if this game has a health system at all.
   *
   * Reaching zero is an elimination exactly like falling off a roof is — same
   * `eliminate`, same placing, same standings — so nothing downstream has to
   * know which game is being played.
   */
  private damage(slot: number, amount: number): void {
    if (this.game.health === null || amount <= 0) return;
    const player = this.players.get(slot);
    if (!player || !player.fighter.alive) return;

    player.health = Math.max(0, player.health - amount);
    player.tag.setHealth(player.health / this.game.health);
    if (player.health > 0) return;

    player.fighter.eliminate();
    player.place = this.remainingPlaces();
    this.sfx.fall();
    this.checkRoundEnd();
  }

  /* -------------------------------- phases ------------------------------- */

  private advancePhase(frameMs: number): void {
    this.phaseMs += frameMs;

    switch (this.phase) {
      case 'lobby': {
        // A pick that arrived mid-round gets honoured now.
        if (this.pendingGame !== null) {
          this.applyGame(gameById(this.pendingGame));
          break;
        }
        // Nobody here but bots: start on our own after a beat, so a rooftop of
        // animals is not left standing still forever with nobody holding a
        // phone to pick with. Deliberately unhurried — someone who has just
        // scanned is still reading the picker.
        const idle = this.players.size >= MIN_PLAYERS && this.humanCount === 0;
        this.attractMs = idle ? this.attractMs + frameMs : 0;
        if (this.attractMs > ATTRACT_DELAY_MS) this.beginCountdown();
        break;
      }

      case 'countdown': {
        const remaining = COUNTDOWN_MS - this.phaseMs;
        const second = Math.ceil(remaining / 1000);
        if (second !== this.lastCountdownSecond) {
          this.lastCountdownSecond = second;
          if (second > 0) this.sfx.countdownTick();
        }
        if (remaining <= 0) {
          this.phase = 'playing';
          this.phaseMs = 0;
          this.roundMs = 0;
          this.sfx.countdownGo();
          this.pushPhones();
        }
        break;
      }

      case 'playing':
        if (this.roundMs >= this.game.roundLimitMs) this.endRound(null);
        break;

      case 'round_over':
        if (this.phaseMs >= ROUND_OVER_MS) {
          this.phase = 'lobby';
          this.phaseMs = 0;
          this.pushPhones();
        }
        break;
    }
  }

  private beginCountdown(): void {
    if (this.countAlivePlayers() < MIN_PLAYERS && this.players.size < MIN_PLAYERS) return;
    this.phase = 'countdown';
    this.phaseMs = 0;
    this.attractMs = 0;
    this.lastCountdownSecond = -1;
    this.winnerSlot = null;
    this.juice.reset();
    this.effects?.reset();
    this.arena?.reset();

    const spawns = this.arena!.spawnPoints();
    let i = 0;
    for (const player of this.players.values()) {
      player.place = 0;
      player.health = this.game.health ?? 0;
      player.tag.setHealth(this.game.health === null ? null : 1);
      player.fighter.respawn(spawns[i % spawns.length]!);
      player.tag.sprite.visible = true;
      i++;
    }
    this.chase?.snap(spawns.map((p) => ({ x: p.x, y: 1, z: p.z })));
    this.pushPhones();
  }

  private get humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.cpu) n++;
    return n;
  }

  /**
   * Humans still standing in the current round.
   *
   * The test for "is anyone actually playing this" — not `humanCount`, which
   * counts a person who scanned ten seconds ago and is sitting out as a
   * spectator. If no human is alive, nobody is enjoying this round and it can
   * be cut short for whoever just asked for a different game.
   */
  private get humansAlive(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.cpu && p.fighter.alive) n++;
    return n;
  }

  private countAlivePlayers(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.fighter.alive) n++;
    return n;
  }

  private remainingPlaces(): number {
    // Eliminations are placed from the bottom up: the first player out of a
    // four-player round takes 4th.
    return this.countAlivePlayers() + 1;
  }

  private checkRoundEnd(): void {
    if (this.phase !== 'playing') return;
    const alive = this.countAlivePlayers();
    if (alive > 1) return;
    if (this.players.size < MIN_PLAYERS) {
      this.endRound(null);
      return;
    }
    let winner: Player | null = null;
    for (const p of this.players.values()) if (p.fighter.alive) winner = p;
    this.endRound(winner);
  }

  private endRound(winner: Player | null): void {
    this.phase = 'round_over';
    this.phaseMs = 0;
    this.winnerSlot = winner?.slot ?? null;
    if (winner) {
      winner.place = 1;
      winner.wins++;
      this.sfx.fanfare();
    }
    this.pushPhones();
    this.pushHud();
  }

  /* ------------------------------- reporting ------------------------------ */

  private standings(): Standing[] {
    return [...this.players.values()]
      .sort((a, b) => b.wins - a.wins || a.slot - b.slot)
      .map((p) => ({
        slot: p.slot,
        name: displayName(p.name, p.slot),
        color: p.color,
        alive: p.fighter.alive,
        place: p.place,
      }));
  }

  private pushHud(): void {
    const alive = this.countAlivePlayers();
    let banner = '';
    let subBanner = '';

    switch (this.phase) {
      case 'lobby':
        if (this.players.size < MIN_PLAYERS) {
          banner = 'WAITING FOR PLAYERS';
          subBanner = `${this.players.size}/${MIN_PLAYERS} needed · scan to join`;
        } else {
          banner = this.game.name;
          subBanner = 'Pick a game on your phone to start';
        }
        break;
      case 'countdown': {
        const second = Math.max(0, Math.ceil((COUNTDOWN_MS - this.phaseMs) / 1000));
        banner = second > 0 ? String(second) : 'GO!';
        subBanner = this.game.lose;
        break;
      }
      case 'playing':
        break;
      case 'round_over': {
        const winner = this.winnerSlot === null ? null : this.players.get(this.winnerSlot);
        banner = winner ? `${displayName(winner.name, winner.slot)} WINS` : 'DRAW';
        subBanner = 'Next round starting…';
        break;
      }
    }

    this.opts.onHud({
      phase: this.phase,
      gameName: this.game.name,
      gameLose: this.game.lose,
      banner,
      subBanner,
      elapsed: this.roundMs / 1000,
      aliveCount: alive,
      standings: this.standings(),
    });
  }

  /**
   * What each phone shows. Lobby and UI only — a banner, and whether the
   * controls are live. No positions, no velocities, nothing simulated.
   */
  private pushPhones(): void {
    for (const player of this.players.values()) {
      // CPUs have no phone to talk to.
      if (player.cpu) continue;
      const alive = player.fighter.alive;
      let title = '';
      let detail = '';
      let secondsLeft: number | undefined;

      switch (this.phase) {
        case 'lobby':
          title = this.players.size < MIN_PLAYERS ? 'Waiting' : 'Ready';
          detail =
            this.players.size < MIN_PLAYERS
              ? 'Need one more player'
              : 'Pick a game to start';
          break;
        case 'countdown':
          title = 'Get ready';
          detail = this.game.lose;
          secondsLeft = Math.max(0, Math.ceil((COUNTDOWN_MS - this.phaseMs) / 1000));
          break;
        case 'playing':
          title = alive ? 'Fight!' : 'Knocked off';
          detail = alive ? 'A punch · B grab, again to throw · C jump' : 'Back next round';
          break;
        case 'round_over':
          title = this.winnerSlot === player.slot ? 'You win!' : 'Round over';
          detail = player.place > 0 ? `Placed #${player.place}` : 'Next round soon';
          break;
      }

      this.opts.onPhoneStatus({
        slot: player.slot,
        phase: this.phase,
        title,
        detail,
        youAlive: alive,
        ...(secondsLeft !== undefined ? { secondsLeft } : {}),
      });
    }
  }

  /* ------------------------------- teardown ------------------------------ */

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    for (const slot of [...this.players.keys()]) this.removePlayer(slot);
    this.effects?.dispose();
    this.arena?.dispose();
    this.engine?.dispose();
    this.engine = null;
  }
}
