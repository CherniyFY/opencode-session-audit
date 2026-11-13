"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("node:sqlite");

const Database = sqlite.Database ?? sqlite.DatabaseSync;
const SCRIPT = path.join(__dirname, "..", "opencode-session-audit");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-session-audit-"));
const DB = path.join(dir, "test.db");
const EMPTY = path.join(dir, "empty.db");
const MISSING = path.join(dir, "missing.db");
const COPY = path.join(dir, "copy.db");
const ATTACHED = path.join(dir, "attached.db");
const sqlPath = (file) => `'${file.replaceAll("'", "''")}'`;
let originalBytes;
let secondaryBytes;

function buildFixtures() {
  const empty = new Database(EMPTY);
  empty.exec("create table other (a integer)");
  empty.close();

  const db = new Database(DB);
  db.exec(`
    create table session_v2 (id text primary key, title text, directory text not null, time_created integer not null);
    create table session_message (id text primary key, session_id text not null, type text not null,
      seq integer not null, time_created integer not null, time_updated integer not null, data text not null);
  `);
  const session = db.prepare("insert into session_v2 values (?, ?, ?, ?)");
  session.run("ses_aaa111", "First session", "/work/one", 1700000000000);
  session.run("ses_bbb222", "Second session", "/work/two", 1700000600000);
  const message = db.prepare("insert into session_message values (?, ?, ?, ?, 0, 0, ?)");
  message.run("m1", "ses_aaa111", "assistant", 1, JSON.stringify({
    content: [
      { type: "tool", name: "write", state: { input: { filePath: "/work/one/a.txt" } } },
      { type: "tool", name: "bash", state: { input: { command: "git status\ngit log" } } },
    ],
  }));
  message.run("m2", "ses_bbb222", "assistant", 1, JSON.stringify({
    content: [
      { type: "tool", name: "edit", state: { input: { filePath: "/work/two/b.ts" } } },
      { type: "tool", name: "shell", state: { input: { command: "npm test" } } },
      { type: "text", text: "done" },
    ],
  }));
  message.run("m3", "ses_aaa111", "user", 2, JSON.stringify({ text: "hello" }));
  message.run("m4", "ses_aaa111", "assistant", 3, "not json");
  db.close();
  originalBytes = fs.readFileSync(DB);
  secondaryBytes = fs.readFileSync(EMPTY);
}

function run(args) {
  const result = spawnSync(SCRIPT, args, { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const withDb = (...args) => ["--db", DB, ...args];

const cases = [
  ["sessions", withDb("sessions"), (r) => r.code === 0 && r.out === "2023-11-14 22:23\tses_bbb222\t/work/two\tSecond session\n2023-11-14 22:13\tses_aaa111\t/work/one\tFirst session\n"],
  ["sessions --dir", withDb("sessions", "--dir", "/work/one"), (r) => r.code === 0 && r.out === "2023-11-14 22:13\tses_aaa111\t/work/one\tFirst session\n"],
  ["tools", withDb("tools"), (r) => r.code === 0 && r.out === "1\tbash\n1\tedit\n1\tshell\n1\twrite\n"],
  ["tools one session", withDb("tools", "ses_aaa"), (r) => r.code === 0 && r.out === "1\tbash\n1\twrite\n"],
  ["files", withDb("files"), (r) => r.code === 0 && r.out === "1\tFirst session\twrite\t/work/one/a.txt\n1\tSecond session\tedit\t/work/two/b.ts\n"],
  ["files --tool write", withDb("files", "--tool", "write"), (r) => r.code === 0 && r.out === "1\tFirst session\twrite\t/work/one/a.txt\n"],
  ["shell", withDb("shell"), (r) => r.code === 0 && r.out === "First session\tgit status | git log\nSecond session\tnpm test\n"],
  ["shell --match", withDb("shell", "--match", "npm"), (r) => r.code === 0 && r.out === "Second session\tnpm test\n"],
  ["query", withDb("query", "select count(*) as n from session_message"), (r) => r.code === 0 && r.out.includes('"n": 4')],
  ["query with comments", withDb("query", " \n/* report */ -- count sessions\n select count(*) as n from session_v2"), (r) => r.code === 0 && r.out.includes('"n": 2')],
  ["query with CTE", withDb("query", "WITH counts AS (SELECT count(*) AS n FROM session_v2) SELECT n FROM counts"), (r) => r.code === 0 && r.out.includes('"n": 2')],
  ["query cannot write", withDb("query", "delete from session_v2"), (r) => r.code === 2 && r.err.includes("SELECT or WITH")],
  ["query CTE cannot write", withDb("query", "WITH ids AS (SELECT id FROM session_v2) DELETE FROM session_v2 WHERE id IN (SELECT id FROM ids)"), (r) => r.code === 1 && r.err.includes("readonly")],
  ["VACUUM INTO cannot create output", withDb("query", `VACUUM INTO ${sqlPath(COPY)}`), (r) => r.code === 2 && !fs.existsSync(COPY)],
  ["commented VACUUM cannot create output", withDb("query", `/* export */ -- copy\n VaCuUm INTO ${sqlPath(COPY)}`), (r) => r.code === 2 && !fs.existsSync(COPY)],
  ["ATTACH cannot create a database", withDb("query", `ATTACH DATABASE ${sqlPath(ATTACHED)} AS attached`), (r) => r.code === 2 && !fs.existsSync(ATTACHED)],
  ["commented ATTACH cannot create a database", withDb("query", `-- attach\n/* database */ AtTaCh DATABASE ${sqlPath(ATTACHED)} AS attached`), (r) => r.code === 2 && !fs.existsSync(ATTACHED)],
  ["ATTACH cannot write an existing database", withDb("query", `ATTACH DATABASE ${sqlPath(EMPTY)} AS attached; DROP TABLE attached.other`), (r) => r.code === 2 && fs.readFileSync(EMPTY).equals(secondaryBytes)],
  ["PRAGMA cannot disable query_only", withDb("query", "PRAGMA query_only = OFF"), (r) => r.code === 2 && r.err.includes("SELECT or WITH")],
  ["second statement cannot create output", withDb("query", `SELECT 1 AS n; VACUUM INTO ${sqlPath(COPY)}`), (r) => r.code === 0 && r.out.includes('"n": 1') && !fs.existsSync(COPY)],
  ["second statement cannot attach database", withDb("query", `SELECT 1 AS n; ATTACH DATABASE ${sqlPath(ATTACHED)} AS attached; CREATE TABLE attached.test (n)`), (r) => r.code === 0 && r.out.includes('"n": 1') && !fs.existsSync(ATTACHED)],
  ["rows survive write attempt", withDb("query", "select count(*) as n from session_v2"), (r) => r.code === 0 && r.out.includes('"n": 2')],
  ["ambiguous prefix", withDb("tools", "ses_"), (r) => r.code === 1 && r.err.includes("matches 2 sessions")],
  ["unknown session", withDb("tools", "nope"), (r) => r.code === 1 && r.err.includes("no session starts with nope")],
  ["not an opencode db", ["--db", EMPTY, "tools"], (r) => r.code === 1 && r.err.includes("missing session_v2, session_message")],
  ["missing db", ["--db", MISSING, "tools"], (r) => r.code === 1 && r.err.includes("no database at")],
  ["no command", [], (r) => r.code === 2 && r.err.includes("no command given")],
  ["help", ["--help"], (r) => r.code === 0 && r.out.startsWith("usage:")],
  ["bad regex", withDb("shell", "--match", "("), (r) => r.code === 1 && r.err.includes("Invalid regular expression")],
  ["bad limit", withDb("sessions", "--limit", "0"), (r) => r.code === 2 && r.err.includes("positive integer")],
  ["unknown command", withDb("frobnicate"), (r) => r.code === 2 && r.err.includes("unknown command")],
  ["extra argument", withDb("tools", "a", "b"), (r) => r.code === 2 && r.err.includes("unexpected argument b")],
  ["missing value", withDb("files", "--tool"), (r) => r.code === 2 && r.err.includes("--tool needs a value")],
  ["unknown option", withDb("sessions", "--nope"), (r) => r.code === 2 && r.err.includes("unknown option --nope")],
  ["database bytes unchanged", withDb("query", "SELECT count(*) AS n FROM session_v2"), (r) => r.code === 0 && fs.readFileSync(DB).equals(originalBytes) && fs.readFileSync(EMPTY).equals(secondaryBytes)],
];

try {
  buildFixtures();
  let failed = 0;
  for (const [name, args, check] of cases) {
    const result = run(args);
    const pass = check(result);
    if (!pass) failed += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) console.log(JSON.stringify(result, null, 2));
  }
  console.log(failed === 0 ? `all ${cases.length} passed` : `${failed} of ${cases.length} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
