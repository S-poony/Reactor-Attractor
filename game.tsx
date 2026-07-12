import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Play, RotateCcw, HelpCircle, Trophy, Sparkles, AlertTriangle, ChevronRight, ChevronUp, Volume2, VolumeX } from 'lucide-react';

// --- GAME CONFIG & CONSTANTS ---
const GRID_SIZE = 8;
const COLORS = {
  R: { name: 'Red', hex: '#EF4444', text: 'text-red-500', bg: 'bg-red-500', border: 'border-red-600' },
  G: { name: 'Green', hex: '#22C55E', text: 'text-green-500', bg: 'bg-green-500', border: 'border-green-600' },
  B: { name: 'Blue', hex: '#3B82F6', text: 'text-blue-500', bg: 'bg-blue-500', border: 'border-blue-600' },
};

// Attraction rules: Key attracts Value (Value is pulled towards Key)
const ATTRACTION_RULES = {
  R: 'G', // Red attracts Green
  G: 'B', // Green attracts Blue
  B: 'R', // Blue attracts Red
};

// Check if a cell is on the 8x8 outer edge
const isOuterEdge = (r, c) => {
  return r === 0 || r === GRID_SIZE - 1 || c === 0 || c === GRID_SIZE - 1;
};

// How far a piece is allowed to drift past the visible board before it's
// culled. Any genuinely finite push chain resolves (binds, stabilizes, or
// gets pulled back by a stronger attractor) well within one board-width of
// the edge; anything still going after that is a runaway chain pushing its
// own target away forever and is removed instead of ending the game.
const BOUNDS_MARGIN = GRID_SIZE;
const MIN_COORD = -BOUNDS_MARGIN;
const MAX_COORD = GRID_SIZE - 1 + BOUNDS_MARGIN;

// --- OFF-GRID VISUAL COMPRESSION ---
// Pieces can drift up to BOUNDS_MARGIN (8) cells past the board edge before
// being culled. Rendering that 1:1 would need a stage 3x the board's size,
// which kills legibility on small screens. Instead, visual distance past
// the edge grows on a saturating curve — it approaches but never exceeds
// MAX_MARGIN_CELLS, no matter how far the true (culling) distance gets.
const MAX_MARGIN_CELLS = 1.4;
const OFFSET_SOFTNESS = 2.2;
const compressedOffset = (trueDist) => (MAX_MARGIN_CELLS * trueDist) / (trueDist + OFFSET_SOFTNESS);

// Total stage size in "cell units": the 8x8 board plus compression margin
// on both sides. The bordered board itself only occupies GRID_BOX_SIZE_PCT
// of the stage — the rest is room for off-grid pieces to render into.
const STAGE_CELLS = GRID_SIZE + 2 * MAX_MARGIN_CELLS;
const CELL_STAGE_PCT = 100 / STAGE_CELLS;
const GRID_BOX_OFFSET_PCT = MAX_MARGIN_CELLS * CELL_STAGE_PCT;
const GRID_BOX_SIZE_PCT = GRID_SIZE * CELL_STAGE_PCT;

// The bordered board box has its own internal padding + gap between cells
// (drawn below via these exact same constants, as % of the box's own
// size — not px — so they scale with the box and stay in sync with the
// piece-overlay math at every screen size instead of drifting apart at
// Tailwind's responsive breakpoints).
const BOARD_PAD_FRAC = 0.025;
const CELL_GAP_FRAC = 0.01;
const CELL_CONTENT_FRAC = 1 - 2 * BOARD_PAD_FRAC;
// Size of one on-grid cell, and the left-edge-to-left-edge step to the
// next one, both expressed as a fraction of the board box's own size.
const ON_GRID_CELL_FRAC = (CELL_CONTENT_FRAC - (GRID_SIZE - 1) * CELL_GAP_FRAC) / GRID_SIZE;
const ON_GRID_STEP_FRAC = ON_GRID_CELL_FRAC + CELL_GAP_FRAC;
// Same cell size, converted into "stage cell units" so it can be used
// directly as a width/height alongside coordToStageCellUnits below.
const ON_GRID_CELL_STAGE_UNITS = ON_GRID_CELL_FRAC * GRID_SIZE;

// CSS quirk: a percentage `padding` resolves against the CONTAINING BLOCK's
// width (the stage), not against the padded element's own size (the board
// box) — even though the board box's own width is itself only
// GRID_BOX_SIZE_PCT% of the stage. So to actually get BOARD_PAD_FRAC worth
// of padding relative to the board box, the inline style must use this
// stage-relative value instead of BOARD_PAD_FRAC directly.
const BOARD_PAD_STAGE_PCT = BOARD_PAD_FRAC * GRID_BOX_SIZE_PCT;
// CSS Grid `gap` percentages, unlike padding, resolve against the grid
// container's own content box — which here is already the padded-in area
// (CELL_CONTENT_FRAC of the board box) — so this converts CELL_GAP_FRAC
// (a fraction of the board box) into the matching fraction of that smaller
// content box.
const CELL_GAP_GRID_PCT = (CELL_GAP_FRAC / CELL_CONTENT_FRAC) * 100;
// How far each bridge needs to reach past its own cell's edge, as a % of
// its own (small) box, so two neighboring bridges meet in the middle of
// the real inter-cell gap instead of each stopping short of it.
const BRIDGE_OVERSHOOT_PCT = (CELL_GAP_FRAC / ON_GRID_CELL_FRAC / 2) * 100;

// Base z-index for pieces (PIECES LAYER, see render): each piece's actual
// z-index is PIECE_Z_BASE - dist, so pieces closer to the grid stack above
// ones that have drifted further out. Set comfortably above BOUNDS_MARGIN
// (the furthest a piece can drift before being culled) so this never goes
// negative and sinks below the links layer's z-index: 0.
const PIECE_Z_BASE = 1000;

// Maps a single coordinate (row or col — can be negative or >= GRID_SIZE)
// to its position within the stage, in cell units from the stage's edge.
// On-grid coords land on the true left/top edge of their rendered cell
// (padding + gap included) instead of an idealized zero-gap grid, so
// pieces sit centered on the cells you actually see.
const coordToStageCellUnits = (coord) => {
  if (coord >= 0 && coord <= GRID_SIZE - 1) {
    const leftFrac = BOARD_PAD_FRAC + coord * ON_GRID_STEP_FRAC;
    return MAX_MARGIN_CELLS + leftFrac * GRID_SIZE;
  }
  if (coord < 0) {
    return MAX_MARGIN_CELLS - compressedOffset(-coord);
  }
  const dist = coord - (GRID_SIZE - 1);
  return MAX_MARGIN_CELLS + (GRID_SIZE - 1) + compressedOffset(dist);
};

// True (uncompressed) distance past the board edge, in real grid cells —
// drives shrink/fade/warning intensity so it still reads as "8 is the
// cull line," even though the visual position itself is compressed.
const trueDistPastEdge = (r, c) => {
  const dr = r < 0 ? -r : r > GRID_SIZE - 1 ? r - (GRID_SIZE - 1) : 0;
  const dc = c < 0 ? -c : c > GRID_SIZE - 1 ? c - (GRID_SIZE - 1) : 0;
  return Math.max(dr, dc);
};

// dist=0 (on-grid) -> full size, opaque, no warning.
// dist=BOUNDS_MARGIN (about to be culled) -> smallest/faintest, pulsing.
const OFFGRID_WARNING_THRESHOLD = 6;
const getPieceVisualStyle = (dist) => {
  const scale = 1 - 0.5 * (dist / (dist + 2));
  const opacity = 1 - 0.3 * (dist / (dist + 3));
  const warning = dist >= OFFGRID_WARNING_THRESHOLD;
  return { scale, opacity, warning };
};

// Pure helper function to bind adjacent pieces that have attraction relationships
const bindAdjacentPieces = (currentPieces) => {
  let didBind = false;
  const tempPieces = currentPieces.map(p => ({ ...p }));

  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    for (let i = 0; i < tempPieces.length; i++) {
      for (let j = i + 1; j < tempPieces.length; j++) {
        const p1 = tempPieces[i];
        const p2 = tempPieces[j];

        if (p1.groupId !== p2.groupId) {
          // Check adjacency
          const isAdjacent = (Math.abs(p1.r - p2.r) === 1 && p1.c === p2.c) || 
                             (Math.abs(p1.c - p2.c) === 1 && p1.r === p2.r);

          if (isAdjacent) {
            // Check if there is an attraction relationship between them
            const p1AttractsP2 = ATTRACTION_RULES[p1.color] === p2.color;
            const p2AttractsP1 = ATTRACTION_RULES[p2.color] === p1.color;

            if (p1AttractsP2 || p2AttractsP1) {
              const targetGroupId = Math.min(p1.groupId, p2.groupId);
              const sourceGroupId = Math.max(p1.groupId, p2.groupId);

              tempPieces.forEach((p) => {
                if (p.groupId === sourceGroupId) {
                  p.groupId = targetGroupId;
                }
              });
              mergedAny = true;
              didBind = true;
            }
          }
        }
      }
    }
  }
  return { pieces: tempPieces, didBind };
};

// Pure helper: scans from a piece in one direction, skipping over inert
// pieces/empty cells, to find the nearest piece that actually attracts it.
// Shared by the resolution engine and the live "who's attracting whom"
// overlay, so both always agree on exactly the same rules.
const findAttractorInDirection = (p, dr, dc, piecesList) => {
  let currR = p.r + dr;
  let currC = p.c + dc;
  let dist = 0;
  while (currR >= MIN_COORD && currR <= MAX_COORD && currC >= MIN_COORD && currC <= MAX_COORD) {
    dist += 1;
    const hit = piecesList.find((item) => item.r === currR && item.c === currC);
    if (hit) {
      if (hit.groupId !== p.groupId && ATTRACTION_RULES[hit.color] === p.color) {
        return { target: hit, dist };
      }
      // Inert relative to p — doesn't block the view, keep scanning.
    }
    currR += dr;
    currC += dc;
  }
  return null;
};

const PULL_DIRS = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 }
];

// Pure helper: for every group on the board, finds its closest attractor(s)
// this tick. Returns:
//  - groupInfo: per-group breakdown (attractor piece ids, tie-locked or
//    not, pull direction) — used to drive the live highlight overlay even
//    while the board is idle or frozen in a tie-lock.
//  - validGroupPulls: flattened list of groups with a single unambiguous
//    closest pull — exactly what the resolution engine acts on.
const computeGroupPulls = (piecesList) => {
  const pulls = [];
  piecesList.forEach((p) => {
    PULL_DIRS.forEach(({ dr, dc }) => {
      const found = findAttractorInDirection(p, dr, dc, piecesList);
      if (found) {
        pulls.push({ attractedGroupId: p.groupId, pieceId: p.id, dr, dc, dist: found.dist, attractorId: found.target.id });
      }
    });
  });

  const byGroup = {};
  pulls.forEach((pull) => {
    if (!byGroup[pull.attractedGroupId]) byGroup[pull.attractedGroupId] = [];
    byGroup[pull.attractedGroupId].push(pull);
  });

  const groupInfo = {};
  const validGroupPulls = [];

  Object.keys(byGroup).forEach((gId) => {
    const groupList = byGroup[gId];
    groupList.sort((a, b) => a.dist - b.dist);
    const bestDist = groupList[0].dist;
    const ties = groupList.filter((p) => p.dist === bestDist);

    const uniqueDirs = [];
    ties.forEach((t) => {
      if (!uniqueDirs.some((d) => d.dr === t.dr && d.dc === t.dc)) {
        uniqueDirs.push({ dr: t.dr, dc: t.dc });
      }
    });

    const isTieLocked = uniqueDirs.length > 1;
    const attractorIds = Array.from(new Set(ties.map((t) => t.attractorId)));
    // The piece(s) within the group whose own scan produced one of the
    // pulls at this group's best distance — relevant for both the tie
    // badge (when tied) and the directional arrow (when not), so neither
    // ends up plastered across every piece in the group.
    const sensingPieceIds = Array.from(new Set(ties.map((t) => t.pieceId)));

    groupInfo[gId] = {
      groupId: Number(gId),
      dist: bestDist,
      isTieLocked,
      attractorIds,
      sensingPieceIds,
      dr: isTieLocked ? 0 : uniqueDirs[0].dr,
      dc: isTieLocked ? 0 : uniqueDirs[0].dc
    };

    if (!isTieLocked) {
      validGroupPulls.push({ attractedGroupId: Number(gId), dr: uniqueDirs[0].dr, dc: uniqueDirs[0].dc, dist: bestDist });
    }
  });

  return { groupInfo, validGroupPulls };
};

// Simple push rule: a moving group can shove one neighboring group out of
// the way, but it does not recursively chain through the whole board.
const getPushSet = (startGroupId, dr, dc, currentPieces) => {
  const affectedGroupIds = new Set([startGroupId]);
  const startPieces = currentPieces.filter((p) => p.groupId === startGroupId);

  startPieces.forEach((piece) => {
    const nextR = piece.r + dr;
    const nextC = piece.c + dc;
    const blockingPiece = currentPieces.find((other) => other.r === nextR && other.c === nextC);

    if (blockingPiece && blockingPiece.groupId !== startGroupId) {
      affectedGroupIds.add(blockingPiece.groupId);
    }
  });

  return Array.from(affectedGroupIds);
};

// Pure function: given the current board, works out exactly which group(s)
// would actually move THIS tick and in which direction. The resolver keeps
// only claims that do not conflict with another claim and ignores the
// heavier chain-reaction loop from the previous version.
const resolveWinningPulls = (piecesList) => {
  const { validGroupPulls } = computeGroupPulls(piecesList);
  if (validGroupPulls.length === 0) return [];

  const globalMinDist = Math.min(...validGroupPulls.map((p) => p.dist));
  const candidatePulls = validGroupPulls.filter((p) => p.dist === globalMinDist);

  const claims = candidatePulls.map((pull) => ({
    pull,
    affectedGroupIds: getPushSet(pull.attractedGroupId, pull.dr, pull.dc, piecesList)
  }));

  const groupDirClaims = {};
  claims.forEach(({ pull, affectedGroupIds }) => {
    const dirKey = `${pull.dr},${pull.dc}`;
    affectedGroupIds.forEach((gId) => {
      if (!groupDirClaims[gId]) groupDirClaims[gId] = new Set();
      groupDirClaims[gId].add(dirKey);
    });
  });

  const conflictedGroupIds = new Set(
    Object.keys(groupDirClaims)
      .filter((gId) => groupDirClaims[gId].size > 1)
      .map(Number)
  );

  let survivors = claims.filter(
    ({ affectedGroupIds }) => !affectedGroupIds.some((gId) => conflictedGroupIds.has(gId))
  );

  if (survivors.length > 0) {
    const tentative = [];
    piecesList.forEach((p) => {
      const claim = survivors.find((s) => s.affectedGroupIds.includes(p.groupId));
      tentative.push(claim
        ? { groupId: p.groupId, r: p.r + claim.pull.dr, c: p.c + claim.pull.dc }
        : { groupId: p.groupId, r: p.r, c: p.c });
    });

    const occupied = {};
    const collidingGroupIds = new Set();
    tentative.forEach((p) => {
      const key = `${p.r},${p.c}`;
      if (occupied[key] !== undefined && occupied[key] !== p.groupId) {
        collidingGroupIds.add(p.groupId);
        collidingGroupIds.add(occupied[key]);
      }
      occupied[key] = p.groupId;
    });

    if (collidingGroupIds.size > 0) {
      survivors = survivors.filter(
        ({ affectedGroupIds }) => !affectedGroupIds.some((gId) => collidingGroupIds.has(gId))
      );
    }
  }

  return survivors;
};

export default function App() {
  // --- STATE ---
  const [pieces, setPieces] = useState([]); // List of { id, color, r, c, groupId }
  const [nextColor, setNextColor] = useState('R');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(() => {
    return Number(localStorage.getItem('attractors_high_score')) || 0;
  });
  const [isResolving, setIsResolving] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [gameOverReason, setGameOverReason] = useState('');
  const [showTutorial, setShowTutorial] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [lastPlacedCell, setLastPlacedCell] = useState(null);
  // Brief "+N" pop shown in the HUD whenever score increases
  const [scoreFlash, setScoreFlash] = useState(null); // { amount, key }
  const prevScoreRef = useRef(0);

  // For generating unique IDs
  const pieceIdCounter = useRef(0);

  // Single reused AudioContext (browsers cap the number of concurrent
  // contexts, so creating a new one per sound effect breaks audio after
  // enough placements)
  const audioCtxRef = useRef(null);

  // Initialize first color
  useEffect(() => {
    rollNextColor();
  }, []);

  // Close the shared AudioContext when the component unmounts
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  // Sync high score
  useEffect(() => {
    if (score > highScore) {
      setHighScore(score);
      localStorage.setItem('attractors_high_score', score.toString());
    }
  }, [score, highScore]);

  // Pop a brief "+N" indicator in the HUD whenever score increases
  useEffect(() => {
    const delta = score - prevScoreRef.current;
    if (delta > 0) {
      setScoreFlash({ amount: delta, key: Date.now() });
      const timeout = setTimeout(() => setScoreFlash(null), 900);
      prevScoreRef.current = score;
      return () => clearTimeout(timeout);
    }
    prevScoreRef.current = score;
  }, [score]);

  // Audio Synth triggers for feedback
  const playSound = (type) => {
    if (!soundEnabled) return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'place') {
        osc.frequency.setValueAtTime(330, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else if (type === 'slide') {
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'bind') {
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.08); // E5
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'lose') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.6);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.65);
        osc.start();
        osc.stop(ctx.currentTime + 0.65);
      } else if (type === 'vanish') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(500, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.35);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      }
    } catch (e) {
      console.warn("Audio Context blocked or unsupported");
    }
  };

  const rollNextColor = () => {
    const colors = ['R', 'G', 'B'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    setNextColor(randomColor);
  };

  const restartGame = () => {
    setPieces([]);
    setScore(0);
    setGameOver(false);
    setGameOverReason('');
    setIsResolving(false);
    setLastPlacedCell(null);
    rollNextColor();
  };

  // Helper to find piece at specific coordinates
  const getPieceAt = useCallback((r, c, list = pieces) => {
    return list.find((p) => p.r === r && p.c === c);
  }, [pieces]);

  // Main attraction calculation and single step execution
  const runResolutionStep = useCallback(async (currentPieces) => {
    let hasMovement = false;
    let nextPieces = [...currentPieces];

    // Identify each group's closest attractor(s) this tick, looking past
    // inert clutter, with the same board-wide tie-lock rule as the live
    // overlay: a group with more than one unique direction pulling at the
    // minimum distance freezes instead of moving. resolveWinningPulls is
    // the same function the live overlay uses, so what actually moves and
    // what the arrows predicted are guaranteed to match.
    const survivingClaims = resolveWinningPulls(nextPieces);

    if (survivingClaims.length > 0) {
          const moveByGroupId = {};
          survivingClaims.forEach(({ pull, affectedGroupIds }) => {
            affectedGroupIds.forEach((gId) => {
              moveByGroupId[gId] = { dr: pull.dr, dc: pull.dc };
            });
          });

          const movedCount = nextPieces.filter((p) => moveByGroupId[p.groupId]).length;

          nextPieces = nextPieces.map((p) => {
            const move = moveByGroupId[p.groupId];
            if (move) {
              return { ...p, r: p.r + move.dr, c: p.c + move.dc };
            }
            return p;
          });

          // Score: 1 point per piece that moved this tick, so a bound group of
          // 5 sliding (or several unrelated groups sliding at once) scores
          // more than a single piece nudging over.
          setScore((prev) => prev + movedCount);

          playSound('slide');
          hasMovement = true;

          // Cull any group that has drifted more than BOUNDS_MARGIN cells
          // past the visible board. A legitimate, finite push has plenty of
          // room to bind or stabilize within that buffer; anything still
          // going after that is a runaway chain (e.g. pushing its own
          // target away every tick) and gets removed instead of ending the
          // game outright.
          const escapedGroupIds = new Set(
            nextPieces
              .filter((p) => p.r < MIN_COORD || p.r > MAX_COORD || p.c < MIN_COORD || p.c > MAX_COORD)
              .map((p) => p.groupId)
          );
          if (escapedGroupIds.size > 0) {
            nextPieces = nextPieces.filter((p) => !escapedGroupIds.has(p.groupId));
            playSound('vanish');
          }

          // --- BINDING PHASE (POST-MOVEMENT) ---
          const bindResult = bindAdjacentPieces(nextPieces);
          if (bindResult.didBind) {
            playSound('bind');
            nextPieces = bindResult.pieces;
          }
        }
        // If survivingClaims is empty, every pull at the minimum distance was
        // entangled in a conflict with another — a board-wide tie-lock.
        // Nothing moves this tick; hasMovement stays false and control
        // returns to the player.

    // Update board state
    setPieces(nextPieces);

    if (hasMovement) {
      // Queue next tick of resolution animation
      setTimeout(() => {
        runResolutionStep(nextPieces);
      }, 250);
    } else {
      // Done resolving, return control to player
      setIsResolving(false);
      // Check if board outer edge has absolutely no empty spaces
      let freeOuterCellExists = false;
      for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
          if (isOuterEdge(r, c) && !nextPieces.some((p) => p.r === r && p.c === c)) {
            freeOuterCellExists = true;
            break;
          }
        }
      }

      if (!freeOuterCellExists) {
        setGameOver(true);
        setGameOverReason('No space left on the outer edge to place pieces!');
        playSound('lose');
      }
    }
  }, [soundEnabled]);

  // Click handler to place active piece on the board
  const handleCellClick = (r, c) => {
    if (isResolving || gameOver) return;
    if (!isOuterEdge(r, c)) return;

    // Check if cell is occupied
    if (getPieceAt(r, c)) return;

    playSound('place');
    const newPieceId = pieceIdCounter.current++;
    const newPiece = {
      id: newPieceId,
      color: nextColor,
      r,
      c,
      groupId: newPieceId
    };

    const updatedPieces = [...pieces, newPiece];
    
    // --- BINDING PHASE (IMMEDIATE PRE-ATTRACTION PRE-RESOLUTION) ---
    const bindResult = bindAdjacentPieces(updatedPieces);
    const resolvedInitialPieces = bindResult.pieces;
    
    if (bindResult.didBind) {
      // Trigger binding sound effect instantly if they immediately link up
      setTimeout(() => {
        playSound('bind');
      }, 80);
    }

    setPieces(resolvedInitialPieces);
    setLastPlacedCell({ r, c });

    // Lock board and trigger resolution cascade
    setIsResolving(true);
    rollNextColor();

    setTimeout(() => {
      runResolutionStep(resolvedInitialPieces);
    }, 300);
  };

  // Determine connections between pieces of the same group for visuals
  const hasNeighborInGroup = (piece, dir) => {
    let checkR = piece.r;
    let checkC = piece.c;
    if (dir === 'up') checkR--;
    if (dir === 'down') checkR++;
    if (dir === 'left') checkC--;
    if (dir === 'right') checkC++;

    const neighbor = pieces.find((p) => p.r === checkR && p.c === checkC);
    return neighbor && neighbor.groupId === piece.groupId;
  };

  // Live "who's attracting whom" state, recomputed from the current board
  // any time it changes — including while idle and while frozen in a
  // tie-lock, which is exactly when this is most useful to see.
  const attractionState = useMemo(() => computeGroupPulls(pieces).groupInfo, [pieces]);
  const attractingPieceIds = useMemo(() => {
    const ids = new Set();
    Object.values(attractionState).forEach((info) => {
      info.attractorIds.forEach((id) => ids.add(id));
    });
    return ids;
  }, [attractionState]);

  // Which group(s) would actually move THIS tick, and in which direction —
  // the same global-min-distance + conflict resolution runResolutionStep
  // uses to commit moves. A group can have a perfectly valid closest pull
  // (present in attractionState) without being the one that wins the
  // board-wide race, so the arrow overlay checks this instead of just
  // "does this group have any pull at all."
  const winningPullByGroupId = useMemo(() => {
    const map = {};
    resolveWinningPulls(pieces).forEach(({ pull }) => {
      // Only the originally-attracted group gets an arrow — groups merely
      // dragged along via a push chain didn't sense anything themselves.
      map[pull.attractedGroupId] = { dr: pull.dr, dc: pull.dc };
    });
    return map;
  }, [pieces]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none antialiased selection:bg-slate-800">
      
      {/* HEADER */}
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 bg-slate-800 border border-slate-700 rounded-lg flex items-center justify-center text-blue-500 font-extrabold text-xl tracking-tight">
            Ø
          </div>
          <div>
            <h1 className="font-mono text-lg font-bold tracking-tight">ORBITALS & ATTRACTORS</h1>
            <p className="text-xs text-slate-400 font-mono">Turn-based slide & bind physical puzzle</p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors border border-slate-700"
            title={soundEnabled ? 'Mute' : 'Unmute'}
          >
            {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          <button
            onClick={() => setShowTutorial(!showTutorial)}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors border border-slate-700 flex items-center space-x-1.5 text-sm font-mono"
          >
            <HelpCircle size={16} />
            <span className="hidden md:inline">Rules</span>
          </button>
          <button
            onClick={restartGame}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors border border-slate-700 flex items-center space-x-1.5 text-sm font-mono"
          >
            <RotateCcw size={16} />
            <span className="hidden md:inline">Reset</span>
          </button>
        </div>
      </header>

      {/* TUTORIAL OVERLAY / PANEL */}
      {showTutorial && (
        <div className="bg-slate-900 border-b border-slate-800 p-6 transition-all">
          <div className="max-w-4xl mx-auto">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-md font-mono font-bold tracking-wide uppercase text-slate-300 flex items-center space-x-2">
                <Sparkles size={16} className="text-amber-400" />
                <span>How to Play & Game Mechanics</span>
              </h2>
              <button
                onClick={() => setShowTutorial(false)}
                className="text-xs text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 rounded font-mono transition-colors"
              >
                Hide Rules
              </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm text-slate-300">
              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                <span className="text-amber-400 font-mono font-bold text-xs block mb-1">RULE 1</span>
                <p className="font-mono text-xs leading-relaxed">
                  You can only place the randomly drawn pieces on the <strong className="text-slate-100">8x8 outer edge</strong> cells (highlighted on grid). Pieces slide into the inner 6x6 area through magnetic forces.
                </p>
              </div>

              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                <span className="text-amber-400 font-mono font-bold text-xs block mb-1">RULE 2</span>
                <p className="font-mono text-xs leading-relaxed mb-2">
                  Magnetism cycle dictates physical attraction in same row or column:
                </p>
                <div className="flex flex-col space-y-1 font-mono text-xs">
                  <div className="flex items-center space-x-2">
                    <span className="w-3 h-3 rounded-full bg-red-500 inline-block"></span>
                    <span className="text-red-400 font-semibold">Red</span>
                    <ChevronRight size={10} className="text-slate-500" />
                    <span className="text-green-400 font-semibold">Green</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="w-3 h-3 rounded-full bg-green-500 inline-block"></span>
                    <span className="text-green-400 font-semibold">Green</span>
                    <ChevronRight size={10} className="text-slate-500" />
                    <span className="text-blue-400 font-semibold">Blue</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="w-3 h-3 rounded-full bg-blue-500 inline-block"></span>
                    <span className="text-blue-400 font-semibold">Blue</span>
                    <ChevronRight size={10} className="text-slate-500" />
                    <span className="text-red-400 font-semibold">Red</span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                <span className="text-amber-400 font-mono font-bold text-xs block mb-1">RULE 3</span>
                <p className="font-mono text-xs leading-relaxed">
                  Attracted pieces <strong className="text-slate-100">slide and push</strong> obstacles in their way, even past pieces that don't attract them. Touching an attractor <strong className="text-slate-100">binds them together</strong>. The game ends when there's <strong className="text-slate-100">no space left on the outer edge</strong> to place a new piece.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MAIN GAME LAYOUT */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 flex flex-col lg:flex-row gap-8 items-center justify-center">
        
        {/* STATS & CONTROLS SIDEBAR */}
        <div className="w-full lg:w-80 flex flex-col space-y-4">
          
          {/* STATS CARD */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col space-y-4">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 font-mono text-xs uppercase tracking-wider">Session Score</span>
              <div className="flex items-center space-x-1.5 text-amber-400">
                <Trophy size={14} />
                <span className="text-xs font-mono font-bold">BEST: {highScore}</span>
              </div>
            </div>
            
            <div className="flex justify-between items-baseline">
              <span className="text-3xl font-mono font-black text-slate-100">{score}</span>
              <span className="text-xs text-slate-500 font-mono">tiles moved</span>
            </div>
          </div>

          {/* NEXT DRAW CARD */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col space-y-3">
            <span className="text-slate-400 font-mono text-xs uppercase tracking-wider block">Upcoming Piece</span>
            
            <div className="flex items-center space-x-4 bg-slate-950 p-3 rounded-lg border border-slate-800">
              <div className={`w-12 h-12 rounded-full ${COLORS[nextColor]?.bg} border-2 ${COLORS[nextColor]?.border} flex items-center justify-center text-slate-950 font-mono font-black text-xl shadow-lg animate-pulse`}>
                {nextColor}
              </div>
              <div className="font-mono">
                <p className="text-xs text-slate-400">Placing Active:</p>
                <p className="text-sm font-bold" style={{ color: COLORS[nextColor]?.hex }}>
                  {COLORS[nextColor]?.name} Particle
                </p>
              </div>
            </div>

            {/* Quick attraction legend */}
            <div className="mt-2 text-[11px] font-mono text-slate-400 bg-slate-950 p-2.5 rounded border border-slate-800/50 space-y-1">
              <p className="text-xs text-slate-300 border-b border-slate-800/60 pb-1 mb-1 font-bold">Magnetism Cycle:</p>
              <p>🔴 Red pulls 🟢 Green</p>
              <p>🟢 Green pulls 🔵 Blue</p>
              <p>🔵 Blue pulls 🔴 Red</p>
            </div>
          </div>

          {/* SYSTEM STATUS */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 font-mono text-xs space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">State Engine:</span>
              <span className={`font-bold uppercase tracking-wide px-2 py-0.5 rounded text-[10px] ${isResolving ? 'bg-amber-500/20 text-amber-400' : 'bg-green-500/20 text-green-400'}`}>
                {isResolving ? 'Resolving Pulls...' : 'Awaiting Input'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Total Bound Groups:</span>
              <span className="text-slate-200">
                {new Set(pieces.map((p) => p.groupId)).size}
              </span>
            </div>
          </div>
        </div>

        {/* INTERACTIVE PLAYING BOARD */}
        <div className="relative flex-1 flex flex-col items-center w-full">

          {/* COMPACT HUD BAR — score, best, and next piece live right above
              the board at every screen size, so neither requires scrolling
              back up to the sidebar after a placement. */}
          <div className="w-full max-w-lg flex items-center justify-between gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 mb-3">
            <div className="relative flex items-baseline gap-2">
              <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Score</span>
              <span className="text-xl font-mono font-black text-slate-100 tabular-nums">{score}</span>
              {scoreFlash && (
                <span
                  key={scoreFlash.key}
                  className="absolute -top-2 left-12 text-xs font-mono font-bold text-emerald-400 animate-bounce pointer-events-none"
                >
                  +{scoreFlash.amount}
                </span>
              )}
              <span className="flex items-center gap-1 text-slate-600 ml-1">
                <Trophy size={11} className="text-amber-400/80" />
                <span className="text-[11px] font-mono">{highScore}</span>
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider hidden sm:inline">Next</span>
              <div className={`w-8 h-8 rounded-full ${COLORS[nextColor]?.bg} border-2 ${COLORS[nextColor]?.border} flex items-center justify-center text-slate-950 font-mono font-black text-xs shadow-md`}>
                {nextColor}
              </div>
            </div>
          </div>

          {/* STAGE — deliberately larger than the visible board. Off-grid
              pieces (up to BOUNDS_MARGIN cells out) render into the margin
              at compressed scale instead of being invisibly clipped. */}
          <div className="relative w-full max-w-lg aspect-square">

            {/* Bordered board box — inset within the stage, still clips its
                own background/cells so the grid itself reads cleanly. */}
            <div
              className="absolute bg-slate-950 border border-slate-800 rounded-xl overflow-hidden shadow-2xl"
              style={{
                left: `${GRID_BOX_OFFSET_PCT}%`,
                top: `${GRID_BOX_OFFSET_PCT}%`,
                width: `${GRID_BOX_SIZE_PCT}%`,
                height: `${GRID_BOX_SIZE_PCT}%`,
                padding: `${BOARD_PAD_STAGE_PCT}%`,
              }}
            >
              {/* 8x8 GRID LAYOUT */}
              <div
                className="w-full h-full grid grid-cols-8 grid-rows-8 relative"
                style={{ gap: `${CELL_GAP_GRID_PCT}%` }}
              >
                {Array.from({ length: GRID_SIZE }).map((_, r) =>
                  Array.from({ length: GRID_SIZE }).map((_, c) => {
                    const isEdge = isOuterEdge(r, c);
                    const piece = getPieceAt(r, c);
                    const isLastPlaced = lastPlacedCell && lastPlacedCell.r === r && lastPlacedCell.c === c;

                    return (
                      <div
                        key={`${r}-${c}`}
                        onClick={() => handleCellClick(r, c)}
                        className={`
                          relative rounded-lg flex items-center justify-center transition-colors select-none cursor-default
                          ${isEdge 
                            ? 'bg-slate-900/60 hover:bg-slate-800/80 border border-dashed border-slate-700/60 cursor-pointer' 
                            : 'bg-slate-950 border border-slate-900/40'
                          }
                        `}
                      >
                        {/* Grid Position Coordinates (Very subtle) */}
                        <span className="absolute bottom-0.5 right-1 text-[8px] font-mono text-slate-700/60 pointer-events-none">
                          {r},{c}
                        </span>

                        {/* Persistent preview of the next piece on every valid edge
                            cell. Previously this only appeared on :hover, which
                            meant touch/mobile players never saw it at all. */}
                        {isEdge && !piece && !isResolving && !gameOver && (
                          <div
                            className={`absolute inset-1 rounded-full ${COLORS[nextColor]?.bg} border ${COLORS[nextColor]?.border} opacity-25 hover:opacity-50 active:opacity-60 transition-opacity flex items-center justify-center font-mono font-bold text-[10px] text-slate-950`}
                          >
                            {nextColor}
                          </div>
                        )}

                        {/* Cell highlight border for the last placed element */}
                        {isLastPlaced && (
                          <div className="absolute inset-0 border border-amber-400/50 rounded-lg animate-pulse pointer-events-none" />
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* LOSS / GAME OVER MODAL SCREEN */}
              {gameOver && (
                <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-sm flex flex-col items-center justify-center p-6 z-30 text-center">
                  <div className="w-16 h-16 bg-red-500/20 text-red-500 rounded-full flex items-center justify-center mb-4 border border-red-500/30">
                    <AlertTriangle size={32} />
                  </div>
                  
                  <h3 className="text-2xl font-mono font-black text-slate-100 tracking-tight mb-2">
                    MISSION TERMINATED
                  </h3>
                  
                  <p className="text-sm font-mono text-slate-400 max-w-xs mb-6">
                    {gameOverReason}
                  </p>

                  <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 mb-6 w-full max-w-xs">
                    <p className="text-xs text-slate-500 font-mono uppercase">Your Final Score</p>
                    <p className="text-3xl font-mono font-black text-amber-400 mt-1">{score}</p>
                    {score >= highScore && score > 0 && (
                      <span className="text-[10px] bg-amber-400/20 text-amber-400 px-2 py-0.5 rounded font-mono font-bold mt-2 inline-block animate-bounce">
                        NEW RECORD SET!
                      </span>
                    )}
                  </div>

                  <button
                    onClick={restartGame}
                    className="w-full max-w-xs py-3 bg-blue-600 hover:bg-blue-500 text-white font-mono font-bold rounded-lg transition-colors flex items-center justify-center space-x-2 shadow-lg hover:shadow-blue-600/20"
                  >
                    <RotateCcw size={16} />
                    <span>Deploy New Core</span>
                  </button>
                </div>
              )}
            </div>

            {/* UNCLIPPED PIECE LAYER — spans the full stage (not just the
                bordered box) so off-grid pieces render at their real,
                compressed position instead of vanishing at the border. */}
            <div className="absolute inset-0 pointer-events-none z-10">
              {(() => {
                // Precompute everything once per piece so the links pass
                // and the pieces pass below can't drift out of sync with
                // each other.
                const renderInfo = pieces.map((p) => {
                  const colorConfig = COLORS[p.color];

                  const hasUp = hasNeighborInGroup(p, 'up');
                  const hasDown = hasNeighborInGroup(p, 'down');
                  const hasLeft = hasNeighborInGroup(p, 'left');
                  const hasRight = hasNeighborInGroup(p, 'right');

                  const dist = trueDistPastEdge(p.r, p.c);
                  const { scale, opacity, warning } = getPieceVisualStyle(dist);
                  const leftPercent = coordToStageCellUnits(p.c) * CELL_STAGE_PCT;
                  const topPercent = coordToStageCellUnits(p.r) * CELL_STAGE_PCT;
                  const isOnGrid = p.r >= 0 && p.r <= GRID_SIZE - 1 && p.c >= 0 && p.c <= GRID_SIZE - 1;
                  const boxStageUnits = isOnGrid ? ON_GRID_CELL_STAGE_UNITS : 1;
                  const boxPercent = boxStageUnits * CELL_STAGE_PCT;

                  const isAttractor = attractingPieceIds.has(p.id);
                  const groupPull = attractionState[p.groupId];
                  const isGroupTieLocked = groupPull?.isTieLocked;
                  const isSensingPiece = groupPull?.sensingPieceIds?.includes(p.id);
                  const isTieLocked = isGroupTieLocked && isSensingPiece;
                  const winningPull = winningPullByGroupId[p.groupId];
                  const hasDirectionalPull = !isGroupTieLocked && !!winningPull && isSensingPiece;

                  const arrowStyle = hasDirectionalPull
                    ? winningPull.dr === -1
                      ? { top: '-7px', left: '50%', transform: 'translateX(-50%) rotate(0deg)' }
                      : winningPull.dr === 1
                      ? { bottom: '-7px', left: '50%', transform: 'translateX(-50%) rotate(180deg)' }
                      : winningPull.dc === -1
                      ? { left: '-7px', top: '50%', transform: 'translateY(-50%) rotate(-90deg)' }
                      : { right: '-7px', top: '50%', transform: 'translateY(-50%) rotate(90deg)' }
                    : null;

                  return {
                    p, colorConfig, hasUp, hasDown, hasLeft, hasRight, dist, scale, opacity, warning,
                    leftPercent, topPercent, boxPercent, isAttractor, isTieLocked, hasDirectionalPull, arrowStyle
                  };
                });

                return (
                  <>
                    {/* LINKS LAYER — always painted beneath every piece, no
                        matter how far anything has drifted off-grid. Group
                        connectors are background scaffolding; they
                        shouldn't compete with pieces for visibility. */}
                    <div className="absolute inset-0" style={{ zIndex: 0 }}>
                      {renderInfo.map(({ p, hasUp, hasDown, hasLeft, hasRight, leftPercent, topPercent, boxPercent, scale, opacity }) => (
                        <div
                          key={`link-${p.id}`}
                          className="absolute transition-all duration-300 ease-out"
                          style={{ left: `${leftPercent}%`, top: `${topPercent}%`, width: `${boxPercent}%`, height: `${boxPercent}%`, opacity }}
                        >
                          <div className="relative w-full h-full flex items-center justify-center" style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}>
                            {hasUp && (
                              <div className="absolute w-4 bg-slate-700 opacity-60" style={{ top: `-${BRIDGE_OVERSHOOT_PCT}%`, height: `calc(50% + ${BRIDGE_OVERSHOOT_PCT}%)` }} />
                            )}
                            {hasDown && (
                              <div className="absolute w-4 bg-slate-700 opacity-60" style={{ bottom: `-${BRIDGE_OVERSHOOT_PCT}%`, height: `calc(50% + ${BRIDGE_OVERSHOOT_PCT}%)` }} />
                            )}
                            {hasLeft && (
                              <div className="absolute h-4 bg-slate-700 opacity-60" style={{ left: `-${BRIDGE_OVERSHOOT_PCT}%`, width: `calc(50% + ${BRIDGE_OVERSHOOT_PCT}%)` }} />
                            )}
                            {hasRight && (
                              <div className="absolute h-4 bg-slate-700 opacity-60" style={{ right: `-${BRIDGE_OVERSHOOT_PCT}%`, width: `calc(50% + ${BRIDGE_OVERSHOOT_PCT}%)` }} />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* PIECES LAYER — every piece has its own explicit
                        z-index, PIECE_Z_BASE minus how far past the edge it
                        is, so pieces closer to the grid always render above
                        ones that have drifted further out (instead of
                        whichever happened to be later in the pieces array),
                        while still staying safely above the links layer's
                        z-index: 0 even at the furthest drift distance. */}
                    <div className="absolute inset-0">
                      {renderInfo.map(({ p, colorConfig, dist, scale, opacity, warning, leftPercent, topPercent, boxPercent, isAttractor, isTieLocked, hasDirectionalPull, arrowStyle }) => (
                        <div
                          key={p.id}
                          className="absolute transition-all duration-300 ease-out flex items-center justify-center"
                          style={{
                            left: `${leftPercent}%`,
                            top: `${topPercent}%`,
                            width: `${boxPercent}%`,
                            height: `${boxPercent}%`,
                            opacity,
                            zIndex: PIECE_Z_BASE - dist,
                          }}
                        >
                          <div className="relative w-full h-full flex items-center justify-center" style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}>
                            <div className="relative w-full h-full flex items-center justify-center" style={{ padding: '4px' }}>
                              {/* Attractor halo — pulses in the piece's own
                                  color whenever it's currently the chosen
                                  attractor for some group, even off-grid or
                                  mid tie-lock. */}
                              {isAttractor && (
                                <div
                                  className="absolute inset-0 rounded-full animate-ping opacity-40"
                                  style={{ backgroundColor: colorConfig.hex, animationDuration: '1.8s' }}
                                />
                              )}

                              {/* Off-grid warning ring — pulses as a piece
                                  nears the cull threshold, so drift reads as
                                  "danger" and not just "small." */}
                              {warning && (
                                <div className="absolute -inset-1 rounded-full border-2 border-red-500/70 animate-pulse" />
                              )}

                              {/* Outer Edge Circle */}
                              <div
                                className={`
                                  w-full h-full rounded-full ${colorConfig.bg} border-2 ${colorConfig.border}
                                  flex flex-col items-center justify-center text-slate-950 font-mono font-extrabold text-sm md:text-base
                                  shadow-md shadow-black/40 select-none relative
                                `}
                              >
                                {p.color}

                                {/* Sub-label showing internal group membership ID to aid puzzle transparency */}
                                <span className="text-[7px] text-slate-950/60 block -mt-1 font-mono font-normal">
                                  g{p.groupId}
                                </span>
                              </div>

                              {/* Pull direction indicator — sits on the edge
                                  of the circle facing where the group would
                                  slide this tick. */}
                              {hasDirectionalPull && (
                                <div
                                  className="absolute w-4 h-4 rounded-full bg-slate-900 border border-slate-600 flex items-center justify-center"
                                  style={arrowStyle}
                                >
                                  <ChevronUp size={10} className="text-slate-200" />
                                </div>
                              )}

                              {/* Tie-lock badge — this is the confusing
                                  case: two+ competing attractors at equal
                                  distance, so the group is frozen. Shown
                                  even while idle. */}
                              {isTieLocked && (
                                <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-amber-500 border border-amber-300 flex items-center justify-center animate-pulse">
                                  <AlertTriangle size={9} className="text-slate-950" />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Quick instructions subtext below the playing grid */}
          <div className="mt-4 text-center">
            <p className="text-xs font-mono text-slate-500">
              Only place particles inside the dashed border cells. Sliding cascades resolve automatically.
            </p>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="border-t border-slate-800/80 bg-slate-900/40 py-4 px-6 text-center font-mono text-[10px] text-slate-500 mt-auto">
        Orbital System Control Board — Designed with strict polarity vectors.
      </footer>
    </div>
  );
}