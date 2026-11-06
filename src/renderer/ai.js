'use strict';

/**
 * AI 助手对话窗口（渲染进程）。
 * 独立成文件、只在 DOM 上活动：正文 / 故事大纲 / 设定 三处共用同一个面板，
 * 取文与写回都只操作对应页面的 DOM，再派发一次 input 事件让原有的自动保存逻辑接管。
 * 真正的外网请求由主进程完成（见 src/main/services/ai.js），这里只消费流式增量。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const THE_MAX = 90000; // 单次送进模型的原文上限，超长取尾部

  const AI_SYSTEM_PROMPT = [
    '你是「墨枢」写作工作台里的中文小说创作助手。既能对用户正在编辑的文字做局部润色，也能直接写出新的正文或大纲内容。',
    '用户会给你【当前编辑内容】、可能附带的【故事大纲】等写作依据，以及一句【修改要求】。',
    '请严格遵守下面的输出格式与要求：',
    '1. 先用一两句自然语言说明你的思路，让用户能直接阅读。',
    '2. 然后必须输出一个 ```json 代码块，内容是一个 JSON 数组，数组每一项是下面两种之一：',
    '   A. 局部替换：{"op":"replace","find":"与原文逐字完全一致的片段","replace":"改写后的片段","reason":"为什么这样改"}',
    '   B. 整段写入：{"op":"write","text":"完整的正文或大纲内容","reason":"写作依据"}',
    '3. 当用户要求「直接写」「续写」「扩写」「生成正文/大纲」「帮我写第 N 章」时，**必须**用 op=write 一次性给出完整内容，不要拆成大量局部替换，也不要以“不适合替换片段”为由拒绝。',
    '4. 当前编辑内容为空时，同样用 op=write 直接产出内容。',
    '5. op=replace 的 find 必须能在原文里精确匹配并且只出现一次；局部润色时尽量只做最小范围的替换。',
    '6. 如果用户只是提问、或不需要改动文字，json 数组返回 []。',
    '7. 用户可能随消息附上图片（人物立绘、参考截图、设定图等）：先读懂图片里的画面与文字，再结合图片回答；涉及画面细节时以图片为准。',
    '8. 除上述说明与 json 代码块外，不要再输出其它内容。',
  ].join('\n');

  const el = {
    panel: $('ai-panel'),
    context: $('ai-context'),
    log: $('ai-log'),
    input: $('ai-input'),
    send: $('ai-send'),
    stop: $('ai-stop'),
    composer: $('ai-composer'),
    atts: $('ai-atts'),
    attach: $('ai-attach'),
    file: $('ai-file'),
  };
  if (!el.panel) return; // 面板没挂上（老版本 HTML）就整体跳过

  const run = { seq: 0, id: '', busy: false, buffer: '', body: null, editsBox: null };
  let atts = []; // 待发送的多模态附件：图片（dataUrl）与文本文件（已读出内容）

  const MAX_ATTACH = 6;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_TEXT_BYTES = 200 * 1024;
  const MAX_ATTACH_CHARS = 30000;

  // ---------- 上下文：当前哪个页面、取文 / 写回 ----------

  const hidden = (id) => {
    const node = $(id);
    return !node || node.classList.contains('hidden');
  };

  function fire(node, type) {
    node.dispatchEvent(new Event(type, { bubbles: true }));
  }

  /** 整段写回：走浏览器原生编辑命令，保留撤销栈，Ctrl+Z 能退回替换前的内容 */
  function rewriteAll(node, text, html) {
    node.focus();
    if (node.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        if (document.execCommand(html ? 'insertHTML' : 'insertText', false, text)) return;
      } catch {
        /* 落到下面的兜底 */
      }
      node.innerHTML = text;
      fire(node, 'input');
      return;
    }
    node.select();
    try {
      if (document.execCommand('insertText', false, text)) return;
    } catch {
      /* 落到下面的兜底 */
    }
    node.value = text;
    fire(node, 'input');
  }

  /** 当前取文目标由 app.js 维护（左栏页签切走后仍记得刚在看什么） */
  function targetKey() {
    return typeof window.mushuGetAiPane === 'function' ? window.mushuGetAiPane() : 'chapter';
  }

  /** 当前正在编辑的页面 → { key, label, read, write }；画布或无内容时返回 null */
  function aiContext() {
    if (hidden('workspace')) return null;
    if (!hidden('canvas-pane')) return null;

    const key = targetKey();

    if (key === 'cast') {
      const desc = $('cast-desc');
      if (!desc) return null;
      const name = ($('cast-name') && $('cast-name').value.trim()) || '未命名';
      return {
        key: 'cast',
        label: `设定·${name}`,
        read: () => desc.value,
        write: (text) => rewriteAll(desc, text, false),
      };
    }

    if (key === 'outline') {
      const body = $('outline-body');
      if (!body) return null;
      return {
        key: 'outline',
        label: '故事大纲',
        read: () => (window.markdownFromDom ? window.markdownFromDom(body) : body.innerText),
        write: (text) => rewriteAll(body, window.renderMarkdown ? window.renderMarkdown(text) : text, true),
      };
    }

    const ed = $('editor');
    const title = ($('chapter-title') && $('chapter-title').value.trim()) || '';
    return {
      key: 'chapter',
      label: title ? `正文·${title}` : '正文',
      read: () => ed.value,
      write: (text) => rewriteAll(ed, text, false),
    };
  }

  function refreshContext() {
    const ctx = aiContext();
    el.context.textContent = ctx ? ctx.label : hidden('workspace') ? '这里没有可编辑的文字' : '';
    // 面板从隐藏切回来时重新量一次高度（隐藏期间 scrollHeight 恒为 0）
    if (!hidden('ai-panel')) autoGrow();
  }

  /** 写作依据：把故事大纲一并送给模型，让「写第 N 章」有据可依 */
  async function backgroundText() {
    let md = '';
    if (typeof window.mushuReadOutlineMd === 'function') {
      try {
        md = await window.mushuReadOutlineMd();
      } catch {
        md = '';
      }
    }
    if (!md.trim()) {
      const body = $('outline-body');
      md = body ? (window.markdownFromDom ? window.markdownFromDom(body) : body.innerText) : '';
    }
    if (!md.trim()) return '';
    return '【故事大纲】\n<<<\n' + md.trim().slice(0, 8000) + '\n>>>';
  }

  /** 输入框随内容高度自适应（上限由 CSS max-height 控制） */
  function autoGrow() {
    if (!el.input) return;
    el.input.style.height = '22px';
    // 面板隐藏时 scrollHeight 为 0：此时保留 22px，避免把输入框压成 0 高度后再也点不进去
    const h = el.input.scrollHeight;
    el.input.style.height = (h > 22 ? Math.min(h, 140) : 22) + 'px';
  }

  // ---------- 多模态附件：图片 / 文本文件 ----------

  const toastIf = (text) => {
    if (typeof toast === 'function') toast(text);
  };

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('读取失败'));
      r.readAsDataURL(file);
    });
  }

  /** 大图先缩到 1400px 内再转 dataUrl，避免 base64 撑爆 IPC 与请求体 */
  async function imageDataUrl(file) {
    const raw = await readAsDataUrl(file);
    try {
      const bitmap = await createImageBitmap(file);
      const max = 1400;
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      if (bitmap.close) bitmap.close();
      // 动图保持原样，避免压成静态帧
      const type = file.type === 'image/gif' ? 'image/gif' : file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const out = canvas.toDataURL(type, 0.86);
      return out && out.length < raw.length ? out : raw;
    } catch {
      return raw; // 解码失败就用原图，至少还能发给模型
    }
  }

  function renderAtts() {
    el.atts.innerHTML = '';
    el.atts.classList.toggle('hidden', !atts.length);
    atts.forEach((a) => {
      const chip = document.createElement('div');
      chip.className = 'ai-att' + (a.kind === 'image' ? ' image' : '');
      chip.title = a.name;
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.src = a.dataUrl;
        img.alt = a.name;
        chip.append(img);
      } else {
        const ico = document.createElement('span');
        ico.className = 'ai-att-ico';
        ico.textContent = 'TXT';
        chip.append(ico);
      }
      const name = document.createElement('span');
      name.className = 'ai-att-name';
      name.textContent = a.name;
      chip.append(name);
      const del = document.createElement('button');
      del.className = 'ai-att-del';
      del.title = '移除附件';
      del.textContent = '×';
      del.onclick = () => {
        atts = atts.filter((x) => x.id !== a.id);
        renderAtts();
      };
      chip.append(del);
      el.atts.append(chip);
    });
    autoGrow();
  }

  async function addFiles(files) {
    for (const file of files || []) {
      if (!file) continue;
      if (atts.length >= MAX_ATTACH) {
        toastIf('最多添加 ' + MAX_ATTACH + ' 个附件');
        break;
      }
      const isImage = /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name || '');
      const id = 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      if (isImage) {
        if (file.size > MAX_IMAGE_BYTES) {
          toastIf('「' + (file.name || '图片') + '」超过 8MB，未添加');
          continue;
        }
        try {
          atts.push({ id, kind: 'image', name: file.name || '粘贴的图片', size: file.size, dataUrl: await imageDataUrl(file) });
        } catch (err) {
          toastIf('图片读取失败：' + (err && err.message ? err.message : err));
        }
      } else {
        if (file.size > MAX_TEXT_BYTES) {
          toastIf('「' + file.name + '」超过 200KB，未添加');
          continue;
        }
        try {
          atts.push({ id, kind: 'text', name: file.name, size: file.size, text: await file.text() });
        } catch (err) {
          toastIf('文件读取失败：' + (err && err.message ? err.message : err));
        }
      }
    }
    renderAtts();
  }

  const hasDropFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));

  function dragOn(on) {
    el.composer.classList.toggle('drag', !!on);
  }

  el.attach.onclick = () => el.file.click();
  el.file.onchange = async () => {
    await addFiles([...el.file.files]);
    el.file.value = '';
  };
  el.composer.addEventListener('dragover', (e) => {
    if (!hasDropFiles(e)) return;
    e.preventDefault();
    dragOn(true);
  });
  el.composer.addEventListener('dragleave', (e) => {
    if (!hasDropFiles(e)) return;
    dragOn(false);
  });
  el.composer.addEventListener('drop', (e) => {
    if (!hasDropFiles(e)) return;
    e.preventDefault();
    dragOn(false);
    addFiles([...e.dataTransfer.files]);
  });
  el.input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (f) files.push(f);
    }
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  // ---------- 消息渲染 ----------

  function appendMessage(role, text, list) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ai-' + role;
    if (list && list.length) {
      const box = document.createElement('div');
      box.className = 'ai-msg-atts';
      list.forEach((a) => {
        if (a.kind === 'image') {
          const img = document.createElement('img');
          img.src = a.dataUrl;
          img.alt = a.name;
          img.title = a.name;
          box.append(img);
        } else {
          const chip = document.createElement('span');
          chip.className = 'ai-msg-file';
          chip.textContent = 'TXT ' + a.name;
          chip.title = a.name;
          box.append(chip);
        }
      });
      wrap.append(box);
    }
    const body = document.createElement('div');
    body.className = 'ai-text';
    body.textContent = text || '';
    wrap.append(body);
    el.log.append(wrap);
    el.log.scrollTop = el.log.scrollHeight;
    return { wrap, body };
  }

  /** 从流式文本里剥掉 json 代码块，只留可读的说明文字 */
  function splitProse(text) {
    const idx = text.indexOf('```');
    return (idx === -1 ? text : text.slice(0, idx)).trim();
  }

  /** 解析模型返回的 ```json 块，归一化成 { op:'replace' | 'write' } 两种操作 */
  function parseOps(text) {
    const out = [];
    const re = /```(?:json)?\s*([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let arr;
      try {
        arr = JSON.parse(m[1].trim());
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        if (typeof it.text === 'string' && it.text.trim()) {
          out.push({ op: 'write', text: it.text, reason: String(it.reason || '') });
          continue;
        }
        if (typeof it.find === 'string' && it.find && typeof it.replace === 'string') {
          out.push({ op: 'replace', find: it.find, replace: it.replace, reason: String(it.reason || '') });
        }
      }
    }
    return out;
  }

  function buildEditCard(edit, index, paneKey) {
    const card = document.createElement('div');
    card.className = 'ai-edit';

    const head = document.createElement('div');
    head.className = 'ai-edit-head';
    head.textContent = `建议 ${index + 1}`;

    const del = document.createElement('div');
    del.className = 'ai-edit-del';
    del.textContent = edit.find;

    const add = document.createElement('div');
    add.className = 'ai-edit-add';
    add.textContent = edit.replace;

    card.append(head, del, add);
    if (edit.reason) {
      const reason = document.createElement('div');
      reason.className = 'ai-edit-reason';
      reason.textContent = edit.reason;
      card.append(reason);
    }

    const btn = document.createElement('button');
    btn.className = 'ai-apply';
    btn.textContent = '应用';
    btn.onclick = () => applyEdit(edit, btn, paneKey);
    card.append(btn);
    return card;
  }

  function applyEdit(edit, btn, paneKey) {
    const ctx = aiContext();
    if (!ctx || ctx.key !== paneKey) {
      btn.textContent = '页面已切换';
      btn.disabled = true;
      return;
    }
    const text = ctx.read();
    const first = text.indexOf(edit.find);
    if (first === -1) {
      btn.textContent = '未找到原文';
      btn.disabled = true;
      return;
    }
    if (text.indexOf(edit.find, first + edit.find.length) !== -1) {
      btn.textContent = '匹配不唯一';
      btn.disabled = true;
      return;
    }
    ctx.write(text.slice(0, first) + edit.replace + text.slice(first + edit.find.length));
    btn.textContent = '已应用';
    btn.disabled = true;
    btn.classList.add('done');
  }

  /** 把整段草稿写回页面：replace = 覆盖全文，append = 追加到末尾 */
  function writeInto(op, mode, paneKey) {
    const ctx = aiContext();
    if (!ctx || ctx.key !== paneKey) return '页面已切换，未写入';
    const current = ctx.read();
    const next = mode === 'append' && current.trim()
      ? current.replace(/\s+$/, '') + '\n\n' + op.text
      : op.text;
    ctx.write(next);
    return mode === 'append' ? '已追加到末尾' : '已写入全文';
  }

  function buildWriteCard(op, index, paneKey) {
    const card = document.createElement('div');
    card.className = 'ai-write';

    const head = document.createElement('div');
    head.className = 'ai-write-head';
    head.textContent = `完整草稿 ${index + 1} · ${op.text.length} 字`;

    const body = document.createElement('div');
    body.className = 'ai-write-body';
    body.textContent = op.text;

    const acts = document.createElement('div');
    acts.className = 'ai-write-acts';

    const btnWrite = document.createElement('button');
    btnWrite.className = 'primary';
    btnWrite.textContent = '替换全文';
    const btnAppend = document.createElement('button');
    btnAppend.textContent = '追加到末尾';
    const btnDrop = document.createElement('button');
    btnDrop.textContent = '放弃';

    const done = (label) => {
      acts.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
        b.classList.remove('primary');
      });
      btnDrop.remove();
      const tag = document.createElement('span');
      tag.className = 'ai-write-done';
      tag.textContent = label;
      acts.append(tag);
    };

    btnWrite.onclick = () => done(writeInto(op, 'replace', paneKey));
    btnAppend.onclick = () => done(writeInto(op, 'append', paneKey));
    btnDrop.onclick = () => card.remove();

    acts.append(btnWrite, btnAppend, btnDrop);
    card.append(head, body, acts);
    if (op.reason) {
      const reason = document.createElement('div');
      reason.className = 'ai-edit-reason';
      reason.textContent = op.reason;
      card.append(reason);
    }
    return card;
  }

  // ---------- 发送 / 流式接收 ----------

  function renderStream() {
    if (!run.body) return;
    const prose = splitProse(run.buffer);
    run.body.textContent = prose || '正在整理修改建议…';
    el.log.scrollTop = el.log.scrollHeight;
  }

  function finishAnswer() {
    const full = run.buffer;
    const prose = splitProse(full);
    run.body.textContent = prose || '（模型没有返回说明）';
    const ops = parseOps(full);
    if (!ops.length) {
      const hint = document.createElement('div');
      hint.className = 'ai-hint';
      hint.textContent = '本次没有产生可落地的修改或草稿。';
      run.editsBox.append(hint);
    } else {
      ops.forEach((op, i) => {
        run.editsBox.append(op.op === 'write' ? buildWriteCard(op, i, run.paneKey) : buildEditCard(op, i, run.paneKey));
      });
    }
    el.log.scrollTop = el.log.scrollHeight;
  }

  async function send() {
    if (run.busy) return;
    const ctx = aiContext();
    const instruction = el.input.value.trim();
    if (!ctx) {
      if (typeof toast === 'function') toast('这里没有可编辑的内容');
      return;
    }
    if (!instruction) {
      if (typeof toast === 'function') toast('先写一句要求，比如“帮我写第 1 章正文”');
      return;
    }
    const source = ctx.read();

    const images = atts.filter((a) => a.kind === 'image');
    const textAtts = atts.filter((a) => a.kind === 'text');
    appendMessage('user', instruction, atts.slice());
    atts = [];
    renderAtts();
    el.input.value = '';
    autoGrow();
    run.busy = true;
    run.buffer = '';
    run.paneKey = ctx.key;
    run.id = 'ai-' + ++run.seq;
    el.send.classList.add('hidden');
    el.stop.classList.remove('hidden');

    const pending = appendMessage('assistant', '思考中…');
    run.body = pending.body;
    const editsBox = document.createElement('div');
    editsBox.className = 'ai-edits';
    pending.wrap.append(editsBox);
    run.editsBox = editsBox;

    const shown = !source.trim()
      ? '（当前内容为空，可直接生成新内容）'
      : source.length > THE_MAX
        ? '…（前文已省略）…\n' + source.slice(-THE_MAX)
        : source;

    const parts = [`【当前编辑内容（${ctx.label}）】`, '<<<', shown, '>>>'];
    const bg = await backgroundText();
    if (bg) parts.push('', bg);
    if (images.length) {
      parts.push('', '【附图】已随消息附上 ' + images.length + ' 张图片：' + images.map((a) => a.name).join('、') + '。');
    }
    if (textAtts.length) {
      let budget = MAX_ATTACH_CHARS;
      const blocks = [];
      for (const a of textAtts) {
        if (budget <= 0) break;
        const body = String(a.text || '').slice(0, budget);
        budget -= body.length;
        blocks.push('【附件：' + a.name + '】', '<<<', body, '>>>');
      }
      if (blocks.length) parts.push('', ...blocks);
    }
    parts.push('', '【修改要求】', instruction);

    // 有图片时走多模态内容数组（主进程会自动切到视觉模型），纯文字仍沿用原来的字符串格式
    const userContent = images.length
      ? [{ type: 'text', text: parts.join('\n') }, ...images.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }))]
      : parts.join('\n');

    const messages = [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    try {
      const res = await window.mushu.aiChat(run.id, messages);
      if (!res || !res.ok) throw new Error((res && res.error) || 'AI 调用失败');
      const data = res.data || {};
      if (data.cancelled) {
        run.body.textContent = splitProse(run.buffer) || '（已停止）';
      } else {
        finishAnswer();
      }
    } catch (err) {
      run.body.textContent = '调用失败：' + (err && err.message ? err.message : err);
      run.body.classList.add('ai-error');
    } finally {
      run.busy = false;
      el.send.classList.remove('hidden');
      el.stop.classList.add('hidden');
    }
  }

  // ---------- 事件绑定 ----------

  window.mushu.onAiDelta((payload) => {
    if (!payload || payload.id !== run.id || !run.busy) return;
    run.buffer += payload.text;
    renderStream();
  });

  el.send.onclick = () => send();
  el.stop.onclick = async () => {
    if (!run.busy || !run.id) return;
    await window.mushu.aiCancel(run.id);
  };

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('focus', refreshContext);
  const castName = $('cast-name');
  if (castName) castName.addEventListener('input', refreshContext);
  const chapterTitle = $('chapter-title');
  if (chapterTitle) chapterTitle.addEventListener('input', refreshContext);

  // 左栏页签切换由 app.js 负责调用；这里只盯住画布的显隐
  window.mushuRefreshAiContext = refreshContext;
  const canvasPane = $('canvas-pane');
  if (canvasPane) {
    new MutationObserver(refreshContext).observe(canvasPane, { attributes: true, attributeFilter: ['class'] });
  }
  refreshContext();
  autoGrow();
})();
