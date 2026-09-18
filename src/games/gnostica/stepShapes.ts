// Pure completeness check for each power step kind's own IStep grammar (never legality); deriveMinorMode/deriveHermitMode below do the same for raw tokens.
import { SpecialPower } from "./majorArcana";
import type { IStep } from "../gnostica";

export interface MinorModeConfig {
    label: string;
    shape: "cell" | "piece";
    minArgs: number;
    // The IStep-field-presence equivalent of minArgs, used by primitiveStepShape below; minArgs itself stays in use for click-handling's own slicing.
    isComplete: (step: IStep) => boolean;
}

// The four minor-arcana suits, shared by gnostica.ts and randomMove.ts so neither imports a value from the other.
export const ALL_SUITS: { uid: string; label: string }[] = [
    { uid: "C", label: "Cups" },
    { uid: "R", label: "Rods" },
    { uid: "D", label: "Discs" },
    { uid: "S", label: "Swords" },
];

// One entry per suit+mode: button label, cell-vs-piece target shape, and the minimum tokens before a step is complete.
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

// Hermit isn't suit-shaped, so it gets its own tiny mode table rather than a MINOR_MODES slot - label only, its click handler manages stages directly.
export const HERMIT_MODES: Record<string, { label: string }> = {
    piece: { label: "Move Piece" },
    tile: { label: "Push Territory" },
};

// Three-way, not boolean, since a given token can be actively WRONG (malformed) rather than merely absent (incomplete).
export type StepShape =
    | { status: "incomplete" }
    | { status: "malformed"; key: string; params?: Record<string, unknown> }
    | { status: "complete" };

// Cups infers own/enemy/new from its argument's own shape (no mode word); Rods/Discs/Swords infer piece-vs-tile from a pips suffix on their verb's argument.
const RDS_VERBS: Record<string, string> = { R: "move", D: "grow", S: "shrink" };
const PIECE_WITH_PIPS_RE = /^[a-z]{1,2}-?\d+\.[1-3](\.[neswu])?(\.\d+)?$/i;

// A piece mode's own trailing reorientation is optional everywhere it appears, always spelled "orient <direction>".
function trailingOrient(tokens: string[]): string | undefined {
    return tokens[0]?.toLowerCase() === "orient" ? tokens[1] : undefined;
}

// The inverse of deriveMinorMode's Rods/Discs/Swords branch, rebuilding verb-first move-string tokens; shared so gnostica.ts/randomMove.ts don't import from each other.
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
                // Rods' "tile" mode keeps the cell (the minion's own facing cell, written explicitly), then the push distance.
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
            // Discs' "tile" mode keeps the cell and needs a new card uid, spelled "to <uid>", never optional.
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
        // Swords' "tile" mode keeps the cell; its trailing "to <uid>" is genuinely optional - omitted means destroy the tile.
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
        // Nothing after "create" yet - "own"/"enemy" have no empty-arg reading, so this can only be "new" awaiting its card uid.
        return { mode: "new", args: [cellStr] };
    }
    const bare = first.endsWith("?") ? first.slice(0, -1) : first;
    // Victim ref is a full piece ref (PIECE_WITH_PIPS_RE); a card uid never has the mandatory "." pips separator, so no ambiguity.
    const mode = /^[neswu]$/i.test(bare) ? "own" : PIECE_WITH_PIPS_RE.test(bare) ? "enemy" : "new";
    return { mode, args: [cellStr, ...argTokens] };
}

// Hermit's "fly" verb infers piece-vs-tile like Rods/Discs/Swords; "to <destCell>" is mandatory, and "piece" mode may add a trailing orient.
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

// The inverse of deriveHermitMode, rebuilt into verb-first move-string tokens.
export function buildHermitTokens(args: string[]): string[] {
    if (args.length === 1) {
        return ["fly", args[0]];
    }
    if (args.length === 2) {
        return ["fly", args[0], "to", args[1]];
    }
    return ["fly", args[0], "to", args[1], "orient", args[2]];
}

// The IStep-field-based twin of deriveMinorMode above - mode only, reading fields parseMove already resolved rather than re-deriving from tokens.
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
    // "own"/"enemy" have no empty-field reading, so this is "new" either way, same as deriveMinorMode's own fallback.
    return "new";
}

// The IStep-field-based twin of deriveHermitMode; targetCell is reserved exclusively for the destination in both modes.
export function stepHermitMode(step: IStep): string | undefined {
    if (step.action !== "fly") {
        return undefined;
    }
    return step.targetPiece !== undefined ? "piece" : step.card !== undefined ? "tile" : undefined;
}

// A primitive suit step's own grammar - shared by minor-arcana, major-arcana primitive, and Magician-borrowed suit steps alike.
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

// One shape function per SpecialPower; highPriestess/fool have no minionRef of their own but accept anything regardless.
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
    // Dead in practice - a Magician borrow resolves its suit via the head's own "as <suit>" before this table is ever consulted; kept for exhaustiveness.
    magicianChoice: () => ({ status: "complete" }),
    // Dead in practice - the borrowed card is "as <uid>" in the head now; kept for exhaustiveness (and parsePendingStep's pre-"as" walk).
    worldUseAny: () => ({ status: "complete" }),
    // "draw" is mandatory; any count after it (including zero) is complete enough to ATTEMPT - real semantics live in checkJudgementDraw.
    judgementDraw: (step) => step.action === "draw" ? { status: "complete" } : { status: "incomplete" },
    // Matters only to parsePendingStep (apply/validate special-case highPriestess early); its discard list stays editable right up until Submit.
    highPriestess: () => ({ status: "incomplete" }),
    fool: () => ({ status: "incomplete" }),
};
