/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import { Deck, Card, minorCards, majorCards, allCards, ranks, suits } from "../../src/common/tarot";

describe("Tarot", () => {
    it("has 56 minor and 22 major arcana, 78 total", () => {
        expect(minorCards.length).eq(56);
        expect(majorCards.length).eq(22);
        expect(allCards().length).eq(78);
    });

    it("has 4 suits and 14 ranks", () => {
        expect(suits.length).eq(4);
        expect(ranks.length).eq(14);
    });

    it("flags exactly the four court ranks", () => {
        const court = ranks.filter(r => r.court);
        expect(court.map(r => r.name).sort()).to.deep.equal(["King", "Knight", "Page", "Queen"].sort());
        const pips = ranks.filter(r => !r.court);
        expect(pips.length).eq(10); // Ace..10
    });

    it("every card has a unique uid", () => {
        const uids = allCards().map(c => c.uid);
        expect(new Set(uids).size).eq(uids.length);
    });

    it("builds minor card identity correctly", () => {
        const card = minorCards.find(c => c.uid === "AC")!;
        expect(card).to.not.be.undefined;
        expect(card.major).eq(false);
        expect(card.name).eq("Ace of Cups");
        expect(card.rank.name).eq("Ace");
        expect(card.suit.name).eq("Cups");

        const king = minorCards.find(c => c.uid === "KS")!;
        expect(king.name).eq("King of Swords");
        expect(king.rank.court).eq(true);
    });

    it("builds major arcana identity correctly", () => {
        const fool = majorCards.find(c => c.rank.seq === 0)!;
        expect(fool.major).eq(true);
        expect(fool.name).eq("The Fool");
        expect(fool.uid).eq("00");

        const world = majorCards.find(c => c.rank.seq === 21)!;
        expect(world.name).eq("The World");
        expect(world.uid).eq("21");
    });

    it("produces a renderer glyph stack for both card kinds", () => {
        const minor = minorCards[0];
        const minorGlyph = minor.toGlyph();
        expect(minorGlyph.length).to.be.greaterThan(1);
        const rankText = minorGlyph.find(g => g.text === minor.rank.uid);
        expect(rankText).to.not.be.undefined;

        const major = majorCards[0];
        const majorGlyph = major.toGlyph();
        expect(majorGlyph.length).eq(2);
        expect(majorGlyph[1].text).eq(major.romanNumeral);
    });

    it("renders major arcana numbering as additive Roman numerals, matching Rider-Waite-Smith numbering", () => {
        const byNumeral = new Map(majorCards.map(c => [c.rank.seq, c.romanNumeral]));
        expect(byNumeral.get(0)).eq("0");     // The Fool
        expect(byNumeral.get(1)).eq("I");     // The Magician
        expect(byNumeral.get(4)).eq("IIII");  // The Emperor (additive, not "IV")
        expect(byNumeral.get(9)).eq("VIIII"); // The Hermit (additive, not "IX")
        expect(byNumeral.get(14)).eq("XIIII"); // Temperance
        expect(byNumeral.get(19)).eq("XVIIII"); // The Sun (additive, not "XIX")
        expect(byNumeral.get(21)).eq("XXI");  // The World
    });

    it("clones without aliasing", () => {
        const card = minorCards[0];
        const clone = card.clone();
        expect(clone.uid).eq(card.uid);
        expect(clone).to.not.equal(card);

        const major = majorCards[0];
        const majorClone = major.clone();
        expect(majorClone.uid).eq(major.uid);
        expect(majorClone).to.not.equal(major);
    });

    it("round-trips through deserialize by uid", () => {
        expect(Card.deserialize("AC")?.name).eq("Ace of Cups");
        expect(Card.deserialize("nope")).to.be.undefined;
        expect(Card.deserialize("00")?.name).eq("The Fool");
        expect(Card.deserialize("nope")).to.be.undefined;
    });

    it("round-trips a card instance through deserialize (post JSON.parse shape)", () => {
        const card = minorCards.find(c => c.uid === "10D")!;
        const revived = Card.deserialize(JSON.parse(JSON.stringify(card)));
        expect(revived?.uid).eq("10D");
        expect(revived?.name).eq("10 of Discs");
    });

    it("builds a full 78-card deck, shuffles, draws, adds, removes", () => {
        const deck = new Deck(Deck.full());
        expect(deck.size).eq(78);

        deck.shuffle();
        expect(deck.size).eq(78);

        const drawn = deck.draw(3);
        expect(drawn.length).eq(3);
        expect(deck.size).eq(75);

        deck.remove(deck.cards[0].uid);
        expect(deck.size).eq(74);

        deck.add("00");
        expect(deck.size).eq(75);

        expect(() => deck.remove("nope")).to.throw();
        expect(() => deck.add("nope")).to.throw();
    });

    it("doesn't blow up when the deck runs out", () => {
        const deck = new Deck(Deck.full());
        deck.draw(78);
        expect(deck.size).eq(0);
        const [card] = deck.draw(1);
        expect(card).to.be.undefined;
    });

    it("clones a deck independently of the source", () => {
        const deck = new Deck(Deck.full());
        const clone = deck.clone();
        clone.draw(5);
        expect(clone.size).eq(73);
        expect(deck.size).eq(78);
    });
});
