import { GameBase, IAPGameState, IIndividualState, IMoveOptions, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, Glyph } from "@abstractplay/renderer/build/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, shuffle, UserFacingError } from "../common";
import { UnboundedSquareBoard } from "../common/unbounded-square-board";
import { Deck, MinorCard, MajorCard, TarotCard, allCards } from "../common/tarot";
import { GnosticaBoard, CellClass } from "./gnostica/board";
import { Territory, ITerritory } from "./gnostica/Territory";
import { Piece, Orientation, cardinalOrientations } from "./gnostica/Piece";
import {
    Stash, PowerContext, takeFromStash,
    resolveCreateOwn, resolveCreateCopy, resolveCreateTerritory,
    resolveMovePiece, resolveMoveTerritory,
    resolveGrowPiece, resolveGrowTerritory,
    resolveAttackPiece, resolveAttackTerritory,
    resolveOrientMinion, resolveOrientAny, resolveHierophantReplace,
    resolveHermitMovePiece, resolveHermitMoveTerritory, resolveTradeHands,
    resolveJudgementDraw, resolveHighPriestess,
} from "./gnostica/powers";
import { MajorArcanaDef, PowerStep, SuitPrimitive, getMajorArcanaDef, getMajorArcanaIcons } from "./gnostica/majorArcana";
import i18next from "i18next";

export type playerid = 1|2|3|4|5|6;

// A board tile overlays a 3x3 grid: the 4 corners are the card face (rank
// + suit/power icons, see buildCardFace), leaving 5 cells for pyramids -
// one edge midpoint per cardinal facing, plus the exact centre for an "up"
// (unfaced) piece. Orientation has exactly 5 values (N/E/S/W/up), a 1:1
// match.
const BOARD_TILE_GRID_CORNER = 650;
// Pieces get their own (smaller) radius rather than sharing
// BOARD_TILE_GRID_CORNER: the card corners are diagonal, so their true
// distance from centre is BOARD_TILE_GRID_CORNER*sqrt(2); an edge midpoint
// at the same magnitude is only BOARD_TILE_GRID_CORNER from centre - closer
// in a straight line - but pieces are much bigger glyphs (scale 0.48 vs
// 0.15-0.25 for icons) sitting flush against an axis rather than tucked
// into a corner, so at equal magnitude they visibly poked outside the tile
// (confirmed - not just a theoretical concern).
const PIECE_GRID_RADIUS = 380;
// Index in this array doubles as the slot's identity everywhere else -
// PIECE_GRID_PREFERRED_INDEX below must stay in step with it.
const PIECE_GRID_SLOTS: [number, number][] = [[0, -1], [0, 1], [1, 0], [-1, 0], [0, 0]]; // N, S, E, W, up
const PIECE_GRID_PREFERRED_INDEX: Record<Orientation, number> = { N: 0, S: 1, E: 2, W: 3, up: 4 };

// The renderer's own glyph-composition source (read directly, not
// inferred): a placed glyph's `nudge` is applied via its <use> element's
// x/y attributes, and only THEN is that already-positioned content rotated
// (around the origin) via the glyph's own `rotate` - so `nudge` lives in
// the glyph's local, PRE-rotation space, not screen space. A rotated
// piece's nudge therefore has to be the inverse-rotated target position -
// the piece's own rotation (already set to make it visually point the
// right way, see pyramidGlyph()) then carries that nudge back around to
// where it's actually meant to land on screen. [cos,sin] of each cardinal
// rotation's angle, in exact integers (not Math.cos/sin, which introduces
// float noise like 6.1e-17 at these multiples of 90deg).
const CARDINAL_COS_SIN: Record<Exclude<Orientation, "up">, [number, number]> = {
    N: [1, 0], E: [0, 1], S: [-1, 0], W: [0, -1],
};

// A minion's board location - shorthand used while resolving activate/play.
interface IMinionRef {
    x: number;
    y: number;
    index: number;
}

// What a single suit-power step did, as far as chaining later steps in the
// same major-arcana activation cares: "any of your pieces that are directly
// affected by a minion become minions for that turn" (Lovers example in the
// rules text) - so a step that moved/grew/created/replaced one of the
// acting player's OWN pieces reports its new location here.
interface IStepOutcome {
    newMinion?: IMinionRef;
}

// Major arcana chaining (up to 3 power steps, "become a minion when
// directly targeted", the Strength/Death/Sun/Chariot same-target shortcuts)
// is the largest chunk still missing from a fully playable game - only
// minor arcana's single, always-optional suit power is wired up so far.
// See docs on `applyMove()` below.
interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: UnboundedSquareBoard<Territory>;
    // Card uids per player, index 0 = player 1.
    hands: string[][];
    drawPile: string[];
    discardPile: string[];
    stashes: Map<playerid, Stash>;
    eliminated: playerid[];
    lastTurnAnnouncedBy: playerid | undefined;
    lastmove?: string;
}

export interface IGnosticaState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
}

export class GnosticaGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Gnostica",
        uid: "gnostica",
        playercounts: [2, 3, 4, 5, 6],
        version: "20260813",
        dateAdded: "2026-08-13",
        // i18next.t("apgames:descriptions.gnostica")
        description: "apgames:descriptions.gnostica",
        notes: "apgames:notes.gnostica",
        urls: ["https://www.looneylabs.com/games/gnostica"],
        bggid: "9629",
        people: [
            { type: "designer", name: "John Cooper" },
            { type: "designer", name: "Kory Heath" },
            { type: "designer", name: "Kristin Matherly" },
            { type: "designer", name: "Jacob Davenport" },
            {
                type: "coder",
                name: "mcd",
                urls: ["https://mcdemarco.net/games/"],
                apid: "4bd8317d-fb04-435f-89e0-2557c3f2e66c",
            },

        ],
        variants: [
            { uid: "target-8", group: "target" },
            { uid: "target-10", group: "target" },
            { uid: "no-majors" },
        ],
        categories: ["goal>score>eog", "mechanic>area", "mechanic>capture", "mechanic>hand", "mechanic>place", "board>dynamic", "components>cards-tarot", "components>pyramids", "other>2+players"],
        flags: ["experimental", "no-moves", "custom-randomization", "player-stashes"],
    };

    public numplayers!: number;
    public currplayer!: playerid;
    public board!: GnosticaBoard;
    public hands: string[][] = [];
    public drawPile: string[] = [];
    public discardPile: string[] = [];
    public stashes!: Map<playerid, Stash>;
    public eliminated: playerid[] = [];
    public lastTurnAnnouncedBy: playerid | undefined;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];

    private targetScore(): number {
        if (this.variants.includes("target-8")) {
            return 8;
        }
        if (this.variants.includes("target-10")) {
            return 10;
        }
        return 9;
    }

    constructor(state: number | IGnosticaState | string, variants?: string[]) {
        super();
        if (typeof state === "number") {
            this.numplayers = state;
            if (variants !== undefined) {
                this.variants = [...variants];
            }

            const deck = new Deck(Deck.full()).shuffle();
            const hands: string[][] = [];
            for (let p = 0; p < this.numplayers; p++) {
                hands.push(deck.draw(6).map(c => c.uid));
            }

            // The starting 3x3 grid is built directly (not via
            // GnosticaBoard.createTerritory(), which requires the target to
            // already classify as a wasteland - true once neighbours exist,
            // not true for an entirely empty board).
            const board = new GnosticaBoard();
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    const [c] = deck.draw(1);
                    board.store.set(x, y, new Territory(c));
                }
            }
            const drawPile = deck.cards.map(c => c.uid);

            const stashes = new Map<playerid, Stash>();
            for (let p = 1; p <= this.numplayers; p++) {
                stashes.set(p as playerid, [5, 5, 5]);
            }

            // Player 1 is the starting player by definition - randomizing
            // who's actually "player 1" (or running the rules' bid-and-
            // redraw procedure) is the front end's job, not the engine's.
            // v1 doesn't implement the bid procedure at all; a future
            // variant could.
            const fresh: IMoveState = {
                _version: GnosticaGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board: board.store,
                hands,
                drawPile,
                discardPile: [],
                stashes,
                eliminated: [],
                lastTurnAnnouncedBy: undefined,
            };
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IGnosticaState;
            }
            if (state.game !== GnosticaGame.gameinfo.uid) {
                throw new Error(`The Gnostica engine cannot process a game of '${state.game}'.`);
            }
            this.numplayers = state.numplayers;
            this.variants = state.variants;
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.stack = [...state.stack];
            // Two-step rehydration (see GnosticaBoard.rehydrate's own docs):
            // JSON.parse+reviver only restores the outer UnboundedSquareBoard
            // wrapper; every stored Territory still needs its own
            // deserialize() pass to become a real class instance again.
            this.stack.forEach(s => {
                s.board = GnosticaBoard.rehydrate(s.board as UnboundedSquareBoard<ITerritory>);
            });
        }
        this.load();
    }

    public load(idx = -1): GnosticaGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if (idx < 0 || idx >= this.stack.length) {
            throw new Error("Could not load the requested state from the stack.");
        }
        const state = this.stack[idx];
        this.results = [...state._results];
        this.currplayer = state.currplayer;
        // Wrap + deep-clone so mutating `this.board` during play never
        // touches the snapshot stored in the stack.
        this.board = new GnosticaBoard(state.board).clone();
        this.hands = state.hands.map(h => [...h]);
        this.drawPile = [...state.drawPile];
        this.discardPile = [...state.discardPile];
        this.stashes = new Map([...state.stashes.entries()].map(([k, v]) => [k, [...v] as Stash]));
        this.eliminated = [...state.eliminated];
        this.lastTurnAnnouncedBy = state.lastTurnAnnouncedBy;
        this.lastmove = state.lastmove;
        return this;
    }

    protected moveState(): IMoveState {
        return {
            _version: GnosticaGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            board: this.board.clone().store,
            hands: this.hands.map(h => [...h]),
            drawPile: [...this.drawPile],
            discardPile: [...this.discardPile],
            stashes: new Map([...this.stashes.entries()].map(([k, v]) => [k, [...v] as Stash])),
            eliminated: [...this.eliminated],
            lastTurnAnnouncedBy: this.lastTurnAnnouncedBy,
            lastmove: this.lastmove,
        };
    }

    public state(): IGnosticaState {
        return {
            game: GnosticaGame.gameinfo.uid,
            numplayers: this.numplayers,
            variants: this.variants,
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack],
        };
    }

    public clone(): GnosticaGame {
        return new GnosticaGame(this.serialize());
    }

    // ============================================================
    // Move parsing
    //
    // Grammar (see the plan for the full design): a comma/semicolon/slash-
    // delimited list of segments. Exactly one segment names the turn's
    // action; an optional extra "last" segment announces the player's final
    // turn. "activate"/"play" (which chain 0-2 suit/major-arcana power
    // steps after the action segment) aren't implemented yet - only place/
    // orient/draw are real right now.
    //
    // validateMove() and move() share one code path (applyMove(), below)
    // rather than duplicating the legality checks: validateMove() runs it
    // against a throwaway clone and reports whether it threw. This is
    // simpler than Homeworlds' hand-rolled parallel validators, at the cost
    // of the granular complete:0-vs-1 partial-move UX every other game gets
    // from a bespoke validator - that polish is deferred to a later pass
    // once handleClick/render exist to actually exercise it.
    // ============================================================

    public move(m: string, opts: IMoveOptions = {}): GnosticaGame {
        const { trusted = false } = opts;
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }
        m = m.trim();
        if (!trusted) {
            const result = this.validateMove(m);
            if (!result.valid) {
                throw new UserFacingError("VALIDATION_GENERAL", result.message);
            }
        }
        this.results = [];
        this.applyMove(m);
        this.lastmove = m;
        this.nextPlayer();
        this.checkEOG();
        this.saveState();
        return this;
    }

    public validateMove(m: string): IValidationResult {
        const result: IValidationResult = { valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
        m = m.trim();
        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            // i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS")
            result.message = i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS");
            return result;
        }
        try {
            const clone = this.clone();
            clone.results = [];
            clone.applyMove(m);
            result.valid = true;
            result.complete = 1;
            result.message = i18next.t("apgames:validation._general.VALID_MOVE");
        } catch (e) {
            result.valid = false;
            result.message = e instanceof UserFacingError ? e.client : i18next.t("apgames:validation._general.INVALID_MOVE", { move: m });
        }
        return result;
    }

    // Parses and executes `m` against `this` - the one place move grammar
    // is interpreted. Throws UserFacingError on any illegal move; callers
    // (move()/validateMove()) decide what to do with that.
    //
    // Segment 0 is always the turn's top-level action. For "activate"/
    // "play", 0 or 1 further segments follow - a single suit-power step
    // (minor arcana always grants exactly one power, and it's always
    // optional). Major arcana cards (which can chain up to 3 power steps)
    // aren't supported here yet - see cmdActivate/cmdPlay.
    private applyMove(m: string): void {
        const segments = m.split(/\s*[\n,;/\\]\s*/).filter(s => s.length > 0);
        let announceLast = false;
        const remaining: string[] = [];
        for (const seg of segments) {
            if (seg.toLowerCase() === "last") {
                announceLast = true;
            } else {
                remaining.push(seg);
            }
        }
        if (remaining.length === 0) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation._general.INVALID_MOVE", { move: m }));
        }

        // Remembered before acting: if this player announced their last
        // turn on a PREVIOUS turn, this is the turn that resolves it - win
        // or elimination is decided after their action, below.
        const wasAnnounced = this.lastTurnAnnouncedBy === this.currplayer;

        const [head, ...rest] = remaining[0].split(/\s+/);
        const stepSegments = remaining.slice(1).map(s => s.split(/\s+/));
        const requireNoSteps = () => {
            if (stepSegments.length > 0) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: head }));
            }
        };
        switch (head.toLowerCase()) {
            case "place":
                requireNoSteps();
                this.cmdPlace(rest);
                break;
            case "orient":
                requireNoSteps();
                this.requireHasPiecesOnBoard();
                this.cmdOrient(rest);
                break;
            case "draw":
                requireNoSteps();
                this.requireHasPiecesOnBoard();
                this.cmdDraw(rest);
                break;
            case "activate":
                this.requireHasPiecesOnBoard();
                this.cmdActivate(rest, stepSegments);
                break;
            case "play":
                this.requireHasPiecesOnBoard();
                this.cmdPlay(rest, stepSegments);
                break;
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation._general.UNRECOGNIZED_MOVE", { move: remaining[0] }));
        }

        if (announceLast) {
            if (this.lastTurnAnnouncedBy !== undefined && this.lastTurnAnnouncedBy !== this.currplayer) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.ALREADY_ANNOUNCED"));
            }
            this.lastTurnAnnouncedBy = this.currplayer;
            this.results.push({ type: "announce", payload: ["lastTurn", this.currplayer] });
        }

        if (wasAnnounced) {
            this.resolveAnnouncedTurn();
        }
    }

    private hasPiecesOnBoard(player: playerid): boolean {
        for (const [, , t] of this.board.entries()) {
            if (t.pieces.some(p => p.owner === player)) {
                return true;
            }
        }
        return false;
    }

    // "If you have no pieces on the board, you may only put a small piece
    // [...]. Otherwise, do one of the following [...]" - place is the only
    // legal action with zero board pieces; every other action requires this.
    private requireHasPiecesOnBoard(): void {
        if (!this.hasPiecesOnBoard(this.currplayer)) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.MUST_PLACE_FIRST"));
        }
    }

    private parseOrientation(s: string): Orientation {
        if (s.toLowerCase() === "up") {
            return "up";
        }
        const dir = s.toUpperCase();
        if ((cardinalOrientations as string[]).includes(dir)) {
            return dir as Orientation;
        }
        throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: s }));
    }

    private parsePieceRef(ref: string): { x: number; y: number; index: number } {
        const parts = ref.split(".");
        if (parts.length !== 2) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_PIECE_REF", { ref }));
        }
        const [cellStr, idxStr] = parts;
        const index = parseInt(idxStr, 10);
        if (Number.isNaN(index)) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_PIECE_REF", { ref }));
        }
        const [x, y] = GnosticaBoard.algebraic2coords(cellStr);
        return { x, y, index };
    }

    // "place <cell> [orientation]" - only legal with zero pieces on board;
    // orientation defaults to "up".
    private cmdPlace(args: string[]): void {
        const [cellStr, orientationStr] = args;
        if (cellStr === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.PLACE_CELL_REQUIRED"));
        }
        if (this.hasPiecesOnBoard(this.currplayer)) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.ALREADY_ON_BOARD"));
        }
        const orientation = this.parseOrientation(orientationStr ?? "up");
        const [x, y] = GnosticaBoard.algebraic2coords(cellStr);
        if (this.board.classify(x, y) === "void") {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.PLACE_VOID", { cell: cellStr }));
        }
        let territory = this.board.get(x, y);
        if (territory !== undefined && territory.pieces.length > 0) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.PLACE_OCCUPIED", { cell: cellStr }));
        }
        if (territory === undefined) {
            territory = new Territory(undefined);
            this.board.store.set(x, y, territory);
        }
        // Your very first piece comes from your own stash, same as every
        // other piece that ever enters play (Cups' "own" creation, growth,
        // etc.) - it isn't manufactured out of nothing.
        takeFromStash(this.buildPowerContext(), this.currplayer, 1);
        territory.add(new Piece(this.currplayer, 1, orientation));
        this.results.push({ type: "place", where: cellStr });
    }

    // "orient <cell>.<index> <facing>" - only your own piece.
    private cmdOrient(args: string[]): void {
        const [ref, orientationStr] = args;
        if (ref === undefined || orientationStr === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.ORIENT_ARGS_REQUIRED"));
        }
        const { x, y, index } = this.parsePieceRef(ref);
        const piece = this.board.get(x, y)?.pieces[index];
        if (piece === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_SUCH_PIECE", { ref }));
        }
        if (piece.owner !== this.currplayer) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NOT_YOUR_PIECE", { ref }));
        }
        const orientation = this.parseOrientation(orientationStr);
        piece.orientation = orientation;
        this.results.push({ type: "orient", where: ref, facing: orientation });
    }

    // "draw [uid...]" - discard the named hand cards, then redraw to 6,
    // reshuffling the discard pile into the draw pile if it runs dry.
    private cmdDraw(args: string[]): void {
        const hand = this.hands[this.currplayer - 1];
        for (const uid of args) {
            const idx = hand.indexOf(uid);
            if (idx === -1) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }));
            }
            hand.splice(idx, 1);
            this.discardPile.push(uid);
        }
        let drawnCount = 0;
        while (hand.length < 6) {
            if (this.drawPile.length === 0) {
                if (this.discardPile.length === 0) {
                    break; // nothing left anywhere
                }
                this.drawPile = shuffle(this.discardPile) as string[];
                this.discardPile = [];
            }
            hand.push(this.drawPile.shift() as string);
            drawnCount++;
        }
        this.results.push({ type: "deckDraw", count: drawnCount, from: "deck" });
    }

    // ============================================================
    // Activate / play a card - minor arcana only for now. Each minor card
    // has exactly one suit power, always optional, used by exactly one
    // minion. Major arcana (which can chain up to 3 power steps across
    // several minions, per MAJOR_ARCANA in gnostica/majorArcana.ts) is
    // deliberately not handled here yet.
    // ============================================================

    private buildPowerContext(): PowerContext {
        return {
            board: this.board,
            currplayer: this.currplayer,
            stashes: this.stashes,
            hand: this.hands[this.currplayer - 1],
            discardPile: this.discardPile,
            drawPile: this.drawPile,
        };
    }

    // "Activate a card on the board. All your pieces on that card are
    // minions [...]"
    private cmdActivate(args: string[], stepSegments: string[][]): void {
        const [cellStr] = args;
        if (cellStr === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.ACTIVATE_CELL_REQUIRED"));
        }
        const [x, y] = GnosticaBoard.algebraic2coords(cellStr);
        const t = this.board.get(x, y);
        if (t === undefined || t.card === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_CARD_THERE", { cell: cellStr }));
        }
        const eligible: IMinionRef[] = t.pieces
            .map((p, index) => ({ x, y, index }))
            .filter(ref => t.pieces[ref.index].owner === this.currplayer);
        if (eligible.length === 0) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_MINIONS_THERE", { cell: cellStr }));
        }
        this.applyCardPower(t.card, eligible, stepSegments);
    }

    // "Play a card from your hand to the discard pile. All your pieces on
    // the board are minions [...]"
    private cmdPlay(args: string[], stepSegments: string[][]): void {
        const [uid] = args;
        if (uid === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.PLAY_UID_REQUIRED"));
        }
        const hand = this.hands[this.currplayer - 1];
        const handIdx = hand.indexOf(uid);
        if (handIdx === -1) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }));
        }
        const card = allCards().find(c => c.uid === uid);
        if (card === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid }));
        }
        hand.splice(handIdx, 1);
        this.discardPile.push(uid);
        this.results.push({ type: "deckDraw", count: 0, what: uid, from: "hand" });

        const eligible: IMinionRef[] = [];
        for (const [x, y, t] of this.board.entries()) {
            t.pieces.forEach((p, index) => {
                if (p.owner === this.currplayer) {
                    eligible.push({ x, y, index });
                }
            });
        }
        this.applyCardPower(card, eligible, stepSegments);
    }

    private applyCardPower(card: MinorCard | MajorCard, eligible: IMinionRef[], stepSegments: string[][]): void {
        if (card.major) {
            const def = getMajorArcanaDef(card as MajorCard);
            // Fool and World both delegate to ANOTHER card's full power
            // resolution (a randomly flipped card; any major currently on
            // the board) rather than doing something self-contained - that
            // recursive dispatch is a distinct, not-yet-built piece of work,
            // not an oversight in the chaining logic below.
            if (def.uid === "00" || def.uid === "21") {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.FOOL_WORLD_NOT_YET_SUPPORTED"));
            }
            this.applyMajorPower(def, eligible, stepSegments);
        } else {
            this.applyMinorPower((card as MinorCard).suit.uid, eligible, stepSegments);
        }
    }

    private applyMinorPower(suitUid: string, eligible: IMinionRef[], stepSegments: string[][]): void {
        if (stepSegments.length === 0) {
            return; // power declined - always optional
        }
        if (stepSegments.length > 1) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.MINOR_ONE_STEP_ONLY"));
        }
        const [minionRef, mode, ...rest] = stepSegments[0];
        if (minionRef === undefined || mode === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.POWER_STEP_ARGS_REQUIRED"));
        }
        const loc = this.parsePieceRef(minionRef);
        const minion = eligible.find(e => e.x === loc.x && e.y === loc.y && e.index === loc.index);
        if (minion === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NOT_AN_ELIGIBLE_MINION", { ref: minionRef }));
        }
        this.applySuitPrimitive(suitUid, minion, mode, rest, {});
    }

    // Walks a major arcana card's power-step list, one activation-move
    // segment per step (fewer than the card's full count is fine - every
    // power is optional). Tracks the growing minion set ("any of your
    // pieces directly affected by a minion become minions for that turn")
    // and derives the runtime opts each shortcut card needs - see
    // computeShortcutOpts()'s own docs for why that derivation is safe to
    // apply unconditionally rather than requiring genuine same-target
    // detection between steps.
    private applyMajorPower(def: MajorArcanaDef, eligible: IMinionRef[], stepSegments: string[][]): void {
        if (stepSegments.length > def.powers.length) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.TOO_MANY_POWER_STEPS"));
        }
        let minions = [...eligible];
        for (let i = 0; i < stepSegments.length; i++) {
            const step = def.powers[i];
            const tokens = stepSegments[i];
            const outcome = this.applyPowerStep(step, minions, tokens, def, i, stepSegments.length);
            if (outcome?.newMinion !== undefined) {
                minions = [...minions, outcome.newMinion];
            }
        }
    }

    // "primitive" steps expect <minionRef> <mode> <args...> (same grammar as
    // minor arcana). "special" steps have their own bespoke token shapes -
    // see each apply*() method below. High Priestess is the one special
    // with no minion reference at all (it's pure hand/pile manipulation).
    private applyPowerStep(
        step: PowerStep, minions: IMinionRef[], tokens: string[], def: MajorArcanaDef, stepIndex: number, totalSteps: number,
    ): IStepOutcome | undefined {
        if ("special" in step && step.special === "highPriestess") {
            this.applyHighPriestess(tokens);
            return undefined;
        }
        const [minionRef, ...rest] = tokens;
        if (minionRef === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.POWER_STEP_ARGS_REQUIRED"));
        }
        const loc = this.parsePieceRef(minionRef);
        const minion = minions.find(m => m.x === loc.x && m.y === loc.y && m.index === loc.index);
        if (minion === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NOT_AN_ELIGIBLE_MINION", { ref: minionRef }));
        }
        if ("primitive" in step) {
            const [mode, ...modeArgs] = rest;
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts);
            return this.applySuitPrimitive(step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S", minion, mode, modeArgs, opts);
        }
        switch (step.special) {
            case "orientMinion":
                return this.applyOrientMinion(minion, rest);
            case "orientAny":
                return this.applyOrientAny(minion, rest);
            case "hierophantReplace":
                return this.applyHierophantReplace(minion, rest);
            case "hermitTeleport":
                return this.applyHermitStep(minion, rest);
            case "tradeHands":
                return this.applyTradeHands(minion, rest);
            case "judgementDraw":
                this.applyJudgementDraw(minion, rest);
                return undefined;
            case "magicianChoice":
                return this.applyMagicianChoice(minion, rest);
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.SPECIAL_NOT_YET_SUPPORTED", { special: step.special }));
        }
    }

    // Derives the runtime relaxation opts a same-target-shortcut/Moon card's
    // step needs, WITHOUT actually verifying the two steps share a target.
    // This is deliberately simplified (see the design discussion this was
    // built from): Strength/Death's ladder-skip is safe to apply
    // unconditionally because it only ever WIDENS the legal range (a normal
    // 1-rung change is still legal with it on) - a player using two
    // ordinary steps is unaffected, and a player using the shortcut's
    // single big jump is correctly allowed. Chariot's landing-check
    // relaxation is applied to every step except the last, which is exact
    // for Chariot's only real shape (two rod steps) but would over-relax a
    // hypothetical 3-step move-shortcut card that moves different pieces -
    // no such card exists, so this isn't a live gap. Moon's capacity
    // exemption on its move step is gated on the attack step actually being
    // supplied in the same activation, so it can't be used to strand a
    // 4-stack with no follow-up.
    private computeShortcutOpts(
        def: MajorArcanaDef, primitive: SuitPrimitive,
        stepIndex: number, totalSteps: number, staticOpts: object | undefined,
    ): Record<string, unknown> {
        const opts: Record<string, unknown> = { ...staticOpts };
        if (def.sameTargetShortcut) {
            if (primitive === "grow") {
                opts.skipLadder = true;
            } else if (primitive === "attack") {
                opts.skipStashCheck = true;
            } else if (primitive === "move" && stepIndex < totalSteps - 1) {
                opts.skipLandingCheck = true;
            }
        }
        if (def.moonCapacityExemption && primitive === "move" && stepIndex === 0 && totalSteps >= 2) {
            opts.ignoreCapacity = true;
        }
        return opts;
    }

    private applySuitPrimitive(suitUid: string, minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown>): IStepOutcome {
        switch (suitUid) {
            case "C":
                return this.applyCups(minion, mode, rest, opts);
            case "R":
                return this.applyRods(minion, mode, rest, opts);
            case "D":
                return this.applyDiscs(minion, mode, rest, opts);
            case "S":
                return this.applySwords(minion, mode, rest, opts);
            default:
                throw new Error(`Unknown suit uid "${suitUid}".`);
        }
    }

    // Cups - own <cell> <orientation> | copy <cell> <victimIndex> | new <cell> (<uid>|random)
    private applyCups(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "own": {
                const [cellStr, orientationStr] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const orientation = this.parseOrientation(orientationStr);
                resolveCreateOwn(ctx, minion.x, minion.y, minion.index, tx, ty, orientation, opts);
                this.results.push({ type: "place", where: cellStr, how: "cups-own" });
                const newIndex = this.board.get(tx, ty)!.pieces.length - 1;
                return { newMinion: { x: tx, y: ty, index: newIndex } };
            }
            case "copy": {
                const [cellStr, victimIdxStr] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const victimIndex = parseInt(victimIdxStr, 10);
                resolveCreateCopy(ctx, minion.x, minion.y, minion.index, tx, ty, victimIndex, opts);
                this.results.push({ type: "place", where: cellStr, how: "cups-copy" });
                return {}; // the new piece belongs to the copied enemy, not the acting player
            }
            case "new": {
                const [cellStr, cardArg] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                if (cardArg === "random") {
                    resolveCreateTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, undefined, { ...opts, allowRandomDraw: true });
                } else {
                    resolveCreateTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, cardArg, opts);
                }
                this.results.push({ type: "discover", where: cellStr });
                return {};
            }
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Cups" }));
        }
    }

    // Rods - piece <targetRef> <dist> [orientation] | tile <dist>
    private applyRods(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const [targetRef, distStr, orientationStr] = rest;
                const target = this.parsePieceRef(targetRef);
                const dist = parseInt(distStr, 10);
                const newOrientation = orientationStr !== undefined ? this.parseOrientation(orientationStr) : undefined;
                // Captured before the move mutates the board, to compute
                // where the piece actually ends up for the result log and
                // the minion-chaining check below.
                const movedOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
                const facing = this.board.get(minion.x, minion.y)!.pieces[minion.index].orientation;
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "up">);
                resolveMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, dist, newOrientation, opts);
                const destX = target.x + dx * dist;
                const destY = target.y + dy * dist;
                const dest = GnosticaBoard.coords2algebraic(destX, destY);
                this.results.push({ type: "move", from: targetRef, to: dest, how: "rod-piece" });
                if (movedOwner === this.currplayer) {
                    const newIndex = this.board.get(destX, destY)!.pieces.length - 1;
                    return { newMinion: { x: destX, y: destY, index: newIndex } };
                }
                return {};
            }
            case "tile": {
                const [distStr] = rest;
                const dist = parseInt(distStr, 10);
                const facing = this.board.get(minion.x, minion.y)!.pieces[minion.index].orientation;
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "up">);
                const srcX = minion.x + dx;
                const srcY = minion.y + dy;
                resolveMoveTerritory(ctx, minion.x, minion.y, minion.index, dist);
                const from = GnosticaBoard.coords2algebraic(srcX, srcY);
                const to = GnosticaBoard.coords2algebraic(srcX + dx * dist, srcY + dy * dist);
                this.results.push({ type: "move", from, to, how: "rod-tile" });
                return {};
            }
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Rods" }));
        }
    }

    // Discs - piece <targetRef> [orientation] | tile <cell> <newCardUid>
    private applyDiscs(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const [targetRef, orientationStr] = rest;
                const target = this.parsePieceRef(targetRef);
                const newOrientation = orientationStr !== undefined ? this.parseOrientation(orientationStr) : undefined;
                const targetPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                const owner = targetPiece.owner;
                const beforeSize = targetPiece.size;
                resolveGrowPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, newOrientation);
                this.results.push({ type: "convert", what: `size-${beforeSize}`, into: `size-${beforeSize + 1}`, where: targetRef });
                if (owner === this.currplayer) {
                    const newIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
                    return { newMinion: { x: target.x, y: target.y, index: newIndex } };
                }
                return {};
            }
            case "tile": {
                const [cellStr, newCardUid] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const beforeUid = this.board.get(tx, ty)!.card!.uid;
                resolveGrowTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, newCardUid, opts);
                this.results.push({ type: "convert", what: beforeUid, into: newCardUid, where: cellStr });
                return {};
            }
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Discs" }));
        }
    }

    // Swords - piece <targetRef> <pips> [orientation] | tile <cell> <pips> [newCardUid]
    private applySwords(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const [targetRef, pipsStr, orientationStr] = rest;
                const target = this.parsePieceRef(targetRef);
                const pips = parseInt(pipsStr, 10);
                const newOrientation = orientationStr !== undefined ? this.parseOrientation(orientationStr) : undefined;
                const targetPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                const owner = targetPiece.owner;
                const beforeSize = targetPiece.size;
                resolveAttackPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, pips, newOrientation, opts);
                this.results.push({ type: "destroy", what: targetRef });
                const resultSize = beforeSize - pips;
                if (resultSize > 0 && owner === this.currplayer) {
                    const newIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
                    return { newMinion: { x: target.x, y: target.y, index: newIndex } };
                }
                return {};
            }
            case "tile": {
                const [cellStr, pipsStr, newCardUid] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const pips = parseInt(pipsStr, 10);
                resolveAttackTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, pips, newCardUid, opts);
                this.results.push({ type: "destroy", where: cellStr });
                return {};
            }
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Swords" }));
        }
    }

    // orientMinion: <minionRef> <newOrientation> - no targeting restriction,
    // any current minion.
    private applyOrientMinion(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [orientationStr] = rest;
        const orientation = this.parseOrientation(orientationStr);
        resolveOrientMinion(this.buildPowerContext(), minion.x, minion.y, minion.index, orientation);
        this.results.push({ type: "orient", where: `${minion.x},${minion.y}.${minion.index}`, facing: orientation });
        return { newMinion: minion };
    }

    // orientAny (Devil only): <minionRef> <targetPieceRef> <newOrientation>
    // - still subject to the minion's own self/adjacent targeting rule,
    // just without the "must be your own piece" restriction.
    private applyOrientAny(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [targetRef, orientationStr] = rest;
        const target = this.parsePieceRef(targetRef);
        const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const orientation = this.parseOrientation(orientationStr);
        resolveOrientAny(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.results.push({ type: "orient", where: targetRef, facing: orientation });
        return owner === this.currplayer ? { newMinion: target } : {};
    }

    // Hierophant: <minionRef> <targetPieceRef> <newOrientation>
    private applyHierophantReplace(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [targetRef, orientationStr] = rest;
        const target = this.parsePieceRef(targetRef);
        const orientation = this.parseOrientation(orientationStr);
        resolveHierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.results.push({ type: "convert", what: targetRef, into: `owner-${this.currplayer}` });
        const newIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
        return { newMinion: { x: target.x, y: target.y, index: newIndex } };
    }

    // Hermit - piece <minionRef> piece <targetPieceRef> <destCell> [orientation]
    //        | tile <minionRef> tile <targetCell> <destCell>
    private applyHermitStep(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [mode, ...args] = rest;
        const ctx = this.buildPowerContext();
        if (mode === "piece") {
            const [targetRef, destCellStr, orientationStr] = args;
            const target = this.parsePieceRef(targetRef);
            const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
            const [destX, destY] = GnosticaBoard.algebraic2coords(destCellStr);
            const newOrientation = orientationStr !== undefined ? this.parseOrientation(orientationStr) : undefined;
            resolveHermitMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, destX, destY, newOrientation);
            this.results.push({ type: "move", from: targetRef, to: destCellStr, how: "hermit-piece" });
            if (owner === this.currplayer) {
                const newIndex = this.board.get(destX, destY)!.pieces.length - 1;
                return { newMinion: { x: destX, y: destY, index: newIndex } };
            }
            return {};
        } else if (mode === "tile") {
            const [targetCellStr, destCellStr] = args;
            const [tx, ty] = GnosticaBoard.algebraic2coords(targetCellStr);
            const [destX, destY] = GnosticaBoard.algebraic2coords(destCellStr);
            resolveHermitMoveTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, destX, destY);
            this.results.push({ type: "move", from: targetCellStr, to: destCellStr, how: "hermit-tile" });
            return {};
        }
        throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Hermit" }));
    }

    // Justice / Hanged Man: <minionRef> <targetPieceRef> - swaps hands with
    // the targeted piece's owner. PowerContext only carries the acting
    // player's own hand, so the OTHER player's live hand array is looked up
    // here (the one place the engine, not powers.ts, needs the full
    // per-player hand map) and passed in directly.
    private applyTradeHands(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [targetRef] = rest;
        const target = this.parsePieceRef(targetRef);
        const targetOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const otherHand = this.hands[targetOwner - 1];
        resolveTradeHands(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, otherHand);
        this.results.push({ type: "announce", payload: ["tradeHands", this.currplayer, targetOwner] });
        return {};
    }

    // Judgement: <minionRef> <discardUid...>
    private applyJudgementDraw(minion: IMinionRef, rest: string[]): void {
        resolveJudgementDraw(this.buildPowerContext(), minion.x, minion.y, minion.index, rest);
        this.results.push({ type: "deckDraw", count: rest.length, from: "discard" });
    }

    // High Priestess: <discardUid...> - no minion reference at all.
    private applyHighPriestess(tokens: string[]): void {
        resolveHighPriestess(this.buildPowerContext(), tokens);
        this.results.push({ type: "deckDraw", count: tokens.length, from: "deck" });
    }

    // Magician: <minionRef> <suitLetter: C|R|D|S> <mode> <args...> - the
    // player picks which of the four suit primitives to use; everything
    // after the suit letter matches that suit's normal mode+args grammar.
    private applyMagicianChoice(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [suitLetter, mode, ...args] = rest;
        if (!["C", "R", "D", "S"].includes(suitLetter)) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_SUIT_LETTER", { suitLetter }));
        }
        return this.applySuitPrimitive(suitLetter, minion, mode, args, {});
    }

    // ============================================================
    // Turn order / scoring / win-elimination
    // ============================================================

    private nextPlayer(): void {
        if (this.gameover) {
            return;
        }
        let next = this.currplayer;
        do {
            next = ((next % this.numplayers) + 1) as playerid;
        } while (this.eliminated.includes(next) && next !== this.currplayer);
        this.currplayer = next;
    }

    private scoreFor(player: playerid): number {
        let total = 0;
        for (const [, , t] of this.board.entries()) {
            if (t.isUncontestedBy(player)) {
                total += t.pointValue();
            }
        }
        return total;
    }

    public getPlayerScore(player: number): number {
        return this.scoreFor(player as playerid);
    }

    // Called (after the player's action for the turn has already been
    // applied) when this is the turn following that player's own
    // "announce last turn" - decides win or elimination.
    private resolveAnnouncedTurn(): void {
        const player = this.currplayer;
        this.lastTurnAnnouncedBy = undefined;
        if (this.scoreFor(player) >= this.targetScore()) {
            this.gameover = true;
            this.winner = [player];
        } else {
            this.eliminatePlayer(player);
        }
    }

    private eliminatePlayer(player: playerid): void {
        for (const [, , t] of this.board.entries()) {
            t.pieces = t.pieces.filter(p => p.owner !== player);
        }
        this.hands[player - 1] = [];
        this.eliminated.push(player);
        this.results.push({ type: "eliminated", who: player.toString() });
        // Not explicit in the rules text (which assumes play continues
        // until someone announces and wins), but if elimination ever
        // leaves only one player standing, they've necessarily won.
        const remaining: playerid[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            if (!this.eliminated.includes(p as playerid)) {
                remaining.push(p as playerid);
            }
        }
        if (remaining.length === 1) {
            this.gameover = true;
            this.winner = remaining;
        }
    }

    protected checkEOG(): GnosticaGame {
        if (this.gameover) {
            this.results.push({ type: "eog" });
            this.results.push({ type: "winners", players: [...this.winner] });
        }
        return this;
    }

    // Stub covering only the two turn types implemented so far
    // (place/draw) - expand once activate/play exist. `custom-randomization`
    // is declared precisely because full `moves()` enumeration of every
    // legal chained-power target combination is combinatorially infeasible
    // (see Homeworlds' own precedent), not merely deferred.
    public randomMove(): string {
        if (!this.hasPiecesOnBoard(this.currplayer)) {
            const candidates: string[] = [];
            for (const [x, y, t] of this.board.entries()) {
                if (t.pieces.length === 0 && this.board.classify(x, y) !== "void") {
                    candidates.push(`place ${GnosticaBoard.coords2algebraic(x, y)}`);
                }
            }
            if (candidates.length > 0) {
                return candidates[Math.floor(Math.random() * candidates.length)];
            }
        }
        return "draw";
    }

    // Standard grid renderer over a window recomputed from the board's live
    // bounding box every call (the "Knight Line" pattern - see the plan:
    // there's no fixed board size, so the visible window has to track
    // wherever territories currently are, padded by one empty ring so
    // placement/push destinations just outside the current bounds are still
    // visible and clickable). Gnostica's algebraic notation is already
    // absolute (GnosticaBoard.coords2algebraic doesn't shift as the board
    // grows, unlike Knight Line's own notation), so this only needs ONE
    // extra coordinate layer (window-relative row/col), not two.
    public render(): APRenderRep {
        const minX = this.board.minX - 1;
        const maxX = this.board.maxX + 1;
        const minY = this.board.minY - 1;
        const maxY = this.board.maxY + 1;
        const width = maxX - minX + 1;
        const height = maxY - minY + 1;

        const legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] } = {};
        const pieceRows: string[] = [];
        for (let y = minY; y <= maxY; y++) {
            const rowCells: string[] = [];
            for (let x = minX; x <= maxX; x++) {
                const cls = this.board.classify(x, y);
                if (cls === "void") {
                    rowCells.push("-");
                    continue;
                }
                const t = this.board.get(x, y);
                const key = this.cellRenderKey(t, cls);
                if (!(key in legend)) {
                    legend[key] = this.buildCellGlyph(t, cls);
                }
                rowCells.push(key);
            }
            pieceRows.push(rowCells.join(","));
        }

        const columnLabels: string[] = [];
        for (let x = minX; x <= maxX; x++) {
            // coords2algebraic(x, 0) always ends in the literal digit "0"
            // (y===0 is a special case producing yval=0) - strip it to get
            // just this column's letter(s).
            columnLabels.push(GnosticaBoard.coords2algebraic(x, 0).slice(0, -1));
        }
        // The renderer pairs rowLabels[i] with pieceRows[N-1-i] (mirrored,
        // not same-index) - confirmed by actually rendering an asymmetric
        // test board, not just by reading the schema. pieceRows[0] is the
        // smallest absolute y (top, since y grows downward), so rowLabels
        // has to be built bottom-first (largest y = index 0) for the
        // mirrored pairing to land each row's true algebraic-notation label
        // on itself. Matches Knight Line's own .reverse() in its render().
        const rowLabels: string[] = [];
        for (let y = maxY; y >= minY; y--) {
            rowLabels.push((y === 0 ? 0 : -y).toString());
        }

        const rep: APRenderRep = {
            board: {
                style: "squares",
                width,
                height,
                columnLabels,
                rowLabels,
                strokeColour: {
                    func: "flatten",
                    fg: "_context_strokes",
                    bg: "_context_board",
                    opacity: 0,
                },
            },
            legend,
            pieces: pieceRows.join("\n"),
        };

        if (this.results.length > 0) {
            const annotations: NonNullable<APRenderRep["annotations"]> = [];
            for (const r of this.results) {
                if (r.type === "place" && r.where !== undefined) {
                    const [x, y] = GnosticaBoard.algebraic2coords(r.where);
                    annotations.push({ type: "enter", targets: [{ row: y - minY, col: x - minX }] });
                } else if (r.type === "move" && r.from !== undefined && r.to !== undefined) {
                    const [fx, fy] = GnosticaBoard.algebraic2coords(r.from);
                    const [tx, ty] = GnosticaBoard.algebraic2coords(r.to);
                    annotations.push({ type: "move", targets: [{ row: fy - minY, col: fx - minX }, { row: ty - minY, col: tx - minX }] });
                }
            }
            if (annotations.length > 0) {
                rep.annotations = annotations;
            }
        }

        return rep;
    }

    // A canonical string identifying this cell's exact visual contents
    // (card identity + every piece's owner/size/orientation) - the legend
    // only ever grows entries for combinations actually on the board, built
    // fresh each render() call, matching Knight Line's encodePiece/
    // createPiece pattern.
    private cellRenderKey(t: Territory | undefined, cls: CellClass): string {
        const cardPart = t?.card !== undefined ? t.card.uid : (cls === "wasteland" ? "waste" : "void");
        // Piece.id() (owner+size+orientation, no punctuation) - legend keys
        // end up as literal DOM ids in the renderer, and a "." breaks
        // querySelector("#" + key) since it reads as a class selector.
        const piecesPart = (t?.pieces ?? []).map(p => p.id()).join("_");
        return `k_${cardPart}_${piecesPart}`;
    }

    // Gnostica's own card face, built from scratch rather than
    // `card.toGlyph()`: a four-corner layout modelled on Decktet's own
    // toGlyph() (rank/suit badges in the corners), not a tarot-deck fact,
    // so it lives here rather than in the generic tarot module.
    //   - top-left: the rank (minors) or major arcana numeral, plain text.
    //   - top-right: a "piece" circle holding the suit icon (minors) or the
    //     major's first power icon - always populated.
    //   - bottom-left: nothing at all for minors; for majors, an empty
    //     circle, except when the card has a 3rd icon (only the Devil,
    //     currently), which populates it.
    //   - bottom-right: nothing for pip minors (A-10); an empty circle for
    //     court minors (P/N/Q/K); for majors, a circle populated with the
    //     2nd icon if the card has one, else empty.
    private buildCardFace(card: TarotCard, compact: boolean): Glyph[] {
        const stack: Glyph[] = [{ name: "piece-square", scale: 1 }];

        // `compact` (board tiles, which also have to fit up to 3+ pieces in
        // the same small square) pushes the four corners further out and
        // shrinks everything in them, versus the roomier sizing tuned for a
        // card shown alone. The non-compact numbers below are the ones
        // already tuned by eye for card format - left untouched.
        const rankText = card.major ? (card as MajorCard).romanNumeral : (card as MinorCard).rank.uid;
        const rankScale = compact ? 0.25 : 0.45;
        const corner = compact ? BOARD_TILE_GRID_CORNER : 250;
        const rankShift = compact ? -675 : -corner;
        stack.push({
            text: rankText,
            scale: rankScale,
            colour: "_context_strokes",
            nudge: { dx: rankShift, dy: rankShift },
        });

        const icons = card.major
            ? getMajorArcanaIcons(card as MajorCard)
            : (card as MinorCard).suit.glyph !== undefined ? [(card as MinorCard).suit.glyph!] : [];
        const circleScale = compact ? 0.25 : 0.45;
        const iconScale = compact ? 0.15 : 0.30;
        // The renderer positions a glyph via a scale-INDEPENDENT anchor
        // (nudge - 250 in its internal 500-unit canvas) and only then
        // applies that glyph's own scale around that anchor, so two glyphs
        // sharing one nudge only share a visual centre when they also share
        // scale - confirmed by inspecting the rendered <use> elements'
        // actual x/y/transform. `iconShift` compensates so a smaller-scaled
        // icon still lands centred on its larger coin. The non-compact value
        // (375) was tuned by eye; the compact value is only scaled
        // proportionally to the corner change (unverified - the exact
        // number likely needs the same by-eye check the original did).
        const iconShift = compact ? 1075 : 375;
        // A solid "piece" circle backdrop, matching the physical sticker
        // sheet's always-printed circles - the icon (if any) is composed on
        // top of it. Flat fill, no opacity blending.
        const pushCircle = (xdir: number, ydir: number, iconName?: string) => {
            stack.push({ name: "piece", scale: circleScale, colour: "_context_board", nudge: { dx: xdir * corner, dy: ydir * corner } });
            if (iconName !== undefined) {
                stack.push({ name: iconName, scale: iconScale, nudge: { dx: xdir * iconShift, dy: ydir * iconShift } });
            }
        };

        // Top-right: always populated.
        pushCircle(1, -1, icons[0]);

        if (card.major) {
            pushCircle(-1, 1, icons[2]);
            pushCircle(1, 1, icons[1]);
        } else if ((card as MinorCard).rank.court) {
            pushCircle(1, 1, undefined);
        }

        return stack;
    }

    // A board tile has to show the card AND up to 3 pieces in the same
    // small square, so it uses the compact card face (smaller rank/circle
    // sizing) rather than the roomier default meant for a card shown alone
    // (e.g. a hand, once that's rendered).
    private buildCellGlyph(t: Territory | undefined, cls: CellClass): Glyph | [Glyph, ...Glyph[]] {
        const stack: Glyph[] = [];
        if (t?.card !== undefined) {
            stack.push(...this.buildCardFace(t.card, true));
        } else {
            // Wasteland: a faint neutral square so the clickable area is
            // visible without implying a territory is there. Void cells are
            // never given a legend entry at all (rendered as "-").
            stack.push({ name: "piece-square-borderless", scale: 1, opacity: cls === "wasteland" ? 0.15 : 0 });
        }
        const pieces = t?.pieces ?? [];
        this.pieceGridSlots(pieces).forEach((slot, i) => {
            const g = this.pyramidGlyph(pieces[i]);
            g.scale = slot.scale;
            g.nudge = { dx: slot.dx, dy: slot.dy };
            stack.push(g);
        });
        return stack as [Glyph, ...Glyph[]];
    }

    // Pieces are never allowed to visually stack/overlap, but a territory
    // can legitimately hold more than 3 (some major arcana powers bypass
    // Territory's normal capacity check - see Territory.canAdd()), so this
    // can't just be a fixed 3-slot table.
    //
    // Up to 5 pieces: each piece's own orientation names its preferred cell
    // in the tile's 3x3 grid (PIECE_GRID_SLOTS/PIECE_GRID_PREFERRED_INDEX) -
    // an N-facing piece wants the top-centre cell, "up" wants dead centre,
    // etc. Two pieces sharing an orientation (or one whose preferred cell
    // is already taken) means only one gets it; the rest are bumped into
    // whatever cells are still free, in no particular order for now - a
    // first pass, not yet visually tuned the way the card face was.
    private pieceGridSlots(pieces: Piece[]): { dx: number; dy: number; scale: number }[] {
        const n = pieces.length;
        if (n === 0) {
            return [];
        }
        if (n > PIECE_GRID_SLOTS.length) {
            return this.densePieceGrid(n);
        }
        const claimed = new Set<number>();
        const chosenIdx: number[] = new Array(n);
        pieces.forEach((p, i) => {
            const idx = PIECE_GRID_PREFERRED_INDEX[p.orientation];
            if (!claimed.has(idx)) {
                claimed.add(idx);
                chosenIdx[i] = idx;
            }
        });
        const free = PIECE_GRID_SLOTS.map((_, idx) => idx).filter(idx => !claimed.has(idx));
        for (let i = 0; i < n; i++) {
            if (chosenIdx[i] === undefined) {
                chosenIdx[i] = free.shift()!;
            }
        }
        return chosenIdx.map((idx, i) => {
            const [dirX, dirY] = PIECE_GRID_SLOTS[idx];
            const targetX = dirX * PIECE_GRID_RADIUS;
            const targetY = dirY * PIECE_GRID_RADIUS;
            const orientation = pieces[i].orientation;
            if (orientation === "up") {
                // No rotate on this glyph at all - nudge is applied in
                // plain screen space, no compensation needed.
                return { dx: targetX, dy: targetY, scale: 0.48 };
            }
            const [cos, sin] = CARDINAL_COS_SIN[orientation];
            return {
                dx: targetX * cos + targetY * sin,
                dy: -targetX * sin + targetY * cos,
                scale: 0.48,
            };
        });
    }

    // Overflow fallback for the rare case of more pieces than the 3x3
    // grid has spare cells for (5) - a dense shrink-to-fit grid, unrelated
    // to (and not checked against) where the card face's own corners land.
    private densePieceGrid(n: number): { dx: number; dy: number; scale: number }[] {
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const span = 800;
        const cellW = span / cols;
        const cellH = span / rows;
        const scale = Math.min(0.48, (0.9 * Math.min(cellW, cellH)) / 500);
        const slots: { dx: number; dy: number; scale: number }[] = [];
        for (let i = 0; i < n; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            slots.push({
                dx: -span / 2 + cellW * (col + 0.5),
                dy: -span / 2 + cellH * (row + 0.5),
                scale,
            });
        }
        return slots;
    }

    // "up" pyramids stand upright, drawn once with no rotation; N/E/S/W
    // pyramids are the same "flat/pointing" glyph rotated to face that
    // direction - the exact pattern btt.ts uses for its own Icehouse pieces.
    private pyramidGlyph(piece: Piece): Glyph {
        const sizeNames = ["small", "medium", "large"];
        const sizeName = sizeNames[piece.size - 1];
        if (piece.orientation === "up") {
            return { name: `pyramid-up-${sizeName}`, colour: piece.owner };
        }
        const rotations: Record<Exclude<Orientation, "up">, number> = { N: 0, E: 90, S: 180, W: -90 };
        return { name: `pyramid-flat-${sizeName}`, colour: piece.owner, rotate: rotations[piece.orientation] };
    }

    // Each player's remaining reserve, by size - see the `player-stashes` flag.
    public getPlayerStash(player: number): { count: number; glyph: Glyph; movePart: string }[] | undefined {
        const stash = this.stashes.get(player as playerid);
        if (stash === undefined) {
            return undefined;
        }
        const sizeNames = ["small", "medium", "large"];
        return stash.map((count, i) => ({
            count,
            glyph: { name: `pyramid-up-${sizeNames[i]}`, colour: player },
            movePart: (i + 1).toString(),
        }));
    }
}
