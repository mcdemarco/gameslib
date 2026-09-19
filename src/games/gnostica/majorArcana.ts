import { Card } from "../../common/tarot";

// The four suit primitives every minor-arcana card (and most major powers) reduce to; behaviour lives in powers.ts.
export type SuitPrimitive = "create" | "move" | "grow" | "attack";

export interface PrimitiveOpts {
    // Empress/Emperor: bypass the normal 3-piece-per-territory cap.
    ignoreCapacity?: boolean;
    // Tower/Star: the replacement card may come from anywhere in the discard pile, not just the hand.
    replacementSource?: "hand" | "discard";
    // Wheel of Fortune: the new territory's card may be drawn randomly from the draw pile instead of played from hand.
    allowRandomDraw?: boolean;
    // Sun/Strength: a same-target shortcut's intermediate size is only ever transient, so its own step doesn't need a real stash piece.
    skipStashCheck?: boolean;
}

// Powers that don't reduce to a suit primitive - each is bespoke logic implemented directly in powers.ts.
export type SpecialPower =
    | "fool"              // flip and optionally play the top card of the draw pile
    | "magicianChoice"    // this step IS one of sword/rod/cup/disc, chosen at resolution time
    | "highPriestess"     // one discard-any-then-redraw-to-6 round
    | "orientMinion"      // orient one of your own pieces
    | "orientAny"         // orient any piece, even an opponent's (Devil only)
    | "hierophantReplace" // swap the target piece for one of yours, same size, then orient it
    | "hermitTeleport"    // move a piece/territory anywhere on the board, ignoring adjacency
    | "tradeHands"        // swap hands with the owner of the targeted piece
    | "judgementDraw"     // draw N cards (N = minion's pip size) from anywhere in the discard pile
    | "worldUseAny";      // use the power of any major arcana territory currently on the board

export type PowerStep =
    | { primitive: SuitPrimitive; opts?: PrimitiveOpts }
    | { special: SpecialPower };

export interface MajorArcanaDef {
    uid: string;
    name: string;
    seq: number;
    // Which suit-power icon(s) are printed on the card, in power order - Gnostica's own interpretation, not real tarot.
    icons: string[];
    powers: PowerStep[];
    // Strength/Death/Sun/Chariot: same-target step pairs may shortcut (skip a rung / pass through); powers.ts interprets per primitive.
    sameTargetShortcut?: boolean;
    // Moon only: its move step may enter a 3-piece territory, as long as the follow-up attack leaves at most 3 there.
    moonCapacityExemption?: boolean;
}

export const MAJOR_ARCANA: Record<string, MajorArcanaDef> = {
    "00": {
        uid: "00", name: "The Fool", seq: 0,
        icons: ["gnostica-cardQuestion", "gnostica-cardQuestion"],
        powers: [{ special: "fool" }, { special: "fool" }],
    },
    "01": {
        uid: "01", name: "The Magician", seq: 1,
        icons: ["gnostica-allSuits"],
        powers: [{ special: "magicianChoice" }],
    },
    "02": {
        uid: "02", name: "The High Priestess", seq: 2,
        icons: ["gnostica-hand", "gnostica-hand"],
        powers: [{ special: "highPriestess" }, { special: "highPriestess" }],
    },
    "03": {
        uid: "03", name: "The Empress", seq: 3,
        icons: ["gnostica-tip", "gnostica-cupWild"],
        powers: [{ special: "orientMinion" }, { primitive: "create", opts: { ignoreCapacity: true } }],
    },
    "04": {
        uid: "04", name: "The Emperor", seq: 4,
        icons: ["gnostica-tip", "gnostica-wandWild"],
        powers: [{ special: "orientMinion" }, { primitive: "move", opts: { ignoreCapacity: true } }],
    },
    "05": {
        uid: "05", name: "The Hierophant", seq: 5,
        icons: ["gnostica-transform"],
        powers: [{ special: "hierophantReplace" }],
    },
    "06": {
        uid: "06", name: "The Lovers", seq: 6,
        icons: ["gnostica-wand", "gnostica-cup"],
        powers: [{ primitive: "move" }, { primitive: "create" }],
    },
    "07": {
        uid: "07", name: "The Chariot", seq: 7,
        icons: ["gnostica-wand", "gnostica-wand"],
        powers: [{ primitive: "move" }, { primitive: "move" }],
        sameTargetShortcut: true,
    },
    "08": {
        uid: "08", name: "Strength", seq: 8,
        icons: ["gnostica-star", "gnostica-star"],
        powers: [{ primitive: "grow" }, { primitive: "grow" }],
        sameTargetShortcut: true,
    },
    "09": {
        uid: "09", name: "The Hermit", seq: 9,
        icons: ["gnostica-fly"],
        powers: [{ special: "hermitTeleport" }],
    },
    "10": {
        uid: "10", name: "Wheel of Fortune", seq: 10,
        icons: ["gnostica-cupQuestion"],
        powers: [{ primitive: "create", opts: { allowRandomDraw: true } }],
    },
    "11": {
        uid: "11", name: "Justice", seq: 11,
        icons: ["gnostica-handTrade", "gnostica-sword"],
        powers: [{ special: "tradeHands" }, { primitive: "attack" }],
    },
    "12": {
        uid: "12", name: "The Hanged Man", seq: 12,
        icons: ["gnostica-wand", "gnostica-handTrade"],
        powers: [{ primitive: "move" }, { special: "tradeHands" }],
    },
    "13": {
        uid: "13", name: "Death", seq: 13,
        icons: ["gnostica-sword", "gnostica-sword"],
        powers: [{ primitive: "attack" }, { primitive: "attack" }],
        sameTargetShortcut: true,
    },
    "14": {
        uid: "14", name: "Temperance", seq: 14,
        icons: ["gnostica-cup", "gnostica-cup"],
        powers: [{ primitive: "create" }, { primitive: "create" }],
    },
    "15": {
        uid: "15", name: "The Devil", seq: 15,
        icons: ["gnostica-tip", "gnostica-tip", "gnostica-tip"],
        powers: [{ special: "orientAny" }, { special: "orientAny" }, { special: "orientAny" }],
    },
    "16": {
        uid: "16", name: "The Tower", seq: 16,
        icons: ["gnostica-tip", "gnostica-swordCycle"],
        powers: [{ special: "orientMinion" }, { primitive: "attack", opts: { replacementSource: "discard" } }],
    },
    "17": {
        uid: "17", name: "The Star", seq: 17,
        icons: ["gnostica-tip", "gnostica-starCycle"],
        powers: [{ special: "orientMinion" }, { primitive: "grow", opts: { replacementSource: "discard" } }],
    },
    "18": {
        uid: "18", name: "The Moon", seq: 18,
        icons: ["gnostica-wand", "gnostica-sword"],
        powers: [{ primitive: "move" }, { primitive: "attack" }],
        moonCapacityExemption: true,
    },
    "19": {
        uid: "19", name: "The Sun", seq: 19,
        icons: ["gnostica-cup", "gnostica-star"],
        powers: [{ primitive: "create" }, { primitive: "grow" }],
        sameTargetShortcut: true,
    },
    "20": {
        uid: "20", name: "Judgement", seq: 20,
        icons: ["gnostica-handCycle"],
        powers: [{ special: "judgementDraw" }],
    },
    "21": {
        uid: "21", name: "The World", seq: 21,
        icons: ["gnostica-chameleon"],
        powers: [{ special: "worldUseAny" }],
    },
};

export const getMajorArcanaDef = (card: Card): MajorArcanaDef => MAJOR_ARCANA[card.uid];

// Separate accessor since rendering code only ever wants the icon list.
export const MAJOR_ARCANA_ICONS: Record<string, string[]> = Object.fromEntries(
    Object.entries(MAJOR_ARCANA).map(([uid, def]) => [uid, def.icons])
);
export const getMajorArcanaIcons = (card: Card): string[] => MAJOR_ARCANA[card.uid].icons;
