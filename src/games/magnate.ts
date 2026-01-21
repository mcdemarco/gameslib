import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaPieces, Glyph, MarkerFlood, RowCol } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";
import { Card, Deck, cardSortAsc, cardsBasic, cardsExtended, suits } from "../common/decktet";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2;
export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";
//Deeds: the owner, the column, an array of sheltered resources, and a preferred suit (to simplify resource collection).
export type DeedContents = {
    player: playerid,
    district: string,
    tokens: number[],
    suit?: Suit
};

const suitOrder = ["M","S","V","L","Y","K"];

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: [string[], string[][], string[][]];
    crowns: string[][];
    deeds: Map<string, DeedContents>;
    discards: string[];
    hands: string[][];
    tokens: [number[], number[]];
    shuffled: boolean;
    lastmove?: string;
};

export interface IMagnateState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

interface ILegendObj {
    [key: string]: Glyph|[Glyph, ...Glyph[]];
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
        //notes: "apgames:notes.magnate",
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
        return (x + 1).toString();
    }
    public algebraic2coord(district: string): number {
        return parseInt(district, 10) - 1;
    }

    public numplayers = 2;
    public currplayer: playerid = 1;
    public board: [string[], string[][], string[][]] = [[],[],[]];
    public crowns: string[][] = [];
    public deeds!: Map<string, DeedContents>;
    public discards: string[] = [];
    public hands: string[][] = [];
    public tokens: [number[], number[]] = [[], []];
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

            for (let c = 0; c < handCount; c++) {
                for (let p = 0; p < 2; p++) {
                    const [card] = crownDeck.draw();
                    crowns[p][c] = card.uid;
                    const suit = card.suits.map(s => s.uid)[0];
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
                deeds: new Map(), 
                discards: [],
                hands,
                tokens,
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
        this.deeds = new Map(state.deeds);
        this.discards = [...state.discards];
        this.hands = state.hands.map(h => [...h]);
        this.tokens = [[...state.tokens[0]], [...state.tokens[1]]];
        this.lastmove = state.lastmove;

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

        this.deeds.forEach((value, key) => this.deck.remove(key));

        this.deck.shuffle();

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

    private matched(card1: string, card2: string): boolean {
        const c1 = Card.deserialize(card1);
        const c2 = Card.deserialize(card2);

        if (c1 === undefined || c2 === undefined)
            return false;
        
        if (c1.rank.name === "Excuse" || c2.rank.name === "Excuse")
            return true;

        return c1.sharesSuitWith(c2);
    }

    /*
    private canTrade(suit: string): boolean {
        //TODO: Test if this player can trade for a suit.
        
        return !!(suit);
    }
*/    
    private hasDeed(district: string, player: playerid): boolean {
        //Check if a district has a deed.
        //Inefficient, but in practice there should only be a handful to check.
        let deeded = false;
        this.deeds.forEach((deed) => {
            //We don't care about the keys.
            if (deed.player === player && deed.district === district)
                deeded = true;
        }); 

        return deeded;
    }
    
    private getDeedCard(district: string, player: playerid): string {
        //Check if a district has a deed.
        //Inefficient, but in practice there should only be a handful to check.
        let deeded = "";
        this.deeds.forEach((deed, key) => {
            if (deed.player === player && deed.district === district)
                deeded = key;
        }); 

        return deeded;
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
        
        //Test if the card can be placed. 
        for (let d = 1; d <= this.districts; d++) {
            if (this.canPlace(card, d.toString())) {
                //No economy testing:  40% build, 40% deed, 20% sell.
                const rando = Math.random();

                if (rando < 0.4)
                    return card + ">" + d;
                else if (rando < 0.4)
                    return card + ">" + d + "d";
                else
                    break;
                
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

            }
        }
        
        //Otherwise, sell it.
        return card + ">$"; //No payment means a sale?
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
        this.removeCard(card, this.hands[this.currplayer]);

        if (destination === "$") {
            //TODO: Profit!
            this.discards.push(card);
        } else {
            const district = destination.split("d")[0];
            const col = this.algebraic2coord(district);
            if (district !== destination) {
                //create  a deed
                const deed = {
                    player: this.currplayer,
                    district: district,
                    tokens: [0,0,0],
                };
                this.deeds.set(card, deed);
            } else {
                this.board[this.currplayer][col].push(card);
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

    protected checkEOG(): MagnateGame {
        const finalHandSize = (this.variants.includes("mega") ? 4 : 2);
        //May not be exactly equal in mega.
        if (this.deck.size === 0 && this.hands[0].length <= finalHandSize && this.hands[1].length <= finalHandSize) {
            this.gameover = true;
            const scores: number[] = [];
            for (let p = 1; p <= this.numplayers; p++) {
                scores.push(this.getPlayerScore(p));
            }
            if (scores[0] === scores[1]) {
                //Evaluate tiebreaker.
                this.winner = this.getTieWinner();
            } else {
                //Simple win.
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
            deeds: new Map(this.deeds),
            discards: [...this.discards],
            hands: this.hands.map(h => [...h]),
            tokens: [[...this.tokens[0]],[...this.tokens[1]]],
            shuffled: this.shuffled,
            lastmove: this.lastmove,
         };
    }

    private getMaxDistrictSize(player: number): number {
        //Gets max district size (disregarding deeds).
        //Add one later for deeds.
        let max = 0;
        let board = this.board[player];
        for (let d = 0; d < this.districts; d++) {
            //const deed = this.hasDeed(d, player as playerid) ? 1 : 0;
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

    private renderPieces(): string {
        const pstr: string[] = [];

        //Player two's tableau.
        const p2rows = this.getMaxDistrictSize(2);
        let board = this.board[2];
        for (let r = 0; r <= p2rows; r++) {
            const row = [];
            for (let b2 = 0; b2 < this.districts; b2++) {
                if (board[b2].length > r) {
                    const c = board[b2][r];
                    row.push("c" + c + "r");
                } else if (board[b2].length === r) {
                    //Check for a deed.
                    const dist = this.coord2algebraic(b2);
                    if (this.hasDeed(dist, 2)) {
                        const c = this.getDeedCard(dist, 2);
                        row.push("c" + c);
                    } else {
                        row.push("-");
                    }
                } else {
                    row.push("-");
                }
            }
            pstr.push(row.join(","));
        }

        //Invert here.
        pstr.reverse();

        //the center row
        const row = [];
        for (let bc = 0; bc < this.districts; bc++) {
            const c = this.board[0][bc];
            row.push("c" + c);
        }
        pstr.push(row.join(","));

        //Player one's tableau.
        const p1rows = this.getMaxDistrictSize(1);
        board = this.board[1];
        for (let r = 0; r <= p1rows; r++) {
            const row = [];
            for (let b1 = 0; b1 < this.districts; b1++) {
                if (board[b1].length > r) {
                    const c = board[b1][r];
                    row.push("c" + c);
                } else if (board[b1].length === r) {
                    //Check for a deed.
                    const dist = this.coord2algebraic(b1);
                    if (this.hasDeed(dist, 1)) {
                        const c = this.getDeedCard(dist, 1);
                        row.push("c" + c);
                    } else {
                        row.push("-");
                    }
                } else {
                    row.push("-");
                }
            }
            pstr.push(row.join(","));
        }
        
        return pstr.join("\n");
    }
    
    public render(): APRenderRep {

        //Need to determine the number of rows every time.
        const p1rows = this.getMaxDistrictSize(1);
        const p2rows = this.getMaxDistrictSize(2);
        const centerrow = p2rows + 2;
        const rows = p1rows + p2rows + 3;
        
        // No pieces on the board, just markers.
        const pstr = this.renderPieces();
        console.log(pstr);

        // Mark live spots and deeds.
        const markers: MarkerFlood[] = [];

        let sideboard = this.board[1];
        const points1 = [];
        for (let col = 0; col < this.districts; col++) {
            const rawrow = sideboard[col] ? sideboard[col].length : 0;
            points1.push({col: col, row: rawrow + centerrow} as RowCol);
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
            points2.push({col: col, row: centerrow - rawrow - 2} as RowCol);
        }
        markers.push({
            type: "flood",
            colour: 2,
            opacity: 0.15,
            points: points2 as [RowCol, ...RowCol[]],
        });
        
        // Build legend of most cards, including an Excuse.
        const allcards = this.renderCards();
        
        const legend: ILegendObj = {};
        for (const card of allcards) {
            let glyph = card.toGlyph({border: true});
            let cardui = card.uid;

            // the pawny pieces and the excuse (center row)
            if (card.rank.uid === this.pawnrank || card.rank.name === "Excuse") {
                 glyph = card.toGlyph({border: false, fill: {
                    func: "flatten",
                    fg: "_context_labels",
                    bg: "_context_background",
                    opacity: 0.2,
                 }});
            }
            legend["c" + cardui] = glyph;
        }

        //console.log(legend["c01"]);

        for (const suit of suits) {
            legend[suit.uid] = {
                name: suit.glyph!,
                scale: 0.5
            }
        }

        // build pieces areas
        const areas: AreaPieces[] = [];

        //hands
        for (let p = 1; p <= this.numplayers; p++) {
            const hand = this.hands[p - 1];
            if (hand.length > 0) {
                areas.push({
                    type: "pieces",
                    pieces: hand.map(c => "c" + (c === "" ? "UNKNOWN" : c)) as [string, ...string[]],
                    label: i18next.t("apgames:validation.magnate.LABEL_HAND", {playerNum: p}) || `P${p} Hand`,
                    spacing: 0.5,
                    ownerMark: p
                });
            }
        }

        //discards
        if (this.discards.length > 0) {
            areas.push({
                type: "pieces",
                pieces: this.discards.map(c => "c" + c) as [string, ...string[]],
                label: i18next.t("apgames:validation.magnate.LABEL_DISCARDS") || "Discards",
                spacing: 0.25,
                width: this.districts + 2,
            });
        }

        const remaining = this.deck.clone().draw(this.deck.size).sort(cardSortAsc).map(c => "c" + c.uid) as [string, ...string[]];


        //const remaining = allcards.sort(cardSortAsc).filter(c => visibleCards.find(cd => cd!.uid === c.uid) === undefined).map(c => "c" + c.uid)
        if (remaining.length > 0) {
            areas.push({
                type: "pieces",
                label: i18next.t("apgames:validation.frogger.LABEL_REMAINING") || "Cards in deck",
                spacing: 0.25,
                width: this.districts + 2,
                pieces: remaining,
            });
        }

/*
        // suits
        for (let p = 1; p <= this.numplayers; p++) {
            const captive = this.tokens[p-1].reduce((partialSum, a) => partialSum + a, 0);
            if (captive > 0) {
                const indexBySize = this.tokens[p-1].map((val, idx) => idx).sort((a, b) => this.tokens[p-1][a] - this.tokens[p-1][b]);
                const captives: string[] = [];
                indexBySize.forEach(idx => {
                    const cnt = this.tokens[p-1][idx];
                    if (cnt > 0) {
                        for (let c = 0; c<cnt; c++)
                            captives.push(suitOrder[idx]);
                    }
                });
                areas.push({
                    type: "pieces",
                    pieces: captives as [string, ...string[]],
                    label: i18next.t("apgames:validation.magnate.LABEL_COLLECTION", {playerNum: p}) || `P${p} suits`,
                    spacing: -0.25,
                    ownerMark: p,
                    width: 16,
                });
            }
        }
*/
        
        // Build rep
        const rep: APRenderRep =  {
            options: ["hide-labels"],
            board: {
                style: "squares",
                width: this.districts,
                height: rows,
                tileHeight: 1,
                tileWidth: 1,
                tileSpacing: 0.15,
                strokeOpacity: 0,
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

    private getTieWinner(): playerid[] {
        //Evaluate tiebreaker.
        let tieWinner: playerid[] = [];
        //Sort.
        const sortedArrays = this.tokens.map(collection => [...collection].sort((a,b) => a - b));
        //Subtract.
        const winArray = sortedArrays[0].map((item, index) => item - (sortedArrays[1])[index]).filter((item) => item !== 0);

        if (winArray.length === 0) {
            tieWinner = [1,2] as playerid[];
        } else {
            tieWinner.push((winArray[0] > 0 ? 1 : 2) as playerid);
        }
        return tieWinner;
    }

    public getPlayerScore(player: number): number {
        //gets min of suits
        const score = [...this.tokens[player - 1]].sort((a,b) => a - b)[0];
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

    public status(): string {
        let status = super.status();

        status += "**Scores**: " + this.getPlayersScores()[0].scores.join(", ") + "\n\n";

        return status;
    }

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "place":
                node.push(i18next.t("apresults:PLACE.magnate", {player, where: r.where}));
                resolved = true;
                break;
            case "pie":
                node.push(i18next.t("apresults:PIE.magnate", {player}));
                resolved = true;
                break;
            case "move":
                node.push(i18next.t("apresults:MOVE.magnate", {player, from: r.from, to: r.to, what: r.what}));
                resolved = true;
                break;
            case "eject":
                node.push(i18next.t("apresults:EJECT.magnate", {player, from: r.from, to: r.to}));
                resolved = true;
                break;
            case "swap":
                node.push(i18next.t("apresults:SWAP.magnate", {player, what: r.what, with: r.with, where: r.where}));
                resolved = true;
                break;
            case "pass":
                node.push(i18next.t("apresults:PASS.simple", {player}));
                resolved = true;
                break;
            case "announce":
                node.push(i18next.t("apresults:ANNOUNCE.magnate", {player, payload: r.payload}));
                resolved = true;
                break;
            case "eog":
                node.push(i18next.t("apresults:EOG.magnate", {player}));
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): MagnateGame {
        return Object.assign(new MagnateGame(), deepclone(this) as MagnateGame);
    }
}
