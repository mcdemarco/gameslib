/* eslint-disable @typescript-eslint/no-unused-expressions */

import "mocha";
import { expect } from "chai";
import { FroggerGame } from '../../src/games';

describe("Frogger", () => {
    const g = new FroggerGame(2);
    it ("Parses single moves", () => {
        // parsing good moves
        expect(g.parseMove("8MS:a3-b3")).to.deep.equal({
            card: "8MS",
            forward: true,
            from: "a3",
            incomplete: false,
            to: "b3",
            refill: false,
            valid: true
        });
        expect(g.parseMove("c2-b3,8MS")).to.deep.equal({
            card: "8MS",
            forward: false,
            from: "c2",
            incomplete: false,
            to: "b3",
            refill: false,
            valid: true
        });
        expect(g.parseMove("c2-b3,1M!")).to.deep.equal({
            card: "1M",
            forward: false,
            from: "c2",
            incomplete: false,
            to: "b3",
            refill: true,
            valid: true
        });
        expect(g.parseMove("c2")).to.deep.equal({
            forward: false,
            from: "c2",
            incomplete: true,
            refill: false,
            valid: true
        });
    });

    it ("Does character validation on parse", () => {
        expect(g.parseMove("7MSaaa:c5")).to.deep.equal({
            card: "7MSaaa",
            forward: true,
            from: "c5",
            incomplete: true,
            refill: false,
            valid: false
        });
        expect(g.parseMove("7MS:o5-o6!")).to.deep.equal({
            forward: false,
            incomplete: false,
            refill: true,
            valid: false
        });
    });

    it ("Does structural validation on parse", () => {
        expect(g.parseMove("7MS:m5-m6,6MS!")).to.deep.equal({
            forward: false,
            incomplete: false,
            refill: true,
            valid: false
        });
        expect(g.parseMove("7MS,m5-m6,6MS!")).to.deep.equal({
            forward: false,
            incomplete: false,
            refill: true,
            valid: false
        });
        expect(g.parseMove("7MS:m5-m6:6MS")).to.deep.equal({
            forward: false,
            incomplete: false,
            refill: false,
            valid: false
        });
        expect(g.parseMove("7MS;m5-m6*6MS")).to.deep.equal({
            forward: false,
            incomplete: false,
            refill: false,
            valid: false
        });
        expect(g.parseMove("c2-,1M!")).to.deep.equal({
            card: "1M",
            forward: false,
            from: "c2",
            incomplete: true,
            refill: true,
            valid: false
        });
        expect(g.parseMove("c2-,1M!")).to.have.deep.property("valid", false);
    });
});

