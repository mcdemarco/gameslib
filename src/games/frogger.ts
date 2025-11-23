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
            {
                uid: "crocodiles"
            },
            {
                uid: "basic",
                experimental: true
            },
        ],
        categories: ["goal>evacuate", "mechanic>move", "mechanic>bearoff", "mechanic>block", "mechanic>random>setup", "mechanic>random>play", "board>shape>rect", "board>connect>rect", "components>decktet", "other>2+players"],
        flags: ["random-start", "custom-randomization"],
    };
    public coords2algebraic(x: number, y: number): string {
        return GameBase.coords2algebraic(x, y, this.rows);
    }
    public algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, this.rows);
    }

    public numplayers = 2;
    public currplayer: playerid = 1;
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
    private deck!: Deck;
    private unboard: string[] = [];
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

            const board = new Map<string, string>();
	    const suitboard = new Map<string, string>();

            //add cards
            for (let col = 1; col < 13; col++) {
                const [card] = boardDeck.draw();
                const cell = this.coords2algebraic(col, 0);
                board.set(cell, card.uid);
		//also set suits
		const suits = card.suits.map(s => s.uid);
		for (let s = 0; s < suits.length; s++) {
                    const cell = this.coords2algebraic(col, s + 1);
                    suitboard.set(cell,suits[s]);
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
            const market: string[] = [...deck.draw(6).map(c => c.uid)];

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
        this.board = new Map(state.board);
        this.hands = state.hands.map(h => [...h]);
        this.market = [...state.market];
        this.discards = [...state.discards];
        this.nummoves = state.nummoves;
        this.lastmove = state.lastmove;

        this.rows = Math.max(3, this.numplayers) + 1;
	
	//TODO: remove unboard and use suitboard for those tests.
        this.unboard = this.getUnusedCells();
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

    private checkNextBack(fromX: number, toX: number, toY: number): boolean {
        console.log(fromX, toX, toY);
        return true;
    }

    private checkNextForward(fromX: number, toX: number, toY: number, card: string): boolean {
        console.log(fromX, toX, toY, card);
        return true;
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
		if (!this.board.has(cell) && this.unboard.indexOf(cell) < 0)
		    cells.push(cell);
	    }
	    if (cells.length > 0)
		return cells;
	}
	const startCell = this.coords2algebraic(0, this.currplayer);
	return [startCell];
    }

    private getNextForward(from: string, suit: string): string {
	//Get the next available cell by suit.
	let homecell = this.coords2algebraic(13, this.currplayer);

	const fromX = this.algebraic2coords(from)[0];

	if ( fromX === 13 ) {
	    throw new Error(`Could not go forward from home. This should never happen.`);
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

    private getSuits(cardId: string): string[] {
        const card = Card.deserialize(cardId)!;
        const suits = card.suits.map(s => s.uid);
        return suits;
    }

    private getUnusedCells(): string[] {
        const cards = this.getBoardCards();
        const badcells: string[] = [];
        for (let col = 1; col < 13; col++) {
            const suits = this.getSuits(cards[col - 1]);
            for (let s = suits.length + 1; s < this.rows; s++) {
                const badcell = this.coords2algebraic(col, s);
                badcells.push(badcell);
            }
        }
        return badcells;
    }

    private moveFrog(from: string, to: string): void {
        //Frog adjustments are complicated by frog piles.
	const fromX = this.algebraic2coords(from)[0];
	const toX = this.algebraic2coords(to)[0];
	
        if (fromX > 0 && toX < 13) {
            this.board.set(to, this.board.get(from)!);
            this.board.delete(from);
        } else {
	    
	    //Unsetting the old:
	    if (fromX === 0) {
		const oldFromFrogs = this.board.get(from)!.split("-");
		if (oldFromFrogs[1] === "1") {
                    this.board.delete(from);
		} else {
                    const newFromFrogs = oldFromFrogs[0] + "-" + (parseInt(oldFromFrogs[1],10) - 1).toString();
                    this.board.set(from, newFromFrogs);
		}
	    } else {
		//Normal delete.
		this.board.delete(from);
	    }

	    //Setting the new:
	    if (toX === 13) {
		const oldToFrogs = this.board.get(to)!.split("-");
		//In this case we never remove frogs so we don't have to check for XP-1.
                const newToFrogs = oldToFrogs[0] + "-" + (parseInt(oldToFrogs[1],10) + 1).toString();
                this.board.set(to, newToFrogs);
	    } else {
		this.board.set(to, "X" + this.currplayer);
	    }
		
        }
    }

    private popHand(card: string): void {
	this.removeCard(card, this.hands[this.currplayer - 1]);
	this.discards.push(card);
    }

    private popMarket(card: string): void {
        //Remove the drawn card.
        this.removeCard(card, this.market);
	this.hands[this.currplayer - 1].push(card);

        //If the market is empty, we draw a new market.
        //TODO: this requires ending the move sequence
        //      and passing the other players to move again.
    }

    private randomElement(array: string[]): string {
	const index = Math.floor(Math.random() * array.length);
	return array[index];
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
    
    public randomMove(): string {
	//We return only one, legal move, for testing purposes.
	if (this.checkBlocked()) {
	    const marketCard = this.randomElement(this.market);
	    return marketCard + "//";
	}

	//Flip a coin about what to do (if there's an option).
	let handcard = ( Math.random() < 0.5 );
	//But...
        if ( this.hands[this.currplayer - 1].length === 0 )
	    handcard = false;
	if (this.countStartFrogs() + this.countHomeFrogs() === 6)
            handcard = true;
	
	//Pick a frog at random.
	const from = this.randomElement(this.getFrogs(!handcard));
	
	if ( handcard ) {
	    //hop forward
	    const cardId = this.randomElement(this.hands[this.currplayer - 1]);
	    const card = Card.deserialize(cardId)!;
            const suits = card.suits.map(s => s.uid);
	    const suit = this.randomElement(suits);
	    
	    const to = this.getNextForward(from, suit);

	    return `${cardId}:${from}-${to}`;
	    
        } else {
	    //fall back.

	    const toArray = this.getNextBack(from);
	    const to = this.randomElement(toArray);

	    //TODO: get and check market card.
	    
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

            console.log("lastchar: ", lastchar, "currmove: ", currmove);
            
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
                if (this.unboard.indexOf(cell) > -1) {
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
                    if (s > 0 || moves.length > 1) {
                        //Bad blocked move (in presence of other moves.
                        result.valid = false;
                        result.message = s > 0 ? i18next.t("apgames:validation.frogger.TOO_LATE_FOR_BLOCKED") : i18next.t("apgames:validation.frogger.NO_MOVE_BLOCKED");
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
                result.message = i18next.t("apgames:validation.frogger.INVALID_HAND_CARD", {card: ca});
                return result;
            } else if (!handcard && !nocard && cloned.market.indexOf(ca!) < 0) {
                //Bad card.
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.INVALID_MARKET_CARD", {card: ca});
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
            if (cloned.unboard.indexOf(to) > -1) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.OFF_BOARD");
                return result;
            }
            //The source location was tested for frogs so must have been on the board.

            //On to to testing.
            const [toX, toY] = this.algebraic2coords(to);

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

            //Moving back is the simpler case.
            if (!handcard && !this.checkNextBack(fromX, toX, toY)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.INVALID_HOP_BACKWARD");
                return result;
            } else if (handcard && !cloned.checkNextForward(fromX, toX, toY, ca!)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.INVALID_HOP_FORWARD");
                return result;
            }

            if (s < moves.length - 1) {
                //Passed all tests so make the submove for validating the rest.
                //Card adjustments.
                if (handcard) {
                    cloned.popHand(ca!);
                } else if (ca) {
                    cloned.popMarket(ca);
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

        for (let s = 0; s < moves.length; s++) {
            const submove = moves[s];
            if ( submove === "" )
                continue;
            
            let mv, from, to, ca;
            let handcard = false;
//          let complete = false;
//          let nocard = false;

//          if (s < moves.length - 1)
//              complete = true;

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
            }

            if ( mv ) 
                [from, to] = mv!.split("-");

       /*
            
            if ( (from === undefined) || (to === undefined) || (to.length !== 2) || (from.length < 2) || (from.length > 3) ) {
                throw new UserFacingError("VALIDATION_FAILSAFE", i18next.t("apgames:validation._general.FAILSAFE", {move: m}))
            }
*/

            //Make the submove.
            //Possible card adjustments.
            if (handcard) {
                this.removeCard(ca!, this.hands[this.currplayer - 1]);
            } else if (ca) {
                this.popMarket(ca);
                this.hands[this.currplayer - 1].push(ca);
            }

            if (from && to) {
		this.moveFrog(from,to);
            }
        }
/*
        if (idx < 0 || influence) {
            throw new Error(`Could not find the card "${card}" in the player's hand. This should never happen.`);
        }
        this.hands[this.currplayer - 1].splice(idx, 1);
        if (to !== undefined && to.length > 0) {
            this.board.set(to, card);
            this.results.push({type: "place", what: cardObj.plain, where: to});
        }
*/
        if (partial) { return this; }
/*
        // draw new card
        const [drawn] = this.deck.draw();
        if (drawn !== undefined) {
            this.hands[this.currplayer - 1].push(drawn.uid);
            }

*/
        //update market if necessary
        //TODO

        //update crocodiles if croccy
        //TODO

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
        if (this.board.size === 36) {
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
        
        // Build piece string
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
            colour: "#888",
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
                    label: i18next.t("apgames:validation.frogger.LABEL_STASH", {playerNum: p}) || "local",
                    spacing: 0.5,
                    ownerMark: p
                });
            }
        }
        areas.push({
            type: "pieces",
            pieces: this.market.map(c => "c" + c) as [string, ...string[]],
            label: i18next.t("apgames:validation.frogger.LABEL_MARKET") || "local",
            spacing: 0.375,
        });
        
        // create an area for all invisible cards (if there are any cards left)
        const hands = this.hands.map(h => [...h]);
        const visibleCards = [...this.getBoardCards(), ...hands.flat(), ...this.market].map(uid => Card.deserialize(uid));
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
                if (move.type === "place") {
                    // only add if there's not a claim for the same cell
                    const found = this.results.find(r => r.type === "claim" && r.where === move.where);
                    if (found === undefined) {
                        const [x, y] = this.algebraic2coords(move.where!);
                        rep.annotations.push({type: "enter", occlude: false, targets: [{row: y, col: x}]});
                    }
                } else if (move.type === "claim") {
                    const [x, y] = this.algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", occlude: false, dashed: [4,8], targets: [{row: y, col: x}]});
                }
            }
        }

        return rep;
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

        if (this.variants !== undefined) {
            status += "**Variants**: " + this.variants.join(", ") + "\n\n";
        }

        return status;
    }

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "place":
                node.push(i18next.t("apresults:PLACE.decktet", {player, where: r.where, what: r.what}));
                resolved = true;
                break;
            case "claim":
                node.push(i18next.t("apresults:CLAIM.frogger", {player, where: r.where}));
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): FroggerGame {

        return Object.assign(new FroggerGame(this.numplayers), deepclone(this) as FroggerGame);
    }
}
