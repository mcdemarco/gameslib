import { UnboundedSquareBoard } from "../../common/unbounded-square-board";
import { DirectionCardinal, orthDirections } from "../../common";
import { TarotCard } from "../../common/tarot";
import { CellContents, ICellContents } from "./cell";
import { Piece } from "./piece";

export type CellClass = "territory" | "wasteland" | "void";

export interface IEvicted {
    x: number;
    y: number;
    pieces: Piece[];
}

// Internal absolute coordinates: y increases downward, matching UnboundedSquareBoard's own convention.
const DELTAS: Record<DirectionCardinal, [number, number]> = {
    N: [0, -1],
    S: [0, 1],
    E: [1, 0],
    W: [-1, 0],
};

const colLabels = "abcdefghijklmnopqrstuvwxyz".split("");
const revColLabels = [...colLabels].reverse();

// Wraps UnboundedSquareBoard<CellContents> with territory/wasteland/void classification and create/destroy/grow/shrink/push mutations.
export class GnosticaBoard {
    private cells: UnboundedSquareBoard<CellContents>;

    constructor(cells?: UnboundedSquareBoard<CellContents>) {
        this.cells = cells ?? new UnboundedSquareBoard<CellContents>();
    }

    // What actually gets stored in IMoveState - never a GnosticaBoard instance (see rehydrate()).
    public get store(): UnboundedSquareBoard<CellContents> {
        return this.cells;
    }

    public get(x: number, y: number): CellContents | undefined {
        return this.cells.get(x, y);
    }

    public has(x: number, y: number): boolean {
        return this.cells.has(x, y);
    }

    public get size(): number {
        return this.cells.size;
    }

    public get minX(): number { return this.cells.minX; }
    public get maxX(): number { return this.cells.maxX; }
    public get minY(): number { return this.cells.minY; }
    public get maxY(): number { return this.cells.maxY; }

    public *entries(): IterableIterator<[number, number, CellContents]> {
        yield* this.cells;
    }

    public neighbors(x: number, y: number): [number, number][] {
        return orthDirections.map(d => {
            const [dx, dy] = DELTAS[d];
            return [x + dx, y + dy] as [number, number];
        });
    }

    public delta(dir: DirectionCardinal): [number, number] {
        return DELTAS[dir];
    }

    // Derived from live board contents every time, never stored; adjacency does NOT chain through neighbouring wastelands.
    public classify(x: number, y: number): CellClass {
        const here = this.cells.get(x, y);
        if (here !== undefined && here.card !== undefined) {
            return "territory";
        }
        for (const [nx, ny] of this.neighbors(x, y)) {
            const n = this.cells.get(nx, ny);
            if (n !== undefined && n.card !== undefined) {
                return "wasteland";
            }
        }
        return "void";
    }

    // Deletes {x,y}'s stored CellContents once empty - a lingering wasteland cell would never reclassify to void and inflate the bounding box forever.
    public pruneIfEmpty(x: number, y: number): void {
        const t = this.cells.get(x, y);
        if (t !== undefined && t.card === undefined && t.pieces.length === 0) {
            this.cells.delete(x, y);
        }
    }

    // Only {x,y} and its four neighbours can possibly change classification, since classify() only looks one step away.
    private evictVoidPieces(x: number, y: number): IEvicted[] {
        const evicted: IEvicted[] = [];
        for (const [cx, cy] of [[x, y] as [number, number], ...this.neighbors(x, y)]) {
            if (this.classify(cx, cy) === "void") {
                const t = this.cells.get(cx, cy);
                if (t !== undefined && t.pieces.length > 0) {
                    evicted.push({ x: cx, y: cy, pieces: [...t.pieces] });
                    t.pieces = [];
                }
                this.pruneIfEmpty(cx, cy);
            }
        }
        return evicted;
    }

    // Only legal on a wasteland. Never strands anyone - adding a card only ever promotes void neighbours.
    public createTerritory(x: number, y: number, card: TarotCard): void {
        if (this.classify(x, y) !== "wasteland") {
            throw new Error(`Cannot create a territory at (${x},${y}): not a wasteland.`);
        }
        const existing = this.cells.get(x, y);
        if (existing !== undefined) {
            existing.card = card;
        } else {
            this.cells.set(x, y, new CellContents(card));
        }
    }

    // Removes the card; returns every cell that consequently collapsed into the void, with its evicted pieces (crediting the stash is powers.ts's job).
    public destroyTerritory(x: number, y: number): IEvicted[] {
        const t = this.cells.get(x, y);
        if (t === undefined || t.card === undefined) {
            throw new Error(`No territory to destroy at (${x},${y}).`);
        }
        t.card = undefined;
        if (t.pieces.length === 0) {
            this.cells.delete(x, y);
        }
        return this.evictVoidPieces(x, y);
    }

    // In-place value change; the cell still has a card throughout, so this never changes classification.
    public growTerritory(x: number, y: number, newCard: TarotCard): void {
        const t = this.cells.get(x, y);
        if (t === undefined || t.card === undefined) {
            throw new Error(`No territory to grow at (${x},${y}).`);
        }
        t.card = newCard;
    }

    // Same in-place swap as growTerritory; shrinking all the way to nothing is destroyTerritory, not this method.
    public shrinkTerritory(x: number, y: number, newCard: TarotCard): void {
        this.growTerritory(x, y, newCard);
    }

    // Moves only the CARD; pieces stay put. Destination is always wasteland, possibly already holding pieces of its own.
    public pushTerritory(fromX: number, fromY: number, toX: number, toY: number): IEvicted[] {
        const src = this.cells.get(fromX, fromY);
        if (src === undefined || src.card === undefined) {
            throw new Error(`No territory to push at (${fromX},${fromY}).`);
        }
        const card = src.card;

        // Card must land FIRST - evicting before it arrives would wrongly treat the in-between state as void.
        let dest = this.cells.get(toX, toY);
        if (dest === undefined) {
            dest = new CellContents(card);
            this.cells.set(toX, toY, dest);
        } else {
            dest.card = card;
        }

        src.card = undefined;
        if (src.pieces.length === 0) {
            this.cells.delete(fromX, fromY);
        }
        return this.evictVoidPieces(fromX, fromY);
    }

    public clone(): GnosticaBoard {
        const cloned = new UnboundedSquareBoard<CellContents>();
        for (const [x, y, t] of this.cells) {
            cloned.set(x, y, t.clone());
        }
        return new GnosticaBoard(cloned);
    }

    // Rehydration after JSON.parse: GnosticaBoard itself is never serialized, only the raw UnboundedSquareBoard, so cell contents need their own fix-up pass.
    public static rehydrate(raw: UnboundedSquareBoard<ICellContents>): UnboundedSquareBoard<CellContents> {
        const wrapped = UnboundedSquareBoard.from(raw);
        const fixed = new UnboundedSquareBoard<CellContents>();
        for (const [x, y, t] of wrapped) {
            fixed.set(x, y, CellContents.deserialize(t));
        }
        return fixed;
    }

    // Algebraic notation (mirrors knightline.ts): stable even as the board's bounding box drifts; origin (0,0) is "m0".
    private static absXCoord2algebraic(x: number): string {
        let xval: string;
        if (x > 12) {
            x = x - 13;
            xval = colLabels[Math.floor(x / 26)] + colLabels[x % 26];
        } else if (x < -12) {
            x = Math.abs(x) - 13;
            xval = revColLabels[Math.floor(x / 26)] + revColLabels[x % 26];
        } else {
            xval = colLabels[x + 12];
        }
        return xval;
    }

    public static coords2algebraic(x: number, y: number): string {
        const xval = GnosticaBoard.absXCoord2algebraic(x);
        const yval = y === 0 ? 0 : -y;
        return xval + yval.toString();
    }

    public static algebraic2coords(cell: string): [number, number] {
        const temp = cell.match(/[a-z]+|-?[0-9]+/g);
        if (!temp || !temp[0] || temp[0].length > 2 || (temp[1] === undefined)) {
            throw new Error(`Invalid Gnostica cell notation: "${cell}"`);
        }
        const y = parseInt(temp[1], 10);
        let x: number;
        if (temp[0].length === 1) {
            x = colLabels.indexOf(temp[0]) - 12;
        } else {
            const let1 = temp[0][0];
            const let2 = temp[0][1];
            let let1val = colLabels.indexOf(let1);
            if (let1val < 13) {
                const let2val = colLabels.indexOf(let2);
                x = let1val * 26 + let2val + 13;
            } else {
                let1val = revColLabels.indexOf(let1);
                const let2val = revColLabels.indexOf(let2);
                x = -(let1val * 26 + let2val + 13);
            }
        }
        const yval = y === 0 ? 0 : -y;
        return [x, yval];
    }
}
