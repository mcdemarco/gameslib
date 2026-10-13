import { UnboundedSquareBoard } from "../../common/unbounded-square-board.js";
import { DirectionCardinal, orthDirections } from "../../common/index.js";
import { TarotCard } from "../../common/tarot/index.js";
import { CellContents, ICellContents } from "./cell.js";

export type CellClass = "territory" | "wasteland" | "void";

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

    public get(cell: string): CellContents | undefined {
        return this.cells.get(...GnosticaBoard.algebraic2coords(cell));
    }

    public has(cell: string): boolean {
        return this.cells.has(...GnosticaBoard.algebraic2coords(cell));
    }

    public set(cell: string, contents: CellContents): void {
        this.cells.set(...GnosticaBoard.algebraic2coords(cell), contents);
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
    public classify(cell: string): CellClass {
        return this.classifyAt(...GnosticaBoard.algebraic2coords(cell));
    }

    private classifyAt(x: number, y: number): CellClass {
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

    // Deletes the cell's stored CellContents once empty - a lingering wasteland cell would never reclassify to void and inflate the bounding box forever.
    public pruneIfEmpty(cell: string): void {
        this.pruneAt(...GnosticaBoard.algebraic2coords(cell));
    }

    private pruneAt(x: number, y: number): void {
        const t = this.cells.get(x, y);
        if (t !== undefined && t.card === undefined && t.pieces.length === 0) {
            this.cells.delete(x, y);
        }
    }

    // Only {x,y} and its four neighbours can possibly change classification, since classify() only looks one step away.
    private voidCellsWithPieces(x: number, y: number): string[] {
        const stranded: string[] = [];
        for (const [cx, cy] of [[x, y] as [number, number], ...this.neighbors(x, y)]) {
            if (this.classifyAt(cx, cy) === "void") {
                if ((this.cells.get(cx, cy)?.pieces.length ?? 0) > 0) {
                    stranded.push(GnosticaBoard.coords2algebraic(cx, cy));
                }
                this.pruneAt(cx, cy);
            }
        }
        return stranded;
    }

    // Only legal on a wasteland. Never strands anyone - adding a card only ever promotes void neighbours.
    public createTerritory(cell: string, card: TarotCard): void {
        const [x, y] = GnosticaBoard.algebraic2coords(cell);
        const existing = this.cells.get(x, y);
        if (existing !== undefined) {
            existing.card = card;
        } else {
            this.cells.set(x, y, new CellContents(card));
        }
    }

    // Removes the card; returns every cell that consequently collapsed into the void while still holding pieces, which the game must remove and stash.
    public destroyTerritory(cell: string): string[] {
        const [x, y] = GnosticaBoard.algebraic2coords(cell);
        const t = this.cells.get(x, y)!;
        t.card = undefined;
        if (t.pieces.length === 0) {
            this.cells.delete(x, y);
        }
        return this.voidCellsWithPieces(x, y);
    }

    // In-place value change (grow or shrink); the cell still has a card throughout, so this never changes classification. Shrinking to nothing is destroyTerritory.
    public updateTerritory(cell: string, newCard: TarotCard): void {
        this.get(cell)!.card = newCard;
    }

    // Moves only the CARD; pieces stay put. Destination is always wasteland, possibly already holding pieces of its own.
    public pushTerritory(from: string, to: string): string[] {
        const [fromX, fromY] = GnosticaBoard.algebraic2coords(from);
        const [toX, toY] = GnosticaBoard.algebraic2coords(to);
        const src = this.cells.get(fromX, fromY)!;
        const card = src.card!;

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
        return this.voidCellsWithPieces(fromX, fromY);
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
