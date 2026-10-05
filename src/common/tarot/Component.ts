export type ComponentParams = {
    uid: string;
    seq: number;
    name: string;
    glyph?: string;
    court?: boolean;
};

export class Component {
    private readonly _uid: string;
    private readonly _seq: number;
    private readonly _name: string;
    private readonly _glyph?: string;
    private readonly _court: boolean = false;

    constructor(params: ComponentParams) {
        this._uid = params.uid;
        this._seq = params.seq;
        this._name = params.name;
        this._glyph = params.glyph;
        if (params.court !== undefined) {
            this._court = params.court;
        }
    }

    public get uid(): string {
        return this._uid;
    }
    public get seq(): number {
        return this._seq;
    }
    public get name(): string {
        return this._name;
    }
    public get glyph(): string|undefined {
        return this._glyph;
    }
    // True for the four "court" ranks (Page/Knight/Queen/King). Always false for suits.
    // A genuine fact about a tarot deck's rank structure, not a game rule.
    public get court(): boolean {
        return this._court;
    }

    public clone(): Component {
        return new Component({uid: this.uid, seq: this.seq, name: this.name, glyph: this.glyph, court: this.court});
    }

    public static deserialize(comp: Component|string): Component|undefined {
        if (typeof comp === "string") {
            return [...suits, ...ranks].find(c => c.uid === comp);
        }
        return new Component({uid: comp._uid, seq: comp._seq, name: comp._name, glyph: comp._glyph, court: comp._court});
    }

    public toString(): string {
        return this.uid;
    }
}

export const suits: Component[] = [
    new Component({uid: "C", seq: 1, name: "Cups", glyph: "gnostica-cup"}),
    new Component({uid: "R", seq: 2, name: "Rods", glyph: "gnostica-wand"}),
    new Component({uid: "D", seq: 3, name: "Discs", glyph: "gnostica-star"}),
    new Component({uid: "S", seq: 4, name: "Swords", glyph: "gnostica-sword"}),
];

// Ranks have no renderer glyphs of their own; they display as plain text
// (their uid: A, 2-10, P, N, Q, K) nudged onto the card face by Card.toGlyph().
export const ranks: Component[] = [
    new Component({uid: "A", seq: 1, name: "Ace"}),
    new Component({uid: "2", seq: 2, name: "2"}),
    new Component({uid: "3", seq: 3, name: "3"}),
    new Component({uid: "4", seq: 4, name: "4"}),
    new Component({uid: "5", seq: 5, name: "5"}),
    new Component({uid: "6", seq: 6, name: "6"}),
    new Component({uid: "7", seq: 7, name: "7"}),
    new Component({uid: "8", seq: 8, name: "8"}),
    new Component({uid: "9", seq: 9, name: "9"}),
    new Component({uid: "10", seq: 10, name: "10"}),
    new Component({uid: "P", seq: 11, name: "Page", court: true}),
    new Component({uid: "N", seq: 12, name: "Knight", court: true}),
    new Component({uid: "Q", seq: 13, name: "Queen", court: true}),
    new Component({uid: "K", seq: 14, name: "King", court: true}),
];

// A pseudo-suit standing in for "this card has no real elemental suit" -
// major arcana cards use this so every Card, major or minor, has a
// genuine, always-populated `suit`, with no optional fields anywhere.
// Deliberately NOT part of the `suits` array above: minorCards is built
// by iterating `suits`, so mixing this in would silently generate 14
// bogus extra "minor" cards, and would also disrupt allCards()'s own
// array order, which hand-display sorting depends on directly. The empty
// uid is what lets Card.uid use one formula (`rank.uid + suit.uid`) for
// every card - concatenating "" is a no-op, so majors' uid collapses to
// exactly their rank's own uid.
export const majorArcanaSuit: Component = new Component({uid: "", seq: 0, name: "Major Arcana"});

// One rank per major arcana card (seq 0-21), analogous to `ranks` above
// for minors. uid is the exact 2-digit zero-padded scheme major card uids
// have always used ("00".."21") - load-bearing throughout gnostica.ts's
// move-string grammar, MAJOR_ARCANA's own lookup keys, and countless test
// literals, so this must not change. A major's rank uid ("10" for Wheel
// of Fortune) coincides with a minor rank's own uid ("10" for a Ten) -
// harmless, since majorArcanaSuit's own empty uid keeps the two cards'
// full uids distinct ("10" vs "10C").
export const majorRanks: Component[] = [
    {seq: 0, name: "The Fool"},
    {seq: 1, name: "The Magician"},
    {seq: 2, name: "The High Priestess"},
    {seq: 3, name: "The Empress"},
    {seq: 4, name: "The Emperor"},
    {seq: 5, name: "The Hierophant"},
    {seq: 6, name: "The Lovers"},
    {seq: 7, name: "The Chariot"},
    {seq: 8, name: "Strength"},
    {seq: 9, name: "The Hermit"},
    {seq: 10, name: "Wheel of Fortune"},
    {seq: 11, name: "Justice"},
    {seq: 12, name: "The Hanged Man"},
    {seq: 13, name: "Death"},
    {seq: 14, name: "Temperance"},
    {seq: 15, name: "The Devil"},
    {seq: 16, name: "The Tower"},
    {seq: 17, name: "The Star"},
    {seq: 18, name: "The Moon"},
    {seq: 19, name: "The Sun"},
    {seq: 20, name: "Judgement"},
    {seq: 21, name: "The World"},
].map(({seq, name}) => new Component({uid: seq.toString().padStart(2, "0"), seq, name}));
