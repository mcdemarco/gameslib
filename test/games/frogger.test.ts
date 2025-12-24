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
        expect(g.parseMove("8MS")).to.deep.equal({
            card: "8MS",
            forward: false,
            incomplete: false,
            refill: false,
            valid: true
        });
    });

    it ("Does character validation on parse", () => {
        expect(g.parseMove("7MSaaa:c5")).to.have.deep.property("valid", false);
        expect(g.parseMove("7MS:n5-n6!")).to.have.deep.property("valid", false);
        expect(g.parseMove("7MS:n5-o4")).to.have.deep.property("valid", false);
        expect(g.parseMove("7MS:b5-cc4!")).to.have.deep.property("valid", false);
        expect(g.parseMove("7MS:b55-c4")).to.have.deep.property("valid", false);
        expect(g.parseMove("7MSPQRS:b5-c4!")).to.have.deep.property("valid", false);
        expect(g.parseMove("M7SLST")).to.have.deep.property("valid", false);
        expect(g.parseMove("d2-e2,7MSPQRS")).to.have.deep.property("valid", false);
    });

    it ("Does structural validation on parse", () => {
        expect(g.parseMove("7MS:m5-m6,6MS!")).to.have.deep.property("valid", false);
        expect(g.parseMove("7MS,m5-m6,6MS!")).to.have.deep.property("valid", false);
        expect(g.parseMove("7MS:m5-m6:6MS")).to.have.deep.property("valid", false);
        expect(g.parseMove("7MS;m5*m6")).to.have.deep.property("valid", false);            
        expect(g.parseMove("7MS;m5-n6")).to.have.deep.property("valid", false);            
        expect(g.parseMove("7MS-m5")).to.have.deep.property("valid", false);            
        expect(g.parseMove("c2-,1M!")).to.have.deep.property("valid", false);
        expect(g.parseMove("c2,1M!")).to.have.deep.property("valid", false);
        expect(g.parseMove("c2-d2-e2")).to.have.deep.property("valid", false);
    });

    it ("Does character validation on validate", () => {
        expect(g.validateMove("7MSaaa:c5")).to.have.deep.property("valid", false);
        expect(g.validateMove("7MS:n5-n6!")).to.have.deep.property("valid", false);
        expect(g.validateMove("7MS:n5-o4")).to.have.deep.property("valid", false);
        expect(g.validateMove("7MS:b5-cc4!")).to.have.deep.property("valid", false);
        expect(g.validateMove("7MS:b55-c4")).to.have.deep.property("valid", false);
        expect(g.validateMove("7MSPQRS:b5-c4!")).to.have.deep.property("valid", false);
        expect(g.validateMove("M7SLST")).to.have.deep.property("valid", false);
        expect(g.validateMove("d2-e2,7MSPQRS")).to.have.deep.property("valid", false);
    });

    it ("Does structural validation on validate", () => {
        expect(g.validateMove("8MS:m2-n3,9MS!")).to.have.deep.property("valid", false);
        expect(g.validateMove("8MS,m2-n3,9MS!")).to.have.deep.property("valid", false);
        expect(g.validateMove("8MS:m2-n3:9MS")).to.have.deep.property("valid", false);
        expect(g.validateMove("8MS;m2*n3")).to.have.deep.property("valid", false);            
        expect(g.validateMove("8MS;m2-n3")).to.have.deep.property("valid", false);            
        expect(g.validateMove("8MS-m5")).to.have.deep.property("valid", false);            
        expect(g.validateMove("c2-,1M!")).to.have.deep.property("valid", false);
        expect(g.validateMove("c2,1M!")).to.have.deep.property("valid", false);
        expect(g.validateMove("c2-d2-e2")).to.have.deep.property("valid", false);
    });

    it ("Does semantic validation on validate", () => {
        //This is only semantic in that non-existent cards won't be in anyone's hand.
        expect(g.validateMove("7MS:b2-c3")).to.have.deep.property("valid", false);
        //Non-existent cards also won't be in the market.
        expect(g.validateMove("d2-c3,9MV")).to.have.deep.property("valid", false);
        //Set up a 2p base game, so cells a4-n4 are disallowed.
        expect(g.validateMove("8MS:f2-g4")).to.have.deep.property("valid", false);
        //Cells a5-n5 are off the board.
        expect(g.validateMove("8MS:f2-g5")).to.have.deep.property("valid", false);
    });
});

