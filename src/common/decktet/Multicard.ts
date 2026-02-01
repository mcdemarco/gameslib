import { Card, Params } from "./Card";

export class Multicard extends Card {
    private readonly _deck: number;

    constructor(params: Params, deck: number) {
        super(params);
        this._deck = deck;
    }

    public get uid(): string {
        return [super.uid, this._deck].join("");
    }

    public static deserialize(mcard: string): Multicard|undefined {
        const deck: number = parseInt(mcard.charAt(mcard.length - 1),10);
        const card: string = mcard.substring(0, mcard.length - 1);
        const cardObj: Card|undefined = Card.deserialize(card);
        if (cardObj)
            return new Multicard(cardObj, deck);
        else
            return undefined; 
    }
}
