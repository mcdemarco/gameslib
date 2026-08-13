import { TarotCard, MinorCard, MajorCard } from "../../common/tarot";
import { Piece, IPiece } from "./Piece";

export type TerritoryPointValue = 0 | 1 | 2 | 3;

// Standalone so powers.ts can evaluate a candidate replacement card (from
// hand or discard) before it's ever placed on the board, not just a card
// already sitting in a Territory.
export const cardPointValue = (card?: TarotCard): TerritoryPointValue => {
    if (card === undefined) {
        return 0;
    }
    if (card.major) {
        return 3;
    }
    return (card as MinorCard).rank.court ? 2 : 1;
};

export interface ITerritory {
    card?: TarotCard;
    pieces: IPiece[];
}

// A single board cell that currently has a card and/or pieces on it. A
// "wasteland" (adjacent-to-a-territory empty space) with no pieces on it is
// never actually stored on the board - see GnosticaBoard.classify() - so
// every Territory instance has a card, at least one piece, or both.
export class Territory implements ITerritory {
    public card?: TarotCard;
    public pieces: Piece[];

    constructor(card?: TarotCard, pieces: Piece[] = []) {
        this.card = card;
        this.pieces = pieces;
    }

    public canAdd(ignoreCapacity = false): boolean {
        return ignoreCapacity || this.pieces.length < 3;
    }

    public add(piece: Piece, ignoreCapacity = false): Territory {
        if (!this.canAdd(ignoreCapacity)) {
            throw new Error("Territory already holds 3 pieces.");
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

    public ownersPresent(): Set<number> {
        return new Set(this.pieces.map(p => p.owner));
    }

    // Scoring rule: a territory counts for `player` only if it holds at
    // least one of their pieces and nobody else's.
    public isUncontestedBy(player: number): boolean {
        const owners = this.ownersPresent();
        return owners.size === 1 && owners.has(player);
    }

    public pointValue(): TerritoryPointValue {
        return cardPointValue(this.card);
    }

    public clone(): Territory {
        const card = this.card === undefined ? undefined
            : this.card.major ? (this.card as MajorCard).clone() : (this.card as MinorCard).clone();
        return new Territory(card, this.pieces.map(p => p.clone()));
    }

    public static deserialize(t: ITerritory): Territory {
        let card: TarotCard | undefined;
        if (t.card !== undefined) {
            card = t.card.major ? MajorCard.deserialize(t.card as MajorCard) : MinorCard.deserialize(t.card as MinorCard);
        }
        return new Territory(card, (t.pieces ?? []).map(p => Piece.deserialize(p)));
    }
}
