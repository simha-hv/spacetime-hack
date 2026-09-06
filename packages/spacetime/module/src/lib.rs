//! Room and player registry as a SpacetimeDB module.
//!
//! This is a port of the state currently held in memory by `RoomRegistry`
//! (`packages/server/src/rooms.ts`). It is NOT wired into the running server —
//! the TypeScript registry remains authoritative. See `../README.md` for the
//! status and the migration plan.
//!
//! The schema deliberately mirrors the TypeScript types field for field, so the
//! eventual swap is a transport change rather than a redesign.

use spacetimedb::{rand::Rng, reducer, table, Identity, ReducerContext, Table, Timestamp};

/* ------------------------------- constants -------------------------------
 * Mirrored from packages/protocol/src/constants.ts and profile.ts. These are
 * duplicated rather than shared because a WASM module cannot import the TS
 * package; keeping them adjacent to the schema is the tradeoff. If they drift,
 * the TS copy wins — it is what actually runs today.
 */

const MAX_PLAYERS: u8 = 4;
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 4;
const NAME_MAX_LENGTH: usize = 12;

const SLOT_GRACE_MICROS: i64 = 45_000_000;
const HOST_GRACE_MICROS: i64 = 60_000_000;
const IDLE_ROOM_MICROS: i64 = 600_000_000;

/// (hex, spoken name). Auto-assignment walks this in order, so the first four
/// joiners still get red/blue/green/yellow.
const PALETTE: [(&str, &str); 8] = [
    ("#ff4d4d", "RED"),
    ("#3d7dff", "BLUE"),
    ("#3ddc84", "GREEN"),
    ("#ffd23d", "YELLOW"),
    ("#b06dff", "PURPLE"),
    ("#ff8a3d", "ORANGE"),
    ("#35d6d6", "CYAN"),
    ("#ff6ec7", "PINK"),
];

/* --------------------------------- tables --------------------------------- */

#[table(accessor = room, public)]
pub struct Room {
    #[primary_key]
    pub code: String,
    pub host: Identity,
    pub created_at: Timestamp,
    pub last_activity_at: Timestamp,
    /// `None` while the host is connected.
    pub host_disconnected_at: Option<Timestamp>,
}

#[table(accessor = player, public)]
#[derive(Clone)]
pub struct Player {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_code: String,
    pub slot: u8,
    /// Chosen, not derived from the slot. Held exclusively within a room.
    pub color: String,
    pub color_name: String,
    /// Sanitized; empty means "no name set" and the host falls back to P1..P4.
    pub name: String,
    /// Replaces the random reclaim token in the TS registry: SpacetimeDB already
    /// gives every connection a stable identity, so "same phone comes back" is
    /// an identity lookup rather than a secret the client has to store.
    pub identity: Identity,
    /// `None` while connected.
    pub disconnected_at: Option<Timestamp>,
}

/* -------------------------------- helpers --------------------------------- */

fn micros(ts: Timestamp) -> i64 {
    ts.to_micros_since_unix_epoch()
}

fn touch(ctx: &ReducerContext, mut room: Room) {
    room.last_activity_at = ctx.timestamp;
    ctx.db.room().code().update(room);
}

fn members(ctx: &ReducerContext, code: &str) -> Vec<Player> {
    ctx.db.player().room_code().filter(code).collect()
}

fn allocate_code(ctx: &ReducerContext) -> Result<String, String> {
    let mut rng = ctx.rng();
    // 32^4 is about a million codes; with a handful of live rooms a collision is
    // vanishingly rare, but retry anyway.
    for _ in 0..200 {
        let code: String = (0..CODE_LENGTH)
            .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
            .collect();
        // TODO(port): CODE_BLACKLIST from rooms.ts must come across before this
        // module ever hands a code to a real screen.
        if ctx.db.room().code().find(&code).is_none() {
            return Ok(code);
        }
    }
    Err("could not allocate a room code".into())
}

/// Placeholder for `sanitizeName` in packages/protocol/src/profile.ts.
///
/// The TS version is Unicode-aware (it preserves Devanagari matras, ZWJ/ZWNJ and
/// other combining marks) and applies a whole-word blocklist. Reproducing that
/// faithfully in Rust is its own task; this only trims and truncates, so it MUST
/// NOT be treated as equivalent until ported.
fn sanitize_name(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
        .chars()
        .take(NAME_MAX_LENGTH)
        .collect()
}

/* -------------------------------- reducers -------------------------------- */

#[reducer]
pub fn create_room(ctx: &ReducerContext) -> Result<(), String> {
    let code = allocate_code(ctx)?;
    ctx.db.room().insert(Room {
        code,
        host: ctx.sender(),
        created_at: ctx.timestamp,
        last_activity_at: ctx.timestamp,
        host_disconnected_at: None,
    });
    Ok(())
}

#[reducer]
pub fn join_room(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(&code)
        .ok_or_else(|| format!("no room {code}"))?;

    let held = members(ctx, &code);

    // Reclaim first: a returning phone keeps its slot and colour. This is the
    // whole reason the grace window exists.
    if let Some(mut existing) = held.iter().find(|p| p.identity == ctx.sender()).cloned() {
        existing.disconnected_at = None;
        ctx.db.player().id().update(existing);
        touch(ctx, room);
        return Ok(());
    }

    // Slots inside a grace window still count as occupied, so a new joiner
    // cannot steal the slot of someone 20 seconds into reading a text message.
    let slot = (0..MAX_PLAYERS)
        .find(|s| !held.iter().any(|p| p.slot == *s))
        .ok_or("room is full")?;

    let (hex, color_name) = PALETTE
        .iter()
        .find(|(hex, _)| !held.iter().any(|p| p.color.eq_ignore_ascii_case(hex)))
        .copied()
        // Unreachable while PALETTE is larger than MAX_PLAYERS, and a duplicate
        // colour beats refusing to let someone play.
        .unwrap_or(PALETTE[0]);

    ctx.db.player().insert(Player {
        id: 0,
        room_code: code,
        slot,
        color: hex.to_string(),
        color_name: color_name.to_string(),
        name: String::new(),
        identity: ctx.sender(),
        disconnected_at: None,
    });

    touch(ctx, room);
    Ok(())
}

/// Set name and/or colour. The module is authoritative on both.
///
/// Note for the integration: the TS version applies these fields independently,
/// so a request that sets a name and a contested colour still lands the name.
/// A reducer that returns `Err` rolls the whole transaction back, which would
/// discard the name too — so a rejected field is skipped in place rather than
/// raised. Reporting *which* field was rejected needs either a per-player status
/// column or a separate error table; that decision belongs with the wiring.
#[reducer]
pub fn set_profile(
    ctx: &ReducerContext,
    code: String,
    name: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(&code)
        .ok_or_else(|| format!("no room {code}"))?;

    let held = members(ctx, &code);
    let mut me = held
        .iter()
        .find(|p| p.identity == ctx.sender())
        .cloned()
        .ok_or("not in this room")?;

    if let Some(raw) = name {
        me.name = sanitize_name(&raw);
    }

    if let Some(wanted) = color {
        if let Some((hex, color_name)) = PALETTE
            .iter()
            .find(|(hex, _)| hex.eq_ignore_ascii_case(&wanted))
            .copied()
        {
            // Exclusive within the room: two identical circles are unplayable.
            let taken = held
                .iter()
                .any(|p| p.id != me.id && p.color.eq_ignore_ascii_case(hex));
            if !taken {
                me.color = hex.to_string();
                me.color_name = color_name.to_string();
            }
        }
    }

    ctx.db.player().id().update(me);
    touch(ctx, room);
    Ok(())
}

#[reducer]
pub fn leave_room(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let room = ctx
        .db
        .room()
        .code()
        .find(&code)
        .ok_or_else(|| format!("no room {code}"))?;

    if let Some(me) = members(ctx, &code)
        .into_iter()
        .find(|p| p.identity == ctx.sender())
    {
        ctx.db.player().id().delete(me.id);
    }

    touch(ctx, room);
    Ok(())
}

/// Start the grace window rather than dropping anyone immediately.
#[reducer(client_disconnected)]
pub fn identity_disconnected(ctx: &ReducerContext) {
    for mut p in ctx.db.player().iter().filter(|p| p.identity == ctx.sender()) {
        p.disconnected_at = Some(ctx.timestamp);
        ctx.db.player().id().update(p);
    }

    for mut r in ctx.db.room().iter().filter(|r| r.host == ctx.sender()) {
        r.host_disconnected_at = Some(ctx.timestamp);
        ctx.db.room().code().update(r);
    }
}

#[reducer(client_connected)]
pub fn identity_connected(ctx: &ReducerContext) {
    for mut p in ctx.db.player().iter().filter(|p| p.identity == ctx.sender()) {
        p.disconnected_at = None;
        ctx.db.player().id().update(p);
    }

    for mut r in ctx.db.room().iter().filter(|r| r.host == ctx.sender()) {
        r.host_disconnected_at = None;
        ctx.db.room().code().update(r);
    }
}

/// Expire stale slots and dead rooms.
///
/// Called explicitly for now. Wiring this to a `#[reducer(scheduled)]` table is
/// part of the integration, not of the schema.
#[reducer]
pub fn sweep(ctx: &ReducerContext) {
    let now = micros(ctx.timestamp);

    for r in ctx.db.room().iter() {
        let host_lost = r
            .host_disconnected_at
            .is_some_and(|t| now - micros(t) > HOST_GRACE_MICROS);
        let idle = now - micros(r.last_activity_at) > IDLE_ROOM_MICROS;

        if host_lost || idle {
            for p in members(ctx, &r.code) {
                ctx.db.player().id().delete(p.id);
            }
            ctx.db.room().code().delete(&r.code);
            continue;
        }

        for p in members(ctx, &r.code) {
            if p
                .disconnected_at
                .is_some_and(|t| now - micros(t) > SLOT_GRACE_MICROS)
            {
                ctx.db.player().id().delete(p.id);
            }
        }
    }
}
