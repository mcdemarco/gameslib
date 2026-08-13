/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import { majorCards } from "../../src/common/tarot";
import { MAJOR_ARCANA, MAJOR_ARCANA_ICONS, getMajorArcanaIcons, getMajorArcanaDef } from "../../src/games/gnostica/majorArcana";

describe("Gnostica major arcana", () => {
    it("has a definition for every major arcana card, 1-3 icons each, matching power-step count", () => {
        for (const card of majorCards) {
            const def = MAJOR_ARCANA[card.uid];
            expect(def, `missing definition for ${card.uid} (${card.name})`).to.not.be.undefined;
            expect(def.icons.length).to.be.within(1, 3);
            expect(def.powers.length).to.equal(def.icons.length);
            for (const icon of def.icons) {
                expect(icon).to.match(/^gnostica-/);
            }
        }
    });

    it("has no stray entries for uids that don't exist", () => {
        const validUids = new Set(majorCards.map(c => c.uid));
        for (const uid of Object.keys(MAJOR_ARCANA)) {
            expect(validUids.has(uid), `unexpected uid ${uid} in MAJOR_ARCANA`).to.be.true;
        }
    });

    it("getMajorArcanaDef/getMajorArcanaIcons look up by card", () => {
        const fool = majorCards.find(c => c.seq === 0)!;
        expect(getMajorArcanaIcons(fool)).to.deep.equal(["gnostica-cardQuestion", "gnostica-cardQuestion"]);
        expect(getMajorArcanaDef(fool).powers).to.deep.equal([{ special: "fool" }, { special: "fool" }]);
        expect(MAJOR_ARCANA_ICONS["00"]).to.deep.equal(["gnostica-cardQuestion", "gnostica-cardQuestion"]);
    });

    it("flags the three same-target-shortcut cards (Chariot, Strength, Death) plus Sun", () => {
        const shortcuts = Object.values(MAJOR_ARCANA).filter(d => d.sameTargetShortcut).map(d => d.name).sort();
        expect(shortcuts).to.deep.equal(["Death", "Strength", "The Chariot", "The Sun"].sort());
    });

    it("flags only the Moon with a capacity exemption", () => {
        const exempt = Object.values(MAJOR_ARCANA).filter(d => d.moonCapacityExemption).map(d => d.name);
        expect(exempt).to.deep.equal(["The Moon"]);
    });

    it("matches every primitive-based power step to one of the four suit primitives", () => {
        const primitives = new Set(["create", "move", "grow", "attack"]);
        for (const def of Object.values(MAJOR_ARCANA)) {
            for (const step of def.powers) {
                if ("primitive" in step) {
                    expect(primitives.has(step.primitive), `${def.name}: unknown primitive ${step.primitive}`).to.be.true;
                }
            }
        }
    });

    it("Devil is the only card with three power steps, all orientAny", () => {
        const devil = MAJOR_ARCANA["15"];
        expect(devil.powers.length).eq(3);
        expect(devil.powers.every(s => "special" in s && s.special === "orientAny")).to.be.true;
        const others = Object.values(MAJOR_ARCANA).filter(d => d.uid !== "15");
        for (const def of others) {
            expect(def.powers.length).to.be.lessThan(3);
        }
    });
});
