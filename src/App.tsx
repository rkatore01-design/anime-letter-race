import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type GameStatus = "lobby" | "playing" | "finished";
type Player = {
  id: string;
  name: string;
  score: number;
  lastRoundPoints: number;
  joinedAt: number;
};
type PublicRound = {
  number: number;
  anime: string;
  length: number;
  startedAt: number;
  elapsedMs: number;
  revealedCount: number;
  answerChars: string[];
  answer: string | null;
  winnerPlayerId: string | null;
  winnerName: string | null;
  pointsAwarded: number | null;
  revealedCountAtWin: number | null;
  nextRevealInMs: number | null;
};
type PublicRoom = {
  code: string;
  createdAt: number;
  status: GameStatus;
  hostId: string;
  players: Player[];
  round: PublicRound | null;
};
type ApiResponse = {
  room?: PublicRoom;
  playerId?: string;
  result?: { correct: boolean; points?: number; message: string };
  error?: string;
};

const API = "/.netlify/functions/game";
const POLL_MS = 750;

function getPlayerId() {
  const key = "anime-letter-race-player-id";
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "");
    window.localStorage.setItem(key, id);
  }
  return id;
}

async function postGame(payload: Record<string, unknown>): Promise<ApiResponse> {
  const result = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const data = (await result.json()) as ApiResponse;
  if (!result.ok) throw new Error(data.error || `Request failed (${result.status}).`);
  return data;
}

async function getRoom(code: string): Promise<PublicRoom> {
  const result = await fetch(`${API}?code=${encodeURIComponent(code)}`, { cache: "no-store" });
  const data = (await result.json()) as ApiResponse;
  if (!result.ok || !data.room) throw new Error(data.error || "Could not load the room.");
  return data.room;
}

function formatClock(ms: number) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1_000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function App() {
  const [playerId] = useState(getPlayerId);
  const [name, setName] = useState(() => window.localStorage.getItem("anime-letter-race-name") ?? "");
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [lastRoomSyncAt, setLastRoomSyncAt] = useState(Date.now());
  const [joinCode, setJoinCode] = useState("");
  const [guess, setGuess] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; kind: "good" | "bad" | "neutral" } | null>(null);
  const [now, setNow] = useState(Date.now());
  const isHost = !!room && room.hostId === playerId;
  const activeRound = room?.round;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 150);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("anime-letter-race-name", name);
  }, [name]);

  useEffect(() => {
    if (!room?.code) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const fresh = await getRoom(room.code);
        if (!cancelled) {
          setRoom(fresh);
          setLastRoomSyncAt(Date.now());
        }
      } catch (error) {
        if (!cancelled) {
          setFeedback({ text: error instanceof Error ? error.message : "Lost connection to the room.", kind: "bad" });
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // Polling is tied to the room identity, not each incoming room snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.code]);

  const perform = useCallback(async (payload: Record<string, unknown>, successText?: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const data = await postGame({ ...payload, playerId, name: name.trim() || "Player" });
      if (data.room) {
        setRoom(data.room);
        setLastRoomSyncAt(Date.now());
      }
      if (successText) setFeedback({ text: successText, kind: "good" });
      return data;
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : "Something went wrong.", kind: "bad" });
      return null;
    } finally {
      setBusy(false);
    }
  }, [name, playerId]);

  const createRoom = async () => {
    if (!name.trim()) {
      setFeedback({ text: "Choose a nickname before creating a room.", kind: "bad" });
      return;
    }
    const data = await perform({ action: "create" }, "Room created. Invite your friends!");
    if (data?.room) {
      setJoinCode(data.room.code);
      setGuess("");
    }
  };

  const joinRoom = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setFeedback({ text: "Choose a nickname before joining a room.", kind: "bad" });
      return;
    }
    const code = joinCode.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      setFeedback({ text: "Room codes are exactly 4 letters.", kind: "bad" });
      return;
    }
    const data = await perform({ action: "join", code }, "Joined the room. Good luck!");
    if (data?.room) {
      setJoinCode(data.room.code);
      setGuess("");
    }
  };

  const sendGuess = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!room || !guess.trim() || busy) return;
    const data = await perform({ action: "guess", code: room.code, guess });
    if (data?.result) {
      setFeedback({ text: data.result.message, kind: data.result.correct ? "good" : "neutral" });
      if (data.result.correct) setGuess("");
    }
  };

  const leaveRoom = async () => {
    if (!room) return;
    await perform({ action: "leave", code: room.code });
    setRoom(null);
    setLastRoomSyncAt(Date.now());
    setGuess("");
    setFeedback(null);
  };

  const copyCode = async () => {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setFeedback({ text: "Room code copied to clipboard.", kind: "good" });
    } catch {
      setFeedback({ text: `Share this room code: ${room.code}`, kind: "neutral" });
    }
  };

  const revealCountdown = useMemo(() => {
    if (!activeRound || room?.status !== "playing") return null;
    if (activeRound.revealedCount >= activeRound.length - 1) return null;
    if (activeRound.nextRevealInMs === null) return null;
    const remaining = Math.max(0, activeRound.nextRevealInMs - (now - lastRoomSyncAt));
    return Math.ceil(remaining / 1_000);
  }, [activeRound, now, lastRoomSyncAt, room?.status]);

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <button className="brand" onClick={() => { if (room) void leaveRoom(); else setFeedback(null); }} aria-label="Back to lobby">
          <span className="brand-mark"><span>字</span></span>
          <span className="brand-copy"><strong>ANIME<span>RACE</span></strong><small>GUESS FAST. SCORE BIG.</small></span>
        </button>
        <div className="topbar-right">
          <span className="live-dot" /> LIVE MULTIPLAYER
          <span className="topbar-divider" />
          <span className="players-total"><span className="tiny-people">♟</span> 2–8 PLAYERS</span>
        </div>
      </header>

      <main className="main-content">
        {!room ? (
          <Lobby
            name={name}
            setName={setName}
            joinCode={joinCode}
            setJoinCode={setJoinCode}
            busy={busy}
            feedback={feedback}
            createRoom={createRoom}
            joinRoom={joinRoom}
          />
        ) : (
          <section className="room-view">
            <div className="room-nav">
              <button className="back-button" onClick={leaveRoom} disabled={busy}><span aria-hidden="true">←</span> LEAVE ROOM</button>
              <div className="room-identity"><span className="room-overline">ROOM CODE</span><strong>{room.code}</strong><button onClick={copyCode} className="copy-code" title="Copy room code">▣</button></div>
              <div className="connection-status"><span className="live-dot" /> SYNCED</div>
            </div>

            {room.status === "lobby" ? (
              <div className="room-lobby-grid">
                <section className="panel waiting-panel">
                  <div className="eyebrow"><span className="eyebrow-line" /> MATCH LOBBY <span className="eyebrow-line" /></div>
                  <h1>Build your <span className="gradient-text">squad.</span></h1>
                  <p className="section-lead">Share the room code and get your rivals in here.</p>
                  <div className="code-share-card">
                    <div><span className="field-label">YOUR ROOM CODE</span><strong className="large-code">{room.code}</strong></div>
                    <button className="button button-secondary copy-wide" onClick={copyCode}>▣ <span>Copy code</span></button>
                  </div>
                  <div className="roster-heading"><span>PLAYER ROSTER</span><span className="roster-count">{room.players.length} / 8 JOINED</span></div>
                  <PlayerRoster room={room} playerId={playerId} compact={false} />
                  {isHost ? (
                    <button className="button button-primary button-full start-button" onClick={() => void perform({ action: "start", code: room.code }, "Match started — go go go!")} disabled={busy || room.players.length < 2}>
                      <span>START MATCH</span><span className="button-arrow">↗</span>
                    </button>
                  ) : <div className="waiting-message"><span className="pulse-ring" /> Waiting for the host to start the match…</div>}
                  {isHost && room.players.length < 2 && <p className="helper-text centered">You need at least one more player to start.</p>}
                  {feedback && <Feedback feedback={feedback} />}
                </section>
                <aside className="panel side-panel room-howto">
                  <div className="side-panel-icon">✦</div>
                  <span className="section-tag">QUICK BRIEFING</span>
                  <h2>How to <span className="gradient-text">play</span></h2>
                  <HowToPlay compact />
                  <div className="anime-pool"><span>CHARACTER POOL</span><div className="anime-chip-row"><span>Dragon Ball</span><span>One Piece</span><span>Attack on Titan</span><span>My Hero Academia</span></div></div>
                </aside>
              </div>
            ) : (
              <div className="game-grid">
                <section className="panel game-panel">
                  <div className="game-header">
                    <div><div className="eyebrow left"><span className="eyebrow-line" /> ROUND {activeRound?.number ?? 1}</div><h1>{room.status === "finished" ? "Round complete." : "Name that character."}</h1></div>
                    <div className={`round-status ${room.status === "finished" ? "status-finished" : "status-playing"}`}><span /> {room.status === "finished" ? "ROUND OVER" : "IN PROGRESS"}</div>
                  </div>
                  <div className="anime-label-row"><span className="anime-label">{activeRound?.anime ?? "Anime character"}</span><span className="reveal-status">{activeRound?.revealedCount ?? 0} LETTER{activeRound?.revealedCount === 1 ? "" : "S"} REVEALED</span></div>
                  <div className={`character-board ${room.status === "finished" ? "character-board-finished" : ""}`}>
                    <div className="scan-line" />
                    <div className="board-corner board-tl" /><div className="board-corner board-br" />
                    <span className="board-caption">SECRET CHARACTER</span>
                    <div className="letter-row" aria-label={`${activeRound?.revealedCount ?? 0} letters revealed`}>
                      {activeRound?.answerChars.map((char, index) => (
                        <div key={`${activeRound.number}-${index}`} className={`letter-tile ${char ? "letter-revealed" : "letter-hidden"}`}>
                          <span>{char || "_"}</span>
                          {char && <i className="letter-glint" />}
                        </div>
                      ))}
                    </div>
                    {room.status === "playing" ? (
                      <div className="reveal-timer"><span className="timer-icon">◷</span>{revealCountdown === null ? "FINAL LETTER LOCKED" : `NEXT LETTER IN 00:0${revealCountdown}`}</div>
                    ) : <div className="reveal-timer reveal-complete">✦ ANSWER REVEALED ✦</div>}
                  </div>

                  {room.status === "playing" ? (
                    <form className="guess-form" onSubmit={sendGuess}>
                      <label htmlFor="character-guess">YOUR GUESS</label>
                      <div className="guess-input-row"><span className="input-search">⌕</span><input id="character-guess" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Type the character's name…" value={guess} onChange={(event) => setGuess(event.target.value)} disabled={busy} /><button className="button button-primary guess-button" type="submit" disabled={busy || !guess.trim()}>GUESS <span>↗</span></button></div>
                      <p className="helper-text">First correct answer wins the round. Capitalization doesn't matter.</p>
                    </form>
                  ) : (
                    <div className="winner-banner"><div className="winner-medal">✦</div><div className="winner-copy"><span className="winner-kicker">ROUND WINNER</span><strong>{activeRound?.winnerName ?? "Champion"}</strong><span>Found <b>{activeRound?.answer}</b> with {activeRound?.revealedCountAtWin ?? 0} letter{activeRound?.revealedCountAtWin === 1 ? "" : "s"} revealed.</span></div><div className="winner-points">+{(activeRound?.pointsAwarded ?? 0).toLocaleString()}<small>PTS</small></div></div>
                  )}

                  {feedback && <Feedback feedback={feedback} />}

                  {room.status === "finished" && (
                    <div className="next-round-row">{isHost ? <button className="button button-primary button-full" onClick={() => void perform({ action: "nextRound", code: room.code }, "Next round — new character incoming!")} disabled={busy}>NEXT ROUND <span className="button-arrow">↗</span></button> : <div className="waiting-message"><span className="pulse-ring" /> Host is setting up the next round…</div>}</div>
                  )}
                </section>

                <aside className="panel scoreboard-panel">
                  <div className="scoreboard-heading"><div><span className="section-tag">THE RANKINGS</span><h2>Scoreboard<span className="scoreboard-dot">.</span></h2></div><span className="roster-count">{room.players.length} PLAYERS</span></div>
                  <PlayerRoster room={room} playerId={playerId} compact />
                  <div className="scoring-note"><span className="scoring-note-icon">⚡</span><div><strong>Speed is everything.</strong><p>Fewer revealed letters and a faster guess mean more points.</p></div></div>
                  <div className="mini-stats"><div><span>ROUND</span><strong>{String(activeRound?.number ?? 1).padStart(2, "0")}</strong></div><div><span>ELAPSED</span><strong>{formatClock(room.status === "finished" ? (activeRound?.elapsedMs ?? 0) : (activeRound?.elapsedMs ?? 0) + Math.max(0, now - lastRoomSyncAt))}</strong></div></div>
                </aside>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="footer"><span>ANIME RACE <i>©</i> 2026</span><span>BUILT FOR THE LOVE OF ANIME <b>✦</b></span><span>FAST FINGERS. BIG ENERGY.</span></footer>
    </div>
  );
}

type LobbyProps = {
  name: string;
  setName: (value: string) => void;
  joinCode: string;
  setJoinCode: (value: string) => void;
  busy: boolean;
  feedback: { text: string; kind: "good" | "bad" | "neutral" } | null;
  createRoom: () => void;
  joinRoom: (event: FormEvent) => void;
};

function Lobby({ name, setName, joinCode, setJoinCode, busy, feedback, createRoom, joinRoom }: LobbyProps) {
  return (
    <>
      <section className="hero-section">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> THE ULTIMATE ANIME SHOWDOWN <span className="eyebrow-line" /></div>
          <h1>Know your anime.<br /><span className="gradient-text">Beat the clock.</span></h1>
          <p>One secret character. A few hidden letters. And a race to type the name before anyone else does.</p>
          <div className="hero-metrics"><div><strong>13<span>+</span></strong><small>ICONIC CHARACTERS</small></div><div className="metric-divider" /><div><strong>4<span>s</span></strong><small>BETWEEN REVEALS</small></div><div className="metric-divider" /><div><strong>8</strong><small>PLAYERS PER ROOM</small></div></div>
          <div className="hero-sticker"><span>✦</span> READY, SET, ANIME! <span>↗</span></div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-sun" />
          <div className="art-card card-back"><span>??</span><small>UNKNOWN</small></div>
          <div className="art-card card-front"><span className="art-kanji">速</span><div className="art-lines"><i /><i /><i /></div><small>CHARACTER RACE</small></div>
          <div className="art-spark spark-a">✦</div><div className="art-spark spark-b">✧</div><div className="art-speed speed-a" /><div className="art-speed speed-b" />
          <div className="art-label label-top">GUESS IT</div><div className="art-label label-bottom">BE FIRST</div>
        </div>
      </section>

      <section className="lobby-lower-grid">
        <div className="panel join-panel">
          <div className="panel-topline"><span className="step-number">01</span><span className="section-tag">ENTER THE ARENA</span></div>
          <h2>Ready to <span className="gradient-text">race?</span></h2>
          <p className="panel-intro">Pick your player name, then create a new room or jump into an existing one.</p>
          <label className="field-label" htmlFor="player-name">YOUR NICKNAME</label>
          <input id="player-name" className="text-input" maxLength={16} placeholder="e.g. Kai, Senpai, Neko…" value={name} onChange={(event) => setName(event.target.value)} />
          <div className="lobby-actions">
            <button className="button button-primary create-button" onClick={createRoom} disabled={busy}><span className="button-icon">＋</span><span><strong>CREATE ROOM</strong><small>Be the host</small></span><span className="button-arrow">↗</span></button>
            <div className="or-divider"><span /> OR <span /></div>
            <form className="join-form" onSubmit={joinRoom}>
              <label className="field-label" htmlFor="room-code">HAVE A ROOM CODE?</label>
              <div className="join-input-row"><input id="room-code" className="text-input code-input" maxLength={4} autoCapitalize="characters" placeholder="A B C D" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} /><button className="button button-secondary join-button" type="submit" disabled={busy}>JOIN ROOM <span>↗</span></button></div>
            </form>
          </div>
          {feedback && <Feedback feedback={feedback} />}
          <div className="secure-note"><span>◈</span> Share your 4-letter code only with players you want in your room.</div>
        </div>

        <aside className="panel howto-panel">
          <div className="panel-topline"><span className="step-number">02</span><span className="section-tag">THE GAME PLAN</span></div>
          <h2>How to <span className="gradient-text">play</span></h2>
          <p className="panel-intro">Easy to learn. Hard to stop playing.</p>
          <HowToPlay compact={false} />
          <div className="anime-pool"><span>FEATURING WORLDS FROM</span><div className="anime-chip-row"><span>Dragon Ball</span><span>One Piece</span><span>Attack on Titan</span><span>My Hero Academia</span></div></div>
        </aside>
      </section>
    </>
  );
}

function HowToPlay({ compact }: { compact: boolean }) {
  const steps = [
    { number: "01", title: "Create or join", body: "Use a 4-letter room code to gather 2–8 players." },
    { number: "02", title: "Watch the letters", body: "A secret character starts as underscores. One letter appears every 4 seconds." },
    { number: "03", title: "Type to win", body: "Race to enter the full character name before anyone else." },
    { number: "04", title: "Stack your points", body: "Guess quickly and before more letters reveal to earn the biggest score." },
  ];
  return <div className={`howto-steps ${compact ? "howto-steps-compact" : ""}`}>{steps.map((step) => <div className="howto-step" key={step.number}><span className="howto-number">{step.number}</span><div><strong>{step.title}</strong><p>{step.body}</p></div></div>)}</div>;
}

function PlayerRoster({ room, playerId, compact }: { room: PublicRoom; playerId: string; compact: boolean }) {
  const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  return (
    <div className={`player-roster ${compact ? "player-roster-compact" : ""}`}>
      {sortedPlayers.map((player, index) => {
        const self = player.id === playerId;
        const host = player.id === room.hostId;
        const winner = player.id === room.round?.winnerPlayerId && room.status === "finished";
        return <div className={`player-row ${self ? "player-row-self" : ""} ${winner ? "player-row-winner" : ""}`} key={player.id}>
          <div className={`player-rank rank-${Math.min(index + 1, 4)}`}>{index === 0 && player.score > 0 ? "✦" : String(index + 1).padStart(2, "0")}</div>
          <div className={`avatar avatar-${index % 5}`}><span>{player.name.trim().charAt(0).toUpperCase() || "?"}</span><i /></div>
          <div className="player-name-wrap"><strong>{player.name}{self && <span className="you-tag">YOU</span>}</strong><small>{winner ? "ROUND WINNER" : host ? "ROOM HOST" : player.score > 0 ? "IN THE RACE" : "READY TO PLAY"}</small></div>
          <div className="player-score"><strong>{player.score.toLocaleString()}</strong><small>PTS</small>{player.lastRoundPoints > 0 && <em>+{player.lastRoundPoints}</em>}</div>
        </div>;
      })}
      {Array.from({ length: Math.max(0, (compact ? Math.min(4, 8) : 8) - room.players.length) }).map((_, index) => <div className="player-row player-row-empty" key={`empty-${index}`}><div className="player-rank">—</div><div className="avatar avatar-empty">＋</div><div className="player-name-wrap"><strong>Open slot</strong><small>WAITING FOR PLAYER</small></div><div className="empty-slot-dots">···</div></div>)}
    </div>
  );
}

function Feedback({ feedback }: { feedback: { text: string; kind: "good" | "bad" | "neutral" } }) {
  return <div className={`feedback feedback-${feedback.kind}`} role="status"><span>{feedback.kind === "good" ? "✓" : feedback.kind === "bad" ? "!" : "✦"}</span>{feedback.text}</div>;
}

export default App;
