# @brawl/spacetime

A [SpacetimeDB](https://github.com/clockworklabs/spacetimedb) module holding the
room and player registry for brawl-games.

## Status: scaffolding, not yet connected

Nothing in the running system imports this. `RoomRegistry` in
`packages/server/src/rooms.ts` is still the authoritative store, and the module
here has never been compiled or published to a SpacetimeDB instance — there is
no Rust toolchain or `spacetime` CLI in this environment yet.

It exists because the schema is the part worth designing first. `module/src/lib.rs`
mirrors the current `Room` and `Player` types field for field, so connecting it
later is a transport change rather than a redesign.

## Why this is the right seam

The registry is already the only long-lived server state: rooms keyed by a
four-character code, up to four players each, slots and colours held exclusively,
grace windows on disconnect, a periodic sweep. That is a database, currently
implemented as two `Map`s that die with the process. Moving it into SpacetimeDB
gets persistence across restarts and lets the host subscribe to roster changes
instead of the relay fanning them out by hand.

The game loop is deliberately *not* in scope. The host stays 100% authoritative
over simulation at 30Hz; pushing per-frame input through a database is the wrong
shape. Only lobby and identity state belongs here.

## What is already ported

| Behaviour | Source of truth | State |
| --- | --- | --- |
| Room create / lookup by code | `rooms.ts` `RoomRegistry` | mirrored |
| Lowest-free-slot assignment | `rooms.ts` `freeSlot` | mirrored |
| Palette walk for auto-colour | `rooms.ts` `freeColor` | mirrored |
| Exclusive colour within a room | `rooms.ts` `setProfile` | mirrored |
| Slot / host grace windows, sweep | `rooms.ts` `sweep` | mirrored |
| Reclaim after disconnect | `rooms.ts` `byToken` | **changed** — uses SpacetimeDB `Identity` instead of a client-held random token |
| `sanitizeName` | `profile.ts` | **stub** — trims and truncates only; the Unicode handling and the blocklist are not ported |
| Room code blacklist | `rooms.ts` `CODE_BLACKLIST` | **not ported** |

The last three are the blockers. The name stub in particular is not equivalent
to the TypeScript one: the real version preserves combining marks so Devanagari,
Arabic, Thai and Tamil names survive, and matches its blocklist on whole words to
avoid the Scunthorpe problem. Shipping the stub would mangle real players' names.

## Open questions for the integration

- **Partial profile updates.** The TS version applies name and colour
  independently, so a contested colour still lets the name through. A reducer
  returning `Err` rolls the whole transaction back, so `set_profile` currently
  skips a rejected field silently. Surfacing *which* field was rejected needs a
  status column or an error table.
- **Who connects.** Either the phones talk to SpacetimeDB directly (the relay
  stops carrying lobby traffic entirely) or the Node server stays the only
  client. The first is the idiomatic shape; the second is a smaller diff.
- **Sweep scheduling.** Currently an explicit reducer; wants a
  `#[reducer(scheduled)]` table.

## Building it (once a toolchain exists)

```sh
cargo install spacetimedb-cli
spacetime build --project-path packages/spacetime/module
spacetime publish --project-path packages/spacetime/module brawl-games
```
