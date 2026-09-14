// randomMove() and its supporting builders - extracted verbatim from
// gnostica.ts (see #84's own docs on why that file needs to shrink).
// GnosticaGame.randomMove() itself stays a thin stub in gnostica.ts,
// calling generateRandomMove(this) below.
//
// `custom-randomization` is declared precisely because full `moves()`
// enumeration of every legal chained-power target combination is
// combinatorially infeasible - randomMove() instead CONSTRUCTS a
// candidate move (random targets/modes/cards at each decision point)
// and leans on gnostica.ts's own existing validateX functions as the
// single source of truth for legality, rather than re-deriving every
// rule itself. Every builder below either produces something
// guaranteed legal by construction, or verifies its own candidate
// against the matching validateX before accepting it - see each one's
// own docs for which. The top-level dispatch below also runs the
// fully-assembled move through validateMove() as a final safety net
// before returning it.
//
// Every function here takes the acting GnosticaGame instance (`game`)
// explicitly as its first argument, rather than being a method on the
// class. GnosticaGame itself is imported type-only (fully erased, no
// runtime dependency at all) - the one place this file would otherwise
// need it as a genuine VALUE (GnosticaGame.chainMinion, a small pure
// helper) is inlined locally instead (see its own docs below), so
// gnostica.ts can import from here with no circular value import
// either way.
import { type GnosticaGame, type IMinionRef, type IStepOutcome } from "../gnostica";
import { shuffle } from "../../common";
import { Card, allCards } from "../../common/tarot";
import { cardPointValue } from "./cell";
import { Orientation, allOrientations } from "./piece";
import { GnosticaBoard } from "./board";
import { MajorArcanaDef, PowerStep, PrimitiveOpts, SpecialPower, SuitPrimitive, getMajorArcanaDef } from "./majorArcana";
import { ALL_SUITS } from "./stepShapes";

// Mirrors GnosticaGame's own private static chainMinion exactly (see its
// docs there, including #98/#100's own) - duplicated rather than imported
// so this file never needs GnosticaGame as a runtime VALUE at all, only
// as a type (fully erased), avoiding a circular import between this file
// and gnostica.ts. Keep this in sync by hand if that one ever changes -
// #98's own crash went unfixed here for a full extra round exactly
// because this copy was missed the first time.
function chainMinion(minions: IMinionRef[], outcome: IStepOutcome): IMinionRef[] {
    const stale = outcome.replacesMinion;
    const base = stale === undefined
        ? minions
        : minions
            .filter(m => !(m.x === stale.x && m.y === stale.y && m.index === stale.index))
            .map(m => (m.x === stale.x && m.y === stale.y && m.index > stale.index) ? { ...m, index: m.index - 1 } : m);
    return outcome.newMinion === undefined ? base : [...base, outcome.newMinion];
}

export function generateRandomMove(game: GnosticaGame): string {
    if (game.gameover) {
        return ""; // matches magnate.ts's own precedent for this case
    }
    // An eliminated player has nothing left to do - matches moves()'s
    // own contract (see its docs), and "pass" is now phase-independent
    // for them (see validatePass()'s own docs). Checked before the
    // phase dispatch below since it applies regardless of phase.
    if (game.eliminated.includes(game.currplayer)) {
        return "pass";
    }
    // A paused activation obligates this seat before anything else is
    // legal (matches getActionButtons()'s own "only one thing possible
    // right now" gate). High Priestess can't be Declined at all
    // (NOTHING_TO_DECLINE - its own round is mandatory, not a revealed
    // card) - round 1's own randomizer, buildRandomHighPriestessResumeTokens,
    // is reused for round 2 too, since both rounds share the identical
    // grammar and legality.
    if (game.continued.length > 0) {
        const activeUid = game.continued[game.continued.length - 1].split(".")[0];
        if (activeUid === "02") {
            return game.buildViaMove([buildRandomHighPriestessResumeTokens(game)]);
        }
        // A persisted Fool obligation always means an ordinary revealed
        // card sits on top awaiting a decision (buildPendingFromContinued's
        // own docs) - sometimes genuinely try to use it instead of always
        // declining. The player never has to reason about how deep the
        // reveal is nested - only "what's the card in front of me right
        // now" - so this reuses the EXACT same per-card logic a fresh
        // top-level activation uses, Fool/World included, rather than
        // falling back to decline just because the card happens to be
        // reached this way: Fool's own step needs no typed input whether
        // it's a root activation or a nested self-reveal (using it just
        // means letting it flip again), and World's own borrow-target
        // pick (randomWorldBorrowUid) works identically regardless of
        // nesting depth too.
        const revealedUid = game.discardPile[game.discardPile.length - 1];
        const revealedCard = revealedUid !== undefined ? allCards().find(c => c.uid === revealedUid) : undefined;
        // Matches buildRandomChain's own "sometimes skip outright" odds
        // elsewhere - a real player might just decline a perfectly usable
        // reveal too, not only an unusable one.
        if (revealedCard !== undefined && Math.random() >= 0.15) {
            let candidate: string | undefined;
            if (revealedCard.uid === "00") {
                candidate = game.buildViaMove([]);
            } else if (revealedCard.uid === "21") {
                const borrowedUid = randomWorldBorrowUid(game);
                if (borrowedUid !== undefined) {
                    const borrowedCard = allCards().find(c => c.uid === borrowedUid)!;
                    const chain = buildRandomChain(game, borrowedCard, game.eligibleMinionsForPlay());
                    candidate = game.buildViaMove(chain, borrowedUid);
                }
            } else if (revealedCard.uid === "01") {
                // Fool's own reveal never spends asUid (unlike World's
                // borrow) - the suit still goes through "as <suit>" here,
                // same as a root activation (findRandomMagicianChain's own
                // docs).
                const found = findRandomMagicianChain(game, game.eligibleMinionsForPlay());
                if (found !== undefined) {
                    candidate = game.buildViaMove(found.chain, found.suitUid);
                }
            } else {
                const chain = buildRandomChain(game, revealedCard, game.eligibleMinionsForPlay());
                if (chain.length > 0) {
                    candidate = game.buildViaMove(chain);
                }
            }
            if (candidate !== undefined) {
                const check = game.validateMove(candidate);
                // Same commit-on-a-clone safety check the top-level loop
                // below uses (task #45's own class of validate/apply
                // divergence risk, reachable here too now that a real
                // chain is being attempted instead of a trivially-always-
                // legal decline).
                if (check.valid && check.complete !== -1) {
                    try {
                        game.clone().move(candidate, { trusted: false });
                        return candidate;
                    } catch {
                        // fall through to decline below
                    }
                }
            }
        }
        return game.buildViaMove([["decline"]]);
    }
    if (game.phase === "bidding") {
        const hand = game.hands[game.currplayer - 1];
        return `bid ${1 + Math.floor(Math.random() * hand.length)}`;
    }
    if (game.phase === "redraw") {
        const needed = 6 - game.hands[game.currplayer - 1].length;
        const picks = (shuffle(game.biddingPool!) as string[]).slice(0, needed);
        return `redraw ${picks.join(" ")}`.trim();
    }
    if (!game.hasPiecesOnBoard(game.currplayer)) {
        return randomPlaceMove(game);
    }
    // Once eligible to declare (own score already at/above target, and
    // nobody has an active declaration pending at all - move()'s own
    // ALREADY_ANNOUNCED gate rejects a second announceLast even by the
    // same player who's already the declarer), sometimes append the
    // "(last)" suffix to whatever move is about to be returned. Without
    // this, a game played purely by randomMove() could never actually
    // end. Not unconditional even once eligible - a real player might
    // wait for a wider safety margin first, same as this file's own
    // "prefer, don't require" weighting elsewhere.
    const canAnnounce = game.lastTurner === undefined
        && game.scoreFor(game.currplayer) >= game.targetScore();
    const announce = canAnnounce && Math.random() < 0.25;
    // "discard" is always unconditionally legal once the player has
    // board presence (any subset of hand, no draw suffix required), so
    // shuffling every head into the try-order and falling all the way
    // through to a bare "discard" guarantees this loop always
    // terminates with something real.
    const heads = shuffle(["use", "play", "orient", "discard"]) as string[];
    for (const head of heads) {
        try {
            const candidate = buildRandomHeadMove(game, head);
            if (candidate === undefined) {
                continue;
            }
            const finalCandidate = announce ? `${candidate} (last)` : candidate;
            const check = game.validateMove(finalCandidate);
            // Genuinely submittable is complete !== -1, not === 1 -
            // several heads (orient, a use/play chain with a further
            // optional step still available) are legitimately final yet
            // still complete:0, matching Magnate's own "never complete,
            // only submissible" rule (see provisionalResult's own docs).
            if (!check.valid || check.complete === -1) {
                continue;
            }
            // validateMove() never mutates, so a multi-step chain that
            // re-targets a piece/territory an EARLIER step of the same
            // chain relocated can look fully legal here (step 2 still
            // "sees" the original, pre-move board) while actually
            // committing it later would fail - the same
            // validate/apply divergence as task #45, just triggered by
            // a later step's own target rather than its acting minion.
            // A cheap commit-on-a-throwaway-clone check catches this
            // (and anything else in the same class) before it's ever
            // handed back as "the" move, matching how click-support's
            // own preview already verifies via clone+real-apply rather
            // than trusting prediction.
            game.clone().move(finalCandidate, { trusted: false });
            return finalCandidate;
        } catch {
            // A speculative chain can hit a still-open engine edge case
            // (see task #45 - a later step's own acting minion landing
            // on a cell the board doesn't actually have data for yet)
            // that throws instead of failing validation gracefully.
            // Same tolerance as an ordinary failed candidate: drop it
            // and let the loop try a different head/card/chain shape -
            // "discard" below is always available as the last resort.
            continue;
        }
    }
    return announce ? "discard (last)" : "discard";
}

function buildRandomHeadMove(game: GnosticaGame, head: string): string | undefined {
    switch (head) {
        case "discard": return randomDiscardMove(game);
        case "orient": return randomOrientMove(game);
        case "use": return randomUseOrPlayMove(game, "use");
        case "play": return randomUseOrPlayMove(game, "play");
        default: return undefined;
    }
}

// Every cell that's both non-void and currently holds zero pieces -
// scanned over the same window render() uses (see renderWindow's own
// docs), NOT just `board.entries()` (which only yields cells with a
// stored CellContents object - see randomPlaceMove's own docs on why
// that under-enumerates). Shared by randomPlaceMove (a legal
// initial-placement target) and buildRandomHermitTokens (a legal
// teleport destination - hermit's own rules use the identical "empty
// territory or wasteland" shape).
function emptyNonVoidCells(game: GnosticaGame): [number, number][] {
    const { minX, maxX, minY, maxY } = game.renderWindow();
    const cells: [number, number][] = [];
    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            if (game.board.classify(x, y) === "void") {
                continue;
            }
            const t = game.board.get(x, y);
            if (t !== undefined && t.pieces.length > 0) {
                continue;
            }
            cells.push([x, y]);
        }
    }
    return cells;
}

// Candidate cells are scanned the same padded window render() uses
// (board's own min/max +/-1 in each direction), NOT just
// `board.entries()` - entries() only yields cells with a stored
// CellContents object, but a never-touched wasteland adjacent to an
// existing territory (classify() derives wasteland-ness from
// NEIGHBORING cards, not from whether the cell itself was ever stored)
// is an equally legal placement target. This matters a lot here
// specifically: place is the ONLY legal head whenever
// !hasPiecesOnBoard (every other head, including bare discard, throws
// MUST_PLACE_FIRST), so under-enumerating candidates isn't just a
// coverage gap, it risks returning nothing legal at all in a
// forced-re-placement-after-wipeout scenario.
// Weighted random pick: each item's weight (always > 0) is its
// relative probability. Used to bias randomMove()'s own choices toward
// outcomes that are ordinarily stronger - a card cell over a bare
// wasteland for placement, a higher-value card for use/play - without
// ever ruling the weaker options out entirely, the same way a human
// player occasionally still takes the less obvious option.
// A facing only matters for what it points AT (Rods/Swords/Discs all
// act on the facing cell - see ROD_NEEDS_FACING and friends), so a
// uniformly random orientation on a WASTELAND cell wastes that choice
// about as often as not, pointing off into cells with nothing there to
// act on. Same "prefer, don't require" bias as weightedPick's own
// docs: "U" (no facing at all) and any cardinal direction that
// genuinely points at a territory are weighted well above one that
// points at more wasteland/void, without ruling the latter out
// entirely. A piece on its own territory cell is left uniformly
// random - its facing is already meaningful there regardless of
// direction, so there's no "wasted" option to steer away from.
// `exclude` lets randomOrientMove() rule out the piece's own CURRENT
// facing - reorienting a piece to the direction it's already facing is
// a no-op (see validateOrient's own ORIENT_NO_OP docs), so a
// legitimate reorientation must always end up genuinely different.
// randomPlaceMove() never passes this - a fresh placement has no
// "current" facing to avoid, and "U" is a perfectly meaningful choice
// there.
export function weightedRandomOrientation(game: GnosticaGame, x: number, y: number, exclude?: Orientation): Orientation {
    const candidates = exclude === undefined ? allOrientations : allOrientations.filter(o => o !== exclude);
    if (game.board.classify(x, y) !== "wasteland") {
        return candidates[Math.floor(Math.random() * candidates.length)];
    }
    return weightedPick(candidates, (o) => {
        if (o === "U") {
            return 2;
        }
        const [dx, dy] = game.board.delta(o);
        return game.board.classify(x + dx, y + dy) === "territory" ? 3 : 1;
    });
}

export function weightedPick<T>(items: T[], weight: (item: T) => number): T {
    const weights = items.map(weight);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) {
            return items[i];
        }
    }
    return items[items.length - 1]; // floating-point safety net
}

// A full ordering, not just one pick: repeated weightedPick-without-
// replacement. Used where a caller needs to TRY candidates in order
// until one validates (findRandomPrimitiveChoice's own retry loop) -
// higher-weight candidates tend to land earlier and so get tried (and
// kept) first, but every candidate is still reachable if the earlier
// ones all fail validation.
export function weightedShuffle<T>(items: T[], weight: (item: T) => number): T[] {
    const pool = [...items];
    const result: T[] = [];
    while (pool.length > 0) {
        const picked = weightedPick(pool, weight);
        pool.splice(pool.indexOf(picked), 1);
        result.push(picked);
    }
    return result;
}

function randomPlaceMove(game: GnosticaGame): string {
    const candidates = emptyNonVoidCells(game);
    // Structurally shouldn't happen (the board always has somewhere to
    // place in practice), but "discard" would be flatly illegal in
    // this exact state (see this function's own docs) - "" (no legal
    // move) is the honest answer, matching the gameover case above,
    // rather than returning something guaranteed to throw.
    if (candidates.length === 0) {
        return "";
    }
    // Landing on an existing card is weighted 8x over a bare wasteland cell.
    const [x, y] = weightedPick(candidates, ([cx, cy]) => game.board.classify(cx, cy) === "territory" ? 8 : 1);
    const orientation = weightedRandomOrientation(game, x, y);
    return `place ${GnosticaBoard.coords2algebraic(x, y)} ${orientation}`;
}

// Any subset of hand is a legal discard list; an optional "draw <n>"
// suffix (random count up to the room left) is sometimes added,
// otherwise the draw-to-max default applies - see cmdDiscard's own
// docs. Always legal by construction.
function randomDiscardMove(game: GnosticaGame): string {
    const hand = game.hands[game.currplayer - 1];
    const discards = hand.filter(() => Math.random() < 0.3);
    const maxDraw = Math.max(0, 6 - (hand.length - discards.length));
    const tokens = ["discard", ...discards];
    if (Math.random() < 0.5) {
        tokens.push("draw", String(Math.floor(Math.random() * (maxDraw + 1))));
    }
    return tokens.join(" ");
}

// Any of the acting player's own on-board pieces, reoriented to any of
// the 5 facings - unconditionally legal for your own piece. undefined
// only if hasPiecesOnBoard's own scan somehow disagrees with this one
// (defensive; can't happen in the only place this is called from).
export function randomOrientMove(game: GnosticaGame): string | undefined {
    const ownPieces: { x: number; y: number; index: number }[] = [];
    for (const [x, y, t] of game.board.entries()) {
        t.pieces.forEach((p, index) => {
            if (p.owner === game.currplayer) {
                ownPieces.push({ x, y, index });
            }
        });
    }
    if (ownPieces.length === 0) {
        return undefined;
    }
    const picked = ownPieces[Math.floor(Math.random() * ownPieces.length)];
    const { x, y, index } = picked;
    const ref = game.pieceRefStr(picked);
    const current = game.board.get(x, y)!.pieces[index].orientation;
    const orientation = weightedRandomOrientation(game, x, y, current);
    return `orient ${ref} ${orientation}`;
}

// "use"/"play" - candidate card, then a random (possibly empty) power
// chain. See buildRandomChain's own docs for the chain-building
// strategy; this just picks the target card and assembles the final
// move string.
export function randomUseOrPlayMove(game: GnosticaGame, head: "use" | "play"): string | undefined {
    if (head === "use") {
        const onBoard: { uid: string; eligible: IMinionRef[] }[] = [];
        for (const [x, y, t] of game.board.entries()) {
            if (t.card === undefined) {
                continue;
            }
            const eligible = game.eligibleMinionsForActivate(x, y);
            if (eligible.length > 0) {
                onBoard.push({ uid: t.card.uid, eligible });
            }
        }
        if (onBoard.length === 0) {
            return undefined;
        }
        // Prefer a higher-value card - its own point value doubles as
        // a natural "how good is this option" weight (see
        // weightedPick's own docs) - without ever ruling out a lesser
        // one.
        const { uid, eligible } = weightedPick(onBoard, ({ uid: u }) => cardPointValue(allCards().find(c => c.uid === u)));
        if (uid === "21") {
            return buildRandomWorldMove(game, "use", eligible);
        }
        if (uid === "01") {
            return buildRandomMagicianMove(game, "use", eligible);
        }
        const card = allCards().find(c => c.uid === uid)!;
        const chain = buildRandomChain(game, card, eligible);
        const steps = chain.map(tokens => tokens.join(" "));
        return steps.length === 0 ? `use ${uid}` : `use ${uid}/${steps.join("/")}`;
    }
    const hand = game.hands[game.currplayer - 1];
    if (hand.length === 0) {
        return undefined;
    }
    const uid = weightedPick(hand, u => cardPointValue(allCards().find(c => c.uid === u)));
    const eligible = game.eligibleMinionsForPlay();
    // cmdPlay removes the played card from hand before resolving its
    // power (it's spent to fund the ability, same as a discard) - true
    // for World exactly like any other card - so a chain step that spends
    // a hand card (Cups "new", Discs/Swords "tile") can't legally reuse
    // this exact uid as its own material. Temporarily removing it here -
    // restored below regardless of outcome, since this speculative build
    // must never leave a lasting side effect on the real hand - makes
    // buildRandomChain's own hand reads see the same post-play hand a
    // real commit would.
    const handIdx = hand.indexOf(uid);
    hand.splice(handIdx, 1);
    try {
        if (uid === "21") {
            return buildRandomWorldMove(game, "play", eligible);
        }
        if (uid === "01") {
            return buildRandomMagicianMove(game, "play", eligible);
        }
        const card = allCards().find(c => c.uid === uid)!;
        const chain = buildRandomChain(game, card, eligible);
        const steps = chain.map(tokens => tokens.join(" "));
        return steps.length === 0 ? `play ${uid}` : `play ${uid}/${steps.join("/")}`;
    } finally {
        hand.splice(handIdx, 0, uid);
    }
}

// A random legal major arcana uid for World to borrow (excluding itself) -
// the "as <uid>" head annotation checkWorldChoosePower requires is the
// ONLY legality rule ("present on the board, not World itself" - see its
// own docs), so any random pick from the board's own majors is legal by
// construction. undefined when nothing else is on the board yet - World
// then has nothing to borrow, matching how it validates for real
// (WORLD_BORROW_REQUIRED/complete:-1 for a bare "use 21").
function randomWorldBorrowUid(game: GnosticaGame): string | undefined {
    const majors: string[] = [];
    for (const [, , t] of game.board.entries()) {
        if (t.card !== undefined && t.card.major && t.card.uid !== "21") {
            majors.push(t.card.uid);
        }
    }
    return majors.length === 0 ? undefined : majors[Math.floor(Math.random() * majors.length)];
}

// World's own move string: "<head> 21 as <borrowed>[/<steps>]". The
// borrowed card's own steps are built via buildRandomChain exactly like
// a fresh activation would build them for itself, using World's own
// eligible pool - the acting minion World's own step inherits into the
// pushed frame (see applyPowerStep's own "worldUseAny" case).
function buildRandomWorldMove(game: GnosticaGame, head: "use" | "play", eligible: IMinionRef[]): string | undefined {
    const borrowedUid = randomWorldBorrowUid(game);
    if (borrowedUid === undefined) {
        return undefined;
    }
    const borrowedCard = allCards().find(c => c.uid === borrowedUid)!;
    const chain = buildRandomChain(game, borrowedCard, eligible);
    const steps = chain.map(tokens => tokens.join(" "));
    return steps.length === 0 ? `${head} 21 as ${borrowedUid}` : `${head} 21 as ${borrowedUid}/${steps.join("/")}`;
}

// A random legal (suit, one-step chain) combination for a FRESH Magician
// activation - shared by a root "use"/"play 01" (buildRandomMagicianMove
// below) and a Fool-revealed Magician (generateRandomMove's own resume
// branch). Both put the suit in the head's "as <suit>", never a step
// token - only a Magician frame PUSHED BY WORLD reads its suit from its
// own step instead, since World's own borrow already spent the head's
// one asUid slot (see gnostica.ts's deriveStepTokens/walkFrameStack for
// the matching real-commit rule, and buildRandomMagicianChoiceTokens
// below for that one remaining case). findRandomPrimitiveChoice does the
// real legality search, same as an ordinary suit card's own single step
// (buildRandomStepTokens's own twin).
function findRandomMagicianChain(game: GnosticaGame, minions: IMinionRef[]): { suitUid: string; chain: string[][] } | undefined {
    for (const suit of shuffle([...ALL_SUITS]) as typeof ALL_SUITS) {
        const choice = findRandomPrimitiveChoice(game, suit.uid, minions, {});
        if (choice === undefined) {
            continue;
        }
        const ref = game.pieceRefStr(choice.minion, minions);
        return { suitUid: suit.uid, chain: [[ref, choice.mode, ...choice.args]] };
    }
    return undefined;
}

// Magician's own move string: "<head> 01 as <suit>/<minionRef> <mode>
// <args>".
function buildRandomMagicianMove(game: GnosticaGame, head: "use" | "play", minions: IMinionRef[]): string | undefined {
    const found = findRandomMagicianChain(game, minions);
    if (found === undefined) {
        return undefined;
    }
    const steps = found.chain.map(tokens => tokens.join(" "));
    return `${head} 01 as ${found.suitUid}/${steps.join("/")}`;
}

// Every legal target ref for a minion's own "piece"-shaped actions:
// itself, plus every piece (any owner) sitting in its facing cell -
// exactly the target set checkValidPieceTarget allows. Shared by every
// builder below that needs a piece-shaped target (R.piece/D.piece/
// S.piece, tradeHands, orientAny, hierophantReplace, hermitTeleport's
// own "piece" mode).
function pieceTargetRefs(game: GnosticaGame, minion: IMinionRef): string[] {
    const [tx, ty] = game.minorTargetCell(minion);
    // Pass `minion` itself as a one-entry pool so pieceRefStr can find it
    // and use its own `.piece` (see #98/#100's own docs) - without a
    // pool, it falls straight to a raw `pieces[minion.index]` read, which
    // can be stale by the time a LATER step in the same chain calls this.
    const selfRef = game.pieceRefStr(minion, [minion]);
    if (tx === minion.x && ty === minion.y) {
        return [selfRef];
    }
    const targetT = game.board.get(tx, ty);
    const facingRefs = (targetT?.pieces ?? []).map((_, i) => game.pieceRefStr({ x: tx, y: ty, index: i }));
    return [selfRef, ...facingRefs];
}

// Same target set as pieceTargetRefs, but keeping each ref's owner
// alongside it - used only to weight R.piece/D.piece/S.piece
// candidates toward "grow/reposition your own minion, attack someone
// else's" (see buildRandomModeArgCandidates's own docs). Every OTHER
// pieceTargetRefs caller (tradeHands, orientAny, hierophantReplace,
// hermitTeleport) has no such constructive/destructive distinction to
// weight, so it isn't worth widening the shared helper's own return
// type for them.
function pieceTargetRefsWithOwner(game: GnosticaGame, minion: IMinionRef): { ref: string; owner: number }[] {
    const [tx, ty] = game.minorTargetCell(minion);
    const selfOwner = (minion.piece ?? game.board.get(minion.x, minion.y)!.pieces[minion.index]).owner;
    // See pieceTargetRefs' own matching docs on why `minion` is passed as
    // a one-entry pool here.
    const selfRef = game.pieceRefStr(minion, [minion]);
    if (tx === minion.x && ty === minion.y) {
        return [{ ref: selfRef, owner: selfOwner }];
    }
    const targetT = game.board.get(tx, ty);
    const facing = (targetT?.pieces ?? []).map((p, i) => ({ ref: game.pieceRefStr({ x: tx, y: ty, index: i }), owner: p.owner }));
    return [{ ref: selfRef, owner: selfOwner }, ...facing];
}

// Same target set as pieceTargetRefs, but keeping each ref's own current
// orientation alongside it - hierophantReplace's own random mover needs
// it to build the mandatory, seeded `<facing>?` token (validateHierophantReplace's
// own convention - see its docs).
function pieceTargetRefsWithOrientation(game: GnosticaGame, minion: IMinionRef): { ref: string; orientation: Orientation }[] {
    const [tx, ty] = game.minorTargetCell(minion);
    const selfOrientation = (minion.piece ?? game.board.get(minion.x, minion.y)!.pieces[minion.index]).orientation;
    const selfRef = game.pieceRefStr(minion, [minion]);
    if (tx === minion.x && ty === minion.y) {
        return [{ ref: selfRef, orientation: selfOrientation }];
    }
    const targetT = game.board.get(tx, ty);
    const facing = (targetT?.pieces ?? []).map((p, i) => ({ ref: game.pieceRefStr({ x: tx, y: ty, index: i }), orientation: p.orientation }));
    return [{ ref: selfRef, orientation: selfOrientation }, ...facing];
}

// Adapts minorModeAvailability's own switch to a raw minion rather
// than an IPendingStep (reconstructed from a move string, not
// convenient here) - a thin, deliberately-looser wrapper over the
// exact same per-mode legality rules, not a second copy of them.
// Best-effort pre-filter only, same as minorModeAvailability itself -
// buildRandomModeArgCandidates + validateSuitPrimitive remain the real
// gate.
function legalModesForMinion(game: GnosticaGame, minion: IMinionRef, suitUid: string, opts: Record<string, unknown>): string[] {
    return [...game.minorModeAvailability({ suitUid, minion, opts }).entries()]
        .filter(([, reason]) => reason === undefined)
        .map(([mode]) => mode);
}

// Every plausible full set of trailing args (after "<minionRef>
// <mode>") for one suit-mode, given hand sizes/pip counts small enough
// that a full enumeration is cheap - not just one random guess, since
// several of these (a hand card matching an exact value, a specific
// victim among several) have a narrow or empty legal set that blind
// random guessing would miss far more often than it hit. Each
// candidate carries a weight (see weightedPick's own docs) biasing
// findRandomPrimitiveChoice's search toward constructive actions
// (grow/create) landing on the acting player's OWN minion/territory,
// and destructive actions (attack) landing on someone else's or a
// neutral one - a piece/territory-shrinking action against your own
// side, or a growing one that only helps an opponent, is rarely what
// a player actually wants, even though the rules allow it. Modes with
// no self/other choice at all in their own target set (C.own/C.enemy/
// C.new/R.tile, each always self-only, enemy-only, or plain territory)
// get a flat weight of 1 throughout.
function buildRandomModeArgCandidates(game: GnosticaGame, minion: IMinionRef, suitUid: string, mode: string): { args: string[]; weight: number }[] {
    const piece = minion.piece ?? game.board.get(minion.x, minion.y)!.pieces[minion.index];
    const [tx, ty] = game.minorTargetCell(minion);
    const targetCell = GnosticaBoard.coords2algebraic(tx, ty);
    const targetT = game.board.get(tx, ty);
    const hand = game.hands[game.currplayer - 1];
    const pieceTargets = pieceTargetRefsWithOwner(game, minion);
    const pips = Array.from({ length: piece.size }, (_, i) => String(i + 1));
    const cardsWorth = (value: number) => hand.filter(uid => {
        const c = allCards().find(cc => cc.uid === uid);
        return c !== undefined && cardPointValue(c) === value;
    });
    const flat = (candidates: string[][]): { args: string[]; weight: number }[] => candidates.map(args => ({ args, weight: 1 }));
    // Growing/attacking a territory benefits whoever currently profits
    // from it uncontested - a cell nobody profits from yet (contested,
    // or genuinely neutral) counts as "not the acting player's own"
    // for this purpose, same as an outright enemy-controlled one.
    const benefitsSelf = targetT?.isUncontestedBy(game.currplayer) ?? false;

    switch (`${suitUid}.${mode}`) {
        case "C.own":
            return flat(allOrientations.map(o => [targetCell, o]));
        case "C.enemy":
            return flat((targetT?.pieces ?? [])
                .map((p, i) => ({ p, i }))
                .filter(({ p }) => p.owner !== game.currplayer)
                .map(({ i }) => [targetCell, game.victimRefStr(tx, ty, i)]));
        case "C.new":
            return flat(cardsWorth(1).map(uid => [targetCell, uid]));
        case "R.piece": {
            // Moving your own minion is ordinary positioning; shoving
            // an enemy's is a real but less common destructive tactic
            // (e.g. into the void) - lean toward self without ruling
            // the other out. Within "move your own minion" candidates
            // specifically, also lean toward whatever distance lands it
            // on a territory cell rather than a bare wasteland - moving
            // your own piece off a productive cell for no reason isn't
            // something a real player would usually choose, even though
            // the rules allow it (an enemy's piece gets no such
            // preference: walking it off into the wasteland is a
            // legitimate destructive use of the same mode).
            const [dx, dy] = game.board.delta(piece.orientation as Exclude<Orientation, "U">);
            const selfRef = game.pieceRefStr(minion);
            return pieceTargets.flatMap(({ ref, owner }) => {
                const [bx, by] = ref === selfRef ? [minion.x, minion.y] : [tx, ty];
                return pips.map(d => {
                    const dist = Number(d);
                    const ownWeight = owner === game.currplayer ? 2 : 1;
                    const landsOnTerritory = owner === game.currplayer
                        && game.board.classify(bx + dx * dist, by + dy * dist) === "territory";
                    return { args: [ref, d], weight: ownWeight * (landsOnTerritory ? 2 : 1) };
                });
            });
        }
        case "R.tile":
            return flat(pips.map(d => [d]));
        case "D.piece":
            // Growing is constructive - strongly favor your own minion
            // over an enemy's.
            return pieceTargets.map(({ ref, owner }) => ({ args: [ref], weight: owner === game.currplayer ? 3 : 1 }));
        case "D.tile": {
            const current = targetT?.pointValue() ?? 0;
            const weight = benefitsSelf ? 3 : 1;
            return [...cardsWorth(current + 1), ...cardsWorth(current + 2)].map(uid => ({ args: [targetCell, uid], weight }));
        }
        case "S.piece":
            // Attacking is destructive - strongly favor an enemy's
            // minion over your own.
            return pieceTargets.flatMap(({ ref, owner }) =>
                pips.map(p => ({ args: [ref, p], weight: owner === game.currplayer ? 1 : 3 })));
        case "S.tile": {
            const current = targetT?.pointValue() ?? 0;
            const weight = benefitsSelf ? 1 : 3;
            const results: { args: string[]; weight: number }[] = [];
            for (const p of pips) {
                const resultValue = current - Number(p);
                if (resultValue < 0) {
                    continue;
                }
                if (resultValue === 0) {
                    results.push({ args: [targetCell, p], weight });
                } else {
                    for (const uid of cardsWorth(resultValue)) {
                        results.push({ args: [targetCell, p, uid], weight });
                    }
                }
            }
            return results;
        }
        default:
            return [];
    }
}

// Searches for one legal (minion, mode, args) combination for a suit
// primitive - shuffled minion pool, shuffled legal modes per minion,
// weighted-shuffled arg candidates per mode (see
// buildRandomModeArgCandidates's own docs on the weighting), first
// fully-validated combination wins. Returns the raw pieces (not yet
// assembled into a move-string token array) since magicianChoice needs
// the same raw minion to build its own doubly-wrapped step;
// buildRandomStepTokens below is the thin wrapper that assembles
// tokens for direct suit-mode use.
function findRandomPrimitiveChoice(
    game: GnosticaGame, suitUid: string, minions: IMinionRef[], opts: Record<string, unknown>,
): { minion: IMinionRef; mode: string; args: string[] } | undefined {
    const pool = shuffle([...minions]) as IMinionRef[];
    for (const minion of pool) {
        const modeCandidates = legalModesForMinion(game, minion, suitUid, opts)
            .map(mode => ({ mode, candidates: buildRandomModeArgCandidates(game, minion, suitUid, mode) }));
        // R.piece's own best candidate weight already tells us whether
        // ANY way of using it here actually lands the acting player's
        // own minion on a territory cell (see buildRandomModeArgCandidates's
        // R.piece case - that combination alone reaches weight 4). When
        // it doesn't - every option either moves an enemy or stubbornly
        // strands your own piece in the wasteland (a fixed 1-space hop
        // for a size-1 minion has no better distance to pick) - this
        // mode is a comparatively weak choice for THIS minion
        // specifically, so it's down-weighted against this minion's
        // other legal modes rather than picked on equal footing.
        // C.own's own target cell is entirely fixed by the minion's
        // facing (no arg choice to weight the way R.piece has) - landing
        // a new own piece on an already-established territory keeps it
        // immediately productive, while landing on bare wasteland is
        // the normal "push into new ground" use of the mode, still
        // legal and often the only option a minion actually has. Both
        // cases favor the acting player's own placement; still legal,
        // still sometimes chosen - "prefer, don't require" (see
        // weightedPick's own docs), same philosophy as every other
        // weighting in this file.
        const modeWeight = ({ mode, candidates }: { mode: string; candidates: { weight: number }[] }): number => {
            const key = `${suitUid}.${mode}`;
            if (key === "R.piece" && candidates.length > 0) {
                return Math.max(...candidates.map(c => c.weight)) >= 4 ? 3 : 1;
            }
            if (key === "C.own") {
                const [tx, ty] = game.minorTargetCell(minion);
                return game.board.classify(tx, ty) === "territory" ? 3 : 1;
            }
            return 3;
        };
        const orderedModes = weightedShuffle(modeCandidates, modeWeight);
        for (const { mode, candidates } of orderedModes) {
            const ordered = weightedShuffle(candidates, c => c.weight);
            for (const { args } of ordered) {
                const check = game.validateSuitPrimitive(suitUid, minion, mode, args, opts);
                if (!check.failed) {
                    return { minion, mode, args };
                }
            }
        }
    }
    return undefined;
}

function buildRandomStepTokens(game: GnosticaGame, suitUid: string, minions: IMinionRef[], opts: Record<string, unknown>): string[] | undefined {
    const choice = findRandomPrimitiveChoice(game, suitUid, minions, opts);
    if (choice === undefined) {
        return undefined;
    }
    const ref = game.pieceRefStr(choice.minion, minions);
    return [ref, choice.mode, ...choice.args];
}

// A major card's own `primitive` step - same suit machinery as a minor
// card's single step, but the relaxation opts a shortcut card
// (Chariot/Strength/Death/Sun/Star/Moon/Empress/Emperor) grants for
// THIS step depend on where it sits in the chain, hence threading
// def/stepIndex/totalSteps through to computeShortcutOpts - the same
// call a real commit makes - rather than always building against the
// unrelaxed rules. computeShortcutOpts's relaxations only ever WIDEN
// legality, so skipping this would be safe, just needlessly weaker
// coverage of those cards' own shortcut paths.
function buildRandomPrimitiveStepTokens(
    game: GnosticaGame, primitive: SuitPrimitive, minions: IMinionRef[], def: MajorArcanaDef, stepOpts: PrimitiveOpts | undefined, stepIndex: number, totalSteps: number,
): string[] | undefined {
    const suitUid = game.primitiveToSuit(primitive);
    const opts = game.computeShortcutOpts(def, primitive, stepIndex, totalSteps, stepOpts);
    return buildRandomStepTokens(game, suitUid, minions, opts);
}

function buildRandomOrientMinionTokens(game: GnosticaGame, minions: IMinionRef[]): string[] | undefined {
    const pool = shuffle([...minions]) as IMinionRef[];
    for (const minion of pool) {
        for (const o of shuffle([...allOrientations]) as Orientation[]) {
            const check = game.validateOrientMinion(minion, [o]);
            if (!check.failed) {
                const ref = game.pieceRefStr(minion, minions);
                return [ref, o];
            }
        }
    }
    return undefined;
}

function buildRandomTradeHandsTokens(game: GnosticaGame, minions: IMinionRef[]): string[] | undefined {
    const pool = shuffle([...minions]) as IMinionRef[];
    for (const minion of pool) {
        for (const targetRef of shuffle(pieceTargetRefs(game, minion)) as string[]) {
            const check = game.validateTradeHands(minion, [targetRef]);
            if (!check.failed) {
                const ref = game.pieceRefStr(minion, minions);
                return [ref, targetRef];
            }
        }
    }
    return undefined;
}

// Shared by orientAny (Devil) and hierophantReplace (Hierophant) - same
// self-or-facing-cell target-pick logic, but genuinely different move
// shapes: orientAny's facing is a plain mandatory token with no default,
// while hierophantReplace's is mandatory-but-seeded (the captured
// piece's own prior facing, written as a "?"-marked token - matches
// validateHierophantReplace's own convention, mirroring Cups "own").
// `undefined` joins hierophantReplace's shuffled correction candidates
// so the random mover sometimes leaves that seeded default in place
// instead of always overriding it.
function buildRandomOrientAnyOrHierophantTokens(game: GnosticaGame, minions: IMinionRef[], special: "orientAny" | "hierophantReplace"): string[] | undefined {
    const pool = shuffle([...minions]) as IMinionRef[];
    for (const minion of pool) {
        if (special === "orientAny") {
            for (const targetRef of shuffle(pieceTargetRefs(game, minion)) as string[]) {
                for (const o of shuffle([...allOrientations]) as Orientation[]) {
                    const check = game.validateOrientAny(minion, [targetRef, o]);
                    if (!check.failed) {
                        const ref = game.pieceRefStr(minion, minions);
                        return [ref, targetRef, o];
                    }
                }
            }
            continue;
        }
        for (const { ref: targetRef, orientation: capturedFacing } of shuffle(pieceTargetRefsWithOrientation(game, minion)) as { ref: string; orientation: Orientation }[]) {
            const orientationToken = `${capturedFacing}?`;
            for (const o of shuffle([...allOrientations, undefined]) as (Orientation | undefined)[]) {
                const rest = o === undefined ? [targetRef, orientationToken] : [targetRef, orientationToken, o];
                const check = game.validateHierophantReplace(minion, rest);
                if (!check.failed) {
                    return [game.pieceRefStr(minion, minions), ...rest];
                }
            }
        }
    }
    return undefined;
}

function buildRandomHermitTokens(game: GnosticaGame, minions: IMinionRef[]): string[] | undefined {
    const destinations = shuffle(emptyNonVoidCells(game)) as [number, number][];
    if (destinations.length === 0) {
        return undefined;
    }
    const pool = shuffle([...minions]) as IMinionRef[];
    for (const minion of pool) {
        for (const mode of shuffle(["piece", "tile"]) as string[]) {
            const targetToken = mode === "piece"
                ? undefined // resolved per-candidate below (piece mode has several possible targets)
                : GnosticaBoard.coords2algebraic(...game.minorTargetCell(minion));
            const pieceTargets = mode === "piece" ? shuffle(pieceTargetRefs(game, minion)) as string[] : [targetToken as string];
            for (const target of pieceTargets) {
                for (const [dx, dy] of destinations) {
                    const destCell = GnosticaBoard.coords2algebraic(dx, dy);
                    const check = game.validateHermitStep(minion, [mode, target, destCell]);
                    if (!check.failed) {
                        const ref = game.pieceRefStr(minion, minions);
                        return [ref, mode, target, destCell];
                    }
                }
            }
        }
    }
    return undefined;
}

function buildRandomJudgementDrawTokens(game: GnosticaGame, minions: IMinionRef[]): string[] | undefined {
    const pool = shuffle([...minions]) as IMinionRef[];
    const hand = game.hands[game.currplayer - 1];
    for (const minion of pool) {
        const piece = minion.piece ?? game.board.get(minion.x, minion.y)!.pieces[minion.index];
        const maxDraw = Math.min(piece.size, Math.max(0, 6 - hand.length));
        const count = Math.floor(Math.random() * (maxDraw + 1));
        const uids = (shuffle([...game.discardPile]) as string[]).slice(0, count);
        if (game.validateJudgementDraw(minion, uids).valid) {
            const ref = game.pieceRefStr(minion, minions);
            return [ref, ...uids];
        }
    }
    return undefined;
}

// No minion involved at all - pure hand/pile manipulation. Always
// legal by construction (a random subset of the acting player's own
// hand, each uid distinct since it's drawn from `hand` itself).
function buildRandomHighPriestessTokens(game: GnosticaGame): string[] {
    const hand = game.hands[game.currplayer - 1];
    const discards = hand.filter(() => Math.random() < 0.3);
    return game.validateHighPriestess(["discard", ...discards]).valid ? discards : [];
}

// Round 2's own resume, reusing round 1's exact discard-uid randomization
// above plus the ordinary top-level discard action's own "sometimes name
// an explicit draw count" behaviour (randomDiscardMove) - both rounds
// share the identical <discardUid...> [draw <n>] grammar and legality
// (checkHighPriestess never distinguishes them), so there's nothing
// round-2-specific left to derive here. One thing IS round-2-specific
// though: a fully empty result (no discards, no "draw") would render as
// a bare "discard (via <uid>)" - indistinguishable from
// resumeStepSegments' own "nothing typed yet, just a preview seed" check
// (see its own docs), so the resume would silently no-op instead of
// actually clearing the obligation. Never omit "draw" when there are no
// discards to disambiguate it - mirrors the top-level Pass button's own
// identical "discard draw 0", never bare "discard", for the same reason.
function buildRandomHighPriestessResumeTokens(game: GnosticaGame): string[] {
    const discards = buildRandomHighPriestessTokens(game);
    if (discards.length === 0 || Math.random() < 0.5) {
        const hand = game.hands[game.currplayer - 1];
        const maxDraw = Math.max(0, 6 - (hand.length - discards.length));
        return [...discards, "draw", String(Math.floor(Math.random() * (maxDraw + 1)))];
    }
    return discards;
}

// Only ever reached with a World-pushed Magician frame - a fresh root
// Magician activation is intercepted earlier by buildRandomMagicianMove,
// which puts the suit in the head's "as <suit>" instead. World's own
// borrow already spent that one asUid slot naming which card to push, so
// the pushed Magician frame's own suit has nowhere to go but its own step
// token (see gnostica.ts's deriveStepTokens/walkFrameStack for the
// matching real-commit rule) - reuse findRandomPrimitiveChoice directly
// rather than re-deriving mode/arg legality, then verify the doubly-
// wrapped shape via validateMagicianChoice as this step's own final check.
function buildRandomMagicianChoiceTokens(game: GnosticaGame, minions: IMinionRef[]): string[] | undefined {
    for (const suit of shuffle([...ALL_SUITS]) as typeof ALL_SUITS) {
        const choice = findRandomPrimitiveChoice(game, suit.uid, minions, {});
        if (choice === undefined) {
            continue;
        }
        const check = game.validateMagicianChoice(choice.minion, [suit.uid, choice.mode, ...choice.args]);
        if (!check.failed) {
            const ref = game.pieceRefStr(choice.minion, minions);
            return [ref, suit.uid, choice.mode, ...choice.args];
        }
    }
    return undefined;
}

function buildRandomSpecialStepTokens(game: GnosticaGame, special: SpecialPower, minions: IMinionRef[]): string[] | undefined {
    switch (special) {
        case "orientMinion": return buildRandomOrientMinionTokens(game, minions);
        case "tradeHands": return buildRandomTradeHandsTokens(game, minions);
        case "orientAny": return buildRandomOrientAnyOrHierophantTokens(game, minions, "orientAny");
        case "hierophantReplace": return buildRandomOrientAnyOrHierophantTokens(game, minions, "hierophantReplace");
        case "hermitTeleport": return buildRandomHermitTokens(game, minions);
        case "judgementDraw": return buildRandomJudgementDrawTokens(game, minions);
        // Leading "discard" (see resumeStepSegments' own docs, gnostica.ts)
        // is this step's own real token, unlike buildRandomHighPriestessTokens'
        // OTHER caller below, which feeds bare tokens to buildViaMove -
        // that one already prepends "discard" itself for the resume's
        // own head word.
        case "highPriestess": return ["discard", ...buildRandomHighPriestessTokens(game)];
        // A root magicianChoice never reaches here (buildRandomMagicianMove
        // intercepts it earlier) - only a World-pushed one does.
        case "magicianChoice": return buildRandomMagicianChoiceTokens(game, minions);
        // fool/worldUseAny - never reached; buildRandomChain filters
        // Fool/World out by uid before any step is ever attempted.
        default: return undefined;
    }
}

function buildRandomStepForPowerStep(
    game: GnosticaGame, step: PowerStep, minions: IMinionRef[], def: MajorArcanaDef, stepIndex: number, totalSteps: number,
): string[] | undefined {
    if ("primitive" in step) {
        return buildRandomPrimitiveStepTokens(game, step.primitive, minions, def, step.opts, stepIndex, totalSteps);
    }
    return buildRandomSpecialStepTokens(game, step.special, minions);
}

// Builds a random (possibly empty) power-step chain for a "use"/"play"
// target card. Minor arcana get at most their one single step; major
// arcana chain through def.powers in order, threading each step's
// outcome.newMinion into the next step's own minion pool (the "become
// a minion" rule - see applyMajorPower's own docs, which this mirrors
// exactly). The first step that can't be built stops the chain there -
// no attempt to skip a step and resume building later, matching the
// common real-play pattern.
//
// Final correctness pass: truncates from the end while
// validateMajorPower rejects the assembled chain, since
// computeShortcutOpts's totalSteps-dependent relaxations (e.g.
// Chariot's "every step except the last") can invalidate an earlier
// step once the chain's ACTUAL final length is known, which can differ
// from the length assumed while speculatively building it. Always
// terminates - validateMajorPower(def, eligible, []) is trivially
// legal (no steps to check).
function buildRandomChain(game: GnosticaGame, card: Card, eligible: IMinionRef[]): string[][] {
    if (!card.major) {
        if (eligible.length === 0 || Math.random() < 0.2) {
            return []; // skip outright - always legal
        }
        const suitUid = card.suit.uid;
        const tokens = buildRandomStepTokens(game, suitUid, eligible, {});
        if (tokens === undefined) {
            return [];
        }
        const result = game.validateMinorPower(suitUid, card.uid, eligible, [tokens]);
        // Genuinely submittable is complete !== -1, not === 1 - see the
        // top-level loop's own matching docs. A Rods/Discs/Swords "piece"
        // step landing on the acting player's own minion is legitimately
        // final yet still complete:0 (a further reorientation remains
        // available, never supplied by buildRandomModeArgCandidates).
        return result.valid && result.complete !== -1 ? [tokens] : [];
    }
    const def = getMajorArcanaDef(card);
    if (def.uid === "00") {
        // Fool's own root step consumes no segment regardless of what's
        // typed (its flip is mandatory and automatic - see
        // walkFrameStack's own docs) - there is genuinely nothing to
        // randomize for a fresh Fool activation itself. This is
        // independent of the resume case: once Fool's flip has actually
        // revealed something, generateRandomMove's own continued>0
        // branch calls back into this SAME function with the revealed
        // card, which is never "00" again unless Fool reveals itself.
        return [];
    }
    // World is never reached here directly anymore - randomUseOrPlayMove
    // redirects a World target to buildRandomWorldMove instead, which
    // calls this function with the BORROWED card, not World itself (its
    // own worldUseAny step needs a borrow target named in the move's
    // head, not a step segment - buildRandomChain has no mechanism for
    // that). If World's own def somehow does reach here (a caller bug),
    // buildRandomSpecialStepTokens's own default case already returns
    // undefined for "worldUseAny", so the loop below still degrades to
    // the same empty chain it always returned before.
    if (Math.random() < 0.15) {
        return []; // skip outright sometimes, same as minor arcana
    }
    const stepSegments: string[][] = [];
    let minions = [...eligible];
    // A relocated/replaced-in-place piece (Rods' own "piece" move, say)
    // only exists at chainMinion's own predicted position on a board
    // that's ACTUALLY been mutated to match - validatePowerStep
    // (called below) never mutates anything, so without this, a LATER
    // step's own random-token generation would try to read a real
    // piece off `game`'s own board at a cell nothing was ever placed
    // on. Mirrors validateFrameStack's own identical clone-replay
    // pattern (see its own docs) - `ctx` (not always `game`) is why
    // both the token-generation AND validation calls below use it,
    // once a prior step has forced this chain onto a clone.
    let clone: GnosticaGame | undefined;
    for (let i = 0; i < def.powers.length; i++) {
        const step = def.powers[i];
        const ctx = clone ?? game;
        const tokens = buildRandomStepForPowerStep(ctx, step, minions, def, i, stepSegments.length + 1);
        if (tokens === undefined) {
            break;
        }
        stepSegments.push(tokens);
        const result = ctx.validatePowerStep(step, minions, tokens, def, i, stepSegments.length);
        if (result.failed) {
            stepSegments.pop();
            break;
        }
        const minionsForReplay = minions;
        minions = chainMinion(minions, result.outcome ?? {} as IStepOutcome);
        if (i < def.powers.length - 1) {
            clone ??= game.cloneLive();
            clone.applyPowerStep(step, minionsForReplay, tokens, def, i, def.powers.length, true);
        }
    }
    const isCleanSuccess = (segs: string[][]): boolean => {
        const result = game.validateMajorPower(def, eligible, segs);
        // Stopping partway through a chain that still has a genuinely
        // optional further step left is complete:0, not 1 (see
        // validateFrameStack's own docs) - .valid alone is what actually
        // means "no complaint," complete distinguishes "final" from "more
        // could still be added," which isn't this check's own concern.
        return result.valid;
    };
    while (stepSegments.length > 0 && !isCleanSuccess(stepSegments)) {
        stepSegments.pop();
    }
    return stepSegments;
}
