import { GameBase, IAPGameState, IClickResult, IIndividualState, IStashEntry, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { RectGrid } from "../common";
import { APRenderRep, Glyph } from "@abstractplay/renderer/src/schemas/schema";
import { Direction } from "../common";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, shuffle, UserFacingError } from "../common";
import { CartesianProduct } from "js-combinatorics";
import i18next from "i18next";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const clone = require("rfdc/default");

export type playerid = 1|2|3|4;
export type Size = 1|2|3;
export type Colour = "VT"|"OG"|"BN"|"WH";
export type CellContents = [Colour, Size];
const allColours: string[] = ["VT", "OG", "BN"];

interface ILegendObj {
    [key: string]: Glyph|[Glyph, ...Glyph[]];
}

interface ILocalStash {
    [k: string]: unknown;
    type: "localStash";
    label: string;
    stash: string[][];
}

interface IOrganizedCaps {
    triosMono: CellContents[][];
    partialsMono: CellContents[][];
    triosMixed: CellContents[][];
    partialsMixed: CellContents[][];
    miscellaneous: CellContents[];
}

interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: Array<Array<CellContents[]>>;
    lastmove?: string;
    scores: number[];
    caps: number[];
    stashes: Map<playerid, number[]>;
}

export interface IStawvsState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

export class StawvsGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Stawvs",
        uid: "stawvs",
        playercounts: [2,3,4],
        version: "20251113",
        dateAdded: "2025-11-13",
        // i18next.t("apgames:descriptions.stawvs")
        description: "apgames:descriptions.stawvs",
        urls: [
	    "https://looneypyramids.wiki/wiki/Stawvs",
	    "https://boardgamegeek.com/boardgame/130579/stawvs",
	],
        people: [
            {
                type: "designer",
                name: "Russ Williams",
		urls: ["https://boardgamegeek.com/boardgamedesigner/43454/russ-williams"],
		apid: "4223967c-d922-47c6-8f57-69b6025f5a9b",
            },
            {
                type: "coder",
                name: "mcd",
                urls: ["https://mcdemarco.net/games/"],
                apid: "4bd8317d-fb04-435f-89e0-2557c3f2e66c",
            },
        ],
        categories: ["goal>score>eog", "mechanic>set", "board>shape>rect", "board>connect>rect", "components>pyramids", "other>2+players"],
        flags: ["scores"]
    };

    public static coords2algebraic(x: number, y: number): string {
        return GameBase.coords2algebraic(x, y, 8);
    }
    public static algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, 8);
    }

    public numplayers!: number;
    public currplayer!: playerid;
    public board!: Array<Array<CellContents[]>>;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public scores!: number[];
    public caps!: number[];
    public stashes!: Map<playerid, number[]>;
    public captured: [CellContents[], CellContents[]] = [[], []];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = []

    public static newBoard(): Array<Array<CellContents[]>> {
        const order: string[] = shuffle([...allColours, ...allColours, ...allColours, ...allColours, ...allColours, "WH"]) as string[];
        const board: Array<Array<CellContents[]>> = [];
        for (let row = 0; row < 6; row++) {
            const node: Array<CellContents[]> = [];
            for (let col = 0; col < 6; col++) {
                const colour = order.pop() as Colour;
                node.push([[colour, 1], [colour, 2], [colour, 3]]);
            }
            board.push(node);
        }
        return board;
    }

    constructor(state: number | IStawvsState | string, variants?: string[]) {
        super();
        if (typeof state === "number") {
            this.numplayers = state;
            const fresh: IMoveState = {
                _version: StawvsGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board: StawvsGame.newBoard(),
                scores: [],
                caps: [],
                stashes: new Map()
            };
            if ( (variants !== undefined) && (variants.length === 1) && (variants[0] === "overloaded") ) {
                this.variants = ["overloaded"];
            }
            for (let pid = 1; pid <= state; pid++) {
                fresh.scores.push(0);
                fresh.caps.push(0);
                fresh.stashes.set(pid as playerid, [5,5,5]);
            }
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IStawvsState;
            }
            if (state.game !== StawvsGame.gameinfo.uid) {
                throw new Error(`The Stawvs! game code cannot process a game of '${state.game}'.`);
            }
            this.numplayers = state.numplayers;
            this.variants = state.variants;
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.stack = [...state.stack];
        }
        this.load();
    }

    public load(idx = -1): StawvsGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if ( (idx < 0) || (idx >= this.stack.length) ) {
            throw new Error("Could not load the requested state from the stack.");
        }

        const state = this.stack[idx];
        this.currplayer = state.currplayer;
        this.board = clone(state.board) as Array<Array<CellContents[]>>;
        this.stashes = clone(state.stashes) as Map<playerid, number[]>;
        this.lastmove = state.lastmove;
        this.scores = [...state.scores];
        this.captured = clone(state.captured) as [CellContents[], CellContents[]];
        this.caps = [...state.caps];
        return this;
    }

    public moves(player?: playerid): string[] {
        if (this.gameover) {
            return [];
        }
        if (player === undefined) {
            player = this.currplayer;
        }
        // What pieces can the player place?
        const pieces: number[] = [];
        const stash = this.stashes.get(player);
        if ( (stash === undefined) || (stash.length !== 3) ) {
            throw new Error("Malformed stash.");
        }
        [0, 1, 2].forEach((n) => {
            if (stash[n] > 0) {
                pieces.push(n + 1);
            }
        });

        if (pieces.length === 0) {
            return ["pass"];
        }

        const cells: string[] = [];
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const cell = StawvsGame.coords2algebraic(col, row);
                if (! this.board.has(cell)) {
                    cells.push(cell);
                }
            }
        }

        const moves: string[] = [];
        pieces.forEach((piece) => {
            cells.forEach((cell) => {
                moves.push(piece.toString() + cell)
            });
        });
        return moves;
    }

    public randomMove(): string {
        const moves = this.moves();
        return moves[Math.floor(Math.random() * moves.length)];
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            const cell = StawvsGame.coords2algebraic(col, row);
            let newmove = "";
            // If you click on an occupied cell, clear the entry
            if (this.board.has(cell)) {
                return {move: "", message: ""} as IClickResult;
            }
            const stash = this.stashes.get(this.currplayer)!;
            let smallest: number|undefined;
            for (let i = 0; i < 3; i++) {
                if (stash[i] > 0) {
                    smallest = i + 1;
                    break;
                }
            }
            if (stash.reduce((a, b) => a + b) === 0) {
                return {
                    move: "pass",
                    valid: true,
                    complete: 1,
                    message: i18next.t("apgames:validation._general.NOPIECES"),
                } as IClickResult;
            }
            if (move === '') {
                if (smallest === undefined) {
                    return {
                        move: "",
                        valid: false,
                        message: i18next.t("apgames:validation.stawvs.SIZEFIRST"),
                    } as IClickResult;
                } else {
                    move = smallest.toString();
                }
            }

            newmove = `${move}${cell}`

            const result = this.validateMove(newmove) as IClickResult;
            if (! result.valid) {
                result.move = "";
            } else {
                result.move = newmove;
            }
            return result;
        } catch (e) {
            return {
                move,
                valid: false,
                message: i18next.t("apgames:validation._general.GENERIC", {move, row, col, piece, emessage: (e as Error).message})
            }
        }
    }

    public validateMove(m: string): IValidationResult {
        const result: IValidationResult = {valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER")};
        const stash = this.stashes.get(this.currplayer)!;

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation.stawvs.INITIAL_INSTRUCTIONS")
            return result;
        }

        // check for "pass" first
        if (m === "pass") {
            if (stash.reduce((a, b) => a + b) === 0) {
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            } else {
                result.valid = false;
                result.message = i18next.t("apgames:validation.stawvs.MOVES_NOPASS")
                return result;
            }
        }

        const match = m.match(/^([123])([a-h][1-8])$/);
        if (match === null) {
            result.valid = false;
            if (m.length === 1 && m.match(/^[123]$/) !== null) {
                if (stash[parseInt(m, 10) - 1] === 0) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.stawvs.NOPIECE", {m});
                    return result;
                }
                result.valid = true;
                result.complete = -1;
                result.canrender = false;
                result.message = i18next.t("apgames:validation.stawvs.PARTIAL");
                return result;
            }
            result.message = i18next.t("apgames:validation.stawvs.BADSYNTAX", {move: m});
            return result;
        }
        const size = parseInt(match[1], 10);
        const cell = match[2];
        // cell exists
        try {
            StawvsGame.algebraic2coords(cell)
        } catch {
            result.valid = false;
            result.message = i18next.t("apgames:validation._general.INVALIDCELL", {cell})
            return result;
        }
        // have piece to place
        if (stash[size - 1] === 0) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.stawvs.NOPIECE", {size});
            return result;
        }
        // space is empty
        if (this.board.has(cell)) {
            result.valid = false;
            result.message = i18next.t("apgames:validation._general.OCCUPIED", {where: cell});
            return result;
        }

        // Looks good
        result.valid = true;
        result.complete = 1;
        result.message = i18next.t("apgames:validation._general.VALID_MOVE");
        return result;
    }

    public move(m: string, {trusted = false} = {}): StawvsGame {
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }

        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");
        if (! trusted) {
            const result = this.validateMove(m);
            if (! result.valid) {
                throw new UserFacingError("VALIDATION_GENERAL", result.message)
            }
            if (! this.moves().includes(m)) {
                throw new UserFacingError("VALIDATION_FAILSAFE", i18next.t("apgames:validation._general.FAILSAFE", {move: m}))
            }
        }

        if (m.toLowerCase() === "pass") {
            this.results = [{type: "pass"}];
        } else {
            // validate move
            const chars = m.split("");
            const pip = parseInt(chars[0], 10);
            const stash = this.stashes.get(this.currplayer)!;
            const cell = chars[1] + chars[2];
            const coords = StawvsGame.algebraic2coords(cell);
            const grid = new RectGrid(8, 8);

            // place the piece
            this.board.set(cell, [this.currplayer, pip]);
            stash[pip - 1]--;
            this.stashes.set(this.currplayer, stash);
            this.results = [{type: "place", where: cell, what: pip.toString()}]

            // Look in each direction for adjacent pieces and recursively push down the line
            const dirs: Direction[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
            dirs.forEach((d) => {
                const adj = RectGrid.move(...coords, d);
                if (grid.inBounds(...adj)) {
                    this.push(adj, d);
                }
            });
        }

        // update currplayer
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

    private push(start: [number, number], dir: Direction): void {
        let scoreDelta = 0;
        // If there's a piece here, move it, pushing anything it its way
        if (this.board.has(StawvsGame.coords2algebraic(...start))) {
            const grid = new RectGrid(8, 8);
            // Do the recursion, and then when it returns, move the piece
            const adj = RectGrid.move(...start, dir);
            if (grid.inBounds(...adj)) {
                this.push(adj, dir);
            }

            const cellStart = StawvsGame.coords2algebraic(...start);
            const piece = this.board.get(cellStart);
            if (piece === undefined) {
                throw new Error("Trying to move a nonexistent piece.");
            }
            // If the next cell is in bounds, move the piece
            if (grid.inBounds(...adj)) {
                this.board.set(StawvsGame.coords2algebraic(...adj), piece);
                this.results.push({type: "move", from: cellStart, to: StawvsGame.coords2algebraic(...adj), what: piece[1].toString()});
                this.board.delete(cellStart);
            // Otherwise it's off the board and is either captured or reclaimed
            } else {
                // If the piece belongs to the current player, reclaim it
                if (piece[0] === this.currplayer) {
                    const stash = this.stashes.get(this.currplayer);
                    if ( (stash === undefined) || (stash.length !== 3)) {
                        throw new Error("Malformed stash.");
                    }
                    stash[piece[1] - 1]++;
                    this.stashes.set(this.currplayer, stash);
                    this.results.push({type: "reclaim", what: piece[1].toString()});
                // Otherwise, capture it (add it to the current player's score)
                } else {
                    let score = this.scores[(this.currplayer as number) - 1];
                    if (score === undefined) {
                        throw new Error("Malformed score.");
                    }
                    let caps = this.caps[(this.currplayer as number) - 1];
                    if (caps === undefined) {
                        throw new Error("Malformed caps.");
                    }
                    caps++;
                    this.caps[(this.currplayer as number) - 1] = caps;
                    this.results.push({type: "capture", what: piece[1].toString()});
                    score += piece[1];
                    scoreDelta += piece[1];
                    this.scores[(this.currplayer as number) - 1] = score;
                }
                this.board.delete(cellStart);
            }
        }
        if (scoreDelta > 0) {
            this.results.push({type: "deltaScore", delta: scoreDelta});
        }
    }

    protected checkEOG(): StawvsGame {
        for (let n = 1; n <= this.numplayers; n++) {
            const stash = this.stashes.get(n as playerid);
            if ( (stash === undefined) || (stash.length !== 3) ) {
                throw new Error("Malformed stash.");
            }
            const sum = stash.reduce((a, b) => {return a + b;});
            if (sum > 0) {
                return this;
            }
        }
        // If we get here, then the game is truly over
        this.gameover = true;
        this.results.push({type: "eog"});
        // Find the maximum score
        const maxscore = Math.max(...this.scores);
        // If the maxscore is unique, then we've found our winner
        const map: Map<number, number> = this.scores.reduce((acc, e) => acc.set(e, (acc.get(e) || 0) + 1), new Map<number, number>());
        if (map.size === this.scores.length) {
            const n = this.scores.indexOf(maxscore);
            this.winner = [(n + 1) as playerid];
        } else {
            const nTied: playerid[] = [];
            for (let i = 0; i < this.scores.length; i++) {
                if (this.scores[i] === maxscore) {
                    nTied.push((i + 1) as playerid);
                }
            }
            const caps: number[] = [];
            for (const n of nTied) {
                caps.push(this.caps[n - 1])
            }
            const maxcaps = Math.max(...caps);
            const capmap: Map<number, number> = caps.reduce((acc, e) => acc.set(e, (acc.get(e) || 0) + 1), new Map<number, number>());
            if (capmap.size === nTied.length) {
                const n = this.caps.indexOf(maxcaps);
                this.winner = [(n + 1) as playerid];
            } else {
                this.winner = [...nTied];
            }
        }
        this.results.push({type: "winners", players: [...this.winner]});

        if (this.winner === undefined) {
            throw new Error("A winner could not be determined.");
        }

        return this;
    }

    public getPlayerScore(indata: number | IOrganizedCaps): number {
        let org: IOrganizedCaps;
        if (typeof indata === "number") {
            org = this.organizeCaps(indata as playerid);
        } else {
            org = indata;
        }
        let score = 0;
        score += 7 * org.triosMono.length;
        score += 5 * org.triosMixed.length;
        for (const stack of org.partialsMono) {
            score += stack.length;
        }
        for (const stack of org.partialsMixed) {
            score += stack.length;
        }
        score += org.miscellaneous.length;
        return score;
    }

    public organizeCaps(indata: playerid | CellContents[] = 1): IOrganizedCaps {
        let pile: CellContents[];
        if (Array.isArray(indata)) {
            pile = [...indata];
        } else {
            pile = [...(this.captured[indata - 1])];
        }

        let org: IOrganizedCaps = {
            triosMono: [],
            partialsMono: [],
            triosMixed: [],
            partialsMixed: [],
            miscellaneous: []
        };
        const stacks: CellContents[][] = [];

        const whites = pile.filter(x => x[0] === "WH");
        const lgs = pile.filter(x => x[1] === 3 && x[0] !== "WH");
        const mds = pile.filter(x => x[1] === 2 && x[0] !== "WH");
        const sms = pile.filter(x => x[1] === 1 && x[0] !== "WH");
        // Put each large in a stack and then look for a matching medium and small
        // This will find all monochrome trios
        while (lgs.length > 0) {
            const stack: CellContents[] = [];
            const next = lgs.pop();
            stack.push(next!);
            const mdIdx = mds.findIndex(x => x[0] === next![0]);
            if (mdIdx >= 0) {
                stack.push(mds[mdIdx]);
                mds.splice(mdIdx, 1);
                const smIdx = sms.findIndex(x => x[0] === next![0]);
                if (smIdx >= 0) {
                    stack.push(sms[smIdx]);
                    sms.splice(smIdx, 1);
                }
            }
            stacks.push(stack);
        }
        // Look at each stack that has only a large and find any leftover mediums and stack them
        for (const stack of stacks) {
            if (stack.length === 1) {
                const mdIdx = mds.findIndex(x => x[1] === 2);
                if (mdIdx >= 0) {
                    stack.push(mds[mdIdx]);
                    mds.splice(mdIdx, 1);
                }
            }
        }
        // Look at each stack that has a large and a medium and add any loose smalls
        for (const stack of stacks) {
            if (stack.length === 2) {
                const smIdx = sms.findIndex(x => x[1] === 1);
                if (smIdx >= 0) {
                    stack.push(sms[smIdx]);
                    sms.splice(smIdx, 1);
                }
            }
        }
        // All remaining mediums now form the basis of their own stack and see if there is a matching small
        while (mds.length > 0) {
            const stack: CellContents[] = [];
            const next = mds.pop();
            stack.push(next!);
            const smIdx = sms.findIndex(x => x[0] === next![0]);
            if (smIdx >= 0) {
                stack.push(sms[smIdx]);
                sms.splice(smIdx, 1);
            }
            stacks.push(stack);
        }
        // Find stacks with just a medium and put any loose smalls on top of them
        for (const stack of stacks) {
            if ( (stack.length === 1) && (stack[0][1] === 2) ) {
                const smIdx = sms.findIndex(x => x[1] === 1);
                if (smIdx >= 0) {
                    stack.push(sms[smIdx]);
                    sms.splice(smIdx, 1);
                }
            }
        }
        // Now all you should have are loose smalls, add those
        stacks.push(...sms.map(x => [x]));

        // And add any whites to this as well
        stacks.push(...whites.map(x => [x]));

        // // Validate that all the pieces in the original pile are now found in the stack structure
        // const pieces: CellContents[] = stacks.reduce((accumulator, value) => accumulator.concat(value), []);
        // if (pieces.length !== pile.length) {
        //     throw new Error("Stack lengths don't match. This should never happen.");
        // }

        // Categorize each stack
        for (const stack of stacks) {
            if (stack.length === 3) {
                if ((new Set(stack.map(c => c[0]))).size === 1) {
                    org.triosMono.push(clone(stack) as CellContents[]);
                } else {
                    org.triosMixed.push(clone(stack) as CellContents[]);
                }
            } else if (stack.length === 2) {
                if ((new Set(stack.map(c => c[0]))).size === 1) {
                    org.partialsMono.push(clone(stack) as CellContents[]);
                } else {
                    org.partialsMixed.push(clone(stack) as CellContents[]);
                }
            } else {
                org.miscellaneous.push(...clone(stack) as CellContents[]);
            }
        }

        if (whites.length > 0) {
            let highestScore = this.getPlayerScore(org);
            const colourSet: string[][] = [];

            for (let i = 0; i < whites.length; i++) {
                colourSet.push([...allColours]);
            }
            const replacements = [...new CartesianProduct(...colourSet)];
            const sizes = whites.map(w => w[1]);
            for (const r of replacements) {
                const newpieces: CellContents[] = [];
                for (let i = 0; i < r.length; i++) {
                    newpieces.push([r[i] as Colour, sizes[i]])
                }
                const newpile = [...pile.filter(p => p[0] !== "WH"), ...newpieces];
                const neworg = this.organizeCaps(newpile);
                const newscore = this.getPlayerScore(neworg);
                if (newscore > highestScore) {
                    // Find the replacement pieces and make them white again
                    for (const newpiece of newpieces) {
                        let found = false;
                        for (const key of ["triosMono", "triosMixed", "partialsMono", "partialsMixed"] as const) {
                            for (const stack of neworg[key]) {
                                const i = stack.findIndex(p => p[0] === newpiece[0] && p[1] === newpiece[1]);
                                if (i >= 0) {
                                    found = true;
                                    stack[i][0] = "WH";
                                    break;
                                }
                            }
                            if (found) {
                                break;
                            }
                        }
                        // If still not found, check the miscellaneous key
                        if (! found) {
                            const i = neworg.miscellaneous.findIndex(p => p[0] === newpiece[0] && p[1] === newpiece[1]);
                            if (i >= 0) {
                                found = true;
                                neworg.miscellaneous[i][0] = "WH";
                            }
                        }
                        // At this point, something has gone horribly wrong
                        if (! found) {
                            throw new Error("Could not find the replacement piece.");
                        }
                    }

                    org = clone(neworg) as IOrganizedCaps;
                    highestScore = newscore;
                }
            }
        }

        return org;
    }

    public state(): IStawvsState {
        return {
            game: StawvsGame.gameinfo.uid,
            numplayers: this.numplayers,
            variants: this.variants,
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack]
        };
    }

    public moveState(): IMoveState {
        return {
            _version: StawvsGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            lastmove: this.lastmove,
            board: clone(this.board) as Array<Array<CellContents[]>>,
            scores: [...this.scores],
            caps: [...this.caps],
            stashes: clone(this.stashes) as Map<playerid, number[]>
        };
    }

    private renderStashHelper(s: CellContents[]): string[] {
        const ret: string[] = [];
        for (let i = 0; i < s.length; i++) {
            for (let j = i; j < s[s.length - i - 1][1] - i - 1; j++)
                ret.push("-");
            ret.push(s[s.length - i - 1].join(""));
        }
        return ret;
//            return s.map((t) => t.join("") + "c");
    }

    public render(): APRenderRep {
        // Build piece string
        let pstr = "";
        for (let row = 0; row < 8; row++) {
            if (pstr.length > 0) {
                pstr += "\n";
            }
            const pieces: string[] = [];
            for (let col = 0; col < 8; col++) {
                const cell = StawvsGame.coords2algebraic(col, row);
                if (this.board.has(cell)) {
                    const contents = this.board.get(cell);
                    if (contents === undefined) {
                        throw new Error("Malformed cell contents.");
                    }
                    pieces.push("P" + contents[0].toString() + contents[1].toString());
                } else {
                    pieces.push("-");
                }
            }
            pstr += pieces.join(",");
        }
        pstr = pstr.replace(/-{8}/g, "_");

        // build legend based on number of players
        const myLegend: ILegendObj = {};
        for (let n = 1; n <= this.numplayers; n++) {
            myLegend["P" + n.toString() + "1"] = {
                name: "pyramid-up-small-upscaled",
                colour: n
            };
            myLegend["P" + n.toString() + "2"] = {
                name: "pyramid-up-medium-upscaled",
                colour: n
            };
            myLegend["P" + n.toString() + "3"] = {
                name: "pyramid-up-large-upscaled",
                colour: n
            };
        }

        // Build rep
        const rep: APRenderRep =  {
            board: {
                style: "squares-checkered",
                width: 8,
                height: 8
            },
            legend: myLegend,
            pieces: pstr
        };

	const areas = [];

        // Add captured stashes
        for (let player = 0; player < this.numplayers; player++) {
            if (this.captured[player].length > 0) {
                const node: ILocalStash = {
                    type: "localStash",
                    label: `Player ${player + 1}: Captured Pieces`,
                    stash: []
                };
                const org = this.organizeCaps((player + 1) as playerid);
                node.stash.push(...org.triosMono.map((s) => this.renderStashHelper(s)));
                node.stash.push(...org.triosMixed.map((s) => this.renderStashHelper(s)));
                node.stash.push(...org.partialsMono.map((s) => this.renderStashHelper(s)));
                node.stash.push(...org.partialsMixed.map((s) => this.renderStashHelper(s)));
                node.stash.push(...org.miscellaneous.map((s) => this.renderStashHelper([s])));
                areas.push(node);
            }
        }
        if (areas.length > 0) {
            rep.areas = areas;
        }


        // Add annotations
        if (this.stack[this.stack.length - 1]._results.length > 0) {
            rep.annotations = [];
            for (const move of this.stack[this.stack.length - 1]._results) {
                if (move.type === "place") {
                    const [toX, toY] = StawvsGame.algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", targets: [{row: toY, col: toX}]});
                } else if (move.type === "move") {
                    const [fromX, fromY] = StawvsGame.algebraic2coords(move.from);
                    const [toX, toY] = StawvsGame.algebraic2coords(move.to);
                    rep.annotations.push({type: "move", targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
                }
            }
            if (rep.annotations.length === 0) {
                delete rep.annotations;
            }
        }

        return rep;
    }

    public status(): string {
        let status = super.status();

        status += "**Stashes**\n\n";
        for (let n = 1; n <= this.numplayers; n++) {
            const stash = this.stashes.get(n as playerid);
            if ( (stash === undefined) || (stash.length !== 3) ) {
                throw new Error("Malformed stash.");
            }
            status += `Player ${n}: ${stash[0]} small, ${stash[1]} medium, ${stash[2]} large\n\n`;
        }

        status += "**Scores**\n\n";
        for (let n = 1; n <= this.numplayers; n++) {
            const score = this.scores[n - 1];
            const caps = this.caps[n - 1];
            status += `Player ${n}: ${score} (${caps} pieces)\n\n`;
        }

        return status;
    }

    public getPlayerStash(player: number): IStashEntry[] | undefined {
        const stash = this.stashes.get(player as playerid);
        if (stash !== undefined) {
            return [
                {count: stash[0], glyph: { name: "pyramid-up-small-upscaled",  colour: player }, movePart: "1"},
                {count: stash[1], glyph: { name: "pyramid-up-medium-upscaled", colour: player }, movePart: "2"},
                {count: stash[2], glyph: { name: "pyramid-up-large-upscaled",  colour: player }, movePart: "3"}
            ];
        }
        return;
    }

    public getPlayersScores(): IScores[] {
        return [{ name: i18next.t("apgames:status.SCORES"), scores: this.scores.map((s,i) => `${s} (${i18next.t("apgames:status.stawvs.NUMPIECES", {count: this.caps[i]})})`)}];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected getMoveList(): any[] {
        return this.getMovesAndResults(["move", "place", "pass", "winners", "eog", "deltaScore"]);
    }

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "move":
                node.push(i18next.t("apresults:MOVE.push", {what: r.what, from: r.from, to: r.to}));
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): StawvsGame {
        return new StawvsGame(this.serialize());
    }
}
