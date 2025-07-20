import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaPieces, Glyph, MarkerFlood, MarkerOutline } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";
import { Card, Deck, cardsBasic, cardsExtended, suits } from "../common/decktet";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2;
export type Mode = "place"|"collect";
export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";
const suitOrder = ["M","S","V","L","Y","K"];

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    mode: Mode;
    board: Map<string, string>;
    market: string[];
    occupied: Map<string, playerid>;
    collected: [Suit[], Suit[]];
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
        return GameBase.coords2algebraic(x, y, 6);
    }
    public static algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, 6);
    }

    public numplayers = 2;
    public currplayer: playerid = 1;
    public mode!: Mode;
    public board!: Map<string, string>;
    public market!: string[];
    public occupied!: Map<string, playerid>;
    public collected!: [Suit[], Suit[]];
    public eliminated?: playerid;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    private highlights: string[] = [];

    constructor(state?: IDeckfishState | string) {
        super();
        if (state === undefined) {

            // init deck
            const cards = [...cardsBasic, ...cardsExtended];

            const deck = new Deck(cards);
            deck.shuffle();

            // init board
            const board = new Map<string, string>();

            for (let x = 0; x < 7; x++) {
                for (let y = 0; y < 6; y++) {
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
                collected: [[],[]],
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

        return this;
    }

    public canMoveFrom(cell: string): boolean {
        if (this.occupied.has(cell) && this.occupied.get(cell) === this.currplayer) {
            return true;
        } else
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
            for (let x = 0; x < 7; x++) {
                for (let y = 0; y < 6; y++) {
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
            this.occupied.forEach((value, key) => {
                if (value === this.currplayer) {
                    //push all other card cells in row and column
                    const [sx, sy] = DeckfishGame.algebraic2coords(key);
                    for (let x = 0; x < 7; x++) {
                        for (let y = 0; y < 6; y++) {
                            if ((sx === x && sy !== y) || (sy == y && sx !== x)) {
                                const cell = DeckfishGame.coords2algebraic(x, y);
                                if (this.board.has(cell) && ! this.occupied.has(cell)) {
                                    //TODO: Some moves to player-occupied cards are possible.

                                    const card = Card.deserialize(this.board.get(cell)!)!;
                                    if (card.rank.name !== "Excuse") {
                                        moves.push(`${key}-${cell}`);
                                    }
                                }
                            } else {
                                //TODO: knot moves
                            }
                        }
                    }
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
                    newmove = `${move},` + piece!.substring(1);
                }
            }
            // otherwise, on the board
            else {
                const cell = DeckfishGame.coords2algebraic(col, row);
                // continuation of placement
                if (move.includes(",") || (move && ! move.includes("-"))) {
                    newmove = `${move}-${cell}`;
                } else {
                    //Selecting initial from location or placement location.
                    newmove = `${cell}`;
                }
            }

            console.log("New move is " + newmove);

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
                result.message = i18next.t("apgames:validation.deckfish.PARTIAL_MOVEMENT");
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

 /*           result.message = i18next.t("apgames:validation._general.PARTIAL_MOVEMENT", {cell: to});            result.valid = true;
            result.complete = 0;
            result.message = i18next.t("apgames:validation.deckfish.MAY_SWAP");
            return result;
        } else {
 */

        //Now, swapping.

        // if `sw` is missing, possibly partial
        if (sw === undefined || sw.length === 0) {
            result.valid = true;
            result.complete = 0;
            result.message = i18next.t("apgames:validation.deckfish.INITIAL_SWAP_INSTRUCTIONS");
            return result;
 
        } else {

            //otherwise
            let [market, swap] = sw.split("-");

            //A successful market choice is always valid, 
            //but have to check that it's there.
            //TODO?
            console.log("Market card is " + market);

            // if swap is missing, may or not be complete
            if (swap === undefined || swap.length === 0) {
                result.valid = true;
                result.canrender = true;
                result.complete = -1;
                result.message = i18next.t("apgames:validation.deckfish.PARTIAL_SWAP", {what: market});
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
            
            if (to !== undefined && to.length > 0) {
                //Remove the card.
                const card = Card.deserialize(this.board.get(from)!)!;
                if (card === undefined)
                    throw new Error(`Could not load the card at ${from}.`);

                if (partial)
                    this.highlights.push(card.uid);
                else
                    this.board.delete(from);

                //Move the pawn.
                this.occupied.delete(from);
                if (!partial)
                    this.occupied.set(to, this.currplayer);
                //In the wyrms/bounce case, must also move the other pawn.
                //TODO
                
                //Score the card.
                
                const newSuits = card.suits.map(s => s.uid as Suit);
                //console.log(newSuits);
                //Keeping this sorted.
                this.collected[this.currplayer - 1] = this.collected[this.currplayer - 1].concat(newSuits).sort((a,b) => suitOrder.indexOf(a) - suitOrder.indexOf(b));
                
                this.results.push({type: "move", from: from, to: to});

                if (sw !== undefined && sw.length > 0) {
                    let [marketCard, swapCell] = sw.split("-");
                    //highlight market card
                    //if (partial)
                    this.highlights.push(marketCard);

                    if (swapCell !== undefined && swapCell.length > 0) {
                        //swap market card
                        const swapCard = this.board.get(swapCell)!;
                        this.highlights.push(swapCard);
                        console.log("swapcard " + swapCard + " marketcard " + marketCard);
                        this.market[this.market.indexOf(marketCard)] = swapCard!;
                        this.board.set(swapCell, marketCard);
                        this.results.push({type: "swap", what: marketCard, with: swapCard, where: swapCell});
                    } else {
                        //TODO
                    }
                }
            } else {
                if (this.mode === "place") {
                    if (!partial)
                        this.occupied.set(from, this.currplayer);
                    this.results.push({type: "place", where: from});
                } else {
                    //Illustrate partial move.
                    //TODO
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

    public render(): APRenderRep {
        // Build piece string
        let pstr = "";
        for (let row = 0; row < 6; row++) {
            if (pstr.length > 0) {
                pstr += "\n";
            }
            const pieces: string[] = [];
            for (let col = 0; col < 7; col++) {
                const cell = DeckfishGame.coords2algebraic(col, row);
                if (this.board.has(cell)) {
                    pieces.push("c" + this.board.get(cell)!);
                } else {
                    pieces.push("-");
                }
            }
            pstr += pieces.join(",");
        }

        // build occupied markers
        let markers: (MarkerOutline|MarkerFlood)[]|undefined;
        if (this.occupied.size > 0) {
            markers = [];
            for (const [cell, p] of this.occupied.entries()) {
                const [x,y] = DeckfishGame.algebraic2coords(cell);
                // find existing marker if present for this player
                const found = markers.find(m => m.colour === p);
                if (found !== undefined) {
                    found.points.push({row: y, col: x});
                } 
                //otherwise create new marker
                else {
                    markers.push({
                        type: "outline",
                        colour: p,
                        points: [{row: y, col: x}],
                    });
                }
            }
        }

        // build legend of ALL cards
        const allcards = [...cardsBasic, ...cardsExtended];

        const legend: ILegendObj = {};
        console.log("highlight: " + this.highlights);
        for (const card of allcards) {
            // turn cards into markers in order to fade them?
            if (this.highlights.indexOf(card.uid) > -1) {
		console.log("highlighting " + card.uid);
                legend["c" + card.uid] = card.toGlyph({border: false});
            } else
            legend["c" + card.uid] = card.toGlyph({border: true});
        }
        for (const suit of suits) {
            legend[suit.uid] = {
                name: suit.glyph!,
                scale: 0.5
            }
        }

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
            let captives = this.collected[p-1];
            if (captives.length > 0) {
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
                tileSpacing: 0.1,
                strokeOpacity: 0.05,
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
                console.log(this.results);
            for (const move of this.results) {
                if (move.type === "place") {
                    const [x, y] = DeckfishGame.algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", occlude: false, dashed: [6,8], targets: [{row: y, col: x}]});
                } else if (move.type === "move") {
                    const [fromX, fromY] = DeckfishGame.algebraic2coords(move.from);
                    const [toX, toY] = DeckfishGame.algebraic2coords(move.to);
                    rep.annotations.push({type: "move", targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
                    rep.annotations.push({type: "enter", occlude: false, dashed: [2,4], targets: [{row: toY, col: toX}]});
                } else if (move.type === "swap") {
                    const [x, y] = DeckfishGame.algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", occlude: false, dashed: [6,8], targets: [{row: y, col: x}]});
                }
            }
        }

        return rep;
    }

    private getItemCount(suitArray: string[], item: string): number {
        return suitArray.filter(x => x === item).length;
    }

    private getSuitCounts(suitArray: string[]): number[] {
        return suits.map(s => this.getItemCount(suitArray, s.uid));
    }

    private getTieWinner(): playerid[] {
        //Evaluate tiebreaker.
        let tieWinner: playerid[] = [];
        const sortedArrays = this.collected.map(collection => this.getSuitCounts(collection.slice()).sort());

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
        let score = 0;
        //gets min of suits
        const collection = this.collected[player - 1].slice();
        if (collection !== undefined && collection.length !== 0) {
            score = this.getSuitCounts(collection).sort()[0];
        }
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

    public getStartingPosition(): string {
        const pcs: string[] = [];
        const board = this.stack[0].board;
        for (const [cell, card] of board.entries()) {
            pcs.push(`${card}-${cell}`);
        }
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
                node.push(i18next.t("apresults:MOVE.deckfish", {player, from: r.from, to: r.to}));
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
