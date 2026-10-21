/** Structural checks supplement, but cannot replace, bilingual editorial review. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagramFiles } from './render-diagrams.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
const documents = new Map();
const normalize = value => value.replaceAll('.en.md', '.md').replaceAll('.en.svg', '.svg').replaceAll('.en.html', '.html');
const known = new Set(('goal scope out_of_scope constraints acceptance workspace decision comment instruction revision run.id '
  + 'dispatching running execution_completed awaiting_review changes_requested accepted failed needs_human waiting_approval '
  + 'cancel_requested cancelled needs_recovery confirmed aborted rejected outcome_unknown not_cancelled '
  + 'pending attempted sent completed interrupted uncertain superseded ready inspect dispatch_prepared '
  + 'true false desktop model cwd approvalPolicy approvalsReviewer sandbox effective binding '
  + 'cursor baseline_cursor next_cursor preview truncated hostname prompt continue followup turn title desc').split(' '));
const withoutFences = value => value.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
const slug = value => value.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-');

function sections(text) {
  const result = [];
  let current = { level: 0, text: '' };
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const match = !fenced && line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      if (current.text) result.push(current);
      current = { level: match[1].length, text: '' };
    }
    current.text += line + '\n';
  }
  result.push(current);
  return result;
}

function tables(text) {
  return [...withoutFences(text).matchAll(/(?:^\|.*\|\n)+/gm)].map(match => match[0].trim().split('\n').length);
}

function tokens(text) {
  return new Set([...withoutFences(text).matchAll(/`([^`\n]+)`/g)].map(match => normalize(match[1]))
    .filter(value => !/\p{Script=Han}/u.test(value) && (known.has(value) || /[_./:$()[\]{}>=-]/.test(value) || /^\d/.test(value))));
}

function numbers(text) {
  return new Set(text.match(/\d+(?:\.\d+)*(?:-rc\.\d+)?/g) ?? []);
}

function jsonContent(value, key) {
  if (Array.isArray(value)) return value.map(item => jsonContent(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, jsonContent(value[name], name)]));
  if (typeof value === 'string' && ['goal', 'scope', 'out_of_scope', 'constraints', 'acceptance', 'instruction', 'comment'].includes(key)) return '<localized text>';
  return value;
}

function examples(text) {
  return [...text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)].map(([, language, body]) => {
    if (language === 'json') return [language, jsonContent(JSON.parse(body))];
    const command = body.split('\n').filter(line => !line.trim().startsWith('#'))
      .map(line => line.replace(/\s+#.*$/, '').trimEnd()).filter(Boolean).join('\n');
    return [language, command];
  });
}

function equalSet(left, right, where, kind) {
  const onlyLeft = [...left].filter(item => !right.has(item));
  const onlyRight = [...right].filter(item => !left.has(item));
  if (onlyLeft.length || onlyRight.length) failures.push(`${where}: ${kind} differ (Chinese only: ${onlyLeft.join(', ') || '—'}; English only: ${onlyRight.join(', ') || '—'})`);
}

async function collect(directory, recurse) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory() && recurse) await collect(path, true);
    else if (item.isFile() && extname(path) === '.md') documents.set(path, await readFile(path, 'utf8'));
  }
}

function anchors(text) {
  const result = new Set();
  const counts = new Map();
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const name = slug(match[1]);
    const count = counts.get(name) ?? 0;
    result.add(count ? `${name}-${count}` : name);
    counts.set(name, count + 1);
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\bid=["']([^"']+)["']/g)) result.add(match[1]);
  return result;
}

await collect(root, false);
await collect(join(root, 'docs'), true);
let pairs = 0;
for (const [path, text] of documents) {
  const counterpart = path.endsWith('.en.md') ? path.replace(/\.en\.md$/, '.md') : path.replace(/\.md$/, '.en.md');
  const other = documents.get(counterpart);
  if (other === undefined) {
    failures.push(`${relative(root, path)}: missing bilingual counterpart ${relative(root, counterpart)}`);
    continue;
  }
  for (const target of [path, counterpart]) {
    if (!text.split('\n').slice(0, 6).join('\n').includes(`](${relative(dirname(path), target)})`)) {
      failures.push(`${relative(root, path)}: missing language switch to ${relative(root, target)}`);
    }
  }
  if (path.endsWith('.en.md')) continue;
  pairs++;
  const chinese = sections(text), english = sections(other);
  if (chinese.map(item => item.level).join() !== english.map(item => item.level).join()) {
    failures.push(`${relative(root, path)}: heading levels/count differ`);
    continue;
  }
  for (let index = 0; index < chinese.length; index++) {
    const left = chinese[index].text, right = english[index].text;
    const where = `${relative(root, path)} section ${index + 1}`;
    if (JSON.stringify(tables(left)) !== JSON.stringify(tables(right))) failures.push(`${where}: table-row counts differ`);
    equalSet(tokens(left), tokens(right), where, 'technical identifiers');
    equalSet(numbers(left), numbers(right), where, 'numbers');
    try {
      if (JSON.stringify(examples(left)) !== JSON.stringify(examples(right))) failures.push(`${where}: commands or JSON examples differ`);
    } catch (error) {
      failures.push(`${where}: invalid JSON example: ${error.message}`);
    }
  }
}
for (const [path, text] of documents) {
  for (const match of withoutFences(text).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    const [file, fragment] = target.split('#');
    const destination = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
    try {
      if (!(await stat(destination)).isFile()) throw new Error('not a file');
      if (fragment && destination.endsWith('.md')) {
        const destinationText = documents.get(destination) ?? await readFile(destination, 'utf8');
        if (!anchors(destinationText).has(decodeURIComponent(fragment))) throw new Error('missing anchor');
      }
    } catch {
      failures.push(`${relative(root, path)}: broken link ${target}`);
    }
  }
}
for (const [path, expected] of diagramFiles()) {
  try {
    if (await readFile(join(root, path), 'utf8') !== expected) failures.push(`${path}: stale diagram; run npm run docs:diagrams`);
  } catch {
    failures.push(`${path}: missing diagram; run npm run docs:diagrams`);
  }
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`Validated ${pairs} bilingual guide pairs, local links/anchors, examples, technical values, and generated diagrams.`);
  console.log('Translation meaning and visual layout still require editorial review.');
}
