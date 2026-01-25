/* tslint:disable:no-unused-expression */

import "mocha";
import { expect } from "chai";
import { MagnateGame } from '../../src/games';

describe("Magnate", () => {
    const g = new MagnateGame();
    it ("Parses buys", () => {

        expect(g.parseMove("B:8MS1,a")).to.deep.equal({
            card: "8MS1",
            district: "a",
            incomplete: true,
            type: "B",
            valid: true
        });
        expect(g.parseMove("B:8MS1,a,")).to.deep.equal({
            card: "8MS1",
            district: "a",
            incomplete: true,
            type: "B",
            valid: true
        });
        expect(g.parseMove("B:8MS3,a,M3")).to.deep.equal({
            type: "B",
            valid: false
        });
        expect(g.parseMove("B:8MS1,a,M3")).to.deep.equal({
            card: "8MS1",
            district: "a",
            incomplete: false,
            spend: [3,0,0,0,0,0],
            type: "B",
            valid: true
        });
        expect(g.parseMove("B:8MS1,a,M3,")).to.deep.equal({
            card: "8MS1",
            district: "a",
            type: "B",
            valid: false
        });
        expect(g.parseMove("B:1L1,a,M3,S5")).to.deep.equal({
            card: "1L1",
            district: "a",
            incomplete: false,
            spend: [3,5,0,0,0,0],
            type: "B",
            valid: true
        });
        expect(g.parseMove("BB:1L1,a,M3,S5")).to.deep.equal({
            type: "E",
            valid: false
        });
    });
    it ("Parses deeds", () => {

        expect(g.parseMove("D:TMLY1")).to.deep.equal({
            card: "TMLY1",
            incomplete: true,
            type: "D",
            valid: true
        });
        expect(g.parseMove("D:TMLY2,h")).to.deep.equal({
            card: "TMLY2",
            district: "h",
            incomplete: false,
            type: "D",
            valid: true
        });
       expect(g.parseMove("D:9MS2,a")).to.deep.equal({
            card: "9MS2",
            district: "a",
            incomplete: false,
            type: "D",
            valid: true
        });
        expect(g.parseMove("D:9MS2,a,")).to.deep.equal({
            card: "9MS2",
            district: "a",
            incomplete: false,
            type: "D",
            valid: true
        });
    });
    it ("Parses sales", () => {

        expect(g.parseMove("S:9MS2")).to.deep.equal({
            card: "9MS2",
            incomplete: false,
            type: "S",
            valid: true
        });
        expect(g.parseMove("S:9MS2,a")).to.deep.equal({
            card: "9MS2",
            incomplete: false,
            type: "S",
            valid: true
        });
        expect(g.parseMove("S:9MS2,M5,")).to.deep.equal({
            card: "9MS2",
            incomplete: false,
            type: "S",
            valid: true
        });
        expect(g.parseMove("S:M5")).to.deep.equal({
            type: "S",
            valid: false
        });
    });
    it ("Parses adds", () => {

        expect(g.parseMove("A:4MS2")).to.deep.equal({
            card: "4MS2",
            incomplete: true,
            type: "A",
            valid: true
        });
        expect(g.parseMove("A:4MS2,M5")).to.deep.equal({
            card: "4MS2",
            incomplete: false,
            spend: [5,0,0,0,0,0],
            type: "A",
            valid: true
        });

    });
    it ("Parses trades", () => {

        expect(g.parseMove("T:Y3")).to.deep.equal({
            incomplete: true,
            spend: [0,0,0,0,3,0],
            type: "T",
            valid: true
        });
        expect(g.parseMove("T:Y3,M")).to.deep.equal({
            incomplete: false,
            spend: [0,0,0,0,3,0],
            suit: "M",
            type: "T",
            valid: true
        });
        
    });
    it ("Parses prefs", () => {

        expect(g.parseMove("P:4MS2")).to.deep.equal({
            card: "4MS2",
            incomplete: true,
            type: "P",
            valid: true
        });
        expect(g.parseMove("P:4MS2,K")).to.deep.equal({
            card: "4MS2",
            incomplete: false,
            suit: "K",
            type: "P",
            valid: true
        });

    });
    
    it ("Validates single moves", () => {
        // parsing good moves
        expect(g.validateMove("P:4MS2,K")).to.have.deep.property("valid", true);
        g.render();
        g.randomMove();

        /*
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
        }); */
    });

    it ("Plays along a bit", () => {
        const g = new MagnateGame();
        for (let x = 0; x < 5; x++) {  //27
            g.move(g.randomMove());
        }
        console.log(g.status());
    });

});
