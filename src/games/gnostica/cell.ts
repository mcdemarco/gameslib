import { TarotCard, allCards } from "../../common/tarot";
import { Piece } from "./piece";

export type CellPointValue = 0 | 1 | 2 | 3;

// Standalone so powers.ts can evaluate a candidate card before it's placed, not just one already in a cell.
export const cardPointValue = (card?: TarotCard): CellPointValue => {
    if (card === undefined) {
        return 0;
    }
    if (card.major) {
        return 3;
    }
    return card.court ? 2 : 1;
};

// Bare array, no key names (repeated per cell/history entry): [cardUid or "", ...piece id() strings].
export type ICellContents = string[];

// A board cell's card and/or pieces - not named "Territory" since a cardless/pieces-only wasteland cell isn't one.
export class CellContents {
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

    // Caller is responsible for having identified which same-id piece it means, if more than one.
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

    // A territory counts for `player` only if it holds at least one of their pieces and nobody else's.
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

    // JSON.stringify calls this automatically; see the class's own docs for why the wire shape is a bare array.
    public toJSON(): ICellContents {
        return [this.cardUid ?? "", ...this.pieces.map(p => p.id())];
    }

    public static deserialize(raw: ICellContents): CellContents {
        const [cardUid, ...pieceStrs] = raw;
        const instance = new CellContents(undefined, pieceStrs.map(s => Piece.deserialize(s)));
        instance.cardUid = cardUid ? cardUid : undefined;
        return instance;
    }
}
