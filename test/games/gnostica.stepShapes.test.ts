import "mocha";
import { expect } from "chai";
import { primitiveStepShape, SPECIAL_STEP_SHAPES } from "../../src/games/gnostica/stepShapes";

describe("Gnostica: stepShapes - shared step-completeness predicates", () => {
    // These functions are the single source of truth apply, validate, and
    // the UI preview walker (parsePendingStep) each consult independently
    // - see stepShapes.ts's own docs on why. Pinned here at the unit level
    // rather than only indirectly through gnostica.test.ts's own apply/
    // validate/click-flow tests, so a regression can't surface as those
    // three quietly disagreeing with each other instead. IStep field
    // presence stands in for "how many tokens have been typed" now -
    // {action:"with"} is parseMove's own sentinel for "verb not typed
    // yet" (see IStep's own docs).

    it("primitiveStepShape: needs a recognized mode for the suit, then defers to parseMove's own complete value", () => {
        // Mode gate: no recognizable mode for this suit's verb reads as incomplete, whatever `complete` says.
        expect(primitiveStepShape("R", { action: "with", complete: 1 })).to.deep.equal({ status: "incomplete" });
        expect(primitiveStepShape("R", { action: "move", complete: 1 })).to.deep.equal({ status: "incomplete" }); // no target/cell
        expect(primitiveStepShape("R", { action: "nope", targetCell: "n0", complete: 1 })).to.deep.equal({ status: "incomplete" });
        expect(primitiveStepShape("D", { action: "move", targetCell: "n0", amount: 1, complete: 0 })).to.deep.equal({ status: "incomplete" }); // wrong verb for the suit
        expect(primitiveStepShape("C", { action: "at", atCell: "m0", complete: 1 })).to.deep.equal({ status: "incomplete" }); // no "create" yet
        // With a mode, completeness is parseMove's: -1 (or absent) still building, 0/1 submittable.
        expect(primitiveStepShape("R", { action: "move", targetCell: "n0" })).to.deep.equal({ status: "incomplete" });
        expect(primitiveStepShape("R", { action: "move", targetCell: "n0", complete: -1 })).to.deep.equal({ status: "incomplete" });
        expect(primitiveStepShape("R", { action: "move", targetCell: "n0", amount: 1, complete: 0 })).to.deep.equal({ status: "complete" });
        expect(primitiveStepShape("R", { action: "move", targetPiece: "m0.1", amount: 3, complete: 1 })).to.deep.equal({ status: "complete" });
        expect(primitiveStepShape("C", { action: "create", atCell: "m0", direction: "U", complete: 1 })).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.orientMinion/tradeHands/orientAny/hierophantReplace: field-presence, table-driven", () => {
        expect(SPECIAL_STEP_SHAPES.orientMinion({ action: "with" })).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.orientMinion({ action: "orient", direction: "U" })).to.deep.equal({ status: "complete" });
        expect(SPECIAL_STEP_SHAPES.tradeHands({ action: "trade", targetPiece: "n0.1" })).to.deep.equal({ status: "complete" });
        expect(SPECIAL_STEP_SHAPES.orientAny({ action: "orient", targetPiece: "n0.1" })).to.deep.equal({ status: "incomplete" }); // target chosen, facing not yet
        expect(SPECIAL_STEP_SHAPES.orientAny({ action: "orient", targetPiece: "n0.1", direction: "U" })).to.deep.equal({ status: "complete" });
        expect(SPECIAL_STEP_SHAPES.hierophantReplace({ action: "replace", targetPiece: "n0.1" })).to.deep.equal({ status: "incomplete" }); // same shape as orientAny
        expect(SPECIAL_STEP_SHAPES.hierophantReplace({ action: "replace", targetPiece: "n0.1", direction: "U?" })).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.hermitTeleport: mode-inferred target/card + destination, no mode word left to be malformed", () => {
        expect(SPECIAL_STEP_SHAPES.hermitTeleport({ action: "with" })).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.hermitTeleport({ action: "fly" })).to.deep.equal({ status: "incomplete" }); // no target/card yet
        expect(SPECIAL_STEP_SHAPES.hermitTeleport({ action: "fly", targetPiece: "m0.1" })).to.deep.equal({ status: "incomplete" }); // target chosen, destination still needed
        expect(SPECIAL_STEP_SHAPES.hermitTeleport({ action: "fly", targetPiece: "m0.1", targetCell: "n0" })).to.deep.equal({ status: "complete" });
        // "tile" mode's own source is the moved territory's own card uid,
        // not a cell (see buildHermitStepFromArgs's own docs).
        expect(SPECIAL_STEP_SHAPES.hermitTeleport({ action: "fly", card: "5D" })).to.deep.equal({ status: "incomplete" }); // source chosen, destination still needed
        expect(SPECIAL_STEP_SHAPES.hermitTeleport({ action: "fly", card: "5D", targetCell: "n0" })).to.deep.equal({ status: "complete" });
    });

    // A Magician borrow now resolves its suit via the head's own "as
    // <suit>" before apply/validate/parsePendingStep ever reach the
    // shared dispatch (see applyPowerStep's/validatePowerStep's own
    // docs), which then checks the step exactly like an ordinary suit
    // primitive - primitiveStepShape(suitUid, step), not through this
    // table at all. This entry is unreachable in practice now; kept only
    // for Record<SpecialPower> exhaustiveness, always reporting complete
    // regardless of input.
    it("SPECIAL_STEP_SHAPES.magicianChoice: dead in practice now - always complete", () => {
        expect(SPECIAL_STEP_SHAPES.magicianChoice({ action: "with" })).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.worldUseAny: vestigial - the borrowed card is now 'as <uid>' in the head, so this is never consulted", () => {
        expect(SPECIAL_STEP_SHAPES.worldUseAny({ action: "with" })).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.judgementDraw: mandatory 'draw' keyword, then any card count including zero is complete", () => {
        expect(SPECIAL_STEP_SHAPES.judgementDraw({ action: "with" })).to.deep.equal({ status: "incomplete" }); // "draw" not typed yet
        expect(SPECIAL_STEP_SHAPES.judgementDraw({ action: "draw" })).to.deep.equal({ status: "complete" }); // drawing nothing is a legal choice
        expect(SPECIAL_STEP_SHAPES.judgementDraw({ action: "draw", cardList: ["AS", "2C"] })).to.deep.equal({ status: "complete" });
    });

    // highPriestess/fool are handled by an EARLY special-case in both
    // applyPowerStep and validatePowerStep, so their entries here are
    // consulted ONLY by parsePendingStep (the UI walker) - never by apply/
    // validate. For highPriestess specifically, "complete" would be WRONG
    // there: its discard list has no fixed grammar boundary and must stay
    // editable (toggle cards, pick a draw count) right up until Submit, so
    // the generic same-call "walk past" mechanism must never fire for it,
    // regardless of how much of the step is already filled in.
    it("SPECIAL_STEP_SHAPES.highPriestess/fool: always incomplete, regardless of the step's own fields", () => {
        expect(SPECIAL_STEP_SHAPES.highPriestess({ action: "with" })).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.highPriestess({ action: "discard", cardList: ["AS", "2C"], amount: 3 })).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.fool({ action: "with" })).to.deep.equal({ status: "incomplete" });
    });
});
