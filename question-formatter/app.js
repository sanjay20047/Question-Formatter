/* Question Formatter — main script
 * ---------------------------------
 * Pipeline overview
 *
 *   user types markdown
 *           │
 *           ▼
 *   normalizeMarkdown   (clean up whitespace, prevent setext-heading misparses,
 *                        collapse blank lines after bold-only "label" lines)
 *           │
 *           ▼
 *   marked.parse        (markdown → HTML in the on-screen #output panel)
 *           │
 *           ▼
 *   postProcessHtml     (display-only: strip <p> from <li>, wrap tables in
 *                        a horizontally scrollable container)
 *
 *   user clicks "Copy Rich Text"
 *           ▼
 *   buildCopyHtml       (assembles the HTML that goes on the clipboard)
 *     applyCopyInlineStyles
 *     convertTablesToPre        (always — Examly mangles real <table> on paste)
 *     flattenListsToParagraphs  (always — every <li> becomes its own
 *                                <p data-list-item>; Examly mangles real
 *                                <ol>/<ul>, and one-<p>-with-<br>-separators
 *                                splits 3:1 inside Examly. Per-item <p>s
 *                                avoid both bugs.)
 *     forceZeroBlockMargins     (margin: 0 !important on every block)
 *     insertBlankLineSpacers    (smart rule: spacer between adjacent blocks
 *                                EXCEPT when the next block is a list item.
 *                                That keeps section headers sticky to their
 *                                bullets and consecutive bullets tight,
 *                                while putting one blank line between every
 *                                section / between adjacent test cases.)
 *     appendFinalSentinels      (invisible trailing blocks so destination
 *                                editor doesn't promote the user's last
 *                                bullet to a heading)
 *
 * The "Sample" panel and presets are preserved from the previous version,
 * but driven detection has been pruned aggressively. The only flag that
 * actually changes the pipeline is `blankLineSpacers` (0/1/2). Everything
 * else (flatten, convert tables, bold-prefix, no-merge) is now hard-wired
 * because making it sample-driven introduced more bugs than it solved
 * (CloudLab labels were being merged like Playwright test-case headers,
 * Playwright real-list samples were turning the flatten step off, etc.).
 * The preset is now mainly an organizational aid: switch between named
 * formats without reloading the page; the Sample doubles as a visual
 * reference next to the Output. */

(() => {
  'use strict';

  // ------------------ DOM references ------------------
  const markdownInput   = document.getElementById('markdownInput');
  const fileInput       = document.getElementById('fileInput');
  const clearBtn        = document.getElementById('clearBtn');
  const output          = document.getElementById('output');
  const copyRichBtn     = document.getElementById('copyRichBtn');
  const copyMdBtn       = document.getElementById('copyMdBtn');
  const toast           = document.getElementById('toast');

  const sampleInput     = document.getElementById('sampleInput');
  const sampleBody      = document.getElementById('sampleBody');
  const sampleToggleBtn = document.getElementById('sampleToggleBtn');
  const presetSelect    = document.getElementById('presetSelect');
  const savePresetBtn   = document.getElementById('savePresetBtn');
  const deletePresetBtn = document.getElementById('deletePresetBtn');
  const detectedStatus  = document.getElementById('detectedStatus');

  // ------------------ marked config ------------------
  marked.setOptions({
    gfm: true,
    breaks: true,        // single newlines → <br> (matches how the source markdown is written)
    headerIds: false,
    mangle: false,
  });

  // ============================================================
  //                        Markdown normalization
  // ============================================================
  /* The destination editor (Examly) is more sensitive to markdown source
     style than a normal renderer would be. These passes paper over a few
     common authoring patterns so the eventual HTML is uniform regardless
     of exactly how the source was written. */
  function normalizeMarkdown(src) {
    if (!src) return '';
    let s = src.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    s = s.split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n');

    // Auto-format plain "Label:" patterns. This is the bridge between
    // CloudLab-style sources (which the user writes as plain text without
    // any markdown markers) and the formatted target output (where every
    // section label is bold and field groups are bullet lists). Lines that
    // already use markdown markers (**bold**, - bullet, # heading, ...)
    // are preserved untouched, so Playwright sources are unaffected.
    s = autoFormatPlainLabels(s);

    // Blank line before a heading, in case the user pasted them tightly.
    s = s.replace(/([^\n])\n(#{1,6} )/g, '$1\n\n$2');

    // Blank line before a markdown table that follows a paragraph.
    s = s.replace(/([^\n])\n(\|.+\|)\n(\|[\s\-:|]+\|)/g, '$1\n\n$2\n$3');

    // Setext-heading defence: "text\n---" or "text\n===" is parsed as an
    // <h2>/<h1>. That bit us when the last bullet of a section was followed
    // by an "---" rule line. Forcing a blank line before makes "---" parse
    // as <hr>.
    s = s.replace(/^([^\n]+)\n([-*_]{3,}|={3,})[ \t]*$/gm, (m, prev, rule) => {
      if (prev.trim() === '') return m;
      return prev + '\n\n' + rule;
    });

    // Collapse blank lines after a bold-prefixed line (label-only OR
    // label-with-content), so long as the next paragraph isn't itself a
    // bold-prefixed section. Examples:
    //   "**Lab Scenario:**\n\nDescription" → "**Lab Scenario:**\nDescription"
    //   "**1. `name`**\n\nVerify..."        → "**1. `name`**\nVerify..."
    //   "**Lab Title:** Azure...\n\n**Lab Scenario:**" — preserved (next
    //                                        line starts with **, kept apart)
    // With breaks: true the collapsed form renders as one <p> with <br>,
    // which gives us the visual gap of a single line break between label
    // and description (instead of an extra paragraph margin).
    s = s.replace(/^(\*\*[^*\n]+\*\*[^\n]*)\n\n+(?=[^\s*])/gm, '$1\n');

    s = collapseListBlankLines(s);
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  function collapseListBlankLines(text) {
    const lines = text.split('\n');
    const out = [];
    const isListLine = (l) => /^[ \t]*([-*+]|\d+\.)\s/.test(l);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        let prev = i - 1;
        while (prev >= 0 && lines[prev].trim() === '') prev--;
        let next = i + 1;
        while (next < lines.length && lines[next].trim() === '') next++;
        if (prev >= 0 && next < lines.length && isListLine(lines[prev]) && isListLine(lines[next])) {
          continue; // tight list — drop the blank line
        }
      }
      out.push(lines[i]);
    }
    return out.join('\n');
  }

  /* ----------------------------------------------------------------
     autoFormatPlainLabels
     ----------------------------------------------------------------
     Turns plain-text "label" sources (the user's CloudLab style) into
     proper markdown:

       Source ("Label" lines have no markdown markers):
         Lab Scenario:
         CloudFirst Solutions, a SaaS company, has been...

         Lab Objective:
         Deploy a Log Analytics workspace as the central hub...
         Create a storage account to serve as a monitored resource.
         Enable diagnostic settings...

         Storage Account:
         Name: [your_resource_group_name]monstore
         Region: East US

       After auto-format:
         **Lab Scenario:**
         CloudFirst Solutions, a SaaS company, has been...

         **Lab Objective:**
         - Deploy a Log Analytics workspace as the central hub...
         - Create a storage account to serve as a monitored resource.
         - Enable diagnostic settings...

         **Storage Account:**
         - Name: [your_resource_group_name]monstore
         - Region: East US

     Rules
       1. A line that already starts with a markdown marker (`**bold`,
          `- item`, `# heading`, `> quote`, `` ` ``, `|`, `1. ordered`)
          is preserved untouched. So Playwright sources, which already
          use proper markdown, are NOT changed.
       2. A "label-only" line (`Lab Scenario:` — line ends with `:`,
          short prefix, starts with capital) is wrapped in `**...**`.
       3. A "label-value" line (`Task 1: Create...` — short prefix,
          colon, then content) gets `**Label:**` bolding around the
          label part — UNLESS it lives inside a bullet group (see #4),
          in which case it stays plain so it reads as a field, not a
          section heading.
       4. A label-only line followed DIRECTLY (no blank line between)
          by 2+ non-blank, non-label-only content lines starts a
          "bullet group": each of those content lines gets a `- `
          prefix. This is what turns plain Lab-Objective sentences
          and plain Storage-Account fields into bullet lists. A
          single-line follow-up stays a paragraph, so a label like
          "Lab Scenario:" with one descriptive paragraph isn't
          wrongly bulleted.
     ---------------------------------------------------------------- */
  function autoFormatPlainLabels(source) {
    if (!source) return '';
    const lines = source.split('\n');
    const types = lines.map(classifyLineForLabels);

    const asBullet = new Array(lines.length).fill(false);
    let i = 0;
    while (i < lines.length) {
      if (types[i] === 'LABEL_ONLY') {
        const j0 = i + 1;
        if (j0 >= lines.length || types[j0] === 'BLANK') {
          // Blank line right after the label — content is a separate
          // section, not a bullet group.
          i = j0;
          continue;
        }
        let j = j0;
        while (j < lines.length && types[j] !== 'BLANK' && types[j] !== 'LABEL_ONLY') {
          j++;
        }
        if (j - j0 >= 2) {
          for (let k = j0; k < j; k++) asBullet[k] = true;
        }
        i = j;
      } else {
        i++;
      }
    }

    const out = [];
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      const trimmed = line.trim();
      const indent = line.match(/^\s*/)[0];

      switch (types[k]) {
        case 'BLANK':
        case 'PRESERVED':
          out.push(line);
          break;
        case 'LABEL_ONLY':
          out.push(`${indent}**${trimmed}**`);
          break;
        case 'LABEL_VALUE':
          if (asBullet[k]) {
            // Field inside a bullet group — keep "Field: value" plain,
            // just add the bullet marker. Matches the user's reference
            // (`- Name: novalake`, label not separately bolded).
            out.push(`${indent}- ${trimmed}`);
          } else {
            // Top-level "Label: value" line — bold just the label part
            // (everything up to and including the first colon).
            out.push(`${indent}${trimmed.replace(/^([^:]+:)/, '**$1**')}`);
          }
          break;
        case 'PARAGRAPH':
          if (asBullet[k]) {
            out.push(`${indent}- ${trimmed}`);
          } else {
            out.push(line);
          }
          break;
      }
    }
    return out.join('\n');
  }

  function classifyLineForLabels(line) {
    const trimmed = line.trim();
    if (trimmed === '') return 'BLANK';

    // Already-formatted lines — preserve as-is.
    if (trimmed.startsWith('**') ||
        trimmed.startsWith('- ') ||
        trimmed.startsWith('* ') ||
        trimmed.startsWith('+ ') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('>') ||
        trimmed.startsWith('`') ||
        trimmed.startsWith('|') ||
        /^\d+[.)]\s/.test(trimmed)) {
      return 'PRESERVED';
    }

    // Label-only — capital-led, ends with ":", reasonable label length.
    if (/^[A-Z][\w\s\-&()./'"]{0,60}:$/.test(trimmed)) return 'LABEL_ONLY';

    // Label-value — capital-led "Word(s):" then space + content.
    if (/^[A-Z][\w\s\-&()./'"]{0,60}:\s+\S/.test(trimmed)) return 'LABEL_VALUE';

    return 'PARAGRAPH';
  }

  // ============================================================
  //                        Display post-processing
  // ============================================================
  /* Display-only tweaks for the #output panel (does NOT affect what goes
     on the clipboard — that's all in buildCopyHtml). */
  function postProcessHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    // Strip <p> from inside <li> for clean visual rendering of loose lists.
    tmp.querySelectorAll('li').forEach(li => {
      const ps = Array.from(li.children).filter(c => c.tagName === 'P');
      ps.forEach((p, idx) => {
        if (idx > 0) li.insertBefore(document.createElement('br'), p);
        while (p.firstChild) li.insertBefore(p.firstChild, p);
        p.remove();
      });
    });

    // Wrap tables in a horizontally scrollable wrapper so wide URL columns
    // don't push the panel sideways.
    tmp.querySelectorAll('table').forEach(table => {
      if (table.parentElement && table.parentElement.classList.contains('table-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });

    return tmp.innerHTML;
  }

  // ============================================================
  //                        Render (display)
  // ============================================================
  function render() {
    const raw = markdownInput.value;
    if (!raw.trim()) {
      output.innerHTML = '<p class="text-slate-400 italic">Your formatted question will appear here.</p>';
      return;
    }
    let html = marked.parse(normalizeMarkdown(raw));
    html = postProcessHtml(html);
    output.innerHTML = html;
  }

  // ============================================================
  //                        Sample-flag detection
  // ============================================================
  /* Most of the previous flag-driven behaviour has been hard-coded after
     it caused regressions (CloudLab labels being merged, Playwright real-
     lists not getting flattened, etc.). The only flag that still varies
     is blankLineSpacers, which lets a sample with double-spaced sections
     express that preference. */
  function defaultFlags() {
    return { blankLineSpacers: 1 };
  }

  function detectSampleFlags(sampleMarkdown) {
    if (!sampleMarkdown || !sampleMarkdown.trim()) return defaultFlags();
    const md = normalizeMarkdown(sampleMarkdown);
    return { blankLineSpacers: inferBlankLineMode(md) };
  }

  function inferBlankLineMode(md) {
    const lines = md.split('\n');
    const runs = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim() === '') {
        let run = 0;
        while (i < lines.length && lines[i].trim() === '') { run++; i++; }
        if (i < lines.length) {
          let hadPrior = false;
          for (let j = i - run - 1; j >= 0; j--) {
            if (lines[j].trim() !== '') { hadPrior = true; break; }
          }
          if (hadPrior) runs.push(run);
        }
      } else { i++; }
    }
    if (!runs.length) return defaultFlags().blankLineSpacers;
    const counts = {};
    runs.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
    let best = 1, bestCount = -1;
    Object.keys(counts).forEach(k => {
      const n = parseInt(k, 10);
      if (counts[k] > bestCount && n >= 0 && n <= 2) {
        best = n; bestCount = counts[k];
      }
    });
    return best;
  }

  let currentFlags = defaultFlags();

  // ============================================================
  //                        Copy HTML pipeline
  // ============================================================
  function buildCopyHtml(flags) {
    flags = flags || defaultFlags();
    const div = document.createElement('div');
    div.innerHTML = output.innerHTML;

    applyCopyInlineStyles(div);
    convertTablesToPre(div);
    flattenListsToParagraphs(div);
    forceZeroBlockMargins(div);
    for (let i = 0; i < flags.blankLineSpacers; i++) insertBlankLineSpacers(div);
    appendFinalSentinels(div);

    return div.innerHTML;
  }

  function applyCopyInlineStyles(div) {
    div.querySelectorAll('table').forEach(t => {
      t.setAttribute('border', '1');
      t.style.borderCollapse = 'collapse';
      t.style.width = '100%';
    });
    div.querySelectorAll('th, td').forEach(c => {
      c.style.border = '1px solid #999';
      c.style.padding = '6px 10px';
      c.style.verticalAlign = 'top';
      c.style.textAlign = 'left';
    });
    div.querySelectorAll('th').forEach(t => {
      t.style.background = '#f3f4f6';
      t.style.fontWeight = 'bold';
    });
    div.querySelectorAll('code').forEach(c => {
      if (c.parentElement && c.parentElement.tagName === 'PRE') return;
      c.style.fontFamily = 'Consolas, Monaco, monospace';
      c.style.background = '#f3f4f6';
      c.style.padding = '1px 4px';
      c.style.borderRadius = '3px';
      c.style.fontSize = '0.95em';
      // <code> inside <strong> needs to inherit weight or Examly's base
      // stylesheet (`code { font-weight: normal }`) wins and the test-case
      // names render plain instead of bold.
      c.style.fontWeight = 'inherit';
    });
    div.querySelectorAll('pre').forEach(p => {
      p.style.background = '#f3f4f6';
      p.style.padding = '10px 12px';
      p.style.borderRadius = '4px';
      p.style.fontFamily = 'Consolas, Monaco, monospace';
      p.style.fontSize = '0.9em';
      p.style.whiteSpace = 'pre-wrap';
      p.querySelectorAll('code').forEach(c => {
        c.style.background = 'transparent';
        c.style.padding = '0';
        c.style.fontFamily = 'inherit';
        c.style.border = 'none';
      });
    });
    div.querySelectorAll('h1').forEach(el => {
      el.style.fontSize = '24px';
      el.style.fontWeight = 'bold';
      el.style.margin = '0 0 12px 0';
    });
    div.querySelectorAll('h2').forEach(el => {
      el.style.fontSize = '18px';
      el.style.fontWeight = 'bold';
      el.style.margin = '18px 0 6px 0';
    });
    div.querySelectorAll('h3').forEach(el => {
      el.style.fontSize = '15px';
      el.style.fontWeight = 'bold';
      el.style.margin = '14px 0 4px 0';
    });
  }

  // -------------------------- Tables → <pre> --------------------------
  /* Render the <table> as a fixed-width ASCII grid inside a <pre>. The
     grid is what the destination editor handles cleanly — real <table>
     elements are unreliable across editors, especially Examly. */
  function convertTablesToPre(container) {
    container.querySelectorAll('table').forEach(table => {
      const rows = Array.from(table.querySelectorAll('tr'));
      if (!rows.length) return;

      const cellRows = rows.map(row =>
        Array.from(row.querySelectorAll('th, td')).map(cell =>
          (cell.textContent || '').replace(/\s+/g, ' ').trim()
        )
      );

      const numCols = Math.max(...cellRows.map(r => r.length));
      const colWidths = new Array(numCols).fill(0);
      cellRows.forEach(row => {
        for (let i = 0; i < numCols; i++) {
          const len = (row[i] || '').length;
          if (len > colWidths[i]) colWidths[i] = len;
        }
      });

      const formatRow = (row) =>
        colWidths.map((w, i) => (row[i] || '').padEnd(w)).join(' | ');

      const lines = [formatRow(cellRows[0])];
      lines.push(colWidths.map(w => '-'.repeat(w)).join('-+-'));
      for (let i = 1; i < cellRows.length; i++) lines.push(formatRow(cellRows[i]));

      const pre = document.createElement('pre');
      pre.style.background = '#f3f4f6';
      pre.style.padding = '10px 12px';
      pre.style.borderRadius = '4px';
      pre.style.fontFamily = 'Consolas, Monaco, monospace';
      pre.style.fontSize = '0.9em';
      pre.style.whiteSpace = 'pre';
      pre.style.overflowX = 'auto';
      pre.style.margin = '8px 0';
      pre.style.border = '1px solid #ddd';
      pre.style.color = '#0f172a';
      pre.textContent = lines.join('\n');

      const wrapper = table.closest('.table-wrap');
      const target = wrapper || table;
      target.parentNode.replaceChild(pre, target);
    });
  }

  // ----------------------- Flatten lists ------------------------------
  /* Each <li> from any <ol>/<ul> becomes its own <p data-list-item>.
     This is different from the previous version (which packed the whole
     list into one <p> joined by <br>). The single-paragraph-with-<br>
     approach was being split 3:1 inside Examly, producing the empty-list-
     item bug we kept hitting. Per-item <p>s sidestep that completely:
     each item is one paragraph that can't be re-split.

     The matching `insertBlankLineSpacers` rule below knows that adjacent
     [data-list-item] paragraphs should *not* get a spacer between them,
     so they stack tightly the way real bullets would. */
  const NBSP = ' ';

  function flattenListsToParagraphs(container) {
    const rebuilt = [];
    Array.from(container.childNodes).forEach(child => {
      const result = transformForCopy(child, 0);
      if (Array.isArray(result)) rebuilt.push(...result);
      else if (result) rebuilt.push(result);
    });
    while (container.firstChild) container.removeChild(container.firstChild);
    rebuilt.forEach(n => container.appendChild(n));
  }

  function transformForCopy(node, indent) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return node.cloneNode(true);
    }
    if (node.tagName === 'OL' || node.tagName === 'UL') {
      return flattenSingleList(node, indent);
    }
    const clone = node.cloneNode(false);
    Array.from(node.childNodes).forEach(child => {
      const result = transformForCopy(child, indent);
      if (Array.isArray(result)) result.forEach(r => clone.appendChild(r));
      else if (result) clone.appendChild(result);
    });
    return clone;
  }

  function flattenSingleList(list, indent) {
    const isOrdered = list.tagName === 'OL';
    const startAttr = parseInt(list.getAttribute('start') || '1', 10);
    const items = Array.from(list.children).filter(c => c.tagName === 'LI');
    const indentStr = NBSP.repeat(indent * 4);
    const out = [];

    items.forEach((li, idx) => {
      const tok = isOrdered ? `${startAttr + idx}.` : '•';
      // Bold prefix via styled <span> rather than <strong>/<b>. Some editors
      // treat a leading <strong> as a heading marker.
      const prefix = `<span style="font-weight: bold;">${tok}</span>${NBSP}`;

      let inlineHtml = '';
      const nestedLists = [];
      Array.from(li.childNodes).forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'OL' || child.tagName === 'UL')) {
          nestedLists.push(child);
        } else {
          const tmp = document.createElement('span');
          const transformed = transformForCopy(child, indent);
          if (Array.isArray(transformed)) transformed.forEach(t => tmp.appendChild(t));
          else if (transformed) tmp.appendChild(transformed);
          inlineHtml += tmp.innerHTML;
        }
      });

      const p = document.createElement('p');
      p.setAttribute('data-list-item', 'true');
      p.setAttribute('style',
        'margin: 0 !important; padding: 0 !important; line-height: 1.6; ' +
        'font-weight: normal; font-size: 14px; font-family: inherit;');
      p.innerHTML = indentStr + prefix + inlineHtml;
      out.push(p);

      // Nested lists: emit their items as additional list-item paragraphs
      // at indent+1. The smart spacer rule will keep them tight against
      // their parent.
      nestedLists.forEach(nl => {
        const nested = flattenSingleList(nl, indent + 1);
        nested.forEach(n => out.push(n));
      });
    });

    return out;
  }

  // ----------------------- Force zero margins -------------------------
  function forceZeroBlockMargins(container) {
    container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, table, ul, ol').forEach(el => {
      el.style.setProperty('margin', '0', 'important');
      el.style.setProperty('padding-top', '0', 'important');
      el.style.setProperty('padding-bottom', '0', 'important');
    });
  }

  // ----------------------- Smart blank-line spacers -------------------
  /* Insert a <p><br></p> spacer between adjacent block children — except
     when the next block is a list item.

         non-list  →  list-item    : no spacer  (label sticks to its bullets)
         list-item →  list-item    : no spacer  (consecutive bullets stack)
         list-item →  non-list     : spacer     (gap after list)
         non-list  →  non-list     : spacer     (gap between sections)

     This is what produces the desired layout for both Playwright (test-case
     header sticks to its bullets, blank line between test cases) and
     CloudLab (label sticks to its bullets, blank line between sections),
     without needing the `mergeTestCaseSections` heuristic that wrongly
     fired on every CloudLab `**Lab Title:**` style label. */
  function insertBlankLineSpacers(container) {
    const isListItem = (el) =>
      el && el.nodeType === Node.ELEMENT_NODE &&
      el.tagName === 'P' &&
      el.getAttribute('data-list-item') === 'true';

    const els = Array.from(container.children);
    const result = [];
    els.forEach((el, idx) => {
      result.push(el);
      if (idx === els.length - 1) return;
      const next = els[idx + 1];
      if (isListItem(next)) return;          // sticky / tight
      // Spacer.
      const spacer = document.createElement('p');
      spacer.innerHTML = '<br>';
      spacer.setAttribute('style', 'margin: 0 !important; padding: 0 !important;');
      result.push(spacer);
    });
    while (container.firstChild) container.removeChild(container.firstChild);
    result.forEach(el => container.appendChild(el));
  }

  // ----------------------- Final sentinels ----------------------------
  /* Two neutral trailing blocks so the destination editor doesn't promote
     the user's *real* last bullet to a heading-like style (it loves doing
     that to the very last block of a paste). The sentinels become the
     "last block" instead, where the auto-promotion is invisible. */
  function appendFinalSentinels(div) {
    const p = document.createElement('p');
    p.innerHTML = '<br>';
    p.setAttribute('style',
      'margin: 0 !important; padding: 0 !important; font-weight: normal; ' +
      'font-size: 14px; line-height: 1;');
    div.appendChild(p);

    const tail = document.createElement('div');
    tail.innerHTML = '&nbsp;';
    tail.setAttribute('style',
      'margin: 0 !important; padding: 0 !important; font-weight: normal; ' +
      'font-size: 14px; line-height: 1; color: transparent;');
    div.appendChild(tail);
  }

  // ============================================================
  //                        Sample / preset module
  // ============================================================
  const STORAGE_KEY = 'qf:presets';

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.presets)) return null;
      return obj;
    } catch (e) { return null; }
  }

  function saveStore(store) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch (e) { /* localStorage unavailable — ignore */ }
  }

  function seedDefaults() {
    return {
      presets: [
        { name: 'Playwright', sampleText: PLAYWRIGHT_SAMPLE },
        { name: 'CloudLab',   sampleText: CLOUDLAB_SAMPLE },
      ],
      selected: 'Playwright',
      sampleCollapsed: false,
    };
  }

  function initSampleSection() {
    let store = loadStore();
    if (!store) { store = seedDefaults(); saveStore(store); }

    const refreshPresetDropdown = () => {
      presetSelect.innerHTML = '';
      store.presets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        if (p.name === store.selected) opt.selected = true;
        presetSelect.appendChild(opt);
      });
    };
    refreshPresetDropdown();

    const findPreset = (name) =>
      store.presets.find(p => p.name === name) || store.presets[0];

    const initial = findPreset(store.selected);
    sampleInput.value = initial ? initial.sampleText : '';
    recomputeFlagsFromSample();

    applyCollapsed(store.sampleCollapsed);

    let sampleDebounce = null;
    sampleInput.addEventListener('input', () => {
      clearTimeout(sampleDebounce);
      sampleDebounce = setTimeout(() => {
        recomputeFlagsFromSample();
        const p = findPreset(store.selected);
        if (p) { p.sampleText = sampleInput.value; saveStore(store); }
        render();
      }, 200);
    });

    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      store.selected = name;
      saveStore(store);
      const p = findPreset(name);
      sampleInput.value = p ? p.sampleText : '';
      recomputeFlagsFromSample();
      render();
    });

    savePresetBtn.addEventListener('click', () => {
      const name = (prompt('Save current sample as preset. Name?') || '').trim();
      if (!name) return;
      const existing = store.presets.find(p => p.name === name);
      if (existing) {
        if (!confirm(`Overwrite preset "${name}"?`)) return;
        existing.sampleText = sampleInput.value;
      } else {
        store.presets.push({ name, sampleText: sampleInput.value });
      }
      store.selected = name;
      saveStore(store);
      refreshPresetDropdown();
      showToast('Preset saved');
    });

    deletePresetBtn.addEventListener('click', () => {
      if (store.presets.length <= 1) {
        showToast('Cannot delete the last preset');
        return;
      }
      const name = store.selected;
      if (!confirm(`Delete preset "${name}"?`)) return;
      store.presets = store.presets.filter(p => p.name !== name);
      store.selected = store.presets[0].name;
      saveStore(store);
      refreshPresetDropdown();
      const p = findPreset(store.selected);
      sampleInput.value = p ? p.sampleText : '';
      recomputeFlagsFromSample();
      render();
      showToast('Preset deleted');
    });

    sampleToggleBtn.addEventListener('click', () => {
      store.sampleCollapsed = !store.sampleCollapsed;
      saveStore(store);
      applyCollapsed(store.sampleCollapsed);
    });

    function applyCollapsed(collapsed) {
      sampleBody.style.display = collapsed ? 'none' : '';
      sampleToggleBtn.textContent = collapsed ? 'Show' : 'Hide';
      sampleToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    }
  }

  function recomputeFlagsFromSample() {
    currentFlags = detectSampleFlags(sampleInput.value);
    renderDetectedStatus(currentFlags);
  }

  function renderDetectedStatus(flags) {
    detectedStatus.textContent =
      `Detected: blank-lines ${flags.blankLineSpacers}` +
      ' (other formatting rules are hard-coded for cross-editor reliability)';
  }

  // ============================================================
  //                        Toast + clipboard
  // ============================================================
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
  }

  async function copyRichText() {
    if (!output.innerHTML.trim() || output.querySelector('p.italic')) {
      showToast('Nothing to copy');
      return;
    }
    const html = buildCopyHtml(currentFlags);
    const plain = output.innerText;

    try {
      if (navigator.clipboard && window.ClipboardItem) {
        const item = new ClipboardItem({
          'text/html':  new Blob([html],  { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
        showToast('Copied rich text!');
        return;
      }
    } catch (err) { /* fall through to legacy */ }

    try {
      const stage = document.createElement('div');
      stage.contentEditable = 'true';
      stage.style.position = 'fixed';
      stage.style.left = '-9999px';
      stage.innerHTML = html;
      document.body.appendChild(stage);
      const range = document.createRange();
      range.selectNodeContents(stage);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      document.body.removeChild(stage);
      showToast(ok ? 'Copied rich text!' : 'Copy failed');
    } catch (err) {
      showToast('Copy failed');
    }
  }

  async function copyMarkdown() {
    const md = normalizeMarkdown(markdownInput.value);
    if (!md) { showToast('Nothing to copy'); return; }
    try {
      await navigator.clipboard.writeText(md);
      showToast('Copied markdown!');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = md;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(ok ? 'Copied markdown!' : 'Copy failed');
    }
  }

  // ============================================================
  //                        Wiring
  // ============================================================
  markdownInput.addEventListener('input', render);

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      markdownInput.value = ev.target.result || '';
      render();
    };
    reader.readAsText(file);
    fileInput.value = '';
  });

  clearBtn.addEventListener('click', () => {
    markdownInput.value = '';
    render();
    markdownInput.focus();
  });

  copyRichBtn.addEventListener('click', copyRichText);
  copyMdBtn.addEventListener('click', copyMarkdown);

  // ============================================================
  //                        Seeded preset samples
  // ============================================================
  const PLAYWRIGHT_SAMPLE = `**Playwright – Explicit Synchronization with \`waitForSelector\` on Books to Scrape**

## Scenario

You are practicing explicit synchronization techniques against the Books to Scrape website using Playwright.

## Required Test Cases

**1. \`homepage_loads\`**
Verify the first book card is visible on the homepage after an explicit element wait.
- Navigate to the Books to Scrape homepage
- Wait for the book card elements identified by their shared CSS class to appear in the DOM
- Verify that the first book card is visible

**2. \`waitForSelector_returns_element\`**
Verify the call to wait returns an element handle.
- Navigate to the homepage
- Explicitly wait for the book card elements identified by their shared CSS class and store the returned element handle
- Verify that the returned handle is present
`;

  const CLOUDLAB_SAMPLE = `**Lab Title:** Azure Data Lake Gen2: Enterprise Data Lake with Synapse Analytics Integration

**Lab Scenario:**
Nova Logistics has matured its data lake architecture and now needs to enable SQL-based analytics on top of the data stored in ADLS Gen2.

**Lab Objective:**
- Deploy an ADLS Gen2 storage account with containers organized for analytics workloads.
- Create directory structures within each container for domain-specific data management.
- Deploy an Azure Synapse Analytics workspace connected to the data lake.
- Configure Synapse firewall rules for secure access.
- Validate that the serverless SQL endpoint is accessible for ad-hoc queries.

**Prerequisite**: Ensure you have an active Azure subscription, are logged into the Azure Portal, and are working within your assigned resource group.

**Task Details:**

**Task 1:** Create the ADLS Gen2 Storage Account
**Instruction:** Deploy a storage account with Hierarchical Namespace enabled to serve as the enterprise data lake.
**Storage Account:**
- Name: [your_resource_group_name]novalake
- Region: Central US
- Performance: Standard
- Redundancy: LRS
- Hierarchical Namespace: Enabled
- Allow trusted Azure services: Enabled

**Task 2:** Create Data Lake Containers
**Instruction:** Create four containers representing different stages of the analytics data lifecycle.
**Containers:**
- raw-zone — landing area for unprocessed source data
- transform-zone — intermediate data undergoing cleaning and transformation
- serve-zone — finalized data ready for Synapse SQL queries and dashboards
- archive-zone — historical data retained for compliance and long-term analysis

**Expected Output:**
- A Storage Account named [your_resource_group_name]novalake exists in Central US with HNS enabled and Standard LRS.
- Containers raw-zone, transform-zone, serve-zone, and archive-zone exist in the storage account.
`;

  // ============================================================
  //                        Boot
  // ============================================================
  initSampleSection();
  render();
})();
