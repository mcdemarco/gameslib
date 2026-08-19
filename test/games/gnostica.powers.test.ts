/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import { Piece } from "../../src/games/gnostica/piece";
import { CellContents } from "../../src/games/gnostica/cell";
import { GnosticaBoard } from "../../src/games/gnostica/board";
import { minorCards, majorCards } from "../../src/common/tarot";
import {
    PowerContext, Stash,
    createOwn, createEnemy, createTerritory,
    movePiece, moveTerritory,
    growPiece, growTerritory,
    attackPiece, attackTerritory,
    orientMinion, orientAny, hierophantReplace,
    hermitMovePiece, hermitMoveTerritory, tradeHands,
    judgementDraw, highPriestess, fool, worldChoosePower,
} from "../../src/games/gnostica/powers";

const card = (uid: string) => minorCards.find(c => c.uid === uid) ?? majorCards.find(c => c.uid === uid)!;
const aceOfCups = () => card("AC");
const twoOfCups = () => card("2C");
const threeOfCups = () => card("3C");
const theFool = () => card("00");

const fullStash = (): Stash => [5, 5, 5];

const makeCtx = (board: GnosticaBoard, overrides: Partial<PowerContext> = {}): PowerContext => ({
    board,
    currplayer: 1,
    stashes: new Map([[1, fullStash()], [2, fullStash()]]),
    hand: [],
    discardPile: [],
    drawPile: [],
    ...overrides,
});

describe("Gnostica powers: Cups (create)", () => {
    it("adds an own small piece to the target cell, consuming the stash", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx = makeCtx(b);
        createOwn(ctx, 0, 0, 0, 0, 0, "N");
        const t = b.get(0, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 1, size: 1, orientation: "N" });
        expect(ctx.stashes.get(1)![0]).eq(4);
    });

    it("refuses to add past the 3-piece cap unless ignoreCapacity is set", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1), new Piece(1, 1), new Piece(1, 1)]));
        const ctx = makeCtx(b);
        expect(() => createOwn(ctx, 0, 0, 0, 0, 0, "N")).to.throw();
        createOwn(ctx, 0, 0, 0, 0, 0, "N", { ignoreCapacity: true });
        expect(b.get(0, 0)!.pieces.length).eq(4);
    });

    it("only targets its own cell (up) or the pointed-at adjacent cell", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "N")]));
        b.store.set(1, 0, new CellContents(twoOfCups()));
        const ctx = makeCtx(b);
        // minion at (0,0) points N, so (1,0) - to the east - is not a legal target
        expect(() => createOwn(ctx, 0, 0, 0, 1, 0, "N")).to.throw();
    });

    it("refuses to create an own piece in the void (a minion on an isolated wasteland facing away from any card)", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups()));
        // A minion sitting on a wasteland (adjacent to (0,0)'s card, but
        // no card of its own), facing further away from it - (2,0) is
        // void, not adjacent to any card at all. Reproduces a real bug:
        // a piece created here had no way to ever be evicted (unlike a
        // MOVED piece landing in the void, which movePiece destroys as
        // it goes), so it just sat there permanently.
        b.store.set(1, 0, new CellContents(undefined, [new Piece(1, 1, "E")]));
        const ctx = makeCtx(b);
        expect(() => createOwn(ctx, 1, 0, 0, 2, 0, "N")).to.throw();
        expect(b.get(2, 0)).to.be.undefined;
    });

    it("copies an enemy piece's own small piece, matching its orientation, from the enemy's stash", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U"), new Piece(2, 1, "W")]));
        const ctx = makeCtx(b);
        createEnemy(ctx, 0, 0, 0, 0, 0, 1);
        const t = b.get(0, 0)!;
        expect(t.pieces.length).eq(3);
        expect(t.pieces[2]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
        expect(ctx.stashes.get(2)![0]).eq(4); // enemy's stash, not the acting player's
        expect(ctx.stashes.get(1)![0]).eq(5);
    });

    it("refuses to copy your own piece", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U"), new Piece(1, 1, "W")]));
        const ctx = makeCtx(b);
        expect(() => createEnemy(ctx, 0, 0, 0, 0, 0, 1)).to.throw();
    });

    it("refuses to create an enemy copy in the void, same as createOwn", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups()));
        b.store.set(1, 0, new CellContents(undefined, [new Piece(1, 1, "E")]));
        const ctx = makeCtx(b);
        expect(() => createEnemy(ctx, 1, 0, 0, 2, 0, 0)).to.throw();
        expect(b.get(2, 0)).to.be.undefined;
    });

    it("creates a new territory on a wasteland from a spot card in hand", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        const ctx = makeCtx(b, { hand: ["2C"] });
        createTerritory(ctx, 0, 0, 0, 1, 0, "2C");
        expect(b.get(1, 0)!.card?.uid).eq("2C");
        expect(ctx.hand).to.deep.equal([]);
    });

    it("refuses to create a territory with a non-spot card", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        const ctx = makeCtx(b, { hand: ["KS"] });
        expect(() => createTerritory(ctx, 0, 0, 0, 1, 0, "KS")).to.throw();
    });

    it("refuses to create a territory on a wasteland occupied by enemies", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "W")]));
        b.store.set(-1, 0, new CellContents(undefined, [new Piece(2, 1, "U")]));
        const ctx = makeCtx(b, { hand: ["2C"] });
        expect(() => createTerritory(ctx, 0, 0, 0, -1, 0, "2C")).to.throw();
    });

    it("refuses to create a territory in the void", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        const ctx = makeCtx(b, { hand: ["2C"] });
        expect(() => createTerritory(ctx, 0, 0, 0, 5, 5, "2C")).to.throw();
    });

    it("Wheel of Fortune's random-draw mode pulls from the draw pile instead of hand", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        const ctx = makeCtx(b, { drawPile: ["3C"] });
        createTerritory(ctx, 0, 0, 0, 1, 0, undefined, { allowRandomDraw: true });
        expect(b.get(1, 0)!.card?.uid).eq("3C");
        expect(ctx.drawPile).to.deep.equal([]);
    });

    it("Wheel of Fortune's random-draw mode reshuffles the discard pile once the draw pile runs dry", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        const ctx = makeCtx(b, { drawPile: [], discardPile: ["3C"] });
        createTerritory(ctx, 0, 0, 0, 1, 0, undefined, { allowRandomDraw: true });
        expect(b.get(1, 0)!.card?.uid).eq("3C");
        expect(ctx.discardPile).to.deep.equal([]);
    });
});

describe("Gnostica powers: Rods (move)", () => {
    it("moves the minion itself up to its size in the direction it points", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 2, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups()));
        const ctx = makeCtx(b);
        movePiece(ctx, 0, 0, 0, 0, 0, 0, 1, "N");
        expect(b.get(0, 0)!.pieces.length).eq(0);
        const dest = b.get(1, 0)!;
        expect(dest.pieces.length).eq(1);
        expect(dest.pieces[0]).to.deep.include({ owner: 1, size: 2, orientation: "N" });
    });

    it("a minion standing up cannot use a rod at all", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx = makeCtx(b);
        expect(() => movePiece(ctx, 0, 0, 0, 0, 0, 0, 1, undefined)).to.throw();
    });

    it("pushes a targeted piece in the cell it's pointing at, retaining an enemy's orientation", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(2, 1, "S")]));
        b.store.set(2, 0, new CellContents(threeOfCups()));
        const ctx = makeCtx(b);
        movePiece(ctx, 0, 0, 0, 1, 0, 0, 1, "N"); // acting player 1 tries to reorient the pushed enemy piece to N
        expect(b.get(1, 0)!.pieces.length).eq(0);
        const dest = b.get(2, 0)!;
        expect(dest.pieces[0]).to.deep.include({ owner: 2, orientation: "S" }); // unchanged - not the mover's own piece
    });

    it("cannot move zero spaces, beyond its size, or into a full cell", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(1, 1), new Piece(1, 1), new Piece(1, 1)]));
        const ctxFull = makeCtx(b);
        expect(() => movePiece(ctxFull, 0, 0, 0, 0, 0, 0, 1, undefined)).to.throw(); // destination already has 3

        const b2 = new GnosticaBoard();
        b2.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        const ctxVoid = makeCtx(b2);
        expect(() => movePiece(ctxVoid, 0, 0, 0, 0, 0, 0, 5, undefined)).to.throw(); // beyond size 1
        expect(() => movePiece(ctxVoid, 0, 0, 0, 0, 0, 0, 0, undefined)).to.throw(); // zero spaces
    });

    // Unlike Hermit's teleport (which forbids the void outright), a Rod push
    // landing in the void is legal - the piece is simply destroyed, same as
    // any other piece that ends up there (a territory-push/destroy eviction,
    // for instance). A relaxed mid-chain waypoint (Chariot, skipLandingCheck)
    // is the one exception: the piece must persist there for the next step.
    it("a genuine final landing in the void destroys the piece, returning it to its owner's stash", () => {
        const b = new GnosticaBoard();
        // A size-1 piece can only move 1 space, and 1 space away from a
        // carded cell is always still a wasteland (adjacent) - only a
        // size-2+ piece moving 2+ spaces can actually clear the wasteland
        // border and reach genuine void.
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 2, "E")]));
        const ctx = makeCtx(b);
        movePiece(ctx, 0, 0, 0, 0, 0, 0, 2, undefined); // 2 spaces east of (0,0) - void, no card in reach
        expect(b.has(2, 0)).eq(false); // no phantom territory left behind
        expect(ctx.stashes.get(1)!).to.deep.equal([5, 6, 5]); // returned to the mover's own stash
    });

    it("a relaxed mid-chain waypoint in the void does NOT destroy the piece - it must still be there for the next step", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 2, "E")]));
        const ctx = makeCtx(b);
        movePiece(ctx, 0, 0, 0, 0, 0, 0, 2, undefined, { skipLandingCheck: true });
        expect(b.get(2, 0)!.pieces.length).eq(1); // still on the board, sitting in the void
        expect(ctx.stashes.get(1)!).to.deep.equal([5, 5, 5]); // NOT returned - the piece is still in play
    });

    it("ignoreCapacity (Emperor) lets a push land on an already-full cell", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(1, 1), new Piece(1, 1), new Piece(1, 1)]));
        const ctx = makeCtx(b);
        movePiece(ctx, 0, 0, 0, 0, 0, 0, 1, undefined, { ignoreCapacity: true });
        expect(b.get(1, 0)!.pieces.length).eq(4);
    });

    it("pushes the pointed-at territory, never the minion's own", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 3, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups()));
        const ctx = makeCtx(b);
        // Legality is checked against the board as it stands before the push,
        // so (2,0) still counts as a wasteland (adjacent to (1,0)'s card,
        // which hasn't left yet) even though (1,0) is about to be vacated.
        moveTerritory(ctx, 0, 0, 0, 1);
        // (1,0) had no pieces left behind, so the vacated cell is dropped entirely.
        expect(b.has(1, 0)).eq(false);
        expect(b.get(2, 0)!.card?.uid).eq("2C");
    });

    it("returns a piece stranded at the departure side of a push to its owner's stash", () => {
        // A territory can only be pushed if it holds no enemy pieces, so
        // anything stranded at the departure cell is necessarily the
        // acting player's own. The minion stands on a *wasteland* here
        // (not the territory it's pushing) - a card of its own would
        // permanently keep the departure cell adjacent to a territory,
        // making this eviction unreachable, since the minion is always
        // right next door to whatever it pushes.
        const b = new GnosticaBoard();
        b.store.set(-1, 0, new CellContents(threeOfCups())); // keeps (0,0) a wasteland throughout
        b.store.set(0, 0, new CellContents(undefined, [new Piece(1, 3, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(1, 1, "U")]));
        b.store.set(5, 0, new CellContents(aceOfCups())); // keeps the landing spot a legal wasteland
        const ctx = makeCtx(b);
        moveTerritory(ctx, 0, 0, 0, 3); // (1,0) -> (4,0), adjacent to (5,0)
        expect(b.get(4, 0)!.card?.uid).eq("2C");
        expect(b.has(1, 0)).eq(false);
        expect(ctx.stashes.get(1)!).to.deep.equal([6, 5, 5]);
    });

    it("refuses to push a territory occupied by enemies, into the void, or beyond size", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(2, 1, "U")]));
        const ctx = makeCtx(b);
        expect(() => moveTerritory(ctx, 0, 0, 0, 1)).to.throw(); // enemy-occupied

        const b2 = new GnosticaBoard();
        b2.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b2.store.set(1, 0, new CellContents(twoOfCups()));
        const ctx2 = makeCtx(b2);
        expect(() => moveTerritory(ctx2, 0, 0, 0, 5)).to.throw(); // beyond size, lands in void
    });
});

describe("Gnostica powers: Discs (grow)", () => {
    it("grows a piece one size larger from that piece owner's stash, freeing the old size back", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx = makeCtx(b);
        growPiece(ctx, 0, 0, 0, 0, 0, 0, "N");
        const t = b.get(0, 0)!;
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 2, orientation: "N" });
        expect(ctx.stashes.get(1)!).to.deep.equal([6, 4, 5]);
    });

    it("cannot grow a large piece further, or grow without the next size available", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(3, 3, "U")]));
        const ctx = makeCtx(b);
        expect(() => growPiece(ctx, 0, 0, 0, 0, 0, 0, undefined)).to.throw();

        const b2 = new GnosticaBoard();
        b2.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx2 = makeCtx(b2, { stashes: new Map([[1, [5, 0, 5] as Stash], [2, fullStash()]]) });
        expect(() => growPiece(ctx2, 0, 0, 0, 0, 0, 0, undefined)).to.throw();
    });

    it("grows a territory by exactly one point, discarding the old card", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx = makeCtx(b, { hand: ["KS"] });
        growTerritory(ctx, 0, 0, 0, 0, 0, "KS");
        expect(b.get(0, 0)!.card?.uid).eq("KS");
        expect(ctx.discardPile).to.deep.equal(["AC"]);
    });

    it("refuses to grow by more than one point without skipLadder, or to a card of equal/lower value", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx = makeCtx(b, { hand: ["00"] }); // major, worth 3 - too far without skipLadder
        expect(() => growTerritory(ctx, 0, 0, 0, 0, 0, "00")).to.throw();
        expect(ctx.hand).to.deep.equal(["00"]); // failed attempt returns the card to hand

        const ctxSame = makeCtx(b, { hand: ["2C"] }); // AC is worth 1, 2C is also worth 1 - not a growth
        expect(() => growTerritory(ctxSame, 0, 0, 0, 0, 0, "2C")).to.throw();
        expect(ctxSame.hand).to.deep.equal(["2C"]);
    });

    it("Strength's skipLadder allows jumping a spot card straight to a major arcana", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx = makeCtx(b, { hand: ["00"] });
        growTerritory(ctx, 0, 0, 0, 0, 0, "00", { skipLadder: true });
        expect(b.get(0, 0)!.card?.uid).eq("00");
    });

    it("Star's replacementSource=discard draws the new card from the discard pile instead of hand", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx = makeCtx(b, { discardPile: ["KS"] });
        growTerritory(ctx, 0, 0, 0, 0, 0, "KS", { replacementSource: "discard" });
        expect(b.get(0, 0)!.card?.uid).eq("KS");
        expect(ctx.discardPile).to.deep.equal(["AC"]); // old card discarded, new one already left the pile
    });

    it("refuses to grow a territory occupied by enemies", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(2, 1, "U")]));
        const ctx = makeCtx(b, { hand: ["KS"] });
        expect(() => growTerritory(ctx, 0, 0, 0, 0, 0, "KS")).to.throw();
    });
});

describe("Gnostica powers: Swords (attack)", () => {
    it("shrinks a piece, replacing it with a smaller piece from the VICTIM's own stash", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 3, "U"), new Piece(2, 2, "N")]));
        const ctx = makeCtx(b);
        attackPiece(ctx, 0, 0, 0, 0, 0, 1, 1, undefined);
        const t = b.get(0, 0)!;
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "N" });
        expect(ctx.stashes.get(2)!).to.deep.equal([4, 6, 5]); // took a small out, freed the old medium back in
    });

    it("destroys a piece outright at 0 pips, returning its full size to the victim's stash", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 2, "U"), new Piece(1, 2, "N")]));
        const ctx = makeCtx(b);
        attackPiece(ctx, 0, 0, 0, 0, 0, 1, 2, undefined);
        expect(b.get(0, 0)!.pieces.length).eq(1);
        expect(ctx.stashes.get(1)!).to.deep.equal([5, 6, 5]);
    });

    it("cannot shrink to a size unavailable in the victim's stash, unless skipStashCheck is set", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U"), new Piece(2, 3, "N")]));
        const ctx = makeCtx(b, { stashes: new Map([[1, fullStash()], [2, [5, 0, 5] as Stash]]) });
        expect(() => attackPiece(ctx, 0, 0, 0, 0, 0, 1, 1, undefined)).to.throw();
        attackPiece(ctx, 0, 0, 0, 0, 0, 1, 1, undefined, { skipStashCheck: true }); // Death's shortcut
        expect(b.get(0, 0)!.pieces[1].size).eq(2);
    });

    it("may not attack for more pips than the victim has, or for zero", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 3, "U"), new Piece(2, 1, "N")]));
        const ctx = makeCtx(b, { stashes: new Map([[1, fullStash()], [2, fullStash()]]) });
        expect(() => attackPiece(ctx, 0, 0, 0, 0, 0, 1, 2, undefined)).to.throw(); // victim only has 1 pip
        expect(() => attackPiece(ctx, 0, 0, 0, 0, 0, 1, 0, undefined)).to.throw(); // zero pips
    });

    it("shrinks a territory's value, discarding the old card and requiring an exact-value replacement", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(theFool(), [new Piece(1, 3, "U")])); // worth 3
        const ctx = makeCtx(b, { hand: ["KS"] }); // worth 2
        attackTerritory(ctx, 0, 0, 0, 0, 0, 1, "KS");
        expect(b.get(0, 0)!.card?.uid).eq("KS");
        expect(ctx.discardPile).to.deep.equal(["00"]);
    });

    it("fully destroys a territory with no replacement card, returning every stranded piece to its owner's stash", () => {
        // A territory can only be attacked if it has no enemy pieces on it
        // (same "not occupied by enemy pieces" rule as Rods/Discs), so any
        // pieces caught in a self-destroyed territory are necessarily the
        // attacker's own. Icehouse pieces are never removed from the game
        // outright, though - "destroyed" just means "returned to stash",
        // same as a 0-pip piece attack. A *neighbouring* cell that collapses
        // into the void as a side effect can belong to anyone, and is
        // returned to its owner's stash the same way.
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 3, "U"), new Piece(1, 1, "N")]));
        b.store.set(1, 0, new CellContents(undefined, [new Piece(2, 1, "U")]));
        const ctx = makeCtx(b, { stashes: new Map([[1, fullStash()], [2, fullStash()]]) });
        attackTerritory(ctx, 0, 0, 0, 0, 0, 1, undefined); // aceOfCups is worth 1, so 1 pip destroys it
        expect(b.has(0, 0)).eq(false);
        expect(b.has(1, 0)).eq(false);
        // (0,0) has no other territory neighbour, so once its card is gone
        // the cell itself collapses to void too - taking the attacking
        // minion (size 3) down with its own second piece (size 1), both
        // returned to stash:
        expect(ctx.stashes.get(1)!).to.deep.equal([6, 5, 6]);
        // The neighbour's stranded piece (owner 2, size 1) is returned too:
        expect(ctx.stashes.get(2)!).to.deep.equal([6, 5, 5]);
    });

    it("refuses a replacement card that isn't worth exactly the post-attack value", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(theFool(), [new Piece(3, 3, "U")]));
        const ctx = makeCtx(b, { hand: ["AC"] }); // worth 1, but attacking for 1 pip should leave value 2
        expect(() => attackTerritory(ctx, 0, 0, 0, 0, 0, 1, "AC")).to.throw();
        expect(ctx.hand).to.deep.equal(["AC"]); // failed attempt returns the card to hand
    });

    it("refuses to attack a territory occupied by enemies", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(theFool(), [new Piece(2, 1, "U")]));
        const ctx = makeCtx(b, { hand: ["KS"] });
        expect(() => attackTerritory(ctx, 0, 0, 0, 0, 0, 1, "KS")).to.throw();
    });
});

describe("Gnostica powers: special (major arcana)", () => {
    it("orientMinion reorients any of the acting player's own minions, with no adjacency restriction", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "N")]));
        const ctx = makeCtx(b);
        orientMinion(ctx, 0, 0, 0, "W");
        expect(b.get(0, 0)!.pieces[0].orientation).eq("W");
    });

    it("orientMinion refuses to reorient an opponent's piece", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(2, 1, "N")]));
        const ctx = makeCtx(b);
        expect(() => orientMinion(ctx, 0, 0, 0, "W")).to.throw();
    });

    it("orientAny (Devil) can reorient an opponent's piece, but only a legally-targeted one", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(2, 1, "S")]));
        const ctx = makeCtx(b);
        orientAny(ctx, 0, 0, 0, 1, 0, 0, "N");
        expect(b.get(1, 0)!.pieces[0].orientation).eq("N");
    });

    it("orientAny still enforces the minion's own self/adjacent targeting rule", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "N")])); // points N, not E
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(2, 1, "S")]));
        const ctx = makeCtx(b);
        expect(() => orientAny(ctx, 0, 0, 0, 1, 0, 0, "N")).to.throw();
    });

    it("Hierophant replaces a target piece with the acting player's own, same size, from their stash", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(2, 2, "S")]));
        const ctx = makeCtx(b);
        hierophantReplace(ctx, 0, 0, 0, 1, 0, 0, "N");
        const dest = b.get(1, 0)!;
        expect(dest.pieces[0]).to.deep.include({ owner: 1, size: 2, orientation: "N" });
        expect(ctx.stashes.get(1)!).to.deep.equal([5, 4, 5]); // took a medium from the acting player
        expect(ctx.stashes.get(2)!).to.deep.equal([5, 6, 5]); // displaced piece returned to its own owner
    });

    it("Hierophant cannot replace with a size the acting player doesn't have", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(2, 3, "S")]));
        const ctx = makeCtx(b, { stashes: new Map([[1, [5, 5, 0] as Stash], [2, fullStash()]]) });
        expect(() => hierophantReplace(ctx, 0, 0, 0, 1, 0, 0, "N")).to.throw();
    });

    it("Hermit moves a piece to any completely empty cell on the board, ignoring adjacency", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        b.store.set(9, 9, new CellContents(twoOfCups())); // far away, empty of pieces
        const ctx = makeCtx(b);
        hermitMovePiece(ctx, 0, 0, 0, 0, 0, 0, 9, 9, "S");
        expect(b.get(0, 0)!.pieces.length).eq(0);
        expect(b.get(9, 9)!.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "S" });
    });

    it("Hermit refuses a destination that already holds a piece, or the void", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        b.store.set(9, 9, new CellContents(twoOfCups(), [new Piece(2, 1, "U")]));
        const ctx = makeCtx(b);
        expect(() => hermitMovePiece(ctx, 0, 0, 0, 0, 0, 0, 9, 9, undefined)).to.throw(); // occupied
        expect(() => hermitMovePiece(ctx, 0, 0, 0, 0, 0, 0, 50, 50, undefined)).to.throw(); // void
    });

    it("Hermit moves a territory to any wasteland, leaving its pieces behind, evicting anyone stranded", () => {
        const b = new GnosticaBoard();
        b.store.set(-1, 0, new CellContents(threeOfCups())); // keeps (0,0) a wasteland throughout
        b.store.set(0, 0, new CellContents(undefined, [new Piece(1, 1, "E")])); // minion on a wasteland, pointing at (1,0)
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(1, 1, "U")]));
        b.store.set(9, 9, new CellContents(aceOfCups())); // keeps the landing spot a legal wasteland
        const ctx = makeCtx(b);
        hermitMoveTerritory(ctx, 0, 0, 0, 1, 0, 9, 8);
        expect(b.has(1, 0)).eq(false); // stranded, evicted
        expect(b.get(9, 8)!.card?.uid).eq("2C");
        expect(ctx.stashes.get(1)!).to.deep.equal([6, 5, 5]);
    });

    it("trade hands swaps the acting player's hand with the targeted piece owner's, in place", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "E")]));
        b.store.set(1, 0, new CellContents(twoOfCups(), [new Piece(2, 1, "U")]));
        const mine = ["AC", "2C"];
        const theirs = ["KS"];
        const ctx = makeCtx(b, { hand: mine });
        const owner = tradeHands(ctx, 0, 0, 0, 1, 0, 0, theirs);
        expect(owner).eq(2);
        expect(mine).to.deep.equal(["KS"]);
        expect(theirs).to.deep.equal(["AC", "2C"]);
        expect(ctx.hand).to.deep.equal(mine); // still the same live array reference
    });

    it("Judgement draws chosen cards from the discard pile, capped at pips and at the 6-card hand limit", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 2, "U")]));
        const ctx = makeCtx(b, { hand: ["AC", "2C", "3C"], discardPile: ["KS", "00"] });
        judgementDraw(ctx, 0, 0, 0, ["KS", "00"]);
        expect(ctx.hand).to.deep.equal(["AC", "2C", "3C", "KS", "00"]);
        expect(ctx.discardPile).to.deep.equal([]);
    });

    it("Judgement refuses to draw more than the minion's pip count", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        const ctx = makeCtx(b, { discardPile: ["KS", "00"] });
        expect(() => judgementDraw(ctx, 0, 0, 0, ["KS", "00"])).to.throw();
    });

    it("High Priestess discards chosen cards then redraws up to 6, drawing the just-discarded card back out via reshuffle once the draw pile empties", () => {
        const b = new GnosticaBoard();
        const ctx = makeCtx(b, { hand: ["AC", "2C"], discardPile: [], drawPile: ["KS"] });
        highPriestess(ctx, ["AC"]);
        // Only 3 cards exist anywhere (2C, KS, AC), so all 3 end up in hand -
        // the reshuffle even pulls the just-discarded AC back in, since the
        // rules make reshuffling unconditional.
        expect(ctx.hand).to.deep.equal(["2C", "KS", "AC"]);
        expect(ctx.discardPile).to.deep.equal([]);
        expect(ctx.drawPile).to.deep.equal([]);
    });

    it("High Priestess reshuffles the discard pile into the draw pile mid-redraw if the draw pile runs dry", () => {
        const b = new GnosticaBoard();
        const ctx = makeCtx(b, { hand: ["AC", "2C"], discardPile: ["3C"], drawPile: [] });
        highPriestess(ctx, ["AC"]);
        expect(ctx.hand.slice().sort()).to.deep.equal(["2C", "3C", "AC"].sort());
        expect(ctx.discardPile).to.deep.equal([]);
        expect(ctx.drawPile).to.deep.equal([]);
    });

    it("High Priestess stops redrawing once there is genuinely nothing left in either pile", () => {
        const b = new GnosticaBoard();
        const ctx = makeCtx(b, { hand: ["AC", "2C"], discardPile: [], drawPile: [] });
        highPriestess(ctx, []); // decline to discard anything
        expect(ctx.hand).to.deep.equal(["AC", "2C"]);
        expect(ctx.discardPile).to.deep.equal([]);
        expect(ctx.drawPile).to.deep.equal([]);
    });

    it("Fool flips the top of the draw pile into the discard pile and returns it", () => {
        const b = new GnosticaBoard();
        const ctx = makeCtx(b, { drawPile: ["KS", "AC"] });
        const flipped = fool(ctx);
        expect(flipped.uid).eq("KS");
        expect(ctx.drawPile).to.deep.equal(["AC"]);
        expect(ctx.discardPile).to.deep.equal(["KS"]);
    });

    it("Fool reshuffles the discard pile into the draw pile if the draw pile is empty", () => {
        const b = new GnosticaBoard();
        const ctx = makeCtx(b, { drawPile: [], discardPile: ["3C"] });
        const flipped = fool(ctx);
        expect(flipped.uid).eq("3C");
        expect(ctx.drawPile).to.deep.equal([]);
        expect(ctx.discardPile).to.deep.equal(["3C"]);
    });

    it("Fool refuses to flip when both the draw pile and discard pile are empty", () => {
        const b = new GnosticaBoard();
        const ctx = makeCtx(b, { drawPile: [], discardPile: [] });
        expect(() => fool(ctx)).to.throw();
    });

    it("World validates the chosen major arcana card is actually on the board, and returns its definition", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(theFool()));
        const ctx = makeCtx(b);
        const def = worldChoosePower(ctx, "00");
        expect(def.name).eq("The Fool");
    });

    it("World refuses to borrow the power of a major arcana card that isn't on the board", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups()));
        const ctx = makeCtx(b);
        expect(() => worldChoosePower(ctx, "00")).to.throw();
    });
});
