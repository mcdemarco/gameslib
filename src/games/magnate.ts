import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaPieces, Colourfuncs, Glyph, MarkerGlyph } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";
import { Deck, cardsBasic, cardsExtended, suits } from "../common/decktet";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2;
export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";
export type DeedContents = [playerid, number, number[]];

const suitOrder = ["M","S","V","L","Y","K"];
const crowdedRanks = ["Pawn","Court"];

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: [string[], string[][], string[][]];
    crowns: string[][];
    deeds: Map<string, DeedContents>;
    discards: string[];
    hands: string[][];
    tokens: [number[], number[]];
    shuffled: boolean;
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
    private highlights: string[] = [];

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
                if ( d === Math.round(this.districts / 2) ) {
                    board[0][d] = "01"; //the Excuse
                } else {
                    const [card] = districtDeck.draw();
                    board[0][d] = card.uid;
                }
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

    private initDeck(deckCount: number): Deck {
        //Init draw deck and hands.

        //Remove the crowns from the basic deck.
        const cards = [...cardsBasic.filter(c => c.rank.name !== "Crown")];

        //Usually add the courts.
        if (this.variants.includes("courts"))
            cards.push(...[...cardsExtended.filter(c => c.rank.uid === this.courtrank)]);

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

        // Deck is reset every time you load
        const deckCount = (this.variants.includes("mega") ? 2 : 1);
        this.deck = this.initDeck(deckCount);
        
        // remove cards from the deck that are on the board, the discard, or in known hands
        const board = this.board.flat().flat();
        for (const uid of [...board, ...this.discards]) {
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

    public canPlace(district: number): boolean {
        if (false) {
            //Check for a deeded card.
            return false;
        }
        if (false) {
            //Check  for suit mismatch.
            return false;
        }

        return true;
    }

    public moves(player?: playerid): string[] {
        if (this.gameover) {
            return [];
        }

        if (player === undefined) {
            player = this.currplayer;
        }

        const moves: string[] = [];

        // if placing
        if (this.mode === "place") {
            //push all unoccupied aces and crown on the board
            for (let x = 0; x < this.columns; x++) {
                for (let y = 0; y < this.rows; y++) {
                    const cell = this.coords2algebraic(x, y);
                    if (this.board.has(cell) && ! this.occupied.has(cell)) {
                        //There's an unoccupied card.
                        const card = this.getCardFromCell(cell);
                        //Check rank.
                        if (card.rank.name === "Ace" || (card.rank.name === "Crown" && ! this.variants.includes("double"))) {
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
                    //const meepleLoc = this.algebraic2loc(cell);
                    //const suits = this.getSuits(cell);
                    const targets = this.myMoves(cell);
                    //this.assembleTargets(meepleLoc,suits);
                    targets.forEach(t => {
                        moves.push(cell + "-" + t);
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
                    newmove = `${move},` + this.coord2algebraic(this.market.indexOf(piece!.substring(1)));
                }
            }
            // otherwise, clicked on the board
            else {
                const cell = this.coords2algebraic(col, row);
                // continuation of placement
                if (this.mode === "place") {
                    //Selecting initial placement location.
                    newmove = `${cell}`;
                } else if (move === "") {
                    //Selecting initial source location.
                    newmove = `${cell}`;
                } else if (move.includes(",")) {
                    //Selecting market target location.
                    newmove = `${move}-${cell}`;
                } else if (! move.includes("-")) {
                    //Selecting move target location.
                    newmove = `${move}-${cell}`;
                } else {
                    // move includes a dash but not a comma,
                    // trying to click on the board instead of market first.
                    return {
                        move,
                        valid: false,
                        message: i18next.t("apgames:validation.magnate.REVERSED_MARKET")
                    }
                }
            }

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

        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            if (this.mode === "place") {
                result.message = i18next.t("apgames:validation.magnate.INITIAL_PLACEMENT_INSTRUCTIONS")
            } else {
                result.message = i18next.t("apgames:validation.magnate.INITIAL_MOVE_INSTRUCTIONS")
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
                    result.message = i18next.t("apgames:validation.magnate.BAD_PASS");
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
                    result.message = i18next.t("apgames:validation.magnate.BAD_PASS");
                    return result;
                }
            }
        }

        const [mv, sw] = m.split(",");
        // eslint-disable-next-line prefer-const
        let [frm, to] = mv.split("-");
        //card = card.toUpperCase();

        //Testing placements.
        if (this.mode === "place") {
            if (this.occupied.size >= 6) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.magnate.MUST_PASS");
            } else if (this.canPlace(frm)) {
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation.magnate.VALID_PLACEMENT");
            } else {
                result.valid = false;
                if (this.variants.includes("double"))
                    result.message = i18next.t("apgames:validation.magnate.INVALID_PLACEMENT_DOUBLE");
                else
                    result.message = i18next.t("apgames:validation.magnate.INVALID_PLACEMENT");

            }
            return result;
        }
        //Otherwise, collecting.

        // if `to` is missing, partial
        if (to === undefined || to.length === 0) {
            if (this.canMoveFrom(frm)) {
                result.valid = true;
                result.complete = -1;
                result.canrender = true;
                result.message = i18next.t("apgames:validation.magnate.PARTIAL_MOVE");
                return result;
            } else {
                result.valid = false;
                result.message = i18next.t("apgames:validation.magnate.INVALID_FROM");
                return result;
            }
        }

        //Otherwise, evaluate the move destination.
        if (! this.canMoveTo(frm,to)) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.magnate.INVALID_TO", {cell: to});
            return result;
        }

        //Now, swapping.

        // if `sw` is missing, possibly partial
        if (sw === undefined || sw.length === 0) {
            result.valid = true;
            result.complete = 0;
            result.canrender = true;
            result.message = i18next.t("apgames:validation.magnate.INITIAL_SWAP_INSTRUCTIONS");
            return result;

        } else {

            //otherwise
            const [mark, swap] = sw.split("-");

            //A successful market choice is always valid.
            //Need to check the click?
            const marketCard = this.market[this.algebraic2coord(mark)];

            // if swap is missing, may or not be complete
            if (swap === undefined || swap.length === 0) {
                result.valid = true;
                result.canrender = true;
                result.complete = -1;
                result.message = i18next.t("apgames:validation.magnate.PARTIAL_SWAP", {what: marketCard, where: mark});
                return result;
            }
            // otherwise the swap location needs testing.
            else if (! this.board.has(swap)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.magnate.NO_SWAP", {cell: swap});
                return result;
            } else if (this.occupied.has(swap)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.magnate.OCCUPIED_SWAP", {cell: swap});
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
            let [frm, to] = mv.split("-");

            const cardID = this.getIDFromCell(frm);
            if (cardID === undefined)
                throw new Error(`Could not load the card at ${frm}.`);

            this.highlights.push(cardID);

            if (to !== undefined && to.length > 0) {
                //Remove the card.

                this.highlights.push(cardID);
                if (!partial)
                    this.board.delete(frm);

                this.results.push({type: "move", from: frm, to: to, what: this.getUIDFromID(cardID)});

                //Move the piece from
                this.occupied.delete(frm);
                //In the wyrms case, must also bounce another piece out of the way.
                if (this.occupied.has(to)) {
                    const bounceCell = this.bounce(frm, to);
                    this.results.push({type: "eject", from: to, to: bounceCell});
                    const bounceCardID = this.getIDFromCell(bounceCell);
                    this.highlights.push(bounceCardID);
                }

                //Move the piece to
                this.occupied.set(to, this.currplayer);

                //Score the card.
                const card = this.getCardFromID(cardID);
                const newSuits = card.suits.map(s => s.uid as Suit);
                newSuits.forEach(s => {
                    this.tokens[this.currplayer - 1][suitOrder.indexOf(s)]++;
                })

                if (sw !== undefined && sw.length > 0) {
                    const [marketCell, swapCell] = sw.split("-");
                    //highlight market card
                    const marketCard = this.market[this.algebraic2coord(marketCell)];
                    this.highlights.push(marketCard);

                    if (swapCell !== undefined && swapCell.length > 0) {
                        //swap market card
                        const swapCard = this.board.get(swapCell)!;
                        this.highlights.push(swapCard);
                        this.market[this.market.indexOf(marketCard)] = swapCard!;
                        this.board.set(swapCell, marketCard);
                        this.results.push({type: "swap", what: this.getUIDFromID(marketCard), with: this.getUIDFromID(swapCard), where: swapCell});
                    } else {
                        //TODO
                    }
                }
            } else {
                if (this.mode === "place") {
                    this.occupied.set(frm, this.currplayer);
                    this.results.push({type: "place", where: frm});
                } else {
                    //Partial move already illustrated, though a bit flakily.
                    //Highlight potential targets.
                    const potentialTargets = this.myMoves(frm);
                    potentialTargets.forEach(t =>
                        this.highlights.push(this.board.get(t)!)!);
                }
            }
        }

        if (partial) { return this; }

        //update tableau for autopasser
        this.tableau = this.populateTableau();

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
            mode: this.mode,
            lastmove: this.lastmove,
            eliminated: this.eliminated,
            board: new Map(this.board),
            market: [...this.market],
            occupied: new Map(this.occupied),
            tokens: [[...this.tokens[0]],[...this.tokens[1]]],
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
        for (let row = 0; row < this.rows; row++) {
            if (pstr.length > 0) {
                pstr += "\n";
            }
            const pieces: string[] = [];
            for (let col = 0; col < this.columns; col++) {
                const cell = this.coords2algebraic(col, row);
                if (this.occupied.has(cell)) {
                    const card = this.getCardFromCell(cell);
                    const adjust = crowdedRanks.includes(card.rank.name) ? "H" : "";
                    pieces.push(this.occupied.get(cell) === 1 ? "A" + adjust : "B" + adjust);
                } else {
                    pieces.push("-");
                }
            }
            pstr += pieces.join(",");
        }
        // build card markers
        const markers: MarkerGlyph[] = [];
        if (this.board.size > 0) {
            for (const [cell, c] of this.board.entries()) {
                const [x,y] = this.algebraic2coords(cell);
                //const card = this.getCardFromID(c);

                markers.push({
                    type: "glyph",
                    glyph: "c" + c,
                    points: [{row: y, col: x}],
                });
            }
        }
        /*
        if (this.occupied.size > 0) {
           for (const [cell,p] of this.occupied.entries()) {
                const [x,y] = this.algebraic2coords(cell);

                markers.push({
                    type: "outline",
                    colour: p,
                    opacity: 0.2,
                    points: [{row: y, col: x}],
                });
            }
        }
        */

        // build legend of ALL cards, from card ids.
        const allcards = this.getDeck();
        const legend: ILegendObj = {};

        let lastMarketCard = "";
        if (this.highlights.length === 0 && this.lastmove  && this.lastmove.length > 0) {
            const lastMarketCell = this.lastmove!.split(/\W+/).find((elt) => elt[0] == "m");
            if (lastMarketCell)
                lastMarketCard = this.market[this.algebraic2coord(lastMarketCell!)];
        }

        const occupiedCards = new Map<string, playerid>();
        this.occupied.forEach((player,cell) => {
            occupiedCards.set(this.board.get(cell)!,player);
        });

        allcards.forEach(cardID => {
            const card = this.getCardFromID(cardID);
            const border = (this.highlights.indexOf(cardID) > -1 || cardID === lastMarketCard);
            if (occupiedCards.has(cardID)) {
                const player = occupiedCards.get(cardID);
                legend["c" + cardID] = card.toGlyph({border: border, fill: player, opacity: 0.2});
            } else if (this.highlights.indexOf(cardID) > -1 || this.market.indexOf(cardID) > -1) {
                legend["c" + cardID] = card.toGlyph({border: border});
            } else if (this.mode === "place" && card.rank.name === "Ace") {
                legend["c" + cardID] = card.toGlyph({border: border});
            } else if (this.mode === "place" && card.rank.name === "Crown" && ! this.variants.includes("double")) {
                legend["c" + cardID] = card.toGlyph({border: border});
            } else {
                legend["c" + cardID] = card.toGlyph({border: border, fill: "#888", opacity: 0.2});
            }
        });

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
            const marketCards = this.market.map(id => "c" + id) as [string, ...string[]];

            areas.push({
                type: "pieces",
                label: i18next.t("apgames:validation.magnate.LABEL_MARKET") || "Market cards",
                spacing: 0.25,
                pieces: marketCards,
                width: 3,
            });
        }

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

        // Build rep
        const rep: APRenderRep =  {
            board: {
                style: "squares",
                width: this.columns,
                height: this.rows,
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
                    const [x, y] = this.algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", occlude: false, dashed: [6,8], targets: [{row: y, col: x}]});
                } else if (move.type === "move") {
                    const [fromX, fromY] = this.algebraic2coords(move.from);
                    const [toX, toY] = this.algebraic2coords(move.to);
                    rep.annotations.push({type: "move", targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
                    rep.annotations.push({type: "enter", occlude: false, targets: [{row: toY, col: toX}]});
                } else if (move.type === "swap") {
                    const [x, y] = this.algebraic2coords(move.where!);
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

    public getStartingPosition(): string {
        const pcs: string[] = [];
        const board = this.stack[0].board;
        const market = this.stack[0].market;
        for (let x = 0; x < this.columns; x++) {
            for (let y = 0; y < this.rows; y++) {
                const cell = this.coords2algebraic(x, y);
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
