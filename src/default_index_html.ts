import * as fs from 'fs';
export const DEFAULT_INDEX_HTML = fs.readFileSync(__dirname + '/default_index.html', 'utf-8');
