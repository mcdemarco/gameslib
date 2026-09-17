# Gnostica move-string catalogue

Reference table of real, verified move strings for every top-level head and
every `use`/`play` power-step shape. Format: `use <cardUid>[/<step1>][/<step2>]...`
(or `play`). Each `/`-separated segment starts with `<minionRef>` (e.g. `m0.1`)
except High Priestess.

| Context                                             | Example move string                              | New move string                                                        |
|-----------------------------------------------------|--------------------------------------------------|------------------------------------------------------------------------|
| **place** (initial piece)                           | `place n0 U`                                     |                                                                        |
| **orient** (top-level reorient)                     | `orient n0.1 N`                                  |                                                                        |
| **discard** (ordinary discard/draw)                 | `discard AC KS draw 2`                           |                                                                        |
| **bid** (bidding phase)                             | `bid 2`                                          | (these are unchanged)                                                  |
| **redraw** (redraw phase)                           | `redraw AC KS 5D`                                |                                                                        |
| **pass** (redraw phase / forced)                    | `pass`                                           |                                                                        |
| **use** (bare, no power step)                       | `use AC`                                         |                                                                        |
| **use** — Cups own                                  | `use AC/m0.1 own n0 U`                           | `use AC/with m0.1 at n0 create U`                                      |
| **use** — Cups enemy                                | `use AC/m0.1 enemy n0 1`                         | `use AC/with m0.1 at n0 create n0.1`                                      |
| **use** — Cups new                                  | `use AC/l0.1 new k0 5D`                          | `use AC/with l0.1 at k0 create 5D`                                     |
| **use** — Rods piece                                | `use AR/m0.1 piece m0.1 1 N`                     | `use AR/with m0.1 move m0.1 1 orient N`                                |
| **use** — Rods tile                                 | `use AR/m0.1 tile 1`                             | `use AR/with m0.1 move n0 1`                                           |
| **use** — Discs piece                               | `use AD/m0.1 piece m0.1 N`                       | `use AD/with m0.1 grow m0.1 orient N`                                  |
| **use** — Discs tile                                | `use AD/m0.1 tile n0 QD`                         | `use AD/with m0.1 grow n0 to QD`                                       |
| **use** — Swords piece                              | `use AS/m0.1 piece n0.1 1`                       | `use AS/with m0.1 shrink n0.1 1`                                       |
| **use** — Swords tile                               | `use AS/m0.1 tile l0 1 5D`                       | `use AS/with m0.1 shrink l0 1 to 5D`                                   |
| **use** — Empress (orientMinion→create)             | `use 03/m0.1 E/m0.1 own m0 U`                    | `use 03/orient m0.1 E/with m0.1 at m0 create U`                        |
| **use** — Hierophant (hierophantReplace)            | `use 05/m0.1 n0.1 N`                             | `use 05/with m0.1 replace n0.1 N`                                      |
| **use** — Devil (orientAny ×3)                      | `use 15/m0.1 n0.1 N`                             | `use 15/with m0.1 orient n0.1 N`                                       |
| **use** — Justice (tradeHands→attack)               | `use 11/m0.1 n0.1/m0.1 piece n0.1 1`             | `use 11/with m0.1 trade n0.1/with m0.1 shrink n0.1 1`                  |
| **use** — Lovers (move→create)                      | `use 06/m0.1 piece n0.1 1 U/o0.1 own o0 U`       | `use 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U`       |
| **use** — Hermit (hermitTeleport)                   | `use 09/m0.1 piece m0.1 o0`                      | `use 09/with m0.1 fly m0.1 to o0`                                      |
| **use** — Magician (magicianChoice, direct)         | `use 01 as R/m0.1 piece m0.1 1`                  | `use 01 as R/with m0.1 move m0.1 1`                                    |
| **use** — Magician (via World's borrow)             | `use 21 as 01/m0.1 C own m0 U`                   | `use 21 as 01 as C/with m0.1 at m0 create U`                           |
| **use** — Judgement (judgementDraw)                 | `use 20/m0.2 KS 00`                              | `use 20/with m0.2 draw KS 00`                                          |
| **use** — High Priestess round 1 (fresh activation) | `use 02/discard AC KS draw 2`                    | `use 02/discard AC KS draw 2` (unchanged)                              |
| **use** — World (worldUseAny)                       | `use 21 as 06/m0.1 piece n0.1 1 U/o0.1 own o0 U` | `use 21 as 06/with m0.1 move n0.1 1 orient U/with o0.1 at o0 create U` |
| **play** (from hand, otherwise identical to use)    | `play AC/m0.1 own m0 U`                          | `play AC/with m0.1 at m0 create U`                                     |
| **decline** (resume, declining a pause)             | `decline 05 (via 00)`                            | `decline 05 via 00`                                                    |
| **play … (via)** (Fool/World resume, continuing)    | `play 6D/l0.1 piece l0.1 (via 00)`               | `play 6D via 00/with l0.1 grow l0.1`                                   |
| **discard … (via)** (High Priestess round 2 resume) | `discard AR draw 1 (via 02)`                     | `discard AR draw 1 via 02`                                             |
| **(last)** bare (declare with nothing else typed)   | `(last)`                                         | `last`                                                                 |
| **(last)** appended to discard                      | `discard draw 0 (last)`                          | `discard draw 0 last`                                                  |
| **(last)** appended to use                          | `use AC (last)`                                  | `use AC last`                                                          |

## Notes

- **Category 1 vs 2** orientation: `orientMinion`/`orientAny` (and the
  standalone `orient` command) hard-reject a same-facing click as a no-op.
  Every trailing/seeded facing elsewhere (Cups own, R/D/S piece,
  hierophantReplace) never does — reorienting there is optional icing on an
  already-meaningful act.
- **`"?"` seeding** is used only for Cups own and hierophantReplace — both
  because the grammar makes the orientation token mandatory even though (for
  Hierophant) the default is derivable from state; it's a move-completeness
  marker, not a legality concern.
- **Magician's suit** always goes through the head's `as <suit>`, whether
  activated directly or reached via Fool's reveal — *except* when reached via
  World's own borrow, where the suit is embedded inline as the step's first
  token instead (World's own `as <uid>` already spent the head's one slot).
  See [TODO-gnostica](TODO-gnostica) #105 for replacing this with a chained
  `as <uid> as <suit>` form.

Comments on new format:

          only some of these  (with, discard, draw, orient, replace, trade) can be a subhead/start a step 

          last: no arguments
          via: 00 or 02
          as: cardUid or suitId  -- World and Magician
          with: own minion ref
          discard/draw: for High Priestess and Judgement (draw only)
          create: <target cell> + ( new cardUid or enemy.minion.ref or just direction )  -- includes Wheel of Fortune
          grow: (<target cell> to newcarduid ) or minion.ref  -- includes Star
          shrink: (<target cell> + <number> to newcarduid ) or (minion.ref + <number>)  -- includes Death, Tower
          move: (<carduid> + distance )  or ( minion.ref + distance) 
          orient: minion.ref direction  -- the Devil, empress, emperor, tower, star
          replace: Hierophant
          fly: Hermit (minion ref OR target card) to target cell
          trade: minionJustice and the Hanged Man

          Stuff that isn't keywords:  pieceRefs, cell, cardUid, suitId, playerId, Direction, pip count
          Special issues:  question mark for orients, previously floating terms like last and via  
