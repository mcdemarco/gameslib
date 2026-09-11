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
import { randomUseOrPlayMove } from "../../src/games/gnostica/randomMove";

const theWorld = () => majorCards.find(c => c.rank.seq === 21)!;
const major = (seq: number) => majorCards.find(c => c.rank.seq === seq)!;
const card = (uid: string) => minorCards.find(c => c.uid === uid)!;
const aceOfCups = () => card("AC");
const aceOfRods = () => card("AR");
const aceOfDiscs = () => card("AD");
const aceOfSwords = () => card("AS");
// Mirrors cardDisplayName's own "the " prefix for a minor card's chat/log
// display name.
const withArticle = (name: string) => `the ${name}`;

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
        // outright regardless of player 2's own hand (any major they
        // might hold is seq <= 21 too, at best a tie the code breaks
        // toward the lower-numbered player anyway). Player 2's own hand
        // is ALSO forced (to a set with no major at all) rather than left
        // to the constructor's random deal - the random deal draws from
        // the SAME single-copy deck this forced hand is also drawn from,
        // so leaving it uncontrolled could occasionally deal player 2 a
        // duplicate of one of these same forced uids (most commonly
        // World itself, per single-copy-deck rules), corrupting deck
        // integrity and leaving g.bidWinner wrong or undefined.
        g.hands[0] = [card("2R").uid, major(21).uid, card("AC").uid, "3C", "4C", "5C"];
        g.hands[1] = [card("6R").uid, card("7R").uid, card("8R").uid, card("9R").uid, card("10R").uid, "PR"];
        const forcedUids = new Set([...g.hands[0], ...g.hands[1]]);
        g.drawPile = g.drawPile.filter(uid => !forcedUids.has(uid));
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
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
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
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
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
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
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

    // The "_new" suffix is part of the CLICKABLE piece
    // identifier too (AreaPieces reuses the same string for both the
    // legend key and what the renderer reports back on click), not just
    // a cosmetic legend tag - a real click on a highlighted card must
    // still resolve to its own real uid.
    it("a real click on the highlighted card (its actual _new-suffixed piece id) still resolves, not 'not in hand'", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.drawPile = [card("7C").uid, ...g.drawPile.filter(uid => uid !== card("7C").uid)];
        g.move("discard AC", { trusted: true });
        g.move("discard", { trusted: true });
        expect(g.currplayer).eq(1);
        const newKey = `hand_${card("7C").uid}_new`;
        expect(player1HandArea(g.render() as RenderRep)?.pieces).to.include(newKey); // sanity - not vacuous
        const seeded = g.handleClick("", -1, -1, "_btn_discard");
        const click = g.handleClick(seeded.move, -1, -1, newKey);
        expect(click.valid).to.be.true;
        expect(click.move).eq(`discard ${card("7C").uid}`);
    });
});

describe("Gnostica: place", () => {
    it("places a small piece on an empty territory, orientation an explicit part of the move (U included)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        const t = g.board.get(0, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
        const g2 = new GnosticaGame(2);
        g2.move("place m0 E", { trusted: true });
        expect(g2.board.get(0, 0)!.pieces[0].orientation).eq("E");
    });

    it("draws the placed piece from the player's own stash", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        expect(g.stashes.get(1)).to.deep.equal([4, 5, 5]);
    });

    it("refuses to place a second time once you already have a piece on the board", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
        // back to player 1
        expect(() => g.move("place l0 U")).to.throw();
    });

    it("refuses to place in the void", () => {
        const g = new GnosticaGame(2);
        expect(() => g.move("place a50 U")).to.throw(); // far outside the 3x3 grid - void
    });

    it("refuses to place on an already-occupied cell", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        expect(() => g.move("place m0 U")).to.throw(); // player 2, same cell
    });
});

describe("Gnostica: orient", () => {
    it("reorients your own piece", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 N", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2's own required placement
        g.move("orient m0.1 W", { trusted: true }); // player 1 again
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("W");
    });

    it("refuses to reorient an opponent's piece", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 N", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
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
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        const notInHand = [...g.drawPile].find(uid => !g.hands[0].includes(uid))!;
        expect(() => g.move(`discard ${notInHand}`)).to.throw();
    });

    it("an explicit \"draw <n>\" draws exactly that many, not the max - it is legal to end up under 6", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
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
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        const before = [...g.hands[0]];
        g.move("discard draw 0", { trusted: true });
        expect(g.hands[0]).to.deep.equal(before);
    });

    it("refuses a \"draw <n>\" above the room left in a 6-card hand", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        const [discard1] = g.hands[0];
        // Only 1 discarded, so at most 1 can legally be drawn back.
        expect(() => g.move(`discard ${discard1} draw 2`)).to.throw();
    });

    it("refuses a negative or non-numeric \"draw <n>\"", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        expect(() => g.move("discard draw -1")).to.throw();
        expect(() => g.move("discard draw abc")).to.throw();
    });
});

describe("Gnostica: turn order", () => {
    it("advances currplayer around the table and back", () => {
        const g = new GnosticaGame(3);
        expect(g.currplayer).eq(1);
        g.move("place m0 U", { trusted: true });
        expect(g.currplayer).eq(2);
        g.move("place l0 U", { trusted: true });
        expect(g.currplayer).eq(3);
        g.move("place n0 U", { trusted: true });
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
                const picks = g.biddingPool!.slice(0, needed);
                g.move(`redraw ${picks.join(" ")}`, { trusted: true });
            }
            expect(g.phase).eq("main");
            expect(g.currplayer).eq(2); // winner goes first
            g.move("place m0 U", { trusted: true }); // winner's first main-phase turn (no board presence yet)
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2 - keeps their own board presence legal
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
        expect(g.lastTurner).eq(1);
        g.move("discard", { trusted: true }); // player 2's turn
        expect(g.lastTurner).eq(1);
        g.move("discard", { trusted: true }); // player 1's resolving turn
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([1]);
    });

    // currplayer must still rotate past the winner on the winning move
    // itself, even though winning via resolveAnnouncedTurn() sets
    // this.gameover directly (unlike an elimination-triggered endgame,
    // where checkEOG() sets it only AFTER nextPlayer() already ran).
    // External move-history/chat logs attribute move N to whichever player
    // stack[N-1].currplayer names, so a currplayer that doesn't rotate on
    // the final move makes it look like the PREVIOUS player acted twice in
    // a row instead of the actual winner having the last turn. Checked for
    // both 2 and 3 players.
    for (const numplayers of [2, 3] as const) {
        it(`currplayer still rotates past the winner on the winning move itself (${numplayers}-player)`, () => {
            const g = new GnosticaGame(numplayers);
            const cells = ["m0", "l0", "n0"].slice(0, numplayers);
            for (const cell of cells) {
                g.move(`place ${cell} U`, { trusted: true });
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
            // currplayer must rotate to 2 on the winning move itself,
            // exactly as every other move does.
            expect(g.currplayer).eq(2);
        });
    }

    it("eliminates the announcing player if they fall short of the target score, without ending the game with players left", () => {
        const g = new GnosticaGame(3);
        // Each player's single placed piece scores at most 3 (whatever card
        // it's on) - always short of the 9-point target, no board rigging needed.
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move("place n0 U", { trusted: true }); // player 3
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move("place n0 U", { trusted: true }); // player 3
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
        g.move("discard (last)", { trusted: true }); // player 1 announces
        g.move("discard", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // player 1's resolving turn - falls short, eliminated
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([2]);
    });

    it("refuses to announce while another player's announcement hasn't resolved yet", () => {
        const g = new GnosticaGame(3);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move("place n0 U", { trusted: true }); // player 3
        g.move("discard (last)", { trusted: true }); // player 1 announces
        expect(() => g.move("discard (last)")).to.throw(); // player 2 tries to announce too
    });

    it("\"target-8\" variant: 8 points wins, unlike the default target of 9", () => {
        const g = new GnosticaGame(2, ["target-8"]);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move("place n0 U", { trusted: true }); // player 3
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
        // The eliminated ply's own line must still name the actual actor
        // (Alice, who WAS still currplayer for that ply) even though
        // currplayer itself has since moved on past the skipped seats.
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move("place n0 U", { trusted: true }); // player 3
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
    it("#49: a bare use with no power step is not yet submittable, but a trusted caller may still apply it (test setup, click-preview 'still skipped so far' states)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2
        const validated = g.validateMove(`use ${aceOfCups().uid}`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(-1);
        expect(validated.message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: aceOfCups().name }));
        g.move(`use ${aceOfCups().uid}`, { trusted: true }); // player 1, no power step
        expect(g.board.get(0, 0)!.pieces.length).eq(1); // nothing changed but the turn
        expect(g.currplayer).eq(2);
    });

    it("Cups (own): adds an own small piece to the target cell", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2
        g.move(`use ${aceOfCups().uid}/m0.1 own n0 U`, { trusted: true });
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
        g.move(`use ${aceOfCups().uid}/m0.1 enemy n0 1`, { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
        expect(g.stashes.get(2)![0]).eq(3); // player 2's stash, not player 1's
    });

    it("Cups (new): creates a territory on a wasteland from a hand card", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, -1, 0, () => aceOfCups()); // l0
        g.move("place l0 W", { trusted: true }); // player 1, pointing further west
        g.move("place n0 U", { trusted: true }); // player 2
        // The random deal may not happen to include a spot minor - dedupe
        // and force one in, rather than relying on chance (a real flaky
        // failure otherwise, on the rare hand with none).
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        g.move(`use ${aceOfCups().uid}/l0.1 new k0 ${spotUid}`, { trusted: true });
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): moves the minion itself and reorients it", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move(`use ${aceOfRods().uid}/m0.1 piece m0.1 1 N`, { trusted: true });
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
        g.move("place l0 U", { trusted: true }); // player 2, onto the wasteland beside m0
        g.move(`use ${aceOfRods().uid}/m0.1 tile 1`, { trusted: true });
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
        g.move("place r0 U", { trusted: true }); // player 2, onto cluster B's own card

        // A real initial placement always starts at size 1 (see
        // MUST_PLACE_FIRST's own wording); bumped directly to 3 here so a
        // real, validated dist-3 push is reachable in one move, matching
        // the bare-board test's exact push (fromX=1, toX=4) rather than
        // needing several turns of Discs growth first, which isn't what
        // this test is about.
        g.board.get(0, 0)!.pieces[0].size = 3;

        const pushMove = `use ${aceOfRods().uid}/m0.3 tile 3`;
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move(`use ${aceOfDiscs().uid}/m0.1 piece m0.1 N`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2, orientation: "N" });
    });

    it("Discs (tile): grows the pointed-at territory's value by one, discarding the old card", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        const target = g.board.get(1, 0)!; // n0
        const oldUid = card("2C").uid;
        target.card = card("2C"); // a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2
        const royaltyUid = "KS"; // King of Swords, worth 2 - injected so the test doesn't depend on the random deal
        g.hands[0].push(royaltyUid);
        g.move(`use ${aceOfDiscs().uid}/m0.1 tile n0 ${royaltyUid}`, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("Swords (piece): shrinks a targeted enemy piece, returning it to their stash", () => {
        const g = new GnosticaGame(2);
        clearBoard(g); // fully deterministic - see clearBoard's own docs
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, small piece, on the targeted cell - stash now [4,5,5]
        g.move(`use ${aceOfSwords().uid}/m0.1 piece n0.1 1`, { trusted: true });
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
        g.move("place n0 U", { trusted: true }); // player 2
        // The random deal may not happen to include a spot minor at all -
        // force one in rather than relying on chance (a real flaky failure
        // otherwise, on the rare hand with none).
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        g.move(`use ${aceOfSwords().uid}/m0.1 tile l0 1 ${spotUid}`, { trusted: true });
        expect(g.board.get(-1, 0)!.card?.uid).eq(spotUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("play: uses a hand card's power through any of the player's board pieces/then discards it", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1, defaults to "U" - no relation to the played card's suit
        g.move("place l0 U", { trusted: true }); // player 2
        const cupsUid = "2C";
        // The random deal may already hold a copy - dedupe first so the
        // post-play "not.include" assertion below can't see a leftover.
        g.hands[0] = g.hands[0].filter(c => c !== cupsUid);
        g.hands[0].push(cupsUid);
        // The minion at m0 points "U", so it can only target its own
        // cell - add the second piece there rather than at an adjacent one.
        g.move(`play ${cupsUid}/m0.1 own m0 U`, { trusted: true });
        expect(g.hands[0]).to.not.include(cupsUid);
        expect(g.discardPile).to.include(cupsUid);
        expect(g.board.get(0, 0)!.pieces.length).eq(2);
        expect(g.board.get(0, 0)!.pieces[1]).to.deep.include({ owner: 1, size: 1 });
    });

    it("refuses to use a uid that isn't a real card at all", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        expect(() => g.move("use ZZ")).to.throw(); // not a real card uid
    });

    it("refuses to use a real card uid that isn't currently on the board", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        const unplacedUid = g.drawPile[0]; // definitely not on the board
        expect(() => g.move(`use ${unplacedUid}`)).to.throw();
    });

    it("refuses to use a card the acting player has no minion on", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place n0 U", { trusted: true }); // player 2, elsewhere
        // player 1's turn again after player 2's placement
        g.move("discard", { trusted: true });
        // now player 2's turn - they have no piece on m0
        expect(() => g.move(`use ${aceOfCups().uid}`)).to.throw();
    });

    it("refuses to USE World's power against a malformed target", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        // "C" isn't any major arcana card's own uid - checkWorldChoosePower
        // rejects it as NO_SUCH_MAJOR_ON_BOARD.
        expect(() => g.move(`use ${theWorld().uid}/m0.1 C own m0 U`)).to.throw();
    });

    // World is subject to #49 like every other major now (see the Fool/
    // World test suite below for full coverage) - skipping its power
    // entirely still needs a trusted caller to bypass #49, exactly like
    // every other major arcana card.
    it("skipping World's power outright is legal for a trusted caller, but not yet submittable untrusted (#49)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const validated = g.validateMove(`use ${theWorld().uid}`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(-1);
        expect(() => g.move(`use ${theWorld().uid}`, { trusted: true })).to.not.throw();
    });
});

describe("Gnostica: activate/play - major arcana chaining", () => {
    it("#49: skipping every power step is not yet submittable, but a trusted caller may still apply it (test setup, click-preview 'still skipped so far' states)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        const validated = g.validateMove(`use ${major(6).uid}`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(-1);
        expect(validated.message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: major(6).name }));
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
        g.move(`use ${major(6).uid}/m0.1 piece n0.1 1 U/o0.1 own o0 U`, { trusted: true });
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
        g.move(`use ${major(6).uid}/m0.1 piece n0.1 1 U/o0.1 own o0 U`, { trusted: true });
        // Confirms the move's own results really are grouped (not flat) -
        // otherwise this test would pass even without the chat()-side
        // _group fix, since a flat result list needs no unwrapping at all.
        expect(g.results.filter(r => r.type === "_group")).to.have.length(2);
        const log = g.chatLog(["Alice", "Bob"]);
        const lastNode = log[log.length - 1];
        expect(lastNode.some(l => l.includes("moved"))).eq(true); // step 1 (rod-piece)
        expect(lastNode.some(l => l.includes("added"))).eq(true); // step 2 (cups-own)
    });

    // validateMove() itself never mutates the board, so a later step
    // naming the exact minion an earlier step in this SAME chain just
    // moved/created must still resolve correctly for an untrusted caller
    // (the Lovers test above only exercises this with {trusted: true},
    // which skips validateMove() entirely).
    it("Chariot (move, then move): an untrusted move validates and applies when step 2 acts through step 1's own relocated piece", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(7)); // The Chariot: move, then move
        forceCardAt(g, 3, 0, () => aceOfDiscs()); // keeps o0 (2,0) a genuine wasteland, not void
        g.move("place m0 E", { trusted: true }); // player 1, pointing east
        g.move("place l0 U", { trusted: true }); // player 2
        // No trailing orientation on either step - the minion never
        // changes facing (stays E throughout), and a same-facing "E"
        // would now be a hard-rejected no-op (#76).
        const move = `use ${major(7).uid}/m0.1 piece m0.1 1/n0.1 piece n0.1 1`;
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

    // Direct, low-level regression coverage for chainMinion itself (the
    // Phase 1 fragility fix) - a relocation/in-place mutation prunes its
    // own pre-mutation ref (never left dangling to be mistaken for a
    // second, still-live candidate), while a genuine creation is purely
    // additive (both the acting piece and the new one stay real,
    // independent candidates for whatever step comes next).
    it("chainMinion: a relocation replaces its own pre-move ref; a creation is purely additive", () => {
        const g = new GnosticaGame(2);
        const chainMinion = (GnosticaGame as unknown as {
            chainMinion: (minions: { x: number; y: number; index: number }[], outcome: { newMinion?: { x: number; y: number; index: number }; replacesMinion?: { x: number; y: number; index: number } }) => { x: number; y: number; index: number }[];
        }).chainMinion;
        void g; // unused - chainMinion is static, called on the class itself

        const original = [{ x: 0, y: 0, index: 0 }];
        // Relocation (Rods' own "piece" move, Discs' grow, Swords' shrink,
        // Hierophant's replace, Hermit's teleport, orientMinion/orientAny's
        // own reorient all set replacesMinion) - the old ref is gone.
        const afterMove = chainMinion(original, {
            newMinion: { x: 1, y: 0, index: 0 },
            replacesMinion: { x: 0, y: 0, index: 0 },
        });
        expect(afterMove).to.deep.equal([{ x: 1, y: 0, index: 0 }]);

        // Creation (Cups' own "create" modes - the only newMinion producer
        // that never sets replacesMinion) - both the original piece and
        // the freshly created one remain real, independent candidates.
        const afterCreate = chainMinion(original, {
            newMinion: { x: 2, y: 0, index: 0 },
        });
        expect(afterCreate).to.deep.equal([{ x: 0, y: 0, index: 0 }, { x: 2, y: 0, index: 0 }]);

        // No outcome at all (judgementDraw, a skipped step, etc.) - the
        // pool is returned completely unchanged.
        expect(chainMinion(original, {})).to.deep.equal(original);
    });

    // randomMove()'s own separate simulator (buildRandomChain) threads
    // chainMinion the same way walkFrameStack/validateFrameStack do -
    // stress-tested here since Chariot's own "move, then move" is exactly
    // the shape (a second step whose own target only exists at the FIRST
    // step's post-move position) that exposed the chainMinion ordering
    // bug this session's own Phase 1 fix addressed. Chariot is the ONLY
    // card player 1 has a piece on, so randomUseOrPlayMove("use") always
    // resolves to it specifically, rather than leaving that to chance
    // across whatever else randomMove()'s own top-level dispatch might
    // otherwise pick.
    it("randomMove() stress check: Chariot's own 'move, then move' never throws, however randomChain happens to build it", () => {
        for (let i = 0; i < 60; i++) {
            const g = new GnosticaGame(2);
            clearBoard(g);
            forceCardAt(g, 0, 0, () => major(7)); // The Chariot
            forceCardAt(g, 3, 0, () => aceOfDiscs());
            g.move("place m0 E", { trusted: true });
            g.move("place l0 U", { trusted: true });
            expect(() => randomUseOrPlayMove(g, "use")).to.not.throw();
        }
    });

    it("Strength: a single grow step may skip straight from spot to major arcana (skipLadder)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(8)); // Strength
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        forceCardAt(g, 1, 0, () => card("AC")); // n0 - spot, worth 1
        g.hands[0].push("00"); // The Fool, worth 3 - injected regardless of the random deal
        g.move(`use ${major(8).uid}/m0.1 tile n0 00`, { trusted: true }); // only ONE of Strength's two grow steps needed
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
        g.move(`use ${major(7).uid}/m0.3 piece m0.3 3 E/j0.3 piece j0.3 3 U`, { trusted: true });
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
        g.move(`use ${major(3).uid}/m0.1.N U/m0.1 own m0 U`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(4); // ignoreCapacity let a 4th piece in
    });

    it("orientMinion: a same-facing (no-op) reorientation is rejected, not silently accepted as a real step", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(3)); // The Empress
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        const validated = g.validateMove(`use ${major(3).uid}/m0.1 E`);
        expect(validated.valid).to.be.false;
        expect(validated.message).to.eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        // Genuinely reorienting first still validates fine.
        expect(g.validateMove(`use ${major(3).uid}/m0.1 N`).valid).to.be.true;
    });

    it("Devil: three orientAny steps, including reorienting the acting minion mid-chain", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(15)); // The Devil
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")]; // minion, standing
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")]; // an enemy piece, east of m0
        g.move(
            // Step 1: orient the minion itself from "U" to "E", so it can now target n0.
            // Step 2: orient the enemy piece at n0 to face away (W).
            `use ${major(15).uid}/m0.1 m0.1 E/m0.1 n0.1 W/m0.1 m0.1 U`,
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
        g.move(`use ${major(20).uid}/m0.2 KS 00`, { trusted: true });
        expect(g.hands[0]).to.include.members(["KS", "00"]);
        expect(g.discardPile).to.deep.equal([]);
    });

    it("High Priestess: two discard-and-redraw rounds, no minion reference needed", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const [firstDiscard] = g.hands[0];
        g.move(`use ${major(2).uid}/${firstDiscard}`, { trusted: true }); // only the first of the two rounds
        expect(g.hands[0]).to.not.include(firstDiscard);
        expect(g.hands[0].length).eq(6);
    });

    it("Magician: chooses which suit primitive to use for its one step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(1)); // The Magician
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        g.move(`use ${major(1).uid}/m0.1 C own m0 U`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // used Cups' "own" mode
    });

    it("refuses more power-step segments than the card actually grants", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(1)); // The Magician - only 1 power
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        expect(() => g.move(`use ${major(1).uid}/m0.1 C own m0 U/m0.1 C own m0 U`)).to.throw();
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
        const move = `use ${major(6).uid}/m0.1 piece n0.1 1 U/o0.1 own o0 U`;
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
        g.move(`use ${major(6).uid}/m0.1 piece n0.1 1 U/o0.1 own o0 U`, { trusted: true });
        // liveMove is cleared on a real commit - nothing "in progress" left.
        const reps = g.render() as RepLike[];
        expect(reps.length).eq(2);
        expect(barValues(reps[0])).eq(undefined); // no buttonBar area at all on the historical frame
        expect(barValues(reps[1])).to.not.eq(undefined); // the final/live rep still gets its own normal bar
    });

    it("0 real steps never produce an array or grouped results", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        g.move(`use ${aceOfCups().uid}`, { trusted: true }); // 0 steps - fully skipped
        expect(Array.isArray(g.render())).eq(false);
        expect(g.results.some(r => r.type === "_group")).eq(false);
    });

    it("1 real step never produces an array or grouped results, even on a card that could have taken more", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers - could take up to 2 steps
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.move(`use ${major(6).uid}/m0.1 piece m0.1 1 E`, { trusted: true }); // only step 1, step 2 skipped
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
        g.move(`use ${major(6).uid}/m0.1 piece n0.1 1 U/o0.1 own o0 U`, { trusted: true });
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
            // (E, W, U, S) this must land on W next, not jump straight to S.
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
    // major arcana powers bypass CellContents.canAdd()'s check), and
    // pyramids must never be rendered stacked/overlapping past that point
    // either.
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2 - keeps their own board presence legal
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
        g.move(`use ${aceOfCups().uid}/${minionCell}.1 own ${targetCell} U`, { trusted: true });
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
        g.move(`use ${major(15).uid}/${minionCell}.1 ${targetCell}.1 N`, { trusted: true });
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
        g.move(`use ${major(5).uid}/${minionCell}.1 ${targetCell}.1 N`, { trusted: true });
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
        g.move(`place ${neighbourCell} U`, { trusted: true }); // player 2

        const useMove = `use ${aceOfCups().uid}/${originCell}.1 own ${neighbourCell} U`;
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
        expect(result.move).eq("place m0 U?"); // "?" - seeded default, not yet a deliberate choice
    });

    // A bare "place <cell> U?" is already grammatically complete
    // (orientation defaults to "U"), but the trailing "?" tells
    // validatePlace itself that it's still merely a seeded default, not
    // yet a deliberate choice (see its own docs) - complete:0 straight
    // from validateMove, no click-time downgrade needed. Without it, the
    // interface would auto-submit "U" on the very first click, before the
    // player ever gets a chance to click again and cycle to a real
    // facing.
    it("place: the first click is never auto-submittable - complete stays 0 even though the move is already valid", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(0);
    });

    // playground.js's boardClick() only re-renders the live preview
    // (updating the button bar) when canrender or complete>=0 is set, so
    // canrender must be set on every valid click result regardless of
    // complete - not just the ones that happen to be complete:0/1 - or the
    // button bar goes visibly stale after a real click even though the
    // returned message was correct.
    it("sets canrender on a valid complete:-1 result - a top-level button choice - not just complete>=0 ones", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_use");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.canrender).eq(true);
    });

    it("sets canrender on a valid complete:-1 result - a freshly-picked card, mode not chosen yet", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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
        expect(east.move).eq("place m0 U E"); // mandatory "U" stays; E is the optional trailing correction
    });

    it("place: clicking a non-adjacent cell restarts placement there instead", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0);
        const first = g.handleClick("", row, col);
        const [rowFar, colFar] = rowColFor(g, 2, 0); // "o0", two cells east - not adjacent to m0
        const far = g.handleClick(first.move, rowFar, colFar);
        expect(far.valid).to.be.true;
        expect(far.move).eq("place o0 U?"); // a fresh restart - seeded default again
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
        expect(first.move).eq(`place ${placeCell} U?`);
        const [rowVoid, colVoid] = rowColFor(g, 3, 1);
        const east = g.handleClick(first.move, rowVoid, colVoid);
        expect(east.valid).to.be.true;
        expect(east.move).eq(`place ${placeCell} U E`);
    });

    // A hand-typed "place l0 U" never carries "?" at all - it's the
    // player's own deliberate choice, genuinely complete:1, unlike the
    // click flow's own seeded default.
    it("place: a hand-typed facing (no \"?\") is genuinely complete, not provisional", () => {
        const g = new GnosticaGame(2);
        const result = g.validateMove("place m0 U");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(1);
    });

    // The "?" is purely a UI/completeness marker - a real (non-partial)
    // commit still works with it present, creates the piece correctly,
    // and drops it from the persisted move string.
    it("place: submitting a still-\"?\"-marked move works, and the \"?\" is dropped from the persisted move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U?", { trusted: true });
        const t = g.board.get(0, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
        expect(g.lastmove).eq("place m0 U");
    });

    it("orient: clicking your own piece (with pieces already on the board/and Orient chosen) starts an orient move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        expect(seed.move).eq("orient");
        const result = g.handleClick(seed.move, row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("orient m0.1");
        // The minion is chosen; its facing is a separate decision only a
        // further click may make - never auto-assigned (see
        // validateOrient's own PICK_DIRECTION_TO_ORIENT docs).
        expect(result.complete).eq(-1);
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT"));
    });

    it("orient: clicking the piece's own cell again re-affirms \"up\"; clicking a neighbour sets that facing directly", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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

    it("orient: clicking a non-adjacent/unoccupied cell falls back to fresh-selection handling", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const first = g.handleClick(seed.move, row, col);
        expect(first.move).eq("orient m0.1");
        const [rowFar, colFar] = rowColFor(g, 2, 0); // "o0", not adjacent to m0, no piece there either
        const far = g.handleClick(first.move, rowFar, colFar);
        expect(far.valid).to.be.false; // no piece of the acting player's there to (re-)select
    });

    // Regression: orient's own first click used to grab whichever of the
    // player's own pieces happened to be first at the clicked cell, with
    // no way to pick a different one - now routed through the same
    // minion-selection primitive "use"/"play" already use.
    it("orient: 2+ of the player's own distinguishable pieces at one cell offer a minion-picker/instead of silently acting on the first", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U"), new Piece(1, 2, "U")]; // two distinguishable own minions
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const clicked = g.handleClick(seed.move, row, col);
        expect(clicked.valid).to.be.true;
        expect(clicked.complete).eq(-1);
        expect(clicked.move).eq("orient m0");
        expect(clicked.message).eq(i18next.t("apgames:validation.gnostica.PICK_MINION_BUTTON"));
        g.move(clicked.move!, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const pickButtons = bar!.buttons!.filter(b => b.value?.startsWith("orientpick_"));
        expect(pickButtons.length).eq(2);
        const picked = g.handleClick(clicked.move!, -1, -1, `_btn_${pickButtons[1].value!}`);
        expect(picked.valid).to.be.true;
        expect(picked.move).eq("orient m0.2");
    });

    it("choosing Orient via the button bar seeds an instructional, not-yet-valid move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_orient");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq("orient");
    });

    it("board clicks are ambiguous with no action chosen once pieces are on the board - no default guess", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.false;
    });

    it("Use Territory (activate) via the button bar, then a board click, builds a use move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        // Force a card whose own "use" is never immediately complete - the
        // random deal could otherwise occasionally land Fool/World at m0,
        // both of which produce a complete:0 root activation with no power
        // step needed at all (see their own dedicated tests), which this
        // test isn't exercising.
        forceCardAt(g, 0, 0, () => aceOfCups());
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const uid = g.hands[0][0];
        const seed = g.handleClick("", -1, -1, "_btn_play");
        const result = g.handleClick(seed.move, -1, -1, `hand_${uid}`);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`play ${uid}`);
    });

    it("Pass immediately builds a submittable, genuinely no-op discard/draw move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_pass");
        expect(result.valid).to.be.true;
        // Not just "discard" - that bare form silently draws back to max,
        // which isn't actually a pass. Pass needs explicit "draw 0" too.
        expect(result.move).eq("discard draw 0");
    });

    it("Discard/Draw carries instructions, unlike Pass's own already-complete seed", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_discard");
        expect(result.valid).to.be.true;
        expect(result.move).eq("discard");
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.DISCARD_CARDS_OPTIONAL"));
        // No "draw <n>" yet - the move is already legal (an omitted draw
        // defaults to the max at commit time), but the string hasn't
        // recorded an explicit draw decision, so genuinely complete:0,
        // regardless of hand contents (see validateDiscard's own docs) -
        // not the -1 an actually-illegal move would get.
        expect(result.complete).eq(0);
        const withCount = g.handleClick(result.move, -1, -1, "_btn_drawcount_0");
        expect(withCount.move).eq("discard draw 0");
        expect(withCount.complete).eq(1);
    });

    it("Declare appends last to an in-progress move, and toggles it back off", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const seed = g.handleClick("", -1, -1, "_btn_pass"); // "discard draw 0"
        const declared = g.handleClick(seed.move, -1, -1, "_btn_declare");
        expect(declared.valid).to.be.true;
        expect(declared.move).eq("discard draw 0 (last)");
        const undeclared = g.handleClick(declared.move, -1, -1, "_btn_declare");
        expect(undeclared.move).eq("discard draw 0");
    });

    it("Declare works even with no base action chosen yet, and survives switching to a real action afterwards", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        // The random initial deal could otherwise occasionally put The
        // Fool itself at m0, whose own root activation is immediately
        // complete:0 (#49 exempts it), breaking this test's own
        // complete:-1 expectation below (see forceCardAt's own docs on
        // this exact class of flake).
        forceCardAt(g, 0, 0, () => major(1)); // The Magician
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move("place n0 U", { trusted: true }); // player 3
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
        g.move("place m0 U", { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar!.buttons!.length).eq(1);
        expect(bar!.buttons![0].value).eq("place");
    });

    it("shows the full action set once a placement is genuinely committed", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true }); // back to player 1
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar!.buttons!.length).greaterThan(1);
    });

    // this.lastmove/this.results don't reset between turns on their own,
    // so hasLiveMoveInProgress() must keep a committed action from the
    // PREVIOUS player's finished turn from misreading as the NEW current
    // player's own in-progress action (most visibly when the two share a
    // contested cell) - right after a real commit, before the next player
    // has clicked anything at all, nothing should be highlighted.
    it("does not highlight a stale button before the next player's own first click", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2 - now player 1's turn again
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2 - now player 1's turn again
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const clicked = g.handleClick(seed.move, row, col);
        expect(clicked.move).eq("orient m0.1");
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const [uid1, uid2] = g.hands[0];
        const btn = g.handleClick("", -1, -1, "_btn_discard");
        const seeded = g.handleClick(btn.move, -1, -1, `hand_${uid1}`);
        const built = g.handleClick(seeded.move, -1, -1, `hand_${uid2}`);
        expect(built.move).eq(`discard ${uid1} ${uid2}`);
        const result = g.handleClick(built.move, -1, -1, "_btn_drawcount_1");
        expect(result.valid).to.be.true;
        expect(result.move).eq(`discard ${uid1} ${uid2} draw 1`);
        g.move(result.move, { trusted: true });
        expect(g.hands[0].length).eq(5); // 4 left after discarding 2, +1 drawn back
    });

    it("still highlights Use Territory during a live activate-skipping-power preview (no results pushed)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        // The random initial deal could otherwise occasionally put The Fool
        // itself at m0, whose own root activation shows a dedicated Use/
        // Decline pair instead of the ordinary top-level bar this test
        // means to check (see forceCardAt's own docs on this exact class
        // of flake).
        forceCardAt(g, 0, 0, () => major(1)); // The Magician
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const uid0 = g.board.get(0, 0)!.card!.uid;
        const clicked = g.handleClick(seed.move, row, col);
        expect(clicked.move).eq(`use ${uid0}`);
        g.move(clicked.move, { partial: true }); // live preview, power still skipped - pushes zero results
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const activateBtn = bar!.buttons!.find(b => b.value === "use");
        // lastmove-based detection still catches this case, since lastmove is
        // set unconditionally regardless of pushed results
        expect(activateBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
    });

    // A CONTESTED cell (both players have a piece there) defeats the
    // narrower "does the current player own a piece at that result's
    // cell" check alone, since the new current player genuinely does have
    // a piece there too - only knowing whether a move() call has happened
    // yet THIS turn can tell the two apart.
    it("does not carry a stale mode-button set into a contested cell on the next player's fresh turn", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true }); // player 1's piece on m0, "U"
        g.move("place l0 U", { trusted: true }); // player 2, elsewhere
        g.board.get(0, 0)!.pieces.push(new Piece(2, 1, "U")); // contrive: player 2 ALSO on m0 now
        g.move(`use ${aceOfCups().uid}/m0.1 own m0 U`, { trusted: true }); // player 1 uses Cups (own), ending their turn
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2 - now player 1's turn again
        const [row, col] = rowColFor(g, -1, 0); // "l0", player 2's piece
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.false;
    });

    it("discard: clicking a hand card toggles it into a discard move/and clicking again toggles it back out", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // discard requires pieces already on the board
        g.move("place l0 U", { trusted: true }); // back to player 1's turn
        const uid = g.hands[0][0];
        const btn = g.handleClick("", -1, -1, "_btn_discard");
        const first = g.handleClick(btn.move, -1, -1, `hand_${uid}`);
        expect(first.valid).to.be.true;
        expect(first.move).eq(`discard ${uid}`);
        expect(first.complete).eq(0); // same auto-submit guard as place/orient
        const second = g.handleClick(first.move, -1, -1, `hand_${uid}`);
        expect(second.valid).to.be.true;
        expect(second.move).eq("discard");
    });

    it("a bare hand-card click with no action selected yet is rejected, not defaulted into discard", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const uid = g.hands[0][0];
        const result = g.handleClick("", -1, -1, `hand_${uid}`);
        expect(result.valid).to.be.false;
        expect(result.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST"));
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
    // docs) - a player toggling multiple hand cards into one discard move
    // must see the whole batch resolve together only once the move is
    // truly submitted, not each card discarded and immediately replaced
    // one at a time.
    it("move(..., {partial: true}) applies the move's effects without advancing the turn or persisting it", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true }); // back to player 1
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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
    type DiscardRenderRep = { legend: Record<string, { colour?: unknown; text?: string }[]>; areas?: { pieces?: string[] }[] };
    const discardArea = (rep: DiscardRenderRep) => rep.areas?.find(a => a.pieces?.some(p => p.startsWith("discard_")));

    it("tags a card discarded on the most recent move, tinted the same theme-relative muted colour as a new hand card", () => {
        // A major arcana card specifically - unlike a minor, it gets its
        // own individual legend entry rather than folding into a suit/
        // category bucket (see the next test for that case).
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        g.hands[0] = [major(3).uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.move(`discard ${major(3).uid}`, { trusted: true });
        const rep = g.render() as DiscardRenderRep;
        const newKey = `discard_${major(3).uid}_new`;
        expect(discardArea(rep)?.pieces).to.include(newKey);
        expect(rep.legend[newKey].some(gl => gl.colour !== undefined)).to.be.true;
    });

    it("a minor card only tints its own share of the bucket, not the whole count", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        g.discardPile = [card("2C").uid]; // one spot cup already discarded earlier
        g.hands[0] = [card("AC").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid, card("7C").uid];
        g.move("discard AC", { trusted: true }); // a second spot cup, discarded just now
        const rep = g.render() as DiscardRenderRep;
        const pieces = discardArea(rep)?.pieces ?? [];
        expect(pieces).to.include("discard_C_spot"); // the older one, untinted
        expect(pieces).to.include("discard_C_spot_new"); // just this move's own
        expect(rep.legend.discard_C_spot.some(gl => gl.text === "1x")).to.be.true;
        expect(rep.legend.discard_C_spot_new.some(gl => gl.text === "1x")).to.be.true;
        expect(rep.legend.discard_C_spot_new.some(gl => gl.colour !== undefined)).to.be.true;
    });

    it("clears once the next move is submitted, even by a different player", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.move("discard AC", { trusted: true });
        g.move("discard", { trusted: true }); // player 2's own turn
        const rep = g.render() as DiscardRenderRep;
        expect(discardArea(rep)?.pieces?.some(p => p.endsWith("_new"))).to.be.false;
    });

    it("a live preview of the player's own in-progress move highlights discards", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place n0 U", { trusted: true });
        g.hands[0] = [card("AC").uid, card("2C").uid, card("3C").uid, card("4C").uid, card("5C").uid, card("6C").uid];
        g.move("discard AC", { partial: true, trusted: true }); // simulates the player's own first click
        const rep = g.render() as DiscardRenderRep;
        expect(discardArea(rep)?.pieces?.some(p => p.endsWith("_new"))).to.be.true;
    });

    // Same "_new" suffix stripping as the hand-card click -
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
        expect(click.move).eq(`use ${major(20).uid}/m0.1 ${major(3).uid}`);
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
        g.move("place l0 U", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use ${aceOfCups().uid}`);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_own");
        expect(modeClick.move).eq(`use ${aceOfCups().uid}/m0.1 own n0 U`);
        expect(modeClick.valid).to.be.true;
        // A minor card's power is always exactly one step, already
        // exhausted here - the mandatory "U" alone makes this genuinely
        // complete:1 (matches Cups "own"'s own precedent - see
        // resolveTrailingOrientation's own docs), the optional trailing
        // correction below being pure bonus.
        expect(modeClick.complete).eq(1);
        // n0 itself is already "U", the creation's own default - a click
        // there hard-rejects as a no-op (same trailing-orientation rule
        // every other target minion gets), rather than silently
        // re-affirming.
        const [row2, col2] = rowColFor(g, 1, 0);
        const sameCell = g.handleClick(modeClick.move, row2, col2);
        expect(sameCell.valid).to.be.false;
        expect(sameCell.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        const [row3, col3] = rowColFor(g, 2, 0); // "o0", east of n0 - sets the new piece's facing
        const east = g.handleClick(modeClick.move, row3, col3);
        expect(east.move).eq(`use ${aceOfCups().uid}/m0.1 own n0 U E`);
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
        expect(modeClick.move).eq(`use ${aceOfCups().uid}/m0.1 enemy n0 1`);
        g.move(modeClick.move, { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
    });

    it("Cups (new): mode button seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, -1, 0, () => aceOfCups()); // l0
        g.move("place l0 W", { trusted: true }); // player 1, pointing at k0, a wasteland
        g.move("place n0 U", { trusted: true }); // player 2
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, -1, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_new");
        expect(modeClick.move).eq(`use ${aceOfCups().uid}/l0.1 new k0`);
        // Cell chosen, card uid not yet supplied - genuinely still
        // building (complete:-1), not just soft-pedaled to 0 - a bare
        // hand-typed submission of this exact string must not look
        // "valid" (see validateMinorPower's own docs).
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(-1);
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${spotUid}`);
        expect(cardClick.move).eq(`use ${aceOfCups().uid}/l0.1 new k0 ${spotUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): mode button leaves the target unset when the minion is facing another piece - a button picks between them", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${aceOfRods().uid}/m0.1 piece`); // genuinely ambiguous - no default
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(-1);
        g.move(modeClick.move, { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("target_m0.1");
        expect(values).to.include("target_n0.1");
        const selfClick = g.handleClick(modeClick.move, -1, -1, "_btn_target_m0.1");
        expect(selfClick.move).eq(`use ${aceOfRods().uid}/m0.1 piece m0.1 1`);
        const faceClick = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.1");
        expect(faceClick.move).eq(`use ${aceOfRods().uid}/m0.1 piece n0.1 1`);
        g.move(selfClick.move, { trusted: true }); // commit moving itself
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        // n0 already held player 2's piece (pieces[0]) before the move - the
        // mover lands alongside it, not alone.
        expect(g.board.get(1, 0)!.pieces[1]).to.deep.include({ owner: 1, orientation: "E" });
    });

    it("Rods (piece): once a button targets the OTHER piece at the facing cell, ITS distance 1 is directly click-settable (no self-target collision)", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfRods());
        forceCardAt(g, 4, 0, () => aceOfDiscs()); // keeps p0 wasteland, not void
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        g.board.get(0, 0)!.pieces = [new Piece(1, 2, "E")]; // room to move up to 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        const targeted = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.1");
        expect(targeted.move).eq(`use ${aceOfRods().uid}/m0.2 piece n0.1 1`); // distance still defaults to 1
        const [row2, col2] = rowColFor(g, 3, 0); // p0, distance 2 from n0
        const distClick2 = g.handleClick(targeted.move, row2, col2);
        expect(distClick2.move).eq(`use ${aceOfRods().uid}/m0.2 piece n0.1 2`);
        // Unlike a self-target (where distance 1 collides with the
        // ACTING minion's own facing cell), n0's own distance-1
        // destination (o0) doesn't coincide with anything else, so it's
        // directly click-settable even though it's the smallest distance.
        const [row1, col1] = rowColFor(g, 2, 0); // o0, distance 1 from n0
        const distClick1 = g.handleClick(distClick2.move, row1, col1);
        expect(distClick1.move).eq(`use ${aceOfRods().uid}/m0.2 piece n0.1 1`);
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
        g.move("place l0 U", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_tile");
        expect(modeClick.move).eq(`use ${aceOfRods().uid}/m0.1 tile 1`);
        g.move(modeClick.move, { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
    });

    it("Discs (piece): mode button defaults to growing the minion itself", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_piece");
        expect(modeClick.move).eq(`use ${aceOfDiscs().uid}/m0.1 piece m0.1`);
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2 });
    });

    it("Discs (tile): mode button seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        forceCardAt(g, 1, 0, () => card("2C")); // n0, a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2
        const royaltyUid = "KS"; // King of Swords, worth 2
        g.hands[0].push(royaltyUid);
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_tile");
        expect(modeClick.move).eq(`use ${aceOfDiscs().uid}/m0.1 tile n0`);
        // Target chosen, replacement card not yet supplied - must not read
        // as a submittable move ("looks like a valid move"): still valid
        // (still building), but genuinely incomplete.
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(-1);
        expect(modeClick.message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: aceOfDiscs().name }));
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${royaltyUid}`);
        expect(cardClick.move).eq(`use ${aceOfDiscs().uid}/m0.1 tile n0 ${royaltyUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
    });

    it("Discs (tile): mode button is struck through and rejects a click when the hand has no card that could grow this territory", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        forceCardAt(g, 1, 0, () => card("2C")); // n0, a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2
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
        expect(accepted.move).eq(`use ${aceOfDiscs().uid}/m0.1 tile n0`);
    });

    it("Cups (new), Wheel of Fortune: a dedicated button supplies the random draw - no hand card needed, no other card offers it", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(10)); // Wheel of Fortune
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_new");
        expect(modeClick.move).eq(`use ${major(10).uid}/m0.1 new n0`);
        g.move(modeClick.move, { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar?.buttons?.some(b => b.value === "random")).eq(true);

        const randomClick = g.handleClick(modeClick.move, -1, -1, "_btn_random");
        expect(randomClick.move).eq(`use ${major(10).uid}/m0.1 new n0 random`);
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
        g2.move("place l0 U", { trusted: true });
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
        expect(g2.validateMove(`use ${aceOfCups().uid}/m0.1 new n0 random`).valid).to.be.false;
    });

    it("Swords (piece): with no facing piece to attack (minion is \"up\"), falls back to the minion itself", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 U", { trusted: true }); // player 1, size 1, "U" - no facing cell at all
        g.move("place l0 U", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}/m0.1 piece m0.1 1`);
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(0); // 1 pip on a size-1 piece destroys it
        expect(g.stashes.get(1)![0]).eq(5); // returned to its own stash
    });

    // Attacking yourself is almost never what's wanted (unlike Rods' "move
    // self" or Discs' "grow self", both genuinely common choices) - when
    // the minion is actually facing an enemy, that's what the default
    // should target.
    it("Swords (piece): with a piece in the facing cell, a button offers attacking THAT instead of self", () => {
        const g = new GnosticaGame(2);
        clearBoard(g); // fully deterministic - see clearBoard's own docs
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}/m0.1 piece`); // genuinely ambiguous - no default
        const targeted = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.1");
        expect(targeted.move).eq(`use ${aceOfSwords().uid}/m0.1 piece n0.1 1`);
        g.move(targeted.move, { trusted: true });
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
        g.move("place n0 U", { trusted: true }); // player 2
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
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}/m0.1 tile l0 1`);
        // Unlike Cups "new"/Discs "tile", Swords "tile" already has enough
        // tokens (mode+cell+pips) to attempt the primitive outright - and a
        // pips-1 attack on a worth-2 territory leaves a nonzero remainder,
        // which genuinely requires a replacement card. This is a real rules
        // error, not applyMinorPower's "still skipped" tolerance - fixed
        // up below by the hand-card click regardless.
        expect(modeClick.valid).to.be.false;
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${spotUid}`);
        expect(cardClick.move).eq(`use ${aceOfSwords().uid}/m0.1 tile l0 1 ${spotUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(-1, 0)!.card?.uid).eq(spotUid);
    });

    it("narrows the bar to just the selected top-level button, a spacer, then the mode buttons", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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
        g.move("place m0 U", { trusted: true }); // "U" - targets itself, a territory with no enemy on it
        g.move("place l0 U", { trusted: true });
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        g.move(`use ${aceOfCups().uid}/m0.1 own m0 U`, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const ownBtn = bar!.buttons!.find(b => b.value === "mode_C_own");
        expect(ownBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
    });

    // A live "activate"/"play" preview can only ever have started with
    // board presence (both throw otherwise), so zero pieces on the board
    // mid-preview is a legitimate mid-action side effect (e.g. a Sword
    // step destroying the acting player's own last minion), not a
    // fresh-turn signal - getActionButtons() must not collapse the bar
    // down to a single Place button in that case.
    it("does not collapse to the Place button mid-preview when a power step destroys the acting player's own last minion", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 U", { trusted: true }); // player 1, size 1, "U" - only piece on the board
        g.move("place l0 U", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}/m0.1 piece m0.1 1`); // self-attack, since "U" has no facing cell
        g.move(modeClick.move, { partial: true }); // live preview - destroys the player's only piece
        expect(g.board.get(0, 0)!.pieces.length).eq(0); // confirm the destructive side effect really happened
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.not.deep.equal(["place"]);
        expect(values).to.include("use");
        expect(values).to.include("play");
    });

    it("Rods (piece): clicking a cell 2+ away along the acting minion's own facing directly sets distance", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfRods());
        // classify() only looks at IMMEDIATE neighbours (no chaining
        // through wasteland - see its own docs), so a card is needed
        // adjacent to EACH destination cell to keep it wasteland, not
        // void (a void landing destroys the piece outright).
        forceCardAt(g, 1, 0, () => card("2C")); // keeps o0 wasteland
        forceCardAt(g, 4, 0, () => aceOfDiscs()); // keeps p0 wasteland
        g.move("place m0 E", { trusted: true }); // player 1, pointing east
        g.move("place l0 U", { trusted: true }); // player 2
        g.board.get(0, 0)!.pieces = [new Piece(1, 3, "E")]; // room to move up to 3
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${aceOfRods().uid}/m0.3 piece m0.3 1`); // defaults to distance 1
        const [row3, col3] = rowColFor(g, 3, 0); // p0, 3 cells east
        const distClick3 = g.handleClick(modeClick.move, row3, col3);
        expect(distClick3.move).eq(`use ${aceOfRods().uid}/m0.3 piece m0.3 3`);
        const [row2, col2] = rowColFor(g, 2, 0); // o0, 2 cells east
        const distClick2 = g.handleClick(distClick3.move, row2, col2);
        expect(distClick2.move).eq(`use ${aceOfRods().uid}/m0.3 piece m0.3 2`);
        // Distance 1 (n0) is directly click-settable too - now that the
        // target itself is button-only (see getActionButtons' own
        // "target_" button set), this cell has exactly one meaning.
        const [row1, col1] = rowColFor(g, 1, 0); // n0, 1 cell east
        const distClick1 = g.handleClick(distClick2.move, row1, col1);
        expect(distClick1.move).eq(`use ${aceOfRods().uid}/m0.3 piece m0.3 1`);
        g.move(distClick2.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        expect(g.board.get(2, 0)!.pieces[0]).to.deep.include({ owner: 1, orientation: "E" });
    });

    it("Swords (piece): pips is offered as a button set, not click-cycled, bolding the current value", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        g.board.get(0, 0)!.pieces = [new Piece(1, 2, "E")]; // up to 2 pips
        g.board.get(1, 0)!.pieces = [new Piece(2, 2, "W")]; // survives a 1-pip hit
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}/m0.2 piece`); // genuinely ambiguous - no default
        const targeted = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.2");
        expect(targeted.move).eq(`use ${aceOfSwords().uid}/m0.2 piece n0.2 1`); // pips defaults to 1
        // partial-applying a Swords step is genuinely destructive (see
        // "does not collapse..." above) - render the bar here, but don't
        // build further click-based moves against a ref this mutation may
        // have invalidated (n0's own piece is about to shrink to 1 pip).
        g.move(targeted.move, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("pips_1");
        expect(values).to.include("pips_2");
        const pips1Btn = bar!.buttons!.find(b => b.value === "pips_1");
        expect(pips1Btn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
    });

    it("Swords (piece): clicking a pips button sets pips directly, replacing the mode button's own default", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        g.board.get(0, 0)!.pieces = [new Piece(1, 2, "E")]; // up to 2 pips
        g.board.get(1, 0)!.pieces = [new Piece(2, 2, "W")];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq(`use ${aceOfSwords().uid}/m0.2 piece`); // genuinely ambiguous - no default
        const targeted = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.2");
        expect(targeted.move).eq(`use ${aceOfSwords().uid}/m0.2 piece n0.2 1`);
        const pips2Click = g.handleClick(targeted.move, -1, -1, "_btn_pips_2");
        expect(pips2Click.move).eq(`use ${aceOfSwords().uid}/m0.2 piece n0.2 2`);
        g.move(pips2Click.move, { trusted: true });
        expect(g.board.get(1, 0)?.pieces.length ?? 0).eq(0); // destroyed by the full 2 pips
    });

    it("Rods (piece): a click near the destination cell reorients the minion once distance is set, hard-rejecting a same-facing click", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1, pointing east
        g.move("place l0 U", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${aceOfRods().uid}/m0.1 piece m0.1 1`);
        // Effective (post-move) position is n0 - clicking o0 (east of n0)
        // sets the moved piece's new facing to E... which is already its
        // current facing, so this must hard-reject as a no-op.
        const [rowSame, colSame] = rowColFor(g, 2, 0); // o0
        const noOp = g.handleClick(modeClick.move, rowSame, colSame);
        expect(noOp.valid).to.be.false;
        expect(noOp.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        // Clicking m0 (west of n0, the vacated origin) sets it to face back W.
        const [rowW, colW] = rowColFor(g, 0, 0); // m0
        const faceW = g.handleClick(modeClick.move, rowW, colW);
        expect(faceW.move).eq(`use ${aceOfRods().uid}/m0.1 piece m0.1 1 W`);
        g.move(faceW.move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, orientation: "W" });
    });

    it("Discs (piece): a click near a target that isn't the acting player's own has no orientation effect", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_piece");
        expect(modeClick.move).eq(`use ${aceOfDiscs().uid}/m0.1 piece`); // genuinely ambiguous - no default
        const [rowFace, colFace] = rowColFor(g, 1, 0); // n0, the facing cell
        const targeted = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.1");
        expect(targeted.move).eq(`use ${aceOfDiscs().uid}/m0.1 piece n0.1`); // targets the enemy at n0
        // n0 belongs to player 2 - no trailing orientation is offered for
        // an enemy's own piece (movePiece/growPiece/attackPiece's own
        // owner===currplayer gate in powers.ts), so a click there
        // no-ops instead of appending a facing.
        const clickOnTarget = g.handleClick(targeted.move, rowFace, colFace);
        expect(clickOnTarget.move).eq(targeted.move); // unchanged - no facing appended
        expect(clickOnTarget.valid).to.be.false;
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
        expect(picked.move).eq(`use ${aceOfRods().uid}/m0.1.E`);
        g.move(picked.move, { partial: true });
        const rep2 = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar2 = rep2.areas?.find(a => a.type === "buttonBar");
        const values2 = bar2!.buttons!.map(b => b.value);
        expect(values2.some(v => v?.startsWith("minion_"))).to.be.false; // no minion buttons left once resolved
        expect(values2).to.include("mode_R_piece"); // legal now - the "E"-facing minion was actually seeded
        const modeClick = g.handleClick(picked.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${aceOfRods().uid}/m0.1.E piece m0.1.E 1`);
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

    it("use: two eligible minions at the activated cell that are fully identical (same owner/size/facing) resolve directly/no picker offered", () => {
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
        expect(cellClick.move).eq(`play ${uid}/n0.1`);
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
        expect(modeClick.move).eq(`play ${uid}/n0.1 piece n0.1 1`);
    });

    it("play: clicking a cell with multiple eligible minions there narrows the picker to just that cell/not the whole board-wide pool", () => {
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
        expect(cellClick.move).eq(`play ${uid}/m0`); // still-narrowing bare cell token, not a resolved ref
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
        expect(picked.move).eq(`play ${uid}/m0.2`);
        const g2 = setup();
        g2.move(picked.move, { partial: true });
        const rep2 = g2.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar2 = rep2.areas?.find(a => a.type === "buttonBar");
        expect(bar2!.buttons!.map(b => b.value)).to.include("mode_R_piece");
    });

    it("does not offer a minion picker when only one minion is eligible", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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
        expect(picked.move).eq(`use ${major(3).uid}/m0.2`);
        const [rowE, colE] = rowColFor(g, 1, 0); // n0, east of m0
        const result = g.handleClick(picked.move, rowE, colE);
        expect(result.move).eq(`use ${major(3).uid}/m0.2 E`);
        g.move(result.move, { trusted: true }); // skips step 2 (create)
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("U"); // the size-1 minion, untouched
        expect(g.board.get(0, 0)!.pieces[1].orientation).eq("E"); // the size-2 minion actually picked
    });
});

// validateMove() is a genuine, non-mutating validator (gnostica.ts's
// validateX tree + gnostica/powers.ts's checkX functions) - every
// powers.ts failure must surface its own real message, not a generic
// INVALID_MOVE fallback, and validation must never mutate game state.
describe("Gnostica: validateMove architecture (non-mutating validator)", () => {
    before(() => {
        addResource("en");
    });

    it("surfaces the real reason a suit-power move failed, not the generic fallback", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true }); // player 1, "U" - targets itself
        g.move("place l0 U", { trusted: true }); // player 2
        g.board.get(0, 0)!.pieces.push(new Piece(1, 1, "U"), new Piece(1, 1, "U")); // fill to capacity (3)
        const result = g.validateMove(`use ${aceOfCups().uid}/m0.1 own m0 U`);
        expect(result.valid).to.be.false;
        // Compares against CELL_FULL's own real message (whatever it
        // currently is - not hardcoded, since the translation gets filled
        // in independently of this test) rather than the generic
        // INVALID_MOVE fallback ("'...' doesn't look like a valid move.").
        expect(result.message).to.eq(i18next.t("apgames:validation.gnostica.CELL_FULL"));
        expect(result.message).to.not.eq(i18next.t("apgames:validation._general.INVALID_MOVE", { move: `use ${aceOfCups().uid}/m0.1 own m0 U` }));
    });

    it("does not mutate game state while validating an invalid move", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const handBefore = [...g.hands[0]];
        const piecesBefore = g.board.get(0, 0)!.pieces.length;
        const discardBefore = g.discardPile.length;
        const result = g.validateMove(`use ${aceOfCups().uid}/m0.1 own m0 U/m0.1 own m0 U`); // MINOR_ONE_STEP_ONLY
        expect(result.valid).to.be.false;
        expect(g.hands[0]).to.deep.equal(handBefore);
        expect(g.board.get(0, 0)!.pieces.length).to.eq(piecesBefore);
        expect(g.discardPile.length).to.eq(discardBefore);
    });

    // A genuinely untouched wasteland has no stored CellContents object at
    // all (one is only ever created for a cell that already has a card or
    // a piece) - Cups "own"/"enemy" must handle that the same way
    // movePiece/hermitMovePiece already do, by creating one on the fly.
    it("Cups (own) can target a genuinely untouched wasteland, not just an existing territory", () => {
        const g = new GnosticaGame(2);
        const [cx, cy] = [1, 1]; // a corner of the initial 3x3
        const cornerCell = GnosticaBoard.coords2algebraic(cx, cy);
        const [tx, ty] = [2, 1]; // outside the 3x3 - genuinely untouched
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        expect(g.board.has(tx, ty)).to.be.false;
        forceCardAt(g, cx, cy, () => aceOfCups());
        g.move(`place ${cornerCell} E`, { trusted: true }); // player 1, pointing at the untouched cell
        g.move("place l0 U", { trusted: true }); // player 2
        const move = `use ${aceOfCups().uid}/${cornerCell}.1 own ${targetCell} U`;
        expect(g.validateMove(move).valid).to.be.true;
        expect(() => g.move(move, { trusted: true })).to.not.throw();
        expect(g.board.get(tx, ty)!.pieces.length).to.eq(1);
    });
});

// The piece-reference notation itself
// ("<cell>.<pips>[.<orientation>][.<player>]") - each field is included
// only when the ones before it don't already narrow a target cell's
// pieces down to one.
describe("Gnostica: piece-reference notation", () => {
    before(() => {
        addResource("en");
    });

    it("pips alone is enough to pick a target out when sizes at the cell differ", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 U", { trusted: true }); // player 2, size 1
        g.board.get(1, 0)!.pieces.push(new Piece(2, 2, "U")); // a second, size-2 piece, also at n0
        const move = `use ${aceOfRods().uid}/m0.1 piece n0.1 1`; // "n0.1" - pips alone, no orientation/player needed
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
        expect(g.validateMove(`use ${aceOfSwords().uid}/m0.1 piece n0.1 1`).valid).to.be.false;
        const move = `use ${aceOfSwords().uid}/m0.1 piece n0.1.N 1`; // pips + orientation picks out the N-facing one
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
        g.move("place n0 U", { trusted: true }); // player 2, size 1, "U"
        g.board.get(1, 0)!.pieces.push(new Piece(2, 1, "U")); // an identical second piece - same owner, size, facing
        const move = `use ${aceOfSwords().uid}/m0.1 piece n0.1 1`; // fully qualifying further (n0.1.U.2) couldn't help either
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.validateMove(`use ${aceOfCups().uid}/m0.1 own$ m0 U`);
        expect(result.valid).to.be.false;
    });

    it("rejects a step segment with an unreasonable number of tokens", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.validateMove(`use ${aceOfCups().uid}/m0.1 own m0 U a b c d e f g h i j`);
        expect(result.valid).to.be.false;
    });

    it("rejects a step whose first token isn't shaped like a piece ref or a card uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.validateMove(`use ${aceOfCups().uid}/bogus own m0 U`);
        expect(result.valid).to.be.false;
    });

    it("accepts a genuinely well-formed step whose first token is a card uid, not a piece ref (High Priestess)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const [firstDiscard] = g.hands[0];
        const result = g.validateMove(`use ${major(2).uid}/${firstDiscard}`);
        expect(result.valid).to.be.true;
    });

    it("rejects an unrecognized head keyword", () => {
        const g = new GnosticaGame(2);
        const result = g.validateMove("frobnicate m0");
        expect(result.valid).to.be.false;
    });
});

// "orient" (reorienting an EXISTING piece) rewrites a single facing token
// with each click - one real direction click is the whole action, genuinely
// complete: at most one click for a minion, then done (never re-invites
// further adjustment). "place" is the same mandatory-plus-optional-
// trailing-correction shape Cups "own" uses (see resolveTrailingOrientation's
// own docs), genuinely complete as soon as the mandatory "U" is present.
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

    // Place's own facing is now the same mandatory-plus-optional-trailing-
    // correction shape Cups "own" uses (see resolveTrailingOrientation's
    // own docs), with one addition: a freshly-seeded "U" carries a
    // trailing "?" (still merely prepopulated, not a deliberate choice -
    // see validatePlace's own docs), so there's no separate "still
    // adjustable" MESSAGE to soft-pedal here anymore - the generic
    // VALID_MOVE is the whole story regardless of complete's own value.
    it("place: the very first click is already valid, generically-worded, and genuinely marked provisional", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("place m0 U?");
        expect(result.complete).eq(0);
        expect(result.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
    });

    it("place: clicking a neighbour appends the optional trailing correction, same generic message", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 1, 0); // n0, east of m0
        const result = g.handleClick("place m0 U", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("place m0 U E");
        expect(result.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
    });

    it("orient: clicking a piece to start reorienting it carries the PICK_DIRECTION_TO_ORIENT message/never a facing", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 E", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("orient", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("orient m0.1"); // selecting the minion never itself assigns a facing
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT"));
    });

    it("orient: a genuine no-op reorientation click (clicking the same cell again) carries the ORIENT_NO_OP message", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // defaults to "U"
        g.move("place l0 U", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const selected = g.handleClick("orient", row, col);
        expect(selected.move).eq("orient m0.1");
        // Clicking the SAME cell again is a real, deliberate "face up"
        // click (see orientationTowardClick's own docs) - not an
        // auto-assigned default - which happens to be a no-op here since
        // the piece already faces "U".
        const result = g.handleClick(selected.move!, row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq("orient m0.1 U");
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
    });

    it("orient: a genuine no-op reorientation is rejected at validateMove() too/so it can never be an actual final move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 N", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.validateMove("orient m0.1 N");
        expect(result.valid).to.be.true; // still building, not a hard error - see the click test above
        expect(result.complete).eq(-1);
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        // A genuine change to a DIFFERENT facing is fully valid AND
        // complete - one real direction click is the whole action, the
        // same for this hand-typed call as a click result.
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
        expect(selected.move).eq(`orient ${ref}`);

        const [rowVoid, colVoid] = rowColFor(g, 3, 0); // one step east - the void side
        const result = g.handleClick(selected.move!, -1, -1, `${colVoid},${rowVoid}`);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`orient ${ref} E`);
        expect(result.complete).eq(1);
    });

    // Cups "own" always creates its new minion with a real, mandatory
    // facing ("U" - never left unstated), the same way place's own first
    // click does - but adjusting that facing afterward is now the exact
    // same trailing-optional-orientation primitive every other target
    // minion gets (see handlePendingStepBoardClick's own docs), not a
    // special "still adjustable" soft-pedal: no message once the create
    // step is otherwise complete, and a same-facing click is a hard
    // ORIENT_NO_OP rejection instead of a silent no-change.
    it("Cups (own): the mode button's default facing needs no message; a click only changes it, hard-rejecting a same-facing request", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_own");
        expect(modeClick.move).eq(`use ${aceOfCups().uid}/m0.1 own n0 U`);
        const [rowN, colN] = rowColFor(g, 1, 0); // n0 itself - "U" again, already the creation default
        const sameFacing = g.handleClick(modeClick.move, rowN, colN);
        expect(sameFacing.move).eq(`use ${aceOfCups().uid}/m0.1 own n0 U U`);
        expect(sameFacing.valid).to.be.false;
        expect(sameFacing.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        const [rowE, colE] = rowColFor(g, 2, 0); // "o0", east of n0 - a genuine change
        const east = g.handleClick(modeClick.move, rowE, colE);
        expect(east.move).eq(`use ${aceOfCups().uid}/m0.1 own n0 U E`);
        expect(east.valid).to.be.true;
        g.move(east.move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "E" });
    });

    it("the Pass button produces the right bare seed and generic message", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_pass");
        expect(result.valid).to.be.true;
        expect(result.move).eq("discard draw 0");
        expect(result.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
    });
});

// The bare "activate <cell>"/"play <uid>" state, right after picking the
// card and before any suit mode or major-arcana power step, is still "in
// progress" (valid:true, complete:-1), per #49. validateMove() itself
// computes CHOOSE_STEP's own instructional wording directly, for a
// hand-typed OR click-driven move alike. Applies equally to a minor or a
// major arcana card, and to both activate and play - except Fool/World,
// which stay complete/optional (neither can ever take a real step - not
// yet supported).
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
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
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`use ${major(10).uid}`);
        expect(result.message).eq(chooseStepMsg(major(10).name));
    });

    it("play: a hand-card click carries the message (minor arcana)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const uid = g.hands[0].find(u => !/^\d{2}$/.test(u))!; // a minor card
        const result = g.handleClick("play", -1, -1, `hand_${uid}`);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`play ${uid}`);
        expect(result.message).eq(chooseStepMsg(minorCards.find(c => c.uid === uid)!.name));
    });

    it("play: carries the message for a major arcana card too", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        g.hands[0].push("10"); // Wheel of Fortune, injected regardless of the random deal
        const result = g.handleClick("play", -1, -1, "hand_10");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq("play 10");
        expect(result.message).eq(chooseStepMsg(major(10).name));
    });

    // Every click-driven special with no button of its own (orientMinion/
    // orientAny/hierophantReplace/tradeHands/judgementDraw - see
    // computeActionButtons' own docs) names its actual targeting rule
    // instead of CHOOSE_STEP's "using the buttons next to the game
    // board" wording, which is actively wrong for them (same reasoning
    // as World's own dedicated message just below). A primitive-first
    // step (a real mode button) or hermitTeleport/magicianChoice (their
    // own dedicated button sets) still get plain CHOOSE_STEP, since it's
    // accurate for them.
    it("activate: orientMinion names any-own-minion targeting, not the generic CHOOSE_STEP", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        forceCardAt(g, 0, 0, () => major(3)); // Empress
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP_ORIENT_MINION", { card: major(3).name, cell: "m0" }));
        expect(result.message).to.not.eq(chooseStepMsg(major(3).name));
    });

    it("activate: orientAny/tradeHands/hierophantReplace name the shared self-or-facing-cell targeting rule, not the generic CHOOSE_STEP", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        for (const seq of [5, 11, 15]) { // Hierophant, Justice, Devil
            forceCardAt(g, 0, 0, () => major(seq));
            const [row, col] = rowColFor(g, 0, 0);
            const result = g.handleClick("use", row, col);
            expect(result.valid, `seq ${seq}`).to.be.true;
            expect(result.message, `seq ${seq}`).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP_FACING", { card: major(seq).name, cell: "m0" }));
            expect(result.message, `seq ${seq}`).to.not.eq(chooseStepMsg(major(seq).name));
        }
    });

    it("activate: judgementDraw names the discard pile, not the game board, not the generic CHOOSE_STEP", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        forceCardAt(g, 0, 0, () => major(20)); // Judgement
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP_DISCARD", { card: major(20).name }));
        expect(result.message).to.not.eq(chooseStepMsg(major(20).name));
    });

    // With 2+ distinguishable minions eligible at the activated cell, the
    // acting minion is genuinely ambiguous and a minion-picker button set
    // appears (see resolveStepMinion's/computeActionButtons' own docs) -
    // CHOOSE_STEP's own "using the buttons" wording is accurate here,
    // unlike the single-eligible-minion case above.
    it("activate: with an ambiguous acting minion, falls back to the generic CHOOSE_STEP (buttons genuinely apply) instead of naming a cell", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(3)); // Empress
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U"), new Piece(1, 2, "U")]; // two distinguishable own minions
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.message).eq(chooseStepMsg(major(3).name));
        g.move(result.move, { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar!.buttons!.some(b => b.value?.startsWith("minion_"))).to.be.true;
    });

    it("activate: a primitive-first step, or a special with its own button set (hermitTeleport/magicianChoice), keeps the generic CHOOSE_STEP wording", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        for (const seq of [1, 6, 9]) { // Magician, Lovers, Hermit
            forceCardAt(g, 0, 0, () => major(seq));
            const [row, col] = rowColFor(g, 0, 0);
            const result = g.handleClick("use", row, col);
            expect(result.valid, `seq ${seq}`).to.be.true;
            expect(result.message, `seq ${seq}`).eq(chooseStepMsg(major(seq).name));
        }
    });

    // World's own target is unbounded ("any major arcana card currently on
    // the board"), unlike every other click-driven special above, whose
    // target is always just the acting minion's own obvious self-or-
    // facing cell (or "any of your own minions", or the discard pile) -
    // none of those fixed rules fit World, so it gets its own real
    // instructions instead, the same way Fool/High Priestess already do.
    it("activate: World gets its own real instructions, not the generic CHOOSE_STEP wording", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`use ${theWorld().uid}`);
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.WORLD_CHOOSE_TARGET"));
        expect(result.message).to.not.eq(chooseStepMsg(theWorld().name));
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

        g.move(`use ${major(2).uid}/${discardUid}`, { trusted: true }); // step 1: a real discard, pauses on step 2
        expect(g.continued).to.not.be.empty;
        const resumed = g.handleClick("", -1, -1, "_btn_resume_power");
        // High Priestess round 2 resumes as a bare "discard (via 02)" -
        // its own step IS a discard/draw, so "play 02" would be a lie.
        expect(resumed.move).eq(`discard (via ${major(2).uid})`);
        expect(resumed.message).eq(round2Msg);
    });

    // A genuine pendingPower obligation shows X's own buttons directly
    // (here, the Draw N count picker) whenever X's own step (like High
    // Priestess's round 2) has real buttons to offer. Unlike every other
    // obligation, High Priestess's own round 2 is never Declinable
    // (NOTHING_TO_DECLINE/ACTION_NOT_ALLOWED - only "discard" is an
    // allowed resume head for it - see validateMove's own resume-head
    // gate) - so no persisting Decline button here at all; offering one
    // would be a button whose click is guaranteed to fail.
    it("a pending High Priestess obligation's own buttons show directly, with no persisting Decline button", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2));
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];
        g.move(`use ${major(2).uid}/${discardUid}`, { trusted: true });
        expect(g.continued).to.not.be.empty;

        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; label?: string; attributes?: unknown[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        expect(bar.buttons!.find(b => b.value === "resume_power")).to.be.undefined;
        expect(bar.buttons!.some(b => b.value?.startsWith("hpdraw_"))).to.be.true;
        expect(bar.buttons!.find(b => b.value === "decline_power")).to.be.undefined;
        expect(g.validateMove(`decline (via ${major(2).uid})`).message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "ACTION_NOT_ALLOWED" }));
    });

    // The persisting Decline button must be labeled after the ACTIVE
    // card's uid, not rootCardUid (always the ORIGINALLY used/played
    // card) - once Fool reveals a DIFFERENT card (here, the High
    // Priestess), "Decline 00" would misleadingly point at the Fool while
    // what it actually declines is the High Priestess's own power.
    it("the persisting Decline button is named after the ACTIVE card's uid, not the root card's", () => {
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

        g.move(`use ${major(0).uid}`, { trusted: true });
        // Fool owes its 2nd flip ("00.1"); the revealed High Priestess is
        // itself a continuing card, so it's tracked too ("02.0", round 1).
        expect(g.continued).to.deep.equal(["00.1"]);

        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; label?: string }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        expect(bar.buttons!.find(b => b.value === "resume_power")).to.be.undefined;
        expect(bar.buttons!.some(b => b.value?.startsWith("hpdraw_"))).to.be.true;
        // "02" (The High Priestess) - the active card - not "00" (The Fool
        // - the root).
        const declineBtn = bar.buttons!.find(b => b.value === "decline_power")!;
        expect(declineBtn.label).eq("Decline 02");
    });

    // validateMove("") only populates the status line for the render
    // right after a commit (see playground.js's moveBtn handler). Every
    // state now has a real button to click - the ordinary bar, or a
    // resume's own Use/Decline pair - so "click a button" always fits;
    // the card's own real instructions come from the resume_power click,
    // not prepopulated here. The one exception is a player with no piece
    // down yet, who must place.
    it("validateMove(\"\") is the generic click-a-button wording, or place instructions when no piece is down", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];

        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));

        g.move(`use ${major(2).uid}/${discardUid}`, { trusted: true }); // pauses, awaiting round 2
        expect(g.continued).to.not.be.empty;
        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));

        g.move(`decline ${major(2).uid} (via ${major(2).uid})`, { trusted: true }); // clears the obligation
        expect(g.continued).to.be.empty;
        // Turn has passed to player 2, who has no pieces on the board yet.
        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS_PLACE"));
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
        const incomplete = g.validateMove(`use ${major(3).uid}/m0.1 E/m0.1 new n0`);
        expect(incomplete.valid).to.be.true;
        expect(incomplete.complete).eq(-1);
        expect(incomplete.message).eq(i18next.t("apgames:validation.gnostica.POWER_STILL_OPTIONAL", { card: major(3).name }));
        // Supplying the card uid completes it normally.
        g.hands[0].push("2S");
        const complete = g.validateMove(`use ${major(3).uid}/m0.1 E/m0.1 new n0 2S`);
        expect(complete.complete).eq(1);
    });

    it("#75: chatLog() names the card placed by Cups' 'new' mode, not just the destination cell", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => major(3)); // The Empress
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        g.hands[0].push("2S");
        g.move(`use ${major(3).uid}/m0.1 E/m0.1 new n0 2S`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes(i18next.t("apresults:PLACE.gnostica_territory", { player: "Alice", where: "n0", what: withArticle(card("2S").name) })));
        expect(line).to.not.be.undefined;
    });

    // Regression: an orientMinion step's own reorientation click, still
    // mid-chain (never yet committed for real), must be reflected in a
    // LATER step's own default target - it was previously reading
    // `this.board`'s pre-reorientation facing instead (see
    // parsePendingStep's own "always replay" fix).
    it("Empress (orientMinion, then create): step 2's own default target reflects step 1's just-clicked reorientation, not the piece's original facing", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, -1, 0, () => major(3)); // Empress at l0
        g.board.get(-1, 0)!.pieces = [new Piece(1, 1, "E")]; // originally facing E, toward m0
        const [rowL0, colL0] = rowColFor(g, -1, 0);
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const cellClick = g.handleClick(seed.move, rowL0, colL0);
        expect(cellClick.move).eq(`use ${major(3).uid}`);
        const [rowS, colS] = rowColFor(g, -1, 1); // south of l0
        const orientClick = g.handleClick(cellClick.move, rowS, colS);
        expect(orientClick.move).eq(`use ${major(3).uid}/l0.1 S`);
        const modeClick = g.handleClick(orientClick.move, -1, -1, "_btn_mode_C_own");
        const freshTarget = GnosticaBoard.coords2algebraic(-1, 1); // the NEW (south) facing cell
        expect(modeClick.move).eq(`use ${major(3).uid}/l0.1 S/l0.1 own ${freshTarget} U`);
        expect(modeClick.move).to.not.include(" m0 "); // the STALE, pre-reorientation (east) default
    });

    it("Lovers (move, then create): step 2's Cups buttons appear only once step 1 is complete; a target button still picks step 1's target; the chained click sequence resolves correctly", () => {
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
        expect(modeClick.move).eq(`use ${major(6).uid}/m0.1 piece`); // genuinely ambiguous - B sits at n0 too

        // A target button picks THIS step's target, still correctly
        // scoped to the in-progress step rather than being mistaken for
        // "start step 2" - the exact gap parsePendingStep's preferCurrent
        // option exists to close.
        const redirected = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.1");
        expect(redirected.move).eq(`use ${major(6).uid}/m0.1 piece n0.1 1`);
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
        expect(step2.move).eq(`use ${major(6).uid}/m0.1 piece n0.1 1/m0.1 own n0 U`);
        expect(step2.valid).to.be.true;

        g.move(step2.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(1); // A, unmoved
        expect(g.board.get(2, 0)!.pieces.length).eq(1); // B, pushed E to o0
        expect(g.board.get(1, 0)!.pieces.length).eq(1); // new piece created at n0 (now vacant)
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
        expect(g.currplayer).eq(2);
    });

    it("Lovers: submitting after just step 1 (skipping step 2) is still legal via clicks", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, pointing at n0

        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${major(6).uid}/m0.1 piece m0.1 1`); // defaults to self, skips step 2
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
        const withStep1 = `use ${major(16).uid}/m0.1 E`;
        const previewAfter = new GnosticaGame(2);
        setup(previewAfter);
        previewAfter.move(withStep1, { partial: true });
        const values = buttonValues(previewAfter);
        expect(values).to.include("mode_S_piece");
        expect(values).to.not.include("mode_R_piece");
        expect(values).to.not.include("mode_C_own");

        const modeClick = g.handleClick(withStep1, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.valid).to.be.true;
        expect(modeClick.move).to.match(new RegExp(`^use ${major(16).uid}/m0\\.1 E/`));
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
        expect(modeClick.move).eq(`use ${major(14).uid}/l0.1 new k0`);
        expect(modeClick.valid).to.be.true; // still-incomplete ("new" needs a card uid) but not an error
        const supplied = g.handleClick(modeClick.move, -1, -1, `hand_${spotUid}`);
        expect(supplied.move).eq(`use ${major(14).uid}/l0.1 new k0 ${spotUid}`);
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
        expect(result.move).eq(`use ${major(3).uid}/m0.1 E`);
        expect(result.valid).to.be.true;
        // Step 1 (orientMinion) is complete, but step 2 (create) is still
        // genuinely optional - complete:0, generic message, computed
        // directly by validateMove() now, not just click.
        expect(result.complete).eq(0);
        expect(result.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
        expect(g.validateMove(result.move).message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
        g.move(result.move, { trusted: true }); // skips step 2 (create)
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
        expect(result.move).eq(`use ${major(11).uid}/m0.1 n0.1`);
        expect(result.valid).to.be.true;
        g.move(result.move, { trusted: true }); // skips step 2 (attack)
        expect(g.hands[0]).to.deep.equal(handsBefore[1]);
        expect(g.hands[1]).to.deep.equal(handsBefore[0]);
        expect(g.currplayer).eq(2);
    });

    it("tradeHands: forbids targeting one of the acting player's own pieces - a no-op dressed up as a step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(11)); // Justice
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "U")]; // own piece B, also player 1
        const result = g.validateMove(`use ${major(11).uid}/m0.1 n0.1`);
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

    it("orientAny (Devil): target pick never assigns a default orientation; a further click near the TARGET sets it", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(15)); // The Devil
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "S")]; // enemy B, player 2, facing S
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const [rowN, colN] = rowColFor(g, 1, 0);
        const step1 = g.handleClick(cellClick.move, rowN, colN);
        expect(step1.move).eq(`use ${major(15).uid}/m0.1 n0.1`); // target chosen, no facing yet
        expect(step1.valid).to.be.true;
        expect(step1.complete).eq(-1);
        // Target already picked - the message must name the TARGET's own
        // facing as what's still needed, not the generic "pick a target"
        // wording (see validateFrameStack's own PICK_DIRECTION_TO_ORIENT
        // docs) - computed directly by validateMove() now, not just click.
        expect(step1.message).eq(i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT"));
        expect(g.validateMove(step1.move).message).eq(i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT"));
        const [rowO, colO] = rowColFor(g, 2, 0); // o0, east of n0 (the target)
        const step2 = g.handleClick(step1.move, rowO, colO);
        expect(step2.move).eq(`use ${major(15).uid}/m0.1 n0.1 E`);
        expect(step2.valid).to.be.true;
        // This step is genuinely complete (one real direction click is
        // the whole action), but steps 2 & 3 are still genuinely optional -
        // complete:0, generic message, computed directly by validateMove()
        // now, not just click.
        expect(step2.complete).eq(0);
        expect(step2.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
        expect(g.validateMove(step2.move).message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
        g.move(step2.move, { trusted: true }); // skips steps 2 & 3
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, size: 1, orientation: "E" });
        expect(g.currplayer).eq(2);
    });

    it("orientAny (Devil): a same-facing (no-op) reorientation is rejected, and the target-pick default never seeds one", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(15)); // The Devil
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")]; // enemy B, already facing up
        const validated = g.validateMove(`use ${major(15).uid}/m0.1 n0.1 U`);
        expect(validated.valid).to.be.false;
        expect(validated.message).to.eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        // The click-driven default (see handleOrientAnyOrHierophantClick's
        // own docs) must never itself land on this no-op - it falls back
        // to a different facing when the target already faces up.
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const [rowN, colN] = rowColFor(g, 1, 0);
        const step1 = g.handleClick(cellClick.move, rowN, colN);
        expect(step1.move).to.not.eq(`use ${major(15).uid}/m0.1 n0.1 U`);
        expect(step1.valid).to.be.true;
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
        expect(step1.move).eq(`use ${major(5).uid}/m0.1 n0.1`); // target chosen, no facing yet
        const [rowO, colO] = rowColFor(g, 2, 0);
        const step2 = g.handleClick(step1.move, rowO, colO);
        expect(step2.move).eq(`use ${major(5).uid}/m0.1 n0.1 E`);
        expect(step2.valid).to.be.true;
        g.move(step2.move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "E" });
    });

    it("hierophantReplace: forbids targeting one of the acting player's own pieces - a no-op dressed up as a step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(5)); // The Hierophant
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")]; // own piece B, also player 1
        const result = g.validateMove(`use ${major(5).uid}/m0.1 n0.1 U`);
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
        expect(suitClick.move).eq(`use ${major(1).uid} as R`);
        expect(suitClick.valid).to.be.true; // suit chosen, mode not yet - still skipped
        const modeClick = g.handleClick(suitClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${major(1).uid} as R/m0.1 piece m0.1 1`);
        expect(modeClick.valid).to.be.true;
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        expect(g.board.get(1, 0)!.pieces.length).eq(1);
        expect(g.currplayer).eq(2);
    });

    // Regression: magicianChoice's own minion is part of its step's
    // segment, which doesn't even start until a suit is known ("as
    // <suit>") - with 2+ of the player's own minions sharing the
    // Magician's cell, buildSpecialPending used to eagerly compute
    // minion-ambiguity anyway, so the bar wrongly offered "Choose Minion"
    // buttons ahead of the real suit choice (and picking one built a
    // malformed "use 01/m0.1" move, missing "as" entirely).
    it("magicianChoice: 2+ minions on its own cell still show the suit buttons first, not a premature minion picker", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(1)); // The Magician
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E"), new Piece(1, 2, "W")];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        g.move(cellClick.move, { partial: true }); // sync engine state, same as the playground's own preview flow
        expect(buttonValues(g)).to.include.members(["magician_C", "magician_R", "magician_D", "magician_S"]);
        expect(buttonValues(g)).to.not.include.members(["minion_m0.1", "minion_m0.2"]);
        const suitClick = g.handleClick(cellClick.move, -1, -1, "_btn_magician_R");
        expect(suitClick.move).eq(`use ${major(1).uid} as R`);
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
        expect(modeClick.move).eq(`use ${major(9).uid}/m0.1 piece m0.1`); // defaults to self
        const [rowN, colN] = rowColFor(g, 1, 0);
        const redirected = g.handleClick(modeClick.move, rowN, colN);
        expect(redirected.move).eq(`use ${major(9).uid}/m0.1 piece n0.1`); // redirected to B
        // o0: not adjacent to A at all - proves the destination click has
        // no adjacency restriction, unlike every other click-to-target
        // flow in this file.
        const [rowDest, colDest] = rowColFor(g, 2, 0);
        const withDest = g.handleClick(redirected.move, rowDest, colDest);
        expect(withDest.move).eq(`use ${major(9).uid}/m0.1 piece n0.1 o0`);
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
        expect(click1.move).eq(`use ${major(20).uid}/m0.2 07`);
        expect(click1.valid).to.be.true;
        const click2 = g.handleClick(click1.move, -1, -1, "discard_C_spot");
        expect(click2.valid).to.be.true;
        const pickedMatch = click2.move.match(new RegExp(`^use ${major(20).uid}/m0\\.2 07 (\\S+)$`));
        expect(pickedMatch).to.not.eq(null);
        const picked = pickedMatch![1];
        expect(["2C", "5C"]).to.include(picked);
        // Clicking the same bucket again removes the just-picked uid.
        const click3 = g.handleClick(click2.move, -1, -1, "discard_C_spot");
        expect(click3.move).eq(`use ${major(20).uid}/m0.2 07`);
        expect(click3.valid).to.be.true;
        // At maxDraw (2, after re-adding the bucket pick), a third pick is
        // rejected. Re-adding is an INDEPENDENT random draw - not
        // necessarily `picked` again - so re-derive it from click4 itself
        // rather than assuming it matches.
        const click4 = g.handleClick(click3.move, -1, -1, "discard_C_spot");
        const pickedMatch4 = click4.move.match(new RegExp(`^use ${major(20).uid}/m0\\.2 07 (\\S+)$`));
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
        expect(click1.move).eq(`use ${major(2).uid}/2C`);
        expect(click1.valid).to.be.true;
        // Regression: no "draw <n>" chosen yet - still soft (complete:0),
        // not "ready to submit" (complete:1), even though this ALREADY
        // forces round 1's own pause into round 2 if actually committed -
        // a missing draw count is a default, not the player's final word
        // (see validateHighPriestess's own docs), so a single discard
        // toggle must never read as done.
        expect(click1.complete).eq(0);
        const click2 = g.handleClick(click1.move, -1, -1, "hand_5C");
        expect(click2.move).eq(`use ${major(2).uid}/2C 5C`);
        expect(click2.complete).eq(0);
        const click3 = g.handleClick(click2.move, -1, -1, "hand_2C"); // toggle back off
        expect(click3.move).eq(`use ${major(2).uid}/5C`);
        expect(click3.complete).eq(0);
        const click4 = g.handleClick(click3.move, -1, -1, "_btn_hpdraw_1");
        expect(click4.complete).eq(1); // an explicit draw count IS the player's final word
        g.move(click3.move, { trusted: true }); // step 1 commits and pauses, awaiting step 2
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6); // redrawn from 2 (3 - 1 discarded) back to 6
        expect(g.discardPile).to.include("5C");
        expect(g.currplayer).eq(1); // same seat still owes step 2
        expect(g.continued).to.not.be.empty;
        g.move(`decline ${major(2).uid} (via ${major(2).uid})`, { trusted: true }); // declines the second highPriestess step
        expect(g.continued).to.be.empty;
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
        expect(discardClick.move).eq(`use ${major(2).uid}/5C`);
        // maxDraw is 6 - 2 (hand after discarding 5C) = 4; choose 1 instead.
        const drawClick = g.handleClick(discardClick.move, -1, -1, "_btn_hpdraw_1");
        expect(drawClick.move).eq(`use ${major(2).uid}/5C draw 1`);
        expect(drawClick.valid).to.be.true;
        // A count picked completes the move - tell the player to submit,
        // not the generic "Looks like a valid move" (there's a second
        // round still coming, this being round 1).
        expect(drawClick.message).eq(i18next.t("apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1_READY"));

        g.move(drawClick.move, { trusted: true });
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(3); // 2 remaining + exactly 1 drawn, not up to 6
        expect(g.continued).to.not.be.empty; // step 1 of 2 - still owes the second flip

        // Round 2: the SAME count-picker click now reports it's the LAST round.
        const resumed = g.handleClick("", -1, -1, "_btn_resume_power");
        const round2Draw = g.handleClick(resumed.move, -1, -1, "_btn_hpdraw_0");
        expect(round2Draw.message).eq(i18next.t("apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2_READY"));

        // Same message, computed directly by validateFrameStack itself now -
        // a hand-typed round 2 submission gets it without ever going
        // through the click handler above.
        expect(g.validateMove(round2Draw.move).message).eq(i18next.t("apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2_READY"));
    });

    // Clicking a "Draw N" button early, then going back to discard ANOTHER
    // card, must drop the stale "draw N" tail rather than appending the
    // new uid after it - a card added past the "draw" token must actually
    // be discarded, not silently ignored.
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
        expect(drawClick.move).eq(`use ${major(2).uid}/5C draw 1`);

        const discard2 = g.handleClick(drawClick.move, -1, -1, "hand_AR");
        expect(discard2.move).eq(`use ${major(2).uid}/5C AR`); // stale "draw 1" dropped, AR added
        expect(discard2.valid).to.be.true;

        g.move(discard2.move, { trusted: true }); // 0 remaining in a 3-card hand, defaults to max draw
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0]).to.not.include("AR");
        expect(g.hands[0].length).eq(6); // defaulted to max (1 remaining + 5 drawn), not stuck at a stale count
    });

    // Playing High Priestess (as opposed to using it already on the
    // board) removes the card from hand BEFORE its own power resolves
    // (cmdPlay's own docs), so the max-draw bound must account for that
    // extra card leaving too: a 6-card hand, played + 2 discards, is
    // genuinely down to 3 - the true max draw is 3, not 2.
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
        expect(discard2.move).eq("play 02/2C 5C");

        // Hand is genuinely down to 3 (6 - the played card - 2 discards),
        // so drawing 3 is legal; drawing 4 is not.
        const draw3 = g.handleClick(discard2.move, -1, -1, "_btn_hpdraw_3");
        expect(draw3.move).eq("play 02/2C 5C draw 3");
        expect(draw3.valid).to.be.true;

        g.move(draw3.move, { trusted: true });
        expect(g.hands[0].length).eq(6); // 3 remaining + exactly 3 drawn
        expect(g.hands[0]).to.not.include("02");
        expect(g.hands[0]).to.not.include("2C");
        expect(g.hands[0]).to.not.include("5C");
    });

    // The real client's boardClick() calls game.move(result.move, {partial:
    // true}) after EVERY click, to render a live preview - the actual
    // (random) redraw must not fire until Submit, before the player has
    // even finished building their discard list. Mirrors cmdDiscard's own
    // "discard eagerly/defer the draw" convention for the ordinary
    // end-of-turn action.
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
        preview.move(`use ${major(2).uid}/5C`, { partial: true }); // exactly what a live client preview does
        expect(preview.hands[0]).to.not.include("5C"); // discarded for real...
        expect(preview.hands[0].length).eq(2); // ...but NOT yet redrawn back to 6
        // A partial preview never persists a continuation - see
        // this.continued's own docs - so nothing is owed until the real
        // submit below.
        expect(preview.continued).to.be.empty;
        expect(preview.currplayer).eq(1);

        const g = setup();
        g.move(`use ${major(2).uid}/5C`, { trusted: true }); // the real, final submit
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6); // now genuinely redrawn
        expect(g.continued).to.not.be.empty; // step 1 of 2 - still owes the second flip
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
        expect(step1.move).eq(`use ${major(12).uid}/m0.1 tile 1`); // pushes n0's territory east; A never moves
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
        // Skipping tradeHands (the chain's own tail) stays legal, so
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
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move("discard", { trusted: true }); // discards nothing, draws back up to 6
        const log = g.chatLog(["Alice", "Bob"]);
        const lastNode = log[log.length - 1];
        expect(lastNode.some(l => l.includes("discarded"))).eq(false);
        expect(lastNode.some(l => l.includes("drew"))).eq(true);
    });

    it("explicitly says '0' when drawing nothing, rather than a bare 'X drew'", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
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
        g.move(`use ${major(11).uid}/m0.1 n0.1`, { trusted: true }); // skips step 2 (attack)
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("traded hands"));
        expect(line).eq(i18next.t("apresults:SWAP.gnostica", { player: "Alice", target: "Bob" }));
    });

    it("destroy (Swords piece): names whose minion was destroyed", () => {
        const g = new GnosticaGame(2);
        clearBoard(g); // fully deterministic - see clearBoard's own docs
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, small piece, on the targeted cell
        g.move(`use ${aceOfSwords().uid}/m0.1 piece n0.1 1`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("destroyed"));
        expect(line).eq(i18next.t("apresults:DESTROY.gnostica_piece", { player: "Alice", what: "1", target: "Bob" }));
    });

    it("convert, not destroy (Swords piece): an enemy minion that survives an attack, merely shrunk, is not logged as destroyed - and names whose it is", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2
        g.board.get(1, 0)!.pieces[0] = new Piece(2, 2, "W"); // grow it to 2 pips first
        g.move(`use ${aceOfSwords().uid}/m0.1 piece n0.2 1`, { trusted: true });
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, size: 1 }); // survived, shrunk
        const log = g.chatLog(["Alice", "Bob"]);
        expect(log.flat().some(l => l.includes("destroyed"))).to.be.false;
        const line = log.flat().find(l => l.includes("shrank"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_piece_shrink", { player: "Alice", into: "size 1", where: "n0", target: "Bob" }));
    });

    it("convert (Swords piece): no target named when the acting player shrinks their own minion", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, elsewhere
        g.board.get(0, 0)!.pieces[0] = new Piece(1, 2, "E"); // grow the acting minion itself to 2 pips
        g.move(`use ${aceOfSwords().uid}/m0.2 piece m0.2 1`, { trusted: true });
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1 }); // survived, shrunk
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("shrank"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_piece_shrink_own", { player: "Alice", into: "size 1", where: "m0" }));
    });

    it("convert (Discs piece): names whose piece was grown, when it isn't the acting player's own", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        g.move(`use ${aceOfDiscs().uid}/m0.1 piece n0.1 W`, { trusted: true });
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, size: 2 });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("grew"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_piece", { player: "Alice", into: "size 2", where: "n0", target: "Bob" }));
    });

    it("convert (Discs piece): no target named for the acting player's own minion", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move(`use ${aceOfDiscs().uid}/m0.1 piece m0.1 N`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("grew"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_piece_own", { player: "Alice", into: "size 2", where: "m0" }));
    });

    it("destroy (Swords tile): names the destroyed card, not a raw uid", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords()); // m0, 1 pip
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0, worth 1 - exactly destroyed by 1 pip
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2, elsewhere
        g.move(`use ${aceOfSwords().uid}/m0.1 tile n0 1`, { trusted: true });
        expect(g.board.get(1, 0)?.card).eq(undefined); // territory genuinely destroyed, not just shrunk
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("destroyed"));
        expect(line).eq(i18next.t("apresults:DESTROY.gnostica_tile", { player: "Alice", what: withArticle(aceOfDiscs().name), where: "n0" }));
    });

    it("convert, not destroy (Swords tile): a territory that survives an attack, replaced by a new card, is logged as shrunk - not destroyed", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords()); // m0, 1 pip
        const oldUid = card("KS").uid; // King of Swords, worth 2
        forceCardAt(g, 1, 0, () => card("KS")); // n0
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2, elsewhere
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        g.move(`use ${aceOfSwords().uid}/m0.1 tile n0 1 ${spotUid}`, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(spotUid); // survived, replaced - not destroyed
        const log = g.chatLog(["Alice", "Bob"]);
        expect(log.flat().some(l => l.includes("destroyed"))).to.be.false;
        const line = log.flat().find(l => l.includes("shrank"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_tile_shrink", { player: "Alice", what: withArticle(card(oldUid).name), into: withArticle(card(spotUid).name), where: "n0" }));
    });

    it("move (Rods piece): names whose minion was moved when it isn't the acting player's own", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfRods());
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0, distinct from the Rods card itself
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        g.move(`use ${aceOfRods().uid}/m0.1 piece n0.1 1 U`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("moved"));
        expect(line).eq(i18next.t("apresults:MOVE.gnostica_rod_piece", { player: "Alice", what: "1", from: "n0", to: "o0", target: "Bob" }));
    });

    it("move (Rods piece): no target named for the acting player's own minion", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move(`use ${aceOfRods().uid}/m0.1 piece m0.1 1 N`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("moved"));
        expect(line).eq(i18next.t("apresults:MOVE.gnostica_rod_piece_own", { player: "Alice", what: "1", from: "m0", to: "n0" }));
    });

    it("place (Cups enemy): names whose stash the copy came from", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        g.move(`use ${aceOfCups().uid}/m0.1 enemy n0 1`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("copy of"));
        expect(line).eq(i18next.t("apresults:PLACE.gnostica_enemy_target", { player: "Alice", where: "n0", target: "Bob" }));
    });

    it("convert (Hierophant replace): names whose piece was displaced", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(5)); // The Hierophant
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "S")]; // enemy B, player 2, facing S
        g.move(`use ${major(5).uid}/m0.1 n0.1 U`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("converted"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_hierophant_target", { player: "Alice", where: "n0", target: "Bob" }));
    });

    it("orient (Devil orientAny): names whose minion was reoriented when it isn't the acting player's own", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(15)); // The Devil
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "S")]; // enemy B, player 2, facing S
        g.move(`use ${major(15).uid}/m0.1 n0.1 U`, { trusted: true }); // skips steps 2 & 3
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("oriented"));
        expect(line).eq(i18next.t("apresults:ORIENT.gnostica_target", { player: "Alice", where: "n0", what: "1", facing: "U", target: "Bob" }));
    });

    it("orient: no target named for an ordinary turn action (always the acting player's own piece)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.move("orient m0.1 N", { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("oriented"));
        expect(line).eq(i18next.t("apresults:ORIENT.gnostica_own", { player: "Alice", where: "m0", what: "1", facing: "N" }));
    });

    it("use (activating a card already on the board): names the card/not a raw uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2
        g.move(`use ${aceOfCups().uid}/m0.1 own n0 U`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("used"));
        expect(line).eq(i18next.t("apresults:USE.gnostica", { player: "Alice", what: withArticle(aceOfCups().name) }));
    });

    it("deckDraw (playing a card from hand): names the card, not a raw uid", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true }); // player 1
        g.move("place l0 U", { trusted: true }); // player 2
        g.hands[0].push(aceOfCups().uid);
        g.move(`play ${aceOfCups().uid}/m0.1 own m0 U`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("played"));
        expect(line).eq(i18next.t("apresults:DECKDRAW.gnostica_hand", { player: "Alice", what: withArticle(aceOfCups().name) }));
    });

    it("convert (Discs tile grow-replace): names both the replaced and the new card, not raw uids", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.board.get(1, 0)!.card = card("2C"); // n0, a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0 U", { trusted: true }); // player 2
        const royaltyUid = "KS"; // King of Swords, worth 2
        g.hands[0].push(royaltyUid);
        g.move(`use ${aceOfDiscs().uid}/m0.1 tile n0 ${royaltyUid}`, { trusted: true });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("grew the territory"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_tile", { player: "Alice", what: withArticle(card("2C").name), into: withArticle(card(royaltyUid).name), where: "n0" }));
    });

    it("falls back to 'Player N' when no names (or too few) are supplied - old-data/pre-#47 compatibility path", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(11)); // Justice
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "U")];
        g.move(`use ${major(11).uid}/m0.1 n0.1`, { trusted: true });
        const log = g.chatLog([]);
        const line = log.flat().find(l => l.includes("traded hands"));
        expect(line).eq(i18next.t("apresults:SWAP.gnostica", { player: "Player 1", target: "Player 2" }));
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
        g.move(`use ${major(2).uid}/5C`, { trusted: true }); // step 1: discard 5C, redraw to 6, pauses
        expect(g.continued).to.not.be.empty;
        expect(g.currplayer).eq(1); // same seat still owes step 2
        g.move(`use ${major(2).uid}/decline`, { trusted: true }); // step 2: decline
        expect(g.continued).to.be.empty;
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
        g.move(`use ${major(2).uid}/5C`, { trusted: true });
        expect(g.currplayer).eq(1);
        expect(g.continued).to.not.be.empty;
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6);
        g.move(`play ${major(2).uid}/AR (via ${major(2).uid})`, { trusted: true }); // step 2: discard AR instead of declining
        expect(g.continued).to.be.empty;
        expect(g.currplayer).eq(2);
        expect(g.hands[0]).to.not.include("AR");
        expect(g.hands[0].length).eq(6); // redrawn back up again
    });

    // A resume submission (validateMove only - a {trusted: true} caller is
    // trusted to have validated already, per feedback_no_trusted_path_defense)
    // must carry a matching "(via <root>)" anchor AND spell the head that
    // fits what it's doing: "decline" to give the active card up, "discard"
    // for a High Priestess round. The click UI never gets any of this
    // wrong, so every rejection is a malformed hand-edit -> INVALID_MOVE.
    it("resume-mismatch guards reject a wrong card uid or a wrong head word", () => {
        const g = setupHP();
        g.hands[0] = ["2C", "5C", "AR"];
        g.move(`use ${major(2).uid}/5C`, { trusted: true });
        expect(g.continued).to.not.be.empty;
        // Wrong anchor (the Fool, a real continuing card, but not the
        // High Priestess round actually pending) / missing anchor.
        expect(g.validateMove("decline 00 (via 00)").valid).to.be.false;
        expect(g.validateMove("use 00/decline").valid).to.be.false;
        // Right anchor, wrong head ("play"/"use", or "decline" - a High
        // Priestess round is always a "discard", never declined; to do
        // nothing you discard and draw 0) -> rejected.
        expect(g.validateMove(`play ${major(2).uid}/AR (via ${major(2).uid})`).valid).to.be.false;
        expect(g.validateMove(`use ${major(2).uid}/decline`).valid).to.be.false;
        expect(g.validateMove(`decline (via ${major(2).uid})`).valid).to.be.false;
        // The canonical spellings work.
        expect(g.validateMove(`discard AR (via ${major(2).uid})`).valid).to.be.true;
        expect(g.validateMove(`discard draw 0 (via ${major(2).uid})`).valid).to.be.true;
        // None of the rejected attempts cleared the obligation.
        expect(g.continued).to.not.be.empty;
        expect(g.currplayer).eq(1);
    });

    it("a trusted resume with more step segments than the obligation needs consumes what it needs and drops the rest", () => {
        const g = setupHP();
        g.hands[0] = ["2C", "5C", "AR"];
        g.move(`use ${major(2).uid}/5C`, { trusted: true });
        expect(g.continued).to.not.be.empty;
        g.move(`play ${major(2).uid}/AR/2C (via ${major(2).uid})`, { trusted: true });
        expect(g.continued).to.be.empty; // the obligation resolved on "AR" alone
        expect(g.currplayer).eq(2); // "2C" was never consumed
    });

    it("a bare 'decline' with nothing pending is rejected outright", () => {
        const g = setupHP();
        expect(g.continued).to.be.empty;
        const validated = g.validateMove(`decline ${major(2).uid} (via ${major(2).uid})`);
        expect(validated.valid).to.be.false;
        expect(validated.message).to.eq(i18next.t("apgames:validation.gnostica.NOTHING_TO_DECLINE"));
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

    // A revealed card's own real buttons show immediately (no separate
    // "Use Card X" click first - see getActionButtons()'s own docs), with
    // a persisting "Decline X" always folded in alongside them - even for
    // a Rods card whose every eligible minion is upright (Rods rejects
    // upright minions for every mode), so the player always has a way
    // back out.
    it("a revealed Rods card with only upright minions leaves every mode struck through, but the persisting Decline button is still there", () => {
        const g = setupFool();
        pluckCard(g, "2R");
        g.drawPile.unshift("2R"); // force the flip to reveal 2 of Rods
        g.move(`use ${major(0).uid}`, { trusted: true });
        // Only Fool's own remaining flip persists; the revealed 2R is
        // re-derived from the resume submission's own head arg.
        expect(g.continued).to.deep.equal(["00.1"]);

        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; label?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        // Rods' own mode buttons show directly - no "Use Card 2R" click
        // needed first - and every one is struck through, since Fool's
        // own minion (the only eligible one) is upright.
        const modeButtons = bar.buttons!.filter(b => b.value?.startsWith("mode_R_"));
        expect(modeButtons.length).to.be.greaterThan(0);
        for (const b of modeButtons) {
            expect(b.attributes?.some(a => a.name === "text-decoration" && a.value === "line-through")).to.be.true;
        }
        // A way out, still available.
        const declineBtn = bar.buttons!.find(b => b.value === "decline_power")!;
        expect(declineBtn.label).eq("Decline 2R");
        expect(declineBtn.attributes).to.be.undefined;
    });

    // Regression: a revealed minor card's own eligible pool ("play" draws
    // from every one of the acting player's minions, not just one cell -
    // see eligibleMinionsForPlay's own docs) can span more than one cell.
    // Before this fix, computeActionButtons' own minionAmbiguous branch
    // fell back to the ordinary top-level bar unconditionally - wrong here,
    // since none of those 6 buttons are legal mid-resume (same reasoning
    // as the "special" branch just below it) - clicking "Play Card X"
    // dispatched into the generic "play" head instead of anything about
    // the actual pending obligation.
    it("a revealed minor card whose own eligible pool spans 2+ cells shows the paused Use/Decline pair, not the ordinary top-level bar", () => {
        const g = setupFool();
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "U")]; // a second minion for player 1, a different cell than Fool's own
        pluckCard(g, "10D");
        g.drawPile.unshift("10D");
        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.deep.equal(["00.1"]);
        expect(buttonValues(g)).to.deep.equal(["resume_power", "decline_power"]);
    });

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
        g.move(`use ${theWorld().uid} as ${major(6).uid}/m0.1 piece n0.1 1 U/o0.1 own o0 U`, { trusted: true });
        expect(g.continued).to.be.empty; // World's push is informationally free - no pause at all
        expect(g.currplayer).eq(2);
        const dest = g.board.get(2, 0)!; // o0
        expect(dest.pieces.length).eq(2); // B, pushed here, plus Lovers' own new piece
        expect(g.board.get(1, 0)!.pieces.length).eq(0); // B left n0
        // Three chained segments (World's own push, then Lovers' own two
        // steps) means every one of them gets its own _group wrapper.
        expect(g.results.filter(r => r.type === "_group")).to.have.length(3);
        const flat = g.results.flatMap(r => r.type === "_group" ? r.results : [r]);
        // World's own step reuses the ordinary "use" result type (no more
        // stubbed "borrowPower" - see chatLog's own docs), tagged with
        // count: 21 so chatLog can still say "borrowed the power of X"
        // instead of the plain "used X" wording an ordinary activation gets.
        expect(flat.some(r => r.type === "use" && (r as { what?: string; count?: number }).what === major(6).uid && (r as { count?: number }).count === 21)).eq(true);
    });

    // Matches Magnate's own "a turn is never complete, only submissible"
    // rule: whenever a genuinely optional further step remains available
    // (Lovers' own step 2, once step 1 is done), the move is
    // unconditionally complete:0 - computed directly from the frame's own
    // state, the same for a hand-typed move as a click-built one, no
    // marker needed (the same way an outright incomplete step already
    // needs none). Only once the chain is fully exhausted (both steps
    // given, nothing further possible) does it become complete:1.
    it("a step done with a genuinely optional further one still available is always complete:0, never 1", () => {
        const g = setupWorldLovers();
        const oneStep = `use ${theWorld().uid} as ${major(6).uid}/m0.1 piece n0.1 1 U`;
        const result = g.validateMove(oneStep);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(0);
        const bothSteps = `${oneStep}/o0.1 own o0 U`;
        const exhausted = g.validateMove(bothSteps);
        expect(exhausted.valid).to.be.true;
        expect(exhausted.complete).eq(1);
        // A trailing "/" is no longer special - just an ordinary empty
        // step segment, malformed like any other.
        const trailingSlash = g.validateMove(`${oneStep}/`);
        expect(trailingSlash.valid).to.be.false;
    });

    it("World -> Lovers, then nothing more: rejected as incomplete, not silently accepted as a no-op move", () => {
        // Regression: naming Lovers as World's target has no board effect
        // of its own (unlike Fool's flip) - completing right there would
        // make the whole move a no-op in every way that matters, exactly
        // what #49 forbids for anything but Fool's own reveal.
        const g = setupWorldLovers();
        const result = g.validateMove(`use ${theWorld().uid} as ${major(6).uid}`);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: major(6).name }));
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
        // The moment the target is picked, it lands in the head as
        // "as <borrowed card>" - the head arg (The World) never moves.
        expect(targetClick.move).eq(`use ${theWorld().uid} as ${major(6).uid}`);
        expect(targetClick.valid).to.be.true;

        // Lovers' own step 1 (Rods) buttons are now on offer, proving
        // parsePendingStep's stack-awareness resolved the PUSHED frame's
        // own def, not World's own (already-exhausted) one.
        const preview1 = setup();
        preview1.move(targetClick.move, { partial: true });
        expect(buttonValues(preview1)).to.include("mode_R_piece");

        const modeClick = g.handleClick(targetClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq(`use ${theWorld().uid} as ${major(6).uid}/m0.1 piece`);

        const redirected = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.1");
        expect(redirected.move).eq(`use ${theWorld().uid} as ${major(6).uid}/m0.1 piece n0.1 1`);
        expect(redirected.valid).to.be.true;

        const preview2 = setup();
        preview2.move(redirected.move, { partial: true });
        expect(buttonValues(preview2)).to.include("mode_C_own");

        const step2 = g.handleClick(redirected.move, -1, -1, "_btn_mode_C_own");
        expect(step2.valid).to.be.true;

        g.move(step2.move, { trusted: true });
        expect(g.continued).to.be.empty;
        expect(g.currplayer).eq(2);
        expect(g.board.get(2, 0)!.pieces.length).eq(1); // B, pushed to o0
        expect(g.board.get(1, 0)!.pieces.length).eq(1); // Lovers' own new piece, at n0 (now vacant)
    });

    // Regression: worldUseAny defers its own minion choice entirely to the
    // borrowed card's first step (see applyPowerStep's own docs) - with 2+
    // of the player's own minions sharing The World's cell, buildSpecialPending
    // used to eagerly compute minion-ambiguity anyway, so the bar wrongly
    // offered a "Choose Minion" picker before any card was even targeted
    // (and picking one built a malformed "use 21/m0.1" move, missing "as").
    it("worldUseAny: 2+ minions on World's own cell don't trigger a premature minion picker", () => {
        const g = setupWorldLovers();
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E"), new Piece(1, 2, "W")];
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [rowM, colM] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, rowM, colM);
        expect(cellClick.move).eq(`use ${theWorld().uid}`);
        g.move(cellClick.move, { partial: true }); // sync engine state, same as the playground's own preview flow
        expect(buttonValues(g)).to.not.include.members(["minion_m0.1", "minion_m0.2"]);
        const [rowP, colP] = rowColFor(g, 3, 0);
        const targetClick = g.handleClick(cellClick.move, rowP, colP);
        expect(targetClick.move).eq(`use ${theWorld().uid} as ${major(6).uid}`);
        expect(targetClick.valid).to.be.true;
    });

    // #67: the collapsed top-level button names the active card's own
    // uid, not just which action started the move - and once World's own
    // push resolves onto Lovers, the label follows the ACTIVE card
    // (Lovers), not the root (World), matching #74's own "via" reasoning.
    it("Use Territory names the active card's uid once one's known, following World's own push", () => {
        const g = setupWorldLovers();
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [rowM, colM] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, rowM, colM);

        // World's own step is itself a chained segment, so render() may
        // return an array of per-frame reps once a frame boundary exists
        // (see the shared buttonValues helper's own identical docs) - the
        // live button bar is always on the last one.
        const buttonLabel = (g2: GnosticaGame, value: string): string | undefined => {
            const raw = g2.render();
            const rep = (Array.isArray(raw) ? raw[raw.length - 1] : raw) as { areas?: { type: string; buttons?: { value?: string; label?: string }[] }[] };
            const bar = rep.areas!.find(a => a.type === "buttonBar")!;
            return bar.buttons!.find(b => b.value === value)?.label;
        };

        const preview = setupWorldLovers();
        preview.move(cellClick.move, { partial: true });
        expect(buttonLabel(preview, "use")).eq(`Use Territory (${theWorld().uid})`);

        // "still incomplete" states (Lovers' own chain has a 2nd step left
        // to go - see "World -> Lovers via clicks" above) keep this.liveMove
        // set for the NEXT click to build on, unlike modeClick's own
        // self-target default, which is already a syntactically complete
        // step and so - via the same implicit-decline path an explicit
        // "decline" click would take - can auto-resolve Lovers' own
        // remaining (optional) 2nd step and end the whole turn right there.
        const [rowP, colP] = rowColFor(g, 3, 0);
        const targetClick = g.handleClick(cellClick.move, rowP, colP);
        const modeClick = g.handleClick(targetClick.move, -1, -1, "_btn_mode_R_piece");
        const redirected = g.handleClick(modeClick.move, -1, -1, "_btn_target_n0.1");
        const preview2 = setupWorldLovers();
        preview2.move(redirected.move, { partial: true });
        expect(buttonLabel(preview2, "use")).eq(`Use Territory (${major(6).uid})`);
    });

    it("clicking a minor arcana territory while picking World's target gives the 'choose a major' hint, not a stale no-minion complaint", () => {
        const g = setupWorldLovers();
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [rowM, colM] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, rowM, colM); // use 21
        const [rowA, colA] = rowColFor(g, 1, 0); // the Ace of Discs
        const minorClick = g.handleClick(cellClick.move, rowA, colA);
        expect(minorClick.valid).to.be.false;
        expect(minorClick.message).eq(i18next.t("apgames:validation.gnostica.WORLD_CHOOSE_TARGET"));
        expect(minorClick.move).eq(cellClick.move); // move string unchanged - no silent switch to "use AR"
    });

    it("World rejects a self-reference and an off-board target; skipping its own power outright needs a trusted caller (#49, same as any other major)", () => {
        const selfRef = new GnosticaGame(2);
        forceCardAt(selfRef, 0, 0, () => theWorld());
        selfRef.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        expect(() => selfRef.move(`use ${theWorld().uid} as ${theWorld().uid}`, { trusted: true })).to.throw();

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
        expect(() => offBoard.move(`use ${theWorld().uid} as ${major(6).uid}`, { trusted: true })).to.throw(); // Lovers isn't on the board

        const skip = new GnosticaGame(2);
        forceCardAt(skip, 0, 0, () => theWorld());
        skip.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const validated = skip.validateMove(`use ${theWorld().uid}`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(-1); // #49 applies to the root the same as every other major now
        expect(() => skip.move(`use ${theWorld().uid}`, { trusted: true })).to.not.throw();
    });

    it("Fool flips a forced major -> pauses; resuming Lovers' own two steps also auto-continues Fool's own second (mandatory) flip", () => {
        const g = setupFool();
        pluckCard(g, "06");
        g.drawPile.unshift("06"); // force the flip to reveal The Lovers
        pluckCard(g, "AS");
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0 - own piece B
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")];
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, facing n0

        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.currplayer).eq(1);
        expect(g.continued).to.not.be.empty;
        // Fool's own frame stays (it still owes its own 2nd flip - only
        // 1 of its own 2 steps is done), with the revealed card pushed on top.
        expect(g.continued).to.deep.equal(["00.1"]);
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
        g.move(`play 06/m0.1 piece n0.1 1 U/o0.1 own o0 U (via ${major(0).uid})`, { trusted: true });
        expect(g.continued).to.not.be.empty;
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.currplayer).eq(1); // still paused - the turn hasn't passed yet
        expect(g.board.get(2, 0)!.pieces.length).eq(2); // Lovers' own steps DID take effect

        // Declining the second reveal's own power now fully resolves the
        // whole activation in one more submission (Fool's frame is
        // already spent, so nothing is left to auto-continue).
        g.move(`decline AS (via ${major(0).uid})`, { trusted: true });
        expect(g.continued).to.be.empty;
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

        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.deep.equal(["00.1"]);
        g.drawPile.unshift("AS"); // force what Fool's own automatic second flip reveals
        g.move(`play AC/m0.1 own m0 U (via ${major(0).uid})`, { trusted: true });
        expect(g.continued).to.not.be.empty; // Fool's own second flip auto-fired, in the same submission
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.currplayer).eq(1);
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // Fool's own minion, plus the new Cups piece

        g.move(`decline AS (via ${major(0).uid})`, { trusted: true });
        expect(g.continued).to.be.empty;
        expect(g.currplayer).eq(2);
    });

    // A two-stage special (magicianChoice, hermitTeleport) that Fool
    // reveals must be click-driven from the very first click, when nothing
    // has been clicked yet THIS turn - movebox.value is still "" (untouched
    // since the last real commit). handleClickCore's own parsePendingStep
    // calls need pendingPower's root seeded in for them in this case.
    it("a revealed Magician's own suit buttons are click-driven even before anything else has been clicked this turn", () => {
        const g = setupFool();
        pluckCard(g, major(1).uid);
        pluckCard(g, "AS");
        g.drawPile.unshift(major(1).uid); // force the flip to reveal The Magician
        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.deep.equal(["00.1"]);

        const suitClick = g.handleClick("", -1, -1, "_btn_magician_C");
        expect(suitClick.valid).to.be.true;
        expect(suitClick.move).eq(`play ${major(1).uid} as C (via ${major(0).uid})`);

        // Syncing the engine to this still-incomplete segment (suit
        // chosen, mode not yet - same as the playground's own preview flow
        // between every click) must neither silently complete the step
        // early nor lose track of the suit already chosen - the bar should
        // show CUPS' OWN mode buttons directly, not the suit-picker again,
        // and "Decline 01" (the Magician, not the Fool) stays put
        // throughout.
        g.move(suitClick.move, { partial: true });
        expect(buttonValues(g)).to.include.members(["mode_C_own", "mode_C_enemy", "mode_C_new"]);
        expect(buttonValues(g)).to.not.include("magician_R");
        const midRep = g.render() as { areas?: { type: string; buttons?: { value?: string; label?: string }[] }[] };
        const midBar = midRep.areas!.find(a => a.type === "buttonBar")!;
        expect(midBar.buttons!.find(b => b.value === "decline_power")!.label).eq("Decline 01");

        const modeClick = g.handleClick(suitClick.move, -1, -1, "_btn_mode_C_own");
        expect(modeClick.valid).to.be.true;

        // Once Magician's own power genuinely completes (via this same
        // partial sync), Fool's own next flip becomes the active step -
        // mandatory, not optional (see walkFrameStack's own docs) - so
        // there is nothing left to decline here at all.
        g.move(modeClick.move, { partial: true });
        expect(buttonValues(g)).to.not.include("decline_power");

        g.drawPile.unshift("AS"); // force what Fool's own automatic second flip reveals
        g.move(modeClick.move, { trusted: true });
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.currplayer).eq(1);
    });

    // Fool's own draws are never optional (walkFrameStack's own docs) -
    // declining what the first flip revealed auto-continues straight into
    // the second flip, IN THE SAME SUBMISSION, rather than needing a
    // separate "Continue"/resume round just to ask whether Fool should
    // draw again.
    it("declining what the first flip revealed auto-continues into a mandatory second flip, in one submission", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        pluckCard(g, "AD");
        g.drawPile.unshift("AC");

        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.deep.equal(["00.1"]);

        g.drawPile.unshift("AD");
        g.move(`decline AC (via ${major(0).uid})`, { trusted: true }); // decline AC's own step
        expect(g.continued).to.not.be.empty;
        // Fool's own frame is now fully exhausted (both flips done), but
        // the forced pause on the SECOND flip's own reveal fires before
        // any cascade could pop it - so it's still sitting there, buried,
        // exactly like World's own spent frame does in the nested tests
        // below.
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.discardPile).to.include.members(["AC", "AD"]); // both flips actually happened
        expect(g.currplayer).eq(1); // still paused on AD's own choice
    });

    // Same cascade as above, but the revealed card's own tail step is
    // skipped by OMISSION (no legal tradeHands target exists at all, so
    // there's nothing to type) rather than an explicit "decline" token.
    // walkFrameStack's own "segments exhausted" skip branch used to just
    // pop that one frame and stop, leaving Fool's own mandatory second
    // flip sitting unexecuted with no button anywhere to trigger it (the
    // bar only ever offers "Use Card X"/"Decline X" for a flip still at
    // its own nextStepIndex 0 - see powerStepMessageKey's own docs) - a
    // real dead end for the player.
    it("an implicitly-skipped tail step (no legal tradeHands target) also auto-continues Fool's own mandatory second flip", () => {
        const g = setupFool();
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // a real facing - Rods' own move step needs one
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0 - the territory Hanged Man's own move step pushes
        pluckCard(g, major(12).uid);
        g.drawPile.unshift(major(12).uid); // force the flip to reveal The Hanged Man
        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.deep.equal(["00.1"]);

        g.drawPile.unshift("AS"); // whatever Fool's own second flip reveals next
        // Only step 1 (the push) is typed - no enemy exists anywhere to
        // trade hands with, so step 2 is left entirely unaddressed rather
        // than explicitly declined.
        g.move(`play ${major(12).uid}/m0.1 tile 1 (via ${major(0).uid})`, { trusted: true });
        expect(g.board.has(1, 0)).eq(false); // the push actually happened
        expect(g.continued).to.not.be.empty;
        // tradeHands never even shows up on the stack - it's popped by
        // the same implicit-skip branch that walked straight into
        // Fool's own next mandatory flip within this SAME submission.
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.discardPile).to.include.members([major(12).uid, "AS"]);
        expect(g.currplayer).eq(1);
    });

    // Instead of the generic VALID_MOVE fallback, a tail step that
    // genuinely cannot be completed (no enemy anywhere for tradeHands to
    // reach) gets an explicit heads-up that it will be skipped - true
    // whether Hanged Man was activated directly or reached via the Fool's
    // own reveal, and whether or not the tradeHands step's own card is the
    // acting player's LAST step (Justice: tradeHands then attack) - see
    // specialStepHasNoLegalTarget's own docs.
    it("a doomed tail step (tradeHands/hierophantReplace with no legal target) gets an explicit skip message, not the generic VALID_MOVE fallback", () => {
        const skippedMsg = i18next.t("apgames:validation.gnostica.TRADEHANDS_SKIPPED_NO_TARGET", { card: major(12).name });
        {
            // Direct activation - no Fool involved at all.
            const g = new GnosticaGame(2);
            clearBoard(g);
            forceCardAt(g, 0, 0, () => major(12)); // The Hanged Man
            forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0 - the territory to push
            g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
            const result = g.validateMove(`use ${major(12).uid}/m0.1 tile 1`);
            expect(result.valid).to.be.true;
            expect(result.complete).eq(1); // still a genuinely complete, submittable move
            expect(result.message).eq(skippedMsg);
        }
        {
            // Same scenario, reached via the Fool's own reveal instead.
            const g = setupFool();
            g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
            forceCardAt(g, 1, 0, () => aceOfDiscs());
            pluckCard(g, major(12).uid);
            g.drawPile.unshift(major(12).uid);
            g.move(`use ${major(0).uid}`, { trusted: true });
            const result = g.validateMove(`play ${major(12).uid}/m0.1 tile 1 (via ${major(0).uid})`);
            expect(result.valid).to.be.true;
            expect(result.complete).eq(1);
            expect(result.message).eq(skippedMsg);
        }
        {
            // Same again, but step 1 uses Rods' "piece" mode (moving the
            // acting minion itself) rather than "tile" (pushing territory,
            // which leaves the minion in place). This APPENDS a second,
            // post-move minion ref onto the frame's own minions array
            // rather than replacing the pre-move one (see walkFrameStack's/
            // validateFrameStack's own `[...top.minions, newMinion]`) -
            // specialStepHasNoLegalTarget must still recognize this as
            // doomed by checking the piece's CURRENT (moved) position, not
            // bail out just because more than one entry is now present.
            const g = setupFool();
            g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
            forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0 - where the piece relocates to
            pluckCard(g, major(12).uid);
            g.drawPile.unshift(major(12).uid);
            g.move(`use ${major(0).uid}`, { trusted: true });
            const result = g.validateMove(`play ${major(12).uid}/m0.1 piece m0.1 1 (via ${major(0).uid})`);
            expect(result.valid).to.be.true;
            expect(result.complete).eq(1);
            expect(result.message).eq(skippedMsg);
        }
        {
            // Sanity: a real, reachable enemy means no message at all - the
            // decline (if it happens) is a genuine, silent choice again.
            // "piece m0.1 1" actually RELOCATES the acting minion (target
            // self, distance 1) to n0, still facing east - so the enemy
            // has to sit at o0, the piece's own NEW facing cell once it
            // gets there, not at n0 itself (n0 is just a wasteland the
            // piece passes onto, per Rods' own "piece" mode - see
            // applyRods's own docs).
            const g = new GnosticaGame(2);
            clearBoard(g);
            forceCardAt(g, 0, 0, () => major(12));
            forceCardAt(g, 1, 0, () => aceOfDiscs());
            g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
            g.board.store.set(2, 0, new CellContents());
            g.board.get(2, 0)!.pieces = [new Piece(2, 1, "U")]; // enemy at o0
            const result = g.validateMove(`use ${major(12).uid}/m0.1 piece m0.1 1`);
            expect(result.message).to.not.eq(skippedMsg);
        }
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

        g.move("play 00", { trusted: true });
        // Outer Fool still owes its 2nd flip ("00.1"); the inner
        // self-revealed Fool owes both of its own ("00.0" on top).
        expect(g.continued).to.deep.equal(["00.1"]);
    });

    it("World targets Fool: a nested pause, and declining the reveal auto-continues into Fool's own mandatory second flip", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        forceCardAt(g, 1, 0, () => major(0)); // The Fool, World's own target
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        pluckCard(g, "AS");

        g.move(`use ${theWorld().uid} as 00`, { trusted: true });
        expect(g.continued).to.not.be.empty;
        // World's own spent frame is buried but not yet popped - the
        // forced pause fires before any cascade could reach it (same
        // "buried, not yet cleaned up" situation as Fool's own frame
        // above).
        expect(g.continued).to.deep.equal(["00.1"]);
        expect(g.currplayer).eq(1);

        // Declining AC's own power exposes Fool's own remaining flip -
        // never optional (see walkFrameStack's own docs) - so it fires
        // automatically, in this SAME submission, revealing a new card
        // and pausing on IT instead.
        g.drawPile.unshift("AS");
        g.move(`decline AC (via 00)`, { trusted: true }); // decline the reveal (AC's own step)
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.currplayer).eq(1);
    });

    it("resume-mismatch guards are keyed on the innermost obligation, not an outer one still on the stack", () => {
        // Fool reveals the High Priestess; resuming its round 1 leaves
        // continued = ["00.1", "02.1"] - the Fool still owes its own second
        // flip, but the High Priestess's round 2 is what's active now. The
        // anchor must be "02" (the innermost obligation), not "00" (the
        // Fool buried under it).
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(0)); // The Fool
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        for (const hand of g.hands) {
            const idx = hand.indexOf("02");
            if (idx !== -1) hand.splice(idx, 1);
        }
        const drawIdx = g.drawPile.indexOf("02");
        if (drawIdx !== -1) g.drawPile.splice(drawIdx, 1);
        g.drawPile.unshift("02");

        g.move(`use ${major(0).uid}`, { trusted: true }); // flip reveals the High Priestess
        expect(g.continued).to.deep.equal(["00.1"]);
        g.hands[0] = ["2C", "5C", "AR"];
        g.move("discard 5C (via 00)", { trusted: true }); // High Priestess round 1
        expect(g.continued).to.deep.equal(["00.1", "02.1"]);

        // "(via 00)" names the buried Fool, not the active round 2 -> rejected.
        expect(g.validateMove("decline 00 (via 00)").valid).to.be.false;
        expect(g.continued).to.deep.equal(["00.1", "02.1"]);
        // The correct anchor works (a High Priestess round is a "discard").
        expect(g.validateMove("discard draw 0 (via 02)").valid).to.be.true;
    });

    it("Fool's own root activation needs no button - selecting it already produces a complete, submittable move", () => {
        const g = setupFool();
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use ${major(0).uid}`);
        expect(cellClick.valid).to.be.true;
        // The flip is mandatory and one-shot - nothing to reconsider via
        // a further click, so genuinely complete:1 (forcePauseReadyMessage's
        // own "ready" state - see validateFrameStack's own docs).
        expect(cellClick.complete).to.eq(1);
        expect(cellClick.message).to.eq(i18next.t("apgames:validation.gnostica.FOOL_FLIP_READY"));

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
        // A partial preview never persists a continuation - see
        // this.continued's own docs - so nothing has been committed yet,
        // there's nothing to decline, and the bar should be the plain,
        // uncollapsed top-level set (Use Territory bold, since this was
        // "use 00") with no "decline_power" mixed in.
        expect(preview.continued).to.be.empty;
        expect(buttonValues(preview)).to.not.include("decline_power");
        const rep = preview.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const useBtn = bar.buttons!.find(b => b.value === "use")!;
        expect(useBtn.attributes).to.deep.equal([{ name: "font-weight", value: "bold" }]);

        // The real commit is what actually flips and pauses.
        const real = setupFool();
        real.move(cellClick.move);
        expect(real.continued).to.not.be.empty;
    });

    // Same as the "use" case above, but for "play" (Fool from hand) -
    // before submitting, there's nothing yet to decline, so no
    // "Decline 00" should show alongside the bold Play Card button.
    it("playing the Fool from hand, before submitting, shows no Decline button either", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U", { trusted: true });
        g.move("place l0 U", { trusted: true });
        g.hands[0].push("00"); // Fool, injected regardless of the random deal

        g.move("play 00", { partial: true });
        expect(buttonValues(g)).to.not.include("decline_power");
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const playBtn = bar.buttons!.find(b => b.value === "play")!;
        expect(playBtn.attributes).to.deep.equal([{ name: "font-weight", value: "bold" }]);
    });

    // Fool's own second flip is never a separate, optional choice - it
    // fires automatically the moment declining a reveal exposes it (see
    // walkFrameStack's own docs), so clicking "Decline" on a revealed
    // card's own power already produces a complete, submit-ready move
    // whose real commit performs BOTH the decline and the automatic
    // second flip - the button bar has nothing Fool-specific to offer at
    // any point in this preview.
    it("declining a revealed card's power in the click preview is already complete, and the decline choice persists (bolded)", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.not.be.empty;

        const declined = g.handleClick("", -1, -1, "_btn_decline_power");
        expect(declined.move).eq(`decline AC (via ${major(0).uid})`);
        expect(declined.valid).to.be.true;
        // Declining exposes Fool's own mandatory, one-shot 2nd flip -
        // nothing to reconsider, genuinely complete:1.
        expect(declined.complete).to.eq(1);
        expect(declined.message).to.eq(i18next.t("apgames:validation.gnostica.DECLINE_THEN_AUTO_DRAW"));

        const preview = setupFool();
        pluckCard(preview, "AC");
        preview.drawPile.unshift("AC");
        preview.move(`use ${major(0).uid}`, { trusted: true });
        preview.move(declined.move, { partial: true });
        // No button for Fool's own (automatic) flip - the bar falls back
        // to the plain top-level set (nothing left to click for Fool's
        // own step, same as any other click-only stage) plus the decline
        // of AC (the card that WAS actually drawn), persisting bolded,
        // same as "Use Territory"/"Play Card" persists once chosen.
        expect(buttonValues(preview)).to.not.include("power_fool");
        expect(buttonValues(preview)).to.deep.equal(["use", "play", "orient", "discard", "pass", "declare", "decline_power"]);
        const rep = preview.render() as { areas?: { type: string; buttons?: { value?: string; label?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const declineBtn = bar.buttons!.find(b => b.value === "decline_power")!;
        expect(declineBtn.label).eq("Decline AC");
        expect(declineBtn.attributes).to.deep.equal([{ name: "font-weight", value: "bold" }]);
    });

    // Same message, computed directly by validateFrameStack itself now -
    // a hand-typed "decline AC (via 00)" gets DECLINE_THEN_AUTO_DRAW
    // without ever going through the click handler above.
    it("a hand-typed decline of a revealed card also names the automatic second flip", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use ${major(0).uid}`, { trusted: true });

        const validated = g.validateMove(`decline AC (via ${major(0).uid})`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).to.eq(1);
        expect(validated.message).to.eq(i18next.t("apgames:validation.gnostica.DECLINE_THEN_AUTO_DRAW"));
    });

    // Right after a real flip the status line is the generic "click a
    // button" wording (a Use/Decline pair is on the bar); clicking "Use
    // Card X" (resume_power) is what surfaces the revealed card's own
    // real instructions, naming it explicitly rather than forcing the
    // player to check the chat log.
    it("Fool's real flip: the Use Card click names the revealed card in the message", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use ${major(0).uid}`); // real, non-partial commit - actually flips
        expect(g.continued).to.not.be.empty;
        const acName = minorCards.find(c => c.uid === "AC")!.name;
        expect(g.validateMove("").message).to.eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));

        const resumed = g.handleClick("", -1, -1, "_btn_resume_power");
        expect(resumed.move).eq(`play AC (via ${major(0).uid})`);
        // A minor card's own synthesized primitive step is a fresh (step
        // 0) choice - CHOOSE_STEP is the right message key, now naming AC.
        expect(resumed.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: acName }));
    });

    // A resumed/pushed frame is never mandatory the way #49's ROOT-only
    // rule is - a bare-but-non-empty resume string must not fall back to
    // that root-only wording.
    it("validating a bare resume (no steps typed yet) names the revealed card, not the #49 root-only wording", () => {
        const g = setupFool();
        pluckCard(g, major(1).uid); // Magician
        g.drawPile.unshift(major(1).uid);
        g.move(`use ${major(0).uid}`, { trusted: true });

        const bare = g.validateMove(`play ${major(1).uid} (via ${major(0).uid})`);
        expect(bare.valid).to.be.true;
        expect(bare.complete).to.eq(-1);
        expect(bare.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: major(1).name }));
    });

    // Same, one click later - validateFrameStack's own "given segment is
    // still incomplete" fallback must not fall back to the root-only
    // wording either, e.g. once Fool reveals the Magician and Cups is
    // picked (suit chosen, mode not yet).
    it("validating a still-incomplete resumed step (a real segment given, but not enough of one) also names the card", () => {
        const g = setupFool();
        pluckCard(g, major(1).uid); // Magician
        g.drawPile.unshift(major(1).uid);
        g.move(`use ${major(0).uid}`, { trusted: true });

        const suitChosen = g.validateMove(`play ${major(1).uid}/m0.1 C (via ${major(0).uid})`); // suit picked, no mode yet
        expect(suitChosen.valid).to.be.true;
        expect(suitChosen.complete).to.eq(-1);
        expect(suitChosen.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: major(1).name }));
    });

    // Declining a revealed card's own power exposes Fool's own remaining
    // flip underneath (see walkFrameStack's own "lastWasExplicitDecline"
    // docs) - the click PREVIEW of that decline must recognize this as a
    // complete, submit-ready move (see reachedViaDecline's own docs), not
    // fall back to the generic top-level bar and a bare "Looks like a
    // valid move" message as if it were a fresh/mandatory activation.
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
        expect(targetClick.move).eq(`use ${theWorld().uid} as 00`); // the borrowed Fool named as "as", head arg unchanged
        expect(targetClick.valid).to.be.true;
        // World's own push is free, then Fool's own flip is next - forced,
        // one-shot, nothing to reconsider, genuinely complete:1.
        expect(targetClick.complete).to.eq(1);

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
        // World targeted the Fool and its flip fired; only the Fool's own
        // remaining obligation persists (the spent World and the revealed
        // card are not - see this.continued's docs).
        expect(real.continued).to.deep.equal(["00.1"]);
    });

    // Once genuinely paused (Fool's own reveal of a click-driven special,
    // here the World), the bar drops the ordinary 6 buttons entirely
    // (none legal - validateMove would reject every one with PENDING_
    // POWER_NEEDS_CONTINUE) and shows a self-contained Use/Decline pair
    // instead. Clicking "Use Card" surfaces the World's own real target
    // instructions; a direct board click still works too.
    it("Fool reveals World: the bar drops to a Use/Decline pair, and clicking Use gives real target instructions", () => {
        const g = setupFool();
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, 1, 0, () => major(1)); // a real target for World to use
        pluckCard(g, theWorld().uid);
        g.drawPile.unshift(theWorld().uid);
        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.deep.equal(["00.1"]);

        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));
        expect(buttonValues(g)).to.deep.equal(["resume_power", "decline_power"]);
        expect(g.handleClick("", -1, -1, "_btn_resume_power").message).eq(i18next.t("apgames:validation.gnostica.WORLD_CHOOSE_TARGET"));

        // A direct board click on the target still works too.
        const [rowN, colN] = rowColFor(g, 1, 0);
        const targetClick = g.handleClick("", rowN, colN);
        expect(targetClick.valid).to.be.true;
        expect(targetClick.move).eq(`play ${theWorld().uid} as ${major(1).uid} (via ${major(0).uid})`);
    });

    // Regression: Fool -> Hanged Man -> (Rods "piece" mode relocates the
    // acting minion) -> tradeHands auto-skips (no enemy) -> Fool's own
    // mandatory second flip reveals World, ALL in one submission (the
    // cascade this session's own earlier fixes made possible). World's
    // own frame inherits its "acting minion" from Fool's own buried frame
    // (see popFrame's own docs) - before that fix, it inherited Fool's
    // own ORIGINAL, pre-move position, which the relocated piece no
    // longer occupies at all; the first thing that tried to read a piece
    // there (a board click on World's own target) crashed outright
    // instead of failing gracefully. Also covers parsePendingStep's own,
    // separate copy of the same staleness bug (its own resume re-derives
    // eligibility from the ROOT card's own cell, which the acting piece
    // has since moved away from too).
    it("Fool -> Hanged Man (piece relocates) -> World: the relocated piece's CURRENT position survives, not its pre-move one", () => {
        const g = setupFool();
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // facing n0
        forceCardAt(g, 1, 0, () => major(5)); // Hierophant - the piece relocates onto n0, and it's also a real World target
        pluckCard(g, major(12).uid);
        g.drawPile.unshift(major(12).uid); // Fool's 1st flip reveals Hanged Man
        g.move(`use ${major(0).uid}`, { trusted: true });

        g.drawPile.unshift(theWorld().uid); // Fool's mandatory 2nd flip reveals World
        g.move(`play ${major(12).uid}/m0.1 piece m0.1 1 (via ${major(0).uid})`, { trusted: true }); // moves to n0; tradeHands auto-skips (no enemy)
        expect(g.continued).to.deep.equal(["00.2"]);
        // The staleness bug this guards is now structurally impossible:
        // buildPendingFromContinued recomputes minions fresh from the
        // board every time (see this.continued's own docs), so a resume
        // can never re-derive eligibility from a cell the acting piece has
        // moved away from.
        const [rowN, colN] = rowColFor(g, 1, 0);
        expect(() => g.handleClick("", rowN, colN)).to.not.throw();
        const targetClick = g.handleClick("", rowN, colN);
        expect(targetClick.valid).to.be.true;
        expect(targetClick.move).eq(`play ${theWorld().uid} as ${major(5).uid} (via ${major(0).uid})`);
    });

    it("chatLog() renders revealFlip/borrowPower lines, naming the actual card, not a bare uid", () => {
        addResource("en");
        const foolGame = setupFool();
        pluckCard(foolGame, "AC");
        foolGame.drawPile.unshift("AC");
        foolGame.move(`use ${major(0).uid}`, { trusted: true });
        const foolRows = foolGame.chatLog(["Alice", "Bob"]);
        const acName = minorCards.find(c => c.uid === "AC")!.name;
        expect(foolRows[foolRows.length - 1].some(line => line.includes(acName))).to.be.true;

        const worldGame = setupWorldLovers();
        worldGame.move(`use ${theWorld().uid} as ${major(6).uid}/m0.1 piece n0.1 1 U/o0.1 own o0 U`, { trusted: true });
        const worldRows = worldGame.chatLog(["Alice", "Bob"]);
        // cardDisplayName() adds the major-arcana numeral to the card's
        // own stored name as-is (e.g. "The Lovers (VI)").
        const lovers = `${major(6).name} (${major(6).romanNumeral})`;
        expect(worldRows[worldRows.length - 1].some(line => line.includes(lovers))).to.be.true;
    });

    // A pure decline pushes no board/state results of its own (see
    // walkFrameStack's own docs) - reused "announce" gives it a real chat
    // line anyway, so a turn that ends on a decline (nothing left to
    // auto-continue into) doesn't vanish from the log entirely.
    it("chatLog() also logs a pure decline, not just the deckDraw lines it may trigger", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        pluckCard(g, "AD");
        g.drawPile.unshift("AC");
        g.move(`use ${major(0).uid}`, { trusted: true });
        g.drawPile.unshift("AD");
        g.move(`decline AC (via ${major(0).uid})`, { trusted: true }); // auto-continues into the 2nd flip
        expect(g.continued).to.deep.equal(["00.2"]);
        g.move(`decline AD (via ${major(0).uid})`, { trusted: true }); // nothing left to auto-continue
        expect(g.continued).to.be.empty;
        const rows = g.chatLog(["Alice", "Bob"]);
        const adName = minorCards.find(c => c.uid === "AD")!.name;
        expect(rows[rows.length - 1].some(line => line.includes(adName))).to.be.true;
    });

    it("randomMove() sanity check: a paused activation always yields something validateMove() accepts", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.not.be.empty;
        const move = g.randomMove();
        expect(move).eq(`decline AC (via ${major(0).uid})`);
        expect(g.validateMove(move).valid).to.be.true;
        expect(() => g.move(move, { trusted: true })).to.not.throw();
    });

    // Regression: randomMove()'s own "paused activation" fallback used to
    // build "decline" unconditionally for ANY this.continued obligation -
    // wrong for High Priestess specifically, whose own round 2 rejects
    // "decline" outright (ACTION_NOT_ALLOWED - see validateMove's own
    // resume-head gate). "draw 0" is High Priestess's own always-legal
    // minimal resume instead.
    it("randomMove() never declines a persisted High Priestess obligation (ACTION_NOT_ALLOWED otherwise)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];
        g.move(`use ${major(2).uid}/${discardUid}`, { trusted: true }); // round 1
        expect(g.continued).to.deep.equal(["02.1"]); // round 2 owed

        expect(g.validateMove(`decline (via ${major(2).uid})`).message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "ACTION_NOT_ALLOWED" }));
        const move = g.randomMove();
        expect(move).eq(`discard/draw 0 (via ${major(2).uid})`);
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
        g.move("play 20/m0.1 20", { trusted: true });
        expect(g.hands[0]).to.include("20");
        expect(g.discardPile).to.not.include("20");
        expect(g.currplayer).eq(2);
    });

    // validatePlay must simulate cmdPlay's own discard-pile push, not just
    // its hand removal, so a power that reads discard pile CONTENTS (not
    // just count) - Judgement drawing the very card that was just played,
    // itself included - validates against the same discard pile a real
    // commit would actually see, for an ORDINARY (untrusted) player too.
    it("regression: playing Judgement and drawing itself back also validates correctly for an ordinary (untrusted) player", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        pluckCard(g, "20");
        g.hands[0] = g.hands[0].slice(0, 5);
        g.hands[0].push("20");
        g.discardPile.push("21");

        const move = "play 20/m0.1 20";
        const validated = g.validateMove(move);
        expect(validated.valid).to.be.true;
        expect(() => g.move(move)).to.not.throw(); // untrusted - the real client path
        expect(g.hands[0]).to.include("20");
        expect(g.currplayer).eq(2);
    });

    // Drawing/using a power is a UX convenience (#49), never a
    // rules requirement, and it never applies to a card Fool reveals -
    // Judgement's own draw has always been optional (0 cards is legal).
    // The player is also never responsible for foreseeing that a legal
    // choice will starve Fool's OWN mandatory next flip - drawing the
    // discard pile's only card (even Judgement itself) back into hand is
    // still just Judgement's own ordinary power, fully legal, and Fool's
    // subsequent flip finding nothing simply completes the whole Fool
    // activation there, gracefully - not an error, and not something
    // validation should reject in advance either.
    it("Judgement draws the discard pile's only card (itself) back, leaving nothing for Fool's mandatory second flip - completes gracefully", () => {
        const g = setupFool();
        const judgementUid = major(20).uid;
        g.drawPile = [];
        g.discardPile = [judgementUid]; // the only card anywhere in the game
        g.move(`use ${major(0).uid}`, { trusted: true });
        expect(g.continued).to.deep.equal(["00.1"]);
        g.hands[0].pop(); // make room for Judgement's own draw

        const move = `play ${judgementUid}/m0.1 ${judgementUid} (via ${major(0).uid})`;
        const validated = g.validateMove(move);
        expect(validated.valid).to.be.true;
        expect(validated.complete).to.eq(1); // a fully complete, submittable move - not rejected in advance

        g.move(move, { trusted: true });
        expect(g.hands[0]).to.include(judgementUid); // Judgement drew itself back
        expect(g.discardPile).to.be.empty;
        expect(g.drawPile).to.be.empty;
        expect(g.continued).to.be.empty; // Fool's own second flip found nothing and completed - no error, no pause
        expect(g.currplayer).eq(2); // the turn actually ended
    });

    // The two cases that stay hard rejections: activating Fool with
    // NOTHING anywhere to flip, before any commitment has been made at
    // all. "use" is simply a no-op the player should pass instead of
    // (a UX nudge, not a rules requirement - #49's own root-only scope).
    // "play" is the one genuinely irreversible case: playing Fool
    // discards its own physical card FIRST, which would let the very
    // next flip succeed by finding nothing but Fool itself, forever -
    // an unbounded self-reveal loop the player has no way out of, so
    // it stays blocked rather than "gracefully" handed to them.
    it("use/play 00 with nothing anywhere to flip yet are still rejected outright/not gracefully completed", () => {
        const use = setupFool();
        use.drawPile = [];
        use.discardPile = [];
        const useValidated = use.validateMove(`use ${major(0).uid}`);
        expect(useValidated.valid).to.be.false;
        expect(useValidated.message).to.eq(i18next.t("apgames:validation.gnostica.DRAW_PILE_EMPTY"));

        const play = new GnosticaGame(2);
        clearBoard(play);
        forceCardAt(play, 0, 0, () => major(3)); // any other major, so Fool stays in hand
        play.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        play.hands[0].push(major(0).uid);
        play.drawPile = [];
        play.discardPile = [];
        const playValidated = play.validateMove(`play ${major(0).uid}`);
        expect(playValidated.valid).to.be.false;
        expect(playValidated.message).to.eq(i18next.t("apgames:validation.gnostica.DRAW_PILE_EMPTY"));
        // A {trusted: true} caller is expected to have already validated,
        // same as every other legality check in this file - this guard
        // is validate-only by design, not mirrored in cmdPlay itself.
    });
});
