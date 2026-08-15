import { GameBase, IAPGameState, IClickResult, IIndividualState, IMoveOptions, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaButtonBar, AreaPieces, ButtonBarButton, Glyph } from "@abstractplay/renderer/build/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, shuffle, UserFacingError } from "../common";
import { UnboundedSquareBoard } from "../common/unbounded-square-board";
import { Deck, MinorCard, MajorCard, TarotCard, allCards, ranks, suits } from "../common/tarot";
import { GnosticaBoard, CellClass } from "./gnostica/board";
import { Territory, ITerritory } from "./gnostica/Territory";
import { Piece, Orientation, cardinalOrientations } from "./gnostica/Piece";
import {
    Stash, PowerContext, PowerFailure, takeFromStash, hasStashAvailable,
    createOwn, createCopy, createTerritory,
    movePiece, moveTerritory,
    growPiece, growTerritory,
    attackPiece, attackTerritory,
    orientMinion, orientAny, hierophantReplace,
    hermitMovePiece, hermitMoveTerritory, tradeHands,
    judgementDraw, highPriestess,
    checkCreateOwn, checkCreateCopy, checkCreateTerritory,
    checkMovePiece, checkMoveTerritory,
    checkGrowPiece, checkGrowTerritory,
    checkAttackPiece, checkAttackTerritory,
    checkOrientMinion, checkOrientAny, checkHierophantReplace,
    checkHermitMovePiece, checkHermitMoveTerritory, checkTradeHands,
    checkJudgementDraw, checkHighPriestess,
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

// The non-mutating validator's counterpart to IStepOutcome: either a
// failure (validation stops here - `result` is the final, i18n-wrapped
// answer) or a successful step's predicted outcome (validation continues -
// same chaining information IStepOutcome carries, just computed read-only
// instead of read off a board that's actually been mutated).
type StepValidation =
    | { failed: true; result: IValidationResult }
    | { failed: false; outcome?: IStepOutcome };

// Click support for minor arcana's single suit-power step (major arcana
// chaining is out of scope for this pass - see parsePendingMinorStep()).
// One entry per suit+mode: the button label, whether the mode's target is a
// whole cell (assertValidCellTarget) or a specific piece within one
// (assertValidPieceTarget, which additionally always allows self regardless
// of facing), and the minimum number of tokens after "<minionRef> <mode>"
// needed before applyMinorPower() will actually attempt the primitive
// rather than treating the step as still-in-progress (see its own docs).
// Trailing optional args (a reorientation after acting on your own piece)
// are deliberately not counted here, and not click-driven this pass either
// - every mode is fully usable without one, just not adjustable by click.
interface MinorModeConfig {
    label: string;
    shape: "cell" | "piece" | "none";
    minArgs: number;
}
const MINOR_MODES: Record<string, Record<string, MinorModeConfig>> = {
    C: {
        own: { label: "Create Minion", shape: "cell", minArgs: 2 },
        copy: { label: "Create Enemy", shape: "cell", minArgs: 2 },
        new: { label: "Create Territory", shape: "cell", minArgs: 2 },
    },
    R: {
        piece: { label: "Move Piece", shape: "piece", minArgs: 2 },
        tile: { label: "Push Territory", shape: "none", minArgs: 1 },
    },
    D: {
        piece: { label: "Grow Piece", shape: "piece", minArgs: 1 },
        tile: { label: "Grow Territory", shape: "cell", minArgs: 2 },
    },
    S: {
        piece: { label: "Attack Piece", shape: "piece", minArgs: 2 },
        tile: { label: "Attack Territory", shape: "cell", minArgs: 2 },
    },
};

// The engine-side view of an in-progress "activate"/"play" click sequence
// for a minor arcana card - reconstructed fresh from the move string on
// every call (same philosophy as isPendingFirstPlacement/
// highlightedButtonValues, not persisted anywhere). `minion` always defaults
// to the first eligible piece (see eligibleMinionsForActivate/Play's own
// docs on why disambiguating between several eligible minions by click is
// out of scope this pass). Undefined whenever there's nothing here for the
// minor-arcana click flow to do - no activate/play in progress, the card is
// major (out of scope), or there are no eligible minions at all.
interface IPendingMinorStep {
    head: "activate" | "play";
    headArg: string;
    suitUid: string;
    minion: IMinionRef;
    mode?: string;
    rest: string[];
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
    // Transient click-UI hint, not part of persisted game state - see
    // move()'s own docs for exactly what this does and does not track.
    private liveMove: string | undefined;

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

    // `partial: true` is the playground/interface's live-preview signal -
    // "apply this move's effects so I can render what it would look like,
    // but don't treat it as an actual, final turn" (see Homeworlds' own
    // move(), which documents the exact same contract). Every hand-card
    // toggle click re-renders a preview by calling move(..., {partial:
    // true}) on a disposable reconstructed instance; without honouring
    // that flag, each of those preview calls was running full end-of-move
    // processing - advancing the turn and re-drawing for real - which is
    // exactly what produced the reported "discards immediately replaced,
    // one at a time" bug. The `partial` object this method mutates is
    // documented (by that same Homeworlds precedent) as left in a
    // possibly-inconsistent state afterwards; only ever call it on a
    // disposable/throwaway instance.
    public move(m: string, opts: IMoveOptions = {}): GnosticaGame {
        const { partial = false, trusted = false } = opts;
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
        this.applyMove(m, partial);
        this.lastmove = m;
        // A transient, unpersisted UI hint - NOT the same thing as
        // this.lastmove (the actual recorded last move, part of official
        // game state, serialized every real commit - see moveState()).
        // liveMove exists purely to answer "is there an in-progress
        // preview of the CURRENT player's own turn right now" for
        // getActionButtons()'s benefit: set to `m` for a partial preview
        // call, explicitly cleared back to undefined the moment a turn is
        // actually committed - so by the time render() next runs (for
        // whoever's turn is now current), there is nothing left over from
        // the previous player's finished action to misread, without
        // needing to compare against stack history at read time. Mirrors
        // Magnate's own this.highlights field (also reset/populated fresh
        // per move() call, never persisted).
        this.liveMove = partial ? m : undefined;
        if (partial) {
            return this;
        }
        this.nextPlayer();
        this.checkEOG();
        this.saveState();
        return this;
    }

    // Walks the exact same move grammar applyMove() does, but read-only -
    // every legality check is a direct query against live (unmutated)
    // state, or a checkX call from gnostica/powers.ts (the same predicate
    // the matching mutating function calls before mutating - see powers.ts's
    // own docs on why that split keeps the two from drifting apart). Replaces the old
    // "clone this, try applyMove() on the clone, catch whatever it throws"
    // approach: that mechanism silently discarded every specific reason a
    // suit-power move was illegal, since the thrown GnosticaRulesError
    // wasn't a UserFacingError and the catch block only ever unwrapped
    // UserFacingError's `.client` - every powers.ts failure surfaced as the
    // generic INVALID_MOVE fallback instead of its real message. Fixed as a
    // side effect here: every validateX/checkX failure below carries its
    // own key straight through to the returned message.
    public validateMove(m: string): IValidationResult {
        m = m.trim();
        if (m.length === 0) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS") };
        }
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
            return this.invalid("apgames:validation._general.INVALID_MOVE", { move: m });
        }

        const [head, ...rest] = remaining[0].split(/\s+/);
        const stepSegments = remaining.slice(1).map(s => s.split(/\s+/));
        const requireNoSteps = (): IValidationResult | undefined => {
            if (stepSegments.length > 0) {
                return this.invalid("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: head });
            }
            return undefined;
        };

        let failure: IValidationResult | undefined;
        switch (head.toLowerCase()) {
            case "place":
                failure = requireNoSteps() ?? this.validatePlace(rest);
                break;
            case "orient":
                failure = requireNoSteps() ?? this.validateHasPiecesOnBoard() ?? this.validateOrient(rest);
                break;
            case "draw":
                failure = requireNoSteps() ?? this.validateHasPiecesOnBoard() ?? this.validateDraw(rest);
                break;
            case "activate":
                failure = this.validateHasPiecesOnBoard() ?? this.validateActivate(rest, stepSegments);
                break;
            case "play":
                failure = this.validateHasPiecesOnBoard() ?? this.validatePlay(rest, stepSegments);
                break;
            default:
                failure = this.invalid("apgames:validation._general.UNRECOGNIZED_MOVE", { move: remaining[0] });
        }
        if (failure !== undefined) {
            return failure;
        }

        if (announceLast && this.lastTurnAnnouncedBy !== undefined && this.lastTurnAnnouncedBy !== this.currplayer) {
            return this.invalid("apgames:validation.gnostica.ALREADY_ANNOUNCED");
        }

        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    private invalid(key: string, params?: Record<string, unknown>): IValidationResult {
        return { valid: false, complete: -1, message: i18next.t(key, params) };
    }

    private failureResult(failure: PowerFailure): IValidationResult {
        return this.invalid(`apgames:validation.gnostica.${failure.key}`, failure.params);
    }

    private validateHasPiecesOnBoard(): IValidationResult | undefined {
        if (!this.hasPiecesOnBoard(this.currplayer)) {
            return this.invalid("apgames:validation.gnostica.MUST_PLACE_FIRST");
        }
        return undefined;
    }

    private tryParseOrientation(s: string | undefined): Orientation | undefined {
        if (s === undefined) {
            return undefined;
        }
        if (s.toLowerCase() === "up") {
            return "up";
        }
        const dir = s.toUpperCase();
        if ((cardinalOrientations as string[]).includes(dir)) {
            return dir as Orientation;
        }
        return undefined;
    }

    private tryAlgebraic2coords(cell: string): [number, number] | undefined {
        try {
            return GnosticaBoard.algebraic2coords(cell);
        } catch {
            return undefined;
        }
    }

    private tryParsePieceRef(ref: string | undefined): { x: number; y: number; index: number } | undefined {
        if (ref === undefined) {
            return undefined;
        }
        const parts = ref.split(".");
        if (parts.length !== 2) {
            return undefined;
        }
        const [cellStr, idxStr] = parts;
        const index = parseInt(idxStr, 10);
        if (Number.isNaN(index)) {
            return undefined;
        }
        const coords = this.tryAlgebraic2coords(cellStr);
        if (coords === undefined) {
            return undefined;
        }
        const [x, y] = coords;
        return { x, y, index };
    }

    // A syntactically-complete move that the click flow itself built up
    // (as opposed to one the user finished typing) is still provisional -
    // place/orient's orientation and draw's discard list are all optional
    // refinements the player may want to keep clicking through, so this
    // deliberately downgrades validateMove()'s natural complete:1 to 0
    // whenever the move is otherwise valid. Matches Knight Line's own
    // mm.complete-vs-result.complete distinction: complete:1 tells the
    // interface it's safe to auto-finalize the move on its own, which is
    // wrong here - only the player's own explicit "Submit Move" should end
    // the click sequence, or the very first click auto-submits "up" before
    // there's ever a chance to cycle to a real facing.
    private provisionalResult(newmove: string): IClickResult {
        const result = this.validateMove(newmove) as IClickResult;
        result.move = newmove;
        if (result.valid && result.complete === 1) {
            result.complete = 0;
        }
        return result;
    }

    // A result for a button-seeded but not-yet-targeted action ("activate"/
    // "play"/"orient" with no cell/card chosen yet) - deliberately NOT run
    // through validateMove(), since the bare keyword alone would just
    // report as an error (it's missing required args by design, not
    // broken). Mirrors validateMove()'s own empty-string case: valid,
    // complete:-1, an instructional message telling the player what to
    // click next.
    private modeSeedResult(newmove: string, messageKey: string): IClickResult {
        return { move: newmove, valid: true, complete: -1, message: i18next.t(messageKey) };
    }

    // The six top-level turn choices, as buttons - see the class-level docs
    // above render() for why: a bare click on a cell/piece the acting
    // player already occupies is genuinely ambiguous between "orient this"
    // and "activate this card", and there's no second click region per
    // cell to disambiguate with. None of these are legal with zero board
    // pieces (place is the only option then, and needs no button - a
    // direct empty-cell click already builds it). "Declare" only makes
    // sense once some other action is already chosen, but is still offered
    // up front, same as the others.
    // A partial preview of an in-progress (not yet submitted) "place"
    // click already mutates this.board for rendering purposes (see
    // move()'s own docs on `partial`), so hasPiecesOnBoard() alone can't
    // tell "genuinely has committed board presence" apart from "just
    // tentatively placed this same turn, still building the move".
    //
    // `r.how !== undefined` excludes Cups' "own"/"copy" modes, which also
    // push a `type:"place"` result (see applyCups) - those can only ever
    // happen once the acting player already has committed board presence
    // (activate/play both require it), so they can never actually BE a
    // pending first placement; without this check they'd still falsely
    // match the shape above (same result type, a `where` the current
    // player now occupies) and collapse the button bar back down to the
    // single "Place" button mid-power-step.
    //
    // Gated on this.liveMove (see move()'s own docs) rather than
    // this.results directly: results are reset every move() call, partial
    // or real, so on their own they can't tell "the CURRENT player's own
    // in-progress preview" apart from "whatever the PREVIOUS player's own
    // just-finished turn happened to leave behind" - liveMove is
    // explicitly cleared the instant a turn is actually committed, so it's
    // undefined for exactly the window where results would otherwise be
    // stale. Without this, a cell the previous player's own action
    // touched that also happens to hold the NEW current player's own
    // piece (a perfectly ordinary contested cell) would misread as that
    // player's own in-progress action.
    private isPendingFirstPlacement(): boolean {
        if (this.liveMove === undefined) {
            return false;
        }
        return this.results.some(r => {
            if (r.type !== "place" || r.where === undefined || r.how !== undefined) {
                return false;
            }
            const [px, py] = GnosticaBoard.algebraic2coords(r.where);
            return this.board.get(px, py)?.pieces.some(p => p.owner === this.currplayer) ?? false;
        });
    }

    // Which button(s) to bold, based on this.liveMove (see move()'s own
    // docs) - unlike this.results, which some actions (e.g. an activate
    // that declines its power) never populate at all, liveMove is set
    // uniformly for every kind of in-progress preview. "Declare" is a
    // modifier, not a top-level choice, so it can be highlighted alongside
    // whatever the base action is, not instead of it. Naturally empty
    // whenever there's no live preview right now (liveMove undefined) -
    // see isPendingFirstPlacement's docs for why that matters.
    private highlightedButtonValues(): Set<string> {
        const found = new Set<string>();
        if (this.liveMove === undefined) {
            return found;
        }
        const segments = this.liveMove.split(/\s*[\n,;/\\]\s*/).filter(s => s.length > 0);
        const head = segments[0]?.split(/\s+/)[0]?.toLowerCase();
        if (head !== undefined && ["place", "activate", "play", "orient", "draw"].includes(head)) {
            found.add(head);
        }
        if (segments.some(s => s.toLowerCase() === "last")) {
            found.add("declare");
        }
        return found;
    }

    private getActionButtons(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (this.gameover) {
            return undefined;
        }
        // A live preview of "activate"/"play" can only ever have STARTED
        // with the acting player already having board presence - both
        // throw via requireHasPiecesOnBoard() otherwise - so a piece count
        // of zero mid-preview (e.g. a Sword attack that ends up destroying
        // the acting player's own last minion) is a legitimate side effect
        // of the very same in-progress move, not a sign a fresh placement
        // turn is needed. Without this, hasPiecesOnBoard() below would
        // misread that transient state and collapse the bar down to
        // "Place" mid-preview, even though the in-progress move is still
        // perfectly valid and submittable as-is.
        const midPowerStep = this.liveMove !== undefined && /^(activate|play)\b/.test(this.liveMove);
        if ((!midPowerStep && !this.hasPiecesOnBoard(this.currplayer)) || this.isPendingFirstPlacement()) {
            // Only one action is legal here regardless of which case this
            // is - place is a full turn on its own with zero real board
            // presence, so nothing else should be offered mid-placement
            // either. A single bold button rather than nothing at all,
            // mirroring Magnate's own single-button "Choose" state for an
            // analogous "only one thing possible right now" situation.
            return [{ label: "Place", value: "place", attributes: [{ name: "font-weight", value: "bold" }] }];
        }
        const topLevel: ButtonBarButton[] = [
            { label: "Use Territory", value: "activate" },
            { label: "Use Hand Card", value: "play" },
            { label: "Orient", value: "orient" },
            { label: "Discard", value: "draw" },
            { label: "Pass", value: "pass" },
        ];
        if (this.lastTurnAnnouncedBy === undefined || this.lastTurnAnnouncedBy === this.currplayer) {
            topLevel.push({ label: "Declare", value: "declare" });
        }
        const highlighted = this.highlightedButtonValues();
        for (const b of topLevel) {
            if (b.value !== undefined && highlighted.has(b.value)) {
                b.attributes = [{ name: "font-weight", value: "bold" }];
            }
        }

        const pendingMinor = this.liveMove !== undefined ? this.parsePendingMinorStep(this.liveMove) : undefined;
        if (pendingMinor === undefined) {
            return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
        }

        // Once a minor-arcana power step's suit modes are on offer, there
        // isn't room to also keep the full top-level set around - only the
        // one choice that got us here (Use Territory/Use Hand Card) stays,
        // followed by a non-interactive spacer button (the schema has no
        // dedicated divider type) and this step's own mode buttons. Declare
        // stays available throughout (it's an orthogonal end-of-turn
        // flourish, not a step in this particular choice), tacked on at the
        // end rather than lost.
        const selected = topLevel.find(b => b.value === pendingMinor.head);
        const declareBtn = topLevel.find(b => b.value === "declare");
        const buttons: ButtonBarButton[] = selected !== undefined ? [selected] : [];
        buttons.push({ label: "→", value: "_spacer" });
        for (const mode of this.legalMinorModes(pendingMinor)) {
            const config = MINOR_MODES[pendingMinor.suitUid][mode];
            const button: ButtonBarButton = { label: config.label, value: `mode_${pendingMinor.suitUid}_${mode}` };
            if (pendingMinor.mode === mode) {
                button.attributes = [{ name: "font-weight", value: "bold" }];
            }
            buttons.push(button);
        }
        if (declareBtn !== undefined) {
            buttons.push(declareBtn);
        }
        return buttons as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Reconstructs the in-progress minor-arcana power step (if any) purely
    // from a move string - same "recompute, don't persist" approach as
    // isPendingFirstPlacement/highlightedButtonValues. `moveStr` is passed
    // explicitly (rather than always reading this.liveMove) so handleClick
    // can call this with its own `move` parameter mid-click, before that
    // click's result has been partial-applied back into this.liveMove -
    // the two stay in lockstep in practice (see the click-handling docs
    // below), but this keeps the dependency explicit either way.
    // `minion` always defaults to the first eligible piece - disambiguating
    // between several eligible minions by click is out of scope this pass
    // (mirrors the same simplification "orient" already makes). Undefined
    // whenever there's nothing here for the minor-arcana click flow to do:
    // no activate/play in progress, the card is major (chaining isn't
    // click-driven yet), or there's no eligible minion at all.
    private parsePendingMinorStep(moveStr: string): IPendingMinorStep | undefined {
        const segments = moveStr.split(/\s*[\n,;/\\]\s*/).filter(s => s.length > 0);
        if (segments.length === 0) {
            return undefined;
        }
        const [head, ...headArgs] = segments[0].split(/\s+/);
        if (head !== "activate" && head !== "play") {
            return undefined;
        }
        const headArg = headArgs[0];
        if (headArg === undefined) {
            return undefined;
        }
        let card: MinorCard | MajorCard | undefined;
        let eligible: IMinionRef[];
        if (head === "activate") {
            let x: number, y: number;
            try {
                [x, y] = GnosticaBoard.algebraic2coords(headArg);
            } catch {
                return undefined;
            }
            card = this.board.get(x, y)?.card;
            eligible = this.eligibleMinionsForActivate(x, y);
        } else {
            card = allCards().find(c => c.uid === headArg);
            eligible = this.eligibleMinionsForPlay();
        }
        if (card === undefined || card.major || eligible.length === 0) {
            return undefined;
        }
        const suitUid = (card as MinorCard).suit.uid;
        const stepTokens = segments.length >= 2 ? segments[1].split(/\s+/) : [];
        const [, mode, ...rest] = stepTokens; // stepTokens[0] is the minionRef - always eligible[0] by construction
        return { head, headArg, suitUid, minion: eligible[0], mode, rest };
    }

    // The single valid cell a minor suit-power step may affect, per
    // assertValidCellTarget in powers.ts: the minion's own cell if it's
    // facing "up", otherwise the one cell it's pointing at. Also used as
    // the DEFAULT target for "piece"-shaped modes (self is additionally
    // always valid there too, per assertValidPieceTarget - clicking the
    // minion's own cell switches to that instead, see
    // handlePendingMinorBoardClick).
    private minorTargetCell(minion: IMinionRef): [number, number] {
        const piece = this.board.get(minion.x, minion.y)!.pieces[minion.index];
        if (piece.orientation === "up") {
            return [minion.x, minion.y];
        }
        const [dx, dy] = this.board.delta(piece.orientation as Exclude<Orientation, "up">);
        return [minion.x + dx, minion.y + dy];
    }

    private pieceRefStr(x: number, y: number, index: number): string {
        return `${GnosticaBoard.coords2algebraic(x, y)}.${index}`;
    }

    // Click-to-orient: clicking the cell a piece already occupies means
    // "face up"; clicking one of its four orthogonal neighbours means
    // "face that way" - one click always states the intended direction
    // outright, rather than stepping through up to 5 states via a toggle.
    // Every one of a piece's neighbours is guaranteed to be inside the
    // current render window (padded by exactly 1 beyond the board's own
    // bounding box - see render()'s own docs) and, since void cells now
    // render an invisible-but-clickable placeholder there too, guaranteed
    // clickable regardless of whether that neighbour is a territory,
    // wasteland, or void. Returns undefined when `toX,toY` is neither the
    // piece's own cell nor an orthogonal neighbour of it.
    private orientationTowardClick(fromX: number, fromY: number, toX: number, toY: number): Orientation | undefined {
        if (fromX === toX && fromY === toY) {
            return "up";
        }
        for (const dir of cardinalOrientations) {
            const [dx, dy] = this.board.delta(dir as Exclude<Orientation, "up">);
            if (fromX + dx === toX && fromY + dy === toY) {
                return dir;
            }
        }
        return undefined;
    }

    // A void cell only ever matters to click-to-orient (see
    // orientationTowardClick) as the facing target of a piece sitting on a
    // WASTELAND cell next door - a piece on an actual territory can never
    // have a void neighbour at all (any neighbour of a card-bearing cell is
    // itself at worst a wasteland, by classify()'s own definition), so this
    // only needs to check wasteland neighbours, not territory ones too.
    private voidCellNeedsClickTarget(x: number, y: number): boolean {
        return this.board.neighbors(x, y).some(([nx, ny]) => {
            if (this.board.classify(nx, ny) !== "wasteland") {
                return false;
            }
            return (this.board.get(nx, ny)?.pieces.length ?? 0) > 0;
        });
    }

    // Best-effort filter over which modes are worth offering as buttons
    // right now, given current board state - not a full legality check
    // (validateMove still catches anything this misses or over-includes
    // once the player actually acts). Rods needs its own orientation gate
    // (a piece pointing "up" cannot use a rod at all, per
    // requireCanUseRod in powers.ts); the other three suits have no such
    // restriction.
    private legalMinorModes(pending: IPendingMinorStep): string[] {
        const minion = this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetT = this.board.get(tx, ty);
        return Object.keys(MINOR_MODES[pending.suitUid]).filter(mode => {
            switch (`${pending.suitUid}.${mode}`) {
                case "C.own":
                    return targetT === undefined || targetT.canAdd();
                case "C.copy":
                    return (targetT?.pieces ?? []).some(p => p.owner !== this.currplayer);
                case "C.new":
                    return this.board.classify(tx, ty) === "wasteland";
                case "R.piece":
                case "R.tile":
                    return minion.orientation !== "up";
                case "D.tile":
                case "S.tile":
                    return (targetT?.pointValue() ?? 0) > 0;
                default:
                    return true;
            }
        });
    }

    // Builds the move string for choosing a suit-power mode via button -
    // the minion is always the first eligible one (see
    // IPendingMinorStep's docs), and the target cell is auto-derived
    // (minorTargetCell) since it's fully determined by the minion's own
    // facing, not something the player needs to click. "Piece"-shaped
    // modes default to targeting the minion itself (always structurally
    // valid, regardless of what's in the facing cell) - clicking the
    // facing cell afterwards redirects to a piece there, see
    // handlePendingMinorBoardClick. Deliberately produces a step with
    // FEWER tokens than MINOR_MODES' minArgs for modes needing a hand-card
    // uid (Cups "new", Discs/Swords "tile") - applyMinorPower's own
    // tolerance (see its docs) keeps that a harmless, still-provisional
    // "declined so far" state rather than a thrown error, until
    // supplyMinorCardUid fills it in.
    private buildMinorModeMove(pending: IPendingMinorStep, mode: string): string {
        const ref = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index);
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        const tokens = [ref, mode];
        switch (`${pending.suitUid}.${mode}`) {
            case "C.own":
                tokens.push(targetCell, "up");
                break;
            case "C.copy": {
                const t = this.board.get(tx, ty);
                const victimIdx = (t?.pieces ?? []).findIndex(p => p.owner !== this.currplayer);
                tokens.push(targetCell, String(Math.max(victimIdx, 0)));
                break;
            }
            case "C.new":
                tokens.push(targetCell);
                break;
            case "R.piece":
                tokens.push(ref, "1");
                break;
            case "R.tile":
                tokens.push("1");
                break;
            case "D.piece":
                tokens.push(ref);
                break;
            case "D.tile":
                tokens.push(targetCell);
                break;
            case "S.piece": {
                // Unlike Rods (moving yourself is a normal, common choice)
                // or Discs (growing an ENEMY piece would be self-defeating,
                // so self is the only sensible default), defaulting an
                // attack to the acting player's OWN minion is almost never
                // what's wanted. If the minion is actually facing a piece
                // (not "up", which has no facing cell at all - self really
                // is the only legal target there), default to attacking
                // THAT piece instead - the common case (attack the enemy
                // this minion is pointing at) then needs no second click at
                // all, rather than silently defaulting to self-harm.
                const facingHasPiece = (tx !== pending.minion.x || ty !== pending.minion.y)
                    && (this.board.get(tx, ty)?.pieces.length ?? 0) > 0;
                tokens.push(facingHasPiece ? this.pieceRefStr(tx, ty, 0) : ref, "1");
                break;
            }
            case "S.tile":
                tokens.push(targetCell, "1");
                break;
            default:
                throw new Error(`Unknown minor mode "${pending.suitUid}.${mode}".`);
        }
        return `${pending.head} ${pending.headArg}, ${tokens.join(" ")}`;
    }

    private pendingMoveString(pending: IPendingMinorStep): string {
        if (pending.mode === undefined) {
            return `${pending.head} ${pending.headArg}`;
        }
        const ref = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index);
        return `${pending.head} ${pending.headArg}, ${ref} ${pending.mode} ${pending.rest.join(" ")}`.trim();
    }

    // Board-click handling once a minor-arcana power step's MODE is already
    // chosen (see buildMinorModeMove) - cycling or switching whichever
    // trailing arg(s) that mode's shape supports. Returns undefined when
    // the click isn't one of this step's own interactive targets, so the
    // caller falls back to its own (unrelated) handling.
    //
    // Known, deliberate simplifications (consistent with "orient"'s own
    // first-match precedent elsewhere in this file): picking a specific
    // piece INDEX within a multi-piece facing cell isn't click-driven
    // (always defaults to index 0 there); the optional trailing
    // reorientation available after acting on your own piece isn't
    // click-driven either. Both remain available by typing a move
    // manually.
    private handlePendingMinorBoardClick(pending: IPendingMinorStep, x: number, y: number, cell: string): IClickResult | undefined {
        if (pending.mode === undefined) {
            return undefined;
        }
        const mode = pending.mode;
        const config = MINOR_MODES[pending.suitUid][mode];
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index);
        const minionPiece = this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        const rebuild = (rest: string[]): IClickResult =>
            this.provisionalResult(`${pending.head} ${pending.headArg}, ${minionRef} ${mode} ${rest.join(" ")}`.trim());

        if (config.shape === "cell") {
            const [tx, ty] = this.minorTargetCell(pending.minion);
            // Cups "own" is the one cell-shape mode with an orientation arg
            // (the new piece's own facing) - click-to-orient (see
            // orientationTowardClick) relative to the target cell, so its
            // clickable region is that cell PLUS its neighbours, not just
            // the cell itself like every other cell-shape mode below.
            if (pending.suitUid === "C" && mode === "own") {
                const dir = this.orientationTowardClick(tx, ty, x, y);
                if (dir === undefined) {
                    return undefined;
                }
                return rebuild([GnosticaBoard.coords2algebraic(tx, ty), dir]);
            }
            if (x !== tx || y !== ty) {
                return undefined;
            }
            if (pending.suitUid === "C" && mode === "copy") {
                const t = this.board.get(tx, ty);
                const enemyIndices = (t?.pieces ?? [])
                    .map((p, i) => ({ owner: p.owner, i }))
                    .filter(({ owner }) => owner !== this.currplayer)
                    .map(({ i }) => i);
                if (enemyIndices.length === 0) {
                    return { move: this.pendingMoveString(pending), valid: false, message: i18next.t("apgames:validation.gnostica.NO_ENEMY_THERE", { cell }) };
                }
                const current = parseInt(pending.rest[1] ?? "-1", 10);
                const at = enemyIndices.indexOf(current);
                const next = enemyIndices[(at + 1) % enemyIndices.length];
                return rebuild([cell, String(next)]);
            }
            // "new" (Cups) / "tile" (Discs) - the only remaining arg is a
            // hand-card uid (supplyMinorCardUid), nothing to cycle here.
            return rebuild(pending.rest);
        }

        if (config.shape === "piece") {
            const [faceX, faceY] = this.minorTargetCell(pending.minion);
            const isSelfClick = x === pending.minion.x && y === pending.minion.y;
            const isFaceClick = x === faceX && y === faceY;
            if (!isSelfClick && !isFaceClick) {
                return undefined;
            }
            const currentIsSelf = pending.rest[0] === minionRef;
            const needsNumeric = !(pending.suitUid === "D" && mode === "piece");
            const switchingToSelf = isSelfClick && !currentIsSelf;
            const switchingToFace = isFaceClick && !(faceX === pending.minion.x && faceY === pending.minion.y) && currentIsSelf;
            if (switchingToSelf) {
                return rebuild(needsNumeric ? [minionRef, "1"] : [minionRef]);
            }
            if (switchingToFace) {
                const t = this.board.get(faceX, faceY);
                if (t === undefined || t.pieces.length === 0) {
                    return { move: this.pendingMoveString(pending), valid: false, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE", { cell }) };
                }
                const ref = this.pieceRefStr(faceX, faceY, 0);
                return rebuild(needsNumeric ? [ref, "1"] : [ref]);
            }
            // Same cell as the current target - cycle the numeric arg, if any.
            if (!needsNumeric) {
                return rebuild(pending.rest);
            }
            const maxArg = minionPiece.size;
            const current = parseInt(pending.rest[1] ?? "1", 10);
            const next = (current % maxArg) + 1;
            return rebuild([pending.rest[0], String(next)]);
        }

        // "none" shape (Rods' "tile" mode) - only the minion's own cell is
        // interactive, cycling distance.
        if (x !== pending.minion.x || y !== pending.minion.y) {
            return undefined;
        }
        const maxArg = minionPiece.size;
        const current = parseInt(pending.rest[0] ?? "1", 10);
        const next = (current % maxArg) + 1;
        return rebuild([String(next)]);
    }

    // Supplies a hand-card uid for whichever minor-arcana mode is currently
    // waiting on one (Cups "new", Discs/Swords "tile") - the caller (a
    // hand-card click in handleClick) has already confirmed the card is
    // actually in hand. Returns undefined if the current pending step isn't
    // waiting on a card right now, so the caller falls back to its own
    // (unrelated) hand-card handling. Deliberately doesn't pre-validate
    // that the card's point value is the one actually required (a spot
    // card for Cups; current+1 for Discs; current-pips for Swords) -
    // that's createTerritory/growTerritory/
    // attackTerritory's own job, surfaced as an ordinary validation
    // message if the player picks the wrong one.
    private supplyMinorCardUid(pending: IPendingMinorStep, uid: string): IClickResult | undefined {
        if (pending.mode === undefined) {
            return undefined;
        }
        const key = `${pending.suitUid}.${pending.mode}`;
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index);
        let rest: string[];
        if ((key === "C.new" || key === "D.tile") && pending.rest.length === 1) {
            rest = [pending.rest[0], uid];
        } else if (key === "S.tile" && pending.rest.length === 2) {
            rest = [...pending.rest, uid];
        } else {
            return undefined;
        }
        return this.provisionalResult(`${pending.head} ${pending.headArg}, ${minionRef} ${pending.mode} ${rest.join(" ")}`);
    }

    // Click support for the top-level turn choice (via the button bar from
    // getActionButtons()) plus the simple, single-segment actions - place,
    // orient, activate/play with power declined, and toggling hand cards
    // into a draw's discard list. activate/play's chained power steps
    // aren't click-driven yet (deliberately scoped out of this pass).
    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            if (piece !== undefined && piece.startsWith("_btn_")) {
                const value = piece.slice("_btn_".length);
                if (value.startsWith("mode_")) {
                    // "mode_<suitUid>_<mode>" - see getActionButtons()'s own
                    // pendingMinor branch, which only ever offers one of
                    // these once a minor-arcana activate/play is already
                    // seeded (0 steps taken yet).
                    const [, suitUid, mode] = value.split("_");
                    const pending = this.parsePendingMinorStep(move);
                    if (pending === undefined || pending.suitUid !== suitUid) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    return this.provisionalResult(this.buildMinorModeMove(pending, mode));
                }
                switch (value) {
                    case "pass":
                    case "draw":
                        // Discard's own bare seed is already a legal,
                        // complete move on its own (discard nothing) - no
                        // different from Pass, so both just build it.
                        return this.provisionalResult("draw");
                    case "place":
                        // Not strictly necessary (an empty move already
                        // builds "place <cell>" directly from a bare board
                        // click, see below), but offered as a button too
                        // for consistency with every other action, now
                        // that "place" is always shown as the sole choice
                        // rather than an empty bar - see getActionButtons().
                        return this.modeSeedResult("place", "apgames:validation.gnostica.PICK_CELL_TO_PLACE");
                    case "activate":
                        return this.modeSeedResult("activate", "apgames:validation.gnostica.PICK_CARD_TO_ACTIVATE");
                    case "play":
                        return this.modeSeedResult("play", "apgames:validation.gnostica.PICK_HAND_CARD_TO_PLAY");
                    case "orient":
                        return this.modeSeedResult("orient", "apgames:validation.gnostica.PICK_PIECE_TO_ORIENT");
                    case "declare": {
                        if (move.trim().length === 0) {
                            return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
                        }
                        const segments = move.split(/\s*[\n,;/\\]\s*/).filter(s => s.length > 0);
                        const hasLast = segments.some(s => s.toLowerCase() === "last");
                        const newmove = hasLast
                            ? segments.filter(s => s.toLowerCase() !== "last").join(", ")
                            : `${move}, last`;
                        return this.provisionalResult(newmove);
                    }
                    default:
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                }
            }

            // Segment-aware, not just whitespace-split - once a minor-arcana
            // power step is being built the move string has a second,
            // comma-separated segment (see buildMinorModeMove), and a naive
            // split(/\s+/) would leave a trailing comma stuck to the cell
            // token. Only the HEAD segment's own tokens are needed here;
            // the pending-step helpers below do their own full parsing.
            const headSegments = move.length > 0 ? move.split(/\s*[\n,;/\\]\s*/).filter(s => s.length > 0) : [];
            const [head, ...args] = headSegments.length > 0 ? headSegments[0].split(/\s+/) : [];

            // Hand-card clicks (from the per-player AreaPieces built in
            // render()) arrive as `piece`, independent of row/col - only
            // the acting player's own hand can be touched. A card click
            // means something different depending on what's already in
            // progress: supplying a card uid for a pending minor-arcana
            // power step in progress (Cups "new", Discs/Swords "tile"),
            // playing the card outright ("play"), or toggling it into a
            // draw's discard list (the default, if no mode is active).
            if (piece !== undefined && piece.startsWith("hand_")) {
                const uid = piece.slice("hand_".length);
                const hand = this.hands[this.currplayer - 1] ?? [];
                if (!hand.includes(uid)) {
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
                }
                const pendingForCard = this.parsePendingMinorStep(move);
                if (pendingForCard?.mode !== undefined) {
                    const result = this.supplyMinorCardUid(pendingForCard, uid);
                    if (result !== undefined) {
                        return result;
                    }
                    // Not a mode expecting a card uid right now - fall
                    // through to the ordinary hand-card behaviour below.
                }
                if (head === "play") {
                    return this.provisionalResult(`play ${uid}`);
                }
                let discards = head === "draw" ? [...args] : [];
                if (discards.includes(uid)) {
                    discards = discards.filter(u => u !== uid);
                } else {
                    discards.push(uid);
                }
                return this.provisionalResult(["draw", ...discards].join(" "));
            }

            const minX = this.board.minX - 1;
            const minY = this.board.minY - 1;
            const x = col + minX;
            const y = row + minY;
            const cell = GnosticaBoard.coords2algebraic(x, y);

            let newmove: string;

            if (head === "place") {
                // Click-to-orient (see orientationTowardClick's own docs):
                // once a placement cell is chosen, clicking it again means
                // "face up", clicking one of its neighbours means "face
                // that way" - any OTHER cell is a fresh placement there
                // instead (defaulting to "up" again), same as clicking a
                // different cell always has.
                const [prevCell] = args;
                let dir: Orientation | undefined;
                if (prevCell !== undefined) {
                    const [px, py] = GnosticaBoard.algebraic2coords(prevCell);
                    dir = this.orientationTowardClick(px, py, x, y);
                }
                if (prevCell !== undefined && dir !== undefined) {
                    newmove = `place ${prevCell} ${dir}`;
                } else {
                    newmove = `place ${cell}`;
                }
            } else if (head === "orient") {
                // Same click-to-orient model as "place" above, but relative
                // to whichever piece is already selected (prevRef) rather
                // than the clicked cell - a click on a cell adjacent to
                // THAT piece sets its facing, even if the clicked cell also
                // happens to hold another of the player's own pieces
                // (known simplification: to re-select a different, ADJACENT
                // own piece instead, click a non-adjacent cell first, or
                // just submit and start over - re-selecting rarely matters
                // once a piece is already picked).
                const [prevRef] = args;
                let dir: Orientation | undefined;
                if (prevRef !== undefined) {
                    const loc = this.parsePieceRef(prevRef);
                    dir = this.orientationTowardClick(loc.x, loc.y, x, y);
                }
                if (prevRef !== undefined && dir !== undefined) {
                    newmove = `orient ${prevRef} ${dir}`;
                } else {
                    const myPieceIdx = this.board.get(x, y)?.pieces.findIndex(p => p.owner === this.currplayer) ?? -1;
                    if (myPieceIdx === -1) {
                        return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NO_SUCH_PIECE", { ref: cell }) };
                    }
                    newmove = `orient ${cell}.${myPieceIdx} up`;
                }
            } else if (head === "activate" || head === "play") {
                // Once a minor-arcana power step's mode is already chosen,
                // a board click is target/arg cycling for that step first -
                // see handlePendingMinorBoardClick's own docs. Falls
                // through to the ordinary activate/play handling below only
                // when the click doesn't match one of that step's own
                // interactive targets (undefined).
                const pending = this.parsePendingMinorStep(move);
                if (pending !== undefined && pending.mode !== undefined) {
                    const result = this.handlePendingMinorBoardClick(pending, x, y, cell);
                    if (result !== undefined) {
                        return result;
                    }
                }
                if (head === "play") {
                    // "play" has no cell of its own to re-pick the way
                    // "activate" does below - a board click here only ever
                    // means pending-step cycling (handled above); anything
                    // else is ambiguous.
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
                }
                const t = this.board.get(x, y);
                if (t?.card === undefined) {
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NO_CARD_THERE", { cell }) };
                }
                if (!t.pieces.some(p => p.owner === this.currplayer)) {
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NO_MINIONS_THERE", { cell }) };
                }
                newmove = `activate ${cell}`;
            } else if (!this.hasPiecesOnBoard(this.currplayer)) {
                // Fresh click, nothing placed yet - place is the only legal
                // start, and needs no button.
                newmove = `place ${cell}`;
            } else {
                // No mode chosen yet (or an unrecognized one) and pieces
                // already exist - board clicks are genuinely ambiguous
                // here (see getActionButtons()'s docs), so this doesn't
                // guess; the player picks a button first.
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
            }

            return this.provisionalResult(newmove);
        } catch {
            return {
                move,
                valid: false,
                message: i18next.t("apgames:validation._general.DEFAULT_HANDLER"),
            };
        }
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
    private applyMove(m: string, partial = false): void {
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
                this.cmdDraw(rest, partial);
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

    private validatePlace(args: string[]): IValidationResult | undefined {
        const [cellStr, orientationStr] = args;
        if (cellStr === undefined) {
            return this.invalid("apgames:validation.gnostica.PLACE_CELL_REQUIRED");
        }
        if (this.hasPiecesOnBoard(this.currplayer)) {
            return this.invalid("apgames:validation.gnostica.ALREADY_ON_BOARD");
        }
        const orientation = this.tryParseOrientation(orientationStr ?? "up");
        if (orientation === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr });
        }
        const coords = this.tryAlgebraic2coords(cellStr);
        if (coords === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr });
        }
        const [x, y] = coords;
        if (this.board.classify(x, y) === "void") {
            return this.invalid("apgames:validation.gnostica.PLACE_VOID", { cell: cellStr });
        }
        const territory = this.board.get(x, y);
        if (territory !== undefined && territory.pieces.length > 0) {
            return this.invalid("apgames:validation.gnostica.PLACE_OCCUPIED", { cell: cellStr });
        }
        if (!hasStashAvailable(this.buildPowerContext(), this.currplayer, 1)) {
            return this.invalid("apgames:validation.gnostica.STASH_EMPTY", { player: this.currplayer, size: 1 });
        }
        return undefined;
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

    private validateOrient(args: string[]): IValidationResult | undefined {
        const [ref, orientationStr] = args;
        if (ref === undefined || orientationStr === undefined) {
            return this.invalid("apgames:validation.gnostica.ORIENT_ARGS_REQUIRED");
        }
        const loc = this.tryParsePieceRef(ref);
        if (loc === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref });
        }
        const piece = this.board.get(loc.x, loc.y)?.pieces[loc.index];
        if (piece === undefined) {
            return this.invalid("apgames:validation.gnostica.NO_SUCH_PIECE", { ref });
        }
        if (piece.owner !== this.currplayer) {
            return this.invalid("apgames:validation.gnostica.NOT_YOUR_PIECE", { ref });
        }
        if (this.tryParseOrientation(orientationStr) === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr });
        }
        return undefined;
    }

    // "draw [uid...]" - discard the named hand cards, then redraw to 6,
    // reshuffling the discard pile into the draw pile if it runs dry.
    //
    // `partial` (set only by move()'s live-preview calls, never by a real
    // submitted move) stops after the discard step, deliberately skipping
    // the redraw - the player may still be clicking through more cards to
    // discard, and drawing replacements prematurely would either reveal
    // cards for a discard set that isn't final yet, or require redrawing
    // (and discarding the previous preview's draws back into the deck) on
    // every subsequent click. The hand simply shows smaller while this is
    // in progress; the real draw only happens once, on final submission.
    private cmdDraw(args: string[], partial = false): void {
        const hand = this.hands[this.currplayer - 1];
        for (const uid of args) {
            const idx = hand.indexOf(uid);
            if (idx === -1) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }));
            }
            hand.splice(idx, 1);
            this.discardPile.push(uid);
        }
        if (partial) {
            return;
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

    // Every named uid is checked up front, including rejecting the same
    // uid named twice - cmdDraw's own loop mutates the hand as it goes, so
    // a repeated uid already fails there (found once, then genuinely gone
    // from hand on the second lookup); this reproduces that without
    // actually mutating anything.
    private validateDraw(args: string[]): IValidationResult | undefined {
        const hand = this.hands[this.currplayer - 1];
        const seen = new Set<string>();
        for (const uid of args) {
            if (seen.has(uid)) {
                return this.invalid("apgames:validation.gnostica.DUPLICATE_CARD", { uid });
            }
            seen.add(uid);
            if (!hand.includes(uid)) {
                return this.invalid("apgames:validation.gnostica.NOT_IN_HAND", { uid });
            }
        }
        return undefined;
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
    // Every piece the acting player owns on the activated cell - the pool
    // "activate" draws minions from. Returns [] (rather than throwing) for a
    // cell with no card / no eligible piece, so click-time helpers can use
    // this directly without their own duplicate error handling.
    private eligibleMinionsForActivate(x: number, y: number): IMinionRef[] {
        const t = this.board.get(x, y);
        if (t === undefined || t.card === undefined) {
            return [];
        }
        return t.pieces
            .map((p, index) => ({ x, y, index }))
            .filter(ref => t.pieces[ref.index].owner === this.currplayer);
    }

    // Every piece the acting player owns anywhere on the board - the pool
    // "play" draws minions from.
    private eligibleMinionsForPlay(): IMinionRef[] {
        const eligible: IMinionRef[] = [];
        for (const [x, y, t] of this.board.entries()) {
            t.pieces.forEach((p, index) => {
                if (p.owner === this.currplayer) {
                    eligible.push({ x, y, index });
                }
            });
        }
        return eligible;
    }

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
        const eligible = this.eligibleMinionsForActivate(x, y);
        if (eligible.length === 0) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_MINIONS_THERE", { cell: cellStr }));
        }
        this.applyCardPower(t.card, eligible, stepSegments);
    }

    private validateActivate(args: string[], stepSegments: string[][]): IValidationResult | undefined {
        const [cellStr] = args;
        if (cellStr === undefined) {
            return this.invalid("apgames:validation.gnostica.ACTIVATE_CELL_REQUIRED");
        }
        const coords = this.tryAlgebraic2coords(cellStr);
        if (coords === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr });
        }
        const [x, y] = coords;
        const t = this.board.get(x, y);
        if (t === undefined || t.card === undefined) {
            return this.invalid("apgames:validation.gnostica.NO_CARD_THERE", { cell: cellStr });
        }
        const eligible = this.eligibleMinionsForActivate(x, y);
        if (eligible.length === 0) {
            return this.invalid("apgames:validation.gnostica.NO_MINIONS_THERE", { cell: cellStr });
        }
        return this.validateCardPower(t.card, eligible, stepSegments);
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

        const eligible = this.eligibleMinionsForPlay();
        this.applyCardPower(card, eligible, stepSegments);
    }

    // Doesn't need to simulate cmdPlay's own hand mutation (removing the
    // card before resolving its power) - eligibleMinionsForPlay() only
    // reads board state, never hand contents, so the two are independent
    // regardless of ordering.
    private validatePlay(args: string[], stepSegments: string[][]): IValidationResult | undefined {
        const [uid] = args;
        if (uid === undefined) {
            return this.invalid("apgames:validation.gnostica.PLAY_UID_REQUIRED");
        }
        const hand = this.hands[this.currplayer - 1];
        if (!hand.includes(uid)) {
            return this.invalid("apgames:validation.gnostica.NOT_IN_HAND", { uid });
        }
        const card = allCards().find(c => c.uid === uid);
        if (card === undefined) {
            return this.invalid("apgames:validation.gnostica.UNKNOWN_CARD", { uid });
        }
        const eligible = this.eligibleMinionsForPlay();
        return this.validateCardPower(card, eligible, stepSegments);
    }

    private applyCardPower(card: MinorCard | MajorCard, eligible: IMinionRef[], stepSegments: string[][]): void {
        if (card.major) {
            const def = getMajorArcanaDef(card as MajorCard);
            // Fool and World both delegate to ANOTHER card's full power
            // resolution (a randomly flipped card; any major currently on
            // the board) rather than doing something self-contained - that
            // recursive dispatch is a distinct, not-yet-built piece of work,
            // not an oversight in the chaining logic below. But every
            // power is optional ("keeping in mind that all powers are
            // optional"), including these two - declining it entirely
            // needs no power resolution at all, so only reject when a step
            // is actually attempted.
            if ((def.uid === "00" || def.uid === "21") && stepSegments.length > 0) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.FOOL_WORLD_NOT_YET_SUPPORTED"));
            }
            this.applyMajorPower(def, eligible, stepSegments);
        } else {
            this.applyMinorPower((card as MinorCard).suit.uid, eligible, stepSegments);
        }
    }

    private validateCardPower(card: MinorCard | MajorCard, eligible: IMinionRef[], stepSegments: string[][]): IValidationResult | undefined {
        if (card.major) {
            const def = getMajorArcanaDef(card as MajorCard);
            if ((def.uid === "00" || def.uid === "21") && stepSegments.length > 0) {
                return this.invalid("apgames:validation.gnostica.FOOL_WORLD_NOT_YET_SUPPORTED");
            }
            const majorResult = this.validateMajorPower(def, eligible, stepSegments);
            return majorResult;
        }
        return this.validateMinorPower((card as MinorCard).suit.uid, eligible, stepSegments);
    }

    // Tolerant of an incomplete step (mode chosen but not enough trailing
    // args yet, or no mode at all) rather than throwing - treated as still
    // effectively "declined so far", same trick Magnate's own move parser
    // uses to let the click flow build a move up incrementally across
    // several clicks, each producing a fully-parseable (if still
    // provisional) move string. Genuinely wrong data (a garbled minionRef,
    // an unrecognized mode, more than one step) still throws - only
    // "not enough tokens yet" is swallowed. See MINOR_MODES for minArgs.
    private applyMinorPower(suitUid: string, eligible: IMinionRef[], stepSegments: string[][]): void {
        if (stepSegments.length === 0) {
            return; // power declined - always optional
        }
        if (stepSegments.length > 1) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.MINOR_ONE_STEP_ONLY"));
        }
        const [minionRef, mode, ...rest] = stepSegments[0];
        if (minionRef === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.POWER_STEP_ARGS_REQUIRED"));
        }
        const loc = this.parsePieceRef(minionRef);
        const minion = eligible.find(e => e.x === loc.x && e.y === loc.y && e.index === loc.index);
        if (minion === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NOT_AN_ELIGIBLE_MINION", { ref: minionRef }));
        }
        if (mode === undefined) {
            return; // minion earmarked, mode not chosen yet - still declined
        }
        const config = MINOR_MODES[suitUid]?.[mode];
        if (config === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: suitUid }));
        }
        if (rest.length < config.minArgs) {
            return; // mode chosen, args not yet complete - still declined
        }
        this.applySuitPrimitive(suitUid, minion, mode, rest, {});
    }

    // Mirrors applyMinorPower's own tolerance exactly (declining, and an
    // incomplete-so-far step, both still validate as "fine, nothing to
    // report yet") - see its docs.
    private validateMinorPower(suitUid: string, eligible: IMinionRef[], stepSegments: string[][]): IValidationResult | undefined {
        if (stepSegments.length === 0) {
            return undefined; // power declined - always optional
        }
        if (stepSegments.length > 1) {
            return this.invalid("apgames:validation.gnostica.MINOR_ONE_STEP_ONLY");
        }
        const [minionRef, mode, ...rest] = stepSegments[0];
        if (minionRef === undefined) {
            return this.invalid("apgames:validation.gnostica.POWER_STEP_ARGS_REQUIRED");
        }
        const loc = this.tryParsePieceRef(minionRef);
        if (loc === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: minionRef });
        }
        const minion = eligible.find(e => e.x === loc.x && e.y === loc.y && e.index === loc.index);
        if (minion === undefined) {
            return this.invalid("apgames:validation.gnostica.NOT_AN_ELIGIBLE_MINION", { ref: minionRef });
        }
        if (mode === undefined) {
            return undefined; // minion earmarked, mode not chosen yet - still declined
        }
        const config = MINOR_MODES[suitUid]?.[mode];
        if (config === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: suitUid });
        }
        if (rest.length < config.minArgs) {
            return undefined; // mode chosen, args not yet complete - still declined
        }
        const stepResult = this.validateSuitPrimitive(suitUid, minion, mode, rest, {});
        return stepResult.failed ? stepResult.result : undefined;
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

    private validateMajorPower(def: MajorArcanaDef, eligible: IMinionRef[], stepSegments: string[][]): IValidationResult | undefined {
        if (stepSegments.length > def.powers.length) {
            return this.invalid("apgames:validation.gnostica.TOO_MANY_POWER_STEPS");
        }
        let minions = [...eligible];
        for (let i = 0; i < stepSegments.length; i++) {
            const step = def.powers[i];
            const tokens = stepSegments[i];
            const stepResult = this.validatePowerStep(step, minions, tokens, def, i, stepSegments.length);
            if (stepResult.failed) {
                return stepResult.result;
            }
            if (stepResult.outcome?.newMinion !== undefined) {
                minions = [...minions, stepResult.outcome.newMinion];
            }
        }
        return undefined;
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

    // No "incomplete step, still declined" tolerance here (unlike
    // validateMinorPower) - major arcana chaining isn't click-driven yet,
    // so applyPowerStep never needed that leniency and this mirrors it
    // exactly: a missing/unrecognized mode surfaces as a real BAD_MODE
    // failure from validateSuitPrimitive, not a silent no-op.
    private validatePowerStep(
        step: PowerStep, minions: IMinionRef[], tokens: string[], def: MajorArcanaDef, stepIndex: number, totalSteps: number,
    ): StepValidation {
        if ("special" in step && step.special === "highPriestess") {
            const failure = this.validateHighPriestess(tokens);
            if (failure) {
                return { failed: true, result: failure };
            }
            return { failed: false };
        }
        const [minionRef, ...rest] = tokens;
        if (minionRef === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.POWER_STEP_ARGS_REQUIRED") };
        }
        const loc = this.tryParsePieceRef(minionRef);
        if (loc === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: minionRef }) };
        }
        const minion = minions.find(m => m.x === loc.x && m.y === loc.y && m.index === loc.index);
        if (minion === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.NOT_AN_ELIGIBLE_MINION", { ref: minionRef }) };
        }
        if ("primitive" in step) {
            const [mode, ...modeArgs] = rest;
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts);
            return this.validateSuitPrimitive(step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S", minion, mode, modeArgs, opts);
        }
        switch (step.special) {
            case "orientMinion":
                return this.validateOrientMinion(minion, rest);
            case "orientAny":
                return this.validateOrientAny(minion, rest);
            case "hierophantReplace":
                return this.validateHierophantReplace(minion, rest);
            case "hermitTeleport":
                return this.validateHermitStep(minion, rest);
            case "tradeHands":
                return this.validateTradeHands(minion, rest);
            case "judgementDraw": {
                const failure = this.validateJudgementDraw(minion, rest);
                return failure !== undefined ? { failed: true, result: failure } : { failed: false };
            }
            case "magicianChoice":
                return this.validateMagicianChoice(minion, rest);
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.SPECIAL_NOT_YET_SUPPORTED", { special: step.special }) };
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

    private validateSuitPrimitive(suitUid: string, minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown>): StepValidation {
        switch (suitUid) {
            case "C":
                return this.validateCups(minion, mode, rest, opts);
            case "R":
                return this.validateRods(minion, mode, rest, opts);
            case "D":
                return this.validateDiscs(minion, mode, rest, opts);
            case "S":
                return this.validateSwords(minion, mode, rest, opts);
            default:
                return { failed: true, result: this.invalid("apgames:validation._general.DEFAULT_HANDLER") };
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
                createOwn(ctx, minion.x, minion.y, minion.index, tx, ty, orientation, opts);
                this.results.push({ type: "place", where: cellStr, how: "cups-own" });
                const newIndex = this.board.get(tx, ty)!.pieces.length - 1;
                return { newMinion: { x: tx, y: ty, index: newIndex } };
            }
            case "copy": {
                const [cellStr, victimIdxStr] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const victimIndex = parseInt(victimIdxStr, 10);
                createCopy(ctx, minion.x, minion.y, minion.index, tx, ty, victimIndex, opts);
                this.results.push({ type: "place", where: cellStr, how: "cups-copy" });
                return {}; // the new piece belongs to the copied enemy, not the acting player
            }
            case "new": {
                const [cellStr, cardArg] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                if (cardArg === "random") {
                    createTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, undefined, { ...opts, allowRandomDraw: true });
                } else {
                    createTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, cardArg, opts);
                }
                this.results.push({ type: "discover", where: cellStr });
                return {};
            }
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Cups" }));
        }
    }

    private validateCups(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "own": {
                const [cellStr, orientationStr] = rest;
                const coords = this.tryAlgebraic2coords(cellStr);
                if (coords === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr }) };
                }
                const [tx, ty] = coords;
                const orientation = this.tryParseOrientation(orientationStr);
                if (orientation === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
                }
                const failure = checkCreateOwn(ctx, minion.x, minion.y, minion.index, tx, ty, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                // The new piece is always pushed to the end - its
                // pre-mutation length here IS its post-mutation index.
                const newIndex = this.board.get(tx, ty)?.pieces.length ?? 0;
                return { failed: false, outcome: { newMinion: { x: tx, y: ty, index: newIndex } } };
            }
            case "copy": {
                const [cellStr, victimIdxStr] = rest;
                const coords = this.tryAlgebraic2coords(cellStr);
                if (coords === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr }) };
                }
                const [tx, ty] = coords;
                const victimIndex = parseInt(victimIdxStr, 10);
                if (Number.isNaN(victimIndex)) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_NUMBER", { value: victimIdxStr }) };
                }
                const failure = checkCreateCopy(ctx, minion.x, minion.y, minion.index, tx, ty, victimIndex, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false }; // the new piece belongs to the copied enemy, not the acting player
            }
            case "new": {
                const [cellStr, cardArg] = rest;
                const coords = this.tryAlgebraic2coords(cellStr);
                if (coords === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr }) };
                }
                const [tx, ty] = coords;
                const failure = cardArg === "random"
                    ? checkCreateTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, undefined, { ...opts, allowRandomDraw: true })
                    : checkCreateTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, cardArg, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
            }
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Cups" }) };
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
                movePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, dist, newOrientation, opts);
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
                moveTerritory(ctx, minion.x, minion.y, minion.index, dist);
                const from = GnosticaBoard.coords2algebraic(srcX, srcY);
                const to = GnosticaBoard.coords2algebraic(srcX + dx * dist, srcY + dy * dist);
                this.results.push({ type: "move", from, to, how: "rod-tile" });
                return {};
            }
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Rods" }));
        }
    }

    private validateRods(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const [targetRef, distStr, orientationStr] = rest;
                const target = this.tryParsePieceRef(targetRef);
                if (target === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: targetRef }) };
                }
                const dist = parseInt(distStr, 10);
                if (Number.isNaN(dist)) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_NUMBER", { value: distStr }) };
                }
                if (orientationStr !== undefined && this.tryParseOrientation(orientationStr) === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
                }
                const failure = checkMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, dist, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                const movedOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
                const facing = this.board.get(minion.x, minion.y)!.pieces[minion.index].orientation;
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "up">);
                const destX = target.x + dx * dist;
                const destY = target.y + dy * dist;
                if (movedOwner === this.currplayer) {
                    const newIndex = this.board.get(destX, destY)?.pieces.length ?? 0;
                    return { failed: false, outcome: { newMinion: { x: destX, y: destY, index: newIndex } } };
                }
                return { failed: false };
            }
            case "tile": {
                const [distStr] = rest;
                const dist = parseInt(distStr, 10);
                if (Number.isNaN(dist)) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_NUMBER", { value: distStr }) };
                }
                const failure = checkMoveTerritory(ctx, minion.x, minion.y, minion.index, dist);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
            }
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Rods" }) };
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
                growPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, newOrientation);
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
                growTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, newCardUid, opts);
                this.results.push({ type: "convert", what: beforeUid, into: newCardUid, where: cellStr });
                return {};
            }
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Discs" }));
        }
    }

    private validateDiscs(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const [targetRef, orientationStr] = rest;
                const target = this.tryParsePieceRef(targetRef);
                if (target === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: targetRef }) };
                }
                if (orientationStr !== undefined && this.tryParseOrientation(orientationStr) === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
                }
                const failure = checkGrowPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                const targetPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                if (targetPiece.owner === this.currplayer) {
                    // Growing replaces the piece in place (removeAt then
                    // add at the end) - net piece count at this cell is
                    // unchanged, so the pre- and post-mutation "last index"
                    // are the same value.
                    const newIndex = (this.board.get(target.x, target.y)?.pieces.length ?? 1) - 1;
                    return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex } } };
                }
                return { failed: false };
            }
            case "tile": {
                const [cellStr, newCardUid] = rest;
                const coords = this.tryAlgebraic2coords(cellStr);
                if (coords === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr }) };
                }
                const [tx, ty] = coords;
                const failure = checkGrowTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, newCardUid, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
            }
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Discs" }) };
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
                attackPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, pips, newOrientation, opts);
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
                attackTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, pips, newCardUid, opts);
                this.results.push({ type: "destroy", where: cellStr });
                return {};
            }
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Swords" }));
        }
    }

    private validateSwords(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const [targetRef, pipsStr, orientationStr] = rest;
                const target = this.tryParsePieceRef(targetRef);
                if (target === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: targetRef }) };
                }
                const pips = parseInt(pipsStr, 10);
                if (Number.isNaN(pips)) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_NUMBER", { value: pipsStr }) };
                }
                if (orientationStr !== undefined && this.tryParseOrientation(orientationStr) === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
                }
                const failure = checkAttackPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, pips, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                const targetPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                const owner = targetPiece.owner;
                const resultSize = targetPiece.size - pips;
                if (resultSize > 0 && owner === this.currplayer) {
                    // Shrinking replaces the piece in place, same net
                    // count as Discs' own grow above.
                    const newIndex = (this.board.get(target.x, target.y)?.pieces.length ?? 1) - 1;
                    return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex } } };
                }
                return { failed: false };
            }
            case "tile": {
                const [cellStr, pipsStr, newCardUid] = rest;
                const coords = this.tryAlgebraic2coords(cellStr);
                if (coords === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr }) };
                }
                const [tx, ty] = coords;
                const pips = parseInt(pipsStr, 10);
                if (Number.isNaN(pips)) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_NUMBER", { value: pipsStr }) };
                }
                const failure = checkAttackTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, pips, newCardUid, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
            }
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Swords" }) };
        }
    }

    // orientMinion: <minionRef> <newOrientation> - no targeting restriction,
    // any current minion.
    private applyOrientMinion(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [orientationStr] = rest;
        const orientation = this.parseOrientation(orientationStr);
        orientMinion(this.buildPowerContext(), minion.x, minion.y, minion.index, orientation);
        this.results.push({ type: "orient", where: `${minion.x},${minion.y}.${minion.index}`, facing: orientation });
        return { newMinion: minion };
    }

    private validateOrientMinion(minion: IMinionRef, rest: string[]): StepValidation {
        const [orientationStr] = rest;
        if (this.tryParseOrientation(orientationStr) === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
        }
        const failure = checkOrientMinion(this.buildPowerContext(), minion.x, minion.y, minion.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        return { failed: false, outcome: { newMinion: minion } };
    }

    // orientAny (Devil only): <minionRef> <targetPieceRef> <newOrientation>
    // - still subject to the minion's own self/adjacent targeting rule,
    // just without the "must be your own piece" restriction.
    private applyOrientAny(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [targetRef, orientationStr] = rest;
        const target = this.parsePieceRef(targetRef);
        const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const orientation = this.parseOrientation(orientationStr);
        orientAny(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.results.push({ type: "orient", where: targetRef, facing: orientation });
        return owner === this.currplayer ? { newMinion: target } : {};
    }

    private validateOrientAny(minion: IMinionRef, rest: string[]): StepValidation {
        const [targetRef, orientationStr] = rest;
        const target = this.tryParsePieceRef(targetRef);
        if (target === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: targetRef }) };
        }
        if (this.tryParseOrientation(orientationStr) === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
        }
        const failure = checkOrientAny(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        return owner === this.currplayer ? { failed: false, outcome: { newMinion: target } } : { failed: false };
    }

    // Hierophant: <minionRef> <targetPieceRef> <newOrientation>
    private applyHierophantReplace(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [targetRef, orientationStr] = rest;
        const target = this.parsePieceRef(targetRef);
        const orientation = this.parseOrientation(orientationStr);
        hierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.results.push({ type: "convert", what: targetRef, into: `owner-${this.currplayer}` });
        const newIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
        return { newMinion: { x: target.x, y: target.y, index: newIndex } };
    }

    private validateHierophantReplace(minion: IMinionRef, rest: string[]): StepValidation {
        const [targetRef, orientationStr] = rest;
        const target = this.tryParsePieceRef(targetRef);
        if (target === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: targetRef }) };
        }
        if (this.tryParseOrientation(orientationStr) === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
        }
        const failure = checkHierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        // Replace-in-place (removeAt then add) - net piece count at this
        // cell is unchanged, so pre- and post-mutation "last index" match.
        const newIndex = (this.board.get(target.x, target.y)?.pieces.length ?? 1) - 1;
        return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex } } };
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
            hermitMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, destX, destY, newOrientation);
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
            hermitMoveTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, destX, destY);
            this.results.push({ type: "move", from: targetCellStr, to: destCellStr, how: "hermit-tile" });
            return {};
        }
        throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Hermit" }));
    }

    private validateHermitStep(minion: IMinionRef, rest: string[]): StepValidation {
        const [mode, ...args] = rest;
        const ctx = this.buildPowerContext();
        if (mode === "piece") {
            const [targetRef, destCellStr, orientationStr] = args;
            const target = this.tryParsePieceRef(targetRef);
            if (target === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: targetRef }) };
            }
            const destCoords = this.tryAlgebraic2coords(destCellStr);
            if (destCoords === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: destCellStr }) };
            }
            const [destX, destY] = destCoords;
            if (orientationStr !== undefined && this.tryParseOrientation(orientationStr) === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
            }
            const failure = checkHermitMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, destX, destY);
            if (failure) {
                return { failed: true, result: this.failureResult(failure) };
            }
            const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
            if (owner === this.currplayer) {
                const newIndex = this.board.get(destX, destY)?.pieces.length ?? 0;
                return { failed: false, outcome: { newMinion: { x: destX, y: destY, index: newIndex } } };
            }
            return { failed: false };
        } else if (mode === "tile") {
            const [targetCellStr, destCellStr] = args;
            const targetCoords = this.tryAlgebraic2coords(targetCellStr);
            if (targetCoords === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: targetCellStr }) };
            }
            const destCoords = this.tryAlgebraic2coords(destCellStr);
            if (destCoords === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: destCellStr }) };
            }
            const [tx, ty] = targetCoords;
            const [destX, destY] = destCoords;
            const failure = checkHermitMoveTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, destX, destY);
            if (failure) {
                return { failed: true, result: this.failureResult(failure) };
            }
            return { failed: false };
        }
        return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Hermit" }) };
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
        tradeHands(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, otherHand);
        this.results.push({ type: "announce", payload: ["tradeHands", this.currplayer, targetOwner] });
        return {};
    }

    private validateTradeHands(minion: IMinionRef, rest: string[]): StepValidation {
        const [targetRef] = rest;
        const target = this.tryParsePieceRef(targetRef);
        if (target === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_PIECE_REF", { ref: targetRef }) };
        }
        const failure = checkTradeHands(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        return { failed: false };
    }

    // Judgement: <minionRef> <discardUid...>
    private applyJudgementDraw(minion: IMinionRef, rest: string[]): void {
        judgementDraw(this.buildPowerContext(), minion.x, minion.y, minion.index, rest);
        this.results.push({ type: "deckDraw", count: rest.length, from: "discard" });
    }

    private validateJudgementDraw(minion: IMinionRef, rest: string[]): IValidationResult | undefined {
        const failure = checkJudgementDraw(this.buildPowerContext(), minion.x, minion.y, minion.index, rest);
        return failure ? this.failureResult(failure) : undefined;
    }

    // High Priestess: <discardUid...> - no minion reference at all.
    private applyHighPriestess(tokens: string[]): void {
        highPriestess(this.buildPowerContext(), tokens);
        this.results.push({ type: "deckDraw", count: tokens.length, from: "deck" });
    }

    private validateHighPriestess(tokens: string[]): IValidationResult | undefined {
        const failure = checkHighPriestess(this.buildPowerContext(), tokens);
        return failure ? this.failureResult(failure) : undefined;
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

    private validateMagicianChoice(minion: IMinionRef, rest: string[]): StepValidation {
        const [suitLetter, mode, ...args] = rest;
        if (!["C", "R", "D", "S"].includes(suitLetter)) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_SUIT_LETTER", { suitLetter }) };
        }
        return this.validateSuitPrimitive(suitLetter, minion, mode, args, {});
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

        // A void cell only gets a real (invisible-but-clickable) legend
        // entry when a piece might actually need to click it - see
        // voidCellNeedsClickTarget's own docs for exactly when that is.
        // Every other void cell stays the bare "-" the renderer leaves
        // with no legend entry (and no clickable region) at all, to avoid
        // padding the rendered board out with clickable-but-pointless
        // space. Re-rendering happens after every click/commit, so a void
        // cell that only becomes relevant once a piece lands on the
        // wasteland next to it picks up its click target on the very next
        // render - nothing is ever permanently unreachable.
        const legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] } = {};
        const pieceRows: string[] = [];
        for (let y = minY; y <= maxY; y++) {
            const rowCells: string[] = [];
            for (let x = minX; x <= maxX; x++) {
                const cls = this.board.classify(x, y);
                if (cls === "void" && !this.voidCellNeedsClickTarget(x, y)) {
                    rowCells.push("-");
                    continue;
                }
                const t = this.board.get(x, y);
                const key = this.cellRenderKey(t, cls);
                if (!(key in legend)) {
                    legend[key] = this.buildCellGlyph(t);
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

        // One area per player's hand, full-size (non-compact) card faces.
        // Per-viewer redaction (blanking opponents' hand uids to "") is the
        // back end's job, same as every other Decktet-hand game in this
        // repo - this class just has to render whatever it's actually
        // given, including a placeholder for any uid it can't resolve
        // (an opponent's redacted "" entry, matching emu.ts's own
        // "UNKNOWN" convention), rather than assuming every uid is real.
        const areas: (AreaPieces | AreaButtonBar)[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            const hand = this.hands[p - 1] ?? [];
            if (hand.length === 0) {
                continue;
            }
            const handKeys: string[] = [];
            for (const uid of hand) {
                const card = allCards().find(c => c.uid === uid);
                if (card === undefined) {
                    if (!("hand_UNKNOWN" in legend)) {
                        legend.hand_UNKNOWN = [
                            { name: "piece-square", scale: 1 },
                            { text: "?", scale: 0.5, colour: "_context_strokes" },
                        ];
                    }
                    handKeys.push("hand_UNKNOWN");
                    continue;
                }
                const key = `hand_${uid}`;
                if (!(key in legend)) {
                    legend[key] = this.buildCardFace(card, false) as [Glyph, ...Glyph[]];
                }
                handKeys.push(key);
            }
            areas.push({
                type: "pieces",
                pieces: handKeys as [string, ...string[]],
                label: i18next.t("apgames:validation.gnostica.LABEL_HAND", { playerNum: p }),
                // Matches magnate.ts/emu.ts's own hand/deck sizing - tighter
                // than the default auto-wrap-at-board-width spacing, and a
                // fixed width (hands are always <=6 cards) rather than
                // letting row width drift with the board's own size.
                spacing: 0.25,
                width: 6,
                ownerMark: p,
            });
        }

        // The literal drawPile array isn't used for the draw-pile summary -
        // its order/contents are exactly as hidden from this viewer as an
        // opponent's redacted hand uids, so "what's left to draw" is
        // computed by elimination instead: every card in the full 78-card
        // deck that isn't visible somewhere else. This naturally folds
        // hidden opponent hand cards into the same pool - a card sitting
        // unseen in an opponent's hand is exactly as "still in the draw
        // pile" as far as this summary can tell them apart. It also
        // degrades correctly with no redaction at all (e.g. in tests, or a
        // local sandbox with no back end): every hand is then fully
        // visible, so the eliminated set is exactly drawPile's own
        // contents.
        const visible = this.visibleCardUids();
        const unknownUids = allCards().filter(c => !visible.has(c.uid)).map(c => c.uid);
        const drawArea = this.buildDeckSummaryArea(
            unknownUids, "draw", legend, i18next.t("apgames:validation.gnostica.LABEL_DECK")
        );
        if (drawArea !== undefined) {
            areas.push(drawArea);
        }
        // The discard pile is always face-up/public, unlike hands or the
        // draw pile, so its own contents are read directly.
        const discardArea = this.buildDeckSummaryArea(
            this.discardPile, "discard", legend, i18next.t("apgames:validation.gnostica.LABEL_DISCARDS")
        );
        if (discardArea !== undefined) {
            areas.push(discardArea);
        }

        // The top-level turn choice (Use Territory/Use Hand Card/Orient/
        // Discard/Pass/Declare) as buttons - see getActionButtons()'s own
        // docs for why a button bar rather than inferring intent from
        // board clicks alone.
        const actionButtons = this.getActionButtons();
        if (actionButtons !== undefined) {
            areas.push({ type: "buttonBar", position: "right", buttons: actionButtons });
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
            areas: areas.length > 0 ? areas : undefined,
        };

        // A visual marker for wasteland cells (distinct from an occupied
        // territory) is still an open question - a per-cell fill glyph
        // defaults to plain white regardless of opacity (confirmed by
        // reading the renderer's own glyph definition), a MarkerFence
        // border traces the full cell rather than the smaller inset area
        // an actual card occupies, and "enter"-type annotations merge into
        // one outline around their combined union rather than drawing one
        // square per cell, no matter how many separate entries are given
        // (confirmed by actually rendering both cases). Wasteland cells
        // are still fully functional (clickable, correctly classified) -
        // just visually plain for now.
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

        return rep;
    }

    // Every card whose identity is definitively known to whoever is
    // viewing this render: every board territory's card, the always
    // face-up discard pile, and any hand entry that isn't a redacted ""
    // placeholder - including the viewer's own hand, which (per this
    // class's own redaction convention, matching every other Decktet-hand
    // game here) is never blanked for the player it belongs to. Used to
    // compute the draw-pile summary by elimination rather than by reading
    // drawPile's own (equally hidden-from-the-viewer) contents directly.
    private visibleCardUids(): Set<string> {
        const visible = new Set<string>();
        for (const [, , t] of this.board.entries()) {
            if (t.card !== undefined) {
                visible.add(t.card.uid);
            }
        }
        for (const uid of this.discardPile) {
            visible.add(uid);
        }
        for (const hand of this.hands) {
            for (const uid of hand) {
                if (uid !== "") {
                    visible.add(uid);
                }
            }
        }
        return visible;
    }

    // Draw/discard piles can hold most of the 78-card deck at once - too
    // many to show as individual cards. Minor arcana are summarized as one
    // token per (suit, spot-or-royalty) bucket with a count, since only
    // that combination matters for a minor card's identity here (not the
    // exact rank); major arcana are unique, so each remaining one is shown
    // as its own full card face, per the design brief. Returns undefined
    // for an empty pile (no area to show).
    private buildDeckSummaryArea(
        uids: string[], keyPrefix: string, legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, label: string
    ): AreaPieces | undefined {
        if (uids.length === 0) {
            return undefined;
        }
        const counts = new Map<string, number>();
        const majorUids: string[] = [];
        for (const uid of uids) {
            const card = allCards().find(c => c.uid === uid);
            if (card === undefined) {
                continue;
            }
            if (card.major) {
                majorUids.push(uid);
            } else {
                const minor = card as MinorCard;
                const bucket = `${minor.suit.uid}_${minor.rank.court ? "royal" : "spot"}`;
                counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
            }
        }

        const pieces: string[] = [];
        for (const suit of suits) {
            for (const category of ["spot", "royal"] as const) {
                const bucket = `${suit.uid}_${category}`;
                const count = counts.get(bucket);
                if (count === undefined) {
                    continue;
                }
                const key = `${keyPrefix}_${bucket}`;
                if (!(key in legend)) {
                    // Built via buildCardFace itself - same already-tuned
                    // corner/circle numbers as every other card face,
                    // rather than a second, separately-guessed composition.
                    // A representative rank (any court rank for "royal",
                    // any non-court rank for "spot") drives the exact same
                    // icon/circle layout a real card of that category would
                    // get; only the background (borderless, no card-square)
                    // and the rank-corner text (a count, not a real rank)
                    // are overridden.
                    const representativeRank = ranks.find(r => r.court === (category === "royal"))!;
                    const representative = new MinorCard({ rank: representativeRank, suit });
                    legend[key] = this.buildCardFace(representative, false, {
                        borderless: true,
                        rankText: `${count}x`,
                    }) as [Glyph, ...Glyph[]];
                }
                pieces.push(key);
            }
        }
        for (const uid of majorUids.sort()) {
            const key = `${keyPrefix}_${uid}`;
            if (!(key in legend)) {
                const card = allCards().find(c => c.uid === uid)!;
                legend[key] = this.buildCardFace(card, false) as [Glyph, ...Glyph[]];
            }
            pieces.push(key);
        }

        if (pieces.length === 0) {
            return undefined;
        }
        return {
            type: "pieces",
            pieces: pieces as [string, ...string[]],
            label,
            // Tighter and wider than the default auto-wrap - matches
            // magnate.ts/emu.ts's own deck/discard sizing, and there's
            // rarely more than ~30 distinct tokens (8 minor buckets + up to
            // 22 majors) to lay out, so a wide fixed row keeps this to a
            // couple of lines instead of wrapping narrowly.
            spacing: 0.25,
            width: 10,
        };
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
    // `borderless` drops the card-square background (for tokens that
    // summarize a category rather than depict an actual card - see
    // buildDeckSummaryArea); `rankText` overrides the upper-left text
    // (same purpose - a count like "3x" instead of a real rank/numeral).
    private buildCardFace(card: TarotCard, compact: boolean, opts: { borderless?: boolean; rankText?: string } = {}): Glyph[] {
        const stack: Glyph[] = [{ name: opts.borderless ? "piece-square-borderless" : "piece-square", scale: 1 }];

        // `compact` (board tiles, which also have to fit up to 3+ pieces in
        // the same small square) pushes the four corners further out and
        // shrinks everything in them, versus the roomier sizing tuned for a
        // card shown alone. The non-compact numbers below are the ones
        // already tuned by eye for card format - left untouched.
        let rankText = opts.rankText;
        if (rankText === undefined) {
            rankText = card.major ? (card as MajorCard).romanNumeral : (card as MinorCard).rank.uid;
            if (!card.major && (card as MinorCard).rank.uid !== "10") {
                rankText += "\u00A0";
            }
        }
        const rankScale = compact ? 0.25 : 0.45;
        const corner = compact ? BOARD_TILE_GRID_CORNER : 250;
        let rankShiftX = compact ? -675 : -corner;
        let rankShiftY = rankShiftX;
        if (card.major) {
            rankShiftX += compact ? 675 : 250;
            rankShiftY += compact ? -175 : -175;
        }
        const majorRotation = card.major ? -45 : 0;
        stack.push({
            text: rankText,
            scale: rankScale,
            colour: "_context_strokes",
            nudge: { dx: rankShiftX, dy: rankShiftY },
            rotate: majorRotation,
            fontFamily: "Georgia,serif",
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
    private buildCellGlyph(t: Territory | undefined): Glyph | [Glyph, ...Glyph[]] {
        const stack: Glyph[] = [];
        if (t?.card !== undefined) {
            stack.push(...this.buildCardFace(t.card, true));
        } else {
            // Wasteland: fully invisible - its actual visual marker (a
            // dashed border tracing the cell) is a board-level fence
            // marker built once in render(), not a per-cell fill glyph.
            // This placeholder only exists so the cell still has a
            // clickable legend entry, distinct from a void cell (which
            // gets none at all, rendered as "-").
            stack.push({ name: "piece-square-borderless", scale: 1, opacity: 0 });
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
