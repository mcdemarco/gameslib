import "mocha";
import { expect } from "chai";
import { MagnateGame } from '../../src/games';
//import { Multicard } from '../../src/common/decktet';

describe("Magnate", () => {
    const g = new MagnateGame();
    it ("Parses buys", () => {

        expect(g.parseMove("B:8MS,a")).to.deep.equal({
            card: "8MS",
            district: "a",
            incomplete: true,
            type: "B",
            valid: true
        });
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
        expect(g.parseMove("B:8MS,a,M3")).to.deep.equal({
            card: "8MS",
            district: "a",
            incomplete: false,
            spend: [3,0,0,0,0,0],
            type: "B",
            valid: true
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

        expect(g.parseMove("D:TMLY")).to.deep.equal({
            card: "TMLY",
            incomplete: true,
            type: "D",
            valid: true
        });
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

        expect(g.parseMove("S:9MS")).to.deep.equal({
            card: "9MS",
            incomplete: false,
            type: "S",
            valid: true
        });
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

        expect(g.parseMove("A:4MS")).to.deep.equal({
            card: "4MS",
            incomplete: true,
            type: "A",
            valid: true
        });
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
        expect(g.parseMove("P:4MS,K")).to.deep.equal({
            card: "4MS",
            incomplete: false,
            suit: "K",
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
        const mv = g.randomMove();
        expect(g.validateMove(mv)).to.have.deep.property("valid", true);
        g.move(mv);
        //g.randomMove();

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

    it ("Renders without exploding", () => {
        g.render();
    });

    it ("Plays along a bit", () => {
        const g = new MagnateGame();
        for (let x = 0; x < 25; x++) {  //27
            const mv = g.randomMove();
            //console.log(mv);
            g.move(mv);
        }
        //console.log(g.status());
    });

    it ("Plays mega a bit", () => {
        const g = new MagnateGame(undefined, ["mega","taxtax"]);
        for (let x = 0; x < 25; x++) {  //27
            const mv = g.randomMove();
            //console.log(mv);
            g.move(mv);
        }
        //console.log(g.status());
    });

    it ("Test the turn completion condition", () => {
        const g = new MagnateGame(`{"game":"magnate","numplayers":2,"variants":[],"gameover":false,"winner":[],"stack":[{"_version":"20260119","_results":[],"_timestamp":"2026-02-03T15:38:09.056Z","currplayer":1,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[]},{"dataType":"Map","value":[]}],"discards":[],"hands":[["1V","1K","1M"],["1S","8YK","8MS"]],"tokens":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"lastroll":[8],"shuffled":false},{"_version":"20260119","_results":[{"type":"roll","values":[8],"who":1},{"type":"place","what":"1K","where":"b","how":"D"},{"type":"roll","values":[8]},{"type":"announce","payload":["  did not collect any tokens.","The next player did not collect any tokens."]}],"_timestamp":"2026-02-03T15:38:23.475Z","currplayer":2,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["1K",{"district":"b","suit1":0}]]},{"dataType":"Map","value":[]}],"discards":[],"hands":[["1V","1M","6LK"],["1S","8YK","8MS"]],"tokens":[[0,0,0,1,1,0],[1,1,1,0,0,0]],"shuffled":false,"lastroll":[8],"lastmove":"D:1K,b/"},{"_version":"20260119","_results":[{"type":"place","what":"8MS","where":"b","how":"D"},{"type":"roll","values":[1]},{"type":"announce","payload":["  was not taxed, and  did not collect any tokens.","The next player was not taxed, and  collected 1 K."]}],"_timestamp":"2026-02-03T15:38:24.407Z","currplayer":1,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["1K",{"district":"b","suit1":1}]]},{"dataType":"Map","value":[["8MS",{"district":"b","suit1":0,"suit2":0}]]}],"discards":[],"hands":[["1V","1M","6LK"],["1S","8YK","9MS"]],"tokens":[[0,0,0,1,1,1],[0,0,1,0,0,0]],"shuffled":false,"lastroll":[1,5],"lastmove":"D:8MS,b/"},{"_version":"20260119","_results":[{"type":"place","what":"6LK","where":"a","how":"D"},{"type":"add","where":"1K","num":1},{"type":"roll","values":[4]},{"type":"announce","payload":["  did not collect any tokens.","The next player did not collect any tokens."]}],"_timestamp":"2026-02-03T15:38:24.995Z","currplayer":2,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["1K",{"district":"b","suit1":1}],["6LK",{"district":"a","suit1":0,"suit2":0}]]},{"dataType":"Map","value":[["8MS",{"district":"b","suit1":0,"suit2":0}]]}],"discards":[],"hands":[["1V","1M","7ML"],["1S","8YK","9MS"]],"tokens":[[0,0,0,0,1,0],[0,0,1,0,0,0]],"shuffled":false,"lastroll":[4],"lastmove":"D:6LK,a/A:1K,K"},{"_version":"20260119","_results":[{"type":"place","what":"1S","where":"discards"},{"type":"roll","values":[4]},{"type":"announce","payload":["  was taxed 1 S, and  did not collect any tokens.","The next player was not taxed, and  did not collect any tokens."]}],"_timestamp":"2026-02-03T15:38:27.280Z","currplayer":1,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["1K",{"district":"b","suit1":1}],["6LK",{"district":"a","suit1":0,"suit2":0}]]},{"dataType":"Map","value":[["8MS",{"district":"b","suit1":0,"suit2":0}]]}],"discards":["1S"],"hands":[["1V","1M","7ML"],["8YK","9MS","1L"]],"tokens":[[0,0,0,0,1,0],[0,1,1,0,0,0]],"shuffled":false,"lastroll":[4,2],"lastmove":"S:1S/A:8MS,"},{"_version":"20260119","_results":[{"type":"place","what":"1M","where":"discards"},{"type":"roll","values":[7]},{"type":"announce","payload":["  was not taxed, and  did not collect any tokens.","The next player was not taxed, and  did not collect any tokens."]}],"_timestamp":"2026-02-03T15:38:28.630Z","currplayer":2,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["1K",{"district":"b","suit1":1}],["6LK",{"district":"a","suit1":0,"suit2":0}]]},{"dataType":"Map","value":[["8MS",{"district":"b","suit1":0,"suit2":1}]]}],"discards":["1S","1M"],"hands":[["1V","7ML","5YK"],["8YK","9MS","1L"]],"tokens":[[2,0,0,0,1,0],[0,1,1,0,0,0]],"shuffled":false,"lastroll":[7,2],"lastmove":"S:1M/A:1K,"},{"_version":"20260119","_results":[{"type":"place","what":"1L","where":"discards"},{"type":"add","where":"8MS","num":1},{"type":"roll","values":[6]},{"type":"announce","payload":["  did not collect any tokens.","The next player collected 1 K."]}],"_timestamp":"2026-02-03T15:38:29.967Z","currplayer":1,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["1K",{"district":"b","suit1":2}],["6LK",{"district":"a","suit1":0,"suit2":0}]]},{"dataType":"Map","value":[["8MS",{"district":"b","suit1":0,"suit2":1}]]}],"discards":["1S","1M","1L"],"hands":[["1V","7ML","5YK"],["8YK","9MS","2MK"]],"tokens":[[2,0,0,0,1,1],[0,0,1,2,0,0]],"shuffled":false,"lastroll":[6],"lastmove":"S:1L/A:8MS1,S"},{"_version":"20260119","_results":[{"type":"place","what":"5YK","where":"c","how":"D"},{"type":"add","where":"1K","num":1},{"type":"roll","values":[10]},{"type":"announce","payload":["  collected 1 L and 1 Y and 1 K.","The next player collected 1 M and 1 S and 1 V."]}],"_timestamp":"2026-02-03T15:38:31.623Z","currplayer":2,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["1K",{"district":"b","suit1":2}],["6LK",{"district":"a","suit1":0,"suit2":0}],["5YK",{"district":"c","suit1":0,"suit2":0}]]},{"dataType":"Map","value":[["8MS",{"district":"b","suit1":1,"suit2":2}]]}],"discards":["1S","1M","1L"],"hands":[["1V","7ML","9VY"],["8YK","9MS","2MK"]],"tokens":[[2,0,0,1,1,1],[1,1,2,2,0,0]],"shuffled":false,"lastroll":[10],"lastmove":"D:5YK,c/A:1K,K"},{"_version":"20260119","_results":[{"type":"place","what":"9MS","where":"c","how":"D"},{"type":"add","where":"8MS","num":2},{"type":"roll","values":[10]},{"type":"announce","payload":["  collected 1 M and 1 S and 1 V.","The next player collected 1 L and 1 Y and 1 K."]}],"_timestamp":"2026-02-03T15:38:32.851Z","currplayer":1,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],[],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["1K",{"district":"b","suit1":3}],["6LK",{"district":"a","suit1":0,"suit2":0}],["5YK",{"district":"c","suit1":0,"suit2":0}]]},{"dataType":"Map","value":[["8MS",{"district":"b","suit1":1,"suit2":2}],["9MS",{"district":"c","suit1":0,"suit2":0}]]}],"discards":["1S","1M","1L"],"hands":[["1V","7ML","9VY"],["8YK","2MK","2VL"]],"tokens":[[2,0,0,2,2,2],[1,1,3,2,0,0]],"shuffled":false,"lastroll":[10],"lastmove":"D:9MS,c/A:8MS,M,S"},{"_version":"20260119","_results":[{"type":"place","what":"7ML","where":"d","how":"D"},{"type":"add","where":"1K","num":1},{"type":"place","what":"1K","where":"b","how":"A"},{"type":"roll","values":[10]},{"type":"announce","payload":["  collected 1 L and 1 Y and 1 K.","The next player collected 1 M and 1 S and 1 V."]}],"_timestamp":"2026-02-03T15:38:42.384Z","currplayer":2,"board":[["PVLY","PSVK","0","PMYK","PMSL"],[[],["1K"],[],[],[]],[[],[],[],[],[]]],"crowns":[[0,0,0,1,1,1],[1,1,1,0,0,0]],"deeds":[{"dataType":"Map","value":[["6LK",{"district":"a","suit1":0,"suit2":0}],["5YK",{"district":"c","suit1":0,"suit2":0}],["7ML",{"district":"d","suit1":0,"suit2":0}]]},{"dataType":"Map","value":[["8MS",{"district":"b","suit1":1,"suit2":2}],["9MS",{"district":"c","suit1":0,"suit2":0}]]}],"discards":["1S","1M","1L"],"hands":[["1V","9VY","4MS"],["8YK","2MK","2VL"]],"tokens":[[1,0,0,2,3,2],[2,2,4,2,0,0]],"shuffled":false,"lastroll":[10],"lastmove":"D:7ML,d/A:1K,K"}]}`);

        //Player 2 is able to trade, but a trade is not a full move.
        expect(g.validateMove("T:V3,K")).to.have.deep.property("valid", true);
        expect(g.validateMove("T:V3,K")).to.have.deep.property("complete", -1);

        expect(g.validateMove("T:V3,K/B:2MK,d,M,K,")).to.have.deep.property("valid", true);
        expect(g.validateMove("T:V3,K/B:2MK,d,M,K,")).to.have.deep.property("complete", 0);

    });

});
