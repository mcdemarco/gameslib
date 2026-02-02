import { shuffle } from "../shuffle";
import { Card, cardsBasic, cardsExtended } from "./Card";
import { Multicard } from "./Multicard";

export class Multideck {
    private _cards: Multicard[];
    private _decks: number;

    constructor(cards: Card[], decks: number) {
        if (decks < 1 || decks > 9) {
            throw new Error("Only one to nine decktet decks are supported.");
        }
        this._cards = [];
        for (let d=1; d <= decks; d++) {
            cards.forEach(c => {
                this._cards.push(new Multicard(new Card(c), d));
            });
        }
        this._decks = decks;
    }

    public get cards(): Multicard[] {
        return this._cards.map(m => new Multicard(new Card(m), m.deck));
    }

    public get size(): number {
        return this._cards.length;
    }

    public shuffle(): Multideck {
        this._cards = shuffle(this._cards) as Multicard[];
        return this;
    }

    public add(muid: string): Multideck {
        const found = Multicard.deserialize(muid);
        if (found === undefined) {
            throw new Error(`Could not find a Decktet card with the uid "${muid}"`);
        }
        this._cards.push(found);
        this.shuffle();
        return this;
    }
    
    public addAll(uid: string): Multideck {
        const found = [...cardsBasic, ...cardsExtended].find(c => c.uid === uid);
        if (found === undefined) {
            throw new Error(`Could not find a Decktet card with the uid "${uid}"`);
        }
        for (let d=1; d <= this._decks; d++) {
            this._cards.push(new Multicard(found, d));
        }
        this.shuffle();
        return this;
    }

    public addOne(uid: string, deck: number): Multideck {
        const found = [...cardsBasic, ...cardsExtended].find(c => c.uid === uid);
        if (found === undefined) {
            throw new Error(`Could not find a Decktet card with the uid "${uid}"`);
        }
        this._cards.push(new Multicard(found, deck));
        this.shuffle();
        return this;
    }
    
    public remove(muid: string): Multideck {
        
        const idx = this._cards.findIndex(m => m.muid === muid);
        if (idx < 0) {
            throw new Error(`Could not find a card in the deck with the uid "${muid}"`);
        }
        this._cards.splice(idx, 1);
        return this;
    }

    public removeAll(uid: string): Multideck {
        let idx = this._cards.findIndex(c => c.uid === uid);
        while (idx > -1) {
            this._cards.splice(idx, 1);
            idx = this._cards.findIndex(c => c.uid === uid);
        }
        return this;
    }

    public removeOne(uid: string, deck: number): Multideck {
        const idx = this._cards.findIndex(c => c.uid === uid);
        if (idx < 0) {
            throw new Error(`Could not find a card in the deck with the uid "${uid}"`);
        }
        this._cards.splice(idx, 1);
        return this;
    }

    public draw(count = 1): Multicard[] {
        const drawn: Multicard[] = [];
        const limit = Math.min(count, this._cards.length);
        for (let i = 0; i < limit; i++) {
            drawn.push(this._cards.shift()!)
        }
        return drawn;
    }

    public empty(): Multideck {
        this._cards = [];
        return this;
    }

    public clone(): Multideck {
        const cloned = new Multideck([], this._decks);
        cloned._cards = this._cards.map(m => new Multicard(new Card(m), m.deck));
        return cloned;
    }

    public static deserialize(deck: Multideck): Multideck {
        const des = new Multideck([], deck._decks);
        des._cards = deck._cards.map(m => new Multicard(new Card(m), m.deck));
        return des;
    }

}
