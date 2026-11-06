/* ===== 数据分析 Agent · 应用逻辑 ===== */
(function () {
  'use strict';

  var A = window.Analytics;
  var LIMITS = window.APP_CONFIG.limits;
  var cloud = null;

  var state = {
    session: null,
    datasets: [],
    activeId: null,
    dataset: null,
    profile: null,
    analyses: [],
    charts: [],
    busy: false,
    model: null,
    models: null,
    pendingOtp: null,
    authTab: 'email',
    upload: { parsed: null, name: '' }
  };

  /* ================= 工具 ================= */

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function show(node) { if (node) node.classList.remove('hidden'); }
  function hide(node) { if (node) node.classList.add('hidden'); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { hide(t); }, 2600);
  }

  function maskAccount(raw) {
    var s = String(raw || '');
    if (!s) return '我的工作区';
    if (s.indexOf('@') > -1) {
      var p = s.split('@');
      var name = p[0];
      return (name.length <= 2 ? name[0] + '*' : name.slice(0, 2) + '***') + '@' + p[1];
    }
    if (/^\d{6,}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(-2);
    return s;
  }

  /* ================= 云端初始化 ================= */

  function initCloud() {
    if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
      throw new Error('云端 SDK 加载失败，请检查网络后刷新页面');
    }
    cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.APP_CONFIG.cloud.endpoint,
      oauthRelayBaseUrl: window.APP_CONFIG.cloud.oauthRelayBaseUrl,
      publishableKey: window.APP_CONFIG.cloud.publishableKey
    });
  }

  /* ================= 启动 ================= */

  async function boot() {
    try {
      initCloud();
    } catch (err) {
      $('bootText').textContent = err.message;
      return;
    }

    var session = null;
    try {
      var res = await cloud.auth.getSession();
      session = res && res.data;
    } catch (err) {
      session = null;
    }

    hide($('bootScreen'));
    if (session && session.user) {
      state.session = session;
      await enterApp();
    } else {
      show($('authView'));
    }
  }

  async function enterApp() {
    hide($('authView'));
    show($('appView'));
    renderUser();
    await loadDatasets();
    if (state.datasets.length) {
      await openDataset(state.datasets[0].id);
    } else {
      renderEmptyState();
    }
  }

  function renderUser() {
    var user = (state.session && state.session.user) || {};
    var account = user.email || user.phone || '';
    var name = user.name || maskAccount(account) || '分析用户';
    $('userName').textContent = name;
    $('userSub').textContent = user.name ? maskAccount(account) || '已登录' : '已连接云端';
    $('userAvatar').textContent = String(name).slice(0, 1).toUpperCase() || '分';
  }

  /* ================= 登录 ================= */

  function setAuthTab(tab) {
    state.authTab = tab;
    Array.prototype.forEach.call($('authTabs').children, function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    $('emailPane').classList.toggle('hidden', tab !== 'email');
    $('phonePane').classList.toggle('hidden', tab !== 'phone');
    state.pendingOtp = null;
    authError('');
  }

  function authError(msg) {
    var n = $('authError');
    if (!msg) { hide(n); n.textContent = ''; return; }
    n.textContent = msg;
    show(n);
  }

  function currentIdentifier() {
    if (state.authTab === 'email') return { email: $('emailInput').value.trim() };
    return { phone: $('phoneInput').value.trim() };
  }

  var codeTimer = null;

  async function sendCode() {
    var id = currentIdentifier();
    var value = id.email || id.phone;
    if (!value) { authError(state.authTab === 'email' ? '请输入邮箱地址' : '请输入手机号'); return; }
    if (state.authTab === 'phone' && !/^1\d{10}$/.test(value)) {
      authError('请输入正确的 11 位手机号');
      return;
    }
    if (state.authTab === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      authError('请输入正确的邮箱地址');
      return;
    }

    var btn = $('sendCodeBtn');
    btn.disabled = true;
    btn.textContent = '发送中…';
    authError('');

    var res = await cloud.auth.sendOtp(id);
    if (res.error) {
      authError(res.error.message || '验证码发送失败，请稍后重试');
      btn.disabled = false;
      btn.textContent = '获取验证码';
      return;
    }
    state.pendingOtp = {
      identifier: id,
      verificationId: res.data.verificationId,
      isExistingUser: res.data.isExistingUser
    };
    toast('验证码已发送');
    var seconds = 60;
    clearInterval(codeTimer);
    codeTimer = setInterval(function () {
      seconds--;
      if (seconds <= 0) {
        clearInterval(codeTimer);
        btn.disabled = false;
        btn.textContent = '重新获取';
      } else {
        btn.textContent = seconds + 's';
      }
    }, 1000);
  }

  async function submitAuth(e) {
    e.preventDefault();
    var id = currentIdentifier();
    var value = id.email || id.phone;
    var token = $('otpInput').value.trim();

    if (!value) { authError('请输入邮箱或手机号'); return; }
    if (!token) { authError('请输入验证码'); return; }

    var pending = state.pendingOtp;
    var sameTarget = pending && (
      (id.email && pending.identifier.email === id.email) ||
      (id.phone && pending.identifier.phone === id.phone)
    );
    if (!sameTarget) {
      authError('请先获取当前' + (state.authTab === 'email' ? '邮箱' : '手机号') + '的验证码');
      return;
    }

    var btn = $('verifyBtn');
    btn.disabled = true;
    btn.textContent = '验证中…';
    authError('');

    var payload = {
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: token
    };
    if (id.email) payload.email = id.email; else payload.phone = id.phone;

    var res = await cloud.auth.verifyOtp(payload);
    if (res.error) {
      btn.disabled = false;
      btn.textContent = '登录 / 注册';
      authError(res.error.message || '验证码错误或已过期');
      return;
    }

    state.pendingOtp = null;
    btn.disabled = false;
    btn.textContent = '登录 / 注册';
    $('otpInput').value = '';

    var sessionRes = await cloud.auth.getSession();
    state.session = sessionRes && sessionRes.data;
    await enterApp();
  }

  async function logout() {
    try { await cloud.auth.signOut(); } catch (err) { /* 忽略 */ }
    state.session = null;
    state.datasets = [];
    state.activeId = null;
    state.dataset = null;
    await openDataset(null);
    hide($('appView'));
    hide($('workspace'));
    show($('emptyState'));
    show($('authView'));
  }

  /* ================= 数据集列表 ================= */

  async function loadDatasets() {
    var res = await cloud.database
      .from('datasets')
      .select('id,name,source_type,row_count,columns_def,created_at')
      .order('created_at', { ascending: false })
      .limit(60);

    if (res.error) {
      toast('数据集加载失败：' + (res.error.message || '未知错误'));
      state.datasets = [];
    } else {
      state.datasets = res.data || [];
    }
    renderDatasetList();
  }

  function renderDatasetList() {
    var box = $('datasetList');
    box.innerHTML = '';
    if (!state.datasets.length) {
      box.appendChild(el('div', 'side-empty', '还没有数据集'));
      return;
    }
    state.datasets.forEach(function (ds) {
      var btn = el('button', 'ds-item' + (ds.id === state.activeId ? ' active' : ''));
      btn.type = 'button';
      btn.appendChild(el('strong', null, ds.name));
      var date = new Date(ds.created_at);
      btn.appendChild(el('small', null, ds.row_count + ' 行 · ' + (date.getMonth() + 1) + '/' + date.getDate()));
      btn.addEventListener('click', function () { openDataset(ds.id); });
      box.appendChild(btn);
    });
  }

  function renderEmptyState() {
    hide($('workspace'));
    hide($('previewDataBtn'));
    hide($('deleteDatasetBtn'));
    show($('emptyState'));
    $('topTitle').textContent = '选择或新建数据集';
    $('topMeta').textContent = '支持 CSV / TSV / Excel / 粘贴表格';
  }

  /* ================= 打开数据集 ================= */

  async function openDataset(id) {
    destroyCharts();
    state.analyses = [];
    $('thread').innerHTML = '';

    if (!id) {
      state.activeId = null;
      state.dataset = null;
      state.profile = null;
      renderDatasetList();
      renderEmptyState();
      return;
    }

    state.activeId = id;
    renderDatasetList();
    var meta = state.datasets.filter(function (d) { return d.id === id; })[0];
    $('topTitle').textContent = meta ? meta.name : '加载中…';
    $('topMeta').textContent = '正在读取数据…';
    show($('workspace'));
    hide($('emptyState'));

    var res = await cloud.database.from('datasets').select('*').eq('id', id).maybeSingle();
    if (res.error || !res.data) {
      toast('读取数据集失败：' + (res.error ? res.error.message : '数据不存在'));
      renderEmptyState();
      return;
    }

    var row = res.data;
    state.dataset = {
      id: row.id,
      name: row.name,
      columns: row.columns_def || [],
      rows: row.rows_data || [],
      rowCount: row.row_count || 0
    };
    state.profile = A.profile(state.dataset);

    $('topTitle').textContent = row.name;
    $('topMeta').textContent = state.dataset.rowCount + ' 行 · ' + state.dataset.columns.length + ' 列 · 保存在云端';
    show($('previewDataBtn'));
    show($('deleteDatasetBtn'));

    renderStats();
    renderChips();
    await loadHistory(id);
  }

  function renderStats() {
    var p = state.profile;
    var box = $('statRow');
    box.innerHTML = '';
    box.appendChild(statCard('数据规模', p.rowCount + ' 行', p.colCount + ' 列'));
    if (p.numericCols.length) {
      var t = p.totals[0];
      box.appendChild(statCard(t.column + ' 合计', A.compactNumber(t.sum)));
      if (p.totals[1]) box.appendChild(statCard(p.totals[1].column + ' 合计', A.compactNumber(p.totals[1].sum)));
    }
    if (p.dateRange) {
      box.appendChild(statCard('时间跨度', A.formatMonthShort(p.dateRange.from) + ' → ' + A.formatMonthShort(p.dateRange.to)));
    }
    box.appendChild(statCard('字段构成', p.numericCols.length + ' 数值', p.categoryCols.length + ' 文本'));
  }

  function statCard(k, v, sub) {
    var c = el('div', 'stat-card');
    c.appendChild(el('div', 'k', k));
    var val = el('div', 'v', v);
    if (sub) {
      var s = el('small', null, sub);
      val.appendChild(s);
    }
    c.appendChild(val);
    return c;
  }

  function renderChips() {
    var p = state.profile;
    var dateCol = p.dateCols[0];
    var numCol = p.numericCols[0];
    var catCol = p.categoryCols[0];
    var chips = [];
    chips.push({ label: '数据总览', q: '帮我整体概览这份数据，总结核心指标和分布情况' });
    if (dateCol && numCol) chips.push({ label: '趋势分析', q: '按' + dateCol.name + '看' + numCol.name + '的变化趋势，并说明关键拐点' });
    if (catCol && numCol) chips.push({ label: '指标对比', q: '对比不同' + catCol.name + '的' + numCol.name + '差异，指出最高和最低，并计算差距' });
    chips.push({ label: '异常识别', q: '找出数据中明显异常的记录或时间点，说明偏离程度和可能原因' });
    if (catCol && numCol) chips.push({ label: 'TOP 排名', q: '按' + catCol.name + '排出' + numCol.name + '最高的前 10 名' });
    if (numCol && p.categoryCols[1]) chips.push({ label: '交叉分析', q: '同时按' + p.categoryCols[1].name + '和' + catCol.name + '看' + numCol.name + '的分布' });
    chips.push({ label: '数据明细', q: '列出几条明细数据，看看数据长什么样' });

    var box = $('chips');
    box.innerHTML = '';
    chips.slice(0, 6).forEach(function (c) {
      var b = el('button', 'chip', c.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        $('askInput').value = c.q;
        autoGrow();
        $('askInput').focus();
      });
      box.appendChild(b);
    });
  }

  /* ================= 历史分析 ================= */

  async function loadHistory(datasetId) {
    var res = await cloud.database
      .from('analyses')
      .select('*')
      .eq('dataset_id', datasetId)
      .order('created_at', { ascending: true })
      .limit(20);

    var thread = $('thread');
    if (res.error) {
      thread.appendChild(el('div', 'thread-intro', '历史记录读取失败：' + (res.error.message || '未知错误')));
      return;
    }
    state.analyses = res.data || [];

    if (!state.analyses.length) {
      thread.appendChild(el('div', 'thread-intro',
        '数据已就绪。用一句话提问，Agent 会规划取数方式、按真实数据计算指标，然后出图并给出结论。'));
      return;
    }

    thread.appendChild(el('div', 'thread-intro', '以下是这个数据集最近的分析记录'));
    state.analyses.forEach(function (item) {
      var payload = item.result || {};
      buildCard({
        title: payload.title || '分析结果',
        question: item.question,
        intent: payload.intent || item.intent,
        metaText: payload.metaText,
        note: payload.note,
        chart: payload.chart,
        table: payload.table,
        answer: item.answer || '',
        createdAt: item.created_at
      }, false);
    });
  }

  /* ================= 图表 ================= */

  var PALETTE = ['#4f46e5', '#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6'];

  function destroyCharts() {
    state.charts.forEach(function (c) { try { c.destroy(); } catch (e) { /* noop */ } });
    state.charts = [];
  }

  function renderChart(canvas, spec) {
    if (!spec || !spec.labels || !spec.labels.length || !window.Chart) return null;
    var type = spec.type === 'doughnut' ? 'doughnut' : spec.type;
    var isPie = type === 'pie' || type === 'doughnut';
    var series = isPie ? spec.series.slice(0, 1) : spec.series;

    var datasets = series.map(function (s, i) {
      var color = PALETTE[i % PALETTE.length];
      if (type === 'line') {
        return {
          label: s.label,
          data: s.values,
          borderColor: color,
          backgroundColor: color + '1f',
          borderWidth: 2,
          pointRadius: s.values.length > 24 ? 0 : 3,
          pointHoverRadius: 5,
          tension: 0.32,
          fill: false,
          spanGaps: true
        };
      }
      if (isPie) {
        return {
          label: s.label,
          data: s.values,
          backgroundColor: spec.labels.map(function (_, idx) { return PALETTE[idx % PALETTE.length] + 'd9'; }),
          borderColor: '#fff',
          borderWidth: 2
        };
      }
      return {
        label: s.label,
        data: s.values,
        backgroundColor: color + 'd0',
        hoverBackgroundColor: color,
        borderRadius: 6,
        maxBarThickness: 42
      };
    });

    var options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 420 },
      interaction: { mode: isPie ? 'nearest' : 'index', intersect: false },
      plugins: {
        legend: {
          display: series.length > 1 || isPie,
          position: isPie ? 'right' : 'top',
          labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, pointStyle: 'circle', font: { size: 11 }, color: '#6b7280' }
        },
        tooltip: {
          backgroundColor: '#111827',
          padding: 10,
          cornerRadius: 8,
          titleFont: { size: 12 },
          bodyFont: { size: 12 },
          callbacks: {
            label: function (ctx) {
              var v = isPie ? ctx.parsed : ctx.parsed.y;
              return ' ' + (ctx.dataset.label ? ctx.dataset.label + '：' : '') + A.formatNumber(v);
            }
          }
        }
      }
    };

    if (!isPie) {
      options.scales = {
        x: {
          grid: { display: false },
          ticks: {
            color: '#9ca3af',
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12
          },
          border: { color: '#e6e8ec' }
        },
        y: {
          beginAtZero: type === 'bar',
          grid: { color: '#f0f1f4' },
          border: { display: false },
          ticks: {
            color: '#9ca3af',
            font: { size: 11 },
            callback: function (v) { return A.compactNumber(v); }
          }
        }
      };
    }

    var chart = new window.Chart(canvas.getContext('2d'), { type: type, data: { labels: spec.labels, datasets: datasets }, options: options });
    state.charts.push(chart);
    return chart;
  }

  /* ================= Markdown ================= */

  function inlineMd(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  }

  function renderMarkdown(md) {
    var lines = escapeHtml(md).split(/\r?\n/);
    var out = [];
    var listType = null;
    var para = [];

    function flushPara() {
      if (para.length) {
        out.push('<p>' + inlineMd(para.join(' ')) + '</p>');
        para = [];
      }
    }
    function closeList() {
      if (listType) { out.push('</' + listType + '>'); listType = null; }
    }

    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) { flushPara(); closeList(); return; }

      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flushPara(); closeList(); out.push('<h4>' + inlineMd(h[2]) + '</h4>'); return; }

      var boldTitle = /^\*\*([^*]+)\*\*[：:]?\s*$/.exec(line);
      if (boldTitle) { flushPara(); closeList(); out.push('<h4>' + inlineMd(boldTitle[1]) + '</h4>'); return; }

      var li = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + inlineMd(li[1]) + '</li>');
        return;
      }

      closeList();
      para.push(line);
    });

    flushPara();
    closeList();
    return out.join('');
  }

  /* ================= 结果卡片 ================= */

  var INTENT_META = {
    trend: { label: '趋势分析', cls: 't-trend' },
    anomaly: { label: '异常识别', cls: 't-anomaly' },
    compare: { label: '指标对比', cls: 't-compare' },
    rank: { label: '排名 / 构成', cls: '' },
    summary: { label: '整体概览', cls: '' },
    detail: { label: '数据明细', cls: 't-detail' }
  };

  function buildCard(payload, streaming) {
    var thread = $('thread');
    var card = el('article', 'result-card');

    var head = el('div', 'rc-head');
    var left = el('div');
    var title = el('h3', 'rc-title', payload.title || '分析结果');
    left.appendChild(title);
    if (payload.question) left.appendChild(el('p', 'rc-q', '「' + payload.question + '」'));
    head.appendChild(left);

    var meta = INTENT_META[payload.intent] || { label: '分析', cls: '' };
    var tag = el('span', 'tag ' + (meta.cls || ''), meta.label);
    head.appendChild(tag);
    card.appendChild(head);

    var metaText = payload.metaText || '';
    if (payload.note) metaText = metaText ? metaText + '　|　' + payload.note : payload.note;
    if (metaText) card.appendChild(el('p', 'rc-meta', metaText));

    var chartWrap = null;
    if (payload.chart && payload.chart.labels && payload.chart.labels.length) {
      chartWrap = el('div', 'chart-wrap');
      var canvas = document.createElement('canvas');
      chartWrap.appendChild(canvas);
      card.appendChild(chartWrap);
    }

    var answer = el('div', 'answer');
    if (payload.answer) answer.innerHTML = renderMarkdown(payload.answer);
    card.appendChild(answer);

    if (payload.table && payload.table.rows && payload.table.rows.length) {
      var fold = el('details', 'table-fold');
      var summary = el('summary', null, '查看计算明细（' + payload.table.rows.length + ' 行）');
      fold.appendChild(summary);
      var scroll = el('div', 'table-scroll');
      scroll.appendChild(buildTable(payload.table));
      fold.appendChild(scroll);
      card.appendChild(fold);
    }

    thread.appendChild(card);

    if (chartWrap && payload.chart) {
      // 需要元素进入布局后再初始化图表
      requestAnimationFrame(function () { renderChart(chartWrap.querySelector('canvas'), payload.chart); });
    }
    scrollThread();

    return { card: card, answer: answer, title: title };
  }

  function buildTable(table) {
    var t = el('table', 'data-table');
    var thead = el('thead');
    var tr = el('tr');
    (table.headers || []).forEach(function (h) {
      tr.appendChild(el('th', null, h));
    });
    thead.appendChild(tr);
    t.appendChild(thead);

    var tbody = el('tbody');
    (table.rows || []).forEach(function (row) {
      var r = el('tr');
      row.forEach(function (cell, i) {
        var isNum = table.numeric ? table.numeric[i] : typeof cell === 'number';
        var td = el('td', isNum ? 'num' : null,
          cell === null || cell === undefined ? '—' : (typeof cell === 'number' ? A.formatNumber(cell) : String(cell)));
        r.appendChild(td);
      });
      tbody.appendChild(r);
    });
    t.appendChild(tbody);
    return t;
  }

  function scrollThread() {
    var thread = $('thread');
    thread.scrollTop = thread.scrollHeight;
  }

  /* ================= 大模型 ================= */

  async function getModel() {
    if (state.model) return state.model;
    var list;
    try {
      list = await cloud.llm.models.list();
    } catch (err) {
      throw new Error('模型服务暂时不可用，请稍后重试');
    }
    state.models = Array.isArray(list) ? list : [];
    var pick = state.models.filter(function (m) { return m.disabled !== true; })[0];
    if (!pick) throw new Error('当前没有可用的模型，请联系管理员开启模型权限');
    state.model = pick;
    return pick;
  }

  function columnLine(c, idx) {
    var sample = '';
    if (c.type === 'text') {
      var vals = [];
      var rows = state.dataset.rows;
      for (var i = 0; i < rows.length && vals.length < 6; i++) {
        var v = rows[i][c.name];
        if (v !== '' && v !== null && v !== undefined && vals.indexOf(String(v)) === -1) vals.push(String(v));
      }
      sample = vals.length ? '，取值如 ' + vals.join(' / ') : '';
    } else if (c.type === 'number') {
      sample = '，数值';
    } else if (c.type === 'date') {
      sample = '，日期';
    }
    return (idx + 1) + '. ' + c.name + '（' + A.typeLabel(c.type) + sample + '）';
  }

  function datasetBrief() {
    var ds = state.dataset;
    var p = state.profile;
    var cols = ds.columns.map(columnLine).join('\n');
    var sampleRows = ds.rows.slice(0, 5).map(function (r) {
      return ds.columns.map(function (c) { return String(r[c.name] === null ? '' : r[c.name]); }).join(' | ');
    }).join('\n');
    return '数据集：' + ds.name + '\n行数：' + p.rowCount + '，列数：' + ds.columns.length + '\n列清单：\n' + cols +
      '\n\n前 5 行示例（列顺序同上）：\n' + sampleRows;
  }

  var PLAN_SYSTEM = [
    '你是一个严谨的数据分析规划器。你的唯一任务是把用户的自然语言问题翻译成一条可执行的聚合查询计划。',
    '你只输出 JSON 对象，不输出任何解释性文字、不使用 Markdown 代码块。',
    '列名必须严格取自给定的列清单，禁止臆造列名或数值。'
  ].join('\n');

  function planPrompt(question) {
    return datasetBrief() +
      '\n\n用户问题：' + question +
      '\n\n请输出如下结构的 JSON：\n' +
      '{\n' +
      '  "intent": "trend|anomaly|compare|rank|summary|detail",\n' +
      '  "title": "不超过 16 个字的中文标题",\n' +
      '  "groupBy": { "column": "列名或 null", "bucket": "day|week|month|quarter|year|null" },\n' +
      '  "metrics": [ { "column": "列名或 null（null 表示计数）", "agg": "sum|avg|count|min|max" } ],\n' +
      '  "filters": [ { "column": "列名", "op": "eq|neq|gt|gte|lt|lte|contains|in", "value": "取值或数组" } ],\n' +
      '  "compareBy": { "column": "列名", "values": ["A", "B"] },\n' +
      '  "sort": { "by": "metric|label", "direction": "asc|desc" },\n' +
      '  "limit": 12,\n' +
      '  "chartType": "line|bar|pie|doughnut|table"\n' +
      '}\n\n' +
      '规划规则：\n' +
      '- 时间趋势：groupBy.column 用日期列，bucket 按跨度选择（小于 2 个月用 week，一年内用 month，超过一年用 quarter），chartType 用 line。\n' +
      '- 排名 / 构成：groupBy.column 用文本列，chartType 用 bar（前几名）或 pie（占比）。\n' +
      '- 对比两个取值：用 compareBy 指定文本列和两个取值，groupBy.column 置 null，chartType 用 bar。\n' +
      '- 异常识别：intent 用 anomaly，按时间或类别分组，chartType 用 line 或 bar。\n' +
      '- 明细 / 样本：intent 用 detail，groupBy.column 置 null，chartType 用 table。\n' +
      '- metrics 最多 2 个；只能对数值列使用 sum/avg，count 的 column 置 null。\n' +
      '- 没有筛选依据时 filters 给空数组；compareBy 不适用时给 null。';
  }

  async function callModel(messages, opts) {
    var model = await getModel();
    var params = {
      model: model.id,
      messages: messages,
      stream: true,
      temperature: opts && opts.temperature !== undefined ? opts.temperature : 0.3
    };
    if (opts && opts.json) params.response_format = { type: 'json_object' };
    if (opts && opts.signal) params.signal = opts.signal;

    var text = '';
    for await (var chunk of cloud.llm.chat.completions.create(params)) {
      var delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta && delta.content) {
        text += delta.content;
        if (opts && opts.onDelta) opts.onDelta(delta.content, text);
      }
    }
    return text;
  }

  function sanitizePlan(plan) {
    if (!plan || typeof plan !== 'object') throw new Error('计划解析失败');
    var names = state.dataset.columns.map(function (c) { return c.name; });
    var intents = ['trend', 'anomaly', 'compare', 'rank', 'summary', 'detail'];
    var out = {
      intent: intents.indexOf(plan.intent) > -1 ? plan.intent : 'summary',
      title: typeof plan.title === 'string' ? plan.title.slice(0, 30) : '分析结果',
      groupBy: { column: null, bucket: null },
      metrics: [],
      filters: [],
      compareBy: null,
      sort: plan.sort && typeof plan.sort === 'object' ? plan.sort : null,
      limit: Math.min(Math.max(Number(plan.limit) || 12, 3), 30),
      chartType: ['line', 'bar', 'pie', 'doughnut', 'table'].indexOf(plan.chartType) > -1 ? plan.chartType : 'bar'
    };
    if (plan.groupBy && names.indexOf(plan.groupBy.column) > -1) {
      out.groupBy.column = plan.groupBy.column;
      out.groupBy.bucket = ['day', 'week', 'month', 'quarter', 'year'].indexOf(plan.groupBy.bucket) > -1 ? plan.groupBy.bucket : null;
    }
    (Array.isArray(plan.metrics) ? plan.metrics : []).slice(0, 2).forEach(function (m) {
      if (!m) return;
      var col = m.column === null || m.column === undefined ? null : (names.indexOf(m.column) > -1 ? m.column : null);
      var agg = ['sum', 'avg', 'count', 'min', 'max'].indexOf(m.agg) > -1 ? m.agg : (col ? 'sum' : 'count');
      if (!col && agg !== 'count') agg = 'count';
      out.metrics.push({ column: col, agg: agg });
    });
    (Array.isArray(plan.filters) ? plan.filters : []).slice(0, 4).forEach(function (f) {
      if (!f || names.indexOf(f.column) === -1) return;
      out.filters.push({
        column: f.column,
        op: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'].indexOf(f.op) > -1 ? f.op : 'eq',
        value: f.value
      });
    });
    if (plan.compareBy && names.indexOf(plan.compareBy.column) > -1 &&
        Array.isArray(plan.compareBy.values) && plan.compareBy.values.length === 2) {
      out.compareBy = { column: plan.compareBy.column, values: plan.compareBy.values.map(String) };
    }
    return out;
  }

  function fallbackPlan() {
    var p = state.profile;
    var dateCol = p.dateCols[0];
    var numCol = p.numericCols[0];
    return sanitizePlan({
      intent: dateCol && numCol ? 'trend' : 'summary',
      title: '数据总览',
      groupBy: { column: dateCol ? dateCol.name : null, bucket: null },
      metrics: [{ column: numCol ? numCol.name : null, agg: numCol ? 'sum' : 'count' }],
      filters: [],
      compareBy: null,
      limit: 12,
      chartType: dateCol && numCol ? 'line' : 'bar'
    });
  }

  function parsePlan(raw) {
    var cleaned = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    var start = cleaned.indexOf('{');
    var end = cleaned.lastIndexOf('}');
    if (start > -1 && end > start) cleaned = cleaned.slice(start, end + 1);
    try {
      return sanitizePlan(JSON.parse(cleaned));
    } catch (e) {
      return fallbackPlan();
    }
  }

  function statsDigest(result) {
    var c = result.computed;
    if (!c) return '';
    var lines = [];
    var p = c.primary;
    if (p) {
      lines.push('- 参与计算行数：' + c.rowCount + '，分组数：' + c.groupCount);
      lines.push('- ' + c.metricLabels[0] + '：合计 ' + A.formatNumber(p.total) + '，均值 ' + A.formatNumber(p.mean) +
        '，中位数 ' + A.formatNumber(p.median) + '，最高 ' + p.peak.label + '（' + A.formatNumber(p.peak.value) + '）' +
        '，最低 ' + p.trough.label + '（' + A.formatNumber(p.trough.value) + '）');
      if (c.growth !== null && c.growth !== undefined) {
        lines.push('- 首末变化：' + c.growth.toFixed(1) + '%（' + p.first.label + ' → ' + p.last.label + '）');
      }
      if (p.anomalies && p.anomalies.length) {
        lines.push('- 检出异常点：' + p.anomalies.map(function (a) {
          return a.label + '（' + A.formatNumber(a.value) + '，偏' + a.direction + (a.deviation === null ? '' : ' ' + a.deviation.toFixed(0) + '%') + '）';
        }).join('；'));
      } else {
        lines.push('- 未检出统计意义上的异常点');
      }
    }
    if (c.secondary) {
      lines.push('- ' + c.metricLabels[1] + '：合计 ' + A.formatNumber(c.secondary.total) + '，均值 ' + A.formatNumber(c.secondary.mean));
    }
    if (c.share) {
      lines.push('- 占比前三：' + c.share.slice(0, 3).map(function (s) { return s.label + ' ' + s.pct.toFixed(1) + '%'; }).join('，'));
    }
    if (c.deltas) {
      c.deltas.forEach(function (d) {
        lines.push('- ' + d.metric + '：' + d.a + ' vs ' + d.b + '，差额 ' + A.formatNumber(d.diff) +
          (d.pct === null ? '' : '（' + A.pctText(d.pct) + '）'));
      });
    }
    return lines.join('\n');
  }

  var ANSWER_SYSTEM = [
    '你是一位资深数据分析师，擅长把计算结果翻译成清晰、可执行的业务结论。',
    '只能使用用户提供的数据结果中的数字，严禁编造、估算或使用外部知识补充数字。',
    '使用简体中文，语气专业克制，不要空话套话。'
  ].join('\n');

  function answerPrompt(question, plan, result) {
    var tableText = result.table.headers.join(' | ') + '\n' +
      result.table.rows.slice(0, 24).map(function (r) {
        return r.map(function (c) { return c === null ? '—' : (typeof c === 'number' ? A.formatNumber(c) : c); }).join(' | ');
      }).join('\n');

    return datasetBrief() +
      '\n\n用户问题：' + question +
      '\n\n计算口径：' + (result.metaText || '') +
      '\n计算结果：\n' + tableText +
      '\n\n统计摘要：\n' + (statsDigest(result) || '（无）') +
      '\n\n请输出 Markdown 格式的分析结论，严格包含以下四个小节（用 **小节名** 作为标题行）：\n' +
      '**核心结论**：2-3 句话给出最重要的判断，包含关键数字。\n' +
      '**关键数据**：用 3-4 条列表列出支撑结论的数字依据。\n' +
      '**异常与风险**：指出异常点或需要关注的风险；若没有明显异常，写“暂无明显异常，数据整体平稳”。\n' +
      '**建议**：给出 2-3 条可执行的动作建议。\n\n' +
      '总字数控制在 200-350 字，不要复述表格，不要编造数据。';
  }

  /* ================= 提问主流程 ================= */

  async function generatePlan(question) {
    var messages = [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: planPrompt(question) }
    ];
    try {
      return parsePlan(await callModel(messages, { json: true, temperature: 0 }));
    } catch (err) {
      var code = err && err.error && err.error.code;
      // 部分模型不支持 JSON 模式（request_ 类错误）时，退回普通输出再解析一次
      if (typeof code === 'string' && code.indexOf('request_') === 0) {
        return parsePlan(await callModel(messages, { temperature: 0 }));
      }
      throw err;
    }
  }

  async function ask(question) {
    if (state.busy) return;
    if (!state.dataset) { toast('请先选择数据集'); return; }

    var q = String(question || '').trim();
    if (!q) return;
    if (q.length > LIMITS.maxPromptChars) {
      toast('问题太长了，请精简到 ' + LIMITS.maxPromptChars + ' 字以内');
      return;
    }

    state.busy = true;
    setComposerBusy(true);

    var thinking = el('div', 'thinking');
    thinking.appendChild(el('span', 'dot'));
    var thinkingText = el('span', null, '正在理解问题，规划取数方式…');
    thinking.appendChild(thinkingText);
    $('thread').appendChild(thinking);
    scrollThread();

    try {
      await getModel();

      var plan = await generatePlan(q);

      thinkingText.textContent = '正在按计划计算指标…';
      var result = A.runPlan(state.dataset, plan);

      thinking.remove();

      var handle = buildCard({
        title: result.empty ? '没有匹配的数据' : (result.title || plan.title),
        question: q,
        intent: result.intent || plan.intent,
        metaText: result.metaText || '',
        note: result.note || '',
        chart: result.chart,
        table: result.table,
        answer: ''
      }, true);

      if (result.empty) {
        handle.answer.innerHTML = '<p>' + escapeHtml(result.note || '按当前条件没有匹配到数据，换个问法试试。') + '</p>';
        return;
      }

      handle.answer.innerHTML = '<p><span class="cursor"></span></p>';
      var buffer = '';
      var lastPaint = 0;

      var answerText = await callModel([
        { role: 'system', content: ANSWER_SYSTEM },
        { role: 'user', content: answerPrompt(q, plan, result) }
      ], {
        temperature: 0.4,
        onDelta: function (_, full) {
          buffer = full;
          var now = Date.now();
          if (now - lastPaint > 80) {
            lastPaint = now;
            handle.answer.innerHTML = renderMarkdown(full) + '<p><span class="cursor"></span></p>';
          }
        }
      });

      handle.answer.innerHTML = renderMarkdown(answerText || buffer || '模型没有返回内容。');

      await saveAnalysis(q, plan, result, answerText || buffer);
    } catch (err) {
      thinking.remove();
      var msg = err && err.message ? err.message : '分析失败，请重试';
      var box = el('div', 'card-error', '分析失败：' + msg);
      $('thread').appendChild(box);
      scrollThread();
    } finally {
      state.busy = false;
      setComposerBusy(false);
    }
  }

  function setComposerBusy(busy) {
    $('askBtn').disabled = busy;
    $('askBtn').textContent = busy ? '分析中…' : '发送';
    $('askInput').disabled = busy;
  }

  async function saveAnalysis(question, plan, result, answer) {
    var payload = {
      dataset_id: state.dataset.id,
      dataset_name: state.dataset.name,
      question: question.slice(0, 500),
      intent: result.intent || plan.intent,
      plan: plan,
      result: {
        title: result.title,
        intent: result.intent,
        metaText: result.metaText,
        note: result.note,
        chart: result.chart,
        table: result.table
      },
      answer: String(answer || '').slice(0, 8000),
      owner_name: (state.session && state.session.user && state.session.user.name) || null
    };
    var res = await cloud.database.from('analyses').insert(payload).select('id');
    if (res.error) {
      // 保存失败不影响本次结果展示，但要告知用户
      toast('结论已生成，但历史记录保存失败：' + (res.error.message || '未知错误'));
    }
  }

  /* ================= 数据集创建 ================= */

  function openUpload() {
    state.upload = { parsed: null, name: '' };
    $('previewWrap').classList.add('hidden');
    $('uploadError').classList.add('hidden');
    $('fileName').classList.add('hidden');
    $('datasetNameInput').value = '';
    $('saveDatasetBtn').disabled = true;
    $('fileInput').value = '';
    $('rowsNote').textContent = '最多保存 ' + LIMITS.maxRows + ' 行、' + LIMITS.maxColumns + ' 列，单个文件不超过 ' + LIMITS.maxFileMB + 'MB。超出部分会被截断。';
    setUploadTab('file');
    show($('uploadModal'));
  }

  function setUploadTab(tab) {
    Array.prototype.forEach.call($('uploadModal').querySelectorAll('[data-utab]'), function (b) {
      b.classList.toggle('active', b.dataset.utab === tab);
    });
    $('filePane').classList.toggle('hidden', tab !== 'file');
    $('pastePane').classList.toggle('hidden', tab !== 'paste');
  }

  function uploadError(msg) {
    var n = $('uploadError');
    if (!msg) { hide(n); return; }
    n.textContent = msg;
    show(n);
  }

  function applyParsed(parsed, suggestedName) {
    uploadError('');
    try {
      var ds = A.buildDataset(parsed.headers, parsed.matrix);
      if (!ds.rowCount) throw new Error('没有解析到数据行');
      state.upload.parsed = ds;
      state.upload.name = suggestedName || '未命名数据集';

      $('previewInfo').textContent = ds.rowCount + ' 行 × ' + ds.columns.length + ' 列' +
        (ds.truncated ? '（已按上限截断）' : '') +
        ' · 识别到 ' + ds.columns.filter(function (c) { return c.type === 'number'; }).length + ' 个数值列';
      $('datasetNameInput').value = state.upload.name;

      var table = $('previewTable');
      table.innerHTML = '';
      var thead = el('thead');
      var tr = el('tr');
      ds.columns.forEach(function (c) {
        var th = el('th');
        th.appendChild(document.createTextNode(c.name));
        th.appendChild(el('span', 'col-type', A.typeLabel(c.type)));
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);

      var tbody = el('tbody');
      ds.rows.slice(0, 12).forEach(function (r) {
        var rowEl = el('tr');
        ds.columns.forEach(function (c) {
          var v = r[c.name];
          var td = el('td', c.type === 'number' ? 'num' : null,
            v === null || v === undefined || v === '' ? '—' : (typeof v === 'number' ? A.formatNumber(v) : String(v)));
          rowEl.appendChild(td);
        });
        tbody.appendChild(rowEl);
      });
      table.appendChild(tbody);

      show($('previewWrap'));
      $('saveDatasetBtn').disabled = false;
    } catch (err) {
      uploadError(err.message || '数据解析失败');
      hide($('previewWrap'));
      $('saveDatasetBtn').disabled = true;
    }
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > LIMITS.maxFileMB * 1024 * 1024) {
      uploadError('文件超过 ' + LIMITS.maxFileMB + 'MB，请拆分后再上传');
      return;
    }
    var lower = file.name.toLowerCase();
    var baseName = file.name.replace(/\.[^.]+$/, '');
    var isSheet = /\.(xlsx|xls)$/.test(lower);

    $('fileName').textContent = file.name + ' · ' + (file.size / 1024).toFixed(0) + ' KB';
    show($('fileName'));

    if (isSheet) {
      if (!window.XLSX) {
        uploadError('Excel 解析组件未加载，请将文件另存为 CSV 后上传');
        return;
      }
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var wb = window.XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
          var parsed = A.parseSheetWorkbook(wb);
          applyParsed(parsed, baseName);
        } catch (err) {
          uploadError('Excel 解析失败：' + (err.message || '未知错误'));
        }
      };
      reader.onerror = function () { uploadError('文件读取失败'); };
      reader.readAsArrayBuffer(file);
      return;
    }

    var textReader = new FileReader();
    textReader.onload = function (e) {
      try {
        var parsed = A.parseText(e.target.result);
        applyParsed(parsed, baseName);
      } catch (err) {
        uploadError('解析失败：' + (err.message || '未知错误'));
      }
    };
    textReader.onerror = function () { uploadError('文件读取失败'); };
    textReader.readAsText(file, 'utf-8');
  }

  async function saveDataset() {
    if (!state.upload.parsed) return;
    var name = ($('datasetNameInput').value || '').trim() || '未命名数据集';
    var ds = state.upload.parsed;
    var btn = $('saveDatasetBtn');
    btn.disabled = true;
    btn.textContent = '保存中…';

    var res = await cloud.database.from('datasets').insert({
      name: name.slice(0, 80),
      source_type: ds.truncated ? 'truncated' : 'upload',
      columns_def: ds.columns.map(function (c) { return { name: c.name, type: c.type }; }),
      rows_data: ds.rows,
      row_count: ds.rowCount,
      owner_name: (state.session && state.session.user && state.session.user.name) || null
    }).select('id').single();

    btn.textContent = '保存到云端';
    btn.disabled = false;

    if (res.error) {
      uploadError('保存失败：' + (res.error.message || '未知错误'));
      return;
    }
    hide($('uploadModal'));
    toast('数据集已保存到云端');
    await loadDatasets();
    await openDataset(res.data.id);
  }

  async function loadSample() {
    var ds = A.sampleDataset();
    var btn = $('sampleBtn');
    btn.disabled = true;
    btn.textContent = '正在生成…';

    var res = await cloud.database.from('datasets').insert({
      name: ds.name,
      source_type: 'sample',
      columns_def: ds.columns.map(function (c) { return { name: c.name, type: c.type }; }),
      rows_data: ds.rows,
      row_count: ds.rowCount,
      owner_name: (state.session && state.session.user && state.session.user.name) || null
    }).select('id').single();

    btn.disabled = false;
    btn.textContent = '载入示例数据';

    if (res.error) { toast('示例数据保存失败：' + (res.error.message || '未知错误')); return; }
    toast('示例数据已载入');
    await loadDatasets();
    await openDataset(res.data.id);
  }

  async function deleteDataset() {
    if (!state.dataset) return;
    var ok = window.confirm('确定删除数据集「' + state.dataset.name + '」吗？\n相关的历史分析记录也会一并删除，且无法恢复。');
    if (!ok) return;

    var id = state.dataset.id;
    var res = await cloud.database.from('datasets').delete().eq('id', id).select('id');
    if (res.error) { toast('删除失败：' + (res.error.message || '未知错误')); return; }

    await cloud.database.from('analyses').delete().eq('dataset_id', id);

    toast('数据集已删除');
    state.dataset = null;
    state.activeId = null;
    $('thread').innerHTML = '';
    $('statRow').innerHTML = '';
    destroyCharts();
    await loadDatasets();
    if (state.datasets.length) await openDataset(state.datasets[0].id);
    else renderEmptyState();
  }

  function showRawData() {
    if (!state.dataset) return;
    var ds = state.dataset;
    $('previewTitle').textContent = ds.name;
    $('previewSub').textContent = ds.rowCount + ' 行 × ' + ds.columns.length + ' 列（展示前 200 行）';
    var table = $('rawTable');
    table.innerHTML = '';

    var thead = el('thead');
    var tr = el('tr');
    ds.columns.forEach(function (c) {
      var th = el('th');
      th.appendChild(document.createTextNode(c.name));
      th.appendChild(el('span', 'col-type', A.typeLabel(c.type)));
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);

    var tbody = el('tbody');
    ds.rows.slice(0, 200).forEach(function (r) {
      var rowEl = el('tr');
      ds.columns.forEach(function (c) {
        var v = r[c.name];
        rowEl.appendChild(el('td', c.type === 'number' ? 'num' : null,
          v === null || v === undefined || v === '' ? '—' : (typeof v === 'number' ? A.formatNumber(v) : String(v))));
      });
      tbody.appendChild(rowEl);
    });
    table.appendChild(tbody);
    show($('previewModal'));
  }

  /* ================= 事件绑定 ================= */

  function autoGrow() {
    var t = $('askInput');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 132) + 'px';
  }

  function bind() {
    Array.prototype.forEach.call($('authTabs').children, function (b) {
      b.addEventListener('click', function () { setAuthTab(b.dataset.tab); });
    });
    $('sendCodeBtn').addEventListener('click', sendCode);
    ['emailInput', 'phoneInput'].forEach(function (id) {
      $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); sendCode(); }
      });
    });
    $('authForm').addEventListener('submit', submitAuth);
    $('logoutBtn').addEventListener('click', logout);

    $('newDatasetBtn').addEventListener('click', openUpload);
    $('emptyUploadBtn').addEventListener('click', openUpload);
    $('sampleBtn').addEventListener('click', loadSample);
    $('closeUploadBtn').addEventListener('click', function () { hide($('uploadModal')); });
    $('cancelUploadBtn').addEventListener('click', function () { hide($('uploadModal')); });
    $('saveDatasetBtn').addEventListener('click', saveDataset);

    Array.prototype.forEach.call($('uploadModal').querySelectorAll('[data-utab]'), function (b) {
      b.addEventListener('click', function () { setUploadTab(b.dataset.utab); });
    });

    var dz = $('dropzone');
    dz.addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) { readFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
    });

    $('parsePasteBtn').addEventListener('click', function () {
      var text = $('pasteArea').value;
      if (!text.trim()) { uploadError('请先粘贴表格内容'); return; }
      try {
        var parsed = A.parseText(text);
        applyParsed(parsed, '粘贴数据 ' + new Date().getMonth() + '/' + new Date().getDate());
      } catch (err) {
        uploadError('解析失败：' + (err.message || '未知错误'));
      }
    });

    $('previewDataBtn').addEventListener('click', showRawData);
    $('deleteDatasetBtn').addEventListener('click', deleteDataset);
    $('closePreviewBtn').addEventListener('click', function () { hide($('previewModal')); });

    $('askForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('askInput').value;
      $('askInput').value = '';
      autoGrow();
      ask(v);
    });
    $('askInput').addEventListener('input', autoGrow);
    $('askInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $('askForm').dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        hide($('uploadModal'));
        hide($('previewModal'));
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) m.classList.add('hidden'); });
    });
  }

  /* ================= 启动 ================= */

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    boot();
  });
})();
