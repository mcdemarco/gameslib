import { GameBase, IAPGameState, IClickResult, IIndividualState, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaPieces, Glyph, MarkerFlood, MarkerGlyph, RowCol} from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";
import { Card, Deck, cardSortAsc, cardsBasic, cardsExtended, suits } from "../common/decktet";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2|3|4|5;
export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";
const suitOrder = ["M","S","V","L","Y","K"];

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    skipto?: playerid;
    board: Map<string, string>;
    hands: string[][];
    market: string[];
    discards: string[];
    nummoves: number;
    lastmove?: string;
};

export interface IFroggerState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

interface ILegendObj {
    [key: string]: Glyph|[Glyph, ...Glyph[]];
}

export class FroggerGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Frogger",
        uid: "frogger",
        playercounts: [2,3,4,5],
        version: "20251118",
        dateAdded: "2025-11-18",
        // i18next.t("apgames:descriptions.frogger")
        description: "apgames:descriptions.frogger",
        // i18next.t("apgames:notes.frogger")
        notes: "apgames:notes.frogger",
        urls: [
            "http://wiki.decktet.com/game:frogger",
            "https://boardgamegeek.com/boardgame/41859/frogger",
        ],
        people: [
            {
                type: "designer",
                name: "José Carlos de Diego Guerrero",
                urls: ["http://www.labsk.net"],
            },
            {
                type: "coder",
                name: "mcd",
                urls: ["https://mcdemarco.net/games/"],
                apid: "4bd8317d-fb04-435f-89e0-2557c3f2e66c",
            },
        ],
        variants: [
            { uid: "basic", experimental: true },
            { uid: "crocodiles" },
            { uid: "#market" }, //i.e., no refills
            { uid: "refills", group: "market" }, //the official rule
            { uid: "continuous", group: "market" },
        ],
        categories: ["goal>evacuate", "mechanic>move", "mechanic>bearoff", "mechanic>block", "mechanic>random>setup", "mechanic>random>play", "board>shape>rect", "board>connect>rect", "components>decktet", "other>2+players"],
        flags: ["autopass", "custom-buttons", "custom-randomization", "random-start", "experimental"],
    };
    public coords2algebraic(x: number, y: number): string {
        return GameBase.coords2algebraic(x, y, this.rows);
    }
    public algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, this.rows);
    }

    public numplayers = 2;
    public currplayer: playerid = 1;
    public skipto?: playerid|undefined;
    public board!: Map<string, string>;
    public hands: string[][] = [];
    public market: string[] = [];
    public discards: string[] = [];
    public nummoves = 3;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    private rows: number = 3;
    private marketsize: number = 6;
    private deck!: Deck;
    private suitboard!: Map<string, string>;

    constructor(state: number | IFroggerState | string, variants?: string[]) {
        super();
        if (typeof state === "number") {
            this.numplayers = state;
            if (variants !== undefined) {
                this.variants = [...variants];
            }

            // init deck
            const cards = [...cardsBasic];
            const deck = new Deck(cards);
            deck.shuffle();
            
            //const boardCard = [...cardsExtended.filter(c=> c.rank.uid === "0")];
            const boardDeckCards = [...cardsExtended.filter(c => c.rank.uid === "P")].concat(deck.draw(8));
            const boardDeck = new Deck(boardDeckCards);
            boardDeck.shuffle();

            // init board
            this.rows = Math.max(3, this.numplayers) + 1;

            if (this.variants.includes("continuous"))
                this.marketsize = 3;

            const board = new Map<string, string>();
            const suitboard = new Map<string, string>();

            //add cards
            for (let col = 1; col < 13; col++) {
                const [card] = boardDeck.draw();
                const cell = this.coords2algebraic(col, 0);
                board.set(cell, card.uid);
                
                //Set suits.
                const suits = card.suits.map(s => s.uid);
                for (let s = 0; s < suits.length; s++) {
                    const cell = this.coords2algebraic(col, s + 1);
                    suitboard.set(cell,suits[s]);
                }
                
                //Add crocodiles.  Crocodiles are player 0.
                if (this.variants.includes("crocodiles")) {
                    if (card.rank.uid === "P") {
                        const cell = this.coords2algebraic(col, 1);
                        board.set(cell, "X0");
                    }
                }
            }

            //add players, who are Xs to not conflict with Pawns
            for (let row = 1; row <= this.numplayers; row++) {
                const cell = this.coords2algebraic(0, row);
                board.set(cell, "X" + row.toString() + "-6");
            }

            // init market and hands
            const hands: string[][] = [];
            for (let i = 0; i < this.numplayers; i++) {
                hands.push([...deck.draw(4).map(c => c.uid)]);
            }
            const market: string[] = [...deck.draw(this.marketsize).map(c => c.uid)];

            const fresh: IMoveState = {
                _version: FroggerGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board,
                hands,
                market,
                discards: [],
                nummoves: 3
            };
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IFroggerState;
            }
            if (state.game !== FroggerGame.gameinfo.uid) {
                throw new Error(`The Frogger engine cannot process a game of '${state.game}'.`);
            }
            this.numplayers = state.numplayers;
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.variants = state.variants;
            this.stack = [...state.stack];

        }
        this.load();
    }

    public load(idx = -1): FroggerGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if ( (idx < 0) || (idx >= this.stack.length) ) {
            throw new Error("Could not load the requested state from the stack.");
        }

        const state = this.stack[idx];
        this.results = [...state._results];
        this.currplayer = state.currplayer;
        this.skipto = state.skipto;
        this.board = new Map(state.board);
        this.hands = state.hands.map(h => [...h]);
        this.market = [...state.market];
        this.discards = [...state.discards];
        this.nummoves = state.nummoves;
        this.lastmove = state.lastmove;

        this.rows = Math.max(3, this.numplayers) + 1;
        if (this.variants.includes("continuous"))
            this.marketsize = 3;
        
        this.suitboard = this.setSuitedCells();

        // Deck is reset every time you load
        const cards = [...cardsBasic];
        //Some board cards, for removal.
        cards.push(...cardsExtended.filter(c => c.rank.uid === "P"));
        
        this.deck = new Deck(cards);
        
        // remove cards from the deck that are on the board, in the market, or in known hands
        this.getBoardCards().forEach( uid => 
            this.deck.remove(uid)
        );
        for (const hand of this.hands) {
            for (const uid of hand) {
                this.deck.remove(uid);
            }
        }
        for (const uid of this.market) {
            this.deck.remove(uid);
        }
        for (const uid of this.discards) {
            this.deck.remove(uid);
        }

        this.deck.shuffle();

        return this;
    }
    
    private checkBlocked(): boolean {
        //A player is blocked if their hand is empty and all frogs are already at the Excuse or home.
        if (this.hands[this.currplayer - 1].length > 0)
            return false;
        if (this.countStartFrogs() + this.countHomeFrogs() < 6)
            return false;
        return true;
    }

    private checkMarket(card: string, suit: string): boolean {
        const suits = this.getSuits(card);
        return (suits.indexOf(suit) < 0);
    }

    private checkNextBack(from: string, to: string): boolean {
        const correctBacks: string[] = this.getNextBack(from);
        return (correctBacks.indexOf(to) > -1);
    }

    private checkNextForward(from: string, to: string, card: string): boolean {
        const suits = this.getSuits(card);
            
        for (let s = 0; s < suits.length; s++) {
            const suitto = this.getNextForward(from, suits[s]);
            if (to === suitto)
                return true;
        }
        
        return false;
    }

    private countColumnFrogs(col: number): number {
        if (col !== 0 && col !== 13)
            throw new Error(`The request for frog count was malformed. This should never happen.`);
        
        const cell = this.coords2algebraic(col, this.currplayer as number);
        if (!this.board.has(cell))
            return 0;
        const piece = this.board.get(cell)!;
        const parts = piece.split("-");
        if (parts.length < 2)
            throw new Error(`The piece at "${cell}" was malformed. This should never happen.`);
        else
            return parseInt(parts[1],10);
    }

    private getBoardCards(): string[] {
        const cards: string[] = [];
        for (let col = 1; col < 13; col++) {
            const cell = this.coords2algebraic(col, 0);
            const uid = this.board.get(cell)!;
            cards.push(uid);
        }
        return cards;
    }

    private getFrogs(forBack: boolean): string[] {
        //These are frogs that can move, so skip the home row.
        const frarray = [];
        for (let row = 1; row < this.rows; row++) {
            for (let col = 0; col < 13; col++) {
                if ( col === 0 && forBack )
                    continue;
                const cell = this.coords2algebraic(col, row);
                if (this.board.has(cell)) {
                    const frog = this.board.get(cell)!;
                    if ( frog.charAt(1) === this.currplayer.toString() )
                        frarray.push(cell);
                }
            }
        }
        return frarray;
    }

    private getNextBack(from: string): string[] {
        //Walk back through the board until we find a free column.
        //Return an array of all available cells in the column.
        const fromX = this.algebraic2coords(from)[0];

        if ( fromX === 0 ) {
            throw new Error(`Could not back up from the Excuse. This should never happen.`);
        }

        for (let c = fromX - 1; c > 0; c--) {
            const cells = [];
            for (let r = 1; r < this.rows; r++) {
                const cell = this.coords2algebraic(c, r);
                if ( !this.board.has(cell) && this.suitboard.has(cell) )
                    cells.push(cell);
            }
            if (cells.length > 0)
                return cells;
        }
        const startCell = this.coords2algebraic(0, this.currplayer);
        return [startCell];
    }

    private getMarketCards(suit: string): string[] {
        //Filter the market by the forbidden suit.
        //Return an array of all legal cards in the market (for random moves).
        const whiteMarket: string[] = [];

        this.market.forEach(card => {
            const suits = this.getSuits(card);
            if (suits.indexOf(suit) < 0)
                whiteMarket.push(card);
        });

        return whiteMarket;
    }
    
    private getNextForward(from: string, suit: string): string {
        //Get the next available cell by suit.
        const homecell = this.coords2algebraic(13, this.currplayer);

        const fromX = this.algebraic2coords(from)[0];

        if ( fromX === 13 ) {
            throw new Error("Could not go forward from home. This should never happen.");
        }

        for (let c = fromX + 1; c < 14; c++) {
            if (c === 13) {
                return homecell;
            }
            for (let r = 1; r < this.rows; r++) {
                const cell = this.coords2algebraic(c, r);
                if ( !this.board.has(cell) && this.suitboard.has(cell) && this.suitboard.get(cell) === suit )
                    return cell;
            }
        }

        //You shouldn't be here!
        throw new Error(`Something went wrong looking for the next suited cell.`);
    }

    private countHomeFrogs(): number {
        return this.countColumnFrogs(13);
    }

    private countStartFrogs(): number {
        return this.countColumnFrogs(0);
    }

    private getCrocRowFromColumn(col: number): number {
        for (let row = 1; row < 4; row++) {
            const croc = this.coords2algebraic(col, row);
            if (this.board.has(croc) && this.board.get(croc) === "X0") {
                return row;
            }
        }
        throw new Error("Could not find row for crocodile column.");
        return 0;
    }

    private getSuits(cardId: string): string[] {
        const card = Card.deserialize(cardId)!;
        const suits = card.suits.map(s => s.uid);
        return suits;
    }

    private getUnsuitedCells(): string[] {
        //Return those board cells that aren't on suitboard but are playable.
        const uncells: string[] = [];
        for (let row = 1; row <= this.numplayers; row++) {
            const startcell = this.coords2algebraic(0, row);
            const homecell = this.coords2algebraic(13, row);
            uncells.push(startcell);
            uncells.push(homecell);
        }
        return uncells;
    }

    private isCracy(cardId: string): boolean {
        const card = Card.deserialize(cardId)!;
        const rank = card.rank.name;
        return ( rank === "Crown" || rank === "Ace" );
    }
    
    private modifyFrogStack(cell: string, increment: boolean): void {
        //It's the responsibility of the caller to validate the arguments.
        const [cellX, cellY] =  this.algebraic2coords(cell);

        if (! this.board.has(cell) ) {
            if ( (cellX === 13 || cellX === 0) && increment ) {
                //The special case of the first frog home,
                // or the first frog returning to the empty Excuse.
                this.board.set(cell, "X" + cellY + "-1");
            } else {
                throw new Error(`Stack not found at "${cell}" in modifyFrogStack.`);
            }
            return;
        } 
            
        const oldFrog = this.board.get(cell)!;
        const player = oldFrog.charAt(1);
        const oldFrogCount = parseInt(oldFrog.split("-")[1], 10);
        const newFrogCount = increment ? oldFrogCount + 1 : oldFrogCount - 1 ;

        if (newFrogCount === 0) {
            this.board.delete(cell);
        } else {
            const newFrogStack = "X" + player + "-" + newFrogCount.toString();
            this.board.set(cell, newFrogStack);
        }
        
    }

    private moveFrog(from: string, to: string): void {
        //Frog adjustments are complicated by frog piles and crocodiles.
        const frog = this.board.get(from)!;
        const fromX = this.algebraic2coords(from)[0];
        const toX = this.algebraic2coords(to)[0];
        const singleFrog = "X" + frog.charAt(1);
        
        if (fromX > 0 && toX > 0 && toX < 13) {
            this.board.set(to, singleFrog);
            this.board.delete(from);
        } else {
            //Unsetting the old:
            if (fromX === 0) {
                this.modifyFrogStack(from, false);
            } else {
                //Normal delete.
                this.board.delete(from);
            }

            //Setting the new:
            if ( toX === 0 || toX === 13 ) {
                this.modifyFrogStack(to, true);
            } else {
                this.board.set(to, singleFrog);
            }
        }
    }

    private moveFrogToExcuse(from: string): string {
        //Wrapper to determine Excuse row.
        const frog = this.board.get(from)!;
        const row = parseInt(frog.charAt(1),10);
        const to = this.coords2algebraic(0, row);
        this.moveFrog(from, to);
        return to;
    }

    private moveNeighbors(cell: string): string[][] {
        //Move other frogs off your lily pad.  Track who.
        const bounced: string[][] = [];
        const col = this.algebraic2coords(cell)[0];
        
        if (col === 0) {
            throw new Error("Trying to bounce frogs off the Excuse. This should never happen!");
        } else if (col === 13) {
            //Can't bounce here.
            return bounced;
        }
        
        for (let row = 1; row < this.rows; row++) {
            const bouncee = this.coords2algebraic(col, row);
            //Don't bounce self or crocodiles.
            if ( bouncee !== cell && this.board.has(bouncee) && this.board.get(bouncee) !== "X0" ) {
                const to = this.moveFrogToExcuse(bouncee)!;
                bounced.push([bouncee, to]);
            }
        }
        return bounced;
    }

    private popCrocs(): string[][] {
        const victims: string[][] = [];
        for (let col = 1; col < 13; col++) {
            // check for pawn column using the suit board
            if ( this.suitboard.has(this.coords2algebraic(col, 3)) ) {
                // we have a croc's column; get its row.
                const crocRow = this.getCrocRowFromColumn(col);
                const victimRow = (crocRow % 3) + 1;
                const crocFrom = this.coords2algebraic(col, crocRow);
                const victimFrom = this.coords2algebraic(col, victimRow);
                if ( this.board.has(victimFrom) ) {
                    const victimTo = this.moveFrogToExcuse(victimFrom);
                    victims.push([victimFrom, victimTo]);
                }
                // regardless of squashed frogs, we move the crocodile
                this.moveFrog(crocFrom, victimFrom);
            }
        }
        return victims;
    }

    private popHand(card: string): void {
        this.removeCard(card, this.hands[this.currplayer - 1]);
        this.discards.push(card);
    }

    private popMarket(card: string): boolean {
        //Remove the drawn card.
        this.removeCard(card, this.market);
        this.hands[this.currplayer - 1].push(card);

        return (this.market.length === 0);

        //If the market is empty, we need to draw a new market.
        //TODO: this requires ending the move sequence
        //      and passing the other players to move again.
    }

    private randomElement(array: string[]): string {
        const index = Math.floor(Math.random() * array.length);
        return array[index];
    }

    private refillMarket(): boolean {
        //Fills the market regardless of current size.
        
        //But if it's already full (in the variant), return.
        if (this.market.length === this.marketsize)
            return false;
        
        //First, draw from the deck.
        const toDraw = Math.min(this.marketsize, this.deck.size);
        this.market = [...this.deck.draw(toDraw).map(c => c.uid)];

        //If we didn't fill the market, shuffle the discards.
        if (this.market.length < this.marketsize) {
            //Return the discards to the deck and shuffle.
            this.discards.forEach( card => {
                this.deck.add(card);
            });
            this.discards = [];
            this.deck.shuffle();
            
            //Draw the rest.
            for (let n = this.market.length; n < this.marketsize; n++) {
                const [card] = this.deck.draw();
                this.market.push(card.uid);
            }
        }
        return true;
    }

    private removeCard(card: string, arr: string[]): void {
        const index = arr.indexOf(card);
        if (index > -1) {
            arr.splice(index, 1);
        } else {
            throw new Error(`Could not find the card "${card}" in the given array. This should never happen.`);
        }
        return;
    }

    private setSuitedCells(): Map<string, string> {
        const suitboard = new Map<string, string>();
        const cards = this.getBoardCards();
        for (let col = 1; col < 13; col++) {
            const suits = this.getSuits(cards[col - 1]);
            for (let s = 1; s < suits.length + 1; s++) {
                const cell = this.coords2algebraic(col, s);
                suitboard.set(cell,suits[s-1]);
            }
        }
        return suitboard;
    }
    
    public moves(player?: playerid): string[] {
        if (this.gameover) {
            return [];
        }

        if (player === undefined) {
            player = this.currplayer;
        }

        if (this.skipto !== undefined && this.skipto !== this.currplayer ) {
            //Passing for market hiding.
            return ["pass"];
        }

        return [this.randomMove()];
    }
    
    public randomMove(): string {
        //We return only one, legal move, for testing purposes.
        if (this.checkBlocked()) {
            const marketCard = this.randomElement(this.market);
            return marketCard + "/";
        }

        //Flip a coin about what to do (if there's an option).
        let handcard = ( Math.random() < 0.66 );
        //But...
        if ( this.hands[this.currplayer - 1].length === 0 )
            handcard = false;
        if ( this.countStartFrogs() + this.countHomeFrogs() === 6 )
            handcard = true;
        
        //Pick a frog at random.
        const from = this.randomElement(this.getFrogs(!handcard));
        
        if ( handcard ) {
            //hop forward
            const card = this.randomElement(this.hands[this.currplayer - 1]);
            const suits = this.getSuits(card);
            const suit = this.randomElement(suits);
            
            const to = this.getNextForward(from, suit);

            return `${card}:${from}-${to}`;
            
        } else {
            //fall back.

            const toArray = this.getNextBack(from);
            const to = this.randomElement(toArray);
            const toX = this.algebraic2coords(to)[0];
            let card;
            if (toX === 0) {
                //Can choose any market card.
                card = this.randomElement(this.market);
            } else {
                const suit = this.suitboard.get(to);
                const whiteMarket = this.getMarketCards(suit!);
                if (whiteMarket.length > 0)
                    card = this.randomElement(whiteMarket);
            }

            if ( card )
                return `${from}-${to},${card}`;
            else
                return `${from}-${to}`;
        }

    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        //The move format is one of:
        // handcard:from-to      a regular move forward
        // from-to,marketcard    a productive move backward
        // from-to               a move backward but no available market card
        // marketcard://          the whole turn blocked option
        try {
            let newmove = "";
            const lastchar = move ? move.slice(-1) : "";
            const moves =  move.split("/");
            const currmove = moves.length > 0 ? moves[moves.length - 1] : "";

            //console.log("lastchar: ", lastchar, "currmove: ", currmove);
            
            if (moves.length > this.nummoves) {
                return {
                    move,
                    valid: false,
                    message: i18next.t("apgames:validation.frogger.TOO_HOPPY")
                }
            }
            
            if (row < 0 && col < 0) {
                //clicking on a hand or market card
                if (lastchar === "/") {
                    // starting another move (forward).
                    newmove = `${move}${piece!.substring(1)}:`;
                } else if (lastchar === "") {
                    // starting the first move (forward) or possibly the blocked option
                    if (this.checkBlocked()) {
                        //The blocked case (spending your entire turn to draw a market card)
                        newmove = `${piece!.substring(1)}//`;
                    } else {
                        newmove = `${piece!.substring(1)}:`;
                    }
                } else if (lastchar === "-") {
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.frogger.PLACE_NEXT")
                    }
                } else if (lastchar === ":") {
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.frogger.PIECE_NEXT")
                    }
                } else if ( moves.length < this.nummoves ) {
                    //The last char is text.
                    newmove = `${move},${piece!.substring(1)}/`;
                } else {
                   return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.frogger.TOO_HOPPY")
                    }
                }
            } else {
                //Clicking on the board.

                if (row === 0) {
                    //The top row is not allowed.
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.frogger.OFFSIDES")
                    }
                }

                const cell = this.coords2algebraic(col, row);
                if ( !this.suitboard.has(cell) && this.getUnsuitedCells().indexOf(cell) < 0 ) {
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.frogger.OFF_BOARD")
                    }
                }

                if (( lastchar === ":" || lastchar === "/" || lastchar === "" ) && ( piece === undefined || piece === "" ) ) {
                    //Piece picking cases, so need a piece.
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.frogger.PIECE_NEXT")
                    }
                } else if ( lastchar === ":" || lastchar === "/" ) {
                    //picked the piece.
                    newmove += `${move}${cell}-`;
                } else if ( lastchar === "" ) {
                    //picked a piece for moving back.
                    newmove += `${cell}-`;
                } else if ( lastchar === "-" && currmove.indexOf(":") > -1) {
                    //picked the target and finished the move.
                    newmove = `${move}${cell}/`;
                } else if ( lastchar === "-" ) {
                    //picked the target but not a market card.
                    newmove = `${move}${cell}`;
                } else if ( move.split("/").length < this.nummoves ) {
                    //The last char is text and we need to start a new move if legal.
                    newmove = `${move}/${cell}`;
                } else {
                   return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.frogger.TOO_HOPPY")
                    }
                }
            }
            
            const result = this.validateMove(newmove) as IClickResult;
            if (! result.valid) {
                result.move = move;
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
        //TODO: remove double slashes.

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            if ( this.stack.length > this.numplayers )
                result.message = i18next.t("apgames:validation.frogger.LATER_INSTRUCTIONS")
            else
                result.message = i18next.t("apgames:validation.frogger.INITIAL_INSTRUCTIONS")
            return result;
        }

        const cloned: FroggerGame = Object.assign(new FroggerGame(this.numplayers, [...this.variants]), deepclone(this) as FroggerGame);

        const moves: string[] = m.split("/");

        if ( moves.length > this.nummoves ) {
            if (moves.length > this.nummoves + 1 || moves[this.nummoves] !== "") {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.TOO_HOPPY");
                return result;
            } //else extra empty move is a placeholder to show the final move is complete.
        }

        let allcomplete = false;
        let marketEmpty = false;

        for (let s = 0; s < moves.length; s++) {
            const submove = moves[s];

            if ( s === moves.length - 1 && submove === "" ) {
                //Just a dummy move to signify the previous one was complete.
                //TODO: Might need to do final wrapup here.
                continue;
            }
            
            let mv, from, to, ca;
            let handcard = false;
            let complete = false;
            let nocard = false;




            if (s < moves.length - 1)
                complete = true;
//          console.log("loop ", s, "complete?", complete, "moves?", m, moves);
            
            if (submove.indexOf(":") > -1) {
                //Card followed by move is a hand card.
                [ca, mv] = submove.split(":");
                handcard = true;
            } else if (submove.indexOf(",") > -1) {
                //Move followed by card is a backwards move.
                [mv, ca] = submove.split(",");
            } else if (submove.indexOf("-") > -1) {
                //Raw move is a unproductive or partial backwards move.
                [from, to] = submove.split("-");
                nocard = true;
            } else {
                //Raw card must be a blocked move or a partial.
                if (complete) {
                    if (s > 0) {
                        //Bad blocked move (in presence of other moves)
                        result.valid = false;
                        result.message = i18next.t("apgames:validation.frogger.TOO_LATE_FOR_BLOCKED");
                        return result;
                    } else if (moves.length > 1 && moves[1] !== "") {
                        //Bad blocked move (in presence of other moves)
                        //TODO: obviate this case by fixing the move stack.
                        result.valid = false;
                        result.message = i18next.t("apgames:validation.frogger.NO_MOVE_BLOCKED");
                        return result;
                    } else if (s === 0) {
                        //Blocked move on its own.
                        ca = submove; //TODO: No extra punctuation?
                        //We don't need to check the clone here
                        //because no other changes have been made,
                        //and none are allowed on a blocked move.
                        const blocked = this.checkBlocked();                    
                        if (!blocked) {
                            result.valid = false;
                            result.message = i18next.t("apgames:validation.frogger.NOT_BLOCKED");
                            return result;
                        }
                        if (this.market.indexOf(ca) > -1) {
                            result.valid = true;
                            result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                            result.complete = 1;
                            return result;
                        }
                    }
                } else {
                    result.valid = true;
                    if (cloned.market.indexOf(ca!) > -1)
                        result.message = i18next.t("apgames:validation.frogger.SUBMIT_BLOCKED");
                    else
                        result.message = i18next.t("apgames:validation.frogger.PIECE_NEXT"); 
                    result.complete = 0;
                    return result;
                }
            }

            //Next: check cards.
            //There is a case remaining with no cards.
            if (handcard && cloned.hands[cloned.currplayer - 1].indexOf(ca!) < 0 ) {
                //Bad hand card.
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.NO_SUCH_HAND_CARD", {card: ca});
                return result;
            } else if (!handcard && !nocard && cloned.market.indexOf(ca!) < 0 ) {
                //Bad card.
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.NO_SUCH_MARKET_CARD", {card: ca});
                return result;
            }

            //Parse unparsed moves.
            //There is no case remaining without moves, except partials.
            if ( mv ) {
                [from, to] = mv!.split("-");
            }

            if ( !from ) {
                if (!complete) {
                    result.valid = true;
                    result.complete = -1;
                    result.message = i18next.t("apgames:validation.frogger.PIECE_NEXT");
                    return result;
                } else {
                    //malformed
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.frogger.INVALID_MOVE");
                    return result;
                }
            }

            //Once we have a move from, we have a frog.
            const frog = cloned.board.get(from!);
            if (!frog || frog!.charAt(1)! !== cloned.currplayer.toString() ) {
                //Bad frog.
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.INVALID_FROG");
                return result;
            }

            //Frog location.
            const [fromX, fromY] = this.algebraic2coords(from);
            if (fromY === 13) {
                //No deposit, no return.
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.NO_RETURN");
                return result;
            }

            if ( !to ) {
                if (!complete) {
                    result.valid = true;
                    result.complete = -1;
                    result.message = i18next.t("apgames:validation.frogger.PLACE_NEXT");
                    return result;
                } else {
                    //malformed
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.frogger.INVALID_MOVE");
                    return result;
                }
            }
            
            if (!to) {
                result.valid = true;
                result.complete = -1;
                result.message = i18next.t("apgames:validation.frogger.PLACE_NEXT");
                return result;
            }

            //Check target location is on the board.
            if ( !cloned.suitboard.has(to) && cloned.getUnsuitedCells().indexOf(to) < 0 ) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.OFF_BOARD");
                return result;
            }
            //The source location was tested for frogs so must have been on the board.

            //On to to testing.
            const toX = this.algebraic2coords(to)[0];

            //It's my interpretation of the rules that you must change cards on a move,
            // not just change space, but I'm not 100% sure about that.
            if (fromX === toX) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.MUST_MOVE");
                return result;  
            }

            //Test the move direction against what kind of card was selected.
            if (handcard && toX < fromX) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.MUST_HOP_FORWARD");
                return result;
            } else if (!handcard && toX > fromX) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.MUST_HOP_BACKWARD");
                return result;
            }

            //Moving back tests.
            if (!handcard) {
                if ( !this.checkNextBack(from, to)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.frogger.INVALID_HOP_BACKWARD");
                    return result;
                }
                if (toX > 0 && ca) {
                    const suit = this.suitboard.get(to)!;
                    if (! this.checkMarket(ca, suit) ) {
                        result.valid = false;
                        result.message = i18next.t("apgames:validation.frogger.INVALID_MARKET_CARD");
                        return result;
                    }
                } // When backing up to start you can pick any market card.
            }

            //Moving forward tests.
            if (handcard && !cloned.checkNextForward(from, to, ca!)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.INVALID_HOP_FORWARD");
                return result;
            }

            if (s < moves.length - 1) {
                //Passed all tests so make the submove for validating the rest.
                //Card adjustments.
                if (handcard) {
                    cloned.popHand(ca!);
                    //Also pop other frogs if it's a crown or ace.
                    if ( cloned.isCracy(ca!) ) {
                        cloned.moveNeighbors(to);
                    }
                } else if (ca) {
                    marketEmpty = cloned.popMarket(ca);
                }

                if (from && to) {
                    //Frog adjustments, complicated by frog piles.
                    cloned.moveFrog(from, to);
                }
                
            } else if ( s === moves.length - 1 ) {
                //Pass completion status to outside.
                allcomplete = complete;
            }
        }

        console.log(marketEmpty);

        //Really really done.
        result.valid = true;
        result.complete = allcomplete ? 1 : 0;
        result.message = i18next.t("apgames:validation._general.VALID_MOVE");
        return result;
    }

    public move(m: string, {trusted = false, partial = false} = {}): FroggerGame {
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

        const moves = m.split("/");
        
        this.results = [];
        let marketEmpty = false;

        for (let s = 0; s < moves.length; s++) {
            const submove = moves[s];
            if ( submove === "" )
                continue;
            
            let mv, from, to, ca;
            let handcard = false;

            if (submove.indexOf(":") > -1) {
                //Card followed by move is a hand card.
                [ca, mv] = submove.split(":");
                handcard = true;
            } else if (submove.indexOf(",") > -1) {
                //Move followed by card is a backwards move.
                [mv, ca] = submove.split(",");
            } else if (submove.indexOf("-") > -1) {
                //Raw move is a unproductive or partial backwards move.
                [from, to] = submove.split("-");
//              nocard = true;
            } else {
                //Raw card must be a blocked move or a partial.
                ca = submove;
                if (!partial)
                    this.results.push({type: "claim", what: ca});
            }

            if ( mv ) 
                [from, to] = mv!.split("-");

            //Make the submove.
            //Possible card adjustments.
            if (handcard) {
                this.popHand(ca!);
                this.results.push({type: "move", from: from!, to: to!, what: ca!, how: "forward"});
                if ( this.isCracy(ca!) ) {
                    const bounced = this.moveNeighbors(to!);
                    bounced.forEach( ([from, to]) => {
                        this.results.push({type: "eject", from: from, to: to, what: "a Crown or Ace"});
                    });
                }
            } else if (ca) {
                marketEmpty = this.popMarket(ca);
                if (from) {
                    this.results.push({type: "move", from: from!, to: to!, what: ca!, how: "back"});
                    //TODO: midstream market
                }
            } else {
                    this.results.push({type: "move", from: from!, to: to!, what: "no card", how: "back"});
            }

            if (from && to) {
                this.moveFrog(from,to);
            }
        }

        if (partial) { return this; }

        //update market if necessary
        if (marketEmpty || this.variants.includes("continuous")) {
            const refilled = this.refillMarket();
            if (refilled)
                this.results.push({type: "deckDraw"});
        }

        //update crocodiles if croccy
        if (this.variants.includes("crocodiles") && this.currplayer as number === this.numplayers) {
            this.results.push({type: "declare"});
            //Advance the crocodiles.
            const victims = this.popCrocs();
            //Memorialize any victims.
            victims.forEach( ([from, to]) => {
                this.results.push({type: "eject", from: from, to: to, what: "crocodiles"});
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

    protected checkEOG(): FroggerGame {
        if ( this.countHomeFrogs() === 6 ) {
            this.gameover = true;
            this.winner.push(this.currplayer);
        }

        if (this.gameover) {
            this.results.push(
                {type: "eog"},
                {type: "winners", players: [...this.winner]}
            );
        }
        return this;
    }

    public state(opts?: {strip?: boolean, player?: number}): IFroggerState {
        const state: IFroggerState = {
            game: FroggerGame.gameinfo.uid,
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
                    mstate.hands[p-1] = [];
                }
                return mstate;
            });
        }
        return state;
    }

    public moveState(): IMoveState {
        return {
            _version: FroggerGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            skipto: this.skipto,
            lastmove: this.lastmove,
            board: new Map(this.board),
            hands: this.hands.map(h => [...h]),
            market: [...this.market],
            discards: [...this.discards],
            nummoves: this.nummoves,
        };
    }

    public render(): APRenderRep {
        //Taken from the decktet sheet.
        const suitColors = ["#c7c8ca","#e08426","#6a9fcc","#bc8a5d","#6fc055","#d6dd40"];
        
        // Build piece string. 
        let pstr = "";
        for (let row = 0; row < this.rows; row++) {
            if (pstr.length > 0) {
                pstr += "\n";
            }
            const pieces: string[] = [];
            for (let col = 0; col < 14; col++) {
                const cell = this.coords2algebraic(col, row);

                if (this.board.has(cell)) {
                    if (row === 0) 
                        pieces.push("c" + this.board.get(cell)!);
                    else
                        pieces.push(this.board.get(cell)!);
                } else {
                    pieces.push("-");
                }

            }
            
            pstr += pieces.join(",");
        }

        //Also build blocked sting.
        const blocked = [];
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < 14; col++) {
                const cell = this.coords2algebraic(col, row);
                if (row === 0) {
                    blocked.push({col: col, row: row} as RowCol);
                } else if (col === 0 || col === 13) {
                    if (row > this.numplayers)
                        blocked.push({col: col, row: row} as RowCol);
                } else if (! this.suitboard.has(cell) ) {
                    blocked.push({col: col, row: row} as RowCol);
                }
            }
        }

        // build claimed markers
        const markers: (MarkerFlood|MarkerGlyph)[] = [];
        
        /*    for (const [cell, p] of this.claimed.entries()) {
                const [x,y] = FroggerGame.algebraic2coords(cell);
                // find existing marker if present for this player
                const found = markers.find(m => m.colour === p);
                if (found !== undefined) {
                    found.points.push({row: y, col: x});
                }
                // otherwise create new marker
                else {
                    markers.push({
                        type: "outline",
                        colour: p,
                        points: [{row: y, col: x}],
                    });
                }
          }
        
        }*/
        markers.push({
            type: "glyph",
            glyph: "start",
            points: [{row: 0, col: 0}],
        });
        markers.push({
            type: "glyph",
            glyph: "home",
            points: [{row: 0, col: 13}],
        });

        // add flood markers for the end column
        const points = [];
        for (let r = 0; r < this.numplayers; r++) {
            const row = this.rows - 2 - r;
            points.push({col: 0, row: row} as RowCol);
            points.push({col: 13, row: row} as RowCol);
        }
        markers.push({
            type: "flood",
            colour: "_context_fill_",
            opacity: 0.03,
            points: points as [RowCol, ...RowCol[]],
        });

        //Need card info on all cards.
        const allcards = [...cardsBasic];
        allcards.push(...cardsExtended.filter(c => c.rank.uid === "P"));

        //add flood and suit markers for the active spaces
        for (let col = 1; col < 13; col++) {
            const cell = this.coords2algebraic(col,0);
            const cardObj = Card.deserialize(this.board.get(cell)!);
            const suits = cardObj!.suits;

            let shadeRow = 1;
            suits.forEach(suit => {
                const color = suitColors[suitOrder.indexOf(suit.uid)];
                markers.push({
                    type: "flood",
                    colour: color,
                    opacity: 0.33,
                    points: [{row: shadeRow, col: col}],
                });
                markers.push({
                    type: "glyph",
                    glyph: suit.uid,
                    points: [{row: shadeRow, col: col}],
                });
                shadeRow++;
            });
        }
        
        // build legend of ALL cards
        const legend: ILegendObj = {};
        for (const card of allcards) {
            legend["c" + card.uid] = card.toGlyph();
        }
        
        const excuses = [...cardsExtended.filter(c => c.rank.uid === "0")];
        legend["start"] = excuses[0].toGlyph();

        //Home symbol for the last column.
        legend["home"] = {
            name: "streetcar-house",
            scale: 0.75
        };

        //Player pieces.
        for (let player = 1; player <= this.numplayers; player++) {
            
            legend["X" + player] = {
                name: "piece",
                colour: player,
                scale: 0.75
            }

            //The XP-1 token is used in the first and last rows.
            for (let count = 1; count <= 6; count++) {
                legend["X" + player + "-" + count] = [
                    {
                        name: "piece",
                        colour: player,
                        scale: 0.75
                    },
                    {
                        text: count.toString(),
                        colour: "_context_strokes",
                        scale: 0.66
                    }
                ]
            }
        }

        if (this.variants.includes("crocodiles")) {
            legend["X0"] = [
		{
		    name: "piece-borderless",
		    colour: "_context_background",
                    scale: 0.85,
		    opacity: 0.55
		},
		{
		    text: "\u{1F40A}",
                    scale: 0.85
		}
	    ]
        }

         if (this.variants.includes("refills")) {
            legend["refill"] = [
		{
		    text: "\u{1F504}",
                    scale: 1.25
		}
	    ]
        }

        //Suit glyphs.
        for (const suit of suits) {
            legend[suit.uid] = {
                name: suit.glyph,
                scale: 1,
                opacity: 0.33
            }
        };

        // build pieces areas
        const areas: AreaPieces[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            const hand = this.hands[p-1];
            if (hand.length > 0) {
                areas.push({
                    type: "pieces",
                    pieces: hand.map(c => "c" + c) as [string, ...string[]],
                    label: i18next.t("apgames:validation.frogger.LABEL_STASH", {playerNum: p}) || `P${p} Hand`,
                    spacing: 0.5,
                    ownerMark: p
                });
            }
        }

        if (this.market.length > 0) {
            areas.push({
                type: "pieces",
                pieces: this.market.map(c => "c" + c) as [string, ...string[]],
                label: i18next.t("apgames:validation.frogger.LABEL_MARKET") || "Market",
                spacing: 0.375,
            });
        } else if ( this.variants.includes("refills") ) {
            areas.push({
                type: "pieces",
                pieces: ["refill"],
                label: i18next.t("apgames:validation.frogger.LABEL_MARKET") || "Market",
                spacing: 0.375,
            });
	}

        if (this.discards.length > 0) {
            areas.push({
                type: "pieces",
                pieces: this.discards.map(c => "c" + c) as [string, ...string[]],
                label: i18next.t("apgames:validation.frogger.LABEL_DISCARDS") || "Discards",
                spacing: 0.375,
            });
        }
        
        // create an area for all invisible cards (if there are any cards left)
        const hands = this.hands.map(h => [...h]);
        const visibleCards = [...this.getBoardCards(), ...hands.flat(), ...this.market, ...this.discards].map(uid => Card.deserialize(uid));
        if (visibleCards.includes(undefined)) {
            throw new Error(`Could not deserialize one of the cards. This should never happen!`);
        }
        const remaining = allcards.sort(cardSortAsc).filter(c => visibleCards.find(cd => cd!.uid === c.uid) === undefined).map(c => "c" + c.uid) as [string, ...string[]]
        if (remaining.length > 0) {
            areas.push({
                type: "pieces",
                label: i18next.t("apgames:validation.frogger.LABEL_REMAINING") || "Cards in deck",
                spacing: 0.25,
                pieces: remaining,
            });
        }

        // Build rep
        const rep: APRenderRep =  {
            options: ["hide-labels-half"],
            board: {
                style: "squares",
                width: 14,
                height: this.rows,
                tileHeight: 1,
                tileWidth: 1,
                tileSpacing: 0.1,
                strokeOpacity: 0,
                blocked: blocked as [RowCol, ...RowCol[]],
                markers,
            },
            legend,
            pieces: pstr,
            areas,
        };

        //console.log(rep);

        // Add annotations
        if (this.results.length > 0) {
            rep.annotations = [];
            for (const move of this.results) {
                if (move.type === "move") {
                    const [fromX, fromY] = this.algebraic2coords(move.from!);
                    const [toX, toY] = this.algebraic2coords(move.to!);
                    if (move.how === "back")
                        rep.annotations.push({type: "move",  style: "dashed", targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
                    else
                        rep.annotations.push({type: "move",  targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
                } else if (move.type === "claim") {
                    //TODO: Uncover the market card?
                } else if (move.type === "eject") {
                    const [fromX, fromY] = this.algebraic2coords(move.from!);
                    const [toX, toY] = this.algebraic2coords(move.to!);
                    if (move.what = "crocodiles") {
                        rep.annotations.push({type: "eject", targets: [{row: fromY, col: fromX},{row: toY, col: toX}], opacity: 0.9, colour: "#FE019A"});//"#780606"});
                        rep.annotations.push({type: "exit", targets: [{row: fromY, col: fromX}], occlude: false, colour: "#FE019A"});
                    } else {
                        rep.annotations.push({type: "eject", targets: [{row: fromY, col: fromX},{row: toY, col: toX}]});
                        rep.annotations.push({type: "exit", targets: [{row: fromY, col: fromX}]});
                    }
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

        return status;
    }

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "claim":                
                node.push(i18next.t("apresults:CLAIM.frogger", {player, card: r.what}));
                resolved = true;
                break;
           case "deckDraw":                
                node.push(i18next.t("apresults:DECKDRAW.frogger"));
                resolved = true;
                break;
           case "declare":                
                node.push(i18next.t("apresults:DECLARE.frogger"));
                resolved = true;
                break;
            case "eject":                
                if (r.what === "crocodiles") {
                    node.push(i18next.t("apresults:EJECT.frogger_croc", {player, from: r.from, to: r.to}));
                } else {
                    node.push(i18next.t("apresults:EJECT.frogger_card", {player, from: r.from, to: r.to}));
                }
                resolved = true;
                break;
            case "move":
                if (r.how === "forward") {
                    node.push(i18next.t("apresults:MOVE.frogger_forward", {player, from: r.from, to: r.to, card: r.what}));
                } else if (r.how === "back") {
                    node.push(i18next.t("apresults:MOVE.frogger_back", {player, from: r.from, to: r.to, card: r.what}));
                } else {
                    node.push(i18next.t("apresults:MOVE.frogger_blocked", {player, card: r.what}));
                }
                resolved = true;
                break;
            case "eog":                
                node.push(i18next.t("apresults:EOG.frogger", {player}));
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): FroggerGame {

        return Object.assign(new FroggerGame(this.numplayers), deepclone(this) as FroggerGame);
    }
}
