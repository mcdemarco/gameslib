import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult, IStashEntry } from "./_base";
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
    stashes: Map<playerid, [number, number, number]>; // index 0 is size 1, index 1 is size 2, index 2 is size 3
};

export interface IBTTState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

export class BTTGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Branches and Twigs and Thorns",
        uid: "btt",
        playercounts: [2, 3, 4, 5, 6],
        version: "20260305",
        dateAdded: "2026-03-05",
        // i18next.t("apgames:descriptions.btt")
        description: "apgames:descriptions.btt",
        urls: [
            "https://boardgamegeek.com/boardgame/17298/branches-and-twigs-and-thorns",
            "https://www.eblong.com/zarf/barsoom-go.html"
        ],
        people: [
            {
                type: "designer",
                name: "Andrew Plotkin",
                urls: ["https://www.eblong.com"]
            },
            {
                type: "coder",
                name: "mcd",
                urls: ["https://mcdemarco.net/games/"],
                apid: "4bd8317d-fb04-435f-89e0-2557c3f2e66c",
            },
        ],
        variants: [
            { uid: "arcade", group: "setup" },
            { uid: "martian-go", group: "setup" }
        ],
        categories: ["goal>score>maximize", "mechanic>place", "board>shape>rect", "board>connect>rect", "components>pyramids", "other>2+players"],
        flags: ["player-stashes", "scores", "experimental"]
    };

    public numplayers!: number;
    public currplayer: playerid = 1;
    public board!: Map<string, CellContents>;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public scores!: number[];
    public stashes!: Map<playerid, [number, number, number]>;
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];

    constructor(state: number | IBTTState | string, variants?: string[]) {
        super();
        if (typeof state === "number") {
            this.numplayers = state;
            if (variants !== undefined) {
                this.variants = [...variants];
            }
            
            const fresh: IMoveState = {
                _version: BTTGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board: new Map(),
                scores: [],
                stashes: new Map()
            };
            if ( this.variants.includes("martian-go") && this.numplayers < 5 ) {
                //There are no nulls, and the roots are prefab.
                fresh.board.set("d4", "ROOT");
                fresh.board.set("e4", "ROOT");
                if (this.numplayers === 3) {
                    fresh.board.set("d3", "ROOT");
                } else if (this.numplayers === 4) {
                    fresh.board.set("d5", "ROOT");
                    fresh.board.set("e5", "ROOT");
                }
            }

            for (let pid = 1; pid <= state; pid++) {
                fresh.scores.push(0);
                if ( this.variants.includes("arcade") )
                    fresh.stashes.set(pid as playerid, [3,3,3]);
                else
                    fresh.stashes.set(pid as playerid, [5,5,5]);
            }

            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IBTTState;
            }
            if (state.game !== BTTGame.gameinfo.uid) {
                throw new Error(`The BTT engine cannot process a game of '${state.game}'.`);
            }
            this.numplayers = state.numplayers;
            this.variants = state.variants;
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.stack = [...state.stack];
        }
        this.load();
    }

    public load(idx = -1): BTTGame {
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
        this.stashes = deepclone(state.stashes) as Map<playerid, [number, number, number]>;
        this.results = [...state._results];
        return this;
    }

    public get boardHeight(): number {
        if (this.variants.includes("arcade"))
            return this.numplayers < 6 ? 5 : 10;
        else 
            return this.numplayers * 2;
    }

    public get boardWidth(): number {
        if (this.variants.includes("arcade"))
            return this.numplayers < 6 ? this.numplayers * 2 : 6;
        else
            return 8;
    }

    public coords2algebraic(x: number, y: number): string {
        return GameBase.coords2algebraic(x, y, this.numplayers * 2);
    }
    public algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, this.numplayers * 2);
    }


    /* helper functions */

    //TODO: this becomes more complicated with 3 nulls (6 players).
    private checkNull(cell: string): boolean {
        //Determine whether a second null is legal (doesn't isolate any squares).
        //Also returns true if there is no first null.
        const firstNull = [...this.board.values()].filter(c => c === "NULL");
        if ( firstNull === undefined || firstNull.length === 0 )
            return true;

        const firstXY = this.algebraic2coords([...this.board.keys()][0]);
        const secondXY = this.algebraic2coords(cell);
        //The first condition on cutting off squares: the cells are diagonally adjacent.
        if ( (Math.abs(firstXY[0] - secondXY[0]) !== 1)
            || (Math.abs(firstXY[1] - secondXY[1]) !== 1) )
            return true;
        //The second condition is that both cells are on (different) edges of the board.
        if ( firstXY[0] !== 0 && firstXY[0] !== this.boardWidth - 1 &&
            firstXY[1] !== 0 && firstXY[1] !== this.boardHeight - 1 )
            return true;
        if ( secondXY[0] !== 0 && secondXY[0] !== this.boardWidth - 1 &&
            secondXY[1] !== 0 && secondXY[1] !== this.boardHeight - 1 )
            return true;
        
        return false;
    }

    //TODO: these get called alot; add a list of nulls/roots to the state instead?
    private needNull(): boolean {
        if ( this.variants.includes("martian-go") && this.numplayers < 5 )
            return false;
        const nulls = [...this.board.values()].filter(c => c === "NULL").length;
        return nulls < Math.floor(this.numplayers / 2);
    }

    private needRoot(): boolean {
        const roots = [...this.board.values()].filter(c => c === "ROOT").length;
        return roots < Math.ceil(this.numplayers / 2);
    }


    /* end helper functions */

    public moves(player?: playerid): string[] {
        if (this.gameover) { return []; }
        if (player === undefined) {
            player = this.currplayer;
        }
        const moves: string[] = [];

        if ( this.needNull() ) {
            for (let y = 0; y < this.boardHeight; y++) {
                for (let x = 0; x < this.boardWidth; x++) {
                    const cell = this.coords2algebraic(x, y);
                    if (this.board.has(cell)) continue;
                    if ( ! this.checkNull(cell) ) {
                        continue;
                    }
                    moves.push(`NULL-${cell}`);
                }
            }
        } else if ( this.needRoot() ) {
            for (let y = 0; y < this.boardHeight; y++) {
                for (let x = 0; x < this.boardWidth; x++) {
                    const cell = this.coords2algebraic(x, y);
                    if (!this.board.has(cell)) {
                        moves.push(`ROOT-${cell}`);
                    }
                }
            }
        } else {
            // Normal placement phase
            const stashes = this.stashes.get(player)!;
            const sizes: Size[] = [];
            if (stashes[0] > 0) sizes.push(1);
            if (stashes[1] > 0) sizes.push(2);
            if (stashes[2] > 0) sizes.push(3);

            const grid = new RectGrid(this.boardWidth, this.boardHeight);

            for (const [cell, contents] of this.board.entries()) {
                if (contents === "NULL") continue;

                const [x, y] = this.algebraic2coords(cell);

                for (const dir of orientations) {
                    const ray = grid.ray(x, y, dir);
                    if (ray.length > 0) {
                        const [nx, ny] = ray[0];
                        const nextCell = this.coords2algebraic(nx, ny);
                        if (!this.board.has(nextCell)) {
                            const oppDir = dir === "N" ? "S" : dir === "S" ? "N" : dir === "E" ? "W" : "E";
                            for (const size of sizes) {
                                moves.push(`${size}-${nextCell}-${oppDir}`);
                            }
                        }
                    }
                }
            }
        }

        return moves;
    }

    public randomMove(): string {
        const allmoves = this.moves();
        const grid = new RectGrid(this.boardWidth, this.boardHeight);
        
        //Omit the "stupid" moves.
        // If the move points to an opponent's piece, but the piece ALSO has an adjacent friendly piece, it is forbidden.
        const filteredMoves = [];
        for (const move of allmoves) {
            const parts = move.split("-");
            if (parts.length !== 3) continue;
            const [, cell, oppDir] = parts;

            let adjFriendlies = false;
            const [cx, cy] = this.algebraic2coords(cell);
            for (const d of orientations) {
                const ray = grid.ray(cx, cy, d);
                if (ray.length > 0) {
                    const [nx, ny] = ray[0];
                    const nc = this.coords2algebraic(nx, ny);
                    if (this.board.has(nc)) {
                        const c = this.board.get(nc)!;
                        if (Array.isArray(c) && c[0] === this.currplayer) {
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
                const pointedCell = this.coords2algebraic(px, py);
                const pointedContents = this.board.get(pointedCell);
                if (pointedContents && Array.isArray(pointedContents)) {
                    const nextColor = pointedContents[0];
                    if (nextColor !== this.currplayer && adjFriendlies) {
                        continue; // Culling this move
                    }
                }
            }
            filteredMoves.push(move);
        }

        if (filteredMoves.length > 0)
            return filteredMoves[Math.floor(Math.random() * filteredMoves.length)];
        else
            return allmoves[Math.floor(Math.random() * allmoves.length)];
        //Or emit an error, because the latter case shouldn't happen.
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            //Preliminary move format: cell-NULL|ROOT
            //Preliminary move format: cell|cell|cell-size-direction
            //Final move format: cell-size-direction
            const cell = this.coords2algebraic(col, row);

            let newmove = "";
 
            if ( this.needNull() ) {
                newmove = `NULL-${cell}`;
            } else if ( this.needRoot() ) {
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
                    const [cx, cy] = this.algebraic2coords(move as string);
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
            if ( this.needNull() )
                result.message = i18next.t("apgames:validation.btt.NULL_INSTRUCTIONS");
            else if ( this.needRoot() )
                result.message = i18next.t("apgames:validation.btt.ROOT_INSTRUCTIONS");
            else
                result.message = i18next.t("apgames:validation.btt.ROOT_INSTRUCTIONS");
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

    public move(m: string, { partial = false, trusted = false } = {}): BTTGame {
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

            const stash = this.stashes.get(this.currplayer)!;
            stash[size - 1]--;
            this.stashes.set(this.currplayer, stash);
            this.board.set(cell, [this.currplayer, size, dir]);
            this.results.push({ type: "place", where: cell, what: size.toString(), how: dir });

            // Handle pointing penalties
            const grid = new RectGrid(this.boardWidth, this.boardHeight);
            const [cx, cy] = this.algebraic2coords(cell);
            const ray = grid.ray(cx, cy, dir);
            if (ray.length > 0) {
                const [px, py] = ray[0];
                const pcell = this.coords2algebraic(px, py);
                const pcontents = this.board.get(pcell);
                if (pcontents && Array.isArray(pcontents)) {
                    const oppPlayer = pcontents[0];
                    if (oppPlayer !== this.currplayer) {
                        const oppSize = pcontents[1];
                        this.scores[this.currplayer - 1] -= oppSize;
                        if (! this.variants.includes("martian-go") )
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

    protected checkEOG(): BTTGame {
        const maxPieces = this.numplayers * 16;

        if (this.board.size === maxPieces) {
            this.gameover = true;
        } else if (this.moves().length === 0) {
            this.gameover = true;
        }

        if (this.gameover === true) {
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

    public state(): IBTTState {
        return {
            game: BTTGame.gameinfo.uid,
            numplayers: this.numplayers,
            variants: this.variants,
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack]
        };
    }

    public moveState(): IMoveState {
        return {
            _version: BTTGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            lastmove: this.lastmove,
            board: deepclone(this.board) as Map<string, CellContents>,
            scores: [...this.scores],
            stashes: deepclone(this.stashes) as Map<playerid, [number, number, number]>
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
            for (let col = 0; col < this.boardWidth; col++) {
                const cell = this.coords2algebraic(col, row);
                if (this.board.has(cell)) {
                    const contents = this.board.get(cell)!;
                    if (contents === "NULL") {
                        pieces.push("X");
                    } else if (contents === "ROOT") {
                        pieces.push("R");
                    } else {
                        const [player, size, dir] = contents;
                        pieces.push("P" + player.toString() + size.toString() + dir);
                    }
                } else {
                    pieces.push("-");
                }
            }
            pstr += pieces.join(",");
        }

        const token: [Glyph, ...Glyph[]] =  [
            { name: "piece", colour: "#000", scale: 0.5 },
            { name: "piece", colour: "#fff", scale: 0.3 }
        ]

        const tokens: [Glyph, ...Glyph[]] = [
            {
                name: "piece-square-borderless",
                colour: "_context_background",
            }
        ];

        const nudges: [number,number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

        nudges.forEach( nudge => {
            tokens.push({
                name: "piece",
                colour: "#000",
                scale: 0.5,
                nudge: {
                    dx: nudge[0] * 225,
                    dy: nudge[1] * 225,
                }
            });
            tokens.push({
                name: "piece",
                colour: "#fff",
                scale: 0.3,
                nudge: {
                    dx: nudge[0] * 375,
                    dy: nudge[1] * 375,
                }
             });
        });

        const myLegend: ILegendObj = {
            "X": token,
            "R": tokens
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
                    const pyraglyph: Glyph = {
                        name: "pyramid-flat-" + sizeNames[size - 1],
                        colour: player,
                        rotate: angle,
                    };
                    myLegend["P" + player.toString() + size.toString() + dir] = pyraglyph;
                }
            }
        }

        // Build rep
        const rep: APRenderRep = {
            board: {
                style: "squares-checkered",
                width: this.boardWidth,
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
                    const [x, y] = this.algebraic2coords(mSafe.where || mSafe.to!);
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

        status += "**Stashes**\n\n";
        for (let n = 1; n <= this.numplayers; n++) {
            const stash = this.stashes.get(n as playerid);
            if (stash) {
                status += `Player ${n}: ${stash[0]} small, ${stash[1]} medium, ${stash[2]} large\n\n`;
            }
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

    public getPlayerStash(player: number): IStashEntry[] | undefined {
        const stash = this.stashes.get(player as playerid);
        if (stash !== undefined) {
            return [
                { count: stash[0], glyph: { name: "pyramid-flat-small", colour: player }, movePart: "1" },
                { count: stash[1], glyph: { name: "pyramid-flat-medium", colour: player }, movePart: "2" },
                { count: stash[2], glyph: { name: "pyramid-flat-large", colour: player }, movePart: "3" }
            ];
        }
        return;
    }

    protected getMoveList(): APMoveResult[] {
        return this.getMovesAndResults(["move", "capture", "orient", "eog", "winners"]) as APMoveResult[];
    }

    public getPlayerScore(player: number): number {
        return this.scores[player - 1];
    }

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "deltaScore":
                if ( this.variants.includes("martian-go") && r.delta === -1 )
                    node.push(i18next.t("apresults:DELTASCORE.btt_go_one", {player, delta: r.delta! * -1}));
                else if ( this.variants.includes("martian-go") )
                    node.push(i18next.t("apresults:DELTASCORE.btt_go", {player, delta: r.delta! * -1}));
                else if ( r.delta === -1 )
                    node.push(i18next.t("apresults:DELTASCORE.btt_default_one", {player, delta: r.delta! * -1}));         
                else 
                    node.push(i18next.t("apresults:DELTASCORE.btt_default", {player, delta: r.delta! * -1}));         
                resolved = true;
                break;
        }
        switch (r.type) {
            case "place":
                if (r.what === "1")
                    node.push(i18next.t("apresults:PLACE.btt_small", {player, what: r.what, where: r.where, how: r.how}));
                else if (r.what === "2")
                    node.push(i18next.t("apresults:PLACE.btt_medium", {player, what: r.what, where: r.where, how: r.how}));
                else if (r.what === "3")
                    node.push(i18next.t("apresults:PLACE.btt_large", {player, what: r.what, where: r.where, how: r.how}));
                else
                    node.push(i18next.t("apresults:PLACE.btt", {player, what: r.what!.toLowerCase(), where: r.where, how: r.how}));
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): BTTGame {
        return new BTTGame(this.serialize());
    }
}
