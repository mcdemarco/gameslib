import { UnboundedSquareBoard } from "../../common/unbounded-square-board";
import { DirectionCardinal, orthDirections } from "../../common";
import { TarotCard } from "../../common/tarot";
import { CellContents, ICellContents } from "./cell";
import { Piece } from "./Piece";

export type CellClass = "territory" | "wasteland" | "void";

export interface IEvicted {
    x: number;
    y: number;
    pieces: Piece[];
}

// Internal absolute coordinates: y increases downward, matching
// UnboundedSquareBoard's own convention (see its header comment).
const DELTAS: Record<DirectionCardinal, [number, number]> = {
    N: [0, -1],
    S: [0, 1],
    E: [1, 0],
    W: [-1, 0],
};

const colLabels = "abcdefghijklmnopqrstuvwxyz".split("");
const revColLabels = [...colLabels].reverse();

// Wraps UnboundedSquareBoard<CellContents> and adds Gnostica's board concepts
// on top of its existing set/get/delete primitives: territory vs. wasteland
// vs. void classification (derived, not stored), and the create/destroy/
// grow/shrink/push mutations, each responsible for evicting any pieces left
// stranded in a newly-void cell (general rule: they're returned to the
// owner's stash - see docs on destroyTerritory/pushTerritory below for the
// one documented exception, which is applied by the caller in
// src/games/gnostica/powers.ts, not here).
export class GnosticaBoard {
    private cells: UnboundedSquareBoard<CellContents>;

    constructor(cells?: UnboundedSquareBoard<CellContents>) {
        this.cells = cells ?? new UnboundedSquareBoard<CellContents>();
    }

    // The live UnboundedSquareBoard this wraps. This is what actually gets
    // stored in IMoveState (never a GnosticaBoard instance) - see
    // GnosticaBoard.rehydrate() for why.
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

    // Territory-ness/wasteland-ness/void-ness is derived from live board
    // contents every time, never stored. Adjacency is checked only against
    // immediate neighbours that themselves carry a card - it does NOT chain
    // through neighbouring wastelands.
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

    // Deletes {x,y}'s own stored CellContents once it's become empty (no
    // card, no pieces) - the invariant this class's own header comment
    // promises ("a wasteland with no pieces on it is never actually
    // stored on the board"), but which only destroyTerritory/
    // evictVoidPieces previously enforced, and only for a cell that
    // reclassifies all the way down to "void". A wasteland cell (one
    // still adjacent to a card-bearing neighbour) that loses its last
    // piece - e.g. it moves, is destroyed, or its owner is eliminated -
    // never reclassifies to "void" at all, so it was never pruned: the
    // empty CellContents stayed in the map forever, artificially inflating
    // minX/maxX/minY/maxY (and so the rendered window) even though
    // nothing was actually there anymore. Deliberately classify()-
    // agnostic - emptiness alone is the only thing that matters here.
    // Every caller that removes a piece from a cell without immediately
    // adding a different one back to that same cell needs to call this
    // afterward (see movePiece/attackPiece/hermitMovePiece in
    // powers.ts, and eliminatePlayer in gnostica.ts).
    public pruneIfEmpty(x: number, y: number): void {
        const t = this.cells.get(x, y);
        if (t !== undefined && t.card === undefined && t.pieces.length === 0) {
            this.cells.delete(x, y);
        }
    }

    // Only {x,y} and its four neighbours can possibly change classification
    // as a result of a mutation at {x,y}, since classify() only ever looks
    // one step away.
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

    // Only legal on a wasteland. Never strands anyone - adding a card can
    // only ever promote void neighbours to wasteland, not the reverse.
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

    // Removes the card at {x,y} (the cell may still hold pieces afterwards).
    // Returns every cell (this one, or a neighbour) that consequently
    // collapsed into the void, with the pieces evicted from it. Icehouse
    // pieces are never removed from the game outright - by the general void
    // rule, every evicted piece (including the destroyed cell's own) is
    // returned to its owner's stash; the caller in powers.ts is responsible
    // for actually crediting the stash.
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

    // In-place value change; the cell still has *a* card throughout, so this
    // can never change any cell's classification and never strands anyone.
    public growTerritory(x: number, y: number, newCard: TarotCard): void {
        const t = this.cells.get(x, y);
        if (t === undefined || t.card === undefined) {
            throw new Error(`No territory to grow at (${x},${y}).`);
        }
        t.card = newCard;
    }

    // Same in-place swap as growTerritory; shrinking all the way to nothing
    // is destroyTerritory, not this method.
    public shrinkTerritory(x: number, y: number, newCard: TarotCard): void {
        this.growTerritory(x, y, newCard);
    }

    // Moves only the CARD from (fromX,fromY) to (toX,toY) - per the rules,
    // pieces never travel with a pushed territory, they stay exactly where
    // they were. The destination is always wasteland (the caller already
    // enforced that), so it may already hold pieces of its own, stored as
    // a cardless CellContents object - the incoming card slides in under
    // them by attaching to that SAME object, not a fresh one. Returns the
    // same "evicted at the departure side" list as destroyTerritory
    // (arrival can only promote cells, never strand anyone there).
    public pushTerritory(fromX: number, fromY: number, toX: number, toY: number): IEvicted[] {
        const src = this.cells.get(fromX, fromY);
        if (src === undefined || src.card === undefined) {
            throw new Error(`No territory to push at (${fromX},${fromY}).`);
        }
        const card = src.card;

        // Place the card at its destination FIRST. If the destination is
        // adjacent to the source (the common case), the source cell's
        // classification legitimately depends on the card already having
        // arrived next door - evicting before it lands would wrongly treat
        // that in-between state as void.
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

    // Rehydration after JSON.parse(str, reviver). GnosticaBoard itself is
    // never serialized/deserialized - IMoveState.board stores the raw
    // UnboundedSquareBoard<CellContents> directly (mirrors homeworlds.ts's
    // System[] and trax.ts/knightline.ts's own board field), and the game
    // class is expected to call this on that field before use. Two rounds of
    // fix-up are needed: UnboundedSquareBoard.from() only restores the Map
    // wrapper itself, so every stored CellContents value still comes back as
    // a plain object and needs its own CellContents.deserialize() pass to
    // become a real instance with methods again.
    public static rehydrate(raw: UnboundedSquareBoard<ICellContents>): UnboundedSquareBoard<CellContents> {
        const wrapped = UnboundedSquareBoard.from(raw);
        const fixed = new UnboundedSquareBoard<CellContents>();
        for (const [x, y, t] of wrapped) {
            fixed.set(x, y, CellContents.deserialize(t));
        }
        return fixed;
    }

    /* Algebraic notation: a stable letter+number scheme (mirrors
     * src/games/knightline.ts) so move strings and cell references stay
     * meaningful even as the board's live bounding box drifts under pushes,
     * growth, and destruction. The origin (0,0) is "m0" - centred in the
     * alphabet, like Knight Line, so early growth in either x direction
     * stays single-letter for longer. */
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
