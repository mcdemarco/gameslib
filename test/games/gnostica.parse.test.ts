/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import { GnosticaGame } from '../../src/games';

describe("Gnostica parsing", () => {
    const g = new GnosticaGame(3);
    it ("Parses", () => {

        expect(g.validateMove("place m0 U?")).to.have.deep.property("valid", true);

        expect(g.parseMove("place m0 U?")).to.deep.equal({
            announceLast: false,
            head: "place",
            rest: ["m0", "U?"],
            steps: [{
                action: "place",
                direction: "U",
                targetCell: "m0"
            }],
            stepSegments: [],
            valid: true
        });

        g.validateMove("decline 00 via 00");
        //expect(g.validateMove("decline 00 via 00")).to.have.deep.property("valid", true);
        
        expect(g.parseMove("decline 00 via 00")).to.deep.equal({
            announceLast: false,
            head: "decline",
            rest: ["00"],
            steps: [{
                action: "decline",
                card: "00"
            }],
            stepSegments: [],
            valid: true,
            viaUid: "00"
        });
        
        g.validateMove("orient n0.1 N");
        //expect(g.validateMove("orient n0.1 N")).to.have.deep.property("valid", true);
        
        expect(g.parseMove("orient n0.1 N")).to.deep.equal({
            announceLast: false,
            head: "orient",
            rest: ["n0.1", "N"],
            steps: [{
                action: "orient",
                targetPiece: "n0.1",
                direction: "N"
            }],
            stepSegments: [],
            valid: true
        });

        g.validateMove("use 9D/with l1.1 grow l1.1");
        
    });

    it ("Pickles", () => {

    });


});
