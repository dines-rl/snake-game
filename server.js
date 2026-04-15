const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const COLS = 20;
const ROWS = 20;
const TICK_MS = 110;
const MAX_PLAYERS = 2;
const COUNTDOWN_SECS = 3;

// --- HTTP server to serve index.html ---

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// --- WebSocket server ---

const wss = new WebSocketServer({ server });

// Game state
let players = [];       // { ws, id, name, snake, direction, nextDirection, score, alive }
let food = null;
let gameState = 'lobby'; // 'lobby' | 'countdown' | 'running' | 'gameover'
let tickTimer = null;
let countdownTimer = null;
let nextPlayerId = 0;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const p of players) {
    if (p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function placeFood() {
  const allSegments = players.flatMap(p => p.snake);
  let pos;
  let attempts = 0;
  do {
    pos = {
      x: Math.floor(Math.random() * COLS),
      y: Math.floor(Math.random() * ROWS),
    };
    attempts++;
  } while (allSegments.some(s => s.x === pos.x && s.y === pos.y) && attempts < 1000);
  food = pos;
}

function initPlayer(id, name) {
  const spawnConfigs = [
    { x: Math.floor(COLS / 4), y: Math.floor(ROWS / 2), dx: 1, dy: 0 },
    { x: Math.floor(3 * COLS / 4), y: Math.floor(ROWS / 2), dx: -1, dy: 0 },
  ];
  const cfg = spawnConfigs[id % spawnConfigs.length];
  return {
    id,
    name,
    snake: [
      { x: cfg.x, y: cfg.y },
      { x: cfg.x - cfg.dx, y: cfg.y - cfg.dy },
      { x: cfg.x - 2 * cfg.dx, y: cfg.y - 2 * cfg.dy },
    ],
    direction: { x: cfg.dx, y: cfg.dy },
    nextDirection: { x: cfg.dx, y: cfg.dy },
    score: 0,
    alive: true,
  };
}

function resetGame() {
  for (let i = 0; i < players.length; i++) {
    const fresh = initPlayer(i, players[i].name);
    players[i].snake = fresh.snake;
    players[i].direction = fresh.direction;
    players[i].nextDirection = fresh.nextDirection;
    players[i].score = fresh.score;
    players[i].alive = fresh.alive;
    players[i].id = i;
  }
  placeFood();
}

function getStatePayload() {
  return {
    type: 'state',
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      snake: p.snake,
      score: p.score,
      alive: p.alive,
    })),
    food,
    gameState,
  };
}

function checkGameOver() {
  const alive = players.filter(p => p.alive);
  if (players.length >= 2 && alive.length <= 1) {
    gameState = 'gameover';
    clearInterval(tickTimer);
    tickTimer = null;

    const winner = alive.length === 1 ? alive[0].name : null;
    broadcast({
      type: 'gameover',
      winner,
      players: players.map(p => ({ id: p.id, name: p.name, score: p.score, alive: p.alive })),
    });
    return true;
  }
  return false;
}

function tick() {
  // Process each living player
  const newHeads = [];

  for (const p of players) {
    if (!p.alive) continue;
    p.direction = { ...p.nextDirection };
    const head = {
      x: p.snake[0].x + p.direction.x,
      y: p.snake[0].y + p.direction.y,
    };
    newHeads.push({ player: p, head });
  }

  // Check wall collisions
  for (const { player, head } of newHeads) {
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
      player.alive = false;
    }
  }

  // Check self-collision (against current body, before moving)
  for (const { player, head } of newHeads) {
    if (!player.alive) continue;
    if (player.snake.some(s => s.x === head.x && s.y === head.y)) {
      player.alive = false;
    }
  }

  // Check collision with other players' bodies (current positions, before moving)
  for (const { player: p1, head: h1 } of newHeads) {
    if (!p1.alive) continue;
    for (const p2 of players) {
      if (p1.id === p2.id) continue;
      if (p2.snake.some(s => s.x === h1.x && s.y === h1.y)) {
        p1.alive = false;
      }
    }
  }

  // Check head-to-head collision
  const aliveHeads = newHeads.filter(nh => nh.player.alive);
  for (let i = 0; i < aliveHeads.length; i++) {
    for (let j = i + 1; j < aliveHeads.length; j++) {
      if (aliveHeads[i].head.x === aliveHeads[j].head.x &&
          aliveHeads[i].head.y === aliveHeads[j].head.y) {
        aliveHeads[i].player.alive = false;
        aliveHeads[j].player.alive = false;
      }
    }
  }

  // Move surviving snakes
  for (const { player, head } of newHeads) {
    if (!player.alive) continue;
    player.snake.unshift(head);

    if (head.x === food.x && head.y === food.y) {
      player.score++;
      placeFood();
    } else {
      player.snake.pop();
    }
  }

  if (!checkGameOver()) {
    broadcast(getStatePayload());
  }
}

function startCountdown() {
  gameState = 'countdown';
  resetGame();
  let remaining = COUNTDOWN_SECS;

  broadcast({ type: 'countdown', seconds: remaining });

  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      gameState = 'running';
      broadcast(getStatePayload());
      tickTimer = setInterval(tick, TICK_MS);
    } else {
      broadcast({ type: 'countdown', seconds: remaining });
    }
  }, 1000);
}

function broadcastLobby() {
  broadcast({
    type: 'lobby',
    players: players.map(p => ({ id: p.id, name: p.name })),
    needed: MAX_PLAYERS,
  });
}

function cleanupGame() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  gameState = 'lobby';
}

// --- Connection handling ---

wss.on('connection', (ws) => {
  if (players.length >= MAX_PLAYERS) {
    sendTo(ws, { type: 'full', message: 'Game is full. Try again later.' });
    ws.close();
    return;
  }

  const playerId = nextPlayerId++;
  const playerObj = {
    ws,
    ...initPlayer(playerId, `Player ${playerId + 1}`),
  };
  players.push(playerObj);

  sendTo(ws, { type: 'welcome', id: playerObj.id, name: playerObj.name });
  broadcastLobby();

  if (players.length === MAX_PLAYERS && gameState === 'lobby') {
    startCountdown();
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'direction' && gameState === 'running') {
      const p = players.find(pl => pl.ws === ws);
      if (!p || !p.alive) return;
      const { x, y } = msg.dir;
      // Validate direction
      if (Math.abs(x) + Math.abs(y) !== 1) return;
      // Prevent 180° reversal
      if (p.direction.x === -x && p.direction.y === -y) return;
      p.nextDirection = { x, y };
    }

    if (msg.type === 'setName') {
      const p = players.find(pl => pl.ws === ws);
      if (p) {
        p.name = String(msg.name).slice(0, 16) || p.name;
        broadcastLobby();
      }
    }

    if (msg.type === 'restart' && gameState === 'gameover') {
      if (players.length === MAX_PLAYERS) {
        startCountdown();
      } else {
        gameState = 'lobby';
        broadcastLobby();
      }
    }
  });

  ws.on('close', () => {
    const idx = players.findIndex(p => p.ws === ws);
    if (idx !== -1) {
      const removed = players.splice(idx, 1)[0];
      // Re-index remaining players
      players.forEach((p, i) => { p.id = i; });
      nextPlayerId = players.length;

      cleanupGame();
      broadcast({
        type: 'playerLeft',
        name: removed.name,
        players: players.map(p => ({ id: p.id, name: p.name })),
      });

      if (players.length > 0) {
        broadcastLobby();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Snake server running at http://localhost:${PORT}`);
});
