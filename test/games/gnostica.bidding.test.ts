/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import { AreaButtonBar } from "@abstractplay/renderer/build/schemas/schema";
import { addResource } from "../../src";
import { GnosticaGame } from "../../src/games/gnostica";
import { majorCards, minorCards } from "../../src/common/tarot";

const major = (seq: number) => majorCards.find(c => c.seq === seq)!;
const minor = (uid: string) => minorCards.find(c => c.uid === uid)!;

describe("Gnostica: bidding variant, stage 1 (opening bid)", () => {
    it("starts in the bidding phase only when the variant is selected", () => {
        const withBidding = new GnosticaGame(3, ["bidding"]);
        expect(withBidding.phase).eq("bidding");
        const without = new GnosticaGame(3);
        expect(without.phase).eq("main");
    });

    it("every other move head is illegal while a bid is in progress", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        expect(() => g.move("place k1")).to.throw();
        expect(() => g.move("discard")).to.throw();
    });

    it("rejects a bad bid position (zero, out of range, non-numeric)", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        expect(() => g.move("bid 0")).to.throw();
        expect(() => g.move(`bid ${g.hands[0].length + 1}`)).to.throw();
        expect(() => g.move("bid x")).to.throw();
    });

    it("a unique winner resolves the round immediately and transitions to redraw", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"]; // King of Swords first
        g.hands[1] = [minor("QS").uid, "AR", "2R", "3R", "4R", "5R"]; // Queen of Swords first
        g.move("bid 1", { trusted: true }); // player 1 bids the King
        expect(g.phase).eq("bidding"); // still waiting on player 2
        g.move("bid 1", { trusted: true }); // player 2 bids the Queen
        expect(g.phase).eq("redraw");
        expect(g.bidWinner).eq(1); // King beats Queen
        expect(g.biddingPool).to.have.members([minor("KS").uid, minor("QS").uid]);
        expect(g.hands[0]).to.not.include(minor("KS").uid); // spent
        expect(g.hands[1]).to.not.include(minor("QS").uid);
    });

    it("Ace is the lowest minor rank, King the highest", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = [minor("AS").uid, "2C", "3C", "4C", "5C", "6C"]; // Ace of Swords
        g.hands[1] = [minor("2S").uid, "2R", "3R", "4R", "5R", "6R"]; // 2 of Swords
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        expect(g.bidWinner).eq(2); // 2 beats Ace
    });

    it("any major arcana bid beats every minor arcana bid, regardless of the major's own number", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = [major(0).uid, "AC", "2C", "3C", "4C", "5C"]; // The Fool - lowest-numbered major
        g.hands[1] = [minor("KS").uid, "AR", "2R", "3R", "4R", "5R"]; // King of Swords - highest minor
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        expect(g.bidWinner).eq(1); // Fool still beats King
    });

    it("among multiple major-arcana bids, the highest-numbered major wins", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        g.hands[0] = [major(5).uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [major(15).uid, "AR", "2R", "3R", "4R", "5R"];
        g.hands[2] = [minor("KS").uid, "AD", "2D", "3D", "4D", "5D"]; // minor - shouldn't matter
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        expect(g.bidWinner).eq(2); // The Devil (15) beats The Hierophant (5) and any minor
    });

    it("a tie forces every player (not just the tied ones) to bid again, accumulating both rounds into the pool", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        g.hands[0] = [minor("KS").uid, minor("AC").uid, "2C", "3C", "4C", "5C"];
        g.hands[1] = [minor("KR").uid, minor("AR").uid, "2R", "3R", "4R", "5R"];
        g.hands[2] = [minor("2D").uid, minor("AD").uid, "3D", "4D", "5D", "6D"]; // not tied, but must still re-bid
        g.move("bid 1", { trusted: true }); // P1 bids King of Swords
        g.move("bid 1", { trusted: true }); // P2 bids King of Rods - ties P1
        g.move("bid 1", { trusted: true }); // P3 bids 2 of Discs
        // Round 1 ties between P1/P2 (both Kings) - resets everyone, round 2 begins.
        expect(g.phase).eq("bidding");
        expect(g.bidRound).eq(1);
        expect(g.currplayer).eq(1);
        expect(g.bidPositions).to.deep.equal([null, null, null]);
        expect(g.biddingPool).to.have.members([minor("KS").uid, minor("KR").uid, minor("2D").uid]);

        g.move("bid 1", { trusted: true }); // P1 bids Ace of Cups
        g.move("bid 1", { trusted: true }); // P2 bids Ace of Rods
        g.move("bid 1", { trusted: true }); // P3 bids Ace of Discs - now everyone tied on Ace!
        expect(g.phase).eq("bidding");
        expect(g.bidRound).eq(2);
        expect(g.biddingPool.length).eq(6);

        g.move("bid 1", { trusted: true }); // P1: 2C
        g.move("bid 1", { trusted: true }); // P2: 2R
        g.move("bid 1", { trusted: true }); // P3: 3D
        expect(g.phase).eq("redraw"); // no more ties possible - 2 vs 2 vs 3
        expect(g.bidWinner).eq(3);
        expect(g.biddingPool.length).eq(9);
    });

    it("exhaustion fallback: an unresolvable tie keeps the tied players in their existing (lowest-player-number-first) order", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        // Single-card hands that immediately tie and can't be re-bid.
        g.hands[0] = [minor("KS").uid];
        g.hands[1] = [minor("KR").uid];
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        expect(g.phase).eq("redraw");
        expect(g.bidWinner).eq(1); // lowest-numbered tied player, not random
        expect(g.hands[0]).to.be.empty;
        expect(g.hands[1]).to.be.empty;
        expect(g.biddingPool).to.have.members([minor("KS").uid, minor("KR").uid]);
    });

    it("exhaustion fires exactly when hands would run out, even after several genuinely tied rounds - never attempts a round with empty hands", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        // Two rounds of ties, back to back, using up both players' entire
        // (2-card) hands - the fallback must not fire early (round 1 still
        // has cards left to re-bid with) but must fire the instant round 2
        // empties both hands, rather than letting the loop try for a
        // round 3 that could never produce a legal bid.
        g.hands[0] = [minor("KS").uid, minor("AC").uid];
        g.hands[1] = [minor("KR").uid, minor("AR").uid];
        g.move("bid 1", { trusted: true }); // P1: King of Swords
        g.move("bid 1", { trusted: true }); // P2: King of Rods - ties
        expect(g.phase).eq("bidding"); // round 1 tie, hands still have 1 card each - re-bid, not exhaustion
        expect(g.bidRound).eq(1);
        expect(g.hands[0].length).eq(1);
        expect(g.hands[1].length).eq(1);

        g.move("bid 1", { trusted: true }); // P1: Ace of Cups
        g.move("bid 1", { trusted: true }); // P2: Ace of Rods - ties again, and now both hands are empty
        expect(g.phase).eq("redraw"); // exhaustion fallback fired on round 2, not a stalled round 3
        expect(g.bidRound).eq(2);
        expect(g.bidWinner).eq(1); // lowest-numbered tied player, not random
        expect(g.hands[0]).to.be.empty;
        expect(g.hands[1]).to.be.empty;
        expect(g.biddingPool).to.have.members([minor("KS").uid, minor("KR").uid, minor("AC").uid, minor("AR").uid]);
    });

    it("exhaustion fallback: with only a subset of players tied, still picks the lowest-numbered player among just that subset", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        // P2 and P3 tie both rounds (Kings, then Queens); P1 bids the
        // lowest possible card (an Ace) both times so they never
        // accidentally win outright, but per the rules still has to
        // keep re-bidding every round right alongside them.
        g.hands[0] = [minor("AC").uid, minor("AD").uid];
        g.hands[1] = [minor("KS").uid, minor("QS").uid];
        g.hands[2] = [minor("KR").uid, minor("QR").uid];
        g.move("bid 1", { trusted: true }); // P1: Ace of Cups
        g.move("bid 1", { trusted: true }); // P2: King of Swords
        g.move("bid 1", { trusted: true }); // P3: King of Rods - P2/P3 tie
        expect(g.phase).eq("bidding"); // still one card left each - re-bid, not exhaustion yet
        g.move("bid 1", { trusted: true }); // P1: Ace of Discs
        g.move("bid 1", { trusted: true }); // P2: Queen of Swords
        g.move("bid 1", { trusted: true }); // P3: Queen of Rods - P2/P3 tie again, hands now empty
        expect(g.phase).eq("redraw");
        expect(g.bidWinner).eq(2); // lowest-numbered of the tied {2, 3}, not player 1
    });

    it("computes the redraw order as the reverse of normal turn order, ending at the winner", () => {
        const g = new GnosticaGame(4, ["bidding"]);
        g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [minor("2S").uid, "AR", "2R", "3R", "4R", "5R"];
        g.hands[2] = [minor("3S").uid, "AD", "2D", "3D", "4D", "5D"];
        g.hands[3] = [minor("4S").uid, minor("5S").uid, minor("6S").uid, minor("7S").uid, minor("8S").uid, minor("9S").uid];
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        expect(g.bidWinner).eq(1); // King is the highest bid
        expect(g.redrawOrder).to.deep.equal([4, 3, 2, 1]); // winner's right neighbour first, winner last
        expect(g.currplayer).eq(4);
        expect(g.redrawPos).eq(0);
    });

    it("survives a real serialize/deserialize round-trip mid-bid (JSON turns unfilled array slots into null, not undefined)", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [minor("2S").uid, "AR", "2R", "3R", "4R", "5R"];
        g.hands[2] = [minor("3S").uid, "AD", "2D", "3D", "4D", "5D"];
        g.move("bid 1", { trusted: true }); // only player 1 has bid so far
        const reloaded = new GnosticaGame(g.serialize());
        expect(reloaded.phase).eq("bidding");
        expect(reloaded.currplayer).eq(2);
        // The real bug this guards against: validateBid mistakenly seeing
        // player 2's still-open slot as "already bid" after a round-trip.
        expect(() => reloaded.move("bid 1")).to.not.throw();
        expect(reloaded.phase).eq("bidding"); // still waiting on player 3
        expect(() => reloaded.move("bid 1")).to.not.throw();
        expect(reloaded.phase).eq("redraw");
        expect(reloaded.bidWinner).eq(1); // King beats both 2 and 3 of Swords
    });

    it("the non-bidding game is entirely unaffected: phase stays main, place is legal from turn one", () => {
        const g = new GnosticaGame(2);
        expect(g.phase).eq("main");
        expect(() => g.move("place l0")).to.not.throw();
    });
});

// Drives a fresh 3-player bidding game straight to "redraw": P1 bids the
// highest card (a King), P2 and P3 bid lower minors that don't tie it or
// each other, so the round resolves in one pass with P1 as winner and a
// 3-card pool (one per player).
const setupRedraw = (): GnosticaGame => {
    const g = new GnosticaGame(3, ["bidding"]);
    g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"];
    g.hands[1] = [minor("QS").uid, "AR", "2R", "3R", "4R", "5R"];
    g.hands[2] = [minor("PS").uid, "AD", "2D", "3D", "4D", "5D"];
    g.move("bid 1", { trusted: true });
    g.move("bid 1", { trusted: true });
    g.move("bid 1", { trusted: true });
    return g;
};

describe("Gnostica: bidding variant, stage 2 (redraw)", () => {
    it("enforces the exact draw count needed to reach 6", () => {
        const g = setupRedraw();
        expect(g.hands[g.currplayer - 1].length).eq(5); // needs exactly 1 back
        expect(() => g.move("redraw")).to.throw(); // too few (0)
        expect(() => g.move(`redraw ${g.biddingPool[0]} ${g.biddingPool[1]}`)).to.throw(); // too many (2)
    });

    it("rejects a uid that isn't in the bidding pool", () => {
        const g = setupRedraw();
        expect(() => g.move("redraw AC")).to.throw(); // AC is in a hand, not the pool
    });

    it("rejects naming the same uid twice in one redraw", () => {
        const g = setupRedraw();
        // Force the current redrawer to need 2 cards back, so a count of 2
        // naming the same uid twice exercises duplicate-detection
        // specifically, rather than just tripping the count check.
        g.hands[g.currplayer - 1] = g.hands[g.currplayer - 1].slice(0, 4);
        const uid = g.biddingPool[0];
        expect(() => g.move(`redraw ${uid} ${uid}`)).to.throw();
    });

    it("walks the full redraw order and hands off to main phase with the bid winner as currplayer", () => {
        const g = setupRedraw();
        expect(g.redrawOrder).to.deep.equal([3, 2, 1]); // winner is 1, so right-neighbour (3) first
        expect(g.currplayer).eq(3);
        const poolStart = [...g.biddingPool];

        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        expect(g.currplayer).eq(2);
        expect(g.phase).eq("redraw");

        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        expect(g.currplayer).eq(1);
        expect(g.phase).eq("redraw");

        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        expect(g.phase).eq("main");
        expect(g.currplayer).eq(1); // the bid winner
        expect(g.biddingPool).to.be.empty;
        for (const h of g.hands) {
            expect(h.length).eq(6);
        }
        // Every card that went into the pool came back out into someone's hand.
        const allHandUids = g.hands.flat();
        for (const uid of poolStart) {
            expect(allHandUids).to.include(uid);
        }
    });

    it("normal play resumes immediately once redraw completes", () => {
        const g = setupRedraw();
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        expect(g.phase).eq("main");
        expect(() => g.move("place l0")).to.not.throw();
    });

    it("turn order actually follows the bid winner, not just the first move after redraw", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [major(10).uid, "AR", "2R", "3R", "4R", "5R"]; // Wheel of Fortune - any major beats any minor
        g.hands[2] = [minor("QS").uid, "AD", "2D", "3D", "4D", "5D"];
        g.move("bid 1", { trusted: true }); // P1
        g.move("bid 1", { trusted: true }); // P2 - major arcana, wins outright over P1/P3's minors
        g.move("bid 1", { trusted: true }); // P3
        expect(g.bidWinner).eq(2);
        expect(g.redrawOrder).to.deep.equal([1, 3, 2]); // winner's right neighbour (1) first, winner (2) last

        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        expect(g.phase).eq("main");
        expect(g.currplayer).eq(2); // the actual bid winner starts, not player 1

        // Walk a full cycle of real turns to confirm rotation is genuinely
        // anchored to the winner (2 -> 3 -> 1 -> 2), not just the first
        // currplayer value after the handoff.
        g.move("place l1", { trusted: true });
        expect(g.currplayer).eq(3);
        g.move("place m1", { trusted: true });
        expect(g.currplayer).eq(1);
        g.move("place n1", { trusted: true });
        expect(g.currplayer).eq(2);
    });

    it("2-player only: if the winner is player 2, player 1 auto-passes an empty first turn instead of currplayer being reassigned directly", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = [minor("QS").uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [minor("KS").uid, "AR", "2R", "3R", "4R", "5R"]; // P2 wins with the King
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        expect(g.bidWinner).eq(2);
        expect(g.redrawOrder).to.deep.equal([1, 2]); // winner's right neighbour (1) first, winner (2) last

        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true }); // P1 redraws
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true }); // P2 redraws - completes redraw
        expect(g.phase).eq("main");
        expect(g.currplayer).eq(2); // effectively player 2 goes first...
        expect(g.results.some(r => r.type === "pass" && r.who === 1)).to.be.true; // ...via a real auto-pass, not a direct reassignment
        expect(g.hands[0].length).eq(6); // untouched - nothing to discard or draw at a full hand
    });

    it("2-player only: if the winner is player 1, no autopass happens - currplayer just starts at its ordinary default", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"]; // P1 wins with the King
        g.hands[1] = [minor("QS").uid, "AR", "2R", "3R", "4R", "5R"];
        g.move("bid 1", { trusted: true });
        g.move("bid 1", { trusted: true });
        expect(g.bidWinner).eq(1);
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true });
        expect(g.phase).eq("main");
        expect(g.currplayer).eq(1);
        expect(g.results.some(r => r.type === "pass")).to.be.false;
    });

    it("survives a real serialize/deserialize round-trip mid-redraw", () => {
        const g = setupRedraw();
        g.move(`redraw ${g.biddingPool[0]}`, { trusted: true }); // player 3's turn done
        const reloaded = new GnosticaGame(g.serialize());
        expect(reloaded.phase).eq("redraw");
        expect(reloaded.currplayer).eq(2);
        expect(reloaded.redrawOrder).to.deep.equal([3, 2, 1]);
        expect(() => reloaded.move(`redraw ${reloaded.biddingPool[0]}`)).to.not.throw();
        expect(() => reloaded.move(`redraw ${reloaded.biddingPool[0]}`)).to.not.throw();
        expect(reloaded.phase).eq("main");
        expect(reloaded.currplayer).eq(1);
    });
});

describe("Gnostica: bidding variant, stage 3 (click support)", () => {
    it("the bare 'Bid' button seeds an incomplete move with the right prompt", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        const result = g.handleClick("", -1, -1, "_btn_bid");
        expect(result.move).eq("bid");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
    });

    it("clicking a hand card during bidding builds bid <n> from its 1-based hand position", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = ["AC", "2C", minor("KS").uid, "3C", "4C", "5C"];
        const result = g.handleClick("", -1, -1, `hand_${minor("KS").uid}`);
        expect(result.move).eq("bid 3");
        expect(result.valid).to.be.true;
    });

    it("clicking a different hand card replaces the earlier pick rather than accumulating", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = ["AC", "2C", "3C", "4C", "5C", "6C"];
        const first = g.handleClick("", -1, -1, "hand_AC");
        expect(first.move).eq("bid 1");
        const second = g.handleClick(first.move, -1, -1, "hand_6C");
        expect(second.move).eq("bid 6"); // replaced, not "bid 1 6"
    });

    it("clicking a card not in your hand during bidding is rejected", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = ["AC", "2C", "3C", "4C", "5C", "6C"];
        const result = g.handleClick("", -1, -1, "hand_KS");
        expect(result.valid).to.be.false;
    });

    it("the bare 'Redraw' button seeds an incomplete move with the right prompt", () => {
        const g = setupRedraw();
        const result = g.handleClick("", -1, -1, "_btn_redraw");
        expect(result.move).eq("redraw");
        expect(result.valid).to.be.true;
        expect(result.complete).eq(-1);
    });

    it("clicking pool cards during redraw toggles a uid list, building redraw <uid...>", () => {
        const g = setupRedraw();
        const [uidA, uidB] = g.biddingPool;
        const click1 = g.handleClick("", -1, -1, `pool_${uidA}`);
        expect(click1.move).eq(`redraw ${uidA}`);
        const click2 = g.handleClick(click1.move, -1, -1, `pool_${uidA}`); // toggle back off
        expect(click2.move).eq("redraw");
        const click3 = g.handleClick("", -1, -1, `pool_${uidB}`);
        expect(click3.move).eq(`redraw ${uidB}`);
    });

    it("clicking a uid not currently in the pool during redraw is rejected", () => {
        const g = setupRedraw();
        const result = g.handleClick("", -1, -1, "pool_AC"); // AC is in a hand, not the pool
        expect(result.valid).to.be.false;
    });

    it("a full click-driven walk from bid through redraw to a real first move", () => {
        const g = new GnosticaGame(3, ["bidding"]);
        g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [minor("QS").uid, "AR", "2R", "3R", "4R", "5R"];
        g.hands[2] = [minor("PS").uid, "AD", "2D", "3D", "4D", "5D"];

        // Bidding: each player clicks their own high card in turn.
        const bid1 = g.handleClick("", -1, -1, `hand_${minor("KS").uid}`);
        g.move(bid1.move, { trusted: true });
        const bid2 = g.handleClick("", -1, -1, `hand_${minor("QS").uid}`);
        g.move(bid2.move, { trusted: true });
        const bid3 = g.handleClick("", -1, -1, `hand_${minor("PS").uid}`);
        g.move(bid3.move, { trusted: true });
        expect(g.phase).eq("redraw");
        expect(g.bidWinner).eq(1);

        // Redraw: each player in redrawOrder clicks their one needed pool card.
        for (let i = 0; i < 3; i++) {
            const click = g.handleClick("", -1, -1, `pool_${g.biddingPool[0]}`);
            g.move(click.move, { trusted: true });
        }
        expect(g.phase).eq("main");
        expect(g.currplayer).eq(1);

        // Normal play resumes, driven by an ordinary click just like any
        // other game - proves the whole variant hands off cleanly.
        expect(() => g.move("place l0")).to.not.throw();
    });

    it("render() offers a single bold 'Bid'/'Redraw' button per phase, and the pool area only appears once populated", () => {
        addResource("en");
        const bidding = new GnosticaGame(2, ["bidding"]);
        const biddingRep = bidding.render();
        const biddingBar = biddingRep.areas?.find((a): a is AreaButtonBar => a.type === "buttonBar");
        expect(biddingBar?.buttons).to.deep.equal([{ label: "Bid", value: "bid", attributes: [{ name: "font-weight", value: "bold" }] }]);
        expect(biddingRep.areas?.some(a => a.type === "pieces" && "label" in a && a.label === "Revealed bid cards, available to redraw")).to.be.false;

        const redraw = setupRedraw();
        const redrawRep = redraw.render();
        const redrawBar = redrawRep.areas?.find((a): a is AreaButtonBar => a.type === "buttonBar");
        expect(redrawBar?.buttons).to.deep.equal([{ label: "Redraw", value: "redraw", attributes: [{ name: "font-weight", value: "bold" }] }]);
        const poolArea = redrawRep.areas?.find(a => a.type === "pieces" && "label" in a && a.label === "Revealed bid cards, available to redraw");
        expect(poolArea).to.not.be.undefined;
    });

    // Regression: a live-preview call (move(m, {partial: true}), exactly
    // what the playground/front end uses to render a hover/click preview
    // on a disposable reconstructed instance - see move()'s own docs on
    // `partial`) must never actually commit the bid/redraw for real. Found
    // by testing in an actual browser, not by any of the tests above -
    // none of them ever exercised `partial: true` at all, which is
    // exactly how this slipped through: cmdBid/cmdRedraw didn't check the
    // flag, so clicking a card to preview it silently resolved the whole
    // round/redraw turn a move ahead of schedule.
    it("a bid preview (partial: true) must not resolve the round for real", () => {
        const g = new GnosticaGame(2, ["bidding"]);
        g.hands[0] = [minor("KS").uid, "AC", "2C", "3C", "4C", "5C"];
        g.hands[1] = [minor("QS").uid, "AR", "2R", "3R", "4R", "5R"];
        g.move("bid 1", { trusted: true }); // player 1's real bid
        g.move("bid 1", { partial: true }); // player 2's own preview click
        expect(g.phase).eq("bidding"); // must NOT have jumped to "redraw"
        expect(g.currplayer).eq(2); // must NOT have advanced
        expect(g.bidPositions).to.deep.equal([1, null]); // player 2's slot must still be open
        expect(g.biddingPool).to.be.empty;
        expect(g.hands[1]).to.deep.equal([minor("QS").uid, "AR", "2R", "3R", "4R", "5R"]); // untouched
    });

    it("a redraw preview (partial: true) may show the pending pick, but must not advance redrawPos/currplayer/phase", () => {
        const g = setupRedraw();
        const uid = g.biddingPool[0];
        const handBefore = [...g.hands[g.currplayer - 1]];
        g.move(`redraw ${uid}`, { partial: true });
        expect(g.phase).eq("redraw"); // must NOT have advanced to "main"
        expect(g.currplayer).eq(3); // must NOT have moved to the next redrawer
        expect(g.redrawPos).eq(0);
        // The visible pool->hand mutation IS allowed during partial
        // (mirrors cmdDiscard's own precedent), unlike bid's own
        // "nothing to safely preview" case.
        expect(g.hands[2]).to.deep.equal([...handBefore, uid]);
        expect(g.biddingPool).to.not.include(uid);

        // Confirm the REAL (non-partial) submit, from a fresh instance
        // built off the true persisted state, is unaffected by the
        // preview and works correctly.
        const fresh = new GnosticaGame(g.serialize());
        expect(fresh.phase).eq("redraw");
        expect(fresh.currplayer).eq(3);
        expect(fresh.biddingPool).to.include(uid); // the preview never actually persisted
    });
});
