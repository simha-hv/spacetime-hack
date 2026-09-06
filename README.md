# brawl-games

Phone as gamepad. The big screen runs the game; players scan a QR code, open a
web page, and their phone becomes a wireless controller. No app install.

**Milestone 1:** scan a QR, join, move a coloured shape with a thumbstick,
buttons, four players joining and leaving at any moment, name and colour.

**Milestone 2 — three brawlers.** Plush animals rendered in three.js with
Rapier3D active ragdolls, sharing one cast and one control scheme across three
games that differ in how you win: knock people off a **rooftop**, feed them to a
**conveyor**, or take their health bar in a walled **pit**. Players pick the game
from their phone in the lobby and it starts. Fill empty seats with CPU brawlers.

## The architecture constraint

This is **not multiplayer netcode. It is a wireless gamepad.**

The host is 100% authoritative and runs the only simulation. Phones send input
snapshots and receive lobby/UI state — never game state. There is no state sync,
no prediction, no rollback, and there should never be. If you find yourself
adding any of those, the design has gone wrong.

The relay server does not understand the game. Its entire involvement in the
input path is prepending one slot byte for routing.

---

## Run it

```bash
npm install
npm run dev
```

One command starts everything — there is only one process, because there is only
one port. Node 20+ is required; a copy is vendored at `.node/` (see
[Node](#node)).

| | URL |
|---|---|
| Host screen | <https://bsa-demo.dev.hyperverge.co/brawl-games/> |
| Phones | scan the QR, or `…/brawl-games/j/<CODE>` |
| LAN direct | `http://<lan-ip>:1099/brawl-games/` |
| Health | `…/brawl-games/healthz` |

The server binds `0.0.0.0`, never localhost-only, and prints its reachable
addresses on startup.

Other scripts: `npm run build` (production, enforces the controller size
budget), `npm test`, `npm run typecheck`, `npm start` (serve a built tree).

### Node

The box's system Node is v12 with no npm, which cannot build or run this. Rather
than touch it — other services on this host use it — Node 20.18.1 is vendored
into `.node/`, scoped entirely to this folder:

```bash
export PATH="$PWD/.node/bin:$PATH"   # then npm/node work as normal
```

Nothing outside `brawl-games/` is modified and no `sudo` is involved. `.node/`
is gitignored; to recreate it:

```bash
curl -sL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz \
  | tar -xJ --strip-components=1 -C .node
```

---

## Testing with a real phone

1. `npm run dev` on this box.
2. Open <https://bsa-demo.dev.hyperverge.co/brawl-games/> on the big screen.
3. Point a phone camera at the QR. Tap the notification. You are playing.

Because the join URL is a **public HTTPS address**, phones do not need to be on
the same network as the host — cellular works, guest wifi works, a colleague in
another building works. That also sidesteps the guest-wifi client-isolation
problem that will break WebRTC later.

**What to actually check**

- **Multi-touch.** Thumb on the stick, other thumb on A and B. The stick must
  not jump when the button thumb lifts. (Touches are tracked by
  `touch.identifier`, never by index.)
- **Pull-to-refresh.** Swipe down hard during play. The page must not reload.
- **Reconnect — the big one.** While playing, background Safari (home gesture),
  wait ~10s, come back. You must return as the *same* colour in the *same*
  slot, not as a new player. Try it having also locked the screen.
- **Buttons under packet loss.** Tap A very fast. Every tap must flash, even
  taps that begin and end between two 30Hz snapshots.
- **Join/leave churn.** Have someone join and leave repeatedly while others
  play. Nobody else should be disturbed.
- **Colour contention.** Two people open the picker and tap the same swatch at
  once. Exactly one gets it; the other sees "Someone just took that colour" and
  keeps the colour they had. A colour someone else holds shows struck through.
- **Identity across a reconnect.** Set a name, background Safari, come back.
  Name and colour must both still be yours.
- **Wake lock.** Leave a controller untouched for a few minutes; the screen
  should stay awake.
- **The game itself.** A punches, B grabs and B again throws. A hit should
  visibly launch and tip the victim, not merely nudge them. You should *not* be
  able to walk off the edge — only be knocked off.
- **Joining mid-round.** You should spectate until the next round rather than
  appearing in the middle of a live one.

### HTTPS and wake lock

`navigator.wakeLock.request('screen')` requires a **secure context**. Safari
gives you no error — the API is simply absent, and phones dim mid-match.

Through nginx you already have real HTTPS, so **wake lock works with no
workaround** on the normal URL above. Use it for anything you actually care
about.

The workaround only matters if you test over plain HTTP on a LAN IP
(`http://172.31.x.x:1099/…`), where the API is absent. Options, best first:

1. **Use the HTTPS URL.** Already available. This is the answer.
2. **Port-forward to the phone over USB** so the origin becomes `localhost`,
   which browsers treat as secure. Android: `adb reverse tcp:1099 tcp:1099`.
3. **Self-signed cert**, if you need LAN-only HTTPS with no internet:
   ```bash
   mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
     -keyout certs/key.pem -out certs/cert.pem -subj "/CN=$(hostname -I | awk '{print $1}')"
   ```
   iOS additionally requires the CA to be installed *and* manually trusted under
   Settings → General → About → Certificate Trust Settings. This is slow and
   annoying, which is why option 1 exists.

Wake lock is also released whenever the page is backgrounded, so it is
re-acquired on `visibilitychange` and on `pageshow` — acquiring once at startup
is not enough.

---

## Message protocol

Two channels, split by what they need from the network. **This split is the
point.**

| | Control channel | Input channel |
|---|---|---|
| Carries | join, slot/colour, roster, tokens, RTC signaling | 5-byte input snapshots |
| Needs | reliable, ordered | unreliable, latest-wins, droppable |
| Transport | **WebSocket, permanently** | WS now → WebRTC later, **WS stays as fallback** |

Today both ride one socket: **text frames are control, binary frames are input.**

### Input datagram — 5 bytes, little-endian

```
byte 0    seq      u8    wraps 0..255
byte 1    axisX    i8    -127..127
byte 2    axisY    i8    -127..127   (+Y = down, screen coords)
byte 3-4  buttons  u16   LE — eight 2-bit rolling press counters
```

Server → host prepends one routing byte: `[slot:u8][seq][ax][ay][btn:u16]`, 6
bytes. That prefix is the only thing the server does to the input path.

The controller samples its own state at a fixed **30Hz** and sends one snapshot
per tick. It does **not** send per `touchmove` — event-driven sending produces
60–120 msg/s from a fast finger and nothing from a still one, which is the worst
possible traffic shape for congested venue wifi.

### `buttons` — 2-bit rolling press counters, not booleans

```
bits 0-1    A press counter (mod 4)   punch
bits 2-3    B press counter (mod 4)   grab / throw
bits 4-5    C press counter (mod 4)   jump
bits 6-15   reserved (five more buttons)
```

Each counter increments on **press** and never on release. The host recovers
presses with `(current - last) & 0b11`.

This is required, not stylistic. With an unreliable transport a tap can be
pressed *and* released between two delivered snapshots — a boolean "is held" bit
reads `false` in both frames and the tap vanishes entirely. A counter that moved
from 1 to 2 proves the press happened even though no frame ever saw the finger
down. Do not "fix" this with a separate reliable channel.

Two consequences worth knowing:

- **Dropping a stale frame never loses a press.** Counters are monotonic mod 4,
  so the newest accepted frame already accounts for every press in the frames
  that were skipped. Always diff against the last *accepted* value, never the
  last *received* one.
- **Aliasing:** 4+ presses between two accepted frames alias to `n mod 4`. That
  is four taps inside 33ms, which no thumb can do. Bounded and accepted.

### Sequence numbers and staleness

Latest-wins. A frame is newer if its forward distance is under half the sequence
space, which handles `u8` wraparound in both directions:

```js
const forward = (seq - last) & 0xff;
const isNewer = forward !== 0 && forward < 128;   // 250 → 3 is newer; 3 → 250 is stale
```

### Control messages (JSON text)

| Direction | Message |
|---|---|
| host → server | `host_hello {resume?}` |
| server → host | `host_welcome {code, hostToken, joinUrl, tickHz, players}` |
| server → host | `player_join {slot, color, colorName, resumed}` · `player_stale {slot}` · `player_leave {slot, reason}` · `roster {players}` |
| server → host | `player_profile {slot, color, colorName, name}` |
| phone → server | `join {code, token?}` · `set_profile {name?, color?}` |
| server → phone | `joined {slot, color, colorName, name, token, resumed, tickHz, code, taken}` · `join_error {reason}` · `profile {color, colorName, name, error?}` · `lobby {slot, color, colorName, playerCount, taken}` · `host_gone` |
| both | `ping {ts}` / `pong {ts}` |
| reserved | `rtc_offer` · `rtc_answer` · `rtc_ice` — relayed blindly, never parsed |

`lobby` is the **only** state a phone ever receives. No positions, no scores —
just occupancy and which colours are spoken for.

---

## Player identity

**Join first, customise after.** A player who scans is in the game immediately
with an auto-assigned colour. Name and colour are chosen from a sheet they open
*while already playing*, and can be changed mid-match. Nothing about identity is
on the critical path to playing, so scan-to-playing stays where it was.

- **Name** — up to 12 characters, `''` means unset and the host shows `P1`..`P4`.
  Sanitized on the server; the phone only previews.
- **Colour** — 8 in the palette for 4 players, so there is a real choice.
  **Exclusive within a room**: two identical shapes are unplayable. The server
  arbitrates, so two people tapping the same swatch at the same instant get one
  winner and one `color_taken`. A colour held by a player inside their 45s
  grace window stays reserved.

Changes are **never applied optimistically.** The phone shows what the server
confirmed, because a colour race would otherwise read as "mine" on both phones
and then flicker back on one. This is UI, not the stick — a 30ms round trip is
imperceptible here, and the zero-delay rule applies to the thumb, not to a
settings sheet.

The name persists in `localStorage` across rooms, so a returning player keeps
their identity. Colour does not: which colours are free depends on who else is
in the room.

### On name filtering

The blocklist matches **whole words only, never substrings.** This is the
Scunthorpe problem and it is not hypothetical for this deployment: *Harshit*,
*Rishit* and *Ashit* are ordinary Indian given names containing "shit", and
Dickson, Hancock and Cunliffe are ordinary surnames. Refusing to let someone
type their own name is a worse failure than letting `xxsh1txx` through, and
anyone determined to get an obscenity on screen will manage it regardless.
Spaced-out and punctuated evasions (`F U C K`, `s.h.i.t`) are still caught by
checking the whole name reduced to letters.

Sanitization keeps `\p{M}` (combining marks) alongside `\p{L}`. Dropping marks
turns *प्रिया* into *परय* — it silently destroys Devanagari, Tamil, Arabic and
Thai names.

### Timings

| | |
|---|---|
| Input tick | 30Hz |
| Host zeroes a slot's axes after | 500 ms of silence |
| Keepalive ping | 5 s (also stops the AWS ALB's 60s idle reap) |
| **Slot grace after disconnect** | **45 s** |
| Room dies after host loss | 60 s |
| Idle room reaped | 10 min |

---

## The transport seam

Everything input-shaped goes through one interface, implemented by both ends:

```ts
interface GamepadTransport {
  connect(): Promise<void>;
  sendInput(snapshot: Uint8Array): void;                      // fire-and-forget, MAY drop
  onInput(cb: (peer: PeerId, snapshot: Uint8Array) => void): void;
  onDisconnect(cb: (peer: PeerId, reason: DisconnectReason) => void): void;
  close(): void;
}
```

It is symmetric on purpose, so a single `RTCPeerConnection` wrapper can serve
host and controller alike. A controller never fires `onInput`; a host never
calls `sendInput`.

**To add WebRTC later:** write `RtcInputTransport implements GamepadTransport`,
using the already-reserved `rtc_offer`/`rtc_answer`/`rtc_ice` control messages
for signaling over the existing WebSocket. Swap it in where
`HostWsTransport` / `ControllerWsTransport` are constructed. Nothing in the
stick, button, ticker, input-state or scene code changes — they only ever touch
`sendInput`. Keep the WebSocket implementation: WebRTC fails on guest wifi with
client isolation and on cellular without TURN, so it is a permanent fallback,
selected per-player at runtime.

One WebSocket-specific detail that matters for feel: `sendBinary` **drops**
datagrams when `socket.bufferedAmount` exceeds 512 bytes. TCP will otherwise
queue every snapshot behind a head-of-line block and deliver two seconds of
stale input in a burst, rubber-banding the character through a replay of where
the thumb used to be. Dropping is correct — each snapshot is a complete state,
so the next one supersedes anything discarded.

---

## The games

Three games, one cast, one control scheme. They differ in the only thing that
actually changes how a brawler plays: **how you win.**

| | win condition | the level |
|---|---|---|
| **KNOCKOUT** | position — put them over an edge | a rooftop with gaps in the parapet |
| **GRINDER** | the level does it for you | two conveyors running in opposite directions, over a pit |
| **THE PIT** | damage — take their health bar | a walled circle with nowhere to fall |

Everything above the `Arena` seam — fighters, camera, HUD, phones, CPUs — is
shared. That is deliberate: someone who arrives halfway through the evening
learns the controls once and every game is immediately playable.

**GRINDER** is the one that needed the most care. The two belts run in
*opposite* directions, which is the whole design: standing on the wrong belt
drags you toward the pit while an opponent two metres away is being carried to
safety. You fight the floor as much as each other, and a grab becomes far
stronger than a punch — carry someone two metres sideways and the level finishes
them. Swinging press arms sweep on a slow cycle so there is a rhythm to learn
rather than a constant grind.

Two things about the belts that were not obvious. They are ordinary static
colliders driven by an impulse rather than kinematic surfaces — cheaper, more
stable, and it lets a player *fight* the belt instead of being locked to it. And
the belt surface is deliberately slick: the first version drove at 8 m/s² against
a 0.6-friction floor under 22.5 gravity, which is 8 against 13.5, so a player
standing on a "moving" belt simply did not move at all.

**THE PIT** is round rather than rectangular on purpose. A rectangle has corners
to be trapped in, and being cornered with no escape *and* no ring-out is just
losing slowly. A circle means there is always somewhere to go, so a losing
player is always one good read from turning it around. Its wall is a ring of
boxes, not a cylinder collider — Rapier's cylinder is solid, so a body would be
trapped *inside* it rather than contained by it.

### Picking one

The lobby **is** the picker. Every phone lists the games; tap one and it starts.

No vote, no majority, no separate "ready" step. Making four people agree before
anything can happen is how a party game dies — whoever is keenest decides, and
tapping the game that is already selected is how you start it.

The catalogue comes from the host, not the controller. The controller is a
static file a phone may have cached for a week, and one that decides for itself
what the games are will cheerfully offer one the big screen has never heard of.
An unrecognised id falls back to a real game rather than leaving the host
without an arena.

### KNOCKOUT

Four plush animals on a rooftop. Punch, grab and throw each other through the
gaps in the parapet. Last one on the roof wins.

#### Two design mistakes this replaced

**SPIN OUT** had four players *independently* dodging a spinning bar. Nobody had
any reason to look at anyone else. The environment was the opponent, and it was
not fun.

The fix for that was right — make the other players the game — but the arena
that came with it was **the same flat disc in different colours**, and a flat
disc is the SPIN OUT layout whatever you put on it. A Party Animals level is
somewhere: props to trip over, ledges at different heights, and specific places
you can be thrown off. So:

**ROOFTOP.** A rectangular roof with a raised deck at one end, two fixed AC
units to break a charge, five loose crates that are real dynamic bodies, and a
parapet around the edge with **two deliberate gaps**.

The gaps are the entire design. With an open edge everyone strolls off in two
seconds and nobody ever fights; with a wall all the way round nobody can ever be
eliminated. Gaps make the fight *directional* — you manoeuvre people toward a
specific side of the roof.

### Controls

Stick to move, **A** punch, **B** grab (press again to throw), **C** jump.

C is new; A and B are unchanged. The wire format did not move a byte — the
`buttons` u16 always carried eight counters and only two were spoken for.

**The pad has to be legible before anyone touches it.** Three things that were
not, and now are:

- *The stick is drawn at rest.* It used to be a faint dashed ring that only
  became a real stick once you were already dragging — the thing you needed to
  understand only appeared after you had understood it. There is now a solid
  base and knob parked at a home position with a `MOVE` label. The floating
  origin is kept, because that is what actually feels good: the base slides to
  your thumb on contact (with the CSS transition killed, so the knob never lags
  the finger) and eases home on release.
- *The buttons say what they do.* `A PUNCH`, `B GRAB`, `C JUMP`. There is no
  console convention to lean on when someone opened the page thirty seconds
  ago; the letter stays only because the big screen refers to it.
- *One line of instructions, once.* A prompt appears the moment the phone is in
  a room and comes down a few seconds into the first round the player is
  actually alive for, then never again. It deliberately stays up for someone
  who joined mid-round and is sitting out as a spectator — that is the person
  with nothing to do but read.

### Up must not mean down

The single worst gamepad bug there is, and it shipped: pushing up on the stick
walked the player *down* the screen.

Four sign conventions meet in one expression. The controller reports **screen**
coordinates, where +Y is down, so a thumb pushed up sends `axisY = -1`. The
camera sits at +Z looking toward −Z, so "away from the viewer", up the screen,
is −Z. Both already point the same way, and the mapping is the **identity** —
but it reads like it needs a flip, and the first version obligingly wrote one.

It now lives alone in `game/controls.ts` with the derivation written out and
three tests, one of which walks a real body under real physics and asserts its
`z` decreased.

### Active ragdoll

There is no "knocked down" state. Rotation is **free**, and the body is held
upright by a PD torque that is constantly straining against gravity and
momentum. A hard enough hit simply overwhelms it. The wobble, the stagger and
the scramble back to standing are the physics, not an animation.

Two things here were expensive to learn and are worth not re-deriving:

- **The righting axis is `cross(up, worldUp)` = `(-up.z, 0, up.x)`.** The
  opposite sign drives the body *away* from vertical and parks it on its head,
  chattering. It does not look like a flipped vector; it looks like a stuck
  ragdoll, which is why it survived a first misdiagnosis.
- **Rapier emits no contact events unless a collider opts in** with
  `ActiveEvents.CONTACT_FORCE_EVENTS`. Without that flag the entire knockdown
  path is silently dead code.

Both have regression tests that run the real physics.

### Feel

- **Movement is clamped acceleration, never a velocity assignment.** Assigning
  velocity from the stick each frame erases any impulse on the very next frame
  and makes every punch weightless.
- **Grabs are a damped spring, not a joint.** A joint between two actively
  controlled bodies fights itself and explodes; a spring degrades gracefully and
  still lets the victim struggle.
- **Gravity is −22.5**, well above earth. Earth gravity on a two-metre character
  makes every jump and fall feel floaty; heavier gravity with bigger impulses is
  the standard platformer trade and reads as snappy.
- **Juice.** Procedural Web Audio (punch, whiff, grab, throw, land, fall,
  countdown, fanfare — no asset files), hit-stop that freezes the simulation
  35–110ms on a connect while rendering continues, and camera shake.

### Making a hit read

A landed punch used to produce audio, a freeze and a shake — all of which say
*something happened* and none of which say **where**, or **to whom**. From
across a room you could not tell a connect from a whiff.

- **Every hit draws itself at the contact point:** a warm additive bloom with a
  comic starburst punched out on top. The star is a filled polygon with a heavy
  dark outline, not a soft shockwave ring — the first version was additive white
  and vanished completely against a bright yellow animal, which is the worst
  possible behaviour for the one element whose entire job is to be seen. It is
  capped near one character-height so it never hides who got hit, holds full
  opacity for the first third of its life (fading from frame one means it is
  never actually seen at full strength), and ignores depth, because a hit behind
  a crate is still a hit you need to see.
- **The punch has a real windup.** 60ms of anticipation is below the threshold
  where an animation registers at all; the arm was retracting before anyone saw
  it move. The body now winds the *opposite* way for 95ms, then snaps out at
  roughly twice the blend rate. The asymmetry is what reads as force.
- **It steps into the swing** — a forward impulse on the puncher at windup, so
  the whole body commits rather than twitching an arm.
- **Not turned up further than that.** At an impulse of 13.5 a single clean hit
  sent people straight off a 13-metre roof and rounds ended in three seconds,
  which is its own kind of unreadable. It sits at 11.5: enough to carry you
  several metres, not enough to end the round on contact.

Effects are pooled and pre-allocated — impacts arrive in bursts of four when a
pile-up goes off, and allocating a texture mid-frame is how you get a stutter on
the one frame everybody is looking hardest at. They also keep animating *during*
hit-stop: the freeze is meant to hold the bodies still so you can see the
impact, not freeze the impact itself.

`/brawl-games/proto/cast.html?fx=1` fires bursts on the real cast on a timer.
A 340ms effect that only happens on a connect is nearly impossible to catch in a
screenshot of a live match, so it was going unreviewed.

### The look

Three.js and Rapier3D, back after a canvas-2D detour that could not get there.

Party Animals' own description of its art is *"simple textures, plump physiques,
vivid colour schemes"*, and the silhouette is the whole trick: the head is
enormous and wider than the body, the body is one small rounded bean, and the
limbs are short, thick and **splayed**.

That last point is not cosmetic. The first pass built the torso from a capsule
with the arms hanging flat against it, and at gameplay distance the overlapping
silhouettes read as one ribbed tube — the characters looked like caterpillars.
Splaying the limbs and shrinking the torso is what turns the same primitives
into a plush toy. No texture maps anywhere; high roughness under a warm key and
a cool hemisphere fill is what reads as felt.

Six species — pup, kit, bun, cub, quack, tusk — share one rig and differ only
above the neck plus a tail. Everything above the neck lives in **unit-head
space**, so changing one radius rescales every face consistently.

`/brawl-games/proto/cast.html` renders the whole cast close up under the game's
own lights (`?pose=idle|run|punch|reach|flail`, `?view=front|side|back`). It
imports the game's real `animal.ts`, compiled at build time — a character review
page showing last week's proportions is worse than none.

### The camera

It frames whoever is still alive, and the fit is **exact rather than a bounding
box against the FOV**. The pitch is fixed, so a point's camera-space offsets do
not depend on distance at all — only its depth does, and linearly — which makes
the distance each point needs closed-form:

```
x' = p.x − look.x
y' = cos(pitch)·dy − sin(pitch)·dz
depth = d − (sin(pitch)·dy + cos(pitch)·dz)
```

Fitting a world-space box instead silently ignores perspective: the near player
subtends far more of the frame than the far one, and gets cropped off the bottom
of the screen while the maths insists everything fits.

Two more rules that each fixed a visible bug. The box is grown upward by a body
height plus name tag, because the solver is fed positions and those sit at the
feet. And a player who is already **below the roof does not get a vote**: they
are alive for another second while they fall, and letting them drag the box down
yanks the camera twenty metres out from the fight still happening on the roof.

That second rule governs the name tags too, for the same reason. Tags ignore
depth so they draw through the building, and a punch can throw a body twenty
metres clear of the roof — so a label was left hovering over the arena with
nothing underneath it, which reads as a character that simply vanished. Below
the roof, the tag comes down with you.

### Efficiency

Geometry is shared across the whole cast, so four players cost four materials
and no extra buffers. One directional light with a single 1024 shadow map sized
to the arena — not the world, or the contact shadows under the feet dissolve —
plus one hemisphere fill. No post-processing, no environment map. Name tags are
one 256×64 canvas texture each, repainted only when the name changes. The
standings DOM rebuilds only when its content changes.

Physics is a fixed 60Hz accumulator with bounded catch-up (five steps, then drop
the remainder) so a slow frame cannot spiral. Rendering interpolates between
steps, so a 120Hz display does not judder.

**The cost:** the host's lazy chunk is ~1.2MB gzipped, and 79% of that is the
Rapier WASM, which `rapier3d-compat` inlines as base64. It loads *after* the QR
paints, once, on a machine plugged into a TV — the 100KB budget that matters is
the controller's, and that is at 30%. Switching to the non-compat build would
roughly halve it; it has not been worth the build plumbing yet.


## Layout

```
packages/
  protocol/     shared; the wire format lives here and nowhere else
    input.ts        encode/decode, isNewerSeq, press-counter diffing
    control.ts      JSON control messages
    transport.ts    GamepadTransport
    ws-link.ts      one socket, both channels (browser only)
  server/       node + ws. rooms in memory, no database
    rooms.ts        codes, slots, colours, tokens, expiry sweeper
    relay.ts        connection handling; the input fast path
  host/         big screen — vanilla TS, three.js + Rapier3D
    input-state.ts  latest-wins axes, accumulate-and-drain presses
    game/
      engine.ts       renderer, lights and the physics world
      animal.ts       the rigged cast, poses, pose blending
      arena.ts        the level seam + shared build/dispose plumbing
      games.ts        the catalogue: arena + win condition + tuning
      levels/
        rooftop.ts      KNOCKOUT: deck, parapet gaps, props, facade
        grinder.ts      GRINDER: opposed conveyors, presses, the pit
        dojo.ts         THE PIT: walled circle, no way out
      fighter.ts      active-ragdoll body: upright PD, punch, grab, throw
      cpu.ts          the bot brain: same FighterInput a phone sends
      controls.ts     stick -> world movement, and why it is the identity
      effects.ts      pooled impact bursts
      camera.ts       exact-fit chase framing
      nametag.ts      floating labels, one canvas texture each
      match.ts        phases, elimination, per-phone UI
      audio.ts        procedural Web Audio SFX
      juice.ts        hit-stop and camera shake
      hud.ts          banner, clock, standings
      index.ts        the node-safe surface the physics tests bundle
  controller/   phone — vanilla, no framework, ships as ONE html file
    stick.ts        thumbstick: visible at rest, floating origin in use
    buttons.ts      the rolling press counters
    ticker.ts       the fixed 30Hz sampler
    wakelock.ts     acquire + re-acquire on visibilitychange
tools/          build.mjs, dev.mjs
```

### Controller size budget

The controller ships as **one self-contained HTML file** — no external CSS, JS,
fonts, or favicon. One request, one document, gzipped at build time. It has to
load over congested venue wifi while ten people scan at once.

Currently **29.7KB raw / 9.7KB gzipped**, against a 100KB budget that
`npm run build` enforces as a hard failure. (`npm run dev` builds unminified
with inline sourcemaps and is several times larger; the budget applies to what
ships.)

---

## Configuration

| Env | Default | |
|---|---|---|
| `PORT` | `1099` | must match the nginx `proxy_pass` |
| `BIND_HOST` | `0.0.0.0` | do not set to localhost; phones need to reach it |
| `PUBLIC_ORIGIN` | inferred | absolute origin for the QR's join URL |
| `PUBLIC_DIR` | `dist/server/public` | |
| `QUIET` | | `1` silences logs |

### nginx

```nginx
location /brawl-games/ {
    proxy_pass http://localhost:1099;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    ...
}
```

`proxy_pass` has no URI part, so the `/brawl-games/` prefix is forwarded intact
and the app serves everything under that base path.

Origin inference for the join URL, in order: `PUBLIC_ORIGIN` → the
`X-Forwarded-Proto` header → a real domain name in `Host` implies HTTPS (that
vhost is TLS-only) while a bare IP implies HTTP. The nginx block does not
currently set `X-Forwarded-Proto`, which is why the third rule exists. Adding
`proxy_set_header X-Forwarded-Proto $scheme;` would make it exact.

---

## Known bounds

- Four players. Slots are handed out lowest-first; colours are auto-assigned
  from the palette in order, then freely changed.
- A slot inside its 45s grace window counts as **occupied** — a new player
  cannot take the seat of someone 20 seconds into reading a text. That is
  deliberate; it is what the grace window is for.
- The player token is written to both `sessionStorage` (primary, per-tab) and
  `localStorage` (fallback read). sessionStorage alone loses the slot when a
  re-scan opens a *new tab*, which is common. Both writes happen once at join,
  so there is no per-frame cost.
- `navigator.vibrate()` is a no-op on iOS and is not used anywhere. Do not build
  feel around haptics.
- There is no Fullscreen API on iPhone, so the layout is designed around the
  Safari URL bar remaining visible (`--url-bar` in the controller CSS).
- Rooms are in memory. Restarting the server ends every game.
