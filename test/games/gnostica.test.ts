/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import i18next from "i18next";
import { addResource } from "../../src";
import { GnosticaGame } from "../../src/games/gnostica";
import { Piece } from "../../src/games/gnostica/piece";
import { GnosticaBoard } from "../../src/games/gnostica/board";
import { CellContents } from "../../src/games/gnostica/cell";
import { majorCards, minorCards, TarotCard } from "../../src/common/tarot";

const theWorld = () => majorCards.find(c => c.rank.seq === 21)!;
const major = (seq: number) => majorCards.find(c => c.rank.seq === seq)!;
const card = (uid: string) => minorCards.find(c => c.uid === uid)!;
const aceOfCups = () => card("AC");
const aceOfRods = () => card("AR");
const aceOfDiscs = () => card("AD");
const aceOfSwords = () => card("AS");

// Forces `cardFn()`'s card onto (x, y), first clearing that same uid from
// wherever the random initial 3x3 deal happened to already put it -
// necessary now that "use <uid>" resolves a card by scanning the board for
// a matching uid rather than by cell, so a leftover duplicate elsewhere on
// the board would make it ambiguous (or resolve to the wrong cell) which
// one a test's own "use" move actually means.
const forceCardAt = (g: GnosticaGame, x: number, y: number, cardFn: () => TarotCard): void => {
    const target = cardFn();
    for (const [ox, oy, t] of g.board.entries()) {
        if ((ox !== x || oy !== y) && t.card?.uid === target.uid) {
            t.card = undefined;
        }
    }
    const t = g.board.get(x, y);
    if (t !== undefined) {
        t.card = target;
    } else {
        g.board.store.set(x, y, new CellContents(target));
    }
};

// Wipes the constructor's own randomly-dealt initial 3x3 grid entirely,
// so a test can build a fully deterministic board from scratch instead
// of relying on forceCardAt alone - forceCardAt only controls its OWN
// target cell; every other cell (and every other card's random position)
// is still whatever the constructor happened to deal, which occasionally
// collides with a test's own assumptions (e.g. forceCardAt's own
// duplicate-clearing wiping out a DIFFERENT cell the test still needed a
// card at, if that card was randomly dealt there too). Use together with
// forceCardAt (now tolerant of missing CellContents) to name every cell a
// test actually cares about, leaving everything else void/wasteland by
// construction rather than by chance.
const clearBoard = (g: GnosticaGame): void => {
    for (const [x, y] of g.board.store.getAllPositions()) {
        g.board.store.delete(x, y);
    }
};

// Hand sorting now happens only in render() (it sorts a local copy of the
// hand, not this.hands itself - see render()'s own "Hand sorting is now
// done in the render only" comment), so any test that cares about sort
// order has to read it back off the rendered hand area, not the raw
// array. Strips the "_new" highlight suffix (see newHandCardUids's own
// docs) the same way the real hand_ click handler does.
const renderedHandUids = (g: GnosticaGame, player: number): string[] => {
    const rep = g.render() as { areas?: { type: string; ownerMark?: number; pieces?: string[] }[] };
    const area = rep.areas?.find(a => a.type === "pieces" && a.ownerMark === player);
    return (area?.pieces ?? []).map(key => key.replace(/^hand_/, "").replace(/_new$/, ""));
};

describe("Gnostica: setup", () => {
    it("deals 6 cards to each player, tiles a 3x3 grid, and stocks full stashes", () => {
        const g = new GnosticaGame(4);
        expect(g.hands.length).eq(4);
        for (const h of g.hands) {
            expect(h.length).eq(6);
        }
        let territoryCount = 0;
        for (const [, , t] of g.board.entries()) {
            if (t.card !== undefined) {
                territoryCount++;
            }
        }
        expect(territoryCount).eq(9);
        expect(g.drawPile.length).eq(78 - 9 - 6 * 4);
        expect(g.discardPile.length).eq(0);
        for (let p = 1; p <= 4; p++) {
            expect(g.stashes.get(p as 1 | 2 | 3 | 4)).to.deep.equal([5, 5, 5]);
        }
        expect(g.currplayer).eq(1); // player 1 is the starting player by definition
    });

    it("no two dealt/tiled cards repeat a uid (deck integrity)", () => {
        const g = new GnosticaGame(3);
        const seen = new Set<string>();
        const all: string[] = [...g.hands.flat(), ...g.drawPile];
        for (const [, , t] of g.board.entries()) {
            if (t.card !== undefined) {
                all.push(t.card.uid);
            }
        }
        expect(all.length).eq(78);
        for (const uid of all) {
            expect(seen.has(uid), `duplicate uid ${uid}`).eq(false);
            seen.add(uid);
        }
    });

    it("\"no-majors\" variant: no major arcana on the opening board, but they're still fully in the mix for hands and the draw pile", () => {
        const g = new GnosticaGame(4, ["no-majors"]);
        let territoryCount = 0;
        for (const [, , t] of g.board.entries()) {
            if (t.card !== undefined) {
                territoryCount++;
                expect(t.card.major, `${t.card.uid} is a major arcana card on the opening board`).eq(false);
            }
        }
        expect(territoryCount).eq(9);
        // No restriction on hands or the draw pile - every major is still
        // somewhere in the mix, same total deck as always.
        const all: string[] = [...g.hands.flat(), ...g.drawPile];
        for (const [, , t] of g.board.entries()) {
            if (t.card !== undefined) {
                all.push(t.card.uid);
            }
        }
        expect(all.length).eq(78);
        expect(new Set(all).size).eq(78); // no duplicates, nothing lost
        const majorUidsSeen = all.filter(uid => majorCards.some(c => c.uid === uid)).length;
        expect(majorUidsSeen).eq(majorCards.length); // every major arcana card is accounted for
    });
});

describe("Gnostica: hand sort order", () => {
    // Sort order is deliberately simple - handSortKey just reads position
    // in allCards(), i.e. [...minorCards, ...majorCards] (see its own
    // docs): minors first (grouped by suit, ranked within it, since
    // minorCards itself is built that way), then majors by seq.
    it("a fresh non-bidding game renders hands already in rank order: minors first (grouped by suit and ranked within it), then majors by seq", () => {
        const g = new GnosticaGame(3);
        for (let p = 1; p <= g.numplayers; p++) {
            const cards = renderedHandUids(g, p).map(uid => majorCards.find(c => c.uid === uid) ?? minorCards.find(c => c.uid === uid)!);
            let seenMajor = false;
            let lastSuitSeq = -Infinity;
            let lastRankSeq = -Infinity;
            let lastMajorSeq = -Infinity;
            for (const c of cards) {
                if (c.major) {
                    seenMajor = true;
                    expect(c.rank.seq).to.be.greaterThan(lastMajorSeq);
                    lastMajorSeq = c.rank.seq;
                } else {
                    expect(seenMajor, `minor ${c.uid} appears after a major`).to.be.false;
                    const suitSeq = c.suit.seq;
                    const rankSeq = c.rank.seq;
                    if (suitSeq === lastSuitSeq) {
                        expect(rankSeq).to.be.greaterThan(lastRankSeq);
                    } else {
                        expect(suitSeq).to.be.greaterThan(lastSuitSeq);
                        lastRankSeq = -Infinity;
                    }
                    lastSuitSeq = suitSeq;
                    lastRankSeq = rankSeq;
                }
            }
        }
    });

    it("the bidding variant leaves the raw hand array in draw order even after a bid resolves; render() sorts it regardless", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        // Force a hand that's already known to be UNSORTED (a minor
        // before a major), so a spurious pass (already-sorted-by-luck)
        // can't hide a bug. major(21) (The World) is the highest-seq
        // major in the deck - bidding it guarantees player 1 wins
        // outright regardless of player 2's own uncontrolled random
        // hand (any major they might hold is seq <= 21 too, at best a
        // tie the code breaks toward the lower-numbered player anyway).
        g.hands[0] = [card("2R").uid, major(21).uid, card("AC").uid, "3C", "4C", "5C"];
        const beforeBid = [...g.hands[0]];
        // Position 2 (still hand-order, not sorted) is the major.
        g.move("bid 2", { trusted: true });
        // The bid card isn't actually pulled from hand until the round
        // resolves (see resolveBidRound's own docs) - hand order must
        // stay completely untouched by the bid itself.
        expect(g.hands[0]).to.deep.equal(beforeBid);
        g.move("bid 1", { trusted: true }); // player 2 - resolves the round (P1's major always wins)
        expect(g.bidWinner).eq(1);
        expect(g.phase).eq("redraw");
        // The bid major is gone (spent on the bid), so what's left is
        // minors - render() sorts them by suit/rank regardless of phase
        // (see renderedHandUids's own docs), even though g.hands[0]
        // itself is never touched by sorting at all.
        const cards = renderedHandUids(g, 1).map(uid => minorCards.find(c => c.uid === uid)!);
        for (let i = 1; i < cards.length; i++) {
            const a = cards[i - 1], b = cards[i];
            expect(a.suit.seq < b.suit.seq || (a.suit.seq === b.suit.seq && a.rank.seq < b.rank.seq)).to.be.true;
        }
    });

    it("renders sorted after an ordinary main-phase hand mutation (discard/draw)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.hands[0] = [card("5R").uid, major(1).uid, card("AC").uid, card("2C").uid, card("KS").uid, "3D"];
        // Fully deterministic: the real draw below could otherwise
        // (rarely) pull a duplicate of one of these same forced cards
        // straight back out of the draw pile, if the constructor's own
        // random deal happened to leave it there too - direct hand pokes
        // like this one don't remove the card from drawPile on their own.
        const forcedUids = new Set(g.hands[0]);
        g.drawPile = g.drawPile.filter(uid => !forcedUids.has(uid));
        g.move("discard 5R", { trusted: true }); // draws back to 6
        const cards = renderedHandUids(g, 1).map(uid => majorCards.find(c => c.uid === uid) ?? minorCards.find(c => c.uid === uid)!);
        let seenMajor = false;
        let lastSuitSeq = -Infinity;
        let lastRankSeq = -Infinity;
        let lastMajorSeq = -Infinity;
        for (const c of cards) {
            if (c.major) {
                seenMajor = true;
                expect(c.rank.seq).to.be.greaterThan(lastMajorSeq);
                lastMajorSeq = c.rank.seq;
            } else {
                expect(seenMajor).to.be.false;
                if (c.suit.seq === lastSuitSeq) {
                    expect(c.rank.seq).to.be.greaterThan(lastRankSeq);
                } else {
                    expect(c.suit.seq).to.be.greaterThan(lastSuitSeq);
                    lastRankSeq = -Infinity;
                }
                lastSuitSeq = c.suit.seq;
                lastRankSeq = c.rank.seq;
            }
        }
    });
});

describe("Gnostica: new-card hand highlight", () => {
    type HandArea = { type: string; pieces?: string[]; label?: string };
    type RenderRep = { legend: Record<string, unknown>; areas?: HandArea[] };

    const player1HandArea = (rep: RenderRep): HandArea | undefined =>
        rep.areas?.find(a => a.type === "pieces" && a.pieces?.some(p => p.startsWith("hand_")));

    it("tags a newly drawn card with its own legend entry once it becomes that player's turn again", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.drawPile = [card("7C").uid, ...g.drawPile.filter(uid => uid !== card("7C").uid)];
        g.move("discard AC", { trusted: true }); // player 1 discards AC, draws 7C back
        expect(g.hands[0]).to.include(card("7C").uid);
        g.move("discard", { trusted: true }); // player 2's turn - now back to player 1
        expect(g.currplayer).eq(1);

        const rep = g.render() as RenderRep;
        const handArea = player1HandArea(rep);
        const newKey = `hand_${card("7C").uid}_new`;
        expect(newKey in rep.legend).to.be.true;
        expect(handArea?.pieces).to.include(newKey);
        // A card that was already there before last turn stays untagged.
        expect(handArea?.pieces).to.include(`hand_${card("2C").uid}`);
        expect(handArea?.pieces).to.not.include(`hand_${card("2C").uid}_new`);
    });

    it("the highlight disappears once the player starts building this turn's own move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.drawPile = [card("7C").uid, ...g.drawPile.filter(uid => uid !== card("7C").uid)];
        g.move("discard AC", { trusted: true });
        g.move("discard", { trusted: true });
        expect(g.currplayer).eq(1);
        // Confirm it WOULD show first, so this test isn't vacuous.
        expect(player1HandArea(g.render() as RenderRep)?.pieces).to.include(`hand_${card("7C").uid}_new`);

        g.move("discard", { partial: true, trusted: true }); // simulates the player's own first click
        const rep = g.render() as RenderRep;
        const handArea = player1HandArea(rep);
        expect(handArea?.pieces?.some(p => p.endsWith("_new"))).to.be.false;
    });

    it("does not highlight anything on a player's very first turn", () => {
        const g = new GnosticaGame(2);
        const rep = g.render() as RenderRep;
        const handArea = player1HandArea(rep);
        expect(handArea?.pieces?.some(p => p.endsWith("_new"))).to.be.false;
    });

    // Regression: the "_new" suffix is part of the CLICKABLE piece
    // identifier too (AreaPieces reuses the same string for both the
    // legend key and what the renderer reports back on click), not just
    // a cosmetic legend tag - a real click on a highlighted card must
    // still resolve to its own real uid.
    it("a real click on the highlighted card (its actual _new-suffixed piece id) still resolves, not 'not in hand'", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.drawPile = [card("7C").uid, ...g.drawPile.filter(uid => uid !== card("7C").uid)];
        g.move("discard AC", { trusted: true });
        g.move("discard", { trusted: true });
        expect(g.currplayer).eq(1);
        const newKey = `hand_${card("7C").uid}_new`;
        expect(player1HandArea(g.render() as RenderRep)?.pieces).to.include(newKey); // sanity - not vacuous
        const click = g.handleClick("", -1, -1, newKey);
        expect(click.valid).to.be.true;
        expect(click.move).eq(`discard ${card("7C").uid}`);
    });
});

describe("Gnostica: place", () => {
    it("places a small piece on an empty territory, defaulting to U", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        const t = g.board.get(0, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
    });

    it("accepts an explicit orientation", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 E", { trusted: true });
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("E");
    });

    it("draws the placed piece from the player's own stash", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        expect(g.stashes.get(1)).to.deep.equal([4, 5, 5]);
    });

    it("refuses to place a second time once you already have a piece on the board", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        // back to player 1
        expect(() => g.move("place l0")).to.throw();
    });

    it("refuses to place in the void", () => {
        const g = new GnosticaGame(2);
        expect(() => g.move("place a50")).to.throw(); // far outside the 3x3 grid - void
    });

    it("refuses to place on an already-occupied cell", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        expect(() => g.move("place m0")).to.throw(); // player 2, same cell
    });
});

describe("Gnostica: orient", () => {
    it("reorients your own piece", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 N", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2's own required placement
        g.move("orient m0.1 W", { trusted: true }); // player 1 again
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("W");
    });

    it("refuses to reorient an opponent's piece", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 N", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 1 - now legal, they've placed
        expect(() => g.move("orient m0.1 W")).to.throw(); // player 2, targeting player 1's piece
    });

    it("requires having placed a piece before any non-place action", () => {
        const g = new GnosticaGame(2);
        expect(() => g.move("discard")).to.throw();
    });
});

describe("Gnostica: discard", () => {
    it("discards named cards and redraws back to 6", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        const hand = [...g.hands[0]];
        const discard1 = hand[0];
        const discard2 = hand[1];
        g.move(`discard ${discard1} ${discard2}`, { trusted: true }); // player 1
        expect(g.hands[0].length).eq(6);
        expect(g.hands[0]).to.not.include(discard1);
        expect(g.hands[0]).to.not.include(discard2);
        expect(g.discardPile).to.include(discard1);
        expect(g.discardPile).to.include(discard2);
    });

    it("refuses to discard a card that isn't in hand", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        const notInHand = [...g.drawPile].find(uid => !g.hands[0].includes(uid))!;
        expect(() => g.move(`discard ${notInHand}`)).to.throw();
    });

    it("an explicit \"draw <n>\" draws exactly that many, not the max - it is legal to end up under 6", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        const hand = [...g.hands[0]];
        const discard1 = hand[0];
        const discard2 = hand[1];
        g.move(`discard ${discard1} ${discard2} draw 1`, { trusted: true }); // player 1
        expect(g.hands[0].length).eq(5); // 4 left after discarding 2, +1 drawn back
        expect(g.hands[0]).to.not.include(discard1);
        expect(g.hands[0]).to.not.include(discard2);
    });

    it("\"discard draw 0\" is a legal no-op turn - discards nothing, draws nothing", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        const before = [...g.hands[0]];
        g.move("discard draw 0", { trusted: true });
        expect(g.hands[0]).to.deep.equal(before);
    });

    it("refuses a \"draw <n>\" above the room left in a 6-card hand", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        const [discard1] = g.hands[0];
        // Only 1 discarded, so at most 1 can legally be drawn back.
        expect(() => g.move(`discard ${discard1} draw 2`)).to.throw();
    });

    it("refuses a negative or non-numeric \"draw <n>\"", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        expect(() => g.move("discard draw -1")).to.throw();
        expect(() => g.move("discard draw abc")).to.throw();
    });
});

describe("Gnostica: turn order", () => {
    it("advances currplayer around the table and back", () => {
        const g = new GnosticaGame(3);
        expect(g.currplayer).eq(1);
        g.move("place m0", { trusted: true });
        expect(g.currplayer).eq(2);
        g.move("place l0", { trusted: true });
        expect(g.currplayer).eq(3);
        g.move("place n0", { trusted: true });
        expect(g.currplayer).eq(1);
        g.move("discard", { trusted: true });
        expect(g.currplayer).eq(2);
        g.move("discard", { trusted: true });
        expect(g.currplayer).eq(3);
        g.move("discard", { trusted: true });
        expect(g.currplayer).eq(1);
    });
});

describe("Gnostica: turn order legend", () => {
    type KeyArea = { type: string; list?: { piece: string; name: string }[] };
    const keyArea = (g: GnosticaGame): KeyArea | undefined =>
        (g.render() as { areas?: KeyArea[] }).areas?.find(a => a.type === "key");

    it("does not appear for the default (non-bidding) variant, even with 3+ players", () => {
        const g = new GnosticaGame(3);
        expect(keyArea(g)).to.be.undefined;
    });

    it("does not appear for a 2-player bidding game - nothing to legend with only two players", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        expect(keyArea(g)).to.be.undefined;
    });

    it("appears for a 3+ player bidding game, defaulting to plain ascending order while still mid-bid", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        const area = keyArea(g);
        expect(area).to.not.be.undefined;
        expect(area!.list!.map(e => e.name)).to.deep.equal(["1st", "2nd", "3rd"]);
    });

    it("reorders to the rank order of what was bid once the round resolves (tournament rules)", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        g.hands[0] = [card("KS").uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [major(21).uid, "AR", "2R", "3R", "4R", "5R"]; // The World - unbeatable
        g.hands[2] = [card("QS").uid, "AD", "2D", "3D", "4D", "5D"];
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true }); // player 2's major wins
        g.move("bid 1", { trusted: true });
        expect(g.bidWinner).eq(2);
        // Winner (major) first, then King (player 1) over Queen (player 3)
        // among the minors - NOT seating order from the winner ([2,3,1]).
        const area = keyArea(g)!;
        expect(area.list!.map(e => e.piece)).to.deep.equal(["turnorder_p2", "turnorder_p1", "turnorder_p3"]);
    });
});

describe("Gnostica: bidding-variant player reordering and pass removal", () => {
    it("2-player: beginRedraw() lands directly on the loser with no forced pass, whichever player wins the bid", () => {
        const winner1 = new GnosticaGame(2, ["bidding"]);
        winner1.hands[0] = [major(21).uid, "AC", "2C", "3C", "4C", "5C"]; // The World - unbeatable
        winner1.hands[1] = [card("KS").uid, "AR", "2R", "3R", "4R", "5R"];
        winner1.move("bid 1", { trusted: true }); // player 1's major
        winner1.move("bid 1", { trusted: true }); // player 2's minor - resolves
        expect(winner1.bidWinner).eq(1);
        expect(winner1.phase).eq("redraw");
        expect(winner1.currplayer).eq(2); // loser redraws first, no forced pass in between
        expect(winner1.getPlies().some(p => p.results.some(r => r.type === "pass"))).eq(false);

        const winner2 = new GnosticaGame(2, ["bidding"]);
        winner2.hands[0] = [card("KS").uid, "AC", "2C", "3C", "4C", "5C"];
        winner2.hands[1] = [major(21).uid, "AR", "2R", "3R", "4R", "5R"]; // The World - unbeatable
        winner2.move("bid 1", { trusted: true });
        winner2.move("bid 1", { trusted: true }); // player 2's major - resolves
        expect(winner2.bidWinner).eq(2);
        expect(winner2.phase).eq("redraw");
        expect(winner2.currplayer).eq(1); // loser (player 1) redraws first
        expect(winner2.getPlies().some(p => p.results.some(r => r.type === "pass"))).eq(false);
    });

    it("moves()/validateMove()/randomMove() no longer offer or accept \"pass\" for a non-eliminated player during bidding/redraw", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = [major(21).uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [card("KS").uid, "AR", "2R", "3R", "4R", "5R"];
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        expect(g.phase).eq("redraw");
        expect(g.moves()).to.deep.equal([]);
        expect(g.validateMove("pass").valid).to.be.false;
        expect(g.randomMove()).to.not.eq("pass");
    });

    for (const numplayers of [2, 3] as const) {
        it(`turnOrder reorder (${numplayers}p): getPlies()/getRounds()/chatLog() stay correct across the bid resolution boundary`, () => {
            addResource("en");
            const g = new GnosticaGame(numplayers, ["bidding"]);
            g.hands[0] = [card("KS").uid, "AC", "2C", "3C", "4C", "5C"];
            g.hands[1] = [major(21).uid, "AR", "2R", "3R", "4R", "5R"]; // The World - unbeatable
            if (numplayers === 3) {
                g.hands[2] = [card("QS").uid, "AD", "2D", "3D", "4D", "5D"];
            }
            for (let i = 0; i < numplayers; i++) {
                g.move("bid 1", { trusted: true });
            }
            expect(g.bidWinner).eq(2);
            for (let i = 0; i < numplayers; i++) {
                const needed = 6 - g.hands[g.currplayer - 1].length;
                const picks = g.biddingPool.slice(0, needed);
                g.move(`redraw ${picks.join(" ")}`, { trusted: true });
            }
            expect(g.phase).eq("main");
            expect(g.currplayer).eq(2); // winner goes first
            g.move("place m0", { trusted: true }); // winner's first main-phase turn (no board presence yet)
            const plies = g.getPlies();
            expect(plies[plies.length - 1].actor).eq(2);
            const names = numplayers === 2 ? ["Alice", "Bob"] : ["Alice", "Bob", "Carol"];
            const log = g.chatLog(names);
            expect(log[log.length - 1].some(l => l.includes("Bob"))).eq(true);
        });
    }
});

describe("Gnostica: announce last turn / win / elimination", () => {
    it("wins if the announcing player has reached the target score on their following turn", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2 - keeps their own board presence legal
        // Rig every OTHER territory to a known-value card (major arcana, 3
        // pts), uncontested by player 1 - comfortably >= 9 total. Leave
        // player 2's own placed cell untouched so they can still act.
        for (const [, , t] of g.board.entries()) {
            if (t.pieces.some(p => p.owner === 2)) {
                continue;
            }
            t.card = theWorld().clone();
            t.pieces = [new Piece(1, 1, "U")];
        }
        g.move("discard (last)", { trusted: true }); // player 1 announces
        expect(g.lastTurnAnnouncedBy).eq(1);
        g.move("discard", { trusted: true }); // player 2's turn
        g.move("discard", { trusted: true }); // player 1's resolving turn
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([1]);
    });

    // Regression test for a reported bug: winning via resolveAnnouncedTurn()
    // sets this.gameover directly (unlike an elimination-triggered endgame,
    // where checkEOG() sets it only AFTER nextPlayer() already ran) - so
    // nextPlayer()'s own former "if (this.gameover) return" guard was
    // skipping the rotation specifically on the winning move itself,
    // leaving currplayer pinned to the winner instead of advancing past
    // them. External move-history/chat logs attribute move N to whichever
    // player stack[N-1].currplayer names, so a currplayer that doesn't
    // rotate on the final move makes it look like the PREVIOUS player
    // acted twice in a row instead of the actual winner having the last
    // turn. Checked for both 2 and 3 players, matching the report.
    for (const numplayers of [2, 3] as const) {
        it(`currplayer still rotates past the winner on the winning move itself (${numplayers}-player)`, () => {
            const g = new GnosticaGame(numplayers);
            const cells = ["m0", "l0", "n0"].slice(0, numplayers);
            for (const cell of cells) {
                g.move(`place ${cell}`, { trusted: true });
            }
            for (const [, , t] of g.board.entries()) {
                if (t.pieces.length > 0) {
                    continue; // leave every player's own placed piece alone
                }
                t.card = theWorld().clone();
                t.pieces = [new Piece(1, 1, "U")];
            }
            g.move("discard (last)", { trusted: true }); // player 1 announces
            for (let i = 1; i < numplayers; i++) {
                g.move("discard", { trusted: true }); // every other player
            }
            expect(g.currplayer).eq(1);
            g.move("discard", { trusted: true }); // player 1's resolving turn - wins
            expect(g.gameover).eq(true);
            expect(g.winner).to.deep.equal([1]);
            // The bug: this used to stay 1 (pinned to the winner) instead
            // of rotating to 2, exactly as every other move does.
            expect(g.currplayer).eq(2);
        });
    }

    it("eliminates the announcing player if they fall short of the target score, without ending the game with players left", () => {
        const g = new GnosticaGame(3);
        // Each player's single placed piece scores at most 3 (whatever card
        // it's on) - always short of the 9-point target, no board rigging needed.
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("place n0", { trusted: true }); // player 3
        const hand = [...g.hands[0]];
        expect(g.stashes.get(1)).to.deep.equal([4, 5, 5]); // one small piece placed
        g.move("discard (last)", { trusted: true }); // player 1 announces
        g.move("discard", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 3
        g.move("discard", { trusted: true }); // player 1's resolving turn - falls short
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.hands[0]).to.deep.equal([]);
        expect(g.gameover).eq(false); // players 2 and 3 remain
        // Rules text: an eliminated player discards their hand.
        for (const uid of hand) {
            expect(g.discardPile).to.include(uid);
        }
        // The board piece placed above is gone AND returned to stash,
        // rather than just vanishing.
        expect(g.board.get(0, 0)!.pieces.some(p => p.owner === 1)).eq(false);
        expect(g.stashes.get(1)).to.deep.equal([5, 5, 5]);
    });

    it("an eliminated player's own randomMove()/pass is a real, committable move that correctly skips them again", () => {
        const g = new GnosticaGame(3);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("place n0", { trusted: true }); // player 3
        g.move("discard (last)", { trusted: true }); // player 1 announces
        g.move("discard", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 3
        g.move("discard", { trusted: true }); // player 1's resolving turn - falls short, eliminated
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.currplayer).eq(2); // nextPlayer() already correctly skipped player 1

        // Force it to (incorrectly) be player 1's turn again, matching the
        // scenario randomMove()'s own eliminated check exists for - a
        // human would never see this via normal play, but the engine
        // should handle it gracefully regardless.
        g.currplayer = 1;
        const rm = g.randomMove();
        expect(rm).eq("pass");
        expect(g.validateMove(rm).valid).to.be.true;
        g.move(rm); // untrusted, exactly like a real client
        expect(g.currplayer).eq(2); // correctly advanced past the eliminated player again
        const last = g.results[g.results.length - 1] as { type: string; who?: number; why?: string };
        expect(last).to.deep.include({ type: "pass", who: 1, why: "eliminated" });
    });

    it("declares the sole remaining player the winner if elimination leaves only one player standing", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        g.move("discard (last)", { trusted: true }); // player 1 announces
        g.move("discard", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 1's resolving turn - falls short, eliminated
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([2]);
    });

    it("refuses to announce while another player's announcement hasn't resolved yet", () => {
        const g = new GnosticaGame(3);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("place n0", { trusted: true }); // player 3
        g.move("discard (last)", { trusted: true }); // player 1 announces
        expect(() => g.move("discard (last)")).to.throw(); // player 2 tries to announce too
    });

    it("\"target-8\" variant: 8 points wins, unlike the default target of 9", () => {
        const g = new GnosticaGame(2, ["target-8"]);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        g.board.get(0, 0)!.card = theWorld().clone(); // m0 (player 1's own piece already there): major, 3 pts
        g.board.get(-1, -1)!.pieces = [new Piece(1, 1, "U")];
        g.board.get(-1, -1)!.card = major(19).clone(); // The Sun: major, 3 pts - running total 6
        g.board.get(-1, 1)!.pieces = [new Piece(1, 1, "U")];
        g.board.get(-1, 1)!.card = card("KC"); // King of Cups: royalty, 2 pts - running total 8, exactly the target-8 threshold
        expect(g.getPlayerScore(1)).eq(8);
        g.move("discard (last)", { trusted: true }); // player 1 announces
        g.move("discard", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 1's resolving turn
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([1]);
    });

    it("\"target-10\" variant: 9 points (enough under the default target) falls short and eliminates instead", () => {
        const g = new GnosticaGame(2, ["target-10"]);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        g.board.get(0, 0)!.card = theWorld().clone(); // m0 (player 1's own piece already there): major, 3 pts
        g.board.get(-1, -1)!.pieces = [new Piece(1, 1, "U")];
        g.board.get(-1, -1)!.card = major(19).clone(); // The Sun: major, 3 pts - running total 6
        g.board.get(-1, 1)!.pieces = [new Piece(1, 1, "U")];
        g.board.get(-1, 1)!.card = major(13).clone(); // Death: major, 3 pts - running total 9, short of the target-10 threshold
        expect(g.getPlayerScore(1)).eq(9);
        g.move("discard (last)", { trusted: true }); // player 1 announces
        g.move("discard", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 1's resolving turn - falls short under target-10
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.gameover).eq(true); // only player 2 remains
        expect(g.winner).to.deep.equal([2]);
    });

    it("getPlies()/chatLog() stay correct across the elimination boundary (plyActor(), not a stale currplayer-1 guess)", () => {
        addResource("en");
        const g = new GnosticaGame(3);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("place n0", { trusted: true }); // player 3
        g.move("discard (last)", { trusted: true }); // player 1 announces
        g.move("discard", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 3
        g.move("discard", { trusted: true }); // player 1's resolving turn - falls short, eliminated
        expect(g.eliminated).to.deep.equal([1]);
        g.move("discard", { trusted: true }); // player 2's ordinary post-elimination turn
        const plies = g.getPlies();
        // Actor 1 never appears again once eliminated - nextPlayer()'s own
        // skip loop already guarantees this at the currplayer level, this
        // confirms getPlies()'s own plyActor()-based reconstruction agrees.
        const actorsAfterElimination = plies.slice(plies.findIndex(p => p.results.some(r => r.type === "eliminated")) + 1).map(p => p.actor);
        expect(actorsAfterElimination).to.not.include(1);
        expect(plies[plies.length - 1].actor).eq(2);
        const log = g.chatLog(["Alice", "Bob", "Carol"]);
        // The eliminated ply's own line still names the actual actor (Alice,
        // who WAS still currplayer for that ply) even though currplayer
        // itself has since moved on - the old `state.currplayer - 1` guess
        // would have misattributed this once elimination started skipping
        // seats.
        const eliminatedLine = log.find(node => node.some(l => l.includes("eliminated")));
        expect(eliminatedLine?.some(l => l.includes("Alice"))).eq(true);
        // The final, post-elimination line correctly names Bob, not a
        // stale/incorrect guess.
        const lastLine = log[log.length - 1];
        expect(lastLine.some(l => l.includes("Bob"))).eq(true);
    });

    it("chatLog()'s \"eliminated\" line uses the result's own r.who, not the generically-computed actor", () => {
        addResource("en");
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        g.move("discard (last)", { trusted: true }); // player 1 announces
        g.move("discard", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 1's resolving turn - falls short, eliminated
        expect(g.eliminated).to.deep.equal([1]);
        const log = g.chatLog(["Alice", "Bob"]);
        const eliminatedLine = log.find(node => node.some(l => l.includes("eliminated")));
        expect(eliminatedLine?.some(l => l.includes("Alice"))).eq(true);
    });
});

describe("Gnostica: sidebarScores", () => {
    it("reports each player's score, position i always player i+1's - never reordered by turn order", () => {
        const g = new GnosticaGame(3);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("place n0", { trusted: true }); // player 3
        g.board.get(0, 0)!.card = aceOfCups(); // player 1's own cell: spot, 1 pt
        g.board.get(-1, 0)!.card = card("KS"); // player 2's own cell: royalty, 2 pts
        g.board.get(1, 0)!.card = theWorld().clone(); // player 3's own cell: major, 3 pts
        const scores = g.sidebarScores();
        expect(scores).to.have.length(1);
        expect(scores[0].scores).to.deep.equal([1, 2, 3]);
        expect(scores[0].scores).to.deep.equal([g.getPlayerScore(1), g.getPlayerScore(2), g.getPlayerScore(3)]);
    });
});

describe("Gnostica: activate/play - minor arcana suit powers", () => {
    it("#49: a bare use with no power step is not yet submittable, but a trusted caller may still apply it (test setup, click-preview 'still declined so far' states)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        const validated = g.validateMove(`use ${aceOfCups().uid}`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(-1);
        expect(validated.message).eq(i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED"));
        g.move(`use ${aceOfCups().uid}`, { trusted: true }); // player 1, no power step
        expect(g.board.get(0, 0)!.pieces.length).eq(1); // nothing changed but the turn
        expect(g.currplayer).eq(2);
    });

    it("Cups (own): adds an own small piece to the target cell", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        g.move(`use ${aceOfCups().uid}, m0.1 own n0 U`, { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
        expect(g.stashes.get(1)![0]).eq(3); // one for the initial placement, one for this
    });

    it("Cups (enemy): adds a copy of a targeted enemy's small piece from THEIR stash", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        g.move(`use ${aceOfCups().uid}, m0.1 enemy n0 1`, { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
        expect(g.stashes.get(2)![0]).eq(3); // player 2's stash, not player 1's
    });

    it("Cups (new): creates a territory on a wasteland from a hand card", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, -1, 0, () => aceOfCups()); // l0
        g.move("place l0 W", { trusted: true }); // player 1, pointing further west
        g.move("place n0", { trusted: true }); // player 2
        // The random deal may not happen to include a spot minor - dedupe
        // and force one in, rather than relying on chance (a real flaky
        // failure otherwise, on the rare hand with none).
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        g.move(`use ${aceOfCups().uid}, l0.1 new k0 ${spotUid}`, { trusted: true });
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): moves the minion itself and reorients it", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move(`use ${aceOfRods().uid}, m0.1 piece m0.1 1 N`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, orientation: "N" });
    });

    it("Rods (tile): pushes the pointed-at territory further away", () => {
        const g = new GnosticaGame(2);
        // Fully deterministic (see clearBoard's own docs): the random
        // initial deal could otherwise occasionally put the Ace of Rods
        // itself at n0, which forceCardAt's own duplicate-clearing would
        // then wipe out from there, leaving no territory to push.
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfRods());
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0, the territory to be pushed
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2, onto the wasteland beside m0
        g.move(`use ${aceOfRods().uid}, m0.1 tile 1`, { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
    });

    // Real gameplay counterpart to the bare-board "keeps two genuinely
    // separate multi-cell clusters classified correctly" unit test in
    // gnostica.board.test.ts (identical geometry, fromX=1/toX=4) - that
    // test calls board.pushTerritory() directly, skipping turns, players,
    // and validateMove() entirely (see its own docs on why a bare board
    // is the right size for it). This version drives the exact same push
    // through a real player's "use" move, and also checks the OTHER
    // player's own, genuinely disconnected cluster stays independently
    // valid to interact with afterward.
    it("real gameplay: a Rods push across a genuine void gap validates and applies correctly, and both disconnected clusters stay independently usable", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, -1, 0, () => card("2C")); // l0 - cluster A
        forceCardAt(g, 0, 0, () => aceOfRods()); // m0 - cluster A, the acting minion's own card
        forceCardAt(g, 1, 0, () => card("KS")); // n0 - isolated card to be pushed
        // Cluster B, pre-existing, far away - a DIFFERENT uid than cluster
        // A's own "2C", since "use <uid>" resolves by scanning the whole
        // board for a matching uid (see forceCardAt's own docs) - reusing
        // one would make the final cross-cluster "use" check ambiguous,
        // and would also make THIS call's own duplicate-clearing wipe out
        // cluster A's card out from under it.
        forceCardAt(g, 5, 0, () => card("2D"));
        g.move("place m0 E", { trusted: true }); // player 1, facing n0
        g.move("place r0", { trusted: true }); // player 2, onto cluster B's own card

        // A real initial placement always starts at size 1 (see
        // MUST_PLACE_FIRST's own wording); bumped directly to 3 here so a
        // real, validated dist-3 push is reachable in one move, matching
        // the bare-board test's exact push (fromX=1, toX=4) rather than
        // needing several turns of Discs growth first, which isn't what
        // this test is about.
        g.board.get(0, 0)!.pieces[0].size = 3;

        const pushMove = `use ${aceOfRods().uid}, m0.3 tile 3`;
        expect(g.validateMove(pushMove).valid).to.be.true; // through real validation, not a trusted bypass
        g.move(pushMove);

        // Cluster A: unaffected.
        expect(g.board.classify(-1, 0)).eq("territory");
        expect(g.board.classify(0, 0)).eq("territory");
        // Departure cell: reverted to wasteland, still adjacent to m0.
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.classify(1, 0)).eq("wasteland");
        // The gap: genuinely disconnected from either cluster.
        expect(g.board.classify(2, 0)).eq("void");
        expect(g.board.classify(3, 0)).eq("wasteland"); // adjacent to the arrived card at q0
        // Arrival: a brand new 2-cell cluster with cluster B's pre-existing card.
        expect(g.board.classify(4, 0)).eq("territory");
        expect(g.board.get(4, 0)!.card?.uid).eq("KS");
        expect(g.board.classify(5, 0)).eq("territory");

        // Cluster B stays independently valid for its own owner to act
        // on, entirely unaffected by the unrelated push that happened
        // three cells away on the other side of a genuine void gap.
        expect(g.currplayer).eq(2);
        expect(g.validateMove(`use ${card("2D").uid}`).valid).to.be.true;
    });

    it("Discs (piece): grows the minion by one size", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move(`use ${aceOfDiscs().uid}, m0.1 piece m0.1 N`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2, orientation: "N" });
    });

    it("Discs (tile): grows the pointed-at territory's value by one, discarding the old card", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        const target = g.board.get(1, 0)!; // n0
        const oldUid = card("2C").uid;
        target.card = card("2C"); // a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const royaltyUid = "KS"; // King of Swords, worth 2 - injected so the test doesn't depend on the random deal
        g.hands[0].push(royaltyUid);
        g.move(`use ${aceOfDiscs().uid}, m0.1 tile n0 ${royaltyUid}`, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("Swords (piece): shrinks a targeted enemy piece, returning it to their stash", () => {
        const g = new GnosticaGame(2);
        clearBoard(g); // fully deterministic - see clearBoard's own docs
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, small piece, on the targeted cell - stash now [4,5,5]
        g.move(`use ${aceOfSwords().uid}, m0.1 piece n0.1 1`, { trusted: true });
        // n0 has no card of its own (cleared above) - once its only piece
        // is destroyed, pruneIfEmpty deletes the cell outright rather than
        // leaving empty CellContents behind (see pruneIfEmpty's own docs),
        // so board.get(1,0) itself becomes undefined, not just empty.
        expect(g.board.get(1, 0)?.pieces.length ?? 0).eq(0); // small piece, 1 pip = destroyed
        expect(g.stashes.get(2)![0]).eq(5); // destruction returns it, undoing the placement's draw
    });

    it("Swords (tile): shrinks the acting player's own uncontested territory's value", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        const oldUid = card("KS").uid; // King of Swords, worth 2
        forceCardAt(g, -1, 0, () => card("KS")); // l0
        g.move("place m0 W", { trusted: true }); // player 1, pointing at l0
        g.move("place n0", { trusted: true }); // player 2
        // The random deal may not happen to include a spot minor at all -
        // force one in rather than relying on chance (a real flaky failure
        // otherwise, on the rare hand with none).
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        g.move(`use ${aceOfSwords().uid}, m0.1 tile l0 1 ${spotUid}`, { trusted: true });
        expect(g.board.get(-1, 0)!.card?.uid).eq(spotUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("play: uses a hand card's power through any of the player's board pieces, then discards it", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1, defaults to "U" - no relation to the played card's suit
        g.move("place l0", { trusted: true }); // player 2
        const cupsUid = "2C";
        // The random deal may already hold a copy - dedupe first so the
        // post-play "not.include" assertion below can't see a leftover.
        g.hands[0] = g.hands[0].filter(c => c !== cupsUid);
        g.hands[0].push(cupsUid);
        // The minion at m0 points "U", so it can only target its own
        // cell - add the second piece there rather than at an adjacent one.
        g.move(`play ${cupsUid}, m0.1 own m0 U`, { trusted: true });
        expect(g.hands[0]).to.not.include(cupsUid);
        expect(g.discardPile).to.include(cupsUid);
        expect(g.board.get(0, 0)!.pieces.length).eq(2);
        expect(g.board.get(0, 0)!.pieces[1]).to.deep.include({ owner: 1, size: 1 });
    });

    it("refuses to use a uid that isn't a real card at all", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        expect(() => g.move("use ZZ")).to.throw(); // not a real card uid
    });

    it("refuses to use a real card uid that isn't currently on the board", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        const unplacedUid = g.drawPile[0]; // definitely not on the board
        expect(() => g.move(`use ${unplacedUid}`)).to.throw();
    });

    it("refuses to use a card the acting player has no minion on", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2, elsewhere
        // player 1's turn again after player 2's placement
        g.move("discard", { trusted: true });
        // now player 2's turn - they have no piece on m0
        expect(() => g.move(`use ${aceOfCups().uid}`)).to.throw();
    });

    it("refuses to USE World's power against a malformed target", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        // "C" isn't any major arcana card's own uid - checkWorldChoosePower
        // rejects it as NO_SUCH_MAJOR_ON_BOARD.
        expect(() => g.move(`use ${theWorld().uid}, m0.1 C own m0 U`)).to.throw();
    });

    // World is subject to #49 like every other major now (see the Fool/
    // World test suite below for full coverage) - declining its power
    // entirely still needs a trusted caller to bypass #49, exactly like
    // every other major arcana card.
    it("declining World's power outright is legal for a trusted caller, but not yet submittable untrusted (#49)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const validated = g.validateMove(`use ${theWorld().uid}`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(-1);
        expect(() => g.move(`use ${theWorld().uid}`, { trusted: true })).to.not.throw();
    });
});

describe("Gnostica: activate/play - major arcana chaining", () => {
    it("#49: declining every power step is not yet submittable, but a trusted caller may still apply it (test setup, click-preview 'still declined so far' states)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        const validated = g.validateMove(`use ${major(6).uid}`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(-1);
        expect(validated.message).eq(i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED"));
        g.move(`use ${major(6).uid}`, { trusted: true }); // no power steps at all
        expect(g.board.get(0, 0)!.pieces.length).eq(1);
        expect(g.currplayer).eq(2);
    });

    it("Lovers (move, then create): a pushed own piece becomes a minion for the second step", () => {
        const g = new GnosticaGame(2);
        // Fully deterministic (see clearBoard's own docs): the random
        // initial deal could otherwise occasionally put The Lovers
        // itself at n0, which forceCardAt's own duplicate-clearing would
        // then wipe out from under piece B, stranding it off-territory.
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0 - any real card, distinct from The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, pointing at n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")]; // own piece B, already on n0 (not on the Lovers)
        // A (m0) pushes B (n0) one space east to o0, reorienting it "U";
        // B, now at o0, is used for the Cups step to add a second piece there.
        g.move(`use ${major(6).uid}, m0.1 piece n0.1 1 U, o0.1 own o0 U`, { trusted: true });
        const dest = g.board.get(2, 0)!; // o0
        expect(dest.pieces.length).eq(2);
        expect(dest.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" }); // B, pushed and reoriented
        expect(dest.pieces[1]).to.deep.include({ owner: 1, size: 1, orientation: "U" }); // new piece from the Cups step

        // A genuine 2-step chain: one frame (state after step 1 only),
        // plus the final/live rep.
        expect(g.frames.length).eq(1);
        expect(g.frames[0].board.get(2, 0)?.pieces.length).eq(1); // B pushed here, Cups step not yet applied
        const reps = g.render() as { annotations?: { type: string }[] }[];
        expect(Array.isArray(reps)).eq(true);
        expect(reps.length).eq(2);

        // Frame 0's own annotations cover only step 1's effect (the
        // push) - not step 2's (the new piece), proving the _group/
        // annotation-flattening fix actually isolates each step, rather
        // than overlaying every step's own effect onto every frame.
        expect(reps[0].annotations?.map(a => a.type)).to.deep.equal(["move"]);
        // The final/live rep covers the whole turn, same as any ordinary
        // (non-chained) move already does today.
        expect(reps[1].annotations?.map(a => a.type).sort()).to.deep.equal(["enter", "move"]);
    });

    it("#47: chatLog() logs a line for EACH step of a chained move, not just one - proving _group unwrapping actually works", () => {
        addResource("en");
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")];
        g.move(`use ${major(6).uid}, m0.1 piece n0.1 1 U, o0.1 own o0 U`, { trusted: true });
        // Confirms the move's own results really are grouped (not flat) -
        // otherwise this test would pass even without the chat()-side
        // _group fix, since a flat result list needs no unwrapping at all.
        expect(g.results.filter(r => r.type === "_group")).to.have.length(2);
        const log = g.chatLog(["Alice", "Bob"]);
        const lastNode = log[log.length - 1];
        expect(lastNode.some(l => l.includes("moved"))).eq(true); // step 1 (rod-piece)
        expect(lastNode.some(l => l.includes("added"))).eq(true); // step 2 (cups-own)
    });

    // Regression test for task #45: validateMove() itself never mutates
    // the board, so a later step naming the exact minion an earlier step
    // in this SAME chain just moved/created had nowhere real to read it
    // from (checkX/getPiece in powers.ts threw NO_TERRITORY_TRACKED) -
    // the untrusted `move()` path (which calls validateMove() first)
    // crashed instead of validating or applying. The Lovers test above
    // only ever exercises this with {trusted: true}, which skips
    // validateMove() (and therefore this bug) entirely.
    it("Chariot (move, then move): an untrusted move validates and applies when step 2 acts through step 1's own relocated piece", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(7)); // The Chariot: move, then move
        forceCardAt(g, 3, 0, () => aceOfDiscs()); // keeps o0 (2,0) a genuine wasteland, not void
        g.move("place m0 E", { trusted: true }); // player 1, pointing east
        g.move("place l0", { trusted: true }); // player 2
        const move = `use ${major(7).uid}, m0.1 piece m0.1 1 E, n0.1 piece n0.1 1 E`;
        expect(g.validateMove(move).valid).to.be.true;
        expect(() => g.move(move, { trusted: false })).to.not.throw();
        const dest = g.board.get(2, 0)!; // o0
        expect(dest.pieces.length).eq(1);
        expect(dest.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "E" });
        expect(g.board.has(1, 0)).eq(false); // the waypoint at n0 is left empty

        // Frame 0 shows the piece at its intermediate (post-first-move)
        // position, n0 - not yet at its final position, o0.
        expect(g.frames.length).eq(1);
        expect(g.frames[0].board.get(1, 0)?.pieces.length).eq(1);
        expect(g.frames[0].board.get(2, 0)).eq(undefined);
    });

    it("Strength: a single grow step may skip straight from spot to major arcana (skipLadder)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(8)); // Strength
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        forceCardAt(g, 1, 0, () => card("AC")); // n0 - spot, worth 1
        g.hands[0].push("00"); // The Fool, worth 3 - injected regardless of the random deal
        g.move(`use ${major(8).uid}, m0.1 tile n0 00`, { trusted: true }); // only ONE of Strength's two grow steps needed
        expect(g.board.get(1, 0)!.card?.uid).eq("00");
    });

    it("Chariot: two rod steps on the same piece may pass through the void mid-chain", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(7)); // The Chariot
        g.board.get(0, 0)!.pieces = [new Piece(1, 3, "W")]; // large minion, pointing away from the grid
        // Step 1 (relaxed, not the last step): 3 west from m0 lands at j0,
        // which is void (no card within reach) - illegal as an ordinary
        // landing, legal here as Chariot's waypoint. Reorient east.
        // Step 2 (the last step, normal rules apply): 3 east from j0 lands
        // back on m0 - a real, legal landing (0 pieces there now, has a card).
        g.move(`use ${major(7).uid}, m0.3 piece m0.3 3 E, j0.3 piece j0.3 3 U`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(1);
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 3, orientation: "U" });
        expect(g.board.get(-3, 0)?.pieces.length ?? 0).eq(0); // nothing left stranded at the waypoint
    });

    it("Empress: orient-minion then create-ignoring-capacity", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(3)); // The Empress
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "N"), new Piece(1, 1, "U"), new Piece(1, 1, "U")]; // already 3 here
        // The first piece is size-1 facing N, uniquely identified among the
        // three (also size-1) pieces at m0 - the other two are identical
        // (owner+size+orientation), so once the first is reoriented to
        // match them, the second step's "m0.1" alone still resolves (to
        // the first array slot) via resolvePieceRef's true-duplicate
        // tie-break rather than an ambiguous-ref failure.
        g.move(`use ${major(3).uid}, m0.1.N U, m0.1 own m0 U`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(4); // ignoreCapacity let a 4th piece in
    });

    it("Devil: three orientAny steps, including reorienting the acting minion mid-chain", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(15)); // The Devil
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")]; // minion, standing
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")]; // an enemy piece, east of m0
        g.move(
            // Step 1: orient the minion itself from "U" to "E", so it can now target n0.
            // Step 2: orient the enemy piece at n0 to face away (W).
            `use ${major(15).uid}, m0.1 m0.1 E, m0.1 n0.1 W, m0.1 m0.1 U`,
            { trusted: true },
        );
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("U"); // reoriented twice, back to up
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, orientation: "W" }); // enemy piece reoriented too

        // A genuine 3-step chain: two frames (N-1), plus the final/live rep.
        expect(g.frames.length).eq(2);
        expect(g.frames[0].board.get(0, 0)!.pieces[0].orientation).eq("E"); // after step 1 only
        expect(g.frames[0].board.get(1, 0)!.pieces[0].orientation).eq("U"); // step 2 not yet applied
        expect(g.frames[1].board.get(0, 0)!.pieces[0].orientation).eq("E"); // still E after step 2
        expect(g.frames[1].board.get(1, 0)!.pieces[0].orientation).eq("W"); // step 2's own effect
        const reps = g.render() as unknown[];
        expect(Array.isArray(reps)).eq(true);
        expect(reps.length).eq(3);

        // Confirms this.results was genuinely grouped, one _group per
        // step, not left flat.
        const groups = g.results.filter(r => r.type === "_group");
        expect(groups.length).eq(3);
    });

    it("Judgement: draws named cards from the discard pile, up to the minion's pip count", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(20)); // Judgement
        g.board.get(0, 0)!.pieces = [new Piece(1, 2, "U")]; // medium minion, 2 pips
        g.hands[0] = g.hands[0].slice(0, 4); // make room - a full 6-card hand has none
        g.discardPile.push("KS", "00");
        g.move(`use ${major(20).uid}, m0.2 KS 00`, { trusted: true });
        expect(g.hands[0]).to.include.members(["KS", "00"]);
        expect(g.discardPile).to.deep.equal([]);
    });

    it("High Priestess: two discard-and-redraw rounds, no minion reference needed", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const [firstDiscard] = g.hands[0];
        g.move(`use ${major(2).uid}, ${firstDiscard}`, { trusted: true }); // only the first of the two rounds
        expect(g.hands[0]).to.not.include(firstDiscard);
        expect(g.hands[0].length).eq(6);
    });

    it("Magician: chooses which suit primitive to use for its one step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(1)); // The Magician
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        g.move(`use ${major(1).uid}, m0.1 C own m0 U`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // used Cups' "own" mode
    });

    it("refuses more power-step segments than the card actually grants", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(1)); // The Magician - only 1 power
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        expect(() => g.move(`use ${major(1).uid}, m0.1 C own m0 U, m0.1 C own m0 U`)).to.throw();
    });
});

// The frame-array API contract itself (see render()'s own docs) - not
// specific card behaviour, already covered above.
describe("Gnostica: frame-stepping render() contract", () => {
    type AreaButtonBarLike = { type: string; buttons?: { value?: string }[] };
    type RepLike = { areas?: AreaButtonBarLike[] };
    const barValues = (rep: RepLike): string[] | undefined =>
        rep.areas?.find(a => a.type === "buttonBar")?.buttons?.map(b => b.value ?? "");

    it("live paging: a genuine 2-step chain, still mid-build (partial), shows step 1's own real choices on frame 0 - not the final rep's", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        forceCardAt(g, 1, 0, () => aceOfDiscs());
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")];
        const move = `use ${major(6).uid}, m0.1 piece n0.1 1 U/o0.1 own o0 U`;
        g.move(move, { partial: true });
        expect(g.frames.length).eq(1); // still mid-build, but the chain itself is complete
        const reps = g.render() as RepLike[];
        expect(Array.isArray(reps)).eq(true);
        expect(reps.length).eq(2);
        // Frame 0 (as of just step 1) still has Cups' own mode buttons on
        // offer - the real choice available at that point in the chain.
        expect(barValues(reps[0])).to.include("mode_C_own");
        // The final/live rep (both steps already typed) does not offer
        // the same thing - proving the two are genuinely distinct, not
        // both just showing today's (final) button state.
        expect(barValues(reps[1])).to.not.deep.equal(barValues(reps[0]));
    });

    it("historical review: the same chain, once fully committed and reloaded, shows no buttons on its own intermediate frame", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(6));
        forceCardAt(g, 1, 0, () => aceOfDiscs());
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")];
        g.move(`use ${major(6).uid}, m0.1 piece n0.1 1 U/o0.1 own o0 U`, { trusted: true });
        // liveMove is cleared on a real commit - nothing "in progress" left.
        const reps = g.render() as RepLike[];
        expect(reps.length).eq(2);
        expect(barValues(reps[0])).eq(undefined); // no buttonBar area at all on the historical frame
        expect(barValues(reps[1])).to.not.eq(undefined); // the final/live rep still gets its own normal bar
    });

    it("0 real steps never produce an array or grouped results", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.move(`use ${aceOfCups().uid}`, { trusted: true }); // 0 steps - fully declined
        expect(Array.isArray(g.render())).eq(false);
        expect(g.results.some(r => r.type === "_group")).eq(false);
    });

    it("1 real step never produces an array or grouped results, even on a card that could have taken more", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers - could take up to 2 steps
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.move(`use ${major(6).uid}, m0.1 piece m0.1 1 E`, { trusted: true }); // only step 1, step 2 declined
        expect(Array.isArray(g.render())).eq(false);
        expect(g.results.some(r => r.type === "_group")).eq(false);
    });

    it("persistence round-trip: a reloaded game still steps through the same frames a genuine chain produced", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(6));
        forceCardAt(g, 1, 0, () => aceOfDiscs());
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")];
        g.move(`use ${major(6).uid}, m0.1 piece n0.1 1 U/o0.1 own o0 U`, { trusted: true });
        const before = g.render() as RepLike[];

        const g2 = new GnosticaGame(g.serialize());
        const after = g2.render() as RepLike[];
        expect(after.length).eq(before.length);
        expect(g2.frames.length).eq(g.frames.length);
        expect(g2.frames[0].board.get(2, 0)?.pieces.length).eq(g.frames[0].board.get(2, 0)?.pieces.length);
    });
});

describe("Gnostica: piece grid fallback order (#48)", () => {
    const gridSlots = (g: GnosticaGame, pieces: Piece[]): { dx: number; dy: number; scale: number }[] =>
        (g as unknown as { pieceGridSlots: (pieces: Piece[]) => { dx: number; dy: number; scale: number }[] }).pieceGridSlots(pieces);

    it("bumps a piece off its own preferred slot into a perpendicular side, not straight to the opposite one", () => {
        const g = new GnosticaGame(2);
        const pieces = [
            new Piece(1, 1, "N"),
            new Piece(1, 1, "E"),
            // N and E both already taken - per #48's fallback order for N
            // (E, W, U, S) this must land on W next, not jump straight to
            // S the way the OLD fixed global order (N, S, E, W, U) would
            // have.
            new Piece(1, 1, "N"),
        ];
        const slots = gridSlots(g, pieces);
        // Only pieces[0]/pieces[2] (orientation "N") are checked by raw
        // dx/dy here - N's own rotation transform is the identity (see
        // CARDINAL_COS_SIN), so its slot choice reads directly off the
        // returned coordinates with no rotation math needed. pieces[1]
        // (orientation "E") DOES get rotated before its nudge is
        // returned (the renderer quirk noted on pieceGridSlots' own
        // docs - nudge is pre-rotation, not screen space), so its exact
        // dx/dy isn't asserted here; which slot INDEX it landed on isn't
        // what this test is about anyway.
        expect([slots[0].dx, slots[0].dy]).to.deep.equal([0, -380]); // N's own preferred slot
        expect([slots[2].dx, slots[2].dy]).to.deep.equal([-380, 0]); // W, not S
    });

    it("exhausts one orientation's own full fallback list in order: preferred, both perpendiculars, centre, opposite side last", () => {
        const g = new GnosticaGame(2);
        const pieces = [new Piece(1, 1, "N"), new Piece(1, 1, "N"), new Piece(1, 1, "N"), new Piece(1, 1, "N"), new Piece(1, 1, "N")];
        const slots = gridSlots(g, pieces).map(s => [s.dx, s.dy]);
        expect(slots).to.deep.equal([
            [0, -380], // N - preferred
            [380, 0],  // E - 1st fallback
            [-380, 0], // W - 2nd fallback
            [0, 0],    // U - 3rd fallback
            [0, 380],  // S - last resort, the opposite side
        ]);
    });

    it("a centre-preferring piece bumped off U just takes the first free slot - no particular preference", () => {
        const g = new GnosticaGame(2);
        const pieces = [new Piece(1, 1, "U"), new Piece(1, 1, "U")];
        const slots = gridSlots(g, pieces).map(s => [s.dx, s.dy]);
        expect(slots[0]).to.deep.equal([0, 0]); // U's own preferred slot
        expect(slots[1]).to.deep.equal([0, -380]); // first free slot (N), no ordering claim beyond that
    });
});

describe("Gnostica: render", () => {
    // The renderer pairs rowLabels[i] with pieceRows[N-1-i] (mirrored, not
    // same-index) - confirmed by actually rendering an asymmetric board in
    // the renderer playground, not just by reading the schema. This test
    // guards against that mirroring silently regressing: for every row, the
    // label paired with it (per the renderer's own convention) must equal
    // that row's true algebraic notation, for every cell in the row.
    it("labels every row with its true algebraic row number, mirrored per the renderer's convention", () => {
        const g = new GnosticaGame(2);
        const rep = g.render() as { board: { rowLabels: string[]; width: number }; pieces: string };
        const pieceRows = rep.pieces.split("\n");
        const n = pieceRows.length;
        expect(rep.board.rowLabels.length).eq(n);
        // The board's own minY is the absolute y of pieceRows[0] (top row,
        // since y grows downward); walk every row and check the label the
        // renderer will actually display against it.
        const minY = g.board.minY - 1; // render() pads by 1 cell
        for (let i = 0; i < n; i++) {
            const absY = minY + i;
            const trueLabel = (absY === 0 ? 0 : -absY).toString();
            const pairedLabel = rep.board.rowLabels[n - 1 - i];
            expect(pairedLabel, `row ${i} (absolute y=${absY})`).eq(trueLabel);
        }
    });

    // A cell can legitimately exceed the normal 3-piece capacity (some
    // major arcana powers bypass CellContents.canAdd()'s check), and pyramids
    // must never be rendered stacked/overlapping. Regression test for
    // exactly that bug: the old fixed 3-slot nudge table silently reused
    // slot 1's coordinates for every piece beyond the 3rd.
    it("never gives two pieces on the same territory identical render coordinates, even past normal capacity", () => {
        const g = new GnosticaGame(2);
        const t = g.board.get(0, 0)!;
        t.pieces = [
            new Piece(1, 1, "U"), new Piece(2, 1, "U"), new Piece(1, 2, "U"),
            new Piece(2, 2, "U"), new Piece(1, 3, "U"),
        ];
        type CellGlyph = { name?: string; nudge?: { dx: number; dy: number } };
        const rep = g.render() as { legend: Record<string, CellGlyph | CellGlyph[]> };
        // Not every legend entry is array-shaped (e.g. hand_UNKNOWN is a
        // single bare Glyph) - only scan the ones that are.
        const entry = Object.values(rep.legend)
            .filter((glyphs): glyphs is CellGlyph[] => Array.isArray(glyphs))
            .find(glyphs => glyphs.filter(gl => gl.name?.startsWith("pyramid-")).length === t.pieces.length);
        expect(entry, "expected a legend entry with 5 pyramid glyphs").to.not.be.undefined;
        const coords = entry!.filter(gl => gl.name?.startsWith("pyramid-")).map(gl => `${gl.nudge!.dx},${gl.nudge!.dy}`);
        expect(new Set(coords).size, "every piece should have a distinct nudge").eq(coords.length);
    });

    // Void cells are never individually clickable in the grid - a
    // wasteland minion facing into one instead gets a `buffer` area on
    // whichever single side of the board's own stored extent it sits on
    // (see cmdOrient's own docs). This is the Pacru-style replacement for
    // the earlier "expand the void" approach.
    it("never renders a void cell as a clickable target, even once a piece is on the wasteland next to it", () => {
        const g = new GnosticaGame(2);
        const before = g.render() as { pieces: string };
        expect(before.pieces).to.include("-"); // no pieces anywhere yet - every void cell is bare
        expect(before.pieces).to.not.include("k_void_");

        // (2,1) is wasteland (adjacent to the initial 3x3's corner at
        // (1,1)); its own east neighbour (3,1) is void.
        expect(g.board.classify(2, 1)).eq("wasteland");
        expect(g.board.classify(3, 1)).eq("void");
        g.board.store.set(2, 1, new CellContents(undefined, [new Piece(1, 1, "U")]));

        const after = g.render() as { pieces: string };
        expect(after.pieces).to.not.include("k_void_");
    });

    it("shows a buffer on the single board edge a wasteland minion sits on, once it starts reorienting", () => {
        const g = new GnosticaGame(2);
        // (2,0) becomes the board's own new eastern edge (maxX): the
        // initial 3x3 deal only reaches x=1, and (2,0)'s own y=0 isn't
        // also a min/max boundary, so this is unambiguously an east-only
        // case, not a corner.
        g.board.store.set(2, 0, new CellContents(undefined, [new Piece(1, 1, "U")]));
        (g as unknown as { saveState: () => void }).saveState();
        expect(g.board.classify(2, 0)).eq("wasteland");
        expect(g.board.maxX).eq(2);

        const ref = `${GnosticaBoard.coords2algebraic(2, 0)}.1`;
        g.move(`orient ${ref} N`, { trusted: true });
        const rep = g.render() as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });

    it("shows no buffer for a minion sitting on a real territory", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2 - keeps their own board presence legal
        const ref = `${GnosticaBoard.coords2algebraic(0, 0)}.1`;
        g.move(`orient ${ref} N`, { trusted: true });
        const rep = g.render() as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer).to.be.undefined;
    });

    // The other four flows that can also orient a piece into the void -
    // see addBufferIfWasteland's own docs on why all five need this, not
    // just the top-level "orient" command above.
    it("shows a buffer when placing directly onto an edge wasteland", () => {
        const g = new GnosticaGame(2);
        expect(g.board.classify(2, 0)).eq("wasteland");
        const cell = GnosticaBoard.coords2algebraic(2, 0);
        g.move(`place ${cell} N`, { trusted: true });
        const rep = g.render() as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });

    it("shows a buffer when Cups 'own' creates a new piece on an edge wasteland", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 1, 0, () => aceOfCups());
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "E")]; // facing (2,0)
        expect(g.board.classify(2, 0)).eq("wasteland");
        const minionCell = GnosticaBoard.coords2algebraic(1, 0);
        const targetCell = GnosticaBoard.coords2algebraic(2, 0);
        g.move(`use ${aceOfCups().uid}, ${minionCell}.1 own ${targetCell} U`, { trusted: true });
        const rep = g.render() as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });

    it("shows a buffer when orientAny (Devil) targets a piece on an edge wasteland", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 1, 0, () => major(15)); // The Devil
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "E")]; // acting minion, facing (2,0)
        g.board.store.set(2, 0, new CellContents(undefined, [new Piece(2, 1, "S")])); // enemy target, on an edge wasteland
        expect(g.board.classify(2, 0)).eq("wasteland");
        const minionCell = GnosticaBoard.coords2algebraic(1, 0);
        const targetCell = GnosticaBoard.coords2algebraic(2, 0);
        g.move(`use ${major(15).uid}, ${minionCell}.1 ${targetCell}.1 N`, { trusted: true });
        const rep = g.render() as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });

    it("shows a buffer when hierophantReplace targets a piece on an edge wasteland", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 1, 0, () => major(5)); // The Hierophant
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "E")]; // acting minion, facing (2,0)
        g.board.store.set(2, 0, new CellContents(undefined, [new Piece(2, 1, "S")])); // enemy target, on an edge wasteland
        expect(g.board.classify(2, 0)).eq("wasteland");
        const minionCell = GnosticaBoard.coords2algebraic(1, 0);
        const targetCell = GnosticaBoard.coords2algebraic(2, 0);
        g.move(`use ${major(5).uid}, ${minionCell}.1 ${targetCell}.1 N`, { trusted: true });
        const rep = g.render() as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });
});

// GnosticaBoard.coords2algebraic/algebraic2coords' own round-trip math is
// covered directly in gnostica.board.test.ts - this instead exercises the
// full pipeline (parseMove/validateMove/move/render) at |x| > 12, where the
// notation itself switches from one letter to two, using cells built with
// coords2algebraic rather than hardcoded strings so it stays correct if the
// notation ever changes.
describe("Gnostica: double-letter coordinates (full move pipeline)", () => {
    it("places, activates a suit power, and renders correctly entirely past the single-letter boundary", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        const originCell = GnosticaBoard.coords2algebraic(13, 0); // first double-letter column
        const neighbourCell = GnosticaBoard.coords2algebraic(14, 0);
        expect(originCell).eq("aa0"); // sanity check on the notation itself
        expect(neighbourCell).eq("ab0");
        forceCardAt(g, 13, 0, aceOfCups);
        expect(g.board.classify(14, 0)).eq("wasteland");

        expect(g.validateMove(`place ${originCell} E`).valid).to.be.true;
        g.move(`place ${originCell} E`, { trusted: true }); // player 1, pointing at the neighbour
        g.move(`place ${neighbourCell}`, { trusted: true }); // player 2

        const useMove = `use ${aceOfCups().uid}, ${originCell}.1 own ${neighbourCell} U`;
        expect(g.validateMove(useMove).valid).to.be.true;
        g.move(useMove, { trusted: true });
        const target = g.board.get(14, 0)!;
        expect(target.pieces.length).eq(2); // player 2's placed piece, plus player 1's new one
        expect(target.pieces[1]).to.deep.include({ owner: 1, size: 1, orientation: "U" });

        const rep = g.render() as { board: { columnLabels: string[] }; pieces: string };
        expect(rep.board.columnLabels).to.include.members(["aa", "ab"]);
        expect(rep.pieces).to.be.a("string"); // rendered without throwing
    });
});

describe("Gnostica: handleClick", () => {
    // handleClick's row/col are relative to render()'s current window
    // (padded by 1 cell beyond the board's own bounding box) - this mirrors
    // that exact formula so tests can go from absolute board coords to the
    // row/col a real click would report.
    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        // Must match handleClickCore's own window exactly (see
        // renderWindow's own docs - territory bounds, not the raw
        // board.minX/maxX/minY/maxY, which also includes cardless
        // wasteland cells a piece may have been pushed onto) - reusing
        // the game's own private computation directly rather than
        // duplicating its logic here, so the two can never drift apart.
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };

    it("place: clicking a valid cell before any pieces are on the board starts a place move", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0); // "m0"
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("place m0");
    });

    // A bare "place <cell>" is already grammatically complete (orientation
    // defaults to "U"), so validateMove() alone would mark it complete:1 -
    // but handleClick has to downgrade that to 0, or the interface would
    // auto-submit "U" on the very first click, before the player ever
    // gets a chance to click again and cycle to a real facing (the
    // reported bug this guards against).
    it("place: the first click is never auto-submittable - complete stays 0 even though the move is already valid", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(0);
    });

    // Regression: playground.js's boardClick() only re-renders the live
    // preview (updating the button bar) when canrender or complete>=0 is
    // set - a valid but complete:-1 result (the common case since #49,
    // e.g. right after picking a card or a top-level button) used to
    // leave the button bar visibly stale after a real click, even though
    // the returned message was correct. canrender must be set on every
    // valid click result regardless of complete, not just the ones that
    // happen to be complete:0/1.
    it("sets canrender on a valid complete:-1 result - a top-level button choice - not just complete>=0 ones", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_use");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.canrender).eq(true);
    });

    it("sets canrender on a valid complete:-1 result - a freshly-picked card, mode not chosen yet", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.canrender).eq(true);
    });

    it("place: clicking the same cell again re-affirms \"up\"; clicking a neighbour sets that facing directly", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0);
        const first = g.handleClick("", row, col);
        const same = g.handleClick(first.move, row, col);
        expect(same.valid).to.be.true;
        expect(same.move).eq("place m0 U");
        const [rowE, colE] = rowColFor(g, 1, 0); // n0, east of m0
        const east = g.handleClick(first.move, rowE, colE);
        expect(east.valid).to.be.true;
        expect(east.move).eq("place m0 E");
    });

    it("place: clicking a non-adjacent cell restarts placement there instead", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0);
        const first = g.handleClick("", row, col);
        const [rowFar, colFar] = rowColFor(g, 2, 0); // "o0", two cells east - not adjacent to m0
        const far = g.handleClick(first.move, rowFar, colFar);
        expect(far.valid).to.be.true;
        expect(far.move).eq("place o0");
    });

    it("place: a void neighbour is a valid orientation target too", () => {
        const g = new GnosticaGame(2);
        // (2,1) is a wasteland (adjacent to the initial 3x3's corner at
        // (1,1)) whose OWN east neighbour (3,1) is void - nothing adjacent
        // to it has a card either. This is the scenario the click-to-orient
        // redesign specifically has to support: a void cell still needs to
        // be a clickable orientation target.
        const placeCell = GnosticaBoard.coords2algebraic(2, 1);
        expect(g.board.classify(2, 1)).eq("wasteland");
        expect(g.board.classify(3, 1)).eq("void");
        const [row, col] = rowColFor(g, 2, 1);
        const first = g.handleClick("", row, col);
        expect(first.move).eq(`place ${placeCell}`);
        const [rowVoid, colVoid] = rowColFor(g, 3, 1);
        const east = g.handleClick(first.move, rowVoid, colVoid);
        expect(east.valid).to.be.true;
        expect(east.move).eq(`place ${placeCell} E`);
    });

    it("orient: clicking your own piece (with pieces already on the board, and Orient chosen) starts an orient move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        expect(seed.move).eq("orient");
        const result = g.handleClick(seed.move, row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("orient m0.1 U");
        // A freshly-placed piece already defaults to "U", so selecting it
        // to reorient seeds a genuine no-op - complete:-1, not just the
        // usual auto-submit guard (0), since this isn't submittable as-is
        // at all (see validateOrient's own ORIENT_NO_OP docs).
        expect(result.complete).eq(-1);
    });

    it("orient: clicking the piece's own cell again re-affirms \"up\"; clicking a neighbour sets that facing directly", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const first = g.handleClick(seed.move, row, col);
        const same = g.handleClick(first.move, row, col);
        expect(same.valid).to.be.true;
        expect(same.move).eq("orient m0.1 U");
        const [rowE, colE] = rowColFor(g, 1, 0); // n0, east of m0
        const east = g.handleClick(first.move, rowE, colE);
        expect(east.valid).to.be.true;
        expect(east.move).eq("orient m0.1 E");
    });

    it("orient: clicking a non-adjacent, unoccupied cell falls back to fresh-selection handling", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const first = g.handleClick(seed.move, row, col);
        expect(first.move).eq("orient m0.1 U");
        const [rowFar, colFar] = rowColFor(g, 2, 0); // "o0", not adjacent to m0, no piece there either
        const far = g.handleClick(first.move, rowFar, colFar);
        expect(far.valid).to.be.false; // no piece of the acting player's there to (re-)select
    });

    it("choosing Orient via the button bar seeds an instructional, not-yet-valid move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_orient");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq("orient");
    });

    it("board clicks are ambiguous with no action chosen once pieces are on the board - no default guess", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.false;
    });

    it("Use Territory (activate) via the button bar, then a board click, builds a use move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const uid0 = g.board.get(0, 0)!.card!.uid;
        const seed = g.handleClick("", -1, -1, "_btn_use");
        expect(seed.complete).eq(-1);
        const result = g.handleClick(seed.move, row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`use ${uid0}`);
        // #49: a bare "use <uid>" (no power step yet) is genuinely still
        // building, not just soft-pedaled - validateMove's own complete:-1
        // survives provisionalResult's clamp untouched (that clamp only
        // downgrades an otherwise-complete:1 result).
        expect(result.complete).eq(-1);
    });

    it("Use Hand Card (play) via the button bar, then a hand-card click, builds a play move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const uid = g.hands[0][0];
        const seed = g.handleClick("", -1, -1, "_btn_play");
        const result = g.handleClick(seed.move, -1, -1, `hand_${uid}`);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`play ${uid}`);
    });

    it("Pass immediately builds a submittable, genuinely no-op discard/draw move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_pass");
        expect(result.valid).to.be.true;
        // Not just "discard" - that bare form silently draws back to max,
        // which isn't actually a pass. Pass needs explicit "draw 0" too.
        expect(result.move).eq("discard draw 0");
    });

    it("Discard/Draw carries instructions, unlike Pass's own already-complete seed", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_discard");
        expect(result.valid).to.be.true;
        expect(result.move).eq("discard");
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.DISCARD_CARDS_OPTIONAL"));
    });

    it("Declare appends last to an in-progress move, and toggles it back off", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const seed = g.handleClick("", -1, -1, "_btn_pass"); // "discard draw 0"
        const declared = g.handleClick(seed.move, -1, -1, "_btn_declare");
        expect(declared.valid).to.be.true;
        expect(declared.move).eq("discard draw 0 (last)");
        const undeclared = g.handleClick(declared.move, -1, -1, "_btn_declare");
        expect(undeclared.move).eq("discard draw 0");
    });

    it("Declare works even with no base action chosen yet, and survives switching to a real action afterwards", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const declared = g.handleClick("", -1, -1, "_btn_declare"); // clicked first, no move string yet
        expect(declared.valid).to.be.true;
        expect(declared.complete).eq(-1); // still needs a real action - not submittable as-is
        expect(declared.move).eq("(last)"); // the bare flag, not a guessed action like "discard"
        // Picking a real action afterwards must carry the flag along, even
        // though clicking "Activate" here has nothing to do with declaring.
        const seed = g.handleClick(declared.move, -1, -1, "_btn_use");
        expect(seed.move).eq("use (last)");
        const [row, col] = rowColFor(g, 0, 0);
        const uid0 = g.board.get(0, 0)!.card!.uid;
        const result = g.handleClick(seed.move, row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`use ${uid0} (last)`);
        // #49: same as the un-declared version above - still building.
        expect(result.complete).eq(-1);
    });

    // The trickiest part of reattachLastFlag: a still-incomplete click
    // result (e.g. Pass's own "discard", always legal on its own) gets
    // re-validated once "(last)" makes it a genuinely complete move -
    // catching a declare that's ONLY illegal because of the flag itself
    // (another player's announcement hasn't resolved yet), rather than
    // reusing the pre-declare result's now-stale validity.
    it("re-validates once declaring completes the move, catching ALREADY_ANNOUNCED at that point", () => {
        const g = new GnosticaGame(3);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("place n0", { trusted: true }); // player 3
        g.move("discard (last)", { trusted: true }); // player 1 announces
        // player 2's turn - "discard draw 0" (Pass) is perfectly legal on
        // its own; declaring on top of it must not be.
        const declared = g.handleClick("", -1, -1, "_btn_declare");
        expect(declared.move).eq("(last)");
        const passed = g.handleClick(declared.move, -1, -1, "_btn_pass");
        expect(passed.move).eq("discard draw 0 (last)");
        expect(passed.valid).to.be.false;
    });

    it("shows only a single, bold Place button with no pieces on the board yet", () => {
        const g = new GnosticaGame(2);
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar, "expected a button bar").to.not.be.undefined;
        expect(bar!.buttons!.length).eq(1);
        expect(bar!.buttons![0].value).eq("place");
    });

    // The playground's live-preview mechanism applies a not-yet-submitted
    // "place" click to this.board for rendering (see move()'s own docs on
    // `partial`), which would otherwise make hasPiecesOnBoard() look true
    // before the move is actually committed - isPendingFirstPlacement()
    // exists specifically to keep the button bar showing only "Place"
    // through that window, not the full action set.
    it("still shows only Place while a first placement is previewed but not yet submitted", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar!.buttons!.length).eq(1);
        expect(bar!.buttons![0].value).eq("place");
    });

    it("shows the full action set once a placement is genuinely committed", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true }); // back to player 1
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar!.buttons!.length).greaterThan(1);
    });

    // hasLiveMoveInProgress() is the fix for a real bug: this.lastmove/
    // this.results don't reset between turns on their own, so without this
    // guard a committed action from the PREVIOUS player's finished turn
    // would misread as the NEW current player's own in-progress action
    // (most visibly when the two share a contested cell) - wrongly
    // highlighting a button, or worse, collapsing the whole bar down to a
    // stale single button or mode-button set. This is the direct
    // regression test: right after a real commit, before the next player
    // has clicked anything at all, nothing should be highlighted.
    it("does not highlight a stale button before the next player's own first click", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2 - now player 1's turn again
        g.move(`orient m0.1 N`, { trusted: true }); // player 1 orients, ending their turn
        // it's player 2's turn now; they haven't clicked anything yet - the
        // just-committed "orient" belongs to player 1's finished turn, not
        // a live action of player 2's.
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        for (const b of bar!.buttons!) {
            expect(b.attributes, `button "${b.value}" should not be highlighted yet`).to.be.undefined;
        }
    });

    it("highlights the button matching the current player's own in-progress action", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2 - now player 1's turn again
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const clicked = g.handleClick(seed.move, row, col);
        expect(clicked.move).eq("orient m0.1 U");
        g.move(clicked.move, { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const orientBtn = bar!.buttons!.find(b => b.value === "orient");
        expect(orientBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
        const activateBtn = bar!.buttons!.find(b => b.value === "use");
        expect(activateBtn!.attributes).to.be.undefined;
    });

    it("bolds Pass, not Discard/Draw, when the live move is Pass's own bare seed - whether built by the Pass button or by hand", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        for (const liveMove of ["discard draw 0", "discard draw 0"]) {
            g.move(liveMove, { partial: true });
            const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
            const bar = rep.areas?.find(a => a.type === "buttonBar");
            const passBtn = bar!.buttons!.find(b => b.value === "pass");
            const discardBtn = bar!.buttons!.find(b => b.value === "discard");
            expect(passBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold"), "Pass should be bold").to.be.true;
            expect(discardBtn!.attributes, "Discard/Draw should not be bold").to.be.undefined;
        }
    });

    it("still bolds Discard/Draw for a discard preview that isn't Pass-equivalent (draws more than 0)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.hands[0] = g.hands[0].slice(0, 5); // leave room to draw
        g.move("discard draw 1", { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const discardBtn = bar!.buttons!.find(b => b.value === "discard");
        const passBtn = bar!.buttons!.find(b => b.value === "pass");
        expect(discardBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
        expect(passBtn!.attributes).to.be.undefined;
    });

    it("collapses to the draw-count picker during a live discard preview, offering every legal count", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [uid1, uid2] = g.hands[0];
        g.move(`discard ${uid1} ${uid2}`, { partial: true }); // player 1's own live preview, 2 discarded, no count chosen yet
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        // Pass and a bare "discard" share the exact same move text (known
        // simplification - see cmdDiscard's own bare-seed docs), so this
        // same collapse is unavoidably shown no matter which button
        // actually got clicked to seed the preview.
        expect(values).to.deep.equal(["drawcount_2", "drawcount_1", "drawcount_0"]);
    });

    it("clicking a draw-count button completes the move with that exact count", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [uid1, uid2] = g.hands[0];
        const seeded = g.handleClick("", -1, -1, `hand_${uid1}`);
        const built = g.handleClick(seeded.move, -1, -1, `hand_${uid2}`);
        expect(built.move).eq(`discard ${uid1} ${uid2}`);
        const result = g.handleClick(built.move, -1, -1, "_btn_drawcount_1");
        expect(result.valid).to.be.true;
        expect(result.move).eq(`discard ${uid1} ${uid2} draw 1`);
        g.move(result.move, { trusted: true });
        expect(g.hands[0].length).eq(5); // 4 left after discarding 2, +1 drawn back
    });

    it("still highlights Use Territory during a live activate-declining-power preview (no results pushed)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const uid0 = g.board.get(0, 0)!.card!.uid;
        const clicked = g.handleClick(seed.move, row, col);
        expect(clicked.move).eq(`use ${uid0}`);
        g.move(clicked.move, { partial: true }); // live preview, power still declined - pushes zero results
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const activateBtn = bar!.buttons!.find(b => b.value === "use");
        // lastmove-based detection still catches this case, since lastmove is
        // set unconditionally regardless of pushed results
        expect(activateBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
    });

    // The bug this whole guard exists for: a CONTESTED cell (both players
    // have a piece there) defeats the narrower "does the current player
    // own a piece at that result's cell" checks alone, since the new
    // current player genuinely does have a piece there too - only knowing
    // whether a move() call has happened yet THIS turn can tell the two
    // apart.
    it("does not carry a stale mode-button set into a contested cell on the next player's fresh turn", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true }); // player 1's piece on m0, "U"
        g.move("place l0", { trusted: true }); // player 2, elsewhere
        g.board.get(0, 0)!.pieces.push(new Piece(2, 1, "U")); // contrive: player 2 ALSO on m0 now
        g.move(`use ${aceOfCups().uid}, m0.1 own m0 U`, { trusted: true }); // player 1 uses Cups (own), ending their turn
        // it's player 2's turn now, and they haven't clicked anything -
        // even though player 2 also has a piece on the just-activated
        // cell, the mode-button set from player 1's finished turn must not
        // leak through.
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("use");
        expect(values).to.include("play"); // the full top-level set, not narrowed
        expect(values).to.not.include("mode_C_own");
    });

    it("does not guess at a click on a cell with no piece of the acting player's, once placement is no longer legal", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2 - now player 1's turn again
        const [row, col] = rowColFor(g, -1, 0); // "l0", player 2's piece
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.false;
    });

    it("discard: clicking a hand card toggles it into a discard move, and clicking again toggles it back out", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // discard requires pieces already on the board
        g.move("place l0", { trusted: true }); // back to player 1's turn
        const uid = g.hands[0][0];
        const first = g.handleClick("", -1, -1, `hand_${uid}`);
        expect(first.valid).to.be.true;
        expect(first.move).eq(`discard ${uid}`);
        expect(first.complete).eq(0); // same auto-submit guard as place/orient
        const second = g.handleClick(first.move, -1, -1, `hand_${uid}`);
        expect(second.valid).to.be.true;
        expect(second.move).eq("discard");
    });

    it("discard: rejects a hand-card click for a card not in the acting player's hand", () => {
        const g = new GnosticaGame(2);
        const uid = g.hands[1][0]; // player 2's card, player 1 is acting
        const result = g.handleClick("", -1, -1, `hand_${uid}`);
        expect(result.valid).to.be.false;
    });

    // Hand redaction (blanking an opponent's hand uids to "") is the back
    // end's job, not this class's - but render() still has to cope with
    // whatever it's handed, rather than silently referencing a legend key
    // that was never defined (which would break the actual renderer).
    it("renders a redacted (blank-uid) hand card as a placeholder, not a dangling legend reference", () => {
        const g = new GnosticaGame(2);
        g.hands[1].fill(""); // simulate the back end redacting player 2's cards
        const rep = g.render() as { legend: Record<string, unknown>; areas?: { pieces: string[] }[] };
        const p2area = rep.areas?.[1];
        expect(p2area, "expected an area for player 2's hand").to.not.be.undefined;
        expect(p2area!.pieces[0]).eq("hand_UNKNOWN");
        expect(rep.legend).to.have.property("hand_UNKNOWN");
    });

    // The playground's live-preview mechanism calls move(m, {partial:
    // true}) on every click to show what the in-progress move would do,
    // without treating it as a final, committed turn (see move()'s own
    // comment for the full story - this was a real, previously-missing
    // piece of the engine, not a click-building bug). Without honouring
    // `partial`, every preview call fully committed: advanced the turn,
    // drew for real, and pushed onto the stack - so a player toggling
    // multiple hand cards into one discard move would see each card
    // discarded and immediately replaced one at a time, rather than the
    // whole batch resolving together only once the move is truly
    // submitted.
    it("move(..., {partial: true}) applies the move's effects without advancing the turn or persisting it", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true }); // back to player 1
        const uid = g.hands[0][0];
        const beforePlayer = g.currplayer;
        const beforeStackLength = g.stack.length;
        const beforeHandLength = g.hands[0].length;

        g.move(`discard ${uid}`, { partial: true });

        expect(g.currplayer, "partial move should not advance the turn").eq(beforePlayer);
        expect(g.stack.length, "partial move should not push onto the stack").eq(beforeStackLength);
        // The discard itself did happen (that's the whole point of a
        // preview - the card should visibly disappear), but a partial
        // discard deliberately does NOT redraw yet, so the hand is smaller
        // rather than being backfilled with a card the player hasn't
        // earned by finishing their discard selection.
        expect(g.hands[0].length).eq(beforeHandLength - 1);
        expect(g.hands[0]).to.not.include(uid);
    });

    it("a partial discard only discards - the actual redraw happens once, on final (non-partial) submission", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [uid1, uid2] = g.hands[0];

        // Each click's preview reconstructs from the true persisted state
        // (mirroring the playground rebuilding `game` from localStorage on
        // every click) rather than accumulating on top of a previous
        // preview - so this clones fresh each time, just as real usage does.
        const preview1 = g.clone();
        preview1.move(`discard ${uid1}`, { partial: true });
        expect(preview1.hands[0].length).eq(5);

        const preview2 = g.clone();
        preview2.move(`discard ${uid1} ${uid2}`, { partial: true });
        expect(preview2.hands[0].length).eq(4);

        // The real game is untouched by any preview made on a clone.
        expect(g.hands[0].length).eq(6);

        g.move(`discard ${uid1} ${uid2}`, { trusted: true }); // final submission
        expect(g.hands[0].length).eq(6);
        expect(g.hands[0]).to.not.include(uid1);
        expect(g.hands[0]).to.not.include(uid2);
    });
});

describe("Gnostica: render - draw/discard pile summaries", () => {
    // Too many cards to show individually - minor arcana are summarized as
    // one counted token per (suit, spot-or-royalty) bucket, since exact
    // rank doesn't matter here; major arcana are unique, so each remaining
    // one gets its own full card face. The discard pile is always
    // face-up/public, so it's read directly from discardPile.
    it("buckets discard-pile minors by suit and spot/royalty, and shows majors as individual cards", () => {
        const g = new GnosticaGame(2);
        g.discardPile = ["AC", "2C", "KC", "07"]; // 2 spot cups, 1 royal cup, 1 major
        // Matches the discard pile itself, so none of these register as
        // "just discarded" (see newDiscardUids's own docs) - this test is
        // about the bucketing/grouping shape, not the highlight.
        const rep = g.render() as { legend: Record<string, unknown>; areas?: { label: string; pieces?: string[] }[] };
        const discardArea = rep.areas?.find(a => a.pieces?.some(p => p.startsWith("discard_")));
        expect(discardArea, "expected a discard-pile area").to.not.be.undefined;
        expect(discardArea!.pieces).to.include("discard_C_spot");
        expect(discardArea!.pieces).to.include("discard_C_royal");
        expect(discardArea!.pieces).to.include("discard_07");
        expect(discardArea!.pieces!.length).eq(3); // one spot-cup bucket, one royal-cup bucket, one major - not 4 separate entries
        expect(rep.legend).to.have.property("discard_C_spot");
        const spotGlyphs = rep.legend.discard_C_spot as { text?: string }[];
        expect(spotGlyphs.find(gl => gl.text === "2x"), "spot bucket should count 2").to.not.be.undefined;
    });

    it("omits the discard-pile area entirely once the pile is empty", () => {
        const g = new GnosticaGame(2);
        g.discardPile = [];
        const rep = g.render() as { areas?: { pieces?: string[] }[] };
        const discardArea = rep.areas?.find(a => a.pieces?.some(p => p.startsWith("discard_")));
        expect(discardArea).to.be.undefined;
    });

    // The draw pile's own order/contents are exactly as hidden from a
    // viewer as an opponent's redacted hand uids, so the summary can't
    // just read drawPile directly - it has to compute "what's unknown" by
    // elimination (every card not definitively visible somewhere else).
    // This is the direct behavioural proof: a real card moves from
    // "not counted" to "counted as unknown" the moment it's redacted.
    it("counts a card hidden in another player's redacted hand as part of the draw-pile pool", () => {
        const g = new GnosticaGame(2);
        for (const [, , t] of g.board.entries()) {
            t.card = undefined;
        }
        g.discardPile = [];
        g.hands[0] = [];
        g.hands[1] = ["AC"]; // a real, visible Ace of Cups in player 2's hand
        g.drawPile = []; // deliberately empty/stale - must not affect the summary

        // 10 spot cups exist in total; with AC visible in hand, the other
        // 9 are unaccounted for anywhere and should show as unknown.
        const before = g.render() as { legend: Record<string, { text?: string }[]> };
        const beforeText = before.legend.draw_C_spot.find(gl => gl.text !== undefined)!.text;
        expect(beforeText, "AC is visible, so only the other 9 spot cups are unknown").eq("9x");

        g.hands[1] = [""]; // the back end redacts it - now hidden from this viewer
        const after = g.render() as { legend: Record<string, { text?: string }[]> };
        const afterText = after.legend.draw_C_spot.find(gl => gl.text !== undefined)!.text;
        expect(afterText, "AC is now hidden too, so all 10 spot cups are unknown").eq("10x");
    });
});

// Mirrors "Gnostica: new-card hand highlight" - a card added to the
// discard pile by the most recently completed move gets the same tint as
// a just-drawn hand card (see newDiscardUids's own docs), except it's not
// scoped to a specific viewer (the pile is always public) or gated on
// whose turn it is (there's only one shared pile).
describe("Gnostica: discard-pile 'just discarded' highlight", () => {
    type DiscardRenderRep = { legend: Record<string, { colour?: string; text?: string }[]>; areas?: { pieces?: string[] }[] };
    const discardArea = (rep: DiscardRenderRep) => rep.areas?.find(a => a.pieces?.some(p => p.startsWith("discard_")));

    it("tags a card discarded on the most recent move, tinted the same #ccc as a new hand card", () => {
        // A major arcana card specifically - unlike a minor, it gets its
        // own individual legend entry rather than folding into a suit/
        // category bucket (see the next test for that case).
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.hands[0] = [major(3).uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.move(`discard ${major(3).uid}`, { trusted: true });
        const rep = g.render() as DiscardRenderRep;
        const newKey = `discard_${major(3).uid}_new`;
        expect(discardArea(rep)?.pieces).to.include(newKey);
        expect(rep.legend[newKey].some(gl => gl.colour === "#ccc")).to.be.true;
    });

    it("a minor card only tints its own share of the bucket, not the whole count", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.discardPile = [card("2C").uid]; // one spot cup already discarded earlier
        g.hands[0] = [card("AC").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid, card("7C").uid];
        g.move("discard AC", { trusted: true }); // a second spot cup, discarded just now
        const rep = g.render() as DiscardRenderRep;
        const pieces = discardArea(rep)?.pieces ?? [];
        expect(pieces).to.include("discard_C_spot"); // the older one, untinted
        expect(pieces).to.include("discard_C_spot_new"); // just this move's own
        expect(rep.legend.discard_C_spot.some(gl => gl.text === "1x")).to.be.true;
        expect(rep.legend.discard_C_spot_new.some(gl => gl.text === "1x")).to.be.true;
        expect(rep.legend.discard_C_spot_new.some(gl => gl.colour === "#ccc")).to.be.true;
    });

    it("clears once the next move is submitted, even by a different player", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.move("discard AC", { trusted: true });
        g.move("discard", { trusted: true }); // player 2's own turn
        const rep = g.render() as DiscardRenderRep;
        expect(discardArea(rep)?.pieces?.some(p => p.endsWith("_new"))).to.be.false;
    });

    it("a live preview of the player's own in-progress move highlights discards", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.move("discard AC", { partial: true, trusted: true }); // simulates the player's own first click
        const rep = g.render() as DiscardRenderRep;
        expect(discardArea(rep)?.pieces?.some(p => p.endsWith("_new"))).to.be.true;
    });

    // Regression: same "_new" suffix stripping as the hand-card click -
    // AreaPieces reuses the pieces[] entry as both the legend key and the
    // clickable identifier, so a real click on a highlighted discard-pile
    // card (Judgement's own picker) must still resolve to its real uid/
    // bucket, not fall through to "not a recognized click".
    it("a real click on the highlighted discard-pile card (Judgement) still resolves correctly", () => {
        const g = new GnosticaGame(2);
        const rowColFor = (x: number, y: number): [number, number] => {
            const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
            return [y - minY, x - minX];
        };
        forceCardAt(g, 0, 0, () => major(20)); // Judgement
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        g.hands[0] = g.hands[0].slice(0, 5); // room for 1 more (a full 6-card hand has none)
        g.discardPile = [major(3).uid];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const newKey = `discard_${major(3).uid}_new`;
        const click = g.handleClick(cellClick.move, -1, -1, newKey);
        expect(click.valid).to.be.true;
        expect(click.move).eq(`use ${major(20).uid}, m0.1 ${major(3).uid}`);
    });
});

// Click support for minor arcana's single suit-power step - see
// buildMinorModeMove/handlePendingMinorBoardClick/supplyMinorCardUid in
// gnostica.ts. Major arcana chaining is out of scope for this pass. Every
// mode button defaults to a fully-formed (if sometimes deliberately
// tolerant/incomplete) move, mirroring the exact move strings the
// hand-typed tests above already exercise end-to-end - these tests only
// need to confirm the CLICK path reaches the same string, then let one
// representative commit per suit prove the resulting move actually works.
describe("Gnostica: handleClick - minor arcana power steps", () => {
    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        // Must match handleClickCore's own window exactly (see
        // renderWindow's own docs - territory bounds, not the raw
        // board.minX/maxX/minY/maxY, which also includes cardless
        // wasteland cells a piece may have been pushed onto) - reusing
        // the game's own private computation directly rather than
        // duplicating its logic here, so the two can never drift apart.
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };

    it("Cups (own): mode button seeds the default step; click-to-orient sets the new piece's facing", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use ${aceOfCups().uid}`);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_own");
        expect(modeClick.move).eq(`use ${aceOfCups().uid}, m0.1 own n0 U`);
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(0);
        const [row2, col2] = rowColFor(g, 1, 0); // n0, the target cell itself - re-affirms "U"
        const sameCell = g.handleClick(modeClick.move, row2, col2);
        expect(sameCell.move).eq(`use ${aceOfCups().uid}, m0.1 own n0 U`);
        const [row3, col3] = rowColFor(g, 2, 0); // "o0", east of n0 - sets the new piece's facing
        const east = g.handleClick(modeClick.move, row3, col3);
        expect(east.move).eq(`use ${aceOfCups().uid}, m0.1 own n0 E`);
        g.move(modeClick.move, { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
    });

    it("Cups (enemy): mode button defaults to the only enemy piece at the target cell", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_enemy");
        expect(modeClick.move).eq(`use ${aceOfCups().uid}, m0.1 enemy n0 1`);
        g.move(modeClick.move, { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
    });

    it("Cups (new): mode button seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, -1, 0, () => aceOfCups()); // l0
        g.move("place l0 W", { trusted: true }); // player 1, pointing at k0, a wasteland
        g.move("place n0", { trusted: true }); // player 2
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, -1, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_new");
        expect(modeClick.move).eq(`use ${aceOfCups().uid}, l0.1 new k0`);
        // Cell chosen, card uid not yet supplied - genuinely still
        // building (complete:-1), not just soft-pedaled to 0 - a bare
        // hand-typed submission of this exact string must not look
        // "valid" (the false-positive this fixes; see validateMinorPower's
        // own docs).
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(-1);
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${spotUid}`);
        expect(cardClick.move).eq(`use ${aceOfCups().uid}, l0.1 new k0 ${spotUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): mode button defaults to moving the minion itself; clicking the facing cell redirects", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${aceOfRods().uid}, m0.1 piece m0.1 1`); // defaults to self
        const [row2, col2] = rowColFor(g, 1, 0); // n0, the facing cell
        const switched = g.handleClick(modeClick.move, row2, col2);
        expect(switched.move).eq(`use ${aceOfRods().uid}, m0.1 piece n0.1 1`);
        g.move(modeClick.move, { trusted: true }); // commit the (unswitched) default: moves itself
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        // n0 already held player 2's piece (pieces[0]) before the move - the
        // mover lands alongside it, not alone.
        expect(g.board.get(1, 0)!.pieces[1]).to.deep.include({ owner: 1, orientation: "E" });
    });

    it("Rods (tile): mode button defaults to pushing the pointed-at territory 1 space", () => {
        const g = new GnosticaGame(2);
        // Fully deterministic (see clearBoard's own docs): the random
        // initial deal could otherwise occasionally put the Ace of Rods
        // itself at n0, which forceCardAt's own duplicate-clearing would
        // then wipe out from there, leaving no territory to push - see
        // "Rods (tile): pushes the pointed-at territory further away"'s
        // own identical fix above.
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfRods());
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0, the territory to be pushed
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_tile");
        expect(modeClick.move).eq(`use ${aceOfRods().uid}, m0.1 tile 1`);
        g.move(modeClick.move, { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
    });

    it("Discs (piece): mode button defaults to growing the minion itself", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_piece");
        expect(modeClick.move).eq(`use ${aceOfDiscs().uid}, m0.1 piece m0.1`);
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2 });
    });

    it("Discs (tile): mode button seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        forceCardAt(g, 1, 0, () => card("2C")); // n0, a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const royaltyUid = "KS"; // King of Swords, worth 2
        g.hands[0].push(royaltyUid);
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_tile");
        expect(modeClick.move).eq(`use ${aceOfDiscs().uid}, m0.1 tile n0`);
        // Target chosen, replacement card not yet supplied - must not read
        // as a submittable move ("looks like a valid move"): still valid
        // (still building), but genuinely incomplete.
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(-1);
        expect(modeClick.message).eq(i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED"));
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${royaltyUid}`);
        expect(cardClick.move).eq(`use ${aceOfDiscs().uid}, m0.1 tile n0 ${royaltyUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
    });

    it("Discs (tile): mode button is struck through and rejects a click when the hand has no card that could grow this territory", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        forceCardAt(g, 1, 0, () => card("2C")); // n0, a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        // All spot cards (worth 1) - growing a worth-1 territory needs a
        // worth-2 (court) card, which none of these are.
        g.hands[0] = [card("AC").uid, card("2R").uid, card("3D").uid, card("4S").uid];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        g.move(cellClick.move, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const tileBtn = bar!.buttons!.find(b => b.value === "mode_D_tile");
        expect(tileBtn!.attributes).to.deep.include({ name: "text-decoration", value: "line-through" });
        const rejected = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_tile");
        expect(rejected.valid).to.be.false;
        expect(rejected.message).eq(i18next.t("apgames:validation.gnostica.NO_CARD_TO_GROW"));
        g.hands[0].push("KS"); // King of Swords, worth 2 - now completable
        const rep2 = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar2 = rep2.areas?.find(a => a.type === "buttonBar");
        const tileBtn2 = bar2!.buttons!.find(b => b.value === "mode_D_tile");
        expect(tileBtn2!.attributes).to.be.undefined;
        const accepted = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_tile");
        expect(accepted.move).eq(`use ${aceOfDiscs().uid}, m0.1 tile n0`);
    });

    it("Cups (new), Wheel of Fortune: a dedicated button supplies the random draw - no hand card needed, no other card offers it", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(10)); // Wheel of Fortune
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_new");
        expect(modeClick.move).eq(`use ${major(10).uid}, m0.1 new n0`);
        g.move(modeClick.move, { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar?.buttons?.some(b => b.value === "random")).eq(true);

        const randomClick = g.handleClick(modeClick.move, -1, -1, "_btn_random");
        expect(randomClick.move).eq(`use ${major(10).uid}, m0.1 new n0 random`);
        expect(randomClick.valid).to.be.true;
        // Fully deterministic (see clearBoard's own docs on the same
        // principle) - and deliberately a non-spot (major arcana) card,
        // to prove the random draw has no point-value restriction at all
        // (unlike the ordinary hand-card path for this same mode).
        const majorUid = major(3).uid; // The Empress, worth 3
        g.drawPile = [majorUid, ...g.drawPile.filter(uid => uid !== majorUid)];
        const before = g.drawPile.length;
        g.move(randomClick.move, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(majorUid);
        expect(g.drawPile.length).to.be.lessThan(before);

        // A regular Ace of Cups own "new" step never offers this button -
        // allowRandomDraw is Wheel of Fortune's own opt, not universal to
        // "new" mode.
        const g2 = new GnosticaGame(2);
        clearBoard(g2);
        forceCardAt(g2, 0, 0, () => aceOfCups());
        g2.move("place m0 E", { trusted: true });
        g2.move("place l0", { trusted: true });
        const seed2 = g2.handleClick("", -1, -1, "_btn_use");
        const [row2, col2] = rowColFor(g2, 0, 0);
        const cellClick2 = g2.handleClick(seed2.move, row2, col2);
        const modeClick2 = g2.handleClick(cellClick2.move, -1, -1, "_btn_mode_C_new");
        g2.move(modeClick2.move, { partial: true });
        const rep2 = g2.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar2 = rep2.areas?.find(a => a.type === "buttonBar");
        expect(bar2?.buttons?.some(b => b.value === "random")).eq(false);

        // And typing "random" by hand for that same non-Wheel-of-Fortune
        // card is rejected outright, not silently honored - the gate is
        // opts.allowRandomDraw (derived from the card's own step
        // definition), not the literal token.
        expect(g2.validateMove(`use ${aceOfCups().uid}, m0.1 new n0 random`).valid).to.be.false;
    });

    it("Swords (piece): with no facing piece to attack (minion is \"up\"), falls back to the minion itself", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0", { trusted: true }); // player 1, size 1, "U" - no facing cell at all
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}, m0.1 piece m0.1 1`);
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(0); // 1 pip on a size-1 piece destroys it
        expect(g.stashes.get(1)![0]).eq(5); // returned to its own stash
    });

    // Regression test for a reported bug: using a Sword to attack a
    // neighbouring enemy instead attacked the acting player's own minion,
    // because the mode button unconditionally defaulted to self. Attacking
    // yourself is almost never what's wanted (unlike Rods' "move self" or
    // Discs' "grow self", both genuinely common choices) - when the minion
    // is actually facing an enemy, that's what the default should target.
    it("Swords (piece): with a piece in the facing cell, defaults to attacking THAT instead of self", () => {
        const g = new GnosticaGame(2);
        clearBoard(g); // fully deterministic - see clearBoard's own docs
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}, m0.1 piece n0.1 1`);
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(1); // the acting player's own minion survives
        // n0 has no card of its own (cleared above) - once its only piece
        // is destroyed, pruneIfEmpty deletes the cell outright rather than
        // leaving empty CellContents behind (see pruneIfEmpty's own docs),
        // so board.get(1,0) itself becomes undefined, not just empty.
        expect(g.board.get(1, 0)?.pieces.length ?? 0).eq(0); // the enemy piece is destroyed instead
        expect(g.stashes.get(2)![0]).eq(5); // returned to ITS owner's stash
    });

    it("Swords (tile): mode button seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        forceCardAt(g, -1, 0, () => card("KS")); // l0, worth 2
        g.move("place m0 W", { trusted: true }); // player 1, pointing at l0
        g.move("place n0", { trusted: true }); // player 2
        // The random deal may not happen to include a spot minor at all -
        // force one in rather than relying on chance (a real flaky failure
        // otherwise, on the rare hand with none).
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_tile");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}, m0.1 tile l0 1`);
        // Unlike Cups "new"/Discs "tile", Swords "tile" already has enough
        // tokens (mode+cell+pips) to attempt the primitive outright - and a
        // pips-1 attack on a worth-2 territory leaves a nonzero remainder,
        // which genuinely requires a replacement card. This is a real rules
        // error, not applyMinorPower's "still declined" tolerance - fixed
        // up below by the hand-card click regardless.
        expect(modeClick.valid).to.be.false;
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${spotUid}`);
        expect(cardClick.move).eq(`use ${aceOfSwords().uid}, m0.1 tile l0 1 ${spotUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(-1, 0)!.card?.uid).eq(spotUid);
    });

    it("narrows the bar to just the selected top-level button, a spacer, then the mode buttons", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.move(`use ${aceOfCups().uid}`, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        // The full top-level set (play/orient/discard/pass) is gone, save for
        // the one choice that got us here - no room to keep both levels.
        expect(values).to.not.include("play");
        expect(values).to.not.include("orient");
        expect(values).to.not.include("discard");
        expect(values).to.not.include("pass");
        expect(values[0]).eq("use");
        expect(bar!.buttons![0].attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
        expect(values[1]).eq("_spacer"); // divider - the schema has no dedicated type for one
        expect(values.slice(2)).to.include("mode_C_own");
        // Declare stays available throughout - an orthogonal end-of-turn
        // flourish, not a step of this particular choice.
        expect(values[values.length - 1]).eq("declare");
    });

    it("offers every suit mode as a button, struck through when not currently sensible, and rejects a click on one immediately", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true }); // "U" - targets itself, a territory with no enemy on it
        g.move("place l0", { trusted: true });
        g.move(`use ${aceOfCups().uid}`, { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("mode_C_own");
        expect(values).to.include("mode_C_enemy"); // still offered, not omitted - see tree-pruning docs
        expect(values).to.include("mode_C_new");
        const ownBtn = bar!.buttons!.find(b => b.value === "mode_C_own");
        expect(ownBtn!.attributes).to.be.undefined; // feasible - not struck through
        const enemyBtn = bar!.buttons!.find(b => b.value === "mode_C_enemy");
        expect(enemyBtn!.attributes).to.deep.include({ name: "text-decoration", value: "line-through" }); // no enemy piece at the target (self) cell
        const newBtn = bar!.buttons!.find(b => b.value === "mode_C_new");
        expect(newBtn!.attributes).to.deep.include({ name: "text-decoration", value: "line-through" }); // "U" targets self, a territory, not a wasteland
        const enemyClick = g.handleClick(`use ${aceOfCups().uid}`, -1, -1, "_btn_mode_C_enemy");
        expect(enemyClick.valid).to.be.false;
        expect(enemyClick.message).eq(i18next.t("apgames:validation.gnostica.NO_ENEMY_THERE", { cell: "m0" }));
        const newClick = g.handleClick(`use ${aceOfCups().uid}`, -1, -1, "_btn_mode_C_new");
        expect(newClick.valid).to.be.false;
        expect(newClick.message).eq(i18next.t("apgames:validation.gnostica.NOT_A_WASTELAND"));
    });

    it("bolds the currently-chosen mode button", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.move(`use ${aceOfCups().uid}, m0.1 own m0 U`, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const ownBtn = bar!.buttons!.find(b => b.value === "mode_C_own");
        expect(ownBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
    });

    // Regression test for a second reported bug, hit via the Sword
    // self-attack above: destroying the acting player's own last minion
    // mid-preview made getActionButtons() misread "zero pieces on board
    // right now" as "fresh turn, needs a placement" and collapse the whole
    // bar down to a single Place button - even though the in-progress
    // activate/play move was still perfectly valid and just needed
    // submitting. A live "activate"/"play" preview can only ever have
    // started with board presence (both throw otherwise), so this piece
    // count is a legitimate mid-action side effect, not a fresh-turn
    // signal.
    it("does not collapse to the Place button mid-preview when a power step destroys the acting player's own last minion", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0", { trusted: true }); // player 1, size 1, "U" - only piece on the board
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}, m0.1 piece m0.1 1`); // self-attack, since "U" has no facing cell
        g.move(modeClick.move, { partial: true }); // live preview - destroys the player's only piece
        expect(g.board.get(0, 0)!.pieces.length).eq(0); // confirm the destructive side effect really happened
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.not.deep.equal(["place"]);
        expect(values).to.include("use");
        expect(values).to.include("play");
    });
});

describe("Gnostica: handleClick - minion disambiguation", () => {
    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };

    it("use: multiple eligible minions at the activated cell offer a minion-picker bar; picking one seeds it for the mode buttons that follow", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        // Two of player 1's own minions share the activated cell - one
        // facing "U" (can't use a rod at all), one facing "E" (can) - so
        // which one gets seeded is directly observable in which mode
        // buttons show up afterward.
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U"), new Piece(1, 1, "E")];
        g.move(`use ${aceOfRods().uid}`, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("minion_m0.1.U");
        expect(values).to.include("minion_m0.1.E");
        expect(values).to.not.include("mode_R_piece"); // not offered until a minion is actually chosen
        // The upright minion is still offered (not pruned outright), but
        // struck through - it can never satisfy checkCanUseRod - and an
        // actual click on it is rejected immediately instead of building a
        // doomed provisional move.
        const uprightButton = bar!.buttons!.find(b => b.value === "minion_m0.1.U");
        expect(uprightButton!.attributes).to.deep.include({ name: "text-decoration", value: "line-through" });
        const rejectedClick = g.handleClick(`use ${aceOfRods().uid}`, -1, -1, "_btn_minion_m0.1.U");
        expect(rejectedClick.valid).to.be.false;
        expect(rejectedClick.message).eq(i18next.t("apgames:validation.gnostica.ROD_NEEDS_FACING"));
        const facingButton = bar!.buttons!.find(b => b.value === "minion_m0.1.E");
        expect(facingButton!.attributes).to.be.undefined;
        const picked = g.handleClick(`use ${aceOfRods().uid}`, -1, -1, "_btn_minion_m0.1.E");
        expect(picked.move).eq(`use ${aceOfRods().uid}, m0.1.E`);
        g.move(picked.move, { partial: true });
        const rep2 = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar2 = rep2.areas?.find(a => a.type === "buttonBar");
        const values2 = bar2!.buttons!.map(b => b.value);
        expect(values2.some(v => v?.startsWith("minion_"))).to.be.false; // no minion buttons left once resolved
        expect(values2).to.include("mode_R_piece"); // legal now - the "E"-facing minion was actually seeded
        const modeClick = g.handleClick(picked.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${aceOfRods().uid}, m0.1.E piece m0.1.E 1`);
    });

    it("use: minion-picker button labels show the piece's real orientation even when the ref itself omits it (disambiguated by size alone)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        // Different sizes alone are enough to disambiguate these two, so
        // neither ref needs an orientation suffix (see pieceRefStr's own
        // docs) - the button LABEL must still read the piece's actual
        // facing directly, not try to parse it back out of that ref.
        g.board.get(0, 0)!.pieces = [new Piece(1, 2, "N"), new Piece(1, 1, "E")];
        g.move(`use ${aceOfRods().uid}`, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; label?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("minion_m0.2"); // no orientation in the ref - size alone disambiguates
        expect(values).to.include("minion_m0.1");
        const labelFor = (value: string) => bar!.buttons!.find(b => b.value === value)!.label;
        expect(labelFor("minion_m0.2")).eq("2-pip pointing N");
        expect(labelFor("minion_m0.1")).eq("1-pip pointing E");
    });

    it("use: two eligible minions at the activated cell that are fully identical (same owner/size/facing) resolve directly, no picker offered", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        // Two genuinely interchangeable minions - same owner, size, and
        // facing. Picking either has the exact same effect, so this isn't
        // really a choice at all (see allIndistinguishable's own docs).
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E"), new Piece(1, 1, "E")];
        g.move(`use ${aceOfRods().uid}`, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        // Not offered a minion picker at all - resolves straight through to
        // the mode buttons, as if only one minion had ever been there.
        expect(values.some(v => v?.startsWith("minion_"))).to.be.false;
        expect(values).to.include("mode_R_piece");
    });

    it("play: a board-wide pool offers no buttons until a cell is clicked; clicking a cell with just one eligible minion there resolves it directly", () => {
        // A fresh instance per checkpoint, exactly like the real click flow
        // (every click reconstructs a fresh GnosticaGame via GameFactory,
        // then does its own single move(..., {partial: true}) - see this
        // describe block's own docs) - unlike "use", "play" mutates the
        // hand (discards the card) on ANY partial apply, so reusing one
        // instance across two separate partial calls would make the
        // second's own re-validation see the card already gone from hand.
        const setup = (): GnosticaGame => {
            const g = new GnosticaGame(2);
            clearBoard(g);
            forceCardAt(g, 0, 0, () => card("AC"));
            forceCardAt(g, 1, 0, () => card("AD"));
            g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // m0
            g.board.get(1, 0)!.pieces = [new Piece(1, 1, "E")]; // n0
            const uid = "2R";
            g.hands[0] = g.hands[0].filter(u => u !== uid);
            g.hands[0].push(uid);
            return g;
        };
        const uid = "2R";
        // "play"'s partial apply mutates the hand (discards the card) -
        // one fresh instance per checkpoint whose button bar/click needs
        // to see the card still there, same as this describe block's
        // other "play" test.
        const g = setup();
        const seeded = g.handleClick("", -1, -1, "_btn_play");
        const cardClick = g.handleClick(seeded.move, -1, -1, `hand_${uid}`);
        expect(cardClick.message).eq(i18next.t("apgames:validation.gnostica.PICK_MINION_CELL"));
        const gBar = setup();
        gBar.move(cardClick.move, { partial: true });
        const rep = gBar.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        // No minion buttons yet - the pool spans two cells, nothing clicked.
        expect(values.some(v => v?.startsWith("minion_"))).to.be.false;
        const [row, col] = rowColFor(g, 1, 0); // n0 - only one of the pool's own minions there
        const cellClick = g.handleClick(cardClick.move, row, col);
        expect(cellClick.move).eq(`play ${uid}, n0.1`);
        // Follow-up to #49: no step taken yet (mode still unchosen), but
        // this is a click-driven preview mid-navigation, not a submit
        // attempt - points at the button bar rather than surfacing the
        // raw validation reason (see powerStepMessageKey's own docs).
        expect(cellClick.message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: card(uid).name }));
        const g2 = setup();
        g2.move(cellClick.move, { partial: true });
        const rep2 = g2.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar2 = rep2.areas?.find(a => a.type === "buttonBar");
        expect(bar2!.buttons!.map(b => b.value)).to.include("mode_R_piece");
        const modeClick = g2.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        // n0's own piece, not m0's - proves the CLICKED cell (not just
        // eligible[0]) is what the rest of the step actually acts on.
        expect(modeClick.move).eq(`play ${uid}, n0.1 piece n0.1 1`);
    });

    it("play: clicking a cell with multiple eligible minions there narrows the picker to just that cell, not the whole board-wide pool", () => {
        const setup = (): GnosticaGame => {
            const g = new GnosticaGame(2);
            clearBoard(g);
            forceCardAt(g, 0, 0, () => card("AC"));
            forceCardAt(g, 1, 0, () => card("AD"));
            g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E"), new Piece(1, 2, "E")]; // m0 - two, distinct sizes
            g.board.get(1, 0)!.pieces = [new Piece(1, 1, "E")]; // n0 - just one
            const uid = "2R";
            g.hands[0] = g.hands[0].filter(u => u !== uid);
            g.hands[0].push(uid);
            return g;
        };
        const uid = "2R";
        const g = setup();
        const seeded = g.handleClick("", -1, -1, "_btn_play");
        const cardClick = g.handleClick(seeded.move, -1, -1, `hand_${uid}`);
        const [row, col] = rowColFor(g, 0, 0); // m0 - two of the pool's own minions there
        const cellClick = g.handleClick(cardClick.move, row, col);
        expect(cellClick.move).eq(`play ${uid}, m0`); // still-narrowing bare cell token, not a resolved ref
        expect(cellClick.message).eq(i18next.t("apgames:validation.gnostica.PICK_MINION_BUTTON"));
        const gBar = setup();
        gBar.move(cellClick.move, { partial: true });
        const rep = gBar.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("minion_m0.1");
        expect(values).to.include("minion_m0.2");
        expect(values).to.not.include("minion_n0.1"); // narrowed to m0 - n0's own piece isn't offered
        const picked = g.handleClick(cellClick.move, -1, -1, "_btn_minion_m0.2");
        expect(picked.move).eq(`play ${uid}, m0.2`);
        const g2 = setup();
        g2.move(picked.move, { partial: true });
        const rep2 = g2.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar2 = rep2.areas?.find(a => a.type === "buttonBar");
        expect(bar2!.buttons!.map(b => b.value)).to.include("mode_R_piece");
    });

    it("does not offer a minion picker when only one minion is eligible", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.move(`use ${aceOfCups().uid}`, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values.some(v => v?.startsWith("minion_"))).to.be.false;
        expect(values).to.include("mode_C_own"); // straight to mode buttons, exactly as before this feature
    });

    it("orientMinion (a pure click-driven special power): the minion picker still pre-empts the uncollapsed bar, and the chosen minion (not eligible[0]) is what a board click actually reorients", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(3)); // The Empress - step 1 is orientMinion
        // Same cell, different sizes so the refs are trivially distinct.
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U"), new Piece(1, 2, "U")];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use ${major(3).uid}`);
        g.move(cellClick.move, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("minion_m0.1");
        expect(values).to.include("minion_m0.2");
        const picked = g.handleClick(cellClick.move, -1, -1, "_btn_minion_m0.2");
        expect(picked.move).eq(`use ${major(3).uid}, m0.2`);
        const [rowE, colE] = rowColFor(g, 1, 0); // n0, east of m0
        const result = g.handleClick(picked.move, rowE, colE);
        expect(result.move).eq(`use ${major(3).uid}, m0.2 E`);
        g.move(result.move, { trusted: true }); // declines step 2 (create)
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("U"); // the size-1 minion, untouched
        expect(g.board.get(0, 0)!.pieces[1].orientation).eq("E"); // the size-2 minion actually picked
    });
});

// Regression tests for validateMove()'s rearchitecture: a genuine,
// non-mutating validator (gnostica.ts's validateX tree + gnostica/powers.ts's
// checkX functions) replacing the old "clone this, try running the move on
// the clone, catch whatever it throws" mechanism. That old mechanism silently
// discarded every specific reason a suit-power move was illegal, since the
// thrown GnosticaRulesError wasn't a UserFacingError and the catch block
// only ever unwrapped UserFacingError's own message - every powers.ts
// failure surfaced as the generic INVALID_MOVE fallback instead of its real
// message.
describe("Gnostica: validateMove architecture (non-mutating validator)", () => {
    before(() => {
        addResource("en");
    });

    it("surfaces the real reason a suit-power move failed, not the generic fallback", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true }); // player 1, "U" - targets itself
        g.move("place l0", { trusted: true }); // player 2
        g.board.get(0, 0)!.pieces.push(new Piece(1, 1, "U"), new Piece(1, 1, "U")); // fill to capacity (3)
        const result = g.validateMove(`use ${aceOfCups().uid}, m0.1 own m0 U`);
        expect(result.valid).to.be.false;
        // Compares against CELL_FULL's own real message (whatever it
        // currently is - not hardcoded, since the translation gets filled
        // in independently of this test) rather than the generic
        // INVALID_MOVE fallback ("'...' doesn't look like a valid move.").
        expect(result.message).to.eq(i18next.t("apgames:validation.gnostica.CELL_FULL"));
        expect(result.message).to.not.eq(i18next.t("apgames:validation._general.INVALID_MOVE", { move: `use ${aceOfCups().uid}, m0.1 own m0 U` }));
    });

    it("does not mutate game state while validating an invalid move", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const handBefore = [...g.hands[0]];
        const piecesBefore = g.board.get(0, 0)!.pieces.length;
        const discardBefore = g.discardPile.length;
        const result = g.validateMove(`use ${aceOfCups().uid}, m0.1 own m0 U, m0.1 own m0 U`); // MINOR_ONE_STEP_ONLY
        expect(result.valid).to.be.false;
        expect(g.hands[0]).to.deep.equal(handBefore);
        expect(g.board.get(0, 0)!.pieces.length).to.eq(piecesBefore);
        expect(g.discardPile.length).to.eq(discardBefore);
    });

    // Second bug found while building this refactor: Cups "own"/"enemy"
    // previously looked up the target cell with the throwing
    // getCellContents() helper, which threw on a genuinely untouched
    // wasteland (no stored CellContents object at all, since one is only
    // ever created for a cell that already has a card or a piece) -
    // inconsistent with movePiece/hermitMovePiece, which already handle
    // exactly this case by creating one on the fly. Now fixed to match.
    it("Cups (own) can target a genuinely untouched wasteland, not just an existing territory", () => {
        const g = new GnosticaGame(2);
        const [cx, cy] = [1, 1]; // a corner of the initial 3x3
        const cornerCell = GnosticaBoard.coords2algebraic(cx, cy);
        const [tx, ty] = [2, 1]; // outside the 3x3 - genuinely untouched
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        expect(g.board.has(tx, ty)).to.be.false;
        forceCardAt(g, cx, cy, () => aceOfCups());
        g.move(`place ${cornerCell} E`, { trusted: true }); // player 1, pointing at the untouched cell
        g.move("place l0", { trusted: true }); // player 2
        const move = `use ${aceOfCups().uid}, ${cornerCell}.1 own ${targetCell} U`;
        expect(g.validateMove(move).valid).to.be.true;
        expect(() => g.move(move, { trusted: true })).to.not.throw();
        expect(g.board.get(tx, ty)!.pieces.length).to.eq(1);
    });
});

// Regression tests for the piece-reference notation itself
// ("<cell>.<pips>[.<orientation>][.<player>]", replacing the old opaque
// array-index "<cell>.<index>") - each field is included only when the
// ones before it don't already narrow a target cell's pieces down to one.
describe("Gnostica: piece-reference notation", () => {
    before(() => {
        addResource("en");
    });

    it("pips alone is enough to pick a target out when sizes at the cell differ", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0", { trusted: true }); // player 2, size 1
        g.board.get(1, 0)!.pieces.push(new Piece(2, 2, "U")); // a second, size-2 piece, also at n0
        const move = `use ${aceOfRods().uid}, m0.1 piece n0.1 1`; // "n0.1" - pips alone, no orientation/player needed
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces.length).to.eq(1); // the size-1 piece moved away
        expect(g.board.get(1, 0)!.pieces[0].size).to.eq(2); // the size-2 piece was untouched
    });

    it("needs orientation too when two same-size pieces at the cell face different ways, and reports ambiguity without it", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, size 1, facing W
        g.board.get(1, 0)!.pieces.push(new Piece(2, 1, "N")); // a second size-1 piece, facing N
        // "n0.1" alone still matches both - genuinely ambiguous, not a
        // "pick the first" case (the two pieces differ in orientation).
        expect(g.validateMove(`use ${aceOfSwords().uid}, m0.1 piece n0.1 1`).valid).to.be.false;
        const move = `use ${aceOfSwords().uid}, m0.1 piece n0.1.N 1`; // pips + orientation picks out the N-facing one
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move, { trusted: true });
        const remaining = g.board.get(1, 0)!.pieces;
        expect(remaining.length).to.eq(1);
        expect(remaining[0].orientation).to.eq("W"); // the untargeted piece survives
    });

    it("resolves to the first match when two pieces are fully identical, rather than erroring", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0", { trusted: true }); // player 2, size 1, "U"
        g.board.get(1, 0)!.pieces.push(new Piece(2, 1, "U")); // an identical second piece - same owner, size, facing
        const move = `use ${aceOfSwords().uid}, m0.1 piece n0.1 1`; // fully qualifying further (n0.1.U.2) couldn't help either
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces.length).to.eq(1); // one of the two interchangeable pieces destroyed
    });
});

// parseMove's structural checks: the head keyword and each power
// step's rough shape (legal characters, a plausible token count, a first
// token that at least looks like a piece ref or - the one exception,
// High Priestess - a card uid), all checkable without knowing which
// suit/power is actually involved. Deep field-level validation (is this
// specific piece ref real, is this a legal mode for this suit) stays
// exactly where it lived before this parser existed.
describe("Gnostica: move-string structural validation", () => {
    before(() => {
        addResource("en");
    });

    it("rejects a step segment containing illegal characters", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.validateMove(`use ${aceOfCups().uid}, m0.1 own$ m0 U`);
        expect(result.valid).to.be.false;
    });

    it("rejects a step segment with an unreasonable number of tokens", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.validateMove(`use ${aceOfCups().uid}, m0.1 own m0 U a b c d e f g h i j`);
        expect(result.valid).to.be.false;
    });

    it("rejects a step whose first token isn't shaped like a piece ref or a card uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.validateMove(`use ${aceOfCups().uid}, bogus own m0 U`);
        expect(result.valid).to.be.false;
    });

    it("accepts a genuinely well-formed step whose first token is a card uid, not a piece ref (High Priestess)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const [firstDiscard] = g.hands[0];
        const result = g.validateMove(`use ${major(2).uid}, ${firstDiscard}`);
        expect(result.valid).to.be.true;
    });

    it("rejects an unrecognized head keyword", () => {
        const g = new GnosticaGame(2);
        const result = g.validateMove("frobnicate m0");
        expect(result.valid).to.be.false;
    });
});

// A complete, valid, submittable move built via click-to-orient (place/
// orient's own facing, Cups "own"'s new-piece facing) still has a facing
// the player only clicked their way into by default or by picking one
// neighbour - another click can still change it before they submit. The
// generic VALID_MOVE message doesn't convey that, so these click paths
// get their own DIRECTION_STILL_ADJUSTABLE message instead; every OTHER
// complete move (no facing left to adjust) keeps the generic one.
describe("Gnostica: click-to-orient messaging", () => {
    before(() => {
        addResource("en");
    });

    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        // Must match handleClickCore's own window exactly (see
        // renderWindow's own docs - territory bounds, not the raw
        // board.minX/maxX/minY/maxY, which also includes cardless
        // wasteland cells a piece may have been pushed onto) - reusing
        // the game's own private computation directly rather than
        // duplicating its logic here, so the two can never drift apart.
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };
    const directionMsg = () => i18next.t("apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE");

    it("place: the very first click already carries the adjustable-direction message", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("place m0");
        expect(result.message).eq(directionMsg());
    });

    it("place: clicking a neighbour to set a facing keeps the same message", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 1, 0); // n0, east of m0
        const result = g.handleClick("place m0", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("place m0 E");
        expect(result.message).eq(directionMsg());
    });

    it("orient: clicking a piece to start reorienting it carries the same message", () => {
        const g = new GnosticaGame(2);
        // Facing E, not the click flow's own default "U" - so selecting
        // it to reorient seeds a genuine change (U), not a no-op (see
        // ORIENT_NO_OP's own dedicated test below for that case).
        g.move("place m0 E", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("orient", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("orient m0.1 U");
        expect(result.message).eq(directionMsg());
    });

    it("orient: clicking an already-\"U\" piece to start reorienting it is a no-op, and carries the ORIENT_NO_OP message instead", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // defaults to "U"
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("orient", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq("orient m0.1 U");
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
    });

    it("orient: a genuine no-op reorientation is rejected at validateMove() too, so it can never be an actual final move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 N", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.validateMove("orient m0.1 N");
        expect(result.valid).to.be.true; // still building, not a hard error - see the click test above
        expect(result.complete).eq(-1);
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        // A genuine change to a DIFFERENT facing stays fully valid/complete.
        expect(g.validateMove("orient m0.1 S").complete).eq(1);
    });

    // A wasteland minion facing into the void reads its target from a
    // buffer click instead - same contract pacru.ts/azacru.ts already use
    // for their own `buffer` areas: an out-of-window row/col (-1,-1 here,
    // matching every other non-cell click in this file) plus the clicked
    // segment's own coordinates via `piece`, comma-separated - but
    // (confirmed against the real renderer, not just pacru's own source)
    // still WINDOW-RELATIVE, the same frame rowColFor's own row/col are,
    // not raw absolute board coordinates.
    it("orient: a buffer click on the void side of a wasteland minion sets that facing", () => {
        const g = new GnosticaGame(2);
        g.board.store.set(2, 0, new CellContents(undefined, [new Piece(1, 1, "U")]));
        (g as unknown as { saveState: () => void }).saveState();
        const ref = `${GnosticaBoard.coords2algebraic(2, 0)}.1`;

        const [row, col] = rowColFor(g, 2, 0);
        const selected = g.handleClick("orient", row, col);
        expect(selected.move).eq(`orient ${ref} U`);

        const [rowVoid, colVoid] = rowColFor(g, 3, 0); // one step east - the void side
        const result = g.handleClick(selected.move!, -1, -1, `${colVoid},${rowVoid}`);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`orient ${ref} E`);
        expect(result.message).eq(directionMsg());
    });

    it("Cups (own): the mode button's default facing, and clicking to change it, both carry the message", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_own");
        expect(modeClick.move).eq(`use ${aceOfCups().uid}, m0.1 own n0 U`);
        expect(modeClick.message).eq(directionMsg());
        const [rowE, colE] = rowColFor(g, 2, 0); // "o0", east of n0 - changes the new piece's facing
        const east = g.handleClick(modeClick.move, rowE, colE);
        expect(east.move).eq(`use ${aceOfCups().uid}, m0.1 own n0 E`);
        expect(east.message).eq(directionMsg());
    });

    it("does not leak the adjustable-direction message onto a move with no facing left to adjust", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_pass");
        expect(result.valid).to.be.true;
        expect(result.move).eq("discard draw 0");
        expect(result.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
        expect(result.message).to.not.eq(directionMsg());
    });
});

// The bare "activate <cell>"/"play <uid>" state, right after picking the
// card and before any suit mode or major-arcana power step. Per #49 this
// is no longer a complete, submittable move - it's still "in progress"
// (valid:true, complete:-1). The MESSAGE shown here is a click-driven UI
// nudge, not a validation complaint - a real Submit is disabled client-
// side in this state anyway, so there's nothing to warn the player away
// from; it just points at the button bar (CHOOSE_STEP). The raw
// POWER_STEP_REQUIRED validation reason still exists (see
// validateMinorPower/validateMajorPower's own tests, checked directly via
// validateMove()) - it surfaces only for an actual submit attempt while
// incomplete (e.g. a hand-typed move), never through this click path.
// Applies equally to a minor or a major arcana card, and to both activate
// and play - except Fool/World, permanently exempt since neither can
// ever take a real step (not yet supported), where the old fully-
// complete/POWER_STILL_OPTIONAL behavior still applies.
describe("Gnostica: choose-step click messaging", () => {
    before(() => {
        addResource("en");
    });

    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        // Must match handleClickCore's own window exactly (see
        // renderWindow's own docs - territory bounds, not the raw
        // board.minX/maxX/minY/maxY, which also includes cardless
        // wasteland cells a piece may have been pushed onto) - reusing
        // the game's own private computation directly rather than
        // duplicating its logic here, so the two can never drift apart.
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };
    const chooseStepMsg = (cardName: string) => i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: cardName });

    it("activate: a board click onto a card cell carries the message (minor arcana)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`use ${aceOfCups().uid}`);
        expect(result.message).eq(chooseStepMsg(aceOfCups().name));
    });

    it("activate: carries the message for a major arcana card too", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(10)); // Wheel of Fortune
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`use ${major(10).uid}`);
        expect(result.message).eq(chooseStepMsg(major(10).name));
    });

    it("play: a hand-card click carries the message (minor arcana)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const uid = g.hands[0].find(u => !/^\d{2}$/.test(u))!; // a minor card
        const result = g.handleClick("play", -1, -1, `hand_${uid}`);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`play ${uid}`);
        expect(result.message).eq(chooseStepMsg(minorCards.find(c => c.uid === uid)!.name));
    });

    it("play: carries the message for a major arcana card too", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.hands[0].push("10"); // Wheel of Fortune, injected regardless of the random deal
        const result = g.handleClick("play", -1, -1, "hand_10");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq("play 10");
        expect(result.message).eq(chooseStepMsg(major(10).name));
    });

    it("activate: World carries the same CHOOSE_STEP message as any other major now", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`use ${theWorld().uid}`);
        expect(result.message).eq(chooseStepMsg(theWorld().name));
    });

    // High Priestess isn't button-driven at all (CHOOSE_STEP would be
    // actively wrong - there's no button for it), so it gets the same
    // wording as the ordinary discard/draw action instead, plus a clause
    // about its own two-round structure.
    it("activate: High Priestess carries discard-style wording instead of CHOOSE_STEP, distinguishing round 1 from round 2", () => {
        const round1Msg = i18next.t("apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1");
        const round2Msg = i18next.t("apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2");
        expect(round1Msg).to.not.eq(chooseStepMsg(major(2).name));
        expect(round2Msg).to.not.eq(round1Msg);

        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];
        const [row, col] = rowColFor(g, 0, 0);
        const fresh = g.handleClick("use", row, col);
        expect(fresh.move).eq(`use ${major(2).uid}`);
        expect(fresh.message).eq(round1Msg);

        g.move(`use ${major(2).uid}, ${discardUid}`, { trusted: true }); // step 1: a real discard, pauses on step 2
        expect(g.pendingPower).to.not.be.undefined;
        const resumed = g.handleClick("", -1, -1, "_btn_resume_power");
        expect(resumed.move).eq(`use ${major(2).uid}`);
        expect(resumed.message).eq(round2Msg);
    });

    // Regression: bold marks a button matching what this.liveMove ALREADY
    // says (see highlightedButtonValues' own docs) - Continue and Decline
    // are both genuinely open choices at this point, neither "selected",
    // so neither should be bold.
    it("Continue/Decline: neither button is bold - nothing has been chosen yet", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2));
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];
        g.move(`use ${major(2).uid}, ${discardUid}`, { trusted: true });
        expect(g.pendingPower).to.not.be.undefined;

        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: unknown[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const continueBtn = bar.buttons!.find(b => b.value === "resume_power")!;
        const declineBtn = bar.buttons!.find(b => b.value === "decline_power")!;
        expect(continueBtn.attributes).to.be.undefined;
        expect(declineBtn.attributes).to.be.undefined;
    });

    // Regression: the button used to be labeled "Continue {{rootCardUid's
    // name}}" - always the ORIGINALLY used/played card, never the actual
    // active one. Once Fool reveals a DIFFERENT card (here, the High
    // Priestess), that label would misleadingly say "Continue The Fool"
    // while what Continue actually resolves is the High Priestess's own
    // power. The buttons are now generic; the status message (asserted
    // elsewhere) is what actually names the active card.
    it("Continue/Decline buttons are named after the ACTIVE card's uid, not the root card's", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(0)); // The Fool
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        // Force the flip to reveal The High Priestess - pluck it from
        // wherever the random deal put it first.
        for (const hand of g.hands) {
            const idx = hand.indexOf("02");
            if (idx !== -1) hand.splice(idx, 1);
        }
        const drawIdx = g.drawPile.indexOf("02");
        if (drawIdx !== -1) g.drawPile.splice(drawIdx, 1);
        g.drawPile.unshift("02");

        g.move(`use ${major(0).uid}, fool`, { trusted: true });
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["00", "02"]);

        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; label?: string }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const continueBtn = bar.buttons!.find(b => b.value === "resume_power")!;
        const declineBtn = bar.buttons!.find(b => b.value === "decline_power")!;
        // "02" (The High Priestess) - the active card - not "00" (The Fool
        // - the root).
        expect(continueBtn.label).eq("Use Card 02");
        expect(declineBtn.label).eq("Decline 02");
    });

    // Regression: the real client calls validateMove("") right after every
    // real commit, purely to populate the status line for the render that
    // follows (see playground.js's own moveBtn handler) - this used to
    // always say INITIAL_INSTRUCTIONS ("click a top-level button"), which
    // is wrong the moment that render is actually the forced Continue/
    // Decline screen, not the ordinary button bar.
    it("validateMove(\"\") reports the pending-power choice, not the generic top-level-button instructions, once a card's power is paused", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];

        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));

        g.move(`use ${major(2).uid}, ${discardUid}`, { trusted: true }); // pauses, awaiting round 2
        expect(g.pendingPower).to.not.be.undefined;
        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.PENDING_POWER_CHOICE", { card: major(2).name }));

        g.move(`use ${major(2).uid}, decline`, { trusted: true }); // clears the obligation
        expect(g.pendingPower).to.be.undefined;
        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));
    });
});

describe("Gnostica: handleClick - major arcana chained power steps", () => {
    before(() => {
        addResource("en");
    });

    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        // Must match handleClickCore's own window exactly (see
        // renderWindow's own docs - territory bounds, not the raw
        // board.minX/maxX/minY/maxY, which also includes cardless
        // wasteland cells a piece may have been pushed onto) - reusing
        // the game's own private computation directly rather than
        // duplicating its logic here, so the two can never drift apart.
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };
    const buttonValues = (g: GnosticaGame): (string | undefined)[] => {
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        return bar!.buttons!.map(b => b.value);
    };

    it("Empress (orientMinion, then create): a chain whose LAST step is started but not yet complete is not treated as a valid, submittable move", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(3)); // The Empress
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        // Step 1 (orientMinion) reorients U -> E, so step 2's own target
        // (the minion's new facing) is n0. Step 2 (Cups "new") has that
        // target cell but no replacement card uid yet - the same shape of
        // bug reported for a minor arcana card's own single step, just
        // reached through a major arcana chain's LAST step instead (see
        // validatePowerStep/validateMajorPower's own docs).
        const incomplete = g.validateMove(`use ${major(3).uid}, m0.1 E/m0.1 new n0`);
        expect(incomplete.valid).to.be.true;
        expect(incomplete.complete).eq(-1);
        expect(incomplete.message).eq(i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED"));
        // Supplying the card uid completes it normally.
        g.hands[0].push("2S");
        const complete = g.validateMove(`use ${major(3).uid}, m0.1 E/m0.1 new n0 2S`);
        expect(complete.complete).eq(1);
    });

    it("Lovers (move, then create): step 2's Cups buttons appear only once step 1 is complete; a board click still redirects step 1's default target; the chained click sequence resolves correctly", () => {
        // Fully deterministic (see clearBoard's own docs): the random
        // initial deal could otherwise occasionally put The Lovers
        // itself at n0, which forceCardAt's own duplicate-clearing would
        // then wipe out from under piece B, stranding it off-territory.
        const setup = (game: GnosticaGame) => {
            clearBoard(game);
            forceCardAt(game, 0, 0, () => major(6)); // The Lovers
            forceCardAt(game, 1, 0, () => aceOfDiscs()); // n0 - any real card, distinct from The Lovers
            game.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, pointing at n0
            game.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")]; // own piece B, already on n0
        };
        const g = new GnosticaGame(2);
        setup(g);

        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use ${major(6).uid}`);

        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${major(6).uid}, m0.1 piece m0.1 1`); // defaults to self

        // The default already satisfies R.piece's minArgs, but a board
        // click on the facing cell still redirects THIS step's target
        // rather than being swallowed as "start step 2" - the exact gap
        // parsePendingStep's preferCurrent option exists to close.
        const [rowN, colN] = rowColFor(g, 1, 0); // n0, the facing cell (B)
        const redirected = g.handleClick(modeClick.move, rowN, colN);
        expect(redirected.move).eq(`use ${major(6).uid}, m0.1 piece n0.1 1`);
        expect(redirected.valid).to.be.true;

        // Step 1 is now complete - the button bar should offer step 2's
        // (Cups) modes, not step 1's (Rods) own anymore. Inspected on a
        // separate, identically-set-up instance (mirrors how a real client
        // re-renders a live preview from the official state plus the
        // in-progress move string - see move()'s own docs). g.clone() isn't
        // usable here: it only round-trips officially COMMITTED state
        // (this.stack, updated by saveState()), not this test's own direct
        // board.get(x,y)!.card/.pieces pokes, so partial-applying to `g`
        // itself would also actually push B off n0, corrupting the very
        // move string being re-parsed.
        const preview = new GnosticaGame(2);
        setup(preview);
        preview.move(redirected.move, { partial: true });
        const values = buttonValues(preview);
        expect(values).to.include("mode_C_own");
        expect(values).to.not.include("mode_R_piece");

        const step2 = g.handleClick(redirected.move, -1, -1, "_btn_mode_C_own");
        expect(step2.move).eq(`use ${major(6).uid}, m0.1 piece n0.1 1/m0.1 own n0 U`);
        expect(step2.valid).to.be.true;

        g.move(step2.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(1); // A, unmoved
        expect(g.board.get(2, 0)!.pieces.length).eq(1); // B, pushed E to o0
        expect(g.board.get(1, 0)!.pieces.length).eq(1); // new piece created at n0 (now vacant)
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
        expect(g.currplayer).eq(2);
    });

    it("Lovers: submitting after just step 1 (declining step 2) is still legal via clicks", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, pointing at n0

        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${major(6).uid}, m0.1 piece m0.1 1`); // defaults to self, declines step 2
        g.move(modeClick.move, { trusted: true });
        expect(g.currplayer).eq(2);
    });

    it("Tower (orientMinion, then attack): no mode buttons appear for the special step 1, but Swords buttons do once it's typed by hand", () => {
        const setup = (game: GnosticaGame) => {
            forceCardAt(game, 0, 0, () => major(16)); // The Tower
            game.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")]; // minion A, standing
        };
        const g = new GnosticaGame(2);
        setup(g);

        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use ${major(16).uid}`);

        // Button-bar checkpoints are inspected on separate,
        // identically-set-up instances - see the Lovers test above for why
        // g.clone() isn't usable here.
        const previewBefore = new GnosticaGame(2);
        setup(previewBefore);
        previewBefore.move(cellClick.move, { partial: true });
        expect(buttonValues(previewBefore).some(v => v?.startsWith("mode_"))).to.be.false;

        // Step 1 (special: orientMinion) has no click support (Phase B) -
        // typed by hand instead.
        const withStep1 = `use ${major(16).uid}, m0.1 E`;
        const previewAfter = new GnosticaGame(2);
        setup(previewAfter);
        previewAfter.move(withStep1, { partial: true });
        const values = buttonValues(previewAfter);
        expect(values).to.include("mode_S_piece");
        expect(values).to.not.include("mode_R_piece");
        expect(values).to.not.include("mode_C_own");

        const modeClick = g.handleClick(withStep1, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.valid).to.be.true;
        expect(modeClick.move).to.match(new RegExp(`^use ${major(16).uid}, m0\\.1 E/`));
    });
});

describe("Gnostica: handleClick - major arcana special powers (Phase B)", () => {
    before(() => {
        addResource("en");
    });

    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        // Must match handleClickCore's own window exactly (see
        // renderWindow's own docs - territory bounds, not the raw
        // board.minX/maxX/minY/maxY, which also includes cardless
        // wasteland cells a piece may have been pushed onto) - reusing
        // the game's own private computation directly rather than
        // duplicating its logic here, so the two can never drift apart.
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };
    const buttonValues = (g: GnosticaGame): (string | undefined)[] => {
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        return bar!.buttons!.map(b => b.value);
    };
    // Removes a uid from wherever the random initial deal happened to put
    // it (any hand, the draw pile, the discard pile) - a prerequisite for
    // safely force-placing specific cards elsewhere, since every uid is
    // unique in the 78-card deck and forcing one into a second location
    // without removing the first creates a duplicate. Manifests as rare,
    // hard-to-reproduce test flakiness (e.g. a "redraw to 6" step
    // accidentally redrawing a card that was ALSO just discarded) rather
    // than an outright crash, since nothing else in the engine checks for
    // deck-wide uniqueness at runtime.
    const pluckCard = (g: GnosticaGame, uid: string): void => {
        for (const hand of g.hands) {
            const idx = hand.indexOf(uid);
            if (idx !== -1) hand.splice(idx, 1);
        }
        let idx = g.drawPile.indexOf(uid);
        if (idx !== -1) g.drawPile.splice(idx, 1);
        idx = g.discardPile.indexOf(uid);
        if (idx !== -1) g.discardPile.splice(idx, 1);
    };

    it("regression: a major card's own primitive step tolerates a mode needing hand-card supply, same as minor arcana's own", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, -1, 0, () => major(14)); // Temperance (l0): create, create
        g.board.get(-1, 0)!.pieces = [new Piece(1, 1, "W")]; // facing k0, a genuine wasteland
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, -1, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_new");
        expect(modeClick.move).eq(`use ${major(14).uid}, l0.1 new k0`);
        expect(modeClick.valid).to.be.true; // used to be false - a major step's own mode had no "declined so far" tolerance
        const supplied = g.handleClick(modeClick.move, -1, -1, `hand_${spotUid}`);
        expect(supplied.move).eq(`use ${major(14).uid}, l0.1 new k0 ${spotUid}`);
        expect(supplied.valid).to.be.true;
        g.move(supplied.move, { trusted: true });
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
    });

    it("orientMinion (Empress step 1): board click orients the acting minion directly, no target-pick needed", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(3)); // The Empress
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")]; // minion A, standing
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const [rowE, colE] = rowColFor(g, 1, 0); // n0, east of m0
        const result = g.handleClick(cellClick.move, rowE, colE);
        expect(result.move).eq(`use ${major(3).uid}, m0.1 E`);
        expect(result.valid).to.be.true;
        g.move(result.move, { trusted: true }); // declines step 2 (create)
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("E");
        expect(g.currplayer).eq(2);
    });

    it("tradeHands (Justice step 1): a single click on the facing cell's piece swaps hands", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(11)); // Justice
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")]; // enemy B, player 2
        const handsBefore = [g.hands[0].slice(), g.hands[1].slice()];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const [rowN, colN] = rowColFor(g, 1, 0);
        const result = g.handleClick(cellClick.move, rowN, colN);
        expect(result.move).eq(`use ${major(11).uid}, m0.1 n0.1`);
        expect(result.valid).to.be.true;
        g.move(result.move, { trusted: true }); // declines step 2 (attack)
        expect(g.hands[0]).to.deep.equal(handsBefore[1]);
        expect(g.hands[1]).to.deep.equal(handsBefore[0]);
        expect(g.currplayer).eq(2);
    });

    it("tradeHands: forbids targeting one of the acting player's own pieces - a no-op dressed up as a step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(11)); // Justice
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "U")]; // own piece B, also player 1
        const result = g.validateMove(`use ${major(11).uid}, m0.1 n0.1`);
        expect(result.valid).to.be.false;
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.TRADEHANDS_MUST_TARGET_ENEMY"));
    });

    it("tradeHands: clicking the acting minion's own cell during target-pick surfaces MUST_TARGET_ENEMY immediately, instead of building a doomed self-target move", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(11)); // Justice
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")]; // enemy B, player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const selfClick = g.handleClick(cellClick.move, row, col); // m0 itself, not n0
        expect(selfClick.valid).to.be.false;
        expect(selfClick.message).eq(i18next.t("apgames:validation.gnostica.TRADEHANDS_MUST_TARGET_ENEMY"));
        expect(selfClick.move).eq(cellClick.move); // the move string never advances into the doomed state
    });

    it("orientAny (Devil): target pick auto-seeds a default orientation; a further click near the TARGET adjusts it", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(15)); // The Devil
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "S")]; // enemy B, player 2, facing S
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const [rowN, colN] = rowColFor(g, 1, 0);
        const step1 = g.handleClick(cellClick.move, rowN, colN);
        expect(step1.move).eq(`use ${major(15).uid}, m0.1 n0.1 U`);
        expect(step1.valid).to.be.true;
        const [rowO, colO] = rowColFor(g, 2, 0); // o0, east of n0 (the target)
        const step2 = g.handleClick(step1.move, rowO, colO);
        expect(step2.move).eq(`use ${major(15).uid}, m0.1 n0.1 E`);
        expect(step2.valid).to.be.true;
        g.move(step2.move, { trusted: true }); // declines steps 2 & 3
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, size: 1, orientation: "E" });
        expect(g.currplayer).eq(2);
    });

    it("hierophantReplace: same two-stage target-then-orient flow; the target is replaced by the acting player's own piece", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(5)); // The Hierophant
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "S")]; // enemy B, player 2, facing S
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const [rowN, colN] = rowColFor(g, 1, 0);
        const step1 = g.handleClick(cellClick.move, rowN, colN);
        expect(step1.move).eq(`use ${major(5).uid}, m0.1 n0.1 U`);
        const [rowO, colO] = rowColFor(g, 2, 0);
        const step2 = g.handleClick(step1.move, rowO, colO);
        expect(step2.move).eq(`use ${major(5).uid}, m0.1 n0.1 E`);
        expect(step2.valid).to.be.true;
        g.move(step2.move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "E" });
    });

    it("hierophantReplace: forbids targeting one of the acting player's own pieces - a no-op dressed up as a step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(5)); // The Hierophant
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")]; // own piece B, also player 1
        const result = g.validateMove(`use ${major(5).uid}, m0.1 n0.1 U`);
        expect(result.valid).to.be.false;
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.HIEROPHANT_MUST_TARGET_ENEMY"));
    });

    it("magicianChoice: picking a suit letter via button, then that suit's own mode buttons take over unmodified", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(1)); // The Magician
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const suitClick = g.handleClick(cellClick.move, -1, -1, "_btn_magician_R");
        expect(suitClick.move).eq(`use ${major(1).uid}, m0.1 R`);
        expect(suitClick.valid).to.be.true; // suit chosen, mode not yet - still declined
        const modeClick = g.handleClick(suitClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${major(1).uid}, m0.1 R piece m0.1 1`);
        expect(modeClick.valid).to.be.true;
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        expect(g.board.get(1, 0)!.pieces.length).eq(1);
        expect(g.currplayer).eq(2);
    });

    it("hermitTeleport: mode button seeds self as target; a click redirects it; the destination click is unrestricted", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(9)); // The Hermit
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")]; // enemy B, player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_hermit_piece");
        expect(modeClick.move).eq(`use ${major(9).uid}, m0.1 piece m0.1`); // defaults to self
        const [rowN, colN] = rowColFor(g, 1, 0);
        const redirected = g.handleClick(modeClick.move, rowN, colN);
        expect(redirected.move).eq(`use ${major(9).uid}, m0.1 piece n0.1`); // redirected to B
        // o0: not adjacent to A at all - proves the destination click has
        // no adjacency restriction, unlike every other click-to-target
        // flow in this file.
        const [rowDest, colDest] = rowColFor(g, 2, 0);
        const withDest = g.handleClick(redirected.move, rowDest, colDest);
        expect(withDest.move).eq(`use ${major(9).uid}, m0.1 piece n0.1 o0`);
        expect(withDest.valid).to.be.true;
        g.move(withDest.move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces.length).eq(0);
        expect(g.board.get(2, 0)!.pieces[0]).to.deep.include({ owner: 2, size: 1 });
        expect(g.currplayer).eq(2);
    });

    it("judgementDraw: a major discard entry toggles exactly; a minor bucket draws (and un-draws) a random matching uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(20)); // Judgement
        g.board.get(0, 0)!.pieces = [new Piece(1, 2, "U")]; // minion A, size 2 (max draw = 2)
        for (const uid of ["07", "2C", "5C", "3D"]) {
            pluckCard(g, uid);
        }
        g.hands[0] = g.hands[0].slice(0, 4); // 4 cards -> room for 2 more (6 - 4)
        g.discardPile = ["07", "2C", "5C", "3D"];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const click1 = g.handleClick(cellClick.move, -1, -1, "discard_07");
        expect(click1.move).eq(`use ${major(20).uid}, m0.2 07`);
        expect(click1.valid).to.be.true;
        const click2 = g.handleClick(click1.move, -1, -1, "discard_C_spot");
        expect(click2.valid).to.be.true;
        const pickedMatch = click2.move.match(new RegExp(`^use ${major(20).uid}, m0\\.2 07 (\\S+)$`));
        expect(pickedMatch).to.not.eq(null);
        const picked = pickedMatch![1];
        expect(["2C", "5C"]).to.include(picked);
        // Clicking the same bucket again removes the just-picked uid.
        const click3 = g.handleClick(click2.move, -1, -1, "discard_C_spot");
        expect(click3.move).eq(`use ${major(20).uid}, m0.2 07`);
        expect(click3.valid).to.be.true;
        // At maxDraw (2, after re-adding the bucket pick), a third pick is
        // rejected. Re-adding is an INDEPENDENT random draw - not
        // necessarily `picked` again - so re-derive it from click4 itself
        // rather than assuming it matches.
        const click4 = g.handleClick(click3.move, -1, -1, "discard_C_spot");
        const pickedMatch4 = click4.move.match(new RegExp(`^use ${major(20).uid}, m0\\.2 07 (\\S+)$`));
        expect(pickedMatch4).to.not.eq(null);
        const picked4 = pickedMatch4![1];
        expect(["2C", "5C"]).to.include(picked4);
        const click5 = g.handleClick(click4.move, -1, -1, "discard_D_spot");
        expect(click5.valid).to.be.false;
        expect(click5.message).eq(i18next.t("apgames:validation.gnostica.TOO_MANY_TO_DRAW", { maxDraw: 2, requested: 3 }));
        g.move(click4.move, { trusted: true });
        expect(g.hands[0]).to.include("07");
        expect(g.hands[0]).to.include(picked4);
        expect(g.discardPile).to.not.include("07");
        expect(g.discardPile).to.not.include(picked4);
        expect(g.currplayer).eq(2);
    });

    it("highPriestess: hand-card clicks toggle a discard list (no minionRef at all), defaulting to a redraw up to 6 on commit", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        for (const uid of ["2C", "5C", "AR"]) {
            pluckCard(g, uid);
        }
        g.hands[0] = ["2C", "5C", "AR"];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const click1 = g.handleClick(cellClick.move, -1, -1, "hand_2C");
        expect(click1.move).eq(`use ${major(2).uid}, 2C`);
        expect(click1.valid).to.be.true;
        const click2 = g.handleClick(click1.move, -1, -1, "hand_5C");
        expect(click2.move).eq(`use ${major(2).uid}, 2C 5C`);
        const click3 = g.handleClick(click2.move, -1, -1, "hand_2C"); // toggle back off
        expect(click3.move).eq(`use ${major(2).uid}, 5C`);
        g.move(click3.move, { trusted: true }); // step 1 commits and pauses, awaiting step 2
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6); // redrawn from 2 (3 - 1 discarded) back to 6
        expect(g.discardPile).to.include("5C");
        expect(g.currplayer).eq(1); // same seat still owes step 2
        expect(g.pendingPower).to.not.be.undefined;
        g.move(`use ${major(2).uid}, decline`, { trusted: true }); // declines the second highPriestess step
        expect(g.pendingPower).to.be.undefined;
        expect(g.currplayer).eq(2);
    });

    // The rules never mandate refilling all the way to 6 - the draw count
    // is the player's own choice, exactly like the ordinary end-of-turn
    // discard/draw action's own "Draw N" buttons.
    it("highPriestess: the Draw N button set lets the player choose fewer than the max", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        for (const uid of ["2C", "5C", "AR"]) {
            pluckCard(g, uid);
        }
        g.hands[0] = ["2C", "5C", "AR"];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const discardClick = g.handleClick(cellClick.move, -1, -1, "hand_5C");
        expect(discardClick.move).eq(`use ${major(2).uid}, 5C`);
        // maxDraw is 6 - 2 (hand after discarding 5C) = 4; choose 1 instead.
        const drawClick = g.handleClick(discardClick.move, -1, -1, "_btn_hpdraw_1");
        expect(drawClick.move).eq(`use ${major(2).uid}, 5C draw 1`);
        expect(drawClick.valid).to.be.true;
        // A count picked completes the move - tell the player to submit,
        // not the generic "Looks like a valid move" (there's a second
        // round still coming, this being round 1).
        expect(drawClick.message).eq(i18next.t("apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1_READY"));

        g.move(drawClick.move, { trusted: true });
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(3); // 2 remaining + exactly 1 drawn, not up to 6
        expect(g.pendingPower).to.not.be.undefined; // step 1 of 2 - still owes the second flip

        // Round 2: the SAME count-picker click now reports it's the LAST round.
        const resumed = g.handleClick("", -1, -1, "_btn_resume_power");
        const round2Draw = g.handleClick(resumed.move, -1, -1, "_btn_hpdraw_0");
        expect(round2Draw.message).eq(i18next.t("apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2_READY"));
    });

    // Regression: clicking a "Draw N" button early, then going back to
    // discard ANOTHER card, used to append the new uid AFTER the "draw n"
    // tail (e.g. "5C draw 1 AR") - drawIdx-based parsing then silently
    // dropped everything past "draw", so the new card was never actually
    // discarded at all, despite the move looking "valid".
    it("highPriestess: discarding another card after already choosing a draw count drops the stale count and adds the card", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2));
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        for (const uid of ["2C", "5C", "AR"]) {
            pluckCard(g, uid);
        }
        g.hands[0] = ["2C", "5C", "AR"];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const discard1 = g.handleClick(cellClick.move, -1, -1, "hand_5C");
        const drawClick = g.handleClick(discard1.move, -1, -1, "_btn_hpdraw_1"); // chosen too early
        expect(drawClick.move).eq(`use ${major(2).uid}, 5C draw 1`);

        const discard2 = g.handleClick(drawClick.move, -1, -1, "hand_AR");
        expect(discard2.move).eq(`use ${major(2).uid}, 5C AR`); // stale "draw 1" dropped, AR added
        expect(discard2.valid).to.be.true;

        g.move(discard2.move, { trusted: true }); // 0 remaining in a 3-card hand, defaults to max draw
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0]).to.not.include("AR");
        expect(g.hands[0].length).eq(6); // defaulted to max (1 remaining + 5 drawn), not stuck at a stale count
    });

    // Regression: playing High Priestess (as opposed to using it already on
    // the board) removes the card from hand BEFORE its own power resolves
    // (cmdPlay's own docs) - validation never accounted for that extra
    // card leaving, so its own max-draw bound was off by one relative to
    // what actually happens on commit (a 6-card hand, played + 2 discards,
    // is genuinely down to 3 - the true max draw is 3, not 2).
    it("highPriestess (played from hand): the draw-count max accounts for the played card itself leaving the hand", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")]; // some piece on the board, for eligibleMinionsForPlay
        for (const uid of ["02", "2C", "5C"]) {
            pluckCard(g, uid);
        }
        g.hands[0] = ["02", "2C", "5C", "AR", "AS", "AD"];
        const seed = g.handleClick("", -1, -1, "_btn_play");
        const play02 = g.handleClick(seed.move, -1, -1, "hand_02");
        expect(play02.move).eq("play 02");
        const discard1 = g.handleClick(play02.move, -1, -1, "hand_2C");
        const discard2 = g.handleClick(discard1.move, -1, -1, "hand_5C");
        expect(discard2.move).eq("play 02, 2C 5C");

        // Hand is genuinely down to 3 (6 - the played card - 2 discards),
        // so drawing 3 is legal; drawing 4 is not.
        const draw3 = g.handleClick(discard2.move, -1, -1, "_btn_hpdraw_3");
        expect(draw3.move).eq("play 02, 2C 5C draw 3");
        expect(draw3.valid).to.be.true;

        g.move(draw3.move, { trusted: true });
        expect(g.hands[0].length).eq(6); // 3 remaining + exactly 3 drawn
        expect(g.hands[0]).to.not.include("02");
        expect(g.hands[0]).to.not.include("2C");
        expect(g.hands[0]).to.not.include("5C");
    });

    // Regression: the real client's boardClick() calls game.move(result.move,
    // {partial: true}) after EVERY click, to render a live preview - this
    // used to trigger the actual (random) redraw immediately, before the
    // player had finished building their discard list or ever clicked
    // Submit. Mirrors cmdDiscard's own "discard eagerly, defer the draw"
    // convention for the ordinary end-of-turn action.
    it("highPriestess: a partial preview discards eagerly but does not redraw until the real, non-partial commit", () => {
        // A fresh instance per call, exactly like the real client's own
        // boardClick() convention (a fresh GameFactory reload from the
        // last CONFIRMED state before every partial preview, and again
        // for the real submit) - a single instance can't reuse the same
        // "5C" token for both, since the partial call already discards it
        // for real.
        const setup = (): GnosticaGame => {
            const g = new GnosticaGame(2);
            forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
            g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
            for (const uid of ["2C", "5C", "AR"]) {
                pluckCard(g, uid);
            }
            g.hands[0] = ["2C", "5C", "AR"];
            return g;
        };
        const preview = setup();
        preview.move(`use ${major(2).uid}, 5C`, { partial: true }); // exactly what a live client preview does
        expect(preview.hands[0]).to.not.include("5C"); // discarded for real...
        expect(preview.hands[0].length).eq(2); // ...but NOT yet redrawn back to 6
        expect(preview.pendingPower).to.not.be.undefined; // forcePause still fires regardless of partial
        expect(preview.currplayer).eq(1);

        const g = setup();
        g.move(`use ${major(2).uid}, 5C`, { trusted: true }); // the real, final submit
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6); // now genuinely redrawn
        expect(g.pendingPower).to.not.be.undefined; // step 1 of 2 - still owes the second flip
    });

    it("Hanged Man (move, then tradeHands): a click on a cell already 'claimed' by step 1 still starts step 2, not step 1's own refinement", () => {
        const g = new GnosticaGame(2);
        // Fully deterministic (see clearBoard's own docs): the random
        // initial deal could otherwise occasionally put The Hanged Man
        // itself at n0, which forceCardAt's own duplicate-clearing would
        // then wipe out, leaving no territory there to push.
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(12)); // The Hanged Man
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0, the territory to be pushed
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, facing n0
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const step1 = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_tile");
        expect(step1.move).eq(`use ${major(12).uid}, m0.1 tile 1`); // pushes n0's territory east; A never moves
        // m0 is BOTH step 1's own "cycle distance" click target AND
        // tradeHands' own "self" target - starting step 2 wins (see
        // handleClickCore's own docs on this priority). Self-targeting
        // tradeHands is itself forbidden (a no-op dressed up as a real
        // step - see checkTradeHands's own docs), so pickPieceTargetClick
        // now rejects it immediately (see its own tree-pruning docs) rather
        // than building the doomed step-2 move and letting it fail later -
        // this proves routing picked step 2 without ever advancing the
        // move string into that invalid state.
        const [rowM, colM] = rowColFor(g, 0, 0);
        const step2 = g.handleClick(step1.move, rowM, colM);
        expect(step2.move).eq(step1.move);
        expect(step2.valid).to.be.false;
        expect(step2.message).eq(i18next.t("apgames:validation.gnostica.TRADEHANDS_MUST_TARGET_ENEMY"));
        // Declining tradeHands (the chain's own tail) stays legal, so
        // step 1's own push still completes correctly on its own.
        g.move(step1.move, { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
        expect(g.currplayer).eq(2);
    });

    it("orientMinion/tradeHands/orientAny/hierophantReplace/judgementDraw leave the button bar uncollapsed (no mode buttons of their own)", () => {
        const setups: [number, () => void][] = [
            [3, () => undefined],  // Empress: orientMinion
            [11, () => undefined], // Justice: tradeHands
            [15, () => undefined], // Devil: orientAny
            [5, () => undefined],  // Hierophant: hierophantReplace
            [20, () => undefined], // Judgement: judgementDraw
        ];
        for (const [seq] of setups) {
            const g = new GnosticaGame(2);
            forceCardAt(g, 0, 0, () => major(seq));
            g.board.get(0, 0)!.pieces = [new Piece(1, seq === 20 ? 2 : 1, "U")];
            g.move(`use ${major(seq).uid}`, { partial: true });
            const values = buttonValues(g);
            expect(values, `seq ${seq}`).to.deep.equal(["use", "play", "orient", "discard", "pass", "declare"]);
        }
    });

    // High Priestess is the one exception - unlike the others above, its
    // own draw count IS a real player choice (see the ordinary discard/draw
    // action's own ROOT_ARGS analogue), so it gets the same count-picker
    // button set that action already has, offered as soon as the step is
    // live and no count has been chosen yet.
    it("highPriestess shows its own Draw N count-picker, same shape as the ordinary discard/draw action's own", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2));
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        g.hands[0] = g.hands[0].slice(0, 4); // room to draw, so maxDraw > 0
        g.move(`use ${major(2).uid}`, { partial: true });
        expect(buttonValues(g)).to.deep.equal(["hpdraw_2", "hpdraw_1", "hpdraw_0"]); // maxDraw = 6 - 4
    });

    it("hermitTeleport shows its own piece/tile buttons; magicianChoice shows its own suit buttons", () => {
        const gHermit = new GnosticaGame(2);
        forceCardAt(gHermit, 0, 0, () => major(9));
        gHermit.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        gHermit.move(`use ${major(9).uid}`, { partial: true });
        expect(buttonValues(gHermit)).to.deep.equal(["use", "_spacer", "hermit_piece", "hermit_tile", "declare"]);

        const gMagician = new GnosticaGame(2);
        forceCardAt(gMagician, 0, 0, () => major(1));
        gMagician.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        gMagician.move(`use ${major(1).uid}`, { partial: true });
        expect(buttonValues(gMagician)).to.deep.equal(["use", "_spacer", "magician_C", "magician_R", "magician_D", "magician_S", "declare"]);
    });
});

// #47: chatLog() naming the OTHER player involved in a power, not just the
// acting player - see gnostica.ts's own otherPlayerName() docs.
describe("Gnostica: discard/draw chat messages", () => {
    before(() => {
        addResource("en");
    });

    it("omits the discard line entirely when nothing was discarded, rather than 'X discarded .'", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // discards nothing, draws back up to 6
        const log = g.chatLog(["Alice", "Bob"]);
        const lastNode = log[log.length - 1];
        expect(lastNode.some(l => l.includes("discarded"))).eq(false);
        expect(lastNode.some(l => l.includes("drew"))).eq(true);
    });

    it("explicitly says '0' when drawing nothing, rather than a bare 'X drew'", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid]; // already at max
        g.move("discard", { trusted: true }); // discards nothing, hand already full - draws 0
        const log = g.chatLog(["Alice", "Bob"]);
        const lastNode = log[log.length - 1];
        const line = lastNode.find(l => l.includes("drew"));
        expect(line).eq(i18next.t("apresults:DECKDRAW.gnostica_deck", { player: "Alice", count: 0 }));
    });
});

describe("Gnostica: chatLog() other-player naming", () => {
    before(() => {
        addResource("en");
    });

    it("announce (Justice tradeHands): names both the acting player and the one they traded with", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(11)); // Justice
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")]; // enemy B, player 2
        g.move(`use ${major(11).uid}, m0.1 n0.1`, { trusted: true }); // declines step 2 (attack)
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("traded hands"));
        expect(line).eq(i18next.t("apresults:ANNOUNCE.gnostica", { player: "Alice", target: "Bob" }));
    });

    it("destroy (Swords piece): names whose minion was destroyed", () => {
        const g = new GnosticaGame(2);
        clearBoard(g); // fully deterministic - see clearBoard's own docs
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, small piece, on the targeted cell
        g.move(`use ${aceOfSwords().uid}, m0.1 piece n0.1 1`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("destroyed"));
        expect(line).eq(i18next.t("apresults:DESTROY.gnostica_piece", { player: "Alice", what: "1", target: "Bob" }));
    });

    it("destroy (Swords tile): names the destroyed card's uid, not a raw {{what}} placeholder", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords()); // m0, 1 pip
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0, worth 1 - exactly destroyed by 1 pip
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2, elsewhere
        g.move(`use ${aceOfSwords().uid}, m0.1 tile n0 1`, { trusted: true });
        expect(g.board.get(1, 0)?.card).eq(undefined); // territory genuinely destroyed, not just shrunk
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("destroyed"));
        expect(line).eq(i18next.t("apresults:DESTROY.gnostica_tile", { player: "Alice", what: aceOfDiscs().uid, where: "n0" }));
    });

    it("move (Rods piece): names whose minion was moved when it isn't the acting player's own", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfRods());
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0, distinct from the Rods card itself
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        g.move(`use ${aceOfRods().uid}, m0.1 piece n0.1 1 U`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("moved"));
        expect(line).eq(i18next.t("apresults:MOVE.gnostica_rod_piece", { player: "Alice", what: "1", from: "n0", to: "o0", target: "Bob" }));
    });

    it("move (Rods piece): no target named for the acting player's own minion", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move(`use ${aceOfRods().uid}, m0.1 piece m0.1 1 N`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("moved"));
        expect(line).eq(i18next.t("apresults:MOVE.gnostica_rod_piece_own", { player: "Alice", what: "1", from: "m0", to: "n0" }));
    });

    it("place (Cups enemy): names whose stash the copy came from", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        g.move(`use ${aceOfCups().uid}, m0.1 enemy n0 1`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("copy of"));
        expect(line).eq(i18next.t("apresults:PLACE.gnostica_enemy_target", { player: "Alice", where: "n0", target: "Bob" }));
    });

    it("convert (Hierophant replace): names whose piece was displaced", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(5)); // The Hierophant
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "S")]; // enemy B, player 2, facing S
        g.move(`use ${major(5).uid}, m0.1 n0.1 U`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("converted"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_hierophant_target", { player: "Alice", where: "n0", target: "Bob" }));
    });

    it("orient (Devil orientAny): names whose minion was reoriented when it isn't the acting player's own", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(15)); // The Devil
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "S")]; // enemy B, player 2, facing S
        g.move(`use ${major(15).uid}, m0.1 n0.1 U`, { trusted: true }); // declines steps 2 & 3
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("oriented"));
        expect(line).eq(i18next.t("apresults:ORIENT.gnostica_target", { player: "Alice", where: "n0", what: "1", facing: "U", target: "Bob" }));
    });

    it("orient: no target named for an ordinary turn action (always the acting player's own piece)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("orient m0.1 N", { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("oriented"));
        expect(line).eq(i18next.t("apresults:ORIENT.gnostica", { player: "Alice", where: "m0", what: "1", facing: "N" }));
    });

    it("falls back to 'Player N' when no names (or too few) are supplied - old-data/pre-#47 compatibility path", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(11)); // Justice
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")];
        g.move(`use ${major(11).uid}, m0.1 n0.1`, { trusted: true });
        const log = g.chatLog([]);
        const line = log.flat().find(l => l.includes("traded hands"));
        expect(line).eq(i18next.t("apresults:ANNOUNCE.gnostica", { player: "Player 1", target: "Player 2" }));
    });
});

describe("Gnostica: High Priestess sequenced obligation (turn-model)", () => {
    // Mirrors the identical helper in "handleClick - major arcana special
    // powers (Phase B)" - removes a uid from wherever the random initial
    // deal put it, so force-assigning g.hands[0] below can't create a
    // duplicate that gets redrawn straight back (see that helper's own docs).
    const pluckCard = (g: GnosticaGame, uid: string): void => {
        for (const hand of g.hands) {
            const idx = hand.indexOf(uid);
            if (idx !== -1) hand.splice(idx, 1);
        }
        let idx = g.drawPile.indexOf(uid);
        if (idx !== -1) g.drawPile.splice(idx, 1);
        idx = g.discardPile.indexOf(uid);
        if (idx !== -1) g.discardPile.splice(idx, 1);
    };

    const setupHP = (numplayers = 2): GnosticaGame => {
        const g = new GnosticaGame(numplayers);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        for (const uid of ["2C", "5C", "AR"]) {
            pluckCard(g, uid);
        }
        return g;
    };

    it("getPlies()/getRounds(): two same-seat plies, no synthetic pass, sharing one round until the cycle genuinely wraps", () => {
        const g = setupHP();
        g.hands[0] = ["2C", "5C", "AR"];
        g.move(`use ${major(2).uid}, 5C`, { trusted: true }); // step 1: discard 5C, redraw to 6, pauses
        expect(g.pendingPower).to.not.be.undefined;
        expect(g.currplayer).eq(1); // same seat still owes step 2
        g.move(`use ${major(2).uid}, decline`, { trusted: true }); // step 2: decline
        expect(g.pendingPower).to.be.undefined;
        expect(g.currplayer).eq(2); // now advances normally

        const plies = g.getPlies();
        const [step1, step2] = plies.slice(-2);
        expect([step1.actor, step2.actor]).to.deep.equal([1, 1]);
        // Both plies stay in the same round - proves shouldCloseRound's
        // pendingPower guard prevented a false-positive close after step 1,
        // even though currplayer (still 1) already equalled the round's
        // own opener at that point.
        expect(step1.round).eq(step2.round);
        expect(plies.some(p => p.results.some(r => r.type === "pass"))).eq(false);

        // Sparse export: one row per ply, both landing in player 1's column.
        const [row1, row2] = g.getRounds().slice(-2);
        expect(row1[0]).to.not.be.null;
        expect(row1[1]).to.be.null;
        expect(row2[0]).to.not.be.null;
        expect(row2[1]).to.be.null;
    });

    it("full scenario: step 1 pauses (currplayer unchanged, pendingPower set), step 2 resumes and clears it, hand redraws to 6", () => {
        const g = setupHP();
        g.hands[0] = ["2C", "5C", "AR"];
        g.move(`use ${major(2).uid}, 5C`, { trusted: true });
        expect(g.currplayer).eq(1);
        expect(g.pendingPower).to.not.be.undefined;
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6);
        g.move(`use ${major(2).uid}, AR`, { trusted: true }); // step 2: discard AR instead of declining
        expect(g.pendingPower).to.be.undefined;
        expect(g.currplayer).eq(2);
        expect(g.hands[0]).to.not.include("AR");
        expect(g.hands[0].length).eq(6); // redrawn back up again
    });

    it("resume-mismatch guards reject a wrong card uid, the wrong action (use vs play), and more than one step segment", () => {
        const g = setupHP();
        g.hands[0] = ["2C", "5C", "AR"];
        g.move(`use ${major(2).uid}, 5C`, { trusted: true });
        expect(g.pendingPower).to.not.be.undefined;
        expect(() => g.move("use 07, decline", { trusted: true })).to.throw(); // wrong cardUid
        expect(() => g.move(`play ${major(2).uid}, decline`, { trusted: true })).to.throw(); // wrong source (resumed via "use")
        expect(() => g.move(`use ${major(2).uid}, AR, 2C`, { trusted: true })).to.throw(); // more than one step segment
        // None of the rejected attempts cleared the obligation.
        expect(g.pendingPower).to.not.be.undefined;
        expect(g.currplayer).eq(1);
    });
});

describe("Gnostica: Fool and World", () => {
    const pluckCard = (g: GnosticaGame, uid: string): void => {
        for (const hand of g.hands) {
            const idx = hand.indexOf(uid);
            if (idx !== -1) hand.splice(idx, 1);
        }
        let idx = g.drawPile.indexOf(uid);
        if (idx !== -1) g.drawPile.splice(idx, 1);
        idx = g.discardPile.indexOf(uid);
        if (idx !== -1) g.discardPile.splice(idx, 1);
    };

    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };

    const buttonValues = (g: GnosticaGame): (string | undefined)[] => {
        // World's own step is itself a chained segment (unlike a direct
        // card's often-single-segment preview), so even a 2-segment
        // preview here already has a frame boundary - render() returns
        // an array of per-frame reps in that case; the LIVE button bar is
        // always on the last one.
        const raw = g.render();
        const rep = (Array.isArray(raw) ? raw[raw.length - 1] : raw) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        return bar!.buttons!.map(b => b.value);
    };

    const setupFool = (): GnosticaGame => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(0)); // The Fool
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        return g;
    };

    // m0: The World, minion A facing n0. n0: own piece B (to be pushed).
    // p0: The Lovers, World's own target - kept away from m0/n0/o0 so the
    // push destination (o0) never collides with it.
    const setupWorldLovers = (): GnosticaGame => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => theWorld());
        forceCardAt(g, 1, 0, () => aceOfDiscs());
        forceCardAt(g, 3, 0, () => major(6));
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")];
        return g;
    };

    it("World -> Lovers fully resolves both of Lovers' own steps in one call, no pause (hand-typed)", () => {
        const g = setupWorldLovers();
        g.move(`use ${theWorld().uid}, m0.1 ${major(6).uid}, m0.1 piece n0.1 1 U, o0.1 own o0 U`, { trusted: true });
        expect(g.pendingPower).to.be.undefined; // World's push is informationally free - no pause at all
        expect(g.currplayer).eq(2);
        const dest = g.board.get(2, 0)!; // o0
        expect(dest.pieces.length).eq(2); // B, pushed here, plus Lovers' own new piece
        expect(g.board.get(1, 0)!.pieces.length).eq(0); // B left n0
        // Three chained segments (World's own push, then Lovers' own two
        // steps) means every one of them gets its own _group wrapper.
        expect(g.results.filter(r => r.type === "_group")).to.have.length(3);
        const flat = g.results.flatMap(r => r.type === "_group" ? r.results : [r]);
        expect(flat.some(r => (r as unknown as { type: string }).type === "borrowPower")).eq(true);
    });

    it("World -> Lovers via clicks: the pushed frame's own steps become click-driven too", () => {
        const setup = setupWorldLovers;
        const g = setup();

        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [rowM, colM] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, rowM, colM);
        expect(cellClick.move).eq(`use ${theWorld().uid}`);

        // No mode button for worldUseAny (pure click-driven) - a click on
        // Lovers' own cell supplies the target directly.
        const [rowP, colP] = rowColFor(g, 3, 0);
        const targetClick = g.handleClick(cellClick.move, rowP, colP);
        expect(targetClick.move).eq(`use ${theWorld().uid}, m0.1 ${major(6).uid}`);
        expect(targetClick.valid).to.be.true;

        // Lovers' own step 1 (Rods) buttons are now on offer, proving
        // parsePendingStep's stack-awareness resolved the PUSHED frame's
        // own def, not World's own (already-exhausted) one.
        const preview1 = setup();
        preview1.move(targetClick.move, { partial: true });
        expect(buttonValues(preview1)).to.include("mode_R_piece");

        const modeClick = g.handleClick(targetClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${theWorld().uid}, m0.1 ${major(6).uid}/m0.1 piece m0.1 1`);

        const [rowN, colN] = rowColFor(g, 1, 0);
        const redirected = g.handleClick(modeClick.move, rowN, colN);
        expect(redirected.move).eq(`use ${theWorld().uid}, m0.1 ${major(6).uid}/m0.1 piece n0.1 1`);
        expect(redirected.valid).to.be.true;

        const preview2 = setup();
        preview2.move(redirected.move, { partial: true });
        expect(buttonValues(preview2)).to.include("mode_C_own");

        const step2 = g.handleClick(redirected.move, -1, -1, "_btn_mode_C_own");
        expect(step2.valid).to.be.true;

        g.move(step2.move, { trusted: true });
        expect(g.pendingPower).to.be.undefined;
        expect(g.currplayer).eq(2);
        expect(g.board.get(2, 0)!.pieces.length).eq(1); // B, pushed to o0
        expect(g.board.get(1, 0)!.pieces.length).eq(1); // Lovers' own new piece, at n0 (now vacant)
    });

    it("World rejects a self-reference and an off-board target; declining its own power outright needs a trusted caller (#49, same as any other major)", () => {
        const selfRef = new GnosticaGame(2);
        forceCardAt(selfRef, 0, 0, () => theWorld());
        selfRef.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        expect(() => selfRef.move(`use ${theWorld().uid}, m0.1 ${theWorld().uid}`, { trusted: true })).to.throw();

        const offBoard = new GnosticaGame(2);
        forceCardAt(offBoard, 0, 0, () => theWorld());
        offBoard.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        // The random initial deal could otherwise occasionally have
        // already placed Lovers somewhere on the board too.
        for (const [x, y, t] of offBoard.board.entries()) {
            if ((x !== 0 || y !== 0) && t.card?.uid === major(6).uid) {
                t.card = undefined;
            }
        }
        expect(() => offBoard.move(`use ${theWorld().uid}, m0.1 ${major(6).uid}`, { trusted: true })).to.throw(); // Lovers isn't on the board

        const decline = new GnosticaGame(2);
        forceCardAt(decline, 0, 0, () => theWorld());
        decline.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const validated = decline.validateMove(`use ${theWorld().uid}`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(-1); // #49 applies to the root the same as every other major now
        expect(() => decline.move(`use ${theWorld().uid}`, { trusted: true })).to.not.throw();
    });

    it("Fool flips a forced major -> pauses; resuming Lovers' own two steps also auto-continues Fool's own second (mandatory) flip", () => {
        const g = setupFool();
        pluckCard(g, "06");
        g.drawPile.unshift("06"); // force the flip to reveal The Lovers
        pluckCard(g, "AS");
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0 - own piece B
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")];
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, facing n0

        g.move(`use ${major(0).uid}, fool`, { trusted: true });
        expect(g.currplayer).eq(1);
        expect(g.pendingPower).to.not.be.undefined;
        // Fool's own frame stays (it still owes its own 2nd flip - only
        // 1 of its own 2 steps is done), with the revealed card pushed on top.
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["00", "06"]);
        expect(g.discardPile).to.include("06"); // flipped straight to discard, per fool()'s own docs

        // Resume: Lovers' own two steps, both in the same submission -
        // nothing about what a reveal grants stays hidden once the flip
        // itself has already happened. Fool's own draws are never
        // optional (see walkFrameStack's own docs), so the moment
        // Lovers' own frame is fully exhausted, Fool's second flip fires
        // automatically, IN THIS SAME submission - revealing a new card
        // and pausing on ITS OWN choice, rather than a separate "should
        // Fool draw again" prompt.
        g.drawPile.unshift("AS"); // force what that automatic second flip reveals
        g.move(`use ${major(0).uid}, m0.1 piece n0.1 1 U, o0.1 own o0 U`, { trusted: true });
        expect(g.pendingPower).to.not.be.undefined;
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["00", "AS"]);
        expect(g.pendingPower!.stack[0].nextStepIndex).eq(2); // Fool's own frame is now fully spent
        expect(g.currplayer).eq(1); // still paused - the turn hasn't passed yet
        expect(g.board.get(2, 0)!.pieces.length).eq(2); // Lovers' own steps DID take effect

        // Declining the second reveal's own power now fully resolves the
        // whole activation in one more submission (Fool's frame is
        // already spent, so nothing is left to auto-continue).
        g.move(`use ${major(0).uid}, decline`, { trusted: true });
        expect(g.pendingPower).to.be.undefined;
        expect(g.currplayer).eq(2);

        const plies = g.getPlies();
        const [step1, step2, step3] = plies.slice(-3);
        expect([step1.actor, step2.actor, step3.actor]).to.deep.equal([1, 1, 1]);
    });

    it("Fool flips a forced minor -> pauses; resuming its synthesized primitive step also auto-continues Fool's own second flip", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC"); // Ace of Cups - synthesized into a one-step "create" frame
        pluckCard(g, "AS");

        g.move(`use ${major(0).uid}, fool`, { trusted: true });
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["00", "AC"]);
        g.drawPile.unshift("AS"); // force what Fool's own automatic second flip reveals
        g.move(`use ${major(0).uid}, m0.1 own m0 U`, { trusted: true });
        expect(g.pendingPower).to.not.be.undefined; // Fool's own second flip auto-fired, in the same submission
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["00", "AS"]);
        expect(g.currplayer).eq(1);
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // Fool's own minion, plus the new Cups piece

        g.move(`use ${major(0).uid}, decline`, { trusted: true });
        expect(g.pendingPower).to.be.undefined;
        expect(g.currplayer).eq(2);
    });

    // Regression: Fool's own draws are never optional (walkFrameStack's
    // own docs) - declining what the first flip revealed auto-continues
    // straight into the second flip, IN THE SAME SUBMISSION, rather than
    // needing a separate "Continue"/resume round just to ask whether
    // Fool should draw again.
    it("declining what the first flip revealed auto-continues into a mandatory second flip, in one submission", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        pluckCard(g, "AD");
        g.drawPile.unshift("AC");

        g.move(`use ${major(0).uid}, fool`, { trusted: true });
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["00", "AC"]);

        g.drawPile.unshift("AD");
        g.move(`use ${major(0).uid}, decline`, { trusted: true }); // decline AC's own step
        expect(g.pendingPower).to.not.be.undefined;
        // Fool's own frame is now fully exhausted (both flips done), but
        // the forced pause on the SECOND flip's own reveal fires before
        // any cascade could pop it - so it's still sitting there, buried,
        // exactly like World's own spent frame does in the nested tests
        // below.
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["00", "AD"]);
        expect(g.pendingPower!.stack[0].nextStepIndex).eq(2);
        expect(g.discardPile).to.include.members(["AC", "AD"]); // both flips actually happened
        expect(g.currplayer).eq(1); // still paused on AD's own choice
    });

    it("Fool -> Fool: playing the Fool discards it first, so an empty draw pile can flip it right back", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups()); // any real card, distinct from the Fool
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        pluckCard(g, "00"); // avoid a duplicate wherever the random deal put it
        for (const [, , t] of g.board.entries()) {
            if (t.card?.uid === "00") t.card = undefined;
        }
        g.hands[0].push("00");
        // Empty the draw pile entirely and leave only "00" in the discard
        // pile - reshuffle() (inside fool()) will pull it right back in.
        g.drawPile.length = 0;
        g.discardPile.length = 0;
        g.discardPile.push("00");

        g.move("play 00, fool", { trusted: true });
        expect(g.pendingPower).to.not.be.undefined;
        expect(g.pendingPower!.stack.length).eq(2);
        expect(g.pendingPower!.stack[0].cardUid).eq("00"); // the OUTER Fool, still owed its own 2nd flip
        expect(g.pendingPower!.stack[1].cardUid).eq("00"); // the INNER (self-revealed) Fool, owed both of its own flips
        expect(g.pendingPower!.stack[1].nextStepIndex).eq(0);
    });

    it("World targets Fool: a nested pause, and declining the reveal auto-continues into Fool's own mandatory second flip", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        forceCardAt(g, 1, 0, () => major(0)); // The Fool, World's own target
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        pluckCard(g, "AS");

        g.move(`use ${theWorld().uid}, m0.1 00, fool`, { trusted: true });
        expect(g.pendingPower).to.not.be.undefined;
        // World's own spent frame is buried but not yet popped - the
        // forced pause fires before any cascade could reach it (same
        // "buried, not yet cleaned up" situation as Fool's own frame
        // above).
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["21", "00", "AC"]);
        expect(g.currplayer).eq(1);

        // Declining AC's own power exposes Fool's own remaining flip -
        // never optional (see walkFrameStack's own docs) - so it fires
        // automatically, in this SAME submission, revealing a new card
        // and pausing on IT instead.
        g.drawPile.unshift("AS");
        g.move(`use ${theWorld().uid}, decline`, { trusted: true }); // decline the reveal (AC's own step)
        expect(g.pendingPower).to.not.be.undefined;
        expect(g.pendingPower!.stack.map(f => f.cardUid)).to.deep.equal(["21", "00", "AS"]);
        expect(g.pendingPower!.stack[1].nextStepIndex).eq(2); // Fool's own frame is now fully spent
        expect(g.currplayer).eq(1);
    });

    it("resume-mismatch guards are keyed on rootCardUid, not the current top frame's own cardUid", () => {
        const g = setupWorldLovers();
        g.move(`use ${theWorld().uid}, m0.1 ${major(6).uid}`, { trusted: true }); // World's own step only - pauses on Lovers, no forcePause though
        // World's own push never forces a pause, so this single-segment
        // submission actually completes the WHOLE activation (Lovers' own
        // steps get implicitly declined) rather than leaving anything
        // pending - confirms this before the real point of the test below.
        expect(g.pendingPower).to.be.undefined;

        // Rebuild with a card that DOES force a pause once targeted, so a
        // genuine nested pendingPower (rootCardUid "21", top cardUid "00")
        // exists to probe.
        const g2 = new GnosticaGame(2);
        forceCardAt(g2, 0, 0, () => theWorld());
        forceCardAt(g2, 1, 0, () => major(0)); // The Fool
        g2.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        pluckCard(g2, "AC");
        g2.drawPile.unshift("AC");
        g2.move(`use ${theWorld().uid}, m0.1 00, fool`, { trusted: true });
        expect(g2.pendingPower!.rootCardUid).eq("21");
        expect(g2.pendingPower!.stack[g2.pendingPower!.stack.length - 1].cardUid).eq("AC");
        // A resume keyed on the TOP frame's own cardUid ("AC") rather than
        // rootCardUid ("21") must be rejected.
        expect(() => g2.move("use AC, decline", { trusted: true })).to.throw();
        expect(g2.pendingPower).to.not.be.undefined;
        expect(() => g2.move(`use ${theWorld().uid}, decline`, { trusted: true })).to.not.throw();
    });

    it("Fool's own root activation needs no button - selecting it already produces a complete, submittable move", () => {
        const g = setupFool();
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use ${major(0).uid}`);
        expect(cellClick.valid).to.be.true;
        expect(cellClick.complete).to.eq(0); // already complete, just not yet submitted
        expect(cellClick.message).to.eq(i18next.t("apgames:validation.gnostica.FOOL_FLIP1_READY"));

        // No button offered - the root's flip is mandatory (#49), so
        // there's nothing left to click.
        const preview = setupFool();
        preview.move(cellClick.move, { partial: true });
        expect(buttonValues(preview)).to.not.include("power_fool");
        // Nor does the partial preview itself reveal anything - the real
        // flip (and anything it would push onto the stack) only happens
        // on a genuine, non-partial commit. The preview instance does
        // still record that A pause happened (bookkeeping only, never
        // persisted - see the fresh-per-click architecture), but nothing
        // about WHAT was revealed.
        expect(preview.discardPile.length).eq(0);
        expect(preview.pendingPower?.stack).to.have.length(1);

        // The real commit is what actually flips and pauses.
        const real = setupFool();
        real.move(cellClick.move);
        expect(real.pendingPower).to.not.be.undefined;
    });

    // Regression: since Fool's own second flip is never a separate,
    // optional choice any more (it fires automatically the moment
    // declining a reveal exposes it - see walkFrameStack's own docs),
    // there's no longer a "Continue"/resume round for it at all. Clicking
    // "Decline" on a revealed card's own power already produces a
    // complete, submit-ready move whose real commit performs BOTH the
    // decline and the automatic second flip - the button bar has nothing
    // Fool-specific to offer at any point in this preview.
    it("declining a revealed card's power in the click preview is already complete, and the decline choice persists (bolded)", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use ${major(0).uid}, fool`, { trusted: true });
        expect(g.pendingPower).to.not.be.undefined;

        const declined = g.handleClick("", -1, -1, "_btn_decline_power");
        expect(declined.move).eq(`use ${major(0).uid}, decline`);
        expect(declined.valid).to.be.true;
        expect(declined.complete).to.eq(0);
        expect(declined.message).to.eq(i18next.t("apgames:validation.gnostica.DECLINE_THEN_AUTO_DRAW"));

        const preview = setupFool();
        pluckCard(preview, "AC");
        preview.drawPile.unshift("AC");
        preview.move(`use ${major(0).uid}, fool`, { trusted: true });
        preview.move(declined.move, { partial: true });
        // No button for Fool's own (automatic) flip - just the decline of
        // AC (the card that WAS actually drawn), persisting bolded, same
        // as "Use Territory"/"Play Card" persists once chosen.
        expect(buttonValues(preview)).to.not.include("power_fool");
        expect(buttonValues(preview)).to.deep.equal(["use", "decline_power", "declare"]);
        const rep = preview.render() as { areas?: { type: string; buttons?: { value?: string; label?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const declineBtn = bar.buttons!.find(b => b.value === "decline_power")!;
        expect(declineBtn.label).eq("Decline AC");
        expect(declineBtn.attributes).to.deep.equal([{ name: "font-weight", value: "bold" }]);
    });

    // Regression: a real flip's own message (validateMove("") right after
    // commit, the Continue/Decline screen) and the message shown once
    // Continue is clicked both used to be generic, never naming what was
    // actually revealed - the player could only learn that from the chat
    // log, easy to miss. Both must name the revealed card explicitly.
    it("Fool's real flip and its Continue click both name the revealed card in the message, not just the chat log", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use ${major(0).uid}`); // real, non-partial commit - actually flips
        expect(g.pendingPower).to.not.be.undefined;
        const acName = minorCards.find(c => c.uid === "AC")!.name;
        expect(g.validateMove("").message).to.eq(i18next.t("apgames:validation.gnostica.PENDING_POWER_CHOICE", { card: acName }));

        const resumed = g.handleClick("", -1, -1, "_btn_resume_power");
        expect(resumed.move).eq(`use ${major(0).uid}`);
        // A minor card's own synthesized primitive step is a fresh (step
        // 0) choice - CHOOSE_STEP is the right message key, now naming AC.
        expect(resumed.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: acName }));
    });

    // Regression: declining a revealed card's own power exposes Fool's own
    // remaining flip underneath (see walkFrameStack's own
    // "lastWasExplicitDecline" docs) - the click PREVIEW of that decline
    // used to fall back to the generic top-level bar and a bare "Looks
    // like a valid move" message, because getActionButtons()'s own
    // pendingPower-reseeded read of parsePendingStep always started
    // priorSteps at [] (see reachedViaDecline's own docs), indistinguishable
    // from a genuinely fresh/mandatory activation.
    it("World's target-cell click on Fool already produces a complete, submit-ready move - no button needed", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        forceCardAt(g, 1, 0, () => major(0)); // The Fool
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];

        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [rowM, colM] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, rowM, colM);

        const [rowN, colN] = rowColFor(g, 1, 0);
        const targetClick = g.handleClick(cellClick.move, rowN, colN);
        expect(targetClick.move).eq(`use ${theWorld().uid}, m0.1 00`);
        expect(targetClick.valid).to.be.true;
        expect(targetClick.complete).to.eq(0); // already complete via World's own free push + Fool's auto-flip

        const preview = new GnosticaGame(2);
        forceCardAt(preview, 0, 0, () => theWorld());
        forceCardAt(preview, 1, 0, () => major(0));
        preview.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        preview.move(targetClick.move, { partial: true });
        // No button needed - Fool's own flip auto-resolves on a real
        // commit regardless of any click; nothing about it is offered as
        // an optional continuation.
        expect(buttonValues(preview)).to.not.include("power_fool");
        expect(preview.discardPile.length).eq(0); // nothing revealed during this partial preview

        const real = new GnosticaGame(2);
        forceCardAt(real, 0, 0, () => theWorld());
        forceCardAt(real, 1, 0, () => major(0));
        real.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        real.move(targetClick.move); // real, non-partial commit
        expect(real.pendingPower).to.not.be.undefined; // Fool's own flip actually fired, pausing on what it revealed
        expect(real.pendingPower!.stack.map(f => f.cardUid)[0]).eq("21");
        expect(real.pendingPower!.stack.map(f => f.cardUid)[1]).eq("00");
    });

    it("chatLog() renders revealFlip/borrowPower lines, naming the actual card, not a bare uid", () => {
        addResource("en");
        const foolGame = setupFool();
        pluckCard(foolGame, "AC");
        foolGame.drawPile.unshift("AC");
        foolGame.move(`use ${major(0).uid}, fool`, { trusted: true });
        const foolRows = foolGame.chatLog(["Alice", "Bob"]);
        const acName = minorCards.find(c => c.uid === "AC")!.name;
        expect(foolRows[foolRows.length - 1].some(line => line.includes(acName))).to.be.true;

        const worldGame = setupWorldLovers();
        worldGame.move(`use ${theWorld().uid}, m0.1 ${major(6).uid}, m0.1 piece n0.1 1 U, o0.1 own o0 U`, { trusted: true });
        const worldRows = worldGame.chatLog(["Alice", "Bob"]);
        expect(worldRows[worldRows.length - 1].some(line => line.includes(major(6).name))).to.be.true;
    });

    it("randomMove() sanity check: a paused activation always yields something validateMove() accepts", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use ${major(0).uid}, fool`, { trusted: true });
        expect(g.pendingPower).to.not.be.undefined;
        const move = g.randomMove();
        expect(move).eq(`use ${major(0).uid}, decline`);
        expect(g.validateMove(move).valid).to.be.true;
        expect(() => g.move(move, { trusted: true })).to.not.throw();
    });

    it("regression: Judgement can draw itself back from the discard pile", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        pluckCard(g, "20"); // Judgement - avoid a duplicate elsewhere
        g.hands[0] = g.hands[0].slice(0, 5); // room for 1 more once "20" itself is played away
        g.hands[0].push("20");
        g.discardPile.push("21"); // padding, so "20" isn't the only discard entry
        g.move("play 20, m0.1 20", { trusted: true });
        expect(g.hands[0]).to.include("20");
        expect(g.discardPile).to.not.include("20");
        expect(g.currplayer).eq(2);
    });
});
