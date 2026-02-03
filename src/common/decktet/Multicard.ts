import { Card, Params } from "./Card";

export class Multicard extends Card {
    private readonly _deck: number;

    constructor(params: Params, deck: number) {
        super(params);
        this._deck = deck;
    }

    public get deck(): number {
        return this._deck;
    }

    public get cuid(): string {
        return super.uid;
    }

    public get uid(): string {
        return [super.uid, this._deck].join("");
    }

    public static deserialize(mcard: string): Multicard|undefined {
        mcard = mcard.trim();
        if (mcard.length < 2)
            return undefined;

        const last = mcard.charAt(mcard.length - 1);
        if (!/\d/.test(last))
            return undefined;

        const deck = parseInt(last, 10);
        const cardStr = mcard.slice(0, -1);
        
        const cardObj = Card.deserialize(cardStr);
        if (!cardObj)
            return undefined;

        return new Multicard(cardObj, deck);
    }
}
