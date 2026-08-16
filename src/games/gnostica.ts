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
    createOwn, createEnemy, createTerritory,
    movePiece, moveTerritory,
    growPiece, growTerritory,
    attackPiece, attackTerritory,
    orientMinion, orientAny, hierophantReplace,
    hermitMovePiece, hermitMoveTerritory, tradeHands,
    judgementDraw, highPriestess,
    checkCreateOwn, checkCreateEnemy, checkCreateTerritory,
    checkMovePiece, checkMoveTerritory,
    checkGrowPiece, checkGrowTerritory,
    checkAttackPiece, checkAttackTerritory,
    checkOrientMinion, checkOrientAny, checkHierophantReplace,
    checkHermitMovePiece, checkHermitMoveTerritory, checkTradeHands,
    checkJudgementDraw, checkHighPriestess,
} from "./gnostica/powers";
import { MajorArcanaDef, PowerStep, SpecialPower, SuitPrimitive, getMajorArcanaDef, getMajorArcanaIcons } from "./gnostica/majorArcana";
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

// resolvePieceRef's result: "ok" resolves to exactly one piece;
// "malformed" is a syntax failure (wrong segment count, bad pips,
// unrecognized orientation letter, bad player number); "not_found" is
// zero matches after applying whatever fields were supplied;
// "ambiguous" is more than one match remaining, where supplying
// additional fields would have narrowed it further (as opposed to true
// duplicate pieces, which "ok" already resolves via first-match - see
// resolvePieceRef's own docs).
type PieceRefResolution =
    | { kind: "ok"; ref: IMinionRef }
    | { kind: "malformed" }
    | { kind: "not_found" }
    | { kind: "ambiguous" };

// parseMove's result - one canonical structural parse of a move
// string, shared by every consumer (validateMove, move,
// parsePendingStep, highlightedButtonValues, handleClick) instead of
// each re-deriving head/args/steps and the "(last)" flag independently.
// Purely structural - like Magnate's own parseMove/pickleMove pair, this
// never checks legality against game state (that stays the
// validateX/checkX layer's job); it only answers "what does this string
// SAY, and is it at least well-formed enough to be worth asking that
// question." stringifyMove is its exact inverse.
interface IParsedMove {
    announceLast: boolean;
    // undefined only for a genuinely empty move (or one that's just
    // "(last)" alone).
    head: string | undefined;
    // true if head is undefined, or is one of the recognized keywords -
    // false is a real structural failure (UNRECOGNIZED_MOVE), not
    // something left for a switch statement's default arm to rediscover.
    headRecognized: boolean;
    rest: string[];
    stepSegments: string[][];
    // The first step segment that fails isStepShapeValid, if any - see
    // its own docs on what "shape" means here and why it can't go any
    // deeper without already knowing which suit/power is involved.
    malformedStep: string[] | undefined;
}

// Click support for minor arcana's single suit-power step (major arcana
// chaining is out of scope for this pass - see parsePendingStep()).
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
        enemy: { label: "Create Enemy", shape: "cell", minArgs: 2 },
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

// Hermit isn't suit-shaped (no create/move/grow/attack primitive behind
// it), so it gets its own tiny two-entry mode table rather than a slot in
// MINOR_MODES - button label only; shape/minArgs aren't needed here since
// hermitTeleport's own click handler manages its stages directly rather
// than going through legalMinorModes/buildStepModeMove.
const HERMIT_MODES: Record<string, { label: string }> = {
    piece: { label: "Move Piece" },
    tile: { label: "Push Territory" },
};

// The four suits magicianChoice lets the player pick between, in button
// order - reuses MINOR_MODES[suitUid] once chosen (see IPendingStep's own
// `prefix` field).
const MAGICIAN_SUITS: { uid: string; label: string }[] = [
    { uid: "C", label: "Cups" },
    { uid: "R", label: "Rods" },
    { uid: "D", label: "Discs" },
    { uid: "S", label: "Swords" },
];

// Minimum token count (including the leading minionRef, except
// highPriestess which has none) for a `special` step's segment to be
// considered "complete enough to walk past" - checked for BOTH an
// earlier, already-typed step in a chain, AND a card's own ONLY step on
// every non-preferCurrent call (getActionButtons, the mode_/magician_/
// hermit_ button dispatches) - it's not exclusively a "multi-step chain"
// concern. orientMinion/tradeHands/orientAny have a real, fixed token
// count once complete, so they get one; hierophantReplace does too even
// though (being always its card's only step) it's never actually walked
// past in practice - listed anyway for correctness rather than relying on
// that coincidence. magicianChoice, hermitTeleport, judgementDraw, and
// highPriestess all have variable-length grammars with no fixed
// "complete" token count reachable from here, AND are also always their
// card's only step - Infinity means "never complete enough to walk past,"
// which is exactly right for a step that's never anything BUT current.
const SPECIAL_MIN_TOKENS: Record<SpecialPower, number> = {
    orientMinion: 2,      // minionRef + orientation
    tradeHands: 2,        // minionRef + targetRef
    orientAny: 3,         // minionRef + targetRef + orientation
    hierophantReplace: 3, // minionRef + targetRef + orientation
    magicianChoice: Infinity,
    hermitTeleport: Infinity,
    judgementDraw: Infinity,
    highPriestess: Infinity,
    // Unreachable - parsePendingStep bails out for Fool/World before this
    // table is ever consulted (see its own docs) - listed only so this
    // stays a total, not partial, mapping.
    fool: Infinity,
    worldUseAny: Infinity,
};

// The engine-side view of an in-progress "activate"/"play" click sequence -
// reconstructed fresh from the move string on every call (same philosophy
// as isPendingFirstPlacement/highlightedButtonValues, not persisted
// anywhere). `minion` always defaults to the first eligible piece (see
// eligibleMinionsForActivate/Play's own docs on why disambiguating between
// several eligible minions by click is out of scope this pass). Undefined
// whenever there's nothing here for the click flow to do - no
// activate/play in progress, no eligible minions at all, or Fool/World
// (not resolvable through the engine at all yet).
//
// Exactly one of `suitUid` or `special` is ever set for a given pending
// object (never both, never neither) - a discriminated union would let
// TypeScript enforce that, but every existing suit-mode helper
// (legalMinorModes, buildStepModeMove, handlePendingStepBoardClick,
// supplyStepCardUid) already assumes `suitUid` unconditionally, and a
// union would force touching all of them just to re-narrow. Kept as plain
// optional fields instead - each of those functions asserts `suitUid!`
// once at its own top, documented there, rather than scattering asserts.
interface IPendingStep {
    head: "use" | "play";
    headArg: string;
    // For a minor card, its own suit. For a major card's `primitive` step,
    // the suit that primitive maps to (create→C, move→R, grow→D,
    // attack→S) - either way, MINOR_MODES[suitUid] is this step's mode
    // table, so every suit-mode click helper stays suit-agnostic between
    // minor and major. Undefined instead when the current step is a major
    // card's `special` power - see `special` below.
    suitUid?: string;
    // Set instead of suitUid when the current step is a major card's
    // `special` power (Phase B) - dispatched to its own click handler
    // (handlePendingSpecialBoardClick) rather than the suit-mode machinery
    // above. `rest` (below) holds whatever tokens are already typed after
    // the minionRef for this step (or ALL tokens, for highPriestess, which
    // has no minionRef at all).
    special?: SpecialPower;
    // Extra tokens spliced in right after minionRef, before mode/args -
    // always [] except magicianChoice's 2nd stage (after a suit letter is
    // chosen), where it's [suitLetter]. Lets that stage reuse
    // buildStepModeMove/handlePendingStepBoardClick/supplyStepCardUid
    // completely unmodified once suitUid is set to the chosen letter.
    prefix: string[];
    // Every one of the acting player's own pieces eligible to act here -
    // `minion` is always minions[0] (see this interface's own docs), but
    // the full list is kept too so a minion-selector ref can still be
    // generated correctly (disambiguated only against the player's own
    // OTHER eligible minions, never a co-located enemy piece - see
    // resolvePieceRef's docs on the "minion-selector" pool).
    eligible: IMinionRef[];
    // eligible, plus any newMinion chained in from earlier COMPLETE steps
    // of the same major-arcana activation (mirrors validateMajorPower's
    // own chaining loop) - identical to `eligible` for a minor card, or
    // for a major card's own first step.
    minions: IMinionRef[];
    minion: IMinionRef;
    // Earlier complete power-step segments of the same major-arcana
    // activation, verbatim raw text - preserved as-is by every move
    // string this step's own click helpers build. Always [] for a minor
    // card, which only ever has the one step.
    priorSteps: string[];
    // computeShortcutOpts's own result for the CURRENT step - always {}
    // for a minor card (which never has shortcut opts at all) or a
    // special step (which never has PrimitiveOpts at all). Exists so
    // legalMinorModes' best-effort button pre-filter can account for a
    // same-target-shortcut/Moon card's relaxed capacity, the one place
    // that filter's own logic needs to know about opts.
    opts: Record<string, unknown>;
    mode?: string;
    rest: string[];
}

// Major arcana chaining (up to 3 power steps, "become a minion when
// directly targeted", the Strength/Death/Sun/Chariot same-target
// shortcuts) is fully supported at the engine level (applyMajorPower/
// validateMajorPower, driven by a hand-typed move string) - what's still
// missing is click support for each `special` power's own bespoke
// argument shape (orientMinion, orientAny, hierophantReplace,
// hermitTeleport, tradeHands, judgementDraw, highPriestess,
// magicianChoice); a card's `primitive` steps chain through the exact
// same click machinery a minor arcana card's own single step already
// uses - see IPendingStep/parsePendingStep. See docs on `move()` below.
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
            { uid: "#target" },
            { uid: "target-10", group: "target" },
            { uid: "bidding" },
            { uid: "no-majors" }
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
            let boardCards: TarotCard[];
            let drawPile: string[];
            if (this.variants.includes("no-majors")) {
                // Only keeps majors off the OPENING board - they're still
                // fully in the mix for hands (already dealt above) and the
                // draw pile. Pulls 9 non-major cards out of what's left
                // (still in shuffled order, so still a fair random sample),
                // then reshuffles everything else (leftover non-majors +
                // every major) back together so majors stay genuinely
                // randomly distributed through the draw pile rather than
                // clumping at one end.
                const remaining = deck.cards;
                const nonMajors = remaining.filter(c => !c.major);
                boardCards = nonMajors.splice(0, 9);
                const rest = shuffle([...nonMajors, ...remaining.filter(c => c.major)]) as TarotCard[];
                drawPile = rest.map(c => c.uid);
            } else {
                boardCards = deck.draw(9);
                drawPile = deck.cards.map(c => c.uid);
            }
            let boardIdx = 0;
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    board.store.set(x, y, new Territory(boardCards[boardIdx]));
                    boardIdx++;
                }
            }

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
    // Grammar: a comma/semicolon/slash-delimited list of segments naming
    // the turn's action (plus, for "activate"/"play", 0+ further segments
    // chaining suit/major-arcana power steps). A trailing "(last)" suffix
    // on the WHOLE move string - not a segment of its own, always at the
    // very end - announces the player's final turn. It's deliberately a
    // distinct, unmistakable suffix rather than just another
    // comma-segment, so it's one flag on parseMove's own result
    // rather than something every consumer has to notice and skip past
    // on its own.
    //
    // parseMove/stringifyMove (below) are this grammar's single
    // structural parser/serializer pair - every reader (validateMove,
    // move, parsePendingStep, highlightedButtonValues,
    // handleClick) calls the former instead of re-deriving head/args/
    // steps/announceLast independently, and handleClick's declare
    // handling calls the latter instead of string-level regex surgery.
    // Purely structural, like Magnate's own parseMove/pickleMove pair -
    // never checks legality against game state, only "is the head a
    // recognized keyword, and does each power step at least look
    // plausible" (isStepShapeValid's own docs explain why that can't go
    // any deeper without already knowing which suit/power is involved -
    // the legality/field-level checking stays exactly where it already
    // lived, in validateMinorPower/validatePowerStep/validateCups etc.).
    //
    // validateMove() (below) is a real, non-mutating validator that
    // walks this same grammar read-only, rather than mutating a
    // throwaway clone and reporting whether it threw - see its own docs
    // for why.
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

        // Parses and executes `m` against `this` - the one place move
        // grammar is interpreted (validateMove mirrors this exact
        // structure, read-only - see its own docs). Throws
        // UserFacingError on any illegal move.
        //
        // Segment 0 is always the turn's top-level action. For "activate"/
        // "play", 0 or 1 further segments follow - a single suit-power step
        // (minor arcana always grants exactly one power, and it's always
        // optional). Major arcana cards (which can chain up to 3 power
        // steps) aren't supported here yet - see cmdActivate/cmdPlay.
        const parsed = this.parseMove(m);
        if (parsed.head === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation._general.INVALID_MOVE", { move: m }));
        }
        if (!parsed.headRecognized) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation._general.UNRECOGNIZED_MOVE", { move: [parsed.head, ...parsed.rest].join(" ") }));
        }

        // Remembered before acting: if this player announced their last
        // turn on a PREVIOUS turn, this is the turn that resolves it - win
        // or elimination is decided after their action, below.
        const wasAnnounced = this.lastTurnAnnouncedBy === this.currplayer;

        const requireNoSteps = () => {
            if (parsed.stepSegments.length > 0) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: parsed.head }));
            }
        };
        const requireValidStepShapes = () => {
            if (parsed.malformedStep !== undefined) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP", step: parsed.malformedStep.join(" ") }));
            }
        };
        // Place is always a player's ENTIRE turn - one gate here, ahead of
        // the switch, replaces a separate check inside every other command:
        // with no board presence, place is the only legal head this turn,
        // full stop; with board presence, place is illegal instead (caught
        // by cmdPlace's own ALREADY_ON_BOARD check) and every other command
        // is free to assume board presence without asking again. Evaluated
        // fresh every call, so this covers a mid-game wipeout's forced
        // re-placement identically to the very first turn - no separate
        // tracked state needed for either case.
        const headLower = parsed.head.toLowerCase();
        if (headLower !== "place" && !this.hasPiecesOnBoard(this.currplayer)) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.MUST_PLACE_FIRST"));
        }
        switch (headLower) {
            case "place":
                requireNoSteps();
                this.cmdPlace(parsed.rest);
                break;
            case "orient":
                requireNoSteps();
                this.cmdOrient(parsed.rest);
                break;
            case "discard":
                requireNoSteps();
                this.cmdDiscard(parsed.rest, partial);
                break;
            case "use":
                requireValidStepShapes();
                this.cmdActivate(parsed.rest, parsed.stepSegments);
                break;
            case "play":
                requireValidStepShapes();
                this.cmdPlay(parsed.rest, parsed.stepSegments);
                break;
        }

        if (parsed.announceLast) {
            if (this.lastTurnAnnouncedBy !== undefined && this.lastTurnAnnouncedBy !== this.currplayer) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.ALREADY_ANNOUNCED"));
            }
            this.lastTurnAnnouncedBy = this.currplayer;
            this.results.push({ type: "announce", payload: ["lastTurn", this.currplayer] });
        }

        if (wasAnnounced) {
            this.resolveAnnouncedTurn();
        }

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

    // Walks the exact same move grammar move() does, but read-only - every
    // legality check is a direct query against live (unmutated) state, or
    // a checkX call from gnostica/powers.ts (the same predicate the
    // matching mutating function calls before mutating - see powers.ts's
    // own docs on why that split keeps the two from drifting apart). Replaces the old
    // "clone this, try running the move on the clone, catch whatever it throws"
    // approach: that mechanism silently discarded every specific reason a
    // suit-power move was illegal, since the thrown GnosticaRulesError
    // wasn't a UserFacingError and the catch block only ever unwrapped
    // UserFacingError's `.client` - every powers.ts failure surfaced as the
    // generic INVALID_MOVE fallback instead of its real message. Fixed as a
    // side effect here: every validateX/checkX failure below carries its
    // own key straight through to the returned message.
    public validateMove(m: string): IValidationResult {
        const parsed = this.parseMove(m);
        if (parsed.head === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.INITIAL_INSTRUCTIONS") };
        }
        if (!parsed.headRecognized) {
            return this.invalid("apgames:validation._general.UNRECOGNIZED_MOVE", { move: [parsed.head, ...parsed.rest].join(" ") });
        }

        const requireNoSteps = (): IValidationResult | undefined => {
            if (parsed.stepSegments.length > 0) {
                return this.invalid("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: parsed.head });
            }
            return undefined;
        };
        const requireValidStepShapes = (): IValidationResult | undefined => {
            if (parsed.malformedStep !== undefined) {
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP", step: parsed.malformedStep.join(" ") });
            }
            return undefined;
        };

        // Mirrors move()'s own single top-level gate - see its docs.
        const headLower = parsed.head.toLowerCase();
        if (headLower !== "place" && !this.hasPiecesOnBoard(this.currplayer)) {
            return this.invalid("apgames:validation.gnostica.MUST_PLACE_FIRST");
        }
        let failure: IValidationResult | undefined;
        switch (headLower) {
            case "place":
                failure = requireNoSteps() ?? this.validatePlace(parsed.rest);
                break;
            case "orient":
                failure = requireNoSteps() ?? this.validateOrient(parsed.rest);
                break;
            case "discard":
                failure = requireNoSteps() ?? this.validateDiscard(parsed.rest);
                break;
            case "use":
                failure = requireValidStepShapes() ?? this.validateActivate(parsed.rest, parsed.stepSegments);
                break;
            case "play":
                failure = requireValidStepShapes() ?? this.validatePlay(parsed.rest, parsed.stepSegments);
                break;
        }
        if (failure !== undefined) {
            return failure;
        }

        if (parsed.announceLast && this.lastTurnAnnouncedBy !== undefined && this.lastTurnAnnouncedBy !== this.currplayer) {
            return this.invalid("apgames:validation.gnostica.ALREADY_ANNOUNCED");
        }

        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // The end-of-turn "declare" flag is always this exact trailing suffix
    // on the whole move string - never a comma-separated segment mixed in
    // with the rest - so it can be found/stripped/reattached with one
    // shared regex regardless of wherever else in the grammar the rest
    // of the string is being parsed. See this file's "Move parsing" docs
    // above for why.
    private static readonly LAST_FLAG_RE = /\s*\(last\)\s*$/i;
    private static readonly RECOGNIZED_HEADS = ["place", "orient", "discard", "use", "play"];

    // Every step's first token is always either a piece ref (every suit
    // primitive and special power except one) or a card uid (High
    // Priestess's own discard-list steps, which have no minion reference
    // at all) - the one thing checkable across the whole grammar without
    // resolving the card (board state this parser doesn't have - see the
    // "Move parsing" docs above). Every token everywhere in a step is
    // built from the same small alphabet regardless of which suit/power
    // it belongs to, and no real step needs more than a handful of
    // tokens (the richest shape - Magician wrapping Swords' own
    // piece-target form - tops out at 6; discarding several cards at
    // once, Judgement or High Priestess, is the other realistic
    // outlier) - 12 leaves comfortable headroom without weakening the
    // check.
    private static readonly PIECE_REF_SHAPE_RE = /^[a-z]{1,2}-?\d+\.[1-3](\.[nesu])?(\.\d+)?$/i;
    private static readonly CARD_UID_SHAPE_RE = /^((a|10|[2-9]|p|n|q|k)[crds]|\d{2})$/i;
    private static readonly STEP_TOKEN_RE = /^[a-z0-9.-]+$/i;
    private static readonly MAX_STEP_TOKENS = 12;

    private isStepShapeValid(tokens: string[]): boolean {
        if (tokens.length === 0 || tokens.length > GnosticaGame.MAX_STEP_TOKENS) {
            return false;
        }
        if (!tokens.every(t => GnosticaGame.STEP_TOKEN_RE.test(t))) {
            return false;
        }
        return GnosticaGame.PIECE_REF_SHAPE_RE.test(tokens[0]) || GnosticaGame.CARD_UID_SHAPE_RE.test(tokens[0]);
    }

    private parseMove(m: string): IParsedMove {
        const trimmed = m.trim();
        const announceLast = GnosticaGame.LAST_FLAG_RE.test(trimmed);
        const bare = trimmed.replace(GnosticaGame.LAST_FLAG_RE, "").trim();
        const segments = bare.split(/\s*[\n,;/\\]\s*/).filter(s => s.length > 0);
        if (segments.length === 0) {
            return { announceLast, head: undefined, headRecognized: true, rest: [], stepSegments: [], malformedStep: undefined };
        }
        const [head, ...rest] = segments[0].split(/\s+/);
        const stepSegments = segments.slice(1).map(s => s.split(/\s+/));
        return {
            announceLast,
            head,
            headRecognized: GnosticaGame.RECOGNIZED_HEADS.includes(head.toLowerCase()),
            rest,
            stepSegments,
            malformedStep: stepSegments.find(tokens => !this.isStepShapeValid(tokens)),
        };
    }

    private stringifyMove(p: IParsedMove): string {
        const segments = p.head === undefined ? [] : [[p.head, ...p.rest].join(" "), ...p.stepSegments.map(s => s.join(" "))];
        const base = segments.join(", ");
        return p.announceLast ? (base.length === 0 ? "(last)" : `${base} (last)`) : base;
    }

    private invalid(key: string, params?: Record<string, unknown>): IValidationResult {
        return { valid: false, complete: -1, message: i18next.t(key, params) };
    }

    private failureResult(failure: PowerFailure): IValidationResult {
        return this.invalid(`apgames:validation.gnostica.${failure.key}`, failure.params);
    }

    // Maps a failed resolvePieceRef() result to its validation message -
    // `notFoundKey` lets a minion-selector call site report
    // NOT_AN_ELIGIBLE_MINION instead of the target-slot default of
    // NO_SUCH_PIECE for the same "nothing matched" outcome (mirrors
    // resolvePieceRefOrThrow's own notFoundKey param on the apply* side).
    private invalidPieceRef(kind: "malformed" | "not_found" | "ambiguous", ref: string | undefined, notFoundKey = "NO_SUCH_PIECE"): IValidationResult {
        switch (kind) {
            case "malformed": return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_PIECE_REF", ref });
            // notFoundKey is sometimes overridden to a key with its own
            // real text (e.g. NOT_AN_ELIGIBLE_MINION) - only the shared
            // default collapses into INVALID_MOVE.
            case "not_found": return notFoundKey === "NO_SUCH_PIECE"
                ? this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_SUCH_PIECE", ref })
                : this.invalid(`apgames:validation.gnostica.${notFoundKey}`, { ref });
            case "ambiguous": return this.invalid("apgames:validation.gnostica.AMBIGUOUS_PIECE_REF", { ref });
        }
    }

    // The move grammar's orientation vocabulary - N/E/S/W/U, all single
    // uppercase letters ("U" for the internal "up" value), used
    // everywhere a move string names a facing (place, orient, Cups
    // "own", piece refs, every optional post-action reorientation arg).
    // Case-insensitive on input; orientationLetter (below) is this
    // function's exact inverse for generating a move string.
    private tryParseOrientation(s: string | undefined): Orientation | undefined {
        if (s === undefined) {
            return undefined;
        }
        if (s.toUpperCase() === "U") {
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

    private orientationLetter(o: Orientation): string {
        return o === "up" ? "U" : o;
    }

    // A piece reference names a pyramid the same way a player would
    // describe one out loud: "<cell>.<pips>[.<orientation>][.<player>]" -
    // pips always present, orientation/player each included only if
    // needed to pick out one piece. Resolved against `pool` if given
    // (a "minion-selector" slot - the eligible/minions list, already the
    // acting player's own pieces, filtered to the parsed cell), or every
    // piece at the parsed cell if omitted (a "target" slot - any owner is
    // fair game, matching checkValidPieceTarget's own lack of an
    // ownership restriction). Two pieces identical in every field
    // (owner+size+orientation - see Piece.id()) are functionally
    // interchangeable, so resolve to whichever comes first rather than
    // erroring; anything less than fully identical that's still ambiguous
    // after the fields actually supplied is a genuine "ambiguous" result,
    // since supplying more fields would have resolved it.
    private resolvePieceRef(ref: string | undefined, pool?: IMinionRef[]): PieceRefResolution {
        if (ref === undefined) {
            return { kind: "malformed" };
        }
        const segments = ref.split(".");
        if (segments.length < 2 || segments.length > 4) {
            return { kind: "malformed" };
        }
        const [cellStr, pipsStr, ...rest] = segments;
        const coords = this.tryAlgebraic2coords(cellStr);
        if (coords === undefined) {
            return { kind: "malformed" };
        }
        const [x, y] = coords;
        const pips = parseInt(pipsStr, 10);
        if (Number.isNaN(pips) || pips < 1 || pips > 3) {
            return { kind: "malformed" };
        }
        let orientation: Orientation | undefined;
        let player: number | undefined;
        for (const tok of rest) {
            const asOrientation = this.tryParseOrientation(tok);
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
            : (this.board.get(x, y)?.pieces ?? []).map((_, index) => ({ x, y, index }));
        let matches = candidateRefs
            .map(r => ({ r, piece: this.board.get(r.x, r.y)!.pieces[r.index] }))
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
        return { kind: "ok", ref: matches[0].r };
    }

    // Throwing counterpart to resolvePieceRef, for the
    // mutating apply* side - `notFoundKey` lets a minion-selector call
    // site report NOT_AN_ELIGIBLE_MINION instead of the target-slot
    // default of NO_SUCH_PIECE for the same "nothing matched" outcome.
    private resolvePieceRefOrThrow(ref: string | undefined, pool?: IMinionRef[], notFoundKey = "NO_SUCH_PIECE"): { x: number; y: number; index: number } {
        const result = this.resolvePieceRef(ref, pool);
        if (result.kind === "ok") {
            return result.ref;
        }
        if (result.kind === "malformed" || (result.kind === "not_found" && notFoundKey === "NO_SUCH_PIECE")) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: result.kind === "malformed" ? "BAD_PIECE_REF" : "NO_SUCH_PIECE", ref }));
        }
        const key = result.kind === "ambiguous" ? "AMBIGUOUS_PIECE_REF" : notFoundKey;
        throw new UserFacingError("VALIDATION_GENERAL", i18next.t(`apgames:validation.gnostica.${key}`, { ref }));
    }

    // A syntactically-complete move that the click flow itself built up
    // (as opposed to one the user finished typing) is still provisional -
    // place/orient's orientation and discard's uid/count list are all optional
    // refinements the player may want to keep clicking through, so this
    // deliberately downgrades validateMove()'s natural complete:1 to 0
    // whenever the move is otherwise valid. Matches Knight Line's own
    // mm.complete-vs-result.complete distinction: complete:1 tells the
    // interface it's safe to auto-finalize the move on its own, which is
    // wrong here - only the player's own explicit "Submit Move" should end
    // the click sequence, or the very first click auto-submits "up" before
    // there's ever a chance to cycle to a real facing.
    private provisionalResult(newmove: string, messageKey?: string): IClickResult {
        const result = this.validateMove(newmove) as IClickResult;
        result.move = newmove;
        if (result.valid && result.complete === 1) {
            result.complete = 0;
        }
        if (messageKey !== undefined && result.valid) {
            result.message = i18next.t(messageKey);
        }
        return result;
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
    // `r.how !== undefined` excludes Cups' "own"/"enemy" modes, which also
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
        const parsed = this.parseMove(this.liveMove);
        if (parsed.announceLast) {
            found.add("declare");
        }
        const head = parsed.head?.toLowerCase();
        if (head !== undefined && ["place", "use", "play", "orient", "discard"].includes(head)) {
            found.add(head);
        }
        return found;
    }

    private getActionButtons(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (this.gameover) {
            return undefined;
        }
        // A live preview of "activate"/"play" can only ever have STARTED
        // with the acting player already having board presence - both
        // throw via move()'s own top-level hasPiecesOnBoard gate otherwise
        // - so a piece count
        // of zero mid-preview (e.g. a Sword attack that ends up destroying
        // the acting player's own last minion) is a legitimate side effect
        // of the very same in-progress move, not a sign a fresh placement
        // turn is needed. Without this, hasPiecesOnBoard() below would
        // misread that transient state and collapse the bar down to
        // "Place" mid-preview, even though the in-progress move is still
        // perfectly valid and submittable as-is.
        const midPowerStep = this.liveMove !== undefined && /^(use|play)\b/.test(this.liveMove);
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
            { label: "Use Territory", value: "use" },
            { label: "Use Hand Card", value: "play" },
            { label: "Orient", value: "orient" },
            { label: "Discard/Draw", value: "discard" },
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

        // Discard's own count is optional (an omitted "draw <n>" defaults
        // to the max at commit time - see cmdDiscard's docs), but the bar
        // still actively solicits it: as soon as "discard" is the live
        // head and no count has been chosen yet, offer every legal count
        // from 0 up to the room left in a 6-card hand as its own button,
        // fully replacing the top-level bar (same shape as hermitTeleport/
        // magicianChoice's own button sets below). this.hands already
        // reflects the live move's own discard uids by the time this runs
        // - move(..., {partial: true}) already ran cmdDiscard's own
        // discard loop to get here (see its docs), it only stopped short
        // of the redraw - so the room left is just 6 minus the CURRENT
        // hand length, no separate subtraction of the discard list needed.
        if (this.liveMove !== undefined) {
            const liveParsed = this.parseMove(this.liveMove);
            if (liveParsed.head?.toLowerCase() === "discard" && !liveParsed.rest.includes("draw")) {
                const hand = this.hands[this.currplayer - 1] ?? [];
                const maxDraw = Math.max(0, 6 - hand.length);
                const countButtons: ButtonBarButton[] = [];
                for (let n = 0; n <= maxDraw; n++) {
                    countButtons.push({ label: `Draw ${n}`, value: `drawcount_${n}` });
                }
                return countButtons as [ButtonBarButton, ...ButtonBarButton[]];
            }
        }

        const pendingMinor = this.liveMove !== undefined ? this.parsePendingStep(this.liveMove) : undefined;
        if (pendingMinor === undefined) {
            return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
        }
        // orientMinion/tradeHands/orientAny/hierophantReplace/
        // judgementDraw/highPriestess are pure click-driven (board or
        // AreaPieces clicks, no mode to pick via button) - leave the bar
        // exactly as "orient"/"place" already do (uncollapsed), rather
        // than collapsing to an empty button set. hermitTeleport (mode not
        // chosen yet) and magicianChoice (suit not chosen yet) are the two
        // special powers that DO need their own button set, handled below
        // instead of falling into the suit-mode loop. Once magicianChoice's
        // suit IS chosen, buildSpecialPending has already redirected
        // `pendingMinor` into an ordinary suit-shaped pending (special
        // undefined, suitUid set), so it falls straight through to that
        // same existing loop unmodified.
        if (pendingMinor.special !== undefined && pendingMinor.special !== "hermitTeleport" && pendingMinor.special !== "magicianChoice") {
            return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
        }

        // Once a power step's own modes are on offer, there isn't room to
        // also keep the full top-level set around - only the one choice
        // that got us here (Use Territory/Use Hand Card) stays, followed
        // by a non-interactive spacer button (the schema has no dedicated
        // divider type) and this step's own mode buttons. Declare stays
        // available throughout (it's an orthogonal end-of-turn flourish,
        // not a step in this particular choice), tacked on at the end
        // rather than lost.
        const selected = topLevel.find(b => b.value === pendingMinor.head);
        const declareBtn = topLevel.find(b => b.value === "declare");
        const buttons: ButtonBarButton[] = selected !== undefined ? [selected] : [];
        buttons.push({ label: "→", value: "_spacer" });
        if (pendingMinor.special === "hermitTeleport") {
            const chosen = pendingMinor.rest[0];
            for (const [mode, config] of Object.entries(HERMIT_MODES)) {
                const button: ButtonBarButton = { label: config.label, value: `hermit_${mode}` };
                if (chosen === mode) {
                    button.attributes = [{ name: "font-weight", value: "bold" }];
                }
                buttons.push(button);
            }
        } else if (pendingMinor.special === "magicianChoice") {
            for (const suit of MAGICIAN_SUITS) {
                buttons.push({ label: suit.label, value: `magician_${suit.uid}` });
            }
        } else {
            const suitUid = pendingMinor.suitUid!;
            for (const mode of this.legalMinorModes(pendingMinor)) {
                const config = MINOR_MODES[suitUid][mode];
                const button: ButtonBarButton = { label: config.label, value: `mode_${suitUid}_${mode}` };
                if (pendingMinor.mode === mode) {
                    button.attributes = [{ name: "font-weight", value: "bold" }];
                }
                buttons.push(button);
            }
        }
        if (declareBtn !== undefined) {
            buttons.push(declareBtn);
        }
        return buttons as [ButtonBarButton, ...ButtonBarButton[]];
    }

    private primitiveToSuit(primitive: SuitPrimitive): string {
        return primitive === "create" ? "C" : primitive === "move" ? "R" : primitive === "grow" ? "D" : "S";
    }

    // Reconstructs the in-progress power step (if any) purely from a move
    // string - same "recompute, don't persist" approach as
    // isPendingFirstPlacement/highlightedButtonValues. `moveStr` is passed
    // explicitly (rather than always reading this.liveMove) so handleClick
    // can call this with its own `move` parameter mid-click, before that
    // click's result has been partial-applied back into this.liveMove -
    // the two stay in lockstep in practice (see the click-handling docs
    // below), but this keeps the dependency explicit either way.
    // `minion` always defaults to the first eligible piece - disambiguating
    // between several eligible minions by click is out of scope this pass
    // (mirrors the same simplification "orient" already makes).
    //
    // For a minor card there's always exactly one step, so "which step am
    // I on" is trivial. For a major card, this walks every step segment
    // ALREADY in the move string, checking only STRUCTURAL completeness
    // (mode + minArgs for a primitive step, minionRef + at least one more
    // token for a special one) - stopping, and returning undefined (no
    // click support), the moment it hits a segment that's still short of
    // that, or a card that's Fool/World (not resolvable through the engine
    // at all). If every existing segment is structurally complete, the
    // pending step becomes a fresh, not-yet-started one for
    // def.powers[stepSegments.length] - only if that one is a primitive
    // and the card has one left (a fresh special step gets no click
    // support of its own - Phase B).
    //
    // Deliberately does NOT re-run validatePowerStep against board state to
    // confirm a prior segment is actually LEGAL (not just structurally
    // complete), unlike validateMajorPower's own chaining loop - this is
    // called from getActionButtons() after this.liveMove may have already
    // been partial-applied for real (see move()'s own docs), meaning the
    // board can already reflect that very segment's own effect (e.g. a
    // pushed piece already sitting at its NEW cell) - re-resolving the
    // segment's OWN token string against that already-changed board would
    // wrongly fail. Semantic legality of every segment stays
    // validateMove/move's job at submit time regardless; this is a
    // best-effort UI helper, not a source of truth. One consequence: a
    // chained piece created/moved by an earlier step is never folded into
    // `minions` here (Phase A's click flow always defaults to `eligible[0]`
    // as the actor anyway - see the doc paragraph above).
    //
    // `callOpts.preferCurrent` controls what happens once the LAST typed
    // segment is already complete enough to advance past (its mode's
    // minArgs are met) but a further step remains: by default this
    // function advances to that fresh next step (what getActionButtons
    // and the mode-button dispatch want, so a different suit's button
    // starts a new segment). Board clicks and hand-card-uid supply want
    // the opposite - they should keep refining whatever's already
    // typed (e.g. redirecting a Rods "piece" step's self-target default
    // to the facing cell) for as long as the player keeps clicking,
    // rather than being silently bumped to the next step the moment the
    // default alone happens to satisfy minArgs.
    private parsePendingStep(moveStr: string, callOpts: { preferCurrent?: boolean } = {}): IPendingStep | undefined {
        const parsed = this.parseMove(moveStr);
        const head = parsed.head;
        if (head !== "use" && head !== "play") {
            return undefined;
        }
        const headArg = parsed.rest[0];
        if (headArg === undefined) {
            return undefined;
        }
        let card: MinorCard | MajorCard | undefined;
        let eligible: IMinionRef[];
        if (head === "use") {
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
            const suitUid = (card as MinorCard).suit.uid;
            const [, mode, ...rest] = parsed.stepSegments[0] ?? []; // stepSegments[0][0] is the minionRef - always eligible[0] by construction
            return { head, headArg, suitUid, prefix: [], eligible, minions: eligible, minion: eligible[0], priorSteps: [], opts: {}, mode, rest };
        }

        const def = getMajorArcanaDef(card as MajorCard);
        if (def.uid === "00" || def.uid === "21") {
            return undefined; // Fool/World - not resolvable through the engine at all yet
        }
        if (parsed.stepSegments.length > def.powers.length) {
            return undefined; // too many steps already typed - validateMove/move report this properly on submit
        }

        const minions = eligible;
        const priorSteps: string[] = [];
        let stepIndex = 0;
        for (; stepIndex < parsed.stepSegments.length; stepIndex++) {
            const tokens = parsed.stepSegments[stepIndex];
            const step = def.powers[stepIndex];
            const isLastSegment = stepIndex === parsed.stepSegments.length - 1;
            if ("primitive" in step) {
                const suitUidForStep = this.primitiveToSuit(step.primitive);
                const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, def.powers.length, step.opts);
                const [, mode, ...rest] = tokens;
                const config = mode !== undefined ? MINOR_MODES[suitUidForStep]?.[mode] : undefined;
                if (config === undefined || rest.length < config.minArgs || (isLastSegment && callOpts.preferCurrent)) {
                    // Still building this one - not complete enough to
                    // advance past, OR the caller explicitly wants the
                    // last-typed segment treated as "current" even once it
                    // IS complete enough (board clicks/hand-card supply keep
                    // refining whatever's already there - e.g. redirecting
                    // a Rods "piece" step's self-target default to the
                    // facing cell - right up until the player picks a
                    // different suit's mode button to actually move on; see
                    // the two call sites this flag is passed from in
                    // handleClickCore).
                    return { head, headArg, suitUid: suitUidForStep, prefix: [], eligible, minions, minion: minions[0], priorSteps, opts, mode, rest };
                }
            } else {
                const minTokens = SPECIAL_MIN_TOKENS[step.special];
                if (tokens.length < minTokens || (isLastSegment && callOpts.preferCurrent)) {
                    // Same "still building, or the caller wants it treated
                    // as current regardless" rule as the primitive branch
                    // above - see this function's own docs and
                    // buildSpecialPending's.
                    return this.buildSpecialPending(step.special, head, headArg, eligible, minions, priorSteps, tokens);
                }
            }
            // Walking past this segment (primitive-and-complete, or
            // special-and-complete) is what lets a LATER primitive step
            // (e.g. Tower's own attack, after its special orientMinion
            // step 1) become click-driven - see this function's own docs
            // for why this stays a structural check only, not a full
            // validatePowerStep call.
            priorSteps.push(tokens.join(" "));
        }
        if (stepIndex >= def.powers.length) {
            return undefined; // every step already complete - nothing left to click for
        }
        const step = def.powers[stepIndex];
        if ("primitive" in step) {
            const suitUid = this.primitiveToSuit(step.primitive);
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, def.powers.length, step.opts);
            return { head, headArg, suitUid, prefix: [], eligible, minions, minion: minions[0], priorSteps, opts, mode: undefined, rest: [] };
        }
        return this.buildSpecialPending(step.special, head, headArg, eligible, minions, priorSteps, []);
    }

    // Builds the `special`-flavored branch of IPendingStep - `tokens` is
    // this step's own already-typed segment (or [] for a brand new one),
    // still including its own leading minionRef (except highPriestess,
    // which has none at all - see IPendingStep's own docs). `minion` is
    // set to minions[0] even for highPriestess (unused by its own click
    // handler, but the field isn't optional and minions is guaranteed
    // non-empty by this point regardless of which special power it is -
    // the general "must own a piece at the activated cell" rule, not
    // anything specific to a particular power).
    //
    // magicianChoice is the one exception: once a suit letter is chosen
    // (tokens[1]), the rest of its own grammar (<mode> <args...>) is
    // identical to that suit's own primitive step - rather than building a
    // second, parallel implementation of legalMinorModes/buildStepModeMove/
    // handlePendingStepBoardClick/supplyStepCardUid for it, this returns
    // an ordinary SUIT-shaped pending instead (suitUid = the chosen
    // letter, prefix = [letter] so the letter gets spliced back into every
    // move string those functions build), letting that entire existing
    // machinery drive stage 2 completely unmodified.
    private buildSpecialPending(
        special: SpecialPower, head: "use" | "play", headArg: string,
        eligible: IMinionRef[], minions: IMinionRef[], priorSteps: string[], tokens: string[],
    ): IPendingStep {
        if (special === "magicianChoice" && MAGICIAN_SUITS.some(s => s.uid === tokens[1])) {
            const suitUid = tokens[1];
            const [, , mode, ...rest] = tokens;
            return { head, headArg, suitUid, prefix: [suitUid], eligible, minions, minion: minions[0], priorSteps, opts: {}, mode, rest };
        }
        const rest = special === "highPriestess" ? tokens : tokens.slice(1);
        return { head, headArg, special, prefix: [], eligible, minions, minion: minions[0], priorSteps, opts: {}, mode: undefined, rest };
    }

    // The single valid cell a minor suit-power step may affect, per
    // assertValidCellTarget in powers.ts: the minion's own cell if it's
    // facing "up", otherwise the one cell it's pointing at. Also used as
    // the DEFAULT target for "piece"-shaped modes (self is additionally
    // always valid there too, per assertValidPieceTarget - clicking the
    // minion's own cell switches to that instead, see
    // handlePendingStepBoardClick).
    private minorTargetCell(minion: IMinionRef): [number, number] {
        const piece = this.board.get(minion.x, minion.y)!.pieces[minion.index];
        if (piece.orientation === "up") {
            return [minion.x, minion.y];
        }
        const [dx, dy] = this.board.delta(piece.orientation as Exclude<Orientation, "up">);
        return [minion.x + dx, minion.y + dy];
    }

    // Inverse of resolvePieceRef: the shortest ref that resolves back to
    // this exact piece within the same pool (see resolvePieceRef's docs -
    // omitted here, defaults to every piece at the cell). Tries pips alone,
    // then pips+orientation alone, then pips+player alone (skipping
    // orientation if it didn't help), then all three together.
    private pieceRefStr(x: number, y: number, index: number, pool?: IMinionRef[]): string {
        const piece = this.board.get(x, y)!.pieces[index];
        const cell = GnosticaBoard.coords2algebraic(x, y);
        const candidateRefs = pool !== undefined
            ? pool.filter(p => p.x === x && p.y === y)
            : (this.board.get(x, y)?.pieces ?? []).map((_, i) => ({ x, y, index: i }));
        const byPips = candidateRefs
            .map(r => this.board.get(r.x, r.y)!.pieces[r.index])
            .filter(p => p.size === piece.size);
        if (byPips.length <= 1) {
            return `${cell}.${piece.size}`;
        }
        const orientLetter = this.orientationLetter(piece.orientation);
        if (byPips.filter(p => p.orientation === piece.orientation).length <= 1) {
            return `${cell}.${piece.size}.${orientLetter}`;
        }
        if (byPips.filter(p => p.owner === piece.owner).length <= 1) {
            return `${cell}.${piece.size}.${piece.owner}`;
        }
        return `${cell}.${piece.size}.${orientLetter}.${piece.owner}`;
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
    private legalMinorModes(pending: IPendingStep): string[] {
        // Only ever called for a suit-shaped pending - see buildStepModeMove's
        // own docs on why suitUid is guaranteed set here.
        const suitUid = pending.suitUid!;
        const minion = this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetT = this.board.get(tx, ty);
        return Object.keys(MINOR_MODES[suitUid]).filter(mode => {
            switch (`${suitUid}.${mode}`) {
                case "C.own":
                    return targetT === undefined || targetT.canAdd(pending.opts.ignoreCapacity === true);
                case "C.enemy":
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
    // IPendingStep's docs), and the target cell is auto-derived
    // (minorTargetCell) since it's fully determined by the minion's own
    // facing, not something the player needs to click. "Piece"-shaped
    // modes default to targeting the minion itself (always structurally
    // valid, regardless of what's in the facing cell) - clicking the
    // facing cell afterwards redirects to a piece there, see
    // handlePendingStepBoardClick. Deliberately produces a step with
    // FEWER tokens than MINOR_MODES' minArgs for modes needing a hand-card
    // uid (Cups "new", Discs/Swords "tile") - applyMinorPower's own
    // tolerance (see its docs) keeps that a harmless, still-provisional
    // "declined so far" state rather than a thrown error, until
    // supplyStepCardUid fills it in.
    // Cups "enemy"'s victim argument reuses the same <pips>[.<orientation>]
    // [.<player>] qualifier vocabulary as a full piece ref, just without
    // its own leading cell segment (the target cell is already "enemy"'s
    // own first argument) - built/read by borrowing pieceRefStr/
    // resolvePieceRef's own logic and stripping/re-adding the cell.
    private victimRefStr(x: number, y: number, index: number): string {
        const full = this.pieceRefStr(x, y, index);
        return full.slice(full.indexOf(".") + 1);
    }

    private resolveVictimRef(cellStr: string, suffix: string | undefined): PieceRefResolution {
        if (suffix === undefined) {
            return { kind: "malformed" };
        }
        return this.resolvePieceRef(`${cellStr}.${suffix}`);
    }

    private resolveVictimRefOrThrow(cellStr: string, suffix: string | undefined): { x: number; y: number; index: number } {
        const result = this.resolveVictimRef(cellStr, suffix);
        if (result.kind === "ok") {
            return result.ref;
        }
        if (result.kind === "ambiguous") {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.AMBIGUOUS_PIECE_REF", { ref: suffix }));
        }
        throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: result.kind === "malformed" ? "BAD_PIECE_REF" : "NO_SUCH_PIECE", ref: suffix }));
    }

    // Assembles a full move string from a pending step's own already-typed
    // PRIOR power-step segments (verbatim) plus the current one's tokens -
    // shared by every click helper below that builds/rebuilds a move, so
    // a major-arcana chain's earlier steps are never lost while a LATER
    // one is still being clicked together. For a minor card (priorSteps
    // always []) this reduces to exactly what these helpers built before
    // major-arcana chaining existed.
    private assembleStepMove(pending: IPendingStep, currentTokens: string[]): string {
        const segments = [...pending.priorSteps, currentTokens.join(" ")];
        return `${pending.head} ${pending.headArg}, ${segments.join(", ")}`;
    }

    private buildStepModeMove(pending: IPendingStep, mode: string): string {
        // Only ever called for a suit-shaped pending (a minor card, a
        // major card's own `primitive` step, or magicianChoice's 2nd
        // stage once a suit letter is chosen - see buildSpecialPending) -
        // suitUid is guaranteed set in every one of those cases, per
        // IPendingStep's own docs on the two branches being mutually
        // exclusive.
        const suitUid = pending.suitUid!;
        // Two different refs to the acting minion: `minionRef` fills the
        // step's own minion-selector slot (disambiguated only against the
        // player's OTHER minions currently in play - see resolvePieceRef's
        // docs on the "minion-selector" pool); `selfRef` is used wherever the same
        // piece is the DEFAULT TARGET of a "piece"-shaped mode instead
        // (disambiguated against every piece at that cell, any owner -
        // the "target" pool). These can differ, so they're never
        // interchangeable even though they name the same piece here.
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        const selfRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index);
        const [tx, ty] = this.minorTargetCell(pending.minion);
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        const tokens = [minionRef, ...pending.prefix, mode];
        switch (`${suitUid}.${mode}`) {
            case "C.own":
                tokens.push(targetCell, "U");
                break;
            case "C.enemy": {
                const t = this.board.get(tx, ty);
                const victim = (t?.pieces ?? []).find(p => p.owner !== this.currplayer);
                const victimIdx = victim !== undefined ? t!.pieces.indexOf(victim) : 0;
                tokens.push(targetCell, this.victimRefStr(tx, ty, victimIdx));
                break;
            }
            case "C.new":
                tokens.push(targetCell);
                break;
            case "R.piece":
                tokens.push(selfRef, "1");
                break;
            case "R.tile":
                tokens.push("1");
                break;
            case "D.piece":
                tokens.push(selfRef);
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
                tokens.push(facingHasPiece ? this.pieceRefStr(tx, ty, 0) : selfRef, "1");
                break;
            }
            case "S.tile":
                tokens.push(targetCell, "1");
                break;
            default:
                throw new Error(`Unknown minor mode "${suitUid}.${mode}".`);
        }
        return this.assembleStepMove(pending, tokens);
    }

    private pendingMoveString(pending: IPendingStep): string {
        if (pending.mode === undefined) {
            return pending.priorSteps.length === 0
                ? `${pending.head} ${pending.headArg}`
                : `${pending.head} ${pending.headArg}, ${pending.priorSteps.join(", ")}`;
        }
        const ref = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        return this.assembleStepMove(pending, [ref, ...pending.prefix, pending.mode, ...pending.rest]).trim();
    }

    // Board-click handling once a minor-arcana power step's MODE is already
    // chosen (see buildStepModeMove) - cycling or switching whichever
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
    private handlePendingStepBoardClick(pending: IPendingStep, x: number, y: number, cell: string): IClickResult | undefined {
        if (pending.mode === undefined) {
            return undefined;
        }
        // Only ever called for a suit-shaped pending - see buildStepModeMove's
        // own docs on why suitUid is guaranteed set here.
        const suitUid = pending.suitUid!;
        const mode = pending.mode;
        const config = MINOR_MODES[suitUid][mode];
        // Two refs to the same acting minion, same reasoning as
        // buildStepModeMove: `minionRef` (minions pool) always fills the
        // rebuilt move's own selector slot below; `selfRef` (target pool)
        // is used wherever the piece needs to be named as a TARGET instead
        // (the "piece"-shape branch's self/face comparisons and rebuilds).
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        const selfRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index);
        const minionPiece = this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        const rebuild = (rest: string[], messageKey?: string): IClickResult =>
            this.provisionalResult(this.assembleStepMove(pending, [minionRef, ...pending.prefix, mode, ...rest]), messageKey);

        if (config.shape === "cell") {
            const [tx, ty] = this.minorTargetCell(pending.minion);
            // Cups "own" is the one cell-shape mode with an orientation arg
            // (the new piece's own facing) - click-to-orient (see
            // orientationTowardClick) relative to the target cell, so its
            // clickable region is that cell PLUS its neighbours, not just
            // the cell itself like every other cell-shape mode below.
            if (suitUid === "C" && mode === "own") {
                const dir = this.orientationTowardClick(tx, ty, x, y);
                if (dir === undefined) {
                    return undefined;
                }
                return rebuild([GnosticaBoard.coords2algebraic(tx, ty), this.orientationLetter(dir)], "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE");
            }
            if (x !== tx || y !== ty) {
                return undefined;
            }
            if (suitUid === "C" && mode === "enemy") {
                const t = this.board.get(tx, ty);
                const enemyIndices = (t?.pieces ?? [])
                    .map((p, i) => ({ owner: p.owner, i }))
                    .filter(({ owner }) => owner !== this.currplayer)
                    .map(({ i }) => i);
                if (enemyIndices.length === 0) {
                    return { move: this.pendingMoveString(pending), valid: false, message: i18next.t("apgames:validation.gnostica.NO_ENEMY_THERE", { cell }) };
                }
                const currentResolution = this.resolveVictimRef(cell, pending.rest[1]);
                const current = currentResolution.kind === "ok" ? currentResolution.ref.index : -1;
                const at = enemyIndices.indexOf(current);
                const next = enemyIndices[(at + 1) % enemyIndices.length];
                return rebuild([cell, this.victimRefStr(tx, ty, next)]);
            }
            // "new" (Cups) / "tile" (Discs) - the only remaining arg is a
            // hand-card uid (supplyStepCardUid), nothing to cycle here.
            return rebuild(pending.rest);
        }

        if (config.shape === "piece") {
            const [faceX, faceY] = this.minorTargetCell(pending.minion);
            const isSelfClick = x === pending.minion.x && y === pending.minion.y;
            const isFaceClick = x === faceX && y === faceY;
            if (!isSelfClick && !isFaceClick) {
                return undefined;
            }
            const currentIsSelf = pending.rest[0] === selfRef;
            const needsNumeric = !(suitUid === "D" && mode === "piece");
            const switchingToSelf = isSelfClick && !currentIsSelf;
            const switchingToFace = isFaceClick && !(faceX === pending.minion.x && faceY === pending.minion.y) && currentIsSelf;
            if (switchingToSelf) {
                return rebuild(needsNumeric ? [selfRef, "1"] : [selfRef]);
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
    private supplyStepCardUid(pending: IPendingStep, uid: string): IClickResult | undefined {
        if (pending.mode === undefined) {
            return undefined;
        }
        const key = `${pending.suitUid}.${pending.mode}`;
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        let rest: string[];
        if ((key === "C.new" || key === "D.tile") && pending.rest.length === 1) {
            rest = [pending.rest[0], uid];
        } else if (key === "S.tile" && pending.rest.length === 2) {
            rest = [...pending.rest, uid];
        } else {
            return undefined;
        }
        return this.provisionalResult(this.assembleStepMove(pending, [minionRef, ...pending.prefix, pending.mode, ...rest]));
    }

    // Shared self-or-facing-cell target pick, used by every special power
    // whose target argument follows the exact same rule as a minor-arcana
    // "piece"-shaped mode's own target (checkValidPieceTarget in
    // powers.ts) - tradeHands, orientAny, hierophantReplace, and
    // hermitTeleport's own "piece" mode. Returns undefined when the click
    // isn't on the minion's own cell or its facing cell at all (caller
    // falls through to its own unrelated handling); a real error
    // IClickResult when it IS the facing cell but nothing's there to
    // target; otherwise the target's piece-ref string (against the
    // default "every piece at that cell, any owner" pool - see
    // resolvePieceRef's own docs on the "target" pool).
    private pickPieceTargetClick(minion: IMinionRef, x: number, y: number, cell: string, pendingForError: IPendingStep): string | IClickResult | undefined {
        const [faceX, faceY] = this.minorTargetCell(minion);
        if (x === minion.x && y === minion.y) {
            return this.pieceRefStr(minion.x, minion.y, minion.index);
        }
        if (x !== faceX || y !== faceY) {
            return undefined;
        }
        const t = this.board.get(faceX, faceY);
        if (t === undefined || t.pieces.length === 0) {
            return { move: this.pendingMoveString(pendingForError), valid: false, message: i18next.t("apgames:validation.gnostica.NO_PIECE_THERE", { cell }) };
        }
        return this.pieceRefStr(faceX, faceY, 0);
    }

    // Dispatches a board click to whichever special power's own click
    // handler is currently in progress - the `special`-flavored
    // counterpart to handlePendingStepBoardClick. Returns undefined for
    // judgementDraw/highPriestess/magicianChoice (stage 1)/hermitTeleport
    // (stage 1) - none of those have a board-click stage at all (discard-
    // pile clicks, hand-card clicks, or mode buttons instead - see
    // handleClickCore's own docs on each), so a board click there simply
    // isn't for this pending step. magicianChoice's OWN 2nd stage never
    // reaches here at all - buildSpecialPending already redirects it into
    // an ordinary suit-shaped pending, dispatched through
    // handlePendingStepBoardClick instead.
    private handlePendingSpecialBoardClick(pending: IPendingStep, x: number, y: number, cell: string): IClickResult | undefined {
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
            default:
                return undefined;
        }
    }

    // orientMinion: <minionRef> <orientation> - the acting minion IS the
    // target (no separate pick stage, unlike orientAny/hierophantReplace),
    // so this is just the top-level "orient" command's own click-to-orient
    // (orientationTowardClick), anchored at the fixed acting minion
    // instead of a freshly-picked one.
    private handleOrientMinionClick(pending: IPendingStep, x: number, y: number): IClickResult | undefined {
        const dir = this.orientationTowardClick(pending.minion.x, pending.minion.y, x, y);
        if (dir === undefined) {
            return undefined;
        }
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        return this.provisionalResult(
            this.assembleStepMove(pending, [minionRef, this.orientationLetter(dir)]),
            "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE",
        );
    }

    // tradeHands: <minionRef> <targetRef> - a single self-or-facing-cell
    // target pick, no further stage (no orientation involved).
    private handleTradeHandsClick(pending: IPendingStep, x: number, y: number, cell: string): IClickResult | undefined {
        const targetResult = this.pickPieceTargetClick(pending.minion, x, y, cell, pending);
        if (targetResult === undefined) {
            return undefined;
        }
        if (typeof targetResult !== "string") {
            return targetResult;
        }
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        return this.provisionalResult(this.assembleStepMove(pending, [minionRef, targetResult]));
    }

    // orientAny/hierophantReplace: <minionRef> <targetRef> <orientation> -
    // identical two-stage shape for both (orientAny reorients the target
    // in place; hierophantReplace swaps it for one of the acting player's
    // own, then orients THAT - either way the move string's own shape,
    // and this click flow, are the same). Stage 1 (pending.rest is empty):
    // the same self-or-facing-cell target pick as tradeHands, auto-seeding
    // a default orientation ("U") the instant a target is picked, so the
    // step becomes immediately complete. Stage 2 (target already in
    // pending.rest[0]): further clicks adjust ITS OWN orientation via
    // orientationTowardClick, anchored at the TARGET's cell rather than
    // the minion's. Deliberately doesn't support re-picking a different
    // target once one's already chosen (a self/face click at that point
    // would be genuinely ambiguous with "orient the target toward this
    // neighbour," since the target's own cell is frequently the minion's
    // self/face cell too) - same known-simplification precedent as
    // "orient"'s own re-selection; retype the segment by hand to change
    // targets instead.
    private handleOrientAnyOrHierophantClick(pending: IPendingStep, x: number, y: number, cell: string): IClickResult | undefined {
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        if (pending.rest.length === 0) {
            const targetResult = this.pickPieceTargetClick(pending.minion, x, y, cell, pending);
            if (targetResult === undefined) {
                return undefined;
            }
            if (typeof targetResult !== "string") {
                return targetResult;
            }
            return this.provisionalResult(
                this.assembleStepMove(pending, [minionRef, targetResult, "U"]),
                "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE",
            );
        }
        const targetRef = pending.rest[0];
        const targetResolution = this.resolvePieceRef(targetRef);
        if (targetResolution.kind !== "ok") {
            return undefined;
        }
        const dir = this.orientationTowardClick(targetResolution.ref.x, targetResolution.ref.y, x, y);
        if (dir === undefined) {
            return undefined;
        }
        return this.provisionalResult(
            this.assembleStepMove(pending, [minionRef, targetRef, this.orientationLetter(dir)]),
            "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE",
        );
    }

    // hermitTeleport: `piece <minionRef> piece <targetRef> <destCell>
    // [orientation]` | `piece <minionRef> tile <targetCell> <destCell>` -
    // mode is chosen via a button (hermit_piece/hermit_tile in
    // handleClickCore), which is always present (pending.rest[0]) by the
    // time a board click can reach here at all.
    private handleHermitTeleportClick(pending: IPendingStep, x: number, y: number, cell: string): IClickResult | undefined {
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        const mode = pending.rest[0];
        if (mode !== "piece" && mode !== "tile") {
            return undefined; // mode not chosen yet - only the hermit_piece/hermit_tile buttons can start this
        }
        if (mode === "tile") {
            // No self-vs-face CHOICE for a cell-shaped target - minorTargetCell
            // already computes the one legal cell deterministically, same
            // as Discs/Swords "tile" mode's own target - so any click here
            // just sets/replaces the (unrestricted) destination.
            const [tx, ty] = this.minorTargetCell(pending.minion);
            const targetCellStr = GnosticaBoard.coords2algebraic(tx, ty);
            return this.provisionalResult(this.assembleStepMove(pending, [minionRef, "tile", targetCellStr, cell]));
        }
        // "piece" mode: the target is a genuine self-or-facing-cell choice
        // (mirrors Rods "piece" mode's own redirect) until a destination
        // is picked - after that, further clicks only replace the
        // destination. The destination itself is Hermit's one genuinely
        // new click primitive: unrestricted, no adjacency limit at all,
        // unlike every other click-to-target flow in this file (see
        // checkHermitMovePiece's own docs on why). The optional trailing
        // orientation stays hand-typed-only this pass - it's optional, so
        // this doesn't block submission.
        if (pending.rest.length < 3) {
            const targetResult = this.pickPieceTargetClick(pending.minion, x, y, cell, pending);
            if (typeof targetResult === "string") {
                return this.provisionalResult(this.assembleStepMove(pending, [minionRef, "piece", targetResult]));
            }
            if (targetResult !== undefined) {
                return targetResult; // NO_PIECE_THERE at the facing cell
            }
            // Not a self/face click - once a target's already picked,
            // treat this as the destination instead; otherwise there's
            // nothing to build yet (pick a target first).
            if (pending.rest.length < 2) {
                return undefined;
            }
            return this.provisionalResult(this.assembleStepMove(pending, [minionRef, "piece", pending.rest[1], cell]));
        }
        return this.provisionalResult(this.assembleStepMove(pending, [minionRef, "piece", pending.rest[1], cell]));
    }

    // Click support for the top-level turn choice (via the button bar from
    // getActionButtons()) plus the simple, single-segment actions - place,
    // orient, activate/play with power declined, and toggling hand cards
    // into a discard's uid list. activate/play's chained power steps
    // aren't click-driven yet (deliberately scoped out of this pass).
    //
    // "Declare" is handled up front, separately from everything else -
    // it's the one click that operates on the "(last)" flag directly
    // (toggling it), rather than building/replacing the move's base
    // action. Every OTHER click below is handled with "(last)" stripped
    // off first (so none of that logic has to know it exists) and
    // reattached to whatever move string comes back out - see
    // reattachLastFlag - so the flag survives no matter what the player
    // clicks next, including switching to a completely different action
    // after already declaring.
    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        const parsed = this.parseMove(move);
        if (piece === "_btn_declare") {
            return this.provisionalResult(this.stringifyMove({ ...parsed, announceLast: !parsed.announceLast }));
        }
        const bareMove = this.stringifyMove({ ...parsed, announceLast: false });
        const result = this.handleClickCore(bareMove, row, col, piece);
        return this.reattachLastFlag(result, parsed.announceLast);
    }

    // Reattaches "(last)" to a click result computed against the
    // last-stripped move, if it was present going in. A still-incomplete
    // result (complete: -1 - either a friendly, deliberately-not-validated
    // button-seeded result, or a genuinely in-progress real move)
    // gets the flag spliced on as-is, since it isn't submittable yet
    // regardless; a complete, currently-valid result gets properly
    // re-validated on the combined string instead, so a move that's only
    // illegal BECAUSE of declaring (ALREADY_ANNOUNCED) is still caught
    // right when it matters. An outright error result (valid: false)
    // still gets the flag spliced into the echoed-back `.move` for
    // display, but keeps its own real error message untouched.
    private reattachLastFlag(result: IClickResult, announceLast: boolean): IClickResult {
        if (!announceLast || result.move === undefined) {
            return result;
        }
        const combined = this.stringifyMove({ ...this.parseMove(result.move), announceLast: true });
        if (result.valid && result.complete !== -1) {
            return this.provisionalResult(combined);
        }
        return { ...result, move: combined };
    }

    private handleClickCore(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            if (piece !== undefined && piece.startsWith("_btn_")) {
                const value = piece.slice("_btn_".length);
                if (value.startsWith("mode_")) {
                    // "mode_<suitUid>_<mode>" - see getActionButtons()'s own
                    // pendingMinor branch, which only ever offers one of
                    // these once a minor-arcana activate/play is already
                    // seeded (0 steps taken yet).
                    const [, suitUid, mode] = value.split("_");
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.suitUid !== suitUid) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    // Cups "own" seeds its new piece's facing as "up" by
                    // default (see buildStepModeMove's own C.own case) -
                    // still adjustable by clicking around the target cell,
                    // same as place/orient's own click-to-orient.
                    const seedsAdjustableDirection = suitUid === "C" && mode === "own";
                    return this.provisionalResult(
                        this.buildStepModeMove(pending, mode),
                        seedsAdjustableDirection ? "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE" : undefined,
                    );
                }
                if (value.startsWith("magician_")) {
                    // Stage 1 of magicianChoice - picks the suit letter.
                    // Once present, buildSpecialPending's own magicianChoice
                    // branch redirects `pending` into an ordinary suit-shaped
                    // one, so every FOLLOWING click (mode buttons, board
                    // clicks, hand-card supply) goes through the existing,
                    // unmodified suit-mode machinery - see its own docs.
                    const suitUid = value.slice("magician_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.special !== "magicianChoice") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
                    return this.provisionalResult(this.assembleStepMove(pending, [minionRef, suitUid]));
                }
                if (value.startsWith("hermit_")) {
                    // Stage 1 of hermitTeleport - picks piece/tile mode,
                    // seeding "piece"'s target to self by default (mirrors
                    // Rods "piece" mode's own default) - "tile"'s target has
                    // no self-vs-face choice at all (see handleHermitTeleportClick's
                    // own docs), so it's filled in immediately too.
                    const mode = value.slice("hermit_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.special !== "hermitTeleport") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
                    if (mode === "piece") {
                        const selfRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index);
                        return this.provisionalResult(this.assembleStepMove(pending, [minionRef, "piece", selfRef]));
                    }
                    if (mode === "tile") {
                        const [tx, ty] = this.minorTargetCell(pending.minion);
                        const targetCellStr = GnosticaBoard.coords2algebraic(tx, ty);
                        return this.provisionalResult(this.assembleStepMove(pending, [minionRef, "tile", targetCellStr]));
                    }
                    return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                }
                if (value.startsWith("drawcount_")) {
                    // The count-picker buttons getActionButtons() offers
                    // once "discard" is the live head and no "draw <n>"
                    // suffix has been chosen yet - see its own docs. Always
                    // rebuilt from the move's current discard uids (there's
                    // never an existing "draw <n>" tail to strip here,
                    // since the button set itself stops being offered the
                    // moment one is present).
                    const n = value.slice("drawcount_".length);
                    const parsed = this.parseMove(move);
                    if (parsed.head?.toLowerCase() !== "discard") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    return this.provisionalResult(["discard", ...parsed.rest, "draw", n].join(" "));
                }
                switch (value) {
                    case "pass":
                    case "discard":
                        // Discard's own bare seed is already a legal,
                        // complete move on its own (discard nothing, draw
                        // the max) - no different from Pass, so both just
                        // build it.
                        return this.provisionalResult("discard");
                    case "place":
                        // Not strictly necessary (an empty move already
                        // builds "place <cell>" directly from a bare board
                        // click, see below), but offered as a button too
                        // for consistency with every other action, now
                        // that "place" is always shown as the sole choice
                        // rather than an empty bar - see getActionButtons().
                        return { move: "place", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CELL_TO_PLACE") };
                    case "use":
                        return { move: "use", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CARD_TO_ACTIVATE") };
                    case "play":
                        return { move: "play", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_HAND_CARD_TO_PLAY") };
                    case "orient":
                        return { move: "orient", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_PIECE_TO_ORIENT") };
                    default:
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                }
            }

            // Only the head segment's own tokens are needed here; the
            // pending-step helpers below (parsePendingStep etc.) do
            // their own full parsing of the rest.
            const { head, rest: args } = this.parseMove(move);

            // Hand-card clicks (from the per-player AreaPieces built in
            // render()) arrive as `piece`, independent of row/col - only
            // the acting player's own hand can be touched. A card click
            // means something different depending on what's already in
            // progress: supplying a card uid for a pending minor-arcana
            // power step in progress (Cups "new", Discs/Swords "tile"),
            // playing the card outright ("play"), or toggling it into a
            // discard's uid list (the default, if no mode is active).
            if (piece !== undefined && piece.startsWith("hand_")) {
                const uid = piece.slice("hand_".length);
                const hand = this.hands[this.currplayer - 1] ?? [];
                if (!hand.includes(uid)) {
                    return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
                }
                const pendingForCard = this.parsePendingStep(move, { preferCurrent: true });
                if (pendingForCard?.mode !== undefined) {
                    const result = this.supplyStepCardUid(pendingForCard, uid);
                    if (result !== undefined) {
                        return result;
                    }
                    // Not a mode expecting a card uid right now - fall
                    // through to the ordinary hand-card behaviour below.
                }
                if (pendingForCard?.special === "highPriestess") {
                    // Same toggle-into-a-list mechanic as "discard"'s own
                    // uid list below, just scoped to this in-progress
                    // step's own token list (no minionRef prefix at all -
                    // see IPendingStep's own docs) rather than the
                    // top-level move's args. Checked BEFORE the
                    // `head === "play"` case below, since resolving High
                    // Priestess via "play" would otherwise misread this
                    // click as "play this card" instead.
                    let discards = [...pendingForCard.rest];
                    if (discards.includes(uid)) {
                        discards = discards.filter(u => u !== uid);
                    } else {
                        discards.push(uid);
                    }
                    return this.provisionalResult(this.assembleStepMove(pendingForCard, discards));
                }
                if (head === "play") {
                    return this.provisionalResult(`play ${uid}`, "apgames:validation.gnostica.POWER_STILL_OPTIONAL");
                }
                // Any already-chosen "draw <n>" tail is deliberately
                // dropped here rather than carried forward - the valid
                // count range shifts with the discard list itself, so
                // changing which cards are discarded re-solicits the count
                // fresh (via getActionButtons()'s own count-picker) rather
                // than silently keeping a now-possibly-invalid number.
                const drawIdx = head === "discard" ? args.indexOf("draw") : -1;
                let discards = head === "discard" ? (drawIdx === -1 ? [...args] : args.slice(0, drawIdx)) : [];
                if (discards.includes(uid)) {
                    discards = discards.filter(u => u !== uid);
                } else {
                    discards.push(uid);
                }
                return this.provisionalResult(["discard", ...discards].join(" "));
            }

            // Discard-pile clicks (from the AreaPieces built by
            // buildDeckSummaryArea) drive judgementDraw only - every other
            // in-progress action ignores them. A major-arcana entry
            // (`discard_<uid>`) is unambiguous and toggles exactly like a
            // hand card; a minor-arcana bucket (`discard_<suitUid>_spot`|
            // `discard_<suitUid>_royal`) has no individual identity in the
            // render at all (buildDeckSummaryArea groups them for display),
            // so per your direction, clicking one draws a uniformly-random
            // not-yet-selected uid from it - clicking the SAME bucket again
            // removes the most-recently-added-from-it uid, a symmetric
            // add/remove without the player ever seeing which card it was
            // until it's actually in their hand.
            if (piece !== undefined && piece.startsWith("discard_")) {
                const key = piece.slice("discard_".length);
                const pendingForDiscard = this.parsePendingStep(move, { preferCurrent: true });
                if (pendingForDiscard?.special !== "judgementDraw") {
                    return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                }
                const minionRef = this.pieceRefStr(pendingForDiscard.minion.x, pendingForDiscard.minion.y, pendingForDiscard.minion.index, pendingForDiscard.minions);
                const selected = pendingForDiscard.rest;
                const minionPiece = this.board.get(pendingForDiscard.minion.x, pendingForDiscard.minion.y)!.pieces[pendingForDiscard.minion.index];
                const maxDraw = Math.min(minionPiece.size, Math.max(0, 6 - (this.hands[this.currplayer - 1]?.length ?? 0)));
                const rebuildDiscard = (updated: string[]): IClickResult =>
                    this.provisionalResult(this.assembleStepMove(pendingForDiscard, [minionRef, ...updated]));

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
                    const minor = card as MinorCard;
                    return minor.suit.uid === bucketSuit && (minor.rank.court ? "royal" : "spot") === bucketCategory;
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
                    return { move: this.pendingMoveString(pendingForDiscard), valid: false, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NOT_IN_DISCARD", uid: key }) };
                }
                const picked = candidates[Math.floor(Math.random() * candidates.length)];
                return rebuildDiscard([...selected, picked]);
            }

            const minX = this.board.minX - 1;
            const minY = this.board.minY - 1;
            const x = col + minX;
            const y = row + minY;
            const cell = GnosticaBoard.coords2algebraic(x, y);

            let newmove: string;
            // Overrides the generic VALID_MOVE message for a board-click
            // result that's already complete/submittable but still
            // deliberately soft-pedals that: DIRECTION_STILL_ADJUSTABLE
            // (place/orient's own facing, defaulted to "up" or set to
            // whatever neighbour was clicked, never the player's final
            // word on it - Cups "own"'s new-piece facing sets this too,
            // separately, in handlePendingStepBoardClick) and
            // POWER_STILL_OPTIONAL (activate/play's bare "<cell>"/"<uid>"
            // state right after picking the card, before any suit mode or
            // power step - the move is already legal as a decline, but
            // picking a power is the more usual next step; the "play"
            // half of this is set in the hand-card click branch below,
            // not here). See provisionalResult's own messageKey param.
            let resultMessageKey: string | undefined;

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
                    newmove = `place ${prevCell} ${this.orientationLetter(dir)}`;
                } else {
                    newmove = `place ${cell}`;
                }
                resultMessageKey = "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE";
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
                    const loc = this.resolvePieceRefOrThrow(prevRef);
                    dir = this.orientationTowardClick(loc.x, loc.y, x, y);
                }
                if (prevRef !== undefined && dir !== undefined) {
                    newmove = `orient ${prevRef} ${this.orientationLetter(dir)}`;
                } else {
                    const myPieceIdx = this.board.get(x, y)?.pieces.findIndex(p => p.owner === this.currplayer) ?? -1;
                    if (myPieceIdx === -1) {
                        return { move, valid: false, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_SUCH_PIECE", ref: cell }) };
                    }
                    newmove = `orient ${this.pieceRefStr(x, y, myPieceIdx)} U`;
                }
                resultMessageKey = "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE";
            } else if (head === "use" || head === "play") {
                // Once a minor-arcana power step's mode is already chosen,
                // a board click is target/arg cycling for that step first -
                // see handlePendingStepBoardClick's own docs. Falls
                // through to the ordinary activate/play handling below only
                // when the click doesn't match one of that step's own
                // interactive targets (undefined).
                const pending = this.parsePendingStep(move, { preferCurrent: true });
                // A completed PRIOR step's own interactive region (self/
                // facing-cell clicks) frequently overlaps the exact same
                // cells a FOLLOWING button-less special power
                // (orientMinion/tradeHands/orientAny/hierophantReplace)
                // would use to begin - unlike a primitive step (a mode
                // button) or hermitTeleport/magicianChoice (their own
                // button set), those four have no button to explicitly
                // trigger the advance, so a board click is their ONLY way
                // to begin at all. Tried FIRST, ahead of refining the
                // current step further, so that starting the next step is
                // reachable - the tradeoff (documented, not a bug):
                // redirecting a just-completed prior step's own target via
                // click is no longer possible once a button-less special
                // step follows it; retype that portion by hand instead.
                // Re-parses WITHOUT preferCurrent (the "advance past a
                // complete step" behaviour) - see parsePendingStep's own
                // docs - and only tries it when that's a genuinely FRESH,
                // further-along step than `pending` itself represents.
                const advanced = this.parsePendingStep(move);
                if (advanced !== undefined && advanced.special !== undefined && advanced.rest.length === 0
                    && advanced.priorSteps.length > (pending?.priorSteps.length ?? -1)) {
                    const result = this.handlePendingSpecialBoardClick(advanced, x, y, cell);
                    if (result !== undefined) {
                        return result;
                    }
                }
                if (pending !== undefined && pending.mode !== undefined) {
                    const result = this.handlePendingStepBoardClick(pending, x, y, cell);
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
                newmove = `use ${t.card.uid}`;
                resultMessageKey = "apgames:validation.gnostica.POWER_STILL_OPTIONAL";
            } else if (!this.hasPiecesOnBoard(this.currplayer)) {
                // Fresh click, nothing placed yet - place is the only legal
                // start, and needs no button.
                newmove = `place ${cell}`;
                resultMessageKey = "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE";
            } else {
                // No mode chosen yet (or an unrecognized one) and pieces
                // already exist - board clicks are genuinely ambiguous
                // here (see getActionButtons()'s docs), so this doesn't
                // guess; the player picks a button first.
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
            }

            return this.provisionalResult(newmove, resultMessageKey);
        } catch {
            return {
                move,
                valid: false,
                message: i18next.t("apgames:validation._general.DEFAULT_HANDLER"),
            };
        }
    }

    // "If you have no pieces on the board, you may only put a small piece
    // [...]. Otherwise, do one of the following [...]" - place is the only
    // legal action with zero board pieces; every other action requires
    // this. Also true again the instant a wipeout leaves a player with
    // none - no separate tracking needed for that case, since this always
    // recomputes fresh from current board state. See move()'s and
    // validateMove()'s own single top-level gate, cmdPlace/validatePlace's
    // own (inverse) check, getActionButtons(), and randomMove().
    private hasPiecesOnBoard(player: playerid): boolean {
        for (const [, , t] of this.board.entries()) {
            if (t.pieces.some(p => p.owner === player)) {
                return true;
            }
        }
        return false;
    }

    private parseOrientation(s: string): Orientation {
        if (s.toUpperCase() === "U") {
            return "up";
        }
        const dir = s.toUpperCase();
        if ((cardinalOrientations as string[]).includes(dir)) {
            return dir as Orientation;
        }
        throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: s }));
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
        const orientation = this.parseOrientation(orientationStr ?? "U");
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
        const orientation = this.tryParseOrientation(orientationStr ?? "U");
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

    // "orient <pieceRef> <facing>" - only your own piece.
    private cmdOrient(args: string[]): void {
        const [ref, orientationStr] = args;
        if (ref === undefined || orientationStr === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.ORIENT_ARGS_REQUIRED"));
        }
        const { x, y, index } = this.resolvePieceRefOrThrow(ref);
        const piece = this.board.get(x, y)!.pieces[index];
        if (piece.owner !== this.currplayer) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NOT_YOUR_MINION"));
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
        const result = this.resolvePieceRef(ref);
        if (result.kind !== "ok") {
            return this.invalidPieceRef(result.kind, ref);
        }
        const { x, y, index } = result.ref;
        const piece = this.board.get(x, y)!.pieces[index];
        if (piece.owner !== this.currplayer) {
            return this.invalid("apgames:validation.gnostica.NOT_YOUR_MINION");
        }
        if (this.tryParseOrientation(orientationStr) === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr });
        }
        return undefined;
    }

    // "discard [uid...] [draw <n>]" - discard the named hand cards, then
    // draw back: exactly <n> if "draw <n>" is given (0 up to however much
    // room is left in a 6-card hand - it's always legal to draw fewer than
    // the max), or as many as possible if "draw <n>" is omitted entirely
    // (the only behaviour before this command could under-draw on
    // purpose). Reshuffles the discard pile into the draw pile if it runs
    // dry, same as every other draw-pile-exhaustion spot - see
    // reshuffleIfDrawPileEmpty's twin logic in gnostica/powers.ts (this one
    // can't share that helper directly, since it mutates this.drawPile/
    // this.discardPile rather than a PowerContext's).
    //
    // `partial` (set only by move()'s live-preview calls, never by a real
    // submitted move) stops after the discard step, deliberately skipping
    // the redraw - the player may still be clicking through more cards to
    // discard or choosing a count, and drawing replacements prematurely
    // would either reveal cards for a choice that isn't final yet, or
    // require redrawing (and discarding the previous preview's draws back
    // into the deck) on every subsequent click. The hand simply shows
    // smaller while this is in progress; the real draw only happens once,
    // on final submission.
    private cmdDiscard(args: string[], partial = false): void {
        const hand = this.hands[this.currplayer - 1];
        const drawIdx = args.indexOf("draw");
        const discardUids = drawIdx === -1 ? args : args.slice(0, drawIdx);
        for (const uid of discardUids) {
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
        const maxDraw = Math.max(0, 6 - hand.length);
        let count = maxDraw;
        if (drawIdx !== -1) {
            const countStr = args[drawIdx + 1];
            const parsedCount = countStr === undefined ? NaN : Number(countStr);
            if (!Number.isInteger(parsedCount) || parsedCount < 0 || parsedCount > maxDraw) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_DRAW_COUNT", { requested: countStr, max: maxDraw }));
            }
            count = parsedCount;
        }
        let drawnCount = 0;
        while (drawnCount < count) {
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

    // Mirrors cmdDiscard's own "discard [uid...] [draw <n>]" grammar and
    // logic, non-mutating. Every named discard uid is checked up front,
    // including rejecting the same uid named twice - cmdDiscard's own loop
    // mutates the hand as it goes, so a repeated uid already fails there
    // (found once, then genuinely gone from hand on the second lookup);
    // this reproduces that without actually mutating anything.
    private validateDiscard(args: string[]): IValidationResult | undefined {
        const hand = this.hands[this.currplayer - 1];
        const drawIdx = args.indexOf("draw");
        const discardUids = drawIdx === -1 ? args : args.slice(0, drawIdx);
        const seen = new Set<string>();
        for (const uid of discardUids) {
            if (seen.has(uid)) {
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "DUPLICATE_CARD", uid });
            }
            seen.add(uid);
            if (!hand.includes(uid)) {
                return this.invalid("apgames:validation.gnostica.NOT_IN_HAND", { uid });
            }
        }
        if (drawIdx !== -1) {
            const maxDraw = Math.max(0, 6 - (hand.length - discardUids.length));
            const countStr = args[drawIdx + 1];
            const count = countStr === undefined ? NaN : Number(countStr);
            if (!Number.isInteger(count) || count < 0 || count > maxDraw) {
                return this.invalid("apgames:validation.gnostica.BAD_DRAW_COUNT", { requested: countStr, max: maxDraw });
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

    // "use <cardUid>" targets a card by its own identity, not a cell - every
    // card uid is unique across the whole 78-card deck, so this is
    // unambiguous, and it matches "play <uid>"'s own by-identity targeting.
    // Returns undefined for a uid that isn't currently on the board
    // anywhere (whether or not it's a real card at all - that distinction
    // is the caller's job to report separately, see cmdActivate/
    // validateActivate's own UNKNOWN_CARD vs CARD_NOT_ON_BOARD split).
    private findCardCell(uid: string): { x: number; y: number } | undefined {
        for (const [x, y, t] of this.board.entries()) {
            if (t.card?.uid === uid) {
                return { x, y };
            }
        }
        return undefined;
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
        const [cardUid] = args;
        if (cardUid === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.ACTIVATE_UID_REQUIRED"));
        }
        if (allCards().find(c => c.uid === cardUid) === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.UNKNOWN_CARD", { uid: cardUid }));
        }
        const loc = this.findCardCell(cardUid);
        if (loc === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.CARD_NOT_ON_BOARD", { uid: cardUid }));
        }
        const { x, y } = loc;
        const t = this.board.get(x, y)!;
        const eligible = this.eligibleMinionsForActivate(x, y);
        if (eligible.length === 0) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_MINIONS_THERE", { uid: cardUid }));
        }
        this.applyCardPower(t.card!, eligible, stepSegments);
    }

    private validateActivate(args: string[], stepSegments: string[][]): IValidationResult | undefined {
        const [cardUid] = args;
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
        return this.validateCardPower(t.card!, eligible, stepSegments);
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
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "FOOL_WORLD_NOT_YET_SUPPORTED" }));
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
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "FOOL_WORLD_NOT_YET_SUPPORTED" });
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
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "MINOR_ONE_STEP_ONLY" }));
        }
        const [minionRef, mode, ...rest] = stepSegments[0];
        if (minionRef === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" }));
        }
        const minion = this.resolvePieceRefOrThrow(minionRef, eligible, "NOT_AN_ELIGIBLE_MINION");
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
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "MINOR_ONE_STEP_ONLY" });
        }
        const [minionRef, mode, ...rest] = stepSegments[0];
        if (minionRef === undefined) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" });
        }
        const result = this.resolvePieceRef(minionRef, eligible);
        if (result.kind !== "ok") {
            return this.invalidPieceRef(result.kind, minionRef, "NOT_AN_ELIGIBLE_MINION");
        }
        const minion = result.ref;
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
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "TOO_MANY_POWER_STEPS" }));
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
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "TOO_MANY_POWER_STEPS" });
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
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" }));
        }
        const minion = this.resolvePieceRefOrThrow(minionRef, minions, "NOT_AN_ELIGIBLE_MINION");
        if ("primitive" in step) {
            const [mode, ...modeArgs] = rest;
            const suitUid = step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S";
            // Same "declined so far" tolerance applyMinorPower's own single
            // step already has - a major card's primitive step is no
            // different from a minor card's own, and Phase A's click flow
            // relies on it identically (a mode-button click for Cups
            // "new"/Discs or Swords "tile" deliberately produces fewer
            // tokens than minArgs, waiting on a hand-card uid supply).
            if (mode === undefined) {
                return undefined; // minion earmarked, mode not chosen yet - still declined
            }
            const config = MINOR_MODES[suitUid]?.[mode];
            if (config === undefined) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: suitUid }));
            }
            if (modeArgs.length < config.minArgs) {
                return undefined; // mode chosen, args not yet complete - still declined
            }
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts);
            return this.applySuitPrimitive(suitUid, minion, mode, modeArgs, opts);
        }
        // orientMinion/tradeHands/orientAny/hierophantReplace all have a
        // fixed arg count once complete (SPECIAL_MIN_TOKENS, minus the
        // leading minionRef already stripped above) - same "declined so
        // far" tolerance as everything else in this function, for a
        // hand-typed partial segment (my own click flows never expose an
        // incomplete state for these four, since each click either
        // produces a fully-complete segment or is rejected outright - see
        // handleOrientMinionClick/handleTradeHandsClick/
        // handleOrientAnyOrHierophantClick's own docs).
        if (
            (step.special === "orientMinion" || step.special === "tradeHands" || step.special === "orientAny" || step.special === "hierophantReplace")
            && rest.length < SPECIAL_MIN_TOKENS[step.special] - 1
        ) {
            return undefined;
        }
        switch (step.special) {
            case "orientMinion":
                return this.applyOrientMinion(minion, rest);
            case "orientAny":
                return this.applyOrientAny(minion, rest);
            case "hierophantReplace":
                return this.applyHierophantReplace(minion, rest);
            case "hermitTeleport": {
                // Same "declined so far" tolerance a primitive step's own
                // mode+args get (see applyPowerStep's own docs) -
                // hermitTeleport's mode/target/destination are built up
                // via clicks the exact same incremental way.
                const [hermitMode, ...hermitArgs] = rest;
                if (hermitMode === undefined) {
                    return undefined; // mode not chosen yet - still declined
                }
                if (hermitMode !== "piece" && hermitMode !== "tile") {
                    throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode: hermitMode, suit: "Hermit" }));
                }
                if (hermitArgs.length < 2) {
                    return undefined; // mode chosen, target/destination not yet complete - still declined
                }
                return this.applyHermitStep(minion, rest);
            }
            case "tradeHands":
                return this.applyTradeHands(minion, rest);
            case "judgementDraw":
                this.applyJudgementDraw(minion, rest);
                return undefined;
            case "magicianChoice":
                return this.applyMagicianChoice(minion, rest);
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "SPECIAL_NOT_YET_SUPPORTED", special: step.special }));
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
            return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" }) };
        }
        const result = this.resolvePieceRef(minionRef, minions);
        if (result.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(result.kind, minionRef, "NOT_AN_ELIGIBLE_MINION") };
        }
        const minion = result.ref;
        if ("primitive" in step) {
            const [mode, ...modeArgs] = rest;
            const suitUid = step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S";
            // Mirrors applyPowerStep's own tolerance - see its docs.
            if (mode === undefined) {
                return { failed: false }; // minion earmarked, mode not chosen yet - still declined
            }
            const config = MINOR_MODES[suitUid]?.[mode];
            if (config === undefined) {
                return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: suitUid }) };
            }
            if (modeArgs.length < config.minArgs) {
                return { failed: false }; // mode chosen, args not yet complete - still declined
            }
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts);
            return this.validateSuitPrimitive(suitUid, minion, mode, modeArgs, opts);
        }
        // Mirrors applyPowerStep's own tolerance - see its docs.
        if (
            (step.special === "orientMinion" || step.special === "tradeHands" || step.special === "orientAny" || step.special === "hierophantReplace")
            && rest.length < SPECIAL_MIN_TOKENS[step.special] - 1
        ) {
            return { failed: false };
        }
        switch (step.special) {
            case "orientMinion":
                return this.validateOrientMinion(minion, rest);
            case "orientAny":
                return this.validateOrientAny(minion, rest);
            case "hierophantReplace":
                return this.validateHierophantReplace(minion, rest);
            case "hermitTeleport": {
                // Mirrors applyPowerStep's own tolerance - see its docs.
                const [hermitMode, ...hermitArgs] = rest;
                if (hermitMode === undefined) {
                    return { failed: false }; // mode not chosen yet - still declined
                }
                if (hermitMode !== "piece" && hermitMode !== "tile") {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode: hermitMode, suit: "Hermit" }) };
                }
                if (hermitArgs.length < 2) {
                    return { failed: false }; // mode chosen, target/destination not yet complete - still declined
                }
                return this.validateHermitStep(minion, rest);
            }
            case "tradeHands":
                return this.validateTradeHands(minion, rest);
            case "judgementDraw": {
                const failure = this.validateJudgementDraw(minion, rest);
                return failure !== undefined ? { failed: true, result: failure } : { failed: false };
            }
            case "magicianChoice":
                return this.validateMagicianChoice(minion, rest);
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "SPECIAL_NOT_YET_SUPPORTED", special: step.special }) };
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

    // Cups - own <cell> <orientation> | enemy <cell> <victimRef> | new <cell> (<uid>|random)
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
            case "enemy": {
                const [cellStr, victimRef] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const { index: victimIndex } = this.resolveVictimRefOrThrow(cellStr, victimRef);
                createEnemy(ctx, minion.x, minion.y, minion.index, tx, ty, victimIndex, opts);
                this.results.push({ type: "place", where: cellStr, how: "cups-enemy" });
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
            case "enemy": {
                const [cellStr, victimRef] = rest;
                const coords = this.tryAlgebraic2coords(cellStr);
                if (coords === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr }) };
                }
                const [tx, ty] = coords;
                const victimResult = this.resolveVictimRef(cellStr, victimRef);
                if (victimResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(victimResult.kind, victimRef) };
                }
                const failure = checkCreateEnemy(ctx, minion.x, minion.y, minion.index, tx, ty, victimResult.ref.index, opts);
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
                const target = this.resolvePieceRefOrThrow(targetRef);
                const dist = parseInt(distStr, 10);
                const newOrientation = orientationStr !== undefined ? this.parseOrientation(orientationStr) : undefined;
                // Captured before the move mutates the board, to compute
                // where the piece actually ends up for the result log and
                // the minion-chaining check below.
                const movedOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
                const facing = this.board.get(minion.x, minion.y)!.pieces[minion.index].orientation;
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "up">);
                const destX = target.x + dx * dist;
                const destY = target.y + dy * dist;
                // A genuine final landing (not a Chariot-relaxed waypoint)
                // in the void destroys the piece instead of moving it -
                // see movePiece's own docs.
                const destroyedInVoid = opts.skipLandingCheck !== true && this.board.classify(destX, destY) === "void";
                movePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, dist, newOrientation, opts);
                if (destroyedInVoid) {
                    this.results.push({ type: "destroy", what: targetRef });
                    return {};
                }
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
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const dist = parseInt(distStr, 10);
                if (Number.isNaN(dist)) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_NUMBER", value: distStr }) };
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
                const destroyedInVoid = opts.skipLandingCheck !== true && this.board.classify(destX, destY) === "void";
                if (destroyedInVoid) {
                    return { failed: false };
                }
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
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_NUMBER", value: distStr }) };
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
                const target = this.resolvePieceRefOrThrow(targetRef);
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
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
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
                const target = this.resolvePieceRefOrThrow(targetRef);
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
                const targetResult = this.resolvePieceRef(targetRef);
                if (targetResult.kind !== "ok") {
                    return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
                }
                const target = targetResult.ref;
                const pips = parseInt(pipsStr, 10);
                if (Number.isNaN(pips)) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_NUMBER", value: pipsStr }) };
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
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_NUMBER", value: pipsStr }) };
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
        const target = this.resolvePieceRefOrThrow(targetRef);
        const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const orientation = this.parseOrientation(orientationStr);
        orientAny(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.results.push({ type: "orient", where: targetRef, facing: orientation });
        return owner === this.currplayer ? { newMinion: target } : {};
    }

    private validateOrientAny(minion: IMinionRef, rest: string[]): StepValidation {
        const [targetRef, orientationStr] = rest;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
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
        const target = this.resolvePieceRefOrThrow(targetRef);
        const orientation = this.parseOrientation(orientationStr);
        hierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.results.push({ type: "convert", what: targetRef, into: `owner-${this.currplayer}`, where: targetRef });
        const newIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
        return { newMinion: { x: target.x, y: target.y, index: newIndex } };
    }

    private validateHierophantReplace(minion: IMinionRef, rest: string[]): StepValidation {
        const [targetRef, orientationStr] = rest;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
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
            const target = this.resolvePieceRefOrThrow(targetRef);
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
            const targetResult = this.resolvePieceRef(targetRef);
            if (targetResult.kind !== "ok") {
                return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
            }
            const target = targetResult.ref;
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
        const target = this.resolvePieceRefOrThrow(targetRef);
        const targetOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        const otherHand = this.hands[targetOwner - 1];
        tradeHands(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, otherHand);
        this.results.push({ type: "announce", payload: ["tradeHands", this.currplayer, targetOwner] });
        return {};
    }

    private validateTradeHands(minion: IMinionRef, rest: string[]): StepValidation {
        const [targetRef] = rest;
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
    private applyMagicianChoice(minion: IMinionRef, rest: string[]): IStepOutcome | undefined {
        const [suitLetter, mode, ...args] = rest;
        if (suitLetter === undefined) {
            return undefined; // minion earmarked, suit not chosen yet - still declined
        }
        if (!["C", "R", "D", "S"].includes(suitLetter)) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_SUIT_LETTER", { suitLetter }));
        }
        // Same "declined so far" tolerance a primitive step's own mode
        // gets (see applyPowerStep's docs) - magicianChoice's suit choice
        // is really just an extra token in front of that same grammar.
        if (mode === undefined) {
            return undefined; // suit chosen, mode not chosen yet - still declined
        }
        const config = MINOR_MODES[suitLetter]?.[mode];
        if (config === undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_MODE", { mode, suit: suitLetter }));
        }
        if (args.length < config.minArgs) {
            return undefined; // mode chosen, args not yet complete - still declined
        }
        return this.applySuitPrimitive(suitLetter, minion, mode, args, {});
    }

    private validateMagicianChoice(minion: IMinionRef, rest: string[]): StepValidation {
        const [suitLetter, mode, ...args] = rest;
        if (suitLetter === undefined) {
            return { failed: false }; // minion earmarked, suit not chosen yet - still declined
        }
        if (!["C", "R", "D", "S"].includes(suitLetter)) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_SUIT_LETTER", { suitLetter }) };
        }
        if (mode === undefined) {
            return { failed: false }; // suit chosen, mode not chosen yet - still declined
        }
        const config = MINOR_MODES[suitLetter]?.[mode];
        if (config === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_MODE", { mode, suit: suitLetter }) };
        }
        if (args.length < config.minArgs) {
            return { failed: false }; // mode chosen, args not yet complete - still declined
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
    // (place/discard) - expand once activate/play exist. `custom-randomization`
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
        return "discard"; // discards nothing, draws the max
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
