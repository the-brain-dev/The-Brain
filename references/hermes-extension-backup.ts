/**
 * Hermes Agent Extension for the-brain.
 *
 * Auto-harvests Hermes Agent interactions from state.db,
 * provides CLI commands for context injection and monitoring.
 *
 * Uses only Bun globals + brain.openDatabase() — no require/import.
 * All file I/O is async (Bun.file().text() returns Promise).
 *
 * Loaded automatically from ~/.the-brain/extensions/.
 * Exposes: the-brain ext hermes <context|harvest|stats>
 *
 * Data source:  ~/.hermes/state.db  (SQLite, read-only)
 * State file:   ~/.the-brain/hermes-state.json
 */

export default function (brain) {

  var HOME       = process.env.HOME || "~";
  var HERMES_DB  = HOME + "/.hermes/state.db";
  var STATE_FILE = HOME + "/.the-brain/hermes-state.json";
  var SOURCE     = "hermes";
  var MAX_LEN    = 800;

  // ── Helpers (Bun globals only, no require) ────────────────────

  function exists(p) {
    try { var f = Bun.file(p); return typeof f.size === "number" ? f.size > 0 : f.size > 0n; }
    catch (_) { return false; }
  }

  function sha256(text) {
    var h = new Bun.CryptoHasher("sha256");
    h.update(text);
    return h.digest("hex");
  }

  // ── Async state (Bun.file().text() is Promise-based) ──────────

  async function loadState() {
    try {
      var raw = await Bun.file(STATE_FILE).text();
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { lastId: 0, lastAt: 0, sessions: [], totalIx: 0, totalSes: 0 };
  }

  async function saveState(s) {
    try { await Bun.write(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (_) {}
  }

  // ── Hermes DB access (sync — bun:sqlite) ─────────────────────

  function openDb() {
    if (!exists(HERMES_DB)) return null;
    return brain.openDatabase(HERMES_DB, true);
  }

  function loadSessions(db) {
    var out = {};
    try {
      var rows = db.query("SELECT id, source, model FROM sessions").all();
      for (var i = 0; i < rows.length; i++)
        out[rows[i].id] = { source: rows[i].source || "unknown", model: rows[i].model || "unknown" };
    } catch (_) {}
    return out;
  }

  function getNewMsgs(db, lastId) {
    try {
      return db.query(
        "SELECT id, session_id, role, content, timestamp, token_count " +
        "FROM messages WHERE id > ?1 ORDER BY session_id, timestamp ASC LIMIT 500"
      ).all(lastId);
    } catch (_) { return []; }
  }

  // ── Pair user->assistant messages ────────────────────────────

  function pair(msgs) {
    var buf = {};
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.role === "session_meta" || m.role === "tool") continue;
      if (!buf[m.session_id]) buf[m.session_id] = { lastUser: null, pairs: [] };
      if (m.role === "user")
        buf[m.session_id].lastUser = m;
      else if (m.role === "assistant" && buf[m.session_id].lastUser) {
        buf[m.session_id].pairs.push({ u: buf[m.session_id].lastUser, a: m });
        buf[m.session_id].lastUser = null;
      }
    }
    return buf;
  }

  function build(buf, sessions, seen) {
    var out = [], maxId = 0;
    var keys = Object.keys(buf);
    for (var s = 0; s < keys.length; s++) {
      var ses = sessions[keys[s]] || {};
      var ch = ses.source || "unknown", mdl = ses.model || "unknown";
      var pairs = buf[keys[s]].pairs;
      for (var p = 0; p < pairs.length; p++) {
        var uc = pairs[p].u.content || "", ac = pairs[p].a.content || "";
        var id = sha256(uc.slice(0,200) + ac.slice(0,200) + pairs[p].u.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (pairs[p].u.id > maxId) maxId = pairs[p].u.id;
        if (pairs[p].a.id > maxId) maxId = pairs[p].a.id;
        out.push({
          id: id,
          ts: Math.round((pairs[p].u.timestamp || Date.now()) * 1000),
          prompt: uc.slice(0, 2000),
          response: ac.slice(0, 2000),
          channel: ch,
          model: mdl,
          tokens: pairs[p].a.token_count || 0,
        });
      }
    }
    return { items: out, maxId: maxId };
  }

  // ── Core harvest (sync except state) ─────────────────────────

  function doHarvest(sessions, lastId, seen) {
    var db = openDb();
    if (!db) return { items: [], newSessions: [], newSessionCount: 0, maxId: 0 };

    try {
      var dbSessions = loadSessions(db);
      var allKeys = Object.keys(dbSessions);
      var newSessions = [];
      for (var i = 0; i < allKeys.length; i++)
        if (sessions.indexOf(allKeys[i]) === -1)
          newSessions.push(allKeys[i]);

      var msgs = getNewMsgs(db, lastId);
      if (!msgs.length) return { items: [], newSessions: newSessions, newSessionCount: newSessions.length, maxId: 0 };

      var result = build(pair(msgs), dbSessions, seen);
      return { items: result.items, newSessions: newSessions, newSessionCount: newSessions.length, maxId: result.maxId };
    } finally { db.close(); }
  }

  // ── Emit into daemon pipeline (async — hook calls) ──────────

  async function emitAll(interactions) {
    var emitted = 0;
    for (var i = 0; i < interactions.length; i++) {
      var ix = interactions[i];
      var p = ix.prompt.slice(0, MAX_LEN), r = ix.response.slice(0, MAX_LEN);
      var ctx = {
        interaction: {
          id: ix.id, timestamp: ix.ts, prompt: p, response: r,
          source: SOURCE,
          metadata: { hermesChannel: ix.channel, hermesModel: ix.model, tokenCount: ix.tokens },
        },
        fragments: [{
          id: "frag-" + ix.id, layer: "instant",
          content: "Prompt: " + p + "\n\nResponse: " + r,
          timestamp: ix.ts, source: SOURCE,
          metadata: { hermesChannel: ix.channel, hermesModel: ix.model },
        }],
        promoteToDeep: function () {},
      };
      try {
        await brain.emit("harvester:newData", ctx);
        await brain.emit("onInteraction", ctx);
        emitted++;
      } catch (_) {}
    }
    return emitted;
  }

  // ── CLI: hermes context (sync — Bun.spawnSync) ──────────────

  function cmdContext(args) {
    var isJson = args.indexOf("--json") !== -1;
    try {
      var proc = Bun.spawnSync([
        process.env.HOME + "/.bun/bin/the-brain", "context", "--markdown"
      ]);
      if (proc.exitCode !== 0)
        throw new Error(proc.stderr.toString().trim() || "exit " + proc.exitCode);
      var out = proc.stdout.toString().trim();

      if (isJson) {
        console.log(JSON.stringify({ source: "the-brain", context: out, at: new Date().toISOString() }, null, 2));
      } else {
        console.log("## Hermes Context (the-brain)\n");
        console.log(out);
      }
    } catch (err) {
      console.error("[hermes] context failed:", err.message || String(err));
      process.exit(1);
    }
  }

  // ── CLI: hermes harvest (async — state I/O) ─────────────────

  async function cmdHarvest() {
    var state = await loadState();
    var seen = new Set(state.sessions);
    var result = doHarvest(state.sessions, state.lastId, seen);
    if (!result.items.length) { console.log("No new Hermes interactions found."); return; }

    console.log("Found " + result.items.length + " new interaction(s). Updating state...");
    state.lastId = result.maxId;
    state.lastAt = Date.now();
    for (var i = 0; i < result.newSessions.length; i++)
      if (state.sessions.indexOf(result.newSessions[i]) === -1)
        state.sessions.push(result.newSessions[i]);
    state.totalIx += result.items.length;
    state.totalSes += result.newSessionCount;
    await saveState(state);
    console.log("Done. State saved to " + STATE_FILE);
  }

  // ── CLI: hermes stats (async — state I/O) ───────────────────

  async function cmdStats() {
    var s = await loadState();
    var lines = [
      "## Hermes Extension Stats\n",
      "**Source:** " + SOURCE,
      "**State file:** " + STATE_FILE + "\n",
      "### Harvested",
      "- Total interactions: " + s.totalIx,
      "- Total sessions tracked: " + s.totalSes + "\n",
      "### Last Activity",
      "- Last harvest: " + (s.lastAt ? new Date(s.lastAt).toISOString() : "never"),
      "- Last message ID: " + s.lastId + "\n",
      "### Hermes DB (live)",
    ];

    var db = openDb();
    if (db) {
      try {
        var stats = db.query(
          "SELECT 'sessions' as k, COUNT(*) as v FROM sessions " +
          "UNION ALL SELECT 'messages', COUNT(*) FROM messages"
        ).all();
        var bySrc = db.query("SELECT source, COUNT(*) as c FROM sessions GROUP BY source").all();
        for (var i = 0; i < stats.length; i++)
          lines.push("- " + stats[i].k + ": " + stats[i].v);
        var parts = [];
        for (var i = 0; i < bySrc.length; i++)
          parts.push(bySrc[i].source + ": " + bySrc[i].c);
        lines.push("- By source: " + parts.join(", "));
      } catch (_) { lines.push("- (db read error)"); }
      db.close();
    } else {
      lines.push("- (not found -- Hermes not running yet?)");
    }
    console.log(lines.join("\n"));
  }

  function cmdHelp() {
    console.log([
      "Hermes Agent Extension for the-brain\n",
      "Usage: the-brain ext hermes <command> [options]\n",
      "Commands:",
      "  context       Export enhanced brain context for Hermes",
      "    --json      Output as JSON (default: markdown)\n",
      "  harvest       Manually harvest from Hermes state.db\n",
      "  stats         Show harvest statistics and session counts\n",
      "  help          Show this help",
    ].join("\n"));
  }

  // ═══════════════════════════════════════════════════════════════
  //  REGISTRATION
  // ═══════════════════════════════════════════════════════════════

  brain.registerCommand("hermes", async function (args) {
    var cmd = (args && args[0]) || "help";
    switch (cmd) {
      case "context":  cmdContext(args.slice(1)); break;
      case "harvest":  await cmdHarvest(); break;
      case "stats":    await cmdStats(); break;
      default:         cmdHelp(); break;
    }
  });

  brain.hook("harvester:poll", async function () {
    var state = await loadState();
    var seen = new Set(state.sessions);
    var result = doHarvest(state.sessions, state.lastId, seen);
    if (!result.items.length) return;

    var emitted = await emitAll(result.items);

    state.lastId = result.maxId;
    state.lastAt = Date.now();
    for (var i = 0; i < result.newSessions.length; i++)
      if (state.sessions.indexOf(result.newSessions[i]) === -1)
        state.sessions.push(result.newSessions[i]);
    state.totalIx += emitted;
    state.totalSes += result.newSessionCount;
    await saveState(state);

    if (emitted > 0)
      console.log("[hermes] Harvested " + emitted + " from " + result.newSessionCount + " new session(s)");
  });

  brain.hook("onInteraction", async function (ctx) {
    if (ctx && ctx.interaction && ctx.interaction.source === SOURCE) {
      var ch = (ctx.interaction.metadata && ctx.interaction.metadata.hermesChannel) || "?";
      console.log("[hermes] Processed " + ch + ": \"" + (ctx.interaction.prompt || "").slice(0, 60) + "...\"");
    }
  });
}
