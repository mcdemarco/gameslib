import { IAPGameState, IClickResult, IIndividualState, IRenderOpts, IScores, IValidationResult, type ChatLogEntry, type ChatLogLine, type StructuredRenderLabel } from "./_base.js";
import { GameBaseSequenced } from "./_turn-sequenced.js";
import type { IGamePly } from "./_turn-model.js";
import { APGamesInformation } from "../schemas/gameinfo.js";
import { APRenderRep, AreaButtonBar, AreaKey, AreaPieces, ButtonBarButton, Glyph, MarkerGlyph, MarkerOutline } from "@abstractplay/renderer/build/schemas/schema";
import type { ColourResolvable, Colourfuncs } from "@abstractplay/renderer/build/schemas/schema";
import { APMoveResult } from "../schemas/moveresults.js";
import { Direction, DirectionCardinal, replacer, reviver, shuffle, UserFacingError } from "../common/index.js";
import { UnboundedSquareBoard } from "../common/unbounded-square-board.js";
import { Deck, Card, TarotCard, allCards, ranks, suits } from "../common/tarot/index.js";
import { CellClass, GnosticaBoard } from "./gnostica/board.js";
import { CellContents, ICellContents, cardPointValue, UNREVEALED_CARD, UNREVEALED_UID } from "./gnostica/cell.js";
import { Piece, Pips, Orientation, allOrientations, cardinalOrientations } from "./gnostica/piece.js";
import { MAJOR_ARCANA, MajorArcanaDef, POWERS, PowerStep, PrimitiveOpts, SpecialPower, SuitPrimitive } from "./gnostica/majorArcana.js";
import { generateRandomMove } from "./gnostica/randomMove.js";
import i18next from "i18next";

export type playerid = 1|2|3|4|5|6;

type Stash = [number, number, number];

interface ILegendObj {
    [key: string]: Glyph|[Glyph, ...Glyph[]];
}

interface PowerFailure {
    key: string;
    params?: Record<string, unknown>;
}

const cardByUid = (uid: string): TarotCard => allCards().find(c => c.uid === uid)!;

const takeFromPile = (pile: string[], uid: string): TarotCard => {
    pile.splice(pile.indexOf(uid), 1);
    return cardByUid(uid);
};

const checkOwnMinion = (minion: Piece, player: number): PowerFailure | undefined => {
    if (minion.owner !== player) {
        return { key: "NOT_YOUR_MINION" };
    }
    return undefined;
};

// Rods - Move

// Discs - Grow

// How many cards a Judgement draw may take in all: one per pip of the acting minion, as far as the hand has room.
const judgementDrawRoom = (minionSize: number, handSize: number): number => Math.min(minionSize, Math.max(0, 6 - handSize));

// ---- Power step grammar: suit/mode constants and IStep-based mode inference (never legality) ----

// The four minor-arcana suits.
type MinorSuitUid = "C" | "R" | "D" | "S";
// Rods/Discs/Swords' own step target, and Hermit's fly mode (same shape, different power).
type TargetMode = "piece" | "tile";
type CupsMode = "own" | "enemy" | "new";
type MinorMode = CupsMode | TargetMode;

// The four minor-arcana suits.
const ALL_SUITS: { uid: MinorSuitUid; label: string }[] = [
    { uid: "C", label: "Cups" },
    { uid: "R", label: "Rods" },
    { uid: "D", label: "Discs" },
    { uid: "S", label: "Swords" },
];

// The verb each of Rods/Discs/Swords spells its step with; Cups has none (no entry).
const RDS_VERBS: Partial<Record<MinorSuitUid, string>> = { R: "move", D: "grow", S: "shrink" };

// A suit step's mode (Cups own/enemy/new; the others piece/tile), read from the fields parseMove already resolved; undefined if the action isn't this suit's verb or no target is named.
function stepMinorMode(suitUid: MinorSuitUid, step: IStep): MinorMode | undefined {
    const verb = RDS_VERBS[suitUid];
    if (verb !== undefined) {
        if (step.action !== verb) {
            return undefined;
        }
        return step.targetPiece !== undefined ? "piece" : step.targetCell !== undefined ? "tile" : undefined;
    }
    if (suitUid !== "C" || step.action !== "create") {
        return undefined;
    }
    if (step.direction !== undefined) {
        return "own";
    }
    if (step.targetPiece !== undefined) {
        return "enemy";
    }
    // "own"/"enemy" have no empty-field reading, so this is "new" either way.
    return "new";
}

// Hermit's mode from the step's fields; targetCell is reserved exclusively for the destination in both modes.
function stepHermitMode(step: IStep): TargetMode | undefined {
    if (step.action !== "fly") {
        return undefined;
    }
    return step.targetPiece !== undefined ? "piece" : step.card !== undefined ? "tile" : undefined;
}

// The verb each of these special powers' step is spelled with; a step with any other action is not this power's step, however its fields happen to line up.
const SPECIAL_STEP_ACTIONS: Partial<Record<SpecialPower, string>> = {
    orientMinion: "orient",
    orientAny: "orient",
    hierophantReplace: "replace",
    hermitTeleport: "fly",
    tradeHands: "trade",
    judgementDraw: "draw",
};
// ---- end of the power helpers ----

// card.suit.uid is typed as plain `string` by tarot, but is always one of the 4 minor suits.
const suitUidOf = (card: TarotCard): MinorSuitUid => card.suit.uid as MinorSuitUid;

const MUTED_FILL: Colourfuncs = { func: "flatten", fg: "_context_strokes", bg: "_context_background", opacity: 0.3 };
// The greyed button: MUTED_FILL's dark-theme grey, lightened to about #ccc in the light theme.
const GREYED_BUTTON_FILL: Colourfuncs = {
    func: "flatten",
    fg: { func: "flatten", fg: "_context_strokes", bg: "_context_fill", opacity: 0.71 },
    bg: "_context_background",
    opacity: 0.2,
};

// Major arcana chaining uses frames: the board before each step of a move of 2+ steps, as in Frogger and Rincala.  Discards are abbreviated.
export type FrameState = {
    board: UnboundedSquareBoard<CellContents>;
    discardSummary: DiscardSummary;
};

// One button-bar choice, before its value gets a `<prefix>_` prepended.
interface ChoiceOption {
    value: string;
    label?: string | StructuredRenderLabel;
    glyph?: string; // A legend key; the render adds the entry for a piece's or a suit's.
    glyphPosition?: "prefix" | "suffix"; // Defaults to suffix.
    disabled?: boolean; // Crossed out, and inert when clicked.
}

// A minion's board location; `piece` carries owner/size/orientation for a newMinion predicted by validate* before the board is actually mutated.
export interface IPieceRef {
    cell: string;
    piece: Piece;
}

const xy = (cell: string): [number, number] => GnosticaBoard.algebraic2coords(cell);

// What a single suit-power step did, for chaining later steps of the same major-arcana activation (which of the acting player's own pieces moved).
export interface IStepOutcome {
    newMinion?: IPieceRef;
    // The EXISTING pool entry (matched by cell and piece) newMinion supersedes - unset only when nothing existing became invalid (Cups' "create").
    replacesMinion?: IPieceRef;
    // Hand off to a DIFFERENT card's power array (World's target, or Fool's flip).
    pushPower?: { cardUid: string; minions: IPieceRef[] };
    // Must pause here regardless of further supplied step segments - the outcome is hidden (Fool's flip) or a later sibling step needs it (High Priestess).
    forcePause?: boolean;
    // This step's tokens still carry a trailing "?" (Cups "own" creation's mandatory facing) - read by validateMinorPower/validatePowerSteps as complete:0.
    softComplete?: boolean;
    // Rods "piece" mode's own landing cell, regardless of the moved piece's owner (newMinion is only set for the acting player's own) - Moon's own capacity-restoration check reads this.
    movedToCell?: string;
    // Swords "piece" mode's own cell, set only when the target was fully destroyed (not just shrunk in place) - Moon's own capacity-restoration check reads this too.
    destroyedAtCell?: string;
    // A one-step shortcut (Strength's +2 grow, Sun's royalty create, Death's both-swords shrink) already did the card's whole job, so its remaining steps are spent.
    consumesRest?: boolean;
    // Swords: the pips actually removed - applyPowerStep compares it with the minion's size to decide consumesRest, so applying never needs the minion.
    shrunkBy?: number;
    // The piece a grow/create/move produced, for the not-tracked (an enemy's) cases newMinion leaves out - a two-step shortcut's second step must act on it.
    producedPiece?: IPieceRef;
}

// The non-mutating validator's verdict on one step: a failure, or a pass where `complete: false` marks a still-building step, not a finished one.
// What a passing step actually did comes from applying it (see IStepOutcome), never from the validator.
type StepValidation =
    | { failed: true; result: IValidationResult }
    // `mayAddMore`: a Judgement draw that could still take this many more discards, so the move can be submitted as it is but isn't finished.
    | { failed: false; complete?: boolean; mayAddMore?: number };

// resolvePieceRef's result: "ok" (exactly one), "not_found" (zero matches, which includes text that isn't a piece reference), or "ambiguous" (2+, narrowable by more fields).
type PieceRefResolution =
    | { kind: "ok"; ref: IPieceRef }
    | { kind: "not_found" }
    | { kind: "ambiguous" };

export interface IParsedMove {
    announceLast: boolean;
    asUid?: string;  //for World
    asSuit?: string; //for Magician
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
    eligible: IPieceRef[];
    // eligible plus any newMinion chained in from earlier COMPLETE steps of the same activation; identical to eligible for a minor card or the first step.
    minions: IPieceRef[];
    // Resolved from this step's typed minionRef, or minions[0] as a preview default; minionAmbiguous gates whether that default is trustworthy.
    minion: IPieceRef;
    minionAmbiguous: boolean;
    minionCandidates: IPieceRef[];
    // Earlier complete power-step segments of the same activation, as typed IStep objects; always [] for a minor card.
    priorSteps: IStep[];
    // computeShortcutOpts's result for the CURRENT step - lets unavailableModes's button pre-filter account for a same-target-shortcut/Moon card.
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

// What applying a card's powers did: ran to the end, stopped on an unfinished step, or left something for move() to continue - the Fool used, a High Priestess round, or Justice's trade.
type PowerOutcome = "done" | "stopped" | "fool" | "hp" | "trade";

type IHiddenEffect = (
    | { type: "territory"; cell: string }
    | { type: "draw"; count: number }
    // Justice or the Hanged Man: the acting player swaps hands with the owner of this piece.
    | { type: "trade"; target: IPieceRef }
) & {
    // Set by the chain walker: the effect's results belong in the submission's per-step _group entries.
    grouped?: boolean;
};

// What the click UI needs to know about an in-progress (partial) move, computed once inside move(..., {partial: true}) from the pre-move state.
interface IPreview {
    head: string | undefined;
    // Top-level button values to bold.
    highlighted: Set<string>;
    discardNeedsCount: boolean;
    // Pieces to ring on the board: the ones a click can pick, or the ones the step has picked.
    rings: Map<string, "minion" | "target">;
    // The territories to mark as choices ("x,y"): a "use" with no territory chosen yet marks the ones the player has a minion on.
    pickCells: Set<string>;
    // A bare orient cell whose piece is still ambiguous.
    orientPickCell: string | undefined;
    // The resume seed move string, including whatever was typed against the pending obligation.
    pending: IPendingStep | undefined;
    // A finished power whose piece can still be turned, with the next power waiting: board clicks turn the piece until the buttons go on.
    facingOpen: boolean;
    // The move the client sent was illegal and this previews the longest valid part of it: only Undo is offered.
    rejected: boolean;
}

// A lossless-for-display abbreviation of a raw uid list - individual major uids, plus per-suit/per-(spot|royal) minor COUNTs (minors aren't shown individually).
interface DiscardSummary {
    majorUids: string[];
    counts: Map<string, number>;
}

// One card's power-array progress in the resolution stack; minions is its own accreting pool, seeded at push time, never shared with a sibling.
interface IPowerProgress {
    cardUid: string;
    nextStepIndex: number;
    minions: IPieceRef[];
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
    eligible: IPieceRef[];
    // The typed power segments, with a High Priestess resume's own content folded back in.
    steps: IStep[];
    asUid?: string;
    asSuit?: MinorSuitUid;
    // The stack a walk of this play starts from, as fresh copies: just the card for a use or play, or the persisted obligations plus the revealed card for a resume.
    stack: IPowerProgress[];
    // The card whose obligation the walk is rooted in.
    rootUid: string;
}

// A same-seat obligation left over from a High Priestess/Fool/World activation that paused mid-chain; rootCardUid is fixed at the original use/play call.
interface IPendingMajorPower {
    rootCardUid: string;
    stack: [IPowerProgress, ...IPowerProgress[]];
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
    // Every card revealed by a bid across every round played - the shared pool players draw back up to 6 from during "redraw"; the winner (turnOrder[0]) derives from this.
    biddingPool?: string[];
    // Hand cards every player has seen, because they came from a public pile (the bidding pool or the discards); only they stay face-up in other players' views of a hand.
    drawn: string[];
    // Hand cards that only some players have seen, because a hand trade moved them: uid -> the players who held them before the trade.
    traded: Record<string, number[]>;
    // "Tournament rules": in the "bidding" variant, play order is the rank order of the cards everyone bid (majors always outrank minors); seating order until the bids resolve, and always empty otherwise.
    turnOrder: playerid[];
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
            {
                uid: "no-majors",
                fans: true,
                people: [
                    {
                        type: "designer",
                        name: "Russ Williams",
                        urls: ["https://boardgamegeek.com/boardgamedesigner/43454/russ-williams"],
                        apid: "4223967c-d922-47c6-8f57-69b6025f5a9b",
                    },
                ],
            }
        ],
        categories: ["goal>score>eog", "mechanic>area", "mechanic>capture", "mechanic>hand", "mechanic>hidden", "mechanic>random>play", "mechanic>place", "board>dynamic", "components>cards-tarot", "components>pyramids", "other>2+players"],
        flags: ["experimental", "no-moves", "custom-randomization", "no-explore", "player-stashes", "scores"],
        displays: [
            { uid: "larger-cards" },
            { uid: "#circles", group: "circles" },
            { uid: "icons", group: "circles" },
            { uid: "letters", group: "circles" }
        ],
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
    public drawn: string[] = [];
    public traded: Record<string, number[]> = {};
    public turnOrder!: playerid[];

    // How many players have already redrawn - reads the last REAL commit's hands (this.stack's top), immune to a live preview's own in-progress mutation.
    public get redrawPos(): number {
        return this.stack[this.stack.length - 1].hands.filter(h => h.length === 6).length;
    }

    // Transient click-UI hints, not part of persisted game state; set by move(..., {partial: true}) and cleared by a committed move.
    private preview: IPreview | undefined;
    // Hidden or random effects (deck draws) recorded while a move is applied; only move() performs them, once the move is committed.
    private hidden: IHiddenEffect[] = [];
    private buffers: Direction[] = [];
    // The void cell where a Chariot's first move leaves its piece waiting for the second, which the render window has to reach.
    private waypointCell: string | undefined;
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
                drawn: [],
                traded: {},
                turnOrder: this.variants.includes("bidding") ? [...Array(this.numplayers)].map((_, i) => (i + 1) as playerid) : [],
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
        this.drawn = [...state.drawn];
        this.traded = Object.fromEntries(Object.entries(state.traded).map(([uid, players]) => [uid, [...players]]));
        this.turnOrder = [...state.turnOrder];
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
            drawn: [...this.drawn],
            traded: Object.fromEntries(Object.entries(this.traded).map(([uid, players]) => [uid, [...players]])),
            turnOrder: [...this.turnOrder],
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
                const entry = {...mstate, hands: mstate.hands.map(h => [...h])};
                for (let p = 1; p <= this.numplayers; p++) {
                    if (p === opts.player) { continue; }
                    entry.hands[p - 1] = entry.hands[p - 1].map(uid => entry.drawn.includes(uid) || (opts.player !== undefined && entry.traded[uid]?.includes(opts.player)) ? uid : UNREVEALED_UID);
                }
                return entry;
            });
        }
        return state;
    }

    // Previews a move that fails validation as the longest valid part of it, flagged so render offers only Undo.
    private previewRejected(m: string): GnosticaGame {
        let parsed = this.parseMove(m);
        let previewed = false;
        while (parsed.head !== undefined || parsed.announceLast) {
            parsed = this.retractedMove(parsed);
            const prefix = this.pickleMove(parsed);
            if (prefix !== "" && this.validateMove(prefix).valid) {
                this.move(prefix, { partial: true });
                previewed = true;
                break;
            }
        }
        this.preview = { ...(previewed ? this.preview! : this.buildPreview(this.parseMove(""))), rejected: true };
        return this;
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

        // Computed once and reused below rather than called twice - board presence can't change between the two reads within a single call.
        const hasPieces = this.hasPiecesOnBoard(this.currplayer);

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            // The real client calls validateMove("") right after every commit to populate the status line; "click a button" fits every state but a fresh placement.
            result.message = i18next.t(
                this.getContinuedUid() === "02"
                    ? "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2"
                    : this.continued.length === 0 && !hasPieces
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
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", {reason: "WRONG_VIA_CARD"}) };
            const allowed = activeUid === "02" ? ["discard"] : activeUid === "11" ? [this.justiceHead(), "decline"] : ["decline", "play"];
            if (! allowed.includes(parsed.head!))
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", {reason: "WRONG_CONTINUED_ACTION"}) };
            // Cannot announce when a different player has announced.  Has nothing to do your own declaration, continued or not.
            if (parsed.announceLast && (this.lastTurner !== undefined))
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.ALREADY_ANNOUNCED") };
            return this.validateResumePendingPower(parsed);
        } else if (head === "decline") {
            // "decline" can only appear when continued is populated.
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOTHING_TO_DECLINE") };
        }

        // Mirrors move()'s own bid/redraw/phase gates - see their docs.
        if (head === "bid" || head === "redraw") {
            if (head === "bid" && this.phase !== "bidding") {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.WRONG_PHASE", { move: head }) };
            }
            if (head === "redraw" && this.phase !== "redraw") {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.WRONG_PHASE", { move: head }) };
            }
            if (parsed.steps.length > 1 || parsed.announceLast) {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: head }) };
            }
            if (head === "bid")
                return this.validateBid(parsed);
            else
                return this.validateRedraw(parsed);
        } else if (this.phase !== "main") {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.WRONG_PHASE", { move: head }) };
        }
        
        if (head !== "place" && !hasPieces) {
            //The Fool suicide corner case can be escaped by declining, above.
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.MUST_PLACE_FIRST") };
        }
        if (head === "place" && hasPieces) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.ALREADY_ON_BOARD") };
        }
        // Concurrent lastTurners aren't allowed, so no need to check *who* it is. 
        if (parsed.announceLast && this.lastTurner !== undefined) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.ALREADY_ANNOUNCED") };
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
            case "discard": return this.validateDiscard(parsed.steps[0]);
            case "use": return this.validateActivate(parsed);
            case "play": return this.validatePlay(parsed);
        }
        // Unreachable: head was confirmed recognized above, and bid/redraw/pass/resume are all handled before here.
        return { valid: false, complete: -1, message: i18next.t("apgames:validation._general.UNRECOGNIZED_MOVE", { move: m }) };
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
                if (partial && this.phase === "main") {
                    return this.previewRejected(m);
                }
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
        // A "last" already staged on an earlier sub-move of this same still-open turn rides at the front of this.continued.
        const hadDeclareMarker = this.continued.length > 0 && this.continued[0] === "last";
        let newLast = hadDeclareMarker ? this.currplayer : this.lastTurner;
        // The card a use, play or resume applies, the steps typed for it, and how it was reached (for Justice's token), with what applying it did, from which
        // the tokens in this.continued are settled once past the partial boundary below.
        let powerCard: string | undefined;
        let powerSteps: IStep[] = [];
        let powerAsUid: string | undefined;
        let powerHow = "";
        let outcome: PowerOutcome | undefined;
        let announceLast = false;

        this.buffers = [];
        this.waypointCell = undefined;
        this.discarded = [];
        
        // Parses and executes `m` against `this` - the one place move grammar is interpreted (validateMove mirrors this exact structure, read-only).
        const parsed = this.parseMove(m);
        const head = parsed.head;
        const preview = partial ? this.buildPreview(parsed) : undefined;
        this.addDistanceBuffer(preview?.pending);
        this.addPendingFacingBuffer(parsed, preview?.pending);

        // A "discard" resume is a High Priestess round (not a card); a "play" resume names the revealed card as its front token, else the "via" root.
        const resume = this.continued.length > 0;
        if (resume || head === "use" || head === "play") {
            powerCard = resume ? (head === "discard" ? parsed.viaUid : parsed.steps[0]?.card ?? parsed.viaUid) : parsed.steps[0]?.card;
            // High Priestess resumes with its own content right after "discard", not a "/"-segment - resumeSteps folds it back.
            powerSteps = resume ? this.resumeSteps(parsed) : parsed.steps.slice(1);
            powerAsUid = parsed.asUid;
            // A resumed Justice keeps the verb its first turn used, which decides who may attack; every other resume is a play. Through the World it is "21" too.
            const verb = resume ? (powerCard === "11" && head === "use" ? "use" : "play") : head;
            powerHow = `${verb}${parsed.asUid !== undefined && powerCard === "21" ? "21" : ""}`;
        }
        // A genuine cross-turn pause means every legal move right now has to be resuming it; legality of any kind is validateMove's job alone now.
        if (resume) {
            outcome = this.resumePowers(powerCard!, powerSteps, powerAsUid, partial);
        } else if (head === "bid") {

        // The "bidding" variant's own opening procedure - no power steps, no "last" announcement, own bespoke currplayer advancement.
            this.cmdBid(parsed.steps[0], partial);

        } else if (head === "redraw") {
            this.cmdRedraw(parsed.steps[0], partial);
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
                // A bare "use" or "play" has nothing to play yet.
                case "use":
                    outcome = powerCard === undefined ? undefined : this.cmdActivate(powerCard, powerSteps, powerAsUid, partial);
                    break;
                case "play":
                    outcome = powerCard === undefined ? undefined : this.cmdPlay(powerCard, powerSteps, powerAsUid, partial);
                    break;
                // "decline" with nothing pending, or any other head with no business here, falls through with no case - a caller bug, not this dispatch's job.
            }
        }

        // A "last" may be declared on any sub-move of a still-open chain, not just the first - validateMove's own ALREADY_ANNOUNCED guards (both the
        // fresh-dispatch and continued-branch copies) are the only gate; bid/redraw/pass reject announceLast outright before ever reaching here.
        announceLast = parsed.announceLast;
        // A transient, unpersisted UI hint (not this.lastmove) answering "is there an in-progress preview right now" - cleared the moment a turn commits.
        this.preview = preview;
        if (preview !== undefined) {
            preview.rings = this.previewRings(parsed, preview.pending);
            preview.pickCells = this.usePickCells(parsed);
        }

        if (partial) {
            this.showUnrevealed();
            return this;
        }
        this.resolveHiddenEffects();
        // undefined means no power ran or it stopped on an incomplete step.
        const owed = powerCard !== undefined && outcome !== undefined && outcome !== "stopped" ? this.continueTurn(powerCard, powerSteps, powerAsUid, powerHow, outcome) : undefined;
        if (announceLast) {
            newLast = this.currplayer;
            this.results.push({ type: "declare", count: this.getPlayerScore(this.currplayer) });
        }
        if (emulation) {
            return this;
        }

        // "?" marks a "place"-only click-preview facing as still merely prepopulated, dropped the instant a turn is actually committed.
        this.lastmove = m.replace(/\?/g, "");
        if (owed !== undefined) {
            this.continued = owed;
        }
        if (head === "bid" || head === "redraw") {
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
        const inHand = (uid: string): boolean => this.hands.some(hand => hand.includes(uid));
        this.drawn = this.drawn.filter(inHand);
        this.traded = Object.fromEntries(Object.entries(this.traded).filter(([uid]) => inHand(uid)));
        this.saveState();
        return this;
    }

    // A previewed move must not reveal the deck, so each territory it would draw a card for is shown face-down.
    private showUnrevealed(): void {
        for (const effect of this.hidden) {
            if (effect.type === "territory") {
                this.board.createTerritory(effect.cell, UNREVEALED_CARD);
            } else if (effect.type === "trade") {
                // The player sees their old cards in the other hand, and none of the ones they get.
                const owner = effect.target.piece.owner;
                const mine = this.hands[this.currplayer - 1];
                this.hands[this.currplayer - 1] = this.hands[owner - 1].map(() => UNREVEALED_UID);
                this.hands[owner - 1] = mine;
            }
        }
    }

    // Performs what move() recorded but a preview must not: every deck draw, in the order the steps recorded them, logging each into the step's own result group.
    private resolveHiddenEffects(): void {
        for (const effect of this.hidden) {
            let result: APMoveResult;
            switch (effect.type) {
                case "territory": {
                    const card = this.createTerritoryFromDeck(effect.cell);
                    result = { type: "place", where: effect.cell, how: "territory", what: card.uid };
                    break;
                }
                case "trade": {
                    const owner = effect.target.piece.owner;
                    this.tradeHands(effect.target, this.hands[owner - 1]);
                    result = { type: "swap", where: effect.target.cell, who: owner };
                    break;
                }
                case "draw": {
                    const drawn = this.drawCards(effect.count);
                    this.cardsDrawn[this.currplayer - 1] = drawn;
                    result = { type: "deckDraw", count: drawn, from: "deck" };
                    break;
                }
            }
            if (effect.grouped !== true) {
                this.results.push(result);
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
        const HEADWORDS = ["place", "orient", "discard", "use", "play", "decline", "bid", "redraw"];
        const STEPWORDS = ["discard", "draw", "orient", "skip", "with"];
        const OTHERWORDS = ["as", "at", "create", "draw", "fly", "grow", "last", "move", "orient", "replace", "shrink", "to", "trade", "via"];

        const CARD_UID_RE = /^((a|10|[2-9]|p|n|q|k)[crds]|\d{2})$/i;
        const CELL_RE = /^[a-z]{1,2}(0|-?[1-9]\d*)$/;
        const DIRECTION_RE = /^[NESWU]\??$/i;
        const PIECE_REF_RE = /^[a-z]{1,2}(0|-?[1-9]\d*)(\.[1-3](\.[NESWU])?(\.[1-6])?)?$/;
        const MAJOR_ARCANA_RE = /^[0-1][0-9]|20|21$/i;
        const NUMBER_RE = /^[0-6]$/i; //Used for player Ids, card counts, bids, etc.
        const SUIT_RE = /^[CDRS]$/;
        
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
        
                if (headTokens.length === 0 && ! lastStep) {
                    //All head tokens must have contents.
                    pm.error = "HEAD_STEP_NEEDS_CONTENT";
                    break;
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
                        pm.error = "MAGICIAN_OR_JUSTICE_BAD_SUIT";
                        break;
                    }
                    if ( pm.asSuit !== undefined &&  headTokens[0] === "11" && pm.asSuit !== "S" ) {
                        //Bad suit for the Magician.
                        pm.error = "JUSTICE_WRONG_SUIT";
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
            // High Priestess can never decline (High Priestess's step only accepts "discard"; no Decline button is ever offered for it).
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
            rings: new Map(),
            pickCells: new Set(),
            orientPickCell: head === "orient" && step0?.targetPiece !== undefined && step0.direction === undefined && !step0.targetPiece.includes(".") ? step0.targetPiece : undefined,
            pending: advanced,
            facingOpen: this.facingOpen(current, advanced),
            rejected: false,
        };
    }

    // Maps a failed resolvePieceRef() result to its validation message; `notFoundKey` lets a minion-selector report NOT_AN_ELIGIBLE_MINION instead of NO_SUCH_PIECE.
    private invalidPieceRef(kind: "not_found" | "ambiguous", ref: string | undefined, notFoundKey = "NO_SUCH_PIECE"): IValidationResult {
        switch (kind) {
            // notFoundKey is sometimes overridden to a key with its own real text - only the shared default collapses into INVALID_MOVE.
            case "not_found": return notFoundKey === "NO_SUCH_PIECE"
                ? { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_SUCH_PIECE" }) }
                : { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${notFoundKey}`, { ref }) };
            case "ambiguous": return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.AMBIGUOUS_PIECE_REF", { ref }) };
        }
    }

    // "<cell>.<pips>[.<orientation>][.<player>]"; resolved against `pool` (minion-selector) if given, else every piece at the cell (a target, any owner).
    private resolvePieceRef(ref: string | undefined, pool?: IPieceRef[]): PieceRefResolution {
        if (ref === undefined) {
            return { kind: "not_found" };
        }
        const segments = ref.toLowerCase().split(".");
        if (segments.length < 2 || segments.length > 4) {
            return { kind: "not_found" };
        }
        // PIECE_REF_RE (parseMove) already guarantees the cell is spelled the way the game writes it - same cell grammar as CELL_RE.
        const [cell, pipsStr, ...rest] = segments;
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
            ? pool.filter(p => p.cell === cell)
            : (this.cellContents(cell)?.pieces ?? []).map((piece): IPieceRef => ({ cell, piece }));
        let matches = candidateRefs
            .map(r => ({ r, piece: r.piece }))
            // A pool entry can go stale mid-chain (an earlier step relocated whatever used to be there) - treat that as never matched, not a crash.
            .filter((m): m is { r: IPieceRef; piece: Piece } => m.piece !== undefined)
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
        // A pool entry can be stale (an earlier step moved or changed that piece), so the piece must still stand in the cell; hand back a copy of it.
        if (this.pieceIndex({ cell: r.cell, piece }) === -1) {
            return { kind: "not_found" };
        }
        return { kind: "ok", ref: { cell: r.cell, piece: piece.clone() } };
    }

    // For the mutating apply* side, where the matching validate* has already confirmed `ref` resolves - trusts that, rather than re-deciding what to do on failure.
    private resolvePieceRefTrusted(ref: string | undefined, pool?: IPieceRef[]): IPieceRef {
        return (this.resolvePieceRef(ref, pool) as { kind: "ok"; ref: IPieceRef }).ref;
    }

    // Resolves a territory's own card uid to its current cell - Hermit's "tile" mode names it this way; a card is unique, so no "ambiguous" outcome to report.
    private resolveTileCard(cardUid: string | undefined): string | undefined {
        if (cardUid === undefined) {
            return undefined;
        }
        for (const [x, y, t] of this.board.entries()) {
            if (t.cardUid === cardUid) {
                return GnosticaBoard.coords2algebraic(x, y);
            }
        }
        return undefined;
    }

    // A bare cell token (no ".") - a "click the cell your minion is on" click landed here; only meaningful when 2+ of `pool`'s minions actually sit there, but stays defensive.
    // Unlike a parsed step's own targetCell/targetPiece, `tok` isn't guaranteed cell-shaped at all here (e.g. orientMinion's own literal "orient" subhead reaches this same slot), so this still needs a real try/catch.
    private isMinionCellStillNarrowing(tok: string, pool: IPieceRef[], suitUid?: MinorSuitUid): boolean {
        if (tok.includes(".")) {
            return false;
        }
        return this.actingCandidates(pool.filter(m => m.cell === tok), suitUid).length > 1;
    }

    // A Rod can't act while upright, so while choosing, only a facing minion is a candidate - unless none is, when the error should still show.
    private actingCandidates(candidates: IPieceRef[], suitUid: MinorSuitUid | undefined): IPieceRef[] {
        const facing = suitUid === "R" ? candidates.filter(m => !this.rodNeedsFacing("R", m.piece)) : candidates;
        return facing.length > 0 ? facing : candidates;
    }

    // The suit of a power step that is a suit primitive.
    private stepSuit(step: PowerStep): MinorSuitUid | undefined {
        return "primitive" in step ? this.primitiveToSuit(step.primitive) : undefined;
    }

    // True when every candidate is the SAME cell AND the same owner/size/facing (Piece.id()) - picking any one has the exact same effect.
    private allIndistinguishable(candidates: IPieceRef[]): boolean {
        if (candidates.length <= 1) {
            return true;
        }
        if (candidates.some(m => m.cell !== candidates[0].cell)) {
            return false;
        }
        const ids = candidates.map(m => (m.piece)?.id());
        return ids.every(id => id !== undefined && id === ids[0]);
    }

    // Resolves a step's typed minionRef against `pool`: a full ref resolves definitively, a bare cell token narrows `candidates` and sets ambiguous.
    private resolveStepMinion(
        ref: string | undefined, pool: IPieceRef[], suitUid?: MinorSuitUid,
    ): { minion: IPieceRef; ambiguous: boolean; candidates: IPieceRef[] } {
        if (ref === undefined) {
            pool = this.actingCandidates(pool, suitUid);
        }
        if (pool.length <= 1) {
            return { minion: pool[0], ambiguous: false, candidates: pool };
        }
        const tok = ref?.toLowerCase();
        if (tok !== undefined) {
            const resolved = this.resolvePieceRef(tok, pool);
            if (resolved.kind === "ok") {
                return { minion: resolved.ref, ambiguous: false, candidates: pool };
            }
            if (this.isMinionCellStillNarrowing(tok, pool, suitUid)) {
                const narrowed = this.actingCandidates(pool.filter(m => m.cell === tok), suitUid);
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
    private powerStepMessageKey(headArg: string, priorStepsCount: number, minions: IPieceRef[], minionRef?: string): { key: string; params?: Record<string, unknown> } {
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
                const step = this.resolveCardDef(headArg).powers[0];
                if ("special" in step) {
                    const cell = minion.cell;
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

    // A fresh step's own message: PICK_MINION_CELL when the eligible pool spans more than one cell, otherwise powerStepMessageKey's own step-0 wording.
    private freshStepMessage(cardUid: string, priorStepsCount: number, minions: IPieceRef[], asSuit?: string): { key: string; params?: Record<string, unknown> } {
        // The Magician picks its suit before any minion, so the buttons are what the player is waiting on.
        const step = this.resolveCardDef(cardUid).powers[priorStepsCount];
        const awaitingSuit = asSuit === undefined && step !== undefined && "special" in step && step.special === "magicianChoice";
        if (priorStepsCount === 0 && !awaitingSuit && new Set(minions.map(m => m.cell)).size > 1) {
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

    // A greyed or crossed-out button must not act when clicked, so it gets a value no handler recognizes.
    private withInertUnavailable(bar: [ButtonBarButton, ...ButtonBarButton[]] | undefined): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        return bar?.map(b => b.value !== undefined && !b.value.startsWith("_")
            && (b.fill === GREYED_BUTTON_FILL || b.attributes?.some(a => a.name === "text-decoration" && a.value === "line-through"))
            ? { ...b, value: `_disabled_${b.value}` }
            : b) as [ButtonBarButton, ...ButtonBarButton[]] | undefined;
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

    // Pick one value from a small labeled set: available is plain, unavailable is crossed out, the `current` one is greyed.
    private buildChoiceButtons(prefix: string, options: ChoiceOption[], current: string | undefined): ButtonBarButton[] {
        return options.map(({ value, label, glyph, glyphPosition, disabled }) => {
            const button: ButtonBarButton = { value: `${prefix}_${value}` };
            if (label !== undefined) {
                button.label = label;
            }
            if (glyph !== undefined) {
                button.glyph = glyph;
                button.glyphPosition = glyphPosition ?? "suffix";
            }
            if (disabled) {
                button.attributes = [{ name: "text-decoration", value: "line-through" }];
            } else if (value === current) {
                button.fill = GREYED_BUTTON_FILL;
            }
            return button;
        });
    }

    // Rod can never act while upright, so doom an upright candidate.
    private rodNeedsFacing(suitUid: MinorSuitUid | undefined, piece: Piece): boolean {
        return suitUid === "R" && piece.orientation === "U";
    }

    // The self-contained Play/Decline pair offered whenever a paused power has no button set of its own; reads the active card off the resume stack's top entry.
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
        // The "bidding" variant's opening procedure has no buttons: every click is on a hand card or a pool card.
        if (this.phase !== "main") {
            return undefined;
        }
        const topLevel = this.buildTopLevelBar();
        const discardCount = this.discardCountBar();
        if (discardCount !== undefined) {
            return discardCount;
        }
        const orientPicker = this.orientAmbiguityBar(topLevel);
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

        // A finished step whose piece can still be turned: board clicks set its facing, so the next step's buttons wait (getActionButtons adds Skip Reorient).
        if (this.preview?.facingOpen === true) {
            const waiting = [...(selected !== undefined ? [selected] : []), ...(declareBtn !== undefined ? [declareBtn] : [])];
            return waiting as [ButtonBarButton, ...ButtonBarButton[]];
        }

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
        // orientMinion/judgementDraw/worldUseAny are pure click-driven; tradeHands/orientAny/hierophantReplace are too unless the facing cell holds several candidates for a click to pick between.
        // Self is always its own unambiguous click target for orientAny, so it doesn't count.
        const pickingSpecialTarget = (pendingMinor.special === "orientAny" || pendingMinor.special === "tradeHands" || pendingMinor.special === "hierophantReplace")
            && pendingMinor.istep.targetPiece === undefined
            && pendingMinor.game.targetCandidates(pendingMinor).length - (pendingMinor.special === "orientAny" ? 1 : 0) > 1;
        if (pendingMinor.special !== undefined && pendingMinor.special !== "hermitTeleport" && pendingMinor.special !== "magicianChoice" && !pickingSpecialTarget) {
            // A click-only special power whose play has begun (fresh, or a resume once Play is clicked): just the action chosen, since the board or hand click that continues it is no button.
            if (phase !== "owed") {
                const only: ButtonBarButton[] = [...(selected !== undefined ? [selected] : []), ...(declareBtn !== undefined ? [declareBtn] : [])];
                return only as [ButtonBarButton, ...ButtonBarButton[]];
            }
            // A resume not yet begun: none of the ordinary 6 buttons are legal - offer the same self-contained Play/Decline pair the Fool-special branch above does.
            return this.pausedPowerButtons();
        }

        return pendingMinor.game.stepModeBar(pendingMinor, selected, declareBtn);
    }

    // Once an action is chosen the bar keeps just it (greyed) and Declare; the whole ordinary set is only for an empty move or a bare "last".
    private chosenActionBar(topLevel: ButtonBarButton[]): [ButtonBarButton, ...ButtonBarButton[]] {
        const chosen = this.preview === undefined ? [] : topLevel.filter(b => b.value !== undefined && b.value !== "declare" && this.preview!.highlighted.has(b.value));
        if (chosen.length === 0) {
            return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
        }
        const declare = topLevel.find(b => b.value === "declare");
        return (declare === undefined ? chosen : [...chosen, declare]) as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // The ordinary top-level choice (just Place before a player has any piece), with the action already taken greyed per highlightedButtonValues - the fallback bar, and the seed every pendingMinor state further trims.
    private buildTopLevelBar(): ButtonBarButton[] {
        const highlighted = this.preview?.highlighted ?? this.highlightedButtonValues(undefined);
        // A live "place" preview is applied to the board, so hasPiecesOnBoard() already looks true; a live "use"/"play" is never a fresh start, however briefly it leaves the player with no pieces.
        const placeOnly = highlighted.has("place") || (!this.inPowerPlay(this.preview?.head) && !this.hasPiecesOnBoard(this.currplayer));
        const topLevel: ButtonBarButton[] = placeOnly
            ? [{ label: "Place", value: "place" }]
            : [
                { label: "Use Territory", value: "use" },
                { label: "Play Card", value: "play" },
                { label: "Orient", value: "orient" },
                { label: "Discard/Draw", value: "discard" },
                { label: "Pass", value: "pass" },
            ];
        // Declare is offered until someone has declared (committed, or staged in an open turn), and is a toggle, so once on it offers to undo itself rather than sit greyed.
        if (!placeOnly && this.lastTurner === undefined && !this.continued.includes("last")) {
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
    private drawCountBar(prefix: string, discarding = 0): [ButtonBarButton, ...ButtonBarButton[]] {
        const hand = this.hands[this.currplayer - 1] ?? [];
        const maxDraw = Math.max(0, 6 - (hand.length - discarding));
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
    private orientAmbiguityBar(topLevel: ButtonBarButton[]): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        const cell = this.preview?.orientPickCell;
        if (cell === undefined) {
            return undefined;
        }
        const { ambiguous, candidates } = this.resolveStepMinion(undefined, this.piecesOwnedAt(cell));
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
            const piece = this.getPiece(m);
            options.push({ value: ref, label: `${piece.size}-pip`, glyph: GnosticaGame.pieceButtonGlyph(piece) });
        }
        // Like minionPickerBar: the chosen top-level action stays, and Declare remains available.
        return [
            ...topLevel.filter(b => b.value === "orient"),
            { label: "Choose Minion", value: "_spacer", attributes: [{ name: "font-style", value: "italic" }] },
            ...this.buildChoiceButtons("orientpick", options, undefined),
            ...topLevel.filter(b => b.value === "declare"),
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
        const candidateCells = new Set(pendingMinor.minionCandidates.map(m => m.cell));
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
            const piece = this.getPiece(m);
            options.push({ value: ref, label: `${piece.size}-pip`, glyph: GnosticaGame.pieceButtonGlyph(piece), disabled: this.rodNeedsFacing(pendingMinor.suitUid, piece) });
        }
        buttons.push(...this.buildChoiceButtons("minion", options, undefined));
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
        return this.drawCountBar("hpdraw", pendingMinor.istep.cardList?.length ?? 0);
    }

    // Self (unless excluded), plus every distinguishable piece at the facing cell (deduplicated by pieceRefStr) - shared by every target-candidate button list.
    // `ownLast` moves the acting player's own pieces after everyone else's (Swords: destroying your own minion is the least likely pick).
    private pieceCandidateOptions(
        pending: IPendingStep, verb: string,
        opts: { disabled?: boolean; includeSelf?: boolean; filter?: (piece: Piece) => boolean; ownLast?: boolean; selfVerb?: string } = {},
    ): ChoiceOption[] {
        const { disabled, includeSelf = true, filter, ownLast = false, selfVerb = verb } = opts;
        const faceCell = this.minorTargetCell(pending.minion);
        const cellPieces = this.cellContents(faceCell)?.pieces ?? [];
        const options: ChoiceOption[] = [];
        const own: ChoiceOption[] = [];
        const seen = new Set<string>();
        const pushPieceCandidate = (candidate: IPieceRef, selfAction = false): void => {
            const ref = this.pieceRefStr(candidate);
            if (seen.has(ref)) {
                return;
            }
            seen.add(ref);
            const piece = this.getPiece(candidate);
            const option = { value: ref, label: this.ownerButtonLabel(selfAction ? selfVerb : verb, piece.owner), glyph: GnosticaGame.pieceButtonGlyph(piece), disabled };
            (ownLast && piece.owner === this.currplayer ? own : options).push(option);
        };
        // Self is always a candidate unless explicitly excluded (tradeHands/hierophantReplace, which require an enemy) - uniquified against the facing cell's own pieces below.
        if (includeSelf) {
            pushPieceCandidate(pending.minion, true);
        }
        cellPieces.forEach(p => {
            if (filter === undefined || filter(p)) {
                pushPieceCandidate({ cell: faceCell, piece: p });
            }
        });
        return [...options, ...own];
    }

    // The legend key for a suit's icon shown on a button; the render adds its entry.
    private static suitButtonGlyph(suitUid: MinorSuitUid): string {
        return `buttonsuit_${suitUid}`;
    }

    // The legend key for a piece shown on a button; the render adds its entry.
    private static pieceButtonGlyph(piece: Piece): string {
        return `buttonpiece_${piece.id()}`;
    }

    // Every target-piece button names whose piece it is, since size/facing alone can match across different opponents; another player's is named by seat, for the front end to fill in.
    private ownerButtonLabel(verb: string, owner: number): string | StructuredRenderLabel {
        return owner === this.currplayer ? `${verb} own` : this.seatAreaLabel(owner, "apgames:validation.gnostica.OWNER_BUTTON", { verb });
    }

    // One candidate per real target for orientAny/tradeHands/hierophantReplace - tradeHands/hierophantReplace exclude self and require an enemy, matching pickPieceTargetClick's own rule.
    // The target buttons for whichever power the pending step is: Hermit's teleport, one of the three special target powers, or a suit power.
    private targetCandidates(pending: IPendingStep): ChoiceOption[] {
        if (pending.special === "hermitTeleport") {
            return this.hermitTargetCandidates(pending);
        }
        return pending.suitUid === undefined ? this.specialTargetCandidates(pending) : this.suitTargetCandidates(pending, pending.suitUid);
    }

    private specialTargetCandidates(pending: IPendingStep): ChoiceOption[] {
        if (pending.special === "orientAny") {
            return this.pieceCandidateOptions(pending, "Orient");
        }
        const verb = pending.special === "tradeHands" ? "Trade with" : "Replace";
        return this.pieceCandidateOptions(pending, verb, { includeSelf: false, filter: p => p.owner !== this.currplayer });
    }

    // One candidate per real target for a fresh suit-power step - the tile at minorTargetCell plus every piece there, or Cups' "own"/every enemy piece/"new"; one click supplies mode + target.
    private suitTargetCandidates(pending: IPendingStep, suitUid: MinorSuitUid): ChoiceOption[] {
        const unavailable = this.unavailableModes(pending);
        const faceCell = this.minorTargetCell(pending.minion);
        const targetCell = faceCell;
        if (suitUid === "C") {
            const cellPieces = this.cellContents(faceCell)?.pieces ?? [];
            const options: ChoiceOption[] = [{ value: "own", label: "Create Minion", disabled: unavailable.has("own") }];
            // The new piece is a gift added to the referenced enemy's own side, not a capture of anything - see applyCups' "enemy" case.
            const enemyEntries: ChoiceOption[] = [];
            cellPieces.forEach(p => {
                if (p.owner !== this.currplayer) {
                    enemyEntries.push({ value: this.pieceRefStr({ cell: faceCell, piece: p }), label: this.ownerButtonLabel("Create Enemy", p.owner), glyph: GnosticaGame.pieceButtonGlyph(p), disabled: unavailable.has("enemy") });
                }
            });
            if (enemyEntries.length > 0) {
                options.push(...enemyEntries);
            } else {
                // No enemy piece to reference right now - still show the option, struck through, matching "own"/"new"'s own always-present buttons.
                options.push({ value: "enemy", label: "Create Enemy", disabled: unavailable.has("enemy") });
            }
            options.push({ value: "new", label: "Create Territory", disabled: unavailable.has("new") });
            return options;
        }
        // The verb prefixes each piece candidate. A Rod moves its own minion but pushes any other piece or territory, so only Rods have a separate selfVerb.
        const verb = suitUid === "R" ? "Push" : suitUid === "D" ? "Grow" : "Attack";
        const selfVerb = suitUid === "R" ? "Move" : undefined;
        const tile = `${verb} Territory`;
        return [
            { value: targetCell, label: tile, disabled: unavailable.has("tile") },
            ...this.pieceCandidateOptions(pending, verb, { disabled: unavailable.has("piece"), ownLast: suitUid === "S", selfVerb }),
        ];
    }

    // Hermit's own twin of suitTargetCandidates - same tile-plus-self-plus-every-co-located-piece enumeration.
    private hermitTargetCandidates(pending: IPendingStep): ChoiceOption[] {
        const faceCell = this.minorTargetCell(pending.minion);
        const targetCell = faceCell;
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
        const glyph = pendingMinor.suitUid ? GnosticaGame.suitButtonGlyph(pendingMinor.suitUid) : `buttonpower_${pendingMinor.special}`;
        buttons.push({ label: spacerLabel, value: "_spacer", attributes: [{ name: "font-style", value: "italic" }], glyph });

        if (pendingMinor.special === "magicianChoice") {
            const options = ALL_SUITS.map(suit => ({ value: suit.uid, label: suit.label, glyph: GnosticaGame.suitButtonGlyph(suit.uid) }));
            buttons.push(...this.buildChoiceButtons("magician", options, undefined));
        } else {
            const targeted = pendingMinor.special === "hermitTeleport" ? stepHermitMode(pendingMinor.istep) !== undefined
                : pendingMinor.suitUid !== undefined ? stepMinorMode(pendingMinor.suitUid, pendingMinor.istep) !== undefined
                    : pendingMinor.istep.targetPiece !== undefined;
            if (!targeted) {
                buttons.push(...this.buildChoiceButtons("target", this.targetCandidates(pendingMinor), undefined));
            }
            const suitUid = pendingMinor.suitUid;
            // "new" mode's required card arg is otherwise only suppliable by clicking a hand card; Wheel of Fortune (allowRandomDraw) has none, so it gets a button.
            if (suitUid === "C" && stepMinorMode("C", pendingMinor.istep) === "new" && pendingMinor.opts.allowRandomDraw === true) {
                buttons.push({ label: "Draw a card", value: "drawn" });
            }
            if (suitUid === "S" && stepMinorMode("S", pendingMinor.istep) === "tile" && pendingMinor.istep.card === undefined) {
                const faceCell = pendingMinor.istep.targetCell!;
                const size = (pendingMinor.minion.piece).size;
                const current = this.cellContents(faceCell)?.pointValue() ?? 0;
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
        const minionPiece = pending.minion.piece;
        // Anything past the victim's own pips is the same wipeout (or, with one sword, rejected), so it isn't offered.
        const target = pending.game.resolvePieceRef(pending.istep.targetPiece);
        const victim = target.kind === "ok" ? target.ref.piece : undefined;
        const maxPips = Math.min(minionPiece.size * (pending.opts.bothSwords === true ? 2 : 1), victim?.size ?? Infinity);
        const options: ChoiceOption[] = [];
        for (let n = maxPips; n >= 1; n--) {
            const left = victim === undefined ? 0 : victim.size - n;
            const stashEmpty = victim !== undefined && left > 0 && !pending.game.hasStashAvailable(victim.owner, left as Pips);
            options.push({ value: String(n), label: `Attack for ${n}`, disabled: stashEmpty });
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
        let eligible: IPieceRef[];
        // A card revealed by Fool (headArg names it directly for a resume) is always play-pool eligible regardless.
        if (resume) {
            card = allCards().find(c => c.uid === headArg);
            eligible = this.eligibleMinionsForOwed(this.continued.filter(t => t !== "last").pop()!);
        } else if (head === "use") {
            const loc = this.findCardCell(headArg);
            if (loc === undefined) {
                return undefined;
            }
            card = this.cellContents(loc)?.card;
            eligible = this.eligibleMinionsForActivate(loc);
        } else {
            card = allCards().find(c => c.uid === headArg);
            eligible = this.eligibleMinionsForPlay();
        }
        // asUid (World's borrow) and asSuit (Magician's suit) are separate fields throughout; a World-pushed Magician can have both set at once.
        return {
            head, headArg, card, resume, eligible, steps, asUid: parsed.asUid, asSuit: parsed.asSuit as MinorSuitUid | undefined,
            stack: resume ? this.resumeQueue()! : [{ cardUid: headArg, nextStepIndex: 0, minions: [...eligible] }],
            rootUid: resume ? this.getContinuedUid()! : headArg,
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
            const { minion, ambiguous, candidates } = this.resolveStepMinion(istep.withPiece, eligible, suitUid);
            return { advanced: { head, headArg, activeCardUid: headArg, suitUid, eligible, minions: eligible, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps: [], opts: {}, istep, announceLast: parsed.announceLast } };
        }

        // A resolution stack local to this UI-only walk - `eligible` (frozen at push time) stays tracked separately from `minions` (which keeps accreting).
        const stack: { cardUid: string; nextStepIndex: number; eligible: IPieceRef[]; minions: IPieceRef[] }[] =
            play.stack.map(f => ({ cardUid: f.cardUid, nextStepIndex: f.nextStepIndex, eligible: [...f.minions], minions: [...f.minions] }));

        // The World's sole step (worldUseAny) takes no segment - the borrowed card is "as <uid>" in the head. Splice its entry on now, as validatePowerSteps does.
        if (worldBorrow) {
            const wt = stack[stack.length - 1];
            const wStep = this.resolveCardDef(wt.cardUid).powers[wt.nextStepIndex];
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
            const cardDef = this.resolveCardDef(top.cardUid);
            if (top.nextStepIndex >= cardDef.powers.length) {
                return { held }; // defensive - popExhaustedPowers keeps this in sync below
            }
            if (steps[segIdx].action === "skip") {
                if (top.nextStepIndex !== 0 || !GnosticaGame.canSkipFirstPower(cardDef)) {
                    return { held }; // validateMove reports it
                }
                priorSteps.push(steps[segIdx]);
                top.nextStepIndex++;
                priorTaken = false;
                continue;
            }
            // A typed step spelled as a later power of the card skips the powers before it (see skipAheadTarget).
            const skipTarget = GnosticaGame.skipAheadTarget(cardDef, top.nextStepIndex, steps[segIdx]);
            if (skipTarget !== top.nextStepIndex) {
                top.nextStepIndex = skipTarget;
                priorTaken = false;
            }
            const stepIndex = top.nextStepIndex;
            const step = cardDef.powers[stepIndex];
            if ("special" in step && step.special === "fool") {
                // Fool's own step always auto-resolves the instant it's next in line on a real commit - nothing here for a click to build.
                return { held };
            }
            const isLastSegment = segIdx === steps.length - 1;
            // Set in whichever branch below falls through (step complete) - the IStep this segment becomes.
            let completedStep: IStep | undefined;
            if ("primitive" in step) {
                const suitUidForStep = this.primitiveToSuit(step.primitive);
                const opts = this.computeShortcutOpts(cardDef, step.primitive, stepIndex, cardDef.powers.length, step.opts);
                const istepSoFar: IStep = steps[segIdx] ?? { action: "with" };
                const stepHere = (): Omit<IPendingStep, "game"> => {
                    const { minion, ambiguous, candidates } = (holder.clone ?? this).resolveStepMinion(istepSoFar.withPiece, top.minions, suitUidForStep);
                    return { head, headArg, activeCardUid: top.cardUid, asUid, asSuit, suitUid: suitUidForStep, eligible: top.eligible, minions: top.minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps: [...priorSteps], opts, istep: istepSoFar, announceLast: parsed.announceLast };
                };
                if ((istepSoFar.complete ?? -1) < 0) {
                    return { advanced: stepHere() };
                }
                if (isLastSegment) {
                    held = { pending: stepHere(), game: (holder.clone ?? this).scratchClone() };
                }
                completedStep = istepSoFar;
            } else {
                // A Magician's suit choice lives in asSuit, unless worldBorrow lets a chained card supply it.
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
                    held = { pending: stepHere(), game: (holder.clone ?? this).scratchClone() };
                }
                completedStep = istepSoFar;
            }
            // Walking past this segment lets a LATER step of the SAME card become click-driven, via a clone.
            priorSteps.push(completedStep!);
            holder.clone ??= this.scratchClone();
            const clone = holder.clone;
            // A magicianChoice step needs its suit passed as `borrowedPower` here.
            const magicianAs = "special" in step && step.special === "magicianChoice" && asSuit !== undefined;
            const outcome = clone.applyPowerStep(step, top.minions, completedStep, cardDef, stepIndex, cardDef.powers.length, true, magicianAs ? asSuit : undefined, true, priorTaken);
            priorTaken = true;
            if (isLastSegment && held !== undefined) {
                held.pending.softComplete = outcome?.softComplete === true;
            }
            top.minions = GnosticaGame.chainMinion(top.minions, outcome ?? {});
            top.nextStepIndex = outcome?.consumesRest ? cardDef.powers.length : top.nextStepIndex + 1;
            if (outcome?.pushPower !== undefined) {
                stack.push({ cardUid: outcome.pushPower.cardUid, nextStepIndex: 0, eligible: [...outcome.pushPower.minions], minions: [...outcome.pushPower.minions] });
            }
            GnosticaGame.popExhaustedPowers(clone, stack);
        }
        const top = stack[stack.length - 1];
        if (top === undefined) {
            return { held }; // every step already complete - nothing left to click for
        }
        const cardDef = this.resolveCardDef(top.cardUid);
        const stepIndex = top.nextStepIndex;
        if (stepIndex >= cardDef.powers.length) {
            return { held };
        }
        const step = cardDef.powers[stepIndex];
        if ("primitive" in step) {
            const suitUid = this.primitiveToSuit(step.primitive);
            const opts = this.computeShortcutOpts(cardDef, step.primitive, stepIndex, cardDef.powers.length, step.opts);
            const { minion, ambiguous, candidates } = (holder.clone ?? this).resolveStepMinion(undefined, top.minions, suitUid);
            return { held, advanced: { head, headArg, activeCardUid: top.cardUid, asUid, asSuit, suitUid, eligible: top.eligible, minions: top.minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts, istep: { action: "with" }, announceLast: parsed.announceLast } };
        }
        return { held, advanced: this.buildSpecialPending(holder.clone ?? this, step.special, head, headArg, top.cardUid, top.eligible, top.minions, priorSteps, { action: "with" }, asUid, asSuit, parsed.announceLast) };
    }

    // Builds the `special`-flavored branch of IPendingStep, with an exception for magicianChoice once its suit is chosen, which is treated as a plain suit step.
    private buildSpecialPending(
        ctx: GnosticaGame, special: SpecialPower, head: "use" | "play", headArg: string, activeCardUid: string,
        eligible: IPieceRef[], minions: IPieceRef[], priorSteps: IStep[], istep: IStep, asUid?: string, asSuit?: MinorSuitUid, announceLast = false,
    ): Omit<IPendingStep, "game"> {
        if (special === "magicianChoice" && asSuit !== undefined) {
            const { minion, ambiguous, candidates } = ctx.resolveStepMinion(istep.withPiece, minions, asSuit);
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
    public minorTargetCell(minion: IPieceRef): string {
        // `minion.piece`, when set, is a snapshot from a clone that already replayed an earlier step - preferred over a fresh board read (pre-mutation until commit).
        const piece = minion.piece;
        if (piece.orientation === "U") {
            return minion.cell;
        }
        const [dx, dy] = this.board.delta(piece.orientation as Exclude<Orientation, "U">);
        const [x, y] = xy(minion.cell);
        return GnosticaBoard.coords2algebraic(x + dx, y + dy);
    }

    // Whether `step` is a piece-target special (tradeHands/hierophantReplace, the only two requiring an ENEMY on the self-or-facing cell) with NO legal candidate right now.
    private specialStepHasNoLegalTarget(ctx: GnosticaGame, step: PowerStep, minions: readonly IPieceRef[]): boolean {
        if (!("special" in step) || (step.special !== "tradeHands" && step.special !== "hierophantReplace")) {
            return false;
        }
        // Checked against EVERY minion in `minions` (chainMinion may leave 2+ live candidates); `ctx` matters because validatePowerSteps applies to a CLONE, not `this`.
        return minions.every(m => {
            const faceCell = ctx.minorTargetCell(m);
            const t = ctx.cellContents(faceCell);
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
        minX--;
        maxX++;
        minY--;
        maxY++;
        if (this.waypointCell !== undefined && (board.get(this.waypointCell)?.pieces.length ?? 0) > 0) {
            const [x, y] = xy(this.waypointCell);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
        return { minX, maxX, minY, maxY };
    }

    // Inverse of resolvePieceRef: the shortest ref that resolves back to this exact piece in the pool. Tries pips, then pips+orientation, then pips+player, then all three.
    // With a pool, the owner's other pieces in the cell count too: a later step may resolve the ref against all of the owner's pieces, not only the pool.
    public pieceRefStr(minion: IPieceRef, pool?: IPieceRef[]): string {
        const { cell } = minion;
        const piece = minion.piece;
        let candidateRefs: IPieceRef[];
        if (pool === undefined) {
            candidateRefs = (this.cellContents(cell)?.pieces ?? []).map((piece): IPieceRef => ({ cell, piece }));
        } else {
            candidateRefs = pool.filter(p => p.cell === cell);
            (this.cellContents(cell)?.pieces ?? []).forEach(p => {
                if (p.owner === piece.owner && !candidateRefs.some(r => GnosticaGame.samePiece(r, { cell, piece: p }))) {
                    candidateRefs.push({ cell, piece: p });
                }
            });
        }
        const byPips = candidateRefs
            .map(r => r.piece)
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
    private pushOrientResult(piece: IPieceRef, pieceRef: string, facing: Orientation): void {
        this.results.push({
            type: "orient",
            where: piece.cell,
            what: this.getPipsFromRef(pieceRef),
            facing,
            who: piece.piece.owner,
        });
    }

    // Click-to-orient: clicking the piece's own cell means "face up"; clicking an orthogonal neighbour means "face that way" - one click states the direction outright.
    private orientationTowardClick(fromCell: string, toCell: string): Orientation | undefined {
        if (fromCell === toCell) {
            return "U";
        }
        const [fromX, fromY] = xy(fromCell);
        const [toX, toY] = xy(toCell);
        for (const dir of cardinalOrientations) {
            const [dx, dy] = this.board.delta(dir as Exclude<Orientation, "U">);
            if (fromX + dx === toX && fromY + dy === toY) {
                return dir;
            }
        }
        return undefined;
    }


    // The distances a Rod's minion may push the named piece, up to its size.
    private rodPieceDistances(pending: IPendingStep, targetRef: string): number[] {
        const target = this.resolvePieceRef(targetRef);
        if (target.kind !== "ok") {
            return [];
        }
        const piece = pending.minion.piece;
        const legal: number[] = [];
        for (let dist = 1; dist <= piece.size; dist++) {
            if (this.checkMovePiece(pending.minion, target.ref, dist) === undefined) {
                legal.push(dist);
            }
        }
        return legal;
    }

    // The nearest legal distance for a Rod's territory push, or undefined when none is.
    private rodPushDistance(minion: IPieceRef): number | undefined {
        const faceCell = this.minorTargetCell(minion);
        for (let dist = 1; dist <= minion.piece.size; dist++) {
            if (this.checkMoveTerritory(minion, faceCell, dist) === undefined) {
                return dist;
            }
        }
        return undefined;
    }

    // Best-effort feasibility check for which modes are worth offering as buttons - not a full legality check; an unusable mode's button is crossed out and inert.
    public unavailableModes(pending: { suitUid?: MinorSuitUid; minion: IPieceRef; opts: Record<string, unknown> }): Set<MinorMode> {
        // Only ever called for a suit-shaped pending - suitUid is guaranteed set here.
        const suitUid = pending.suitUid!;
        const minion = pending.minion.piece;
        const faceCell = this.minorTargetCell(pending.minion);
        const targetT = this.cellContents(faceCell);
        const hand = this.hands[this.currplayer - 1];
        const pile = pending.opts.replacementSource === "discard" ? [...hand, ...this.discardPile] : hand;
        const current = targetT?.pointValue() ?? 0;
        const handHasCardOfValue = (cards: string[], value: number): boolean => cards.some(uid => {
            const c = allCards().find(cc => cc.uid === uid);
            return c !== undefined && cardPointValue(c) === value;
        });
        const isUnavailable = (mode: MinorMode): boolean => {
            switch (`${suitUid}.${mode}`) {
                case "C.own":
                    return !(targetT === undefined || targetT.canAdd(pending.opts.ignoreCapacity === true))
                        || !(pending.opts.skipStashCheck === true || this.hasStashAvailable(this.currplayer, 1));
                case "C.enemy":
                    return !(targetT?.pieces ?? []).some(p => p.owner !== this.currplayer);
                case "C.new":
                    return this.classifyCell(faceCell) !== "wasteland"
                        || !(pending.opts.allowRandomDraw === true || handHasCardOfValue(hand, 1) || (pending.opts.allowRoyalty === true && handHasCardOfValue(hand, 2)));
                case "R.piece":
                    return this.rodNeedsFacing("R", minion);
                case "R.tile":
                    return this.rodNeedsFacing("R", minion) || this.rodPushDistance(pending.minion) === undefined;
                case "D.tile": {
                    const maxDelta = pending.opts.skipLadder === true ? 2 : 1;
                    return current === 0 || ![...Array(maxDelta)].some((_, i) => handHasCardOfValue(pile, current + i + 1));
                }
                case "S.tile": {
                    const maxPips = minion.size * (pending.opts.bothSwords === true ? 2 : 1);
                    return current === 0 || ![...Array(maxPips)].some((_, i) => current - (i + 1) >= 0 && (current - (i + 1) === 0 || handHasCardOfValue(pile, current - (i + 1))));
                }
                default:
                    return false;
            }
        };
        const modes: MinorMode[] = suitUid === "C" ? ["own", "enemy", "new"] : ["piece", "tile"];
        return new Set(modes.filter(isUnavailable));
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

    // The verb a pending step is spelled with.
    private stepAction(pending: IPendingStep): string {
        if (pending.special !== undefined) {
            return pending.special === "magicianChoice" ? "create" : SPECIAL_STEP_ACTIONS[pending.special] ?? pending.special;
        }
        return pending.suitUid === "C" ? "create" : RDS_VERBS[pending.suitUid!]!;
    }

    // The pending step's own move string with `fields` added: its verb and its acting minion come from the pending step.
    private stepMove(pending: IPendingStep, fields: Partial<IStep>): string {
        return this.assembleStepMove(pending, { action: this.stepAction(pending), withPiece: this.pieceRefStr(pending.minion, pending.minions), ...fields });
    }

    // The minion is chosen but nothing else about this step is yet - every IStep needs SOME action, so this seeds just a bare "with <ref>" anchor, mirroring parseMove's own tolerance.
    private buildAnchorMove(pending: IPendingStep, ref: string): string {
        if (pending.special === undefined) {
            return this.assembleStepMove(pending, { action: "with", withPiece: ref });
        }
        return this.assembleStepMove(pending, {
            action: this.stepAction(pending),
            withPiece: ref,
            // orientMinion's acting minion is also its target, so pickle omits the "with" prefix (the bare "orient <ref>" grammar).
            ...(pending.special === "orientMinion" ? { targetPiece: ref } : {}),
            ...(pending.special === "judgementDraw" ? { cardList: [] } : {}),
        });
    }

    // Builds the move string for a step whose target was just picked from the unified candidate list; which suit-mode this becomes is inferred entirely from `targetRef`'s shape.
    private buildTargetedStepMove(pending: IPendingStep, targetRef: string): string {
        // Only ever called for a suit-shaped pending - suitUid is guaranteed set in every case.
        const suitUid = pending.suitUid!;
        const targetCell = this.minorTargetCell(pending.minion);
        if (suitUid === "C") {
            let step: Partial<IStep>;
            if (targetRef === "own") {
                // Trailing "?" - the new piece's default facing isn't yet a deliberate choice (mirrors "place"'s identical convention for the first piece).
                step = { atCell: targetCell, direction: "U?" };
            } else if (targetRef === "new") {
                step = { atCell: targetCell };
            } else {
                step = { atCell: targetCell, targetPiece: targetRef };
            }
            return this.stepMove(pending, step);
        }
        const minionPiece = pending.minion.piece;
        // A size-1 minion has only one legal dist/pips value, supplied here; a size>1 minion is left unset so the step reads as still-incomplete, not a guessed default.
        const isPieceTarget = targetRef.includes(".");
        let onlyCount = minionPiece.size === 1 ? 1 : undefined;
        // A Rod's piece has only one distance when the others would land it in a full territory.
        if (onlyCount === undefined && suitUid === "R" && isPieceTarget) {
            const legal = this.rodPieceDistances(pending, targetRef);
            onlyCount = legal.length === 1 ? legal[0] : undefined;
        }
        let step: Partial<IStep>;
        if (suitUid === "D") {
            step = isPieceTarget ? { targetPiece: targetRef } : { targetCell };
        } else if (isPieceTarget) {
            step = { targetPiece: targetRef };
            if (onlyCount !== undefined) {
                step.amount = onlyCount;
            }
        } else if (suitUid === "R") {
            // Rods' "tile" mode seeds the nearest distance that is legal (1 unless that space is occupied) - a destination-cell click reaches any other.
            step = { targetCell, amount: this.rodPushDistance(pending.minion) ?? 1 };
        } else {
            // A territory's shrink is set by the replacement card (or the Destroy button), not chosen up front.
            step = { targetCell };
        }
        return this.stepMove(pending, step);
    }

    // Hermit's version of buildTargetedStepMove.
    private buildTargetedHermitMove(pending: IPendingStep, targetRef: string): string {
        if (targetRef.includes(".")) {
            return this.stepMove(pending, { targetPiece: targetRef });
        }
        const cardUid = this.cellContents(this.minorTargetCell(pending.minion))?.cardUid;
        return this.stepMove(pending, cardUid === undefined ? {} : { card: cardUid });
    }

    // Board-click handling once a minor-arcana power step's MODE is already chosen - cycling or switching whichever trailing arg(s) that mode's shape supports.
    private handlePendingStepBoardClick(pending: IPendingStep, clickedCell: string): string | IClickResult | undefined {
        if (this.pendingMode(pending) === undefined) {
            return undefined;
        }
        // Only ever called for a suit-shaped pending - suitUid is guaranteed set here.
        const suitUid = pending.suitUid!;
        const mode = this.pendingMode(pending)!;
        const minionPiece = pending.minion.piece;

        if (mode !== "piece") {
            const faceCell = this.minorTargetCell(pending.minion);
            // Cups "own" is the one cell-shape mode with an orientation arg; a click here sets the OPTIONAL 3rd token, over the target cell PLUS its neighbours.
            if (suitUid === "C" && mode === "own") {
                const dir = this.orientationTowardClick(faceCell, clickedCell);
                if (dir === undefined) {
                    return undefined;
                }
                return this.stepMove(pending, { atCell: faceCell, direction: dir });
            }
            // Rods' "tile" mode: the cell is fixed (the facing cell) - a click instead sets DISTANCE, anchored on the facing cell rather than a chosen piece target.
            if (suitUid === "R") {
                for (let n = 1; n <= minionPiece.size; n++) {
                    if (clickedCell === this.cellBeyond(faceCell, minionPiece.orientation, n)) {
                        return this.stepMove(pending, { targetCell: pending.istep.targetCell!, amount: n });
                    }
                }
                return undefined;
            }
            if (clickedCell !== faceCell) {
                return undefined;
            }
            // "new" (Cups) - the only remaining arg is a hand-card uid, nothing to cycle here; "enemy"'s victim is already chosen the instant the mode is inferred.
            if (suitUid === "C") {
                return mode === "new" ? this.stepMove(pending, { atCell: pending.istep.atCell! }) : undefined;
            }
            // "tile" (Discs) - same as "new" above.
            return this.stepMove(pending, { targetCell: pending.istep.targetCell! });
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
                for (let n = 1; n <= minionPiece.size; n++) {
                    if (clickedCell === this.cellBeyond(target.cell, minionPiece.orientation, n)) {
                        return this.stepMove(pending, { targetPiece: pending.istep.targetPiece, amount: n });
                    }
                }
            }

            // Once the suit action is otherwise complete, a further click adjacent to the target's EFFECTIVE position sets its facing - only for the player's own piece.
            if ((pending.istep.complete ?? -1) < 0) {
                return undefined;
            }
            const targetPiece = this.getPiece(target);
            if (targetPiece.owner !== this.currplayer) {
                return undefined;
            }
            const effCell = suitUid === "R" ? this.cellBeyond(target.cell, minionPiece.orientation, pending.istep.amount!) : target.cell;
            const dir = this.orientationTowardClick(effCell, clickedCell);
            if (dir === undefined) {
                return undefined;
            }
            // The "core" required args (target, plus distance/pips for R/S - D.piece has no second arg), dropping any stale trailing facing correction.
            const core: Partial<IStep> = suitUid === "D" ? { targetPiece: pending.istep.targetPiece } : { targetPiece: pending.istep.targetPiece, amount: pending.istep.amount! };
            // This trailing facing is only ever an OPTIONAL addition, so a click landing back on the piece's own UNCORRECTED facing completes the step, not a no-op.
            if (dir === targetPiece.orientation) {
                const baseMove = this.stepMove(pending, core);
                return { move: baseMove, valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
            }
            return this.stepMove(pending, { ...core, direction: dir });
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
            const faceCell = istep.targetCell!;
            const amount = (this.cellContents(faceCell)?.pointValue() ?? 0) - this.cardValueByUid(uid);
            return this.assembleStepMove(pending, { ...istep, withPiece: minionRef, card: uid, amount });
        }
        // Everything typed so far stays; the uid is the only thing this click adds.
        return this.assembleStepMove(pending, { ...istep, withPiece: minionRef, card: uid });
    }

    // Shared self-or-facing-cell target pick, used by tradeHands/orientAny/hierophantReplace/hermitTeleport's "piece" mode alike; undefined when the click is off-target.
    private pickPieceTargetClick(minion: IPieceRef, cell: string, pendingForError: IPendingStep): string | IClickResult | undefined {
        const faceCell = this.minorTargetCell(minion);
        // tradeHands/hierophantReplace must target an enemy; orientAny/hermitTeleport don't - reject a self-target immediately rather than fail only at submit.
        const requiresEnemy = pendingForError.special === "tradeHands" || pendingForError.special === "hierophantReplace";
        const enemyKey = pendingForError.special === "tradeHands" ? "TRADEHANDS_MUST_TARGET_ENEMY" : "HIEROPHANT_MUST_TARGET_ENEMY";
        if (cell === minion.cell) {
            if (requiresEnemy) {
                return { move: this.describePendingMove(pendingForError, pendingForError.priorSteps), valid: false, message: i18next.t(`apgames:validation.gnostica.${enemyKey}`) };
            }
            return this.pieceRefStr(minion);
        }
        if (cell !== faceCell) {
            return undefined;
        }
        const t = this.cellContents(faceCell);
        if (t === undefined || t.pieces.length === 0) {
            return { move: this.describePendingMove(pendingForError, pendingForError.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE", { cell }) };
        }
        if (requiresEnemy) {
            const enemyIndex = t.pieces.findIndex(p => p.owner !== this.currplayer);
            if (enemyIndex === -1) {
                return { move: this.describePendingMove(pendingForError, pendingForError.priorSteps), valid: false, message: i18next.t(`apgames:validation.gnostica.${enemyKey}`) };
            }
            return this.pieceRefStr({ cell: faceCell, piece: t.pieces[enemyIndex] });
        }
        return this.pieceRefStr({ cell: faceCell, piece: t.pieces[0] });
    }

    // Handles a board click for whichever special power is in progress - undefined for judgementDraw/highPriestess/magicianChoice/hermitTeleport stage 1.
    private handlePendingSpecialBoardClick(pending: IPendingStep, cell: string): string | IClickResult | undefined {
        switch (pending.special) {
            // orientMinion: <minionRef> <orientation> - the acting minion IS the target, so this is just click-to-orient.
            case "orientMinion": {
                const dir = this.orientationTowardClick(pending.minion.cell, cell);
                if (dir === undefined) {
                    return undefined;
                }
                return this.stepMove(pending, { targetPiece: this.pieceRefStr(pending.minion, pending.minions), direction: dir });
            }
            case "tradeHands":
            case "orientAny":
            case "hierophantReplace": {
                if (pending.special === "tradeHands" || pending.istep.targetPiece === undefined) {
                    const targetResult = this.pickPieceTargetClick(pending.minion, cell, pending);
                    if (targetResult === undefined) {
                        return undefined;
                    }
                    if (typeof targetResult !== "string") {
                        return targetResult;
                    }
                    return this.buildSpecialTargetMove(pending, targetResult);
                }
                const targetRef = pending.istep.targetPiece;
                const targetResolution = this.resolvePieceRef(targetRef);
                if (targetResolution.kind !== "ok") {
                    return undefined;
                }
                const dir = this.orientationTowardClick(targetResolution.ref.cell, cell);
                if (dir === undefined) {
                    return undefined;
                }
                // `dir` is already the click's own final resolved facing - no need to also carry Hierophant's now-superseded seed.
                return this.stepMove(pending, { targetPiece: targetRef, direction: dir });
            }
            case "hermitTeleport": {
                const mode = stepHermitMode(pending.istep);
                if (mode === undefined) {
                    return undefined; // mode not chosen yet - only the hermit_piece/hermit_tile buttons can start this
                }
                if (mode === "tile") {
                    // No self-vs-face CHOICE for a cell-shaped target - so any click here just sets/replaces the (unrestricted) destination.
                    const cardUid = this.cellContents(this.minorTargetCell(pending.minion))?.cardUid;
                    if (cardUid === undefined) {
                        return undefined;
                    }
                    return this.stepMove(pending, { card: cardUid, targetCell: cell });
                }
                // "piece" mode: the target is a genuine self-or-facing-cell choice until a destination is picked, then further clicks only replace it.
                if (pending.istep.targetCell === undefined) {
                    const targetResult = this.pickPieceTargetClick(pending.minion, cell, pending);
                    if (typeof targetResult === "string") {
                        return this.stepMove(pending, { targetPiece: targetResult });
                    }
                    if (targetResult !== undefined) {
                        return targetResult; // NO_PIECE_THERE at the facing cell
                    }
                    // Not a self/face click - once a target's already picked, treat this as the destination instead; otherwise there's nothing to build yet.
                    if (pending.istep.targetPiece === undefined) {
                        return undefined;
                    }
                    return this.stepMove(pending, { targetPiece: pending.istep.targetPiece, targetCell: cell });
                }
                return this.stepMove(pending, { targetPiece: pending.istep.targetPiece!, targetCell: cell });
            }
            case "worldUseAny": {
                const t = this.cellContents(cell);
                if (t?.card === undefined) {
                    return undefined; // not a card cell at all
                }
                if (t.card.uid === "21") {
                    return { move: this.describePendingMove(pending, pending.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.WORLD_SELF_REFERENCE") };
                }
                if (!t.card.major) {
                    return { move: this.describePendingMove(pending, pending.priorSteps), valid: false, message: i18next.t("apgames:validation.gnostica.WORLD_CHOOSE_TARGET") };
                }
                return this.describePendingMove({ ...pending, asUid: t.card.uid }, pending.priorSteps);
            }
            default:
                return undefined;
        }
    }

    // Builds this step's own move string once a target ref is already resolved - shared by the click-driven stage 1 (pickPieceTargetClick) and the button-driven target picker.
    private buildSpecialTargetMove(pending: IPendingStep, targetRef: string): string | undefined {
        if (pending.special === "hierophantReplace") {
            const targetResolution = this.resolvePieceRef(targetRef);
            if (targetResolution.kind !== "ok") {
                return undefined;
            }
            const capturedFacing = (targetResolution.ref.piece
                ?? this.getPiece(targetResolution.ref)).orientation;
            // Trailing "?" - seeded from the captured piece's own prior facing, not yet a deliberate choice (mirrors Cups "own"'s identical convention).
            return this.stepMove(pending, { targetPiece: targetRef, direction: `${capturedFacing}?` });
        }
        // tradeHands and orientAny: the target is chosen; orientAny's new facing is a separate decision only the player's own click may make - never auto-assigned.
        return this.stepMove(pending, { targetPiece: targetRef });
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
            // A handler's own rejection of a click that does nothing (a wrong World pick, say) leaves the move as it was, still previewable, with its message.
            if (!result.valid && this.phase === "main") {
                const current = this.validateMove(result.move);
                result = { ...result, valid: true, complete: current.valid ? current.complete : -1 };
            }
        }
        // The front end only re-renders a live partial preview when `canrender` or `complete >= 0` is set - set unconditionally here for any valid result.
        // A click-built move that fails validation is still previewed, as its valid part plus an Undo, rather than falling back to the turn-start buttons.
        if (result.valid || (typeof outcome === "string" && outcome !== move && outcome !== "" && this.phase === "main")) {
            result.canrender = true;
        }
        return result;
    }

    // Routes a click on the move so far (as parsed) to the handler for what was clicked.
    private routeClick(parsed: IParsedMove, row: number, col: number, piece?: string): string | IClickResult {
        // The "bidding" variant's opening procedure is structurally unlike every other click, so it's handled entirely by its own function.
        if (this.phase !== "main") {
            return this.handleBiddingClick(parsed, piece);
        }
        // A pending obligation's own real click targets show up directly, so the move may still be leftover from before it existed - seed it uniformly here.
        if (parsed.head === undefined) {
            parsed = this.resumeMove(parsed) ?? parsed;
        }
        // A click outside the board grid (both coordinates negative) names what was clicked in `piece`; a buffer segment only has one coordinate out of range, and goes to clickBoard.
        if (row < 0 && col < 0 && piece !== undefined) {
            if (piece.startsWith("_btn_")) {
                return this.clickButton(parsed, piece.slice("_btn_".length));
            }
            // Discard-pile clicks drive judgementDraw only; a minor-arcana bucket has no individual identity, so clicking one draws a uniformly-random not-yet-selected uid from it.
            if (/^[A-Z]_(spot|royal)_/.test(piece)) {
                return this.clickDiscardPile(parsed, piece);
            }
            // A card is in one place at a time, so a card key is a hand card unless it is in the discard pile; board cards are never clicked through the legend.
            const cardUid = GnosticaGame.cardKeyUid(piece);
            if (cardUid !== undefined) {
                return this.discardPile.includes(cardUid) ? this.clickDiscardPile(parsed, cardUid) : this.clickHandCard(parsed, cardUid);
            }
        }
        return this.clickBoard(parsed, row, col, piece);
    }

    private clickButton(parsed: IParsedMove, value: string): string | IClickResult {
        const prefixed: [string, (parsed: IParsedMove, arg: string) => string | IClickResult][] = [
            ["minion_", (p, a) => this.clickMinionButton(p, a)],
            ["orientpick_", (p, a) => this.clickOrientPickButton(p, a)],
            ["target_", (p, a) => this.clickTargetButton(p, a)],
            ["pips_", (p, a) => this.clickPipsButton(p, a)],
            ["magician_", (p, a) => this.clickMagicianButton(p, a)],
            ["drawcount_", (p, a) => this.clickDrawCountButton(p, a)],
            ["hpdraw_", (p, a) => this.clickHpDrawButton(p, a)],
        ];
        for (const [prefix, handler] of prefixed) {
            if (value.startsWith(prefix)) {
                return handler(parsed, value.slice(prefix.length));
            }
        }
        return this.clickActionButton(parsed, value);
    }

    // "minion_<ref>" - offered whenever 2+ of the acting player's pieces are eligible and none has been picked yet; types just the ref.
    private clickMinionButton(parsed: IParsedMove, ref: string): string | IClickResult {
        const pending = this.parsePendingStep(parsed).advanced;
        if (pending === undefined) {
            return this.noop(parsed);
        }
        return pending.game.buildAnchorMove(pending, ref);
    }

    // "orientpick_<ref>" - orient's own minion-picker (orient has no IPendingStep to resolve against, so it can't reuse "minion_"); facing is a separate click.
    private clickOrientPickButton(parsed: IParsedMove, ref: string): string | IClickResult {
        return `orient ${ref}${parsed.announceLast ? " last" : ""}`;
    }

    // The unified candidate list for a fresh suit-power step, hermitTeleport, or an ambiguous orientAny/tradeHands/hierophantReplace target - one click supplies it directly.
    private clickTargetButton(parsed: IParsedMove, ref: string): string | IClickResult {
        const pending = this.parsePendingStep(parsed).advanced;
        if (pending === undefined) {
            return this.noop(parsed);
        }
        if (pending.special === "hermitTeleport") {
            return pending.game.buildTargetedHermitMove(pending, ref);
        }
        if (pending.special === "orientAny" || pending.special === "tradeHands" || pending.special === "hierophantReplace") {
            return pending.game.buildSpecialTargetMove(pending, ref) ?? this.noop(parsed);
        }
        return pending.game.buildTargetedStepMove(pending, ref);
    }

    // Swords "piece" (attack) pips - a button set rather than a click-cycled arg, always rebuilt against the CURRENT target.
    private clickPipsButton(parsed: IParsedMove, n: string): string | IClickResult {
        const pending = this.parsePendingStep(parsed).advanced;
        if (pending === undefined) {
            return this.noop(parsed);
        }
        return pending.game.stepMove(pending, { targetPiece: pending.istep.targetPiece!, amount: parseInt(n, 10) });
    }

    // Stage 1 of magicianChoice - picks the suit letter, landing in the head as "as <suit>"; every following click then uses ordinary suit-mode machinery.
    private clickMagicianButton(parsed: IParsedMove, suit: string): string | IClickResult {
        // The button's own suffix always comes from ALL_SUITS, so it's a real MinorSuitUid even though this parse can't prove it.
        return this.pickleMove({ ...parsed, asSuit: suit as MinorSuitUid });
    }

    // The count-picker buttons offered once "discard" is the live head and no "draw <n>" suffix has been chosen yet; always rebuilt from the current discard uids.
    private clickDrawCountButton(parsed: IParsedMove, n: string): string | IClickResult {
        const via = parsed.viaUid !== undefined ? ` via ${parsed.viaUid}` : "";
        return ["discard", ...(parsed.steps[0]?.cardList ?? []), "draw", n].join(" ") + via + (parsed.announceLast ? " last" : "");
    }

    // High Priestess's count-picker - mirrors drawcount_ but appends onto the CURRENT power step's own istep, not the top-level move's args.
    private clickHpDrawButton(parsed: IParsedMove, n: string): string | IClickResult {
        const pending = this.parsePendingStep(parsed).advanced;
        if (pending === undefined) {
            return this.noop(parsed);
        }
        // Picking a count always completes this step - whatever's already been discarded is sitting in the step's own cardList.
        const cardList = pending.istep.cardList ?? [];
        return pending.game.assembleStepMove(pending, { action: "discard", cardList, amount: parseInt(n, 10) });
    }

    private clickActionButton(parsed: IParsedMove, value: string): string | IClickResult {
        const last = parsed.announceLast ? " last" : "";
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
                // Seeds the resume submission's head + already-known card uid directly - pendingPower already names the exact card, no board click needed.
                // Returned as a candidate string, not a hardcoded complete:-1, since a resumed Fool flip is ALREADY complete and needs Submit enabled.
                return this.pickleMove(this.freshResumeMove(false, parsed.announceLast));
            case "decline_power":
                // Declining pops the CURRENT top of the stack; Fool's own remaining flip auto-resolves on this same commit instead of pausing.
                return this.pickleMove(this.freshResumeMove(true, parsed.announceLast));
            case "undo":
                return this.pickleMove(this.retractedMove(parsed));
            case "skip_reorient":
                return this.settleFacing(parsed);
            case "skip":
                return this.pickleMove({ ...parsed, steps: [parsed.steps[0], { action: "skip", complete: -1 }] });
            case "drawn": {
                // Only ever offered for Wheel of Fortune's special option.
                const pending = this.parsePendingStep(parsed).advanced;
                if (pending === undefined) {
                    return this.noop(parsed);
                }
                return pending.game.supplyStepCardUid(pending, "drawn") ?? this.noop(parsed);
            }
            case "destroy": {
                const pending = this.parsePendingStep(parsed).advanced;
                if (pending === undefined || pending.istep.targetCell === undefined) {
                    return this.noop(parsed);
                }
                const faceCell = pending.istep.targetCell;
                const minionRef = pending.game.pieceRefStr(pending.minion, pending.minions);
                return pending.game.assembleStepMove(pending, { ...pending.istep, withPiece: minionRef, amount: pending.game.cellContents(faceCell)?.pointValue() ?? 0 });
            }
            default:
                return this.noop(parsed);
        }
    }

    private clickHandCard(parsed: IParsedMove, uid: string): string | IClickResult {
        const last = parsed.announceLast ? " last" : "";
        const { head, steps: headSteps } = parsed;
        const toggled = (list: string[]): string[] => list.includes(uid) ? list.filter(u => u !== uid) : [...list, uid];
        // A card already being played isn't in the hand it would replace from.
        const pendingForCard = this.parsePendingStep(parsed).current;
        const hand = (pendingForCard?.game ?? this).hands[this.currplayer - 1] ?? [];
        if (!hand.includes(uid)) {
            return this.ignoredClick(parsed, i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }));
        }
        if (pendingForCard !== undefined && this.pendingMode(pendingForCard) !== undefined) {
            const result = pendingForCard.game.supplyStepCardUid(pendingForCard, uid);
            if (result !== undefined) {
                return result;
            }
            // Not a mode expecting a card uid right now - fall through.
        }
        if (pendingForCard?.special === "highPriestess") {
            // Special handling for the one of her discard/draw steps - istep.cardList is already just the discard uids, "draw N" already stripped.
            return pendingForCard.game.assembleStepMove(pendingForCard, { action: "discard", cardList: toggled(pendingForCard.istep.cardList ?? []) });
        }
        if (head === "play") {
            // "play"'s own pool can span the whole board, unlike "use".
            return `play ${uid}${last}`;
        }
        if (head === "discard") {
            return ["discard", ...toggled(headSteps[0]?.cardList ?? [])].join(" ") + last;
        }
        // No action selected yet - require a button click first rather than guessing what the player meant; once one is, a hand card means nothing and the move's own prompt stands.
        return this.ignoredClick(parsed, head === undefined ? i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") : undefined);
    }

    // The "this click means nothing right now" result: the current move's own status, unchanged, so the player sees no new message or move.
    private noop(parsed: IParsedMove): IClickResult {
        const move = this.pickleMove(parsed);
        return { ...this.validateMove(move), move };
    }

    // A click that means nothing right now: the move stays as it was, and stays previewable even where the move so far isn't valid on its own (a bare "orient").
    private ignoredClick(parsed: IParsedMove, message?: string): IClickResult {
        const result = { ...this.noop(parsed) };
        if (!result.valid) {
            result.valid = true;
            result.complete = -1;
        }
        if (message !== undefined) {
            result.message = message;
        }
        return result;
    }

    private clickDiscardPile(parsed: IParsedMove, key: string): string | IClickResult {
        const pendingForDiscard = this.parsePendingStep(parsed).current;
        if (pendingForDiscard?.special !== "judgementDraw") {
            // Tower/Star: a discard may be the replacement card, in place of one from the hand.
            if (pendingForDiscard?.opts.replacementSource !== "discard") {
                return this.noop(parsed);
            }
            const uid = /^\d{2}$/.test(key) ? this.discardPile.find(u => u === key) : this.pickFromDiscardBucket(key, []);
            return uid === undefined ? this.noop(parsed) : pendingForDiscard.game.supplyStepCardUid(pendingForDiscard, uid) ?? this.noop(parsed);
        }
        const game = pendingForDiscard.game;
        // Leading "draw" may or may not be there yet depending on whether this is the first click - stripped before working the list, reattached when rebuilding.
        const selected = pendingForDiscard.istep.cardList ?? [];
        const minionPiece = game.getPiece(pendingForDiscard.minion);
        const maxDraw = judgementDrawRoom(minionPiece.size, game.hands[this.currplayer - 1]?.length ?? 0);
        const rebuildDiscard = (updated: string[]): string =>
            game.stepMove(pendingForDiscard, { cardList: updated });

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

    private clickBoard(parsed: IParsedMove, row: number, col: number, piece?: string): string | IClickResult {
        const move = this.pickleMove(parsed);
        const last = parsed.announceLast ? " last" : "";
        const { head, steps: headSteps } = parsed;
        // The client displays the board with the current move already applied, so row/col are relative to THAT window - an earlier step's new territory can widen it.
        const { minX, minY } = this.renderWindow(this.previewBoard(parsed));
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
            const dir = prevCell !== undefined ? this.orientationTowardClick(prevCell, cell) : undefined;
            return prevCell !== undefined && dir !== undefined ? `place ${prevCell} ${dir}${last}` : `place ${cell} U?${last}`;
        }
        if (head === "orient") {
            // Same click-to-orient model as "place", but relative to whichever piece is already selected (prevRef) rather than the clicked cell.
            const prevRef = headSteps[0]?.targetPiece;
            let dir: Orientation | undefined;
            let prevLoc: IPieceRef | undefined;
            // A bare cell token (2+ own pieces there, none picked yet) isn't a resolvable piece ref - treat it the same as "nothing selected yet" below.
            if (prevRef !== undefined && prevRef.includes(".")) {
                prevLoc = this.resolvePieceRefTrusted(prevRef);
                dir = this.orientationTowardClick(prevLoc.cell, cell);
            }
            if (prevLoc !== undefined && dir !== undefined) {
                // validateOrient's own message already distinguishes a no-op from a real, complete reorientation - nothing to override here.
                return `orient ${prevRef} ${dir}${last}`;
            }
            // Fresh selection - routed through the same minion-selection primitive "use"/"play" use, since 2+ distinguishable pieces here need a real choice.
            const pool = this.piecesOwnedAt(cell);
            if (pool.length === 0) {
                // A click on a cell with none of the player's pieces changes nothing: the selection stands and the message says what to click.
                return { move, valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_PIECE_TO_ORIENT") };
            }
            const { minion, ambiguous } = this.resolveStepMinion(undefined, pool);
            return ambiguous ? `orient ${cell}${last}` : `orient ${this.pieceRefStr(minion)}${last}`;
        }
        if (this.inPowerPlay(head)) {
            // Once a minor-arcana power step's mode is chosen, a board click is target/arg cycling for that step first; falls through to ordinary use/play only if unmatched.
            const { current: pending, advanced } = this.parsePendingStep(parsed);
            // Some eligible minions still span more than one cell with none pinned down - a board click here means "this is the cell my minion is on," tried before mode/special cycling.
            const tryNarrowMinion = (candidate: IPendingStep | undefined): string | undefined => {
                if (candidate === undefined || !candidate.minionAmbiguous) {
                    return undefined;
                }
                const atCell = this.actingCandidates(candidate.minions.filter(m => m.cell === cell), candidate.suitUid);
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
                    const turned = pending!.game.handlePendingStepBoardClick(pending!, cell);
                    if (turned === undefined) {
                        return { move, valid: true, complete: 0, message: i18next.t("apgames:validation.gnostica.FACE_OR_NEXT_POWER") };
                    }
                    // A click on the facing it already has keeps it, and goes on.
                    return (typeof turned === "string" ? turned : turned.move) === move ? this.settleFacing(parsed) : turned;
                }
                // The next step is a button-less special whose start click may overlap the finished step's own: it wins, so the next step stays reachable.
                if (!advanced.minionAmbiguous && advanced.special !== undefined && this.pendingSpecialUntouched(advanced)) {
                    const result = advanced.game.handlePendingSpecialBoardClick(advanced, cell);
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
                const result = pending.game.handlePendingStepBoardClick(pending, cell);
                if (result !== undefined) {
                    return result;
                }
            }
            if (pending !== undefined && pending.special !== undefined) {
                const result = pending.game.handlePendingSpecialBoardClick(pending, cell);
                if (result !== undefined) {
                    return result;
                }
            }
            if (head === "play" || this.continued.length > 0) {
                // "play" has no cell of its own to re-pick the way "use" does - a board click here only ever means pending-step cycling (handled above), so the move's own prompt stands.
                return this.ignoredClick(parsed);
            }
            const t = this.board.get(cell);
            if (t?.card === undefined) {
                return this.ignoredClick(parsed, i18next.t("apgames:validation.gnostica.NO_CARD_THERE", { cell }));
            }
            if (!t.pieces.some(p => p.owner === this.currplayer)) {
                return this.ignoredClick(parsed, i18next.t("apgames:validation.gnostica.NO_MINIONS_THERE", { cell }));
            }
            return `use ${t.card.uid}${last}`;
        }
        if (!this.hasPiecesOnBoard(this.currplayer)) {
            // Fresh click, nothing placed yet - place is the only legal start, needs no button. Facing defaults to "U", trailing "?" marking it not yet deliberate.
            return `place ${cell} U?${last}`;
        }
        // No mode chosen yet and pieces already exist - board clicks are genuinely ambiguous here, so this doesn't guess; the player picks a button first.
        return this.ignoredClick(parsed, i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST"));
    }

    // Click support for the "bidding" variant's opening procedure. Row/col are never used - both phases are driven entirely by clicking cards in an AreaPieces.
    private handleBiddingClick(parsed: IParsedMove, piece?: string): string | IClickResult {
        const move = this.pickleMove(parsed);
        // A bid is always exactly one card - unlike discard's toggle-list, each click REPLACES any earlier pick rather than accumulating.
        const cardUid = piece === undefined ? undefined : GnosticaGame.cardKeyUid(piece);
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
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.BID_POSITION_REQUIRED") };
        }
        const hand = this.hands[this.currplayer - 1];
        if (n < 1 || n > hand.length) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.BAD_BID_POSITION", { position: n, max: hand.length }) };
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
            setTurnOrder(); // turnOrder[0] === winners[0] by construction
            // Announce the now-finalized order once. Under "tournament rules" there's no physical seating, so "clockwise" is reinterpreted as turnOrder itself,
            // "counterclockwise" as its exact reverse; the worst bidder (last in turnOrder) redraws first, so jump there directly instead of routing through nextPlayer().
            this.results.push({ type: "announce", payload: [...this.turnOrder] });
            this.phase = "redraw";
            this.currplayer = this.turnOrder[this.numplayers - 1];
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

    // "redraw <uid...>" - free choice from the shared, fully public biddingPool, drawing back up to 6. `partial` mirrors cmdDiscard's split; legality is validateRedraw's job.
    private cmdRedraw(step: IStep, partial = false): void {
        const args = step.cardList ?? [];
        const hand = this.hands[this.currplayer - 1];
        for (const uid of args) {
            this.biddingPool!.splice(this.biddingPool!.indexOf(uid), 1);
            hand.push(uid);
            this.drawn.push(uid);
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
                this.currplayer = this.turnOrder[this.numplayers - 1 - donePos];
            }
        } else {
            // Everyone has redrawn - redraw order (turnOrder reversed) always ends with the bid winner, so whoever just submitted this final redraw already IS the winner.
            this.phase = "main";
            // Nothing left to hide or replay once "bidding" is over for good - clear both so they stop appearing in every subsequent turn's state.
            this.bidPositions = undefined;
            this.biddingPool = undefined;
            if (this.numplayers !== 2) {
                this.currplayer = this.turnOrder[0];
            }
        }
    }

    private validateRedraw(parsed: IParsedMove): IValidationResult {
        const uids = parsed.steps[0]?.cardList ?? [];
        const hand = this.hands[this.currplayer - 1];
        const needed = 6 - hand.length;
        if (uids.length !== needed) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.REDRAW_COUNT_MISMATCH", { requested: uids.length, needed }) };
        }
        const seen = new Set<string>();
        for (const uid of uids) {
            if (seen.has(uid)) {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "DUPLICATE_CARD" }) };
            }
            seen.add(uid);
            if (!this.biddingPool!.includes(uid)) {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.REDRAW_UID_NOT_IN_POOL", { uid }) };
            }
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // "place <cell> <orientation>" - only legal with zero pieces on board; a real facing is always required, same mandatory-facing shape Cups "own" uses.
    private cmdPlace(step: IStep): void {
        const cellStr = step.targetCell!;
        const orientationToken = step.direction!;
        // A trailing "?" (still-prepopulated, not yet deliberate) makes no difference to the actual piece created; strip it the same way here.
        const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
        const orientation = orientationStr as Orientation;
        let territory = this.board.get(cellStr);
        if (territory === undefined) {
            territory = new CellContents(undefined);
            this.board.set(cellStr, territory);
        }
        // Your very first piece comes from your own stash, same as every other piece that ever enters play - it isn't manufactured out of nothing.
        this.takeFromStash(this.currplayer, 1);
        territory.add(new Piece(this.currplayer, 1, orientation));
        this.addBufferIfWasteland(cellStr);
        this.results.push({ type: "place", where: cellStr, how: "initial" });
    }

    private validatePlace(parsed: IParsedMove): IValidationResult {
        const step = parsed.steps[0];
        const cellStr = step?.targetCell;
        const orientationToken = step?.direction;
        if (cellStr === undefined) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.PLACE_CELL_REQUIRED") };
        }
        if (this.board.classify(cellStr) === "void") {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.PLACE_VOID", { cell: cellStr }) };
        }
        const contents = this.board.get(cellStr);
        if (contents !== undefined && contents.pieces.length > 0) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.PLACE_OCCUPIED", { cell: cellStr }) };
        }
        // A default orientation is provided in the click flow, but may be missing from a hand-typed move.
        if (orientationToken === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PLACE_DIRECTION_REQUIRED") };
        }
        // A trailing "?" marks the click flow's own seeded default as not yet deliberate - complete:0; a hand-typed "place l0 U" is complete:1.
        // parseMove already guarantees a valid N/E/S/W/U (with or without "?"), so there's nothing left to validate here.
        const prepopulated = orientationToken.endsWith("?");
        return { valid: true, complete: prepopulated ? 0 : 1, message: i18next.t(prepopulated ? "apgames:validation.gnostica.VALID_MOVE_MAY_ORIENT" : "apgames:validation._general.VALID_MOVE") };
    }

    // "orient <pieceRef> <facing>" - only your own piece; legality is validateOrient's own job.
    private cmdOrient(step: IStep): void {
        const ref = step.targetPiece;
        const orientationStr = step.direction;
        // Still building - a bare cell or a missing orientation isn't resolvable yet; a trusted partial preview can legitimately be here mid-build, so just no-op.
        if (ref === undefined || !ref.includes(".") || orientationStr === undefined) {
            return;
        }
        const piece = this.resolvePieceRefTrusted(ref);
        this.addBufferIfWasteland(piece.cell);
        const orientation = orientationStr as Orientation;
        // Reorienting one of your own minions, with no adjacency restriction, is exactly what orientMinion already is - reuse it rather than mutating .orientation inline.
        this.setPieceOrientation(piece, orientation);
        this.pushOrientResult(piece, ref, orientation);
    }

    // Any board cell whose facing might get set/adjusted by a click needs a buffer on a side only if that side's void cell is ALSO outside the rendered window.
    private addBufferIfWasteland(cell: string): void {
        if (this.classifyCell(cell) !== "wasteland") {
            return;
        }
        const win = this.renderWindow();
        const [x, y] = xy(cell);
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
        this.addBufferIfWasteland(ref.split(".")[0]);
    }

    // A Rods piece step still waiting for its distance: a landing cell can lie past the window, so a buffer on that side gives it something to click.
    private addDistanceBuffer(pending: IPendingStep | undefined): void {
        if (pending?.suitUid !== "R" || pending.istep.amount !== undefined || this.pendingMode(pending) !== "piece") {
            return;
        }
        const target = pending.game.resolvePieceRef(pending.istep.targetPiece);
        const minionPiece = pending.minion.piece;
        if (target.kind !== "ok" || minionPiece === undefined || minionPiece.orientation === "U") {
            return;
        }
        const [dx, dy] = this.board.delta(minionPiece.orientation);
        const win = this.renderWindow();
        const [targetX, targetY] = xy(target.ref.cell);
        for (let n = 1; n <= minionPiece.size; n++) {
            const x = targetX + dx * n;
            const y = targetY + dy * n;
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
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.ORIENT_ARGS_REQUIRED") };
        }
        // A bare cell with 2+ of the player's own pieces means the acting minion hasn't been picked yet - still building, not a hard error, same tolerance every minion-selection context gets.
        if (!ref.includes(".")) {
            if (this.resolveStepMinion(undefined, this.piecesOwnedAt(ref)).ambiguous) {
                return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_MINION_BUTTON") };
            }
        }
        const result = this.resolvePieceRef(ref);
        if (result.kind !== "ok") {
            return this.invalidPieceRef(result.kind, ref);
        }
        const piece = this.getPiece(result.ref);
        if (piece.owner !== this.currplayer) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOT_YOUR_MINION") };
        }
        // The minion itself is chosen but not the orientation.
        if (orientationStr === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT") };
        }
        //The parser already checked the orientation string so just cast it.
        const orientation = orientationStr as Orientation;
        
        // "orient" IS the whole action, so a no-op is rejected.
        if (piece.orientation === orientation) {
            return { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.ORIENT_NO_OP`) };
        }
        // One real direction click is the whole action - done.
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // "discard [uid...] [draw <n>]" - discard the named hand cards, then draw back.
    private cmdDiscard(step: IStep): void {
        const discardUids = step.cardList ?? [];
        const drawCountStr = step.amount?.toString();
        this.discardCards(discardUids);
        if (discardUids.length > 0) {
            this.discarded.push(...discardUids);
            this.results.push({ type: "place", how: "discard", what: discardUids.join(",") });
        }
        this.hidden.push({ type: "draw", count: Number(drawCountStr) });
    }

    // Shared by the top-level discard and High Priestess's rounds: "discard [uid...] draw <n>", where the count is the player's explicit choice.
    private validateDiscard(step: IStep | undefined): IValidationResult {
        const discardUids = step?.cardList ?? [];
        const seen = new Set<string>();
        for (const uid of discardUids) {
            if (seen.has(uid)) {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "DUPLICATE_CARD", uid }) };
            }
            seen.add(uid);
            if (!this.hands[this.currplayer - 1].includes(uid)) {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
            }
        }
        if (step?.amount === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.DISCARD_DRAW_REQUIRED") };
        }
        const maxDraw = Math.max(0, 6 - (this.hands[this.currplayer - 1].length - discardUids.length));
        if (!Number.isInteger(step.amount) || step.amount < 0 || step.amount > maxDraw) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.BAD_DRAW_COUNT", { requested: step.amount, max: maxDraw }) };
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // ---- The power rules: each checkX returns undefined if the action is legal, or a failure; the rest carry the action out ----

    // Reshuffles discard into draw whenever draw is empty, in place (mirrors cmdDraw).
    private reshuffle(): void {
        if (this.drawPile.length > 0 || this.discardPile.length === 0) {
            return;
        }
        this.drawPile.push(...(shuffle(this.discardPile) as string[]));
        this.discardPile.length = 0;
    }

    private stashOf(player: number): Stash {
        return this.stashes.get(player as playerid)!;
    }

    private takeFromStash(player: number, size: Pips): void {
        this.stashOf(player)[size - 1] -= 1;
    }

    private returnToStash(ref: IPieceRef): void {
        this.cellContents(ref.cell)!.removeAt(this.pieceIndex(ref));
        this.stashOf(ref.piece.owner)[ref.piece.size - 1] += 1;
    }

    // Non-mutating check used by checkX functions and validatePlace; the mutators just do the arithmetic.
    private hasStashAvailable(player: number, size: Pips): boolean {
        const s = this.stashes.get(player as playerid);
        return s !== undefined && s[size - 1] > 0;
    }

    public cellContents(cell: string): CellContents | undefined {
        return this.board.get(cell);
    }

    public classifyCell(cell: string): CellClass {
        return this.board.classify(cell);
    }

    // Where a ref's piece stands in its cell: the first piece that looks the same, since pieces that look the same are interchangeable.
    private pieceIndex(ref: IPieceRef): number {
        return (this.cellContents(ref.cell)?.pieces ?? []).findIndex(p => p.id() === ref.piece.id());
    }

    // The piece on this board that a ref names; undefined if it is no longer there.
    private findPiece(ref: IPieceRef): Piece | undefined {
        return this.cellContents(ref.cell)?.pieces[this.pieceIndex(ref)];
    }

    private getPiece(ref: IPieceRef): Piece {
        return this.findPiece(ref)!;
    }

    // A cell "has an enemy" if any piece there belongs to someone other than `player`.
    private hasEnemyPieces(cell: string, player: number): boolean {
        const t = this.cellContents(cell);
        if (t === undefined) {
            return false;
        }
        return t.pieces.some(p => p.owner !== player);
    }

    // Pieces stranded in the void by destroyTerritory/pushTerritory return to their owner's stash; shared by Rods' push and Swords' attack-territory.
    private returnEvictedPieces(voidCells: string[]): void {
        for (const cell of voidCells) {
            for (const piece of [...this.cellContents(cell)!.pieces]) {
                this.returnToStash({ cell, piece });
            }
            this.board.pruneIfEmpty(cell);
        }
    }

    // The cell `dist` spaces from `cell` in the direction a piece faces.
    private cellBeyond(cell: string, facing: Orientation, dist: number): string {
        const [dx, dy] = this.board.delta(facing as DirectionCardinal);
        const [x, y] = xy(cell);
        return GnosticaBoard.coords2algebraic(x + dx * dist, y + dy * dist);
    }

    // Shared legality check for a CELL-level target: the minion's own cell ("U") or the single cell it's pointing at.
    private checkValidCellTarget(minion: Piece, minionCell: string, targetCell: string,): PowerFailure | undefined {
        const [minionX, minionY] = xy(minionCell);
        const [targetX, targetY] = xy(targetCell);
        if (minion.orientation === "U") {
            if (targetX === minionX && targetY === minionY) {
                return undefined;
            }
            return { key: "MUST_TARGET_SELF" };
        }
        const [dx, dy] = this.board.delta(minion.orientation as DirectionCardinal);
        if (targetX === minionX + dx && targetY === minionY + dy) {
            return undefined;
        }
        return { key: "MUST_TARGET_FACING", params: { facing: minion.orientation } };
    }

    // The opening every piece-targeting check shares: the acting piece is the player's own, and the target piece is one it can reach.
    private checkOwnMinionTargetsPiece(
        minionRef: IPieceRef,
        targetRef: IPieceRef,
    ): PowerFailure | undefined {
        const minion = this.getPiece(minionRef);
        const ownErr = checkOwnMinion(minion, this.currplayer);
        if (ownErr) return ownErr;
        return this.checkValidPieceTarget(minion, minionRef, targetRef);
    }

    // The cell-target counterpart of checkOwnMinionTargetsPiece.
    private checkOwnMinionTargetsCell(
        minionRef: IPieceRef,
        targetCell: string,
    ): PowerFailure | undefined {
        const minion = this.getPiece(minionRef);
        const ownErr = checkOwnMinion(minion, this.currplayer);
        if (ownErr) return ownErr;
        return this.checkValidCellTarget(minion, minionRef.cell, targetCell);
    }

    // Same, but for a specific PIECE target - a minion may always target itself regardless of orientation.
    private checkValidPieceTarget(
    minion: Piece, minionRef: IPieceRef,
        targetRef: IPieceRef,
    ): PowerFailure | undefined {
        const isSelf = GnosticaGame.samePiece(targetRef, minionRef);
        if (isSelf) {
            return undefined;
        }
        return this.checkValidCellTarget(minion, minionRef.cell, targetRef.cell);
    }

    // Cups - Create

    private createOwn(targetCell: string, orientation: Orientation): void {
        this.takeFromStash(this.currplayer, 1);
        let t = this.cellContents(targetCell);
        if (t === undefined) {
            t = new CellContents(undefined);
            this.board.set(targetCell, t);
        }
        t.add(new Piece(this.currplayer, 1, orientation));
    }

    private createEnemy(targetRef: IPieceRef): void {
        const t = this.cellContents(targetRef.cell)!;
        const victim = this.getPiece(targetRef);
        this.takeFromStash(victim.owner, 1);
        t.add(new Piece(victim.owner, 1, victim.orientation));
    }

    private createTerritory(targetCell: string, cardUid: string): void {
        this.board.createTerritory(targetCell, takeFromPile(this.hands[this.currplayer - 1], cardUid));
    }

    // Wheel of Fortune's drawn territory: the deck's top card, which nobody may see before the move is committed.
    private createTerritoryFromDeck(targetCell: string): TarotCard {
        this.reshuffle();
        const card = cardByUid(this.drawPile.shift() as string);
        this.board.createTerritory(targetCell, card);
        return card;
    }

    // Move the minion itself, or push a targeted piece, `dist` spaces in the minion's own direction.
    private checkMovePiece(
    minionRef: IPieceRef,
        targetRef: IPieceRef, dist: number,
        opts: PrimitiveOpts & { skipLandingCheck?: boolean } = {},
    ): PowerFailure | undefined {
        const minionErr = this.checkOwnMinionTargetsPiece(minionRef, targetRef);
        if (minionErr) return minionErr;
        const minion = this.getPiece(minionRef);
        if (minion.orientation === "U") {
            return { key: "ROD_NEEDS_FACING" };
        }
        if (dist < 1 || dist > minion.size) {
            return { key: "BAD_DISTANCE", params: { size: minion.size, dist } };
        }
        if (!opts.skipLandingCheck) {
            // Landing in the void is legal here (unlike Hermit's teleport,
            // which forbids it) - it just destroys the piece, same as any
            // other piece that ends up in the void (see returnEvictedPieces).
            const destT = this.cellContents(this.cellBeyond(targetRef.cell, minion.orientation, dist));
            if (destT !== undefined && !destT.canAdd(opts.ignoreCapacity)) {
                return { key: "CELL_FULL" };
            }
        }
        return undefined;
    }

    private movePiece(
    minionRef: IPieceRef,
        targetRef: IPieceRef, dist: number,
        newOrientation: Orientation | undefined, waypoint = false,
    ): void {
        const minion = this.getPiece(minionRef);
        const dest = this.cellBeyond(targetRef.cell, minion.orientation, dist);
        // A genuine final landing in the void destroys the piece. A mid-chain
        // waypoint (Chariot) must NOT - the piece still needs to be sitting
        // there for the chain's next step to act on.
        const inVoid = this.classifyCell(dest) === "void";
        const destroyed = !waypoint && inVoid;
        if (waypoint && inVoid) {
            this.waypointCell = dest;
        } else if (targetRef.cell === this.waypointCell) {
            this.waypointCell = undefined;
        }
        if (destroyed) {
            this.returnToStash(targetRef);
        }
        const moved = destroyed ? undefined : this.cellContents(targetRef.cell)!.removeAt(this.pieceIndex(targetRef));
        // The source never gets a piece back, so an emptied wasteland must not linger in the board's stored map.
        this.board.pruneIfEmpty(targetRef.cell);
        if (moved === undefined) {
            return;
        }
        if (moved.owner === this.currplayer && newOrientation !== undefined) {
            moved.orientation = newOrientation;
        }
        let destT = this.cellContents(dest);
        if (destT === undefined) {
            destT = new CellContents(undefined);
            this.board.set(dest, destT);
        }
        destT.add(moved);
    }

    // Push the territory at the minion-facing (srcX, srcY) `dist` spaces further, same direction; srcX/srcY are caller-supplied so the move string names it.
    private checkMoveTerritory(
    minionRef: IPieceRef,
        srcCell: string, dist: number,
    ): PowerFailure | undefined {
        const minionErr = this.checkOwnMinionTargetsCell(minionRef, srcCell);
        if (minionErr) return minionErr;
        const minion = this.getPiece(minionRef);
        if (minion.orientation === "U") {
            return { key: "ROD_NEEDS_FACING" };
        }
        if (this.classifyCell(srcCell) !== "territory") {
            return { key: "NO_TERRITORY_THAT_WAY" };
        }
        if (this.hasEnemyPieces(srcCell, this.currplayer)) {
            return { key: "CELL_HAS_ENEMY" };
        }
        if (dist < 1 || dist > minion.size) {
            return { key: "BAD_DISTANCE", params: { size: minion.size, dist } };
        }
        const destCell = this.cellBeyond(srcCell, minion.orientation, dist);
        if (destCell === minionRef.cell) {
            return { key: "CANT_PUSH_ONTO_SELF" };
        }
        if (this.classifyCell(destCell) !== "wasteland") {
            return { key: "PUSH_NEEDS_WASTELAND" };
        }
        if (this.hasEnemyPieces(destCell, this.currplayer)) {
            return { key: "DESTINATION_HAS_ENEMY" };
        }
        return undefined;
    }

    private moveTerritory(
    minionRef: IPieceRef,
        srcCell: string, dist: number,
    ): void {
        const minion = this.getPiece(minionRef);
        // Pushing the card out can strand pieces left at the departure cell if nothing else keeps it adjacent to a territory.
        const evictions = this.board.pushTerritory(srcCell, this.cellBeyond(srcCell, minion.orientation, dist));
        this.returnEvictedPieces(evictions);
    }

    // The replacement card comes from wherever it is: the hand, or (Tower/Star) the discards.
    private replacementPile(uid: string): string[] {
        return this.hands[this.currplayer - 1].includes(uid) ? this.hands[this.currplayer - 1] : this.discardPile;
    }

    // Tower/Star may take the replacement from the discards as well as the hand; every other card, from the hand alone.
    private replacementCards(opts: { replacementSource?: "hand" | "discard" }): string[] {
        return opts.replacementSource === "discard" ? [...this.hands[this.currplayer - 1], ...this.discardPile] : this.hands[this.currplayer - 1];
    }

    // Swords - Attack

    private attackPiece(
    targetRef: IPieceRef, pips: number,
        newOrientation: Orientation | undefined,
    ): void {
        const t = this.cellContents(targetRef.cell)!;
        const victim = this.getPiece(targetRef);
        const resultSize = victim.size - pips;
        if (resultSize === 0) {
            this.returnToStash(targetRef);
            this.board.pruneIfEmpty(targetRef.cell);
            return;
        }
        this.stashOf(victim.owner)[resultSize - 1] -= 1;
        const orientation = victim.owner === this.currplayer && newOrientation !== undefined ? newOrientation : victim.orientation;
        this.returnToStash(targetRef);
        t.add(new Piece(victim.owner, resultSize as Pips, orientation));
    }

    private attackTerritory(targetCell: string, pips: number, newCardUid: string | undefined,): void {
        const t = this.cellContents(targetCell)!;
        const current = t.pointValue();
        const oldUid = (t.card as TarotCard).uid;
        const resultValue = current - pips;
        if (resultValue === 0) {
            const evictions = this.board.destroyTerritory(targetCell);
            this.discardPile.push(oldUid);
            this.returnEvictedPieces(evictions);
            return;
        }
        const newCard = takeFromPile(this.replacementPile(newCardUid as string), newCardUid as string);
        this.discardPile.push(oldUid);
        this.board.updateTerritory(targetCell, newCard);
    }

    // Special powers: the major arcana abilities that don't reduce to a suit primitive; chaining a card's own multi-step power list is gnostica.ts's job.

    // The one place any orientation actually gets written - orientMinion, orientAny, and the standalone "orient" command all funnel through here.
    private setPieceOrientation(ref: IPieceRef, newOrientation: Orientation,): void {
        this.getPiece(ref).orientation = newOrientation;
    }

    private hierophantReplace(targetRef: IPieceRef, newOrientation: Orientation,): void {
        const t = this.cellContents(targetRef.cell)!;
        const target = this.getPiece(targetRef);
        this.takeFromStash(this.currplayer, target.size);
        this.returnToStash(targetRef);
        t.add(new Piece(this.currplayer, target.size, newOrientation));
    }

    private hermitMovePiece(
    targetRef: IPieceRef,
        destCell: string, newOrientation: Orientation | undefined,
    ): void {
        const srcT = this.cellContents(targetRef.cell)!;
        const moved = srcT.removeAt(this.pieceIndex(targetRef));
        this.board.pruneIfEmpty(targetRef.cell);
        if (moved.owner === this.currplayer && newOrientation !== undefined) {
            moved.orientation = newOrientation;
        }
        let dt = this.cellContents(destCell);
        if (dt === undefined) {
            dt = new CellContents(undefined);
            this.board.set(destCell, dt);
        }
        dt.add(moved);
    }

    private hermitMoveTerritory(targetCell: string, destCell: string,): void {
        const evictions = this.board.pushTerritory(targetCell, destCell);
        this.returnEvictedPieces(evictions);
    }

    // Returns the target's owner so the caller can double-check it passed the right array.
    private tradeHands(targetRef: IPieceRef, otherHand: string[],): number {
        const target = this.getPiece(targetRef);
        const mine = [...this.hands[this.currplayer - 1]];
        // Each side remembers the cards it handed over, though nobody else saw them.
        for (const [uid, from] of [...mine.map(uid => [uid, this.currplayer] as const), ...otherHand.map(uid => [uid, target.owner] as const)]) {
            this.traded[uid] = [...new Set([...(this.traded[uid] ?? []), from])];
        }
        this.hands[this.currplayer - 1].length = 0;
        this.hands[this.currplayer - 1].push(...otherHand);
        otherHand.length = 0;
        otherHand.push(...mine);
        return target.owner;
    }

    private judgementDraw(cardUids: string[]): void {
        for (const uid of cardUids) {
            const idx = this.discardPile.indexOf(uid);
            this.discardPile.splice(idx, 1);
            this.hands[this.currplayer - 1].push(uid);
            this.drawn.push(uid);
        }
    }

    private discardCards(discardUids: string[]): void {
        for (const uid of discardUids) {
            const idx = this.hands[this.currplayer - 1].indexOf(uid);
            this.hands[this.currplayer - 1].splice(idx, 1);
            this.discardPile.push(uid);
        }
    }

    // Genuinely random, so only ever run once a move is committed; returns the actual count drawn.
    private drawCards(count: number): number {
        let drawn = 0;
        while (drawn < count) {
            this.reshuffle();
            if (this.drawPile.length === 0) {
                break; // nothing left anywhere
            }
            this.hands[this.currplayer - 1].push(this.drawPile.shift() as string);
            drawn++;
        }
        return drawn;
    }

    // The Fool reshuffles the discards into an empty deck, so it can flip as long as either pile holds a card.
    private foolCanFlip(): boolean {
        return this.drawPile.length > 0 || this.discardPile.length > 0;
    }

    // Fool: flip the top draw-pile card straight to discard; dispatching its power is the caller's job (the engine's full per-card dispatcher).
    private fool(): TarotCard {
        this.reshuffle();
        const uid = this.drawPile.shift()!;
        const flipped = cardByUid(uid);
        this.discardPile.push(uid);
        return flipped;
    }

    // World: validates `chosenUid` names a major arcana card on the board (not World itself) and returns its MajorArcanaDef for the engine to dispatch.
    private worldChoosePower(chosenUid: string): MajorArcanaDef {
        return MAJOR_ARCANA[chosenUid];
    }

    // "use <cardUid>" targets a card by its own identity, not a cell.  Cards are unique, so we can derive the cell.
    private findCardCell(uid: string): string | undefined {
        for (const [x, y, t] of this.board.entries()) {
            if (t.card?.uid === uid) {
                return GnosticaBoard.coords2algebraic(x, y);
            }
        }
        return undefined;
    }

    // Returns the card's display name, for messages.  
    private cardNameOrUid(uid: string): string {
        return allCards().find(c => c.uid === uid)!.name;
    }

    // Returns every piece the acting player owns on the activated cell, for the minion pool.
    private piecesOwnedAt(cell: string): IPieceRef[] {
        const t = this.cellContents(cell);
        if (t === undefined) {
            return [];
        }
        return t.pieces
            .map(p => ({ cell, piece: p.clone() }))
            .filter(ref => ref.piece.owner === this.currplayer);
    }

    public eligibleMinionsForActivate(cell: string): IPieceRef[] {
        const t = this.cellContents(cell);
        if (t === undefined || t.card === undefined) {
            return [];
        }
        return this.piecesOwnedAt(cell);
    }

    // Every piece the acting player owns anywhere on the board - the pool "play" draws minions from.
    public eligibleMinionsForPlay(): IPieceRef[] {
        const eligible: IPieceRef[] = [];
        for (const [x, y, t] of this.board.entries()) {
            t.pieces.forEach(p => {
                if (p.owner === this.currplayer) {
                    eligible.push({ cell: GnosticaBoard.coords2algebraic(x, y), piece: p.clone() });
                }
            });
        }
        return eligible;
    }

    // Only ever reached for a FRESH activation - move() resumes this.continued directly instead, before this switch is reached. Legality is validateActivate's own job.
    private cmdActivate(card: string, steps: IStep[], asUid: string | undefined, partial: boolean): PowerOutcome {
        this.results.push({ type: "use", what: card });
        return this.applyPowers(card, steps, asUid, partial);
    }

    // Who may act on a resumed obligation: for a Justice reached by a use, the minions in the territory it was used from (the World's, if it borrowed Justice); otherwise any of the player's.
    private eligibleMinionsForOwed(token: string): IPieceRef[] {
        const [uid, how] = token.split(".");
        if (uid !== "11" || how === "play" || how === "play21") {
            return this.eligibleMinionsForPlay();
        }
        const loc = this.findCardCell(how === "use21" ? "21" : "11");
        return loc === undefined ? [] : this.eligibleMinionsForActivate(loc);
    }

    // Applies a submission's power segments card by card (the head card, a World's borrowed card) straight off the string. `uid` undefined means the revealed card was declined.
    // What it leaves for move() to continue - the Fool used, a High Priestess round, Justice's trade - comes back as the outcome; "stopped" is a preview's unfinished step.
    private applyPowers(uid: string | undefined, allSteps: IStep[], asUid: string | undefined, partial: boolean): PowerOutcome {
        // A skip only names the power left unused; the step that follows it says everything that happens.
        const steps = allSteps.filter(step => step.action !== "skip");
        const chained = steps.length + (asUid !== undefined ? 1 : 0) > 1;
        let counted = 0;
        let at = 0;
        // Where the World's "use" result sits: it changes nothing on the board, so it has no frame and joins the next step's group.
        let worldResult: number | undefined;
        // One step: a snapshot of the board before it, and its results grouped when the submission is chained; false if it didn't complete.
        const count = (apply: () => boolean): boolean => {
            this.frames.push({ board: this.board.clone().store, discardSummary: this.summarizeDiscardPile(this.discardPile) });
            const resultsBefore = worldResult ?? this.results.length;
            worldResult = undefined;
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
        const run = (card: string): PowerOutcome => {
            if (card === "21") {
                // The World's own step takes no segment: the borrowed card is named in the head.
                if (asUid === undefined) {
                    return "stopped";
                }
                this.results.push({ type: "use", what: asUid, count: 21 });
                worldResult = this.results.length - 1;
                return run(asUid);
            }
            if (card === "00") {
                return "fool";
            }
            if (card === "02") {
                // No segment: the round is skipped.
                if (at >= steps.length) {
                    return "done";
                }
                const step = steps[at++];
                return count(() => {
                    this.cmdDiscard(step);
                    return true;
                }) ? "hp" : "stopped";
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
                    return "trade";
                }
            }
            return "done";
        };
        const outcome = uid === undefined ? "done" : run(uid);
        // Frames only matter to a move of 2+ steps; one step's frame is just the current state.
        if (counted < 2) {
            this.frames = [];
        }
        return outcome;
    }

    // Once a committed submission's powers are applied, settles what the turn still owes (Fool flips, a High Priestess round, Justice's attack) from the tokens in this.continued
    // and returns the tokens it leaves. A flip is made here, after the card's own effects, and joins the last result group when the submission was a chain.
    private continueTurn(card: string, allSteps: IStep[], asUid: string | undefined, how: string, outcome: PowerOutcome): string[] {
        const owed = this.continued.filter(t => t !== "last");
        const top = (): string | undefined => owed[owed.length - 1];
        const steps = allSteps[0]?.action === "decline" ? [] : allSteps.filter(step => step.action !== "skip");
        const chained = steps.length + (asUid !== undefined ? 1 : 0) > 1;
        // A flip, or (with nothing to flip) the report that none could be made; either joins the last result group of a chain.
        const flip = (canFlip: boolean): void => {
            const result: APMoveResult = canFlip ? { type: "deckDraw", what: this.fool().uid, from: "fool" } : { type: "deckDraw", from: "fool" };
            const last = this.results[this.results.length - 1];
            if (!chained) {
                this.results.push(result);
            } else if (last?.type === "_group") {
                last.results.push(result);
            } else {
                this.results.push({ type: "_group", who: this.currplayer, results: [result] });
            }
        };
        if (outcome === "fool") {
            const canFlip = this.foolCanFlip();
            flip(canFlip);
            if (canFlip) {
                owed.push("00.1");
                return owed;
            }
        }
        if (outcome === "trade") {
            // How the play was reached decides who may attack: used or played, through the World or not.
            owed.push(`11.${how}`);
            return owed;
        }
        if (outcome === "hp") {
            if (top() !== "02") {
                owed.push("02");
                return owed;
            }
            owed.pop();
        } else if ((card === "02" || card === "11") && top()?.split(".")[0] === card) {
            // A skipped second round, a made Justice attack, or a declined Justice attack.
            owed.pop();
        }
        // A Fool exposed once its revealed card is used or declined flips again by itself; a High Priestess round needs its own submission.
        for (let token = top(); token?.startsWith("00."); token = top()) {
            const flips = Number(token.split(".")[1]);
            if (flips < 2) {
                const canFlip = this.foolCanFlip();
                flip(canFlip);
                if (canFlip) {
                    owed[owed.length - 1] = `00.${flips + 1}`;
                    return owed;
                }
            }
            owed.pop();
        }
        return owed;
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
        if ((step.action === "move" || step.action === "orient") && this.isMinionCellStillNarrowing(minionRef, pool, step.action === "move" ? "R" : undefined)) {
            return false;
        }
        this.applyVerb(() => this.resolvePieceRefTrusted(minionRef, pool), step, step.action === "move" && (next === undefined ? previewWaypoint : next.action === "move"));
        return true;
    }

    // What resumes a persisted Fool or High Priestess obligation: the revealed card used or declined, or the second round.
    private resumePowers(card: string, steps: IStep[], asUid: string | undefined, partial: boolean): PowerOutcome | undefined {
        // A bare resume seed, nothing typed yet, has nothing to apply - except a revealed Fool's flip or a known World borrow, which resolve on their own.
        if (steps.length === 0 && card !== "00" && !(asUid !== undefined && card === "21")) {
            return undefined;
        }
        if (steps[0]?.action === "decline") {
            this.results.push({ type: "announce", payload: ["decline", card] });
            return this.applyPowers(undefined, [], asUid, partial);
        }
        return this.applyPowers(card, steps, asUid, partial);
    }

    private validateActivate(parsed: IParsedMove): IValidationResult {
        const cardUid = parsed.steps[0]?.card;
        if (cardUid === undefined) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.ACTIVATE_UID_REQUIRED") };
        }
        if (allCards().find(c => c.uid === cardUid) === undefined) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: cardUid }) };
        }
        const loc = this.findCardCell(cardUid);
        if (loc === undefined) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CARD_NOT_ON_BOARD", { uid: cardUid }) };
        }
        if (this.eligibleMinionsForActivate(loc).length === 0) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_MINIONS_THERE", { uid: cardUid }) };
        }
        return this.validatePlayedPower(this.resolvePowerPlay(parsed)!);
    }

    // "Play a card from your hand to the discard pile" - same fresh-activation-only note as cmdActivate; legality is validatePlay's own job.
    private cmdPlay(card: string, steps: IStep[], asUid: string | undefined, partial: boolean): PowerOutcome {
        this.discardPlayedCard(card);
        this.results.push({ type: "deckDraw", what: card, from: "hand" });
        return this.applyPowers(card, steps, asUid, partial);
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
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.PLAY_UID_REQUIRED") };
        }
        if (!this.hands[this.currplayer - 1].includes(uid)) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
        }
        const card = allCards().find(c => c.uid === uid);
        if (card === undefined) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid }) };
        }
        // Playing the Fool discards its own card FIRST, which would otherwise let its first flip trivially "succeed" by revealing only itself - checked here, on the REAL pre-play state.
        if (uid === "00" && this.drawPile.length === 0 && this.discardPile.length === 0) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.DRAW_PILE_EMPTY") };
        }
        const play = this.resolvePowerPlay(parsed)!;
        // Validated on a copy that has already played the card, as cmdPlay will leave it.
        return this.scratchForPlay(play).validatePlayedPower(play);
    }

    // Validates what a use, play or resume goes on to do with its card, the same for all three: a fresh minor card is its one suit step, anything else is a walk of its power stack.
    private validatePlayedPower(play: IPowerPlay): IValidationResult {
        if (play.card !== undefined && !play.card.major && !play.resume) {
            return this.validateMinorPower(suitUidOf(play.card), play.card.uid, play.eligible, play.steps);
        }
        return this.validatePowerStack(play.stack, play.steps, play.rootUid, play.asUid, play.asSuit);
    }

    // Mirrors applyMinorPower's own tolerance exactly - skipping, and an incomplete-so-far step, both validate as "fine, nothing to report yet".
    public validateMinorPower(suitUid: MinorSuitUid, cardUid: string, eligible: IPieceRef[], steps: IStep[]): IValidationResult {
        if (steps.some(step => step.action === "skip")) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.SKIP_NOT_ALLOWED") };
        }
        if (steps.length === 0) {
            // #49: a use/play must take its one meaningful step, not skip it outright - still valid, still "in progress" (complete: -1), not an error.
            const msg = this.freshStepMessage(cardUid, 0, eligible);
            return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
        }
        if (steps.length > 1) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "MINOR_ONE_STEP_ONLY" }) };
        }
        const step = steps[0];
        const minionRef = step.withPiece;
        if (minionRef === undefined) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" }) };
        }
        // Same #49 principle as the steps.length===0 case above: a cell chosen but not which minion is ALSO genuinely still incomplete.
        if (this.isMinionCellStillNarrowing(minionRef, eligible, suitUid)) {
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

    private resolveCardDef(cardUid: string): MajorArcanaDef {
        const existing = MAJOR_ARCANA[cardUid];
        if (existing !== undefined) {
            return existing;
        }
        const card = allCards().find(c => c.uid === cardUid);
        if (card === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: cardUid }));
        }
        return { uid: cardUid, name: card.name, seq: -1, powers: [POWERS[GnosticaGame.SUIT_TO_PRIMITIVE[suitUidOf(card)]]] };
    }

    // Whether two refs name the same piece: pieces that look the same in the same cell are interchangeable.
    private static samePiece(a: IPieceRef, b: IPieceRef): boolean {
        return a.cell === b.cell && a.piece.id() === b.piece.id();
    }

    // Applies a step's own outcome.newMinion chaining to `minions`: appends it, first removing the one existing entry it supersedes.
    private static chainMinion(minions: IPieceRef[], outcome: IStepOutcome): IPieceRef[] {
        const stale = outcome.replacesMinion;
        const gone = stale === undefined ? -1 : minions.findIndex(m => GnosticaGame.samePiece(m, stale));
        const base = gone === -1 ? minions : minions.filter((_, i) => i !== gone);
        return outcome.newMinion === undefined ? base : [...base, outcome.newMinion];
    }

    // Pops the top entry off `stack` in place - the ONE place every Decline/skip/exhaustion removes one, so the popped card's own current acting piece can hand off to the entry beneath.
    private static popPower(stack: IPowerProgress[]): void {
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

    // Pops fully-exhausted entries off the top of `stack` - shared cleanup after every step, since a one-power card (World itself) needs to disappear again immediately.
    private static popExhaustedPowers(target: GnosticaGame, stack: IPowerProgress[]): void {
        while (stack.length > 0 && stack[stack.length - 1].nextStepIndex >= target.resolveCardDef(stack[stack.length - 1].cardUid).powers.length) {
            GnosticaGame.popPower(stack);
        }
    }

    // The action a plain power's step is spelled with (create/move/grow, an attack is "shrink", or a special's own verb); undefined for Fool/World/High Priestess/Magician.
    private static powerAction(power: PowerStep): string | undefined {
        if ("primitive" in power) {
            return power.primitive === "attack" ? "shrink" : power.primitive;
        }
        return SPECIAL_STEP_ACTIONS[power.special];
    }

    // Whether a card's first power can be given up for its second, a different one (the move's "skip" segment); same-kind cards gain nothing, since using the second alone is using the first.
    private static canSkipFirstPower(cardDef: MajorArcanaDef): boolean {
        const first = GnosticaGame.powerAction(cardDef.powers[0]);
        const second = cardDef.powers[1] === undefined ? undefined : GnosticaGame.powerAction(cardDef.powers[1]);
        return first !== undefined && second !== undefined && first !== second;
    }

    // Powers are optional, so a card's second power may be used alone: when a typed step is spelled as a LATER power of the entry's card, the powers in
    // between are skipped. Forward-only - a step matching only an earlier power finds no target here and is rejected as the wrong action further on.
    private static skipAheadTarget(cardDef: MajorArcanaDef, from: number, istep: IStep | undefined): number {
        if (istep === undefined || istep.action === "with") {
            return from;
        }
        const current = GnosticaGame.powerAction(cardDef.powers[from]);
        if (current === undefined || current === istep.action) {
            return from;
        }
        for (let j = from + 1; j < cardDef.powers.length; j++) {
            const action = GnosticaGame.powerAction(cardDef.powers[j]);
            if (action === undefined) {
                return from;
            }
            if (action === istep.action) {
                return j;
            }
        }
        return from;
    }

    // Rebuilds the throwaway IPendingMajorPower-shaped view the resume machinery expects, from the minimal persisted this.continued tokens; one entry per token, minions recomputed fresh.
    private buildPendingFromContinued(): IPendingMajorPower | undefined {
        const tokens = this.continued.filter(t => t !== "last");
        if (tokens.length === 0) {
            return undefined;
        }
        const pool = this.eligibleMinionsForPlay();
        // The Fool's token counts its flips done, which is the power the walk resumes at; the others have one power left.
        const stack = tokens.map(token => {
            const [uid, detail] = token.split(".");
            return { cardUid: uid, nextStepIndex: uid === "00" ? Number(detail) : 1, minions: [...this.eligibleMinionsForOwed(token)] } as IPowerProgress;
        });
        if (stack[stack.length - 1].cardUid === "00") {
            const revealed = this.discardPile[this.discardPile.length - 1];
            if (revealed !== undefined) {
                stack.push({ cardUid: revealed, nextStepIndex: 0, minions: [...pool] });
            }
        }
        return { rootCardUid: stack[0].cardUid, stack: stack as [IPowerProgress, ...IPowerProgress[]] };
    }

    // True when `stack`'s top entry's NEXT step is special:"fool" - decides whether a bare 0-segment seed should be left alone or walked straight into the auto-resolving Fool step.
    private topStepIsFool(stack: readonly IPowerProgress[]): boolean {
        const top = stack[stack.length - 1];
        if (top === undefined) {
            return false;
        }
        const step = this.resolveCardDef(top.cardUid).powers[top.nextStepIndex];
        return step !== undefined && "special" in step && step.special === "fool";
    }

    // The stack for a resumed turn is: the persisted Fool/HP obligation(s), plus (via Fool) a fresh entry for the drawn card.
    private resumeQueue(): IPowerProgress[] | undefined {
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

    // Validation walks a power stack where applyPowers walks the string, so the two must agree by hand; Fool's step is checked regardless of the segment cursor `i`, and validation always stops right at a forced-pause step, exactly once.
    private validatePowerSteps(stack: IPowerProgress[], steps: IStep[], rootCardUid: string, asUid?: string, asSuit?: string): IValidationResult {
        let clone: GnosticaGame | undefined;
        let i = 0;
        // True exactly when the entry just popped to expose the current top was a real Decline, not a silently-skipped one; set before "decline" continue, read at the top of the next iteration.
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
        let moonRestoreCell: string | undefined;
        // Set when the last step was only legal thanks to a two-step shortcut's waiver, which its (missing) paired second step would have earned.
        let awaitingPair = false;
        // False right after a power was skipped (a later power of the card used alone), so nothing was there to pass on to it; true once a step is processed.
        let priorTaken = true;
        // Where the previous step of a same-target-shortcut card left the piece it acted on; the next step must act on that same piece.
        let sameTargetWanted: IPieceRef | undefined;
        for (;;) {
            const top = stack[stack.length - 1];
            const poppedViaDecline = justDeclined;
            justDeclined = false;
            if (top === undefined) {
                if (i < steps.length) {
                    return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "TOO_MANY_POWER_STEPS" }) };
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
            const cardDef = this.resolveCardDef(top.cardUid);
            const stepIndex = top.nextStepIndex;
            const step = cardDef.powers[stepIndex];
            const kind = steps[i]?.action === "decline" ? "decline"
                : "special" in step && step.special === "worldUseAny" ? "world"
                : "special" in step && step.special === "fool" ? "fool"
                : "step";
            // The ROOT's own untouched first flip is the one case that stays a hard rejection.
            const isFreshRootFool = kind === "fool" && stack.length === 1 && top.cardUid === rootCardUid && top.nextStepIndex === 0;
            if (kind === "decline") {
                i++;
                GnosticaGame.popPower(stack);
                // Popping can expose an already-exhausted buried entry (e.g. World's own spent one), which a later segment must not be validated against.
                GnosticaGame.popExhaustedPowers(this, stack);
                justDeclined = true;
                continue;
            }
            // Only a plain step reads the segment: a World's own entry consumes none, so its borrowed card's first power is what a leading skip means.
            if (kind === "step" && steps[i]?.action === "skip") {
                if (top.nextStepIndex !== 0 || !GnosticaGame.canSkipFirstPower(cardDef)) {
                    return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.SKIP_NOT_ALLOWED") };
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
                const target = GnosticaGame.skipAheadTarget(cardDef, top.nextStepIndex, steps[i]);
                if (target !== top.nextStepIndex) {
                    top.nextStepIndex = target;
                    priorTaken = false;
                    continue;
                }
            }
            let istep: IStep | undefined;
            let borrowedForStep: string | undefined;
            if (kind === "world") {
                borrowedForStep = asUid; // the borrowed card is named "as <uid>" in the head
            } else if (kind === "fool") {
                // the flip consumes no segment
            } else {
                if (i >= steps.length) {
                    // Nothing more given - a step past the card's own first stays optional and is silently skipped, UNLESS provably impossible right now (no legal target at all).
                    if (this.specialStepHasNoLegalTarget(clone ?? this, step, top.minions)) {
                        const cardName = this.cardNameOrUid(top.cardUid);
                        const key = (step as { special: SpecialPower }).special === "tradeHands"
                            ? "apgames:validation.gnostica.TRADEHANDS_SKIPPED_NO_TARGET"
                            : "apgames:validation.gnostica.HIEROPHANT_SKIPPED_NO_TARGET";
                        // This step being doomed says nothing about whether an EARLIER step's own outcome is still soft - respected here, not overridden by the generic complete:1 fallback.
                        return { valid: true, complete: softComplete ? 0 : 1, message: i18next.t(key, { card: cardName }) };
                    }
                    // An entry's OWN first step (nextStepIndex 0) arriving with nothing supplied is reachable ONLY via World's push (Fool's own push always forcePauses) - #49 forbids a no-op completion here.
                    if (stack.length > 1 && top.nextStepIndex === 0) {
                        const msg = this.freshStepMessage(top.cardUid, top.nextStepIndex, top.minions, asSuit);
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
                    // Entry not exhausted: a further step is still optional, so complete:0.
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
                        return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.MAGICIAN_NEEDS_AS") };
                    }
                }
                istep = steps[i];
                i++;
            }
            if (sameTargetWanted !== undefined && "primitive" in step && istep !== undefined && (istep.complete ?? -1) >= 0) {
                const target = istep.targetPiece === undefined ? undefined : (clone ?? this).resolvePieceRef(istep.targetPiece);
                if (target?.kind !== "ok" || !GnosticaGame.samePiece(target.ref, sameTargetWanted)) {
                    return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.SAME_TARGET_REQUIRED") };
                }
            }
            sameTargetWanted = undefined;
            // Strict rules first: a two-step shortcut's waiver only applies when the card's next step was actually supplied.
            const followed = i < steps.length;
            let paired = followed;
            const takenBefore = priorTaken;
            // The shortcut is only for when both actions HAPPEN to hit the same target: the step is held to the same target only if it was legal solely thanks to its waiver.
            const waiverNeeded = !(followed && "primitive" in step)
                || (clone ?? this).validatePowerStep(step, top.minions, istep, cardDef, stepIndex, cardDef.powers.length, isFreshRootFool, borrowedForStep, false, takenBefore).failed;
            let stepResult = (clone ?? this).validatePowerStep(step, top.minions, istep, cardDef, stepIndex, cardDef.powers.length, isFreshRootFool, borrowedForStep, followed, takenBefore);
            if (stepResult.failed && !followed && stepIndex < cardDef.powers.length - 1) {
                // Legal only WITH the waiver: fine as far as it goes, but the move can't be submitted until the paired second step is added.
                const optimistic = (clone ?? this).validatePowerStep(step, top.minions, istep, cardDef, stepIndex, cardDef.powers.length, isFreshRootFool, borrowedForStep, true, takenBefore);
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
                    if (istep!.withPiece !== undefined && this.isMinionCellStillNarrowing(istep!.withPiece, top.minions, this.stepSuit(step))) {
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
                        ? this.freshStepMessage(top.cardUid, top.nextStepIndex, top.minions, asSuit)
                        : this.powerStepMessageKey(top.cardUid, top.nextStepIndex, top.minions, istep?.withPiece));
                    return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
                }
                // An earlier segment being incomplete means a later one couldn't legitimately exist - defensive, shouldn't fire.
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP" }) };
            }
            // The step's real effect, applied to a throwaway copy that later steps then validate against.
            clone ??= this.scratchClone();
            const outcome = clone.applyPowerStep(step, top.minions, istep, cardDef, stepIndex, cardDef.powers.length, true, borrowedForStep, paired, takenBefore) ?? {};
            if (outcome.forcePause === true) {
                // A forced-pause step can never legally be followed by more segments - the player couldn't have known what to put there (Fool's flip is hidden).
                if (i < steps.length) {
                    return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "STEPS_AFTER_FORCED_PAUSE" }) };
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
            if (cardDef.moonCapacityExemption && "primitive" in step) {
                if (step.primitive === "move" && outcome.movedToCell !== undefined) {
                    const cell = outcome.movedToCell;
                    if ((clone.cellContents(cell)?.pieces.length ?? 0) >= 4) {
                        moonRestoreCell = cell;
                    }
                } else if (step.primitive === "attack" && moonRestoreCell !== undefined) {
                    const destroyed = outcome.destroyedAtCell;
                    if (destroyed !== undefined && destroyed === moonRestoreCell) {
                        moonRestoreCell = undefined;
                    } else {
                        return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.MOON_MUST_RESTORE_CAPACITY") };
                    }
                }
            }
            if (cardDef.sameTargetShortcut && followed && waiverNeeded && "primitive" in step) {
                const produced = outcome.producedPiece ?? outcome.newMinion;
                sameTargetWanted = produced;
            }
            top.minions = GnosticaGame.chainMinion(top.minions, outcome);
            top.nextStepIndex = outcome.consumesRest ? cardDef.powers.length : top.nextStepIndex + 1;
            priorTaken = true;
            if ("special" in step && step.special === "highPriestess" && top.nextStepIndex >= cardDef.powers.length) {
                hpFinalRoundReady = this.forcePauseReadyMessage(top.cardUid, stepIndex);
            }
            hpDrawNotChosen = "special" in step && step.special === "highPriestess" && istep?.amount === undefined;
            softComplete = outcome.softComplete === true;
            mayDrawMore = stepResult.mayAddMore ?? 0;
            if (outcome.pushPower !== undefined) {
                stack.push({ cardUid: outcome.pushPower.cardUid, nextStepIndex: 0, minions: outcome.pushPower.minions });
            }
            GnosticaGame.popExhaustedPowers(this, stack);
        }
    }

    // The shared start of validating a walk of a power stack, fresh or resumed (#49: every entry owes one meaningful step; see validatePowerSteps).
    public validatePowerStack(stack: IPowerProgress[], steps: IStep[], rootCardUid: string, asUid?: string, asSuit?: string): IValidationResult {
        // A World borrow with nothing else typed still has a real step to choose (falls through to the walk); a Magician borrow pushes no entry, so it wants the same fresh-step wording.
        const worldBorrow = asUid !== undefined;
        if (steps.length === 0 && !this.topStepIsFool(stack) && !worldBorrow) {
            const top = stack[stack.length - 1];
            const msg = this.freshStepMessage(top.cardUid, top.nextStepIndex, top.minions, asSuit);
            return { valid: true, complete: -1, message: i18next.t(msg.key, msg.params) };
        }
        return this.validatePowerSteps(stack, steps, rootCardUid, asUid, asSuit);
    }

    // Read-only check of a resume; checks the card a "play" resume names (must be what the last flip left on top of discard), then walks the segments for legality.
    private validateResumePendingPower(parsed: IParsedMove): IValidationResult {
        const play = this.resolvePowerPlay(parsed)!;
        // The card named must be the one the last flip left on top - a decline names it too, since the announcement and the log read it from here.
        if ((parsed.head === "play" || parsed.head === "use" || parsed.head === "decline") && parsed.steps[0]?.card !== undefined && parsed.steps[0].card !== play.stack[play.stack.length - 1].cardUid) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", {reason: "BAD_CARD"}) };
        }
        // Justice's remaining power is its attack, which is Swords.
        if (this.getContinuedUid() === "11" && parsed.head !== "decline" && parsed.asSuit !== "S") {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", {reason: "WRONG_AS_SUIT"}) };
        }
        return this.validatePlayedPower(play);
    }

    // "primitive" steps expect <minionRef> <mode> <args...> (same grammar as minor arcana); "special" steps have their own bespoke shapes. High Priestess alone has no minion reference at all.
    public applyPowerStep(
        step: PowerStep, minions: IPieceRef[], istep: IStep | undefined, def: MajorArcanaDef, stepIndex: number, totalSteps: number, partial: boolean,
        borrowedPower?: string, paired = true, priorTaken = true,
    ): IStepOutcome | undefined {
        if ("special" in step && step.special === "worldUseAny") {
            // The borrowed card is named "as <uid>" in the head, never a step segment - this step takes no minion of its own and just hands off to that card's entry.
            if (borrowedPower === undefined) {
                return undefined;
            }
            const borrowedDef = this.worldChoosePower(borrowedPower);
            this.results.push({ type: "use", what: borrowedPower, count: 21 });
            return { pushPower: { cardUid: borrowedDef.uid, minions } };
        }
        if ("special" in step && step.special === "highPriestess") {
            // Pause only if a LATER sibling step of THIS SAME card depends on this one's outcome.
            return { forcePause: stepIndex + 1 < totalSteps };
        }
        if ("special" in step && step.special === "fool") {
            if (!this.foolCanFlip()) {
                // Nothing to flip: complete.  Validation already rejected the root Fool's own untouched first flip.
                return {};
            }
            // The flip itself happens once the move is committed; unlike High Priestess, EVERY flip forces a pause, regardless of whether Fool has another one left.
            return { forcePause: true };
        }
        const minionRef = istep!.withPiece!;
        if (this.isMinionCellStillNarrowing(minionRef, minions, this.stepSuit(step))) {
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
        if (outcome.shrunkBy !== undefined && outcome.shrunkBy > minion.piece.size) {
            outcome.consumesRest = true;
        }
        return outcome;
    }

    // One verb's effect, read off the step itself; shared by every caller that applies a step. `waypoint`: a Rods landing in the void is left standing for the next step.
    private applyVerb(minion: () => IPieceRef, istep: IStep, waypoint = false): IStepOutcome {
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
            default: { // draw (Judgement): <minionRef> draw <discardUid...>
                const uids = istep.cardList ?? [];
                this.judgementDraw(uids);
                this.results.push({ type: "deckDraw", count: uids.length, from: "discard" });
                // A real (if empty) outcome, is not marked undefined.
                return {};
            }
        }
    }

    // Mirrors applyPowerStep's own "incomplete step, still skipped" tolerance.
    public validatePowerStep(
        step: PowerStep, minions: IPieceRef[], istep: IStep | undefined, def: MajorArcanaDef, stepIndex: number, totalSteps: number,
        isFreshRootFool = false, borrowedPower?: string, paired = true, priorTaken = true,
    ): StepValidation {
        if ("special" in step && step.special === "worldUseAny") {
            if (borrowedPower === undefined) {
                return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "WORLD_BORROW_REQUIRED" }) } };
            }
            const worldResult = this.validateWorldChoosePower(borrowedPower);
            if (!worldResult.valid) {
                return { failed: true, result: worldResult };
            }
            return { failed: false };
        }
        if ("special" in step && step.special === "highPriestess") {
            if (istep !== undefined && istep.action !== "discard") {
                return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP" }) } };
            }
            const hpResult = this.validateDiscard(istep);
            if (!hpResult.valid) {
                return { failed: true, result: hpResult };
            }
            return { failed: false };
        }
        if ("special" in step && step.special === "fool") {
            // The ROOT Fool card's own untouched first flip with nothing to flip stays a hard rejection; anywhere else it completes gracefully, as there is nothing left to reveal.
            if (!this.foolCanFlip() && isFreshRootFool) {
                return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.DRAW_PILE_EMPTY") } };
            }
            return { failed: false };
        }
        const minionRef = istep!.withPiece;
        if (minionRef === undefined) {
            // A bare "/": the step is begun with nothing chosen for it, which leaves the move as complete as it was.
            if (istep!.action === "with") {
                return { failed: false, complete: false };
            }
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" }) } };
        }
        if (this.isMinionCellStillNarrowing(minionRef, minions, this.stepSuit(step))) {
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
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "WRONG_STEP_ACTION" }) } };
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
                const room = judgementDrawRoom(minion.piece.size, this.hands[this.currplayer - 1].length) - taken.length;
                return { failed: false, mayAddMore: room > 0 && this.discardPile.some(uid => !taken.includes(uid)) ? room : undefined };
            }
            default:
                return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "SPECIAL_NOT_FOUND" }) } };
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

    private applySuitPrimitive(minion: () => IPieceRef, step: IStep, waypoint = false): IStepOutcome {
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

    public validateSuitPrimitive(suitUid: MinorSuitUid, minion: IPieceRef, step: IStep, opts: Record<string, unknown>): StepValidation {
        const mode = stepMinorMode(suitUid, step);
        if (mode === undefined) {
            // The step's action doesn't spell this suit's verb (or names no target) - not something a well-formed move for this power can contain.
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "WRONG_STEP_ACTION" }) } };
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
        switch (mode) {
            case "own": {
                // The creation's mandatory initial facing, possibly still carrying a trailing "?" - makes no difference to the piece created, so it's stripped the same way cmdPlace strips its own.
                const cellStr = step.atCell!;
                const orientationToken = step.direction!;
                const targetCell = cellStr;
                const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
                const orientation = orientationStr as Orientation;
                this.createOwn(targetCell, orientation);
                this.addBufferIfWasteland(targetCell);
                this.results.push({ type: "place", where: cellStr, how: "cups-own" });
                const created = this.cellContents(targetCell)!.pieces;
                return { newMinion: { cell: targetCell, piece: created[created.length - 1].clone() }, softComplete: orientationToken.endsWith("?") };
            }
            case "enemy": {
                const cellStr = step.atCell!;
                const victimRef = step.targetPiece!;
                // victimRef is a full piece ref (#106) - validateCups already confirmed it names a piece at this cell, so it is trusted directly.
                const victim = this.resolvePieceRefTrusted(victimRef);
                const victimOwner = victim.piece.owner;
                this.createEnemy(victim);
                this.results.push({ type: "place", where: cellStr, how: "cups-enemy", who: victimOwner });
                return {}; // the new piece belongs to the targeted enemy, not the acting player
            }
            case "new": {
                const cellStr = step.atCell!;
                const cardArg = step.card;
                const targetCell = cellStr;
                // "drawn" is parsed as step.amount === 1 (pickleMove's own sentinel, since step.card must always be a real card uid).
                if (step.amount === 1) {
                    this.hidden.push({ type: "territory", cell: targetCell });
                    return {};
                }
                this.createTerritory(targetCell, cardArg!);
                this.results.push({ type: "place", where: cellStr, how: "territory", what: cardArg! });
                return this.cardValueByUid(cardArg!) === 2 ? { consumesRest: true } : {};
            }
        }
    }

    private validateCups(minion: IPieceRef, mode: CupsMode, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        switch (mode) {
            case "own": {
                // A brand-new minion can't reasonably go unoriented - "U" is a real, always-legal choice, never auto-assigned but always REQUIRED as an explicit fact of creation.
                const cellStr = step.atCell!;
                const targetCell = cellStr;
                // parseMove already guarantees a valid N/E/S/W/U (with or without the "?" marking a seeded default), so there's nothing left to validate about the facing.
                const minionErr = this.checkOwnMinionTargetsCell(minion, targetCell);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                // A minion sitting on an isolated wasteland (not itself a territory)
                // can face a cell that's genuinely void - unlike movePiece, which
                // destroys a piece that lands in the void as a natural consequence of
                // relocating an EXISTING piece, there's no equivalent cleanup for a
                // brand-new piece, so it would otherwise just sit there forever,
                // invisible to every void-eviction path. Reject outright instead,
                // same as the territory case's own wasteland-only restriction.
                if (this.classifyCell(targetCell) === "void") {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.TARGET_IS_VOID") } };
                }
                // The target cell may be a genuinely untouched wasteland (no stored
                // CellContents object at all, since one is only ever created for a cell
                // that already has a card or a piece) - that's zero pieces there, not
                // an error. movePiece/hermitMovePiece already handle an
                // absent destination the same way; this mirrors them.
                const t = this.cellContents(targetCell);
                const pieceCount = t?.pieces.length ?? 0;
                if (!opts.ignoreCapacity && pieceCount >= 3) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CELL_FULL") } };
                }
                if (!opts.skipStashCheck && !this.hasStashAvailable(this.currplayer, 1)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.STASH_EMPTY", { playerNum: this.currplayer, size: 1 }) } };
                }
                return { failed: false };
            }
            case "enemy": {
                const cellStr = step.atCell!;
                const victimRef = step.targetPiece!;
                const targetCell = cellStr;
                // victimRef is a full piece ref (#106), resolved board-wide, but Cups can only act on the SAME cell "at <cell>" already named - a ref elsewhere is rejected as "no victim there".
                const victimResult = this.resolvePieceRef(victimRef);
                if (victimResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(victimResult.kind, victimRef) };
                }
                if (victimResult.ref.cell !== targetCell) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_VICTIM_THERE") } };
                }
                const minionErr = this.checkOwnMinionTargetsCell(minion, victimResult.ref.cell);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                // A void cell can never legitimately have a victim, but check explicitly anyway - creation has no cleanup path for a stranded piece.
                if (this.classifyCell(victimResult.ref.cell) === "void") {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.TARGET_IS_VOID") } };
                }
                const t = this.cellContents(victimResult.ref.cell);
                const victim = this.findPiece(victimResult.ref);
                if (victim === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_VICTIM_THERE" }) } };
                }
                if (victim.owner === this.currplayer) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.MUST_TARGET_ENEMY") } };
                }
                if (!opts.ignoreCapacity && (t?.pieces.length ?? 0) >= 3) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CELL_FULL") } };
                }
                if (!this.hasStashAvailable(victim.owner, 1)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.STASH_EMPTY", { playerNum: victim.owner, size: 1 }) } };
                }
                return { failed: false }; // the new piece belongs to the targeted enemy, not the acting player
            }
            case "new": {
                const cellStr = step.atCell!;
                const cardArg = step.card;
                const targetCell = cellStr;
                // Mirrors applyCups's own "new" case - "drawn" is parsed as step.amount === 1, and only honored when opts.allowRandomDraw is genuinely set for THIS card's step.
                const cardUid = step.amount === 1 && opts.allowRandomDraw ? undefined : cardArg;
                const minionErr = this.checkOwnMinionTargetsCell(minion, targetCell);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                if (this.classifyCell(targetCell) !== "wasteland") {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOT_A_WASTELAND") } };
                }
                if (this.hasEnemyPieces(targetCell, this.currplayer)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CELL_HAS_ENEMY") } };
                }
                if (opts.allowRandomDraw && cardUid === undefined) {
                    if (this.drawPile.length === 0 && this.discardPile.length === 0) {
                        return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.DRAW_PILE_EMPTY") } };
                    }
                    return { failed: false };
                }
                if (cardUid === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CARD_UID_REQUIRED") } };
                }
                if (!this.hands[this.currplayer - 1].includes(cardUid)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid: cardUid }) } };
                }
                const card = allCards().find(c => c.uid === cardUid);
                if (card === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: cardUid }) } };
                }
                // opts.allowRoyalty (the Sun's shortcut): a royalty card may stand in for creating a spot card and then growing it.
                if (cardPointValue(card) !== 1 && !(opts.allowRoyalty && cardPointValue(card) === 2)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.MUST_BE_SPOT_CARD") } };
                }
                return { failed: false };
            }
        }
    }

    // Rods - piece <targetRef> <dist> [orientation] | tile <dist>
    private applyRods(minion: () => IPieceRef, mode: TargetMode, step: IStep, waypoint: boolean): IStepOutcome {
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const dist = step.amount!;
                const orientationStr = step.direction;
                const target = this.resolvePieceRefTrusted(targetRef);
                const newOrientation = orientationStr as Orientation | undefined;
                // Captured before the move mutates the board, to compute where the piece ends up for the log and minion-chaining check.
                const movedOwner = this.getPiece(target).owner;
                const actor = minion();
                const actorPiece = actor.piece;
                const facing = actorPiece.orientation;
                // Named only when it stays put, so the render can ring it; a minion that moves itself is the moved piece.
                const by = GnosticaGame.samePiece(actor, target) ? undefined : this.pieceIdAt(actor.cell, actorPiece);
                const destCell = this.cellBeyond(target.cell, facing, dist);
                // A genuine final landing (not a Chariot-relaxed waypoint) in the void destroys the piece instead of moving it.
                const destroyedInVoid = !waypoint && this.classifyCell(destCell) === "void";
                const origin = target.cell;
                this.movePiece(actor, target, dist, newOrientation, waypoint);
                if (destroyedInVoid) {
                    this.results.push({ type: "move", by, from: origin, to: destCell, what: this.getPipsFromRef(targetRef), how: "rod-void", who: movedOwner });
                    // Still a real removeAt at target's old slot.  replacesMinion is reported even with no newMinion.
                    return { replacesMinion: target };
                }
                const dest = destCell;
                this.results.push({ type: "move", by, from: origin, to: dest, what: this.getPipsFromRef(targetRef), how: "rod-piece", who: movedOwner });
                if (movedOwner === this.currplayer) {
                    const landed = this.cellContents(destCell)!.pieces;
                    const newIndex = landed.length - 1;
                    return { newMinion: { cell: destCell, piece: landed[newIndex].clone() }, replacesMinion: target, softComplete: orientationStr === undefined, movedToCell: destCell };
                }
                const arrived = this.cellContents(destCell)!.pieces;
                return { replacesMinion: target, movedToCell: destCell, producedPiece: { cell: destCell, piece: arrived[arrived.length - 1].clone() } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const dist = step.amount!;
                const srcCell = cellStr;
                const actor = minion();
                const actorPiece = actor.piece;
                this.moveTerritory(actor, srcCell, dist);
                const to = this.cellBeyond(srcCell, actorPiece.orientation, dist);
                this.results.push({ type: "move", by: this.pieceIdAt(actor.cell, actorPiece), from: cellStr, to, how: "rod-tile" });
                return {};
            }
        }
    }

    private validateRods(minion: IPieceRef, mode: TargetMode, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const dist = step.amount!;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const failure = this.checkMovePiece(minion, target, dist, opts);
                if (failure) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${failure.key}`, failure.params) } };
                }
                return { failed: false };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const dist = step.amount!;
                const srcCell = cellStr;
                const failure = this.checkMoveTerritory(minion, srcCell, dist);
                if (failure) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${failure.key}`, failure.params) } };
                }
                return { failed: false };
            }
        }
    }

    // Discs - piece <targetRef> [orientation] | tile <cell> <newCardUid>
    private applyDiscs(mode: TargetMode, step: IStep): IStepOutcome {
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const orientationStr = step.direction;
                const target = this.resolvePieceRefTrusted(targetRef);
                const newOrientation = orientationStr as Orientation | undefined;
                const targetPiece = this.getPiece(target);
                const owner = targetPiece.owner;
                const beforeSize = targetPiece.size;
                const grownSize = (beforeSize + 1) as Pips;
                this.takeFromStash(owner, grownSize);
                const orientation = owner === this.currplayer && newOrientation !== undefined ? newOrientation : targetPiece.orientation;
                const cell = this.cellContents(target.cell)!;
                this.returnToStash(target);
                cell.add(new Piece(owner, grownSize, orientation));
                this.results.push({ type: "convert", what: `size ${beforeSize}`, into: `size ${beforeSize + 1}`, where: target.cell, who: owner });
                if (owner === this.currplayer) {
                    const grown = this.cellContents(target.cell)!.pieces;
                    const newIndex = grown.length - 1;
                    return { newMinion: { cell: target.cell, piece: grown[newIndex].clone() }, replacesMinion: target, softComplete: orientationStr === undefined };
                }
                // Grown into a piece this pool doesn't track (an enemy's) - still a real removeAt at target's old slot, so chainMinion still needs to know.
                const enemyGrown = this.cellContents(target.cell)!.pieces;
                return { replacesMinion: target, producedPiece: { cell: target.cell, piece: enemyGrown[enemyGrown.length - 1].clone() } };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card!;
                const targetCell = cellStr;
                const beforeUid = this.cellContents(targetCell)!.card!.uid;
                const jumpsTwo = this.cardValueByUid(newCardUid) - this.cellContents(targetCell)!.pointValue() === 2;
                const newCard = takeFromPile(this.replacementPile(newCardUid), newCardUid);
                this.discardPile.push(beforeUid);
                this.board.updateTerritory(targetCell, newCard);
                this.results.push({ type: "convert", what: beforeUid, into: newCardUid, where: cellStr });
                return jumpsTwo ? { consumesRest: true } : {};
            }
        }
    }

    private validateDiscs(minion: IPieceRef, mode: TargetMode, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const minionErr = this.checkOwnMinionTargetsPiece(minion, target);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                const targetPiece = this.findPiece(target);
                if (targetPiece === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE") } };
                }
                if (targetPiece.size >= 3) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.ALREADY_MAX_SIZE") } };
                }
                const grownSize = (targetPiece.size + 1) as Pips;
                if (!opts.skipStashCheck && !this.hasStashAvailable(targetPiece.owner, grownSize)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.STASH_EMPTY", { playerNum: targetPiece.owner, size: grownSize }) } };
                }
                return { failed: false };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card!;
                const targetCell = cellStr;
                const minionErr = this.checkOwnMinionTargetsCell(minion, targetCell);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                if (this.hasEnemyPieces(targetCell, this.currplayer)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CELL_HAS_ENEMY") } };
                }
                const t = this.cellContents(targetCell);
                const current = t?.pointValue() ?? 0;
                if (current === 0) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOTHING_TO_GROW") } };
                }
                if (!this.replacementCards(opts).includes(newCardUid)) {
                    return opts.replacementSource === "discard"
                        ? { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NOT_IN_HAND_OR_DISCARD", uid: newCardUid }) } }
                        : { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid: newCardUid }) } };
                }
                const newCard = allCards().find(c => c.uid === newCardUid);
                if (newCard === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: newCardUid }) } };
                }
                const newValue = cardPointValue(newCard);
                const maxDelta = opts.skipLadder ? 2 : 1;
                if (newValue <= current || newValue > current + maxDelta) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.BAD_GROWTH_VALUE", { current, newValue }) } };
                }
                return { failed: false };
            }
        }
    }

    // The value of a card by uid, for recognizing when a one-step shortcut was used.
    private cardValueByUid(uid: string): number {
        return cardPointValue(allCards().find(c => c.uid === uid)!);
    }

    // Death's shortcut lets one shrink stand for both of its swords, so a total larger than what's there is just a wipeout (a 4 acts as a 3).
    private effectiveShrink(amount: number, available: number, opts: Record<string, unknown>): number {
        return opts.bothSwords === true && available > 0 ? Math.min(amount, available) : amount;
    }

    // Swords - piece <targetRef> <pips> [orientation] | tile <cell> <pips> [newCardUid]
    private applySwords(mode: TargetMode, step: IStep): IStepOutcome {
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const orientationStr = step.direction;
                const target = this.resolvePieceRefTrusted(targetRef);
                const newOrientation = orientationStr as Orientation | undefined;
                const targetPiece = this.getPiece(target);
                // Death's one shrink for both swords may exceed what the victim has: the excess is wasted.
                const pips = Math.min(step.amount!, targetPiece.size);
                const owner = targetPiece.owner;
                const beforeSize = targetPiece.size;
                this.attackPiece(target, pips, newOrientation);
                const resultSize = beforeSize - pips;
                const where = target.cell;
                if (resultSize === 0) {
                    this.results.push({ type: "destroy", where, what: this.getPipsFromRef(targetRef), who: owner });
                } else {
                    this.results.push({ type: "convert", what: `size ${beforeSize}`, into: `size ${resultSize}`, where, who: owner });
                }
                if (resultSize > 0 && owner === this.currplayer) {
                    const shrunk = this.cellContents(target.cell)!.pieces;
                    const newIndex = shrunk.length - 1;
                    return { newMinion: { cell: target.cell, piece: shrunk[newIndex].clone() }, replacesMinion: target, softComplete: orientationStr === undefined, shrunkBy: pips };
                }
                // Destroyed outright, or shrunk but not into a piece this pool tracks (an enemy's) - still a real removeAt at target's old slot, so chainMinion still needs to know.
                // Only a true destroy actually frees a slot at this cell - that alone satisfies Moon's capacity-restoration requirement.
                return { replacesMinion: target, destroyedAtCell: resultSize === 0 ? target.cell : undefined, shrunkBy: pips };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card;
                const targetCell = cellStr;
                const beforeUid = this.cellContents(targetCell)!.card!.uid;
                const pips = Math.min(step.amount!, this.cellContents(targetCell)!.pointValue());
                this.attackTerritory(targetCell, pips, newCardUid);
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

    private validateSwords(minion: IPieceRef, mode: TargetMode, step: IStep, opts: Record<string, unknown> = {}): StepValidation {
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const targetPiece = target.piece;
                const pips = this.effectiveShrink(step.amount!, targetPiece.size, opts);
                const minionErr = this.checkOwnMinionTargetsPiece(minion, target);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                const minionPiece = this.getPiece(minion);
                if (pips < 1 || pips > (opts.bothSwords ? minionPiece.size * 2 : minionPiece.size)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.BAD_DAMAGE", { size: minionPiece.size, pips }) } };
                }
                const victim = this.findPiece(target);
                if (victim === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE") } };
                }
                const resultSize = victim.size - pips;
                if (resultSize < 0) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.TOO_FEW_PIPS", { size: victim.size, pips }) } };
                }
                if (resultSize > 0 && !this.hasStashAvailable(victim.owner, resultSize as Pips)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.STASH_EMPTY", { playerNum: victim.owner, size: resultSize }) } };
                }
                return { failed: false };
            }
            case "tile": {
                const cellStr = step.targetCell!;
                const newCardUid = step.card;
                const targetCell = cellStr;
                const pips = this.effectiveShrink(step.amount!, this.cellContents(targetCell)?.pointValue() ?? 0, opts);
                const minionErr = this.checkOwnMinionTargetsCell(minion, targetCell);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                const minionPiece = this.getPiece(minion);
                if (this.hasEnemyPieces(targetCell, this.currplayer)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CELL_HAS_ENEMY") } };
                }
                if (pips < 1 || pips > (opts.bothSwords ? minionPiece.size * 2 : minionPiece.size)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.BAD_DAMAGE", { size: minionPiece.size, pips }) } };
                }
                const t = this.cellContents(targetCell);
                const current = t?.pointValue() ?? 0;
                if (current === 0) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOTHING_TO_ATTACK") } };
                }
                const resultValue = current - pips;
                if (resultValue < 0) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.TOO_FEW_PIPS_TERRITORY", { current, pips }) } };
                }
                if (resultValue === 0) {
                    if (newCardUid !== undefined) {
                        return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.DESTROYED_NEEDS_NO_CARD") } };
                    }
                    return { failed: false };
                }
                if (newCardUid === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.REPLACEMENT_CARD_REQUIRED") } };
                }
                if (!this.replacementCards(opts).includes(newCardUid)) {
                    return opts.replacementSource === "discard"
                        ? { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NOT_IN_HAND_OR_DISCARD", uid: newCardUid }) } }
                        : { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid: newCardUid }) } };
                }
                const newCard = allCards().find(c => c.uid === newCardUid);
                if (newCard === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: newCardUid }) } };
                }
                const newValue = cardPointValue(newCard);
                if (newValue !== resultValue) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.BAD_SHRINK_VALUE", { current, newValue, pips }) } };
                }
                return { failed: false };
            }
        }
    }

    // orientMinion ("orient <ref> <facing>") turns the minion itself; orientAny (Devil, "with <ref> orient <target> <facing>") turns any piece. Same write either way.
    private applyOrient(minion: () => IPieceRef, step: IStep): IStepOutcome {
        const orientation = step.direction! as Orientation;
        const own = step.targetPiece === undefined || step.targetPiece.toLowerCase() === step.withPiece?.toLowerCase();
        const target = own ? minion() : this.resolvePieceRefTrusted(step.targetPiece!);
        const owner = this.getPiece(target).owner;
        this.setPieceOrientation(target, orientation);
        this.addBufferIfWasteland(target.cell);
        this.pushOrientResult(target, own ? this.pieceRefStr(target) : step.targetPiece!, orientation);
        const turned = target.piece.clone();
        turned.orientation = orientation;
        return own || owner === this.currplayer ? { newMinion: { cell: target.cell, piece: turned }, replacesMinion: target } : {};
    }

    public validateOrientMinion(minion: IPieceRef, step: IStep): StepValidation {
        // parseMove already rejects a non-single-letter direction for the standalone "orient" action (AMBIGUOUS_DIRECTION), so this is always a real N/E/S/W/U by now.
        const orientation = step.direction! as Orientation;
        const ownErr = checkOwnMinion(minion.piece, this.currplayer);
        if (ownErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${ownErr.key}`, ownErr.params) } };
        // Same hard rejection as the standalone "orient" command's own ORIENT_NO_OP - reorienting IS the whole action here too, so a no-op achieves nothing.
        const currentPiece = minion.piece;
        
        if (currentPiece.orientation === orientation) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.ORIENT_NO_OP") } };
        }
        return { failed: false };
    }

    public validateOrientAny(minion: IPieceRef, step: IStep): StepValidation {
        const targetRef = step.targetPiece!;
        const orientationStr = step.direction!;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
        // parseMove already rejects a non-single-letter direction for the standalone "orient" action (AMBIGUOUS_DIRECTION), so this is always a real N/E/S/W/U by now.
        const orientation = orientationStr as Orientation;
        const minionErr = this.checkOwnMinionTargetsPiece(minion, target);
        if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
        if (this.findPiece(target) === undefined) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE") } };
        }
        // reorienting the target IS the whole action here too, so a no-op is hard-rejected.
        const currentPiece = target.piece;

        if (currentPiece.orientation === orientation) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.ORIENT_NO_OP") } };
        }
        return { failed: false };
    }

    // Hierophant: <minionRef> <targetPieceRef> <seededFacing>["?"] [<reorientation>]
    private applyHierophantReplace(step: IStep): IStepOutcome {
        const targetRef = step.targetPiece!;
        const orientationToken = step.direction!;
        const target = this.resolvePieceRefTrusted(targetRef);
        // Captured before the replace mutates the board - the previous owner being displaced, for the result log.
        const previousOwner = this.getPiece(target).owner;
        const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
        const orientation = orientationStr as Orientation;
        this.hierophantReplace(target, orientation);
        this.addBufferIfWasteland(target.cell);
        this.results.push({ type: "convert", what: this.getPipsFromRef(targetRef), into: `owner-${this.currplayer}`, where: target.cell, who: previousOwner });
        const replaced = this.cellContents(target.cell)!.pieces;
        const newIndex = replaced.length - 1;
        return { newMinion: { cell: target.cell, piece: replaced[newIndex].clone() }, replacesMinion: target, softComplete: orientationToken.endsWith("?") };
    }

    // Orientation is mandatory but without a no-op check. The default is the captured piece's prior orientation.
    public validateHierophantReplace(minion: IPieceRef, step: IStep): StepValidation {
        const targetRef = step.targetPiece!;
        const orientationToken = step.direction;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
        if (orientationToken === undefined) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationToken }) } };
        }
        // parseMove already guarantees a valid N/E/S/W/U (with or without a "?" marking the click handler's seeded default), so there's nothing left to validate about the facing.
        const minionErr = this.checkOwnMinionTargetsPiece(minion, target);
        if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
        const targetPiece = this.findPiece(target);
        if (targetPiece === undefined) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE") } };
        }
        // Replacing your own piece with another of your own is a no-op forbidden by the "meaningful step" rule (#49); skipping the step stays legal.
        if (targetPiece.owner === this.currplayer) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.HIEROPHANT_MUST_TARGET_ENEMY") } };
        }
        if (!this.hasStashAvailable(this.currplayer, targetPiece.size)) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.STASH_EMPTY", { playerNum: this.currplayer, size: targetPiece.size }) } };
        }
        return { failed: false };
    }

    // Hermit - <minionRef> fly <targetPieceRef> to <destCell> [orient <direction>] | <minionRef> fly <cardUid> to <destCell>
    private applyHermitStep(step: IStep): IStepOutcome {
        const mode = stepHermitMode(step)!;
        const destCellStr = step.targetCell!;
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const target = this.resolvePieceRefTrusted(targetRef);
                const owner = this.getPiece(target).owner;
                const destCell = destCellStr;
                const newOrientation = step.direction as Orientation | undefined;
                const origin = target.cell;
                this.hermitMovePiece(target, destCell, newOrientation);
                this.results.push({ type: "move", from: origin, to: destCellStr, what: this.getPipsFromRef(targetRef), how: "hermit-piece", who: owner });
                if (owner === this.currplayer) {
                    const landed = this.cellContents(destCell)!.pieces;
                    return { newMinion: { cell: destCell, piece: landed[landed.length - 1].clone() }, replacesMinion: target };
                }
                return { replacesMinion: target };
            }
            case "tile": {
                const targetCell = this.resolveTileCard(step.card)!;
                const destCell = destCellStr;
                this.hermitMoveTerritory(targetCell, destCell);
                this.results.push({ type: "move", from: targetCell, to: destCellStr, how: "hermit-tile" });
                return {};
            }
        }
    }

    public validateHermitStep(minion: IPieceRef, step: IStep): StepValidation {
        const mode = stepHermitMode(step)!;
        const destCellStr = step.targetCell!;
        const destCell = destCellStr;
        switch (mode) {
            case "piece": {
                const targetRef = step.targetPiece!;
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                // parseMove now rejects a non-single-letter direction here too (AMBIGUOUS_DIRECTION), so step.direction is always a real N/E/S/W/U (or absent) by now.
                const minionErr = this.checkOwnMinionTargetsPiece(minion, target);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                if (this.classifyCell(destCell) === "void") {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CANT_END_IN_VOID") } };
                }
                const destT = this.cellContents(destCell);
                if (destT !== undefined && destT.pieces.length > 0) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.HERMIT_NEEDS_EMPTY") } };
                }
                return { failed: false };
            }
            case "tile": {
                const targetCoords = this.resolveTileCard(step.card);
                if (targetCoords === undefined) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_SUCH_TILE", { card: step.card }) } };
                }
                const targetCell = targetCoords;
                const minionErr = this.checkOwnMinionTargetsCell(minion, targetCell);
                if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
                if (this.hasEnemyPieces(targetCell, this.currplayer)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.CELL_HAS_ENEMY") } };
                }
                if (this.classifyCell(destCell) !== "wasteland") {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.PUSH_NEEDS_WASTELAND") } };
                }
                if (this.hasEnemyPieces(destCell, this.currplayer)) {
                    return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.DESTINATION_HAS_ENEMY") } };
                }
                return { failed: false };
            }
        }
    }

    // Justice / Hanged Man: <minionRef> <targetPieceRef> - swaps hands, but only once the move is committed: the other player's hand is hidden from a preview.
    private applyTradeHands(step: IStep): IStepOutcome {
        const targetRef = step.targetPiece!;
        const target = this.resolvePieceRefTrusted(targetRef);
        this.hidden.push({ type: "trade", target });
        return {};
    }

    public validateTradeHands(minion: IPieceRef, step: IStep): StepValidation {
        const targetRef = step.targetPiece!;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
        const minionErr = this.checkOwnMinionTargetsPiece(minion, target);
        if (minionErr) return { failed: true, result: { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${minionErr.key}`, minionErr.params) } };
        const targetPiece = this.findPiece(target);
        if (targetPiece === undefined) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE") } };
        }
        // Swapping hands with yourself is a no-op forbidden by the "meaningful step" rule (#49); skipping the step stays legal.
        if (targetPiece.owner === this.currplayer) {
            return { failed: true, result: { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.TRADEHANDS_MUST_TARGET_ENEMY") } };
        }
        return { failed: false };
    }

    public validateJudgementDraw(minion: IPieceRef, step: IStep): IValidationResult {
        const uids = step.cardList ?? [];
        const ownErr = checkOwnMinion(minion.piece, this.currplayer);
        if (ownErr) return { valid: false, complete: -1, message: i18next.t(`apgames:validation.gnostica.${ownErr.key}`, ownErr.params) };
        const maxDraw = judgementDrawRoom(minion.piece.size, this.hands[this.currplayer - 1].length);
        if (uids.length > maxDraw) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.TOO_MANY_TO_DRAW", { maxDraw, requested: uids.length }) };
        }
        const seen = new Set<string>();
        for (const uid of uids) {
            if (seen.has(uid)) {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "DUPLICATE_CARD", uid }) };
            }
            seen.add(uid);
            if (!this.discardPile.includes(uid)) {
                return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NOT_IN_DISCARD", uid }) };
            }
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // World: <chosenUid> - the minionRef itself is already stripped/resolved by applyPowerStep's own pre-switch logic, same as every other special.
    private validateWorldChoosePower(chosenUid: string): IValidationResult {
        if (chosenUid === "21") {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.WORLD_SELF_REFERENCE") };
        }
        const present = [...this.board.entries()].some(([, , t]) =>
            t.card !== undefined && t.card.major && t.card.uid === chosenUid);
        if (!present) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.NO_SUCH_MAJOR_ON_BOARD", { uid: chosenUid }) };
        }
        if (MAJOR_ARCANA[chosenUid] === undefined) {
            return { valid: false, complete: -1, message: i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: chosenUid }) };
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // Turn order / scoring / win-elimination.  Player always rotates, even on the move that just ended the game.
    private nextPlayer(): void {
        const order = this.variants.includes("bidding")
            ? this.turnOrder
            : [...Array(this.numplayers)].map((_, i) => (i + 1) as playerid);
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

    private static cardKeyUid(piece: string): string | undefined {
        return /^c[^_]+$/.test(piece) ? piece.slice(1) : undefined;
    }

    // Sort cards by their index in allCards.
    private static handSortKey(uid: string): number {
        const card = allCards().find(c => c.uid === uid);
        return card === undefined ? 100 : allCards().indexOf(card);
    }

    // Cards drawn at the end of their last turn, for highlighting by render() - only non-empty for the CURRENT player, and only until they've started building THIS turn's move.
    private newHandCardUids(player: playerid): Set<string> {
        if (player !== this.currplayer || this.preview?.head !== undefined) {
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
        for (const [x, y, t] of this.board.entries()) {
            const cell = GnosticaBoard.coords2algebraic(x, y);
            for (const piece of t.pieces.filter(p => p.owner === player)) {
                this.returnToStash({ cell, piece });
            }
            this.board.pruneIfEmpty(cell);
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
        // Destroying the last territory leaves nothing to play on, whatever pieces are stranded in the wasteland.
        if (![...this.board.entries()].some(([, , t]) => t.card !== undefined)) {
            this.gameover = true;
            this.winner = [];
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
        const displays = this.resolveActiveDisplays(opts);

        // A chain wraps each step's results into a _group entry; whatever else the move did (a "use", a declaration) goes with the last rep.
        const groups = this.results.filter((r): r is Extract<APMoveResult, { type: "_group" }> => r.type === "_group");
        const ungrouped = this.results.filter(r => r.type !== "_group");

        const discardLabel = this.neutralAreaLabel("apgames:validation.gnostica.LABEL_DISCARDS");
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
            const pieceRows = this.buildPieceRows(board, { minX, maxX, minY, maxY }, legend, last ? new Map([...rings, ...(this.preview?.rings ?? [])]) : rings, this.destroyedCells(results));
            const markers = this.buildTerritoryMarkers(board, { minX, minY }, displays, legend, faces);

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
                    displays,
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
                        GnosticaGame.setCardFace(legend, faces, key, `full|${isNew}`, () => this.buildCardFace(displays, card, false, 0, isNew ? { background: MUTED_FILL } : {}));
                        handKeys.push(key);
                    }
                    areas.push({
                        type: "pieces",
                        pieces: handKeys as [string, ...string[]],
                        label: this.seatAreaLabel(p, "apgames:validation.gnostica.LABEL_HAND", { playerNum: p, declared: this.lastTurner === p ? "(declarer)" : "" }),
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
                        GnosticaGame.setCardFace(legend, faces, key, "full|false", () => this.buildCardFace(displays, card, false));
                        poolKeys.push(key);
                    }
                    areas.push({
                        type: "pieces",
                        pieces: poolKeys as [string, ...string[]],
                        label: this.neutralAreaLabel("apgames:validation.gnostica.LABEL_BIDDING_POOL"),
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
                        label: this.neutralAreaLabel("apgames:validation.gnostica.LABEL_WARNING"),
                        spacing: 0.25,
                        width: 1,
                    });
                }

                // The literal drawPile array isn't used for the draw-pile summary - "what's left to draw" is computed by elimination: every card in the full deck not visible somewhere else.
                const drawArea = this.buildAreaFromSummary(
                    displays,
                    this.summarizeDiscardPile(this.unseenCardUids()), legend, faces, this.neutralAreaLabel("apgames:validation.gnostica.LABEL_DECK")
                );
                if (drawArea !== undefined) {
                    areas.push(drawArea);
                }
                // The discard pile is always face-up/public, unlike hands or the draw pile, so its contents are read directly.
                const discardArea = this.buildAreaFromSummary(
                    displays,
                    this.summarizeDiscardPile(this.discardPile), legend, faces, discardLabel, new Set(this.discarded)
                );
                if (discardArea !== undefined) {
                    areas.push(discardArea);
                }

                // Shown whenever it has real content: a bidding game always has turn order to show (any player count - even at 2 players,
                // "you, then them" is still worth confirming once icon rows can share the same key), and any game can have icon rows once a
                // card is actively mid-build this turn, bidding or not.
                const list: AreaKey["list"] = [];
                if (this.variants.includes("bidding")) {
                    this.turnOrder.forEach((p, place) => {
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
                    for (const mark of this.cardMarks(displays, activeCard)) {
                        // Keys end up as literal DOM ids, so a uid's "+" or "?" can't appear in one.
                        const key = `activecard_${[...mark].map(c => c.charCodeAt(0).toString(16)).join("_")}`;
                        if (!(key in legend)) {
                            // Circle-backed, matching every other place these icons appear (buildCardFace's own pushCircle) - a bare
                            // icon glyph alone reads too thin/low-contrast next to the turn-order rows' own solid pyramids.
                            legend[key] = displays.includes("letters")
                                ? [this.markText(mark, 0.6)]
                                : displays.includes("icons")
                                    ? [{ name: mark, scale: 0.8 }]
                                    : [{ name: "piece", colour: "_context_board" }, { name: mark, scale: 0.5 }];
                        }
                        list.push({ piece: key, name: "" });
                    }
                }
                if (list.length > 0) {
                    // "left", not "right" - the action button bar already owns the right side, and the two don't stack cleanly on the same side.
                    areas.push({ type: "key", list, position: "left", height: 0.4, clickable: false });
                }

                // The top-level turn choice as buttons rather than inferring intent from board clicks alone.
                const actionButtons = this.preview?.rejected ? [{ label: "Undo", value: "undo" }] as [ButtonBarButton] : this.withInertUnavailable(this.withUndo(this.getActionButtons()));
                for (const button of actionButtons ?? []) {
                    if (button.glyph?.startsWith("buttonpiece_") && !(button.glyph in legend)) {
                        legend[button.glyph] = this.pyramidGlyph(Piece.deserialize(button.glyph.slice("buttonpiece_".length)));
                    } else if (button.glyph?.startsWith("buttonsuit_") && !(button.glyph in legend)) {
                        legend[button.glyph] = { name: suits.find(suit => suit.uid === button.glyph!.slice("buttonsuit_".length))!.glyph! };
                    } else if (button.glyph?.startsWith("buttonpower_") && !(button.glyph in legend)) {
                        legend[button.glyph] = { name: POWERS[button.glyph.slice("buttonpower_".length) as SpecialPower].icon };
                    }
                }
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
                // A created piece is ringed instead; only a created territory outlines its cell.
                if (r.type === "place" && r.where !== undefined && r.how === "territory") {
                    const [x, y] = GnosticaBoard.algebraic2coords(r.where);
                    annotations.push({ type: "enter", targets: [{ row: y - minY, col: x - minX }] });
                } else if (r.type === "move" && r.from !== undefined && r.to !== undefined) {
                    const [fx, fy] = GnosticaBoard.algebraic2coords(r.from);
                    const [tx, ty] = GnosticaBoard.algebraic2coords(r.to);
                    // A push into the void ends outside the window, so its arrow stops at the edge.
                    const end = { row: Math.min(Math.max(ty - minY, 0), height - 1), col: Math.min(Math.max(tx - minX, 0), width - 1) };
                    annotations.push({ type: "move", targets: [{ row: fy - minY, col: fx - minX }, end] });
                }
            }
            if (last) {
                for (const cell of [...this.worldPickCells(), ...(this.preview?.pickCells ?? [])]) {
                    const [x, y] = cell.split(",").map(Number);
                    annotations.push({ type: "enter", targets: [{ row: y - minY, col: x - minX }] });
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

    // The abbreviation FrameState.discardSummary itself stores: majors by uid, minors by suit and spot/royal count.
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

    // Summary code because draw/discard piles can be large. Minors summarize as one token per (suit, spot-or-royalty) bucket with a count; majors are shown individually. `newUids` are shaded as just added.
    private buildAreaFromSummary(
        displays: string[], summary: DiscardSummary, legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, faces: Map<string, string>, label: StructuredRenderLabel,
        newUids: Set<string> = new Set(),
    ): AreaPieces | undefined {
        const newBuckets = new Set<string>();
        for (const uid of newUids) {
            const card = allCards().find(c => c.uid === uid);
            if (card !== undefined && !card.major) {
                newBuckets.add(`${card.suit.uid}_${card.court ? "royal" : "spot"}`);
            }
        }
        const pieces: string[] = [];
        for (const suit of suits) {
            for (const category of ["spot", "royal"] as const) {
                const bucket = `${suit.uid}_${category}`;
                const count = summary.counts.get(bucket);
                if (count === undefined) {
                    continue;
                }
                // A representative rank uses the usual card layout; only the background and the rank-corner text (a count, not a real rank) are overridden.
                const representativeRank = ranks.find(r => r.court === (category === "royal"))!;
                const representative = new Card({ name: `${representativeRank.name} of ${suit.name}`, rank: representativeRank, suit, major: false });
                const key = `${bucket}_${count}${newBuckets.has(bucket) ? "_shaded" : ""}`;
                if (!(key in legend)) {
                    legend[key] = this.buildCardFace(displays, representative, false, 0, {
                        borderless: true,
                        rankText: `${count}x`,
                        ...(newBuckets.has(bucket) ? { background: MUTED_FILL } : {}),
                    }) as [Glyph, ...Glyph[]];
                }
                pieces.push(key);
            }
        }
        for (const uid of summary.majorUids.sort()) {
            const isNew = newUids.has(uid);
            const key = GnosticaGame.cardKey(uid);
            GnosticaGame.setCardFace(legend, faces, key, `full|${isNew}`, () => this.buildCardFace(displays, allCards().find(c => c.uid === uid)!, false, 0, isNew ? { background: MUTED_FILL } : {}));
            pieces.push(key);
        }
        if (pieces.length === 0) {
            return undefined;
        }
        // Tighter and wider than the default auto-wrap; there's no more than ~30 distinct tokens (8 buckets + 22 majors) to display.
        return { type: "pieces", pieces: pieces as [string, ...string[]], label, spacing: 0.25, width: 10 };
    }

    // "<cell>.<piece id>": names a piece in a result well enough to find it again on the finished board.
    private pieceIdAt(cell: string, piece: Piece): string {
        return `${cell}.${piece.id()}`;
    }

    // The pieces a move's results name, ringed like the live preview does: each target solid, and a Rods move's own minion dashed.
    private ringsFromResults(results: APMoveResult[], board: GnosticaBoard): Map<string, "minion" | "target"> {
        const rings = new Map<string, "minion" | "target">();
        // The last match, since a piece that moved or changed hands is added to the end of its cell.
        const ring = (cell: string, kind: "minion" | "target", match: (p: Piece) => boolean) => {
            const i = (board.get(cell)?.pieces ?? []).map(match).lastIndexOf(true);
            const key = `${cell},${i}`;
            if (i >= 0 && (kind === "target" || !rings.has(key))) {
                rings.set(key, kind);
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
                case "place":
                    // A new piece joins the end of its cell.
                    if (r.where !== undefined && r.how !== "territory") {
                        ring(r.where, "target", () => true);
                    }
                    break;
            }
        }
        return rings;
    }

    // The cells a move destroyed a piece in: a Swords destroy names the cell, and a Rods push into the void the cell the piece left.
    private destroyedCells(results: APMoveResult[]): Set<string> {
        const cells = new Set<string>();
        for (const r of results) {
            const cell = r.type === "destroy" && r.who !== undefined ? r.where : r.type === "move" && r.how === "rod-void" ? r.from : undefined;
            if (cell !== undefined) {
                const [x, y] = GnosticaBoard.algebraic2coords(cell);
                cells.add(`${x},${y}`);
            }
        }
        return cells;
    }

    // After "Use Territory" and before one is chosen, the territories the player has a minion on.
    private usePickCells(parsed: IParsedMove): Set<string> {
        const cells = new Set<string>();
        if (parsed.head?.toLowerCase() !== "use" || parsed.steps[0]?.card !== undefined) {
            return cells;
        }
        for (const [x, y] of this.board.entries()) {
            if (this.eligibleMinionsForActivate(GnosticaBoard.coords2algebraic(x, y)).length > 0) {
                cells.add(`${x},${y}`);
            }
        }
        return cells;
    }

    // While the World's borrowed card is still to be picked, the major arcana territories it may borrow from (every one on the board but the World itself).
    private worldPickCells(): Set<string> {
        const pending = this.computePendingMinor();
        const cells = new Set<string>();
        if (pending?.special !== "worldUseAny" || pending.asUid !== undefined) {
            return cells;
        }
        for (const [x, y, t] of this.board.entries()) {
            if (t.card?.major === true && t.card.uid !== "21") {
                cells.add(`${x},${y}`);
            }
        }
        return cells;
    }

    // The pieces to ring in a live preview: the step's minion (or every candidate while it's still ambiguous which one is meant), and the target piece once picked, which wins on a self-target.
    private previewRings(parsed: IParsedMove, pending: IPendingStep | undefined): Map<string, "minion" | "target"> {
        const rings = new Map<string, "minion" | "target">();
        const ringIfThere = (m: IPieceRef, kind: "minion" | "target") => {
            const onBoard = this.findPiece(m);
            if (onBoard !== undefined && (m.piece === undefined || m.piece.id() === onBoard.id())) {
                rings.set(`${m.cell},${this.pieceIndex(m)}`, kind);
            }
        };
        if (parsed.head?.toLowerCase() === "orient") {
            const chosen = parsed.steps[0]?.targetPiece;
            if (chosen === undefined) {
                // Orient can turn any of the player's pieces, wherever they stand.
                for (const [x, y] of this.board.entries()) {
                    this.piecesOwnedAt(GnosticaBoard.coords2algebraic(x, y)).forEach(m => ringIfThere(m, "minion"));
                }
            } else if (parsed.steps[0].direction === undefined) {
                // A bare cell holding several of the player's pieces hasn't picked one yet.
                const resolved = this.resolvePieceRef(chosen);
                if (resolved.kind === "ok" && (chosen.includes(".") || !this.resolveStepMinion(undefined, this.piecesOwnedAt(chosen)).ambiguous)) {
                    ringIfThere(resolved.ref, "target");
                }
            }
            return rings;
        }
        // A step that destroyed the last minion leaves nothing to ring.
        if (pending === undefined || pending.minions.length === 0) {
            return rings;
        }
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
    private buildTerritoryMarkers(
        board: GnosticaBoard, win: { minX: number; minY: number }, displays: string[],
        legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, faces: Map<string, string>,
    ): (MarkerOutline | MarkerGlyph)[] {
        const pointAt = (x: number, y: number) => ({ row: y - win.minY, col: x - win.minX });
        const markers: (MarkerOutline | MarkerGlyph)[] = [];
        const wastelands = new Map<string, { row: number; col: number }>();
        for (const [x, y, t] of board.entries()) {
            if (t.card === undefined) {
                continue;
            }
            const key = GnosticaGame.cardKey(t.cardUid!);
            const players = t.playersPresent();
            const owner = players.size === 1 ? [...players][0] : 0;
            const dontSpace = displays.includes("larger-cards") && players.size === 0;
            if (t.cardUid !== UNREVEALED_UID) {
                GnosticaGame.setCardFace(legend, faces, key, `board|${!dontSpace}|${owner}`, () => GnosticaGame.markerStack(this.buildCardFace(displays, t.card!, !dontSpace, owner)));
            }
            markers.push({ type: "glyph", glyph: key, points: [pointAt(x, y)] });
            // A wasteland is any card-free cell beside a card.
            for (const [nx, ny] of board.neighbors(x, y)) {
                if (board.get(GnosticaBoard.coords2algebraic(nx, ny))?.card === undefined) {
                    wastelands.set(`${nx},${ny}`, pointAt(nx, ny));
                }
            }
        }
        if (wastelands.size > 0) {
            // Same transparent-by-default convention as buildCardFace's own backdrop, so the theme's board colour shows through here too.
            legend.waste = GnosticaGame.markerStack([{ name: "piece-square-dashed", scale: 1, opacity: 0 }]);
            markers.push({ type: "glyph", glyph: "waste", points: [...wastelands.values()] as [{ row: number; col: number }, ...{ row: number; col: number }[]] });
        }
        return markers;
    }

    private buildPieceRows(
        board: GnosticaBoard, win: { minX: number; maxX: number; minY: number; maxY: number },
        legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] },
        rings?: Map<string, "minion" | "target">,
        destroyed: Set<string> = new Set(),
    ): string[][][] {
        const pieceRows: string[][][] = Array.from({ length: win.maxY - win.minY + 1 }, () => Array.from({ length: win.maxX - win.minX + 1 }, () => []));
        // Only cells that hold pieces matter here, and all of those are stored.
        for (const [x, y, t] of board.entries()) {
            const slots = this.pieceGridSlots(t.pieces);
            const cell = GnosticaBoard.coords2algebraic(x, y);
            const keys = pieceRows[y - win.minY][x - win.minX];
            t.pieces.forEach((piece, i) => {
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
                const ring = rings?.get(`${cell},${i}`);
                if (ring !== undefined) {
                    const ringKey = `ring_${ring}_${key}`;
                    if (!(ringKey in legend)) {
                        // A target is a red dashed ring and a minion a black one; a flat pyramid's centroid lies `drop` below its glyph's centre, so the ring takes the pyramid's rotation to share that nudge.
                        const drop = piece.orientation === "U" ? 0 : [46.3, 63.7, 81][piece.size - 1];
                        legend[ringKey] = GnosticaGame.withBackdrop([{
                            name: "piece-dashed", rotate: g.rotate, scale: slot.scale,
                            paint: ring === "target" ? { fill: { opacity: 0 }, border: "#d00" } : { fill: { opacity: 0 } },
                            nudge: { dx: slot.dx, dy: slot.dy + drop },
                        }], 1);
                    }
                    keys.push(ringKey);
                }
                keys.push(key);
            });
        }
        for (const cell of destroyed) {
            const [x, y] = cell.split(",").map(Number);
            if (x < win.minX || x > win.maxX || y < win.minY || y > win.maxY) {
                continue;
            }
            // The mark takes the slot an upright piece would get, so it sits at the centre of an empty cell and in a free slot otherwise.
            const mark = this.pieceGridSlots([...(board.get(GnosticaBoard.coords2algebraic(x, y))?.pieces ?? []), new Piece(0, 1, "U")]).at(-1)!;
            const markKey = `destroyed_${Math.round(mark.dx)}_${Math.round(mark.dy)}_${Math.round(mark.scale * 100)}`;
            legend[markKey] ??= GnosticaGame.withBackdrop([{ text: "\u2718", scale: mark.scale, colour: "#d00", orientation: "vertical", nudge: { dx: mark.dx, dy: mark.dy } }], 1);
            pieceRows[y - win.minY][x - win.minX].push(markKey);
        }
        return pieceRows;
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
    // What a card prints for its powers, in slot order: icon names, or uids in the "letters" display. A minor's one power is its suit's.
    private cardMarks(displays: string[], card: TarotCard): string[] {
        if (card.major) {
            return MAJOR_ARCANA[card.uid].powers.map(power => displays.includes("letters") ? power.uid : power.icon);
        }
        const mark = displays.includes("letters") ? card.suit.uid : card.suit.glyph;
        return mark === undefined ? [] : [mark];
    }

    // A power's uid as a glyph, upright and in the numerals' typeface.
    private markText(text: string, scale: number, nudge?: { dx: number; dy: number }): Glyph {
        return {
            text, scale, colour: "_context_strokes", fontFamily: "Georgia,serif", orientation: "vertical",
            ...(nudge === undefined ? {} : { nudge: { ...nudge, relativeTo: "glyph" as const } }),
        };
    }

    private buildCardFace(displays: string[], card: TarotCard, spaced: boolean, owner: number = 0, opts: { borderless?: boolean; rankText?: string; background?: ColourResolvable } = {}): Glyph[] {
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
            backdrop.opacity = 0.12;
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
        const rankScale = spaced ? (card.major ? 0.3 : 0.25): 0.45;
        const corner = spaced ? BOARD_TILE_GRID_CORNER : 250;
        let rankShiftX = spaced ? -675 : -corner;
        let rankShiftY = rankShiftX;
        if (card.major) {
            rankShiftX += spaced ? 675 : 250;
            rankShiftY += spaced ? -50 : -175;
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

        const marks = this.cardMarks(displays, card);
        const circleScale = spaced ? 0.25 : 0.45;
        const iconScale = spaced ? 0.15 : 0.30;
        // `iconShift` compensates for nudging issues, so an
        // icon still lands centred on its larger coin.
        const iconShift = spaced ? 1075 : 375;
        const pushCircle = (xdir: number, ydir: number, mark?: string) => {
            // Without circles an empty slot needs its own mark, and a glyph-relative nudge is scaled with the glyph, so the shift that centres one where the circle would be depends on its size.
            const letters = displays.includes("letters");
            if (letters || displays.includes("icons")) {
                const bare = !letters && mark !== undefined;
                // A bare icon, with no circle around it, is drawn larger than one inside a circle.
                const markScale = bare ? 1.25 * iconScale : rankScale;
                const shift = corner * circleScale / markScale;
                const nudge = { dx: xdir * shift, dy: ydir * shift };
                if (bare) {
                    stack.push({ name: mark, scale: markScale, nudge, orientation: "vertical" });
                } else {
                    // Uids are drawn at the ranks' size; a one-character uid gets a leading space, like a one-character rank's trailing one.
                    // The letters display prints a dash where a card has a slot but no power in it.
                    const text = mark === undefined ? "\u2014" : mark.length === 1 ? `\u00A0${mark}` : mark;
                    stack.push(this.markText(text, markScale, nudge));
                }
                return;
            }
            const nudge = { dx: xdir * iconShift, dy: ydir * iconShift };
            stack.push({ name: "piece", scale: circleScale, colour: "_context_board", nudge: { dx: xdir * corner, dy: ydir * corner }, orientation: "vertical" });
            if (mark !== undefined) {
                stack.push({ name: mark, scale: iconScale, nudge, orientation: "vertical" });
            }
        };

        // Top-right: always populated with a "piece" circle holding the suit icon (minors) or the major's first power icon.
        pushCircle(1, -1, marks[0]);

        //Bottom-left: nothing at all for minors; for majors, an empty circle except filled for the Devil.
        //Bottom-right: nothing for pip minors (A-10); an empty circle for court minors (P/N/Q/K); for majors, populated with the 2nd power icon (or empty).
        if (card.major) {
            pushCircle(-1, 1, marks[2]);
            pushCircle(1, 1, marks[1]);
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
            glyph: { name: `pyramid-flat-${sizeNames[i]}`, colour: player },
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

    // Overrides chatLogEntries (what the front end calls), not just chatLog, so the actor comes from plyActor() and the other players' names are filled in here.
    public chatLogEntries(players: string[] = []): ChatLogEntry[] {
        const result: ChatLogEntry[] = [];
        // Index 0 has no associated ply, so it's skipped.
        for (let i = 1; i < this.stack.length; i++) {
            const state = this.stack[i];
            if (state._results !== undefined && state._results.length > 0) {
                const lines: ChatLogLine[] = [];
                // Resolved via plyActor(), not `state.currplayer - 1`, to fix skip-turn (elimination) and sequenced (bidding reorder, High Priestess) cases.
                let otherPlayer = this.plyActor(i);
                if (otherPlayer < 1) {
                    otherPlayer = this.numplayers;
                }
                let name = `Player ${otherPlayer}`;
                if (otherPlayer <= players.length) {
                    name = players[otherPlayer - 1];
                }
                const say = (key: string, params?: Record<string, string | number | undefined>): void => this.pushSeatChatLine(lines, otherPlayer, key, params);
                const sayNeutral = (key: string, params?: Record<string, string | number | undefined>): void => this.pushNeutralChatLine(lines, key, params);
                // Frames for multi-step major arcana moves have _group entries - flatten here so this loop logs one line per step instead of skipping the whole group.
                const flatResults = state._results.flatMap(r => r.type === "_group" ? r.results : [r]);
                for (const r of flatResults) {
                    switch (r.type) {
                        case "announce": {
                            // Reused for two unrelated one-off announcements (bidding's turn-order reveal, and a declined revealed card) - tagged by payload[0] since "announce" carries no type.
                            if (r.payload[0] === "decline") {
                                say("apresults:ANNOUNCE.gnostica_decline", { card: this.cardDisplayName(r.payload[1] as string) });
                                break;
                            }
                            if (r.payload[0] === "declore") {
                                say("apresults:ANNOUNCE.gnostica_declore", { count: r.payload[1] as number });
                                break;
                            }
                            const nameFor = (p: number): string => p <= players.length ? players[p - 1] : `Player ${p}`;
                            const turnOrderNames = (r.payload as number[]).map(nameFor).join(", ");
                            const redrawOrderNames = [...r.payload as number[]].reverse().map(nameFor).join(", ");
                            sayNeutral("apresults:ANNOUNCE.gnostica", { turnOrder: turnOrderNames, redrawOrder: redrawOrderNames });
                            break;
                        }
                        case "swap": {
                            const target = this.otherPlayerName(r.who as number, name, players) ?? `Player ${r.who}`;
                            say("apresults:SWAP.gnostica", { target });
                            break;
                        }
                        case "select":
                            say("apresults:SELECT.gnostica");
                            break;
                        case "deckDraw":
                            switch (r.from) {
                                case "pool":
                                    say("apresults:DECKDRAW.gnostica_pool", { what: r.what!.split(",").filter(uid => uid.length > 0).map(uid => this.cardDisplayName(uid)).join(", ") });
                                    break;
                                case "discard":
                                    say("apresults:DECKDRAW.gnostica_discard", { count: r.count });
                                    break;
                                case "deck":
                                    say("apresults:DECKDRAW.gnostica_deck", { count: r.count });
                                    break;
                                case "hand":
                                    say("apresults:DECKDRAW.gnostica_hand", { what: this.cardDisplayName(r.what) });
                                    break;
                                case "fool": {
                                    if (r.what === undefined) {
                                        say("apresults:DECKDRAW.gnostica_fool_fail");
                                    } else {
                                        say("apresults:DECKDRAW.gnostica_fool", { what: this.cardDisplayName(r.what) });
                                    }
                                    break;
                                }
                            }
                            break;
                        case "declare":
                            say("apresults:DECLARE.gnostica", { count: r.count });
                            break;
                        case "orient": {
                            // The Devil's orientAny can reorient any player's piece; every other orient path only ever turns the acting player's own.
                            const target = this.otherPlayerName(r.who, name, players);
                            if (target === undefined) {
                                say("apresults:ORIENT.gnostica_own", { where: r.where, what: r.what, facing: r.facing });
                            } else {
                                say("apresults:ORIENT.gnostica_target", { where: r.where, what: r.what, facing: r.facing, target });
                            }
                            break;
                        }
                        case "use":
                            say(r.count === 21 ? "apresults:USE.gnostica_world" : "apresults:USE.gnostica", { what: this.cardDisplayName(r.what) });
                            break;
                        case "destroy":
                            if (r.who !== undefined) {
                                //Someone's minion.
                                const target = this.otherPlayerName(r.who, name, players);
                                if (target === undefined) {
                                    say("apresults:DESTROY.gnostica_piece_own", { what: r.what });
                                } else {
                                    say("apresults:DESTROY.gnostica_piece", { what: r.what, target });
                                }
                            } else {
                                //A territory.
                                say("apresults:DESTROY.gnostica_tile", { where: r.where, what: this.cardDisplayName(r.what) });
                            }
                            break;
                        case "move": {
                            // Rods/Hermit "piece" mode can move any piece, not just the acting player's own, so name whose it was.
                            const target = this.otherPlayerName(r.who, name, players);
                            switch (r.how) {
                                case "rod-piece":
                                    // `by` is only named when another minion did the pushing.
                                    if (r.by === undefined) {
                                        say("apresults:MOVE.gnostica_rod_piece_own", { what: r.what, from: r.from, to: r.to });
                                    } else if (target === undefined) {
                                        say("apresults:MOVE.gnostica_rod_push_own", { what: r.what, from: r.from, to: r.to });
                                    } else {
                                        say("apresults:MOVE.gnostica_rod_push", { what: r.what, from: r.from, to: r.to, target });
                                    }
                                    break;
                                case "rod-void":
                                    if (r.by === undefined) {
                                        say("apresults:MOVE.gnostica_rod_void_self", { what: r.what, from: r.from });
                                    } else if (target === undefined) {
                                        say("apresults:MOVE.gnostica_rod_void_own", { what: r.what, from: r.from });
                                    } else {
                                        say("apresults:MOVE.gnostica_rod_void", { what: r.what, from: r.from, target });
                                    }
                                    break;
                                case "rod-tile":
                                    say("apresults:MOVE.gnostica_rod_tile", { from: r.from, to: r.to });
                                    break;
                                case "hermit-piece":
                                    if (target === undefined) {
                                        say("apresults:MOVE.gnostica_hermit_piece_own", { what: r.what, from: r.from, to: r.to });
                                    } else {
                                        say("apresults:MOVE.gnostica_hermit_piece", { what: r.what, from: r.from, to: r.to, target });
                                    }
                                    break;
                                case "hermit-tile":
                                    say("apresults:MOVE.gnostica_hermit_tile", { from: r.from, to: r.to });
                                    break;
                            }
                            break;
                        }
                        case "place":
                            switch (r.how) {
                                case "cups-own":
                                    say("apresults:PLACE.gnostica_own", { where: r.where });
                                    break;
                                case "cups-enemy": {
                                    // "enemy" mode requires a real enemy target (self-targeting is rejected outright), so `who` always names someone else.
                                    const target = this.otherPlayerName(r.who, name, players) ?? `Player ${r.who}`;
                                    say("apresults:PLACE.gnostica_enemy", { where: r.where, target });
                                    break;
                                }
                                case "territory":
                                    say("apresults:PLACE.gnostica_territory", { where: r.where, what: this.cardDisplayName(r.what) });
                                    break;
                                case "initial":
                                    say("apresults:PLACE.gnostica_initial", { where: r.where });
                                    break;
                                case "discard":
                                    say("apresults:PLACE.gnostica_discard", { what: r.what });
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
                                    if (target === undefined) {
                                        say("apresults:CONVERT.gnostica_piece_own", { into: r.into, where: r.where });
                                    } else {
                                        say("apresults:CONVERT.gnostica_piece", { into: r.into, where: r.where, target });
                                    }
                                } else {
                                    if (target === undefined) {
                                        say("apresults:CONVERT.gnostica_piece_shrink_own", { into: r.into, where: r.where });
                                    } else {
                                        say("apresults:CONVERT.gnostica_piece_shrink", { into: r.into, where: r.where, target });
                                    }
                                }
                            } else if (r.into.startsWith("owner-")) {
                                const target = this.otherPlayerName(r.who, name, players);
                                if (target === undefined) {
                                    say("apresults:CONVERT.gnostica_hierophant", { where: r.where });
                                } else {
                                    say("apresults:CONVERT.gnostica_hierophant_target", { where: r.where, target });
                                }
                            } else {
                                // Discs' grow-replace and Swords' attack-and-replace both land here - point value is the only thing distinguishing which direction happened.
                                const before = allCards().find(c => c.uid === r.what);
                                const after = allCards().find(c => c.uid === r.into);
                                const grew = before !== undefined && after !== undefined && cardPointValue(after) > cardPointValue(before);
                                const key = grew ? "apresults:CONVERT.gnostica_tile" : "apresults:CONVERT.gnostica_tile_shrink";
                                say(key, { what: this.cardDisplayName(r.what), into: this.cardDisplayName(r.into), where: r.where });
                            }
                            break;
                        case "eliminated": {
                            const who = parseInt(r.who, 10);
                            const ename = who <= players.length ? players[who - 1] : `Player ${who}`;
                            sayNeutral("apresults:ELIMINATED", { player: ename });
                            break;
                        }
                        case "eog":
                            sayNeutral("apresults:EOG.default");
                            break;
                        case "resigned": {
                            let rname = `Player ${r.player}`;
                            if (r.player <= players.length) {
                                rname = players[r.player - 1];
                            }
                            sayNeutral("apresults:RESIGN", { player: rname });
                            break;
                        }
                        case "timeout": {
                            let tname = `Player ${r.player}`;
                            if (r.player <= players.length) {
                                tname = players[r.player - 1];
                            }
                            sayNeutral("apresults:TIMEOUT", { player: tname });
                            break;
                        }
                        case "drawagreed":
                            sayNeutral("apresults:DRAWAGREED");
                            break;
                        case "gameabandoned":
                            sayNeutral("apresults:ABANDONED");
                            break;
                        case "winners": {
                            const names: string[] = [];
                            for (const w of r.players) {
                                names.push(w <= players.length ? players[w - 1] : `Player ${w}`);
                            }
                            if (r.players.length === 0) {
                                sayNeutral("apresults:WINNERSNONE");
                            } else {
                                sayNeutral("apresults:WINNERS", { count: r.players.length, winners: names.join(", ") });
                            }
                            break;
                        }
                    }
                }
                result.push({ timestamp: (state._timestamp && new Date(state._timestamp).toISOString()) || "unknown", lines });
            }
        }
        return result;
    }

    public clone(): GnosticaGame {
        return new GnosticaGame(this.serialize());
    }
}
