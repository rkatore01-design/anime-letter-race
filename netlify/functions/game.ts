import { getStore } from "@netlify/blobs";

type GameStatus = "lobby" | "playing" | "finished";

type Player = {
  id: string;
  name: string;
  score: number;
  lastRoundPoints: number;
  joinedAt: number;
};

type Character = { name: string; anime: string };

type Round = {
  number: number;
  answer: string;
  anime: string;
  startedAt: number;
  finishedAt: number | null;
  winnerPlayerId: string | null;
  pointsAwarded: number | null;
  revealedCountAtWin: number | null;
};

type StoredRoom = {
  code: string;
  createdAt: number;
  updatedAt: number;
  status: GameStatus;
  hostId: string;
  players: Player[];
  round: Round | null;
  lastAnswer: string | null;
};

const CHARACTERS: Character[] = [
  { name: "Goku", anime: "Dragon Ball" },
  { name: "Vegeta", anime: "Dragon Ball" },
  { name: "Frieza", anime: "Dragon Ball" },
  { name: "Luffy", anime: "One Piece" },
  { name: "Zoro", anime: "One Piece" },
  { name: "Sanji", anime: "One Piece" },
  { name: "Nami", anime: "One Piece" },
  { name: "Eren", anime: "Attack on Titan" },
  { name: "Levi", anime: "Attack on Titan" },
  { name: "Mikasa", anime: "Attack on Titan" },
  { name: "Deku", anime: "My Hero Academia" },
  { name: "Bakugo", anime: "My Hero Academia" },
  { name: "Todoroki", anime: "My Hero Academia" },
];

const store = getStore("anime-letter-race");
const MAX_PLAYERS = 8;
const REVEAL_INTERVAL_MS = 4_000;
const MAX_MUTATION_RETRIES = 10;

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
    },
  });
}

function getPlayerInput(body: Record<string, unknown>) {
  const playerId = String(body.playerId ?? "").trim().slice(0, 80);
  const name = String(body.name ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(playerId)) {
    throw new ApiError(400, "Your player session looks invalid. Refresh and try again.");
  }
  if (!name) throw new ApiError(400, "Enter a nickname first.");
  return { playerId, name };
}

function normaliseGuess(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z]/g, "");
}

function randomCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => letters[byte % letters.length]).join("");
}

function chooseCharacter(previous: string | null): Character {
  const available = CHARACTERS.filter((character) => character.name !== previous);
  const pool = available.length > 0 ? available : CHARACTERS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function makeRound(previousAnswer: string | null, number: number): Round {
  const character = chooseCharacter(previousAnswer);
  return {
    number,
    answer: character.name,
    anime: character.anime,
    startedAt: Date.now(),
    finishedAt: null,
    winnerPlayerId: null,
    pointsAwarded: null,
    revealedCountAtWin: null,
  };
}

async function mutateRoom<T>(
  code: string,
  mutate: (room: StoredRoom) => { room: StoredRoom; result: T },
): Promise<{ room: StoredRoom; result: T }> {
  if (!/^[A-Z]{4}$/.test(code)) throw new ApiError(400, "Enter a valid 4-letter room code.");
  for (let attempt = 0; attempt < MAX_MUTATION_RETRIES; attempt += 1) {
    const current = await store.getWithMetadata(code, {
      consistency: "strong",
      type: "json",
    });
    if (!current) throw new ApiError(404, "Room not found. Check the code and try again.");

    const room = current.data as StoredRoom;
    const changed = mutate(structuredClone(room));
    changed.room.updatedAt = Date.now();
    const saved = await store.setJSON(code, changed.room, {
      onlyIfMatch: current.etag,
    });
    if (saved.modified) return { room: changed.room, result: changed.result };
  }
  throw new ApiError(409, "The room changed at the same time. Please retry your action.");
}

function publicRoom(room: StoredRoom, now = Date.now()) {
  const round = room.round;
  const elapsedMs = round
    ? Math.max(0, (round.finishedAt ?? now) - round.startedAt)
    : 0;
  const revealedCount = round
    ? Math.min(round.answer.length - 1, Math.floor(elapsedMs / REVEAL_INTERVAL_MS))
    : 0;
  const answerVisible = room.status === "finished";
  const answerChars = round
    ? Array.from(round.answer).map((letter, index) =>
        answerVisible || index < revealedCount ? letter : "",
      )
    : [];
  const winner = round?.winnerPlayerId
    ? room.players.find((player) => player.id === round.winnerPlayerId) ?? null
    : null;

  return {
    code: room.code,
    createdAt: room.createdAt,
    status: room.status,
    hostId: room.hostId,
    players: [...room.players].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt),
    round: round
      ? {
          number: round.number,
          anime: round.anime,
          length: round.answer.length,
          startedAt: round.startedAt,
          elapsedMs,
          revealedCount,
          answerChars,
          answer: answerVisible ? round.answer : null,
          winnerPlayerId: round.winnerPlayerId,
          winnerName: winner?.name ?? null,
          pointsAwarded: round.pointsAwarded,
          revealedCountAtWin: round.revealedCountAtWin,
          nextRevealInMs:
            room.status === "playing" && revealedCount < round.answer.length - 1
              ? REVEAL_INTERVAL_MS - (elapsedMs % REVEAL_INTERVAL_MS)
              : null,
        }
      : null,
  };
}

async function readRoom(codeInput: unknown) {
  const code = String(codeInput ?? "").trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) throw new ApiError(400, "Enter a valid 4-letter room code.");
  const entry = await store.getWithMetadata(code, { consistency: "strong", type: "json" });
  if (!entry) throw new ApiError(404, "Room not found. Check the code and try again.");
  return entry.data as StoredRoom;
}

export default async (request: Request): Promise<Response> => {
  try {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const room = await readRoom(url.searchParams.get("code"));
      return response({ room: publicRoom(room) });
    }

    if (request.method !== "POST") {
      return response({ error: "Method not allowed." }, 405);
    }

    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");

    if (action === "create") {
      const { playerId, name } = getPlayerInput(body);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const code = randomCode();
        const now = Date.now();
        const room: StoredRoom = {
          code,
          createdAt: now,
          updatedAt: now,
          status: "lobby",
          hostId: playerId,
          players: [{ id: playerId, name, score: 0, lastRoundPoints: 0, joinedAt: now }],
          round: null,
          lastAnswer: null,
        };
        const saved = await store.setJSON(code, room, { onlyIfNew: true });
        if (saved.modified) return response({ room: publicRoom(room), playerId });
      }
      throw new ApiError(503, "Could not create a unique room. Please try again.");
    }

    if (action === "join") {
      const { playerId, name } = getPlayerInput(body);
      const code = String(body.code ?? "").trim().toUpperCase();
      const { room } = await mutateRoom(code, (draft) => {
        const existing = draft.players.find((player) => player.id === playerId);
        if (existing) {
          existing.name = name;
          return { room: draft, result: undefined };
        }
        if (draft.status !== "lobby") throw new ApiError(409, "This match has already started.");
        if (draft.players.length >= MAX_PLAYERS) throw new ApiError(409, "This room is full (8 players max).");
        if (draft.players.length === 0) draft.hostId = playerId;
        draft.players.push({ id: playerId, name, score: 0, lastRoundPoints: 0, joinedAt: Date.now() });
        return { room: draft, result: undefined };
      });
      return response({ room: publicRoom(room), playerId });
    }

    const { playerId } = getPlayerInput({ ...body, name: String(body.name ?? "Player") || "Player" });
    const code = String(body.code ?? "").trim().toUpperCase();

    if (action === "start") {
      const { room } = await mutateRoom(code, (draft) => {
        if (draft.hostId !== playerId) throw new ApiError(403, "Only the host can start the match.");
        if (draft.status !== "lobby") throw new ApiError(409, "This match has already started.");
        if (draft.players.length < 2) throw new ApiError(409, "Invite at least one more player to start.");
        draft.status = "playing";
        draft.players.forEach((player) => (player.lastRoundPoints = 0));
        draft.round = makeRound(draft.lastAnswer, 1);
        draft.lastAnswer = draft.round.answer;
        return { room: draft, result: undefined };
      });
      return response({ room: publicRoom(room) });
    }

    if (action === "guess") {
      const guess = normaliseGuess(body.guess);
      if (!guess) throw new ApiError(400, "Type a character name first.");
      const beforeGuess = await readRoom(code);
      if (!beforeGuess.players.some((item) => item.id === playerId)) {
        throw new ApiError(403, "You are not a member of this room.");
      }
      if (beforeGuess.status !== "playing" || !beforeGuess.round) {
        throw new ApiError(409, "This round is not accepting guesses.");
      }
      if (normaliseGuess(beforeGuess.round.answer) !== guess) {
        return response({
          room: publicRoom(beforeGuess),
          result: { correct: false, message: "Not quite — keep racing!" },
        });
      }
      const expectedRoundNumber = beforeGuess.round.number;
      const { room, result } = await mutateRoom(code, (draft) => {
        const player = draft.players.find((item) => item.id === playerId);
        if (!player) throw new ApiError(403, "You are not a member of this room.");
        if (draft.status !== "playing" || !draft.round) {
          throw new ApiError(409, "This round is not accepting guesses.");
        }
        if (draft.round.number !== expectedRoundNumber || normaliseGuess(draft.round.answer) !== guess) {
          throw new ApiError(409, "The round changed while your guess was being submitted. Try again.");
        }
        const now = Date.now();
        const elapsedMs = Math.max(0, now - draft.round.startedAt);
        const revealedCount = Math.min(
          draft.round.answer.length - 1,
          Math.floor(elapsedMs / REVEAL_INTERVAL_MS),
        );
        const elapsedSeconds = Math.floor(elapsedMs / 1_000);
        const points = Math.max(100, 1_000 - elapsedSeconds * 12 - revealedCount * 100);
        draft.status = "finished";
        draft.round.finishedAt = now;
        draft.round.winnerPlayerId = player.id;
        draft.round.pointsAwarded = points;
        draft.round.revealedCountAtWin = revealedCount;
        player.score += points;
        player.lastRoundPoints = points;
        return {
          room: draft,
          result: { correct: true, points, message: `Correct! +${points.toLocaleString()} points.` },
        };
      });
      return response({ room: publicRoom(room), result });
    }

    if (action === "nextRound") {
      const { room } = await mutateRoom(code, (draft) => {
        if (draft.hostId !== playerId) throw new ApiError(403, "Only the host can start the next round.");
        if (draft.status !== "finished") throw new ApiError(409, "Finish this round before starting another.");
        draft.status = "playing";
        draft.players.forEach((player) => (player.lastRoundPoints = 0));
        draft.round = makeRound(draft.lastAnswer, (draft.round?.number ?? 0) + 1);
        draft.lastAnswer = draft.round.answer;
        return { room: draft, result: undefined };
      });
      return response({ room: publicRoom(room) });
    }

    if (action === "leave") {
      const { room } = await mutateRoom(code, (draft) => {
        draft.players = draft.players.filter((player) => player.id !== playerId);
        if (draft.players.length > 0 && draft.hostId === playerId) draft.hostId = draft.players[0].id;
        if (draft.players.length === 0) {
          draft.status = "lobby";
          draft.round = null;
          draft.hostId = "";
        }
        return { room: draft, result: undefined };
      });
      return response({ room: publicRoom(room) });
    }

    return response({ error: "Unknown game action." }, 400);
  } catch (error) {
    if (error instanceof ApiError) return response({ error: error.message }, error.status);
    console.error("Anime Letter Race function error:", error);
    return response({ error: "The game server hit an unexpected error. Check the function logs." }, 500);
  }
};
