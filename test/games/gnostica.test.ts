/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import { GnosticaGame } from "../../src/games/gnostica";
import { Piece } from "../../src/games/gnostica/Piece";
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
        g.move("orient m0.0 W", { trusted: true }); // player 1 again
        expect(g.board.get(0, 0)!.pieces[0].orientation).eq("W");
    });

    it("refuses to reorient an opponent's piece", () => {
        const g = new GnosticaGame(2);
        g.move("place m0 N", { trusted: true }); // player 1
        g.move("place n0", { trusted: true }); // player 2
        g.move("draw", { trusted: true }); // player 1 - now legal, they've placed
        expect(() => g.move("orient m0.0 W")).to.throw(); // player 2, targeting player 1's piece
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
        g.move("draw, last", { trusted: true }); // player 1 announces
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
        g.move("draw, last", { trusted: true }); // player 1 announces
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
        g.move("draw, last", { trusted: true }); // player 1 announces
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
        g.move("draw, last", { trusted: true }); // player 1 announces
        expect(() => g.move("draw, last")).to.throw(); // player 2 tries to announce too
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
        g.move("activate m0, m0.0 own n0 up", { trusted: true });
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
        g.move("activate m0, m0.0 copy n0 0", { trusted: true });
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
        const spotUid = g.hands[0].find(uid => /^(A|[2-9]|10)C$|^(A|[2-9]|10)R$|^(A|[2-9]|10)D$|^(A|[2-9]|10)S$/.test(uid))!;
        g.move(`activate l0, l0.0 new k0 ${spotUid}`, { trusted: true });
        expect(g.board.get(-2, 0)!.card?.uid).eq(spotUid);
        expect(g.hands[0]).to.not.include(spotUid);
    });

    it("Rods (piece): moves the minion itself and reorients it", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfRods();
        g.move("place m0 E", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("activate m0, m0.0 piece m0.0 1 N", { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(0);
        expect(g.board.get(1, 0)!.pieces[0]).to.deep.include({ owner: 1, orientation: "N" });
    });

    it("Rods (tile): pushes the pointed-at territory further away", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfRods();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place l0", { trusted: true }); // player 2
        g.move("activate m0, m0.0 tile 1", { trusted: true });
        expect(g.board.has(1, 0)).eq(false);
        expect(g.board.get(2, 0)!.card).to.not.eq(undefined);
    });

    it("Discs (piece): grows the minion by one size", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfDiscs();
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        g.move("activate m0, m0.0 piece m0.0 N", { trusted: true });
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
        g.move(`activate m0, m0.0 tile n0 ${royaltyUid}`, { trusted: true });
        expect(g.board.get(1, 0)!.card?.uid).eq(royaltyUid);
        expect(g.discardPile).to.include(oldUid);
    });

    it("Swords (piece): shrinks a targeted enemy piece, returning it to their stash", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = aceOfSwords();
        g.move("place m0 E", { trusted: true }); // player 1, pointing at n0
        g.move("place n0 W", { trusted: true }); // player 2, small piece, on the targeted cell - stash now [4,5,5]
        g.move("activate m0, m0.0 piece n0.0 1", { trusted: true });
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
        const spotUid = g.hands[0].find(uid => /^(A|[2-9]|10)[CRDS]$/.test(uid))!;
        g.move(`activate m0, m0.0 tile l0 1 ${spotUid}`, { trusted: true });
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
        g.move(`play ${cupsUid}, m0.0 own m0 up`, { trusted: true });
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

    it("refuses to activate/play the Fool or the World - not yet supported", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = theWorld();
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        expect(() => g.move("activate m0")).to.throw();
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
        g.move("activate m0, m0.0 piece n0.0 1 up, o0.0 own o0 up", { trusted: true });
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
        g.move("activate m0, m0.0 tile n0 00", { trusted: true }); // only ONE of Strength's two grow steps needed
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
        g.move("activate m0, m0.0 piece m0.0 3 E, j0.0 piece j0.0 3 up", { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(1);
        expect(g.board.get(0, 0)!.pieces[0]).to.deep.include({ owner: 1, size: 3, orientation: "up" });
        expect(g.board.get(-3, 0)?.pieces.length ?? 0).eq(0); // nothing left stranded at the waypoint
    });

    it("Empress: orient-minion then create-ignoring-capacity", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(3); // The Empress
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "N"), new Piece(1, 1, "up"), new Piece(1, 1, "up")]; // already 3 here
        g.move("activate m0, m0.0 up, m0.0 own m0 up", { trusted: true });
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
            "activate m0, m0.0 m0.0 E, m0.0 n0.0 W, m0.0 m0.0 up",
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
        g.move("activate m0, m0.0 KS 00", { trusted: true });
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
        g.move("activate m0, m0.0 C own m0 up", { trusted: true });
        expect(g.board.get(0, 0)!.pieces.length).eq(2); // used Cups' "own" mode
    });

    it("refuses more power-step segments than the card actually grants", () => {
        const g = new GnosticaGame(2);
        g.board.get(0, 0)!.card = major(1); // The Magician - only 1 power
        g.board.get(0, 0)!.pieces = [new Piece(1, 1, "up")];
        expect(() => g.move("activate m0, m0.0 C own m0 up, m0.0 C own m0 up")).to.throw();
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

    it("place: clicking the same cell again cycles the orientation", () => {
        const g = new GnosticaGame(2);
        const [row, col] = rowColFor(g, 0, 0);
        const first = g.handleClick("", row, col);
        const second = g.handleClick(first.move, row, col);
        expect(second.valid).to.be.true;
        expect(second.move).eq("place m0 N");
    });

    it("orient: clicking your own piece (with pieces already on the board) starts an orient move", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true }); // player 1
        g.move("place l0", { trusted: true }); // player 2
        const [row, col] = rowColFor(g, 0, 0);
        const result = g.handleClick("", row, col);
        expect(result.valid).to.be.true;
        expect(result.move).eq("orient m0.0 up");
        expect(result.complete).eq(0); // same auto-submit guard as place
    });

    it("orient: clicking the same piece again cycles the facing", () => {
        const g = new GnosticaGame(2);
        g.move("place m0", { trusted: true });
        g.move("place l0", { trusted: true });
        const [row, col] = rowColFor(g, 0, 0);
        const first = g.handleClick("", row, col);
        const second = g.handleClick(first.move, row, col);
        expect(second.valid).to.be.true;
        expect(second.move).eq("orient m0.0 N");
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
});
