import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaPieces, Glyph, MarkerFlood, MarkerOutline } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, SquareOrthGraph, UserFacingError } from "../common";
import i18next from "i18next";
import { Card, Deck, cardSortAsc, cardsBasic, cardsExtended } from "../common/decktet";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2;
export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: Map<string, string>;
    market: string[];
    occupied: Map<string, playerid>;
    captured: [Suit[], Suit[]];
    lastmove?: string;
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
        flags: ["scores", "random-start", "custom-randomization", "experimental"],
    };
    public static coords2algebraic(x: number, y: number): string {
        return GameBase.coords2algebraic(x, y, 6);
    }
    public static algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, 6);
    }

    public numplayers = 2;
    public currplayer: playerid = 1;
    public board!: Map<string, string>;
    public market!: string[];
    public occupied!: Map<string, playerid>;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    public captured!: [Suit[], Suit[]];

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

            const fresh: IMoveState = {
                _version: DeckfishGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board,
		market,
                occupied,
                captured: [[],[]],
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
        this.board = new Map(state.board);
	this.market = [...state.market];
        this.occupied = new Map(state.occupied);
        this.captured = [[...state.captured[0]], [...state.captured[1]]];
        this.lastmove = state.lastmove;

        return this;
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

    private get mode(): "place"|"collect" {
        if (this.occupied.size < 6) {
            return "place";
        }
        return "collect";
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
            for (let x = 0; x < 7; x++) {
                for (let y = 0; y < 6; y++) {
                    const cell = DeckfishGame.coords2algebraic(x, y);
		    if (this.board.has(cell)) {
			const card = Card.deserialize(this.board.get(cell)!)!;
			//Check occupation.
			if (! this.occupied.has(cell)) {
			    //Check rank.
			    if (card.rank.name === "Ace" || card.rank.name === "Crown") {
				moves.push(`${cell}`);
			    }
			}
		    }
                }
            }
	    console.log(moves);
        }
        // otherwise collecting
        else {
	    //push some moves
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

        m = m.toLowerCase();
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

        const [mv, sw] = m.split(",");
        // eslint-disable-next-line prefer-const
        let [from, to] = mv.split("-");
        //card = card.toUpperCase();

	//Testing placements.
	if (this.mode === "place") {
	    console.log("Place at " + from);

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

        // if `to` is missing, partial
        if (to === undefined || to.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation.deckfish.PARTIAL_PLACEMENT");
            return result;
        }

        // if `sw` is missing, possibly partial
        if (sw === undefined || sw.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation._general.PARTIAL_MOVEMENT", {cell: to});
            return result;
 
	} else {

	    //otherwise
            let [swap, market] = sw.split("-");


            const g = new SquareOrthGraph(6, 7);
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
                result.message = i18next.t("apgames:validation.deckfish.NOT_ADJ");
                return result;
            }

            // if swap is missing, may or not be complete
            if (swap === undefined || swap.length === 0) {
                result.valid = true;
                result.canrender = true;
                result.complete = 0;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            }
            // otherwise
            else {
                const cloned = this.clone();
//                cloned.board.set(to, card);
                // valid cell
                if (!(g.listCells(false) as string[]).includes(to)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation._general.INVALIDCELL", {cell: swap});
                    return result;
                }
                // card present
                if (! cloned.board.has(swap)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation._general.UNOCCUPIED", {cell: swap});
                    return result;
                }
                // not occupied
                if (cloned.occupied.has(swap)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.deckfish.ALREADY_OCCUPIED", {cell: swap});
                    return result;
                }
                // not owned
                if (!cloned.canSwap(swap, market)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.deckfish.ALREADY_OWNED", {cell: swap});
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

    public move(m: string, {trusted = false, partial = false, emulation = false} = {}): DeckfishGame {
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
        const [mv, swap] = m.split(",");
        // eslint-disable-next-line prefer-const
        let [from, to] = mv.split("-");

        if (to !== undefined && to.length > 0) {
            //this.board.set(to, card);
            this.results.push({type: "move", from: from, to: to});
            if (swap !== undefined && swap.length > 0) {
                //swap market card
                this.results.push({type: "swap", what: "TODO", with: "TODO", where: to});
            }
        } else {
	    if (this.mode === "place") {
		this.occupied.set(from, this.currplayer);
		this.results.push({type: "place", where: from});
	    }
	}

        if (partial) { return this; }

        // update currplayer
        this.lastmove = m;
        let newplayer = (this.currplayer as number) + 1;

	if ((to === undefined || to.length === 0) && m !== "pass" && this.mode === "collect") {
	    //We changed mode after the final placement of the place phase, so do not change player.
	    newplayer  = this.currplayer;
	} 

        if (newplayer > this.numplayers) {
            newplayer = 1;
        }
        this.currplayer = newplayer as playerid;

        this.checkEOG();
        this.saveState();
        return this;
    }

    protected checkEOG(): DeckfishGame {
        if (false) {
            this.gameover = true;
            const scores: number[] = [];
            for (let p = 1; p <= this.numplayers; p++) {
                scores.push(this.getPlayerScore(p));
            }
            const max = Math.max(...scores);
            for (let p = 1; p <= this.numplayers; p++) {
                if (scores[p-1] === max) {
                    this.winner.push(p as playerid);
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
            lastmove: this.lastmove,
            board: new Map(this.board),
	    market: [...this.market],
            occupied: new Map(this.occupied),
            captured: [[...this.captured[0]],[...this.captured[1]]],
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
                // otherwise create new marker
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
        for (const card of allcards) {
            legend["c" + card.uid] = card.toGlyph();
        }

        // build pieces areas
        const areas: AreaPieces[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            let captives = this.captured[p-1];
            if (captives.length > 0) {
                areas.push({
                    type: "pieces",
                    pieces: captives.map(c => "c" + c) as [string, ...string[]],
                    label: i18next.t("apgames:validation.deckfish.LABEL_STASH", {playerNum: p}) || "local",
                    spacing: 0.5,
                });
            }
        }
        // create an area for all invisible cards (if there are any cards left)
        const visibleCards = [...this.board.values()].map(uid => Card.deserialize(uid));
        if (visibleCards.includes(undefined)) {
            throw new Error(`Could not deserialize one of the cards. This should never happen!`);
        }
        const remaining = allcards.sort(cardSortAsc).filter(c => visibleCards.find(cd => cd!.uid === c.uid) === undefined).map(c => "c" + c.uid) as [string, ...string[]]
        if (remaining.length > 0) {
            areas.push({
                type: "pieces",
                label: i18next.t("apgames:validation.deckfish.LABEL_MARKET") || "Market cards",
                spacing: 0.25,
                pieces: remaining,
            });
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
                strokeOpacity: 0.5,
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
                    // only add if there's not a claim for the same cell
                    const found = this.results.find(r => r.type === "claim" && r.where === move.where);
                    if (found === undefined) {
                        const [x, y] = DeckfishGame.algebraic2coords(move.where!);
                        rep.annotations.push({type: "enter", occlude: false, targets: [{row: y, col: x}]});
                    }
                } else if (move.type === "claim") {
                    const [x, y] = DeckfishGame.algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", occlude: false, dashed: [4,8], targets: [{row: y, col: x}]});
                }
            }
        }

        return rep;
    }

    public getPlayerScore(player: number): number {
        let score = 0;
	//TODO: get min of suits
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

        //status += "**Influence**: " + this.influence.join(", ") + "\n\n";

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
            case "move":
                node.push(i18next.t("apresults:MOVE.deckfish", {player, from: r.from, to: r.to}));
                resolved = true;
                break;
            case "swap":
                node.push(i18next.t("apresults:SWAP.deckfish", {player, what: r.what, with: r.with, where: r.where}));
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): DeckfishGame {
        return Object.assign(new DeckfishGame(), deepclone(this) as DeckfishGame);
    }
}
