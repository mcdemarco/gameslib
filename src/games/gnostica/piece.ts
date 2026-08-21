export type Pips = 1 | 2 | 3;
export type Orientation = "N" | "E" | "S" | "W" | "U";

export const cardinalOrientations: Orientation[] = ["N", "E", "S", "W"];
export const allOrientations: Orientation[] = ["N", "E", "S", "W", "U"];

// One Icehouse-style pyramid "minion" on the board: who it belongs to, its
// size (1/2/3 pips), and which way it's pointing (N/E/S/W, or "U" meaning it
// targets only its own space).
export class Piece {
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
    // Always exactly 3 characters, so it's also this piece's own compact
    // serialized form (see toJSON()/deserialize() below) - no delimiter
    // needed since every field is a single character.
    public id(): string {
        return `${this.owner}${this.size}${this.orientation}`;
    }

    public clone(): Piece {
        return new Piece(this.owner, this.size, this.orientation);
    }

    // JSON.stringify calls this automatically wherever a Piece appears -
    // in memory it stays a real object, only its serialized form is this
    // compact string (see CellContents.toJSON()'s own docs on why).
    public toJSON(): string {
        return this.id();
    }

    public static deserialize(s: string): Piece {
        const [owner, size, orientation] = s.split("");
        return new Piece(Number(owner), Number(size) as Pips, orientation as Orientation);
    }
}
