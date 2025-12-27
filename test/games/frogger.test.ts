/* eslint-disable @typescript-eslint/no-unused-expressions */

import "mocha";
import { expect } from "chai";
import { FroggerGame } from '../../src/games';

describe("Frogger", () => {
    let g = new FroggerGame(2);
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
  /*      //Structural issue with a refill request (default refill variant on).
        expect(g.validateMove("f2-e3,1M!//")).to.have.deep.property("valid", false);
        //Structural issue with a refill request (default refill variant on).
        expect(g.validateMove("f2-e3,1M!/e3-b1,2MK")).to.have.deep.property("valid", false);
        //Structural issue with a refill request (default refill variant on).
        expect(g.validateMove("f2-e3,1M!")).to.have.deep.property("valid", false);*/
    });

    g = new FroggerGame(`{"game":"frogger","numplayers":2,"variants":[],"gameover":false,"winner":[],"stack":[{"_version":"20251220","_results":[],"_timestamp":"2025-12-27T20:25:46.174Z","currplayer":1,"board":{"dataType":"Map","value":[["b4","PVLY"],["c4","4YK"],["d4","2MK"],["e4","9VY"],["f4","7VY"],["g4","PMYK"],["h4","5YK"],["i4","6MV"],["j4","PSVK"],["k4","PMSL"],["l4","NV"],["m4","1L"],["a3","X1-6"],["a2","X2-6"]]},"closedhands":[["4VL","2SY","1Y","8YK"],["NY","6SY","1K","5ML"]],"hands":[[],[]],"market":["6LK","3MV","1S","1V","7SK","9LK"],"discards":[],"nummoves":3}]}`);

    it ("Handles multi-part moves", () => {
        expect(g.validateMove("8YK:a3-c2/c2-b2,1S/b2-a3,7MK/")).to.have.deep.property("valid", false);  //Not a real card.
        expect(g.validateMove("8YK:a3-c2/c2-d2,1S/b2-a3,7SK/")).to.have.deep.property("valid", false);  //Wrong direction.
        expect(g.validateMove("8YK:a3-c2/c2-b2,1S!/b2-a3,7SK/")).to.have.deep.property("valid", false); //Can't refill.
        expect(g.validateMove("8YK:a3-c2/c2-b2,1S/b2-a3,7SK/")).to.have.deep.property("valid", true);   //A legal sequence.
        g.move("8YK:a3-c2/c2-b2,1S/b2-a3,7SK/");
        expect(g.validateMove("8YK:a3-c2/c2-b2,1S/b2-a3,7SK/")).to.have.deep.property("valid", false);  //No longer legal.

        expect(g.validateMove("6SY:a2-j3/1K:j3-n2!/")).to.have.deep.property("valid", false); //Can't refill.
        expect(g.validateMove("6SY:a2-j3/1K:j3-n1/")).to.have.deep.property("valid", false);  //Other player's home invasion.
        expect(g.validateMove("6SY:a2-j3/1K:j3-p2/")).to.have.deep.property("valid", false);  //Off the board.
        expect(g.validateMove("6SY:a2-j3/1K:j3-n0/")).to.have.deep.property("valid", false);  //Offsides.
        expect(g.validateMove("6SY:a2-j3/1K:j3-n2/")).to.have.deep.property("valid", true);   //A legal sequence.
        g.move("6SY:a2-j3/1K:j3-n2/");
        expect(g.validateMove("6SY:a2-j3/1K:j3-n2/")).to.have.deep.property("valid", false);  //No longer legal.

        expect(g.validateMove("2SY:a3-j3/NY:j3-n3/1S:a3-j3/")).to.have.deep.property("valid", false);  //Steal other player's card.
        expect(g.validateMove("2SY:a3-j3/4VL:j3-n3/1S:a3-j3/")).to.have.deep.property("valid", false); //Use own wrong card.
        expect(g.validateMove("2SY:a3-j3/2SY:j3-n3/1S:a3-j3/")).to.have.deep.property("valid", false); //Steal own discard.
        expect(g.validateMove("2SY:a3-j3/6SY:j3-n3/1S:a3-j3/")).to.have.deep.property("valid", false); //Steal other discard.
        expect(g.validateMove("2SY:a3-j3/NY:j3-n3/1S:a3-j3/")).to.have.deep.property("valid", false); //Steal deck card.
        expect(g.validateMove("2SY:a3-j3/1Y:j3-n3/3SK:a3-j3/")).to.have.deep.property("valid", false); //Steal another deck card.
        expect(g.validateMove("2SY:a3-j3/1Y:j3-n3/1S:a3-j3/")).to.have.deep.property("valid", true);   //A legal sequence.
        g.move("2SY:a3-j3/1Y:j3-n3/1S:a3-j3/");
        expect(g.validateMove("2SY:a3-j3/1Y:j3-n3/1S:a3-j3/")).to.have.deep.property("valid", false);  //No longer legal.
  
     });
   
});

