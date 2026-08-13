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
