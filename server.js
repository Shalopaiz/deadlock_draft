// Deadlock draft server: без зависимостей, Node 18+.
// Состояние и правила на сервере; клиенты получают обновления по SSE.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, "public", "index.html");
const SEQ = "bA bB bA bB pA pB pB pA bB bA bB bA pB pA pA pB pB pA pA pB".split(" ").map(s => ({ t: s[0] === "b" ? "ban" : "pick", k: s[1] }));
const rooms = new Map();
const tokenOf = () => crypto.randomBytes(12).toString("hex");
const team = (s, k) => (k === "A" ? s.first : 1 - s.first);

function newCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let c;
  do { c = Array.from({ length: 6 }, () => A[crypto.randomInt(A.length)]).join(""); } while (rooms.has(c));
  return c;
}
function roleOf(R, t) {
  if (!t) return "spec";
  return t === R.tok.host ? "host" : t === R.tok.c0 ? "c0" : t === R.tok.c1 ? "c1" : "spec";
}
function broadcast(R) {
  for (const c of R.clients) {
    c.res.write("data: " + JSON.stringify({ s: R.s, you: roleOf(R, c.t), now: Date.now() }) + "\n\n");
  }
}
function applyMove(s, h) {
  const st = SEQ[s.i], now = Date.now();
  const over = Math.max(0, (now - s.ts) / 1000 - s.tt);
  s.rs[st.k] = Math.max(0, Math.round(s.rs[st.k] - over));
  s.log.push({ t: st.t, k: st.k, h });
  s.i++; s.ts = now;
  if (s.i >= SEQ.length) s.stage = "done";
}
function act(R, role, b) {
  const s = R.s, host = role === "host", cap = role[0] === "c" ? +role[1] : -1;
  const can = t => host || cap === t;
  switch (b.a) {
    case "flip":
      if (s.stage !== "coin" || !(host || cap >= 0)) return false;
      s.w = crypto.randomInt(2); s.stage = "order"; return true;
    case "first": case "second":
      if (s.stage !== "order" || !can(s.w)) return false;
      s.first = b.a === "first" ? s.w : 1 - s.w; s.stage = "side"; return true;
    case "amber": case "sapph": {
      const l = 1 - s.w;
      if (s.stage !== "side" || !can(l)) return false;
      const am = b.a === "amber";
      s.side[l] = am ? "Amber Hand" : "Sapphire Flame";
      s.side[s.w] = am ? "Sapphire Flame" : "Amber Hand";
      Object.assign(s, { stage: "draft", i: 0, ts: Date.now(), log: [], rs: { A: s.rt, B: s.rt } });
      return true;
    }
    case "move": {
      if (s.stage !== "draft") return false;
      const st = SEQ[s.i];
      if (!can(team(s, st.k))) return false;
      const h = String(b.h || "");
      if (h === "") { if (st.t !== "ban") return false; }
      else if (!s.pool.includes(h) || s.log.some(l => l.h === h)) return false;
      applyMove(s, h); return true;
    }
    case "undo":
      if (!host || s.i === 0 || !["draft", "done"].includes(s.stage)) return false;
      s.log.pop(); s.i--; s.stage = "draft"; s.ts = Date.now(); return true;
  }
  return false;
}
// Автоход по таймеру: пик — случайный герой, бан — пропуск.
setInterval(() => {
  const now = Date.now();
  for (const [code, R] of rooms) {
    const s = R.s;
    if (now - R.created > 48 * 3600e3) { rooms.delete(code); continue; }
    if (s.stage !== "draft") continue;
    const k = SEQ[s.i].k, over = (now - s.ts) / 1000 - s.tt;
    if (over >= s.rs[k]) {
      let h = "";
      if (SEQ[s.i].t === "pick") {
        const free = s.pool.filter(x => !s.log.some(l => l.h === x));
        h = free[crypto.randomInt(free.length)];
      }
      applyMove(s, h); broadcast(R);
    }
  }
}, 500);
setInterval(() => { for (const R of rooms.values()) for (const c of R.clients) c.res.write(":\n\n"); }, 15000);

function body(req) {
  return new Promise((ok, no) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 1e5) { req.destroy(); no(); } });
    req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch (e) { no(e); } });
  });
}
const json = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  try {
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(INDEX));
    }
    if (req.method === "POST" && p === "/api/create") {
      const b = await body(req);
      const pool = Array.isArray(b.pool) ? [...new Set(b.pool.map(x => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 200) : [];
      if (pool.length < 20) return json(res, 400, { error: "Нужно минимум 20 героев" });
      const n = [0, 1].map(i => String((b.n || [])[i] || "Команда " + (i + 1)).slice(0, 40));
      const tt = Math.min(300, Math.max(5, +b.tt || 30)), rt = Math.min(600, Math.max(0, +b.rt || 0));
      const code = newCode();
      const R = { created: Date.now(), clients: new Set(), tok: { host: tokenOf(), c0: tokenOf(), c1: tokenOf() },
        s: { n, pool, tt, rt, stage: "coin", w: -1, first: -1, side: ["", ""], log: [], i: 0, ts: 0, rs: { A: rt, B: rt } } };
      rooms.set(code, R);
      return json(res, 200, { code, tokens: R.tok });
    }
    const m = p.match(/^\/api\/room\/([A-Z0-9]{6})\/(events|act)$/);
    if (m) {
      const R = rooms.get(m[1]);
      if (!R) return json(res, 404, { error: "Комната не найдена" });
      if (m[2] === "events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        const c = { res, t: u.searchParams.get("t") || "" };
        R.clients.add(c); req.on("close", () => R.clients.delete(c));
        res.write("data: " + JSON.stringify({ s: R.s, you: roleOf(R, c.t), now: Date.now() }) + "\n\n");
        return;
      }
      if (m[2] === "act" && req.method === "POST") {
        const b = await body(req);
        const ok = act(R, roleOf(R, String(b.t || "")), b);
        if (ok) broadcast(R);
        return json(res, ok ? 200 : 403, { ok });
      }
    }
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 400, { error: "bad request" }); }
}).listen(PORT, () => console.log("Deadlock draft: http://localhost:" + PORT));
