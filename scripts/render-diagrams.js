/** Shared geometry keeps the two README diagram languages in sync. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const style = JSON.parse(await readFile(new URL('../docs/diagram-style.json', import.meta.url), 'utf8'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const labels = {
  zh: {
    lang: 'zh-CN', title: 'cd-connect 架构',
    description: '用户授权规划端并在 DSH 中审批；规划端经本地适配器连接 Host 内的插件，原生执行写入工作目录，任务记录、原生日志和目录见证分别支持审查与恢复。',
    subtitle: '规划与审查经 MCP 连接已有 DSH Desktop，不改变原生模型、权限与审批。',
    host: '现有 DSH Desktop Host',
    human: ['用户', '目标与授权'],
    client: ['规划与审查端', 'Codex Desktop'],
    stdio: ['本地适配器', 'MCP stdio'],
    bridge: ['cd-connect 插件', 'MCP 服务 · 任务与审查'],
    native: ['DSH 原生执行', '适配器 · 会话与 Agent'],
    records: ['任务记录', 'ledger/tasks.json'],
    witness: ['目录见证', '完成时核对文件'],
    logs: ['原生日志', '执行记录 · 恢复读取'],
    workspace: ['任务工作目录', '文件与产物'],
    authorize: '授权', approval: '在 DSH 中人工审批',
    http: '回环 HTTP', api: '原生接口', tools: '工具', check: '核对产物',
    flow: '任务与执行', verify: '文件核对', persisted: '持久记录',
  },
  en: {
    lang: 'en', title: 'cd-connect architecture',
    description: 'The user authorizes the planning client and approves operations in DSH; a local adapter connects the client to the Host plugin, native execution writes to the workspace, and separate task records, native logs, and file witnesses support review and recovery.',
    subtitle: 'Planning and review connect to an existing DSH Desktop through MCP, keeping native models, permissions, and approvals.',
    host: 'Existing DSH Desktop Host',
    human: ['Human', 'Goals & authorization'],
    client: ['Plan & review', 'Codex Desktop'],
    stdio: ['Local adapter', 'MCP stdio'],
    bridge: ['cd-connect plugin', 'MCP server · tasks · review'],
    native: ['DSH native execution', 'adapter · session · agent'],
    records: ['Task records', 'ledger/tasks.json'],
    witness: ['File witness', 'check on completion'],
    logs: ['Native logs', 'record · reconcile'],
    workspace: ['Task workspace', 'files & artifacts'],
    authorize: 'Authorize', approval: 'Human approval in DSH',
    http: 'Loopback HTTP', api: 'Native API', tools: 'Tools', check: 'Check files',
    flow: 'Task & execution', verify: 'File verification', persisted: 'Stored records',
  },
};

const geometry = [
  ['human', 40, 128, 192, 64, 'input'],
  ['client', 40, 288, 192, 80, 'service'],
  ['stdio', 40, 464, 192, 72, 'service'],
  ['bridge', 352, 288, 240, 80, 'focal'],
  ['native', 736, 288, 240, 80, 'service'],
  ['records', 344, 464, 184, 72, 'store'],
  ['witness', 568, 464, 184, 72, 'service'],
  ['logs', 792, 464, 184, 72, 'store'],
  ['workspace', 1056, 288, 184, 80, 'store'],
];

function diagram(language) {
  const t = labels[language];
  const id = `architecture-${language}`;
  const text = (x, y, value, className = 'name', anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="${className}" text-anchor="${anchor}">${escape(value)}</text>`;
  const line = (d, kind = 'flow', both = false) =>
    `<path class="connector ${kind}" d="${d}" marker-end="url(#${id}-arrow${kind === 'flow' ? '-link' : ''})"${both ? ` marker-start="url(#${id}-arrow${kind === 'flow' ? '-link' : ''})"` : ''}/>`;
  const label = (x, y, width, value, height = 24) =>
    `<g class="edge-label"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${style.paper}"/>${text(x + width / 2, y + 16, value, 'label')}</g>`;
  const node = ([key, x, y, width, height, kind]) => {
    const [name, detail] = t[key];
    const small = ['records', 'witness', 'logs', 'workspace'].includes(key);
    return `<g class="node ${kind}" data-node="${key}">
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8"/>
      ${text(x + width / 2, y + height / 2 - 4, name, small ? 'small-name' : 'name')}
      ${text(x + width / 2, y + height / 2 + 20, detail, 'detail')}
    </g>`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-labelledby="${id}-title ${id}-desc" lang="${t.lang}">
<title id="${id}-title">${escape(t.title)}</title>
<desc id="${id}-desc">${escape(t.description)}</desc>
<defs>
  <style>
    text { font-family: ${style.sans}; fill: ${style.ink}; }
    .title { font-family: ${style.serif}; font-size: 32px; font-weight: 400; }
    .subtitle { font-size: 16px; fill: ${style.muted}; }
    .name { font-size: 20px; font-weight: 600; }
    .small-name { font-size: 16px; font-weight: 600; }
    .detail, .label, .zone-label, .legend { font-size: 12px; fill: ${style.muted}; }
    .detail, .label { font-family: ${style.mono}; }
    .zone-label { font-size: 16px; font-weight: 600; }
    .node rect { fill: #ffffff; stroke: ${style.ink}; stroke-width: 1.2; }
    .node.input rect { fill: ${style.paper2}; stroke: ${style.muted}; }
    .node.focal rect { fill: ${style.accentTint}; stroke: ${style.accent}; stroke-width: 1.6; }
    .node.store rect { fill: ${style.paper2}; stroke: ${style.muted}; }
    .connector { fill: none; stroke: ${style.muted}; stroke-width: 1.6; }
    .connector.flow { stroke: ${style.link}; }
    .connector.verify { stroke-dasharray: 5 4; }
  </style>
  <marker id="${id}-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto-start-reverse"><path d="M0 0L8 3L0 6Z" fill="${style.muted}"/></marker>
  <marker id="${id}-arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto-start-reverse"><path d="M0 0L8 3L0 6Z" fill="${style.accent}"/></marker>
  <marker id="${id}-arrow-link" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto-start-reverse"><path d="M0 0L8 3L0 6Z" fill="${style.link}"/></marker>
</defs>
<rect width="1280" height="720" fill="${style.paper}"/>
${text(40, 64, t.title, 'title', 'start')}
${text(40, 96, t.subtitle, 'subtitle', 'start')}
<g class="zone">
  <rect x="312" y="224" width="704" height="376" rx="8" fill="${style.paper}" stroke="${style.rule}" stroke-dasharray="4 4"/>
  ${text(336, 256, t.host, 'zone-label', 'start')}
</g>
<g class="edges">
  ${line('M136 192V288')}
  ${line('M232 160H848Q856 160 856 168V288')}
  ${line('M136 368V464', 'flow', true)}
  ${line('M232 500H272Q280 500 280 492V336Q280 328 288 328H352', 'flow', true)}
  ${line('M592 328H736', 'flow', true)}
  ${line('M976 328H1056')}
  ${line('M440 368V464', 'record', true)}
  ${line('M552 368V424Q552 432 560 432H652Q660 432 660 440V464', 'verify')}
  ${line('M856 368V464', 'record', true)}
  ${line('M696 464V416Q696 408 704 408H848a8 8 0 0 1 16 0H1140Q1148 408 1148 400V368', 'verify')}
</g>
${label(144, 224, 128, t.authorize)}
${label(424, 128, 240, t.approval)}
${label(144, 404, 128, 'MCP stdio')}
${label(288, 404, 128, t.http)}
${label(288, 428, 128, 'Bearer')}
${label(608, 296, 112, t.api)}
${label(984, 296, 64, t.tools)}
${label(984, 376, 144, t.check)}
<g class="nodes">
${geometry.map(node).join('\n')}
</g>
<g class="legend-strip">
  <path d="M40 640H1240" stroke="${style.rule}"/>
  <path d="M40 672H80" stroke="${style.link}" stroke-width="1.6"/>
  ${text(92, 676, t.flow, 'legend', 'start')}
  <path d="M344 672H384" stroke="${style.muted}" stroke-width="1.6" stroke-dasharray="5 4"/>
  ${text(396, 676, t.verify, 'legend', 'start')}
  <rect x="672" y="660" width="32" height="24" rx="4" fill="${style.paper2}" stroke="${style.muted}"/>
  ${text(716, 676, t.persisted, 'legend', 'start')}
</g>
</svg>`;
  // HTML is the editable figure source; standalone SVG is extracted from it.
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escape(t.title)}</title>
<style>html,body{margin:0;background:${style.paper}}svg{display:block;width:100%;height:auto;max-width:1280px}</style>
</head>
<body><main>${svg}</main></body>
</html>
`;
}

export function diagramFiles() {
  const files = new Map();
  for (const language of ['zh', 'en']) {
    const name = `docs/assets/architecture${language === 'en' ? '.en' : ''}`;
    const html = diagram(language);
    files.set(`${name}.html`, html);
    files.set(`${name}.svg`, `<?xml version="1.0" encoding="UTF-8"?>\n${html.match(/<svg\b[\s\S]*?<\/svg>/)[0]}\n`);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(new URL('../docs/assets/', import.meta.url), { recursive: true });
  for (const [path, content] of diagramFiles()) {
    await writeFile(new URL(`../${path}`, import.meta.url), content);
    console.log(`Wrote ${path}`);
  }
}
