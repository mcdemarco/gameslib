import { GameBase, IAPGameState, IClickResult, IIndividualState, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaPieces, Glyph, MarkerFlood, MarkerOutline, RowCol } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, shuffle, SquareOrthGraph, UserFacingError } from "../common";
import i18next from "i18next";
import { Card, Deck, cardSortAsc, cardSortDesc, cardsBasic, cardsExtended, suits } from "../common/decktet";
import { connectedComponents } from "graphology-components";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const deepclone = require("rfdc/default");

export type playerid = 1|2;
export type Suit = "M"|"S"|"V"|"L"|"Y"|"K";


export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: Map<string, string>;
    claimed: Map<string, playerid>;
    influence: number[];
    captured: [Suit[], Suit[]];
    lastmove?: string;
};

export interface IDeckfishState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

interface IDistrict {
    cells: string[];
    owner?: playerid;
    suit: string;
}

type InfluenceParams = {
    cell: string;
    ds?: IDistrict[];
    player?: playerid;
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
    public claimed!: Map<string, playerid>;
    public influence!: number[];
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    public captured!: [Suit[], Suit[]];
    private deck!: Deck;

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
 
            // init influence and hands
            const influence: number[] = [];

            const claimed = new Map<string, playerid>();

            const fresh: IMoveState = {
                _version: DeckfishGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board,
                claimed,
                influence,
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
        this.claimed = new Map(state.claimed);
        this.influence = [...state.influence];
        this.captured = [[...state.captured[0]], [...state.captured[1]]];
        this.lastmove = state.lastmove;

        // Deck is reset every time you load
        const cards = [...cardsBasic, ...cardsExtended];

        this.deck = new Deck(cards);
        // remove cards from the deck that are on the board or in known hands
        for (const uid of this.board.values()) {
            this.deck.remove(uid);
        }

        this.deck.shuffle();

        return this;
    }

    public getDistricts(): IDistrict[] {
        const districts: IDistrict[] = [];

        for (const suit of suits) {
            const g = new SquareOrthGraph(6, 7);
            for (const node of g.graph.nodes()) {
                if (!this.board.has(node) || !this.board.get(node)!.includes(suit.uid)) {
                    g.graph.dropNode(node);
                }
            }
            const islands = connectedComponents(g.graph);
            for (const isle of islands) {
                const claimedCells = isle.filter(c => this.claimed.has(c));
                if (claimedCells.length === 0) {
                    districts.push({
                        cells: isle,
                        suit: suit.uid,
                    });
                }
                else if (claimedCells.length === 1) {
                    districts.push({
                        cells: isle,
                        suit: suit.uid,
                        owner: this.claimed.get(claimedCells[0])!,
                    });
                }
                else {
                    const claimedCards = claimedCells.map(c => Card.deserialize(this.board.get(c)!)!);
                    claimedCards.sort(cardSortDesc);
                    const winCard = claimedCards[0];
                    const cell = [...this.board.entries()].find(([,v]) => v === winCard.uid)![0];
                    const owner = this.claimed.get(cell)!;
                    districts.push({
                        cells: isle,
                        suit: suit.uid,
                        owner
                    });
                }
            }
        }

        return districts;
    }

    public canInfluence({cell, ds, player}: InfluenceParams): boolean {
        if (this.claimed.has(cell)) {
            return false;
        }
        if (!this.board.has(cell)) {
            return false;
        }
        const uid = this.board.get(cell)!;
        const card = Card.deserialize(uid);
        if (card === undefined) {
            throw new Error(`Could not deserialize the card ${uid}`);
        }
        if (["T", "P", "0"].includes(card.rank.uid)) {
            return false;
        }
        if (ds === undefined) {
            ds = this.getDistricts();
        }
        if (player ===  undefined) {
            player = this.currplayer;
        }
        const contains = ds.filter(d => d.cells.includes(cell));
        let can = true;
        for (const d of contains) {
            if (d.owner !== undefined && d.owner !== player) {
                can = false;
                break;
            }
        }
        return can;
    }

    public randomMove(): string {
        if (true) {
            const g = new SquareOrthGraph(6, 7);
            const empty = shuffle((g.listCells(false) as string[]).filter(c => !this.board.has(c))) as string[];
            if (empty.length > 0) {
                let move = `${empty[0]}`; //`${card}-${empty[0]}`;
                if (this.influence[this.currplayer - 1] > 0 && Math.random() < 0.5) {
                    const ds = this.getDistricts();
                    let poss: string[] = [];
                    for (const occ of this.board.keys()) {
                        if (this.canInfluence({cell: occ, ds})) {
                            poss.push(occ);
                        }
                    }
                    if (poss.length > 0) {
                        poss = shuffle(poss) as string[];
                        move += `,${poss[0]}`;
                    }
                }
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
                const cell = DeckfishGame.coords2algebraic(col, row);
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
            result.message = i18next.t("apgames:validation.deckfish.INITIAL_INSTRUCTIONS")
            return result;
        }

        const [mv, influence] = m.split(",");
        // eslint-disable-next-line prefer-const
        let [card, to] = mv.split("-");
        card = card.toUpperCase();

        // if `to` is missing, partial
        if (to === undefined || to.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.message = i18next.t("apgames:validation.deckfish.PARTIAL_PLACEMENT");
            return result;
        }
        // otherwise
        else {
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

            // if influence is missing, may or not be complete
            if (influence === undefined || influence.length === 0) {
                result.valid = true;
                result.canrender = true;
                result.complete = this.influence[this.currplayer - 1] > 0 ? 0 : 1;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            }
            // otherwise
            else {
                const cloned = this.clone();
                cloned.board.set(to, card);
                // influence available
                if (cloned.influence[this.currplayer - 1] === 0) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.deckfish.NO_INFLUENCE");
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
                if (cloned.claimed.has(influence)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.deckfish.ALREADY_CLAIMED", {cell: influence});
                    return result;
                }
                // not an extended card
                const targetCard = Card.deserialize(cloned.board.get(influence)!);
                if (targetCard === undefined) {
                    throw new Error(`Could not find the card with the ID ${cloned.board.get(influence)}`);
                }
                if (["0", "P", "T"].includes(targetCard.rank.uid)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.deckfish.BAD_INFLUENCE", {cell: influence});
                    return result;
                }
                // not owned
                if (!cloned.canInfluence({cell: influence})) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation.deckfish.ALREADY_OWNED", {cell: influence});
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
        const [mv, influence] = m.split(",");
        // eslint-disable-next-line prefer-const
        let [card, to] = mv.split("-");
        card = card.toUpperCase();
        const cardObj = Card.deserialize(card)!;

        if (to !== undefined && to.length > 0) {
            this.board.set(to, card);
            this.results.push({type: "place", what: cardObj.plain, where: to});
            if (influence !== undefined && influence.length > 0) {
                this.claimed.set(influence, this.currplayer);
                this.influence[this.currplayer - 1]--;
                this.results.push({type: "claim", where: influence});
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
            claimed: new Map(this.claimed),
            influence: [...this.influence],
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

        // build claimed markers
        let markers: (MarkerOutline|MarkerFlood)[]|undefined;
        if (this.claimed.size > 0) {
            markers = [];
            for (const [cell, p] of this.claimed.entries()) {
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

        // add flood markers for controlled districts
        const dsOwned = this.getDistricts().filter(d => d.owner !== undefined);
        if (dsOwned.length > 0) {
            if (markers === undefined) {
                markers = [];
            }
            for (let p = 1; p <= this.numplayers; p++) {
                const owned = dsOwned.filter(d => d.owner === p);
                if (owned.length > 0) {
                    const cells = owned.map(d => d.cells).flat();
                    markers.push({
                        type: "flood",
                        colour: p,
                        opacity: 0.1,
                        points: cells.map(cell => {
                            const [col, row] = DeckfishGame.algebraic2coords(cell);
                            return {col, row};
                        }) as [RowCol, ...RowCol[]],
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
        const ds = this.getDistricts();
        for (const district of ds.filter(d => d.owner === player)) {
            score += district.cells.length;
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
            { name: i18next.t("apgames:status.deckfish"), scores: this.influence},
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

        status += "**Influence**: " + this.influence.join(", ") + "\n\n";

        status += "**Scores**: " + this.getPlayersScores()[0].scores.join(", ") + "\n\n";

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
                node.push(i18next.t("apresults:CLAIM.deckfish", {player, where: r.where}));
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): DeckfishGame {
        return Object.assign(new DeckfishGame(), deepclone(this) as DeckfishGame);
    }
}
