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

        expect(g.parseMove("use 9D/with l1.1 grow l1.1")).to.deep.equal({
            "announceLast":false,
            "head":"use",
            "valid":true,
            "steps":[{"action":"use","card":"9D"},{"action":"grow","withPiece":"l1.1","targetPiece":"l1.1"}],
            "rest":["9D"],
            "stepSegments":[["l1.1","grow","l1.1"]]
        });

        expect(g.parseMove("use 9D/with l1.1 grow l1.1")).to.have.deep.property("valid", true);
        expect(g.parseMove("discard AC KS draw 2")).to.have.deep.property("valid", true);
        expect(g.parseMove("bid 2")).to.have.deep.property("valid", true);
        expect(g.parseMove("redraw AC KS 5D")).to.have.deep.property("valid", true);
        expect(g.parseMove("pass")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AC")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AC/with m0.1 at n0 create U")).to.have.deep.property("valid", true);
        //g.validateMove("use AC/with m0.1 at n0 create n0.1");
        expect(g.parseMove("use AC/with m0.1 at n0 create n0.1")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AC/with l0.1 at k0 create 5D")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AR/with m0.1 move n0 1")).to.have.deep.property("valid", true);
        //g.validateMove("use AR/with m0.1 move m0.1 1 orient N");
        expect(g.parseMove("use AR/with m0.1 move m0.1 1 orient N")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AD/with m0.1 grow m0.1 orient N")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AD/with m0.1 grow n0 to QD")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AS/with m0.1 shrink n0.1 1")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AS/with m0.1 shrink l0 1 to 5D")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 03/orient m0.1 E/with m0.1 at m0 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 15/with m0.1 orient n0.1 N")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 01 as R/with m0.1 move m0.1 1")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 21 as 01 as C/with m0.1 at m0 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 20/with m0.2 draw KS 00")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 02/discard AC KS draw 2")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 21 as 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("play AC/with m0.1 at m0 create U")).to.have.deep.property("valid", true);   
        expect(g.parseMove("decline 05 via 00")).to.have.deep.property("valid", true); 
        expect(g.parseMove("play 6D via 00/with l0.1 grow l0.1")).to.have.deep.property("valid", true);
        expect(g.parseMove("discard AR draw 1 via 02")).to.have.deep.property("valid", true);
        expect(g.parseMove("last")).to.have.deep.property("valid", true);

        g.validateMove("use AC last");
        expect(g.parseMove("use AC last")).to.have.deep.property("valid", true);
        /*
          expect(g.parseMove("use 11/with m0.1 trade n0.1/with m0.1 shrink n0.1 1")).to.have.deep.property("valid", true);

          expect(g.parseMove("use 05/with m0.1 replace n0.1 N")).to.have.deep.property("valid", true);
          expect(g.parseMove("use 09/with m0.1 fly m0.1 to o0")).to.have.deep.property("valid", true);
          expect(g.parseMove("discard draw 0 last")).to.have.deep.property("valid", true);

          expect(g.parseMove("use 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U")).to.have.deep.property("valid", true);
          expect(g.parseMove("use 12/with m0.1 trade n0.1/with m0.1 shrink n0.1 1")).to.have.deep.property("valid", true);
          expect(g.parseMove("use 07/with m0.1 move m0.1 3 orient E/with j0.1 move j0.1 3 orient U")).to.have.deep.property("valid", true);
        */
    });
    
    it ("Pickles", () =>  {
    });

});
