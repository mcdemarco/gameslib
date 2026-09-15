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
// The four minor-arcana suits - shared by gnostica.ts (button labels,
// magicianChoice's own suit-choice buttons) and randomMove.ts
// (magicianChoice's own random suit pick), living here rather than
// either of those two so neither has to import a value from the other.
export const ALL_SUITS: { uid: string; label: string }[] = [
    { uid: "C", label: "Cups" },
    { uid: "R", label: "Rods" },
    { uid: "D", label: "Discs" },
    { uid: "S", label: "Swords" },
];

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

// Minimum token count (including the leading minionRef, except highPriestess which has none) for a `special` step to be complete - fixedArity's own "at least N" semantics tolerate extra trailing tokens too.
// The rest (Infinity here) have variable-length grammars with their own SPECIAL_STEP_SHAPES entry answering this directly instead.
export const SPECIAL_MIN_TOKENS: Record<SpecialPower, number> = {
    orientMinion: 2,      // minionRef + orientation
    tradeHands: 3,        // minionRef + "trade" + targetRef
    orientAny: 4,         // minionRef + "orient" + targetRef + orientation
    hierophantReplace: 4, // minionRef + "replace" + targetRef + orientation (mandatory, seeded "?" - matches Cups "own")
    magicianChoice: Infinity,
    hermitTeleport: Infinity,
    judgementDraw: Infinity,
    highPriestess: Infinity,
    fool: Infinity,
    // The borrowed card is named "as <uid>" in the head - worldUseAny's
    // own step segment carries nothing, so it never consults this.
    worldUseAny: Infinity,
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

// Every OTHER suit still spells its mode explicitly as rest[0] ("own"/
// "enemy"/"new", "piece"/"tile" - not yet converted to the new grammar).
// Cups alone carries no mode word: "at <cell> create <arg>..." infers
// own/enemy/new from <arg>'s own shape once "at"/"create" are stripped -
// an orientation letter (own), a bare 1-3 pip count (enemy, a victim
// ref's own leading digit - see victimRefStr's own docs), or anything
// else, trusted as a card uid the same way an explicit mode word always
// was (new). Shared by every call site below that used to just
// destructure `rest` directly - undefined here means "still building
// or malformed enough that there's no real mode to report yet," which
// they already treated a missing/bad mode as, so nothing there changes.
// Rods/Discs/Swords each carry one verb in place of a mode word; piece
// vs tile is inferred from whether the verb's first argument names a
// specific piece (a pips suffix present - see PIECE_WITH_PIPS_RE below)
// or a bare cell. PIECE_REF_SHAPE_RE elsewhere treats that suffix as
// optional, which isn't precise enough to tell the two apart here.
const RDS_VERBS: Record<string, string> = { R: "move", D: "grow", S: "shrink" };
const PIECE_WITH_PIPS_RE = /^[a-z]{1,2}-?\d+\.[1-3](\.[neswu])?(\.\d+)?$/i;

// A piece mode's own trailing reorientation is optional everywhere it
// appears (Rods/Discs/Swords), always spelled "orient <direction>".
function trailingOrient(tokens: string[]): string | undefined {
    return tokens[0]?.toLowerCase() === "orient" ? tokens[1] : undefined;
}

// The inverse of deriveMinorMode's own Rods/Discs/Swords branch - given
// the same internal args shape applyRods/applyDiscs/applySwords already
// expect (see their own docs), rebuilds the verb-first move-string
// tokens. Shared by gnostica.ts (echoing back a pending step's move
// string so far) and randomMove.ts (building a random step's tokens
// immediately, not deferred - matching Cups' own precedent), so neither
// has to import a value from the other.
export function buildRdsTokens(suitUid: string, mode: string, args: string[]): string[] {
    const verb = RDS_VERBS[suitUid];
    if (args.length === 0) {
        // Nothing chosen yet - with no argument left to infer a shape
        // from, the verb alone can't tell piece from tile apart (either
        // one can legitimately still be empty here - see
        // buildStepModeMove's own "genuine choice, leave unset" cases),
        // so the mode itself is spelled out as a transient anchor.
        // deriveMinorMode recognizes it and drops it again the instant a
        // real argument arrives.
        return [verb, mode];
    }
    if (suitUid === "R" && mode === "tile") {
        return [verb, ...args];
    }
    const coreCount = suitUid === "D" ? 1 : 2;
    if (args.length <= coreCount) {
        return [verb, ...args];
    }
    const keyword = mode === "piece" ? "orient" : "to";
    return [verb, ...args.slice(0, coreCount), keyword, args[coreCount]];
}

export function deriveMinorMode(suitUid: string, rest: string[]): { mode: string; args: string[] } | undefined {
    const verb = RDS_VERBS[suitUid];
    if (verb !== undefined) {
        if (rest[0]?.toLowerCase() !== verb || rest[1] === undefined) {
            return undefined;
        }
        // The transient "nothing chosen yet" anchor buildRdsTokens writes
        // when there's a genuine choice still to make (see its own docs) -
        // recognized and stripped back down to a real, empty-args mode
        // the moment it's seen, same as every other mode below once its
        // own real argument(s) arrive.
        const anchor = rest[1].toLowerCase();
        if (rest.length === 2 && (anchor === "piece" || anchor === "tile")) {
            return { mode: anchor, args: [] };
        }
        if (suitUid === "R") {
            // Rods' own "tile" mode has no target at all - a "push" always
            // acts on the minion's own facing territory (moveTerritory
            // derives the source purely from its facing), so a bare
            // distance is all that's left after the verb to tell apart
            // from a piece-shaped "move".
            if (!PIECE_WITH_PIPS_RE.test(rest[1])) {
                return { mode: "tile", args: [rest[1]] };
            }
            const targetRef = rest[1];
            const distStr = rest[2];
            if (distStr === undefined) {
                return { mode: "piece", args: [targetRef] };
            }
            const orient = trailingOrient(rest.slice(3));
            return { mode: "piece", args: orient === undefined ? [targetRef, distStr] : [targetRef, distStr, orient] };
        }
        const targetOrCell = rest[1];
        const isPiece = PIECE_WITH_PIPS_RE.test(targetOrCell);
        if (suitUid === "D") {
            if (isPiece) {
                const orient = trailingOrient(rest.slice(2));
                return { mode: "piece", args: orient === undefined ? [targetOrCell] : [targetOrCell, orient] };
            }
            // Discs' own "tile" mode keeps the cell, and needs a new card
            // uid to grow onto it - spelled "to <uid>", never optional.
            if (rest[2]?.toLowerCase() !== "to" || rest[3] === undefined) {
                return { mode: "tile", args: [targetOrCell] };
            }
            return { mode: "tile", args: [targetOrCell, rest[3]] };
        }
        // Swords: both modes carry a pip count right after the target/cell.
        const pipsStr = rest[2];
        if (pipsStr === undefined) {
            return { mode: isPiece ? "piece" : "tile", args: [targetOrCell] };
        }
        if (isPiece) {
            const orient = trailingOrient(rest.slice(3));
            return { mode: "piece", args: orient === undefined ? [targetOrCell, pipsStr] : [targetOrCell, pipsStr, orient] };
        }
        // Swords' own "tile" mode keeps the cell, and its trailing "to
        // <uid>" is genuinely optional - omitted means destroy the tile.
        const uid = rest[3]?.toLowerCase() === "to" ? rest[4] : undefined;
        return { mode: "tile", args: uid === undefined ? [targetOrCell, pipsStr] : [targetOrCell, pipsStr, uid] };
    }
    if (suitUid !== "C") {
        const [mode, ...args] = rest;
        return mode === undefined ? undefined : { mode, args };
    }
    if (rest[0]?.toLowerCase() !== "at" || rest[1] === undefined || rest[2]?.toLowerCase() !== "create") {
        return undefined;
    }
    const cellStr = rest[1];
    const argTokens = rest.slice(3);
    const first = argTokens[0];
    if (first === undefined) {
        // Nothing after "create" yet - "own"/"enemy" have no empty-arg
        // reading at all (there's no such thing as a bare direction or
        // victim ref), so this can only be "new" still waiting on its
        // own card uid (see supplyStepCardUid's own matching docs).
        return { mode: "new", args: [cellStr] };
    }
    const bare = first.endsWith("?") ? first.slice(0, -1) : first;
    // A victim ref's own leading digit is ALWAYS followed by either
    // nothing else or a "." (an orientation/player qualifier) - never a
    // letter glued straight on, which is exactly how a rank-2/3 card uid
    // ("2S", "3C", ...) is shaped instead. Without that distinction,
    // "enemy" would wrongly swallow those uids away from "new".
    const mode = /^[neswu]$/i.test(bare) ? "own" : /^[1-3](\.|$)/.test(bare) ? "enemy" : "new";
    return { mode, args: [cellStr, ...argTokens] };
}

// Hermit isn't suit-shaped (no MINOR_MODES slot - see HERMIT_MODES'
// own docs), but its "fly" verb carries the same piece-vs-tile shape
// inference as Rods/Discs/Swords: a piece-ref target (pips suffix
// present) or a bare cell. Both modes then carry "to <destCell>",
// mandatory (never omitted the way Swords' own "to <uid>" can be) since
// a destination is the entire point of teleporting; "piece" mode alone
// may add an optional trailing "orient <direction>" for the moved
// piece's own new facing.
export function deriveHermitMode(rest: string[]): { mode: string; args: string[] } | undefined {
    if (rest[0]?.toLowerCase() !== "fly" || rest[1] === undefined) {
        return undefined;
    }
    const anchor = rest[1].toLowerCase();
    if (rest.length === 2 && (anchor === "piece" || anchor === "tile")) {
        return { mode: anchor, args: [] };
    }
    const targetOrCell = rest[1];
    const mode = PIECE_WITH_PIPS_RE.test(targetOrCell) ? "piece" : "tile";
    if (rest[2]?.toLowerCase() !== "to" || rest[3] === undefined) {
        return { mode, args: [targetOrCell] };
    }
    const destCell = rest[3];
    if (mode === "tile") {
        return { mode, args: [targetOrCell, destCell] };
    }
    const orient = trailingOrient(rest.slice(4));
    return { mode, args: orient === undefined ? [targetOrCell, destCell] : [targetOrCell, destCell, orient] };
}

// The inverse of deriveHermitMode - same internal args shape
// applyHermitStep/validateHermitStep already expect, rebuilt into
// verb-first move-string tokens. `mode` is only consulted for the
// zero-arg anchor (see buildRdsTokens' own matching docs) - Hermit's
// own click flow never actually leaves it empty (both mode buttons seed
// a default target immediately), but this stays consistent with the
// same "nothing chosen yet" convention regardless.
export function buildHermitTokens(mode: string, args: string[]): string[] {
    if (args.length === 0) {
        return ["fly", mode];
    }
    if (args.length === 1) {
        return ["fly", args[0]];
    }
    if (args.length === 2) {
        return ["fly", args[0], "to", args[1]];
    }
    return ["fly", args[0], "to", args[1], "orient", args[2]];
}

// A primitive suit step's own grammar: <mode> <args...>. Shared by an
// ordinary minor-arcana card's single step, a major-arcana card's own
// primitive step, AND magicianChoice's stage-2 grammar once its suit
// letter is known - see SPECIAL_STEP_SHAPES.magicianChoice below.
export function primitiveStepShape(suitUid: string, rest: string[]): StepShape {
    const derived = deriveMinorMode(suitUid, rest);
    if (derived === undefined) {
        return { status: "incomplete" };
    }
    const { mode, args } = derived;
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
        const derived = deriveHermitMode(rest);
        if (derived === undefined) {
            return { status: "incomplete" };
        }
        return derived.args.length < 2 ? { status: "incomplete" } : { status: "complete" };
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
    // worldUseAny takes no segment of its own now (the borrowed card is
    // "as <uid>" in the head), so apply/validate handle it before this
    // table is ever consulted. Kept for Record<SpecialPower> exhaustiveness
    // and the one dead path that still reaches it: parsePendingStep
    // walking a hand-typed pre-"as" string, where "complete" just lets the
    // walk step cleanly past it (the submit is rejected anyway).
    worldUseAny: () => ({ status: "complete" }),
    // The literal "draw" keyword is mandatory (same as "with" itself);
    // once present, any further token count (including zero - drawing
    // nothing is a legal choice) is complete enough to ATTEMPT - the
    // real semantics live entirely in checkJudgementDraw. This function
    // IS consulted at apply/validate time for judgementDraw (unlike the
    // two below): "complete" just means "ready to check for real," not
    // "no more tokens could ever follow."
    judgementDraw: (rest) => rest[0]?.toLowerCase() === "draw" ? { status: "complete" } : { status: "incomplete" },
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
