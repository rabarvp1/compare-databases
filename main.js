const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: "Compare Databases",
    icon: path.join(__dirname, 'super-cashier.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  // Quietly look for a new release; the user decides whether to download it
  if (app.isPackaged) {
    mainWindow.webContents.once('did-finish-load', () => getUpdater().checkForUpdates().catch(() => {}));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- Self update (GitHub releases)

let updater;

// electron-updater errors include whole HTTP responses; turn them into one readable sentence
function friendlyUpdateError(err) {
  const msg = String(err && err.message || err);
  // The packaged package.json has no "build" section; app-update.yml says where updates come from
  let where = 'the releases repo';
  try {
    const yml = require('fs').readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const get = key => (new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(yml) || [])[1];
    if (get('owner') && get('repo')) where = `${get('owner')}/${get('repo')}`;
  } catch {}
  if (/latest\.yml/i.test(msg) && /404/.test(msg)) {
    return 'The newest release has no latest.yml file. Publish releases with "npm run release".';
  }
  if (/\b404\b/.test(msg)) {
    return `No releases found. The public GitHub repo ${where} does not exist yet, or has no published release.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|net::ERR_/.test(msg)) {
    return 'Cannot reach GitHub. Check your internet connection and try again.';
  }
  const first = msg.split('\n')[0];
  return first.length > 200 ? first.slice(0, 200) + '…' : first;
}

function getUpdater() {
  if (updater) return updater;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = false;
  const send = (state, data = {}) => mainWindow?.webContents.send('update-status', { state, ...data });
  updater.on('checking-for-update', () => send('checking'));
  updater.on('update-available', info => send('available', { version: info.version }));
  updater.on('update-not-available', () => send('latest'));
  updater.on('download-progress', p => send('downloading', { percent: Math.round(p.percent) }));
  updater.on('update-downloaded', info => send('ready', { version: info.version }));
  updater.on('error', err => send('error', { message: friendlyUpdateError(err) }));
  return updater;
}

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('update-check', async () => {
  if (!app.isPackaged) return { success: false, error: 'Updates only work in the installed app, not with npm start.' };
  try {
    await getUpdater().checkForUpdates();
    return { success: true };
  } catch (err) {
    return { success: false, error: friendlyUpdateError(err) };
  }
});

ipcMain.handle('update-download', async () => {
  try {
    await getUpdater().downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: friendlyUpdateError(err) };
  }
});

ipcMain.handle('update-install', () => getUpdater().quitAndInstall());

// Groups ordered rows into { table, name, rows } per constraint
function groupConstraints(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.tbl + '\0' + r.name;
    if (!groups.has(key)) groups.set(key, { table: r.tbl, name: r.name, rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------- Canonical forms
// The same definition can be printed in different ways ('0'::numeric vs 0.00000000,
// varchar vs character varying, IN (...) vs = ANY (ARRAY[...])). Comparing canonical
// forms keeps the compare from reporting differences that are not real.

// Numbers as their plain value: 0.00000000 -> 0, 010.50 -> 10.5
function canonNumber(s) {
  let [int, frac = ''] = String(s).replace(/^\+/, '').split('.');
  const neg = int.startsWith('-');
  int = int.replace(/^-/, '').replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  const out = (neg ? '-' : '') + int + (frac ? '.' + frac : '');
  return out === '-0' ? '0' : out;
}

// A cast such as ::text, ::character varying, ::numeric(12,2) or ::text[]
const PG_CAST = /::\s*(?:character varying|double precision|bit varying|(?:timestamp|time)(?:\(\d+\))?\s+with(?:out)?\s+time\s+zone|"[^"]+"|[a-z_][a-z0-9_]*)(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?/gi;

const PG_TYPE_ALIASES = [
  [/^varchar\b/, 'character varying'],
  [/^char\b/, 'character'],
  [/^(int|int4)$/, 'integer'],
  [/^int8$/, 'bigint'],
  [/^int2$/, 'smallint'],
  [/^bool$/, 'boolean'],
  [/^float8$/, 'double precision'],
  [/^float4$/, 'real'],
  [/^decimal\b/, 'numeric'],
  [/^timestamptz$/, 'timestamp with time zone'],
  [/^(timestamp|time)(\(\d+\))?$/, '$1$2 without time zone']
];

function pgCanonType(type) {
  let t = String(type).toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [re, to] of PG_TYPE_ALIASES) t = t.replace(re, to);
  // No precision on timestamp/time means 6
  return t.replace(/^(timestamp|time) (with|without) time zone$/, '$1(6) $2 time zone');
}

// Wraps in parentheses only when they enclose the whole expression
function stripOuterParens(s) {
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0, wraps = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0) { wraps = false; break; }
    }
    if (!wraps) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

// Shared by both engines once the raw default text is known
function canonDefaultText(def) {
  if (def === null || def === undefined) return '';
  const d = stripOuterParens(String(def).trim());
  if (/^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?|transaction_timestamp\(\))$/i.test(d)) return 'NOW';
  const lit = /^'((?:[^']|'')*)'$/.exec(d);
  const value = lit ? lit[1].replace(/''/g, "'") : d;
  if (/^[-+]?\d+(\.\d+)?$/.test(value)) return canonNumber(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase();
  return (lit ? 'S:' : 'E:') + value;
}

function pgCanonDefault(c) {
  // serial (nextval) and identity columns both just mean "auto increment"
  if (c.identity || /^nextval\(/i.test(c.def || '')) return 'AUTO';
  return canonDefaultText(c.def == null ? null : String(c.def).replace(PG_CAST, ''));
}

// CHECK (type IN ('a','b')) and CHECK (((type)::text = ANY ((ARRAY['a'::character varying, ...])::text[])))
// are the same check
function pgCanonCheck(def) {
  return def.replace(PG_CAST, '').replace(/["\s()]/g, '').replace(/=ANYARRAY\[(.*?)\]/g, 'IN$1');
}

// Columns of a foreign key on both sides, from its definition (works for both engines)
function fkParts(fk) {
  const m = /FOREIGN KEY\s*\((.+?)\)\s*REFERENCES\s+(.+?)\s*\((.+?)\)/i.exec(fk.def);
  if (!m) return null;
  const names = s => s.split(',').map(x => x.trim().replace(/^["`]|["`]$/g, ''));
  return { columns: names(m[1]), refTable: names(m[2]).pop(), refColumns: names(m[3]) };
}

// ---------------------------------------------------------------- MySQL

const mysqlDriver = {
  q: n => '`' + String(n).replace(/`/g, '``') + '`',

  async connect(config) {
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password
    });
    const [rows] = await conn.query("SHOW DATABASES");
    return { conn, dbs: rows.map(r => r.Database) };
  },

  async close(session) {
    await session.conn.end();
  },

  async loadSchema(session, db) {
    const q = this.q;
    const [tables] = await session.conn.query(`
      SELECT TABLE_NAME AS name
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `, [db]);
    const [columns] = await session.conn.query(`
      SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
             COLUMN_DEFAULT AS def, EXTRA AS extra, COLLATION_NAME AS collation,
             GENERATION_EXPRESSION AS generation
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `, [db]);
    const [fkRows] = await session.conn.query(`
      SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
             k.REFERENCED_TABLE_NAME AS refTbl, k.REFERENCED_COLUMN_NAME AS refCol,
             r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
      FROM information_schema.KEY_COLUMN_USAGE k
      JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION
    `, [db]);
    const [indexRows] = await session.conn.query(`
      SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col,
             INDEX_TYPE AS type, SUB_PART AS subPart
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
    `, [db]);

    const schema = { db, tables: {}, fks: [] };
    for (const t of tables) schema.tables[t.name] = { columns: [], indexes: [] };
    for (const c of columns) schema.tables[c.tbl]?.columns.push(c);
    for (const ix of groupConstraints(indexRows)) {
      schema.tables[ix.table]?.indexes.push({
        name: ix.name,
        unique: Number(ix.rows[0].nonUnique) === 0,
        type: ix.rows[0].type,
        columns: ix.rows.map(r => r.col),
        subParts: ix.rows.map(r => r.subPart)
      });
    }
    schema.fks = groupConstraints(fkRows).map(fk => {
      const r = fk.rows[0];
      return {
        table: fk.table,
        name: fk.name,
        columns: fk.rows.map(r => r.col),
        refTable: r.refTbl,
        refColumns: fk.rows.map(r => r.refCol),
        onDelete: r.onDelete,
        onUpdate: r.onUpdate,
        def: `FOREIGN KEY (${fk.rows.map(r => q(r.col)).join(', ')}) ` +
             `REFERENCES ${q(r.refTbl)} (${fk.rows.map(r => q(r.refCol)).join(', ')}) ` +
             `ON DELETE ${r.onDelete} ON UPDATE ${r.onUpdate}`
      };
    });
    return schema;
  },

  columnSql(c) {
    // information_schema returns expressions with quotes escaped as \'
    const unescape = expr => expr.replace(/\\'/g, "'");
    let sql = `${this.q(c.name)} ${c.type}`;
    if (c.collation) sql += ` COLLATE ${c.collation}`;

    const generated = /(VIRTUAL|STORED) GENERATED/i.exec(c.extra || '');
    if (generated) {
      sql += ` GENERATED ALWAYS AS (${unescape(c.generation)}) ${generated[1].toUpperCase()}`;
      return sql + (c.nullable === 'NO' ? ' NOT NULL' : ' NULL');
    }

    sql += c.nullable === 'NO' ? ' NOT NULL' : ' NULL';
    if (c.def !== null) sql += ` DEFAULT ${this.defaultSql(c)}`;
    const extra = (c.extra || '').replace(/DEFAULT_GENERATED/i, '').trim();
    if (extra) sql += ' ' + extra.toUpperCase();
    return sql;
  },

  // The DEFAULT value of a column as SQL
  defaultSql(c) {
    if (/^current_timestamp/i.test(c.def) || /^b'[01]*'$/.test(c.def)) return c.def;
    if (/DEFAULT_GENERATED/i.test(c.extra || '')) return `(${c.def.replace(/\\'/g, "'")})`;
    return `'${c.def.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  },

  // Everything about a column that matters when comparing; display widths like int(11) are ignored
  columnSig(c) {
    const type = c.type.toLowerCase().replace(/^integer\b/, 'int')
      .replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/, (m, base) => (m === 'tinyint(1)' ? m : base));
    const extra = (c.extra || '').toLowerCase().replace('default_generated', '').replace(/\s+/g, ' ').trim();
    return [type, c.nullable, canonDefaultText(c.def), extra, c.generation || ''].join('|');
  },

  alterColumn(table, s) {
    const out = [];
    // Rows with NULL would block NOT NULL, so give them the default first
    if (s.nullable === 'NO' && s.def !== null && !/GENERATED/i.test(s.extra || '')) {
      out.push(`UPDATE ${this.q(table)} SET ${this.q(s.name)} = ${this.defaultSql(s)} WHERE ${this.q(s.name)} IS NULL;`);
    }
    out.push(`ALTER TABLE ${this.q(table)} MODIFY COLUMN ${this.columnSql(s)};`);
    return out;
  },

  // Indexes of one table in canonical form; the primary key is left alone
  indexItems(table, t) {
    return (t.indexes || []).filter(ix => ix.name !== 'PRIMARY').map(ix => {
      const kind = ix.type === 'FULLTEXT' ? 'FULLTEXT ' : ix.type === 'SPATIAL' ? 'SPATIAL ' : ix.unique ? 'UNIQUE ' : '';
      const part = i => (ix.subParts?.[i] ? `(${ix.subParts[i]})` : '');
      return {
        name: ix.name,
        columns: ix.columns,
        canon: kind + '(' + ix.columns.map((c, i) => c + part(i)).join(',') + ')',
        add: `ALTER TABLE ${this.q(table)} ADD ${kind}INDEX ${this.q(ix.name)} (${ix.columns.map((c, i) => this.q(c) + part(i)).join(', ')});`,
        drop: `ALTER TABLE ${this.q(table)} DROP INDEX ${this.q(ix.name)};`
      };
    });
  },

  // MySQL refuses to drop the only index a foreign key uses
  needsIndexForFks: true,

  // Foreign keys are stripped here and added later, so table order does not matter
  async createTable(session, schema, table) {
    const [rows] = await session.conn.query(`SHOW CREATE TABLE ${this.q(schema.db)}.${this.q(table)}`);
    const lines = rows[0]['Create Table']
      .split('\n')
      .filter(l => !/^\s*CONSTRAINT\s+`(?:[^`]|``)+`\s+FOREIGN KEY/i.test(l));
    const end = lines.findIndex(l => l.startsWith(')'));
    lines[end - 1] = lines[end - 1].replace(/,\s*$/, '');
    return lines.join('\n').replace(/ AUTO_INCREMENT=\d+/, '') + ';';
  },

  addColumn(schema, table, column, after) {
    const position = after ? ` AFTER ${this.q(after)}` : ' FIRST';
    return `ALTER TABLE ${this.q(table)} ADD COLUMN ${this.columnSql(column)}${position};`;
  },

  dropColumn(table, column) {
    return `ALTER TABLE ${this.q(table)} DROP COLUMN ${this.q(column)};`;
  },

  dropTable(table) {
    return `DROP TABLE ${this.q(table)};`;
  },

  addForeignKey(fk) {
    return `ALTER TABLE ${this.q(fk.table)} ADD CONSTRAINT ${this.q(fk.name)} ${fk.def};`;
  },

  dropForeignKey(fk) {
    return `ALTER TABLE ${this.q(fk.table)} DROP FOREIGN KEY ${this.q(fk.name)};`;
  }
};

// ---------------------------------------------------------------- PostgreSQL

// USING expression for ALTER COLUMN ... TYPE; 0/1 numbers and booleans need explicit rules
function pgUsing(col, from, to, toSpelled) {
  const isNumber = t => /^(smallint|integer|bigint|numeric)/.test(t);
  if (to === 'boolean' && isNumber(from)) return `(${col} <> 0)`;
  if (from === 'boolean' && isNumber(to)) return `(${col})::integer::${toSpelled}`;
  return `${col}::${toSpelled}`;
}

const postgresDriver = {
  q: n => '"' + String(n).replace(/"/g, '""') + '"',

  async open(config, database) {
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database
    });
    await client.connect();
    return client;
  },

  async connect(config) {
    const client = await this.open(config, config.database || 'postgres');
    try {
      const res = await client.query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname");
      return { dbs: res.rows.map(r => r.datname) };
    } finally {
      await client.end();
    }
  },

  async close() {},

  // Postgres cannot query across databases, so each side gets its own client
  async loadSchema(session, db) {
    const ns = session.config.schema || 'public';
    const client = await this.open(session.config, db);
    try {
      // Makes pg_get_* output unqualified names, matching the script's search_path
      await client.query(`SET search_path TO ${this.q(ns)}`);
      const tables = await client.query(`
        SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname
      `, [ns]);
      // to_jsonb() keeps this working on servers without attidentity/attgenerated
      const columns = await client.query(`
        SELECT c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
               a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def,
               to_jsonb(a) ->> 'attidentity' AS identity, to_jsonb(a) ->> 'attgenerated' AS generated
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum
      `, [ns]);
      const constraints = await client.query(`
        SELECT c.relname AS tbl, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND con.contype IN ('p', 'u', 'c', 'x', 'f')
        ORDER BY c.relname, con.contype <> 'p', con.conname
      `, [ns]);
      const indexes = await client.query(`
        SELECT t.relname AS tbl, pg_get_indexdef(ix.indexrelid) AS def
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND NOT EXISTS (
          SELECT 1 FROM pg_constraint con
          WHERE con.conindid = ix.indexrelid AND con.contype IN ('p', 'u', 'x')
        )
        ORDER BY i.relname
      `, [ns]);
      const enums = await client.query(`
        SELECT t.typname AS name, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1
        GROUP BY t.typname
        ORDER BY t.typname
      `, [ns]);

      const schema = { db, tables: {}, fks: [], enums: enums.rows };
      for (const t of tables.rows) schema.tables[t.name] = { columns: [], constraints: [], indexes: [] };
      for (const c of columns.rows) schema.tables[c.tbl]?.columns.push(c);
      for (const i of indexes.rows) schema.tables[i.tbl]?.indexes.push(i.def);
      for (const con of constraints.rows) {
        if (!schema.tables[con.tbl]) continue;
        if (con.type === 'f') schema.fks.push({ table: con.tbl, name: con.name, def: con.def });
        else schema.tables[con.tbl].constraints.push(con);
      }
      return schema;
    } finally {
      await client.end();
    }
  },

  columnSql(c) {
    let sql = `${this.q(c.name)} ${c.type}`;
    if (c.identity === 'a') sql += ' GENERATED ALWAYS AS IDENTITY';
    else if (c.identity === 'd') sql += ' GENERATED BY DEFAULT AS IDENTITY';
    else if (c.generated === 's') sql += ` GENERATED ALWAYS AS (${c.def}) STORED`;
    else if (c.generated === 'v') sql += ` GENERATED ALWAYS AS (${c.def}) VIRTUAL`;
    else if (c.def !== null) sql += ` DEFAULT ${c.def}`;
    if (c.notnull) sql += ' NOT NULL';
    return sql;
  },

  // serial columns default to nextval('seq'), and that sequence must exist first
  sequenceOf(c) {
    const m = c.generated ? null : /^nextval\('(.+)'::regclass\)$/.exec(c.def || '');
    return m ? m[1].replace(/''/g, "'") : null;
  },

  wrapSequence(table, column, statements) {
    const seq = this.sequenceOf(column);
    if (!seq) return statements;
    return [
      `CREATE SEQUENCE IF NOT EXISTS ${seq};`,
      ...statements,
      `ALTER SEQUENCE ${seq} OWNED BY ${this.q(table)}.${this.q(column.name)};`
    ];
  },

  // Conversion warnings (set by mysqlToPostgres) become comments above the statement
  notesSql(notes) {
    return (notes || []).map(n => `-- NOTE: ${n}\n`).join('');
  },

  // Foreign keys are left out here and added later, so table order does not matter
  async createTable(session, schema, table) {
    const t = schema.tables[table];
    const lines = [
      ...t.columns.map(c => '  ' + this.columnSql(c)),
      ...t.constraints.map(con => `  CONSTRAINT ${this.q(con.name)} ${con.def}`)
    ];
    const notes = [...(t.notes || []), ...t.columns.flatMap(c => c.notes || [])];
    let statements = [this.notesSql(notes) + `CREATE TABLE ${this.q(table)} (\n${lines.join(',\n')}\n);`];
    for (const c of t.columns) statements = this.wrapSequence(table, c, statements);
    statements.push(...t.indexes.map(def => def + ';'));
    return statements.join('\n\n');
  },

  // Checks and unique keys for the new column are added by the index/constraint step
  addColumn(schema, table, column) {
    return this.wrapSequence(table, column, [
      this.notesSql(column.notes) + `ALTER TABLE ${this.q(table)} ADD COLUMN ${this.columnSql(column)};`
    ]).join('\n\n');
  },

  columnSig(c) {
    const def = c.generated ? 'G:' + String(c.def).replace(/\s+/g, '') : pgCanonDefault(c);
    return [pgCanonType(c.type), c.notnull ? 'NOT NULL' : 'NULL', def].join('|');
  },

  // Turns column t (target) into column s (source). Order matters: identity off before
  // NOT NULL can be dropped, old default off before the type changes, NOT NULL before
  // identity can be added.
  alterColumn(table, s, t) {
    const q = this.q;
    const col = `ALTER TABLE ${q(table)} ALTER COLUMN ${q(s.name)}`;
    if (s.generated || t.generated) {
      return [`-- NOTE: ${table}.${s.name} is a generated column with a different definition; change it by hand.`];
    }
    const out = [];
    const sType = pgCanonType(s.type), tType = pgCanonType(t.type);
    const sDef = pgCanonDefault(s), tDef = pgCanonDefault(t);
    let targetDefault = tDef;

    if (tDef === 'AUTO' && sDef !== 'AUTO') {
      out.push(t.identity ? `${col} DROP IDENTITY IF EXISTS;` : `${col} DROP DEFAULT;`);
      targetDefault = '';
    }
    if (sType !== tType) {
      if (targetDefault && targetDefault !== 'AUTO') {
        out.push(`${col} DROP DEFAULT;`);
        targetDefault = '';
      }
      out.push(`${col} TYPE ${s.type} USING ${pgUsing(q(s.name), tType, sType, s.type)};`);
    }
    if (s.notnull && !t.notnull) {
      if (s.def != null && sDef !== 'AUTO') {
        out.push(`UPDATE ${q(table)} SET ${q(s.name)} = ${s.def} WHERE ${q(s.name)} IS NULL;`);
      }
      out.push(`${col} SET NOT NULL;`);
    } else if (!s.notnull && t.notnull) {
      out.push(`${col} DROP NOT NULL;`);
    }
    if (sDef === 'AUTO' && targetDefault !== 'AUTO') {
      if (targetDefault) out.push(`${col} DROP DEFAULT;`);
      const tableLit = `'${q(table).replace(/'/g, "''")}'`;
      out.push(`${col} ADD GENERATED BY DEFAULT AS IDENTITY;`);
      out.push(`SELECT setval(pg_get_serial_sequence(${tableLit}, '${s.name.replace(/'/g, "''")}'), ` +
               `COALESCE((SELECT MAX(${q(s.name)}) FROM ${q(table)}), 0) + 1, false);`);
    } else if (sDef !== 'AUTO' && sDef !== targetDefault) {
      out.push(s.def != null ? `${col} SET DEFAULT ${s.def};` : `${col} DROP DEFAULT;`);
    }
    return out;
  },

  // Unique keys, checks and plain indexes of one table in canonical form. A unique
  // constraint and a unique index on the same columns count as the same thing.
  indexItems(table, t) {
    const q = this.q;
    const items = [];
    for (const con of t.constraints || []) {
      if (con.type !== 'u' && con.type !== 'c') continue;
      items.push({
        name: con.name,
        canon: con.type === 'u' ? 'U:' + con.def.replace(/^UNIQUE\s*/i, '').replace(/["\s]/g, '') : 'C:' + pgCanonCheck(con.def),
        add: `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(con.name)} ${con.def};`,
        drop: `ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(con.name)};`
      });
    }
    for (const def of t.indexes || []) {
      const m = /^CREATE (UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?("(?:[^"]|"")+"|\S+) ON (?:ONLY )?(?:"(?:[^"]|"")+"|\S+)\s*(.*)$/i.exec(def);
      if (!m) continue;
      const rest = m[3].replace(/^USING btree\s*/i, '').replace(/["\s]/g, '');
      items.push({
        name: m[2].replace(/^"|"$/g, '').replace(/""/g, '"'),
        canon: (m[1] ? 'U:' : 'I:') + rest,
        add: def + ';',
        drop: `DROP INDEX ${m[2]};`
      });
    }
    return items;
  },

  dropColumn(table, column) {
    return `ALTER TABLE ${this.q(table)} DROP COLUMN ${this.q(column)};`;
  },

  dropTable(table) {
    return `DROP TABLE ${this.q(table)};`;
  },

  addForeignKey(fk) {
    return `ALTER TABLE ${this.q(fk.table)} ADD CONSTRAINT ${this.q(fk.name)} ${fk.def};`;
  },

  dropForeignKey(fk) {
    return `ALTER TABLE ${this.q(fk.table)} DROP CONSTRAINT ${this.q(fk.name)};`;
  },

  createTypes(src, tgt) {
    const existing = new Set(tgt.enums.map(e => e.name));
    return src.enums
      .filter(e => !existing.has(e.name))
      .map(e => `CREATE TYPE ${this.q(e.name)} AS ENUM (${e.labels});`);
  },

  // DDL is transactional in Postgres, so the whole script applies or nothing does
  wrap(session, sql) {
    return `BEGIN;\n\nSET LOCAL search_path TO ${this.q(session.config.schema || 'public')};\n\n${sql}\n\nCOMMIT;`;
  }
};

// ---------------------------------------------------------------- MySQL -> PostgreSQL

const PG_MAX_NAME = 63;

// Rewrites a schema from mysqlDriver.loadSchema into the shape postgresDriver.loadSchema
// returns, so a MySQL source can be compared against (and created in) a PostgreSQL target
function mysqlToPostgres(schema) {
  const q = postgresDriver.q;
  const pgName = n => n.slice(0, PG_MAX_NAME);
  const cols = list => list.map(q).join(', ');
  const out = { db: schema.db, tables: {}, fks: [], enums: [] };

  // MySQL index names are per table, PostgreSQL ones are per schema
  const nameUse = {};
  for (const t of Object.values(schema.tables)) {
    for (const ix of t.indexes) nameUse[ix.name] = (nameUse[ix.name] || 0) + 1;
  }
  const indexName = (table, name) =>
    pgName(nameUse[name] > 1 || schema.tables[name] ? `${table}_${name}` : name);

  for (const [table, t] of Object.entries(schema.tables)) {
    const pt = { columns: [], constraints: [], indexes: [], notes: [] };
    out.tables[table] = pt;

    for (const c of t.columns) {
      const { column, check } = convertMysqlColumn(table, c);
      pt.columns.push(column);
      if (check) pt.constraints.push(check);
    }

    for (const ix of t.indexes) {
      if (ix.name === 'PRIMARY') {
        pt.constraints.unshift({ name: pgName(`${table}_pkey`), type: 'p', def: `PRIMARY KEY (${cols(ix.columns)})` });
      } else if (ix.type === 'FULLTEXT' || ix.type === 'SPATIAL') {
        pt.notes.push(`${ix.type} index ${ix.name} on ${table} was skipped; create it by hand (e.g. a GIN/GiST index).`);
      } else if (ix.unique) {
        pt.constraints.push({ name: indexName(table, ix.name), type: 'u', def: `UNIQUE (${cols(ix.columns)})` });
      } else {
        pt.indexes.push(`CREATE INDEX ${q(indexName(table, ix.name))} ON ${q(table)} (${cols(ix.columns)})`);
      }
    }
  }

  // NO ACTION is the default and pg_get_constraintdef() leaves it out, so we do too
  out.fks = schema.fks.map(fk => ({
    table: fk.table,
    name: pgName(fk.name),
    def: `FOREIGN KEY (${cols(fk.columns)}) REFERENCES ${q(fk.refTable)}(${cols(fk.refColumns)})` +
         (fk.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${fk.onUpdate}` : '') +
         (fk.onDelete !== 'NO ACTION' ? ` ON DELETE ${fk.onDelete}` : '')
  }));
  return out;
}

function convertMysqlColumn(table, c) {
  const [, rawBase, args, unsigned] = /^(\w+)(?:\((.*)\))?\s*(unsigned)?/i.exec(c.type);
  const base = rawBase.toLowerCase();
  const notes = [];
  const column = { name: c.name, notnull: c.nullable === 'NO', def: null, identity: '', generated: '', notes };
  let check = null;
  let kind = 'string';

  // tinyint(1) stays a 0/1 number (smallint), not boolean: apps written for MySQL compare
  // these columns with 0/1, and boolean = integer is an error in PostgreSQL
  if (base === 'bit' && args === '1') { column.type = 'boolean'; kind = 'bool'; }
  else if (base === 'tinyint') { column.type = 'smallint'; kind = 'number'; }
  else if (base === 'smallint') { column.type = unsigned ? 'integer' : 'smallint'; kind = 'number'; }
  else if (base === 'mediumint') { column.type = 'integer'; kind = 'number'; }
  else if (base === 'int' || base === 'integer') { column.type = unsigned ? 'bigint' : 'integer'; kind = 'number'; }
  else if (base === 'bigint') { column.type = 'bigint'; kind = 'number'; }
  else if (['decimal', 'numeric', 'dec', 'fixed'].includes(base)) { column.type = args ? `numeric(${args})` : 'numeric'; kind = 'number'; }
  else if (base === 'float') { column.type = 'real'; kind = 'number'; }
  else if (base === 'double' || base === 'real') { column.type = 'double precision'; kind = 'number'; }
  else if (base === 'year') { column.type = 'smallint'; kind = 'number'; }
  else if (base === 'bit') { column.type = `bit(${args || 1})`; kind = 'bit'; }
  // Type names are spelled the way PostgreSQL prints them, so compares match exactly
  else if (base === 'char') column.type = `character(${args || 1})`;
  else if (base === 'varchar') column.type = `character varying(${args})`;
  else if (/text$/.test(base) || base === 'set') column.type = 'text';
  else if (/blob$/.test(base) || base === 'binary' || base === 'varbinary') { column.type = 'bytea'; kind = 'binary'; }
  else if (base === 'date') { column.type = 'date'; kind = 'date'; }
  else if (base === 'datetime' || base === 'timestamp') { column.type = `timestamp(${args || 0}) without time zone`; kind = 'date'; }
  else if (base === 'time') { column.type = `time(${args || 0}) without time zone`; kind = 'date'; }
  else if (base === 'json') column.type = 'json';
  else if (base === 'enum') {
    // Same approach Laravel uses on PostgreSQL: varchar + CHECK constraint
    column.type = 'character varying(255)';
    check = { name: `${table}_${c.name}`.slice(0, PG_MAX_NAME - 6) + '_check', type: 'c', column: c.name,
              def: `CHECK (${postgresDriver.q(c.name)} IN (${args}))` };
  } else {
    column.type = 'text';
    notes.push(`${table}.${c.name}: MySQL type ${c.type} has no direct PostgreSQL match, used text.`);
  }

  const extra = c.extra || '';
  if (/auto_increment/i.test(extra)) column.identity = 'd';
  if (/on update current_timestamp/i.test(extra)) {
    notes.push(`${table}.${c.name}: ON UPDATE CURRENT_TIMESTAMP does not exist in PostgreSQL; set it in the app or with a trigger.`);
  }
  if (/GENERATED/i.test(extra.replace(/DEFAULT_GENERATED/i, ''))) {
    notes.push(`${table}.${c.name}: generated column (${c.generation.replace(/\\'/g, "'")}) was created as a normal column.`);
    return { column, check };
  }

  if (c.def === null) return { column, check };
  if (/^current_timestamp/i.test(c.def)) column.def = 'CURRENT_TIMESTAMP';
  else if (/DEFAULT_GENERATED/i.test(extra)) {
    notes.push(`${table}.${c.name}: default expression (${c.def.replace(/\\'/g, "'")}) was not converted.`);
  } else if (kind === 'bool') column.def = /^(0|b'0*')$/.test(c.def) ? 'false' : 'true';
  else if (kind === 'bit') column.def = c.def.replace(/^b/, 'B');
  else if (kind === 'number' && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(c.def)) column.def = c.def;
  else if (kind === 'date' && /^0000-00-00/.test(c.def)) {
    notes.push(`${table}.${c.name}: zero date default '${c.def}' is invalid in PostgreSQL and was dropped.`);
  } else if (kind === 'binary') {
    notes.push(`${table}.${c.name}: binary default was not converted.`);
  } else column.def = `'${c.def.replace(/'/g, "''")}'`;
  return { column, check };
}

const drivers = { mysql: mysqlDriver, postgres: postgresDriver };

// The source and target each have their own server connection
const sessions = {};

ipcMain.handle('connect-db', async (event, { side, ...config }) => {
  try {
    const old = sessions[side];
    delete sessions[side];
    if (old) await old.driver.close(old).catch(() => {});
    const driver = drivers[config.type];
    const { conn, dbs } = await driver.connect(config);
    sessions[side] = { driver, config, conn };
    return { success: true, dbs };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function requireSessions() {
  const srcSession = sessions.source;
  const tgtSession = sessions.target;
  if (!srcSession || !tgtSession) throw new Error('Connect both source and target servers first.');
  return { srcSession, tgtSession };
}

ipcMain.handle('compare-db', async (event, { source, target }) => {
  try {
    const { srcSession, tgtSession } = requireSessions();
    const srcType = srcSession.config.type;
    const tgtType = tgtSession.config.type;
    if (srcType !== tgtType && !(srcType === 'mysql' && tgtType === 'postgres')) {
      throw new Error('Only MySQL → PostgreSQL conversion is supported between different engines.');
    }

    // Everything is generated in the target's dialect
    const d = tgtSession.driver;
    let src = await srcSession.driver.loadSchema(srcSession, source);
    const tgt = await d.loadSchema(tgtSession, target);
    if (srcType !== tgtType) src = mysqlToPostgres(src);
    return { success: true, sql: await buildSyncSql(d, srcSession, tgtSession, src, tgt) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Statements are ordered so every one of them runs against objects in the right state:
// drop stale FKs -> drop stale indexes/checks -> create types/tables -> add columns ->
// change columns -> add indexes/checks -> add FKs -> drop columns -> drop tables
async function buildSyncSql(d, srcSession, tgtSession, src, tgt) {
  const sections = [];
  const section = (title, statements) => {
    if (statements.length) sections.push(`-- ${title}\n\n${statements.join('\n\n')}`);
  };
  const sharedTables = Object.keys(src.tables).filter(t => tgt.tables[t]);

  // Columns whose definition changed, as "table.column"
  const changedCols = new Set();
  const alterCols = [];
  for (const t of sharedTables) {
    const tgtCols = new Map(tgt.tables[t].columns.map(c => [c.name, c]));
    for (const s of src.tables[t].columns) {
      const c = tgtCols.get(s.name);
      if (!c || d.columnSig(s) === d.columnSig(c)) continue;
      changedCols.add(`${t}.${s.name}`);
      alterCols.push(...d.alterColumn(t, s, c));
    }
  }

  // Quoting and spacing differ between how we write a definition and how the server prints it.
  // A key that touches a changed column is dropped and re-added around the change,
  // because MySQL refuses to change the type of a column inside a foreign key.
  const touchesChanged = fk => {
    const p = fkParts(fk);
    return p && (p.columns.some(c => changedCols.has(`${fk.table}.${c}`)) ||
                 p.refColumns.some(c => changedCols.has(`${p.refTable}.${c}`)));
  };
  const fkSig = fk => `${fk.table}\0${fk.name}\0${fk.def.replace(/[\s"`]/g, '')}`;
  const srcFks = new Set(src.fks.map(fkSig));
  const keptFks = tgt.fks.filter(fk => srcFks.has(fkSig(fk)) && !touchesChanged(fk));
  const keptSigs = new Set(keptFks.map(fkSig));

  section('Drop foreign keys that are missing, different or on changed columns',
    tgt.fks.filter(fk => !keptSigs.has(fkSig(fk))).map(fk => d.dropForeignKey(fk)));

  // Unique keys, checks and indexes on tables both sides have
  const dropIdx = [], addIdx = [];
  for (const t of sharedTables) {
    const want = d.indexItems(t, src.tables[t]);
    const have = d.indexItems(t, tgt.tables[t]);
    const wantCanon = new Set(want.map(i => i.canon));
    const haveCanon = new Set(have.map(i => i.canon));
    const dropping = have.filter(i => !wantCanon.has(i.canon));
    for (const ix of dropping) {
      // An index a remaining foreign key still needs can't go (MySQL); one with the same
      // columns is usually created right after anyway
      if (d.needsIndexForFks) {
        const others = have.filter(o => o !== ix && !dropping.includes(o));
        const needed = keptFks.filter(fk => fk.table === t).some(fk => {
          const cols = fkParts(fk)?.columns || [];
          const covers = i => cols.every((c, n) => i.columns?.[n] === c);
          return covers(ix) && !others.some(covers);
        });
        if (needed) continue;
      }
      dropIdx.push(ix.drop);
    }
    addIdx.push(...want.filter(i => !haveCanon.has(i.canon)).map(i => i.add));
  }
  section('Drop indexes and constraints that are missing or different in source', dropIdx);

  if (d.createTypes) section('Create missing types', d.createTypes(src, tgt));

  const creates = [];
  for (const t of Object.keys(src.tables)) {
    if (!tgt.tables[t]) creates.push(await d.createTable(srcSession, src, t));
  }
  section('Create missing tables', creates);

  const addCols = [];
  for (const t of sharedTables) {
    const existing = new Set(tgt.tables[t].columns.map(c => c.name));
    src.tables[t].columns.forEach((c, i, cols) => {
      if (!existing.has(c.name)) addCols.push(d.addColumn(src, t, c, i ? cols[i - 1].name : null));
    });
  }
  section('Add missing columns', addCols);

  section('Change columns (type, default, NULL / NOT NULL, auto increment)', alterCols);

  section('Add missing indexes and constraints', addIdx);

  section('Add foreign keys',
    src.fks.filter(fk => !keptSigs.has(fkSig(fk))).map(fk => d.addForeignKey(fk)));

  const dropCols = [];
  for (const t of sharedTables) {
    const wanted = new Set(src.tables[t].columns.map(c => c.name));
    for (const c of tgt.tables[t].columns) {
      if (!wanted.has(c.name)) dropCols.push(d.dropColumn(t, c.name));
    }
  }
  section('Drop extra columns', dropCols);

  section('Drop extra tables',
    Object.keys(tgt.tables).filter(t => !src.tables[t]).map(t => d.dropTable(t)));

  let sql = sections.join('\n\n');
  if (sql && d.wrap) sql = d.wrap(tgtSession, sql);
  return sql;
}

// Runs a generated sync script on the target database
ipcMain.handle('run-sql', async (event, { target, sql }) => {
  let conn;
  try {
    const { tgtSession } = requireSessions();
    const cfg = tgtSession.config;
    if (cfg.type === 'postgres') {
      conn = await postgresDriver.open(cfg, target);
      try {
        // The script carries its own BEGIN/COMMIT, so it applies completely or not at all
        await conn.query(sql);
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } else {
      conn = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        database: target, multipleStatements: true
      });
      await conn.query(sql);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
});

// ---------------------------------------------------------------- MySQL -> new PostgreSQL database

const EMPTY_SCHEMA = { tables: {}, fks: [], enums: [] };
const LARAVEL_MIGRATIONS = 'migrations';

// Table a foreign key points at, from a definition like
// FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
function referencedTable(fk) {
  const m = /REFERENCES\s+(?:("(?:[^"]|"")+"|[^\s(]+)\.)?("(?:[^"]|"")+"|[^\s(]+)\s*\(/.exec(fk.def);
  return m ? m[2].replace(/^"|"$/g, '').replace(/""/g, '"') : null;
}

async function loadConvertedSchema(source) {
  const { srcSession, tgtSession } = requireSessions();
  if (srcSession.config.type !== 'mysql' || tgtSession.config.type !== 'postgres') {
    throw new Error('Connect a MySQL source server and a PostgreSQL target server first.');
  }
  const src = mysqlToPostgres(await mysqlDriver.loadSchema(srcSession, source));
  return { srcSession, tgtSession, src };
}

ipcMain.handle('convert-preview', async (event, { source }) => {
  try {
    const { srcSession, tgtSession, src } = await loadConvertedSchema(source);
    return { success: true, sql: await buildSyncSql(postgresDriver, srcSession, tgtSession, src, EMPTY_SCHEMA) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Puts a MySQL database into PostgreSQL. For a new database: tables first, then the data,
// then foreign keys (so rows can be copied in any table order), then identity counters.
// With `existing`, the PostgreSQL structure is kept and its data is replaced: tables that are
// also in MySQL are emptied and refilled, tables only in MySQL are created, and foreign keys
// are dropped during the copy and put back afterwards.
// Everything runs in one transaction, so a failure leaves the target as it was.
ipcMain.handle('convert-create', async (event, { source, newDb, existing, copyData }) => {
  const progress = msg => event.sender.send('convert-progress', msg);
  const q = postgresDriver.q;
  let admin, client, created = false;
  try {
    if (!newDb) throw new Error(existing ? 'Choose a PostgreSQL database.' : 'Enter a name for the new PostgreSQL database.');
    const { srcSession, tgtSession, src } = await loadConvertedSchema(source);
    const cfg = tgtSession.config;
    const ns = cfg.schema || 'public';
    const warnings = [];

    admin = await postgresDriver.open(cfg, cfg.database || 'postgres');
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [newDb]);
    if (existing && !exists.rowCount) throw new Error(`Database "${newDb}" does not exist.`);
    if (!existing) {
      if (exists.rowCount) throw new Error(`Database "${newDb}" already exists. Pick a new name, or choose "Existing".`);
      progress(`Creating database ${newDb}...`);
      await admin.query(`CREATE DATABASE ${q(newDb)}`);
      created = true;
    }

    // The target's own structure decides which columns get filled and how values are converted
    const tgt = existing ? await postgresDriver.loadSchema(tgtSession, newDb) : EMPTY_SCHEMA;
    const newTables = Object.keys(src.tables).filter(t => !tgt.tables[t]);
    // Laravel's migration history must keep matching the PostgreSQL structure,
    // or "artisan migrate" would try to re-run PostgreSQL-only migrations
    const kept = existing && tgt.tables[LARAVEL_MIGRATIONS] ? [LARAVEL_MIGRATIONS] : [];
    if (kept.length) warnings.push(`Kept PostgreSQL's own "${LARAVEL_MIGRATIONS}" table, so Laravel's migration history still matches this database.`);
    const replaced = Object.keys(src.tables).filter(t => tgt.tables[t] && !kept.includes(t));

    // PostgreSQL-only tables whose rows point (directly or through each other) at replaced
    // tables would point at rows that no longer exist, so they are emptied as well
    const emptied = new Set(replaced);
    const dependents = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const fk of tgt.fks) {
        if (emptied.has(fk.table) || src.tables[fk.table] || !emptied.has(referencedTable(fk))) continue;
        emptied.add(fk.table);
        dependents.push(fk.table);
        grew = true;
      }
    }
    if (copyData && dependents.length) {
      warnings.push(`Only in PostgreSQL, emptied because their rows pointed at replaced data: ${dependents.join(', ')}`);
    }
    const untouched = Object.keys(tgt.tables).filter(t => !src.tables[t] && !emptied.has(t));
    if (untouched.length) warnings.push(`Only in PostgreSQL, left as they were: ${untouched.join(', ')}`);

    client = await postgresDriver.open(cfg, newDb);
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${q(ns)}`);
    await client.query(`SET LOCAL search_path TO ${q(ns)}`);

    progress('Creating tables...');
    for (const t of newTables) await client.query(await postgresDriver.createTable(srcSession, src, t));

    if (existing) {
      progress('Removing old foreign keys and data...');
      for (const fk of tgt.fks) await client.query(postgresDriver.dropForeignKey(fk));
      if (copyData && emptied.size) await client.query(`TRUNCATE ${[...emptied].map(q).join(', ')}`);
    }

    // [table, columns to fill]; for existing tables, only the columns both sides have
    const fills = newTables.map(t => [t, src.tables[t].columns]);
    for (const t of replaced) {
      const mysqlCols = new Set(src.tables[t].columns.map(c => c.name));
      const pgCols = tgt.tables[t].columns.filter(c => !c.generated);
      const missing = [...mysqlCols].filter(c => !pgCols.some(p => p.name === c));
      if (missing.length) warnings.push(`${t}: MySQL column(s) ${missing.join(', ')} do not exist in PostgreSQL and were not copied.`);
      fills.push([t, pgCols.filter(c => mysqlCols.has(c.name))]);
    }

    if (copyData) {
      for (const [t, cols] of fills) {
        const count = await copyTable(srcSession, source, client, t, cols, warnings, progress);
        progress(`Copied ${count} rows into ${t}`);
      }
      // Rows were inserted with explicit ids, so move each id counter past them
      for (const [t, cols] of fills) {
        for (const c of cols) {
          const seq = (await client.query('SELECT pg_get_serial_sequence($1, $2) AS seq', [q(t), c.name])).rows[0].seq;
          if (seq) {
            await client.query(`SELECT setval($1, COALESCE((SELECT MAX(${q(c.name)}) FROM ${q(t)}), 0) + 1, false)`, [seq]);
          }
        }
      }
    }

    // The target's own foreign keys must come back; if the data breaks one, everything rolls back
    progress('Adding foreign keys...');
    for (const fk of tgt.fks) {
      try {
        await client.query(postgresDriver.addForeignKey(fk));
      } catch (err) {
        throw new Error(`The MySQL data does not satisfy foreign key ${fk.name} on ${fk.table}: ${err.message}`);
      }
    }
    // New tables get MySQL's keys; a savepoint lets one bad key fail without aborting everything
    const createdTables = new Set(newTables);
    for (const fk of src.fks.filter(fk => createdTables.has(fk.table))) {
      await client.query('SAVEPOINT fk');
      try {
        await client.query(postgresDriver.addForeignKey(fk));
        await client.query('RELEASE SAVEPOINT fk');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT fk');
        warnings.push(`Foreign key ${fk.name} on ${fk.table} was not added: ${err.message}`);
      }
    }
    await client.query('COMMIT');

    const dbs = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map(r => r.datname);
    return { success: true, dbs, warnings, createdCount: newTables.length, replacedCount: replaced.length };
  } catch (err) {
    // Undo everything: roll back an existing database, drop a new one
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end().catch(() => {});
    }
    client = null;
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${q(newDb)}`).catch(() => {});
    return { success: false, error: err.message };
  } finally {
    if (client) await client.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
  }
});

const COPY_BATCH_PARAMS = 30000;

// cols: the PostgreSQL columns to fill, each with its PostgreSQL type
async function copyTable(srcSession, db, client, table, cols, warnings, progress) {
  const q = postgresDriver.q;
  // Strings keep dates, big integers and decimals exactly as stored in MySQL
  const conn = await mysql.createConnection({
    host: srcSession.config.host,
    port: srcSession.config.port,
    user: srcSession.config.user,
    password: srcSession.config.password,
    database: db,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  });
  let zeroDates = 0, total = 0, batch = [];
  const perBatch = Math.max(1, Math.floor(COPY_BATCH_PARAMS / cols.length));

  const convert = (value, col) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && /^0000-00-00/.test(value)) {
      zeroDates++;
      return col.notnull ? (col.type === 'date' ? '1970-01-01' : '1970-01-01 00:00:00') : null;
    }
    if (col.type === 'boolean') return Buffer.isBuffer(value) ? value.some(b => b !== 0) : Number(value) !== 0;
    if (Buffer.isBuffer(value) && col.type.startsWith('bit')) {
      return [...value].map(b => b.toString(2).padStart(8, '0')).join('').slice(-Number(/\d+/.exec(col.type)[0]));
    }
    if ((col.type === 'json' || col.type === 'jsonb') && typeof value !== 'string') return JSON.stringify(value);
    return value;
  };

  const flush = async () => {
    if (!batch.length) return;
    const params = [];
    const rows = batch.map(row => '(' + cols.map(c => {
      params.push(convert(row[c.name], c));
      return '$' + params.length;
    }).join(', ') + ')');
    // OVERRIDING SYSTEM VALUE keeps MySQL's ids even in GENERATED ALWAYS identity columns
    await client.query(`INSERT INTO ${q(table)} (${cols.map(c => q(c.name)).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${rows.join(', ')}`, params);
    total += batch.length;
    batch = [];
    progress(`Copying ${table}: ${total} rows...`);
  };

  try {
    const stream = conn.connection.query(`SELECT * FROM ${mysqlDriver.q(table)}`).stream();
    for await (const row of stream) {
      batch.push(row);
      if (batch.length >= perBatch) await flush();
    }
    await flush();
  } catch (err) {
    const hint = /out of range for type bigint/.test(err.message)
      ? ' (a MySQL "bigint unsigned" value is above PostgreSQL\'s bigint limit 9223372036854775807)'
      : '';
    throw new Error(`Copying table ${table} failed: ${err.message}${hint}`);
  } finally {
    await conn.end().catch(() => {});
  }
  if (zeroDates) warnings.push(`${table}: ${zeroDates} zero date value(s) like '0000-00-00' became NULL (or 1970-01-01 in NOT NULL columns).`);
  return total;
}

ipcMain.handle('show-dialog', async (event, { message, type, buttons }) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type,
    title: 'Compare Databases',
    message,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true
  });
  // Give keyboard focus back to the page so inputs keep working
  mainWindow.webContents.focus();
  return response;
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
});
