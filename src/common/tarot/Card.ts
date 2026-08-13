import { Component, ranks, suits } from "./Component";
import { Glyph } from "@abstractplay/renderer/build/schemas/schema";

// Shared shape for every tarot card. Deliberately holds only facts true of a
// real 78-card tarot deck (identity, major/minor split, suit/rank where
// applicable). Anything that depends on how a particular game interprets the
// cards (point values, powers, etc.) does NOT belong here.
// `compact` requests a smaller-footprint composition (e.g. a board tile
// that also has to leave room for up to 3 pieces) rather than the default,
// roomier sizing appropriate for a card shown alone (e.g. in a hand).
export interface ITarotGlyphOpts {
    compact?: boolean;
}

export interface ITarotCard {
    readonly name: string;
    readonly uid: string;
    readonly major: boolean;
    clone(): ITarotCard;
    toGlyph(opts?: ITarotGlyphOpts): [Glyph, ...Glyph[]];
}

export type MinorParams = {
    rank: Component;
    suit: Component;
};

export class MinorCard implements ITarotCard {
    private readonly _rank: Component;
    private readonly _suit: Component;

    constructor(params: MinorParams) {
        this._rank = params.rank;
        this._suit = params.suit;
    }

    public readonly major = false;

    public get rank(): Component {
        return new Component(this._rank);
    }
    public get suit(): Component {
        return new Component(this._suit);
    }
    public get name(): string {
        return `${this.rank.name} of ${this.suit.name}`;
    }
    public get uid(): string {
        return this.rank.uid + this.suit.uid;
    }

    public toGlyph(opts: ITarotGlyphOpts = {}): [Glyph, ...Glyph[]] {
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
        // Ranks have no dedicated glyph asset; render the uid (A, 2-10, P, N, Q, K) as text.
        glyph.push({
            text: this.rank.uid,
            scale,
            colour: "_context_strokes",
            nudge: { dx: corner, dy: -corner },
        });
        return glyph;
    }

    public clone(): MinorCard {
        return new MinorCard({ rank: this.rank, suit: this.suit });
    }

    public static deserialize(card: MinorCard|string): MinorCard|undefined {
        if (typeof card === "string") {
            return minorCards.find(c => c.uid === card);
        }
        return new MinorCard({ rank: Component.deserialize(card._rank)!, suit: Component.deserialize(card._suit)! });
    }
}

export type MajorParams = {
    seq: number;
    name: string;
};

export class MajorCard implements ITarotCard {
    private readonly _seq: number;
    private readonly _name: string;

    constructor(params: MajorParams) {
        this._seq = params.seq;
        this._name = params.name;
    }

    public readonly major = true;

    // Canonical tarot numbering, 0 (the Fool) through 21 (the World).
    public get seq(): number {
        return this._seq;
    }
    public get name(): string {
        return this._name;
    }
    public get uid(): string {
        return this.seq.toString().padStart(2, "0");
    }

    // Traditional additive Roman numeral (no subtractive forms, e.g. 4 is
    // "IIII" not "IV"), matching Rider-Waite-Smith numbering: the Fool is 0
    // (Roman numerals have no zero, so it displays as the digit "0").
    public get romanNumeral(): string {
        if (this.seq === 0) {
            return "0";
        }
        const table: [number, string][] = [[10, "X"], [5, "V"], [1, "I"]];
        let remaining = this.seq;
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
        let numeral = "";
        let paddingLength = 0;

        if (this.seq === 0) {
            numeral = "0";
            paddingLength = 1;
        } else {
            const table: [number, string, number][] = [[10, "X", 1], [5, "V", 1], [1, "I", 0.33]];
            let remaining = this.seq;
            for (const [value, symbol, length] of table) {
                while (remaining >= value) {
                    numeral += symbol;
                    remaining -= value;
                    paddingLength += length;
                }
            }
        }
        
        while (paddingLength < 6) {
            numeral += "\u00A0";
            paddingLength += 1;
        }
        return numeral;
    }

    // No bespoke per-card art asset exists yet; render a generic card face
    // with the card's traditional numeral. Game-specific overlays (e.g.
    // Gnostica's 1-3 power icons) are composed on top by the consuming game,
    // not here - this module only knows genuine tarot-deck facts. In
    // `compact` mode the numeral is nudged to the top edge, leaving the rest
    // of the face free for whatever the caller layers on top of it.
    public toGlyph(opts: ITarotGlyphOpts = {}): [Glyph, ...Glyph[]] {
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

    public clone(): MajorCard {
        return new MajorCard({ seq: this.seq, name: this.name });
    }

    public static deserialize(card: MajorCard|string): MajorCard|undefined {
        if (typeof card === "string") {
            return majorCards.find(c => c.uid === card);
        }
        return new MajorCard({ seq: card._seq, name: card._name });
    }
}

export type TarotCard = MinorCard | MajorCard;

export const minorCards: MinorCard[] = suits.flatMap(
    suit => ranks.map(rank => new MinorCard({ rank, suit }))
);

export const majorCards: MajorCard[] = [
    { seq: 0, name: "The Fool" },
    { seq: 1, name: "The Magician" },
    { seq: 2, name: "The High Priestess" },
    { seq: 3, name: "The Empress" },
    { seq: 4, name: "The Emperor" },
    { seq: 5, name: "The Hierophant" },
    { seq: 6, name: "The Lovers" },
    { seq: 7, name: "The Chariot" },
    { seq: 8, name: "Strength" },
    { seq: 9, name: "The Hermit" },
    { seq: 10, name: "Wheel of Fortune" },
    { seq: 11, name: "Justice" },
    { seq: 12, name: "The Hanged Man" },
    { seq: 13, name: "Death" },
    { seq: 14, name: "Temperance" },
    { seq: 15, name: "The Devil" },
    { seq: 16, name: "The Tower" },
    { seq: 17, name: "The Star" },
    { seq: 18, name: "The Moon" },
    { seq: 19, name: "The Sun" },
    { seq: 20, name: "Judgement" },
    { seq: 21, name: "The World" },
].map(params => new MajorCard(params));

export const allCards = (): TarotCard[] => [...minorCards, ...majorCards];
