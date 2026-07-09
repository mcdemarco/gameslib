/* tslint:disable:no-unused-expression */

import "mocha";
import { expect } from "chai";
import { KnightLineGame } from '../../src/games';

describe("KnightLine", () => {
    const g = new KnightLineGame(2);
    it ("Converts to algebraic coordinates", () => {
        expect(() => g.renCoords2algebraic(-65,0)).to.throw();
        expect(g.renCoords2algebraic(-64,0)).to.equal("-aaa0");
        expect(g.renCoords2algebraic(-52,0)).to.equal("-mmm0");
        expect(g.renCoords2algebraic(-39,0)).to.equal("-zzz0");
        expect(g.renCoords2algebraic(-38,0)).to.equal("-aa0");
        expect(g.renCoords2algebraic(-26,0)).to.equal("-mm0");
        expect(g.renCoords2algebraic(-14,0)).to.equal("-yy0");
        expect(g.renCoords2algebraic(-13,0)).to.equal("-zz0");
        expect(g.renCoords2algebraic(-12,0)).to.equal("a0");
        expect(g.renCoords2algebraic(0,0)).to.equal("m0");
        expect(g.renCoords2algebraic(13,0)).to.equal("z0");
        expect(g.renCoords2algebraic(14,0)).to.equal("aa0");
        expect(g.renCoords2algebraic(26,0)).to.equal("mm0");
        expect(g.renCoords2algebraic(39,0)).to.equal("zz0");
        expect(g.renCoords2algebraic(40,0)).to.equal("aaa0");
        expect(g.renCoords2algebraic(52,0)).to.equal("mmm0");
        expect(g.renCoords2algebraic(65,0)).to.equal("zzz0");
        expect(() => g.renCoords2algebraic(66,0)).to.throw();
        
        expect(g.renCoords2algebraic(0,5)).to.equal("m5");
        expect(g.renCoords2algebraic(0,-5)).to.equal("m-5");
    });
    
    it ("Converts from algebraic coordinates", () => {
//        expect(g.algebraic2renCoords("-aa0")).to.deep.equal([-38,0]);
        /*
        expect(g.algebraic2renCoords(-14,0)).to.equal("yy0");
        expect(g.algebraic2renCoords(-13,0)).to.equal("zz0");
        expect(g.algebraic2renCoords(-12,0)).to.equal("a0");
        expect(g.algebraic2renCoords(0,0)).to.equal("m0");
        expect(g.algebraic2renCoords(13,0)).to.equal("z0");
        expect(g.algebraic2renCoords(14,0)).to.equal("aa0");
        expect(g.algebraic2renCoords(16,0)).to.equal("cc0");
        expect(g.algebraic2renCoords(39,0)).to.equal("zz0");
        
        expect(g.algebraic2renCoords(0,5)).to.equal("m5");
        expect(g.algebraic2renCoords(0,-5)).to.equal("m-5");*/
    });

});
