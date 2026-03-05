import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, Glyph } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { RectGrid, reviver, UserFacingError } from "../common";
import i18next from "i18next";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

interface ILegendObj {
    [key: string]: Glyph | [Glyph, ...Glyph[]];
}

export type playerid = 1 | 2 | 3 | 4;
export type Size = 1 | 2 | 3;
export type Facing = "N" | "E" | "S" | "W";
export type CellContents = [playerid, Size, Facing] | "NULL" | "ROOT";

const orientations: Facing[] = ["N", "E", "S", "W"];

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: Map<string, CellContents>;
    lastmove?: string;
    scores: number[];
    stashes: {
        [key in playerid]?: [number, number, number]; // index 0 is size 1, index 1 is size 2, index 2 is size 3
    };
};

export interface IBttState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

export class BttGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Branches and Twigs and Thorns",
        uid: "btt",
        playercounts: [2, 4],
        version: "20240415",
        dateAdded: "2024-04-15",
        // i18next.t("apgames:descriptions.btt")
        description: "apgames:descriptions.btt",
        urls: [
            "https://boardgamegeek.com/boardgame/1765/branches-twigs-and-thorns",
        ],
        people: [
            {
                type: "designer",
                name: "Kory Heath",
                urls: ["http://www.koryheath.com/games/branches-twigs-and-thorns/"]
            },
        ],
        categories: ["goal>score>maximize", "mechanic>place", "board>shape>rect", "board>connect>rect", "components>pyramids"],
        flags: ["scores", "perspective"]
    };

    public numplayers = 2;
    public currplayer: playerid = 1;
    public board!: Map<string, CellContents>;
    public gameover = false;
    public winner: playerid[] = [];
    public scores!: number[];
    public stashes!: {
        [key in playerid]?: [number, number, number];
    };
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    public variants: string[] = [];

    constructor(state?: IBttState | string, variants?: string[]) {
        super();
        if (state === undefined) {
            let stashes: { [key in playerid]?: [number, number, number] };
            if ((variants !== undefined) && (variants.includes("4player"))) {
                this.numplayers = 4;
                stashes = {
                    1: [5, 5, 5],
                    2: [5, 5, 5],
                    3: [5, 5, 5],
                    4: [5, 5, 5],
                };
            } else {
                this.numplayers = 2;
                stashes = {
                    1: [5, 5, 5],
                    2: [5, 5, 5],
                };
            }
            const fresh: IMoveState = {
                _version: BttGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board: new Map(),
                scores: this.numplayers === 2 ? [0, 0] : [0, 0, 0, 0],
                stashes
            };
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IBttState;
            }
            if (state.game !== BttGame.gameinfo.uid) {
                throw new Error(`The BTT engine cannot process a game of '${state.game}'.`);
            }
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.variants = state.variants;
            this.stack = [...state.stack];
        }
        this.load();
    }

    public load(idx = -1): BttGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if ((idx < 0) || (idx >= this.stack.length)) {
            throw new Error("Could not load the requested state from the stack.");
        }

        const state = this.stack[idx];
        this.currplayer = state.currplayer;
        this.board = deepclone(state.board) as Map<string, CellContents>;
        this.lastmove = state.lastmove;
        this.scores = [...state.scores];
        this.stashes = deepclone(state.stashes);
        this.results = [...state._results];
        return this;
    }

    public get boardHeight(): number {
        return this.numplayers === 2 ? 4 : 8;
    }

    public static coords2algebraic(x: number, y: number, playercount: number): string {
        return GameBase.coords2algebraic(x, y, playercount === 2 ? 4 : 8);
    }
    public static algebraic2coords(cell: string, playercount: number): [number, number] {
        return GameBase.algebraic2coords(cell, playercount === 2 ? 4 : 8);
    }

    public moves(player?: playerid): string[] {
        if (this.gameover) { return []; }
        if (player === undefined) {
            player = this.currplayer;
        }
        const allmoves: string[] = [];

        const nulls = [...this.board.values()].filter(c => c === "NULL").length;
        const roots = [...this.board.values()].filter(c => c === "ROOT").length;

        if ((this.numplayers === 2 && nulls === 0) || (this.numplayers === 4 && nulls < 2)) {
            const badnulls = new Map<string, string>();
            if (this.numplayers === 4) {
                badnulls.set("a2", "b1"); badnulls.set("b1", "a2");
                badnulls.set("a7", "b8"); badnulls.set("b8", "a7");
                badnulls.set("g1", "h2"); badnulls.set("h2", "g1");
                badnulls.set("h7", "g8"); badnulls.set("g8", "h7");
            }

            const existingNull = [...this.board.entries()].find(e => e[1] === "NULL")?.[0];

            for (let y = 0; y < this.boardHeight; y++) {
                for (let x = 0; x < 8; x++) {
                    const cell = BttGame.coords2algebraic(x, y, this.numplayers);
                    if (this.board.has(cell)) continue;
                    if (existingNull !== undefined && badnulls.get(existingNull) === cell) continue;
                    allmoves.push(`NULL-${cell}`);
                }
            }
        } else if ((this.numplayers === 2 && roots === 0) || (this.numplayers === 4 && roots < 2)) {
            for (let y = 0; y < this.boardHeight; y++) {
                for (let x = 0; x < 8; x++) {
                    const cell = BttGame.coords2algebraic(x, y, this.numplayers);
                    if (!this.board.has(cell)) {
                        allmoves.push(`ROOT-${cell}`);
                    }
                }
            }
        } else {
            // Normal placement phase
            const stashes = this.stashes[player]!;
            const sizes: Size[] = [];
            if (stashes[0] > 0) sizes.push(1);
            if (stashes[1] > 0) sizes.push(2);
            if (stashes[2] > 0) sizes.push(3);

            const grid = new RectGrid(8, this.boardHeight);

            for (const [cell, contents] of this.board.entries()) {
                if (contents === "NULL") continue;

                const [x, y] = BttGame.algebraic2coords(cell, this.numplayers);

                for (const dir of orientations) {
                    const ray = grid.ray(x, y, dir);
                    if (ray.length > 0) {
                        const [nx, ny] = ray[0];
                        const nextCell = BttGame.coords2algebraic(nx, ny, this.numplayers);
                        if (!this.board.has(nextCell)) {
                            const oppDir = dir === "N" ? "S" : dir === "S" ? "N" : dir === "E" ? "W" : "E";
                            for (const size of sizes) {
                                allmoves.push(`${size}-${nextCell}-${oppDir}`);
                            }
                        }
                    }
                }
            }

            // Cull "stupid" moves
            // If the move points to an opponent's piece, but the piece ALSO has an adjacent friendly piece, it is forbidden.
            const filteredMoves = [];
            for (const move of allmoves) {
                const parts = move.split("-");
                if (parts.length !== 3) continue;
                const [, cell, oppDir] = parts;

                let adjFriendlies = false;
                const [cx, cy] = BttGame.algebraic2coords(cell, this.numplayers);
                for (const d of orientations) {
                    const ray = grid.ray(cx, cy, d);
                    if (ray.length > 0) {
                        const [nx, ny] = ray[0];
                        const nc = BttGame.coords2algebraic(nx, ny, this.numplayers);
                        if (this.board.has(nc)) {
                            const c = this.board.get(nc)!;
                            if (Array.isArray(c) && c[0] === player) {
                                adjFriendlies = true;
                                break;
                            }
                        }
                    }
                }

                const dir = oppDir === "N" ? "S" : oppDir === "S" ? "N" : oppDir === "E" ? "W" : "E";
                const ray = grid.ray(cx, cy, dir);
                if (ray.length > 0) {
                    const [px, py] = ray[0];
                    const pointedCell = BttGame.coords2algebraic(px, py, this.numplayers);
                    const pointedContents = this.board.get(pointedCell);
                    if (pointedContents && Array.isArray(pointedContents)) {
                        const nextColor = pointedContents[0];
                        if (nextColor !== player && adjFriendlies) {
                            continue; // Culling this move
                        }
                    }
                }

                filteredMoves.push(move);
            }

            return filteredMoves;
        }

        return allmoves;
    }

    public randomMove(): string {
        const moves = this.moves();
        return moves[Math.floor(Math.random() * moves.length)];
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            const cell = BttGame.coords2algebraic(col, row, this.numplayers);

            let newmove = "";
            const nulls = [...this.board.values()].filter(c => c === "NULL").length;
            const roots = [...this.board.values()].filter(c => c === "ROOT").length;

            if ((this.numplayers === 2 && nulls === 0) || (this.numplayers === 4 && nulls < 2)) {
                newmove = `NULL-${cell}`;
            } else if ((this.numplayers === 2 && roots === 0) || (this.numplayers === 4 && roots < 2)) {
                newmove = `ROOT-${cell}`;
            } else {
                if (move === "") {
                    // Start of a piece placement. Wait for piece size string, or click again to infer.
                    // Actually, a piece placement needs a size and an orientation.
                    // Typically, we'd construct something like `1-${cell}` then wait for orientation. But we have no UI.
                    // AP standard is to just return partial.
                    // Let's just say we can't fully construct pieces by clicks easily down to the size without a specific UI,
                    // but we can start with the cell.
                    newmove = cell;
                } else {
                    // if move is a cell, and we clicked an adjacent piece
                    const [cx, cy] = BttGame.algebraic2coords(move as string, this.numplayers);
                    const bearing = RectGrid.bearing(cx, cy, col, row);
                    if (bearing) {
                        newmove = `${move}-${bearing}`;
                    } else {
                        newmove = move; // just keep it
                    }
                }
            }

            const result = this.validateMove(newmove) as IClickResult;
            if (!result.valid) {
                result.move = "";
            } else {
                result.move = newmove;
            }
            return result;
        } catch (e) {
            return {
                move,
                valid: false,
                message: i18next.t("apgames:validation._general.GENERIC", { move, row, col, piece, emessage: (e as Error).message })
            }
        }
    }

    public validateMove(m: string): IValidationResult {
        const result: IValidationResult = { valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation.btt.INITIAL_INSTRUCTIONS");
            return result;
        }

        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");
        const validMoves = this.moves();

        // Let's rely heavily on the moves() generator since it accurately produces all legal moves
        // We'll match partials
        let isComplete = false;
        let isPartial = false;
        for (const v of validMoves) {
            if (v.toLowerCase() === m) {
                isComplete = true;
                break;
            }
            if (v.toLowerCase().startsWith(m) || (m.length > 0 && v.toLowerCase().includes(m))) { // rough partial
                isPartial = true;
            }
        }

        if (isComplete) {
            result.valid = true;
            result.complete = 1;
            result.message = i18next.t("apgames:validation._general.VALID_MOVE");
            return result;
        }

        if (isPartial) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation.btt.PARTIAL_MOVE");
            return result;
        }

        // Failsafe error
        result.valid = false;
        result.message = i18next.t("apgames:validation._general.INVALID_MOVE", { move: m });
        return result;
    }

    public move(m: string, { partial = false, trusted = false } = {}): BttGame {
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }

        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");

        if (!trusted) {
            const result = this.validateMove(m);
            if (!result.valid) {
                throw new UserFacingError("VALIDATION_GENERAL", result.message);
            }
            if (!partial && !this.moves().map(x => x.toLowerCase()).includes(m)) {
                throw new UserFacingError("VALIDATION_FAILSAFE", i18next.t("apgames:validation._general.FAILSAFE", { move: m }));
            }
        }

        if (partial) { return this; }

        const canon = this.moves().find(v => v.toLowerCase() === m);
        if (canon !== undefined) {
            m = canon;
        }

        this.results = [];

        if (m.startsWith("NULL-")) {
            const cell = m.substring(5);
            this.board.set(cell, "NULL");
            this.results.push({ type: "place", where: cell, what: "NULL" });
        } else if (m.startsWith("ROOT-")) {
            const cell = m.substring(5);
            this.board.set(cell, "ROOT");
            this.results.push({ type: "place", where: cell, what: "ROOT" });
        } else {
            const parts = m.split("-");
            const size = parseInt(parts[0], 10) as Size;
            const cell = parts[1];
            const dir = parts[2] as Facing;

            this.stashes[this.currplayer]![size - 1]--;
            this.board.set(cell, [this.currplayer, size, dir]);
            this.results.push({ type: "place", where: cell, what: size.toString() });
            this.results.push({ type: "orient", where: cell, facing: dir });

            // Handle pointing penalties
            const grid = new RectGrid(8, this.boardHeight);
            const [cx, cy] = BttGame.algebraic2coords(cell, this.numplayers);
            const ray = grid.ray(cx, cy, dir);
            if (ray.length > 0) {
                const [px, py] = ray[0];
                const pcell = BttGame.coords2algebraic(px, py, this.numplayers);
                const pcontents = this.board.get(pcell);
                if (pcontents && Array.isArray(pcontents)) {
                    const oppPlayer = pcontents[0];
                    if (oppPlayer !== this.currplayer) {
                        const oppSize = pcontents[1];
                        this.scores[this.currplayer - 1] -= oppSize;
                        this.scores[oppPlayer - 1] += size;
                        this.results.push({ type: "deltaScore", delta: -oppSize });
                    }
                }
            }
        }

        this.lastmove = m;
        let newplayer = (this.currplayer as number) + 1;
        if (newplayer > this.numplayers) {
            newplayer = 1;
        }
        this.currplayer = newplayer as playerid;

        this.checkEOG();
        this.saveState();
        return this;
    }

    protected checkEOG(): BttGame {
        let gameEnded = false;
        const maxPieces = this.numplayers === 2 ? 32 : 64;

        if (this.board.size === maxPieces) {
            gameEnded = true;
        } else if (this.moves().length === 0) {
            gameEnded = true;
        }

        if (gameEnded) {
            this.gameover = true;
            const maxScore = Math.max(...this.scores);
            for (let i = 0; i < this.numplayers; i++) {
                if (this.scores[i] === maxScore) {
                    this.winner.push((i + 1) as playerid);
                }
            }
            this.results.push(
                { type: "eog" },
                { type: "winners", players: [...this.winner] }
            );
        }

        return this;
    }

    public state(): IBttState {
        return {
            game: BttGame.gameinfo.uid,
            numplayers: this.numplayers,
            variants: this.variants,
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack]
        };
    }

    public moveState(): IMoveState {
        return {
            _version: BttGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            lastmove: this.lastmove,
            board: deepclone(this.board) as Map<string, CellContents>,
            scores: [...this.scores],
            stashes: deepclone(this.stashes)
        };
    }

    public render(): APRenderRep {
        // Build piece string
        let pstr = "";
        for (let row = 0; row < this.boardHeight; row++) {
            if (pstr.length > 0) {
                pstr += "\n";
            }
            const pieces: string[] = [];
            for (let col = 0; col < 8; col++) {
                const cell = BttGame.coords2algebraic(col, row, this.numplayers);
                if (this.board.has(cell)) {
                    const contents = this.board.get(cell)!;
                    if (contents === "NULL") {
                        pieces.push("X");
                    } else if (contents === "ROOT") {
                        pieces.push("R");
                    } else {
                        const [player, size, dir] = contents;
                        pieces.push(player.toString() + size.toString() + dir);
                    }
                } else {
                    pieces.push("-");
                }
            }
            pstr += pieces.join(",");
        }

        const myLegend: ILegendObj = {
            "X": { name: "piece", colour: "_black" },
            "R": { name: "piece", colour: "_white" }
        };
        const rotations: Map<string, number> = new Map([
            ["N", 0],
            ["E", 90],
            ["S", 180],
            ["W", -90],
        ]);
        const sizeNames = ["small", "medium", "large"];
        for (let player = 1; player <= this.numplayers; player++) {
            for (const size of [1, 2, 3]) {
                for (const [dir, angle] of rotations.entries()) {
                    const node: Glyph = {
                        name: "pyramid-flat-" + sizeNames[size - 1],
                        colour: player,
                        rotate: angle,
                    };
                    myLegend[player.toString() + size.toString() + dir] = node;
                }
            }
        }

        // Build rep
        const rep: APRenderRep = {
            board: {
                style: "squares-checkered",
                width: 8,
                height: this.boardHeight,
            },
            legend: myLegend,
            pieces: pstr
        };

        // Add annotations for the last move
        if (this.results.length > 0) {
            rep.annotations = [];
            for (const move of this.results) {
                if (move.type === "place" || move.type === "move") {
                    const mSafe = move as { where?: string; to?: string };
                    const [x, y] = BttGame.algebraic2coords(mSafe.where || mSafe.to!, this.numplayers);
                    rep.annotations.push({ type: "enter", targets: [{ row: y, col: x }] });
                }
            }
        }

        return rep;
    }

    public status(): string {
        let status = super.status();

        if (this.variants !== undefined) {
            status += "**Variants**: " + this.variants.join(", ") + "\n\n";
        }

        status += "**Scores**\n\n";
        for (let n = 1; n <= this.numplayers; n++) {
            const score = this.scores[n - 1];
            status += `Player ${n}: ${score}\n\n`;
        }

        return status;
    }

    public getPlayersScores(): IScores[] {
        return [{ name: i18next.t("apgames:status.SCORES"), scores: this.scores }]
    }

    protected getMoveList(): APMoveResult[] {
        return this.getMovesAndResults(["move", "capture", "orient", "eog", "winners"]) as APMoveResult[];
    }

    public getPlayerScore(player: number): number {
        return this.scores[player - 1];
    }

    public clone(): BttGame {
        return new BttGame(this.serialize());
    }
}
