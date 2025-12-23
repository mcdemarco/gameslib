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
            complete: 1,
            forward: true,
            from: "a3",
            to: "b3",
            refill: false
        });
        expect(g.parseMove("c2-b3,8MS")).to.deep.equal({
            card: "8MS",
            complete: 1,
            forward: false,
            from: "c2",
            to: "b3",
            refill: false
        });
        expect(g.parseMove("c2-b3,1M!")).to.deep.equal({
            card: "1M",
            complete: 1,
            forward: false,
            from: "c2",
            to: "b3",
            refill: true
        });
        expect(g.parseMove("c2")).to.deep.equal({
            complete: -1,
            forward: false,
            from: "c2",
            refill: false
        });
     });
       
    it ("Does no validation", () => {
        expect(g.parseMove("7MS:c5")).to.deep.equal({
            card: "7MS",
            complete:-1,
            forward: true,
            from: "c5",
            refill: false
        });
    });
});

