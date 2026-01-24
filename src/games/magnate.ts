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
export type moveType = "B"|"D"|"S"|"A"|"T"|"P";
//Deeds: the column, an array of added resources, and a preferred suit (to simplify resource collection).
export type DeedContents = {
    district: string,
    tokens: number[],
    suit?: string
};

const suitOrder = suits.map(suit => suit.uid); //["M","S","V","L","Y","K"];
const columnLabels = "abcdefghij".split("");

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: [string[], string[][], string[][]];
    crowns: string[][];
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
/*
interface IMagnateMove {
    type: string;
    card?: string;
    district?: string;
    spend: string[];
    gain: string;
    incomplete: boolean;
    valid: boolean;
}
*/
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
    public crowns: string[][] = [];
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
            const crowns: [string[], string[]] = [[],[]];
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
                    crowns[p][c] = suit;
                    tokens[p][suitOrder.indexOf(suit)]++;
                    if (lastroll[0] === 10) //Christmas!
                        tokens[p][suitOrder.indexOf(suit)]++;
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
        this.crowns = state.crowns.map(c => [...c]);
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
        const p = player - 1;
        //Special ranks:
        if (rank === 10) {
            //Crownmas for everyone.
            for (let suit in this.crowns[p])
                this.tokens[p][suitOrder.indexOf(suit)]++;
        } else {
            const myboard = this.board[player];
            for (let d = 0; d < this.districts; d++) {
                for (let c = 0; c < myboard[d].length; c++) {
                    const mycard = myboard[d][c];
                    if (mycard[0] === rank.toString()) {
                        //Correct rank, so collect the suits.
                        this.tokens[p][suitOrder.indexOf(mycard[1])]++;
                        if (rank > 1) {
                            this.tokens[p][suitOrder.indexOf(mycard[2])]++;
                        }
                    }
                }
            }
        }
        
        return;
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
/*
    public parseMove(submove: string): IMagnateMove {
        //Parse a substring into an IMagnateMove object.
        //Does only structural validation.

        //Because the Excuse and the Crowns don't appear in moves, 
        // the card format is: 
        const cardex = /^(\d?[A-Z]{1,2}[1-2]||[A-Z]{3}[1-2])$/;
        //The cell format is: 
        const cellex = /^[a-j]$/;
        //A regex to check for illegal characters (except !) is:
        const illegalChars = /[^A-Za-n1-9:,-]/;

        //The move formats depend on the main action:
        // Buy:    card, district, <tokens>
        // Deed:   card, district, suit preference?
        // Sell:   card
        // Add:    district, <tokens>
        // Trade:  suit, suit
        // Prefer: district, suit

        let mv, from, to, card;
        
        const imm: IMagnateMove = {
            incomplete: false,
            valid: true
        }

        return imm;
    }
*/

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

        //move format: card>district,d?
        //sell format: card>$
        
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
                            move = card + ">" + dist;
                        else 
                            move = card + ">" + dist + "D";
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
            move = card + ">$";

        return move;
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        //First click should be on a hand card, deed, or token pieces (3 or more for trading).
        //Subsequent clicks should be:
        // * hand card > district > tokens (if not autocompleted)
        // * hand card > discards
        // * deed > payment tokens
        // * token pile > bank (for suit selection)
        
        try {
            let newmove = "";
            // clicking on hand pieces or token pieces.
            if (row < 0 && col < 0) {
                if (! move.includes("-")) {
                    //it's too early to click on the market.
                    //TODO: invalid partial result
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.magnate.EARLY_TO_MARKET")
                    }
                } else if (move.includes(",")) {
                    //it's too late to click on the market.
                    //TODO: invalid partial result
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.magnate.LATE_TO_MARKET")
                    }
                } else {
                    newmove = `${move}`; //+ this.coord2algebraic(this.market.indexOf(piece!.substring(1)));
                }
            }
            // otherwise, clicked on the board
            else {
                const district = this.coord2algebraic(col);
                newmove = `${move}-${district}`;
            } 
                /* ???
                return {
                    move,
                    valid: false,
                    message: i18next.t("apgames:validation.magnate.REVERSED_MARKET")
                }*/
 
            const result = this.validateMove(newmove) as IClickResult;
            if (! result.valid) {
                //Revert latest addition to newmove.
                result.move = newmove.includes(",") ? newmove.split(",")[0] : (newmove.includes("-") ? newmove.split("-")[0] : "");
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

        m = m.replace(/\s+/g, "");

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            if (this.stack.length < 2) {
                result.message = i18next.t("apgames:validation.magnate.INITIAL_PLACEMENT_INSTRUCTIONS")
            } else {
                result.message = i18next.t("apgames:validation.magnate.CARD_NOT_DONE_INSTRUCTIONS")
            }
            return result;
        }

        //If the move is complicated, we need a clone here.
        
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
        const [card,destination] = m.split(">");
        this.removeCard(card, this.hands[this.currplayer - 1]);

        if (destination === "$") {
            //TODO: Profit!
            this.discards.push(card);

            this.results.push({
                type: "place",
                what: card,
                where: "discards"
            });
            
        } else {
            const district = destination.split("D")[0];
            const col = this.algebraic2coord(district);
            let type: string;  //Will get this parsing the move later.
            if (district !== destination) {
                type = "D";  //Will get this parsing the move later.
                //create  a deed
                const deed = {
                    district: district,
                    tokens: [0,0,0],
                };
                this.deeds[this.currplayer - 1].set(card, deed);

            } else {
                type = "B";  //Will get this parsing the move later.
                this.board[this.currplayer][col].push(card);
            }

            this.results.push({
                type: "place",
                what: card,
                where: district,
                how: type
            });
                
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
                    mstate.hands[p - 1] = mstate.hands[ p - 1].map(c => "");
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
            crowns: this.crowns.map(c => [...c]),
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

    private renderCards(): Card[] {
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
        let markers: (MarkerOutline|MarkerFlood)[] = [];

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
        const allcards = this.renderCards();
        
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
            }
            legend["k" + card.uid] = glyph;
        }


        //Suit tokens
        
        //Colors taken from the decktet sheet.
        const suitColors: string[] = ["#c7c8ca","#e08426","#6a9fcc","#bc8a5d","#6fc055","#d6dd40"];

        for (let s = 0; s < 6; s++) {
            const suit = suits[s];
            console.log(suit);
            
            legend["s" + suit.uid] = {
                name: suit.glyph!,
                scale: 0.5
            }
            
            const color = suitColors[s];
            const p0count = this.tokens[0][s] ;
            legend["s" + suit.uid + p0count.toString()] = [
                {
                    name: "piece",
                    scale: 1.0,
                    colour: color,
                    opacity: 0.75
                },
                {
                    name: suit.glyph!,
                    scale: 0.75,
                    opacity: 0.3
                },
                {
                    text: p0count.toString(),
                    scale: 0.85,
                    colour: "#000"
                }
            ];
            const p1count = this.tokens[1][s];
            if (p1count !== p0count) {
                legend["s" + suit.uid + p1count.toString()] = [
                    {
                        name: "piece",
                        scale: 1.0,
                        colour: color,
                        opacity: 0.75
                    },
                    {
                        name: suit.glyph!,
                        scale: 0.75,
                        opacity: 0.3
                    },
                    {
                        text: p1count.toString(),
                        scale: 0.85,
                        colour: "#000"
                    }
                ];
            }
        }

        console.log(Object.keys(legend));

        legend["Die"] = {
            name: `d6-${this.lastroll[0]}`
        };
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
            const hand = this.hands[p - 1];
            if (hand.length > 0) {
                areas.push({
                    type: "pieces",
                    pieces: hand.map(c => "k" + (c === "" ? "UNKNOWN" : c)) as [string, ...string[]],
                    label: i18next.t("apgames:validation.magnate.LABEL_HAND", {playerNum: p}) || `P${p} Hand`,
                    spacing: 0.5,
                    ownerMark: p
                });
            }
            const tokens = this.tokens[p - 1].map((cnt, idx) => "s" + suitOrder[idx] + cnt.toString());
            if (tokens.length > 0) {
                areas.push({
                    type: "pieces",
                    pieces: tokens as [string, ...string[]],
                    label: i18next.t("apgames:validation.magnate.LABEL_COLLECTION", {playerNum: p}) || `P${p} Tokens`,
                    spacing: 0.25,
                    width: 6
                    //ownerMark: p
                });
            }
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
            position: "left",
            clickable: false,
            height: 1
        });
        //Button area.
        areas.push({                      
            type: "buttonBar",
            position: "right",
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
                node.push(i18next.t("apresults:CONVERT.magnate", {player,  what: r.what, where: r.where}));
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
