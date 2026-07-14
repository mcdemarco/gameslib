import { GameBase, IAPGameState, IClickResult, IIndividualState, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep, Glyph, MarkerGlyph } from "@abstractplay/renderer/build/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";
//import { UndirectedGraph } from "graphology";
//import { bidirectional } from "graphology-shortest-path";
import { UnboundedSquareBoard } from "../common/unbounded-square-board";

const colLabels = "abcdefghijklmnopqrstuvwxyz".split("");
const revColLabels = "abcdefghijklmnopqrstuvwxyz".split("").reverse();
const pieceInitials = ["X","A","B","C"];

type playerid = 1 | 2 | 3;
type ColorID = 0 | 1 | 2 | 3;

type CellContents = [ColorID, number];

//const allDirections: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];

interface ILegendObj {
    [key: string]: Glyph|[Glyph, ...Glyph[]];
}

interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: UnboundedSquareBoard<CellContents>;
    lastmove?: string;
}

export interface IKnightLineState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

export class KnightLineGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Knight Line",
        uid: "knightline",
        playercounts: [2, 3],
        version: "20260707",
        dateAdded: "2026-07-07",
        // i18next.t("apgames:descriptions.knightline")
        description: "apgames:descriptions.knightline",
        urls: [
            "http://www.nestorgames.com/rulebooks/KNIGHTLINE_EN.pdf",
            "https://boardgamegeek.com/boardgame/146989/knight-line",
        ],
        people: [
            {
                type: "designer",
                name: "Stephen Tavener",
                urls: ["http://www.mrraow.com"],
                apid: "151518d9-dcec-4900-8277-f86830befb64",
            },
            {
                type: "coder",
                name: "mcd",
                urls: ["https://mcdemarco.net/games/"],
                apid: "4bd8317d-fb04-435f-89e0-2557c3f2e66c",
            },
        ],
        variants: [
            { uid: "blocker" },
            { uid: "wildcard" },
        ],
        categories: ["goal>arrange", "mechanic>merge", "board>dynamic", "board>shape>rect", "board>connect>rect", "other>2+players"],
        flags: ["experimental"],
    };

    public absCoords2algebraic(x: number, y: number): string {
        // In knightline, the y axis uses cartesian coordinates, 
        // and the x axis is lettered.
        // The origin and first placement is at m0, aka (0,0).
        // Cells retain the same algebraic coordinates thoughout the game.
        let xval: string;
        if (x > 13) {
            x = x - 14;
            xval = colLabels[Math.floor(x/26)] + colLabels[x % 26];
        } else if (x < -12) {
            x = Math.abs(x) - 13;
            xval = revColLabels[Math.floor(x/26)] + revColLabels[x % 26];
        } else {
            xval = colLabels[x + 12];
        }
        const yval = y === 0 ? 0 : -y;
        return xval + yval.toString();
    }

    public algebraic2absCoords(cell: string): [number, number] {
        // In knightline, the y axis uses cartesian coordinates,
        // and the x axis is lettered.
        // The origin and first placement is at (m, 0).
        // The double indices are divided at m,
        // which is assigned the positive value.
        const temp = cell.match(/[a-z]+|-?[0-9]+/g);
        let x = 0;
        if (!temp || !temp[0] || temp[0].length > 2 || (!temp[1] && temp[1] !== "0"))
            throw new Error(`An invalid cell '${cell}' was passed to algebraic2absCoords.`);
        const y = parseInt(temp[1],10);
        if (temp[0].length === 1) {
            //All the single letter cases.
            x = colLabels.indexOf(temp[0]) - 12;
        } else {
            const let1 = temp[0][0];
            const let2 = temp[0][1];
            let let1val = colLabels.indexOf(let1);
            if (let1val < 13) {
                const let2val = colLabels.indexOf(let2);
                x = let1val * 26 + let2val + 14;
            } else {
                let1val = revColLabels.indexOf(let1);
                const let2val = revColLabels.indexOf(let2);
                x = -(let1val * 26 + let2val + 13);
            }
        }
        const yval = y === 0 ? 0 : -y;
        return [x, yval];
    }
/*
    public algebraic2absCoords(cell: string, board?: UnboundedSquareBoard<CellContents>): [number, number] {
        // Convert from algebraic to renCoords,
        // from which we can easily find the relCoords,
        // then feed to method on board to get absCoords.
        board ??= this.board;
        const [x, y] = this.algebraic2renCoords(cell);
        return board.rel2abs(x - 1, y - 1);
    }

    public absCoords2algebraic(x: number, y: number, board?: UnboundedSquareBoard<CellContents>): string {
        // Convert from absCoords to relCoords using method on board
        // then convert to algebraic via renCoords2algebraic method.
        board ??= this.board;
        const [relx, rely] = board.abs2rel(x, y);
        return this.renCoords2algebraic(relx + 1, rely + 1);
    }
*/
    public abs2relCoords(x: number, y: number): [number, number] {
        //The relative coordinates provided by unbounded-square-board
        // merely move the origin.
        //We need to move the origin one more square down and right
        // in order to leave blank spaces around the board.
        const [relx, rely] = this.board.abs2rel(x, y);
        return [relx + 1, rely + 1];
    }

    public rel2absCoords(x: number, y: number): [number, number] {
        // Convert from relCoords to absCoords.
        return this.board.rel2abs(x - 1, y - 1);
    }

    public algebraic2relCoords(cell: string): [number, number] {
        const coords = this.algebraic2absCoords(cell);
        return this.abs2relCoords(coords[0],coords[1]);
    }

    public relCoords2algebraic(x: number, y: number): string {
        const coords = this.rel2absCoords(x, y);
        return this.absCoords2algebraic(coords[0],coords[1]);
    }
    
    public numplayers = 2;
    public currplayer!: playerid;
    public board!: UnboundedSquareBoard<CellContents>;
    public gameover = false;
    public winner: playerid[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    public variants: string[] = [];

    constructor(state: number | IKnightLineState | string, variants?: string[]) {
        super();
        if (typeof state === "number") {
            this.numplayers = state;
            if (variants !== undefined) {
                this.variants = [...variants];
            }

            const board: UnboundedSquareBoard<CellContents> = new UnboundedSquareBoard();
            const fresh: IMoveState = {
                _version: KnightLineGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board,
            };

            //Set up the starting stacks.
            if (this.variants.includes("blocker") || this.variants.includes("wildcard")) {
                board.set(0,0,[0,1]);
            } else {
                board.set(0,0,[1,20]);
                board.set(1,0,[2,20]);
                if (this.numplayers > 2) {
                    board.set(0,-1,[3,20]);
                }
            }
            
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IKnightLineState;
            }
            if (state.game !== KnightLineGame.gameinfo.uid) {
                throw new Error(`The KnightLine game code cannot process a game of '${state.game}'.`);
            }
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.variants = state.variants;
            this.stack = [...state.stack];
            this.stack.map((s) => {
                s.board = UnboundedSquareBoard.from(s.board);
            });

        }
        this.load();
    }

    public load(idx = -1): KnightLineGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if (idx < 0 || idx >= this.stack.length) {
            throw new Error("Could not load the requested state from the stack.");
        }

        const state = this.stack[idx];
        if (state === undefined) {
            throw new Error(`Could not load state index ${idx}`);
        }
        this.results = [...state._results];
        this.currplayer = state.currplayer;
        this.board = state.board.clone();
        this.lastmove = state.lastmove;
        return this;
    }

/*
    private canPlaceAt(absX: number, absY: number, canExpandX: boolean, canExpandY: boolean): boolean {
        if (this.board.has(absX, absY)) { return false; }
        if (!canExpandX) {
            if (this.board.expandsX(absX)) { return false; }
        }
        if (!canExpandY) {
            if (this.board.expandsY(absY)) { return false; }
        }
        const neighbours = this.getNeighboursDir(absX, absY);
        if (neighbours.length === 0) { return false; }
        return true;
    }
*/

    private createPiece(cell: CellContents): Glyph {
        if (!cell || cell.length < 2)
            throw new Error("Bad cellContents passed to createPiece.");

        const color = cell[0];
        const count = cell[1];
        return [
            {
                name: "piece-square",
                opacity: 1,
                colour: color
            },
            {
                text: count.toString(),
                colour: "#000",
                scale: 0.75
            }
        ] as Glyph;
    }

    private decodePiece(pstr: string): CellContents {
        if (pstr.length < 2)
            throw new Error("Bad piece string passed to decodePiece.");

        const initial = pstr.substring(0,1);
        const color = pieceInitials.indexOf(initial);
        const height = parseInt(pstr.substring(1),10);

        return [color, height] as CellContents;
    }

    private encodePiece(cell: CellContents): string {
        if (!cell || cell.length < 2)
            throw new Error("Bad cellContents passed to encodePiece.");
        
        const color = cell[0];
        const count = cell[1];
        return `${pieceInitials[color]}${count}`;
    }

    public getKnightMoves(absX: number, absY:number): string[] {
        //Takes an absolute board location.
        //Returns an array of cell names of unoccupied cells that are connected to the board.
        const knightMoves: string[] = [];
        const knightAdjust = [[-1,-2],[-1,2],[1,-2],[1,2],[-2,-1],[-2,1],[2,-1],[2,1]];
        for (const [dx,dy] of knightAdjust) {
            if ((! this.board.has(absX + dx, absY + dy) ) && this.hasNeighbors(absX + dx, absY + dy)) {
                const cellname = this.absCoords2algebraic(absX + dx, absY + dy);
                knightMoves.push(cellname);
            }
        }
        return knightMoves;
    }

    private hasNeighbors(absX: number, absY: number): boolean {
        // Check if an empty cell has any neighbors.
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (this.board.has(absX + dx, absY + dy)) {
                    return true;
                }
            }
        }
        return false;
    }
/*
    public moves(player?: playerid): string[] {
        if (player === undefined) {
            player = this.currplayer;
        }
        
        const moves: string[] = [];
        if (!this.gameover && this.board.size > 0) {
            const relXRange = this.getRelXRange();
            const relYRange = this.getRelYRange();
            for (let y = relYRange[0]; y <= relYRange[1]; y++) {
                for (let x = relXRange[0]; x <= relXRange[1]; x++) {
                    const [absX, absY] = this.relCoords2absCoords(x, y);
                    const cellContent = this.board.get(absX, absY);
                    if (cellContent !== undefined) {
                        if (cellContent[0] === player && cellContent[1] > 1) {
                            const kmoves = this.getKnightMoves(absX, absY);
                            moves.push(...kmoves);
                        }
                    }
                }
            }
        }
        console.log(moves);
        
        return moves;
    }
*/
    private hasMoves(): boolean {
        // Check if the player has any moves left.
        // Useful for finite board variants.
        if (this.stack.length === 1) { return true; }
        return false;
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            let newmove = "";
            const cell = this.relCoords2algebraic(col, row);
            console.log(cell);
            if (piece !== undefined && piece !== "") {
                //Reset the move when clicking on a piece.
                if (move !== "")
                    move = "";
                const [color, height] = this.decodePiece(piece);
                if (color !== this.currplayer)
                    newmove = "";
                else if (height === 1)
                    newmove = "";
                else {
                    newmove = cell;
                }
            } else if (move === "") {
                //Need a piece to move.
                newmove = "";
            } else {
                newmove = move + "," + cell;
            }
            const result = this.validateMove(newmove) as IClickResult;
            if (!result.valid) {
                result.move = move;
            } else {
                result.move = newmove;
            }
            return result;
        } catch (e) {
            return {
                move,
                valid: false,
                message: i18next.t("apgames:validation._general.GENERIC", { move, row, col, piece, emessage: (e as Error).message })
            }
        }
    }

    public validateMove(m: string): IValidationResult {
        const result: IValidationResult = { valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER") };
        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            result.canrender = true;
            result.message = i18next.t("apgames:validation.knightline.INITIAL_INSTRUCTIONS");
            return result;
        }
        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");

        //Validate characters.
        if (!/^([a-z]|\d|-|,)+$/.test(m)) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.knightline.INVALID_NOTATION", { move: m });
            return result;
        }

        const moves = m.split(",").filter(move => move.length > 0);
        
        //Validate structure.
        if ( moves.length === 0 || moves.length > 3
            || !/^([a-z][a-z]?-?\d+$)/.test(moves[0])
            || (moves[1] !== undefined && !/^([a-z][a-z]?-?\d+$)/.test(moves[1]))
            || (moves[2] !== undefined && !/^([1-9][0-9]?$)/.test(moves[2])) ) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.knightline.INVALID_NOTATION", { move: m });
            return result;
        }

        //Validate content.

        //Validate starting stack.
        //moves[0] should be a stack of size > 1 owned by the player.
        const cell = moves[0];
        const [absX, absY] = this.algebraic2absCoords(cell);
        const cellContent = this.board.get(absX,absY);

        if (cellContent === undefined) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.knightline.NO_STACK", { cell: cell });
            return result;
        } else if ( cellContent[0] !== this.currplayer ) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.knightline.INVALID_STACK", { cell: cell });
            return result;
        } else if ( cellContent[1] < 2 ) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.knightline.SHORT_STACK", { cell: cell });
            return result;
        }

        const count = cellContent[1];

        if ( moves.length === 1 ) {
            result.valid = true;
            result.complete = -1;
            result.canrender = true;
            result.message = i18next.t("apgames:validation.knightline.SELECT_CELL");
            return result;
        }

        //Validate target cell.
        //moves[1] should be an unoccupied cell a knight move away, with neighbors.
        const targetCell = moves[1];
        const [tabsX, tabsY] = this.algebraic2absCoords(targetCell);
        if (this.board.has(tabsX,tabsY)) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.knightline.INVALID_TARGET", { cell: targetCell });
            return result;
        } else if (! this.hasNeighbors(tabsX, tabsY) ) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.knightline.NO_NEIGHBORS", { cell: targetCell });
            return result;
        } else {
            const dx = Math.abs(absX - tabsX);
            const dy = Math.abs(absY - tabsY);
            if (! ( (dx === 1 && dy === 2) || (dx === 2 && dy === 1) )) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.knightline.NO_KNIGHT", { cell: targetCell });
                return result;
            }
        }

        if ( moves.length === 2 ) {
            result.valid = true;
            result.complete = -1;
            result.canrender = true;
            result.message = i18next.t("apgames:validation.knightline.SPLIT_STACK");
            return result;
        }

        //Validate stacked quantity.
        //moves[2] should be a legal value to pop off the original stack.
        const restack = parseInt(moves[2],10);
        if ( restack < 0 || restack > count - 1 ) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.knightline.BAD_VALUE", { what: restack });
            return result;
        }
        
        if (this.stack.length === 1 && this.numplayers === 2) {
            if (restack === 1) {
                //One of our few complete moves.
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            } else {
                result.valid = false;
                result.message = i18next.t("apgames:validation.knightline.INVALID_FIRST_MOVE", { move: m });
                return result;
            }
        }

        //In most cases the restack quantity can be adjusted,
        //so the move is only provisionally complete.
        result.valid = true;
        result.complete = 0;
        result.message = i18next.t("apgames:validation._general.VALID_MOVE");
        return result;
    }

/*    
    private getNeighboursDir(absX: number, absY: number, board?: UnboundedSquareBoard<CellContents>): [number, number, CellContents][] {
        // Get the directions where the cell at (absX, absY) has neighbours.
        board ??= this.board;
        const neighbours: [number, number, CellContents][] = [];
        for (const [dx, dy] of allDirections) {
            const x = absX + dx;
            const y = absY + dy;
            const tile = board.get(x, y);
            if (tile !== undefined) {
                neighbours.push([dx, dy, tile]);
            }
        }
        return neighbours;
    }
*/

    public move(m: string, { partial = false, trusted = false } = {}): KnightLineGame {
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }

        let result;
        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");
        if (!trusted) {
            result = this.validateMove(m);
            if (!result.valid) {
                throw new UserFacingError("VALIDATION_GENERAL", result.message);
            }
        }
        if (m.length === 0) { return this; }
        this.results = [];

        const moves = m.split(",").filter(move => move.length > 0);
        const cell = moves[0];
        const [absX, absY] = this.algebraic2absCoords(cell);
        const cellContent = this.board.get(absX,absY);
        const count = cellContent![1];

        if ( moves.length === 1 ) {
//            this.results = [{type: "move", from: cell}];
            return this;
        }
        
        const targetCell = moves[1];
        const [tabsX, tabsY] = this.algebraic2absCoords(targetCell);

        if ( moves.length === 2 ) {
//            this.results = [{type: "move", from: cell, to: targetCell}];
            return this;
        }

        const restack = parseInt(moves[2],10);
        const destack = count - restack;

        this.board.set(absX, absY, [this.currplayer, destack]);
        this.board.set(tabsX, tabsY, [this.currplayer, restack]);
        this.results = [{type: "move", from: cell, to: targetCell, what: restack.toString()}];

        
        this.lastmove = m;
        this.currplayer = this.currplayer % 2 + 1 as playerid;

        this.checkEOG();
        this.saveState();
        return this;
    }
/*
    private getNeighbours(cell: string, player: playerid): string[] {
        const [x, y] = this.board.notation2abs(cell);
        const neighboursDirs = this.getNeighboursDir(x, y);
        const neighbours: string[] = [];
        for (const [dx, dy] of neighboursDirs) {
            if (player === 1) {
                neighbours.push(this.board.abs2notation(x + dx, y + dy));
            }
        }
        return neighbours;
    }

    private buildGraph(player: playerid, allPositionsNotation: string[]): UndirectedGraph {
        const graph = new UndirectedGraph();
        // seed nodes
        allPositionsNotation.forEach(c => { graph.addNode(c); });
        // for each node, check neighbours
        // if any are in the graph, add an edge
        for (const node of graph.nodes()) {
            const neighbours = this.getNeighbours(node, player);
            for (const n of neighbours) {
                if (graph.hasNode(n) && !graph.hasEdge(node, n)) {
                    graph.addEdge(node, n);
                }
            }
        }
        return graph;
    }
*/

    protected checkEOG(): KnightLineGame {
        let winner: playerid | undefined;
        const allPositions = this.board.getAllPositions();
//        const allPositionsNotation = allPositions.map(([x, y]) => this.board.abs2notation(x, y));
        
        //Check that enough moves have been made to make a 4-in-a-row.
        if (allPositions.length < this.numplayers * 3 + 1)
            return this;
        
        //Check for 4-in-a-row.
        if (true) {
            this.gameover = true;
            //It's not possible to make 4 in a row for another player, so we know it's you.
            winner = this.currplayer;
        }
        if (this.gameover) {
            this.results.push({ type: "eog" });
        }
        // Check for stalemate, in which player2 wins.
        if (!this.gameover && !this.hasMoves()) {
            //When no one can move, declare a winner or winners.
            this.gameover = true;
            if (this.numplayers === 2) {
                //In a 2p game, the second player wins.
                this.winner = [2];
            } else {
                this.winner = [1, 2, 3];
            }
            this.results.push({ type: "eog", reason: "stalemate" });
        }
        if (this.gameover) {
            this.winner = [winner!];
            this.results.push({ type: "winners", players: [...this.winner] });
        }
        return this;
    }

    public state(): IKnightLineState {
        return {
            game: KnightLineGame.gameinfo.uid,
            numplayers: 2,
            variants: this.variants,
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack],
        };
    }

    protected moveState(): IMoveState {
        return {
            _version: KnightLineGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            lastmove: this.lastmove,
            board: this.board.clone(),
        };
    }

    private getRenderWidthHeight(): [number, number] {
        // Get the width and height of the board for rendering.
        if (this.board.size === 0) {
            //This case should not occur.  Error trap it?
            return [1, 1];
        } else
            return [this.board.width + 2, this.board.height + 2];
    }

    public render(): APRenderRep {
        // Build piece string
        const pieces: string[] = [];
        const legend: ILegendObj = {};
        let firstAX = -1, firstAY = -1;
        const [width, height] = this.getRenderWidthHeight();
        for (let y = 0; y <= height; y++) {
            const pstr: String[] = [];
            for (let x = 0; x <= width; x++) {
                const [absX, absY] = this.rel2absCoords(x, y);
                
                if ( x === 0 && y === 0 )
                    [firstAX, firstAY] = [absX, absY];

                const cellContent = this.board.get(absX, absY);
                if (cellContent === undefined) {
                    pstr.push("-");
                } else {
                    const name = this.encodePiece(cellContent);
                    pstr.push(name);
                    //We may occasionally overwrite an identical legend element.
                    legend[name] = this.createPiece(cellContent);
                }
            }
            pieces.push(pstr.join(","));
        }

        let markers: MarkerGlyph[] | undefined = [];

        if (markers.length === 0) { markers = undefined; }

        console.log("first vals: ", firstAX, firstAY);
        
        const rowLabels = [...Array(height).keys()].map(l => (l + firstAY).toString());

        //TODO: This needs to account for aa, ab, ac, ...
        let columnLabels = (Array.from(Array(width).keys())).map(c =>
            this.absCoords2algebraic(firstAX + c,0).slice(0, -1));
        
        //let columnLabels = colLabels.slice(firstX + 12);
        //columnLabels.length = width;
        
        // Build rep
        const rep: APRenderRep =  {
            board: {
                style: "squares",
                width,
                height,
                columnLabels,
                rowLabels,
                markers,
                strokeColour: {
                    func: "flatten",
                    fg: "_context_strokes",
                    bg: "_context_board",
                    opacity: 0.15,
                },
            },
            legend: legend,
            pieces: pieces.join("\n"),
        };
        //console.log(JSON.stringify(rep));

        rep.annotations = [];
        if (this.results.length > 0) {
            for (const move of this.results) {
                if (move.type === "place") {
                    const [absX, absY] = this.board.notation2abs(move.where!);
                    const [col, row] = this.abs2relCoords(absX, absY);
                    rep.annotations.push({ type: "enter", targets: [{ row, col }] });
                }
            }
        }
        return rep;
    }

    public chat(node: string[], player: string, results: APMoveResult[], r: APMoveResult): boolean {
        let resolved = false;
        switch (r.type) {
            case "place":
                node.push(i18next.t("apresults:PLACE.knightline", { player, where: r.where, piece: r.what, algebraic: r.how }));
                resolved = true;
                break;
            case "eog":
                if (r.reason === "stalemate") {
                    node.push(i18next.t("apresults:EOG.stalemate", { count: 1 }));
                } else {
                    node.push(i18next.t("apresults:EOG.default"));
                }
                resolved = true;
                break;
        }
        return resolved;
    }

    public clone(): KnightLineGame {
        return new KnightLineGame(this.serialize());
    }
}
