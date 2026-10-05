// The one supported way to seed a GnosticaGame test's starting position (TODO #107).
//
// This builds a plain state object using the game's own real classes, then round-trips it
// through JSON.stringify(..., replacer) into the game's string constructor - the exact path
// a real client uses to reload a saved game. That is what makes this different from poking a
// LIVE game's fields directly (clearBoard/forceCardAt/g.board.get(...)!.pieces = [...]/
// g.hands[i] = [...]/g.stashes.set(...)/g.currplayer = ...): those bypass load() entirely, so
// the constructed game's "committed" state (what clone()/history reads) and its live state can
// disagree - the exact class of bug this session spent most of its time chasing. Going through
// the string constructor means there is no live state to disagree with the committed state in
// the first place.
import { replacer } from "../../src/common";
import { allCards } from "../../src/common/tarot";
import { GnosticaGame, IGnosticaState } from "../../src/games/gnostica";
import { GnosticaBoard } from "../../src/games/gnostica/board";
import { CellContents } from "../../src/games/gnostica/cell";
import { Orientation, Piece } from "../../src/games/gnostica/piece";

export type TestPiece = [owner: number, size: 1 | 2 | 3, orientation: Orientation];

export interface TestCard {
    x: number;
    y: number;
    // Omit for a cardless wasteland cell that still needs a piece standing on it.
    uid?: string;
    pieces?: TestPiece[];
}

export interface TestGameOpts {
    numplayers?: number;
    currplayer?: number;
    phase?: "bidding" | "redraw" | "main";
    board?: TestCard[];
    hands: string[][];
    stashes?: Record<number, [number, number, number]>;
    drawPile?: string[];
    discardPile?: string[];
    eliminated?: number[];
    continued?: string[];
    variants?: string[];
}

// Builds a fully-specified GnosticaGame from data, via the same load() path a saved game reload uses.
export function testGame(opts: TestGameOpts): GnosticaGame {
    const numplayers = opts.numplayers ?? opts.hands.length;
    const board = new GnosticaBoard();
    for (const c of opts.board ?? []) {
        let card;
        if (c.uid !== undefined) {
            card = allCards().find(a => a.uid === c.uid);
            if (card === undefined) {
                throw new Error(`testGame: unknown card uid "${c.uid}"`);
            }
        }
        const contents = new CellContents(card);
        contents.pieces = (c.pieces ?? []).map(([owner, size, orientation]) => new Piece(owner, size, orientation));
        board.store.set(c.x, c.y, contents);
    }
    const stashEntries = Object.entries(opts.stashes ?? {}).map(([p, s]) => [Number(p), s]);
    const stashes = stashEntries.length > 0
        ? stashEntries
        : Array.from({ length: numplayers }, (_, i) => [i + 1, [5, 5, 5]]);
    const phase = opts.phase ?? "main";
    // The "bidding" variant carries its own bookkeeping (bidPositions/biddingPool/turnOrder) for
    // its WHOLE lifetime once dealt in that variant (see the constructor's own `fresh` object),
    // not just while still mid-bid/redraw - a caller asking for a bidding/redraw phase implies
    // the variant even if they forgot to list it, but a caller asking for the variant on an
    // ordinary main-phase game (post-bid, normal play) still needs that bookkeeping present too.
    const bidding = phase !== "main" || (opts.variants ?? []).includes("bidding");
    const variants = bidding && !(opts.variants ?? []).includes("bidding") ? [...(opts.variants ?? []), "bidding"] : (opts.variants ?? []);
    const raw = {
        game: GnosticaGame.gameinfo.uid,
        numplayers,
        variants,
        gameover: false,
        winner: [],
        stack: [{
            _version: GnosticaGame.gameinfo.version,
            _results: [],
            _timestamp: new Date(),
            currplayer: opts.currplayer ?? 1,
            board: board.store,
            hands: opts.hands,
            cardsDrawn: opts.hands.map(() => 0),
            discardPile: opts.discardPile ?? [],
            stashes: new Map(stashes as [number, [number, number, number]][]),
            eliminated: opts.eliminated ?? [],
            lastTurner: undefined,
            phase,
            bidPositions: bidding ? new Array(numplayers).fill(null) : undefined,
            biddingPool: bidding ? [] : undefined,
            turnOrder: bidding ? Array.from({ length: numplayers }, (_, i) => i + 1) : undefined,
            continued: opts.continued,
        }],
    } as unknown as IGnosticaState;
    const game = new GnosticaGame(JSON.stringify(raw, replacer));
    // The draw pile isn't part of the state: it is rebuilt, shuffled, whenever a game loads, so a test pins it on the game it is about to play.
    game.drawPile = [...(opts.drawPile ?? [])];
    return game;
}
