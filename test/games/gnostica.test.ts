/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import i18next from "i18next";
import { addResource } from "../../src";
import { GnosticaGame } from "../../src/games/gnostica";
import { Piece } from "../../src/games/gnostica/Piece";
import { GnosticaBoard } from "../../src/games/gnostica/board";
import { Territory } from "../../src/games/gnostica/Territory";
import { majorCards, minorCards, TarotCard } from "../../src/common/tarot";

const theWorld = () => majorCards.find(c => c.seq === 21)!;
const major = (seq: number) => majorCards.find(c => c.seq === seq)!;
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
    g.board.get(x, y)!.card = target;
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
    it("a fresh non-bidding game deals hands already in rank order: majors first, then minors grouped by suit and ranked within it", () => {
        const g = new GnosticaGame(3);
        for (const hand of g.hands) {
            const cards = hand.map(uid => majorCards.find(c => c.uid === uid) ?? minorCards.find(c => c.uid === uid)!);
            let lastWasMajor = true;
            let lastSuitSeq = -Infinity;
            let lastRankSeq = -Infinity;
            for (const c of cards) {
                if (c.major) {
                    expect(lastWasMajor, `major ${c.uid} appears after a minor`).to.be.true;
                } else {
                    lastWasMajor = false;
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

    it("the bidding variant leaves hands in raw draw order through the bidding phase itself, then sorts once it resolves", () => {
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
        // Now sorted: the bid major is gone (spent on the bid), so
        // what's left is minors sorted by suit/rank.
        const cards = g.hands[0].map(uid => minorCards.find(c => c.uid === uid)!);
        for (let i = 1; i < cards.length; i++) {
            const a = cards[i - 1], b = cards[i];
            expect(a.suit.seq < b.suit.seq || (a.suit.seq === b.suit.seq && a.rank.seq < b.rank.seq)).to.be.true;
        }
    });

    it("stays sorted after an ordinary main-phase hand mutation (discard/draw)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place n0", { trusted: true });
        g.hands[0] = [card("5R").uid, major(1).uid, card("AC").uid, card("2C").uid, card("KS").uid, "3D"];
        g.move("discard 5R", { trusted: true }); // draws back to 6, then re-sorts
        const cards = g.hands[0].map(uid => majorCards.find(c => c.uid === uid) ?? minorCards.find(c => c.uid === uid)!);
        let lastWasMajor = true;
        let lastSuitSeq = -Infinity;
        let lastRankSeq = -Infinity;
        for (const c of cards) {
            if (c.major) {
                expect(lastWasMajor).to.be.true;
            } else {
                lastWasMajor = false;
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

    it("reorders to start from the bid winner once the round resolves", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        g.hands[0] = [card("KS").uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [major(21).uid, "AR", "2R", "3R", "4R", "5R"]; // The World - unbeatable
        g.hands[2] = [card("QS").uid, "AD", "2D", "3D", "4D", "5D"];
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true }); // player 2's major wins
        g.move("bid 1", { trusted: true });
        expect(g.bidWinner).eq(2);
        const area = keyArea(g)!;
        expect(area.list!.map(e => e.piece)).to.deep.equal(["turnorder_p2", "turnorder_p3", "turnorder_p1"]);
    });
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
    it("declining the power is legal - a bare use with no power step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
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
        forceCardAt(g, 0, 0, () => aceOfRods());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        g.move(`use ${aceOfRods().uid}, m0.1 tile 1`, { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
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
        forceCardAt(g, 0, 0, () => aceOfSwords());
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, small piece, on the targeted cell - stash now [4,5,5]
        g.move(`use ${aceOfSwords().uid}, m0.1 piece n0.1 1`, { trusted: true });
        expect(g.board.get(1, 0)!.pieces.length).eq(0); // small piece, 1 pip = destroyed
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

    it("refuses to USE the Fool or World's power - not yet supported", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        expect(() => g.move(`use ${theWorld().uid}, m0.1 C own m0 U`)).to.throw();
    });

    // Every power is optional, including the Fool/World's - even though
    // actually resolving their power isn't implemented yet, declining it
    // entirely needs no resolution at all and should always be legal, same
    // as activating/playing any other card and choosing not to use it.
    it("still allows activating/playing the Fool or World if the power is declined", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => theWorld());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        expect(() => g.move(`use ${theWorld().uid}`, { trusted: true })).to.not.throw();
    });
});

describe("Gnostica: activate/play - major arcana chaining", () => {
    it("declining every power step is legal, same as minor arcana", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.move(`use ${major(6).uid}`, { trusted: true }); // no power steps at all
        expect(g.board.get(0, 0)!.pieces.length).eq(1);
        expect(g.currplayer).eq(2);
    });

    it("Lovers (move, then create): a pushed own piece becomes a minion for the second step", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(6)); // The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, pointing at n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")]; // own piece B, already on n0 (not on the Lovers)
        // A (m0) pushes B (n0) one space east to o0, reorienting it "U";
        // B, now at o0, is used for the Cups step to add a second piece there.
        g.move(`use ${major(6).uid}, m0.1 piece n0.1 1 U, o0.1 own o0 U`, { trusted: true });
        const dest = g.board.get(2, 0)!; // o0
        expect(dest.pieces.length).eq(2);
        expect(dest.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "U" }); // B, pushed and reoriented
        expect(dest.pieces[1]).to.deep.include({ owner: 1, size: 1, orientation: "U" }); // new piece from the Cups step
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

    // A territory can legitimately exceed the normal 3-piece capacity (some
    // major arcana powers bypass Territory.canAdd()'s check), and pyramids
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
        const rep = g.render() as { legend: Record<string, ({ name?: string; nudge?: { dx: number; dy: number } })[]> };
        const entry = Object.values(rep.legend).find(
            glyphs => glyphs.filter(gl => gl.name?.startsWith("pyramid-")).length === t.pieces.length
        );
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
        g.board.store.set(2, 1, new Territory(undefined, [new Piece(1, 1, "U")]));

        const after = g.render() as { pieces: string };
        expect(after.pieces).to.not.include("k_void_");
    });

    it("shows a buffer on the single board edge a wasteland minion sits on, once it starts reorienting", () => {
        const g = new GnosticaGame(2);
        // (2,0) becomes the board's own new eastern edge (maxX): the
        // initial 3x3 deal only reaches x=1, and (2,0)'s own y=0 isn't
        // also a min/max boundary, so this is unambiguously an east-only
        // case, not a corner.
        g.board.store.set(2, 0, new Territory(undefined, [new Piece(1, 1, "U")]));
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
        g.board.store.set(2, 0, new Territory(undefined, [new Piece(2, 1, "S")])); // enemy target, on an edge wasteland
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
        g.board.store.set(2, 0, new Territory(undefined, [new Piece(2, 1, "S")])); // enemy target, on an edge wasteland
        expect(g.board.classify(2, 0)).eq("wasteland");
        const minionCell = GnosticaBoard.coords2algebraic(1, 0);
        const targetCell = GnosticaBoard.coords2algebraic(2, 0);
        g.move(`use ${major(5).uid}, ${minionCell}.1 ${targetCell}.1 N`, { trusted: true });
        const rep = g.render() as { board: { buffer?: { show: string[] } } };
        expect(rep.board.buffer?.show).to.deep.equal(["E"]);
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
        expect(result.complete).eq(0); // same auto-submit guard as place
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
        expect(result.complete).eq(0);
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

    it("Pass immediately builds a submittable bare discard move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_pass");
        expect(result.valid).to.be.true;
        expect(result.move).eq("discard");
    });

    it("Declare appends last to an in-progress move, and toggles it back off", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const seed = g.handleClick("", -1, -1, "_btn_pass"); // "discard"
        const declared = g.handleClick(seed.move, -1, -1, "_btn_declare");
        expect(declared.valid).to.be.true;
        expect(declared.move).eq("discard (last)");
        const undeclared = g.handleClick(declared.move, -1, -1, "_btn_declare");
        expect(undeclared.move).eq("discard");
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
        expect(result.complete).eq(0);
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
        // player 2's turn - a bare "discard" (Pass) is perfectly legal on its
        // own; declaring on top of it must not be.
        const declared = g.handleClick("", -1, -1, "_btn_declare");
        expect(declared.move).eq("(last)");
        const passed = g.handleClick(declared.move, -1, -1, "_btn_pass");
        expect(passed.move).eq("discard (last)");
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
        g.hands[1][0] = ""; // simulate the back end redacting player 2's first card
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
        expect(modeClick.valid).to.be.true; // still-declined-tolerant, not an error - see applyMinorPower's docs
        expect(modeClick.complete).eq(0);
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
        forceCardAt(g, 0, 0, () => aceOfRods());
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
        expect(modeClick.valid).to.be.true;
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${royaltyUid}`);
        expect(cardClick.move).eq(`use ${aceOfDiscs().uid}, m0.1 tile n0 ${royaltyUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
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
        expect(g.board.get(1, 0)!.pieces.length).eq(0); // the enemy piece is destroyed instead
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

    it("offers only currently-sensible suit modes as buttons", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true }); // "U" - targets itself, a territory with no enemy on it
        g.move("place l0", { trusted: true });
        g.move(`use ${aceOfCups().uid}`, { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("mode_C_own");
        expect(values).to.not.include("mode_C_enemy"); // no enemy piece at the target (self) cell
        expect(values).to.not.include("mode_C_new"); // "U" targets self, a territory, not a wasteland
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
    // previously looked up the target cell with the throwing getTerritory()
    // helper, which threw on a genuinely untouched wasteland (no stored
    // Territory object at all, since one is only ever created for a cell
    // that already has a card or a piece) - inconsistent with
    // movePiece/hermitMovePiece, which already handle exactly
    // this case by creating one on the fly. Now fixed to match.
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
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("orient", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("orient m0.1 U");
        expect(result.message).eq(directionMsg());
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
        g.board.store.set(2, 0, new Territory(undefined, [new Piece(1, 1, "U")]));
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
        expect(result.move).eq("discard");
        expect(result.message).eq(i18next.t("apgames:validation._general.VALID_MOVE"));
        expect(result.message).to.not.eq(directionMsg());
    });
});

// The bare "activate <cell>"/"play <uid>" state, right after picking the
// card and before any suit mode or major-arcana power step - already a
// complete, legal move (declining the power is always allowed), but
// picking a power is the more usual next step, so it gets its own
// POWER_STILL_OPTIONAL message instead of the generic VALID_MOVE one.
// Applies equally to a minor or a major arcana card, and to both activate
// and play.
describe("Gnostica: power-still-optional messaging", () => {
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
    const powerMsg = () => i18next.t("apgames:validation.gnostica.POWER_STILL_OPTIONAL");

    it("activate: a board click onto a card cell carries the message (minor arcana)", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => aceOfCups());
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`use ${aceOfCups().uid}`);
        expect(result.message).eq(powerMsg());
    });

    it("activate: carries the message for a major arcana card too", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(10)); // Wheel of Fortune
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("use", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`use ${major(10).uid}`);
        expect(result.message).eq(powerMsg());
    });

    it("play: a hand-card click carries the message (minor arcana)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const uid = g.hands[0].find(u => !/^\d{2}$/.test(u))!; // a minor card
        const result = g.handleClick("play", -1, -1, `hand_${uid}`);
        expect(result.valid).to.be.true;
        expect(result.move).eq(`play ${uid}`);
        expect(result.message).eq(powerMsg());
    });

    it("play: carries the message for a major arcana card too", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.hands[0].push("10"); // Wheel of Fortune, injected regardless of the random deal
        const result = g.handleClick("play", -1, -1, "hand_10");
        expect(result.valid).to.be.true;
        expect(result.move).eq("play 10");
        expect(result.message).eq(powerMsg());
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

    it("Lovers (move, then create): step 2's Cups buttons appear only once step 1 is complete; a board click still redirects step 1's default target; the chained click sequence resolves correctly", () => {
        const setup = (game: GnosticaGame) => {
            forceCardAt(game, 0, 0, () => major(6)); // The Lovers
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
        expect(step2.move).eq(`use ${major(6).uid}, m0.1 piece n0.1 1, m0.1 own n0 U`);
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
        expect(modeClick.move).to.match(new RegExp(`^use ${major(16).uid}, m0\\.1 E, `));
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

    it("highPriestess: hand-card clicks toggle a discard list (no minionRef at all), then redraw to 6 on commit", () => {
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
        g.move(click3.move, { trusted: true }); // declines the second highPriestess step too
        expect(g.hands[0]).to.not.include("5C");
        expect(g.hands[0].length).eq(6); // redrawn from 2 (3 - 1 discarded) back to 6
        expect(g.discardPile).to.include("5C");
        expect(g.currplayer).eq(2);
    });

    it("Hanged Man (move, then tradeHands): a click on a cell already 'claimed' by step 1 still starts step 2, not step 1's own refinement", () => {
        const g = new GnosticaGame(2);
        forceCardAt(g, 0, 0, () => major(12)); // The Hanged Man
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // A, facing n0
        const seed = g.handleClick("", -1, -1, "_btn_use");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const step1 = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_tile");
        expect(step1.move).eq(`use ${major(12).uid}, m0.1 tile 1`); // pushes n0's territory east; A never moves
        // m0 is BOTH step 1's own "cycle distance" click target AND
        // tradeHands' own "self" target - starting step 2 wins (see
        // handleClickCore's own docs on this priority).
        const [rowM, colM] = rowColFor(g, 0, 0);
        const step2 = g.handleClick(step1.move, rowM, colM);
        expect(step2.move).eq(`use ${major(12).uid}, m0.1 tile 1, m0.1 m0.1`);
        expect(step2.valid).to.be.true;
        g.move(step2.move, { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
        expect(g.currplayer).eq(2);
    });

    it("orientMinion/tradeHands/orientAny/hierophantReplace/judgementDraw/highPriestess leave the button bar uncollapsed (no mode buttons of their own)", () => {
        const setups: [number, () => void][] = [
            [3, () => undefined],  // Empress: orientMinion
            [11, () => undefined], // Justice: tradeHands
            [15, () => undefined], // Devil: orientAny
            [5, () => undefined],  // Hierophant: hierophantReplace
            [20, () => undefined], // Judgement: judgementDraw
            [2, () => undefined],  // High Priestess: highPriestess
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
