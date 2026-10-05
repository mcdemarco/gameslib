import { IAPGameState, IClickResult, IIndividualState, IRenderOpts, IScores, IValidationResult } from "./_base.js";
import { GameBaseSequenced } from "./_turn-sequenced.js";
import type { IGamePly } from "./_turn-model.js";
import { APGamesInformation } from "../schemas/gameinfo.js";
import { APRenderRep, AreaButtonBar, AreaKey, AreaPieces, ButtonBarButton, Glyph, MarkerGlyph, MarkerOutline } from "@abstractplay/renderer/build/schemas/schema";
import type { ColourResolvable, Colourfuncs } from "@abstractplay/renderer/build/schemas/schema";
import { APMoveResult } from "../schemas/moveresults.js";
import { Direction, replacer, reviver, shuffle, UserFacingError } from "../common/index.js";
import { UnboundedSquareBoard } from "../common/unbounded-square-board.js";
import { Deck, Card, TarotCard, allCards, ranks, suits } from "../common/tarot/index.js";
import { GnosticaBoard } from "./gnostica/board.js";
import { CellContents, ICellContents, cardPointValue, UNREVEALED_CARD, UNREVEALED_UID } from "./gnostica/cell.js";
import { Piece, Pips, Orientation, allOrientations, cardinalOrientations } from "./gnostica/piece.js";
import {
    Stash, PowerContext, PowerFailure, takeFromStash, returnToStash, hasStashAvailable,
    createOwn, createEnemy, createTerritory,
    movePiece, moveTerritory,
    growPiece, growTerritory,
    attackPiece, attackTerritory,
    orientMinion, orientAny, hierophantReplace,
    hermitMovePiece, hermitMoveTerritory, tradeHands,
    judgementDraw, discardCards, drawCards, fool, createTerritoryFromDeck, worldChoosePower,
    checkCreateOwn, checkCreateEnemy, checkCreateTerritory,
    checkMovePiece, checkMoveTerritory,
    checkGrowPiece, checkGrowTerritory,
    checkAttackPiece, checkAttackTerritory,
    checkOrientMinion, checkOrientAny, checkHierophantReplace,
    checkHermitMovePiece, checkHermitMoveTerritory, checkTradeHands,
    checkJudgementDraw, judgementDrawRoom, checkDiscardDraw, checkFool, checkWorldChoosePower,
    ALL_SUITS, RDS_VERBS, stepMinorMode, stepHermitMode, SPECIAL_STEP_ACTIONS,
    MinorSuitUid, TargetMode, CupsMode, MinorMode,
} from "./gnostica/powers.js";
import { MAJOR_ARCANA, MajorArcanaDef, PowerStep, SpecialPower, SuitPrimitive, getMajorArcanaIcons } from "./gnostica/majorArcana.js";
import { generateRandomMove } from "./gnostica/randomMove.js";

import i18next from "i18next";

// card.suit.uid is typed as plain `string` by the shared tarot infra (src/common/tarot), but is always one
// of the 4 minor suits in practice (fixed card data, not user input) - the one place that fact gets asserted.
const suitUidOf = (card: TarotCard): MinorSuitUid => card.suit.uid as MinorSuitUid;

// The target-button wording for Rods/Discs/Swords: the verb prefixing each piece candidate, and the whole-territory option.
const RDS_TARGET_LABELS: Record<Exclude<MinorSuitUid, "C">, { verb: string; tile: string }> = {
    R: { verb: "Move", tile: "Push Territory" },
    D: { verb: "Grow", tile: "Grow Territory" },
    S: { verb: "Attack", tile: "Attack Territory" },
};

const MUTED_FILL: Colourfuncs = { func: "flatten", fg: "_context_strokes", bg: "_context_background", opacity: 0.3 };
// The greyed button: MUTED_FILL's dark-theme grey, lightened to about #ccc in the light theme.
const GREYED_BUTTON_FILL: Colourfuncs = {
    func: "flatten",
    fg: { func: "flatten", fg: "_context_strokes", bg: "_context_fill", opacity: 0.71 },
    bg: "_context_background",
    opacity: 0.2,
};

export type playerid = 1|2|3|4|5|6;

// Major arcana chaining uses frames: the board before each step of a move of 2+ steps, as in Frogger and Rincala.  Discards are abbreviated.
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

interface ILegendObj {
    [key: string]: Glyph|[Glyph, ...Glyph[]];
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
    // Hand off to a DIFFERENT card's power array (World's target, or Fool's flip).
    pushFrame?: { cardUid: string; minions: IMinionRef[] };
    // Must pause here regardless of further supplied step segments - the outcome is hidden (Fool's flip) or a later sibling step needs it (High Priestess).
    forcePause?: boolean;
    // This step's tokens still carry a trailing "?" (Cups "own" creation's mandatory facing) - read by validateMinorPower/validateFrameStack as complete:0.
    softComplete?: boolean;
    // Rods "piece" mode's own landing cell, regardless of the moved piece's owner (newMinion is only set for the acting player's own) - Moon's own capacity-restoration check reads this.
    movedToCell?: { x: number; y: number };
    // Swords "piece" mode's own cell, set only when the target was fully destroyed (not just shrunk in place) - Moon's own capacity-restoration check reads this too.
    destroyedAtCell?: { x: number; y: number };
    // A one-step shortcut (Strength's +2 grow, Sun's royalty create, Death's both-swords shrink) already did the card's whole job, so its remaining steps are spent.
    consumesRest?: boolean;
    // Swords: the pips actually removed - applyPowerStep compares it with the minion's size to decide consumesRest, so applying never needs the minion.
    shrunkBy?: number;
    // The piece a grow/create/move produced, for the not-tracked (an enemy's) cases newMinion leaves out - a two-step shortcut's second step must act on it.
    producedPiece?: { x: number; y: number; index: number };
}

// The non-mutating validator's verdict on one step: a failure, or a pass where `complete: false` marks a still-building step, not a finished one.
// What a passing step actually did comes from applying it (see IStepOutcome), never from the validator.
type StepValidation =
    | { failed: true; result: IValidationResult }
    // `mayAddMore`: a Judgement draw that could still take this many more discards, so the move can be submitted as it is but isn't finished.
    | { failed: false; complete?: boolean; mayAddMore?: number };

// resolvePieceRef's result: "ok" (exactly one), "not_found" (zero matches, which includes text that isn't a piece reference), or "ambiguous" (2+, narrowable by more fields).
type PieceRefResolution =
    | { kind: "ok"; ref: IMinionRef }
    | { kind: "not_found" }
    | { kind: "ambiguous" };

export interface IParsedMove {
    announceLast: boolean;
    asUid?: string;  //for World
    asSuit?: MinorSuitUid; //for Magician
    error?: string;
    head: string | undefined;  //Head may be absent.
    steps: IStep[];
    valid: boolean;
    viaUid?: string; //for Fool and High Priestess
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
    asSuit?: MinorSuitUid;
    // This step's suit - the card's own for a minor, or the mapped primitive's for a major (create→C/move→R/grow→D/attack→S); unset for a `special` step.
    suitUid?: MinorSuitUid;
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
    // The current step's own content as typed so far, already resolved into an IStep - completeness gates and click handlers read it directly.
    istep: IStep;
    // Set on a finished step viewed as the one still being refined: it only completed by default (its facing was never chosen), so a facing click can still redirect it.
    softComplete?: boolean;
    // Whether the move string being clicked on already declares "last" - rebuilt moves must carry it forward.
    announceLast: boolean;
    // The game as it stands after every completed step above was applied to a clone of the committed state; refs, candidates and lookups for this step resolve against its board.
    game: GnosticaGame;
}

// An unfinished Fool flip, High Priestess round or Justice attack, bottom to top - the same tokens as this.continued: "00.<flips done>", "02", and "11.<how it was reached>".
type Owed = { uid: string; done: number; how?: string };

type IHiddenEffect = (
    | { type: "flip" }
    | { type: "territory"; x: number; y: number }
    | { type: "draw"; count: number; setsCardsDrawn: boolean }
    // Justice or the Hanged Man: the acting player swaps hands with the owner of this piece.
    | { type: "trade"; x: number; y: number; index: number }
) & {
    // Set by the chain walker: the effect's results belong in the submission's per-step _group entries.
    grouped?: boolean;
    // Its step already logged a visible result, so in a chained submission it already has a group to join.
    joinsGroup?: boolean;
};

// What each click handler needs: the move being clicked on, as parsed, and a once-per-click, lazily computed view of its in-progress power step.
interface IClickContext {
    move: string;
    parsed: IParsedMove;
    row: number;
    col: number;
    piece?: string;
    // " last" when the move already declares it, else "" - appended to every move string a handler builds by hand.
    last: string;
    // The "this click means nothing right now" result.
    noop: IClickResult;
    pending: () => { current?: IPendingStep; advanced?: IPendingStep };
}

// What the click UI needs to know about an in-progress (partial) move, computed once inside move(..., {partial: true}) from the pre-move state.
interface IPreview {
    head: string | undefined;
    // Top-level button values to bold.
    highlighted: Set<string>;
    discardNeedsCount: boolean;
    // A bare orient cell whose piece is still ambiguous.
    orientPickCell: string | undefined;
    // The resume seed move string, including whatever was typed against the pending obligation.
    pending: IPendingStep | undefined;
    // A finished power whose piece can still be turned, with the next power waiting: board clicks turn the piece until the buttons go on.
    facingOpen: boolean;
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
}

// What a use, play or resume move is playing (see resolvePowerPlay).
interface IPowerPlay {
    head: "use" | "play";
    // The card whose powers are walked: the head's card, or the card a Fool/High Priestess resume is waiting on.
    headArg: string;
    // Unknown only for a resume that names a card the deck doesn't have; every other kind has been checked by now.
    card: Card | undefined;
    // A persisted obligation being resumed, rather than a fresh use or play.
    resume: boolean;
    // Every piece that may act.
    eligible: IMinionRef[];
    // The typed power segments, with a High Priestess resume's own content folded back in.
    steps: IStep[];
    asUid?: string;
    asSuit?: MinorSuitUid;
    // The frame stack a walk of this play starts from, as fresh copies: just the card for a use or play, or the persisted obligations plus the revealed card for a resume.
    frames: IPowerFrame[];
    // The card whose obligation the walk is rooted in.
    rootUid: string;
    // What is already owed below this play (nothing, for a use or play).
    owed: Owed[];
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

    // Transient click-UI hints, not part of persisted game state; set by move(..., {partial: true}) and cleared by a committed move.
    private preview: IPreview | undefined;
    // Hidden or random effects (deck draws) recorded while a move is applied; only move() performs them, once the move is committed.
    private hidden: IHiddenEffect[] = [];
    private buffers: Direction[] = [];
    private discarded: string[] = [];

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
            // The draw pile isn't stored: load() rebuilds it from the cards nobody can see.
            const boardCards = this.variants.includes("no-majors")
                // Pulls 9 non-major cards out.
                ? deck.cards.filter(c => !c.major).slice(0, 9)
                : deck.draw(9);
            
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
        // Like the other Decktet games, the deck is reset every time you load: whatever isn't on the board, in a hand, discarded or in the pool, shuffled.
        this.drawPile = shuffle(this.unseenCardUids()) as string[];
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

    public state(opts?: {strip?: boolean, player?: number}): IGnosticaState {
        const state: IGnosticaState = {
            game: GnosticaGame.gameinfo.uid,
            numplayers: this.numplayers,
            variants: this.variants,
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack],
        };
        if (opts !== undefined && opts.strip) {
            state.stack = state.stack.map(mstate => {
                for (let p = 1; p <= this.numplayers; p++) {
                    if (p === opts.player) { continue; }
                    mstate.hands[p - 1] = mstate.hands[p - 1].map(() => UNREVEALED_UID);
                }
                return mstate;
            });
        }
        return state;
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
            if (this.resumeAnchor(parsed) !== activeUid)
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "WRONG_VIA_CARD"});
            const allowed = activeUid === "02" ? ["discard"] : activeUid === "11" ? [this.justiceHead(), "decline"] : ["decline", "play"];
            if (! allowed.includes(parsed.head!))
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "WRONG_CONTINUED_ACTION"});
            // Cannot announce when a different player has announced.  Has nothing to do your own declaration, continued or not.
            if (parsed.announceLast && (this.lastTurner !== undefined))
                return this.invalid("apgames:validation.gnostica.ALREADY_ANNOUNCED");
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
        // An action chosen with nothing yet clicked for it is a legal start, and says what to click next.
        const prompts: Record<string, string> = {
            place: "PICK_CELL_TO_PLACE", use: "PICK_CARD_TO_ACTIVATE", play: "PICK_HAND_CARD_TO_PLAY", orient: "PICK_PIECE_TO_ORIENT",
        };
        if (head !== undefined && prompts[head] !== undefined && parsed.viaUid === undefined && parsed.asUid === undefined && parsed.steps.every(step => GnosticaGame.isBareStep(step))) {
            return { valid: true, complete: -1, message: i18next.t(`apgames:validation.gnostica.${prompts[head]}`) };
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
        this.hidden = [];
        this.frames = [];
        this.cardsDrawn[this.currplayer - 1] = 0;
        let head;
        // A "last" already staged on an earlier sub-move of this same still-open turn rides at the front of this.continued.
        const hadDeclareMarker = this.continued.length > 0 && this.continued[0] === "last";
        let newLast = hadDeclareMarker ? this.currplayer : this.lastTurner;
        // What this submission left owed (a Fool flip, a High Priestess round), serialized into this.continued once past the partial boundary below.
        let owed: Owed[] | undefined;
        let preview: IPreview | undefined;
        let announceLast = false;

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
            preview = partial ? this.buildPreview(parsed) : undefined;
            this.addDistanceBuffer(preview?.pending);
            this.addPendingFacingBuffer(parsed, preview?.pending);

            // A genuine cross-turn pause means every legal move right now has to be resuming it; legality of any kind is validateMove's job alone now.
            if (this.continued.length > 0) {
                owed = this.resumePowers(this.resolvePowerPlay(parsed)!, partial);
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
                        // A bare "place" has no cell to put a piece on yet.
                        if (parsed.steps[0]?.targetCell !== undefined) {
                            this.cmdPlace(parsed.steps[0]);
                        }
                        break;
                    case "orient":
                        this.cmdOrient(parsed.steps[0]);
                        break;
                    case "discard":
                        this.cmdDiscard(parsed.steps[0]);
                        break;
                    // A bare "use" or "play" has nothing to play yet, which resolvePowerPlay reports as undefined.
                    case "use": {
                        const play = this.resolvePowerPlay(parsed);
                        owed = play === undefined ? undefined : this.cmdActivate(play, partial);
                        break;
                    }
                    case "play": {
                        const play = this.resolvePowerPlay(parsed);
                        owed = play === undefined ? undefined : this.cmdPlay(play, partial);
                        break;
                    }
                    // "decline" with nothing pending, or any other head with no business here, falls through with no case - a caller bug, not this dispatch's job.
                }
            }

            // A "last" may be declared on any sub-move of a still-open chain, not just the first - validateMove's own ALREADY_ANNOUNCED guards (both the
            // fresh-dispatch and continued-branch copies) are the only gate; bid/redraw/pass reject announceLast outright before ever reaching here.
            announceLast = parsed.announceLast;
            // A transient, unpersisted UI hint (not this.lastmove) answering "is there an in-progress preview right now" - cleared the moment a turn commits.
            this.preview = preview;
        }
 
        if (partial) {
            this.showUnrevealed();
            return this;
        }
        this.resolveHiddenEffects();
        if (announceLast) {
            newLast = this.currplayer;
            this.results.push({ type: "declare", count: this.getPlayerScore(this.currplayer) });
        }
        if (emulation) {
            return this;
        }

        // "?" marks a "place"-only click-preview facing as still merely prepopulated, dropped the instant a turn is actually committed.
        this.lastmove = m.replace(/\?/g, "");
        // undefined means no power ran or it stopped on an incomplete step.
        if (owed !== undefined) {
            this.continued = owed.map(o => GnosticaGame.owedToken(o));
        }
        // `head` is only assigned inside the parsed-dispatch branch above, so a literal "pass" falls into `else` below and gets the same nextPlayer()/checkEOG().
        if (head === "bid" || head === "redraw" || head === "pass") {
            //Need to rewrite these to remove this exception.
        } else if (this.continued.length > 0) {
            // Same seat still owes a follow-up submission - stay put; checkEOG() doesn't need to run either, since nothing it reads could have changed.
            // A "last" declared on this or an earlier sub-move is stored at the front of this.continued rather than in lastTurner itself.
            if (newLast === this.currplayer && this.lastTurner !== this.currplayer && this.continued[0] !== "last") {
                this.continued = ["last", ...this.continued];
            }
        } else {
            // Only on a real end-of-turn do we check the last turn announcement - this is also the ONE place a pending declare ever gets promoted into
            // lastTurner, at the same spot (and no sooner) a single-call declare-and-close always has been.
            if (this.lastTurner === this.currplayer) {
                this.results.push({ type: "announce", payload: ["declore", this.getPlayerScore(this.currplayer)] });
                const targetScore = (this.variants.includes("target-8") ? 8 : (this.variants.includes("target-10") ? 10 : 9));
                if (this.scoreFor(this.currplayer) >= targetScore) {
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

    // A previewed move must not reveal the deck, so each territory it would draw a card for is shown face-down.
    private showUnrevealed(): void {
        for (const effect of this.hidden) {
            if (effect.type === "territory") {
                this.board.createTerritory(effect.x, effect.y, UNREVEALED_CARD);
            } else if (effect.type === "trade") {
                // The player sees their old cards in the other hand, and none of the ones they get.
                const owner = this.board.get(effect.x, effect.y)!.pieces[effect.index].owner;
                const mine = this.hands[this.currplayer - 1];
                this.hands[this.currplayer - 1] = this.hands[owner - 1].map(() => UNREVEALED_UID);
                this.hands[owner - 1] = mine;
            }
        }
    }

    // Performs what move() recorded but a preview must not: every deck draw, in the order the steps recorded them, logging each into the step's own result group.
    private resolveHiddenEffects(): void {
        const ctx = this.buildPowerContext();
        for (const effect of this.hidden) {
            let result: APMoveResult;
            switch (effect.type) {
                case "flip":
                    result = { type: "deckDraw", what: fool(ctx).uid, from: "fool" };
                    break;
                case "territory": {
                    const card = createTerritoryFromDeck(ctx, effect.x, effect.y);
                    result = { type: "place", where: GnosticaBoard.coords2algebraic(effect.x, effect.y), how: "territory", what: card.uid };
                    break;
                }
                case "trade": {
                    const owner = this.board.get(effect.x, effect.y)!.pieces[effect.index].owner;
                    tradeHands(ctx, effect.x, effect.y, effect.index, this.hands[owner - 1]);
                    result = { type: "swap", where: GnosticaBoard.coords2algebraic(effect.x, effect.y), who: owner };
                    break;
                }
                case "draw": {
                    const drawn = drawCards(ctx, effect.count);
                    if (effect.setsCardsDrawn) {
                        this.cardsDrawn[this.currplayer - 1] = drawn;
                    }
                    result = { type: "deckDraw", count: drawn, from: "deck" };
                    break;
                }
            }
            const last = this.results[this.results.length - 1];
            if (effect.grouped !== true) {
                this.results.push(result);
            } else if (effect.joinsGroup === true && last?.type === "_group") {
                last.results.push(result);
            } else {
                this.results.push({ type: "_group", who: this.currplayer, results: [result] });
            }
        }
    }

    // English ordinal suffix (1st, 2nd, 3rd, ..., 11th-13th stay "th") - used only for the turn-order legend; plain TS formatting, not an i18next key.
    private static ordinal(n: number): string {
        //Here n is a number between 1 and 6.
        if (n === 1) return `${n}st`;
        if (n === 2) return `${n}nd`;
        if (n === 3) return `${n}rd`;
        return `${n}th`;
    }

    public parseMove(m: string): IParsedMove {
        const HEADWORDS = ["place", "orient", "discard", "use", "play", "decline", "bid", "redraw", "pass"];
        const STEPWORDS = ["discard", "draw", "orient", "skip", "with"];
        const OTHERWORDS = ["as", "at", "create", "draw", "fly", "grow", "last", "move", "orient", "replace", "shrink", "to", "trade", "via"];

        const CARD_UID_RE = /^((a|10|[2-9]|p|n|q|k)[crds]|\d{2})$/i;
        const CELL_RE = /^[a-z]{1,2}-?\d+$/i;
        const DIRECTION_RE = /^[NESWU]\??$/i;
        const PIECE_REF_RE = /^[a-z]{1,2}-?\d+(\.[1-3](\.[NESWU])?(\.[1-6])?)?$/;
        const MAJOR_ARCANA_RE = /^[0-1][0-9]|20|21$/i;
        const NUMBER_RE = /^[0-6]$/i; //Used for player Ids, card counts, bids, etc.
        const SUIT_RE = /^[CDRS]$/i;
        
        let trimmed = m.trim();
        const pm: IParsedMove = {
            announceLast: false,
            head: undefined,
            valid: true,
            steps: [],
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
                    if (headTokens[0] !== "01" && headTokens[0] !== "11" && headTokens[0] !== "21") {
                        pm.error = "AS_NEEDS_MAGICIAN_JUSTICE_OR_WORLD";
                        break;
                    }
                    while (headTokens.indexOf("as") > -1) {
                        const asIdx = headTokens.indexOf("as");
     
                        if (headTokens.length > asIdx + 1) {
                            const tempAs = headTokens[asIdx + 1];
                            if (tempAs.length === 1 && pm.asSuit === undefined)
                                // Provisional - not yet known to be a real suit letter until the SUIT_RE check below passes (which also normalizes its case).
                                pm.asSuit = tempAs as MinorSuitUid;
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
                        pm.error = "MAGICIAN_OR_JUSTICE_BAD_SUIT";
                        break;
                    }
                    if ( pm.asSuit !== undefined &&  headTokens[0] === "11" && pm.asSuit !== "S" ) {
                        //Bad suit for the Magician.
                        pm.error = "JUSTICE_WRONG_SUIT";
                        break;
                    }
                    if (pm.asSuit !== undefined) {
                        // SUIT_RE is case-insensitive, so "as c" parses as legal - normalize now, the one place a lowercase suit letter becomes the real MinorSuitUid.
                        pm.asSuit = pm.asSuit.toUpperCase() as MinorSuitUid;
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

            //Special case for skip.
            if (step.action === "skip") {
                if (segment.length > 0) {
                    pm.error = "STEP_TOO_LONG";
                    break;
                } else if (s !== 1) {
                    pm.error = "BAD_SKIP_TIMING";
                    break;
                } else if (lastStep) {
                    //Partial move.
                    step.complete = -1;
                    pm.steps.push(step);
                    break;
                } else {
                    pm.steps.push(step);
                    continue;
                }
            }
            
            //Non-skip steps require more content (except "pass" which was handled already)
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

                //With and at are required.
                if (step.withPiece === undefined || step.atCell === undefined) {
                    pm.error = "MISSING_CREATE_CONTENT";
                    break;
                }

                if ( CARD_UID_RE.test(tempwhat) )
                    step.card = tempwhat;
                else if ( DIRECTION_RE.test(tempwhat) )
                    step.direction = tempwhat.toUpperCase();
                else if ( PIECE_REF_RE.test(tempwhat) )
                    step.targetPiece = tempwhat;
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
                } else if (!lastStep && step.direction !== undefined && step.direction.length > 1) {
                    pm.error = "AMBIGUOUS_DIRECTION";
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
                    step.targetPiece = tempwhat;
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
                } else if ( step.action === "trade" ) {
                    step.complete = 1;
                    pm.steps.push(step);
                    continue;
                } else if ( lastStep ) {
                    // Replace still needs its facing.
                    step.complete = -1;
                    pm.steps.push(step);
                    break;
                } else {
                    pm.error = "MISSING_STEP_CONTENT";
                    break;
                }
            }

            if ( step.action === "grow" || step.action === "move" || step.action === "shrink" || step.action === "fly" ) {
                //Test tempwhat.
                if ( CELL_RE.test(tempwhat) )
                    step.targetCell = tempwhat.toLowerCase();
                else if ( CARD_UID_RE.test(tempwhat) )
                    step.card = tempwhat;
                else if ( PIECE_REF_RE.test(tempwhat) )
                    step.targetPiece = tempwhat;
                else {
                    pm.error = "BAD_STEP_CONTENT";
                    break;
                }

                if (step.action === "fly" && step.targetCell !== undefined) {
                    pm.error = "CANT_FLY_A_CELL";
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
                    if (step.action === "fly") {
                        pm.error = "CANT_FLY_A_DISTANCE";
                        break;
                    } else
                        step.amount = parseInt(nextseg, 10);
                    
                    if (segment.length > 0)
                        nextseg = segment.shift()!;
                    else {
                        //Can end with a number.
                        step.complete = 0;
                        pm.steps.push(step);
                        continue;
                    }
                } else if (step.action === "shrink" || step.action === "move") {
                    //No number but a number was needed for shrinks or moves.
                    if (segment.length === 0 && lastStep) {
                        //Partial move.
                        step.complete = -1;
                        pm.steps.push(step);
                        break;
                    } else {
                        pm.error = "MISSING_STEP_CONTENT";
                        break;
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
                        if ( CARD_UID_RE.test(tempdest) && step.action !== "fly") {
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
            
            // "with" is parseMove's placeholder action for a segment that so far only names its minion ref - the "with <ref>" prefix above already spells it.
            if (step.action !== "with") {
                ppart.push(step.action);
            }

            if (step.action !== "skip") {
            
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
            }// Returned from the skip exclusion.  The next two cases shouldn't apply to a skip.

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

    // Takes back the field a click supplied last, working only on the move's own text (not on what the game would have filled in): the reverse of pickleMove's order.
    private static retractStep(step: IStep): boolean {
        const clear = (...keys: (keyof IStep)[]): boolean => {
            const set = keys.filter(k => step[k] !== undefined);
            for (const k of set) {
                delete step[k];
            }
            return set.length > 0;
        };
        const dropLastCard = (): boolean => {
            if (step.cardList === undefined || step.cardList.length === 0) {
                return false;
            }
            step.cardList = step.cardList.slice(0, -1);
            return true;
        };
        switch (step.action) {
            case "grow": case "shrink": case "move":
                // A replaced territory is picked with its card, which sets the amount too.
                return clear("direction") || (step.card !== undefined && step.amount !== undefined ? clear("card", "amount") : clear("card") || clear("amount")) || clear("targetCell", "targetPiece");
            case "fly":
                return clear("direction") || clear("targetCell") || clear("card", "targetPiece");
            case "create":
                // Choosing the "own" option seeds the new piece's facing ("U?"), and a chosen facing goes back to that seed; the seed goes with the whole option.
                if (step.direction !== undefined && !step.direction.endsWith("?") && step.atCell !== undefined) {
                    step.direction = "U?";
                    return true;
                }
                if (step.direction?.endsWith("?")) {
                    step.action = "with";
                    delete step.atCell;
                    delete step.direction;
                    return true;
                }
                return clear("card", "direction", "targetPiece", "amount");
            case "place":
                // A cell click seeds its facing ("U?"), so a chosen facing goes back to the seed, and the seed goes with the cell.
                if (step.targetCell !== undefined && step.direction !== undefined && !step.direction.endsWith("?")) {
                    step.direction = "U?";
                    return true;
                }
                return clear("direction", "targetCell");
            case "orient": case "replace": {
                const target = step.targetPiece;
                if (clear("direction")) {
                    return true;
                }
                // An orient of the minion itself spells its ref once, so the minion goes with its target.
                if (step.withPiece === target) {
                    clear("withPiece");
                }
                return clear("targetPiece");
            }
            case "trade":
                return clear("targetPiece");
            case "draw": case "redraw":
                return dropLastCard();
            case "discard":
                return clear("amount") || dropLastCard();
            case "bid":
                return clear("amount");
            case "play": case "use": case "decline":
                return clear("card");
        }
        return false;
    }

    private static isBareStep(step: IStep): boolean {
        return Object.entries(step).every(([k, v]) => k === "action" || k === "complete" || v === undefined);
    }

    // The move with its latest decision taken back; an empty move has nothing left to take back.
    private retractedMove(parsed: IParsedMove): IParsedMove {
        if (parsed.head === undefined) {
            return { ...parsed, announceLast: false };
        }
        const steps: IStep[] = parsed.steps.map(step => ({ ...step, cardList: step.cardList?.slice() }));
        const emptied: IParsedMove = { ...parsed, head: undefined, steps: [], asUid: undefined, asSuit: undefined, viaUid: undefined };
        if (steps.length <= 1) {
            if (parsed.asSuit !== undefined) {
                return { ...parsed, steps, asSuit: undefined };
            }
            if (parsed.asUid !== undefined) {
                return { ...parsed, steps, asUid: undefined };
            }
            // A resume's own first step is what choosing Play or Decline supplied, so it goes back to the pair as a whole.
            if (steps.length === 0 || (parsed.viaUid !== undefined && parsed.head !== "discard") || !GnosticaGame.retractStep(steps[0])) {
                return emptied;
            }
            return parsed.viaUid !== undefined && GnosticaGame.isBareStep(steps[0]) ? emptied : { ...parsed, steps };
        }
        const step = steps[steps.length - 1];
        if (step.action === "skip" || !GnosticaGame.retractStep(step)) {
            if (step.action === "skip" || step.action === "with" || step.withPiece === undefined) {
                steps.pop();
            } else {
                // Back to naming only the minion; the cell it was to act at goes with the action.
                steps[steps.length - 1] = { action: "with", withPiece: step.withPiece };
            }
        } else if (step.withPiece === undefined) {
            steps.pop();
        }
        return { ...parsed, steps };
    }

    // What a resume submission names to say which obligation it answers: "via <uid>" for the Fool and High Priestess, the card itself for Justice.
    private resumeAnchor(parsed: IParsedMove): string | undefined {
        return parsed.viaUid ?? (this.getContinuedUid() === "11" ? parsed.steps[0]?.card : undefined);
    }

    // The verb a Justice resume has to start with: whichever the first turn used.
    private justiceHead(): "use" | "play" {
        return this.continued.some(t => t.startsWith("11.use")) ? "use" : "play";
    }

    // The innermost continued obligation's own uid ("00", "02" or "11") - the one a resume submission addresses and demotes into "via <uid>".
    // Ignores a leading "last" (a declare staged mid-chain) rather than relying on it always sitting exactly at the front.
    public getContinuedUid(): string | undefined {
        const real = this.continued.filter(t => t !== "last");
        return real[real.length - 1]?.split(".")[0];
    }

    // The card a continuation is waiting on: the obligation's own card, or for the Fool what its last flip revealed, as the last committed move logged it. undefined when nothing is pending.
    public activeCardUid(): string | undefined {
        const active = this.getContinuedUid();
        if (active !== "00") {
            return active;
        }
        const results = this.stack[this.stack.length - 1]._results.flatMap(r => r.type === "_group" ? r.results : [r]);
        return results.reverse().find((r): r is Extract<APMoveResult, { type: "deckDraw" }> => r.type === "deckDraw" && r.from === "fool")?.what;
    }

    // Whether a move headed `head` is a power in progress: a use or play, or anything while a resume is owed.
    private inPowerPlay(head: string | undefined): boolean {
        return head === "use" || head === "play" || this.continued.length > 0;
    }

    // How far an owed resume has got: nothing owed, owed with nothing clicked yet, Play clicked or a step of the revealed card typed, or Decline clicked.
    private resumePhase(): "none" | "owed" | "playing" | "declined" {
        if (this.continued.length === 0) {
            return "none";
        }
        if (this.preview === undefined) {
            return "owed";
        }
        return this.preview.head === "decline" ? "declined" : "playing";
    }

    // The move as the resume machinery reads it: as typed once it names the obligation owed, otherwise the bare seed (an empty or stale move). undefined when nothing is owed.
    private resumeMove(parsed?: IParsedMove): IParsedMove | undefined {
        if (this.continued.length === 0) {
            return undefined;
        }
        return parsed !== undefined && this.resumeAnchor(parsed) === this.getContinuedUid() ? parsed : this.freshResumeMove(false, parsed?.announceLast ?? false);
    }

    // The two trivial resume-seed shapes gnostica.ts itself ever needs: nothing typed yet, or a bare decline. Only randomMove.ts's own bot-move construction
    // (arbitrary raw-token chains, built with no move string to parse one from) needs the general buildViaMove found there.
    private freshResumeMove(decline = false, announceLast = false): IParsedMove {
        const activeUid = this.getContinuedUid()!;
        if (activeUid === "02") {
            // High Priestess can never decline (validateHighPriestess only accepts "discard"; no Decline button is ever offered for it).
            return { announceLast, valid: true, head: "discard", viaUid: activeUid, steps: [{ action: "discard", complete: -1 }] };
        }
        if (activeUid === "11") {
            const head = decline ? "decline" : this.justiceHead();
            return { announceLast, valid: true, head, asSuit: decline ? undefined : "S", steps: [{ action: head, card: "11" }] };
        }
        // "via 00" only ever names the Fool itself, so a Fool decline still has to name the REVEALED card separately ("decline AC via 00") - parseMove requires it to validate as complete.
        return {
            announceLast, valid: true,
            head: decline ? "decline" : "play",
            viaUid: activeUid,
            steps: [{ action: decline ? "decline" : "play", card: this.activeCardUid() }],
        };
    }

    private facingOpen(current: IPendingStep | undefined, advanced: IPendingStep | undefined): boolean {
        return current?.softComplete === true && this.pendingMode(current) !== undefined && advanced !== undefined && advanced.priorSteps.length > current.priorSteps.length;
    }

    private buildPreview(parsed: IParsedMove): IPreview {
        const step0 = parsed.steps[0];
        const head = parsed.head?.toLowerCase();
        const { current, advanced } = this.parsePendingStep(this.resumeMove(parsed) ?? parsed);
        return {
            head: parsed.head,
            highlighted: this.highlightedButtonValues(parsed),
            discardNeedsCount: head === "discard" && step0?.amount === undefined,
            orientPickCell: head === "orient" && step0?.targetPiece !== undefined && step0.direction === undefined && !step0.targetPiece.includes(".") ? step0.targetPiece : undefined,
            pending: advanced,
            facingOpen: this.facingOpen(current, advanced),
        };
    }

    private invalid(key: string, params?: Record<string, unknown>): IValidationResult {
        return { valid: false, complete: -1, message: i18next.t(key, params) };
    }

    private failureResult(failure: PowerFailure): IValidationResult {
        return this.invalid(`apgames:validation.gnostica.${failure.key}`, failure.params);
    }

    // Maps a failed resolvePieceRef() result to its validation message; `notFoundKey` lets a minion-selector report NOT_AN_ELIGIBLE_MINION instead of NO_SUCH_PIECE.
    private invalidPieceRef(kind: "not_found" | "ambiguous", ref: string | undefined, notFoundKey = "NO_SUCH_PIECE"): IValidationResult {
        switch (kind) {
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
            return { kind: "not_found" };
        }
        const segments = ref.toLowerCase().split(".");
        if (segments.length < 2 || segments.length > 4) {
            return { kind: "not_found" };
        }
        const [cellStr, pipsStr, ...rest] = segments;
        // PIECE_REF_RE (parseMove) already guarantees cellStr decodes cleanly - same cell grammar and case as CELL_RE.
        const [x, y] = GnosticaBoard.algebraic2coords(cellStr);
        const pips = parseInt(pipsStr, 10);
        if (Number.isNaN(pips) || pips < 1 || pips > 3) {
            return { kind: "not_found" };
        }
        let orientation: Orientation | undefined;
        let player: number | undefined;
        for (const tok of rest) {
            const upper = tok.toUpperCase();
            const asOrientation = (allOrientations as string[]).includes(upper) ? upper as Orientation : undefined;
            if (asOrientation !== undefined) {
                if (orientation !== undefined || player !== undefined) {
                    return { kind: "not_found" };
                }
                orientation = asOrientation;
                continue;
            }
            const asPlayer = parseInt(tok, 10);
            if (Number.isNaN(asPlayer) || player !== undefined) {
                return { kind: "not_found" };
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
        const { r, piece } = matches[0];
        // #98/#100: never hand back `r`'s stored index verbatim - a splice elsewhere can leave it stale; re-derive the CURRENT index by attribute, not identity.
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

    // Resolves a step's typed minionRef against `pool`: a full ref resolves definitively, a bare cell token narrows `candidates` and sets ambiguous.
    private resolveStepMinion(
        ref: string | undefined, pool: IMinionRef[],
    ): { minion: IMinionRef; ambiguous: boolean; candidates: IMinionRef[] } {
        if (pool.length <= 1) {
            return { minion: pool[0], ambiguous: false, candidates: pool };
        }
        const tok = ref?.toLowerCase();
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
    private powerStepMessageKey(headArg: string, priorStepsCount: number, minions: IMinionRef[], minionRef?: string): { key: string; params?: Record<string, unknown> } {
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
        // minionRef, when already typed (e.g. a minion picked via the ambiguity picker), is trusted directly rather than
        // re-deciding ambiguity from scratch - otherwise a card that STARTED with 2+ eligible minions never stops looking
        // ambiguous here even once the player has genuinely already chosen one, falling through to the generic CHOOSE_STEP
        // wording even though these specials have no button of their own to click.
        if (priorStepsCount === 0 && minions.length > 0) {
            const { minion, ambiguous } = this.resolveStepMinion(minionRef, minions);
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

    // "Incomplete" needs different wording depending on whether the target is chosen yet; undefined means "use the generic wording".
    private primitiveIncompleteMessage(suitUid: MinorSuitUid, step: IStep): { key: string; params?: Record<string, unknown> } | undefined {
        const mode = stepMinorMode(suitUid, step);
        if (mode === undefined) {
            // Rods' "tile" mode has no target token to hang a message off - falls back to the generic wording, same as any other still-choosing-a-mode state.
            return undefined;
        }
        if (mode === "piece" && (suitUid === "R" || suitUid === "S") && step.amount === undefined) {
            return { key: suitUid === "R" ? "apgames:validation.gnostica.PICK_DESTINATION_TO_SET_DISTANCE" : "apgames:validation.gnostica.PICK_PIPS_BUTTON" };
        }
        if (mode === "tile" && suitUid === "S" && step.card === undefined && step.amount === undefined) {
            return { key: "apgames:validation.gnostica.PICK_REPLACEMENT_OR_DESTROY" };
        }
        if (step.card === undefined && step.amount === undefined) {
            if (suitUid === "C" && mode === "new") {
                return { key: "apgames:validation.gnostica.PICK_CARD_FOR_NEW_TERRITORY" };
            }
            if (suitUid === "D" && mode === "tile") {
                return { key: "apgames:validation.gnostica.PICK_CARD_TO_GROW_TERRITORY" };
            }
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
        }
        if (cardUid === "11") {
            return { key: "apgames:validation.gnostica.JUSTICE_TRADE_READY" };
        } //else (cardUid === "00") {
        return { key: "apgames:validation.gnostica.FOOL_FLIP_READY" };
    }

    // The six top-level turn choices, as buttons - a bare click on an already-occupied cell/piece is ambiguous between "orient" and "use", with no way to disambiguate.
    private isPendingFirstPlacement(): boolean {
        // validateMove unconditionally rejects "place" once the acting player has ANY board presence, so a live "place" preview can only be their first piece.
        return this.preview?.head?.toLowerCase() === "place";
    }

    // Which top-level button(s) the partial move (or an owed resume) already reflects; "Declare" is a modifier so it is reported alongside whatever the base action is, not instead of it.
    private highlightedButtonValues(parsed: IParsedMove | undefined): Set<string> {
        const found = new Set<string>();
        if (parsed?.announceLast) {
            found.add("declare");
        }
        const head = parsed?.head;
        const step0 = parsed?.steps[0];
        // A discard move is Pass-equivalent only when it discards nothing AND explicitly draws zero
        if (head === "discard" && step0 !== undefined && ((step0.cardList === undefined || step0.cardList.length === 0) && step0.amount === 0)) {
            // "discard draw 0" is the user-facing pass, so Pass is the one taken.
            found.add("pass");
        } else if (this.continued.length > 0) {
            // The top-level button matches the resume: "Discard/Draw" for High Priestess, "Play Card" for Fool.
            found.add(this.getContinuedUid() === "02" ? "discard" : this.getContinuedUid() === "11" ? this.justiceHead() : "play");
        } else if (head !== undefined && ["place", "use", "play", "orient", "discard"].includes(head)) {
            found.add(head);
        }
        return found;
    }

    // Whether the power just started could be given up for the card's second one: a major card's first power still pending, whether the card was used, played, borrowed by the World or revealed by the Fool.
    private canSkipPending(pending: IPendingStep | undefined): boolean {
        // A Justice resumed for its attack has already taken its first power.
        const resumedJustice = pending?.activeCardUid === "11" && this.getContinuedUid() === "11";
        return pending !== undefined && !resumedJustice && pending.priorSteps.length === 0 && MAJOR_ARCANA[pending.activeCardUid] !== undefined
            && GnosticaGame.canSkipFirstPower(MAJOR_ARCANA[pending.activeCardUid]);
    }

    // Slots a "Skip Power" button in just before Declare whenever the first power of a card with a different second one is pending; a bar without Declare (the bare Play/Decline pair) is left alone.
    private withSkipPower(bar: [ButtonBarButton, ...ButtonBarButton[]] | undefined): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        const at = bar?.findIndex(b => b.value === "declare") ?? -1;
        if (bar === undefined || at < 0 || !this.canSkipPending(this.computePendingMinor())) {
            return bar;
        }
        return [...bar.slice(0, at), { label: "Skip Power", value: "skip" }, ...bar.slice(at)] as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Keeps the finished power's facing as it stands and begins the next step with a bare "with", nothing chosen for it: a seeded facing loses its "?", being chosen now.
    private settleFacing(parsed: IParsedMove): string {
        const steps = parsed.steps.map(step => ({ ...step }));
        const finished = steps[steps.length - 1];
        finished.direction = finished.direction?.replace("?", "");
        return `${this.pickleMove({ ...parsed, announceLast: false, steps })}/with${parsed.announceLast ? " last" : ""}`;
    }

    // While a finished power's piece can still be turned, board clicks turn it; Skip Reorient settles its facing so they can go on to the next power.
    private withSkipReorient(bar: [ButtonBarButton, ...ButtonBarButton[]] | undefined): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (bar === undefined || this.preview?.facingOpen !== true) {
            return bar;
        }
        // The next power can't start until the reorient is skipped, so its minion buttons wait too.
        const open = bar.filter(b => !b.value?.startsWith("minion_"));
        const at = open.findIndex(b => b.value === "declare");
        const skip: ButtonBarButton = { label: "Skip Reorient", value: "skip_reorient" };
        return (at < 0 ? [...open, skip] : [...open.slice(0, at), skip, ...open.slice(at)]) as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Undo ends every main-phase bar; crossed out, like any unavailable action, when the move has nothing to take back.
    private withUndo(bar: [ButtonBarButton, ...ButtonBarButton[]] | undefined): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (bar === undefined || this.phase !== "main") {
            return bar;
        }
        const undo: ButtonBarButton = { label: "Undo", value: "undo" };
        // There is something to take back once the move has an action or a declaration.
        if (this.preview === undefined || (this.preview.head === undefined && !this.preview.highlighted.has("declare"))) {
            undo.attributes = [{ name: "text-decoration", value: "line-through" }];
        }
        return [...bar, undo] as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Wraps computeActionButtons() to unconditionally fold a persisting "Decline X" into the bar, since a pending obligation's card can always be declined.
    private getActionButtons(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        const bar = this.withSkipReorient(this.withSkipPower(this.computeActionButtons()));
        const phase = this.resumePhase();
        if (bar === undefined || phase === "none") {
            return bar;
        }
        // this.continued always names a genuine obligation, so there's nothing further to distinguish here.
        if (bar.some(b => b.value === "decline_power")) {
            // Fool's own step has nothing else to offer, so computeActionButtons() already returns its explicit Play/Decline pair - nothing to add here.
            return bar;
        }
        // The state as ADVANCED by whatever's been clicked so far this render; `.special === "fool"` means clicks already ran a revealed card's steps.
        const advanced = this.computePendingMinor();
        const justDeclined = phase === "declined";
        // Declining is the alternative to playing the revealed card, so once Play is clicked or a step of it typed, the choice has been made.
        if (phase === "playing") {
            return bar;
        }
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
            // Greyed once clicked: the partial move already says it, and a second click would do nothing.
            declineBtn.fill = GREYED_BUTTON_FILL;
        }
        return [...bar, declineBtn] as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Pick one value from a small labeled set: available is plain, unavailable (a `disabledReason`, shared with minorModeAvailability) is crossed out, the `current` one is greyed.
    private buildChoiceButtons(prefix: string, options: ChoiceOption[], current: string | undefined): ButtonBarButton[] {
        return options.map(({ value, label, disabledReason }) => {
            const button: ButtonBarButton = { label, value: `${prefix}_${value}` };
            if (disabledReason !== undefined) {
                button.attributes = [{ name: "text-decoration", value: "line-through" }];
            } else if (value === current) {
                button.fill = GREYED_BUTTON_FILL;
            }
            return button;
        });
    }

    // Rod can never act while upright, so doom an upright candidate.
    private rodNeedsFacingReason(suitUid: MinorSuitUid | undefined, piece: Piece): { key: string } | undefined {
        return suitUid === "R" && piece.orientation === "U" ? { key: "ROD_NEEDS_FACING" } : undefined;
    }

    // The self-contained Play/Decline pair offered whenever a paused power has no button set of its own; reads the active card off the resume stack's top frame.
    private pausedPowerButtons(): [ButtonBarButton, ButtonBarButton] {
        const resumeQueue = this.resumeQueue()!;
        const activeUid = resumeQueue[resumeQueue.length - 1].cardUid;
        return [
            { label: `Play Card ${activeUid}`, value: "resume_power" },
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
        const phase = this.resumePhase();
        if (pendingMinor === undefined) {
            // A flip owed and then declined has nothing left to play, and the ordinary actions were never options: only Declare is left, and getActionButtons adds Decline.
            if (phase === "declined") {
                const declare = topLevel.find(b => b.value === "declare");
                return declare === undefined ? this.pausedPowerButtons() : [declare];
            }
            // A move already chosen and fully built (a power's last step, an orient, a discard): the other actions are no more options than mid-step.
            return this.chosenActionBar(topLevel);
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
            if (phase === "owed") {
                return this.pausedPowerButtons();
            }
            // A flip owed (a decline clicked, say) never had the ordinary actions as options, so only Declare is left, and getActionButtons adds Decline.
            if (phase !== "none") {
                return declareBtn === undefined ? this.pausedPowerButtons() : [declareBtn];
            }
            return this.chosenActionBar(topLevel);
        }

        const minionPicker = pendingMinor.game.minionPickerBar(pendingMinor, selected, declareBtn);
        if (minionPicker !== undefined) {
            return minionPicker;
        }
        // Still ambiguous but spanning more than one cell ("play"'s board-wide pool): a paused resume gets Play/Decline, anything else only the board click that picks the minion.
        if (pendingMinor.minionAmbiguous) {
            // An owed resume is still the bare Play/Decline pair until Play is clicked; after that it reads like a card played from the hand.
            if (phase === "owed") {
                return this.pausedPowerButtons();
            }
            const collapsed: ButtonBarButton[] = selected !== undefined ? [selected] : [];
            collapsed.push({ label: "Choose Minion", value: "_spacer", attributes: [{ name: "font-style", value: "italic" }] });
            if (declareBtn !== undefined) {
                collapsed.push(declareBtn);
            }
            return collapsed as [ButtonBarButton, ...ButtonBarButton[]];
        }

        const hpCount = pendingMinor.game.highPriestessCountBar(pendingMinor);
        if (hpCount !== undefined) {
            return hpCount;
        }
        const specialTargetPicker = pendingMinor.game.specialTargetPickerBar(pendingMinor, selected, declareBtn);
        if (specialTargetPicker !== undefined) {
            return specialTargetPicker;
        }
        // orientMinion/judgementDraw/worldUseAny are pure click-driven; tradeHands/orientAny/hierophantReplace fall back to click-driven only when unambiguous (see specialTargetPickerBar above).
        if (pendingMinor.special !== undefined && pendingMinor.special !== "hermitTeleport" && pendingMinor.special !== "magicianChoice") {
            // A click-only special power whose play has begun (fresh, or a resume once Play is clicked): just the action chosen, since the board or hand click that continues it is no button.
            if (phase !== "owed") {
                const only: ButtonBarButton[] = [...(selected !== undefined ? [selected] : []), ...(declareBtn !== undefined ? [declareBtn] : [])];
                return (only.length > 0 ? only : topLevel) as [ButtonBarButton, ...ButtonBarButton[]];
            }
            // A resume not yet begun: none of the ordinary 6 buttons are legal - offer the same self-contained Play/Decline pair the Fool-special branch above does.
            return this.pausedPowerButtons();
        }

        return pendingMinor.game.stepModeBar(pendingMinor, selected, declareBtn);
    }

    // A live "use"/"play" preview or genuine pendingPower obligation can never collapse to "Place" - a transient zero-piece moment shouldn't misread as a fresh start.
    private isPlaceOnlyState(): boolean {
        return (!this.inPowerPlay(this.preview?.head) && !this.hasPiecesOnBoard(this.currplayer)) || this.isPendingFirstPlacement();
    }

    // Once an action is chosen the bar keeps just it (greyed) and Declare; with no live preview, or nothing chosen, it is the whole ordinary set.
    private chosenActionBar(topLevel: ButtonBarButton[]): [ButtonBarButton, ...ButtonBarButton[]] {
        const chosen = this.preview === undefined ? [] : topLevel.filter(b => b.value !== undefined && b.value !== "declare" && this.preview!.highlighted.has(b.value));
        if (chosen.length === 0) {
            return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
        }
        const declare = topLevel.find(b => b.value === "declare");
        return (declare === undefined ? chosen : [...chosen, declare]) as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // The ordinary 6-button top-level choice, with the action already taken greyed per highlightedButtonValues - the fallback bar, and the seed every pendingMinor state further trims.
    private buildTopLevelBar(): ButtonBarButton[] {
        const topLevel: ButtonBarButton[] = [
            { label: "Use Territory", value: "use" },
            { label: "Play Card", value: "play" },
            { label: "Orient", value: "orient" },
            { label: "Discard/Draw", value: "discard" },
            { label: "Pass", value: "pass" },
        ];
        const highlighted = this.preview?.highlighted ?? this.highlightedButtonValues(undefined);
        // Declare is offered until someone has declared (committed, or staged in an open turn), and is a toggle, so once on it offers to undo itself rather than sit greyed.
        if (this.lastTurner === undefined && !this.continued.includes("last")) {
            topLevel.push({ label: highlighted.has("declare") ? "(Undeclare)" : "(Declare)", value: "declare" });
        }
        // A button the move already reflects is greyed; clicking it would do nothing (see clickActionButton).
        for (const b of topLevel) {
            if (b.value !== "declare" && b.value !== undefined && highlighted.has(b.value)) {
                b.fill = GREYED_BUTTON_FILL;
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
        if (this.preview?.discardNeedsCount !== true) {
            return undefined;
        }
        return this.drawCountBar("drawcount");
    }

    // Orient: a bare cell means 2+ of the player's own pieces share it and none has been picked yet - same shape "use"/"play" get via minionPickerBar.
    private orientAmbiguityBar(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        const cell = this.preview?.orientPickCell;
        if (cell === undefined) {
            return undefined;
        }
        const coords = GnosticaBoard.algebraic2coords(cell);
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

    // For a genuine resume, the preview's seed is a move string rebuilt from this.continued plus the typed segments; no "already reflected" bookkeeping needed.
    private computePendingMinor(): IPendingStep | undefined {
        if (this.preview !== undefined) {
            return this.preview.pending;
        }
        const seed = this.resumeMove();
        return seed === undefined ? undefined : this.parsePendingStep(seed).advanced;
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
    // `ownLast` moves the acting player's own pieces after everyone else's (Swords: destroying your own minion is the least likely pick).
    private pieceCandidateOptions(
        pending: IPendingStep, verb: string,
        opts: { disabledReason?: { key: string; params?: Record<string, unknown> }; includeSelf?: boolean; filter?: (piece: Piece) => boolean; ownLast?: boolean } = {},
    ): ChoiceOption[] {
        const { disabledReason, includeSelf = true, filter, ownLast = false } = opts;
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const cellPieces = this.board.get(tx, ty)?.pieces ?? [];
        const options: ChoiceOption[] = [];
        const own: ChoiceOption[] = [];
        const seen = new Set<string>();
        const pushPieceCandidate = (x: number, y: number, index: number): void => {
            const ref = this.pieceRefStr({ x, y, index });
            if (seen.has(ref)) {
                return;
            }
            seen.add(ref);
            const piece = this.board.get(x, y)!.pieces[index];
            const option = { value: ref, label: `${verb} ${this.ownerLabel(piece.owner)} ${this.textFormat(piece)}`, disabledReason };
            (ownLast && piece.owner === this.currplayer ? own : options).push(option);
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
        return [...options, ...own];
    }

    // Every target-piece button names whose piece it is, since size/facing alone (textFormat) can match across different opponents.
    private ownerLabel(owner: number): string {
        return owner === this.currplayer ? "own" : `Player ${owner}'s`;
    }

    // One candidate per real target for orientAny/tradeHands/hierophantReplace - tradeHands/hierophantReplace exclude self and require an enemy, matching pickPieceTargetClick's own rule.
    private specialTargetCandidates(pending: IPendingStep): ChoiceOption[] {
        if (pending.special === "orientAny") {
            return this.pieceCandidateOptions(pending, "Orient");
        }
        const verb = pending.special === "tradeHands" ? "Trade with" : "Replace";
        return this.pieceCandidateOptions(pending, verb, { includeSelf: false, filter: p => p.owner !== this.currplayer });
    }

    // One candidate per real target for a fresh suit-power step - the tile at minorTargetCell plus every piece there, or Cups' "own"/every enemy piece/"new"; one click supplies mode + target.
    private suitTargetCandidates(pending: IPendingStep, suitUid: MinorSuitUid): ChoiceOption[] {
        const availability = this.minorModeAvailability(pending);
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        if (suitUid === "C") {
            const cellPieces = this.board.get(tx, ty)?.pieces ?? [];
            const options: ChoiceOption[] = [{ value: "own", label: "Create Minion", disabledReason: availability.get("own") }];
            // The new piece is a gift added to the referenced enemy's own side, not a capture of anything - see applyCups' "enemy" case.
            const enemyEntries: ChoiceOption[] = [];
            cellPieces.forEach((p, index) => {
                if (p.owner !== this.currplayer) {
                    enemyEntries.push({ value: this.pieceRefStr({ x: tx, y: ty, index }), label: `Create Enemy ${this.ownerLabel(p.owner)} ${this.textFormat(p)}`, disabledReason: availability.get("enemy") });
                }
            });
            if (enemyEntries.length > 0) {
                options.push(...enemyEntries);
            } else {
                // No enemy piece to reference right now - still show the option, struck through, matching "own"/"new"'s own always-present buttons.
                options.push({ value: "enemy", label: "Create Enemy", disabledReason: availability.get("enemy") });
            }
            options.push({ value: "new", label: "Create Territory", disabledReason: availability.get("new") });
            return options;
        }
        const { verb, tile } = RDS_TARGET_LABELS[suitUid];
        return [
            { value: targetCell, label: tile, disabledReason: availability.get("tile") },
            ...this.pieceCandidateOptions(pending, verb, { disabledReason: availability.get("piece"), ownLast: suitUid === "S" }),
        ];
    }

    // Hermit's own twin of suitTargetCandidates - same tile-plus-self-plus-every-co-located-piece enumeration.
    private hermitTargetCandidates(pending: IPendingStep): ChoiceOption[] {
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        return [
            { value: targetCell, label: "Teleport Territory" },
            ...this.pieceCandidateOptions(pending, "Teleport"),
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
            if (suitUid === "S" && stepMinorMode("S", pendingMinor.istep) === "tile" && pendingMinor.istep.card === undefined) {
                const [tx, ty] = GnosticaBoard.algebraic2coords(pendingMinor.istep.targetCell!);
                const size = (pendingMinor.minion.piece ?? this.board.get(pendingMinor.minion.x, pendingMinor.minion.y)!.pieces[pendingMinor.minion.index]).size;
                const current = this.board.get(tx, ty)?.pointValue() ?? 0;
                if (current > 0 && current <= size * (pendingMinor.opts.bothSwords === true ? 2 : 1)) {
                    buttons.push({ label: "Destroy Territory", value: "destroy" });
                }
            }
            // Swords pips is pure damage, no destination cell to click (unlike Rods' distance), so it's a button set once a target is chosen.
            if (suitUid === "S" && stepMinorMode("S", pendingMinor.istep) === "piece") {
                buttons.push(...this.buildChoiceButtons("pips", this.swordsPipsOptions(pendingMinor), pendingMinor.istep.amount?.toString()));
            }
        }
        if (declareBtn !== undefined) {
            buttons.push(declareBtn);
        }
        return buttons as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // The attack amounts a Swords piece step offers, each crossed out when the victim's owner couldn't take the shrunken piece back from their stash.
    private swordsPipsOptions(pending: IPendingStep): ChoiceOption[] {
        const minionPiece = pending.minion.piece ?? this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        // Anything past the victim's own pips is the same wipeout (or, with one sword, rejected), so it isn't offered.
        const target = pending.game.resolvePieceRef(pending.istep.targetPiece);
        const victim = target.kind === "ok" ? target.ref.piece ?? pending.game.board.get(target.ref.x, target.ref.y)?.pieces[target.ref.index] : undefined;
        const maxPips = Math.min(minionPiece.size * (pending.opts.bothSwords === true ? 2 : 1), victim?.size ?? Infinity);
        const ctx = pending.game.buildPowerContext();
        const options: ChoiceOption[] = [];
        for (let n = maxPips; n >= 1; n--) {
            const left = victim === undefined ? 0 : victim.size - n;
            const stashEmpty = victim !== undefined && left > 0 && !hasStashAvailable(ctx, victim.owner, left as Pips);
            options.push({ value: String(n), label: `Attack for ${n}`, disabledReason: stashEmpty ? { key: "STASH_EMPTY", params: { playerNum: victim.owner, size: left } } : undefined });
        }
        return options;
    }

    public primitiveToSuit(primitive: SuitPrimitive): MinorSuitUid {
        return primitive === "create" ? "C" : primitive === "move" ? "R" : primitive === "grow" ? "D" : "S";
    }

    // The current step's own minor-arcana mode (own/enemy/new/piece/tile), derived from `istep` - undefined for a plain special step (no suitUid) or a not-yet-shaped primitive/magicianChoice step.
    private pendingMode(pending: IPendingStep): MinorMode | undefined {
        return pending.suitUid === undefined ? undefined : stepMinorMode(pending.suitUid, pending.istep);
    }

    // Whether NOTHING has been typed yet for `pending`'s own special step, beyond the bare minion ref (if any).
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

    // What a use, play or resume is playing, resolved once from the move and the game state (a resume reads as a play of the card it waits on); undefined when there is nothing to play.
    private resolvePowerPlay(parsed: IParsedMove): IPowerPlay | undefined {
        // A "via <uid>" marker dispatches from the Fool/HP anchor for a genuine resume; otherwise the front card token. "as <x>" never moves the head arg.
        let headArg = parsed.viaUid ?? parsed.steps[0]?.card;
        if (headArg === undefined) {
            return undefined;
        }
        // A genuine resume is detected from the "via <root>" anchor matching this.continued; for button-building it always plays the active card, so `head` is "play".
        const resume = this.continued.length > 0 && this.resumeAnchor(parsed) === this.getContinuedUid();
        // High Priestess resumes with its own content right after "discard", not a "/"-segment - resumeSteps folds it back so the walk sees it.
        const steps = resume ? this.resumeSteps(parsed) : parsed.steps.slice(1);
        if (resume) {
            // A "discard" resume is a High Priestess round (not a card); a "play" resume names the revealed card as its front token.
            headArg = parsed.head === "discard" ? parsed.viaUid! : (parsed.steps[0]?.card ?? parsed.viaUid!);
        }
        if (!resume && parsed.head !== "use" && parsed.head !== "play") {
            return undefined;
        }
        // A resumed Justice keeps the verb its first turn used, which decides who may act; every other resume is a play.
        const head: "use" | "play" = resume ? (headArg === "11" && parsed.head === "use" ? "use" : "play") : parsed.head as "use" | "play";
        let card: Card | undefined;
        let eligible: IMinionRef[];
        // A card revealed by Fool (headArg names it directly for a resume) is always play-pool eligible regardless.
        if (resume) {
            card = allCards().find(c => c.uid === headArg);
            eligible = this.eligibleMinionsForOwed(GnosticaGame.owedFromToken(this.continued.filter(t => t !== "last").pop()!));
        } else if (head === "use") {
            const loc = this.findCardCell(headArg);
            if (loc === undefined) {
                return undefined;
            }
            card = this.board.get(loc.x, loc.y)?.card;
            eligible = this.eligibleMinionsForActivate(loc.x, loc.y);
        } else {
            card = allCards().find(c => c.uid === headArg);
            eligible = this.eligibleMinionsForPlay();
        }
        // asUid (World's borrow) and asSuit (Magician's suit) are separate fields throughout; a World-pushed Magician frame can have both set at once.
        return {
            head, headArg, card, resume, eligible, steps, asUid: parsed.asUid, asSuit: parsed.asSuit,
            frames: resume ? this.resumeQueue()! : [{ cardUid: headArg, nextStepIndex: 0, minions: [...eligible] }],
            rootUid: resume ? this.getContinuedUid()! : headArg,
            owed: resume ? this.owedFromContinued() : [],
        };
    }

    // Reconstructs the in-progress power step (if any) purely from a move string.  Checks step segments for STRUCTURAL completeness,  also stopping at Fool or World.
    // `current` treats a complete last-typed segment as still the step being refined (board clicks keep adjusting it); `advanced` walks past it to the next step.
    // They are the same object unless that last segment is already complete.
    private parsePendingStep(parsed: IParsedMove): { current?: IPendingStep; advanced?: IPendingStep } {
        const holder: { clone?: GnosticaGame } = {};
        const { held, advanced } = this.walkPendingStep(parsed, holder);
        const advancedStep = advanced === undefined ? undefined : { ...advanced, game: holder.clone ?? this.scratchClone() };
        return { current: held === undefined ? advancedStep : { ...held.pending, game: held.game }, advanced: advancedStep };
    }

    // The walk goes on to apply the held step's own segment, which reorients the very Piece objects its minion snapshots point at; the held view needs its own copies.
    private static detachPieces(pending: Omit<IPendingStep, "game">): Omit<IPendingStep, "game"> {
        const detach = (m: IMinionRef): IMinionRef => m.piece === undefined ? m : { ...m, piece: m.piece.clone() };
        return { ...pending, eligible: pending.eligible.map(detach), minions: pending.minions.map(detach), minion: detach(pending.minion), minionCandidates: pending.minionCandidates.map(detach) };
    }

    // `held` is the step as it stood BEFORE the complete last segment was walked past (with its own copy of the game, since the walk goes on mutating `holder.clone`).
    private walkPendingStep(parsed: IParsedMove, holder: { clone?: GnosticaGame }): { held?: { pending: Omit<IPendingStep, "game">; game: GnosticaGame }; advanced?: Omit<IPendingStep, "game"> } {
        // "decline" is already a complete choice - no step for a button set to configure, so the bar falls back to plain top-level context.
        if (parsed.head === "decline") {
            return {};
        }
        const play = this.resolvePowerPlay(parsed);
        if (play === undefined || play.card === undefined || play.eligible.length === 0) {
            return {};
        }
        const { head, headArg, card, eligible, steps, asUid, asSuit } = play;
        const worldBorrow = asUid !== undefined;
        // Everything the walk reads about the hand and discards is from a copy that has already played the card.
        holder.clone ??= this.scratchForPlay(play);
        if (!card.major) {
            if (steps[0]?.action === "skip") {
                return {}; // a minor card has no power to skip; validateMove reports it
            }
            const suitUid = suitUidOf(card);
            const istep: IStep = steps[0] ?? { action: "with" };
            const { minion, ambiguous, candidates } = this.resolveStepMinion(istep.withPiece, eligible);
            return { advanced: { head, headArg, activeCardUid: headArg, suitUid, eligible, minions: eligible, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps: [], opts: {}, istep, announceLast: parsed.announceLast } };
        }

        // A resolution stack local to this UI-only walk - `eligible` (frozen at push time) stays tracked separately from `minions` (which keeps accreting).
        const stack: { cardUid: string; nextStepIndex: number; eligible: IMinionRef[]; minions: IMinionRef[] }[] =
            play.frames.map(f => ({ cardUid: f.cardUid, nextStepIndex: f.nextStepIndex, eligible: [...f.minions], minions: [...f.minions] }));

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
        // False right after a power was skipped (a later power of the card used alone); true once a step has been walked past.
        let priorTaken = true;
        let held: { pending: Omit<IPendingStep, "game">; game: GnosticaGame } | undefined;
        for (let segIdx = 0; segIdx < steps.length; segIdx++) {
            const top = stack[stack.length - 1];
            if (top === undefined) {
                return { held }; // too many steps already typed - validateMove/move report this properly on submit
            }
            const frameDef = this.resolveFrameDef(top.cardUid);
            if (top.nextStepIndex >= frameDef.powers.length) {
                return { held }; // defensive - popExhaustedFrames keeps this in sync below
            }
            if (steps[segIdx].action === "skip") {
                if (top.nextStepIndex !== 0 || !GnosticaGame.canSkipFirstPower(frameDef)) {
                    return { held }; // validateMove reports it
                }
                priorSteps.push(steps[segIdx]);
                top.nextStepIndex++;
                priorTaken = false;
                continue;
            }
            // A typed step spelled as a later power of the card skips the powers before it (see skipAheadTarget).
            const skipTarget = GnosticaGame.skipAheadTarget(frameDef, top.nextStepIndex, steps[segIdx]);
            if (skipTarget !== top.nextStepIndex) {
                top.nextStepIndex = skipTarget;
                priorTaken = false;
            }
            const stepIndex = top.nextStepIndex;
            const step = frameDef.powers[stepIndex];
            if ("special" in step && step.special === "fool") {
                // Fool's own step always auto-resolves the instant it's next in line on a real commit - nothing here for a click to build.
                return { held };
            }
            const isLastSegment = segIdx === steps.length - 1;
            // Set in whichever branch below falls through (step complete) - the IStep this segment becomes.
            let completedStep: IStep | undefined;
            if ("primitive" in step) {
                const suitUidForStep = this.primitiveToSuit(step.primitive);
                const opts = this.computeShortcutOpts(frameDef, step.primitive, stepIndex, frameDef.powers.length, step.opts);
                const istepSoFar: IStep = steps[segIdx] ?? { action: "with" };
                const stepHere = (): Omit<IPendingStep, "game"> => {
                    const { minion, ambiguous, candidates } = (holder.clone ?? this).resolveStepMinion(istepSoFar.withPiece, top.minions);
                    return { head, headArg, activeCardUid: top.cardUid, asUid, asSuit, suitUid: suitUidForStep, eligible: top.eligible, minions: top.minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps: [...priorSteps], opts, istep: istepSoFar, announceLast: parsed.announceLast };
                };
                if ((istepSoFar.complete ?? -1) < 0) {
                    return { advanced: stepHere() };
                }
                if (isLastSegment) {
                    held = { pending: GnosticaGame.detachPieces(stepHere()), game: (holder.clone ?? this).scratchClone() };
                }
                completedStep = istepSoFar;
            } else {
                // A Magician's suit choice lives in asSuit, unless worldBorrow lets a chained frame supply it.
                const magicianNeedsAs = step.special === "magicianChoice" && asSuit === undefined && !worldBorrow;
                // A Magician borrow's step needs no splicing once the suit is known: "at m0 create U" parses the same regardless of suit.
                const istepSoFar: IStep = steps[segIdx] ?? { action: "with" };
                // A High Priestess discard list stays editable right up until Submit, so it is never "complete" here.
                const complete = magicianNeedsAs || step.special === "highPriestess" ? false : (istepSoFar.complete ?? -1) >= 0;
                const stepHere = (): Omit<IPendingStep, "game"> =>
                    this.buildSpecialPending(holder.clone ?? this, step.special, head, headArg, top.cardUid, top.eligible, top.minions, [...priorSteps], istepSoFar, asUid, asSuit, parsed.announceLast);
                if (!complete) {
                    return { advanced: stepHere() };
                }
                if (isLastSegment) {
                    held = { pending: GnosticaGame.detachPieces(stepHere()), game: (holder.clone ?? this).scratchClone() };
                }
                completedStep = istepSoFar;
            }
            // Walking past this segment lets a LATER step of the SAME frame become click-driven, via a clone.
            priorSteps.push(completedStep!);
            holder.clone ??= this.scratchClone();
            const clone = holder.clone;
            // A magicianChoice step needs its suit passed as `borrowedPower` here.
            const magicianAs = "special" in step && step.special === "magicianChoice" && asSuit !== undefined;
            const outcome = clone.applyPowerStep(step, top.minions, completedStep, frameDef, stepIndex, frameDef.powers.length, true, magicianAs ? asSuit : undefined, true, priorTaken);
            priorTaken = true;
            if (isLastSegment && held !== undefined) {
                held.pending.softComplete = outcome?.softComplete === true;
            }
            top.minions = GnosticaGame.chainMinion(top.minions, outcome ?? {});
            top.nextStepIndex = outcome?.consumesRest ? frameDef.powers.length : top.nextStepIndex + 1;
            if (outcome?.pushFrame !== undefined) {
                stack.push({ cardUid: outcome.pushFrame.cardUid, nextStepIndex: 0, eligible: [...outcome.pushFrame.minions], minions: [...outcome.pushFrame.minions] });
            }
            GnosticaGame.popExhaustedFrames(clone, stack);
        }
        const top = stack[stack.length - 1];
        if (top === undefined) {
            return { held }; // every step already complete - nothing left to click for
        }
        const frameDef = this.resolveFrameDef(top.cardUid);
        const stepIndex = top.nextStepIndex;
        if (stepIndex >= frameDef.powers.length) {
            return { held };
        }
        const step = frameDef.powers[stepIndex];
        if ("primitive" in step) {
            const suitUid = this.primitiveToSuit(step.primitive);
            const opts = this.computeShortcutOpts(frameDef, step.primitive, stepIndex, frameDef.powers.length, step.opts);
            const { minion, ambiguous, candidates } = (holder.clone ?? this).resolveStepMinion(undefined, top.minions);
            return { held, advanced: { head, headArg, activeCardUid: top.cardUid, asUid, asSuit, suitUid, eligible: top.eligible, minions: top.minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts, istep: { action: "with" }, announceLast: parsed.announceLast } };
        }
        return { held, advanced: this.buildSpecialPending(holder.clone ?? this, step.special, head, headArg, top.cardUid, top.eligible, top.minions, priorSteps, { action: "with" }, asUid, asSuit, parsed.announceLast) };
    }

    // Builds the `special`-flavored branch of IPendingStep, with an exception for magicianChoice once its suit is chosen, which is treated as a plain suit step.
    private buildSpecialPending(
        ctx: GnosticaGame, special: SpecialPower, head: "use" | "play", headArg: string, activeCardUid: string,
        eligible: IMinionRef[], minions: IMinionRef[], priorSteps: IStep[], istep: IStep, asUid?: string, asSuit?: MinorSuitUid, announceLast = false,
    ): Omit<IPendingStep, "game"> {
        if (special === "magicianChoice" && asSuit !== undefined) {
            const { minion, ambiguous, candidates } = ctx.resolveStepMinion(istep.withPiece, minions);
            return { head, headArg, activeCardUid, asUid, asSuit, suitUid: asSuit, eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts: {}, istep, announceLast };
        }
        // Fool/High Priestess/worldUseAny have no minionRef here; an unchosen magicianChoice also defers its minion choice until after the suit is picked (its
        // own button set needs to show before any ambiguous-minion picker would - see the "2+ minions... suit buttons first" regression test).
        const noMinionRef = special === "highPriestess" || special === "fool" || special === "worldUseAny" || special === "magicianChoice";
        const { minion, ambiguous, candidates } = noMinionRef
            ? { minion: minions[0], ambiguous: false, candidates: minions }
            : ctx.resolveStepMinion(istep.withPiece, minions);
        return { head, headArg, activeCardUid, asUid, asSuit, special, eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts: {}, istep, announceLast };
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
    // With a pool, the owner's other pieces in the cell count too: a later step may resolve the ref against all of the owner's pieces, not only the pool.
    public pieceRefStr(minion: IMinionRef, pool?: IMinionRef[]): string {
        const { x, y, index } = minion;
        const piece = minion.piece ?? this.board.get(x, y)!.pieces[index];
        const cell = GnosticaBoard.coords2algebraic(x, y);
        let candidateRefs: IMinionRef[];
        if (pool === undefined) {
            candidateRefs = (this.board.get(x, y)?.pieces ?? []).map((_, i): IMinionRef => ({ x, y, index: i }));
        } else {
            candidateRefs = pool.filter(p => p.x === x && p.y === y);
            (this.board.get(x, y)?.pieces ?? []).forEach((p, i) => {
                if (p.owner === piece.owner && !candidateRefs.some(r => r.index === i)) {
                    candidateRefs.push({ x, y, index: i });
                }
            });
        }
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
    public minorModeAvailability(pending: { suitUid?: MinorSuitUid; minion: IMinionRef; opts: Record<string, unknown> }): Map<MinorMode, { key: string; params?: Record<string, unknown> } | undefined> {
        // Only ever called for a suit-shaped pending - suitUid is guaranteed set here.
        const suitUid = pending.suitUid!;
        const minion = pending.minion.piece ?? this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetT = this.board.get(tx, ty);
        const cell = GnosticaBoard.coords2algebraic(tx, ty);
        const hand = this.hands[this.currplayer - 1];
        const result = new Map<MinorMode, { key: string; params?: Record<string, unknown> } | undefined>();
        const minorModeNames: MinorMode[] = suitUid === "C" ? ["own", "enemy", "new"] : ["piece", "tile"];
        for (const mode of minorModeNames) {
            switch (`${suitUid}.${mode}`) {
                case "C.own": {
                    if (!(targetT === undefined || targetT.canAdd(pending.opts.ignoreCapacity === true))) {
                        result.set(mode, { key: "CELL_FULL" });
                        break;
                    }
                    const ctx = this.buildPowerContext();
                    const stashOk = pending.opts.skipStashCheck === true || hasStashAvailable(ctx, this.currplayer, 1);
                    result.set(mode, stashOk ? undefined : { key: "STASH_EMPTY", params: { playerNum: this.currplayer, size: 1 } });
                    break;
                }
                case "C.enemy":
                    result.set(mode, (targetT?.pieces ?? []).some(p => p.owner !== this.currplayer)
                        ? undefined : { key: "NO_ENEMY_THERE", params: { cell } });
                    break;
                case "C.new":
                    if (this.board.classify(tx, ty) !== "wasteland") {
                        result.set(mode, { key: "NOT_A_WASTELAND" });
                    } else if (pending.opts.allowRandomDraw === true || handHasCardOfValue(hand, 1) || (pending.opts.allowRoyalty === true && handHasCardOfValue(hand, 2))) {
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
                    const pile = pending.opts.replacementSource === "discard" ? [...hand, ...this.discardPile] : hand;
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
                    const pile = pending.opts.replacementSource === "discard" ? [...hand, ...this.discardPile] : hand;
                    let ok = false;
                    for (let p = 1; p <= minion.size * (pending.opts.bothSwords === true ? 2 : 1); p++) {
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
        const base = { announceLast: pending.announceLast, valid: true };
        // A genuine resume always carries a "via <root>".
        if (this.continued.length > 0) {
            // High Priestess's second step is a discard/draw.
            if (pending.special === "highPriestess") {
                const step: IStep = { ...(steps[steps.length - 1] ?? { action: "discard" }), action: "discard" };
                return this.pickleMove({ ...base, head: "discard", viaUid: this.getContinuedUid(), steps: [step] });
            }
            const headStep: IStep = { action: pending.head, card: pending.headArg };
            // A Justice resume has no "via"; it is the card itself, played "as S".
            if (this.getContinuedUid() === "11") {
                return this.pickleMove({ ...base, head: pending.head, asSuit: "S", steps: [headStep, ...steps] });
            }
            return this.pickleMove({ ...base, head: pending.head, asUid, asSuit, viaUid: this.getContinuedUid(), steps: [headStep, ...steps] });
        }
        const headStep: IStep = { action: pending.head, card: pending.headArg };
        return this.pickleMove({ ...base, head: pending.head, asUid, asSuit, steps: [headStep, ...steps] });
    }

    // Assembles a full move string from a pending step's own already-typed prior power-step IStep's plus the current one
    private assembleStepMove(pending: IPendingStep, currentStep: IStep): string {
        return this.describePendingMove(pending, [...pending.priorSteps, currentStep]);
    }

    // The bare step for a special power whose minion is chosen and nothing else is yet - just its action and minion ref.
    private anchorStep(special: SpecialPower, ref: string): IStep {
        switch (special) {
            // orientMinion's acting minion is also its target, so pickle omits the "with" prefix (the bare "orient <ref>" grammar).
            case "orientMinion": return { action: "orient", withPiece: ref, targetPiece: ref };
            case "tradeHands": return { action: "trade", withPiece: ref };
            case "orientAny": return { action: "orient", withPiece: ref };
            case "hierophantReplace": return { action: "replace", withPiece: ref };
            case "hermitTeleport": return { action: "fly", withPiece: ref };
            case "judgementDraw": return { action: "draw", withPiece: ref, cardList: [] };
            case "magicianChoice": return { action: "create", withPiece: ref };
            default: return { action: special, withPiece: ref };
        }
    }

    // The minion is chosen but nothing else about this step is yet - every IStep needs SOME action, so this seeds just a bare "with <ref>" anchor, mirroring parseMove's own tolerance.
    private buildAnchorMove(pending: IPendingStep, ref: string): string {
        if (pending.special !== undefined) {
            return this.assembleStepMove(pending, this.anchorStep(pending.special, ref));
        }
        return this.assembleStepMove(pending, { action: "with", withPiece: ref });
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
                step = { action: "create", withPiece: minionRef, atCell: targetCell, direction: "U?" };
            } else if (targetRef === "new") {
                step = { action: "create", withPiece: minionRef, atCell: targetCell };
            } else {
                step = { action: "create", withPiece: minionRef, atCell: targetCell, targetPiece: targetRef };
            }
            return this.assembleStepMove(pending, step);
        }
        const minionPiece = pending.minion.piece ?? this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        // A size-1 minion has only one legal dist/pips value, supplied here; a size>1 minion is left unset so the step reads as still-incomplete, not a guessed default.
        const onlyCount = minionPiece.size === 1 ? 1 : undefined;
        const isPieceTarget = targetRef.includes(".");
        // suitUid is narrowed to R/D/S here (the "C" branch above already returned) - RDS_VERBS has an entry for all three, just not typed that way since Cups genuinely has none.
        const action = RDS_VERBS[suitUid]!;
        let step: IStep;
        if (suitUid === "D") {
            step = isPieceTarget ? { action, withPiece: minionRef, targetPiece: targetRef } : { action, withPiece: minionRef, targetCell };
        } else if (isPieceTarget) {
            step = { action, withPiece: minionRef, targetPiece: targetRef };
            if (onlyCount !== undefined) {
                step.amount = onlyCount;
            }
        } else if (suitUid === "R") {
            // Rods' "tile" mode always seeds a real distance of 1 - a further destination-cell click is how the player reaches any distance beyond 1.
            step = { action, withPiece: minionRef, targetCell, amount: 1 };
        } else {
            // A territory's shrink is set by the replacement card (or the Destroy button), not chosen up front.
            step = { action, withPiece: minionRef, targetCell };
        }
        return this.assembleStepMove(pending, step);
    }

    // Hermit's version of buildTargetedStepMove.
    private buildTargetedHermitMove(pending: IPendingStep, targetRef: string): string {
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        if (targetRef.includes(".")) {
            return this.assembleStepMove(pending, { action: "fly", withPiece: minionRef, targetPiece: targetRef });
        }
        const cardUid = this.board.get(...this.minorTargetCell(pending.minion))?.cardUid;
        const step: IStep = { action: "fly", withPiece: minionRef };
        if (cardUid !== undefined) {
            step.card = cardUid;
        }
        return this.assembleStepMove(pending, step);
    }

    // Board-click handling once a minor-arcana power step's MODE is already chosen - cycling or switching whichever trailing arg(s) that mode's shape supports.
    private handlePendingStepBoardClick(pending: IPendingStep, x: number, y: number): string | IClickResult | undefined {
        if (this.pendingMode(pending) === undefined) {
            return undefined;
        }
        // Only ever called for a suit-shaped pending - suitUid is guaranteed set here.
        const suitUid = pending.suitUid!;
        const mode = this.pendingMode(pending)!;
        // Fills the rebuilt move's selector slot; the "piece"-shape branch's own self-or-facing target instead goes through pickPieceTargetClick.
        const minionRef = this.pieceRefStr(pending.minion, pending.minions);
        const minionPiece = pending.minion.piece ?? this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        // Only ever reached for R/D/S - every Cups branch below returns early instead (so RDS_VERBS always has an entry here). Always a fresh step, so stale trailing fields (e.g. a facing correction) drop off.
        const rebuild = (fields: Partial<IStep>): string =>
            this.assembleStepMove(pending, { action: RDS_VERBS[suitUid]!, withPiece: minionRef, ...fields });

        if (mode !== "piece") {
            const [tx, ty] = this.minorTargetCell(pending.minion);
            // Cups "own" is the one cell-shape mode with an orientation arg; a click here sets the OPTIONAL 3rd token, over the target cell PLUS its neighbours.
            if (suitUid === "C" && mode === "own") {
                const dir = this.orientationTowardClick(tx, ty, x, y);
                if (dir === undefined) {
                    return undefined;
                }
                const cell = GnosticaBoard.coords2algebraic(tx, ty);
                // Cups carries no mode word - built directly here instead of via `rebuild`, which would wrongly splice "own" back in.
                return this.assembleStepMove(pending, { action: "create", withPiece: minionRef, atCell: cell, direction: dir });
            }
            // Rods' "tile" mode: the cell is fixed (the facing cell) - a click instead sets DISTANCE, anchored on the facing cell rather than a chosen piece target.
            if (suitUid === "R") {
                const [dx, dy] = this.board.delta(minionPiece.orientation as Exclude<Orientation, "U">);
                for (let n = 1; n <= minionPiece.size; n++) {
                    if (x === tx + dx * n && y === ty + dy * n) {
                        return rebuild({ targetCell: pending.istep.targetCell!, amount: n });
                    }
                }
                return undefined;
            }
            if (x !== tx || y !== ty) {
                return undefined;
            }
            // "new" (Cups) - the only remaining arg is a hand-card uid, nothing to cycle here; "enemy"'s victim is already chosen the instant the mode is inferred.
            if (suitUid === "C") {
                return mode === "new" ? this.assembleStepMove(pending, { action: "create", withPiece: minionRef, atCell: pending.istep.atCell! }) : undefined;
            }
            // "tile" (Discs) - same as "new" above.
            return rebuild({ targetCell: pending.istep.targetCell! });
        }

        if (mode === "piece") {
            // The target itself is button-only now - overloading the same cells with a THIRD meaning (retargeting) alongside distance/orientation was confusing.
            if (pending.istep.targetPiece === undefined) {
                return undefined;
            }
            const targetResolution = this.resolvePieceRef(pending.istep.targetPiece);
            const target = targetResolution.kind === "ok" ? targetResolution.ref : undefined;
            if (target === undefined) {
                return undefined;
            }

            // Rods' distance is a real destination cell, along the ACTING minion's own facing (matches movePiece's own computation); once chosen, Undo is how to change it.
            if (suitUid === "R" && pending.istep.amount === undefined) {
                const [dx, dy] = this.board.delta(minionPiece.orientation as Exclude<Orientation, "U">);
                for (let n = 1; n <= minionPiece.size; n++) {
                    if (x === target.x + dx * n && y === target.y + dy * n) {
                        return rebuild({ targetPiece: pending.istep.targetPiece, amount: n });
                    }
                }
            }

            // Once the suit action is otherwise complete, a further click adjacent to the target's EFFECTIVE position sets its facing - only for the player's own piece.
            if ((pending.istep.complete ?? -1) < 0) {
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
            const core: Partial<IStep> = suitUid === "D" ? { targetPiece: pending.istep.targetPiece } : { targetPiece: pending.istep.targetPiece, amount: pending.istep.amount! };
            // This trailing facing is only ever an OPTIONAL addition, so a click landing back on the piece's own UNCORRECTED facing completes the step, not a no-op.
            if (dir === targetPiece.orientation) {
                const baseMove = rebuild(core);
                return { move: baseMove, valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
            }
            return rebuild({ ...core, direction: dir });
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
        const { istep } = pending;
        const waitingForCard = istep.card === undefined && (
            (key === "C.new" && istep.atCell !== undefined)
            || (key === "D.tile" && istep.targetCell !== undefined)
            || (key === "S.tile" && istep.targetCell !== undefined)
        );
        if (!waitingForCard) {
            return undefined;
        }
        if (key === "S.tile") {
            const [tx, ty] = GnosticaBoard.algebraic2coords(istep.targetCell!);
            const amount = (this.board.get(tx, ty)?.pointValue() ?? 0) - this.cardValueByUid(uid);
            return this.assembleStepMove(pending, { ...istep, withPiece: minionRef, card: uid, amount });
        }
        // Everything typed so far stays; the uid is the only thing this click adds.
        return this.assembleStepMove(pending, { ...istep, withPiece: minionRef, card: uid });
    }

    // Shared self-or-facing-cell target pick, used by tradeHands/orientAny/hierophantReplace/hermitTeleport's "piece" mode alike; undefined when the click is off-target.
    private pickPieceTargetClick(minion: IMinionRef, x: number, y: number, cell: string, pendingForError: IPendingStep): string | IClickResult | undefined {
        const [faceX, faceY] = this.minorTargetCell(minion);
        // tradeHands/hierophantReplace must target an enemy; orientAny/hermitTeleport don't - reject a self-target immediately rather than fail only at submit.
        const requiresEnemy = pendingForError.special === "tradeHands" || pendingForError.special === "hierophantReplace";
        const enemyKey = pendingForError.special === "tradeHands" ? "TRADEHANDS_MUST_TARGET_ENEMY" : "HIEROPHANT_MUST_TARGET_ENEMY";
        if (x === minion.x && y === minion.y) {
            if (requiresEnemy) {
                return { move: this.describePendingMove(pendingForError, pendingForError.priorSteps), valid: false, message: i18next.t(`apgames:validation.gnostica.${enemyKey}`) };
            }
            return this.pieceRefStr(minion);
        }
        if (x !== faceX || y !== faceY) {
            return undefined;
        }
        const t = this.board.get(faceX, faceY);
        if (t === undefined || t.pieces.length === 0) {
            return { move: this.describePendingMove(pendingForError, pendingForError.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE", { cell }) };
        }
        if (requiresEnemy) {
            const enemyIndex = t.pieces.findIndex(p => p.owner !== this.currplayer);
            if (enemyIndex === -1) {
                return { move: this.describePendingMove(pendingForError, pendingForError.priorSteps), valid: false, message: i18next.t(`apgames:validation.gnostica.${enemyKey}`) };
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
            return this.assembleStepMove(pending, { action: "fly", withPiece: minionRef, card: cardUid, targetCell: cell });
        }
        // "piece" mode: the target is a genuine self-or-facing-cell choice until a destination is picked, then further clicks only replace it.
        if (pending.istep.targetCell === undefined) {
            const targetResult = this.pickPieceTargetClick(pending.minion, x, y, cell, pending);
            if (typeof targetResult === "string") {
                return this.assembleStepMove(pending, { action: "fly", withPiece: minionRef, targetPiece: targetResult });
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
            return this.assembleStepMove(pending, { action: "fly", withPiece: minionRef, targetPiece: pending.istep.targetPiece, targetCell: cell });
        }
        return this.assembleStepMove(pending, { action: "fly", withPiece: minionRef, targetPiece: pending.istep.targetPiece!, targetCell: cell });
    }

    // worldUseAny: a click on any major currently on the board (except World itself) picks it as the borrowed card.
    private handleWorldChooseClick(pending: IPendingStep, x: number, y: number): string | IClickResult | undefined {
        const t = this.board.get(x, y);
        if (t?.card === undefined) {
            return undefined; // not a card cell at all - not this handler's click
        }
        // A card cell, but the wrong kind.
        if (t.card.uid === "21") {
            return { move: this.describePendingMove(pending, pending.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.WORLD_SELF_REFERENCE") };
        }
        if (!t.card.major) {
            return { move: this.describePendingMove(pending, pending.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.WORLD_CHOOSE_TARGET") };
        }
        return this.describePendingMove({ ...pending, asUid: t.card.uid }, pending.priorSteps);
    }

    // The board as the client currently shows it: the move applied on a scratch clone whenever it's previewable, otherwise this.board unchanged.
    private previewBoard(parsed: IParsedMove): GnosticaBoard {
        const move = this.pickleMove(parsed);
        const result = this.validateMove(move);
        if (!result.valid || (result.complete ?? -1) < 0 && result.canrender !== true) {
            return this.board;
        }
        const scratch = this.scratchClone();
        scratch.move(move, { partial: true });
        return scratch.board;
    }

    // Click support for the top-level turn choice.  "Declare" is handled up front.
    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        const parsed = this.parseMove(move);
        let outcome: string | IClickResult;
        if (piece === "_btn_declare") {
            outcome = this.pickleMove({ ...parsed, announceLast: !parsed.announceLast });
        } else {
            outcome = this.routeClick(parsed, row, col, piece);
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

    // What every click handler needs: the move so far (as parsed), and a lazily computed, once-per-click view of its in-progress power step.
    private routeClick(parsed: IParsedMove, row: number, col: number, piece?: string): string | IClickResult {
        // The "bidding" variant's opening procedure is structurally unlike every other click, so it's handled entirely by its own function.
        if (this.phase !== "main") {
            return this.handleBiddingClick(parsed, piece);
        }
        // A pending obligation's own real click targets show up directly, so the move may still be leftover from before it existed - seed it uniformly here.
        if (parsed.head === undefined) {
            parsed = this.resumeMove(parsed) ?? parsed;
        }
        const move = this.pickleMove(parsed);
        let views: { current?: IPendingStep; advanced?: IPendingStep } | undefined;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const ctx: IClickContext = {
            move, parsed, row, col, piece,
            last: parsed.announceLast ? " last" : "",
            // A click that means nothing right now answers with the current move's own status, unchanged, so the player sees no new message or move.
            get noop(): IClickResult {
                return { ...self.validateMove(move), move };
            },
            pending: () => views ??= this.parsePendingStep(parsed),
        };
        if (piece !== undefined && piece.startsWith("_btn_")) {
            return this.clickButton(ctx, piece.slice("_btn_".length));
        }
        // A card is in one place at a time, so a card key is a hand card unless it is in the discard pile; board cards are never clicked through the legend.
        const cardUid = GnosticaGame.cardKeyUid(piece);
        if (cardUid !== undefined) {
            return this.discardPile.includes(cardUid) ? this.clickDiscardPile(ctx, cardUid) : this.clickHandCard(ctx, cardUid);
        }
        // Discard-pile clicks drive judgementDraw only; a minor-arcana bucket has no individual identity, so clicking one draws a uniformly-random not-yet-selected uid from it.
        if (piece !== undefined && /^[A-Z]_(spot|royal)_/.test(piece)) {
            return this.clickDiscardPile(ctx, piece);
        }
        return this.clickBoard(ctx);
    }

    private clickButton(ctx: IClickContext, value: string): string | IClickResult {
        const prefixed: [string, (ctx: IClickContext, arg: string) => string | IClickResult][] = [
            ["minion_", (c, a) => this.clickMinionButton(c, a)],
            ["orientpick_", (c, a) => this.clickOrientPickButton(c, a)],
            ["target_", (c, a) => this.clickTargetButton(c, a)],
            ["pips_", (c, a) => this.clickPipsButton(c, a)],
            ["magician_", (c, a) => this.clickMagicianButton(c, a)],
            ["drawcount_", (c, a) => this.clickDrawCountButton(c, a)],
            ["hpdraw_", (c, a) => this.clickHpDrawButton(c, a)],
        ];
        for (const [prefix, handler] of prefixed) {
            if (value.startsWith(prefix)) {
                return handler(ctx, value.slice(prefix.length));
            }
        }
        return this.clickActionButton(ctx, value);
    }

    // "minion_<ref>" - offered whenever 2+ of the acting player's pieces are eligible and none has been picked yet; types just the ref.
    private clickMinionButton(ctx: IClickContext, ref: string): string | IClickResult {
        const { current, advanced: pending } = ctx.pending();
        if (pending === undefined || !pending.minionAmbiguous || this.facingOpen(current, pending)) {
            return ctx.noop;
        }
        // Resolved against minionCandidates (currently shown), not the full minions pool - a stale move string shouldn't resolve against pieces no longer on offer.
        const resolved = pending.game.resolvePieceRef(ref, pending.minionCandidates);
        if (resolved.kind !== "ok") {
            return ctx.noop;
        }
        const clickedPiece = pending.game.board.get(resolved.ref.x, resolved.ref.y)!.pieces[resolved.ref.index];
        const rodReason = this.rodNeedsFacingReason(pending.suitUid, clickedPiece);
        if (rodReason !== undefined) {
            return ctx.noop;
        }
        const minionRef = pending.game.pieceRefStr(resolved.ref, pending.minions);
        return pending.game.buildAnchorMove(pending, minionRef);
    }

    // "orientpick_<ref>" - orient's own minion-picker (orient has no IPendingStep to resolve against, so it can't reuse "minion_"); facing is a separate click.
    private clickOrientPickButton(ctx: IClickContext, ref: string): string | IClickResult {
        if (ctx.parsed.head?.toLowerCase() !== "orient") {
            return ctx.noop;
        }
        const resolved = this.resolvePieceRef(ref);
        if (resolved.kind !== "ok" || this.board.get(resolved.ref.x, resolved.ref.y)!.pieces[resolved.ref.index].owner !== this.currplayer) {
            return ctx.noop;
        }
        return `orient ${this.pieceRefStr(resolved.ref)}${ctx.last}`;
    }

    // The unified candidate list for a fresh suit-power step, hermitTeleport, or an ambiguous orientAny/tradeHands/hierophantReplace target - one click supplies it directly.
    private clickTargetButton(ctx: IClickContext, ref: string): string | IClickResult {
        const pending = ctx.pending().advanced;
        if (pending === undefined) {
            return ctx.noop;
        }
        if (pending.special === "hermitTeleport") {
            if (stepHermitMode(pending.istep) !== undefined) {
                return ctx.noop;
            }
            return pending.game.buildTargetedHermitMove(pending, ref);
        }
        if (pending.special === "orientAny" || pending.special === "tradeHands" || pending.special === "hierophantReplace") {
            if (pending.istep.targetPiece !== undefined) {
                return ctx.noop;
            }
            return pending.game.buildSpecialTargetMove(pending, ref) ?? ctx.noop;
        }
        if (pending.suitUid === undefined || this.pendingMode(pending) !== undefined) {
            return ctx.noop;
        }
        // Same per-mode availability check the old mode_ buttons used - a struck-through candidate must still reject the click, not build a doomed move.
        const clickedMode = pending.suitUid === "C"
            ? (ref === "own" || ref === "new" ? ref : "enemy")
            : (ref.includes(".") ? "piece" : "tile");
        const reason = pending.game.minorModeAvailability(pending).get(clickedMode);
        if (reason !== undefined) {
            return ctx.noop;
        }
        return pending.game.buildTargetedStepMove(pending, ref);
    }

    // Swords "piece" (attack) pips - a button set rather than a click-cycled arg, always rebuilt against the CURRENT target.
    private clickPipsButton(ctx: IClickContext, n: string): string | IClickResult {
        const pending = ctx.pending().advanced;
        if (pending === undefined || pending.suitUid !== "S" || this.pendingMode(pending) !== "piece") {
            return ctx.noop;
        }
        // An amount that isn't offered, is crossed out, or is already the chosen one does nothing.
        const option = this.swordsPipsOptions(pending).find(o => o.value === n);
        if (option === undefined || option.disabledReason !== undefined || pending.istep.amount === parseInt(n, 10)) {
            return ctx.noop;
        }
        const minionRef = pending.game.pieceRefStr(pending.minion, pending.minions);
        return pending.game.assembleStepMove(pending, { action: "shrink", withPiece: minionRef, targetPiece: pending.istep.targetPiece!, amount: parseInt(n, 10) });
    }

    // Stage 1 of magicianChoice - picks the suit letter, landing in the head as "as <suit>"; every following click then uses ordinary suit-mode machinery.
    private clickMagicianButton(ctx: IClickContext, suit: string): string | IClickResult {
        const pending = ctx.pending().advanced;
        if (pending === undefined || pending.special !== "magicianChoice") {
            return ctx.noop;
        }
        // The button's own suffix always comes from ALL_SUITS, so it's a real MinorSuitUid even though this parse can't prove it.
        return pending.game.describePendingMove({ ...pending, asSuit: suit as MinorSuitUid }, pending.priorSteps);
    }

    // The count-picker buttons offered once "discard" is the live head and no "draw <n>" suffix has been chosen yet; always rebuilt from the current discard uids.
    private clickDrawCountButton(ctx: IClickContext, n: string): string | IClickResult {
        if (ctx.parsed.head !== "discard") {
            return ctx.noop;
        }
        return ["discard", ...(ctx.parsed.steps[0]?.cardList ?? []), "draw", n].join(" ") + ctx.last;
    }

    // High Priestess's count-picker - mirrors drawcount_ but appends onto the CURRENT power step's own istep, not the top-level move's args.
    private clickHpDrawButton(ctx: IClickContext, n: string): string | IClickResult {
        const pending = ctx.pending().advanced;
        if (pending === undefined || pending.special !== "highPriestess") {
            return ctx.noop;
        }
        // Picking a count always completes this step - whatever's already been discarded is sitting in the step's own cardList.
        const cardList = pending.istep.cardList ?? [];
        return pending.game.assembleStepMove(pending, { action: "discard", cardList, amount: parseInt(n, 10) });
    }

    private clickActionButton(ctx: IClickContext, value: string): string | IClickResult {
        const { last } = ctx;
        // A button the move already reflects is greyed, so a click on it does nothing - never a silent restart of the move.
        if (this.highlightedButtonValues(ctx.parsed).has(value) || (value === "decline_power" && ctx.parsed.head === "decline")) {
            return ctx.noop;
        }
        switch (value) {
            case "pass":
                // A genuine pass - explicitly zero discards AND zero draw; a bare "discard" seed defaults its omitted "draw <n>" to the max, so it isn't equivalent.
                return `discard draw 0${last}`;
            case "discard":
                // validateDiscard's own message already says this - no override needed.
                return `discard${last}`;
            case "place": case "use": case "play": case "orient":
                // Place isn't strictly necessary (an empty move already builds "place <cell>" from a bare board click), but is offered for consistency with every other action.
                return `${value}${last}`;
            case "resume_power":
                if (this.continued.length === 0) {
                    return ctx.noop;
                }
                // Seeds the resume submission's head + already-known card uid directly - pendingPower already names the exact card, no board click needed.
                // Returned as a candidate string, not a hardcoded complete:-1, since a resumed Fool flip is ALREADY complete and needs Submit enabled.
                return this.pickleMove(this.freshResumeMove(false, ctx.parsed.announceLast));
            case "decline_power":
                if (this.continued.length === 0) {
                    return ctx.noop;
                }
                // Declining pops the CURRENT top frame; Fool's own remaining flip auto-resolves on this same commit instead of pausing.
                return this.pickleMove(this.freshResumeMove(true, ctx.parsed.announceLast));
            case "undo":
                return this.pickleMove(this.retractedMove(ctx.parsed));
            case "skip_reorient": {
                const { current, advanced } = ctx.pending();
                if (current === undefined || !this.facingOpen(current, advanced)) {
                    return ctx.noop;
                }
                return this.settleFacing(ctx.parsed);
            }
            case "skip": {
                const pending = ctx.pending().advanced;
                const card = ctx.parsed.steps[0]?.card;
                if (!this.canSkipPending(pending) || card === undefined) {
                    return ctx.noop;
                }
                return this.pickleMove({ ...ctx.parsed, steps: [ctx.parsed.steps[0], { action: "skip", complete: -1 }] });
            }
            case "drawn": {
                // Only ever offered for Wheel of Fortune's special option.
                const pending = ctx.pending().advanced;
                if (pending === undefined || pending.suitUid !== "C" || this.pendingMode(pending) !== "new" || pending.opts.allowRandomDraw !== true) {
                    return ctx.noop;
                }
                return pending.game.supplyStepCardUid(pending, "drawn") ?? ctx.noop;
            }
            case "destroy": {
                const pending = ctx.pending().advanced;
                if (pending === undefined || pending.suitUid !== "S" || this.pendingMode(pending) !== "tile" || pending.istep.targetCell === undefined) {
                    return ctx.noop;
                }
                const [tx, ty] = GnosticaBoard.algebraic2coords(pending.istep.targetCell);
                const minionRef = pending.game.pieceRefStr(pending.minion, pending.minions);
                return pending.game.assembleStepMove(pending, { ...pending.istep, withPiece: minionRef, amount: pending.game.board.get(tx, ty)?.pointValue() ?? 0 });
            }
            default:
                return ctx.noop;
        }
    }

    private clickHandCard(ctx: IClickContext, uid: string): string | IClickResult {
        const { move, last } = ctx;
        const { head, steps: headSteps } = ctx.parsed;
        // A card already being played isn't in the hand it would replace from.
        const hand = (ctx.pending().current?.game ?? this).hands[this.currplayer - 1] ?? [];
        if (!hand.includes(uid)) {
            return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
        }
        const pendingForCard = ctx.pending().current;
        if (pendingForCard !== undefined && this.pendingMode(pendingForCard) !== undefined) {
            const result = pendingForCard.game.supplyStepCardUid(pendingForCard, uid);
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
            return pendingForCard.game.assembleStepMove(pendingForCard, { action: "discard", cardList: discards });
        }
        if (head === "play") {
            // "play"'s own pool can span the whole board, unlike "use".
            return `play ${uid}${last}`;
        }
        if (head === "discard") {
            let discards = [...(headSteps[0]?.cardList ?? [])];
            if (discards.includes(uid)) {
                discards = discards.filter(u => u !== uid);
            } else {
                discards.push(uid);
            }
            return ["discard", ...discards].join(" ") + last;
        }
        // No action selected yet (or one a hand-card click makes no sense for) - require a button click first rather than guessing what the player meant.
        return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
    }

    private clickDiscardPile(ctx: IClickContext, key: string): string | IClickResult {
        const pendingForDiscard = ctx.pending().current;
        if (pendingForDiscard?.special !== "judgementDraw") {
            // Tower/Star: a discard may be the replacement card, in place of one from the hand.
            if (pendingForDiscard?.opts.replacementSource !== "discard") {
                return ctx.noop;
            }
            const uid = /^\d{2}$/.test(key) ? this.discardPile.find(u => u === key) : this.pickFromDiscardBucket(key, []);
            return uid === undefined ? ctx.noop : pendingForDiscard.game.supplyStepCardUid(pendingForDiscard, uid) ?? ctx.noop;
        }
        const game = pendingForDiscard.game;
        const minionRef = game.pieceRefStr(pendingForDiscard.minion, pendingForDiscard.minions);
        // Leading "draw" may or may not be there yet depending on whether this is the first click - stripped before working the list, reattached when rebuilding.
        const selected = pendingForDiscard.istep.cardList ?? [];
        const minionPiece = game.board.get(pendingForDiscard.minion.x, pendingForDiscard.minion.y)!.pieces[pendingForDiscard.minion.index];
        const maxDraw = judgementDrawRoom(minionPiece.size, game.hands[this.currplayer - 1]?.length ?? 0);
        const rebuildDiscard = (updated: string[]): string =>
            game.assembleStepMove(pendingForDiscard, { action: "draw", withPiece: minionRef, cardList: updated });

        if (/^\d{2}$/.test(key)) {
            // Unambiguous major-arcana uid.
            if (selected.includes(key)) {
                return rebuildDiscard(selected.filter(u => u !== key));
            }
            if (selected.length >= maxDraw || !this.discardPile.includes(key)) {
                return { move: game.describePendingMove(pendingForDiscard, pendingForDiscard.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.TOO_MANY_TO_DRAW", { maxDraw, requested: selected.length + 1 }) };
            }
            return rebuildDiscard([...selected, key]);
        }

        const matchesBucket = (uid: string): boolean => this.inDiscardBucket(uid, key);
        const alreadyFromBucket = selected.filter(matchesBucket);
        if (alreadyFromBucket.length > 0) {
            const last = alreadyFromBucket[alreadyFromBucket.length - 1];
            const idx = selected.lastIndexOf(last);
            return rebuildDiscard([...selected.slice(0, idx), ...selected.slice(idx + 1)]);
        }
        if (selected.length >= maxDraw) {
            return { move: game.describePendingMove(pendingForDiscard, pendingForDiscard.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.TOO_MANY_TO_DRAW", { maxDraw, requested: selected.length + 1 }) };
        }
        const picked = this.pickFromDiscardBucket(key, selected);
        if (picked === undefined) {
            return { move: game.describePendingMove(pendingForDiscard, pendingForDiscard.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NOT_IN_DISCARD" }) };
        }
        return rebuildDiscard([...selected, picked]);
    }

    // A minor card's identity is hidden in the discard pile's display, shown by "<suit>_<spot|royal>" bucket.
    private inDiscardBucket(uid: string, key: string): boolean {
        const [bucketSuit, bucketCategory] = key.split("_");
        const card = allCards().find(c => c.uid === uid);
        if (card === undefined || card.major) {
            return false;
        }
        return card.suit.uid === bucketSuit && (card.court ? "royal" : "spot") === bucketCategory;
    }

    // A uniformly random discard from the clicked bucket that isn't already taken.
    private pickFromDiscardBucket(key: string, taken: string[]): string | undefined {
        const candidates = this.discardPile.filter(uid => this.inDiscardBucket(uid, key) && !taken.includes(uid));
        return candidates.length === 0 ? undefined : candidates[Math.floor(Math.random() * candidates.length)];
    }

    private clickBoard(ctx: IClickContext): string | IClickResult {
        const { move, row, col, piece, last } = ctx;
        const { head, steps: headSteps } = ctx.parsed;
        // The client displays the board with the current move already applied, so row/col are relative to THAT window - an earlier step's new territory can widen it.
        const { minX, minY } = this.renderWindow(this.previewBoard(ctx.parsed));
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

        if (head === "place") {
            // Click-to-orient: clicking the chosen cell again means "face up", a neighbour means "face that way"; any OTHER cell is a fresh placement (defaulting to "U").
            const prevCell = headSteps[0]?.targetCell;
            let dir: Orientation | undefined;
            if (prevCell !== undefined) {
                const [px, py] = GnosticaBoard.algebraic2coords(prevCell);
                dir = this.orientationTowardClick(px, py, x, y);
            }
            return prevCell !== undefined && dir !== undefined ? `place ${prevCell} ${dir}${last}` : `place ${cell} U?${last}`;
        }
        if (head === "orient") {
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
                return `orient ${prevRef} ${dir}${last}`;
            }
            // Fresh selection - routed through the same minion-selection primitive "use"/"play" use, since 2+ distinguishable pieces here need a real choice.
            const pool = this.eligibleMinionsForOrient(x, y);
            if (pool.length === 0) {
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_SUCH_PIECE" }) };
            }
            const { minion, ambiguous } = this.resolveStepMinion(undefined, pool);
            return ambiguous ? `orient ${cell}${last}` : `orient ${this.pieceRefStr(minion)}${last}`;
        }
        if (this.inPowerPlay(head)) {
            // Once a minor-arcana power step's mode is chosen, a board click is target/arg cycling for that step first; falls through to ordinary use/play only if unmatched.
            const { current: pending, advanced } = ctx.pending();
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
                    const ref = candidate.game.pieceRefStr(atCell[0], candidate.minions);
                    return candidate.game.buildAnchorMove(candidate, ref);
                }
                return candidate.game.buildAnchorMove(candidate, cell);
            };
            // A completed PRIOR step's own click region often overlaps a FOLLOWING button-less special's start region - `advanced` is tried FIRST so starting the next step stays reachable.
            const advancedPastCurrent = advanced !== undefined && advanced.priorSteps.length > (pending?.priorSteps.length ?? -1);
            // With the previous step complete and the next step's minion still undecided, a click on a candidate minion's cell picks that minion, unless it can still turn the previous step's piece.
            if (advancedPastCurrent) {
                // A finished power whose piece can still be turned: the board turns it, and the buttons go on to the next power.
                if (this.facingOpen(pending, advanced)) {
                    const turned = pending!.game.handlePendingStepBoardClick(pending!, x, y);
                    if (turned === undefined) {
                        return { move, valid: true, complete: 0, message: i18next.t("apgames:validation.gnostica.FACE_OR_NEXT_POWER") };
                    }
                    // A click on the facing it already has keeps it, and goes on.
                    return (typeof turned === "string" ? turned : turned.move) === move ? this.settleFacing(ctx.parsed) : turned;
                }
                // The next step is a button-less special whose start click may overlap the finished step's own: it wins, so the next step stays reachable.
                if (!advanced.minionAmbiguous && advanced.special !== undefined && this.pendingSpecialUntouched(advanced)) {
                    const result = advanced.game.handlePendingSpecialBoardClick(advanced, x, y, cell);
                    if (result !== undefined) {
                        return result;
                    }
                }
                const narrowed = tryNarrowMinion(advanced);
                if (narrowed !== undefined) {
                    return narrowed;
                }
                // Any other click can't refine the finished step here; name the next one instead of raising that step's own errors.
                if (advanced.minionAmbiguous) {
                    return { move, valid: true, complete: 0, message: i18next.t("apgames:validation.gnostica.PICK_MINION_CELL") };
                }
            }
            const narrowed = tryNarrowMinion(pending);
            if (narrowed !== undefined) {
                return narrowed;
            }
            if (pending !== undefined && this.pendingMode(pending) !== undefined) {
                const result = pending.game.handlePendingStepBoardClick(pending, x, y);
                if (result !== undefined) {
                    return result;
                }
            }
            if (pending !== undefined && pending.special !== undefined) {
                const result = pending.game.handlePendingSpecialBoardClick(pending, x, y, cell);
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
            return `use ${t.card.uid}${last}`;
        }
        if (!this.hasPiecesOnBoard(this.currplayer)) {
            // Fresh click, nothing placed yet - place is the only legal start, needs no button. Facing defaults to "U", trailing "?" marking it not yet deliberate.
            return `place ${cell} U?${last}`;
        }
        // No mode chosen yet and pieces already exist - board clicks are genuinely ambiguous here, so this doesn't guess; the player picks a button first.
        return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
    }

    // Click support for the "bidding" variant's opening procedure. Row/col are never used - both phases are driven entirely by clicking cards in an AreaPieces.
    private handleBiddingClick(parsed: IParsedMove, piece?: string): string | IClickResult {
        const move = this.pickleMove(parsed);
        if (piece === "_btn_bid") {
            return { move: "bid", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CARD_TO_BID") };
        }
        if (piece === "_btn_redraw") {
            return { move: "redraw", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CARDS_TO_REDRAW") };
        }
        // A bid is always exactly one card - unlike discard's toggle-list, each click REPLACES any earlier pick rather than accumulating.
        const cardUid = GnosticaGame.cardKeyUid(piece);
        if (this.phase === "bidding" && cardUid !== undefined) {
            const uid = cardUid;
            const hand = this.hands[this.currplayer - 1] ?? [];
            const idx = hand.indexOf(uid);
            if (idx === -1) {
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
            }
            return `bid ${idx + 1}`;
        }
        // Redraw can need several cards, so pool clicks toggle a uid list exactly like discard's own hand-card toggle.
        if (this.phase === "redraw" && cardUid !== undefined) {
            const uid = cardUid;
            if (!this.biddingPool!.includes(uid)) {
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.REDRAW_UID_NOT_IN_POOL", { uid }) };
            }
            const { head, steps } = parsed;
            let picks = head?.toLowerCase() === "redraw" ? [...(steps[0]?.cardList ?? [])] : [];
            if (picks.includes(uid)) {
                picks = picks.filter(u => u !== uid);
            } else {
                picks.push(uid);
            }
            return ["redraw", ...picks].join(" ");
        }
        return { ...this.validateMove(move), move };
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

    // A piece picked to be turned but not yet turned: nothing sets its buffer until the facing is in, yet the facing click may be past the window.
    private addPendingFacingBuffer(parsed: IParsedMove, pending: IPendingStep | undefined): void {
        const turning = parsed.head === "orient" ? parsed.steps[0] : pending?.special === "orientAny" ? pending.istep : undefined;
        const ref = turning?.targetPiece;
        if (ref === undefined || turning?.direction !== undefined || !ref.includes(".")) {
            return;
        }
        const [x, y] = GnosticaBoard.algebraic2coords(ref.split(".")[0]);
        this.addBufferIfWasteland(x, y);
    }

    // A Rods piece step still waiting for its distance: a landing cell can lie past the window, so a buffer on that side gives it something to click.
    private addDistanceBuffer(pending: IPendingStep | undefined): void {
        if (pending?.suitUid !== "R" || pending.istep.amount !== undefined || this.pendingMode(pending) !== "piece") {
            return;
        }
        const target = pending.game.resolvePieceRef(pending.istep.targetPiece);
        const minionPiece = pending.minion.piece ?? pending.game.board.get(pending.minion.x, pending.minion.y)?.pieces[pending.minion.index];
        if (target.kind !== "ok" || minionPiece === undefined || minionPiece.orientation === "U") {
            return;
        }
        const [dx, dy] = this.board.delta(minionPiece.orientation);
        const win = this.renderWindow();
        for (let n = 1; n <= minionPiece.size; n++) {
            const x = target.ref.x + dx * n;
            const y = target.ref.y + dy * n;
            const side = x < win.minX ? "W" : x > win.maxX ? "E" : y < win.minY ? "N" : y > win.maxY ? "S" : undefined;
            if (side !== undefined) {
                if (!this.buffers.includes(side)) {
                    this.buffers.push(side);
                }
                return;
            }
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
    private cmdDiscard(step: IStep): void {
        const discardUids = step.cardList ?? [];
        const drawCountStr = step.amount?.toString();
        discardCards(this.buildPowerContext(), discardUids);
        if (discardUids.length > 0) {
            this.discarded.push(...discardUids);
            this.results.push({ type: "place", how: "discard", what: discardUids.join(",") });
        }
        this.hidden.push({ type: "draw", count: Number(drawCountStr), setsCardsDrawn: true });
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
    private cmdActivate(play: IPowerPlay, partial: boolean): Owed[] | undefined {
        this.results.push({ type: "use", what: play.headArg });
        return this.applyPlay(play, partial);
    }

    // Walks a play's powers, whichever way it was reached.
    private applyPlay(play: IPowerPlay, partial: boolean): Owed[] | undefined {
        // How the play was reached, for a Justice that pauses after its trade: used or played, through the World or not.
        const how = `${play.head}${play.asUid !== undefined && play.headArg === "21" ? "21" : ""}`;
        return this.applyPowers(play.headArg, play.owed, play.steps, play.asUid, partial, how);
    }

    // The Fool's token counts its flips, Justice's says how it was reached ("use", "use21", "play", "play21"), and High Priestess's needs nothing more.
    private static owedToken(owed: Owed): string {
        switch (owed.uid) {
            case "00": return `00.${owed.done}`;
            case "11": return `11.${owed.how}`;
            default: return owed.uid;
        }
    }

    private static owedFromToken(token: string): Owed {
        const [uid, detail] = token.split(".");
        switch (uid) {
            case "00": return { uid, done: Number(detail) };
            case "11": return { uid, done: 1, how: detail };
            default: return { uid, done: 1 };
        }
    }

    private owedFromContinued(): Owed[] {
        return this.continued.filter(t => t !== "last").map(t => GnosticaGame.owedFromToken(t));
    }

    // Who may act on a resumed obligation: for a Justice reached by a use, the minions in the territory it was used from (the World's, if it borrowed Justice); otherwise any of the player's.
    private eligibleMinionsForOwed(owed: Owed): IMinionRef[] {
        if (owed.uid !== "11" || owed.how === "play" || owed.how === "play21") {
            return this.eligibleMinionsForPlay();
        }
        const loc = this.findCardCell(owed.how === "use21" ? "21" : "11");
        return loc === undefined ? [] : this.eligibleMinionsForActivate(loc.x, loc.y);
    }

    // Applies a submission's power segments card by card (the head card, a World's borrowed card, a Fool's revealed card) straight off the string, then settles whatever
    // that leaves owed. `uid` undefined means the revealed card was declined. Returns what is still owed, or undefined if it stopped early (a preview's unfinished step or Fool flip).
    private applyPowers(uid: string | undefined, owed: Owed[], allSteps: IStep[], asUid: string | undefined, partial: boolean, how?: string): Owed[] | undefined {
        // A skip only names the power left unused; the step that follows it says everything that happens.
        const steps = allSteps.filter(step => step.action !== "skip");
        const ctx = this.buildPowerContext();
        const chained = steps.length + (asUid !== undefined ? 1 : 0) > 1;
        let counted = 0;
        let at = 0;
        // One step: a snapshot of the board before it, and its results grouped when the submission is chained; false if it didn't complete.
        const count = (apply: () => boolean): boolean => {
            this.frames.push({ board: this.board.clone().store, discardSummary: this.summarizeDiscardPile(this.discardPile) });
            const resultsBefore = this.results.length;
            const hiddenBefore = this.hidden.length;
            if (!apply()) {
                this.frames.pop();
                return false;
            }
            counted++;
            for (const effect of this.hidden.slice(hiddenBefore)) {
                effect.grouped = chained;
            }
            if (chained) {
                const stepResults = this.results.splice(resultsBefore) as APMoveResult[];
                if (stepResults.length > 0) {
                    this.results.push({ type: "_group", who: this.currplayer, results: stepResults as [APMoveResult, ...APMoveResult[]] });
                }
            }
            return true;
        };
        // The Fool's flip isn't one of the move's steps: it takes no segment, so it gets no frame and joins the last step's group.
        const flip = (): void => {
            this.hidden.push({ type: "flip", grouped: chained, joinsGroup: true });
        };
        const run = (card: string): "done" | "paused" | "stopped" => {
            if (card === "21") {
                // The World's own step takes no segment: the borrowed card is named in the head.
                if (asUid === undefined) {
                    return "stopped";
                }
                count(() => {
                    this.results.push({ type: "use", what: asUid, count: 21 });
                    return true;
                });
                return run(asUid);
            }
            if (card === "00") {
                if (partial) {
                    return "stopped";
                }
                if (checkFool(ctx) !== undefined) {
                    // Nothing left to flip: both flips are spent.
                    return "done";
                }
                flip();
                owed.push({ uid: "00", done: 1 });
                return "paused";
            }
            if (card === "02") {
                const round2 = owed[owed.length - 1]?.uid === "02";
                if (at >= steps.length) {
                    // No segment: the round is skipped.
                    if (round2) {
                        owed.pop();
                    }
                    return "done";
                }
                const step = steps[at++];
                if (!count(() => {
                    this.applyHighPriestess(step, partial);
                    return true;
                })) {
                    return "stopped";
                }
                if (round2) {
                    owed.pop();
                    return "done";
                }
                owed.push({ uid: "02", done: 1 });
                return "paused";
            }
            const sameTarget = MAJOR_ARCANA[card]?.sameTargetShortcut === true;
            for (let idx = 0; at < steps.length; idx++) {
                const step = steps[at++];
                const next = steps[at];
                if (!count(() => this.applyPlainStep(step, next, partial && sameTarget && idx === 0))) {
                    return "stopped";
                }
                // Justice's trade happens on commit, so its attack waits for the next submission.
                if (card === "11" && step.action === "trade") {
                    owed.push({ uid: "11", done: 1, how });
                    return "paused";
                }
            }
            // A resumed Justice attack is the last of what was owed.
            if (card === "11" && owed[owed.length - 1]?.uid === "11") {
                owed.pop();
            }
            return "done";
        };
        // A Fool exposed once its revealed card is used or declined flips again by itself; a High Priestess round needs its own submission.
        const settle = (): Owed[] | undefined => {
            for (let top = owed[owed.length - 1]; top !== undefined && top.uid === "00"; top = owed[owed.length - 1]) {
                if (top.done >= 2) {
                    owed.pop();
                    continue;
                }
                if (partial) {
                    return undefined;
                }
                if (checkFool(ctx) !== undefined) {
                    owed.pop();
                    continue;
                }
                flip();
                top.done++;
                return owed;
            }
            return owed;
        };
        const outcome = uid === undefined ? "done" : run(uid);
        const stillOwed = outcome === "stopped" ? undefined : outcome === "paused" ? owed : settle();
        // Frames only matter to a move of 2+ steps; one step's frame is just the current state.
        if (counted < 2) {
            this.frames = [];
        }
        return stillOwed;
    }

    // One ordinary power segment: false while a preview's step is still unfinished (its arguments, or the minion it needs, aren't chosen yet).
    // The `with` minion is only looked up for Rods and orient, the verbs that read it. `waypoint`: a Rods move into the void that a following move continues from (Chariot)
    // leaves the piece standing; `previewWaypoint` is the same for a preview with nothing following yet.
    private applyPlainStep(step: IStep, next: IStep | undefined, previewWaypoint: boolean): boolean {
        if ((step.complete ?? -1) < 0) {
            return false;
        }
        const pool = this.eligibleMinionsForPlay();
        const minionRef = step.withPiece!;
        if ((step.action === "move" || step.action === "orient") && this.isMinionCellStillNarrowing(minionRef, pool)) {
            return false;
        }
        this.applyVerb(() => this.resolvePieceRefTrusted(minionRef, pool), step, step.action === "move" && (next === undefined ? previewWaypoint : next.action === "move"));
        return true;
    }

    // What resumes a persisted Fool or High Priestess obligation: the revealed card used or declined, or the second round.
    private resumePowers(play: IPowerPlay, partial: boolean): Owed[] | undefined {
        const pending = play.headArg;
        // A bare resume seed, nothing typed yet, has nothing to apply - except a revealed Fool's flip or a known World borrow, which resolve on their own.
        if (play.steps.length === 0 && pending !== "00" && !(play.asUid !== undefined && pending === "21")) {
            return undefined;
        }
        if (play.steps[0]?.action === "decline") {
            this.results.push({ type: "announce", payload: ["decline", pending] });
            if (pending === "11") {
                play.owed.pop();
            }
            return this.applyPowers(undefined, play.owed, [], play.asUid, partial);
        }
        return this.applyPlay(play, partial);
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
        if (this.eligibleMinionsForActivate(loc.x, loc.y).length === 0) {
            return this.invalid("apgames:validation.gnostica.NO_MINIONS_THERE", { uid: cardUid });
        }
        return this.validatePlayedPower(this.resolvePowerPlay(parsed)!);
    }

    // "Play a card from your hand to the discard pile" - same fresh-activation-only note as cmdActivate; legality is validatePlay's own job.
    private cmdPlay(play: IPowerPlay, partial: boolean): Owed[] | undefined {
        this.discardPlayedCard(play.headArg);
        this.results.push({ type: "deckDraw", what: play.headArg, from: "hand" });
        return this.applyPlay(play, partial);
    }

    // The card leaves the hand for the discards before its power runs, so the power sees a hand without it.
    private discardPlayedCard(uid: string): void {
        const hand = this.hands[this.currplayer - 1];
        hand.splice(hand.indexOf(uid), 1);
        this.discardPile.push(uid);
        this.discarded.push(uid);
    }

    // A scratch copy as the play's power will see it: for a card played from the hand, one that has already played it.
    private scratchForPlay(play: IPowerPlay): GnosticaGame {
        const copy = this.scratchClone();
        if (play.head === "play" && !play.resume) {
            copy.discardPlayedCard(play.headArg);
        }
        return copy;
    }


    private validatePlay(parsed: IParsedMove): IValidationResult {
        const uid = parsed.steps[0]?.card;
        if (uid === undefined) {
            return this.invalid("apgames:validation.gnostica.PLAY_UID_REQUIRED");
        }
        if (!this.hands[this.currplayer - 1].includes(uid)) {
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
        const play = this.resolvePowerPlay(parsed)!;
        // Validated on a copy that has already played the card, as cmdPlay will leave it.
        return this.scratchForPlay(play).validatePlayedPower(play);
    }

    // Validates what a use, play or resume goes on to do with its card, the same for all three: a fresh minor card is its one suit step, anything else is a walk of its frame stack.
    private validatePlayedPower(play: IPowerPlay): IValidationResult {
        if (play.card !== undefined && !play.card.major && !play.resume) {
            return this.validateMinorPower(suitUidOf(play.card), play.card.uid, play.eligible, play.steps);
        }
        return this.validatePowerStack(play.frames, play.steps, play.rootUid, play.asUid, play.asSuit);
    }

    // Mirrors applyMinorPower's own tolerance exactly - skipping, and an incomplete-so-far step, both validate as "fine, nothing to report yet".
    public validateMinorPower(suitUid: MinorSuitUid, cardUid: string, eligible: IMinionRef[], steps: IStep[]): IValidationResult {
        if (steps.some(step => step.action === "skip")) {
            return this.invalid("apgames:validation.gnostica.SKIP_NOT_ALLOWED");
        }
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
        if ((step.complete ?? -1) < 0) {
            const msg = this.primitiveIncompleteMessage(suitUid, step) ?? this.powerStepMessageKey(cardUid, 0, eligible, step.withPiece);
            return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
        }
        const stepResult = this.validateSuitPrimitive(suitUid, minion, step, {});
        if (stepResult.failed) {
            return stepResult.result;
        }
        // Cups "own" creation's still-prepopulated facing, or a piece just acted on with no reorientation given - either way complete:0, so the client doesn't auto-submit before a click.
        const outcome = this.scratchClone().applySuitPrimitive(() => minion, step);
        const softComplete = outcome.softComplete === true;
        return {
            valid: true,
            complete: softComplete ? 0 : 1,
            message: i18next.t(softComplete ? "apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT" : "apgames:validation._general.VALID_MOVE"),
        };
    }

    // Whether `cardUid` names a real major arcana card or a minor Fool flipped - either way, returns something shaped like a MajorArcanaDef so downstream code needs no second path.
    private static readonly SUIT_TO_PRIMITIVE: Record<MinorSuitUid, SuitPrimitive> = { C: "create", R: "move", D: "grow", S: "attack" };

    private resolveFrameDef(cardUid: string): MajorArcanaDef {
        const existing = MAJOR_ARCANA[cardUid];
        if (existing !== undefined) {
            return existing;
        }
        const card = allCards().find(c => c.uid === cardUid);
        if (card === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: cardUid }));
        }
        return { uid: cardUid, name: card.name, seq: -1, icons: [], powers: [{ primitive: GnosticaGame.SUIT_TO_PRIMITIVE[suitUidOf(card)] }] };
    }

    // Applies a step's own outcome.newMinion chaining to `minions`: appends it, first removing whichever existing entry it supersedes (a splice can shift later same-cell indices down by one).
    private static chainMinion(minions: IMinionRef[], outcome: IStepOutcome): IMinionRef[] {
        const stale = outcome.replacesMinion;
        // An in-place change (a reorientation) leaves every other piece's index alone; only a removeAt shifts later ones down.
        const inPlace = stale !== undefined && outcome.newMinion?.x === stale.x && outcome.newMinion.y === stale.y && outcome.newMinion.index === stale.index;
        const base = stale === undefined
            ? minions
            : minions
                .filter(m => !(m.x === stale.x && m.y === stale.y && m.index === stale.index))
                .map(m => (!inPlace && m.x === stale.x && m.y === stale.y && m.index > stale.index) ? { ...m, index: m.index - 1 } : m);
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

    // The action a plain power's step is spelled with (create/move/grow, an attack is "shrink", or a special's own verb); undefined for Fool/World/High Priestess/Magician.
    private static powerAction(power: PowerStep): string | undefined {
        if ("primitive" in power) {
            return power.primitive === "attack" ? "shrink" : power.primitive;
        }
        return SPECIAL_STEP_ACTIONS[power.special];
    }

    // Whether a card's first power can be given up for its second, a different one (the move's "skip" segment); same-kind cards gain nothing, since using the second alone is using the first.
    private static canSkipFirstPower(frameDef: MajorArcanaDef): boolean {
        const first = GnosticaGame.powerAction(frameDef.powers[0]);
        const second = frameDef.powers[1] === undefined ? undefined : GnosticaGame.powerAction(frameDef.powers[1]);
        return first !== undefined && second !== undefined && first !== second;
    }

    // Powers are optional, so a card's second power may be used alone: when a typed step is spelled as a LATER power of the frame's card, the powers in
    // between are skipped. Forward-only - a step matching only an earlier power finds no target here and is rejected as the wrong action further on.
    private static skipAheadTarget(frameDef: MajorArcanaDef, from: number, istep: IStep | undefined): number {
        if (istep === undefined || istep.action === "with") {
            return from;
        }
        const current = GnosticaGame.powerAction(frameDef.powers[from]);
        if (current === undefined || current === istep.action) {
            return from;
        }
        for (let j = from + 1; j < frameDef.powers.length; j++) {
            const action = GnosticaGame.powerAction(frameDef.powers[j]);
            if (action === undefined) {
                return from;
            }
            if (action === istep.action) {
                return j;
            }
        }
        return from;
    }

    // Rebuilds the throwaway IPendingMajorPower-shaped view the resume machinery expects, from the minimal persisted this.continued tokens; one frame per token, minions recomputed fresh.
    private buildPendingFromContinued(): IPendingMajorPower | undefined {
        const tokens = this.continued.filter(t => t !== "last");
        if (tokens.length === 0) {
            return undefined;
        }
        const pool = this.eligibleMinionsForPlay();
        const stack = tokens.map(token => {
            const owed = GnosticaGame.owedFromToken(token);
            return { cardUid: owed.uid, nextStepIndex: owed.done, minions: [...this.eligibleMinionsForOwed(owed)] } as IPowerFrame;
        });
        if (stack[stack.length - 1].cardUid === "00") {
            const revealed = this.discardPile[this.discardPile.length - 1];
            if (revealed !== undefined) {
                stack.push({ cardUid: revealed, nextStepIndex: 0, minions: [...pool] });
            }
        }
        return { rootCardUid: stack[0].cardUid, stack: stack as [IPowerFrame, ...IPowerFrame[]] };
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

    // The frame stack for a resumed turn is: the persisted Fool/HP obligation(s), plus (via Fool) a fresh frame for the drawn card.
    private resumeQueue(): IPowerFrame[] | undefined {
        const pending = this.buildPendingFromContinued();
        return pending?.stack.map(f => ({ ...f, minions: [...f.minions] }));
    }

    // The steps a genuine resume submission carries; the "discard" resume is already a real, fully-parsed IStep at parsed.steps[0] - no synthetic reconstruction needed.
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
        // How many more discards a Judgement draw step could still take, when the last step was one; same "last step wins" convention.
        let mayDrawMore = 0;
        // Set once Moon's own move step genuinely needed its capacity exemption (destination was already at 3); cleared once the attack step destroys a piece there, restoring it.
        let moonRestoreCell: { x: number; y: number } | undefined;
        // Set when the last step was only legal thanks to a two-step shortcut's waiver, which its (missing) paired second step would have earned.
        let awaitingPair = false;
        // False right after a power was skipped (a later power of the card used alone), so nothing was there to pass on to it; true once a step is processed.
        let priorTaken = true;
        // Where the previous step of a same-target-shortcut card left the piece it acted on; the next step must act on that same piece.
        let sameTargetWanted: { x: number; y: number; index: number } | undefined;
        for (;;) {
            const top = stack[stack.length - 1];
            const poppedViaDecline = justDeclined;
            justDeclined = false;
            if (top === undefined) {
                if (i < steps.length) {
                    return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "TOO_MANY_POWER_STEPS" });
                }
                if (awaitingPair) {
                    return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PAIRED_STEP_REQUIRED") };
                }
                if (hpDrawNotChosen) {
                    return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.DISCARD_DRAW_REQUIRED") };
                }
                if (softComplete) {
                    return { valid: true, complete: 0, message: i18next.t("apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT") };
                }
                if (mayDrawMore > 0) {
                    return { valid: true, complete: 0, message: i18next.t("apgames:validation.gnostica.VALID_MOVE_MAY_DRAW_MORE", { remaining: mayDrawMore }) };
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
                justDeclined = true;
                continue;
            }
            // Only a plain step reads the segment: a World's own frame consumes none, so its borrowed card's first power is what a leading skip means.
            if (kind === "step" && steps[i]?.action === "skip") {
                if (top.nextStepIndex !== 0 || !GnosticaGame.canSkipFirstPower(frameDef)) {
                    return this.invalid("apgames:validation.gnostica.SKIP_NOT_ALLOWED");
                }
                i++;
                top.nextStepIndex++;
                priorTaken = false;
                // A skip is only ever legal with the power it skips to following it.
                if (i >= steps.length) {
                    return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.CHOOSE_STEP", { card: this.cardNameOrUid(top.cardUid) }) };
                }
                continue;
            }
            if (kind === "step" && i < steps.length) {
                const target = GnosticaGame.skipAheadTarget(frameDef, top.nextStepIndex, steps[i]);
                if (target !== top.nextStepIndex) {
                    top.nextStepIndex = target;
                    priorTaken = false;
                    continue;
                }
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
                    // The last step was only legal thanks to a two-step shortcut's waiver, so its paired second step is no longer optional.
                    if (awaitingPair) {
                        return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PAIRED_STEP_REQUIRED") };
                    }
                    // Frame not exhausted: a further step is still optional, so complete:0.
                    const optional = this.powerStepMessageKey(top.cardUid, i, top.minions);
                    return {
                        valid: true,
                        complete: 0,
                        message: i18next.t(optional.key, optional.params),
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
            if (sameTargetWanted !== undefined && "primitive" in step && istep !== undefined && (istep.complete ?? -1) >= 0) {
                const target = istep.targetPiece === undefined ? undefined : (clone ?? this).resolvePieceRef(istep.targetPiece);
                if (target?.kind !== "ok" || target.ref.x !== sameTargetWanted.x || target.ref.y !== sameTargetWanted.y || target.ref.index !== sameTargetWanted.index) {
                    return this.invalid("apgames:validation.gnostica.SAME_TARGET_REQUIRED");
                }
            }
            sameTargetWanted = undefined;
            // Strict rules first: a two-step shortcut's waiver only applies when the card's next step was actually supplied.
            const followed = i < steps.length;
            let paired = followed;
            const takenBefore = priorTaken;
            let stepResult = (clone ?? this).validatePowerStep(step, top.minions, istep, frameDef, stepIndex, frameDef.powers.length, isFreshRootFool, borrowedForStep, followed, takenBefore);
            if (stepResult.failed && !followed && stepIndex < frameDef.powers.length - 1) {
                // Legal only WITH the waiver: fine as far as it goes, but the move can't be submitted until the paired second step is added.
                const optimistic = (clone ?? this).validatePowerStep(step, top.minions, istep, frameDef, stepIndex, frameDef.powers.length, isFreshRootFool, borrowedForStep, true, takenBefore);
                if (!optimistic.failed) {
                    awaitingPair = true;
                    paired = true;
                    stepResult = optimistic;
                }
            }
            if (stepResult.failed) {
                return stepResult.result;
            }
            if (stepResult.complete === false) {
                if (i >= steps.length) {
                    if (istep!.withPiece !== undefined && this.isMinionCellStillNarrowing(istep!.withPiece, top.minions)) {
                        return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_MINION_BUTTON") };
                    }
                    // orientAny/hierophantReplace's own target is already chosen but its facing isn't yet - name the real next click, not the generic "pick a target" wording.
                    if ("special" in step && (step.special === "orientAny" || step.special === "hierophantReplace") && istep?.targetPiece !== undefined) {
                        return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT") };
                    }
                    // hermitTeleport's target is already chosen; only the destination click is left.
                    if ("special" in step && step.special === "hermitTeleport" && istep !== undefined && stepHermitMode(istep) !== undefined) {
                        return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_HERMIT_DESTINATION") };
                    }
                    const override = "primitive" in step && istep !== undefined ? this.primitiveIncompleteMessage(this.primitiveToSuit(step.primitive), istep) : undefined;
                    // A bare "/" has begun the step with nothing chosen for it.
                    const msg = override ?? (istep?.action === "with" && istep.withPiece === undefined
                        ? this.freshStepMessage(top.cardUid, top.nextStepIndex, top.minions)
                        : this.powerStepMessageKey(top.cardUid, top.nextStepIndex, top.minions, istep?.withPiece));
                    return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
                }
                // An earlier segment being incomplete means a later one couldn't legitimately exist - defensive, shouldn't fire.
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP" });
            }
            // The step's real effect, applied to a throwaway copy that later steps then validate against.
            clone ??= this.scratchClone();
            const outcome = clone.applyPowerStep(step, top.minions, istep, frameDef, stepIndex, frameDef.powers.length, true, borrowedForStep, paired, takenBefore) ?? {};
            if (outcome.forcePause === true) {
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
                const ready = i18next.t(readyMsg.key, readyMsg.params);
                // The orientation hint comes first: the facing is still the player's to change, and the move isn't submitted for them.
                return { valid: true, complete: softComplete ? 0 : 1, message: softComplete ? `${i18next.t("apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT")} ${ready}` : ready };
            }
            // Moon: the move step is only exempt from the capacity cap if it actually needed to be (destination now holds 4); the attack step then must destroy a piece at that SAME cell to restore it.
            if (frameDef.moonCapacityExemption && "primitive" in step) {
                if (step.primitive === "move" && outcome.movedToCell !== undefined) {
                    const cell = outcome.movedToCell;
                    if ((clone.board.get(cell.x, cell.y)?.pieces.length ?? 0) >= 4) {
                        moonRestoreCell = cell;
                    }
                } else if (step.primitive === "attack" && moonRestoreCell !== undefined) {
                    const destroyed = outcome.destroyedAtCell;
                    if (destroyed !== undefined && destroyed.x === moonRestoreCell.x && destroyed.y === moonRestoreCell.y) {
                        moonRestoreCell = undefined;
                    } else {
                        return this.invalid("apgames:validation.gnostica.MOON_MUST_RESTORE_CAPACITY");
                    }
                }
            }
            if (frameDef.sameTargetShortcut && followed && "primitive" in step) {
                const produced = outcome.producedPiece ?? outcome.newMinion;
                sameTargetWanted = produced === undefined ? undefined : { x: produced.x, y: produced.y, index: produced.index };
            }
            top.minions = GnosticaGame.chainMinion(top.minions, outcome);
            top.nextStepIndex = outcome.consumesRest ? frameDef.powers.length : top.nextStepIndex + 1;
            priorTaken = true;
            if ("special" in step && step.special === "highPriestess" && top.nextStepIndex >= frameDef.powers.length) {
                hpFinalRoundReady = this.forcePauseReadyMessage(top.cardUid, stepIndex);
            }
            hpDrawNotChosen = "special" in step && step.special === "highPriestess" && istep?.amount === undefined;
            softComplete = outcome.softComplete === true;
            mayDrawMore = stepResult.mayAddMore ?? 0;
            if (outcome.pushFrame !== undefined) {
                stack.push({ cardUid: outcome.pushFrame.cardUid, nextStepIndex: 0, minions: outcome.pushFrame.minions });
            }
            GnosticaGame.popExhaustedFrames(this, stack);
        }
    }

    public validateMajorPower(def: MajorArcanaDef, eligible: IMinionRef[], steps: IStep[], asUid?: string, asSuit?: string): IValidationResult {
        return this.validatePowerStack([{ cardUid: def.uid, nextStepIndex: 0, minions: [...eligible] }], steps, def.uid, asUid, asSuit);
    }

    // The shared start of validating a walk of a frame stack, fresh or resumed (#49: every frame owes one meaningful step; see validateFrameStack).
    private validatePowerStack(stack: IPowerFrame[], steps: IStep[], rootCardUid: string, asUid?: string, asSuit?: string): IValidationResult {
        // A World borrow with nothing else typed still has a real step to choose (falls through to the walk); a Magician borrow pushes no frame, so it wants the same fresh-step wording.
        const worldBorrow = asUid !== undefined;
        if (steps.length === 0 && !this.topStepIsFool(stack) && !worldBorrow) {
            const top = stack[stack.length - 1];
            const msg = this.freshStepMessage(top.cardUid, top.nextStepIndex, top.minions);
            return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
        }
        return this.validateFrameStack(stack, steps, rootCardUid, asUid, asSuit);
    }

    // Mirrors resumePendingPower's own dispatch, read-only; checks the card a "play" resume names (must be what the last flip left on top of discard), then walks the segments for legality.
    private validateResumePendingPower(parsed: IParsedMove): IValidationResult {
        const play = this.resolvePowerPlay(parsed)!;
        // The card named must be the one the last flip left on top - a decline names it too, since the announcement and the log read it from here.
        if ((parsed.head === "play" || parsed.head === "use" || parsed.head === "decline") && parsed.steps[0]?.card !== undefined && parsed.steps[0].card !== play.frames[play.frames.length - 1].cardUid) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "BAD_CARD"});
        }
        // Justice's remaining power is its attack, which is Swords.
        if (this.getContinuedUid() === "11" && parsed.head !== "decline" && parsed.asSuit !== "S") {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "WRONG_AS_SUIT"});
        }
        return this.validatePlayedPower(play);
    }

    // "primitive" steps expect <minionRef> <mode> <args...> (same grammar as minor arcana); "special" steps have their own bespoke shapes. High Priestess alone has no minion reference at all.
    public applyPowerStep(
        step: PowerStep, minions: IMinionRef[], istep: IStep | undefined, def: MajorArcanaDef, stepIndex: number, totalSteps: number, partial: boolean,
        borrowedPower?: string, paired = true, priorTaken = true,
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
            const failure = checkFool(this.buildPowerContext());
            if (failure) {
                // Nothing to flip: complete.  Validation already rejected the root Fool's own untouched first flip.
                return {};
            }
            // The flip itself happens once the move is committed; unlike High Priestess, EVERY flip forces a pause, regardless of whether Fool has another one left.
            this.hidden.push({ type: "flip" });
            return { forcePause: true };
        }
        const minionRef = istep!.withPiece!;
        if (this.isMinionCellStillNarrowing(minionRef, minions)) {
            return undefined; // cell chosen, which minion there is still undecided - still skipped
        }
        const minion = this.resolvePieceRefTrusted(minionRef, minions);
        if ((istep!.complete ?? -1) < 0) {
            return undefined; // still skipped so far
        }
        // The only card-derived fact apply still needs: Chariot's relaxed mid-chain landing.
        const waypoint = "primitive" in step && this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts, paired, priorTaken).skipLandingCheck === true;
        const outcome = this.applyVerb(() => minion, istep!, waypoint);
        // The trade happens on commit, so a power that follows it can't be checked until then.
        if ("special" in step && step.special === "tradeHands" && stepIndex + 1 < totalSteps) {
            outcome.forcePause = true;
        }
        // Death's one shrink for both swords: more pips than the minion has means the card's other power is spent too.
        if (outcome.shrunkBy !== undefined && outcome.shrunkBy > this.minionSize(minion)) {
            outcome.consumesRest = true;
        }
        return outcome;
    }

    // One verb's effect, read off the step itself; shared by every caller that applies a step. `waypoint`: a Rods landing in the void is left standing for the next step.
    private applyVerb(minion: () => IMinionRef, istep: IStep, waypoint = false): IStepOutcome {
        switch (istep.action) {
            case "create":
            case "move":
            case "grow":
            case "shrink":
                return this.applySuitPrimitive(minion, istep, waypoint);
            case "orient":
                return this.applyOrient(minion, istep);
            case "replace":
                return this.applyHierophantReplace(istep);
            case "fly":
                return this.applyHermitStep(istep);
            case "trade":
                return this.applyTradeHands(istep);
            default: // draw (Judgement)
                this.applyJudgementDraw(istep);
                // A real (if empty) outcome, is not marked undefined.
                return {};
        }
    }

    // Mirrors applyPowerStep's own "incomplete step, still skipped" tolerance.
    public validatePowerStep(
        step: PowerStep, minions: IMinionRef[], istep: IStep | undefined, def: MajorArcanaDef, stepIndex: number, totalSteps: number,
        isFreshRootFool = false, borrowedPower?: string, paired = true, priorTaken = true,
    ): StepValidation {
        if ("special" in step && step.special === "worldUseAny") {
            if (borrowedPower === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "WORLD_BORROW_REQUIRED" }) };
            }
            const worldResult = this.validateWorldChoosePower(borrowedPower);
            if (!worldResult.valid) {
                return { failed: true, result: worldResult };
            }
            return { failed: false };
        }
        if ("special" in step && step.special === "highPriestess") {
            const hpResult = this.validateHighPriestess(istep);
            if (!hpResult.valid) {
                return { failed: true, result: hpResult };
            }
            return { failed: false };
        }
        if ("special" in step && step.special === "fool") {
            const failure = checkFool(this.buildPowerContext());
            if (failure) {
                if (isFreshRootFool) {
                    // The ROOT Fool card's own untouched first flip stays a hard rejection.
                    return { failed: true, result: this.failureResult(failure) };
                }
                // Anywhere else, gracefully complete instead - there's nothing left to reveal.
            }
            return { failed: false };
        }
        const minionRef = istep!.withPiece;
        if (minionRef === undefined) {
            // A bare "/": the step is begun with nothing chosen for it, which leaves the move as complete as it was.
            if (istep!.action === "with") {
                return { failed: false, complete: false };
            }
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
            const suitUid = this.primitiveToSuit(step.primitive);
            if ((istep!.complete ?? -1) < 0) {
                return { failed: false, complete: false };
            }
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts, paired, priorTaken);
            return this.validateSuitPrimitive(suitUid, minion, istep!, opts);
        }
        if (step.special === "magicianChoice") {
            // The suit is always `borrowedPower` now - see applyPowerStep's matching cast for why it's still plain `string` here.
            const suitLetter = borrowedPower! as MinorSuitUid;
            if ((istep!.complete ?? -1) < 0) {
                return { failed: false, complete: false };
            }
            return this.validateSuitPrimitive(suitLetter, minion, istep!, {});
        }
        if ((istep!.complete ?? -1) < 0) {
            return { failed: false, complete: false };
        }
        const expectedAction = SPECIAL_STEP_ACTIONS[step.special];
        if (expectedAction !== undefined && istep!.action !== expectedAction) {
            // The fields line up with this power's shape, but the step is spelled as some other action (a "shrink" read as a "trade", a "create" read as an "orient").
            return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "WRONG_STEP_ACTION" }) };
        }
        // Every validate* method below can now assume complete, well-formed input - the completeness check above already ruled out anything else.
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
                if (!jResult.valid) {
                    return { failed: true, result: jResult };
                }
                const taken = istep!.cardList ?? [];
                const room = judgementDrawRoom((minion.piece ?? this.board.get(minion.x, minion.y)!.pieces[minion.index]).size, this.hands[this.currplayer - 1].length) - taken.length;
                return { failed: false, mayAddMore: room > 0 && this.discardPile.some(uid => !taken.includes(uid)) ? room : undefined };
            }
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "SPECIAL_NOT_FOUND" }) };
        }
    }

    // Derives the runtime relaxation opts a same-target-shortcut/Moon card's step needs, WITHOUT verifying the two steps share a target - deliberately simplified since it only ever widens legality.
    public computeShortcutOpts(
        def: MajorArcanaDef, primitive: SuitPrimitive,
        stepIndex: number, totalSteps: number, staticOpts: object | undefined,
        // False when this step is being validated/applied with no second step actually supplied - a two-step shortcut's waiver then doesn't apply.
        paired = true,
        // False when the card's previous power was skipped (this later power is being used alone), so there is no transient size to skip returning.
        priorTaken = true,
    ): Record<string, unknown> {
        const opts: Record<string, unknown> = { ...staticOpts };
        const waiverApplies = paired && stepIndex < totalSteps - 1;
        if (def.sameTargetShortcut) {
            if (primitive === "grow") {
                // Strength's first grow may jump two values at once (one step for both grows); the Sun's single grow is still one value at a time.
                if (stepIndex === 0 && def.powers.every(pw => "primitive" in pw && pw.primitive === "grow")) {
                    opts.skipLadder = true;
                }
                // Strength's own shortcut: a non-final grow step's resulting size is only transient, restored to its final size by the step after.
                if (waiverApplies) {
                    opts.skipStashCheck = true;
                }
                // Strength/Sun: a step past the first is growing a piece whose OWN current size was itself never really taken (the step before skipped it) - returning it now would over-credit the stash.
                if (stepIndex > 0 && priorTaken) {
                    opts.skipStashReturn = true;
                }
            } else if (primitive === "attack") {
                // Death's own shortcut: one shrink standing for both swords, so the first step may be worth up to twice the minion's pips.
                if (stepIndex === 0) {
                    opts.bothSwords = true;
                }
            } else if (primitive === "move" && waiverApplies) {
                opts.skipLandingCheck = true;
            } else if (primitive === "create") {
                // Sun's own shortcut: the created piece's initial size-1 form is only transient, grown to its final size by the step after.
                if (waiverApplies) {
                    opts.skipStashCheck = true;
                }
                // A created territory may go straight to royalty instead of a spot card grown by the step after - one step doing both jobs, so no second step is needed.
                if (stepIndex === 0) {
                    opts.allowRoyalty = true;
                }
            }
        }
        if (def.moonCapacityExemption && primitive === "move" && stepIndex === 0 && totalSteps >= 2 && paired) {
            opts.ignoreCapacity = true;
        }
        return opts;
    }

    private applySuitPrimitive(minion: () => IMinionRef, step: IStep, waypoint = false): IStepOutcome {
        const suitUid = ({ create: "C", move: "R", grow: "D", shrink: "S" } as Record<string, MinorSuitUid>)[step.action];
        const mode = stepMinorMode(suitUid, step)!;
        switch (suitUid) {
            case "C":
                // mode is stepMinorMode's own MinorMode union (shared across all 4 suits) - each branch below casts it back to ITS suit's own subset, which
                // this switch on suitUid guarantees is correct even though TS can't correlate the two independently-typed values on its own.
                return this.applyCups(mode as CupsMode, step);
            case "R":
                return this.applyRods(minion, mode as TargetMode, step, waypoint);
            case "D":
                return this.applyDiscs(mode as TargetMode, step);
            case "S":
                return this.applySwords(mode as TargetMode, step);
        }
    }

    public validateSuitPrimitive(suitUid: MinorSuitUid, minion: IMinionRef, step: IStep, opts: Record<string, unknown>): StepValidation {
        const mode = stepMinorMode(suitUid, step);
        if (mode === undefined) {
            // The step's action doesn't spell this suit's verb (or names no target) - not something a well-formed move for this power can contain.
            return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "WRONG_STEP_ACTION" }) };
        }
        switch (suitUid) {
            case "C":
                return this.validateCups(minion, mode as CupsMode, step, opts);
            case "R":
                return this.validateRods(minion, mode as TargetMode, step, opts);
            case "D":
                return this.validateDiscs(minion, mode as TargetMode, step, opts);
            case "S":
                return this.validateSwords(minion, mode as TargetMode, step, opts);
        }
    }

    // Cups - own <cell> <orientation> | enemy <cell> <victimRef> | new <cell> (<uid>|random)
    private applyCups(mode: CupsMode, step: IStep): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "own": {
                // The creation's mandatory initial facing, possibly still carrying a trailing "?" - makes no difference to the piece created, so it's stripped the same way cmdPlace strips its own.
                const cellStr = step.atCell!;
                const orientationToken = step.direction!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
                const orientation = orientationStr as Orientation;
                createOwn(ctx, tx, ty, orientation);
                this.addBufferIfWasteland(tx, ty);
                this.results.push({ type: "place", where: cellStr, how: "cups-own" });
                const newIndex = this.board.get(tx, ty)!.pieces.length - 1;
                return { newMinion: { x: tx, y: ty, index: newIndex }, softComplete: orientationToken.endsWith("?") };
            }
            case "enemy": {
                const cellStr = step.atCell!;
                const victimRef = step.targetPiece!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // victimRef is a full piece ref (#106) - validateCups already confirmed it names a piece at this cell, so its index is trusted directly.
                const { index: victimIndex } = this.resolvePieceRefTrusted(victimRef);
                const victimOwner = this.board.get(tx, ty)!.pieces[victimIndex].owner;
                createEnemy(ctx, tx, ty, victimIndex);
                this.results.push({ type: "place", where: cellStr, how: "cups-enemy", who: victimOwner });
                return {}; // the new piece belongs to the targeted enemy, not the acting player
            }
            case "new": {
                const cellStr = step.atCell!;
                const cardArg = step.card;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // "drawn" is parsed as step.amount === 1 (pickleMove's own sentinel, since step.card must always be a real card uid).
                if (step.amount === 1) {
                    this.hidden.push({ type: "territory", x: tx, y: ty });
                    return {};
                }
                createTerritory(ctx, tx, ty, cardArg!);
                this.results.push({ type: "place", where: cellStr, how: "territory", what: cardArg! });
                return this.cardValueByUid(cardArg!) === 2 ? { consumesRest: true } : {};
            }
        }
    }

    private validateCups(minion: IMinionRef, mode: CupsMode, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "own": {
                // A brand-new minion can't reasonably go unoriented - "U" is a real, always-legal choice, never auto-assigned but always REQUIRED as an explicit fact of creation.
                const cellStr = step.atCell!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // parseMove already guarantees a valid N/E/S/W/U (with or without the "?" marking a seeded default), so there's nothing left to validate about the facing.
                const failure = checkCreateOwn(ctx, minion.x, minion.y, minion.index, tx, ty, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
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
        }
    }

    // Rods - piece <targetRef> <dist> [orientation] | tile <dist>
    private applyRods(minion: () => IMinionRef, mode: TargetMode, step: IStep, waypoint: boolean): IStepOutcome {
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
                const actor = minion();
                const actorPiece = actor.piece ?? this.board.get(actor.x, actor.y)!.pieces[actor.index];
                const facing = actorPiece.orientation;
                // Named only when it stays put, so the render can ring it; a minion that moves itself is the moved piece.
                const by = actor.x === target.x && actor.y === target.y && actor.index === target.index ? undefined : this.pieceIdAt(actor.x, actor.y, actorPiece);
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "U">);
                const destX = target.x + dx * dist;
                const destY = target.y + dy * dist;
                // A genuine final landing (not a Chariot-relaxed waypoint) in the void destroys the piece instead of moving it.
                const destroyedInVoid = !waypoint && this.board.classify(destX, destY) === "void";
                const origin = GnosticaBoard.coords2algebraic(target.x, target.y);
                movePiece(ctx, actor.x, actor.y, actor.index, target.x, target.y, target.index, dist, newOrientation, waypoint);
                if (destroyedInVoid) {
                    this.results.push({ type: "destroy", where: origin, what: this.getPipsFromRef(targetRef), who: movedOwner });
                    // Still a real removeAt at target's old slot.  replacesMinion is reported even with no newMinion.
                    return { replacesMinion: { x: target.x, y: target.y, index: target.index } };
                }
                const dest = GnosticaBoard.coords2algebraic(destX, destY);
                this.results.push({ type: "move", by, from: origin, to: dest, what: this.getPipsFromRef(targetRef), how: "rod-piece", who: movedOwner });
                if (movedOwner === this.currplayer) {
                    const landed = this.board.get(destX, destY)!.pieces;
                    const newIndex = landed.length - 1;
                    return { newMinion: { x: destX, y: destY, index: newIndex, piece: landed[newIndex] }, replacesMinion: { x: target.x, y: target.y, index: target.index }, softComplete: orientationStr === undefined, movedToCell: { x: destX, y: destY } };
                }
                const producedIndex = this.board.get(destX, destY)!.pieces.length - 1;
                return { replacesMinion: { x: target.x, y: target.y, index: target.index }, movedToCell: { x: destX, y: destY }, producedPiece: { x: destX, y: destY, index: producedIndex } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const dist = step.amount!;
                const [srcX, srcY] = GnosticaBoard.algebraic2coords(cellStr);
                const actor = minion();
                const actorPiece = actor.piece ?? this.board.get(actor.x, actor.y)!.pieces[actor.index];
                const [dx, dy] = this.board.delta(actorPiece.orientation as Exclude<Orientation, "U">);
                moveTerritory(ctx, actor.x, actor.y, actor.index, srcX, srcY, dist);
                const to = GnosticaBoard.coords2algebraic(srcX + dx * dist, srcY + dy * dist);
                this.results.push({ type: "move", by: this.pieceIdAt(actor.x, actor.y, actorPiece), from: cellStr, to, how: "rod-tile" });
                return {};
            }
        }
    }

    private validateRods(minion: IMinionRef, mode: TargetMode, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const dist = step.amount!;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const failure = checkMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, dist, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
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
        }
    }

    // Discs - piece <targetRef> [orientation] | tile <cell> <newCardUid>
    private applyDiscs(mode: TargetMode, step: IStep): IStepOutcome {
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
                growPiece(ctx, target.x, target.y, target.index, newOrientation);
                this.results.push({ type: "convert", what: `size ${beforeSize}`, into: `size ${beforeSize + 1}`, where: GnosticaBoard.coords2algebraic(target.x, target.y), who: owner });
                if (owner === this.currplayer) {
                    const grown = this.board.get(target.x, target.y)!.pieces;
                    const newIndex = grown.length - 1;
                    return { newMinion: { x: target.x, y: target.y, index: newIndex, piece: grown[newIndex] }, replacesMinion: { x: target.x, y: target.y, index: target.index }, softComplete: orientationStr === undefined };
                }
                // Grown into a piece this pool doesn't track (an enemy's) - still a real removeAt at target's old slot, so chainMinion still needs to know.
                const grownIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
                return { replacesMinion: { x: target.x, y: target.y, index: target.index }, producedPiece: { x: target.x, y: target.y, index: grownIndex } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card!;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const beforeUid = this.board.get(tx, ty)!.card!.uid;
                const jumpsTwo = this.cardValueByUid(newCardUid) - this.board.get(tx, ty)!.pointValue() === 2;
                growTerritory(ctx, tx, ty, newCardUid);
                this.results.push({ type: "convert", what: beforeUid, into: newCardUid, where: cellStr });
                return jumpsTwo ? { consumesRest: true } : {};
            }
        }
    }

    private validateDiscs(minion: IMinionRef, mode: TargetMode, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const failure = checkGrowPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
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
        }
    }

    // Swords - piece <targetRef> <pips> [orientation] | tile <cell> <pips> [newCardUid]
    private minionSize(minion: IMinionRef): number {
        return (minion.piece ?? this.board.get(minion.x, minion.y)!.pieces[minion.index]).size;
    }

    // The value of a card by uid, for recognizing when a one-step shortcut was used.
    private cardValueByUid(uid: string): number {
        return cardPointValue(allCards().find(c => c.uid === uid)!);
    }

    // Death's shortcut lets one shrink stand for both of its swords, so a total larger than what's there is just a wipeout (a 4 acts as a 3).
    private effectiveShrink(amount: number, available: number, opts: Record<string, unknown>): number {
        return opts.bothSwords === true && available > 0 ? Math.min(amount, available) : amount;
    }

    private applySwords(mode: TargetMode, step: IStep): IStepOutcome {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const orientationStr = step.direction;
                const target = this.resolvePieceRefTrusted(targetRef);
                const newOrientation = orientationStr as Orientation | undefined;
                const targetPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                // Death's one shrink for both swords may exceed what the victim has: the excess is wasted.
                const pips = Math.min(step.amount!, targetPiece.size);
                const owner = targetPiece.owner;
                const beforeSize = targetPiece.size;
                attackPiece(ctx, target.x, target.y, target.index, pips, newOrientation);
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
                    return { newMinion: { x: target.x, y: target.y, index: newIndex, piece: shrunk[newIndex] }, replacesMinion: { x: target.x, y: target.y, index: target.index }, softComplete: orientationStr === undefined, shrunkBy: pips };
                }
                // Destroyed outright, or shrunk but not into a piece this pool tracks (an enemy's) - still a real removeAt at target's old slot, so chainMinion still needs to know.
                // Only a true destroy actually frees a slot at this cell - that alone satisfies Moon's capacity-restoration requirement.
                return { replacesMinion: { x: target.x, y: target.y, index: target.index }, destroyedAtCell: resultSize === 0 ? { x: target.x, y: target.y } : undefined, shrunkBy: pips };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const beforeUid = this.board.get(tx, ty)!.card!.uid;
                const pips = Math.min(step.amount!, this.board.get(tx, ty)!.pointValue());
                attackTerritory(ctx, tx, ty, pips, newCardUid);
                // A replacement card means the territory survived, shrunk; only a true wipeout (no replacement) is a "destroy".
                if (newCardUid === undefined) {
                    this.results.push({ type: "destroy", where: cellStr, what: beforeUid });
                } else {
                    this.results.push({ type: "convert", what: beforeUid, into: newCardUid, where: cellStr });
                }
                return { shrunkBy: pips };
            }
        }
    }

    private validateSwords(minion: IMinionRef, mode: TargetMode, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const targetPiece = target.piece ?? this.board.get(target.x, target.y)!.pieces[target.index];
                const pips = this.effectiveShrink(step.amount!, targetPiece.size, opts);
                const failure = checkAttackPiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, pips, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const pips = this.effectiveShrink(step.amount!, this.board.get(tx, ty)?.pointValue() ?? 0, opts);
                const failure = checkAttackTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, pips, newCardUid, opts);
                if (failure) {
                    return { failed: true, result: this.failureResult(failure) };
                }
                return { failed: false };
            }
        }
    }

    // orientMinion ("orient <ref> <facing>") turns the minion itself; orientAny (Devil, "with <ref> orient <target> <facing>") turns any piece. Same write either way.
    private applyOrient(minion: () => IMinionRef, step: IStep): IStepOutcome {
        const orientation = step.direction! as Orientation;
        const own = step.targetPiece === undefined || step.targetPiece.toLowerCase() === step.withPiece?.toLowerCase();
        const target = own ? minion() : this.resolvePieceRefTrusted(step.targetPiece!);
        const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        orientAny(this.buildPowerContext(), target.x, target.y, target.index, orientation);
        this.addBufferIfWasteland(target.x, target.y);
        this.pushOrientResult(target.x, target.y, target.index, own ? this.pieceRefStr(target) : step.targetPiece!, orientation);
        return own || owner === this.currplayer ? { newMinion: target, replacesMinion: target } : {};
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
        return { failed: false };
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
        return { failed: false };
    }

    // Hierophant: <minionRef> <targetPieceRef> <seededFacing>["?"] [<reorientation>]
    private applyHierophantReplace(step: IStep): IStepOutcome {
        const targetRef = step.targetPiece!;
        const orientationToken = step.direction!;
        const target = this.resolvePieceRefTrusted(targetRef);
        // Captured before the replace mutates the board - the previous owner being displaced, for the result log.
        const previousOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
        const orientation = orientationStr as Orientation;
        hierophantReplace(this.buildPowerContext(), target.x, target.y, target.index, orientation);
        this.addBufferIfWasteland(target.x, target.y);
        this.results.push({ type: "convert", what: this.getPipsFromRef(targetRef), into: `owner-${this.currplayer}`, where: GnosticaBoard.coords2algebraic(target.x, target.y), who: previousOwner });
        const replaced = this.board.get(target.x, target.y)!.pieces;
        const newIndex = replaced.length - 1;
        return { newMinion: { x: target.x, y: target.y, index: newIndex, piece: replaced[newIndex] }, replacesMinion: { x: target.x, y: target.y, index: target.index }, softComplete: orientationToken.endsWith("?") };
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
        if (orientationToken === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationToken }) };
        }
        // parseMove already guarantees a valid N/E/S/W/U (with or without a "?" marking the click handler's seeded default), so there's nothing left to validate about the facing.
        const failure = checkHierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        return { failed: false };
    }

    // Hermit - <minionRef> fly <targetPieceRef> to <destCell> [orient <direction>] | <minionRef> fly <cardUid> to <destCell>
    private applyHermitStep(step: IStep): IStepOutcome {
        const mode = stepHermitMode(step)!;
        const ctx = this.buildPowerContext();
        const destCellStr = step.targetCell!;
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const target = this.resolvePieceRefTrusted(targetRef);
                const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
                const [destX, destY] = GnosticaBoard.algebraic2coords(destCellStr);
                const newOrientation = step.direction as Orientation | undefined;
                const origin = GnosticaBoard.coords2algebraic(target.x, target.y);
                hermitMovePiece(ctx, target.x, target.y, target.index, destX, destY, newOrientation);
                this.results.push({ type: "move", from: origin, to: destCellStr, what: this.getPipsFromRef(targetRef), how: "hermit-piece", who: owner });
                if (owner === this.currplayer) {
                    const newIndex = this.board.get(destX, destY)!.pieces.length - 1;
                    return { newMinion: { x: destX, y: destY, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
                }
                return { replacesMinion: { x: target.x, y: target.y, index: target.index } };
            }
            case "tile": {
                const { x: tx, y: ty } = this.resolveTileCard(step.card)!;
                const [destX, destY] = GnosticaBoard.algebraic2coords(destCellStr);
                hermitMoveTerritory(ctx, tx, ty, destX, destY);
                this.results.push({ type: "move", from: GnosticaBoard.coords2algebraic(tx, ty), to: destCellStr, how: "hermit-tile" });
                return {};
            }
        }
    }

    public validateHermitStep(minion: IMinionRef, step: IStep): StepValidation {
        const mode = stepHermitMode(step)!;
        const ctx = this.buildPowerContext();
        const destCellStr = step.targetCell!;
        const [destX, destY] = GnosticaBoard.algebraic2coords(destCellStr);
        switch (mode) {
            case "piece": {
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
                return { failed: false };
            }
            case "tile": {
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
        }
    }

    // Justice / Hanged Man: <minionRef> <targetPieceRef> - swaps hands, but only once the move is committed: the other player's hand is hidden from a preview.
    private applyTradeHands(step: IStep): IStepOutcome {
        const targetRef = step.targetPiece!;
        const target = this.resolvePieceRefTrusted(targetRef);
        this.hidden.push({ type: "trade", x: target.x, y: target.y, index: target.index });
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
    private applyJudgementDraw(step: IStep): void {
        const uids = step.cardList ?? [];
        judgementDraw(this.buildPowerContext(), uids);
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
        discardCards(this.buildPowerContext(), discardUids);
        if (!partial && discardUids.length > 0) {
            this.discarded.push(...discardUids);
            this.results.push({ type: "place", how: "discard", what: discardUids.join(",") });
        }
        this.hidden.push({ type: "draw", count: Number(drawCountStr), setsCardsDrawn: false, joinsGroup: !partial && discardUids.length > 0 });
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

    // A card is unique, so its legend key needs no location; every hidden card shares the one face-down key.
    private static cardKey(uid: string): string {
        return uid === UNREVEALED_UID ? "cUNKNOWN" : `c${uid}`;
    }

    private static cardKeyUid(piece: string | undefined): string | undefined {
        return piece !== undefined && /^c[^_]+$/.test(piece) ? piece.slice(1) : undefined;
    }

    // Sort cards by their index in allCards.
    private static handSortKey(uid: string): number {
        const card = allCards().find(c => c.uid === uid);
        return card === undefined ? 100 : allCards().indexOf(card);
    }

    // Cards drawn at the end of their last turn, for highlighting by render() - only non-empty for the CURRENT player, and only until they've started building THIS turn's move.
    private newHandCardUids(player: playerid): Set<string> {
        if (player !== this.currplayer || this.preview !== undefined) {
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

    // A disposable copy for applying steps onto, without the full-history serialization clone() pays - nothing here reads earlier stack entries.
    private scratchClone(): GnosticaGame {
        const raw = this.state();
        raw.stack = [this.moveState()];
        return new GnosticaGame(JSON.stringify(raw, replacer));
    }

    // Each frame of a 2+-step chain holds the board before a step and shows the results of the step that led to it; the live state comes last and alone carries the hands, pools and buttons.
    public render(opts?: IRenderOpts): APRenderRep[] {
        const largerCards = opts?.altDisplay === "larger-cards";

        // A chain wraps each step's results into a _group entry; whatever else the move did (a "use", a declaration) goes with the last rep.
        const groups = this.results.filter((r): r is Extract<APMoveResult, { type: "_group" }> => r.type === "_group");
        const ungrouped = this.results.filter(r => r.type !== "_group");

        const discardLabel = i18next.t("apgames:validation.gnostica.LABEL_DISCARDS");
        const strokeColour = {
            func: "flatten" as const,
            fg: "_context_strokes",
            bg: "_context_board",
            opacity: 0,
        };

        // Built once and edited per frame: a card's face depends on where it is in the frame, so every frame assigns the cards it shows afresh.
        const legend: ILegendObj = { ["cUNKNOWN"]: GnosticaGame.markerStack([{
            name: "piece-square-borderless",
            colour: {
                func: "flatten",
                fg: "_context_fill",
                bg: "_context_background",
                opacity: 0.5,
            },
        }])};
                                   
        const faces = new Map<string, string>();

        const renders: APRenderRep[] = [];
        // We need to look at each frame, and then finally the live state.
        for (let i = 0; i <= this.frames.length; i++) {
            const last = i === this.frames.length;
            const board = last ? this.board : new GnosticaBoard(this.frames[i].board);
            const results: APMoveResult[] = i > 0 && groups[i - 1] !== undefined ? [...groups[i - 1].results] : [];
            if (last) {
                results.push(...ungrouped);
            }

            const { minX, maxX, minY, maxY } = this.renderWindow(board);
            const width = maxX - minX + 1;
            const height = maxY - minY + 1;

            // Every void cell is the bare "-" with no legend entry or clickable region - a wasteland piece facing into one gets a `buffer` area instead, not a click target baked into the grid.
            const rings = this.ringsFromResults(results, board);
            const { pieceRows, markers } = this.buildBoardLayers(board, { minX, maxX, minY, maxY }, largerCards, legend, faces, last ? new Map([...rings, ...this.pieceRings()]) : rings);

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

            const areas: (AreaPieces | AreaButtonBar | AreaKey)[] = [];
            if (!last) {
                // The discard pile is always face-up/public - the one non-board area worth reconstructing for an earlier frame; no "just discarded" tinting since that's a live-only concept.
                const discardArea = this.buildAreaFromSummary(
                    this.frames[i].discardSummary, legend, faces, discardLabel
                );
                if (discardArea !== undefined) {
                    areas.push(discardArea);
                }
            } else {
                // One area per player's hand, full-size (non-spaced) card faces.
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
                            handKeys.push(GnosticaGame.cardKey(UNREVEALED_UID));
                            continue;
                        }
                        // A card just added to hand gets its face tinted so it's easy to spot regardless of sort order.
                        const isNew = newUids.has(uid);
                        const key = GnosticaGame.cardKey(uid);
                        GnosticaGame.setCardFace(legend, faces, key, `full|${isNew}`, () => this.buildCardFace(card, false, 0, isNew ? { background: MUTED_FILL } : {}));
                        handKeys.push(key);
                    }
                    areas.push({
                        type: "pieces",
                        pieces: handKeys as [string, ...string[]],
                        label: i18next.t("apgames:validation.gnostica.LABEL_HAND", { playerNum: p, declared: this.lastTurner === p ? "(declarer)" : "" }),
                        spacing: 0.25,
                        width: 6,
                        ownerMark: p,
                    });
                }

                // The "bidding" variant's shared pool - every card revealed by the opening bid procedure, available for anyone to redraw; fully public, no redaction needed.
                if (this.biddingPool !== undefined && this.biddingPool.length > 0) {
                    const poolKeys: string[] = [];
                    for (const uid of this.biddingPool) {
                        const card = allCards().find(c => c.uid === uid)!;
                        const key = GnosticaGame.cardKey(uid);
                        GnosticaGame.setCardFace(legend, faces, key, "full|false", () => this.buildCardFace(card, false));
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

                // The declaration round banner: once a declaration is committed, but not in the turn it is made (when it is still staged in `continued`).
                if (this.lastTurner !== undefined) {
                    legend.Warning = [
                        { name: "piece-borderless", colour: "_context_background" },
                        { text: "\u{26A0}", colour: "#f00", orientation: "vertical" },
                    ];
                    areas.push({
                        type: "pieces",
                        pieces: ["Warning"],
                        label: i18next.t("apgames:validation.gnostica.LABEL_WARNING"),
                        spacing: 0.25,
                        width: 1,
                    });
                }

                // The literal drawPile array isn't used for the draw-pile summary - "what's left to draw" is computed by elimination: every card in the full deck not visible somewhere else.
                const drawArea = this.buildDeckSummaryArea(
                    this.unseenCardUids(), legend, faces, i18next.t("apgames:validation.gnostica.LABEL_DECK")
                );
                if (drawArea !== undefined) {
                    areas.push(drawArea);
                }
                // The discard pile is always face-up/public, unlike hands or the draw pile, so its contents are read directly.
                const discardArea = this.buildDeckSummaryArea(
                    this.discardPile, legend, faces, discardLabel, new Set(this.discarded)
                );
                if (discardArea !== undefined) {
                    areas.push(discardArea);
                }

                // Shown whenever it has real content: a bidding game always has turn order to show (any player count - even at 2 players,
                // "you, then them" is still worth confirming once icon rows can share the same key), and any game can have icon rows once a
                // card is actively mid-build this turn, bidding or not.
                const list: AreaKey["list"] = [];
                if (this.variants.includes("bidding")) {
                    this.turnOrder!.forEach((p, place) => {
                        const key = `turnorder_p${p}`;
                        if (!(key in legend)) {
                            legend[key] = { name: "pyramid-up-small", colour: p };
                        }
                        list.push({ piece: key, name: GnosticaGame.ordinal(place + 1) });
                    });
                }
                // The card whose own step is CURRENTLY resolving (follows World's borrow/Fool's reveal, not pinned to the root card) -
                // undefined once nothing is mid-build, including right after a commit (this.preview is cleared then).
                const activeCard = allCards().find(c => c.uid === this.preview?.pending?.activeCardUid);
                if (activeCard !== undefined) {
                    const icons = activeCard.major ? getMajorArcanaIcons(activeCard) : (activeCard.suit.glyph !== undefined ? [activeCard.suit.glyph] : []);
                    for (const icon of icons) {
                        const key = `activecard_${icon}`;
                        if (!(key in legend)) {
                            // Circle-backed, matching every other place these icons appear (buildCardFace's own pushCircle) - a bare
                            // icon glyph alone reads too thin/low-contrast next to the turn-order rows' own solid pyramids.
                            legend[key] = [
                                { name: "piece", colour: "_context_board" },
                                { name: icon, scale: 0.5 },
                            ];
                        }
                        list.push({ piece: key, name: "" });
                    }
                }
                if (list.length > 0) {
                    // "left", not "right" - the action button bar already owns the right side, and the two don't stack cleanly on the same side.
                    areas.push({ type: "key", list, position: "left", height: 0.7, clickable: false });
                }

                // The top-level turn choice as buttons rather than inferring intent from board clicks alone.
                const actionButtons = this.withUndo(this.getActionButtons());
                if (actionButtons !== undefined) {
                    areas.push({ type: "buttonBar", position: "right", buttons: actionButtons });
                }
            }

            const rep: APRenderRep = {
                renderer: "stacking-offset",
                // A click on a pyramid reports its stack index, which handleClick would take for a legend piece; cells are what we want clicked.
                options: ["no-piece-click"],
                board: {
                    style: "squares",
                    stackOffset: 0,
                    width,
                    height,
                    columnLabels,
                    rowLabels,
                    strokeColour,
                    buffer: !last || this.buffers.length === 0 ? undefined : {
                        separated: true,
                        width: 0.2,
                        pattern: "dots",
                        show: [...this.buffers] as ("N" | "E" | "S" | "W")[],
                    },
                    markers,
                },
                legend: { ...legend },
                pieces: pieceRows as [string[][], ...string[][][]],
                areas: areas.length > 0 ? areas : undefined,
            };

            const annotations: NonNullable<APRenderRep["annotations"]> = [];
            for (const r of results) {
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

            renders.push(rep);
        }
        return renders;
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

    // The cards nobody can see, which is to say the draw pile.
    private unseenCardUids(): string[] {
        const visible = this.visibleCardUids();
        return allCards().filter(c => !visible.has(c.uid)).map(c => c.uid);
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
        summary: DiscardSummary, legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, faces: Map<string, string>, label: string,
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
                const key = `${bucket}_${count}`;
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
            const key = GnosticaGame.cardKey(uid);
            GnosticaGame.setCardFace(legend, faces, key, "full|false", () => this.buildCardFace(allCards().find(c => c.uid === uid)!, false));
            pieces.push(key);
        }
        if (pieces.length === 0) {
            return undefined;
        }
        return { type: "pieces", pieces: pieces as [string, ...string[]], label, spacing: 0.25, width: 10 };
    }

    // Summary code because Draw/discard piles can be large. Minors summarize as one token per (suit, spot-or-royalty) bucket with a count; majors are shown individually.
    private buildDeckSummaryArea(
        uids: string[], legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, faces: Map<string, string>, label: string,
        newUids: Set<string> = new Set(),
    ): AreaPieces | undefined {
        if (uids.length === 0) {
            return undefined;
        }
        const counts = new Map<string, number>();
        const newBuckets = new Set<string>();
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
                    newBuckets.add(bucket);
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
                const key = `${bucket}_${count}${newBuckets.has(bucket) ? "_shaded" : ""}`;
                if (!(key in legend)) {
                    legend[key] = this.buildCardFace(representative, false, 0, {
                        borderless: true,
                        rankText: `${count}x`,
                        ...(newBuckets.has(bucket) ? { background: MUTED_FILL } : {}),
                    }) as [Glyph, ...Glyph[]];
                }
                pieces.push(key);
            }
        }
        for (const uid of majorUids.sort()) {
            const isNew = newUids.has(uid);
            const key = GnosticaGame.cardKey(uid);
            GnosticaGame.setCardFace(legend, faces, key, `full|${isNew}`, () => this.buildCardFace(allCards().find(c => c.uid === uid)!, false, 0, isNew ? { background: MUTED_FILL } : {}));
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

    // "<cell>.<piece id>": names a piece in a result well enough to find it again on the finished board.
    private pieceIdAt(x: number, y: number, piece: Piece): string {
        return `${GnosticaBoard.coords2algebraic(x, y)}.${piece.id()}`;
    }

    // The pieces a move's results name, ringed like the live preview does: each target solid, and a Rods move's own minion dashed.
    private ringsFromResults(results: APMoveResult[], board: GnosticaBoard): Map<string, "minion" | "target"> {
        const rings = new Map<string, "minion" | "target">();
        // The last match, since a piece that moved or changed hands is added to the end of its cell.
        const ring = (cell: string, kind: "minion" | "target", match: (p: Piece) => boolean) => {
            const [x, y] = GnosticaBoard.algebraic2coords(cell);
            const i = (board.get(x, y)?.pieces ?? []).map(match).lastIndexOf(true);
            if (i >= 0 && (kind === "target" || !rings.has(`${x},${y},${i}`))) {
                rings.set(`${x},${y},${i}`, kind);
            }
        };
        for (const r of results) {
            switch (r.type) {
                case "move": {
                    if (r.by !== undefined) {
                        const [cell, id] = r.by.split(".");
                        ring(cell, "minion", p => p.id() === id);
                    }
                    if (r.how === "rod-piece" || r.how === "hermit-piece") {
                        ring(r.to!, "target", p => p.owner === r.who && p.size === Number(r.what));
                    }
                    break;
                }
                case "convert":
                    if (r.into!.startsWith("size ")) {
                        ring(r.where!, "target", p => p.owner === r.who && p.size === Number(r.into!.slice(5)));
                    } else if (r.into!.startsWith("owner-")) {
                        ring(r.where!, "target", p => p.owner === Number(r.into!.slice(6)) && p.size === Number(r.what));
                    }
                    break;
                case "orient":
                    ring(r.where!, "target", p => p.owner === r.who && p.size === Number(r.what) && p.orientation === r.facing);
                    break;
            }
        }
        return rings;
    }

    // The pieces to ring in a live preview: the step's minion (or every candidate while it's still ambiguous which one is meant), and the target piece once picked, which wins on a self-target.
    private pieceRings(): Map<string, "minion" | "target"> {
        const rings = new Map<string, "minion" | "target">();
        const pending = this.preview?.pending;
        if (pending === undefined) {
            return rings;
        }
        const ringIfThere = (m: IMinionRef, kind: "minion" | "target") => {
            const onBoard = this.board.get(m.x, m.y)?.pieces[m.index];
            if (onBoard !== undefined && (m.piece === undefined || m.piece.id() === onBoard.id())) {
                rings.set(`${m.x},${m.y},${m.index}`, kind);
            }
        };
        for (const m of pending.minionAmbiguous ? pending.minionCandidates : [pending.minion]) {
            ringIfThere(m, "minion");
        }
        const target = pending.istep.targetPiece === undefined ? undefined : pending.game.resolvePieceRef(pending.istep.targetPiece);
        if (target?.kind === "ok") {
            ringIfThere(target.ref, "target");
        }
        return rings;
    }

    // The board grid as two layers: a glyph marker for each card (and each wasteland), and in the pieces layer one legend entry per distinct set of pieces in a cell.
    // Cards are unique, so each card's legend entry is built for its one cell. Every other cell is the bare "-".
    private buildBoardLayers(
        board: GnosticaBoard, win: { minX: number; maxX: number; minY: number; maxY: number }, largerCards: boolean,
        legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, faces: Map<string, string>,
        rings?: Map<string, "minion" | "target">,
    ): { pieceRows: string[][][]; markers: (MarkerOutline | MarkerGlyph)[] } {
        const pieceRows: string[][][] = [];
        const markers: (MarkerOutline | MarkerGlyph)[] = [];
        const wastelands: { row: number; col: number }[] = [];
        for (let y = win.minY; y <= win.maxY; y++) {
            const rowCells: string[][] = [];
            for (let x = win.minX; x <= win.maxX; x++) {
                const cls = board.classify(x, y);
                const t = board.get(x, y);
                const point = { row: y - win.minY, col: x - win.minX };
                if (t?.card !== undefined) {
                    const key = GnosticaGame.cardKey(t.cardUid!);
                    const players = t.playersPresent();
                    const owner = players.size === 1 ? [...players][0] : 0;
                    if (owner !== 0) {
                        markers.push({ type: "outline", colour: owner, points: [point] });
                    }
                    const dontSpace = largerCards && players.size === 0;
                    if (t.cardUid !== UNREVEALED_UID) {
                        GnosticaGame.setCardFace(legend, faces, key, `board|${!dontSpace}|${owner}`, () => GnosticaGame.markerStack(this.buildCardFace(t.card!, !dontSpace, owner)));
                    }
                    markers.push({ type: "glyph", glyph: key, points: [point] });
                } else if (cls === "wasteland") {
                    wastelands.push(point);
                }
                const pieces = t?.pieces ?? [];
                const slots = this.pieceGridSlots(pieces);
                rowCells.push(pieces.flatMap((piece, i) => {
                    // Keys end up as literal DOM ids in the renderer, so no "." (a rounded slot can't carry one).
                    const slot = slots[i];
                    const key = `p_${piece.id()}_${Math.round(slot.dx)}_${Math.round(slot.dy)}_${Math.round(slot.scale * 100)}`;
                    const g = this.pyramidGlyph(piece);
                    g.scale = slot.scale;
                    g.nudge = { dx: slot.dx, dy: slot.dy };
                    if (!(key in legend)) {
                        // Slots lie out to the edges of the cell, so the symbol has to be cell-sized (backdrop scale 1) or the outer pyramids are cropped.
                        legend[key] = GnosticaGame.withBackdrop([g], 1);
                    }
                    const ring = rings?.get(`${x},${y},${i}`);
                    if (ring === undefined) {
                        return [key];
                    }
                    const ringKey = `ring_${ring}_${key}`;
                    if (!(ringKey in legend)) {
                        // A target is a solid ring and a minion a dashed one; a flat pyramid's centroid lies `drop` below its glyph's centre, so the ring takes the pyramid's rotation to share that nudge.
                        const drop = piece.orientation === "U" ? 0 : [46.3, 63.7, 81][piece.size - 1];
                        legend[ringKey] = GnosticaGame.withBackdrop([{
                            name: ring === "target" ? "piece" : "piece-dashed", rotate: g.rotate, scale: slot.scale, opacity: 0,
                            nudge: { dx: slot.dx, dy: slot.dy + drop },
                        }], 1);
                    }
                    return [ringKey, key];
                }));
            }
            pieceRows.push(rowCells);
        }
        if (wastelands.length > 0) {
            // Same transparent-by-default convention as buildCardFace's own backdrop, so the theme's board colour shows through here too.
            legend.waste = GnosticaGame.markerStack([{ name: "piece-square-dashed", scale: 1, opacity: 0 }]);
            markers.push({ type: "glyph", glyph: "waste", points: wastelands as [{ row: number; col: number }, ...{ row: number; col: number }[]] });
        }
        return { pieceRows, markers };
    }

    // Puts a card's face in the legend unless its key already holds this variant of it: a card's face depends on where it is, so a later frame rebuilds only the cards that moved or changed.
    private static setCardFace(legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, faces: Map<string, string>, key: string, variant: string, face: () => Glyph[]): void {
        if (faces.get(key) !== variant) {
            legend[key] = face() as [Glyph, ...Glyph[]];
            faces.set(key, variant);
        }
    }

    // A marker is drawn at the full size of its cell, but the pieces layer is scaled down. Scaling only `scale` (a nudge is applied inside the scale transform, so it shrinks with it) keeps the card the size it was when it lived in the pieces layer.
    private static markerStack(stack: Glyph[]): [Glyph, ...Glyph[]] {
        return GnosticaGame.withBackdrop(stack.map(g => ({ ...g, scale: (g.scale ?? 1) * 0.85 })), 1);
    }

    // The renderer sizes a legend symbol to its largest glyph, so an invisible glyph of a given scale fixes how big the rest of the stack is drawn inside it.
    private static withBackdrop(stack: Glyph[], scale: number): [Glyph, ...Glyph[]] {
        return [{ name: "piece-square-borderless", scale, opacity: 0 }, ...stack];
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
        // A previewed first step of Strength or the Sun can dip an empty size below zero until the second step returns it.
        return stash.map((count, i) => ({
            count: Math.max(0, count),
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
