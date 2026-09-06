import { DirectionCardinal, shuffle } from "../../common";
import { TarotCard, allCards } from "../../common/tarot";
import { GnosticaBoard, IEvicted } from "./board";
import { CellContents, cardPointValue } from "./cell";
import { Piece, Pips, Orientation } from "./piece";
import { PrimitiveOpts, MAJOR_ARCANA, MajorArcanaDef } from "./majorArcana";

// Per-size counts of pieces still in reserve (not on the board), indexed
// [small, medium, large]. There's no dedicated Stash class - it's a plain
// tuple, mutated in place by takeFromStash/returnToStash below.
export type Stash = [number, number, number];

export interface PowerContext {
    board: GnosticaBoard;
    currplayer: number;
    stashes: Map<number, Stash>;
    // Card uids. Mutated in place as cards move between piles - callers that
    // need to preserve the pre-call state should clone first.
    hand: string[];
    discardPile: string[];
    drawPile: string[];
}

// A legality-check failure: an i18next key suffix (apgames:validation.gnostica.<key>)
// plus whatever interpolation params that message needs. Every checkX
// function below returns `undefined` for "legal" or one of these for
// "illegal, and here's why" - the single source of truth both the
// non-mutating validator (gnostica.ts's validateX tree) and the real
// mutating functions here are built on, so the two can never drift out
// of sync with each other.
export interface PowerFailure {
    key: string;
    params?: Record<string, unknown>;
}

// Thrown only when a `trusted: true` caller skipped validation and the
// move turns out to be illegal anyway - never player-facing, so never
// routed through i18next/apgames.json. The message is a plain hardcoded
// string for whoever debugs the integration bug, not a translation key.
export class GnosticaRulesError extends Error {}

const cardByUid = (uid: string): TarotCard => {
    const found = allCards().find(c => c.uid === uid);
    if (found === undefined) {
        throw new GnosticaRulesError(`Unknown card uid "${uid}".`);
    }
    return found;
};

const takeFromPile = (pile: string[], uid: string): TarotCard => {
    const idx = pile.indexOf(uid);
    if (idx === -1) {
        throw new GnosticaRulesError(`Card "${uid}" is not in the expected pile.`);
    }
    pile.splice(idx, 1);
    return cardByUid(uid);
};

// Reshuffles the discard pile into the draw pile in place whenever the
// draw pile is empty. - mirrors cmdDraw's own
// reshuffle in gnostica.ts. Mutates the arrays in place (push/splice)
// rather than reassigning ctx.drawPile/ctx.discardPile, since those are
// the same array instances GnosticaGame's this.drawPile/this.discardPile
// point to - a reassignment here wouldn't be visible there. No-op if the
// draw pile isn't actually empty, or if there's nothing to reshuffle.
const reshuffle = (ctx: PowerContext): void => {
    if (ctx.drawPile.length > 0 || ctx.discardPile.length === 0) {
        return;
    }
    ctx.drawPile.push(...(shuffle(ctx.discardPile) as string[]));
    ctx.discardPile.length = 0;
};

const stashOf = (ctx: PowerContext, player: number): Stash => {
    const s = ctx.stashes.get(player);
    if (s === undefined) {
        throw new GnosticaRulesError(`No stash tracked for player ${player}.`);
    }
    return s;
};

// Exported: the engine also needs this directly for the base "place" turn
// action (your first piece comes from your own stash, same as every other
// piece that ever enters play).
export const takeFromStash = (ctx: PowerContext, player: number, size: Pips): void => {
    const s = stashOf(ctx, player);
    if (s[size - 1] <= 0) {
        throw new GnosticaRulesError(`Player ${player} has no stash pieces of size ${size}.`);
    }
    s[size - 1] -= 1;
};

export const returnToStash = (ctx: PowerContext, player: number, size: Pips): void => {
    stashOf(ctx, player)[size - 1] += 1;
};

// Non-mutating: true iff the acting player currently has at least one
// size-`size` piece left in their own reserve. Used by checkX functions
// that need to confirm a grow/replace is possible before the mutating
// function commits to it (its own takeFromStash call is the enforcement
// backstop).
// Exported: the engine's own validatePlace needs it too, for the same
// reason cmdPlace's takeFromStash call needs a non-throwing twin.
export const hasStashAvailable = (ctx: PowerContext, player: number, size: Pips): boolean => {
    const s = ctx.stashes.get(player);
    return s !== undefined && s[size - 1] > 0;
};

const getCellContents = (ctx: PowerContext, x: number, y: number): CellContents => {
    const t = ctx.board.get(x, y);
    if (t === undefined) {
        throw new GnosticaRulesError(`No territory at (${x}, ${y}).`);
    }
    return t;
};

const getPiece = (ctx: PowerContext, x: number, y: number, index: number): Piece => {
    const t = getCellContents(ctx, x, y);
    const p = t.pieces[index];
    if (p === undefined) {
        throw new GnosticaRulesError(`No piece at (${x}, ${y}) index ${index}.`);
    }
    return p;
};

// A cell "has an enemy" if any piece there belongs to someone other than
// `player` - used by every "not occupied by enemy pieces" rule in the text.
const hasEnemyPieces = (ctx: PowerContext, x: number, y: number, player: number): boolean => {
    const t = ctx.board.get(x, y);
    if (t === undefined) {
        return false;
    }
    return t.pieces.some(p => p.owner !== player);
};

// Icehouse pieces are never removed from the game outright - anything a
// territory-level mutation (destroyTerritory/pushTerritory) leaves stranded
// in the void is simply returned to its owner's stash, same as any other
// piece that ends up in the void. Shared by Rods' push-territory and Swords'
// attack-territory, the only two board.ts mutations that can strand pieces.
const returnEvictedPieces = (ctx: PowerContext, evictions: IEvicted[]): void => {
    for (const ev of evictions) {
        for (const p of ev.pieces) {
            returnToStash(ctx, p.owner, p.size);
        }
    }
};

const checkOwnMinion = (minion: Piece, player: number): PowerFailure | undefined => {
    if (minion.owner !== player) {
        return { key: "NOT_YOUR_MINION" };
    }
    return undefined;
};

// Every suit power targets either the minion's own cell (orientation "U")
// or the single cell it's pointing at (orientation N/E/S/W) - see the rules'
// "Orientation and targeting" section. This is the shared legality check for
// a CELL-level target (a territory/wasteland as a whole, not a specific
// piece in it).
const checkValidCellTarget = (
    ctx: PowerContext, minion: Piece, minionX: number, minionY: number, targetX: number, targetY: number,
): PowerFailure | undefined => {
    if (minion.orientation === "U") {
        if (targetX === minionX && targetY === minionY) {
            return undefined;
        }
        return { key: "MUST_TARGET_SELF" };
    }
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
    if (targetX === minionX + dx && targetY === minionY + dy) {
        return undefined;
    }
    return { key: "MUST_TARGET_FACING", params: { facing: minion.orientation } };
};

// Same, but for a specific PIECE target - a minion may always target itself
// regardless of orientation, on top of the cell-level rule above.
const checkValidPieceTarget = (
    ctx: PowerContext, minion: Piece, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
): PowerFailure | undefined => {
    const isSelf = targetX === minionX && targetY === minionY && targetIndex === minionIndex;
    if (isSelf) {
        return undefined;
    }
    return checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
};

// ============================================================
// Cups - Create
// ============================================================

// Add one of the acting player's own small pieces to the target cell.
export const checkCreateOwn = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, opts: PrimitiveOpts = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (targetErr) return targetErr;
    // A minion sitting on an isolated wasteland (not itself a territory)
    // can face a cell that's genuinely void - unlike movePiece, which
    // destroys a piece that lands in the void as a natural consequence of
    // relocating an EXISTING piece, there's no equivalent cleanup for a
    // brand-new piece, so it would otherwise just sit there forever,
    // invisible to every void-eviction path. Reject outright instead,
    // same as checkCreateTerritory's own wasteland-only restriction.
    if (ctx.board.classify(targetX, targetY) === "void") {
        return { key: "TARGET_IS_VOID" };
    }
    // The target cell may be a genuinely untouched wasteland (no stored
    // CellContents object at all, since one is only ever created for a cell
    // that already has a card or a piece) - that's zero pieces there, not
    // an error. movePiece/hermitMovePiece already handle an
    // absent destination the same way; this mirrors them.
    const t = ctx.board.get(targetX, targetY);
    const pieceCount = t?.pieces.length ?? 0;
    if (!opts.ignoreCapacity && pieceCount >= 3) {
        return { key: "CELL_FULL" };
    }
    return undefined;
};

export const createOwn = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, orientation: Orientation, opts: PrimitiveOpts = {},
): void => {
    const failure = checkCreateOwn(ctx, minionX, minionY, minionIndex, targetX, targetY, opts);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    takeFromStash(ctx, ctx.currplayer, 1);
    let t = ctx.board.get(targetX, targetY);
    if (t === undefined) {
        t = new CellContents(undefined);
        ctx.board.store.set(targetX, targetY, t);
    }
    t.add(new Piece(ctx.currplayer, 1, orientation), opts.ignoreCapacity);
};

// Add one of the TARGETED enemy's own small pieces to the same cell,
// matching that enemy piece's orientation, drawn from the enemy's stash.
export const checkCreateEnemy = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, victimIndex: number, opts: PrimitiveOpts = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (targetErr) return targetErr;
    // A genuinely void cell can never legitimately have a piece to copy
    // (a real victim already rules this out below), but check explicitly
    // anyway - see checkCreateOwn's own docs on why creation, unlike
    // movement, has no other cleanup path for a piece stranded in the
    // void.
    if (ctx.board.classify(targetX, targetY) === "void") {
        return { key: "TARGET_IS_VOID" };
    }
    const t = ctx.board.get(targetX, targetY);
    const victim = t?.pieces[victimIndex];
    if (victim === undefined) {
        return { key: "INVALID_MOVE", params: { reason: "NO_VICTIM_THERE" } };
    }
    if (victim.owner === ctx.currplayer) {
        return { key: "MUST_TARGET_ENEMY" };
    }
    if (!opts.ignoreCapacity && (t?.pieces.length ?? 0) >= 3) {
        return { key: "CELL_FULL" };
    }
    return undefined;
};

export const createEnemy = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, victimIndex: number, opts: PrimitiveOpts = {},
): void => {
    const failure = checkCreateEnemy(ctx, minionX, minionY, minionIndex, targetX, targetY, victimIndex, opts);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const t = getCellContents(ctx, targetX, targetY);
    const victim = t.pieces[victimIndex];
    takeFromStash(ctx, victim.owner, 1);
    t.add(new Piece(victim.owner, 1, victim.orientation), opts.ignoreCapacity);
};

// Create a new territory on a targeted wasteland, playing a spot (1-point)
// card from hand - or, with opts.allowRandomDraw (Wheel of Fortune), drawing
// the top of the draw pile instead, whatever it turns out to be (no point-
// value restriction on the random draw - unlike the hand-card path, the
// player never chose it, so there's nothing to restrict against).
export const checkCreateTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, cardUid: string | undefined, opts: PrimitiveOpts = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (targetErr) return targetErr;
    if (ctx.board.classify(targetX, targetY) !== "wasteland") {
        return { key: "NOT_A_WASTELAND" };
    }
    if (hasEnemyPieces(ctx, targetX, targetY, ctx.currplayer)) {
        return { key: "CELL_HAS_ENEMY" };
    }
    if (opts.allowRandomDraw) {
        if (ctx.drawPile.length === 0 && ctx.discardPile.length === 0) {
            return { key: "DRAW_PILE_EMPTY" };
        }
        return undefined;
    }
    if (cardUid === undefined) {
        return { key: "CARD_UID_REQUIRED" };
    }
    if (!ctx.hand.includes(cardUid)) {
        return { key: "NOT_IN_HAND", params: { uid: cardUid } };
    }
    const card = allCards().find(c => c.uid === cardUid);
    if (card === undefined) {
        return { key: "UNKNOWN_CARD", params: { uid: cardUid } };
    }
    if (cardPointValue(card) !== 1) {
        return { key: "MUST_BE_SPOT_CARD" };
    }
    return undefined;
};

export const createTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, cardUid: string | undefined, opts: PrimitiveOpts = {},
): void => {
    const failure = checkCreateTerritory(ctx, minionX, minionY, minionIndex, targetX, targetY, cardUid, opts);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    let card: TarotCard;
    if (opts.allowRandomDraw) {
        reshuffle(ctx);
        card = cardByUid(ctx.drawPile.shift() as string);
    } else {
        card = takeFromPile(ctx.hand, cardUid as string);
    }
    ctx.board.createTerritory(targetX, targetY, card);
};

// ============================================================
// Rods - Move
// ============================================================

const checkCanUseRod = (minion: Piece): PowerFailure | undefined => {
    if (minion.orientation === "U") {
        return { key: "ROD_NEEDS_FACING" };
    }
    return undefined;
};

// Move the minion itself, or push a targeted piece (self or the cell the
// minion is pointing at), `dist` spaces in the minion's own direction.
export const checkMovePiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, dist: number,
    opts: PrimitiveOpts & { skipLandingCheck?: boolean } = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const rodErr = checkCanUseRod(minion);
    if (rodErr) return rodErr;
    const targetErr = checkValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (targetErr) return targetErr;
    if (dist < 1 || dist > minion.size) {
        return { key: "BAD_DISTANCE", params: { size: minion.size, dist } };
    }
    if (!opts.skipLandingCheck) {
        const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
        const destX = targetX + dx * dist;
        const destY = targetY + dy * dist;
        // Landing in the void is legal here (unlike Hermit's teleport,
        // which forbids it) - it just destroys the piece, same as any
        // other piece that ends up in the void (see returnEvictedPieces).
        const destT = ctx.board.get(destX, destY);
        if (destT !== undefined && !destT.canAdd(opts.ignoreCapacity)) {
            return { key: "CELL_FULL" };
        }
    }
    return undefined;
};

export const movePiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, dist: number,
    newOrientation: Orientation | undefined, opts: PrimitiveOpts & { skipLandingCheck?: boolean } = {},
): void => {
    const failure = checkMovePiece(ctx, minionX, minionY, minionIndex, targetX, targetY, targetIndex, dist, opts);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
    const destX = targetX + dx * dist;
    const destY = targetY + dy * dist;

    const srcT = getCellContents(ctx, targetX, targetY);
    const moved = srcT.removeAt(targetIndex);
    // The source cell never gets a piece back from this function (it
    // either lands elsewhere or is destroyed in the void below) - prune
    // it now if that was its last occupant, so an empty wasteland
    // doesn't linger in the board's own stored map (see
    // GnosticaBoard.pruneIfEmpty's own docs).
    ctx.board.pruneIfEmpty(targetX, targetY);
    // A genuine final landing in the void destroys the piece. A relaxed
    // mid-chain waypoint (skipLandingCheck, Chariot) must NOT - the piece
    // still needs to be sitting there for the chain's next step to act on.
    if (!opts.skipLandingCheck && ctx.board.classify(destX, destY) === "void") {
        returnToStash(ctx, moved.owner, moved.size);
        return;
    }
    if (moved.owner === ctx.currplayer && newOrientation !== undefined) {
        moved.orientation = newOrientation;
    }
    let destT = ctx.board.get(destX, destY);
    if (destT === undefined) {
        destT = new CellContents(undefined);
        ctx.board.store.set(destX, destY, destT);
    }
    // A relaxed landing (Chariot's waypoint) must bypass CellContents.add()'s
    // own capacity enforcement too, not just the pre-check above - passing
    // "through" a 3+ piece cell means briefly exceeding it, transiently.
    destT.add(moved, opts.ignoreCapacity || opts.skipLandingCheck);
};

// Push the territory the minion is pointing at (never the minion's own
// cell - a rod can't push "itself") `dist` spaces further in that same
// direction.
export const checkMoveTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number, dist: number,
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const rodErr = checkCanUseRod(minion);
    if (rodErr) return rodErr;
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
    const srcX = minionX + dx;
    const srcY = minionY + dy;
    if (ctx.board.classify(srcX, srcY) !== "territory") {
        return { key: "NO_TERRITORY_THAT_WAY" };
    }
    if (hasEnemyPieces(ctx, srcX, srcY, ctx.currplayer)) {
        return { key: "CELL_HAS_ENEMY" };
    }
    if (dist < 1 || dist > minion.size) {
        return { key: "BAD_DISTANCE", params: { size: minion.size, dist } };
    }
    const destX = srcX + dx * dist;
    const destY = srcY + dy * dist;
    if (destX === minionX && destY === minionY) {
        return { key: "CANT_PUSH_ONTO_SELF" };
    }
    if (ctx.board.classify(destX, destY) !== "wasteland") {
        return { key: "PUSH_NEEDS_WASTELAND" };
    }
    if (hasEnemyPieces(ctx, destX, destY, ctx.currplayer)) {
        return { key: "DESTINATION_HAS_ENEMY" };
    }
    return undefined;
};

export const moveTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    dist: number,
): void => {
    const failure = checkMoveTerritory(ctx, minionX, minionY, minionIndex, dist);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
    const srcX = minionX + dx;
    const srcY = minionY + dy;
    const destX = srcX + dx * dist;
    const destY = srcY + dy * dist;
    // Pushing the card out from under the departure cell can strand any
    // pieces left there if nothing else keeps it adjacent to a territory.
    const evictions = ctx.board.pushTerritory(srcX, srcY, destX, destY);
    returnEvictedPieces(ctx, evictions);
};

// ============================================================
// Discs - Grow
// ============================================================

const nextSize = (size: Pips): Pips => (size + 1) as Pips;

// Replace the minion (or a targeted piece) with one exactly one size larger,
// same owner, drawn from that owner's own stash.
export const checkGrowPiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (targetErr) return targetErr;
    const target = ctx.board.get(targetX, targetY)?.pieces[targetIndex];
    if (target === undefined) {
        return { key: "NO_PIECE_THERE" };
    }
    if (target.size >= 3) {
        return { key: "ALREADY_MAX_SIZE" };
    }
    if (!hasStashAvailable(ctx, target.owner, nextSize(target.size))) {
        return { key: "STASH_EMPTY", params: { player: target.owner, size: nextSize(target.size) } };
    }
    return undefined;
};

export const growPiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
    newOrientation: Orientation | undefined,
): void => {
    const failure = checkGrowPiece(ctx, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const t = getCellContents(ctx, targetX, targetY);
    const target = t.pieces[targetIndex];
    const grownSize = nextSize(target.size);
    takeFromStash(ctx, target.owner, grownSize);
    returnToStash(ctx, target.owner, target.size);
    const orientation = target.owner === ctx.currplayer && newOrientation !== undefined ? newOrientation : target.orientation;
    t.removeAt(targetIndex);
    t.add(new Piece(target.owner, grownSize, orientation));
};

// Grow the targeted territory by exactly one point of value (or two, with
// opts.skipLadder - Strength growing the same territory twice), replacing
// its card from hand (default) or the discard pile (opts.replacementSource,
// Star).
export const checkGrowTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, newCardUid: string, opts: PrimitiveOpts & { skipLadder?: boolean } = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (targetErr) return targetErr;
    if (hasEnemyPieces(ctx, targetX, targetY, ctx.currplayer)) {
        return { key: "CELL_HAS_ENEMY" };
    }
    const t = ctx.board.get(targetX, targetY);
    const current = t?.pointValue() ?? 0;
    if (current === 0) {
        return { key: "NOTHING_TO_GROW" };
    }
    const pile = opts.replacementSource === "discard" ? ctx.discardPile : ctx.hand;
    if (!pile.includes(newCardUid)) {
        return { key: opts.replacementSource === "discard" ? "INVALID_MOVE" : "NOT_IN_HAND", params: { uid: newCardUid } };
    }
    const newCard = allCards().find(c => c.uid === newCardUid);
    if (newCard === undefined) {
        return { key: "UNKNOWN_CARD", params: { uid: newCardUid } };
    }
    const newValue = cardPointValue(newCard);
    const maxDelta = opts.skipLadder ? 2 : 1;
    if (newValue <= current || newValue > current + maxDelta) {
        return { key: "BAD_GROWTH_VALUE", params: { current, newValue } };
    }
    return undefined;
};

export const growTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, newCardUid: string, opts: PrimitiveOpts & { skipLadder?: boolean } = {},
): void => {
    const failure = checkGrowTerritory(ctx, minionX, minionY, minionIndex, targetX, targetY, newCardUid, opts);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const t = getCellContents(ctx, targetX, targetY);
    const pile = opts.replacementSource === "discard" ? ctx.discardPile : ctx.hand;
    const newCard = takeFromPile(pile, newCardUid);
    ctx.discardPile.push((t.card as TarotCard).uid);
    ctx.board.growTerritory(targetX, targetY, newCard);
};

// ============================================================
// Swords - Attack
// ============================================================

// Shrink a targeted piece (self or the cell the minion is pointing at) by up
// to `pips` (capped at the minion's size), replacing it with the
// appropriately smaller piece from the VICTIM's own stash - or, if the
// result is 0 pips, destroying it outright (its full size returns to the
// victim's stash, no replacement piece is placed).
export const checkAttackPiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, pips: number,
    opts: { skipStashCheck?: boolean } = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (targetErr) return targetErr;
    if (pips < 1 || pips > minion.size) {
        return { key: "BAD_DAMAGE", params: { size: minion.size, pips } };
    }
    const victim = ctx.board.get(targetX, targetY)?.pieces[targetIndex];
    if (victim === undefined) {
        return { key: "NO_PIECE_THERE" };
    }
    const resultSize = victim.size - pips;
    if (resultSize < 0) {
        return { key: "TOO_FEW_PIPS", params: { size: victim.size, pips } };
    }
    if (resultSize > 0 && !opts.skipStashCheck && !hasStashAvailable(ctx, victim.owner, resultSize as Pips)) {
        return { key: "STASH_EMPTY", params: { player: victim.owner, size: resultSize } };
    }
    return undefined;
};

export const attackPiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, pips: number,
    newOrientation: Orientation | undefined, opts: { skipStashCheck?: boolean } = {},
): void => {
    const failure = checkAttackPiece(ctx, minionX, minionY, minionIndex, targetX, targetY, targetIndex, pips, opts);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const t = getCellContents(ctx, targetX, targetY);
    const victim = t.pieces[targetIndex];
    const resultSize = victim.size - pips;
    if (resultSize === 0) {
        returnToStash(ctx, victim.owner, victim.size);
        t.removeAt(targetIndex);
        ctx.board.pruneIfEmpty(targetX, targetY);
        return;
    }
    if (!opts.skipStashCheck) {
        stashOf(ctx, victim.owner)[resultSize - 1] -= 1;
    }
    returnToStash(ctx, victim.owner, victim.size);
    const orientation = victim.owner === ctx.currplayer && newOrientation !== undefined ? newOrientation : victim.orientation;
    t.removeAt(targetIndex);
    t.add(new Piece(victim.owner, resultSize as Pips, orientation));
};

// Shrink the targeted territory's value by up to `pips`, replacing its card
// from hand (default) or the discard pile (opts.replacementSource, Tower) -
// or, if `newCardUid` is omitted, destroying the territory outright.
export const checkAttackTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, pips: number, newCardUid: string | undefined,
    opts: PrimitiveOpts = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (targetErr) return targetErr;
    if (hasEnemyPieces(ctx, targetX, targetY, ctx.currplayer)) {
        return { key: "CELL_HAS_ENEMY" };
    }
    if (pips < 1 || pips > minion.size) {
        return { key: "BAD_DAMAGE", params: { size: minion.size, pips } };
    }
    const t = ctx.board.get(targetX, targetY);
    const current = t?.pointValue() ?? 0;
    if (current === 0) {
        return { key: "NOTHING_TO_ATTACK" };
    }
    const resultValue = current - pips;
    if (resultValue < 0) {
        return { key: "TOO_FEW_PIPS_TERRITORY", params: { current, pips } };
    }
    if (resultValue === 0) {
        if (newCardUid !== undefined) {
            return { key: "DESTROYED_NEEDS_NO_CARD" };
        }
        return undefined;
    }
    if (newCardUid === undefined) {
        return { key: "REPLACEMENT_CARD_REQUIRED" };
    }
    const pile = opts.replacementSource === "discard" ? ctx.discardPile : ctx.hand;
    if (!pile.includes(newCardUid)) {
        return { key: opts.replacementSource === "discard" ? "INVALID_MOVE" : "NOT_IN_HAND", params: { uid: newCardUid } };
    }
    const newCard = allCards().find(c => c.uid === newCardUid);
    if (newCard === undefined) {
        return { key: "UNKNOWN_CARD", params: { uid: newCardUid } };
    }
    const newValue = cardPointValue(newCard);
    if (newValue !== resultValue) {
        return { key: "BAD_SHRINK_VALUE", params: { current, newValue, pips } };
    }
    return undefined;
};

export const attackTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, pips: number, newCardUid: string | undefined,
    opts: PrimitiveOpts = {},
): void => {
    const failure = checkAttackTerritory(ctx, minionX, minionY, minionIndex, targetX, targetY, pips, newCardUid, opts);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const t = getCellContents(ctx, targetX, targetY);
    const current = t.pointValue();
    const oldUid = (t.card as TarotCard).uid;
    const resultValue = current - pips;
    if (resultValue === 0) {
        const evictions = ctx.board.destroyTerritory(targetX, targetY);
        ctx.discardPile.push(oldUid);
        returnEvictedPieces(ctx, evictions);
        return;
    }
    const pile = opts.replacementSource === "discard" ? ctx.discardPile : ctx.hand;
    const newCard = takeFromPile(pile, newCardUid as string);
    ctx.discardPile.push(oldUid);
    ctx.board.shrinkTerritory(targetX, targetY, newCard);
};

// ============================================================
// Special powers - the major arcana abilities that don't reduce to one of
// the four suit primitives. Each function here mirrors the primitives'
// contract: given fully-specified parameters, either report why it can't be
// applied (checkX) or mutate ctx/board correctly for that one step (the
// matching mutating function). Chaining these together across a card's
// multi-step power list (walking a MajorArcanaDef.powers array, tracking
// which of the acting player's pieces have become minions this turn, etc.)
// is the move parser's job in the GameBase engine (src/games/gnostica.ts),
// not this file's.
//
// Two of the twenty-two majors need no dedicated function here at all:
// - Magician ({special: "magicianChoice"}) just means "the acting player
//   picks any one of the eight primitive functions above for this step" -
//   there's no distinct behaviour to implement, only a choice at dispatch
//   time.
// - every other major that decomposes into primitives (Lovers, Chariot,
//   Strength, Temperance, Empress, Emperor, Justice's sword half, Hanged
//   Man's rod half, Tower, Star, Moon, Sun, Death) is already fully covered
//   by the primitives above plus their opts flags.
//
// Fool ({special:"fool"}) and World ({special:"worldUseAny"}) both hand
// off to a DIFFERENT card's own power array rather than doing something
// self-contained - the flipped card, for Fool; the player-chosen on-board
// card, for World. fool()/worldChoosePower() below resolve/validate only
// their OWN half (flipping; naming a legal target); actually dispatching
// the resulting card's own power steps is gnostica.ts's job (see
// resolveFrameDef/walkFrameStack there).
// ============================================================

// Orient one of the acting player's own minions. Unlike the suit
// primitives, there's no adjacency/self targeting restriction here - any of
// the player's current minions may be the one reoriented (Empress/
// Emperor's first step, Tower/Star's first step).
export const checkOrientMinion = (ctx: PowerContext, x: number, y: number, index: number): PowerFailure | undefined => {
    const p = getPiece(ctx, x, y, index);
    return checkOwnMinion(p, ctx.currplayer);
};

export const orientMinion = (
    ctx: PowerContext, x: number, y: number, index: number, newOrientation: Orientation,
): void => {
    const failure = checkOrientMinion(ctx, x, y, index);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    getPiece(ctx, x, y, index).orientation = newOrientation;
};

// Devil only: orient ANY piece, even an opponent's - still subject to the
// normal self/adjacent-cell targeting rule, since the minion doing the
// orienting is still bound by its own facing. Reorienting the acting minion
// itself changes what it can subsequently target with the Devil's other two
// steps, which is the card's signature trick.
export const checkOrientAny = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (targetErr) return targetErr;
    if (ctx.board.get(targetX, targetY)?.pieces[targetIndex] === undefined) {
        return { key: "NO_PIECE_THERE" };
    }
    return undefined;
};

export const orientAny = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, newOrientation: Orientation,
): void => {
    const failure = checkOrientAny(ctx, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    getPiece(ctx, targetX, targetY, targetIndex).orientation = newOrientation;
};

// Hierophant: replace the target piece (anyone's) with one of the acting
// player's own, same size, drawn from the acting player's stash - the
// displaced piece returns to its own owner's stash, same as any other
// removal.
export const checkHierophantReplace = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (targetErr) return targetErr;
    const target = ctx.board.get(targetX, targetY)?.pieces[targetIndex];
    if (target === undefined) {
        return { key: "NO_PIECE_THERE" };
    }
    // Replacing one of your own pieces with another of your own achieves
    // nothing a real opponent-facing use of the power would - the
    // "meaningful step" rule (#49) that already forbids declining a
    // card's power outright forbids this too, rather than let it stand in
    // as an equivalent no-op. Skipping this step (leaving the chain's own
    // tail undeclared) stays legal, same as any other power.
    if (target.owner === ctx.currplayer) {
        return { key: "HIEROPHANT_MUST_TARGET_ENEMY" };
    }
    if (!hasStashAvailable(ctx, ctx.currplayer, target.size)) {
        return { key: "STASH_EMPTY", params: { player: ctx.currplayer, size: target.size } };
    }
    return undefined;
};

export const hierophantReplace = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, newOrientation: Orientation,
): void => {
    const failure = checkHierophantReplace(ctx, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const t = getCellContents(ctx, targetX, targetY);
    const target = t.pieces[targetIndex];
    takeFromStash(ctx, ctx.currplayer, target.size);
    returnToStash(ctx, target.owner, target.size);
    t.removeAt(targetIndex);
    t.add(new Piece(ctx.currplayer, target.size, newOrientation));
};

// Hermit, piece variant: move a targeted piece to ANY completely empty
// territory or wasteland on the board, ignoring the normal
// adjacency/distance limits every Rod is bound by.
export const checkHermitMovePiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, destX: number, destY: number,
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (targetErr) return targetErr;
    if (ctx.board.classify(destX, destY) === "void") {
        return { key: "CANT_END_IN_VOID" };
    }
    const destT = ctx.board.get(destX, destY);
    if (destT !== undefined && destT.pieces.length > 0) {
        return { key: "HERMIT_NEEDS_EMPTY" };
    }
    return undefined;
};

export const hermitMovePiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
    destX: number, destY: number, newOrientation: Orientation | undefined,
): void => {
    const failure = checkHermitMovePiece(ctx, minionX, minionY, minionIndex, targetX, targetY, targetIndex, destX, destY);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const srcT = getCellContents(ctx, targetX, targetY);
    const moved = srcT.removeAt(targetIndex);
    ctx.board.pruneIfEmpty(targetX, targetY);
    if (moved.owner === ctx.currplayer && newOrientation !== undefined) {
        moved.orientation = newOrientation;
    }
    let dt = ctx.board.get(destX, destY);
    if (dt === undefined) {
        dt = new CellContents(undefined);
        ctx.board.store.set(destX, destY, dt);
    }
    dt.add(moved);
};

// Hermit, territory variant: move a targeted (non-enemy-occupied) territory
// to ANY wasteland on the board not occupied by enemy pieces - the same
// card-only-moves mechanic as a Rod's tile push, just without the
// direction/distance limits.
export const checkHermitMoveTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, destX: number, destY: number,
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (targetErr) return targetErr;
    if (hasEnemyPieces(ctx, targetX, targetY, ctx.currplayer)) {
        return { key: "CELL_HAS_ENEMY" };
    }
    if (ctx.board.classify(destX, destY) !== "wasteland") {
        return { key: "PUSH_NEEDS_WASTELAND" };
    }
    if (hasEnemyPieces(ctx, destX, destY, ctx.currplayer)) {
        return { key: "DESTINATION_HAS_ENEMY" };
    }
    return undefined;
};

export const hermitMoveTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, destX: number, destY: number,
): void => {
    const failure = checkHermitMoveTerritory(ctx, minionX, minionY, minionIndex, targetX, targetY, destX, destY);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const evictions = ctx.board.pushTerritory(targetX, targetY, destX, destY);
    returnEvictedPieces(ctx, evictions);
};

// Justice / Hanged Man: swap hands with the owner of the targeted piece.
// PowerContext only ever carries the acting player's own hand, so the
// caller (which owns the full per-player hand map) must pass in the other
// player's live hand array by reference - both arrays are mutated in place,
// matching every other pile mutation in this file.
export const checkTradeHands = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (targetErr) return targetErr;
    const target = ctx.board.get(targetX, targetY)?.pieces[targetIndex];
    if (target === undefined) {
        return { key: "NO_PIECE_THERE" };
    }
    // Swapping hands with yourself is a no-op wearing the shape of a real
    // step - the "meaningful step" rule (#49) forbids it the same way it
    // forbids declining a card's power outright. Skipping this step
    // (leaving the chain's own tail undeclared) stays legal, same as any
    // other power.
    if (target.owner === ctx.currplayer) {
        return { key: "TRADEHANDS_MUST_TARGET_ENEMY" };
    }
    return undefined;
};

// Returns the target's owner so the caller can double-check it passed the
// right array.
export const tradeHands = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, otherHand: string[],
): number => {
    const failure = checkTradeHands(ctx, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    const target = getPiece(ctx, targetX, targetY, targetIndex);
    const mine = [...ctx.hand];
    ctx.hand.length = 0;
    ctx.hand.push(...otherHand);
    otherHand.length = 0;
    otherHand.push(...mine);
    return target.owner;
};

// Judgement: draw specific cards (chosen by the acting player, "from
// anywhere in the discard pile") into hand, up to one per pip of the acting
// minion, capped by the 6-card hand limit - drawing fewer than the minion's
// full pip count is always allowed, per the general "all powers are
// optional" rule. Every named uid is checked up front (including rejecting
// the same uid named twice, which would otherwise silently succeed on its
// first occurrence and only fail on retrying an already-drawn card) so
// judgementDraw can't partially mutate hand/discardPile before
// hitting an invalid later uid in the same list.
export const checkJudgementDraw = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number, cardUids: string[],
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const maxDraw = Math.min(minion.size, Math.max(0, 6 - ctx.hand.length));
    if (cardUids.length > maxDraw) {
        return { key: "TOO_MANY_TO_DRAW", params: { maxDraw, requested: cardUids.length } };
    }
    const seen = new Set<string>();
    for (const uid of cardUids) {
        if (seen.has(uid)) {
            return { key: "INVALID_MOVE", params: { reason: "DUPLICATE_CARD", uid } };
        }
        seen.add(uid);
        if (!ctx.discardPile.includes(uid)) {
            return { key: "INVALID_MOVE", params: { reason: "NOT_IN_DISCARD", uid } };
        }
    }
    return undefined;
};

export const judgementDraw = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number, cardUids: string[],
): void => {
    const failure = checkJudgementDraw(ctx, minionX, minionY, minionIndex, cardUids);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    for (const uid of cardUids) {
        const idx = ctx.discardPile.indexOf(uid);
        ctx.discardPile.splice(idx, 1);
        ctx.hand.push(uid);
    }
};

// High Priestess: one "discard any or none, then draw" round (the card
// grants two of these in a row - see MAJOR_ARCANA["02"] - by simply calling
// this twice). No minion/targeting is involved; this is pure hand/pile
// manipulation. The rules never mandate refilling all the way to 6 - the
// draw count is the player's own choice, exactly like the ordinary
// end-of-turn "discard and draw" action's own "draw <n>" grammar (see
// cmdDiscard/validateDiscard, gnostica.ts): omitting a count defaults to
// the max, same as that action's own default. Every named discard uid is
// checked up front for the same reason as Judgement above.
export const checkHighPriestess = (ctx: PowerContext, discardUids: string[], drawCountStr?: string): PowerFailure | undefined => {
    const seen = new Set<string>();
    for (const uid of discardUids) {
        if (seen.has(uid)) {
            return { key: "INVALID_MOVE", params: { reason: "DUPLICATE_CARD", uid } };
        }
        seen.add(uid);
        if (!ctx.hand.includes(uid)) {
            return { key: "NOT_IN_HAND", params: { uid } };
        }
    }
    if (drawCountStr !== undefined) {
        const maxDraw = Math.max(0, 6 - (ctx.hand.length - discardUids.length));
        const count = Number(drawCountStr);
        if (!Number.isInteger(count) || count < 0 || count > maxDraw) {
            return { key: "BAD_DRAW_COUNT", params: { requested: drawCountStr, max: maxDraw } };
        }
    }
    return undefined;
};

// `partial` mirrors cmdDiscard's own convention: the discard half happens
// eagerly either way (so a click-driven preview correctly shows the named
// cards leaving hand), but the draw half - genuinely random once a
// reshuffle is needed, and otherwise just premature - is skipped during a
// partial preview and only actually happens on a real commit. Returns the
// number of cards actually drawn, so the caller can log the real count
// rather than the discard count or the requested one (a reshuffle-starved
// deck can still fall short of what was asked for).
export const highPriestess = (ctx: PowerContext, discardUids: string[], drawCountStr: string | undefined, partial: boolean): number => {
    const failure = checkHighPriestess(ctx, discardUids, drawCountStr);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    for (const uid of discardUids) {
        const idx = ctx.hand.indexOf(uid);
        ctx.hand.splice(idx, 1);
        ctx.discardPile.push(uid);
    }
    if (partial) {
        return 0;
    }
    const maxDraw = Math.max(0, 6 - ctx.hand.length);
    const count = drawCountStr === undefined ? maxDraw : Number(drawCountStr);
    let drawn = 0;
    while (drawn < count) {
        reshuffle(ctx);
        if (ctx.drawPile.length === 0) {
            break; // nothing left anywhere
        }
        ctx.hand.push(ctx.drawPile.shift() as string);
        drawn++;
    }
    return drawn;
};

export const checkFool = (ctx: PowerContext): PowerFailure | undefined =>
    (ctx.drawPile.length === 0 && ctx.discardPile.length === 0) ? { key: "DRAW_PILE_EMPTY" } : undefined;

// Fool: flip the top card of the draw pile and "play" it - i.e. it goes
// straight to the discard pile, same as any other played card, and is
// returned here so the caller can resolve whichever power it grants (the
// card grants two flips - see MAJOR_ARCANA["00"] - by calling this twice).
// Actually dispatching the flipped card's own power is the caller's job,
// same scope boundary as World below - only the engine has the full
// per-card power dispatcher.
export const fool = (ctx: PowerContext): TarotCard => {
    const failure = checkFool(ctx);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    reshuffle(ctx);
    const uid = ctx.drawPile.shift();
    if (uid === undefined) {
        throw new GnosticaRulesError("Draw pile and discard pile are both empty.");
    }
    const flipped = cardByUid(uid);
    ctx.discardPile.push(uid);
    return flipped;
};

export const checkWorldChoosePower = (ctx: PowerContext, chosenUid: string): PowerFailure | undefined => {
    if (chosenUid === "21") {
        return { key: "WORLD_SELF_REFERENCE" };
    }
    const present = [...ctx.board.entries()].some(([, , t]) =>
        t.card !== undefined && t.card.major && t.card.uid === chosenUid);
    if (!present) {
        return { key: "NO_SUCH_MAJOR_ON_BOARD", params: { uid: chosenUid } };
    }
    if (MAJOR_ARCANA[chosenUid] === undefined) {
        return { key: "UNKNOWN_CARD", params: { uid: chosenUid } };
    }
    return undefined;
};

// World: validates that `chosenUid` names a major arcana card currently
// present somewhere on the board (and isn't World itself), and returns its
// MajorArcanaDef so the caller can resolve that card's power(s) exactly as
// if it had been activated directly - the actual multi-step dispatch is
// the engine's job.
export const worldChoosePower = (ctx: PowerContext, chosenUid: string): MajorArcanaDef => {
    const failure = checkWorldChoosePower(ctx, chosenUid);
    if (failure) {
        throw new GnosticaRulesError(`Move rejected by checkX: ${failure.key}`);
    }
    return MAJOR_ARCANA[chosenUid];
};
