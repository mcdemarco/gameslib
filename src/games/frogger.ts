import { GameBase, IAPGameState, IClickResult, IIndividualState, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaPieces, Glyph, MarkerFlood, MarkerGlyph, RowCol} from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, shuffle, SquareOrthGraph, UserFacingError } from "../common";
import i18next from "i18next";
import { Card, Deck, cardSortAsc, cardsBasic, cardsExtended } from "../common/decktet"; //pending suits

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2|3|4|5;
export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";
const suitOrder = ["M","S","V","L","Y","K"];

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: Map<string, string>;
    hands: string[][];
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
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    private rows: number = 3;
    private deck!: Deck;

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
            //const cells: string[] = ["b1", "c1", "d1", "e1", "f1", "g1", "h1", "i1", "j1", "k1", "l1", "m1"];
	    for (let col = 1; col < 14; col++) {
		const cell = this.coords2algebraic(col, 0);
                const [card] = boardDeck.draw();
                board.set(cell, card.uid);
            }

	    console.log(board);
	    
            // init market and hands
            const hands: string[][] = [];
            for (let i = 0; i < this.numplayers; i++) {
                hands.push([...deck.draw(4).map(c => c.uid)]);
            }

            const fresh: IMoveState = {
                _version: FroggerGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board,
                hands,
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
        this.lastmove = state.lastmove;

	this.rows = Math.max(3, this.numplayers) + 1;

        // Deck is reset every time you load
        const cards = [...cardsBasic];
	//Some board cards, for removal.
	cards.push(...cardsExtended.filter(c => c.rank.uid === "P"));
	
        this.deck = new Deck(cards);
        // remove cards from the deck that are on the board or in known hands
        for (const uid of this.board.values()) {
	    this.deck.remove(uid);
        }
        for (const hand of this.hands) {
            for (const uid of hand) {
                this.deck.remove(uid);
            }
        }
        this.deck.shuffle();

        return this;
    }

    public randomMove(): string {
        if (this.hands[this.currplayer - 1].length > 0) {
            const g = new SquareOrthGraph(6,6);
            const shuffled = shuffle(this.hands[this.currplayer - 1]) as string[];
            const card = shuffled[0];
            const empty = shuffle((g.listCells(false) as string[]).filter(c => !this.board.has(c))) as string[];
            if (empty.length > 0) {
                const move = `${card}-${empty[0]}`;
		return move;
            }
        }
        return "";
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            let newmove = "";
            // clicking on your hand
            if (row < 0 && col < 0) {
                newmove = piece!.substring(1);
            }
            // otherwise, on the board
            else {
                const cell = this.coords2algebraic(col, row);
                // continuation of placement
                if (!move.includes("-")) {
                    newmove = `${move}-${cell}`;
                }
                // otherwise, exerting influence
                else {
                    newmove = `${move},${cell}`;
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

        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation.frogger.INITIAL_INSTRUCTIONS")
            return result;
        }

        const [mv, influence] = m.split(",");
        // eslint-disable-next-line prefer-const
        let [card, to] = mv.split("-");
        card = card.toUpperCase();

        // card is in your hand
        if (!this.hands[this.currplayer - 1].includes(card)) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.frogger.NO_CARD", {card});
            return result;
        }

        // if `to` is missing, partial
        if (to === undefined || to.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation.frogger.PARTIAL_PLACEMENT");
            return result;
        }
        // otherwise
        else {
            const g = new SquareOrthGraph(6,6);
            // valid cell
            if (!(g.listCells(false) as string[]).includes(to)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation._general.INVALIDCELL", {cell: to});
                return result;
            }
            // unoccupied
            if (this.board.has(to)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation._general.OCCUPIED", {cell: to});
                return result;
            }
            // adjacent to existing card
            let hasadj = false;
            for (const n of g.neighbours(to)) {
                if (this.board.has(n)) {
                    hasadj = true;
                    break;
                }
            }
            if (!hasadj) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.frogger.NOT_ADJ");
                return result;
            }

            // if influence is missing, may or not be complete
            if (influence === undefined || influence.length === 0) {
                result.valid = true;
                result.canrender = true;
                result.complete = 0;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            }
            // otherwise
            else {
                const cloned = this.clone();
                cloned.board.set(to, card);
                // influence available
                if (false) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.frogger.NO_INFLUENCE");
                    return result;
                }
                // valid cell
                if (!(g.listCells(false) as string[]).includes(to)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation._general.INVALIDCELL", {cell: influence});
                    return result;
                }
                // card present
                if (! cloned.board.has(influence)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation._general.UNOCCUPIED", {cell: influence});
                    return result;
                }
                // not claimed
                if (false) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.frogger.ALREADY_CLAIMED", {cell: influence});
                    return result;
                }
                // not an extended card
                const targetCard = Card.deserialize(cloned.board.get(influence)!);
                if (targetCard === undefined) {
                    throw new Error(`Could not find the card with the ID ${cloned.board.get(influence)}`);
                }
                if (["0", "P", "T"].includes(targetCard.rank.uid)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.frogger.BAD_INFLUENCE", {cell: influence});
                    return result;
                }
                // not owned
                if (false) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.frogger.ALREADY_OWNED", {cell: influence});
                    return result;
                }

                // we're good!
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            }
        }
    }

    public move(m: string, {trusted = false, partial = false} = {}): FroggerGame {
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
        }

        this.results = [];
        const [mv, influence] = m.split(",");
        // eslint-disable-next-line prefer-const
        let [card, to] = mv.split("-");
        card = card.toUpperCase();
        const cardObj = Card.deserialize(card)!;

        const idx = this.hands[this.currplayer - 1].findIndex(c => c === card);
        if (idx < 0 || influence) {
            throw new Error(`Could not find the card "${card}" in the player's hand. This should never happen.`);
        }
        this.hands[this.currplayer - 1].splice(idx, 1);
        if (to !== undefined && to.length > 0) {
            this.board.set(to, card);
            this.results.push({type: "place", what: cardObj.plain, where: to});
        }

        if (partial) { return this; }

        // draw new card
        const [drawn] = this.deck.draw();
        if (drawn !== undefined) {
            this.hands[this.currplayer - 1].push(drawn.uid);
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
		//console.log(col,row,cell);
                if (this.board.has(cell)) {
                    pieces.push("c" + this.board.get(cell)!);
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

	console.log(this.board);
	console.log(suitOrder,suitColors);
	
	//add flood and suit markers for the active spaces
	for (let col = 1; col < 13; col++) {
	    let row = 0;
	    const cell = this.coords2algebraic(col,row);
	    console.log(col,row,cell,this.board.has(cell),this.board.get(cell));
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

        legend["home"] = {
            name: "streetcar-house",
            scale: 0.75
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
        // create an area for all invisible cards (if there are any cards left)
        const hands = this.hands.map(h => [...h]);
        const visibleCards = [...this.board.values(), ...hands.flat()].map(uid => Card.deserialize(uid));
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
	    options: ["hide-labels"],
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
