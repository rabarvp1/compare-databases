const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const mysql = require('mysql2/promise');

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let connection;

ipcMain.handle('connect-db', async (event, args) => {
  try {
    connection = await mysql.createConnection({
      host: args.host,
      user: args.user,
      password: args.password
    });
    const [rows] = await connection.query("SHOW DATABASES");
    const dbs = rows.map(r => r.Database);
    return { success: true, dbs };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('compare-db', async (event, { source, target }) => {
  try {
    let sqlOutput = "";
    
    // Find missing tables
    const tableQuery = `
      SELECT t1.TABLE_NAME
      FROM information_schema.TABLES t1
      LEFT JOIN information_schema.TABLES t2
          ON t1.TABLE_NAME = t2.TABLE_NAME AND t2.TABLE_SCHEMA = ?
      WHERE t1.TABLE_SCHEMA = ? AND t2.TABLE_NAME IS NULL AND t1.TABLE_TYPE = 'BASE TABLE'
    `;
    const [missingTables] = await connection.query(tableQuery, [target, source]);
    
    for (let tb of missingTables) {
      await connection.query(`USE \`${source}\``);
      const [createRes] = await connection.query(`SHOW CREATE TABLE \`${tb.TABLE_NAME}\``);
      sqlOutput += createRes[0]['Create Table'] + ";\n\n";
    }

    // Find missing columns
    const colQuery = `
      SELECT c1.TABLE_NAME, c1.COLUMN_NAME, c1.COLUMN_TYPE, c1.IS_NULLABLE, c1.COLUMN_DEFAULT
      FROM information_schema.COLUMNS c1
      JOIN information_schema.TABLES t 
          ON t.TABLE_NAME = c1.TABLE_NAME AND t.TABLE_SCHEMA = ?
      LEFT JOIN information_schema.COLUMNS c2
          ON c1.TABLE_NAME = c2.TABLE_NAME AND c1.COLUMN_NAME = c2.COLUMN_NAME AND c2.TABLE_SCHEMA = ?
      WHERE c1.TABLE_SCHEMA = ? AND c2.COLUMN_NAME IS NULL
    `;
    const [missingCols] = await connection.query(colQuery, [target, target, source]);
    
    for (let col of missingCols) {
      let nullStr = col.IS_NULLABLE === 'NO' ? "NOT NULL" : "NULL";
      let defStr = col.COLUMN_DEFAULT ? `DEFAULT '${col.COLUMN_DEFAULT}'` : "";
      sqlOutput += `ALTER TABLE \`${col.TABLE_NAME}\` ADD COLUMN \`${col.COLUMN_NAME}\` ${col.COLUMN_TYPE} ${nullStr} ${defStr};\n\n`;
    }

    // Find extra tables in target (to DROP)
    const extraTableQuery = `
      SELECT t1.TABLE_NAME
      FROM information_schema.TABLES t1
      LEFT JOIN information_schema.TABLES t2
          ON t1.TABLE_NAME = t2.TABLE_NAME AND t2.TABLE_SCHEMA = ?
      WHERE t1.TABLE_SCHEMA = ? AND t2.TABLE_NAME IS NULL AND t1.TABLE_TYPE = 'BASE TABLE'
    `;
    const [extraTables] = await connection.query(extraTableQuery, [source, target]);
    for (let tb of extraTables) {
      sqlOutput += `DROP TABLE \`${tb.TABLE_NAME}\`;\n\n`;
    }

    // Find extra columns in target (to DROP)
    const extraColQuery = `
      SELECT c1.TABLE_NAME, c1.COLUMN_NAME
      FROM information_schema.COLUMNS c1
      JOIN information_schema.TABLES t 
          ON t.TABLE_NAME = c1.TABLE_NAME AND t.TABLE_SCHEMA = ?
      LEFT JOIN information_schema.COLUMNS c2
          ON c1.TABLE_NAME = c2.TABLE_NAME AND c1.COLUMN_NAME = c2.COLUMN_NAME AND c2.TABLE_SCHEMA = ?
      WHERE c1.TABLE_SCHEMA = ? AND c2.COLUMN_NAME IS NULL
    `;
    const [extraCols] = await connection.query(extraColQuery, [source, source, target]);
    for (let col of extraCols) {
      sqlOutput += `ALTER TABLE \`${col.TABLE_NAME}\` DROP COLUMN \`${col.COLUMN_NAME}\`;\n\n`;
    }

    return { success: true, sql: sqlOutput };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
});
