import { openStore } from './db.js';
const store = openStore();
store.close();
console.log('SQLite database initialized.');
