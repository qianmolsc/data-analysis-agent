/* ===== 数据分析 Agent · 本地数据引擎 =====
 * 负责：解析表格 → 推断列类型 → 按计划聚合 → 计算统计摘要与异常点。
 * 所有数字都在本地基于真实数据计算，模型只负责“理解问题”和“解读结果”。
 */
(function (global) {
  'use strict';

  var TYPE_LABEL = { number: '数值', date: '日期', text: '文本', bool: '布尔' };

  /* ---------------- 基础工具 ---------------- */

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (!s) return null;
    var negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    s = s.replace(/[,，\s]/g, '').replace(/[¥$€£%]/g, '');
    if (!s || s === '-' || s === '--' || s === 'null' || s === 'NULL') return null;
    var n = Number(s);
    if (!isFinite(n)) return null;
    return negative ? -n : n;
  }

  function toDate(v) {
    if (!v && v !== 0) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var s = String(v).trim();
    if (!s) return null;
    var m;
    if ((m = /^(\d{4})[-/年.](\d{1,2})(?:[-/月.](\d{1,2}))?日?$/.exec(s))) {
      return new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
    }
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
      return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s))) {
      return new Date(+m[3], +m[1] - 1, +m[2]);
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      var d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    if ((m = /^(\d{4})[-/]?Q([1-4])$/i.exec(s))) {
      return new Date(+m[1], (+m[2] - 1) * 3, 1);
    }
    return null;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function dateKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function bucketLabel(d, bucket) {
    if (!d) return '未知时间';
    var y = d.getFullYear();
    switch (bucket) {
      case 'day': return dateKey(d);
      case 'week': {
        var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var dow = (t.getDay() + 6) % 7;
        t.setDate(t.getDate() - dow);
        return dateKey(t);
      }
      case 'quarter': return y + ' Q' + (Math.floor(d.getMonth() / 3) + 1);
      case 'year': return String(y);
      case 'month':
      default: return y + '-' + pad2(d.getMonth() + 1);
    }
  }

  function autoBucket(dates) {
    var valid = dates.filter(Boolean).sort(function (a, b) { return a - b; });
    if (valid.length < 2) return 'month';
    var days = (valid[valid.length - 1] - valid[0]) / 86400000;
    if (days <= 31) return 'day';
    if (days <= 200) return 'week';
    if (days <= 1100) return 'month';
    if (days <= 4000) return 'quarter';
    return 'year';
  }

  function cellText(v) {
    if (v === null || v === undefined || v === '') return '（空）';
    if (typeof v === 'boolean') return v ? '是' : '否';
    return String(v);
  }

  function formatNumber(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var d = digits === undefined ? (Math.abs(n) >= 100 ? 0 : 2) : digits;
    var fixed = Math.abs(n) >= 1000 || Number.isInteger(n) ? Math.round(n).toString() : n.toFixed(d);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function compactNumber(n) {
    if (n === null || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(abs >= 1e6 ? 0 : 1) + ' 万';
    return formatNumber(n);
  }

  function formatDateShort(d) {
    if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '—';
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
  }

  function formatMonthShort(d) {
    if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '—';
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1);
  }

  function pctText(v, digits) {
    if (v === null || !isFinite(v)) return '—';
    var d = digits === undefined ? 1 : digits;
    return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  }

  /* ---------------- 表格解析 ---------------- */

  function detectDelimiter(text) {
    var sample = text.split(/\r?\n/).slice(0, 8).join('\n');
    var candidates = ['\t', ',', ';', '|'];
    var best = ',', bestScore = -1;
    candidates.forEach(function (d) {
      var count = sample.split(d).length - 1;
      if (count > bestScore) { bestScore = count; best = d; }
    });
    return bestScore > 0 ? best : ',';
  }

  function parseDelimited(text) {
    var clean = String(text).replace(/^\uFEFF/, '');
    var delimiter = detectDelimiter(clean);
    var rows = [], field = '', row = [], inQuotes = false, i = 0, ch;
    while (i < clean.length) {
      ch = clean[i];
      if (inQuotes) {
        if (ch === '"') {
          if (clean[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
      if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    row.push(field);
    rows.push(row);
    rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
    if (!rows.length) throw new Error('没有解析到任何数据行');
    return { headers: rows[0], matrix: rows.slice(1), delimiter: delimiter };
  }

  function parseJson(text) {
    var parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('JSON 需要是对象数组');
    var headers = Object.keys(parsed[0]);
    Object.keys(parsed).forEach(function (k) {
      Object.keys(parsed[k]).forEach(function (key) {
        if (headers.indexOf(key) === -1) headers.push(key);
      });
    });
    var matrix = parsed.map(function (item) {
      return headers.map(function (h) { return item[h]; });
    });
    return { headers: headers, matrix: matrix };
  }

  function buildDataset(rawHeaders, rawMatrix) {
    var headers = [], seen = {};
    rawHeaders.forEach(function (h, i) {
      var name = String(h === undefined || h === null ? '' : h).trim() || ('列' + (i + 1));
      var base = name, n = 2;
      while (seen[name]) { name = base + '_' + (n++); }
      seen[name] = true;
      headers.push(name);
    });

    var limit = global.APP_CONFIG.limits;
    var truncated = false;
    var matrix = rawMatrix;
    if (matrix.length > limit.maxRows) { matrix = matrix.slice(0, limit.maxRows); truncated = true; }
    if (headers.length > limit.maxColumns) {
      matrix = matrix.map(function (r) { return r.slice(0, limit.maxColumns); });
      headers = headers.slice(0, limit.maxColumns);
    }

    var columns = headers.map(function (name, idx) {
      var vals = matrix.map(function (r) { return r[idx]; }).filter(function (v) {
        return v !== null && v !== undefined && String(v).trim() !== '';
      });
      var total = vals.length;
      var numHits = 0, dateHits = 0, boolHits = 0;
      vals.forEach(function (v) {
        if (toNumber(v) !== null) numHits++;
        if (toDate(v) !== null) dateHits++;
        if (typeof v === 'boolean' || /^(true|false|是|否)$/i.test(String(v).trim())) boolHits++;
      });
      var type = 'text';
      if (total > 0) {
        if (numHits / total >= 0.8) type = 'number';
        else if (dateHits / total >= 0.8) type = 'date';
        else if (boolHits / total >= 0.9) type = 'bool';
      }
      return { name: name, type: type, index: idx };
    });

    var rows = matrix.map(function (r) {
      var obj = {};
      columns.forEach(function (c) {
        var v = r[c.index];
        if (c.type === 'number') {
          var n = toNumber(v);
          obj[c.name] = n === null ? null : n;
        } else if (c.type === 'bool') {
          var s = String(v === undefined || v === null ? '' : v).trim();
          obj[c.name] = /^(true|是|1|yes)$/i.test(s) ? true : (s === '' ? null : false);
        } else {
          obj[c.name] = v === undefined || v === null ? '' : String(v).trim();
        }
      });
      return obj;
    });

    return {
      columns: columns,
      rows: rows,
      rowCount: rows.length,
      truncated: truncated
    };
  }

  function parseText(text) {
    var trimmed = String(text).trim();
    if (!trimmed) throw new Error('内容为空');
    if (trimmed[0] === '[' || trimmed[0] === '{') {
      try { return parseJson(trimmed); } catch (e) { /* 继续按分隔符解析 */ }
    }
    return parseDelimited(trimmed);
  }

  function parseSheetWorkbook(workbook) {
    var name = workbook.SheetNames[0];
    var sheet = workbook.Sheets[name];
    var aoa = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    aoa = aoa.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
    if (!aoa.length) throw new Error('表格内容为空');
    return { headers: aoa[0], matrix: aoa.slice(1), sheetName: name };
  }

  /* ---------------- 数据集画像 ---------------- */

  function profile(dataset) {
    var cols = dataset.columns;
    var nums = cols.filter(function (c) { return c.type === 'number'; });
    var dates = cols.filter(function (c) { return c.type === 'date'; });
    var dateRange = null;
    if (dates.length) {
      var all = [];
      dataset.rows.forEach(function (r) {
        dates.forEach(function (c) { var d = toDate(r[c.name]); if (d) all.push(d); });
      });
      if (all.length) {
        all.sort(function (a, b) { return a - b; });
        dateRange = { from: all[0], to: all[all.length - 1] };
      }
    }
    return {
      rowCount: dataset.rowCount,
      colCount: cols.length,
      numericCols: nums,
      dateCols: dates,
      categoryCols: cols.filter(function (c) { return c.type === 'text'; }),
      dateRange: dateRange,
      totals: nums.slice(0, 3).map(function (c) {
        var sum = 0, count = 0;
        dataset.rows.forEach(function (r) {
          var v = r[c.name];
          if (typeof v === 'number') { sum += v; count++; }
        });
        return { column: c.name, sum: sum, avg: count ? sum / count : null, count: count };
      })
    };
  }

  /* ---------------- 计划执行 ---------------- */

  var AGGS = { sum: '合计', avg: '平均', count: '记录数', min: '最小值', max: '最大值' };

  function metricLabel(column, agg) {
    if (!column) return '记录数';
    return column + '·' + (AGGS[agg] || agg);
  }

  function matchEq(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    return String(a === null || a === undefined ? '' : a).trim().toLowerCase() ===
      String(b === null || b === undefined ? '' : b).trim().toLowerCase();
  }

  function applyFilters(rows, filters) {
    if (!Array.isArray(filters) || !filters.length) return rows;
    return rows.filter(function (row) {
      return filters.every(function (f) {
        if (!f || !f.column || !(f.column in row)) return true;
        var v = row[f.column];
        var target = f.value;
        var nv = typeof v === 'number' ? v : toNumber(v);
        var nt = typeof target === 'number' ? target : toNumber(target);
        switch (f.op) {
          case 'eq': return matchEq(v, target);
          case 'neq': return !matchEq(v, target);
          case 'gt': return nv !== null && nt !== null && nv > nt;
          case 'gte': return nv !== null && nt !== null && nv >= nt;
          case 'lt': return nv !== null && nt !== null && nv < nt;
          case 'lte': return nv !== null && nt !== null && nv <= nt;
          case 'contains': return String(v === null || v === undefined ? '' : v).indexOf(String(target)) !== -1;
          case 'in': return Array.isArray(target) && target.some(function (t) { return matchEq(v, t); });
          default: return true;
        }
      });
    });
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var base = Math.floor(pos);
    var rest = pos - base;
    if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    return sorted[base];
  }

  function linearResiduals(values) {
    var n = values.length;
    var sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) { sx += i; sy += values[i]; sxy += i * values[i]; sxx += i * i; }
    var denom = n * sxx - sx * sx;
    var slope = denom ? (n * sxy - sx * sy) / denom : 0;
    var intercept = (sy - slope * sx) / n;
    return values.map(function (v, i) { return v - (intercept + slope * i); });
  }

  /* 留一法残差：拟合趋势时排除被评估的点，避免异常点把趋势线拉向自己 */
  function looResiduals(values) {
    var n = values.length, out = [];
    for (var i = 0; i < n; i++) {
      var sx = 0, sy = 0, sxy = 0, sxx = 0, m = 0, j;
      for (j = 0; j < n; j++) {
        if (j === i) continue;
        m++; sx += j; sy += values[j]; sxy += j * values[j]; sxx += j * j;
      }
      if (!m) { out.push(0); continue; }
      var denom = m * sxx - sx * sx;
      var slope = denom ? (m * sxy - sx * sy) / denom : 0;
      var intercept = (sy - slope * sx) / m;
      out.push(values[i] - (intercept + slope * i));
    }
    return out;
  }

  function seriesStats(labels, values, isSeries) {
    var pairs = [];
    values.forEach(function (v, i) { if (typeof v === 'number' && isFinite(v)) pairs.push({ label: labels[i], value: v }); });
    if (!pairs.length) return null;
    var nums = pairs.map(function (p) { return p.value; }).slice().sort(function (a, b) { return a - b; });
    var sum = nums.reduce(function (a, b) { return a + b; }, 0);
    var mean = sum / nums.length;
    var q1 = quantile(nums, 0.25), q3 = quantile(nums, 0.75);
    var iqr = q3 - q1;
    var low = q1 - 1.5 * iqr, high = q3 + 1.5 * iqr;
    var sd = Math.sqrt(nums.reduce(function (a, v) { return a + Math.pow(v - mean, 2); }, 0) / nums.length);
    var anomalies = [];

    if (isSeries && pairs.length >= 6) {
      /* 时间序列：留一法去趋势 + MAD 稳健离散度，避免趋势本身被误判为异常 */
      var seq = pairs.map(function (p) { return p.value; });
      var resid = looResiduals(seq);
      var absResid = resid.map(function (r) { return Math.abs(r); }).sort(function (a, b) { return a - b; });
      var mad = quantile(absResid, 0.5) * 1.4826;
      var floor = Math.abs(mean) * 0.03;
      if (mad > 0) {
        resid.forEach(function (r, i) {
          var z = r / mad;
          if (Math.abs(z) >= 2.5 && Math.abs(r) >= floor) {
            anomalies.push({
              label: pairs[i].label,
              value: pairs[i].value,
              expected: pairs[i].value - r,
              direction: z > 0 ? '偏高' : '偏低',
              z: Math.round(z * 10) / 10,
              deviation: mean ? (r / Math.abs(mean)) * 100 : null
            });
          }
        });
      }
    } else if (nums.length >= 4 && iqr > 0) {
      pairs.forEach(function (p) {
        if (p.value > high || p.value < low) {
          var z2 = sd > 0 ? (p.value - mean) / sd : 0;
          anomalies.push({
            label: p.label,
            value: p.value,
            expected: null,
            direction: p.value > high ? '偏高' : '偏低',
            z: Math.round(z2 * 10) / 10,
            deviation: mean ? ((p.value - mean) / Math.abs(mean)) * 100 : null
          });
        }
      });
    }
    var peak = pairs.reduce(function (a, b) { return b.value > a.value ? b : a; }, pairs[0]);
    var trough = pairs.reduce(function (a, b) { return b.value < a.value ? b : a; }, pairs[0]);
    return {
      count: nums.length,
      total: sum,
      mean: mean,
      median: quantile(nums, 0.5),
      min: nums[0],
      max: nums[nums.length - 1],
      std: sd,
      peak: peak,
      trough: trough,
      anomalies: anomalies,
      first: pairs[0],
      last: pairs[pairs.length - 1]
    };
  }

  function runPlan(dataset, plan) {
    plan = plan || {};
    var rows = dataset.rows || [];
    var colMap = {};
    dataset.columns.forEach(function (c) { colMap[c.name] = c; });

    var gb = plan.groupBy || {};
    var gbCol = gb.column && colMap[gb.column] ? gb.column : null;
    var gbMeta = gbCol ? colMap[gbCol] : null;

    var metrics = (Array.isArray(plan.metrics) ? plan.metrics : [])
      .filter(function (m) { return m && (m.column === null || m.column === undefined || colMap[m.column]); })
      .slice(0, 2);
    if (!metrics.length) {
      var firstNum = dataset.columns.filter(function (c) { return c.type === 'number'; })[0];
      metrics = [{ column: firstNum ? firstNum.name : null, agg: firstNum ? 'sum' : 'count' }];
    }
    metrics = metrics.map(function (m) {
      var col = m.column && colMap[m.column] ? m.column : null;
      var agg = col ? (AGGS[m.agg] ? m.agg : 'sum') : 'count';
      return { column: col, agg: agg, label: metricLabel(col, agg) };
    });

    var data = applyFilters(rows, plan.filters);

    var compareValues = null;
    if (plan.compareBy && plan.compareBy.column && colMap[plan.compareBy.column] &&
        Array.isArray(plan.compareBy.values) && plan.compareBy.values.length === 2) {
      compareValues = plan.compareBy.values;
    }

    var intent = plan.intent || (gbCol ? 'rank' : 'summary');
    var note = '';

    if (data.length === 0) {
      return {
        title: plan.title || '分析结果',
        intent: intent,
        empty: true,
        note: '按当前筛选条件没有匹配到任何数据行。',
        chart: null,
        table: { headers: [], rows: [] },
        computed: null
      };
    }

    /* 明细模式：直接给出行级样本 */
    if (intent === 'detail' && !gbCol && !compareValues) {
      var detailCols = dataset.columns.slice(0, 8);
      var limitRows = Math.min(Number(plan.limit) || 20, 50);
      var tableRows = data.slice(0, limitRows).map(function (r) {
        return detailCols.map(function (c) {
          var v = r[c.name];
          return typeof v === 'number' ? v : cellText(v);
        });
      });
      return {
        title: plan.title || '数据明细',
        intent: 'detail',
        empty: false,
        note: '共匹配 ' + data.length + ' 行，展示前 ' + tableRows.length + ' 行。',
        chart: null,
        table: {
          headers: detailCols.map(function (c) { return c.name; }),
          rows: tableRows,
          numeric: detailCols.map(function (c) { return c.type === 'number'; })
        },
        computed: null
      };
    }

    /* 聚合模式 */
    var buckets = [];
    var index = {};

    function getAcc(label) {
      if (index[label] === undefined) {
        index[label] = buckets.length;
        buckets.push({ label: label, sum: metrics.map(function () { return 0; }), cnt: metrics.map(function () { return 0; }), min: metrics.map(function () { return undefined; }), max: metrics.map(function () { return undefined; }) });
      }
      return buckets[index[label]];
    }

    var skipped = 0;
    data.forEach(function (row) {
      var label;
      if (compareValues) {
        var hit = null;
        for (var i = 0; i < compareValues.length; i++) {
          if (matchEq(row[plan.compareBy.column], compareValues[i])) { hit = compareValues[i]; break; }
        }
        if (hit === null) return;
        label = String(hit);
      } else if (gbCol) {
        if (gbMeta.type === 'date') {
          var d = toDate(row[gbCol]);
          if (!d) { skipped++; return; }
          label = bucketLabel(d, gb.bucket && gb.bucket !== 'none' ? gb.bucket : null);
        } else {
          label = cellText(row[gbCol]);
        }
      } else {
        label = '合计';
      }
      var acc = getAcc(label);
      metrics.forEach(function (m, mi) {
        var v = m.column ? toNumber(row[m.column]) : 1;
        if (m.column && v === null) return;
        acc.sum[mi] += v;
        acc.cnt[mi] += 1;
        acc.min[mi] = acc.min[mi] === undefined ? v : Math.min(acc.min[mi], v);
        acc.max[mi] = acc.max[mi] === undefined ? v : Math.max(acc.max[mi], v);
      });
    });

    function finalize(acc, mi) {
      var m = metrics[mi];
      if (m.agg === 'count') return acc.cnt[mi] || 0;
      if (!acc.cnt[mi]) return null;
      if (m.agg === 'avg') return acc.sum[mi] / acc.cnt[mi];
      if (m.agg === 'min') return acc.min[mi];
      if (m.agg === 'max') return acc.max[mi];
      return acc.sum[mi];
    }

    var items = buckets.map(function (acc) {
      return { label: acc.label, values: metrics.map(function (m, mi) { return finalize(acc, mi); }) };
    });

    /* 若时间列的 bucket 未指定，用自动粒度 */
    var bucketUsed = null;
    if (gbCol && gbMeta.type === 'date') {
      bucketUsed = gb.bucket && gb.bucket !== 'none' ? gb.bucket : null;
      if (!bucketUsed) {
        var ds = [];
        data.forEach(function (r) { var d = toDate(r[gbCol]); if (d) ds.push(d); });
        bucketUsed = autoBucket(ds);
        if (bucketUsed !== 'month') {
          items = [];
          index = {};
          buckets = [];
          data.forEach(function (row) {
            var d = toDate(row[gbCol]);
            if (!d) return;
            var label = bucketLabel(d, bucketUsed);
            var acc = getAcc(label);
            metrics.forEach(function (m, mi) {
              var v = m.column ? toNumber(row[m.column]) : 1;
              if (m.column && v === null) return;
              acc.sum[mi] += v;
              acc.cnt[mi] += 1;
              acc.min[mi] = acc.min[mi] === undefined ? v : Math.min(acc.min[mi], v);
              acc.max[mi] = acc.max[mi] === undefined ? v : Math.max(acc.max[mi], v);
            });
          });
          items = buckets.map(function (acc) {
            return { label: acc.label, values: metrics.map(function (m, mi) { return finalize(acc, mi); }) };
          });
        }
      }
    }

    /* 排序与截断 */
    var chartType = plan.chartType || 'bar';
    if (compareValues) {
      var order = {};
      compareValues.forEach(function (v, i) { order[String(v)] = i; });
      items.sort(function (a, b) { return order[a.label] - order[b.label]; });
    } else if (gbMeta && gbMeta.type === 'date') {
      items.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
      if (items.length > 48) items = items.slice(items.length - 48);
    } else if (intent === 'rank' || intent === 'summary') {
      items.sort(function (a, b) { return (b.values[0] || 0) - (a.values[0] || 0); });
    }

    var limit = Math.min(Math.max(Number(plan.limit) || 12, 3), 40);
    var othersTotal = null;
    if (!compareValues && !(gbMeta && gbMeta.type === 'date') && items.length > limit) {
      var rest = items.slice(limit - 1);
      items = items.slice(0, limit - 1);
      othersTotal = { label: '其他 ' + rest.length + ' 项', values: metrics.map(function (m, mi) {
        return rest.reduce(function (a, it) { return a + (it.values[mi] || 0); }, 0);
      }) };
      if (chartType === 'pie' || chartType === 'doughnut') items.push(othersTotal);
    }

    var labels = items.map(function (it) { return it.label; });
    var series = metrics.map(function (m, mi) {
      return { label: m.label, values: items.map(function (it) { return it.values[mi]; }) };
    });

    if (compareValues && labels.length === 2) {
      series = metrics.map(function (m, mi) {
        return { label: m.label, values: [items[0].values[mi], items[1].values[mi]] };
      });
    }

    var numericChart = ['line', 'bar', 'pie', 'doughnut'].indexOf(chartType) === -1 ? null : chartType;
    if (compareValues && numericChart === 'line') numericChart = 'bar';

    /* 统计摘要 */
    var isSeries = !!(gbMeta && gbMeta.type === 'date');
    var primary = seriesStats(labels, series[0].values, isSeries);
    var secondary = series.length > 1 ? seriesStats(labels, series[1].values, isSeries) : null;
    var growth = null;
    if (isSeries && primary && labels.length >= 2 && primary.first.value !== 0) {
      growth = ((primary.last.value - primary.first.value) / Math.abs(primary.first.value)) * 100;
    }
    var share = null;
    if ((numericChart === 'pie' || numericChart === 'doughnut') && primary && primary.total) {
      share = labels.map(function (l, i) {
        var v = series[0].values[i];
        return { label: l, value: v, pct: v / primary.total * 100 };
      }).sort(function (a, b) { return b.pct - a.pct; });
    }
    var deltas = null;
    if (compareValues && labels.length === 2) {
      deltas = metrics.map(function (m, mi) {
        var a = series[mi].values[0], b = series[mi].values[1];
        var diff = (b || 0) - (a || 0);
        return {
          metric: m.label,
          a: a, b: b, diff: diff,
          pct: a ? (diff / Math.abs(a)) * 100 : null
        };
      });
    }

    var tableHeaders = [(gbCol && gbMeta.type === 'date' ? '时间' : compareValues ? '对比项' : '分组')].concat(metrics.map(function (m) { return m.label; }));
    var tableRows = items.map(function (it) {
      return [it.label].concat(it.values.map(function (v) { return v === null ? null : v; }));
    });

    var metaParts = [];
    if (compareValues) metaParts.push('对比「' + plan.compareBy.column + '」的 ' + compareValues.join(' / '));
    else if (gbCol) metaParts.push('按「' + gbCol + '」分组' + (gbMeta.type === 'date' ? '（' + ({ day: '日', week: '周', month: '月', quarter: '季度', year: '年' }[bucketUsed] || '月') + '）' : ''));
    else metaParts.push('整体汇总');
    metaParts.push(metrics.map(function (m) { return m.label; }).join('、'));
    if (Array.isArray(plan.filters) && plan.filters.length) {
      metaParts.push('筛选 ' + plan.filters.map(function (f) { return f.column + ' ' + f.op + ' ' + f.value; }).join('，'));
    }
    if (skipped) metaParts.push('跳过 ' + skipped + ' 行无法识别的时间');
    if (othersTotal) note = '仅展示前 ' + (limit - 1) + ' 项，其余合并为「' + othersTotal.label + '」。';

    return {
      title: plan.title || '分析结果',
      intent: gbMeta && gbMeta.type === 'date' ? 'trend' : (compareValues ? 'compare' : intent),
      empty: false,
      note: note,
      metaText: metaParts.join(' · ') + ' · 参与计算 ' + data.length + ' 行',
      chart: numericChart ? { type: numericChart, labels: labels, series: series } : null,
      table: { headers: tableHeaders, rows: tableRows, numeric: [false].concat(metrics.map(function () { return true; })) },
      computed: {
        primary: primary,
        secondary: secondary,
        growth: growth,
        share: share,
        deltas: deltas,
        metricLabels: metrics.map(function (m) { return m.label; }),
        rowCount: data.length,
        groupCount: labels.length,
        bucket: bucketUsed
      }
    };
  }

  /* ---------------- 示例数据 ---------------- */

  function sampleDataset() {
    var regions = ['华东', '华南', '华北'];
    var products = ['智能硬件', '软件订阅', '增值服务'];
    var rows = [];
    var startY = 2024, startM = 6;
    for (var i = 0; i < 18; i++) {
      var y = startY + Math.floor((startM - 1 + i) / 12);
      var m = (startM - 1 + i) % 12 + 1;
      for (var r = 0; r < regions.length; r++) {
        for (var p = 0; p < products.length; p++) {
          var trend = 1 + i * 0.026;
          var seasonal = 1 + 0.11 * Math.sin((m - 3) / 12 * Math.PI * 2) + ((m === 11 || m === 12) ? 0.1 : 0);
          var regionFactor = [1.32, 1.0, 0.78][r];
          var productFactor = [1.0, 0.62, 0.44][p];
          var noise = 0.97 + ((i * 7 + r * 3 + p * 5) % 9) / 100;
          var amount = 260000 * trend * seasonal * regionFactor * productFactor * noise;
          if (y === 2025 && m === 3) amount *= 1.62;
          if (y === 2025 && m === 9) amount *= 0.58;
          rows.push({
            '月份': y + '-' + pad2(m),
            '地区': regions[r],
            '产品线': products[p],
            '销售额': Math.round(amount),
            '订单数': Math.round(amount / (2400 + r * 180 + p * 320)),
            '新客占比': Math.round((0.24 + ((i + r) % 5) * 0.02 + p * 0.01) * 1000) / 1000
          });
        }
      }
    }
    var headers = ['月份', '地区', '产品线', '销售额', '订单数', '新客占比'];
    var matrix = rows.map(function (o) { return headers.map(function (h) { return o[h]; }); });
    var ds = buildDataset(headers, matrix);
    ds.name = '示例：区域销售明细（2024-06 至 2025-11）';
    return ds;
  }

  global.Analytics = {
    parseText: parseText,
    parseDelimited: parseDelimited,
    parseSheetWorkbook: parseSheetWorkbook,
    buildDataset: buildDataset,
    profile: profile,
    runPlan: runPlan,
    sampleDataset: sampleDataset,
    toNumber: toNumber,
    toDate: toDate,
    formatNumber: formatNumber,
    formatDateShort: formatDateShort,
    formatMonthShort: formatMonthShort,
    compactNumber: compactNumber,
    pctText: pctText,
    cellText: cellText,
    typeLabel: function (t) { return TYPE_LABEL[t] || t; }
  };
})(window);
