import { TarotCard, MinorCard, allCards } from "../../common/tarot";
import { Piece, IPiece } from "./piece";

export type CellPointValue = 0 | 1 | 2 | 3;

// Standalone so powers.ts can evaluate a candidate replacement card (from
// hand or discard) before it's ever placed on the board, not just a card
// already sitting in a cell's CellContents.
export const cardPointValue = (card?: TarotCard): CellPointValue => {
    if (card === undefined) {
        return 0;
    }
    if (card.major) {
        return 3;
    }
    return (card as MinorCard).rank.court ? 2 : 1;
};

// The stored/serialized shape only ever keeps the card's uid, not the full
// object (see CellContents's own docs on why) - hands/discardPile/drawPile
// already store plain uid strings the same way, translating to a real card
// via allCards().find(...) on demand.
export interface ICellContents {
    cardUid?: string;
    pieces: IPiece[];
}

// Whatever's currently at a single board cell - a card and/or pieces, or
// (as a fresh instance about to be stored) neither yet. A "wasteland"
// (adjacent-to-a-territory empty space) with no pieces on it is never
// actually stored on the board - see GnosticaBoard.classify() - so every
// stored CellContents instance has a card, at least one piece, or both.
// Deliberately NOT named "Territory": a cardless instance holding only
// pieces (a wasteland cell someone's minion is standing on) isn't a
// territory at all by this game's own rules - see GnosticaBoard.classify()'s
// three-way territory/wasteland/void split.
//
// Only `cardUid` is ever actually stored/serialized - a whole board's worth
// of full TarotCard objects (each with its own nested rank/suit Component
// sub-objects) repeated across every historical stack entry adds up fast.
// `card` stays available as a getter/setter for every existing call site's
// convenience (construct/read/write with a real TarotCard, exactly as
// before) - it just resolves against allCards() on the fly instead of
// storing the object itself. Safe because TarotCard instances are treated
// as immutable value objects throughout this file (uid identifies a card
// uniquely; nothing ever mutates one of its own sub-properties in place).
export class CellContents implements ICellContents {
    public cardUid?: string;
    public pieces: Piece[];

    constructor(card?: TarotCard, pieces: Piece[] = []) {
        this.cardUid = card?.uid;
        this.pieces = pieces;
    }

    public get card(): TarotCard | undefined {
        return this.cardUid === undefined ? undefined : allCards().find(c => c.uid === this.cardUid);
    }

    public set card(card: TarotCard | undefined) {
        this.cardUid = card?.uid;
    }

    public canAdd(ignoreCapacity = false): boolean {
        return ignoreCapacity || this.pieces.length < 3;
    }

    public add(piece: Piece, ignoreCapacity = false): CellContents {
        if (!this.canAdd(ignoreCapacity)) {
            throw new Error("This cell already holds 3 pieces.");
        }
        this.pieces.push(piece);
        return this;
    }

    // Removes and returns the piece at the given array index (the caller is
    // responsible for having identified *which* same-id piece it means, when
    // there's more than one candidate).
    public removeAt(idx: number): Piece {
        const found = this.pieces[idx];
        if (found === undefined) {
            throw new Error(`No piece at index ${idx}.`);
        }
        this.pieces.splice(idx, 1);
        return found;
    }

    public playersPresent(): Set<number> {
        return new Set(this.pieces.map(p => p.owner));
    }

    // Scoring rule: a territory counts for `player` only if it holds at
    // least one of their pieces and nobody else's.
    public isUncontestedBy(player: number): boolean {
        const players = this.playersPresent();
        return players.size === 1 && players.has(player);
    }

    public pointValue(): CellPointValue {
        return cardPointValue(this.card);
    }

    public clone(): CellContents {
        const cloned = new CellContents(undefined, this.pieces.map(p => p.clone()));
        cloned.cardUid = this.cardUid;
        return cloned;
    }

    public static deserialize(t: ICellContents): CellContents {
        const instance = new CellContents(undefined, (t.pieces ?? []).map(p => Piece.deserialize(p)));
        instance.cardUid = t.cardUid;
        return instance;
    }
}
