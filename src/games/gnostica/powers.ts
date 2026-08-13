import { DirectionCardinal } from "../../common";
import { TarotCard, allCards } from "../../common/tarot";
import { GnosticaBoard, IEvicted } from "./board";
import { Territory, cardPointValue } from "./Territory";
import { Piece, PieceSize, Orientation } from "./Piece";
import { PrimitiveOpts } from "./majorArcana";

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

class GnosticaRulesError extends Error {}

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

const stashOf = (ctx: PowerContext, player: number): Stash => {
    const s = ctx.stashes.get(player);
    if (s === undefined) {
        throw new GnosticaRulesError(`No stash tracked for player ${player}.`);
    }
    return s;
};

const takeFromStash = (ctx: PowerContext, player: number, size: PieceSize): void => {
    const s = stashOf(ctx, player);
    if (s[size - 1] <= 0) {
        throw new GnosticaRulesError(`Player ${player} has no size-${size} pieces left in their stash.`);
    }
    s[size - 1] -= 1;
};

const returnToStash = (ctx: PowerContext, player: number, size: PieceSize): void => {
    stashOf(ctx, player)[size - 1] += 1;
};

const getTerritory = (ctx: PowerContext, x: number, y: number): Territory => {
    const t = ctx.board.get(x, y);
    if (t === undefined) {
        throw new GnosticaRulesError(`No territory/wasteland tracked at (${x},${y}).`);
    }
    return t;
};

const getPiece = (ctx: PowerContext, x: number, y: number, index: number): Piece => {
    const t = getTerritory(ctx, x, y);
    const p = t.pieces[index];
    if (p === undefined) {
        throw new GnosticaRulesError(`No piece at index ${index} on (${x},${y}).`);
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

// Every suit power targets either the minion's own cell (orientation "up")
// or the single cell it's pointing at (orientation N/E/S/W) - see the rules'
// "Orientation and targeting" section. This is the shared legality check for
// a CELL-level target (a territory/wasteland as a whole, not a specific
// piece in it).
const assertValidCellTarget = (ctx: PowerContext, minion: Piece, minionX: number, minionY: number, targetX: number, targetY: number): void => {
    if (minion.orientation === "up") {
        if (targetX === minionX && targetY === minionY) {
            return;
        }
        throw new GnosticaRulesError("A minion pointing up may only target its own cell.");
    }
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
    if (targetX === minionX + dx && targetY === minionY + dy) {
        return;
    }
    throw new GnosticaRulesError(`A minion pointing ${minion.orientation} may only target the cell it's pointing at.`);
};

// Same, but for a specific PIECE target - a minion may always target itself
// regardless of orientation, on top of the cell-level rule above.
const assertValidPieceTarget = (
    ctx: PowerContext, minion: Piece, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
): void => {
    const isSelf = targetX === minionX && targetY === minionY && targetIndex === minionIndex;
    if (isSelf) {
        return;
    }
    assertValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
};

const requireOwnMinion = (minion: Piece, player: number): void => {
    if (minion.owner !== player) {
        throw new GnosticaRulesError("You may only act through your own minions.");
    }
};

// ============================================================
// Cups - Create
// ============================================================

// Add one of the acting player's own small pieces to the target cell.
export const resolveCreateOwn = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, orientation: Orientation, opts: PrimitiveOpts = {},
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    assertValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    const t = getTerritory(ctx, targetX, targetY);
    if (!t.canAdd(opts.ignoreCapacity)) {
        throw new GnosticaRulesError("That cell already holds 3 pieces.");
    }
    takeFromStash(ctx, ctx.currplayer, 1);
    t.add(new Piece(ctx.currplayer, 1, orientation), opts.ignoreCapacity);
};

// Add one of the TARGETED enemy's own small pieces to the same cell,
// matching that enemy piece's orientation, drawn from the enemy's stash.
export const resolveCreateCopy = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, victimIndex: number, opts: PrimitiveOpts = {},
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    assertValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    const t = getTerritory(ctx, targetX, targetY);
    const victim = t.pieces[victimIndex];
    if (victim === undefined) {
        throw new GnosticaRulesError(`No piece at index ${victimIndex} on (${targetX},${targetY}).`);
    }
    if (victim.owner === ctx.currplayer) {
        throw new GnosticaRulesError("Cups' copy mode requires targeting an enemy piece.");
    }
    if (!t.canAdd(opts.ignoreCapacity)) {
        throw new GnosticaRulesError("That cell already holds 3 pieces.");
    }
    takeFromStash(ctx, victim.owner, 1);
    t.add(new Piece(victim.owner, 1, victim.orientation), opts.ignoreCapacity);
};

// Create a new territory on a targeted wasteland, playing a spot (1-point)
// card from hand - or, with opts.allowRandomDraw (Wheel of Fortune), drawing
// the top of the draw pile instead.
export const resolveCreateTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, cardUid: string | undefined, opts: PrimitiveOpts = {},
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    assertValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (ctx.board.classify(targetX, targetY) !== "wasteland") {
        throw new GnosticaRulesError("Cups can only create a territory on a wasteland.");
    }
    if (hasEnemyPieces(ctx, targetX, targetY, ctx.currplayer)) {
        throw new GnosticaRulesError("That wasteland is occupied by enemy pieces.");
    }
    let card: TarotCard;
    if (opts.allowRandomDraw) {
        const drawnUid = ctx.drawPile.shift();
        if (drawnUid === undefined) {
            throw new GnosticaRulesError("The draw pile is empty.");
        }
        card = cardByUid(drawnUid);
    } else {
        if (cardUid === undefined) {
            throw new GnosticaRulesError("A card uid is required unless drawing randomly.");
        }
        card = takeFromPile(ctx.hand, cardUid);
    }
    if (cardPointValue(card) !== 1) {
        throw new GnosticaRulesError("Only a spot (1-point) card may be used to create a territory.");
    }
    ctx.board.createTerritory(targetX, targetY, card);
};

// ============================================================
// Rods - Move
// ============================================================

const requireCanUseRod = (minion: Piece): void => {
    if (minion.orientation === "up") {
        throw new GnosticaRulesError("A piece standing upright may not use a rod.");
    }
};

// Move the minion itself, or push a targeted piece (self or the cell the
// minion is pointing at), `dist` spaces in the minion's own direction.
export const resolveMovePiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, dist: number,
    newOrientation: Orientation | undefined, opts: PrimitiveOpts & { skipLandingCheck?: boolean } = {},
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    requireCanUseRod(minion);
    assertValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (dist < 1 || dist > minion.size) {
        throw new GnosticaRulesError(`A size-${minion.size} minion may move 1 to ${minion.size} spaces, not ${dist}.`);
    }
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
    const destX = targetX + dx * dist;
    const destY = targetY + dy * dist;

    if (!opts.skipLandingCheck) {
        if (ctx.board.classify(destX, destY) === "void") {
            throw new GnosticaRulesError("A moved piece may not end in the void.");
        }
        const destT = ctx.board.get(destX, destY);
        if (destT !== undefined && !destT.canAdd(opts.ignoreCapacity)) {
            throw new GnosticaRulesError("That destination already holds 3 pieces.");
        }
    }

    const srcT = getTerritory(ctx, targetX, targetY);
    const moved = srcT.removeAt(targetIndex);
    if (moved.owner === ctx.currplayer && newOrientation !== undefined) {
        moved.orientation = newOrientation;
    }
    let destT = ctx.board.get(destX, destY);
    if (destT === undefined) {
        destT = new Territory(undefined);
        ctx.board.store.set(destX, destY, destT);
    }
    destT.add(moved, opts.ignoreCapacity);
};

// Push the territory the minion is pointing at (never the minion's own
// cell - a rod can't push "itself") `dist` spaces further in that same
// direction.
export const resolveMoveTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    dist: number,
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    requireCanUseRod(minion);
    const [dx, dy] = ctx.board.delta(minion.orientation as DirectionCardinal);
    const srcX = minionX + dx;
    const srcY = minionY + dy;
    if (ctx.board.classify(srcX, srcY) !== "territory") {
        throw new GnosticaRulesError("There is no territory in the direction the minion is pointing.");
    }
    if (hasEnemyPieces(ctx, srcX, srcY, ctx.currplayer)) {
        throw new GnosticaRulesError("That territory is occupied by enemy pieces.");
    }
    if (dist < 1 || dist > minion.size) {
        throw new GnosticaRulesError(`A size-${minion.size} minion may push 1 to ${minion.size} spaces, not ${dist}.`);
    }
    const destX = srcX + dx * dist;
    const destY = srcY + dy * dist;
    if (destX === minionX && destY === minionY) {
        throw new GnosticaRulesError("A pushed territory cannot land on the pushing minion's own cell.");
    }
    if (ctx.board.classify(destX, destY) !== "wasteland") {
        throw new GnosticaRulesError("A pushed territory must land on a wasteland.");
    }
    if (hasEnemyPieces(ctx, destX, destY, ctx.currplayer)) {
        throw new GnosticaRulesError("That destination wasteland is occupied by enemy pieces.");
    }
    // Pushing the card out from under the departure cell can strand any
    // pieces left there if nothing else keeps it adjacent to a territory.
    const evictions = ctx.board.pushTerritory(srcX, srcY, destX, destY);
    returnEvictedPieces(ctx, evictions);
};

// ============================================================
// Discs - Grow
// ============================================================

const nextSize = (size: PieceSize): PieceSize => {
    if (size === 3) {
        throw new GnosticaRulesError("A large piece cannot grow any further.");
    }
    return (size + 1) as PieceSize;
};

// Replace the minion (or a targeted piece) with one exactly one size larger,
// same owner, drawn from that owner's own stash.
export const resolveGrowPiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number,
    newOrientation: Orientation | undefined,
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    assertValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    const t = getTerritory(ctx, targetX, targetY);
    const target = t.pieces[targetIndex];
    if (target === undefined) {
        throw new GnosticaRulesError(`No piece at index ${targetIndex} on (${targetX},${targetY}).`);
    }
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
export const resolveGrowTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, newCardUid: string, opts: PrimitiveOpts & { skipLadder?: boolean } = {},
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    assertValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (hasEnemyPieces(ctx, targetX, targetY, ctx.currplayer)) {
        throw new GnosticaRulesError("That territory is occupied by enemy pieces.");
    }
    const t = getTerritory(ctx, targetX, targetY);
    const current = t.pointValue();
    if (current === 0) {
        throw new GnosticaRulesError("There is no territory there to grow.");
    }
    const pile = opts.replacementSource === "discard" ? ctx.discardPile : ctx.hand;
    const newCard = takeFromPile(pile, newCardUid);
    const newValue = cardPointValue(newCard);
    const maxDelta = opts.skipLadder ? 2 : 1;
    if (newValue <= current || newValue > current + maxDelta) {
        pile.push(newCardUid); // undo the take before reporting failure
        throw new GnosticaRulesError(`A territory worth ${current} may only grow to ${current + 1}${maxDelta > 1 ? ` or ${current + 2}` : ""}, not ${newValue}.`);
    }
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
export const resolveAttackPiece = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, targetIndex: number, pips: number,
    newOrientation: Orientation | undefined, opts: { skipStashCheck?: boolean } = {},
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    assertValidPieceTarget(ctx, minion, minionX, minionY, minionIndex, targetX, targetY, targetIndex);
    if (pips < 1 || pips > minion.size) {
        throw new GnosticaRulesError(`A size-${minion.size} minion may attack for 1 to ${minion.size} pips, not ${pips}.`);
    }
    const t = getTerritory(ctx, targetX, targetY);
    const victim = t.pieces[targetIndex];
    if (victim === undefined) {
        throw new GnosticaRulesError(`No piece at index ${targetIndex} on (${targetX},${targetY}).`);
    }
    const resultSize = victim.size - pips;
    if (resultSize < 0) {
        throw new GnosticaRulesError(`That piece only has ${victim.size} pips; cannot attack for ${pips}.`);
    }
    if (resultSize === 0) {
        returnToStash(ctx, victim.owner, victim.size);
        t.removeAt(targetIndex);
        return;
    }
    if (!opts.skipStashCheck) {
        const s = stashOf(ctx, victim.owner);
        if (s[resultSize - 1] <= 0) {
            throw new GnosticaRulesError(`Player ${victim.owner} has no size-${resultSize} pieces left to replace the victim with.`);
        }
        s[resultSize - 1] -= 1;
    }
    returnToStash(ctx, victim.owner, victim.size);
    const orientation = victim.owner === ctx.currplayer && newOrientation !== undefined ? newOrientation : victim.orientation;
    t.removeAt(targetIndex);
    t.add(new Piece(victim.owner, resultSize as PieceSize, orientation));
};

// Shrink the targeted territory's value by up to `pips`, replacing its card
// from hand (default) or the discard pile (opts.replacementSource, Tower) -
// or, if `newCardUid` is omitted, destroying the territory outright.
export const resolveAttackTerritory = (
    ctx: PowerContext, minionX: number, minionY: number, minionIndex: number,
    targetX: number, targetY: number, pips: number, newCardUid: string | undefined,
    opts: PrimitiveOpts = {},
): void => {
    const minion = getPiece(ctx, minionX, minionY, minionIndex);
    requireOwnMinion(minion, ctx.currplayer);
    assertValidCellTarget(ctx, minion, minionX, minionY, targetX, targetY);
    if (hasEnemyPieces(ctx, targetX, targetY, ctx.currplayer)) {
        throw new GnosticaRulesError("That territory is occupied by enemy pieces.");
    }
    if (pips < 1 || pips > minion.size) {
        throw new GnosticaRulesError(`A size-${minion.size} minion may attack for 1 to ${minion.size} pips, not ${pips}.`);
    }
    const t = getTerritory(ctx, targetX, targetY);
    const current = t.pointValue();
    if (current === 0) {
        throw new GnosticaRulesError("There is no territory there to attack.");
    }
    const oldUid = (t.card as TarotCard).uid;
    const resultValue = current - pips;
    if (resultValue < 0) {
        throw new GnosticaRulesError(`That territory is only worth ${current}; cannot attack for ${pips}.`);
    }
    if (resultValue === 0) {
        if (newCardUid !== undefined) {
            throw new GnosticaRulesError("A fully-destroyed territory has no replacement card.");
        }
        const evictions = ctx.board.destroyTerritory(targetX, targetY);
        ctx.discardPile.push(oldUid);
        returnEvictedPieces(ctx, evictions);
        return;
    }
    if (newCardUid === undefined) {
        throw new GnosticaRulesError("A replacement card is required unless the territory is fully destroyed.");
    }
    const pile = opts.replacementSource === "discard" ? ctx.discardPile : ctx.hand;
    const newCard = takeFromPile(pile, newCardUid);
    const newValue = cardPointValue(newCard);
    if (newValue !== resultValue) {
        pile.push(newCardUid); // undo the take before reporting failure
        throw new GnosticaRulesError(`Attacking for ${pips} pips leaves a territory worth ${resultValue}, but "${newCardUid}" is worth ${newValue}.`);
    }
    ctx.discardPile.push(oldUid);
    ctx.board.shrinkTerritory(targetX, targetY, newCard);
};
