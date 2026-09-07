import "mocha";
import { expect } from "chai";
import { primitiveStepShape, SPECIAL_STEP_SHAPES } from "../../src/games/gnostica/stepShapes";

describe("Gnostica: stepShapes - shared step-completeness predicates", () => {
    // These functions are the single source of truth apply, validate, and
    // the UI preview walker (parsePendingStep) each consult independently
    // - see stepShapes.ts's own docs on why. Pinned here at the unit level
    // rather than only indirectly through gnostica.test.ts's own apply/
    // validate/click-flow tests, so a regression can't surface as those
    // three quietly disagreeing with each other instead.

    it("primitiveStepShape: mode undefined is incomplete, unknown mode is malformed, short args is incomplete, enough args is complete", () => {
        expect(primitiveStepShape("C", [])).to.deep.equal({ status: "incomplete" });
        expect(primitiveStepShape("C", ["nope"])).to.deep.equal({ status: "malformed", key: "BAD_MODE", params: { mode: "nope", suit: "C" } });
        expect(primitiveStepShape("C", ["own", "m0"])).to.deep.equal({ status: "incomplete" }); // needs 2 args
        expect(primitiveStepShape("C", ["own", "m0", "U"])).to.deep.equal({ status: "complete" });
        expect(primitiveStepShape("R", ["tile"])).to.deep.equal({ status: "incomplete" }); // needs 1 arg
        expect(primitiveStepShape("R", ["tile", "m0"])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.orientMinion/tradeHands/orientAny/hierophantReplace: fixed arity, table-driven", () => {
        expect(SPECIAL_STEP_SHAPES.orientMinion([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.orientMinion(["U"])).to.deep.equal({ status: "complete" }); // minionRef + orientation = 2 tokens, minionRef already stripped
        expect(SPECIAL_STEP_SHAPES.tradeHands(["n0.1"])).to.deep.equal({ status: "complete" });
        expect(SPECIAL_STEP_SHAPES.orientAny(["n0.1"])).to.deep.equal({ status: "incomplete" }); // needs targetRef + orientation
        expect(SPECIAL_STEP_SHAPES.orientAny(["n0.1", "U"])).to.deep.equal({ status: "complete" });
        expect(SPECIAL_STEP_SHAPES.hierophantReplace(["n0.1", "U"])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.hermitTeleport: mode then 2 more tokens, bad mode is malformed", () => {
        expect(SPECIAL_STEP_SHAPES.hermitTeleport([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.hermitTeleport(["sideways"])).to.deep.equal({ status: "malformed", key: "BAD_MODE", params: { mode: "sideways", suit: "Hermit" } });
        expect(SPECIAL_STEP_SHAPES.hermitTeleport(["piece", "m0.1"])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.hermitTeleport(["piece", "m0.1", "n0"])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.magicianChoice: delegates to primitiveStepShape once a valid suit letter is given", () => {
        expect(SPECIAL_STEP_SHAPES.magicianChoice([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.magicianChoice(["X"])).to.deep.equal({ status: "malformed", key: "BAD_SUIT_LETTER", params: { suitLetter: "X" } });
        expect(SPECIAL_STEP_SHAPES.magicianChoice(["C"])).to.deep.equal({ status: "incomplete" }); // suit chosen, mode not yet
        expect(SPECIAL_STEP_SHAPES.magicianChoice(["C", "own", "m0"])).to.deep.equal({ status: "incomplete" }); // mode chosen, 1 of 2 args
        expect(SPECIAL_STEP_SHAPES.magicianChoice(["C", "own", "m0", "U"])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.worldUseAny: complete as soon as a target uid is given", () => {
        expect(SPECIAL_STEP_SHAPES.worldUseAny([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.worldUseAny(["06"])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.judgementDraw: always complete, any token count including zero", () => {
        expect(SPECIAL_STEP_SHAPES.judgementDraw([])).to.deep.equal({ status: "complete" });
        expect(SPECIAL_STEP_SHAPES.judgementDraw(["AS", "2C"])).to.deep.equal({ status: "complete" });
    });

    // highPriestess/fool are handled by an EARLY special-case in both
    // applyPowerStep and validatePowerStep, so their entries here are
    // consulted ONLY by parsePendingStep (the UI walker) - never by apply/
    // validate. For highPriestess specifically, "complete" would be WRONG
    // there: its discard list has no fixed grammar boundary and must stay
    // editable (toggle cards, pick a draw count) right up until Submit, so
    // the generic same-call "walk past" mechanism must never fire for it,
    // regardless of how many tokens are already present.
    it("SPECIAL_STEP_SHAPES.highPriestess/fool: always incomplete, regardless of token count", () => {
        expect(SPECIAL_STEP_SHAPES.highPriestess([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.highPriestess(["AS", "2C", "draw", "3"])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.fool([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.fool(["fool"])).to.deep.equal({ status: "incomplete" });
    });
});
