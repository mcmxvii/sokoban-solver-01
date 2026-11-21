// Push-optimal Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// The levels are a hallway with one to four rooms off it, each room holding
// three or four boxes and as many goals, and a box pushed out of a room can
// never come back — so the rooms are independent problems, joined only by the
// player's walk. This solver cuts the level into its rooms, solves each room
// with a breadth-first search over pushes (a state is the boxes' squares plus
// the player's reachable region, so the first solved state found is
// push-optimal), and stitches the rooms' move strings together with the
// hallway walks between them. A reward needs a score strictly above the house
// baseline, plain-astar 1.0.0, and a push-optimal room is the strongest
// answer a room can give: the level's optimum is the sum of its rooms'.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
// (the kit's grade-local runs it the same way, twice, and scores it).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room's push search keeps before it gives up (work, never the clock). */
const MAX_STATES = 250_000;

/** The four moves: the step's dx, dy and letter, and the push's letter. */
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box can be pushed onto some goal: pulled back
 * from the goals, a square y is live when a box on it can be pushed onto a
 * live square — the push needs the square behind it, where the player
 * stands, to be floor. A box on a square that is not live is dead: no push
 * can ever save it, so a state holding one is pruned.
 */
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goals } = lv;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of DIRS) {
      const step = d.dy * w + d.dx;
      const y = x - step;
      if (y < 0 || y >= wall.length) continue;
      const behind = y - step;
      if (behind < 0 || behind >= wall.length) continue;
      if (wall[y] || wall[behind] || live[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/** One room: its floor squares, its door onto the hallway and the hallway square outside it. */
interface Room {
  cells: number[];
  door: number;
  entry: number;
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: the connected parts of the floor off the player's row
 * (the hallway), each holding boxes. A room opens onto the hallway through
 * exactly one door, the one square of it beside a hallway square. Null when
 * the level is no set of rooms — a part holding more or fewer boxes than
 * goals, a box in the hallway, or a room with no door or two.
 */
function findRooms(lv: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const hallRow = Math.floor(player / w);
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || Math.floor(s / w) === hallRow || part[s] >= 0) continue;
    const cells: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      for (const d of DIRS) {
        const q = cells[i] + d.dy * w + d.dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && Math.floor(q / w) !== hallRow && part[q] < 0) {
          part[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ cells, door: -1, entry: -1, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (Math.floor(b / w) === hallRow) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  for (const room of rooms) {
    if (room.boxes.length !== room.goals.length) return null;
    const doors = room.cells.filter((s) => {
      const y = Math.floor(s / w);
      return (y === hallRow - 1 && !wall[s + w]) || (y === hallRow + 1 && !wall[s - w]);
    });
    if (doors.length !== 1) return null;
    room.door = doors[0];
    room.entry = Math.floor(room.door / w) === hallRow - 1 ? room.door + w : room.door - w;
  }
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from one square to another around walls and boxes, in lower LURD letters. */
function walkTo(lv: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = lv;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the target square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after playing `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface PushSolution {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of a level: a breadth-first search over pushes.
 * A state is the boxes' squares and the player's reachable region, named by
 * its lowest square (for fixed boxes, a region is fixed by its lowest square:
 * two regions sharing a square are one). The search expands states in order
 * of pushes made, so the first solved state it meets is push-optimal. It
 * prunes two deadlocks a box can never leave: a dead square, and a frozen
 * 2x2 block of walls and boxes with a box off its goal. Pure: no clock, no
 * randomness; ties go by square order, so it answers alike on every run.
 * `exit` is the hallway square the player must be able to reach once the
 * boxes are on their goals (so it can walk on to the next room); null when
 * the player need not leave (the last room). Null when the search gives up.
 */
function solvePushOptimal(lv: Level, exit: number | null, maxStates = MAX_STATES): PushSolution | null {
  const { w, wall, goals } = lv;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(lv);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  if (lv.boxes.some((b) => !live[b])) return null;

  // Flood the player's reachable region from `from` with `occupied` in the
  // way, stamping it `stampHere` on `marks`; returns its lowest square.
  const floodRegion = (marks: Int32Array, from: number, stampHere: number): number => {
    let low = from;
    let n = 0;
    stack[n++] = from;
    marks[from] = stampHere;
    while (n > 0) {
      const p = stack[--n];
      if (p < low) low = p;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (q < 0 || q >= size) continue;
        if (wall[q] === 0 && occupied[q] === 0 && marks[q] !== stampHere) {
          marks[q] = stampHere;
          stack[n++] = q;
        }
      }
    }
    return low;
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
  // and boxes with a box off its goal.
  const frozenBlock = (t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      if (a < 0 || a + w + 1 >= size) continue;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
    }
    return false;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const keyOf = (boxes: number[], low: number): string => `${low}|${boxes.join(',')}`;

  // The states in the order found: their boxes, the player's square after
  // the push that made them, and that push (the square the box left, and
  // its direction) from their parent.
  const statesBoxes: number[][] = [lv.boxes];
  const statesPlayer: number[] = [lv.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<string, number>();
  for (const b of lv.boxes) occupied[b] = 1;
  const startLow = floodRegion(seen, lv.player, ++stamp);
  index.set(keyOf(lv.boxes, startLow), 0);
  for (const b of lv.boxes) occupied[b] = 0;
  let found = solved(lv.boxes) && (exit === null || seen[exit] === stamp) ? 0 : -1;

  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    floodRegion(seen, statesPlayer[head], ++stamp);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < DIRS.length; di++) {
        const d = DIRS[di];
        const step = d.dy * w + d.dx;
        const t = b + step;
        if (t < 0 || t >= size) continue;
        if (seen[b - step] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(t);
        let key = '';
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, x) => a - x);
          low = floodRegion(mark, b, ++stamp);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next!);
        statesPlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushDir.push(di);
        if (solved(next!) && (exit === null || mark[exit] === stamp)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = lv.player;
  let boxes = lv.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    const from = pushFrom[s];
    const d = DIRS[pushDir[s]];
    const step = d.dy * w + d.dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(lv, occupied, player, from - step);
    for (const b of boxes) occupied[b] = 0;
    moves += d.push;
    player = from;
    boxes = nextBoxes;
  }
  // Walk out to the hallway square, when the player must leave.
  if (exit !== null) {
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(lv, occupied, player, exit);
    for (const b of boxes) occupied[b] = 0;
  }
  return { pushes: path.length, moves };
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's. An
 * empty string when a room's search gives up, or the level is no set of
 * rooms and the search over the whole level gives up: empty is valid, worth
 * no points, and never an illegal move.
 */
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const rooms = findRooms(lv);
  if (rooms === null) {
    const whole = solvePushOptimal(lv, null);
    return whole === null ? '' : whole.moves;
  }
  let player = lv.player;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const last = ri === rooms.length - 1;
    const wall = lv.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const s of other.done ? other.goals : other.boxes) wall[s] = 1;
    }
    const sub: Level = {
      w: lv.w,
      h: lv.h,
      wall,
      goals: [...room.goals].sort((a, b) => a - b),
      boxes: [...room.boxes].sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, last ? null : room.entry);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(lv.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
