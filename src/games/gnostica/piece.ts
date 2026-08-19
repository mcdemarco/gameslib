export type Pips = 1 | 2 | 3;
export type Orientation = "N" | "E" | "S" | "W" | "U";

export const cardinalOrientations: Orientation[] = ["N", "E", "S", "W"];
export const allOrientations: Orientation[] = ["N", "E", "S", "W", "U"];

export interface IPiece {
    owner: number;
    size: Pips;
    orientation: Orientation;
}

// One Icehouse-style pyramid "minion" on the board: who it belongs to, its
// size (1/2/3 pips), and which way it's pointing (N/E/S/W, or "U" meaning it
// targets only its own space).
export class Piece implements IPiece {
    public owner: number;
    public size: Pips;
    public orientation: Orientation;

    constructor(owner: number, size: Pips, orientation: Orientation = "U") {
        this.owner = owner;
        this.size = size;
        this.orientation = orientation;
    }

    // A local identity (owner+size+facing), not a global serial. Two pieces
    // in the same territory can share an id; disambiguating duplicates by
    // array position is the caller's job (mirrors the rarity of the case).
    public id(): string {
        return `${this.owner}${this.size}${this.orientation}`;
    }

    public clone(): Piece {
        return new Piece(this.owner, this.size, this.orientation);
    }

    public static deserialize(piece: IPiece): Piece {
        return new Piece(piece.owner, piece.size, piece.orientation);
    }
}
