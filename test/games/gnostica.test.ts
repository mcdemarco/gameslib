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
import { MAJOR_ARCANA } from "../../src/games/gnostica/majorArcana";
import { testGame, TestPiece } from "./gnostica.testState";

// The it.skip tests below build boards by editing live state (never committed to the game's history), which the pending-step/validation walkers no longer see now that they clone() instead of cloneLive(); revisit with TODO #29.
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
// array.
const renderedHandUids = (g: GnosticaGame, player: number): string[] => {
    const rep = g.render().at(-1) as { areas?: { type: string; ownerMark?: number; pieces?: string[] }[] };
    const area = rep.areas?.find(a => a.type === "pieces" && a.ownerMark === player);
    return (area?.pieces ?? []).map(key => key.slice(1));
};

describe("Gnostica: setup", () => {
    it("deals 6 cards to each player, tiles a 3x3 grid with no duplicate uids, and stocks full stashes", () => {
        const g = new GnosticaGame(4);
        expect(g.hands.length).eq(4);
        for (const h of g.hands) {
            expect(h.length).eq(6);
        }
        const all: string[] = [...g.hands.flat(), ...g.drawPile];
        let territoryCount = 0;
        for (const [, , t] of g.board.entries()) {
            if (t.card !== undefined) {
                territoryCount++;
                all.push(t.card.uid);
            }
        }
        expect(territoryCount).eq(9);
        expect(all.length).eq(78);
        expect(new Set(all).size).eq(78); // no duplicate uids, nothing lost
        expect(g.drawPile.length).eq(78 - 9 - 6 * 4);
        expect(g.discardPile.length).eq(0);
        for (let p = 1; p <= 4; p++) {
            expect(g.stashes.get(p as 1 | 2 | 3 | 4)).to.deep.equal([5, 5, 5]);
        }
        expect(g.currplayer).eq(1); // player 1 is the starting player by definition
    });

    it("\"no-majors\" variant: no major arcana on the opening board, but they're still fully in the mix for hands and the draw pile", () => {
        const g = new GnosticaGame(4, ["no-majors"]);
        let territoryCount = 0;
        const all: string[] = [...g.hands.flat(), ...g.drawPile];
        for (const [, , t] of g.board.entries()) {
            if (t.card !== undefined) {
                territoryCount++;
                expect(t.card.major, `${t.card.uid} is a major arcana card on the opening board`).eq(false);
                all.push(t.card.uid);
            }
        }
        expect(territoryCount).eq(9);
        // No restriction on hands or the draw pile - every major is still somewhere in the mix.
        expect(all.length).eq(78);
        const majorUidsSeen = all.filter(uid => majorCards.some(c => c.uid === uid)).length;
        expect(majorUidsSeen).eq(majorCards.length); // every major arcana card is accounted for
    });
});

describe("Gnostica: hand sort order", () => {
    // Sort order is deliberately simple - handSortKey just reads position in allCards(), i.e.
    // [...minorCards, ...majorCards]: minors first (grouped by suit, ranked within it), then
    // majors by seq. A fresh, non-bidding hand is already dealt in this order; this checks it
    // survives (a) the bidding variant's own hand-order-preserving bid resolution, and (b) an
    // ordinary main-phase discard/draw.
    const inSortOrder = (uids: string[]): boolean => {
        const cards = uids.map(uid => majorCards.find(c => c.uid === uid) ?? minorCards.find(c => c.uid === uid)!);
        let seenMajor = false, lastSuitSeq = -Infinity, lastRankSeq = -Infinity, lastMajorSeq = -Infinity;
        for (const c of cards) {
            if (c.major) {
                if (seenMajor && c.rank.seq <= lastMajorSeq) return false;
                seenMajor = true;
                lastMajorSeq = c.rank.seq;
            } else {
                if (seenMajor) return false;
                if (c.suit.seq === lastSuitSeq && c.rank.seq <= lastRankSeq) return false;
                if (c.suit.seq < lastSuitSeq) return false;
                lastSuitSeq = c.suit.seq;
                lastRankSeq = c.rank.seq;
            }
        }
        return true;
    };

    it("a fresh non-bidding game renders hands already in sort order", () => {
        const g = new GnosticaGame(3);
        for (let p = 1; p <= g.numplayers; p++) {
            expect(inSortOrder(renderedHandUids(g, p))).to.be.true;
        }
    });

    it("survives a bid resolution (hand order untouched by the bid itself) and an ordinary discard/draw", () => {
        // major(21) (The World) is the highest-seq major - bidding it guarantees player 1 wins
        // outright, whatever player 2 holds.
        const g = testGame({ hands: [["2R", "21", "AC", "3C", "4C", "5C"], filler], phase: "bidding" });
        const beforeBid = [...g.hands[0]];
        g.move("bid 2"); // position 2 (still hand-order) is the major
        expect(g.hands[0]).to.deep.equal(beforeBid); // not pulled from hand until the round resolves
        g.move("bid 1"); // resolves - player 1's major wins
        expect(g.bidWinner).eq(1);
        expect(inSortOrder(renderedHandUids(g, 1))).to.be.true;

        const g2 = testGame({
            board: [{ x: 0, y: 0, uid: "AD", pieces: [[1, 1, "U"]] }, { x: 1, y: 0, uid: "AS", pieces: [[2, 1, "U"]] }],
            hands: [["5R", "01", "AC", "2C", "KS", "3D"], filler],
        });
        g2.move("discard 5R draw 1"); // draws back to 6
        expect(inSortOrder(renderedHandUids(g2, 1))).to.be.true;
    });
});

describe("Gnostica: new-card hand highlight", () => {
    type HandArea = { type: string; pieces?: string[]; label?: string };
    type RenderRep = { legend: Record<string, unknown>; areas?: HandArea[] };
    const isTinted = (rep: RenderRep, key: string): boolean => JSON.stringify(rep.legend[key]).includes('"flatten"');
    const player1HandArea = (rep: RenderRep): HandArea | undefined =>
        rep.areas?.find(a => a.type === "pieces" && a.pieces?.some(p => p.startsWith("c")));

    it("tags a newly drawn card once it's that player's turn again, and a real click on it still resolves", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "U"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "U"]] }],
            hands: [["AC", "2C", "3C", "4C", "5C", "6C"], filler], drawPile: ["7C"],
        });
        g.move("discard AC draw 1"); // player 1 discards AC, draws 7C back
        g.move("discard draw 0"); // player 2's turn - now back to player 1
        const rep = g.render().at(-1) as RenderRep;
        const handArea = player1HandArea(rep);
        const newKey = `c7C`;
        expect(handArea?.pieces).to.include(newKey);
        expect(isTinted(rep, newKey)).to.be.true;
        // A card that was already there before last turn stays untagged.
        expect(handArea?.pieces).to.include(`c2C`);
        expect(isTinted(rep, `c2C`)).to.be.false;
        const seeded = g.handleClick("", -1, -1, "_btn_discard");
        const click = g.handleClick(seeded.move, -1, -1, newKey);
        expect(click.valid).to.be.true;
        expect(click.move).eq(`discard 7C`);
    });

    it("shows no highlight on a player's first turn, or once they start building this turn's own move", () => {
        const fresh = new GnosticaGame(2);
        const freshRep = fresh.render().at(-1) as RenderRep;
        expect(player1HandArea(freshRep)?.pieces?.some(p => isTinted(freshRep, p))).to.be.false;

        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "U"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "U"]] }],
            hands: [["AC", "2C", "3C", "4C", "5C", "6C"], filler], drawPile: ["7C"],
        });
        g.move("discard AC draw 1");
        g.move("discard draw 0");
        const before = g.render().at(-1) as RenderRep;
        expect(isTinted(before, `c7C`)).to.be.true; // sanity - not vacuous
        g.move("discard", { partial: true }); // simulates the player's own first click
        const after = g.render().at(-1) as RenderRep;
        expect(player1HandArea(after)?.pieces?.some(p => isTinted(after, p))).to.be.false;
    });
});

describe("Gnostica: place / orient", () => {
    it("places a small piece, drawn from stash, orientation an explicit part of the move (U included)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 E");
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "E" });
        expect(g.stashes.get(1)).to.deep.equal([4, 5, 5]);
    });

    it("refuses to place a second time, in the void, or on an already-occupied cell", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place n0 U"); // player 2
        expect(g.validateMove("place l0 U").message).eq(i18next.t("apgames:validation.gnostica.ALREADY_ON_BOARD")); // player 1 already placed
        expect(new GnosticaGame(2).validateMove("place a50 U").message).eq(i18next.t("apgames:validation.gnostica.PLACE_VOID", { cell: "a50" })); // far outside the 3x3 grid - void
        const g2 = new GnosticaGame(2);
        g2.move("place m0 U");
        expect(g2.validateMove("place m0 U").message).eq(i18next.t("apgames:validation.gnostica.PLACE_OCCUPIED", { cell: "m0" })); // occupied cell
    });

    it("reorients your own piece, but not an opponent's, and requires having placed first", () => {
        const g = new GnosticaGame(2);
        expect(g.validateMove("discard").message).eq(i18next.t("apgames:validation.gnostica.MUST_PLACE_FIRST")); // nothing placed yet
        g.move("place m0 N"); // player 1
        g.move("place n0 U"); // player 2
        g.move("orient m0.1 W"); // player 1 reorients their own piece, ending their turn
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("W");
        expect(g.validateMove("orient m0.1 N").message).eq(i18next.t("apgames:validation.gnostica.NOT_YOUR_MINION")); // now player 2's turn - can't touch player 1's piece
    });
});

describe("Gnostica: discard", () => {
    it("discards named cards and redraws exactly as many as asked, up to the room left in a 6-card hand", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place n0 U");
        const [discard1, discard2] = g.hands[0];
        g.move(`discard ${discard1} ${discard2} draw 1`); // player 1: not the max
        expect(g.hands[0].length).eq(5); // 4 left after discarding 2, +1 drawn back
        expect(g.hands[0]).to.not.include(discard1);
        expect(g.discardPile).to.include(discard1);
        expect(g.discardPile).to.include(discard2);
    });

    it("\"discard draw 0\" is a legal no-op turn", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place n0 U");
        const before = [...g.hands[0]];
        g.move("discard draw 0");
        expect(g.hands[0]).to.deep.equal(before);
    });

    it("refuses a card not in hand, a draw above what was discarded, or a negative/non-numeric draw count", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place n0 U");
        const notInHand = g.drawPile.find(uid => !g.hands[0].includes(uid))!;
        expect(g.validateMove(`discard ${notInHand}`).message).eq(i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid: notInHand }));
        expect(g.validateMove(`discard ${g.hands[0][0]} draw 2`).message).eq(i18next.t("apgames:validation.gnostica.BAD_DRAW_COUNT", { requested: "2", max: 1 })); // only 1 discarded
        // A negative or non-numeric draw count isn't even grammatically a valid "draw <n>" token - rejected by parseMove itself, before checkDiscardDraw's own range check ever runs.
        expect(g.validateMove("discard draw -1").message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_DRAW_COUNT" }));
        expect(g.validateMove("discard draw abc").message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_DRAW_COUNT" }));
    });
});

describe("Gnostica: turn order / legend", () => {
    type KeyArea = { type: string; list?: { piece: string; name: string }[] };
    const keyArea = (g: GnosticaGame): KeyArea | undefined =>
        (g.render().at(-1) as { areas?: KeyArea[] }).areas?.find(a => a.type === "key");

    it("advances currplayer around the table and back", () => {
        const g = new GnosticaGame(3);
        expect(g.currplayer).eq(1);
        g.move("place m0 U");
        g.move("place l0 U");
        g.move("place n0 U");
        expect(g.currplayer).eq(1);
        g.move("discard draw 0");
        g.move("discard draw 0");
        g.move("discard draw 0");
        expect(g.currplayer).eq(1);
    });

    it("the turn-order legend appears for any bidding game (2+ players), never for a non-bidding one with nothing active, and reorders to bid rank once it resolves", () => {
        expect(keyArea(new GnosticaGame(3))).to.be.undefined; // non-bidding, nothing active
        expect(keyArea(new GnosticaGame(2, ["bidding"]))!.list!.map(e => e.name)).to.deep.equal(["1st", "2nd"]); // now shown even at 2 players
        const fresh = new GnosticaGame(3, ["bidding"]);
        expect(keyArea(fresh)!.list!.map(e => e.name)).to.deep.equal(["1st", "2nd", "3rd"]); // plain order mid-bid

        const g = testGame({
            hands: [["KS", "AC", "2C", "3C", "4C", "5C"], ["21", "AR", "2R", "3R", "4R", "5R"], ["QS", "AD", "2D", "3D", "4D", "5D"]],
            phase: "bidding",
        });
        g.move("bid 1"); g.move("bid 1"); g.move("bid 1"); // player 2's World (unbeatable) wins
        expect(g.bidWinner).eq(2);
        // Winner first, then King (player 1) over Queen (player 3) among the minors - not seating order.
        expect(keyArea(g)!.list!.map(e => e.piece)).to.deep.equal(["turnorder_p2", "turnorder_p1", "turnorder_p3"]);
    });

    it("appends the active card's own icons (unlabeled) after the turn-order rows - one per power for a major, the suit glyph for a minor - and follows a chain onto the active card, not the root", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "03", pieces: [[1, 2, "E"]] }], // The Empress: orientMinion, then create - 2 powers
            hands: [filler, filler],
            variants: ["bidding"],
        });
        g.move("use 03/orient m0.2 N", { partial: true });
        const area = keyArea(g)!;
        expect(area.list!.slice(0, 2).map(e => e.name)).to.deep.equal(["1st", "2nd"]); // turn-order rows still first
        const iconRows = area.list!.slice(2);
        expect(iconRows.length).eq(2); // one row per Empress power
        expect(iconRows.every(e => e.name === "")).to.be.true; // no labels

        // A minor's own single suit glyph, and no key at all once nothing is active (non-bidding, here).
        const minor = testGame({ board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }], hands: [filler, filler] });
        expect(keyArea(minor)).to.be.undefined; // non-bidding, nothing active yet
        minor.move("use AC", { partial: true });
        expect(keyArea(minor)!.list!.length).eq(1); // no turn-order rows (non-bidding) - just the one suit icon
    });
});

describe("Gnostica: bidding-variant player reordering and pass removal", () => {
    it("beginRedraw() lands directly on the bid's loser, whichever player wins, with no forced pass in between", () => {
        const winner1 = testGame({ hands: [["21", "AC", "2C", "3C", "4C", "5C"], ["KS", "AR", "2R", "3R", "4R", "5R"]], phase: "bidding" });
        winner1.move("bid 1"); winner1.move("bid 1"); // player 1's World wins
        expect(winner1.bidWinner).eq(1);
        expect(winner1.currplayer).eq(2); // loser redraws first
        expect(winner1.getPlies().some(p => p.results.some(r => r.type === "pass"))).eq(false);

        const winner2 = testGame({ hands: [["KS", "AC", "2C", "3C", "4C", "5C"], ["21", "AR", "2R", "3R", "4R", "5R"]], phase: "bidding" });
        winner2.move("bid 1"); winner2.move("bid 1"); // player 2's World wins
        expect(winner2.bidWinner).eq(2);
        expect(winner2.currplayer).eq(1);
        expect(winner2.getPlies().some(p => p.results.some(r => r.type === "pass"))).eq(false);
    });

    it("moves()/validateMove()/randomMove() no longer offer or accept \"pass\" during bidding/redraw", () => {
        const g = testGame({ hands: [["21", "AC", "2C", "3C", "4C", "5C"], ["KS", "AR", "2R", "3R", "4R", "5R"]], phase: "bidding" });
        g.move("bid 1"); g.move("bid 1");
        expect(g.phase).eq("redraw");
        expect(g.moves()).to.deep.equal([]);
        expect(g.validateMove("pass").valid).to.be.false;
        expect(g.randomMove()).to.not.eq("pass");
    });

    for (const numplayers of [2, 3] as const) {
        it(`turnOrder reorder (${numplayers}p): getPlies()/chatLog() stay correct across the bid resolution boundary`, () => {
            addResource("en");
            const hands = [["KS", "AC", "2C", "3C", "4C", "5C"], ["21", "AR", "2R", "3R", "4R", "5R"], ["QS", "AD", "2D", "3D", "4D", "5D"]].slice(0, numplayers);
            const g = testGame({ board: [{ x: 0, y: 0, uid: "2R" }], hands, phase: "bidding" });
            for (let i = 0; i < numplayers; i++) {
                g.move("bid 1");
            }
            expect(g.bidWinner).eq(2);
            for (let i = 0; i < numplayers; i++) {
                const needed = 6 - g.hands[g.currplayer - 1].length;
                g.move(`redraw ${g.biddingPool!.slice(0, needed).join(" ")}`);
            }
            expect(g.currplayer).eq(2); // winner goes first
            g.move("place m0 U");
            const names = numplayers === 2 ? ["Alice", "Bob"] : ["Alice", "Bob", "Carol"];
            expect(g.chatLog(names)[g.getPlies().length - 1].some(l => l.includes("Bob"))).eq(true);
        });
    }
});

describe("Gnostica: announce last turn / win / elimination", () => {
    it("wins on the announcing player's following turn if they reached the target, rotating currplayer past the winner", () => {
        // Player 1 stands, uncontested, on three majors (9 pts); player 2 just needs a placement of their own.
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "21", pieces: [[1, 1, "U"]] },
                { x: 1, y: 0, uid: "19", pieces: [[1, 1, "U"]] },
                { x: -1, y: 0, uid: "13", pieces: [[1, 1, "U"]] },
                { x: 0, y: 1, uid: "AR", pieces: [[2, 1, "U"]] },
            ],
            hands: [filler, filler],
        });
        expect(g.getPlayerScore(1)).eq(9);
        g.move("discard draw 0 last"); // player 1 announces
        expect(g.lastTurner).eq(1);
        g.move("discard draw 0"); // player 2
        g.move("discard draw 0"); // player 1's resolving turn - wins
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([1]);
        expect(g.currplayer).eq(2); // still rotates on the winning move itself
    });

    it("eliminates the announcer if they fall short, discarding their hand and returning their piece to stash, without ending the game", () => {
        const g = new GnosticaGame(3); // each player's lone piece scores <= 3, always short of 9
        g.move("place m0 U"); g.move("place l0 U"); g.move("place n0 U");
        const hand = [...g.hands[0]];
        g.move("discard draw 0 last"); // player 1 announces
        expect(g.validateMove("discard draw 0 last").message).eq(i18next.t("apgames:validation.gnostica.ALREADY_ANNOUNCED")); // player 2 may not also announce
        g.move("discard draw 0"); g.move("discard draw 0");
        g.move("discard draw 0"); // player 1's resolving turn - falls short
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.hands[0]).to.deep.equal([]);
        expect(g.gameover).eq(false); // players 2 and 3 remain
        for (const uid of hand) {
            expect(g.discardPile).to.include(uid);
        }
        expect(g.board.get(0, 0)!.pieces.some(p => p.owner === 1)).eq(false);
        expect(g.stashes.get(1)).to.deep.equal([5, 5, 5]);
        // An eliminated player's own randomMove() is still a real, committable "pass" that
        // correctly re-skips them, even if asked again on a later, stale turn.
        g.currplayer = 1;
        const rm = g.randomMove();
        expect(rm).eq("pass");
        expect(g.validateMove(rm).valid).to.be.true;
        g.move(rm); // untrusted, exactly like a real client
        expect(g.currplayer).eq(2);
    });

    it("declares the sole survivor the winner if elimination leaves only one player standing", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); g.move("place n0 U");
        g.move("discard draw 0 last"); g.move("discard draw 0");
        g.move("discard draw 0"); // player 1 falls short, eliminated
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([2]);
    });

    // Player 1 holds three majors/royalty worth exactly the named total; player 2 is uninvolved.
    for (const [variant, thirdCardUid, total, expectWin] of [["target-8", "KC", 8, true], ["target-10", "13", 9, false]] as const) {
        it(`"${variant}" variant moves the win threshold (here, a score of ${total})`, () => {
            const g = testGame({
                board: [
                    { x: 0, y: 0, uid: "21", pieces: [[1, 1, "U"]] }, // The World, 3 pts
                    { x: -1, y: 0, uid: "19", pieces: [[1, 1, "U"]] }, // The Sun, 3 pts
                    { x: 1, y: 0, uid: thirdCardUid, pieces: [[1, 1, "U"]] },
                    { x: -1, y: -1, uid: "AR", pieces: [[2, 1, "U"]] },
                ],
                hands: [filler, filler],
                variants: [variant],
            });
            expect(g.getPlayerScore(1)).eq(total);
            g.move("discard draw 0 last");
            g.move("discard draw 0");
            g.move("discard draw 0");
            expect(g.gameover).eq(true);
            expect(g.winner).to.deep.equal(expectWin ? [1] : [2]);
        });
    }

    it("getPlies()/chatLog() attribute the elimination and the following turn to the right actors, using the result's own r.who", () => {
        addResource("en");
        const g = new GnosticaGame(3);
        g.move("place m0 U"); g.move("place l0 U"); g.move("place n0 U");
        g.move("discard draw 0 last"); g.move("discard draw 0"); g.move("discard draw 0");
        g.move("discard draw 0"); // player 1 falls short, eliminated
        g.move("discard draw 0"); // player 2's ordinary post-elimination turn
        const plies = g.getPlies();
        const actorsAfterElimination = plies.slice(plies.findIndex(p => p.results.some(r => r.type === "eliminated")) + 1).map(p => p.actor);
        expect(actorsAfterElimination).to.not.include(1); // nextPlayer()'s skip loop, agreeing with plyActor()
        const log = g.chatLog(["Alice", "Bob", "Carol"]);
        const eliminatedLine = log.find(node => node.some(l => l.includes("eliminated")));
        expect(eliminatedLine?.some(l => l.includes("Alice"))).eq(true); // the actual actor, not currplayer's later value
        expect(log[log.length - 1].some(l => l.includes("Bob"))).eq(true);
    });

    // Regression: a "last" declared on a move that itself leaves `continued` open (e.g. the
    // High Priestess's own second discard round) used to vanish entirely - move()'s tail only
    // ever committed it once the WHOLE turn's chain closed, which never ran on a still-open
    // sub-move. A "last" marker riding at the front of this.continued stages it across such
    // sub-moves without letting the chain's own closing sub-move (still the declaring turn
    // itself) be mistaken for the declarer's later, genuine return turn.
    it("a 'last' declared on a move that leaves continued open (High Priestess) still lands, and only wins on the declarer's later return turn, not the same turn's own closing sub-move", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, 1, 0, () => major(21)); // The World, 3 pts
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, -1, 0, () => major(19)); // The Sun, 3 pts
        g.board.get(-1, 0)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, 0, 1, () => major(13)); // Death, 3 pts
        g.board.get(0, 1)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, 0, -1, () => aceOfDiscs());
        g.board.get(0, -1)!.pieces = [new Piece(2, 1, "U")]; // player 2's own piece, so they can act
        expect(g.getPlayerScore(1)).eq(12); // 4 majors (including the High Priestess itself) - comfortably past the 9-point target

        for (const uid of ["2C", "5C", "AR"]) {
            for (const hand of g.hands) {
                const idx = hand.indexOf(uid);
                if (idx !== -1) hand.splice(idx, 1);
            }
            let idx = g.drawPile.indexOf(uid);
            if (idx !== -1) g.drawPile.splice(idx, 1);
            idx = g.discardPile.indexOf(uid);
            if (idx !== -1) g.discardPile.splice(idx, 1);
        }
        g.hands[0] = ["2C", "5C", "AR"];

        g.move("use 02/discard 5C draw 4 last"); // player 1 declares mid-chain
        expect(g.continued).to.not.be.empty;
        expect(g.lastTurner).to.be.undefined; // not yet locked in - the turn's chain isn't closed
        expect(g.continued).to.include("last");

        g.move("discard AR draw 1 via 02"); // resolves the High Priestess's own chain, same turn
        expect(g.continued).to.be.empty;
        expect(g.lastTurner).eq(1); // now locked in
        expect(g.gameover).eq(false); // still just the declaring turn's own close, not the "following turn" yet
        expect(g.currplayer).eq(2);

        g.move("discard draw 0"); // player 2's ordinary turn
        g.move("discard draw 0"); // player 1's return turn (the reported "Pass" click) - now wins
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([1]);
    });

    // A "last" can be declared on ANY sub-move of a still-open chain, not just its first - including the very
    // sub-move that closes the chain, which must still wait for the player's later return turn to check the score.
    it("a 'last' declared on the closing sub-move of a continued chain (not the first) still only wins on the later return turn", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, 1, 0, () => major(21)); // The World, 3 pts
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, -1, 0, () => major(19)); // The Sun, 3 pts
        g.board.get(-1, 0)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, 0, 1, () => major(13)); // Death, 3 pts
        g.board.get(0, 1)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, 0, -1, () => aceOfDiscs());
        g.board.get(0, -1)!.pieces = [new Piece(2, 1, "U")]; // player 2's own piece, so they can act

        for (const uid of ["2C", "5C", "AR"]) {
            for (const hand of g.hands) {
                const idx = hand.indexOf(uid);
                if (idx !== -1) hand.splice(idx, 1);
            }
            let idx = g.drawPile.indexOf(uid);
            if (idx !== -1) g.drawPile.splice(idx, 1);
            idx = g.discardPile.indexOf(uid);
            if (idx !== -1) g.discardPile.splice(idx, 1);
        }
        g.hands[0] = ["2C", "5C", "AR"];

        g.move("use 02/discard 5C draw 4"); // player 1 opens the High Priestess round - no declare yet
        expect(g.continued).to.not.include("LAST");

        g.move("discard AR draw 1 via 02 last"); // declares on the CLOSING sub-move instead
        expect(g.continued).to.be.empty;
        expect(g.lastTurner).eq(1); // locked in immediately - this same call already closed the chain
        expect(g.gameover).eq(false); // still the declaring turn itself, not the "following turn" yet
        expect(g.currplayer).eq(2);

        g.move("discard draw 0"); // player 2's ordinary turn
        g.move("discard draw 0"); // player 1's return turn - now wins
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([1]);
    });
});

describe("Gnostica: sidebarScores", () => {
    it("reports each player's score, position i always player i+1's - never reordered by turn order", () => {
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }, // spot, 1 pt
                { x: -1, y: 0, uid: "KS", pieces: [[2, 1, "U"]] }, // royalty, 2 pts
                { x: 1, y: 0, uid: "21", pieces: [[3, 1, "U"]] }, // major, 3 pts
            ],
            hands: [filler, filler, filler],
        });
        const scores = g.sidebarScores();
        expect(scores).to.have.length(1);
        expect(scores[0].scores).to.deep.equal([1, 2, 3]);
        expect(scores[0].scores).to.deep.equal([g.getPlayerScore(1), g.getPlayerScore(2), g.getPlayerScore(3)]);
    });
});

// Minimal 2-player boards for the minor-arcana suit-power tests below - real cards, seeded via
// testGame() (TODO #107) rather than forced onto a live, randomly-dealt game. Filler hand cards
// are unrelated spot cards, present only so a hand isn't suspiciously empty.
const filler = ["2R", "3R", "4R", "5D", "6D", "7D"];

describe("Gnostica: activate/play - minor arcana suit powers", () => {
    it("Cups (own): adds an own small piece to the target cell", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "E"]] }],
            hands: [filler, filler],
        });
        g.move(`use AC/with m0.1 at n0 create U`);
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
        expect(g.stashes.get(1)![0]).eq(4); // the piece at m0 already accounted for one
    });

    it("Cups (enemy): adds a copy of a targeted enemy's small piece from THEIR stash", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 1, "W"]] }],
            hands: [filler, filler],
        });
        g.move(`use AC/with m0.1 at n0 create n0.1`);
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
        expect(g.stashes.get(2)![0]).eq(4); // player 2's stash, not player 1's
    });

    it("Cups (new): creates a territory on a wasteland from a hand card", () => {
        const spotUid = "2S";
        const g = testGame({
            board: [{ x: -1, y: 0, uid: "AC", pieces: [[1, 1, "W"]] }],
            hands: [[spotUid, ...filler], filler],
        });
        g.move(`use AC/with l0.1 at k0 create ${spotUid}`);
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): moves the minion itself and reorients it", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "E"]] }],
            hands: [filler, filler],
        });
        g.move(`use AR/with m0.1 move m0.1 1 orient N`);
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, orientation: "N" });
    });

    // Also the real gameplay counterpart to the bare-board "keeps two genuinely separate
    // multi-cell clusters classified correctly" unit test in gnostica.board.test.ts (identical
    // geometry, fromX=1/toX=4): that test calls board.pushTerritory() directly, skipping turns
    // and validateMove() entirely. This version drives the exact same push through a real
    // player's "use" move, and checks the OTHER player's own, disconnected cluster stays usable.
    it("Rods (tile): a push across a genuine void gap validates and applies correctly, and both disconnected clusters stay independently usable", () => {
        const g = testGame({
            board: [
                { x: -1, y: 0, uid: "2C" }, // cluster A
                { x: 0, y: 0, uid: "AR", pieces: [[1, 3, "E"]] }, // cluster A, the acting minion
                { x: 1, y: 0, uid: "KS" }, // the isolated card to be pushed
                { x: 5, y: 0, uid: "2D", pieces: [[2, 1, "U"]] }, // cluster B, far away
            ],
            hands: [filler, filler],
        });
        const pushMove = `use AR/with m0.3 move n0 3`;
        expect(g.validateMove(pushMove).valid).to.be.true; // through real validation, not a trusted bypass
        g.move(pushMove);
        // Cluster A: unaffected. Departure cell: reverted to wasteland, still adjacent to m0.
        expect(g.board.classify(-1, 0)).eq("territory");
        expect(g.board.classify(0, 0)).eq("territory");
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.classify(1, 0)).eq("wasteland");
        // The gap: genuinely disconnected from either cluster.
        expect(g.board.classify(2, 0)).eq("void");
        expect(g.board.classify(3, 0)).eq("wasteland"); // adjacent to the arrived card at q0
        // Arrival: a brand new 2-cell cluster with cluster B's pre-existing card.
        expect(g.board.classify(4, 0)).eq("territory");
        expect(g.board.get(4, 0)!.card?.uid).eq("KS");
        expect(g.board.classify(5, 0)).eq("territory");
        // Cluster B stays independently valid for its own owner, unaffected by the push.
        expect(g.currplayer).eq(2);
        expect(g.validateMove(`use 2D`).valid).to.be.true;
    });

    it("Discs (piece): grows the minion by one size, and rejects a step spelled as the wrong verb", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AD", pieces: [[1, 1, "U"]] }],
            hands: [filler, filler],
        });
        expect(g.validateMove(`use AD/with m0.1 move m0.1 1`).valid).to.be.false; // wrong verb, rejected outright
        g.move(`use AD/with m0.1 grow m0.1 orient N`);
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2, orientation: "N" });
    });

    it("Discs (tile): grows the pointed-at territory's value by one, discarding the old card", () => {
        const royaltyUid = "KS"; // worth 2
        const oldUid = "2C"; // worth 1
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AD", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: oldUid }],
            hands: [[royaltyUid, ...filler], filler],
        });
        g.move(`use AD/with m0.1 grow n0 to ${royaltyUid}`);
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("Swords (piece): shrinks a targeted enemy piece to destruction, returning it to their stash", () => {
        const g = testGame({
            // n0 has no card of its own - the targeted piece just stands on a wasteland.
            board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, pieces: [[2, 1, "W"]] }],
            hands: [filler, filler],
            stashes: { 1: [5, 5, 5], 2: [4, 5, 5] }, // player 2 already has one piece down, at n0
        });
        g.move(`use AS/with m0.1 shrink n0.1 1`);
        // pruneIfEmpty deletes a cardless cell outright once its last piece is gone.
        expect(g.board.get(1, 0)?.pieces.length ?? 0).eq(0);
        expect(g.stashes.get(2)![0]).eq(5); // destruction returns it
    });

    it("Swords (tile): shrinks the acting player's own uncontested territory's value", () => {
        const oldUid = "KS"; // worth 2
        const spotUid = "2S"; // worth 1
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 1, "W"]] }, { x: -1, y: 0, uid: oldUid }],
            hands: [[spotUid, ...filler], filler],
        });
        g.move(`use AS/with m0.1 shrink l0 1 to ${spotUid}`);
        expect(g.board.get(-1, 0)!.card?.uid).eq(spotUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("play: uses a hand card's power through any of the player's board pieces, then discards it", () => {
        const cupsUid = "2C";
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "U"]] }],
            hands: [[cupsUid, ...filler], filler],
        });
        // The minion at m0 points "U", so it can only target its own cell.
        g.move(`play ${cupsUid}/with m0.1 at m0 create U`);
        expect(g.hands[0]).to.not.include(cupsUid);
        expect(g.discardPile).to.include(cupsUid);
        expect(g.board.get(0, 0)!.pieces.length).eq(2);
        expect(g.board.get(0, 0)!.pieces[1]).to.deep.include({ owner: 1, size: 1 });
    });

    it("refuses to use a uid that isn't a real card, one that isn't on the board, or a card the player has no minion on", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 1, "U"]] }],
            hands: [filler, filler],
            drawPile: ["AS"], // a real card, deliberately not placed on the board
        });
        // "ZZ" isn't even grammatically a valid card-uid token - rejected by parseMove itself, before validateActivate's own UNKNOWN_CARD check ever runs.
        expect(g.validateMove("use ZZ").message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_CARD_ID" })); // not a real card uid
        expect(g.validateMove(`use AS`).message).eq(i18next.t("apgames:validation.gnostica.CARD_NOT_ON_BOARD", { uid: "AS" })); // real card, but not on the board
        expect(g.validateMove(`use AR`).message).eq(i18next.t("apgames:validation.gnostica.NO_MINIONS_THERE", { uid: "AR" })); // player 1 has no minion at n0
    });

    it("refuses to USE World's power against a malformed target", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "21", pieces: [[1, 1, "U"]] }],
            hands: [filler, filler],
        });
        // "C" isn't a valid token in this grammar slot at all - rejected by parseMove itself, before checkWorldChoosePower's own NO_SUCH_MAJOR_ON_BOARD check ever runs.
        expect(g.validateMove(`use 21/with m0.1 C own m0 U`).message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_OTHERWORD" }));
    });
});

describe("Gnostica: activate/play - major arcana chaining", () => {
    it("Lovers (move, then create): a pushed own piece becomes a minion for the second step, and both steps' own chat lines and frame history are right", () => {
        addResource("en");
        // A (m0) pushes B (n0) one space east to o0, reorienting it "U";
        // B, now at o0, is used for the Cups step to add a second piece there.
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "06", pieces: [[1, 1, "E"]] }, // The Lovers
                { x: 1, y: 0, uid: "AD", pieces: [[1, 1, "S"]] }, // own piece B, already on n0
            ],
            hands: [filler, filler],
        });
        g.move(`use 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U`);
        const dest = g.board.get(2, 0)!; // o0
        expect(dest.pieces.length).eq(2);
        expect(dest.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" }); // B, pushed and reoriented
        expect(dest.pieces[1]).to.deep.include({ owner: 1, size: 1, orientation: "U" }); // new piece from the Cups step

        // A genuine 2-step chain: a frame before each step (the first is the starting board), plus the final/live rep.
        expect(g.frames.length).eq(2);
        expect(g.frames[0].board.get(2, 0)).eq(undefined); // the starting board
        expect(g.frames[1].board.get(2, 0)?.pieces.length).eq(1); // B pushed here, Cups step not yet applied
        const reps = g.render() as { annotations?: { type: string }[] }[];
        expect(reps.length).eq(3);
        // Each rep's annotations cover only the step that led to it: none for the starting board, the push for the
        // next, and the live rep shows the last step's own effect.
        expect(reps[0].annotations).eq(undefined);
        expect(reps[1].annotations?.map(a => a.type)).to.deep.equal(["move"]);
        expect(reps[2].annotations?.map(a => a.type)).to.deep.equal(["enter"]);
        // Confirms results really are grouped (one _group per step, not flat), and chatLog()
        // logs a line for each step of the chain.
        expect(g.results.filter(r => r.type === "_group")).to.have.length(2);
        const lastNode = g.chatLog(["Alice", "Bob"])[g.getPlies().length - 1];
        expect(lastNode.some(l => l.includes("moved"))).eq(true); // step 1 (rod-piece)
        expect(lastNode.some(l => l.includes("added"))).eq(true); // step 2 (cups-own)
    });

    // validateMove() itself never mutates the board, so a later step naming the exact minion an
    // earlier step in this SAME chain just moved must still resolve correctly for an untrusted
    // caller - also checks that frame history captures the intermediate (post-step-1) position.
    it("Chariot (move, then move): an untrusted move validates and applies when step 2 acts through step 1's own relocated piece", () => {
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "07", pieces: [[1, 1, "E"]] }, // The Chariot: move, then move
                { x: 3, y: 0, uid: "AD" }, // keeps o0 (2,0) a genuine wasteland, not void
            ],
            hands: [filler, filler],
        });
        // No trailing orientation on either step - the minion never changes facing (stays E
        // throughout), and a same-facing "E" would now be a hard-rejected no-op.
        const move = `use 07/with m0.1 move m0.1 1/with n0.1 move n0.1 1`;
        expect(g.validateMove(move).valid).to.be.true;
        expect(() => g.move(move, { trusted: false })).to.not.throw();
        const dest = g.board.get(2, 0)!; // o0
        expect(dest.pieces.length).eq(1);
        expect(dest.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "E" });
        expect(g.board.has(1, 0)).eq(false); // the waypoint at n0 is left empty

        // Frame 1 shows the piece at its intermediate (post-first-move) position, n0 - not yet o0.
        expect(g.frames.length).eq(2);
        expect(g.frames[0].board.get(0, 0)?.pieces.length).eq(1); // the starting board
        expect(g.frames[1].board.get(1, 0)?.pieces.length).eq(1);
        expect(g.frames[1].board.get(2, 0)).eq(undefined);
    });

    // Direct, low-level coverage for chainMinion itself: a relocation prunes its own pre-mutation
    // ref (never left dangling as a second, still-live candidate), while a genuine creation is
    // purely additive (both the acting piece and the new one stay real, independent candidates).
    it("chainMinion: a relocation replaces its own pre-move ref; a creation is purely additive; no outcome leaves the pool unchanged", () => {
        const chainMinion = (GnosticaGame as unknown as {
            chainMinion: (minions: { x: number; y: number; index: number }[], outcome: { newMinion?: { x: number; y: number; index: number }; replacesMinion?: { x: number; y: number; index: number } }) => { x: number; y: number; index: number }[];
        }).chainMinion;

        const original = [{ x: 0, y: 0, index: 0 }];
        // Relocation (Rods' move, Discs' grow, Swords' shrink, Hierophant's replace, Hermit's
        // teleport, orientMinion/orientAny's reorient all set replacesMinion) - the old ref is gone.
        expect(chainMinion(original, { newMinion: { x: 1, y: 0, index: 0 }, replacesMinion: { x: 0, y: 0, index: 0 } }))
            .to.deep.equal([{ x: 1, y: 0, index: 0 }]);
        // Creation (Cups' own "create" modes - the only newMinion producer that never sets
        // replacesMinion) - both the original piece and the new one remain independent candidates.
        expect(chainMinion(original, { newMinion: { x: 2, y: 0, index: 0 } }))
            .to.deep.equal([{ x: 0, y: 0, index: 0 }, { x: 2, y: 0, index: 0 }]);
        // No outcome at all (judgementDraw, a skipped step, etc.) - the pool is unchanged.
        expect(chainMinion(original, {})).to.deep.equal(original);
    });

    it("Strength: a single grow may skip straight from spot to major arcana (skipLadder), and doing so uses up both grows", () => {
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "08", pieces: [[1, 1, "E"]] }, // Strength
                { x: 1, y: 0, uid: "AC" }, // n0 - spot, worth 1
            ],
            hands: [["00", ...filler], filler], // The Fool, worth 3
        });
        expect(g.validateMove(`use 08/with m0.1 grow n0 to 00`)).to.deep.include({ valid: true, complete: 1 });
        g.move(`use 08/with m0.1 grow n0 to 00`); // only ONE of Strength's two grow steps needed
        expect(g.board.get(1, 0)!.card?.uid).eq("00");
        expect(g.validateMove(`use 08/with m0.1 grow m0.1`).valid).to.be.false; // already consumed
    });

    describe("two-step shortcuts need the paired second step, on the same piece", () => {
        const setupStrength = (): GnosticaGame => testGame({
            board: [{ x: 0, y: 0, uid: "08", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }],
            hands: [filler, filler],
        });

        it("Strength: a lone grow only earns the waiver with its second step - without a size-2 in stash it stays incomplete; with one, exact stash accounting", () => {
            const g = setupStrength();
            g.stashes.get(1)![1] = 0;
            expect(g.validateMove("use 08/with m0.1 grow m0.1")).to.deep.include({ valid: true, complete: -1 });
            expect(g.validateMove("use 08/with m0.1 grow m0.1/with m0.2 grow m0.2")).to.deep.include({ valid: true });

            const g2 = setupStrength();
            const before = g2.stashes.get(1)!.slice();
            expect(g2.validateMove("use 08/with m0.1 grow m0.1").complete).eq(0);
            g2.move("use 08/with m0.1 grow m0.1");
            expect(g2.stashes.get(1)).to.deep.equal([before[0] + 1, before[1] - 1, before[2]]);
        });

        it("Strength: the second grow must act on the piece the first grow produced", () => {
            const g = setupStrength();
            expect(g.validateMove("use 08/with m0.1 grow m0.1/with m0.2 grow n0.1").valid).to.be.false;
            const before = g.stashes.get(1)!.slice();
            g.move("use 08/with m0.1 grow m0.1/with m0.2 grow m0.2");
            expect(g.stashes.get(1)).to.deep.equal([before[0] + 1, before[1], before[2] - 1]);
        });

        it("Sun: the grow must act on the piece the create just made", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "19", pieces: [[1, 1, "E"], [1, 2, "U"]] }],
                hands: [filler, filler],
            });
            expect(g.validateMove("use 19/with m0.1 at n0 create U/with n0.1 grow n0.1").valid).to.be.true;
            expect(g.validateMove("use 19/with m0.1 at n0 create U/with m0.2 grow m0.2").valid).to.be.false;
        });

        it("Chariot: a full-territory waypoint needs the same piece moved again; alone it stays incomplete", () => {
            const g = testGame({
                board: [
                    { x: 0, y: 0, uid: "07", pieces: [[1, 1, "E"]] }, // The Chariot
                    { x: 1, y: 0, uid: "AC", pieces: [[2, 2, "U"], [2, 2, "U"], [2, 2, "U"]] }, // already holds three pieces
                    { x: 3, y: 0, uid: "AD" }, // keeps o0 (2,0) a genuine wasteland, not void
                ],
                hands: [filler, filler],
            });
            expect(g.validateMove("use 07/with m0.1 move m0.1 1")).to.deep.include({ valid: true, complete: -1 });
            expect(g.validateMove("use 07/with m0.1 move m0.1 1/with n0.1 move n0.1 1").valid).to.be.true;
            expect(g.validateMove("use 07/with m0.1 move m0.1 1/with n0.1 move n0.2 1").valid).to.be.false;
        });

        it("Strength's +2 territory jump belongs to the first grow only", () => {
            const g = new GnosticaGame(2);
            const def = MAJOR_ARCANA["08"];
            expect(g.computeShortcutOpts(def, "grow", 0, 2, undefined).skipLadder).to.be.true;
            expect(g.computeShortcutOpts(def, "grow", 1, 2, undefined).skipLadder).to.be.undefined;
        });
    });

    it("a same-piece shortcut's transient intermediate size never touches the stash, either for Strength (1->3) or Sun (create then grow)", () => {
        const strength = testGame({ board: [{ x: 0, y: 0, uid: "08", pieces: [[1, 1, "U"]] }], hands: [filler, filler] });
        strength.stashes.get(1)![1] = 0; // zero size-2 pieces left in stash
        strength.move(`use 08/with m0.1 grow m0.1/with m0.2 grow m0.2`);
        expect(strength.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 3 });
        expect(strength.stashes.get(1)!).to.deep.equal([6, 0, 4]); // the transient size-2 was never taken OR returned

        const sun = testGame({ board: [{ x: 0, y: 0, uid: "19", pieces: [[1, 1, "E"]] }], hands: [filler, filler], stashes: { 1: [0, 5, 5], 2: [5, 5, 5] } });
        sun.move(`use 19/with m0.1 at n0 create U/with n0.1 grow n0.1`);
        expect(sun.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2 });
        expect(sun.stashes.get(1)!).to.deep.equal([0, 4, 5]); // the transient size-1 was never taken OR returned
    });

    describe("a special power's step must be spelled with that power's own action", () => {
        const setupSpecial = (seq: number): GnosticaGame => testGame({
            board: [
                { x: 0, y: 0, uid: String(seq).padStart(2, "0"), pieces: [[1, 2, "E"]] },
                { x: 1, y: 0, uid: "AC", pieces: [[2, 1, "N"]] },
            ],
            hands: [["2C", "KS", "5D"], ["3S", "4S"]],
        });

        it("a second power alone is spelled with its OWN action (Justice's sword, Empress's cup), not the card's first power", () => {
            const justice = setupSpecial(11);
            expect(justice.validateMove("use 11/with m0.2 trade n0.1").valid).to.be.true;
            expect(justice.validateMove("use 11/with m0.2 shrink n0.1 1").valid).to.be.true;
            justice.move("use 11/with m0.2 shrink n0.1 1");
            expect(justice.hands[0]).to.deep.equal(["2C", "KS", "5D"]); // hands were not traded
            expect(justice.board.get(1, 0)!.pieces.length).eq(0); // the size-1 enemy piece was attacked

            const empress = setupSpecial(3);
            expect(empress.validateMove("use 03/orient m0.2 N").valid).to.be.true;
            expect(empress.validateMove("use 03/with m0.2 at n0 create U").valid).to.be.true;
            empress.move("use 03/with m0.2 at n0 create U");
            expect(empress.board.get(1, 0)!.pieces.length).eq(2); // the created piece
            expect(empress.board.get(0, 0)!.pieces[0].orientation).eq("E"); // not reoriented
        });

        it("a step spelled as neither of the card's powers is rejected", () => {
            expect(setupSpecial(11).validateMove("use 11/with m0.2 grow m0.2").valid).to.be.false;
            expect(setupSpecial(3).validateMove("use 03/with m0.2 shrink n0.1 1").valid).to.be.false;
        });
    });

    // All powers are optional: either of a two-power card's powers may be used alone, but never
    // in reverse order (the full two-power form still works too).
    describe("using a card's second power alone", () => {
        const setupCard = (seq: number): GnosticaGame => testGame({
            board: [
                { x: 0, y: 0, uid: String(seq).padStart(2, "0"), pieces: [[1, 2, "E"]] },
                { x: 1, y: 0, uid: "AC", pieces: [[2, 1, "N"]] },
            ],
            hands: [["2C", "KS", "5D"], ["3S", "4S"]],
        });

        it("Lovers: the cup alone creates a piece; the full two-power form (rod then cup) still works", () => {
            const g = setupCard(6);
            g.move("use 06/with m0.2 at n0 create U");
            expect(g.board.get(1, 0)!.pieces.length).eq(2);
            expect(setupCard(6).validateMove("use 06/with m0.2 move m0.2 1/with n0.2 at o0 create U").valid).to.be.true;
        });

        it("Emperor: the rod alone moves the piece", () => {
            const g = setupCard(4);
            g.move("use 04/with m0.2 move m0.2 1");
            expect(g.board.get(1, 0)!.pieces.some(p => p.owner === 1 && p.size === 2)).to.be.true;
        });

        it("Hanged Man: the trade alone swaps hands", () => {
            const g = setupCard(12);
            g.move("use 12/with m0.2 trade n0.1");
            expect(g.hands[0]).to.deep.equal(["3S", "4S"]);
        });

        it("Tower and Moon: the sword alone destroys the enemy piece", () => {
            const tower = setupCard(16);
            tower.move("use 16/with m0.2 shrink n0.1 1");
            expect(tower.board.get(1, 0)?.pieces.length ?? 0).eq(0);
            const moon = setupCard(18);
            moon.move("use 18/with m0.2 shrink n0.1 1");
            expect(moon.board.get(1, 0)?.pieces.length ?? 0).eq(0);
        });

        it("Star: the disc alone grows the piece", () => {
            const g = setupCard(17);
            g.move("use 17/with m0.2 grow m0.2");
            expect(g.board.get(0, 0)!.pieces[0].size).eq(3);
        });

        it("Sun: the disc alone is an ordinary grow with exact stash accounting", () => {
            const g = setupCard(19);
            const before = g.stashes.get(1)!.slice();
            g.move("use 19/with m0.2 grow m0.2");
            expect(g.board.get(0, 0)!.pieces[0].size).eq(3);
            expect(g.stashes.get(1)).to.deep.equal([before[0], before[1] + 1, before[2] - 1]);
        });

        it("the powers may not be used in reverse order", () => {
            expect(setupCard(19).validateMove("use 19/with m0.2 grow m0.2/with m0.2 at n0 create U").valid).to.be.false;
            expect(setupCard(18).validateMove("use 18/with m0.2 shrink n0.1 1/with m0.2 move m0.2 1").valid).to.be.false;
        });
    });

    describe("Sun's territory shortcut", () => {
        const setupSun = (uid = "19"): GnosticaGame => testGame({
            board: [{ x: 0, y: 0, uid, pieces: [[1, 1, "E"]] }], // n0 is the wasteland it points at
            hands: [["2C", "KS", "00"], filler],
        });

        it("creating a territory with a royalty card stands in for creating a spot card and growing it, and uses up both steps", () => {
            const g = setupSun();
            expect(g.validateMove("use 19/with m0.1 at n0 create 2C").valid).to.be.true; // the ordinary spot card still works
            expect(g.validateMove("use 19/with m0.1 at n0 create KS")).to.deep.include({ valid: true, complete: 1 });
            g.move("use 19/with m0.1 at n0 create KS");
            expect(g.board.get(1, 0)!.card?.uid).eq("KS");
            expect(g.validateMove("use 19/with m0.1 grow n0 to 00").valid).to.be.false; // already consumed
        });

        it("a major arcana card is still not a legal create, and only the Sun may create royalty", () => {
            expect(setupSun().validateMove("use 19/with m0.1 at n0 create 00").valid).to.be.false;
            expect(setupSun("AC").validateMove("use AC/with m0.1 at n0 create KS").valid).to.be.false;
        });

        it("the Sun's grow is one value at a time (no skipLadder)", () => {
            const g = setupSun();
            expect(g.validateMove("use 19/with m0.1 at n0 create 2C/with m0.1 grow n0 to KS").valid).to.be.true;
            expect(g.validateMove("use 19/with m0.1 at n0 create 2C/with m0.1 grow n0 to 00").valid).to.be.false;
        });
    });

    it("Death's shortcut is one shrink standing for both swords, so only its first step gets bothSwords", () => {
        const g = new GnosticaGame(2);
        const def = MAJOR_ARCANA["13"]; // Death
        expect(g.computeShortcutOpts(def, "attack", 0, 2, undefined).bothSwords).to.be.true;
        expect(g.computeShortcutOpts(def, "attack", 1, 2, undefined).bothSwords).to.be.undefined;
        expect(g.computeShortcutOpts(def, "attack", 0, 2, undefined).skipStashCheck).to.be.undefined; // no stash waiver anymore
    });

    // Death (attack, attack): two swords on the same target may be written as one shrink of their total.
    describe("Death's single-step shortcut", () => {
        const setup = (minionSize: 1 | 2, targetUid: string, targetPieces: TestPiece[] = [], ownHand: string[] = filler): GnosticaGame => testGame({
            board: [{ x: 0, y: 0, uid: "13", pieces: [[1, minionSize, "E"]] }, { x: 1, y: 0, uid: targetUid, pieces: targetPieces }],
            hands: [ownHand, filler],
        });

        it("offers no attack amount past the victim's own pips (a 2-pip minion's 4 and 3 against a 2-pip victim are just 2)", () => {
            const g = setup(2, "3C", [[2, 2, "U"]]);
            g.move("use 13/with m0.2 shrink n0.2", { partial: true });
            const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label?: string }[] }[] };
            const labels = rep.areas!.find(a => a.type === "buttonBar")!.buttons!.map(b => b.label).filter(l => l?.startsWith("Attack for"));
            expect(labels).to.deep.equal(["Attack for 2", "Attack for 1"]);
        });

        it("crosses out (rather than hides) an attack amount whose leftover piece the victim's owner has no stash for", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "13", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "3C", pieces: [[2, 2, "U"]] }],
                hands: [filler, filler],
                stashes: { 2: [0, 5, 5] }, // no small pyramids left, so a 2-pip piece can't be shrunk to 1
            });
            g.move("use 13/with m0.2 shrink n0.2", { partial: true });
            type Btn = { label?: string; attributes?: { name: string; value: string }[] };
            const rep = g.render().at(-1) as { areas?: { type: string; buttons?: Btn[] }[] };
            const attacks = rep.areas!.find(a => a.type === "buttonBar")!.buttons!.filter(b => b.label?.startsWith("Attack for"));
            const crossed = (b: Btn) => b.attributes?.some(a => a.name === "text-decoration" && a.value === "line-through") === true;
            expect(attacks.map(b => [b.label, crossed(b)])).to.deep.equal([["Attack for 2", false], ["Attack for 1", true]]);
        });

        it("a piece shrink's total acts across its whole range: 3->1 (size-1 minion, capped at 2), 2->0 and 3->0 (destroyed), and a total above what's there wipes out (4 acts as 3)", () => {
            const a = setup(1, "3C", [[2, 3, "U"]]);
            expect(a.validateMove("use 13/with m0.1 shrink n0.3 3").valid).to.be.false; // 3 > 2 x 1
            expect(a.validateMove("use 13/with m0.1 shrink n0.3 2").valid).to.be.true;
            a.move("use 13/with m0.1 shrink n0.3 2");
            expect(a.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, size: 1 });

            const b = setup(1, "3C", [[2, 2, "U"]]);
            b.move("use 13/with m0.1 shrink n0.2 2");
            expect(b.board.get(1, 0)!.pieces.length).eq(0);

            const c = setup(2, "3C", [[2, 3, "U"]]);
            c.move("use 13/with m0.2 shrink n0.3 3");
            expect(c.board.get(1, 0)!.pieces.length).eq(0);

            const d = setup(2, "3C", [[2, 3, "U"]]);
            d.move("use 13/with m0.2 shrink n0.3 4");
            expect(d.board.get(1, 0)!.pieces.length).eq(0);
        });

        it("a territory shrink's total acts across its whole range: 2->0 (royalty, size-1 minion), 3->1 (major to spot, size-1 minion), 3->0 (major, size-2 minion)", () => {
            const a = setup(1, "KS"); // worth 2
            a.move("use 13/with m0.1 shrink n0 2");
            expect(a.board.get(1, 0)?.card).to.be.undefined;

            const b = setup(1, "00", [], ["2C", ...filler]); // worth 3
            expect(b.validateMove("use 13/with m0.1 shrink n0 2 to KS").valid).to.be.false; // wrong replacement value
            b.move("use 13/with m0.1 shrink n0 2 to 2C");
            expect(b.board.get(1, 0)!.card?.uid).eq("2C");

            const c = setup(2, "00");
            c.move("use 13/with m0.2 shrink n0 3");
            expect(c.board.get(1, 0)?.card).to.be.undefined;
        });

        it("a one-step Death shrink uses up both swords, so a second step is rejected; the ordinary two steps still work", () => {
            const g = setup(1, "3C", [[2, 3, "U"]]);
            expect(g.validateMove("use 13/with m0.1 shrink n0.3 2").complete).eq(1);
            expect(g.validateMove("use 13/with m0.1 shrink n0.3 2/with m0.1 shrink n0.1 1").valid).to.be.false;
            expect(g.validateMove("use 13/with m0.1 shrink n0.3 1/with m0.1 shrink n0.2 1").valid).to.be.true;
        });
    });

    it("Moon: a move that pushes a territory to 4 pieces stays incomplete until the attack destroys one there, restoring the cap", () => {
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "18", pieces: [[1, 1, "E"]] }, // The Moon, facing n0
                { x: 1, y: 0, uid: "AC", pieces: [[2, 1, "N"], [2, 2, "N"], [2, 3, "N"]] }, // already at the 3-piece cap
            ],
            hands: [filler, filler],
        });
        // Move alone pushes n0 to 4 pieces - not yet submittable, since nothing has restored the cap.
        expect(g.validateMove(`use 18/with m0.1 move m0.1 1`).complete).to.equal(-1);
        // Shrinking (not destroying) the victim doesn't satisfy the restoration either.
        expect(g.validateMove(`use 18/with m0.1 move m0.1 1 orient U/with n0.1.1 shrink n0.3 1`).valid).to.be.false;
        // Destroying one of the four pieces at n0 (not necessarily the moved one) restores the cap.
        const full = `use 18/with m0.1 move m0.1 1 orient U/with n0.1.1 shrink n0.1.2 1`;
        expect(g.validateMove(full)).to.deep.include({ valid: true, complete: 1 });
        g.move(full);
        expect(g.board.get(1, 0)!.pieces.length).eq(3);
        expect(g.board.get(1, 0)!.pieces.some(p => p.owner === 2 && p.size === 1)).to.be.false; // the victim is gone
    });

    it("replacing a piece in place still commits in a cell Empress left over capacity", () => {
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "05", pieces: [[1, 1, "E"]] }, // The Hierophant
                { x: 1, y: 0, uid: "AC", pieces: [[2, 1, "N"], [2, 2, "N"], [2, 3, "N"], [1, 2, "N"]] }, // 4 pieces
            ],
            hands: [filler, filler],
        });
        const move = `use 05/with m0.1 replace n0.1 U`;
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move);
        const cell = g.board.get(1, 0)!;
        expect(cell.pieces.length).eq(4);
        expect(cell.pieces.some(p => p.owner === 1 && p.size === 1 && p.orientation === "U")).to.be.true;
    });

    it("validateMove of a chained move leaves the game untouched", () => {
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "18", pieces: [[1, 1, "E"]] },
                { x: 1, y: 0, uid: "AC", pieces: [[2, 1, "N"], [2, 2, "N"], [2, 3, "N"]] },
            ],
            hands: [filler, filler],
        });
        const before = g.serialize();
        expect(g.validateMove(`use 18/with m0.1 move m0.1 1 orient U/with n0.1.1 shrink n0.1.2 1`).valid).to.be.true;
        expect(g.serialize()).eq(before);
    });

    it("a with-ref stays unambiguous among all the player's pieces in its cell, not just the pool (Chariot onto an occupied territory)", () => {
        const setup = () => testGame({
            board: [
                { x: 0, y: 0, uid: "07", pieces: [[1, 2, "E"]] },
                { x: 1, y: 0, uid: "AR", pieces: [[1, 2, "N"]] },
                { x: 2, y: 0, uid: "2R" },
            ],
            hands: [filler, filler],
        });
        const g = setup();
        // After step 1 the moved piece A sits beside B (same size, different facing); the pool holds only A.
        const moved = setup();
        moved.board.get(1, 0)!.pieces.push(new Piece(1, 2, "E"));
        expect(moved.pieceRefStr({ x: 1, y: 0, index: 1 }, [{ x: 1, y: 0, index: 1 }])).eq("n0.2.E");
        // Nothing else in the cell: the plain ref is still enough.
        expect(g.pieceRefStr({ x: 0, y: 0, index: 0 }, [{ x: 0, y: 0, index: 0 }])).eq("m0.2");
        // The ref resolves to A against every piece the player owns, not only the pool.
        const resolve = (moved as unknown as { resolvePieceRef: (ref: string, pool: { x: number; y: number; index: number }[]) => { kind: string; ref?: { index: number } } }).resolvePieceRef.bind(moved);
        const resolved = resolve("n0.2.E", [{ x: 0, y: 0, index: 0 }, { x: 1, y: 0, index: 0 }, { x: 1, y: 0, index: 1 }]);
        expect(resolved.kind).eq("ok");
        expect(resolved.ref!.index).eq(1);

        const chain = `use 07/with m0.2 move m0.2 1/with n0.2.E move n0.2.E 1`;
        expect(g.validateMove(chain).valid).to.be.true;
        g.move(chain);
        expect(g.board.get(2, 0)!.pieces.map(p => p.id())).to.deep.equal(["12E"]);
    });

    it("a pending step's minion snapshots always match its own game's board, in both views, even when the last typed step reorients that minion (Devil)", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "15", pieces: [[1, 1, "S"]] }, { x: 1, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }],
            hands: [filler, filler],
        });
        const chain = "use 15/with m0.1 orient m0.1 N/with m0.1.N orient m0.1.N E";
        const internal = g as unknown as {
            parseMove: (m: string) => unknown;
            parsePendingStep: (p: unknown) => { current?: PendingLike; advanced?: PendingLike };
        };
        type PendingLike = { minions: { x: number; y: number; index: number; piece?: Piece }[]; game: GnosticaGame };
        for (let k = 1; k <= 3; k++) {
            const views = internal.parsePendingStep(internal.parseMove(chain.split("/").slice(0, k).join("/")));
            for (const view of [views.current, views.advanced]) {
                for (const m of view?.minions ?? []) {
                    expect(m.piece?.id()).eq(view!.game.board.get(m.x, m.y)!.pieces[m.index].id());
                }
            }
        }
    });

    it("Chariot: two rod steps on the same piece may pass through the void mid-chain", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "07", pieces: [[1, 3, "W"]] }], // large minion, pointing away from the grid
            hands: [filler, filler],
        });
        // Step 1 (relaxed, not the last step): 3 west from m0 lands at j0, which is void - illegal
        // as an ordinary landing, legal here as Chariot's waypoint. Reorient east.
        // Step 2 (the last step, normal rules apply): 3 east from j0 lands back on m0 - legal.
        g.move(`use 07/with m0.3 move m0.3 3 orient E/with j0.3 move j0.3 3 orient U`);
        expect(g.board.get(0, 0)!.pieces.length).eq(1);
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 3, orientation: "U" });
        expect(g.board.get(-3, 0)?.pieces.length ?? 0).eq(0); // nothing left stranded at the waypoint
    });

    it("a preview with a bare-cell with-token only waits for the minion on verbs that read it", () => {
        // Two of the player's pieces share the card's cell, so "m0" doesn't yet say which acts.
        const strength = testGame({ board: [{ x: 0, y: 0, uid: "08", pieces: [[1, 1, "E"], [1, 2, "N"]] }], hands: [filler, filler] });
        strength.move(`use 08/with m0 grow m0.1`, { partial: true });
        expect(strength.board.get(0, 0)!.pieces.map(p => p.size).sort()).to.deep.equal([2, 2]); // Discs never reads the actor: the grow shows
        const chariot = testGame({ board: [{ x: 0, y: 0, uid: "07", pieces: [[1, 1, "E"], [1, 2, "N"]] }, { x: 1, y: 0, uid: "AR" }], hands: [filler, filler] });
        chariot.move(`use 07/with m0 move m0.1 1`, { partial: true });
        expect(chariot.board.get(0, 0)!.pieces.length).eq(2); // Rods reads the actor's facing: nothing moves yet
    });

    it("a Chariot's first move into the void stands as a waypoint in the preview, while another card's destroys the piece", () => {
        const waypoint = testGame({ board: [{ x: 0, y: 0, uid: "07", pieces: [[1, 3, "W"]] }], hands: [filler, filler] });
        waypoint.move(`use 07/with m0.3 move m0.3 3 orient E`, { partial: true });
        expect(waypoint.board.get(-3, 0)?.pieces.length).eq(1); // waiting there for the second move

        const lovers = testGame({ board: [{ x: 0, y: 0, uid: "06", pieces: [[1, 3, "W"]] }], hands: [filler, filler] });
        lovers.move(`use 06/with m0.3 move m0.3 3 orient E`, { partial: true });
        expect(lovers.board.get(-3, 0)?.pieces.length ?? 0).eq(0); // a final landing in the void destroys it
    });

    it("Empress: orienting the minion first, then creating with ignoreCapacity, still resolves the second step's ref even once orientation makes two pieces identical", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "03", pieces: [[1, 1, "N"], [1, 1, "U"], [1, 1, "U"]] }], // already 3 here
            hands: [filler, filler],
        });
        // The first piece is size-1 facing N, uniquely identified among the three (also size-1)
        // pieces at m0 - the other two are identical, so once the first is reoriented to match
        // them, "m0.1" alone still resolves (to the first array slot) via the true-duplicate tie-break.
        g.move(`use 03/orient m0.1.N U/with m0.1 at m0 create U`);
        expect(g.board.get(0, 0)!.pieces.length).eq(4); // ignoreCapacity let a 4th piece in
    });

    it("orientMinion: a same-facing (no-op) reorientation is rejected, not silently accepted as a real step", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "03", pieces: [[1, 1, "E"]] }], hands: [filler, filler] });
        const validated = g.validateMove(`use 03/orient m0.1 E`);
        expect(validated.valid).to.be.false;
        expect(validated.message).to.eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        expect(g.validateMove(`use 03/orient m0.1 N`).valid).to.be.true; // genuinely reorienting still validates fine
    });

    it("Devil: three orientAny steps, including reorienting the acting minion mid-chain, produce one chat/frame/_group entry per step", () => {
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "15", pieces: [[1, 1, "U"]] }, // The Devil, minion standing
                { x: 1, y: 0, uid: "AC", pieces: [[2, 1, "U"]] }, // an enemy piece, east of m0
            ],
            hands: [filler, filler],
        });
        g.move(
            // Step 1: orient the minion itself from "U" to "E", so it can now target n0.
            // Step 2: orient the enemy piece at n0 to face away (W).
            `use 15/with m0.1 orient m0.1 E/with m0.1 orient n0.1 W/with m0.1 orient m0.1 U`,
        );
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("U"); // reoriented twice, back to up
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, orientation: "W" }); // enemy piece reoriented too

        // A genuine 3-step chain: a frame before each step (N), plus the final/live rep.
        expect(g.frames.length).eq(3);
        expect(g.frames[0].board.get(0, 0)!.pieces[0].orientation).eq("U"); // the starting board
        expect(g.frames[1].board.get(0, 0)!.pieces[0].orientation).eq("E"); // after step 1 only
        expect(g.frames[1].board.get(1, 0)!.pieces[0].orientation).eq("U"); // step 2 not yet applied
        expect(g.frames[2].board.get(0, 0)!.pieces[0].orientation).eq("E"); // still E after step 2
        expect(g.frames[2].board.get(1, 0)!.pieces[0].orientation).eq("W"); // step 2's own effect
        expect((g.render() as unknown[]).length).eq(4);
        expect(g.results.filter(r => r.type === "_group").length).eq(3); // grouped, one per step
    });

    it("Judgement: draws named cards from the discard pile, up to the minion's pip count", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "20", pieces: [[1, 2, "U"]] }], // medium minion, 2 pips
            hands: [filler.slice(0, 4), filler], // make room - a full 6-card hand has none
            discardPile: ["KS", "00"],
        });
        g.move(`use 20/with m0.2 draw KS 00`);
        expect(g.hands[0]).to.include.members(["KS", "00"]);
        expect(g.discardPile).to.deep.equal([]);
    });

    it("High Priestess: two discard-and-redraw rounds, no minion reference needed", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "02", pieces: [[1, 1, "U"]] }], hands: [filler, filler], drawPile: ["9R"] });
        const [firstDiscard] = g.hands[0];
        g.move(`use 02/discard ${firstDiscard} draw 1`); // only the first of the two rounds
        expect(g.hands[0]).to.not.include(firstDiscard);
        expect(g.hands[0].length).eq(6);
    });

    it("Magician: chooses which suit primitive to use for its one step, but only via the head's \"as\" - a suit typed directly into a step is rejected", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "01", pieces: [[1, 1, "U"]] }], hands: [filler, filler] });
        g.move(`use 01 as C/with m0.1 at m0 create U`);
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // used Cups' "own" mode

        // Hand-typed nonsense, not reachable through any click path - a bare suit letter isn't
        // valid step content at all (Cups itself carries no mode word).
        const g2 = testGame({ board: [{ x: 0, y: 0, uid: "01", pieces: [[1, 1, "U"]] }], hands: [filler, filler] });
        const result = g2.validateMove(`use 01/with m0.1 C own m0 U`);
        expect(result.valid).to.be.false;
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_OTHERWORD" }));
    });

    it("refuses more power-step segments than the card actually grants", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "01", pieces: [[1, 1, "U"]] }], hands: [filler, filler] }); // The Magician - only 1 power
        const result = g.validateMove(`use 01 as C/with m0.1 at m0 create U/with m0.1 at m0 create U`);
        expect(result.valid).to.be.false;
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "TOO_MANY_POWER_STEPS" }));
    });

    // Regression: SUIT_RE is case-insensitive by design (a hand-typed "as c" is legal), but the parsed
    // asSuit value used to stay lowercase - now normalized to uppercase in parseMove, so this must still
    // dispatch to Cups' "own" mode exactly like the uppercase form.
    it("a lowercase suit letter in \"as\" still validates and applies correctly", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "01", pieces: [[1, 1, "U"]] }], hands: [filler, filler] });
        g.move(`use 01 as c/with m0.1 at m0 create U`);
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // used Cups' "own" mode
    });
});

// The frame-array API contract itself (see render()'s own docs) - not
// specific card behaviour, already covered above.
describe("Gnostica: frame-stepping render() contract", () => {
    type AreaButtonBarLike = { type: string; buttons?: { value?: string }[] };
    type RepLike = { areas?: AreaButtonBarLike[] };
    const barValues = (rep: RepLike): string[] | undefined =>
        rep.areas?.find(a => a.type === "buttonBar")?.buttons?.map(b => b.value ?? "");
    const setupLovers = (): GnosticaGame => testGame({
        board: [{ x: 0, y: 0, uid: "06", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[1, 1, "S"]] }],
        hands: [filler, filler],
    });
    const move = `use 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U`;

    it("a genuine 2-step chain gives only its final rep any buttons, whether still mid-build (partial) or committed and reloaded", () => {
        const midBuild = setupLovers();
        midBuild.move(move, { partial: true });
        expect(midBuild.frames.length).eq(2); // still mid-build, but the chain itself is complete
        const reps = midBuild.render() as RepLike[];
        expect(reps.length).eq(3);
        expect(barValues(reps[0])).eq(undefined);
        expect(barValues(reps[1])).eq(undefined);
        expect(barValues(reps[2])).to.not.eq(undefined);

        const committed = setupLovers();
        committed.move(move);
        const reps2 = committed.render() as RepLike[];
        expect(reps2.length).eq(3);
        expect(barValues(reps2[0])).eq(undefined);
        expect(barValues(reps2[1])).eq(undefined);
        expect(barValues(reps2[2])).to.not.eq(undefined);
    });

    it("1 real step never produces extra frames or grouped results, even on a card that could have taken more", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "06", pieces: [[1, 1, "E"]] }], hands: [filler, filler] }); // Lovers - could take up to 2 steps
        g.move(`use 06/with m0.1 move m0.1 1 orient E`); // only step 1, step 2 skipped
        expect(g.frames.length).eq(0);
        expect(g.render()).to.have.length(1);
        expect(g.results.some(r => r.type === "_group")).eq(false);
    });

    it("rebuilds a card's legend face only for the frames where it changed, without altering the earlier reps", () => {
        // The Chariot walks a piece off the territory it starts on, so that card loses its owner's tint after the first frame.
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "07", pieces: [[1, 1, "E"]] }, { x: 3, y: 0, uid: "AD" }],
            hands: [filler, filler],
        });
        g.move("use 07/with m0.1 move m0.1 1/with n0.1 move n0.1 1");
        const reps = g.render() as { legend: Record<string, unknown> }[];
        expect(reps.length).eq(3);
        const face = (rep: { legend: Record<string, unknown> }) => JSON.stringify(rep.legend.c07);
        expect(face(reps[0])).to.not.eq(face(reps[1])); // owned in the starting board, not after it walks off
        expect(face(reps[1])).eq(face(reps[2])); // unchanged since
        expect(reps[1].legend).to.not.eq(reps[2].legend); // each rep has its own legend object
    });

    it("persistence round-trip: a reloaded game still steps through the same frames a genuine chain produced", () => {
        const g = setupLovers();
        g.move(move);
        const before = g.render() as RepLike[];
        const g2 = new GnosticaGame(g.serialize());
        const after = g2.render() as RepLike[];
        expect(after.length).eq(before.length);
        expect(g2.frames.length).eq(g.frames.length);
        expect(g2.frames[1].board.get(2, 0)?.pieces.length).eq(g.frames[1].board.get(2, 0)?.pieces.length);
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

    it("more than 5 pieces (only possible via an ignoreCapacity power) falls back to a dense, orientation-agnostic grid instead of the 5-slot layout", () => {
        const g = new GnosticaGame(2);
        // Orientation is irrelevant to densePieceGrid - all "U" here just keeps the setup simple.
        const pieces = [0, 1, 2, 3, 4, 5].map(() => new Piece(1, 1, "U"));
        const slots = gridSlots(g, pieces);
        // 6 pieces -> a 3-column x 2-row grid (cols = ceil(sqrt(6)), rows = ceil(6/cols)), filled row-major by array order.
        expect(slots.map(s => s.scale)).to.deep.equal(new Array(6).fill(0.48));
        const dy = slots.map(s => s.dy);
        expect(dy.slice(0, 3).every(v => Math.abs(v - dy[0]) < 0.001)).to.be.true; // row 0: same dy
        expect(dy.slice(3, 6).every(v => Math.abs(v - dy[3]) < 0.001)).to.be.true; // row 1: same dy
        expect(dy[3] - dy[0]).to.be.greaterThan(0); // row 1 sits below row 0
        const dx = slots.map(s => s.dx);
        expect(dx[0]).to.be.closeTo(dx[3], 0.001); // column 0 lines up between rows
        expect(dx[1]).to.be.closeTo(dx[4], 0.001); // column 1 lines up between rows
        expect(dx[2]).to.be.closeTo(dx[5], 0.001); // column 2 lines up between rows
        expect(dx[0]).to.be.lessThan(dx[1]);
        expect(dx[1]).to.be.lessThan(dx[2]);
    });
});

// A greyed button (already chosen) carries a muted fill; a crossed-out one carries only the strikethrough.
const isGrey = (b: object | undefined): boolean => (b as { fill?: unknown } | undefined)?.fill !== undefined;

describe("Gnostica: render", () => {
    // The renderer pairs rowLabels[i] with pieceRows[N-1-i] (mirrored, not
    // same-index) - confirmed by actually rendering an asymmetric board in
    // the renderer playground, not just by reading the schema. This test
    // guards against that mirroring silently regressing: for every row, the
    // label paired with it (per the renderer's own convention) must equal
    // that row's true algebraic notation, for every cell in the row.
    it("labels every row with its true algebraic row number, mirrored per the renderer's convention", () => {
        const g = new GnosticaGame(2);
        const rep = g.render().at(-1) as { board: { rowLabels: string[]; width: number }; pieces: string[][][] };
        const pieceRows = rep.pieces;
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
        const rep = g.render().at(-1) as { legend: Record<string, CellGlyph | CellGlyph[]>; pieces: string[][][] };
        // The board's own minY is pieceRows[0]'s y; render() pads by 1 cell.
        const keys = rep.pieces[0 - (g.board.minY - 1)][0 - (g.board.minX - 1)];
        expect(keys.length).eq(t.pieces.length);
        const coords = keys.map(key => {
            const nudge = (rep.legend[key] as CellGlyph[]).find(gl => gl.name?.startsWith("pyramid-"))!.nudge!;
            return `${nudge.dx},${nudge.dy}`;
        });
        expect(new Set(coords).size, "every piece should have a distinct nudge").eq(coords.length);
    });

    describe("minion ring", () => {
        type RingRep = { legend: Record<string, { name?: string }[]>; pieces: string[][][] };
        const ringKeys = (g: GnosticaGame): string[] => (g.render().at(-1) as unknown as RingRep).pieces.flat(2).filter(k => k.startsWith("ring_"));
        const duo = () => testGame({
            board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"], [1, 2, "U"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "U"]] }],
            hands: [filler, filler],
        });

        it("rings every candidate while it is still unclear which minion is meant", () => {
            const g = duo();
            g.move("use AC", { partial: true });
            expect(ringKeys(g).length).eq(2);
        });

        it("rings just the chosen minion, listed under its pyramid", () => {
            const g = duo();
            g.move("use AC/with m0.2", { partial: true });
            const rep = g.render().at(-1) as unknown as RingRep;
            const keys = ringKeys(g);
            expect(keys.length).eq(1);
            expect(rep.legend[keys[0]].some(gl => gl.name === "piece-dashed")).to.be.true;
            const cell = rep.pieces.flat().find(c => c.includes(keys[0]))!;
            expect(cell.indexOf(keys[0])).eq(cell.length - 2); // the pyramid's own key follows it
        });

        it("rings the target piece too, solid against the minion's dashed ring, once one is picked", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 2, "W"]] }],
                hands: [filler, filler],
            });
            g.move("use AS/with m0.2 shrink n0.2", { partial: true });
            const rep = g.render().at(-1) as unknown as { legend: Record<string, { name?: string; colour?: unknown }[]>; pieces: string[][][] };
            const keys = rep.pieces.flat(2).filter(k => k.startsWith("ring_"));
            expect(keys.map(k => k.split("_")[1]).sort()).to.deep.equal(["minion", "target"]);
            const target = keys.find(k => k.startsWith("ring_target_"))!;
            expect(rep.legend[target].some(gl => gl.name === "piece")).to.be.true;
            expect(rep.legend[keys.find(k => k.startsWith("ring_minion_"))!].some(gl => gl.name === "piece-dashed")).to.be.true;
            expect(rep.pieces.flat().find(c => c.includes(target))!.length).eq(2); // listed with its own pyramid
        });

        it("keeps the ring on a finished move's target, read back from its results", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 3, "W"]] }],
                hands: [filler, filler],
            });
            g.move("use AS/with m0.2 shrink n0.3 1");
            expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, size: 2 }); // shrunk, not destroyed
            const rep = g.render().at(-1) as unknown as { pieces: string[][][] };
            const keys = rep.pieces.flat(2).filter(k => k.startsWith("ring_"));
            expect(keys.length).eq(1);
            expect(keys[0].startsWith("ring_target_")).to.be.true;
        });

        it("rings a Rods move's minion as well as the piece it moved, once the move is finished", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "U"]] }, { x: 2, y: 0, uid: "AC" }],
                hands: [filler, filler],
            });
            g.move("use AR/with m0.1 move n0.1 1");
            expect(g.board.get(2, 0)!.pieces.length).eq(1); // the enemy piece landed on o0
            const rep = g.render().at(-1) as unknown as { pieces: string[][][] };
            const keys = rep.pieces.flat(2).filter(k => k.startsWith("ring_"));
            expect(keys.map(k => k.split("_")[1]).sort()).to.deep.equal(["minion", "target"]);
        });

        it("shows no ring without a move in progress", () => {
            expect(ringKeys(duo())).to.deep.equal([]);
        });
    });

    // Void cells are never individually clickable in the grid - a
    // wasteland minion facing into one instead gets a `buffer` area on
    // whichever single side of the board's own stored extent it sits on
    // (see cmdOrient's own docs). This is the Pacru-style replacement for
    // the earlier "expand the void" approach.
    it("never renders a void cell as a clickable target, even once a piece is on the wasteland next to it", () => {
        const g = new GnosticaGame(2);
        const before = g.render().at(-1) as { pieces: string[][][]; legend: Record<string, unknown> };
        expect(before.pieces.flat().every(cell => cell.length === 0)).to.be.true; // no pieces anywhere yet - every void cell is bare
        expect(Object.keys(before.legend).filter(k => k.includes("void"))).to.deep.equal([]);

        // (2,1) is wasteland (adjacent to the initial 3x3's corner at
        // (1,1)); its own east neighbour (3,1) is void.
        expect(g.board.classify(2, 1)).eq("wasteland");
        expect(g.board.classify(3, 1)).eq("void");
        g.board.store.set(2, 1, new CellContents(undefined, [new Piece(1, 1, "U")]));

        const after = g.render().at(-1) as { pieces: string[][][]; legend: Record<string, unknown> };
        expect(after.pieces.flat().filter(cell => cell.length > 0).length).eq(1);
        expect(Object.keys(after.legend).filter(k => k.includes("void"))).to.deep.equal([]);
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
        g.move(`orient ${ref} N`);
        const rep = g.render().at(-1) as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });

    it("shows no buffer for a minion sitting on a real territory", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2 - keeps their own board presence legal
        const ref = `${GnosticaBoard.coords2algebraic(0, 0)}.1`;
        g.move(`orient ${ref} N`);
        const rep = g.render().at(-1) as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer).to.be.undefined;
    });

    // The other four flows that can also orient a piece into the void -
    // see addBufferIfWasteland's own docs on why all five need this, not
    // just the top-level "orient" command above.
    it("shows a buffer when placing directly onto an edge wasteland", () => {
        const g = new GnosticaGame(2);
        expect(g.board.classify(2, 0)).eq("wasteland");
        const cell = GnosticaBoard.coords2algebraic(2, 0);
        g.move(`place ${cell} N`);
        const rep = g.render().at(-1) as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });

    it("shows a buffer when Cups 'own' creates a new piece on an edge wasteland", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 1, 0, () => aceOfCups());
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "E")]; // facing (2,0)
        expect(g.board.classify(2, 0)).eq("wasteland");
        const minionCell = GnosticaBoard.coords2algebraic(1, 0);
        const targetCell = GnosticaBoard.coords2algebraic(2, 0);
        g.move(`use AC/with ${minionCell}.1 at ${targetCell} create U`);
        const rep = g.render().at(-1) as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });

    it("shows a buffer when orientAny (Devil) targets a piece on an edge wasteland", () => {
        // (2,0) has no card of its own - a wasteland, adjacent to (1,0)'s card - with an enemy piece on it.
        const g = testGame({
            board: [{ x: 1, y: 0, uid: "15", pieces: [[1, 1, "E"]] }, { x: 2, y: 0, pieces: [[2, 1, "S"]] }],
            hands: [filler, filler],
        });
        expect(g.board.classify(2, 0)).eq("wasteland");
        g.move(`use 15/with n0.1 orient o0.1 N`);
        const rep = g.render().at(-1) as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
    });

    it("shows the buffer as soon as an edge wasteland piece is picked to turn, so its facing can be clicked past the window", () => {
        type BufferRep = { board: { buffer?: { show: string[] } } };
        const g = testGame({
            board: [{ x: 1, y: 0, uid: "15", pieces: [[1, 1, "E"]] }, { x: 2, y: 0, pieces: [[2, 1, "S"]] }],
            hands: [filler, filler],
        });
        const bufferAt = (move: string) => {
            const shown = g.clone();
            shown.move(move, { partial: true });
            return (shown.render().at(-1) as BufferRep).board.buffer?.show;
        };
        expect(bufferAt("use 15/with n0.1 orient o0.1")).to.deep.equal(["E"]); // the Devil's target picked, no facing yet
        expect(bufferAt("use 15/with n0.1 orient n0.1")).to.be.undefined; // a piece on a real territory needs none
        const win = g.renderWindow();
        const click = g.handleClick("use 15/with n0.1 orient o0.1", 0 - win.minY, win.maxX - win.minX + 1);
        expect(click.move).eq("use 15/with n0.1 orient o0.1 E");
        const own = testGame({ board: [{ x: 1, y: 0, uid: "AD" }, { x: 2, y: 0, pieces: [[1, 1, "S"]] }], hands: [filler, filler] });
        own.move("orient o0.1", { partial: true });
        expect((own.render().at(-1) as BufferRep).board.buffer?.show).to.deep.equal(["E"]); // the plain orient's piece, same
    });

    it("shows a buffer when hierophantReplace targets a piece on an edge wasteland", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 1, 0, () => major(5)); // The Hierophant
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "E")]; // acting minion, facing (2,0)
        g.board.store.set(2, 0, new CellContents(undefined, [new Piece(2, 1, "S")])); // enemy target, on an edge wasteland
        expect(g.board.classify(2, 0)).eq("wasteland");
        const minionCell = GnosticaBoard.coords2algebraic(1, 0);
        const targetCell = GnosticaBoard.coords2algebraic(2, 0);
        g.move(`use 05/with ${minionCell}.1 replace ${targetCell}.1 N`);
        const rep = g.render().at(-1) as { board: { buffer?: { show: string[] } } };
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
        g.move(`place ${originCell} E`); // player 1, pointing at the neighbour
        g.move(`place ${neighbourCell} U`); // player 2

        const useMove = `use AC/with ${originCell}.1 at ${neighbourCell} create U`;
        expect(g.validateMove(useMove).valid).to.be.true;
        g.move(useMove);
        const target = g.board.get(14, 0)!;
        expect(target.pieces.length).eq(2); // player 2's placed piece, plus player 1's new one
        expect(target.pieces[1]).to.deep.include({ owner: 1, size: 1, orientation: "U" });

        const rep = g.render().at(-1) as { board: { columnLabels: string[] }; pieces: string[][][] };
        expect(rep.board.columnLabels).to.include.members(["aa", "ab"]);
        expect(rep.pieces).to.be.an("array"); // rendered without throwing
    });
});

describe("Gnostica: Judgement's draw from the discards", () => {
    const judgement = (hand: string[], discardPile: string[], size: 1 | 2 | 3 = 2) => testGame({
        board: [{ x: 0, y: 0, uid: "20", pieces: [[1, size, "U"]] }],
        hands: [hand, filler],
        discardPile,
    });

    it("stays open for a second card after the first rather than ending the turn", () => {
        const g = judgement(["2R", "3R", "4R", "5D"], ["AC", "2C", "3C"]); // a 2-pip minion, room for 2 in the hand
        const one = g.validateMove("use 20/with m0.2 draw AC");
        expect(one.valid).to.be.true;
        expect(one.complete).eq(0);
        expect(g.validateMove("use 20/with m0.2 draw AC 2C").complete).eq(1);
    });

    it("keeps the ordinary actions off the bar while it waits for discards: just Use and Declare", () => {
        const g = judgement(["2R", "3R", "4R", "5D"], ["AC", "2C", "3C"]);
        const values = (move: string): (string | undefined)[] => {
            const shown = g.clone();
            shown.move(move, { partial: true });
            return ((shown.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] }).areas ?? [])
                .filter(a => a.type === "buttonBar").flatMap(a => (a.buttons ?? []).map(b => b.value));
        };
        expect(values("use 20/with m0.2 draw AC")).to.deep.equal(["use", "declare", "undo"]); // one taken, room for another
        expect(values("use 20/with m0.2 draw AC 2C")).to.deep.equal(["use", "declare", "undo"]);
    });

    it("completes at once when nothing more can be drawn: the hand is full, or the discard pile has no other card", () => {
        expect(judgement(["2R", "3R", "4R", "5D", "6D"], ["AC", "2C"]).validateMove("use 20/with m0.2 draw AC").complete).eq(1); // room for only 1
        expect(judgement(["2R", "3R", "4R", "5D"], ["AC"]).validateMove("use 20/with m0.2 draw AC").complete).eq(1); // nothing else to take
        expect(judgement(["2R", "3R", "4R", "5D"], ["AC", "2C"], 1).validateMove("use 20/with m0.1 draw AC").complete).eq(1); // a 1-pip minion
    });

    it("answers a discard-pile click that nothing is waiting for with the current status, not the default handler's", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }], hands: [filler, filler], discardPile: ["2C"] });
        const click = g.handleClick("", -1, -1, "C_spot_1");
        expect(click.move).eq("");
        expect(click.message).eq(g.validateMove("").message); // the current status, unchanged
        expect(click.message).to.not.eq(i18next.t("apgames:validation._general.DEFAULT_HANDLER"));
    });
});

describe("Gnostica: Tower and Star take their replacement card from the hand or the discards", () => {
    // Star (grow): a 2-pip minion facing a 2 of Cups (worth 1), so a court card (worth 2) is the replacement.
    const star = () => testGame({
        board: [{ x: 0, y: 0, uid: "17", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "2C" }],
        hands: [["2R", "3R", "4R", "KR"], filler],
        discardPile: ["3D", "KD", "AC"],
    });

    it("accepts a card from either place, and rejects one in neither with a real message", () => {
        const g = star();
        expect(g.validateMove("use 17/with m0.2 grow n0 to KR").valid).to.be.true; // hand
        expect(g.validateMove("use 17/with m0.2 grow n0 to KD").valid).to.be.true; // discards
        const neither = g.validateMove("use 17/with m0.2 grow n0 to KS");
        expect(neither.valid).to.be.false;
        expect((neither as { message?: string }).message).to.not.include("{{");
        g.move("use 17/with m0.2 grow n0 to KR");
        expect(g.board.get(1, 0)!.cardUid).eq("KR");
        expect(g.discardPile).to.include("2C");
    });

    it("lets a click on the discard pile supply the card, as a click on a hand card does", () => {
        const g = star();
        const fromDiscard = g.handleClick("use 17/with m0.2 grow n0", -1, -1, "D_royal_1");
        expect(fromDiscard.move).eq("use 17/with m0.2 grow n0 to KD");
        expect(fromDiscard.valid).to.be.true;
        expect(g.handleClick("use 17/with m0.2 grow n0", -1, -1, "cKR").move).eq("use 17/with m0.2 grow n0 to KR");
    });
});

describe("Gnostica: button states", () => {
    type Btn = { label?: string; value?: string; attributes?: { name: string; value: string }[] };
    const barOf = (g: GnosticaGame): Btn[] => (g.render().at(-1) as { areas?: { type: string; buttons?: Btn[] }[] }).areas!.find(a => a.type === "buttonBar")!.buttons!;
    const swords = () => testGame({
        board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 2, "W"]] }],
        hands: [filler, filler],
    });

    it("never restarts the move when a greyed top-level button is clicked again", () => {
        const g = swords();
        const mid = "use AS/with m0.2 shrink n0.2";
        g.move(mid, { partial: true });
        const use = barOf(g).find(b => b.value === "use")!;
        expect(isGrey(use)).to.be.true;
        const click = g.handleClick(mid, -1, -1, "_btn_use");
        expect(click.move).eq(mid);
        expect(g.handleClick("discard 2R", -1, -1, "_btn_discard").move).eq("discard 2R"); // same for Discard/Draw
        // Choosing a different action is still a deliberate switch.
        expect(g.handleClick(mid, -1, -1, "_btn_orient").move).eq("orient");
    });

    it("offers to undo a declaration rather than silently toggling it", () => {
        const g = swords();
        expect(barOf(g).find(b => b.value === "declare")!.label).eq("(Declare)");
        const declared = g.handleClick("use AS/with m0.2 shrink n0.2 2", -1, -1, "_btn_declare");
        expect(declared.move).eq("use AS/with m0.2 shrink n0.2 2 last");
        g.move(declared.move!, { partial: true });
        const btn = barOf(g).find(b => b.value === "declare")!;
        expect(btn.label).eq("(Undeclare)");
        expect(isGrey(btn)).to.be.false;
        expect(g.handleClick(declared.move!, -1, -1, "_btn_declare").move).eq("use AS/with m0.2 shrink n0.2 2");
    });

    it("greys the chosen attack amount and ignores a click on it, leaving the others available", () => {
        const g = swords();
        const chosen = "use AS/with m0.2 shrink n0.2 2";
        g.move(chosen, { partial: true });
        const pips = barOf(g).filter(b => b.value?.startsWith("pips_"));
        expect(pips.map(b => [b.value, isGrey(b)])).to.deep.equal([["pips_2", true], ["pips_1", false]]);
        expect(g.handleClick(chosen, -1, -1, "_btn_pips_2").move).eq(chosen);
        expect(g.handleClick(chosen, -1, -1, "_btn_pips_1").move).eq("use AS/with m0.2 shrink n0.2 1");
    });

    it("ignores a click on a crossed-out attack amount instead of building a move that validation then rejects", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 2, "W"]] }],
            hands: [filler, filler],
            stashes: { 2: [0, 5, 5] }, // no small pyramids: a 2-pip piece can't be shrunk to 1
        });
        const mid = "use AS/with m0.2 shrink n0.2";
        g.move(mid, { partial: true });
        const one = barOf(g).find(b => b.value === "pips_1")!;
        expect(one.attributes).to.deep.include({ name: "text-decoration", value: "line-through" });
        expect(isGrey(one)).to.be.false; // crossed out on white, not greyed
        expect(g.handleClick(mid, -1, -1, "_btn_pips_1").move).eq(mid);
    });

    it("greys the Fool's resume button and ignores a click on it, so the revealed card's own steps stay reachable", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "00", pieces: [[1, 1, "U"]] }], hands: [filler, filler], drawPile: ["AC", "2C", "3C"] });
        g.move("use 00");
        expect(g.continued).to.not.be.empty;
        const play = barOf(g).find(b => b.value === "play")!;
        expect(isGrey(play)).to.be.true;
        const click = g.handleClick("", -1, -1, "_btn_play");
        expect(click.move).eq("play AC via 00"); // unchanged: still the resume, not a bare "play"
        expect(g.handleClick(click.move!, -1, -1, "_btn_target_own").valid).to.be.true;
    });
});

describe("Gnostica: handleClick", () => {
    // handleClick's row/col are relative to render()'s current window
    // (padded by 1 cell beyond the board's own bounding box) - this mirrors
    // that exact formula so tests can go from absolute board coords to the
    // row/col a real click would report.
    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        // Must match handleClick's own window exactly (see
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
        g.move("place m0 U");
        g.move("place l0 U");
        const result = g.handleClick("", -1, -1, "_btn_use");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.canrender).eq(true);
    });

    it("sets canrender on a valid complete:-1 result - a freshly-picked card, mode not chosen yet", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U");
        g.move("place l0 U");
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
        expect(east.move).eq("place m0 E"); // the click's own facing replaces the seeded "U?" outright
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
        expect(east.move).eq(`place ${placeCell} E`); // the click's own facing replaces the seeded "U?" outright
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
        g.move("place m0 U?");
        const t = g.board.get(0, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
        expect(g.lastmove).eq("place m0 U");
    });

    it("orient: clicking your own piece (with pieces already on the board/and Orient chosen) starts an orient move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2
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

    it("orient: clicking the piece's own cell again is a rejected no-op (reorienting IS the whole action); clicking a neighbour sets that facing directly", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const first = g.handleClick(seed.move, row, col);
        const same = g.handleClick(first.move, row, col);
        expect(same.valid).to.be.false;
        expect(same.move).eq("orient m0.1 U");
        expect(same.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
        const [rowE, colE] = rowColFor(g, 1, 0); // n0, east of m0
        const east = g.handleClick(first.move, rowE, colE);
        expect(east.valid).to.be.true;
        expect(east.move).eq("orient m0.1 E");
    });

    it("orient: clicking a non-adjacent/unoccupied cell falls back to fresh-selection handling", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
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
        g.move("place m0 U");
        g.move("place l0 U");
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U"), new Piece(1, 2, "U")]; // two distinguishable own minions
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const clicked = g.handleClick(seed.move, row, col);
        expect(clicked.valid).to.be.true;
        expect(clicked.complete).eq(-1);
        expect(clicked.move).eq("orient m0");
        expect(clicked.message).eq(i18next.t("apgames:validation.gnostica.PICK_MINION_BUTTON"));
        g.move(clicked.move!, { partial: true });
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const pickButtons = bar!.buttons!.filter(b => b.value?.startsWith("orientpick_"));
        expect(pickButtons.length).eq(2);
        const picked = g.handleClick(clicked.move!, -1, -1, `_btn_${pickButtons[1].value!}`);
        expect(picked.valid).to.be.true;
        expect(picked.move).eq("orient m0.2");
    });

    it("choosing Orient via the button bar seeds an instructional, not-yet-valid move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const result = g.handleClick("", -1, -1, "_btn_orient");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq("orient");
    });

    it("board clicks are ambiguous with no action chosen once pieces are on the board - no default guess", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.false;
    });

    it("Use Territory (activate) via the button bar, then a board click, builds a use move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
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
        g.move("place m0 U");
        g.move("place l0 U");
        const uid = g.hands[0][0];
        const seed = g.handleClick("", -1, -1, "_btn_play");
        const result = g.handleClick(seed.move, -1, -1, `c${uid}`);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`play ${uid}`);
    });

    it("Pass immediately builds a submittable, genuinely no-op discard/draw move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const result = g.handleClick("", -1, -1, "_btn_pass");
        expect(result.valid).to.be.true;
        // Not just "discard" - that bare form silently draws back to max,
        // which isn't actually a pass. Pass needs explicit "draw 0" too.
        expect(result.move).eq("discard draw 0");
    });

    it("Discard/Draw carries instructions, unlike Pass's own already-complete seed", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const result = g.handleClick("", -1, -1, "_btn_discard");
        expect(result.valid).to.be.true;
        expect(result.move).eq("discard");
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.DISCARD_DRAW_REQUIRED"));
        // No "draw <n>" yet - never complete without one (0 included),
        // regardless of hand contents (see validateDiscard's own docs).
        expect(result.complete).eq(-1);
        const withCount = g.handleClick(result.move, -1, -1, "_btn_drawcount_0");
        expect(withCount.move).eq("discard draw 0");
        expect(withCount.complete).eq(1);
    });

    it("Declare appends last to an in-progress move, and toggles it back off", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const seed = g.handleClick("", -1, -1, "_btn_pass"); // "discard draw 0"
        const declared = g.handleClick(seed.move, -1, -1, "_btn_declare");
        expect(declared.valid).to.be.true;
        expect(declared.move).eq("discard draw 0 last");
        const undeclared = g.handleClick(declared.move, -1, -1, "_btn_declare");
        expect(undeclared.move).eq("discard draw 0");
    });

    it("Declare works even with no base action chosen yet, and survives switching to a real action afterwards", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        // The random initial deal could otherwise occasionally put The
        // Fool itself at m0, whose own root activation is immediately
        // complete:0 (#49 exempts it), breaking this test's own
        // complete:-1 expectation below (see forceCardAt's own docs on
        // this exact class of flake).
        forceCardAt(g, 0, 0, () => major(1)); // The Magician
        const declared = g.handleClick("", -1, -1, "_btn_declare"); // clicked first, no move string yet
        expect(declared.valid).to.be.true;
        expect(declared.complete).eq(-1); // still needs a real action - not submittable as-is
        expect(declared.move).eq("last"); // the bare flag, not a guessed action like "discard"
        // Picking a real action afterwards must carry the flag along, even
        // though clicking "Activate" here has nothing to do with declaring.
        const seed = g.handleClick(declared.move, -1, -1, "_btn_use");
        expect(seed.move).eq("use last");
        const [row, col] = rowColFor(g, 0, 0);
        const uid0 = g.board.get(0, 0)!.card!.uid;
        const result = g.handleClick(seed.move, row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`use ${uid0} last`);
        // #49: same as the un-declared version above - still building.
        expect(result.complete).eq(-1);
    });

    // The trickiest part of handleClick's own "last" reattachment: a still-incomplete click
    // result (e.g. Pass's own "discard", always legal on its own) gets
    // re-validated once "last" makes it a genuinely complete move -
    // catching a declare that's ONLY illegal because of the flag itself
    // (another player's announcement hasn't resolved yet), rather than
    // reusing the pre-declare result's now-stale validity.
    it("re-validates once declaring completes the move, catching ALREADY_ANNOUNCED at that point", () => {
        const g = new GnosticaGame(3);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2
        g.move("place n0 U"); // player 3
        g.move("discard draw 0 last"); // player 1 announces
        // player 2's turn - "discard draw 0" (Pass) is perfectly legal on
        // its own; declaring on top of it must not be.
        const declared = g.handleClick("", -1, -1, "_btn_declare");
        expect(declared.move).eq("last");
        const passed = g.handleClick(declared.move, -1, -1, "_btn_pass");
        expect(passed.move).eq("discard draw 0 last");
        expect(passed.valid).to.be.false;
    });

    // Once lastTurner wraps back around to the declarer's own next turn
    // (see move()'s own docs on that check), they never re-declare - the
    // turn either wins outright or reopens the announcement window
    // (lastTurner reset to undefined). Declaring again mid-cycle, before
    // that wrap, is exactly as illegal for the declarer as for anyone
    // else (randomMove()'s own canAnnounce and buildTopLevelBar() both
    // used to wrongly treat "lastTurner === currplayer" as still
    // eligible).
    it("does not offer (or accept) a re-declare from the player who is already the declarer", () => {
        const g = new GnosticaGame(3);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2
        g.move("place n0 U"); // player 3, back to player 1
        g.lastTurner = g.currplayer;
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar!.buttons!.map(b => b.value)).to.not.include("declare");
        const check = g.validateMove("discard draw 0 last");
        expect(check.valid).to.be.false;
        expect(check.message).eq(i18next.t("apgames:validation.gnostica.ALREADY_ANNOUNCED"));
    });

    it("shows only a single, bold Place button with no pieces on the board yet", () => {
        const g = new GnosticaGame(2);
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar, "expected a button bar").to.not.be.undefined;
        expect(bar!.buttons!.map(b => b.value)).to.deep.equal(["place", "undo"]);
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
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar!.buttons!.map(b => b.value)).to.deep.equal(["place", "undo"]);
        expect(bar!.buttons![0].value).eq("place");
    });

    it("shows the full action set once a placement is genuinely committed", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U"); // back to player 1
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
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
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2 - now player 1's turn again
        g.move(`orient m0.1 N`); // player 1 orients, ending their turn
        // it's player 2's turn now; they haven't clicked anything yet - the
        // just-committed "orient" belongs to player 1's finished turn, not
        // a live action of player 2's.
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        for (const b of bar!.buttons!.filter(b => b.value !== "undo")) {
            expect(b.attributes, `button "${b.value}" should not be highlighted yet`).to.be.undefined;
        }
    });

    it("greys the button matching the current player's own in-progress action", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2 - now player 1's turn again
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_orient");
        const clicked = g.handleClick(seed.move, row, col);
        expect(clicked.move).eq("orient m0.1");
        g.move(clicked.move, { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const orientBtn = bar!.buttons!.find(b => b.value === "orient");
        expect(isGrey(orientBtn)).to.be.true; // already chosen
        // The other actions are not offered once one is chosen and built.
        expect(bar!.buttons!.map(b => b.value)).to.deep.equal(["orient", "declare", "undo"]);
    });

    it("greys Pass, not Discard/Draw, when the live move is Pass's own bare seed - whether built by the Pass button or by hand", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        for (const liveMove of ["discard draw 0", "discard draw 0"]) {
            g.move(liveMove, { partial: true });
            const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
            const bar = rep.areas?.find(a => a.type === "buttonBar");
            const passBtn = bar!.buttons!.find(b => b.value === "pass");
            const discardBtn = bar!.buttons!.find(b => b.value === "discard");
            expect(isGrey(passBtn), "Pass should be greyed").to.be.true;
            expect(isGrey(discardBtn), "Discard/Draw should not be greyed").to.be.false;
        }
    });

    it("still greys Discard/Draw for a discard preview that isn't Pass-equivalent (draws more than 0)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        g.hands[0] = g.hands[0].slice(0, 5); // leave room to draw
        g.move("discard draw 1", { partial: true });
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const discardBtn = bar!.buttons!.find(b => b.value === "discard");
        const passBtn = bar!.buttons!.find(b => b.value === "pass");
        expect(isGrey(discardBtn)).to.be.true;
        expect(isGrey(passBtn)).to.be.false;
    });

    it("collapses to the draw-count picker during a live discard preview, offering every legal count", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const [uid1, uid2] = g.hands[0];
        g.move(`discard ${uid1} ${uid2}`, { partial: true }); // player 1's own live preview, 2 discarded, no count chosen yet
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        // Pass and a bare "discard" share the exact same move text (known
        // simplification - see cmdDiscard's own bare-seed docs), so this
        // same collapse is unavoidably shown no matter which button
        // actually got clicked to seed the preview.
        expect(values).to.deep.equal(["drawcount_2", "drawcount_1", "drawcount_0", "undo"]);
    });

    it("clicking a draw-count button completes the move with that exact count", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const [uid1, uid2] = g.hands[0];
        const btn = g.handleClick("", -1, -1, "_btn_discard");
        const seeded = g.handleClick(btn.move, -1, -1, `c${uid1}`);
        const built = g.handleClick(seeded.move, -1, -1, `c${uid2}`);
        expect(built.move).eq(`discard ${uid1} ${uid2}`);
        const result = g.handleClick(built.move, -1, -1, "_btn_drawcount_1");
        expect(result.valid).to.be.true;
        expect(result.move).eq(`discard ${uid1} ${uid2} draw 1`);
        g.move(result.move);
        expect(g.hands[0].length).eq(5); // 4 left after discarding 2, +1 drawn back
    });

    it("still greys Use Territory during a live activate-skipping-power preview (no results pushed)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
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
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const activateBtn = bar!.buttons!.find(b => b.value === "use");
        // lastmove-based detection still catches this case, since lastmove is
        // set unconditionally regardless of pushed results
        expect(isGrey(activateBtn)).to.be.true;
    });

    // A CONTESTED cell (both players have a piece there) defeats the
    // narrower "does the current player own a piece at that result's
    // cell" check alone, since the new current player genuinely does have
    // a piece there too - only knowing whether a move() call has happened
    // yet THIS turn can tell the two apart.
    it("does not carry a stale mode-button set into a contested cell on the next player's fresh turn", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U"); // player 1's piece on m0, "U"
        g.move("place l0 U"); // player 2, elsewhere
        g.board.get(0, 0)!.pieces.push(new Piece(2, 1, "U")); // contrive: player 2 ALSO on m0 now
        g.move(`use AC/with m0.1 at m0 create U`); // player 1 uses Cups (own), ending their turn
        // it's player 2's turn now, and they haven't clicked anything -
        // even though player 2 also has a piece on the just-activated
        // cell, the mode-button set from player 1's finished turn must not
        // leak through.
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("use");
        expect(values).to.include("play"); // the full top-level set, not narrowed
        expect(values).to.not.include("target_own");
    });

    it("does not guess at a click on a cell with no piece of the acting player's, once placement is no longer legal", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2 - now player 1's turn again
        const [row, col] = rowColFor(g, -1, 0); // "l0", player 2's piece
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.false;
    });

    it("discard: clicking a hand card toggles it into a discard move/and clicking again toggles it back out", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // discard requires pieces already on the board
        g.move("place l0 U"); // back to player 1's turn
        const uid = g.hands[0][0];
        const btn = g.handleClick("", -1, -1, "_btn_discard");
        const first = g.handleClick(btn.move, -1, -1, `c${uid}`);
        expect(first.valid).to.be.true;
        expect(first.move).eq(`discard ${uid}`);
        expect(first.complete).eq(-1); // no draw count chosen yet - never complete without one
        const second = g.handleClick(first.move, -1, -1, `c${uid}`);
        expect(second.valid).to.be.true;
        expect(second.move).eq("discard");
    });

    it("a bare hand-card click with no action selected yet is rejected, not defaulted into discard", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const uid = g.hands[0][0];
        const result = g.handleClick("", -1, -1, `c${uid}`);
        expect(result.valid).to.be.false;
        expect(result.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST"));
    });

    it("discard: rejects a hand-card click for a card not in the acting player's hand", () => {
        const g = new GnosticaGame(2);
        const uid = g.hands[1][0]; // player 2's card, player 1 is acting
        const result = g.handleClick("", -1, -1, `c${uid}`);
        expect(result.valid).to.be.false;
    });

    // Hand redaction (blanking an opponent's hand uids to "") is the back
    // end's job, not this class's - but render() still has to cope with
    // whatever it's handed, rather than silently referencing a legend key
    // that was never defined (which would break the actual renderer).
    it("renders a redacted (blank-uid) hand card as a placeholder, not a dangling legend reference", () => {
        const g = new GnosticaGame(2);
        g.hands[1].fill(""); // simulate the back end redacting player 2's cards
        const rep = g.render().at(-1) as { legend: Record<string, unknown>; areas?: { pieces: string[] }[] };
        const p2area = rep.areas?.[1];
        expect(p2area, "expected an area for player 2's hand").to.not.be.undefined;
        expect(p2area!.pieces[0]).eq("cUNKNOWN");
        expect(rep.legend).to.have.property("cUNKNOWN");
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
        g.move("place m0 U");
        g.move("place l0 U"); // back to player 1
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
        g.move("place m0 U");
        g.move("place l0 U");
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

        g.move(`discard ${uid1} ${uid2} draw 2`); // final submission
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
        const rep = g.render().at(-1) as { legend: Record<string, unknown>; areas?: { label: string; pieces?: string[] }[] };
        const discardArea = rep.areas?.find(a => a.label === i18next.t("apgames:validation.gnostica.LABEL_DISCARDS"));
        expect(discardArea, "expected a discard-pile area").to.not.be.undefined;
        expect(discardArea!.pieces).to.include("C_spot_2");
        expect(discardArea!.pieces).to.include("C_royal_1");
        expect(discardArea!.pieces).to.include("c07");
        expect(discardArea!.pieces!.length).eq(3); // one spot-cup bucket, one royal-cup bucket, one major - not 4 separate entries
        expect(rep.legend).to.have.property("C_spot_2");
        const spotGlyphs = rep.legend.C_spot_2 as { text?: string }[];
        expect(spotGlyphs.find(gl => gl.text === "2x"), "spot bucket should count 2").to.not.be.undefined;
    });

    it("omits the discard-pile area entirely once the pile is empty", () => {
        const g = new GnosticaGame(2);
        g.discardPile = [];
        const rep = g.render().at(-1) as { areas?: { label?: string; pieces?: string[] }[] };
        const discardArea = rep.areas?.find(a => a.label === i18next.t("apgames:validation.gnostica.LABEL_DISCARDS"));
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
        const before = g.render().at(-1) as { legend: Record<string, { text?: string }[]> };
        const beforeText = before.legend.C_spot_9.find(gl => gl.text !== undefined)!.text;
        expect(beforeText, "AC is visible, so only the other 9 spot cups are unknown").eq("9x");

        g.hands[1] = [""]; // the back end redacts it - now hidden from this viewer
        const after = g.render().at(-1) as { legend: Record<string, { text?: string }[]> };
        const afterText = after.legend.C_spot_10.find(gl => gl.text !== undefined)!.text;
        expect(afterText, "AC is now hidden too, so all 10 spot cups are unknown").eq("10x");
    });
});

// Mirrors "Gnostica: new-card hand highlight" - a card added to the
// discard pile by the most recently completed move gets the same tint as
// a just-drawn hand card (see newDiscardUids's own docs), except it's not
// scoped to a specific viewer (the pile is always public) or gated on
// whose turn it is (there's only one shared pile).
describe("Gnostica: discard-pile 'just discarded' highlight", () => {
    type DiscardRenderRep = { legend: Record<string, { colour?: unknown; text?: string }[]>; areas?: { label?: string; pieces?: string[] }[] };
    const isTinted = (rep: DiscardRenderRep, key: string): boolean => JSON.stringify(rep.legend[key]).includes('"flatten"');
    const discardArea = (rep: DiscardRenderRep) => rep.areas?.find(a => a.label === i18next.t("apgames:validation.gnostica.LABEL_DISCARDS"));

    it("tags a card discarded on the most recent move, tinted the same theme-relative muted colour as a new hand card", () => {
        // A major arcana card specifically - unlike a minor, it gets its
        // own individual legend entry rather than folding into a suit/
        // category bucket (see the next test for that case).
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place n0 U");
        g.hands[0] = ["03", "2C", "3C", "4C", "5C", "6C"];
        g.move(`discard 03 draw 1`); // 1 is max: 6 - 5 remaining
        const rep = g.render().at(-1) as DiscardRenderRep;
        const newKey = `c03`;
        expect(discardArea(rep)?.pieces).to.include(newKey);
        expect(rep.legend[newKey].some(gl => gl.colour !== undefined)).to.be.true;
    });

    it("tints a minor card's whole bucket, with the total count, when any card in it is new", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place n0 U");
        g.discardPile = ["2C"]; // one spot cup already discarded earlier
        g.hands[0] = ["AC", "3C", "4C", "5C", "6C", "7C"];
        g.move("discard AC draw 1"); // a second spot cup, discarded just now; 1 is max: 6 - 5 remaining
        const rep = g.render().at(-1) as DiscardRenderRep;
        expect(discardArea(rep)?.pieces).to.deep.equal(["C_spot_2_shaded"]);
        expect(rep.legend.C_spot_2_shaded.some(gl => gl.text === "2x")).to.be.true;
        expect(isTinted(rep, "C_spot_2_shaded")).to.be.true;
    });

    it("clears once the next move is submitted, even by a different player", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place n0 U");
        g.hands[0] = ["AC", "2C", "3C", "4C", "5C", "6C"];
        g.move("discard AC draw 1"); // 1 is max: 6 - 5 remaining
        g.move("discard draw 0"); // player 2's own turn
        const rep = g.render().at(-1) as DiscardRenderRep;
        expect(discardArea(rep)?.pieces?.some(p => isTinted(rep, p))).to.be.false;
    });

    it("a live preview of the player's own in-progress move highlights discards", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place n0 U");
        g.hands[0] = ["AC", "2C", "3C", "4C", "5C", "6C"];
        g.move("discard AC", { partial: true }); // simulates the player's own first click
        const rep = g.render().at(-1) as DiscardRenderRep;
        expect(discardArea(rep)?.pieces?.some(p => isTinted(rep, p))).to.be.true;
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
        // Must match handleClick's own window exactly (see renderWindow's own docs - territory
        // bounds, not the raw board bounds, which also includes cardless wasteland cells a piece
        // may have been pushed onto) - reusing the game's own private computation directly.
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };

    it("Cups (own): mode button seeds the default step; click-to-orient sets the new piece's facing", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "E"]] }], hands: [filler, filler] });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use AC`);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_own");
        // Trailing "?" - the seeded default facing isn't yet a deliberate choice (mirrors
        // "place"'s identical convention), so a real client's auto-submit-on-complete behaviour
        // doesn't whisk the new piece away before a click can orient it.
        expect(modeClick.move).eq(`use AC/with m0.1 at n0 create U?`);
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(0);
        // Soft-complete says WHY it's holding open, not the bare generic "looks like a valid move".
        expect(modeClick.message).eq(i18next.t("apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT"));
        // n0 itself is already "U", the creation's own still-soft default - confirms it (drops "?",
        // no duplicate token) rather than erroring as a no-op, same as "place"'s own click-to-orient collapse.
        const [row2, col2] = rowColFor(g, 1, 0);
        const sameCell = g.handleClick(modeClick.move, row2, col2);
        expect(sameCell.valid).to.be.true;
        expect(sameCell.move).eq(`use AC/with m0.1 at n0 create U`);
        expect(sameCell.complete).eq(1); // no longer soft - a deliberate confirmation
        expect(sameCell.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
        const [row3, col3] = rowColFor(g, 2, 0); // "o0", east of n0 - sets the new piece's facing
        const east = g.handleClick(modeClick.move, row3, col3);
        expect(east.move).eq(`use AC/with m0.1 at n0 create E`); // any click drops "?" outright
        expect(east.complete).eq(1); // a real correction is a deliberate choice, no longer soft
        // Committing the ORIGINAL, still-soft seed directly - "?" makes no difference to the piece
        // actually created, only to whether it auto-submits.
        g.move(modeClick.move);
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" });
    });

    it("Cups (enemy): one candidate per enemy piece at the target cell - here, the only one", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 1, "W"]] }],
            hands: [filler, filler],
        });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_n0.1");
        expect(modeClick.move).eq(`use AC/with m0.1 at n0 create n0.1`);
        g.move(modeClick.move);
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
    });

    it("Cups (new): target candidate seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const spotUid = "2S";
        const g = testGame({ board: [{ x: -1, y: 0, uid: "AC", pieces: [[1, 1, "W"]] }], hands: [[spotUid, ...filler], filler] });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, -1, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_new");
        expect(modeClick.move).eq(`use AC/with l0.1 at k0 create`);
        // Cell chosen, card uid not yet supplied - genuinely still building (complete:-1), not just
        // soft-pedaled to 0 - a bare hand-typed submission of this exact string must not look valid.
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(-1);
        const cardClick = g.handleClick(modeClick.move, -1, -1, `c${spotUid}`);
        expect(cardClick.move).eq(`use AC/with l0.1 at k0 create ${spotUid}`);
        g.move(cardClick.move);
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): the unified target list offers both the minion itself and whatever's at the facing cell", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "W"]] }],
            hands: [filler, filler],
        });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        g.move(cellClick.move, { partial: true }); // sync engine state, same as a real client's preview flow
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("target_m0.1");
        expect(values).to.include("target_n0.1");
        const selfClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_m0.1");
        expect(selfClick.move).eq(`use AR/with m0.1 move m0.1 1`);
        const faceClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_n0.1");
        expect(faceClick.move).eq(`use AR/with m0.1 move n0.1 1`);
        g.move(selfClick.move); // commit moving itself
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        // n0 already held player 2's piece (pieces[0]) before the move - the mover lands alongside it.
        expect(g.board.get(1, 0)!.pieces[1]).to.deep.include({ owner: 1, orientation: "E" });
    });

    it("Rods (piece): once the target list picks the OTHER piece at the facing cell, ITS distance 1 is directly click-settable (no self-target collision)", () => {
        const g = testGame({
            board: [
                { x: 0, y: 0, uid: "AR", pieces: [[1, 2, "E"]] }, // room to move up to 2
                { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "W"]] },
                { x: 4, y: 0, uid: "AC" }, // keeps p0 wasteland, not void
            ],
            hands: [filler, filler],
        });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const targeted = g.handleClick(cellClick.move, -1, -1, "_btn_target_n0.1");
        expect(targeted.move).eq(`use AR/with m0.2 move n0.1`); // no default - a real distance choice exists
        expect(targeted.complete).eq(-1);
        expect(targeted.message).eq(i18next.t("apgames:validation.gnostica.PICK_DESTINATION_TO_SET_DISTANCE"));
        const [row2, col2] = rowColFor(g, 3, 0); // p0, distance 2 from n0
        const distClick2 = g.handleClick(targeted.move, row2, col2);
        expect(distClick2.move).eq(`use AR/with m0.2 move n0.1 2`);
        // Unlike a self-target (where distance 1 collides with the acting minion's own facing
        // cell), n0's own distance-1 destination (o0) doesn't coincide with anything else.
        const [row1, col1] = rowColFor(g, 2, 0); // o0, distance 1 from n0
        expect(g.handleClick(targeted.move, row1, col1).move).eq(`use AR/with m0.2 move n0.1 1`);
        // Once the distance is chosen, a click no longer changes it (this target is the opponent's, so it has no facing to set either); Undo is how to change it.
        expect(g.handleClick(distClick2.move, row1, col1).move).eq(`use AR/with m0.2 move n0.1 2`);
    });

    it("Rods (tile): the tile candidate defaults to pushing the pointed-at territory 1 space, and seeds distance 1 - a destination click sets any further distance", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AD" }],
            hands: [filler, filler],
        });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_n0");
        expect(modeClick.move).eq(`use AR/with m0.1 move n0 1`);
        g.move(modeClick.move);
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);

        // o0 (dist 1) is wasteland via adjacency to n0 alone; p0 (dist 2) isn't adjacent to any
        // territory once n0 is gone, so it needs its own neighbour card to stay wasteland, not void.
        const g2 = testGame({
            board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD" }, { x: 4, y: 0, uid: "2C" }],
            hands: [filler, filler],
        });
        const seed2 = g2.handleClick("", -1, -1, "_btn_use");
        const [row0, col0] = rowColFor(g2, 0, 0);
        const cellClick2 = g2.handleClick(seed2.move, row0, col0);
        const modeClick2 = g2.handleClick(cellClick2.move, -1, -1, "_btn_target_n0");
        expect(modeClick2.move).eq(`use AR/with m0.2 move n0 1`);
        // Same destination-click mechanism "piece" mode's own distance uses, anchored on the
        // fixed facing cell (n0) instead of a chosen piece target.
        const [row2, col2] = rowColFor(g2, 3, 0); // p0, distance 2 from n0
        const distClick2 = g2.handleClick(modeClick2.move, row2, col2);
        expect(distClick2.move).eq(`use AR/with m0.2 move n0 2`);
        const [row1, col1] = rowColFor(g2, 2, 0); // o0, distance 1 from n0
        const distClick1 = g2.handleClick(distClick2.move, row1, col1);
        expect(distClick1.move).eq(`use AR/with m0.2 move n0 1`);
        g2.move(distClick2.move);
        expect(g2.board.has(1, 0)).eq(false);
        expect(g2.board.get(3, 0)!.card).to.not.eq(undefined);
    });

    it("Discs (piece): the only candidate at the (self) target cell is the minion itself", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AD", pieces: [[1, 1, "U"]] }], hands: [filler, filler] });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_m0.1");
        expect(modeClick.move).eq(`use AD/with m0.1 grow m0.1`);
        g.move(modeClick.move);
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2 });
    });

    describe("hidden deck draws wait for the commit", () => {
        const wheelGame = () => testGame({
            board: [{ x: 0, y: 0, uid: "10", pieces: [[1, 1, "E"]] }],
            hands: [filler, filler],
            drawPile: ["03", "KS"],
            discardPile: ["AC"],
        });
        const drawn = "use 10/with m0.1 at n0 create drawn";

        it("a previewed Wheel of Fortune draw leaves the deck alone and shows the new territory face down", () => {
            const g = wheelGame();
            g.move(drawn, { partial: true });
            expect(g.drawPile).to.deep.equal(["03", "KS"]);
            expect(g.discardPile).to.deep.equal(["AC"]);
            const rep = g.render().at(-1) as unknown as { legend: Record<string, unknown>; pieces: string[][][]; board: { markers: { type: string; glyph?: string; points: { row: number; col: number }[] }[] } };
            expect(g.board.get(1, 0)!.cardUid).eq("");
            expect(rep.pieces[1].length).eq(4); // the window widened to take in the unrevealed territory
            const marker = rep.board.markers.find(m => m.type === "glyph" && m.glyph === "cUNKNOWN")!;
            expect(marker.points).to.deep.equal([{ row: 1, col: 2 }]);
            expect(rep.board.markers.some(m => m.glyph === "c03")).to.be.false; // the drawn card is not on the board
        });

        it("committing it draws the top card, logs it, and leaves nothing unrevealed behind", () => {
            const g = wheelGame();
            g.move(drawn);
            expect(g.board.get(1, 0)!.cardUid).eq("03");
            expect(g.drawPile).to.deep.equal(["KS"]);
            const placed = (g.getPlies().at(-1)!.results as { type: string; what?: string }[]).find(r => r.type === "place");
            expect(placed?.what).eq("03");
        });

        it("a hand card typed for the Wheel is used, and one not in hand is rejected", () => {
            const g = wheelGame();
            g.hands[0] = ["AS", ...filler.slice(1)];
            g.move("use 10/with m0.1 at n0 create AS");
            expect(g.board.get(1, 0)!.cardUid).eq("AS");
            expect(g.drawPile).to.deep.equal(["03", "KS"]);
            expect(wheelGame().validateMove("use 10/with m0.1 at n0 create AS").valid).to.be.false;
        });

        it("a previewed Fool flip and a previewed discard draw leave the deck alone", () => {
            const foolGame = () => testGame({ board: [{ x: 0, y: 0, uid: "00", pieces: [[1, 1, "U"]] }], hands: [filler, filler], drawPile: ["AC", "2C"] });
            const fool = foolGame();
            fool.move("use 00", { partial: true });
            expect(fool.drawPile).to.deep.equal(["AC", "2C"]);
            expect(fool.discardPile).to.deep.equal([]);
            const flipped = foolGame();
            flipped.move("use 00");
            expect(flipped.drawPile).to.deep.equal(["2C"]);
            expect(flipped.discardPile).to.deep.equal(["AC"]);

            const drawGame = () => testGame({ board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }], hands: [["2R", "3R", "4R"], filler], drawPile: ["5R", "6R"] });
            const preview = drawGame();
            preview.move("discard 2R draw 2", { partial: true });
            expect(preview.drawPile).to.deep.equal(["5R", "6R"]);
            const committed = drawGame();
            committed.move("discard 2R draw 2");
            expect(committed.drawPile).to.deep.equal([]);
            expect(committed.hands[0]).to.deep.equal(["3R", "4R", "5R", "6R"]);
        });
    });

    it("Cups (new), Wheel of Fortune: a dedicated button supplies the drawn card, no point-value restriction - a regular Ace of Cups offers no such button, and typing \"drawn\" by hand for it is rejected", () => {
        const majorUid = "03"; // The Empress, worth 3
        const g = testGame({ board: [{ x: 0, y: 0, uid: "10", pieces: [[1, 1, "E"]] }], hands: [filler, filler], drawPile: [majorUid] });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_new");
        expect(modeClick.move).eq(`use 10/with m0.1 at n0 create`);
        g.move(modeClick.move, { partial: true }); // sync engine state, same as a real client's preview flow
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        expect(bar?.buttons?.some(b => b.value === "drawn")).eq(true);

        const randomClick = g.handleClick(modeClick.move, -1, -1, "_btn_drawn");
        expect(randomClick.move).eq(`use 10/with m0.1 at n0 create drawn`);
        const before = g.drawPile.length;
        g.move(randomClick.move);
        expect(g.board.get(1, 0)!.card?.uid).eq(majorUid); // deliberately non-spot, proving no point-value restriction
        expect(g.drawPile.length).to.be.lessThan(before);

        // allowRandomDraw is Wheel of Fortune's own opt, not universal to "new" mode.
        const g2 = testGame({ board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "E"]] }], hands: [filler, filler] });
        const seed2 = g2.handleClick("", -1, -1, "_btn_use");
        const [row2, col2] = rowColFor(g2, 0, 0);
        const cellClick2 = g2.handleClick(seed2.move, row2, col2);
        const modeClick2 = g2.handleClick(cellClick2.move, -1, -1, "_btn_target_new");
        g2.move(modeClick2.move, { partial: true });
        const rep2 = g2.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar2 = rep2.areas?.find(a => a.type === "buttonBar");
        expect(bar2?.buttons?.some(b => b.value === "drawn")).eq(false);
        // The gate is opts.allowRandomDraw (derived from the card's own step definition), not the literal token.
        expect(g2.validateMove(`use AC/with m0.1 at n0 create drawn`).valid).to.be.false;
    });

    it("Swords (piece): with no facing piece to attack (minion is \"up\"), falls back to the minion itself", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 1, "U"]] }], hands: [filler, filler], stashes: { 1: [4, 5, 5], 2: [5, 5, 5] } });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_m0.1");
        expect(modeClick.move).eq(`use AS/with m0.1 shrink m0.1 1`);
        g.move(modeClick.move);
        expect(g.board.get(0, 0)!.pieces.length).eq(0); // 1 pip on a size-1 piece destroys it
        expect(g.stashes.get(1)![0]).eq(5); // returned to its own stash
    });

    // Attacking yourself is almost never what's wanted (unlike Rods' "move self" or Discs' "grow
    // self", both genuinely common choices) - when the minion is facing an enemy, that's the default.
    it("Swords (piece): with a piece in the facing cell, the target list offers attacking THAT instead of just self", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, pieces: [[2, 1, "W"]] }], // n0: no card of its own
            hands: [filler, filler],
            stashes: { 1: [4, 5, 5], 2: [4, 5, 5] },
        });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const targeted = g.handleClick(cellClick.move, -1, -1, "_btn_target_n0.1");
        expect(targeted.move).eq(`use AS/with m0.1 shrink n0.1 1`);
        g.move(targeted.move);
        expect(g.board.get(0, 0)!.pieces.length).eq(1); // the acting player's own minion survives
        // n0 has no card of its own - once its only piece is destroyed, pruneIfEmpty deletes the
        // cell outright, so board.get(1,0) itself becomes undefined, not just empty.
        expect(g.board.get(1, 0)?.pieces.length ?? 0).eq(0); // the enemy piece is destroyed instead
        expect(g.stashes.get(2)![0]).eq(5); // returned to ITS owner's stash
    });

    describe("after a completed power step, the next optional step is announced", () => {
        const setup = (twoCells: boolean): GnosticaGame => testGame({
            board: [
                { x: 0, y: 0, uid: "AR", pieces: twoCells ? [[1, 1, "E"]] : [] },
                { x: 1, y: 0, uid: "AC", pieces: [[1, 2, "E"]] },
                { x: 2, y: 0, uid: "AD", pieces: [[2, 1, "U"]] },
                { x: 3, y: 1, uid: "2C" },
            ],
            hands: [["03", "2S"], filler],
        });
        const barValues = (g: GnosticaGame) =>
            (g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; label: string }[] }[] }).areas!.find(a => a.type === "buttonBar")!.buttons!;

        it("any other board click names the next step instead of raising the finished orient's errors; a fresh play with minions on several cells offers only the minion pick, not the ordinary actions", () => {
            const g = setup(true);
            const move = "play 03/orient n0.2 S";
            for (const [x, y] of [[2, 0], [3, 1]]) {
                const [row, col] = rowColFor(g, x, y);
                const result = g.handleClick(move, row, col);
                expect(result.move).eq(move);
                expect(result.valid).to.be.true;
                expect(result.message).eq(i18next.t("apgames:validation.gnostica.PICK_MINION_CELL"));
            }
            const g2 = setup(true);
            g2.move("play 03", { partial: true });
            // Empress has a different second power, so the minion pick is joined by Skip Power.
            expect(barValues(g2).map(b => b.value)).to.deep.equal(["play", "_spacer", "skip", "declare", "undo"]);
        });
    });

    describe("a reoriented minion stays in the pool alongside its untouched siblings", () => {
        const setup = (): GnosticaGame => testGame({
            board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "W"], [2, 1, "W"], [2, 1, "W"], [2, 2, "N"]] }],
            currplayer: 2,
            hands: [filler, ["03", "2S"]],
        });
        const move = "play 03/orient m0.1.w.2 E";

        it("after orient, the next step's candidates include every own minion in the cell, at its current facing, and the button bar after the partial move lists them all too", () => {
            const g = setup();
            const pending = (g as unknown as { parsePendingStep: (m: unknown) => { advanced?: { minionCandidates: { piece?: Piece }[] } } }).parsePendingStep(g.parseMove(move)).advanced!;
            expect(pending.minionCandidates.map(c => `${c.piece?.size}${c.piece?.orientation}`).sort()).to.deep.equal(["1E", "1W", "2N"]);

            const g2 = setup();
            g2.move(move, { partial: true });
            const buttons = (g2.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; label: string }[] }[] }).areas!.find(a => a.type === "buttonBar")!.buttons!;
            expect(buttons.filter(b => b.value?.startsWith("minion_")).map(b => b.label).sort()).to.deep.equal(["1-pip pointing E", "1-pip pointing W", "2-pip pointing N"]);
        });

        it("every one of those buttons can be clicked, including the reoriented piece and its untouched twin", () => {
            for (const ref of ["m0.1.W", "m0.1.E", "m0.2"]) {
                const g = setup();
                const result = g.handleClick(move, -1, -1, `_btn_minion_${ref}`);
                expect(result.move).eq(`${move}/with ${ref}`);
                expect(result.valid).to.be.true;
            }
        });
    });

    describe("Cups options after picking the final step's minion", () => {
        it("offers Create Minion, a struck-through Create Territory (the cell is already one), and Create Enemy naming the enemy piece's owner", () => {
            const g = testGame({
                board: [
                    { x: 0, y: 0, uid: "AR", pieces: [[2, 1, "E"], [2, 1, "E"], [2, 2, "N"]] },
                    { x: 1, y: 0, uid: "AC", pieces: [[1, 1, "U"]] },
                ],
                currplayer: 2,
                hands: [filler, ["03", "2S"]],
            });
            const move = "play 03/orient m0.1.e.2 N";
            const withMinion = g.handleClick(move, -1, -1, "_btn_minion_m0.1.E");
            g.move(withMinion.move, { partial: true });
            const buttons = (g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; label: string; attributes?: { name: string; value: string }[] }[] }[] }).areas!.find(a => a.type === "buttonBar")!.buttons!;
            expect(buttons.some(b => b.value === "target_own")).to.be.true;
            const enemyBtn = buttons.find(b => b.value === "target_n0.1")!;
            expect(enemyBtn.label).to.eq("Create Enemy Player 1's 1-pip pointing up");
            const territory = buttons.find(b => b.value === "target_new")!;
            expect(territory.attributes).to.deep.include({ name: "text-decoration", value: "line-through" });
        });

        it("choosing a territory target names the hand-card click as the next step (Cups new, Discs tile)", () => {
            addResource("en"); // without resources, every message is empty and the comparisons below would pass vacuously
            const cups = testGame({
                board: [{ x: 1, y: 0, uid: "AC", pieces: [[1, 1, "E"]] }],
                hands: [["03", "2S"], filler],
            });
            expect(cups.handleClick("use AC", -1, -1, "_btn_target_new").message).eq(i18next.t("apgames:validation.gnostica.PICK_CARD_FOR_NEW_TERRITORY"));

            const discs = testGame({
                board: [{ x: 1, y: 0, uid: "AD", pieces: [[1, 1, "E"]] }, { x: 2, y: 0, uid: "2R", pieces: [] }],
                hands: [["KR", "2S"], filler],
            });
            expect(discs.handleClick("use AD", -1, -1, "_btn_target_o0").message).eq(i18next.t("apgames:validation.gnostica.PICK_CARD_TO_GROW_TERRITORY"));
        });

        it("Hermit names the destination click once its target (piece or territory) is chosen", () => {
            addResource("en");
            const g = testGame({
                board: [{ x: 1, y: 0, uid: "09", pieces: [[1, 1, "E"]] }, { x: 2, y: 0, uid: "AR", pieces: [[2, 1, "U"]] }],
                hands: [["03", "2S"], filler],
            });
            const expected = i18next.t("apgames:validation.gnostica.PICK_HERMIT_DESTINATION");
            expect(expected).to.not.eq("");
            expect(g.handleClick("use 09", -1, -1, "_btn_target_o0.1").message).eq(expected);
            expect(g.handleClick("use 09", -1, -1, "_btn_target_o0").message).eq(expected);
        });

        it("Swords lists the acting player's own pieces after the enemy ones", () => {
            const g = testGame({
                board: [{ x: 1, y: 0, uid: "AS", pieces: [[1, 1, "E"]] }, { x: 2, y: 0, uid: "AR", pieces: [[1, 2, "U"], [2, 1, "U"], [2, 3, "U"]] }],
                hands: [["03", "2S"], filler],
            });
            const internal = g as unknown as {
                parsePendingStep: (m: unknown) => { advanced?: object };
                suitTargetCandidates: (pending: object, suitUid: string) => { value: string; label: string }[];
            };
            const pending = internal.parsePendingStep(g.parseMove("use AS")).advanced!;
            const owners = internal.suitTargetCandidates(pending, "S").slice(1).map(c => c.label.includes(" own ") ? "own" : "enemy");
            expect(owners).to.deep.equal(["enemy", "enemy", "own", "own"]);
        });

        // "use AC" activates via a minion standing ON the Cups card itself (n0), which then targets
        // the cell it faces (o0) - unlike the Empress test above, whose minion sits elsewhere.
        it("always names the enemy piece's owner, in both 3+ player and 2-player games", () => {
            const g = testGame({
                board: [{ x: 1, y: 0, uid: "AC", pieces: [[1, 1, "E"]] }, { x: 2, y: 0, uid: "AR", pieces: [[2, 1, "U"], [3, 1, "U"]] }],
                hands: [["03", "2S"], filler, filler],
            });
            const internal = g as unknown as {
                parsePendingStep: (m: unknown) => { advanced?: object };
                suitTargetCandidates: (pending: object, suitUid: string) => { value: string; label: string }[];
            };
            const pending = internal.parsePendingStep(g.parseMove("use AC")).advanced!;
            const enemyLabels = internal.suitTargetCandidates(pending, "C").filter(c => c.value.startsWith("o0.")).map(c => c.label).sort();
            expect(enemyLabels).to.deep.equal(["Create Enemy Player 2's 1-pip pointing up", "Create Enemy Player 3's 1-pip pointing up"]);

            const g2 = testGame({
                board: [{ x: 1, y: 0, uid: "AC", pieces: [[1, 1, "E"]] }, { x: 2, y: 0, uid: "AR", pieces: [[2, 1, "U"]] }],
                hands: [["03", "2S"], filler],
            });
            const internal2 = g2 as unknown as {
                parsePendingStep: (m: unknown) => { advanced?: object };
                suitTargetCandidates: (pending: object, suitUid: string) => { value: string; label: string }[];
            };
            const pending2 = internal2.parsePendingStep(g2.parseMove("use AC")).advanced!;
            const candidates2 = internal2.suitTargetCandidates(pending2, "C");
            expect(candidates2.find(c => c.value === "o0.1")!.label).to.eq("Create Enemy Player 2's 1-pip pointing up");
        });

        it("Create Minion is struck through once the acting player's own stash has no 1-pip piece left, and a click on it does nothing", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }],
                hands: [filler, filler],
                stashes: { 1: [0, 5, 5], 2: [5, 5, 5] },
            });
            g.move("use AC", { partial: true });
            const buttons = (g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] }).areas!.find(a => a.type === "buttonBar")!.buttons!;
            const ownBtn = buttons.find(b => b.value === "target_own")!;
            expect(ownBtn.attributes).to.deep.include({ name: "text-decoration", value: "line-through" });
            expect(isGrey(ownBtn)).to.be.false;
            const click = g.handleClick("use AC", -1, -1, "_btn_target_own");
            expect(click.move).eq("use AC");
            expect(click.message).eq(g.validateMove("use AC").message);
        });
    });

    describe("Swords (tile) click flow: the shrink comes from the replacement card, or the Destroy button", () => {
        // Spot cards are worth 1, courts 2, majors 3.
        const setup = (size: 1 | 2 | 3, territoryUid: string) => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, size, "W"]] }, { x: -1, y: 0, uid: territoryUid }, { x: 1, y: 0, uid: "AR", pieces: [[2, 1, "U"]] }],
                hands: [["AC", "2S", "KS"], filler],
            });
            const seed = g.handleClick("", -1, -1, "_btn_use");
            const [row, col] = rowColFor(g, 0, 0);
            const cellClick = g.handleClick(seed.move, row, col);
            const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_l0");
            return { g, modeClick };
        };
        const buttonValuesOf = (g: GnosticaGame) =>
            (g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] }).areas!.find(a => a.type === "buttonBar")!.buttons!.map(b => b.value);

        it("the target click leaves the shrink open, and a hand-card click derives it; a card needing a bigger shrink than the minion's size is rejected by validation", () => {
            const { g, modeClick } = setup(2, "00"); // major, worth 3
            expect(modeClick.move).eq("use AS/with m0.2 shrink l0");
            expect(modeClick.valid).to.be.true;
            const cardClick = g.handleClick(modeClick.move, -1, -1, "c2S");
            expect(cardClick.move).eq("use AS/with m0.2 shrink l0 2 to 2S");
            g.move(cardClick.move);
            expect(g.board.get(-1, 0)!.card?.uid).eq("2S");

            const { g: g2, modeClick: modeClick2 } = setup(1, "00");
            const cardClick2 = g2.handleClick(modeClick2.move, -1, -1, "c2S");
            expect(cardClick2.move).eq("use AS/with m0.1 shrink l0 2 to 2S");
            expect(g2.validateMove(cardClick2.move).valid).to.be.false;
        });

        it("Destroy Territory wipes it when its value is within the minion's reach, but offers no button when it's beyond reach; Death's shortcut reaches twice the minion's size", () => {
            const { g, modeClick } = setup(2, "QS"); // court, worth 2
            g.move(modeClick.move, { partial: true });
            expect(buttonValuesOf(g)).to.include("destroy");
            const destroyClick = g.handleClick(modeClick.move, -1, -1, "_btn_destroy");
            expect(destroyClick.move).eq("use AS/with m0.2 shrink l0 2");
            g.move(destroyClick.move);
            expect(g.board.get(-1, 0)?.card).to.be.undefined;

            const { g: beyond, modeClick: modeClickBeyond } = setup(1, "QS");
            beyond.move(modeClickBeyond.move, { partial: true });
            expect(buttonValuesOf(beyond)).to.not.include("destroy");

            const death = testGame({
                board: [{ x: 0, y: 0, uid: "13", pieces: [[1, 2, "W"]] }, { x: -1, y: 0, uid: "03" }], // Death, size-2 minion; Empress, worth 3
                hands: [["AC", "2S", "KS"], filler],
            });
            death.move("use 13/with m0.2 shrink l0", { partial: true });
            expect(buttonValuesOf(death)).to.include("destroy");
            const deathDestroy = death.handleClick("use 13/with m0.2 shrink l0", -1, -1, "_btn_destroy");
            expect(deathDestroy.move).eq("use 13/with m0.2 shrink l0 3");
            death.move(deathDestroy.move);
            expect(death.board.get(-1, 0)?.card).to.be.undefined;
        });
    });

    it("narrows the bar to just the selected top-level button, a spacer, then the mode buttons - Declare stays available throughout", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }], hands: [filler, filler] });
        g.move(`use AC`, { partial: true });
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        // The full top-level set (play/orient/discard/pass) is gone, save for the one choice that got us here.
        expect(values).to.not.include("play");
        expect(values).to.not.include("orient");
        expect(values).to.not.include("discard");
        expect(values).to.not.include("pass");
        expect(values[0]).eq("use");
        expect(isGrey(bar!.buttons![0])).to.be.true;
        expect(values[1]).eq("_spacer"); // divider - the schema has no dedicated type for one
        expect(values.slice(2)).to.include("target_own");
        expect(values[values.length - 2]).eq("declare"); // orthogonal end-of-turn flourish, not a step of this choice
    });

    it("offers a target candidate for own/enemy/new, struck through when not currently sensible, and ignores a click on one", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }], hands: [filler, filler] }); // "U" targets itself, a territory with no enemy on it
        g.move(`use AC`, { partial: true });
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; label?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("target_own");
        expect(values).to.include("target_enemy");
        expect(values).to.include("target_new");
        const ownBtn = bar!.buttons!.find(b => b.value === "target_own");
        expect(ownBtn!.attributes).to.be.undefined; // feasible - not struck through
        expect(isGrey(ownBtn)).to.be.false;
        // No enemy piece at the target (self) cell - a struck-through generic placeholder is still
        // offered, matching own/new's own always-present buttons.
        const enemyBtn = bar!.buttons!.find(b => b.value === "target_enemy");
        expect(enemyBtn!.label).to.eq("Create Enemy");
        expect(enemyBtn!.attributes).to.deep.include({ name: "text-decoration", value: "line-through" });
        expect(isGrey(enemyBtn)).to.be.false; // crossed out on white, not greyed
        const newBtn = bar!.buttons!.find(b => b.value === "target_new");
        expect(newBtn!.attributes).to.deep.include({ name: "text-decoration", value: "line-through" }); // "U" targets self, a territory, not a wasteland
        const ownClick = g.handleClick(`use AC`, -1, -1, "_btn_target_own");
        expect(ownClick.valid).to.be.true;
        // A crossed-out button doesn't respond: the move and its status come back unchanged.
        const unchanged = g.validateMove("use AC");
        for (const value of ["target_enemy", "target_new"]) {
            const click = g.handleClick(`use AC`, -1, -1, `_btn_${value}`);
            expect(click.move).eq("use AC");
            expect(click.valid).eq(unchanged.valid);
            expect(click.message).eq(unchanged.message);
        }
    });

    // A live "activate"/"play" preview can only ever have started with board presence, so zero
    // pieces mid-preview is a legitimate mid-action side effect (a Sword step destroying the
    // acting player's own last minion), not a fresh-turn signal - the bar must not collapse to Place.
    it("does not collapse to the Place button mid-preview when a power step destroys the acting player's own last minion", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 1, "U"]] }], hands: [filler, filler] }); // only piece on the board
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_m0.1");
        expect(modeClick.move).eq(`use AS/with m0.1 shrink m0.1 1`); // self-attack, since "U" has no facing cell
        g.move(modeClick.move, { partial: true }); // live preview - destroys the player's only piece
        expect(g.board.get(0, 0)!.pieces.length).eq(0); // confirm the destructive side effect really happened
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.not.deep.equal(["place"]);
        expect(values).to.include("use");
    });

    it("Swords (piece): pips is offered as a button set, not click-cycled, unbolded until one is chosen; clicking one sets it directly", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AS", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 2, "W"]] }],
            hands: [filler, filler],
        });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const targeted = g.handleClick(cellClick.move, -1, -1, "_btn_target_n0.2");
        expect(targeted.move).eq(`use AS/with m0.2 shrink n0.2`); // no default - a real pips choice exists
        expect(targeted.complete).eq(-1);
        expect(targeted.message).eq(i18next.t("apgames:validation.gnostica.PICK_PIPS_BUTTON"));
        const pips2Click = g.handleClick(targeted.move, -1, -1, "_btn_pips_2");
        expect(pips2Click.move).eq(`use AS/with m0.2 shrink n0.2 2`);
        g.move(pips2Click.move);
        expect(g.board.get(1, 0)?.pieces.length ?? 0).eq(0); // destroyed by the full 2 pips
    });

    it("Rods (piece): a click near the destination cell reorients the minion once distance is set; a same-facing click completes the step instead of rejecting", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "E"]] }], hands: [filler, filler] });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_m0.1");
        expect(modeClick.move).eq(`use AR/with m0.1 move m0.1 1`);
        // No reorientation given yet for the acting player's own moved piece - complete:0, and the
        // message says so instead of the generic "looks like a valid move" fallback.
        expect(modeClick.complete).eq(0);
        expect(modeClick.message).eq(i18next.t("apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT"));
        // Effective (post-move) position is n0 - clicking o0 (east of n0) computes E, already the
        // moved piece's current facing. This trailing facing is only optional, so a same-facing
        // click completes the step - exactly as a real correction would - rather than rejecting.
        const [rowSame, colSame] = rowColFor(g, 2, 0); // o0
        const noOp = g.handleClick(modeClick.move, rowSame, colSame);
        expect(noOp.valid).to.be.true;
        expect(noOp.move).eq(`use AR/with m0.1 move m0.1 1`); // unchanged - no token added
        expect(noOp.complete).eq(1);
        // Clicking m0 (west of n0, the vacated origin) sets it to face back W.
        const [rowW, colW] = rowColFor(g, 0, 0); // m0
        const faceW = g.handleClick(modeClick.move, rowW, colW);
        expect(faceW.move).eq(`use AR/with m0.1 move m0.1 1 orient W`);
        expect(faceW.complete).eq(1); // a real, deliberate facing - genuinely complete
        expect(faceW.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
        g.move(faceW.move);
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, orientation: "W" });
    });

    it("Discs (piece): a click near a target that isn't the acting player's own has no orientation effect", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AD", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AR", pieces: [[2, 1, "W"]] }],
            hands: [filler, filler],
        });
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const [rowFace, colFace] = rowColFor(g, 1, 0); // n0, the facing cell
        const targeted = g.handleClick(cellClick.move, -1, -1, "_btn_target_n0.1");
        expect(targeted.move).eq(`use AD/with m0.1 grow n0.1`); // targets the enemy at n0
        // n0 belongs to player 2 - no trailing orientation is offered for an enemy's own piece, so
        // a click there no-ops instead of appending a facing.
        const clickOnTarget = g.handleClick(targeted.move, rowFace, colFace);
        expect(clickOnTarget.move).eq(targeted.move); // unchanged - no facing appended
        expect(clickOnTarget.valid).to.be.false;
    });
});

describe("Gnostica: handleClick - minion disambiguation", () => {
    it("does not offer a minion picker when only one minion is eligible", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U");
        g.move("place l0 U");
        g.move(`use AC`, { partial: true });
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values.some(v => v?.startsWith("minion_"))).to.be.false;
        expect(values).to.include("target_own"); // straight to the target candidates, exactly as before this feature
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
        g.move("place m0 U"); // player 1, "U" - targets itself
        g.move("place l0 U"); // player 2
        g.board.get(0, 0)!.pieces.push(new Piece(1, 1, "U"), new Piece(1, 1, "U")); // fill to capacity (3)
        const result = g.validateMove(`use AC/with m0.1 at m0 create U`);
        expect(result.valid).to.be.false;
        // Compares against CELL_FULL's own real message (whatever it
        // currently is - not hardcoded, since the translation gets filled
        // in independently of this test) rather than the generic
        // INVALID_MOVE fallback ("'...' doesn't look like a valid move.").
        expect(result.message).to.eq(i18next.t("apgames:validation.gnostica.CELL_FULL"));
        expect(result.message).to.not.eq(i18next.t("apgames:validation._general.INVALID_MOVE", { move: `use AC/with m0.1 at m0 create U` }));
    });

    it("does not mutate game state while validating an invalid move", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U");
        g.move("place l0 U");
        const handBefore = [...g.hands[0]];
        const piecesBefore = g.board.get(0, 0)!.pieces.length;
        const discardBefore = g.discardPile.length;
        const result = g.validateMove(`use AC/with m0.1 at m0 create U/with m0.1 at m0 create U`); // MINOR_ONE_STEP_ONLY
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
        g.move(`place ${cornerCell} E`); // player 1, pointing at the untouched cell
        g.move("place l0 U"); // player 2
        const move = `use AC/with ${cornerCell}.1 at ${targetCell} create U`;
        expect(g.validateMove(move).valid).to.be.true;
        expect(() => g.move(move)).to.not.throw();
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
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 U"); // player 2, size 1
        g.board.get(1, 0)!.pieces.push(new Piece(2, 2, "U")); // a second, size-2 piece, also at n0
        const move = `use AR/with m0.1 move n0.1 1`; // "n0.1" - pips alone, no orientation/player needed
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move);
        expect(g.board.get(1, 0)!.pieces.length).to.eq(1); // the size-1 piece moved away
        expect(g.board.get(1, 0)!.pieces[0].size).to.eq(2); // the size-2 piece was untouched
    });

    it("needs orientation too when two same-size pieces at the cell face different ways, and reports ambiguity without it", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 W"); // player 2, size 1, facing W
        g.board.get(1, 0)!.pieces.push(new Piece(2, 1, "N")); // a second size-1 piece, facing N
        // "n0.1" alone still matches both - genuinely ambiguous, not a
        // "pick the first" case (the two pieces differ in orientation).
        expect(g.validateMove(`use AS/with m0.1 shrink n0.1 1`).valid).to.be.false;
        const move = `use AS/with m0.1 shrink n0.1.N 1`; // pips + orientation picks out the N-facing one
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move);
        const remaining = g.board.get(1, 0)!.pieces;
        expect(remaining.length).to.eq(1);
        expect(remaining[0].orientation).to.eq("W"); // the untargeted piece survives
    });

    it("resolves to the first match when two pieces are fully identical, rather than erroring", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 U"); // player 2, size 1, "U"
        g.board.get(1, 0)!.pieces.push(new Piece(2, 1, "U")); // an identical second piece - same owner, size, facing
        const move = `use AS/with m0.1 shrink n0.1 1`; // fully qualifying further (n0.1.U.2) couldn't help either
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move);
        expect(g.board.get(1, 0)!.pieces.length).to.eq(1); // one of the two interchangeable pieces destroyed
    });
});

// parseMove's structural checks: the head keyword and each power
// step's rough shape (legal characters, a plausible token count, a first
// token that at least looks like a piece ref or - the one exception,
// High Priestess - a card uid), all checkable without knowing which
// suit/power is actually involved. That's ALL parseMove itself ever
// rejects now - it reports only `valid: boolean`, no reason. A
// recognized head's own `rest` failing its specific grammar (a bad
// cell, an unknown card uid, ...) is caught only once dispatch reaches
// that head's own validate* function, exactly the same place it always
// had to be checked for legitimate input anyway - see those heads' own
// describe blocks for that coverage.
describe("Gnostica: move-string structural validation", () => {
    before(() => {
        addResource("en");
    });

    it("rejects a step segment containing illegal characters", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U");
        g.move("place l0 U");
        const result = g.validateMove(`use AC/with m0.1 own$ m0 U`);
        expect(result.valid).to.be.false;
    });

    it("rejects a step segment with an unreasonable number of tokens", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U");
        g.move("place l0 U");
        const result = g.validateMove(`use AC/with m0.1 at m0 create U a b c d e f g h i j`);
        expect(result.valid).to.be.false;
    });

    it("rejects a step whose first token isn't shaped like a piece ref or a card uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 U");
        g.move("place l0 U");
        const result = g.validateMove(`use AC/with bogus at m0 create U`);
        expect(result.valid).to.be.false;
    });

    it("accepts a genuinely well-formed step whose first token is the literal 'discard' keyword, not a piece ref or card uid (High Priestess)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const [firstDiscard] = g.hands[0];
        const result = g.validateMove(`use 02/discard ${firstDiscard}`);
        expect(result.valid).to.be.true;
    });

    it("rejects an unrecognized head keyword", () => {
        const g = new GnosticaGame(2);
        const result = g.validateMove("frobnicate m0");
        expect(result.valid).to.be.false;
    });

    // Every non-chained head's own `rest` has a grammar fixed by the head
    // keyword alone (no card/suit to resolve first), but parseMove no
    // longer checks any of it - these are all still correctly rejected,
    // just by that head's own validate* function once dispatch reaches
    // it (see this describe block's own top docs), not by parseMove
    // itself. `valid` alone is what's left to check here; the specific
    // message is each head's own describe block's job.
    it("place: a malformed orientation or cell token is still rejected, just by validatePlace now", () => {
        const g = new GnosticaGame(2);
        expect(g.validateMove("place m0 xyz").valid).to.be.false;
        expect(g.validateMove("place zzz U").valid).to.be.false;
        expect(g.validateMove("place m0 U xyz").valid).to.be.false;
    });

    it("orient: a malformed ref or orientation token is still rejected, just by validateOrient now", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        expect(g.validateMove("orient !!! N").valid).to.be.false;
        expect(g.validateMove("orient m0.1 xyz").valid).to.be.false;
    });

    it("discard: a bad-shaped uid, a duplicate uid, or a non-numeric draw count are still rejected, just by validateDiscard now", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        expect(g.validateMove("discard xx").valid).to.be.false;
        expect(g.validateMove("discard AC AC").valid).to.be.false;
        expect(g.validateMove("discard AC draw abc").valid).to.be.false;
    });

    it("bid: a non-numeric position is still rejected, just by validateBid now", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        expect(g.validateMove("bid abc").valid).to.be.false;
    });

    it("redraw: a bad-shaped or duplicate uid is still rejected, just by validateRedraw now", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.move("bid 1");
        g.move("bid 1"); // resolves the round, entering redraw phase
        expect(g.validateMove("redraw xx").valid).to.be.false;
        expect(g.validateMove(`redraw ${g.hands[0][0]} ${g.hands[0][0]}`).valid).to.be.false; // duplicate
    });

    it("use/play: a bad-shaped card uid is still rejected, just by validateActivate/validatePlay now - but 'as <x>' stays deeper (card-dependent: a suit letter for Magician, a card uid for World)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        expect(g.validateMove("use xx").valid).to.be.false;
        expect(g.validateMove("play xx").valid).to.be.false;
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
        // Must match handleClick's own window exactly (see
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

    it("place: clicking a neighbour replaces the facing with the correction, same generic message", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 1, 0); // n0, east of m0
        const result = g.handleClick("place m0 U", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("place m0 E");
        expect(result.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
    });

    it("orient: clicking a piece to start reorienting it carries the PICK_DIRECTION_TO_ORIENT message/never a facing", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 E");
        g.move("place l0 U");
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("orient", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("orient m0.1"); // selecting the minion never itself assigns a facing
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT"));
    });

    it("orient: a genuine no-op reorientation click (clicking the same cell again) is rejected, carrying the ORIENT_NO_OP message", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // defaults to "U"
        g.move("place l0 U");
        const [row, col] = rowColFor(g, 0, 0);
        const selected = g.handleClick("orient", row, col);
        expect(selected.move).eq("orient m0.1");
        // Clicking the SAME cell again is a real, deliberate "face up"
        // click (see orientationTowardClick's own docs) - not an
        // auto-assigned default - which happens to be a no-op here since
        // the piece already faces "U". Reorienting IS the whole action
        // for "orient", so this is hard-rejected, not held open.
        const result = g.handleClick(selected.move!, row, col);
        expect(result.valid).to.be.false;
        expect(result.move).eq("orient m0.1 U");
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.ORIENT_NO_OP"));
    });

    it("orient: a genuine no-op reorientation is rejected outright at validateMove() too, hand-typed or clicked alike", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 N");
        g.move("place l0 U");
        const result = g.validateMove("orient m0.1 N");
        expect(result.valid).to.be.false;
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
    // click does - and a click confirming that still-soft default (the
    // same direction it's already seeded as) drops the "?" instead of
    // erroring, mirroring place's own identical collapse-back-to-U rule;
    // only a click that actually changes an already-DELIBERATE facing
    // hits ORIENT_NO_OP.
    it("Cups (own): the target candidate's default facing needs no message; a click only changes it, confirming (not rejecting) a same-facing request", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place l0 U"); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_target_own");
        expect(modeClick.move).eq(`use AC/with m0.1 at n0 create U?`);
        // n0 itself - "U" again, already the creation's own still-soft
        // default - confirms it (drops "?", no duplicate token) rather
        // than erroring, since nothing deliberate has been chosen yet.
        const [rowN, colN] = rowColFor(g, 1, 0);
        const sameFacing = g.handleClick(modeClick.move, rowN, colN);
        expect(sameFacing.move).eq(`use AC/with m0.1 at n0 create U`);
        expect(sameFacing.valid).to.be.true;
        expect(sameFacing.complete).eq(1);
        const [rowE, colE] = rowColFor(g, 2, 0); // "o0", east of n0 - a genuine change
        const east = g.handleClick(modeClick.move, rowE, colE);
        expect(east.move).eq(`use AC/with m0.1 at n0 create E`);
        expect(east.valid).to.be.true;
        g.move(east.move);
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "E" });
    });

    it("the Pass button produces the right bare seed and generic message", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
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
        // Must match handleClick's own window exactly (see
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
        g.move("place m0 U");
        g.move("place l0 U");
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`use AC`);
        expect(result.message).eq(chooseStepMsg(aceOfCups().name));
    });

    it("activate: carries the message for a major arcana card too", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(10)); // Wheel of Fortune
        g.move("place m0 U");
        g.move("place l0 U");
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`use 10`);
        expect(result.message).eq(chooseStepMsg(major(10).name));
    });

    it("play: a hand-card click carries the message (minor arcana)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        const uid = g.hands[0].find(u => !/^\d{2}$/.test(u))!; // a minor card
        const result = g.handleClick("play", -1, -1, `c${uid}`);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`play ${uid}`);
        expect(result.message).eq(chooseStepMsg(minorCards.find(c => c.uid === uid)!.name));
    });

    it("play: carries the message for a major arcana card too", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        g.hands[0].push("10"); // Wheel of Fortune, injected regardless of the random deal
        const result = g.handleClick("play", -1, -1, "c10");
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
        g.move("place m0 U");
        g.move("place l0 U");
        forceCardAt(g, 0, 0, () => major(3)); // Empress
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP_ORIENT_MINION", { card: major(3).name, cell: "m0" }));
        expect(result.message).to.not.eq(chooseStepMsg(major(3).name));
    });

    it("activate: orientAny/tradeHands/hierophantReplace name the shared self-or-facing-cell targeting rule, not the generic CHOOSE_STEP", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
        for (const seq of [5, 11, 15]) { // Hierophant, Justice, Devil
            forceCardAt(g, 0, 0, () => major(seq));
            const [row, col] = rowColFor(g, 0, 0);
            const result = g.handleClick("use", row, col);
            expect(result.valid, `seq ${seq}`).to.be.true;
            expect(result.message, `seq ${seq}`).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP_FACING", { card: major(seq).name, cell: "m0" }));
            expect(result.message, `seq ${seq}`).to.not.eq(chooseStepMsg(major(seq).name));
        }
    });

    // Regression: once a card STARTS with 2+ eligible minions (so the minion-picker fires), naming a specific one explicitly
    // (`with <ref>`) must still get the special's own real message - the ambiguity check used to ignore the already-typed ref
    // and re-decide from scratch, finding the pool "still ambiguous" forever and falling through to the generic CHOOSE_STEP
    // wording (whose buttons don't even apply to these click-only specials) no matter which minion was actually picked.
    it("orientMinion/orientAny/hierophantReplace still name their own targeting rule once a specific minion (from an originally-ambiguous pool) is explicitly typed", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "03", pieces: [[1, 1, "E"], [1, 2, "U"]] }], // Empress, 2 eligible minions
            hands: [filler, filler],
        });
        for (const ref of ["m0.1", "m0.2"]) {
            const result = g.validateMove(`use 03/with ${ref}`);
            expect(result.message, ref).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP_ORIENT_MINION", { card: major(3).name, cell: "m0" }));
        }

        const devil = testGame({
            board: [
                { x: 0, y: 0, uid: "15", pieces: [[1, 1, "E"], [1, 2, "U"]] }, // Devil, 2 eligible minions
                { x: 1, y: 0, uid: "AC", pieces: [[2, 1, "U"]] },
            ],
            hands: [filler, filler],
        });
        expect(devil.validateMove("use 15/with m0.2").message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP_FACING", { card: major(15).name, cell: "m0" }));

        const hierophant = testGame({
            board: [
                { x: 0, y: 0, uid: "05", pieces: [[1, 1, "E"], [1, 2, "U"]] }, // Hierophant, 2 eligible minions
                { x: 1, y: 0, uid: "AC", pieces: [[2, 1, "U"]] },
            ],
            hands: [filler, filler],
        });
        expect(hierophant.validateMove("use 05/with m0.2").message).eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP_FACING", { card: major(5).name, cell: "m0" }));
    });

    it("activate: judgementDraw names the discard pile, not the game board, not the generic CHOOSE_STEP", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
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

    it("activate: a primitive-first step, or a special with its own button set (hermitTeleport/magicianChoice), keeps the generic CHOOSE_STEP wording", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U");
        g.move("place l0 U");
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
        g.move("place m0 U");
        g.move("place l0 U");
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
        expect(result.move).eq(`use 21`);
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
        expect(fresh.move).eq(`use 02`);
        expect(fresh.message).eq(round1Msg);

        g.move(`use 02/discard ${discardUid} draw 1`); // step 1: a real discard, pauses on step 2
        expect(g.continued).to.not.be.empty;
        const resumed = g.handleClick("", -1, -1, "_btn_resume_power");
        // High Priestess round 2 resumes as a bare "discard via 02" -
        // its own step IS a discard/draw, so "play 02" would be a lie.
        expect(resumed.move).eq(`discard via 02`);
        expect(resumed.message).eq(round2Msg);
    });

    // A genuine pendingPower obligation shows X's own buttons directly
    // (here, the Draw N count picker) whenever X's own step (like High
    // Priestess's round 2) has real buttons to offer. Unlike the one
    // other pending obligation, High Priestess's own round 2 is not
    // not declinable - so no persisting Decline button here.
    it("a pending High Priestess obligation's own buttons show directly, with no persisting Decline button", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2));
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];
        g.move(`use 02/discard ${discardUid} draw 1`);
        expect(g.continued).to.not.be.empty;

        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; label?: string; attributes?: unknown[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        expect(bar.buttons!.find(b => b.value === "resume_power")).to.be.undefined;
        expect(bar.buttons!.some(b => b.value?.startsWith("hpdraw_"))).to.be.true;
        expect(bar.buttons!.find(b => b.value === "decline_power")).to.be.undefined;
        expect(g.validateMove(`decline via 02`).message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "WRONG_CONTINUED_ACTION" }));
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

        g.move(`use 00`);
        // Fool owes its 2nd flip ("00.1"); the revealed High Priestess is
        // itself a continuing card, so it's tracked too ("02", round 1).
        expect(g.continued).to.deep.equal(["00.1"]);

        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; label?: string }[] }[] };
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
    // resume's own Play/Decline pair - so "click a button" always fits;
    // the card's own real instructions come from the resume_power click,
    // not prepopulated here. The one exception is a player with no piece
    // down yet, who must place.
    it("validateMove(\"\") is the generic click-a-button wording, or place instructions when no piece is down", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];

        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));

        g.move(`use 02/discard ${discardUid} draw 1`); // pauses, awaiting round 2; 1 is max: 6 - 5 remaining
        expect(g.continued).to.not.be.empty;
        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));

        g.move(`discard draw 0 via 02`); // clears the obligation
        expect(g.continued).to.be.empty;
        // Turn has passed to player 2, who has no pieces on the board yet.
        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS_PLACE"));
    });
});

describe("Gnostica: handleClick - major arcana special powers (Phase B)", () => {
    before(() => {
        addResource("en");
    });

    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        // Must match handleClick's own window exactly (see
        // renderWindow's own docs - territory bounds, not the raw
        // board.minX/maxX/minY/maxY, which also includes cardless
        // wasteland cells a piece may have been pushed onto) - reusing
        // the game's own private computation directly rather than
        // duplicating its logic here, so the two can never drift apart.
        const { minX, minY } = (g as unknown as { renderWindow: () => { minX: number; minY: number } }).renderWindow();
        return [y - minY, x - minX];
    };
    const buttonValues = (g: GnosticaGame): (string | undefined)[] => {
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
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

    it("tradeHands: forbids targeting one of the acting player's own pieces - a no-op dressed up as a step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(11)); // Justice
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "U")]; // own piece B, also player 1
        const result = g.validateMove(`use 11/with m0.1 trade n0.1`);
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

    // The facing is a mandatory token, seeded with the captured piece's
    // own prior orientation and "?"-marked until a further click confirms
    // or corrects it - deliberately matching place/Cups "own"'s
    // mandatory-seeded convention for consistency, even though the
    // default here is always derivable from the board (see
    // validateHierophantReplace's own docs).

    it("hierophantReplace: forbids targeting one of the acting player's own pieces - a no-op dressed up as a step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(5)); // The Hierophant
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")]; // own piece B, also player 1
        const result = g.validateMove(`use 05/with m0.1 replace n0.1 U`);
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
        expect(suitClick.move).eq(`use 01 as R`);
        expect(suitClick.valid).to.be.true; // suit chosen, mode not yet - still skipped
        const modeClick = g.handleClick(suitClick.move, -1, -1, "_btn_target_m0.1");
        expect(modeClick.move).eq(`use 01 as R/with m0.1 move m0.1 1`);
        expect(modeClick.valid).to.be.true;
        g.move(modeClick.move);
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
        expect(suitClick.move).eq(`use 01 as R`);
    });

    it("highPriestess: hand-card clicks toggle a discard list (no minionRef at all), committing the explicit draw count chosen via the button bar", () => {
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
        const click1 = g.handleClick(cellClick.move, -1, -1, "c2C");
        expect(click1.move).eq(`use 02/discard 2C`);
        expect(click1.valid).to.be.true;
        // No "draw <n>" chosen yet - never complete without one
        // (see validateHighPriestess's own docs), so a single discard
        // toggle must never read as done.
        expect(click1.complete).eq(-1);
        const click2 = g.handleClick(click1.move, -1, -1, "c5C");
        expect(click2.move).eq(`use 02/discard 2C 5C`);
        expect(click2.complete).eq(-1);
        const click3 = g.handleClick(click2.move, -1, -1, "c2C"); // toggle back off
        expect(click3.move).eq(`use 02/discard 5C`);
        expect(click3.complete).eq(-1);
        const click4 = g.handleClick(click3.move, -1, -1, "_btn_hpdraw_1");
        expect(click4.complete).eq(1); // an explicit draw count IS the player's final word
        g.move(click4.move); // step 1 commits and pauses, awaiting step 2
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(3); // 2 remaining after discarding 5C, plus the 1 explicitly drawn
        expect(g.discardPile).to.include("5C");
        expect(g.currplayer).eq(1); // same seat still owes step 2
        expect(g.continued).to.not.be.empty;
        g.move(`discard draw 0 via 02`); // declines the second highPriestess step
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
        const discardClick = g.handleClick(cellClick.move, -1, -1, "c5C");
        expect(discardClick.move).eq(`use 02/discard 5C`);
        // maxDraw is 6 - 2 (hand after discarding 5C) = 4; choose 1 instead.
        const drawClick = g.handleClick(discardClick.move, -1, -1, "_btn_hpdraw_1");
        expect(drawClick.move).eq(`use 02/discard 5C draw 1`);
        expect(drawClick.valid).to.be.true;
        // A count picked completes the move - tell the player to submit,
        // not the generic "Looks like a valid move" (there's a second
        // round still coming, this being round 1).
        expect(drawClick.message).eq(i18next.t("apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1_READY"));

        g.move(drawClick.move);
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
        const discard1 = g.handleClick(cellClick.move, -1, -1, "c5C");
        const drawClick = g.handleClick(discard1.move, -1, -1, "_btn_hpdraw_1"); // chosen too early
        expect(drawClick.move).eq(`use 02/discard 5C draw 1`);

        const discard2 = g.handleClick(drawClick.move, -1, -1, "cAR");
        expect(discard2.move).eq(`use 02/discard 5C AR`); // stale "draw 1" dropped, AR added
        expect(discard2.valid).to.be.true;

        // The stale count is gone, so a fresh draw choice is needed - the max is now 5 (6 - 1 remaining).
        const drawClick2 = g.handleClick(discard2.move, -1, -1, "_btn_hpdraw_5");
        expect(drawClick2.move).eq(`use 02/discard 5C AR draw 5`);
        g.move(drawClick2.move);
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0]).to.not.include("AR");
        expect(g.hands[0].length).eq(6); // 1 remaining + 5 explicitly drawn, not stuck at the stale count
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
        const play02 = g.handleClick(seed.move, -1, -1, "c02");
        expect(play02.move).eq("play 02");
        const discard1 = g.handleClick(play02.move, -1, -1, "c2C");
        const discard2 = g.handleClick(discard1.move, -1, -1, "c5C");
        expect(discard2.move).eq("play 02/discard 2C 5C");

        // Hand is genuinely down to 3 (6 - the played card - 2 discards),
        // so drawing 3 is legal; drawing 4 is not.
        const draw3 = g.handleClick(discard2.move, -1, -1, "_btn_hpdraw_3");
        expect(draw3.move).eq("play 02/discard 2C 5C draw 3");
        expect(draw3.valid).to.be.true;

        g.move(draw3.move);
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
        preview.move(`use 02/discard 5C`, { partial: true }); // exactly what a live client preview does
        expect(preview.hands[0]).to.not.include("5C"); // discarded for real...
        expect(preview.hands[0].length).eq(2); // ...but NOT yet redrawn back to 6
        // A partial preview never persists a continuation - see
        // this.continued's own docs - so nothing is owed until the real
        // submit below.
        expect(preview.continued).to.be.empty;
        expect(preview.currplayer).eq(1);

        const g = setup();
        g.move(`use 02/discard 5C draw 4`); // the real, final submit (4 is max: 6 - 2 remaining)
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6); // now genuinely redrawn
        expect(g.continued).to.not.be.empty; // step 1 of 2 - still owes the second flip
    });

    // High Priestess is the one exception - unlike the others above, its
    // own draw count IS a real player choice (see the ordinary discard/draw
    // action's own ROOT_ARGS analogue), so it gets the same count-picker
    // button set that action already has, offered as soon as the step is
    // live and no count has been chosen yet.

});

// #47: chatLog() naming the OTHER player involved in a power, not just the
// acting player - see gnostica.ts's own otherPlayerName() docs.
describe("Gnostica: discard/draw chat messages", () => {
    before(() => {
        addResource("en");
    });

    it("omits the discard line entirely when nothing was discarded, rather than 'X discarded .'", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2
        g.move("discard draw 0"); // discards nothing, draws back up to 6
        const log = g.chatLog(["Alice", "Bob"]);
        const lastNode = log[log.length - 1];
        expect(lastNode.some(l => l.includes("discarded"))).eq(false);
        expect(lastNode.some(l => l.includes("drew"))).eq(true);
    });

    it("explicitly says '0' when drawing nothing, rather than a bare 'X drew'", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2
        g.hands[0] = ["AC", "2C", "3C", "4C", "5C", "6C"]; // already at max
        g.move("discard draw 0"); // discards nothing, hand already full - draws 0
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

    it("destroy (Swords piece): names whose minion was destroyed", () => {
        const g = new GnosticaGame(2);
        clearBoard(g); // fully deterministic - see clearBoard's own docs
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 W"); // player 2, small piece, on the targeted cell
        g.move(`use AS/with m0.1 shrink n0.1 1`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("destroyed"));
        expect(line).eq(i18next.t("apresults:DESTROY.gnostica_piece", { player: "Alice", what: "1", target: "Bob" }));
    });

    it("convert, not destroy (Swords piece): an enemy minion that survives an attack, merely shrunk, is not logged as destroyed - and names whose it is", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 W"); // player 2
        g.board.get(1, 0)!.pieces[0] = new Piece(2, 2, "W"); // grow it to 2 pips first
        g.move(`use AS/with m0.1 shrink n0.2 1`);
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
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 W"); // player 2, elsewhere
        g.board.get(0, 0)!.pieces[0] = new Piece(1, 2, "E"); // grow the acting minion itself to 2 pips
        g.move(`use AS/with m0.2 shrink m0.2 1`);
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 1 }); // survived, shrunk
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("shrank"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_piece_shrink_own", { player: "Alice", into: "size 1", where: "m0" }));
    });

    it("convert (Discs piece): names whose piece was grown, when it isn't the acting player's own", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 W"); // player 2, on the targeted cell
        g.move(`use AD/with m0.1 grow n0.1 orient W`);
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, size: 2 });
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("grew"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_piece", { player: "Alice", into: "size 2", where: "n0", target: "Bob" }));
    });

    it("convert (Discs piece): no target named for the acting player's own minion", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2
        g.move(`use AD/with m0.1 grow m0.1 orient N`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("grew"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_piece_own", { player: "Alice", into: "size 2", where: "m0" }));
    });

    it("destroy (Swords tile): names the destroyed card, not a raw uid", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords()); // m0, 1 pip
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0, worth 1 - exactly destroyed by 1 pip
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place l0 U"); // player 2, elsewhere
        g.move(`use AS/with m0.1 shrink n0 1`);
        expect(g.board.get(1, 0)?.card).eq(undefined); // territory genuinely destroyed, not just shrunk
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("destroyed"));
        expect(line).eq(i18next.t("apresults:DESTROY.gnostica_tile", { player: "Alice", what: withArticle(aceOfDiscs().name), where: "n0" }));
    });

    it("convert, not destroy (Swords tile): a territory that survives an attack, replaced by a new card, is logged as shrunk - not destroyed", () => {
        const g = new GnosticaGame(2);
        clearBoard(g);
        forceCardAt(g, 0, 0, () => aceOfSwords()); // m0, 1 pip
        const oldUid = "KS"; // King of Swords, worth 2
        forceCardAt(g, 1, 0, () => card("KS")); // n0
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place l0 U"); // player 2, elsewhere
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        g.move(`use AS/with m0.1 shrink n0 1 to ${spotUid}`);
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
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 W"); // player 2, on the targeted cell
        g.move(`use AR/with m0.1 move n0.1 1 orient U`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("moved"));
        expect(line).eq(i18next.t("apresults:MOVE.gnostica_rod_piece", { player: "Alice", what: "1", from: "n0", to: "o0", target: "Bob" }));
    });

    it("move (Rods piece): no target named for the acting player's own minion", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E"); // player 1
        g.move("place l0 U"); // player 2
        g.move(`use AR/with m0.1 move m0.1 1 orient N`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("moved"));
        expect(line).eq(i18next.t("apresults:MOVE.gnostica_rod_piece_own", { player: "Alice", what: "1", from: "m0", to: "n0" }));
    });

    it("place (Cups enemy): names whose own stash the new piece came from", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 W"); // player 2, on the targeted cell
        g.move(`use AC/with m0.1 at n0 create n0.1`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("added a new piece"));
        expect(line).eq(i18next.t("apresults:PLACE.gnostica_enemy", { player: "Alice", where: "n0", target: "Bob" }));
    });

    // Regression: neither checkCreateOwn nor checkCreateEnemy verified the
    // relevant player's own stash had a small left before createOwn/
    // createEnemy's own takeFromStash call ran - an empty stash reached
    // validateMove() with no complaint at all, only to throw once a
    // commit actually tried to apply it.
    it("Cups (own): validateMove() itself rejects when the acting player's own stash is empty", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place l0 U"); // player 2
        g.stashes.get(1)![0] = 0; // drain player 1's own smalls
        const validated = g.validateMove(`use AC/with m0.1 at n0 create U`);
        expect(validated.valid).to.be.false;
        expect(validated.message).to.eq(i18next.t("apgames:validation.gnostica.STASH_EMPTY", { playerNum: 1, size: 1 }));
    });

    it("Cups (enemy): validateMove() itself rejects when the TARGETED enemy's own stash is empty", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place n0 W"); // player 2, on the targeted cell
        g.stashes.get(2)![0] = 0; // drain player 2's (the victim's) own smalls
        const validated = g.validateMove(`use AC/with m0.1 at n0 create n0.1`);
        expect(validated.valid).to.be.false;
        expect(validated.message).to.eq(i18next.t("apgames:validation.gnostica.STASH_EMPTY", { playerNum: 2, size: 1 }));
    });

    it("convert (Hierophant replace): names whose piece was displaced", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(5)); // The Hierophant
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, player 1, facing n0
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "S")]; // enemy B, player 2, facing S
        g.move(`use 05/with m0.1 replace n0.1 U`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("converted"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_hierophant_target", { player: "Alice", where: "n0", target: "Bob" }));
    });

    it("orient: no target named for an ordinary turn action (always the acting player's own piece)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2
        g.move("orient m0.1 N");
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("oriented"));
        expect(line).eq(i18next.t("apresults:ORIENT.gnostica_own", { player: "Alice", where: "m0", what: "1", facing: "N" }));
    });

    it("use (activating a card already on the board): names the card/not a raw uid", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place l0 U"); // player 2
        g.move(`use AC/with m0.1 at n0 create U`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("used"));
        expect(line).eq(i18next.t("apresults:USE.gnostica", { player: "Alice", what: withArticle(aceOfCups().name) }));
    });

    it("deckDraw (playing a card from hand): names the card, not a raw uid", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 U"); // player 1
        g.move("place l0 U"); // player 2
        g.hands[0].push("AC");
        g.move(`play AC/with m0.1 at m0 create U`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("played"));
        expect(line).eq(i18next.t("apresults:DECKDRAW.gnostica_hand", { player: "Alice", what: withArticle(aceOfCups().name) }));
    });

    it("convert (Discs tile grow-replace): names both the replaced and the new card, not raw uids", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfDiscs());
        g.board.get(1, 0)!.card = card("2C"); // n0, a known worth-1 spot card
        g.move("place m0 E"); // player 1, pointing at n0
        g.move("place l0 U"); // player 2
        const royaltyUid = "KS"; // King of Swords, worth 2
        g.hands[0].push(royaltyUid);
        g.move(`use AD/with m0.1 grow n0 to ${royaltyUid}`);
        const log = g.chatLog(["Alice", "Bob"]);
        const line = log.flat().find(l => l.includes("grew the territory"));
        expect(line).eq(i18next.t("apresults:CONVERT.gnostica_tile", { player: "Alice", what: withArticle(card("2C").name), into: withArticle(card(royaltyUid).name), where: "n0" }));
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
        g.move(`use 02/discard 5C draw 4`); // step 1: discard 5C, redraw to 6, pauses; 4 is max: 6 - 2 remaining
        expect(g.continued).to.not.be.empty;
        expect(g.currplayer).eq(1); // same seat still owes step 2
        g.move(`discard draw 0 via 02`); // step 2: decline (discard nothing)
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
        g.move(`use 02/discard 5C draw 4`); // 4 is max: 6 - 2 remaining
        expect(g.currplayer).eq(1);
        expect(g.continued).to.not.be.empty;
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6);
        g.move(`discard AR draw 1 via 02`); // step 2: discard AR instead of declining; 1 is max: 6 - 5 remaining
        expect(g.continued).to.be.empty;
        expect(g.currplayer).eq(2);
        expect(g.hands[0]).to.not.include("AR");
        expect(g.hands[0].length).eq(6); // redrawn back up again
    });

    // A resume submission (validateMove only - a {trusted: true} caller is
    // trusted to have validated already, per feedback_no_trusted_path_defense)
    // must carry a matching " via <root>" anchor AND spell the head that
    // fits what it's doing: "decline" to give the active card up, "discard"
    // for a High Priestess round. The click UI never gets any of this
    // wrong, so every rejection is a malformed hand-edit -> INVALID_MOVE.
    it("resume-mismatch guards reject a wrong card uid or a wrong head word", () => {
        const g = setupHP();
        g.hands[0] = ["2C", "5C", "AR"];
        g.move(`use 02/discard 5C draw 4`); // 4 is max: 6 - 2 remaining
        expect(g.continued).to.not.be.empty;
        // Wrong anchor (the Fool, a real continuing card, but not the
        // High Priestess round actually pending) / missing anchor.
        expect(g.validateMove("decline 00 via 00").valid).to.be.false;
        expect(g.validateMove("use 00/decline").valid).to.be.false;
        // Right anchor, wrong head ("play"/"use", or "decline" - a High
        // Priestess round is always a "discard", never declined; to do
        // nothing you discard and draw 0) -> rejected.
        expect(g.validateMove(`play 02 via 02/discard AR`).valid).to.be.false;
        expect(g.validateMove(`use 02/decline`).valid).to.be.false;
        expect(g.validateMove(`decline via 02`).valid).to.be.false;
        // The canonical spellings work.
        expect(g.validateMove(`discard AR via 02`).valid).to.be.true;
        expect(g.validateMove(`discard draw 0 via 02`).valid).to.be.true;
        // None of the rejected attempts cleared the obligation.
        expect(g.continued).to.not.be.empty;
        expect(g.currplayer).eq(1);
    });

    it("a bare 'decline' with nothing pending is rejected outright", () => {
        const g = setupHP();
        expect(g.continued).to.be.empty;
        const validated = g.validateMove(`decline 02 via 02`);
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
    // "Play Card X" click first - see getActionButtons()'s own docs), with
    // a persisting "Decline X" always folded in alongside them - even for
    // a Rods card whose every eligible minion is upright (Rods rejects
    // upright minions for every mode), so the player always has a way
    // back out.
    it("a revealed Rods card with only upright minions leaves every mode struck through, but the persisting Decline button is still there", () => {
        const g = setupFool();
        pluckCard(g, "2R");
        g.drawPile.unshift("2R"); // force the flip to reveal 2 of Rods
        g.move(`use 00`);
        // Only Fool's own remaining flip persists; the revealed 2R is
        // re-derived from the resume submission's own head arg.
        expect(g.continued).to.deep.equal(["00.1"]);

        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; label?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        // Rods' own target candidates show directly - no "Play Card 2R"
        // click needed first - and every one is struck through, since
        // Fool's own minion (the only eligible one) is upright.
        const modeButtons = bar.buttons!.filter(b => b.value?.startsWith("target_"));
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
    it("a revealed minor card whose own eligible pool spans 2+ cells shows the paused Play/Decline pair, not the ordinary top-level bar", () => {
        const g = setupFool();
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "U")]; // a second minion for player 1, a different cell than Fool's own
        pluckCard(g, "10D");
        g.drawPile.unshift("10D");
        g.move(`use 00`);
        expect(g.continued).to.deep.equal(["00.1"]);
        expect(buttonValues(g)).to.deep.equal(["resume_power", "decline_power", "undo"]);
    });

    it("World rejects a self-reference and an off-board target", () => {
        const selfRef = new GnosticaGame(2);
        forceCardAt(selfRef, 0, 0, () => theWorld());
        selfRef.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const selfRefResult = selfRef.validateMove(`use 21 as 21`);
        expect(selfRefResult.valid).to.be.false;
        expect(selfRefResult.message).to.eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "WORLD_NOT_SELF" }));

        const offBoard = new GnosticaGame(2);
        forceCardAt(offBoard, 0, 0, () => theWorld());
        offBoard.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        // The random initial deal could otherwise occasionally have
        // already placed Lovers somewhere on the board too.
        for (const [x, y, t] of offBoard.board.entries()) {
            if ((x !== 0 || y !== 0) && t.card?.uid === "06") {
                t.card = undefined;
            }
        }
        const offBoardResult = offBoard.validateMove(`use 21 as 06`); // Lovers isn't on the board
        expect(offBoardResult.valid).to.be.false;
    });

    it("Fool flips a forced major -> pauses; resuming Lovers' own two steps also auto-continues Fool's own second (mandatory) flip", () => {
        const g = setupFool();
        pluckCard(g, "06");
        g.drawPile.unshift("06"); // force the flip to reveal The Lovers
        pluckCard(g, "AS");
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0 - own piece B
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")];
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, facing n0

        g.move(`use 00`);
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
        g.move(`play 06 via 00/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U`);
        expect(g.continued).to.not.be.empty;
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.currplayer).eq(1); // still paused - the turn hasn't passed yet
        expect(g.board.get(2, 0)!.pieces.length).eq(2); // Lovers' own steps DID take effect

        // Declining the second reveal's own power now fully resolves the
        // whole activation in one more submission (Fool's frame is
        // already spent, so nothing is left to auto-continue).
        g.move(`decline AS via 00`);
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

        g.move(`use 00`);
        expect(g.continued).to.deep.equal(["00.1"]);
        g.drawPile.unshift("AS"); // force what Fool's own automatic second flip reveals
        g.move(`play AC via 00/with m0.1 at m0 create U`);
        expect(g.continued).to.not.be.empty; // Fool's own second flip auto-fired, in the same submission
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.currplayer).eq(1);
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // Fool's own minion, plus the new Cups piece

        g.move(`decline AS via 00`);
        expect(g.continued).to.be.empty;
        expect(g.currplayer).eq(2);
    });

    // A two-stage special (magicianChoice, hermitTeleport) that Fool
    // reveals must be click-driven from the very first click, when nothing
    // has been clicked yet THIS turn - movebox.value is still "" (untouched
    // since the last real commit). handleClick's own parsePendingStep
    // calls need pendingPower's root seeded in for them in this case.
    it("a revealed Magician's own suit buttons are click-driven even before anything else has been clicked this turn", () => {
        const g = setupFool();
        pluckCard(g, "01");
        pluckCard(g, "AS");
        g.drawPile.unshift("01"); // force the flip to reveal The Magician
        g.move(`use 00`);
        expect(g.continued).to.deep.equal(["00.1"]);

        const suitClick = g.handleClick("", -1, -1, "_btn_magician_C");
        expect(suitClick.valid).to.be.true;
        expect(suitClick.move).eq(`play 01 as C via 00`);

        // Syncing the engine to this still-incomplete segment (suit
        // chosen, mode not yet - same as the playground's own preview flow
        // between every click) must neither silently complete the step
        // early nor lose track of the suit already chosen - the bar should
        // show CUPS' OWN mode buttons directly, not the suit-picker again,
        // and no "Decline 01": choosing the suit already began playing it.
        g.move(suitClick.move, { partial: true });
        // Cups' own target candidates: "own"/"new" always, no enemy
        // candidate at all here (Fool's minion, facing U, targets itself -
        // no enemy piece there to offer one for).
        expect(buttonValues(g)).to.include.members(["target_own", "target_new"]);
        expect(buttonValues(g)).to.not.include("magician_R");
        expect(buttonValues(g)).to.not.include("decline_power");

        const modeClick = g.handleClick(suitClick.move, -1, -1, "_btn_target_own");
        expect(modeClick.valid).to.be.true;

        // Once Magician's own power genuinely completes (via this same
        // partial sync), Fool's own next flip becomes the active step -
        // mandatory, not optional (see walkFrameStack's own docs) - so
        // there is nothing left to decline here at all.
        g.move(modeClick.move, { partial: true });
        expect(buttonValues(g)).to.not.include("decline_power");

        g.drawPile.unshift("AS"); // force what Fool's own automatic second flip reveals
        g.move(modeClick.move);
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

        g.move(`use 00`);
        expect(g.continued).to.deep.equal(["00.1"]);

        g.drawPile.unshift("AD");
        g.move(`decline AC via 00`); // decline AC's own step
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
    // bar only ever offers "Play Card X"/"Decline X" for a flip still at
    // its own nextStepIndex 0 - see powerStepMessageKey's own docs) - a
    // real dead end for the player.
    it("an implicitly-skipped tail step (no legal tradeHands target) also auto-continues Fool's own mandatory second flip", () => {
        const g = setupFool();
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // a real facing - Rods' own move step needs one
        forceCardAt(g, 1, 0, () => aceOfDiscs()); // n0 - the territory Hanged Man's own move step pushes
        pluckCard(g, "12");
        g.drawPile.unshift("12"); // force the flip to reveal The Hanged Man
        g.move(`use 00`);
        expect(g.continued).to.deep.equal(["00.1"]);

        g.drawPile.unshift("AS"); // whatever Fool's own second flip reveals next
        // Only step 1 (the push) is typed - no enemy exists anywhere to
        // trade hands with, so step 2 is left entirely unaddressed rather
        // than explicitly declined.
        g.move(`play 12 via 00/with m0.1 move n0 1`);
        expect(g.board.has(1, 0)).eq(false); // the push actually happened
        expect(g.continued).to.not.be.empty;
        // tradeHands never even shows up on the stack - it's popped by
        // the same implicit-skip branch that walked straight into
        // Fool's own next mandatory flip within this SAME submission.
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.discardPile).to.include.members(["12", "AS"]);
        expect(g.currplayer).eq(1);
    });

    // Instead of the generic VALID_MOVE fallback, a tail step that
    // genuinely cannot be completed (no enemy anywhere for tradeHands to
    // reach) gets an explicit heads-up that it will be skipped - true
    // whether Hanged Man was activated directly or reached via the Fool's
    // own reveal, and whether or not the tradeHands step's own card is the
    // acting player's LAST step (Justice: tradeHands then attack) - see
    // specialStepHasNoLegalTarget's own docs.

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

        g.move("play 00");
        // Outer Fool still owes its 2nd flip ("00.1"); the inner
        // self-revealed Fool owes both of its own ("00.0" on top).
        expect(g.continued).to.deep.equal(["00.1"]);
    });

    it("Fool suicide: self-destroying your only minion mid-chain still leaves Decline available, not blocked by MUST_PLACE_FIRST", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")]; // player 1's ONLY minion
        pluckCard(g, "00");
        for (const [, , t] of g.board.entries()) {
            if (t.card?.uid === "00") t.card = undefined;
        }
        g.hands[0].push("00");
        pluckCard(g, "AS");
        pluckCard(g, "2S");
        g.drawPile.unshift("AS", "2S"); // first flip reveals AS, second reveals 2S

        g.move("play 00");
        expect(g.continued).to.deep.equal(["00.1"]);

        // Resolving AS by self-attacking the last minion to 0 also auto-fires
        // Fool's mandatory second flip (revealing 2S) within this same call.
        g.move(`play AS via 00/with m0.1 shrink m0.1 1`);
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.eligibleMinionsForPlay()).to.deep.equal([]);

        // The player now has zero minions and a pending reveal (2S) that
        // needs one - reusing the destroyed piece's stale ref is rejected,
        // not silently accepted.
        const badAttempt = g.validateMove(`play 2S via 00/with m0.1 shrink m0.1 1`);
        expect(badAttempt.valid).to.be.false;

        // Declining the unresolvable reveal must still work - MUST_PLACE_FIRST
        // (which fires for a fresh, non-resume head once hasPieces is false)
        // must not leak into this resume path.
        const declineResult = g.validateMove("decline 2S via 00");
        expect(declineResult.valid).to.be.true;
        expect(declineResult.complete).to.equal(1);
        g.move("decline 2S via 00");
        expect(g.continued).to.deep.equal([]);
        expect(g.currplayer).to.equal(2);
    });

    it("resume-mismatch guards are keyed on the innermost obligation, not an outer one still on the stack", () => {
        // Fool reveals the High Priestess; resuming its round 1 leaves
        // continued = ["00.1", "02"] - the Fool still owes its own second
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

        g.move(`use 00`); // flip reveals the High Priestess
        expect(g.continued).to.deep.equal(["00.1"]);
        g.hands[0] = ["2C", "5C", "AR"];
        g.move("play 02 via 00/discard 5C draw 1"); // High Priestess round 1
        expect(g.continued).to.deep.equal(["00.1", "02"]);

        // " via 00" names the buried Fool, not the active round 2 -> rejected.
        expect(g.validateMove("decline 00 via 00").valid).to.be.false;
        expect(g.continued).to.deep.equal(["00.1", "02"]);
        // The correct anchor works (a High Priestess round is a "discard").
        expect(g.validateMove("discard draw 0 via 02").valid).to.be.true;
    });

    it("Fool's own root activation needs no button - selecting it already produces a complete, submittable move", () => {
        const g = setupFool();
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq(`use 00`);
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
        const rep = preview.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const useBtn = bar.buttons!.find(b => b.value === "use")!;
        expect(isGrey(useBtn)).to.be.true;

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
        g.move("place m0 U");
        g.move("place l0 U");
        g.hands[0].push("00"); // Fool, injected regardless of the random deal

        g.move("play 00", { partial: true });
        expect(buttonValues(g)).to.not.include("decline_power");
        const rep = g.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const playBtn = bar.buttons!.find(b => b.value === "play")!;
        expect(isGrey(playBtn)).to.be.true;
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
        g.move(`use 00`);
        expect(g.continued).to.not.be.empty;

        const declined = g.handleClick("", -1, -1, "_btn_decline_power");
        expect(declined.move).eq(`decline AC via 00`);
        expect(declined.valid).to.be.true;
        // Declining exposes Fool's own mandatory, one-shot 2nd flip -
        // nothing to reconsider, genuinely complete:1.
        expect(declined.complete).to.eq(1);
        expect(declined.message).to.eq(i18next.t("apgames:validation.gnostica.DECLINE_THEN_AUTO_DRAW"));

        const preview = setupFool();
        pluckCard(preview, "AC");
        preview.drawPile.unshift("AC");
        preview.move(`use 00`);
        preview.move(declined.move, { partial: true });
        // No button for Fool's own (automatic) flip, and none of the ordinary
        // actions - they were never options with a flip owed - so just Declare
        // and the decline of AC (the card that WAS actually drawn), which
        // stays, greyed, as the choice already made.
        expect(buttonValues(preview)).to.not.include("power_fool");
        expect(buttonValues(preview)).to.deep.equal(["declare", "decline_power", "undo"]);
        const rep = preview.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; label?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas!.find(a => a.type === "buttonBar")!;
        const declineBtn = bar.buttons!.find(b => b.value === "decline_power")!;
        expect(declineBtn.label).eq("Decline AC");
        expect(isGrey(declineBtn)).to.be.true;
    });

    // Same message, computed directly by validateFrameStack itself now -
    // a hand-typed "decline AC via 00" gets DECLINE_THEN_AUTO_DRAW
    // without ever going through the click handler above.
    it("a hand-typed decline of a revealed card also names the automatic second flip", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use 00`);

        const validated = g.validateMove(`decline AC via 00`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).to.eq(1);
        expect(validated.message).to.eq(i18next.t("apgames:validation.gnostica.DECLINE_THEN_AUTO_DRAW"));
    });

    // Right after a real flip the status line is the generic "click a
    // button" wording (a Play/Decline pair is on the bar); clicking "Use
    // Card X" (resume_power) is what surfaces the revealed card's own
    // real instructions, naming it explicitly rather than forcing the
    // player to check the chat log.
    it("Fool's real flip: the Play Card click names the revealed card in the message", () => {
        const g = setupFool();
        pluckCard(g, "AC");
        g.drawPile.unshift("AC");
        g.move(`use 00`); // real, non-partial commit - actually flips
        expect(g.continued).to.not.be.empty;
        const acName = minorCards.find(c => c.uid === "AC")!.name;
        expect(g.validateMove("").message).to.eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));

        const resumed = g.handleClick("", -1, -1, "_btn_resume_power");
        expect(resumed.move).eq(`play AC via 00`);
        // A minor card's own synthesized primitive step is a fresh (step
        // 0) choice - CHOOSE_STEP is the right message key, now naming AC.
        expect(resumed.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: acName }));
    });

    // A resumed/pushed frame is never mandatory the way #49's ROOT-only
    // rule is - a bare-but-non-empty resume string must not fall back to
    // that root-only wording.
    it("validating a bare resume (no steps typed yet) names the revealed card, not the #49 root-only wording", () => {
        const g = setupFool();
        pluckCard(g, "01"); // Magician
        g.drawPile.unshift("01");
        g.move(`use 00`);

        const bare = g.validateMove(`play 01 via 00`);
        expect(bare.valid).to.be.true;
        expect(bare.complete).to.eq(-1);
        expect(bare.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: major(1).name }));
    });

    // Same, one click later - validateFrameStack's own "given segment is
    // still incomplete" fallback must not fall back to the root-only
    // wording either, e.g. once Fool reveals the Magician, Cups is chosen
    // (via "as"), and its own "own" mode is picked but not yet complete.
    it("validating a still-incomplete resumed step (a real segment given, but not enough of one) also names the card", () => {
        const g = setupFool();
        pluckCard(g, "01"); // Magician
        g.drawPile.unshift("01");
        g.move(`use 00`);

        const modeChosen = g.validateMove(`play 01 as C via 00/with m0.1 at m0 create`); // suit + mode chosen, orientation not yet
        expect(modeChosen.valid).to.be.true;
        expect(modeChosen.complete).to.eq(-1);
        expect(modeChosen.message).to.eq(i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: major(1).name }));
    });

    // Declining a revealed card's own power exposes Fool's own remaining
    // flip underneath (see walkFrameStack's own "lastWasExplicitDecline"
    // docs) - the click PREVIEW of that decline must recognize this as a
    // complete, submit-ready move (see reachedViaDecline's own docs), not
    // fall back to the generic top-level bar and a bare "Looks like a
    // valid move" message as if it were a fresh/mandatory activation.

    // Once genuinely paused (Fool's own reveal of a click-driven special,
    // here the World), the bar drops the ordinary 6 buttons entirely
    // (none legal - validateMove would reject every one with PENDING_
    // POWER_NEEDS_CONTINUE) and shows a self-contained Play/Decline pair
    // instead. Clicking "Play Card" surfaces the World's own real target
    // instructions; a direct board click still works too.
    it("Fool reveals World: the bar drops to a Play/Decline pair, and clicking Play gives real target instructions", () => {
        const g = setupFool();
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        forceCardAt(g, 1, 0, () => major(1)); // a real target for World to use
        pluckCard(g, "21");
        g.drawPile.unshift("21");
        g.move(`use 00`);
        expect(g.continued).to.deep.equal(["00.1"]);

        expect(g.validateMove("").message).eq(i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS"));
        expect(buttonValues(g)).to.deep.equal(["resume_power", "decline_power", "undo"]);
        expect(g.handleClick("", -1, -1, "_btn_resume_power").message).eq(i18next.t("apgames:validation.gnostica.WORLD_CHOOSE_TARGET"));

        // A direct board click on the target still works too.
        const [rowN, colN] = rowColFor(g, 1, 0);
        const targetClick = g.handleClick("", rowN, colN);
        expect(targetClick.valid).to.be.true;
        expect(targetClick.move).eq(`play 21 as 01 via 00`);
    });

    // Regression: World's own frame push (isWorldStep, tokens=[]) used to
    // run before the decline-check ever got a look at the segment, so a
    // genuine decline of a Fool-revealed World silently fell through to
    // validating World's own step instead and failed with
    // WORLD_BORROW_REQUIRED. Declining a Fool-revealed World must work
    // exactly like declining any other Fool-revealed card.
    it("declining a Fool-revealed World auto-continues into Fool's own mandatory second flip", () => {
        const g = setupFool();
        pluckCard(g, "21");
        g.drawPile.unshift("21");
        g.move(`use 00`);
        expect(g.continued).to.deep.equal(["00.1"]);

        const declined = g.validateMove(`decline via 00`);
        expect(declined.valid).to.be.true;
        expect(declined.complete).eq(1);
        g.move(`decline via 00`);
        expect(g.continued).to.deep.equal(["00.2"]); // Fool's own mandatory second flip
        expect(g.discardPile).to.include("21");
    });

    // Regression: only the ROOT card's own untouched first flip is
    // mandatory (playing/using Fool commits you to it) - a NESTED
    // self-reveal (Fool flipping to reveal another Fool) is declinable
    // exactly like any other revealed card, ending the cascade without
    // triggering a further flip from IT, while the outer Fool's own
    // still-owed second flip fires regardless (never optional itself).
    it("Fool revealing Fool offers the ordinary Play/Decline pair, and declining it auto-continues the outer Fool's own mandatory second flip", () => {
        const g = setupFool();
        pluckCard(g, "00");
        g.drawPile.unshift("00"); // Fool's own first flip reveals another Fool
        g.move(`use 00`);
        expect(g.continued).to.deep.equal(["00.1"]);
        expect(buttonValues(g)).to.deep.equal(["resume_power", "decline_power", "undo"]);

        pluckCard(g, "AC");
        g.drawPile.unshift("AC"); // the outer's own mandatory second flip, once it fires
        const validated = g.validateMove(`decline via 00`);
        expect(validated.valid).to.be.true;
        expect(validated.complete).eq(1);
        g.move(`decline via 00`);
        expect(g.continued).to.deep.equal(["00.2"]);
        expect(g.discardPile).to.include.members(["00", "AC"]);
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
        pluckCard(g, "12");
        g.drawPile.unshift("12"); // Fool's 1st flip reveals Hanged Man
        g.move(`use 00`);

        g.drawPile.unshift("21"); // Fool's mandatory 2nd flip reveals World
        g.move(`play 12 via 00/with m0.1 move m0.1 1`); // moves to n0; tradeHands auto-skips (no enemy)
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
        expect(targetClick.move).eq(`play 21 as 05 via 00`);
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
        g.move(`use 00`);
        g.drawPile.unshift("AD");
        g.move(`decline AC via 00`); // auto-continues into the 2nd flip
        expect(g.continued).to.deep.equal(["00.2"]);
        g.move(`decline AD via 00`); // nothing left to auto-continue
        expect(g.continued).to.be.empty;
        const rows = g.chatLog(["Alice", "Bob"]);
        const adName = minorCards.find(c => c.uid === "AD")!.name;
        expect(rows[rows.length - 1].some(line => line.includes(adName))).to.be.true;
    });

    // randomMove() now sometimes genuinely tries to USE what Fool revealed
    // (reusing buildRandomChain, the same builder a fresh activation uses)
    // rather than always declining - run several fresh trials to confirm
    // every candidate is still legal AND that "play ..." (a real use, not
    // just "decline") actually comes up at least once, proving the new
    // path is reachable and not silently falling back every time.
    it("randomMove() sanity check: a paused activation always yields something validateMove() accepts", () => {
        let sawRealUse = false;
        for (let i = 0; i < 30; i++) {
            const g = setupFool();
            pluckCard(g, "AC");
            g.drawPile.unshift("AC");
            g.move(`use 00`);
            expect(g.continued).to.not.be.empty;
            const move = g.randomMove();
            expect(g.validateMove(move).valid, `"${move}" should validate`).to.be.true;
            expect(() => g.move(move)).to.not.throw();
            if (move.startsWith("play ")) {
                sawRealUse = true;
            }
        }
        expect(sawRealUse, "expected at least one trial to actually use the revealed card, not just decline").to.be.true;
    });

    // The player never reasons about "nesting" - a Fool-revealed Fool or
    // World is just the card in front of them, exactly like any other
    // reveal - so randomMove() must try to use these two exactly as
    // readily as a fresh top-level "use 00"/"use 21" would, not fall back
    // to decline just because they were reached via a reveal instead of a
    // direct activation.
    it("randomMove() sometimes uses a Fool-revealed Fool (lets it flip again) instead of always declining", () => {
        let sawRealUse = false;
        for (let i = 0; i < 30; i++) {
            const g = setupFool();
            pluckCard(g, "00");
            g.drawPile.unshift("00"); // Fool's own flip reveals another Fool
            g.move(`use 00`);
            expect(g.continued).to.not.be.empty;
            const move = g.randomMove();
            expect(g.validateMove(move).valid, `"${move}" should validate`).to.be.true;
            expect(() => g.move(move)).to.not.throw();
            if (move === `play 00 via 00`) {
                sawRealUse = true;
            }
        }
        expect(sawRealUse, "expected at least one trial to actually use (re-flip) the revealed Fool, not just decline").to.be.true;
    });

    it("randomMove() sometimes borrows a real major arcana card when Fool reveals The World", () => {
        let sawRealUse = false;
        for (let i = 0; i < 30; i++) {
            const g = setupFool();
            forceCardAt(g, 1, 0, () => major(6)); // The Lovers - a real borrow target
            pluckCard(g, "21");
            g.drawPile.unshift("21"); // Fool's own flip reveals The World
            g.move(`use 00`);
            expect(g.continued).to.not.be.empty;
            const move = g.randomMove();
            expect(g.validateMove(move).valid, `"${move}" should validate`).to.be.true;
            expect(() => g.move(move)).to.not.throw();
            if (new RegExp(`^play 21 as \\d\\d`).test(move)) {
                sawRealUse = true;
            }
        }
        expect(sawRealUse, "expected at least one trial to actually borrow a card via the revealed World, not just decline").to.be.true;
    });

    // Regression: a Fool-revealed Magician never spends the head's asUid
    // on the reveal itself (unlike World's own borrow), so its own suit
    // choice still goes through "as <suit>" - randomMove() must build it
    // that way too, not the inline form only a World-pushed Magician uses
    // (see findRandomMagicianChain's own docs, randomMove.ts).
    it("randomMove() sometimes uses a Fool-revealed Magician, choosing its suit via 'as'", () => {
        let sawRealUse = false;
        for (let i = 0; i < 30; i++) {
            const g = setupFool();
            g.board.get(1, 0)!.pieces = [new Piece(1, 1, "U")]; // room for Cups "own" to have a facing target too
            pluckCard(g, "01");
            g.drawPile.unshift("01"); // Fool's own flip reveals The Magician
            g.move(`use 00`);
            expect(g.continued).to.not.be.empty;
            const move = g.randomMove();
            expect(g.validateMove(move).valid, `"${move}" should validate`).to.be.true;
            expect(() => g.move(move)).to.not.throw();
            if (new RegExp(`^play 01 as [CRDS]`).test(move)) {
                sawRealUse = true;
            }
        }
        expect(sawRealUse, "expected at least one trial to actually use the revealed Magician, not just decline").to.be.true;
    });

    // Regression: randomMove()'s own "paused activation" fallback used to
    // build "decline" unconditionally for ANY this.continued obligation -
    // wrong for High Priestess specifically, whose own round 2 rejects
    // "decline" outright (WRONG_CONTINUED_ACTION - see validateMove's own
    // resume-head gate). "draw 0" is High Priestess's own always-legal
    // minimal resume instead.
    it("randomMove() never declines a persisted High Priestess obligation (WRONG_CONTINUED_ACTION otherwise)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(2)); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        const discardUid = g.hands[0][0];
        g.move(`use 02/discard ${discardUid} draw 1`); // round 1
        expect(g.continued).to.deep.equal(["02"]); // round 2 owed

        expect(g.validateMove(`decline via 02`).message).eq(i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "WRONG_CONTINUED_ACTION" }));
        const move = g.randomMove();
        // No slash regression test.  The discard uids/draw count are randomized
        // (buildRandomHighPriestessResumeTokens reuses round 1's own randomizer).
        expect(move.startsWith("discard ") && move.endsWith(` via 02`) && !move.includes("/")).to.be.true;
        expect(g.validateMove(move).valid).to.be.true;
        expect(() => g.move(move)).to.not.throw();
        expect(g.continued).to.be.empty; // the obligation actually resolved...
        expect(g.currplayer).eq(2); // ...and the turn actually advanced
    });

    it("regression: Judgement can draw itself back from the discard pile", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        pluckCard(g, "20"); // Judgement - avoid a duplicate elsewhere
        g.hands[0] = g.hands[0].slice(0, 5); // room for 1 more once "20" itself is played away
        g.hands[0].push("20");
        g.discardPile.push("21"); // padding, so "20" isn't the only discard entry
        g.move("play 20/with m0.1 draw 20");
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

        const move = "play 20/with m0.1 draw 20";
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
        const useValidated = use.validateMove(`use 00`);
        expect(useValidated.valid).to.be.false;
        expect(useValidated.message).to.eq(i18next.t("apgames:validation.gnostica.DRAW_PILE_EMPTY"));

        const play = new GnosticaGame(2);
        clearBoard(play);
        forceCardAt(play, 0, 0, () => major(3)); // any other major, so Fool stays in hand
        play.board.get(0, 0)!.pieces = [new Piece(1, 1, "U")];
        play.hands[0].push("00");
        play.drawPile = [];
        play.discardPile = [];
        const playValidated = play.validateMove(`play 00`);
        expect(playValidated.valid).to.be.false;
        expect(playValidated.message).to.eq(i18next.t("apgames:validation.gnostica.DRAW_PILE_EMPTY"));
        // A {trusted: true} caller is expected to have already validated,
        // same as every other legality check in this file - this guard
        // is validate-only by design, not mirrored in cmdPlay itself.
    });
});

describe("Gnostica: a new or changed minion's facing stays open to a click until the next step starts", () => {
    // Temperance (create, create): the first create's facing is only the seeded "U?", and the second step's minion is still ambiguous.
    it("redirects the minion just created on a neighbouring click, instead of asking for the next step's minion", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "14", pieces: [[1, 2, "U"]] }, { x: 1, y: 0, uid: "AD" }, { x: -1, y: 0, uid: "AR" }],
            hands: [filler, filler],
        });
        const seeded = "use 14/with m0.2 at m0 create U?";
        const shown = g.clone();
        shown.move(seeded, { partial: true });
        const { minX, minY } = shown.renderWindow();
        const east = g.handleClick(seeded, 0 - minY, 1 - minX);
        expect(east.move).eq("use 14/with m0.2 at m0 create E");
        expect(east.valid).to.be.true;
        const west = g.handleClick(seeded, 0 - minY, -1 - minX);
        expect(west.move).eq("use 14/with m0.2 at m0 create W");
        // The piece's own cell points it up, even though a minion stands there too: the next step starts from the buttons.
        expect(g.handleClick(seeded, 0 - minY, 0 - minX).move).eq("use 14/with m0.2 at m0 create U");
    });

    describe("Skip Reorient", () => {
        // The Hanged Man (move, then trade) next to an enemy piece the trade could target, which is also a facing cell of the moved piece.
        const hanged = () => testGame({
            board: [{ x: 0, y: 0, uid: "12", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD" }, { x: 1, y: -1, uid: "2D", pieces: [[2, 1, "W"]] }],
            hands: [filler, filler], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
        });
        const seeded = "use 12/with m0.2 move m0.2 1";
        const barValues = (g: GnosticaGame, move: string) => {
            const shown = g.clone();
            shown.move(move, { partial: true });
            const out = shown.render();
            const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
            return rep.areas!.find(a => a.type === "buttonBar")!.buttons!.map(b => b.value);
        };

        it("is offered while the finished power's piece can still be turned, before Declare", () => {
            const values = barValues(hanged(), seeded);
            expect(values.indexOf("skip_reorient")).to.be.greaterThan(-1);
            expect(values.indexOf("skip_reorient")).eq(values.indexOf("declare") - 1);
        });

        it("keeps a board click on the piece's neighbour a facing click, not the start of the next power", () => {
            const g = hanged();
            const shown = g.clone();
            shown.move(seeded, { partial: true });
            const { minX, minY } = shown.renderWindow();
            expect(g.handleClick(seeded, -1 - minY, 1 - minX).move).eq(`${seeded} orient N`);
        });

        it("begins the next power with a bare with, adding no facing, after which a click chooses its minion", () => {
            const g = hanged();
            const skipped = g.handleClick(seeded, -1, -1, "_btn_skip_reorient");
            expect(skipped.move).eq(`${seeded}/with`);
            expect(skipped.valid).to.be.true;
            expect(skipped.complete).eq(-1);
            expect(barValues(g, skipped.move!)).to.not.include("skip_reorient");
            const shown = g.clone();
            shown.move(skipped.move!, { partial: true });
            const { minX, minY } = shown.renderWindow();
            expect(g.handleClick(skipped.move!, -1 - minY, 1 - minX).move).to.include("/with");
        });

        it("treats a click on the facing the piece already has as skipping the reorient", () => {
            const g = hanged();
            const shown = g.clone();
            shown.move(seeded, { partial: true });
            const { minX, minY } = shown.renderWindow();
            expect(g.handleClick(seeded, 0 - minY, 2 - minX).move).eq(`${seeded}/with`); // east: where the moved piece already points
        });

        it("rejects a move that goes on past a facing still marked unchosen, which only a wrongly built move would", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "14", pieces: [[1, 2, "U"]] }, { x: 1, y: 0, uid: "AD" }, { x: -1, y: 0, uid: "AR" }],
                hands: [filler, filler],
            });
            for (const move of ["use 14/with m0.2 at m0 create U?/with m0.1", "use 14/with m0.2 at m0 create U?/with"]) {
                expect(g.validateMove(move).valid, move).to.be.false;
            }
            expect(g.validateMove("use 14/with m0.2 at m0 create U/with m0.1").valid).to.be.true;
        });

        it("holds back the next power's minion buttons until the reorient is skipped", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "14", pieces: [[1, 2, "U"]] }, { x: 1, y: 0, uid: "AD" }, { x: -1, y: 0, uid: "AR" }],
                hands: [filler, filler],
            });
            const open = "use 14/with m0.2 at m0 create U?";
            expect(barValues(g, open).some(v => v?.startsWith("minion_"))).to.be.false;
            expect(g.handleClick(open, -1, -1, "_btn_minion_m0.1").move).eq(open); // inert, like any button the state doesn't offer
            const skipped = g.handleClick(open, -1, -1, "_btn_skip_reorient").move!;
            expect(skipped).eq("use 14/with m0.2 at m0 create U/with");
            expect(barValues(g, skipped).some(v => v?.startsWith("minion_"))).to.be.true;
            expect(g.handleClick(skipped, -1, -1, "_btn_minion_m0.1").move).eq("use 14/with m0.2 at m0 create U/with m0.1");
        });

        it("is taken back by Undo, which reopens the facing", () => {
            expect(hanged().handleClick(`${seeded}/with`, -1, -1, "_btn_undo").move).eq(seeded);
        });

        it("goes on from a seeded Cups facing without choosing one", () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "19", pieces: [[1, 1, "W"]] }, { x: -1, y: 0, uid: "AD" }],
                hands: [filler, filler], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
            });
            expect(g.handleClick("use 19/with m0.1 at l0 create U?", -1, -1, "_btn_skip_reorient").move).eq("use 19/with m0.1 at l0 create U/with");
        });

        it("says what to click for a board click that neither turns the piece nor can start the next power", () => {
            const g = hanged();
            const shown = g.clone();
            shown.move(seeded, { partial: true });
            const { minX, minY } = shown.renderWindow();
            const stray = g.handleClick(seeded, 0 - minY, -2 - minX);
            expect(stray.move).eq(seeded);
            expect(stray.message).eq(i18next.t("apgames:validation.gnostica.FACE_OR_NEXT_POWER"));
        });
    });

    // The Sun (create, grow) makes its piece on a neighbouring territory, so the cell that turns it toward the minion is also a candidate minion's cell.
    it("turns the new piece toward a neighbouring minion's cell, not on to the next step", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "19", pieces: [[1, 1, "W"]] }, { x: -1, y: 0, uid: "AD" }, { x: 1, y: 0, uid: "2D" }],
            hands: [filler, filler], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
        });
        const seeded = "use 19/with m0.1 at l0 create U?";
        const shown = g.clone();
        shown.move(seeded, { partial: true });
        const { minX, minY } = shown.renderWindow();
        expect(g.handleClick(seeded, 0 - minY, 0 - minX).move).eq("use 19/with m0.1 at l0 create E");
    });

    // The facing may be unchosen without a "?" in the move: a Rods move of one's own piece and a grow of it are only complete by default too.
    it("does the same after a first step that names no facing at all: Strength's grow and Lovers' move", () => {
        const board = (uid: string) => [
            { x: 0, y: 0, uid, pieces: [[1, 2, "E"], [1, 1, "U"]] as TestPiece[] },
            { x: 1, y: 0, uid: "AD" }, { x: -1, y: 0, uid: "AR" }, { x: 0, y: 1, uid: "AC" }, { x: 0, y: -1, uid: "AS" }, { x: 2, y: 0, uid: "2D" },
            { x: 1, y: 1, uid: "3D" }, { x: 1, y: -1, uid: "4D" },
        ];
        const click = (g: GnosticaGame, move: string, x: number, y: number) => {
            const shown = g.clone();
            shown.move(move, { partial: true });
            const { minX, minY } = shown.renderWindow();
            return g.handleClick(move, y - minY, x - minX).move;
        };
        const strength = testGame({ board: board("08"), hands: [filler, filler] });
        expect(click(strength, "use 08/with m0.1 grow m0.1", 0, -1)).eq("use 08/with m0.1 grow m0.1 orient N"); // the grown piece stays at m0
        const lovers = testGame({ board: board("06"), hands: [filler, filler] });
        expect(click(lovers, "use 06/with m0.2 move m0.2 1", 1, 1)).eq("use 06/with m0.2 move m0.2 1 orient S"); // the moved piece is now at n0
    });
});

describe("Gnostica: skipping a card's first power", () => {
    type Btn = { value?: string; fill?: unknown };
    const barOf = (g: GnosticaGame): Btn[] => {
        const out = g.render();
        const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { areas?: { type: string; buttons?: Btn[] }[] };
        return rep.areas!.find(a => a.type === "buttonBar")!.buttons!;
    };
    // A 2-pip minion facing an enemy 2-pip piece at n0: Moon (move, attack), Lovers (move, create), Chariot (move, move).
    const duel = (uid: string) => testGame({
        board: [{ x: 0, y: 0, uid, pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 2, "W"]] }, { x: -1, y: 0, uid: "2D" }],
        hands: [filler, filler],
    });

    it("offers Skip Power just before Declare while the first power is pending, and only for cards whose powers differ", () => {
        for (const uid of ["18", "06", "03", "11", "12", "19"]) {
            const shown = duel(uid);
            shown.move(`use ${uid}`, { partial: true });
            const values = barOf(shown).map(b => b.value);
            expect(values.indexOf("skip"), uid).to.be.greaterThan(-1);
            expect(values.indexOf("skip"), uid).eq(values.indexOf("declare") - 1);
        }
        for (const uid of ["07", "08", "13", "14", "15"]) {
            const shown = duel(uid);
            shown.move(`use ${uid}`, { partial: true });
            expect(barOf(shown).map(b => b.value), uid).to.not.include("skip");
        }
    });

    it("builds `skip`, then shows the second power's buttons without a second Skip Power", () => {
        const g = duel("18");
        const click = g.handleClick("use 18", -1, -1, "_btn_skip");
        expect(click.move).eq("use 18/skip");
        expect(click.valid).to.be.true;
        expect(click.complete).eq(-1); // a skip is not a move until the second power's step follows
        const shown = g.clone();
        shown.move(click.move!, { partial: true });
        const values = barOf(shown).map(b => b.value);
        expect(values).to.not.include("skip");
        expect(values).to.include("target_n0.2"); // the attack's targets
        const target = g.handleClick(click.move!, -1, -1, "_btn_target_n0.2");
        expect(target.move).eq("use 18/skip/with m0.2 shrink n0.2");
        expect(g.handleClick(target.move!, -1, -1, "_btn_pips_1").move).eq("use 18/skip/with m0.2 shrink n0.2 1");
    });

    it("applies only the second power, and leaves no trace of the skip", () => {
        const g = duel("18");
        g.move("use 18/skip/with m0.2 shrink n0.2 1");
        expect(g.board.get(0, 0)!.pieces.map(p => p.id())).to.deep.equal(["12E"]); // the minion didn't move
        expect(g.board.get(1, 0)!.pieces.map(p => p.id())).to.deep.equal(["21W"]); // the enemy shrank from 2 to 1
        expect(g.results.some(r => r.type === "_group")).to.be.false;
    });

    it("also applies to the card a World borrows and the card a Fool reveals", () => {
        // The World borrowing the Moon: `as 18` names the card, and a skip leads the borrowed card's own steps.
        const world = testGame({
            board: [{ x: 0, y: 0, uid: "21", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 2, "W"]] }, { x: -1, y: 0, uid: "18" }],
            hands: [filler, filler],
        });
        const borrowed = "use 21 as 18";
        const shown = world.clone();
        shown.move(borrowed, { partial: true });
        const values = barOf(shown).map(b => b.value);
        expect(values.indexOf("skip")).eq(values.indexOf("declare") - 1);
        expect(world.handleClick(borrowed, -1, -1, "_btn_skip").move).eq(`${borrowed}/skip`);
        world.move(`${borrowed}/skip/with m0.2 shrink n0.2 1`);
        expect(world.board.get(1, 0)!.pieces.map(p => p.id())).to.deep.equal(["21W"]);
        expect(world.board.get(0, 0)!.pieces.map(p => p.id())).to.deep.equal(["12E"]); // the Moon's move was skipped

        // The Fool revealing the Moon: Skip Power sits in the owed bar, ahead of Declare and Decline.
        const fool = testGame({
            board: [{ x: 0, y: 0, uid: "00", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 2, "W"]] }, { x: -1, y: 0, uid: "2D" }],
            hands: [filler, filler],
            drawPile: ["18", "3C", "4C"],
        });
        fool.move("use 00");
        const owed = barOf(fool).map(b => b.value);
        expect(owed.indexOf("skip")).to.be.greaterThan(-1);
        expect(owed.indexOf("skip")).to.be.lessThan(owed.indexOf("declare"));
        const click = fool.handleClick("", -1, -1, "_btn_skip");
        expect(click.move).eq("play 18 via 00/skip");
        const after = fool.clone();
        after.move(click.move!, { partial: true });
        expect(barOf(after).map(b => b.value)).to.not.include("skip");
        expect(fool.validateMove("play 18 via 00/skip/with m0.2 shrink n0.2 1").complete).eq(1);
    });

    it("is rejected where there is nothing to skip to, and ignored where the button isn't offered", () => {
        const chariot = duel("07");
        const bad = chariot.validateMove("use 07/skip/with m0.2 move m0.2 1");
        expect(bad.valid).to.be.false;
        expect(bad.message).eq(i18next.t("apgames:validation.gnostica.SKIP_NOT_ALLOWED"));
        expect(chariot.handleClick("use 07", -1, -1, "_btn_skip").move).eq("use 07");
        const minor = testGame({ board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 1, "U"]] }], hands: [filler, filler] });
        expect(minor.validateMove("use AC/skip").valid).to.be.false;
        // The High Priestess: both rounds are the same power, in a move with no minion, so a skip is refused in a fresh use and a play, and in the round-2 resume.
        const priestess = testGame({ board: [{ x: 0, y: 0, uid: "02", pieces: [[1, 2, "U"]] }], hands: [["02", ...filler.slice(0, 5)], filler], drawPile: ["AC", "2C", "3C", "4C"] });
        for (const move of ["use 02/skip", "use 02/skip/discard 2R draw 1", "play 02/skip/discard 2R draw 1"]) {
            const result = priestess.validateMove(move);
            expect(result.valid, move).to.be.false;
            expect(result.message, move).eq(i18next.t("apgames:validation.gnostica.SKIP_NOT_ALLOWED"));
        }
        priestess.move("use 02/discard 2R draw 1");
        expect(priestess.validateMove("discard 3R draw 1 via 02/skip").valid).to.be.false;
        // A move that only skips is never submittable.
        const only = duel("18").validateMove("use 18/skip");
        expect(only.valid).to.be.true;
        expect(only.complete).eq(-1);
    });
});

describe("Gnostica: the Fool's Decline button", () => {
    const owed = () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "00", pieces: [[1, 1, "U"]] }], hands: [filler, filler], drawPile: ["AC", "2C", "3C"] });
        g.move("use 00"); // flips the Ace of Cups
        return g;
    };
    const valuesWhile = (g: GnosticaGame, move?: string): string[] => {
        const shown = g.clone();
        if (move !== undefined) {
            shown.move(move, { partial: true });
        }
        return ((shown.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] }).areas ?? [])
            .filter(a => a.type === "buttonBar").flatMap(a => (a.buttons ?? []).map(b => b.value ?? ""));
    };

    it("is offered until Play is chosen or a step of the revealed card is entered, then goes away", () => {
        const g = owed();
        expect(valuesWhile(g)).to.include("decline_power");
        expect(valuesWhile(g, "play AC via 00")).to.not.include("decline_power"); // Play clicked: the choice is made
        expect(valuesWhile(g, "play AC via 00/with m0.1 at m0 create N")).to.not.include("decline_power");
    });

    it("with minions on several cells, clicking Play turns the Play/Decline pair into the ordinary minion pick, with Skip Power", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "00", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[1, 1, "W"]] }, { x: -1, y: 0, uid: "2D", pieces: [[2, 1, "U"]] }],
            hands: [filler, filler],
            drawPile: ["18", "3C", "4C"], // the Moon
        });
        g.move("use 00");
        expect(valuesWhile(g)).to.deep.equal(["resume_power", "decline_power", "undo"]);
        const click = g.handleClick("", -1, -1, "_btn_resume_power");
        expect(click.move).eq("play 18 via 00");
        const shown = g.clone();
        shown.move(click.move!, { partial: true });
        const buttons = (shown.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; fill?: unknown }[] }[] }).areas!.find(a => a.type === "buttonBar")!.buttons!;
        expect(buttons.map(b => b.value)).to.deep.equal(["play", "_spacer", "skip", "declare", "undo"]);
        expect(isGrey(buttons[0])).to.be.true; // the chosen Play
    });

    it("leaves none of the ordinary actions on the bar once it is chosen, just Declare and the greyed Decline", () => {
        const g = owed();
        const shown = g.clone();
        shown.move("decline AC via 00", { partial: true });
        const values = ((shown.render().at(-1) as { areas?: { type: string; buttons?: { value?: string }[] }[] }).areas ?? [])
            .filter(a => a.type === "buttonBar").flatMap(a => (a.buttons ?? []).map(b => b.value));
        expect(values).to.deep.equal(["declare", "decline_power", "undo"]);
    });

    it("stays, greyed, once it has been chosen", () => {
        const g = owed();
        const shown = g.clone();
        shown.move("decline AC via 00", { partial: true });
        const buttons = (shown.render().at(-1) as { areas?: { type: string; buttons?: { value?: string; fill?: unknown }[] }[] }).areas!.find(a => a.type === "buttonBar")!.buttons!;
        const decline = buttons.find(b => b.value === "decline_power")!;
        expect(decline).to.not.be.undefined;
        expect(isGrey(decline)).to.be.true;
    });
});

describe("Gnostica: a Rods distance past the edge of the window", () => {
    type Rep = { board: { width: number; height: number; buffer?: { show: string[] } } };
    const rep = (g: GnosticaGame, move: string) => {
        const shown = g.clone();
        shown.move(move, { partial: true });
        return { rep: shown.render().at(-1) as Rep, window: shown.renderWindow() };
    };

    it("draws a buffer on the side the piece moves toward, and a click on it sets the distance", () => {
        // A lone 3-pip minion facing south: distance 1 lands in the window's padding, distance 2 one cell past it.
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 3, "S"]] }], hands: [filler, filler] });
        const mid = "use AR/with m0.3 move m0.3";
        const { rep: shown, window } = rep(g, mid);
        expect(shown.board.buffer?.show).to.deep.equal(["S"]);
        expect(g.handleClick(mid, 2, 0 - window.minX).move).eq(`${mid} 1`); // the padding row
        expect(g.handleClick(mid, 3, 0 - window.minX).move).eq(`${mid} 2`); // the buffer row
    });

    it("draws none when every landing cell is inside the window", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 1, "S"]] }, { x: 0, y: 1, uid: "AD" }], hands: [filler, filler] });
        expect(rep(g, "use AR/with m0.1 move m0.1").rep.board.buffer).to.be.undefined;
    });
});

describe("Gnostica: a card played from the hand is not counted in the hand its power sees", () => {
    type Btn = { value?: string; attributes?: { name: string; value: string }[] };
    const barAt = (g: GnosticaGame, move: string): Btn[] => {
        const shown = g.clone();
        shown.move(move, { partial: true });
        const out = shown.render();
        const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { areas?: { type: string; buttons?: Btn[] }[] };
        return rep.areas!.find(a => a.type === "buttonBar")!.buttons!;
    };
    const crossed = (b: Btn | undefined): boolean => b?.attributes?.some(a => a.name === "text-decoration" && a.value === "line-through") === true;
    const grid = [{ x: 0, y: 0, uid: "2D", pieces: [[1, 1, "E"]] as TestPiece[] }, { x: 1, y: 0, uid: "KC" }];

    it("crosses out an attack on a territory when the played card is the only one that could replace it", () => {
        // The minion faces a court card (worth 2); shrinking it by 1 needs a replacement worth 1.
        const sole = testGame({ board: grid, hands: [["AS", "KC", "KD", "KR", "KS", "QC"], filler] });
        expect(crossed(barAt(sole, "play AS/with m0.1").find(b => b.value === "target_n0"))).to.be.true;
        expect(sole.handleClick("play AS/with m0.1", -1, -1, "_btn_target_n0").move).eq("play AS/with m0.1"); // no response
        // With another card worth 1 in the hand, the same button is fine.
        const other = testGame({ board: grid, hands: [["AS", "2R", "KD", "KR", "KS", "QC"], filler] });
        expect(crossed(barAt(other, "play AS/with m0.1").find(b => b.value === "target_n0"))).to.be.false;
    });

    it("does not let a played Strength stand in for its own territory growth", () => {
        const board = [{ x: 0, y: 0, uid: "00", pieces: [[1, 2, "E"]] as TestPiece[] }, { x: 1, y: 0, uid: "AD" }];
        const fromHand = testGame({ board, hands: [["08", "2R", "3R", "4R", "5D", "6D"], filler] });
        expect(crossed(barAt(fromHand, "play 08/with m0.2").find(b => b.value === "target_n0"))).to.be.true;
    });

    it("lets a High Priestess played from a full hand draw back the one card her own play freed", () => {
        const board = [{ x: 0, y: 0, uid: "00", pieces: [[1, 2, "E"]] as TestPiece[] }];
        const g = testGame({ board, hands: [["02", "2R", "3R", "4R", "5D", "6D"], filler], drawPile: ["AC", "2C", "3C"] });
        const values = barAt(g, "play 02").map(b => b.value);
        expect(values).to.include("hpdraw_1");
        expect(values).to.include("hpdraw_0");
    });
});

describe("Gnostica: a Fool's revealed card plays down the same path as one played from the hand", () => {
    type Btn = { value?: string; fill?: unknown };
    const barAt = (g: GnosticaGame, move: string): string[] => {
        const shown = g.clone();
        shown.move(move, { partial: true });
        const out = shown.render();
        const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { areas?: { type: string; buttons?: Btn[] }[] };
        return rep.areas!.find(a => a.type === "buttonBar")!.buttons!.map(b => `${b.value}${b.fill !== undefined ? "*" : ""}`).filter(v => v !== "decline_power");
    };
    const board = [{ x: 0, y: 0, uid: "00", pieces: [[1, 2, "E"]] as TestPiece[] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 2, "W"]] as TestPiece[] }, { x: -1, y: 0, uid: "2D" }];
    const pair = (revealed: string) => {
        const fool = testGame({ board, hands: [["2R", "3R", "4R", "5D", "6D", "7D"], filler], drawPile: [revealed, "3C", "4C"] });
        fool.move("use 00");
        const hand = testGame({ board, hands: [[revealed, "2R", "3R", "4R", "5D", "6D"], filler], drawPile: ["3C", "4C"] });
        return { fool, hand };
    };

    it("keeps the chosen Play greyed, with Skip Power and Declare, after a first click-only step (Empress's orient)", () => {
        const { fool, hand } = pair("03");
        expect(barAt(fool, "play 03 via 00/orient m0.2")).to.deep.equal(["play*", "skip", "declare", "undo"]);
        expect(barAt(hand, "play 03/orient m0.2")).to.deep.equal(["play*", "skip", "declare", "undo"]);
    });

    it("keeps the chosen Play greyed on a complete move, as a hand play does", () => {
        const { fool, hand } = pair("AC");
        const foolBar = barAt(fool, "play AC via 00/with m0.2 at n0 create N");
        expect(foolBar[0]).eq("play*");
        expect(foolBar).to.deep.equal(barAt(hand, "play AC/with m0.2 at n0 create N"));
    });
});

describe("Gnostica: a Fool's revealed card whose facing can still be changed", () => {
    it("says so as well as noting the automatic draw, and waits for the submit", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "00", pieces: [[1, 1, "U"]] }], hands: [filler, filler], drawPile: ["AD", "2C", "3C"] });
        g.move("use 00"); // flips the Ace of Discs
        const grow = g.validateMove("play AD via 00/with m0.1 grow m0.1"); // a grow of its own piece names no facing
        expect(grow.valid).to.be.true;
        expect(grow.complete).eq(0);
        expect(grow.message).to.include(i18next.t("apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT"));
        expect(grow.message).to.include(i18next.t("apgames:validation.gnostica.FOOL_FLIP_READY"));
        // With the facing chosen it is complete, and only the automatic draw is worth noting.
        const done = g.validateMove("play AD via 00/with m0.1 grow m0.1 orient N");
        expect(done.complete).eq(1);
        expect(done.message).to.not.include(i18next.t("apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT"));
    });
});

describe("Gnostica: handleClick window", () => {
    // Regression: the client computes row/col from the board it displays WITH the move applied; a step that creates
    // a territory beyond the current edge widens that window, so handleClick() must convert against the same one.
    it("a facing click after Temperance creates a territory at the board edge lands on the displayed cell", () => {
        const g = testGame({
            board: [
                { x: 0, y: -1, pieces: [[1, 1, "U"]] }, // m1: edge wasteland, player 1's minion
                { x: 0, y: 0, uid: "AD" },
                { x: 0, y: 1, uid: "AR" },
            ],
            hands: [["14", "3R", ...filler.slice(0, 4)], filler],
        });
        const seed = "play 14/with m1.1 at m1 create 3R/with m1.1 at m1 create U?";
        const shown = g.clone();
        shown.move(seed, { partial: true });
        const { minX, minY } = shown.renderWindow();
        // The existing card at m0 (0,0) is directly "south" of m1 (0,-1).
        const result = g.handleClick(seed, 0 - minY, 0 - minX, undefined);
        expect(result.valid).to.be.true;
        expect(result.move).eq("play 14/with m1.1 at m1 create 3R/with m1.1 at m1 create S");
    });
});

describe("Gnostica: the Undo button", () => {
    type Btn = { value?: string; attributes?: { name: string; value: string }[] };
    const undoButton = (g: GnosticaGame, move?: string): Btn | undefined => {
        const shown = g.clone();
        if (move !== undefined && move !== "") {
            shown.move(move, { partial: true });
        }
        const out = shown.render();
        const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { areas?: { type: string; buttons?: Btn[] }[] };
        return rep.areas?.find(a => a.type === "buttonBar")?.buttons?.find(b => b.value === "undo");
    };
    const undoAll = (g: GnosticaGame, move: string): string[] => {
        const chain = [move];
        for (let current = move; current !== ""; ) {
            const result = g.handleClick(current, -1, -1, "_btn_undo");
            expect(result.valid, `${current} -> ${result.move}`).to.be.true;
            if (result.move === current) {
                break;
            }
            current = result.move!;
            chain.push(current);
        }
        return chain;
    };
    const board = () => testGame({
        board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "U"]] }],
        hands: [["2R", "3R", "4R", "5D", "6D", "7D"], filler],
    });

    it("takes back one decision per click, from a finished minor-card power down to the bare action", () => {
        expect(undoAll(board(), "use AR/with m0.2 move n0.1 1")).to.deep.equal([
            "use AR/with m0.2 move n0.1 1", "use AR/with m0.2 move n0.1", "use AR/with m0.2 move", "use AR/with m0.2", "use AR", "use", "",
        ]);
        expect(undoAll(board(), "play 2R/with m0.2 move m0.2 1")).to.deep.equal([
            "play 2R/with m0.2 move m0.2 1", "play 2R/with m0.2 move m0.2", "play 2R/with m0.2 move", "play 2R/with m0.2", "play 2R", "play", "",
        ]);
    });

    it("takes back one card at a time from a discard, then the draw count first", () => {
        expect(undoAll(board(), "discard 2R 3R draw 1")).to.deep.equal(["discard 2R 3R draw 1", "discard 2R 3R", "discard 2R", "discard", ""]);
    });

    it("takes back a place's facing to the seed its cell click made, then the cell, so every step is one a click could reach", () => {
        const g = new GnosticaGame(2);
        expect(undoAll(g, "place m0 N")).to.deep.equal(["place m0 N", "place m0 U?", "place", ""]);
    });

    it("takes back Cups' new piece's facing to the seed its option made, then the whole option", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "U"]] }],
            hands: [["9R", "3R", "4R", "5D", "6D", "7D"], filler], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
        });
        expect(undoAll(g, "use AC/with m0.2 at n0 create W")).to.deep.equal([
            "use AC/with m0.2 at n0 create W", "use AC/with m0.2 at n0 create U?", "use AC/with m0.2", "use AC", "use", "",
        ]);
    });

    it("leaves a board and bar that render, once it is back to a bare action", () => {
        const g = new GnosticaGame(2);
        const placed = g.clone();
        placed.move("place m0 U?", { partial: true });
        expect((placed.render().at(-1) as { pieces: string[][][] }).pieces.flat().some(cell => cell.length > 0)).to.be.true;
        const undone = g.handleClick("place m0 U?", -1, -1, "_btn_undo").move!;
        expect(undone).eq("place");
        const shown = g.clone();
        shown.move(undone, { partial: true }); // what the front end does with a click's move
        expect((shown.render().at(-1) as { pieces: string[][][] }).pieces.flat().some(cell => cell.length > 0)).to.be.false;
        expect(undoButton(g, "place")).to.not.be.undefined;
    });

    it("previews a chosen action with nothing yet clicked for it, greying that action", () => {
        const g = board();
        g.move("use", { partial: true });
        const out = g.render();
        const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { areas?: { type: string; buttons?: (Btn & { fill?: unknown })[] }[] };
        const buttons = rep.areas!.find(a => a.type === "buttonBar")!.buttons!;
        expect(buttons.map(b => b.value)).to.deep.equal(["use", "declare", "undo"]);
        expect(isGrey(buttons[0])).to.be.true;
        expect(buttons[2].attributes).to.be.undefined; // Undo is live
    });

    it("takes back an orient's facing, then its piece", () => {
        expect(undoAll(board(), "orient m0.2 N")).to.deep.equal(["orient m0.2 N", "orient m0.2", "orient", ""]);
    });

    it("says what to click next when it lands on a bare action", () => {
        const g = board();
        const result = g.handleClick("use AR", -1, -1, "_btn_undo");
        expect(result.move).eq("use");
        expect(result.valid).to.be.true;
        expect(result.message).eq(i18next.t("apgames:validation.gnostica.PICK_CARD_TO_ACTIVATE"));
    });

    it("goes back across the segments of a card with two powers, through a skip", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "18", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 2, "W"]] }, { x: -1, y: 0, uid: "2D" }],
            hands: [filler, filler],
        });
        expect(undoAll(g, "use 18/skip/with m0.2 shrink n0.2 1")).to.deep.equal([
            "use 18/skip/with m0.2 shrink n0.2 1", "use 18/skip/with m0.2 shrink n0.2", "use 18/skip/with m0.2 shrink", "use 18/skip/with m0.2", "use 18/skip", "use 18", "use", "",
        ]);
    });

    it("takes back a declaration last, once the rest of the move is gone", () => {
        expect(undoAll(board(), "use AR last")).to.deep.equal(["use AR last", "use last", "last", ""]);
    });

    it("is live while only a declaration has been made", () => {
        const g = board();
        const shown = g.clone();
        shown.move("last", { partial: true });
        const out = shown.render();
        const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { areas?: { type: string; buttons?: Btn[] }[] };
        expect(rep.areas!.find(a => a.type === "buttonBar")!.buttons!.find(b => b.value === "undo")!.attributes).to.be.undefined;
    });

    it("is crossed out, and does nothing, while there is nothing to take back", () => {
        const g = board();
        expect(undoButton(g)?.attributes?.some(a => a.name === "text-decoration")).to.be.true;
        const click = g.handleClick("", -1, -1, "_btn_undo");
        expect(click.move).eq("");
        expect(undoButton(g, "use AR")?.attributes).to.be.undefined;
    });

    it("sends a Fool's Play or Decline back to the pair of them", () => {
        const g = testGame({ board: [{ x: 0, y: 0, uid: "00", pieces: [[1, 1, "U"]] }], hands: [filler, filler], drawPile: ["AC", "2C", "3C"] });
        g.move("use 00");
        expect(g.handleClick("play AC via 00", -1, -1, "_btn_undo").move).eq("");
        expect(g.handleClick("decline AC via 00", -1, -1, "_btn_undo").move).eq("");
    });
});

describe("Gnostica: hidden information", () => {
    const game = () => testGame({
        board: [{ x: 0, y: 0, uid: "AR", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "U"]] }],
        hands: [["2R", "3R", "4R", "5D", "6D", "7D"], ["AC", "KS", "9S", "8S", "QD", "PD"]],
        drawPile: ["10C", "ND", "3S"],
    });
    const top = (g: GnosticaGame, opts: { strip?: boolean; player?: number }) => g.state(opts).stack[g.state(opts).stack.length - 1];

    it("shows a viewer only their own hand, keeping the sizes", () => {
        const stripped = top(game(), { strip: true, player: 1 });
        expect(stripped.hands[0]).to.deep.equal(["2R", "3R", "4R", "5D", "6D", "7D"]);
        expect(stripped.hands[1]).to.deep.equal(["", "", "", "", "", ""]);
        expect(top(game(), { strip: true, player: 2 }).hands[0]).to.deep.equal(["", "", "", "", "", ""]);
    });

    it("shows a spectator no hand at all", () => {
        const stripped = top(game(), { strip: true });
        expect(stripped.hands.flat().every(uid => uid === "")).to.be.true;
    });

    it("gives the full state when not asked to strip", () => {
        expect(top(game(), {}).hands[1][0]).eq("AC");
    });

    it("keeps no draw pile in the state, and rebuilds it on load from the cards nobody can see", () => {
        const g = new GnosticaGame(2);
        expect("drawPile" in top(g, {})).to.be.false;
        const reloaded = new GnosticaGame(g.serialize());
        const seen = new Set<string>([...reloaded.hands.flat(), ...reloaded.discardPile, ...[...reloaded.board.entries()].map(([, , t]) => t.cardUid!)]);
        expect(reloaded.drawPile.length).eq(78 - seen.size);
        expect(reloaded.drawPile.some(uid => seen.has(uid))).to.be.false;
        expect(new Set(reloaded.drawPile).size).eq(reloaded.drawPile.length);
    });

    it("reloads from a stripped state, renders the viewer's hand and the other's face down, and still plays the viewer's own moves", () => {
        const viewer = new GnosticaGame(game().serialize({ strip: true, player: 1 }));
        const out = viewer.render();
        const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { legend: Record<string, unknown>; areas?: { ownerMark?: number; pieces?: string[] }[] };
        expect(rep.areas!.find(a => a.ownerMark === 1)!.pieces).to.include("c2R");
        expect(rep.areas!.find(a => a.ownerMark === 2)!.pieces!.every(key => key === "cUNKNOWN")).to.be.true;
        expect(rep.legend).to.have.property("cUNKNOWN");
        expect(viewer.validateMove("play 2R/with m0.2 move m0.2 1").valid).to.be.true;
        viewer.move("discard 2R draw 1", { partial: true });
    });
});


describe("Gnostica: Justice's trade and its continued attack", () => {
    const theirs = ["AC", "KS", "9S", "8S", "QD", "PD"];
    const justice = (uid = "11") => testGame({
        board: [{ x: 0, y: 0, uid, pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "W"]] }],
        hands: [filler, theirs], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
    });
    const barValues = (g: GnosticaGame, move?: string): (string | undefined)[] => {
        const shown = g.clone();
        if (move !== undefined) {
            shown.move(move, { partial: true });
        }
        const out = shown.render();
        const rep = (Array.isArray(out) ? out[out.length - 1] : out) as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        return rep.areas!.find(a => a.type === "buttonBar")!.buttons!.map(b => b.value);
    };
    const trade = "use 11/with m0.2 trade n0.1";

    it("pauses after the trade: nothing may follow it in the same submission", () => {
        const g = justice();
        expect(g.validateMove(trade).complete).eq(1);
        const after = g.validateMove(`${trade}/with m0.2 shrink n0.1 1`);
        expect(after.valid).to.be.false;
        expect(after.message).to.include("STEPS_AFTER_FORCED_PAUSE");
    });

    it("previews the player's old hand in the other hand, and their new hand face-down", () => {
        const g = justice();
        g.move(trade, { partial: true });
        expect(g.hands[0]).to.deep.equal(["", "", "", "", "", ""]);
        expect(g.hands[1]).to.deep.equal(filler);
    });

    it("previews the same from a client that cannot see the other hand", () => {
        const client = new GnosticaGame(justice().serialize({ strip: true, player: 1 }));
        client.move(trade, { partial: true });
        expect(client.hands[0]).to.deep.equal(["", "", "", "", "", ""]);
        expect(client.hands[1]).to.deep.equal(filler);
    });

    it("swaps the hands only when the move is committed, and leaves the turn with the same player, owing the attack", () => {
        const g = justice();
        g.move(trade);
        expect(g.hands[0]).to.deep.equal(theirs);
        expect(g.hands[1]).to.deep.equal(filler);
        expect(g.currplayer).eq(1);
        expect(g.continued).to.deep.equal(["11.use"]);
        expect(g.results.some(r => r.type === "swap")).to.be.true;
    });

    it("remembers how it was reached: used, played, or used through the World", () => {
        const played = testGame({
            board: [{ x: 0, y: 0, uid: "AC", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "W"]] }],
            hands: [["11", ...filler.slice(0, 5)], theirs], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
        });
        played.move("play 11/with m0.2 trade n0.1");
        expect(played.continued).to.deep.equal(["11.play"]);
        expect(played.validateMove("play 11 as S/with m0.2 shrink n0.1 1").valid).to.be.true;
        expect(played.validateMove("use 11 as S/with m0.2 shrink n0.1 1").valid).to.be.false;

        const world = testGame({
            board: [{ x: 0, y: 0, uid: "21", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "W"]] }, { x: -1, y: 0, uid: "11" }],
            hands: [filler, theirs], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
        });
        world.move("use 21 as 11/with m0.2 trade n0.1");
        expect(world.continued).to.deep.equal(["11.use21"]);
        expect(world.validateMove("use 11 as S/with m0.2 shrink n0.1 1").valid).to.be.true; // the World's own minion, not one on Justice's territory
    });

    it("lets a used Justice's attack be made only by the minions in the territory it was used from", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "11", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "W"]] }, { x: -1, y: 0, uid: "2D", pieces: [[1, 3, "E"]] }],
            hands: [filler, theirs], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
        });
        g.move("use 11/with m0.2 trade n0.1");
        expect(g.validateMove("use 11 as S/with m0.2 shrink n0.1 1").valid).to.be.true;
        expect(g.validateMove("use 11 as S/with l0.3 shrink n0.1 1").valid).to.be.false; // a minion from another territory
    });

    it("finishes the turn when the attack is made, or when it is declined", () => {
        const attacked = justice();
        attacked.move(trade);
        attacked.move("use 11 as S/with m0.2 shrink n0.1 1");
        expect(attacked.continued).to.deep.equal([]);
        expect(attacked.currplayer).eq(2);
        expect(attacked.board.get(1, 0)?.pieces.length ?? 0).eq(0);

        const declined = justice();
        declined.move(trade);
        declined.move("decline 11");
        expect(declined.continued).to.deep.equal([]);
        expect(declined.currplayer).eq(2);
        expect(declined.hands[0]).to.deep.equal(theirs); // the trade stands
    });

    it("rejects a continued turn that names the wrong card, verb or suit", () => {
        const g = justice();
        g.move(trade);
        expect(g.validateMove("use 11 as S/with m0.2 shrink n0.1 1").valid).to.be.true;
        expect(g.validateMove("play 11 as S/with m0.2 shrink n0.1 1").message).to.include("WRONG_CONTINUED_ACTION");
        expect(g.validateMove("use 11/with m0.2 shrink n0.1 1").message).to.include("WRONG_AS_SUIT");
        expect(g.validateMove("use 12 as S/with m0.2 shrink n0.1 1").valid).to.be.false;
        expect(g.validateMove("use 11 as C/with m0.2 shrink n0.1 1").valid).to.be.false;
    });

    it("offers Play and Decline for the owed attack, without Skip Power, and drops Decline once Play is chosen", () => {
        const g = justice();
        g.move(trade);
        const owed = barValues(g);
        expect(owed).to.include("decline_power");
        expect(owed).to.not.include("skip");
        const play = g.handleClick("", -1, -1, "_btn_resume_power");
        expect(play.move).eq("use 11 as S");
        expect(barValues(g, play.move)).to.not.include("decline_power");
        expect(g.handleClick("", -1, -1, "_btn_decline_power").move).eq("decline 11");
    });

    describe("revealed by the Fool", () => {
        const owed = () => {
            const g = testGame({
                board: [{ x: 0, y: 0, uid: "00", pieces: [[1, 2, "E"]] }, { x: 1, y: 0, uid: "AD", pieces: [[2, 1, "W"]] }],
                hands: [filler, theirs], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] }, drawPile: ["11", "3C", "4C"],
            });
            g.move("use 00"); // flips Justice
            g.move("play 11 via 00/with m0.2 trade n0.1");
            return g;
        };

        it("owes the attack above the Fool's second flip, and plays its trade without needing `as S`", () => {
            const g = owed();
            expect(g.continued).to.deep.equal(["00.1", "11.play"]);
            expect(g.currplayer).eq(1);
            expect(g.hands[0]).to.deep.equal(theirs);
        });

        it("goes on to the Fool's second flip once the attack is made or declined", () => {
            for (const move of ["play 11 as S/with m0.2 shrink n0.1 1", "decline 11"]) {
                const g = owed();
                g.drawPile = ["3C", "4C"]; // pinned again after the reload
                expect(g.validateMove(move).valid, move).to.be.true;
                g.move(move);
                expect(g.continued, move).to.deep.equal(["00.2"]);
                expect(g.discardPile, move).to.deep.equal(["11", "3C"]);
            }
        });

        it("still names the Fool, not Justice, for a move that answers the wrong obligation", () => {
            expect(owed().validateMove("play 3C via 00").message).to.include("WRONG_VIA_CARD");
        });
    });

    it("does not pause the Hanged Man, whose trade comes last", () => {
        const g = testGame({
            board: [{ x: 0, y: 0, uid: "12", pieces: [[1, 1, "E"]] }, { x: 1, y: 0, uid: "AD" }, { x: 2, y: 0, uid: "2D", pieces: [[2, 1, "W"]] }, { x: 3, y: 0, uid: "3D" }],
            hands: [filler, theirs], stashes: { 1: [3, 3, 3], 2: [3, 3, 3] },
        });
        g.move("use 12/with m0.1 move m0.1 1/with n0.1 trade o0.1");
        expect(g.continued).to.deep.equal([]);
        expect(g.currplayer).eq(2);
        expect(g.hands[1]).to.deep.equal(filler); // swapped on commit
    });
});
