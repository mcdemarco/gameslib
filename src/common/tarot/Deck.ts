import { shuffle } from "../shuffle";
import { Card, TarotCard, minorCards, majorCards } from "./Card";

export class Deck {
    private _cards: TarotCard[];

    constructor(cards: TarotCard[]) {
        this._cards = cards.map(c => new Card(c));
    }

    public get cards(): TarotCard[] {
        return this._cards.map(c => new Card(c));
    }

    public get size(): number {
        return this._cards.length;
    }

    public shuffle(): Deck {
        this._cards = shuffle(this._cards) as TarotCard[];
        return this;
    }

    public add(uid: string): Deck {
        const found = [...minorCards, ...majorCards].find(c => c.uid === uid);
        if (found === undefined) {
            throw new Error(`Could not find a tarot card with the uid "${uid}"`);
        }
        this._cards.push(new Card(found));
        this.shuffle();
        return this;
    }

    public remove(uid: string): Deck {
        const idx = this._cards.findIndex(c => c.uid === uid);
        if (idx < 0) {
            throw new Error(`Could not find a card in the deck with the uid "${uid}"`);
        }
        this._cards.splice(idx, 1);
        return this;
    }

    public draw(count = 1): TarotCard[] {
        const drawn: TarotCard[] = [];
        const limit = Math.min(count, this._cards.length);
        for (let i = 0; i < limit; i++) {
            drawn.push(this._cards.shift()!);
        }
        return drawn;
    }

    public empty(): Deck {
        this._cards = [];
        return this;
    }

    public clone(): Deck {
        return new Deck(this.cards);
    }

    public static full(): TarotCard[] {
        return [...minorCards, ...majorCards];
    }

    public static deserialize(deck: Deck): Deck {
        return new Deck(deck.cards);
    }
}
