import "mocha";
import { expect } from "chai";
import { GnosticaGame } from '../../src/games';

describe("Gnostica parsing", () => {
    const g = new GnosticaGame(3);
    it ("Parses moves", () => {

         expect(g.parseMove("place m0 U?")).to.deep.equal({
            announceLast: false,
            head: "place",
            steps: [{
                action: "place",
                complete: 0,
                direction: "U?",
                targetCell: "m0"
            }],
            valid: true
        });

        expect(g.parseMove("decline 00 via 00")).to.deep.equal({
            announceLast: false,
            head: "decline",
            steps: [{
                action: "decline",
                card: "00",
                complete: 1
            }],
            valid: true,
            viaUid: "00"
        });
 
        expect(g.parseMove("orient n0.1 N")).to.deep.equal({
            announceLast: false,
            head: "orient",
            steps: [{
                action: "orient",
                complete: 1,
                targetPiece: "n0.1",
                direction: "N",
                withPiece: "n0.1"
            }],
            valid: true
        });

        expect(g.parseMove("use 9D/with l1.1 grow l1.1")).to.deep.equal({
            "announceLast":false,
            "head":"use",
            "valid":true,
            "steps":[
                {"action":"use",
                 "card":"9D",
                 "complete":1
                },
                {"action":"grow",
                 "complete":1,
                 "withPiece":"l1.1",
                 "targetPiece":"l1.1"
                }
            ]
            });

    });
    
    it ("Does parser validation", () =>  {

        expect(g.parseMove("use 9D/with l1.1 grow l1.1")).to.have.deep.property("valid", true);
        expect(g.parseMove("discard AC KS draw 2")).to.have.deep.property("valid", true);
        expect(g.parseMove("bid 2")).to.have.deep.property("valid", true);
        expect(g.parseMove("redraw AC KS 5D")).to.have.deep.property("valid", true);
        expect(g.parseMove("pass")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AC")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AC/with m0.1 at n0 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AC/with m0.1 at n0 create n0.1")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AC/with l0.1 at k0 create 5D")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AR/with m0.1 move n0 1")).to.have.deep.property("valid", true);
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
        expect(g.parseMove("use 11 as S/with m0.1 shrink m0.2 2")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 20/with m0.2 draw KS 00")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 02/discard AC KS draw 2")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 21 as 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("play AC/with m0.1 at m0 create U")).to.have.deep.property("valid", true);   
        expect(g.parseMove("decline 05 via 00")).to.have.deep.property("valid", true); 
        expect(g.parseMove("play 6D via 00/with l0.1 grow l0.1")).to.have.deep.property("valid", true);
        expect(g.parseMove("discard AR draw 1 via 02")).to.have.deep.property("valid", true);
        expect(g.parseMove("last")).to.have.deep.property("valid", true);
        expect(g.parseMove("use AC last")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 05/with m0.1 replace n0.1 N")).to.have.deep.property("valid", true);
        expect(g.parseMove("discard draw 0 last")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 09/with m0.1 fly m0.1 to o0")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 12/with m0.1 trade n0.1/with m0.1 shrink n0.1 1")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 07/with m0.1 move m0.1 3 orient E/with j0.1 move j0.1 3 orient U")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 11/with m0.1 trade n0.1/with m0.1 shrink n0.1 1")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 21 as 01 as C/with m0.1 at m1 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("play 21 as 01 as C via 00/with m0.1 at m1 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("play 11 as S/with m0.1 shrink m1.2 1")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 01 as C/with m0.1 at m1 create U")).to.have.deep.property("valid", true);
        expect(g.parseMove("use 11/with m0.1 trade n0.1")).to.have.deep.property("valid", true);

        expect(g.parseMove("use 11/skip/with m0.1 shrink n0.1 1")).to.have.deep.property("valid", true);
    });
    
    it ("Pickles", () =>  {
        const move = "use 9D/with l1.1 grow l1.1";
        const move2 = "use 07/with m0.1 move m0.1 3 orient E/with j0.1 move j0.1 3 orient U";
        const move3 = "use 09/with m0.1 fly m0.1 to o0";
        const move4 = "use 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U";
        const move5 = "use 12/with m0.1 trade n0.1/with m0.1 shrink n0.1 1";
        expect(g.pickleMove(g.parseMove(move))).to.equal(move);
        expect(g.pickleMove(g.parseMove(move2))).to.equal(move2);
        expect(g.pickleMove(g.parseMove(move3))).to.equal(move3);
        expect(g.pickleMove(g.parseMove(move4))).to.equal(move4);
        expect(g.pickleMove(g.parseMove(move5))).to.equal(move5);

        const move6 = "use 07/with m0.1 move m0.1 3 orient E/with j0.1 move j0.1 3 orient U";
        const move7 = "use 11/with m0.1 trade n0.1/with m0.1 shrink n0.1 1";
        const move8 = "use 20/with m0.2 draw KS 00";
        const move9 = "play 21 as 01 as C via 00/with m0.1 at m1 create U";
        const move10 = "use 21 as 01 as C/with m0.1 at m1 create U";
        expect(g.pickleMove(g.parseMove(move6))).to.equal(move6);
        expect(g.pickleMove(g.parseMove(move7))).to.equal(move7);
        expect(g.pickleMove(g.parseMove(move8))).to.equal(move8);
        expect(g.pickleMove(g.parseMove(move9))).to.equal(move9);
        expect(g.pickleMove(g.parseMove(move10))).to.equal(move10);

        const move11 = "use 21 as 01 as C/with m0.1 at m1 create U?";
        const move12 = "discard 21 AS";
        const move13 = "use 10/with m0.1 at n0 create drawn";
        const move14 = "use 04/orient m0.1 N/with m1.2 move m0.2 2 orient N"
        const move15 = "use 15/orient m0.1 N/with m0.1 orient m1.2 W/orient m0.2 N"
        expect(g.pickleMove(g.parseMove(move11))).to.equal(move11);
        expect(g.pickleMove(g.parseMove(move12))).to.equal(move12);
        expect(g.pickleMove(g.parseMove(move13))).to.equal(move13);
        expect(g.pickleMove(g.parseMove(move14))).to.equal(move14);
        expect(g.pickleMove(g.parseMove(move15))).to.equal(move15);

        expect(g.pickleMove(g.parseMove("use 15/orient m0.1 N/with m0.1 orient m0.1 W/orient m0.2 N"))).to.equal("use 15/orient m0.1 N/orient m0.1 W/orient m0.2 N");

        const move16 = "use 11/skip/with m0.1 shrink n0.1 1";
        expect(g.pickleMove(g.parseMove(move16))).to.equal(move16);

    });

    it ("Obviates old validation rules", () =>  {
        expect(g.parseMove("place m0 U/with l1.1 grow l1.1")).to.have.deep.property("valid", false);
        expect(g.parseMove("place m0 U/blah blah blah")).to.have.deep.property("valid", false);
        expect(g.parseMove("discard draw 0/blah blah blah")).to.have.deep.property("valid", false);
        expect(g.parseMove("discard AC draw 3/blah blah blah")).to.have.deep.property("valid", false);
        expect(g.parseMove("orient m0 U/blah blah blah")).to.have.deep.property("valid", false);
    });

    it ("Rejects bad moves", () =>  {
        expect(g.parseMove("use 3S/shrink n0.1 orient N")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 3D/grow n0 orient N")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 3D/grow n0 2")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 3D/grow n0 to n1")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 3D/grow n0.1 2")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 3C/with m0.1 create U")).to.have.deep.property("valid", false);

        expect(g.parseMove("use 09/with n0.1 fly n0.1 to AR")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 09/with n0.1 fly n0.1 3")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 09/with n0.1 fly AC 3")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 09/with n0.1 fly AC to AR")).to.have.deep.property("valid", false);
        expect(g.parseMove("skip")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 3D/skip/grow n0.1 2")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 09/with n0.1 fly AC to AR/skip")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 01 as Q/with n0.1 grow AC to KC")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 11 as Q/with n0.1 fly AC to AR")).to.have.deep.property("valid", false);
    });

    it("marks a special power's step complete only once its fields are typed", () => {
        const lastComplete = (m: string) => g.parseMove(m).steps!.at(-1)!.complete;
        expect(lastComplete("use 03/with m0.1")).eq(-1);
        expect(lastComplete("use 03/with m0.1 orient")).eq(-1);
        expect(lastComplete("use 03/orient m0.1 N")).eq(1);
        expect(lastComplete("use 11/with m0.1 trade")).eq(-1);
        expect(lastComplete("use 11/with m0.1 trade n0.1")).eq(1);
        expect(lastComplete("use 05/with m0.1 replace n0.1")).eq(-1);
        expect(lastComplete("use 05/with m0.1 replace n0.1 N")).eq(1);
        expect(lastComplete("use 09/with m0.1 fly n0.1")).eq(-1);
        expect(lastComplete("use 09/with m0.1 fly n0.1 to o0")).eq(0);
        expect(lastComplete("use 20/with m0.1 draw")).eq(-1);
        expect(g.parseMove("use 09/with m0.1 fly n0.1 to AR")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 09/with m0.1 fly n0.1 3")).to.have.deep.property("valid", false);
    });

    it("reads a bare trailing with as the next step begun", () => {
        const parsed = g.parseMove("use 19/with m0.1 at l0 create U/with");
        expect(parsed).to.have.deep.property("valid", true);
        expect(parsed.steps.map(step => step.action)).to.deep.equal(["use", "create", "with"]);
        expect(parsed.steps[2].withPiece).eq(undefined);
        expect(g.pickleMove(parsed)).eq("use 19/with m0.1 at l0 create U/");
        expect(g.parseMove("use 19//with m0.1 at l0 create U?")).to.have.deep.property("valid", false);
        expect(g.parseMove("use 19/with m0.1 at l0 create U?/with m0.1")).to.have.deep.property("valid", false);
        expect(g.pickleMove(g.parseMove("use 19/with m0.1 at l0 create U/with"))).to.equal("use 19/with m0.1 at l0 create U/");
    });
});
