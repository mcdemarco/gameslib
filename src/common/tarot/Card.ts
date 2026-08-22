import { Component, ranks, suits, majorRanks, majorArcanaSuit } from "./Component";
import { Glyph } from "@abstractplay/renderer/build/schemas/schema";

// `compact` requests a smaller-footprint composition (e.g. a board tile
// that also has to leave room for up to 3 pieces) rather than the default,
// roomier sizing appropriate for a card shown alone (e.g. in a hand).
export interface ITarotGlyphOpts {
    compact?: boolean;
}

export type CardParams = {
    name: string;
    rank: Component;
    suit: Component;
    major: boolean;
};

// One class for every tarot card, major or minor - `rank`/`suit`/`major`
// are always populated (majors get majorArcanaSuit/a majorRanks entry
// rather than leaving suit/rank undefined), so no cast or narrowing is
// ever needed to read a card's identity, mirroring the sibling Decktet
// module's own single-class Card.
export class Card {
    private readonly _name: string;
    private readonly _rank: Component;
    private readonly _suit: Component;
    private readonly _major: boolean;

    constructor(params: CardParams) {
        this._name = params.name;
        this._rank = params.rank;
        this._suit = params.suit;
        this._major = params.major;
    }

    public get name(): string {
        return this._name;
    }
    public get rank(): Component {
        return new Component(this._rank);
    }
    public get suit(): Component {
        return new Component(this._suit);
    }
    public get major(): boolean {
        return this._major;
    }
    // Minor pip cards, Ace through 10. Derived from the rank's own
    // `court` flag, not an independently-settable field, so it can never
    // drift out of sync with it.
    public get spot(): boolean {
        return !this._major && !this._rank.court;
    }
    // Minor court cards, Page through King.
    public get court(): boolean {
        return !this._major && this._rank.court;
    }

    // One formula for every card - majorArcanaSuit's own uid is "", so
    // concatenation is a no-op for majors, collapsing this to exactly
    // `rank.uid` (the existing "00".."21" scheme). No branching needed.
    public get uid(): string {
        return this.rank.uid + this.suit.uid;
    }

    // Traditional additive Roman numeral (no subtractive forms, e.g. 4 is
    // "IIII" not "IV"), matching Rider-Waite-Smith numbering: the Fool is 0
    // (Roman numerals have no zero, so it displays as the digit "0").
    // Only meaningful for major arcana, but well-defined (if unused) for
    // any card, since every card has a `rank.seq`.
    public get romanNumeral(): string {
        const seq = this.rank.seq;
        if (seq === 0) {
            return "0";
        }
        const table: [number, string][] = [[10, "X"], [5, "V"], [1, "I"]];
        let remaining = seq;
        let numeral = "";
        for (const [value, symbol] of table) {
            while (remaining >= value) {
                numeral += symbol;
                remaining -= value;
            }
        }
        return numeral;
    }
    // (Roman numerals have no zero, so it displays as the digit "0").
    public get romanNumeralPadded(): string {
        const seq = this.rank.seq;
        let numeral = "";
        let paddingLength = 0;

        if (seq === 0) {
            numeral = "0";
            paddingLength = 1;
        } else {
            const table: [number, string, number][] = [[10, "X", 1], [5, "V", 1], [1, "I", 0.33]];
            let remaining = seq;
            for (const [value, symbol, length] of table) {
                while (remaining >= value) {
                    numeral += symbol;
                    remaining -= value;
                    paddingLength += length;
                }
            }
        }

        while (paddingLength < 6) {
            numeral += " ";
            paddingLength += 1;
        }
        return numeral;
    }

    // No bespoke per-card art asset exists yet for major arcana; render a
    // generic card face with the card's traditional numeral. Game-specific
    // overlays (e.g. Gnostica's 1-3 power icons) are composed on top by
    // the consuming game, not here - this module only knows genuine
    // tarot-deck facts. In `compact` mode the numeral is nudged to the top
    // edge, leaving the rest of the face free for whatever the caller
    // layers on top of it. Minor cards show their suit glyph and rank
    // text instead. Ranks have no dedicated glyph asset; they display as
    // plain text (their uid: A, 2-10, P, N, Q, K).
    public toGlyph(opts: ITarotGlyphOpts = {}): [Glyph, ...Glyph[]] {
        if (this.major) {
            return [
                { name: "piece-square", scale: 1 },
                {
                    text: this.romanNumeral,
                    scale: opts.compact ? 0.32 : 0.6,
                    colour: "_context_strokes",
                    nudge: opts.compact ? { dx: 0, dy: -380 } : undefined,
                },
            ];
        }
        const scale = opts.compact ? 0.32 : 0.5;
        const corner = opts.compact ? 310 : 250;
        const glyph: [Glyph, ...Glyph[]] = [
            { name: "piece-square", scale: 1 },
        ];
        if (this.suit.glyph !== undefined) {
            glyph.push({
                name: this.suit.glyph,
                scale,
                nudge: { dx: -corner, dy: corner },
            });
        }
        glyph.push({
            text: this.rank.uid,
            scale,
            colour: "_context_strokes",
            nudge: { dx: corner, dy: -corner },
        });
        return glyph;
    }

    public clone(): Card {
        return new Card({ name: this.name, rank: this.rank, suit: this.suit, major: this.major });
    }

    public static deserialize(card: Card | string): Card | undefined {
        if (typeof card === "string") {
            return [...minorCards, ...majorCards].find(c => c.uid === card);
        }
        return new Card({
            name: card._name,
            major: card._major,
            rank: Component.deserialize(card._rank)!,
            suit: Component.deserialize(card._suit)!,
        });
    }
}

export type TarotCard = Card;

export const minorCards: Card[] = suits.flatMap(
    suit => ranks.map(rank => new Card({ name: `${rank.name} of ${suit.name}`, rank, suit, major: false }))
);

export const majorCards: Card[] = majorRanks.map(
    rank => new Card({ name: rank.name, rank, suit: majorArcanaSuit, major: true })
);

export const allCards = (): TarotCard[] => [...minorCards, ...majorCards];
