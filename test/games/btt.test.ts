import "mocha";
import { expect } from "chai";
import { BTTGame } from "../../src/games";

describe("Branches and Twigs and Thorns", () => {
    it("Does initial board config", () => {
        for (let p = 2; p <= 6; p++) {
            const g = new BTTGame(p);
            expect(g.moves().length).eq(p * 16);
            
            const ga = new BTTGame(p, ["arcade"]);
            expect(ga.moves().length).eq(p * 10);

            const gg = new BTTGame(p, ["martian-go"]);
            if (p > 4) {
                //No Martian Go setup in these cases.
                expect(gg.moves().length).eq(p * 16);
            } else if (p === 2 || p === 4) {
                //These two cases are symmetric.  (No nulls.)
                //(2 spots per player, three pyramid types)
                expect(gg.moves().length).eq(p * 2 * 3);
            } else {
                //Three players get a funky root.  (No nulls.)
                expect(gg.moves().length).eq(8 * 3);
            }
        }
    });

    it("Does initial setup moves (2P)", () => {
        const g = new BTTGame(2);

        let moves = g.moves();
        expect(moves.length).eq(32); // 4x8 board
        expect(moves[0].endsWith("-NULL")).eq(true);

        g.move(moves[0]); // Place NULL

        moves = g.moves();
        expect(moves.length).eq(31);
        expect(moves[0].endsWith("-ROOT")).eq(true);

        g.move(moves[0]); // Place ROOT

        moves = g.moves();
        // The ROOT placed allows placement of pieces facing it
        // A root has up to 4 empty neighbors, and for each we can place size 1, 2, or 3.
        expect(moves[0]).match(/^[a-h][1-4]-[123]-[NESW]$/);
    });

    it("Does initial setup moves (4P)", () => {
        const g = new BTTGame(4);

        // P1 places Null
        let moves = g.moves();
        expect(moves.length).eq(64); // 8x8 board
        expect(moves[0].endsWith("-NULL")).eq(true);

        g.move("a1-NULL"); // Place first NULL at a1

        // P2 places second Null
        moves = g.moves();
        // Since P1 placed at a1, a2 and b1 might be restricted if the badnulls logic triggers.
        // Wait, for 4P, badnulls from a2 are b1, from a7 are b8, etc. a1 has no badnulls.
        expect(moves.length).eq(63);
        expect(moves[0].endsWith("-NULL")).eq(true);

        g.move("a2-NULL"); // Place second NULL at a2

        // P3 places first Root
        moves = g.moves();
        expect(moves.length).eq(62);
        expect(moves[0].endsWith("-ROOT")).eq(true);

        g.move("h1-ROOT"); // Place ROOT

        // P4 places second Root
        moves = g.moves();
        expect(moves.length).eq(61);
        expect(moves[0].endsWith("-ROOT")).eq(true);

        g.move("h2-ROOT"); // Place ROOT

        moves = g.moves();
        expect(moves[0]).match(/^[a-h][1-8]-[123]-[NESW]$/);
    });

    it("Scores and validates", () => {
        const g = new BTTGame(2);

        g.move("h4-NULL");
        g.move("g4-ROOT");

        // P1 places a size 1 piece at f4 pointing E at the root (g4)
        expect(g.validateMove("f4-1-E").valid).eq(true);
        g.move("f4-1-E");

        expect(g.scores[0]).eq(0); // Pointing at ROOT has no penalty

        // P2 places a size 2 piece at e4 pointing E at P1's size 1 piece (f4)
        expect(g.validateMove("e4-2-E").valid).eq(true);
        g.move("e4-2-E");

        // P2 pointed at P1's size 1. P2 loses 1, P1 gains 2.
        expect(g.scores[1]).eq(-1);
        expect(g.scores[0]).eq(2);

        // However, if P1's size 1 piece had a friendly piece adjacent, pointing at it would be illegal!
        // Right now P1's size 1 unit handles itself.
        // Let P1 place a size 3 piece at f3 pointing N at P1's size 1 piece (f4).
        g.move("f3-3-N");

        // Now P1 has pieces at f4 and f3.
        // If P2 tries to point something at f3... wait, pointing at someone else's piece is only forbidden
        // if they ALSO have a friendly piece adjacent.
        // Let's verify standard validity
        expect(g.validateMove("f2-1-N").valid).eq(true);
    });

});
