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
            spend: ["M3"],
            type: "B",
            valid: true
        });
        expect(g.parseMove("B:8MS1,a,M3,")).to.deep.equal({
            card: "8MS1",
            district: "a",
            type: "B",
            valid: false
        });
        expect(g.parseMove("B:8MS1,a,M3,S5")).to.deep.equal({
            card: "8MS1",
            district: "a",
            incomplete: false,
            spend: ["M3","S5"],
            type: "B",
            valid: true
        });
        expect(g.parseMove("BB:8MS1,a,M3,S5")).to.deep.equal({
            type: "E",
            valid: false
        });
    });
    it ("Parses deeds", () => {

        expect(g.parseMove("D:8MS2,a")).to.deep.equal({
            card: "8MS2",
            district: "a",
            incomplete: false,
            type: "D",
            valid: true
        });
        expect(g.parseMove("D:8MS2,a,")).to.deep.equal({
            card: "8MS2",
            district: "a",
            incomplete: false,
            type: "D",
            valid: true
        });
    });
    it ("Parses sales", () => {

        expect(g.parseMove("S:8MS2")).to.deep.equal({
            card: "8MS2",
            incomplete: false,
            type: "S",
            valid: true
        });
        expect(g.parseMove("S:8MS2,a")).to.deep.equal({
            card: "8MS2",
            incomplete: false,
            type: "S",
            valid: true
        });
        expect(g.parseMove("S:8MS2,M5,")).to.deep.equal({
            card: "8MS2",
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

        expect(g.parseMove("A:8MS2")).to.deep.equal({
            card: "8MS2",
            incomplete: true,
            type: "A",
            valid: true
        });
        expect(g.parseMove("A:8MS2,M5")).to.deep.equal({
            card: "8MS2",
            incomplete: false,
            spend: ["M5"],
            type: "A",
            valid: true
        });

    });
    it ("Parses trades", () => {

        expect(g.parseMove("T:M3")).to.deep.equal({
            incomplete: true,
            spend: ["M3"],
            type: "T",
            valid: true
        });
        expect(g.parseMove("T:M3,K")).to.deep.equal({
            incomplete: false,
            spend: ["M3"],
            suit: "K",
            type: "T",
            valid: true
        });
        
    });
    it ("Parses prefs", () => {

        expect(g.parseMove("P:8MS2")).to.deep.equal({
            card: "8MS2",
            incomplete: true,
            type: "P",
            valid: true
        });
        expect(g.parseMove("P:8MS2,K")).to.deep.equal({
            card: "8MS2",
            incomplete: false,
            suit: "K",
            type: "P",
            valid: true
        });

    });
    
    it ("Validates single moves", () => {
        // parsing good moves
        expect(g.validateMove("7MS;m5*m6")).to.have.deep.property("valid", true);
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
