import { IAPGameState, IClickResult, IIndividualState, IRenderOpts, IScores, IValidationResult } from "./_base";
import { GameBaseSequenced } from "./_turn-sequenced";
import type { IGamePly } from "./_turn-model";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaButtonBar, AreaKey, AreaPieces, ButtonBarButton, Glyph, MarkerOutline } from "@abstractplay/renderer/build/schemas/schema";
import type { ColourResolvable, Colourfuncs } from "@abstractplay/renderer/build/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { Direction, replacer, reviver, shuffle, UserFacingError } from "../common";
import { UnboundedSquareBoard } from "../common/unbounded-square-board";
import { Deck, Card, TarotCard, allCards, ranks, suits } from "../common/tarot";
import { GnosticaBoard, CellClass } from "./gnostica/board";
import { CellContents, ICellContents, cardPointValue } from "./gnostica/cell";
import { Piece, Orientation, Pips, allOrientations, cardinalOrientations } from "./gnostica/piece";
import {
    Stash, PowerContext, PowerFailure, takeFromStash, returnToStash,
    createOwn, createEnemy, createTerritory,
    movePiece, moveTerritory,
    growPiece, growTerritory,
    attackPiece, attackTerritory,
    orientMinion, orientAny, hierophantReplace,
    hermitMovePiece, hermitMoveTerritory, tradeHands,
    judgementDraw, discardDraw, fool, worldChoosePower,
    checkCreateOwn, checkCreateEnemy, checkCreateTerritory,
    checkMovePiece, checkMoveTerritory,
    checkGrowPiece, checkGrowTerritory,
    checkAttackPiece, checkAttackTerritory,
    checkOrientMinion, checkOrientAny, checkHierophantReplace,
    checkHermitMovePiece, checkHermitMoveTerritory, checkTradeHands,
    checkJudgementDraw, checkDiscardDraw, checkFool, checkWorldChoosePower,
} from "./gnostica/powers";
import { MAJOR_ARCANA, MajorArcanaDef, PowerStep, SpecialPower, SuitPrimitive, getMajorArcanaDef, getMajorArcanaIcons } from "./gnostica/majorArcana";
import { generateRandomMove } from "./gnostica/randomMove";
import { ALL_SUITS, MINOR_MODES, HERMIT_MODES, primitiveStepShape, deriveMinorMode, deriveHermitMode, stepMinorMode, stepHermitMode, SPECIAL_STEP_SHAPES, StepShape } from "./gnostica/stepShapes";
import i18next from "i18next";

const MUTED_FILL: Colourfuncs = { func: "flatten", fg: "_context_strokes", bg: "_context_background", opacity: 0.3 };

export type playerid = 1|2|3|4|5|6;

// Major arcana chaining uses frames.  Discards are abbreviated.
export type FrameState = {
    board: UnboundedSquareBoard<CellContents>;
    discardSummary: DiscardSummary;
};

// One button-bar choice, before its value gets a `<prefix>_` prepended - see buildChoiceButtons' own docs.
interface ChoiceOption {
    value: string;
    label: string;
    disabledReason?: { key: string; params?: Record<string, unknown> };
}

// A minion's board location; `piece` carries owner/size/orientation for a newMinion predicted by validate* before the board is actually mutated.
export interface IMinionRef {
    x: number;
    y: number;
    index: number;
    piece?: Piece;
}

// What a single suit-power step did, for chaining later steps of the same major-arcana activation (which of the acting player's own pieces moved).
export interface IStepOutcome {
    newMinion?: IMinionRef;
    // The EXISTING frame-pool entry (matched by x,y,index) newMinion supersedes - unset only when nothing existing became invalid (Cups' "create").
    replacesMinion?: IMinionRef;
    // Hand off to a DIFFERENT card's power array (World's target, or Fool's flip); `viaFool` distinguishes which, since only Fool's makes Decline available.
    pushFrame?: { cardUid: string; minions: IMinionRef[]; viaFool?: boolean };
    // Must pause here regardless of further supplied step segments - the outcome is hidden (Fool's flip) or a later sibling step needs it (High Priestess).
    forcePause?: boolean;
    // This step's tokens still carry a trailing "?" (Cups "own" creation's mandatory facing) - read by validateMinorPower/validateFrameStack as complete:0.
    softComplete?: boolean;
    // Rods "piece" mode's own landing cell, regardless of the moved piece's owner (newMinion is only set for the acting player's own) - Moon's own capacity-restoration check reads this.
    movedToCell?: { x: number; y: number };
    // Swords "piece" mode's own cell, set only when the target was fully destroyed (not just shrunk in place) - Moon's own capacity-restoration check reads this too.
    destroyedAtCell?: { x: number; y: number };
}

// The non-mutating validator's counterpart to IStepOutcome: a failure, or an outcome where `complete: false` marks a still-building step, not a finished one.
type StepValidation =
    | { failed: true; result: IValidationResult }
    | { failed: false; complete?: boolean; outcome?: IStepOutcome };

// resolvePieceRef's result: "ok" (exactly one), "malformed" (syntax), "not_found" (zero matches), or "ambiguous" (2+, narrowable by more fields).
type PieceRefResolution =
    | { kind: "ok"; ref: IMinionRef }
    | { kind: "malformed" }
    | { kind: "not_found" }
    | { kind: "ambiguous" };

interface IParsedMove {
    announceLast: boolean;
    asUid?: string;  //for World
    asSuit?: string; //for Magician
    error?: string;
    head: string | undefined;  //Head may be absent.
    steps: IStep[];
    valid: boolean;
    viaUid?: string; //for Fool and High Priestess
    //Deprecated attribute.
    stepSegments: string[][];
}

export interface IStep {
    action: string;
    amount?: number;
    atCell?: string;
    card?: string; 
    cardList?: string[]; 
    complete?: number;
    direction?: string;
    targetPiece?: string;
    targetCell?: string;
    withPiece?: string;
}

// The engine-side view of an in-progress "use"/"play" click sequence, reconstructed fresh from the move string every call, never persisted.
interface IPendingStep {
    // The verb the front of the move string spells - "play" for a genuine resume, else the literal typed head for a fresh "use"/"play".
    head: "use" | "play";
    // The ROOT card - the one originally used/played/resumed, not necessarily the card whose steps are currently being resolved (see activeCardUid).
    headArg: string;
    // The card whose steps THIS pending step belongs to - equals headArg until a push happens (World's target, Fool's reveal); feeds #67's button label.
    activeCardUid: string;
    // "as <uid> as <suit>" for a meta-card, mirroring IParsedMove's own separate fields - asUid is World's borrow, asSuit is Magician's suit choice.
    asUid?: string;
    asSuit?: string;
    // This step's suit - the card's own for a minor, or the mapped primitive's for a major (create→C/move→R/grow→D/attack→S); unset for a `special` step.
    suitUid?: string;
    // Set instead of suitUid for a major card's `special` power, dispatched to handlePendingSpecialBoardClick rather than the suit-mode machinery above.
    special?: SpecialPower;
    // Every one of the acting player's own eligible pieces, kept in full so a minion-selector ref can still disambiguate against the OTHER candidates.
    eligible: IMinionRef[];
    // eligible plus any newMinion chained in from earlier COMPLETE steps of the same activation; identical to eligible for a minor card or the first step.
    minions: IMinionRef[];
    // Resolved from this step's typed minionRef, or minions[0] as a preview default; minionAmbiguous gates whether that default is trustworthy.
    minion: IMinionRef;
    minionAmbiguous: boolean;
    minionCandidates: IMinionRef[];
    // Earlier complete power-step segments of the same activation, as typed IStep objects; always [] for a minor card.
    priorSteps: IStep[];
    // computeShortcutOpts's result for the CURRENT step - lets minorModeAvailability's button pre-filter account for a same-target-shortcut/Moon card.
    opts: Record<string, unknown>;
    mode?: string;
    rest: string[];
    // The current step's own raw content, already resolved into an IStep - used for completeness gates instead of re-deriving shape from `rest`/`mode`.
    istep: IStep;
}

// A lossless-for-display abbreviation of a raw uid list - individual major uids, plus per-suit/per-(spot|royal) minor COUNTs (minors aren't shown individually).
interface DiscardSummary {
    majorUids: string[];
    counts: Map<string, number>;
}

// One card's power-array progress in the resolution stack; minions is this frame's own accreting pool, seeded at push time, never shared with a sibling.
interface IPowerFrame {
    cardUid: string;
    nextStepIndex: number;
    minions: IMinionRef[];
    // True only for a frame pushed by Fool's reveal - this is what makes Decline available, since flipping (unlike World's target choice) is itself committing.
    viaFool?: boolean;
}

// A same-seat obligation left over from a High Priestess/Fool/World activation that paused mid-chain; rootCardUid is fixed at the original use/play call.
interface IPendingMajorPower {
    rootCardUid: string;
    stack: [IPowerFrame, ...IPowerFrame[]];
}

interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: UnboundedSquareBoard<CellContents>;
    // Card uids per player, index 0 = player 1.
    hands: string[][];
    // Number of hand cards drawn on the player's last turn.
    cardsDrawn: number[];
    drawPile: string[];
    discardPile: string[];
    stashes: Map<playerid, Stash>;
    eliminated: playerid[];
    lastTurner: playerid | undefined;
    lastmove?: string;
    // Present only for a move that chained 2+ major-arcana steps - optional so stack entries predating this feature still deserialize fine.
    frames?: FrameState[];
    // Which card(s) still owe a follow-up move() submission on the same seat before the turn can advance (Fool's two flips, High Priestess's second round).
    continued?: string[];
    // The "bidding" variant's opening procedure - every other variant stays in "main" for its whole lifetime, so the fields below are untouched outside it.
    phase: "bidding" | "redraw" | "main";
    // Per-player 1-based bid position in their own hand, or null if not yet bid (null not undefined, since JSON round-tripping turns undefined into null).
    bidPositions?: (number | null)[];
    // Every card revealed by a bid across every round played - the shared pool players draw back up to 6 from during "redraw"; bidWinner/redrawOrder derive from this.
    biddingPool?: string[];
    // "Tournament rules": play order is exactly the rank order of the cards everyone bid (majors always outrank minors); only ever set for the "bidding" variant.
    turnOrder?: playerid[];
}

export interface IGnosticaState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
}

export class GnosticaGame extends GameBaseSequenced {
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
            { uid: "#target" },
            { uid: "target-10", group: "target" },
            { uid: "bidding" },
            { uid: "no-majors" }
        ],
        categories: ["goal>score>eog", "mechanic>area", "mechanic>capture", "mechanic>hand", "mechanic>place", "board>dynamic", "components>cards-tarot", "components>pyramids", "other>2+players"],
        flags: ["experimental", "no-moves", "custom-randomization", "player-stashes", "autopass", "scores"],
        displays: [{ uid: "larger-cards" }],
    };

    public numplayers!: number;
    public currplayer!: playerid;
    public board!: GnosticaBoard;
    public hands: string[][] = [];
    public cardsDrawn: number[] = [];
    public drawPile: string[] = [];
    public discardPile: string[] = [];
    public stashes!: Map<playerid, Stash>;
    public eliminated: playerid[] = [];
    public lastTurner: playerid | undefined;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    // Populated only for a move chaining 2+ major-arcana steps; left populated even after a partial() call returns, letting the acting player page through their in-progress chain.
    public frames: FrameState[] = [];
    // Which continuing card(s) still owe a follow-up move() submission - only Fool's two flips/High Priestess's second round root an obligation; each entry "<cardUid>.<step>", outermost-first.
    public continued: string[] = [];
    // The "bidding" variant's own state.
    public phase!: "bidding" | "redraw" | "main";
    public bidPositions: (number | null)[] | undefined;
    public biddingPool: string[] | undefined;
    public turnOrder: playerid[] | undefined;

    // How many tied rounds have happened so far (0-indexed) - biddingPool grows by `numplayers` cards every round, so this is exact mid-"bidding".
    public get bidRound(): number {
        return Math.floor((this.biddingPool?.length ?? 0) / this.numplayers);
    }

    // turnOrder[0] is the bid winner by construction (sorted by rank); undefined until a bid has actually resolved.
    public get bidWinner(): playerid | undefined {
        return this.phase === "bidding" ? undefined : this.turnOrder?.[0];
    }

    // Exact reverse of turnOrder - worst bidder redraws first, winner last; only read during "redraw", by which point turnOrder is finalized.
    public get redrawOrder(): playerid[] {
        return [...this.turnOrder!].reverse();
    }

    // How many players have already redrawn - reads the last REAL commit's hands (this.stack's top), immune to a live preview's own in-progress mutation.
    public get redrawPos(): number {
        return this.stack[this.stack.length - 1].hands.filter(h => h.length === 6).length;
    }

    // Transient click-UI hint, not part of persisted game state; stores the ALREADY-PARSED move so readers don't each re-parse the same string.
    private liveMove: IParsedMove | undefined;
    private buffers: Direction[] = [];
    private discarded: string[] = [];

    public targetScore(): number {
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

            // Built directly, not via createTerritory() (which requires the target to already classify as a wasteland - not true for an empty board).
            const board = new GnosticaBoard();
            let boardCards: TarotCard[];
            let drawPile: string[];
            if (this.variants.includes("no-majors")) {
                // Pulls 9 non-major cards out then reshuffles.
                const remaining = deck.cards;
                const nonMajors = remaining.filter(c => !c.major);
                boardCards = nonMajors.splice(0, 9);
                const rest = shuffle([...nonMajors, ...remaining.filter(c => c.major)]) as TarotCard[];
                drawPile = rest.map(c => c.uid);
            } else {
                boardCards = deck.draw(9);
                drawPile = deck.cards.map(c => c.uid);
            }
            
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    board.store.set(x, y, new CellContents(boardCards.pop()));
                }
            }

            const stashes = new Map<playerid, Stash>();
            for (let p = 1; p <= this.numplayers; p++) {
                stashes.set(p as playerid, [5, 5, 5]);
            }

            // Player 1 is the starting player by default; the "bidding" variant runs bid-and-redraw first and only sets currplayer once that resolves.
            const fresh: IMoveState = {
                _version: GnosticaGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board: board.store,
                hands,
                // Do not display the initial hand as a draw.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                cardsDrawn: hands.map(h => 0),
                drawPile,
                discardPile: [],
                stashes,
                eliminated: [],
                lastTurner: undefined,
                phase: this.variants.includes("bidding") ? "bidding" : "main",
                bidPositions: this.variants.includes("bidding") ? new Array(this.numplayers).fill(null) as (number | null)[] : undefined,
                biddingPool: this.variants.includes("bidding") ? [] : undefined,
                turnOrder: this.variants.includes("bidding") ? [...Array(this.numplayers)].map((_, i) => (i + 1) as playerid) : undefined,
                buffer: undefined
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
            // Two-step rehydration: JSON.parse+reviver only restores the outer wrapper; every CellContents still needs its own deserialize() pass.
            this.stack.forEach(s => {
                s.board = GnosticaBoard.rehydrate(s.board as unknown as UnboundedSquareBoard<ICellContents>);
                s.frames?.forEach(f => {
                    f.board = GnosticaBoard.rehydrate(f.board as unknown as UnboundedSquareBoard<ICellContents>);
                });
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
        // Wrap + deep-clone so mutating `this.board` during play never touches the snapshot stored in the stack.
        this.board = new GnosticaBoard(state.board).clone();
        this.hands = state.hands.map(h => [...h]);
        this.cardsDrawn = [...state.cardsDrawn];
        this.drawPile = [...state.drawPile];
        this.discardPile = [...state.discardPile];
        this.stashes = new Map([...state.stashes.entries()].map(([k, v]) => [k, [...v] as Stash]));
        this.eliminated = [...state.eliminated];
        this.lastTurner = state.lastTurner;
        this.lastmove = state.lastmove;
        this.phase = state.phase;
        this.bidPositions = state.bidPositions !== undefined ? [...state.bidPositions] : undefined;
        this.biddingPool = state.biddingPool !== undefined ? [...state.biddingPool] : undefined;
        this.turnOrder = state.turnOrder !== undefined ? [...state.turnOrder] : undefined;
        this.frames = state.frames ? [...state.frames] : [];
        this.continued = state.continued ? [...state.continued] : [];
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
            cardsDrawn: [...this.cardsDrawn],
            drawPile: [...this.drawPile],
            discardPile: [...this.discardPile],
            stashes: new Map([...this.stashes.entries()].map(([k, v]) => [k, [...v] as Stash])),
            eliminated: [...this.eliminated],
            lastTurner: this.lastTurner,
            lastmove: this.lastmove,
            phase: this.phase,
            bidPositions: this.bidPositions !== undefined ? [...this.bidPositions] : undefined,
            biddingPool: this.biddingPool !== undefined ? [...this.biddingPool] : undefined,
            turnOrder: this.turnOrder !== undefined ? [...this.turnOrder] : undefined,
            frames: this.frames.length > 0 ? [...this.frames] : [],
            continued: this.continued.length > 0 ? [...this.continued] : undefined,
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

    // Unlike clone() (last REAL commit only), reflects this.board/hands live, including a partial preview's own in-progress mutation - validateMajorPower needs this.
    public cloneLive(): GnosticaGame {
        const raw = this.state();
        raw.stack = [this.moveState()];
        return new GnosticaGame(JSON.stringify(raw, replacer));
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

        const isEliminated = this.eliminated.indexOf(this.currplayer) > -1;

        // check for autopass first
        if (m === "pass") {
            if (isEliminated) {
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            } else {
                //There may be other autopass circumstances.
                result.valid = false;
                result.message = i18next.t("apgames:validation.gnostica.USE_PASS_BUTTON");
                return result;
            }
        } else {
            // (m !== "pass")
            if (isEliminated) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.gnostica.MUST_PASS");
                return result;
            }
        }

        // Computed once and reused below rather than called twice - board presence can't change between the two reads within a single call.
        const hasPieces = this.hasPiecesOnBoard(this.currplayer);

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            // The real client calls validateMove("") right after every commit to populate the status line; "click a button" fits every state but a fresh placement.
            result.message = i18next.t(
                this.continued.length === 0 && !hasPieces
                    ? "apgames:validation.gnostica.INITIAL_INSTRUCTIONS_PLACE"
                    : "apgames:validation.gnostica.INITIAL_INSTRUCTIONS");
            return result;
        }

        const parsed = this.parseMove(m);

        if (parsed.head === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS") };
        }
        // An unrecognized head or broken step grammar - the click UI never produces either, so this is a hand-edit or broken client, not each head's own validate* job.
        if (!parsed.valid) {
            return  { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: parsed.error ? parsed.error : "" }) };
        }

        const head = parsed.head;

        // A genuine cross-turn pause means EVERY legal move right now has to be resuming it - route on that runtime fact, not the verb the move string spells.
        if (this.continued.length > 0) {
            const activeUid = this.getContinuedUid();
            if (parsed.viaUid !== activeUid)
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "WRONG_VIA_CARD"});
            const allowed = activeUid === "02" ? ["discard"] : ["decline", "play"];
            if (! allowed.includes(parsed.head!))
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "WRONG_CONTINUED_ACTION"});
            return this.validateResumePendingPower(parsed);
        } else if (head === "decline") {
            // "decline" can only appear when continued is populated.
            return this.invalid("apgames:validation.gnostica.NOTHING_TO_DECLINE");
        }

        // Mirrors move()'s own bid/redraw/pass/phase gates - see their docs.
        if (head === "bid" || head === "redraw" || head === "pass") {
            if (head === "bid" && this.phase !== "bidding") {
                return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: head });
            }
            // An eliminated player's own "pass" is already fully handled above (before parseMove even runs), so this.eliminated can't be true for currplayer here.
            if ((head === "redraw" || head === "pass") && this.phase !== "redraw") {
                return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: head });
            }
            if (parsed.steps.length > 1 || parsed.announceLast) {
                return this.invalid("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: head });
            }
            if (head === "bid")
                return this.validateBid(parsed);
            else if (head === "redraw")
                return this.validateRedraw(parsed);
            else {//head === "pass"
                if (this.eliminated.includes(this.currplayer)) {
                    return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
                } else {
                    return this.invalid("apgames:validation.gnostica.BAD_PASS");
                }
            }
        } else if (this.phase !== "main") {
            return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: head });
        }
        
        if (head !== "place" && !hasPieces) {
            //The Fool suicide corner case can be escaped by declining, above.
            return this.invalid("apgames:validation.gnostica.MUST_PLACE_FIRST");
        }
        if (head === "place" && hasPieces) {
            return this.invalid("apgames:validation.gnostica.ALREADY_ON_BOARD");
        }
        // Concurrent lastTurners aren't allowed, so no need to check *who* it is.
        if (parsed.announceLast && this.lastTurner !== undefined) {
            return this.invalid("apgames:validation.gnostica.ALREADY_ANNOUNCED");
        }
        switch (head) {
            case "place": return this.validatePlace(parsed);
            case "orient": return this.validateOrient(parsed);
            case "discard": return this.validateDiscard(parsed);
            case "use": return this.validateActivate(parsed);
            case "play": return this.validatePlay(parsed);
        }
        // Unreachable: head was confirmed recognized above, and bid/redraw/pass/resume are all handled before here.
        return this.invalid("apgames:validation._general.UNRECOGNIZED_MOVE", { move: m });
    }
    
    // Move parsing: "/"-delimited segments (action, then 0+ power steps); parseMove/pickleMove below are the grammar's single structural parser/serializer pair.
    public move(m: string, {trusted = false, partial = false, emulation = false} = {}): GnosticaGame {
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }

        m = m.trim();

        if (! trusted) {
            const result = this.validateMove(m);
            if (! result.valid) {
                throw new UserFacingError("VALIDATION_GENERAL", result.message);
            }
            if (! partial && ( result.complete === undefined || result.complete < 0) ) {
                throw new UserFacingError("VALIDATION_GENERAL", result.message)
            }
        }

        this.results = [];
        this.frames = [];
        this.cardsDrawn[this.currplayer - 1] = 0;
        let head;
        let newLast = this.lastTurner;
        // The frame stack walkFrameStack hands back, serialized into this.continued once past the partial boundary below.
        let residualFrames: IPowerFrame[] | undefined;

        if (m.toLowerCase() === "pass") {
            // validateMove() (above) is the actual gate on WHO may say "pass"; `head` deliberately stays undefined here (see the tail below).
            const why = this.eliminated.includes(this.currplayer) ? "eliminated" : "bidding";
            this.results = [{ type: "pass", who: this.currplayer, why }];
        } else {
            this.buffers = [];
            this.discarded = [];
            
            // Parses and executes `m` against `this` - the one place move grammar is interpreted (validateMove mirrors this exact structure, read-only).
            const parsed = this.parseMove(m);
            head = parsed.head;

            // A genuine cross-turn pause means every legal move right now has to be resuming it; legality of any kind is validateMove's job alone now.
            if (this.continued.length > 0) {
                residualFrames = this.resumePendingPower(this.resumeSteps(parsed), partial, parsed.asUid, parsed.asSuit);
            } else if (head === "bid") {

            // The "bidding" variant's own opening procedure - no power steps, no "last" announcement, own bespoke currplayer advancement.
                this.cmdBid(parsed.steps[0], partial);

            } else if (head === "redraw" || head === "pass") {
                if (head === "redraw") {
                    this.cmdRedraw(parsed.steps[0], partial);
                } else {
                    this.cmdPass(partial);
                }
            } else {
                switch (head) {
                    case "place":
                        this.cmdPlace(parsed.steps[0]);
                        break;
                    case "orient":
                        this.cmdOrient(parsed.steps[0]);
                        break;
                    case "discard":
                        this.cmdDiscard(parsed.steps[0], partial);
                        break;
                    case "use":
                        residualFrames = this.cmdActivate(parsed.steps[0].card!, parsed.steps.slice(1), partial, parsed.asUid, parsed.asSuit);
                        break;
                    case "play":
                        residualFrames = this.cmdPlay(parsed.steps[0].card!, parsed.steps.slice(1), partial, parsed.asUid, parsed.asSuit);
                        break;
                    // "decline" with nothing pending, or any other head with no business here, falls through with no case - a caller bug, not this dispatch's job.
                }

                if (parsed.announceLast) {
                    newLast = this.currplayer;
                    this.results.push({ type: "declare", count: this.getPlayerScore(this.currplayer) });
                }

            }
            // A transient, unpersisted UI hint (not this.lastmove) answering "is there an in-progress preview right now" - cleared the moment a turn commits.
            this.liveMove = partial ? parsed : undefined;

        }
 
        if (partial || emulation) {
            return this;
        }

        // "?" marks a "place"-only click-preview facing as still merely prepopulated, dropped the instant a turn is actually committed.
        this.lastmove = m.replace(/\?/g, "");
        // The walk this turn (if any) resolved some frames and left others still owing; undefined means no walk ran or it stopped on an incomplete step.
        if (residualFrames !== undefined) {
            this.persistContinued(residualFrames);
        }
        // `head` is only assigned inside the parsed-dispatch branch above, so a literal "pass" falls into `else` below and gets the same nextPlayer()/checkEOG().
        if (head === "bid" || head === "redraw" || head === "pass") {
            //Need to rewrite these to remove this exception.
        } else if (this.continued.length > 0) {
            // Same seat still owes a follow-up submission - stay put; checkEOG() doesn't need to run either, since nothing it reads could have changed.
        } else {
            // Only on a real end-of-turn do we check the last turn announcement.
            if (this.lastTurner === this.currplayer) {
                this.results.push({ type: "announce", payload: ["declore", this.getPlayerScore(this.currplayer)] });
                if (this.scoreFor(this.currplayer) >= this.targetScore()) {
                    this.gameover = true;
                    this.winner = [this.currplayer];
                } else {
                    this.eliminatePlayer(this.currplayer);
                    newLast = undefined;
                }
            }

            this.lastTurner = newLast;
            this.nextPlayer();
            this.checkEOG();
        }
        this.saveState();
        return this;
    }

    // English ordinal suffix (1st, 2nd, 3rd, ..., 11th-13th stay "th") - used only for the turn-order legend; plain TS formatting, not an i18next key.
    private static ordinal(n: number): string {
        const j = n % 10;
        const k = n % 100;
        if (j === 1 && k !== 11) return `${n}st`;
        if (j === 2 && k !== 12) return `${n}nd`;
        if (j === 3 && k !== 13) return `${n}rd`;
        return `${n}th`;
    }

    public parseMove(m: string): IParsedMove {
        const HEADWORDS = ["place", "orient", "discard", "use", "play", "decline", "bid", "redraw", "pass"];
        const STEPWORDS = ["discard", "draw", "orient", "with"];
        const OTHERWORDS = ["as", "at", "create", "draw", "fly", "grow", "last", "move", "orient", "replace", "shrink", "to", "trade", "via"];

        const CARD_UID_RE = /^((a|10|[2-9]|p|n|q|k)[crds]|\d{2})$/i;
        const CELL_RE = /^[a-z]{1,2}-?\d+$/i;
        const DIRECTION_RE = /^[NESWU]\??$/i;
        const PIECE_REF_RE = /^[a-z]{1,2}-?\d+(\.[1-3](\.[neswu])?(\.[1-6])?)?$/i;
        const MAJOR_ARCANA_RE = /^[0-1][0-9]|20|21$/i;
        const NUMBER_RE = /^[0-6]$/i; //Used for player Ids, card counts, bids, etc.
        const SUIT_RE = /^[CDRS]$/i;
        
        // Deprecated.
        const STEP_TOKEN_RE = /^[a-z0-9.-]+\??$/i;
        const MAX_STEP_TOKENS = 12;

        let trimmed = m.trim();
        const pm: IParsedMove = {
            announceLast: false,
            head: undefined,
            valid: true,
            steps: [],
            stepSegments: []
        };

        if ( trimmed.endsWith("last") ) {
            pm.announceLast = true;
            trimmed = trimmed.substring(0, trimmed.length - 4).trim();
        }

        if (trimmed.length === 0) {
            //Not sure we want this case to be valid
            return pm;
        }

        //was trimmed.split(/\s*[\n/]\s*/);
        const segments = trimmed.split("/").map(part => part.trim());

        if (segments.length === 0) {
            pm.valid = true;
            return pm;
        }

/* deprecated code to be removed */
        
        const segments2 = segments.slice();
        const rawStepSegments = segments2.slice(1).map(s => s.split(/\s+/));
        const stepSegments = rawStepSegments.map(raw => raw[0]?.toLowerCase() === "with" ? raw.slice(1) : raw);
        //let stepsWellFormed = true;
        for (let i = 0; i < rawStepSegments.length; i++) {
            const raw = rawStepSegments[i];
            if (raw.length === 0 || raw.length > MAX_STEP_TOKENS) {
                //stepsWellFormed = false;
                break;
            }
            if (raw[0]?.toLowerCase() === "draw" || raw[0]?.toLowerCase() === "discard"
                || (raw.length === 1 && raw[0]?.toLowerCase() === "decline")) {
                continue;
            }
            if (raw[0]?.toLowerCase() !== "with" && raw[0]?.toLowerCase() !== "orient") {
                //stepsWellFormed = false;
                break;
            }
            const tokens = stepSegments[i];
            // "orient" wasn't stripped, so the real minionRef sits one
            // slot later for it than for everything else here.
            const refIdx = tokens[0]?.toLowerCase() === "orient" ? 1 : 0;
            if (!tokens.every(t => STEP_TOKEN_RE.test(t))
                || !(PIECE_REF_RE.test(tokens[refIdx]) || CARD_UID_RE.test(tokens[refIdx]))) {
                //stepsWellFormed = false;
                break;
            }
        }

        pm.stepSegments = stepSegments;
        //console.log("old analysis: ", stepsWellFormed);

/* end deprecation */

        //Here we step through ALL segments.

        for (let s=0; s < segments.length; s++) {
            let segment = segments[s].split(/\s+/);
            const lastStep = (s === segments.length - 1); //Used for testing incomplete moves.

            if (s === 0) {
                //The head segment is treated somewhat differently.
                const rawHead = segment[0];
                let headTokens = segment.slice(1);
                pm.head = rawHead.toLowerCase();
                
                if (! HEADWORDS.includes(pm.head)) {
                    pm.error = "BAD_HEADWORD";
                }
        
                if (headTokens.length === 0) {
                    //The only head that can have no arguments *and* no following steps is a "pass".
                    if (! lastStep) {
                        //"Pass" can't be followed by more steps, so whatever the head is, it's invalid.
                        pm.error = "HEAD_STEP_NEEDS_CONTENT";
                        break;
                    }
                }
                
                //Via and as are peculiar to the first step and need separate treatment.
                
                if (headTokens.indexOf("via") > -1) {
                    const viaIdx = headTokens.indexOf("via");
                    if (pm.head !== "play" && pm.head !== "decline" && pm.head !== "discard") {
                        //Fool may only play/decline, and High Priestess may only discard.
                        pm.error = "BAD_VIA_HEADWORD";
                        break;
                    }
                    if (headTokens.length > viaIdx + 1) {
                        pm.viaUid = headTokens[viaIdx + 1];
                        //Test viaUid.
                        if (pm.viaUid !== "00" && pm.viaUid !== "02") {
                            pm.error = "BAD_VIA_CARD";
                            break;
                        }
                    } else {
                        //If there are other segments after a partial via, we fail this one.
                        if (!lastStep) {
                            pm.error = "VIA_INCOMPLETE";
                            break;
                        }
                    }
                    //Remove consumed segments.
                    headTokens =  [...headTokens.slice(0, viaIdx), ...headTokens.slice(viaIdx + 2)];
                }
                if (headTokens.indexOf("as") > -1) {
                    //A loop of at most two.  Structural conditions will fail any more as-es.
                    
                    //Only The Magician and The World (or both) may have as.
                    if (pm.head !== "play" && pm.head !== "use") {
                        //They must be played or used.
                        pm.error = "BAD_AS_HEADWORD";
                        break;
                    }
                    if (headTokens[0] !== "01" && headTokens[0] !== "21") {
                        pm.error = "AS_NEEDS_MAGICIAN_OR_WORLD";
                        break;
                    }
                    while (headTokens.indexOf("as") > -1) {
                        const asIdx = headTokens.indexOf("as");
     
                        if (headTokens.length > asIdx + 1) {
                            const tempAs = headTokens[asIdx + 1];
                            if (tempAs.length === 1 && pm.asSuit === undefined)
                                pm.asSuit = tempAs;
                            else if (tempAs.length === 2 && pm.asUid === undefined)
                                pm.asUid = tempAs;
                            else {
                                pm.error = "AS_NOT_SUIT_OR_CARD";
                                break;
                            }
                        } else {
                            //If there are other segments after a partial as, we fail this one.
                            if (! lastStep) {
                                return pm;
                            }
                        }
                        //We splice off this as to get the next one.
                        headTokens = [...headTokens.slice(0, asIdx), ...headTokens.slice(asIdx + 2)];
                    }
                    //Further testing of the values we got for as.
                    if ( pm.asUid !== undefined && ( (! MAJOR_ARCANA_RE.test(pm.asUid)) || pm.asUid === "21" ) ) {
                        //Bad card for the World.
                        pm.error = pm.asUid === "21" ? "WORLD_NOT_SELF" : "WORLD_NEEDS_MAJOR_ARCANA";
                        break;
                    }
                    if ( pm.asSuit !== undefined && (! SUIT_RE.test(pm.asSuit)) ) {
                        //Bad suit for the Magician.
                        pm.error = "MAGICIAN_BAD_SUIT";
                        break;
                    }
                }
                
                segment = headTokens.slice();

                // Reject if an inappropriate head has further steps (not use or play).
                if ( pm.head !== "use" && pm.head !== "play" && segments.length > 1 ) {
                    pm.error = "TOO_MANY_STEPS_FOR_HEADWORD";
                    break;
                }
                //End of special head treatment.
                
            } else {//s > 0
                //Need to validate the step headword.
                if (! STEPWORDS.includes(segment[0]) ) {
                    pm.error = "BAD_STEPWORD";
                    break;
                }
            }
            
            //In all cases, construct the step.
            const step:IStep = {
                action: (s === 0 ? pm.head! : segment.shift()!)
            }

            //All steps require more content (except "pass" which was handled already)
            //so if there is no more it's either a partial move or invalid.  
            if (segment.length === 0) {
                if (lastStep) {
                    //Partial move.
                    step.complete = -1;
                    pm.steps.push(step);
                    break;
                } else {
                    pm.error = "STEP_TOO_SHORT";
                    break;
                }
            }

            if (step.action === "with") {
                //Parse minion.
                step.withPiece = segment.shift()!;
                if (! PIECE_REF_RE.test(step.withPiece) ) {
                    pm.error = "WITH_BAD_PIECE_REF";
                    break;
                }
                step.withPiece = step.withPiece.toLowerCase();

                if (segment.length === 0) {
                    if (lastStep) {
                        //Partial move.
                        step.complete = -1;
                        pm.steps.push(step);
                     } else {
                        pm.error = "STEP_TOO_SHORT";
                     }
                    break;
                } else {
                    //"with" is not really the step action, so move on.
                    step.action = segment.shift()!;
                    //We're past the step headword, but maybe not at the real action, so test.
                    if (! OTHERWORDS.includes(step.action) ) {
                        pm.error = "BAD_OTHERWORD";
                        break;
                    }
                    if (segment.length === 0) {
                        if (lastStep) {
                            //Partial move.
                            step.complete = -1;
                            pm.steps.push(step);
                        } else {
                            pm.error = "MISSING_STEP_CONTENTS";
                        }
                        break;
                    }
                    //Otherwise, we pass the new action to the next check.
                }
            }
            if (step.action === "at") {
                //Parse cell
                step.atCell = segment.shift()!;
                if (! CELL_RE.test(step.atCell) ) {
                    pm.error = "BAD_AT_CELL";
                    break;
                }
                step.atCell = step.atCell.toLowerCase();

                if (segment.length === 0) {
                    if (lastStep) {
                        //Partial move.
                        step.complete = -1;
                        pm.steps.push(step);
                    } else {
                        pm.error = "STEP_TOO_SHORT";
                    }
                    break;
                } else {
                    //This one should be the real action.
                    step.action = segment.shift()!;
                    if (! OTHERWORDS.includes(step.action) ) {
                        pm.error = "BAD_OTHERWORD";
                        break;
                    }
                    if (segment.length === 0) {
                        if (lastStep) {
                            //Partial move.
                            step.complete = -1;
                            pm.steps.push(step);
                        } else {
                            pm.error = "MISSING_STEP_CONTENTS";
                        }            
                        break;
                    }
                }
            }
            
            //We have our real step.action now, plus at least one segment to pop.

            //Start with the multi-argument cases.
            if ( step.action === "draw" || step.action === "redraw" ) {
                //If draw comes before discard, it's a special Judgement draw of explicit cards.
                step.cardList = segment.slice()!;
                
                //There are limits on how many cards can be drawn with Judgement.
                if (segment.length > 6 || (step.action === "draw" && segment.length > 3) ) {
                    pm.error = "TOO_MANY_CARDS_DRAWN";
                    break;
                }             
                const allAreCards = segment.reduce((acc, curr) => acc && CARD_UID_RE.test(curr), true);
                if (!allAreCards) {
                    pm.error = "BAD_CARD_IDS";
                    break;
                } else {
                    step.complete = 0;
                    pm.steps.push(step);
                    continue;
                }
            }
            
            if ( step.action === "discard" ) {
                const drawIdx = segment.indexOf("draw");
                if ( drawIdx < 0 ) {
                    if (! lastStep) {
                        //Discard requires draw or it's incomplete.
                        pm.error = "DISCARD_NEEDS_DRAW";
                        break;
                    } else {
                        //Else partial move.
                        step.complete = -1;
                    }
                } else if ( segment.length > drawIdx + 1 ) { 
                    const tempamount = segment[drawIdx + 1];
                    if (! NUMBER_RE.test(tempamount) ) {
                        pm.error = "BAD_DRAW_COUNT";
                        break;
                    }
                    step.amount = parseInt(tempamount, 10);
                    //The segment cannot go on after this.
                    if (segment.length > drawIdx + 2) {
                        pm.error = "SURPLUS_STEP_CONTENT";
                        break;
                    } else
                        step.complete = 1;
                }
                
                if (drawIdx > -1) {
                    //Trim the segment.
                    segment.length = drawIdx;
                }

                step.cardList = segment.slice();
                
                //There are limits on how many cards can be discarded.
                if (step.cardList.length > 6) {
                    pm.error = "TOO_MANY_DISCARDS";
                    break;
                }
                const allAreCards = step.cardList.reduce((acc, curr) => acc && CARD_UID_RE.test(curr), true);
                if (!allAreCards) {
                    pm.error = "BAD_DISCARD_IDS";
                    break;
                } else {
                    pm.steps.push(step);
                    continue;
                }
            }

            //Now that we know it's not a whole list of cards, we can pop the segment.
            const tempwhat = segment.shift()!;

            //Start with some low-hanging fruit.
            if (step.action === "bid") {
                if (! NUMBER_RE.test(tempwhat) ) {
                    pm.error = "BAD_BID";
                    break;
                }
                step.amount = parseInt(tempwhat, 10);

                //Bid is terminal to the move.
                if (segment.length > 0) {
                    pm.error = "SURPLUS_STEP_CONTENT";
                    break;
                }
                step.complete = 1;
                pm.steps.push(step);
                break;
            }

            //Create was mostly handled in our pre-processing.
            if ( step.action === "create" ) {
                if ( CARD_UID_RE.test(tempwhat) )
                    step.card = tempwhat;
                else if ( DIRECTION_RE.test(tempwhat) )
                    step.direction = tempwhat.toUpperCase();
                else if ( PIECE_REF_RE.test(tempwhat) )
                    step.targetPiece = tempwhat.toLowerCase();
                else if ( tempwhat === "drawn" )
                    step.amount = 1;
                else {
                    pm.error = "BAD_CREATE_CONTENT";
                    break;
                }
                
                //Create is terminal to the step.
                if (segment.length > 0) {
                    pm.error = "SURPLUS_STEP_CONTENT";
                    break;
                } else {
                    step.complete = 1;
                    pm.steps.push(step);
                    continue;
                }
            }

            //Note that terminal orients don't become step actions, so this must be a full orient.
            if ( step.action === "place" || step.action === "orient" ) {
                if ( step.action === "place" ) {
                    if (! CELL_RE.test(tempwhat) ) {
                        pm.error = "BAD_PLACEMENT_CELL";
                        break;
                    }
                    step.targetCell = tempwhat.toLowerCase();
                } else { //step.action === "orient"
                    if (! PIECE_REF_RE.test(tempwhat) ) {
                        pm.error = "BAD_PIECE_REF_FOR_ORIENT";
                        break;
                    }
                    step.targetPiece = tempwhat.toLowerCase();
                    //The rules are not explicit about orient needing/being a minion,
                    //but for code consistency purposes we also populate the minion field.
                    if (step.withPiece === undefined)
                        step.withPiece = step.targetPiece;
                }

                if ( segment.length > 0 ) {
                    const tempdirection = segment.shift()!;
                    if (! DIRECTION_RE.test(tempdirection) ) {
                        pm.error = "BAD_DIRECTION";
                        break;
                    } else if ( step.action === "orient" && tempdirection.length > 1 ) {
                        //This is not a place where the ? is allowed.
                        pm.error = "AMBIGUOUS_DIRECTION";
                        break;
                    } else
                        step.direction = tempdirection.toUpperCase();
                } else {
                    // Sans direction it's a partial move.
                    if (!lastStep) {
                        pm.error = "STEP_NEEDS_CONTENT";
                        break;
                    }
                    step.complete = -1;
                    pm.steps.push(step);
                    break;
                }
                //Neither can go on after popping the direction.
                if ( segment.length > 0 ) {
                    pm.error = "SURPLUS_STEP_CONTENT";
                    break;
                }

                if ( step.action === "place" && step.direction.length > 1 ) 
                    step.complete = 0;
                else
                    step.complete = 1;

                pm.steps.push(step);

                if ( step.action === "place" ) {
                    //Place is terminal to the move.
                    break;
                } else {
                    continue;
                }
            }
            
            if ( step.action === "play" || step.action === "use" || step.action === "decline" ) {
                step.card = tempwhat;
                //Validate the card UID.
                if (! CARD_UID_RE.test(step.card) ) {
                    pm.error = "BAD_CARD_ID";
                    break;
                }
                //We've already handled vias and as-es, so more segments in this step is a failure.
                if (segment.length > 0) {
                    pm.error = "SURPLUS_STEP_CONTENT";
                    break;
                } else {
                    step.complete = 1;
                    pm.steps.push(step);
                    continue;
                }
            }
            
            if ( step.action === "trade" || step.action === "replace" ) {
                step.targetPiece = tempwhat;
                if (! PIECE_REF_RE.test(step.targetPiece) ) {
                    pm.error = "BAD_PIECE_REF";
                    break;
                }
                step.targetPiece = step.targetPiece.toLowerCase();

                if (segment.length > 0) {
                    const tempdirection = segment.shift()!;
                    if (! DIRECTION_RE.test(tempdirection) ) {
                        pm.error = "BAD_DIRECTION";
                        break;
                    } else if ( step.action === "trade" ) {
                        pm.error = "SURPLUS_STEP_CONTENT";
                        break;
                    } else
                        step.direction = tempdirection.toUpperCase();

                    //Must be at the end of the step now.
                    if (segment.length > 0) {
                        pm.error = "SURPLUS_STEP_CONTENT";
                        break;
                    } else {
                        step.complete = 1;
                        pm.steps.push(step);
                        continue;
                    }
                }
            }

            if ( step.action === "grow" || step.action === "move" || step.action === "shrink" || step.action === "fly" ) {
                //Test tempwhat.
                if ( CELL_RE.test(tempwhat) )
                    step.targetCell = tempwhat.toLowerCase();
                else if ( CARD_UID_RE.test(tempwhat) )
                    step.card = tempwhat;
                else if ( PIECE_REF_RE.test(tempwhat) )
                    step.targetPiece = tempwhat.toLowerCase();
                else {
                    pm.error = "BAD_STEP_CONTENT";
                    break;
                }

                if (segment.length === 0) {
                    //More is needed for these actions, except grow *can* end with a piece.
                    if ( step.action === "grow" && step.targetPiece !== undefined ) {
                        step.complete = 1;
                        pm.steps.push(step);
                        continue;
                    } else if (lastStep) {
                        //Partial move.
                        step.complete = -1;
                        pm.steps.push(step);
                        break;
                    } else  {
                        pm.error = "MISSING_STEP_CONTENT";
                        break;
                    }
                }
                
                //We have three choices for the next segment: "to", "orient", or an amount.
                let nextseg = segment.shift()!;

                if ( NUMBER_RE.test(nextseg) ) {
                    step.amount = parseInt(nextseg, 10);
                    if (segment.length > 0)
                        nextseg = segment.shift()!;
                    else {
                        //Can end with a number.
                        step.complete = 0;
                        pm.steps.push(step);
                        continue;
                    }
                }
                
                if (nextseg === "to") {
                    if (segment.length === 0) {
                        if (lastStep) {
                            step.complete = -1;
                            pm.valid = true;
                        } else {
                            pm.error = "MISSING_STEP_CONTENT";
                        }
                        pm.steps.push(step);
                        break;
                    } else {
                        const tempdest = segment.shift()!;
                        if ( CARD_UID_RE.test(tempdest) ) {
                            step.card = tempdest;
                        } else if ( CELL_RE.test(tempdest) ) {
                            step.targetCell = tempdest.toLowerCase();
                        } else {
                            pm.error = "BAD_TO_DESTINATION";
                            break;
                        }
                    }

                    if (segment.length > 0)
                        nextseg = segment.shift()!;
                    else {
                        //Can end with the replacement card.
                        step.complete = 0;
                        pm.steps.push(step);
                        continue;
                    }
                }

                if (nextseg === "orient") {
                    if (segment.length === 0) {
                        if (! lastStep) {
                            step.complete = -1;
                            pm.valid = true;
                        } else {
                            pm.error = "MISSING_STEP_CONTENT";
                        }
                        pm.steps.push(step);
                        break;
                    } else {
                        const tempdirection = segment.shift()!;
                        if (! DIRECTION_RE.test(tempdirection) ) {
                            pm.error = "BAD_DIRECTION";
                            break;
                        } else if ( tempdirection.length > 1 ) {
                            //This is not a place where the ? is allowed.
                            pm.error = "AMBIGUOUS_DIRECTION";
                            break;
                        } else
                            step.direction = tempdirection.toUpperCase();
                    }

                    //Orient is our last otherword.
                    if (segment.length > 0) {
                        pm.error = "SURPLUS_STEP_CONTENT";
                        break;
                    }
                }

                //I think we can assume completeness here.
                step.complete = 1;
            }

            pm.steps.push(step);  
        }

        if (pm.error !== undefined)
            pm.valid = false;

        //console.log(pm.steps);
            
        return pm;
    }

    public pickleMove(p: IParsedMove): string {
        if (p.head === undefined) {
            return p.announceLast ? "last" : "";
        }
        if (p.steps === undefined || p.steps.length === 0) {
            return p.head + ( p.announceLast ? " last" : "");
        }
        
        const pparts: string[] = [];
        for (let s = 0; s < p.steps.length; s++) {
            const ppart: string[] = [];
            const step = p.steps[s];
            if (step.withPiece !== undefined && (step.action !== "orient" || step.withPiece !== step.targetPiece) ) {
                ppart.push("with");
                ppart.push(step.withPiece);
            }
            if (step.atCell !== undefined) {
                ppart.push("at");
                ppart.push(step.atCell);
            }
            
            ppart.push(step.action);
            
            if ( step.action === "draw" || step.action === "redraw" || step.action === "discard" ) {
                if (step.cardList !== undefined)
                    ppart.push(...step.cardList);
         
                if ( step.action === "discard" && step.amount !== undefined ) {
                    ppart.push("draw");
                    ppart.push(step.amount.toString());
                }
            }
            if ( step.action === "bid" && step.amount !== undefined ) {
                ppart.push(step.amount.toString());
            }

            if ( step.action === "create" ) {
                if ( step.card !== undefined || step.direction !== undefined || step.targetPiece !== undefined)
                    ppart.push(((step.card ?? step.direction) ?? step.targetPiece) as string);
                else if ( step.amount === 1 )
                    ppart.push("drawn");
            }
                
            if ( step.action === "place" || step.action === "orient" || step.action === "replace" ) {

                if ( step.action === "place" && step.targetCell !== undefined ) {
                    ppart.push(step.targetCell);
                } else if ( (step.action === "orient" || step.action === "replace") && step.targetPiece !== undefined ) {
                    ppart.push(step.targetPiece);
                }

                if ( step.direction !== undefined ) {
                    ppart.push(step.direction);
                }
            }

            if ( step.action === "play" || step.action === "use" || step.action === "decline" ) {
                if ( step.card !== undefined ) {
                    ppart.push(step.card);
                }
            }

            if ( step.action === "trade" ) {
                if ( step.targetPiece !== undefined ) {
                    ppart.push(step.targetPiece);
                }
            }
                
            if ( step.action === "grow" || step.action === "shrink" || step.action === "move" ) {
                if ( step.targetCell !== undefined || step.targetPiece !== undefined ) {
                    ppart.push((step.targetCell ?? step.targetPiece)!);
                }
                if ( step.amount !== undefined ) {
                    ppart.push(step.amount.toString());
                }
                if ( step.card !== undefined ) {
                    ppart.push("to")
                    ppart.push(step.card);
                }

            }

            if ( step.action === "fly" ) {
                if ( step.card !== undefined || step.targetPiece !== undefined ) {
                    ppart.push((step.card ?? step.targetPiece)!);
                }
                if ( step.targetCell !== undefined ) {
                    ppart.push("to")
                    ppart.push(step.targetCell);
                }
            }

            if ( step.action === "grow" || step.action === "move" || step.action === "shrink" || step.action === "fly" ) {
                if ( step.direction !== undefined ) {
                    ppart.push("orient")
                    ppart.push(step.direction as string);
                }
            }


            //First round.
            if (s === 0) {
                if (p.asUid !== undefined) {
                    ppart.push("as");
                    ppart.push(p.asUid);
                }
                if (p.asSuit !== undefined) {
                    ppart.push("as");
                    ppart.push(p.asSuit);
                }
                if (p.viaUid !== undefined) {
                    ppart.push("via");
                    ppart.push(p.viaUid);
                }
            }

            
            //Last round.
            if (s ===  p.steps.length -1 && p.announceLast === true)
                ppart.push("last");

            
            pparts.push(ppart.join(" "));
        }

        return pparts.join("/");
    }

    // The innermost continued obligation's own uid ("00" or "02") - the one a resume submission addresses and demotes into "via <uid>".
    private getContinuedUid(): string | undefined {
        return this.continued[this.continued.length - 1]?.split(".")[0];
    }

    // The ordinary card a Fool continuation is waiting on: what the last flip revealed (discard pile's top), or the in-progress resume move's own card. undefined when nothing is pending.
    private activeCardUid(): string | undefined {
        const active = this.getContinuedUid();
        if (active !== "00") {
            return active;
        }
        if (this.liveMove?.viaUid === "00" && this.liveMove.steps[0]?.card !== undefined) {
            return this.liveMove.steps[0].card;
        }
        return this.discardPile[this.discardPile.length - 1];
    }

    // The one place that assembles a resumed move's own move STRING directly - every resume-seed call site shares this rather than hand-rolling the verb/parenthetical itself.
    public buildViaMove(stepSegments: string[][], asUid?: string, asSuit?: string): string {
        const activeUid = this.getContinuedUid()!;
        const declining = stepSegments.length === 1 && stepSegments[0].length === 1 && stepSegments[0][0].toLowerCase() === "decline";
        // "decline" is a bare head - it carries no step segments (unlike a mid-chain "/decline", it IS the whole submission).
        const steps = declining ? [] : stepSegments;
        // Assembled as plain words, matching what a player would type by hand; "via <uid>" sits in the HEAD (same slot as "as"), not trailing the string.
        if (activeUid === "02") {
            // High Priestess can never decline (validateHighPriestess only accepts "discard"; no Decline button is ever offered for it), so there's no decline shape to build here.
            const tokens = steps.length > 0 ? steps[0] : [];
            return ["discard", ...tokens, "via", activeUid].join(" ");
        }
        // "via 00" only ever names the Fool itself, so a Fool decline still has to name the REVEALED card separately ("decline AC via 00") - parseMove requires it to validate as complete.
        const head: IParsedMove = {
            announceLast: false, valid: true, stepSegments: [],
            head: declining ? "decline" : "play",
            asUid: declining ? undefined : asUid,
            asSuit: declining ? undefined : asSuit,
            viaUid: activeUid,
            steps: [{ action: declining ? "decline" : "play", card: this.activeCardUid() }],
        };
        return [this.pickleMove(head), ...steps.map(s => s.join(" "))].join("/");
    }

    // Builds the resume seed plus whatever step segments this.liveMove has typed against the same obligation, always starting fresh from this.continued.
    private continuedSeedMoveString(): string {
        const forThisObligation = this.liveMove !== undefined && this.liveMove.viaUid === this.getContinuedUid();
        const segments = forThisObligation ? this.resumeStepSegments(this.liveMove!) : [];
        return this.buildViaMove(segments, forThisObligation ? this.liveMove!.asUid : undefined, forThisObligation ? this.liveMove!.asSuit : undefined);
    }

    private invalid(key: string, params?: Record<string, unknown>): IValidationResult {
        return { valid: false, complete: -1, message: i18next.t(key, params) };
    }

    private failureResult(failure: PowerFailure): IValidationResult {
        return this.invalid(`apgames:validation.gnostica.${failure.key}`, failure.params);
    }

    // Maps a failed resolvePieceRef() result to its validation message; `notFoundKey` lets a minion-selector report NOT_AN_ELIGIBLE_MINION instead of NO_SUCH_PIECE.
    private invalidPieceRef(kind: "malformed" | "not_found" | "ambiguous", ref: string | undefined, notFoundKey = "NO_SUCH_PIECE"): IValidationResult {
        switch (kind) {
            case "malformed": return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_PIECE_REF" });
            // notFoundKey is sometimes overridden to a key with its own real text - only the shared default collapses into INVALID_MOVE.
            case "not_found": return notFoundKey === "NO_SUCH_PIECE"
                ? this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_SUCH_PIECE" })
                : this.invalid(`apgames:validation.gnostica.${notFoundKey}`, { ref });
            case "ambiguous": return this.invalid("apgames:validation.gnostica.AMBIGUOUS_PIECE_REF", { ref });
        }
    }

    // "<cell>.<pips>[.<orientation>][.<player>]"; resolved against `pool` (minion-selector) if given, else every piece at the cell (a target, any owner).
    private resolvePieceRef(ref: string | undefined, pool?: IMinionRef[]): PieceRefResolution {
        if (ref === undefined) {
            return { kind: "malformed" };
        }
        const segments = ref.toLowerCase().split(".");
        if (segments.length < 2 || segments.length > 4) {
            return { kind: "malformed" };
        }
        const [cellStr, pipsStr, ...rest] = segments;
        // PIECE_REF_RE (parseMove) already guarantees cellStr decodes cleanly - same cell grammar and case as CELL_RE.
        const [x, y] = GnosticaBoard.algebraic2coords(cellStr);
        const pips = parseInt(pipsStr, 10);
        if (Number.isNaN(pips) || pips < 1 || pips > 3) {
            return { kind: "malformed" };
        }
        let orientation: Orientation | undefined;
        let player: number | undefined;
        for (const tok of rest) {
            const upper = tok.toUpperCase();
            const asOrientation = (allOrientations as string[]).includes(upper) ? upper as Orientation : undefined;
            if (asOrientation !== undefined) {
                if (orientation !== undefined || player !== undefined) {
                    return { kind: "malformed" };
                }
                orientation = asOrientation;
                continue;
            }
            const asPlayer = parseInt(tok, 10);
            if (Number.isNaN(asPlayer) || player !== undefined) {
                return { kind: "malformed" };
            }
            player = asPlayer;
        }
        const candidateRefs = pool !== undefined
            ? pool.filter(p => p.x === x && p.y === y)
            : (this.board.get(x, y)?.pieces ?? []).map((_, index): IMinionRef => ({ x, y, index }));
        let matches = candidateRefs
            .map(r => ({ r, piece: r.piece ?? this.board.get(r.x, r.y)?.pieces[r.index] }))
            // A pool entry can go stale mid-chain (an earlier step relocated whatever used to be there) - treat that as never matched, not a crash.
            .filter((m): m is { r: IMinionRef; piece: Piece } => m.piece !== undefined)
            .filter(({ piece }) => piece.size === pips);
        if (orientation !== undefined) {
            matches = matches.filter(({ piece }) => piece.orientation === orientation);
        }
        if (player !== undefined) {
            matches = matches.filter(({ piece }) => piece.owner === player);
        }
        if (matches.length === 0) {
            return { kind: "not_found" };
        }
        if (matches.length > 1 && new Set(matches.map(({ piece }) => piece.id())).size > 1) {
            return { kind: "ambiguous" };
        }
        // #98/#100: never hand back `r`'s stored index verbatim - a splice elsewhere can leave it stale; re-derive the CURRENT index by attribute, not identity.
        const { r, piece } = matches[0];
        const live = this.board.get(r.x, r.y)?.pieces ?? [];
        const freshIndex = live.findIndex(p => p.size === piece.size && p.orientation === piece.orientation && p.owner === piece.owner);
        if (freshIndex === -1) {
            return { kind: "not_found" };
        }
        return { kind: "ok", ref: { x: r.x, y: r.y, index: freshIndex, piece: live[freshIndex] } };
    }

    // For the mutating apply* side, where the matching validate* has already confirmed `ref` resolves - trusts that, rather than re-deciding what to do on failure.
    private resolvePieceRefTrusted(ref: string | undefined, pool?: IMinionRef[]): IMinionRef {
        return (this.resolvePieceRef(ref, pool) as { kind: "ok"; ref: IMinionRef }).ref;
    }

    // Resolves a territory's own card uid to its current cell - Hermit's "tile" mode names it this way; a card is unique, so no "ambiguous" outcome to report.
    private resolveTileCard(cardUid: string | undefined): { x: number; y: number } | undefined {
        if (cardUid === undefined) {
            return undefined;
        }
        for (const [x, y, t] of this.board.entries()) {
            if (t.cardUid === cardUid) {
                return { x, y };
            }
        }
        return undefined;
    }

    // A bare cell token (no ".") - a "click the cell your minion is on" click landed here; only meaningful when 2+ of `pool`'s minions actually sit there, but stays defensive.
    // Unlike a parsed step's own targetCell/targetPiece, `tok` isn't guaranteed cell-shaped at all here (e.g. orientMinion's own literal "orient" subhead reaches this same slot), so this still needs a real try/catch.
    private isMinionCellStillNarrowing(tok: string, pool: IMinionRef[]): boolean {
        if (tok.includes(".")) {
            return false;
        }
        let coords: [number, number];
        try {
            coords = GnosticaBoard.algebraic2coords(tok.toLowerCase());
        } catch {
            return false;
        }
        const [cx, cy] = coords;
        return pool.filter(m => m.x === cx && m.y === cy).length > 1;
    }

    // True when every candidate is the SAME cell AND the same owner/size/facing (Piece.id()) - picking any one has the exact same effect.
    private allIndistinguishable(candidates: IMinionRef[]): boolean {
        if (candidates.length <= 1) {
            return true;
        }
        if (candidates.some(m => m.x !== candidates[0].x || m.y !== candidates[0].y)) {
            return false;
        }
        const ids = candidates.map(m => (m.piece ?? this.board.get(m.x, m.y)?.pieces[m.index])?.id());
        return ids.every(id => id !== undefined && id === ids[0]);
    }

    // Resolves a step's leading minionRef token against `pool`: a full ref resolves definitively, a bare cell token narrows `candidates` and sets ambiguous.
    private resolveStepMinion(
        tokens: string[] | undefined, pool: IMinionRef[],
    ): { minion: IMinionRef; ambiguous: boolean; candidates: IMinionRef[] } {
        if (pool.length <= 1) {
            return { minion: pool[0], ambiguous: false, candidates: pool };
        }
        const tok = tokens?.[0]?.toLowerCase();
        if (tok !== undefined) {
            const resolved = this.resolvePieceRef(tok, pool);
            if (resolved.kind === "ok") {
                return { minion: resolved.ref, ambiguous: false, candidates: pool };
            }
            if (this.isMinionCellStillNarrowing(tok, pool)) {
                const coords = GnosticaBoard.algebraic2coords(tok);
                const narrowed = pool.filter(m => m.x === coords[0] && m.y === coords[1]);
                // A cell with 2+ eligible minions that all happen to be identical isn't really ambiguous - pick one at random, as if there'd only been one.
                if (this.allIndistinguishable(narrowed)) {
                    return { minion: narrowed[Math.floor(Math.random() * narrowed.length)], ambiguous: false, candidates: narrowed };
                }
                return { minion: narrowed[0], ambiguous: true, candidates: narrowed };
            }
        }
        // Same tolerance as the narrowed branch above, for a pool that's already single-cell by construction (e.g. "use") without a narrowing click.
        if (this.allIndistinguishable(pool)) {
            return { minion: pool[Math.floor(Math.random() * pool.length)], ambiguous: false, candidates: pool };
        }
        return { minion: pool[0], ambiguous: true, candidates: pool };
    }

    // #49/follow-up: which message a not-yet-finished use/play step carries, shared by hand-typed and click-driven moves alike; High Priestess is a special case.
    private powerStepMessageKey(headArg: string, priorStepsCount: number, minions: IMinionRef[]): { key: string; params?: Record<string, unknown> } {
        if (headArg === "02") {
            return { key: priorStepsCount > 0
                ? "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2"
                : "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1" };
        }
        // Fool: no button, no choice - engaging it always produces a complete move (every flip fires automatically), so this just says what Submit will do.
        if (headArg === "00") {
            return { key: "apgames:validation.gnostica.FOOL_FLIP_READY" };
        }
        // World: the same "click-driven, no button" gap as tradeHands/orientAny/etc below, but its own target is unbounded, so naming the card alone leaves no clue.
        if (headArg === "21") {
            return { key: "apgames:validation.gnostica.WORLD_CHOOSE_TARGET" };
        }
        // Every other card: name it explicitly - a card reached via a push was never clicked by the player, so this is the only place that tells them which one.
        const cardName = this.cardNameOrUid(headArg);
        // Once the acting minion is resolved, orientMinion/orientAny/hierophantReplace/tradeHands/judgementDraw have no button of their own - name the next click instead.
        if (priorStepsCount === 0 && minions.length > 0) {
            const { minion, ambiguous } = this.resolveStepMinion(undefined, minions);
            if (!ambiguous) {
                const step = this.resolveFrameDef(headArg).powers[0];
                if ("special" in step) {
                    const cell = GnosticaBoard.coords2algebraic(minion.x, minion.y);
                    switch (step.special) {
                        case "orientMinion":
                            return { key: "apgames:validation.gnostica.CHOOSE_STEP_ORIENT_MINION", params: { card: cardName, cell } };
                        case "orientAny":
                        case "tradeHands":
                        case "hierophantReplace":
                            return { key: "apgames:validation.gnostica.CHOOSE_STEP_FACING", params: { card: cardName, cell } };
                        case "judgementDraw":
                            return { key: "apgames:validation.gnostica.CHOOSE_STEP_DISCARD", params: { card: cardName } };
                    }
                }
            }
        }
        return {
            key: priorStepsCount > 0
                ? "apgames:validation.gnostica.POWER_STILL_OPTIONAL"
                : "apgames:validation.gnostica.CHOOSE_STEP",
            params: { card: cardName },
        };
    }

    // "Incomplete" per primitiveStepShape needs different wording depending on whether the target is chosen yet; undefined means "use the generic wording".
    private primitiveIncompleteMessage(suitUid: string, step: IStep): { key: string; params?: Record<string, unknown> } | undefined {
        const mode = stepMinorMode(suitUid, step);
        if (mode === undefined) {
            // Rods' "tile" mode has no target token to hang a message off - falls back to the generic wording, same as any other still-choosing-a-mode state.
            return undefined;
        }
        if (mode === "piece" && (suitUid === "R" || suitUid === "S") && step.amount === undefined) {
            return { key: suitUid === "R" ? "apgames:validation.gnostica.PICK_DESTINATION_TO_SET_DISTANCE" : "apgames:validation.gnostica.PICK_PIPS_BUTTON" };
        }
        return undefined;
    }

    // A fresh frame's own message: PICK_MINION_CELL when the eligible pool spans more than one cell, otherwise powerStepMessageKey's own step-0 wording.
    private freshStepMessage(cardUid: string, priorStepsCount: number, minions: IMinionRef[]): { key: string; params?: Record<string, unknown> } {
        if (priorStepsCount === 0 && new Set(minions.map(m => `${m.x},${m.y}`)).size > 1) {
            return { key: "apgames:validation.gnostica.PICK_MINION_CELL" };
        }
        return this.powerStepMessageKey(cardUid, priorStepsCount, minions);
    }

    // "Ready to submit" message for a step whose outcome forces a pause (Fool's flip, High Priestess's round), once already complete - distinct from "what's next".
    private forcePauseReadyMessage(cardUid: string, nextStepIndex: number): { key: string; params?: Record<string, unknown> } {
        if (cardUid === "02") {
            return { key: nextStepIndex > 0
                ? "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2_READY"
                : "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1_READY" };
        } //else (cardUid === "00") {
        return { key: "apgames:validation.gnostica.FOOL_FLIP_READY" };
    }

    // The six top-level turn choices, as buttons - a bare click on an already-occupied cell/piece is ambiguous between "orient" and "use", with no way to disambiguate.
    private isPendingFirstPlacement(): boolean {
        if (this.liveMove === undefined) {
            return false;
        }
        // validateMove unconditionally rejects "place" once the acting player has ANY board presence, so a live "place" preview can only be their first piece.
        return this.liveMove.head?.toLowerCase() === "place";
    }

    // Which button(s) to bold, based on this.liveMove; "Declare" is a modifier so it can be highlighted alongside whatever the base action is, not instead of it.
    private highlightedButtonValues(): Set<string> {
        const found = new Set<string>();
        if (this.liveMove === undefined) {
            return found;
        }
        if (this.liveMove.announceLast) {
            found.add("declare");
        }
        const head = this.liveMove.head;
        const step0 = this.liveMove.steps[0];
        // A discard move is Pass-equivalent only when it discards nothing AND explicitly draws zero
        if (head === "discard" && ((step0.cardList === undefined || step0.cardList.length === 0) && step0.amount === 0)) {
            // "discard draw 0" is the user-facing pass, so bold Pass.
            found.add("pass");
        } else if (this.continued.length > 0) {
            // The top-level button matches the resume: "Discard/Draw" for High Priestess, "Play Card" for Fool.
            found.add(this.continued[this.continued.length - 1].split(".")[0] === "02" ? "discard" : "play");
        } else if (head !== undefined && ["place", "use", "play", "orient", "discard"].includes(head)) {
            found.add(head);
        }
        return found;
    }

    // Wraps computeActionButtons() to unconditionally fold a persisting "Decline X" into the bar, since a pending obligation's card can always be declined.
    private getActionButtons(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        const bar = this.computeActionButtons();
        if (bar === undefined || this.continued.length === 0) {
            return bar;
        }
        // this.continued always names a genuine obligation, so there's nothing further to distinguish here.
        if (bar.some(b => b.value === "decline_power")) {
            // Fool's own step has nothing else to offer, so computeActionButtons() already returns its explicit Use/Decline pair - nothing to add here.
            return bar;
        }
        // The state as ADVANCED by whatever's been clicked so far this render; `.special === "fool"` means clicks already ran a revealed card's steps.
        const advanced = this.parsePendingStep(this.continuedSeedMoveString());
        const justDeclined = this.liveMove?.head === "decline";
        if (advanced?.special === "fool" && !justDeclined) {
            // Fool's flip is never optional - nothing to decline once a revealed card's own steps have simply run their course.
            return bar;
        }
        // Once High Priestess round 1 is DONE and round 2 is persisted, it's never Declinable - checked via getContinuedUid, not activeCardUid below.
        if (this.getContinuedUid() === "02") {
            return bar;
        }
        const activeTop = { cardUid: advanced?.activeCardUid ?? this.activeCardUid() };
        // Fool's remaining flip auto-continues past ANY decline that exposes it, so what needs naming here is whatever was ACTUALLY just declined, not Fool itself.
        const declinedUid = (justDeclined && activeTop.cardUid === "00")
            ? (this.discardPile[this.discardPile.length - 1] ?? activeTop.cardUid)
            : activeTop.cardUid;
        const declineBtn: ButtonBarButton = { label: `Decline ${declinedUid}`, value: "decline_power" };
        if (justDeclined) {
            // Bold marks a button matching what this.liveMove ALREADY says - once clicked, it stays confirmed rather than reverting to an open choice.
            declineBtn.attributes = [{ name: "font-weight", value: "bold" }];
        }
        return [...bar, declineBtn] as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Pick one value from a small labeled set; `disabledReason` reuses the SAME object minorModeAvailability produces, so strikethrough and rejection message can't drift.
    private buildChoiceButtons(prefix: string, options: ChoiceOption[], current: string | undefined): ButtonBarButton[] {
        return options.map(({ value, label, disabledReason }) => {
            const button: ButtonBarButton = { label, value: `${prefix}_${value}` };
            const attrs: { name: string; value: string }[] = [];
            if (value === current) {
                attrs.push({ name: "font-weight", value: "bold" });
            }
            if (disabledReason !== undefined) {
                attrs.push({ name: "text-decoration", value: "line-through" });
                button.fill = MUTED_FILL;
            }
            if (attrs.length > 0) {
                button.attributes = attrs as [{ name: string; value: string }, ...{ name: string; value: string }[]];
            }
            return button;
        });
    }

    // Rod can never act while upright, so doom an upright candidate.
    private rodNeedsFacingReason(suitUid: string | undefined, piece: Piece): { key: string } | undefined {
        return suitUid === "R" && piece.orientation === "U" ? { key: "ROD_NEEDS_FACING" } : undefined;
    }

    // The self-contained Use/Decline pair offered whenever a paused power has no button set of its own; reads the active card off the resume stack's top frame.
    private pausedPowerButtons(): [ButtonBarButton, ButtonBarButton] {
        const resumeQueue = this.resumeQueue()!;
        const activeUid = resumeQueue[resumeQueue.length - 1].cardUid;
        return [
            { label: `Use Card ${activeUid}`, value: "resume_power" },
            { label: `Decline ${activeUid}`, value: "decline_power" },
        ];
    }

    // Shared by all end-of-turn discard/draw count-pickers. 
    private drawCountOptions(maxDraw: number): ChoiceOption[] {
        const options: ChoiceOption[] = [];
        for (let n = maxDraw; n >= 0; n--) {
            options.push({ value: String(n), label: `Draw ${n}` });
        }
        return options;
    }

    // #87/#88: each state below is its own named primitive, tried in this fixed order since two are genuinely order-dependent; undefined always means "keep going".
    private computeActionButtons(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (this.gameover) {
            return undefined;
        }
        // The "bidding" variant's opening procedure - a single bold button per phase, offered for consistency (a direct hand/pool click already builds the move).
        if (this.phase === "bidding") {
            return [{ label: "Bid", value: "bid", attributes: [{ name: "font-weight", value: "bold" }] }];
        }
        if (this.phase === "redraw") {
            return [{ label: "Redraw", value: "redraw", attributes: [{ name: "font-weight", value: "bold" }] }];
        }
        if (this.isPlaceOnlyState()) {
            // Only one action is legal here regardless of which case this is - a single bold button, mirroring Magnate's own single-button "Choose" state.
            return [{ label: "Place", value: "place", attributes: [{ name: "font-weight", value: "bold" }] }];
        }
        const topLevel = this.buildTopLevelBar();
        const discardCount = this.discardCountBar();
        if (discardCount !== undefined) {
            return discardCount;
        }
        const orientPicker = this.orientAmbiguityBar();
        if (orientPicker !== undefined) {
            return orientPicker;
        }

        const pendingMinor = this.computePendingMinor();
        if (pendingMinor === undefined) {
            return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
        }

        // Once a power step's modes are on offer, only the one choice that got us here stays, plus a spacer and this step's own mode buttons; Declare stays available.
        const selected = topLevel.find(b => b.value === pendingMinor.head);
        // #67: name the active card's uid once known - reusing the same activeCardUid #74's own move-string annotation is built from.
        if (selected !== undefined) {
            selected.label = `${selected.label} (${pendingMinor.activeCardUid})`;
        }
        const declareBtn = topLevel.find(b => b.value === "declare");

        // pendingMinor.special === "fool" means Fool flipped and revealed ANOTHER Fool; only the ROOT card's untouched first flip is mandatory, so this nested one is declinable.
        if (pendingMinor.special === "fool") {
            if (this.liveMove === undefined) {
                return this.pausedPowerButtons();
            }
            return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
        }

        const minionPicker = this.minionPickerBar(pendingMinor, selected, declareBtn);
        if (minionPicker !== undefined) {
            return minionPicker;
        }
        // Still ambiguous but spanning more than one cell ("play"'s board-wide pool) - leave the bar uncollapsed for a fresh activation, but a paused resume gets Use/Decline.
        if (pendingMinor.minionAmbiguous) {
            if (this.continued.length > 0) {
                return this.pausedPowerButtons();
            }
            return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
        }

        const hpCount = this.highPriestessCountBar(pendingMinor);
        if (hpCount !== undefined) {
            return hpCount;
        }
        const specialTargetPicker = this.specialTargetPickerBar(pendingMinor, selected, declareBtn);
        if (specialTargetPicker !== undefined) {
            return specialTargetPicker;
        }
        // orientMinion/judgementDraw/worldUseAny are pure click-driven; tradeHands/orientAny/hierophantReplace fall back to click-driven only when unambiguous (see specialTargetPickerBar above).
        if (pendingMinor.special !== undefined && pendingMinor.special !== "hermitTeleport" && pendingMinor.special !== "magicianChoice") {
            // While still building a FRESH root activation, the ordinary top-level bar is still right (matches every other "still typing" preview).
            if (this.continued.length === 0) {
                return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
            }
            // Once genuinely paused, NONE of the ordinary 6 buttons are legal - offer the same self-contained Use/Decline pair the Fool-special branch above does.
            return this.pausedPowerButtons();
        }

        return this.stepModeBar(pendingMinor, selected, declareBtn);
    }

    // A live "use"/"play" preview or genuine pendingPower obligation can never collapse to "Place" - a transient zero-piece moment shouldn't misread as a fresh start.
    private isPlaceOnlyState(): boolean {
        const midPowerStep = this.liveMove?.head === "use" || this.liveMove?.head === "play" || this.continued.length > 0;
        return (!midPowerStep && !this.hasPiecesOnBoard(this.currplayer)) || this.isPendingFirstPlacement();
    }

    // The ordinary 6-button top-level choice, bolded per highlightedButtonValues - the fallback bar, and the seed every pendingMinor state further trims.
    private buildTopLevelBar(): ButtonBarButton[] {
        const topLevel: ButtonBarButton[] = [
            { label: "Use Territory", value: "use" },
            { label: "Play Card", value: "play" },
            { label: "Orient", value: "orient" },
            { label: "Discard/Draw", value: "discard" },
            { label: "Pass", value: "pass" },
        ];
        if (this.lastTurner === undefined) {
            topLevel.push({ label: "(Declare)", value: "declare" });
        }
        const highlighted = this.highlightedButtonValues();
        for (const b of topLevel) {
            if (b.value !== undefined && highlighted.has(b.value)) {
                b.attributes = [{ name: "font-weight", value: "bold" }];
            }
        }
        return topLevel;
    }

    // Shared by the ordinary top-level "discard" action and High Priestess's own nested draw step - same picker, different click-value prefix routes it to its own destination in the move string.
    private drawCountBar(prefix: string): [ButtonBarButton, ...ButtonBarButton[]] {
        const hand = this.hands[this.currplayer - 1] ?? [];
        const maxDraw = Math.max(0, 6 - hand.length);
        return this.buildChoiceButtons(prefix, this.drawCountOptions(maxDraw), undefined) as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Discard's own count is optional, but the bar still actively solicits it once "discard" is the live head and no count has been chosen yet.
    private discardCountBar(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (this.liveMove === undefined || this.liveMove.head?.toLowerCase() !== "discard" || this.liveMove.steps[0]?.amount !== undefined) {
            return undefined;
        }
        return this.drawCountBar("drawcount");
    }

    // Orient: a bare cell means 2+ of the player's own pieces share it and none has been picked yet - same shape "use"/"play" get via minionPickerBar.
    private orientAmbiguityBar(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        const step = this.liveMove?.steps[0];
        if (this.liveMove === undefined || this.liveMove.head?.toLowerCase() !== "orient"
            || step?.targetPiece === undefined || step.direction !== undefined || step.targetPiece.includes(".")) {
            return undefined;
        }
        const coords = GnosticaBoard.algebraic2coords(step.targetPiece);
        const { ambiguous, candidates } = this.resolveStepMinion(undefined, this.eligibleMinionsForOrient(coords[0], coords[1]));
        if (!ambiguous) {
            return undefined;
        }
        const seenRefs = new Set<string>();
        const options: ChoiceOption[] = [];
        for (const m of candidates) {
            const ref = this.pieceRefStr(m, candidates);
            if (seenRefs.has(ref)) {
                continue;
            }
            seenRefs.add(ref);
            options.push({ value: ref, label: this.textFormat(this.board.get(m.x, m.y)!.pieces[m.index]) });
        }
        return [
            { label: "Choose Minion", value: "_spacer", attributes: [{ name: "font-style", value: "italic" }] },
            ...this.buildChoiceButtons("orientpick", options, undefined),
        ] as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // For a genuine resume, continuedSeedMoveString() rebuilds a move string from this.continued plus liveMove's typed segments; no "already reflected" bookkeeping needed.
    private computePendingMinor(): IPendingStep | undefined {
        return this.continued.length > 0
            ? this.parsePendingStep(this.continuedSeedMoveString())
            : this.liveMove === undefined
                ? undefined
                : this.parsePendingStep(this.pickleMove(this.liveMove));
    }

    // Every remaining candidate minion for THIS step already sits on the same cell AND there's more than one, so a real choice is still needed - one button each.
    private minionPickerBar(
        pendingMinor: IPendingStep, selected: ButtonBarButton | undefined, declareBtn: ButtonBarButton | undefined,
    ): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        const candidateCells = new Set(pendingMinor.minionCandidates.map(m => `${m.x},${m.y}`));
        if (!pendingMinor.minionAmbiguous || candidateCells.size !== 1) {
            return undefined;
        }
        const buttons: ButtonBarButton[] = selected !== undefined ? [selected] : [];
        buttons.push({ label: "Choose Minion", value: "_spacer", attributes: [{ name: "font-style", value: "italic" }] });
        const seenRefs = new Set<string>();
        const options: ChoiceOption[] = [];
        for (const m of pendingMinor.minionCandidates) {
            const ref = this.pieceRefStr(m, pendingMinor.minions);
            // Two genuinely identical pieces share the same shortest ref - resolvePieceRef already treats that as "first match, not an error", so a second button would be an inert duplicate.
            if (seenRefs.has(ref)) {
                continue;
            }
            seenRefs.add(ref);
            const piece = this.board.get(m.x, m.y)!.pieces[m.index];
            options.push({ value: ref, label: this.textFormat(piece), disabledReason: this.rodNeedsFacingReason(pendingMinor.suitUid, piece) });
        }
        buttons.push(...this.buildChoiceButtons("minion", options, undefined));
        if (declareBtn !== undefined) {
            buttons.push(declareBtn);
        }
        return buttons as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Button-based target picking for orientAny/tradeHands/hierophantReplace, offered only when 2+ candidates make a click genuinely ambiguous - a single candidate keeps working via click, unchanged.
    private specialTargetPickerBar(
        pendingMinor: IPendingStep, selected: ButtonBarButton | undefined, declareBtn: ButtonBarButton | undefined,
    ): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (pendingMinor.special !== "orientAny" && pendingMinor.special !== "tradeHands" && pendingMinor.special !== "hierophantReplace") {
            return undefined;
        }
        if (pendingMinor.istep.targetPiece !== undefined) {
            return undefined;
        }
        const options = this.specialTargetCandidates(pendingMinor);
        // Ambiguity is judged on the FACING CELL alone - self is always its own separate, already-unambiguous click target (see pickPieceTargetClick).
        const facingCandidateCount = pendingMinor.special === "orientAny" ? options.length - 1 : options.length;
        if (facingCandidateCount <= 1) {
            return undefined;
        }
        const buttons: ButtonBarButton[] = selected !== undefined ? [selected] : [];
        buttons.push({ label: "Special Power", value: "_spacer", attributes: [{ name: "font-style", value: "italic" }] });
        buttons.push(...this.buildChoiceButtons("target", options, undefined));
        if (declareBtn !== undefined) {
            buttons.push(declareBtn);
        }
        return buttons as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // High Priestess: the discard list is built via hand-card clicks, but the draw count is the player's own choice, same shape as the ordinary discard/draw count-picker.
    private highPriestessCountBar(pendingMinor: IPendingStep): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (pendingMinor.special !== "highPriestess" || pendingMinor.istep.amount !== undefined) {
            return undefined;
        }
        return this.drawCountBar("hpdraw");
    }

    // Self (unless excluded), plus every distinguishable piece at the facing cell (deduplicated by pieceRefStr) - shared by every target-candidate button list.
    private pieceCandidateOptions(
        pending: IPendingStep, labelFor: (piece: Piece) => string,
        opts: { disabledReason?: { key: string; params?: Record<string, unknown> }; includeSelf?: boolean; filter?: (piece: Piece) => boolean } = {},
    ): ChoiceOption[] {
        const { disabledReason, includeSelf = true, filter } = opts;
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const cellPieces = this.board.get(tx, ty)?.pieces ?? [];
        const options: ChoiceOption[] = [];
        const seen = new Set<string>();
        const pushPieceCandidate = (x: number, y: number, index: number): void => {
            const ref = this.pieceRefStr({ x, y, index });
            if (seen.has(ref)) {
                return;
            }
            seen.add(ref);
            options.push({ value: ref, label: labelFor(this.board.get(x, y)!.pieces[index]), disabledReason });
        };
        // Self is always a candidate unless explicitly excluded (tradeHands/hierophantReplace, which require an enemy) - uniquified against the facing cell's own pieces below.
        if (includeSelf) {
            pushPieceCandidate(pending.minion.x, pending.minion.y, pending.minion.index);
        }
        cellPieces.forEach((p, index) => {
            if (filter === undefined || filter(p)) {
                pushPieceCandidate(tx, ty, index);
            }
        });
        return options;
    }

    // One candidate per real target for orientAny/tradeHands/hierophantReplace - tradeHands/hierophantReplace exclude self and require an enemy, matching pickPieceTargetClick's own rule.
    private specialTargetCandidates(pending: IPendingStep): ChoiceOption[] {
        if (pending.special === "orientAny") {
            return this.pieceCandidateOptions(pending, p => `Orient ${this.textFormat(p)}`);
        }
        const verb = pending.special === "tradeHands" ? "Trade with" : "Replace";
        return this.pieceCandidateOptions(pending, p => `${verb} ${this.textFormat(p)}`, { includeSelf: false, filter: p => p.owner !== this.currplayer });
    }

    // One candidate per real target for a fresh suit-power step - the tile at minorTargetCell plus every piece there, or Cups' "own"/every enemy piece/"new"; one click supplies mode + target.
    private suitTargetCandidates(pending: IPendingStep, suitUid: string): ChoiceOption[] {
        const availability = this.minorModeAvailability(pending);
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        if (suitUid === "C") {
            const cellPieces = this.board.get(tx, ty)?.pieces ?? [];
            const options: ChoiceOption[] = [{ value: "own", label: MINOR_MODES.C.own.label, disabledReason: availability.get("own") }];
            cellPieces.forEach((p, index) => {
                if (p.owner !== this.currplayer) {
                    options.push({ value: this.pieceRefStr({ x: tx, y: ty, index }), label: `Capture ${this.textFormat(p)}`, disabledReason: availability.get("enemy") });
                }
            });
            options.push({ value: "new", label: MINOR_MODES.C.new.label, disabledReason: availability.get("new") });
            return options;
        }
        const verb = MINOR_MODES[suitUid].piece.label.replace(" Piece", "");
        return [
            { value: targetCell, label: MINOR_MODES[suitUid].tile.label, disabledReason: availability.get("tile") },
            ...this.pieceCandidateOptions(pending, p => `${verb} ${this.textFormat(p)}`, { disabledReason: availability.get("piece") }),
        ];
    }

    // Hermit's own twin of suitTargetCandidates - same tile-plus-self-plus-every-co-located-piece enumeration, via HERMIT_MODES' own labels.
    private hermitTargetCandidates(pending: IPendingStep): ChoiceOption[] {
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        return [
            { value: targetCell, label: HERMIT_MODES.tile.label },
            ...this.pieceCandidateOptions(pending, p => `Teleport ${this.textFormat(p)}`),
        ];
    }

    // The final fallback once every click-only/no-button state above is ruled out: a primitive suit-power step, or hermitTeleport/magicianChoice's own button sets.
    private stepModeBar(
        pendingMinor: IPendingStep, selected: ButtonBarButton | undefined, declareBtn: ButtonBarButton | undefined,
    ): [ButtonBarButton, ...ButtonBarButton[]] {
        const buttons: ButtonBarButton[] = selected !== undefined ? [selected] : [];

        const spacerLabel = pendingMinor.suitUid ? ALL_SUITS.filter(obj => obj.uid === pendingMinor.suitUid)[0].label : "Special Power";
        buttons.push({ label: spacerLabel, value: "_spacer",  attributes: [{ name: "font-style", value: "italic" }] });

        if (pendingMinor.special === "hermitTeleport") {
            if (stepHermitMode(pendingMinor.istep) === undefined) {
                buttons.push(...this.buildChoiceButtons("target", this.hermitTargetCandidates(pendingMinor), undefined));
            }
        } else if (pendingMinor.special === "magicianChoice") {
            const options = ALL_SUITS.map(suit => ({ value: suit.uid, label: suit.label }));
            buttons.push(...this.buildChoiceButtons("magician", options, undefined));
        } else {
            const suitUid = pendingMinor.suitUid!;
            if (stepMinorMode(suitUid, pendingMinor.istep) === undefined) {
                buttons.push(...this.buildChoiceButtons("target", this.suitTargetCandidates(pendingMinor, suitUid), undefined));
            }
            // "new" mode's required card arg is otherwise only suppliable by clicking a hand card; Wheel of Fortune (allowRandomDraw) has none, so it gets a button.
            if (suitUid === "C" && stepMinorMode("C", pendingMinor.istep) === "new" && pendingMinor.opts.allowRandomDraw === true) {
                buttons.push({ label: "Draw a card", value: "drawn" });
            }
            // Swords pips is pure damage, no destination cell to click (unlike Rods' distance), so it's a button set once a target is chosen.
            if (suitUid === "S" && stepMinorMode("S", pendingMinor.istep) === "piece") {
                const minionPiece = pendingMinor.minion.piece ?? this.board.get(pendingMinor.minion.x, pendingMinor.minion.y)!.pieces[pendingMinor.minion.index];
                const pipsOptions: ChoiceOption[] = [];
                for (let n = minionPiece.size; n >= 1; n--) {
                    pipsOptions.push({ value: String(n), label: `Attack for ${n}` });
                }
                buttons.push(...this.buildChoiceButtons("pips", pipsOptions, pendingMinor.istep.amount?.toString()));
            }
        }
        if (declareBtn !== undefined) {
            buttons.push(declareBtn);
        }
        return buttons as [ButtonBarButton, ...ButtonBarButton[]];
    }

    public primitiveToSuit(primitive: SuitPrimitive): string {
        return primitive === "create" ? "C" : primitive === "move" ? "R" : primitive === "grow" ? "D" : "S";
    }

    // The current step's own minor-arcana mode (own/enemy/new/piece/tile), derived from `istep` rather than the raw `mode` field - undefined for a plain special step (no suitUid) or a not-yet-shaped primitive/magicianChoice step. Completeness-gate equivalent of `pending.mode`.
    private pendingMode(pending: IPendingStep): string | undefined {
        return pending.suitUid === undefined ? undefined : stepMinorMode(pending.suitUid, pending.istep);
    }

    // Whether NOTHING has been typed yet for `pending`'s own special step, beyond the bare minion ref (if any) - completeness-gate equivalent of `pending.rest.length === 0` for any special kind.
    private pendingSpecialUntouched(pending: IPendingStep): boolean {
        switch (pending.special) {
            case "orientMinion": return pending.istep.direction === undefined;
            case "tradeHands":
            case "orientAny":
            case "hierophantReplace": return pending.istep.targetPiece === undefined;
            case "hermitTeleport": return stepHermitMode(pending.istep) === undefined;
            case "judgementDraw": return (pending.istep.cardList?.length ?? 0) === 0;
            case "highPriestess": return (pending.istep.cardList?.length ?? 0) === 0 && pending.istep.amount === undefined;
            default: return true; // fool/worldUseAny/magicianChoice take no typed content of their own here
        }
    }

    // Reconstructs the in-progress power step (if any) purely from a move string.  Checks step segments for STRUCTURAL completeness,  also stopping at Fool or World.
    private parsePendingStep(moveStr: string, callOpts: { preferCurrent?: boolean } = {}): IPendingStep | undefined {
        const parsed = this.parseMove(moveStr);
        // A "via <uid>" marker dispatches from the Fool/HP anchor for a genuine resume; otherwise the front card token. "as <x>" never moves the head arg.
        let headArg = parsed.viaUid ?? parsed.steps[0]?.card;
        if (headArg === undefined) {
            return undefined;
        }
        // asUid (World's borrow) and asSuit (Magician's suit) are separate fields throughout; a World-pushed Magician frame can have both set at once.
        const { asUid, asSuit } = parsed;
        const worldBorrow = asUid !== undefined;
        // "decline" is already a complete choice - no step for a button set to configure, so the bar falls back to plain top-level context.
        if (parsed.head === "decline") {
            return undefined;
        }
        // A genuine resume is detected from the "via <root>" anchor matching this.continued; for button-building it always plays the active card, so `head` is "play".
        const isGenuineResume = this.continued.length > 0 && parsed.viaUid === this.getContinuedUid();
        // High Priestess resumes with its own tokens right after "discard", not a "/"-segment - fold them back so the walk below sees them.
        const stepSegments = isGenuineResume ? this.resumeStepSegments(parsed) : parsed.stepSegments;
        if (isGenuineResume) {
            // A "discard" resume is a High Priestess round (not a card); a "play" resume names the revealed card as its front token.
            headArg = parsed.head === "discard" ? parsed.viaUid! : (parsed.steps[0]?.card ?? parsed.viaUid!);
        }
        if (!isGenuineResume && parsed.head !== "use" && parsed.head !== "play") {
            return undefined;
        }
        const head: "use" | "play" = isGenuineResume ? "play" : parsed.head as "use" | "play";
        let card: Card | undefined;
        let eligible: IMinionRef[];
        // A card revealed by Fool (headArg names it directly for a resume) is always play-pool eligible regardless.
        if (isGenuineResume) {
            card = allCards().find(c => c.uid === headArg);
            eligible = this.eligibleMinionsForPlay();
        } else if (head === "use") {
            const loc = this.findCardCell(headArg);
            if (loc === undefined) {
                return undefined;
            }
            const { x, y } = loc;
            card = this.board.get(x, y)?.card;
            eligible = this.eligibleMinionsForActivate(x, y);
        } else {
            card = allCards().find(c => c.uid === headArg);
            eligible = this.eligibleMinionsForPlay();
        }
        if (card === undefined || eligible.length === 0) {
            return undefined;
        }
        if (!card.major) {
            const suitUid = card.suit.uid;
            const segment = stepSegments[0] ?? []; // segment[0] is the minionRef, if typed yet - see resolveStepMinion
            // Cups alone infers its mode from shape rather than a literal token; it already falls back to the plain positional read for every other suit.
            const derived = deriveMinorMode(suitUid, segment.slice(1));
            const { minion, ambiguous, candidates } = this.resolveStepMinion(segment, eligible);
            const istep: IStep = derived === undefined
                ? { action: "with", withPiece: segment[0] }
                : suitUid === "C" ? this.buildCupsStep(segment[0], derived.mode, derived.args)
                    : this.buildRdsStep(suitUid, derived.mode, segment[0], derived.args);
            return { head, headArg, activeCardUid: headArg, suitUid, eligible, minions: eligible, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps: [], opts: {}, mode: derived?.mode, rest: derived?.args ?? segment.slice(1), istep };
        }

        const def = getMajorArcanaDef(card);
        // A resolution stack local to this UI-only walk - `eligible` (frozen at push time) stays tracked separately from `minions` (which keeps accreting).
        const stack: { cardUid: string; nextStepIndex: number; eligible: IMinionRef[]; minions: IMinionRef[] }[] =
            isGenuineResume
                ? this.resumeQueue()!.map(f => ({ cardUid: f.cardUid, nextStepIndex: f.nextStepIndex, eligible: [...f.minions], minions: [...f.minions] }))
                : [{ cardUid: def.uid, nextStepIndex: 0, eligible: [...eligible], minions: [...eligible] }];

        // The World's sole step (worldUseAny) takes no segment - the borrowed card is "as <uid>" in the head. Splice its frame on now (mirrors walkFrameStack).
        if (worldBorrow) {
            const wt = stack[stack.length - 1];
            const wStep = this.resolveFrameDef(wt.cardUid).powers[wt.nextStepIndex];
            if (wStep !== undefined && "special" in wStep && wStep.special === "worldUseAny") {
                wt.nextStepIndex++;
                stack.push({ cardUid: asUid!, nextStepIndex: 0, eligible: [...wt.minions], minions: [...wt.minions] });
            }
        }

        const priorSteps: IStep[] = [];
        let clone: GnosticaGame | undefined;
        for (let segIdx = 0; segIdx < stepSegments.length; segIdx++) {
            const top = stack[stack.length - 1];
            if (top === undefined) {
                return undefined; // too many steps already typed - validateMove/move report this properly on submit
            }
            const frameDef = this.resolveFrameDef(top.cardUid);
            if (top.nextStepIndex >= frameDef.powers.length) {
                return undefined; // defensive - popExhaustedFrames keeps this in sync below
            }
            const stepIndex = top.nextStepIndex;
            const step = frameDef.powers[stepIndex];
            if ("special" in step && step.special === "fool") {
                // Fool's own step always auto-resolves the instant it's next in line on a real commit - nothing here for a click to build.
                return undefined;
            }
            const tokens = stepSegments[segIdx];
            const isLastSegment = segIdx === stepSegments.length - 1;
            // Set in whichever branch below falls through (step complete, not held back by preferCurrent) - the IStep this segment becomes.
            let completedStep: IStep | undefined;
            if ("primitive" in step) {
                const suitUidForStep = this.primitiveToSuit(step.primitive);
                const opts = this.computeShortcutOpts(frameDef, step.primitive, stepIndex, frameDef.powers.length, step.opts);
                // Cups alone infers its mode from shape; it already falls back to the plain positional read for every other suit.
                const derived = deriveMinorMode(suitUidForStep, tokens.slice(1));
                const mode = derived?.mode;
                const rest = derived?.args ?? tokens.slice(1);
                // Built once up front so the shared shape check and a "complete" outcome below can both reuse it; "malformed" folds into "incomplete" here.
                const istepSoFar = mode === undefined ? undefined
                    : suitUidForStep === "C" ? this.buildCupsStep(tokens[0], mode, rest)
                        : this.buildRdsStep(suitUidForStep, mode, tokens[0], rest);
                const shape = istepSoFar === undefined ? { status: "incomplete" as const } : primitiveStepShape(suitUidForStep, istepSoFar);
                if (shape.status !== "complete" || (isLastSegment && callOpts.preferCurrent)) {
                    // Still building this one, OR the caller wants the last-typed segment treated as "current" even once complete (board clicks keep refining it).
                    const { minion, ambiguous, candidates } = this.resolveStepMinion(tokens, top.minions);
                    const istep = istepSoFar ?? { action: "with", withPiece: tokens[0] };
                    return { head, headArg, activeCardUid: top.cardUid, asUid, asSuit, suitUid: suitUidForStep, eligible: top.eligible, minions: top.minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts, mode, rest, istep };
                }
                completedStep = istepSoFar!;
            } else {
                // highPriestess/fool have no minionRef to strip; every other special does. A Magician's suit choice lives in asSuit, unless worldBorrow lets it spell its own leading token.
                const magicianAs = step.special === "magicianChoice" && asSuit !== undefined;
                const magicianNeedsAs = step.special === "magicianChoice" && asSuit === undefined && !worldBorrow;
                const noMinionRef = step.special === "highPriestess" || step.special === "fool";
                // orientMinion's "orient" subhead is kept literal by parseMove (unlike "with"), skipped here alongside the minionRef.
                const isOrientMinion = step.special === "orientMinion" && tokens[0]?.toLowerCase() === "orient";
                const rest = isOrientMinion ? tokens.slice(2) : noMinionRef ? tokens : tokens.slice(1);
                const specialMinionRef = isOrientMinion ? tokens[1] : noMinionRef ? undefined : tokens[0];
                // Built once up front - a Magician borrow's step needs no splicing once the suit is known: "at m0 create U" parses the same regardless of suit.
                let istepSoFar: IStep | undefined;
                let shape: StepShape;
                if (magicianAs) {
                    const magicianDerived = deriveMinorMode(asSuit!, tokens.slice(1));
                    istepSoFar = magicianDerived === undefined ? undefined
                        : asSuit === "C" ? this.buildCupsStep(tokens[0], magicianDerived.mode, magicianDerived.args)
                            : this.buildRdsStep(asSuit!, magicianDerived.mode, tokens[0], magicianDerived.args);
                    shape = istepSoFar === undefined ? { status: "incomplete" } : primitiveStepShape(asSuit!, istepSoFar);
                } else if (magicianNeedsAs) {
                    shape = { status: "incomplete" };
                } else {
                    istepSoFar = this.buildSpecialStep(step.special, specialMinionRef, rest);
                    shape = SPECIAL_STEP_SHAPES[step.special](istepSoFar);
                }
                if (shape.status !== "complete" || (isLastSegment && callOpts.preferCurrent)) {
                    // Same "still building, or the caller wants it treated as current regardless" rule as the primitive branch.
                    return this.buildSpecialPending(step.special, head, headArg, top.cardUid, top.eligible, top.minions, priorSteps, tokens, asUid, asSuit);
                }
                completedStep = istepSoFar!;
            }
            // Walking past this segment lets a LATER step of the SAME frame become click-driven, via a clone.
            priorSteps.push(completedStep!);
            clone ??= this.cloneLive();
            // A magicianChoice step needs its suit passed as `borrowedPower` here.
            const magicianAs = "special" in step && step.special === "magicianChoice" && asSuit !== undefined;
            try {
                const outcome = clone.applyPowerStep(step, top.minions, completedStep, frameDef, stepIndex, frameDef.powers.length, true, magicianAs ? asSuit : undefined);
                top.minions = GnosticaGame.chainMinion(top.minions, outcome ?? {}).map(m => ({
                    ...m,
                    piece: clone!.board.get(m.x, m.y)?.pieces[m.index],
                }));
                top.nextStepIndex++;
                if (outcome?.pushFrame !== undefined) {
                    stack.push({ cardUid: outcome.pushFrame.cardUid, nextStepIndex: 0, eligible: [...outcome.pushFrame.minions], minions: [...outcome.pushFrame.minions] });
                }
                GnosticaGame.popExhaustedFrames(clone, stack);
            } catch {
                // Every other step's tokens failing to resolve against a clone seeded from `this.board` means `this.board` has advanced past this step.
                top.nextStepIndex++;
            }
        }
        const top = stack[stack.length - 1];
        if (top === undefined) {
            return undefined; // every step already complete - nothing left to click for
        }
        const frameDef = this.resolveFrameDef(top.cardUid);
        const stepIndex = top.nextStepIndex;
        if (stepIndex >= frameDef.powers.length) {
            return undefined;
        }
        const step = frameDef.powers[stepIndex];
        if ("primitive" in step) {
            const suitUid = this.primitiveToSuit(step.primitive);
            const opts = this.computeShortcutOpts(frameDef, step.primitive, stepIndex, frameDef.powers.length, step.opts);
            const { minion, ambiguous, candidates } = this.resolveStepMinion(undefined, top.minions);
            return { head, headArg, activeCardUid: top.cardUid, asUid, asSuit, suitUid, eligible: top.eligible, minions: top.minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts, mode: undefined, rest: [], istep: { action: "with" } };
        }
        return this.buildSpecialPending(step.special, head, headArg, top.cardUid, top.eligible, top.minions, priorSteps, [], asUid, asSuit);
    }

    // Builds the `special`-flavored branch of IPendingStep, with an exception for magicianChoice which can be treated as non-special.
    private buildSpecialPending(
        special: SpecialPower, head: "use" | "play", headArg: string, activeCardUid: string,
        eligible: IMinionRef[], minions: IMinionRef[], priorSteps: IStep[], tokens: string[], asUid?: string, asSuit?: string,
    ): IPendingStep {
        if (special === "magicianChoice") {
            const suitFromToken = ALL_SUITS.some(s => s.uid === tokens[1]) ? tokens[1] : undefined;
            const suitUid = asSuit ?? suitFromToken;
            if (suitUid !== undefined) {
                const afterSuit = suitFromToken !== undefined ? tokens.slice(2) : tokens.slice(1);
                const [mode, ...rest] = afterSuit;
                const { minion, ambiguous, candidates } = this.resolveStepMinion(tokens, minions);
                const istep: IStep = mode === undefined
                    ? { action: "with", withPiece: tokens[0] }
                    : suitUid === "C" ? this.buildCupsStep(tokens[0], mode, rest)
                        : this.buildRdsStep(suitUid, mode, tokens[0], rest);
                return { head, headArg, activeCardUid, asUid, asSuit, suitUid, eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts: {}, mode, rest, istep };
            }
        }
        // Fool/High Priestess have no minionRef; worldUseAny/an unchosen magicianChoice also have no minion HERE - each defers its own minion choice further along.
        const noMinionRef = special === "highPriestess" || special === "fool" || special === "worldUseAny" || special === "magicianChoice";
        // orientMinion's "orient" subhead is kept literal by parseMove (unlike "with") - the minionRef sits one slot later for it than for every other special.
        const isOrientMinion = special === "orientMinion" && tokens[0]?.toLowerCase() === "orient";
        const minionTokens = isOrientMinion ? tokens.slice(1) : tokens;
        const rest = noMinionRef ? tokens : minionTokens.slice(1);
        const specialMinionRef = noMinionRef ? undefined : minionTokens[0];
        const { minion, ambiguous, candidates } = noMinionRef
            ? { minion: minions[0], ambiguous: false, candidates: minions }
            : this.resolveStepMinion(minionTokens, minions);
        const istep = this.buildSpecialStep(special, specialMinionRef, rest);
        return { head, headArg, activeCardUid, asUid, asSuit, special, eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts: {}, mode: undefined, rest, istep };
    }

    // The single valid cell a minor suit-power step may affect: the minion's own cell if facing "U", otherwise the one cell it's pointing at.
    public minorTargetCell(minion: IMinionRef): [number, number] {
        // `minion.piece`, when set, is a snapshot from a clone that already replayed an earlier step - preferred over a fresh board read (pre-mutation until commit).
        const piece = minion.piece ?? this.board.get(minion.x, minion.y)!.pieces[minion.index];
        if (piece.orientation === "U") {
            return [minion.x, minion.y];
        }
        const [dx, dy] = this.board.delta(piece.orientation as Exclude<Orientation, "U">);
        return [minion.x + dx, minion.y + dy];
    }

    // Whether `step` is a piece-target special (tradeHands/hierophantReplace, the only two requiring an ENEMY on the self-or-facing cell) with NO legal candidate right now.
    private specialStepHasNoLegalTarget(ctx: GnosticaGame, step: PowerStep, minions: readonly IMinionRef[]): boolean {
        if (!("special" in step) || (step.special !== "tradeHands" && step.special !== "hierophantReplace")) {
            return false;
        }
        // Checked against EVERY minion in `minions` (chainMinion may leave 2+ live candidates); `ctx` matters because validateFrameStack applies to a CLONE, not `this`.
        return minions.every(m => {
            const [faceX, faceY] = ctx.minorTargetCell(m);
            const t = ctx.board.get(faceX, faceY);
            return t === undefined || !t.pieces.some(p => p.owner !== ctx.currplayer);
        });
    }

    // One ring beyond the CARD-bearing cells' bounding box (not this.board's raw bounds, which also include pushed/teleported-onto wasteland cells).
    public renderWindow(board: GnosticaBoard = this.board): { minX: number; maxX: number; minY: number; maxY: number } {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y, t] of board.entries()) {
            if (t.card === undefined) {
                continue;
            }
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
        if (!Number.isFinite(minX)) {
            return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
        }
        return { minX: minX - 1, maxX: maxX + 1, minY: minY - 1, maxY: maxY + 1 };
    }

    // Inverse of resolvePieceRef: the shortest ref that resolves back to this exact piece in the pool. Tries pips, then pips+orientation, then pips+player, then all three.
    public pieceRefStr(minion: IMinionRef, pool?: IMinionRef[]): string {
        const { x, y, index } = minion;
        const piece = minion.piece ?? this.board.get(x, y)!.pieces[index];
        const cell = GnosticaBoard.coords2algebraic(x, y);
        const candidateRefs = pool !== undefined
            ? pool.filter(p => p.x === x && p.y === y)
            : (this.board.get(x, y)?.pieces ?? []).map((_, i): IMinionRef => ({ x, y, index: i }));
        const byPips = candidateRefs
            .map(r => r.piece ?? this.board.get(r.x, r.y)!.pieces[r.index])
            .filter(p => p.size === piece.size);
        if (byPips.length <= 1) {
            return `${cell}.${piece.size}`;
        }
        if (byPips.filter(p => p.orientation === piece.orientation).length <= 1) {
            return `${cell}.${piece.size}.${piece.orientation}`;
        }
        if (byPips.filter(p => p.owner === piece.owner).length <= 1) {
            return `${cell}.${piece.size}.${piece.owner}`;
        }
        return `${cell}.${piece.size}.${piece.orientation}.${piece.owner}`;
    }

    private getPipsFromRef(ref: string): string {
        const idx = ref.indexOf(".");
        return idx === -1 ? ref : ref.split(".")[1];
    }

    // The one place an "orient" result is built - "orient", orientMinion, and orientAny all funnel through here. Call after the facing is set.
    private pushOrientResult(x: number, y: number, index: number, ref: string, facing: Orientation): void {
        this.results.push({
            type: "orient",
            where: GnosticaBoard.coords2algebraic(x, y),
            what: this.getPipsFromRef(ref),
            facing,
            who: this.board.get(x, y)!.pieces[index].owner,
        });
    }

    // Reads size/orientation off the piece itself rather than parsing a ref string - a ref only carries orientation when it was needed to disambiguate.
    private textFormat(piece: Piece): string {
        return `${piece.size}-pip pointing ${piece.orientation === "U" ? "up" : piece.orientation}`;
    }

    // Click-to-orient: clicking the piece's own cell means "face up"; clicking an orthogonal neighbour means "face that way" - one click states the direction outright.
    private orientationTowardClick(fromX: number, fromY: number, toX: number, toY: number): Orientation | undefined {
        if (fromX === toX && fromY === toY) {
            return "U";
        }
        for (const dir of cardinalOrientations) {
            const [dx, dy] = this.board.delta(dir as Exclude<Orientation, "U">);
            if (fromX + dx === toX && fromY + dy === toY) {
                return dir;
            }
        }
        return undefined;
    }


    // Best-effort feasibility check for which modes are worth offering as buttons - not a full legality check; a struck-through mode still gets a button, rejected on click.
    public minorModeAvailability(pending: { suitUid?: string; minion: IMinionRef; opts: Record<string, unknown> }): Map<string, { key: string; params?: Record<string, unknown> } | undefined> {
        // Only ever called for a suit-shaped pending - suitUid is guaranteed set here.
        const suitUid = pending.suitUid!;
        const minion = pending.minion.piece ?? this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetT = this.board.get(tx, ty);
        const cell = GnosticaBoard.coords2algebraic(tx, ty);
        const hand = this.hands[this.currplayer - 1];
        const result = new Map<string, { key: string; params?: Record<string, unknown> } | undefined>();
        for (const mode of Object.keys(MINOR_MODES[suitUid])) {
            switch (`${suitUid}.${mode}`) {
                case "C.own":
                    result.set(mode, (targetT === undefined || targetT.canAdd(pending.opts.ignoreCapacity === true))
                        ? undefined : { key: "CELL_FULL" });
                    break;
                case "C.enemy":
                    result.set(mode, (targetT?.pieces ?? []).some(p => p.owner !== this.currplayer)
                        ? undefined : { key: "NO_ENEMY_THERE", params: { cell } });
                    break;
                case "C.new":
                    if (this.board.classify(tx, ty) !== "wasteland") {
                        result.set(mode, { key: "NOT_A_WASTELAND" });
                    } else if (pending.opts.allowRandomDraw === true || handHasCardOfValue(hand, 1)) {
                        result.set(mode, undefined);
                    } else {
                        result.set(mode, { key: "NO_CARD_FOR_TERRITORY" });
                    }
                    break;
                case "R.piece":
                case "R.tile":
                    result.set(mode, this.rodNeedsFacingReason("R", minion));
                    break;
                case "D.tile": {
                    const current = targetT?.pointValue() ?? 0;
                    if (current === 0) {
                        result.set(mode, { key: "NOTHING_TO_GROW" });
                        break;
                    }
                    const pile = pending.opts.replacementSource === "discard" ? this.discardPile : hand;
                    const maxDelta = pending.opts.skipLadder === true ? 2 : 1;
                    let ok = false;
                    for (let d = 1; d <= maxDelta; d++) {
                        if (handHasCardOfValue(pile, current + d)) {
                            ok = true;
                        }
                    }
                    result.set(mode, ok ? undefined : { key: "NO_CARD_TO_GROW" });
                    break;
                }
                case "S.tile": {
                    const current = targetT?.pointValue() ?? 0;
                    if (current === 0) {
                        result.set(mode, { key: "NOTHING_TO_ATTACK" });
                        break;
                    }
                    const pile = pending.opts.replacementSource === "discard" ? this.discardPile : hand;
                    let ok = false;
                    for (let p = 1; p <= minion.size; p++) {
                        const resultValue = current - p;
                        if (resultValue < 0) {
                            continue;
                        }
                        if (resultValue === 0 || handHasCardOfValue(pile, resultValue)) {
                            ok = true;
                            break;
                        }
                    }
                    result.set(mode, ok ? undefined : { key: "NO_CARD_TO_ATTACK" });
                    break;
                }
                default:
                    result.set(mode, undefined);
            }
        }
        return result;

        function handHasCardOfValue(pile: string[], value: number): boolean {
            return pile.some(uid => {
                const c = allCards().find(cc => cc.uid === uid);
                return c !== undefined && cardPointValue(c) === value;
            });
        }
    }


    // Spells a pending step's own head. `pending.head` is always the original verb, `headArg` the root card.
    private describePendingMove(pending: IPendingStep, steps: IStep[]): string {
        const { asUid, asSuit } = pending;
        const base = { announceLast: false, valid: true, rest: [], stepSegments: [] };
        // A genuine resume always carries a "via <root>".
        if (this.continued.length > 0) {
            // High Priestess's second step is a discard/draw.
            if (pending.special === "highPriestess") {
                const step: IStep = { ...(steps[steps.length - 1] ?? { action: "discard" }), action: "discard" };
                return this.pickleMove({ ...base, head: "discard", viaUid: this.getContinuedUid(), steps: [step] });
            }
            const headStep: IStep = { action: pending.head, card: pending.headArg };
            return this.pickleMove({ ...base, head: pending.head, asUid, asSuit, viaUid: this.getContinuedUid(), steps: [headStep, ...steps] });
        }
        const headStep: IStep = { action: pending.head, card: pending.headArg };
        return this.pickleMove({ ...base, head: pending.head, asUid, asSuit, steps: [headStep, ...steps] });
    }

    // Assembles a full move string from a pending step's own already-typed prior power-step IStep's plus the current one
    private assembleStepMove(pending: IPendingStep, currentStep: IStep): string {
        return this.describePendingMove(pending, [...pending.priorSteps, currentStep]);
    }

    // Converts a Rods/Discs/Swords primitive's own (suitUid, mode, args into the IStep fields pickleMove now reads.
    public buildSuitStep(suitUid: string, minionRef: string, mode: string, args: string[]): IStep {
        // `args` matches applyRods/applyDiscs/applySwords's own destructure - an empty/short `args` leaves the IStep fields unset
        return suitUid === "C" ? this.buildCupsStep(minionRef, mode, args) : this.buildRdsStep(suitUid, mode, minionRef, args);
    }

    private buildRdsStep(suitUid: string, mode: string, minionRef: string, args: string[]): IStep {
        const verb = suitUid === "R" ? "move" : suitUid === "D" ? "grow" : "shrink";
        const step: IStep = { action: verb, withPiece: minionRef };
        if (suitUid === "R") {
            if (mode === "tile") {
                const [cellStr, distStr] = args;
                if (cellStr !== undefined) {
                    step.targetCell = cellStr;
                }
                if (distStr !== undefined) {
                    step.amount = parseInt(distStr, 10);
                }
                return step;
            }
            const [targetRef, distStr, orient] = args;
            if (targetRef !== undefined) {
                step.targetPiece = targetRef;
            }
            if (distStr !== undefined) {
                step.amount = parseInt(distStr, 10);
            }
            if (orient !== undefined) {
                step.direction = orient;
            }
            return step;
        }
        if (suitUid === "D") {
            if (mode === "piece") {
                const [targetRef, orient] = args;
                if (targetRef !== undefined) {
                    step.targetPiece = targetRef;
                }
                if (orient !== undefined) {
                    step.direction = orient;
                }
                return step;
            }
            const [cellStr, uid] = args;
            if (cellStr !== undefined) {
                step.targetCell = cellStr;
            }
            if (uid !== undefined) {
                step.card = uid;
            }
            return step;
        }
        // Swords
        if (mode === "piece") {
            const [targetRef, pipsStr, orient] = args;
            if (targetRef !== undefined) {
                step.targetPiece = targetRef;
            }
            if (pipsStr !== undefined) {
                step.amount = parseInt(pipsStr, 10);
            }
            if (orient !== undefined) {
                step.direction = orient;
            }
            return step;
        }
        const [cellStr, pipsStr, uid] = args;
        if (cellStr !== undefined) {
            step.targetCell = cellStr;
        }
        if (pipsStr !== undefined) {
            step.amount = parseInt(pipsStr, 10);
        }
        if (uid !== undefined) {
            step.card = uid;
        }
        return step;
    }

    // Cups' own (mode, args) into IStep shape; the "enemy" victim ref (#106) is a full piece ref, stored straight into targetPiece like any other target.
    private buildCupsStep(minionRef: string, mode: string, args: string[]): IStep {
        const [cellStr, ...trailing] = args;
        const step: IStep = { action: "create", withPiece: minionRef, atCell: cellStr };
        if (mode === "own") {
            // trailing is [seeded] or [seeded, correction] - the LAST one is always the real final facing; IStep has one direction slot, no room to mark "still just seeded".
            const facing = trailing[trailing.length - 1];
            if (facing !== undefined) {
                step.direction = facing;
            }
        } else if (mode === "enemy") {
            if (trailing[0] !== undefined) {
                step.targetPiece = trailing[0];
            }
        } else if (trailing[0] !== undefined) {
            step.card = trailing[0];
        }
        return step;
    }

    // Hermit's (minionRef, rest) into IStep fields. "piece" mode targets a piece ref; "tile" mode identifies the territory by its card uid, not a bare cell.
    private buildHermitStepFromArgs(minionRef: string, mode: string, args: string[]): IStep {
        const step: IStep = { action: "fly", withPiece: minionRef };
        const [primary, destCell, orient] = args;
        if (primary !== undefined) {
            if (mode === "tile") {
                step.card = primary;
            } else {
                step.targetPiece = primary;
            }
        }
        if (destCell !== undefined) {
            step.targetCell = destCell;
        }
        if (mode === "piece" && orient !== undefined) {
            step.direction = orient;
        }
        return step;
    }

    private buildHermitStep(minionRef: string, rest: string[]): IStep {
        const derived = deriveHermitMode(rest);
        if (derived === undefined) {
            return { action: "fly", withPiece: minionRef };
        }
        return this.buildHermitStepFromArgs(minionRef, derived.mode, derived.args);
    }

    // Converts one power step's own already-assembled tokens into the matching IStep, for a caller with real tokens but no parsed move string (randomMove.ts).
    public stepFromTokens(step: PowerStep, tokens: string[], borrowedPower?: string): IStep {
        const withoutOrient = "special" in step && step.special === "orientMinion" && tokens[0]?.toLowerCase() === "orient" ? tokens.slice(1) : tokens;
        const [minionRef, ...rest] = withoutOrient;
        if ("primitive" in step) {
            const suitUid = step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S";
            const derived = deriveMinorMode(suitUid, rest);
            return derived === undefined ? { action: "with", withPiece: minionRef } : this.buildSuitStep(suitUid, minionRef, derived.mode, derived.args);
        }
        if (step.special === "magicianChoice") {
            // The suit is `borrowedPower` - the step's own tokens carry no suit letter now that #105's chained "as <uid> as <suit>" is the only spelling produced.
            const derived = borrowedPower === undefined ? undefined : deriveMinorMode(borrowedPower, rest);
            return derived === undefined ? { action: "with", withPiece: minionRef } : this.buildSuitStep(borrowedPower!, minionRef, derived.mode, derived.args);
        }
        return this.buildSpecialStep(step.special, minionRef, rest);
    }

    // Converts a completed special-power step's own (minionRef, rest) into the IStep fields pickleMove reads; shared by parsePendingStep and every handle*Click function.
    private buildSpecialStep(special: SpecialPower, minionRef: string | undefined, rest: string[]): IStep {
        switch (special) {
            case "orientMinion":
                // orientMinion's "orient" IS its own bare subhead - the acting minion is also the target, so both fields carry the same ref.
                return { action: "orient", withPiece: minionRef, targetPiece: minionRef, direction: rest[0] };
            case "tradeHands":
                return { action: "trade", withPiece: minionRef, targetPiece: rest[1] };
            case "orientAny":
                return { action: "orient", withPiece: minionRef, targetPiece: rest[1], direction: rest[2] };
            case "hierophantReplace":
                // rest[3] (a real correction) always wins over rest[2] (the seeded default, "?" and all).
                return { action: "replace", withPiece: minionRef, targetPiece: rest[1], direction: rest[3] ?? rest[2] };
            case "hermitTeleport":
                return this.buildHermitStep(minionRef!, rest);
            case "judgementDraw":
                return { action: "draw", withPiece: minionRef, cardList: rest.slice(1) };
            case "magicianChoice": {
                const [suitLetter, ...suitRest] = rest;
                const derived = suitLetter === undefined ? undefined : deriveMinorMode(suitLetter, suitRest);
                if (suitLetter === undefined || derived === undefined) {
                    return { action: "create", withPiece: minionRef };
                }
                return suitLetter === "C"
                    ? this.buildCupsStep(minionRef!, derived.mode, derived.args)
                    : this.buildRdsStep(suitLetter, derived.mode, minionRef!, derived.args);
            }
            case "highPriestess": {
                // The resume-seeded path (noMinionRef) hands over `rest` unstripped, so a literal leading "discard" can still be here.
                const body = rest[0] === "discard" ? rest.slice(1) : rest;
                const drawIdx = body.indexOf("draw");
                const cardList = drawIdx === -1 ? body : body.slice(0, drawIdx);
                const step: IStep = { action: "discard", cardList };
                if (drawIdx !== -1 && body[drawIdx + 1] !== undefined) {
                    step.amount = parseInt(body[drawIdx + 1], 10);
                }
                return step;
            }
            default:
                // fool/worldUseAny carry no meaningful args of their own - a bare action is enough.
                return { action: special, withPiece: minionRef };
        }
    }

    // The minion is chosen but nothing else about this step is yet - every IStep needs SOME action, so this seeds just a bare "with <ref>" anchor, mirroring parseMove's own tolerance.
    private buildAnchorMove(pending: IPendingStep, ref: string): string {
        if (pending.special !== undefined) {
            return this.assembleStepMove(pending, this.buildSpecialStep(pending.special, ref, []));
        }
        return `${this.describePendingMove(pending, pending.priorSteps)}/with ${ref}`;
    }

    // Builds the move string for a step whose target was just picked from the unified candidate list; which suit-mode this becomes is inferred entirely from `targetRef`'s shape.
    private buildTargetedStepMove(pending: IPendingStep, targetRef: string): string {
        // Only ever called for a suit-shaped pending - suitUid is guaranteed set in every case.
        const suitUid = pending.suitUid!;
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        if (suitUid === "C") {
            let step: IStep;
            if (targetRef === "own") {
                // Trailing "?" - the new piece's default facing isn't yet a deliberate choice (mirrors "place"'s identical convention for the first piece).
                step = this.buildCupsStep(minionRef, "own", [targetCell, "U?"]);
            } else if (targetRef === "new") {
                step = this.buildCupsStep(minionRef, "new", [targetCell]);
            } else {
                step = this.buildCupsStep(minionRef, "enemy", [targetCell, targetRef]);
            }
            return this.assembleStepMove(pending, step);
        }
        const minionPiece = pending.minion.piece ?? this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        // A size-1 minion has only one legal dist/pips value, supplied here; a size>1 minion is left unset so the step reads as still-incomplete, not a guessed default.
        const onlyCount = minionPiece.size === 1 ? "1" : undefined;
        const isPieceTarget = targetRef.includes(".");
        let step: IStep;
        if (suitUid === "R") {
            // Rods' "tile" mode always seeds a real distance of 1 - a further destination-cell click is how the player reaches any distance beyond 1.
            step = isPieceTarget
                ? this.buildRdsStep("R", "piece", minionRef, onlyCount !== undefined ? [targetRef, onlyCount] : [targetRef])
                : this.buildRdsStep("R", "tile", minionRef, [targetCell, "1"]);
        } else if (suitUid === "D") {
            step = isPieceTarget
                ? this.buildRdsStep("D", "piece", minionRef, [targetRef])
                : this.buildRdsStep("D", "tile", minionRef, [targetCell]);
        } else {
            step = isPieceTarget
                ? this.buildRdsStep("S", "piece", minionRef, onlyCount !== undefined ? [targetRef, onlyCount] : [targetRef])
                : this.buildRdsStep("S", "tile", minionRef, [targetCell, "1"]);
        }
        return this.assembleStepMove(pending, step);
    }

    // Hermit's version of buildTargetedStepMove, but using buildHermitStepFromArgs instead of buildRdsStep.
    private buildTargetedHermitMove(pending: IPendingStep, targetRef: string): string {
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        if (targetRef.includes(".")) {
            return this.assembleStepMove(pending, this.buildHermitStepFromArgs(minionRef, "piece", [targetRef]));
        }
        const cardUid = this.board.get(...this.minorTargetCell(pending.minion))?.cardUid;
        const step = this.buildHermitStepFromArgs(minionRef, "tile", cardUid !== undefined ? [cardUid] : []);
        return this.assembleStepMove(pending, step);
    }

    private pendingMoveString(pending: IPendingStep): string {
        if (this.pendingMode(pending) === undefined) {
            return this.describePendingMove(pending, pending.priorSteps);
        }
        const ref = this.pieceRefStr(pending.minion, pending.minions);
        const suitUid = pending.suitUid!;
        const mode = pending.mode!; // pendingMode(pending) just confirmed this is defined
        const step = suitUid === "C"
            ? this.buildCupsStep(ref, mode, pending.rest)
            : this.buildRdsStep(suitUid, mode, ref, pending.rest);
        return this.assembleStepMove(pending, step).trim();
    }

    // Board-click handling once a minor-arcana power step's MODE is already chosen - cycling or switching whichever trailing arg(s) that mode's shape supports.
    private handlePendingStepBoardClick(pending: IPendingStep, x: number, y: number): string | IClickResult | undefined {
        if (this.pendingMode(pending) === undefined) {
            return undefined;
        }
        // Only ever called for a suit-shaped pending - suitUid is guaranteed set here.
        const suitUid = pending.suitUid!;
        const mode = pending.mode!; // pendingMode(pending) just confirmed this is defined
        const config = MINOR_MODES[suitUid][mode];
        // Fills the rebuilt move's selector slot; the "piece"-shape branch's own self-or-facing target instead goes through pickPieceTargetClick.
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        const minionPiece = pending.minion.piece ?? this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        // Only ever reached for R/D/S - every Cups branch below returns early instead (Cups carries no mode word to rebuild against).
        const rebuild = (rest: string[]): string =>
            this.assembleStepMove(pending, this.buildRdsStep(suitUid, mode, minionRef, rest));

        if (config.shape === "cell") {
            const [tx, ty] = this.minorTargetCell(pending.minion);
            // Cups "own" is the one cell-shape mode with an orientation arg; a click here sets the OPTIONAL 3rd token, over the target cell PLUS its neighbours.
            if (suitUid === "C" && mode === "own") {
                const dir = this.orientationTowardClick(tx, ty, x, y);
                if (dir === undefined) {
                    return undefined;
                }
                const cell = GnosticaBoard.coords2algebraic(tx, ty);
                // Cups carries no mode word - built directly here instead of via `rebuild`, which would wrongly splice "own" back in.
                return this.assembleStepMove(pending, this.buildCupsStep(minionRef, "own", [cell, dir]));
            }
            // Rods' "tile" mode: the cell is fixed (the facing cell) - a click instead sets DISTANCE, anchored on the facing cell rather than a chosen piece target.
            if (suitUid === "R") {
                const [dx, dy] = this.board.delta(minionPiece.orientation as Exclude<Orientation, "U">);
                for (let n = 1; n <= minionPiece.size; n++) {
                    if (x === tx + dx * n && y === ty + dy * n) {
                        return rebuild([pending.istep.targetCell!, String(n)]);
                    }
                }
                return undefined;
            }
            if (x !== tx || y !== ty) {
                return undefined;
            }
            // "new" (Cups) - the only remaining arg is a hand-card uid, nothing to cycle here; "enemy"'s victim is already chosen the instant the mode is inferred.
            if (suitUid === "C") {
                return mode === "new" ? this.assembleStepMove(pending, this.buildCupsStep(minionRef, "new", [pending.istep.atCell!])) : undefined;
            }
            // "tile" (Discs) - same as "new" above.
            return rebuild([pending.istep.targetCell!]);
        }

        if (config.shape === "piece") {
            // The target itself is button-only now - overloading the same cells with a THIRD meaning (retargeting) alongside distance/orientation was confusing.
            if (pending.istep.targetPiece === undefined) {
                return undefined;
            }
            const targetResolution = this.resolvePieceRef(pending.istep.targetPiece);
            const target = targetResolution.kind === "ok" ? targetResolution.ref : undefined;
            if (target === undefined) {
                return undefined;
            }

            // Rods' distance is a real destination cell, along the ACTING minion's own facing (matches movePiece's own computation).
            if (suitUid === "R") {
                const [dx, dy] = this.board.delta(minionPiece.orientation as Exclude<Orientation, "U">);
                for (let n = 1; n <= minionPiece.size; n++) {
                    if (x === target.x + dx * n && y === target.y + dy * n) {
                        return rebuild([pending.istep.targetPiece, String(n)]);
                    }
                }
            }

            // Once the suit action is otherwise complete, a further click adjacent to the target's EFFECTIVE position sets its facing - only for the player's own piece.
            if (!config.isComplete(pending.istep)) {
                return undefined;
            }
            const targetPiece = this.board.get(target.x, target.y)!.pieces[target.index];
            if (targetPiece.owner !== this.currplayer) {
                return undefined;
            }
            let effX = target.x;
            let effY = target.y;
            if (suitUid === "R") {
                const [dx, dy] = this.board.delta(minionPiece.orientation as Exclude<Orientation, "U">);
                const dist = pending.istep.amount!;
                effX = target.x + dx * dist;
                effY = target.y + dy * dist;
            }
            const dir = this.orientationTowardClick(effX, effY, x, y);
            if (dir === undefined) {
                return undefined;
            }
            // The "core" required args (target, plus distance/pips for R/S - D.piece has no second arg), dropping any stale trailing facing correction.
            const core = suitUid === "D" ? [pending.istep.targetPiece] : [pending.istep.targetPiece, pending.istep.amount!.toString()];
            // This trailing facing is only ever an OPTIONAL addition, so a click landing back on the piece's own UNCORRECTED facing completes the step, not a no-op.
            if (dir === targetPiece.orientation) {
                const baseMove = rebuild(core);
                return { move: baseMove, valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
            }
            return rebuild([...core, dir]);
        }

        return undefined;
    }

    // Supplies a hand-card uid for whichever minor-arcana mode is waiting on one without pre-validating point value.
    private supplyStepCardUid(pending: IPendingStep, uid: string): string | IClickResult | undefined {
        const mode = this.pendingMode(pending);
        if (mode === undefined) {
            return undefined;
        }
        const key = `${pending.suitUid}.${mode}`;
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        if (key === "C.new" && pending.istep.atCell !== undefined && pending.istep.card === undefined) {
            // Cups carries no mode word - "at <cell> create" is already exactly what's typed so far, the uid is the only thing this click adds.
            return this.assembleStepMove(pending, this.buildCupsStep(minionRef, "new", [pending.istep.atCell, uid]));
        }
        let rest: string[];
        if (key === "D.tile" && pending.istep.targetCell !== undefined && pending.istep.card === undefined) {
            rest = [pending.istep.targetCell, uid];
        } else if (key === "S.tile" && pending.istep.targetCell !== undefined && pending.istep.amount !== undefined && pending.istep.card === undefined) {
            rest = [pending.istep.targetCell, pending.istep.amount.toString(), uid];
        } else {
            return undefined;
        }
        return this.assembleStepMove(pending, this.buildRdsStep(pending.suitUid!, mode, minionRef, rest));
    }

    // Shared self-or-facing-cell target pick, used by tradeHands/orientAny/hierophantReplace/hermitTeleport's "piece" mode alike; undefined when the click is off-target.
    private pickPieceTargetClick(minion: IMinionRef, x: number, y: number, cell: string, pendingForError: IPendingStep): string | IClickResult | undefined {
        const [faceX, faceY] = this.minorTargetCell(minion);
        // tradeHands/hierophantReplace must target an enemy; orientAny/hermitTeleport don't - reject a self-target immediately rather than fail only at submit.
        const requiresEnemy = pendingForError.special === "tradeHands" || pendingForError.special === "hierophantReplace";
        const enemyKey = pendingForError.special === "tradeHands" ? "TRADEHANDS_MUST_TARGET_ENEMY" : "HIEROPHANT_MUST_TARGET_ENEMY";
        if (x === minion.x && y === minion.y) {
            if (requiresEnemy) {
                return { move: this.pendingMoveString(pendingForError), valid: false, message: i18next.t(`apgames:validation.gnostica.${enemyKey}`) };
            }
            return this.pieceRefStr(minion);
        }
        if (x !== faceX || y !== faceY) {
            return undefined;
        }
        const t = this.board.get(faceX, faceY);
        if (t === undefined || t.pieces.length === 0) {
            return { move: this.pendingMoveString(pendingForError), valid: false, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE", { cell }) };
        }
        if (requiresEnemy) {
            const enemyIndex = t.pieces.findIndex(p => p.owner !== this.currplayer);
            if (enemyIndex === -1) {
                return { move: this.pendingMoveString(pendingForError), valid: false, message: i18next.t(`apgames:validation.gnostica.${enemyKey}`) };
            }
            return this.pieceRefStr({ x: faceX, y: faceY, index: enemyIndex });
        }
        return this.pieceRefStr({ x: faceX, y: faceY, index: 0 });
    }

    // Dispatches a board click to whichever special power's own click handler is in progress - undefined for judgementDraw/highPriestess/magicianChoice/hermitTeleport stage 1.
    private handlePendingSpecialBoardClick(pending: IPendingStep, x: number, y: number, cell: string): string | IClickResult | undefined {
        switch (pending.special) {
            case "orientMinion":
                return this.handleOrientMinionClick(pending, x, y);
            case "tradeHands":
                return this.handleTradeHandsClick(pending, x, y, cell);
            case "orientAny":
            case "hierophantReplace":
                return this.handleOrientAnyOrHierophantClick(pending, x, y, cell);
            case "hermitTeleport":
                return this.handleHermitTeleportClick(pending, x, y, cell);
            case "worldUseAny":
                return this.handleWorldChooseClick(pending, x, y);
            default:
                return undefined;
        }
    }

    // orientMinion: <minionRef> <orientation> - the acting minion IS the target, so this is just click-to-orient anchored at the fixed acting minion.
    private handleOrientMinionClick(pending: IPendingStep, x: number, y: number): string | IClickResult | undefined {
        const dir = this.orientationTowardClick(pending.minion.x, pending.minion.y, x, y);
        if (dir === undefined) {
            return undefined;
        }
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        return this.assembleStepMove(pending, { action: "orient", withPiece: minionRef, targetPiece: minionRef, direction: dir });
    }

    // Builds this step's own move string once a target ref is already resolved - shared by the click-driven stage 1 (pickPieceTargetClick) and the button-driven target picker.
    private buildSpecialTargetMove(pending: IPendingStep, targetRef: string): string | undefined {
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        if (pending.special === "tradeHands") {
            return this.assembleStepMove(pending, { action: "trade", withPiece: minionRef, targetPiece: targetRef });
        }
        if (pending.special === "hierophantReplace") {
            const targetResolution = this.resolvePieceRef(targetRef);
            if (targetResolution.kind !== "ok") {
                return undefined;
            }
            const capturedFacing = (targetResolution.ref.piece
                ?? this.board.get(targetResolution.ref.x, targetResolution.ref.y)!.pieces[targetResolution.ref.index]).orientation;
            // Trailing "?" - seeded from the captured piece's own prior facing, not yet a deliberate choice (mirrors Cups "own"'s identical convention).
            return this.assembleStepMove(pending, { action: "replace", withPiece: minionRef, targetPiece: targetRef, direction: `${capturedFacing}?` });
        }
        // orientAny: the target is chosen; its new facing is a separate decision only the player's own click may make - never auto-assigned.
        return this.assembleStepMove(pending, { action: "orient", withPiece: minionRef, targetPiece: targetRef });
    }

    // tradeHands: <minionRef> trade <targetRef> - a single self-or-facing-cell target pick, terminal.
    private handleTradeHandsClick(pending: IPendingStep, x: number, y: number, cell: string): string | IClickResult | undefined {
        const targetResult = this.pickPieceTargetClick(pending.minion, x, y, cell, pending);
        if (targetResult === undefined) {
            return undefined;
        }
        if (typeof targetResult !== "string") {
            return targetResult;
        }
        return this.buildSpecialTargetMove(pending, targetResult);
    }

    // orientAny/hierophantReplace: <minionRef> <targetRef> <orientation> - same two-stage click shape; stage 1 picks the target, stage 2 sets its facing.
    private handleOrientAnyOrHierophantClick(pending: IPendingStep, x: number, y: number, cell: string): string | IClickResult | undefined {
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        if (pending.istep.targetPiece === undefined) {
            const targetResult = this.pickPieceTargetClick(pending.minion, x, y, cell, pending);
            if (targetResult === undefined) {
                return undefined;
            }
            if (typeof targetResult !== "string") {
                return targetResult;
            }
            return this.buildSpecialTargetMove(pending, targetResult);
        }
        const targetRef = pending.istep.targetPiece!;
        const targetResolution = this.resolvePieceRef(targetRef);
        if (targetResolution.kind !== "ok") {
            return undefined;
        }
        const dir = this.orientationTowardClick(targetResolution.ref.x, targetResolution.ref.y, x, y);
        if (dir === undefined) {
            return undefined;
        }
        if (pending.special === "hierophantReplace") {
            // `dir` is already the click's own final resolved facing - no need to also carry the now-superseded seed.
            return this.assembleStepMove(pending, { action: "replace", withPiece: minionRef, targetPiece: targetRef, direction: dir });
        }
        return this.assembleStepMove(pending, { action: "orient", withPiece: minionRef, targetPiece: targetRef, direction: dir });
    }

    // hermitTeleport: `<minionRef> fly <targetRef> to <destCell> [orient  <direction>]` | `<minionRef> fly <cardUid> to <destCell>` via a button.
    private handleHermitTeleportClick(pending: IPendingStep, x: number, y: number, cell: string): string | IClickResult | undefined {
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        const mode = stepHermitMode(pending.istep);
        if (mode === undefined) {
            return undefined; // mode not chosen yet - only the hermit_piece/hermit_tile buttons can start this
        }
        if (mode === "tile") {
            // No self-vs-face CHOICE for a cell-shaped target - so any click here just sets/replaces the (unrestricted) destination.
            const cardUid = this.board.get(...this.minorTargetCell(pending.minion))?.cardUid;
             if (cardUid === undefined) {
                return undefined;
            }
            return this.assembleStepMove(pending, this.buildHermitStepFromArgs(minionRef, "tile", [cardUid, cell]));
        }
        // "piece" mode: the target is a genuine self-or-facing-cell choice until a destination is picked, then further clicks only replace it.
        if (pending.istep.targetCell === undefined) {
            const targetResult = this.pickPieceTargetClick(pending.minion, x, y, cell, pending);
            if (typeof targetResult === "string") {
                return this.assembleStepMove(pending, this.buildHermitStepFromArgs(minionRef, "piece", [targetResult]));
            }
            if (targetResult !== undefined) {
                return targetResult; // NO_PIECE_THERE at the facing cell
            }
            // Not a self/face click - once a target's already picked,
            // treat this as the destination instead; otherwise there's
            // nothing to build yet (pick a target first).
            if (pending.istep.targetPiece === undefined) {
                return undefined;
            }
            return this.assembleStepMove(pending, this.buildHermitStepFromArgs(minionRef, "piece", [pending.istep.targetPiece, cell]));
        }
        return this.assembleStepMove(pending, this.buildHermitStepFromArgs(minionRef, "piece", [pending.istep.targetPiece!, cell]));
    }

    // worldUseAny: a click on any major currently on the board (except World itself) picks it as the borrowed card.
    private handleWorldChooseClick(pending: IPendingStep, x: number, y: number): string | IClickResult | undefined {
        const t = this.board.get(x, y);
        if (t?.card === undefined) {
            return undefined; // not a card cell at all - not this handler's click
        }
        // A card cell, but the wrong kind.
        if (t.card.uid === "21") {
            return { move: this.pendingMoveString(pending), valid: false, message: i18next.t("apgames:validation.gnostica.WORLD_SELF_REFERENCE") };
        }
        if (!t.card.major) {
            return { move: this.pendingMoveString(pending), valid: false, message: i18next.t("apgames:validation.gnostica.WORLD_CHOOSE_TARGET") };
        }
        return this.describePendingMove({ ...pending, asUid: t.card.uid }, pending.priorSteps);
    }

    // Click support for the top-level turn choice.  "Declare" is handled up front.
    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        const parsed = this.parseMove(move);
        let outcome: string | IClickResult;
        if (piece === "_btn_declare") {
            outcome = this.pickleMove({ ...parsed, announceLast: !parsed.announceLast });
        } else {
            const bareMove = this.pickleMove({ ...parsed, announceLast: false });
            const core = this.handleClickCore(bareMove, row, col, piece, parsed);
            outcome = this.reattachLastFlag(core, parsed.announceLast);
        }
        let result: IClickResult;
        if (typeof outcome === "string") {
            result = this.validateMove(outcome) as IClickResult;
            result.move = outcome;
        } else {
            result = outcome;
        }
        // The front end only re-renders a live partial preview when `canrender` or `complete >= 0` is set - set unconditionally here for any valid result.
        if (result.valid) {
            result.canrender = true;
        }
        return result;
    }

    // Reattaches "last" to a click outcome computed against the last-stripped move; a string just gets the flag folded in, an already-decided result gets it spliced into `.move`.
    private reattachLastFlag(outcome: string | IClickResult, announceLast: boolean): string | IClickResult {
        if (!announceLast) {
            return outcome;
        }
        const moveStr = typeof outcome === "string" ? outcome : outcome.move;
        const combined = this.pickleMove({ ...this.parseMove(moveStr), announceLast: true });
        return typeof outcome === "string" ? combined : { ...outcome, move: combined };
    }

    // Click support for the "bidding" variant's opening procedure. Row/col are never used - both phases are driven entirely by clicking cards in an AreaPieces.
    private handleBiddingClick(move: string, piece?: string): string | IClickResult {
        if (piece === "_btn_bid") {
            return { move: "bid", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CARD_TO_BID") };
        }
        if (piece === "_btn_redraw") {
            return { move: "redraw", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CARDS_TO_REDRAW") };
        }
        // A bid is always exactly one card - unlike discard's toggle-list, each click REPLACES any earlier pick rather than accumulating.
        if (this.phase === "bidding" && piece?.startsWith("hand_")) {
            // Same "_new" stripping as the main-phase hand-card handler.
            const uid = piece.slice("hand_".length).replace(/_new$/, "");
            const hand = this.hands[this.currplayer - 1] ?? [];
            const idx = hand.indexOf(uid);
            if (idx === -1) {
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
            }
            return `bid ${idx + 1}`;
        }
        // Redraw can need several cards, so pool clicks toggle a uid list exactly like discard's own hand-card toggle.
        if (this.phase === "redraw" && piece?.startsWith("pool_")) {
            const uid = piece.slice("pool_".length);
            if (!this.biddingPool!.includes(uid)) {
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.REDRAW_UID_NOT_IN_POOL", { uid }) };
            }
            const { head, steps } = this.parseMove(move);
            let picks = head?.toLowerCase() === "redraw" ? [...(steps[0]?.cardList ?? [])] : [];
            if (picks.includes(uid)) {
                picks = picks.filter(u => u !== uid);
            } else {
                picks.push(uid);
            }
            return ["redraw", ...picks].join(" ");
        }
        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
    }

    // `parsedMove`, when given, is `move` already parsed by the caller (handleClick already needs it for its own "last" handling) - reused here to skip a redundant re-parse.
    private handleClickCore(move: string, row: number, col: number, piece?: string, parsedMove?: IParsedMove): string | IClickResult {
        try {
            // The "bidding" variant's opening procedure is structurally unlike every other click, so it's handled entirely by its own function.
            if (this.phase !== "main") {
                return this.handleBiddingClick(move, piece);
            }
            // A pending obligation's own real click targets show up directly, so `move` may still be leftover from before it existed - seed it uniformly here.
            if (this.continued.length > 0 && (parsedMove ?? this.parseMove(move)).head === undefined) {
                move = this.buildViaMove([]);
            }
            if (piece !== undefined && piece.startsWith("_btn_")) {
                const value = piece.slice("_btn_".length);
                if (value.startsWith("minion_")) {
                    // "minion_<ref>" - offered whenever 2+ of the acting player's pieces are eligible and none has been picked yet; types just the ref.
                    const ref = value.slice("minion_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || !pending.minionAmbiguous) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    // Resolved against minionCandidates (currently shown), not the full minions pool - a stale move string shouldn't resolve against pieces no longer on offer.
                    const resolved = this.resolvePieceRef(ref, pending.minionCandidates);
                    if (resolved.kind !== "ok") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const clickedPiece = this.board.get(resolved.ref.x, resolved.ref.y)!.pieces[resolved.ref.index];
                    const rodReason = this.rodNeedsFacingReason(pending.suitUid, clickedPiece);
                    if (rodReason !== undefined) {
                        return { move, valid: false, message: i18next.t(`apgames:validation.gnostica.${rodReason.key}`) };
                    }
                    const minionRef = this.pieceRefStr(resolved.ref, pending.minions);
                    return this.buildAnchorMove(pending, minionRef);
                }
                if (value.startsWith("orientpick_")) {
                    // "orientpick_<ref>" - orient's own minion-picker (orient has no IPendingStep to resolve against, so it can't reuse "minion_"); facing is a separate click.
                    const ref = value.slice("orientpick_".length);
                    const parsed = this.parseMove(move);
                    if (parsed.head?.toLowerCase() !== "orient") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const resolved = this.resolvePieceRef(ref);
                    if (resolved.kind !== "ok" || this.board.get(resolved.ref.x, resolved.ref.y)!.pieces[resolved.ref.index].owner !== this.currplayer) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    return `orient ${this.pieceRefStr(resolved.ref)}`;
                }
                if (value.startsWith("target_")) {
                    // The unified candidate list for a fresh suit-power step, hermitTeleport, or an ambiguous orientAny/tradeHands/hierophantReplace target - one click supplies it directly.
                    const ref = value.slice("target_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    if (pending.special === "hermitTeleport") {
                        if (stepHermitMode(pending.istep) !== undefined) {
                            return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                        }
                        return this.buildTargetedHermitMove(pending, ref);
                    }
                    if (pending.special === "orientAny" || pending.special === "tradeHands" || pending.special === "hierophantReplace") {
                        if (pending.istep.targetPiece !== undefined) {
                            return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                        }
                        const result = this.buildSpecialTargetMove(pending, ref);
                        return result ?? { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    if (pending.suitUid === undefined || this.pendingMode(pending) !== undefined) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    // Same per-mode availability check the old mode_ buttons used - a struck-through candidate must still reject the click, not build a doomed move.
                    const clickedMode = pending.suitUid === "C"
                        ? (ref === "own" || ref === "new" ? ref : "enemy")
                        : (ref.includes(".") ? "piece" : "tile");
                    const reason = this.minorModeAvailability(pending).get(clickedMode);
                    if (reason !== undefined) {
                        return { move, valid: false, message: i18next.t(`apgames:validation.gnostica.${reason.key}`, reason.params ?? {}) };
                    }
                    return this.buildTargetedStepMove(pending, ref);
                }
                if (value.startsWith("pips_")) {
                    // Swords "piece" (attack) pips - a button set rather than a click-cycled arg, always rebuilt against the CURRENT target.
                    const n = value.slice("pips_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.suitUid !== "S" || this.pendingMode(pending) !== "piece") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const minionRef = this.pieceRefStr(pending.minion, pending.minions);
                    return this.assembleStepMove(pending, this.buildRdsStep("S", "piece", minionRef, [pending.istep.targetPiece!, n]));
                }
                if (value.startsWith("magician_")) {
                    // Stage 1 of magicianChoice - picks the suit letter, landing in the head as "as <suit>"; every following click then uses ordinary suit-mode machinery.
                    const suitUid = value.slice("magician_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.special !== "magicianChoice") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    return this.describePendingMove({ ...pending, asSuit: suitUid }, pending.priorSteps);
                }
                if (value.startsWith("drawcount_")) {
                    // The count-picker buttons offered once "discard" is the live head and no "draw <n>" suffix has been chosen yet; always rebuilt from the current discard uids.
                    const n = value.slice("drawcount_".length);
                    const parsed = this.parseMove(move);
                    if (parsed.head !== "discard") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    return ["discard", ...(parsed.steps[0]?.cardList ?? []), "draw", n].join(" ");
                }
                if (value.startsWith("hpdraw_")) {
                    // High Priestess's count-picker - mirrors drawcount_ but appends onto pending.rest (the CURRENT power step's own tokens), not the top-level move's args.
                    const n = value.slice("hpdraw_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.special !== "highPriestess") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    // Picking a count always completes this step - whatever's already been discarded is sitting in the step's own cardList.
                    const cardList = pending.istep.cardList ?? [];
                    return this.assembleStepMove(pending, { action: "discard", cardList, amount: parseInt(n, 10) });
                }
                switch (value) {
                    case "pass":
                        // A genuine pass - explicitly zero discards AND zero draw; a bare "discard" seed defaults its omitted "draw <n>" to the max, so it isn't equivalent.
                        return "discard draw 0";
                    case "discard":
                        // validateDiscard's own message already says this - no override needed.
                        return "discard";
                    case "place":
                        // Not strictly necessary (an empty move already builds "place <cell>" from a bare board click), but offered for consistency with every other action.
                        return { move: "place", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CELL_TO_PLACE") };
                    case "use":
                        return { move: "use", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CARD_TO_ACTIVATE") };
                    case "play":
                        return { move: "play", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_HAND_CARD_TO_PLAY") };
                    case "orient":
                        return { move: "orient", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_PIECE_TO_ORIENT") };
                    case "resume_power": {
                        // Seeds the resume submission's head + already-known card uid directly - pendingPower already names the exact card, no board click needed.
                        if (this.continued.length === 0) {
                            return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                        }
                        // Returned as a candidate string, not a hardcoded complete:-1, since a resumed Fool flip is ALREADY complete and needs Submit enabled.
                        return this.buildViaMove([]);
                    }
                    case "decline_power": {
                        if (this.continued.length === 0) {
                            return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                        }
                        // Declining pops the CURRENT top frame; Fool's own remaining flip auto-resolves on this same commit instead of pausing.
                        return this.buildViaMove([["decline"]]);
                    }
                    case "drawn":
                        // Only ever offered for Wheel of Fortune's special option.
                        {
                            const pending = this.parsePendingStep(move);
                            if (pending === undefined || pending.suitUid !== "C" || this.pendingMode(pending) !== "new" || pending.opts.allowRandomDraw !== true) {
                                return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                            }
                            const result = this.supplyStepCardUid(pending, "drawn");
                            return result ?? { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                        }
                    default:
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                }
            }

            const { head, steps: headSteps } = this.parseMove(move);

            // Hand-card clicks arrive as `piece`, independent of row/col.  If no action is selected, the click is rejected.
            if (piece !== undefined && piece.startsWith("hand_")) {
                // TODO: render these cards as desired WITHOUT adding an unnecessary "_new" suffix which needs stripping.
                const uid = piece.slice("hand_".length).replace(/_new$/, "");
                const hand = this.hands[this.currplayer - 1] ?? [];
                if (!hand.includes(uid)) {
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
                }
                const pendingForCard = this.parsePendingStep(move, { preferCurrent: true });
                if (pendingForCard !== undefined && this.pendingMode(pendingForCard) !== undefined) {
                    const result = this.supplyStepCardUid(pendingForCard, uid);
                    if (result !== undefined) {
                        return result;
                    }
                    // Not a mode expecting a card uid right now - fall through.
                }
                if (pendingForCard?.special === "highPriestess") {
                    // Special handling for the one of her discard/draw steps - istep.cardList is already just the discard uids, "draw N" already stripped.
                    let discards = [...(pendingForCard.istep.cardList ?? [])];
                    if (discards.includes(uid)) {
                        discards = discards.filter(u => u !== uid);
                    } else {
                        discards.push(uid);
                    }
                    return this.assembleStepMove(pendingForCard, { action: "discard", cardList: discards });
                }
                if (head === "play") {
                    // "play"'s own pool can span the whole board, unlike "use".
                    return `play ${uid}`;
                }
                if (head === "discard") {
                    let discards = [...(headSteps[0]?.cardList ?? [])];
                    if (discards.includes(uid)) {
                        discards = discards.filter(u => u !== uid);
                    } else {
                        discards.push(uid);
                    }
                    return ["discard", ...discards].join(" ");
                }
                // No action selected yet (or one a hand-card click makes no sense for) - require a button click first rather than guessing what the player meant.
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
            }

            // Discard-pile clicks drive judgementDraw only; a minor-arcana bucket has no individual identity, so clicking one draws a uniformly-random not-yet-selected uid from it.
            if (piece !== undefined && piece.startsWith("discard_")) {
                // Same "_new" stripping as the hand-card click above - neither a bare major uid nor a bucket key can end in "_new" for real, so this is unambiguous too.
                const key = piece.slice("discard_".length).replace(/_new$/, "");
                const pendingForDiscard = this.parsePendingStep(move, { preferCurrent: true });
                if (pendingForDiscard?.special !== "judgementDraw") {
                    return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                }
                const minionRef = this.pieceRefStr(pendingForDiscard.minion, pendingForDiscard.minions);
                // Leading "draw" may or may not be there yet depending on whether this is the first click - stripped before working the list, reattached when rebuilding.
                const selected = pendingForDiscard.istep.cardList ?? [];
                const minionPiece = this.board.get(pendingForDiscard.minion.x, pendingForDiscard.minion.y)!.pieces[pendingForDiscard.minion.index];
                const maxDraw = Math.min(minionPiece.size, Math.max(0, 6 - (this.hands[this.currplayer - 1]?.length ?? 0)));
                const rebuildDiscard = (updated: string[]): string =>
                    this.assembleStepMove(pendingForDiscard, { action: "draw", withPiece: minionRef, cardList: updated });

                if (/^\d{2}$/.test(key)) {
                    // Unambiguous major-arcana uid.
                    if (selected.includes(key)) {
                        return rebuildDiscard(selected.filter(u => u !== key));
                    }
                    if (selected.length >= maxDraw || !this.discardPile.includes(key)) {
                        return { move: this.pendingMoveString(pendingForDiscard), valid: false, message: i18next.t("apgames:validation.gnostica.TOO_MANY_TO_DRAW", { maxDraw, requested: selected.length + 1 }) };
                    }
                    return rebuildDiscard([...selected, key]);
                }

                const [bucketSuit, bucketCategory] = key.split("_");
                const matchesBucket = (uid: string): boolean => {
                    const card = allCards().find(c => c.uid === uid);
                    if (card === undefined || card.major) {
                        return false;
                    }
                    return card.suit.uid === bucketSuit && (card.court ? "royal" : "spot") === bucketCategory;
                };
                const alreadyFromBucket = selected.filter(matchesBucket);
                if (alreadyFromBucket.length > 0) {
                    const last = alreadyFromBucket[alreadyFromBucket.length - 1];
                    const idx = selected.lastIndexOf(last);
                    return rebuildDiscard([...selected.slice(0, idx), ...selected.slice(idx + 1)]);
                }
                if (selected.length >= maxDraw) {
                    return { move: this.pendingMoveString(pendingForDiscard), valid: false, message: i18next.t("apgames:validation.gnostica.TOO_MANY_TO_DRAW", { maxDraw, requested: selected.length + 1 }) };
                }
                const candidates = this.discardPile.filter(uid => matchesBucket(uid) && !selected.includes(uid));
                if (candidates.length === 0) {
                    return { move: this.pendingMoveString(pendingForDiscard), valid: false, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NOT_IN_DISCARD" }) };
                }
                const picked = candidates[Math.floor(Math.random() * candidates.length)];
                return rebuildDiscard([...selected, picked]);
            }

            const { minX, minY } = this.renderWindow();
            // A click on a rendered buffer segment (same contract as pacru.ts/azacru.ts): out-of-window row/col, coords via `piece` as "col,row", still WINDOW-RELATIVE.
            let x: number;
            let y: number;
            if ((row < 0 || col < 0) && piece !== undefined && /^-?\d+,-?\d+$/.test(piece)) {
                const [relCol, relRow] = piece.split(",").map(s => parseInt(s, 10));
                x = relCol + minX;
                y = relRow + minY;
            } else {
                x = col + minX;
                y = row + minY;
            }
            const cell = GnosticaBoard.coords2algebraic(x, y);

            let newmove: string;

            if (head === "place") {
                // Click-to-orient: clicking the chosen cell again means "face up", a neighbour means "face that way"; any OTHER cell is a fresh placement (defaulting to "U").
                const prevCell = headSteps[0]?.targetCell;
                let dir: Orientation | undefined;
                if (prevCell !== undefined) {
                    const [px, py] = GnosticaBoard.algebraic2coords(prevCell);
                    dir = this.orientationTowardClick(px, py, x, y);
                }
                if (prevCell !== undefined && dir !== undefined) {
                    newmove = `place ${prevCell} ${dir}`;
                } else {
                    newmove = `place ${cell} U?`;
                }
            } else if (head === "orient") {
                // Same click-to-orient model as "place", but relative to whichever piece is already selected (prevRef) rather than the clicked cell.
                const prevRef = headSteps[0]?.targetPiece;
                let dir: Orientation | undefined;
                let prevLoc: { x: number; y: number; index: number } | undefined;
                // A bare cell token (2+ own pieces there, none picked yet) isn't a resolvable piece ref - treat it the same as "nothing selected yet" below.
                if (prevRef !== undefined && prevRef.includes(".")) {
                    prevLoc = this.resolvePieceRefTrusted(prevRef);
                    dir = this.orientationTowardClick(prevLoc.x, prevLoc.y, x, y);
                }
                if (prevLoc !== undefined && dir !== undefined) {
                    // validateOrient's own message already distinguishes a no-op from a real, complete reorientation - nothing to override here.
                    newmove = `orient ${prevRef} ${dir}`;
                } else {
                    // Fresh selection - routed through the same minion-selection primitive "use"/"play" use, since 2+ distinguishable pieces here need a real choice.
                    const pool = this.eligibleMinionsForOrient(x, y);
                    if (pool.length === 0) {
                        return { move, valid: false, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_SUCH_PIECE" }) };
                    }
                    const { minion, ambiguous } = this.resolveStepMinion(undefined, pool);
                    if (ambiguous) {
                        return `orient ${cell}`;
                    }
                    newmove = `orient ${this.pieceRefStr(minion)}`;
                }
            } else if (head === "use" || head === "play" || this.continued.length > 0) {
                // Once a minor-arcana power step's mode is chosen, a board click is target/arg cycling for that step first; falls through to ordinary use/play only if unmatched.
                const pending = this.parsePendingStep(move, { preferCurrent: true });
                // A completed PRIOR step's own click region often overlaps a FOLLOWING button-less special's start region - tried FIRST so starting the next step stays reachable.
                const advanced = this.parsePendingStep(move);
                // Some eligible minions still span more than one cell with none pinned down - a board click here means "this is the cell my minion is on," tried before mode/special cycling.
                const tryNarrowMinion = (candidate: IPendingStep | undefined): string | undefined => {
                    if (candidate === undefined || !candidate.minionAmbiguous) {
                        return undefined;
                    }
                    const atCell = candidate.minions.filter(m => m.x === x && m.y === y);
                    if (atCell.length === 0) {
                        return undefined;
                    }
                    if (atCell.length === 1) {
                        const ref = this.pieceRefStr(atCell[0], candidate.minions);
                        return this.buildAnchorMove(candidate, ref);
                    }
                    return this.buildAnchorMove(candidate, cell);
                };
                if (advanced !== undefined && advanced.special !== undefined && this.pendingSpecialUntouched(advanced)
                    && advanced.priorSteps.length > (pending?.priorSteps.length ?? -1)) {
                    const narrowed = tryNarrowMinion(advanced);
                    if (narrowed !== undefined) {
                        return narrowed;
                    }
                    const result = this.handlePendingSpecialBoardClick(advanced, x, y, cell);
                    if (result !== undefined) {
                        return result;
                    }
                }
                {
                    const narrowed = tryNarrowMinion(pending);
                    if (narrowed !== undefined) {
                        return narrowed;
                    }
                }
                if (pending !== undefined && this.pendingMode(pending) !== undefined) {
                    const result = this.handlePendingStepBoardClick(pending, x, y);
                    if (result !== undefined) {
                        return result;
                    }
                }
                if (pending !== undefined && pending.special !== undefined) {
                    const result = this.handlePendingSpecialBoardClick(pending, x, y, cell);
                    if (result !== undefined) {
                        return result;
                    }
                }
                if (head === "play" || this.continued.length > 0) {
                    // "play" has no cell of its own to re-pick the way "use" does - a board click here only ever means pending-step cycling (handled above).
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
                }
                const t = this.board.get(x, y);
                if (t?.card === undefined) {
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NO_CARD_THERE", { cell }) };
                }
                if (!t.pieces.some(p => p.owner === this.currplayer)) {
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NO_MINIONS_THERE", { cell }) };
                }
                newmove = `use ${t.card.uid}`;
            } else if (!this.hasPiecesOnBoard(this.currplayer)) {
                // Fresh click, nothing placed yet - place is the only legal start, needs no button. Facing defaults to "U", trailing "?" marking it not yet deliberate.
                newmove = `place ${cell} U?`;
            } else {
                // No mode chosen yet and pieces already exist - board clicks are genuinely ambiguous here, so this doesn't guess; the player picks a button first.
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
            }

            return newmove;
        } catch {
            return {
                move,
                valid: false,
                message: i18next.t("apgames:validation._general.DEFAULT_HANDLER"),
            };
        }
    }

    // A check used for requiring "place", either initially or after a wipeout.
    public hasPiecesOnBoard(player: playerid): boolean {
        for (const [, , t] of this.board.entries()) {
            if (t.pieces.some(p => p.owner === player)) {
                return true;
            }
        }
        return false;
    }

    // ============================================================
    // The "bidding" variant's opening procedure
    // ============================================================

    // "bid <n>" - n is the 1-based position of a card in the current player's actual hand (not the sorted rendering).
    private cmdBid(step: IStep, partial = false): void {
        if (partial) {
            return;
        }
        const n = step.amount!;
        this.bidPositions![this.currplayer - 1] = n;
        this.results.push({ type: "select", who: this.currplayer, what: "bid" });
        if (this.bidPositions!.every(p => p !== null)) {
            this.resolveBidRound();
        } else {
            this.nextPlayer();
        }
    }

    private validateBid(parsed: IParsedMove): IValidationResult {
        const n = parsed.steps[0]?.amount;
        if (n === undefined) {
            return this.invalid("apgames:validation.gnostica.BID_POSITION_REQUIRED");
        }
        const hand = this.hands[this.currplayer - 1];
        if (n < 1 || n > hand.length) {
            return this.invalid("apgames:validation.gnostica.BAD_BID_POSITION", { position: n, max: hand.length });
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // When every bidPositions slot is filled, reveal them and move them into the shared biddingPool.
    private resolveBidRound(): void {
        const revealed: { player: playerid; card: TarotCard }[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            const idx = this.bidPositions![p - 1]! - 1;
            const hand = this.hands[p - 1];
            const uid = hand[idx];
            hand.splice(idx, 1);
            this.biddingPool!.push(uid);
            revealed.push({ player: p as playerid, card: allCards().find(c => c.uid === uid)! });
        }
        this.bidPositions = new Array(this.numplayers).fill(null) as (number | null)[];

        // Highest major wins; if nobody bid a major, highest minor wins - every card's own rank.seq is exactly this comparison key already.
        const majors = revealed.filter(r => r.card.major);
        const pool = majors.length > 0 ? majors : revealed;
        const rank = (r: { card: TarotCard }): number => r.card.rank.seq;
        const maxRank = Math.max(...pool.map(rank));
        const winners = pool.filter(r => rank(r) === maxRank).map(r => r.player);

        // "Tournament rules": turn order is exactly the rank order everyone bid; ties (only among minors of different suits) break toward the lower player number.
        const setTurnOrder = (): void => {
            this.turnOrder = [...revealed]
                .sort((a, b) => {
                    const aTier = a.card.major ? 1 : 0;
                    const bTier = b.card.major ? 1 : 0;
                    if (aTier !== bTier) return bTier - aTier;
                    if (rank(a) !== rank(b)) return rank(b) - rank(a);
                    return a.player - b.player;
                })
                .map(r => r.player);
        };

        if (winners.length === 1) {
            setTurnOrder(); // turnOrder[0] === winners[0] by construction - see bidWinner's own getter
            this.beginRedraw();
            return;
        }

        // Tied - every player re-bids until one wins. If someone's hand is now empty (nothing left to bid, #68), nobody wins - checkEOG() called directly since "bid" skips move()'s own tail.
        if (this.hands.some(h => h.length === 0)) {
            this.gameover = true;
            this.winner = [];
            this.checkEOG();
            return;
        }
        this.currplayer = 1;
    }

    // Under "tournament rules" there's no physical seating, so "clockwise" is reinterpreted as turnOrder itself, "counterclockwise" as its exact reverse.
    private beginRedraw(): void {
        // Announce the now-finalized order once, regardless of which of resolveBidRound()'s two call sites got us here.
        this.results.push({ type: "announce", payload: [...this.turnOrder!] });
        // redrawOrder[0] is always the worst bidder, for every player count - jump there directly instead of routing through nextPlayer().
        this.phase = "redraw";
        this.currplayer = this.redrawOrder[0];
    }

    // "redraw <uid...>" - free choice from the shared, fully public biddingPool, drawing back up to 6. `partial` mirrors cmdDiscard's split; legality is validateRedraw's job.
    private cmdRedraw(step: IStep, partial = false): void {
        const args = step.cardList ?? [];
        const hand = this.hands[this.currplayer - 1];
        for (const uid of args) {
            this.biddingPool!.splice(this.biddingPool!.indexOf(uid), 1);
            hand.push(uid);
        }
        if (partial) {
            return;
        }
        this.cardsDrawn[this.currplayer - 1] = args.length;
        this.results.push({ type: "deckDraw", what: args.join(","), from: "pool" });

        // redrawPos's own getter reads the last REAL commit (this.stack's top), which doesn't include this move yet - this player's just-applied redraw needs +1 here.
        const donePos = this.redrawPos + 1;
        if (donePos < this.numplayers) {
            if (this.numplayers === 2) {
                // Ordinary rotation, not a direct jump - with exactly two players "whoever's next" is unconditionally "the other one."
                this.nextPlayer();
            } else {
                this.currplayer = this.redrawOrder[donePos];
            }
        } else {
            // Everyone has redrawn - redrawOrder always ends with the bid winner, so whoever just submitted this final redraw already IS the winner.
            this.phase = "main";
            // Nothing left to hide or replay once "bidding" is over for good - clear both so they stop appearing in every subsequent turn's state.
            this.bidPositions = undefined;
            this.biddingPool = undefined;
            if (this.numplayers !== 2) {
                this.currplayer = this.bidWinner!;
            }
        }
    }

    private validateRedraw(parsed: IParsedMove): IValidationResult {
        const uids = parsed.steps[0]?.cardList ?? [];
        const hand = this.hands[this.currplayer - 1];
        const needed = 6 - hand.length;
        if (uids.length !== needed) {
            return this.invalid("apgames:validation.gnostica.REDRAW_COUNT_MISMATCH", { requested: uids.length, needed });
        }
        const seen = new Set<string>();
        for (const uid of uids) {
            if (seen.has(uid)) {
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "DUPLICATE_CARD" });
            }
            seen.add(uid);
            if (!this.biddingPool!.includes(uid)) {
                return this.invalid("apgames:validation.gnostica.REDRAW_UID_NOT_IN_POOL", { uid });
            }
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // "pass" is only used for an eliminated player sitting out the game, usually via the "autopass" flag; legality is validatePass's own job.
    private cmdPass(partial = false): void {
        if (partial) {
            return;
        }
        this.results.push({ type: "pass", who: this.currplayer, why: "eliminated" });
        this.nextPlayer();
        this.checkEOG();
    }

    // The "autopass" flag's signal: a server auto-submits "pass" when this returns exactly ["pass"]; NOT a general move enumerator, every other case returns [].
    public moves(player?: playerid): string[] {
        const p = (player ?? this.currplayer) as playerid;
        if (this.eliminated.indexOf(p) > -1) {
            return ["pass"];
        } else
            return [];
    }

    // "place <cell> <orientation>" - only legal with zero pieces on board; a real facing is always required, same mandatory-facing shape Cups "own" uses.
    private cmdPlace(step: IStep): void {
        const cellStr = step.targetCell!;
        const orientationToken = step.direction!;
        // A trailing "?" (still-prepopulated, not yet deliberate) makes no difference to the actual piece created; strip it the same way here.
        const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
        const orientation = orientationStr as Orientation;
        const [x, y] = GnosticaBoard.algebraic2coords(cellStr);
        let territory = this.board.get(x, y);
        if (territory === undefined) {
            territory = new CellContents(undefined);
            this.board.store.set(x, y, territory);
        }
        // Your very first piece comes from your own stash, same as every other piece that ever enters play - it isn't manufactured out of nothing.
        takeFromStash(this.buildPowerContext(), this.currplayer, 1);
        territory.add(new Piece(this.currplayer, 1, orientation));
        this.addBufferIfWasteland(x, y);
        this.results.push({ type: "place", where: cellStr, how: "initial" });
    }

    private validatePlace(parsed: IParsedMove): IValidationResult {
        const step = parsed.steps[0];
        const cellStr = step?.targetCell;
        const orientationToken = step?.direction;
        if (cellStr === undefined) {
            return this.invalid("apgames:validation.gnostica.PLACE_CELL_REQUIRED");
        }
        const [x, y] = GnosticaBoard.algebraic2coords(cellStr);
        if (this.board.classify(x, y) === "void") {
            return this.invalid("apgames:validation.gnostica.PLACE_VOID", { cell: cellStr });
        }
        const contents = this.board.get(x, y);
        if (contents !== undefined && contents.pieces.length > 0) {
            return this.invalid("apgames:validation.gnostica.PLACE_OCCUPIED", { cell: cellStr });
        }
        // A default orientation is provided in the click flow, but may be missing from a hand-typed move.
        if (orientationToken === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PLACE_DIRECTION_REQUIRED") };
        }
        // A trailing "?" marks the click flow's own seeded default as not yet deliberate - complete:0; a hand-typed "place l0 U" is complete:1.
        // parseMove already guarantees a valid N/E/S/W/U (with or without "?"), so there's nothing left to validate here.
        const prepopulated = orientationToken.endsWith("?");
        return { valid: true, complete: prepopulated ? 0 : 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // "orient <pieceRef> <facing>" - only your own piece; legality is validateOrient's own job.
    private cmdOrient(step: IStep): void {
        const ref = step.targetPiece;
        const orientationStr = step.direction;
        // Still building - a bare cell or a missing orientation isn't resolvable yet; a trusted partial preview can legitimately be here mid-build, so just no-op.
        if (ref === undefined || !ref.includes(".") || orientationStr === undefined) {
            return;
        }
        const { x, y, index } = this.resolvePieceRefTrusted(ref);
        this.addBufferIfWasteland(x, y);
        const orientation = orientationStr as Orientation;
        // Reorienting one of your own minions, with no adjacency restriction, is exactly what orientMinion already is - reuse it rather than mutating .orientation inline.
        orientMinion(this.buildPowerContext(), x, y, index, orientation);
        this.pushOrientResult(x, y, index, ref, orientation);
    }

    // Any board cell whose facing might get set/adjusted by a click needs a buffer on a side only if that side's void cell is ALSO outside the rendered window.
    private addBufferIfWasteland(x: number, y: number): void {
        if (this.board.classify(x, y) !== "wasteland") {
            return;
        }
        const win = this.renderWindow();
        if (x === this.board.minX && x - 1 < win.minX) {
            this.buffers.push("W");
        }
        if (x === this.board.maxX && x + 1 > win.maxX) {
            this.buffers.push("E");
        }
        if (y === this.board.minY && y - 1 < win.minY) {
            this.buffers.push("N");
        }
        if (y === this.board.maxY && y + 1 > win.maxY) {
            this.buffers.push("S");
        }
    }

    private validateOrient(parsed: IParsedMove): IValidationResult {
        const step = parsed.steps[0];
        const ref = step.targetPiece;
        const orientationStr = step.direction;
        if (ref === undefined) {
            return this.invalid("apgames:validation.gnostica.ORIENT_ARGS_REQUIRED");
        }
        // A bare cell with 2+ of the player's own pieces means the acting minion hasn't been picked yet - still building, not a hard error, same tolerance every minion-selection context gets.
        if (!ref.includes(".")) {
            const coords = GnosticaBoard.algebraic2coords(ref);
            if (this.resolveStepMinion(undefined, this.eligibleMinionsForOrient(coords[0], coords[1])).ambiguous) {
                return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_MINION_BUTTON") };
            }
        }
        const result = this.resolvePieceRef(ref);
        if (result.kind !== "ok") {
            return this.invalidPieceRef(result.kind, ref);
        }
        const { x, y, index } = result.ref;
        const piece = this.board.get(x, y)!.pieces[index];
        if (piece.owner !== this.currplayer) {
            return this.invalid("apgames:validation.gnostica.NOT_YOUR_MINION");
        }
        // The minion itself is chosen but not the orientation.
        if (orientationStr === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT") };
        }
        //The parser already checked the orientation string so just cast it.
        const orientation = orientationStr as Orientation;
        
        // "orient" IS the whole action, so a no-op is rejected.
        if (piece.orientation === orientation) {
            return this.invalid(`apgames:validation.gnostica.ORIENT_NO_OP`);
        }
        // One real direction click is the whole action - done.
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // "discard [uid...] [draw <n>]" - discard the named hand cards, then draw back.
    private cmdDiscard(step: IStep, partial = false): void {
        const discardUids = step.cardList ?? [];
        const drawCountStr = step.amount?.toString();
        const drawn = discardDraw(this.buildPowerContext(), discardUids, drawCountStr, partial);
        if (discardUids.length > 0) {
            this.discarded.push(...discardUids);
            this.results.push({ type: "place", how: "discard", what: discardUids.join(",") });
        }
        this.results.push({ type: "deckDraw", count: drawn, from: "deck" });
        this.cardsDrawn[this.currplayer - 1] = drawn;
    }

    // Mirrors cmdDiscard's own "discard [uid...] [draw <n>]" grammar, using the same checkDiscardDraw primitive.
    private validateDiscard(parsed: IParsedMove): IValidationResult {
        const discardUids = parsed.steps[0]?.cardList ?? [];
        const drawCountStr = parsed.steps[0]?.amount?.toString();
        const failure = checkDiscardDraw(this.buildPowerContext(), discardUids, drawCountStr);
        if (failure) {
            return this.failureResult(failure);
        }
        // A missing "draw <n>" is never complete - the player must make an explicit choice.
        if (parsed.steps[0]?.amount === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.DISCARD_DRAW_REQUIRED") };
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // Use / play a card - both minor and major arcana.
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

    // "use <cardUid>" targets a card by its own identity, not a cell.  Cards are unique, so we can derive the cell.
    private findCardCell(uid: string): { x: number; y: number } | undefined {
        for (const [x, y, t] of this.board.entries()) {
            if (t.card?.uid === uid) {
                return { x, y };
            }
        }
        return undefined;
    }

    // Returns the card's display name, for messages.  
    private cardNameOrUid(uid: string): string {
        return allCards().find(c => c.uid === uid)!.name;
    }

    // Returns every piece the acting player owns on the activated cell, for the minion pool.
    private piecesOwnedAt(x: number, y: number): IMinionRef[] {
        const t = this.board.get(x, y);
        if (t === undefined) {
            return [];
        }
        return t.pieces
            .map((p, index) => ({ x, y, index, piece: p }))
            .filter(ref => ref.piece.owner === this.currplayer);
    }

    public eligibleMinionsForActivate(x: number, y: number): IMinionRef[] {
        const t = this.board.get(x, y);
        if (t === undefined || t.card === undefined) {
            return [];
        }
        return this.piecesOwnedAt(x, y);
    }

    // For the standalone "orient" command - same shape as eligibleMinionsForActivate but without the card requirement; you can orient a minion on a bare wasteland cell.
    private eligibleMinionsForOrient(x: number, y: number): IMinionRef[] {
        return this.piecesOwnedAt(x, y);
    }

    // Every piece the acting player owns anywhere on the board - the pool "play" draws minions from.
    public eligibleMinionsForPlay(): IMinionRef[] {
        const eligible: IMinionRef[] = [];
        for (const [x, y, t] of this.board.entries()) {
            t.pieces.forEach((p, index) => {
                if (p.owner === this.currplayer) {
                    eligible.push({ x, y, index, piece: p });
                }
            });
        }
        return eligible;
    }

    // Only ever reached for a FRESH activation - move() resumes this.continued directly instead, before this switch is reached. Legality is validateActivate's own job.
    private cmdActivate(cardUid: string, steps: IStep[], partial: boolean, asUid?: string, asSuit?: string): IPowerFrame[] | undefined {
        const { x, y } = this.findCardCell(cardUid)!;
        const t = this.board.get(x, y)!;
        const eligible = this.eligibleMinionsForActivate(x, y);
        this.results.push({ type: "use", what: t.card!.uid });
        return this.applyCardPower(t.card!, eligible, steps, partial, asUid, asSuit);
    }

    private validateActivate(parsed: IParsedMove): IValidationResult {
        const cardUid = parsed.steps[0]?.card;
        if (cardUid === undefined) {
            return this.invalid("apgames:validation.gnostica.ACTIVATE_UID_REQUIRED");
        }
        if (allCards().find(c => c.uid === cardUid) === undefined) {
            return this.invalid("apgames:validation.gnostica.UNKNOWN_CARD", { uid: cardUid });
        }
        const loc = this.findCardCell(cardUid);
        if (loc === undefined) {
            return this.invalid("apgames:validation.gnostica.CARD_NOT_ON_BOARD", { uid: cardUid });
        }
        const { x, y } = loc;
        const t = this.board.get(x, y)!;
        const eligible = this.eligibleMinionsForActivate(x, y);
        if (eligible.length === 0) {
            return this.invalid("apgames:validation.gnostica.NO_MINIONS_THERE", { uid: cardUid });
        }
        return this.validateCardPower(t.card!, eligible, parsed.steps.slice(1), parsed.asUid, parsed.asSuit);
    }

    // "Play a card from your hand to the discard pile" - same fresh-activation-only note as cmdActivate; legality is validatePlay's own job.
    private cmdPlay(uid: string, steps: IStep[], partial: boolean, asUid?: string, asSuit?: string): IPowerFrame[] | undefined {
        const hand = this.hands[this.currplayer - 1];
        const handIdx = hand.indexOf(uid);
        const card = allCards().find(c => c.uid === uid)!;
        hand.splice(handIdx, 1);
        this.discardPile.push(uid);
        this.discarded.push(uid);
        this.results.push({ type: "deckDraw", what: uid, from: "hand" });

        const eligible = this.eligibleMinionsForPlay();
        return this.applyCardPower(card, eligible, steps, partial, asUid, asSuit);
    }


    private validatePlay(parsed: IParsedMove): IValidationResult {
        const uid = parsed.steps[0]?.card;
        if (uid === undefined) {
            return this.invalid("apgames:validation.gnostica.PLAY_UID_REQUIRED");
        }
        const hand = this.hands[this.currplayer - 1];
        const handIdx = hand.indexOf(uid);
        if (handIdx === -1) {
            return this.invalid("apgames:validation.gnostica.NOT_IN_HAND", { uid });
        }
        const card = allCards().find(c => c.uid === uid);
        if (card === undefined) {
            return this.invalid("apgames:validation.gnostica.UNKNOWN_CARD", { uid });
        }
        // Playing the Fool discards its own card FIRST, which would otherwise let its first flip trivially "succeed" by revealing only itself - checked here, on the REAL pre-play state.
        if (uid === "00" && this.drawPile.length === 0 && this.discardPile.length === 0) {
            return this.invalid("apgames:validation.gnostica.DRAW_PILE_EMPTY");
        }
        const eligible = this.eligibleMinionsForPlay();
        // cmdPlay removes the card from hand AND pushes it to discard BEFORE resolving its power - mirrored here for the DURATION of validation only, restored via finally.
        hand.splice(handIdx, 1);
        this.discardPile.push(uid);
        try {
            return this.validateCardPower(card, eligible, parsed.steps.slice(1), parsed.asUid, parsed.asSuit);
        } finally {
            hand.splice(handIdx, 0, uid);
            this.discardPile.pop();
        }
    }

    // Returns walkFrameStack's residual stack for move() to persist, or undefined for a minor card - always a single step, never pauses.
    private applyCardPower(card: Card, eligible: IMinionRef[], steps: IStep[], partial: boolean, asUid?: string, asSuit?: string): IPowerFrame[] | undefined {
        if (card.major) {
            const def = getMajorArcanaDef(card);
            return this.applyMajorPower(def, eligible, steps, partial, asUid, asSuit);
        }
        this.applyMinorPower(card.suit.uid, eligible, steps);
        return undefined;
    }

    private validateCardPower(card: Card, eligible: IMinionRef[], steps: IStep[], asUid?: string, asSuit?: string): IValidationResult {
        if (card.major) {
            const def = getMajorArcanaDef(card);
            return this.validateMajorPower(def, eligible, steps, asUid, asSuit);
        }
        return this.validateMinorPower(card.suit.uid, card.uid, eligible, steps);
    }

    // Tolerant of an incomplete step (mode chosen but not enough args, or no mode at all) - treated as still-skipped, same trick Magnate's parser uses for incremental click building.
    private applyMinorPower(suitUid: string, eligible: IMinionRef[], steps: IStep[]): void {
        if (steps.length === 0) {
            // #49 blocks this at the validate layer; a trusted/partial caller can still legitimately be here mid-build, so just no-op.
            return;
        }
        const step = steps[0];
        const minionRef = step.withPiece!;
        if (this.isMinionCellStillNarrowing(minionRef, eligible)) {
            return; // cell chosen, which minion there is still undecided - still skipped
        }
        const minion = this.resolvePieceRefTrusted(minionRef, eligible);
        // Same shared shape check applyPowerStep uses for a major card's primitive step - a minor card's power is that same grammar, just never chained.
        const shape = primitiveStepShape(suitUid, step);
        if (shape.status === "incomplete") {
            return; // still skipped so far
        }
        this.applySuitPrimitive(suitUid, minion, step, {});
    }

    // Mirrors applyMinorPower's own tolerance exactly - skipping, and an incomplete-so-far step, both validate as "fine, nothing to report yet".
    public validateMinorPower(suitUid: string, cardUid: string, eligible: IMinionRef[], steps: IStep[]): IValidationResult {
        if (steps.length === 0) {
            // #49: a use/play must take its one meaningful step, not skip it outright - still valid, still "in progress" (complete: -1), not an error.
            const msg = this.freshStepMessage(cardUid, 0, eligible);
            return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
        }
        if (steps.length > 1) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "MINOR_ONE_STEP_ONLY" });
        }
        const step = steps[0];
        const minionRef = step.withPiece;
        if (minionRef === undefined) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" });
        }
        // Same #49 principle as the steps.length===0 case above: a cell chosen but not which minion is ALSO genuinely still incomplete.
        if (this.isMinionCellStillNarrowing(minionRef, eligible)) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_MINION_BUTTON") };
        }
        const result = this.resolvePieceRef(minionRef, eligible);
        if (result.kind !== "ok") {
            return this.invalidPieceRef(result.kind, minionRef, "NOT_AN_ELIGIBLE_MINION");
        }
        const minion = result.ref;
        // Same shared shape check applyMinorPower/applyPowerStep use.
        const shape = primitiveStepShape(suitUid, step);
        if (shape.status === "incomplete") {
            const msg = this.primitiveIncompleteMessage(suitUid, step) ?? this.powerStepMessageKey(cardUid, 0, eligible);
            return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
        }
        if (shape.status === "malformed") {
            return this.invalid(`apgames:validation.gnostica.${shape.key}`, shape.params);
        }
        const stepResult = this.validateSuitPrimitive(suitUid, minion, step, {});
        if (stepResult.failed) {
            return stepResult.result;
        }
        // Cups "own" creation's still-prepopulated facing, or a piece just acted on with no reorientation given - either way complete:0, so the client doesn't auto-submit before a click.
        const softComplete = stepResult.outcome?.softComplete === true;
        return {
            valid: true,
            complete: softComplete ? 0 : 1,
            message: i18next.t(softComplete ? "apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT" : "apgames:validation._general.VALID_MOVE"),
        };
    }

    // Whether `cardUid` names a real major arcana card or a minor Fool flipped - either way, returns something shaped like a MajorArcanaDef so downstream code needs no second path.
    private static readonly SUIT_TO_PRIMITIVE: Record<string, SuitPrimitive> = { C: "create", R: "move", D: "grow", S: "attack" };

    private resolveFrameDef(cardUid: string): MajorArcanaDef {
        const existing = MAJOR_ARCANA[cardUid];
        if (existing !== undefined) {
            return existing;
        }
        const card = allCards().find(c => c.uid === cardUid);
        if (card === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: cardUid }));
        }
        return { uid: cardUid, name: card.name, seq: -1, icons: [], powers: [{ primitive: GnosticaGame.SUIT_TO_PRIMITIVE[card.suit.uid] }] };
    }

    // Applies a step's own outcome.newMinion chaining to `minions`: appends it, first removing whichever existing entry it supersedes (a splice can shift later same-cell indices down by one).
    private static chainMinion(minions: IMinionRef[], outcome: IStepOutcome): IMinionRef[] {
        const stale = outcome.replacesMinion;
        const base = stale === undefined
            ? minions
            : minions
                .filter(m => !(m.x === stale.x && m.y === stale.y && m.index === stale.index))
                .map(m => (m.x === stale.x && m.y === stale.y && m.index > stale.index) ? { ...m, index: m.index - 1 } : m);
        return outcome.newMinion === undefined ? base : [...base, outcome.newMinion];
    }

    // Pops the top frame off `stack` in place - the ONE place every Decline/skip/exhaustion removes a frame, so the popped frame's own current acting piece can hand off to the frame beneath.
    private static popFrame(stack: IPowerFrame[]): void {
        const spent = stack.pop();
        if (spent === undefined) {
            return;
        }
        const beneath = stack[stack.length - 1];
        const current = spent.minions[spent.minions.length - 1];
        if (beneath !== undefined && current !== undefined) {
            beneath.minions = [current];
        }
    }

    // Pops fully-exhausted frames off the top of `stack` - shared cleanup after every step, since a one-power card (World itself) needs to disappear again immediately.
    private static popExhaustedFrames(target: GnosticaGame, stack: IPowerFrame[]): void {
        while (stack.length > 0 && stack[stack.length - 1].nextStepIndex >= target.resolveFrameDef(stack[stack.length - 1].cardUid).powers.length) {
            GnosticaGame.popFrame(stack);
        }
    }

    // Top step classification for walkFrameStack and validateFrameStack
    private static classifyStep(step: PowerStep, steps: IStep[], i: number): "decline" | "world" | "fool" | "step" {
        if (steps[i]?.action === "decline") {
            return "decline";
        }
        if ("special" in step && step.special === "worldUseAny") {
            return "world";
        }
        if ("special" in step && step.special === "fool") {
            return "fool";
        }
        return "step";
    }

    // The engine's one core stack-walker: "consume segments until they run out or a step forces a pause".
    private persistContinued(stack: readonly IPowerFrame[]): void {
        // Only genuine cross-submission obligations: a Fool/High Priestess frame that has taken at least one step ("00.1"/"00.2"/"02.1") and so owes a follow-up submission.
        this.continued = stack
            .filter(f => (f.cardUid === "00" || f.cardUid === "02") && f.nextStepIndex >= 1)
            .map(f => `${f.cardUid}.${f.nextStepIndex}`);
    }

    // Rebuilds the throwaway IPendingMajorPower-shaped view the resume machinery expects, from the minimal persisted this.continued tokens; one frame per token, minions recomputed fresh.
    private buildPendingFromContinued(): IPendingMajorPower | undefined {
        if (this.continued.length === 0) {
            return undefined;
        }
        const pool = this.eligibleMinionsForPlay();
        // Every non-outermost obligation got here via a Fool reveal (the only card that nests one on top of another), so it stays declinable.
        const stack = this.continued.map((token, idx) => {
            const [cardUid, step] = token.split(".");
            return { cardUid, nextStepIndex: Number(step), minions: [...pool], viaFool: idx > 0 } as IPowerFrame;
        });
        if (stack[stack.length - 1].cardUid === "00") {
            const revealed = this.discardPile[this.discardPile.length - 1];
            if (revealed !== undefined) {
                stack.push({ cardUid: revealed, nextStepIndex: 0, minions: [...pool], viaFool: true });
            }
        }
        return { rootCardUid: stack[0].cardUid, stack: stack as [IPowerFrame, ...IPowerFrame[]] };
    }

    // Returns the residual frame stack for move() to serialize into this.continued past the partial boundary, or undefined when nothing should be persisted.
    private walkFrameStack(stack: IPowerFrame[], steps: IStep[], partial: boolean, asUid?: string, asSuit?: string): IPowerFrame[] | undefined {
        // asUid/asSuit are separate fields, each consumed by exactly one step in the whole walk and never reused once read, so neither needs "clearing".
        const worldBorrow = asUid !== undefined;
        const chained = steps.length + (worldBorrow ? 1 : 0) > 1;
        let i = 0;
        let stepsProcessed = 0;
        for (;;) {
            const top = stack[stack.length - 1];
            if (top === undefined) {
                // Extra segments once the stack is already empty are validateFrameStack's own job to reject, not this one's.
                break;
            }
            const frameDef = this.resolveFrameDef(top.cardUid);
            const step = frameDef.powers[top.nextStepIndex];
            const kind = GnosticaGame.classifyStep(step, steps, i);
            if (kind === "decline") {
                i++;
                // A pure decline moves nothing on the board, but it's still a real, deliberate turn action - log it so a turn that ends right here doesn't vanish from the log.
                this.results.push({ type: "announce", payload: ["decline", top.cardUid] });
                GnosticaGame.popFrame(stack);
                // Popping can expose an ALREADY-exhausted frame directly beneath (e.g. World's own 1-step frame) - cascade the same as every other pop site.
                GnosticaGame.popExhaustedFrames(this, stack);
                continue;
            }
            let istep: IStep | undefined;
            // Which of asUid/asSuit THIS step needs, threaded straight into applyPowerStep as `borrowedPower`.
            let borrowedForThisStep: string | undefined;
            if (kind === "world") {
                // The borrowed card is named up front ("as <uid>"), never as a segment - so this step consumes nothing.
                borrowedForThisStep = asUid;
            } else if (kind === "fool") {
                if (partial) {
                    // Nothing genuinely happens under a partial preview - not even nextStepIndex should advance, or popExhaustedFrames would wrongly pop Fool's own frame.
                    return undefined;
                }
                // The flip consumes no segment - it's the only possible action for this step, so there is nothing to type.
            } else {
                if (i >= steps.length) {
                    // Segments exhausted: silently skip whatever's left of the CURRENT frame - same pop + cascade as an explicit "decline", so a mandatory Fool flip still fires this call.
                    GnosticaGame.popFrame(stack);
                    GnosticaGame.popExhaustedFrames(this, stack);
                    continue;
                }
                if ("special" in step && step.special === "magicianChoice") {
                    borrowedForThisStep = asSuit;
                    if (borrowedForThisStep === undefined) {
                        // Should never reach a trusted commit - validateFrameStack rejects this same shape outright.
                        throw new Error("magicianChoice step typed without a borrowed suit (\"as <suit>\").");
                    }
                }
                istep = steps[i];
                i++;
            }
            // Snapshot BEFORE every step except the first processed this call, so undo/redo can stop anywhere; discarded below if the step turns out to be a no-op.
            if (stepsProcessed > 0) {
                this.frames.push({
                    board: this.board.clone().store,
                    discardSummary: this.summarizeDiscardPile(this.discardPile),
                });
            }
            const resultsBefore = this.results.length;
            const outcome = this.applyPowerStep(step, top.minions, istep, frameDef, top.nextStepIndex, frameDef.powers.length, partial, borrowedForThisStep);
            if (outcome === undefined) {
                // A still-being-typed segment - stop here WITHOUT advancing nextStepIndex; nothing is persisted, so this exit only fires under a partial preview.
                if (stepsProcessed > 0) {
                    this.frames.pop();
                }
                return undefined;
            }
            stepsProcessed++;
            top.minions = GnosticaGame.chainMinion(top.minions, outcome);
            top.nextStepIndex++;
            // Wrap this step's own results into one _group entry, mirroring frogger.ts's own precedent.
            if (chained) {
                const stepResults = this.results.splice(resultsBefore) as APMoveResult[];
                if (stepResults.length > 0) {
                    this.results.push({ type: "_group", who: this.currplayer, results: stepResults as [APMoveResult, ...APMoveResult[]] });
                }
            }
            if (outcome.pushFrame !== undefined) {
                stack.push({ cardUid: outcome.pushFrame.cardUid, nextStepIndex: 0, minions: outcome.pushFrame.minions, viaFool: outcome.pushFrame.viaFool === true });
            }
            GnosticaGame.popExhaustedFrames(this, stack);
            if (outcome.forcePause === true) {
                return stack;
            }
        }
        // Only reachable via the top-of-loop `top === undefined` check - every other exit returns directly, so the stack is already empty here.
        return stack;
    }

    // Walks a major arcana card's power-step list from a fresh use/play activation, tracking the growing minion set and the runtime opts each shortcut card needs.
    private applyMajorPower(def: MajorArcanaDef, eligible: IMinionRef[], steps: IStep[], partial: boolean, asUid?: string, asSuit?: string): IPowerFrame[] | undefined {
        const stack: IPowerFrame[] = [{ cardUid: def.uid, nextStepIndex: 0, minions: [...eligible] }];
        return this.walkFrameStack(stack, steps, partial, asUid, asSuit);
    }

    // True when `stack`'s top frame's NEXT step is special:"fool" - decides whether a bare 0-segment seed should be left alone or walked straight into the auto-resolving Fool step.
    private topStepIsFool(stack: readonly IPowerFrame[]): boolean {
        const top = stack[stack.length - 1];
        if (top === undefined) {
            return false;
        }
        const step = this.resolveFrameDef(top.cardUid).powers[top.nextStepIndex];
        return step !== undefined && "special" in step && step.special === "fool";
    }

    // Like topStepIsFool, but for The World's worldUseAny step, which also auto-resolves from no segment of its own (the borrowed card is named "as <uid>" in the head).
    private topStepIsWorld(stack: readonly IPowerFrame[]): boolean {
        const top = stack[stack.length - 1];
        if (top === undefined) {
            return false;
        }
        const step = this.resolveFrameDef(top.cardUid).powers[top.nextStepIndex];
        return step !== undefined && "special" in step && step.special === "worldUseAny";
    }

    // The frame stack for a resumed turn is: the persisted Fool/HP obligation(s), plus (via Fool) a fresh frame for the drawn card.
    private resumeQueue(): IPowerFrame[] | undefined {
        const pending = this.buildPendingFromContinued();
        return pending?.stack.map(f => ({ ...f, minions: [...f.minions] }));
    }

    // The step segments the frame-walk should see for a resume: decline/discard/"anything else".
    private resumeStepSegments(parsed: IParsedMove): string[][] {
        if (parsed.head === "decline") {
            return [["decline"]];
        }
        if (parsed.head === "discard" && parsed.viaUid !== undefined) {
            const step = parsed.steps[0];
            if (step?.cardList === undefined && step?.amount === undefined) {
                return [];
            }
            // Mirrors pickleMove's own "discard" token order exactly.
            const tokens = ["discard", ...(step.cardList ?? []), ...(step.amount !== undefined ? ["draw", step.amount.toString()] : [])];
            return [tokens];
        }
        return parsed.stepSegments;
    }

    // The IStep-based twin of resumeStepSegments above; the "discard" resume is already a real, fully-parsed IStep at parsed.steps[0] - no synthetic reconstruction needed.
    private resumeSteps(parsed: IParsedMove): IStep[] {
        if (parsed.head === "decline") {
            return [{ action: "decline" }];
        }
        if (parsed.head === "discard" && parsed.viaUid !== undefined) {
            const step = parsed.steps[0];
            return step?.cardList !== undefined || step?.amount !== undefined ? [step] : [];
        }
        return parsed.steps.slice(1);
    }

    private resumePendingPower(steps: IStep[], partial: boolean, asUid?: string, asSuit?: string): IPowerFrame[] | undefined {
        const stack = this.resumeQueue();
        if (stack === undefined) {
            return undefined;
        }
        const worldSeed = asUid !== undefined && this.topStepIsWorld(stack);
        if (steps.length === 0 && !this.topStepIsFool(stack) && !worldSeed) {
            // A bare resume seed, no step typed yet - nothing to process. Fool's step and a known World borrow are exempt, both auto-resolving regardless of segment count.
            return undefined;
        }
        return this.walkFrameStack(stack, steps, partial, asUid, asSuit);
    }

    // Read-only counterpart to walkFrameStack; Fool's step is checked regardless of the segment cursor `i`, and validation always stops right at a forced-pause step, exactly once.
    private validateFrameStack(stack: IPowerFrame[], steps: IStep[], rootCardUid: string, asUid?: string, asSuit?: string): IValidationResult {
        let clone: GnosticaGame | undefined;
        let i = 0;
        // True exactly when the frame just popped to expose the current top was a real Decline, not a silently-skipped one; set before "decline" continue, read at the top of the next iteration.
        let justDeclined = false;
        // Set once High Priestess's final round completes without a forcePause; read only at the `top === undefined` exit below.
        let hpFinalRoundReady: { key: string; params?: Record<string, unknown> } | undefined;
        // True right after a High Priestess step succeeds WITHOUT an explicit "draw <n>" - takes priority over the "ready to submit" framing below.
        let hpDrawNotChosen = false;
        // True right after a step whose outcome is still soft (Cups "own" creation's still-prepopulated facing) - same "last step wins" convention as hpDrawNotChosen.
        let softComplete = false;
        // Set once Moon's own move step genuinely needed its capacity exemption (destination was already at 3); cleared once the attack step destroys a piece there, restoring it.
        let moonRestoreCell: { x: number; y: number } | undefined;
        for (;;) {
            const top = stack[stack.length - 1];
            const poppedViaDecline = justDeclined;
            justDeclined = false;
            if (top === undefined) {
                if (i < steps.length) {
                    return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "TOO_MANY_POWER_STEPS" });
                }
                if (hpDrawNotChosen) {
                    return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.DISCARD_DRAW_REQUIRED") };
                }
                if (softComplete) {
                    return { valid: true, complete: 0, message: i18next.t("apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT") };
                }
                if (hpFinalRoundReady !== undefined) {
                    return { valid: true, complete: 1, message: i18next.t(hpFinalRoundReady.key, hpFinalRoundReady.params) };
                }
                return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
            }
            const frameDef = this.resolveFrameDef(top.cardUid);
            const stepIndex = top.nextStepIndex;
            const step = frameDef.powers[stepIndex];
            const kind = GnosticaGame.classifyStep(step, steps, i);
            // Mirrors walkFrameStack's identical computation - the ROOT's own untouched first flip is the one case that stays a hard rejection.
            const isFreshRootFool = kind === "fool" && stack.length === 1 && top.cardUid === rootCardUid && top.nextStepIndex === 0;
            if (kind === "decline") {
                i++;
                GnosticaGame.popFrame(stack);
                // Popping can expose an already-exhausted buried frame (e.g. World's own spent frame), which a later segment must not be validated against.
                GnosticaGame.popExhaustedFrames(this, stack);
                if (i < steps.length) {
                    clone ??= this.cloneLive();
                }
                justDeclined = true;
                continue;
            }
            let istep: IStep | undefined;
            // See walkFrameStack's own matching `borrowedForThisStep`.
            let borrowedForStep: string | undefined;
            if (kind === "world") {
                borrowedForStep = asUid; // the borrowed card is named "as <uid>" in the head
            } else if (kind === "fool") {
                // the flip consumes no segment
            } else {
                if (i >= steps.length) {
                    // Nothing more given - a step past the frame's own first stays optional and is silently skipped, UNLESS provably impossible right now (no legal target at all).
                    if (this.specialStepHasNoLegalTarget(clone ?? this, step, top.minions)) {
                        const cardName = this.cardNameOrUid(top.cardUid);
                        const key = (step as { special: SpecialPower }).special === "tradeHands"
                            ? "apgames:validation.gnostica.TRADEHANDS_SKIPPED_NO_TARGET"
                            : "apgames:validation.gnostica.HIEROPHANT_SKIPPED_NO_TARGET";
                        // This step being doomed says nothing about whether an EARLIER step's own outcome is still soft - respected here, not overridden by the generic complete:1 fallback.
                        return { valid: true, complete: softComplete ? 0 : 1, message: i18next.t(key, { card: cardName }) };
                    }
                    // A frame's OWN first step (nextStepIndex 0) arriving with nothing supplied is reachable ONLY via World's push (Fool's own push always forcePauses) - #49 forbids a no-op completion here.
                    if (stack.length > 1 && top.nextStepIndex === 0) {
                        const msg = this.freshStepMessage(top.cardUid, top.nextStepIndex, top.minions);
                        return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
                    }
                    // Moon's own move step genuinely pushed a territory over capacity - its own attack step is no longer optional, since skipping it would leave that territory illegally over-full.
                    if (moonRestoreCell !== undefined) {
                        return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.MOON_MUST_RESTORE_CAPACITY") };
                    }
                    // Frame not exhausted: a further step is still optional, so complete:0.
                    return {
                        valid: true,
                        complete: 0,
                        message: i18next.t("apgames:validation._general.VALID_MOVE"),
                    };
                }
                if ("special" in step && step.special === "magicianChoice") {
                    borrowedForStep = asSuit;
                    if (borrowedForStep === undefined) {
                        return this.invalid("apgames:validation.gnostica.MAGICIAN_NEEDS_AS");
                    }
                }
                istep = steps[i];
                i++;
            }
            const stepResult = (clone ?? this).validatePowerStep(step, top.minions, istep, frameDef, stepIndex, frameDef.powers.length, isFreshRootFool, borrowedForStep);
            if (stepResult.failed) {
                return stepResult.result;
            }
            if (stepResult.complete === false) {
                if (i >= steps.length) {
                    if (this.isMinionCellStillNarrowing(istep!.withPiece!, top.minions)) {
                        return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_MINION_BUTTON") };
                    }
                    // orientAny/hierophantReplace's own target is already chosen but its facing isn't yet - name the real next click, not the generic "pick a target" wording.
                    if ("special" in step && (step.special === "orientAny" || step.special === "hierophantReplace") && istep?.targetPiece !== undefined) {
                        return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT") };
                    }
                    const override = "primitive" in step && istep !== undefined ? this.primitiveIncompleteMessage(this.primitiveToSuit(step.primitive), istep) : undefined;
                    const msg = override ?? this.powerStepMessageKey(top.cardUid, top.nextStepIndex, top.minions);
                    return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
                }
                // An earlier segment being incomplete means a later one couldn't legitimately exist - defensive, shouldn't fire.
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP" });
            }
            if (stepResult.outcome?.forcePause === true) {
                // A forced-pause step can never legally be followed by more segments - the player couldn't have known what to put there (Fool's flip is hidden).
                if (i < steps.length) {
                    return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "STEPS_AFTER_FORCED_PAUSE" });
                }
                // The move is already complete, but submitting will ALSO trigger this step's own hidden continuation; named via forcePauseReadyMessage, not the generic VALID_MOVE fallback.
                if (poppedViaDecline && top.cardUid === "00") {
                    // softComplete (an earlier step's own state) still has to win here too.
                    return { valid: true, complete: softComplete ? 0 : 1, message: i18next.t("apgames:validation.gnostica.DECLINE_THEN_AUTO_DRAW") };
                }
                // High Priestess's round 1 forces this same pause, but with no explicit "draw <n>" given, the round is never complete - "ready to submit" would be wrong here.
                if ("special" in step && step.special === "highPriestess" && istep?.amount === undefined) {
                    return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.DISCARD_DRAW_REQUIRED") };
                }
                const readyMsg = this.forcePauseReadyMessage(top.cardUid, top.nextStepIndex);
                return { valid: true, complete: softComplete ? 0 : 1, message: i18next.t(readyMsg.key, readyMsg.params) };
            }
            // Moon: the move step is only exempt from the capacity cap if it actually needed to be (destination already at 3); the attack step then must destroy a piece at that SAME cell to restore it.
            if (frameDef.moonCapacityExemption && "primitive" in step) {
                if (step.primitive === "move" && stepResult.outcome?.movedToCell !== undefined) {
                    const cell = stepResult.outcome.movedToCell;
                    if (((clone ?? this).board.get(cell.x, cell.y)?.pieces.length ?? 0) >= 3) {
                        moonRestoreCell = cell;
                    }
                } else if (step.primitive === "attack" && moonRestoreCell !== undefined) {
                    const destroyed = stepResult.outcome?.destroyedAtCell;
                    if (destroyed !== undefined && destroyed.x === moonRestoreCell.x && destroyed.y === moonRestoreCell.y) {
                        moonRestoreCell = undefined;
                    } else {
                        return this.invalid("apgames:validation.gnostica.MOON_MUST_RESTORE_CAPACITY");
                    }
                }
            }
            // Captured BEFORE chainMinion updates top.minions - the replay call further down re-runs this step onto `clone` and needs the SAME pool validatePowerStep just used.
            const minionsForReplay = top.minions;
            top.minions = GnosticaGame.chainMinion(top.minions, stepResult.outcome ?? {});
            top.nextStepIndex++;
            if ("special" in step && step.special === "highPriestess" && top.nextStepIndex >= frameDef.powers.length) {
                hpFinalRoundReady = this.forcePauseReadyMessage(top.cardUid, stepIndex);
            }
            hpDrawNotChosen = "special" in step && step.special === "highPriestess" && istep?.amount === undefined;
            softComplete = stepResult.outcome?.softComplete === true;
            if (stepResult.outcome?.pushFrame !== undefined) {
                stack.push({ cardUid: stepResult.outcome.pushFrame.cardUid, nextStepIndex: 0, minions: stepResult.outcome.pushFrame.minions, viaFool: stepResult.outcome.pushFrame.viaFool === true });
            }
            GnosticaGame.popExhaustedFrames(this, stack);
            if (i < steps.length || stack.length > 0) {
                clone ??= this.cloneLive();
                clone.applyPowerStep(step, minionsForReplay, istep, frameDef, stepIndex, frameDef.powers.length, true, borrowedForStep);
            }
        }
    }

    public validateMajorPower(def: MajorArcanaDef, eligible: IMinionRef[], steps: IStep[], asUid?: string, asSuit?: string): IValidationResult {
        // #49: a use/play must take at least one meaningful step - the SAME commitment every pushed frame owes too, just enforced at different call sites (see validateFrameStack/validateResumePendingPower).
        const stack: IPowerFrame[] = [{ cardUid: def.uid, nextStepIndex: 0, minions: [...eligible] }];
        // A World borrow with nothing else typed still has a real step to choose (falls through to the walk); a Magician borrow pushes no frame, so it wants the same fresh-step wording.
        const worldBorrow = asUid !== undefined;
        if (steps.length === 0 && !this.topStepIsFool(stack) && !worldBorrow) {
            const msg = this.freshStepMessage(def.uid, 0, eligible);
            return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
        }
        return this.validateFrameStack(stack, steps, def.uid, asUid, asSuit);
    }

    // Mirrors resumePendingPower's own dispatch, read-only; checks the card a "play" resume names (must be what the last flip left on top of discard), then walks the segments for legality.
    private validateResumePendingPower(parsed: IParsedMove): IValidationResult {
        const queue = this.resumeQueue()!;
        if (parsed.head === "play" && parsed.steps[0]?.card !== undefined && parsed.steps[0].card !== queue[queue.length - 1].cardUid) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "BAD_CARD"});
        }
        const steps = this.resumeSteps(parsed);
        const worldBorrow = parsed.asUid !== undefined;
        if (steps.length === 0 && !this.topStepIsFool(queue) && !worldBorrow) {
            // Same bare seed as resumePendingPower - valid but incomplete, matching the "still building" complete:-1 pattern; Fool's step is exempt.
            const activeTop = queue[queue.length - 1];
            const msg = this.freshStepMessage(activeTop.cardUid, activeTop.nextStepIndex, activeTop.minions);
            return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
        }
        return this.validateFrameStack(queue, steps, this.getContinuedUid()!, parsed.asUid, parsed.asSuit);
    }

    // "primitive" steps expect <minionRef> <mode> <args...> (same grammar as minor arcana); "special" steps have their own bespoke shapes. High Priestess alone has no minion reference at all.
    public applyPowerStep(
        step: PowerStep, minions: IMinionRef[], istep: IStep | undefined, def: MajorArcanaDef, stepIndex: number, totalSteps: number, partial: boolean,
        borrowedPower?: string,
    ): IStepOutcome | undefined {
        if ("special" in step && step.special === "worldUseAny") {
            // The borrowed card is named "as <uid>" in the head, never a step segment - this step takes no minion of its own and just hands off to that card's frame.
            if (borrowedPower === undefined) {
                return undefined;
            }
            const borrowedDef = worldChoosePower(this.buildPowerContext(), borrowedPower);
            this.results.push({ type: "use", what: borrowedPower, count: 21 });
            return { pushFrame: { cardUid: borrowedDef.uid, minions } };
        }
        if ("special" in step && step.special === "highPriestess") {
            this.applyHighPriestess(istep, partial);
            // Pause only if a LATER sibling step of THIS SAME card depends on this one's outcome.
            return { forcePause: stepIndex + 1 < totalSteps };
        }
        if ("special" in step && step.special === "fool") {
            // Fool's drawn card is hidden information.
            if (partial) {
                return { forcePause: true };
            }
            const failure = checkFool(this.buildPowerContext());
            if (failure) {
                // Validation stops a real player from getting here in the first place, so the Fool is complete.
                return {};
            }
            const revealed = fool(this.buildPowerContext());
            this.results.push({ type: "deckDraw", what: revealed.uid, from: "fool" });
            // Unlike High Priestess, EVERY draw forces a pause, regardless of whether Fool has another draw left.
            return { pushFrame: { cardUid: revealed.uid, minions, viaFool: true }, forcePause: true };
        }
        const minionRef = istep!.withPiece!;
        if (this.isMinionCellStillNarrowing(minionRef, minions)) {
            return undefined; // cell chosen, which minion there is still undecided - still skipped
        }
        const minion = this.resolvePieceRefTrusted(minionRef, minions);
        if ("primitive" in step) {
            const suitUid = step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S";
            // "Still building" vs "ready to act on" is answered by stepShapes.ts's own shared check.
            const shape = primitiveStepShape(suitUid, istep!);
            if (shape.status === "incomplete") {
                return undefined; // still skipped so far
            }
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts);
            return this.applySuitPrimitive(suitUid, minion, istep!, opts);
        }
        if (step.special === "magicianChoice") {
            // Magician's suit is named with "as <suit>".
            const suitLetter = borrowedPower!;
            const shape = primitiveStepShape(suitLetter, istep!);
            if (shape.status === "incomplete") {
                return undefined; // still skipped so far
            }
            return this.applySuitPrimitive(suitLetter, minion, istep!, {});
        }
        const shape = SPECIAL_STEP_SHAPES[step.special](istep!);
        if (shape.status === "incomplete") {
            return undefined; // still skipped so far
        }
        // Every apply* method below can now assume complete, well-formed input after the shape check above.
        switch (step.special) {
            case "orientMinion":
                return this.applyOrientMinion(minion, istep!);
            case "orientAny":
                return this.applyOrientAny(minion, istep!);
            case "hierophantReplace":
                return this.applyHierophantReplace(minion, istep!);
            case "hermitTeleport":
                return this.applyHermitStep(minion, istep!);
            case "tradeHands":
                return this.applyTradeHands(minion, istep!);
            case "judgementDraw":
                this.applyJudgementDraw(minion, istep!);
                // A real (if empty) outcome, is not marked undefined.
                return {};
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "SPECIAL_NOT_FOUND" }));
        }
    }

    // Mirrors applyPowerStep's own "incomplete step, still skipped" tolerance.
    public validatePowerStep(
        step: PowerStep, minions: IMinionRef[], istep: IStep | undefined, def: MajorArcanaDef, stepIndex: number, totalSteps: number,
        isFreshRootFool = false, borrowedPower?: string,
    ): StepValidation {
        if ("special" in step && step.special === "worldUseAny") {
            if (borrowedPower === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "WORLD_BORROW_REQUIRED" }) };
            }
            const worldResult = this.validateWorldChoosePower(borrowedPower);
            if (!worldResult.valid) {
                return { failed: true, result: worldResult };
            }
            return { failed: false, outcome: { pushFrame: { cardUid: borrowedPower, minions } } };
        }
        if ("special" in step && step.special === "highPriestess") {
            const hpResult = this.validateHighPriestess(istep);
            if (!hpResult.valid) {
                return { failed: true, result: hpResult };
            }
            return { failed: false, outcome: { forcePause: stepIndex + 1 < totalSteps } };
        }
        if ("special" in step && step.special === "fool") {
            const failure = checkFool(this.buildPowerContext());
            if (failure) {
                if (isFreshRootFool) {
                    // The ROOT Fool card's own untouched first flip stays a hard rejection.
                    return { failed: true, result: this.failureResult(failure) };
                }
                // Anywhere else, gracefully complete instead - no outcome fields at all, since there's nothing left to reveal.
                return { failed: false };
            }
            // Can't know what gets pushed without actually flipping - forcePause alone stops validateFrameStack from accepting further segments.
            return { failed: false, outcome: { forcePause: true } };
        }
        const minionRef = istep!.withPiece;
        if (minionRef === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" }) };
        }
        if (this.isMinionCellStillNarrowing(minionRef, minions)) {
            return { failed: false, complete: false }; // cell chosen, which minion there is still undecided - still skipped
        }
        const result = this.resolvePieceRef(minionRef, minions);
        if (result.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(result.kind, minionRef, "NOT_AN_ELIGIBLE_MINION") };
        }
        const minion = result.ref;
        if ("primitive" in step) {
            const suitUid = step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S";
            // Same shared shape check applyPowerStep uses, asked directly and independently - this function never calls into applyPowerStep for it.
            const shape = primitiveStepShape(suitUid, istep!);
            if (shape.status === "incomplete") {
                return { failed: false, complete: false };
            }
            if (shape.status === "malformed") {
                return { failed: true, result: this.invalid(`apgames:validation.gnostica.${shape.key}`, shape.params) };
            }
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts);
            return this.validateSuitPrimitive(suitUid, minion, istep!, opts);
        }
        if (step.special === "magicianChoice") {
            // The suit is always `borrowedPower` now.
            const suitLetter = borrowedPower!;
            const shape = primitiveStepShape(suitLetter, istep!);
            if (shape.status === "incomplete") {
                return { failed: false, complete: false };
            }
            if (shape.status === "malformed") {
                return { failed: true, result: this.invalid(`apgames:validation.gnostica.${shape.key}`, shape.params) };
            }
            return this.validateSuitPrimitive(suitLetter, minion, istep!, {});
        }
        const shape = SPECIAL_STEP_SHAPES[step.special](istep!);
        if (shape.status === "incomplete") {
            return { failed: false, complete: false };
        }
        if (shape.status === "malformed") {
            return { failed: true, result: this.invalid(`apgames:validation.gnostica.${shape.key}`, shape.params) };
        }
        // Every validate* method below can now assume complete, well-formed input - the shape check above already ruled out anything else.
        switch (step.special) {
            case "orientMinion":
                return this.validateOrientMinion(minion, istep!);
            case "orientAny":
                return this.validateOrientAny(minion, istep!);
            case "hierophantReplace":
                return this.validateHierophantReplace(minion, istep!);
            case "hermitTeleport":
                return this.validateHermitStep(minion, istep!);
            case "tradeHands":
                return this.validateTradeHands(minion, istep!);
            case "judgementDraw": {
                const jResult = this.validateJudgementDraw(minion, istep!);
                return jResult.valid ? { failed: false } : { failed: true, result: jResult };
            }
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "SPECIAL_NOT_FOUND" }) };
        }
    }

    // Derives the runtime relaxation opts a same-target-shortcut/Moon card's step needs, WITHOUT verifying the two steps share a target - deliberately simplified since it only ever widens legality.
    public computeShortcutOpts(
        def: MajorArcanaDef, primitive: SuitPrimitive,
        stepIndex: number, totalSteps: number, staticOpts: object | undefined,
    ): Record<string, unknown> {
        const opts: Record<string, unknown> = { ...staticOpts };
        if (def.sameTargetShortcut) {
            if (primitive === "grow") {
                opts.skipLadder = true;
                // Strength's own shortcut: a non-final grow step's resulting size is only transient, restored to its final size by the step after.
                if (stepIndex < totalSteps - 1) {
                    opts.skipStashCheck = true;
                }
                // Strength/Sun: a step past the first is growing a piece whose OWN current size was itself never really taken (the step before skipped it) - returning it now would over-credit the stash.
                if (stepIndex > 0) {
                    opts.skipStashReturn = true;
                }
            } else if (primitive === "attack") {
                // Death's own shortcut: a non-final attack step's resulting size is only transient, shrunk further by the step after.
                if (stepIndex < totalSteps - 1) {
                    opts.skipStashCheck = true;
                }
                // Death: a step past the first is shrinking a piece whose OWN current size was itself never really taken (the step before skipped it) - returning it now would over-credit the stash.
                if (stepIndex > 0) {
                    opts.skipStashReturn = true;
                }
            } else if (primitive === "move" && stepIndex < totalSteps - 1) {
                opts.skipLandingCheck = true;
            } else if (primitive === "create" && stepIndex < totalSteps - 1) {
                // Sun's own shortcut: the created piece's initial size-1 form is only transient, grown to its final size by the step after.
                opts.skipStashCheck = true;
            }
        }
        if (def.moonCapacityExemption && primitive === "move" && stepIndex === 0 && totalSteps >= 2) {
            opts.ignoreCapacity = true;
        }
        return opts;
    }

    private applySuitPrimitive(suitUid: string, minion: IMinionRef, step: IStep, opts: Record<string, unknown>): IStepOutcome {
        const mode = stepMinorMode(suitUid, step)!;
        switch (suitUid) {
            case "C":
                return this.applyCups(minion, mode, step, opts);
            case "R":
                return this.applyRods(minion, mode, step, opts);
            case "D":
                return this.applyDiscs(minion, mode, step, opts);
            case "S":
                return this.applySwords(minion, mode, step, opts);
            default:
                throw new Error(`Unknown suit uid "${suitUid}".`);
        }
    }

    public validateSuitPrimitive(suitUid: string, minion: IMinionRef, step: IStep, opts: Record<string, unknown>): StepValidation {
        const mode = stepMinorMode(suitUid, step)!;
        switch (suitUid) {
            case "C":
                return this.validateCups(minion, mode, step, opts);
            case "R":
                return this.validateRods(minion, mode, step, opts);
            case "D":
                return this.validateDiscs(minion, mode, step, opts);
            case "S":
                return this.validateSwords(minion, mode, step, opts);
            default:
                return { failed: true, result: this.invalid("apgames:validation._general.DEFAULT_HANDLER") };
        }
    }

    // Cups - own <cell> <orientation> | enemy <cell> <victimRef> | new <cell> (<uid>|random)
    private applyCups(minion: IMinionRef, mode: string, step: IStep, opts: Record<string, unknown> = {}): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "own": {
                // The creation's mandatory initial facing, possibly still carrying a trailing "?" - makes no difference to the piece created, so it's stripped the same way cmdPlace strips its own.
                const cellStr = step.atCell!;
                const orientationToken = step.direction!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
                const orientation = orientationStr as Orientation;
                createOwn(ctx, minion.x, minion.y, minion.index, tx, ty, orientation, opts);
                this.addBufferIfWasteland(tx, ty);
                this.results.push({ type: "place", where: cellStr, how: "cups-own" });
                const newIndex = this.board.get(tx, ty)!.pieces.length - 1;
                return { newMinion: { x: tx, y: ty, index: newIndex } };
            }
            case "enemy": {
                const cellStr = step.atCell!;
                const victimRef = step.targetPiece!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // victimRef is a full piece ref (#106) - validateCups already confirmed it names a piece at this cell, so its index is trusted directly.
                const { index: victimIndex } = this.resolvePieceRefTrusted(victimRef);
                const victimOwner = this.board.get(tx, ty)!.pieces[victimIndex].owner;
                createEnemy(ctx, minion.x, minion.y, minion.index, tx, ty, victimIndex, opts);
                this.results.push({ type: "place", where: cellStr, how: "cups-enemy", who: victimOwner });
                return {}; // the new piece belongs to the targeted enemy, not the acting player
            }
            case "new": {
                const cellStr = step.atCell!;
                const cardArg = step.card;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // "drawn" is parsed as step.amount === 1 (pickleMove's own sentinel, since step.card must always be a real card uid), and is only honored when THIS card's own step genuinely grants it (opts.allowRandomDraw), not just because the literal token was typed.
                if (step.amount === 1 && opts.allowRandomDraw) {
                    createTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, undefined, opts);
                } else {
                    createTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, cardArg, opts);
                }
                // Read the placed card back off the board rather than trusting cardArg directly - a "drawn" card isn't the literal token typed.
                this.results.push({ type: "place", where: cellStr, how: "territory", what: this.board.get(tx, ty)!.card!.uid });
                return {};
            }
            default:
                // Legality is validateCups's own job - primitiveStepShape already gated entry, so an unrecognized mode here is a bug upstream, not something to re-litigate.
                throw new Error(`Unknown Cups mode "${mode}".`);
        }
    }

    private validateCups(minion: IMinionRef, mode: string, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "own": {
                // A brand-new minion can't reasonably go unoriented - "U" is a real, always-legal choice, never auto-assigned but always REQUIRED as an explicit fact of creation.
                const cellStr = step.atCell!;
                const orientationToken = step.direction!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // A trailing "?" marks the mode button's own seeded default as not yet deliberate (mirrors validatePlace's identical convention) - stripped before resolving.
                // parseMove already guarantees a valid N/E/S/W/U (with or without "?"), so there's nothing left to validate here.
                const prepopulated = orientationToken.endsWith("?");
                const finalOrientation = (orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken) as Orientation;
                const failure = checkCreateOwn(ctx, minion.x, minion.y, minion.index, tx, ty, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                // The new piece is always pushed to the end - pre-mutation length here IS post-mutation index; the target cell may have no stored CellContents yet, so this ref carries its own piece data.
                const newIndex = this.board.get(tx, ty)?.pieces.length ?? 0;
                return { failed: false, outcome: { newMinion: { x: tx, y: ty, index: newIndex, piece: new Piece(this.currplayer, 1, finalOrientation) }, softComplete: prepopulated } };
            }
            case "enemy": {
                const cellStr = step.atCell!;
                const victimRef = step.targetPiece!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // victimRef is a full piece ref (#106), resolved board-wide, but Cups can only act on the SAME cell "at <cell>" already named - a ref elsewhere is rejected as "no victim there".
                const victimResult = this.resolvePieceRef(victimRef);
                if (victimResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(victimResult.kind, victimRef) };
                }
                if (victimResult.ref.x !== tx || victimResult.ref.y !== ty) {
                    return { failed: true, result: this.failureResult({ key: "NO_VICTIM_THERE" }) };
                }
                const failure = checkCreateEnemy(ctx, minion.x, minion.y, minion.index, tx, ty, victimResult.ref.index, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false }; // the new piece belongs to the targeted enemy, not the acting player
            }
            case "new": {
                const cellStr = step.atCell!;
                const cardArg = step.card;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // Mirrors applyCups's own "new" case - "drawn" is parsed as step.amount === 1, and only honored when opts.allowRandomDraw is genuinely set for THIS card's step.
                const failure = step.amount === 1 && opts.allowRandomDraw
                    ? checkCreateTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, undefined, opts)
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
    private applyRods(minion: IMinionRef, mode: string, step: IStep, opts: Record<string, unknown> = {}): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const dist = step.amount!;
                const orientationStr = step.direction;
                const target = this.resolvePieceRefTrusted(targetRef);
                const newOrientation = orientationStr as Orientation | undefined;
                // Captured before the move mutates the board, to compute where the piece ends up for the log and minion-chaining check.
                const movedOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
                const facing = (minion.piece ?? this.board.get(minion.x, minion.y)!.pieces[minion.index]).orientation;
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "U">);
                const destX = target.x + dx * dist;
                const destY = target.y + dy * dist;
                // A genuine final landing (not a Chariot-relaxed waypoint) in the void destroys the piece instead of moving it.
                const destroyedInVoid = opts.skipLandingCheck !== true && this.board.classify(destX, destY) === "void";
                const origin = GnosticaBoard.coords2algebraic(target.x, target.y);
                movePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, dist, newOrientation, opts);
                if (destroyedInVoid) {
                    this.results.push({ type: "destroy", where: origin, what: this.getPipsFromRef(targetRef), who: movedOwner });
                    // Still a real removeAt at target's old slot.  replacesMinion is reported even with no newMinion.
                    return { replacesMinion: { x: target.x, y: target.y, index: target.index } };
                }
                const dest = GnosticaBoard.coords2algebraic(destX, destY);
                this.results.push({ type: "move", from: origin, to: dest, what: this.getPipsFromRef(targetRef), how: "rod-piece", who: movedOwner });
                if (movedOwner === this.currplayer) {
                    const landed = this.board.get(destX, destY)!.pieces;
                    const newIndex = landed.length - 1;
                    return { newMinion: { x: destX, y: destY, index: newIndex, piece: landed[newIndex] }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
                }
                return { replacesMinion: { x: target.x, y: target.y, index: target.index } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const dist = step.amount!;
                const [srcX, srcY] = GnosticaBoard.algebraic2coords(cellStr);
                const facing = (minion.piece ?? this.board.get(minion.x, minion.y)!.pieces[minion.index]).orientation;
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "U">);
                moveTerritory(ctx, minion.x, minion.y, minion.index, srcX, srcY, dist);
                const to = GnosticaBoard.coords2algebraic(srcX + dx * dist, srcY + dy * dist);
                this.results.push({ type: "move", from: cellStr, to, how: "rod-tile" });
                return {};
            }
            default:
                // Not reachable.
                throw new Error(`Unknown Rods mode "${mode}".`);
        }
    }

    private validateRods(minion: IMinionRef, mode: string, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const dist = step.amount!;
                const orientationStr = step.direction;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const targetPiece = target.piece ?? this.board.get(target.x, target.y)!.pieces[target.index];
                // Unlike orient/orientMinion/orientAny, this facing is only an OPTIONAL addition to an already-meaningful move, so a same-facing correction isn't a no-op.
                // parseMove now rejects a non-single-letter direction here too (AMBIGUOUS_DIRECTION), so this is always a real N/E/S/W/U (or absent) by now.
                const orientation = (orientationStr as Orientation | undefined) ?? targetPiece.orientation;
                const failure = checkMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, dist, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                const facing = (minion.piece ?? this.board.get(minion.x, minion.y)!.pieces[minion.index]).orientation;
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "U">);
                const destX = target.x + dx * dist;
                const destY = target.y + dy * dist;
                const destroyedInVoid = opts.skipLandingCheck !== true && this.board.classify(destX, destY) === "void";
                if (destroyedInVoid) {
                    // Destroyed in the void - still a real removeAt at target's old slot, so chainMinion still needs to know.
                    return { failed: false, outcome: { replacesMinion: { x: target.x, y: target.y, index: target.index } } };
                }
                if (targetPiece.owner === this.currplayer) {
                    // The destination may not have a stored CellContents yet, so this ref carries its own piece data rather than relying on a later board read.
                    const newIndex = this.board.get(destX, destY)?.pieces.length ?? 0;
                    const newPiece = new Piece(targetPiece.owner, targetPiece.size, orientation);
                    return { failed: false, outcome: { newMinion: { x: destX, y: destY, index: newIndex, piece: newPiece }, replacesMinion: { x: target.x, y: target.y, index: target.index }, softComplete: orientationStr === undefined, movedToCell: { x: destX, y: destY } } };
                }
                // Moved an enemy's own piece - not tracked in this pool, but still a real removeAt at target's old slot.
                return { failed: false, outcome: { replacesMinion: { x: target.x, y: target.y, index: target.index }, movedToCell: { x: destX, y: destY } } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const dist = step.amount!;
                const [srcX, srcY] = GnosticaBoard.algebraic2coords(cellStr);
                const failure = checkMoveTerritory(ctx, minion.x, minion.y, minion.index, srcX, srcY, dist);
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
    private applyDiscs(minion: IMinionRef, mode: string, step: IStep, opts: Record<string, unknown> = {}): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const orientationStr = step.direction;
                const target = this.resolvePieceRefTrusted(targetRef);
                const newOrientation = orientationStr as Orientation | undefined;
                const targetPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                const owner = targetPiece.owner;
                const beforeSize = targetPiece.size;
                growPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, newOrientation, opts);
                this.results.push({ type: "convert", what: `size ${beforeSize}`, into: `size ${beforeSize + 1}`, where: GnosticaBoard.coords2algebraic(target.x, target.y), who: owner });
                if (owner === this.currplayer) {
                    const grown = this.board.get(target.x, target.y)!.pieces;
                    const newIndex = grown.length - 1;
                    return { newMinion: { x: target.x, y: target.y, index: newIndex, piece: grown[newIndex] }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
                }
                // Grown into a piece this pool doesn't track (an enemy's) - still a real removeAt at target's old slot, so chainMinion still needs to know.
                return { replacesMinion: { x: target.x, y: target.y, index: target.index } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const beforeUid = this.board.get(tx, ty)!.card!.uid;
                growTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, newCardUid, opts);
                this.results.push({ type: "convert", what: beforeUid, into: newCardUid, where: cellStr });
                return {};
            }
            default:
                // See applyCups's own matching comment - validateDiscs owns this legality, not this function.
                throw new Error(`Unknown Discs mode "${mode}".`);
        }
    }

    private validateDiscs(minion: IMinionRef, mode: string, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const orientationStr = step.direction;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const targetPiece = target.piece ?? this.board.get(target.x, target.y)!.pieces[target.index];
                // This facing is an optional addition to an already-meaningful step, not the whole action, so a same-facing correction isn't a no-op worth rejecting.
                // parseMove now rejects a non-single-letter direction here too (AMBIGUOUS_DIRECTION), so this is always a real N/E/S/W/U (or absent) by now.
                const orientation = (orientationStr as Orientation | undefined) ?? targetPiece.orientation;
                const failure = checkGrowPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                if (targetPiece.owner === this.currplayer) {
                    // Growing replaces the piece in place - net piece count at this cell is unchanged, so the pre- and post-mutation "last index" are the same value.
                    const newIndex = (this.board.get(target.x, target.y)?.pieces.length ?? 1) - 1;
                    const grownPiece = new Piece(targetPiece.owner, (targetPiece.size + 1) as Pips, orientation);
                    return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex, piece: grownPiece }, replacesMinion: { x: target.x, y: target.y, index: target.index }, softComplete: orientationStr === undefined } };
                }
                // Grown into a piece this pool doesn't track (an enemy's) - still a real removeAt at target's old slot, so chainMinion still needs to know.
                return { failed: false, outcome: { replacesMinion: { x: target.x, y: target.y, index: target.index } } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
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
    private applySwords(minion: IMinionRef, mode: string, step: IStep, opts: Record<string, unknown> = {}): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const pips = step.amount!;
                const orientationStr = step.direction;
                const target = this.resolvePieceRefTrusted(targetRef);
                const newOrientation = orientationStr as Orientation | undefined;
                const targetPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                const owner = targetPiece.owner;
                const beforeSize = targetPiece.size;
                attackPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, pips, newOrientation, opts);
                const resultSize = beforeSize - pips;
                const where = GnosticaBoard.coords2algebraic(target.x, target.y);
                if (resultSize === 0) {
                    this.results.push({ type: "destroy", where, what: this.getPipsFromRef(targetRef), who: owner });
                } else {
                    this.results.push({ type: "convert", what: `size ${beforeSize}`, into: `size ${resultSize}`, where, who: owner });
                }
                if (resultSize > 0 && owner === this.currplayer) {
                    const shrunk = this.board.get(target.x, target.y)!.pieces;
                    const newIndex = shrunk.length - 1;
                    return { newMinion: { x: target.x, y: target.y, index: newIndex, piece: shrunk[newIndex] }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
                }
                // Destroyed outright, or shrunk but not into a piece this pool tracks (an enemy's) - still a real removeAt at target's old slot, so chainMinion still needs to know.
                return { replacesMinion: { x: target.x, y: target.y, index: target.index } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const pips = step.amount!;
                const newCardUid = step.card;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const beforeUid = this.board.get(tx, ty)!.card!.uid;
                attackTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, pips, newCardUid, opts);
                // A replacement card means the territory survived, shrunk; only a true wipeout (no replacement) is a "destroy".
                if (newCardUid === undefined) {
                    this.results.push({ type: "destroy", where: cellStr, what: beforeUid });
                } else {
                    this.results.push({ type: "convert", what: beforeUid, into: newCardUid, where: cellStr });
                }
                return {};
            }
            default:
                // See applyCups's own matching comment - validateSwords owns this legality, not this function.
                throw new Error(`Unknown Swords mode "${mode}".`);
        }
    }

    private validateSwords(minion: IMinionRef, mode: string, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const pips = step.amount!;
                const orientationStr = step.direction;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const targetPiece = target.piece ?? this.board.get(target.x, target.y)!.pieces[target.index];
                // This facing is an optional addition to an already-meaningful step, not the whole action, so a same-facing correction isn't a no-op worth rejecting.
                // parseMove now rejects a non-single-letter direction here too (AMBIGUOUS_DIRECTION), so this is always a real N/E/S/W/U (or absent) by now.
                const orientation = (orientationStr as Orientation | undefined) ?? targetPiece.orientation;
                const failure = checkAttackPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, pips, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                const owner = targetPiece.owner;
                const resultSize = targetPiece.size - pips;
                if (resultSize > 0 && owner === this.currplayer) {
                    // Shrinking replaces the piece in place, same net count as Discs' own grow above.
                    const newIndex = (this.board.get(target.x, target.y)?.pieces.length ?? 1) - 1;
                    const shrunkPiece = new Piece(owner, resultSize as Pips, orientation);
                    return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex, piece: shrunkPiece }, replacesMinion: { x: target.x, y: target.y, index: target.index }, softComplete: orientationStr === undefined } };
                }
                // Destroyed outright, or shrunk but not into a piece this pool tracks (an enemy's) - still a real removeAt at target's old slot.
                // A true destroy (not just a shrink into an untracked enemy piece) actually frees a slot at this cell - only that satisfies Moon's own capacity-restoration requirement.
                return { failed: false, outcome: { replacesMinion: { x: target.x, y: target.y, index: target.index }, destroyedAtCell: resultSize === 0 ? { x: target.x, y: target.y } : undefined } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const pips = step.amount!;
                const newCardUid = step.card;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
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

    // orientMinion: <minionRef> <newOrientation> - no targeting restriction, any current minion.
    private applyOrientMinion(minion: IMinionRef, step: IStep): IStepOutcome {
        const orientationStr = step.direction!;
        const orientation = orientationStr as Orientation;
        orientMinion(this.buildPowerContext(), minion.x, minion.y, minion.index, orientation);
        this.addBufferIfWasteland(minion.x, minion.y);
        this.pushOrientResult(minion.x, minion.y, minion.index, this.pieceRefStr(minion), orientation);
        return { newMinion: minion, replacesMinion: minion };
    }

    public validateOrientMinion(minion: IMinionRef, step: IStep): StepValidation {
        // parseMove already rejects a non-single-letter direction for the standalone "orient" action (AMBIGUOUS_DIRECTION), so this is always a real N/E/S/W/U by now.
        const orientation = step.direction! as Orientation;
        const failure = checkOrientMinion(this.buildPowerContext(), minion.x, minion.y, minion.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        // Same hard rejection as the standalone "orient" command's own ORIENT_NO_OP - reorienting IS the whole action here too, so a no-op achieves nothing.
        const currentPiece = minion.piece ?? this.board.get(minion.x, minion.y)!.pieces[minion.index];
        
        if (currentPiece.orientation === orientation) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.ORIENT_NO_OP") };
        }
        // Reorienting doesn't move the piece (same x,y,index) - only its facing changes, so predict that directly rather than reusing the pre-mutation `.piece`.
        const reoriented = new Piece(currentPiece.owner, currentPiece.size, orientation);
        const newMinion = { x: minion.x, y: minion.y, index: minion.index, piece: reoriented };
        return { failed: false, outcome: { newMinion, replacesMinion: minion } };
    }

    // orientAny (Devil only): <minionRef> orient <targetPieceRef> <newOrientation> - still subject to self/adjacent targeting, just without "must be your own piece".
    private applyOrientAny(minion: IMinionRef, step: IStep): IStepOutcome {
        const targetRef = step.targetPiece!;
        const orientationStr = step.direction!;
        const target = this.resolvePieceRefTrusted(targetRef);
        const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const orientation = orientationStr as Orientation;
        orientAny(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.addBufferIfWasteland(target.x, target.y);
        this.pushOrientResult(target.x, target.y, target.index, targetRef, orientation);
        return owner === this.currplayer ? { newMinion: target, replacesMinion: target } : {};
    }

    public validateOrientAny(minion: IMinionRef, step: IStep): StepValidation {
        const targetRef = step.targetPiece!;
        const orientationStr = step.direction!;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
        // parseMove already rejects a non-single-letter direction for the standalone "orient" action (AMBIGUOUS_DIRECTION), so this is always a real N/E/S/W/U by now.
        const orientation = orientationStr as Orientation;
        const failure = checkOrientAny(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        // reorienting the target IS the whole action here too, so a no-op is hard-rejected.
        const currentPiece = target.piece ?? this.board.get(target.x, target.y)!.pieces[target.index];

        if (currentPiece.orientation === orientation) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.ORIENT_NO_OP") };
        }
        if (currentPiece.owner !== this.currplayer) {
            return { failed: false };
        }
        const reoriented = new Piece(currentPiece.owner, currentPiece.size, orientation);
        const newMinion = { x: target.x, y: target.y, index: target.index, piece: reoriented };
        return { failed: false, outcome: { newMinion, replacesMinion: target } };
    }

    // Hierophant: <minionRef> <targetPieceRef> <seededFacing>["?"] [<reorientation>]
    private applyHierophantReplace(minion: IMinionRef, step: IStep): IStepOutcome {
        const targetRef = step.targetPiece!;
        const orientationToken = step.direction!;
        const target = this.resolvePieceRefTrusted(targetRef);
        // Captured before the replace mutates the board - the previous owner being displaced, for the result log.
        const previousOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
        const orientation = orientationStr as Orientation;
        hierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.addBufferIfWasteland(target.x, target.y);
        this.results.push({ type: "convert", what: this.getPipsFromRef(targetRef), into: `owner-${this.currplayer}`, where: GnosticaBoard.coords2algebraic(target.x, target.y), who: previousOwner });
        const replaced = this.board.get(target.x, target.y)!.pieces;
        const newIndex = replaced.length - 1;
        return { newMinion: { x: target.x, y: target.y, index: newIndex, piece: replaced[newIndex] }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
    }

    // Orientation is mandatory but without a no-op check. The default is the captured piece's prior orientation.
    public validateHierophantReplace(minion: IMinionRef, step: IStep): StepValidation {
        const targetRef = step.targetPiece!;
        const orientationToken = step.direction;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
        const targetPiece = target.piece ?? this.board.get(target.x, target.y)!.pieces[target.index];
        if (orientationToken === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationToken }) };
        }
        // A trailing "?" marks the click handler's own seeded default as not yet deliberate (mirrors validateCups' identical convention) - stripped before resolving.
        // parseMove already guarantees a valid N/E/S/W/U (with or without "?"), so there's nothing left to validate here.
        const prepopulated = orientationToken.endsWith("?");
        const orientation = (orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken) as Orientation;
        const failure = checkHierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        // Replace-in-place (removeAt then add) - net piece count at this cell is unchanged, so pre- and post-mutation "last index" match.
        const newIndex = (this.board.get(target.x, target.y)?.pieces.length ?? 1) - 1;
        const replacement = new Piece(this.currplayer, targetPiece.size, orientation);
        return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex, piece: replacement }, replacesMinion: { x: target.x, y: target.y, index: target.index }, softComplete: prepopulated } };
    }

    // Hermit - <minionRef> fly <targetPieceRef> to <destCell> [orient <direction>] | <minionRef> fly <cardUid> to <destCell>
    private applyHermitStep(minion: IMinionRef, step: IStep): IStepOutcome {
        const mode = stepHermitMode(step)!;
        const ctx = this.buildPowerContext();
        const destCellStr = step.targetCell!;
        if (mode === "piece") {
            const targetRef = step.targetPiece!;
            const target = this.resolvePieceRefTrusted(targetRef);
            const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
            const [destX, destY] = GnosticaBoard.algebraic2coords(destCellStr);
            const newOrientation = step.direction as Orientation | undefined;
            const origin = GnosticaBoard.coords2algebraic(target.x, target.y);
            hermitMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, destX, destY, newOrientation);
            this.results.push({ type: "move", from: origin, to: destCellStr, what: this.getPipsFromRef(targetRef), how: "hermit-piece", who: owner });
            if (owner === this.currplayer) {
                const newIndex = this.board.get(destX, destY)!.pieces.length - 1;
                return { newMinion: { x: destX, y: destY, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
            }
            return { replacesMinion: { x: target.x, y: target.y, index: target.index } };
        } else if (mode === "tile") {
            const { x: tx, y: ty } = this.resolveTileCard(step.card)!;
            const [destX, destY] = GnosticaBoard.algebraic2coords(destCellStr);
            hermitMoveTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, destX, destY);
            this.results.push({ type: "move", from: GnosticaBoard.coords2algebraic(tx, ty), to: destCellStr, how: "hermit-tile" });
            return {};
        }
        // See applyCups's own matching comment - validateHermitStep owns this legality, not this function.
        throw new Error(`Unknown Hermit mode "${mode}".`);
    }

    public validateHermitStep(minion: IMinionRef, step: IStep): StepValidation {
        const mode = stepHermitMode(step)!;
        const ctx = this.buildPowerContext();
        const destCellStr = step.targetCell!;
        const [destX, destY] = GnosticaBoard.algebraic2coords(destCellStr);
        if (mode === "piece") {
            const targetRef = step.targetPiece!;
            const targetResult = this.resolvePieceRef(targetRef);
            if (targetResult.kind !== "ok") {
                return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
            }
            const target = targetResult.ref;
            // parseMove now rejects a non-single-letter direction here too (AMBIGUOUS_DIRECTION), so step.direction is always a real N/E/S/W/U (or absent) by now.
            const failure = checkHermitMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, destX, destY);
            if (failure) {
                return { failed: true, result: this.failureResult(failure) };
            }
            const movedPiece = this.board.get(target.x, target.y)!.pieces[target.index];
            if (movedPiece.owner === this.currplayer) {
                // The destination may not have a stored CellContents yet, so this ref carries its own piece data rather than relying on a later board read.
                const newIndex = this.board.get(destX, destY)?.pieces.length ?? 0;
                const finalOrientation = (step.direction as Orientation | undefined) ?? movedPiece.orientation;
                const newPiece = new Piece(movedPiece.owner, movedPiece.size, finalOrientation);
                return { failed: false, outcome: { newMinion: { x: destX, y: destY, index: newIndex, piece: newPiece }, replacesMinion: { x: target.x, y: target.y, index: target.index } } };
            }
            // Moved an enemy's own piece - not tracked in this pool, but still a real removeAt at target's old slot.
            return { failed: false, outcome: { replacesMinion: { x: target.x, y: target.y, index: target.index } } };
        } else if (mode === "tile") {
            const targetCoords = this.resolveTileCard(step.card);
            if (targetCoords === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.NO_SUCH_TILE", { card: step.card }) };
            }
            const { x: tx, y: ty } = targetCoords;
            const failure = checkHermitMoveTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, destX, destY);
            if (failure) {
                return { failed: true, result: this.failureResult(failure) };
            }
            return { failed: false };
        }
        return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: "Hermit" }) };
    }

    // Justice / Hanged Man: <minionRef> <targetPieceRef> - swaps hands; the OTHER player's live hand array is looked up here (the one place the engine needs the full per-player hand map).
    private applyTradeHands(minion: IMinionRef, step: IStep): IStepOutcome {
        const targetRef = step.targetPiece!;
        const target = this.resolvePieceRefTrusted(targetRef);
        const targetOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const otherHand = this.hands[targetOwner - 1];
        tradeHands(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, otherHand);
        this.results.push({ type: "swap", where: GnosticaBoard.coords2algebraic(target.x, target.y), who: targetOwner });
        return {};
    }

    public validateTradeHands(minion: IMinionRef, step: IStep): StepValidation {
        const targetRef = step.targetPiece!;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
        const failure = checkTradeHands(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        return { failed: false };
    }

    // Judgement: <minionRef> draw <discardUid...>
    private applyJudgementDraw(minion: IMinionRef, step: IStep): void {
        const uids = step.cardList ?? [];
        judgementDraw(this.buildPowerContext(), minion.x, minion.y, minion.index, uids);
        this.results.push({ type: "deckDraw", count: uids.length, from: "discard" });
    }

    public validateJudgementDraw(minion: IMinionRef, step: IStep): IValidationResult {
        const uids = step.cardList ?? [];
        const failure = checkJudgementDraw(this.buildPowerContext(), minion.x, minion.y, minion.index, uids);
        return failure ? this.failureResult(failure) : { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // High Priestess: [discard <discardUid...>] [draw <n>] - no minion reference, shares the ordinary end-of-turn discard/draw primitive outright; no result logged for a partial call.
    private applyHighPriestess(step: IStep | undefined, partial: boolean): void {
        const discardUids = step?.cardList ?? [];
        const drawCountStr = step?.amount?.toString();
        const drawn = discardDraw(this.buildPowerContext(), discardUids, drawCountStr, partial);
        if (!partial) {
            if (discardUids.length > 0) {
                this.discarded.push(...discardUids);
                this.results.push({ type: "place", how: "discard", what: discardUids.join(",") });
            }
            this.results.push({ type: "deckDraw", count: drawn, from: "deck" });
        }
    }

    public validateHighPriestess(step: IStep | undefined): IValidationResult {
        if (step !== undefined && step.action !== "discard") {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP" });
        }
        const discardUids = step?.cardList ?? [];
        const drawCountStr = step?.amount?.toString();
        const failure = checkDiscardDraw(this.buildPowerContext(), discardUids, drawCountStr);
        if (failure) {
            return this.failureResult(failure);
        }
        // A missing "draw <n>" is never complete - same rule validateDiscard gives the ordinary top-level discard action's own identical shape.
        if (step?.amount === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.DISCARD_DRAW_REQUIRED") };
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // World: <chosenUid> - the minionRef itself is already stripped/resolved by applyPowerStep's own pre-switch logic, same as every other special.
    private validateWorldChoosePower(chosenUid: string): IValidationResult {
        const failure = checkWorldChoosePower(this.buildPowerContext(), chosenUid);
        return failure ? this.failureResult(failure) : { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // Turn order / scoring / win-elimination.  Player always rotates, even on the move that just ended the game.
    private nextPlayer(): void {
        // Step forward through turnOrder under in bidding variant ("tournament rules"), otherwise fall back to plain ascending.
        const order = this.turnOrder ?? [...Array(this.numplayers)].map((_, i) => (i + 1) as playerid);
        const pos = order.indexOf(this.currplayer);
        let next = pos;
        do {
            next = (next + 1) % order.length;
        } while (this.eliminated.includes(order[next]) && order[next] !== this.currplayer);
        this.currplayer = order[next];
    }

    // Stay open while a continuation is still owed, even if currplayer has cycled back to the round opener - otherwise the inherited close check would false-positive-close it early.
    protected shouldCloseRound(roundPlies: IGamePly[], stackIndex: number): boolean {
        if ((this.stack[stackIndex].continued ?? []).length > 0) {
            return false;
        }
        return super.shouldCloseRound(roundPlies, stackIndex);
    }

    // Sort cards by their index in allCards.
    private static handSortKey(uid: string): number {
        const card = allCards().find(c => c.uid === uid);
        return card === undefined ? 100 : allCards().indexOf(card);
    }

    // Cards drawn at the end of their last turn, for highlighting by render() - only non-empty for the CURRENT player, and only until they've started building THIS turn's move.
    private newHandCardUids(player: playerid): Set<string> {
        if (player !== this.currplayer || this.liveMove !== undefined) {
            return new Set();
        }
        const drawn = this.cardsDrawn[player - 1] || 0;
        if (drawn === 0)
            return new Set();
        return new Set(this.hands[player - 1].slice(-drawn));
    }

    public scoreFor(player: playerid): number {
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

    public sidebarScores(): IScores[] {
        const scores: number[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            scores.push(this.scoreFor(p as playerid));
        }
        return [
            { name: i18next.t("apgames:status.SCORES"), scores },
        ];
    }

    // The rule is that an eliminated player discards their hand.  A decision: Pieces are returned to stash.
    private eliminatePlayer(player: playerid): void {
        const ctx = this.buildPowerContext();
        for (const [x, y, t] of this.board.entries()) {
            for (const p of t.pieces) {
                if (p.owner === player) {
                    returnToStash(ctx, p.owner, p.size);
                }
            }
            t.pieces = t.pieces.filter(p => p.owner !== player);
            this.board.pruneIfEmpty(x, y);
        }
        this.discardPile.push(...this.hands[player - 1]);
        this.discarded.push(...this.hands[player - 1]);
        this.hands[player - 1] = [];
        this.eliminated.push(player);
        this.results.push({ type: "eliminated", who: player.toString() });
    }

    protected checkEOG(): GnosticaGame {
        // Not explicit in the rules text, but if elimination ever leaves only one player standing, he wins.
        if (this.eliminated.length === this.numplayers - 1) {
            this.gameover = true;
            const playarray = [...Array(this.numplayers)].map((_, index) => index + 1) as playerid[];
            this.winner = playarray.filter(item => ! this.eliminated.includes(item));
        }
        //Otherwise, gameover is set with a winner outside of checkEOG.
        
        if (this.gameover) {
            this.results.push({ type: "eog" });
            this.results.push({ type: "winners", players: [...this.winner] });
        }
        return this;
    }

    // randomMove() and its supporting builders now live in gnostica/randomMove.ts (#84) - this is just a thin stub calling generateRandomMove().
    public randomMove(): string {
        return generateRandomMove(this);
    }

    //TODO: reword the following comment.
    // The actual, single-state render body, renamed so the public render() dispatcher can call it directly; a historical frame is built entirely from renderFrame() instead.
    private renderCurrent(opts?: IRenderOpts, suppressHands = false): APRenderRep {
        let altDisplay: string | undefined;
        if (opts !== undefined) {
            altDisplay = opts.altDisplay;
        }
        let largerCards = false;
        if (altDisplay !== undefined) {
            if (altDisplay === "larger-cards") {
                largerCards = true;
            }
        }

        const { minX, maxX, minY, maxY } = this.renderWindow();
        const width = maxX - minX + 1;
        const height = maxY - minY + 1;

        // Every void cell is the bare "-" with no legend entry or clickable region - a wasteland piece facing into one gets a `buffer` area instead, not a click target baked into the grid.
        const legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] } = {};
        legend.hand_UNKNOWN = {
            name: "piece-square-borderless",
            colour: {
                func: "flatten",
                fg: "_context_fill",
                bg: "_context_background",
                opacity: 0.5,
            },
        };
                
        const pieceRows: string[] = [];
        const markers: MarkerOutline[] = [];
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
                    let owner = 0;
                    const players = t?.card !== undefined ? t.playersPresent() : undefined;
                    
                    if (players !== undefined && players.size === 1) {
                        [owner] = players;
                        markers.push({
                            type: "outline",
                            colour: owner,
                            points: [{row: y - minY, col: x - minX}],
                        });
                    }
                    legend[key] = this.buildCellGlyph(t, cls, largerCards, owner);
                }
                rowCells.push(key);
            }
            pieceRows.push(rowCells.join(","));
        }

        const columnLabels: string[] = [];
        for (let x = minX; x <= maxX; x++) {
            // coords2algebraic(x, 0) always ends in the literal digit "0" - strip it to get just this column's letter(s).
            columnLabels.push(GnosticaBoard.coords2algebraic(x, 0).slice(0, -1));
        }
        // The renderer pairs rowLabels[i] with pieceRows[N-1-i] (mirrored), so rowLabels is built bottom-first for the label to land on the right row. Matches Knight Line's own .reverse().
        const rowLabels: string[] = [];
        for (let y = maxY; y >= minY; y--) {
            rowLabels.push((y === 0 ? 0 : -y).toString());
        }

        // One area per player's hand, full-size (non-spaced) card faces - skipped entirely for an intermediate frame.
        const areas: (AreaPieces | AreaButtonBar | AreaKey)[] = [];
        if (!suppressHands) {
            for (let p = 1; p <= this.numplayers; p++) {
                const hand = this.hands[p - 1].slice() ?? [];
                if (hand.length === 0) {
                    continue;
                }
                //Hand sorting is now done in the render only.
                hand.sort((a, b) => GnosticaGame.handSortKey(a) - GnosticaGame.handSortKey(b));
                const newUids = this.newHandCardUids(p as playerid);
                const handKeys: string[] = [];
                for (const uid of hand) {
                    const card = allCards().find(c => c.uid === uid);
                    if (card === undefined) {
                        handKeys.push("hand_UNKNOWN");
                        continue;
                    }
                    // A card just added to hand gets its own tagged legend entry - same face, just tinted so it's easy to spot regardless of sort order.
                    const isNew = newUids.has(uid);
                    const key = isNew ? `hand_${uid}_new` : `hand_${uid}`;
                    if (!(key in legend)) {
                        legend[key] = this.buildCardFace(card, false, 0, isNew ? { background: MUTED_FILL } : {}) as [Glyph, ...Glyph[]];
                    }
                    handKeys.push(key);
                }
                areas.push({
                    type: "pieces",
                    pieces: handKeys as [string, ...string[]],
                    label: i18next.t("apgames:validation.gnostica.LABEL_HAND", { playerNum: p, declared: this.lastTurner && this.lastTurner === p ? "(declarer)" : "" }),
                    // Matches magnate.ts/emu.ts's own hand/deck sizing - tighter than default spacing, fixed width since hands are always <=6 cards.
                    spacing: 0.25,
                    width: 6,
                    ownerMark: p,
                });
            }
        }

        // The "bidding" variant's shared pool - every card revealed by the opening bid procedure, available for anyone to redraw; fully public, no redaction needed.
        if (this.biddingPool !== undefined && this.biddingPool.length > 0) {
            const poolKeys: string[] = [];
            for (const uid of this.biddingPool) {
                const card = allCards().find(c => c.uid === uid)!;
                const key = `pool_${uid}`;
                if (!(key in legend)) {
                    legend[key] = this.buildCardFace(card, false) as [Glyph, ...Glyph[]];
                }
                poolKeys.push(key);
            }
            areas.push({
                type: "pieces",
                pieces: poolKeys as [string, ...string[]],
                label: i18next.t("apgames:validation.gnostica.LABEL_BIDDING_POOL"),
                spacing: 0.25,
                width: 6,
            });
        }

        // The declaration round banner.
        if (this.lastTurner !== undefined) {
            if (!("Warning" in legend)) {
                legend.Warning = [
                    { name: "piece-borderless", colour: "_context_background" },
                    { text: "\u{26A0}", colour: "#f00", orientation: "vertical" },
                ];
            }
            areas.push({
                type: "pieces",
                pieces: ["Warning"],
                label: i18next.t("apgames:validation.gnostica.LABEL_WARNING"),
                spacing: 0.25,
                width: 1,
            });
        }
        
        // The literal drawPile array isn't used for the draw-pile summary - "what's left to draw" is computed by elimination: every card in the full deck not visible somewhere else.
        const visible = this.visibleCardUids();
        const unknownUids = allCards().filter(c => !visible.has(c.uid)).map(c => c.uid);
        const drawArea = this.buildDeckSummaryArea(
            unknownUids, "draw", legend, i18next.t("apgames:validation.gnostica.LABEL_DECK")
        );
        if (drawArea !== undefined) {
            areas.push(drawArea);
        }
        // The discard pile is always face-up/public, unlike hands or the draw pile, so its contents are read directly.
        const discardArea = this.buildDeckSummaryArea(
            this.discardPile, "discard", legend, i18next.t("apgames:validation.gnostica.LABEL_DISCARDS"), new Set(this.discarded)
        );
        if (discardArea !== undefined) {
            areas.push(discardArea);
        }

        // Only the bidding variant can ever make turn order diverge from plain player-number order; with only 2 players it's trivially "you, then them" either way, no legend worth showing.
        if (this.numplayers >= 3 && this.variants.includes("bidding")) {
            const list: AreaKey["list"] = [];
            this.turnOrder!.forEach((p, i) => {
                const key = `turnorder_p${p}`;
                if (!(key in legend)) {
                    legend[key] = { name: "pyramid-up-small", colour: p };
                }
                list.push({ piece: key, name: GnosticaGame.ordinal(i + 1) });
            });
            // "left", not "right" - the action button bar already owns the right side, and the two don't stack cleanly on the same side.
            areas.push({ type: "key", list, position: "left", height: 0.7, clickable: false });
        }

        // The top-level turn choice as buttons rather than inferring intent from board clicks alone.
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
                buffer: this.buffers.length === 0 ? undefined : {
                    separated: true,
                    width: 0.2,
                    pattern: "dots",
                    show: [...this.buffers] as ("N" | "E" | "S" | "W")[],
                },
                markers,
            },
            legend,
            pieces: pieceRows.join("\n"),
            areas: areas.length > 0 ? areas : undefined,
        };

        const annotations: NonNullable<APRenderRep["annotations"]> = [];
        // A 2+-step major-arcana chain wraps each step's results into a _group entry - flatten one level so annotations still cover every step's effect.
        const flatResults = this.results.flatMap(r => r.type === "_group" ? r.results : [r]);
        for (const r of flatResults) {
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

    // Builds a finished/historical chain's own intermediate frame DIRECTLY from FrameState's board/discardPile, without hand/pool/button areas.
    private renderFrame(frame: FrameState, stepIndex: number, opts?: IRenderOpts): APRenderRep {
        let altDisplay: string | undefined;
        if (opts !== undefined) {
            altDisplay = opts.altDisplay;
        }
        const largerCards = altDisplay === "larger-cards";

        const board = new GnosticaBoard(frame.board);
        const { minX, maxX, minY, maxY } = this.renderWindow(board);
        const width = maxX - minX + 1;
        const height = maxY - minY + 1;

        const legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] } = {};
        const pieceRows: string[] = [];
        const markers: MarkerOutline[] = [];
        for (let y = minY; y <= maxY; y++) {
            const rowCells: string[] = [];
            for (let x = minX; x <= maxX; x++) {
                const cls = board.classify(x, y);
                if (cls === "void") {
                    rowCells.push("-");
                    continue;
                }
                const t = board.get(x, y);
                const key = this.cellRenderKey(t, cls);
                if (!(key in legend)) {
                    let owner = 0;
                    const players = t?.card !== undefined ? t.playersPresent() : undefined;
                    if (players !== undefined && players.size === 1) {
                        [owner] = players;
                        markers.push({
                            type: "outline",
                            colour: owner,
                            points: [{ row: y - minY, col: x - minX }],
                        });
                    }
                    legend[key] = this.buildCellGlyph(t, cls, largerCards, owner);
                }
                rowCells.push(key);
            }
            pieceRows.push(rowCells.join(","));
        }

        const columnLabels: string[] = [];
        for (let x = minX; x <= maxX; x++) {
            columnLabels.push(GnosticaBoard.coords2algebraic(x, 0).slice(0, -1));
        }
        const rowLabels: string[] = [];
        for (let y = maxY; y >= minY; y--) {
            rowLabels.push((y === 0 ? 0 : -y).toString());
        }

        // The discard pile is always face-up/public - the one non-board area worth reconstructing here; no "just discarded" tinting since that's a live-only concept.
        const areas: AreaPieces[] = [];
        const discardArea = this.buildAreaFromSummary(
            frame.discardSummary, "discard", legend, i18next.t("apgames:validation.gnostica.LABEL_DISCARDS")
        );
        if (discardArea !== undefined) {
            areas.push(discardArea);
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
                markers,
            },
            legend,
            pieces: pieceRows.join("\n"),
            areas: areas.length > 0 ? areas : undefined,
        };

        // Same _group unwrapping as the live render's own annotation loop - pull just this step's own group by position, matching frogger.ts's frame[i]/results[i] pairing.
        const groups = this.results.filter((r): r is Extract<APMoveResult, { type: "_group" }> => r.type === "_group");
        const stepResults = groups[stepIndex]?.results ?? [];
        const annotations: NonNullable<APRenderRep["annotations"]> = [];
        for (const r of stepResults) {
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

    // A second, disposable GnosticaGame instance whose board is overridden to `frame.board` (one intermediate step's snapshot), not the real current board.
    // Its own `.frames` is left empty (it isn't itself mid-chain), so call `.renderCurrent()` on it directly - never the public `.render()` - to always get one rep back.
    private renderFrameSnapshot(frame: FrameState, stepIndex: number): GnosticaGame {
        // this.results holds one _group entry per step of the chain - pull just this step's own group by position, matching frogger.ts's frame[i]/results[i] pairing.
        const groups = this.results.filter((r): r is Extract<APMoveResult, { type: "_group" }> => r.type === "_group");
        const raw = this.state();
        raw.stack = [{
            ...this.moveState(),
            board: frame.board,
            _results: groups[stepIndex] !== undefined ? [groups[stepIndex]] : [],
        }];
        const snapshot = new GnosticaGame(JSON.stringify(raw, replacer));
        if (this.liveMove !== undefined) {
            // Still mid-build - reconstruct exactly what had been typed as of this step, so getActionButtons() on the snapshot offers the real choices available then.
            snapshot.liveMove = {
                ...this.liveMove,
                steps: this.liveMove.steps.slice(0, stepIndex + 2),
                stepSegments: this.liveMove.stepSegments.slice(0, stepIndex + 1),
            };
        }
        return snapshot;
    }

    // this.frames is only non-empty for a move that chained 2+ major-arcana steps - every other move returns the single rep renderCurrent() always has.
    public render(opts?: IRenderOpts): APRenderRep | APRenderRep[] {
        if (this.frames.length === 0) {
            return this.renderCurrent(opts);
        }
        // Historical (fully committed) frames get no buttons, via renderFrame(); a still-mid-build chain gets real ones instead, via renderCurrent() on a snapshot.
        const historical = this.liveMove === undefined;
        const reps = historical
            ? this.frames.map((f, i) => this.renderFrame(f, i, opts))
            : this.frames.map((f, i) => this.renderFrameSnapshot(f, i).renderCurrent(opts, true));
        reps.push(this.renderCurrent(opts));
        return reps;
    }

    // Every card whose identity is definitively known to the viewer: the board, discards, and known hands, used to compute the draw-pile summary by elimination.
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
        for (const uid of this.biddingPool ?? []) {
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

    // The abbreviation FrameState.discardSummary itself stores; pure bucketing, no "new"/tinting concept - just the first half of buildDeckSummaryArea's own logic, minus newUids.
    private summarizeDiscardPile(uids: string[]): DiscardSummary {
        const majorUids: string[] = [];
        const counts = new Map<string, number>();
        for (const uid of uids) {
            const card = allCards().find(c => c.uid === uid);
            if (card === undefined) {
                continue;
            }
            if (card.major) {
                majorUids.push(uid);
            } else {
                const bucket = `${card.suit.uid}_${card.court ? "royal" : "spot"}`;
                counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
            }
        }
        return { majorUids, counts };
    }

    // Builds a discard area straight from a DiscardSummary - used only for historical frames. Otherwise identical to buildDeckSummaryArea.
    private buildAreaFromSummary(
        summary: DiscardSummary, keyPrefix: string, legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, label: string,
    ): AreaPieces | undefined {
        const pieces: string[] = [];
        for (const suit of suits) {
            for (const category of ["spot", "royal"] as const) {
                const bucket = `${suit.uid}_${category}`;
                const count = summary.counts.get(bucket);
                if (count === undefined) {
                    continue;
                }
                const representativeRank = ranks.find(r => r.court === (category === "royal"))!;
                const representative = new Card({ name: `${representativeRank.name} of ${suit.name}`, rank: representativeRank, suit, major: false });
                const key = `${keyPrefix}_${bucket}`;
                if (!(key in legend)) {
                    legend[key] = this.buildCardFace(representative, false, 0, {
                        borderless: true,
                        rankText: `${count}x`,
                    }) as [Glyph, ...Glyph[]];
                }
                pieces.push(key);
            }
        }
        for (const uid of summary.majorUids.sort()) {
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
        return { type: "pieces", pieces: pieces as [string, ...string[]], label, spacing: 0.25, width: 10 };
    }

    // Summary code because Draw/discard piles can be large. Minors summarize as one token per (suit, spot-or-royalty) bucket with a count; majors are shown individually.
    private buildDeckSummaryArea(
        uids: string[], keyPrefix: string, legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, label: string,
        newUids: Set<string> = new Set(),
    ): AreaPieces | undefined {
        if (uids.length === 0) {
            return undefined;
        }
        // Split each minor bucket's count into "new" (just discarded) and the rest, so only the actual just-discarded cards get tinted rather than the whole bucket.
        const counts = new Map<string, number>();
        const newCounts = new Map<string, number>();
        const majorUids: string[] = [];
        for (const uid of uids) {
            const card = allCards().find(c => c.uid === uid);
            if (card === undefined) {
                continue;
            }
            if (card.major) {
                majorUids.push(uid);
            } else {
                const bucket = `${card.suit.uid}_${card.court ? "royal" : "spot"}`;
                counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
                if (newUids.has(uid)) {
                    newCounts.set(bucket, (newCounts.get(bucket) ?? 0) + 1);
                }
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
                // A representative rank uses the usual card layout; only the background and the rank-corner text (a count, not a real rank) are overridden.
                const representativeRank = ranks.find(r => r.court === (category === "royal"))!;
                const representative = new Card({ name: `${representativeRank.name} of ${suit.name}`, rank: representativeRank, suit, major: false });
                const newCount = newCounts.get(bucket) ?? 0;
                const oldCount = count - newCount;
                if (oldCount > 0) {
                    const key = `${keyPrefix}_${bucket}`;
                    if (!(key in legend)) {
                        legend[key] = this.buildCardFace(representative, false, 0, {
                            borderless: true,
                            rankText: `${oldCount}x`,
                        }) as [Glyph, ...Glyph[]];
                    }
                    pieces.push(key);
                }
                if (newCount > 0) {
                    const key = `${keyPrefix}_${bucket}_new`;
                    if (!(key in legend)) {
                        legend[key] = this.buildCardFace(representative, false, 0, {
                            borderless: true,
                            rankText: `${newCount}x`,
                            background: MUTED_FILL,
                        }) as [Glyph, ...Glyph[]];
                    }
                    pieces.push(key);
                }
            }
        }
        for (const uid of majorUids.sort()) {
            const isNew = newUids.has(uid);
            const key = isNew ? `${keyPrefix}_${uid}_new` : `${keyPrefix}_${uid}`;
            if (!(key in legend)) {
                const card = allCards().find(c => c.uid === uid)!;
                legend[key] = this.buildCardFace(card, false, 0, isNew ? { background: MUTED_FILL } : {}) as [Glyph, ...Glyph[]];
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
            // Tighter and wider than the default auto-wrap; there's no more than ~30 distinct tokens (8 buckets + 22 majors) to display.
            spacing: 0.25,
            width: 10,
        };
    }

    // A canonical string identifying this cell's exact visual contents
    // (card identity + every piece's owner/size/orientation) - the legend
    // only ever grows entries for combinations actually on the board, built
    // fresh each render() call.
    private cellRenderKey(t: CellContents | undefined, cls: CellClass): string {
        const cardPart = t?.card !== undefined ? t.card.uid : (cls === "wasteland" ? "waste" : "void");
        // Piece.id() (owner+size+orientation, no punctuation) - legend keys
        // end up as literal DOM ids in the renderer, and a "." breaks
        // querySelector("#" + key) since it reads as a class selector.
        const piecesPart = (t?.pieces ?? []).map(p => p.id()).join("_");
        return `k_${cardPart}_${piecesPart}`;
    }

    // Gnostica's own card face, rebuilt.  Also handles summary tokens.
    private buildCardFace(card: TarotCard, spaced: boolean, owner: number = 0, opts: { borderless?: boolean; rankText?: string; background?: ColourResolvable } = {}): Glyph[] {
        // `borderless` drops the card-square background for summary tokens.
        const BOARD_TILE_GRID_CORNER = 650;
        // Opacity 0 by default.
        const backdrop: Glyph = { name: opts.borderless ? "piece-square-borderless" : "piece-square", scale: 1, opacity: 0 };
        if (opts.background !== undefined) {
            backdrop.colour = opts.background;
            backdrop.opacity = 1;
        }
        if (owner > 0) {
            backdrop.colour = owner;
            backdrop.opacity = 0.05;
        }
        const stack: Glyph[] = [backdrop];

        //The `spaced` version for board tiles (to leave room for pyramids) shrinks all the card contents.
        let rankText = opts.rankText;
        if (rankText === undefined) {
            rankText = card.major ? card.romanNumeral : card.rank.uid;
            if (!card.major && card.rank.uid !== "10") {
                rankText += "\u00A0";
            }
        }
        const rankScale = spaced ? 0.25 : 0.45;
        const corner = spaced ? BOARD_TILE_GRID_CORNER : 250;
        let rankShiftX = spaced ? -675 : -corner;
        let rankShiftY = rankShiftX;
        if (card.major) {
            rankShiftX += spaced ? 675 : 250;
            rankShiftY += spaced ? -175 : -175;
        }

        // top-left: the rank (minors) or major arcana numeral, plain text.
        const majorRotation = card.major ? -45 : 0;
        stack.push({
            text: rankText,
            scale: rankScale,
            colour: "_context_strokes",
            nudge: { dx: rankShiftX, dy: rankShiftY },
            rotate: majorRotation,
            fontFamily: "Georgia,serif",
            orientation: "vertical",
        });

        const icons = card.major
            ? getMajorArcanaIcons(card)
            : card.suit.glyph !== undefined ? [card.suit.glyph!] : [];
        const circleScale = spaced ? 0.25 : 0.45;
        const iconScale = spaced ? 0.15 : 0.30;
        // `iconShift` compensates for nudging issues, so an
        // icon still lands centred on its larger coin.
        const iconShift = spaced ? 1075 : 375;
        const pushCircle = (xdir: number, ydir: number, iconName?: string) => {
            stack.push({ name: "piece", scale: circleScale, colour: "_context_board", nudge: { dx: xdir * corner, dy: ydir * corner }, orientation: "vertical" });
            if (iconName !== undefined) {
                stack.push({ name: iconName, scale: iconScale, nudge: { dx: xdir * iconShift, dy: ydir * iconShift }, orientation: "vertical" });
            }
        };

        // Top-right: always populated with a "piece" circle holding the suit icon (minors) or the major's first power icon.
        pushCircle(1, -1, icons[0]);

        //Bottom-left: nothing at all for minors; for majors, an empty circle except filled for the Devil.
        //Bottom-right: nothing for pip minors (A-10); an empty circle for court minors (P/N/Q/K); for majors, populated with the 2nd power icon (or empty).
        if (card.major) {
            pushCircle(-1, 1, icons[2]);
            pushCircle(1, 1, icons[1]);
        } else if (card.court) {            
            pushCircle(1, 1, undefined);
        }

        return stack;
    }

    // A board tile uses the spaced card face.  (There's a render option to use the card version when the territory is unpopulated.)
    private buildCellGlyph(t: CellContents | undefined, cls: CellClass, largerCards: boolean, owner?: number): Glyph | [Glyph, ...Glyph[]] {
        const stack: Glyph[] = [];
        if (t?.card !== undefined) {
            const dontSpace = largerCards && t.playersPresent().size === 0;
            stack.push(...this.buildCardFace(t.card, !dontSpace, owner));
        } else if (cls === "wasteland") {
            // Same transparent-by-default convention as buildCardFace's own backdrop, so the theme's board colour shows through here too.
            stack.push({ name: "piece-square-dashed", scale: 1, opacity: 0 });
        } else {
            // Void, in principle - the main render loop already short-circuits every void cell to "-", so this is just a defensive fallback.
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

    // Up to 5 pieces: each piece's orientation names its preferred cell in the 3x3 grid; a taken preferred cell bumps the piece into whatever's still free.
    private pieceGridSlots(pieces: Piece[]): { dx: number; dy: number; scale: number }[] {
        const PIECE_GRID_RADIUS = 380;
        const PIECE_GRID_SLOTS: [number, number][] = [[0, -1], [0, 1], [1, 0], [-1, 0], [0, 0]]; // N, S, E, W, U
        const PIECE_GRID_PREFERRED_INDEX: Record<Orientation, number> = { N: 0, S: 1, E: 2, W: 3, U: 4 };
        const CARDINAL_COS_SIN: Record<Exclude<Orientation, "U">, [number, number]> = {
    N: [1, 0], E: [0, 1], S: [-1, 0], W: [0, -1],
};
        // a bumped piece tries the two perpendicular sides first, then the center, and only falls back to the remaining position as a last resort.
        const FALLBACK_ORDER: Record<Orientation, number[]> = {
            N: [2, 3, 4, 1], // E, W, U, S
            S: [2, 3, 4, 0], // E, W, U, N
            E: [0, 1, 4, 3], // N, S, U, W
            W: [0, 1, 4, 2], // N, S, U, E
            U: [0, 1, 2, 3], // no preference
        };

        const n = pieces.length;
        if (n === 0) {
            return [];
        }
        const raw: { dx: number; dy: number; scale: number }[] = (() => {
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
            for (let i = 0; i < n; i++) {
                if (chosenIdx[i] === undefined) {
                    const fallback = FALLBACK_ORDER[pieces[i].orientation].find(idx => !claimed.has(idx))!;
                    claimed.add(fallback);
                    chosenIdx[i] = fallback;
                }
            }
            return chosenIdx.map(idx => {
                const [dirX, dirY] = PIECE_GRID_SLOTS[idx];
                return { dx: dirX * PIECE_GRID_RADIUS, dy: dirY * PIECE_GRID_RADIUS, scale: 0.48 };
            });
        })();
        // The renderer applies nudge pre-rotation, so every non-U piece's raw offset must be counter-rotated by its own facing here, whichever branch produced it.
        return raw.map((slot, i) => {
            const orientation = pieces[i].orientation;
            if (orientation === "U") {
                return slot;
            }
            const [cos, sin] = CARDINAL_COS_SIN[orientation];
            return {
                dx: slot.dx * cos + slot.dy * sin,
                dy: -slot.dx * sin + slot.dy * cos,
                scale: slot.scale,
            };
        });
    }

    // Overflow fallback for more pieces than the 3x3 grid has spare cells for (5) - a dense shrink-to-fit grid, unrelated to where the card face's corners land.
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

    // "U" pyramids stand upright, no rotation; N/E/S/W pyramids are the same "flat/pointing" glyph rotated - the exact pattern btt.ts uses for its own Icehouse pieces.
    private pyramidGlyph(piece: Piece): Glyph {
        const sizeNames = ["small", "medium", "large"];
        const sizeName = sizeNames[piece.size - 1];
        if (piece.orientation === "U") {
            return { name: `pyramid-up-${sizeName}`, colour: piece.owner };
        }
        const rotations: Record<Exclude<Orientation, "U">, number> = { N: 0, E: 90, S: 180, W: -90 };
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

    // A card's display name for chat/status text, with its major arcana numeral appended (e.g. "The World (XXI)"); falls back to the bare uid if not found.
    private cardDisplayName(uid: string | undefined): string {
        const card = allCards().find(c => c.uid === uid);
        if (card === undefined) {
            return uid ?? "";
        }
        if (!card.major) {
            return "the " + card.name;
        }
        return `${card.name} (${card.romanNumeral})`;
    }

    // #47: resolves a player number to their real display name, or undefined if `who` is the acting player themselves.
    private otherPlayerName(who: number | undefined, player: string, players: string[]): string | undefined {
        if (who === undefined) {
            return undefined;
        }
        const name = who <= players.length ? players[who - 1] : `Player ${who}`;
        return name === player ? undefined : name;
    }

    //Switched to chatLog because there are a lot of player names to report.
    public chatLog(players: string[]): string[][] {
        const result: string[][] = [];
        // Index 0 has no associated ply, so it's skipped.
        for (let i = 1; i < this.stack.length; i++) {
            const state = this.stack[i];
            if (state._results !== undefined && state._results.length > 0) {
                const node: string[] = [(state._timestamp && new Date(state._timestamp).toISOString()) || "unknown"];
                // Resolved via plyActor(), not `state.currplayer - 1`, to fix skip-turn (elimination) and sequenced (bidding reorder, High Priestess) cases.
                let otherPlayer = this.plyActor(i);
                if (otherPlayer < 1) {
                    otherPlayer = this.numplayers;
                }
                let name = `Player ${otherPlayer}`;
                if (otherPlayer <= players.length) {
                    name = players[otherPlayer - 1];
                }
                // Frames for multi-step major arcana moves have _group entries - flatten here so this loop logs one line per step instead of skipping the whole group.
                const flatResults = state._results.flatMap(r => r.type === "_group" ? r.results : [r]);
                for (const r of flatResults) {
                    switch (r.type) {
                        case "announce": {
                            // Reused for two unrelated one-off announcements (bidding's turn-order reveal, and a declined revealed card) - tagged by payload[0] since "announce" carries no type.
                            if (r.payload[0] === "decline") {
                                node.push(i18next.t("apresults:ANNOUNCE.gnostica_decline", { player: name, card: this.cardDisplayName(r.payload[1] as string) }));
                                break;
                            }
                            if (r.payload[0] === "declore") {
                                node.push(i18next.t("apresults:ANNOUNCE.gnostica_declore", { player: name, count: r.payload[1] as number }));
                                break;
                            }
                            const nameFor = (p: number): string => p <= players.length ? players[p - 1] : `Player ${p}`;
                            const turnOrderNames = (r.payload as number[]).map(nameFor).join(", ");
                            const redrawOrderNames = [...r.payload as number[]].reverse().map(nameFor).join(", ");
                            node.push(i18next.t("apresults:ANNOUNCE.gnostica", { turnOrder: turnOrderNames, redrawOrder: redrawOrderNames }));
                            break;
                        }
                        case "swap": {
                            const target = this.otherPlayerName(r.who as number, name, players) ?? `Player ${r.who}`;
                            node.push(i18next.t("apresults:SWAP.gnostica", { player: name, target }));
                            break;
                        }
                        case "select":
                            node.push(i18next.t("apresults:SELECT.gnostica", { player: name }));
                            break;
                        case "deckDraw":
                            switch (r.from) {
                                case "pool":
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_pool", { player: name, what: r.what!.split(",").filter(uid => uid.length > 0).map(uid => this.cardDisplayName(uid)).join(", ") }));
                                    break;
                                case "discard":
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_discard", { player: name, count: r.count }));
                                    break;
                                case "deck":
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_deck", { player: name, count: r.count }));
                                    break;
                                case "hand":
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_hand", { player: name, what: this.cardDisplayName(r.what) }));
                                    break;
                                case "fool": {
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_fool", { player: name, what: this.cardDisplayName(r.what) }));
                                    break;
                                }
                            }
                            break;
                        case "declare":
                            node.push(i18next.t("apresults:DECLARE.gnostica", { player: name, count: r.count }));
                            break;
                        case "orient": {
                            // The Devil's orientAny can reorient any player's piece; every other orient path only ever turns the acting player's own.
                            const target = this.otherPlayerName(r.who, name, players);
                            node.push(target === undefined
                                ? i18next.t("apresults:ORIENT.gnostica_own", { player: name, where: r.where, what: r.what, facing: r.facing })
                                : i18next.t("apresults:ORIENT.gnostica_target", { player: name, where: r.where, what: r.what, facing: r.facing, target }));
                            break;
                        }
                        case "use":
                            if (r.count && r.count === 21) {
                                node.push(i18next.t("apresults:USE.gnostica_world", { player: name, what: this.cardDisplayName(r.what) }));
                            } else
                                node.push(i18next.t("apresults:USE.gnostica", { player: name, what: this.cardDisplayName(r.what) }));
                            break;
                        case "pass":
                            node.push(r.why === "eliminated"
                                ? i18next.t("apresults:PASS.gnostica_eliminated", { player: name })
                                : i18next.t("apresults:PASS.gnostica_bids", { player: name }));
                            break;
                        case "destroy":
                            if (r.who !== undefined) {
                                //Someone's minion.
                                const target = this.otherPlayerName(r.who, name, players);
                                node.push(target === undefined
                                    ? i18next.t("apresults:DESTROY.gnostica_piece_own", { player: name, what: r.what })
                                    : i18next.t("apresults:DESTROY.gnostica_piece", { player: name, what: r.what, target }));
                            } else {
                                //A territory.
                                node.push(i18next.t("apresults:DESTROY.gnostica_tile", { player: name, where: r.where, what: this.cardDisplayName(r.what) }));
                            }
                            break;
                        case "move": {
                            // Rods/Hermit "piece" mode can move any piece, not just the acting player's own, so name whose it was.
                            const target = this.otherPlayerName(r.who, name, players);
                            switch (r.how) {
                                case "rod-piece":
                                    node.push(target === undefined
                                        ? i18next.t("apresults:MOVE.gnostica_rod_piece_own", { player: name, what: r.what, from: r.from, to: r.to })
                                        : i18next.t("apresults:MOVE.gnostica_rod_piece", { player: name, what: r.what, from: r.from, to: r.to, target }));
                                    break;
                                case "rod-tile":
                                    node.push(i18next.t("apresults:MOVE.gnostica_rod_tile", { player: name, from: r.from, to: r.to }));
                                    break;
                                case "hermit-piece":
                                    node.push(target === undefined
                                        ? i18next.t("apresults:MOVE.gnostica_hermit_piece_own", { player: name, what: r.what, from: r.from, to: r.to })
                                        : i18next.t("apresults:MOVE.gnostica_hermit_piece", { player: name, what: r.what, from: r.from, to: r.to, target }));
                                    break;
                                case "hermit-tile":
                                    node.push(i18next.t("apresults:MOVE.gnostica_hermit_tile", { player: name, from: r.from, to: r.to }));
                                    break;
                                default:
                                    // Only 4 cases above ever produce a "move" result - an unrecognized `how` here is a genuine bug, not an input to degrade gracefully for.
                                    throw new Error(`chatLog(): unrecognized "move" result how="${r.how}"`);
                            }
                            break;
                        }
                        case "place":
                            switch (r.how) {
                                case "cups-own":
                                    node.push(i18next.t("apresults:PLACE.gnostica_own", { player: name, where: r.where }));
                                    break;
                                case "cups-enemy": {
                                    // "enemy" mode requires a real enemy target (self-targeting is rejected outright), so `who` always names someone else.
                                    const target = this.otherPlayerName(r.who, name, players) ?? `Player ${r.who}`;
                                    node.push(i18next.t("apresults:PLACE.gnostica_enemy", { player: name, where: r.where, target }));
                                    break;
                                }
                                case "territory":
                                    node.push(i18next.t("apresults:PLACE.gnostica_territory", { player: name, where: r.where, what: this.cardDisplayName(r.what) }));
                                    break;
                                case "initial":
                                    node.push(i18next.t("apresults:PLACE.gnostica_initial", { player: name, where: r.where }));
                                    break;
                                case "discard":
                                    node.push(i18next.t("apresults:PLACE.gnostica_discard", { player: name, what: r.what }));
                                    break;
                                default:
                                    // Only 5 cases above ever produce a "place" result - an unrecognized `how` here is a genuine bug, not an input to degrade gracefully for.
                                    throw new Error(`chatLog(): unrecognized "place" result how="${r.how}"`);
                            }
                            break;
                        case "convert":
                            if (r.into.startsWith("size ")) {
                                // Discs' growth and Swords' attack shrink both land here (same "size N" shape) - the numbers say which direction actually happened.
                                const grew = parseInt(r.into.slice(5), 10) > parseInt(r.what.slice(5), 10);
                                // Both can target an enemy's piece, not just the acting player's own - name whose, same _own/target split as DESTROY's.
                                const target = this.otherPlayerName(r.who, name, players);
                                if (grew) {
                                    node.push(target === undefined
                                        ? i18next.t("apresults:CONVERT.gnostica_piece_own", { player: name, into: r.into, where: r.where })
                                        : i18next.t("apresults:CONVERT.gnostica_piece", { player: name, into: r.into, where: r.where, target }));
                                } else {
                                    node.push(target === undefined
                                        ? i18next.t("apresults:CONVERT.gnostica_piece_shrink_own", { player: name, into: r.into, where: r.where })
                                        : i18next.t("apresults:CONVERT.gnostica_piece_shrink", { player: name, into: r.into, where: r.where, target }));
                                }
                            } else if (r.into.startsWith("owner-")) {
                                const target = this.otherPlayerName(r.who, name, players);
                                node.push(target === undefined
                                    ? i18next.t("apresults:CONVERT.gnostica_hierophant", { player: name, where: r.where })
                                    : i18next.t("apresults:CONVERT.gnostica_hierophant_target", { player: name, where: r.where, target }));
                            } else {
                                // Discs' grow-replace and Swords' attack-and-replace both land here - point value is the only thing distinguishing which direction happened.
                                const before = allCards().find(c => c.uid === r.what);
                                const after = allCards().find(c => c.uid === r.into);
                                const grew = before !== undefined && after !== undefined && cardPointValue(after) > cardPointValue(before);
                                const key = grew ? "apresults:CONVERT.gnostica_tile" : "apresults:CONVERT.gnostica_tile_shrink";
                                node.push(i18next.t(key, { player: name, what: this.cardDisplayName(r.what), into: this.cardDisplayName(r.into), where: r.where }));
                            }
                            break;
                        case "eliminated": {
                            const who = parseInt(r.who, 10);
                            const ename = who <= players.length ? players[who - 1] : `Player ${who}`;
                            node.push(i18next.t("apresults:ELIMINATED", { player: ename }));
                            break;
                        }
                        case "eog":
                            node.push(i18next.t("apresults:EOG.default"));
                            break;
                        case "resigned": {
                            let rname = `Player ${r.player}`;
                            if (r.player <= players.length) {
                                rname = players[r.player - 1];
                            }
                            node.push(i18next.t("apresults:RESIGN", { player: rname }));
                            break;
                        }
                        case "timeout": {
                            let tname = `Player ${r.player}`;
                            if (r.player <= players.length) {
                                tname = players[r.player - 1];
                            }
                            node.push(i18next.t("apresults:TIMEOUT", { player: tname }));
                            break;
                        }
                        case "drawagreed":
                            node.push(i18next.t("apresults:DRAWAGREED"));
                            break;
                        case "gameabandoned":
                            node.push(i18next.t("apresults:ABANDONED"));
                            break;
                        case "winners": {
                            const names: string[] = [];
                            for (const w of r.players) {
                                names.push(w <= players.length ? players[w - 1] : `Player ${w}`);
                            }
                            node.push(r.players.length === 0
                                ? i18next.t("apresults:WINNERSNONE")
                                : i18next.t("apresults:WINNERS", { count: r.players.length, winners: names.join(", ") }));
                            break;
                        }
                    }
                }
                result.push(node);
            }
        }
        return result;
    }

    public clone(): GnosticaGame {
        return new GnosticaGame(this.serialize());
    }
}
