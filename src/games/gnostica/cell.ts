import { TarotCard, MinorCard, allCards } from "../../common/tarot";
import { Piece } from "./piece";

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

// The serialized shape: a bare array, no key names at all (repeated per
// cell, per historical stack entry, so they add up) - element 0 is the
// card's uid, or "" if there's no card; every element after that is one
// piece's own compact id() string (see Piece's own docs - always exactly
// 3 characters, so no delimiter is needed between them either).
export type ICellContents = string[];

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
// In memory this stays a real object (`cardUid` + a real Piece[] `pieces`,
// mutated in place via normal array methods everywhere) - only toJSON()'s
// own output (an ICellContents) is ever actually serialized. `card` stays
// available as a getter/setter for every existing call site's convenience
// (construct/read/write with a real TarotCard, exactly as before) - it
// just resolves against allCards() on the fly instead of storing the
// object itself. Safe because TarotCard instances are treated as immutable
// value objects throughout this file (uid identifies a card uniquely;
// nothing ever mutates one of its own sub-properties in place).
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

    // JSON.stringify calls this automatically wherever a CellContents
    // appears - see this class's own docs on why the wire shape is a bare
    // array rather than the object this class actually is in memory.
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
