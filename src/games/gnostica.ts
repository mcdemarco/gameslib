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
import { Piece, Orientation, allOrientations, cardinalOrientations } from "./gnostica/piece";
import {
    Stash, PowerContext, PowerFailure, takeFromStash, returnToStash,
    createOwn, createEnemy, createTerritory,
    movePiece, moveTerritory,
    growPiece, growTerritory,
    attackPiece, attackTerritory,
    orientMinion, orientAny, hierophantReplace,
    hermitMovePiece, hermitMoveTerritory, tradeHands,
    judgementDraw, highPriestess, fool, worldChoosePower,
    checkCreateOwn, checkCreateEnemy, checkCreateTerritory,
    checkMovePiece, checkMoveTerritory,
    checkGrowPiece, checkGrowTerritory,
    checkAttackPiece, checkAttackTerritory,
    checkOrientMinion, checkOrientAny, checkHierophantReplace,
    checkHermitMovePiece, checkHermitMoveTerritory, checkTradeHands,
    checkJudgementDraw, checkHighPriestess, checkFool, checkWorldChoosePower,
} from "./gnostica/powers";
import { MAJOR_ARCANA, MajorArcanaDef, PowerStep, SpecialPower, SuitPrimitive, getMajorArcanaDef, getMajorArcanaIcons } from "./gnostica/majorArcana";
import { generateRandomMove } from "./gnostica/randomMove";
import { ALL_SUITS, MINOR_MODES, HERMIT_MODES, primitiveStepShape, SPECIAL_STEP_SHAPES } from "./gnostica/stepShapes";
import i18next from "i18next";

export type playerid = 1|2|3|4|5|6;

// One button-bar choice, before its value gets a `<prefix>_` prepended -
// see buildChoiceButtons' own docs.
interface ChoiceOption {
    value: string;
    label: string;
    disabledReason?: { key: string; params?: Record<string, unknown> };
}

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
export interface IMinionRef {
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
//
// applyPowerStep's own return type is IStepOutcome | undefined, and
// `undefined` there means ONLY "this step's own token grammar isn't
// complete enough to act on yet" (per stepShapes.ts's own shape check,
// consulted before any apply* method below ever runs) - never "done,
// nothing to report." judgementDraw (the one step with genuinely nothing
// to chain) returns `{}` rather than `undefined` for exactly this reason,
// so walkFrameStack can tell the two apart with a plain `=== undefined`
// check on applyPowerStep's own return value, without needing to ask
// validatePowerStep anything.
export interface IStepOutcome {
    newMinion?: IMinionRef;
    // Which EXISTING entry (if any) in the frame's own `minions` pool
    // newMinion supersedes - matched by (x,y,index), not object identity,
    // since callers rebuild plain {x,y,index} refs rather than reusing
    // the original object. Set this to the piece's own PRE-mutation ref
    // whenever the step relocated it (Rods' own "piece" move, Hermit's
    // teleport) or mutated it in place in a way that changes its own
    // index (Discs' grow, Swords' shrink, Hierophant's replace - all
    // remove-then-re-add at the same cell) or reoriented it without
    // moving at all (orientMinion/orientAny - set it to newMinion itself,
    // a harmless no-op replace when that ref is already tracked). Left
    // unset only when nothing existing became invalid - Cups' own
    // "create" is the one case: the acting piece (and everything else
    // already tracked) is still exactly where it was, so the new piece
    // is purely additive. See chainMinion's own docs for why this
    // matters: without it, a relocated piece's PRE-move ref lingers in
    // `minions` forever, indistinguishable from a second, still-live
    // candidate, even though nothing is standing there anymore.
    replacesMinion?: IMinionRef;
    // Hand off to a DIFFERENT card's own power array - World's chosen
    // target, or Fool's just-flipped card. applyMajorPower's/
    // resumePendingPower's own loops turn this into a fresh IPowerFrame
    // pushed onto the resolution stack. `viaFool` records which of those
    // two this was - Fool's own reveal sets it true; World's own choice
    // never does - see IPowerFrame's own `viaFool` docs for why that
    // distinction has to survive onto the pushed frame itself.
    pushFrame?: { cardUid: string; minions: IMinionRef[]; viaFool?: boolean };
    // Must pause here regardless of how many further step segments the
    // caller already supplied this call - either because what comes next
    // is genuinely unknowable until this step's hidden outcome is seen
    // (Fool's flip, EVERY time - see IPendingMajorPower's own docs on why
    // this isn't the same case as High Priestess), or because a LATER
    // sibling step of the SAME card needs this step's own outcome to
    // inform it (High Priestess's first-of-two discard round). Never set
    // for World's own push - the board is public, so nothing about
    // choosing a target is hidden.
    forcePause?: boolean;
}

// The non-mutating validator's counterpart to IStepOutcome: either a
// failure (validation stops here - `result` is the final, i18n-wrapped
// answer) or a not-failed outcome, which itself splits into two cases a
// plain boolean can't otherwise tell apart: `complete` (default true,
// omitted at every genuine completion site) says the step was actually
// finished, carrying whatever chaining info IStepOutcome has; `complete:
// false` is set explicitly at the handful of "still building" precondition
// checks in validatePowerStep (mode not chosen yet, not enough args yet,
// etc. - the same tolerance applyPowerStep's own docs describe) so
// validateMajorPower's own loop can tell "this step is done" apart from
// "this step was merely never rejected outright" for its own tail
// (mirrors validateMinorPower's identical distinction, made the same way).
export type StepValidation =
    | { failed: true; result: IValidationResult }
    | { failed: false; complete?: boolean; outcome?: IStepOutcome };

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
    // The front tokens as typed - a fresh "use"/"play <uid>", the discard
    // uids for an ordinary discard, or (for a resume) the revealed card
    // being resolved. The "(via <uid>)" anchor is NOT here; it's `viaUid`.
    rest: string[];
    stepSegments: string[][];
    // The first step segment that fails isStepShapeValid, if any - see
    // its own docs on what "shape" means here and why it can't go any
    // deeper without already knowing which suit/power is involved.
    malformedStep: string[] | undefined;
    // The "(via <uid>)" anchor: the Fool (00) or High Priestess (02) whose
    // still-pending power a resumed step continues, demoted to a
    // parenthetical the same way announceLast demotes "(last)". Populated
    // by parseMove when the marker is present, consumed by pickleMove.
    viaUid?: string;
    // "as <uid>" in the head segment: the power a meta-card borrows - the
    // card The World uses ("play 21 as 09"), or the suit letter The
    // Magician runs ("play 01 as S"). Everything downstream of that choice
    // (minion pick, steps) is exactly as if that card/suit were used
    // directly.
    asUid?: string;
}

// A theme-relative "muted" tone, matching hand_UNKNOWN's own established
// placeholder colour below - used anywhere a hardcoded grey would
// otherwise go, e.g. a struck-through/disabled button fill or a "newly
// added" highlight backdrop. Blends toward _context_strokes specifically
// (not _context_fill) because that's the colour the rank/suit glyphs
// drawn ON TOP of this backdrop actually use - keeping the tint a
// consistent distance from the text sitting on it in both themes, rather
// than an unrelated fill colour that happens to land close to the real
// text colour once flattened (as _context_fill did in dark mode).
const MUTED_FILL: Colourfuncs = { func: "flatten", fg: "_context_strokes", bg: "_context_background", opacity: 0.3 };

// True iff `pile` (hand or discard-pile uids) holds a card worth exactly
// `value` points - lets minorModeAvailability tell apart a mode whose
// completion needs a same-valued card the player doesn't hold, instead of
// only discovering that once they reach the card-pick step.
function handHasCardOfValue(pile: string[], value: number): boolean {
    return pile.some(uid => {
        const c = allCards().find(cc => cc.uid === uid);
        return c !== undefined && cardPointValue(c) === value;
    });
}

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
// (minorModeAvailability, buildStepModeMove, handlePendingStepBoardClick,
// supplyStepCardUid) already assumes `suitUid` unconditionally, and a
// union would force touching all of them just to re-narrow. Kept as plain
// optional fields instead - each of those functions asserts `suitUid!`
// once at its own top, documented there, rather than scattering asserts.
interface IPendingStep {
    // The verb the front of the move string spells - "play" for a genuine
    // resume (describePendingMove swaps in "discard" for a High Priestess
    // step; "decline" is handled by its own path), else the literal typed
    // head for a fresh "use"/"play". describePendingMove/assembleStepMove use this
    // for the front of the move string.
    head: "use" | "play";
    // The ROOT card - the one originally used/played/resumed. NOT
    // necessarily the card whose own steps are currently being resolved -
    // see activeCardUid below.
    headArg: string;
    // The card whose own steps THIS pending step actually belongs to -
    // equal to headArg for an unpushed activation or a minor card;
    // differs once a push has happened (World's target chosen, Fool's
    // reveal) - the local walk below's own current top of stack. This is
    // the fact #67 (computeActionButtons' button label) needs.
    activeCardUid: string;
    // "as <x>" for a meta-card: the card The World borrows (uid) or the
    // suit The Magician runs (letter). describePendingMove echoes it back
    // into the head. Undefined for every ordinary card, and for a World/
    // Magician whose borrow hasn't been picked yet.
    asUid?: string;
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
    // minorModeAvailability's best-effort button pre-filter can account for a
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
// One snapshot of state per completed step of a 2+-step major-arcana
// chain (see applyMajorPower's own docs on when/how these get pushed) -
// only fields renderFrame() itself actually draws directly from, not a
// full state snapshot. `results` is NOT a field here - per-frame
// annotations are handled via `_group`-wrapping this.results itself (see
// applyMajorPower/render's own docs), not by duplicating results into
// each frame. `drawPile`/`stashes`/`hands` are excluded entirely -
// renderFrame() never builds a draw-pile, stash, or hand area at all for
// a historical frame (see its own docs), so there's nothing for those to
// feed. `discardSummary` is the one exception: the discard area IS shown
// per-frame (it's always public, unlike a hand), but only ever needs
// the abbreviated form buildAreaFromSummary() consumes - individual
// major uids plus per-(suit, spot/royal) minor counts, exactly what the
// area itself displays - not the raw uid list buildDeckSummaryArea()
// needs for the live view's own "just discarded" tinting, which a fixed
// historical snapshot has no equivalent concept for anyway.
export type FrameState = {
    board: UnboundedSquareBoard<CellContents>;
    discardSummary: DiscardSummary;
};

// The discard/draw-pile summary areas both ever show only two kinds of
// information - an individual major arcana card's own uid, or a per-suit,
// per-(spot|royal) minor arcana COUNT (see buildDeckSummaryArea's own
// docs on why minors are never shown individually) - so this is a
// lossless-for-display abbreviation of a raw uid list, small enough to
// store directly in a FrameState entry instead of the full list.
export interface DiscardSummary {
    majorUids: string[];
    counts: Map<string, number>;
}

// One card's own power-array progress, wherever it sits in the resolution
// stack. cardUid/nextStepIndex re-derive the actual step list via
// resolveFrameDef() - either a real MAJOR_ARCANA entry, or (for a minor
// card Fool flipped) a synthesized single-primitive-step stand-in. minions
// is this frame's OWN accreting pool, seeded at push time - never shared
// with a sibling frame.
interface IPowerFrame {
    cardUid: string;
    nextStepIndex: number;
    minions: IMinionRef[];
    // True only for a frame pushed by Fool's own reveal - never set for
    // the original root frame, and never set for a frame pushed by
    // World's own worldUseAny choice. This is what makes Decline
    // available at all: flipping is itself the real, committing action
    // (a card genuinely gets drawn), so whatever it reveals stays free to
    // walk away from. Naming a target via World has no effect of its own
    // - the player is committing to using THAT card's power, not merely
    // being shown it - so there's nothing to decline once it's chosen;
    // see getActionButtons'/computeActionButtons' own "declinable" checks
    // and validateFrameStack's own "nothing more given" docs for the
    // completeness half of this same distinction.
    viaFool?: boolean;
}

// A same-seat obligation left over from a High Priestess/Fool/World
// activation that paused mid-chain - see applyMajorPower's own docs on
// when this gets set. rootCardUid/source are fixed at the ORIGINAL use/
// play call and never change as frames get pushed - resumePendingPower's
// own mismatch check compares a resume submission's head-arg against
// rootCardUid, NOT against whatever frame is currently on top, since
// World can push a frame for a DIFFERENT card than the one the player
// actually typed (e.g. "use 21, ..." while the top frame is Fool's).
// stack[stack.length-1] is the innermost/current frame - the one an
// incoming resume submission's single step segment actually applies to.
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
    // Present only for a move that chained 2+ major-arcana steps - see
    // FrameState's own docs. Optional so stack entries predating this
    // feature still deserialize fine.
    frames?: FrameState[];
    // Which card(s) still owe a follow-up move() submission on the same
    // seat before the turn can advance (Fool's own two flips, High
    // Priestess's own second round) - see this.continued's own docs.
    // Optional so stack entries predating this feature still deserialize
    // fine.
    continued?: string[];
    // The "bidding" variant's opening procedure - see cmdBid's own docs.
    // Every other variant/game stays in "main" for its entire lifetime, so
    // none of the fields below are ever touched outside that variant.
    phase: "bidding" | "redraw" | "main";
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
    // submitted. The field itself is optional (undefined outside the
    // "bidding"/"redraw" phases) so a game that never uses the "bidding"
    // variant - or one that already finished it - doesn't carry a
    // meaningless all-null array in every stack entry.
    bidPositions?: (number | null)[];
    // Every card actually revealed by a bid, across every round played
    // (tied rounds and the final decisive one alike) - the shared pool
    // every player draws back up to 6 from during "redraw". bidRound
    // (how many tied rounds have happened so far, 0-indexed) and
    // bidWinner/redrawOrder are DERIVED from this plus phase and
    // turnOrder rather than separately stored - see their own getters.
    // Optional, same reasoning as bidPositions/turnOrder - undefined
    // outside the "bidding" variant, and cleared back to undefined once
    // redraw concludes (it's spent by then, same as bidPositions, not
    // permanently meaningful the way turnOrder is).
    biddingPool?: string[];
    // "Tournament rules": the order of play for the rest of the game is
    // exactly the rank order of the cards everyone bid (highest first;
    // majors always outrank minors) - see resolveBidRound's own docs.
    // Starts as plain ascending player order ([1,2,...,N]) so the
    // opening bidding round itself (before any rank is known) still
    // advances player-to-player the ordinary way via nextPlayer(). Only
    // ever set at all for the "bidding" variant - nextPlayer() falls back
    // to that same identity order itself when this is undefined, so a
    // non-bidding game never needs to carry a redundant [1,2,...,N] copy
    // in every stack entry. Once set, it stays set for the rest of that
    // game (unlike bidPositions) - it's the real, permanent play order,
    // not a transient bidding-only artifact.
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
    // Populated only for a move that chains 2+ major-arcana steps - see
    // FrameState's own docs. Left populated even after a partial() call
    // returns (see move()'s own docs) - that's what lets the acting
    // player page through their own in-progress chain mid-turn, not just
    // review a fully-committed one later.
    public frames: FrameState[] = [];
    // Which continuing card(s) still owe a follow-up move() submission on
    // the same seat before the turn can advance - Fool's own two flips
    // (see walkFrameStack's own docs: "every flip forces a pause,
    // regardless of whether Fool has another flip left") and High
    // Priestess's own second round are the only cards a genuine cross-
    // submission obligation is ever rooted on, or nested on top of another
    // one of the same kind (Fool can reveal a second Fool - see the
    // "Fool -> Fool" test). Everything else that gets pushed while
    // resolving a chain (an ordinary revealed minor/major, World's own
    // borrow) resolves within the move-string/click machinery of whichever
    // submission handles the entry below it; it never needs its own
    // persisted fact, since a resume submission already names what it's
    // continuing.
    //
    // Each entry is "<cardUid>.<step>", `step` being the same step index
    // MajorArcanaDef.powers is indexed by, and `cardUid` is ALWAYS "00" or
    // "02": "00.1" means Fool owes its second flip; "00.2" means Fool has
    // flipped twice and its last reveal still awaits a play/decline;
    // "02.1" means High Priestess owes round 2. Ordered outermost-first.
    // Only ever written on a real (non-partial) commit (see
    // persistContinued) - so unlike this.liveMove, reading this field
    // never needs a separate "is this actually genuine" check.
    // buildPendingFromContinued() turns it back into the throwaway frame
    // stack the resume machinery expects, re-deriving the pending revealed
    // card from the discard pile's top (minions recomputed fresh too -
    // see its own docs).
    public continued: string[] = [];
    // The "bidding" variant's own state - see IMoveState's own docs on
    // each field.
    public phase!: "bidding" | "redraw" | "main";
    public bidPositions: (number | null)[] | undefined;
    public biddingPool: string[] | undefined;
    public turnOrder: playerid[] | undefined;

    // How many tied rounds have happened so far (0-indexed) - biddingPool
    // grows by exactly `numplayers` cards every time a round resolves,
    // tied or not, so this is exact for as long as anyone's actually
    // looking at it (mid-"bidding"). It stops being meaningful the instant
    // a round resolves with a winner, but that's also exactly the instant
    // phase leaves "bidding" (and biddingPool goes back to undefined), so
    // nothing ever reads a stale value - 0 for a non-bidding game too.
    public get bidRound(): number {
        return Math.floor((this.biddingPool?.length ?? 0) / this.numplayers);
    }

    // turnOrder[0] is the bid winner by construction (see its own docs -
    // it's sorted by rank, and the winner has the highest rank). Only
    // meaningful once a bid has actually resolved (phase left "bidding")
    // - before that (or for a non-bidding game, where turnOrder is never
    // even set), there's no bid winner to report.
    public get bidWinner(): playerid | undefined {
        return this.phase === "bidding" ? undefined : this.turnOrder?.[0];
    }

    // Exact reverse of turnOrder (see its own docs) - worst bidder
    // redraws first, the winner last. Only ever read during "redraw", by
    // which point turnOrder is already finalized (guaranteed set - see
    // its own docs).
    public get redrawOrder(): playerid[] {
        return [...this.turnOrder!].reverse();
    }

    // How many players have already redrawn this round. Deliberately
    // reads the last REAL commit's hands (the top of this.stack), never
    // the LIVE this.hands - a partial (preview) redraw mutates this.hands
    // immediately (see cmdRedraw's own docs on why), but move() only ever
    // pushes onto this.stack for a REAL commit (see its own tail), so the
    // stack's top stays exactly what it was until the next one actually
    // happens - immune to any preview in between. Every hand sits at
    // exactly 5 cards (post-bid, pre-redraw) or exactly 6 (post-redraw)
    // during this phase - validateRedraw enforces drawing to EXACTLY 6,
    // never more or less - so counting full hands is exact.
    public get redrawPos(): number {
        return this.stack[this.stack.length - 1].hands.filter(h => h.length === 6).length;
    }

    // Transient click-UI hint, not part of persisted game state - see
    // move()'s own docs for exactly what this does and does not track.
    // Stores the ALREADY-PARSED move, not the raw string: every reader
    // but one (parsePendingStep, which is a general string-based utility
    // shared with handleClickCore's own many other ad-hoc move strings)
    // just wants specific fields off it, so parsing once here instead of
    // separately in each reader avoids re-parsing the same string up to
    // four times in a single render() pass. The one reader that needs a
    // string round-trips it back out via pickleMove() - parsePendingStep
    // re-parses it internally anyway, so nothing is lost either way.
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
            // Two-step rehydration (see GnosticaBoard.rehydrate's own docs):
            // JSON.parse+reviver only restores the outer UnboundedSquareBoard
            // wrapper; every stored CellContents still needs its own
            // deserialize() pass to become a real class instance again.
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
        // Wrap + deep-clone so mutating `this.board` during play never
        // touches the snapshot stored in the stack.
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

    // Unlike clone() (via serialize(), which reads only this.stack - the
    // last REAL commit), this reflects this.board/this.hands/etc. exactly
    // as they currently stand live - including a partial preview's own
    // in-progress board mutation, which never touches this.stack at all
    // (see move()'s own docs on why). validateMajorPower's own use of
    // this needs to see exactly what handleClick's live preview already
    // shows mid-chain, not just the last thing actually submitted - a
    // stale clone would silently "forget" an earlier step's own already-
    // rendered effect. A single-entry stack is enough (nothing here ever
    // reads history), and CellContents/Piece still round-trip correctly
    // through moveState()'s own real, deep-cloned board/hands.
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

        // Computed once, here, and reused below (the later head !== "place"
        // gate) rather than called twice - this player's own board presence
        // can't change between the two reads within a single validateMove
        // call.
        const hasPieces = this.hasPiecesOnBoard(this.currplayer);

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            // The real client calls validateMove("") right after every
            // real commit, purely to populate the status line for the
            // FRESH render that follows (see playground.js's own moveBtn
            // handler). Every state now has a real button to click - the
            // ordinary 6-button bar, or a resume's own Use/Decline pair
            // (getActionButtons) - so "click a button" fits; the one
            // exception is a player with no piece down yet, who must place.
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
        if (!parsed.headRecognized) {
            return this.invalid("apgames:validation._general.UNRECOGNIZED_MOVE", { move: m });
        }
        // A step segment whose token grammar is broken (see parseMove's own
        // docs on malformedStep) - rejected the moment it's known, ahead of
        // any head dispatch. The click UI never produces one; this is a
        // hand-edit or a broken client.
        if (parsed.malformedStep !== undefined) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP" });
        }

        const head = parsed.head;

        // A genuine cross-turn pause (Fool's second flip, a revealed/
        // targeted card's own subactions, High Priestess round 2) means
        // EVERY legal move right now has to be resuming it - so route on
        // that runtime fact directly, not on whatever verb the move
        // string happens to spell. this.continued always names a genuine
        // obligation (see its own docs). Short-circuits ahead of the other
        // gates below since they don't apply to a resume.
        if (this.continued.length > 0) {
            const activeUid = this.getContinuedUid();
            if (parsed.viaUid !== activeUid)
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "BAD_VIA_STRING"});
            const allowed = activeUid === "02" ? ["discard"] : ["decline", "play"];
            if (! allowed.includes(parsed.head!))
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "ACTION_NOT_ALLOWED"});
            return this.validateResumePendingPower(parsed);
        }
        
        // "decline" can only appear when continued is populated.
        if (head === "decline") {
            return this.invalid("apgames:validation.gnostica.NOTHING_TO_DECLINE");
        }

        // Mirrors move()'s own bid/redraw/pass/phase gates - see their docs.
        if (head === "bid" || head === "redraw" || head === "pass") {
            if (head === "bid" && this.phase !== "bidding") {
                return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: head });
            }
            // An eliminated player's own "pass" is already fully handled
            // above (isEliminated gate, before parseMove even runs), so
            // this.eliminated can't be true for currplayer here - no
            // exemption needed for either head.
            if ((head === "redraw" || head === "pass") && this.phase !== "redraw") {
                return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: head });
            }
            if (parsed.stepSegments.length > 0 || parsed.announceLast) {
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
        }

        if (this.phase !== "main") {
            return this.invalid("apgames:validation.gnostica.WRONG_PHASE", { move: head });
        }
        
        if (head !== "place" && !hasPieces) {
            //This does not yet cover the Fool suicide corner case.
            return this.invalid("apgames:validation.gnostica.MUST_PLACE_FIRST");
        }
        if (head === "place" && hasPieces) {
            return this.invalid("apgames:validation.gnostica.ALREADY_ON_BOARD");
        }
        if ((head === "place" || head === "orient" || head === "discard") && parsed.stepSegments.length > 0) {
            return this.invalid("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: head });
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
        // Unreachable: head was confirmed recognized above, and bid/redraw/
        // pass/resume are all handled before here.
        return this.invalid("apgames:validation._general.UNRECOGNIZED_MOVE", { move: m });
    }
    
    // ============================================================
    // Move parsing
    //
    // Grammar: a "/"-delimited list of segments - the first naming the
    // turn's action, and (for "use"/"play") 0+ further ones chaining
    // suit/major-arcana power steps. A trailing "(last)" suffix on the
    // WHOLE move string - not a segment of its own, always at the very
    // end - announces the player's final turn. It's deliberately a
    // distinct, unmistakable suffix rather than just another segment, so
    // it's one flag on parseMove's own result rather than something every
    // consumer has to notice and skip past on its own.
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
        this.frames = [];
        this.cardsDrawn[this.currplayer - 1] = 0;
        let head;
        let newLast = this.lastTurner;
        // The frame stack walkFrameStack hands back, serialized into
        // this.continued once past the partial boundary below.
        let residualFrames: IPowerFrame[] | undefined;

        if (m.toLowerCase() === "pass") {
            // validateMove() (above) is the actual gate on WHO may say
            // "pass" - eliminated or the 2-player bidding variant's own
            // bid winner sitting out the loser's first redraw (see
            // validatePass()'s own docs). `head` deliberately stays
            // undefined here - see the tail below's own docs on why that
            // matters for nextPlayer()/checkEOG().
            const why = this.eliminated.includes(this.currplayer) ? "eliminated" : "bidding";
            this.results = [{ type: "pass", who: this.currplayer, why }];
        } else {
            this.buffers = [];
            this.discarded = [];
            
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
            if (parsed.head === undefined || ! parsed.headRecognized ) {
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation._general.INVALID_MOVE", { move: m }));
            }

            head = parsed.head;

            // A genuine cross-turn pause means every legal move right now
            // has to be resuming it - mirrors validateMove's own,
            // identically-placed gate (see its docs on why this runs
            // ahead of bid/redraw/pass below - a resume was already
            // validated as legal regardless of what phase/placement state
            // would otherwise require). Legality of any kind - phase,
            // placement, step shapes, "no steps here" - is validateMove's
            // job alone now; a trusted caller passing garbage is a caller
            // bug, not something this dispatch re-checks.
            if (this.continued.length > 0) {
                residualFrames = this.resumePendingPower(this.resumeStepSegments(parsed), partial, parsed.asUid);
            } else if (head === "bid") {

            // The "bidding" variant's own opening procedure - see cmdBid's/
            // cmdRedraw's/cmdPass's own docs. Structurally unlike every other
            // head below: no power steps, no "(last)" announcement, and their
            // own bespoke currplayer advancement (next bidder/redrawer, a
            // phase transition, or a single nextPlayer() hop) instead of the
            // generic nextPlayer() call every other move falls through to -
            // so all three are handled entirely here rather than folded into
            // the switch below. "pass" only ever exists to let an eliminated
            // player sit out the rest of the game (see validatePass()'s own
            // docs) - the "autopass" flag means a real server auto-submits
            // it via moves() the instant it's the only legal option, so a
            // human player should never actually see or click a "pass"
            // prompt themselves.
                if (parsed.stepSegments.length > 0 || parsed.announceLast) {
                    throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: head }));
                }
                this.cmdBid(parsed.rest, partial);
                
            } else if (head === "redraw" || head === "pass") {
                if (parsed.stepSegments.length > 0 || parsed.announceLast) {
                    throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.NO_POWER_STEPS_HERE", { move: head }));
                }
                if (head === "redraw") {
                    this.cmdRedraw(parsed.rest, partial);
                } else {
                    this.cmdPass(partial);
                }
            } else {
                switch (head) {
                    case "place":
                        this.cmdPlace(parsed.rest);
                        break;
                    case "orient":
                        this.cmdOrient(parsed.rest);
                        break;
                    case "discard":
                        this.cmdDiscard(parsed.rest, partial);
                        break;
                    case "use":
                        residualFrames = this.cmdActivate(parsed.rest[0], parsed.stepSegments, partial, parsed.asUid);
                        break;
                    case "play":
                        residualFrames = this.cmdPlay(parsed.rest[0], parsed.stepSegments, partial, parsed.asUid);
                        break;
                    default:
                        // "decline" with nothing pending (the resume gate
                        // above didn't catch it), or any other recognized
                        // head that has no business here - a caller bug.
                        throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation._general.INVALID_MOVE", { move: m }));
                }

                if (parsed.announceLast) {
                    newLast = this.currplayer;
                    this.results.push({ type: "declare", count: this.getPlayerScore(this.currplayer) });
                }

            }
            // A transient, unpersisted UI hint - NOT the same thing as
            // this.lastmove
            // liveMove exists purely to answer "is there an in-progress
            // preview of the CURRENT player's own turn right now" for
            // getActionButtons()'s benefit: set to `parsed` (already
            // computed above - see liveMove's own docs on why it's stored
            // pre-parsed) for a partial preview call, explicitly cleared
            // back to undefined the moment a turn is actually committed -
            // so by the time render() next runs (for whoever's turn is
            // now current), there is nothing left over from the previous
            // player's finished action to misread, without needing to
            // compare against stack history at read time. Mirrors
            // Magnate's own this.highlights field in lifecycle only (reset/
            // populated fresh per move() call, never persisted) - not in
            // what it stores (see liveMove's own docs).
            this.liveMove = partial ? parsed : undefined;

        }
 
        if (partial || emulation) {
            return this;
        }

        // "?" marks a "place"-only click-preview facing as still merely
        // prepopulated, not yet a deliberate choice (see validatePlace's
        // own docs) - purely a UI/completeness signal, never part of the
        // real, persisted grammar, so it's dropped the instant a turn is
        // actually committed.
        this.lastmove = m.replace(/\?/g, "");
        // The walk this turn (if any) resolved some frames and left
        // others still owing - record that now, past the partial
        // boundary, so a preview never touches this.continued. undefined
        // means no walk ran, or it stopped on an incomplete step (see
        // walkFrameStack) - either way, leave the obligation as it was.
        if (residualFrames !== undefined) {
            this.persistContinued(residualFrames);
        }
        // `head` is only ever assigned inside the parsed-dispatch branch
        // above (never for the bare "pass" shortcut, which returns early
        // in its own branch and leaves `head` undefined) - so a literal
        // "pass" always falls into the `else` below and gets the same
        // unconditional nextPlayer()/checkEOG() every other real move
        // gets, despite matching none of these three string comparisons.
        // Fragile (see the shortcut's own docs), but currently correct:
        // "bid"/"redraw" genuinely need their own bespoke turn-advancement
        // (next bidder/redrawer, a phase transition) instead of this
        // generic one, and only they ever actually reach here with `head`
        // set to a matching string.
        if (head === "bid" || head === "redraw" || head === "pass") {
            //Need to rewrite these to remove this exception.
        } else if (this.continued.length > 0) {
            // Same seat still owes a follow-up submission (Fool's flip,
            // High Priestess round 2) - stay put. checkEOG() doesn't need
            // to run here either: it
            // reads only eliminated/gameover/winner, none of which this
            // step could have changed.
        } else {
            // Only on a real end-of-turn do we check the last turn announcement.
            if (this.lastTurner === this.currplayer) {
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
        // High Priestess with zero discards but an explicit draw count
        // ("draw <n>" as the WHOLE step) - "draw" is neither a piece ref
        // nor a card uid, so it needs the same allowance. A discard list
        // followed by "draw <n>" doesn't need this, since tokens[0] there
        // is a genuine card uid already.
        if (tokens[0]?.toLowerCase() === "draw") {
            return true;
        }
        if (!tokens.every(t => GnosticaGame.STEP_TOKEN_RE.test(t))) {
            return false;
        }
        return GnosticaGame.PIECE_REF_SHAPE_RE.test(tokens[0]) || GnosticaGame.CARD_UID_SHAPE_RE.test(tokens[0]);
    }

    private parseMove(m: string): IParsedMove {
        const RECOGNIZED_HEADS = ["place", "orient", "discard", "use", "play", "decline", "bid", "redraw", "pass"];
        const LAST_FLAG_RE = /\s*\(last\)\s*$/i;
        // "(via <uid>)" names the card whose power a resumed step was
        // reached through - stripped exactly like "(last)" and stashed in
        // `viaUid` alone (never in `rest`). Dispatch detects a resume from
        // this.continued's own state, never from the head - but
        // validateMove still requires the head to be the one that
        // fits the step ("decline"/"discard"/"play"). The uid can only
        // ever be one of the two cards whose power pauses across
        // submissions - the Fool (00) or the High Priestess (02) - so
        // anything else in the slot isn't a via marker. (The World never
        // pauses; it borrows a power inline via "as <uid>".)
        const VIA_FLAG_RE = /\s*\(via\s+(00|02)\)\s*$/i;

        const trimmed = m.trim();
        const announceLast = LAST_FLAG_RE.test(trimmed);
        let bare = trimmed.replace(LAST_FLAG_RE, "").trim();
        const viaMatch = bare.match(VIA_FLAG_RE);
        if (viaMatch) {
            bare = bare.slice(0, viaMatch.index).trim();
        }
        const viaUid = viaMatch ? viaMatch[1] : undefined;
        if (bare.length === 0) {
            return { announceLast, head: undefined, headRecognized: true, rest: [], stepSegments: [], malformedStep: undefined, viaUid };
        }
        // "/" (or a newline) separates every segment - the head from its
        // first power step, and steps from each other. NOT filtered: a
        // leading/trailing/doubled "/" leaves an empty segment that then
        // fails the head or step-shape check, rather than being silently
        // swallowed.
        const segments = bare.split(/\s*[\n/]\s*/);
        const [rawHead, ...headTokens] = segments[0].split(/\s+/);
        const head = rawHead.toLowerCase();
        // "as <x>" carves the borrowed power out of the head segment (see
        // the `asUid` field); the rest of the head stays in `rest` - just
        // the front tokens as typed. The "(via <uid>)" anchor is neither -
        // it lives in `viaUid` alone.
        const asIdx = headTokens.indexOf("as");
        const asUid = asIdx === -1 ? undefined : headTokens[asIdx + 1];
        const rest = asIdx === -1 ? headTokens : headTokens.slice(0, asIdx);
        const stepSegments = segments.slice(1).map(s => s.split(/\s+/));
        return {
            announceLast,
            head,
            headRecognized: RECOGNIZED_HEADS.includes(head),
            rest,
            stepSegments,
            malformedStep: stepSegments.find(tokens => !this.isStepShapeValid(tokens)),
            viaUid,
            asUid,
        };
    }

    // "/" separates every segment - the head/card-uid from its first
    // power step, and steps from each other (see parseMove). So a
    // single-step move is "use <uid>/<step>", a chain "use <uid>/<s1>/<s2>".
    public pickleMove(p: IParsedMove): string {
        if (p.head === undefined) {
            return p.announceLast ? "(last)" : "";
        }
        const headPart = [p.head, ...p.rest, ...(p.asUid !== undefined ? ["as", p.asUid] : [])].join(" ");
        const stepsPart = p.stepSegments.map(s => s.join(" ")).join("/");
        let base = stepsPart.length === 0 ? headPart : `${headPart}/${stepsPart}`;
        if (p.viaUid !== undefined) {
            base = `${base} (via ${p.viaUid})`;
        }
        return p.announceLast ? (base.length === 0 ? "(last)" : `${base} (last)`) : base;
    }

    // The innermost continued obligation's own uid ("00" or "02") - the
    // one a resume submission addresses and demotes into "(via <uid>)".
    private getContinuedUid(): string | undefined {
        return this.continued[this.continued.length - 1]?.split(".")[0];
    }

    // The ordinary card a Fool continuation is currently waiting on a
    // decision for: what the last flip revealed and left on top of the
    // discard pile (fool() puts it there), or - mid-preview - the card
    // the in-progress resume move string itself names. "02" for a High
    // Priestess resume (its own round IS the pending action, no revealed
    // card). undefined when nothing is pending.
    private activeCardUid(): string | undefined {
        const active = this.getContinuedUid();
        if (active !== "00") {
            return active;
        }
        if (this.liveMove?.viaUid === "00" && this.liveMove.rest[0] !== undefined) {
            return this.liveMove.rest[0];
        }
        return this.discardPile[this.discardPile.length - 1];
    }

    // The one place that assembles a resumed move's descriptive front -
    // every "resume seed" call site below shares this instead of hand-
    // rolling the verb/parenthetical itself. "decline" gives the active
    // obligation up; "discard" is a High Priestess round (its step IS a
    // discard/draw - see describePendingMove); "play <revealed card>" is a
    // Fool reveal - the revealed card named as the head arg, the Fool
    // itself demoted into "(via 00)".
    public buildViaMove(stepSegments: string[][], asUid?: string): IParsedMove {
        const activeUid = this.getContinuedUid()!;
        const declining = stepSegments.length === 1 && stepSegments[0].length === 1 && stepSegments[0][0].toLowerCase() === "decline";
        // "decline" is a bare head - it carries no step segments (unlike a
        // mid-chain "/decline", it IS the whole submission).
        const steps = declining ? [] : stepSegments;
        if (activeUid === "02") {
            return { announceLast: false, head: declining ? "decline" : "discard", headRecognized: true, rest: [], viaUid: "02", stepSegments: steps, malformedStep: undefined };
        }
        const revealed = this.activeCardUid();
        return {
            announceLast: false,
            head: declining ? "decline" : "play",
            headRecognized: true,
            rest: revealed !== undefined ? [revealed] : [],
            viaUid: "00",
            stepSegments: steps,
            malformedStep: undefined,
            // A revealed meta-card's borrow choice ("play 21 as 09 (via
            // 00)") carries in the head, not as a step segment - so the
            // seed rebuild has to be told it separately.
            asUid: declining ? undefined : asUid,
        };
    }

    // Builds the move string computeActionButtons()'s own pendingMinor
    // seeding replays: the bare resume seed plus whatever step segments
    // the current in-progress preview (this.liveMove) has typed against
    // this same obligation. No "already reflected" reconciliation needed -
    // the reconstruction always starts fresh from this.continued, so the
    // whole of liveMove's segments is unreflected by construction.
    private continuedSeedMoveString(): string {
        const forThisObligation = this.liveMove !== undefined && this.liveMove.viaUid === this.getContinuedUid();
        const segments = forThisObligation ? this.resumeStepSegments(this.liveMove!) : [];
        return this.pickleMove(this.buildViaMove(segments, forThisObligation ? this.liveMove!.asUid : undefined));
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
            case "malformed": return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_PIECE_REF" });
            // notFoundKey is sometimes overridden to a key with its own
            // real text (e.g. NOT_AN_ELIGIBLE_MINION) - only the shared
            // default collapses into INVALID_MOVE.
            case "not_found": return notFoundKey === "NO_SUCH_PIECE"
                ? this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_SUCH_PIECE" })
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
        if ( (allOrientations as string[]).includes(dir)) {
            return dir as Orientation;
        }
        return undefined;
    }

    // Parses `s` as an orientation or reports why not - the one place
    // BAD_ORIENTATION gets built, shared by every context in the file
    // that names a facing: place, orient, Cups "own", every trailing
    // post-action correction (Rods/Discs/Swords "piece"), and every
    // dedicated reorientation step (orientMinion/orientAny/
    // hierophantReplace).
    private parseOrientationOrFail(s: string | undefined): { orientation: Orientation } | { key: string; params?: Record<string, unknown> } {
        const orientation = this.tryParseOrientation(s);
        return orientation === undefined ? { key: "BAD_ORIENTATION", params: { orientation: s } } : { orientation };
    }

    // Hard-rejects (ORIENT_NO_OP) a `candidate` orientation that changes
    // nothing against `reference` (the piece's current facing, or - for a
    // piece that doesn't exist on the board yet, Cups "own"/place's own
    // new piece - the mandatory default it's about to get). The one place
    // that comparison gets made, shared by every context that hard-rejects
    // a no-op reorientation; the standalone "orient" command's own softer,
    // click-tolerant no-op leniency is deliberately NOT this - it checks
    // for a no-op itself, on its own terms, rather than calling this.
    private checkOrientationChanges(reference: Orientation, candidate: Orientation): { key: string } | undefined {
        return candidate === reference ? { key: "ORIENT_NO_OP" } : undefined;
    }

    // The "mandatory-or-defaulted facing, plus an optional trailing
    // correction" shape shared by every brand-new own piece: place's own
    // new piece and Cups "own"'s own new piece both reduce to exactly
    // this same question (the mandatory facing's own "missing" case is
    // resolved elsewhere by the caller, since that differs between a
    // top-level head and a shape-gated power step - this only ever runs
    // once `orientationStr` is confirmed present).
    private resolveTrailingOrientation(
        orientationStr: string, correctionStr: string | undefined,
    ): { orientation: Orientation } | { key: string; params?: Record<string, unknown> } {
        const parsed = this.parseOrientationOrFail(orientationStr);
        if ("key" in parsed || correctionStr === undefined) {
            return parsed;
        }
        const corrected = this.parseOrientationOrFail(correctionStr);
        if ("key" in corrected) {
            return corrected;
        }
        return this.checkOrientationChanges(parsed.orientation, corrected.orientation) ?? corrected;
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
            throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: result.kind === "malformed" ? "BAD_PIECE_REF" : "NO_SUCH_PIECE" }));
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
    // True when every candidate is a genuinely interchangeable minion: the
    // SAME cell (which territory gets acted on always matters, even for
    // two intrinsically-identical pieces on different cells) AND the same
    // owner/size/facing (Piece.id() - see its own docs on this being a
    // local, non-unique identity by design). Picking any one of them has
    // the exact same effect, so there's no real choice to offer - see
    // resolveStepMinion's own use of this.
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
                // A cell with 2+ eligible minions that all happen to be
                // identical isn't really ambiguous - no button bar needed,
                // just pick one at random (see allIndistinguishable's own
                // docs) exactly as if there'd only ever been one.
                if (this.allIndistinguishable(narrowed)) {
                    return { minion: narrowed[Math.floor(Math.random() * narrowed.length)], ambiguous: false, candidates: narrowed };
                }
                return { minion: narrowed[0], ambiguous: true, candidates: narrowed };
            }
        }
        // Same tolerance as the narrowed branch above, for a pool that's
        // already single-cell by construction (e.g. "use" - see this
        // method's own docs) without ever needing a narrowing click.
        if (this.allIndistinguishable(pool)) {
            return { minion: pool[Math.floor(Math.random() * pool.length)], ambiguous: false, candidates: pool };
        }
        return { minion: pool[0], ambiguous: true, candidates: pool };
    }

    // Builds a click result from a move string: runs it through
    // validateMove() and attaches it as .move, optionally overriding the
    // message with a friendlier click-time instruction. Every validate*
    // function in this file computes its own complete value directly and
    // correctly - "a turn is never complete while more refinement remains
    // genuinely possible, complete:0, whether clicked or hand-typed"
    // (matching Magnate's own identical rule) is handled by the validate
    // layer itself (see validateFrameStack's/validateOrient's own docs),
    // not guessed here after the fact - so there's nothing left for this
    // to second-guess.
    private provisionalResult(newmove: string, messageKey?: string, messageParams?: Record<string, unknown>): IClickResult {
        const result = this.validateMove(newmove) as IClickResult;
        result.move = newmove;
        if (messageKey !== undefined && result.valid) {
            result.message = i18next.t(messageKey, messageParams);
        }
        return result;
    }

    // #49/follow-up: which INSTRUCTIONAL message a click-driven use/play
    // preview should carry - this is UI guidance for a player still
    // actively navigating the button bar, not a validation complaint, so
    // it deliberately never uses POWER_STEP_REQUIRED (that's reserved for
    // validateMinorPower/validateMajorPower's own raw validation message,
    // surfaced only if a move is actually submitted - e.g. hand-typed -
    // while still incomplete; a real click-driven Submit is disabled in
    // this state client-side, so a player navigating by clicking never
    // reaches that message at all). Before any real step has been taken,
    // just point at the button bar (CHOOSE_STEP); once at least one step
    // is in, the move is already submittable and a further step is
    // genuinely optional (POWER_STILL_OPTIONAL).
    //
    // High Priestess is a special case - it isn't button-driven at all
    // (CHOOSE_STEP would be actively wrong, since there IS no button for
    // it), and it has its own real "how does this work" question the
    // ordinary discard/draw action doesn't (a SECOND round follows the
    // first) - so it gets the same wording as the ordinary discard action
    // itself, plus a clause about that.
    private powerStepMessageKey(headArg: string, priorStepsCount: number, minions: IMinionRef[]): { key: string; params?: Record<string, unknown> } {
        if (headArg === "02") {
            return { key: priorStepsCount > 0
                ? "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2"
                : "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1" };
        }
        // Fool: no button, no choice - engaging it at all (root, or as a
        // revealed/targeted card elsewhere) already produces a complete
        // move, since every flip fires automatically once started (see
        // walkFrameStack's own docs) - the message's whole job is telling
        // the player what Submit will do, regardless of which flip
        // (nextStepIndex) is actually about to fire - the wording itself
        // is deliberately flip-number-agnostic, since a LATER flip can be
        // reached this way too (a completed prior step cascading straight
        // into it - see forcePauseReadyMessage's own docs on the specific
        // gap this closes).
        if (headArg === "00") {
            return { key: "apgames:validation.gnostica.FOOL_FLIP_READY" };
        }
        // World: the same "click-driven, no button" gap as tradeHands/
        // orientAny/hierophantReplace/orientMinion/judgementDraw below
        // (see computeActionButtons' own docs), but those all target the
        // acting minion's own obvious self-or-facing cell - a player can
        // guess that with no hint. World's own target is unbounded ("any
        // major arcana territory currently on the board"), so naming the
        // card alone leaves no clue at all what to actually click.
        if (headArg === "21") {
            return { key: "apgames:validation.gnostica.WORLD_CHOOSE_TARGET" };
        }
        // Every other card: name it explicitly. A fresh top-level
        // activation is one the player just clicked themselves (so this
        // is a confirming reminder), but a card reached via a push
        // (Fool's reveal, World's target) was never clicked by the
        // player at all - naming it here is the ONLY way the status line
        // itself (as opposed to the chat log, which the player may not
        // be looking at) tells them which card's power they're now
        // choosing steps for.
        const cardName = this.cardNameOrUid(headArg);
        // CHOOSE_STEP's own "using the buttons" wording is only true for
        // a primitive step (a mode button), hermitTeleport/magicianChoice
        // (their own dedicated button sets), or a genuinely AMBIGUOUS
        // acting minion for any special (2+ eligible pieces sharing one
        // cell DO get a minion-picker button set - see computeActionButtons'
        // own docs). Once the acting minion is resolved (the overwhelmingly
        // common case: "use" is always single-cell by construction, and
        // "play"'s own cross-cell ambiguity is caught separately, before
        // this is ever reached - see its own "needsCellClick" docs),
        // orientMinion/orientAny/hierophantReplace/tradeHands/judgementDraw
        // have no button of their own at all for what comes next (see
        // computeActionButtons' own docs) - so a fresh first step of one
        // of those names the ACTUAL next click instead, split by rule
        // since they don't all share one: orientMinion is reoriented via
        // a click on or around its own cell (see handleOrientMinionClick's
        // own docs) - no separate target to pick, unlike orientAny/
        // tradeHands/hierophantReplace's shared self-or-facing-cell TARGET
        // rule (a different piece than the acting minion itself); judgementDraw
        // isn't a board click at all - it's driven by discard-pile clicks
        // (see computeActionButtons' own docs on AreaPieces clicks).
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

    // The "ready to submit" message for a step whose own outcome forces a
    // pause (Fool's own flip, High Priestess's own round - the only two
    // things that ever set forcePause, per applyPowerStep's own docs)
    // once it's ALREADY genuinely complete - distinct from
    // powerStepMessageKey's own job of saying what to type NEXT, which
    // would be actively wrong to show once there's nothing left to type
    // (High Priestess's own HIGH_PRIESTESS_ROUND1 text opens with "Click
    // hand cards to discard" - correct advice before typing that round's
    // own args, nonsensical once they're already typed and validated).
    // cardUid/nextStepIndex describe the step that JUST completed
    // (pre-increment, matching powerStepMessageKey's own second param and
    // the hpdraw_ button click handler's identical derivation) - this is
    // what closes the gap where validateFrameStack's own forcePause exit
    // used to return a bare `undefined`, falling all the way through to
    // the generic VALID_MOVE fallback with no hint that submitting will
    // ALSO immediately trigger this step's own hidden continuation.
    private forcePauseReadyMessage(cardUid: string, nextStepIndex: number): { key: string; params?: Record<string, unknown> } {
        if (cardUid === "02") {
            return { key: nextStepIndex > 0
                ? "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2_READY"
                : "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1_READY" };
        }
        if (cardUid === "00") {
            return { key: "apgames:validation.gnostica.FOOL_FLIP_READY" };
        }
        // Defensive only - no other card currently sets forcePause at
        // all, so this should never actually fire; falls back to the
        // ordinary VALID_MOVE wording rather than silently mislabeling
        // some future third case with either of the above.
        return { key: "apgames:validation._general.VALID_MOVE" };
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
        // validateMove unconditionally rejects "place" once the acting
        // player already has ANY board presence (ALREADY_ON_BOARD)
        // - so a live "place" preview can only ever be that player's
        // first piece ever, with no other case to distinguish. Reading
        // this off this.liveMove directly (same approach as the
        // midPowerStep check just above) avoids depending on
        // this.results' own shape: results exist to describe game events
        // for chat/history, not to signal UI state, so a chat-only change
        // there (e.g. tagging place's own result with `how: "initial"`)
        // has no business breaking this check.
        return this.liveMove.head?.toLowerCase() === "place";
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
        if (this.liveMove.announceLast) {
            found.add("declare");
        }
        const head = this.liveMove.head;
        if (head === "discard" && this.isPassEquivalent(this.liveMove.rest)) {
            // "discard draw 0" is Pass's own bare seed (see the Pass
            // button's own click handler) - bold Pass instead of
            // Discard/Draw, regardless of whether the player got there by
            // clicking Pass or by hand-building an equivalent Discard/Draw
            // move (0 discards, explicit draw 0).
            found.add("pass");
        } else if (this.continued.length > 0) {
            // The top-level button matching how the active card resumes -
            // "Discard/Draw" for the High Priestess, "Play Card" otherwise.
            found.add(this.continued[this.continued.length - 1].split(".")[0] === "02" ? "discard" : "play");
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

    // Wraps computeActionButtons() (the real logic - see its own docs)
    // to unconditionally fold a persisting "Decline X" into whatever bar
    // it produces, whenever a genuine pendingPower obligation exists.
    // Every such obligation's own card can always be declined outright,
    // at ANY point while still building how to use it - not just via a
    // one-time "Use Card X" screen before anything else is offered. This
    // matters concretely: a player who commits to using a revealed
    // card's power and then finds every one of its own buttons a dead
    // end (e.g. Rods' own mode buttons, all struck through because
    // every minion is upright) would otherwise have no way out at all.
    private getActionButtons(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        const bar = this.computeActionButtons();
        if (bar === undefined || this.continued.length === 0) {
            return bar;
        }
        // this.continued always names a genuine obligation (see its own
        // docs), so there's nothing further to distinguish here.
        if (bar.some(b => b.value === "decline_power")) {
            // Fool's own step has nothing else to offer, so
            // computeActionButtons() already returns its own explicit
            // Use/Decline pair directly for it - nothing to add here.
            return bar;
        }
        // The state as ADVANCED by whatever's been clicked so far this
        // render (this.liveMove) - parsePendingStep replays those segments
        // against the reconstructed stack, so `.special === "fool"` here
        // means the player's clicks have already run a revealed card's own
        // steps to completion and exposed Fool's mandatory next flip
        // underneath.
        const advanced = this.parsePendingStep(this.continuedSeedMoveString());
        const justDeclined = this.liveMove?.head === "decline";
        if (advanced?.special === "fool" && !justDeclined) {
            // Fool's own flip is never optional (see walkFrameStack's own
            // docs) - there's nothing to decline once a revealed card's
            // own steps have simply run their course. An explicit decline
            // the player just typed is different (justDeclined, below).
            return bar;
        }
        const activeTop = { cardUid: advanced?.activeCardUid ?? this.activeCardUid() };
        // Fool's own remaining flip auto-continues past ANY decline that
        // exposes it (see walkFrameStack's own docs) rather than sitting
        // as its own separate choice - so if a decline just happened and
        // Fool's own frame is what's active now, what still needs
        // naming here is whatever was ACTUALLY just declined, not Fool
        // itself. Fool always sends what it flips straight to the
        // discard pile and nothing else touches it in between, so the
        // pile's own last entry names it reliably.
        const declinedUid = (justDeclined && activeTop.cardUid === "00")
            ? (this.discardPile[this.discardPile.length - 1] ?? activeTop.cardUid)
            : activeTop.cardUid;
        const declineBtn: ButtonBarButton = { label: `Decline ${declinedUid}`, value: "decline_power" };
        if (justDeclined) {
            // Bold marks a button matching what this.liveMove ALREADY
            // says (see highlightedButtonValues' own docs) - once the
            // player has actually clicked this, it stays confirmed
            // rather than reverting to an open choice.
            declineBtn.attributes = [{ name: "font-weight", value: "bold" }];
        }
        return [...bar, declineBtn] as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // The recurring shape behind most of computeActionButtons' own button
    // sets: pick one value from a small labeled set. `disabledReason`
    // (when set) is the SAME reason object minorModeAvailability and
    // similar checks already produce - reused here for the strikethrough,
    // and by the matching _btn_ dispatch for the actual rejection
    // message, so the two can't drift apart the way separately-computed
    // copies used to.
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

    // Shared by the minion-ambiguity button set and its own "minion_"
    // click dispatch - a Rod can never act while upright, so an upright
    // candidate is always a doomed choice (see checkCanUseRod, powers.ts).
    private rodNeedsFacingReason(suitUid: string | undefined, piece: Piece): { key: string } | undefined {
        return suitUid === "R" && piece.orientation === "U" ? { key: "ROD_NEEDS_FACING" } : undefined;
    }

    // The self-contained Use/Decline pair offered whenever a paused power
    // has no button set of its own to show for what comes next - Fool's
    // own step (nothing to configure at all) and every other click-driven
    // special (orientAny, World's target, etc., once genuinely paused
    // rather than mid-fresh-activation). Reads the active card straight
    // off the resume stack's own top frame - the same uid both call sites
    // used to independently re-derive.
    private pausedPowerButtons(): [ButtonBarButton, ButtonBarButton] {
        const resumeStack = this.resumeStack()!;
        const activeUid = resumeStack[resumeStack.length - 1].cardUid;
        return [
            { label: `Use Card ${activeUid}`, value: "resume_power" },
            { label: `Decline ${activeUid}`, value: "decline_power" },
        ];
    }

    // Shared by the ordinary end-of-turn discard/draw count-picker and
    // High Priestess's own identical-shaped one.
    private drawCountOptions(maxDraw: number): ChoiceOption[] {
        const options: ChoiceOption[] = [];
        for (let n = maxDraw; n >= 0; n--) {
            options.push({ value: String(n), label: `Draw ${n}` });
        }
        return options;
    }

    // #87/#88: each state below is its own named primitive - gameover/
    // setup, the top-level bar, discard's count-picker, orient's minion-
    // picker, pendingMinor's own several states (fool, minion ambiguity,
    // High Priestess count, click-driven-no-buttons, suit/hermit/magician
    // mode buttons) - tried in this fixed order because two of them are
    // genuinely order-dependent (minion disambiguation must precede
    // dispatch by special kind; hermitTeleport/magicianChoice must escape
    // the "no button set" special branch to reach their own further down)
    // - see #87's own investigation. `undefined` from a primitive always
    // means "doesn't apply here, keep going" - never "empty bar".
    private computeActionButtons(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
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
        if (this.isPlaceOnlyState()) {
            // Only one action is legal here regardless of which case this
            // is - place is a full turn on its own with zero real board
            // presence, so nothing else should be offered mid-placement
            // either. A single bold button rather than nothing at all,
            // mirroring Magnate's own single-button "Choose" state for an
            // analogous "only one thing possible right now" situation.
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

        // Once a power step's own modes are on offer, there isn't room to
        // also keep the full top-level set around - only the one choice
        // that got us here (Use Territory/Use Hand Card) stays, followed
        // by a non-interactive spacer button (the schema has no dedicated
        // divider type) and this step's own mode buttons. Declare stays
        // available throughout (it's an orthogonal end-of-turn flourish,
        // not a step in this particular choice), tacked on at the end
        // rather than lost.
        const selected = topLevel.find(b => b.value === pendingMinor.head);
        // #67: name the active card's uid once one's actually known -
        // Use Territory (21), say - reusing the exact same activeCardUid
        // #74's own move-string annotation is built from.
        if (selected !== undefined) {
            selected.label = `${selected.label} (${pendingMinor.activeCardUid})`;
        }
        const declareBtn = topLevel.find(b => b.value === "declare");

        // Fool's own step has nothing to configure at all - no target,
        // no mode - so there's nothing for a real button bar to offer
        // for it. Before anything's been clicked this turn, that means
        // the ORIGINAL explicit Use/Decline pair (mirroring
        // FOOL_FLIP_READY's own "just submit" messaging) is the only
        // sensible thing to show. Once something HAS been clicked
        // (liveMove set) and Fool's own step is STILL what's active,
        // that can only mean an earlier click declined whatever a flip
        // revealed and Fool auto-continued past it (see walkFrameStack's
        // own docs) - nothing more to show beyond the plain top-level
        // context; getActionButtons()'s own persisting-Decline wrapper
        // is what actually keeps a real choice visible there.
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

        const hpCount = this.highPriestessCountBar(pendingMinor);
        if (hpCount !== undefined) {
            return hpCount;
        }
        // orientMinion/tradeHands/orientAny/hierophantReplace/
        // judgementDraw/worldUseAny are pure click-driven (board or
        // AreaPieces clicks, no mode to pick via button). hermitTeleport
        // (mode not chosen yet) and magicianChoice (suit not chosen yet)
        // are the two special powers that DO need their own button set,
        // handled below instead of falling into the suit-mode loop. Once
        // magicianChoice's suit IS chosen, buildSpecialPending has already
        // redirected `pendingMinor` into an ordinary suit-shaped pending
        // (special undefined, suitUid set), so it falls straight through
        // to that same existing loop unmodified.
        if (pendingMinor.special !== undefined && pendingMinor.special !== "hermitTeleport" && pendingMinor.special !== "magicianChoice") {
            // While still building a FRESH root activation (this.continued
            // always names a genuine obligation - see its own docs - so
            // empty here means exactly that), the ordinary top-level bar
            // is still the right thing to show (matches every other "still
            // typing" preview, and #49 may still reject this activation
            // outright anyway).
            if (this.continued.length === 0) {
                return topLevel as [ButtonBarButton, ...ButtonBarButton[]];
            }
            // Once genuinely paused, though, NONE of the ordinary 6
            // buttons are legal - every one would be rejected outright by
            // validateMove's own resume gate while this obligation is
            // open. A click-driven special (orientAny,
            // World's target, etc.) also has no button of its own for
            // what comes NEXT. So offer the same self-contained Use/
            // Decline pair the Fool-special branch above does: clicking
            // "Use Card X" seeds "play X (via ..)" (resume_power), which
            // then produces that step's own real click-target message -
            // so the empty-move status line here needs no special-casing.
            return this.pausedPowerButtons();
        }

        return this.stepModeBar(pendingMinor, selected, declareBtn);
    }

    // A live preview of "use"/"play" - or a genuine pendingPower
    // obligation, which always implies the acting player already had
    // board presence when the obligation was created - can never
    // legitimately collapse down to "Place" mid-preview. Without this,
    // hasPiecesOnBoard() below could misread a transient zero-piece
    // moment (e.g. a Sword attack that ends up destroying the acting
    // player's own last minion) as a sign a fresh placement turn is
    // needed, even though the in-progress move (or pending obligation) is
    // still perfectly valid and submittable.
    private isPlaceOnlyState(): boolean {
        const midPowerStep = this.liveMove?.head === "use" || this.liveMove?.head === "play" || this.continued.length > 0;
        return (!midPowerStep && !this.hasPiecesOnBoard(this.currplayer)) || this.isPendingFirstPlacement();
    }

    // The ordinary 6-button top-level choice (use/play/orient/discard/
    // pass, plus declare once eligible), bolded per highlightedButtonValues'
    // own suggestion - the fallback bar for every "nothing more specific
    // applies right now" state below, and the seed every pendingMinor
    // state further trims/labels rather than rebuilding from scratch.
    private buildTopLevelBar(): ButtonBarButton[] {
        const topLevel: ButtonBarButton[] = [
            { label: "Use Territory", value: "use" },
            { label: "Play Card", value: "play" },
            { label: "Orient", value: "orient" },
            { label: "Discard/Draw", value: "discard" },
            { label: "Pass", value: "pass" },
        ];
        if (this.lastTurner === undefined || this.lastTurner === this.currplayer) {
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

    // Discard's own count is optional (an omitted "draw <n>" defaults to
    // the max at commit time - see cmdDiscard's docs), but the bar still
    // actively solicits it: as soon as "discard" is the live head and no
    // count has been chosen yet, offer every legal count from 0 up to the
    // room left in a 6-card hand as its own button, fully replacing the
    // top-level bar (same shape as hermitTeleport/magicianChoice's own
    // button sets further down). this.hands already reflects the live
    // move's own discard uids by the time this runs - move(..., {partial:
    // true}) already ran cmdDiscard's own discard loop to get here (see
    // its docs), it only stopped short of the redraw - so the room left is
    // just 6 minus the CURRENT hand length, no separate subtraction of the
    // discard list needed.
    private discardCountBar(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (this.liveMove === undefined || this.liveMove.head?.toLowerCase() !== "discard" || this.liveMove.rest.includes("draw")) {
            return undefined;
        }
        const hand = this.hands[this.currplayer - 1] ?? [];
        const maxDraw = Math.max(0, 6 - hand.length);
        return this.buildChoiceButtons("drawcount", this.drawCountOptions(maxDraw), undefined) as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // Orient: a bare cell (not yet a full piece ref - see handleClickCore's
    // own "orient" docs) means 2+ of the player's own distinguishable
    // pieces share it and none has been picked yet - same minion-picker
    // shape "use"/"play" already get once THEIR own pool narrows to one
    // ambiguous cell (see minionPickerBar's own docs), just reached via
    // orient's own (non-IPendingStep) pool/dispatch since orient has no
    // card/suit-mode machinery to piggyback on.
    private orientAmbiguityBar(): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (this.liveMove === undefined || this.liveMove.head?.toLowerCase() !== "orient"
            || this.liveMove.rest.length !== 1 || this.liveMove.rest[0].includes(".")) {
            return undefined;
        }
        const coords = this.tryAlgebraic2coords(this.liveMove.rest[0]);
        if (coords === undefined) {
            return undefined;
        }
        const { ambiguous, candidates } = this.resolveStepMinion(undefined, this.eligibleMinionsForOrient(coords[0], coords[1]));
        if (!ambiguous) {
            return undefined;
        }
        const seenRefs = new Set<string>();
        const options: ChoiceOption[] = [];
        for (const m of candidates) {
            const ref = this.pieceRefStr(m.x, m.y, m.index, candidates);
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

    // For a genuine resume, continuedSeedMoveString() rebuilds a move
    // string from this.continued's own root anchor plus whatever segments
    // this render's own in-progress preview (this.liveMove) has typed
    // against it; parsePendingStep replays those against the reconstructed
    // stack (buildPendingFromContinued) from scratch. No "already
    // reflected" bookkeeping is needed - the reconstruction always starts
    // fresh from this.continued, so the whole of liveMove's segments is
    // unreflected by construction. Seeded this way REGARDLESS of whether
    // anything's been clicked yet this turn (liveMove may still be
    // undefined) - so a revealed/targeted card's own real buttons (mode
    // buttons, High Priestess's own count picker, etc.) can be offered
    // immediately, without a separate "Use Card X" click first (see
    // getActionButtons()'s own docs on how a persisting Decline button
    // composes with whatever this produces).
    private computePendingMinor(): IPendingStep | undefined {
        return this.continued.length > 0
            ? this.parsePendingStep(this.continuedSeedMoveString())
            : this.liveMove === undefined
                ? undefined
                : this.parsePendingStep(this.pickleMove(this.liveMove));
    }

    // Every remaining candidate minion for THIS step already sits on the
    // same cell - either "use"'s own pool, always single-cell by
    // construction, or "play"'s board-wide pool once a board click has
    // narrowed it down to one cell (see resolveStepMinion's and
    // handleClickCore's own docs) - AND there's more than one of them, so
    // a real choice is still needed. Offer one button per candidate,
    // pre-empting every other branch below (mode buttons, hermitTeleport/
    // magicianChoice's own sets, or the uncollapsed bar a pure click-driven
    // special power would otherwise fall through to). Clicking one types
    // just that minion's ref as this step's own leading token (see
    // handleClickCore's "minion_" dispatch) - nothing else about the step
    // is decided yet, so the very next getActionButtons() call picks up
    // exactly where the single-minion case always has, now with `minion`
    // no longer just a placeholder. Returns undefined (not this step's
    // state) when there's no ambiguity, or the ambiguous pool still spans
    // more than one cell (computeActionButtons' own caller falls back to
    // the uncollapsed top-level bar for that second case).
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
            const piece = this.board.get(m.x, m.y)!.pieces[m.index];
            options.push({ value: ref, label: this.textFormat(piece), disabledReason: this.rodNeedsFacingReason(pendingMinor.suitUid, piece) });
        }
        buttons.push(...this.buildChoiceButtons("minion", options, undefined));
        if (declareBtn !== undefined) {
            buttons.push(declareBtn);
        }
        return buttons as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // High Priestess: the discard list itself is still built via hand-card
    // clicks (handled by handleClickCore directly), but the actual draw
    // count is the player's own choice, exactly like the ordinary
    // end-of-turn discard/draw action's own count-picker (see
    // discardCountBar's own docs) - same shape, offered the same way, as
    // soon as this step is live and no count has been chosen for THIS
    // round yet. pendingMinor.rest already reflects every discard named so
    // far (see buildSpecialPending's own highPriestess handling), so the
    // room left is 6 minus the CURRENT (already-discarded) hand length,
    // identical to the ordinary action's own calculation.
    private highPriestessCountBar(pendingMinor: IPendingStep): [ButtonBarButton, ...ButtonBarButton[]] | undefined {
        if (pendingMinor.special !== "highPriestess" || pendingMinor.rest.includes("draw")) {
            return undefined;
        }
        const hand = this.hands[this.currplayer - 1] ?? [];
        const maxDraw = Math.max(0, 6 - hand.length);
        return this.buildChoiceButtons("hpdraw", this.drawCountOptions(maxDraw), undefined) as [ButtonBarButton, ...ButtonBarButton[]];
    }

    // The final fallback once every click-only/no-button state above has
    // been ruled out: a primitive suit-power step (mode buttons, "piece"'s
    // own self/facing target, Swords' own pips), or hermitTeleport/
    // magicianChoice's own dedicated button sets (suit not chosen yet for
    // the latter - buildSpecialPending redirects `pendingMinor` into an
    // ordinary suit-shaped one the instant it is, so this same "else"
    // branch handles that stage too, unmodified).
    private stepModeBar(
        pendingMinor: IPendingStep, selected: ButtonBarButton | undefined, declareBtn: ButtonBarButton | undefined,
    ): [ButtonBarButton, ...ButtonBarButton[]] {
        const buttons: ButtonBarButton[] = selected !== undefined ? [selected] : [];

        const spacerLabel = pendingMinor.suitUid ? ALL_SUITS.filter(obj => obj.uid === pendingMinor.suitUid)[0].label : "Special Power";
        buttons.push({ label: spacerLabel, value: "_spacer",  attributes: [{ name: "font-style", value: "italic" }] });

        if (pendingMinor.special === "hermitTeleport") {
            const options = Object.entries(HERMIT_MODES).map(([mode, config]) => ({ value: mode, label: config.label }));
            buttons.push(...this.buildChoiceButtons("hermit", options, pendingMinor.rest[0]));
        } else if (pendingMinor.special === "magicianChoice") {
            const options = ALL_SUITS.map(suit => ({ value: suit.uid, label: suit.label }));
            buttons.push(...this.buildChoiceButtons("magician", options, undefined));
        } else {
            const suitUid = pendingMinor.suitUid!;
            const availability = this.minorModeAvailability(pendingMinor);
            const options = Object.keys(MINOR_MODES[suitUid]).map(mode => ({
                value: `${suitUid}_${mode}`,
                label: MINOR_MODES[suitUid][mode].label,
                disabledReason: availability.get(mode),
            }));
            const currentMode = pendingMinor.mode !== undefined ? `${suitUid}_${pendingMinor.mode}` : undefined;
            buttons.push(...this.buildChoiceButtons("mode", options, currentMode));
            // "new" mode's own required card arg is otherwise only ever
            // suppliable by clicking a hand card (see supplyStepCardUid's
            // own docs) - Wheel of Fortune's own step (the only card with
            // allowRandomDraw set, already reflected in pendingMinor.opts
            // by computeShortcutOpts - see parsePendingStep's own docs)
            // has no hand card to click for that, so it gets a dedicated
            // button instead, exactly parallel to a hand-card click.
            if (suitUid === "C" && pendingMinor.mode === "new" && pendingMinor.opts.allowRandomDraw === true) {
                buttons.push({ label: "Random Card", value: "random" });
            }
            // Every "piece" mode's target is either self or whatever's at
            // the facing cell - buildStepModeMove leaves it unset (rather
            // than picking one) exactly when both genuinely exist, so a
            // button set is the ONLY way to choose between them (never a
            // board click - see handlePendingStepBoardClick's own docs on
            // why overloading self/face clicks with a second meaning
            // there is confusing).
            if ((suitUid === "R" || suitUid === "D" || suitUid === "S") && pendingMinor.mode === "piece" && pendingMinor.rest.length === 0) {
                const [tx, ty] = this.minorTargetCell(pendingMinor.minion);
                const verb = MINOR_MODES[suitUid].piece.label.replace(" Piece", "");
                const selfRef = this.pieceRefStr(pendingMinor.minion.x, pendingMinor.minion.y, pendingMinor.minion.index);
                const targetOptions: ChoiceOption[] = [{ value: selfRef, label: `${verb} self` }];
                const facingCell = this.board.get(tx, ty);
                if ((tx !== pendingMinor.minion.x || ty !== pendingMinor.minion.y) && (facingCell?.pieces.length ?? 0) > 0) {
                    targetOptions.push({ value: this.pieceRefStr(tx, ty, 0), label: `${verb} ${this.textFormat(facingCell!.pieces[0])}` });
                }
                buttons.push(...this.buildChoiceButtons("target", targetOptions, undefined));
            }
            // Swords pips is pure damage, no destination cell to click
            // (unlike Rods' own distance - see
            // handlePendingStepBoardClick's own docs), so it's a button
            // set instead, offered once a target is chosen.
            if (suitUid === "S" && pendingMinor.mode === "piece" && pendingMinor.rest.length >= 1) {
                const minionPiece = pendingMinor.minion.piece ?? this.board.get(pendingMinor.minion.x, pendingMinor.minion.y)!.pieces[pendingMinor.minion.index];
                const pipsOptions: ChoiceOption[] = [];
                for (let n = minionPiece.size; n >= 1; n--) {
                    pipsOptions.push({ value: String(n), label: `Attack for ${n}` });
                }
                buttons.push(...this.buildChoiceButtons("pips", pipsOptions, pendingMinor.rest[1]));
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
        // A "(via <uid>)" marker dispatches from the Fool/HP anchor itself
        // for a genuine resume (reassigned below once confirmed); otherwise
        // the front card token. A meta-card borrow ("as <x>") never moves
        // the head arg - it stays the World/Magician.
        let headArg = parsed.viaUid ?? parsed.rest[0];
        if (headArg === undefined) {
            return undefined;
        }
        // "as <x>": the card The World borrows (a uid) or the suit The
        // Magician runs (a letter).
        const borrowed = parsed.asUid;
        const worldBorrow = borrowed !== undefined && !ALL_SUITS.some(s => s.uid === borrowed);
        // "decline" is already a complete choice - there's no step for a
        // button set to configure, so the bar falls back to the plain
        // top-level context (getActionButtons then folds a persisting
        // Decline back in).
        if (parsed.head === "decline") {
            return undefined;
        }
        // A genuine resume is detected from the "(via <root>)" anchor
        // matching this.continued, not from the front head - so this is a
        // runtime-state check. (validateMove separately requires the
        // head itself to fit; here we only need to know it IS a resume.)
        // For button-building, a resumed continuation always plays
        // whatever revealed card is active, so `head` is "play".
        const isGenuineResume = this.continued.length > 0 && parsed.viaUid === this.getContinuedUid();
        // High Priestess resumes with its own tokens right after a
        // "discard" head, not as a "/"-separated segment - fold them back
        // (see resumeStepSegments) so the walk below sees them.
        const stepSegments = isGenuineResume ? this.resumeStepSegments(parsed) : parsed.stepSegments;
        if (isGenuineResume) {
            // A "discard" resume is a High Priestess round - its own tokens
            // aren't a card, so the pending step is the HP itself (viaUid).
            // A "play" resume names the revealed card as its front token.
            headArg = parsed.head === "discard" ? parsed.viaUid! : (parsed.rest[0] ?? parsed.viaUid!);
        }
        if (!isGenuineResume && parsed.head !== "use" && parsed.head !== "play") {
            return undefined;
        }
        const head: "use" | "play" = isGenuineResume ? "play" : parsed.head as "use" | "play";
        let card: Card | undefined;
        let eligible: IMinionRef[];
        // A card revealed by Fool (headArg names it directly for a resume)
        // is always play-pool eligible regardless - see this.continued's
        // own docs.
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
            const [, mode, ...rest] = segment;
            const { minion, ambiguous, candidates } = this.resolveStepMinion(segment, eligible);
            return { head, headArg, activeCardUid: headArg, suitUid, prefix: [], eligible, minions: eligible, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps: [], opts: {}, mode, rest };
        }

        const def = getMajorArcanaDef(card);
        // A resolution stack, local to this UI-only walk - not the
        // engine's own IPowerFrame, because `eligible` (the pool a
        // minion-selector button set gets generated from, frozen at this
        // frame's own push/activation time) needs to stay tracked
        // separately from `minions` (which keeps accreting via newMinion
        // chaining), exactly like the outer eligible/minions split above
        // already does for a minor card. Seeded from this.continued for
        // a genuine resume (matched against rootCardUid, not the top
        // frame's own cardUid, per IPendingMajorPower's own docs on why),
        // otherwise fresh from the root card just resolved.
        const stack: { cardUid: string; nextStepIndex: number; eligible: IMinionRef[]; minions: IMinionRef[] }[] =
            isGenuineResume
                ? this.resumeStack()!.map(f => ({ cardUid: f.cardUid, nextStepIndex: f.nextStepIndex, eligible: [...f.minions], minions: [...f.minions] }))
                : [{ cardUid: def.uid, nextStepIndex: 0, eligible: [...eligible], minions: [...eligible] }];

        // The World's sole step (worldUseAny) takes no segment - the
        // borrowed card is "as <uid>" in the head. Splice its frame on
        // now, with The World's own minion pool, so the walk below sees
        // that card's steps directly (mirrors walkFrameStack).
        if (worldBorrow) {
            const wt = stack[stack.length - 1];
            const wStep = this.resolveFrameDef(wt.cardUid).powers[wt.nextStepIndex];
            if (wStep !== undefined && "special" in wStep && wStep.special === "worldUseAny") {
                wt.nextStepIndex++;
                stack.push({ cardUid: borrowed!, nextStepIndex: 0, eligible: [...wt.minions], minions: [...wt.minions] });
            }
        }

        const priorSteps: string[] = [];
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
                // Fool's own step always auto-resolves the instant it's
                // next in line on a real commit (see walkFrameStack's own
                // docs) - there's nothing here for a click to build, and
                // what a flip reveals is unknowable until that real
                // commit happens, so this UI-only preview has nothing
                // further to say once it's reached, regardless of
                // whatever segment (if any) the player typed next.
                return undefined;
            }
            const tokens = stepSegments[segIdx];
            const isLastSegment = segIdx === stepSegments.length - 1;
            if ("primitive" in step) {
                const suitUidForStep = this.primitiveToSuit(step.primitive);
                const opts = this.computeShortcutOpts(frameDef, step.primitive, stepIndex, frameDef.powers.length, step.opts);
                const [, mode, ...rest] = tokens;
                // Same shared shape check apply/validate use (see
                // stepShapes.ts's own docs) - asked directly,
                // independently; this function never calls into apply or
                // validate for it. "malformed" is folded in with
                // "incomplete" here (both mean "still building" for this
                // best-effort UI preview - a hand-typed bad mode name is
                // caught properly at Submit, not mid-click).
                const shape = primitiveStepShape(suitUidForStep, tokens.slice(1));
                if (shape.status !== "complete" || (isLastSegment && callOpts.preferCurrent)) {
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
                    const { minion, ambiguous, candidates } = this.resolveStepMinion(tokens, top.minions);
                    return { head, headArg, activeCardUid: top.cardUid, asUid: borrowed, suitUid: suitUidForStep, prefix: [], eligible: top.eligible, minions: top.minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts, mode, rest };
                }
            } else {
                // highPriestess/fool have no minionRef to strip at all
                // (fool never reaches here - see the early-return above);
                // every other special does, matching apply/validate's own
                // convention for SPECIAL_STEP_SHAPES. A Magician borrow
                // ("as <suit>") reads that suit's own primitive grammar,
                // not magicianChoice's suit-letter-first one.
                const magicianAs = step.special === "magicianChoice" && borrowed !== undefined && ALL_SUITS.some(s => s.uid === borrowed);
                const noMinionRef = step.special === "highPriestess" || step.special === "fool";
                const shape = magicianAs
                    ? primitiveStepShape(borrowed!, tokens.slice(1))
                    : SPECIAL_STEP_SHAPES[step.special](noMinionRef ? tokens : tokens.slice(1));
                if (shape.status !== "complete" || (isLastSegment && callOpts.preferCurrent)) {
                    // Same "still building, or the caller wants it treated
                    // as current regardless" rule as the primitive branch
                    // above - see this function's own docs and
                    // buildSpecialPending's.
                    return this.buildSpecialPending(step.special, head, headArg, top.cardUid, top.eligible, top.minions, priorSteps, tokens, borrowed);
                }
            }
            // Walking past this segment (primitive-and-complete, or
            // special-and-complete) is what lets a LATER step of the SAME
            // frame (e.g. Tower's own attack, after its special
            // orientMinion step 1) become click-driven - replaying it
            // against a lazily-created clone (never `this`) keeps
            // `top.minions` genuinely current, not just positionally
            // chained: a real commit's own walkFrameStack/validateFrameStack
            // already replay every step this way (see their own docs) -
            // this mirrors it for the click-preview path, so a LATER
            // step's own default/target (e.g. minorTargetCell reading an
            // EARLIER orientMinion step's new facing) sees the actual
            // post-step state instead of whatever `this.board` still
            // holds before a real partial commit.
            priorSteps.push(tokens.join(" "));
            clone ??= this.cloneLive();
            const magicianAs = "special" in step && step.special === "magicianChoice" && borrowed !== undefined && ALL_SUITS.some(s => s.uid === borrowed);
            const replayTokens = magicianAs ? [tokens[0], borrowed!, ...tokens.slice(1)] : tokens;
            try {
                const outcome = clone.applyPowerStep(step, top.minions, replayTokens, frameDef, stepIndex, frameDef.powers.length, true);
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
                // Every other step's tokens failing to resolve against a
                // clone seeded from `this.board` means `this.board` has
                // already advanced past this step for real - render()'s
                // own frame-stepping reuses this same walk against an
                // already-historical board to compute each frame's own
                // button bar (see its own docs), where re-applying an
                // already-applied step is expected to fail exactly this
                // way. Nothing to replay there - keep walking with
                // `top.minions` unchanged, same as before this replay
                // existed.
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
            return { head, headArg, activeCardUid: top.cardUid, asUid: borrowed, suitUid, prefix: [], eligible: top.eligible, minions: top.minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts, mode: undefined, rest: [] };
        }
        return this.buildSpecialPending(step.special, head, headArg, top.cardUid, top.eligible, top.minions, priorSteps, [], borrowed);
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
    // magicianChoice is the one exception: once a suit letter is known,
    // the rest of its own grammar (<mode> <args...>) is identical to that
    // suit's own primitive step - rather than building a second, parallel
    // implementation of minorModeAvailability/buildStepModeMove/
    // handlePendingStepBoardClick/supplyStepCardUid for it, this returns
    // an ordinary SUIT-shaped pending instead, letting that entire
    // existing machinery drive stage 2 completely unmodified. The suit
    // reaches here two ways: "as <suit>" in the head (`borrowed`, the
    // plain case), or an inline suit-letter token (`tokens[1]`, only when
    // The World borrows The Magician) - the latter keeps prefix=[suit] so
    // that token survives every rebuilt move string.
    private buildSpecialPending(
        special: SpecialPower, head: "use" | "play", headArg: string, activeCardUid: string,
        eligible: IMinionRef[], minions: IMinionRef[], priorSteps: string[], tokens: string[], borrowed?: string,
    ): IPendingStep {
        if (special === "magicianChoice") {
            const suitFromAs = borrowed !== undefined && ALL_SUITS.some(s => s.uid === borrowed) ? borrowed : undefined;
            const suitFromToken = ALL_SUITS.some(s => s.uid === tokens[1]) ? tokens[1] : undefined;
            const suitUid = suitFromAs ?? suitFromToken;
            if (suitUid !== undefined) {
                const afterSuit = suitFromToken !== undefined ? tokens.slice(2) : tokens.slice(1);
                const [mode, ...rest] = afterSuit;
                const { minion, ambiguous, candidates } = this.resolveStepMinion(tokens, minions);
                return { head, headArg, activeCardUid, asUid: borrowed, suitUid, prefix: suitFromToken !== undefined ? [suitUid] : [], eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts: {}, mode, rest };
            }
        }
        // Fool/High Priestess have no minionRef at all. worldUseAny and a
        // suit-not-yet-chosen magicianChoice ALSO have no minion to pick
        // HERE: The World defers its own minion choice entirely to the
        // borrowed card's first step (see applyPowerStep's worldUseAny
        // docs - the pushed frame gets The World's WHOLE pool, unfiltered);
        // the Magician's own minion is part of its step's segment, which
        // doesn't even start until a suit is known (see the "as <suit>"
        // branch above, which already returns before reaching here once
        // suitUid resolves). Computing ambiguity against `minions` before
        // either of those exists would wrongly offer a "Choose Minion"
        // picker ahead of the real "as <card>"/"as <suit>" choice.
        const noMinionRef = special === "highPriestess" || special === "fool" || special === "worldUseAny" || special === "magicianChoice";
        const rest = noMinionRef ? tokens : tokens.slice(1);
        const { minion, ambiguous, candidates } = noMinionRef
            ? { minion: minions[0], ambiguous: false, candidates: minions }
            : this.resolveStepMinion(tokens, minions);
        return { head, headArg, activeCardUid, asUid: borrowed, special, prefix: [], eligible, minions, minion, minionAmbiguous: ambiguous, minionCandidates: candidates, priorSteps, opts: {}, mode: undefined, rest };
    }

    // The single valid cell a minor suit-power step may affect, per
    // assertValidCellTarget in powers.ts: the minion's own cell if it's
    // facing "U", otherwise the one cell it's pointing at. Also used as
    // the DEFAULT target for "piece"-shaped modes (self is additionally
    // always valid there too, per assertValidPieceTarget - clicking the
    // minion's own cell switches to that instead, see
    // handlePendingStepBoardClick).
    public minorTargetCell(minion: IMinionRef): [number, number] {
        // `minion.piece`, when set, is a snapshot from a clone that
        // already replayed an earlier step in the SAME still-building
        // move (see parsePendingStep's own docs) - preferred over a fresh
        // `this.board` read, which would still show that earlier step's
        // pre-mutation state until a real partial commit happens.
        const piece = minion.piece ?? this.board.get(minion.x, minion.y)!.pieces[minion.index];
        if (piece.orientation === "U") {
            return [minion.x, minion.y];
        }
        const [dx, dy] = this.board.delta(piece.orientation as Exclude<Orientation, "U">);
        return [minion.x + dx, minion.y + dy];
    }

    // Whether `step` is a piece-target special that CANNOT be completed at
    // all right now - used only to decide whether an implicit decline
    // (segments simply ran out - see validateFrameStack's/walkFrameStack's
    // own docs) deserves an explicit "nothing to do here" message instead
    // of the ordinary silent-decline every other optional step gets.
    // tradeHands and hierophantReplace are the only two members of
    // pickPieceTargetClick's own shared family that can ever have NO legal
    // candidate: both require an ENEMY specifically, and their only
    // possible target cell is the acting minion's own self-or-facing cell
    // (minorTargetCell) - self never counts (it's never an enemy), so
    // there's nothing left to check but whether an enemy piece sits on
    // that one facing cell. orientAny/hermitTeleport have no such
    // restriction (self always qualifies - see pickPieceTargetClick's own
    // docs), so they can never be doomed this way.
    //
    // Checked against EVERY minion in `minions`, not just the frame's own
    // first one - a step reached via chainMinion (see its own docs) may
    // legitimately carry more than one still-live candidate (Cups' own
    // "create", say - the acting piece AND the freshly created one are
    // both real). `minions` is trusted directly here: chainMinion already
    // prunes a relocated/replaced-in-place piece's own stale, pre-move
    // ref at the moment it would otherwise be introduced, so nothing left
    // in the array ever points at a cell with no piece on it anymore.
    // `ctx` (not `this`) matters because validateFrameStack applies a
    // still-being-validated step to a CLONE, not `this` - the acting
    // piece's real, current position/orientation only exists there.
    // Doomed only when EVERY candidate is - if a still-eligible OTHER
    // minion might yet reach an enemy, there's a genuine choice left, so
    // nothing should be said.
    private specialStepHasNoLegalTarget(ctx: GnosticaGame, step: PowerStep, minions: readonly IMinionRef[]): boolean {
        if (!("special" in step) || (step.special !== "tradeHands" && step.special !== "hierophantReplace")) {
            return false;
        }
        return minions.every(m => {
            const [faceX, faceY] = ctx.minorTargetCell(m);
            const t = ctx.board.get(faceX, faceY);
            return t === undefined || !t.pieces.some(p => p.owner !== ctx.currplayer);
        });
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
    // happen once the game has actually started). Takes an explicit
    // board (defaulting to the live one) so renderFrame() can compute a
    // historical frame's own window from that frame's own board, not the
    // live one - board window can genuinely differ mid-chain.
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

    // Inverse of resolvePieceRef: the shortest ref that resolves back to
    // this exact piece within the same pool (see resolvePieceRef's docs -
    // omitted here, defaults to every piece at the cell). Tries pips alone,
    // then pips+orientation alone, then pips+player alone (skipping
    // orientation if it didn't help), then all three together.
    public pieceRefStr(x: number, y: number, index: number, pool?: IMinionRef[]): string {
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

    private getPipsFromRef(ref: string): string {
        const idx = ref.indexOf(".");
        return idx === -1 ? ref : ref.split(".")[1];
    }

    // The one place an "orient" result is built - standalone "orient",
    // orientMinion, and the Devil's orientAny all funnel through here, so
    // the log always records whose piece was turned. Call after the facing
    // is set (ownership is unaffected by it).
    private pushOrientResult(x: number, y: number, index: number, ref: string, facing: Orientation): void {
        this.results.push({
            type: "orient",
            where: GnosticaBoard.coords2algebraic(x, y),
            what: this.getPipsFromRef(ref),
            facing,
            who: this.board.get(x, y)!.pieces[index].owner,
        });
    }

    // Reads size/orientation straight off the piece itself, rather than
    // trying to parse them back out of a minion ref string - a ref only
    // carries orientation when it was actually NEEDED to disambiguate
    // (see pieceRefStr's own docs; two candidates of different sizes
    // never need it at all), so a piece whose size alone was unique would
    // otherwise render as "...pointing undefined" here.
    private textFormat(piece: Piece): string {
        return `${piece.size}-pip pointing ${piece.orientation === "U" ? "up" : piece.orientation}`;
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

    // Best-effort feasibility check over which modes are worth offering as
    // buttons right now, given current board state AND hand contents - not
    // a full legality check (validateMove still catches anything this
    // misses or over-includes once the player actually acts). A mode found
    // infeasible here still gets a button (see getActionButtons' own
    // tree-pruning docs) - it's shown struck through, and an actual click
    // is rejected immediately with the specific reason recorded here,
    // rather than being omitted outright or left to fail only at submit.
    // Only the three fields below are ever read - deliberately narrower
    // than IPendingStep (a real one satisfies this structurally, no cast
    // needed) so legalModesForMinion (randomMove's own, looser caller,
    // with no full IPendingStep of its own to build) can share this exact
    // switch too, instead of maintaining a second, byte-for-byte copy of
    // it that just returns booleans.
    public minorModeAvailability(pending: { suitUid?: string; minion: IMinionRef; opts: Record<string, unknown> }): Map<string, { key: string; params?: Record<string, unknown> } | undefined> {
        // Only ever called for a suit-shaped pending - see buildStepModeMove's
        // own docs on why suitUid is guaranteed set here.
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
    }


    // Builds the move string for choosing a suit-power mode via button -
    // the minion is always the first eligible one (see
    // IPendingStep's docs), and the target cell is auto-derived
    // (minorTargetCell) since it's fully determined by the minion's own
    // facing, not something the player needs to click. "Piece"-shaped
    // modes leave the target unset instead of guessing whenever there's a
    // genuine choice (self vs. whatever's at the facing cell) - see
    // getActionButtons' own "target_" button set, the only way to choose
    // between them (handlePendingStepBoardClick's own docs explain why
    // that's button-only, not a board click). Deliberately produces a step with
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
    public victimRefStr(x: number, y: number, index: number): string {
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
        throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: result.kind === "malformed" ? "BAD_PIECE_REF" : "NO_SUCH_PIECE" }));
    }

    // Spells a pending step's own head, shared by assembleStepMove (mid-
    // click, still adding a segment) and pendingMoveString (echoing back
    // the CURRENT state unmodified, e.g. on a rejected click) - both need
    // the exact same verb / "as <x>" / "(via <uid>)" logic, so neither
    // hand-rolls it separately. `pending.head` is always the true
    // originating verb, `headArg` the root card - stable throughout: a
    // World/Magician borrow is spelled with "as <x>", never by swapping
    // in the borrowed card as the head arg.
    private describePendingMove(pending: IPendingStep, stepSegments: string[][]): string {
        const base: IParsedMove = { announceLast: false, head: pending.head, headRecognized: true, rest: [pending.headArg], stepSegments, malformedStep: undefined, asUid: pending.asUid };
        // A genuine resume always carries a "(via <root>)" anchor for
        // validateResumePendingPower's own mismatch check.
        if (this.continued.length > 0) {
            // High Priestess's own step IS a discard/draw - "play 02" would
            // be a lie (there's no card being played), so it resumes as a
            // bare "discard <uids> draw <n> (via 02)", its tokens sitting
            // directly after the head the way the ordinary end-of-turn
            // discard action's own do.
            if (pending.special === "highPriestess") {
                const tokens = stepSegments[stepSegments.length - 1] ?? [];
                return this.pickleMove({ ...base, head: "discard", rest: tokens, stepSegments: [], viaUid: this.getContinuedUid(), asUid: undefined });
            }
            return this.pickleMove({ ...base, viaUid: this.getContinuedUid() });
        }
        return this.pickleMove(base);
    }

    // Assembles a full move string from a pending step's own already-typed
    // PRIOR power-step segments (verbatim) plus the current one's tokens -
    // shared by every click helper below that builds/rebuilds a move, so
    // a major-arcana chain's earlier steps are never lost while a LATER
    // one is still being clicked together. For a minor card (priorSteps
    // always []) this reduces to exactly what these helpers built before
    // major-arcana chaining existed.
    private assembleStepMove(pending: IPendingStep, currentTokens: string[]): string {
        return this.describePendingMove(pending, [...pending.priorSteps.map(s => s.split(/\s+/)), currentTokens]);
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
        // Whether the minion is actually facing a piece (not "U", which
        // has no facing cell at all) - shared by all three "piece" modes
        // below to decide whether there's a genuine target CHOICE to make
        // at all. When there is, this button leaves the target unset
        // rather than picking a side - see getActionButtons' own
        // "target_" button set, the sole way to choose between them now
        // (never a board click - see handlePendingStepBoardClick's own
        // docs on why that would be ambiguous with distance/orientation).
        const facingHasPiece = (tx !== pending.minion.x || ty !== pending.minion.y)
            && (this.board.get(tx, ty)?.pieces.length ?? 0) > 0;
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
                if (!facingHasPiece) {
                    tokens.push(selfRef, "1");
                }
                break;
            case "R.tile":
                tokens.push("1");
                break;
            case "D.piece":
                if (!facingHasPiece) {
                    tokens.push(selfRef);
                }
                break;
            case "D.tile":
                tokens.push(targetCell);
                break;
            case "S.piece":
                if (!facingHasPiece) {
                    tokens.push(selfRef, "1");
                }
                break;
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
            return this.describePendingMove(pending, pending.priorSteps.map(s => s.split(/\s+/)));
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
        // Fills the rebuilt move's own selector slot below - disambiguated
        // only against the player's OTHER minions currently in play (see
        // resolvePieceRef's docs on the "minion-selector" pool); the
        // "piece"-shape branch's own self-or-facing target instead goes
        // through pickPieceTargetClick, the same primitive tradeHands/
        // orientAny/hierophantReplace/hermitTeleport already use.
        const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
        const minionPiece = pending.minion.piece ?? this.board.get(pending.minion.x, pending.minion.y)!.pieces[pending.minion.index];
        const rebuild = (rest: string[], messageKey?: string): IClickResult =>
            this.provisionalResult(this.assembleStepMove(pending, [minionRef, ...pending.prefix, mode, ...rest]), messageKey);

        if (config.shape === "cell") {
            const [tx, ty] = this.minorTargetCell(pending.minion);
            // Cups "own" is the one cell-shape mode with an orientation arg
            // (the new piece's own facing) - a click here is the exact
            // same trailing-optional-orientation primitive every other
            // target minion gets (see the "piece"-shape branch's own
            // docs): it sets the OPTIONAL 3rd token (the reorientation),
            // never the creation's own mandatory 2nd one, and a same-
            // facing request is hard-rejected by validateCups itself, not
            // specially softened here. Clickable region is the target
            // cell PLUS its neighbours, not just the cell itself like
            // every other cell-shape mode below.
            if (suitUid === "C" && mode === "own") {
                const dir = this.orientationTowardClick(tx, ty, x, y);
                if (dir === undefined) {
                    return undefined;
                }
                return rebuild([GnosticaBoard.coords2algebraic(tx, ty), pending.rest[1] ?? "U", dir]);
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
            // The target itself is button-only now (getActionButtons'
            // own "target_" button set) - a "piece" mode's target is
            // either self or whatever's at the facing cell, and both of
            // those same cells are also where distance (Rods) and the
            // trailing orientation want to click, so overloading them
            // with a THIRD meaning (retargeting) was genuinely confusing.
            // Until a button has picked one, there's nothing for a board
            // click to do here at all.
            if (pending.rest.length === 0) {
                return undefined;
            }
            const targetResolution = this.resolvePieceRef(pending.rest[0]);
            const target = targetResolution.kind === "ok" ? targetResolution.ref : undefined;
            if (target === undefined) {
                return undefined;
            }

            // Rods' distance is a real destination cell, along the ACTING
            // minion's own facing (matches movePiece's own computation).
            if (suitUid === "R") {
                const [dx, dy] = this.board.delta(minionPiece.orientation as Exclude<Orientation, "U">);
                for (let n = 1; n <= minionPiece.size; n++) {
                    if (x === target.x + dx * n && y === target.y + dy * n) {
                        return rebuild([pending.rest[0], String(n)]);
                    }
                }
            }

            // Once the suit action is otherwise complete, a further click
            // on or adjacent to the target's own EFFECTIVE position
            // (Rods: where it will land; Discs/Swords: unchanged) sets
            // its facing - but only for the player's own piece, matching
            // movePiece/growPiece/attackPiece's own "owner===currplayer"
            // gate in powers.ts.
            if (pending.rest.length < config.minArgs) {
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
                const dist = parseInt(pending.rest[1], 10);
                effX = target.x + dx * dist;
                effY = target.y + dy * dist;
            }
            const dir = this.orientationTowardClick(effX, effY, x, y);
            if (dir === undefined) {
                return undefined;
            }
            return rebuild([...pending.rest.slice(0, config.minArgs), dir]);
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
        // tradeHands/hierophantReplace must target an enemy (checkTradeHands/
        // checkHierophantReplace, powers.ts) - orientAny/hermitTeleport have
        // no such restriction. Reject a self-target (or a facing cell whose
        // only/first piece is the acting player's own) immediately here,
        // rather than letting it build a provisional move that's guaranteed
        // to fail with the same message only once submitted.
        const requiresEnemy = pendingForError.special === "tradeHands" || pendingForError.special === "hierophantReplace";
        const enemyKey = pendingForError.special === "tradeHands" ? "TRADEHANDS_MUST_TARGET_ENEMY" : "HIEROPHANT_MUST_TARGET_ENEMY";
        if (x === minion.x && y === minion.y) {
            if (requiresEnemy) {
                return { move: this.pendingMoveString(pendingForError), valid: false, message: i18next.t(`apgames:validation.gnostica.${enemyKey}`) };
            }
            return this.pieceRefStr(minion.x, minion.y, minion.index);
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
            return this.pieceRefStr(faceX, faceY, enemyIndex);
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
            case "worldUseAny":
                return this.handleWorldChooseClick(pending, x, y);
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
            // The target is chosen; its new facing is a genuinely separate
            // decision that only the player's own click may make - never
            // auto-assigned (see validateOrient's own matching docs on
            // why this applies to every EXISTING minion's reorientation,
            // not just the standalone "orient" command). Two tokens where
            // three are expected is "incomplete" per stepShapes.ts's own
            // fixedArity check, so this is already tolerated as still
            // building, not an error - see validatePowerStep's own docs.
            return this.provisionalResult(
                this.assembleStepMove(pending, [minionRef, targetResult]),
                "apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT",
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

    // worldUseAny: a click on any major currently on the board (except
    // World itself) picks it as the borrowed card, regardless of who has
    // pieces there - unlike every other click-to-target flow above (all of
    // which gate on piece presence at the clicked cell). checkWorldChoosePower
    // is what actually enforces legality; a click on anything else just
    // misses. The pick lands in the head as "as <uid>"; The World's own
    // minion is chosen later, from the borrowed card's frame.
    private handleWorldChooseClick(pending: IPendingStep, x: number, y: number): IClickResult | undefined {
        const t = this.board.get(x, y);
        if (t?.card === undefined) {
            return undefined; // not a card cell at all - not this handler's click
        }
        // A card cell, but the wrong kind: a World target pick IS in
        // progress here, so say what's actually needed rather than falling
        // through to the generic "start a fresh use here" path (which would
        // complain about a missing minion on that other territory).
        if (t.card.uid === "21") {
            return { move: this.pendingMoveString(pending), valid: false, message: i18next.t("apgames:validation.gnostica.WORLD_SELF_REFERENCE") };
        }
        if (!t.card.major) {
            return { move: this.pendingMoveString(pending), valid: false, message: i18next.t("apgames:validation.gnostica.WORLD_CHOOSE_TARGET") };
        }
        return this.provisionalResult(this.describePendingMove({ ...pending, asUid: t.card.uid }, pending.priorSteps.map(s => s.split(/\s+/))));
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
        let result: IClickResult;
        if (piece === "_btn_declare") {
            result = this.provisionalResult(this.pickleMove({ ...parsed, announceLast: !parsed.announceLast }));
        } else {
            const bareMove = this.pickleMove({ ...parsed, announceLast: false });
            const core = this.handleClickCore(bareMove, row, col, piece);
            result = this.reattachLastFlag(core, parsed.announceLast);
        }
        // The front end (see playground.js's own boardClick()) only
        // re-renders a live partial preview when `canrender` or
        // `complete >= 0` is set (see IValidationResult's own docs). A
        // great many of gnostica's own click-driven results are
        // legitimately valid but complete:-1 (still building a chain/
        // mode - see #49) - every one of them DOES represent a genuine,
        // helpful partial preview (a card just got picked, a step just
        // got typed, a top-level button just got chosen), so canrender is
        // set unconditionally here for any valid result, rather than
        // threading it through every individual return site inside
        // handleClickCore/handleBiddingClick/provisionalResult - missing
        // even one would silently leave the button bar/board stale after
        // that click.
        if (result.valid) {
            result.canrender = true;
        }
        return result;
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
            if (!this.biddingPool!.includes(uid)) {
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
            // A genuine pending obligation's own real buttons/click targets
            // (mode_, magician_, hermit_, minion_, board/hand-card clicks)
            // now show up directly - see getActionButtons()'s own docs on
            // why "Use Card X" is skipped whenever possible - so `move`
            // (movebox.value, from the caller) may still be whatever was
            // left over from BEFORE this obligation existed (typically "",
            // untouched since the last real commit). Every helper below
            // that parses `move` for its own head/rootCardUid needs the
            // obligation's own seed regardless of whether anything's been
            // clicked yet this turn - mirrors resume_power's own identical,
            // one-off seeding further down, just applied uniformly here so
            // every OTHER handler doesn't have to duplicate it.
            if (this.continued.length > 0 && this.parseMove(move).head === undefined) {
                move = this.pickleMove(this.buildViaMove([]));
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
                    const clickedPiece = this.board.get(resolved.ref.x, resolved.ref.y)!.pieces[resolved.ref.index];
                    const rodReason = this.rodNeedsFacingReason(pending.suitUid, clickedPiece);
                    if (rodReason !== undefined) {
                        return { move, valid: false, message: i18next.t(`apgames:validation.gnostica.${rodReason.key}`) };
                    }
                    const minionRef = this.pieceRefStr(resolved.ref.x, resolved.ref.y, resolved.ref.index, pending.minions);
                    return this.provisionalResult(this.assembleStepMove(pending, [minionRef]));
                }
                if (value.startsWith("orientpick_")) {
                    // "orientpick_<ref>" - orient's own minion-picker (see
                    // computeActionButtons' own docs on why this doesn't
                    // reuse "minion_": orient has no IPendingStep of its
                    // own to resolve against). Picking one names ONLY
                    // which minion to reorient - its new facing is a
                    // genuinely separate decision the player still has to
                    // click for (see validateOrient's own
                    // PICK_DIRECTION_TO_ORIENT docs) - never auto-assigned.
                    const ref = value.slice("orientpick_".length);
                    const parsed = this.parseMove(move);
                    if (parsed.head?.toLowerCase() !== "orient") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const resolved = this.resolvePieceRef(ref);
                    if (resolved.kind !== "ok" || this.board.get(resolved.ref.x, resolved.ref.y)!.pieces[resolved.ref.index].owner !== this.currplayer) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    return this.provisionalResult(`orient ${this.pieceRefStr(resolved.ref.x, resolved.ref.y, resolved.ref.index)}`);
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
                    const reason = this.minorModeAvailability(pending).get(mode);
                    if (reason !== undefined) {
                        return { move, valid: false, message: i18next.t(`apgames:validation.gnostica.${reason.key}`, reason.params ?? {}) };
                    }
                    return this.provisionalResult(this.buildStepModeMove(pending, mode));
                }
                if (value.startsWith("target_")) {
                    // "piece" mode's own target - see getActionButtons'
                    // own docs on why this is button-only, not a board
                    // click. Only ever offered while rest is still empty
                    // (the choice hasn't been made yet), so this always
                    // starts the step's own trailing args fresh.
                    const ref = value.slice("target_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.mode !== "piece"
                        || (pending.suitUid !== "R" && pending.suitUid !== "D" && pending.suitUid !== "S") || pending.rest.length !== 0) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
                    const rest = pending.suitUid === "D" ? [ref] : [ref, "1"];
                    return this.provisionalResult(this.assembleStepMove(pending, [minionRef, ...pending.prefix, "piece", ...rest]));
                }
                if (value.startsWith("pips_")) {
                    // Swords "piece" (attack) pips - see getActionButtons'
                    // own docs on why this is a button set rather than a
                    // click-cycled arg. Always rebuilt against the
                    // CURRENT target (pending.rest[0]) - the button set
                    // itself is only ever offered once one is chosen.
                    const n = value.slice("pips_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.suitUid !== "S" || pending.mode !== "piece" || pending.rest.length === 0) {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    const minionRef = this.pieceRefStr(pending.minion.x, pending.minion.y, pending.minion.index, pending.minions);
                    return this.provisionalResult(this.assembleStepMove(pending, [minionRef, ...pending.prefix, "piece", pending.rest[0], n]));
                }
                if (value.startsWith("magician_")) {
                    // Stage 1 of magicianChoice - picks the suit letter,
                    // which lands in the head as "as <suit>". Once present,
                    // buildSpecialPending's own magicianChoice branch
                    // redirects `pending` into an ordinary suit-shaped one,
                    // so every FOLLOWING click goes through the existing,
                    // unmodified suit-mode machinery - see its own docs.
                    const suitUid = value.slice("magician_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.special !== "magicianChoice") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    return this.provisionalResult(this.describePendingMove({ ...pending, asUid: suitUid }, pending.priorSteps.map(s => s.split(/\s+/))));
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
                    if (parsed.head !== "discard") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    return this.provisionalResult(["discard", ...parsed.rest, "draw", n].join(" "));
                }
                if (value.startsWith("hpdraw_")) {
                    // High Priestess's own count-picker buttons - mirrors
                    // drawcount_ above, but appends onto the CURRENT power
                    // step's own tokens (pending.rest, already carrying
                    // every discard named so far) rather than the top-level
                    // move's args.
                    const n = value.slice("hpdraw_".length);
                    const pending = this.parsePendingStep(move);
                    if (pending === undefined || pending.special !== "highPriestess") {
                        return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                    }
                    // Picking a count always completes this step (highPriestess's
                    // own shape check in stepShapes.ts is unconditional -
                    // any token count is "complete enough" - but the count
                    // itself is the one thing every submission needs) -
                    // unlike the
                    // generic "Looks like a valid move" fallback, tell the
                    // player what submitting actually does: forces a pause
                    // for a SECOND round (see applyPowerStep's own docs) if
                    // this is the first, or ends the whole activation if
                    // it's the second - same stepIndex-from-pendingPower
                    // derivation as the resume_power case above, so this
                    // stays correct even for a High Priestess reached via a
                    // push (Fool's reveal, World's borrow), not just a
                    // direct "use"/"play".
                    const resumeStack = this.resumeStack();
                    const stepIndex = resumeStack !== undefined
                        ? resumeStack[resumeStack.length - 1].nextStepIndex
                        : 0;
                    const messageKey = stepIndex > 0
                        ? "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND2_READY"
                        : "apgames:validation.gnostica.HIGH_PRIESTESS_ROUND1_READY";
                    return this.provisionalResult(this.assembleStepMove(pending, [...pending.rest, "draw", n]), messageKey);
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
                        // validateDiscard's own message already says this
                        // (see its own docs) - no override needed.
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
                    case "resume_power": {
                        // Seeds the resume submission's head + already-known
                        // card uid directly (unlike "use"/"play" above,
                        // there's no ambiguity to resolve via a board click -
                        // pendingPower already names the exact card) - the
                        // existing hand-card-click toggle then builds the
                        // discard list from here unmodified.
                        if (this.continued.length === 0) {
                            return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                        }
                        const seeded = this.pickleMove(this.buildViaMove([]));
                        // The message is about whichever frame is actually
                        // active right now (the top of the stack - e.g. a
                        // card Fool revealed, not necessarily rootCardUid
                        // itself), at its own real step index - not always
                        // step 0, unlike a fresh activation. Routed through
                        // provisionalResult (rather than a hardcoded
                        // complete:-1) because a resumed Fool flip is
                        // ALREADY complete via synthesizeFoolStep - the
                        // player needs Submit enabled, not a false "still
                        // building" state; every other card's genuinely
                        // incomplete resume (e.g. High Priestess round 2)
                        // still reports complete:-1 on its own, unaffected.
                        const resumeStack = this.resumeStack()!;
                        const activeTop = resumeStack[resumeStack.length - 1];
                        const activeMsg = this.powerStepMessageKey(activeTop.cardUid, activeTop.nextStepIndex, activeTop.minions);
                        return this.provisionalResult(seeded, activeMsg.key, activeMsg.params);
                    }
                    case "decline_power": {
                        if (this.continued.length === 0) {
                            return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                        }
                        const declined = this.pickleMove(this.buildViaMove([["decline"]]));
                        // Declining pops the CURRENT top frame. The only
                        // thing that can be left underneath - Fool's own
                        // remaining flip - auto-resolves on this same real
                        // commit instead of pausing (see walkFrameStack's
                        // own docs), so name that outcome plainly rather
                        // than a card that isn't known yet.
                        const remaining = this.resumeStack()!.slice(0, -1);
                        return this.provisionalResult(
                            declined,
                            this.topStepIsFool(remaining) ? "apgames:validation.gnostica.DECLINE_THEN_AUTO_DRAW" : undefined,
                        );
                    }
                    case "random":
                        // Only ever offered for Wheel of Fortune's own
                        // "new" step (see getActionButtons()'s own docs) -
                        // supplies the literal "random" token exactly the
                        // way a hand-card click supplies a specific uid
                        // (see supplyStepCardUid's own docs).
                        {
                            const pending = this.parsePendingStep(move);
                            if (pending === undefined || pending.suitUid !== "C" || pending.mode !== "new" || pending.opts.allowRandomDraw !== true) {
                                return { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                            }
                            const result = this.supplyStepCardUid(pending, "random");
                            return result ?? { move, valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
                        }
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
            // playing the card outright ("play"), or toggling it into an
            // already-selected discard's uid list. With no action
            // selected yet, the click is rejected outright - the player
            // needs to pick a button (Use/Play/Discard/etc.) first.
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
                    //
                    // Any already-chosen "draw <n>" tail is dropped before
                    // toggling, exactly like "discard"'s own handling below -
                    // the valid count range shifts with the discard list
                    // itself, so changing which cards are discarded
                    // re-solicits the count fresh. Without this, a card
                    // toggled AFTER a count was already chosen would be
                    // appended past the "draw" token and silently ignored
                    // (never actually discarded) rather than added to the
                    // list.
                    const drawIdx = pendingForCard.rest.indexOf("draw");
                    let discards = drawIdx === -1 ? [...pendingForCard.rest] : pendingForCard.rest.slice(0, drawIdx);
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
                    const playMsg = this.powerStepMessageKey(uid, 0, freshPending?.minions ?? []);
                    return this.provisionalResult(
                        `play ${uid}`,
                        needsCellClick ? "apgames:validation.gnostica.PICK_MINION_CELL" : playMsg.key,
                        needsCellClick ? undefined : playMsg.params,
                    );
                }
                if (head === "discard") {
                    // Any already-chosen "draw <n>" tail is deliberately
                    // dropped here rather than carried forward - the valid
                    // count range shifts with the discard list itself, so
                    // changing which cards are discarded re-solicits the
                    // count fresh (via getActionButtons()'s own count-
                    // picker) rather than silently keeping a now-possibly-
                    // invalid number.
                    const drawIdx = args.indexOf("draw");
                    let discards = drawIdx === -1 ? [...args] : args.slice(0, drawIdx);
                    if (discards.includes(uid)) {
                        discards = discards.filter(u => u !== uid);
                    } else {
                        discards.push(uid);
                    }
                    return this.provisionalResult(["discard", ...discards].join(" "));
                }
                // No action selected yet (or one that a hand-card click
                // makes no sense for) - require a button click first
                // rather than guessing what the player meant, same as an
                // ambiguous board click below.
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
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
            // powerStepMessageKey()'s own result (use/play's bare "<uid>"
            // state right after picking the card, before any suit mode or
            // power step - not yet submittable per #49, so this nudges
            // toward picking a step; the "play" half of this is set in the
            // hand-card click branch below, not here). See
            // provisionalResult's own messageKey param.
            let resultMessageKey: string | undefined;
            let resultMessageParams: Record<string, unknown> | undefined;

            if (head === "place") {
                // Click-to-orient (see orientationTowardClick's own docs):
                // once a placement cell is chosen, clicking it again means
                // "face up", clicking one of its neighbours means "face
                // that way" - any OTHER cell is a fresh placement there
                // instead (defaulting to "U" again), same as clicking a
                // different cell always has. The mandatory facing is
                // always "U" (matches Cups "own"'s identical mandatory-
                // token rule - see resolveTrailingOrientation's own docs);
                // a further click doesn't rewrite it, it sets the OPTIONAL
                // trailing correction instead - collapsing back to the
                // bare 2-token form when the clicked direction IS "U"
                // (would otherwise be a rejected no-op correction). A
                // freshly-seeded "U" (nothing clicked yet for THIS cell)
                // carries a trailing "?" marking it as not yet a
                // deliberate choice (see validatePlace's own docs) - any
                // further click, confirming or correcting, drops it.
                const [prevCell] = args;
                let dir: Orientation | undefined;
                if (prevCell !== undefined) {
                    const [px, py] = GnosticaBoard.algebraic2coords(prevCell);
                    dir = this.orientationTowardClick(px, py, x, y);
                }
                if (prevCell !== undefined && dir !== undefined) {
                    newmove = dir === "U" ? `place ${prevCell} U` : `place ${prevCell} U ${dir}`;
                } else {
                    newmove = `place ${cell} U?`;
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
                let prevLoc: { x: number; y: number; index: number } | undefined;
                // A bare cell token (2+ own pieces there, none picked yet -
                // see computeActionButtons'/validateOrient's own
                // "orientpick_"/ambiguity docs) isn't a resolvable piece
                // ref at all - treat it the same as "nothing selected
                // yet" below, rather than letting resolvePieceRefOrThrow
                // throw on it.
                if (prevRef !== undefined && prevRef.includes(".")) {
                    prevLoc = this.resolvePieceRefOrThrow(prevRef);
                    dir = this.orientationTowardClick(prevLoc.x, prevLoc.y, x, y);
                }
                if (prevLoc !== undefined && dir !== undefined) {
                    const targetPiece = this.board.get(prevLoc.x, prevLoc.y)!.pieces[prevLoc.index];
                    newmove = `orient ${prevRef} ${dir}`;
                    // A click that would leave the piece facing exactly
                    // where it already does is a no-op (see validateOrient's
                    // own ORIENT_NO_OP docs) - let that message through
                    // unmodified rather than stomping it with the generic
                    // "still adjustable" one, which would otherwise always
                    // win here.
                    resultMessageKey = dir === targetPiece.orientation
                        ? undefined
                        : "apgames:validation.gnostica.DIRECTION_STILL_ADJUSTABLE";
                } else {
                    // Fresh selection - routed through the same minion-
                    // selection primitive "use"/"play" already use
                    // (eligibleMinionsForOrient/resolveStepMinion), rather
                    // than grabbing whichever of the player's own pieces
                    // happened to be first at this cell: 2+ distinguishable
                    // pieces here means a real choice is needed, offered
                    // via computeActionButtons' own "orientpick_" buttons.
                    // Selecting the minion never itself assigns a facing -
                    // that's the player's own, separate decision (see
                    // validateOrient's own PICK_DIRECTION_TO_ORIENT docs);
                    // a fresh piece's own initial facing (Cups "own") is
                    // the only place a default is legitimate, never an
                    // existing minion's.
                    const pool = this.eligibleMinionsForOrient(x, y);
                    if (pool.length === 0) {
                        return { move, valid: false, message: i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "NO_SUCH_PIECE" }) };
                    }
                    const { minion, ambiguous } = this.resolveStepMinion(undefined, pool);
                    if (ambiguous) {
                        return this.provisionalResult(`orient ${cell}`, "apgames:validation.gnostica.PICK_MINION_BUTTON");
                    }
                    newmove = `orient ${this.pieceRefStr(minion.x, minion.y, minion.index)}`;
                    resultMessageKey = undefined; // let validateOrient's own PICK_DIRECTION_TO_ORIENT show through
                }
            } else if (head === "use" || head === "play" || this.continued.length > 0) {
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
                        const narrowMsg = this.powerStepMessageKey(candidate.activeCardUid, candidate.priorSteps.length, atCell);
                        return this.provisionalResult(
                            this.assembleStepMove(candidate, [ref]),
                            narrowMsg.key,
                            narrowMsg.params,
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
                if (head === "play" || this.continued.length > 0) {
                    // "play" has no cell of its own to re-pick the way
                    // "use" does below - a board click here only ever
                    // means pending-step cycling (handled above); anything
                    // else is ambiguous. A genuine resume always plays a
                    // revealed card, so it's the same situation -
                    // there's still no cell of its own to fall back to.
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
                {
                    const useMsg = this.powerStepMessageKey(t.card.uid, 0, this.eligibleMinionsForActivate(x, y));
                    resultMessageKey = useMsg.key;
                    resultMessageParams = useMsg.params;
                }
            } else if (!this.hasPiecesOnBoard(this.currplayer)) {
                // Fresh click, nothing placed yet - place is the only legal
                // start, and needs no button. The facing is always written
                // out explicitly (see validatePlace's own mandatory-token
                // docs), defaulting to "U" - not yet a deliberate choice
                // (the trailing "?" - see validatePlace's own docs), so
                // validatePlace's own generic message/complete:0 are left
                // to show through rather than overridden here.
                newmove = `place ${cell} U?`;
            } else {
                // No mode chosen yet (or an unrecognized one) and pieces
                // already exist - board clicks are genuinely ambiguous
                // here (see getActionButtons()'s docs), so this doesn't
                // guess; the player picks a button first.
                return { move, valid: false, message: i18next.t("apgames:validation.gnostica.CHOOSE_ACTION_FIRST") };
            }

            return this.provisionalResult(newmove, resultMessageKey, resultMessageParams);
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
    // validateMove()'s own single top-level gate (both directions - "place"
    // needs zero, every other head needs some), getActionButtons(), and
    // randomMove().
    public hasPiecesOnBoard(player: playerid): boolean {
        for (const [, , t] of this.board.entries()) {
            if (t.pieces.some(p => p.owner === player)) {
                return true;
            }
        }
        return false;
    }

    private parseOrientation(s: string): Orientation {
        const dir = s.toUpperCase();
        if ((allOrientations as string[]).includes(dir)) {
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
    // Legality (a real position index into this player's own hand, not
    // already bid) is validateBid's own job, not this one's.
    private cmdBid(args: string[], partial = false): void {
        if (partial) {
            return;
        }
        const n = Number(args[0]);
        this.bidPositions![this.currplayer - 1] = n;
        this.results.push({ type: "select", who: this.currplayer, what: "bid" });
        if (this.bidPositions!.every(p => p !== null)) {
            this.resolveBidRound();
        } else {
            this.nextPlayer();
        }
    }

    private validateBid(parsed: IParsedMove): IValidationResult {
        const [nStr] = parsed.rest;
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
        if (this.bidPositions![this.currplayer - 1] !== null) {
            return this.invalid("apgames:validation.gnostica.ALREADY_BID");
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // Every bidPositions slot is filled - reveal them all together
    // (splicing each named card out of its owner's hand into the shared
    // biddingPool, real uids and all - safe now, since this is the exact
    // moment the rules say everyone becomes entitled to see them) and
    // resolve the round.
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

        // "The player with the highest number major arcana card wins the
        // bid. If nobody bid with a major arcana card, then the player
        // with the highest minor arcana card wins" - every card's own
        // rank.seq (majors 0-21, minors Ace=1..King=14) is exactly this
        // comparison key already; no separate ranking table needed.
        const majors = revealed.filter(r => r.card.major);
        const pool = majors.length > 0 ? majors : revealed;
        const rank = (r: { card: TarotCard }): number => r.card.rank.seq;
        const maxRank = Math.max(...pool.map(rank));
        const winners = pool.filter(r => rank(r) === maxRank).map(r => r.player);

        // "Tournament rules": the order of play for the rest of the game
        // is exactly the rank order of the cards everyone bid (majors
        // always outrank minors, same as winner determination above -
        // there's no rules text covering a mixed round's own ordering
        // beyond "who wins," so this is the natural, consistent
        // extension of that same comparison to everyone, not just the
        // winner). Ties (only possible among minors of different suits,
        // since every major uid is unique) break toward the lower player
        // number, matching the same deterministic fallback already used
        // for a tied WINNING rank just below.
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

        // Tied - "set aside the bidding cards and then every player must
        // bid again, repeated until one player wins the bid." Every
        // player re-bids, not just the tied ones. This can only fail to
        // converge if someone's hand is now empty (nothing left to bid) -
        // the rules don't cover that case explicitly, but the intended
        // resolution is that nobody wins: every player has failed to
        // outbid the others, so the game simply ends with no winner
        // (#68). "bid" moves skip move()'s own generic nextPlayer()/
        // checkEOG() tail (see its own docs on why), so checkEOG() is
        // called directly here - the only place that happens for this
        // path - to push the standard {type:"eog"}/{type:"winners"}
        // results the same way every other win/loss condition does.
        if (this.hands.some(h => h.length === 0)) {
            this.gameover = true;
            this.winner = [];
            this.checkEOG();
            return;
        }
        this.currplayer = 1;
    }

    // "The player to the right of the winner draws... as does each
    // player in turn counterclockwise around the table" - under
    // "tournament rules" there's no physical seating to hang "left"/
    // "right" off of, so "clockwise" is reinterpreted as turnOrder
    // itself (the rank order of what everyone bid - see its own docs),
    // and "counterclockwise" as its exact reverse, ending at the winner.
    private beginRedraw(): void {
        // Announce the now-finalized order once, regardless of which of
        // resolveBidRound()'s two call sites got us here (a clean single
        // winner, or the "someone's hand ran dry mid-tie" fallback).
        this.results.push({ type: "announce", payload: [...this.turnOrder!] });
        // redrawOrder's own getter already computes turnOrder's reversal -
        // turnOrder[0] is the bid winner by construction, so redrawOrder[0]
        // is always the worst bidder, for every player count. Jump there
        // directly instead of routing through nextPlayer() - no forced
        // "pass" is needed for the 2-player case now that we don't rely on
        // ordinary rotation to (sometimes) land on the winner first.
        this.phase = "redraw";
        this.currplayer = this.redrawOrder[0];
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
    // show the pick accumulating - but advancing currplayer/phase is the
    // consequential part move()'s live-preview calls must never trigger
    // for real.
    // Legality (count matches what's needed, no duplicates, every uid
    // actually in the pool) is validateRedraw's own job, not this one's.
    private cmdRedraw(args: string[], partial = false): void {
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

        // redrawPos's own getter reads the last REAL commit (this.stack's
        // top), which doesn't include this move yet - saveState() only
        // pushes it once move() has fully returned (see move()'s own
        // tail) - so this player's own just-applied redraw needs +1 here.
        const donePos = this.redrawPos + 1;
        if (donePos < this.numplayers) {
            if (this.numplayers === 2) {
                // Ordinary rotation, not a direct jump (see beginRedraw's
                // own docs on why that matters) - with exactly two
                // players "whoever's next" is unconditionally "the other
                // one," so this can never disagree with the required
                // redraw order the way an arbitrary array-indexed jump
                // could for 3+ players.
                this.nextPlayer();
            } else {
                this.currplayer = this.redrawOrder[donePos];
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
            // Nothing left to hide or replay once "bidding" is over for
            // good - clear both so they stop appearing in every subsequent
            // turn's state for the rest of the game (see IMoveState's own
            // docs on why these fields are optional at all). biddingPool
            // is already empty by this point regardless (see above) -
            // this just drops the now-permanently-spent `[]` too.
            this.bidPositions = undefined;
            this.biddingPool = undefined;
            if (this.numplayers !== 2) {
                this.currplayer = this.bidWinner!;
            }
        }
    }

    private validateRedraw(parsed: IParsedMove): IValidationResult {
        const uids = parsed.rest;
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

    // "pass" is only used for an eliminated player sitting out the game.
    // Ususally handled by the server with the "autopass" flag. Legality
    // (currplayer is actually eliminated) is validatePass's own job, not
    // this one's.
    private cmdPass(partial = false): void {
        if (partial) {
            return;
        }
        this.results.push({ type: "pass", who: this.currplayer, why: "eliminated" });
        this.nextPlayer();
        this.checkEOG();
    }

    // The "autopass" flag's own signal (see gameinfo's own flags): a real
    // server calls this after every move resolves and, if it returns
    // exactly ["pass"], auto-submits "pass" on that player's behalf rather
    // than waiting for real input - see validatePass()'s own docs for the
    // one situation that actually triggers here. This is deliberately NOT
    // a general move enumerator (that's what the "no-moves"/
    // "custom-randomization" flags + randomMove() are for) - every other
    // situation returns [] ("not enumerating, but nothing is forced"),
    // matching this library's own established convention (see e.g.
    // knightline.ts's identical use of "autopass" + moves()).
    public moves(player?: playerid): string[] {
        const p = (player ?? this.currplayer) as playerid;
        if (this.eliminated.indexOf(p) > -1) {
            return ["pass"];
        } else
            return [];
    }

    // "place <cell> <orientation> [<correction>]" - only legal with zero
    // pieces on board. A real facing is always required (no default here
    // - see validatePlace's own docs); the optional 3rd token, when
    // present, is what actually wins - the exact same mandatory-facing-
    // plus-optional-trailing-correction shape Cups "own" uses for its own
    // new piece (see resolveTrailingOrientation's own docs). A trusted
    // caller omitting the mandatory token has a bug of its own, not
    // something this function needs to guard against, same as every other
    // legality check that stays validatePlace's job.
    private cmdPlace(args: string[]): void {
        const [cellStr, orientationToken, correctionStr] = args;
        // A trailing "?" (still-prepopulated, not yet a deliberate choice
        // - see validatePlace's own docs) makes no difference to the
        // actual piece created; strip it the same way here.
        const orientationStr = orientationToken?.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
        const orientation = this.parseOrientation(correctionStr ?? orientationStr);
        const [x, y] = GnosticaBoard.algebraic2coords(cellStr);
        let territory = this.board.get(x, y);
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

    private validatePlace(parsed: IParsedMove): IValidationResult {
        const [cellStr, orientationToken, correctionStr] = parsed.rest;
        if (cellStr === undefined) {
            return this.invalid("apgames:validation.gnostica.PLACE_CELL_REQUIRED");
        }
        const coords = this.tryAlgebraic2coords(cellStr);
        if (coords === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr });
        }
        const [x, y] = coords;
        if (this.board.classify(x, y) === "void") {
            return this.invalid("apgames:validation.gnostica.PLACE_VOID", { cell: cellStr });
        }
        const contents = this.board.get(x, y);
        if (contents !== undefined && contents.pieces.length > 0) {
            return this.invalid("apgames:validation.gnostica.PLACE_OCCUPIED", { cell: cellStr });
        }
        // A default orientation is provided in the click flow,
        // but may be missing from a hand-typed move.
        if (orientationToken === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PLACE_DIRECTION_REQUIRED") };
        }
        // A trailing "?" marks the click flow's own seeded default as not
        // yet a deliberate choice - genuinely complete:0 (submittable,
        // but still soft), computed here directly rather than via
        // provisionalResult's blanket click-result downgrade, so a
        // hand-typed "place l0 U" (never carries "?") is correctly
        // complete:1, the deliberate choice it is. Meaningless once a
        // correction is also present (the correction is itself always a
        // deliberate act, see resolveTrailingOrientation's own docs) -
        // and dropped entirely from the real, persisted move string the
        // instant a turn is actually committed (see move()'s own docs).
        const prepopulated = orientationToken.endsWith("?") && correctionStr === undefined;
        const orientationStr = orientationToken.endsWith("?") ? orientationToken.slice(0, -1) : orientationToken;
        const resolved = this.resolveTrailingOrientation(orientationStr, correctionStr);
        if ("key" in resolved) {
            return this.invalid(`apgames:validation.gnostica.${resolved.key}`, resolved.params);
        }
        return { valid: true, complete: prepopulated ? 0 : 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // "orient <pieceRef> <facing>" - only your own piece. Legality (args
    // present, piece actually yours) is validateOrient's own job, not
    // this one's.
    private cmdOrient(args: string[]): void {
        const [ref, orientationStr] = args;
        // Still building - a bare cell (2+ own pieces there, none picked
        // yet - see validateOrient's own matching tolerance) or a missing
        // orientation isn't resolvable yet; a trusted partial preview can
        // legitimately be here mid-build, so just no-op.
        if (!ref.includes(".") || orientationStr === undefined) {
            return;
        }
        const { x, y, index } = this.resolvePieceRefOrThrow(ref);
        this.addBufferIfWasteland(x, y);
        const orientation = this.parseOrientation(orientationStr);
        // Reorienting one of your own minions, with no adjacency
        // restriction, is exactly what orientMinion already is - reuse it
        // rather than mutating .orientation inline, the same primitive
        // the Empress/Emperor/Tower/Star's own first step goes through.
        orientMinion(this.buildPowerContext(), x, y, index, orientation);
        this.pushOrientResult(x, y, index, ref, orientation);
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

    private validateOrient(parsed: IParsedMove): IValidationResult {
        const [ref, orientationStr] = parsed.rest;
        if (ref === undefined) {
            return this.invalid("apgames:validation.gnostica.ORIENT_ARGS_REQUIRED");
        }
        // A bare cell (no ".") with 2+ of the player's own distinguishable
        // pieces there means the acting minion hasn't been picked yet -
        // see computeActionButtons'/handleClickCore's own "orientpick_"
        // docs - still building, not a hard error, the same tolerance
        // every other minion-selection context already gets.
        if (!ref.includes(".")) {
            const coords = this.tryAlgebraic2coords(ref);
            if (coords !== undefined && this.resolveStepMinion(undefined, this.eligibleMinionsForOrient(coords[0], coords[1])).ambiguous) {
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
        // The minion itself is chosen; its new facing is a genuinely
        // separate decision that only the player's own click may make -
        // never auto-assigned (see cmdOrient's/handleClickCore's own
        // docs) - so this is still building, not an error.
        if (orientationStr === undefined) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PICK_DIRECTION_TO_ORIENT") };
        }
        const orientation = this.tryParseOrientation(orientationStr);
        if (orientation === undefined) {
            return this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr });
        }
        // Same "meaningful action" principle as #49: a no-op reorientation
        // (the piece already faces this way) achieves nothing and should
        // never be the player's actual final move. Still a soft
        // complete:-1 rather than a hard invalid() here, matching #49's
        // own POWER_STEP_REQUIRED shape: valid, but not yet a real
        // answer, so randomMove()/an actual auto-submit can never land on
        // this as the FINAL move, while normal click navigation
        // still works.
        if (orientation === piece.orientation) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.ORIENT_NO_OP") };
        }
        // The player can always click a different neighbour to reconsider
        // - matches Magnate's own "a turn is never complete, only
        // submissible" rule: genuinely complete:0, not 1, computed
        // directly here rather than guessed at click time, the same
        // whether this exact string was clicked-and-confirmed or
        // hand-typed.
        return { valid: true, complete: 0, message: i18next.t("apgames:validation._general.VALID_MOVE") };
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
    // Legality (every named uid actually in hand, the draw count within
    // range) is validateDiscard's own job, not this one's.
    private cmdDiscard(args: string[], partial = false): void {
        const hand = this.hands[this.currplayer - 1];
        const drawIdx = args.indexOf("draw");
        const discardUids = drawIdx === -1 ? args : args.slice(0, drawIdx);
        for (const uid of discardUids) {
            const idx = hand.indexOf(uid);
            hand.splice(idx, 1);
            this.discardPile.push(uid);
            this.discarded.push(uid);
        }
        if (discardUids.length > 0) {
            this.results.push({ type: "place", how: "discard", what: this.discarded.join(",") });
        }
        if (partial) {
            return;
        }
        const maxDraw = Math.max(0, 6 - hand.length);
        let count = maxDraw;
        if (drawIdx !== -1) {
            const countStr = args[drawIdx + 1];
            count = countStr === undefined ? NaN : Number(countStr);
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
        this.cardsDrawn[this.currplayer - 1] = drawnCount;
    }

    // Mirrors cmdDiscard's own "discard [uid...] [draw <n>]" grammar and
    // logic, non-mutating. Every named discard uid is checked up front,
    // including rejecting the same uid named twice - cmdDiscard's own loop
    // mutates the hand as it goes, so a repeated uid already fails there
    // (found once, then genuinely gone from hand on the second lookup);
    // this reproduces that without actually mutating anything.
    private validateDiscard(parsed: IParsedMove): IValidationResult {
        const tokens = parsed.rest;
        const hand = this.hands[this.currplayer - 1];
        const drawIdx = tokens.indexOf("draw");
        const discardUids = drawIdx === -1 ? tokens : tokens.slice(0, drawIdx);
        const seen = new Set<string>();
        for (const uid of discardUids) {
            if (seen.has(uid)) {
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "DUPLICATE_CARD" });
            }
            seen.add(uid);
            if (!hand.includes(uid)) {
                return this.invalid("apgames:validation.gnostica.NOT_IN_HAND", { uid });
            }
        }
        // A missing "draw <n>" is still perfectly legal to submit as-is
        // (cmdDiscard defaults it to the max at commit time), but the
        // move string itself hasn't recorded an explicit draw decision -
        // same "undecided default" principle as place's own missing
        // facing (see its own docs), just soft (complete:0, still
        // submittable) rather than hard, since discard's own grammar
        // genuinely allows omitting it. Applies uniformly - hand-typed or
        // click-built alike - since it's a fact about the string, not
        // about how it was produced.
        if (drawIdx === -1) {
            return { valid: true, complete: 0, message: i18next.t("apgames:validation.gnostica.DISCARD_CARDS_OPTIONAL") };
        }
        const maxDraw = Math.max(0, 6 - (hand.length - discardUids.length));
        const countStr = tokens[drawIdx + 1];
        const count = countStr === undefined ? NaN : Number(countStr);
        if (!Number.isInteger(count) || count < 0 || count > maxDraw) {
            return this.invalid("apgames:validation.gnostica.BAD_DRAW_COUNT", { requested: countStr, max: maxDraw });
        }
        return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
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

    // A card's own display name for a message, falling back to its bare
    // uid on the rare "not a real/known card" edge (never actually hit in
    // practice - every caller already has a resolved card in hand - but
    // keeps a message-building call site from needing its own `?? uid`).
    // Shared by every place a message names "the card" (powerStepMessageKey,
    // validateFrameStack's own skipped/CHOOSE_STEP/PENDING_POWER_CHOICE
    // branches, validateResumePendingPower).
    private cardNameOrUid(uid: string): string {
        return allCards().find(c => c.uid === uid)?.name ?? uid;
    }

    // "Activate a card on the board. All your pieces on that card are
    // minions [...]"
    // Every piece the acting player owns on the activated cell - the pool
    // "activate" draws minions from. Returns [] (rather than throwing) for a
    // cell with no card / no eligible piece, so click-time helpers can use
    // this directly without their own duplicate error handling.
    // The acting player's own pieces sitting at one cell - shared by
    // eligibleMinionsForActivate ("use" additionally requires a card
    // there) and eligibleMinionsForOrient (no card requirement at all).
    private piecesOwnedAt(x: number, y: number): IMinionRef[] {
        const t = this.board.get(x, y);
        if (t === undefined) {
            return [];
        }
        return t.pieces
            .map((p, index) => ({ x, y, index }))
            .filter(ref => t.pieces[ref.index].owner === this.currplayer);
    }

    public eligibleMinionsForActivate(x: number, y: number): IMinionRef[] {
        const t = this.board.get(x, y);
        if (t === undefined || t.card === undefined) {
            return [];
        }
        return this.piecesOwnedAt(x, y);
    }

    // The acting player's own pieces at one cell, for the standalone
    // "orient" command - same shape as eligibleMinionsForActivate's own
    // single-cell pool (a board click always names one cell directly, so
    // there's no "play"-style cross-cell narrowing to do), just without
    // the card requirement - you can orient a minion standing on a bare
    // wasteland cell too.
    private eligibleMinionsForOrient(x: number, y: number): IMinionRef[] {
        return this.piecesOwnedAt(x, y);
    }

    // Every piece the acting player owns anywhere on the board - the pool
    // "play" draws minions from.
    public eligibleMinionsForPlay(): IMinionRef[] {
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

    // Only ever reached for a FRESH activation - move()'s own dispatch
    // resumes this.continued directly instead, before this switch is
    // ever reached, whenever it's genuinely open (see its own docs) -
    // regardless of which verb the move string happens to spell, since
    // there's no dedicated "resume" head anymore (see parseMove's own
    // "(via <uid>)" docs).
    // Legality (uid given, a real card, on the board, with an eligible
    // minion there) is validateActivate's own job, not this one's.
    private cmdActivate(cardUid: string, stepSegments: string[][], partial: boolean, borrowedPower?: string): IPowerFrame[] | undefined {
        const { x, y } = this.findCardCell(cardUid)!;
        const t = this.board.get(x, y)!;
        const eligible = this.eligibleMinionsForActivate(x, y);
        this.results.push({ type: "use", what: t.card!.uid });
        return this.applyCardPower(t.card!, eligible, stepSegments, partial, borrowedPower);
    }

    private validateActivate(parsed: IParsedMove): IValidationResult {
        const cardUid = parsed.rest[0];
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
        return this.validateCardPower(t.card!, eligible, parsed.stepSegments, parsed.asUid);
    }

    // "Play a card from your hand to the discard pile. All your pieces on
    // the board are minions [...]"
    // Same "fresh activation only" note as cmdActivate's own docs.
    // Legality (uid given, in hand, a real card) is validatePlay's own
    // job, not this one's.
    private cmdPlay(uid: string, stepSegments: string[][], partial: boolean, borrowedPower?: string): IPowerFrame[] | undefined {
        const hand = this.hands[this.currplayer - 1];
        const handIdx = hand.indexOf(uid);
        const card = allCards().find(c => c.uid === uid)!;
        hand.splice(handIdx, 1);
        this.discardPile.push(uid);
        this.discarded.push(uid);
        this.results.push({ type: "deckDraw", what: uid, from: "hand" });

        const eligible = this.eligibleMinionsForPlay();
        return this.applyCardPower(card, eligible, stepSegments, partial, borrowedPower);
    }


    private validatePlay(parsed: IParsedMove): IValidationResult {
        const uid = parsed.rest[0];
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
        // Playing the Fool discards its own physical card FIRST (cmdPlay's
        // own docs), which would otherwise let its own first flip
        // trivially "succeed" by finding nothing to reveal but itself -
        // if there's genuinely nothing else anywhere in the game, that's
        // an unbounded self-reveal loop, not a legitimate use of the
        // card. Checked HERE, on the REAL pre-play state, rather than
        // relying on checkFool's own generic emptiness check further down
        // the line - by the time that runs, the discard-push simulation
        // just below would already make the pile look non-empty. This is
        // a validate-only guard, deliberately not mirrored in cmdPlay
        // itself - a trusted caller is expected to have validated first,
        // same as every other legality check in this file.
        if (uid === "00" && this.drawPile.length === 0 && this.discardPile.length === 0) {
            return this.invalid("apgames:validation.gnostica.DRAW_PILE_EMPTY");
        }
        const eligible = this.eligibleMinionsForPlay();
        // cmdPlay removes the card from hand AND pushes it to discard
        // BEFORE resolving its power (see its own docs) - a power that
        // reads hand SIZE (High Priestess's own draw-count bound,
        // Judgement's pip-count cap) or discard pile CONTENTS (Judgement
        // drawing the very card that was just played, itself included)
        // needs to see that same, already-updated state here too, or it
        // would validate against a stale precondition (the eligible pool
        // above is unaffected - eligibleMinionsForPlay only reads board
        // state, never hand/discard contents). Mirrors both for the
        // DURATION of this validation call only, always restored via
        // finally.
        hand.splice(handIdx, 1);
        this.discardPile.push(uid);
        try {
            return this.validateCardPower(card, eligible, parsed.stepSegments, parsed.asUid);
        } finally {
            hand.splice(handIdx, 0, uid);
            this.discardPile.pop();
        }
    }

    // Returns walkFrameStack's residual stack for move() to persist (see
    // its docs), or undefined for a minor card - which is always a single
    // step and never pauses, so it leaves this.continued alone.
    private applyCardPower(card: Card, eligible: IMinionRef[], stepSegments: string[][], partial: boolean, borrowedPower?: string): IPowerFrame[] | undefined {
        if (card.major) {
            const def = getMajorArcanaDef(card);
            return this.applyMajorPower(def, eligible, stepSegments, partial, borrowedPower);
        }
        this.applyMinorPower(card.suit.uid, eligible, stepSegments);
        return undefined;
    }

    private validateCardPower(card: Card, eligible: IMinionRef[], stepSegments: string[][], borrowedPower?: string): IValidationResult {
        if (card.major) {
            const def = getMajorArcanaDef(card);
            return this.validateMajorPower(def, eligible, stepSegments, borrowedPower);
        }
        return this.validateMinorPower(card.suit.uid, eligible, stepSegments);
    }

    // Tolerant of an incomplete step (mode chosen but not enough trailing
    // args yet, or no mode at all) rather than rejecting - treated as still
    // effectively "declined so far", same trick Magnate's own move parser
    // uses to let the click flow build a move up incrementally across
    // several clicks, each producing a fully-parseable (if still
    // provisional) move string. Legality beyond that (single step, minion
    // ref present, well-formed step shape) is validateMinorPower's own
    // job, not this one's. See MINOR_MODES for minArgs.
    private applyMinorPower(suitUid: string, eligible: IMinionRef[], stepSegments: string[][]): void {
        if (stepSegments.length === 0) {
            // #49 blocks this at the validate layer (untrusted submissions
            // never reach apply with zero steps); a trusted/partial caller
            // can still legitimately be here mid-build, so just no-op.
            return;
        }
        const [minionRef, ...rest] = stepSegments[0];
        if (this.isMinionCellStillNarrowing(minionRef, eligible)) {
            return; // cell chosen, which minion there is still undecided - still declined
        }
        const minion = this.resolvePieceRefOrThrow(minionRef, eligible, "NOT_AN_ELIGIBLE_MINION");
        // Same shared shape check applyPowerStep uses for a major card's
        // own primitive step (see stepShapes.ts's own docs) - a minor
        // card's power is that same grammar, just never chained.
        const shape = primitiveStepShape(suitUid, rest);
        if (shape.status === "incomplete") {
            return; // still declined so far
        }
        const [mode, ...args] = rest;
        this.applySuitPrimitive(suitUid, minion, mode, args, {});
    }

    // Mirrors applyMinorPower's own tolerance exactly (declining, and an
    // incomplete-so-far step, both still validate as "fine, nothing to
    // report yet") - see its docs.
    public validateMinorPower(suitUid: string, eligible: IMinionRef[], stepSegments: string[][]): IValidationResult {
        if (stepSegments.length === 0) {
            // #49: a use/play must take its one meaningful step, not just
            // decline it outright - a deliberate break from the literal
            // "all powers are optional" rules text (that's about not
            // being forced through EVERY power a multi-power card grants,
            // not license to activate/play and do nothing at all). Still
            // valid, still "in progress" (complete: -1), not an error -
            // the player just isn't done yet. Giving up a card's power
            // stays available via "discard <uid> draw 0" instead.
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED") };
        }
        if (stepSegments.length > 1) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "MINOR_ONE_STEP_ONLY" });
        }
        const [minionRef, ...rest] = stepSegments[0];
        if (minionRef === undefined) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" });
        }
        // Same #49 principle as the stepSegments.length===0 case above: a
        // cell chosen but not which minion is ALSO genuinely still
        // incomplete - a bare `undefined` here would read as "no
        // objection" to validateMove()'s own tail, defaulting to
        // complete:1/valid, a false "looks like a valid move".
        if (this.isMinionCellStillNarrowing(minionRef, eligible)) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED") };
        }
        const result = this.resolvePieceRef(minionRef, eligible);
        if (result.kind !== "ok") {
            return this.invalidPieceRef(result.kind, minionRef, "NOT_AN_ELIGIBLE_MINION");
        }
        const minion = result.ref;
        // Same shared shape check applyMinorPower/applyPowerStep use (see
        // stepShapes.ts's own docs).
        const shape = primitiveStepShape(suitUid, rest);
        if (shape.status === "incomplete") {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED") };
        }
        if (shape.status === "malformed") {
            return this.invalid(`apgames:validation.gnostica.${shape.key}`, shape.params);
        }
        const [mode, ...args] = rest;
        const stepResult = this.validateSuitPrimitive(suitUid, minion, mode, args, {});
        return stepResult.failed ? stepResult.result : { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // Whether `cardUid` names a real major arcana card or a minor arcana
    // card Fool flipped - either way, returns something shaped like a
    // MajorArcanaDef so applyPowerStep/validatePowerStep/
    // computeShortcutOpts never need a second, minor-flavored code path.
    // A flipped minor's synthesized def is a one-step stand-in for
    // whichever primitive its suit corresponds to - applyMinorPower
    // already dispatches through the exact same applySuitPrimitive call
    // applyPowerStep's own "primitive" branch uses, so nothing else needs
    // to change to support it.
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

    // Pops the top frame off `stack` (mutates in place) - the ONE place
    // every decline/exhaustion site in this file removes a frame, rather
    // than a raw `stack.pop()`, specifically so this can also carry the
    // popped frame's own CURRENT acting piece (its own `minions` last
    // entry - see IStepOutcome.newMinion's "become a minion" docs) down
    // into whatever frame is newly exposed beneath it. A buried parent
    // frame (Fool, or World targeting something) is otherwise frozen at
    // wherever the piece stood when THAT frame was first pushed - the
    // instant a child frame sitting on top of it relocates the very same
    // physical piece (Rods' own "move" mode, say) and then pops, the
    // parent's own copy goes stale. If that parent later pushes yet
    // another child of its own (Fool's second flip is the common case),
    // it would hand the new child a position with no piece on it at all -
    // the first thing that tries to actually read a piece there
    // (pieceRefStr, minorTargetCell, ...) crashes. Safe to simply
    // overwrite rather than merge: by the time a child frame sits on top
    // of a parent at all, the parent's own triggering step has already
    // fully resolved (pushing a frame is itself that step's own outcome),
    // so there's no live ambiguity left in the parent's own `minions` for
    // this to clobber - the only thing it's still good for is exactly
    // this handoff.
    // Applies a step's own outcome.newMinion chaining (see IStepOutcome's
    // own docs) to `minions`: appends newMinion, first removing whichever
    // existing entry (by x,y,index - see replacesMinion's own docs)
    // it supersedes, if any. A no-op (returns `minions` unchanged) when
    // the outcome didn't produce a chainable minion at all. This is the
    // ONE place `minions` ever grows, shared by every call site that used
    // to append `outcome.newMinion` directly (walkFrameStack,
    // validateFrameStack, randomMove's own simulator) - so a relocated
    // piece's stale, pre-move ref is pruned right where it would
    // otherwise be introduced, rather than lingering to confuse a LATER
    // reader (resolveStepMinion's own ambiguity check, pieceRefStr,
    // specialStepHasNoLegalTarget) into treating a cell with nothing
    // standing on it anymore as a second, still-live candidate.
    private static chainMinion(minions: IMinionRef[], outcome: IStepOutcome): IMinionRef[] {
        if (outcome.newMinion === undefined) {
            return minions;
        }
        const stale = outcome.replacesMinion;
        const base = stale === undefined
            ? minions
            : minions.filter(m => !(m.x === stale.x && m.y === stale.y && m.index === stale.index));
        return [...base, outcome.newMinion];
    }

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

    // Pops fully-exhausted frames off the top of `stack` - shared cleanup
    // after every step, since a push (World's target, Fool's flip) always
    // lands a fresh frame at nextStepIndex 0, and a card with only one
    // power (World itself) needs to disappear again immediately rather
    // than sit around already-exhausted. Each pop goes through popFrame
    // (not a raw `stack.pop()`) so a relocated acting piece's own current
    // position survives the cascade - see its own docs.
    private static popExhaustedFrames(target: GnosticaGame, stack: IPowerFrame[]): void {
        while (stack.length > 0 && stack[stack.length - 1].nextStepIndex >= target.resolveFrameDef(stack[stack.length - 1].cardUid).powers.length) {
            GnosticaGame.popFrame(stack);
        }
    }

    // The engine's one core stack-walker, shared by a fresh use/play
    // activation (applyMajorPower, called with a new single-frame stack)
    // and a resume submission (resumePendingPower, called with the
    // persisted pendingPower.stack) - both reduce to "keep consuming
    // segments against whatever's on top of the stack until segments run
    // out or a step forces a pause". Mutates `stack` in place and sets/
    // clears this.continued as a side effect; the caller never needs
    // its own copy of the resulting stack.
    //
    // Two ways this can end:
    // - A step's outcome sets forcePause (Fool's flip, always; High
    //   Priestess's first-of-two step) - pauses immediately, ignoring any
    //   further segments the caller might have supplied (validateMajorPower/
    //   validateFrameStack reject those as malformed before apply is ever
    //   reached for a real, untrusted client).
    // - Segments run out with no forcePause. Whatever the CURRENT (top)
    //   frame had left of its own power is implicitly declined (popped) -
    //   exactly like a plain single-frame chain already works today. If
    //   that pop empties the stack, the whole activation is done and the
    //   turn advances normally. If it exposes an outer frame, that frame's
    //   own next step is either Fool's (see below - auto-resolves right
    //   here, in the SAME call, never reaching this exit at all) or
    //   something else that genuinely needs input the caller didn't
    //   supply, which stays pending exactly like any other pushed frame's
    //   own untaken step.
    //
    // Fool's own step is unconditionally auto-taken the moment it's next
    // in line - flipping is the ONLY possible action for it (unlike every
    // other special, even High Priestess, which genuinely lets the player
    // choose), so there is nothing to decide and nothing to decline: it
    // consumes no segment, and - since every flip force-pauses to reveal
    // what came up - it always returns from inside this loop, never
    // falling through to the "implicitly declined" exit below. This is what makes declining a revealed
    // card's own power (a real, genuine choice) and Fool drawing its
    // next card (never a choice) compose into ONE submission: the
    // decline consumes its own given segment and pops that frame, then
    // the loop immediately re-checks the newly-exposed top - if that's
    // Fool's own remaining flip, it fires right then, in the same call.
    // The only place this.continued is written - called once by move(),
    // past the partial boundary, with the residual frame stack
    // walkFrameStack handed back. Distils it down to the entries that
    // still owe a step.
    private persistContinued(stack: readonly IPowerFrame[]): void {
        // Only the genuine cross-submission obligations: a Fool or High
        // Priestess frame that has already taken at least one of its own
        // steps (nextStepIndex >= 1) and so owes a follow-up submission -
        // "00.1"/"00.2" (Fool owes its second flip, or has flipped twice
        // and its last reveal still awaits a decision) or "02.1" (High
        // Priestess owes round 2). Everything else on the stack (the
        // spent World frame, an as-yet-unresolved revealed card, a
        // revealed Fool/HP that hasn't started its own steps) is NOT
        // persisted - the resume submission names the revealed card
        // itself, and its identity is otherwise the discard pile's top
        // (fool() puts it there). See this.continued's own docs.
        this.continued = stack
            .filter(f => (f.cardUid === "00" || f.cardUid === "02") && f.nextStepIndex >= 1)
            .map(f => `${f.cardUid}.${f.nextStepIndex}`);
    }

    // Rebuilds the throwaway IPendingMajorPower-shaped view the resume
    // machinery expects, from the minimal persisted this.continued
    // (Fool/High-Priestess obligation tokens only - see its own docs).
    // One frame per token; minions are recomputed fresh
    // (eligibleMinionsForPlay() - see this.continued's own docs on why a
    // frozen pool is never needed). When the innermost obligation is a
    // Fool ("00.x"), its last flip left an ordinary card revealed and
    // awaiting a decision - not persisted, but sitting on top of the
    // discard pile (fool() puts it there) - so a fresh viaFool frame for
    // that card is pushed on top. High Priestess's own "02.1" step IS the
    // pending action, so it needs no such extra frame.
    private buildPendingFromContinued(): IPendingMajorPower | undefined {
        if (this.continued.length === 0) {
            return undefined;
        }
        const pool = this.eligibleMinionsForPlay();
        // Every non-outermost obligation got where it is via a Fool reveal
        // (the Fool is the only continuing card that nests one on top of
        // another), so it stays declinable.
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

    // Returns the residual frame stack (what this seat still owes) for
    // move() to serialize into this.continued past the partial boundary,
    // or undefined when nothing should be persisted (a partial preview, or
    // an incomplete step - see the individual exits).
    private walkFrameStack(stack: IPowerFrame[], stepSegments: string[][], partial: boolean, borrowedPower?: string): IPowerFrame[] | undefined {
        // "as <x>" - the card The World borrows (a card uid) or the suit
        // The Magician runs (a suit letter). Consumed by whichever meta-
        // step it belongs to, then cleared: a World that borrows the
        // Magician still reads the Magician's own suit letter from a
        // segment token.
        let borrowed = borrowedPower;
        const worldBorrow = borrowed !== undefined && !ALL_SUITS.some(s => s.uid === borrowed);
        const chained = stepSegments.length + (worldBorrow ? 1 : 0) > 1;
        let i = 0;
        let stepsProcessed = 0;
        for (;;) {
            const top = stack[stack.length - 1];
            if (top === undefined) {
                // Extra segments once the stack is already empty are
                // validateFrameStack's own job to reject, not this one's.
                break;
            }
            const frameDef = this.resolveFrameDef(top.cardUid);
            const step = frameDef.powers[top.nextStepIndex];
            const isFoolStep = "special" in step && step.special === "fool";
            const isWorldStep = "special" in step && step.special === "worldUseAny";
            let tokens: string[];
            if (isWorldStep) {
                // The borrowed card is named up front ("as <uid>"), never
                // as a segment - so this step consumes nothing.
                tokens = [];
            } else if (isFoolStep) {
                if (partial) {
                    // Nothing genuinely happens under a partial preview
                    // (see applyPowerStep's own fool-branch docs) - not
                    // even nextStepIndex should advance, or popExhaustedFrames
                    // right below would wrongly treat Fool's OWN frame as
                    // spent and pop it, as if the whole activation had
                    // resolved (it hasn't - a real commit would push a
                    // newly revealed card's own frame on top instead,
                    // keeping this one buried).
                    return undefined;
                }
                // The flip consumes no segment - it's the only possible
                // action for this step, so there is nothing to type.
                tokens = [];
            } else {
                if (i >= stepSegments.length) {
                    // Segments exhausted: implicitly decline whatever's left
                    // of the CURRENT (top) frame - same pop + cascade as an
                    // explicit "decline" token just below, so a mandatory
                    // Fool flip exposed this way (e.g. tradeHands silently
                    // skipped because no enemy target exists at all) still
                    // fires in this SAME submission, instead of being left
                    // as a separate, unprompted resume the player has no
                    // button for (see powerStepMessageKey's own docs - Fool's
                    // second flip is only ever supposed to reach that
                    // dedicated isFoolStep branch above, never sit here
                    // waiting on a resume the bar never actually offers a
                    // button for).
                    GnosticaGame.popFrame(stack);
                    GnosticaGame.popExhaustedFrames(this, stack);
                    continue;
                }
                tokens = stepSegments[i];
                i++;
                if (tokens.length === 1 && tokens[0].toLowerCase() === "decline") {
                    GnosticaGame.popFrame(stack);
                    // Popping can expose an ALREADY-exhausted frame directly
                    // beneath (a parent whose own single step already ran, but
                    // whose push left it buried under the very frame just
                    // declined - e.g. World's own 1-step frame, still sitting
                    // under whatever it pushed) - cascade the same as every
                    // other pop site, rather than leaving it stranded.
                    GnosticaGame.popExhaustedFrames(this, stack);
                    continue; // no result to group/snapshot for a pure decline
                }
                if ("special" in step && step.special === "magicianChoice" && borrowed !== undefined) {
                    // "as <suit>" splices back in as the suit-letter token
                    // applyMagicianChoice/SPECIAL_STEP_SHAPES still expect.
                    tokens = [tokens[0], borrowed, ...tokens.slice(1)];
                    borrowed = undefined;
                }
            }
            // Snapshot BEFORE every step except the first processed one
            // this call (there's no way to know in advance whether an
            // auto-resolved Fool step will follow a given one), so undo/
            // redo can still stop at any intermediate point. Taken before
            // knowing whether this step will actually complete, since
            // applyPowerStep is a guaranteed no-op when it returns
            // undefined (its own shape check, in stepShapes.ts, runs
            // before any mutation for every branch that can return
            // undefined at all - see IStepOutcome's own docs) - discarded
            // below if that turns out to be the case, rather than leaving
            // a spurious undo point behind.
            if (stepsProcessed > 0) {
                this.frames.push({
                    board: this.board.clone().store,
                    discardSummary: this.summarizeDiscardPile(this.discardPile),
                });
            }
            const resultsBefore = this.results.length;
            const outcome = this.applyPowerStep(step, top.minions, tokens, frameDef, top.nextStepIndex, frameDef.powers.length, partial, isWorldStep ? borrowed : undefined);
            if (isWorldStep) {
                borrowed = undefined;
            }
            if (outcome === undefined) {
                // A still-being-typed segment (minion earmarked but no
                // mode yet, mode chosen but args incomplete, magicianChoice's
                // suit without a mode yet, etc.) - stop here WITHOUT
                // advancing nextStepIndex. `undefined` here means only
                // this now, never "done, nothing to report" - see
                // IStepOutcome's own docs - so no separate call into
                // validatePowerStep is needed to tell the two apart.
                // Nothing is persisted: a real submission is always
                // complete (validateMove gates the untrusted path; a
                // trusted caller is trusted to have done the same), so
                // this exit only fires under a partial preview.
                if (stepsProcessed > 0) {
                    this.frames.pop();
                }
                return undefined;
            }
            stepsProcessed++;
            top.minions = GnosticaGame.chainMinion(top.minions, outcome);
            top.nextStepIndex++;
            // Wrap this step's own results into one _group entry,
            // mirroring frogger.ts's own precedent.
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
        // Only reachable via the top-of-loop `top === undefined` check now -
        // every other exit (forced pause, a still-being-typed segment, a
        // fool-step partial preview) returns directly, and an exhausted/
        // declined non-fool frame loops back via `continue` above instead
        // of breaking out here. So the stack is already fully resolved by
        // this point (empty) - move() serializes it into this.continued,
        // clearing the obligation.
        return stack;
    }

    // Walks a major arcana card's power-step list from a fresh use/play
    // activation. Tracks the growing minion set ("any of your pieces
    // directly affected by a minion become minions for that turn") and
    // derives the runtime opts each shortcut card needs - see
    // computeShortcutOpts()'s own docs for why that derivation is safe to
    // apply unconditionally rather than requiring genuine same-target
    // detection between steps.
    private applyMajorPower(def: MajorArcanaDef, eligible: IMinionRef[], stepSegments: string[][], partial: boolean, borrowedPower?: string): IPowerFrame[] | undefined {
        const stack: IPowerFrame[] = [{ cardUid: def.uid, nextStepIndex: 0, minions: [...eligible] }];
        return this.walkFrameStack(stack, stepSegments, partial, borrowedPower);
    }

    // True when `stack`'s own top frame's NEXT step is special:"fool" -
    // used only to decide whether a bare, 0-segment seed (the client's
    // own "just show me what's here" preview, before any real step is
    // typed) should be left completely alone (every OTHER special/
    // primitive genuinely needs real input before there's anything to
    // apply) or should be allowed straight into walkFrameStack/
    // validateFrameStack, which auto-resolve Fool's own step unconditionally
    // regardless of segment count - see walkFrameStack's own docs.
    private topStepIsFool(stack: readonly IPowerFrame[]): boolean {
        const top = stack[stack.length - 1];
        if (top === undefined) {
            return false;
        }
        const step = this.resolveFrameDef(top.cardUid).powers[top.nextStepIndex];
        return step !== undefined && "special" in step && step.special === "fool";
    }

    // Like topStepIsFool, but for The World's worldUseAny step - which
    // also auto-resolves from no segment of its own (the borrowed card is
    // named "as <uid>" in the head), so a bare resume seed carrying that
    // "as" should still walk it rather than be left alone.
    private topStepIsWorld(stack: readonly IPowerFrame[]): boolean {
        const top = stack[stack.length - 1];
        if (top === undefined) {
            return false;
        }
        const step = this.resolveFrameDef(top.cardUid).powers[top.nextStepIndex];
        return step !== undefined && "special" in step && step.special === "worldUseAny";
    }

    // Resumes a paused activation - does NOT re-enter applyMajorPower from
    // the root, and (for a "play"-sourced obligation) does NOT repeat
    // cmdPlay's own hand/discard-pile mutation, which already happened
    // before the pause. A resume submission may supply MULTIPLE step
    // segments, not just one - e.g. resuming into a card Fool revealed
    // should let the player supply all of ITS steps in one go if they're
    // already known (nothing about a revealed card's own power is hidden
    // once the reveal has happened) - walkFrameStack handles this
    // uniformly, re-pausing again if anything genuinely optional and
    // still needing real input remains once segments run out.
    //
    // The frame stack a resume submission walks: the persisted Fool/HP
    // obligation(s), plus - for a Fool obligation - a fresh frame for the
    // ordinary card its last flip revealed, re-derived from the discard
    // pile's top (see buildPendingFromContinued). Undefined when nothing
    // is pending.
    private resumeStack(): IPowerFrame[] | undefined {
        const pending = this.buildPendingFromContinued();
        return pending?.stack.map(f => ({ ...f, minions: [...f.minions] }));
    }

    // The step segments the frame-walk should see for a resume submission,
    // derived from the head:
    //  - "decline"  -> a lone ["decline"] segment (the walk pops the top
    //    frame on that token; the head itself carries no segments)
    //  - "discard"  -> the High Priestess round's own tokens, which sit
    //    right after the head like the ordinary discard action's rather
    //    than as a "/"-separated segment - folded back into one segment
    //  - anything else -> the segments as typed
    private resumeStepSegments(parsed: IParsedMove): string[][] {
        if (parsed.head === "decline") {
            return [["decline"]];
        }
        if (parsed.head === "discard" && parsed.viaUid !== undefined) {
            return parsed.rest.length > 0 ? [parsed.rest] : [];
        }
        return parsed.stepSegments;
    }

    private resumePendingPower(stepSegments: string[][], partial: boolean, borrowedPower?: string): IPowerFrame[] | undefined {
        const stack = this.resumeStack();
        if (stack === undefined) {
            return undefined;
        }
        const worldSeed = borrowedPower !== undefined && this.topStepIsWorld(stack);
        if (stepSegments.length === 0 && !this.topStepIsFool(stack) && !worldSeed) {
            // A bare resume seed, no step typed yet - the client always
            // sends this to populate a partial preview before any step is
            // typed (see boardClick()'s own convention). Nothing to
            // process yet. Fool's own step is exempt - it auto-resolves
            // regardless of segment count (see walkFrameStack's own docs),
            // as is a World borrow whose "as <uid>" is already known.
            return undefined;
        }
        return this.walkFrameStack(stack, stepSegments, partial, borrowedPower);
    }

    // Read-only counterpart to walkFrameStack, mirroring its own inline
    // Fool auto-resolution (see walkFrameStack's own docs) - Fool's own
    // step is checked regardless of the given-segment cursor `i`, and
    // (since checkFool never knows what would be revealed) validation
    // always stops the instant it validates a forced-pause step, exactly
    // once, the same way a real apply always returns right there:
    // anything "after" it in the stack is fundamentally unknowable until
    // an actual commit happens - unlike walkFrameStack, this loop has no
    // outer segment-count bound to lean on for that, since Fool consumes
    // none, so the stop has to be explicit here.
    private validateFrameStack(stack: IPowerFrame[], stepSegments: string[][], rootCardUid: string, borrowedPower?: string): IValidationResult {
        let borrowed = borrowedPower;
        let clone: GnosticaGame | undefined;
        let i = 0;
        for (;;) {
            const top = stack[stack.length - 1];
            if (top === undefined) {
                if (i < stepSegments.length) {
                    return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "TOO_MANY_POWER_STEPS" });
                }
                return { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
            }
            const frameDef = this.resolveFrameDef(top.cardUid);
            const stepIndex = top.nextStepIndex;
            const step = frameDef.powers[stepIndex];
            const isFoolStep = "special" in step && step.special === "fool";
            const isWorldStep = "special" in step && step.special === "worldUseAny";
            // Mirrors walkFrameStack's own identical computation - see its
            // docs on why the ROOT's own untouched first flip is the one
            // case that stays a hard rejection.
            const isFreshRootFool = isFoolStep && stack.length === 1 && top.cardUid === rootCardUid && top.nextStepIndex === 0;
            let tokens: string[];
            if (isWorldStep) {
                tokens = []; // the borrowed card is named "as <uid>" in the head
            } else if (isFoolStep) {
                tokens = []; // the flip consumes no segment
            } else {
                if (i >= stepSegments.length) {
                    // Nothing more given - a step past the frame's own
                    // first one (root or pushed alike, once that frame has
                    // begun) stays optional and silently declines, UNLESS
                    // it's provably impossible right now (no legal target
                    // at all - see specialStepHasNoLegalTarget's own docs),
                    // in which case that deserves an explicit heads-up
                    // instead of the generic VALID_MOVE fallback (#63-style
                    // guidance for a doomed step, just surfaced here
                    // instead of at click time - see pickPieceTargetClick's
                    // own tree-pruning docs on the click-time half of this).
                    // Checked against `clone ?? this` (not always `this`) -
                    // a real, prior step in THIS SAME validation may have
                    // only been applied to `clone` (see just below), so
                    // the acting piece's current, real position/orientation
                    // only exists there once one has run.
                    if (this.specialStepHasNoLegalTarget(clone ?? this, step, top.minions)) {
                        const cardName = this.cardNameOrUid(top.cardUid);
                        const key = (step as { special: SpecialPower }).special === "tradeHands"
                            ? "apgames:validation.gnostica.TRADEHANDS_SKIPPED_NO_TARGET"
                            : "apgames:validation.gnostica.HIEROPHANT_SKIPPED_NO_TARGET";
                        return { valid: true, complete: 1, message: i18next.t(key, { card: cardName }) };
                    }
                    // A frame's OWN first step (nextStepIndex still 0) is
                    // different: for anything but the root, arriving here
                    // with literally nothing supplied for it yet is
                    // reachable ONLY via World's own worldUseAny push -
                    // Fool's own push always carries forcePause (see
                    // applyPowerStep's/validatePowerStep's own "fool"
                    // cases), so a Fool-revealed frame can never be pushed
                    // and then found empty within this SAME call; it's
                    // always a separate, later resume instead, already
                    // covered by validateResumePendingPower's own
                    // zero-segment check (top.viaFool below is expected to
                    // always be false/undefined here as a result - checked
                    // explicitly anyway rather than relied on as an
                    // invariant). Naming a target via World has no effect
                    // of its own (unlike Fool's flip, which really does
                    // draw a card) - so completing here with zero steps
                    // taken on it would make the whole move a no-op in
                    // every way that matters, exactly what #49 exists to
                    // forbid for anything but Fool (see validateMajorPower's
                    // own docs on Fool's narrower exemption). Root's own
                    // frame can never reach this with i===0 and no
                    // segments - the caller's own upfront check already
                    // turned that away before this loop ever started.
                    // CHOOSE_STEP, not PENDING_POWER_CHOICE, for a non-Fool
                    // push - IPowerFrame's own `viaFool` docs cover why
                    // Decline isn't on offer here, so the message shouldn't
                    // invite it either.
                    if (stack.length > 1 && top.nextStepIndex === 0) {
                        const cardName = this.cardNameOrUid(top.cardUid);
                        const key = top.viaFool === true ? "apgames:validation.gnostica.PENDING_POWER_CHOICE" : "apgames:validation.gnostica.CHOOSE_STEP";
                        return { valid: true, complete: -1, message: i18next.t(key, { card: cardName }) };
                    }
                    // A genuinely optional further step remains available
                    // (this frame isn't exhausted) - matches Magnate's own
                    // "a turn is never complete, only submissible" rule:
                    // unconditionally complete:0 whenever more could still
                    // be added, the same fact for a click or a hand-typed
                    // move alike, computed directly from the frame's own
                    // state - no marker needed, the same way an outright
                    // incomplete step already needs none (its own missing
                    // tokens already say so).
                    return {
                        valid: true,
                        complete: 0,
                        message: i18next.t("apgames:validation._general.VALID_MOVE"),
                    };
                }
                tokens = stepSegments[i];
                i++;
                if (tokens.length === 1 && tokens[0].toLowerCase() === "decline") {
                    // Only ever the "decline" head, translated to this token
                    // by resumeStepSegments - so it always addresses a
                    // Fool/HP obligation frame, never a World borrow (which
                    // isn't declinable and can't reach here anyway, since a
                    // bare "decline" segment is no longer a valid shape).
                    GnosticaGame.popFrame(stack);
                    // Popping can expose an already-exhausted buried frame
                    // (e.g. World's own spent 1-step frame), which a later
                    // segment (if any) must not be validated against.
                    GnosticaGame.popExhaustedFrames(this, stack);
                    if (i < stepSegments.length) {
                        clone ??= this.cloneLive();
                    }
                    continue;
                }
                if ("special" in step && step.special === "magicianChoice" && borrowed !== undefined) {
                    tokens = [tokens[0], borrowed, ...tokens.slice(1)];
                    borrowed = undefined;
                }
            }
            const borrowedForStep = isWorldStep ? borrowed : undefined;
            if (isWorldStep) {
                borrowed = undefined;
            }
            const stepResult = (clone ?? this).validatePowerStep(step, top.minions, tokens, frameDef, stepIndex, frameDef.powers.length, isFreshRootFool, borrowedForStep);
            if (stepResult.failed) {
                return stepResult.result;
            }
            if (stepResult.complete === false) {
                if (i >= stepSegments.length) {
                    // this.continued (never touched by any validate*()
                    // method, always names a genuine obligation - see its
                    // own docs) is checked here read-only: non-empty means
                    // this walk was entered via validateResumePendingPower
                    // (a genuine cross-submission resume - Fool's reveal, HP
                    // round 2 - where a persisting Decline button really is
                    // offered, so #49's ROOT-only "must be used... discard
                    // draw 0" wording is wrong regardless of which frame is
                    // active); empty means a fresh validateMajorPower
                    // activation, where #49's wording still applies even
                    // once it pushes into a nominally-optional later frame
                    // (e.g. World->Lovers typed as one hand-typed chain).
                    if (this.continued.length === 0) {
                        return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED") };
                    }
                    const cardName = this.cardNameOrUid(top.cardUid);
                    return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PENDING_POWER_CHOICE", { card: cardName }) };
                }
                // An earlier segment being incomplete means a later one
                // couldn't legitimately exist - defensive, shouldn't fire.
                return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_STEP" });
            }
            if (stepResult.outcome?.forcePause === true) {
                // A forced-pause step can never legally be followed by more
                // segments - the player couldn't have known what to put
                // there (Fool's flip is hidden; the caller found out what
                // was revealed only by actually taking the step) - and
                // nothing can be validated past it regardless, so stop here
                // either way.
                if (i < stepSegments.length) {
                    return this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "STEPS_AFTER_FORCED_PAUSE" });
                }
                // The move as typed is already genuinely complete - but
                // submitting it will ALSO immediately trigger this step's
                // own hidden, automatic continuation (Fool's next flip,
                // High Priestess's next round), which nothing on the
                // board hints at. Named via forcePauseReadyMessage (see
                // its own docs on why powerStepMessageKey itself would be
                // wrong here) instead of falling through to the generic
                // VALID_MOVE fallback, which says nothing about what
                // submitting will actually do next.
                const readyMsg = this.forcePauseReadyMessage(top.cardUid, top.nextStepIndex);
                return { valid: true, complete: 1, message: i18next.t(readyMsg.key, readyMsg.params) };
            }
            // Captured BEFORE chainMinion updates top.minions below - the
            // replay call further down re-runs THIS SAME step (same
            // `tokens`, same `stepIndex`) onto `clone`, so it needs
            // `tokens`' own leading minionRef resolved against the SAME
            // pool `validatePowerStep` just used above, not the pool
            // AFTER this step's own outcome has already been folded in
            // (chainMinion may have just pruned the very entry `tokens`
            // itself refers to - see its own docs).
            const minionsForReplay = top.minions;
            top.minions = GnosticaGame.chainMinion(top.minions, stepResult.outcome ?? {});
            top.nextStepIndex++;
            if (stepResult.outcome?.pushFrame !== undefined) {
                stack.push({ cardUid: stepResult.outcome.pushFrame.cardUid, nextStepIndex: 0, minions: stepResult.outcome.pushFrame.minions, viaFool: stepResult.outcome.pushFrame.viaFool === true });
            }
            GnosticaGame.popExhaustedFrames(this, stack);
            if (i < stepSegments.length || stack.length > 0) {
                clone ??= this.cloneLive();
                clone.applyPowerStep(step, minionsForReplay, tokens, frameDef, stepIndex, frameDef.powers.length, true, borrowedForStep);
            }
        }
    }

    public validateMajorPower(def: MajorArcanaDef, eligible: IMinionRef[], stepSegments: string[][], borrowedPower?: string): IValidationResult {
        // #49: a use/play must take at least one meaningful step - see
        // validateMinorPower's own docs for why this is a deliberate break
        // from a literal "all powers are optional" reading. This zero-
        // segments-overall check only ever catches a bare root activation
        // with nothing typed at all - but the SAME commitment is owed by
        // every frame this walk ever reaches, not just the root: a card
        // reached via a push (World's target, or whatever Fool reveals)
        // still needs a real step or an explicit "decline" once its own
        // turn comes, exactly like the root does here. That's enforced
        // just as strictly, just at different call sites, since a push
        // isn't always resolvable within THIS SAME call - see
        // validateFrameStack's own "nothing more given" docs (World's
        // push, having no forcePause, can run dry in this very call) and
        // validateResumePendingPower's own zero-segment check (which
        // catches Fool's own push - always deferred to a later resume
        // call by its forcePause - the same way). The one real exemption
        // is narrower than either of those: Fool's own flip step itself
        // needs no real segment (see topStepIsFool's own docs), since
        // flipping - unlike merely naming a target - is already a real,
        // committing action requiring no further input to mean something.
        const stack: IPowerFrame[] = [{ cardUid: def.uid, nextStepIndex: 0, minions: [...eligible] }];
        // A World borrow ("as <card uid>") with nothing else typed still
        // has a real step to choose - the borrowed card's own first one -
        // so it falls through to the frame walk (which pushes that frame
        // and returns CHOOSE_STEP for it). A Magician borrow ("as <suit>")
        // pushes no frame; its magicianChoice step still needs a mode, so
        // it wants the generic POWER_STEP_REQUIRED like any bare root.
        const worldBorrow = borrowedPower !== undefined && !ALL_SUITS.some(s => s.uid === borrowedPower);
        if (stepSegments.length === 0 && !this.topStepIsFool(stack) && !worldBorrow) {
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.POWER_STEP_REQUIRED") };
        }
        return this.validateFrameStack(stack, stepSegments, def.uid, borrowedPower);
    }

    // Mirrors resumePendingPower's own dispatch, read-only. The "(via
    // <uid>)" anchor and head word have already been checked by
    // validateMove's own resume gate; this checks the card a "play"
    // resume names (it must be the one the last flip left on top of the
    // discard pile - see buildPendingFromContinued, which rebuilds the
    // stack's top frame from exactly that), then walks the step segments
    // for legality. The click UI always names it right, so a mismatch is
    // only ever a hand-edit.
    private validateResumePendingPower(parsed: IParsedMove): IValidationResult {
        const stack = this.resumeStack()!;
        if (parsed.head === "play" && parsed.rest[0] !== undefined && parsed.rest[0] !== stack[stack.length - 1].cardUid) {
            return this.invalid("apgames:validation.gnostica.INVALID_MOVE", {reason: "BAD_CARD"});
        }
        const stepSegments = this.resumeStepSegments(parsed);
        const worldBorrow = parsed.asUid !== undefined && !ALL_SUITS.some(s => s.uid === parsed.asUid);
        if (stepSegments.length === 0 && !this.topStepIsFool(stack) && !worldBorrow) {
            // Same bare seed as resumePendingPower - valid but incomplete,
            // matching the "still building" complete:-1 pattern used
            // everywhere else for an in-progress chain. Fool's own step is
            // exempt - see topStepIsFool's own docs. POWER_STEP_REQUIRED
            // (used at every OTHER 0-segment site in this file) is wrong
            // here specifically - it's worded for the #49 ROOT-only rule
            // ("must be used, at least in part... or discard draw 0"),
            // but a RESUMED/pushed frame is never mandatory (see
            // validateMajorPower's own docs) and "discard draw 0" isn't
            // even how you'd give it up - Decline is. PENDING_POWER_CHOICE
            // is the correctly-worded, Decline-aware message already used
            // for this exact situation by validateMove("")'s own status
            // line right after a real commit.
            const activeTop = stack[stack.length - 1];
            const cardName = this.cardNameOrUid(activeTop.cardUid);
            return { valid: true, complete: -1, message: i18next.t("apgames:validation.gnostica.PENDING_POWER_CHOICE", { card: cardName }) };
        }
        return this.validateFrameStack(stack, stepSegments, this.getContinuedUid()!, parsed.asUid);
    }

    // "primitive" steps expect <minionRef> <mode> <args...> (same grammar as
    // minor arcana). "special" steps have their own bespoke token shapes -
    // see each apply*() method below. High Priestess is the one special
    // with no minion reference at all (it's pure hand/pile manipulation).
    public applyPowerStep(
        step: PowerStep, minions: IMinionRef[], tokens: string[], def: MajorArcanaDef, stepIndex: number, totalSteps: number, partial: boolean,
        borrowedPower?: string,
    ): IStepOutcome | undefined {
        if ("special" in step && step.special === "worldUseAny") {
            // The borrowed card is named "as <uid>" in the head now, never
            // as a step segment - so this step takes no minion of its own
            // (the borrowed card picks one from The World's pool) and just
            // hands off to that card's frame.
            if (borrowedPower === undefined) {
                return undefined;
            }
            const borrowedDef = worldChoosePower(this.buildPowerContext(), borrowedPower);
            this.results.push({ type: "use", what: borrowedPower, count: 21 });
            return { pushFrame: { cardUid: borrowedDef.uid, minions } };
        }
        if ("special" in step && step.special === "highPriestess") {
            this.applyHighPriestess(tokens, partial);
            // Pause only if a LATER sibling step of THIS SAME card depends
            // on this one's outcome - High Priestess's own first-of-two
            // discard round. Unlike Fool's flip (see the "fool" case
            // below), a card's OWN later step is a property of stepIndex/
            // totalSteps, not something every occurrence of this special
            // unconditionally needs.
            return { forcePause: stepIndex + 1 < totalSteps };
        }
        if ("special" in step && step.special === "fool") {
            // Unlike High Priestess's redraw (a real quantity that's merely
            // cosmetic to preview early), which card gets flipped is hidden
            // information - a partial preview must never actually flip,
            // since move(partial:true) genuinely mutates this instance
            // (see playground.js's fresh-per-click convention) and anything
            // it reveals would leak to the client before a real Submit.
            // So a partial call only reports that a pause is coming, with
            // no pushFrame and nothing pushed to results; the real flip
            // happens exactly once, on the actual non-partial commit.
            if (partial) {
                return { forcePause: true };
            }
            const failure = checkFool(this.buildPowerContext());
            if (failure) {
                // Validation is what stops a real player from getting here
                // in the first place (see validatePowerStep's/validatePlay's
                // own docs on the ROOT-only rejection) - apply's own job is
                // just to do the thing, not re-litigate whether it should
                // have been allowed. Finding nothing left to flip - for any
                // reason, including a trusted caller that skipped
                // validation entirely - just means the Fool's use is
                // complete, gracefully, right here. Returning a plain (if
                // empty) outcome rather than throwing lets walkFrameStack's
                // own generic bookkeeping do the rest: nextStepIndex still
                // advances, popExhaustedFrames still pops this frame (or
                // the whole activation) once spent - no special-casing
                // needed there at all.
                return {};
            }
            const revealed = fool(this.buildPowerContext());
            this.results.push({ type: "deckDraw", what: revealed.uid, from: "fool" });
            // Unlike High Priestess, EVERY flip forces a pause, regardless
            // of whether Fool has another flip left - resolving what was
            // just revealed always depends on knowing what it was, and
            // that's never knowable before this step actually commits.
            return { pushFrame: { cardUid: revealed.uid, minions, viaFool: true }, forcePause: true };
        }
        // Legality beyond this point (minion ref present, well-formed
        // step shape, a recognized special) is validatePowerStep's own
        // job, not this one's.
        const [minionRef, ...rest] = tokens;
        if (this.isMinionCellStillNarrowing(minionRef, minions)) {
            return undefined; // cell chosen, which minion there is still undecided - still declined
        }
        const minion = this.resolvePieceRefOrThrow(minionRef, minions, "NOT_AN_ELIGIBLE_MINION");
        if ("primitive" in step) {
            const suitUid = step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S";
            // "Still building" vs "ready to act on" is answered once,
            // uniformly, by stepShapes.ts's own shared check (see its
            // docs) - validate and the UI preview walker ask the SAME
            // function, independently, for the SAME question; none of
            // the three calls each other for it.
            const shape = primitiveStepShape(suitUid, rest);
            if (shape.status === "incomplete") {
                return undefined; // still declined so far
            }
            const [mode, ...modeArgs] = rest;
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts);
            return this.applySuitPrimitive(suitUid, minion, mode, modeArgs, opts);
        }
        const shape = SPECIAL_STEP_SHAPES[step.special](rest);
        if (shape.status === "incomplete") {
            return undefined; // still declined so far
        }
        // Every apply* method below can now assume complete, well-formed
        // input - the shape check above already ruled out anything else.
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
                // A real (if empty) outcome, not undefined - undefined is
                // reserved exclusively for "still incomplete" now (see
                // IStepOutcome's own docs and walkFrameStack's).
                return {};
            case "magicianChoice":
                return this.applyMagicianChoice(minion, rest);
            default:
                throw new UserFacingError("VALIDATION_GENERAL", i18next.t("apgames:validation.gnostica.INVALID_MOVE", { reason: "SPECIAL_NOT_FOUND" }));
        }
    }

    // Mirrors applyPowerStep's own "incomplete step, still declined"
    // tolerance (same rationale as validateMinorPower's) - see the inline
    // comments below and applyPowerStep's own docs.
    public validatePowerStep(
        step: PowerStep, minions: IMinionRef[], tokens: string[], def: MajorArcanaDef, stepIndex: number, totalSteps: number,
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
            const hpResult = this.validateHighPriestess(tokens);
            if (!hpResult.valid) {
                return { failed: true, result: hpResult };
            }
            return { failed: false, outcome: { forcePause: stepIndex + 1 < totalSteps } };
        }
        if ("special" in step && step.special === "fool") {
            const failure = checkFool(this.buildPowerContext());
            if (failure) {
                if (isFreshRootFool) {
                    // See applyPowerStep's own docs on why this one case
                    // - the ROOT Fool card's own untouched first flip -
                    // stays a hard rejection.
                    return { failed: true, result: this.failureResult(failure) };
                }
                // Anywhere else, gracefully complete instead - see
                // applyPowerStep's own docs. No outcome fields at all
                // (not even forcePause): there's nothing left to reveal,
                // so nothing more can legally follow this segment either,
                // but that falls out naturally from popExhaustedFrames
                // once nextStepIndex advances - no need to also forbid
                // further segments the way a genuine reveal's forcePause
                // does.
                return { failed: false };
            }
            // Can't know what gets pushed without actually flipping (that's
            // the whole point) - forcePause alone is enough to stop
            // validateFrameStack from accepting any further segments.
            return { failed: false, outcome: { forcePause: true } };
        }
        const [minionRef, ...rest] = tokens;
        if (minionRef === undefined) {
            return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "POWER_STEP_ARGS_REQUIRED" }) };
        }
        if (this.isMinionCellStillNarrowing(minionRef, minions)) {
            return { failed: false, complete: false }; // cell chosen, which minion there is still undecided - still declined
        }
        const result = this.resolvePieceRef(minionRef, minions);
        if (result.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(result.kind, minionRef, "NOT_AN_ELIGIBLE_MINION") };
        }
        const minion = result.ref;
        if ("primitive" in step) {
            const suitUid = step.primitive === "create" ? "C" : step.primitive === "move" ? "R" : step.primitive === "grow" ? "D" : "S";
            // Same shared shape check applyPowerStep uses (see
            // stepShapes.ts's own docs) - asked directly, independently;
            // this function never calls into applyPowerStep for it.
            const shape = primitiveStepShape(suitUid, rest);
            if (shape.status === "incomplete") {
                return { failed: false, complete: false };
            }
            if (shape.status === "malformed") {
                return { failed: true, result: this.invalid(`apgames:validation.gnostica.${shape.key}`, shape.params) };
            }
            const [mode, ...modeArgs] = rest;
            const opts = this.computeShortcutOpts(def, step.primitive, stepIndex, totalSteps, step.opts);
            return this.validateSuitPrimitive(suitUid, minion, mode, modeArgs, opts);
        }
        const shape = SPECIAL_STEP_SHAPES[step.special](rest);
        if (shape.status === "incomplete") {
            return { failed: false, complete: false };
        }
        if (shape.status === "malformed") {
            return { failed: true, result: this.invalid(`apgames:validation.gnostica.${shape.key}`, shape.params) };
        }
        // Every validate* method below can now assume complete,
        // well-formed input - the shape check above already ruled out
        // anything else.
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
                const jResult = this.validateJudgementDraw(minion, rest);
                return jResult.valid ? { failed: false } : { failed: true, result: jResult };
            }
            case "magicianChoice":
                return this.validateMagicianChoice(minion, rest);
            default:
                return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "SPECIAL_NOT_FOUND" }) };
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
    public computeShortcutOpts(
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

    public validateSuitPrimitive(suitUid: string, minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown>): StepValidation {
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
                // rest[2], once present, is the OPTIONAL reorientation of
                // the just-created piece (see validateCups' own docs) -
                // rest[1] is the creation's own mandatory (always real,
                // "U" included) initial facing.
                const [cellStr, orientationStr, reorientStr] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const orientation = this.parseOrientation(reorientStr ?? orientationStr);
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
                const victimOwner = this.board.get(tx, ty)!.pieces[victimIndex].owner;
                createEnemy(ctx, minion.x, minion.y, minion.index, tx, ty, victimIndex, opts);
                this.results.push({ type: "place", where: cellStr, how: "cups-enemy", who: victimOwner });
                return {}; // the new piece belongs to the copied enemy, not the acting player
            }
            case "new": {
                const [cellStr, cardArg] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                // "random" is only ever honored when THIS card's own step
                // genuinely grants it (opts.allowRandomDraw, computed from
                // its own step.opts by computeShortcutOpts - see
                // majorArcana.ts's own Wheel of Fortune definition, the
                // only card with it set) - not just because the literal
                // token happens to be typed, which would otherwise let any
                // "Cups: new" step on ANY card draw randomly regardless of
                // whether it's actually supposed to.
                if (cardArg === "random" && opts.allowRandomDraw) {
                    createTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, undefined, opts);
                } else {
                    createTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, cardArg, opts);
                }
                // Read the placed card back off the board rather than
                // trusting cardArg directly - a "random" draw means the
                // card actually placed isn't the literal token typed.
                this.results.push({ type: "place", where: cellStr, how: "territory", what: this.board.get(tx, ty)!.card!.uid });
                return {};
            }
            default:
                // Legality (a recognized mode) is validateCups's own job,
                // not this one's - primitiveStepShape has already gated
                // entry here for both trusted and validated callers alike,
                // so an unrecognized mode reaching this point is a bug
                // upstream, not something to re-litigate gracefully.
                throw new Error(`Unknown Cups mode "${mode}".`);
        }
    }

    private validateCups(minion: IMinionRef, mode: string, rest: string[], opts: Record<string, unknown> = {}): StepValidation {
        const ctx = this.buildPowerContext();
        switch (mode) {
            case "own": {
                // A brand-new minion can't reasonably go unoriented - "U"
                // is a perfectly real, always-legal choice for it (matches
                // "new minions default up" - never auto-assigned, but
                // always REQUIRED as an explicit fact of creation). The
                // OPTIONAL 3rd token, once present, reorients that just-
                // created piece via the exact same trailing-orientation
                // rule every other target minion gets: hard-reject a
                // request that changes nothing.
                const [cellStr, orientationStr, reorientStr] = rest;
                const coords = this.tryAlgebraic2coords(cellStr);
                if (coords === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_CELL", { cell: cellStr }) };
                }
                const [tx, ty] = coords;
                if (orientationStr === undefined) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.BAD_ORIENTATION", { orientation: orientationStr }) };
                }
                const resolved = this.resolveTrailingOrientation(orientationStr, reorientStr);
                if ("key" in resolved) {
                    return { failed: true, result: this.invalid(`apgames:validation.gnostica.${resolved.key}`, resolved.params) };
                }
                const finalOrientation = resolved.orientation;
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
                return { failed: false, outcome: { newMinion: { x: tx, y: ty, index: newIndex, piece: new Piece(this.currplayer, 1, finalOrientation) } } };
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
                // Mirrors applyCups's own "new" case - "random" is only
                // ever honored when opts.allowRandomDraw is genuinely set
                // for THIS card's own step, not just because the literal
                // token was typed.
                const failure = cardArg === "random" && opts.allowRandomDraw
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
                    this.results.push({ type: "destroy", where: origin, what: this.getPipsFromRef(targetRef), who: movedOwner });
                    return {};
                }
                const dest = GnosticaBoard.coords2algebraic(destX, destY);
                this.results.push({ type: "move", from: origin, to: dest, what: this.getPipsFromRef(targetRef), how: "rod-piece", who: movedOwner });
                if (movedOwner === this.currplayer) {
                    const newIndex = this.board.get(destX, destY)!.pieces.length - 1;
                    return { newMinion: { x: destX, y: destY, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
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
                // See applyCups's own matching comment - validateRods
                // owns this legality, not this function.
                throw new Error(`Unknown Rods mode "${mode}".`);
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
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_NUMBER" }) };
                }
                if (orientationStr !== undefined) {
                    const parsed = this.parseOrientationOrFail(orientationStr);
                    if ("key" in parsed) {
                        return { failed: true, result: this.invalid(`apgames:validation.gnostica.${parsed.key}`, parsed.params) };
                    }
                    // Same "never reorient an existing minion for free"
                    // principle as validateOrient/validateOrientMinion/
                    // validateOrientAny - an explicit facing matching the
                    // piece's own current one achieves nothing (movePiece
                    // only ever applies it to the player's own piece
                    // anyway - see its own docs), so it's rejected the
                    // same hard way, not silently accepted.
                    const currentPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                    const noOp = currentPiece.owner === this.currplayer
                        ? this.checkOrientationChanges(currentPiece.orientation, parsed.orientation)
                        : undefined;
                    if (noOp) {
                        return { failed: true, result: this.invalid(`apgames:validation.gnostica.${noOp.key}`) };
                    }
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
                    return { failed: false, outcome: { newMinion: { x: destX, y: destY, index: newIndex, piece: newPiece }, replacesMinion: { x: target.x, y: target.y, index: target.index } } };
                }
                return { failed: false };
            }
            case "tile": {
                const [distStr] = rest;
                const dist = parseInt(distStr, 10);
                if (Number.isNaN(dist)) {
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_NUMBER" }) };
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
                this.results.push({ type: "convert", what: `size ${beforeSize}`, into: `size ${beforeSize + 1}`, where: GnosticaBoard.coords2algebraic(target.x, target.y), who: owner });
                if (owner === this.currplayer) {
                    const newIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
                    return { newMinion: { x: target.x, y: target.y, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
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
                // See applyCups's own matching comment - validateDiscs
                // owns this legality, not this function.
                throw new Error(`Unknown Discs mode "${mode}".`);
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
                if (orientationStr !== undefined) {
                    const parsed = this.parseOrientationOrFail(orientationStr);
                    if ("key" in parsed) {
                        return { failed: true, result: this.invalid(`apgames:validation.gnostica.${parsed.key}`, parsed.params) };
                    }
                    // See validateRods' own matching docs.
                    const currentPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                    const noOp = currentPiece.owner === this.currplayer
                        ? this.checkOrientationChanges(currentPiece.orientation, parsed.orientation)
                        : undefined;
                    if (noOp) {
                        return { failed: true, result: this.invalid(`apgames:validation.gnostica.${noOp.key}`) };
                    }
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
                    return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } } };
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
                const resultSize = beforeSize - pips;
                const where = GnosticaBoard.coords2algebraic(target.x, target.y);
                if (resultSize === 0) {
                    this.results.push({ type: "destroy", where, what: this.getPipsFromRef(targetRef), who: owner });
                } else {
                    this.results.push({ type: "convert", what: `size ${beforeSize}`, into: `size ${resultSize}`, where, who: owner });
                }
                if (resultSize > 0 && owner === this.currplayer) {
                    const newIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
                    return { newMinion: { x: target.x, y: target.y, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
                }
                return {};
            }
            case "tile": {
                const [cellStr, pipsStr, newCardUid] = rest;
                const [tx, ty] = GnosticaBoard.algebraic2coords(cellStr);
                const pips = parseInt(pipsStr, 10);
                const beforeUid = this.board.get(tx, ty)!.card!.uid;
                attackTerritory(ctx, minion.x, minion.y, minion.index, tx, ty, pips, newCardUid, opts);
                // A replacement card means the territory survived, shrunk
                // (checkAttackTerritory's own REPLACEMENT_CARD_REQUIRED/
                // DESTROYED_NEEDS_NO_CARD pairing guarantees the two are
                // mutually exclusive) - only a true wipeout (no
                // replacement) is a "destroy".
                if (newCardUid === undefined) {
                    this.results.push({ type: "destroy", where: cellStr, what: beforeUid });
                } else {
                    this.results.push({ type: "convert", what: beforeUid, into: newCardUid, where: cellStr });
                }
                return {};
            }
            default:
                // See applyCups's own matching comment - validateSwords
                // owns this legality, not this function.
                throw new Error(`Unknown Swords mode "${mode}".`);
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
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_NUMBER" }) };
                }
                if (orientationStr !== undefined) {
                    const parsed = this.parseOrientationOrFail(orientationStr);
                    if ("key" in parsed) {
                        return { failed: true, result: this.invalid(`apgames:validation.gnostica.${parsed.key}`, parsed.params) };
                    }
                    // See validateRods' own matching docs.
                    const currentPiece = this.board.get(target.x, target.y)!.pieces[target.index];
                    const noOp = currentPiece.owner === this.currplayer
                        ? this.checkOrientationChanges(currentPiece.orientation, parsed.orientation)
                        : undefined;
                    if (noOp) {
                        return { failed: true, result: this.invalid(`apgames:validation.gnostica.${noOp.key}`) };
                    }
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
                    return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } } };
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
                    return { failed: true, result: this.invalid("apgames:validation.gnostica.INVALID_MOVE", { reason: "BAD_NUMBER" }) };
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
        this.pushOrientResult(minion.x, minion.y, minion.index, this.pieceRefStr(minion.x, minion.y, minion.index), orientation);
        return { newMinion: minion, replacesMinion: minion };
    }

    public validateOrientMinion(minion: IMinionRef, rest: string[]): StepValidation {
        const [orientationStr] = rest;
        const parsed = this.parseOrientationOrFail(orientationStr);
        if ("key" in parsed) {
            return { failed: true, result: this.invalid(`apgames:validation.gnostica.${parsed.key}`, parsed.params) };
        }
        const failure = checkOrientMinion(this.buildPowerContext(), minion.x, minion.y, minion.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        // Same "achieves nothing" principle as the standalone "orient"
        // command's own ORIENT_NO_OP - but a hard rejection here, not that
        // command's soft complete:-1 leniency, since nothing about this
        // step's own click flow (handleOrientMinionClick) ever seeds a
        // same-facing default the way "orient"'s own piece-click does or
        // orientAny/hierophantReplace's own target-click does (see
        // handleOrientAnyOrHierophantClick's own default-seed docs) - a
        // same-facing answer reaching here is always a genuine, avoidable
        // player choice, never an unavoidable click-flow artifact.
        const currentOrientation = this.board.get(minion.x, minion.y)!.pieces[minion.index].orientation;
        const noOp = this.checkOrientationChanges(currentOrientation, parsed.orientation);
        if (noOp) {
            return { failed: true, result: this.invalid(`apgames:validation.gnostica.${noOp.key}`) };
        }
        return { failed: false, outcome: { newMinion: minion, replacesMinion: minion } };
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
        this.pushOrientResult(target.x, target.y, target.index, targetRef, orientation);
        return owner === this.currplayer ? { newMinion: target, replacesMinion: target } : {};
    }

    public validateOrientAny(minion: IMinionRef, rest: string[]): StepValidation {
        const [targetRef, orientationStr] = rest;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
        const parsed = this.parseOrientationOrFail(orientationStr);
        if ("key" in parsed) {
            return { failed: true, result: this.invalid(`apgames:validation.gnostica.${parsed.key}`, parsed.params) };
        }
        const failure = checkOrientAny(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        // See validateOrientMinion's own matching docs - hard rejection,
        // not "orient"'s own soft leniency, since
        // handleOrientAnyOrHierophantClick's own stage-1 default seed is
        // fixed to never itself produce this (see its docs), so a
        // same-facing answer reaching here is always a genuine, avoidable
        // choice.
        const currentOrientation = this.board.get(target.x, target.y)!.pieces[target.index].orientation;
        const noOp = this.checkOrientationChanges(currentOrientation, parsed.orientation);
        if (noOp) {
            return { failed: true, result: this.invalid(`apgames:validation.gnostica.${noOp.key}`) };
        }
        const owner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        return owner === this.currplayer ? { failed: false, outcome: { newMinion: target, replacesMinion: target } } : { failed: false };
    }

    // Hierophant: <minionRef> <targetPieceRef> <newOrientation>
    private applyHierophantReplace(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [targetRef, orientationStr] = rest;
        const target = this.resolvePieceRefOrThrow(targetRef);
        const orientation = this.parseOrientation(orientationStr);
        // Captured before the replace mutates the board - the previous
        // owner being displaced, for the result log (see chat()'s own use
        // of `who`).
        const previousOwner = this.board.get(target.x, target.y)!.pieces[target.index].owner;
        hierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index, orientation);
        this.addBufferIfWasteland(target.x, target.y);
        this.results.push({ type: "convert", what: this.getPipsFromRef(targetRef), into: `owner-${this.currplayer}`, where: GnosticaBoard.coords2algebraic(target.x, target.y), who: previousOwner });
        const newIndex = this.board.get(target.x, target.y)!.pieces.length - 1;
        return { newMinion: { x: target.x, y: target.y, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
    }

    public validateHierophantReplace(minion: IMinionRef, rest: string[]): StepValidation {
        const [targetRef, orientationStr] = rest;
        const targetResult = this.resolvePieceRef(targetRef);
        if (targetResult.kind !== "ok") {
            return { failed: true, result: this.invalidPieceRef(targetResult.kind, targetRef) };
        }
        const target = targetResult.ref;
        const parsed = this.parseOrientationOrFail(orientationStr);
        if ("key" in parsed) {
            return { failed: true, result: this.invalid(`apgames:validation.gnostica.${parsed.key}`, parsed.params) };
        }
        const failure = checkHierophantReplace(this.buildPowerContext(), minion.x, minion.y, minion.index, target.x, target.y, target.index);
        if (failure) {
            return { failed: true, result: this.failureResult(failure) };
        }
        // Replace-in-place (removeAt then add) - net piece count at this
        // cell is unchanged, so pre- and post-mutation "last index" match.
        const newIndex = (this.board.get(target.x, target.y)?.pieces.length ?? 1) - 1;
        return { failed: false, outcome: { newMinion: { x: target.x, y: target.y, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } } };
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
            this.results.push({ type: "move", from: origin, to: destCellStr, what: this.getPipsFromRef(targetRef), how: "hermit-piece", who: owner });
            if (owner === this.currplayer) {
                const newIndex = this.board.get(destX, destY)!.pieces.length - 1;
                return { newMinion: { x: destX, y: destY, index: newIndex }, replacesMinion: { x: target.x, y: target.y, index: target.index } };
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
        // See applyCups's own matching comment - validateHermitStep owns
        // this legality, not this function.
        throw new Error(`Unknown Hermit mode "${mode}".`);
    }

    public validateHermitStep(minion: IMinionRef, rest: string[]): StepValidation {
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
                return { failed: false, outcome: { newMinion: { x: destX, y: destY, index: newIndex, piece: newPiece }, replacesMinion: { x: target.x, y: target.y, index: target.index } } };
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
        this.results.push({ type: "swap", where: GnosticaBoard.coords2algebraic(target.x, target.y), who: targetOwner });
        return {};
    }

    public validateTradeHands(minion: IMinionRef, rest: string[]): StepValidation {
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

    public validateJudgementDraw(minion: IMinionRef, rest: string[]): IValidationResult {
        const failure = checkJudgementDraw(this.buildPowerContext(), minion.x, minion.y, minion.index, rest);
        return failure ? this.failureResult(failure) : { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // High Priestess: <discardUid...> [draw <n>] - no minion reference at
    // all, and now mirrors the ordinary end-of-turn discard/draw action's
    // own grammar exactly (see cmdDiscard's own docs) - the draw count is
    // the player's own choice, not forced to the max. The draw itself is
    // genuinely random (once a reshuffle is needed) and is deferred until
    // a real (non-partial) commit, same as cmdDiscard's own convention.
    // No result is logged for a partial call - nothing happened yet worth
    // logging.
    private applyHighPriestess(tokens: string[], partial: boolean): void {
        const drawIdx = tokens.indexOf("draw");
        const discardUids = drawIdx === -1 ? tokens : tokens.slice(0, drawIdx);
        const drawCountStr = drawIdx === -1 ? undefined : tokens[drawIdx + 1];
        const drawn = highPriestess(this.buildPowerContext(), discardUids, drawCountStr, partial);
        if (!partial) {
            this.results.push({ type: "deckDraw", count: drawn, from: "deck" });
        }
    }

    public validateHighPriestess(tokens: string[]): IValidationResult {
        const drawIdx = tokens.indexOf("draw");
        const discardUids = drawIdx === -1 ? tokens : tokens.slice(0, drawIdx);
        const drawCountStr = drawIdx === -1 ? undefined : tokens[drawIdx + 1];
        const failure = checkHighPriestess(this.buildPowerContext(), discardUids, drawCountStr);
        return failure ? this.failureResult(failure) : { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // World: <chosenUid> - the minionRef itself is already stripped/
    // resolved by applyPowerStep's own pre-switch logic, same as every
    // other special.
    private validateWorldChoosePower(chosenUid: string): IValidationResult {
        const failure = checkWorldChoosePower(this.buildPowerContext(), chosenUid);
        return failure ? this.failureResult(failure) : { valid: true, complete: 1, message: i18next.t("apgames:validation._general.VALID_MOVE") };
    }

    // Magician: <minionRef> <suitLetter: C|R|D|S> <mode> <args...> - the
    // player picks which of the four suit primitives to use; everything
    // after the suit letter matches that suit's normal mode+args grammar.
    // Called only once applyPowerStep's own SPECIAL_STEP_SHAPES.magicianChoice
    // check has already confirmed `rest` is complete and well-formed (see
    // stepShapes.ts's own docs) - no completeness/legality checking here.
    private applyMagicianChoice(minion: IMinionRef, rest: string[]): IStepOutcome {
        const [suitLetter, mode, ...args] = rest;
        return this.applySuitPrimitive(suitLetter, minion, mode, args, {});
    }

    // Called only once validatePowerStep's own SPECIAL_STEP_SHAPES.magicianChoice
    // check has already confirmed `rest` is complete and well-formed (see
    // stepShapes.ts's own docs) - no completeness checking here, just the
    // real legality check on the now-known suit/mode/args.
    public validateMagicianChoice(minion: IMinionRef, rest: string[]): StepValidation {
        const [suitLetter, mode, ...args] = rest;
        return this.validateSuitPrimitive(suitLetter, minion, mode, args, {});
    }

    // ============================================================
    // Turn order / scoring / win-elimination
    // ============================================================

    // Always rotates, even on the move that just ended the game (a direct
    // win via resolveAnnouncedTurn(), which sets this.gameover BEFORE this
    // runs) - external consumers (chat/move-history logs) attribute move
    // N to whichever player currplayer names in stack[N-1], so leaving
    // currplayer pinned to the winner instead of rotating past them breaks
    // that attribution for the final move (looks like the previous player
    // acted twice in a row). Elimination-triggered endgames never hit this
    // case anyway - checkEOG() sets gameover AFTER this already ran, not
    // before, so this was only ever actually skipping on a direct win.
    //
    // Steps forward through turnOrder (not raw player-id arithmetic) -
    // "tournament rules" means play order isn't just 1,2,3...N, it's
    // whatever resolveBidRound() sets turnOrder to once a bid resolves
    // (see its own docs). turnOrder is undefined outside the "bidding"
    // variant entirely (see its own docs) - falling back here to the same
    // plain ascending order it would otherwise start as means the opening
    // bid-collection round (cmdBid's own nextPlayer() calls between
    // bidders) still advances correctly too, nothing special-cased here
    // for phase, this one fallback covers both.
    private nextPlayer(): void {
        const order = this.turnOrder ?? [...Array(this.numplayers)].map((_, i) => (i + 1) as playerid);
        const pos = order.indexOf(this.currplayer);
        let next = pos;
        do {
            next = (next + 1) % order.length;
        } while (this.eliminated.includes(order[next]) && order[next] !== this.currplayer);
        this.currplayer = order[next];
    }

    // Stay open while a continuation (Fool's flip, High Priestess round 2)
    // is still owed, even if currplayer has cycled back to the round
    // opener - otherwise the inherited (elimination-safe) close check would
    // false-positive-close the round after the seat's first ply, before
    // the obligation resolves.
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

    // Cards that player drew at the end of their last turn,
    // as tracked by cardsDrawn, for highlighting  by render()
    // Only ever non-empty for the CURRENT player,
    // and only until they've started building THIS turn's move.
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
        this.discarded.push(...this.hands[player - 1]);
        this.hands[player - 1] = [];
        this.eliminated.push(player);
        this.results.push({ type: "eliminated", who: player.toString() });
    }

    protected checkEOG(): GnosticaGame {
        // Not explicit in the rules text (which assumes play continues
        // until someone announces and wins), but if elimination ever
        // leaves only one player standing, they've necessarily won.
        if (this.eliminated.length === this.numplayers - 1) {
            this.gameover = true;
            const playarray = [...Array(this.numplayers)].map((_, index) => index + 1) as playerid[];
            this.winner = playarray.filter(item => ! this.eliminated.includes(item));
        }
          
        if (this.gameover) {
            this.results.push({ type: "eog" });
            this.results.push({ type: "winners", players: [...this.winner] });
        }
        return this;
    }

    // randomMove() and its supporting builders now live in
    // gnostica/randomMove.ts (see #84's own docs on why gnostica.ts needs
    // to shrink) - this is just a thin stub calling generateRandomMove().
    public randomMove(): string {
        return generateRandomMove(this);
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
    // The actual, single-state render body - renamed from render() so the
    // new public render() dispatcher (below) can call it directly. A
    // finished/historical chain's own frames are built entirely from
    // renderFrame() instead (no buttons/hands there at all - see its own
    // docs), so this only ever runs on a genuinely live state: either the
    // real current one, or (mid-build, via renderFrameSnapshot's clone)
    // the acting player's own still-in-progress chain, which DOES need
    // real interactive buttons for whatever comes next. `suppressHands`
    // still applies to that mid-build clone case - FrameState doesn't
    // capture hands at all (see its own docs), so even there an
    // intermediate step's own hand area would just be the live/final hand
    // mislabeled as that step's own.
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

        // One area per player's hand, full-size (non-spaced) card faces -
        // skipped entirely for an intermediate frame (see suppressHands's
        // own docs above).
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
                    // A card just added to hand (see newHandCardUids's own
                    // docs) gets its own tagged legend entry - same face,
                    // just tinted so it's easy to spot regardless of where
                    // rank-order sorting happened to place it.
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
                    // Matches magnate.ts/emu.ts's own hand/deck sizing - tighter
                    // than the default auto-wrap-at-board-width spacing, and a
                    // fixed width (hands are always <=6 cards) rather than
                    // letting row width drift with the board's own size.
                    spacing: 0.25,
                    width: 6,
                    ownerMark: p,
                });
            }
        }

        // The "bidding" variant's shared pool - every card revealed by the
        // opening bid procedure so far, available for anyone to redraw
        // from (see cmdRedraw's own docs). Fully public by the time it's
        // ever non-empty, unlike hands - no redaction/placeholder handling
        // needed at all.
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
            this.discardPile, "discard", legend, i18next.t("apgames:validation.gnostica.LABEL_DISCARDS"), new Set(this.discarded)
        );
        if (discardArea !== undefined) {
            areas.push(discardArea);
        }

        // Only the bidding variant can ever make turn order diverge from
        // plain player-number order ("tournament rules" - the rank order
        // of the cards everyone bid, see resolveBidRound's own docs) -
        // the default variant always rotates 1,2,3,...,N, so a legend
        // there would just be redundant clutter restating the obvious.
        // With only 2 players, turn order is trivially "you, then them"
        // either way - nothing worth a legend for regardless of variant.
        // this.turnOrder is already plain ascending order (1..N)
        // whenever a bid hasn't resolved yet (see its own docs), so no
        // separate fallback is needed here.
        if (this.numplayers >= 3 && this.variants.includes("bidding")) {
            const list: AreaKey["list"] = [];
            this.turnOrder!.forEach((p, i) => {
                const key = `turnorder_p${p}`;
                if (!(key in legend)) {
                    legend[key] = { name: "pyramid-up-small", colour: p };
                }
                list.push({ piece: key, name: GnosticaGame.ordinal(i + 1) });
            });
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
        // A 2+-step major-arcana chain wraps each step's own results into
        // a _group entry (see applyMajorPower's own docs) - flatten one
        // level so annotations still cover every step's own effect,
        // rather than silently disappearing for any chained move.
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

    // Builds a finished/historical chain's own intermediate frame DIRECTLY
    // from FrameState's own board/discardPile - no clone, no live-instance
    // fallback for anything. Never builds a hand, draw-pile, bidding-pool,
    // declaration-banner, turn-order-key, or button area at all (rather
    // than building then suppressing them) - none of those are genuinely
    // per-step data (see FrameState's own docs), so there's nothing there
    // worth reconstructing for a fixed point in a chain's own history.
    // Only used once liveMove is undefined (the chain is fully committed,
    // being reviewed rather than still built) - see render()'s own
    // dispatch; while still mid-build, renderFrameSnapshot's clone is used
    // instead, since that case genuinely needs real interactive buttons
    // for whatever comes next, not just a static picture of what already
    // happened.
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

        // The discard pile is always face-up/public - unlike hands or the
        // draw pile, both never shown for a historical frame at all (see
        // this function's own docs) - so it's the one non-board area worth
        // reconstructing here. No "just discarded" tinting: that reads
        // this.discarded, a live-only concept, not something a fixed
        // historical snapshot needs.
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

        // Same _group unwrapping as the live render's own annotation loop
        // (see applyMajorPower's own docs on why chained results are
        // wrapped this way) - pull just this step's own group by
        // position, matching frogger.ts's identical frame[i]/results[i]
        // pairing.
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

    // A throwaway GnosticaGame reflecting `frame`'s own board instead of
    // live state - extends the existing cloneLive() pattern (built
    // earlier for an unrelated reason) with a field override instead of a
    // straight live copy. Only used mid-build (see render()'s own
    // dispatch) - a finished chain's own historical frames use
    // renderFrame() directly instead, with no clone at all. discardPile
    // is deliberately NOT overridden here - it falls back to the live
    // value via moveState()'s own spread, same tolerance already accepted
    // for hands in this exact case (see FrameState's own docs); only
    // board is worth a real clone override for a still-mid-build preview.
    // The clone's own `frames` stays empty, so callers must call
    // .renderCurrent() directly on it, not the public .render() - calling
    // the latter would risk recursing back into array-building logic.
    private renderFrameSnapshot(frame: FrameState, stepIndex: number): GnosticaGame {
        // this.results holds one _group entry per step of the chain that
        // produced these frames (see applyMajorPower's own docs) - pull
        // just this step's own group by position, matching frogger.ts's
        // identical frame[i]/results[i] pairing.
        const groups = this.results.filter((r): r is Extract<APMoveResult, { type: "_group" }> => r.type === "_group");
        const raw = this.state();
        raw.stack = [{
            ...this.moveState(),
            board: frame.board,
            _results: groups[stepIndex] !== undefined ? [groups[stepIndex]] : [],
        }];
        const snapshot = new GnosticaGame(JSON.stringify(raw, replacer));
        if (this.liveMove !== undefined) {
            // Still mid-build (the acting player is paging through their
            // own not-yet-submitted chain) - reconstruct exactly what had
            // been typed as of this step, so getActionButtons() on the
            // snapshot offers the real choices available at that point,
            // not the final/current ones. Legal despite liveMove being
            // private: TypeScript scopes private access to the class, not
            // the instance - the same trick validateMajorPower's own
            // clone-and-replay logic already relies on.
            snapshot.liveMove = { ...this.liveMove, stepSegments: this.liveMove.stepSegments.slice(0, stepIndex + 1) };
        }
        return snapshot;
    }

    // this.frames is only ever non-empty for a move that chained 2+
    // major-arcana steps (see applyMajorPower's own docs) - every other
    // move returns the single rep renderCurrent() always has, unchanged
    // from before this feature existed.
    public render(opts?: IRenderOpts): APRenderRep | APRenderRep[] {
        if (this.frames.length === 0) {
            return this.renderCurrent(opts);
        }
        // No live in-progress move left to reconstruct buttons from means
        // this is a fully committed move being reviewed later (a reload, a
        // spectator) - build each frame directly from FrameState itself
        // (renderFrame(), no clone, no buttons/hands to suppress - see its
        // own docs), since there's nothing left to interact with. While
        // still mid-build (the acting player paging through their own
        // not-yet-submitted chain), reconstructed per-frame buttons
        // (renderFrameSnapshot's own liveMove override) are genuinely
        // needed instead, for whatever comes next.
        const historical = this.liveMove === undefined;
        const reps = historical
            ? this.frames.map((f, i) => this.renderFrame(f, i, opts))
            : this.frames.map((f, i) => this.renderFrameSnapshot(f, i).renderCurrent(opts, true));
        reps.push(this.renderCurrent(opts));
        return reps;
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

    // The abbreviation FrameState.discardSummary itself stores - see its
    // own docs. Pure bucketing, no "new"/tinting concept at all (that's a
    // live-only idea - see buildAreaFromSummary's own docs), so it's just
    // the first half of buildDeckSummaryArea's own logic, minus newUids.
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

    // Builds a discard area straight from an already-summarized
    // DiscardSummary (see its own docs) - used only for a historical
    // frame (renderFrame()), which has no "just discarded" cards to tint
    // (that's this.discarded, a live-only concept with no equivalent for
    // a fixed point in the past) and no raw uid list to re-derive one
    // from anyway. Otherwise identical output to buildDeckSummaryArea's
    // own pieces-building half, just skipping the tinting split.
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
                // A representative rank (any court rank for "royal", any
                // non-court rank for "spot") uses the usual card layout;
                // only the background (borderless, no card-square) and
                // the rank-corner text (a count, not a real rank) are
                // overridden.
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
    private buildCardFace(card: TarotCard, spaced: boolean, owner: number = 0, opts: { borderless?: boolean; rankText?: string; background?: ColourResolvable } = {}): Glyph[] {
        const BOARD_TILE_GRID_CORNER = 650;
        // Opacity 0 by default, matching Jacynth's own Card.toGlyph() - an
        // ordinary card face has no filled square at all, so the theme's
        // own board/background colour shows through it rather than a fixed
        // white. The stroke/border stays drawn regardless (a separate,
        // always-visible outline), so the cell boundary is still legible.
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

        // `spaced` (board tiles, which also have to fit up to 3+ pieces in
        // the same small square) pushes the four corners further out and
        // shrinks everything in them, versus the normal card layout.
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

        // Top-right: always populated.
        pushCircle(1, -1, icons[0]);

        if (card.major) {
            pushCircle(-1, 1, icons[2]);
            pushCircle(1, 1, icons[1]);
        } else if (card.court) {
            pushCircle(1, 1, undefined);
        }

        return stack;
    }

    // A board tile has to show the card AND up to 3 pieces in the same
    // small square, so it uses the spaced card face (smaller rank/circle
    // sizing) rather than the roomier default meant for a card shown alone
    // (e.g. a hand, once that's rendered).
    private buildCellGlyph(t: CellContents | undefined, cls: CellClass, largerCards: boolean, owner?: number): Glyph | [Glyph, ...Glyph[]] {
        const stack: Glyph[] = [];
        if (t?.card !== undefined) {
            const dontSpace = largerCards && t.playersPresent().size === 0;
            stack.push(...this.buildCardFace(t.card, !dontSpace, owner));
        } else if (cls === "wasteland") {
            // Same transparent-by-default convention as buildCardFace's own
            // backdrop, so the theme's board colour shows through here too.
            stack.push({ name: "piece-square-dashed", scale: 1, opacity: 0 });
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
        const PIECE_GRID_RADIUS = 380;
        const PIECE_GRID_SLOTS: [number, number][] = [[0, -1], [0, 1], [1, 0], [-1, 0], [0, 0]]; // N, S, E, W, U
        const PIECE_GRID_PREFERRED_INDEX: Record<Orientation, number> = { N: 0, S: 1, E: 2, W: 3, U: 4 };
        const CARDINAL_COS_SIN: Record<Exclude<Orientation, "U">, [number, number]> = {
    N: [1, 0], E: [0, 1], S: [-1, 0], W: [0, -1],
};
        // #48: a piece bumped off its own preferred slot tries the two
        // perpendicular sides first, then dead centre, and only falls
        // back to the OPPOSITE side as an absolute last resort - visually
        // the most misleading placement, since it reads as facing the
        // wrong way. A centre-preferring piece has no such concern - any
        // leftover slot is equally fine, so its own list is just a fixed,
        // deterministic order (not a real preference).
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

    // A card's own display name for chat/status text, with its major
    // arcana numeral appended in parens (e.g. "The World (XXI)") - the
    // card's own stored name is used as-is, "The " prefix and all. Falls
    // back to the bare uid (or "" if even that's missing - some result
    // types carry an optional `what`) if the card can't be found at all;
    // a minor card (no numeral worth showing) just gets its plain name.
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

    // Same as cardDisplayName, for the handful of results that carry a
    // comma-joined list of uids (a redraw pick, a discard) rather than a
    // single card.
    private cardDisplayNames(uidsCsv: string): string {
        return uidsCsv.split(",").filter(uid => uid.length > 0).map(uid => this.cardDisplayName(uid)).join(", ");
    }

    // #47: resolves a player number to their real display name (falling
    // back to "Player N" the same way chatLog() itself does for the
    // acting player), or undefined if `who` is the acting player
    // themselves.
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
                // Resolved via plyActor(), not `state.currplayer - 1`, to fix
                // skip-turn (elimination) and sequenced (bidding reorder,
                // High Priestess) cases.
                let otherPlayer = this.plyActor(i);
                if (otherPlayer < 1) {
                    otherPlayer = this.numplayers;
                }
                let player = `Player ${otherPlayer}`;
                if (otherPlayer <= players.length) {
                    player = players[otherPlayer - 1];
                }
                // Frames for multi-step major arcana moves have _group entries
                // to frames - flatten here so this loop logs one line per
                // step instead of silently skipping the whole group (same
                // idea frogger.ts/rincala.ts use, inlined here since
                // gnostica has no separate chat() dispatcher to do it in).
                const flatResults = state._results.flatMap(r => r.type === "_group" ? r.results : [r]);
                for (const r of flatResults) {
                    switch (r.type) {
                        case "announce": {
                            const nameFor = (p: number): string => p <= players.length ? players[p - 1] : `Player ${p}`;
                            const turnOrderNames = (r.payload as number[]).map(nameFor).join(", ");
                            const redrawOrderNames = [...r.payload as number[]].reverse().map(nameFor).join(", ");
                            node.push(i18next.t("apresults:ANNOUNCE.gnostica", { turnOrder: turnOrderNames, redrawOrder: redrawOrderNames }));
                            break;
                        }
                        case "swap": {
                            const target = this.otherPlayerName(r.who as number, player, players) ?? `Player ${r.who}`;
                            node.push(i18next.t("apresults:SWAP.gnostica", { player, target }));
                            break;
                        }
                        case "select":
                            node.push(i18next.t("apresults:SELECT.gnostica", { player }));
                            break;
                        case "deckDraw":
                            switch (r.from) {
                                case "pool":
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_pool", { player, what: this.cardDisplayNames(r.what ?? "") }));
                                    break;
                                case "discard":
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_discard", { player, count: r.count }));
                                    break;
                                case "deck":
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_deck", { player, count: r.count }));
                                    break;
                                case "hand":
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_hand", { player, what: this.cardDisplayName(r.what) }));
                                    break;
                                case "fool": {
                                    node.push(i18next.t("apresults:DECKDRAW.gnostica_fool", { player, what: this.cardDisplayName(r.what) }));
                                    break;
                                }
                            }
                            break;
                        case "declare":
                            node.push(i18next.t("apresults:DECLARE.gnostica", { player, count: r.count }));
                            break;
                        case "orient": {
                            // The Devil's orientAny can reorient any player's
                            // piece; every other orient path only ever turns
                            // the acting player's own.
                            const target = this.otherPlayerName(r.who, player, players);
                            node.push(target === undefined
                                ? i18next.t("apresults:ORIENT.gnostica_own", { player, where: r.where, what: r.what, facing: r.facing })
                                : i18next.t("apresults:ORIENT.gnostica_target", { player, where: r.where, what: r.what, facing: r.facing, target }));
                            break;
                        }
                        case "use":
                            if (r.count && r.count === 21) {
                                node.push(i18next.t("apresults:USE.gnostica_world", { player, what: this.cardDisplayName(r.what) }));
                            } else
                                node.push(i18next.t("apresults:USE.gnostica", { player, what: this.cardDisplayName(r.what) }));
                            break;
                        case "pass":
                            node.push(r.why === "eliminated"
                                ? i18next.t("apresults:PASS.gnostica_eliminated", { player })
                                : i18next.t("apresults:PASS.gnostica_bids", { player }));
                            break;
                        case "destroy":
                            if (r.who !== undefined) {
                                //Someone's minion.
                                const target = this.otherPlayerName(r.who, player, players);
                                node.push(target === undefined
                                    ? i18next.t("apresults:DESTROY.gnostica_piece_own", { player, what: r.what })
                                    : i18next.t("apresults:DESTROY.gnostica_piece", { player, what: r.what, target }));
                            } else {
                                //A territory.
                                node.push(i18next.t("apresults:DESTROY.gnostica_tile", { player, where: r.where, what: this.cardDisplayName(r.what) }));
                            }
                            break;
                        case "move": {
                            // Rods/Hermit "piece" mode can move ANY
                            // player's piece, not just the acting minion's
                            // own (see checkMovePiece/checkHermitMovePiece
                            // - no owner restriction on the target) - name
                            // whose it was, same _own/target split as
                            // "destroy".
                            const target = this.otherPlayerName(r.who, player, players);
                            switch (r.how) {
                                case "rod-piece":
                                    node.push(target === undefined
                                        ? i18next.t("apresults:MOVE.gnostica_rod_piece_own", { player, what: r.what, from: r.from, to: r.to })
                                        : i18next.t("apresults:MOVE.gnostica_rod_piece", { player, what: r.what, from: r.from, to: r.to, target }));
                                    break;
                                case "rod-tile":
                                    node.push(i18next.t("apresults:MOVE.gnostica_rod_tile", { player, from: r.from, to: r.to }));
                                    break;
                                case "hermit-piece":
                                    node.push(target === undefined
                                        ? i18next.t("apresults:MOVE.gnostica_hermit_piece_own", { player, what: r.what, from: r.from, to: r.to })
                                        : i18next.t("apresults:MOVE.gnostica_hermit_piece", { player, what: r.what, from: r.from, to: r.to, target }));
                                    break;
                                case "hermit-tile":
                                    node.push(i18next.t("apresults:MOVE.gnostica_hermit_tile", { player, from: r.from, to: r.to }));
                                    break;
                                default:
                                    node.push(r.what === undefined
                                        ? i18next.t("apresults:MOVE.nowhat", { player, from: r.from, to: r.to })
                                        : i18next.t("apresults:MOVE.complete_what", { player, what: r.what, from: r.from, to: r.to }));
                            }
                            break;
                        }
                        case "place":
                            switch (r.how) {
                                case "cups-own":
                                    node.push(i18next.t("apresults:PLACE.gnostica_own", { player, where: r.where }));
                                    break;
                                case "cups-enemy": {
                                    const target = this.otherPlayerName(r.who, player, players);
                                    node.push(target === undefined
                                        ? i18next.t("apresults:PLACE.gnostica_enemy", { player, where: r.where })
                                        : i18next.t("apresults:PLACE.gnostica_enemy_target", { player, where: r.where, target }));
                                    break;
                                }
                                case "territory":
                                    node.push(i18next.t("apresults:PLACE.gnostica_territory", { player, where: r.where, what: this.cardDisplayName(r.what) }));
                                    break;
                                case "initial":
                                    node.push(i18next.t("apresults:PLACE.gnostica_initial", { player, where: r.where }));
                                    break;
                                case "discard":
                                    node.push(i18next.t("apresults:PLACE.gnostica_discard", { player, what: r.what }));
                                    break;
                                default:
                                    node.push(r.what === undefined
                                        ? i18next.t("apresults:PLACE.nowhat", { player, where: r.where })
                                        : i18next.t("apresults:PLACE.complete", { player, what: r.what, where: r.where }));
                            }
                            break;
                        case "convert":
                            if (r.into.startsWith("size ")) {
                                // Discs' own growth and Swords' own attack
                                // shrink both land here (same "size N"
                                // what/into shape) - the numbers themselves
                                // say which direction actually happened.
                                const grew = parseInt(r.into.slice(5), 10) > parseInt(r.what.slice(5), 10);
                                // Both growth (Discs) and shrinking
                                // (Swords) can target an enemy's piece,
                                // not just the acting player's own - name
                                // whose, same _own/target split as
                                // DESTROY's.
                                const target = this.otherPlayerName(r.who, player, players);
                                if (grew) {
                                    node.push(target === undefined
                                        ? i18next.t("apresults:CONVERT.gnostica_piece_own", { player, into: r.into, where: r.where })
                                        : i18next.t("apresults:CONVERT.gnostica_piece", { player, into: r.into, where: r.where, target }));
                                } else {
                                    node.push(target === undefined
                                        ? i18next.t("apresults:CONVERT.gnostica_piece_shrink_own", { player, into: r.into, where: r.where })
                                        : i18next.t("apresults:CONVERT.gnostica_piece_shrink", { player, into: r.into, where: r.where, target }));
                                }
                            } else if (r.into.startsWith("owner-")) {
                                const target = this.otherPlayerName(r.who, player, players);
                                node.push(target === undefined
                                    ? i18next.t("apresults:CONVERT.gnostica_hierophant", { player, where: r.where })
                                    : i18next.t("apresults:CONVERT.gnostica_hierophant_target", { player, where: r.where, target }));
                            } else {
                                // Discs' own grow-replace and Swords' own
                                // attack-and-replace both land here (same
                                // what/into/where shape) - point value is
                                // the only thing distinguishing which
                                // direction actually happened.
                                const before = allCards().find(c => c.uid === r.what);
                                const after = allCards().find(c => c.uid === r.into);
                                const grew = before !== undefined && after !== undefined && cardPointValue(after) > cardPointValue(before);
                                const key = grew ? "apresults:CONVERT.gnostica_tile" : "apresults:CONVERT.gnostica_tile_shrink";
                                node.push(i18next.t(key, { player, what: this.cardDisplayName(r.what), into: this.cardDisplayName(r.into), where: r.where }));
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

