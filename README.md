# Sokoban solver

Push-optimal Sokoban solver for the make.fun bounty
`sokoban-solver-01-run-20261121` — one program answers every instance of a
drawn set, in as few pushes as it can.

## How it works

Each level is a hallway with one to four rooms off it, and a box pushed out
of a room can never come back, so the rooms are independent problems, joined
only by the player's walk. The solver cuts the level into its rooms, solves
each room with a breadth-first search over pushes — a state is the boxes'
squares plus the player's reachable region, so the first solved state found
is push-optimal — and stitches the rooms' move strings together with the
hallway walks between them. The search prunes two deadlocks a box can never
leave: a dead square (one from which no push reaches a goal) and a frozen
2x2 block of walls and boxes with a box off its goal.

The level's optimum is the sum of its rooms' optima, so a push-optimal room
is the strongest answer a room can give.

## Running it

```sh
node main.ts
```

It reads `/input/<id>/level.txt` for every instance and writes
`/output/<id>/solution.txt`: the player's moves in LURD (`u`, `d`, `l`, `r`),
one letter a step. One run answers the whole set in well under the
60-second wall budget, and two runs write the same bytes.

## Practice results

On the kit's practice set the solver scores **1,000,000** — every instance
solved in exactly its push-optimal count (13, 16, 29, 47 and 60 pushes),
against the house baseline plain-astar 1.0.0's 200,000 (it solves only the
first instance and gives up on the rest). The whole set runs in about
1.3 seconds, and two runs are byte-identical.
