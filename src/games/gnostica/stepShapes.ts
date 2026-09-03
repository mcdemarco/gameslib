// Pure, side-effect-free description of each major-arcana power step
// kind's own token grammar. Answers ONLY "given these tokens (after any
// leading minionRef has already been stripped), is this step's segment
// complete enough to act on yet" - never touches game state, never
// checks whether a target is actually LEGAL (that's powers.ts's checkX
// job, run separately by apply/validate once this says "complete").
//
// Before this file existed, that question was answered independently -
// with the same MINOR_MODES.minArgs/SPECIAL_MIN_TOKENS numbers, but a
// separate hand-written if-statement each time - in six-plus places
// across gnostica.ts: applyPowerStep's primitive branch, its shared
// 4-special pre-check, its own inline hermitTeleport/worldUseAny cases,
// applyMagicianChoice's own ladder, and validatePowerStep/
// validateMinorPower/parsePendingStep's own copies of every one of
// those. Every one of those copies had to independently agree, and
// several rounds of bugs traced back to exactly two of them silently
// drifting apart. Apply, validate, and the UI preview walker
// (parsePendingStep) each call the functions below directly and
// independently - none of the three calls another to answer this
// question.
import { SpecialPower } from "./majorArcana";

export interface MinorModeConfig {
    label: string;
    shape: "cell" | "piece" | "none";
    minArgs: number;
}

// Click support for minor arcana's single suit-power step (major
// arcana's own primitive steps reuse this same table). One entry per
// suit+mode: the button label, whether the mode's target is a whole
// cell (assertValidCellTarget) or a specific piece within one
// (assertValidPieceTarget, which additionally always allows self
// regardless of facing), and the minimum number of tokens after
// "<minionRef> <mode>" needed before a step is complete enough to act
// on rather than still-in-progress. Trailing optional args (a
// reorientation after acting on your own piece) are deliberately not
// counted here, and not click-driven this pass either - every mode is
// fully usable without one, just not adjustable by click.
export const MINOR_MODES: Record<string, Record<string, MinorModeConfig>> = {
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
// it), so it gets its own tiny two-entry mode table rather than a slot
// in MINOR_MODES - button label only; shape/minArgs aren't needed here
// since hermitTeleport's own click handler manages its stages directly
// rather than going through legalMinorModes/buildStepModeMove.
export const HERMIT_MODES: Record<string, { label: string }> = {
    piece: { label: "Move Piece" },
    tile: { label: "Push Territory" },
};

// Minimum token count (including the leading minionRef, except
// highPriestess which has none) for a `special` step to be complete.
// orientMinion/tradeHands/orientAny/hierophantReplace have a real, fixed
// count once complete, so SPECIAL_STEP_SHAPES below builds their own
// entries directly from this table (the only entries anything still
// reads programmatically). The rest have variable-length grammars with
// no single fixed "complete" token count - their own SPECIAL_STEP_SHAPES
// entries answer the question directly instead, without consulting this
// table at all; their own Infinity values here are documentation only,
// preserved for reference against the numbers those entries derive from.
export const SPECIAL_MIN_TOKENS: Record<SpecialPower, number> = {
    orientMinion: 2,      // minionRef + orientation
    tradeHands: 2,        // minionRef + targetRef
    orientAny: 3,         // minionRef + targetRef + orientation
    hierophantReplace: 3, // minionRef + targetRef + orientation
    magicianChoice: Infinity,
    hermitTeleport: Infinity,
    judgementDraw: Infinity,
    highPriestess: Infinity,
    fool: Infinity,
    // <minionRef> <cardUid> - World's own push is informationally free
    // (no forced pause), so a fully-typed segment can legitimately be
    // followed by the pushed frame's own first step in the same move
    // string.
    worldUseAny: 2,
};

// The result of asking "is this step's own token grammar complete
// enough to act on" - three-way, not a boolean, because an
// already-given token can be actively WRONG (a bad mode name, a bad
// suit letter) rather than merely absent, and callers need to tell
// those apart: "malformed" means throw/fail now; "incomplete" means
// quietly wait for more input; "complete" means proceed to the real
// (separate) legality check.
export type StepShape =
    | { status: "incomplete" }
    | { status: "malformed"; key: string; params?: Record<string, unknown> }
    | { status: "complete" };

const fixedArity = (n: number) => (rest: string[]): StepShape =>
    rest.length < n ? { status: "incomplete" } : { status: "complete" };

// A primitive suit step's own grammar: <mode> <args...>. Shared by an
// ordinary minor-arcana card's single step, a major-arcana card's own
// primitive step, AND magicianChoice's stage-2 grammar once its suit
// letter is known - see SPECIAL_STEP_SHAPES.magicianChoice below.
export function primitiveStepShape(suitUid: string, rest: string[]): StepShape {
    const [mode, ...args] = rest;
    if (mode === undefined) {
        return { status: "incomplete" };
    }
    const config = MINOR_MODES[suitUid]?.[mode];
    if (config === undefined) {
        return { status: "malformed", key: "BAD_MODE", params: { mode, suit: suitUid } };
    }
    if (args.length < config.minArgs) {
        return { status: "incomplete" };
    }
    return { status: "complete" };
}

// One shape function per SpecialPower, covering every special step's
// own grammar after its leading minionRef (already stripped by the
// caller) - highPriestess/fool have no minionRef to strip in the first
// place, but their own callers pass tokens unmodified either way since
// both shape functions accept anything.
export const SPECIAL_STEP_SHAPES: Record<SpecialPower, (rest: string[]) => StepShape> = {
    orientMinion: fixedArity(SPECIAL_MIN_TOKENS.orientMinion - 1),
    tradeHands: fixedArity(SPECIAL_MIN_TOKENS.tradeHands - 1),
    orientAny: fixedArity(SPECIAL_MIN_TOKENS.orientAny - 1),
    hierophantReplace: fixedArity(SPECIAL_MIN_TOKENS.hierophantReplace - 1),
    hermitTeleport: (rest) => {
        const [mode, ...args] = rest;
        if (mode === undefined) {
            return { status: "incomplete" };
        }
        if (mode !== "piece" && mode !== "tile") {
            return { status: "malformed", key: "BAD_MODE", params: { mode, suit: "Hermit" } };
        }
        return args.length < 2 ? { status: "incomplete" } : { status: "complete" };
    },
    magicianChoice: (rest) => {
        const [suitLetter, ...moreRest] = rest;
        if (suitLetter === undefined) {
            return { status: "incomplete" };
        }
        if (MINOR_MODES[suitLetter] === undefined) {
            return { status: "malformed", key: "BAD_SUIT_LETTER", params: { suitLetter } };
        }
        // The suit's own grammar, one token in - magicianChoice's suit
        // choice is really just an extra leading token in front of that
        // suit's ordinary primitive grammar.
        return primitiveStepShape(suitLetter, moreRest);
    },
    worldUseAny: (rest) => rest.length === 0 ? { status: "incomplete" } : { status: "complete" },
    // Any token count (including zero) is legal to ATTEMPT - the real
    // semantics live entirely in checkJudgementDraw - but that's an
    // apply/validate-only question (this function IS consulted there
    // for judgementDraw, unlike the two below): "complete" just means
    // "ready to check for real," not "no more tokens could ever follow."
    judgementDraw: () => ({ status: "complete" }),
    // Unlike judgementDraw, applyPowerStep/validatePowerStep both
    // special-case highPriestess and fool EARLY, before ever reaching
    // the generic dispatch that consults this table - so these two
    // entries matter ONLY to parsePendingStep (the UI walker), never to
    // apply/validate. For highPriestess, "incomplete" - always - is the
    // right answer THERE: its discard list has no fixed grammar boundary
    // and stays continuously editable (toggle cards, pick a draw count)
    // right up until Submit, so it must never be treated as "complete,
    // walk past" by the generic same-call chaining mechanism the way a
    // primitive step's fixed args are. fool is unreachable in practice
    // regardless (every caller short-circuits on a fool step before ever
    // asking its shape - see walkFrameStack's own docs) - "incomplete"
    // here purely for consistency with its own SPECIAL_MIN_TOKENS entry.
    highPriestess: () => ({ status: "incomplete" }),
    fool: () => ({ status: "incomplete" }),
};
