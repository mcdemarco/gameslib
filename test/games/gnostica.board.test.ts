/* eslint-disable @typescript-eslint/no-unused-expressions */
import "mocha";
import { expect } from "chai";
import { Piece } from "../../src/games/gnostica/piece";
import { CellContents } from "../../src/games/gnostica/cell";
import { GnosticaBoard } from "../../src/games/gnostica/board";
import { minorCards, majorCards } from "../../src/common/tarot";
import { UnboundedSquareBoard } from "../../src/common/unbounded-square-board";
import { replacer, reviver } from "../../src/common";

const aceOfCups = () => minorCards.find(c => c.uid === "AC")!;
const twoOfCups = () => minorCards.find(c => c.uid === "2C")!;
const kingOfSwords = () => minorCards.find(c => c.uid === "KS")!;
const theFool = () => majorCards.find(c => c.seq === 0)!;

describe("Gnostica: Piece", () => {
    it("builds a local id from owner+size+orientation", () => {
        const p = new Piece(1, 2, "N");
        expect(p.id()).eq("12N");
    });

    it("defaults to standing up", () => {
        const p = new Piece(1, 1);
        expect(p.orientation).eq("U");
    });

    it("clones independently", () => {
        const p = new Piece(1, 1, "E");
        const c = p.clone();
        c.orientation = "W";
        expect(p.orientation).eq("E");
    });
});

describe("Gnostica: CellContents", () => {
    it("enforces the 3-piece capacity by default", () => {
        const t = new CellContents(aceOfCups());
        t.add(new Piece(1, 1));
        t.add(new Piece(1, 1));
        t.add(new Piece(2, 1));
        expect(t.canAdd()).eq(false);
        expect(() => t.add(new Piece(1, 1))).to.throw();
    });

    it("can bypass capacity when told to (Empress/Emperor)", () => {
        const t = new CellContents(aceOfCups());
        t.add(new Piece(1, 1));
        t.add(new Piece(1, 1));
        t.add(new Piece(1, 1));
        expect(() => t.add(new Piece(1, 1), true)).to.not.throw();
        expect(t.pieces.length).eq(4);
    });

    it("scores 0/1/2/3 by card kind", () => {
        expect(new CellContents().pointValue()).eq(0);
        expect(new CellContents(aceOfCups()).pointValue()).eq(1);
        expect(new CellContents(kingOfSwords()).pointValue()).eq(2);
        expect(new CellContents(theFool()).pointValue()).eq(3);
    });

    it("is uncontested only when exactly one owner is present", () => {
        const t = new CellContents(aceOfCups());
        expect(t.isUncontestedBy(1)).eq(false); // empty
        t.add(new Piece(1, 1));
        expect(t.isUncontestedBy(1)).eq(true);
        expect(t.isUncontestedBy(2)).eq(false);
        t.add(new Piece(2, 1));
        expect(t.isUncontestedBy(1)).eq(false);
        expect(t.isUncontestedBy(2)).eq(false);
    });

    it("round-trips through deserialize", () => {
        const t = new CellContents(kingOfSwords(), [new Piece(1, 3, "S")]);
        const revived = CellContents.deserialize(JSON.parse(JSON.stringify(t)));
        expect(revived.card?.uid).eq("KS");
        expect(revived.pieces.length).eq(1);
        expect(revived.pieces[0].orientation).eq("S");
        expect(revived.pointValue()).eq(2);
    });
});

describe("Gnostica: GnosticaBoard classification", () => {
    it("classifies a lone territory's neighbours as wasteland, everything further out as void", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups()));
        expect(b.classify(0, 0)).eq("territory");
        expect(b.classify(1, 0)).eq("wasteland");
        expect(b.classify(-1, 0)).eq("wasteland");
        expect(b.classify(0, 1)).eq("wasteland");
        expect(b.classify(0, -1)).eq("wasteland");
        expect(b.classify(1, 1)).eq("void"); // diagonal - not orthogonally adjacent
        expect(b.classify(2, 0)).eq("void");
    });

    it("does not chain wasteland-adjacency transitively", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups()));
        // (2,0) is a neighbour of the wasteland (1,0), not of the territory itself
        expect(b.classify(1, 0)).eq("wasteland");
        expect(b.classify(2, 0)).eq("void");
    });

    it("builds the standard 3x3 opening layout correctly", () => {
        const b = new GnosticaBoard();
        for (let x = -1; x <= 1; x++) {
            for (let y = -1; y <= 1; y++) {
                b.store.set(x, y, new CellContents(aceOfCups()));
            }
        }
        for (let x = -1; x <= 1; x++) {
            for (let y = -1; y <= 1; y++) {
                expect(b.classify(x, y)).eq("territory");
            }
        }
        expect(b.classify(-2, 0)).eq("wasteland");
        expect(b.classify(0, -2)).eq("wasteland");
        expect(b.classify(-2, -2)).eq("void"); // corner-diagonal from the grid
        expect(b.classify(-2, -1)).eq("wasteland"); // orthogonally touches (-1,-1)
    });
});

describe("Gnostica: GnosticaBoard mutations", () => {
    it("creates a territory only on a wasteland, preserving pieces already sitting there", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups()));
        b.store.set(1, 0, new CellContents(undefined, [new Piece(1, 1, "W")]));

        expect(() => b.createTerritory(2, 0, twoOfCups())).to.throw(); // void, not wasteland
        b.createTerritory(1, 0, twoOfCups());
        const t = b.get(1, 0)!;
        expect(t.card?.uid).eq("2C");
        expect(t.pieces.length).eq(1);
        expect(t.pieces[0].orientation).eq("W");
    });

    it("grows/shrinks a territory's card in place without touching its pieces", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        b.growTerritory(0, 0, kingOfSwords());
        expect(b.get(0, 0)!.card?.uid).eq("KS");
        expect(b.get(0, 0)!.pieces.length).eq(1);
        b.shrinkTerritory(0, 0, aceOfCups());
        expect(b.get(0, 0)!.card?.uid).eq("AC");
    });

    it("destroys a territory and returns evicted pieces from cells that collapse into the void", () => {
        const b = new GnosticaBoard();
        // A single isolated territory with a piece sitting on its wasteland neighbour.
        b.store.set(0, 0, new CellContents(aceOfCups()));
        b.store.set(1, 0, new CellContents(undefined, [new Piece(2, 1, "U")]));

        const evicted = b.destroyTerritory(0, 0);
        // (1,0) had no other territory neighbour, so it collapses to void and evicts.
        expect(evicted.length).eq(1);
        expect(evicted[0]).to.deep.include({ x: 1, y: 0 });
        expect(evicted[0].pieces.length).eq(1);
        expect(b.has(0, 0)).eq(false);
        expect(b.has(1, 0)).eq(false);
    });

    it("does not evict a wasteland piece if another territory still keeps it adjacent", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups()));
        b.store.set(2, 0, new CellContents(aceOfCups()));
        b.store.set(1, 0, new CellContents(undefined, [new Piece(1, 1, "U")]));

        const evicted = b.destroyTerritory(0, 0);
        expect(evicted.length).eq(0);
        expect(b.classify(1, 0)).eq("wasteland"); // still adjacent to (2,0)
        expect(b.get(1, 0)!.pieces.length).eq(1);
    });

    it("pushes only the card, leaving pieces behind at the departure cell", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        // A second territory keeps (0,0) from collapsing to void after the card leaves.
        b.store.set(-1, 0, new CellContents(twoOfCups()));

        b.pushTerritory(0, 0, 1, 0);
        expect(b.get(0, 0)!.card).to.be.undefined;
        expect(b.get(0, 0)!.pieces.length).eq(1); // piece stayed behind
        expect(b.get(1, 0)!.card?.uid).eq("AC");
    });

    it("slides a pushed card in under pieces already at the destination", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups()));
        b.store.set(-1, 0, new CellContents(twoOfCups())); // keeps (0,0) alive after push
        b.store.set(1, 0, new CellContents(undefined, [new Piece(2, 1, "U")]));

        b.pushTerritory(0, 0, 1, 0);
        const dest = b.get(1, 0)!;
        expect(dest.card?.uid).eq("AC");
        expect(dest.pieces.length).eq(1);
        expect(dest.pieces[0].owner).eq(2);
    });

    it("evicts pieces stranded at the departure side of a push", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 1, "U")]));
        // Pushed two spaces away (not adjacent to the source), so the
        // departure cell has no card next door to keep it a wasteland.
        b.store.set(5, 0, new CellContents(twoOfCups())); // far enough not to help (0,0)

        const evicted = b.pushTerritory(0, 0, 2, 0);
        expect(evicted.length).eq(1);
        expect(evicted[0]).to.deep.include({ x: 0, y: 0 });
        expect(b.has(0, 0)).eq(false);
    });
});

describe("Gnostica: GnosticaBoard rehydration", () => {
    it("round-trips a populated board through JSON.stringify/parse", () => {
        const b = new GnosticaBoard();
        b.store.set(0, 0, new CellContents(aceOfCups(), [new Piece(1, 2, "N")]));
        b.store.set(1, 0, new CellContents(theFool()));

        const json = JSON.stringify({ board: b.store }, replacer);
        // Only the card's uid is ever actually serialized, not the whole
        // TarotCard object (see CellContents's own docs on why) - a
        // regression here would silently bloat every stack entry's state.
        expect(json).to.include("\"cardUid\":\"AC\"");
        expect(json).to.not.include("\"rank\"");
        expect(json).to.not.include("\"suit\"");
        const raw = JSON.parse(json, reviver) as { board: UnboundedSquareBoard<CellContents> };
        const fixed = GnosticaBoard.rehydrate(raw.board);
        const revived = new GnosticaBoard(fixed);

        expect(revived.get(0, 0)?.card?.uid).eq("AC");
        expect(revived.get(0, 0)?.pieces[0].orientation).eq("N");
        expect(revived.get(1, 0)?.card?.uid).eq("00");
        // and the rehydrated instance is a real CellContents with working methods, not a plain object
        expect(revived.get(0, 0)?.pointValue()).eq(1);
        expect(revived.get(1, 0)?.pointValue()).eq(3);
    });
});

describe("Gnostica: GnosticaBoard algebraic notation", () => {
    it("round-trips coordinates through algebraic notation across a wide range", () => {
        for (let x = -60; x <= 60; x += 7) {
            for (let y = -60; y <= 60; y += 11) {
                const alg = GnosticaBoard.coords2algebraic(x, y);
                const [rx, ry] = GnosticaBoard.algebraic2coords(alg);
                expect([rx, ry], `round-trip of (${x},${y}) via "${alg}"`).to.deep.equal([x, y]);
            }
        }
    });

    it("places the origin at m0 (centred, so early growth in either x direction stays single-letter)", () => {
        expect(GnosticaBoard.coords2algebraic(0, 0)).eq("m0");
        expect(GnosticaBoard.algebraic2coords("m0")).to.deep.equal([0, 0]);
    });
});
