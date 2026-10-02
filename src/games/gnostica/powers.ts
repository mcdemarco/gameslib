import { DirectionCardinal, shuffle } from "../../common";
import { TarotCard, allCards } from "../../common/tarot";
import { GnosticaBoard, IEvicted } from "./board";
import { CellContents, cardPointValue } from "./cell";
import { Piece, Pips, Orientation } from "./piece";
import type { IStep } from "../gnostica";
import { PrimitiveOpts, MAJOR_ARCANA, MajorArcanaDef, SpecialPower } from "./majorArcana";

// Per-size counts of pieces still in reserve [small, medium, large]; mutated in place by takeFromStash/returnToStash below.
export type Stash = [number, number, number];

export interface PowerContext {
    board: GnosticaBoard;
    currplayer: number;
    stashes: Map<number, Stash>;
    // Card uids, mutated in place as cards move between piles - callers that need to preserve pre-call state should clone first.
    hand: string[];
    discardPile: string[];
    drawPile: string[];
}

// An i18next key suffix + params; every checkX function returns undefined ("legal") or one of these; only validation calls them.
export interface PowerFailure {
    key: string;
    params?: Record<string, unknown>;
}

const cardByUid = (uid: string): TarotCard => allCards().find(c => c.uid === uid)!;

const takeFromPile = (pile: string[], uid: string): TarotCard => {
    pile.splice(pile.indexOf(uid), 1);
    return cardByUid(uid);
};

// Reshuffles discard into draw whenever draw is empty, in place (mirrors cmdDraw) since ctx.drawPile/discardPile alias GnosticaGame's own arrays.
const reshuffle = (ctx: PowerContext): void => {
    if (ctx.drawPile.length > 0 || ctx.discardPile.length === 0) {
        return;
    }
    ctx.drawPile.push(...(shuffle(ctx.discardPile) as string[]));
    ctx.discardPile.length = 0;
};

const stashOf = (ctx: PowerContext, player: number): Stash => ctx.stashes.get(player)!;

// Exported: the engine needs this directly for the base "place" turn action too.
export const takeFromStash = (ctx: PowerContext, player: number, size: Pips): void => {
    stashOf(ctx, player)[size - 1] -= 1;
};

export const returnToStash = (ctx: PowerContext, player: number, size: Pips): void => {
    stashOf(ctx, player)[size - 1] += 1;
};

// Non-mutating check used by checkX functions and validatePlace; the mutators just do the arithmetic.
export const hasStashAvailable = (ctx: PowerContext, player: number, size: Pips): boolean => {
    const s = ctx.stashes.get(player);
    return s !== undefined && s[size - 1] > 0;
};

const getCellContents = (ctx: PowerContext, x: number, y: number): CellContents => ctx.board.get(x, y)!;

const getPiece = (ctx: PowerContext, x: number, y: number, index: number): Piece => getCellContents(ctx, x, y).pieces[index];

// A cell "has an enemy" if any piece there belongs to someone other than `player`.
const hasEnemyPieces = (ctx: PowerContext, x: number, y: number, player: number): boolean => {
    const t = ctx.board.get(x, y);
    if (t === undefined) {
        return false;
    }
    return t.pieces.some(p => p.owner !== player);
};

// Pieces stranded in the void by destroyTerritory/pushTerritory return to their owner's stash; shared by Rods' push and Swords' attack-territory.
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

// Shared legality check for a CELL-level target: the minion's own cell ("U") or the single cell it's pointing at.
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

// Same, but for a specific PIECE target - a minion may always target itself regardless of orientation.
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

// Cups - Create

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
    if (!opts.skipStashCheck && !hasStashAvailable(ctx, ctx.currplayer, 1)) {
        return { key: "STASH_EMPTY", params: { playerNum: ctx.currplayer, size: 1 } };
    }
    return undefined;
};

export const createOwn = (ctx: PowerContext, targetX: number, targetY: number, orientation: Orientation): void => {
    takeFromStash(ctx, ctx.currplayer, 1);
    let t = ctx.board.get(targetX, targetY);
    if (t === undefined) {
        t = new CellContents(undefined);
        ctx.board.store.set(targetX, targetY, t);
    }
    t.add(new Piece(ctx.currplayer, 1, orientation));
};

// Add one of the TARGETED enemy's own small pieces to the same cell, matching its orientation, drawn from the enemy's stash.
export const checkCreateEnemy = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, victimIndex: number, opts: PrimitiveOpts = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (targetErr) return targetErr;
    // A void cell can never legitimately have a victim, but check explicitly anyway - creation has no cleanup path for a stranded piece.
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
    if (!hasStashAvailable(ctx, victim.owner, 1)) {
        return { key: "STASH_EMPTY", params: { playerNum: victim.owner, size: 1 } };
    }
    return undefined;
};

export const createEnemy = (ctx: PowerContext, targetX: number, targetY: number, victimIndex: number): void => {
    const t = getCellContents(ctx, targetX, targetY);
    const victim = t.pieces[victimIndex];
    takeFromStash(ctx, victim.owner, 1);
    t.add(new Piece(victim.owner, 1, victim.orientation));
};

// Create a territory on a wasteland with a spot card from hand, or (Wheel of Fortune's allowRandomDraw) an unrestricted draw-pile card instead.
export const checkCreateTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, cardUid: string | undefined, opts: PrimitiveOpts & { allowRoyalty?: boolean } = {},
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
    if (opts.allowRandomDraw && cardUid === undefined) {
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
    // opts.allowRoyalty (the Sun's shortcut): a royalty card may stand in for creating a spot card and then growing it.
    if (cardPointValue(card) !== 1 && !(opts.allowRoyalty && cardPointValue(card) === 2)) {
        return { key: "MUST_BE_SPOT_CARD" };
    }
    return undefined;
};

export const createTerritory = (ctx: PowerContext, targetX: number, targetY: number, cardUid: string): void => {
    ctx.board.createTerritory(targetX, targetY, takeFromPile(ctx.hand, cardUid));
};

// Wheel of Fortune's drawn territory: the deck's top card, which nobody may see before the move is committed.
export const createTerritoryFromDeck = (ctx: PowerContext, targetX: number, targetY: number): TarotCard => {
    reshuffle(ctx);
    const card = cardByUid(ctx.drawPile.shift() as string);
    ctx.board.createTerritory(targetX, targetY, card);
    return card;
};

// Rods - Move

const checkCanUseRod = (minion: Piece): PowerFailure | undefined => {
    if (minion.orientation === "U") {
        return { key: "ROD_NEEDS_FACING" };
    }
    return undefined;
};

// Move the minion itself, or push a targeted piece, `dist` spaces in the minion's own direction.
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
    newOrientation: Orientation | undefined, waypoint = false,
): void => {
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
    // A genuine final landing in the void destroys the piece. A mid-chain
    // waypoint (Chariot) must NOT - the piece still needs to be sitting
    // there for the chain's next step to act on.
    if (!waypoint && ctx.board.classify(destX, destY) === "void") {
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
    destT.add(moved);
};

// Push the territory at the minion-facing (srcX, srcY) `dist` spaces further, same direction; srcX/srcY are caller-supplied so the move string names it.
export const checkMoveTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    srcX: number, srcY: number, dist: number,
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const rodErr = checkCanUseRod(minion);
    if (rodErr) return rodErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, srcX, srcY);
    if (targetErr) return targetErr;
    if (ctx.board.classify(srcX, srcY) !== "territory") {
        return { key: "NO_TERRITORY_THAT_WAY" };
    }
    if (hasEnemyPieces(ctx, srcX, srcY, ctx.currplayer)) {
        return { key: "CELL_HAS_ENEMY" };
    }
    if (dist < 1 || dist > minion.size) {
        return { key: "BAD_DISTANCE", params: { size: minion.size, dist } };
    }
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
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
    srcX: number, srcY: number, dist: number,
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
    const destX = srcX + dx * dist;
    const destY = srcY + dy * dist;
    // Pushing the card out can strand pieces left at the departure cell if nothing else keeps it adjacent to a territory.
    const evictions = ctx.board.pushTerritory(srcX, srcY, destX, destY);
    returnEvictedPieces(ctx, evictions);
};

// Discs - Grow

const nextSize = (size: Pips): Pips => (size + 1) as Pips;

// Replace the minion (or a targeted piece) with one exactly one size larger, same owner, drawn from that owner's own stash.
export const checkGrowPiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
    opts: { skipStashCheck?: boolean } = {},
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
    if (!opts.skipStashCheck && !hasStashAvailable(ctx, target.owner, nextSize(target.size))) {
        return { key: "STASH_EMPTY", params: { playerNum: target.owner, size: nextSize(target.size) } };
    }
    return undefined;
};

export const growPiece = (
    ctx: PowerContext, targetX: number, targetY: number, targetIndex: number, newOrientation: Orientation | undefined,
): void => {
    const t = getCellContents(ctx, targetX, targetY);
    const target = t.pieces[targetIndex];
    const grownSize = nextSize(target.size);
    takeFromStash(ctx, target.owner, grownSize);
    returnToStash(ctx, target.owner, target.size);
    const orientation = target.owner === ctx.currplayer && newOrientation !== undefined ? newOrientation : target.orientation;
    t.removeAt(targetIndex);
    t.add(new Piece(target.owner, grownSize, orientation));
};

// Grow the targeted territory by one point of value (or two, opts.skipLadder), replacing its card from hand or discard (opts.replacementSource).
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

// The replacement card comes from wherever it is: the hand, or (Tower/Star) the discards.
const replacementPile = (ctx: PowerContext, uid: string): string[] => ctx.hand.includes(uid) ? ctx.hand : ctx.discardPile;

export const growTerritory = (ctx: PowerContext, targetX: number, targetY: number, newCardUid: string): void => {
    const t = getCellContents(ctx, targetX, targetY);
    const newCard = takeFromPile(replacementPile(ctx, newCardUid), newCardUid);
    ctx.discardPile.push((t.card as TarotCard).uid);
    ctx.board.growTerritory(targetX, targetY, newCard);
};

// Swords - Attack

// Shrink a targeted piece by up to `pips`, replacing it from the VICTIM's own stash - or destroying it outright if the result is 0 pips.
// opts.bothSwords (Death's shortcut) lets `pips` be the total of both of the card's attacks, i.e. up to twice the minion's size.
export const checkAttackPiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, pips: number,
    opts: { bothSwords?: boolean } = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (targetErr) return targetErr;
    if (pips < 1 || pips > (opts.bothSwords ? minion.size * 2 : minion.size)) {
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
    if (resultSize > 0 && !hasStashAvailable(ctx, victim.owner, resultSize as Pips)) {
        return { key: "STASH_EMPTY", params: { playerNum: victim.owner, size: resultSize } };
    }
    return undefined;
};

export const attackPiece = (
    ctx: PowerContext, targetX: number, targetY: number, targetIndex: number, pips: number,
    newOrientation: Orientation | undefined,
): void => {
    const t = getCellContents(ctx, targetX, targetY);
    const victim = t.pieces[targetIndex];
    const resultSize = victim.size - pips;
    if (resultSize === 0) {
        returnToStash(ctx, victim.owner, victim.size);
        t.removeAt(targetIndex);
        ctx.board.pruneIfEmpty(targetX, targetY);
        return;
    }
    stashOf(ctx, victim.owner)[resultSize - 1] -= 1;
    returnToStash(ctx, victim.owner, victim.size);
    const orientation = victim.owner === ctx.currplayer && newOrientation !== undefined ? newOrientation : victim.orientation;
    t.removeAt(targetIndex);
    t.add(new Piece(victim.owner, resultSize as Pips, orientation));
};

// Shrink the targeted territory's value by up to `pips`, replacing its card, or destroying it outright if `newCardUid` is omitted.
export const checkAttackTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, pips: number, newCardUid: string | undefined,
    opts: PrimitiveOpts & { bothSwords?: boolean } = {},
): PowerFailure | undefined => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    const ownErr = checkOwnMinion(minion, ctx.currplayer);
    if (ownErr) return ownErr;
    const targetErr = checkValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (targetErr) return targetErr;
    if (hasEnemyPieces(ctx, targetX, targetY, ctx.currplayer)) {
        return { key: "CELL_HAS_ENEMY" };
    }
    if (pips < 1 || pips > (opts.bothSwords ? minion.size * 2 : minion.size)) {
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
    ctx: PowerContext, targetX: number, targetY: number, pips: number, newCardUid: string | undefined,
): void => {
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
    const newCard = takeFromPile(replacementPile(ctx, newCardUid as string), newCardUid as string);
    ctx.discardPile.push(oldUid);
    ctx.board.shrinkTerritory(targetX, targetY, newCard);
};

// Special powers: the major arcana abilities that don't reduce to a suit primitive; chaining a card's own multi-step power list is gnostica.ts's job.

// Orient one of the acting player's own minions - unlike suit primitives, no adjacency/self targeting restriction here.
export const checkOrientMinion = (ctx: PowerContext, x: number, y: number, index: number): PowerFailure | undefined => {
    const p = getPiece(ctx, x, y, index);
    return checkOwnMinion(p, ctx.currplayer);
};

// The one place any orientation actually gets written - orientMinion, orientAny, and the standalone "orient" command all funnel through here.
const setPieceOrientation = (
    ctx: PowerContext, x: number, y: number, index: number, newOrientation: Orientation,
): void => {
    getPiece(ctx, x, y, index).orientation = newOrientation;
};

export const orientMinion = (
    ctx: PowerContext, x: number, y: number, index: number, newOrientation: Orientation,
): void => {
    setPieceOrientation(ctx, x, y, index, newOrientation);
};

// Devil only: orient ANY piece, even an opponent's, still subject to the normal self/adjacent-cell targeting rule.
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
    ctx: PowerContext, targetX: number, targetY: number, targetIndex: number, newOrientation: Orientation,
): void => {
    setPieceOrientation(ctx, targetX, targetY, targetIndex, newOrientation);
};

// Hierophant: replace the target piece with one of the acting player's own, same size; the displaced piece returns to its owner's stash.
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
    // Replacing your own piece with another of your own is a no-op forbidden by the "meaningful step" rule (#49); skipping the step stays legal.
    if (target.owner === ctx.currplayer) {
        return { key: "HIEROPHANT_MUST_TARGET_ENEMY" };
    }
    if (!hasStashAvailable(ctx, ctx.currplayer, target.size)) {
        return { key: "STASH_EMPTY", params: { playerNum: ctx.currplayer, size: target.size } };
    }
    return undefined;
};

export const hierophantReplace = (
    ctx: PowerContext, targetX: number, targetY: number, targetIndex: number, newOrientation: Orientation,
): void => {
    const t = getCellContents(ctx, targetX, targetY);
    const target = t.pieces[targetIndex];
    takeFromStash(ctx, ctx.currplayer, target.size);
    returnToStash(ctx, target.owner, target.size);
    t.removeAt(targetIndex);
    t.add(new Piece(ctx.currplayer, target.size, newOrientation));
};

// Hermit, piece variant: move a targeted piece to ANY completely empty territory or wasteland, ignoring adjacency/distance limits.
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
    ctx: PowerContext, targetX: number, targetY: number, targetIndex: number,
    destX: number, destY: number, newOrientation: Orientation | undefined,
): void => {
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

// Hermit, territory variant: move a targeted territory to ANY non-enemy-occupied wasteland - a Rod's tile push without direction/distance limits.
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
    ctx: PowerContext, targetX: number, targetY: number, destX: number, destY: number,
): void => {
    const evictions = ctx.board.pushTerritory(targetX, targetY, destX, destY);
    returnEvictedPieces(ctx, evictions);
};

// Justice / Hanged Man: swap hands with the owner of the targeted piece; caller must pass the other player's live hand array by reference.
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
    // Swapping hands with yourself is a no-op forbidden by the "meaningful step" rule (#49); skipping the step stays legal.
    if (target.owner === ctx.currplayer) {
        return { key: "TRADEHANDS_MUST_TARGET_ENEMY" };
    }
    return undefined;
};

// Returns the target's owner so the caller can double-check it passed the right array.
export const tradeHands = (
    ctx: PowerContext, targetX: number, targetY: number, targetIndex: number, otherHand: string[],
): number => {
    const target = getPiece(ctx, targetX, targetY, targetIndex);
    const mine = [...ctx.hand];
    ctx.hand.length = 0;
    ctx.hand.push(...otherHand);
    otherHand.length = 0;
    otherHand.push(...mine);
    return target.owner;
};

// Judgement: draw chosen cards from the discard pile into hand, up to one per pip of the acting minion, capped by the 6-card hand limit.
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

export const judgementDraw = (ctx: PowerContext, cardUids: string[]): void => {
    for (const uid of cardUids) {
        const idx = ctx.discardPile.indexOf(uid);
        ctx.discardPile.splice(idx, 1);
        ctx.hand.push(uid);
    }
};

// Shared "discard any or none, then draw" primitive - one round is the ordinary end-of-turn action; High Priestess calls this twice.
export const checkDiscardDraw = (ctx: PowerContext, discardUids: string[], drawCountStr?: string): PowerFailure | undefined => {
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

export const discardCards = (ctx: PowerContext, discardUids: string[]): void => {
    for (const uid of discardUids) {
        const idx = ctx.hand.indexOf(uid);
        ctx.hand.splice(idx, 1);
        ctx.discardPile.push(uid);
    }
};

// Genuinely random, so only ever run once a move is committed; returns the actual count drawn.
export const drawCards = (ctx: PowerContext, count: number): number => {
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

// Fool: flip the top draw-pile card straight to discard; dispatching its power is the caller's job (the engine's full per-card dispatcher).
export const fool = (ctx: PowerContext): TarotCard => {
    reshuffle(ctx);
    const uid = ctx.drawPile.shift()!;
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

// World: validates `chosenUid` names a major arcana card on the board (not World itself) and returns its MajorArcanaDef for the engine to dispatch.
export const worldChoosePower = (ctx: PowerContext, chosenUid: string): MajorArcanaDef => {
    return MAJOR_ARCANA[chosenUid];
};

// ---- Power step grammar: suit/mode constants and IStep-based mode inference (never legality) ----

// The four minor-arcana suits - a closed set in practice (card data, not user input), typed as such so
// every switch/if-chain over a suit uid is compile-time exhaustive instead of needing a runtime fallback.
export type MinorSuitUid = "C" | "R" | "D" | "S";
// Rods/Discs/Swords' own step target, and Hermit's fly mode (same shape, different power).
export type TargetMode = "piece" | "tile";
export type CupsMode = "own" | "enemy" | "new";
export type MinorMode = CupsMode | TargetMode;

// The four minor-arcana suits, shared by gnostica.ts and randomMove.ts (which can't import values from gnostica.ts).
export const ALL_SUITS: { uid: MinorSuitUid; label: string }[] = [
    { uid: "C", label: "Cups" },
    { uid: "R", label: "Rods" },
    { uid: "D", label: "Discs" },
    { uid: "S", label: "Swords" },
];

// The verb each of Rods/Discs/Swords spells its step with; Cups has none (no entry).
export const RDS_VERBS: Partial<Record<MinorSuitUid, string>> = { R: "move", D: "grow", S: "shrink" };

// A suit step's mode (Cups own/enemy/new; the others piece/tile), read from the fields parseMove already resolved; undefined if the action isn't this suit's verb or no target is named.
export function stepMinorMode(suitUid: MinorSuitUid, step: IStep): MinorMode | undefined {
    const verb = RDS_VERBS[suitUid];
    if (verb !== undefined) {
        if (step.action !== verb) {
            return undefined;
        }
        return step.targetPiece !== undefined ? "piece" : step.targetCell !== undefined ? "tile" : undefined;
    }
    if (suitUid !== "C" || step.action !== "create") {
        return undefined;
    }
    if (step.direction !== undefined) {
        return "own";
    }
    if (step.targetPiece !== undefined) {
        return "enemy";
    }
    // "own"/"enemy" have no empty-field reading, so this is "new" either way.
    return "new";
}

// Hermit's mode from the step's fields; targetCell is reserved exclusively for the destination in both modes.
export function stepHermitMode(step: IStep): TargetMode | undefined {
    if (step.action !== "fly") {
        return undefined;
    }
    return step.targetPiece !== undefined ? "piece" : step.card !== undefined ? "tile" : undefined;
}

// The verb each of these special powers' step is spelled with; a step with any other action is not this power's step, however its fields happen to line up.
export const SPECIAL_STEP_ACTIONS: Partial<Record<SpecialPower, string>> = {
    orientMinion: "orient",
    orientAny: "orient",
    hierophantReplace: "replace",
    hermitTeleport: "fly",
    tradeHands: "trade",
    judgementDraw: "draw",
};
