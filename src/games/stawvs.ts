import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
//import { RectGrid } from "../common";
import { APRenderRep, Glyph } from "@abstractplay/renderer/src/schemas/schema";
//import { Direction } from "../common";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, shuffle, UserFacingError } from "../common";
import { CartesianProduct } from "js-combinatorics";
import i18next from "i18next";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const clone = require("rfdc/default");

export type playerid = 1|2|3|4;
export type Mode = "place"|"collect";
export type Size = 1|2|3;
export type Colour = "VT"|"OG"|"BN"|"WH";
export type Pyramid = [Colour, Size];
export type CellContents = [Pyramid, playerid?];
const allColours: string[] = ["VT", "OG", "BN"];
const moreColours: string[] = ["VT", "OG", "BN", "WH"];
const pieceCount = 3; /* there's a variant of 2 for 4p */
const boardDim = 8; /* there's a pyramid-poor variant of 7 */
const triosPerColor = 5; /* in the pyramid-poor variant it's 4 */
const numberOfColors = 4; /* there's a stash-poor variant of 5 */

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
    triosMono: Pyramid[][];
    partialsMono: Pyramid[][];
    triosMixed: Pyramid[][];
    partialsMixed: Pyramid[][];
    miscellaneous: Pyramid[];
}

interface IMoveState extends IIndividualState {
    currplayer: playerid;
    mode: Mode;
    board: Map<string, CellContents>;
    lastmove?: string;
    scores: number[];
    caps: number[];
    captured: [Pyramid[], Pyramid[]];
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
        flags: ["scores", "autopass"]
    };

    public static coords2algebraic(x: number, y: number): string {
        return GameBase.coords2algebraic(x, y, boardDim);
    }
    public static algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, boardDim);
    }

    public numplayers!: number;
    public currplayer!: playerid;
    public mode!: Mode;
    public board!: Map<string, CellContents>;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public scores!: number[];
    public caps!: number[];
    public captured: [Pyramid[], Pyramid[]] = [[], []];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = []

    public static newBoard(): Map<string, CellContents> {
        const emptyCells: string[] = ["a1","a8","h1","h8"];
	//TODO: remove test code
        const testCells: string[] = []; //["a2","a3","b5","e8"]; 
        const board = new Map<string, CellContents>([]);
        let bag: Pyramid[] = [];
        for (let stash = 0; stash < triosPerColor; stash++) {
            for (let size = 1; size < numberOfColors; size++) {
                for (let c = 0; c < moreColours.length; c++) {
                    bag.push([moreColours[c], size] as Pyramid);   
                }
            }
        }
        const shuffled = shuffle(bag);
        for (let x = 0; x < boardDim; x++) {
            for (let y = 0; y < boardDim; y++) {
                const cell = StawvsGame.coords2algebraic(x, y);
                if (emptyCells.indexOf(cell) === -1) {
                    if (testCells.indexOf(cell) > -1)
                        board.set(cell, [shuffled.pop(), 1]);
                    else
                        board.set(cell, [shuffled.pop()]);
                }
            }
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
                mode: "place",
                board: StawvsGame.newBoard(),
                scores: [],
                caps: [],
                captured: [[], []],
            };
            if ( (variants !== undefined) && (variants.length === 1) && (variants[0] === "overloaded") ) {
                this.variants = ["overloaded"];
            }
            for (let pid = 1; pid <= state; pid++) {
                fresh.scores.push(0);
                fresh.caps.push(0);
            }
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IStawvsState;
            }
            if (state.game !== StawvsGame.gameinfo.uid) {
                throw new Error(`The Stawvs game code cannot process a game of '${state.game}'.`);
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
        this.mode = state.mode;
        this.board = new Map(state.board);
        this.lastmove = state.lastmove;
        this.scores = [...state.scores];
        this.captured = clone(state.captured) as [Pyramid[], Pyramid[]];
        this.caps = [...state.caps];
        return this;
    }

    public canFish(cellA: string, cellB: string): boolean {
	//The unobstructed straight line test for moves and claims.
	//Named for Hey, That's My Fish!
	if (cellA === cellB)
	    return false;
	//TODO
        return true;
    }

    public canPlace(cell: string): boolean {
        if (! this.board.has(cell)) {
            return false;
        }

        const contents = this.board.get(cell);
        if (contents === undefined) {
            throw new Error("Malformed cell contents.");
        }
        //const pyramid = contents[0];
        if (contents.length > 1) {
            return false;
        }

        return true;
    }

    public hasOwner(cell: string): boolean {
        if (! this.board.has(cell)) {
            return false;
        }

        const contents = this.board.get(cell);
        if (contents === undefined) {
            throw new Error("Malformed cell contents.");
        }

        if (contents.length > 1) {
            return true;
        }

        return false;
    }

    public getOwner(cell: string): playerid | undefined {
        if (! this.board.has(cell)) {
            return undefined;
        }

        const contents = this.board.get(cell);
	if (contents!.length > 1) {
            return contents![1];
        } else {
	    return undefined;
	}
    }

    public disown(cell: string) : void {
        if (! this.board.has(cell)) {
	    throw new Error("Illicit cell clearance.");
        }
	const contents = this.board.get(cell);
	this.board.set(cell,[contents![0]]);
	return;
    }

    public place(cell: string, owner: playerid): void {
        if (! this.board.has(cell)) {
	    throw new Error("Illegal cell placement.");
        }

        const contents = this.board.get(cell);
        if (contents === undefined) {
            throw new Error("Malformed cell contents.");
        }
        if (contents.length > 1) {
            throw new Error("Cell already claimed.");
        }

	const newContents: CellContents = [contents[0], owner];
	this.board.set(cell, newContents);
        return;
    }

    public moves(player?: playerid): string[] {
        if (this.gameover) {
            return [];
        }
        if (player === undefined) {
            player = this.currplayer;
        }

	const moves: string[] = [];
        if (this.mode === "place") {
            // If the player is placing pieces, enumerate the available pyramids.
            for (let row = 0; row < boardDim; row++) {
                for (let col = 0; col < boardDim; col++) {
                    const cell = StawvsGame.coords2algebraic(col, row);
                    if (this.canPlace(cell)) {
                        moves.push(cell);
                    }
                }
            }
        }

	//TODO: moves for collect mode.
        return moves;
    }

    public randomMove(): string {
        const moves = this.moves();
        return moves[Math.floor(Math.random() * moves.length)];
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
	console.log("In handleClick with move " + move);
        try {
            let newmove = "";
            const cell = StawvsGame.coords2algebraic(col, row);

	    if (this.mode === "place" || move === "")
		newmove = cell;
	    else if (move.indexOf(",") > -1) {
               //No more clicking, please
                return {
                    move,
                    valid: false,
                    message: i18next.t("apgames:validation.stawvs.EXTRA_CLAIMS")
                }
	    } else if (move.indexOf("-") > -1)
		newmove = `${move},${cell}`;
	    else
		newmove = `${move}-${cell}`;

            const result = this.validateMove(newmove) as IClickResult;
	    console.log("Result: ",result.valid,result );
            if (! result.valid) {
		//Revert latest addition to newmove.
                result.move = newmove.includes(",") ? newmove.split(",")[0] : (newmove.includes("-") ? newmove.split("-")[0] : "");
            } else {
                result.move = newmove;
            }
	    console.log("Revised result: ",result.valid,result );
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

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
	    if (this.mode === "place")
		result.message = i18next.t("apgames:validation.stawvs.INITIAL_PLACEMENT_INSTRUCTIONS")
	    else
		result.message = i18next.t("apgames:validation.stawvs.INITIAL_MOVE_INSTRUCTIONS")
            return result;
        }

        // check for "pass" first
        if (m === "pass") {
            if (this.mode === "place") {
                result.valid = false;
                result.message = i18next.t("apgames:validation.stawvs.PLACE_NOPASS")
                return result;
            } else {
		//TODO, pass checking, or just autopass?
                result.valid = true;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            }
        }

	//TODO: after place moves need more parsing.

	if (this.mode === "place") {
	    if (! this.canPlace(m)) {
		result.valid = false;
		result.message = i18next.t("apgames:validation.stawvs.BAD_PLACEMENT", {m});
		return result;
            } else {
		result.valid = true;
		result.complete = 1;
		result.message = i18next.t("apgames:validation.general.VALID_PLACEMENT");
		return result;
            }
	} //else

	//Parse the move into three cells.
	//The first must be occupied by currplayer.
	//The second must be in a straight (incl. diagonal), legal line from there.
	//The third must be in a straight legal line from the second.

	const cells = m.split("-");
	const cell0 = cells[0];
	if (!this.hasOwner(cell0) || this.getOwner(cell0) !== this.currplayer) {
	    result.valid = false;
	    result.message = i18next.t("apgames:validation.stawvs.BAD_START", {m});
	    return result;
	}

	if (cells.length === 1) { 
	    result.valid = true;
	    result.complete = -1;
	    result.message = i18next.t("apgames:validation.stawvs.PARTIAL_MOVE");
	    return result;
	}

	const [cell1,cell2] = cells[1].split(",");
	
	if (! this.canFish(cell0,cell1) ) {
	    result.valid = false;
	    result.message = i18next.t("apgames:validation.stawvs.BAD_MOVE");
	    return result;
	}

	if (! cell2) { 
	    result.valid = true;
	    result.complete = -1;
	    result.message = i18next.t("apgames:validation.stawvs.PARTIAL_CLAIM");
	    return result;
	}

	if (! this.canFish(cell1,cell2) ) {
	    result.valid = false;
	    result.message = i18next.t("apgames:validation.stawvs.BAD_CLAIM", {m});
	    return result;
	} else {
	    result.valid = true;
	    result.complete = 1;
	    result.message = i18next.t("apgames:validation.stawvs.VALID_PLAY");
	    return result;
	}
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
            // enact move
	    if (this.mode === "place") {
		const cell = m;
		if (this.canPlace(cell)) {
		    // place the piece
		    this.place(cell, this.currplayer); //board.set(cell, this.board.get(cell)!.push(this.currplayer));
		    this.results = [{type: "place", where: cell, who: this.currplayer}]
		}
            } else {
		const cells = m.split("-");
		const cell0 = cells[0];
		const [cell1,cell2] = cells[1].split(",");
		//1. Move piece
		this.disown(cell0);
		this.place(cell1,this.currplayer);
		//2. Claim target.
		//TODO
		//3. Remove target.
		this.board.delete(cell2);
	    }
        }

	// update mode if all pieces are placed.
	if (this.mode === "place" && this.checkPlaced()) {
	    this.mode = "collect";
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

    protected checkEOG(): StawvsGame {
        if ( (this.lastmove === "pass") && (this.stack.length >= this.numplayers) ) {
            const lastmoves = new Set<string>();
            lastmoves.add("pass");
            for (let p = 2; p <= this.numplayers; p++) {
                const state = this.stack[this.stack.length - (p - 1)];
                lastmoves.add(state.lastmove!);
            }
            if (lastmoves.size === 1) {
                this.gameover = true;
                const scores = this.getPlayersScores()[0].scores as number[];
                const max = Math.max(...scores);
                for (let p = 1; p <= this.numplayers; p++) {
                    if (scores[p-1] === max) {
                        this.winner.push(p as playerid);
                    }
                }
            }
        }

        if (this.gameover) {
            this.results.push(
                {type: "eog"},
                {type: "winners", players: [...this.winner]}
            );
        }

        return this;
    }

    public getPlayerScore(indata: number | IOrganizedCaps): number {
        //Strangely complex scoring algorithm from mega-volcano.
        //TODO: simplify.
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

    public checkPlaced(): boolean {
	let placements: number[] = Array(this.numplayers).fill(0);
        for (let row = 0; row < boardDim; row++) {
            for (let col = 0; col < boardDim; col++) {
                const cell = StawvsGame.coords2algebraic(col, row);
		const owner = this.getOwner(cell);
                if (owner) {
		    placements[owner as number - 1]++;
                }
            }
	}
	const total = Math.min(...placements);
	if (total > pieceCount) {
	    throw new Error("Too many pieces have been placed.");
	}
	return (total === pieceCount);
    }

    public organizeCaps(indata: playerid | Pyramid[] = 1): IOrganizedCaps {
        let pile: Pyramid[];
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
        const stacks: Pyramid[][] = [];

        const whites = pile.filter(x => x[0] === "WH");
        const lgs = pile.filter(x => x[1] === 3 && x[0] !== "WH");
        const mds = pile.filter(x => x[1] === 2 && x[0] !== "WH");
        const sms = pile.filter(x => x[1] === 1 && x[0] !== "WH");
        // Put each large in a stack and then look for a matching medium and small
        // This will find all monochrome trios
        while (lgs.length > 0) {
            const stack: Pyramid[] = [];
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
            const stack: Pyramid[] = [];
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
        // const pieces: Pyramid[] = stacks.reduce((accumulator, value) => accumulator.concat(value), []);
        // if (pieces.length !== pile.length) {
        //     throw new Error("Stack lengths don't match. This should never happen.");
        // }

        // Categorize each stack
        for (const stack of stacks) {
            if (stack.length === 3) {
                if ((new Set(stack.map(c => c[0]))).size === 1) {
                    org.triosMono.push(clone(stack) as Pyramid[]);
                } else {
                    org.triosMixed.push(clone(stack) as Pyramid[]);
                }
            } else if (stack.length === 2) {
                if ((new Set(stack.map(c => c[0]))).size === 1) {
                    org.partialsMono.push(clone(stack) as Pyramid[]);
                } else {
                    org.partialsMixed.push(clone(stack) as Pyramid[]);
                }
            } else {
                org.miscellaneous.push(...clone(stack) as Pyramid[]);
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
                const newpieces: Pyramid[] = [];
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
            mode: this.mode,
            lastmove: this.lastmove,
            board: new Map(this.board),
            scores: [...this.scores],
            caps: [...this.caps],
	    captured: clone(this.captured) as [Pyramid[], Pyramid[]]
        };
    }

    private renderStashHelper(s: Pyramid[]): string[] {
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
        // Arrays of pieces in the style of Tritium.
        // Flat pyramids in the style of Blam!
        // Build piece string
        let pstr: string[][][] = [];
        for (let row = 0; row < boardDim; row++) {
            const pieces: string[][] = [];
            for (let col = 0; col < boardDim; col++) {
                const piece: string[] = [];
                const cell = StawvsGame.coords2algebraic(col, row);
                if (this.board.has(cell)) {
                    const contents = this.board.get(cell);
                    if (contents === undefined) {
                        throw new Error("Malformed cell contents.");
                    }
                    const pyramid = contents[0];
                    piece.push(pyramid[0].toString() + pyramid[1].toString());
                    if (contents.length > 1)
                        piece.push("P" + contents[1]!.toString());
                }
                pieces.push(piece);
            }
            pstr.push(pieces);
        }

        // build legend 
        const myLegend: ILegendObj = {};
        for (let c = 0; c < moreColours.length; c++) {
            // Use lighter colors from the end of the palette.
            let color = c + 8;
            myLegend[moreColours[c] as String + "1"] = {
                name: "pyramid-up-small-upscaled",
                colour: color
            };
            myLegend[moreColours[c].toString() + "2"] = {
                name: "pyramid-up-medium-upscaled",
                colour: color
            };
            myLegend[moreColours[c].toString() + "3"] = {
                name: "pyramid-up-large-upscaled",
                colour: color
            };
        }
        for (let p = 0; p < this.numplayers; p++) {
            let color = p + 1;
            myLegend["P" + color] = {
                name: "piece",
                scale: 0.3,
                colour: color,
            };
        }

        // Build rep
        const rep: APRenderRep =  {
            board: {
                style: "squares-checkered",
                width: boardDim,
                height: boardDim
            },
            legend: myLegend,
            pieces: pstr as [string[][], ...string[][][]],
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

        status += "**Scores**\n\n";
        for (let n = 1; n <= this.numplayers; n++) {
            const score = this.scores[n - 1];
            const caps = this.caps[n - 1];
            status += `Player ${n}: ${score} (${caps} pieces)\n\n`;
        }

        return status;
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
