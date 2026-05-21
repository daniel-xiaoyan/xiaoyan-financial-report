// 每日巡检：通过 SEC EDGAR 检查美股是否有新的季报/年报
// 中概股通过财经新闻关键词检查
import fs from 'fs';
import path from 'path';

const STATE_FILE = '.github/last-check-state.json';
const REPORT_FILE = '.github/last-check-report.md';

// 美股 CIK 映射（SEC EDGAR 用的公司ID）
const SEC_TARGETS = [
  { id: 'aapl', name: 'Apple', cik: '0000320193' },
  { id: 'msft', name: 'Microsoft', cik: '0000789019' },
  { id: 'googl', name: 'Alphabet', cik: '0001652044' },
  { id: 'amzn', name: 'Amazon', cik: '0001018724' },
  { id: 'meta', name: 'Meta', cik: '0001326801' },
  { id: 'nvda', name: 'NVIDIA', cik: '0001045810' },
];

// 中概股财报常见发布窗口
const CN_TARGETS = [
  { id: 'tencent', name: '腾讯', exchange: 'HK', ticker: '0700' },
  { id: 'baba', name: '阿里巴巴', exchange: 'HK', ticker: '9988' },
  { id: 'meituan', name: '美团', exchange: 'HK', ticker: '3690' },
  { id: 'jd', name: '京东', exchange: 'HK', ticker: '9618' },
  { id: 'pdd', name: '拼多多', exchange: 'US', ticker: 'PDD' },
  { id: 'kuaishou', name: '快手', exchange: 'HK', ticker: '1024' },
  { id: 'baidu', name: '百度', exchange: 'HK', ticker: '9888' },
  { id: 'netease', name: '网易', exchange: 'HK', ticker: '9999' },
  { id: 'xm', name: '小米', exchange: 'HK', ticker: '1810' },
  { id: 'bytedance', name: '字节跳动', exchange: 'private', ticker: '-' },
];

// 加载上次状态
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { lastCheck: null, knownFilings: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// 调 SEC EDGAR 拉取最近的财报列表
async function fetchSECFilings(cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'XiaoyanFinancialReport contact@xiaoyan.dev',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`SEC HTTP ${res.status}`);
  const data = await res.json();
  const recent = data.filings?.recent;
  if (!recent) return [];

  const items = [];
  for (let i = 0; i < Math.min(recent.form.length, 30); i++) {
    const form = recent.form[i];
    if (!['10-Q', '10-K', '20-F', '6-K'].includes(form)) continue;
    items.push({
      form,
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate[i],
      accessionNumber: recent.accessionNumber[i],
    });
  }
  return items;
}

async function main() {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  const updates = [];
  const errors = [];

  console.log(`🔍 巡检开始 - ${today}`);
  console.log(`上次巡检: ${state.lastCheck || '从未'}`);

  for (const target of SEC_TARGETS) {
    try {
      const filings = await fetchSECFilings(target.cik);
      if (filings.length === 0) continue;
      const latest = filings[0];
      const knownKey = `${target.id}:${latest.accessionNumber}`;
      const lastKnown = state.knownFilings[target.id];

      if (lastKnown !== latest.accessionNumber) {
        // 第一次跑不算更新（避免一上来全报新）
        if (lastKnown) {
          updates.push({
            company: target.name,
            id: target.id,
            form: latest.form,
            filingDate: latest.filingDate,
            reportDate: latest.reportDate,
            url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${target.cik}&type=${latest.form}&dateb=&owner=include&count=40`,
          });
        }
        state.knownFilings[target.id] = latest.accessionNumber;
      }
      // 防 SEC 限流
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      errors.push(`${target.name}: ${e.message}`);
      console.error(`❌ ${target.name}: ${e.message}`);
    }
  }

  state.lastCheck = today;
  state.lastUpdates = updates;
  saveState(state);

  // 生成报告
  let report = `# 📊 财报巡检报告\n\n**巡检时间**: ${today}\n\n`;
  if (updates.length > 0) {
    report += `## 🆕 发现 ${updates.length} 家公司有新财报\n\n`;
    for (const u of updates) {
      report += `- **${u.company}** (${u.id}) — ${u.form} | 财报期: ${u.reportDate} | 提交日: ${u.filingDate}\n  [SEC 链接](${u.url})\n`;
    }
    report += `\n👉 请尽快更新 \`index.html\` 中的 \`REAL_DATA\` 数据\n`;
  } else {
    report += `## ✅ 暂无新财报\n\n所有美股公司的财报数据均为最新。\n`;
  }

  if (errors.length > 0) {
    report += `\n## ⚠️ 错误\n\n${errors.map(e => `- ${e}`).join('\n')}\n`;
  }

  report += `\n## 📋 下次预计发布\n\n`;
  report += `中概股 (${CN_TARGETS.length} 家) 暂不在自动巡检范围（无统一 API），建议手动查阅：\n`;
  for (const c of CN_TARGETS) {
    if (c.exchange === 'private') continue;
    report += `- ${c.name} (${c.exchange}: ${c.ticker})\n`;
  }

  fs.writeFileSync(REPORT_FILE, report);

  // 输出给 GitHub Actions
  console.log(`\n${report}`);
  if (updates.length > 0) {
    // 设置 GitHub Actions output（用于触发 issue）
    fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/null', `has_updates=true\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/null', `update_count=${updates.length}\n`);
  } else {
    fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/null', `has_updates=false\n`);
  }
}

main().catch(e => {
  console.error('❌ 巡检失败:', e);
  process.exit(1);
});
