/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import i18next from "i18next";
import { addResource } from "../../src";
import { GnosticaGame } from "../../src/games/gnostica";
import { Piece } from "../../src/games/gnostica/Piece";
import { GnosticaBoard } from "../../src/games/gnostica/board";
import { Territory } from "../../src/games/gnostica/Territory";
import { majorCards, minorCards } from "../../src/common/tarot";

const theWorld = () => majorCards.find(c => c.seq === 21)!;
const major = (seq: number) => majorCards.find(c => c.seq === seq)!;
const card = (uid: string) => minorCards.find(c => c.uid === uid)!;
const aceOfCups = () => card("AC");
const aceOfRods = () => card("AR");
const aceOfDiscs = () => card("AD");
const aceOfSwords = () => card("AS");

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
});

describe("Gnostica: place", () => {
    it("places a small piece on an empty territory, defaulting to up", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        const t = g.board.get(0, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "up" });
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
        g.move("draw", { trusted: true }); // player 1 - now legal, they've placed
        expect(() => g.move("orient m0.1 W")).to.throw(); // player 2, targeting player 1's piece
    });

    it("requires having placed a piece before any non-place action", () => {
        const g = new GnosticaGame(2);
        expect(() => g.move("draw")).to.throw();
    });
});

describe("Gnostica: draw", () => {
    it("discards named cards and redraws back to 6", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        const hand = [...g.hands[0]];
        const discard1 = hand[0];
        const discard2 = hand[1];
        g.move(`draw ${discard1} ${discard2}`, { trusted: true }); // player 1
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
        expect(() => g.move(`draw ${notInHand}`)).to.throw();
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
        g.move("draw", { trusted: true });
        expect(g.currplayer).eq(2);
        g.move("draw", { trusted: true });
        expect(g.currplayer).eq(3);
        g.move("draw", { trusted: true });
        expect(g.currplayer).eq(1);
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
            t.pieces = [new Piece(1, 1, "up")];
        }
        g.move("draw (last)", { trusted: true }); // player 1 announces
        expect(g.lastTurnAnnouncedBy).eq(1);
        g.move("draw", { trusted: true }); // player 2's turn
        g.move("draw", { trusted: true }); // player 1's resolving turn
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
        g.move("draw (last)", { trusted: true }); // player 1 announces
        g.move("draw", { trusted: true }); // player 2
        g.move("draw", { trusted: true }); // player 3
        g.move("draw", { trusted: true }); // player 1's resolving turn - falls short
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.hands[0]).to.deep.equal([]);
        expect(g.gameover).eq(false); // players 2 and 3 remain
    });

    it("declares the sole remaining player the winner if elimination leaves only one player standing", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        g.move("draw (last)", { trusted: true }); // player 1 announces
        g.move("draw", { trusted: true }); // player 2
        g.move("draw", { trusted: true }); // player 1's resolving turn - falls short, eliminated
        expect(g.eliminated).to.deep.equal([1]);
        expect(g.gameover).eq(true);
        expect(g.winner).to.deep.equal([2]);
    });

    it("refuses to announce while another player's announcement hasn't resolved yet", () => {
        const g = new GnosticaGame(3);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("place n0", { trusted: true }); // player 3
        g.move("draw (last)", { trusted: true }); // player 1 announces
        expect(() => g.move("draw (last)")).to.throw(); // player 2 tries to announce too
    });
});

describe("Gnostica: activate/play - minor arcana suit powers", () => {
    it("declining the power is legal - a bare activate with no power step", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        g.move("activate m0", { trusted: true }); // player 1, no power step
        expect(g.board.get(0, 0)!.pieces.length).eq(1); // nothing changed but the turn
        expect(g.currplayer).eq(2);
    });

    it("Cups (own): adds an own small piece to the target cell", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        g.move("activate m0, m0.1 own n0 up", { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "up" });
        expect(g.stashes.get(1)![0]).eq(3); // one for the initial placement, one for this
    });

    it("Cups (copy): adds a copy of a targeted enemy's small piece from THEIR stash", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        g.move("activate m0, m0.1 copy n0 1", { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
        expect(g.stashes.get(2)![0]).eq(3); // player 2's stash, not player 1's
    });

    it("Cups (new): creates a territory on a wasteland from a hand card", () => {
        const g = new GnosticaGame(2);
        g.board.get(-1, 0)!.card = aceOfCups(); // l0
        g.move("place l0 W", { trusted: true }); // player 1, pointing further west
        g.move("place n0", { trusted: true }); // player 2
        // The random deal may not happen to include a spot minor - dedupe
        // and force one in, rather than relying on chance (a real flaky
        // failure otherwise, on the rare hand with none).
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        g.move(`activate l0, l0.1 new k0 ${spotUid}`, { trusted: true });
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): moves the minion itself and reorients it", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfRods();
        g.move("place m0 E", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("activate m0, m0.1 piece m0.1 1 N", { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, orientation: "N" });
    });

    it("Rods (tile): pushes the pointed-at territory further away", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfRods();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        g.move("activate m0, m0.1 tile 1", { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
    });

    it("Discs (piece): grows the minion by one size", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfDiscs();
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("activate m0, m0.1 piece m0.1 N", { trusted: true });
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2, orientation: "N" });
    });

    it("Discs (tile): grows the pointed-at territory's value by one, discarding the old card", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfDiscs();
        const target = g.board.get(1, 0)!; // n0
        const oldUid = card("2C").uid;
        target.card = card("2C"); // a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const royaltyUid = "KS"; // King of Swords, worth 2 - injected so the test doesn't depend on the random deal
        g.hands[0].push(royaltyUid);
        g.move(`activate m0, m0.1 tile n0 ${royaltyUid}`, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("Swords (piece): shrinks a targeted enemy piece, returning it to their stash", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfSwords();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, small piece, on the targeted cell - stash now [4,5,5]
        g.move("activate m0, m0.1 piece n0.1 1", { trusted: true });
        expect(g.board.get(1, 0)!.pieces.length).eq(0); // small piece, 1 pip = destroyed
        expect(g.stashes.get(2)![0]).eq(5); // destruction returns it, undoing the placement's draw
    });

    it("Swords (tile): shrinks the acting player's own uncontested territory's value", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfSwords();
        const oldUid = card("KS").uid; // King of Swords, worth 2
        g.board.get(-1, 0)!.card = card("KS"); // l0
        g.move("place m0 W", { trusted: true }); // player 1, pointing at l0
        g.move("place n0", { trusted: true }); // player 2
        // The random deal may not happen to include a spot minor at all -
        // force one in rather than relying on chance (a real flaky failure
        // otherwise, on the rare hand with none).
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        g.move(`activate m0, m0.1 tile l0 1 ${spotUid}`, { trusted: true });
        expect(g.board.get(-1, 0)!.card?.uid).eq(spotUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("play: uses a hand card's power through any of the player's board pieces, then discards it", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1, defaults to "up" - no relation to the played card's suit
        g.move("place l0", { trusted: true }); // player 2
        const cupsUid = "2C";
        // The random deal may already hold a copy - dedupe first so the
        // post-play "not.include" assertion below can't see a leftover.
        g.hands[0] = g.hands[0].filter(c => c !== cupsUid);
        g.hands[0].push(cupsUid);
        // The minion at m0 points "up", so it can only target its own
        // cell - add the second piece there rather than at an adjacent one.
        g.move(`play ${cupsUid}, m0.1 own m0 up`, { trusted: true });
        expect(g.hands[0]).to.not.include(cupsUid);
        expect(g.discardPile).to.include(cupsUid);
        expect(g.board.get(0, 0)!.pieces.length).eq(2);
        expect(g.board.get(0, 0)!.pieces[1]).to.deep.include({ owner: 1, size: 1 });
    });

    it("refuses to activate a cell with no card", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        expect(() => g.move("activate k0")).to.throw(); // wasteland, no card
    });

    it("refuses to activate a card the acting player has no minion on", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2, elsewhere
        // player 1's turn again after player 2's placement
        g.move("draw", { trusted: true });
        // now player 2's turn - they have no piece on m0
        expect(() => g.move("activate m0")).to.throw();
    });

    it("refuses to USE the Fool or World's power - not yet supported", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = theWorld();
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        expect(() => g.move("activate m0, m0.1 C own m0 up")).to.throw();
    });

    // Every power is optional, including the Fool/World's - even though
    // actually resolving their power isn't implemented yet, declining it
    // entirely needs no resolution at all and should always be legal, same
    // as activating/playing any other card and choosing not to use it.
    it("still allows activating/playing the Fool or World if the power is declined", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = theWorld();
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        expect(() => g.move("activate m0", { trusted: true })).to.not.throw();
    });
});

describe("Gnostica: activate/play - major arcana chaining", () => {
    it("declining every power step is legal, same as minor arcana", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(6); // The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.move("activate m0", { trusted: true }); // no power steps at all
        expect(g.board.get(0, 0)!.pieces.length).eq(1);
        expect(g.currplayer).eq(2);
    });

    it("Lovers (move, then create): a pushed own piece becomes a minion for the second step", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(6); // The Lovers
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")]; // minion A, pointing at n0
        g.board.get(1, 0)!.pieces = [new Piece(1, 1, "S")]; // own piece B, already on n0 (not on the Lovers)
        // A (m0) pushes B (n0) one space east to o0, reorienting it "up";
        // B, now at o0, is used for the Cups step to add a second piece there.
        g.move("activate m0, m0.1 piece n0.1 1 up, o0.1 own o0 up", { trusted: true });
        const dest = g.board.get(2, 0)!; // o0
        expect(dest.pieces.length).eq(2);
        expect(dest.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "up" }); // B, pushed and reoriented
        expect(dest.pieces[1]).to.deep.include({ owner: 1, size: 1, orientation: "up" }); // new piece from the Cups step
    });

    it("Strength: a single grow step may skip straight from spot to major arcana (skipLadder)", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(8); // Strength
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "E")];
        g.board.get(1, 0)!.card = card("AC"); // n0 - spot, worth 1
        g.hands[0].push("00"); // The Fool, worth 3 - injected regardless of the random deal
        g.move("activate m0, m0.1 tile n0 00", { trusted: true }); // only ONE of Strength's two grow steps needed
        expect(g.board.get(1, 0)!.card?.uid).eq("00");
    });

    it("Chariot: two rod steps on the same piece may pass through the void mid-chain", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(7); // The Chariot
        g.board.get(0, 0)!.pieces = [new Piece(1, 3, "W")]; // large minion, pointing away from the grid
        // Step 1 (relaxed, not the last step): 3 west from m0 lands at j0,
        // which is void (no card within reach) - illegal as an ordinary
        // landing, legal here as Chariot's waypoint. Reorient east.
        // Step 2 (the last step, normal rules apply): 3 east from j0 lands
        // back on m0 - a real, legal landing (0 pieces there now, has a card).
        g.move("activate m0, m0.3 piece m0.3 3 E, j0.3 piece j0.3 3 up", { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(1);
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 3, orientation: "up" });
        expect(g.board.get(-3, 0)?.pieces.length ?? 0).eq(0); // nothing left stranded at the waypoint
    });

    it("Empress: orient-minion then create-ignoring-capacity", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(3); // The Empress
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "N"), new Piece(1, 1, "up"), new Piece(1, 1, "up")]; // already 3 here
        // The first piece is size-1 facing N, uniquely identified among the
        // three (also size-1) pieces at m0 - the other two are identical
        // (owner+size+orientation), so once the first is reoriented to
        // match them, the second step's "m0.1" alone still resolves (to
        // the first array slot) via resolvePieceRef's true-duplicate
        // tie-break rather than an ambiguous-ref failure.
        g.move("activate m0, m0.1.N up, m0.1 own m0 up", { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(4); // ignoreCapacity let a 4th piece in
    });

    it("Devil: three orientAny steps, including reorienting the acting minion mid-chain", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(15); // The Devil
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "up")]; // minion, standing
        g.board.get(1, 0)!.pieces = [new Piece(2, 1, "up")]; // an enemy piece, east of m0
        g.move(
            // Step 1: orient the minion itself from "up" to "E", so it can now target n0.
            // Step 2: orient the enemy piece at n0 to face away (W).
            "activate m0, m0.1 m0.1 E, m0.1 n0.1 W, m0.1 m0.1 up",
            { trusted: true },
        );
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("up"); // reoriented twice, back to up
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 2, orientation: "W" }); // enemy piece reoriented too
    });

    it("Judgement: draws named cards from the discard pile, up to the minion's pip count", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(20); // Judgement
        g.board.get(0, 0)!.pieces = [new Piece(1, 2, "up")]; // medium minion, 2 pips
        g.hands[0] = g.hands[0].slice(0, 4); // make room - a full 6-card hand has none
        g.discardPile.push("KS", "00");
        g.move("activate m0, m0.2 KS 00", { trusted: true });
        expect(g.hands[0]).to.include.members(["KS", "00"]);
        expect(g.discardPile).to.deep.equal([]);
    });

    it("High Priestess: two discard-and-redraw rounds, no minion reference needed", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(2); // The High Priestess
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "up")];
        const [firstDiscard] = g.hands[0];
        g.move(`activate m0, ${firstDiscard}`, { trusted: true }); // only the first of the two rounds
        expect(g.hands[0]).to.not.include(firstDiscard);
        expect(g.hands[0].length).eq(6);
    });

    it("Magician: chooses which suit primitive to use for its one step", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(1); // The Magician
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "up")];
        g.move("activate m0, m0.1 C own m0 up", { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // used Cups' "own" mode
    });

    it("refuses more power-step segments than the card actually grants", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(1); // The Magician - only 1 power
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "up")];
        expect(() => g.move("activate m0, m0.1 C own m0 up, m0.1 C own m0 up")).to.throw();
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
            new Piece(1, 1, "up"), new Piece(2, 1, "up"), new Piece(1, 2, "up"),
            new Piece(2, 2, "up"), new Piece(1, 3, "up"),
        ];
        const rep = g.render() as { legend: Record<string, ({ name?: string; nudge?: { dx: number; dy: number } })[]> };
        const entry = Object.values(rep.legend).find(
            glyphs => glyphs.filter(gl => gl.name?.startsWith("pyramid-")).length === t.pieces.length
        );
        expect(entry, "expected a legend entry with 5 pyramid glyphs").to.not.be.undefined;
        const coords = entry!.filter(gl => gl.name?.startsWith("pyramid-")).map(gl => `${gl.nudge!.dx},${gl.nudge!.dy}`);
        expect(new Set(coords).size, "every piece should have a distinct nudge").eq(coords.length);
    });

    // Every piece's own orthogonal neighbours are always inside the render
    // window (see the class-level docs on render()), but a void cell is
    // only given a real, clickable legend entry when it might actually be
    // needed - a piece on the WASTELAND cell next door that could orient
    // toward it (see voidCellNeedsClickTarget's docs: a piece on an actual
    // territory can never have a void neighbour at all). Otherwise it stays
    // the bare "-" placeholder, to avoid padding the rendered board out
    // with clickable-but-pointless space.
    it("only renders a void cell's click target once a piece is on the wasteland next to it", () => {
        const g = new GnosticaGame(2);
        const before = g.render() as { pieces: string };
        expect(before.pieces).to.include("-"); // no pieces anywhere yet - every void cell is bare
        expect(before.pieces).to.not.include("k_void_");

        // (2,1) is wasteland (adjacent to the initial 3x3's corner at
        // (1,1)); its own east neighbour (3,1) is void.
        expect(g.board.classify(2, 1)).eq("wasteland");
        expect(g.board.classify(3, 1)).eq("void");
        g.board.store.set(2, 1, new Territory(undefined, [new Piece(1, 1, "up")]));

        const after = g.render() as { pieces: string };
        expect(after.pieces).to.include("k_void_"); // (3,1) is now a real, clickable placeholder
    });
});

describe("Gnostica: handleClick", () => {
    // handleClick's row/col are relative to render()'s current window
    // (padded by 1 cell beyond the board's own bounding box) - this mirrors
    // that exact formula so tests can go from absolute board coords to the
    // row/col a real click would report.
    const rowColFor = (g: GnosticaGame, x: number, y: number): [number, number] => {
        const minX = g.board.minX - 1;
        const minY = g.board.minY - 1;
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
    // defaults to "up"), so validateMove() alone would mark it complete:1 -
    // but handleClick has to downgrade that to 0, or the interface would
    // auto-submit "up" on the very first click, before the player ever
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
        expect(same.move).eq("place m0 up");
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
        expect(result.move).eq("orient m0.1 up");
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
        expect(same.move).eq("orient m0.1 up");
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
        expect(first.move).eq("orient m0.1 up");
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

    it("Use Territory (activate) via the button bar, then a board click, builds an activate move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        expect(seed.complete).eq(-1);
        const result = g.handleClick(seed.move, row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("activate m0");
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

    it("Pass immediately builds a submittable bare draw move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const result = g.handleClick("", -1, -1, "_btn_pass");
        expect(result.valid).to.be.true;
        expect(result.move).eq("draw");
    });

    it("Declare appends last to an in-progress move, and toggles it back off", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const seed = g.handleClick("", -1, -1, "_btn_pass"); // "draw"
        const declared = g.handleClick(seed.move, -1, -1, "_btn_declare");
        expect(declared.valid).to.be.true;
        expect(declared.move).eq("draw (last)");
        const undeclared = g.handleClick(declared.move, -1, -1, "_btn_declare");
        expect(undeclared.move).eq("draw");
    });

    it("Declare works even with no base action chosen yet, and survives switching to a real action afterwards", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const declared = g.handleClick("", -1, -1, "_btn_declare"); // clicked first, no move string yet
        expect(declared.valid).to.be.true;
        expect(declared.complete).eq(-1); // still needs a real action - not submittable as-is
        expect(declared.move).eq("(last)"); // the bare flag, not a guessed action like "draw"
        // Picking a real action afterwards must carry the flag along, even
        // though clicking "Activate" here has nothing to do with declaring.
        const seed = g.handleClick(declared.move, -1, -1, "_btn_activate");
        expect(seed.move).eq("activate (last)");
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick(seed.move, row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("activate m0 (last)");
        expect(result.complete).eq(0);
    });

    // The trickiest part of reattachLastFlag: a still-incomplete click
    // result (e.g. Pass's own "draw", always legal on its own) gets
    // re-validated once "(last)" makes it a genuinely complete move -
    // catching a declare that's ONLY illegal because of the flag itself
    // (another player's announcement hasn't resolved yet), rather than
    // reusing the pre-declare result's now-stale validity.
    it("re-validates once declaring completes the move, catching ALREADY_ANNOUNCED at that point", () => {
        const g = new GnosticaGame(3);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("place n0", { trusted: true }); // player 3
        g.move("draw (last)", { trusted: true }); // player 1 announces
        // player 2's turn - a bare "draw" (Pass) is perfectly legal on its
        // own; declaring on top of it must not be.
        const declared = g.handleClick("", -1, -1, "_btn_declare");
        expect(declared.move).eq("(last)");
        const passed = g.handleClick(declared.move, -1, -1, "_btn_pass");
        expect(passed.move).eq("draw (last)");
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
        expect(clicked.move).eq("orient m0.1 up");
        g.move(clicked.move, { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const orientBtn = bar!.buttons!.find(b => b.value === "orient");
        expect(orientBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
        const activateBtn = bar!.buttons!.find(b => b.value === "activate");
        expect(activateBtn!.attributes).to.be.undefined;
    });

    it("highlights Discard (not Pass) during a live draw preview, since the two share move text", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.move("draw", { partial: true }); // player 1's own live preview - passes/discards nothing
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const drawBtn = bar!.buttons!.find(b => b.value === "draw");
        const passBtn = bar!.buttons!.find(b => b.value === "pass");
        expect(drawBtn!.attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
        expect(passBtn!.attributes).to.be.undefined; // known simplification: Pass and Discard are indistinguishable from lastmove alone
    });

    it("still highlights Use Territory during a live activate-declining-power preview (no results pushed)", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const clicked = g.handleClick(seed.move, row, col);
        expect(clicked.move).eq("activate m0");
        g.move(clicked.move, { partial: true }); // live preview, power still declined - pushes zero results
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const activateBtn = bar!.buttons!.find(b => b.value === "activate");
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
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0", { trusted: true }); // player 1's piece on m0, "up"
        g.move("place l0", { trusted: true }); // player 2, elsewhere
        g.board.get(0, 0)!.pieces.push(new Piece(2, 1, "up")); // contrive: player 2 ALSO on m0 now
        g.move("activate m0, m0.1 own m0 up", { trusted: true }); // player 1 uses Cups (own), ending their turn
        // it's player 2's turn now, and they haven't clicked anything -
        // even though player 2 also has a piece on the just-activated
        // cell, the mode-button set from player 1's finished turn must not
        // leak through.
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("activate");
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

    it("draw: clicking a hand card toggles it into a draw move, and clicking again toggles it back out", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // draw requires pieces already on the board
        g.move("place l0", { trusted: true }); // back to player 1's turn
        const uid = g.hands[0][0];
        const first = g.handleClick("", -1, -1, `hand_${uid}`);
        expect(first.valid).to.be.true;
        expect(first.move).eq(`draw ${uid}`);
        expect(first.complete).eq(0); // same auto-submit guard as place/orient
        const second = g.handleClick(first.move, -1, -1, `hand_${uid}`);
        expect(second.valid).to.be.true;
        expect(second.move).eq("draw");
    });

    it("draw: rejects a hand-card click for a card not in the acting player's hand", () => {
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
    // multiple hand cards into one draw move would see each card
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

        g.move(`draw ${uid}`, { partial: true });

        expect(g.currplayer, "partial move should not advance the turn").eq(beforePlayer);
        expect(g.stack.length, "partial move should not push onto the stack").eq(beforeStackLength);
        // The discard itself did happen (that's the whole point of a
        // preview - the card should visibly disappear), but a partial
        // draw deliberately does NOT redraw yet, so the hand is smaller
        // rather than being backfilled with a card the player hasn't
        // earned by finishing their discard selection.
        expect(g.hands[0].length).eq(beforeHandLength - 1);
        expect(g.hands[0]).to.not.include(uid);
    });

    it("a partial draw only discards - the actual redraw happens once, on final (non-partial) submission", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [uid1, uid2] = g.hands[0];

        // Each click's preview reconstructs from the true persisted state
        // (mirroring the playground rebuilding `game` from localStorage on
        // every click) rather than accumulating on top of a previous
        // preview - so this clones fresh each time, just as real usage does.
        const preview1 = g.clone();
        preview1.move(`draw ${uid1}`, { partial: true });
        expect(preview1.hands[0].length).eq(5);

        const preview2 = g.clone();
        preview2.move(`draw ${uid1} ${uid2}`, { partial: true });
        expect(preview2.hands[0].length).eq(4);

        // The real game is untouched by any preview made on a clone.
        expect(g.hands[0].length).eq(6);

        g.move(`draw ${uid1} ${uid2}`, { trusted: true }); // final submission
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
        const minX = g.board.minX - 1;
        const minY = g.board.minY - 1;
        return [y - minY, x - minX];
    };

    it("Cups (own): mode button seeds the default step; click-to-orient sets the new piece's facing", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        expect(cellClick.move).eq("activate m0");
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_own");
        expect(modeClick.move).eq("activate m0, m0.1 own n0 up");
        expect(modeClick.valid).to.be.true;
        expect(modeClick.complete).eq(0);
        const [row2, col2] = rowColFor(g, 1, 0); // n0, the target cell itself - re-affirms "up"
        const sameCell = g.handleClick(modeClick.move, row2, col2);
        expect(sameCell.move).eq("activate m0, m0.1 own n0 up");
        const [row3, col3] = rowColFor(g, 2, 0); // "o0", east of n0 - sets the new piece's facing
        const east = g.handleClick(modeClick.move, row3, col3);
        expect(east.move).eq("activate m0, m0.1 own n0 E");
        g.move(modeClick.move, { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0]).to.deep.include({ owner: 1, size: 1, orientation: "up" });
    });

    it("Cups (copy): mode button defaults to the only enemy piece at the target cell", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the targeted cell
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_copy");
        expect(modeClick.move).eq("activate m0, m0.1 copy n0 1");
        g.move(modeClick.move, { trusted: true });
        const t = g.board.get(1, 0)!;
        expect(t.pieces.length).eq(2);
        expect(t.pieces[1]).to.deep.include({ owner: 2, size: 1, orientation: "W" });
    });

    it("Cups (new): mode button seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const g = new GnosticaGame(2);
        g.board.get(-1, 0)!.card = aceOfCups(); // l0
        g.move("place l0 W", { trusted: true }); // player 1, pointing at k0, a wasteland
        g.move("place n0", { trusted: true }); // player 2
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, -1, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_C_new");
        expect(modeClick.move).eq("activate l0, l0.1 new k0");
        expect(modeClick.valid).to.be.true; // still-declined-tolerant, not an error - see applyMinorPower's docs
        expect(modeClick.complete).eq(0);
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${spotUid}`);
        expect(cardClick.move).eq(`activate l0, l0.1 new k0 ${spotUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): mode button defaults to moving the minion itself; clicking the facing cell redirects", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfRods();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_piece");
        expect(modeClick.move).eq("activate m0, m0.1 piece m0.1 1"); // defaults to self
        const [row2, col2] = rowColFor(g, 1, 0); // n0, the facing cell
        const switched = g.handleClick(modeClick.move, row2, col2);
        expect(switched.move).eq("activate m0, m0.1 piece n0.1 1");
        g.move(modeClick.move, { trusted: true }); // commit the (unswitched) default: moves itself
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        // n0 already held player 2's piece (pieces[0]) before the move - the
        // mover lands alongside it, not alone.
        expect(g.board.get(1, 0)!.pieces[1]).to.deep.include({ owner: 1, orientation: "E" });
    });

    it("Rods (tile): mode button defaults to pushing the pointed-at territory 1 space", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfRods();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_R_tile");
        expect(modeClick.move).eq("activate m0, m0.1 tile 1");
        g.move(modeClick.move, { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
    });

    it("Discs (piece): mode button defaults to growing the minion itself", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfDiscs();
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_piece");
        expect(modeClick.move).eq("activate m0, m0.1 piece m0.1");
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 2 });
    });

    it("Discs (tile): mode button seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfDiscs();
        g.board.get(1, 0)!.card = card("2C"); // n0, a known worth-1 spot card
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        const royaltyUid = "KS"; // King of Swords, worth 2
        g.hands[0].push(royaltyUid);
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_D_tile");
        expect(modeClick.move).eq("activate m0, m0.1 tile n0");
        expect(modeClick.valid).to.be.true;
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${royaltyUid}`);
        expect(cardClick.move).eq(`activate m0, m0.1 tile n0 ${royaltyUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
    });

    it("Swords (piece): with no facing piece to attack (minion is \"up\"), falls back to the minion itself", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfSwords();
        g.move("place m0", { trusted: true }); // player 1, size 1, "up" - no facing cell at all
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq("activate m0, m0.1 piece m0.1 1");
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
        g.board.get(0, 0)!.card = aceOfSwords();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, on the facing cell
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq("activate m0, m0.1 piece n0.1 1");
        g.move(modeClick.move, { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(1); // the acting player's own minion survives
        expect(g.board.get(1, 0)!.pieces.length).eq(0); // the enemy piece is destroyed instead
        expect(g.stashes.get(2)![0]).eq(5); // returned to ITS owner's stash
    });

    it("Swords (tile): mode button seeds an incomplete (still valid) step, a hand-card click supplies the uid", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfSwords();
        g.board.get(-1, 0)!.card = card("KS"); // l0, worth 2
        g.move("place m0 W", { trusted: true }); // player 1, pointing at l0
        g.move("place n0", { trusted: true }); // player 2
        // The random deal may not happen to include a spot minor at all -
        // force one in rather than relying on chance (a real flaky failure
        // otherwise, on the rare hand with none).
        const spotUid = "2S";
        g.hands[0] = g.hands[0].filter(uid => uid !== spotUid);
        g.hands[0].push(spotUid);
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_tile");
        expect(modeClick.move).eq("activate m0, m0.1 tile l0 1");
        // Unlike Cups "new"/Discs "tile", Swords "tile" already has enough
        // tokens (mode+cell+pips) to attempt the primitive outright - and a
        // pips-1 attack on a worth-2 territory leaves a nonzero remainder,
        // which genuinely requires a replacement card. This is a real rules
        // error, not applyMinorPower's "still declined" tolerance - fixed
        // up below by the hand-card click regardless.
        expect(modeClick.valid).to.be.false;
        const cardClick = g.handleClick(modeClick.move, -1, -1, `hand_${spotUid}`);
        expect(cardClick.move).eq(`activate m0, m0.1 tile l0 1 ${spotUid}`);
        g.move(cardClick.move, { trusted: true });
        expect(g.board.get(-1, 0)!.card?.uid).eq(spotUid);
    });

    it("narrows the bar to just the selected top-level button, a spacer, then the mode buttons", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.move("activate m0", { partial: true });
        const rep = g.render() as { areas?: { type: string; buttons?: { label: string; value?: string; attributes?: { name: string; value: string }[] }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        // The full top-level set (play/orient/draw/pass) is gone, save for
        // the one choice that got us here - no room to keep both levels.
        expect(values).to.not.include("play");
        expect(values).to.not.include("orient");
        expect(values).to.not.include("draw");
        expect(values).to.not.include("pass");
        expect(values[0]).eq("activate");
        expect(bar!.buttons![0].attributes?.some(a => a.name === "font-weight" && a.value === "bold")).to.be.true;
        expect(values[1]).eq("_spacer"); // divider - the schema has no dedicated type for one
        expect(values.slice(2)).to.include("mode_C_own");
        // Declare stays available throughout - an orthogonal end-of-turn
        // flourish, not a step of this particular choice.
        expect(values[values.length - 1]).eq("declare");
    });

    it("offers only currently-sensible suit modes as buttons", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0", { trusted: true }); // "up" - targets itself, a territory with no enemy on it
        g.move("place l0", { trusted: true });
        g.move("activate m0", { partial: true }); // sync engine state, same as the playground's own preview flow
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.include("mode_C_own");
        expect(values).to.not.include("mode_C_copy"); // no enemy piece at the target (self) cell
        expect(values).to.not.include("mode_C_new"); // "up" targets self, a territory, not a wasteland
    });

    it("bolds the currently-chosen mode button", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        g.move("activate m0, m0.1 own m0 up", { partial: true });
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
        g.board.get(0, 0)!.card = aceOfSwords();
        g.move("place m0", { trusted: true }); // player 1, size 1, "up" - only piece on the board
        g.move("place l0", { trusted: true }); // player 2
        const seed = g.handleClick("", -1, -1, "_btn_activate");
        const [row, col] = rowColFor(g, 0, 0);
        const cellClick = g.handleClick(seed.move, row, col);
        const modeClick = g.handleClick(cellClick.move, -1, -1, "_btn_mode_S_piece");
        expect(modeClick.move).eq("activate m0, m0.1 piece m0.1 1"); // self-attack, since "up" has no facing cell
        g.move(modeClick.move, { partial: true }); // live preview - destroys the player's only piece
        expect(g.board.get(0, 0)!.pieces.length).eq(0); // confirm the destructive side effect really happened
        const rep = g.render() as { areas?: { type: string; buttons?: { value?: string }[] }[] };
        const bar = rep.areas?.find(a => a.type === "buttonBar");
        const values = bar!.buttons!.map(b => b.value);
        expect(values).to.not.deep.equal(["place"]);
        expect(values).to.include("activate");
        expect(values).to.include("play");
    });
});

// Regression tests for validateMove()'s rearchitecture: a genuine,
// non-mutating validator (gnostica.ts's validateX tree + gnostica/powers.ts's
// checkX functions) replacing the old "clone this, try applyMove() on the
// clone, catch whatever it throws" mechanism. That old mechanism silently
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
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0", { trusted: true }); // player 1, "up" - targets itself
        g.move("place l0", { trusted: true }); // player 2
        g.board.get(0, 0)!.pieces.push(new Piece(1, 1, "up"), new Piece(1, 1, "up")); // fill to capacity (3)
        const result = g.validateMove("activate m0, m0.1 own m0 up");
        expect(result.valid).to.be.false;
        // Compares against CELL_FULL's own real message (whatever it
        // currently is - not hardcoded, since the translation gets filled
        // in independently of this test) rather than the generic
        // INVALID_MOVE fallback ("'...' doesn't look like a valid move.").
        expect(result.message).to.eq(i18next.t("apgames:validation.gnostica.CELL_FULL"));
        expect(result.message).to.not.eq(i18next.t("apgames:validation._general.INVALID_MOVE", { move: "activate m0, m0.1 own m0 up" }));
    });

    it("does not mutate game state while validating an invalid move", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfCups();
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const handBefore = [...g.hands[0]];
        const piecesBefore = g.board.get(0, 0)!.pieces.length;
        const discardBefore = g.discardPile.length;
        const result = g.validateMove("activate m0, m0.1 own m0 up, m0.1 own m0 up"); // MINOR_ONE_STEP_ONLY
        expect(result.valid).to.be.false;
        expect(g.hands[0]).to.deep.equal(handBefore);
        expect(g.board.get(0, 0)!.pieces.length).to.eq(piecesBefore);
        expect(g.discardPile.length).to.eq(discardBefore);
    });

    // Second bug found while building this refactor: Cups "own"/"copy"
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
        g.board.get(cx, cy)!.card = aceOfCups();
        g.move(`place ${cornerCell} E`, { trusted: true }); // player 1, pointing at the untouched cell
        g.move("place l0", { trusted: true }); // player 2
        const move = `activate ${cornerCell}, ${cornerCell}.1 own ${targetCell} up`;
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
        g.board.get(0, 0)!.card = aceOfRods();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0", { trusted: true }); // player 2, size 1
        g.board.get(1, 0)!.pieces.push(new Piece(2, 2, "up")); // a second, size-2 piece, also at n0
        const move = "activate m0, m0.1 piece n0.1 1"; // "n0.1" - pips alone, no orientation/player needed
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces.length).to.eq(1); // the size-1 piece moved away
        expect(g.board.get(1, 0)!.pieces[0].size).to.eq(2); // the size-2 piece was untouched
    });

    it("needs orientation too when two same-size pieces at the cell face different ways, and reports ambiguity without it", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfSwords();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, size 1, facing W
        g.board.get(1, 0)!.pieces.push(new Piece(2, 1, "N")); // a second size-1 piece, facing N
        // "n0.1" alone still matches both - genuinely ambiguous, not a
        // "pick the first" case (the two pieces differ in orientation).
        expect(g.validateMove("activate m0, m0.1 piece n0.1 1").valid).to.be.false;
        const move = "activate m0, m0.1 piece n0.1.N 1"; // pips + orientation picks out the N-facing one
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move, { trusted: true });
        const remaining = g.board.get(1, 0)!.pieces;
        expect(remaining.length).to.eq(1);
        expect(remaining[0].orientation).to.eq("W"); // the untargeted piece survives
    });

    it("resolves to the first match when two pieces are fully identical, rather than erroring", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfSwords();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0", { trusted: true }); // player 2, size 1, "up"
        g.board.get(1, 0)!.pieces.push(new Piece(2, 1, "up")); // an identical second piece - same owner, size, facing
        const move = "activate m0, m0.1 piece n0.1 1"; // fully qualifying further (n0.1.up.2) couldn't help either
        expect(g.validateMove(move).valid).to.be.true;
        g.move(move, { trusted: true });
        expect(g.board.get(1, 0)!.pieces.length).to.eq(1); // one of the two interchangeable pieces destroyed
    });
});
