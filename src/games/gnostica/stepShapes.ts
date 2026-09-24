// Mode inference and completeness checks for each power step kind's own IStep grammar (never legality).
import { SpecialPower } from "./majorArcana";
import type { IStep } from "../gnostica";

// The four minor-arcana suits, shared by gnostica.ts and randomMove.ts so neither imports a value from the other.
export const ALL_SUITS: { uid: string; label: string }[] = [
    { uid: "C", label: "Cups" },
    { uid: "R", label: "Rods" },
    { uid: "D", label: "Discs" },
    { uid: "S", label: "Swords" },
];

// The modes each suit's power can take: Cups infers own/enemy/new from its target, the others piece vs tile.
export const MINOR_MODE_NAMES: Record<string, string[]> = {
    C: ["own", "enemy", "new"],
    R: ["piece", "tile"],
    D: ["piece", "tile"],
    S: ["piece", "tile"],
};

// The target-button wording for Rods/Discs/Swords: the verb prefixing each piece candidate, and the whole-territory option.
export const RDS_TARGET_LABELS: Record<string, { verb: string; tile: string }> = {
    R: { verb: "Move", tile: "Push Territory" },
    D: { verb: "Grow", tile: "Grow Territory" },
    S: { verb: "Attack", tile: "Attack Territory" },
};

// Whether a step has everything its power needs typed yet; legality is the validators' job.
export type StepShape =
    | { status: "incomplete" }
    | { status: "complete" };

// The verb each of Rods/Discs/Swords spells its step with.
export const RDS_VERBS: Record<string, string> = { R: "move", D: "grow", S: "shrink" };

// A suit step's mode (Cups own/enemy/new; the others piece/tile), read from the fields parseMove already resolved; undefined if the action isn't this suit's verb or no target is named.
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
    // "own"/"enemy" have no empty-field reading, so this is "new" either way.
    return "new";
}

// Hermit's mode from the step's fields; targetCell is reserved exclusively for the destination in both modes.
export function stepHermitMode(step: IStep): string | undefined {
    if (step.action !== "fly") {
        return undefined;
    }
    return step.targetPiece !== undefined ? "piece" : step.card !== undefined ? "tile" : undefined;
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
