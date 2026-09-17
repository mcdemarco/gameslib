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

    it("primitiveStepShape: mode undefined is incomplete, short args is incomplete, enough args is complete", () => {
        expect(primitiveStepShape("R", [])).to.deep.equal({ status: "incomplete" });
        expect(primitiveStepShape("R", ["move"])).to.deep.equal({ status: "incomplete" }); // no target/cell yet
        expect(primitiveStepShape("R", ["move", "n0"])).to.deep.equal({ status: "incomplete" }); // tile: cell chosen, distance still needed
        expect(primitiveStepShape("R", ["move", "n0", "1"])).to.deep.equal({ status: "complete" }); // tile: cell + distance
        expect(primitiveStepShape("R", ["move", "m0.1"])).to.deep.equal({ status: "incomplete" }); // piece: target chosen, distance still needed
        expect(primitiveStepShape("R", ["move", "m0.1", "3"])).to.deep.equal({ status: "complete" });
        // No suit spells a mode word anymore - Rods/Discs/Swords infer
        // piece vs tile from their own single verb argument's shape (a
        // piece ref's mandatory pips suffix vs a bare cell/distance), the
        // same way Cups infers own/enemy/new (see its own docs below) -
        // so an unrecognized verb, or an argument of the wrong shape,
        // just reads as still-incomplete; there's no "unknown mode" left
        // for primitiveStepShape to ever report as malformed.
        expect(primitiveStepShape("R", ["nope"])).to.deep.equal({ status: "incomplete" });
        expect(primitiveStepShape("C", [])).to.deep.equal({ status: "incomplete" });
        expect(primitiveStepShape("C", ["at", "m0"])).to.deep.equal({ status: "incomplete" }); // no "create" yet
        expect(primitiveStepShape("C", ["at", "m0", "create"])).to.deep.equal({ status: "incomplete" }); // "new" inferred, still needs a card uid
        expect(primitiveStepShape("C", ["at", "m0", "create", "U"])).to.deep.equal({ status: "complete" }); // "own" inferred from the orientation shape
        expect(primitiveStepShape("C", ["at", "m0", "create", "m0.1"])).to.deep.equal({ status: "complete" }); // "enemy" inferred from the full piece-ref shape
        expect(primitiveStepShape("C", ["at", "m0", "create", "5D"])).to.deep.equal({ status: "complete" }); // "new" inferred from the card-uid shape
    });

    it("SPECIAL_STEP_SHAPES.orientMinion/tradeHands/orientAny/hierophantReplace: fixed arity, table-driven", () => {
        expect(SPECIAL_STEP_SHAPES.orientMinion([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.orientMinion(["U"])).to.deep.equal({ status: "complete" }); // minionRef + orientation = 2 tokens, minionRef already stripped
        expect(SPECIAL_STEP_SHAPES.tradeHands(["trade", "n0.1"])).to.deep.equal({ status: "complete" }); // needs "trade" + targetRef
        expect(SPECIAL_STEP_SHAPES.orientAny(["orient", "n0.1"])).to.deep.equal({ status: "incomplete" }); // needs "orient" + targetRef + orientation
        expect(SPECIAL_STEP_SHAPES.orientAny(["orient", "n0.1", "U"])).to.deep.equal({ status: "complete" });
        expect(SPECIAL_STEP_SHAPES.hierophantReplace(["replace", "n0.1"])).to.deep.equal({ status: "incomplete" }); // needs "replace" + targetRef + orientation, same as orientAny
        expect(SPECIAL_STEP_SHAPES.hierophantReplace(["replace", "n0.1", "U?"])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.hermitTeleport: verb then shape-inferred target/cell + destination, no mode word left to be malformed", () => {
        expect(SPECIAL_STEP_SHAPES.hermitTeleport([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.hermitTeleport(["fly"])).to.deep.equal({ status: "incomplete" }); // no target/cell yet
        expect(SPECIAL_STEP_SHAPES.hermitTeleport(["fly", "m0.1"])).to.deep.equal({ status: "incomplete" }); // target chosen, destination still needed
        expect(SPECIAL_STEP_SHAPES.hermitTeleport(["fly", "m0.1", "to", "n0"])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.magicianChoice: delegates to primitiveStepShape once a valid suit letter is given", () => {
        expect(SPECIAL_STEP_SHAPES.magicianChoice([])).to.deep.equal({ status: "incomplete" });
        expect(SPECIAL_STEP_SHAPES.magicianChoice(["X"])).to.deep.equal({ status: "malformed", key: "BAD_SUIT_LETTER", params: { suitLetter: "X" } });
        expect(SPECIAL_STEP_SHAPES.magicianChoice(["C"])).to.deep.equal({ status: "incomplete" }); // suit chosen, mode not yet
        expect(SPECIAL_STEP_SHAPES.magicianChoice(["C", "at", "m0"])).to.deep.equal({ status: "incomplete" }); // no "create" yet
        expect(SPECIAL_STEP_SHAPES.magicianChoice(["C", "at", "m0", "create", "U"])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.worldUseAny: vestigial - the borrowed card is now 'as <uid>' in the head, so this is never consulted", () => {
        expect(SPECIAL_STEP_SHAPES.worldUseAny([])).to.deep.equal({ status: "complete" });
    });

    it("SPECIAL_STEP_SHAPES.judgementDraw: mandatory 'draw' keyword, then any token count including zero is complete", () => {
        expect(SPECIAL_STEP_SHAPES.judgementDraw([])).to.deep.equal({ status: "incomplete" }); // "draw" not typed yet
        expect(SPECIAL_STEP_SHAPES.judgementDraw(["draw"])).to.deep.equal({ status: "complete" }); // drawing nothing is a legal choice
        expect(SPECIAL_STEP_SHAPES.judgementDraw(["draw", "AS", "2C"])).to.deep.equal({ status: "complete" });
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
