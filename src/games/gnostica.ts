import { GameBase, IAPGameState, IClickResult, IIndividualState, IRenderOpts, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, AreaButtonBar, AreaKey, AreaPieces, ButtonBarButton, Glyph, MarkerOutline } from "@abstractplay/renderer/build/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { Direction, reviver, shuffle, UserFacingError } from "../common";
import { UnboundedSquareBoard } from "../common/unbounded-square-board";
import { Deck, MinorCard, MajorCard, TarotCard, allCards, ranks, suits } from "../common/tarot";
import { GnosticaBoard, CellClass } from "./gnostica/board";
import { CellContents, ICellContents, cardPointValue } from "./gnostica/cell";
import { Piece, Orientation, cardinalOrientations } from "./gnostica/piece";
import {
    Stash, PowerContext, PowerFailure, takeFromStash, returnToStash, hasStashAvailable,
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
import { MajorArcanaDef, PowerStep, PrimitiveOpts, SpecialPower, SuitPrimitive, getMajorArcanaDef, getMajorArcanaIcons } from "./gnostica/majorArcana";
import i18next from "i18next";

export type playerid = 1|2|3|4|5|6;

// A board tile overlays a 3x3 grid: the 4 corners are the card face (rank
// + suit/power icons, see buildCardFace), leaving 5 cells for pyramids -
// one edge midpoint per cardinal facing, plus the exact centre for a "U"
// (unfaced) piece. Orientation has exactly 5 values (N/E/S/W/U), a 1:1
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
const PIECE_GRID_SLOTS: [number, number][] = [[0, -1], [0, 1], [1, 0], [-1, 0], [0, 0]]; // N, S, E, W, U
const PIECE_GRID_PREFERRED_INDEX: Record<Orientation, number> = { N: 0, S: 1, E: 2, W: 3, U: 4 };

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
const CARDINAL_COS_SIN: Record<Exclude<Orientation, "U">, [number, number]> = {
    N: [1, 0], E: [0, 1], S: [-1, 0], W: [0, -1],
};

// A minion's board location - shorthand used while resolving use/play.
// `piece` is set only for a newMinion predicted by a non-mutating validate*
// step (see validateCups/validateRods/validateHermitStep's "own"/"piece"
// cases): since validation never actually mutates the board, a piece
// created/moved onto a cell with no stored CellContents object yet has nowhere
// real to read owner/size/orientation from until the move is actually
// committed - this snapshot carries that data along instead. Every other
// producer of an IMinionRef (the real apply* mutation path, and any ref
// pointing at a piece that already existed before this chain started)
// leaves it unset and callers fall back to reading the real board, exactly
// as before this field existed.
interface IMinionRef {
    x: number;
    y: number;
    index: number;
    piece?: Piece;
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

// See parseMove()/pickleMove() for details.
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

// Click support for minor arcana's single suit-power step (major arcana's
// own chained steps reuse this same table - see parsePendingStep()).
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
const ALL_SUITS: { uid: string; label: string }[] = [
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

// The engine-side view of an in-progress "use"/"play" click sequence -
// reconstructed fresh from the move string on every call (same philosophy
// as isPendingFirstPlacement/highlightedButtonValues, not persisted
// anywhere). `minion` always defaults to the first eligible piece (see
// eligibleMinionsForActivate/Play's own docs on why disambiguating between
// several eligible minions by click is out of scope this pass). Undefined
// whenever there's nothing here for the click flow to do - no
// use/play in progress, no eligible minions at all, or Fool/World
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
    // the full list is kept (regardless of which one `minion` currently
    // resolves to) so a minion-selector ref can still be generated
    // correctly (disambiguated only against the player's own OTHER
    // eligible minions, never a co-located enemy piece - see
    // resolvePieceRef's docs on the "minion-selector" pool).
    eligible: IMinionRef[];
    // eligible, plus any newMinion chained in from earlier COMPLETE steps
    // of the same major-arcana activation (mirrors validateMajorPower's
    // own chaining loop) - identical to `eligible` for a minor card, or
    // for a major card's own first step.
    minions: IMinionRef[];
    // Resolved from this step's own already-typed leading minionRef token
    // against `minions`, or `minions[0]` as a preview default when that
    // token is missing/unresolved - see resolveStepMinion's own docs.
    // `minionAmbiguous` is what actually gates whether that default is
    // trustworthy: true means more than one minion is eligible AND none
    // has been pinned down yet, so `minion` here is only a placeholder -
    // every click helper that reads `pending.minion` directly should only
    // be reached once this is false. `minionCandidates` is the (possibly
    // cell-narrowed) set getActionButtons() actually renders a
    // minion-picker button set from, and ONLY once every remaining
    // candidate shares a single cell - see resolveStepMinion's own docs on
    // why a still-multi-cell `minionCandidates` (an un-narrowed "play"
    // pool) means a board click is needed before buttons make sense at
    // all, while "use"'s own always-single-cell pool needs no such click.
    minion: IMinionRef;
    minionAmbiguous: boolean;
    minionCandidates: IMinionRef[];
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
    board: UnboundedSquareBoard<CellContents>;
    // Card uids per player, index 0 = player 1.
    hands: string[][];
    // Each player's own hand exactly as it stood the last time THEY
    // started a new turn (frozen the instant they make their first move
    // of that turn - see move()'s own docs) - the comparison point
    // render()'s "new card" highlight diffs the current hand against.
    // Deliberately NOT the same thing as `hands` a move ago: it only
    // updates at the START of a player's own turn, so it still reflects
    // whatever they had BEFORE their last turn's own draw/trade/etc.,
    // making that turn's changes visible as "new" going into their NEXT
    // one - not just changes caused by other players while they weren't
    // acting.
    handBaseline: string[][];
    drawPile: string[];
    discardPile: string[];
    // discardPile exactly as it stood before the most recently completed
    // real move's own mutations (mirrors handBaseline's own timing - see
    // move()'s docs) - render()'s discard-pile "just discarded" highlight
    // diffs the current pile against this. Unlike handBaseline, there's
    // only one shared pile (always fully public, unlike a hand), so this
    // isn't per-player and isn't gated on whose turn it is - it simply
    // shows whatever the LAST move added, until the NEXT move (by anyone)
    // updates the baseline again.
    discardBaseline: string[];
    stashes: Map<playerid, Stash>;
    eliminated: playerid[];
    lastTurnAnnouncedBy: playerid | undefined;
    lastmove?: string;
    // The "bidding" variant's opening procedure - see cmdBid's own docs.
    // Every other variant/game stays in "main" for its entire lifetime, so
    // none of the fields below are ever touched outside that variant.
    phase: "bidding" | "redraw" | "main";
    bidRound: number;
    // One slot per player (index 0 = player 1): the 1-based position in
    // THEIR OWN hand they've committed as this round's bid, or null if
    // they haven't bid yet this round. null, not undefined - state gets
    // JSON round-tripped (state()/serialize(), exactly what happens
    // between every real move), and JSON.stringify silently turns
    // `undefined` array elements into `null` (arrays can't have holes in
    // JSON) - checking `!== undefined` against an already-round-tripped
    // array would misread every still-open slot as already filled.
    // Deliberately a position, not a card uid - see cmdBid's docs for why
    // storing the identity here would leak it the instant the move is
    // submitted.
    bidPositions: (number | null)[];
    // Every card actually revealed by a bid, across every round played
    // (tied rounds and the final decisive one alike) - the shared pool
    // every player draws back up to 6 from during "redraw".
    biddingPool: string[];
    bidWinner: playerid | undefined;
    // The counterclockwise redraw order (winner's right-hand neighbour
    // first, winner last) and a cursor into it - computed once the bid
    // resolves, consumed one player at a time during "redraw".
    redrawOrder: playerid[];
    redrawPos: number;
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
        flags: ["experimental", "no-moves", "custom-randomization", "player-stashes", "autopass", "scores"],
        displays: [{ uid: "larger-cards" }],
    };

    public numplayers!: number;
    public currplayer!: playerid;
    public board!: GnosticaBoard;
    public hands: string[][] = [];
    public handBaseline: string[][] = [];
    public drawPile: string[] = [];
    public discardPile: string[] = [];
    public discardBaseline: string[] = [];
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
    // The "bidding" variant's own state - see IMoveState's own docs on
    // each field.
    public phase!: "bidding" | "redraw" | "main";
    public bidRound = 0;
    public bidPositions: (number | null)[] = [];
    public biddingPool: string[] = [];
    public bidWinner: playerid | undefined;
    public redrawOrder: playerid[] = [];
    public redrawPos = 0;
    private buffers: Direction[] = [];

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

            // Player 1 is the starting player by default. The "bidding"
            // variant runs the rules' own bid-and-redraw procedure first -
            // see cmdBid's docs - and only sets currplayer to whoever
            // actually won once that's resolved.
            const fresh: IMoveState = {
                _version: GnosticaGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board: board.store,
                hands,
                // Starting hand doubles as each player's own first
                // baseline - nothing highlights as "new" on anyone's
                // opening turn (see move()'s own docs on when this
                // updates from here on).
                handBaseline: hands.map(h => [...h]),
                drawPile,
                discardPile: [],
                discardBaseline: [],
                stashes,
                eliminated: [],
                lastTurnAnnouncedBy: undefined,
                phase: this.variants.includes("bidding") ? "bidding" : "main",
                bidRound: 0,
                bidPositions: new Array(this.numplayers).fill(null),
                biddingPool: [],
                bidWinner: undefined,
                redrawOrder: [],
                redrawPos: 0,
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
            // Two-step rehydration (see GnosticaBoard.rehydrate's own docs):
            // JSON.parse+reviver only restores the outer UnboundedSquareBoard
            // wrapper; every stored CellContents still needs its own
            // deserialize() pass to become a real class instance again.
            this.stack.forEach(s => {
                s.board = GnosticaBoard.rehydrate(s.board as UnboundedSquareBoard<ICellContents>);
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
        this.handBaseline = state.handBaseline.map(h => [...h]);
        this.drawPile = [...state.drawPile];
        this.discardPile = [...state.discardPile];
        this.discardBaseline = [...state.discardBaseline];
        this.stashes = new Map([...state.stashes.entries()].map(([k, v]) => [k, [...v] as Stash]));
        this.eliminated = [...state.eliminated];
        this.lastTurnAnnouncedBy = state.lastTurnAnnouncedBy;
        this.lastmove = state.lastmove;
        this.phase = state.phase;
        this.bidRound = state.bidRound;
        this.bidPositions = [...state.bidPositions];
        this.biddingPool = [...state.biddingPool];
        this.bidWinner = state.bidWinner;
        this.redrawOrder = [...state.redrawOrder];
        this.redrawPos = state.redrawPos;
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
            handBaseline: this.handBaseline.map(h => [...h]),
            drawPile: [...this.drawPile],
            discardPile: [...this.discardPile],
            discardBaseline: [...this.discardBaseline],
            stashes: new Map([...this.stashes.entries()].map(([k, v]) => [k, [...v] as Stash])),
            eliminated: [...this.eliminated],
            lastTurnAnnouncedBy: this.lastTurnAnnouncedBy,
            lastmove: this.lastmove,
            phase: this.phase,
            bidRound: this.bidRound,
            bidPositions: [...this.bidPositions],
            biddingPool: [...this.biddingPool],
            bidWinner: this.bidWinner,
            redrawOrder: [...this.redrawOrder],
            redrawPos: this.redrawPos,
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

        // Mirrors move()'s own bid/redraw/pass/phase gates - see their docs.
        const headLower = parsed.head.toLowerCase();
        if (headLower === "bid" || headLower === "redraw" || headLower === "pass") {
            if (headLower === "bid" && this.phase !== "bidding") {
                return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: parsed.head });
            }
            if ((headLower === "redraw" || headLower === "pass") && this.phase !== "redraw") {
                return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: parsed.head });
            }
            if (parsed.stepSegments.length > 0 || parsed.announceLast) {
                return this.invalid("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: parsed.head });
            }
            const failure = headLower === "bid" ? this.validateBid(parsed.rest)
                : headLower === "redraw" ? this.validateRedraw(parsed.rest)
                : this.validatePass();
            return failure ?? { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
        }
        if (this.phase !== "main") {
            return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: parsed.head });
        }
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
    
    // ============================================================
    // Move parsing
    //
    // Grammar: a comma/semicolon/slash-delimited list of segments naming
    // the turn's action (plus, for "use"/"play", 0+ further segments
    // chaining suit/major-arcana power steps). A trailing "(last)" suffix
    // on the WHOLE move string - not a segment of its own, always at the
    // very end - announces the player's final turn. It's deliberately a
    // distinct, unmistakable suffix rather than just another
    // comma-segment, so it's one flag on parseMove's own result
    // rather than something every consumer has to notice and skip past
    // on its own.
    //
    // parseMove/pickleMove (below) are this grammar's single
    // structural parser/serializer pair - every reader (validateMove,
    // move, parsePendingStep, highlightedButtonValues,
    // handleClick) calls the former instead of re-deriving head/args/
    // steps/announceLast independently, and handleClick's declare
    // handling calls the latter instead of string-level regex surgery.
    // Purely structural,
    // never checks legality against game state, only "is the head a
    // recognized keyword, and does each power step at least look
    // plausible" (isStepShapeValid's own docs explain why that can't go
    // any deeper without already knowing which suit/power is involved -
    // the legality/field-level checking stays exactly where it already
    // lived, in validateMinorPower/validatePowerStep/validateCups etc.).
    // ============================================================

    public move(m: string, {trusted = false, partial = false, emulation = false} = {}): GnosticaGame {
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
        this.buffers = [];

        // Freezes the acting player's hand exactly as it stood BEFORE
        // this turn's own mutations - the comparison point render()'s
        // "new card" highlight (see newHandCardUids's own docs) diffs
        // the current hand against. Captured here, not at the end of
        // the turn, so whatever changes THIS turn makes (a draw, a
        // trade, etc.) still show as "new" the next time it's this
        // player's turn - not just changes some OTHER player caused in
        // between. Real commits only: every partial preview call runs
        // on a disposable, freshly-reconstructed instance (see this
        // method's own docs) whose mutations never reach saveState(),
        // so updating handBaseline there would never actually persist -
        // pointless busywork on every click.
        if (!partial) {
            this.handBaseline[this.currplayer - 1] = [...this.hands[this.currplayer - 1]];
            // Same timing/reasoning as handBaseline just above, but for
            // the single shared discard pile - see discardBaseline's own
            // docs on why this one isn't per-player.
            this.discardBaseline = [...this.discardPile];
        }

        // Parses and executes `m` against `this` - the one place move
        // grammar is interpreted (validateMove mirrors this exact
        // structure, read-only - see its own docs). Throws
        // UserFacingError on any illegal move.
        //
        // Segment 0 is always the turn's top-level action. For "use"/
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
        const headLower = parsed.head.toLowerCase();

        // The "bidding" variant's own opening procedure - see cmdBid's/
        // cmdRedraw's/cmdPass's own docs. Structurally unlike every other
        // head below: no power steps, no "(last)" announcement, and their
        // own bespoke currplayer advancement (next bidder/redrawer, a
        // phase transition, or a single nextPlayer() hop) instead of the
        // generic nextPlayer() call every other move falls through to -
        // so all three are handled entirely here rather than folded into
        // the switch below. "pass" only ever exists to let the 2-player
        // variant's own bid winner sit out the loser's first redraw (see
        // mustPassBeforeRedraw's own docs) - the "autopass" flag means a
        // real server auto-submits it via moves() the instant it's the
        // only legal option, so a human player should never actually see
        // or click a "pass" prompt themselves.
        if (headLower === "bid") {
            if (this.phase !== "bidding") {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.WRONG_PHASE", { move: parsed.head }));
            }
            if (parsed.stepSegments.length > 0 || parsed.announceLast) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: parsed.head }));
            }
            this.cmdBid(parsed.rest, partial);
            
        } else if (headLower === "redraw" || headLower === "pass") {
            if (this.phase !== "redraw") {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.WRONG_PHASE", { move: parsed.head }));
            }
            if (parsed.stepSegments.length > 0 || parsed.announceLast) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: parsed.head }));
            }
            if (headLower === "redraw") {
                this.cmdRedraw(parsed.rest, partial);
            } else {
                this.cmdPass(partial);
            }
        } else {
            // Every other head is illegal until the bidding variant's opening
            // procedure has fully resolved into "main".
            if (this.phase !== "main") {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.WRONG_PHASE", { move: parsed.head }));
            }
            
            // Place is always a player's ENTIRE turn - one gate here, ahead of
            // the switch, replaces a separate check inside every other command:
            // with no board presence, place is the only legal head this turn,
            // full stop; with board presence, place is illegal instead (caught
            // by cmdPlace's own ALREADY_ON_BOARD check) and every other command
            // is free to assume board presence without asking again. Evaluated
            // fresh every call, so this covers a mid-game wipeout's forced
            // re-placement identically to the very first turn - no separate
            // tracked state needed for either case.
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
                this.results.push({ type: "declare" });
            }
            
            if (wasAnnounced) {
                this.resolveAnnouncedTurn();
            }

        }
        // A transient, unpersisted UI hint - NOT the same thing as
        // this.lastmove
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

 
        if (partial || emulation) {
            return this;
        }

        this.lastmove = m;
        if (headLower === "bid" || headLower === "redraw" || headLower === "pass") {
            //Need to rewrite these to remove this exception.
        } else {
            this.nextPlayer();
            this.checkEOG();
        }
        this.saveState();
        return this;
    }


    // The end-of-turn "declare" flag is always this exact trailing suffix
    // on the whole move string - never a comma-separated segment mixed in
    // with the rest - so it can be found/stripped/reattached with one
    // shared regex regardless of wherever else in the grammar the rest
    // of the string is being parsed. See this file's "Move parsing" docs
    // above for why.
    private static readonly LAST_FLAG_RE = /\s*\(last\)\s*$/i;
    private static readonly RECOGNIZED_HEADS = ["place", "orient", "discard", "use", "play", "bid", "redraw", "pass"];

    // English ordinal suffix (1st, 2nd, 3rd, 4th, ..., 11th-13th stay
    // "th") - used only for the turn-order legend's own labels. Plain
    // TS-side formatting rather than an i18next key: every other numeric
    // interpolation in this file's own locale keys is a bare number, and
    // ordinal pluralization is a different (unused elsewhere here) i18n
    // feature not worth introducing for one label.
    private static ordinal(n: number): string {
        const j = n % 10;
        const k = n % 100;
        if (j === 1 && k !== 11) return `${n}st`;
        if (j === 2 && k !== 12) return `${n}nd`;
        if (j === 3 && k !== 13) return `${n}rd`;
        return `${n}th`;
    }

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
    // check. The pips-and-beyond suffix is OPTIONAL specifically so a
    // BARE cell (no ".") also passes shape validation - not a real,
    // resolvable piece ref (resolvePieceRef still rejects one on its own,
    // unaffected by this), but the still-narrowing token a "click the
    // cell your desired minion is on" board click embeds when that cell
    // has more than one eligible minion (see resolveStepMinion's and
    // handleClickCore's own docs) - tolerated the same "still declined,
    // not yet resolved" way as an incomplete mode/args elsewhere in this
    // file (see isMinionCellStillNarrowing's own docs).
    private static readonly PIECE_REF_SHAPE_RE = /^[a-z]{1,2}-?\d+(\.[1-3](\.[nesu])?(\.\d+)?)?$/i;
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

    private pickleMove(p: IParsedMove): string {
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
    // uppercase letters, used everywhere a move string names a facing
    // (place, orient, Cups "own", piece refs, every optional post-action
    // reorientation arg). Case-insensitive on input.
    private tryParseOrientation(s: string | undefined): Orientation | undefined {
        if (s === undefined) {
            return undefined;
        }
        const dir = s.toUpperCase();
        if (dir === "U" || (cardinalOrientations as string[]).includes(dir)) {
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
            : (this.board.get(x, y)?.pieces ?? []).map((_, index): IMinionRef => ({ x, y, index }));
        let matches = candidateRefs
            .map(r => ({ r, piece: r.piece ?? this.board.get(r.x, r.y)?.pieces[r.index] }))
            // A pool entry can go stale mid-chain (an earlier step for
            // real relocated whatever used to be there - pool membership
            // alone doesn't guarantee a piece still exists at that exact
            // index) - treat that the same as never having matched, rather
            // than crashing on a `piece.size` read against undefined.
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

    // A bare cell token (no ".") - a "click the cell your desired minion
    // is on" board click landed here (see handleClickCore's own docs)
    // rather than a genuine, resolvable piece ref. Only meaningful when
    // 2+ of `pool`'s own minions actually sit there - handleClickCore
    // itself only ever embeds one when that's true (a single match there
    // gets a full, resolving ref instead - see its own docs), but this
    // stays defensive (a hand-typed move, or a stale click against a
    // board that's since changed) rather than assuming it.
    private isMinionCellStillNarrowing(tok: string, pool: IMinionRef[]): boolean {
        if (tok.includes(".")) {
            return false;
        }
        const coords = this.tryAlgebraic2coords(tok);
        if (coords === undefined) {
            return false;
        }
        const [cx, cy] = coords;
        return pool.filter(m => m.x === cx && m.y === cy).length > 1;
    }

    // Resolves a step's own leading minionRef token (`tokens[0]`, if
    // present) against `pool`. Three outcomes: (a) it's already a full,
    // valid piece ref - resolves definitively, ambiguous:false; (b) it's a
    // bare cell token still narrowing among 2+ of the pool's own minions
    // there (see isMinionCellStillNarrowing's own docs) - `candidates`
    // narrows to just that cell's pool members, ambiguous:true; (c)
    // neither (nothing typed yet, or unresolved) - `candidates` stays the
    // full, un-narrowed pool. Never ambiguous when the pool has just one
    // member, regardless of what's typed.
    //
    // `candidates` (as opposed to `pool` itself) is what getActionButtons()
    // actually renders a minion-picker button set from, and ONLY once every
    // remaining candidate shares a single cell (own docs there) - so a
    // still-multi-cell `candidates` (outcome (c), "play"'s board-wide pool
    // before any cell has been clicked) correctly shows no buttons at all
    // yet, even though `ambiguous` is true. "use"'s own pool is always
    // already single-cell by construction (eligibleMinionsForActivate),
    // so outcome (c) there is immediately button-ready with no narrowing
    // click needed - the two heads fall out of the same logic here without
    // special-casing either.
    private resolveStepMinion(
        tokens: string[] | undefined, pool: IMinionRef[],
    ): { minion: IMinionRef; ambiguous: boolean; candidates: IMinionRef[] } {
        if (pool.length <= 1) {
            return { minion: pool[0], ambiguous: false, candidates: pool };
        }
        const tok = tokens?.[0];
        if (tok !== undefined) {
            const resolved = this.resolvePieceRef(tok, pool);
            if (resolved.kind === "ok") {
                return { minion: resolved.ref, ambiguous: false, candidates: pool };
            }
            if (this.isMinionCellStillNarrowing(tok, pool)) {
                const coords = this.tryAlgebraic2coords(tok)!;
                const narrowed = pool.filter(m => m.x === coords[0] && m.y === coords[1]);
                return { minion: narrowed[0], ambiguous: true, candidates: narrowed };
            }
        }
        return { minion: pool[0], ambiguous: true, candidates: pool };
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
    // the click sequence, or the very first click auto-submits "U" before
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
    // and "use this card", and there's no second click region per
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
    // (use/play both require it), so they can never actually BE a
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
        // cmdPlace/validatePlace unconditionally reject "place" once the
        // acting player already has ANY board presence (ALREADY_ON_BOARD)
        // - so a live "place" preview can only ever be that player's
        // first piece ever, with no other case to distinguish. Reading
        // this off this.liveMove directly (same approach as the
        // midPowerStep check just above) avoids depending on
        // this.results' own shape: results exist to describe game events
        // for chat/history, not to signal UI state, so a chat-only change
        // there (e.g. tagging place's own result with `how: "initial"`)
        // has no business breaking this check - and previously did.
        return this.parseMove(this.liveMove).head?.toLowerCase() === "place";
    }

    // Which button(s) to bold, based on this.liveMove (see move()'s own
    // docs) - unlike this.results, which some actions (e.g. a use
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
        if (head === "discard" && this.isPassEquivalent(parsed.rest)) {
            // "discard draw 0" is Pass's own bare seed (see the Pass
            // button's own click handler) - bold Pass instead of
            // Discard/Draw, regardless of whether the player got there by
            // clicking Pass or by hand-building an equivalent Discard/Draw
            // move (0 discards, explicit draw 0).
            found.add("pass");
        } else if (head !== undefined && ["place", "use", "play", "orient", "discard"].includes(head)) {
            found.add(head);
        }
        return found;
    }

    // A "discard [uid...] draw <n>" move is Pass-equivalent only when it
    // discards nothing AND explicitly draws zero - an omitted "draw <n>"
    // defaults to drawing the max at commit time (see cmdDiscard's own
    // docs), so that's a real draw, not a pass.
    private isPassEquivalent(rest: string[]): boolean {
        const drawIdx = rest.indexOf("draw");
        const discardUids = drawIdx === -1 ? rest : rest.slice(0, drawIdx);
        return discardUids.length === 0 && drawIdx !== -1 && rest[drawIdx + 1] === "0";
    }

    private getActionButtons(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (this.gameover) {
            return undefined;
        }
        // The "bidding" variant's opening procedure - a single bold button
        // per phase, same "only one thing possible right now" pattern as
        // the initial-placement case below. Not strictly necessary (a
        // direct hand/pool card click already builds the move on its own
        // - see handleBiddingClick), but offered for consistency.
        if (this.phase === "bidding") {
            return [{ label: "Bid", value: "bid", attributes: [{ name: "font-weight", value: "bold" }] }];
        }
        if (this.phase === "redraw") {
            return [{ label: "Redraw", value: "redraw", attributes: [{ name: "font-weight", value: "bold" }] }];
        }
        // A live preview of "use"/"play" can only ever have STARTED
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
            { label: "Play Card", value: "play" },
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
                for (let n = maxDraw; n >= 0; n--) {
                    countButtons.push({ label: `Draw ${n}`, value: `drawcount_${n}` });
                }
                return countButtons as [ButtonBarButton, ...ButtonBarButton[]];
            }
        }

        const pendingMinor = this.liveMove !== undefined ? this.parsePendingStep(this.liveMove) : undefined;
        if (pendingMinor === undefined) {
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

        // Every remaining candidate minion for THIS step already sits on
        // the same cell - either "use"'s own pool, always single-cell by
        // construction, or "play"'s board-wide pool once a board click has
        // narrowed it down to one cell (see resolveStepMinion's and
        // handleClickCore's own docs) - AND there's more than one of them,
        // so a real choice is still needed. Offer one button per candidate,
        // pre-empting every other branch below (mode buttons,
        // hermitTeleport/magicianChoice's own sets, or the uncollapsed bar
        // a pure click-driven special power would otherwise fall through
        // to). Clicking one types just that minion's ref as this step's
        // own leading token (see handleClickCore's "minion_" dispatch) -
        // nothing else about the step is decided yet, so the very next
        // getActionButtons() call picks up exactly where the single-minion
        // case always has, now with `minion` no longer just a placeholder.
        const candidateCells = new Set(pendingMinor.minionCandidates.map(m => `${m.x},${m.y}`));
        if (pendingMinor.minionAmbiguous && candidateCells.size === 1) {
            const buttons: ButtonBarButton[] = selected !== undefined ? [selected] : [];
            buttons.push({ label: "Choose Minion", value: "_spacer", attributes: [{ name: "font-style", value: "italic" }] });
            const seenRefs = new Set<string>();
            for (const m of pendingMinor.minionCandidates) {
                const ref = this.pieceRefStr(m.x, m.y, m.index, pendingMinor.minions);
                // Two genuinely identical pieces (same owner/size/orientation
                // at the same cell) share the same shortest ref - resolvePieceRef
                // already treats that as "resolves to the first match, not an
                // error" (see its own docs), so a second button for the same
                // ref would just be an inert duplicate, not a real choice.
                if (seenRefs.has(ref)) {
                    continue;
                }
                seenRefs.add(ref);
                buttons.push({ label: ref, value: `minion_${ref}` });
            }
            if (declareBtn !== undefined) {
                buttons.push(declareBtn);
            }
            return buttons as [ButtonBarButton, ...ButtonBarButton[]];
        }
        // Still ambiguous but spanning more than one cell ("play"'s
        // board-wide pool, not yet narrowed) - no buttons make sense yet,
        // the player needs to click the cell holding their desired minion
        // first (see handleClickCore's own "narrow to this cell" handling,
        // and the PICK_MINION_CELL message the click that got here already
        // carries). Leave the bar uncollapsed, same as every other
        // click-only stage.
        if (pendingMinor.minionAmbiguous) {
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

        const buttons: ButtonBarButton[] = selected !== undefined ? [selected] : [];

        const spacerLabel = pendingMinor.suitUid ? ALL_SUITS.filter(obj => obj.uid === pendingMinor.suitUid)[0].label : "Special Power";
        buttons.push({ label: spacerLabel, value: "_spacer",  attributes: [{ name: "font-style", value: "italic" }] });

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
            for (const suit of ALL_SUITS) {
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
            const segment = parsed.stepSegments[0] ?? []; // segment[0] is the minionRef, if typed yet - see resolveStepMinion
            const [, mode, ...rest] = segment;
            const { minion, ambiguous, candidates } = this.resolveStepMinion(segment, eligible);
            return { head, headArg, suitUid, prefix: [], eligible, minions: eligible, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps: [], opts: {}, mode, rest };
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
                    const { minion, ambiguous, candidates } = this.resolveStepMinion(tokens, minions);
                    return { head, headArg, suitUid: suitUidForStep, prefix: [], eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts, mode, rest };
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
            const { minion, ambiguous, candidates } = this.resolveStepMinion(undefined, minions);
            return { head, headArg, suitUid, prefix: [], eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts, mode: undefined, rest: [] };
        }
        return this.buildSpecialPending(step.special, head, headArg, eligible, minions, priorSteps, []);
    }

    // Builds the `special`-flavored branch of IPendingStep - `tokens` is
    // this step's own already-typed segment (or [] for a brand new one),
    // still including its own leading minionRef (except highPriestess,
    // which has none at all - see IPendingStep's own docs). highPriestess
    // never targets a specific minion at all (its own click handler
    // ignores `pending.minion` entirely), so it's hardcoded to
    // {minion: minions[0], ambiguous: false} regardless of pool size -
    // resolveStepMinion would otherwise misread tokens[0] there (a
    // hand-card uid, not a piece ref) as an unresolved minionRef and
    // wrongly report ambiguity.
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
        if (special === "magicianChoice" && ALL_SUITS.some(s => s.uid === tokens[1])) {
            const suitUid = tokens[1];
            const [, , mode, ...rest] = tokens;
            const { minion, ambiguous, candidates } = this.resolveStepMinion(tokens, minions);
            return { head, headArg, suitUid, prefix: [suitUid], eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts: {}, mode, rest };
        }
        const rest = special === "highPriestess" ? tokens : tokens.slice(1);
        const { minion, ambiguous, candidates } = special === "highPriestess"
            ? { minion: minions[0], ambiguous: false, candidates: minions }
            : this.resolveStepMinion(tokens, minions);
        return { head, headArg, special, prefix: [], eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts: {}, mode: undefined, rest };
    }

    // The single valid cell a minor suit-power step may affect, per
    // assertValidCellTarget in powers.ts: the minion's own cell if it's
    // facing "U", otherwise the one cell it's pointing at. Also used as
    // the DEFAULT target for "piece"-shaped modes (self is additionally
    // always valid there too, per assertValidPieceTarget - clicking the
    // minion's own cell switches to that instead, see
    // handlePendingStepBoardClick).
    private minorTargetCell(minion: IMinionRef): [number, number] {
        const piece = this.board.get(minion.x, minion.y)!.pieces[minion.index];
        if (piece.orientation === "U") {
            return [minion.x, minion.y];
        }
        const [dx, dy] = this.board.delta(piece.orientation as Exclude<Orientation, "U">);
        return [minion.x + dx, minion.y + dy];
    }

    // The shared board window every renderable/clickable grid scan uses -
    // one ring beyond the CARD-bearing (territory) cells' own bounding
    // box, deliberately NOT this.board's own raw minX/maxX/minY/maxY
    // (which also includes cardless wasteland cells a piece has been
    // pushed/teleported onto). Padding by 1 beyond a wasteland cell
    // rather than a territory overshoots into genuine void - a piece can
    // never legally end up more than 1 step from SOME territory (landing
    // further out either destroys it - Rods - or is outright illegal -
    // Hermit/place), so every legally-occupied wasteland cell is always
    // already within 1 step of a territory and therefore always inside
    // this window too, with no need to separately account for the raw
    // stored-cell bounds at all. Falls back to a trivial single-cell
    // window if there are somehow no territories at all (shouldn't
    // happen once the game has actually started).
    private renderWindow(): { minX: number; maxX: number; minY: number; maxY: number } {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y, t] of this.board.entries()) {
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

    // Inverse of resolvePieceRef: the shortest ref that resolves back to
    // this exact piece within the same pool (see resolvePieceRef's docs -
    // omitted here, defaults to every piece at the cell). Tries pips alone,
    // then pips+orientation alone, then pips+player alone (skipping
    // orientation if it didn't help), then all three together.
    private pieceRefStr(x: number, y: number, index: number, pool?: IMinionRef[]): string {
        const self = pool?.find(p => p.x === x && p.y === y && p.index === index);
        const piece = self?.piece ?? this.board.get(x, y)!.pieces[index];
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

    // Strips the leading `<cell>.` off a pieceRefStr-shaped string (see
    // its own docs on the exact format), leaving just the disambiguating
    // minion detail (size, and orientation/owner only if needed) - for
    // threading a minion's identity into a result's own `what` without
    // duplicating the cell a sibling `where`/`from`/`to` field already
    // carries. Cell notation itself never contains a "." (see
    // GnosticaBoard.coords2algebraic), so the first one is always the
    // cell/detail boundary.
    private stripCellFromRef(ref: string): string {
        const idx = ref.indexOf(".");
        return idx === -1 ? ref : ref.slice(idx + 1);
    }

    // Click-to-orient: clicking the cell a piece already occupies means
    // "face up"; clicking one of its four orthogonal neighbours means
    // "face that way" - one click always states the intended direction
    // outright, rather than stepping through up to 5 states via a toggle.
    // A territory or wasteland neighbour is always independently
    // clickable in the grid; a void neighbour is not (see render()'s own
    // docs) - clicking a piece toward a void direction instead comes
    // through as a buffer click (see handleClickCore's own docs on
    // reading one back), landing here with the exact same toX,toY either
    // way. Returns undefined when `toX,toY` is neither the piece's own
    // cell nor an orthogonal neighbour of it.
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

    // Best-effort filter over which modes are worth offering as buttons
    // right now, given current board state - not a full legality check
    // (validateMove still catches anything this misses or over-includes
    // once the player actually acts). Rods needs its own orientation gate
    // (a piece pointing "U" cannot use a rod at all, per
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
                    return minion.orientation !== "U";
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
                // (not "U", which has no facing cell at all - self really
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
                return rebuild([GnosticaBoard.coords2algebraic(tx, ty), dir], "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE");
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
            this.assembleStepMove(pending, [minionRef, dir]),
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
            this.assembleStepMove(pending, [minionRef, targetRef, dir]),
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
    // orient, use/play with power declined, and toggling hand cards
    // into a discard's uid list. use/play's chained power steps are handled
    // further down (parsePendingStep and friends).
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
            return this.provisionalResult(this.pickleMove({ ...parsed, announceLast: !parsed.announceLast }));
        }
        const bareMove = this.pickleMove({ ...parsed, announceLast: false });
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
        const combined = this.pickleMove({ ...this.parseMove(result.move), announceLast: true });
        if (result.valid && result.complete !== -1) {
            return this.provisionalResult(combined);
        }
        return { ...result, move: combined };
    }

    // Click support for the "bidding" variant's opening procedure. Row/col
    // are never used - both phases are driven entirely by clicking cards
    // in an AreaPieces (own hand during "bidding", the shared pool during
    // "redraw"), never the board.
    private handleBiddingClick(move: string, piece?: string): IClickResult {
        if (piece === "_btn_bid") {
            return { move: "bid", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CARD_TO_BID") };
        }
        if (piece === "_btn_redraw") {
            return { move: "redraw", valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_CARDS_TO_REDRAW") };
        }
        // A bid is always exactly one card - unlike discard's toggle-list,
        // each click REPLACES any earlier pick rather than accumulating
        // (mirrors "play <uid>"'s own single-click-replaces behaviour).
        if (this.phase === "bidding" && piece?.startsWith("hand_")) {
            // Same "_new" stripping as the main-phase hand-card handler -
            // see its own docs.
            const uid = piece.slice("hand_".length).replace(/_new$/, "");
            const hand = this.hands[this.currplayer - 1] ?? [];
            const idx = hand.indexOf(uid);
            if (idx === -1) {
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.NOT_IN_HAND", { uid }) };
            }
            return this.provisionalResult(`bid ${idx + 1}`);
        }
        // Redraw can need several cards, so pool clicks toggle a uid list
        // exactly like discard's own hand-card toggle - see cmdDiscard's
        // click handling above for the identical pattern.
        if (this.phase === "redraw" && piece?.startsWith("pool_")) {
            const uid = piece.slice("pool_".length);
            if (!this.biddingPool.includes(uid)) {
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.REDRAW_UID_NOT_IN_POOL", { uid }) };
            }
            const { head, rest: args } = this.parseMove(move);
            let picks = head?.toLowerCase() === "redraw" ? [...args] : [];
            if (picks.includes(uid)) {
                picks = picks.filter(u => u !== uid);
            } else {
                picks.push(uid);
            }
            return this.provisionalResult(["redraw", ...picks].join(" "));
        }
        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
    }

    private handleClickCore(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            // The "bidding" variant's opening procedure - structurally
            // unlike every other click below (no board, no pending power
            // steps, nothing else legal), so it's handled entirely by its
            // own function rather than interleaved into the main-phase
            // tree - see handleBiddingClick's own docs.
            if (this.phase !== "main") {
                return this.handleBiddingClick(move, piece);
            }
            if (piece !== undefined && piece.startsWith("_btn_")) {
                const value = piece.slice("_btn_".length);
                if (value.startsWith("minion_")) {
                    // "minion_<ref>" - see getActionButtons()'s own
                    // minionAmbiguous branch, offered whenever more than one
                    // of the acting player's own pieces is eligible for the
                    // current step and none has been picked yet. Types just
                    // the chosen minion's ref as this step's leading token -
                    // nothing else about the step (mode, special args) is
                    // decided here, so the resulting move is exactly as
                    // "still building" as an empty step ever was, just no
                    // longer ambiguous about which minion is acting.
                    const ref = value.slice("minion_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || !pending.minionAmbiguous) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    // Resolved against minionCandidates (the currently-shown
                    // set), not the full minions pool - a button for a stale
                    // move string shouldn't resolve against pieces that
                    // aren't actually on offer anymore.
                    const resolved = this.resolvePieceRef(ref, pending.minionCandidates);
                    if (resolved.kind !== "ok") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const minionRef = this.pieceRefStr(resolved.ref.x, resolved.ref.y, resolved.ref.index, pending.minions);
                    return this.provisionalResult(this.assembleStepMove(pending, [minionRef]));
                }
                if (value.startsWith("mode_")) {
                    // "mode_<suitUid>_<mode>" - see getActionButtons()'s own
                    // pendingMinor branch, which only ever offers one of
                    // these once a minor-arcana use/play is already
                    // seeded (0 steps taken yet).
                    const [, suitUid, mode] = value.split("_");
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.suitUid !== suitUid) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    // Cups "own" seeds its new piece's facing as "U" by
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
                        // A genuine pass - explicitly zero discards AND
                        // zero draw. Discard's own bare seed ("discard"
                        // alone) is NOT equivalent to this: cmdDiscard
                        // defaults an omitted "draw <n>" to the max, so it
                        // silently draws a full hand back up rather than
                        // actually passing.
                        return this.provisionalResult("discard draw 0");
                    case "discard":
                        return this.provisionalResult("discard", "apgames:validation.gnostica.DISCARD_CARDS_OPTIONAL");
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
                // A just-drawn card's own rendered/clickable identifier
                // carries a "_new" suffix (see newHandCardUids's own docs
                // on the highlight this drives) distinct from its real
                // uid - stripped here so a real click on one still
                // resolves correctly. No real uid can end in "_new"
                // itself (every uid is a bare rank+suit or 2-digit major
                // code), so this is unambiguous.
                const uid = piece.slice("hand_".length).replace(/_new$/, "");
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
                    // "play"'s own pool can span the whole board - unlike
                    // "use" (always single-cell by construction), the
                    // player needs to click a cell before any minion
                    // picker makes sense (see resolveStepMinion's/
                    // getActionButtons()'s own docs) - flagged here so
                    // that instruction actually reaches them, rather than
                    // the generic "power still optional" wording.
                    const freshPending = this.parsePendingStep(`play ${uid}`);
                    const needsCellClick = freshPending?.minionAmbiguous === true
                        && new Set(freshPending.minionCandidates.map(m => `${m.x},${m.y}`)).size > 1;
                    return this.provisionalResult(
                        `play ${uid}`,
                        needsCellClick ? "apgames:validation.gnostica.PICK_MINION_CELL" : "apgames:validation.gnostica.POWER_STILL_OPTIONAL",
                    );
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
                // Same "_new" stripping as the hand-card click just above,
                // for a just-discarded card's own tag (see
                // newDiscardUids's own docs) - neither a bare major uid
                // nor a "<suit>_spot"/"<suit>_royal" bucket key can end in
                // "_new" for real, so this is unambiguous here too.
                const key = piece.slice("discard_".length).replace(/_new$/, "");
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

            const { minX, minY } = this.renderWindow();
            // A click on a rendered buffer segment (see cmdOrient's own
            // docs on when this.buffers gets populated) - same contract
            // pacru.ts/azacru.ts already use for their own `buffer`
            // areas: the renderer reports an out-of-window row/col and
            // passes the segment's own coordinates via `piece` instead,
            // comma-separated as "col,row" - but (confirmed empirically
            // against the real renderer, not just by reading pacru's own
            // source) still WINDOW-RELATIVE, the exact same frame the
            // ordinary row/col params use, not raw absolute board
            // coordinates - a buffer segment one step beyond the window's
            // own edge reports the next relative index past it (e.g.
            // "5,2" for a 5-wide window's own east buffer, row 2), which
            // still needs the same +minX/+minY offset every other click
            // gets. Every other `piece` convention that also uses an
            // out-of-window row/col (_btn_/hand_/discard_ - see above)
            // has already returned by this point, so reaching here with
            // row/col invalid can only mean a buffer click.
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
            // Overrides the generic VALID_MOVE message for a board-click
            // result that's already complete/submittable but still
            // deliberately soft-pedals that: DIRECTION_STILL_ADJUSTABLE
            // (place/orient's own facing, defaulted to "U" or set to
            // whatever neighbour was clicked, never the player's final
            // word on it - Cups "own"'s new-piece facing sets this too,
            // separately, in handlePendingStepBoardClick) and
            // POWER_STILL_OPTIONAL (use/play's bare "<uid>"
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
                // instead (defaulting to "U" again), same as clicking a
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
                    newmove = `orient ${prevRef} ${dir}`;
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
                // through to the ordinary use/play handling below only
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
                // Some of the acting player's own minions are eligible for
                // a step but the pool still spans more than one cell and
                // none has been pinned down yet (see resolveStepMinion's/
                // IPendingStep's own docs) - a board click here means
                // "this is the cell my minion is on." Tried before every
                // other board-click dispatch below (mode/special cycling),
                // since none of that can mean anything sensible yet - it'd
                // silently act through `pending.minion`'s placeholder
                // default otherwise. Embeds the FULL ref of one of the
                // clicked cell's own candidates - a full, resolving ref if
                // exactly one of the pool's own minions is there (done,
                // same as any other single-match resolution); a bare cell
                // token (see isMinionCellStillNarrowing's own docs) if 2+
                // are, still needing an actual picker pick since a cell
                // alone doesn't say which one. A click matching ZERO of
                // the pool's own minions isn't for this handler at all
                // (returns undefined, falls through to the ordinary
                // handling further down, which reports its own more
                // specific "nothing legal there" message).
                const tryNarrowMinion = (candidate: IPendingStep | undefined): IClickResult | undefined => {
                    if (candidate === undefined || !candidate.minionAmbiguous) {
                        return undefined;
                    }
                    const atCell = candidate.minions.filter(m => m.x === x && m.y === y);
                    if (atCell.length === 0) {
                        return undefined;
                    }
                    if (atCell.length === 1) {
                        const ref = this.pieceRefStr(atCell[0].x, atCell[0].y, atCell[0].index, candidate.minions);
                        return this.provisionalResult(
                            this.assembleStepMove(candidate, [ref]),
                            "apgames:validation.gnostica.POWER_STILL_OPTIONAL",
                        );
                    }
                    return this.provisionalResult(
                        this.assembleStepMove(candidate, [cell]),
                        "apgames:validation.gnostica.PICK_MINION_BUTTON",
                    );
                };
                if (advanced !== undefined && advanced.special !== undefined && advanced.rest.length === 0
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
                    // "use" does below - a board click here only ever
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
            return "U";
        }
        const dir = s.toUpperCase();
        if ((cardinalOrientations as string[]).includes(dir)) {
            return dir as Orientation;
        }
        throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: s }));
    }

    // ============================================================
    // The "bidding" variant's opening procedure
    // ============================================================

    // "bid <n>" - n is the 1-based position of a card in the ACTING
    // player's own current hand, deliberately not the card's own uid.
    // Move strings are permanently public the instant they're submitted
    // (this is a strict-turn, replay-reconstructed engine - there is no
    // "hide this specific move from other players" mechanism anywhere),
    // so a `bid <uid>` move would leak the real card to every viewer
    // immediately, defeating the whole point of a blind bid. A bare
    // position leaks nothing: an opponent's hand is already all-redacted
    // to them (see render()'s own docs on that convention), so "player 3
    // bid their 2nd card" tells them nothing they don't already not-know.
    // The real card stays sitting untouched in `hands[]` - reusing the
    // one field this codebase already has a proven per-viewer redaction
    // convention for - until every player has committed a position, at
    // which point resolveBidRound() reveals them all together.
    // `partial` mirrors cmdDiscard's own contract (see move()'s own docs
    // on what `partial` means): a live-preview call must validate the
    // click exactly as normal, but stop BEFORE actually committing the
    // bid - resolveBidRound() advances phase/currplayer/hands for real,
    // which must never happen on move()'s disposable preview instance.
    // There's nothing else worth rendering for an in-progress bid pick
    // (the acting player's own hand doesn't change until the round
    // actually resolves), so partial is a clean early return.
    private cmdBid(args: string[], partial = false): void {
        const failure = this.validateBid(args);
        if (failure !== undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", failure.message);
        }
        if (partial) {
            return;
        }
        const n = Number(args[0]);
        this.bidPositions[this.currplayer - 1] = n;
        this.results.push({ type: "select", who: this.currplayer, what: "bid" });
        if (this.bidPositions.every(p => p !== null)) {
            this.resolveBidRound();
        } else {
            this.nextPlayer();
        }
    }

    private validateBid(args: string[]): IValidationResult | undefined {
        const [nStr] = args;
        if (nStr === undefined) {
            return this.invalid("apgames:validation.gnostica.BID_POSITION_REQUIRED");
        }
        const hand = this.hands[this.currplayer - 1];
        const n = Number(nStr);
        if (!Number.isInteger(n) || n < 1 || n > hand.length) {
            return this.invalid("apgames:validation.gnostica.BAD_BID_POSITION", { position: nStr, max: hand.length });
        }
        // Defensive - unreachable in normal play, since a round resolves
        // (and resets every slot to null) the instant the last player's
        // slot is filled, so currplayer can never be asked to bid twice
        // within the same still-open round.
        if (this.bidPositions[this.currplayer - 1] !== null) {
            return this.invalid("apgames:validation.gnostica.ALREADY_BID");
        }
        return undefined;
    }

    // Every bidPositions slot is filled - reveal them all together
    // (splicing each named card out of its owner's hand into the shared
    // biddingPool, real uids and all - safe now, since this is the exact
    // moment the rules say everyone becomes entitled to see them) and
    // resolve the round.
    private resolveBidRound(): void {
        const revealed: { player: playerid; card: TarotCard }[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            const idx = this.bidPositions[p - 1]! - 1;
            const hand = this.hands[p - 1];
            const uid = hand[idx];
            hand.splice(idx, 1);
            this.biddingPool.push(uid);
            revealed.push({ player: p as playerid, card: allCards().find(c => c.uid === uid)! });
        }
        this.bidPositions = new Array(this.numplayers).fill(null) as (number | null)[];

        // "The player with the highest number major arcana card wins the
        // bid. If nobody bid with a major arcana card, then the player
        // with the highest minor arcana card wins" - MajorCard.seq (0-21)
        // and MinorCard.rank.seq (Component's own ranks array is already
        // Ace=1..King=14) are exactly these two comparison keys already;
        // no separate ranking table needed.
        const majors = revealed.filter(r => r.card.major);
        const pool = majors.length > 0 ? majors : revealed;
        const rank = (r: { card: TarotCard }): number => r.card.major ? (r.card as MajorCard).seq : (r.card as MinorCard).rank.seq;
        const maxRank = Math.max(...pool.map(rank));
        const winners = pool.filter(r => rank(r) === maxRank).map(r => r.player);

        if (winners.length === 1) {
            this.bidWinner = winners[0];
            this.beginRedraw();
            return;
        }

        // Tied - "set aside the bidding cards and then every player must
        // bid again, repeated until one player wins the bid." Every
        // player re-bids, not just the tied ones. This can only fail to
        // converge if someone's hand is now empty (nothing left to bid);
        // the rules don't cover that case. The engine-level fallback:
        // keep the tied players in the order they were already in -
        // `winners` is built by scanning players 1..numplayers in order
        // (see the loop above), so its first entry is simply the
        // lowest-numbered tied player, taken deterministically rather
        // than broken at random.
        this.bidRound += 1;
        if (this.hands.some(h => h.length === 0)) {
            this.bidWinner = winners[0];
            this.beginRedraw();
            return;
        }
        this.currplayer = 1;
    }

    // "The player to the right of the winner draws... as does each
    // player in turn counterclockwise around the table" - this engine's
    // own turn rotation (nextPlayer()) already goes winner -> winner+1 ->
    // ... , which is what "turns proceeding clockwise" (the very next
    // sentence in the rules) maps onto, so counterclockwise is simply the
    // reverse: starting at winner-1 and stepping by -1, ending at the
    // winner itself last.
    private beginRedraw(): void {
        const winner = this.bidWinner!;
        const order: playerid[] = [];
        let p = winner;
        for (let i = 0; i < this.numplayers; i++) {
            p = (((p - 2 + this.numplayers) % this.numplayers) + 1) as playerid;
            order.push(p);
        }
        this.redrawOrder = order;
        this.redrawPos = 0;
        this.phase = "redraw";
        if (this.numplayers === 2) {
            // Never assign currplayer to an arbitrary value here (reduces
            // exposure to any risk around directly reassigning it - see
            // task #38). currplayer is always player 2 at this exact
            // point (bidding is fixed player-1-then-player-2 order, and
            // this only runs once both have bid), so ordinary rotation
            // takes it to player 1 next - the loser if player 2 won, or
            // the winner (who isn't allowed to redraw yet) if player 1
            // won. In the latter case mustPassBeforeRedraw() reports it,
            // and the "autopass" flag (see gameinfo's own flags, and
            // moves() below) means a real server auto-submits "pass" for
            // player 1 the instant it's their only legal option, landing
            // on player 2 - exactly "the loser draws first," just reached
            // through the same rotation every other turn already uses
            // instead of a direct jump.
            this.nextPlayer();
        } else {
            this.currplayer = order[0];
        }
    }

    // "redraw <uid...>" - the acting player's free choice of cards from
    // the shared, fully public biddingPool (every bid card revealed
    // across the whole opening procedure), drawing exactly enough to
    // bring their hand back up to 6. Unlike "bid", uids are safe to name
    // directly here: by the time redraw is legal, every one of these
    // cards has already been revealed to everyone.
    // `partial` mirrors cmdDiscard's own split exactly: moving the picked
    // cards from the (fully public) pool into the acting player's hand is
    // safe to do even on a disposable preview instance, so the render can
    // show the pick accumulating - but advancing redrawPos/currplayer/
    // phase is the consequential part move()'s live-preview calls must
    // never trigger for real.
    private cmdRedraw(args: string[], partial = false): void {
        const failure = this.validateRedraw(args);
        if (failure !== undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", failure.message);
        }
        const hand = this.hands[this.currplayer - 1];
        for (const uid of args) {
            this.biddingPool.splice(this.biddingPool.indexOf(uid), 1);
            hand.push(uid);
        }
        if (partial) {
            return;
        }
        this.results.push({ type: "deckDraw", what: args.join(","), from: "pool" });

        this.redrawPos += 1;
        if (this.redrawPos < this.numplayers) {
            if (this.numplayers === 2) {
                // Ordinary rotation, not a direct jump (see beginRedraw's
                // own docs on why that matters) - with exactly two
                // players "whoever's next" is unconditionally "the other
                // one," so this can never disagree with the required
                // redraw order the way an arbitrary array-indexed jump
                // could for 3+ players.
                this.nextPlayer();
            } else {
                this.currplayer = this.redrawOrder[this.redrawPos];
            }
        } else {
            // Everyone has redrawn - the pool is now exactly empty (see
            // resolveBidRound's own accounting) and normal play begins.
            // redrawOrder always ends with the bid winner (see
            // beginRedraw's own docs - it's built to cycle back around to
            // them last), so whoever just submitted THIS, the final
            // redraw, already IS the winner - currplayer needs no further
            // adjustment for any player count, and for 2 players in
            // particular, no closing pass is needed either (the one pass
            // this variant ever needs, when it's needed at all, already
            // happened back at beginRedraw()).
            this.phase = "main";
            if (this.numplayers !== 2) {
                this.currplayer = this.bidWinner!;
            }
        }
    }

    // True exactly when the 2-player bidding variant's own "loser draws
    // first" rule blocks `player` from redrawing right now: they won the
    // bid, and the loser hasn't taken their own (first) redraw yet. Only
    // meaningful for exactly 2 players - the 3+ player redraw order is
    // still steered directly via redrawOrder/redrawPos (see beginRedraw's
    // own docs), so currplayer is always already correct there and this
    // always reports false. Shared by validateRedraw (reject a redraw
    // attempt from the blocked winner), validatePass/cmdPass (the only
    // situation where passing is legal), moves() (the "autopass" flag's
    // own signal - see its docs), and randomMove().
    private mustPassBeforeRedraw(player: playerid): boolean {
        return this.phase === "redraw" && this.numplayers === 2
            && this.redrawPos === 0 && player === this.bidWinner;
    }

    private validateRedraw(args: string[]): IValidationResult | undefined {
        if (this.mustPassBeforeRedraw(this.currplayer)) {
            return this.invalid("apgames:validation.gnostica.MUST_PASS_FIRST");
        }
        const hand = this.hands[this.currplayer - 1];
        const needed = 6 - hand.length;
        if (args.length !== needed) {
            return this.invalid("apgames:validation.gnostica.REDRAW_COUNT_MISMATCH", { requested: args.length, needed });
        }
        const seen = new Set<string>();
        for (const uid of args) {
            if (seen.has(uid)) {
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "DUPLICATE_CARD", uid });
            }
            seen.add(uid);
            if (!this.biddingPool.includes(uid)) {
                return this.invalid("apgames:validation.gnostica.REDRAW_UID_NOT_IN_POOL", { uid });
            }
        }
        return undefined;
    }

    // "pass" - exists purely for the 2-player bidding variant's own bid
    // winner to sit out the loser's first redraw (see
    // mustPassBeforeRedraw's own docs). Not a general-purpose pass: it's
    // illegal anywhere else, including the main phase (a bare "discard"
    // already fills that role there). A real server auto-submits this via
    // the "autopass" flag + moves() the instant it's the only legal
    // option, so a human should never actually need to submit it by hand.
    private cmdPass(partial = false): void {
        const failure = this.validatePass();
        if (failure !== undefined) {
            throw new UserFacingError("VALIDATION_GENERAL", failure.message);
        }
        if (partial) {
            return;
        }
        this.results.push({ type: "pass", who: this.currplayer, why: "bidding" });
        this.nextPlayer();
    }

    private validatePass(): IValidationResult | undefined {
        if (!this.mustPassBeforeRedraw(this.currplayer)) {
            return this.invalid("apgames:validation.gnostica.NOTHING_TO_PASS");
        }
        return undefined;
    }

    // The "autopass" flag's own signal (see gameinfo's own flags): a real
    // server calls this after every move resolves and, if it returns
    // exactly ["pass"], auto-submits "pass" on that player's behalf
    // rather than waiting for real input - see mustPassBeforeRedraw's own
    // docs for the one situation that actually triggers here. This is
    // deliberately NOT a general move enumerator (that's what the
    // "no-moves"/"custom-randomization" flags + randomMove() are for) -
    // every other situation returns [] ("not enumerating, but nothing is
    // forced"), matching this library's own established convention (see
    // e.g. knightline.ts's identical use of "autopass" + moves()).
    public moves(player?: playerid): string[] {
        const p = (player ?? this.currplayer) as playerid;
        if (this.mustPassBeforeRedraw(p)) {
            return ["pass"];
        }
        return [];
    }

    // "place <cell> [orientation]" - only legal with zero pieces on board;
    // orientation defaults to "U".
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
            territory = new CellContents(undefined);
            this.board.store.set(x, y, territory);
        }
        // Your very first piece comes from your own stash, same as every
        // other piece that ever enters play (Cups' "own" creation, growth,
        // etc.) - it isn't manufactured out of nothing.
        takeFromStash(this.buildPowerContext(), this.currplayer, 1);
        territory.add(new Piece(this.currplayer, 1, orientation));
        this.addBufferIfWasteland(x, y);
        this.results.push({ type: "place", where: cellStr, how: "initial" });
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
        this.addBufferIfWasteland(x, y);
        const orientation = this.parseOrientation(orientationStr);
        piece.orientation = orientation;
        this.results.push({ type: "orient", where: GnosticaBoard.coords2algebraic(x, y), what: this.stripCellFromRef(ref), facing: orientation });
    }

    // Any board cell whose facing might get set/adjusted by a click -
    // reorienting an existing minion (cmdOrient), a newly placed one
    // (cmdPlace), a newly created one (Cups "own"), or a special power's
    // own target (orientMinion/orientAny/hierophantReplace) - needs a
    // buffer on a given side only if facing that way points at a void
    // cell that's ALSO outside the rendered window (renderWindow's own
    // docs on why that's not the same thing as this.board's raw
    // minX/maxX/minY/maxY). A void cell still inside the window is a
    // perfectly ordinary click target - orientationTowardClick doesn't
    // care what's classified there, and handleClickCore's row/col math
    // is the same for every in-window cell regardless of its glyph - so
    // no buffer (Pacru's own "buffer" approach, not an expanded/padded
    // void ring - see handleClickCore's own docs on reading a buffer
    // click back) is needed there at all. Checked independently per side
    // (not else-if) since a piece parked at a genuine corner of the
    // board's own stored extent can legitimately need two at once.
    // Recomputed on every call (this.buffers itself is reset at the top
    // of every move() call), so this always reflects wherever the
    // CURRENTLY relevant piece actually sits - and deliberately ignores
    // that piece's own (pre-existing) orientation entirely.
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
    // the max), or as many as possible if "draw <n>" is omitted entirely.
    // Reshuffles the discard pile into the draw pile if it runs dry, same
    // as every other draw-pile-exhaustion spot - see
    // reshuffle logic in gnostica/powers.ts (this one
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
    // Use / play a card - both minor and major arcana. Each minor card has
    // exactly one suit power, always optional, used by exactly one minion.
    // Major arcana can chain up to 3 power steps across several minions
    // (see MAJOR_ARCANA in gnostica/majorArcana.ts).
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
        this.results.push({ type: "use", what: t.card!.uid });
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
        this.results.push({ type: "deckDraw", what: uid, from: "hand" });

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
        if (this.isMinionCellStillNarrowing(minionRef, eligible)) {
            return; // cell chosen, which minion there is still undecided - still declined
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
        if (this.isMinionCellStillNarrowing(minionRef, eligible)) {
            return undefined; // cell chosen, which minion there is still undecided - still declined
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
        if (this.isMinionCellStillNarrowing(minionRef, minions)) {
            return undefined; // cell chosen, which minion there is still undecided - still declined
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

    // Mirrors applyPowerStep's own "incomplete step, still declined"
    // tolerance (same rationale as validateMinorPower's) - see the inline
    // comments below and applyPowerStep's own docs.
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
        if (this.isMinionCellStillNarrowing(minionRef, minions)) {
            return { failed: false }; // cell chosen, which minion there is still undecided - still declined
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
                this.addBufferIfWasteland(tx, ty);
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
                this.results.push({ type: "place", where: cellStr, how: "territory" });
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
                // pre-mutation length here IS its post-mutation index. The
                // target cell may not have a stored CellContents yet (a
                // genuinely untouched wasteland), so this ref carries its
                // own piece data rather than relying on a later board read.
                const newIndex = this.board.get(tx, ty)?.pieces.length ?? 0;
                return { failed: false, outcome: { newMinion: { x: tx, y: ty, index: newIndex, piece: new Piece(this.currplayer, 1, orientation) } } };
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
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "U">);
                const destX = target.x + dx * dist;
                const destY = target.y + dy * dist;
                // A genuine final landing (not a Chariot-relaxed waypoint)
                // in the void destroys the piece instead of moving it -
                // see movePiece's own docs.
                const destroyedInVoid = opts.skipLandingCheck !== true && this.board.classify(destX, destY) === "void";
                const origin = GnosticaBoard.coords2algebraic(target.x, target.y);
                movePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, dist, newOrientation, opts);
                if (destroyedInVoid) {
                    this.results.push({ type: "destroy", where: origin, what: this.stripCellFromRef(targetRef) });
                    return {};
                }
                const dest = GnosticaBoard.coords2algebraic(destX, destY);
                this.results.push({ type: "move", from: origin, to: dest, what: this.stripCellFromRef(targetRef), how: "rod-piece" });
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
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "U">);
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
                const movedPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                const facing = this.board.get(minion.x, minion.y)!.pieces[minion.index].orientation;
                const [dx, dy] = this.board.delta(facing as Exclude<Orientation, "U">);
                const destX = target.x + dx * dist;
                const destY = target.y + dy * dist;
                const destroyedInVoid = opts.skipLandingCheck !== true && this.board.classify(destX, destY) === "void";
                if (destroyedInVoid) {
                    return { failed: false };
                }
                if (movedPiece.owner === this.currplayer) {
                    // The destination may not have a stored CellContents yet (a
                    // genuinely untouched wasteland), so this ref carries
                    // its own piece data rather than relying on a later
                    // board read - see IMinionRef's own docs.
                    const newIndex = this.board.get(destX, destY)?.pieces.length ?? 0;
                    const finalOrientation = orientationStr !== undefined ? this.tryParseOrientation(orientationStr)! : movedPiece.orientation;
                    const newPiece = new Piece(movedPiece.owner, movedPiece.size, finalOrientation);
                    return { failed: false, outcome: { newMinion: { x: destX, y: destY, index: newIndex, piece: newPiece } } };
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
                this.results.push({ type: "convert", what: `size-${beforeSize}`, into: `size-${beforeSize + 1}`, where: GnosticaBoard.coords2algebraic(target.x, target.y) });
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
                this.results.push({ type: "destroy", where: GnosticaBoard.coords2algebraic(target.x, target.y), what: this.stripCellFromRef(targetRef) });
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
        this.addBufferIfWasteland(minion.x, minion.y);
        this.results.push({
            type: "orient",
            where: GnosticaBoard.coords2algebraic(minion.x, minion.y),
            what: this.stripCellFromRef(this.pieceRefStr(minion.x, minion.y, minion.index)),
            facing: orientation,
        });
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
        this.addBufferIfWasteland(target.x, target.y);
        this.results.push({ type: "orient", where: GnosticaBoard.coords2algebraic(target.x, target.y), what: this.stripCellFromRef(targetRef), facing: orientation });
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
        this.addBufferIfWasteland(target.x, target.y);
        this.results.push({ type: "convert", what: this.stripCellFromRef(targetRef), into: `owner-${this.currplayer}`, where: GnosticaBoard.coords2algebraic(target.x, target.y) });
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
            const origin = GnosticaBoard.coords2algebraic(target.x, target.y);
            hermitMovePiece(ctx, minion.x, minion.y, minion.index, target.x, target.y, target.index, destX, destY, newOrientation);
            this.results.push({ type: "move", from: origin, to: destCellStr, what: this.stripCellFromRef(targetRef), how: "hermit-piece" });
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
            const movedPiece = this.board.get(target.x, target.y)!.pieces[target.index];
            if (movedPiece.owner === this.currplayer) {
                // The destination may not have a stored CellContents yet (a
                // genuinely untouched wasteland), so this ref carries its
                // own piece data rather than relying on a later board read -
                // see IMinionRef's own docs.
                const newIndex = this.board.get(destX, destY)?.pieces.length ?? 0;
                const finalOrientation = orientationStr !== undefined ? this.tryParseOrientation(orientationStr)! : movedPiece.orientation;
                const newPiece = new Piece(movedPiece.owner, movedPiece.size, finalOrientation);
                return { failed: false, outcome: { newMinion: { x: destX, y: destY, index: newIndex, piece: newPiece } } };
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

    // Sort cards by their index in allCards.
    private static handSortKey(uid: string): number {
        const card = allCards().find(c => c.uid === uid);
        return card === undefined ? 100 : allCards().indexOf(card);
    }

    // Cards in `player`'s hand that weren't there as of the start of
    // their last turn (see move()'s own docs on handBaseline) - render()
    // uses this to highlight them. Only ever non-empty for the CURRENT
    // player, and only until they've started building THIS turn's own
    // move: `liveMove` is transient and never survives serialization,
    // but that's exactly right here - render() only ever runs either
    // with no move() call at all (the idle view, before any click, where
    // liveMove is still unset) or immediately after one ON THAT SAME
    // instance (liveMove correctly reflecting THAT call's own move
    // string) - see move()'s own docs on why every partial preview call
    // reconstructing a fresh instance per click doesn't break this.
    private newHandCardUids(player: playerid): Set<string> {
        if (player !== this.currplayer || this.liveMove !== undefined) {
            return new Set();
        }
        const baseline = new Set(this.handBaseline[player - 1] ?? []);
        return new Set((this.hands[player - 1] ?? []).filter(uid => !baseline.has(uid)));
    }

    // Cards added to the discard pile by the most recently completed move
    // (see move()'s own docs on discardBaseline) - render() highlights
    // them the same way newHandCardUids highlights a just-drawn hand
    // card. Not scoped to a specific viewer the way newHandCardUids is
    // (the discard pile is always fully public) and clears the instant
    // ANY player's next move is submitted, not just the acting player's
    // own next turn - there's only one shared pile, so "whose turn is
    // it" isn't a meaningful gate here.
    private newDiscardUids(): Set<string> {
        if (this.liveMove !== undefined) {
            return new Set();
        }
        const baseline = new Set(this.discardBaseline);
        return new Set(this.discardPile.filter(uid => !baseline.has(uid)));
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

    // Position i is always player i+1's score - the framework-wide
    // convention every other game's own sidebarScores() already follows
    // (see e.g. magnate.ts), since the front end reads this array
    // positionally with no other player label attached. Always plain
    // player-number order, even for the bidding variant (where the
    // FIRST mover isn't necessarily player 1) - reordering by turn order
    // here would silently attribute the wrong score to the wrong
    // player's own slot on the real site.
    public sidebarScores(): IScores[] {
        const scores: number[] = [];
        for (let p = 1; p <= this.numplayers; p++) {
            scores.push(this.scoreFor(p as playerid));
        }
        return [
            { name: i18next.t("apgames:status.SCORES"), scores },
        ];
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

    // Rules text: an eliminated player discards their hand. Their board
    // pieces aren't addressed explicitly, but every other piece-removal
    // path in this file (see powers.ts) returns the piece to its owner's
    // stash rather than deleting it outright, so this follows suit.
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

    // ============================================================
    // randomMove() and its supporting builders
    //
    // `custom-randomization` is declared precisely because full `moves()`
    // enumeration of every legal chained-power target combination is
    // combinatorially infeasible - randomMove() instead CONSTRUCTS a
    // candidate move (random targets/modes/cards at each decision point)
    // and leans on this file's own existing validateX functions as the
    // single source of truth for legality, rather than re-deriving every
    // rule itself. Every builder below either produces something
    // guaranteed legal by construction, or verifies its own candidate
    // against the matching validateX before accepting it - see each
    // one's own docs for which. The top-level dispatch below also runs
    // the fully-assembled move through validateMove() as a final safety
    // net before returning it.
    // ============================================================

    public randomMove(): string {
        if (this.gameover) {
            return ""; // matches magnate.ts's own precedent for this case
        }
        if (this.phase === "bidding") {
            const hand = this.hands[this.currplayer - 1];
            return `bid ${1 + Math.floor(Math.random() * hand.length)}`;
        }
        if (this.phase === "redraw") {
            if (this.mustPassBeforeRedraw(this.currplayer)) {
                return "pass";
            }
            const needed = 6 - this.hands[this.currplayer - 1].length;
            const picks = (shuffle(this.biddingPool) as string[]).slice(0, needed);
            return `redraw ${picks.join(" ")}`.trim();
        }
        if (!this.hasPiecesOnBoard(this.currplayer)) {
            return this.randomPlaceMove();
        }
        // Once eligible to declare (own score already at/above target,
        // and nobody else has an active declaration pending - see
        // move()'s own ALREADY_ANNOUNCED gate), sometimes append the
        // "(last)" suffix to whatever move is about to be returned.
        // Without this, a game played purely by randomMove() could never
        // actually end - gameover/winner/elimination are only ever
        // decided inside resolveAnnouncedTurn(), which itself only runs
        // on the turn following a real declaration (see its own docs).
        // Not unconditional even once eligible - a real player might
        // wait for a wider safety margin first, same as this file's own
        // "prefer, don't require" weighting elsewhere in randomMove().
        const canAnnounce = (this.lastTurnAnnouncedBy === undefined || this.lastTurnAnnouncedBy === this.currplayer)
            && this.scoreFor(this.currplayer) >= this.targetScore();
        const announce = canAnnounce && Math.random() < 0.25;
        // "discard" is always unconditionally legal once the player has
        // board presence (any subset of hand, no draw suffix required),
        // so shuffling every head into the try-order and falling all the
        // way through to a bare "discard" guarantees this loop always
        // terminates with something real.
        const heads = shuffle(["use", "play", "orient", "discard"]) as string[];
        for (const head of heads) {
            try {
                const candidate = this.buildRandomHeadMove(head);
                if (candidate === undefined) {
                    continue;
                }
                const finalCandidate = announce ? `${candidate} (last)` : candidate;
                const check = this.validateMove(finalCandidate);
                if (!check.valid || check.complete !== 1) {
                    continue;
                }
                // validateMove() never mutates, so a multi-step chain that
                // re-targets a piece/territory an EARLIER step of the same
                // chain relocated can look fully legal here (step 2 still
                // "sees" the original, pre-move board) while actually
                // committing it later would fail - the same
                // validate/apply divergence as task #45, just triggered by
                // a later step's own target rather than its acting minion.
                // A cheap commit-on-a-throwaway-clone check catches this
                // (and anything else in the same class) before it's ever
                // handed back as "the" move, matching how click-support's
                // own preview already verifies via clone+real-apply rather
                // than trusting prediction.
                this.clone().move(finalCandidate, { trusted: false });
                return finalCandidate;
            } catch {
                // A speculative chain can hit a still-open engine edge case
                // (see task #45 - a later step's own acting minion landing
                // on a cell the board doesn't actually have data for yet)
                // that throws instead of failing validation gracefully.
                // Same tolerance as an ordinary failed candidate: drop it
                // and let the loop try a different head/card/chain shape -
                // "discard" below is always available as the last resort.
                continue;
            }
        }
        return announce ? "discard (last)" : "discard";
    }

    private buildRandomHeadMove(head: string): string | undefined {
        switch (head) {
            case "discard": return this.randomDiscardMove();
            case "orient": return this.randomOrientMove();
            case "use": return this.randomUseOrPlayMove("use");
            case "play": return this.randomUseOrPlayMove("play");
            default: return undefined;
        }
    }

    // Every cell that's both non-void and currently holds zero pieces -
    // scanned over the same window render() uses (see renderWindow's own
    // docs), NOT just `board.entries()` (which only yields cells with a
    // stored CellContents object - see randomPlaceMove's own docs on why
    // that under-enumerates). Shared by randomPlaceMove (a legal
    // initial-placement target) and buildRandomHermitTokens (a legal
    // teleport destination - hermit's own rules use the identical "empty
    // territory or wasteland" shape).
    private emptyNonVoidCells(): [number, number][] {
        const { minX, maxX, minY, maxY } = this.renderWindow();
        const cells: [number, number][] = [];
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                if (this.board.classify(x, y) === "void") {
                    continue;
                }
                const t = this.board.get(x, y);
                if (t !== undefined && t.pieces.length > 0) {
                    continue;
                }
                cells.push([x, y]);
            }
        }
        return cells;
    }

    // Candidate cells are scanned the same padded window render() uses
    // (board's own min/max +/-1 in each direction), NOT just
    // `board.entries()` - entries() only yields cells with a stored
    // CellContents object, but a never-touched wasteland adjacent to an
    // existing territory (classify() derives wasteland-ness from
    // NEIGHBORING cards, not from whether the cell itself was ever
    // stored) is an equally legal placement target. This matters a lot
    // here specifically: place is the ONLY legal head whenever
    // !hasPiecesOnBoard (every other head, including bare discard,
    // throws MUST_PLACE_FIRST), so under-enumerating candidates isn't
    // just a coverage gap, it risks returning nothing legal at all in a
    // forced-re-placement-after-wipeout scenario.
    // Weighted random pick: each item's weight (always > 0) is its
    // relative probability. Used to bias randomMove()'s own choices
    // toward outcomes that are ordinarily stronger - a card cell over a
    // bare wasteland for placement, a higher-value card for use/play -
    // without ever ruling the weaker options out entirely, the same way
    // a human player occasionally still takes the less obvious option.
    private weightedPick<T>(items: T[], weight: (item: T) => number): T {
        const weights = items.map(weight);
        const total = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        for (let i = 0; i < items.length; i++) {
            r -= weights[i];
            if (r <= 0) {
                return items[i];
            }
        }
        return items[items.length - 1]; // floating-point safety net
    }

    // A full ordering, not just one pick: repeated weightedPick-without-
    // replacement. Used where a caller needs to TRY candidates in order
    // until one validates (findRandomPrimitiveChoice's own retry loop) -
    // higher-weight candidates tend to land earlier and so get tried
    // (and kept) first, but every candidate is still reachable if the
    // earlier ones all fail validation.
    private weightedShuffle<T>(items: T[], weight: (item: T) => number): T[] {
        const pool = [...items];
        const result: T[] = [];
        while (pool.length > 0) {
            const picked = this.weightedPick(pool, weight);
            pool.splice(pool.indexOf(picked), 1);
            result.push(picked);
        }
        return result;
    }

    private randomPlaceMove(): string {
        const candidates = this.emptyNonVoidCells();
        // Structurally shouldn't happen (the board always has somewhere
        // to place in practice), but "discard" would be flatly illegal
        // in this exact state (see this function's own docs) - "" (no
        // legal move) is the honest answer, matching the gameover case
        // above, rather than returning something guaranteed to throw.
        if (candidates.length === 0) {
            return "";
        }
        // Landing on an existing card gives immediate access to its
        // power, so it's weighted 3x over a bare wasteland cell - a
        // strong preference, not a requirement (see weightedPick's own
        // docs).
        const [x, y] = this.weightedPick(candidates, ([cx, cy]) => this.board.classify(cx, cy) === "territory" ? 3 : 1);
        const orientations: Orientation[] = ["U", ...cardinalOrientations];
        const orientation = orientations[Math.floor(Math.random() * orientations.length)];
        return `place ${GnosticaBoard.coords2algebraic(x, y)} ${orientation}`;
    }

    // Any subset of hand is a legal discard list; an optional "draw <n>"
    // suffix (random count up to the room left) is sometimes added,
    // otherwise the draw-to-max default applies - see cmdDiscard's own
    // docs. Always legal by construction.
    private randomDiscardMove(): string {
        const hand = this.hands[this.currplayer - 1];
        const discards = hand.filter(() => Math.random() < 0.3);
        const maxDraw = Math.max(0, 6 - (hand.length - discards.length));
        const tokens = ["discard", ...discards];
        if (Math.random() < 0.5) {
            tokens.push("draw", String(Math.floor(Math.random() * (maxDraw + 1))));
        }
        return tokens.join(" ");
    }

    // Any of the acting player's own on-board pieces, reoriented to any
    // of the 5 facings - unconditionally legal for your own piece.
    // undefined only if hasPiecesOnBoard's own scan somehow disagrees
    // with this one (defensive; can't happen in the only place this is
    // called from).
    private randomOrientMove(): string | undefined {
        const ownPieces: { x: number; y: number; index: number }[] = [];
        for (const [x, y, t] of this.board.entries()) {
            t.pieces.forEach((p, index) => {
                if (p.owner === this.currplayer) {
                    ownPieces.push({ x, y, index });
                }
            });
        }
        if (ownPieces.length === 0) {
            return undefined;
        }
        const { x, y, index } = ownPieces[Math.floor(Math.random() * ownPieces.length)];
        const ref = this.pieceRefStr(x, y, index);
        const orientations: Orientation[] = ["U", ...cardinalOrientations];
        const orientation = orientations[Math.floor(Math.random() * orientations.length)];
        return `orient ${ref} ${orientation}`;
    }

    // "use"/"play" - candidate card, then a random (possibly empty) power
    // chain. See buildRandomChain's own docs for the chain-building
    // strategy; this just picks the target card and assembles the final
    // move string.
    private randomUseOrPlayMove(head: "use" | "play"): string | undefined {
        if (head === "use") {
            const onBoard: { uid: string; eligible: IMinionRef[] }[] = [];
            for (const [x, y, t] of this.board.entries()) {
                if (t.card === undefined) {
                    continue;
                }
                const eligible = this.eligibleMinionsForActivate(x, y);
                if (eligible.length > 0) {
                    onBoard.push({ uid: t.card.uid, eligible });
                }
            }
            if (onBoard.length === 0) {
                return undefined;
            }
            // Prefer a higher-value card - its own point value doubles as
            // a natural "how good is this option" weight (see
            // weightedPick's own docs) - without ever ruling out a lesser
            // one.
            const { uid, eligible } = this.weightedPick(onBoard, ({ uid: u }) => cardPointValue(allCards().find(c => c.uid === u)));
            const card = allCards().find(c => c.uid === uid)!;
            const chain = this.buildRandomChain(card, eligible);
            return [`use ${uid}`, ...chain.map(tokens => tokens.join(" "))].join(", ");
        }
        const hand = this.hands[this.currplayer - 1];
        if (hand.length === 0) {
            return undefined;
        }
        const uid = this.weightedPick(hand, u => cardPointValue(allCards().find(c => c.uid === u)));
        const card = allCards().find(c => c.uid === uid)!;
        const eligible = this.eligibleMinionsForPlay();
        // cmdPlay removes the played card from hand before resolving its
        // power (it's spent to fund the ability, same as a discard), so a
        // chain step that spends a hand card (Cups "new", Discs/Swords
        // "tile") can't legally reuse this exact uid as its own material.
        // Temporarily removing it here - restored below regardless of
        // outcome, since this speculative build must never leave a lasting
        // side effect on the real hand - makes buildRandomChain's own hand
        // reads see the same post-play hand a real commit would.
        const handIdx = hand.indexOf(uid);
        hand.splice(handIdx, 1);
        try {
            const chain = this.buildRandomChain(card, eligible);
            return [`play ${uid}`, ...chain.map(tokens => tokens.join(" "))].join(", ");
        } finally {
            hand.splice(handIdx, 0, uid);
        }
    }

    // Every legal target ref for a minion's own "piece"-shaped actions:
    // itself, plus every piece (any owner) sitting in its facing cell -
    // exactly the target set checkValidPieceTarget allows. Shared by
    // every builder below that needs a piece-shaped target (R.piece/
    // D.piece/S.piece, tradeHands, orientAny, hierophantReplace,
    // hermitTeleport's own "piece" mode).
    private pieceTargetRefs(minion: IMinionRef): string[] {
        const [tx, ty] = this.minorTargetCell(minion);
        const selfRef = this.pieceRefStr(minion.x, minion.y, minion.index);
        if (tx === minion.x && ty === minion.y) {
            return [selfRef];
        }
        const targetT = this.board.get(tx, ty);
        const facingRefs = (targetT?.pieces ?? []).map((_, i) => this.pieceRefStr(tx, ty, i));
        return [selfRef, ...facingRefs];
    }

    // Same target set as pieceTargetRefs, but keeping each ref's owner
    // alongside it - used only to weight R.piece/D.piece/S.piece
    // candidates toward "grow/reposition your own minion, attack
    // someone else's" (see buildRandomModeArgCandidates's own docs).
    // Every OTHER pieceTargetRefs caller (tradeHands, orientAny,
    // hierophantReplace, hermitTeleport) has no such constructive/
    // destructive distinction to weight, so it isn't worth widening the
    // shared helper's own return type for them.
    private pieceTargetRefsWithOwner(minion: IMinionRef): { ref: string; owner: number }[] {
        const [tx, ty] = this.minorTargetCell(minion);
        const selfOwner = this.board.get(minion.x, minion.y)!.pieces[minion.index].owner;
        const selfRef = this.pieceRefStr(minion.x, minion.y, minion.index);
        if (tx === minion.x && ty === minion.y) {
            return [{ ref: selfRef, owner: selfOwner }];
        }
        const targetT = this.board.get(tx, ty);
        const facing = (targetT?.pieces ?? []).map((p, i) => ({ ref: this.pieceRefStr(tx, ty, i), owner: p.owner }));
        return [{ ref: selfRef, owner: selfOwner }, ...facing];
    }

    // Adapts legalMinorModes' own switch to a raw minion rather than an
    // IPendingStep (reconstructed from a move string, not convenient
    // here) - same per-mode legality rules, just read directly off the
    // minion/board. Best-effort pre-filter only, same as legalMinorModes
    // itself - buildRandomModeArgCandidates + validateSuitPrimitive
    // remain the real gate.
    private legalModesForMinion(minion: IMinionRef, suitUid: string, ignoreCapacity: boolean): string[] {
        const piece = this.board.get(minion.x, minion.y)!.pieces[minion.index];
        const [tx, ty] = this.minorTargetCell(minion);
        const targetT = this.board.get(tx, ty);
        return Object.keys(MINOR_MODES[suitUid]).filter(mode => {
            switch (`${suitUid}.${mode}`) {
                case "C.own":
                    return targetT === undefined || targetT.canAdd(ignoreCapacity);
                case "C.enemy":
                    return (targetT?.pieces ?? []).some(p => p.owner !== this.currplayer);
                case "C.new":
                    return this.board.classify(tx, ty) === "wasteland";
                case "R.piece":
                case "R.tile":
                    return piece.orientation !== "U";
                case "D.tile":
                case "S.tile":
                    return (targetT?.pointValue() ?? 0) > 0;
                default:
                    return true;
            }
        });
    }

    // Every plausible full set of trailing args (after "<minionRef>
    // <mode>") for one suit-mode, given hand sizes/pip counts small
    // enough that a full enumeration is cheap - not just one random
    // guess, since several of these (a hand card matching an exact
    // value, a specific victim among several) have a narrow or empty
    // legal set that blind random guessing would miss far more often
    // than it hit. Each candidate carries a weight (see weightedPick's
    // own docs) biasing findRandomPrimitiveChoice's search toward
    // constructive actions (grow/create) landing on the acting player's
    // OWN minion/territory, and destructive actions (attack) landing on
    // someone else's or a neutral one - a piece/territory-shrinking
    // action against your own side, or a growing one that only helps an
    // opponent, is rarely what a player actually wants, even though the
    // rules allow it. Modes with no self/other choice at all in their
    // own target set (C.own/C.enemy/C.new/R.tile, each always self-only,
    // enemy-only, or plain territory) get a flat weight of 1 throughout.
    private buildRandomModeArgCandidates(minion: IMinionRef, suitUid: string, mode: string): { args: string[]; weight: number }[] {
        const piece = this.board.get(minion.x, minion.y)!.pieces[minion.index];
        const [tx, ty] = this.minorTargetCell(minion);
        const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
        const targetT = this.board.get(tx, ty);
        const hand = this.hands[this.currplayer - 1];
        const orientations: Orientation[] = ["U", ...cardinalOrientations];
        const pieceTargets = this.pieceTargetRefsWithOwner(minion);
        const pips = Array.from({ length: piece.size }, (_, i) => String(i + 1));
        const cardsWorth = (value: number) => hand.filter(uid => {
            const c = allCards().find(cc => cc.uid === uid);
            return c !== undefined && cardPointValue(c) === value;
        });
        const flat = (candidates: string[][]): { args: string[]; weight: number }[] => candidates.map(args => ({ args, weight: 1 }));
        // Growing/attacking a territory benefits whoever currently profits
        // from it uncontested - a cell nobody profits from yet (contested,
        // or genuinely neutral) counts as "not the acting player's own"
        // for this purpose, same as an outright enemy-controlled one.
        const benefitsSelf = targetT?.isUncontestedBy(this.currplayer) ?? false;

        switch (`${suitUid}.${mode}`) {
            case "C.own":
                return flat(orientations.map(o => [targetCell, o]));
            case "C.enemy":
                return flat((targetT?.pieces ?? [])
                    .map((p, i) => ({ p, i }))
                    .filter(({ p }) => p.owner !== this.currplayer)
                    .map(({ i }) => [targetCell, this.victimRefStr(tx, ty, i)]));
            case "C.new":
                return flat(cardsWorth(1).map(uid => [targetCell, uid]));
            case "R.piece": {
                // Moving your own minion is ordinary positioning; shoving
                // an enemy's is a real but less common destructive tactic
                // (e.g. into the void) - lean toward self without ruling
                // the other out. Within "move your own minion" candidates
                // specifically, also lean toward whatever distance lands it
                // on a territory cell rather than a bare wasteland - moving
                // your own piece off a productive cell for no reason isn't
                // something a real player would usually choose, even though
                // the rules allow it (an enemy's piece gets no such
                // preference: walking it off into the wasteland is a
                // legitimate destructive use of the same mode).
                const [dx, dy] = this.board.delta(piece.orientation as Exclude<Orientation, "U">);
                const selfRef = this.pieceRefStr(minion.x, minion.y, minion.index);
                return pieceTargets.flatMap(({ ref, owner }) => {
                    const [bx, by] = ref === selfRef ? [minion.x, minion.y] : [tx, ty];
                    return pips.map(d => {
                        const dist = Number(d);
                        const ownWeight = owner === this.currplayer ? 2 : 1;
                        const landsOnTerritory = owner === this.currplayer
                            && this.board.classify(bx + dx * dist, by + dy * dist) === "territory";
                        return { args: [ref, d], weight: ownWeight * (landsOnTerritory ? 2 : 1) };
                    });
                });
            }
            case "R.tile":
                return flat(pips.map(d => [d]));
            case "D.piece":
                // Growing is constructive - strongly favor your own
                // minion over an enemy's.
                return pieceTargets.map(({ ref, owner }) => ({ args: [ref], weight: owner === this.currplayer ? 3 : 1 }));
            case "D.tile": {
                const current = targetT?.pointValue() ?? 0;
                const weight = benefitsSelf ? 3 : 1;
                return [...cardsWorth(current + 1), ...cardsWorth(current + 2)].map(uid => ({ args: [targetCell, uid], weight }));
            }
            case "S.piece":
                // Attacking is destructive - strongly favor an enemy's
                // minion over your own.
                return pieceTargets.flatMap(({ ref, owner }) =>
                    pips.map(p => ({ args: [ref, p], weight: owner === this.currplayer ? 1 : 3 })));
            case "S.tile": {
                const current = targetT?.pointValue() ?? 0;
                const weight = benefitsSelf ? 1 : 3;
                const results: { args: string[]; weight: number }[] = [];
                for (const p of pips) {
                    const resultValue = current - Number(p);
                    if (resultValue < 0) {
                        continue;
                    }
                    if (resultValue === 0) {
                        results.push({ args: [targetCell, p], weight });
                    } else {
                        for (const uid of cardsWorth(resultValue)) {
                            results.push({ args: [targetCell, p, uid], weight });
                        }
                    }
                }
                return results;
            }
            default:
                return [];
        }
    }

    // Searches for one legal (minion, mode, args) combination for a suit
    // primitive - shuffled minion pool, shuffled legal modes per minion,
    // weighted-shuffled arg candidates per mode (see
    // buildRandomModeArgCandidates's own docs on the weighting), first
    // fully-validated combination wins. Returns the raw pieces (not yet
    // assembled into a move-string token array) since magicianChoice
    // needs the same raw minion to build its own doubly-wrapped step;
    // buildRandomStepTokens below is the thin wrapper that assembles
    // tokens for direct suit-mode use.
    private findRandomPrimitiveChoice(
        suitUid: string, minions: IMinionRef[], opts: Record<string, unknown>,
    ): { minion: IMinionRef; mode: string; args: string[] } | undefined {
        const ignoreCapacity = opts.ignoreCapacity === true;
        const pool = shuffle([...minions]) as IMinionRef[];
        for (const minion of pool) {
            const modeCandidates = this.legalModesForMinion(minion, suitUid, ignoreCapacity)
                .map(mode => ({ mode, candidates: this.buildRandomModeArgCandidates(minion, suitUid, mode) }));
            // R.piece's own best candidate weight already tells us whether
            // ANY way of using it here actually lands the acting player's
            // own minion on a territory cell (see buildRandomModeArgCandidates's
            // R.piece case - that combination alone reaches weight 4). When
            // it doesn't - every option either moves an enemy or stubbornly
            // strands your own piece in the wasteland (a fixed 1-space hop
            // for a size-1 minion has no better distance to pick) - this
            // mode is a comparatively weak choice for THIS minion
            // specifically, so it's down-weighted against this minion's
            // other legal modes rather than picked on equal footing.
            // C.own's own target cell is entirely fixed by the minion's
            // facing (no arg choice to weight the way R.piece has) - landing
            // a new own piece on an already-established territory keeps it
            // immediately productive, while landing on bare wasteland is
            // the normal "push into new ground" use of the mode, still
            // legal and often the only option a minion actually has. Both
            // cases favor the acting player's own placement; still legal,
            // still sometimes chosen - "prefer, don't require" (see
            // weightedPick's own docs), same philosophy as every other
            // weighting in this file.
            const modeWeight = ({ mode, candidates }: { mode: string; candidates: { weight: number }[] }): number => {
                const key = `${suitUid}.${mode}`;
                if (key === "R.piece" && candidates.length > 0) {
                    return Math.max(...candidates.map(c => c.weight)) >= 4 ? 3 : 1;
                }
                if (key === "C.own") {
                    const [tx, ty] = this.minorTargetCell(minion);
                    return this.board.classify(tx, ty) === "territory" ? 3 : 1;
                }
                return 3;
            };
            const orderedModes = this.weightedShuffle(modeCandidates, modeWeight);
            for (const { mode, candidates } of orderedModes) {
                const ordered = this.weightedShuffle(candidates, c => c.weight);
                for (const { args } of ordered) {
                    const check = this.validateSuitPrimitive(suitUid, minion, mode, args, opts);
                    if (!check.failed) {
                        return { minion, mode, args };
                    }
                }
            }
        }
        return undefined;
    }

    private buildRandomStepTokens(suitUid: string, minions: IMinionRef[], opts: Record<string, unknown>): string[] | undefined {
        const choice = this.findRandomPrimitiveChoice(suitUid, minions, opts);
        if (choice === undefined) {
            return undefined;
        }
        const ref = this.pieceRefStr(choice.minion.x, choice.minion.y, choice.minion.index, minions);
        return [ref, choice.mode, ...choice.args];
    }

    // A major card's own `primitive` step - same suit machinery as a
    // minor card's single step, but the relaxation opts a shortcut card
    // (Chariot/Strength/Death/Sun/Star/Moon/Empress/Emperor) grants for
    // THIS step depend on where it sits in the chain, hence threading
    // def/stepIndex/totalSteps through to computeShortcutOpts - the same
    // call a real commit makes - rather than always building against the
    // unrelaxed rules. computeShortcutOpts's relaxations only ever WIDEN
    // legality, so skipping this would be safe, just needlessly weaker
    // coverage of those cards' own shortcut paths.
    private buildRandomPrimitiveStepTokens(
        primitive: SuitPrimitive, minions: IMinionRef[], def: MajorArcanaDef, stepOpts: PrimitiveOpts | undefined, stepIndex: number, totalSteps: number,
    ): string[] | undefined {
        const suitUid = this.primitiveToSuit(primitive);
        const opts = this.computeShortcutOpts(def, primitive, stepIndex, totalSteps, stepOpts);
        return this.buildRandomStepTokens(suitUid, minions, opts);
    }

    private buildRandomOrientMinionTokens(minions: IMinionRef[]): string[] | undefined {
        const pool = shuffle([...minions]) as IMinionRef[];
        const orientations: Orientation[] = ["U", ...cardinalOrientations];
        for (const minion of pool) {
            for (const o of shuffle([...orientations]) as Orientation[]) {
                const check = this.validateOrientMinion(minion, [o]);
                if (!check.failed) {
                    const ref = this.pieceRefStr(minion.x, minion.y, minion.index, minions);
                    return [ref, o];
                }
            }
        }
        return undefined;
    }

    private buildRandomTradeHandsTokens(minions: IMinionRef[]): string[] | undefined {
        const pool = shuffle([...minions]) as IMinionRef[];
        for (const minion of pool) {
            for (const targetRef of shuffle(this.pieceTargetRefs(minion)) as string[]) {
                const check = this.validateTradeHands(minion, [targetRef]);
                if (!check.failed) {
                    const ref = this.pieceRefStr(minion.x, minion.y, minion.index, minions);
                    return [ref, targetRef];
                }
            }
        }
        return undefined;
    }

    // Shared by orientAny (Devil) and hierophantReplace (Hierophant) -
    // identical shape (<minionRef> <targetRef> <orientation>), just a
    // different validateX to check against.
    private buildRandomOrientAnyOrHierophantTokens(minions: IMinionRef[], special: "orientAny" | "hierophantReplace"): string[] | undefined {
        const pool = shuffle([...minions]) as IMinionRef[];
        const orientations: Orientation[] = ["U", ...cardinalOrientations];
        for (const minion of pool) {
            for (const targetRef of shuffle(this.pieceTargetRefs(minion)) as string[]) {
                for (const o of shuffle([...orientations]) as Orientation[]) {
                    const check = special === "orientAny"
                        ? this.validateOrientAny(minion, [targetRef, o])
                        : this.validateHierophantReplace(minion, [targetRef, o]);
                    if (!check.failed) {
                        const ref = this.pieceRefStr(minion.x, minion.y, minion.index, minions);
                        return [ref, targetRef, o];
                    }
                }
            }
        }
        return undefined;
    }

    private buildRandomHermitTokens(minions: IMinionRef[]): string[] | undefined {
        const destinations = shuffle(this.emptyNonVoidCells()) as [number, number][];
        if (destinations.length === 0) {
            return undefined;
        }
        const pool = shuffle([...minions]) as IMinionRef[];
        for (const minion of pool) {
            for (const mode of shuffle(["piece", "tile"]) as string[]) {
                const targetToken = mode === "piece"
                    ? undefined // resolved per-candidate below (piece mode has several possible targets)
                    : GnosticaBoard.coords2algebraic(...this.minorTargetCell(minion));
                const pieceTargets = mode === "piece" ? shuffle(this.pieceTargetRefs(minion)) as string[] : [targetToken as string];
                for (const target of pieceTargets) {
                    for (const [dx, dy] of destinations) {
                        const destCell = GnosticaBoard.coords2algebraic(dx, dy);
                        const check = this.validateHermitStep(minion, [mode, target, destCell]);
                        if (!check.failed) {
                            const ref = this.pieceRefStr(minion.x, minion.y, minion.index, minions);
                            return [ref, mode, target, destCell];
                        }
                    }
                }
            }
        }
        return undefined;
    }

    private buildRandomJudgementDrawTokens(minions: IMinionRef[]): string[] | undefined {
        const pool = shuffle([...minions]) as IMinionRef[];
        const hand = this.hands[this.currplayer - 1];
        for (const minion of pool) {
            const piece = this.board.get(minion.x, minion.y)!.pieces[minion.index];
            const maxDraw = Math.min(piece.size, Math.max(0, 6 - hand.length));
            const count = Math.floor(Math.random() * (maxDraw + 1));
            const uids = (shuffle([...this.discardPile]) as string[]).slice(0, count);
            const failure = this.validateJudgementDraw(minion, uids);
            if (failure === undefined) {
                const ref = this.pieceRefStr(minion.x, minion.y, minion.index, minions);
                return [ref, ...uids];
            }
        }
        return undefined;
    }

    // No minion involved at all - pure hand/pile manipulation. Always
    // legal by construction (a random subset of the acting player's own
    // hand, each uid distinct since it's drawn from `hand` itself).
    private buildRandomHighPriestessTokens(): string[] {
        const hand = this.hands[this.currplayer - 1];
        const discards = hand.filter(() => Math.random() < 0.3);
        const failure = this.validateHighPriestess(discards);
        return failure === undefined ? discards : [];
    }

    // Once a suit is chosen, magicianChoice's own step IS an ordinary
    // suit-mode step (see buildSpecialPending's own redirect) - reuse
    // findRandomPrimitiveChoice directly rather than re-deriving mode/arg
    // legality, then verify the doubly-wrapped shape via
    // validateMagicianChoice as this step's own final check.
    private buildRandomMagicianChoiceTokens(minions: IMinionRef[]): string[] | undefined {
        for (const suit of shuffle([...ALL_SUITS]) as typeof ALL_SUITS) {
            const choice = this.findRandomPrimitiveChoice(suit.uid, minions, {});
            if (choice === undefined) {
                continue;
            }
            const check = this.validateMagicianChoice(choice.minion, [suit.uid, choice.mode, ...choice.args]);
            if (!check.failed) {
                const ref = this.pieceRefStr(choice.minion.x, choice.minion.y, choice.minion.index, minions);
                return [ref, suit.uid, choice.mode, ...choice.args];
            }
        }
        return undefined;
    }

    private buildRandomSpecialStepTokens(special: SpecialPower, minions: IMinionRef[]): string[] | undefined {
        switch (special) {
            case "orientMinion": return this.buildRandomOrientMinionTokens(minions);
            case "tradeHands": return this.buildRandomTradeHandsTokens(minions);
            case "orientAny": return this.buildRandomOrientAnyOrHierophantTokens(minions, "orientAny");
            case "hierophantReplace": return this.buildRandomOrientAnyOrHierophantTokens(minions, "hierophantReplace");
            case "hermitTeleport": return this.buildRandomHermitTokens(minions);
            case "judgementDraw": return this.buildRandomJudgementDrawTokens(minions);
            case "highPriestess": return this.buildRandomHighPriestessTokens();
            case "magicianChoice": return this.buildRandomMagicianChoiceTokens(minions);
            // fool/worldUseAny - never reached; buildRandomChain filters
            // Fool/World out by uid before any step is ever attempted.
            default: return undefined;
        }
    }

    private buildRandomStepForPowerStep(
        step: PowerStep, minions: IMinionRef[], def: MajorArcanaDef, stepIndex: number, totalSteps: number,
    ): string[] | undefined {
        if ("primitive" in step) {
            return this.buildRandomPrimitiveStepTokens(step.primitive, minions, def, step.opts, stepIndex, totalSteps);
        }
        return this.buildRandomSpecialStepTokens(step.special, minions);
    }

    // Builds a random (possibly empty) power-step chain for a "use"/"play"
    // target card. Minor arcana get at most their one single step;
    // major arcana chain through def.powers in order, threading each
    // step's outcome.newMinion into the next step's own minion pool
    // (the "become a minion" rule - see applyMajorPower's own docs, which
    // this mirrors exactly). The first step that can't be built stops
    // the chain there - no attempt to "skip" a declined step and resume
    // later, matching the common real-play pattern.
    //
    // Final correctness pass: truncates from the end while
    // validateMajorPower rejects the assembled chain, since
    // computeShortcutOpts's totalSteps-dependent relaxations (e.g.
    // Chariot's "every step except the last") can invalidate an earlier
    // step once the chain's ACTUAL final length is known, which can
    // differ from the length assumed while speculatively building it.
    // Always terminates - validateMajorPower(def, eligible, []) is
    // trivially legal (no steps to check).
    private buildRandomChain(card: MinorCard | MajorCard, eligible: IMinionRef[]): string[][] {
        if (!card.major) {
            if (eligible.length === 0 || Math.random() < 0.2) {
                return []; // decline outright - always legal
            }
            const suitUid = (card as MinorCard).suit.uid;
            const tokens = this.buildRandomStepTokens(suitUid, eligible, {});
            if (tokens === undefined) {
                return [];
            }
            return this.validateMinorPower(suitUid, eligible, [tokens]) === undefined ? [tokens] : [];
        }
        const def = getMajorArcanaDef(card as MajorCard);
        if (def.uid === "00" || def.uid === "21") {
            return []; // Fool/World - not yet engine-supported beyond declining
        }
        if (Math.random() < 0.15) {
            return []; // decline outright sometimes, same as minor arcana
        }
        const stepSegments: string[][] = [];
        let minions = [...eligible];
        for (let i = 0; i < def.powers.length; i++) {
            const step = def.powers[i];
            const tokens = this.buildRandomStepForPowerStep(step, minions, def, i, stepSegments.length + 1);
            if (tokens === undefined) {
                break;
            }
            stepSegments.push(tokens);
            const result = this.validatePowerStep(step, minions, tokens, def, i, stepSegments.length);
            if (result.failed) {
                stepSegments.pop();
                break;
            }
            if (result.outcome?.newMinion !== undefined) {
                minions = [...minions, result.outcome.newMinion];
            }
        }
        while (stepSegments.length > 0 && this.validateMajorPower(def, eligible, stepSegments) !== undefined) {
            stepSegments.pop();
        }
        return stepSegments;
    }

    // Standard grid renderer over a window recomputed every call (the
    // "Knight Line" pattern - see the plan: there's no fixed board size,
    // so the visible window has to track wherever territories currently
    // are). See renderWindow's own docs for exactly how the bounds are
    // derived - one ring beyond the territories themselves, which always
    // reaches every legally-occupied wasteland too without ever
    // overshooting into genuine void beyond one. Gnostica's algebraic
    // notation is already absolute (GnosticaBoard.coords2algebraic
    // doesn't shift as the board grows, unlike Knight Line's own
    // notation), so this only needs ONE extra coordinate layer
    // (window-relative row/col), not two.
    public render(opts?: IRenderOpts): APRenderRep {
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

        // Every void cell is the bare "-" the renderer leaves with no
        // legend entry (and no clickable region) at all - a wasteland
        // piece that needs to face into one gets a `buffer` area instead
        // (see cmdOrient's own docs on this.buffers), not a click target
        // baked into the grid itself.
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
                    legend[key] = this.buildCellGlyph(t, cls, largerCards);
                    const players = t?.card !== undefined ? t.playersPresent() : undefined;
                    if (players !== undefined && players.size === 1) {
                        const [owner] = players;
                        markers.push({
                            type: "outline",
                            colour: owner,
                            points: [{row: y - minY, col: x - minX}],
                        });
                    }
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

        // One area per player's hand, full-size (non-spaced) card faces.
        const areas: (AreaPieces | AreaButtonBar | AreaKey)[] = [];
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
                // A card just added to hand (see newHandCardUids's own
                // docs) gets its own tagged legend entry - same face,
                // just tinted so it's easy to spot regardless of where
                // rank-order sorting happened to place it.
                const isNew = newUids.has(uid);
                const key = isNew ? `hand_${uid}_new` : `hand_${uid}`;
                if (!(key in legend)) {
                    legend[key] = this.buildCardFace(card, false, isNew ? { background: "#ccc" } : {}) as [Glyph, ...Glyph[]];
                }
                handKeys.push(key);
            }
            areas.push({
                type: "pieces",
                pieces: handKeys as [string, ...string[]],
                label: i18next.t("apgames:validation.gnostica.LABEL_HAND", { playerNum: p, declared: this.lastTurnAnnouncedBy && this.lastTurnAnnouncedBy === p ? "(declarer)" : "" }),
                // Matches magnate.ts/emu.ts's own hand/deck sizing - tighter
                // than the default auto-wrap-at-board-width spacing, and a
                // fixed width (hands are always <=6 cards) rather than
                // letting row width drift with the board's own size.
                spacing: 0.25,
                width: 6,
                ownerMark: p,
            });
        }

        // The "bidding" variant's shared pool - every card revealed by the
        // opening bid procedure so far, available for anyone to redraw
        // from (see cmdRedraw's own docs). Fully public by the time it's
        // ever non-empty, unlike hands - no redaction/placeholder handling
        // needed at all.
        if (this.biddingPool.length > 0) {
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
        if (this.lastTurnAnnouncedBy !== undefined) {
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
            this.discardPile, "discard", legend, i18next.t("apgames:validation.gnostica.LABEL_DISCARDS"), this.newDiscardUids()
        );
        if (discardArea !== undefined) {
            areas.push(discardArea);
        }

        // Only the bidding variant can ever make turn order diverge from
        // plain player-number order (its own "winner goes first" rule -
        // see beginRedraw's own docs) - the default variant always
        // rotates 1,2,3,...,N, so a legend there would just be
        // redundant clutter restating the obvious. With only 2 players,
        // turn order is trivially "you, then them" either way - nothing
        // worth a legend for regardless of variant. Defaults to plain
        // ascending order (1..N) whenever bidWinner isn't set yet (still
        // mid-bid) - exactly the sequence nextPlayer()'s own +1 rotation
        // already produces in that case.
        if (this.numplayers >= 3 && this.variants.includes("bidding")) {
            const start = this.bidWinner ?? 1;
            const list: AreaKey["list"] = [];
            let p = start;
            for (let i = 0; i < this.numplayers; i++) {
                const key = `turnorder_p${p}`;
                if (!(key in legend)) {
                    legend[key] = { name: "pyramid-up-small", colour: p };
                }
                list.push({ piece: key, name: GnosticaGame.ordinal(i + 1) });
                p = (p % this.numplayers) + 1;
            }
            // "left", not "right" - the action button bar already owns
            // the right side (see actionButtons below), and the two
            // don't stack cleanly on the same side.
            areas.push({ type: "key", list, position: "left", height: 0.7, clickable: false });
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
        for (const uid of this.biddingPool) {
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
        uids: string[], keyPrefix: string, legend: { [k: string]: Glyph | [Glyph, ...Glyph[]] }, label: string,
        newUids: Set<string> = new Set(),
    ): AreaPieces | undefined {
        if (uids.length === 0) {
            return undefined;
        }
        // Split each minor bucket's own count into "new" (just discarded -
        // see newDiscardUids's own docs) and the rest, so only the actual
        // just-discarded cards get tinted rather than the whole bucket
        // (which, once a suit/category has been discarded from more than
        // once, would otherwise include plenty of much older cards too).
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
                const minor = card as MinorCard;
                const bucket = `${minor.suit.uid}_${minor.rank.court ? "royal" : "spot"}`;
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
                // A representative rank (any court rank for "royal", any
                // non-court rank for "spot") uses the usual card layout;
                // only the background (borderless, no card-square) and
                // the rank-corner text (a count, not a real rank) are
                // overridden.
                const representativeRank = ranks.find(r => r.court === (category === "royal"))!;
                const representative = new MinorCard({ rank: representativeRank, suit });
                const newCount = newCounts.get(bucket) ?? 0;
                const oldCount = count - newCount;
                if (oldCount > 0) {
                    const key = `${keyPrefix}_${bucket}`;
                    if (!(key in legend)) {
                        legend[key] = this.buildCardFace(representative, false, {
                            borderless: true,
                            rankText: `${oldCount}x`,
                        }) as [Glyph, ...Glyph[]];
                    }
                    pieces.push(key);
                }
                if (newCount > 0) {
                    const key = `${keyPrefix}_${bucket}_new`;
                    if (!(key in legend)) {
                        legend[key] = this.buildCardFace(representative, false, {
                            borderless: true,
                            rankText: `${newCount}x`,
                            background: "#ccc",
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
                legend[key] = this.buildCardFace(card, false, isNew ? { background: "#ccc" } : {}) as [Glyph, ...Glyph[]];
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
    private cellRenderKey(t: CellContents | undefined, cls: CellClass): string {
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
    // Every glyph EXCEPT the plain background square carries
    // `orientation: "vertical"` - correction for rotation.
    private buildCardFace(card: TarotCard, spaced: boolean, opts: { borderless?: boolean; rankText?: string; background?: string } = {}): Glyph[] {
        const backdrop: Glyph = { name: opts.borderless ? "piece-square-borderless" : "piece-square", scale: 1 };
        if (opts.background !== undefined) {
            backdrop.colour = opts.background;
        }
        const stack: Glyph[] = [backdrop];

        // `spaced` (board tiles, which also have to fit up to 3+ pieces in
        // the same small square) pushes the four corners further out and
        // shrinks everything in them, versus the normal card layout.
        let rankText = opts.rankText;
        if (rankText === undefined) {
            rankText = card.major ? (card as MajorCard).romanNumeral : (card as MinorCard).rank.uid;
            if (!card.major && (card as MinorCard).rank.uid !== "10") {
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
            ? getMajorArcanaIcons(card as MajorCard)
            : (card as MinorCard).suit.glyph !== undefined ? [(card as MinorCard).suit.glyph!] : [];
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
    // small square, so it uses the spaced card face (smaller rank/circle
    // sizing) rather than the roomier default meant for a card shown alone
    // (e.g. a hand, once that's rendered).
    private buildCellGlyph(t: CellContents | undefined, cls: CellClass, largerCards: boolean): Glyph | [Glyph, ...Glyph[]] {
        const stack: Glyph[] = [];
        if (t?.card !== undefined) {
            const dontSpace = largerCards && t.playersPresent().size === 0;
            stack.push(...this.buildCardFace(t.card, !dontSpace));
        } else if (cls === "wasteland") {
            stack.push({ name: "piece-square-dashed", scale: 1 });
        } else {
            // Void, in principle - the main render loop already short-
            // circuits every void cell to a bare "-" before this is ever
            // called, so this is just a defensive fallback, not a real
            // path.
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

    // Pieces are never allowed to visually stack/overlap, but a cell
    // can legitimately hold more than 3 (some major arcana powers bypass
    // CellContents' normal capacity check - see CellContents.canAdd()), so
    // this can't just be a fixed 3-slot table.
    //
    // Up to 5 pieces: each piece's own orientation names its preferred cell
    // in the tile's 3x3 grid (PIECE_GRID_SLOTS/PIECE_GRID_PREFERRED_INDEX) -
    // an N-facing piece wants the top-centre cell, "U" wants dead centre,
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
            if (orientation === "U") {
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

    // "U" pyramids stand upright, drawn once with no rotation; N/E/S/W
    // pyramids are the same "flat/pointing" glyph rotated to face that
    // direction - the exact pattern btt.ts uses for its own Icehouse pieces.
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

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "announce":
                node.push(i18next.t("apresults:ANNOUNCE.gnostica", { player, target: `Player ${r.payload[2]}` }));
                resolved = true;
                break;
            case "select":
                node.push(i18next.t("apresults:SELECT.gnostica", { player }));
                resolved = true;
                break;
            case "deckDraw":
                switch (r.from) {
                    case "pool":
                        node.push(i18next.t("apresults:DECKDRAW.gnostica_pool", { player, what: r.what }));
                        resolved = true;
                        break;
                    case "discard":
                        node.push(i18next.t("apresults:DECKDRAW.gnostica_discard", { player, count: r.count }));
                        resolved = true;
                        break;
                    case "deck":
                        node.push(i18next.t("apresults:DECKDRAW.gnostica_deck", { player, count: r.count }));
                        resolved = true;
                        break;
                    case "hand":
                        node.push(i18next.t("apresults:DECKDRAW.gnostica_hand", { player, what: r.what }));
                        resolved = true;
                        break;
                }
                break;
            case "declare":
                node.push(i18next.t("apresults:DECLARE.gnostica", { player }));
                resolved = true;
                break;
            case "orient":
                node.push(i18next.t("apresults:ORIENT.gnostica", { player, where: r.where, what: r.what, facing: r.facing }));
                resolved = true;
                break;
            case "use":
                node.push(i18next.t("apresults:USE.gnostica", { player, what: r.what }));
                resolved = true;
                break;
            case "pass":
                node.push(i18next.t("apresults:PASS.gnostica_bids", { player }));
                resolved = true;
                break;
            case "destroy":
                if (r.what !== undefined) {
                    node.push(i18next.t("apresults:DESTROY.gnostica_piece", { player, what: r.what }));
                } else {
                    node.push(i18next.t("apresults:DESTROY.gnostica_tile", { player, where: r.where }));
                }
                resolved = true;
                break;
            case "move":
                switch (r.how) {
                    case "rod-piece":
                        node.push(i18next.t("apresults:MOVE.gnostica_rod_piece", { player, what: r.what, from: r.from, to: r.to }));
                        resolved = true;
                        break;
                    case "rod-tile":
                        node.push(i18next.t("apresults:MOVE.gnostica_rod_tile", { player, from: r.from, to: r.to }));
                        resolved = true;
                        break;
                    case "hermit-piece":
                        node.push(i18next.t("apresults:MOVE.gnostica_hermit_piece", { player, from: r.from, to: r.to }));
                        resolved = true;
                        break;
                    case "hermit-tile":
                        node.push(i18next.t("apresults:MOVE.gnostica_hermit_tile", { player, from: r.from, to: r.to }));
                        resolved = true;
                        break;
                }
                break;
            case "place":
                switch (r.how) {
                    case "cups-own":
                        node.push(i18next.t("apresults:PLACE.gnostica_own", { player, where: r.where }));
                        resolved = true;
                        break;
                    case "cups-enemy":
                        node.push(i18next.t("apresults:PLACE.gnostica_enemy", { player, where: r.where }));
                        resolved = true;
                        break;
                    case "territory":
                        node.push(i18next.t("apresults:PLACE.gnostica_territory", { player, where: r.where }));
                        resolved = true;
                        break;
                    case "initial":
                        node.push(i18next.t("apresults:PLACE.gnostica_initial", { player, where: r.where }));
                        resolved = true;
                        break;
                }
                break;
            case "convert":
                if (r.into.startsWith("size-")) {
                    node.push(i18next.t("apresults:CONVERT.gnostica_piece", { player, what: r.what, into: r.into, where: r.where }));
                } else if (r.into.startsWith("owner-")) {
                    node.push(i18next.t("apresults:CONVERT.gnostica_hierophant", { player, where: r.where }));
                } else {
                    node.push(i18next.t("apresults:CONVERT.gnostica_tile", { player, what: r.what, into: r.into, where: r.where }));
                }
                resolved = true;
                break;
            case "eliminated":
                node.push(i18next.t("apresults:ELIMINATED", { player }));
                resolved = true;
                break;
        }
        return resolved;
    }
}
