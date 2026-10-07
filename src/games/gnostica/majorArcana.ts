import { Card } from "../../common/tarot/index.js";

// The four suit primitives every minor-arcana card (and most major powers) reduce to; behaviour lives in powers.ts.
export type SuitPrimitive = "create" | "move" | "grow" | "attack";

export interface PrimitiveOpts {
    ignoreCapacity?: boolean;  // Empress/Emperor: bypass the normal 3-piece-per-territory cap.
    replacementSource?: "hand" | "discard"; // Tower/Star: the replacement card may be drawn from the discards instead.
    allowRandomDraw?: boolean; // Wheel of Fortune: the new territory may be drawn from the deck instead.
    skipStashCheck?: boolean; // Sun/Strength: the same-target shortcut doesn't require a real stash piece.
}

// Powers that don't reduce to a suit primitive - each is bespoke logic implemented directly in powers.ts.
export type SpecialPower =
    | "fool"              // draw and play (or decline) a card from the deck
    | "magicianChoice"    // choose one of sword/rod/cup/disc (as if the Magician were of that suit)
    | "highPriestess"     // one normal discard/draw cycle (as in the base action)
    | "orientMinion"      // orient one of your own pieces (as in the base action)
    | "orientAny"         // orient any piece, even an opponent's (Devil only)
    | "hierophantReplace" // swap the target piece for one of yours, same size, then orient it
    | "hermitTeleport"    // move a targeted piece/territory to any unoccupied space/any non-enemy wasteland.
    | "tradeHands"        // swap hands with the owner of the targeted piece
    | "judgementDraw"     // draw up to N cards (N = max of minion's pip size and hand space available) from the discards.
    | "worldUseAny";      // use the power of any major arcana territory currently on the board

export type PowerStep =
    | { primitive: SuitPrimitive; opts?: PrimitiveOpts }
    | { special: SpecialPower };

// A power as printed on a card: what it does, plus how it is shown.
export type PowerDef = PowerStep & {
    uid: string; // Short id, like a suit's.
    icon: string; // The Gnostica suit-power icon printed on the card for this power.
};

// Every distinct power a major arcana card can list. Variants of one primitive (an unbounded create, say) are separate entries since they print a different icon.
export const POWERS = {
    create: { uid: "C", primitive: "create", icon: "gnostica-cup" },
    move: { uid: "R", primitive: "move", icon: "gnostica-wand" },
    grow: { uid: "D", primitive: "grow", icon: "gnostica-star" },
    attack: { uid: "S", primitive: "attack", icon: "gnostica-sword" },
    createUnbounded: { uid: "C+", primitive: "create", opts: { ignoreCapacity: true }, icon: "gnostica-cupWild" },
    moveUnbounded: { uid: "R+", primitive: "move", opts: { ignoreCapacity: true }, icon: "gnostica-wandWild" },
    createFromDeck: { uid: "C?", primitive: "create", opts: { allowRandomDraw: true }, icon: "gnostica-cupQuestion" },
    attackFromDiscard: { uid: "Sx", primitive: "attack", opts: { replacementSource: "discard" }, icon: "gnostica-swordCycle" },
    growFromDiscard: { uid: "Dx", primitive: "grow", opts: { replacementSource: "discard" }, icon: "gnostica-starCycle" },
    fool: { uid: "F", special: "fool", icon: "gnostica-cardQuestion" },
    magicianChoice: { uid: "M", special: "magicianChoice", icon: "gnostica-allSuits" },
    highPriestess: { uid: "HP", special: "highPriestess", icon: "gnostica-hand" },
    orientMinion: { uid: "O", special: "orientMinion", icon: "gnostica-tip" },
    orientAny: { uid: "V", special: "orientAny", icon: "gnostica-tip" },
    hierophantReplace: { uid: "H", special: "hierophantReplace", icon: "gnostica-transform" },
    hermitTeleport: { uid: "E", special: "hermitTeleport", icon: "gnostica-fly" },
    tradeHands: { uid: "T", special: "tradeHands", icon: "gnostica-handTrade" },
    judgementDraw: { uid: "X", special: "judgementDraw", icon: "gnostica-handCycle" },
    worldUseAny: { uid: "W", special: "worldUseAny", icon: "gnostica-chameleon" },
} satisfies Record<string, PowerDef>;

export interface MajorArcanaDef {
    uid: string;
    name: string;
    seq: number;
    powers: PowerDef[];
    sameTargetShortcut?: boolean; // Strength/Death/Sun/Chariot: same-target step pairs may shortcut.
    moonCapacityExemption?: boolean; // Moon only: may move into a 3-piece territory, as long as the subsequent attack leaves at most 3 there.
}

export const MAJOR_ARCANA: Record<string, MajorArcanaDef> = {
    "00": {
        uid: "00", name: "The Fool", seq: 0,
        powers: [POWERS.fool, POWERS.fool],
    },
    "01": {
        uid: "01", name: "The Magician", seq: 1,
        powers: [POWERS.magicianChoice],
    },
    "02": {
        uid: "02", name: "The High Priestess", seq: 2,
        powers: [POWERS.highPriestess, POWERS.highPriestess],
    },
    "03": {
        uid: "03", name: "The Empress", seq: 3,
        powers: [POWERS.orientMinion, POWERS.createUnbounded],
    },
    "04": {
        uid: "04", name: "The Emperor", seq: 4,
        powers: [POWERS.orientMinion, POWERS.moveUnbounded],
    },
    "05": {
        uid: "05", name: "The Hierophant", seq: 5,
        powers: [POWERS.hierophantReplace],
    },
    "06": {
        uid: "06", name: "The Lovers", seq: 6,
        powers: [POWERS.move, POWERS.create],
    },
    "07": {
        uid: "07", name: "The Chariot", seq: 7,
        powers: [POWERS.move, POWERS.move],
        sameTargetShortcut: true,
    },
    "08": {
        uid: "08", name: "Strength", seq: 8,
        powers: [POWERS.grow, POWERS.grow],
        sameTargetShortcut: true,
    },
    "09": {
        uid: "09", name: "The Hermit", seq: 9,
        powers: [POWERS.hermitTeleport],
    },
    "10": {
        uid: "10", name: "Wheel of Fortune", seq: 10,
        powers: [POWERS.createFromDeck],
    },
    "11": {
        uid: "11", name: "Justice", seq: 11,
        powers: [POWERS.tradeHands, POWERS.attack],
    },
    "12": {
        uid: "12", name: "The Hanged Man", seq: 12,
        powers: [POWERS.move, POWERS.tradeHands],
    },
    "13": {
        uid: "13", name: "Death", seq: 13,
        powers: [POWERS.attack, POWERS.attack],
        sameTargetShortcut: true,
    },
    "14": {
        uid: "14", name: "Temperance", seq: 14,
        powers: [POWERS.create, POWERS.create],
    },
    "15": {
        uid: "15", name: "The Devil", seq: 15,
        powers: [POWERS.orientAny, POWERS.orientAny, POWERS.orientAny],
    },
    "16": {
        uid: "16", name: "The Tower", seq: 16,
        powers: [POWERS.orientMinion, POWERS.attackFromDiscard],
    },
    "17": {
        uid: "17", name: "The Star", seq: 17,
        powers: [POWERS.orientMinion, POWERS.growFromDiscard],
    },
    "18": {
        uid: "18", name: "The Moon", seq: 18,
        powers: [POWERS.move, POWERS.attack],
        moonCapacityExemption: true,
    },
    "19": {
        uid: "19", name: "The Sun", seq: 19,
        powers: [POWERS.create, POWERS.grow],
        sameTargetShortcut: true,
    },
    "20": {
        uid: "20", name: "Judgement", seq: 20,
        powers: [POWERS.judgementDraw],
    },
    "21": {
        uid: "21", name: "The World", seq: 21,
        powers: [POWERS.worldUseAny],
    },
};

export const getMajorArcanaDef = (card: Card): MajorArcanaDef => MAJOR_ARCANA[card.uid];
