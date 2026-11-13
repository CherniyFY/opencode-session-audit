# opencode-session-audit

Read-only views of the session database that [opencode](https://opencode.ai) keeps on disk: sessions, tool calls, files written or edited, and shell commands.

## Requirements

- Node.js 22.13 or newer. It uses the built-in `node:sqlite` module.
- An opencode database that has the `session_v2` and `session_message` tables. The tool checks for them on startup.

## Usage

```sh
./opencode-session-audit sessions --limit 20
./opencode-session-audit tools
./opencode-session-audit files --tool write
./opencode-session-audit shell --match 'git push'
./opencode-session-audit query "select count(*) as sessions from session_v2"
```

Pass a session id, or a unique prefix of one, to limit `tools`, `files`, and `shell` to that session:

```sh
./opencode-session-audit tools <session-id-prefix>
```

| Command | Output |
| --- | --- |
| `sessions [--dir DIR] [--limit N]` | Date (UTC), id, directory, title. Newest first. Default limit 50. |
| `tools [SESSION]` | Count and tool name. |
| `files [--tool NAME] [SESSION]` | Count, session title, tool, file path. Default tools: `write`, `edit`. |
| `shell [--match REGEX] [SESSION]` | Session title and command. Default tools: `bash`, `shell`. |
| `query SQL` | Rows from a `SELECT` or `WITH` query as JSON. |

Output is tab-separated with no header, so it works with `cut`, `sort`, and `column -t`.

## Database location

`--db PATH` wins. Otherwise `$OPENCODE_DB`. Otherwise `$XDG_DATA_HOME/opencode/opencode.db`, which is `~/.local/share/opencode/opencode.db` when `XDG_DATA_HOME` is unset.

## Read-only

The database opens read-only with SQLite's `query_only` setting enabled. The
`query` command accepts statements beginning with `SELECT` or `WITH` (after
whitespace and SQL comments). Write statements, `PRAGMA`, `ATTACH`, and `VACUUM`
are rejected; `WITH` statements that try to write also fail. Only the first SQL
statement is executed.

## Privacy

The output can contain anything that appeared in your sessions: pasted text, file contents a tool printed, and any secrets among them. Check it before you share it.

## Schema

opencode's database schema is internal, and it can change between versions. This tool reads the `session_v2` and `session_message` tables and the `tool` parts of assistant messages. It was tested on Linux with Node.js 26, against a database with sessions from opencode versions 1.18.18 through 2.3.0.

## License

MIT. See [LICENSE](LICENSE).
