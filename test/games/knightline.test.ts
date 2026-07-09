/* tslint:disable:no-unused-expression */

import "mocha";
import { expect } from "chai";
import { KnightLineGame } from '../../src/games';

describe("KnightLine", () => {
    const g = new KnightLineGame(2);
    it ("Converts to algebraic coordinates", () => {
        expect(g.renCoords2algebraic(-350,0)).to.equal("na0");
        expect(g.renCoords2algebraic(-65,0)).to.equal("xz0");
        expect(g.renCoords2algebraic(-64,0)).to.equal("ya0");
        expect(g.renCoords2algebraic(-52,0)).to.equal("ym0");
        expect(g.renCoords2algebraic(-40,0)).to.equal("yy0");
        expect(g.renCoords2algebraic(-39,0)).to.equal("yz0");
        expect(g.renCoords2algebraic(-38,0)).to.equal("za0");
        expect(g.renCoords2algebraic(-37,0)).to.equal("zb0");
        expect(g.renCoords2algebraic(-26,0)).to.equal("zm0");
        expect(g.renCoords2algebraic(-15,0)).to.equal("zx0");
        expect(g.renCoords2algebraic(-14,0)).to.equal("zy0");
        expect(g.renCoords2algebraic(-13,0)).to.equal("zz0");
        expect(g.renCoords2algebraic(-12,0)).to.equal("a0");
        expect(g.renCoords2algebraic(-7,0)).to.equal("f0");
        expect(g.renCoords2algebraic(0,0)).to.equal("m0");
        expect(g.renCoords2algebraic(5,0)).to.equal("r0");
        expect(g.renCoords2algebraic(13,0)).to.equal("z0");
        expect(g.renCoords2algebraic(14,0)).to.equal("aa0");
        expect(g.renCoords2algebraic(26,0)).to.equal("am0");
        expect(g.renCoords2algebraic(39,0)).to.equal("az0");
        expect(g.renCoords2algebraic(40,0)).to.equal("ba0");
        expect(g.renCoords2algebraic(52,0)).to.equal("bm0");
        expect(g.renCoords2algebraic(65,0)).to.equal("bz0");
        expect(g.renCoords2algebraic(66,0)).to.equal("ca0");
        expect(g.renCoords2algebraic(351,0)).to.equal("mz0");
        //These are not allowed in the other direction due to ambiguity.
        expect(g.renCoords2algebraic(352,0)).to.equal("na0");
        expect(g.renCoords2algebraic(-351,0)).to.equal("mz0");

        expect(g.renCoords2algebraic(0,5)).to.equal("m5");
        expect(g.renCoords2algebraic(0,-5)).to.equal("m-5");
    });
    
    it ("Converts from algebraic coordinates", () => {

        expect(g.algebraic2renCoords("m0")).to.deep.equal([0,0]);
        expect(g.algebraic2renCoords("m5")).to.deep.equal([0,5]);
        expect(g.algebraic2renCoords("m-5")).to.deep.equal([0,-5]);

        expect(() => g.algebraic2renCoords("")).to.throw();
        expect(() => g.algebraic2renCoords("0")).to.throw();
        expect(() => g.algebraic2renCoords("aaa")).to.throw();

        expect(g.algebraic2renCoords("na0")).to.deep.equal([-350,0]);
        expect(g.algebraic2renCoords("xz0")).to.deep.equal([-65,0]);
        expect(g.algebraic2renCoords("ya0")).to.deep.equal([-64,0]);
        expect(g.algebraic2renCoords("za0")).to.deep.equal([-38,0]);
        expect(g.algebraic2renCoords("zz0")).to.deep.equal([-13,0]);
        expect(g.algebraic2renCoords("a0")).to.deep.equal([-12,0]);
        expect(g.algebraic2renCoords("m0")).to.deep.equal([0,0]);
        expect(g.algebraic2renCoords("y0")).to.deep.equal([12,0]);
        expect(g.algebraic2renCoords("z0")).to.deep.equal([13,0]);
        expect(g.algebraic2renCoords("aa0")).to.deep.equal([14,0]);
        expect(g.algebraic2renCoords("ac0")).to.deep.equal([16,0]);
        expect(g.algebraic2renCoords("az0")).to.deep.equal([39,0]);
        expect(g.algebraic2renCoords("mz0")).to.deep.equal([351,0]);

        expect(g.algebraic2renCoords("m4")).to.deep.equal([0,4]);
        expect(g.algebraic2renCoords("m-3")).to.deep.equal([0,-3]);
        
    });

});
