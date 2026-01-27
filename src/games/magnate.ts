import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaButtonBar, AreaPieces, AreaKey, Glyph, MarkerFlood, MarkerOutline, RowCol } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { randomInt, reviver, UserFacingError } from "../common";
import i18next from "i18next";
import { Card, Deck, cardSortAsc, cardsBasic, cardsExtended, suits } from "../common/decktet";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2;
//export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";
export type moveType = "B"|"D"|"S"|"A"|"T"|"P"|"E";
//Deeds: the column, an array of added resources, and a preferred suit (to simplify resource collection).
export type DeedContents = {
    district: string,
    tokens: number[],
    suit?: string
};

const columnLabels = "abcdefghij".split("");
const moveTypes = ["B","D","S","A","T","P"];
const suitColors: string[] = ["#c7c8ca","#e08426","#6a9fcc","#bc8a5d","#6fc055","#d6dd40"];
const suitOrder = suits.map(suit => suit.uid); //["M","S","V","L","Y","K"];

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: [string[], string[][], string[][]];
    crowns: [number[], number[]];
    deeds: Map<string, DeedContents>[];
    discards: string[];
    hands: string[][];
    tokens: [number[], number[]];
    shuffled: boolean;
    //roll: number[];
    lastroll: number[];
    lastmove?: string;
};

export interface IMagnateState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

interface ILegendObj {
    [key: string]: Glyph|[Glyph, ...Glyph[]];
}

interface IMagnateMove {
    type: string;
    card?: string;
    district?: string;
    spend?: number[];
    suit?: string;
    incomplete?: boolean;
    valid: boolean;
}

export class MagnateGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Magnate",
        uid: "magnate",
        playercounts: [2],
        version: "20260119",
        dateAdded: "2026-01-19",
        // i18next.t("apgames:descriptions.magnate")
        description: "apgames:descriptions.magnate",
        // i18next.t("apgames:notes.magnate")
        notes: "apgames:notes.magnate",
        urls: [
            "http://wiki.decktet.com/game:magnate",
            "https://boardgamegeek.com/boardgame/41090/magnate",
            "https://mcdemarco.net/games/decktet/magnate/",
        ],
        people: [
            {
                type: "designer",
                name: "Cristyn Magnus",
                urls: ["http://wiki.decktet.com/designer:cristyn-magnus"],
            },
            {
                type: "coder",
                name: "mcd",
                urls: ["https://mcdemarco.net/games/"],
                apid: "4bd8317d-fb04-435f-89e0-2557c3f2e66c",
            },
        ],
        variants: [
            { uid: "courts", default: true }, //include courts
            { uid: "courtpawns" }, //courts for pawns
            { uid: "deucey" }, //ace scoring variant
            { uid: "mega" }, //double deck double hand 
            { uid: "stacked", experimental: true }, //stacking the deck(s)
            { uid: "taxtax" }, //double taxation
        ],
        categories: ["goal>area", "goal>score>eog", "mechanic>place", "mechanic>economy", "mechanic>hidden", "mechanic>random>play", "board>none", "components>decktet"],
        flags: ["no-explore", "perspective", "scores"],
    };

    //The UI is quite simple because we only need to specify a column.
    public coord2algebraic(x: number): string {
        return columnLabels[x];
    }
    public algebraic2coord(district: string): number {
        return columnLabels.indexOf(district);
    }

    public numplayers = 2;
    public currplayer: playerid = 1;
    public board: [string[], string[][], string[][]] = [[],[],[]];
    public crowns: [number[], number[]] = [[], []];
    public deeds!: [Map<string, DeedContents>,Map<string, DeedContents>];
    public discards: string[] = [];
    public hands: string[][] = [];
    public tokens: [number[], number[]] = [[], []];
    //public roll: number[] = [];
    public lastroll: number[] = [];
    public shuffled: boolean = false;
    public gameover: boolean = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    private pawnrank: string = "P";
    private courtrank: string = "T";
    private districts: number = 5;
    private deck!: Deck;
    //    private highlights: string[] = [];

    constructor(state?: IMagnateState | string, variants?: string[]) {
        super();
        if (state === undefined) {
            if (variants !== undefined) {
                this.variants = [...variants];
            }

            if (this.variants.includes("courtpawns")) {
                this.pawnrank = "T";
                this.courtrank = "P";
            }
            const deckCount = (this.variants.includes("mega") ? 2 : 1);
            const handCount = (this.variants.includes("mega") ? 6 : 3);

            if (this.variants.includes("mega"))
                this.districts = 9; //8 pawns plus the excuse

            // init board
            const board: [string[], string[][], string[][]] = [[],[],[]];

            const districtCards = [...cardsExtended.filter(c => c.rank.uid === this.pawnrank)]
            const districtDeck = new Deck(districtCards, deckCount);
            districtDeck.shuffle();

            for (let d = 0; d < this.districts; d++) {
                if ( d === Math.round(this.districts / 2) - 1 ) {
                    board[0][d] = "01"; //the Excuse
                } else {
                    const [card] = districtDeck.draw();
                    board[0][d] = card.uid;
                }
                //Also init player boards.
                board[1][d] = [];
                board[2][d] = [];
            }
            
            //init crowns and tokens
            const crowns: [number[], number[]] = [[0,0,0,0,0,0],[0,0,0,0,0,0]];
            const tokens: [number[], number[]] = [[0,0,0,0,0,0],[0,0,0,0,0,0]];
            
            const crownCards = [...cardsBasic.filter(c => c.rank.name === "Crown")];
            const crownDeck = new Deck(crownCards, deckCount);
            crownDeck.shuffle();

            //initial roll
            const lastroll: number[] = this.roller();
            //const roll: number[] = [...lastroll];

            //Taxation and rank rolls have no impact on the first turn,
            //but we may have to process a Christmas roll.

            for (let c = 0; c < handCount; c++) {
                for (let p = 0; p < 2; p++) {
                    const [card] = crownDeck.draw();
                    const suit = card.suits.map(s => s.uid)[0];
                    crowns[p][suitOrder.indexOf(suit)]++;
                    //Could do this with the inappropriate function.
                    tokens[p][suitOrder.indexOf(suit)]++;
                    if (lastroll[0] === 10) {//Christmas!
                        //Could do this with the appropriate function.
                        tokens[p][suitOrder.indexOf(suit)]++;
                    }
                }
            }
            
            const deck = this.initDeck(deckCount);
            deck.shuffle();
            
            const hands: [string[], string[]] = [[],[]];
            for (let h = 0; h < handCount; h++) {
                for (let p = 0; p < 2; p++) {
                    const [card] = deck.draw();
                    hands[p][h] = card.uid;
                }
            }
            
            const fresh: IMoveState = {
                _version: MagnateGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board,
                crowns,
                deeds: [new Map(), new Map()],
                discards: [],
                hands,
                tokens,
                //roll,
                lastroll,
                shuffled: false
            };

            
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IMagnateState;
            }
            if (state.game !== MagnateGame.gameinfo.uid) {
                throw new Error(`The Magnate engine cannot process a game of '${state.game}'.`);
            }
            this.numplayers = state.numplayers;
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.stack = [...state.stack];
            this.variants = state.variants;
        }
        this.load();
    }

    private initDeck(deckCount: number, forRender?: boolean): Deck {
        //Init draw deck and hands.

        //Remove the crowns from the basic deck.
        const cards = [...cardsBasic.filter(c => c.rank.name !== "Crown")];

        //Usually add the courts.
        if (this.variants.includes("courts"))
            cards.push(...[...cardsExtended.filter(c => c.rank.uid === this.courtrank)]);
        
        if (forRender) {
            //Add the center row.
            cards.push(...[...cardsExtended.filter(c => c.rank.uid === this.pawnrank)]);
            cards.push([...cardsExtended.filter(c => c.rank.name === "Excuse")][0]);
        }

        return new Deck(cards, deckCount);
    }

    private roller(): number[] {
        const d1 = randomInt(10);
        const d2 = randomInt(10);
        const rolled: number[] = [Math.max(d1, d2)];
        if (d1 === 1 || d2 === 1) {
            const t1 = randomInt(6);
            rolled.push(t1);
            if ( this.variants.includes("taxtax") ) {
                const t2 = randomInt(6);
                if (t1 !== t2)
                    rolled.push(t2);
            }
        }
        return rolled;
    }
    
    public load(idx = -1): MagnateGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if ( (idx < 0) || (idx >= this.stack.length) ) {
            throw new Error("Could not load the requested state from the stack.");
        }

        const state = this.stack[idx];
        this.results = [...state._results];
        this.currplayer = state.currplayer;
        this.board = deepclone(state.board) as [string[], string[][], string[][]];
        this.crowns = [[...state.crowns[0]], [...state.crowns[1]]];
        this.deeds = [new Map(state.deeds[0]),new Map(state.deeds[1])];
        this.discards = [...state.discards];
        this.hands = state.hands.map(h => [...h]);
        this.tokens = [[...state.tokens[0]], [...state.tokens[1]]];
        this.shuffled = state.shuffled;
        //this.roll = [...state.roll];
        this.lastroll = [...state.lastroll];
        this.lastmove = state.lastmove;

        if (this.variants.includes("courtpawns")) {
            this.pawnrank = "T";
            this.courtrank = "P";
        }

        if (this.variants.includes("mega"))
            this.districts = 9; //8 pawns plus the excuse

        // Deck is reset every time you load
        const deckCount = (this.variants.includes("mega") ? 2 : 1);
        this.deck = this.initDeck(deckCount);
        
        // remove cards from the deck that are on the board, the discard, or in known hands
        for (const uid of [...this.board[1].flat(), ...this.board[2].flat(), ...this.discards]) {
            this.deck.remove(uid);
        }

        for (const hand of this.hands) {
            for (const uid of hand) {
                if (uid !== "") {
                    this.deck.remove(uid);
                }
            }
        }

        this.deeds[0].forEach((value, key) => this.deck.remove(key));
        this.deeds[1].forEach((value, key) => this.deck.remove(key));

        this.deck.shuffle();

        //We report the previous roll as associated with this player and this turn.
        this.results.push({type: "roll", values: this.lastroll});
        //If that workn, we could recalculate and report taxes here too.

        return this;
    }


    
    /* helper functions for general gameplay */
    /*
      private canDeed(card: string): boolean {
      //TODO: test if this player can afford to deed the card.
      //CURRENTLY: testing with no economy
      
      //Check for a token of each suit.
      if (card) {        
      //in case of failure, also check for a trade (used for move generation).
      return true;
      }

      return true;
      }

      private canPay(card: string): boolean {
      //TODO: Test if this player can afford to build the card outright.
      //CURRENTLY: testing with no economy
      
      //Check for the suit tokens with canDeed.
      if (!this.canDeed(card)) {        
      return false;
      }

      //TODO: Check  for remaining tokens.

      return true;
      }
    */
    private canPlace(card: string, district: string): boolean {
        const col = this.algebraic2coord(district);
        
        //Check for a deeded card.
        if (this.hasDeed(district, this.currplayer)) {
            return false;
        }

        //Find the card to match.
        let matchMe = this.board[0][col];
        const myBoard = this.board[this.currplayer];
        if (myBoard[col].length > 0)
            matchMe = myBoard[col][myBoard[col].length - 1];

        //Check for suit mismatch.
        return this.matched(card, matchMe);
    }

    /*
      private canTrade(suit: string): boolean {
      //TODO: Test if this player can trade for a suit.
      
      return !!(suit);
      }
    */
    
    private collectOn(rank: number, player: playerid): void {
        //TODO: use this.credit instead.
        let tokens = Array(6).fill(0);
        const p = player - 1;
        //Special ranks:
        if (rank === 10) {
            //Crownmas for everyone.
            tokens = this.crowns[p];
            //          for (const suit in this.crowns[p])
            //             tokens[suitOrder.indexOf(suit)]++;
        } else {
            const myboard = this.board[player];
            for (let d = 0; d < this.districts; d++) {
                for (let c = 0; c < myboard[d].length; c++) {
                    const mycard = myboard[d][c];
                    if (mycard[0] === rank.toString()) {
                        //Correct rank, so collect the suits.
                        tokens[suitOrder.indexOf(mycard[1])]++;
                        if (rank > 1) {
                            tokens[suitOrder.indexOf(mycard[2])]++;
                        }
                    }
                }
            }
        }
        //TODO: test return condition to "log" gains?
        this.credit(tokens, player);
        
        return;
    }

    private credit(tokenArray: number[], player: playerid): boolean {
        //Debits and credits are forumlated as arrays of 6 numbers.
        //Credits should never fail.
        return this.edit(1, tokenArray, player);
    }

    private credit1(suit: string, player: playerid): boolean {
        //Wrapper function for trades.
        const tokenArray: number[] = Array(6).fill(0);
        tokenArray[suitOrder.indexOf(suit)]++;
        return this.credit(tokenArray, player);
    }

    private debit(tokenArray: number[], player: playerid): boolean {
        //Debits and credits are forumlated as arrays of 6 numbers.
        return this.edit(-1, tokenArray, player);
    }
/*    
    private debit3(suit: string, player: playerid): void {
        //Wrapper function for trades.
        const tokenArray: number[] = Array(6).fill(0);
        tokenArray[suitOrder.indexOf(suit)] = 3;
        this.debit(tokenArray, player);
        return;
    }
*/
    private edit(operation: number, tokenArray: number[], player: playerid): boolean {
        //Debits and credits are forumlated as arrays of 6 numbers.
        const playerIdx = player - 1;
        const tokens = this.tokens[playerIdx];

        if (operation === -1) {
            //Test before editing.  There is no going into debt in Magnate.
            if (tokens.filter( (value, index) => tokenArray[index] > value ).length > 0)
                return false;
        }

        //Safe to edit.
        tokens.forEach((value, index) => {
            tokens[index] = value + (tokenArray[index] * operation);
        });
            
        return true;
    }

    private drawUp(): void {
        //First, try to draw what we need from the deck.
        const toDraw = this.variants.includes("mega") ? 2 : 1;
        let drawn = this.deck.draw(Math.min(this.deck.size, toDraw)).map(c => c.uid);

        drawn.forEach(c => this.hands[this.currplayer - 1].push(c));
        
        if (drawn.length === toDraw)
            return;

        const stillToDraw = toDraw - drawn.length;

        if (this.shuffled) {
            return;
        } else {
            //Can shuffle the discards, once.
            this.discards.forEach( card => {
                this.deck.addOne(card);
            });
            this.discards = [];
            this.deck.shuffle();

            this.shuffled = true;
            this.results.push({type: "deckDraw"});

            //Draw the rest.
            drawn = this.deck.draw(Math.min(this.deck.size, stillToDraw)).map(c => c.uid);
            drawn.forEach(c => this.hands[this.currplayer - 1].push(c));
        }
        return;
    }

    private getDeedCard(district: string, player: playerid): string {
        //Check if a district has a deed.
        //Inefficient, but in practice there should only be a handful to check.
        let deeded = "";
        this.deeds[player - 1].forEach((deed, key) => {
            if (deed.district === district)
                deeded = key;
        }); 

        return deeded;
    }

    private hasDeed(district: string, player: playerid): boolean {
        //Check if a district has a deed.
        let deeded = false;
        this.deeds[player - 1].forEach((deed) => {
            //We don't care about the keys.
            if (deed.district === district)
                deeded = true;
        }); 

        return deeded;
    }

    private matched(card1: string, card2: string): boolean {
        const c1 = Card.deserialize(card1);
        const c2 = Card.deserialize(card2);
        
        //This shouldn't happen.
        if (c1 === undefined || c2 === undefined)
            return false;

        //This should only happen in a particular order but whatevs.
        if (c1.rank.name === "Excuse" || c2.rank.name === "Excuse")
            return true;
        
        return c1.sharesSuitWith(c2);
    }

    /*    private nameCard(card: string): string {
    //Wrapper for the usual card stringifier.
    const cardObj = Card.deserialize(card)!;
    return cardObj.name;
    }

    private nameDistrict(district: string): string {
    //Need handles for districts that are
    //independent of coordinates and rotations.
    const card = this.board[0][this.algebraic2coord(district)];
    return this.nameCard(card);
    }
    */

    public parseMove(submove: string): IMagnateMove {
        //Parse a substring into an IMagnateMove object.
        //Does only structural validation.
        //Expects at leat a choice of move type (X:).

        //Because the Excuse and Crowns don't appear in moves, 
        // the card format is: 
        const cardex = /^(\d?[A-Z]{1,2}[1-2]||[A-Z]{4}[1-2])$/;
        //The cell format is: 
        const cellex = /^[a-j]$/;
        //The suit format is: 
        const suitex = /^[MSVLYK][2-8]?$/;
        //A regex to check for illegal characters is:
        const illegalChars = /[^A-Za-n1-9:,]/;

        //The move formats depend on the main action:
        // Buy:    card, district, spend
        // Deed:   card, district
        // Sell:   card
        // Add:    card, spend
        // Trade:  suit, suit
        // Prefer: card, suit
        // Error:  for internal use only

        const mm: IMagnateMove = {
            type: "E",
            valid: false
        }

        //Once we have a legit type we can default to valid = true.
        
        //Incomplete starts out undefined.
        //A partial submove that can't be submitted is set to incomplete.

        //Check for legal characters.
        if (illegalChars.test(submove)) {
            mm.valid = false;
            return mm;
        }

        let card, district, suit: string;

        //Next, split the string on type.
        const typed = submove.split(/:/);

        if (typed.length < 2) {
            //Malformed move string.  We require at least X:
            mm.valid = false;
            return mm;
        }

        //Next, split the string on type.
        const type = typed[0];
        if (moveTypes.indexOf(type) < 0) {
            //Malformed move string.  We require at least X:
            mm.valid = false;
            return mm;
        } else {
            mm.type = type;
            mm.valid = true;
        }

        //That may be everything.
        if (typed[1] === "") {
            mm.incomplete = true;
            return mm;
        }

        //Split the remaining items.
        const split = typed[1].split(",");

        if ( split[0] === "" ) {
            //Malformed move string.  We require at least X:
            mm.valid = false;
            return mm;
        }
        
        //The only case without a card.
        if (type === "T") {
            const value = split.shift()!;
            if (! suitex.test(value) ) {
                //Malformed suit string.
                mm.valid = false;
                return mm;
            } else {
                mm.spend = this.spender([value]);
            }
        } else {
            card = split.shift()!;
            if (! cardex.test(card) ) {
                //Malformed card.
                mm.valid = false;
                return mm;
            } else {
                mm.card = card;
            }
        }

        //The only case without more info.
        if ( type === "S" ) {
            mm.incomplete = false;
            return mm;
        } else if ( split.length === 0 || split[0] === "" ) {
            mm.incomplete = true;
            return mm;
        }

        //The district cases.
        if ( type === "B" || type === "D" ) {
            district = split.shift()!;
            if (! cellex.test(district) ) {
                //Malformed district.
                mm.valid = false;
                return mm;
            } else {
                mm.district = district; 
            }
        } else if ( type === "T" || type === "P" ) {
            //The suit cases har har.
            suit = split.shift()!;
            if (! suitex.test(suit) ) {
                //Malformed suit.
                mm.valid = false;
                return mm;
            }  else {
                mm.suit = suit; 
            }
        } //Skipping add for a minute.

        if ( type === "D" || type === "T" || type === "P" ) {
            //These cases are now complete.
            mm.incomplete = false;
            return mm;
        }

        //Only tokens left...if that.
        if ( split.length === 0 || split[0] === "" ) {
            mm.incomplete = true;
            return mm;
        }

        if ( split.filter(s => ! suitex.test(s)).length > 0 ) {
            //Malformed suit.
            mm.valid = false;
            return mm;
        }

        //amalgamapping the spend
        mm.spend = this.spender(split);
        
        //Finished buy and add cases.
        mm.incomplete = false;
        return mm;
    }

    private reportCard(card: string): string {
        return card.substring(0,card.length - 1);
    }
    
    private removeCard(card: string, arr: string[]): boolean {
        //Remove a card from an array.
        //It's up to the caller to put the card somewhere else.
        const index = arr.indexOf(card);
        if (index > -1) {
            arr.splice(index, 1);
            return true;
        } //else...
        return false;
    }

    private spender(values: string[]): number[] {
        const spend: number[] = Array(6).fill(0);

        values.forEach(value => {
            const suit = value[0];
            const quantity = value.length > 1 ? parseInt(value[1],10) : 1;
            spend[suitOrder.indexOf(suit)] += quantity;
        });
 
        return spend;
    }
    

    
    //Not autopassing (or passing) so don't need a moves function?
    public moves(player?: playerid): string[] {
        if (this.gameover) {
            return [];
        }

        if (player === undefined) {
            player = this.currplayer;
        }

        const moves: string[] = [];

        return moves.sort((a,b) => a.localeCompare(b));
    }

    public randomMove(): string {
        //TODO: mega version requires cloning.

        //We can generate a random move from the player's hand.
        const handCount = (this.variants.includes("mega") ? 6 : 3);
        const randomIndex = Math.floor(Math.random() * handCount);

        const card = this.hands[this.currplayer - 1][randomIndex];
        //The default is to sell it.
        let move: string = "";

        const rando = Math.random();
        if (rando < 0.8) {
            //Test if the card can be placed. 
            for (let d = 0; d < this.districts; d++) {
                const dist = this.coord2algebraic(d);
                if (move === "") {
                    if (this.canPlace(card, dist)) {
                        //No economy testing:  40% buy, 40% deed, 20% sell.
                        if (rando < 0.4 || card[0] === "2") //Can't deed a 2.
                            move = "B:" + card + "," + dist;//Need suits.
                        else 
                            move = "D:" + card + "," + dist;
                    }
                }
            }
        }
        /*
        //Test if the card can be paid for outright. If so, play it.
        if (this.canPay(card)) {
        return card + d; //+ "payment here";
        } else if (this.canDeed(card)) {
        //If the card can be deeded, 50/50 chance of deeding it or selling it.                  
        if (Math.random() < 0.5) {
        return card; //+ "deed payment here";
        }
        } // else fall through
        */
        
        if (move === "")
            move = "S:" + card;

        return move;
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        //First click should be on a move button.
        //Subsequent clicks should be:
        // * hand card > district > tokens (if not autocompleted)
        // * hand card > district (deeds)
        // * hand card (sales)
        // * deed card > add tokens
        // * token pile > token pile (for trades)
        // * deed card > preferred suit
        
        try {
            let newmove = "";
            // clicking on hand pieces or token pieces.
            //console.log(row, col, piece);
            if (row < 0 && col < 0) {
                if (piece?.startsWith("_btn_")) {
                    const type = piece.split("_")[2].charAt(0);
                    if (move && move.endsWith(":"))
                        newmove = `${move.substring(0,move.length - 2)}${type}:`;
                    else if (move)
                        newmove = `${move}/${type}:`;
                    else
                        newmove = `${type}:`;
                } else if (!move) {
                    //it's too early to click on other stuff.
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.magnate.INITIAL_BUTTON_INSTRUCTIONS")
                    }
                } else if (piece?.startsWith("k")) {
                    //clicking a hand card
                    const card = piece.split("k")[1];
                    newmove = `${move}${card},`;
                } else if (piece?.startsWith("s")) {
                    //clicking a suit token.
                    const suit = piece.charAt(1);
                    newmove = `${move}${suit},`;
                } 
            } else {
                // otherwise, clicked on the board
                if (!move) {
                    //it's too early to click on other stuff.
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.magnate.INITIAL_BUTTON_INSTRUCTIONS")
                    }
                } else if (move && move.endsWith("/")) {
                    //it's too early to click on other stuff.
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.magnate.BUTTON_INSTRUCTIONS")
                    }
                } else if (piece?.startsWith("k")) {
                    //clicking a deed card
                    const card = piece.split("k")[1];
                    newmove = `${move}${card},`;
                } else if (move && move.endsWith(":")) {
                    //it's too early to click on a district,
                    //unless you misclicked a card.
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.magnate.DEEDED_CARD_INSTRUCTIONS")
                    }
                } else {
                    const district = this.coord2algebraic(col);
                    newmove = `${move}${district},`;
                }
            }
            
            const result = this.validateMove(newmove) as IClickResult;
            if (! result.valid) {
                result.move = "";
                //TODO: Revert latest addition to newmove.
                //newmove.includes(",") ? newmove.substring(0,newmove.lastIndexOf(",")) : (newmove.includes(":") ? newmove.split(":")[0] : "");
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

        if (this.gameover) {
            if (m.length === 0) {
                result.message = "";
            } else {
                result.message = i18next.t("apgames:MOVES_GAMEOVER");
            }
            return result;
        }

        m = m.replace(/\s+/g, "");

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation.magnate.INITIAL_BUTTON_INSTRUCTIONS")
            return result;
        }

        //If the move is complicated, we need a clone here.
        const cloned = Object.assign(new MagnateGame(), deepclone(this) as MagnateGame);

        const moves: string[] = m.split("/");

        if (moves[moves.length - 1] === "") {
            //Trim the dummy move.
            //Could also test that the last character of m is a /.
            moves.length--;
        }
        
        for (let s = 0; s < moves.length; s++) {
            let action = moves[s];
            //Trim any dangling commas.
            if (action[action.length - 1] === ",")
                action = action.substring(0,action.length - 1);

            //Parse.
            const pact = cloned.parseMove(action);
            //console.log(pact);
            if (pact.valid === false) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.magnate.INVALID_MOVE", {move: action});
                return result;
            }

            //Low-hanging fruit.
            if (pact.type === "T") {
                if (pact.spend === undefined) {
                    result.valid = true;
                    result.complete = -1;
                    result.message = i18next.t("apgames:validation.magnate.SPEND_INSTRUCTIONS");
                    return result;
                }
                //TODO: Would be quicker to change debit to return success or failure.
                //Credit should always succeed.
                const suitIndex = pact.spend.indexOf(3);
                if (suitIndex < 0 || pact.spend.reduce((cur,acc) =>
                    cur + acc, 0) !== 3 ) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.magnate.MALFORMED_TRADE");
                    return result;
                } else if ( cloned.tokens[cloned.currplayer - 1][suitIndex] < 3 ) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.magnate.INVALID_TRADE");
                    return result; 
                }

                //Dock the cloned user (for subsequent submove validation).
                cloned.debit(pact.spend,cloned.currplayer);

                if (pact.suit === undefined) {
                    result.valid = true;
                    result.complete = -1;
                    result.message = i18next.t("apgames:validation.magnate.TOKEN_TRADE_INSTRUCTIONS");
                    return result;
                }

                //Credit the user (for subsequent submove validation).
                cloned.credit1(pact.suit, cloned.currplayer);
                
            } else {//In all other cases we should have a card.
                if (pact.card === undefined) {
                    result.valid = true;
                    result.complete = -1;
                    
                    if (pact.type ===  "A" || pact.type === "P" ) 
                        result.message = i18next.t("apgames:validation.magnate.DEEDED_CARD_INSTRUCTIONS");
                    else
                        result.message = i18next.t("apgames:validation.magnate.HAND_CARD_INSTRUCTIONS");
                       
                    return result;
                }

                if ( pact.type === "A" || pact.type === "P" ) {
                    //Card must be deeded.
                    if (! cloned.deeds[cloned.currplayer - 1].has(pact.card)) {
                        result.valid = false;
                        result.message = i18next.t("apgames:validation.magnate.NOT_DEEDED");
                        return result; 
                    } //nothing is done to the card per se
                    
                } else if ( pact.type === "B" || pact.type === "D" || pact.type === "S" ) {

                    if ( cloned.hands[cloned.currplayer - 1].indexOf(pact.card) < 0 ) {
                        result.valid = false;
                        result.message = i18next.t("apgames:validation.magnate.NOT_IN_HAND");
                        return result; 
                    } else {
                        //We can remove the card now (for ongoing validation).
                        cloned.removeCard(pact.card, cloned.hands[cloned.currplayer - 1]);
                    }
                }
                        
                //In all remaining cases we need to know the card's suits.  We make the array version.
                const tokens = Array(6).fill(0);
                const cardObj = Card.deserialize(pact.card)!;

                //We pause for a corner case.
                if ( pact.type === "D" && cardObj.rank.seq === 2 ) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.magnate.INVALID_DEED_TWO");
                    return result; 
                }
                
                const suitIdxs = cardObj.suits.map(s => s.seq - 1);
                suitIdxs.forEach(suitIdx => tokens[suitIdx]++);

                //Aces vary.  Set it up now.
                if (cardObj.rank.name === "Ace") {
                    if ( pact.type === "B") {
                        //Aces cost three tokens of the same suit.
                        tokens[suitIdxs[0]]++;
                    } else if ( pact.type === "D") {
                        //Aces may be deeded for one token, though that's deeply misguided.
                        tokens[suitIdxs[0]]++;
                    } else if ( pact.type === "S") {
                        //Aces pay two tokens of the same suit.
                        tokens[suitIdxs[0]]++;
                    }
                }

                if ( pact.type === "P" ) {
                    if ( pact.suit === undefined ) {
                        result.valid = true;
                        result.complete = -1;
                        result.canrender = true;
                        result.message = i18next.t("apgames:validation.magnate.PREFER_SUIT_INSTRUCTIONS");
                        return result;
                    } else {
                        //Test suit against card using tokens.
                        const suitIdx = suitOrder.indexOf(pact.suit);
                        if ( tokens[suitIdx] === 0 ) {
                            result.valid = false;
                            result.message = i18next.t("apgames:validation.magnate.INVALID_SUIT");
                            return result; 
                        } else {
                            //We set the preference,
                            //just in case we ever figure out a display for it.
                            const deed = cloned.deeds[cloned.currplayer - 1].get(pact.card)!;
                            deed.suit = pact.suit;
                            cloned.deeds[cloned.currplayer - 1].set(pact.card, deed)!;                   
                        }
                    }
                }
                
                if ( pact.type === "S" ) {
                    //We're done. Credit (for ongoing validation).
                    cloned.credit(tokens, cloned.currplayer);
                }

                if ( pact.type === "B" || pact.type === "D" ) {
                    //Need to check the district.
                    if (! pact.district ) {
                        result.valid = true;
                        result.complete = -1;
                        result.message = i18next.t("apgames:validation.magnate.DISTRICT_INSTRUCTIONS");
                        return result; 
                    } else if (! cloned.canPlace(pact.card, pact.district) ) {
                        result.valid = false;
                        result.message = i18next.t("apgames:validation.magnate.INVALID_PLACEMENT");
                        return result; 
                    } //The district is good.
                    
                    if ( pact.type === "D" ) {
                        //Test if we're done.
                        if (! cloned.debit(tokens, cloned.currplayer) ) {
                            result.valid = false;
                            result.message = i18next.t("apgames:validation.magnate.INVALID_DEED");
                            return result; 
                        } else {
                            //Debited and districted.  Need a deed.
                            const deed: DeedContents = {
                                district: pact.district,
                                tokens: [0,0,0]
                            }
                            
                            cloned.deeds[cloned.currplayer - 1].set(pact.card, deed);
                        }
                    }
                }

                //Now for the (variably) spendy actions.
                
                
            }
        }

        // we're good!
        result.valid = true;
        result.complete = 1;
        result.message = i18next.t("apgames:validation._general.VALID_MOVE");
        return result;
    }

    public move(m: string, {trusted = false, partial = false} = {}): MagnateGame {
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
        //this.highlights = [];

        //TODO!

        const actions = m.split("/");

        for (let a = 0; a < actions.length; a++) {
            const action = actions[a];
            const pact = this.parseMove(action);

            //Low-hanging fruit.
            if (pact.type === "T") {
                if (pact.spend !== undefined) {
                    this.debit(pact.spend,this.currplayer);

                    if (pact.suit !== undefined) {
                        this.credit1(pact.suit, this.currplayer);
                        this.results.push({
                            type: "convert",
                            what: suitOrder[pact.spend.indexOf(3)],
                            into: pact.suit
                        });
                    }
                }
            }
            
            if ( pact.card && ( pact.type === "B" || pact.type === "D" || pact.type === "S" ) ) {
                this.removeCard(pact.card, this.hands[this.currplayer - 1]);

                if (pact.type === "S") {
                    this.discards.push(pact.card);

                    //TODO: Profit!

                    
                    this.results.push({
                        type: "place",
                        what: pact.card,
                        where: "discards"
                    });

                } else if (pact.district) {
                    
                    const col = this.algebraic2coord(pact.district);
                    if (pact.type === "D") {
                        //create  a deed
                        const deed = {
                            district: pact.district,
                            tokens: [0,0,0],
                        };
                        this.deeds[this.currplayer - 1].set(pact.card, deed);
                        
                    } else {
                        if (pact.type === "B") {
                            this.board[this.currplayer][col].push(pact.card);
                        }

                        this.results.push({
                            type: "place",
                            what: pact.card,
                            where: pact.district,
                            how: pact.type
                        });
            
                    }
                }
            }

            if ( pact.card && ( pact.type === "A" || pact.type === "P" ) ) {
                const deed = this.deeds[this.currplayer - 1].get(pact.card)!;
                if (pact.type === "P" && pact.suit !== undefined) {
                    deed.suit = pact.suit;
                    this.deeds[this.currplayer - 1].set(pact.card, deed);                

                }
            }
        }

        if (partial) { return this; }

        // draw up
        this.drawUp();

        // update currplayer
        this.lastmove = m;
        //this.lastroll = this.roll;

        //reroll the dice
        this.lastroll = this.roller();
        //We don't report this roll until the beginning of the next turn.
        if (this.lastroll.length > 1) {
            //The taxman cometh.
            for (let t = 1; t <= this.lastroll.length; t++) {
                for (let p = 0; p < 2; p++) {
                    if (this.tokens[p][this.lastroll[t] - 1] > 1)
                        this.tokens[p][this.lastroll[t] - 1] = 1;
                }
            }
        }
        
        for (let p = 1; p <= 2; p++) {
            this.collectOn(this.lastroll[0], p as playerid);
        }
        
        // update currplayer
        let newplayer = (this.currplayer as number) + 1;
        if (newplayer > this.numplayers) {
            newplayer = 1;
        }
        this.currplayer = newplayer as playerid;

        this.checkEOG();
        this.saveState();
        return this;
    }

    protected checkEOG(): MagnateGame {
        const finalHandSize = (this.variants.includes("mega") ? 4 : 2);
        //May not be exactly equal in mega.
        if (this.deck.size === 0 && this.hands[0].length <= finalHandSize && this.hands[1].length <= finalHandSize) {
            this.gameover = true;
            const scores: IScores[] = this.getPlayersScores();
            if (scores[0] === scores[1]) {
                //Evaluate tiebreaker.
                this.winner = this.getTieWinner();
            } else {
                //Simple win.
                const winner = scores[0] > scores[1] ? 1 : 2;
                this.winner.push(winner as playerid);
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

    public state(opts?: {strip?: boolean, player?: number}): IMagnateState {
        const state: IMagnateState = {
            game: MagnateGame.gameinfo.uid,
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
                    //Hide hands.
                    mstate.hands[p - 1] = mstate.hands[p - 1].map(() => "");
                    //Hide prefs.
                    mstate.deeds[p - 1].forEach( value => value.suit = undefined );
                    //Tokens are public information.
                }
                return mstate;
            });
        }
        return state;
    }

    public moveState(): IMoveState {
        return {
            _version: MagnateGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            board: deepclone(this.board) as [string[], string[][], string[][]],
            crowns: [[...this.crowns[0]],[...this.crowns[1]]],
            deeds: [new Map(this.deeds[0]),new Map(this.deeds[1])],
            discards: [...this.discards],
            hands: this.hands.map(h => [...h]),
            tokens: [[...this.tokens[0]],[...this.tokens[1]]],
            shuffled: this.shuffled,
            //roll: [...this.roll],
            lastroll: [...this.lastroll],
            lastmove: this.lastmove,
        };
    }

    private getMaxDistrictSize(player: number): number {
        //Gets max district size (disregarding deeds).
        let max = 0;
        const board = this.board[player];
        for (let d = 0; d < this.districts; d++) {
            const districtLength = board ? (board[d] ? board[d].length : 0) : 0;
            max = Math.max(districtLength, max);
        }
        return max;
    }

    private renderDecktetGlyph(card: Card, deed?: DeedContents, border?: boolean, opacity?: number, fill?: string|number): [Glyph, ...Glyph[]] {
        //Refactored from the toGlyph method of Card for opacity, verticality, deed tokens, etc.
        if (border === undefined) {
            border = false;
        }
        if (opacity === undefined) {
            opacity = 0;
        }
        const glyph: [Glyph, ...Glyph[]] = [
            {
                name: border ? "piece-square" : "piece-square-borderless",
                scale: border? 1.1 : 1,
                colour: "_context_background",
            },
        ]
        // rank
        if (card.rank.glyph !== undefined) {
            glyph.push({
                name: card.rank.glyph,
                scale: 0.5,
                colour: "_context_strokes",
                nudge: {
                    dx: 250,
                    dy: -250,
                },
                orientation: "vertical",
                opacity: opacity,
            });
        }
        const nudges: [number,number][] = [[-250, -250], [-250, 250], [250, 250]];
        for (let i = 0; i < card.suits.length; i++) {
            const suit = card.suits[i];
            const nudge = nudges[i];
            if ( deed && deed.suit && deed.suit === suit.uid )
                glyph.push({
                    name: "piece",
                    scale: 0.5,
                    nudge: {
                        dx: nudge[0],
                        dy: nudge[1],
                    },
                    colour: suitColors[suit.seq - 1],
                    opacity: opacity,
                });
            else if ( deed ) // && tokens[i] > 0)
                glyph.push({
                    name: "piece-borderless",
                    scale: 0.5,
                    nudge: {
                        dx: nudge[0],
                        dy: nudge[1],
                    },
                    colour: suitColors[suit.seq - 1],
                    opacity: opacity,
                });


            glyph.push({
                name: suit.glyph,
                scale: 0.5,
                nudge: {
                    dx: nudge[0],
                    dy: nudge[1],
                },
                orientation: "vertical",
                opacity: opacity,
            });

            if (deed && deed.tokens) // && deed.tokens[i] > 0)
                glyph.push({
                    text: deed.tokens[i].toString(),
                    scale: 0.5,
                    nudge: {
                        dx: nudge[0],
                        dy: nudge[1],
                    },
                    orientation: "vertical",
                    colour: "#000"
                });
            
        }
        return glyph;
    }
    
    private renderableCards(): Card[] {
        //Init draw deck and hands.
        const deckCount = (this.variants.includes("mega") ? 2 : 1);
        const renderDeck = this.initDeck(deckCount, true);

        return renderDeck.cards;
    }

    private renderPlayerPieces(player: number, maxRows: number): string[] {
        const pstra: string[] = [];

        //A player's tableau.
        const board = this.board[player];
        for (let r = 0; r <= maxRows; r++) {
            const row = [];
            for (let d = 0; d < this.districts; d++) {
                if (board[d].length > r) {
                    const c = board[d][r];
                    row.push("k" + c);
                } else if (board[d].length === r) {
                    //Check for a deed.
                    const dist = this.coord2algebraic(d);
                    if (this.hasDeed(dist, player as playerid)) {
                        const c = this.getDeedCard(dist, player as playerid);
                        row.push("k" + c);
                    } else {
                        row.push("-");
                    }
                } else {
                    row.push("-");
                }
            }
            pstra.push(row.join(","));
        }

        return pstra;
    }
    
    public render(): APRenderRep {

        //Need to determine the number of rows every time.
        const p1rows = this.getMaxDistrictSize(1);
        const p2rows = this.getMaxDistrictSize(2);
        const centerrow = p2rows + 1;
        const rows = p1rows + p2rows + 3;

        //Player 2 on top.
        let pstrArray = this.renderPlayerPieces(2, p2rows);
        //Invert here.
        pstrArray.reverse();

        //the center row
        const row = [];
        for (let bc = 0; bc < this.districts; bc++) {
            const c = this.board[0][bc];
            row.push("k" + c);
        }
        pstrArray.push(row.join(","));

        //Player 1 below.
        const pstr1 = this.renderPlayerPieces(1, p2rows);
        pstrArray = pstrArray.concat(pstr1);
        
        const pstr = pstrArray.join("\n");

        
        // Mark live spots, deeds, and control.
        const markers: (MarkerOutline|MarkerFlood)[] = [];

        let sideboard = this.board[1];
        const points1 = [];
        for (let col = 0; col < this.districts; col++) {
            const rawrow = sideboard[col] ? sideboard[col].length : 0;
            points1.push({col: col, row: rawrow + centerrow + 1} as RowCol);
        }
        markers.push({
            type: "flood",
            colour: 1,
            opacity: 0.15,
            points: points1 as [RowCol, ...RowCol[]],
        });
        
        sideboard = this.board[2];
        const points2 = [];
        for (let col = 0; col < this.districts; col++) {
            const rawrow = sideboard[col] ? sideboard[col].length : 0;
            points2.push({col: col, row: centerrow - rawrow - 1} as RowCol);
        }
        markers.push({
            type: "flood",
            colour: 2,
            opacity: 0.15,
            points: points2 as [RowCol, ...RowCol[]],
        });

        const controlled = this.getDistrictsWinners();
        controlled.forEach((dc, i) => {
            if (dc > 0)
                markers.push({
                    type: "outline",
                    colour: dc,
                    points: [{col: i, row: centerrow}] as [RowCol, ...RowCol[]],
                });
        });
        
        // Build legend of most cards, including an Excuse.
        const allcards = this.renderableCards();
        
        const legend: ILegendObj = {};
        for (const card of allcards) {
            let glyph = card.toGlyph({border: true});

            // the pawny pieces and the excuse (center row)
            if (card.rank.uid === this.pawnrank || card.rank.name === "Excuse") {
                glyph = card.toGlyph({border: false, fill: {
                    func: "flatten",
                    fg: "_context_labels",
                    bg: "_context_background",
                    opacity: 0.2,
                }});
            } else if ( this.deeds[0].has(card.uid) ) {
                //TODO: a function that also handles the suit counts.
                glyph = this.renderDecktetGlyph(card, this.deeds[0].get(card.uid), true, 0.33);
            } else if ( this.deeds[1].has(card.uid) ) {
                //TODO: a function that also handles the suit counts.
                glyph = this.renderDecktetGlyph(card, this.deeds[1].get(card.uid), true, 0.33);
            }
            
            legend["k" + card.uid] = glyph;
        }

        //Suit tokens
        
        for (let s = 0; s < 6; s++) {
            const suit = suits[s];
            
   /*         legend["s" + suit.uid] = {
                name: suit.glyph!,
                scale: 0.5
            }
   */         
            const color = suitColors[s];
            for (let p = 0; p < 2; p++) {
                const pcount = this.tokens[p][s];
                const lname = "s" + suit.uid + (p + 1).toString();

                legend[lname] = [
                    {
                        name: "piece",
                        scale: 0.75,
                        colour: color,
                        opacity: 0.75,
                        nudge: {
                            dx: 0,
                            dy: 100,
                        }
                    },
                    {
                        name: suit.glyph!,
                        scale: 0.60,
                        opacity: 0.3,
                        nudge: {
                            dx: 0,
                            dy: 125,
                        }
                    },
                    {
                        text: pcount.toString(),
                        scale: 0.70,
                        colour: "#000",
                        nudge: {
                            dx: 0,
                            dy: 100,
                        }
                    }
                ];

                if (this.crowns[p][s] === 2) {
                    
                    legend[lname].push(
                        {
                            name: "decktet-crown",
                            scale: 0.30,
                            colour: "_context_strokes",
                            nudge: {
                                dx: -275,
                                dy: -625,
                            }
                        }
                    );
                    legend[lname].push(
                        {
                            name: "decktet-crown",
                            scale: 0.30,
                            colour: "_context_strokes",
                            nudge: {
                                dx: 275,
                                dy: -625,
                            }
                        }
                    );
                    
                } else if (this.crowns[p][s] === 1) {
                    
                    legend[lname].push(
                        {
                            name: "decktet-crown",
                            scale: 0.30,
                            colour: "_context_strokes",
                            nudge: {
                                dx: 0,
                                dy: -650,
                            }
                        }
                    );
                
                } //End crown additions.
            } //end p
        } //end suit
    
        if (this.lastroll[0] < 10) {
            legend["Die"] = {
                name: `d6-${this.lastroll[0]}`
            };
        } else {
            legend["Die"] = [
                {
                    name: "d6-empty"
                },
                {
                    text: "10",
                    scale: 0.70,
                    colour: "_context_strokes",
                }
            ];
        }
        
        legend["Tax"] = {
            name: "d6-empty"
        };
        legend["TaxTax"] = {
            name: "d6-empty"
        };

        if (this.lastroll.length > 1) {

            legend["Tax"] = [
                {name: "d6-empty", colour: "_context_background"},
                {name: suits[this.lastroll[1] - 1].glyph!, scale: 0.75}
            ];

            //Note that the taxtax variant does not always result in double taxation.
            if (this.lastroll.length > 2) {
                legend["TaxTax"] = [
                    {name: "d6-empty", colour: "_context_background"},
                    {name: suits[this.lastroll[2] - 1].glyph!, scale: 0.75}
                ];
            }
        }

        /* add glyph for empty discard
           legend["discard"] = [
           {name: "d6-empty", colour: "_context_background"},
           {text: "$$", scale: 0.9}
           ];*/

        // build pieces areas
        const areas: (AreaPieces|AreaKey|AreaButtonBar)[] = [];

        //hands
        for (let p = 1; p <= this.numplayers; p++) {
            const hand = this.hands[p - 1].map(c => "k" + (c === "" ? "UNKNOWN" : c));
            const tokens = this.tokens[p - 1].map((cnt, idx) => "s" + suitOrder[idx] + p.toString());
            const width = this.variants.includes("mega") ? 12 : 9;

            //This should always be true.
            if (hand.length + tokens.length > 0) {
                
                areas.push({
                    type: "pieces",
                    pieces: hand.concat(tokens) as [string, ...string[]],
                    label: i18next.t("apgames:validation.magnate.LABEL_BOTH", {playerNum: p}) || `P${p}'s Hand and Tokens`,
                    spacing: 0.25,
                    width: width,
                    ownerMark: p
                });
            }/*
               if (tokens.length > 0) {
               areas.push({
               type: "pieces",
               pieces: tokens as [string, ...string[]],
               label: i18next.t("apgames:validation.magnate.LABEL_COLLECTION", {playerNum: p}) || `P${p} Tokens`,
               spacing: 0.25,
               width: 6
               //ownerMark: p
               });
               }*/
        }

        //Build die roll area
        areas.push({
            type: "key",
            list: this.variants.includes("taxtax") ? [
                {
                    piece: "Die",
                    name: ""
                },
                {
                    piece: "Tax",
                    name: ""
                },
                {
                    piece: "TaxTax",
                    name: ""
                }
            ] : [
                {
                    piece: "Die",
                    name: ""
                },
                {
                    piece: "Tax",
                    name: ""
                }
            ],
            position: "right",
            clickable: false,
            height: 1
        });
        //Button area.
        areas.push({                      
            type: "buttonBar",
            position: "left",
            height: 0.75,
            buttons: [
                {
                    label: "Buy"
                },
                {
                    label: "Deed"
                },
                {
                    label: "Sell"
                },
                {
                    label: "Add"
                },
                {
                    label: "Trade"
                },
                {
                    label: "Prefer"
                },
            ]
        });

        //discards
        if (this.discards.length > 0) {
            areas.push({
                type: "pieces",
                pieces: this.discards.map(c => "k" + c) as [string, ...string[]],
                label: i18next.t("apgames:validation.magnate.LABEL_DISCARDS") || "Discards",
                spacing: 0.25,
                width: this.districts + 2,
            });
        }

        const remaining = this.deck.clone().draw(this.deck.size).sort(cardSortAsc).map(c => "k" + c.uid) as [string, ...string[]];

        //const remaining = allcards.sort(cardSortAsc).filter(c => visibleCards.find(cd => cd!.uid === c.uid) === undefined).map(c => "k" + c.uid)
        if (remaining.length > 0) {
            areas.push({
                type: "pieces",
                label: i18next.t("apgames:validation.frogger.LABEL_REMAINING") || "Cards in deck",
                spacing: 0.25,
                width: this.districts + 2,
                pieces: remaining,
            });
        }

        // Build rep
        const rep: APRenderRep =  {
            //options: ["hide-labels-half"],
            board: {
                style: "squares",
                width: this.districts,
                height: rows,
                tileHeight: 1,
                tileWidth: 1,
                tileSpacing: 0.15,
                strokeOpacity: 0,
                rowLabels: [],
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
            /*
              for (const move of this.results) {
              if (move.type === "place") {
              const [x, y] = this.algebraic2coord(move.where!);
              rep.annotations.push({type: "enter", occlude: false, dashed: [6,8], targets: [{row: y, col: x}]});
              } else if (move.type === "move") {
              const [fromX, fromY] = this.algebraic2coord(move.from);
              const [toX, toY] = this.algebraic2coord(move.to);
              rep.annotations.push({type: "move", targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
              rep.annotations.push({type: "enter", occlude: false, targets: [{row: toY, col: toX}]});
              } else if (move.type === "swap") {
              const [x, y] = this.algebraic2coord(move.where!);
              rep.annotations.push({type: "enter", occlude: false, dashed: [2,4], targets: [{row: y, col: x}]});
              }
              }*/
        }

        return rep;
    }

    /* scoring functions */
    private getAceScore(index: number, playernum: number, c1: Card): number {
        let acescore = 0;
        const myDistrict = this.board[playernum][index];
        for (let c = 0; c < myDistrict.length; c++) {
            const c2 = Card.deserialize(myDistrict[c])!;
            if (c1.sharesSuitWith(c2))
                acescore++;
        }

        if (this.variants.includes("deucey")) {
            //Ace variant with more matches.
            const c2 = Card.deserialize(this.board[0][index])!;
            if (c1.sharesSuitWith(c2))
                acescore++;

            const them = playernum === 1 ? 2 : 1; 
            const theirDistrict = this.board[them][index];
            for (let c = 0; c < theirDistrict.length; c++) {
                const c2 = Card.deserialize(theirDistrict[c])!;
                if (c1.sharesSuitWith(c2))
                    acescore++;
            }
        }

        return acescore;
    }

    private getDistrictScoreForPlayer(district: string, player: playerid): number {
        const index = this.algebraic2coord(district);
        const myDistrict = this.board[player as number][index];
        let subscore = 0;
        for (let c = 0; c < myDistrict.length; c++) {
            const card = Card.deserialize(myDistrict[c])!;
            if (card.rank.name === "Ace")
                subscore += this.getAceScore(index, player, card);
            else 
                subscore += Math.ceil(card.rank.seq); //Rounds all "Courts" up to 10. 
        }
        return subscore;
    }

    private getDistrictWinner(district: string): number {
        //Determines district control.
        const control = this.getDistrictScoreForPlayer(district,1) - this.getDistrictScoreForPlayer(district,2);
        return control > 0 ? 1 : (control < 0 ? 2 : 0); 
    }

    private getDistrictsTotals(): number[] {
        //Determines district control.
        const controllers: number[] = [0,0,0];
        for (let d = 0; d < this.districts; d++) {
            const controller = this.getDistrictWinner(this.coord2algebraic(d));
            controllers[controller]++;
        }
        controllers.shift();
        return controllers;
    }

    private getDistrictsWinners(): number[] {
        //Determines district control.
        const controllers: number[] = [];
        for (let d = 0; d < this.districts; d++) {
            const controller = this.getDistrictWinner(this.coord2algebraic(d));
            controllers.push(controller);
        }
        return controllers;
    }

    private getTieWinner(): playerid[] {
        //Evaluate first tiebreaker.
        let tieWinner: playerid[] = [];
        const tieArray: number[][] = [[],[]];
        for (let p = 1; p <=2; p++) {
            tieArray[0][p - 1] = this.getTotalScore(p as playerid);
            tieArray[1][p - 1] = this.tokens[p - 1].reduce(
                (acc, cur) => acc + cur,
                0
            );
        }
        const winArray = tieArray.filter( arry => arry[0] !== arry [1] ).map( arry => arry[0] - arry[1]);

        if (winArray.length === 0) {
            tieWinner = [1,2] as playerid[];
        } else {
            tieWinner.push((winArray[0] > 0 ? 1 : 2) as playerid);
        }
        return tieWinner;
    }

    private getTotalScore(player: playerid): number {
        //TODO.
        let total = 0;
        for (let d = 0; d < this.districts; d++) {
            const dist = this.coord2algebraic(d);
            total += this.getDistrictScoreForPlayer(dist, player)
        }
        return total;
    }

    public getPlayersScores(): IScores[] {
        let scores: string[] = [];
        const districts: number[] = this.getDistrictsTotals();
        scores = districts.map((s, i) => 
            s + " (" + this.getTotalScore((i + 1) as playerid) + ")"
                              );
        return [
            { name: i18next.t("apgames:status.SCORES"), scores },
        ];
    }

    /* end scoring functions */

    public status(): string {
        let status = super.status();

        status += "**Scores**: " + this.getPlayersScores()[0].scores.join(", ") + "\n\n";

        return status;
    }

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "roll":
                // eslint-disable-next-line no-case-declarations
                const or = [...r.values];
                if (or.length === 1)
                    node.push(i18next.t("apresults:ROLL.magnate", {player, values: or[0]}));
                else 
                    node.push(i18next.t("apresults:ROLL.magnate", {player, values: `${or.shift()} with taxation on ${or.map(digit => suits[digit].name).join(" and ")}.`}));
                resolved = true;
                break;
            case "announce": //gains on roll?
                node.push(i18next.t("apresults:ANNOUNCE.magnate", {player, payload: r.payload}));
                resolved = true;
                break;
            case "place":
                // eslint-disable-next-line no-case-declarations
                const whatCard = this.reportCard(r.what!);
                if (r.where === "discards")
                    node.push(i18next.t("apresults:PLACE.magnate_sell", {player, what: whatCard}));
                else if (r.how === "D")
                    node.push(i18next.t("apresults:PLACE.magnate_deed", {player, where: r.where, what: whatCard}));
                else
                    node.push(i18next.t("apresults:PLACE.magnate_buy", {player, where: r.where,  what: whatCard}));
                resolved = true;
                break;
            case "convert": //Complete deed.
                if (r.into) 
                    node.push(i18next.t("apresults:CONVERT.magnate_trade", {player, what: r.what, into: r.into}));
                else
                    node.push(i18next.t("apresults:CONVERT.magnate_deed", {player, what: r.what, where: r.where}));
                resolved = true;
                break;
            case "deckDraw": //For the single shuffle.
                node.push(i18next.t("apresults:DECKDRAW.magnate"));
                resolved = true;
                break;
            case "eog":
                node.push(i18next.t("apresults:EOG.default"));
                resolved = true;
                break;
        }

        return resolved;
    }

    public clone(): MagnateGame {
        return Object.assign(new MagnateGame(), deepclone(this) as MagnateGame);
    }
}
