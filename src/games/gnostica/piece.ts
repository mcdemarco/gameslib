export type Pips = 1 | 2 | 3;
export type Orientation = "N" | "E" | "S" | "W" | "U";

export const cardinalOrientations: Orientation[] = ["N", "E", "S", "W"];
export const allOrientations: Orientation[] = ["N", "E", "S", "W", "U"];

// One Icehouse-style pyramid "minion": owner, size, and facing ("U" = targets only its own space).
export class Piece {
    public owner: number;
    public size: Pips;
    public orientation: Orientation;

    constructor(owner: number, size: Pips, orientation: Orientation = "U") {
        this.owner = owner;
        this.size = size;
        this.orientation = orientation;
    }

    // Local (not globally unique) identity - also doubles as its compact serialized form.
    public id(): string {
        return `${this.owner}${this.size}${this.orientation}`;
    }

    public clone(): Piece {
        return new Piece(this.owner, this.size, this.orientation);
    }

    // JSON.stringify calls this automatically; in memory it stays a real object.
    public toJSON(): string {
        return this.id();
    }

    public static deserialize(s: string): Piece {
        const [owner, size, orientation] = s.split("");
        return new Piece(Number(owner), Number(size) as Pips, orientation as Orientation);
    }
}
