import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaPieces, Colourfuncs, Glyph, MarkerGlyph, MarkerOutline } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";
import { Card, Deck, cardsBasic, cardsExtended, suits } from "../common/decktet";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2;
export type Mode = "place"|"collect";
export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";
export type location = [number, number];

const suitOrder = ["M","S","V","L","Y","K"];
const crowdedRanks = ["Pawn","Court"];
const rows = 6;
const columns = 7;

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    mode: Mode;
    board: Map<string, string>;
    market: string[];
    occupied: Map<string, playerid>;
    collected: [number[], number[]];
    lastmove?: string;
    eliminated?: playerid;
};

export interface IDeckfishState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

interface ILegendObj {
    [key: string]: Glyph|[Glyph, ...Glyph[]];
}

export class DeckfishGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Deckfish",
        uid: "deckfish",
        playercounts: [2],
        version: "20250715",
        dateAdded: "2025-07-15",
        // i18next.t("apgames:descriptions.deckfish")
        description: "apgames:descriptions.deckfish",
        // i18next.t("apgames:notes.deckfish")
        notes: "apgames:notes.deckfish",
        urls: [
            "http://wiki.decktet.com/game:deckfish",
            "https://boardgamegeek.com/boardgame/432405/deckfish",
        ],
        people: [
            {
                type: "designer",
                name: "Alfonso Velasco (Donegal)",
                urls: [],
                apid: "7dbbcf14-42b8-4b4a-87aa-17c35b9852f4",
            },
            {
                type: "coder",
                name: "mcd",
                urls: ["https://mcdemarco.net/games/"],
                apid: "4bd8317d-fb04-435f-89e0-2557c3f2e66c",
            },
        ],
        categories: ["goal>score>eog", "mechanic>move", "mechanic>place", "mechanic>random>setup", "mechanic>set", "board>shape>rect", "board>connect>rect", "components>decktet"],
        flags: ["scores", "random-start", "custom-randomization", "autopass", "experimental"],
    };
    public static coords2algebraic(x: number, y: number): string {
        return GameBase.coords2algebraic(x, y, rows);
    }
    public static algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, rows);
    }
    public loc2algebraic(loc: location): string {
        return DeckfishGame.coords2algebraic(loc[0], loc[1]);
    }
    public algebraic2loc(cell: string): location {
        return DeckfishGame.algebraic2coords(cell);
    }
    public coord2algebraic(m: number): string {
        return "m" + (m + 1);
    }
    public algebraic2coord(cell: string): number {
        return parseInt(cell.substring(1),10) - 1;
    }

    public numplayers = 2;
    public currplayer: playerid = 1;
    public mode!: Mode;
    public board!: Map<string, string>;
    public market!: string[];
    public occupied!: Map<string, playerid>;
    public collected!: [number[], number[]];
    public eliminated?: playerid;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    private highlights: string[] = [];
    private tableau: number[][] = new Array(columns).fill(-1).map(() => 
        new Array(rows).fill(-1));

    constructor(state?: IDeckfishState | string) {
        super();
        if (state === undefined) {

            // init deck
            const cards = [...cardsBasic, ...cardsExtended];

            const deck = new Deck(cards);
            deck.shuffle();

            // init board
            const board = new Map<string, string>();

            for (let x = 0; x < columns; x++) {
                for (let y = 0; y < rows; y++) {
                    const cell = DeckfishGame.coords2algebraic(x, y);
                    if (!board.has(cell)) {
                        const [card] = deck.draw();
                        board.set(cell, card.uid);
                    }
                }
            }

            const market = new Array<string>();
            for (let m = 0; m < 3; m++) {
                const [card] = deck.draw();
                market.push(card.uid);
            }
 
            // init positions
            const occupied = new Map<string, playerid>();
            const mode = "place";

            const fresh: IMoveState = {
                _version: DeckfishGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                mode,
                board,
                market,
                occupied,
                collected: [[0,0,0,0,0,0],[0,0,0,0,0,0]],
            };
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IDeckfishState;
            }
            if (state.game !== DeckfishGame.gameinfo.uid) {
                throw new Error(`The Deckfish engine cannot process a game of '${state.game}'.`);
            }
            this.numplayers = state.numplayers;
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.stack = [...state.stack];
        }
        this.load();
    }

    public load(idx = -1): DeckfishGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if ( (idx < 0) || (idx >= this.stack.length) ) {
            throw new Error("Could not load the requested state from the stack.");
        }

        const state = this.stack[idx];
        this.results = [...state._results];
        this.currplayer = state.currplayer;
        this.mode = state.mode;
        this.board = new Map(state.board);
        this.market = [...state.market];
        this.occupied = new Map(state.occupied);
        this.collected = [[...state.collected[0]], [...state.collected[1]]];
        this.lastmove = state.lastmove;
        this.eliminated = state.eliminated;

        if (this.mode === "collect")
            this.populateTableau();
        console.log(this.tableau);

        return this;
    }

    /* helper functions for general gameplay */

    public canMoveFrom(cell: string): boolean {
        if (this.occupied.has(cell) && this.occupied.get(cell) === this.currplayer)
            return true;
        else
            return false;
    }

    public canMoveTo(cell: string): boolean {
        //This is going to get complicated.
        //For now just check one thing for a placeholder.
        if (! this.board.has(cell)) {
            //Cannot land in the gaps.
            return false;
        } else {
            const card = Card.deserialize(this.board.get(cell)!)!;
            //Cannot land on the Excuse.
            if (card.rank.name === "Excuse")
                return false;
        }
        return true;
    }

    public canPlace(cell: string): boolean {
        console.log("Can place at " + cell + "?");
        if (this.occupied.has(cell)) {
            return false;
        }
        if (this.board.has(cell)) {
            const card = Card.deserialize(this.board.get(cell)!)!;
            if (card.rank.name === "Ace" || card.rank.name === "Crown") {
                return true;
            } else
                return false;
        } else
            return false;
    }

    public canSwap(cell: string, market: string): boolean {
        return true;
    }

    /* end helper functions for general gameplay */

    /* suit-based movement logic */

    private populateTableau(): void {
        //Abstract the data structure to only what is needed for movement.
        for (let x = 0; x < columns; x++) {
            for (let y = 0; y < rows; y++) {
                //The tableau was initialized to all -1's (gaps).  
                const cell = DeckfishGame.coords2algebraic(x, y);
                if (this.board.has(cell)) {
                    // Revise card spaces: 2 is occupied, 1 is unoccupied, 0 is the Excuse.
                    if (this.occupied.has(cell)) {
                        //The card is occupied by a piece.
                        this.tableau[x][y] = 2;
                    } else {
                        //There's an unoccupied card.
                        const card = Card.deserialize(this.board.get(cell)!)!;
                        //Check for excuse.
                        if (card.rank.name === "Excuse")
                            this.tableau[x][y] = 0;
                        else
                            this.tableau[x][y] = 1;
                    }
                }
            }
        }
    }

    private checkLocation(loc: location): boolean {
        //...is on the board, for movement math.
        if (loc[0] < 0 || loc[1] < 0 || loc[0] >= rows || loc[1] >= columns)
            return false;
        else
            return true;
    }

    private assembleTargets(meepleLoc: location, suits: string[]): location[] {
        const targets = this.collectTargets(meepleLoc,suits);
        const filteredTargets = targets.filter(t => this.tableau[t[0]][t[1]] > 0);
        return filteredTargets;
    }

    private collectTargets(meepleLoc: location, suits: string[]): location[] {
        const orthoSuits = ["Moons","Waves","Leaves","Wyrms"];

        //get targets
        let myTargets: location[] = [];
        if (suits.includes('Suns'))
            myTargets = myTargets.concat(this.collectSunTargets(meepleLoc));
        if (suits.includes('Knots'))      
            myTargets = myTargets.concat(this.collectKnotTargets(meepleLoc));
        if (suits.filter(s => orthoSuits.indexOf(s) > -1).length > 0)
            myTargets = myTargets.concat(this.collectOrthogonalTargets(meepleLoc));

        return myTargets;
    }

    private collectKnotTargets(meepleLoc: location): location[] {
        console.log("Collecting knot targets...",-3);
        let meepleRow = meepleLoc[0];
        let meepleCol = meepleLoc[1];
        let targets: location[] = [];
        
        //Straight lines.
        if (this.checkLocation([meepleRow,meepleCol - 3]))
            targets.push([meepleRow,meepleCol - 3]);
        if (this.checkLocation([meepleRow,meepleCol + 3]))
            targets.push([meepleRow,meepleCol + 3]);
        
        if (this.checkLocation([meepleRow - 3,meepleCol]))
            targets.push([meepleRow - 3,meepleCol]);
        if (this.checkLocation([meepleRow + 3,meepleCol]))
            targets.push([meepleRow + 3,meepleCol]);
        
        //Around almost a circle.
        if (this.checkLocation([meepleRow,meepleCol - 1]))
            targets.push([meepleRow,meepleCol - 1]);
        if (this.checkLocation([meepleRow,meepleCol + 1]))
            targets.push([meepleRow,meepleCol + 1]);
        
        if (this.checkLocation([meepleRow - 1,meepleCol]))
            targets.push([meepleRow - 1,meepleCol]);
        if (this.checkLocation([meepleRow + 1,meepleCol]))
            targets.push([meepleRow + 1,meepleCol]);
        
        //Zig-zagging.
        if (this.checkLocation([meepleRow - 1,meepleCol - 2]))
            targets.push([meepleRow - 1,meepleCol - 2]);
        if (this.checkLocation([meepleRow + 1,meepleCol - 2]))
            targets.push([meepleRow + 1,meepleCol - 2]);
        
        if (this.checkLocation([meepleRow - 1,meepleCol + 2]))
            targets.push([meepleRow - 1,meepleCol + 2]);
        if (this.checkLocation([meepleRow + 1,meepleCol + 2]))
            targets.push([meepleRow + 1,meepleCol + 2]);
        
        if (this.checkLocation([meepleRow - 2,meepleCol - 1]))
            targets.push([meepleRow - 2,meepleCol - 1]);
        if (this.checkLocation([meepleRow - 2,meepleCol + 1]))
            targets.push([meepleRow - 2,meepleCol + 1]);
        
        if (this.checkLocation([meepleRow + 2,meepleCol - 1]))
            targets.push([meepleRow + 2,meepleCol - 1]);
        if (this.checkLocation([meepleRow + 2,meepleCol + 1]))
            targets.push([meepleRow + 2,meepleCol + 1]);
        
        return targets;
    }

    private collectOrthogonalTargets(meepleLoc: location): location[] {
        let targets: location[] = [];
        
        for (let r=0; r < rows; r++) {
            if (r != meepleLoc[0]) 
                targets.push([r,meepleLoc[1]]);
        }
        
        for (let c=0; c < columns; c++) {
            if (c != meepleLoc[1]) 
                targets.push([meepleLoc[0],c]);
        }
        
        return targets;
    }

    private collectSunTargets(meepleLoc: location): location[] {
        let meepleRow = meepleLoc[0];
        let meepleCol = meepleLoc[1];
        let targets: location[] = [];
        
        //If the first space diagonally is off the board, the second will be, too.
        if (this.checkLocation([meepleRow - 1,meepleCol - 1])) {
            targets.push([meepleRow - 1,meepleCol - 1]);
            if (this.checkLocation([meepleRow - 2,meepleCol - 2])) {
                targets.push([meepleRow - 2,meepleCol - 2]);
            }
        }
        if (this.checkLocation([meepleRow - 1,meepleCol + 1])) {
            targets.push([meepleRow - 1,meepleCol + 1]);
            if (this.checkLocation([meepleRow - 2,meepleCol + 2]))
                targets.push([meepleRow - 2,meepleCol + 2]);
        }
        if (this.checkLocation([meepleRow + 1,meepleCol + 1])) {
            targets.push([meepleRow + 1,meepleCol + 1]);
            if (this.checkLocation([meepleRow + 2,meepleCol + 2]))
                targets.push([meepleRow + 2,meepleCol + 2]);
        }
        if (this.checkLocation([meepleRow + 1,meepleCol - 1])) {
            targets.push([meepleRow + 1,meepleCol - 1]);
            if (this.checkLocation([meepleRow + 2,meepleCol - 2]))
                targets.push([meepleRow + 2,meepleCol - 2]);
        }
        
        return targets;
    }

    /* end suit movement logic */

    public moves(player?: playerid): string[] {
        if (this.gameover) {
            return [];
        }

        if (player === undefined) {
            player = this.currplayer;
        }

        if (this.mode === "place" && this.occupied.size === 6) {
            return ["pass"];
        }

        const moves: string[] = [];

        // if placing
        if (this.mode === "place") {
            //push all unoccupied aces and crown on the board
            for (let x = 0; x < columns; x++) {
                for (let y = 0; y < rows; y++) {
                    const cell = DeckfishGame.coords2algebraic(x, y);
                    if (this.board.has(cell) && ! this.occupied.has(cell)) {
                        //There's an unoccupied card.
                        const card = Card.deserialize(this.board.get(cell)!)!;
                        //Check rank.
                        if (card.rank.name === "Ace" || card.rank.name === "Crown") {
                            moves.push(`${cell}`);
                        }
                    }
                }
            }
        }
        // otherwise collecting
        else {
            this.occupied.forEach((value, cell) => {
                if (value === this.currplayer) {
                    //push all other card cells in row and column
                    const meepleLoc = this.algebraic2loc(cell);
                    const card = Card.deserialize(this.board.get(cell)!)!;
                    const suits = card.suits.map(s => s.name);
                    const targets = this.assembleTargets(meepleLoc,suits);
                    targets.forEach(t => {
                        moves.push(cell + "-" + this.loc2algebraic(t))
                    });
                }
            });
        }

        if (moves.length === 0) {
            moves.push("pass");
        }
        return moves.sort((a,b) => a.localeCompare(b));
    }

    public randomMove(): string {
        const moves = this.moves();
        return moves[Math.floor(Math.random() * moves.length)];
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            let newmove = "";
            // clicking on the market
            if (row < 0 && col < 0) {
                if (! move.includes("-")) {
                    //it's too early to click on the market.
                    //TODO: invalid partial result
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.deckfish.EARLY_TO_MARKET")
                    }
                } else {
                    newmove = `${move},` + this.coord2algebraic(this.market.indexOf(piece!.substring(1)));
                }
            }
            // otherwise, clicked on the board
            else {
                const cell = DeckfishGame.coords2algebraic(col, row);
                // continuation of placement
                if (this.mode === "place") {
                    //Selecting initial placement location.
                    newmove = `${cell}`;
                } else if (move.includes(",") || (move && ! move.includes("-"))) {
                    newmove = `${move}-${cell}`;
                } else {
                    //Selecting initial source location.
                    newmove = `${cell}`;
                }
            }

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

        //m = m.toLowerCase();
        m = m.replace(/\s+/g, "");

        console.log("Validating move " + m);

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            if (this.mode === "place") {
                result.message = i18next.t("apgames:validation.deckfish.INITIAL_PLACEMENT_INSTRUCTIONS")
            } else {
                result.message = i18next.t("apgames:validation.deckfish.INITIAL_MOVE_INSTRUCTIONS")
            }
            return result;
        }

        if (m === "pass") {
            if (this.mode === "place") {
                if (this.occupied.size === 6) {
                    //The "pie"-style pass.
                    result.valid = true;
                    result.complete = 1;
                    result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                    return result;
                } else {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.deckfish.BAD_PASS");
                    return result;
                }
            } else {
                if (this.moves().includes(m)) {
                    //The end of game passes.
                    result.valid = true;
                    result.complete = 1;
                    result.message = i18next.t("apgames:validation._general.VAILD_MOVE");
                    return result;
                } else {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.deckfish.BAD_PASS");
                    return result;
                }
            }
        }

        const [mv, sw] = m.split(",");
        // eslint-disable-next-line prefer-const
        let [from, to] = mv.split("-");
        //card = card.toUpperCase();

        //Testing placements.
        if (this.mode === "place") {
            if (this.canPlace(from)) {
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation.deckfish.VALID_PLACEMENT");
            } else {
                result.valid = false;
                result.message = i18next.t("apgames:validation.deckfish.INVALID_PLACEMENT");
            }
            return result;
        } 
        //Otherwise, collecting.

        // if `to` is missing, partial
        if (to === undefined || to.length === 0) {
            if (this.canMoveFrom(from)) {
                result.valid = true;
                result.complete = -1;
                result.canrender = true;
                result.message = i18next.t("apgames:validation.deckfish.PARTIAL_MOVE");
                return result;
            } else {
                result.valid = false;
                result.message = i18next.t("apgames:validation.deckfish.INVALID_FROM");
                return result;
            }
        }

        //Otherwise, evaluate the move destination.
        if (! this.canMoveTo(to)) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.deckfish.INVALID_TO", {cell: to});
            return result;
        }

        //Now, swapping.

        // if `sw` is missing, possibly partial
        if (sw === undefined || sw.length === 0) {
            result.valid = true;
            result.complete = 0;
            result.message = i18next.t("apgames:validation.deckfish.INITIAL_SWAP_INSTRUCTIONS");
            return result;
 
        } else {

            //otherwise
            let [mark, swap] = sw.split("-");

            //A successful market choice is always valid. 
            //Need to check the click?
            const marketCard = this.market[this.algebraic2coord(mark)];

            // if swap is missing, may or not be complete
            if (swap === undefined || swap.length === 0) {
                result.valid = true;
                result.canrender = true;
                result.complete = -1;
                result.message = i18next.t("apgames:validation.deckfish.PARTIAL_SWAP", {what: marketCard, where: mark});
                return result;
            }
            // otherwise the swap location needs testing.
            else if (! this.board.has(swap)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.deckfish.NO_SWAP", {cell: swap});
                return result;
            } else if (this.occupied.has(swap)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation._general.OCCUPIED_SWAP", {cell: swap});
                return result;
            } else {

                // we're good!
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;

            }
        }
    }

    public move(m: string, {trusted = false, partial = false, emulation = false} = {}): DeckfishGame {
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }

        //m = m.toLowerCase();
        m = m.replace(/\s+/g, "");
        if (! trusted) {
            const result = this.validateMove(m);
            if (! result.valid) {
                throw new UserFacingError("VALIDATION_GENERAL", result.message)
            }
        }

        this.results = [];
        this.highlights = [];

        if (m === "pass") {
            if (this.mode === "place") {
                this.results.push({type: "pie"});
                //change the mode.
                this.mode = "collect";
            } else {
                this.results.push({type: "pass"});
                //eliminate the player.
                if (!this.eliminated) {
                    this.eliminated = this.currplayer;
                    this.results.push({type: "announce", payload: []})
                }
            }

        } else {

            const [mv, sw] = m.split(",");
            // eslint-disable-next-line prefer-const
            let [from, to] = mv.split("-");
 
            const card = Card.deserialize(this.board.get(from)!)!;
            if (card === undefined)
                throw new Error(`Could not load the card at ${from}.`);

            this.highlights.push(card.uid);
           
            if (to !== undefined && to.length > 0) {
                //Remove the card.
 
                this.highlights.push(card.uid);
                if (!partial)
                    this.board.delete(from);

                //Move the piece.
                this.occupied.delete(from);
                this.occupied.set(to, this.currplayer);
                //In the wyrms/bounce case, must also move the other piece.
                //TODO
                
                //Score the card.
                const newSuits = card.suits.map(s => s.uid as Suit);
                newSuits.forEach(s => {
                    this.collected[this.currplayer - 1][suitOrder.indexOf(s)]++;
                })
                
                this.results.push({type: "move", from: from, to: to, what: card.uid});

                if (sw !== undefined && sw.length > 0) {
                    let [marketCell, swapCell] = sw.split("-");
                    //highlight market card
                    const marketCard = this.market[this.algebraic2coord(marketCell)];
                    this.highlights.push(marketCard);

                    if (swapCell !== undefined && swapCell.length > 0) {
                        //swap market card
                        const swapCard = this.board.get(swapCell)!;
                        this.highlights.push(swapCard);
                        this.market[this.market.indexOf(marketCard)] = swapCard!;
                        this.board.set(swapCell, marketCard);
                        this.results.push({type: "swap", what: marketCard, with: swapCard, where: swapCell});
                    } else {
                        //TODO
                    }
                }
            } else {
                if (this.mode === "place") {
                    this.occupied.set(from, this.currplayer);
                    this.results.push({type: "place", where: from});
                } else {
                    //Partial move already illustrated, though a bit flakily.
                }
            }   
        }

        if (partial) { return this; }

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

    protected checkEOG(): DeckfishGame {
        if (this.lastmove === "pass" && this.eliminated == this.currplayer) {
            this.gameover = true;
            const scores: number[] = [];
            for (let p = 1; p <= this.numplayers; p++) {
                scores.push(this.getPlayerScore(p));
            }
            if (scores[0] === scores[1]) {
                //Evaluate tiebreaker.
                console.log("tiebroken win");
                this.winner = this.getTieWinner();
            } else {
                //Simple win.
                console.log("simple win");
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

    public state(opts?: {strip?: boolean, player?: number}): IDeckfishState {
        const state: IDeckfishState = {
            game: DeckfishGame.gameinfo.uid,
            numplayers: this.numplayers,
            variants: this.variants,
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack]
        };
        if (opts !== undefined && opts.strip) {
            state.stack = state.stack.map(mstate => {
                for (let p = 1; p <= this.numplayers; p++) {
                    if (p === opts.player) { continue; }
                }
                return mstate;
            });
        }
        return state;
    }

    public moveState(): IMoveState {
        return {
            _version: DeckfishGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            mode: this.mode,
            lastmove: this.lastmove,
            eliminated: this.eliminated,
            board: new Map(this.board),
            market: [...this.market],
            occupied: new Map(this.occupied),
            collected: [[...this.collected[0]],[...this.collected[1]]],
        };
    }

    private makeMeeple(opts: {colour?: string|number|Colourfuncs, opacity?: number, adjust?: boolean} = {}): [Glyph, ...Glyph[]] {
        //Build the pieces that we're not calling pawns (because that's a card)
        //or illustrating with meeples (because they looked too busy).
        let opacity = 1;
        if (opts !== undefined && opts.opacity !== undefined) {
            opacity = opts.opacity;
        }
        let colour: string|number|Colourfuncs|undefined;
        if (opts !== undefined && opts.colour !== undefined) {
            colour = opts.colour;
        }
        let adjust = false;
        if (opts !== undefined && opts.adjust !== undefined) {
            adjust = opts.adjust;
        }
        const dy: number = adjust ? -280 : 280;

        const glyph: [Glyph, ...Glyph[]] = [
            {
                name: "piece-square-borderless",
                scale: 1,
                colour: colour,
                opacity: 0,
            },
        ];
        glyph.push({
            name: "ring-13",
            scale: 0.55,
            opacity: opacity === undefined ? 1 : opacity,
            colour: colour, 
            nudge: {
                dx: 280,
                dy: dy,
            }
        });
        return glyph;
    }

    public render(): APRenderRep {
        // Build piece string
        let pstr = "";
        for (let row = 0; row < rows; row++) {
            if (pstr.length > 0) {
                pstr += "\n";
            }
            const pieces: string[] = [];
            for (let col = 0; col < columns; col++) {
                const cell = DeckfishGame.coords2algebraic(col, row);
                if (this.occupied.has(cell)) {
                    const card = Card.deserialize(this.board.get(cell)!)!;
                    const adjust = crowdedRanks.includes(card.rank.name) ? "H" : "";
                    pieces.push(this.occupied.get(cell) === 1 ? "A" + adjust : "B" + adjust);
                } else {
                    pieces.push("-");
                }
            }
            pstr += pieces.join(",");
        }
        // build card markers
        let markers: (MarkerOutline|MarkerGlyph)[]|undefined;
        markers = [];
        if (this.board.size > 0) {
            for (const [cell, c] of this.board.entries()) {
                const [x,y] = DeckfishGame.algebraic2coords(cell);
                const card = Card.deserialize(c)!;

                markers.push({
                    type: "glyph",
                    glyph: "c" + card.uid,
                    points: [{row: y, col: x}],
                });
            }
        }

        // build legend of ALL cards
        const allcards = [...cardsBasic, ...cardsExtended];

        const legend: ILegendObj = {};
        
        let lastMarketCard = "";
        if (this.highlights.length === 0 && this.lastmove  && this.lastmove.length > 0) {
            const lastMarketCell = this.lastmove!.split(/\W+/).find((elt) => elt[0] == "m");
            if (lastMarketCell)
                lastMarketCard = this.market[this.algebraic2coord(lastMarketCell!)];
        }

        for (const card of allcards) {
            if (this.highlights.indexOf(card.uid) > -1 || card.uid == lastMarketCard) {
                legend["c" + card.uid] = card.toGlyph({border: true});
            } else
            legend["c" + card.uid] = card.toGlyph({border: false});
        }
        for (const suit of suits) {
            legend[suit.uid] = {
                name: suit.glyph!,
                scale: 0.5
            }
        }
        legend["A"] = this.makeMeeple({
            colour: 1,
        });
        legend["AH"] = this.makeMeeple({
            colour: 1,
            adjust: true,
        });
        legend["B"] = this.makeMeeple({
            colour: 2,
        });
        legend["BH"] = this.makeMeeple({
            colour: 2,
            adjust: true,
        });

        // build pieces areas
        const areas: AreaPieces[] = [];

        //market
        if (this.market.length > 0) {
            const marketCards = this.market.map(uid => Card.deserialize(uid)!).map(c => "c" + c.uid) as [string, ...string[]];

            areas.push({
                type: "pieces",
                label: i18next.t("apgames:validation.deckfish.LABEL_MARKET") || "Market cards",
                spacing: 0.25,
                pieces: marketCards,
                width: 3,
            });
        }

        // suits
        for (let p = 1; p <= this.numplayers; p++) {
            let captive = this.collected[p-1].reduce((partialSum, a) => partialSum + a, 0);
            if (captive > 0) {
                let captives: string[] = [];
                this.collected[p-1].forEach((cnt,idx) => {
                    if (cnt > 0) {
                        for (let c = 0; c<cnt; c++) 
                            captives.push(suitOrder[idx]);
                    }
                });
                areas.push({
                    type: "pieces",
                    pieces: captives as [string, ...string[]],
                    label: i18next.t("apgames:validation.deckfish.LABEL_COLLECTION", {playerNum: p}) || `P${p} suits`,
                    spacing: -0.25,
                    ownerMark: p,
                    width: 16,
                });
            }
        }

        // Build rep
        const rep: APRenderRep =  {
            board: {
                style: "squares",
                width: 7,
                height: 6,
                tileHeight: 1,
                tileWidth: 1,
                tileSpacing: 0.25,
                strokeOpacity: 0.2,
                labelColour: "#888",
                markers,
            },
            legend,
            pieces: pstr,
            areas,
        };

        // Add annotations
        if (this.results.length > 0) {
            rep.annotations = [];
            for (const move of this.results) {
                if (move.type === "place") {
                    const [x, y] = DeckfishGame.algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", occlude: false, dashed: [6,8], targets: [{row: y, col: x}]});
                } else if (move.type === "move") {
                    const [fromX, fromY] = DeckfishGame.algebraic2coords(move.from);
                    const [toX, toY] = DeckfishGame.algebraic2coords(move.to);
                    rep.annotations.push({type: "move", targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
                    rep.annotations.push({type: "enter", occlude: false, targets: [{row: toY, col: toX}]});
                } else if (move.type === "swap") {
                    const [x, y] = DeckfishGame.algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", occlude: false, dashed: [2,4], targets: [{row: y, col: x}]});
                }
            }
        }

        return rep;
    }

    /* scoring functions */

    private getTieWinner(): playerid[] {
        //Evaluate tiebreaker.
        let tieWinner: playerid[] = [];
        const sortedArrays = this.collected.map(collection => collection.slice().sort());

        console.log("Sort:" + sortedArrays[0] + "; " + sortedArrays[1]);

        const winArray = sortedArrays[0].map((item, index) => item - (sortedArrays[1])[index]).filter((item) => item !== 0);

        console.log("Subtract:" + winArray);

        if (winArray.length === 0) {
            tieWinner = [1,2] as playerid[];
        } else {
            tieWinner.push((winArray[0] > 0 ? 1 : 2) as playerid);
        }
        return tieWinner;
    } 

    public getPlayerScore(player: number): number {
        //gets min of suits
        const score = this.collected[player - 1].slice().sort()[0];
        return score;
    }

    public getPlayersScores(): IScores[] {
        const scores: number[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            scores.push(this.getPlayerScore(p));
        }
        return [
            { name: i18next.t("apgames:status.SCORES"), scores},
        ];
    }

    /* end scoring functions */

    public getStartingPosition(): string {
        const pcs: string[] = [];
        const board = this.stack[0].board;
        const market = this.stack[0].market;
        for (let x = 0; x < columns; x++) {
            for (let y = 0; y < rows; y++) {
                const cell = DeckfishGame.coords2algebraic(x, y);
                if (board.has(cell)) {
                    pcs.push(board.get(cell)!);
                }
            }
            pcs.push("/")
        }

        pcs.push("/");
        market.map(m => pcs.push(m));

        return pcs.join(",");
    }

    public status(): string {
        let status = super.status();

        status += "**Scores**: " + this.getPlayersScores()[0].scores.join(", ") + "\n\n";

        return status;
    }

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "place":
                node.push(i18next.t("apresults:PLACE.deckfish", {player, where: r.where}));
                resolved = true;
                break;
            case "pie":
                node.push(i18next.t("apresults:PIE.deckfish", {player}));
                resolved = true;
                break;
            case "move":
                node.push(i18next.t("apresults:MOVE.deckfish", {player, from: r.from, to: r.to, what: r.what}));
                resolved = true;
                break;
            case "swap":
                node.push(i18next.t("apresults:SWAP.deckfish", {player, what: r.what, with: r.with, where: r.where}));
                resolved = true;
                break;
            case "pass":
                node.push(i18next.t("apresults:PASS.simple", {player}));
                resolved = true;
                break;
            case "announce":
                node.push(i18next.t("apresults:ANNOUNCE.deckfish", {player, payload: r.payload}));
                resolved = true;
                break;
            case "eog":
                node.push(i18next.t("apresults:EOG.deckfish", {player}));
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): DeckfishGame {
        return Object.assign(new DeckfishGame(), deepclone(this) as DeckfishGame);
    }
}
