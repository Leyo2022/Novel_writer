'use strict';

/**
 * 极简 Markdown → HTML 渲染器（零依赖，符合 CSP 'self'）。
 * 支持：标题、引用、有序/无序列表、Pipe 表格、分割线，
 * 以及行内 **粗体** / *斜体* / `代码` / [链接](url)。
 * 源文本先做 HTML 转义再做行内标记，避免注入。
 * 仅暴露 window.renderMarkdown，内部符号用 IIFE 隔离，避免与 app.js 顶层同名冲突。
 */
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function inline(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return s;
  }

  const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  const BLOCK_START = /^\s*(#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s)/;
  const isSep = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }

  function render(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }

      if (HR.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const n = h[1].length;
        out.push(`<h${n}>${inline(h[2].trim())}</h${n}>`);
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      if (/^\s*\|/.test(line)) {
        const rows = [];
        let j = i;
        while (j < lines.length && /^\s*\|/.test(lines[j])) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        if (rows.length >= 2 && isSep(rows[1])) {
          let html = '<table><thead><tr>' + rows[0].map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
          for (let r = 2; r < rows.length; r++) {
            html += '<tr>' + rows[r].map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
          }
          out.push(html + '</tbody></table>');
          i = j;
          continue;
        }
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
        }
        out.push('<ul>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ul>');
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          i++;
        }
        out.push('<ol>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ol>');
        continue;
      }

      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !HR.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('\n');
  }

  // ---- 反向：把所见即所得编辑区的 DOM 还原成 Markdown ----

  /** 行内内容：文本 + 粗体/斜体/代码/链接 + 换行 */
  function inlineMd(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue.replace(/\u00a0/g, ' ');
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'BR') out += '\n';
      else if (tag === 'STRONG' || tag === 'B') out += '**' + inlineMd(child) + '**';
      else if (tag === 'EM' || tag === 'I') out += '*' + inlineMd(child) + '*';
      else if (tag === 'CODE') out += '`' + child.textContent + '`';
      else if (tag === 'A') out += '[' + inlineMd(child) + '](' + (child.getAttribute('href') || '') + ')';
      else out += inlineMd(child);
    }
    return out;
  }

  const HAS_BLOCK = 'p,div,section,article,ul,ol,li,table,blockquote,pre,h1,h2,h3,h4,h5,h6,hr';

  function tableMd(table) {
    const rows = [...table.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((c) => inlineMd(c).trim().replace(/\|/g, '/'))
    );
    if (!rows.length || !rows[0].length) return '';
    const line = (cells) => '| ' + cells.join(' | ') + ' |';
    const out = [line(rows[0]), '| ' + rows[0].map(() => '---').join(' | ') + ' |'];
    for (let r = 1; r < rows.length; r++) out.push(line(rows[r]));
    return out.join('\n');
  }

  /** 引用块：每行前缀 >，空行单独成 > */
  const quoteMd = (md) => md.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');

  /** 逐个块级元素转 Markdown，返回块数组 */
  function blocksMd(node) {
    const out = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = child.nodeValue.trim();
        if (t) out.push(t);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;

      if (/^H[1-6]$/.test(tag)) {
        const t = inlineMd(child).trim();
        if (t) out.push('#'.repeat(Number(tag[1])) + ' ' + t);
        continue;
      }
      if (tag === 'HR') {
        out.push('---');
        continue;
      }
      if (tag === 'BLOCKQUOTE') {
        const inner = blocksMd(child);
        if (inner.length) out.push(inner.map(quoteMd).join('\n>\n'));
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        const items = [...child.children]
          .filter((li) => li.tagName === 'LI')
          .map((li, i) => (tag === 'OL' ? i + 1 + '. ' : '- ') + inlineMd(li).replace(/\n+/g, ' ').trim())
          .filter((s) => s.length > 2);
        if (items.length) out.push(items.join('\n'));
        continue;
      }
      if (tag === 'TABLE') {
        const t = tableMd(child);
        if (t) out.push(t);
        continue;
      }
      if (tag === 'PRE') {
        out.push('```\n' + child.textContent.replace(/\n$/, '') + '\n```');
        continue;
      }
      if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') {
        if (child.querySelector(HAS_BLOCK)) out.push(...blocksMd(child));
        else {
          const t = inlineMd(child).trim();
          if (t) out.push(t);
        }
        continue;
      }
      // 兜底：按行内内容处理（thead/tbody 等容器会被这里递归展开）
      if (child.querySelector(HAS_BLOCK)) out.push(...blocksMd(child));
      else {
        const t = inlineMd(child).trim();
        if (t) out.push(t);
      }
    }
    return out.filter((s) => s !== '');
  }

  function markdownFromDom(root) {
    const body = blocksMd(root).join('\n\n');
    return body ? body + '\n' : '';
  }

  window.renderMarkdown = render;
  window.markdownFromDom = markdownFromDom;
})();
