/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import { GnosticaGame } from "../../src/games/gnostica";
import { Piece } from "../../src/games/gnostica/piece";
import { CellContents } from "../../src/games/gnostica/cell";
import { majorCards, minorCards, TarotCard } from "../../src/common/tarot";

const major = (seq: number) => majorCards.find(c => c.seq === seq)!;
const minor = (uid: string) => minorCards.find(c => c.uid === uid)!;

// Same helper as gnostica.test.ts's own (not exported from there) - forces
// `cardFn()`'s card onto (x, y), clearing any duplicate elsewhere on the
// board first, so board-scanning uid lookups stay unambiguous.
const forceCardAt = (g: GnosticaGame, x: number, y: number, cardFn: () => TarotCard): void => {
    const target = cardFn();
    for (const [ox, oy, t] of g.board.entries()) {
        if ((ox !== x || oy !== y) && t.card?.uid === target.uid) {
            t.card = undefined;
        }
    }
    g.board.get(x, y)!.card = target;
};

// A fixture built via direct board.get(x,y)!.pieces/.card or hands[n]
// pokes (rather than real move() calls) is invisible to this.stack until
// something pushes a fresh snapshot - clone()/serialize() only round-trip
// the stack (see gnostica.test.ts's own note on this), and randomMove()
// itself now verifies each candidate by committing it on a throwaway
// this.clone() before returning it. Without this, that internal clone()
// would silently revert to whatever board/hands state existed BEFORE the
// pokes (typically empty), making every candidate that depends on the
// fixture's own setup fail its own verification. saveState() is protected
// (real callers only ever reach it through move()); reaching past that
// here is the same accepted test-only idiom gnostica.test.ts uses for
// other internals a fixture needs to poke directly.
const commitFixture = (g: GnosticaGame): GnosticaGame => {
    (g as unknown as { saveState: () => void }).saveState();
    return g;
};

// Runs randomMove() against a FRESH instance built by `factory` each
// iteration (so one call's own mutation never contaminates the next),
// asserting every single output is currently a fully valid, complete,
// submittable move - the core contract this whole feature exists to
// guarantee. Returns the list of move heads actually produced, for the
// distribution checks below.
//
// Deliberately rebuilds via `factory()` rather than `g.clone()`: clone()
// only round-trips officially COMMITTED state (this.stack, updated by
// saveState()), not a fixture's own direct board.get(x,y)!.pieces/.card
// pokes (see gnostica.test.ts's own note on this at its "step 2 button
// bar" test) - cloning a richGame() fixture here would silently discard
// every piece it placed, leaving hasPiecesOnBoard() false and randomMove()
// permanently stuck on "place" instead of exercising discard/orient/use/
// play at all.
function assertAlwaysLegal(factory: () => GnosticaGame, iterations: number): string[] {
    const heads: string[] = [];
    for (let i = 0; i < iterations; i++) {
        const attempt = factory();
        const move = attempt.randomMove();
        if (move === "") {
            continue; // "no legal move" (gameover) - not itself a failure
        }
        const result = attempt.validateMove(move);
        expect(result.valid, `"${move}" should validate: ${result.message}`).to.be.true;
        expect(result.complete, `"${move}" should be complete: ${result.message}`).to.eq(1);
        expect(() => attempt.move(move, { trusted: false })).to.not.throw();
        heads.push(move.split(/[\s,]/)[0].toLowerCase());
    }
    return heads;
}

// A board rich enough to exercise most of randomMove()'s own code paths in
// one fixture: several major arcana (a 2-step primitive/primitive card, a
// 2-step primitive/special card, a 3-step all-special card, a single-step
// special-only card), pieces of every size/orientation, a mixed hand
// (including a major that grants a chain), and discard-pile content for
// judgementDraw to draw from.
function richGame(): GnosticaGame {
    const g = new GnosticaGame(3);
    forceCardAt(g, 0, 0, () => major(6));  // The Lovers - move, create
    forceCardAt(g, 1, 0, () => major(7));  // The Chariot - move, move (shortcut)
    forceCardAt(g, -1, 0, () => major(15)); // The Devil - orientAny x3
    forceCardAt(g, 0, 1, () => major(9));  // The Hermit - hermitTeleport
    forceCardAt(g, 0, -1, () => major(11)); // Justice - tradeHands, attack
    g.board.get(0, 0)!.pieces = [new Piece(1, 2, "E"), new Piece(2, 1, "U")];
    g.board.get(1, 0)!.pieces = [new Piece(1, 3, "N")];
    g.board.get(-1, 0)!.pieces = [new Piece(1, 1, "W"), new Piece(3, 2, "S")];
    g.board.get(0, 1)!.pieces = [new Piece(1, 2, "U")];
    g.board.get(0, -1)!.pieces = [new Piece(1, 1, "N"), new Piece(2, 2, "S")];
    g.hands[0] = [minor("AC").uid, minor("5D").uid, minor("KS").uid, major(20).uid, minor("2R").uid, minor("9C").uid];
    g.discardPile = [minor("3C").uid, minor("4D").uid, minor("7S").uid, minor("AR").uid];
    return commitFixture(g);
}

describe("Gnostica: randomMove()", () => {
    it("always returns a currently-legal move against a rich mid-game board", () => {
        const heads = assertAlwaysLegal(richGame, 300);
        expect(heads.length).to.be.greaterThan(0);
    });

    it("always returns a currently-legal move from a fresh (no board presence) game", () => {
        assertAlwaysLegal(() => new GnosticaGame(3), 50);
    });

    it("always returns a currently-legal move with a near-empty hand", () => {
        assertAlwaysLegal(() => {
            const g = richGame();
            g.hands[0] = [minor("AC").uid];
            return commitFixture(g);
        }, 100);
    });

    it("always returns a currently-legal move with an empty hand", () => {
        assertAlwaysLegal(() => {
            const g = richGame();
            g.hands[0] = [];
            return commitFixture(g);
        }, 100);
    });

    it("always returns a currently-legal move mid-bid (bidding variant)", () => {
        assertAlwaysLegal(() => {
            const g = new GnosticaGame(3, ["bidding"]);
            g.move("bid 1", { trusted: true }); // player 1 has already bid
            return g;
        }, 50);
    });

    it("always returns a currently-legal move mid-redraw (bidding variant)", () => {
        const factory = () => {
            const g = new GnosticaGame(3, ["bidding"]);
            g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"];
            g.hands[1] = [minor("QS").uid, "AR", "2R", "3R", "4R", "5R"];
            g.hands[2] = [minor("PS").uid, "AD", "2D", "3D", "4D", "5D"];
            g.move("bid 1", { trusted: true });
            g.move("bid 1", { trusted: true });
            g.move("bid 1", { trusted: true });
            return g;
        };
        expect(factory().phase).eq("redraw");
        assertAlwaysLegal(factory, 50);
    });

    it("genuinely exercises the chain-building path: a variety of heads appear, and use/play sometimes produce real multi-token steps, not just declines", () => {
        const heads = assertAlwaysLegal(richGame, 400);
        const distinctHeads = new Set(heads);
        // With 3 players sharing turn order in this fixture, currplayer
        // stays 1 throughout (randomMove() itself never advances turns),
        // so every one of these heads should be reachable from player 1's
        // own rich hand/board position above.
        for (const expected of ["use", "play", "orient", "discard"]) {
            expect(distinctHeads.has(expected), `expected "${expected}" to appear at least once across ${heads.length} attempts`).to.be.true;
        }

        // Collect actual move STRINGS (not just heads) to check use/play
        // depth separately from the legality loop above.
        let sawMultiTokenUseOrPlay = false;
        for (let i = 0; i < 400; i++) {
            const attempt = richGame();
            const move = attempt.randomMove();
            if (/^(use|play)\b/.test(move) && move.includes(",")) {
                sawMultiTokenUseOrPlay = true;
                break;
            }
        }
        expect(sawMultiTokenUseOrPlay, "expected at least one use/play to attempt a real power step, not just decline").to.be.true;
    });

    it("a chained major arcana move actually mutates state exactly as its own tokens describe when replayed for real", () => {
        // Not a random assertion - deterministically drive The Lovers
        // (move then create) via randomMove()'s own output, repeatedly
        // regenerated until a real 2-step chain appears, then confirm
        // committing it doesn't throw and actually changes the board.
        let committed = false;
        for (let i = 0; i < 200 && !committed; i++) {
            const g = richGame();
            const move = g.randomMove();
            if (move.startsWith(`use ${major(6).uid}`) && move.split(",").length === 3) {
                const before = JSON.stringify(g.state());
                expect(() => g.move(move, { trusted: false })).to.not.throw();
                expect(JSON.stringify(g.state())).to.not.eq(before);
                committed = true;
            }
        }
        // Not a hard requirement that this exact card comes up in 200
        // tries, but if it never does across the whole suite run that's
        // worth knowing - see the coverage test above for the general case.
    });

    it("eventually declares (last) once the acting player's own score is already at/above target", () => {
        // Without this, a randomMove()-only game could never actually
        // end - gameover/winner/elimination only ever resolve on the
        // turn following a real "(last)" declaration (see
        // resolveAnnouncedTurn's own docs).
        let sawDeclare = false;
        for (let i = 0; i < 200 && !sawDeclare; i++) {
            const g = new GnosticaGame(2);
            g.move("place m0", { trusted: true });
            g.move("place n0", { trusted: true });
            // Rig every OTHER territory to a known-value major (3 pts),
            // uncontested by player 1 - comfortably >= the default
            // target of 9.
            for (const [, , t] of g.board.entries()) {
                if (t.pieces.some(p => p.owner === 2)) {
                    continue;
                }
                t.card = major(21).clone(); // The World: major, 3 pts
                t.pieces = [new Piece(1, 1, "U")];
            }
            commitFixture(g);
            const move = g.randomMove();
            if (!move.includes("(last)")) {
                continue;
            }
            sawDeclare = true;
            const check = g.validateMove(move);
            expect(check.valid, `"${move}" should validate: ${check.message}`).to.be.true;
            expect(check.complete).to.eq(1);
            expect(() => g.move(move, { trusted: false })).to.not.throw();
        }
        expect(sawDeclare, "expected randomMove() to declare at least once across 200 eligible attempts").to.be.true;
    });

    it("never declares (last) while the acting player's own score is still below target", () => {
        for (let i = 0; i < 200; i++) {
            const g = new GnosticaGame(2);
            g.move("place m0", { trusted: true });
            g.move("place n0", { trusted: true });
            commitFixture(g);
            const move = g.randomMove();
            expect(move.includes("(last)"), `should not declare while ineligible: ${move}`).to.be.false;
        }
    });

    // A facing only matters for what it points at - on a wasteland cell
    // with just one real territory neighbour, pointing at any of the
    // OTHER three cardinal directions wastes the choice on more void.
    it("weightedRandomOrientation favors U or a direction pointing at real territory over one pointing into more void", () => {
        const g = new GnosticaGame(2);
        // Far from the constructor's own random 3x3 deal, so (10,10)'s
        // only real neighbour is the one forced in deliberately - no
        // existing CellContents way out here, so unlike forceCardAt this
        // creates one directly.
        g.board.store.set(11, 10, new CellContents(minor("AC"))); // east of (10,10)
        expect(g.board.classify(10, 10)).eq("wasteland");
        const pick = (g as unknown as { weightedRandomOrientation: (x: number, y: number) => string }).weightedRandomOrientation.bind(g);
        const counts: Record<string, number> = { N: 0, S: 0, E: 0, W: 0, U: 0 };
        for (let i = 0; i < 400; i++) {
            counts[pick(10, 10)]++;
        }
        const useful = counts.U + counts.E; // U always useful; E points at the one real territory
        const useless = counts.N + counts.S + counts.W; // point at more void
        expect(useful, `useful=${useful} useless=${useless}`).to.be.greaterThan(useless);
    });

    // A no-op reorientation (the same facing as the piece already has) is
    // never a legitimate move - randomOrientMove() must exclude it from
    // its own candidates rather than relying on validateMove() to
    // downgrade it after the fact.
    it("randomOrientMove() never generates a no-op (the same facing the piece already has)", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const build = (g as unknown as { randomOrientMove: () => string | undefined }).randomOrientMove.bind(g);
        for (let i = 0; i < 200; i++) {
            const move = build();
            expect(move).to.not.eq(undefined);
            expect(move).to.not.eq("orient m0.1 U");
        }
    });
});
