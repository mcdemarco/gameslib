// Pure, side-effect-free description of each major-arcana power step
// kind's own grammar. Answers ONLY "given this step's own IStep fields,
// is it complete enough to act on yet" (primitiveStepShape/
// SPECIAL_STEP_SHAPES) - never touches game state, never checks whether a
// target is actually LEGAL (that's powers.ts's checkX job, run separately
// by apply/validate once this says "complete"). The token-based
// deriveMinorMode/deriveHermitMode below answer a related but distinct
// question - "what mode+args does this ALREADY-COMPLETE raw token list
// mean" - for the click-building/message side, which still works in
// tokens rather than a parsed IStep.
//
// Before this file existed, the completeness question was answered
// independently - with the same MINOR_MODES.minArgs numbers, but a
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
import type { IStep } from "../gnostica";

export interface MinorModeConfig {
    label: string;
    shape: "cell" | "piece";
    minArgs: number;
    // The IStep-field-presence equivalent of minArgs, used by the shared
    // apply/validate/parsePendingStep completeness check (primitiveStepShape
    // below) - minArgs itself stays in use separately, for click-handling's
    // own positional pending.rest slicing (gnostica.ts, unaffected by this).
    isComplete: (step: IStep) => boolean;
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
        own: { label: "Create Minion", shape: "cell", minArgs: 2, isComplete: (s) => s.atCell !== undefined && s.direction !== undefined },
        enemy: { label: "Create Enemy", shape: "cell", minArgs: 2, isComplete: (s) => s.atCell !== undefined && s.targetPiece !== undefined },
        new: { label: "Create Territory", shape: "cell", minArgs: 2, isComplete: (s) => s.atCell !== undefined && s.card !== undefined },
    },
    R: {
        piece: { label: "Move Piece", shape: "piece", minArgs: 2, isComplete: (s) => s.targetPiece !== undefined && s.amount !== undefined },
        tile: { label: "Push Territory", shape: "cell", minArgs: 2, isComplete: (s) => s.targetCell !== undefined && s.amount !== undefined },
    },
    D: {
        piece: { label: "Grow Piece", shape: "piece", minArgs: 1, isComplete: (s) => s.targetPiece !== undefined },
        tile: { label: "Grow Territory", shape: "cell", minArgs: 2, isComplete: (s) => s.targetCell !== undefined && s.card !== undefined },
    },
    S: {
        piece: { label: "Attack Piece", shape: "piece", minArgs: 2, isComplete: (s) => s.targetPiece !== undefined && s.amount !== undefined },
        tile: { label: "Attack Territory", shape: "cell", minArgs: 2, isComplete: (s) => s.targetCell !== undefined && s.amount !== undefined },
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

// Every OTHER suit still spells its mode explicitly as rest[0] ("own"/
// "enemy"/"new", "piece"/"tile" - not yet converted to the new grammar).
// Cups alone carries no mode word: "at <cell> create <arg>..." infers
// own/enemy/new from <arg>'s own shape once "at"/"create" are stripped -
// an orientation letter (own), a full piece ref naming the victim (enemy -
// see pieceRefStr's own docs; the "at <cell>" already named, cell and
// all, for readability, not just its own trailing pips - #106), or
// anything else, trusted as a card uid the same way an explicit mode
// word always was (new). Shared by every call site below that used to just
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
        if (suitUid === "R") {
            const targetOrCell = rest[1];
            const isPiece = PIECE_WITH_PIPS_RE.test(targetOrCell);
            if (!isPiece) {
                // Rods' own "tile" mode keeps the cell - the territory
                // being pushed, always the minion's own facing cell, but
                // written explicitly like every other suit's "tile" mode
                // (see checkMoveTerritory's own docs) - then the push
                // distance.
                const distStr = rest[2];
                return { mode: "tile", args: distStr === undefined ? [targetOrCell] : [targetOrCell, distStr] };
            }
            const targetRef = targetOrCell;
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
    // The victim ref is now a full piece ref (its own cell, pips, and
    // qualifiers - #106), the same PIECE_WITH_PIPS_RE-recognized shape
    // Rods/Discs/Swords already use to tell "a specific piece" apart from
    // everything else - a rank-2/3 card uid ("2S", "3C", ...) never has
    // the mandatory "." pips separator, so there's no ambiguity to guard
    // against here the way a bare digit once needed.
    const mode = /^[neswu]$/i.test(bare) ? "own" : PIECE_WITH_PIPS_RE.test(bare) ? "enemy" : "new";
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
// verb-first move-string tokens.
export function buildHermitTokens(args: string[]): string[] {
    if (args.length === 1) {
        return ["fly", args[0]];
    }
    if (args.length === 2) {
        return ["fly", args[0], "to", args[1]];
    }
    return ["fly", args[0], "to", args[1], "orient", args[2]];
}

// The IStep-field-based twin of deriveMinorMode above - mode only, no
// args, since apply/validate/parsePendingStep all read fields off the
// IStep directly now rather than re-deriving positional args from it.
// Rods/Discs/Swords: piece vs tile is just whichever of targetPiece/
// targetCell parseMove itself already populated (no more shape-testing a
// raw token - PIECE_WITH_PIPS_RE stays deriveMinorMode's own tool, for
// its own token-based callers only). Cups: own/enemy/new is direction/
// targetPiece/neither, identical in spirit to deriveMinorMode's own
// shape-test, just reading the field parseMove already resolved it into
// instead of re-testing the raw token's own shape.
export function stepMinorMode(suitUid: string, step: IStep): string | undefined {
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
    // Nothing after "create" yet (or a card uid already chosen) - "own"/
    // "enemy" have no empty-field reading at all, so this is "new" either
    // way, same as deriveMinorMode's own identical fallback.
    return "new";
}

// The IStep-field-based twin of deriveHermitMode above. Hermit's own
// source is a piece ref (targetPiece) in "piece" mode, or the moved
// tile's own card uid (`card` - see buildHermitStepFromArgs's own docs on
// why "tile" mode's source is never a bare cell) in "tile" mode;
// `targetCell` is reserved exclusively for the destination in both.
export function stepHermitMode(step: IStep): string | undefined {
    if (step.action !== "fly") {
        return undefined;
    }
    return step.targetPiece !== undefined ? "piece" : step.card !== undefined ? "tile" : undefined;
}

// A primitive suit step's own grammar. Shared by an ordinary minor-arcana
// card's single step, a major-arcana card's own primitive step, AND a
// Magician-borrowed suit's step (once its suit letter - "as <suit>" in
// the head, resolved before this is ever called - decides `suitUid`; the
// step's own fields need no splicing, since "at m0 create U" parses
// identically regardless of which suit turns out to be borrowed).
export function primitiveStepShape(suitUid: string, step: IStep): StepShape {
    const mode = stepMinorMode(suitUid, step);
    if (mode === undefined) {
        return { status: "incomplete" };
    }
    const config = MINOR_MODES[suitUid]?.[mode];
    if (config === undefined) {
        return { status: "malformed", key: "BAD_MODE", params: { mode, suit: suitUid } };
    }
    return config.isComplete(step) ? { status: "complete" } : { status: "incomplete" };
}

// One shape function per SpecialPower, covering every special step's own
// grammar - highPriestess/fool have no minionRef of their own, but their
// own shape functions accept anything regardless.
export const SPECIAL_STEP_SHAPES: Record<SpecialPower, (step: IStep) => StepShape> = {
    orientMinion: (step) => step.direction !== undefined ? { status: "complete" } : { status: "incomplete" },
    tradeHands: (step) => step.targetPiece !== undefined ? { status: "complete" } : { status: "incomplete" },
    orientAny: (step) => step.targetPiece !== undefined && step.direction !== undefined ? { status: "complete" } : { status: "incomplete" },
    hierophantReplace: (step) => step.targetPiece !== undefined && step.direction !== undefined ? { status: "complete" } : { status: "incomplete" },
    hermitTeleport: (step) => {
        const mode = stepHermitMode(step);
        if (mode === undefined) {
            return { status: "incomplete" };
        }
        return step.targetCell !== undefined ? { status: "complete" } : { status: "incomplete" };
    },
    // Dead in practice now - a Magician borrow resolves its suit via the
    // head's own "as <suit>" before apply/validate ever reach the shared
    // dispatch (see applyPowerStep/validatePowerStep's own docs), so a
    // magicianChoice step is handled there exactly like an ordinary suit
    // primitive (primitiveStepShape with suitUid = the borrowed suit) and
    // this entry is never actually consulted. Kept only for
    // Record<SpecialPower> exhaustiveness.
    magicianChoice: () => ({ status: "complete" }),
    // worldUseAny takes no segment of its own now (the borrowed card is
    // "as <uid>" in the head), so apply/validate handle it before this
    // table is ever consulted. Kept for Record<SpecialPower> exhaustiveness
    // and the one dead path that still reaches it: parsePendingStep
    // walking a hand-typed pre-"as" string, where "complete" just lets the
    // walk step cleanly past it (the submit is rejected anyway).
    worldUseAny: () => ({ status: "complete" }),
    // The literal "draw" keyword is mandatory (same as "with" itself);
    // once present, any further count (including zero - drawing nothing
    // is a legal choice) is complete enough to ATTEMPT - the real
    // semantics live entirely in checkJudgementDraw. This function IS
    // consulted at apply/validate time for judgementDraw (unlike the two
    // below): "complete" just means "ready to check for real," not "no
    // more tokens could ever follow."
    judgementDraw: (step) => step.action === "draw" ? { status: "complete" } : { status: "incomplete" },
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
    // here purely for consistency.
    highPriestess: () => ({ status: "incomplete" }),
    fool: () => ({ status: "incomplete" }),
};
